//! Where things are. The hub's port, data folder and public address are found in the hub's own order: the service's
//! environment (the plist's EnvironmentVariables, the unit's Environment=), then CROSSTALK_HOME/config.json, then the
//! defaults. The app never reads its own CROSSTALK_* variables: it isn't the hub.

use crate::systemd;
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::{CStr, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub const DEFAULT_LABEL: &str = "com.crosstalk.hub";
pub const DEFAULT_UNIT: &str = "crosstalk-hub";
pub const DEFAULT_PORT: u16 = 7420;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// The account and tools this app works with. `from_env` reads them; tests make one by hand.
#[derive(Clone, Debug)]
pub struct Place {
    pub os: Os,
    pub home: PathBuf,
    /// The account's home in the password database. Another $HOME means a trial or a test.
    pub real_home: Option<PathBuf>,
    pub uid: u32,
    pub user: String,
    pub label: String,
    pub unit: String,
    pub launchctl: PathBuf,
    pub systemctl: PathBuf,
    pub journalctl: PathBuf,
    /// A stand-in service tool was given (CROSSTALK_HUB_APP_LAUNCHCTL or _SYSTEMCTL): every change goes to it.
    pub fake: bool,
}

impl Place {
    /// HOME, and the stand-ins trials and tests use: CROSSTALK_HUB_APP_LAUNCHCTL, _SYSTEMCTL, _JOURNALCTL, _LABEL, _UNIT.
    pub fn from_env() -> Place {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty());
        let (uid, user, real_home) = account();
        let os = Os::current();
        let home = var("HOME").map(PathBuf::from).or_else(|| real_home.clone()).unwrap_or_else(|| PathBuf::from("/"));
        let launchctl = var("CROSSTALK_HUB_APP_LAUNCHCTL").map(PathBuf::from);
        let systemctl = var("CROSSTALK_HUB_APP_SYSTEMCTL").map(PathBuf::from);
        let fake = match os {
            Os::Mac => launchctl.is_some(),
            Os::Linux => systemctl.is_some(),
        };
        let first = |names: &[&str]| names.iter().map(PathBuf::from).find(|p| p.exists()).unwrap_or_else(|| PathBuf::from(names[0]));
        Place {
            os,
            home,
            real_home,
            uid,
            user,
            label: var("CROSSTALK_HUB_APP_LABEL").map(|v| v.to_string_lossy().into_owned()).unwrap_or_else(|| DEFAULT_LABEL.into()),
            unit: var("CROSSTALK_HUB_APP_UNIT").map(|v| v.to_string_lossy().into_owned()).unwrap_or_else(|| DEFAULT_UNIT.into()),
            launchctl: launchctl.unwrap_or_else(|| PathBuf::from("/bin/launchctl")),
            systemctl: systemctl.unwrap_or_else(|| first(&["/usr/bin/systemctl", "/bin/systemctl"])),
            journalctl: var("CROSSTALK_HUB_APP_JOURNALCTL").map(PathBuf::from).unwrap_or_else(|| first(&["/usr/bin/journalctl", "/bin/journalctl"])),
            fake,
        }
    }

    /// A place for tests: a made-up account at `home`, with stand-in tools.
    pub fn for_test(os: Os, home: &Path) -> Place {
        Place {
            os,
            home: home.to_path_buf(),
            real_home: Some(home.to_path_buf()),
            uid: 501,
            user: "someone".into(),
            label: DEFAULT_LABEL.into(),
            unit: DEFAULT_UNIT.into(),
            launchctl: PathBuf::from("/bin/launchctl"),
            systemctl: PathBuf::from("/usr/bin/systemctl"),
            journalctl: PathBuf::from("/usr/bin/journalctl"),
            fake: false,
        }
    }

    pub fn service_file(&self) -> PathBuf {
        match self.os {
            Os::Mac => self.home.join("Library/LaunchAgents").join(format!("{}.plist", self.label)),
            Os::Linux => self.home.join(".config/systemd/user").join(format!("{}.service", self.unit)),
        }
    }

    pub fn default_bin(&self) -> PathBuf {
        self.home.join(".local/bin/crosstalk-hub")
    }

    pub fn default_data(&self) -> PathBuf {
        self.home.join(".crosstalk")
    }

    /// The hub's log when its service doesn't say (macOS; on Linux it goes to the journal).
    pub fn default_log(&self) -> Option<PathBuf> {
        match self.os {
            Os::Mac => Some(self.log_dir().join("hub.log")),
            Os::Linux => None,
        }
    }

    pub fn log_dir(&self) -> PathBuf {
        match self.os {
            Os::Mac => self.home.join("Library/Logs/Crosstalk"),
            Os::Linux => self.home.join(".local/state/crosstalk"),
        }
    }

    /// Where the restart-when-quiet watcher writes, as the deploy steps have it.
    pub fn watcher_log(&self) -> PathBuf {
        self.log_dir().join("restart-when-idle.log")
    }

    /// "LaunchAgent com.crosstalk.hub" or "systemd user service crosstalk-hub".
    pub fn service_name(&self) -> String {
        match self.os {
            Os::Mac => format!("LaunchAgent {}", self.label),
            Os::Linux => format!("systemd user service {}", self.unit),
        }
    }

    /// The last line of defence for the user's live hub: a run with another HOME (a trial, a test) or a test label
    /// may only change a stand-in service, never the real one.
    pub fn may_change_service(&self) -> Result<(), String> {
        if self.fake {
            return Ok(());
        }
        if self.label != DEFAULT_LABEL || self.unit != DEFAULT_UNIT {
            return Err("A test service name was given without a stand-in service tool, so nothing was changed.".into());
        }
        match &self.real_home {
            Some(real) if same_dir(real, &self.home) => Ok(()),
            _ => Err("HOME isn't this account's home folder (a trial?), so the real service wasn't touched. Set CROSSTALK_HUB_APP_LAUNCHCTL or CROSSTALK_HUB_APP_SYSTEMCTL to a stand-in to try changes.".into()),
        }
    }
}

pub(crate) fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// This process's user id, name and home folder from the password database.
fn account() -> (u32, String, Option<PathBuf>) {
    // SAFETY: getuid can't fail; getpwuid_r writes only into the buffers given, and the strings are read before
    // those go away.
    unsafe {
        let uid = libc::getuid();
        let mut buf = vec![0 as libc::c_char; 16 * 1024];
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        if libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut found) != 0 || found.is_null() {
            return (uid, String::new(), None);
        }
        let name = CStr::from_ptr(pwd.pw_name).to_string_lossy().into_owned();
        let dir = PathBuf::from(OsStr::from_bytes(CStr::from_ptr(pwd.pw_dir).to_bytes()));
        (uid, name, Some(dir))
    }
}

/// What a service definition says about how the hub runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Definition {
    pub program: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub log_file: Option<PathBuf>,
    /// systemd's EnvironmentFile= files (read into `env` once the unit and its drop-ins are).
    pub env_files: Vec<PathBuf>,
}

/// The LaunchAgent's plist: ProgramArguments (or Program), EnvironmentVariables and StandardOutPath.
pub fn read_plist(bytes: &[u8]) -> Result<Definition, String> {
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes)).map_err(|e| format!("The service's plist can't be read: {e}"))?;
    let dict = value.as_dictionary().ok_or("The service's plist isn't a dictionary")?;
    let program = dict
        .get("ProgramArguments")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_string())
        .or_else(|| dict.get("Program").and_then(|v| v.as_string()))
        .map(PathBuf::from);
    let env = dict
        .get("EnvironmentVariables")
        .and_then(|v| v.as_dictionary())
        .map(|d| d.iter().filter_map(|(k, v)| v.as_string().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();
    let log_file = dict.get("StandardOutPath").and_then(|v| v.as_string()).map(PathBuf::from);
    Ok(Definition { program, env, log_file, env_files: Vec::new() })
}

/// The settings in CROSSTALK_HOME/config.json that matter here.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigFile {
    pub port: Option<u16>,
    pub public_url: Option<String>,
}

pub fn read_config(text: &str) -> ConfigFile {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return ConfigFile::default() };
    ConfigFile {
        port: v.get("port").and_then(|p| p.as_u64().or_else(|| p.as_str().and_then(|s| s.trim().parse().ok()))).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0),
        public_url: v.get("publicUrl").and_then(|u| u.as_str()).map(trim_url).filter(|u| !u.is_empty()),
    }
}

fn trim_url(u: &str) -> String {
    u.trim().trim_end_matches('/').to_string()
}

/// How the hub is set up here, as far as files tell.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub service_file: PathBuf,
    /// The plist or unit file exists.
    pub service_defined: bool,
    pub bin: PathBuf,
    pub bin_exists: bool,
    pub data_home: PathBuf,
    pub port: u16,
    pub public_url: Option<String>,
    /// The hub's log file (macOS); None means the journal.
    pub log_file: Option<PathBuf>,
    /// The service's own environment (PATH, LANG, CROSSTALK_HOME…), handed on to the hub's CLI.
    #[serde(skip)]
    pub env: BTreeMap<String, String>,
    /// The service definition exists but couldn't be read.
    pub problem: Option<String>,
}

impl Setup {
    /// http://127.0.0.1:<port>: the hub only listens there; phones reach it through `tailscale serve`.
    pub fn local_address(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// Reads the service definition and config.json.
pub fn discover(place: &Place) -> Setup {
    let service_file = place.service_file();
    let mut problem = None;
    let def = match place.os {
        Os::Mac => match std::fs::read(&service_file) {
            Ok(bytes) => read_plist(&bytes).map_err(|e| problem = Some(e)).ok(),
            Err(_) => None,
        },
        // With its drop-ins and environment files: `systemctl --user edit` is how a unit is usually changed.
        Os::Linux => systemd::read_service(&service_file, &place.home),
    };
    let service_defined = service_file.exists();
    let def = def.unwrap_or_default();
    let var = |k: &str| def.env.get(k).map(|v| v.trim()).filter(|v| !v.is_empty());
    let data_home = match var("CROSSTALK_HOME") {
        Some(h) => {
            let p = expand(h, &place.home);
            if p.is_absolute() {
                p
            } else {
                place.home.join(p)
            }
        }
        None => place.default_data(),
    };
    let config = std::fs::read_to_string(data_home.join("config.json")).map(|t| read_config(&t)).unwrap_or_default();
    let port = var("CROSSTALK_PORT").and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0).or(config.port).unwrap_or(DEFAULT_PORT);
    let public_url = var("CROSSTALK_PUBLIC_URL").map(trim_url).or(config.public_url);
    let bin = def.program.clone().map(|p| expand(&p.to_string_lossy(), &place.home)).unwrap_or_else(|| place.default_bin());
    Setup {
        service_file,
        service_defined,
        bin_exists: crate::run::is_executable(&bin),
        bin,
        data_home,
        port,
        public_url,
        log_file: def.log_file.clone().or_else(|| place.default_log()),
        env: def.env,
        problem,
    }
}

fn expand(p: &str, home: &Path) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if p == "~" => home.to_path_buf(),
        None => PathBuf::from(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{plist, TempDir};
    use std::fs;

    #[test]
    fn the_plist_gives_the_program_environment_and_log() {
        let def = read_plist(plist(&[("CROSSTALK_PORT", "7421"), ("CROSSTALK_HOST", "127.0.0.1")]).as_bytes()).unwrap();
        assert_eq!(def.program, Some(PathBuf::from("/Users/someone/.local/bin/crosstalk-hub")));
        assert_eq!(def.env.get("CROSSTALK_PORT").map(String::as_str), Some("7421"));
        assert_eq!(def.log_file, Some(PathBuf::from("/Users/someone/Library/Logs/Crosstalk/hub.log")));
        assert!(read_plist(b"not a plist").is_err());
    }

    #[test]
    fn config_json_gives_port_and_public_url() {
        let c = read_config(r#"{"port": 7500, "host": "127.0.0.1", "publicUrl": "https://mini.example.ts.net/", "workspaceRoot": "/x"}"#);
        assert_eq!(c, ConfigFile { port: Some(7500), public_url: Some("https://mini.example.ts.net".into()) });
        assert_eq!(read_config(r#"{"publicUrl": null}"#), ConfigFile::default());
        assert_eq!(read_config("{broken"), ConfigFile::default());
    }

    #[test]
    fn the_service_environment_wins_over_config_json_like_in_the_hub() {
        let home = TempDir::new("paths-mac");
        let place = Place::for_test(Os::Mac, home.path());
        fs::create_dir_all(home.path().join("Library/LaunchAgents")).unwrap();
        let data = home.path().join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("config.json"), r#"{"port": 7500, "publicUrl": "https://from-config.example"}"#).unwrap();
        let env = [("CROSSTALK_PORT", "7421"), ("CROSSTALK_HOME", data.to_str().unwrap())];
        fs::write(place.service_file(), plist(&env)).unwrap();
        let s = discover(&place);
        assert!(s.service_defined);
        assert_eq!(s.port, 7421);
        assert_eq!(s.data_home, data);
        // Not in the service's environment, so config.json's.
        assert_eq!(s.public_url.as_deref(), Some("https://from-config.example"));
        assert_eq!(s.bin, PathBuf::from("/Users/someone/.local/bin/crosstalk-hub"));

        fs::write(place.service_file(), plist(&[("CROSSTALK_HOME", data.to_str().unwrap()), ("CROSSTALK_PUBLIC_URL", "https://mini.example.ts.net")])).unwrap();
        let s = discover(&place);
        assert_eq!(s.port, 7500);
        assert_eq!(s.public_url.as_deref(), Some("https://mini.example.ts.net"));
    }

    #[test]
    fn nothing_installed_means_the_defaults() {
        let home = TempDir::new("paths-none");
        let place = Place::for_test(Os::Mac, home.path());
        let s = discover(&place);
        assert!(!s.service_defined && !s.bin_exists);
        assert_eq!(s.port, DEFAULT_PORT);
        assert_eq!(s.data_home, home.path().join(".crosstalk"));
        assert_eq!(s.bin, home.path().join(".local/bin/crosstalk-hub"));
        assert_eq!(s.log_file, Some(home.path().join("Library/Logs/Crosstalk/hub.log")));
        assert_eq!(s.local_address(), "http://127.0.0.1:7420");
    }

    #[test]
    fn the_linux_unit_is_read_the_same_way() {
        let home = TempDir::new("paths-linux");
        let place = Place::for_test(Os::Linux, home.path());
        fs::create_dir_all(place.service_file().parent().unwrap()).unwrap();
        fs::write(
            place.service_file(),
            "[Unit]\nDescription=Crosstalk hub\n\n[Service]\nType=simple\nExecStart=/home/someone/.local/bin/crosstalk-hub serve\nEnvironment=CROSSTALK_PORT=7422\nEnvironment=CROSSTALK_HOST=127.0.0.1\nEnvironment=CROSSTALK_PUBLIC_URL=https://box.example.ts.net\n\n[Install]\nWantedBy=default.target\n",
        )
        .unwrap();
        let s = discover(&place);
        assert!(s.service_defined);
        assert_eq!(s.port, 7422);
        assert_eq!(s.public_url.as_deref(), Some("https://box.example.ts.net"));
        assert_eq!(s.bin, PathBuf::from("/home/someone/.local/bin/crosstalk-hub"));
        assert_eq!(s.log_file, None);
    }

    #[test]
    fn a_drop_in_s_port_and_data_folder_count() {
        let home = TempDir::new("paths-dropin");
        let place = Place::for_test(Os::Linux, home.path());
        let dropins = home.path().join(".config/systemd/user/crosstalk-hub.service.d");
        fs::create_dir_all(&dropins).unwrap();
        fs::write(place.service_file(), "[Service]\nExecStart=/home/someone/.local/bin/crosstalk-hub serve\nEnvironment=CROSSTALK_PORT=7420\n").unwrap();
        fs::write(dropins.join("override.conf"), "[Service]\nEnvironment=CROSSTALK_PORT=7500 CROSSTALK_HOME=%h/hub-data\n").unwrap();
        fs::create_dir_all(home.path().join("hub-data")).unwrap();
        fs::write(home.path().join("hub-data/config.json"), r#"{"publicUrl": "https://box.example.ts.net"}"#).unwrap();
        let s = discover(&place);
        assert_eq!(s.port, 7500);
        assert_eq!(s.data_home, home.path().join("hub-data"));
        assert_eq!(s.public_url.as_deref(), Some("https://box.example.ts.net"));
    }

    #[test]
    fn only_the_real_home_or_a_stand_in_may_change_the_service() {
        let home = TempDir::new("paths-rail");
        let mut place = Place::for_test(Os::Mac, home.path());
        assert!(place.may_change_service().is_ok());
        place.real_home = Some(PathBuf::from("/Users/someone-else"));
        assert!(place.may_change_service().is_err());
        place.fake = true;
        assert!(place.may_change_service().is_ok());
        place.fake = false;
        place.real_home = Some(home.path().to_path_buf());
        place.label = "com.crosstalk.hub.test".into();
        assert!(place.may_change_service().is_err());
    }
}
