//! Crosstalk Hub: the hub's menu bar (macOS) or tray (Linux) app, and a small window with the same things. It works
//! through the hub's own background service (launchctl, `systemctl --user`) and never runs the hub itself: macOS gives
//! folder and drive permissions to the program that starts a process, so a hub started here would lose them.
//! See docs/HUB-APP.md.

mod commands;
mod headless;
mod login_item;
mod single;
mod tray;

pub use headless::run as headless;

use hub_core::autostart::{self, AppState, LoginItem};
use hub_core::install::Bundle;
use hub_core::service::Fix;
use hub_core::status::{Hub, State, Status};
use hub_core::{idle, Os, Place, System};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

/// How often the app looks at the hub, and how often for a while after an action.
const EVERY: Duration = Duration::from_secs(5);
const SOON: Duration = Duration::from_secs(1);
const SOON_FOR: Duration = Duration::from_secs(30);

/// What the window shows when it opens: a view, and a notice at its top.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    pub view: Option<String>,
    pub notice: Option<Notice>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// "error" or "info".
    pub tone: &'static str,
    pub message: String,
    pub fix: Option<Fix>,
    /// For a menu action that failed: the window's action (app.js) that tries it again.
    pub retry: Option<&'static str>,
}

struct Timer {
    soon_until: Instant,
    poked: bool,
}

/// Shared by the tray, the window's commands and the watch thread.
pub struct App {
    pub hub: Hub<System>,
    pub login: Box<dyn LoginItem>,
    pub resources: Option<PathBuf>,
    pub data_dir: PathBuf,
    pub has_tray: Mutex<bool>,
    last: Mutex<Option<Status>>,
    opening: Mutex<Opening>,
    timer: Mutex<Timer>,
    wake: Condvar,
    pub installing: Mutex<bool>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl App {
    pub fn status(&self) -> Status {
        let s = self.hub.status();
        *lock(&self.last) = Some(s.clone());
        s
    }

    /// The last status seen, without asking again.
    pub fn last(&self) -> Option<Status> {
        lock(&self.last).clone()
    }

    /// Look again now, and every second for a while: after an action the state changes quickly.
    pub fn poke(&self) {
        let mut t = lock(&self.timer);
        t.soon_until = Instant::now() + SOON_FOR;
        t.poked = true;
        self.wake.notify_all();
    }

    fn wait(&self) {
        let mut t = lock(&self.timer);
        if !t.poked {
            let every = if Instant::now() < t.soon_until { SOON } else { EVERY };
            t = self.wake.wait_timeout(t, every).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
        t.poked = false;
    }

    pub fn resource(&self, rel: &str) -> Option<PathBuf> {
        self.resources.as_ref().map(|r| r.join(rel)).filter(|p| p.exists())
    }

    pub fn bundle(&self) -> Bundle {
        let installer = match self.hub.place.os {
            Os::Mac => "deploy/install-macos.sh",
            Os::Linux => "deploy/install.sh",
        };
        Bundle { installer: self.resource(installer), hub: self.resource("hub/crosstalk-hub") }
    }

    /// The restart watcher to start: the maintained one outside trials when it can serve this hub, else this app's.
    pub fn idle_script(&self) -> Option<PathBuf> {
        idle::script(&self.hub.place, &self.hub.setup(), self.resource("deploy/restart-when-idle.sh").as_deref())
    }

    fn state_file(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }
}

/// Shows the window, on `view` when given, with `notice` at its top.
pub fn show_window(app: &AppHandle, view: Option<&str>, notice: Option<Notice>) {
    if let Some(state) = app.try_state::<Arc<App>>() {
        let mut o = lock(&state.opening);
        if let Some(v) = view {
            o.view = Some(v.to_string());
        }
        if notice.is_some() {
            o.notice = notice;
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // The page takes the opening (or asks for it once it has loaded).
    let _ = app.emit("opening", ());
}

pub fn take_opening(app: &AppHandle) -> Opening {
    app.try_state::<Arc<App>>().map(|s| std::mem::take(&mut *lock(&s.opening))).unwrap_or_default()
}

/// Looks at the hub every few seconds and keeps the tray and the window up to date.
fn watch(app: AppHandle, state: Arc<App>, hidden: bool) {
    let mut first = true;
    let mut shown: Option<tray::View> = None;
    loop {
        let status = state.status();
        let view = tray::View::new(&status, state.login.state());
        if shown.as_ref() != Some(&view) {
            tray::apply(&app, &view);
            shown = Some(view);
        }
        let _ = app.emit("status", &status);
        if first {
            first = false;
            let mut st = AppState::load(&state.state_file());
            let has_tray = *lock(&state.has_tray);
            let needs_install = matches!(status.state, State::NotInstalled | State::NoService);
            // Once on the first run so people see what the icon is; when there's no hub to look after; and always
            // without a tray, where the window is all there is.
            if !has_tray || (!hidden && (!st.window_shown || needs_install)) {
                show_window(&app, needs_install.then_some("install"), None);
                st.window_shown = true;
                let _ = st.save(&state.state_file());
            }
        }
        state.wait();
    }
}

pub fn run(hidden: bool) {
    let place = Place::from_env();
    let sock = single::path(&place.home);
    if single::ask_running(&sock) {
        return;
    }
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::app_info,
            commands::take_opening,
            commands::start,
            commands::stop,
            commands::restart_when_quiet,
            commands::cancel_restart,
            commands::restart_now,
            commands::pair,
            commands::logs,
            commands::open_crosstalk,
            commands::open_log_file,
            commands::open_login_items,
            commands::login_item,
            commands::set_login_item,
            commands::install_plan,
            commands::install,
            commands::install_fix,
            commands::hide_window,
            commands::quit,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| place.home.join(".crosstalk-hub-app"));
            let _ = std::fs::create_dir_all(&data_dir);
            let resources = app.path().resource_dir().ok();
            let mut hub = Hub::new(place.clone(), System);
            hub.watcher_script = resources.as_ref().map(|r| r.join("deploy/restart-when-idle.sh"));
            let state = Arc::new(App {
                login: login_item::for_place(&place, &data_dir),
                hub,
                resources,
                data_dir,
                has_tray: Mutex::new(false),
                last: Mutex::new(None),
                opening: Mutex::new(Opening::default()),
                timer: Mutex::new(Timer { soon_until: Instant::now(), poked: false }),
                wake: Condvar::new(),
                installing: Mutex::new(false),
            });
            app.manage(state.clone());
            let handle = app.handle().clone();
            let shower = handle.clone();
            if let Err(e) = single::listen(&sock, move || show_window(&shower, None, None)) {
                eprintln!("crosstalk-hub-app: no single-instance socket: {e}");
            }
            let has_tray = match tray::build(&handle) {
                Ok(()) => true,
                Err(why) => {
                    eprintln!("crosstalk-hub-app: no tray: {why}");
                    show_window(&handle, None, Some(Notice { tone: "info", message: why, fix: None, retry: None }));
                    false
                }
            };
            *lock(&state.has_tray) = has_tray;
            // The first run from where it's installed adds the app to the login items once (docs/HUB-APP.md).
            let exe = std::env::current_exe().unwrap_or_default();
            let installed = place.fake || login_item::installed(&exe, &place.home);
            if let Err(e) = autostart::first_run(state.login.as_ref(), &state.state_file(), installed) {
                let fix = cfg!(target_os = "macos").then_some(Fix::LoginItems);
                show_window(&handle, None, Some(Notice { tone: "error", message: format!("Couldn't turn on Start at login: {e}"), fix, retry: Some("login-toggle") }));
            }
            std::thread::spawn(move || watch(handle, state, hidden));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let has_tray = app.try_state::<Arc<App>>().is_some_and(|s| *lock(&s.has_tray));
                if has_tray {
                    // Into the tray: the app (and the hub) keep running. The page drops what shouldn't wait there.
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("hidden", ());
                } else {
                    // Without a tray the window is all there is: closing it quits the app (the hub keeps running).
                    app.exit(0);
                }
            }
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("crosstalk-hub-app couldn't start: {e}");
            std::process::exit(1);
        }
    };
    app.run(on_event);
}

#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn on_event(app: &AppHandle, event: RunEvent) {
    match event {
        // Only Quit ends the app: no open window isn't a reason to.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        // Opened again from Finder, Spotlight or Login Items while it runs.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app, None, None),
        _ => {}
    }
}
