//! Start at login, for this app: SMAppService's main-app login item on macOS (listed under Login Items, with no
//! LaunchAgent of ours), an XDG autostart entry on Linux, and in trials (a stand-in service tool) a marker file, so a
//! trial never adds a real login item.

use hub_core::autostart::{LoginItem, Marker};
use hub_core::Place;
use std::path::Path;

pub fn for_place(place: &Place, data_dir: &Path) -> Box<dyn LoginItem> {
    if place.fake {
        return Box::new(Marker(data_dir.join("start-at-login.trial")));
    }
    platform(place)
}

/// Running from where it's installed: /Applications on macOS, a package's /usr or /opt or an AppImage on Linux. A
/// build run from its build folder never adds itself to the login items.
pub fn installed(exe: &Path, home: &Path) -> bool {
    if cfg!(target_os = "macos") {
        exe.starts_with("/Applications") || exe.starts_with(home.join("Applications"))
    } else {
        std::env::var_os("APPIMAGE").is_some() || exe.starts_with("/usr") || exe.starts_with("/opt")
    }
}

#[cfg(target_os = "linux")]
fn platform(place: &Place) -> Box<dyn LoginItem> {
    // An AppImage runs from a new mount each time: the entry starts the AppImage file itself.
    use std::path::PathBuf;
    let exe = std::env::var_os("APPIMAGE").map(PathBuf::from).or_else(|| std::env::current_exe().ok()).unwrap_or_else(|| PathBuf::from("crosstalk-hub-app"));
    Box::new(hub_core::autostart::DesktopEntry::new(&place.home, &exe))
}

#[cfg(target_os = "macos")]
fn platform(_place: &Place) -> Box<dyn LoginItem> {
    Box::new(mac::MainApp)
}

/// System Settings → General → Login Items & Extensions.
pub fn open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::open_settings();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Startup apps are set in your desktop's own settings.".into())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use hub_core::autostart::{LoginItem, LoginState};
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    /// This app bundle as a login item (macOS 13+).
    pub struct MainApp;

    // Called from the app's own threads (the status poll), which have no autorelease pool of their own.
    use objc2::rc::autoreleasepool;

    impl LoginItem for MainApp {
        fn state(&self) -> LoginState {
            // SAFETY: SMAppService's class methods and status are safe to call from any thread.
            let status = autoreleasepool(|_| unsafe { SMAppService::mainAppService().status() });
            match status {
                SMAppServiceStatus::Enabled => LoginState::On,
                SMAppServiceStatus::RequiresApproval => LoginState::NeedsApproval,
                SMAppServiceStatus::NotRegistered => LoginState::Off,
                // NotFound: not running from an app bundle (a plain `cargo run`).
                _ => LoginState::Unavailable,
            }
        }

        fn set(&self, on: bool) -> Result<LoginState, String> {
            // SAFETY: as above; register and unregister only talk to the system's login items.
            autoreleasepool(|_| unsafe {
                let service = SMAppService::mainAppService();
                if on {
                    service.registerAndReturnError()
                } else {
                    service.unregisterAndReturnError()
                }
                .map_err(|e| e.localizedDescription().to_string())
            })?;
            Ok(self.state())
        }
    }

    pub fn open_settings() {
        // SAFETY: opens System Settings; nothing else.
        autoreleasepool(|_| unsafe { SMAppService::openSystemSettingsLoginItems() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_installed_copy_adds_itself() {
        let home = Path::new("/Users/someone");
        if cfg!(target_os = "macos") {
            assert!(installed(Path::new("/Applications/Crosstalk Hub.app/Contents/MacOS/crosstalk-hub-app"), home));
            assert!(installed(Path::new("/Users/someone/Applications/Crosstalk Hub.app/Contents/MacOS/crosstalk-hub-app"), home));
            // A build, and a copy macOS runs from a translocated or downloaded place.
            assert!(!installed(Path::new("/Users/someone/src/native/hub-tray/target/release/bundle/macos/Crosstalk Hub.app/Contents/MacOS/crosstalk-hub-app"), home));
            assert!(!installed(Path::new("/private/var/folders/x/AppTranslocation/1/d/Crosstalk Hub.app/Contents/MacOS/crosstalk-hub-app"), home));
        } else {
            assert!(installed(Path::new("/usr/bin/crosstalk-hub-app"), home));
            assert!(!installed(Path::new("/home/someone/src/native/hub-tray/target/release/crosstalk-hub-app"), home));
        }
    }

    #[test]
    fn a_trial_gets_a_marker_never_a_real_login_item() {
        let dir = std::env::temp_dir().join(format!("ct-login-item-{}", std::process::id()));
        let mut place = Place::for_test(hub_core::Os::current(), &dir);
        place.fake = true;
        let item = for_place(&place, &dir);
        assert_eq!(item.state(), hub_core::autostart::LoginState::Off);
        assert_eq!(item.set(true), Ok(hub_core::autostart::LoginState::On));
        assert!(dir.join("start-at-login.trial").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
