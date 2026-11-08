//! launchctl for the hub's LaunchAgent: the command lines, and what `launchctl print` says about the job.
//! `print`'s output isn't a stable interface, so only a few top-level lines are read.

use crate::run::Output;
use std::path::Path;

pub fn domain(uid: u32) -> String {
    format!("gui/{uid}")
}

pub fn target(uid: u32, label: &str) -> String {
    format!("gui/{uid}/{label}")
}

pub fn print(uid: u32, label: &str) -> Vec<String> {
    vec!["print".into(), target(uid, label)]
}

/// Loads the plist into this login session; the job then starts (RunAtLoad).
pub fn bootstrap(uid: u32, plist: &Path) -> Vec<String> {
    vec!["bootstrap".into(), domain(uid), plist.display().to_string()]
}

/// Unloads it: SIGTERM, then SIGKILL after the job's exit timeout. KeepAlive would bring back a hub that was only
/// killed, so this is how it stops; the plist stays, so it starts again at the next login.
pub fn bootout(uid: u32, label: &str) -> Vec<String> {
    vec!["bootout".into(), target(uid, label)]
}

/// Undoes `launchctl disable`, which would make bootstrap fail.
pub fn enable(uid: u32, label: &str) -> Vec<String> {
    vec!["enable".into(), target(uid, label)]
}

/// Starts a loaded job that isn't running; with `kill`, stops a running one first (a restart).
pub fn kickstart(uid: u32, label: &str, kill: bool) -> Vec<String> {
    let mut args = vec!["kickstart".to_string()];
    if kill {
        args.push("-k".into());
    }
    args.push(target(uid, label));
    args
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Job {
    pub state: Option<String>,
    pub pid: Option<u32>,
    pub last_exit: Option<i32>,
    /// "Killed: 9" when it was last ended by a signal.
    pub signal: Option<String>,
    pub runs: Option<u32>,
}

impl Job {
    pub fn running(&self) -> bool {
        self.state.as_deref() == Some("running") && self.pid.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Printed {
    /// Not loaded in this session: stopped, or never set up.
    NotLoaded,
    Loaded(Job),
    Failed(String),
}

pub fn parse_print(out: &Output) -> Printed {
    // 113: "Could not find service … in domain for user gui: 501".
    if out.code == Some(113) || out.said().contains("Could not find service") {
        return Printed::NotLoaded;
    }
    if !out.ok() {
        let said = out.said();
        return Printed::Failed(if said.is_empty() { format!("launchctl print failed (exit {})", out.code.unwrap_or(-1)) } else { said });
    }
    let mut job = Job::default();
    let mut depth = 0i32;
    for line in out.stdout.lines() {
        let t = line.trim();
        if t.starts_with('}') {
            depth -= 1;
            continue;
        }
        // Only the job's own lines: nested blocks (environment, coalitions) have their own "state = …".
        if depth == 1 {
            if let Some((key, value)) = t.split_once(" = ") {
                let number = || value.split(|c: char| !(c.is_ascii_digit() || c == '-')).next().and_then(|n| n.parse::<i64>().ok());
                match key {
                    "state" => job.state = Some(value.to_string()),
                    "pid" => job.pid = number().and_then(|n| u32::try_from(n).ok()),
                    "last exit code" => job.last_exit = number().and_then(|n| i32::try_from(n).ok()),
                    "last terminating signal" => job.signal = Some(value.to_string()),
                    "runs" => job.runs = number().and_then(|n| u32::try_from(n).ok()),
                    _ => {}
                }
            }
        }
        if t.ends_with('{') {
            depth += 1;
        }
    }
    Printed::Loaded(job)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::LAUNCHCTL_RUNNING as RUNNING;

    #[test]
    fn a_running_job() {
        let Printed::Loaded(job) = parse_print(&Output::exited(0, RUNNING)) else { panic!() };
        assert_eq!(job, Job { state: Some("running".into()), pid: Some(52468), last_exit: Some(0), signal: None, runs: Some(3) });
        assert!(job.running());
    }

    #[test]
    fn a_job_that_keeps_exiting() {
        let text = "gui/501/com.crosstalk.hub = {\n\tstate = spawn scheduled\n\truns = 14\n\tlast exit code = 1\n\tresource coalition = {\n\t\tstate = active\n\t}\n}\n";
        let Printed::Loaded(job) = parse_print(&Output::exited(0, text)) else { panic!() };
        assert_eq!(job.state.as_deref(), Some("spawn scheduled"));
        assert_eq!(job.last_exit, Some(1));
        assert_eq!(job.pid, None);
        assert!(!job.running());
    }

    #[test]
    fn a_job_ended_by_a_signal_that_never_exited_by_itself() {
        let text = "gui/501/com.crosstalk.hub = {\n\tstate = not running\n\tlast exit code = (never exited)\n\tlast terminating signal = Killed: 9\n}\n";
        let Printed::Loaded(job) = parse_print(&Output::exited(0, text)) else { panic!() };
        assert_eq!(job.last_exit, None);
        assert_eq!(job.signal.as_deref(), Some("Killed: 9"));
    }

    #[test]
    fn not_loaded_and_errors() {
        let missing = Output { code: Some(113), stdout: "Bad request.\nCould not find service \"com.crosstalk.hub\" in domain for user gui: 501\n".into(), stderr: String::new() };
        assert_eq!(parse_print(&missing), Printed::NotLoaded);
        assert_eq!(parse_print(&Output { code: Some(5), stdout: String::new(), stderr: "Input/output error".into() }), Printed::Failed("Input/output error".into()));
    }

    #[test]
    fn command_lines() {
        assert_eq!(print(501, "com.crosstalk.hub"), ["print", "gui/501/com.crosstalk.hub"]);
        assert_eq!(bootstrap(501, Path::new("/Users/someone/Library/LaunchAgents/com.crosstalk.hub.plist")), ["bootstrap", "gui/501", "/Users/someone/Library/LaunchAgents/com.crosstalk.hub.plist"]);
        assert_eq!(bootout(501, "com.crosstalk.hub"), ["bootout", "gui/501/com.crosstalk.hub"]);
        assert_eq!(enable(501, "com.crosstalk.hub"), ["enable", "gui/501/com.crosstalk.hub"]);
        assert_eq!(kickstart(501, "com.crosstalk.hub", false), ["kickstart", "gui/501/com.crosstalk.hub"]);
        assert_eq!(kickstart(501, "com.crosstalk.hub", true), ["kickstart", "-k", "gui/501/com.crosstalk.hub"]);
    }
}
