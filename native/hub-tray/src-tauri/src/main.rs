// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `status` and `pair` answer on stdout with no window or tray: for tests, and for agents on this computer.
    match args.first().map(String::as_str) {
        Some("status" | "pair") => std::process::exit(crosstalk_hub_app::headless(&args)),
        _ => crosstalk_hub_app::run(args.iter().any(|a| a == "--hidden")),
    }
}
