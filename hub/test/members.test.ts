import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import "../src/providers/all";

const config = (dir: string) => ({ port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 });

test("no agent can be named @all, @everyone or @human", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-members-"));
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  try {
    const room = app.createRoom({ name: "R", mode: "direct" });
    const m = app.addMember(room.id, { provider: "mock", handle: "all" });
    expect(m.handle).toBe("all-agent");
    for (const handle of ["all", "everyone", "human"]) expect(() => app.updateMember(m.id, { handle })).toThrow("reserved");
  } finally {
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents of a kind no longer supported (Claude Code cloud) are removed at start, with their stored token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retired-"));
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  try {
    const room = app.createRoom({ name: "R", mode: "direct" });
    const kept = app.addMember(room.id, { provider: "mock", handle: "worker" });
    const now = Date.now();
    const db = (app.store as unknown as { db: { query: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("INSERT INTO members (id, room_id, handle, provider, model, role, permission_mode, status, config, session, created_at, position) VALUES (?, ?, 'cloud', 'claude-cloud', NULL, '', 'ask', 'idle', '{}', '{}', ?, 1)").run("mb_cloud", room.id, now);
    db.query("INSERT INTO turns (id, room_id, member_id, hop, chain_id, status, created_at, provider) VALUES ('t_c', ?, 'mb_cloud', 0, 'ch', 'done', ?, 'claude-cloud')").run(room.id, now);
    app.store.kvSet("memberSecret:mb_cloud", "sk-ant-oat01-old");
    app.store.kvSet("memberSecret:mb_from_a_deleted_room", "sk-ant-oat01-orphan");
    // Saved defaults from when the cloud agent existed.
    app.store.kvSet("defaults", JSON.stringify({ mode: "review", agents: ["claude-cloud", "mock"], agent: { "claude-cloud": { permissionMode: "ask", model: null, effort: null }, mock: { permissionMode: "auto", model: null, effort: null } } }));
    await app.start();
    expect(app.store.kvGet("memberSecret:mb_from_a_deleted_room")).toBeNull();
    const saved = JSON.parse(app.store.kvGet("defaults")!);
    expect(saved.agents).toEqual(["mock"]);
    expect(Object.keys(saved.agent)).toEqual(["mock"]);
    expect(() => app.setDefaults(app.defaults())).not.toThrow(); // saving Settings works again
    expect(app.store.listMembers(room.id).map((m) => m.id)).toEqual([kept.id]);
    expect(app.store.kvGet("memberSecret:mb_cloud")).toBeNull();
    expect(app.store.listMessages(room.id, { limit: 20 }).some((m) => m.text.includes("@cloud was removed: Crosstalk no longer supports Claude Code (cloud) agents"))).toBe(true);
    expect((app.store.roomActivity()[room.id] ?? []).some((a) => (a.provider as string) === "claude-cloud")).toBe(false);
  } finally {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
