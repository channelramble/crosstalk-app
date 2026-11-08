//! Installing the hub where there's none: the app bundles deploy/install-macos.sh (or deploy/install.sh) and a hub
//! binary and runs that script as it is, after saying what it will change. Never for updates: the installers restart
//! the hub at once, which isn't safe for a hub in use.

use crate::pair;
use crate::paths::{self, Os, Place, Setup};
use crate::run::Cmd;
use crate::status::State;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// What this copy of the app carries.
#[derive(Debug, Clone, Default)]
pub struct Bundle {
    pub installer: Option<PathBuf>,
    pub hub: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub on: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub possible: bool,
    pub why_not: Option<String>,
    /// The hub is on disk already and is kept; only its service is set up.
    pub service_only: bool,
    pub steps: Vec<String>,
    pub choices: Vec<Choice>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chosen {
    #[serde(default)]
    pub tailscale: bool,
    #[serde(default)]
    pub power: bool,
}

fn tilde(place: &Place, p: &std::path::Path) -> String {
    match p.strip_prefix(&place.home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => p.display().to_string(),
    }
}

pub fn plan(place: &Place, setup: &Setup, bundle: &Bundle, state: State) -> Plan {
    let service_only = state == State::NoService;
    let mut why_not = None;
    if !matches!(state, State::NotInstalled | State::NoService) {
        why_not = Some("Crosstalk is already set up here. Updates go through Restart, never through the installer.".to_string());
    } else if bundle.installer.as_ref().is_none_or(|p| !p.exists()) {
        why_not = Some("This copy of the app has no installer in it.".into());
    } else if !service_only && bundle.hub.as_ref().is_none_or(|p| !p.exists()) {
        why_not = Some("This copy of the app has no hub in it. Build it with scripts/build-macos.sh, which puts one in.".into());
    } else if let Err(e) = place.may_change_service() {
        why_not = Some(e);
    } else if place.fake && setup.port == paths::DEFAULT_PORT {
        // The installer's health check would find the real hub there and call the trial a success.
        why_not = Some(format!("A trial needs a port of its own, not {}: put one in the trial's config.json.", paths::DEFAULT_PORT));
    }
    let port = setup.port;
    let bin = tilde(place, &place.default_bin());
    let file = tilde(place, &place.service_file());
    let copy = if service_only { format!("Keeps the hub that's at {bin}.") } else { format!("Copies the hub to {bin}.") };
    let (steps, choices) = match place.os {
        Os::Mac => (
            vec![
                format!("{copy} It's signed with your Apple Development identity if you have one, so macOS remembers what it may open."),
                format!("Adds a background service ({file}) that starts the hub when you log in and brings it back if it stops. It listens on this Mac only (port {port})."),
                "Checks Xcode, the iOS Simulator, git, Homebrew and npm, and tells you what's missing. It installs none of them.".into(),
                "Makes a one-time code to pair your phone. Your data stays in ~/.crosstalk.".into(),
            ],
            vec![
                Choice { id: "tailscale".into(), label: "Reach it from your phone".into(), detail: "Publishes it to your own Tailscale devices over HTTPS (tailscale serve). Nobody else can reach it.".into(), on: true },
                Choice {
                    id: "power".into(),
                    label: "Keep the Mac awake".into(),
                    detail: if place.fake { "Not in a trial: it would change this Mac's real settings.".into() } else { "Stops sleep and restarts after a power cut (pmset). macOS asks for your password.".into() },
                    on: !place.fake,
                },
            ],
        ),
        Os::Linux if place.fake => (
            vec![
                copy,
                format!("Adds a systemd user service ({file}) through the stand-in systemctl. It listens on this computer only (port {port})."),
                "Not in a trial: keeping it running when you're logged out (loginctl enable-linger) would change this computer's real settings.".into(),
                "Not in a trial: publishing it with Tailscale (tailscale serve) would point this computer's real address at the trial.".into(),
                "Makes a one-time code to pair a phone with the trial.".into(),
            ],
            vec![],
        ),
        Os::Linux => (
            vec![
                copy,
                format!("Adds a systemd user service ({file}) that starts the hub when the computer starts and brings it back if it stops. It listens on this computer only (port {port})."),
                "Keeps it running when you're logged out (loginctl enable-linger, which may ask for your password).".into(),
                "Publishes it to your own Tailscale devices over HTTPS (tailscale serve), if Tailscale is installed and connected.".into(),
                "Makes a one-time code to pair your phone. Your data stays in ~/.crosstalk.".into(),
            ],
            vec![],
        ),
    };
    Plan { possible: why_not.is_none(), why_not, service_only, steps, choices }
}

/// The installer's command line and environment.
pub fn command(place: &Place, setup: &Setup, bundle: &Bundle, chosen: Chosen, state: State) -> Result<Cmd, String> {
    let p = plan(place, setup, bundle, state);
    if let Some(why) = p.why_not {
        return Err(why);
    }
    let installer = bundle.installer.clone().unwrap_or_default();
    let src = if p.service_only { setup.bin.clone() } else { bundle.hub.clone().unwrap_or_default() };
    let mut args = vec![installer.display().to_string(), src.display().to_string()];
    let mut path = String::new();
    if place.fake {
        let tool = if place.os == Os::Mac { &place.launchctl } else { &place.systemctl };
        if let Some(dir) = tool.parent() {
            path = format!("{}:", dir.display());
        }
    }
    let home = place.home.display().to_string();
    let mut env = vec![
        ("HOME".to_string(), home.clone()),
        ("USER".to_string(), place.user.clone()),
        ("LOGNAME".to_string(), place.user.clone()),
        ("LANG".to_string(), "en_US.UTF-8".to_string()),
        ("CROSSTALK_PORT".to_string(), setup.port.to_string()),
    ];
    match place.os {
        Os::Mac => {
            // The power step runs on its own, in macOS's password dialog: the script's sudo would need a terminal.
            args.push("--no-power".into());
            if !chosen.tailscale || place.fake {
                args.push("--no-tailscale".into());
            }
            path.push_str("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        }
        Os::Linux => {
            path.push_str(&format!("{home}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
            for k in ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] {
                if let Ok(v) = std::env::var(k) {
                    env.push((k.into(), v));
                }
            }
            if place.fake {
                // Only systemctl has a stand-in: linger and `tailscale serve` would be the computer's real ones (the
                // live hub's address pointed at the trial).
                env.push(("CROSSTALK_NO_LINGER".into(), "1".into()));
                env.push(("CROSSTALK_NO_TAILSCALE".into(), "1".into()));
            }
        }
    }
    env.push(("PATH".into(), path));
    if let Ok(t) = std::env::var("TMPDIR") {
        env.push(("TMPDIR".into(), t));
    }
    if place.fake {
        // A trial installs a test service, signed ad hoc (no keychain).
        env.push(("CROSSTALK_LABEL".into(), place.label.clone()));
        env.push(("SIGN_IDENTITY".into(), "-".into()));
    }
    Ok(Cmd::new("/bin/bash", args).env(env).timeout(Duration::from_secs(600)))
}

/// macOS's own password dialog runs the installer's power step: no sleep, restart after a power cut.
pub fn power_command() -> Cmd {
    Cmd::new("/usr/bin/osascript", ["-e", r#"do shell script "/usr/bin/pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 powernap 0" with administrator privileges"#]).timeout(Duration::from_secs(300))
}

/// The pairing code in the installer's last lines.
pub fn pairing_code(output: &str) -> Option<String> {
    pair::parse_code(output)
}

/// What install.sh couldn't do without a terminal for sudo, and the desktop's own password dialog (pkexec) can.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinuxFix {
    /// Keep the hub running while logged out.
    Linger,
    /// Let this account run `tailscale serve`, then publish the hub.
    TailscaleOperator,
}

pub fn linux_fixes(output: &str) -> Vec<LinuxFix> {
    let mut fixes = Vec::new();
    if output.contains("couldn't enable linger") {
        fixes.push(LinuxFix::Linger);
    }
    if output.contains("tailscale serve failed") {
        fixes.push(LinuxFix::TailscaleOperator);
    }
    fixes
}

/// What a fix runs: Linux only, and never in a trial, where it would change this computer's real settings.
pub fn linux_fix_commands(fix: LinuxFix, place: &Place, setup: &Setup) -> Result<Vec<Cmd>, String> {
    if place.os != Os::Linux {
        return Err("That's for Linux.".into());
    }
    place.may_change_service()?;
    if place.fake {
        return Err("Not in a trial: that would change this computer's real settings.".into());
    }
    let pkexec = |args: &[&str]| Cmd::new("/usr/bin/pkexec", args.iter().map(|a| a.to_string())).timeout(Duration::from_secs(300));
    Ok(match fix {
        LinuxFix::Linger => vec![pkexec(&["loginctl", "enable-linger", &place.user])],
        LinuxFix::TailscaleOperator => vec![
            pkexec(&["tailscale", "set", &format!("--operator={}", place.user)]),
            Cmd::new("tailscale", ["serve".to_string(), "--bg".into(), "--https=443".into(), setup.local_address()]).timeout(Duration::from_secs(60)),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::discover;
    use crate::testing::TempDir;

    fn bundle(dir: &TempDir) -> Bundle {
        let installer = dir.path().join("install-macos.sh");
        let hub = dir.path().join("crosstalk-hub");
        std::fs::write(&installer, "#!/bin/bash\n").unwrap();
        std::fs::write(&hub, "").unwrap();
        Bundle { installer: Some(installer), hub: Some(hub) }
    }

    #[test]
    fn offered_only_where_nothing_is_installed() {
        let dir = TempDir::new("install-plan");
        let place = Place::for_test(Os::Mac, dir.path());
        let setup = discover(&place);
        let b = bundle(&dir);
        assert!(plan(&place, &setup, &b, State::NotInstalled).possible);
        assert!(plan(&place, &setup, &b, State::NoService).service_only);
        for state in [State::Running, State::Stopped, State::Failing, State::Outside] {
            assert!(!plan(&place, &setup, &b, state).possible, "{state:?}");
        }
        assert!(!plan(&place, &setup, &Bundle::default(), State::NotInstalled).possible);
        let mut trial = place.clone();
        trial.real_home = Some("/Users/someone-else".into());
        assert!(!plan(&trial, &setup, &b, State::NotInstalled).possible);
    }

    #[test]
    fn the_macos_installer_runs_without_its_sudo_step() {
        let dir = TempDir::new("install-cmd");
        let place = Place::for_test(Os::Mac, dir.path());
        let setup = discover(&place);
        let b = bundle(&dir);
        let cmd = command(&place, &setup, &b, Chosen { tailscale: true, power: true }, State::NotInstalled).unwrap();
        assert_eq!(cmd.program, PathBuf::from("/bin/bash"));
        assert_eq!(cmd.args[2..], ["--no-power"]);
        let env = cmd.env.clone().unwrap();
        assert!(env.contains(&("CROSSTALK_PORT".into(), "7420".into())));
        assert!(!env.iter().any(|(k, _)| k == "CROSSTALK_LABEL" || k == "SIGN_IDENTITY"));
        let cmd = command(&place, &setup, &b, Chosen::default(), State::NotInstalled).unwrap();
        assert_eq!(cmd.args[2..], ["--no-power", "--no-tailscale"]);
        // Only the service: the hub already there is the one installed.
        let cmd = command(&place, &setup, &b, Chosen::default(), State::NoService).unwrap();
        assert_eq!(cmd.args[1], setup.bin.display().to_string());
    }

    #[test]
    fn a_trial_installs_a_test_service_through_the_stand_in() {
        let dir = TempDir::new("install-trial");
        let mut place = Place::for_test(Os::Mac, dir.path());
        place.fake = true;
        place.launchctl = "/tmp/trial/bin/launchctl".into();
        place.label = "com.crosstalk.hub.test".into();
        let mut setup = discover(&place);
        // Never on the real hub's port.
        assert!(command(&place, &setup, &bundle(&dir), Chosen::default(), State::NotInstalled).unwrap_err().contains("7420"));
        setup.port = 7431;
        let cmd = command(&place, &setup, &bundle(&dir), Chosen { tailscale: true, power: true }, State::NotInstalled).unwrap();
        let env = cmd.env.clone().unwrap();
        let path = &env.iter().find(|(k, _)| k == "PATH").unwrap().1;
        assert!(path.starts_with("/tmp/trial/bin:"));
        assert!(env.contains(&("CROSSTALK_LABEL".into(), "com.crosstalk.hub.test".into())));
        assert!(env.contains(&("SIGN_IDENTITY".into(), "-".into())));
        assert!(env.contains(&("CROSSTALK_PORT".into(), "7431".into())));
        assert!(cmd.args.contains(&"--no-tailscale".to_string()));
        assert!(!plan(&place, &setup, &bundle(&dir), State::NotInstalled).choices[1].on);
    }

    #[test]
    fn linux_steps_the_script_could_not_take() {
        let out = "  ! couldn't enable linger; the hub stops when you log out\n  ! tailscale serve failed. Run: sudo tailscale set --operator=someone  then rerun this script.\n";
        assert_eq!(linux_fixes(out), [LinuxFix::Linger, LinuxFix::TailscaleOperator]);
        let dir = TempDir::new("install-linux");
        let place = Place::for_test(Os::Linux, dir.path());
        let setup = discover(&place);
        let lines: Vec<String> = linux_fix_commands(LinuxFix::TailscaleOperator, &place, &setup).unwrap().iter().map(Cmd::line).collect();
        assert_eq!(lines, ["pkexec tailscale set --operator=someone", "tailscale serve --bg --https=443 http://127.0.0.1:7420"]);
        assert_eq!(pairing_code("    Open   https://box.example.ts.net\n    Pairing code: AB23-9XYZ  (valid until 16:32)\n"), Some("AB23-9XYZ".into()));
        assert!(linux_fix_commands(LinuxFix::Linger, &Place::for_test(Os::Mac, dir.path()), &setup).is_err());
    }

    #[test]
    fn a_linux_trial_leaves_linger_and_tailscale_alone() {
        let dir = TempDir::new("install-linux-trial");
        let mut place = Place::for_test(Os::Linux, dir.path());
        place.fake = true;
        place.systemctl = "/tmp/trial/bin/systemctl".into();
        let mut setup = discover(&place);
        setup.port = 7431;
        let b = bundle(&dir);
        let cmd = command(&place, &setup, &b, Chosen::default(), State::NotInstalled).unwrap();
        let env = cmd.env.clone().unwrap();
        assert!(env.contains(&("CROSSTALK_NO_LINGER".into(), "1".into())) && env.contains(&("CROSSTALK_NO_TAILSCALE".into(), "1".into())));
        assert!(env.iter().find(|(k, _)| k == "PATH").unwrap().1.starts_with("/tmp/trial/bin:"));
        let steps = plan(&place, &setup, &b, State::NotInstalled).steps;
        assert!(steps.iter().any(|s| s.starts_with("Not in a trial: keeping it running")) && steps.iter().any(|s| s.starts_with("Not in a trial: publishing it")));
        // Nor do the fixes offered after an install.
        assert!(linux_fix_commands(LinuxFix::TailscaleOperator, &place, &setup).unwrap_err().contains("Not in a trial"));
        assert!(linux_fix_commands(LinuxFix::Linger, &place, &setup).is_err());
        // Not a trial: as it always was.
        place.fake = false;
        let env = command(&place, &setup, &b, Chosen::default(), State::NotInstalled).unwrap().env.unwrap();
        assert!(!env.iter().any(|(k, _)| k == "CROSSTALK_NO_LINGER" || k == "CROSSTALK_NO_TAILSCALE"));
    }
}
