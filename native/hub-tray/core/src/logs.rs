//! The hub's recent log: the end of hub.log on macOS (the plist's StandardOutPath), the journal on Linux, and the
//! restart watcher's own log.

use crate::paths::{Os, Place, Setup};
use crate::run::{Cmd, Runner};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

pub const LINES: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Logs {
    pub hub: String,
    /// Where it came from: a file's path, or the journalctl command.
    pub hub_source: String,
    pub watcher: Option<String>,
    pub watcher_source: String,
    /// Why the hub's log couldn't be read.
    pub problem: Option<String>,
}

pub fn journal_args(unit: &str, lines: usize) -> Vec<String> {
    vec!["--user".into(), "-u".into(), unit.into(), "-n".into(), lines.to_string(), "--no-pager".into(), "-o".into(), "short-iso".into()]
}

pub fn read(place: &Place, setup: &Setup, runner: &dyn Runner) -> Logs {
    let watcher_log = place.watcher_log();
    let watcher = tail(&watcher_log, 40).ok();
    let watcher_source = watcher_log.display().to_string();
    // Linux services log to the journal unless a file is there.
    match setup.log_file.as_ref().filter(|f| place.os == Os::Mac || f.exists()) {
        Some(file) => match tail(file, LINES) {
            Ok(hub) => Logs { hub, hub_source: file.display().to_string(), watcher, watcher_source, problem: None },
            Err(e) => Logs { hub: String::new(), hub_source: file.display().to_string(), watcher, watcher_source, problem: Some(format!("Couldn't read {}: {e}", file.display())) },
        },
        None => {
            let cmd = Cmd::new(&place.journalctl, journal_args(&place.unit, LINES)).timeout(Duration::from_secs(10));
            let source = cmd.line();
            match runner.run(&cmd) {
                Ok(out) if out.ok() => Logs { hub: strip_ansi(&out.stdout), hub_source: source, watcher, watcher_source, problem: None },
                Ok(out) => Logs { hub: String::new(), hub_source: source, watcher, watcher_source, problem: Some(format!("journalctl didn't show the log: {}", out.said())) },
                Err(e) => Logs { hub: String::new(), hub_source: source, watcher, watcher_source, problem: Some(e) },
            }
        }
    }
}

/// The last `lines` lines of a file, reading only its end.
pub fn tail(path: &Path, lines: usize) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(256 * 1024);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    // A cut first line is dropped.
    let text = if start > 0 { text.split_once('\n').map(|(_, rest)| rest).unwrap_or("") } else { &text };
    let all: Vec<&str> = text.lines().collect();
    Ok(strip_ansi(&all[all.len().saturating_sub(lines)..].join("\n")))
}

/// Without terminal colour codes.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // Parameters, then one final byte in @..~.
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::discover;
    use crate::run::{Fake, Output};
    use crate::testing::TempDir;

    #[test]
    fn the_end_of_a_long_file() {
        let dir = TempDir::new("logs-tail");
        let path = dir.path().join("hub.log");
        let text: String = (0..20_000).map(|i| format!("16:00:00.000 INFO  [main] line {i}\n")).collect();
        std::fs::write(&path, text).unwrap();
        let t = tail(&path, 3).unwrap();
        assert_eq!(t, "16:00:00.000 INFO  [main] line 19997\n16:00:00.000 INFO  [main] line 19998\n16:00:00.000 INFO  [main] line 19999");
    }

    #[test]
    fn colour_codes_go() {
        assert_eq!(strip_ansi("\u{1b}[1m1/5  Installing\u{1b}[0m ok \u{1b}[33m  ! warn\u{1b}[0m"), "1/5  Installing ok   ! warn");
    }

    #[test]
    fn macos_reads_the_file_linux_the_journal() {
        let dir = TempDir::new("logs-read");
        let place = Place::for_test(Os::Mac, dir.path());
        std::fs::create_dir_all(place.log_dir()).unwrap();
        std::fs::write(place.log_dir().join("hub.log"), "a\nb\n").unwrap();
        let fake = Fake::new();
        let logs = read(&place, &discover(&place), &fake);
        assert_eq!((logs.hub.as_str(), logs.problem), ("a\nb", None));
        assert!(fake.calls().is_empty());

        let place = Place::for_test(Os::Linux, dir.path());
        let fake = Fake::new();
        fake.answer("journalctl", Output::exited(0, "2026-10-28T16:00:00+0000 box crosstalk-hub[12]: started\n"));
        let logs = read(&place, &discover(&place), &fake);
        assert!(logs.hub.contains("started"));
        assert_eq!(fake.calls(), ["journalctl --user -u crosstalk-hub -n 300 --no-pager -o short-iso"]);
    }
}
