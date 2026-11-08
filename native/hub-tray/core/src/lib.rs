//! What the Crosstalk Hub app knows about the hub, without any UI: where it's installed, its background service
//! (launchd or systemd), its health, pairing codes, logs, the restart-when-quiet watcher, installing it, and starting
//! the app at login. Everything that changes the service goes through `paths::Place::may_change_service`.

pub mod autostart;
pub mod health;
pub mod idle;
pub mod install;
pub mod launchd;
pub mod logs;
pub mod pair;
pub mod paths;
pub mod procs;
pub mod run;
pub mod service;
pub mod status;
pub mod systemd;
#[cfg(test)]
mod testing;

pub use paths::{Os, Place, Setup};
pub use run::{Runner, System};
pub use status::{Hub, Status};

#[cfg(test)]
mod tests {
    use crate::paths::{discover, Os, Place};
    use crate::run::{Fake, Output};
    use crate::testing::{executable, plist, TempDir, LAUNCHCTL_RUNNING};
    use crate::{install, pair, service, status};

    /// The hub runs only under launchd or systemd: nothing the app runs may start one itself.
    #[test]
    fn nothing_the_app_runs_starts_a_hub_itself() {
        for os in [Os::Mac, Os::Linux] {
            let home = TempDir::new("never-serve");
            let place = Place::for_test(os, home.path());
            std::fs::create_dir_all(place.service_file().parent().unwrap()).unwrap();
            let bin = home.path().join("crosstalk-hub");
            executable(&bin, "#!/bin/sh\n");
            let def = match os {
                Os::Mac => plist(&[("CROSSTALK_PORT", "7421")]).replace("/Users/someone/.local/bin/crosstalk-hub", bin.to_str().unwrap()),
                Os::Linux => format!("[Service]\nExecStart={} serve\n", bin.display()),
            };
            std::fs::write(place.service_file(), def).unwrap();
            let setup = discover(&place);
            let mut commands = Vec::new();
            for answer in [Output::exited(0, LAUNCHCTL_RUNNING), Output::exited(113, ""), Output::exited(0, "LoadState=loaded\nActiveState=inactive\nSubState=dead\n")] {
                let fake = Fake::new();
                fake.answer("launchctl print", answer.clone());
                fake.answer("systemctl --user show", answer);
                fake.answer("crosstalk-hub pair", Output::exited(0, "Pairing code: AB23-9XYZ  (valid until 16:32)\n"));
                let _ = service::start(&place, &setup, &fake);
                let _ = service::stop(&place, &fake);
                let _ = service::restart_now(&place, &setup, &fake);
                let _ = pair::make(&place, &setup, &fake, 0);
                let _ = status::Versions::default().get(&place, &setup, &fake);
                commands.extend(fake.commands());
            }
            let b = install::Bundle { installer: Some(bin.clone()), hub: Some(bin.clone()) };
            commands.push(install::command(&place, &setup, &b, install::Chosen { tailscale: true, power: true }, status::State::NotInstalled).unwrap());
            commands.push(install::power_command());
            assert!(commands.len() > 10);
            for c in &commands {
                assert!(!c.args.iter().any(|a| a == "serve"), "{}", c.line());
                assert!(c.program != bin || c.args.first().is_some_and(|a| a == "pair" || a == "version"), "{}", c.line());
            }
        }
    }
}
