//! Running the few programs the app uses (launchctl, systemctl, ps, the hub's own CLI) with a time limit, and a
//! stand-in for tests that only records what would have run.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Output {
    /// None when it was ended by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// Everything it printed, for an error message.
    pub fn said(&self) -> String {
        let mut s = self.stdout.trim().to_string();
        let err = self.stderr.trim();
        if !err.is_empty() {
            if !s.is_empty() {
                s.push('\n');
            }
            s.push_str(err);
        }
        s
    }

    pub fn exited(code: i32, stdout: &str) -> Output {
        Output { code: Some(code), stdout: stdout.to_string(), stderr: String::new() }
    }
}

/// A program to run, its arguments and, when set, the only environment it gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cmd {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Some: the environment is cleared and only these are set.
    pub env: Option<Vec<(String, String)>>,
    pub timeout: Duration,
}

impl Cmd {
    pub fn new<I, S>(program: impl Into<PathBuf>, args: I) -> Cmd
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Cmd { program: program.into(), args: args.into_iter().map(Into::into).collect(), env: None, timeout: Duration::from_secs(15) }
    }

    pub fn env(mut self, env: Vec<(String, String)>) -> Cmd {
        self.env = Some(env);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Cmd {
        self.timeout = timeout;
        self
    }

    /// The program's name and its arguments: "launchctl print gui/501/com.crosstalk.hub".
    pub fn line(&self) -> String {
        let name = self.program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.program.display().to_string());
        std::iter::once(name).chain(self.args.iter().cloned()).collect::<Vec<_>>().join(" ")
    }
}

pub trait Runner: Send + Sync {
    fn run(&self, cmd: &Cmd) -> Result<Output, String>;
}

/// Runs programs for real.
pub struct System;

impl Runner for System {
    fn run(&self, cmd: &Cmd) -> Result<Output, String> {
        let mut c = Command::new(&cmd.program);
        c.args(&cmd.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(env) = &cmd.env {
            c.env_clear();
            c.envs(env.iter().map(|(k, v)| (k, v)));
        }
        let name = cmd.line().split(' ').next().unwrap_or_default().to_string();
        let mut child = c.spawn().map_err(|e| format!("Couldn't run {}: {e}", cmd.program.display()))?;
        let reader = |pipe: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut p) = pipe {
                    let _ = p.read_to_end(&mut buf);
                }
                String::from_utf8_lossy(&buf).into_owned()
            })
        };
        let out = reader(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
        let err = reader(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
        let deadline = Instant::now() + cmd.timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Ok(Output { code: status.code(), stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() });
                }
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    // The readers are left to finish on their own: something it started may still hold the pipes.
                    return Err(format!("{name} didn't finish within {} seconds", cmd.timeout.as_secs()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => return Err(format!("Couldn't wait for {name}: {e}")),
            }
        }
    }
}

/// Runs `cmd` for real and hands each line it prints (stdout and stderr, as they come) to `on_line`. Returns its
/// exit code (None when a signal ended it). For long jobs like the installer, whose output is shown as it runs.
pub fn stream(cmd: &Cmd, on_line: &mut dyn FnMut(&str)) -> Result<Option<i32>, String> {
    use std::io::BufRead;
    let mut c = Command::new(&cmd.program);
    c.args(&cmd.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(env) = &cmd.env {
        c.env_clear();
        c.envs(env.iter().map(|(k, v)| (k, v)));
    }
    let mut child = c.spawn().map_err(|e| format!("Couldn't run {}: {e}", cmd.program.display()))?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let pipe = |r: Box<dyn Read + Send>, tx: std::sync::mpsc::Sender<String>| {
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(r).split(b'\n').map_while(Result::ok) {
                if tx.send(String::from_utf8_lossy(&line).trim_end_matches('\r').to_string()).is_err() {
                    break;
                }
            }
        })
    };
    if let Some(out) = child.stdout.take() {
        pipe(Box::new(out), tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        pipe(Box::new(err), tx.clone());
    }
    drop(tx);
    let deadline = Instant::now() + cmd.timeout;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => on_line(&line),
            // Both pipes closed: it's done (or only something it left behind still runs).
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("It didn't finish within {} minutes.", cmd.timeout.as_secs() / 60));
                }
                if let Ok(Some(_)) = child.try_wait() {
                    // Exited, but something it started may hold the pipes: take what's there and stop waiting.
                    while let Ok(line) = rx.recv_timeout(Duration::from_millis(300)) {
                        on_line(&line);
                    }
                    break;
                }
            }
        }
    }
    child.wait().map(|s| s.code()).map_err(|e| e.to_string())
}

/// A stand-in for tests: records each command line and answers with the newest answer whose start matches it
/// (exit 0 and no output when none does).
#[derive(Default)]
pub struct Fake {
    calls: Mutex<Vec<Cmd>>,
    answers: Mutex<Vec<(String, Output)>>,
}

impl Fake {
    pub fn new() -> Fake {
        Fake::default()
    }

    pub fn answer(&self, starts_with: &str, out: Output) {
        self.answers.lock().unwrap().push((starts_with.to_string(), out));
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(Cmd::line).collect()
    }

    pub fn commands(&self) -> Vec<Cmd> {
        self.calls.lock().unwrap().clone()
    }
}

impl Runner for Fake {
    fn run(&self, cmd: &Cmd) -> Result<Output, String> {
        let line = cmd.line();
        self.calls.lock().unwrap().push(cmd.clone());
        let answers = self.answers.lock().unwrap();
        Ok(answers.iter().rev().find(|(start, _)| line.starts_with(start.as_str())).map(|(_, out)| out.clone()).unwrap_or_else(|| Output::exited(0, "")))
    }
}

/// The first of `names` found in `PATH`-style `dirs`.
pub fn which(dirs: &str, name: &str) -> Option<PathBuf> {
    dirs.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| is_executable(p))
}

pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_a_program_and_keeps_what_it_printed() {
        let out = System.run(&Cmd::new("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"])).unwrap();
        assert_eq!(out.code, Some(3));
        assert_eq!(out.stdout, "out\n");
        assert_eq!(out.said(), "out\nerr");
    }

    #[test]
    fn a_cleared_environment_has_only_what_was_given() {
        let out = System.run(&Cmd::new("/usr/bin/env", Vec::<String>::new()).env(vec![("ONLY".into(), "this".into())])).unwrap();
        assert_eq!(out.stdout.trim(), "ONLY=this");
    }

    #[test]
    fn a_program_that_hangs_is_stopped() {
        let started = Instant::now();
        let err = System.run(&Cmd::new("/bin/sleep", ["5"]).timeout(Duration::from_millis(200))).unwrap_err();
        assert!(err.contains("didn't finish"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn streams_lines_as_they_come() {
        let mut lines = Vec::new();
        let code = stream(&Cmd::new("/bin/sh", ["-c", "echo one; echo two >&2; printf three; exit 4"]), &mut |l| lines.push(l.to_string())).unwrap();
        assert_eq!(code, Some(4));
        lines.sort();
        assert_eq!(lines, ["one", "three", "two"]);
    }

    #[test]
    fn the_fake_answers_by_the_start_of_the_line() {
        let fake = Fake::new();
        fake.answer("launchctl print", Output::exited(113, ""));
        assert_eq!(fake.run(&Cmd::new("/bin/launchctl", ["print", "gui/1/x"])).unwrap().code, Some(113));
        assert!(fake.run(&Cmd::new("/bin/launchctl", ["bootout", "gui/1/x"])).unwrap().ok());
        assert_eq!(fake.calls(), ["launchctl print gui/1/x", "launchctl bootout gui/1/x"]);
    }
}
