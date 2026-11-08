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
  const dir = mkdtempSync(join(tmpdir(), "ct-rooms-read-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  return { app, done: async () => (await app.engine.shutdown(), app.store.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("a finished reply sends a room event with lastReplyAt", async () => {
  const { app, done } = hub();
  try {
    const room = app.createRoom({ name: "Release notes", mode: "direct" });
    app.addMember(room.id, { provider: "mock", handle: "writer", config: { delayMs: 30, reply: "Here they are." } });
    const rooms: Room[] = [];
    app.bus.on((e: ServerEvent) => e.t === "room" && e.room.id === room.id && rooms.push(e.room));
    const before = Date.now();
    app.engine.postHumanMessage(room.id, "write the release notes", "Mac");
    // Your message moves the chat up every device's list at once (no reply yet).
    expect(rooms).toHaveLength(1);
    expect(rooms[0].updatedAt).toBeGreaterThanOrEqual(before);
    expect(rooms[0].lastReplyAt).toBeUndefined();
    await app.engine.whenIdle();
    // The reply's end: every device hears it, with when it ended.
    const last = rooms.at(-1)!;
    expect(last.lastReplyAt).toBeGreaterThanOrEqual(before);
    expect(last.lastReplyAt).toBeLessThanOrEqual(Date.now());
    expect(last.updatedAt).toBeGreaterThanOrEqual(last.lastReplyAt!);
    expect(app.store.getRoom(room.id)?.lastReplyAt).toBe(last.lastReplyAt);
  } finally {
    await done();
  }
});

test("read never goes backwards and reaches every device", async () => {
  const { app, done } = hub();
  const server = startServer(app);
  const pair = async (name: string) => (await app.auth.pair((await app.auth.createPairingCode()).code, name, "Web"))!;
  const phone = await pair("iPhone");
  const mac = await pair("Mac");
  const base = `http://127.0.0.1:${server.port}`;
  const heard: Record<string, Room[]> = { phone: [], mac: [] };
  const listen = (who: "phone" | "mac", token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?token=${token}&v=2`);
    ws.onmessage = (e) => {
      const ev = JSON.parse(String(e.data)) as ServerEvent;
      if (ev.t === "room") heard[who].push(ev.room);
    };
    return ws;
  };
  const sockets = [listen("phone", phone.token), listen("mac", mac.token)];
  const read = async (roomId: string, at: number) => {
    const res = await fetch(`${base}/api/rooms/${roomId}/read`, { method: "POST", headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" }, body: JSON.stringify({ at }) });
    expect(res.status).toBe(200);
    return (await res.json()) as Room;
  };
  try {
    await eventually(() => sockets.every((s) => s.readyState === WebSocket.OPEN), "the sockets");
    const room = app.createRoom({ name: "Read marks", mode: "direct" });
    const at = Date.now() - 60_000;
    expect((await read(room.id, at)).readAt).toBe(at);
    // Read on the iPhone: the Mac hears it too.
    await eventually(() => heard.mac.some((r) => r.id === room.id && r.readAt === at) && heard.phone.some((r) => r.readAt === at), "both devices");
    // An older time (a device that was behind) doesn't take it back.
    expect((await read(room.id, at - 30_000)).readAt).toBe(at);
    expect(app.store.getRoom(room.id)?.readAt).toBe(at);
    // A later one moves it on; a time in the future counts as now.
    expect((await read(room.id, at + 1000)).readAt).toBe(at + 1000);
    const future = await read(room.id, Date.now() + 3_600_000);
    expect(future.readAt).toBeLessThanOrEqual(Date.now());
    expect((await fetch(`${base}/api/rooms/r_missing/read`, { method: "POST", headers: { authorization: `Bearer ${phone.token}` }, body: "{}" })).status).toBe(404);
  } finally {
    for (const s of sockets) s.close();
    server.stop(true);
    await done();
  }
});

test("rooms that existed before the update start read", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-rooms-migrate-"));
  const path = join(dir, "crosstalk.db");
  try {
    // A database from before: no reply or read times on its rooms.
    const old = new Store(path);
    old.db.exec("ALTER TABLE rooms DROP COLUMN read_at");
    old.db.exec("ALTER TABLE rooms DROP COLUMN last_reply_at");
    old.db.query("INSERT INTO rooms (id, name, cwd, mode, created_at, updated_at) VALUES ('r_old', 'Old chat', '/tmp', 'direct', 1000, 5000)").run();
    old.close();
    const store = new Store(path);
    // Read up to its last activity: it doesn't look unread the day the update arrives.
    expect(store.getRoom("r_old")).toMatchObject({ readAt: 5000 });
    expect(store.getRoom("r_old")?.lastReplyAt).toBeUndefined();
    // Rooms made after it start with nothing read (their first reply is new to you).
    const now = Date.now();
    store.insertRoom({ id: "r_new", name: "New chat", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false });
    expect(store.getRoom("r_new")?.readAt).toBeUndefined();
    store.close();
    // Opening it again changes nothing.
    const again = new Store(path);
    expect(again.getRoom("r_old")?.readAt).toBe(5000);
    expect(again.getRoom("r_new")?.readAt).toBeUndefined();
    again.close();
    expect(new Database(path).query("SELECT COUNT(*) AS n FROM rooms").get()).toEqual({ n: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
