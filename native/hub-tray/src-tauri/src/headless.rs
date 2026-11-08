//! `crosstalk-hub-app status [--json]` and `pair [--json]`: the app's own answers without its window or tray, for the
//! tests and for agents running on this computer. Neither changes the service.

use hub_core::pair;
use hub_core::status::{now_ms, Hub};
use hub_core::{Place, System};

pub fn run(args: &[String]) -> i32 {
    let json = args.iter().any(|a| a == "--json");
    let hub = Hub::new(Place::from_env(), System);
    match args.first().map(String::as_str) {
        Some("status") => {
            let s = hub.status();
            if json {
                println!("{}", serde_json::to_string_pretty(&s).unwrap_or_default());
            } else {
                println!("{}: {}", s.title, s.detail);
                if let Some(v) = &s.version {
                    println!("Version {v}");
                }
                println!("Address {}", s.open_url);
            }
            0
        }
        Some("pair") => match pair::make(&hub.place, &hub.setup(), &hub.runner, now_ms()) {
            Ok(code) => {
                if json {
                    println!("{}", serde_json::to_string_pretty(&code).unwrap_or_default());
                } else {
                    println!("Pairing code: {}  (works once, for {} minutes)", code.code, pair::MINUTES);
                    match &code.link {
                        Some(link) => println!("Link: {link}"),
                        None => println!("This hub isn't published with Tailscale, so phones can't reach it yet."),
                    }
                }
                0
            }
            Err(e) => {
                if json {
                    println!("{}", serde_json::json!({ "error": e }));
                } else {
                    eprintln!("{e}");
                }
                1
            }
        },
        _ => 2,
    }
}
