//! Crosstalk native shell: the bundled web UI plus native notifications and link handling.
//! All chat traffic goes from the UI straight to your hub over HTTPS/WebSocket.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running Crosstalk");
}
