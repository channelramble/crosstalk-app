//! Helpers for tests: temporary folders and made-up samples shaped like the real tools' output.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// A folder of its own under the system's temp folder, removed when dropped.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("ct-hub-app-{name}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp folder");
        TempDir(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Writes a file that can be run.
pub fn executable(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A LaunchAgent plist like deploy/install-macos.sh writes, with these environment variables.
pub fn plist(env: &[(&str, &str)]) -> String {
    let vars: String = env.iter().map(|(k, v)| format!("    <key>{k}</key><string>{v}</string>\n")).collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.crosstalk.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/someone/.local/bin/crosstalk-hub</string>
    <string>serve</string>
  </array>
  <key>StandardOutPath</key><string>/Users/someone/Library/Logs/Crosstalk/hub.log</string>
  <key>EnvironmentVariables</key>
  <dict>
{vars}  </dict>
</dict>
</plist>"#
    )
}

/// Shaped like macOS 27's `launchctl print gui/501/com.crosstalk.hub` for a running hub (values made up).
pub const LAUNCHCTL_RUNNING: &str = r#"gui/501/com.crosstalk.hub = {
	active count = 1
	path = /Users/someone/Library/LaunchAgents/com.crosstalk.hub.plist
	type = LaunchAgent
	state = running

	program = /Users/someone/.local/bin/crosstalk-hub
	arguments = {
		/Users/someone/.local/bin/crosstalk-hub
		serve
	}

	working directory = /Users/someone

	stdout path = /Users/someone/Library/Logs/Crosstalk/hub.log
	stderr path = /Users/someone/Library/Logs/Crosstalk/hub.log
	environment = {
		CROSSTALK_PORT => 7420
		CROSSTALK_HOST => 127.0.0.1
		XPC_SERVICE_NAME => com.crosstalk.hub
	}

	LWCR = {
		"reqs" => {
			"signing-identifier" => "com.crosstalk.hub"
			"team-identifier" => "ABCDE12345"
		}
	}

	domain = gui/501 [100002]
	asid = 100002
	minimum runtime = 5
	exit timeout = 5
	runs = 3
	pid = 52468
	immediate reason = inefficient
	last exit code = 0

	resource coalition = {
		ID = 946
		type = resource
		state = active
		name = com.crosstalk.hub
	}

	spawn type = interactive (4)
	job state = running

	properties = keepalive | runatload | inferred program | managed LWCR | has LWCR
}
"#;
