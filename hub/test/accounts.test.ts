import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { startServer } from "../src/server";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ct-accounts-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  return { dir, app, done: async () => { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("accounts: add, rename, refuse duplicates/unsupported agents, and remove only when unused", async () => {
  const { app, done } = setup();
  const server = startServer(app);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    expect((await fetch(`${base}/api/accounts`)).status).toBe(401);
    const work = await call("POST", "/api/accounts", { provider: "claude", label: "Work" });
    expect(work.status).toBe(200);
    expect(work.body).toMatchObject({ provider: "claude", label: "Work" });
    expect(work.body.id).not.toBe("default");
    expect(existsSync(app.providers.accountDir("claude", work.body.id))).toBe(true);
    expect((await call("POST", "/api/accounts", { provider: "claude", label: "work" })).status).toBe(409); // same name
    expect((await call("POST", "/api/accounts", { provider: "muse", label: "Second" })).status).toBe(400); // can't separate sign-ins
    const renamed = await call("PATCH", `/api/accounts/claude/${work.body.id}`, { label: "Client X" });
    expect(renamed.body.label).toBe("Client X");
    const list = (await call("GET", "/api/accounts")).body as any[];
    expect(list.some((a) => a.provider === "claude" && a.id === work.body.id && a.label === "Client X")).toBe(true);
    // The agent's own sign-in can't be removed; an account an agent uses can't be either.
    expect((await call("DELETE", "/api/accounts/claude/default")).status).toBe(409);
    const room = app.createRoom({ name: "R", mode: "direct" });
    const m = app.addMember(room.id, { provider: "claude", config: { account: work.body.id } });
    const inUse = await call("DELETE", `/api/accounts/claude/${work.body.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toContain(`@${m.handle} in R`);
    app.updateMember(m.id, { config: {} }); // back to the main account
    expect((await call("DELETE", `/api/accounts/claude/${work.body.id}`)).status).toBe(200);
    expect(existsSync(app.providers.accountDir("claude", work.body.id))).toBe(false);
  } finally { server.stop(true); await done(); }
});

test("each account points its agent at its own sign-in folder; saved API keys stay with the main account", () => {
  const { app, done } = setup();
  try {
    for (const [p, key] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["gemini", "GEMINI_CLI_HOME"]] as const) {
      const a = app.providers.addAccount(p, "Second");
      expect(app.providers.agentEnv(p, a.id)[key]).toBe(app.providers.accountDir(p, a.id));
      expect(app.providers.agentEnv(p, "default")[key]).toBeUndefined();
      // Inside an account's scope, provider modules see that account without being told.
      app.providers.forAccount(p, a.id, () => {
        expect(app.providers.currentAccount(p)).toBe(a.id);
        expect(app.providers.agentEnv()[key]).toBe(app.providers.accountDir(p, a.id));
      });
      expect(app.providers.currentAccount(p)).toBe("default");
    }
    process.env.GEMINI_API_KEY = "main-key";
    try {
      const g = app.providers.accounts().find((a) => a.provider === "gemini" && a.id !== "default")!;
      expect(app.providers.agentEnv("gemini", g.id).GEMINI_API_KEY).toBeUndefined();
    } finally { delete process.env.GEMINI_API_KEY; }
  } finally { void done(); }
});

test("agents use their account; switching accounts starts fresh; limits and usage are per account", async () => {
  const { app, done } = setup();
  try {
    const work = app.providers.addAccount("codex", "Work");
    const room = app.createRoom({ name: "R", mode: "direct" });
    expect(() => app.addMember(room.id, { provider: "codex", config: { account: "nope" } })).toThrow("doesn't exist");
    const main = app.addMember(room.id, { provider: "mock", handle: "main" });
    const m = app.addMember(room.id, { provider: "codex", handle: "worker", config: { account: work.id } });
    expect(m.config.account as string).toBe(work.id);
    expect(app.addMember(room.id, { provider: "codex", handle: "plain", config: { account: "default" } }).config.account).toBeUndefined();
    // Switching account: old conversation dropped, and the room is told which account it now uses.
    app.store.setMemberSession(m.id, { threadId: "old-thread" });
    app.updateMember(m.id, { config: {} });
    expect(Object.keys(app.store.getMemberSession(m.id))).toEqual([]);
    expect(app.store.listMessages(room.id, { limit: 50 }).some((x) => x.text.includes("@worker now uses the Main account"))).toBe(true);
    // Usage is kept per account, so one account's numbers don't overwrite the other's.
    app.store.setUsage({ provider: "codex", accountId: work.id, account: "work@x.com", plan: "Pro", windows: [{ label: "5-hour", usedPercent: 95, resetsAt: Date.now() + 3600_000 } as never], credits: null, note: null, updatedAt: Date.now() });
    app.store.setUsage({ provider: "codex", account: "me@x.com", plan: "Plus", windows: [], credits: null, note: null, updatedAt: Date.now() });
    expect(app.store.getUsage("codex", work.id)?.account).toBe("work@x.com");
    expect(app.store.getUsage("codex")?.account).toBe("me@x.com");
    expect(app.store.listUsage().filter((u) => u.provider === "codex")).toHaveLength(2);
    void main;
  } finally { await done(); }
});

test("extra accounts never inherit the hub's own credentials; model lists and defaults are per account", async () => {
  const { app, done } = setup();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { ANTHROPIC_API_KEY: "main", ANTHROPIC_AUTH_TOKEN: "main", CLAUDE_CODE_OAUTH_TOKEN: "main", OPENAI_API_KEY: "main", CODEX_API_KEY: "main", GOOGLE_API_KEY: "main" });
    const c = app.providers.addAccount("claude", "Work");
    const x = app.providers.addAccount("codex", "Work");
    const g = app.providers.addAccount("gemini", "Work");
    const ce = app.providers.agentEnv("claude", c.id);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(ce[k]).toBeUndefined();
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY"]) expect(app.providers.agentEnv("codex", x.id)[k]).toBeUndefined();
    expect(app.providers.agentEnv("gemini", g.id).GOOGLE_API_KEY).toBeUndefined();
    expect(app.providers.agentEnv("claude").ANTHROPIC_API_KEY).toBe("main"); // the main account keeps them
    // Model lists are asked and cached per account (an unknown account falls back to the main one). Asked of the fake
    // Codex, never the one installed on this computer.
    app.providers.which = (p) => (p === "codex" ? join(import.meta.dir, "fixtures", "fake-codex-app") : null);
    expect((await app.providers.models("codex", x.id)).accountId).toBe(x.id);
    expect((await app.providers.models("codex")).accountId).toBe("default");
    expect((await app.providers.models("codex", "gone")).accountId).toBe("default");
    // Defaults can pick an account for new agents; it's checked, applied, and cleared if the account is removed.
    expect(() => app.setDefaults({ agent: { codex: { permissionMode: "auto", model: null, effort: null, account: "nope" } } })).toThrow("doesn't exist");
    app.setDefaults({ agent: { codex: { permissionMode: "auto", model: null, effort: null, account: x.id } } });
    const room = app.createRoom({ name: "R", mode: "direct" });
    const m = app.addMember(room.id, { provider: "codex" });
    expect(m.config.account as string).toBe(x.id);
    expect(app.addMember(room.id, { provider: "codex", config: { account: "default" } }).config.account).toBeUndefined(); // explicit choice wins
    app.updateMember(m.id, { config: {} });
    app.providers.removeAccount("codex", x.id);
    expect(app.defaults().agent.codex?.account).toBeUndefined();
    expect(app.addMember(room.id, { provider: "codex" }).config.account).toBeUndefined();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    await done();
  }
});

test("retrying a Codex sign-in fully replaces the earlier attempt: its expiry can't fail the new, successful one", async () => {
  const { codexProvider } = await import("../src/providers/codex");
  const { app, done } = setup();
  const events: any[] = [];
  app.bus.on((e) => e.t === "login" && events.push(e));
  const fake = join(import.meta.dir, "fixtures", "fake-codex-login");
  process.env.CROSSTALK_CODEX_LOGIN_TTL_MS = "300";
  try {
    const work = app.providers.addAccount("codex", "Work");
    await app.providers.forAccount("codex", work.id, () => codexProvider.startLogin!(app, fake, {})); // never completes
    process.env.FAKE_COMPLETE_MS = "150";
    await app.providers.forAccount("codex", work.id, () => codexProvider.startLogin!(app, fake, {})); // the retry succeeds
    await Bun.sleep(700); // past both the success and the first attempt's (cleared) expiry
    expect(events.map((e) => [e.accountId, e.done, e.error ?? null])).toEqual([[work.id, true, null]]);
  } finally {
    delete process.env.CROSSTALK_CODEX_LOGIN_TTL_MS;
    delete process.env.FAKE_COMPLETE_MS;
    await done();
  }
});
