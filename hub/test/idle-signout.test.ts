import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDLE_SIGN_OUT_DAYS, idleSignOutAt, idleSignOutDays } from "@crosstalk/shared";
import { App } from "../src/app";

// A person's device that has sent no message for a month is signed out (on unless switched off). Linked machines
// aren't people's devices and stay; a device that says something starts its month again.
const DAY = 86_400_000;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function hub() {
  const dir = mkdtempSync(join(tmpdir(), "crosstalk-idle-"));
  const app = new App({ dbPath: join(dir, "hub.db"), config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(async () => {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return app;
}
async function paired(app: App, name: string, scope: "full" | "peer" = "full") {
  const { code } = await app.auth.createPairingCode(60_000, { scope });
  return (await app.auth.pair(code, name, "Web"))!;
}

test("the days in force: 30 unless saved, 0 for never, within a day and a year", () => {
  expect(IDLE_SIGN_OUT_DAYS).toBe(30);
  expect(idleSignOutDays(undefined)).toBe(30);
  expect(idleSignOutDays({})).toBe(30);
  expect(idleSignOutDays({ idleSignOutDays: 0 })).toBe(0);
  expect(idleSignOutDays({ idleSignOutDays: -4 })).toBe(0);
  expect(idleSignOutDays({ idleSignOutDays: 7.4 })).toBe(7);
  expect(idleSignOutDays({ idleSignOutDays: 9999 })).toBe(365);
  expect(idleSignOutDays({ idleSignOutDays: Number.NaN })).toBe(30);
  expect(idleSignOutAt({ createdAt: 1000, lastMessageAt: 5000, scope: "full" }, 30)).toBe(5000 + 30 * DAY);
  expect(idleSignOutAt({ createdAt: 1000, lastMessageAt: null, scope: "full" }, 30)).toBe(1000 + 30 * DAY);
  expect(idleSignOutAt({ createdAt: 1000, lastMessageAt: 5000, scope: "peer" }, 30)).toBeNull();
  expect(idleSignOutAt({ createdAt: 1000, lastMessageAt: 5000, scope: "full" }, 0)).toBeNull();
});

test("a device that sent no message for 30 days is signed out; one that did, and a linked machine, stay", async () => {
  const app = hub();
  const quiet = await paired(app, "Old tablet");
  const used = await paired(app, "Phone");
  const machine = await paired(app, "Linux box", "peer");
  // A machine linked with a full sign-in (it shows this one's chats), paired with a code made for a machine, and one
  // whose sign-in was tied to its machine afterwards.
  const full = (await app.auth.pair((await app.auth.createPairingCode(60_000, { kind: "hub" })).code, "Studio", "Web"))!;
  const tied = await paired(app, "Workshop");
  app.store.setDeviceHub(tied.device.id, "hub-workshop");
  const now = Date.now();
  // Nothing is signed out before its time.
  expect(app.signOutIdleDevices(now + 29 * DAY)).toBe(0);
  // The phone says something on day 20: its month starts again.
  app.store.deviceSpoke(used.device.id, now + 20 * DAY);
  expect(app.signOutIdleDevices(now + 31 * DAY)).toBe(1);
  expect(await app.auth.verify(quiet.token)).toBeNull();
  expect(await app.auth.endedWhy(quiet.token)).toBe("idle");
  expect((await app.auth.verify(used.token))?.name).toBe("Phone");
  expect((await app.auth.verify(machine.token))?.name).toBe("Linux box");
  expect(app.store.listDevices().map((d) => d.name).sort()).toEqual(["Linux box", "Phone", "Studio", "Workshop"]);
  // Signed out by hand, a device is told nothing of the kind.
  app.auth.revoke(used.device.id);
  expect(await app.auth.endedWhy(used.token)).toBeNull();
  // The linked machine never goes this way, however long it says nothing.
  expect(app.signOutIdleDevices(now + 400 * DAY)).toBe(0);
  expect((await app.auth.verify(machine.token))?.name).toBe("Linux box");
  expect((await app.auth.verify(full.token))?.name).toBe("Studio");
  expect((await app.auth.verify(tied.token))?.name).toBe("Workshop");
  // And the app says of none of them that it's about to be signed out.
  for (const d of app.store.listDevices()) expect(idleSignOutAt(d, 30), d.name).toBeNull();
});

test("switched off, nobody is signed out; the setting is kept and bounded", async () => {
  const app = hub();
  const d = await paired(app, "Phone");
  expect(idleSignOutDays(app.hubSettings())).toBe(30);
  expect(app.setHubSettings({ idleSignOutDays: 0 }).idleSignOutDays).toBe(0);
  expect(app.signOutIdleDevices(Date.now() + 500 * DAY)).toBe(0);
  expect((await app.auth.verify(d.token))?.name).toBe("Phone");
  // The usual 30 is saved as nothing, and reads as 30.
  expect(app.setHubSettings({ idleSignOutDays: 30 }).idleSignOutDays).toBeUndefined();
  expect(idleSignOutDays(app.hubSettings())).toBe(30);
  expect(app.setHubSettings({ idleSignOutDays: 100000 }).idleSignOutDays).toBe(365);
  expect(app.signOutIdleDevices(Date.now() + 500 * DAY)).toBe(1);
});

test("through the server: a message or an answered request counts, and a signed-out device is told why", async () => {
  const app = hub();
  const { startServer } = await import("../src/server");
  const srv = startServer(app);
  cleanups.push(() => srv.stop(true));
  const base = `http://127.0.0.1:${srv.port}`;
  const d = await paired(app, "Phone");
  const headers = { authorization: `Bearer ${d.token}`, "content-type": "application/json" };
  const devices = (await (await fetch(`${base}/api/devices`, { headers })).json()) as { id: string; lastMessageAt: number }[];
  expect(typeof devices[0].lastMessageAt).toBe("number");
  // Long ago it last said something.
  app.store.deviceSpoke(d.device.id, Date.now() - 29 * DAY);
  // A chat with nobody in it: the message is taken, and no agent runs.
  const room = app.createRoom({ name: "R", mode: "direct" });
  const sent = await fetch(`${base}/api/rooms/${room.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "hello" }) });
  expect(sent.status).toBe(200);
  expect(app.store.getDevice(d.device.id)!.lastMessageAt!).toBeGreaterThan(Date.now() - 60_000);
  await app.engine.whenIdle();
  // A month of nothing: signed out, and its next request says why, in words and with a code the app knows.
  expect(app.signOutIdleDevices(Date.now() + 31 * DAY)).toBe(1);
  const refused = await fetch(`${base}/api/devices`, { headers });
  expect(refused.status).toBe(401);
  const body = (await refused.json()) as { error: string; code?: string };
  expect(body.code).toBe("signed_out_idle");
  expect(body.error).toBe("This device was signed out because it sent no message for 30 days. Pair it again with a new code.");
  // A stranger's token learns nothing.
  const stranger = await fetch(`${base}/api/devices`, { headers: { authorization: "Bearer not-a-token" } });
  expect(await stranger.json()).toEqual({ error: "unauthorized" });
});
