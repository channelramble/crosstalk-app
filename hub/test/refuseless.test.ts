// Refuseless (api.refuseless.com) as an AI service: its abliterated models offered first with their names and prices,
// Crosstalk's own agent as the one that runs it, what the account has left to spend, how a refused key differs from
// Cloudflare's browser check, and how its replies are counted in Costs. Everything here runs against the stand-in
// Refuseless on a loopback port (fixtures/fake-refuseless.ts): no key of the user's, no model request, and nothing
// reaches the real service.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceModelPick, serviceModelsKept } from "@crosstalk/shared";
import { App } from "../src/app";
import { priceTokens } from "../src/prices";
import { REFUSELESS_MODELS, REFUSELESS_ORIGIN, Refuseless, challengeWords, refuselessAbout, refuselessOrder, refuselessPrice } from "../src/refuseless";
import { endpointModelOptions } from "../src/serviceProbes";
import { startServer } from "../src/server";
import { fakeRefuseless } from "./fixtures/fake-refuseless";

const KEY = "abl_test_key_0001";
const PICK = "deepseek-v4.1-flash-abliterated";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function refuseless(o: Parameters<typeof fakeRefuseless>[0] = {}) {
  const fake = fakeRefuseless({ key: KEY, ...o });
  cleanups.push(() => fake.stop());
  return fake;
}

/** A hub whose Refuseless is the stand-in; without one, Refuseless stays what test/preload.ts set (a closed port). */
function setup(fake?: { url: string }) {
  const dir = mkdtempSync(join(tmpdir(), "ct-refuseless-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  if (fake) app.services.refuseless.origin = fake.url;
  cleanups.push(async () => {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, dir };
}

/** The account the Add sheet saves for Refuseless (web/src/services.ts saveBody): Crosstalk's own agent, on its chat address. */
function addRefuseless(app: App, baseUrl: string, models = [PICK, "glm-5.3-abliterated"], apiKey = KEY, label = "Refuseless") {
  return app.providers.setEndpointAccount("builtin", { label, baseUrl, apiKey, models, contextWindow: 1_048_576, protocol: "chat", contexts: Object.fromEntries(models.map((m) => [m, 1_048_576])) });
}

test("checking Refuseless: OpenCode first, the abliterated models first with their names and prices, and the credit with the check", async () => {
  const fake = refuseless({ credits: { balance: 42.5, reserved: 1.2 } });
  const { app } = setup(fake);
  const r = await app.services.test({ baseUrl: `${fake.base}/v1`, apiKey: KEY }); // the "/v1" its docs give is cut off
  expect(r).toMatchObject({ reachable: true, authOk: true, protocols: { responses: "yes", messages: "yes", chat: "yes" }, problems: [] });
  expect(r.works.slice(0, 2)).toEqual([{ provider: "opencode", via: "chat" }, { provider: "builtin", via: "chat" }]);
  // In the lineup's order, not the order the service sent them: its best coding model first, the stock ones last.
  expect(r.models.map((m) => m.id)).toEqual([PICK, "glm-5.3-abliterated", "glm-5.3-flash-abliterated", "deepseek-v4.1-flash-fast", "minimax-m3.1-flash"]);
  expect(r.models[0]).toEqual({ id: PICK, contextWindow: 1_048_576, name: "DeepSeek V4.1 Flash 1017 Abliterated", price: { input: 0.12, output: 0.45, cached: 0.025 }, uncensored: true });
  expect(r.models.at(-1)).toMatchObject({ id: "minimax-m3.1-flash", uncensored: false });
  // What is left to spend is what a new request can still reserve; what running replies hold is said apart.
  expect(r.funds).toEqual({ balanceUsd: 41.3, heldUsd: 1.2, plan: null, checkedAt: expect.any(Number) });
  // Added with its uncensored models ticked, best first; the makers' own weights are there to tick by hand.
  expect(serviceModelPick(serviceModelsKept(r.models))).toEqual([PICK, "glm-5.3-abliterated", "glm-5.3-flash-abliterated"]);
  // The key only ever went to the stand-in, as a Bearer token.
  expect(fake.seen.length).toBeGreaterThan(0);
  expect(fake.seen.every((s) => s.key === KEY)).toBe(true);
});

test("a key Refuseless refuses is said as the key; Cloudflare's browser check answering instead is said as that, not the key", async () => {
  const fake = refuseless();
  const { app } = setup(fake);
  const bad = await app.services.test({ baseUrl: fake.base, apiKey: "abl_wrong" });
  expect(bad).toMatchObject({ reachable: true, authOk: false });
  expect(bad.problems[0]).toContain("This key was refused");
  expect(bad.funds).toBeUndefined();

  fake.state.challenge = true;
  const walled = await app.services.test({ baseUrl: fake.base, apiKey: KEY });
  expect(walled.reachable).toBe(true);
  // Every address answered 403 — but it was Cloudflare's page, so nothing is known about the key.
  expect(walled.authOk).toBeNull();
  expect(walled.problems).toEqual([challengeWords("Refuseless")]);
  expect(walled.problems[0]).toContain("your key wasn't tried");

  // A wrong key that Refuseless itself turned down (401) stays refused, whatever the balance read met.
  fake.state.challenge = ["/v1/credits"];
  const wrong = await app.services.test({ baseUrl: fake.base, apiKey: "abl_wrong" });
  expect(wrong).toMatchObject({ authOk: false });
  expect(wrong.problems[0]).toContain("This key was refused");
  // A key the list was read with works, even when the balance read then met the check: it's only the balance missing.
  const listed = await app.services.test({ baseUrl: fake.base, apiKey: KEY });
  expect(listed).toMatchObject({ authOk: true, problems: [] });
  expect(listed.funds).toBeUndefined();
  // The probes walled off but the balance read with the key: the key works, and it's the check that is said.
  fake.state.challenge = ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages", "/props", "/api/v0/models", "/api/ps"];
  const half = await app.services.test({ baseUrl: fake.base, apiKey: KEY });
  expect(half).toMatchObject({ authOk: true, funds: { balanceUsd: 41.3 } });
  expect(half.problems).toEqual([expect.stringContaining("Your key works (it read your balance), but Refuseless's Cloudflare check answered")]);
});

test("an account whose model list meets Cloudflare's check says so, not that the key was refused", async () => {
  const fake = refuseless({ challenge: ["/v1/models"] });
  const { app } = setup(fake);
  const account = addRefuseless(app, fake.base);
  await expect(app.services.endpointModels(app.providers.endpointOf("builtin", account.id)!)).rejects.toThrow(challengeWords("Refuseless"));
});

test("the credit read: remembered for five minutes per key, a refused key and Cloudflare's check said plainly", async () => {
  const fake = refuseless({ credits: { balance: 10, reserved: 0 } });
  let now = 1_000_000;
  const r = new Refuseless(() => now);
  r.origin = fake.url;
  expect(await r.fundsOf(KEY)).toEqual({ balanceUsd: 10, heldUsd: null, plan: null, checkedAt: 1_000_000 });
  fake.state.credits = { balance: 7.5, reserved: 0.25 };
  expect((await r.fundsOf(KEY)).balanceUsd).toBe(10);
  now += 5 * 60_000;
  expect(await r.fundsOf(KEY)).toMatchObject({ balanceUsd: 7.25, heldUsd: 0.25 });
  expect(fake.seen.filter((s) => s.path === "/v1/credits")).toHaveLength(2);
  await expect(r.fundsOf("abl_wrong")).rejects.toThrow("Refuseless refused this key");
  await expect(r.fundsOf("")).rejects.toThrow("has no key");
  fake.state.challenge = true;
  await expect(r.fundsOf(KEY, true)).rejects.toThrow("Cloudflare check answered instead of its API");
  // Cloudflare's other pages (a server that timed out) aren't its browser check, and are said as what they are.
  const timedOut = refuseless({ htmlError: { path: "/v1/credits", status: 522 } });
  r.origin = timedOut.url;
  await expect(r.fundsOf(KEY, true)).rejects.toThrow("Refuseless answered with a web page (error 522) instead of its API");
  // Only its own address, or the real one when nothing replaced it, counts as Refuseless.
  expect(r.serves(timedOut.base)).toBe(true);
  expect(r.serves(fake.base)).toBe(false);
  expect(r.serves("https://api.refuseless.com")).toBe(false);
  const real = new Refuseless();
  real.origin = REFUSELESS_ORIGIN;
  expect(real.serves("https://api.refuseless.com/v1")).toBe(true);
  expect(real.serves("https://refuseless.example")).toBe(false);
});

test("the lineup as the hub knows it: prices per million, the best coding model first, newer models after in the service's order", () => {
  expect(refuselessPrice(PICK)).toEqual([0.12, 0.45, 0.025]);
  expect(refuselessPrice("GLM-5.3-Abliterated")).toEqual([1, 2, 0.15]);
  expect(refuselessPrice("some-new-model")).toBeNull();
  expect(refuselessOrder([{ id: "zeta-new" }, { id: "minimax-m3.1-flash" }, { id: "alpha-new" }, { id: PICK }]).map((m) => m.id)).toEqual([PICK, "minimax-m3.1-flash", "zeta-new", "alpha-new"]);
  expect(refuselessAbout(PICK)).toBe("$0.12 in · $0.45 out per million tokens · uncensored");
  // What the service's own list says about a model wins over the page's word for it.
  expect(refuselessAbout("some-new-model", true)).toBe("uncensored");
  expect(refuselessAbout("deepseek-v4.1-flash-fast")).toBe("$0.01 in · $0.08 out per million tokens");
  // Every model the page lists is priced, and the abliterated ones come before the stock ones.
  const rows = Object.values(REFUSELESS_MODELS);
  expect(rows.every((m) => m.price.input > 0 && m.price.output > 0)).toBe(true);
  expect(rows.findIndex((m) => !m.uncensored)).toBe(rows.filter((m) => m.uncensored).length);
});

test("a Refuseless account's model menu says each model's price and that it is uncensored, and its funds route answers its credit", async () => {
  const fake = refuseless({ credits: { balance: 3, reserved: 0 } });
  const { app } = setup(fake);
  const account = addRefuseless(app, fake.base);
  const ep = app.providers.endpointOf("builtin", account.id)!;
  const live = await app.services.endpointModels(ep);
  expect(live?.slice(0, 2)).toEqual([
    { id: PICK, contextWindow: 1_048_576, sizeBytes: null, loaded: false, tools: null, uncensored: true, efforts: ["off", "low", "high", "max"], defaultEffort: "high", about: "$0.12 in · $0.45 out per million tokens · uncensored" },
    { id: "glm-5.3-abliterated", contextWindow: 1_048_576, sizeBytes: null, loaded: false, tools: null, uncensored: true, about: "$1 in · $2 out per million tokens · uncensored" },
  ]);
  expect(endpointModelOptions(ep, live).slice(0, 2).map((m) => [m.id, m.description])).toEqual([
    [PICK, "On Refuseless · $0.12 in · $0.45 out per million tokens · uncensored"],
    ["glm-5.3-abliterated", "On Refuseless · $1 in · $2 out per million tokens · uncensored"],
  ]);

  const server = startServer(app);
  cleanups.push(() => void server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
  const call = async (path: string) => {
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${device.token}` } });
    return { status: r.status, body: (await r.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const funds = await call(`/api/accounts/builtin/${account.id}/funds`);
  expect(funds.status).toBe(200);
  expect(funds.body).toMatchObject({ balanceUsd: 3, heldUsd: null, plan: null });
  const old = addRefuseless(app, fake.base, [PICK], "abl_revoked", "Old Refuseless");
  const refused = await call(`/api/accounts/builtin/${old.id}/funds`);
  expect(refused.status).toBe(502);
  expect(refused.body.error).toContain("Refuseless refused this key");
  expect((await call("/api/accounts/codex/default/funds")).status).toBe(404);
});

test("Costs: a Refuseless reply is priced at Refuseless's own price, its cached input at the cache price", () => {
  const { app } = setup();
  app.store.kvSet("prices.cache", JSON.stringify({ "models.dev": { fetchedAt: Date.now(), table: {} } }));
  app.store.kvSet("accounts", JSON.stringify([{ provider: "builtin", id: "rl", label: "Refuseless", kind: "endpoint", baseUrl: "https://api.refuseless.com", models: [PICK], protocol: "chat" }]));
  const tokens = { inputTokens: 20_000_000, outputTokens: 500_000, cachedTokens: 19_400_000 };
  const priced = app.spend.priceReply({ provider: "builtin", account: "rl", model: PICK, ...tokens });
  expect(priced).toEqual({ costUsd: priceTokens([0.12, 0.45, 0.025], tokens.inputTokens, tokens.outputTokens, tokens.cachedTokens), basis: "estimated" });
  // 0.6M new input at $0.12, 19.4M cached at $0.025, 0.5M out at $0.45: about $0.78.
  expect(priced.costUsd).toBeCloseTo(0.072 + 0.485 + 0.225, 6);
  // The same model id on any other service isn't priced from Refuseless's page.
  app.store.kvSet("accounts", JSON.stringify([{ provider: "builtin", id: "rl", label: "Elsewhere", kind: "endpoint", baseUrl: "https://elsewhere.example", models: [PICK], protocol: "chat" }]));
  expect(app.spend.priceReply({ provider: "builtin", account: "rl", model: PICK, ...tokens }).basis).toBe("unknown");
});
