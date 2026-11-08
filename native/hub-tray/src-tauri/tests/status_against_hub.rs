//! The app's real binary (`status --json`, `pair --json`) against a real hub, started from the source like launchd or
//! systemd would start it, on a port of its own, with its own HOME and data folder. The service tool is a stand-in
//! that answers `print` (macOS) or `show` (Linux) and logs every call; the test fails if it was asked to change
//! anything. Nothing here can reach the user's hub: another port, another HOME, a test service name.
//! Skipped when bun isn't installed.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const LABEL: &str = "com.crosstalk.hub.test";
const UNIT: &str = "crosstalk-hub-test";

struct Temp(PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn bun() -> Option<PathBuf> {
    let on_path = std::env::var("PATH").unwrap_or_default().split(':').map(|d| Path::new(d).join("bun")).find(|p| p.is_file());
    on_path.or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".bun/bin/bun")).filter(|p| p.is_file()))
}

/// A port the system hands out, never the live hub's 7420.
fn free_port() -> u16 {
    loop {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        if port != 7420 {
            return port;
        }
    }
}

fn executable(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn quoted(p: &Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', r"'\''"))
}

fn http(port: u16, request: &str) -> (u16, String) {
    let mut s = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(2)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(request.as_bytes()).unwrap();
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let (code, body) = hub_core::health::parse(&buf).unwrap();
    (code, String::from_utf8_lossy(&body).into_owned())
}

fn stop(hub: &mut Child) {
    // SIGTERM, as launchd and systemd do: the hub ends what it started before exiting.
    // SAFETY: only signals the hub this test started.
    unsafe { libc::kill(hub.id() as i32, libc::SIGTERM) };
    let until = Instant::now() + Duration::from_secs(15);
    while Instant::now() < until {
        if let Ok(Some(_)) = hub.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = hub.kill();
    let _ = hub.wait();
}

#[test]
fn status_and_pairing_against_a_test_hub() {
    let Some(bun) = bun() else {
        eprintln!("skipped: bun isn't installed");
        return;
    };
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
    let version = serde_json::from_str::<serde_json::Value>(&fs::read_to_string(repo.join("hub/package.json")).unwrap()).unwrap()["version"].as_str().unwrap().to_string();
    let t = Temp(std::env::temp_dir().join(format!("ct-hub-app-it-{}", std::process::id())));
    let _ = fs::remove_dir_all(&t.0);
    let (home, data, state) = (t.0.join("home"), t.0.join("data"), t.0.join("state"));
    for d in [&home, &data, &state] {
        fs::create_dir_all(d).unwrap();
    }
    let port = free_port();

    // The hub's CLI where the installers put it, run from the source.
    let shim = home.join(".local/bin/crosstalk-hub");
    executable(&shim, &format!("#!/bin/sh\nexec {} {} \"$@\"\n", quoted(&bun), quoted(&repo.join("hub/src/main.ts"))));

    // The service definition, and a stand-in for its tool that only knows the test hub's pid (or that it's gone).
    let calls = state.join("calls");
    let pid_file = state.join("pid");
    let (tool_env, tool_path, name_env, name) = if cfg!(target_os = "macos") {
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
  <key>ProgramArguments</key><array><string>{shim}</string><string>serve</string></array>
  <key>StandardOutPath</key><string>{log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>CROSSTALK_PORT</key><string>{port}</string>
    <key>CROSSTALK_HOST</key><string>127.0.0.1</string>
    <key>CROSSTALK_HOME</key><string>{data}</string>
  </dict>
</dict>
</plist>"#,
                shim = shim.display(),
                log = home.join("Library/Logs/Crosstalk/hub.log").display(),
                data = data.display(),
            ),
        )
        .unwrap();
        let tool = t.0.join("bin/launchctl");
        executable(
            &tool,
            &format!(
                "#!/bin/sh\necho \"$*\" >> {calls}\ncase \"$1\" in\n  print)\n    if [ -f {pid} ]; then printf '%s = {{\\n\\tstate = running\\n\\tpid = %s\\n\\tlast exit code = 0\\n}}\\n' \"$2\" \"$(cat {pid})\"\n    else echo 'Bad request.'; echo \"Could not find service \\\"{LABEL}\\\" in domain for user gui: $(id -u)\"; exit 113; fi ;;\nesac\n",
                calls = quoted(&calls),
                pid = quoted(&pid_file),
            ),
        );
        ("CROSSTALK_HUB_APP_LAUNCHCTL", tool, "CROSSTALK_HUB_APP_LABEL", LABEL)
    } else {
        let unit = home.join(format!(".config/systemd/user/{UNIT}.service"));
        fs::create_dir_all(unit.parent().unwrap()).unwrap();
        fs::write(
            &unit,
            format!(
                "[Service]\nType=simple\nExecStart={} serve\nEnvironment=CROSSTALK_PORT={port}\nEnvironment=CROSSTALK_HOST=127.0.0.1\nEnvironment=CROSSTALK_HOME={}\nEnvironment=PATH=/usr/bin:/bin\n",
                shim.display(),
                data.display()
            ),
        )
        .unwrap();
        let tool = t.0.join("bin/systemctl");
        executable(
            &tool,
            &format!(
                "#!/bin/sh\necho \"$*\" >> {calls}\ncase \"$2\" in\n  show)\n    if [ -f {pid} ]; then printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=%s\\nExecMainStatus=0\\n' \"$(cat {pid})\"\n    else printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\nExecMainStatus=0\\n'; fi ;;\nesac\n",
                calls = quoted(&calls),
                pid = quoted(&pid_file),
            ),
        );
        ("CROSSTALK_HUB_APP_SYSTEMCTL", tool, "CROSSTALK_HUB_APP_UNIT", UNIT)
    };

    // The hub as its service would start it, and as hub/scripts/e2e.ts isolates it: nothing of this computer's.
    let hub_log = fs::File::create(t.0.join("hub.log")).unwrap();
    let mut hub = Command::new(&shim)
        .arg("serve")
        .env_clear()
        .envs([
            ("HOME", home.display().to_string()),
            ("PATH", "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("LANG", "en_US.UTF-8".into()),
            ("CROSSTALK_HOME", data.display().to_string()),
            ("CROSSTALK_WORKSPACES", t.0.join("ws").display().to_string()),
            ("CROSSTALK_PORT", port.to_string()),
            ("CROSSTALK_HOST", "127.0.0.1".into()),
            ("CROSSTALK_NO_AGENT_CLIS", "1".into()),
            ("CROSSTALK_PRICES_URL", "http://127.0.0.1:9/prices.json".into()),
            ("CROSSTALK_LOCAL_SERVER_PORTS", String::new()),
            ("CROSSTALK_TAILSCALE_BIN", t.0.join("no-tailscale").display().to_string()),
            ("CROSSTALK_GITHUB_API", "http://127.0.0.1:9".into()),
            ("CROSSTALK_LLAMA_RELEASES", "http://127.0.0.1:9".into()),
            ("CROSSTALK_HF_URL", "http://127.0.0.1:9".into()),
        ])
        .stdin(Stdio::null())
        .stdout(hub_log.try_clone().unwrap())
        .stderr(hub_log)
        .spawn()
        .expect("start the test hub");
    let up = (0..300).any(|_| {
        std::thread::sleep(Duration::from_millis(100));
        hub_core::health::check(port).up()
    });
    if !up {
        stop(&mut hub);
        panic!("the test hub didn't start: {}", fs::read_to_string(t.0.join("hub.log")).unwrap_or_default());
    }
    fs::write(&pid_file, hub.id().to_string()).unwrap();

    let app = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_crosstalk-hub-app"))
            .args(args)
            .env_clear()
            .envs([("HOME", home.display().to_string()), ("PATH", "/usr/bin:/bin:/usr/sbin:/sbin".into()), ("LANG", "en_US.UTF-8".into())])
            .env(tool_env, &tool_path)
            .env(name_env, name)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap_or_else(|e| panic!("{args:?}: {e}: {}", String::from_utf8_lossy(&out.stdout)))
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let s = app(&["status", "--json"]);
        assert_eq!(s["state"], "running", "{s}");
        assert_eq!(s["version"], version.as_str());
        assert_eq!(s["installedVersion"], version.as_str());
        assert_eq!(s["port"], port);
        assert_eq!(s["address"], format!("http://127.0.0.1:{port}"));
        assert_eq!(s["fake"], true);
        assert_eq!(s["actions"]["stop"], true);

        // A code from the app pairs a device with the running hub, once.
        let code = app(&["pair", "--json"]);
        let code = code["code"].as_str().expect("a code").to_string();
        let body = format!(r#"{{"code":"{code}","name":"Hub app test","platform":"Test"}}"#);
        let post = format!("POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let (status, answer) = http(port, &post);
        assert_eq!(status, 200, "{answer}");
        assert!(answer.contains("\"token\""), "{answer}");
        assert_ne!(http(port, &post).0, 200, "a code works once");

        // Gone, and the service no longer has it: stopped.
        stop(&mut hub);
        fs::remove_file(&pid_file).unwrap();
        let s = app(&["status", "--json"]);
        assert_eq!(s["state"], "stopped", "{s}");
        assert_eq!(s["actions"]["start"], true);

        // The app only looked.
        let seen = fs::read_to_string(&calls).unwrap();
        let looks = if cfg!(target_os = "macos") { "print " } else { "--user show " };
        assert!(!seen.is_empty() && seen.lines().all(|l| l.starts_with(looks)), "the stand-in was asked: {seen}");
    }));
    stop(&mut hub);
    if let Err(e) = result {
        eprintln!("test hub's log:\n{}", fs::read_to_string(t.0.join("hub.log")).unwrap_or_default());
        std::panic::resume_unwind(e);
    }
}
