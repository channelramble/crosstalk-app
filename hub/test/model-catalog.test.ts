import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatContextSize, type ModelCatalog, type ModelOption, type ServerEvent } from "@crosstalk/shared";
import "../src/providers/all";
import { App } from "../src/app";
import { providerModule, registerProvider, type ModelContextInfo } from "../src/providers";
import { anthropicEfforts, anthropicModels, claudeContext, claudeMoreModels, claudeProvider, withClaudeControl } from "../src/providers/claude";
import { processesEnding, processGrace } from "../src/util/process";
import { codexContextFrom, codexProvider } from "../src/providers/codex";
import { geminiModelOptions } from "../src/providers/gemini";
import { museModelOptions } from "../src/providers/muse";

const FIX = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
const realAntigravity = providerModule("antigravity")!;
afterAll(() => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  registerProvider(realAntigravity);
});

const opt = (id: string, isDefault = false): ModelOption => ({ id, label: id, description: null, efforts: [], defaultEffort: null, isDefault });
const config = (dir: string) => ({ port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 });
async function until(check: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}
const modelsEvents = (events: ServerEvent[]) => events.filter((e): e is Extract<ServerEvent, { t: "models" }> => e.t === "models").map((e) => e.catalog);
const entry = (c: ModelCatalog, id: string) => c.models.find((m) => m.id === id);

test("model lists: sizes are asked in the background and kept, new models are marked, and changes go out as events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-models-"));
  dirs.push(dir);
  const dbPath = join(dir, "hub.db");
  const list = [opt("argon", true), opt("flash")];
  const sizes: Record<string, ModelContextInfo> = { argon: { contextWindow: 1_048_576 }, flash: { contextWindow: 1_048_576, compactAt: 900_000 } };
  let failing = false;
  let sized = 0;
  registerProvider({
    ...realAntigravity,
    async listModels() {
      if (failing) throw new Error("agy crashed");
      return list.map((m) => ({ ...m }));
    },
    async modelContext(_app, _bin, models) {
      sized++;
      return Object.fromEntries(models.filter((m) => sizes[m.id]).map((m) => [m.id, sizes[m.id]]));
    },
  });
  const start = () => {
    const app = new App({ dbPath, config: config(dir) });
    app.providers.which = (p) => (p === "antigravity" ? "/usr/bin/true" : null);
    const events: ServerEvent[] = [];
    app.bus.on((e: ServerEvent) => events.push(e));
    return { app, events };
  };
  const { app, events } = start();
  try {
    // The first list is where Crosstalk starts counting: nothing in it is "new". Sizes come a moment later.
    const first = await app.providers.models("antigravity");
    expect(first.live).toBe(true);
    expect(first.models.map((m) => [m.id, m.firstSeen])).toEqual([["argon", 0], ["flash", 0]]);
    // Clients hear of the list, then of the sizes once they're in.
    await until(() => modelsEvents(events).some((c) => entry(c, "flash")?.contextWindow));
    expect(entry(modelsEvents(events).at(-1)!, "flash")).toMatchObject({ contextWindow: 1_048_576, compactAt: 900_000 });
    expect(entry(await app.providers.models("antigravity"), "argon")!.contextWindow).toBe(1_048_576);
    // What drivers look up without asking the agent: a model by name, or the default.
    expect(app.providers.knownModel("antigravity", "default", "flash")?.compactAt).toBe(900_000);
    expect(app.providers.knownModel("antigravity", "default", null)?.id).toBe("argon");
    expect(await app.providers.modelInfo("antigravity", "default", "flash")).toMatchObject({ id: "flash", contextWindow: 1_048_576 });

    // The agent starts offering a model: the refresh says so, marks when it came, and sizes it.
    list.push(opt("gemini-5"));
    sizes["gemini-5"] = { contextWindow: 2_000_000 };
    await app.providers.refresh("antigravity");
    await app.providers.refreshModels();
    const added = modelsEvents(events).find((c) => entry(c, "gemini-5"))!;
    expect(entry(added, "gemini-5")!.firstSeen).toBeGreaterThan(0);
    expect(entry(added, "argon")!.firstSeen).toBe(0);
    await until(() => sized === 2 && entry(modelsEvents(events).at(-1)!, "gemini-5")?.contextWindow === 2_000_000);

    // A model goes away: that's an event too.
    list.splice(1, 1);
    await app.providers.models("antigravity", "default", { fresh: true });
    expect(modelsEvents(events).at(-1)!.models.map((m) => m.id)).toEqual(["argon", "gemini-5"]);

    // The agent can't be asked this time: the list it gave last still stands, with the error noted.
    failing = true;
    const stale = await app.providers.models("antigravity", "default", { fresh: true });
    expect(stale).toMatchObject({ live: true, error: "agy crashed" });
    expect(stale.models.map((m) => m.id)).toEqual(["argon", "gemini-5"]);
    failing = false;
  } finally {
    await app.engine.shutdown();
    app.store.close();
  }

  // After a restart the sizes are known at once, without asking the agent for them again.
  const again = start();
  try {
    const c = await again.app.providers.models("antigravity");
    expect(entry(c, "gemini-5")).toMatchObject({ contextWindow: 2_000_000 });
    expect(entry(c, "gemini-5")!.firstSeen).toBeGreaterThan(0);
    await Bun.sleep(50);
    expect(sized).toBe(2);
    // Before the list is in, what was learned still answers for a model by name.
    expect(again.app.providers.knownModel("antigravity", "default", "argon")).toMatchObject({ contextWindow: 1_048_576 });
  } finally {
    await again.app.engine.shutdown();
    again.app.store.close();
  }
});

test("Codex's catalog: the window it gives each model, the share the conversation fills, compaction, and long context", () => {
  const sizes = codexContextFrom({
    models: [
      { slug: "gpt-6-astra", context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 },
      { slug: "gpt-6.1-sol", context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95, auto_compact_token_limit: 400000 },
      { slug: "only-max", max_context_window: 128000 },
      { slug: "no-size" },
      { context_window: 1 },
    ],
  });
  expect(sizes["gpt-6-astra"]).toEqual({ contextWindow: 272_000, usableContext: 258_400, compactAt: 244_800, maxContextWindow: 872_000 });
  expect(sizes["gpt-6.1-sol"]).toEqual({ contextWindow: 500_000, usableContext: 475_000, compactAt: 400_000, maxContextWindow: 872_000 });
  // Without a window, the maximum is the window (there's no larger one to raise it to).
  expect(sizes["only-max"]).toEqual({ contextWindow: 128_000, usableContext: 121_600, compactAt: 115_200, maxContextWindow: null });
  expect(Object.keys(sizes)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "only-max"]);

  // A chat on it: the usual window, or with long context the most it allows, Codex's share and compaction growing along.
  expect(chatContextSize(sizes["gpt-6-astra"])).toEqual({ window: 272_000, usable: 258_400, compactAt: 244_800, long: false });
  expect(chatContextSize(sizes["gpt-6-astra"], true)).toEqual({ window: 872_000, usable: 828_400, compactAt: 784_800, long: true });
  expect(chatContextSize(sizes["only-max"], true)).toMatchObject({ window: 128_000, long: false });
  expect(chatContextSize({ contextWindow: 1_000_000, compactAt: 967_000 })).toEqual({ window: 1_000_000, usable: 1_000_000, compactAt: 967_000, long: false });
  expect(chatContextSize({ contextWindow: null })).toBeNull();
  expect(chatContextSize(undefined)).toBeNull();
});

test("Codex lists its models with what each can hold, from its catalog", async () => {
  const app = { providers: { agentEnv: () => ({ PATH: process.env.PATH ?? "" }) } } as unknown as App;
  const models = await codexProvider.listModels!(app, join(FIX, "fake-codex-app"));
  expect(models).toEqual([expect.objectContaining({ id: "gpt-test", isDefault: true, contextWindow: 272_000, usableContext: 258_400, compactAt: 244_800, maxContextWindow: 872_000 })]);
});

test("More models: Codex's hidden models come after its usual ones, sized, and a Codex that refuses to list them still gives its usual list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-codex-more-"));
  dirs.push(dir);
  const bin = join(FIX, "fake-codex-app");
  const rpcLog = join(dir, "rpc.log");
  // Its own CODEX_HOME: nothing of the user's Codex is read or written.
  const env = { PATH: process.env.PATH ?? "", CODEX_HOME: dir, FAKE_CODEX_HIDDEN_MODELS: "1", FAKE_CODEX_RPC_LOG: rpcLog };
  const asked = () => readFileSync(rpcLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.method === "model/list").map((m) => m.params);
  const models = await codexProvider.listModels!({ providers: { agentEnv: () => env } } as unknown as App, bin);
  expect(asked()).toEqual([{ includeHidden: true }]);
  expect(models.map((m) => [m.id, m.more ?? false])).toEqual([["gpt-test", false], ["gpt-test-reserve", true]]);
  // Like any other model: its own description, effort levels and size (Codex's catalog has the hidden ones too).
  expect(models[1]).toEqual({ id: "gpt-test-reserve", label: "GPT test reserve", description: "Fast and affordable test model.", efforts: ["low", "medium"], defaultEffort: "low", isDefault: false, fast: null, more: true, contextWindow: 128_000, usableContext: 121_600, compactAt: 115_200, maxContextWindow: null });

  // An older Codex that doesn't take includeHidden: asked again without it, and nothing more is guessed.
  rmSync(rpcLog, { force: true });
  const older = { ...env, FAKE_CODEX_REFUSE_HIDDEN: "1" };
  const usual = await codexProvider.listModels!({ providers: { agentEnv: () => older } } as unknown as App, bin);
  expect(asked()).toEqual([{ includeHidden: true }, {}]);
  expect(usual.map((m) => [m.id, m.more ?? false])).toEqual([["gpt-test", false]]);

  // Through the hub, that list is live (not an error with suggestions).
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  app.providers.which = (p) => (p === "codex" ? bin : null);
  app.providers.agentEnv = () => older;
  try {
    const catalog = await app.providers.models("codex");
    expect(catalog).toMatchObject({ live: true, error: null });
    expect(catalog.models.map((m) => m.id)).toEqual(["gpt-test"]);
  } finally {
    await app.engine.shutdown();
    app.store.close();
  }
});

test("More models aren't new: Codex's hidden models, listed after its usual list was known, count as there before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-codex-seen-"));
  dirs.push(dir);
  const bin = join(FIX, "fake-codex-app");
  // Its own CODEX_HOME: nothing of the user's Codex is read or written.
  let env: Record<string, string> = { PATH: process.env.PATH ?? "", CODEX_HOME: dir };
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  app.providers.which = (p) => (p === "codex" ? bin : null);
  app.providers.agentEnv = () => env;
  try {
    // The list a hub had before it asked for hidden models: where it started counting.
    expect((await app.providers.models("codex")).models.map((m) => [m.id, m.firstSeen])).toEqual([["gpt-test", 0]]);
    // The first list with them: they were there all along, so an app that doesn't know More models doesn't call them New.
    env = { ...env, FAKE_CODEX_HIDDEN_MODELS: "1" };
    const more = await app.providers.models("codex", "default", { fresh: true });
    expect(more.models.map((m) => [m.id, m.more ?? false, m.firstSeen])).toEqual([["gpt-test", false, 0], ["gpt-test-reserve", true, 0]]);
  } finally {
    await app.engine.shutdown();
    app.store.close();
  }
});

test("More models: a model moving into or out of them reaches the apps, and lookups keep the flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-models-more-"));
  dirs.push(dir);
  let list: ModelOption[] = [opt("argon", true), { ...opt("flash"), more: true }];
  registerProvider({
    ...realAntigravity,
    async listModels() {
      return list.map((m) => ({ ...m }));
    },
  });
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  app.providers.which = (p) => (p === "antigravity" ? "/usr/bin/true" : null);
  const events: ServerEvent[] = [];
  app.bus.on((e: ServerEvent) => events.push(e));
  try {
    expect(entry(await app.providers.models("antigravity"), "flash")?.more).toBe(true);
    // The agent puts it in its usual list: the same models, so only the group says it changed.
    list = [opt("argon", true), opt("flash")];
    await app.providers.models("antigravity", "default", { fresh: true });
    // And back.
    list = [opt("argon", true), { ...opt("flash"), more: true }];
    await app.providers.models("antigravity", "default", { fresh: true });
    expect(modelsEvents(events).map((c) => entry(c, "flash")?.more ?? false)).toEqual([true, false, true]);
    // What drivers look up keeps the flag (a chat can be on one of them like any other).
    expect(app.providers.knownModel("antigravity", "default", "flash")).toMatchObject({ id: "flash", more: true });
    // A model new to the usual list is still news; one that comes under More models (by either of its names) isn't.
    list = [...list, opt("gemini-5"), { ...opt("nano"), resolvedModel: "nano-001", more: true }];
    const later = await app.providers.models("antigravity", "default", { fresh: true });
    expect(entry(later, "gemini-5")!.firstSeen).toBeGreaterThan(0);
    expect(entry(later, "nano")!.firstSeen).toBe(0);
    expect(JSON.parse(app.store.kvGet("modelFirstSeen")!)["antigravity:default"]["nano-001"]).toBe(0);
  } finally {
    await app.engine.shutdown();
    app.store.close();
  }
});

/** What the Claude provider reads of the hub for an account without an API key (a plan sign-in). */
const claudeApp = (env: Record<string, string>) => ({ providers: { agentEnv: () => env, currentAccount: () => "default", apiKeyFor: () => null } }) as unknown as App;
const jsonLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("Claude Code: its models, and each one's context window, from a Claude Code started on that model and pointed at a stand-in for Anthropic's API, so no check can cost anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-claude-sizes-"));
  dirs.push(dir);
  const paid = join(dir, "paid.jsonl");
  const argsLog = join(dir, "args.jsonl");
  const PATH = process.env.PATH ?? "";
  const app = claudeApp({ PATH, FAKE_CLAUDE_PAID_OUT: paid, FAKE_CLAUDE_ARGS_OUT: argsLog });
  const bin = join(FIX, "fake-claude");
  const models = await claudeProvider.listModels!(app, bin);
  expect(models.map((m) => m.id)).toEqual(["opus", "claude-sonnet-4-6", "haiku", "retired"]);
  // A plan sign-in: Claude Code's picker has no other models (it takes them only by full name), so none go under More models.
  expect(models.filter((m) => m.more)).toEqual([]);
  const sizes = await claudeProvider.modelContext!(app, bin, models);
  expect(sizes.opus).toEqual({ contextWindow: 1_000_000, compactAt: 967_000 });
  expect(sizes["claude-sonnet-4-6"]).toEqual({ contextWindow: 200_000, compactAt: 167_000 });
  // By the model's full name as well: that's what a helper agent's transcript names.
  expect(sizes["claude-haiku-4-5-20251001"]).toEqual({ contextWindow: 200_000, compactAt: 167_000 });
  expect(sizes["claude-opus-5-5"]).toEqual(sizes.opus);
  // One it has no size for (not on this plan) is left unsized rather than guessed.
  expect(sizes.retired).toBeUndefined();
  // Each one by starting Claude Code on it (--model), pointed at the stand-in in its environment and in --settings (the
  // user's own settings' env would win over the environment). A full name is never set_model'd, which Claude Code would
  // first check with a one-token request to Anthropic (what the fake notes in `paid`).
  const checks = jsonLines(argsLog).filter((a: string[]) => a.includes("--model"));
  expect(checks.map((a: string[]) => a[a.indexOf("--model") + 1])).toEqual(["opus", "claude-sonnet-4-6", "haiku", "retired"]);
  for (const a of checks) expect(JSON.parse(a[a.indexOf("--settings") + 1])).toEqual({ env: { ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) } });
  expect(jsonLines(paid)).toEqual([]);
  // (Which is what switching would have cost: one request for the full name, none for an alias.)
  await withClaudeControl(bin, { PATH, FAKE_CLAUDE_PAID_OUT: paid }, 10_000, async (ask) => {
    await ask({ subtype: "initialize" });
    await ask({ subtype: "set_model", model: "haiku" });
    await ask({ subtype: "set_model", model: "claude-sonnet-4-6" });
  });
  expect(jsonLines(paid).map((r) => [r.model, r.max_tokens])).toEqual([["claude-sonnet-4-6", 1]]);
  rmSync(paid);

  // A model its picker doesn't list (an API key's More models) is sized the same way, for free.
  const more = { ...opt("claude-opus-4-8"), more: true };
  expect(await claudeProvider.modelContext!(app, bin, [more])).toEqual({ "claude-opus-4-8": { contextWindow: 1_000_000, compactAt: 967_000 } });

  // One that Claude Code's cached model access marks as not entitled (the plan's, which an API key shares): started on it,
  // Claude Code first checks it with a one-token request. That goes to the stand-in, even when the user's own settings
  // point Claude Code at another server, so it fails and Claude Code runs its default model: no size, but nothing marks
  // it as not running (a chat's own start sends that check, with the account's key).
  const denied = { ...opt("claude-fable-5-0"), more: true };
  const proxied = claudeApp({ PATH, FAKE_CLAUDE_PAID_OUT: paid, FAKE_CLAUDE_CACHED_DENY: "claude-fable-5-0", FAKE_CLAUDE_USER_BASE_URL: "https://llm-proxy.example.com" });
  expect(await claudeProvider.modelContext!(proxied, bin, [denied])).toEqual({ "claude-fable-5-0": { contextWindow: null } });
  expect(jsonLines(paid)).toEqual([]);
  // (Without the stand-in, that check goes out: billed to the key.)
  await withClaudeControl(bin, { PATH, FAKE_CLAUDE_PAID_OUT: paid, FAKE_CLAUDE_CACHED_DENY: "claude-fable-5-0" }, 10_000, (ask) => ask({ subtype: "initialize" }), { model: "claude-fable-5-0" });
  expect(jsonLines(paid).map((r) => [r.model, r.max_tokens, r.to])).toEqual([["claude-fable-5-0", 1, "https://api.anthropic.com"]]);
  rmSync(paid);

  // A More model Claude Code runs another model in place of, without checking it first (the user's or an organization's
  // settings leave it out), doesn't run here: marked so with the model that ran. One of its own list just isn't given
  // that model's size.
  const standIn = claudeApp({ PATH, FAKE_CLAUDE_PAID_OUT: paid, FAKE_CLAUDE_STAND_IN: "claude-opus-4-8=claude-opus-5-5,claude-sonnet-4-6=claude-opus-5-5" });
  expect(await claudeProvider.modelContext!(standIn, bin, [more, models[1]])).toEqual({ "claude-opus-4-8": { contextWindow: null, runsAs: "claude-opus-5-5" } });
  expect(jsonLines(paid)).toEqual([]);

  expect(claudeContext({ maxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: false })).toEqual({ contextWindow: 200_000, compactAt: null });
  expect(claudeContext({ maxTokens: 0 })).toBeNull();
});

test("Anthropic's model list for More models: each model's name and effort levels, what Claude Code lists or can't pick left out", () => {
  // The Models API's capability tree: a level counts when it says supported.
  expect(anthropicEfforts({ effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } } })).toEqual(["low", "medium", "high", "max"]);
  expect(anthropicEfforts({ effort: { supported: false, low: { supported: false } } })).toEqual([]);
  expect(anthropicEfforts(undefined)).toEqual([]);
  const usual: ModelOption[] = [
    { ...opt("opus", true), resolvedModel: "claude-opus-5-5" },
    { ...opt("haiku"), resolvedModel: "claude-haiku-4-5-20251001" },
    { ...opt("sonnet[1m]"), resolvedModel: "claude-sonnet-5-5[1m]" },
  ];
  const api = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low"] },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", efforts: [] },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: [] },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", efforts: ["max"] },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: ["low", "max"] },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", efforts: [] },
  ];
  // Named by Claude Code under any of its names (an alias, a dated or 1M form), or one it lists as not for this account: left out.
  expect(claudeMoreModels(api, usual, [{ value: "claude-fable-5-1", disabled: true }])).toEqual([
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", description: null, efforts: ["low", "max"], defaultEffort: null, isDefault: false, fast: null, more: true },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", description: null, efforts: [], defaultEffort: null, isDefault: false, fast: null, more: true },
  ]);
  expect(claudeMoreModels([], usual)).toEqual([]);
});

test("More models for a Claude API key: Anthropic's Models API, asked with that key only, beyond Claude Code's list, sized like the rest at no cost, and kept through an outage and a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-claude-more-"));
  dirs.push(dir);
  const bin = join(FIX, "fake-claude");
  const paid = join(dir, "paid.jsonl");
  const dbPath = join(dir, "hub.db");
  const key = "sk-ant-api03-test-key-0123456789";
  // A stand-in for api.anthropic.com: what it was asked, with which key and workspace.
  const seen: { method: string; path: string; key: string | null; version: string | null; workspace: string | null }[] = [];
  let answer: "list" | "down" | "refused" = "list";
  const effort = (...levels: string[]) => ({ supported: levels.length > 0, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((l) => [l, { supported: levels.includes(l) }])) });
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push({ method: req.method, path: u.pathname + u.search, key: req.headers.get("x-api-key"), version: req.headers.get("anthropic-version"), workspace: req.headers.get("anthropic-workspace-id") });
      if (answer === "refused") return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
      if (answer === "down") return Response.json({ type: "error", error: { type: "api_error", message: "Internal server error" } }, { status: 500 });
      if (u.pathname !== "/v1/models") return new Response("not found", { status: 404 });
      const model = (id: string, name: string, levels: string[]) => ({ type: "model", id, display_name: name, created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: effort(...levels) } });
      return Response.json({
        data: [
          model("claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high", "xhigh", "max"]),
          model("claude-fable-5-1", "Claude Fable 5.1", ["low", "medium", "high", "xhigh", "max"]),
          model("claude-opus-4-8", "Claude Opus 4.8", ["low", "medium", "high", "xhigh", "max"]),
          model("claude-fable-5-0", "Claude Fable 5", ["low", "medium", "high", "max"]),
          model("claude-sonnet-4-6", "Claude Sonnet 4.6", ["low", "medium", "high", "max"]),
          model("claude-opus-4-1-20250805", "Claude Opus 4.1", []),
          model("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", []),
          model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", []),
          { type: "model", display_name: "No id" },
          { type: "model", id: "--model-flag", display_name: "Reads as an option" },
        ],
        has_more: false,
        first_id: "claude-opus-5-5",
        last_id: "claude-haiku-4-5-20251001",
      });
    },
  });
  const urlBefore = process.env.CROSSTALK_ANTHROPIC_API_URL;
  process.env.CROSSTALK_ANTHROPIC_API_URL = `http://127.0.0.1:${api.port}`;
  // This machine's Claude Code: the user's settings leave Opus 4.1 out (it runs Opus 5.5 in its place), the plan's cached
  // model access says Fable 5 isn't for this account, and the user's own settings send its requests to a proxy.
  const fakeEnv = { FAKE_CLAUDE_PAID_OUT: paid, FAKE_CLAUDE_STAND_IN: "claude-opus-4-1-20250805=claude-opus-5-5", FAKE_CLAUDE_CACHED_DENY: "claude-fable-5-0", FAKE_CLAUDE_USER_BASE_URL: "https://llm-proxy.example.com" };
  const start = () => {
    const app = new App({ dbPath, config: config(dir) });
    app.providers.which = (p) => (p === "claude" ? bin : null);
    const realEnv = app.providers.agentEnv.bind(app.providers);
    app.providers.agentEnv = (p, a) => ({ ...realEnv(p, a), ...fakeEnv });
    const events: ServerEvent[] = [];
    app.bus.on((e: ServerEvent) => events.push(e));
    return { app, events };
  };
  const stop = async (app: App) => {
    await app.engine.shutdown();
    app.store.close();
  };
  const ids = (c: ModelCatalog) => c.models.map((m) => [m.id, m.more ?? false]);
  let { app, events } = start();
  try {
    const acct = await app.providers.setApiKeyAccount("claude", key, { label: "Work key", workspaceId: "wrkspc_01ABC" });
    const catalog = await app.providers.models("claude", acct.id);
    expect(catalog).toMatchObject({ live: true, error: null });
    // Claude Code's list first; then what the key can use that it doesn't name (Sonnet 4.6 and Haiku 4.5 it lists, Opus
    // 5.5 by its alias, Fable 5.1 it can't pick here), in Anthropic's order. Nothing is guessed.
    expect(ids(catalog)).toEqual([["opus", false], ["claude-sonnet-4-6", false], ["haiku", false], ["retired", false], ["claude-opus-4-8", true], ["claude-fable-5-0", true], ["claude-opus-4-1-20250805", true], ["claude-sonnet-4-5-20250929", true]]);
    expect(entry(catalog, "claude-opus-4-8")).toMatchObject({ label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"], isDefault: false, fast: null, firstSeen: 0 });
    expect(entry(catalog, "claude-sonnet-4-5-20250929")!.efforts).toEqual([]);
    // One free GET, with the account's own key and workspace; the key goes nowhere a client sees.
    expect(seen).toEqual([{ method: "GET", path: "/v1/models?limit=1000", key, version: "2023-06-01", workspace: "wrkspc_01ABC" }]);
    expect(JSON.stringify(catalog)).not.toContain(key);

    // Sized in the background like the rest, by starting Claude Code on each, pointed at a stand-in for Anthropic's API:
    // nothing reaches Anthropic, for any of them. Opus 4.1 doesn't run here, so it leaves the list (and a chat still on
    // it is told); Fable 5 would need Claude Code to ask Anthropic first, so it stays, unsized.
    await until(() => modelsEvents(events).some((c) => !entry(c, "claude-opus-4-1-20250805") && entry(c, "claude-sonnet-4-5-20250929")?.contextWindow === 200_000), 15_000);
    const sized = modelsEvents(events).at(-1)!;
    expect(ids(sized)).toEqual([["opus", false], ["claude-sonnet-4-6", false], ["haiku", false], ["retired", false], ["claude-opus-4-8", true], ["claude-fable-5-0", true], ["claude-sonnet-4-5-20250929", true]]);
    expect(sized.gone).toEqual(["claude-opus-4-1-20250805"]);
    expect(entry(sized, "claude-opus-4-8")).toMatchObject({ contextWindow: 1_000_000, compactAt: 967_000, more: true });
    expect(entry(sized, "claude-fable-5-0")?.contextWindow ?? null).toBeNull();
    expect(app.providers.knownModel("claude", acct.id, "claude-sonnet-4-6")).toMatchObject({ contextWindow: 200_000, compactAt: 167_000 });
    expect(jsonLines(paid)).toEqual([]);
    expect(app.store.kvGet("modelContext")).not.toContain(key);
    // What it ran instead is kept with the sizes, never handed out as part of a model.
    expect(JSON.parse(app.store.kvGet("modelContext")!)[`claude:${acct.id}`].models["claude-opus-4-1-20250805"]).toEqual({ contextWindow: null, runsAs: "claude-opus-5-5" });
    expect(app.providers.knownModel("claude", acct.id, "claude-opus-4-1-20250805")).not.toHaveProperty("runsAs");
    // The next list leaves it out too.
    const relisted = await app.providers.models("claude", acct.id, { fresh: true });
    expect(relisted.models.some((m) => m.id === "claude-opus-4-1-20250805")).toBe(false);
    expect(relisted.gone).toEqual(["claude-opus-4-1-20250805"]);

    // Anthropic can't be asked this time: the More models it gave stay (not "gone"), and the list stays live.
    answer = "down";
    const again = await app.providers.models("claude", acct.id, { fresh: true });
    expect(again).toMatchObject({ live: true, error: null, gone: ["claude-opus-4-1-20250805"] });
    expect(again.models.filter((m) => m.more).map((m) => m.id)).toEqual(["claude-opus-4-8", "claude-fable-5-0", "claude-sonnet-4-5-20250929"]);
    expect(app.store.kvGet("modelLookups")).not.toContain(key);

    // And after a restart, when the first list's call to Anthropic fails (no connection yet, say): the last list it gave,
    // with names, effort levels and sizes, and only Opus 4.1 named as gone.
    await stop(app);
    ({ app, events } = start());
    const restarted = await app.providers.models("claude", acct.id);
    expect(restarted).toMatchObject({ live: true, error: null, gone: ["claude-opus-4-1-20250805"] });
    expect(ids(restarted)).toEqual(ids(sized));
    expect(entry(restarted, "claude-opus-4-8")).toMatchObject({ label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1_000_000, compactAt: 967_000, more: true });
    expect(seen.slice(1).every((s) => s.method === "GET" && s.path === "/v1/models?limit=1000" && s.key === key)).toBe(true);

    // A key Anthropic refuses: Claude Code's own list, nothing more (and nothing kept from before).
    answer = "refused";
    const other = await app.providers.setApiKeyAccount("claude", "sk-ant-api03-other-key-9876543210", { label: "Old key" });
    const refused = await app.providers.models("claude", other.id);
    expect(refused).toMatchObject({ live: true, error: null });
    expect(refused.models.some((m) => m.more)).toBe(false);
    // A new key for the account, while Anthropic can't be asked: what the old key could use isn't kept for this one.
    answer = "down";
    await app.providers.setApiKeyAccount("claude", "sk-ant-api03-new-key-5555555555", { id: acct.id });
    expect((await app.providers.models("claude", acct.id, { fresh: true })).models.some((m) => m.more)).toBe(false);

    // A plan sign-in can't say more and isn't asked: Anthropic never hears from it.
    const asked = seen.length;
    const plan = await app.providers.models("claude");
    expect(plan.models.some((m) => m.more)).toBe(false);
    expect(seen.length).toBe(asked);
    expect(seen.every((s) => s.method === "GET" && s.path.startsWith("/v1/models"))).toBe(true);
    expect(jsonLines(paid)).toEqual([]);
  } finally {
    if (urlBefore === undefined) delete process.env.CROSSTALK_ANTHROPIC_API_URL;
    else process.env.CROSSTALK_ANTHROPIC_API_URL = urlBefore;
    api.stop(true);
    await stop(app);
  }
}, 30_000);

test("Anthropic's model list: every page is read, and the key never follows a redirect to another server", async () => {
  const keys: (string | null)[] = [];
  const elsewhere = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (keys.push(req.headers.get("x-api-key")), Response.json({ data: [{ id: "claude-stolen-1" }] })) });
  let redirect = false;
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (redirect) return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${elsewhere.port}/v1/models` } });
      const after = new URL(req.url).searchParams.get("after_id");
      return Response.json(after === "claude-b" ? { data: [{ id: "claude-c", display_name: "C" }], has_more: false, last_id: "claude-c" } : { data: [{ id: "claude-a" }, { id: "claude-b", display_name: "B" }], has_more: true, last_id: "claude-b" });
    },
  });
  const urlBefore = process.env.CROSSTALK_ANTHROPIC_API_URL;
  process.env.CROSSTALK_ANTHROPIC_API_URL = `http://127.0.0.1:${api.port}/`;
  try {
    expect(await anthropicModels("sk-ant-api03-test-key-0123456789", null)).toEqual([
      { id: "claude-a", label: "claude-a", efforts: [] },
      { id: "claude-b", label: "B", efforts: [] },
      { id: "claude-c", label: "C", efforts: [] },
    ]);
    redirect = true;
    expect(await anthropicModels("sk-ant-api03-test-key-0123456789", null)).toBeNull();
    expect(keys).toEqual([]);
    // Nothing listens: no list, and nothing more is shown.
    process.env.CROSSTALK_ANTHROPIC_API_URL = "http://127.0.0.1:9";
    expect(await anthropicModels("sk-ant-api03-test-key-0123456789", null)).toBeNull();
  } finally {
    if (urlBefore === undefined) delete process.env.CROSSTALK_ANTHROPIC_API_URL;
    else process.env.CROSSTALK_ANTHROPIC_API_URL = urlBefore;
    api.stop(true);
    elsewhere.stop(true);
  }
});

test("Muse's and Gemini CLI's model lists as picker options", () => {
  expect(
    museModelOptions({ models: [{ modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", description: "Fast", isDefault: true, contextLimit: 256000, variants: ["low", "high"] }, { modelId: "" }, null] }),
  ).toEqual([{ id: "muse-spark-1.3", label: "Muse Spark 1.3", description: "Fast", efforts: [], defaultEffort: null, isDefault: true, contextWindow: 256_000 }]);
  expect(museModelOptions({ models: [] })).toEqual([]);
  expect(
    geminiModelOptions({ availableModels: [{ modelId: "auto-gemini-3", name: "Auto (Gemini 3)", description: "Picks for you" }, { modelId: "gemini-3.8-flash", name: "gemini-3.8-flash" }], currentModelId: "auto-gemini-3" }),
  ).toEqual([
    { id: "auto-gemini-3", label: "Auto (Gemini 3)", description: "Picks for you", efforts: [], defaultEffort: null, isDefault: true },
    { id: "gemini-3.8-flash", label: "gemini-3.8-flash", description: null, efforts: [], defaultEffort: null, isDefault: false },
  ]);
  expect(geminiModelOptions(undefined)).toEqual([]);
});

test("long context is a Codex chat setting: on or off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-long-"));
  dirs.push(dir);
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  try {
    const codex = app.chats.create({ provider: "codex", name: "Long", cwd: dir });
    const claude = app.chats.create({ provider: "claude", name: "Claude", cwd: dir });
    const [cm] = app.store.listMembers(codex.id);
    const [am] = app.store.listMembers(claude.id);
    expect(app.updateMember(cm.id, { config: { ...cm.config, longContext: true } }).config.longContext).toBe(true);
    expect(app.updateMember(cm.id, { config: { ...cm.config, longContext: "yes" } }).config.longContext).toBeUndefined();
    expect(app.updateMember(am.id, { config: { ...am.config, longContext: true } }).config.longContext).toBeUndefined();
  } finally {
    await app.engine.shutdown();
    app.store.close();
  }
});

test("a Claude Code that hangs (and ignores SIGTERM) can't hold up model lists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-frozen-"));
  dirs.push(dir);
  const bin = join(dir, "frozen-claude");
  // Answers initialize, then nothing more, and never exits on SIGTERM.
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (m.request?.subtype === "initialize") process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { models: [{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" }] } } }) + "\\n");
  }
}
`,
  );
  chmodSync(bin, 0o755);
  const grace = processGrace.ms;
  processGrace.ms = 100;
  const env = { PATH: process.env.PATH ?? "" };
  try {
    const started = Date.now();
    expect((await claudeProvider.listModels!(claudeApp(env), bin)).map((m) => m.id)).toEqual(["opus"]);
    // A question it never answers gives up at the time limit instead of waiting forever.
    const answer = await withClaudeControl(bin, env, 300, async (ask) => {
      await ask({ subtype: "initialize" });
      return ask({ subtype: "get_context_usage" }).catch((e: Error) => e.message);
    });
    expect(answer).toBe("Claude Code took too long to answer");
    // Both processes are ended (SIGKILL after the grace period), not left running.
    await processesEnding();
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    processGrace.ms = grace;
  }
});

test("model lists: the first good list after a failure goes out, sizes stay when the agent leaves them out, retries back off, and gone models are named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-models-fail-"));
  dirs.push(dir);
  let mode: "fail" | "ok" | "unsized" = "fail";
  let asked = 0;
  let list = [opt("argon", true), opt("flash")];
  const sized = (m: ModelOption) => ({ ...m, contextWindow: 1_048_576, usableContext: 1_000_000, compactAt: 900_000, maxContextWindow: 2_000_000 });
  registerProvider({
    ...realAntigravity,
    async listModels() {
      asked++;
      if (mode === "fail") throw new Error("agy crashed");
      // "unsized": the list came, but its sizes couldn't be read this time (like `codex debug models` failing).
      return list.map((m) => (mode === "ok" ? sized(m) : { ...m }));
    },
  });
  const app = new App({ dbPath: ":memory:", config: config(dir) });
  app.providers.which = (p) => (p === "antigravity" ? "/usr/bin/true" : null);
  const events: ServerEvent[] = [];
  app.bus.on((e: ServerEvent) => events.push(e));
  try {
    // The agent can't be asked (not signed in, say): suggestions, and not asked again on every request for a while.
    expect((await app.providers.models("antigravity")).live).toBe(false);
    await app.providers.models("antigravity");
    expect(asked).toBe(1);
    // Once it answers, clients get the list even though there was none before.
    mode = "ok";
    expect((await app.providers.models("antigravity", "default", { fresh: true })).live).toBe(true);
    expect(modelsEvents(events)).toHaveLength(1);
    // Its sizes couldn't be read this time: the ones it gave last stand (long context still has its maximum).
    mode = "unsized";
    const kept = await app.providers.models("antigravity", "default", { fresh: true });
    expect(entry(kept, "flash")).toMatchObject({ contextWindow: 1_048_576, usableContext: 1_000_000, compactAt: 900_000, maxContextWindow: 2_000_000 });
    expect(app.providers.knownModel("antigravity", "default", "flash")?.maxContextWindow).toBe(2_000_000);
    // It fails with a list on hand: that list is answered, and the agent isn't asked again on every request.
    mode = "fail";
    asked = 0;
    expect((await app.providers.models("antigravity", "default", { fresh: true })).error).toBe("agy crashed");
    await app.providers.models("antigravity");
    await app.providers.models("antigravity");
    await Bun.sleep(20);
    expect(asked).toBe(1);
    // A model it stops offering is named as gone (so a chat still on it can be told); one it never offered isn't.
    mode = "ok";
    list = [opt("argon", true)];
    const after = await app.providers.models("antigravity", "default", { fresh: true });
    expect(after.gone).toEqual(["flash"]);
    expect(modelsEvents(events).at(-1)!.gone).toEqual(["flash"]);
  } finally {
    await app.engine.shutdown();
    app.store.close();
  }
});

test("background sizing keeps what it had for a model it didn't size again, and an empty list sizes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-models-sizes-"));
  dirs.push(dir);
  let list = [opt("argon", true), opt("flash")];
  let round = 0;
  registerProvider({
    ...realAntigravity,
    async listModels() {
      return list.map((m) => ({ ...m }));
    },
    async modelContext(_app, _bin, models) {
      round++;
      // The second time, the agent sizes only the new model.
      const all: Record<string, ModelContextInfo> = { argon: { contextWindow: 1_000_000, compactAt: 967_000 }, flash: { contextWindow: 200_000, compactAt: 167_000 }, gemini: { contextWindow: 2_000_000 } };
      return Object.fromEntries(models.filter((m) => (round === 1 ? m.id !== "gemini" : m.id === "gemini")).map((m) => [m.id, all[m.id]]));
    },
  });
  const app = new App({ dbPath: join(dir, "hub.db"), config: config(dir) });
  app.providers.which = (p) => (p === "antigravity" ? "/usr/bin/true" : null);
  try {
    await app.providers.models("antigravity");
    await until(() => app.providers.knownModel("antigravity", "default", "flash")?.compactAt === 167_000);
    list = [...list, opt("gemini")];
    await app.providers.models("antigravity", "default", { fresh: true });
    await until(() => app.providers.knownModel("antigravity", "default", "gemini")?.contextWindow === 2_000_000);
    expect(app.providers.knownModel("antigravity", "default", "flash")).toMatchObject({ contextWindow: 200_000, compactAt: 167_000 });
    // An agent that lists nothing: nothing to size, and nothing goes wrong.
    list = [];
    expect((await app.providers.models("antigravity", "default", { fresh: true })).models).toEqual([]);
    await Bun.sleep(30);
    expect(round).toBe(2);
  } finally {
    await app.engine.shutdown();
    app.store.close();
  }
});
