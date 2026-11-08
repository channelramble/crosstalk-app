//! The hub's own background service, on either system: what state it's in, and Start, Stop and Restart now.
//! The hub is only ever started by launchd or systemd, never as this app's child: macOS gives folder and drive
//! permissions to the program that starts a process, so a hub started here would lose them and ask again.

use crate::launchd::{self, Printed};
use crate::paths::{Os, Place, Setup};
use crate::run::{Cmd, Output, Runner};
use crate::systemd::{self, Shown};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Running,
    Starting,
    /// Loaded but not running, with nothing wrong last time.
    Waiting,
    /// It exited with an error or a signal and is being retried.
    Failing,
    /// Not loaded (launchd) or inactive (systemd).
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceState {
    pub phase: Phase,
    /// launchd has the job / systemd knows the unit.
    pub loaded: bool,
    pub pid: Option<u32>,
    pub last_exit: Option<i32>,
    pub signal: Option<String>,
    pub problem: Option<String>,
}

impl ServiceState {
    fn new(phase: Phase, loaded: bool) -> ServiceState {
        ServiceState { phase, loaded, pid: None, last_exit: None, signal: None, problem: None }
    }
}

pub fn from_launchd(p: Printed) -> ServiceState {
    match p {
        Printed::NotLoaded => ServiceState::new(Phase::Stopped, false),
        Printed::Failed(why) => ServiceState { problem: Some(why), ..ServiceState::new(Phase::Unknown, false) },
        Printed::Loaded(job) => {
            let phase = if job.running() {
                Phase::Running
            } else if job.signal.is_some() || job.last_exit.is_some_and(|c| c != 0) {
                Phase::Failing
            } else if job.state.as_deref().is_some_and(|s| s.contains("spawn")) {
                Phase::Starting
            } else {
                Phase::Waiting
            };
            ServiceState { phase, loaded: true, pid: job.pid.filter(|_| job.running()), last_exit: job.last_exit, signal: job.signal, problem: None }
        }
    }
}

pub fn from_systemd(s: Shown) -> ServiceState {
    match s {
        Shown::NotFound => ServiceState::new(Phase::Stopped, false),
        Shown::Failed(why) => ServiceState { problem: Some(why), ..ServiceState::new(Phase::Unknown, false) },
        Shown::Found(u) => {
            let phase = match (u.active.as_str(), u.sub.as_str()) {
                ("active" | "reloading", "running") => Phase::Running,
                ("activating", "auto-restart") | ("failed", _) => Phase::Failing,
                ("activating", _) => Phase::Starting,
                ("inactive", _) => Phase::Stopped,
                _ => Phase::Waiting,
            };
            // ExecMainCode 2 and 3: killed by the signal in ExecMainStatus.
            let signal = matches!(u.exit_code, Some(2 | 3)).then(|| format!("signal {}", u.exit_status.unwrap_or(0)));
            let last_exit = if signal.is_some() { None } else { u.exit_status };
            ServiceState { phase, loaded: true, pid: u.pid.filter(|_| phase == Phase::Running), last_exit, signal, problem: None }
        }
    }
}

fn tool(place: &Place) -> &std::path::Path {
    match place.os {
        Os::Mac => &place.launchctl,
        Os::Linux => &place.systemctl,
    }
}

fn cmd(place: &Place, args: Vec<String>) -> Cmd {
    Cmd::new(tool(place), args).timeout(Duration::from_secs(10))
}

pub fn state(place: &Place, runner: &dyn Runner) -> ServiceState {
    match place.os {
        Os::Mac => match runner.run(&cmd(place, launchd::print(place.uid, &place.label))) {
            Ok(out) => from_launchd(launchd::parse_print(&out)),
            Err(e) => from_launchd(Printed::Failed(e)),
        },
        Os::Linux => match runner.run(&cmd(place, systemd::show(&place.unit))) {
            Ok(out) => from_systemd(systemd::parse_show(&out)),
            Err(e) => from_systemd(Shown::Failed(e)),
        },
    }
}

/// What the person can do about a failed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fix {
    /// System Settings → General → Login Items & Extensions, where background items are allowed.
    LoginItems,
    Logs,
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub message: String,
    pub fix: Option<Fix>,
}

impl Problem {
    pub fn new(message: impl Into<String>, fix: Option<Fix>) -> Problem {
        Problem { message: message.into(), fix }
    }
}

impl From<String> for Problem {
    fn from(message: String) -> Problem {
        Problem { message, fix: None }
    }
}

fn change(place: &Place, runner: &dyn Runner, args: Vec<String>, wait: Duration) -> Result<Output, Problem> {
    runner.run(&Cmd::new(tool(place), args).timeout(wait)).map_err(|e| Problem::new(e, Some(Fix::Retry)))
}

fn refused(what: &str, out: &Output) -> Problem {
    let said = out.said();
    let said = if said.is_empty() { format!("exit {}", out.code.unwrap_or(-1)) } else { said };
    Problem::new(format!("{what} didn't work: {said}"), Some(Fix::Logs))
}

/// Start: load the LaunchAgent (or start the unit), or start a loaded job that isn't running.
pub fn start(place: &Place, setup: &Setup, runner: &dyn Runner) -> Result<String, Problem> {
    place.may_change_service()?;
    let now = state(place, runner);
    if now.phase == Phase::Running {
        return Ok("It's already running.".into());
    }
    if now.phase == Phase::Unknown {
        // Loading it and kicking it differ, and doing the wrong one would fail confusingly.
        let why = now.problem.unwrap_or_else(|| "no answer".into());
        return Err(Problem::new(format!("The service's state couldn't be read ({why}), so nothing was started."), Some(Fix::Retry)));
    }
    match place.os {
        Os::Mac => {
            if now.loaded {
                let out = change(place, runner, launchd::kickstart(place.uid, &place.label, false), Duration::from_secs(30))?;
                return if out.ok() { Ok("Starting…".into()) } else { Err(refused("Starting", &out)) };
            }
            if !setup.service_defined {
                return Err(Problem::new("No background service is set up for the hub. Install it first.", None));
            }
            // A `launchctl disable` (or an older Stop) would make bootstrap fail, so undo it first.
            let _ = change(place, runner, launchd::enable(place.uid, &place.label), Duration::from_secs(10));
            let out = change(place, runner, launchd::bootstrap(place.uid, &setup.service_file), Duration::from_secs(30))?;
            if out.ok() {
                return Ok("Starting…".into());
            }
            // "Bootstrap failed: 5" also comes when it was already loaded meanwhile.
            if state(place, runner).loaded {
                return Ok("Starting…".into());
            }
            if out.said().contains(": 5") || out.said().contains("Input/output error") {
                return Err(Problem::new(
                    "macOS didn't let the hub start. If Crosstalk is switched off under Login Items & Extensions (Allow in the Background), switch it on, then tap Start again.",
                    Some(Fix::LoginItems),
                ));
            }
            Err(refused("Starting", &out))
        }
        Os::Linux => {
            if !now.loaded {
                if !setup.service_defined {
                    return Err(Problem::new("No background service is set up for the hub. Install it first.", None));
                }
                // The unit file is there but systemd hasn't read it yet.
                let _ = change(place, runner, systemd::daemon_reload(), Duration::from_secs(30));
            }
            let out = change(place, runner, systemd::start(&place.unit), Duration::from_secs(100))?;
            if out.ok() {
                Ok("Starting…".into())
            } else {
                Err(refused("Starting", &out))
            }
        }
    }
}

/// Stop until Start or the next login (macOS) / boot (Linux).
pub fn stop(place: &Place, runner: &dyn Runner) -> Result<String, Problem> {
    place.may_change_service()?;
    let now = state(place, runner);
    match place.os {
        Os::Mac => {
            // Only a job surely not loaded is already stopped: one whose state couldn't be read is booted out anyway.
            if now.phase == Phase::Stopped {
                return Ok("It's already stopped.".into());
            }
            let out = change(place, runner, launchd::bootout(place.uid, &place.label), Duration::from_secs(40))?;
            if out.ok() || state(place, runner).phase == Phase::Stopped {
                Ok("Stopped.".into())
            } else {
                Err(refused("Stopping", &out))
            }
        }
        Os::Linux => {
            if now.phase == Phase::Stopped {
                return Ok("It's already stopped.".into());
            }
            let out = change(place, runner, systemd::stop(&place.unit), Duration::from_secs(100))?;
            if out.ok() {
                Ok("Stopped.".into())
            } else {
                Err(refused("Stopping", &out))
            }
        }
    }
}

/// Restart at once, whatever the hub is doing (the caller has asked twice). Starts it when it's stopped.
pub fn restart_now(place: &Place, setup: &Setup, runner: &dyn Runner) -> Result<String, Problem> {
    place.may_change_service()?;
    match place.os {
        Os::Mac => {
            // kickstart -k needs no state, so one that couldn't be read is restarted all the same.
            if state(place, runner).phase == Phase::Stopped {
                return start(place, setup, runner);
            }
            let out = change(place, runner, launchd::kickstart(place.uid, &place.label, true), Duration::from_secs(40))?;
            if out.ok() {
                Ok("Restarting…".into())
            } else {
                Err(refused("Restarting", &out))
            }
        }
        Os::Linux => {
            let out = change(place, runner, systemd::restart(&place.unit), Duration::from_secs(100))?;
            if out.ok() {
                Ok("Restarting…".into())
            } else {
                Err(refused("Restarting", &out))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::discover;
    use crate::run::Fake;
    use crate::testing::{TempDir, LAUNCHCTL_RUNNING};

    fn mac(home: &TempDir) -> (Place, Setup) {
        let place = Place::for_test(Os::Mac, home.path());
        std::fs::create_dir_all(place.service_file().parent().unwrap()).unwrap();
        std::fs::write(place.service_file(), crate::testing::plist(&[("CROSSTALK_PORT", "7421")])).unwrap();
        let setup = discover(&place);
        (place, setup)
    }

    #[test]
    fn launchd_states() {
        assert_eq!(from_launchd(launchd::parse_print(&Output::exited(0, LAUNCHCTL_RUNNING))).phase, Phase::Running);
        assert_eq!(from_launchd(Printed::NotLoaded), ServiceState::new(Phase::Stopped, false));
        let failing = launchd::Job { state: Some("spawn scheduled".into()), last_exit: Some(78), ..Default::default() };
        assert_eq!(from_launchd(Printed::Loaded(failing)).phase, Phase::Failing);
        let respawning = launchd::Job { state: Some("spawn scheduled".into()), last_exit: Some(0), ..Default::default() };
        assert_eq!(from_launchd(Printed::Loaded(respawning)).phase, Phase::Starting);
    }

    #[test]
    fn systemd_states() {
        let unit = |active: &str, sub: &str| systemd::Unit { load: "loaded".into(), active: active.into(), sub: sub.into(), pid: Some(9), exit_status: Some(1), exit_code: Some(1), ..Default::default() };
        assert_eq!(from_systemd(Shown::Found(unit("active", "running"))).pid, Some(9));
        assert_eq!(from_systemd(Shown::Found(unit("activating", "auto-restart"))).phase, Phase::Failing);
        assert_eq!(from_systemd(Shown::Found(unit("activating", "start"))).phase, Phase::Starting);
        assert_eq!(from_systemd(Shown::Found(unit("inactive", "dead"))).phase, Phase::Stopped);
        let killed = systemd::Unit { exit_code: Some(2), exit_status: Some(9), ..unit("failed", "failed") };
        assert_eq!(from_systemd(Shown::Found(killed)).signal.as_deref(), Some("signal 9"));
        assert!(!from_systemd(Shown::NotFound).loaded);
    }

    #[test]
    fn start_loads_the_plist_when_it_is_not_loaded() {
        let home = TempDir::new("svc-start");
        let (place, setup) = mac(&home);
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(113, ""));
        assert_eq!(start(&place, &setup, &fake).unwrap(), "Starting…");
        let plist = place.service_file().display().to_string();
        assert_eq!(fake.calls(), ["launchctl print gui/501/com.crosstalk.hub".to_string(), "launchctl enable gui/501/com.crosstalk.hub".into(), format!("launchctl bootstrap gui/501 {plist}")]);
    }

    #[test]
    fn start_kicks_a_loaded_job_and_leaves_a_running_one() {
        let home = TempDir::new("svc-kick");
        let (place, setup) = mac(&home);
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(0, "gui/501/com.crosstalk.hub = {\n\tstate = not running\n\tlast exit code = 1\n}\n"));
        start(&place, &setup, &fake).unwrap();
        assert_eq!(fake.calls().last().unwrap(), "launchctl kickstart gui/501/com.crosstalk.hub");
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(0, LAUNCHCTL_RUNNING));
        assert_eq!(start(&place, &setup, &fake).unwrap(), "It's already running.");
        assert_eq!(fake.calls().len(), 1);
    }

    #[test]
    fn a_refused_bootstrap_points_at_login_items() {
        let home = TempDir::new("svc-refused");
        let (place, setup) = mac(&home);
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(113, ""));
        fake.answer("launchctl bootstrap", Output { code: Some(5), stdout: String::new(), stderr: "Bootstrap failed: 5: Input/output error".into() });
        let p = start(&place, &setup, &fake).unwrap_err();
        assert_eq!(p.fix, Some(Fix::LoginItems));
    }

    #[test]
    fn stop_boots_out_and_restart_now_kickstarts_with_k() {
        let home = TempDir::new("svc-stop");
        let (place, setup) = mac(&home);
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(0, LAUNCHCTL_RUNNING));
        assert_eq!(stop(&place, &fake).unwrap(), "Stopped.");
        assert_eq!(restart_now(&place, &setup, &fake).unwrap(), "Restarting…");
        let calls = fake.calls();
        assert!(calls.contains(&"launchctl bootout gui/501/com.crosstalk.hub".to_string()));
        assert!(calls.contains(&"launchctl kickstart -k gui/501/com.crosstalk.hub".to_string()));
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(113, ""));
        assert_eq!(stop(&place, &fake).unwrap(), "It's already stopped.");
    }

    #[test]
    fn when_the_service_s_state_can_t_be_read() {
        let home = TempDir::new("svc-unknown");
        let (place, setup) = mac(&home);
        let fake = Fake::new();
        fake.answer("launchctl print", Output { code: Some(5), stdout: String::new(), stderr: "Input/output error".into() });
        // Stop and Restart now act all the same, rather than call it stopped (or load it again).
        assert_eq!(stop(&place, &fake).unwrap(), "Stopped.");
        assert_eq!(restart_now(&place, &setup, &fake).unwrap(), "Restarting…");
        let calls = fake.calls();
        assert!(calls.contains(&"launchctl bootout gui/501/com.crosstalk.hub".to_string()), "{calls:?}");
        assert!(calls.contains(&"launchctl kickstart -k gui/501/com.crosstalk.hub".to_string()), "{calls:?}");
        // A boot-out that failed isn't called stopped while the state is still unknown.
        fake.answer("launchctl bootout", Output { code: Some(5), stdout: String::new(), stderr: "Boot-out failed: 5: Input/output error".into() });
        assert!(stop(&place, &fake).unwrap_err().message.contains("Boot-out failed"));
        // Start doesn't guess between loading it and kicking it.
        assert_eq!(start(&place, &setup, &fake).unwrap_err().fix, Some(Fix::Retry));
        assert!(!fake.calls().iter().any(|c| c.starts_with("launchctl bootstrap") || c == "launchctl kickstart gui/501/com.crosstalk.hub"));
    }

    #[test]
    fn systemd_actions() {
        let home = TempDir::new("svc-linux");
        let place = Place::for_test(Os::Linux, home.path());
        std::fs::create_dir_all(place.service_file().parent().unwrap()).unwrap();
        std::fs::write(place.service_file(), "[Service]\nExecStart=/x/crosstalk-hub serve\n").unwrap();
        let setup = discover(&place);
        let fake = Fake::new();
        fake.answer("systemctl --user show", Output::exited(0, "LoadState=not-found\nActiveState=inactive\nSubState=dead\n"));
        start(&place, &setup, &fake).unwrap();
        assert_eq!(fake.calls()[1..], ["systemctl --user daemon-reload", "systemctl --user start crosstalk-hub"]);
        let fake = Fake::new();
        fake.answer("systemctl --user show", Output::exited(0, "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=5\n"));
        stop(&place, &fake).unwrap();
        restart_now(&place, &setup, &fake).unwrap();
        let calls = fake.calls();
        assert!(calls.contains(&"systemctl --user stop crosstalk-hub".to_string()) && calls.contains(&"systemctl --user restart crosstalk-hub".to_string()));
        let fake = Fake::new();
        fake.answer("systemctl --user start", Output { code: Some(5), stdout: String::new(), stderr: "Failed to start crosstalk-hub.service: Unit is masked.".into() });
        fake.answer("systemctl --user show", Output::exited(0, "LoadState=masked\nActiveState=inactive\nSubState=dead\n"));
        assert!(start(&place, &setup, &fake).unwrap_err().message.contains("Unit is masked"));
    }

    #[test]
    fn a_trial_never_reaches_the_real_service() {
        let home = TempDir::new("svc-rail");
        let (mut place, setup) = mac(&home);
        place.real_home = Some("/Users/someone-else".into());
        let fake = Fake::new();
        assert!(start(&place, &setup, &fake).is_err());
        assert!(stop(&place, &fake).is_err());
        assert!(restart_now(&place, &setup, &fake).is_err());
        assert_eq!(fake.calls(), Vec::<String>::new());
    }
}
