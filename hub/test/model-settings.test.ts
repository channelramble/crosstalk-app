import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { registerDriver } from "../src/agents";
import { ClaudeDriver } from "../src/agents/claude";
import type { AgentDriver, DriverContext, TurnSink } from "../src/agents/driver";
let script: (ctx: DriverContext, sink: TurnSink) => Promise<void>;
class StandIn implements AgentDriver {
  readonly provider = "claude" as const;
  constructor(private ctx: DriverContext) {}
  async runTurn(_input: unknown, sink: TurnSink) { await script(this.ctx, sink); return { ok: true }; }
  async interrupt() {}
  async dispose() {}
}
afterAll(() => registerDriver("claude", (c) => new ClaudeDriver(c, c.bin)));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ct-settings-"));
  const app = new App({ dbPath: ":memory:", config: { host: "127.0.0.1", port: 0, publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  registerDriver("claude", (c) => new StandIn(c));
  const room = app.chats.create({ provider: "claude", cwd: dir });
  const member = app.store.listMembers(room.id)[0];
  app.providers.models = async () => ({ provider: "claude", live: true, error: null, models: [{ id: "sonnet", resolvedModel: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["high"], defaultEffort: "high", description: null, isDefault: false }] });
  return { app, room, member, done: async () => { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10); expect(predicate()).toBe(true); };

test("a settings change while the helper catalog loads is not overwritten", async () => {
  const t = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const models = t.app.providers.models;
  t.app.providers.models = async (...args) => { await gate; return models(...args); };
  let answer = "";
  script = async () => { answer = await t.app.useHelperModel(t.member.id, "sonnet"); };
  try {
    t.app.engine.postHumanMessage(t.room.id, "Use Sonnet for helpers", "Phone");
    await waitFor(() => t.app.engine.runningTurns().length > 0);
    t.app.updateMember(t.member.id, { config: { effort: "max", fast: true } });
    release();
    await t.app.engine.whenIdle();
    expect(t.app.store.getMember(t.member.id)?.config).toEqual({ effort: "max", fast: true });
    expect(answer).toContain("settings changed");
  } finally { release(); await t.done(); }
});

test("Default can be deliberately selected again and the effective model is read-only", async () => {
  const t = setup();
  try {
    t.app.store.setMemberSession(t.member.id, { sessionId: "original", model: "claude-opus-5-5" });
    expect(t.app.store.getMember(t.member.id)?.resolvedModel).toBe("claude-opus-5-5");
    t.app.updateMember(t.member.id, { model: null, resolvedModel: "forged" });
    expect(JSON.stringify(t.app.store.getMemberSession(t.member.id))).toBe(JSON.stringify({ sessionId: "original" }));
    expect(t.app.store.getMember(t.member.id)?.resolvedModel).toBeUndefined();
  } finally { await t.done(); }
});

test("switching to a custom endpoint removes an unavailable helper model and explains it", async () => {
  const t = setup();
  try {
    t.app.updateMember(t.member.id, { config: { helperModel: "sonnet" } });
    const account = t.app.providers.setEndpointAccount("claude", { label: "Local test", baseUrl: "http://127.0.0.1:1", models: ["local-model"] });
    const member = t.app.updateMember(t.member.id, { config: { account: account.id, helperModel: "sonnet" } });
    expect(member.config.helperModel).toBeUndefined();
    expect(t.app.store.listMessages(t.room.id).some((m) => m.text.includes("previous helper model is unavailable"))).toBe(true);
  } finally { await t.done(); }
});
