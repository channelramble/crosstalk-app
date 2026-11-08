//! The menu bar (macOS) or tray (Linux) icon and its menu. Its icon shows how the hub is; its first line says it in
//! words (Linux trays have no tooltip). Stop and Restart now open the window, which asks twice.

use crate::commands::{self, Problem};
use crate::{lock, show_window, App, Notice};
use hub_core::autostart::LoginState;
use hub_core::status::{Actions, State, Status, Tone};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

const TRAY: &str = "hub";

/// Everything the menu shows; it's changed only when this does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub tone: Tone,
    /// Two menus: one for a hub to look after, one to install it.
    pub installed: bool,
    pub status_line: String,
    pub detail_line: String,
    pub tooltip: String,
    pub actions: Actions,
    pub restart_waiting: bool,
    pub install_text: &'static str,
    pub login: LoginState,
}

fn short(url: &str) -> &str {
    url.trim_start_matches("https://").trim_start_matches("http://")
}

impl View {
    pub fn new(s: &Status, login: LoginState) -> View {
        let installed = !matches!(s.state, State::NotInstalled | State::NoService);
        let waiting = if s.restart.is_some() { " · restart waiting" } else { "" };
        let place = short(s.public_url.as_deref().unwrap_or(&s.address)).to_string();
        let detail_line = match &s.version {
            Some(v) => format!("Version {v} · {place}"),
            None if installed => place,
            None => "Nothing is set up on this computer yet".into(),
        };
        View {
            tone: s.tone,
            installed,
            status_line: format!("Crosstalk: {}{waiting}", s.title),
            detail_line,
            tooltip: format!("Crosstalk Hub: {}", s.title),
            actions: s.actions.clone(),
            restart_waiting: s.restart.is_some(),
            install_text: if s.state == State::NoService { "Set up the background service…" } else { "Install Crosstalk…" },
            login,
        }
    }
}

fn icon(tone: Tone) -> Image<'static> {
    #[cfg(target_os = "macos")]
    let img = match tone {
        Tone::Ok => tauri::include_image!("icons/tray/mac-on.png"),
        Tone::Busy => tauri::include_image!("icons/tray/mac-busy.png"),
        Tone::Off => tauri::include_image!("icons/tray/mac-off.png"),
        Tone::Problem => tauri::include_image!("icons/tray/mac-problem.png"),
    };
    #[cfg(not(target_os = "macos"))]
    let img = match tone {
        Tone::Ok => tauri::include_image!("icons/tray/linux-on.png"),
        Tone::Busy => tauri::include_image!("icons/tray/linux-busy.png"),
        Tone::Off => tauri::include_image!("icons/tray/linux-off.png"),
        Tone::Problem => tauri::include_image!("icons/tray/linux-problem.png"),
    };
    img
}

struct Built {
    installed: bool,
    menu: Menu<Wry>,
    status: MenuItem<Wry>,
    detail: Option<MenuItem<Wry>>,
    items: Vec<(&'static str, MenuItem<Wry>)>,
    login: CheckMenuItem<Wry>,
}

struct Menus(Mutex<Option<Built>>);

fn build_menu(app: &AppHandle, installed: bool) -> tauri::Result<Built> {
    let item = |id: &'static str, text: &str, enabled: bool| MenuItem::with_id(app, id, text, enabled, None::<&str>);
    let sep = || PredefinedMenuItem::separator(app);
    let status = item("status", "Crosstalk: checking…", false)?;
    let login = CheckMenuItem::with_id(app, "login", "Start at login", true, false, None::<&str>)?;
    let window = item("window", "Show window", true)?;
    let quit = item("quit", "Quit (Crosstalk keeps running)", true)?;
    if !installed {
        let install = item("install", "Install Crosstalk…", true)?;
        let menu = Menu::with_items(app, &[&status, &sep()?, &install, &window, &login, &sep()?, &quit])?;
        return Ok(Built { installed, menu, status, detail: None, items: vec![("install", install)], login });
    }
    let detail = item("detail", "", false)?;
    let items = vec![
        ("open", item("open", "Open Crosstalk", false)?),
        ("pair", item("pair", "Pair a phone…", false)?),
        ("start", item("start", "Start", false)?),
        ("stop", item("stop", "Stop…", false)?),
        ("restart", item("restart", "Restart when it's quiet", false)?),
        ("restart-now", item("restart-now", "Restart now…", false)?),
        ("logs", item("logs", "Show logs", true)?),
    ];
    let get = |id: &str| &items.iter().find(|(i, _)| *i == id).expect("menu item").1;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &detail,
            &sep()?,
            get("open"),
            get("pair"),
            &sep()?,
            get("start"),
            get("stop"),
            get("restart"),
            get("restart-now"),
            &sep()?,
            get("logs"),
            &window,
            &login,
            &sep()?,
            &quit,
        ],
    )?;
    Ok(Built { installed, menu, status, detail: Some(detail), items, login })
}

/// Why there's no tray here, if there isn't one. On Linux the tray needs an AppIndicator library, which
/// libappindicator-sys loads by name and panics without (and a release build aborts on a panic).
fn unavailable() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let found = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"].iter().any(|name| {
            let name = std::ffi::CString::new(*name).unwrap_or_default();
            // SAFETY: only maps the library the tray would load anyway, and closes it again.
            unsafe {
                let h = libc::dlopen(name.as_ptr(), libc::RTLD_LAZY);
                if !h.is_null() {
                    libc::dlclose(h);
                }
                !h.is_null()
            }
        });
        if !found {
            return Some("There's no tray icon: this computer lacks the AppIndicator library (on Debian or Ubuntu: sudo apt install libayatana-appindicator3-1). This window does the same things.".into());
        }
    }
    None
}

pub fn build(app: &AppHandle) -> Result<(), String> {
    if let Some(why) = unavailable() {
        return Err(why);
    }
    let built = build_menu(app, true).map_err(|e| e.to_string())?;
    TrayIconBuilder::with_id(TRAY)
        .icon(icon(Tone::Off))
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Crosstalk Hub")
        .menu(&built.menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .build(app)
        .map_err(|e| e.to_string())?;
    app.manage(Menus(Mutex::new(Some(built))));
    Ok(())
}

pub fn apply(app: &AppHandle, view: &View) {
    let (Some(tray), Some(menus)) = (app.tray_by_id(TRAY), app.try_state::<Menus>()) else { return };
    let mut built = lock(&menus.0);
    if built.as_ref().map(|b| b.installed) != Some(view.installed) {
        match build_menu(app, view.installed) {
            Ok(b) => {
                let _ = tray.set_menu(Some(b.menu.clone()));
                *built = Some(b);
            }
            Err(_) => return,
        }
    }
    let Some(b) = built.as_ref() else { return };
    let _ = b.status.set_text(&view.status_line);
    if let Some(d) = &b.detail {
        let _ = d.set_text(&view.detail_line);
    }
    let a = &view.actions;
    for (id, item) in &b.items {
        let enabled = match *id {
            "open" => a.open,
            "pair" => a.pair,
            "start" => a.start,
            "stop" => a.stop,
            "restart" => a.restart || a.cancel_restart,
            "restart-now" => a.restart_now,
            _ => true,
        };
        let _ = item.set_enabled(enabled);
        match *id {
            "restart" => {
                let _ = item.set_text(if view.restart_waiting { "Cancel the waiting restart" } else { "Restart when it's quiet" });
            }
            "install" => {
                let _ = item.set_text(view.install_text);
            }
            _ => {}
        }
    }
    set_login(b, view.login);
    let _ = tray.set_icon_with_as_template(Some(icon(view.tone)), cfg!(target_os = "macos"));
    let _ = tray.set_tooltip(Some(&view.tooltip));
}

fn set_login(b: &Built, login: LoginState) {
    let _ = b.login.set_checked(matches!(login, LoginState::On | LoginState::NeedsApproval));
    let _ = b.login.set_enabled(login != LoginState::Unavailable);
    let _ = b.login.set_text(if login == LoginState::NeedsApproval { "Start at login (allow it in Login Items)" } else { "Start at login" });
}

/// The menu toggles its own check mark when clicked: put back what's true.
pub fn sync_login(app: &AppHandle, login: LoginState) {
    if let Some(menus) = app.try_state::<Menus>() {
        if let Some(b) = lock(&menus.0).as_ref() {
            set_login(b, login);
        }
    }
}

/// A menu action's error, with the window's action that tries it again (and the fix's own button, if any).
fn notice(p: Problem, retry: &'static str) -> Notice {
    Notice { tone: "error", message: p.message, fix: p.fix, retry: Some(retry) }
}

/// Runs `f` off the menu's thread; a failure opens the window to say so, with a way out: `retry` is the window's own
/// action for it (app.js `actions`).
fn background(app: AppHandle, state: Arc<App>, retry: &'static str, f: impl FnOnce(&App) -> Result<String, Problem> + Send + 'static) {
    std::thread::spawn(move || {
        if let Err(p) = f(&state) {
            show_window(&app, None, Some(notice(p, retry)));
        }
        state.poke();
    });
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<Arc<App>>().map(|s| s.inner().clone()) else { return };
    let app = app.clone();
    match id {
        "open" => background(app, state, "open", |s| commands::do_open_crosstalk(s).map(|_| String::new())),
        "pair" | "logs" | "install" | "stop" | "restart-now" => show_window(&app, Some(id), None),
        "window" => show_window(&app, Some("home"), None),
        "start" => background(app, state, "start", commands::do_start),
        "restart" if state.last().is_some_and(|st| st.restart.is_some()) => background(app, state, "cancel-restart", commands::do_cancel_restart),
        "restart" => background(app, state, "restart-quiet", commands::do_restart_when_quiet),
        "login" => {
            let handle = app.clone();
            background(app, state, "login-toggle", move |s| {
                let r = commands::do_toggle_login(s);
                sync_login(&handle, s.login.state());
                r.map(|_| String::new())
            })
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hub_core::status::{decide, Inputs};
    use hub_core::health::Health;
    use hub_core::service::{Phase, ServiceState};
    use hub_core::{Os, Place};

    fn status(phase: Phase, health: Health, defined: bool) -> Status {
        let dir = std::env::temp_dir().join(format!("ct-tray-{}", std::process::id()));
        let place = Place::for_test(Os::Mac, &dir);
        let mut setup = hub_core::paths::discover(&place);
        setup.service_defined = defined;
        setup.bin_exists = defined;
        setup.public_url = Some("https://mini.example.ts.net".into());
        let service = ServiceState { phase, loaded: defined, pid: None, last_exit: None, signal: None, problem: None };
        decide(Inputs { place: &place, setup: &setup, service: &service, health: &health, installed_version: None, watcher: None, age: None, waiting_for: None, now_ms: 0 })
    }

    #[test]
    fn the_menu_says_how_it_is() {
        let v = View::new(&status(Phase::Running, Health::Up { version: "0.4.1".into() }, true), LoginState::On);
        assert_eq!(v.status_line, "Crosstalk: Running");
        assert_eq!(v.detail_line, "Version 0.4.1 · mini.example.ts.net");
        assert!(v.installed && v.actions.stop);
        let v = View::new(&status(Phase::Stopped, Health::Down { reason: "x".into() }, true), LoginState::Off);
        assert_eq!((v.status_line.as_str(), v.detail_line.as_str(), v.tone), ("Crosstalk: Stopped", "mini.example.ts.net", Tone::Off));
        let v = View::new(&status(Phase::Stopped, Health::Down { reason: "x".into() }, false), LoginState::Off);
        assert!(!v.installed);
        assert_eq!(v.status_line, "Crosstalk: Not installed");
    }
}
