//! `systemctl --user` for the hub's user service: the command lines, what `systemctl show` says, and the unit's
//! ExecStart= and Environment= (install.sh writes them), with its drop-ins and environment files.

use crate::paths::Definition;
use crate::run::Output;
use std::path::{Path, PathBuf};

pub const PROPERTIES: &str = "LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode,UnitFileState,FragmentPath";

pub fn show(unit: &str) -> Vec<String> {
    vec!["--user".into(), "show".into(), unit.into(), format!("--property={PROPERTIES}"), "--no-pager".into()]
}

pub fn start(unit: &str) -> Vec<String> {
    vec!["--user".into(), "start".into(), unit.into()]
}

/// Until the next `start` or boot: the unit stays enabled (WantedBy=default.target).
pub fn stop(unit: &str) -> Vec<String> {
    vec!["--user".into(), "stop".into(), unit.into()]
}

pub fn restart(unit: &str) -> Vec<String> {
    vec!["--user".into(), "restart".into(), unit.into()]
}

/// After the unit file was written or changed by hand.
pub fn daemon_reload() -> Vec<String> {
    vec!["--user".into(), "daemon-reload".into()]
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Unit {
    pub load: String,
    pub active: String,
    pub sub: String,
    pub pid: Option<u32>,
    pub exit_status: Option<i32>,
    /// ExecMainCode as systemd shows it: 1 exited, 2 killed, 3 dumped core.
    pub exit_code: Option<i32>,
    pub file_state: String,
    pub fragment: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shown {
    /// systemd doesn't know the unit (LoadState=not-found).
    NotFound,
    Found(Unit),
    Failed(String),
}

pub fn parse_show(out: &Output) -> Shown {
    if !out.ok() {
        let said = out.said();
        // "Failed to connect to bus": no user manager for this session.
        return Shown::Failed(if said.is_empty() { format!("systemctl show failed (exit {})", out.code.unwrap_or(-1)) } else { said });
    }
    let mut u = Unit::default();
    for line in out.stdout.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "LoadState" => u.load = value.into(),
            "ActiveState" => u.active = value.into(),
            "SubState" => u.sub = value.into(),
            "MainPID" => u.pid = value.parse().ok().filter(|p| *p > 0),
            "ExecMainStatus" => u.exit_status = value.parse().ok(),
            "ExecMainCode" => u.exit_code = value.parse().ok(),
            "UnitFileState" => u.file_state = value.into(),
            "FragmentPath" => u.fragment = Some(value).filter(|v| !v.is_empty()).map(PathBuf::from),
            _ => {}
        }
    }
    if u.load == "not-found" {
        return Shown::NotFound;
    }
    if u.load.is_empty() && u.active.is_empty() {
        return Shown::Failed("systemctl show said nothing about the unit".into());
    }
    Shown::Found(u)
}

/// Splits a value the way systemd does: words by whitespace, "double" and 'single' quotes, backslash escapes.
pub fn split_words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (_, '\\') => {
                if let Some(n) = chars.next() {
                    cur.push(match n {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                    in_word = true;
                }
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            (None, c) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    words
}

/// The unit as systemd puts it together: the unit file, then its drop-ins in name order (`systemctl --user edit`
/// writes <unit>.service.d/override.conf), then the EnvironmentFile= files, whose settings win over Environment=.
pub fn read_service(file: &Path, home: &Path) -> Option<Definition> {
    let read = |p: &Path| std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let mut def = read_unit(&read(file)?, home);
    let mut dropins: Vec<PathBuf> = std::fs::read_dir(format!("{}.d", file.display()))
        .map(|dir| dir.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "conf")).collect())
        .unwrap_or_default();
    dropins.sort();
    for d in dropins.iter().filter_map(|d| read(d)) {
        read_into(&mut def, &d, home);
    }
    for f in def.env_files.clone().iter().filter_map(|f| read(f)) {
        def.env.extend(env_file(&f));
    }
    Some(def)
}

/// One unit file's [Service] ExecStart= program, Environment= assignments and EnvironmentFile= files.
pub fn read_unit(text: &str, home: &Path) -> Definition {
    let mut def = Definition::default();
    read_into(&mut def, text, home);
    def
}

/// Reads a unit file or drop-in over what came before it, as systemd does: an empty ExecStart=, Environment= or
/// EnvironmentFile= clears what was set, and `%h` is the home folder.
fn read_into(def: &mut Definition, text: &str, home: &Path) {
    let mut in_service = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_service = t == "[Service]";
            continue;
        }
        if !in_service || t.starts_with('#') || t.starts_with(';') {
            continue;
        }
        let Some((key, value)) = t.split_once('=') else { continue };
        // Specifiers after the split, word by word, so a home folder with a space in it stays one word.
        match key.trim() {
            "ExecStart" => {
                // Prefixes: "-" ignore failure, "@" argv[0], ":" no expansion, "+" / "!" privileges.
                let words = split_words(value.trim_start().trim_start_matches(['-', '@', ':', '+', '!']));
                def.program = words.first().map(|w| PathBuf::from(specifiers(w, home)));
            }
            "Environment" => {
                let words = split_words(value);
                if words.is_empty() {
                    def.env.clear();
                }
                for w in words.iter().map(|w| specifiers(w, home)) {
                    if let Some((k, v)) = w.split_once('=') {
                        def.env.insert(k.to_string(), v.to_string());
                    }
                }
            }
            "EnvironmentFile" => match value.trim() {
                "" => def.env_files.clear(),
                // "-": no error when it's missing (a missing one is skipped here either way).
                f => def.env_files.push(PathBuf::from(specifiers(f.strip_prefix('-').unwrap_or(f), home))),
            },
            _ => {}
        }
    }
}

/// systemd's `%h` (the home folder) and `%%` in a unit's values; other specifiers stay as they are.
fn specifiers(s: &str, home: &Path) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match (c, chars.clone().next()) {
            ('%', Some('h')) => {
                chars.next();
                out.push_str(&home.display().to_string());
            }
            ('%', Some('%')) => {
                chars.next();
                out.push('%');
            }
            _ => out.push(c),
        }
    }
    out
}

/// An EnvironmentFile=: KEY=VALUE lines, # and ; comments, a value maybe in quotes.
pub fn env_file(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') || t.starts_with(';') {
                return None;
            }
            let (k, v) = t.split_once('=')?;
            let v = v.trim();
            let quoted = v.len() >= 2 && (v.starts_with('"') && v.ends_with('"') || v.starts_with('\'') && v.ends_with('\''));
            Some((k.trim().to_string(), if quoted { v[1..v.len() - 1].to_string() } else { v.to_string() }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_unit() {
        let out = Output::exited(0, "MainPID=1234\nExecMainStatus=0\nExecMainCode=0\nLoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=/home/someone/.config/systemd/user/crosstalk-hub.service\nUnitFileState=enabled\n");
        let Shown::Found(u) = parse_show(&out) else { panic!() };
        assert_eq!(u.pid, Some(1234));
        assert_eq!((u.active.as_str(), u.sub.as_str(), u.file_state.as_str()), ("active", "running", "enabled"));
        assert_eq!(u.fragment, Some(PathBuf::from("/home/someone/.config/systemd/user/crosstalk-hub.service")));
    }

    #[test]
    fn a_unit_that_keeps_failing_and_one_that_is_not_there() {
        let out = Output::exited(0, "MainPID=0\nExecMainStatus=1\nExecMainCode=1\nLoadState=loaded\nActiveState=activating\nSubState=auto-restart\nFragmentPath=/x.service\nUnitFileState=enabled\n");
        let Shown::Found(u) = parse_show(&out) else { panic!() };
        assert_eq!((u.pid, u.exit_status, u.sub.as_str()), (None, Some(1), "auto-restart"));
        let missing = Output::exited(0, "MainPID=0\nExecMainStatus=0\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nFragmentPath=\nUnitFileState=\n");
        assert_eq!(parse_show(&missing), Shown::NotFound);
        let no_bus = Output { code: Some(1), stdout: String::new(), stderr: "Failed to connect to bus: No medium found".into() };
        assert_eq!(parse_show(&no_bus), Shown::Failed("Failed to connect to bus: No medium found".into()));
    }

    #[test]
    fn words_and_quotes() {
        assert_eq!(split_words(r#"A=1 "B=two words" 'C=x y' D=a\ b"#), ["A=1", "B=two words", "C=x y", "D=a b"]);
        assert_eq!(split_words("  "), Vec::<String>::new());
    }

    #[test]
    fn the_unit_written_by_install_sh() {
        let home = Path::new("/home/someone");
        let def = read_unit(
            "[Unit]\nDescription=Crosstalk hub (group chat for coding agents)\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=/home/someone/.local/bin/crosstalk-hub serve\nRestart=always\nEnvironment=CROSSTALK_PORT=7420\nEnvironment=CROSSTALK_HOST=127.0.0.1\nEnvironment=PATH=/home/someone/.local/bin:/usr/bin:/bin\n\n# Agents run as you\nLimitNOFILE=65536\n\n[Install]\nWantedBy=default.target\n",
            home,
        );
        assert_eq!(def.program, Some(PathBuf::from("/home/someone/.local/bin/crosstalk-hub")));
        assert_eq!(def.env.get("CROSSTALK_PORT").map(String::as_str), Some("7420"));
        assert_eq!(def.env.get("PATH").map(String::as_str), Some("/home/someone/.local/bin:/usr/bin:/bin"));
        assert_eq!(read_unit("[Service]\nExecStart=-\"/opt/my hub/crosstalk-hub\" serve\n", home).program, Some(PathBuf::from("/opt/my hub/crosstalk-hub")));
        assert_eq!(read_unit("[Service]\nExecStart=%h/bin/crosstalk-hub serve\nEnvironment=A=100%%\n", home).env.get("A").map(String::as_str), Some("100%"));
        assert_eq!(read_unit("[Service]\nExecStart=%h/bin/crosstalk-hub serve\n", Path::new("/home/some one")).program, Some(PathBuf::from("/home/some one/bin/crosstalk-hub")));
    }

    #[test]
    fn drop_ins_and_environment_files_change_the_unit_as_systemd_does() {
        let home = crate::testing::TempDir::new("systemd-dropins");
        let unit = home.path().join(".config/systemd/user/crosstalk-hub.service");
        let dropins = home.path().join(".config/systemd/user/crosstalk-hub.service.d");
        std::fs::create_dir_all(&dropins).unwrap();
        std::fs::write(&unit, "[Service]\nExecStart=/home/someone/.local/bin/crosstalk-hub serve\nEnvironment=CROSSTALK_PORT=7420\nEnvironment=CROSSTALK_HOST=127.0.0.1\n").unwrap();
        // In name order: `systemctl --user edit`'s override.conf comes after 10-data.conf.
        std::fs::write(dropins.join("override.conf"), "[Service]\nEnvironment=LANG=en_GB.UTF-8 CROSSTALK_PORT=7500\nEnvironmentFile=-%h/.config/crosstalk.env\n").unwrap();
        std::fs::write(dropins.join("10-data.conf"), "[Service]\nEnvironment=CROSSTALK_HOME=%h/hub-data LANG=C\n").unwrap();
        std::fs::write(dropins.join("notes.txt"), "[Service]\nEnvironment=CROSSTALK_PORT=1\n").unwrap();
        // An environment file's settings win over Environment='s.
        std::fs::write(home.path().join(".config/crosstalk.env"), "# the hub's\nCROSSTALK_PORT=7600\nCROSSTALK_PUBLIC_URL=\"https://box.example.ts.net\"\n").unwrap();
        let def = read_service(&unit, home.path()).unwrap();
        let env = |k: &str| def.env.get(k).cloned();
        assert_eq!(env("CROSSTALK_PORT").as_deref(), Some("7600"));
        assert_eq!(env("LANG").as_deref(), Some("en_GB.UTF-8"));
        assert_eq!(env("CROSSTALK_HOME"), Some(home.path().join("hub-data").display().to_string()));
        assert_eq!(env("CROSSTALK_PUBLIC_URL").as_deref(), Some("https://box.example.ts.net"));
        assert_eq!(env("CROSSTALK_HOST").as_deref(), Some("127.0.0.1"));
        // A drop-in that replaces ExecStart= empties it first, as systemd wants.
        std::fs::write(dropins.join("20-bin.conf"), "[Service]\nExecStart=\nExecStart=/opt/crosstalk/crosstalk-hub serve\n").unwrap();
        assert_eq!(read_service(&unit, home.path()).unwrap().program, Some(PathBuf::from("/opt/crosstalk/crosstalk-hub")));
        assert_eq!(read_service(&home.path().join("nothing.service"), home.path()), None);
    }

    #[test]
    fn command_lines() {
        assert_eq!(show("crosstalk-hub"), ["--user", "show", "crosstalk-hub", "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode,UnitFileState,FragmentPath", "--no-pager"]);
        assert_eq!(start("crosstalk-hub"), ["--user", "start", "crosstalk-hub"]);
        assert_eq!(stop("crosstalk-hub"), ["--user", "stop", "crosstalk-hub"]);
        assert_eq!(restart("crosstalk-hub"), ["--user", "restart", "crosstalk-hub"]);
    }
}
