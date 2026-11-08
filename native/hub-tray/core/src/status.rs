//! One answer to "how is the hub?": the service's state, its health check, the version installed and any waiting
//! restart, in plain words, with the actions that make sense now.

use crate::health::{self, Health};
use crate::idle::{self, Watcher};
use crate::pair;
use crate::paths::{self, Os, Place, Setup};
use crate::procs;
use crate::run::Runner;
use crate::service::{self, Phase, Problem, ServiceState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// A hub that has run less than this and doesn't answer yet is still starting; a job loaded but idle this long isn't.
const STARTING_SECS: u64 = 30;

/// A hub that answered less than this ago and misses an answer now is busy, not broken (about three looks).
const ANSWER_GRACE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Running,
    Starting,
    NotAnswering,
    Failing,
    Stopped,
    NotInstalled,
    /// The binary is there, but no service runs it.
    NoService,
    /// A hub answers, but the service didn't start it.
    Outside,
    /// Something that isn't Crosstalk has the port.
    OtherProgram,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Ok,
    Busy,
    Off,
    Problem,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Actions {
    pub open: bool,
    pub pair: bool,
    pub start: bool,
    pub stop: bool,
    pub restart: bool,
    pub restart_now: bool,
    pub cancel_restart: bool,
    pub install: bool,
    pub logs: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub tone: Tone,
    pub title: String,
    pub detail: String,
    /// The version answering now.
    pub version: Option<String>,
    /// The version of the binary on disk; differs from `version` when an update waits for a restart.
    pub installed_version: Option<String>,
    pub update_waiting: bool,
    pub port: u16,
    pub address: String,
    pub public_url: Option<String>,
    /// What "Open Crosstalk" opens: the published address, else the local one.
    pub open_url: String,
    pub service: String,
    pub service_file: PathBuf,
    pub bin: PathBuf,
    pub data_home: PathBuf,
    pub pid: Option<u32>,
    /// A restart waiting for five quiet minutes.
    pub restart: Option<Watcher>,
    pub actions: Actions,
    pub os: Os,
    /// A trial with a stand-in service tool.
    pub fake: bool,
    pub checked_at: u64,
}

pub struct Inputs<'a> {
    pub place: &'a Place,
    pub setup: &'a Setup,
    pub service: &'a ServiceState,
    pub health: &'a Health,
    pub installed_version: Option<String>,
    pub watcher: Option<Watcher>,
    /// Seconds the service's process has run.
    pub age: Option<u64>,
    /// Seconds the job has been seen loaded but not running (Phase::Waiting).
    pub waiting_for: Option<u64>,
    pub now_ms: u64,
}

pub fn decide(i: Inputs) -> Status {
    let port = i.setup.port;
    let up = i.health.up();
    let defined = i.setup.service_defined || i.service.loaded;
    let next_start = match i.place.os {
        Os::Mac => "at the next login",
        Os::Linux => "when the computer next starts",
    };
    let exit = || match (&i.service.signal, i.service.last_exit) {
        (Some(sig), _) => format!(" ({})", sig.to_lowercase()),
        (None, Some(code)) => format!(" (exit {code})"),
        _ => String::new(),
    };
    let mut a = Actions { logs: true, ..Actions::default() };
    let (state, tone, title, detail): (State, Tone, String, String) = if !defined {
        if up {
            a.open = true;
            a.pair = i.setup.bin_exists;
            (State::Outside, Tone::Ok, "Running outside the service".into(), format!("A hub answers on port {port}, but no background service started it (a terminal?), so Start and Stop can't manage it."))
        } else if i.setup.bin_exists {
            a.install = true;
            (State::NoService, Tone::Off, "Not set up to run".into(), format!("The hub is at {}, but no background service starts it.", i.setup.bin.display()))
        } else {
            a = Actions { install: true, ..Actions::default() };
            (State::NotInstalled, Tone::Off, "Not installed".into(), "Crosstalk isn't set up on this computer yet.".into())
        }
    } else {
        match (i.service.phase, i.health) {
            (Phase::Running, Health::Up { .. }) => {
                a = Actions { open: true, pair: i.setup.bin_exists, stop: true, restart: true, restart_now: true, logs: true, ..Actions::default() };
                (State::Running, Tone::Ok, "Running".into(), format!("It starts by itself {next_start} and comes back if it stops."))
            }
            (_, Health::Other { detail }) => {
                a.stop = i.service.loaded;
                (State::OtherProgram, Tone::Problem, format!("Port {port} is taken"), format!("{detail} The hub can't use the port while that program has it."))
            }
            (Phase::Running, Health::Down { .. }) if i.age.is_some_and(|s| s < STARTING_SECS) => {
                a.stop = true;
                (State::Starting, Tone::Busy, "Starting…".into(), "It should answer in a few seconds.".into())
            }
            (Phase::Running, Health::Down { reason }) => {
                a.stop = true;
                // When it's quiet first, as anywhere: a busy hub that answers late isn't helped by cutting it off.
                a.restart = true;
                a.restart_now = true;
                (State::NotAnswering, Tone::Problem, "Not answering".into(), format!("It runs (process {}), but doesn't answer. {reason} The log may say why.", i.service.pid.unwrap_or(0)))
            }
            (Phase::Unknown, Health::Up { .. }) => {
                // launchctl or systemctl didn't answer this time (busy right after login, say); the hub did.
                a = Actions { open: true, pair: i.setup.bin_exists, stop: true, restart: true, restart_now: true, logs: true, ..Actions::default() };
                let why = i.service.problem.clone().unwrap_or_else(|| "no answer".into());
                (State::Running, Tone::Ok, "Running".into(), format!("It answers, but its background service's state couldn't be read just now ({why})."))
            }
            (_, Health::Up { .. }) => {
                a.open = true;
                a.pair = i.setup.bin_exists;
                (State::Outside, Tone::Ok, "Running outside the service".into(), format!("A hub answers on port {port}, but the background service didn't start it (a terminal?), so Start and Stop can't manage it."))
            }
            (Phase::Waiting, _) if i.waiting_for.is_some_and(|s| s >= STARTING_SECS) => {
                // Loaded, but nothing starts it again (a job without KeepAlive that exited cleanly).
                a.start = true;
                (State::Stopped, Tone::Off, "Stopped".into(), format!("Phones can't reach it. It starts again when you tap Start, or {next_start}."))
            }
            (Phase::Starting | Phase::Waiting, _) => {
                a.stop = true;
                (State::Starting, Tone::Busy, "Starting…".into(), "It should answer in a few seconds.".into())
            }
            (Phase::Failing, _) => {
                a.start = true;
                a.stop = true;
                (State::Failing, Tone::Problem, format!("Keeps stopping{}", exit()), "It stops soon after it starts, and the system keeps starting it again. The log says why.".into())
            }
            (Phase::Stopped, _) => {
                a.start = true;
                (State::Stopped, Tone::Off, "Stopped".into(), format!("Phones can't reach it. It starts again when you tap Start, or {next_start}."))
            }
            (Phase::Unknown, _) => (State::Unknown, Tone::Problem, "Can't tell".into(), i.service.problem.clone().unwrap_or_else(|| "The service's state couldn't be read.".into())),
        }
    };
    let version = i.health.version().map(str::to_string).filter(|v| !v.is_empty());
    let update_waiting = state == State::Running && matches!((&version, &i.installed_version), (Some(run), Some(inst)) if run != inst);
    let (title, detail) = if update_waiting {
        ("Update waiting".to_string(), format!("Version {} is installed, {} still runs. Restart to finish.", i.installed_version.clone().unwrap_or_default(), version.clone().unwrap_or_default()))
    } else {
        (title, detail)
    };
    if i.watcher.is_some() {
        a.restart = false;
        a.cancel_restart = true;
    }
    let address = i.setup.local_address();
    Status {
        state,
        tone,
        title,
        detail,
        version,
        installed_version: i.installed_version,
        update_waiting,
        port,
        open_url: i.setup.public_url.clone().unwrap_or_else(|| address.clone()),
        address,
        public_url: i.setup.public_url.clone(),
        service: i.place.service_name(),
        service_file: i.setup.service_file.clone(),
        bin: i.setup.bin.clone(),
        data_home: i.setup.data_home.clone(),
        pid: i.service.pid,
        restart: i.watcher,
        actions: a,
        os: i.place.os,
        fake: i.place.fake,
        checked_at: i.now_ms,
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A binary file as last seen: path, size and modification time.
type FileKey = (PathBuf, u64, Option<SystemTime>);

/// The installed version, asked of the binary again only when the file changes.
#[derive(Default)]
pub struct Versions {
    seen: Mutex<Option<(FileKey, Option<String>)>>,
}

impl Versions {
    pub fn get(&self, place: &Place, setup: &Setup, runner: &dyn Runner) -> Option<String> {
        let meta = std::fs::metadata(&setup.bin).ok()?;
        let key = (setup.bin.clone(), meta.len(), meta.modified().ok());
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((k, v)) = seen.as_ref() {
            if *k == key {
                return v.clone();
            }
        }
        let v = runner.run(&pair::version_command(place, setup)).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string()).filter(|v| looks_like_version(v));
        *seen = Some((key, v.clone()));
        v
    }
}

fn looks_like_version(v: &str) -> bool {
    !v.is_empty() && v.len() < 40 && v.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)) && v.starts_with(|c: char| c.is_ascii_digit())
}

/// What earlier looks showed, so one look doesn't decide alone.
#[derive(Default)]
struct Seen {
    /// The service's process that last answered (None: one the service didn't start), when, and what it said.
    answered: Option<(Option<u32>, Instant, Health)>,
    /// Since when the job has been loaded but not running.
    waiting_since: Option<Instant>,
}

impl Seen {
    /// The health to go by, and the seconds the job has been waiting. A hub that answered a moment ago and misses an
    /// answer now is busy (Bun has one thread): within ANSWER_GRACE, the same process's last answer stands.
    fn look(&mut self, service: &ServiceState, health: Health, now: Instant) -> (Health, Option<u64>) {
        let pid = service.pid.filter(|_| service.phase == Phase::Running);
        let health = match &health {
            Health::Up { .. } => {
                self.answered = Some((pid, now, health.clone()));
                health
            }
            Health::Down { .. } => match &self.answered {
                Some((p, at, last)) if *p == pid && now.duration_since(*at) < ANSWER_GRACE => last.clone(),
                _ => health,
            },
            Health::Other { .. } => health,
        };
        if service.phase == Phase::Waiting {
            self.waiting_since.get_or_insert(now);
        } else {
            self.waiting_since = None;
        }
        (health, self.waiting_since.map(|t| now.duration_since(t).as_secs()))
    }
}

/// Everything the app needs to answer, read fresh each time (and a little of what it saw before).
pub struct Hub<R: Runner> {
    pub place: Place,
    pub runner: R,
    pub versions: Versions,
    /// The app's own copy of the restart watcher (the only one a trial counts).
    pub watcher_script: Option<PathBuf>,
    seen: Mutex<Seen>,
}

impl<R: Runner> Hub<R> {
    pub fn new(place: Place, runner: R) -> Hub<R> {
        Hub { place, runner, versions: Versions::default(), watcher_script: None, seen: Mutex::default() }
    }

    pub fn setup(&self) -> Setup {
        paths::discover(&self.place)
    }

    pub fn status(&self) -> Status {
        let setup = self.setup();
        let service = service::state(&self.place, &self.runner);
        let checked = health::check(setup.port);
        let (health, waiting_for) = self.seen.lock().unwrap_or_else(|e| e.into_inner()).look(&service, checked, Instant::now());
        let age = service.pid.filter(|_| !health.up()).and_then(|pid| procs::age(pid, &self.runner));
        let installed_version = if setup.bin_exists { self.versions.get(&self.place, &setup, &self.runner) } else { None };
        let watcher = idle::find(&self.place, &setup, &self.runner, self.watcher_script.as_deref()).into_iter().next();
        decide(Inputs { place: &self.place, setup: &setup, service: &service, health: &health, installed_version, watcher, age, waiting_for, now_ms: now_ms() })
    }

    /// Ends the waiting restart, if there is one (a trial: only its own). Returns how many there were.
    pub fn cancel_restart(&self) -> Result<usize, String> {
        idle::cancel(&self.place, &self.setup(), &self.runner, self.watcher_script.as_deref())
    }

    /// Stop. A waiting restart ends first: nothing is left for it to do, and on Linux its `systemctl restart` would
    /// start the stopped hub again.
    pub fn stop(&self) -> Result<String, Problem> {
        let ended = self.cancel_restart()?;
        said_ended(service::stop(&self.place, &self.runner), ended)
    }

    /// Restart now. A waiting restart ends first: this does what it waited for, and it would restart the hub a second
    /// time while phones reconnect.
    pub fn restart_now(&self) -> Result<String, Problem> {
        let ended = self.cancel_restart()?;
        said_ended(service::restart_now(&self.place, &self.setup(), &self.runner), ended)
    }
}

/// An action's answer, saying when it ended a waiting restart.
fn said_ended(r: Result<String, Problem>, ended: usize) -> Result<String, Problem> {
    let add = |s: String| if ended == 0 { s } else { format!("{s} The waiting restart is cancelled.") };
    r.map(add).map_err(|p| Problem { message: add(p.message), ..p })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::{Fake, Output};
    use crate::testing::TempDir;

    struct Case {
        defined: bool,
        bin: bool,
        phase: Phase,
        loaded: bool,
        health: Health,
        age: Option<u64>,
        installed: Option<&'static str>,
        watcher: bool,
        last_exit: Option<i32>,
        waiting_for: Option<u64>,
    }

    fn base() -> Case {
        Case { defined: true, bin: true, phase: Phase::Running, loaded: true, health: Health::Up { version: "0.4.1".into() }, age: None, installed: Some("0.4.1"), watcher: false, last_exit: None, waiting_for: None }
    }

    fn run(c: Case) -> Status {
        let home = TempDir::new("status");
        let place = Place::for_test(Os::Mac, home.path());
        let mut setup = paths::discover(&place);
        setup.service_defined = c.defined;
        setup.bin_exists = c.bin;
        setup.public_url = Some("https://mini.example.ts.net".into());
        let service = ServiceState { phase: c.phase, loaded: c.loaded, pid: (c.phase == Phase::Running).then_some(4242), last_exit: c.last_exit, signal: None, problem: None };
        let watcher = c.watcher.then(|| Watcher { pid: 900, own_group: true, script: "restart-when-idle.sh".into(), waited: Some(60) });
        decide(Inputs { place: &place, setup: &setup, service: &service, health: &c.health, installed_version: c.installed.map(String::from), watcher, age: c.age, waiting_for: c.waiting_for, now_ms: 1 })
    }

    #[test]
    fn running() {
        let s = run(base());
        assert_eq!((s.state, s.tone, s.title.as_str()), (State::Running, Tone::Ok, "Running"));
        assert_eq!(s.version.as_deref(), Some("0.4.1"));
        assert_eq!(s.open_url, "https://mini.example.ts.net");
        assert_eq!(s.address, "http://127.0.0.1:7420");
        assert_eq!(s.actions, Actions { open: true, pair: true, stop: true, restart: true, restart_now: true, logs: true, ..Actions::default() });
    }

    #[test]
    fn an_update_waits_for_a_restart() {
        let s = run(Case { installed: Some("0.4.2"), ..base() });
        assert!(s.update_waiting);
        assert_eq!(s.title, "Update waiting");
        assert_eq!(s.detail, "Version 0.4.2 is installed, 0.4.1 still runs. Restart to finish.");
    }

    #[test]
    fn a_waiting_restart_can_be_cancelled() {
        let s = run(Case { watcher: true, ..base() });
        assert!(s.actions.cancel_restart && !s.actions.restart);
        assert_eq!(s.restart.map(|w| w.pid), Some(900));
    }

    #[test]
    fn starting_then_not_answering() {
        let down = Health::Down { reason: "Nothing answers on port 7420.".into() };
        assert_eq!(run(Case { health: down.clone(), age: Some(3), ..base() }).state, State::Starting);
        let s = run(Case { health: down, age: Some(600), ..base() });
        assert_eq!((s.state, s.tone), (State::NotAnswering, Tone::Problem));
        assert!(s.actions.restart_now && s.actions.stop && !s.actions.open);
        // Restart when it's quiet stays the first offer.
        assert!(s.actions.restart);
    }

    #[test]
    fn one_slow_answer_from_a_hub_that_just_answered_changes_nothing() {
        let running = ServiceState { phase: Phase::Running, loaded: true, pid: Some(4242), last_exit: None, signal: None, problem: None };
        let up = Health::Up { version: "0.4.1".into() };
        let late = Health::Down { reason: "Port 7420 didn't answer in time.".into() };
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut seen = Seen::default();
        assert_eq!(seen.look(&running, up.clone(), at(0)).0, up);
        assert_eq!(seen.look(&running, late.clone(), at(5)).0, up);
        assert_eq!(seen.look(&running, late.clone(), at(10)).0, up);
        // Fifteen seconds without an answer: not answering.
        assert_eq!(seen.look(&running, late.clone(), at(15)).0, late);
        // Never for another process (restarted), or once the service has stopped it.
        seen.look(&running, up.clone(), at(20));
        assert_eq!(seen.look(&ServiceState { pid: Some(4243), ..running.clone() }, late.clone(), at(21)).0, late);
        seen.look(&running, up.clone(), at(22));
        let stopped = ServiceState { phase: Phase::Stopped, loaded: false, pid: None, ..running.clone() };
        assert_eq!(seen.look(&stopped, late.clone(), at(23)).0, late);
    }

    #[test]
    fn a_job_loaded_but_idle_for_a_while_is_stopped_not_starting() {
        let down = Health::Down { reason: "x".into() };
        let s = run(Case { phase: Phase::Waiting, health: down.clone(), waiting_for: Some(3), ..base() });
        assert_eq!(s.state, State::Starting);
        let s = run(Case { phase: Phase::Waiting, health: down, waiting_for: Some(31), ..base() });
        assert_eq!((s.state, s.title.as_str()), (State::Stopped, "Stopped"));
        assert!(s.actions.start);
        // How long it has waited, as seen here.
        let waiting = ServiceState { phase: Phase::Waiting, loaded: true, pid: None, last_exit: Some(0), signal: None, problem: None };
        let t0 = Instant::now();
        let mut seen = Seen::default();
        assert_eq!(seen.look(&waiting, Health::Down { reason: "x".into() }, t0).1, Some(0));
        assert_eq!(seen.look(&waiting, Health::Down { reason: "x".into() }, t0 + Duration::from_secs(40)).1, Some(40));
        let running = ServiceState { phase: Phase::Running, pid: Some(1), ..waiting };
        assert_eq!(seen.look(&running, Health::Down { reason: "x".into() }, t0 + Duration::from_secs(41)).1, None);
    }

    #[test]
    fn a_hub_answering_while_its_service_can_t_be_read_is_running() {
        let s = run(Case { phase: Phase::Unknown, loaded: false, ..base() });
        assert_eq!((s.state, s.title.as_str()), (State::Running, "Running"));
        assert!(s.detail.contains("couldn't be read just now"), "{}", s.detail);
        assert!(s.actions.stop && s.actions.restart && s.actions.restart_now && s.actions.open);
        // Without an answer either, it can't tell.
        assert_eq!(run(Case { phase: Phase::Unknown, loaded: false, health: Health::Down { reason: "x".into() }, ..base() }).state, State::Unknown);
    }

    #[test]
    fn stopped_and_failing() {
        let down = Health::Down { reason: "x".into() };
        let s = run(Case { phase: Phase::Stopped, loaded: false, health: down.clone(), ..base() });
        assert_eq!((s.state, s.title.as_str()), (State::Stopped, "Stopped"));
        assert!(s.detail.contains("at the next login"));
        assert!(s.actions.start && !s.actions.stop && !s.actions.pair);
        let s = run(Case { phase: Phase::Failing, health: down, last_exit: Some(78), ..base() });
        assert_eq!(s.title, "Keeps stopping (exit 78)");
        assert!(s.actions.start && s.actions.stop);
    }

    #[test]
    fn not_installed_only_offers_install() {
        let s = run(Case { defined: false, bin: false, loaded: false, phase: Phase::Stopped, health: Health::Down { reason: "x".into() }, installed: None, ..base() });
        assert_eq!(s.state, State::NotInstalled);
        assert_eq!(s.actions, Actions { install: true, ..Actions::default() });
        let s = run(Case { defined: false, loaded: false, phase: Phase::Stopped, health: Health::Down { reason: "x".into() }, ..base() });
        assert_eq!(s.state, State::NoService);
        assert!(s.actions.install);
    }

    #[test]
    fn a_hub_the_service_did_not_start() {
        let s = run(Case { phase: Phase::Stopped, loaded: false, ..base() });
        assert_eq!(s.state, State::Outside);
        assert!(!s.actions.start && !s.actions.stop && s.actions.open);
        let s = run(Case { defined: false, loaded: false, phase: Phase::Stopped, ..base() });
        assert_eq!(s.state, State::Outside);
        assert!(!s.actions.install);
    }

    #[test]
    fn another_program_on_the_port() {
        let s = run(Case { health: Health::Other { detail: "Port 7420 answers, but not as Crosstalk.".into() }, ..base() });
        assert_eq!((s.state, s.title.as_str()), (State::OtherProgram, "Port 7420 is taken"));
    }

    #[test]
    fn stop_and_restart_now_end_a_waiting_restart_first() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let home = TempDir::new("status-actions");
        let mut place = Place::for_test(Os::Mac, home.path());
        // SAFETY: getuid can't fail. The stand-in watcher below is this account's.
        place.uid = unsafe { libc::getuid() };
        let data = home.path().join(".crosstalk");
        std::fs::create_dir_all(&data).unwrap();
        for restart in [false, true] {
            // A waiting watcher: a process of this test's own, in a group of its own, that ps (the fake) says is one.
            let mut waiting = std::process::Command::new("/bin/sleep").arg("30").process_group(0).spawn().unwrap();
            let pid = waiting.id();
            let fake = Fake::new();
            fake.answer("ps -A", Output::exited(0, &format!("{pid} {pid} {} 01:00 /bin/sh /x/restart-when-idle.sh\n", place.uid)));
            fake.answer(&format!("lsof -a -p {pid} "), Output::exited(0, &format!("p{pid}\nfcwd\nn{}\n", data.display())));
            fake.answer("launchctl print", Output::exited(0, crate::testing::LAUNCHCTL_RUNNING));
            let hub = Hub::new(place.clone(), fake);
            let said = if restart { hub.restart_now() } else { hub.stop() }.unwrap();
            assert_eq!(said, format!("{} The waiting restart is cancelled.", if restart { "Restarting…" } else { "Stopped." }));
            assert_eq!(waiting.wait().unwrap().signal(), Some(libc::SIGTERM));
            // Before the service was touched.
            let calls = hub.runner.calls();
            let looked = calls.iter().position(|c| c.starts_with("ps -A")).unwrap();
            let changed = calls.iter().position(|c| c.starts_with("launchctl bootout") || c.starts_with("launchctl kickstart -k")).unwrap();
            assert!(looked < changed, "{calls:?}");
        }
        // Nothing waiting: nothing more to say.
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(0, crate::testing::LAUNCHCTL_RUNNING));
        assert_eq!(Hub::new(place, fake).stop().unwrap(), "Stopped.");
    }

    #[test]
    fn the_version_is_asked_again_only_when_the_binary_changes() {
        let home = TempDir::new("versions");
        let place = Place::for_test(Os::Mac, home.path());
        let mut setup = paths::discover(&place);
        setup.bin = home.path().join("crosstalk-hub");
        crate::testing::executable(&setup.bin, "#!/bin/sh\necho 0.4.1\n");
        let fake = Fake::new();
        fake.answer("crosstalk-hub version", Output::exited(0, "0.4.1\n"));
        let v = Versions::default();
        assert_eq!(v.get(&place, &setup, &fake).as_deref(), Some("0.4.1"));
        assert_eq!(v.get(&place, &setup, &fake).as_deref(), Some("0.4.1"));
        assert_eq!(fake.calls().len(), 1);
        crate::testing::executable(&setup.bin, "#!/bin/sh\necho 0.4.2 # a longer file\n");
        fake.answer("crosstalk-hub version", Output::exited(0, "0.4.2\n"));
        assert_eq!(v.get(&place, &setup, &fake).as_deref(), Some("0.4.2"));
        assert_eq!(fake.calls().len(), 2);
        assert!(!looks_like_version("error: something"));
    }
}
