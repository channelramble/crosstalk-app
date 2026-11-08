//! One copy at a time. On macOS a second launch from Finder just reopens the first (RunEvent::Reopen); a second start
//! of the binary itself (and any on Linux) tells the first, through a socket only this account can use, to show its
//! window, and exits.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Short enough for a socket path, and one per home folder, so a trial with its own HOME is a copy of its own.
pub fn path(home: &Path) -> PathBuf {
    let dir = ["XDG_RUNTIME_DIR", "TMPDIR"].iter().filter_map(std::env::var_os).map(PathBuf::from).find(|p| p.is_dir()).unwrap_or_else(|| PathBuf::from("/tmp"));
    // SAFETY: getuid can't fail.
    let uid = unsafe { libc::getuid() };
    dir.join(format!("crosstalk-hub-app-{uid}-{:08x}.sock", fnv(home.as_os_str().as_encoded_bytes()) as u32))
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100000001b3))
}

/// True when another copy runs and was asked to show its window.
pub fn ask_running(path: &Path) -> bool {
    match UnixStream::connect(path) {
        Ok(mut s) => s.write_all(b"show\n").is_ok(),
        Err(_) => false,
    }
}

pub fn listen(path: &Path, on_show: impl Fn() + Send + 'static) -> std::io::Result<()> {
    // Left by a copy that didn't quit cleanly: nobody answered on it.
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    std::thread::spawn(move || {
        for mut conn in listener.incoming().flatten() {
            let _ = conn.set_read_timeout(Some(Duration::from_secs(1)));
            let mut buf = [0u8; 16];
            let n = conn.read(&mut buf).unwrap_or(0);
            if buf[..n].starts_with(b"show") {
                on_show();
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_second_copy_asks_the_first_to_show_itself() {
        let dir = std::env::temp_dir().join(format!("ct-single-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("s.sock");
        assert!(!ask_running(&sock));
        let (tx, rx) = mpsc::channel();
        listen(&sock, move || tx.send(()).unwrap()).unwrap();
        assert!(ask_running(&sock));
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
        assert_eq!(std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
        assert_ne!(path(Path::new("/Users/a")), path(Path::new("/Users/b")));
    }
}
