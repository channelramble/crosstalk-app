//! Other processes, from `ps`: how long the hub has run, and which restart watchers are waiting.

use crate::paths::Os;
use crate::run::{Cmd, Runner};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub pgid: u32,
    /// Its owner's user id.
    pub uid: u32,
    /// Seconds since it started.
    pub age: Option<u64>,
    pub args: Vec<String>,
}

const PS: &str = "/bin/ps";

/// Every process: `ps -A -o pid= -o pgid= -o uid= -o etime= -o args=` (the same on macOS and Linux).
pub fn list(runner: &dyn Runner) -> Vec<Proc> {
    let cmd = Cmd::new(PS, ["-A", "-o", "pid=", "-o", "pgid=", "-o", "uid=", "-o", "etime=", "-o", "args="]).timeout(Duration::from_secs(5));
    runner.run(&cmd).map(|o| parse_ps(&o.stdout)).unwrap_or_default()
}

pub fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let pid = words.next()?.parse().ok()?;
            let pgid = words.next()?.parse().ok()?;
            let uid = words.next()?.parse().ok()?;
            let age = parse_etime(words.next()?);
            Some(Proc { pid, pgid, uid, age, args: words.map(String::from).collect() })
        })
        .collect()
}

/// The folder one of this account's processes works in: lsof on macOS, /proc on Linux.
pub fn cwd(pid: u32, os: Os, runner: &dyn Runner) -> Option<PathBuf> {
    match os {
        Os::Mac => {
            let cmd = Cmd::new("/usr/sbin/lsof", ["-a".to_string(), "-p".into(), pid.to_string(), "-d".into(), "cwd".into(), "-Fn".into()]).timeout(Duration::from_secs(5));
            let out = runner.run(&cmd).ok().filter(|o| o.ok())?;
            out.stdout.lines().find_map(|l| l.strip_prefix('n')).filter(|p| !p.is_empty()).map(PathBuf::from)
        }
        Os::Linux => std::fs::read_link(format!("/proc/{pid}/cwd")).ok(),
    }
}

/// How long one process has run, from `ps -o etime= -p <pid>`.
pub fn age(pid: u32, runner: &dyn Runner) -> Option<u64> {
    let cmd = Cmd::new(PS, ["-o".to_string(), "etime=".into(), "-p".into(), pid.to_string()]).timeout(Duration::from_secs(5));
    runner.run(&cmd).ok().filter(|o| o.ok()).and_then(|o| parse_etime(o.stdout.trim()))
}

/// ps's elapsed time, "[[dd-]hh:]mm:ss", in seconds.
pub fn parse_etime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<u64> = rest.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let secs = match parts.as_slice() {
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(days * 86400 + secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_times() {
        assert_eq!(parse_etime("00:07"), Some(7));
        assert_eq!(parse_etime("12:34"), Some(754));
        assert_eq!(parse_etime("01:02:03"), Some(3723));
        assert_eq!(parse_etime("2-01:00:00"), Some(2 * 86400 + 3600));
        assert_eq!(parse_etime("soon"), None);
    }

    #[test]
    fn ps_lines() {
        let procs = parse_ps("    1     1     0 10-00:00:00 /sbin/launchd\n52468 52468   501    01:02:03 /Users/someone/.local/bin/crosstalk-hub serve\n  oops\n");
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[1], Proc { pid: 52468, pgid: 52468, uid: 501, age: Some(3723), args: vec!["/Users/someone/.local/bin/crosstalk-hub".into(), "serve".into()] });
    }

    #[test]
    fn the_folder_a_process_works_in() {
        let fake = crate::run::Fake::new();
        fake.answer("lsof -a -p 900", crate::run::Output::exited(0, "p900\nfcwd\nn/Users/someone/.crosstalk\n"));
        assert_eq!(cwd(900, Os::Mac, &fake), Some(PathBuf::from("/Users/someone/.crosstalk")));
        assert_eq!(fake.calls(), ["lsof -a -p 900 -d cwd -Fn"]);
        // Another account's process, or one that has gone.
        fake.answer("lsof -a -p 901", crate::run::Output::exited(1, ""));
        assert_eq!(cwd(901, Os::Mac, &fake), None);
    }
}
