//! Start at login, for this app (the hub's own service starts at login regardless). macOS uses SMAppService (in
//! the app crate), Linux an XDG autostart entry, trials and tests a marker file. On its first run from where it's
//! installed the app turns itself on once; after that it's the person's choice, so turning it off sticks.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginState {
    On,
    Off,
    /// macOS: added, but switched off under Login Items until the person allows it.
    NeedsApproval,
    Unavailable,
}

pub trait LoginItem: Send + Sync {
    fn state(&self) -> LoginState;
    fn set(&self, on: bool) -> Result<LoginState, String>;
}

/// A stand-in: on while the file exists.
pub struct Marker(pub PathBuf);

impl LoginItem for Marker {
    fn state(&self) -> LoginState {
        if self.0.exists() {
            LoginState::On
        } else {
            LoginState::Off
        }
    }

    fn set(&self, on: bool) -> Result<LoginState, String> {
        if on {
            if let Some(dir) = self.0.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&self.0, "on\n").map_err(|e| e.to_string())?;
        } else if self.0.exists() {
            std::fs::remove_file(&self.0).map_err(|e| e.to_string())?;
        }
        Ok(self.state())
    }
}

/// ~/.config/autostart/crosstalk-hub-app.desktop, which desktop sessions start at login.
pub struct DesktopEntry {
    pub path: PathBuf,
    pub exec: PathBuf,
}

impl DesktopEntry {
    pub fn new(home: &Path, exec: &Path) -> DesktopEntry {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".config"));
        DesktopEntry { path: config.join("autostart/crosstalk-hub-app.desktop"), exec: exec.to_path_buf() }
    }
}

/// An Exec= value: quoted when it has to be, with the characters the spec reserves inside quotes escaped.
fn exec_word(p: &Path) -> String {
    let s = p.display().to_string();
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) {
        return s;
    }
    let escaped: String = s.chars().flat_map(|c| if "\"`$\\".contains(c) { vec!['\\', c] } else { vec![c] }).collect();
    format!("\"{escaped}\"")
}

pub fn desktop_entry(exec: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Crosstalk Hub\nComment=Shows whether the Crosstalk hub is running, and starts, stops and pairs it\nExec={} --hidden\nIcon=crosstalk-hub-app\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        exec_word(exec)
    )
}

impl LoginItem for DesktopEntry {
    fn state(&self) -> LoginState {
        match std::fs::read_to_string(&self.path) {
            Ok(text) if !text.contains("Hidden=true") && !text.contains("X-GNOME-Autostart-enabled=false") => LoginState::On,
            _ => LoginState::Off,
        }
    }

    fn set(&self, on: bool) -> Result<LoginState, String> {
        if on {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
            }
            std::fs::write(&self.path, desktop_entry(&self.exec)).map_err(|e| format!("Couldn't write {}: {e}", self.path.display()))?;
        } else if self.path.exists() {
            std::fs::remove_file(&self.path).map_err(|e| format!("Couldn't remove {}: {e}", self.path.display()))?;
        }
        Ok(self.state())
    }
}

/// What the app remembers between runs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// It turned itself on to start at login once.
    #[serde(default)]
    pub login_item_offered: bool,
    /// It showed its window once (the first run shows it).
    #[serde(default)]
    pub window_shown: bool,
}

impl AppState {
    pub fn load(path: &Path) -> AppState {
        std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.new");
        std::fs::write(&tmp, serde_json::to_string_pretty(self).unwrap_or_default()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}

/// The first run from where it's installed turns Start at login on, once. Returns what it did, if anything.
pub fn first_run(item: &dyn LoginItem, state_file: &Path, installed: bool) -> Result<Option<LoginState>, String> {
    if !installed {
        return Ok(None);
    }
    let mut st = AppState::load(state_file);
    if st.login_item_offered {
        return Ok(None);
    }
    // Remembered even when it fails, so a refusal isn't asked about at every start: the menu can still turn it on.
    st.login_item_offered = true;
    st.save(state_file)?;
    item.set(true).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn the_first_installed_run_turns_it_on_once_and_off_sticks() {
        let dir = TempDir::new("autostart-first");
        let item = Marker(dir.path().join("login-item"));
        let state = dir.path().join("state.json");
        // A build run from its build folder isn't installed: nothing happens, and the first installed run still counts.
        assert_eq!(first_run(&item, &state, false), Ok(None));
        assert_eq!(item.state(), LoginState::Off);
        assert_eq!(first_run(&item, &state, true), Ok(Some(LoginState::On)));
        assert_eq!(item.state(), LoginState::On);
        item.set(false).unwrap();
        assert_eq!(first_run(&item, &state, true), Ok(None));
        assert_eq!(item.state(), LoginState::Off);
        assert!(AppState::load(&state).login_item_offered);
    }

    #[test]
    fn a_refusal_is_not_asked_again_at_every_start() {
        struct Refuses;
        impl LoginItem for Refuses {
            fn state(&self) -> LoginState {
                LoginState::Off
            }
            fn set(&self, _: bool) -> Result<LoginState, String> {
                Err("Operation not permitted".into())
            }
        }
        let dir = TempDir::new("autostart-refused");
        let state = dir.path().join("state.json");
        assert!(first_run(&Refuses, &state, true).is_err());
        assert_eq!(first_run(&Refuses, &state, true), Ok(None));
    }

    #[test]
    fn the_linux_autostart_entry() {
        let dir = TempDir::new("autostart-linux");
        let item = DesktopEntry { path: dir.path().join(".config/autostart/crosstalk-hub-app.desktop"), exec: "/usr/bin/crosstalk-hub-app".into() };
        assert_eq!(item.state(), LoginState::Off);
        assert_eq!(item.set(true), Ok(LoginState::On));
        let text = std::fs::read_to_string(&item.path).unwrap();
        assert!(text.contains("Exec=/usr/bin/crosstalk-hub-app --hidden\n"));
        assert!(text.starts_with("[Desktop Entry]\nType=Application\n"));
        assert_eq!(item.set(false), Ok(LoginState::Off));
        assert!(!item.path.exists());
        assert_eq!(exec_word(Path::new("/opt/Crosstalk Hub/app\"s")), "\"/opt/Crosstalk Hub/app\\\"s\"");
    }
}
