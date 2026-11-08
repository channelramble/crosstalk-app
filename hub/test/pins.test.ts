import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Room, ServerEvent } from "@crosstalk/shared";
import { App } from "../src/app";
import { Store } from "../src/db";
import { startServer } from "../src/server";

async function eventually(check: () => boolean, what: string) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10);
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

function hub() {
  const dir = mkdtempSync(join(tmpdir(), "ct-pins-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  return { app, dir, done: async () => (await app.engine.shutdown(), app.store.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("pins, moves and unpins reach every device, and never move a chat in the recency list", async () => {
  const { app, dir, done } = hub();
  const server = startServer(app);
  const pair = async (name: string) => (await app.auth.pair((await app.auth.createPairingCode()).code, name, "Web"))!;
  const phone = await pair("iPhone");
  const mac = await pair("Mac");
  const base = `http://127.0.0.1:${server.port}`;
  const heard: Record<"phone" | "mac", Room[]> = { phone: [], mac: [] };
  const listen = (who: "phone" | "mac", token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?token=${token}&v=2`);
    ws.onmessage = (e) => {
      const ev = JSON.parse(String(e.data)) as ServerEvent;
      if (ev.t === "room") heard[who].push(ev.room);
    };
    return ws;
  };
  const sockets = [listen("phone", phone.token), listen("mac", mac.token)];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  const pin = (id: string, body: unknown) => call("POST", `/api/rooms/${id}/pin`, body);
  // What each device has heard so far, and whether both heard a change since.
  const mark = () => ({ phone: heard.phone.length, mac: heard.mac.length });
  const both = (since: { phone: number; mac: number }, check: (r: Room) => boolean, what: string) =>
    eventually(() => heard.phone.slice(since.phone).some(check) && heard.mac.slice(since.mac).some(check), what);
  try {
    await eventually(() => sockets.every((s) => s.readyState === WebSocket.OPEN), "the sockets");
    const a = app.chats.create({ provider: "codex", cwd: dir, name: "Release" });
    const b = app.chats.create({ provider: "claude", cwd: dir, name: "Docs" });
    const c = app.chats.create({ provider: "codex", cwd: dir, name: "Site" });
    const was = new Map([a, b, c].map((r) => [r.id, r.updatedAt]));

    // Without a place, a pin goes above those pinned before it on any machine, as the app's do: minus the seconds since
    // 1970 when it was pinned. The next one goes above it, within the same second too.
    let since = mark();
    const first = await pin(a.id, { pinned: true });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: a.id, name: "Release" });
    expect(first.body.pinnedAt).toBeGreaterThan(0);
    const top: number = first.body.pinOrder;
    expect(top).toBe(-first.body.pinnedAt / 1000);
    await both(since, (r) => r.id === a.id && r.pinOrder === top, "the first pin on both devices");
    const second = await pin(b.id, { pinned: true });
    expect(second.body.pinOrder).toBe(Math.min(top - 1, -second.body.pinnedAt / 1000));
    expect(second.body.pinOrder).toBeLessThan(top);
    // With a place (the app's, on its scale for every machine): that one.
    since = mark();
    expect((await pin(c.id, { pinned: true, order: 0.5 })).body.pinOrder).toBe(0.5);
    await both(since, (r) => r.id === c.id && r.pinOrder === 0.5, "the placed pin on both devices");

    // A move: a new place, pinned at the same time as before.
    since = mark();
    const moved = await pin(a.id, { pinned: true, order: -2 });
    expect(moved.body).toMatchObject({ pinOrder: -2, pinnedAt: first.body.pinnedAt });
    await both(since, (r) => r.id === a.id && r.pinOrder === -2 && r.pinnedAt === first.body.pinnedAt, "the move on both devices");
    // Pinned again without a place: it stays where it is.
    expect((await pin(a.id, { pinned: true })).body).toMatchObject({ pinOrder: -2, pinnedAt: first.body.pinnedAt });

    // Every device's state has them, and so does the hub's list; a rename keeps the pin.
    const state = await call("GET", "/api/state");
    expect(state.body.rooms.find((r: Room) => r.id === b.id)).toMatchObject({ pinnedAt: second.body.pinnedAt, pinOrder: second.body.pinOrder });
    expect(state.body.rooms.find((r: Room) => r.id === a.id)).toMatchObject({ pinnedAt: first.body.pinnedAt, pinOrder: -2 });
    expect(app.store.listRooms().find((r) => r.id === c.id)).toMatchObject({ pinOrder: 0.5 });
    const renamed = await call("PATCH", `/api/rooms/${b.id}`, { name: "Docs site" });
    expect(renamed.body).toMatchObject({ name: "Docs site", pinnedAt: second.body.pinnedAt, pinOrder: second.body.pinOrder });
    expect(app.store.getRoom(b.id)).toMatchObject({ name: "Docs site", pinOrder: second.body.pinOrder });

    // Unpinned: both go, on every device.
    since = mark();
    const off = await pin(c.id, { pinned: false });
    expect(off.status).toBe(200);
    expect(off.body.pinnedAt).toBeUndefined();
    expect(off.body.pinOrder).toBeUndefined();
    await both(since, (r) => r.id === c.id && r.pinnedAt === undefined && r.pinOrder === undefined, "the unpin on both devices");
    expect(app.store.getRoom(c.id)?.pinnedAt).toBeUndefined();
    // Unpinned already: still fine, still unpinned.
    expect((await pin(c.id, { pinned: false })).body.pinnedAt).toBeUndefined();
    // Pinned again: a new pin, above the others (b is the top one).
    const again = await pin(c.id, { pinned: true });
    expect(again.body.pinOrder).toBe(Math.min(second.body.pinOrder - 1, -again.body.pinnedAt / 1000));
    expect(again.body.pinOrder).toBeLessThan(second.body.pinOrder);
    expect(again.body.pinnedAt).toBeGreaterThanOrEqual(first.body.pinnedAt);

    // None of it was activity: the chats kept their place in the recency list (the rename moved b, as renames do).
    for (const id of [a.id, c.id]) {
      expect(app.store.getRoom(id)?.updatedAt).toBe(was.get(id)!);
      for (const r of [...heard.phone, ...heard.mac]) if (r.id === id) expect(r.updatedAt).toBe(was.get(id)!);
    }
  } finally {
    for (const s of sockets) s.close();
    server.stop(true);
    await done();
  }
});

test("pins refuse what they can't keep, and a missing chat never reads as an older hub", async () => {
  const { app, dir, done } = hub();
  const server = startServer(app);
  const phone = (await app.auth.pair((await app.auth.createPairingCode()).code, "iPhone", "Web"))!;
  const base = `http://127.0.0.1:${server.port}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const post = async (path: string, body: string): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" }, body });
    return { status: res.status, body: await res.json() };
  };
  try {
    const room = app.chats.create({ provider: "codex", cwd: dir, name: "Release" });
    expect((await post(`/api/rooms/${room.id}/pin`, JSON.stringify({ pinned: true, order: 4 }))).status).toBe(200);
    const bad = [{}, { pinned: "yes" }, { pinned: 1 }, { pinned: true, order: "1" }, { pinned: true, order: 1e13 }, { pinned: false, order: -1e13 }].map((b) => JSON.stringify(b));
    for (const body of [...bad, "not json", "null", "[]", "7"]) {
      const res = await post(`/api/rooms/${room.id}/pin`, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(typeof res.body.error).toBe("string");
    }
    // None of them changed it.
    expect(app.store.getRoom(room.id)).toMatchObject({ pinOrder: 4 });
    // No place (null, as JSON writes a NaN or Infinity): a pinned chat stays where it is.
    expect((await post(`/api/rooms/${room.id}/pin`, JSON.stringify({ pinned: true, order: null }))).body.pinOrder).toBe(4);

    // A chat that's gone says so in words, with a code: never the bare "not found" of a route a hub doesn't have.
    const gone = await post("/api/rooms/r_missing/pin", JSON.stringify({ pinned: true }));
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("no_room");
    expect(gone.body.error).not.toMatch(/^not found$/i);
    // That one is what the app takes for a hub from before pins.
    expect(await post(`/api/rooms/${room.id}/pins`, JSON.stringify({ pinned: true }))).toEqual({ status: 404, body: { error: "not found" } });
  } finally {
    server.stop(true);
    await done();
  }
});

test("rooms from before pins start unpinned, can be pinned, and stay pinned", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-pins-migrate-"));
  const path = join(dir, "crosstalk.db");
  try {
    // A database from before: its rooms have no pin or place.
    const old = new Store(path);
    old.db.exec("ALTER TABLE rooms DROP COLUMN pin_order");
    old.db.exec("ALTER TABLE rooms DROP COLUMN pinned_at");
    old.db.query("INSERT INTO rooms (id, name, cwd, mode, created_at, updated_at) VALUES ('r_old', 'Old chat', '/tmp', 'direct', 1000, 5000)").run();
    old.db.query("INSERT INTO rooms (id, name, cwd, mode, created_at, updated_at) VALUES ('r_other', 'Other chat', '/tmp', 'direct', 1000, 6000)").run();
    old.close();
    const store = new Store(path);
    const cols = (store.db.query("PRAGMA table_info(rooms)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["pinned_at", "pin_order"]));
    // Nothing is pinned the day this arrives.
    for (const r of store.listRooms()) {
      expect(r.pinnedAt).toBeUndefined();
      expect(r.pinOrder).toBeUndefined();
    }
    expect(store.topPinOrder()).toBeNull();
    // Pinning isn't activity: its updatedAt stays.
    expect(store.setPin("r_old", { at: 7000, order: 3 })).toMatchObject({ pinnedAt: 7000, pinOrder: 3, updatedAt: 5000 });
    expect(store.topPinOrder()).toBe(3);
    // The recency list is as it was.
    expect(store.listRooms().map((r) => r.id)).toEqual(["r_other", "r_old"]);
    store.close();
    // Opened again: still pinned, nothing added or lost.
    const again = new Store(path);
    expect(again.getRoom("r_old")).toMatchObject({ pinnedAt: 7000, pinOrder: 3, updatedAt: 5000 });
    expect(again.getRoom("r_other")?.pinnedAt).toBeUndefined();
    expect(again.setPin("r_old", null)?.pinnedAt).toBeUndefined();
    expect(again.topPinOrder()).toBeNull();
    again.close();
    const db = new Database(path);
    expect(db.query("SELECT COUNT(*) AS n FROM rooms").get()).toEqual({ n: 2 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
