import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { Store } from "../src/db";
import { buildSystemNote, rosterHash } from "../src/engine/prompt";
import { ROOM_MODES } from "@crosstalk/shared";

const config = (dir: string) => ({ port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 });

test("only two modes are offered: Build & review and Off", () => {
  expect(ROOM_MODES.map((m) => [m.id, m.label])).toEqual([["review", "Build & review"], ["direct", "Off"]]);
});

test("rooms from before with lead or relay become Off, and old clients sending them get Off; round-robin is a group chat's everyone in turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-modes-"));
  const db = join(dir, "hub.db");
  try {
    const first = new App({ dbPath: db, config: config(dir) });
    const old = first.createRoom({ name: "Old" });
    first.store.updateRoom(old.id, { mode: "relay" as never }); // as an older hub would have saved it
    const turns = first.createRoom({ name: "Turns" });
    first.store.updateRoom(turns.id, { mode: "roundrobin" });
    await first.engine.shutdown();
    first.store.close();
    const app = new App({ dbPath: db, config: config(dir) });
    expect(app.store.getRoom(old.id)!.mode).toBe("direct");
    expect(app.store.getRoom(turns.id)!.mode).toBe("roundrobin");
    expect(app.updateRoom(old.id, { mode: "relay" as never }).mode).toBe("direct");
    expect(app.updateRoom(old.id, { mode: "roundrobin" }).mode).toBe("roundrobin");
    expect(app.createRoom({ name: "Lead", mode: "lead" as never }).mode).toBe("direct");
    expect(() => app.updateRoom(old.id, { mode: "chaos" as never })).toThrow();
    await app.engine.shutdown();
    app.store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Off: unmentioned requests go to the default agent, @mentions go to who's named, agents don't hand off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-off-"));
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  try {
    const room = app.createRoom({ name: "Off", mode: "direct" });
    app.addMember(room.id, { provider: "mock", handle: "first", config: { delayMs: 20, reply: "first here @second over to you" } });
    const second = app.addMember(room.id, { provider: "mock", handle: "second", config: { delayMs: 20, reply: "second here" } });
    app.updateRoom(room.id, { leadMemberId: second.id });
    const agents = () => app.store.listMessages(room.id, { limit: 100 }).filter((m) => m.authorKind === "agent").map((m) => m.authorName);
    app.engine.postHumanMessage(room.id, "please do it", "Phone");
    await app.engine.whenIdle();
    expect(agents()).toEqual(["second"]); // the default agent, not the first one in the list
    app.engine.postHumanMessage(room.id, "@first your turn", "Phone");
    await app.engine.whenIdle();
    expect(agents()).toEqual(["second", "first"]); // first's @second didn't start another turn
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("agents are told who gets messages when Off, and how to coordinate when they can work at the same time", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const room = { id: "r", name: "R", cwd: "/tmp", mode: "direct", leadMemberId: "b", maxHops: 5, rounds: 1, parallel: true, createdAt: now, updatedAt: now, archived: false } as const;
  const m = (id: string, handle: string) => ({ id, roomId: "r", handle, provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 }) as never;
  const note = buildSystemNote(room as never, [m("a", "alpha"), m("b", "beta")], m("a", "alpha"));
  expect(note).toContain("Turn-taking is off: the human's messages go to @beta unless they @mention someone");
  expect(note).toContain("tell the human what you need from them instead of saying you'll ask them");
  expect(note).toContain("post which files you're taking (room_post)");
  expect(note).toContain("Stay off files another agent has claimed");
  const solo = buildSystemNote({ ...room, parallel: false } as never, [m("a", "alpha")], m("a", "alpha"));
  expect(solo).toContain("Only one agent works at a time");
  store.close();
});

test("turning 'work at the same time' on or off re-briefs existing agents (both directions)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-parallel-"));
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  try {
    const room = app.createRoom({ name: "P", mode: "direct" });
    app.addMember(room.id, { provider: "mock", handle: "solo", config: { delayMs: 10 } });
    const members = app.store.listMembers(room.id);
    const solo = rosterHash(app.store.getRoom(room.id)!, members);
    const on = rosterHash(app.updateRoom(room.id, { parallel: true }), members);
    const off = rosterHash(app.updateRoom(room.id, { parallel: false }), members);
    expect(on).not.toBe(solo);
    expect(off).toBe(solo);
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an agent's next turn carries the updated coordination instructions after the toggle changes", async () => {
  const { Engine } = await import("../src/engine/engine");
  const { Bus } = await import("../src/bus");
  const { MockDriver } = await import("../src/agents/mock");
  const store = new Store(":memory:");
  const notes: (string | null)[] = [];
  const engine = new Engine({
    store,
    bus: new Bus(),
    createDriver: (ctx) => {
      const inner = new MockDriver(ctx);
      return { provider: "mock", runTurn: (input, sink) => (notes.push(input.systemNote ?? null), inner.runTurn(input, sink)), interrupt: () => inner.interrupt(), dispose: () => inner.dispose() };
    },
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  store.insertRoom({ id: "r", name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 5, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false });
  store.insertMember({ id: "m", roomId: "r", handle: "solo", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: { delayMs: 10 }, createdAt: now, position: 0 });
  try {
    engine.postHumanMessage("r", "one", "Phone");
    await engine.whenIdle();
    store.updateRoom("r", { parallel: true });
    engine.postHumanMessage("r", "two", "Phone");
    await engine.whenIdle();
    store.updateRoom("r", { parallel: false });
    engine.postHumanMessage("r", "three", "Phone");
    await engine.whenIdle();
    expect(notes[0]).toContain("Only one agent works at a time");
    expect(notes[1]).toContain("Stay off files another agent has claimed");
    expect(notes[2]).toContain("Only one agent works at a time");
  } finally { await engine.shutdown(); store.close(); }
});
