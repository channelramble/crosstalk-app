import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_STORAGE, FACTORY_TEAMWORK, type AgentDefaults } from "@crosstalk/shared";
import { App } from "../src/app";
import { startServer } from "../src/server";

test("Settings → Defaults: saved over the API, applied to new rooms and new agents, explicit choices win", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-defaults-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Mac", "Web"))!;
    const call = (method: string, body?: unknown) => fetch(`${base}/api/settings/defaults`, { method, headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    // Before anything is saved: the built-ins, with the hub's own hand-off default.
    expect(await (await call("GET")).json()).toEqual({ mode: "review", agents: [], maxHops: 6, rounds: 1, parallel: false, agent: {} });
    expect((await fetch(`${base}/api/settings/defaults`)).status).toBe(401);
    // Bad values are refused.
    expect((await call("PUT", { mode: "chaos" })).status).toBe(400);
    expect((await call("PUT", { agents: ["skynet"] })).status).toBe(400);
    expect((await call("PUT", { agent: { codex: { permissionMode: "root" } } })).status).toBe(400);
    const saved = await (await call("PUT", { mode: "lead", maxHops: 99, parallel: true, agents: ["claude", "codex", "claude"], agent: { codex: { permissionMode: "auto", model: " gpt-6 ", effort: "high" } } })).json();
    // "lead" is an old mode: it's saved as Off ("direct").
    expect(saved).toEqual({ mode: "direct", agents: ["claude", "codex"], maxHops: 50, rounds: 1, parallel: true, agent: { codex: { permissionMode: "auto", model: "gpt-6", effort: "high" } } });
    // New rooms start from them…
    const room = app.createRoom({ name: "New" });
    expect([room.mode, room.maxHops, room.parallel]).toEqual(["direct", 50, true]);
    expect(app.createRoom({ name: "Picked", mode: "review" }).mode).toBe("review"); // …unless the caller chose
    // …and so do new agents of that kind; other kinds keep the old defaults.
    const codex = app.addMember(room.id, { provider: "codex" });
    expect([codex.permissionMode, codex.model, codex.config.effort]).toEqual(["auto", "gpt-6", "high"]);
    const claude = app.addMember(room.id, { provider: "claude" });
    expect([claude.permissionMode, claude.model, claude.config.effort]).toEqual(["ask", null, undefined]);
    const chosen = app.addMember(room.id, { provider: "codex", permissionMode: "full", model: null, config: { effort: "low" } });
    expect([chosen.permissionMode, chosen.model, chosen.config.effort]).toEqual(["full", null, "low"]);
    // Choosing "Default" effort is sent as null and must stay that way, not turn back into the saved "high".
    const cleared = app.addMember(room.id, { provider: "codex", config: { effort: null } });
    expect(cleared.config.effort).toBeNull();
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pausing hand-offs near a usage limit is off by default, and works when turned on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-hubsettings-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  try {
    expect(app.hubSettings()).toEqual({ machineName: "", agentsAcrossChats: false, pauseNearLimit: false, carryOnAfterLimit: true, messagesFlow: true, teamwork: FACTORY_TEAMWORK, storage: FACTORY_STORAGE });
    const room = app.createRoom({ name: "R", mode: "review" });
    // The (test) agents' plan reports 95% of its 5-hour limit.
    app.addMember(room.id, { provider: "mock", handle: "builder", config: { delayMs: 10, reply: "Built {n}.", usedPercent: 95 } });
    app.addMember(room.id, { provider: "mock", handle: "checker", config: { delayMs: 10, reply: "APPROVED: ok.", usedPercent: 95 } });
    const agents = () => app.store.listMessages(room.id, { limit: 50 }).filter((m) => m.authorKind === "agent").length;
    app.engine.postHumanMessage(room.id, "go", "Phone");
    await app.engine.whenIdle();
    expect(agents()).toBe(2); // off: the review still happens at 95%
    expect(app.setHubSettings({ pauseNearLimit: true })).toEqual({ machineName: "", agentsAcrossChats: false, pauseNearLimit: true, carryOnAfterLimit: true, messagesFlow: true, teamwork: FACTORY_TEAMWORK, storage: FACTORY_STORAGE });
    app.engine.postHumanMessage(room.id, "again", "Phone");
    await app.engine.whenIdle();
    expect(agents()).toBe(3); // on: the builder works, the hand-off to the reviewer pauses
    expect(app.store.listMessages(room.id, { limit: 50 }).some((m) => m.text.includes("Paused the review loop"))).toBe(true);
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("carrying on when a usage limit resets is on by default, and saves off and on again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-carryon-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  try {
    expect(app.hubSettings().carryOnAfterLimit).toBe(true);
    expect(app.setHubSettings({ carryOnAfterLimit: false }).carryOnAfterLimit).toBe(false);
    expect(app.hubSettings().carryOnAfterLimit).toBe(false);
    expect(app.setHubSettings({ carryOnAfterLimit: true }).carryOnAfterLimit).toBe(true);
    // Settings saved by an older hub say nothing about it: that means on, so chats still carry on after an update.
    app.store.kvSet("hubSettings", JSON.stringify({ machineName: "", agentsAcrossChats: false, pauseNearLimit: true }));
    expect(app.hubSettings()).toMatchObject({ pauseNearLimit: true, carryOnAfterLimit: true });
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("simultaneous per-agent defaults saves preserve each other while legacy PUT can replace the map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-defaults-concurrent-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const base = `http://127.0.0.1:${server.port}/api/settings/defaults`;
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Mac", "Web"))!;
    const headers = { authorization: `Bearer ${device.token}`, "content-type": "application/json" };
    const patch = (provider: string, body: unknown) => fetch(`${base}/${provider}`, { method: "PATCH", headers, body: JSON.stringify(body) });
    const claude: AgentDefaults = { permissionMode: "full", model: "claude-custom", effort: "high" };
    const codex: AgentDefaults = { permissionMode: "auto", model: "codex-custom", effort: null };
    const results = await Promise.all([patch("claude", claude), patch("codex", codex)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(app.defaults().agent).toEqual({ claude, codex });
    expect((await patch("codex", { ...codex, permissionMode: "root" })).status).toBe(400);
    expect((await patch("unknown", codex)).status).toBe(400);
    expect((await patch("codex", null)).status).toBe(400);
    expect(app.defaults().agent).toEqual({ claude, codex });
    expect((await fetch(`${base}/codex`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(codex) })).status).toBe(401);
    expect((await fetch(base, { method: "PUT", headers, body: JSON.stringify({ agent: { claude } }) })).status).toBe(200);
    expect(app.defaults().agent).toEqual({ claude });
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
