//! Start, Restart now, Stop and Restart when it's quiet for real, through scripts/fake-launchctl.sh: a stand-in
//! launchctl that runs a test hub (from the source, on a spare port, in a home of its own) the way launchd runs the
//! LaunchAgent. The real launchctl is never called, and the service name is a test one, so even a stray call couldn't
//! reach the user's hub. macOS only (the stand-in is launchctl's); skipped when bun isn't installed.
#![cfg(target_os = "macos")]

use hub_core::paths::{Os, Place};
use hub_core::status::{Hub, State, Status};
use hub_core::{idle, service, System};
use std::fs;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LABEL: &str = "com.crosstalk.hub.test";

fn bun() -> Option<PathBuf> {
    let on_path = std::env::var("PATH").unwrap_or_default().split(':').map(|d| Path::new(d).join("bun")).find(|p| p.is_file());
    on_path.or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".bun/bin/bun")).filter(|p| p.is_file()))
}

fn executable(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Ends whatever the test started, however it ends.
struct Trial {
    dir: PathBuf,
    place: Place,
    script: PathBuf,
}

impl Drop for Trial {
    fn drop(&mut self) {
        let _ = idle::cancel(&self.place, &hub_core::paths::discover(&self.place), &System, Some(&self.script));
        let _ = service::stop(&self.place, &System);
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn wait_for(hub: &Hub<System>, what: &str, ok: impl Fn(&Status) -> bool) -> Status {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let s = hub.status();
        if ok(&s) {
            return s;
        }
        assert!(Instant::now() < until, "waited for {what}; last: {} ({:?}): {}", s.title, s.state, s.detail);
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn start_restart_now_stop_and_a_waiting_restart() {
    let Some(bun) = bun() else {
        eprintln!("skipped: bun isn't installed");
        return;
    };
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
    let dir = std::env::temp_dir().join(format!("ct-hub-app-actions-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let home = dir.join("home");
    let port = loop {
        let p = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        if p != 7420 {
            break p;
        }
    };
    let tool = dir.join("bin/launchctl");
    executable(&tool, &fs::read_to_string(repo.join("native/hub-tray/scripts/fake-launchctl.sh")).unwrap());
    let shim = home.join(".local/bin/crosstalk-hub");
    executable(&shim, &format!("#!/bin/sh\nexec '{}' '{}' \"$@\"\n", bun.display(), repo.join("hub/src/main.ts").display()));
    let plist = home.join(format!("Library/LaunchAgents/{LABEL}.plist"));
    fs::create_dir_all(plist.parent().unwrap()).unwrap();
    fs::write(
        &plist,
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{}</string><string>serve</string></array>
  <key>StandardOutPath</key><string>{}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>{}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>CROSSTALK_PORT</key><string>{port}</string>
    <key>CROSSTALK_HOST</key><string>127.0.0.1</string>
    <key>CROSSTALK_HOME</key><string>{}</string>
  </dict>
</dict>
</plist>"#,
            shim.display(),
            home.join("Library/Logs/Crosstalk/hub.log").display(),
            home.display(),
            home.join(".crosstalk").display(),
        ),
    )
    .unwrap();

    let mut place = Place::for_test(Os::Mac, &home);
    // SAFETY: getuid can't fail.
    place.uid = unsafe { libc::getuid() };
    place.label = LABEL.into();
    place.launchctl = tool.clone();
    place.fake = true;
    let script = repo.join("deploy/restart-when-idle.sh");
    let trial = Trial { dir: dir.clone(), place: place.clone(), script: script.clone() };
    let mut hub = Hub::new(place.clone(), System);
    hub.watcher_script = Some(script.clone());

    assert_eq!(hub.status().state, State::Stopped);
    assert_eq!(service::start(&place, &hub.setup(), &System).unwrap(), "Starting…");
    let first = wait_for(&hub, "the hub to start", |s| s.state == State::Running);
    assert_eq!(first.port, port);

    assert_eq!(service::restart_now(&place, &hub.setup(), &System).unwrap(), "Restarting…");
    let again = wait_for(&hub, "a new hub process", |s| s.state == State::Running && s.pid.is_some() && s.pid != first.pid);
    assert!(again.actions.restart);

    // Restart when it's quiet: the watcher waits detached, only once, and Cancel ends it.
    let log = home.join("Library/Logs/Crosstalk/restart-when-idle.log");
    let pid = idle::start(&place, &hub.setup(), &script, &log, &System).unwrap();
    let waiting = wait_for(&hub, "the waiting restart to show", |s| s.restart.is_some());
    assert_eq!(waiting.restart.as_ref().map(|w| w.pid), Some(pid));
    assert!(waiting.actions.cancel_restart && !waiting.actions.restart);
    assert_eq!(idle::start(&place, &hub.setup(), &script, &log, &System).unwrap(), pid, "never a second watcher");
    assert!(fs::read_to_string(&log).unwrap().contains(&format!("restarting LaunchAgent {LABEL}")));
    assert_eq!(hub.cancel_restart().unwrap(), 1);
    wait_for(&hub, "the waiting restart to go", |s| s.restart.is_none());

    // Restart now and Stop end a waiting restart first: nothing would be left for it to do.
    idle::start(&place, &hub.setup(), &script, &log, &System).unwrap();
    wait_for(&hub, "another waiting restart", |s| s.restart.is_some());
    assert_eq!(hub.restart_now().unwrap(), "Restarting… The waiting restart is cancelled.");
    wait_for(&hub, "a new hub process, and no waiting restart", |s| s.state == State::Running && s.pid.is_some() && s.pid != again.pid && s.restart.is_none());
    idle::start(&place, &hub.setup(), &script, &log, &System).unwrap();
    wait_for(&hub, "a waiting restart again", |s| s.restart.is_some());
    assert_eq!(hub.stop().unwrap(), "Stopped. The waiting restart is cancelled.");
    let stopped = wait_for(&hub, "the hub to stop, and no waiting restart", |s| s.state == State::Stopped && s.restart.is_none());
    assert!(stopped.actions.start && !stopped.actions.stop);

    let calls = fs::read_to_string(dir.join("state/calls.log")).unwrap();
    for done in [format!("enable gui/{}/{LABEL}", place.uid), format!("bootstrap gui/{} {}", place.uid, plist.display()), format!("kickstart -k gui/{}/{LABEL}", place.uid), format!("bootout gui/{}/{LABEL}", place.uid)] {
        assert!(calls.contains(&done), "no `{done}` in:\n{calls}");
    }
    drop(trial);
}
