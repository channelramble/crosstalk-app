//! Pair a phone: a one-time code from `crosstalk-hub pair`, the link the web app reads (`<public url>/#pair=<code>`,
//! as in DevicesPage.tsx) and its QR code. The CLI works whether or not the hub is running.

use crate::paths::{Place, Setup};
use crate::run::{Cmd, Runner};
use serde::Serialize;
use std::time::Duration;

pub const MINUTES: u32 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    pub code: String,
    /// Milliseconds since 1970. Worked out here: the CLI prints the time in the Mac's own format.
    pub expires_at: u64,
    /// Where phones open the hub; None when it isn't published (no Tailscale).
    pub base: Option<String>,
    pub link: Option<String>,
    pub qr_svg: Option<String>,
}

/// The hub's CLI with only what it needs from the service's environment: the same data folder, nothing else
/// (whatever it opens counts as this app's doing on macOS).
pub fn env(place: &Place, setup: &Setup) -> Vec<(String, String)> {
    let get = |k: &str, default: &str| setup.env.get(k).filter(|v| !v.trim().is_empty()).cloned().unwrap_or_else(|| default.to_string());
    let mut env = vec![
        ("HOME".to_string(), place.home.display().to_string()),
        ("PATH".to_string(), get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")),
        ("LANG".to_string(), get("LANG", "en_US.UTF-8")),
    ];
    if let Some(h) = setup.env.get("CROSSTALK_HOME").filter(|h| !h.trim().is_empty()) {
        env.push(("CROSSTALK_HOME".into(), h.clone()));
    }
    env
}

pub fn command(place: &Place, setup: &Setup) -> Cmd {
    Cmd::new(&setup.bin, ["pair".to_string(), MINUTES.to_string()]).env(env(place, setup)).timeout(Duration::from_secs(20))
}

/// `crosstalk-hub version`, for the version installed (as opposed to running).
pub fn version_command(place: &Place, setup: &Setup) -> Cmd {
    Cmd::new(&setup.bin, ["version"]).env(env(place, setup)).timeout(Duration::from_secs(10))
}

/// The code in "Pairing code: XXXX-XXXX  (valid until …)".
pub fn parse_code(out: &str) -> Option<String> {
    out.lines().find_map(|l| l.trim().strip_prefix("Pairing code:")).and_then(|rest| rest.split_whitespace().next()).filter(|c| is_code(c)).map(str::to_string)
}

fn is_code(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() == 9 && b[4] == b'-' && b.iter().enumerate().all(|(i, ch)| i == 4 || ch.is_ascii_uppercase() || ch.is_ascii_digit())
}

pub fn link(base: &str, code: &str) -> String {
    format!("{}/#pair={code}", base.trim_end_matches('/'))
}

/// A QR code as an SVG drawing, dark on white with the quiet zone scanners need.
pub fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).ok()?;
    Some(code.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).dark_color(qrcode::render::svg::Color("#000000")).light_color(qrcode::render::svg::Color("#ffffff")).build())
}

pub fn make(place: &Place, setup: &Setup, runner: &dyn Runner, now_ms: u64) -> Result<PairCode, String> {
    if !setup.bin_exists {
        return Err(format!("The hub isn't installed at {}.", setup.bin.display()));
    }
    let out = runner.run(&command(place, setup))?;
    let code = parse_code(&out.stdout).ok_or_else(|| {
        let said = out.said();
        format!("The hub didn't give a code{}", if said.is_empty() { ".".to_string() } else { format!(": {}", said.lines().last().unwrap_or("")) })
    })?;
    let base = setup.public_url.clone();
    let link = base.as_deref().map(|b| link(b, &code));
    let qr_svg = link.as_deref().and_then(qr_svg);
    Ok(PairCode { code, expires_at: now_ms + u64::from(MINUTES) * 60_000, base, link, qr_svg })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{discover, Os};
    use crate::run::{Fake, Output};
    use crate::testing::TempDir;

    #[test]
    fn the_code_from_the_cli_line() {
        assert_eq!(parse_code("Pairing code: H24X-C77J  (valid until 4:32:10 PM)\n"), Some("H24X-C77J".into()));
        assert_eq!(parse_code("    Pairing code: AB23-9XYZ  (valid until 16:32:10)"), Some("AB23-9XYZ".into()));
        assert_eq!(parse_code("Pairing code: lower-case"), None);
        assert_eq!(parse_code("error: database is locked"), None);
    }

    #[test]
    fn the_link_is_the_web_app_s() {
        assert_eq!(link("https://mini.example.ts.net/", "H24X-C77J"), "https://mini.example.ts.net/#pair=H24X-C77J");
        let svg = qr_svg(&link("https://mini.example.ts.net", "H24X-C77J")).unwrap();
        assert!(svg.starts_with("<?xml") && svg.contains("<svg") && svg.contains("#000000"));
    }

    #[test]
    fn it_runs_the_cli_with_the_service_s_data_folder_only() {
        let home = TempDir::new("pair");
        let place = Place::for_test(Os::Mac, home.path());
        std::fs::create_dir_all(place.service_file().parent().unwrap()).unwrap();
        let bin = home.path().join("crosstalk-hub");
        crate::testing::executable(&bin, "#!/bin/sh\n");
        let plist = crate::testing::plist(&[("CROSSTALK_HOME", "/data/ct"), ("CROSSTALK_PUBLIC_URL", "https://mini.example.ts.net"), ("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")])
            .replace("/Users/someone/.local/bin/crosstalk-hub", bin.to_str().unwrap());
        std::fs::write(place.service_file(), plist).unwrap();
        let setup = discover(&place);
        let fake = Fake::new();
        fake.answer("crosstalk-hub pair", Output::exited(0, "Pairing code: H24X-C77J  (valid until 4:32:10 PM)\n"));
        let code = make(&place, &setup, &fake, 1_000).unwrap();
        assert_eq!(code.code, "H24X-C77J");
        assert_eq!(code.expires_at, 1_000 + 30 * 60_000);
        assert_eq!(code.link.as_deref(), Some("https://mini.example.ts.net/#pair=H24X-C77J"));
        assert!(code.qr_svg.is_some());
        let cmd = &fake.commands()[0];
        assert_eq!(cmd.args, ["pair", "30"]);
        let env = cmd.env.clone().unwrap();
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["HOME", "PATH", "LANG", "CROSSTALK_HOME"]);
        assert!(env.contains(&("CROSSTALK_HOME".into(), "/data/ct".into())));
    }

    #[test]
    fn no_public_address_means_a_code_without_a_link() {
        let home = TempDir::new("pair-local");
        let place = Place::for_test(Os::Mac, home.path());
        let mut setup = discover(&place);
        setup.bin_exists = true;
        let fake = Fake::new();
        fake.answer("crosstalk-hub pair", Output::exited(0, "Pairing code: H24X-C77J  (valid until 4:32:10 PM)\n"));
        let code = make(&place, &setup, &fake, 0).unwrap();
        assert_eq!((code.link, code.qr_svg), (None, None));
        let fake = Fake::new();
        fake.answer("crosstalk-hub pair", Output { code: Some(1), stdout: String::new(), stderr: "SQLiteError: database is locked".into() });
        assert_eq!(make(&place, &setup, &fake, 0).unwrap_err(), "The hub didn't give a code: SQLiteError: database is locked");
    }
}
