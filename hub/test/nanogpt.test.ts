// NanoGPT (nano-gpt.com) as an AI service: finding a model among the several hundred it sells (its uncensored ones first),
// what each costs, what the account has left to spend, and how its replies are counted in Costs. Everything here runs
// against the stand-in NanoGPT on a loopback port (fixtures/fake-nanogpt.ts): no key of the user's, no model request,
// and nothing reaches the real service.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Turn } from "@crosstalk/shared";
import { App } from "../src/app";
import { NANOGPT_BASE_URL, NANOGPT_ORIGIN, NanoGpt, cleanFilter, planOf, priceOf, rowOf } from "../src/nanogpt";
import { priceTokens } from "../src/prices";
import { endpointModelOptions } from "../src/serviceProbes";
import { startServer } from "../src/server";
import { NANO_MODELS, fakeNanoGpt } from "./fixtures/fake-nanogpt";

const KEY = "sk-nano-test-key-0001";
const PICK = "deepseek/deepseek-v4.1-flash-uncensored";
const IN_PLAN = "z-ai/glm-5.3-flash-uncensored";
/** The rows an agent can use: the decision model and the image model are never listed. */
const USABLE = NANO_MODELS.length - 2;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function nano(o: Parameters<typeof fakeNanoGpt>[0] = {}) {
  const fake = fakeNanoGpt({ key: KEY, ...o });
  cleanups.push(() => fake.stop());
  return fake;
}

/** A hub whose NanoGPT is the stand-in; without one, NanoGPT stays what test/preload.ts set (a closed port). */
function setup(fake?: { url: string }) {
  const dir = mkdtempSync(join(tmpdir(), "ct-nano-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  if (fake) app.services.nanogpt.origin = fake.url;
  cleanups.push(async () => {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, dir };
}

/** The account the Add sheet saves for NanoGPT (web/src/services.ts saveBody): Codex, through the hub's chat adapter. */
function addNano(app: App, baseUrl: string, models = [PICK, IN_PLAN]) {
  return app.providers.setEndpointAccount("codex", { label: "NanoGPT", baseUrl, apiKey: KEY, models, contextWindow: 1_048_576, protocol: "chat", contexts: Object.fromEntries(models.map((m) => [m, 1_048_576])) });
}

test("checking NanoGPT: a catalogue to search, both agents reach it directly, and the key's balance comes with the check", async () => {
  const fake = nano({ balance: 5, plan: { active: true, weeklyUsed: 2_500_000, weeklyLimit: 60_000_000 } });
  const { app } = setup(fake);
  const r = await app.services.test({ baseUrl: `${fake.base}/v1`, apiKey: KEY }); // the "/v1" a person might paste is cut off
  expect(r).toMatchObject({
    reachable: true,
    authOk: true,
    protocols: { responses: "yes", messages: "yes", chat: "yes" },
    problems: [],
    catalog: { name: "nanogpt", total: USABLE },
    funds: { balanceUsd: 5, plan: { active: true, billing: "subscription", weekly: { used: 2_500_000, limit: 60_000_000, resetAt: 1_793_664_000_000 }, daily: null, renewsAt: Date.parse("2026-11-30T00:00:00.000Z") } },
  });
  // Codex on its Responses address, Claude Code on its Messages one: no translator in between.
  expect(r.works).toEqual(expect.arrayContaining([{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }]));
  // No list of models to tick: several hundred are searched, not listed.
  expect(r.models).toEqual([]);
  // Free requests only: the public list once, the three empty POSTs, and the two reads of what the key has to spend.
  expect(fake.lists().map((s) => s.query)).toEqual(["detailed=true"]);
  expect(fake.seen.filter((s) => s.path.startsWith("/api/v1/") && s.method === "POST").map((s) => [s.path, s.body]).sort()).toEqual([
    ["/api/v1/chat/completions", "{}"],
    ["/api/v1/messages", "{}"],
    ["/api/v1/responses", "{}"],
  ]);
  expect(fake.seen.filter((s) => s.path === "/api/check-balance" || s.path === "/api/subscription/v1/usage").map((s) => [s.method, s.path, s.key])).toEqual([
    ["POST", "/api/check-balance", KEY],
    ["GET", "/api/subscription/v1/usage", KEY],
  ]);
});

test("a key NanoGPT turns down is said plainly, and nothing is read with it", async () => {
  const fake = nano();
  const { app } = setup(fake);
  const refused = await app.services.test({ baseUrl: fake.base, apiKey: "sk-nano-wrong" });
  expect(refused).toMatchObject({ reachable: true, authOk: false });
  expect(refused.problems[0]).toContain("This key was refused");
  expect(refused.funds).toBeUndefined();
  const none = await app.services.test({ baseUrl: fake.base });
  expect(none.problems).toEqual(["This server wants an API key. Paste one in the key field."]);
  // A refused or missing key is never used to ask what the account has: only the address probes saw it.
  expect(fake.seen.some((s) => s.path === "/api/check-balance" || s.path === "/api/subscription/v1/usage")).toBe(false);
});

test("searching: uncensored models first by default, the subscription's on their own, and any model by its words", async () => {
  const fake = nano();
  const { app } = setup(fake);
  const n = app.services.nanogpt;

  // Nothing typed: its uncensored models (its own category, and a heretic build it files as roleplay), the ones that
  // can run tools first and the newest of those first. One that can't run tools is still listed, last.
  const first = await n.search("");
  expect(first).toMatchObject({ name: "nanogpt", q: "", filter: "uncensored", matched: 4, total: USABLE });
  expect(first.models.map((m) => m.id)).toEqual([PICK, "gemma-4-26b-a4b-it-chimeraxheretic", IN_PLAN, "venice-uncensored"]);
  // Each row carries what the picker shows: NanoGPT's own name, the context, its price per million tokens (the cache price
  // arrives per thousand and is said per million), whether tools work and what covers it.
  expect(first.models[0]).toEqual({
    id: PICK,
    modelClass: "deepseek",
    params: null,
    contextWindow: 1_048_576,
    concurrency: null,
    gated: false,
    tools: true,
    toolsSaid: "service",
    name: "DeepSeek V4.1 Flash Uncensored",
    price: { input: 0.33, output: 1.32, cached: 0.00825 },
    inPlan: false,
    uncensored: true,
    reasoning: true,
  });

  const plan = await n.search("", "plan");
  expect(plan).toMatchObject({ filter: "plan", matched: 4 });
  expect(plan.models.map((m) => m.id)).toEqual(["gemma-4-26b-a4b-it-chimeraxheretic", IN_PLAN, "z-ai/glm-5.3-flash", "venice-uncensored"]);
  expect(plan.models.every((m) => m.inPlan)).toBe(true);

  // Typed words search every model unless a part was asked for, and each word must be in the id or the name.
  expect((await n.search("deepseek uncensored")).models.map((m) => m.id)).toEqual([PICK]);
  expect((await n.search("glm")).models.map((m) => m.id)).toEqual([IN_PLAN, "z-ai/glm-5.3-flash"]);
  expect((await n.search("Claude Opus")).models.map((m) => m.id)).toEqual(["anthropic/claude-opus-5.5"]);
  expect((await n.search("glm", "plan")).matched).toBe(2);
  // A decision model (JSON questions only) and an image model are no use to an agent: never offered at all.
  expect((await n.search("jev", "all")).matched).toBe(0);
  expect((await n.search("flux", "all")).matched).toBe(0);
  // An unknown filter is no filter: the uncensored ones with nothing typed, everything with something typed.
  expect(cleanFilter("everything", "")).toBe("uncensored");
  expect(cleanFilter(null, "glm")).toBe("all");
  // All of those were answered from one read of the list.
  expect(fake.lists()).toHaveLength(1);
});

test("a list that can't be read says so and isn't remembered, and a later failure keeps the last good list", async () => {
  const fake = nano({ listStatus: 503 });
  const { app } = setup(fake);
  const n = app.services.nanogpt;
  await expect(n.search("")).rejects.toThrow("NanoGPT's model list answered with error 503. Try again in a minute.");
  // The check says the same, with what Crosstalk needs it for, and still checks the key.
  const r = await app.services.test({ baseUrl: fake.base, apiKey: KEY });
  expect(r.catalog).toEqual({ name: "nanogpt", total: 0 });
  expect(r.problems[0]).toContain("NanoGPT's model list answered with error 503");
  fake.state.listStatus = 0;
  expect((await n.search("")).matched).toBe(4);
  // NanoGPT has a bad minute later on: the list the hub already holds goes on answering.
  fake.state.listStatus = 500;
  expect(await n.models(true)).toHaveLength(USABLE);
  expect((await n.search("glm")).matched).toBe(2);
});

test("reading a list row: prices per million, the uncensored ones by category or name, and rows an agent can't use", () => {
  expect(priceOf({ prompt: 0.33, completion: 1.32, cacheReadInputPer1kTokens: 8.25e-6, currency: "USD", unit: "per_million_tokens" })).toEqual({ input: 0.33, output: 1.32, cached: 0.00825 });
  expect(priceOf({ prompt: "0.1", completion: "0.6" })).toEqual({ input: 0.1, output: 0.6, cached: null });
  // Not dollars per million tokens, or no output price: not a price Crosstalk can use.
  expect(priceOf({ prompt: 1, completion: 2, currency: "EUR" })).toBeNull();
  expect(priceOf({ prompt: 1, unit: "per_image" })).toBeNull();
  expect(priceOf({ prompt: 1 })).toBeNull();
  const row = (over: Record<string, unknown>) => rowOf({ id: "x/model", name: "Model", context_length: 131_072, capabilities: { tool_calling: true }, pricing: { prompt: 1, completion: 2 }, category: "More", ...over });
  expect(row({})?.uncensored).toBe(false);
  expect(row({ category: "Uncensored" })?.uncensored).toBe(true);
  expect(row({ id: "x/qwen3.8-27b-abliterated" })?.uncensored).toBe(true);
  expect(row({ name: "Qwen 3.5 27B Derestricted" })?.uncensored).toBe(true);
  expect(row({ category: "Decisions" })).toBeNull();
  expect(row({ architecture: { output_modalities: ["image"] } })).toBeNull();
  expect(row({ id: "has a space" })).toBeNull();
  expect(row({ capabilities: {} })?.tools).toBe(false);
});

test("what an account has to spend: its balance and allowance, an allowance that's used up, and no subscription at all", async () => {
  const fake = nano({ balance: 12.5, plan: { active: true, weeklyUsed: 60_000_000, weeklyLimit: 60_000_000 } });
  const n = new NanoGpt();
  n.origin = fake.url;
  n.timeoutMs = 1500;
  const used = await n.fundsOf(KEY);
  // The allowance is gone: covered models are billed to the balance until it starts again.
  expect(used).toMatchObject({ balanceUsd: 12.5, plan: { active: true, billing: "paygo", weekly: { used: 60_000_000, limit: 60_000_000 } } });
  // Kept for five minutes: asking again costs NanoGPT nothing, unless it's asked for afresh.
  await n.fundsOf(KEY);
  expect(fake.seen.filter((s) => s.path === "/api/check-balance")).toHaveLength(1);
  fake.state.plan = null;
  expect(await n.fundsOf(KEY, true)).toMatchObject({ balanceUsd: 12.5, plan: null });
  // A key it refuses everywhere is said as that, with where to make a new one.
  await expect(n.fundsOf("sk-nano-wrong")).rejects.toThrow("NanoGPT refused this key");
  // An account that never subscribed answers inactive with no allowances: that is no plan, not an empty one.
  expect(planOf({ active: false, limits: { weeklyInputTokens: null }, weeklyInputTokens: null })).toBeNull();
  expect(planOf({ active: false, limits: { weeklyInputTokens: 60_000_000 }, weeklyInputTokens: { used: 0, remaining: 60_000_000 } })).toMatchObject({ active: false, weekly: { limit: 60_000_000 } });
});

test("a balance NanoGPT can't say is unknown, not nothing; the subscription is still read", async () => {
  const fake = nano({ balanceStatus: 500, plan: { active: true, weeklyUsed: 1_000, weeklyLimit: 60_000_000 } });
  const n = new NanoGpt();
  n.origin = fake.url;
  expect(await n.fundsOf(KEY)).toMatchObject({ balanceUsd: null, plan: { active: true, billing: "subscription" } });
});

test("a reply is the subscription's only for a covered model, on an active subscription billing covered models, read recently", async () => {
  const fake = nano({ plan: { active: true, weeklyUsed: 1_000, weeklyLimit: 60_000_000 } });
  let now = 1_800_000_000_000;
  const n = new NanoGpt(() => now);
  n.origin = fake.url;
  // Nothing read yet: not known, so not free.
  expect(n.covers(IN_PLAN, KEY)).toBe(false);
  await n.models();
  await n.fundsOf(KEY);
  expect(n.covers(IN_PLAN, KEY)).toBe(true);
  // A model the subscription doesn't cover is the balance's, whatever the subscription says.
  expect(n.covers(PICK, KEY)).toBe(false);
  // Another key's subscription says nothing about this one.
  expect(n.covers(IN_PLAN, "sk-nano-other")).toBe(false);
  // Half an hour later, the last read no longer says how a reply is billed.
  now += 31 * 60_000;
  expect(n.covers(IN_PLAN, KEY)).toBe(false);
  // Read again with the allowance used up: covered models are billed to the balance now.
  fake.state.plan = { active: true, weeklyUsed: 60_000_000, weeklyLimit: 60_000_000 };
  await n.fundsOf(KEY, true);
  expect(n.covers(IN_PLAN, KEY)).toBe(false);
});

test("a NanoGPT account's model menu: its saved models, each with NanoGPT's price and what covers it", async () => {
  const fake = nano();
  const { app } = setup(fake);
  const account = addNano(app, fake.base);
  const ep = app.providers.endpointOf("codex", account.id)!;
  const live = await app.services.endpointModels(ep);
  expect(live).toEqual([
    { id: PICK, contextWindow: 1_048_576, sizeBytes: null, loaded: true, tools: true, about: "$0.33 in · $1.32 out per million tokens · uncensored" },
    { id: IN_PLAN, contextWindow: 1_048_576, sizeBytes: null, loaded: true, tools: true, about: "$0.20 in · $0.80 out per million tokens · in NanoGPT's subscription · uncensored" },
  ]);
  expect(endpointModelOptions(ep, live).map((m) => [m.id, m.description])).toEqual([
    [PICK, "On NanoGPT · $0.33 in · $1.32 out per million tokens · uncensored"],
    [IN_PLAN, "On NanoGPT · $0.20 in · $0.80 out per million tokens · in NanoGPT's subscription · uncensored"],
  ]);
  // The list was read once, not once per model.
  expect(fake.lists()).toHaveLength(1);
});

test("the routes: searching NanoGPT's catalogue in one part of it, and what an account has to spend", async () => {
  const fake = nano({ balance: 0.5 });
  const { app } = setup(fake);
  const server = startServer(app);
  cleanups.push(() => void server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
  const call = async (path: string) => {
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${device.token}` } });
    return { status: r.status, body: (await r.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const plan = await call("/api/services/catalog?name=nanogpt&q=&filter=plan");
  expect(plan.status).toBe(200);
  expect(plan.body).toMatchObject({ name: "nanogpt", filter: "plan", matched: 4 });
  expect((await call("/api/services/catalog?name=nanogpt&q=deepseek")).body.models.map((m: { id: string }) => m.id)).toEqual([PICK]);
  expect((await call("/api/services/catalog?name=somewhere")).status).toBe(400);

  const account = addNano(app, fake.base);
  const funds = await call(`/api/accounts/codex/${account.id}/funds`);
  expect(funds.status).toBe(200);
  expect(funds.body).toMatchObject({ balanceUsd: 0.5, plan: null, checkedAt: expect.any(Number) });
  // Any other account has no NanoGPT balance to read.
  expect((await call("/api/accounts/codex/default/funds")).status).toBe(404);
  // A key NanoGPT no longer takes says so, in its own words.
  app.providers.setEndpointAccount("codex", { label: "Old NanoGPT", baseUrl: fake.base, apiKey: "sk-nano-revoked", models: [PICK], contextWindow: 1_048_576, protocol: "chat" });
  const old = app.providers.accounts().find((a) => a.label === "Old NanoGPT")!;
  const refused = await call(`/api/accounts/codex/${old.id}/funds`);
  expect(refused.status).toBe(502);
  expect(refused.body.error).toContain("NanoGPT refused this key");
});

test("Costs: a NanoGPT reply is priced at NanoGPT's own price, its cached input at the cache price", async () => {
  const { app } = setup();
  // A list this hub already kept (prices.ts never fetches in a test hub). An uncensored build is on no other list.
  app.store.kvSet("prices.cache", JSON.stringify({ "models.dev": { fetchedAt: Date.now(), table: {} }, nanogpt: { fetchedAt: Date.now(), table: { [PICK]: [0.33, 1.32, 0.00825] } } }));
  app.store.kvSet("accounts", JSON.stringify([{ provider: "codex", id: "nano", label: "NanoGPT", kind: "endpoint", baseUrl: "https://nano-gpt.com/api", models: [PICK], protocol: "chat" }]));
  const tokens = { inputTokens: 20_000_000, outputTokens: 500_000, cachedTokens: 19_400_000 };
  const priced = app.spend.priceReply({ provider: "codex", account: "nano", model: PICK, ...tokens });
  expect(priced).toEqual({ costUsd: priceTokens([0.33, 1.32, 0.00825], tokens.inputTokens, tokens.outputTokens, tokens.cachedTokens), basis: "estimated" });
  // 0.6M new input at $0.33, 19.4M cached at $0.00825, 0.5M out at $1.32: about $1.02.
  expect(priced.costUsd).toBeCloseTo(0.198 + 0.16005 + 0.66, 6);
});

test("Costs: a reply NanoGPT's subscription covered is the plan's, and one on the balance is priced", async () => {
  const fake = nano({ plan: { active: true, weeklyUsed: 1_000, weeklyLimit: 60_000_000 } });
  const { app, dir } = setup(fake);
  // What the hub knows before the reply ends: the list, and the account's subscription (read when Settings showed it) —
  // read here from the stand-in. The account itself is on NanoGPT's real address, because a stand-in on 127.0.0.1 is a
  // model server on this machine to the ledger, whose replies are free; nothing below asks NanoGPT anything.
  await app.services.nanogpt.models();
  await app.services.nanogpt.fundsOf(KEY);
  app.services.nanogpt.origin = NANOGPT_ORIGIN;
  const account = addNano(app, NANOGPT_BASE_URL);
  const reply = (model: string) => {
    const room = app.chats.create({ provider: "codex", name: "Uncensored work", cwd: dir, account: account.id, model });
    const member = app.chats.member(room.id)!;
    app.spend.recordTurn(room, member, { id: `t-${model}` } as Turn, { inputTokens: 100_000, outputTokens: 2_000, cachedInputTokens: 90_000, costUsd: null });
  };
  reply(IN_PLAN);
  reply(PICK);
  const rows = app.store.db.query("SELECT model, cost_usd AS cost, basis FROM spend_ledger ORDER BY id").all() as { model: string; cost: number | null; basis: string }[];
  // Covered: nothing came off the balance, and no limit counts it. Not covered: priced, or unknown in a hub with no price
  // list — never called free.
  expect(rows[0]).toEqual({ model: IN_PLAN, cost: 0, basis: "plan" });
  expect(rows[1].model).toBe(PICK);
  expect(rows[1].basis).not.toBe("plan");
});
