//! What the window may ask for: fixed actions only. The page hands over no paths, addresses or command lines; the
//! few arguments are a yes or no, or one of a fixed list.

use crate::{lock, login_item, tray, App, Opening};
use hub_core::autostart::LoginState;
use hub_core::install::{self, Chosen, LinuxFix, Plan};
use hub_core::logs::{self, Logs};
use hub_core::pair::{self, PairCode};
use hub_core::service::{self, Fix};
use hub_core::status::{now_ms, Status};
use hub_core::{idle, run, Os};
use serde::Serialize;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub use hub_core::service::Problem;

type Result<T> = std::result::Result<T, Problem>;

fn app_state(app: &AppHandle) -> Arc<App> {
    app.state::<Arc<App>>().inner().clone()
}

/// Runs `f` on a thread of its own: launchctl and systemctl can take seconds, and the window mustn't wait on them.
async fn off_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&App) -> Result<T> + Send + 'static) -> Result<T> {
    let s = app_state(app);
    tauri::async_runtime::spawn_blocking(move || f(&s)).await.map_err(|e| Problem::new(format!("It stopped halfway: {e}"), Some(Fix::Retry)))?
}

#[tauri::command]
pub async fn status(app: AppHandle) -> Result<Status> {
    off_main(&app, |s| Ok(s.status())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    version: String,
    os: Os,
    /// A stand-in service tool: nothing real is changed.
    trial: bool,
    tray: bool,
    service: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Info {
    let s = app_state(&app);
    let tray = *lock(&s.has_tray);
    Info { version: app.package_info().version.to_string(), os: s.hub.place.os, trial: s.hub.place.fake, tray, service: s.hub.place.service_name() }
}

#[tauri::command]
pub fn take_opening(app: AppHandle) -> Opening {
    crate::take_opening(&app)
}

pub fn do_start(s: &App) -> Result<String> {
    let r = service::start(&s.hub.place, &s.hub.setup(), &s.hub.runner);
    s.poke();
    r
}

/// Stop and Restart now end a waiting restart first (`Hub::stop`, `Hub::restart_now`).
pub fn do_stop(s: &App) -> Result<String> {
    let r = s.hub.stop();
    s.poke();
    r
}

pub fn do_restart_now(s: &App) -> Result<String> {
    let r = s.hub.restart_now();
    s.poke();
    r
}

pub fn do_restart_when_quiet(s: &App) -> Result<String> {
    let script = s.idle_script().ok_or_else(|| Problem::new("The restart helper isn't in this copy of the app. Use Restart now instead.", None))?;
    let r = idle::start(&s.hub.place, &s.hub.setup(), &script, &s.hub.place.watcher_log(), &s.hub.runner)
        .map(|_| "It restarts once it has been quiet for five minutes: no replies running and no helpers writing.".to_string())
        .map_err(|e| Problem::new(e, None));
    s.poke();
    r
}

pub fn do_cancel_restart(s: &App) -> Result<String> {
    let n = s.hub.cancel_restart().map_err(Problem::from)?;
    s.poke();
    Ok(if n == 0 { "Nothing was waiting to restart." } else { "The waiting restart is cancelled." }.into())
}

#[tauri::command]
pub async fn start(app: AppHandle) -> Result<String> {
    off_main(&app, do_start).await
}

#[tauri::command]
pub async fn stop(app: AppHandle) -> Result<String> {
    off_main(&app, do_stop).await
}

#[tauri::command]
pub async fn restart_when_quiet(app: AppHandle) -> Result<String> {
    off_main(&app, do_restart_when_quiet).await
}

#[tauri::command]
pub async fn cancel_restart(app: AppHandle) -> Result<String> {
    off_main(&app, do_cancel_restart).await
}

#[tauri::command]
pub async fn restart_now(app: AppHandle) -> Result<String> {
    off_main(&app, do_restart_now).await
}

#[tauri::command]
pub async fn pair(app: AppHandle) -> Result<PairCode> {
    off_main(&app, |s| pair::make(&s.hub.place, &s.hub.setup(), &s.hub.runner, now_ms()).map_err(|e| Problem::new(e, Some(Fix::Retry)))).await
}

#[tauri::command]
pub async fn logs(app: AppHandle) -> Result<Logs> {
    off_main(&app, |s| Ok(logs::read(&s.hub.place, &s.hub.setup(), &s.hub.runner))).await
}

/// Opens with the system's own opener, without waiting for it.
fn open_with(program: &str, args: &[&str]) -> Result<()> {
    let mut child = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| Problem::new(format!("Couldn't open it: {e}"), None))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn opener() -> &'static str {
    if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else {
        "xdg-open"
    }
}

pub fn do_open_crosstalk(s: &App) -> Result<()> {
    let url = s.last().unwrap_or_else(|| s.status()).open_url;
    // Only a web address: the published one comes from the service's settings, not from this page.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(Problem::new(format!("{url} isn't a web address."), None));
    }
    open_with(opener(), &[&url])
}

#[tauri::command]
pub fn open_crosstalk(app: AppHandle) -> Result<()> {
    do_open_crosstalk(&app_state(&app))
}

/// The hub's log file in Console (macOS) or the desktop's viewer; the journal has no file to open.
#[tauri::command]
pub fn open_log_file(app: AppHandle) -> Result<()> {
    let s = app_state(&app);
    match s.hub.setup().log_file.filter(|f| f.exists()) {
        Some(f) if cfg!(target_os = "macos") => open_with("/usr/bin/open", &["-a", "Console", &f.display().to_string()]),
        Some(f) => open_with("xdg-open", &[&f.display().to_string()]),
        None => Err(Problem::new(format!("The hub's log is in the journal: journalctl --user -u {}", s.hub.place.unit), None)),
    }
}

#[tauri::command]
pub fn open_login_items() -> Result<()> {
    login_item::open_settings().map_err(Problem::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    state: LoginState,
    trial: bool,
}

#[tauri::command]
pub async fn login_item(app: AppHandle) -> Result<Login> {
    off_main(&app, |s| Ok(Login { state: s.login.state(), trial: s.hub.place.fake })).await
}

fn set_login(s: &App, on: bool) -> Result<LoginState> {
    s.login.set(on).map_err(|e| Problem::new(format!("Couldn't change Start at login: {e}"), cfg!(target_os = "macos").then_some(Fix::LoginItems)))
}

/// The menu's Start at login: on, off, or (switched off under Login Items) the settings where it's allowed.
pub fn do_toggle_login(s: &App) -> Result<LoginState> {
    match s.login.state() {
        LoginState::NeedsApproval => login_item::open_settings().map(|_| LoginState::NeedsApproval).map_err(Problem::from),
        LoginState::On => set_login(s, false),
        _ => set_login(s, true),
    }
}

#[tauri::command]
pub async fn set_login_item(app: AppHandle, on: bool) -> Result<Login> {
    let handle = app.clone();
    off_main(&app, move |s| {
        let r = set_login(s, on);
        tray::sync_login(&handle, s.login.state());
        r.map(|state| Login { state, trial: s.hub.place.fake })
    })
    .await
}

#[tauri::command]
pub async fn install_plan(app: AppHandle) -> Result<Plan> {
    off_main(&app, |s| {
        let state = s.status().state;
        Ok(install::plan(&s.hub.place, &s.hub.setup(), &s.bundle(), state))
    })
    .await
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum InstallEvent {
    Line {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        ok: bool,
        message: String,
        pairing_code: Option<String>,
        fixes: Vec<LinuxFix>,
    },
}

fn emit_line(app: &AppHandle, text: &str) {
    let _ = app.emit("install", InstallEvent::Line { text: logs::strip_ansi(text) });
}

/// Claims the installer for one run at a time.
fn claim(s: &App) -> Result<()> {
    let mut busy = lock(&s.installing);
    if *busy {
        return Err(Problem::new("It's already installing.", None));
    }
    *busy = true;
    Ok(())
}

/// Runs the bundled installer (after the window has shown what it changes and the person said yes), streaming what it
/// prints as "install" events. The power step runs after it in macOS's own password dialog.
#[tauri::command]
pub async fn install(app: AppHandle, tailscale: bool, power: bool) -> Result<()> {
    let handle = app.clone();
    off_main(&app, move |s| {
        let chosen = Chosen { tailscale, power };
        let cmd = install::command(&s.hub.place, &s.hub.setup(), &s.bundle(), chosen, s.status().state).map_err(Problem::from)?;
        claim(s)?;
        let state = app_state(&handle);
        std::thread::spawn(move || {
            let place = state.hub.place.clone();
            let mut all = String::new();
            let code = run::stream(&cmd, &mut |line| {
                all.push_str(line);
                all.push('\n');
                emit_line(&handle, line);
            });
            let ok = matches!(code, Ok(Some(0)));
            let mut message = match &code {
                Ok(Some(0)) => "Crosstalk is installed and running.".to_string(),
                Ok(Some(n)) => format!("The installer stopped (exit {n}). Its last lines say why."),
                Ok(None) => "The installer was stopped.".into(),
                Err(e) => e.clone(),
            };
            if ok && chosen.power && place.os == Os::Mac && !place.fake {
                emit_line(&handle, "Keeping the Mac awake: macOS asks for your password in its own window…");
                match run::stream(&install::power_command(), &mut |line| emit_line(&handle, line)) {
                    Ok(Some(0)) => emit_line(&handle, "The Mac stays awake now (the display can still sleep), and starts again after a power cut."),
                    _ => message.push_str(" The Mac's sleep settings weren't changed: System Settings → Energy → Prevent automatic sleeping."),
                }
            }
            let fixes = if place.os == Os::Linux { install::linux_fixes(&all) } else { Vec::new() };
            let _ = handle.emit("install", InstallEvent::Done { ok, message, pairing_code: install::pairing_code(&all), fixes });
            *lock(&state.installing) = false;
            state.poke();
        });
        Ok(())
    })
    .await
}

/// Linux: what install.sh couldn't do without a terminal for sudo, through the desktop's password dialog (pkexec).
#[tauri::command]
pub async fn install_fix(app: AppHandle, fix: LinuxFix) -> Result<()> {
    let handle = app.clone();
    off_main(&app, move |s| {
        let cmds = install::linux_fix_commands(fix, &s.hub.place, &s.hub.setup()).map_err(Problem::from)?;
        claim(s)?;
        let state = app_state(&handle);
        std::thread::spawn(move || {
            let mut ok = true;
            for cmd in &cmds {
                emit_line(&handle, &format!("$ {}", cmd.line()));
                if !matches!(run::stream(cmd, &mut |line| emit_line(&handle, line)), Ok(Some(0))) {
                    ok = false;
                    break;
                }
            }
            let message = if ok { "Done." } else { "That didn't work. The lines above say why." }.to_string();
            let _ = handle.emit("install", InstallEvent::Done { ok, message, pairing_code: None, fixes: Vec::new() });
            *lock(&state.installing) = false;
            state.poke();
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn hide_window(window: WebviewWindow) {
    let _ = window.hide();
    let _ = window.emit("hidden", ());
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}
