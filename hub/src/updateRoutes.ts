// Updates from the app (the contract is in shared/src/protocol.ts): looking for a newer release, downloading it, and
// starting one that's ready. The person's own devices only: a linked machine's hub, and its agents, have no business
// updating or restarting this one.

import type { Device } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";
import { route, type Route } from "./routes";
import { CantUpdate } from "./selfUpdate";
import { isPersonDevice } from "./signin";

function personOnly(device: Device) {
  if (!isPersonDevice(device)) throw new HttpError(403, "Only your own devices can update or restart this machine's Crosstalk. This came from a linked machine.", "person_only");
}

export function updateRoutes(app: App): Route[] {
  return [
    route("GET", "/api/update", ({ device }) => (personOnly(device), app.selfUpdate.status())),
    // "Check now": asks GitHub. A machine that's offline isn't an error: the answer says it couldn't check.
    route("POST", "/api/update/check", async ({ device }) => {
      personOnly(device);
      await app.selfUpdate.check();
      return app.selfUpdate.status();
    }),
    // "Update": starts the download and answers at once; its progress comes with the hub's info (HubInfo.release).
    // Tapped again while one runs, it answers with the one that's running.
    route("POST", "/api/update/install", async ({ device }) => {
      personOnly(device);
      try {
        await app.selfUpdate.install();
      } catch (e) {
        if (e instanceof CantUpdate) throw new HttpError(409, e.message, "cant_update");
        throw e;
      }
      return app.selfUpdate.status();
    }),
    // "Restart now" on an update that's waiting for the chats to go quiet (update.ts).
    route("POST", "/api/update/restart", ({ device }) => {
      personOnly(device);
      if (!app.updater.restartNow(device.name)) throw new HttpError(409, "There's no update waiting on this machine.");
      return { ok: true };
    }),
  ];
}
