import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@crosstalk/shared";
import { App } from "../src/app";

test("room activity counts each kind of agent's finished turns (most work first) and is pushed after each turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-activity-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const events: ServerEvent[] = [];
  app.bus.on((e) => events.push(e));
  await app.start();
  try {
    const room = app.createRoom({ name: "R", mode: "direct" });
    const quiet = app.createRoom({ name: "Quiet", mode: "direct" });
    app.addMember(room.id, { provider: "mock", handle: "busy", config: { delayMs: 5 } });
    app.addMember(room.id, { provider: "mock", handle: "rare", config: { delayMs: 5 } });
    for (const text of ["@busy one", "@busy two", "@rare three"]) {
      app.engine.postHumanMessage(room.id, text, "Phone");
      await app.engine.whenIdle();
    }
    await Bun.sleep(20);
    const activity = app.store.roomActivity();
    // Both test agents are the same kind ("mock"), so they add up to one entry with all three turns.
    expect(activity[room.id]).toEqual([{ provider: "mock", turns: 3, outputTokens: expect.any(Number) }]);
    expect(activity[quiet.id]).toBeUndefined();
    expect(app.snapshot({ id: "d", name: "x", platform: "", createdAt: 0, lastSeenAt: 0 } as never).roomActivity[room.id]?.[0].turns).toBe(3);
    const pushed = events.filter((e) => e.t === "roomActivity" && e.roomId === room.id);
    expect(pushed.length).toBe(3);
    expect((pushed.at(-1) as Extract<ServerEvent, { t: "roomActivity" }>).activity[0].turns).toBe(3);
    // Removing an agent keeps its past work in the icon.
    const rare = app.store.listMembers(room.id).find((m) => m.handle === "rare")!;
    await app.removeMember(rare.id);
    expect(app.store.roomActivity()[room.id]?.[0].turns).toBe(3);
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an older database gets the provider column filled in from its agents", async () => {
  const { Database } = await import("bun:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "ct-migrate-"));
  const path = join(dir, "old.db");
  try {
    const { Store } = await import("../src/db");
    const fresh = new Store(path);
    const now = Date.now();
    fresh.insertRoom({ id: "r", name: "R", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 5, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false });
    fresh.insertMember({ id: "m", roomId: "r", handle: "c", provider: "codex", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    fresh.close();
    // Simulate an older hub's database: no provider column on turns yet.
    const raw = new Database(path);
    raw.exec("ALTER TABLE turns DROP COLUMN provider");
    raw.exec(`INSERT INTO turns (id,room_id,member_id,hop,chain_id,status,created_at) VALUES ('t','r','m',0,'c','done',${now})`);
    raw.close();
    const migrated = new Store(path);
    expect(migrated.roomActivity()["r"]).toEqual([{ provider: "codex", turns: 1, outputTokens: 0 }]);
    migrated.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
