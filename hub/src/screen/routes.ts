// Settings for the screen and the Screen page (the contract is in shared/src/protocol.ts). The person's own devices
// only: not another machine's hub, whether its sign-in is a peer's or a full one (a linked machine has no business with
// this machine's screen, and neither do its agents).

import type { Device } from "@crosstalk/shared";
import type { App } from "../app";
import { HttpError } from "../engine/engine";
import { route, type Route } from "../routes";
import { isPersonDevice } from "../signin";

function personOnly(device: Device) {
  if (!isPersonDevice(device)) throw new HttpError(403, "Only your own devices can see or set up this machine's screen. This came from a linked machine.", "person_only");
}

export function screenRoutes(app: App): Route[] {
  return [
    route("GET", "/api/screen", ({ device }) => (personOnly(device), app.screen.status())),
    route("POST", "/api/screen/check", ({ device }) => (personOnly(device), app.screen.check())),
    route("PUT", "/api/screen", async ({ device, body }) => (personOnly(device), app.screen.configure(await body()))),
    route("GET", "/api/screen/windows", async ({ device }) => (personOnly(device), { windows: await app.screen.windows() })),
  ];
}
