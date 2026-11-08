//! "Restart when it's quiet": deploy/restart-when-idle.sh waits for five idle minutes (no turns or asks running,
//! no Claude helper writing) and then restarts the service. The app starts the maintained copy or its own (`script`),
//! detached and in its own process group, so it keeps waiting after the app quits, and in the hub's data folder, so it
//! can be told apart from another hub's. Only one ever runs: one started by hand (also the older
//! restart-when-turns-end.sh) counts.

use crate::paths::{same_dir, Os, Place, Setup, DEFAULT_LABEL, DEFAULT_UNIT};
use crate::procs::{self, Proc};
use crate::run::{which, Runner};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SCRIPTS: [&str; 2] = ["restart-when-idle.sh", "restart-when-turns-end.sh"];
const SHELLS: [&str; 4] = ["sh", "bash", "dash", "zsh"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Watcher {
    pub pid: u32,
    /// It leads its own process group (started here, or as a job from a shell): Cancel ends the group.
    pub own_group: bool,
    pub script: String,
    /// Seconds it has waited.
    pub waited: Option<u64>,
}

/// A shell running one of the watcher scripts, and nothing else that merely names it (an editor, a `tail`, a
/// command string such as `zsh -c "nano …/restart-when-idle.sh"`).
pub fn watchers(procs: &[Proc]) -> Vec<Watcher> {
    procs
        .iter()
        .filter_map(|p| {
            let base = |s: &str| Path::new(s).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let first = base(p.args.first()?);
            let script = if SCRIPTS.contains(&first.as_str()) {
                p.args.join(" ")
            } else if SHELLS.contains(&first.trim_start_matches('-')) {
                let options = p.args.iter().skip(1).take_while(|a| a.starts_with('-')).count();
                if p.args[1..=options].iter().any(|o| !o.starts_with("--") && o.contains('c')) {
                    return None;
                }
                // The scripts take no arguments, so the rest is the script's path (ps splits one with spaces in it,
                // like the app's own in "/Applications/Crosstalk Hub.app").
                let rest: Vec<&str> = p.args[1 + options..].iter().map(String::as_str).collect();
                Some(rest.join(" ")).filter(|r| SCRIPTS.contains(&base(r).as_str()))?
            } else {
                return None;
            };
            Some(Watcher { pid: p.pid, own_group: p.pgid == p.pid, script, waited: p.age })
        })
        .collect()
}

/// The watchers waiting for this hub: this account's, and none working in another hub's data folder (the app starts
/// each in its own hub's; one started by hand may work anywhere, and counts). A trial (a stand-in service tool) sees
/// and ends only its own, the script `ours` working in the trial hub's folder, never one waiting for the real hub.
pub fn find(place: &Place, setup: &Setup, runner: &dyn Runner, ours: Option<&Path>) -> Vec<Watcher> {
    let mine: Vec<Proc> = procs::list(runner).into_iter().filter(|p| p.uid == place.uid).collect();
    watchers(&mine)
        .into_iter()
        .filter(|w| {
            if place.fake && !ours.is_some_and(|o| Path::new(&w.script) == o) {
                return false;
            }
            match procs::cwd(w.pid, place.os, runner) {
                Some(dir) => same_dir(&dir, &setup.data_home) || (!place.fake && !dir.join("crosstalk.db").exists()),
                None => !place.fake,
            }
        })
        .collect()
}

/// The watcher to start. Outside trials, the maintained copy when it's there and can serve this hub: hub deploys keep
/// ~/.crosstalk/bin/restart-when-idle.sh up to date , while this app isn't updated with the hub, so its own
/// copy may not know newer kinds of work. Copies from before 0.4.1 restart only a LaunchAgent and read only
/// ~/.crosstalk, so they're used only where that's enough. A trial always uses the app's own copy, `bundled`.
pub fn script(place: &Place, setup: &Setup, bundled: Option<&Path>) -> Option<PathBuf> {
    let bundled = bundled.filter(|p| p.exists()).map(Path::to_path_buf);
    if place.fake {
        return bundled;
    }
    let maintained = place.default_data().join("bin/restart-when-idle.sh");
    let serves = |text: &str| (place.os == Os::Mac || text.contains("systemctl")) && (same_dir(&setup.data_home, &place.default_data()) || text.contains("CROSSTALK_HOME"));
    match std::fs::read_to_string(&maintained) {
        Ok(text) if serves(&text) => Some(maintained),
        _ => bundled,
    }
}

/// The watcher's environment: the hub's data folder and service name, and the service tool to use (a stand-in's
/// folder first on PATH in trials, so it can only restart that).
pub fn env(place: &Place, setup: &Setup) -> Vec<(String, String)> {
    let mut path = String::new();
    if place.fake {
        let tool = match place.os {
            Os::Mac => &place.launchctl,
            Os::Linux => &place.systemctl,
        };
        if let Some(dir) = tool.parent() {
            path.push_str(&dir.display().to_string());
            path.push(':');
        }
    }
    path.push_str("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    let mut env = vec![("PATH".to_string(), path), ("HOME".to_string(), place.home.display().to_string()), ("LANG".to_string(), "en_US.UTF-8".to_string())];
    if let Some(h) = setup.env.get("CROSSTALK_HOME").filter(|h| !h.trim().is_empty()) {
        env.push(("CROSSTALK_HOME".into(), h.clone()));
    }
    if place.label != DEFAULT_LABEL {
        env.push(("CROSSTALK_LABEL".into(), place.label.clone()));
    }
    if place.unit != DEFAULT_UNIT {
        env.push(("CROSSTALK_UNIT".into(), place.unit.clone()));
    }
    // `systemctl --user` finds the user's manager through these.
    for k in ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] {
        if let Ok(v) = std::env::var(k) {
            env.push((k.into(), v));
        }
    }
    env
}

/// Why it can't wait here, if it can't: on Linux the script needs the sqlite3 command, often missing on desktops.
pub fn missing_tool(env: &[(String, String)]) -> Option<String> {
    let path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.as_str()).unwrap_or("");
    which(path, "sqlite3").is_none().then(|| "Restart when it's quiet needs the sqlite3 command (on Debian or Ubuntu: sudo apt install sqlite3). Or use Restart now.".to_string())
}

/// Starts `script` detached, appending to `log`. Returns its pid.
pub fn start(place: &Place, setup: &Setup, script: &Path, log: &Path, runner: &dyn Runner) -> Result<u32, String> {
    place.may_change_service()?;
    if let Some(w) = find(place, setup, runner, Some(script)).first() {
        return Ok(w.pid);
    }
    if !script.exists() {
        return Err(format!("The restart helper isn't in this copy of the app ({}).", script.display()));
    }
    if !setup.data_home.is_dir() {
        return Err(format!("The hub's data folder ({}) isn't there, so there's nothing to wait for.", setup.data_home.display()));
    }
    let env = env(place, setup);
    if let Some(why) = missing_tool(&env) {
        return Err(why);
    }
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(log).map_err(|e| format!("Couldn't open {}: {e}", log.display()))?;
    let _ = writeln!(file, "{} Crosstalk Hub: waiting for five quiet minutes, then restarting {} ({})", now_text(), place.service_name(), script.display());
    let err = file.try_clone().map_err(|e| e.to_string())?;
    use std::os::unix::process::CommandExt;
    let mut child = Command::new("/bin/sh")
        .arg(script)
        .env_clear()
        .envs(env)
        // Its hub's data folder: that's how find() tells it from another hub's.
        .current_dir(&setup.data_home)
        .stdin(Stdio::null())
        .stdout(file)
        .stderr(err)
        // Its own group: not ended with the app, and Cancel can end it with the `sleep` it waits in.
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Couldn't start the restart helper: {e}"))?;
    let pid = child.id();
    // Reaped here if it finishes while the app runs; after the app quits, the system takes it over.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

/// Ends every watcher waiting for this hub (a trial: only its own). Returns how many there were.
pub fn cancel(place: &Place, setup: &Setup, runner: &dyn Runner, ours: Option<&Path>) -> Result<usize, String> {
    place.may_change_service()?;
    let found = find(place, setup, runner, ours);
    for w in &found {
        // SAFETY: kill only sends a signal; the pids come from ps a moment ago and are checked to be the script.
        let target = if w.own_group { -(w.pid as i32) } else { w.pid as i32 };
        if unsafe { libc::kill(target, libc::SIGTERM) } != 0 {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("Couldn't stop the waiting restart: {e}"));
            }
        }
    }
    Ok(found.len())
}

fn now_text() -> String {
    // The shell's own `date` keeps the log in the same format as the script's lines.
    Command::new("/bin/date").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::discover;
    use crate::run::{Fake, Output};
    use crate::testing::TempDir;

    fn ps(lines: &[&str]) -> Vec<Proc> {
        procs::parse_ps(&lines.join("\n"))
    }

    #[test]
    fn only_shells_running_the_scripts_count() {
        let found = watchers(&ps(&[
            "  900   900   501    05:00 /bin/sh /Users/someone/.crosstalk/bin/restart-when-idle.sh",
            "  901   880   501    01:00 sh restart-when-turns-end.sh",
            "  902   902   501    00:10 /bin/sh /Applications/Crosstalk Hub.app/Contents/Resources/deploy/restart-when-idle.sh",
            "  903   903   501    00:10 vim /Users/someone/.crosstalk/bin/restart-when-idle.sh",
            "  904   904   501    00:10 tail -f /Users/someone/Library/Logs/Crosstalk/restart-when-idle.log",
            "  905   905   501    00:10 /bin/sh -c ./build.sh",
            "  906   906   501    00:10 sh -c sh restart-when-idle.sh",
            // A command string only names it, wherever the name is.
            "  907   907   501    00:10 zsh -c nano /Users/someone/.crosstalk/bin/restart-when-idle.sh",
            "  908   908   501    00:10 bash -ec sh /Users/someone/.crosstalk/bin/restart-when-idle.sh",
            "  909   909   501    00:10 bash --norc -x /Users/someone/.crosstalk/bin/restart-when-idle.sh",
        ]));
        assert_eq!(found.iter().map(|w| w.pid).collect::<Vec<_>>(), [900, 901, 902, 909]);
        assert_eq!(found[0], Watcher { pid: 900, own_group: true, script: "/Users/someone/.crosstalk/bin/restart-when-idle.sh".into(), waited: Some(300) });
        assert!(!found[1].own_group);
        assert_eq!(found[2].script, "/Applications/Crosstalk Hub.app/Contents/Resources/deploy/restart-when-idle.sh");
    }

    /// A data folder, another hub's (it has a database) and a folder of no hub's, and ps and lsof saying which
    /// watcher works where.
    struct Machine {
        home: TempDir,
        place: Place,
        setup: Setup,
        fake: Fake,
    }

    fn machine(name: &str, watchers: &[(u32, u32, &str, Option<&str>)]) -> Machine {
        let home = TempDir::new(name);
        let place = Place::for_test(Os::Mac, home.path());
        let setup = discover(&place);
        for dir in [".crosstalk", "other-hub", "src"] {
            std::fs::create_dir_all(home.path().join(dir)).unwrap();
        }
        std::fs::write(home.path().join("other-hub/crosstalk.db"), "").unwrap();
        let fake = Fake::new();
        let lines: Vec<String> = watchers.iter().map(|(pid, uid, script, _)| format!("{pid} {pid} {uid} 05:00 /bin/sh {script}")).collect();
        fake.answer("ps -A", Output::exited(0, &lines.join("\n")));
        for (pid, _, _, cwd) in watchers {
            let out = cwd.map(|d| format!("p{pid}\nfcwd\nn{}\n", home.path().join(d).display()));
            fake.answer(&format!("lsof -a -p {pid} "), out.map(|o| Output::exited(0, &o)).unwrap_or_else(|| Output::exited(1, "")));
        }
        Machine { home, place, setup, fake }
    }

    #[test]
    fn only_this_account_s_watchers_for_this_hub_count() {
        let m = machine(
            "idle-find",
            &[
                (900, 501, "/x/restart-when-idle.sh", Some(".crosstalk")),
                (901, 502, "/x/restart-when-idle.sh", Some(".crosstalk")),
                (902, 501, "/x/restart-when-idle.sh", Some("other-hub")),
                (903, 501, "/x/restart-when-idle.sh", Some("src")),
                (904, 501, "/x/restart-when-idle.sh", None),
            ],
        );
        // Another account's (901) and one waiting for another hub (902, in its data folder) don't; one started by hand
        // in some other folder (903), or whose folder can't be seen (904), may be this hub's.
        assert_eq!(find(&m.place, &m.setup, &m.fake, None).iter().map(|w| w.pid).collect::<Vec<_>>(), [900, 903, 904]);
        assert!(!m.fake.calls().iter().any(|c| c.contains("-p 901 ")), "nobody else's process is looked into");
    }

    #[test]
    fn the_environment_names_the_hub_and_a_trial_s_stand_in() {
        let home = TempDir::new("idle-env");
        let mut place = Place::for_test(Os::Mac, home.path());
        let mut setup = discover(&place);
        setup.env.insert("CROSSTALK_HOME".into(), "/data/crosstalk".into());
        let env = env(&place, &setup);
        assert!(env.contains(&("CROSSTALK_HOME".into(), "/data/crosstalk".into())));
        assert!(!env.iter().any(|(k, _)| k == "CROSSTALK_LABEL"));
        assert_eq!(env[0], ("PATH".into(), "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()));
        place.fake = true;
        place.launchctl = "/tmp/trial/bin/launchctl".into();
        place.label = "com.crosstalk.hub.test".into();
        let env = super::env(&place, &setup);
        assert!(env[0].1.starts_with("/tmp/trial/bin:"));
        assert!(env.contains(&("CROSSTALK_LABEL".into(), "com.crosstalk.hub.test".into())));
    }

    #[test]
    fn the_maintained_copy_when_it_can_serve_this_hub_else_the_app_s() {
        let home = TempDir::new("idle-script");
        let bundled = home.path().join("app/deploy/restart-when-idle.sh");
        let maintained = home.path().join(".crosstalk/bin/restart-when-idle.sh");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::create_dir_all(maintained.parent().unwrap()).unwrap();
        std::fs::write(&bundled, "# the app's copy\n").unwrap();
        let place = Place::for_test(Os::Mac, home.path());
        let mut setup = discover(&place);
        assert_eq!(script(&place, &setup, Some(&bundled)), Some(bundled.clone()), "no maintained copy");
        // As 0.4.0's deploy installed it: LaunchAgent only, ~/.crosstalk only.
        std::fs::write(&maintained, "DB=\"$HOME/.crosstalk/crosstalk.db\"\nlaunchctl kickstart -k \"gui/$(id -u)/com.crosstalk.hub\"\n").unwrap();
        assert_eq!(script(&place, &setup, Some(&bundled)), Some(maintained.clone()));
        assert_eq!(script(&place, &setup, None), Some(maintained.clone()));
        // That copy would read the wrong database for a hub whose data is elsewhere, and can't restart a systemd unit.
        setup.data_home = home.path().join("data");
        assert_eq!(script(&place, &setup, Some(&bundled)), Some(bundled.clone()));
        let linux = Place::for_test(Os::Linux, home.path());
        let linux_setup = discover(&linux);
        assert_eq!(script(&linux, &linux_setup, Some(&bundled)), Some(bundled.clone()));
        std::fs::write(&maintained, "DB=\"${CROSSTALK_HOME:-$HOME/.crosstalk}/crosstalk.db\"\nsystemctl --user restart \"$UNIT\"\n").unwrap();
        assert_eq!(script(&linux, &linux_setup, Some(&bundled)), Some(maintained.clone()));
        assert_eq!(script(&place, &setup, Some(&bundled)), Some(maintained.clone()));
        // A trial: always the app's own copy (the one it alone sees).
        let mut trial = place.clone();
        trial.fake = true;
        assert_eq!(script(&trial, &setup, Some(&bundled)), Some(bundled.clone()));
        assert_eq!(script(&trial, &setup, None), None);
    }

    #[test]
    fn sqlite3_is_needed() {
        assert!(missing_tool(&[("PATH".into(), "/nowhere".into())]).is_some());
    }

    #[test]
    fn a_waiting_watcher_is_never_started_twice_and_a_trial_never_starts_one_for_real() {
        let m = machine("idle-start", &[(900, 501, "/x/restart-when-idle.sh", Some(".crosstalk"))]);
        let log = m.home.path().join("w.log");
        assert_eq!(start(&m.place, &m.setup, Path::new("/nonexistent.sh"), &log, &m.fake), Ok(900));
        let mut trial = m.place.clone();
        trial.real_home = Some("/Users/someone-else".into());
        assert!(start(&trial, &m.setup, Path::new("/nonexistent.sh"), &log, &m.fake).is_err());
        assert!(cancel(&trial, &m.setup, &m.fake, None).is_err());
    }

    #[test]
    fn a_trial_sees_only_its_own_watcher() {
        let ours = "/tmp/app/deploy/restart-when-idle.sh";
        let mut m = machine(
            "idle-trial",
            &[
                (900, 501, "/Users/someone/.crosstalk/bin/restart-when-idle.sh", Some("src")),
                (901, 501, ours, Some(".crosstalk")),
                // The same copy of the script, waiting for another hub (the real one, when the trial runs the
                // installed app), and one whose folder can't be seen.
                (902, 501, ours, Some("other-hub")),
                (903, 501, ours, None),
            ],
        );
        m.place.fake = true;
        assert_eq!(find(&m.place, &m.setup, &m.fake, Some(Path::new(ours))).iter().map(|w| w.pid).collect::<Vec<_>>(), [901]);
        assert!(find(&m.place, &m.setup, &m.fake, None).is_empty());
        m.place.fake = false;
        assert_eq!(find(&m.place, &m.setup, &m.fake, Some(Path::new(ours))).iter().map(|w| w.pid).collect::<Vec<_>>(), [900, 901, 903]);
    }
}
