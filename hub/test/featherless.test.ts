// Featherless (featherless.ai) as an AI service: finding a model among the 22,000 it serves, what each one means for a
// chat (its size, its context, whether tool calls work, whether it is gated, its price), which plan a key is on and what
// Crosstalk says and books because of it, and its refusals in plain words. Everything here runs against the stand-in
// Featherless on a loopback port (fixtures/fake-featherless.ts): no key of the user's, no inference request, and nothing
// reaches the real service (the one test that books replies on its real address fails on any request to it).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLimitHit } from "../src/agents/limits";
import { planLabel } from "@crosstalk/shared";
import { App } from "../src/app";
import { CHAT_PLAN_ID, CONTEXT_CAP, DEVELOPER_PLAN_ID, Featherless, KeyRefused, chatNotice, paramsOf, planFrom, planKind, priceOfRow, toolsByDocs } from "../src/featherless";
import { endpointModelOptions } from "../src/serviceProbes";
import { serviceRoutes } from "../src/services";
import { BLOCKED_MODEL, BUSY_MODEL, CHAT_PLAN, DEVELOPER_PLAN, FEATHER_MODELS, fakeFeatherless } from "./fixtures/fake-featherless";

const KEY = "rc_featherless_test_key_0001";
/** The model most of these tests use (32K, class qwen3.5-27b, 2 concurrent units). */
const PICK = "huihui-ai/Huihui-Qwen3.5-27B-abliterated";
/** The models the stand-in has deployed (one of its rows isn't). */
const ACTIVE = FEATHER_MODELS.filter((m) => !m.inactive).length;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function feather(o: Parameters<typeof fakeFeatherless>[0] = {}) {
  const fake = fakeFeatherless({ key: KEY, ...o });
  cleanups.push(() => fake.stop());
  return fake;
}

/**
 * A hub whose Featherless is the stand-in: both the catalogue searches and "is this Featherless?" follow that address.
 * Without one, the address stays what test/preload.ts set (a closed port), for the tests that ask the service nothing.
 */
function setup(fake?: { url: string }) {
  const dir = mkdtempSync(join(tmpdir(), "ct-feather-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  if (fake) app.services.catalog.origin = fake.url;
  cleanups.push(async () => {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return app;
}

/** The account the Add sheet saves for Featherless (web/src/services.ts saveBody), with the adapter's address to reach it by. */
function addFeatherless(app: App, baseUrl: string, over: Record<string, unknown> = {}) {
  const account = app.providers.setEndpointAccount("codex", {
    label: "Featherless",
    baseUrl,
    apiKey: KEY,
    models: [PICK],
    contextWindow: 32_768,
    protocol: "chat",
    contexts: { [PICK]: 32_768 },
    ...over,
  });
  return { account, via: app.adapter.urlFor("codex", account.id)! };
}

const codexRequest = (over: Record<string, unknown> = {}) => ({
  model: PICK,
  instructions: "You are Codex, a coding agent.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "List the files." }] }],
  tools: [{ type: "function", name: "shell", description: "Runs a shell command", parameters: { type: "object", properties: {} } }],
  stream: true,
  ...over,
});

const post = (via: { baseUrl: string; key: string }, body: unknown) =>
  fetch(`${via.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${via.key}`, "content-type": "application/json" }, body: JSON.stringify(body) });

async function readSse(res: Response) {
  const events: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const block of (await res.text()).split("\n\n")) {
    const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
    if (data) events.push(JSON.parse(data));
  }
  return events;
}

test("checking Featherless: it lists a catalogue to search instead of models to tick, and the check stays free", async () => {
  const fake = feather();
  const app = setup(fake);
  const r = await app.services.test({ baseUrl: `${fake.url}/v1`, apiKey: KEY }); // the sheet's "/v1" is cut off
  // Chat Completions only: its docs give /v1/chat/completions and /v1/completions, so Codex goes through the adapter.
  expect(r).toMatchObject({
    reachable: true,
    authOk: true,
    server: null,
    protocols: { responses: "no", messages: "no", chat: "yes" },
    works: [{ provider: "codex", via: "adapter" }],
    problems: [],
    catalog: { name: "featherless", total: ACTIVE },
  });
  // No model list comes back: 22,000 models are searched, not listed (the whole list is about 7 MB).
  expect(r.models).toEqual([]);
  // One bounded read of the list — `page=1` holds the service to 100 rows, `status=active` leaves out models that
  // aren't deployed — and the usual three empty POSTs, which run nothing.
  expect(fake.lists().map((s) => s.query)).toEqual(["status=active&page=1&per_page=100"]);
  expect(fake.seen.filter((s) => s.method === "POST").map((s) => [s.path, JSON.stringify(s.body)]).sort()).toEqual([
    ["/v1/chat/completions", "{}"],
    ["/v1/messages", "{}"],
    ["/v1/responses", "{}"],
  ]);
  expect(fake.seen.every((s) => s.method === "GET" || JSON.stringify(s.body) === "{}")).toBe(true);
});

test("searching the catalogue: the facts beside each name, and a model found by part of its name", async () => {
  const fake = feather();
  const app = setup(fake);
  // With nothing typed, the service's own uncensored models (training=abliterated), best first: the ones an agent can
  // use come before the ones it can't, and the bigger model before the smaller.
  // (The rows come back in the service's own order, as the real page has them: the ranking is what decides this list,
  // not the order the stand-in holds them in — see fixtures/fake-featherless.ts.)
  const suggested = await app.services.catalog.search("");
  expect(suggested.models.map((m) => m.id)).toEqual([
    "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
    PICK,
    "huihui-ai/Huihui-Qwen3-8B-abliterated-v2",
    "wangzhang/gemma-4-31B-it-abliterated",
    "mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated",
  ]);
  expect(suggested).toMatchObject({ name: "featherless", q: "", matched: 5, total: ACTIVE });
  // The models the docs cover come first, and the test's model is among the shortlist with nothing typed at all.
  expect(suggested.models.slice(0, 3).every((m) => m.tools)).toBe(true);
  expect(suggested.models.map((m) => m.id)).toContain(PICK);
  // Each row is the handful of facts a phone shows, and nothing else: the size from the class, the context, what one
  // request reserves of the plan's 4, whether it is gated, whether tool calls work, and what it costs per million tokens
  // on the Developer plan (the list has no cached-input price, so none is claimed).
  expect(suggested.models.find((m) => m.id === PICK)).toEqual({ id: PICK, modelClass: "qwen3.5-27b", params: 27, contextWindow: 32_768, concurrency: 2, gated: false, tools: true, toolsSaid: "docs", price: { input: 0.3, output: 2.4, cached: null } });
  // Each model at its own price: a finetune can cost four times its family's usual rate.
  expect(suggested.models[0]).toMatchObject({ id: "OBLITERATUS/Qwen3.8-27B-OBLITERATED", price: { input: 1.6, output: 12, cached: null } });
  // A family the docs don't name, whose row says `features.tool_use: true` all the same: Crosstalk still goes by the
  // docs, and says where that stands, so the words can be "not promised" rather than "it can't".
  expect(suggested.models.find((m) => m.id === "wangzhang/gemma-4-31B-it-abliterated")).toMatchObject({ tools: false, toolsSaid: "list" });
  // One the list says nothing about keeps the docs' own answer.
  expect((await app.services.catalog.search("Embedding")).models[0]).toMatchObject({ tools: false, toolsSaid: "docs" });
  // Typing part of a name: the service searches, and an exact match comes first.
  const found = await app.services.catalog.search("huihui-qwen3.5-27b");
  expect(found.models.map((m) => m.id)).toEqual([PICK]);
  expect(found.matched).toBe(1);
  // A broader search: the ones an agent can work with first (the roomiest of those first, then the closest name), and
  // a model that can't hold a conversation at all last.
  expect((await app.services.catalog.search("qwen3")).models.map((m) => m.id)).toEqual([
    "Qwen/Qwen3-235B-A22B",
    "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
    PICK,
    "huihui-ai/Huihui-Qwen3-8B-abliterated-v2",
    "Qwen/Qwen3-Embedding-8B",
  ]);
  // Nothing matched is an answer, not a failure: the app's words say what to try instead.
  expect(await app.services.catalog.search("nothinglikethis")).toMatchObject({ models: [], matched: 0 });
  // A model that isn't deployed isn't offered, whatever its name says.
  expect((await app.services.catalog.search("99B")).models).toEqual([]);
});

test("the same search twice costs one request, and a search that failed isn't remembered", async () => {
  const fake = feather();
  const app = setup(fake);
  await app.services.catalog.search("qwen3");
  await app.services.catalog.search("qwen3");
  await app.services.catalog.search(" qwen3 "); // the same query, tidied
  // Two reads: the search itself, and the one that says how big the catalogue is (kept for a day).
  expect(fake.lists().map((s) => s.query)).toEqual(["status=active&page=1&per_page=100&q=qwen3", "status=active&page=1&per_page=100"]);
  await app.services.catalog.search("kimi");
  expect(fake.lists()).toHaveLength(3);
  // Asked at the same moment, the same query is still one request.
  const together = await Promise.all([app.services.catalog.search("llama"), app.services.catalog.search("llama")]);
  expect(together[0].models).toEqual(together[1].models);
  expect(fake.lists()).toHaveLength(4);

  // A search that failed leaves nothing behind: the next one asks again rather than repeating the error for ten minutes.
  const broken = feather({ listStatus: 503 });
  const app2 = setup(broken);
  await expect(app2.services.catalog.search("qwen3")).rejects.toThrow("error 503");
  await expect(app2.services.catalog.search("qwen3")).rejects.toThrow("error 503");
  expect(broken.lists().length).toBeGreaterThanOrEqual(4); // two searches and two size reads, none of them kept
});

test("a key Featherless turns down is said plainly, and its public list still answers", async () => {
  const fake = feather();
  const app = setup(fake);
  const bad = await app.services.test({ baseUrl: fake.url, apiKey: "rc_not_a_key" });
  // Its model list needs no key, so the catalogue is still there to search; what the service *speaks* is what stays
  // unknown, because every address answered 401. The sheet stops its lines at "Key refused" (web/src/services.ts).
  // Its addresses are the same whoever asks (the ones it hasn't got answer 404 with or without a key), so only the key
  // itself is in question here.
  expect(bad).toMatchObject({ reachable: true, authOk: false, protocols: { responses: "no", messages: "no", chat: "yes" }, catalog: { name: "featherless", total: ACTIVE } });
  expect(bad.problems).toEqual([`This key was refused. Check that you copied all of it, and that it is for 127.0.0.1:${fake.port}.`]);
  // No key at all says how to get past it, and the key the account saved works.
  expect((await app.services.test({ baseUrl: fake.url })).problems).toEqual(["This server wants an API key. Paste one in the key field."]);
  const { account } = addFeatherless(app, fake.url);
  expect(await app.services.test({ baseUrl: "", accountId: account.id })).toMatchObject({ authOk: true, works: [{ provider: "codex", via: "adapter" }] });
});

test("a catalogue that can't be read says so, instead of saying the service lists no models", async () => {
  const fake = feather({ listStatus: 500 });
  const app = setup(fake);
  const r = await app.services.test({ baseUrl: fake.url, apiKey: KEY });
  // Still a catalogue service, with nothing counted: the app shows the search box (and its Try again) rather than
  // asking for a model name to be typed out of 22,406 by hand.
  expect(r.catalog).toEqual({ name: "featherless", total: 0 });
  expect(r.models).toEqual([]);
  expect(r.problems).toEqual(["Featherless's model list answered with error 500. Try again in a minute. Crosstalk needs its model list to find a model for you."]);
  // The service itself answered, so what it can run is still known: the model is the only thing missing.
  expect(r).toMatchObject({ reachable: true, works: [{ provider: "codex", via: "adapter" }] });
});

test("the whole catalogue is never held: an answer bigger than one page is dropped", async () => {
  // Said in the answer's own content-length.
  const sized = feather({ flood: true });
  await expect(setup(sized).services.catalog.search("qwen3")).rejects.toThrow("far more than Crosstalk asked for");
  // And when nothing says how big it is, which is what a chunked or compressed 7 MB answer looks like: then only
  // reading it finds out, so the guard that counts the pieces is the one that has to stop it.
  const streamed = feather({ floodStream: true });
  await expect(setup(streamed).services.catalog.search("qwen3")).rejects.toThrow("far more than Crosstalk asked for");
  expect(streamed.lists().length).toBeGreaterThan(0);
});

test("which models can run tools is Featherless's own documented rule, and the size comes from the class", () => {
  // featherless.ai/docs/tool-calling: "function calling is natively supported on the following model families:
  // moonshotai/Kimi-K2-Instruct, Qwen 3 family".
  for (const yes of ["qwen3-32b", "qwen3.5-27b", "qwen3_5moe-35b", "qwen3vl-8b", "qwen3next-80b", "qwen38-2400b", "kimi-k2", "kimi-k25"]) expect(toolsByDocs(yes)).toBe(true);
  // Everything else: tool calls there only work through prompting and JSON, which an agent doesn't do.
  for (const no of ["llama33-70b", "gemma4-31b", "mistral-24b", "deepseek4-671b", "kimi3-2780b", "k2-horizon-375b", "glm52-355b", "qwen2.5-72b", ""]) expect(toolsByDocs(no)).toBe(false);
  // Nor a model that holds no conversation at all, whatever family it is from.
  for (const no of ["qwen3-embedding-8b", "qwen3-tts-1b7"]) expect(toolsByDocs(no)).toBe(false);
  expect([paramsOf("qwen3.5-27b"), paramsOf("qwen3-0b6"), paramsOf("k2-horizon-5b1"), paramsOf("qwen38-2400b"), paramsOf("rwkv5-7b"), paramsOf("kimi-k2"), paramsOf(null)]).toEqual([27, 0.6, 5.1, 2400, 7, null, null]);
});

test("an account's models keep their facts: the catalogue is asked by name, and a model that can't run tools is marked", async () => {
  const fake = feather();
  const app = setup(fake);
  const { account } = addFeatherless(app, fake.url, {
    models: [PICK, "wangzhang/gemma-4-31B-it-abliterated", "Qwen/Qwen3-235B-A22B", "moonshotai/Kimi-K2-Instruct"],
    // The last model has no saved size at all: a name typed into Settings → Accounts, or added to the list later, never
    // went through the Add sheet (web/src/services.ts capContext), so the plan's limit has to hold here too.
    contexts: { [PICK]: 32_768, "wangzhang/gemma-4-31B-it-abliterated": 32_768, "Qwen/Qwen3-235B-A22B": 32_768 },
  });
  const catalog = await app.providers.models("codex", account.id);
  // Each saved model asked for by name (a tiny answer each), never the catalogue: four searches, and the size read.
  expect(fake.lists().filter((s) => s.query.includes("&q=")).length).toBe(4);
  expect(catalog.models.map((m) => [m.id, m.contextWindow, m.noTools ?? false])).toEqual([
    [PICK, 32_768, false],
    // Its family isn't one Featherless documents for tool calls, so an agent on it couldn't read a file: marked, and
    // the pickers say so before a chat starts (web/src/newChat.ts noToolsWords).
    ["wangzhang/gemma-4-31B-it-abliterated", 32_768, true],
    // The model could hold 262k, but the plan reads 32k at once: what the account was saved with is what a chat gets.
    ["Qwen/Qwen3-235B-A22B", 32_768, false],
    // 131k of its own, nothing saved for it, and still only what the plan reads at once.
    ["moonshotai/Kimi-K2-Instruct", CONTEXT_CAP, false],
  ]);
  // An account with no size saved anywhere (one added under "Add a custom model", say) still reads only what the plan
  // serves at once, and one that was given a bigger figure by hand keeps it (Featherless's Developer plan reads 256K).
  const bare = addFeatherless(app, fake.url, { label: "Featherless (bare)", models: ["Qwen/Qwen3-235B-A22B"], contextWindow: null, contexts: {} });
  expect((await app.providers.models("codex", bare.account.id)).models.map((m) => m.contextWindow)).toEqual([CONTEXT_CAP]);
  const bigger = addFeatherless(app, fake.url, { label: "Featherless (developer)", models: ["Qwen/Qwen3-235B-A22B"], contextWindow: 131_072, contexts: {} });
  expect((await app.providers.models("codex", bigger.account.id)).models.map((m) => m.contextWindow)).toEqual([131_072]);

  // Nothing marked when the catalogue can't be asked at all: the saved names stand (the same as any other service).
  const saved = endpointModelOptions({ label: "Featherless", models: [PICK], contextWindow: 32_768 }, null)[0];
  expect([saved.id, saved.contextWindow]).toEqual([PICK, 32_768]);
  expect(saved.noTools).toBeUndefined();
});

test("a gated model says to agree to its licence, not that the key was refused", async () => {
  const fake = feather();
  const app = setup(fake);
  // Gated models are marked where they're picked, because every request for one is refused until the licence is agreed.
  expect((await app.services.catalog.search("Llama-3.3-70B")).models[0]).toMatchObject({ id: "meta-llama/Llama-3.3-70B-Instruct", gated: true, tools: false });
  const { via } = addFeatherless(app, fake.url, { models: ["meta-llama/Llama-3.3-70B-Instruct"] });
  const failed = (await readSse(await post(via, codexRequest({ model: "meta-llama/Llama-3.3-70B-Instruct" })))).at(-1)!;
  expect(failed.type).toBe("response.failed");
  expect(failed.response.error.message).toBe("Featherless won't run meta-llama/Llama-3.3-70B-Instruct until you agree to that model's licence on Featherless's own website. Open the model there, agree, then try again.");
  // Codex is told to stop rather than try again: nothing changes until the person agrees to the licence.
  expect(failed.response.error.code).toBe("invalid_prompt");

  // The same 403 for a model the plan doesn't include (available_on_current_plan: false) says that instead, because
  // neither refusal is anything to do with the key.
  const big = addFeatherless(app, fake.url, { label: "Featherless (big)", models: ["moonshotai/Kimi-K2.5-Instruct"] });
  const offPlan = (await readSse(await post(big.via, codexRequest({ model: "moonshotai/Kimi-K2.5-Instruct" })))).at(-1)!;
  expect(offPlan.response.error.message).toBe("Featherless (big) says moonshotai/Kimi-K2.5-Instruct isn't included in your plan. Pick another model in Settings → AI services, or change your plan with Featherless (big).");

  // Only the service's own answer can say those things. A 403 from something in between — a proxy's HTML block page
  // that happens to say "not available" and link to a page with "plan" in it — is a key or a network problem, and says
  // so, instead of sending someone to the model picker over it.
  const proxied = addFeatherless(app, fake.url, { label: "Featherless (proxied)", models: [BLOCKED_MODEL] });
  const blocked = (await readSse(await post(proxied.via, codexRequest({ model: BLOCKED_MODEL })))).at(-1)!;
  expect(blocked.response.error.message).toBe("Featherless (proxied) refused this key. Paste a working key in Settings → AI services, then try again.");
});

test("the plan's four-at-a-time refusal says what to wait for, and a reply still runs through the adapter", async () => {
  const fake = feather();
  const app = setup(fake);
  const { via } = addFeatherless(app, fake.url);
  // An ordinary reply: the chat lane, the agent's own tools, and the real key never leaving the hub.
  const events = await readSse(await post(via, codexRequest()));
  expect(events.at(-1)?.type).toBe("response.completed");
  expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta)).toEqual(["Hello", " world"]);
  expect(fake.lastChat()).toMatchObject({ model: PICK, stream: true, tools: [{ type: "function", function: { name: "shell" } }] });
  expect(fake.seen.at(-1)?.auth).toBe(`Bearer ${KEY}`);
  expect(via.key).not.toContain(KEY);

  // More requests at once than the plan's concurrent units allow: a 429 that is nothing to do with a usage window, so
  // the words say what to wait for (featherless.ai/docs/concurrency-limits).
  const busy = (await readSse(await post(via, codexRequest({ model: BUSY_MODEL })))).at(-1)!;
  expect(busy.type).toBe("response.failed");
  expect(busy.response.error.code).toBe("rate_limit_exceeded"); // the agent may still try again by itself
  expect(busy.response.error.message).toBe("Featherless is already running as many requests at once as your plan allows. Wait for one of your other chats or asks to finish. Try again in 20 seconds.");
  // And when Codex gives up on its own retries, the hub reads that short wait back out of the words. Without a time in
  // them it would treat this as a window it can't see and leave the reply waiting five minutes (engine.ts BACKOFF_MS)
  // for a refusal that clears as soon as another chat finishes.
  const now = Date.now();
  const hit = codexLimitHit({ info: "rateLimitExceeded", message: busy.response.error.message, now });
  expect(hit).toMatchObject({ kind: "rate", source: "text" });
  expect(Math.round((hit!.resetsAt! - now) / 1000)).toBe(20);
});

test("Check on a Featherless address reads nothing: it says where a model is found instead", async () => {
  const fake = feather();
  const app = setup(fake);
  // Settings → Accounts → Change → Check, and Add a custom model, both come here (POST /api/accounts/endpoint/probe).
  // Before, this read the 22,406-model list in full and wrote its first 50 names over the one model you had searched
  // for, with the first row's context (262k) over the plan's 32k.
  await expect(app.providers.probeEndpoint(`${fake.url}/v1`, KEY)).rejects.toThrow("too many to list here. Add it in Settings → AI services");
  expect(fake.seen).toEqual([]);

  // The guard behind it, for any list a probe may meet: an answer far bigger than a model list is dropped, not held.
  const flood = feather({ floodStream: true, fillerBytes: 500_000 }); // ten rows: 5 MB, past what any model list can be
  const app2 = setup(flood);
  app2.services.catalog.origin = "http://127.0.0.1:9"; // not Featherless as far as this hub knows: the plain probe path
  await expect(app2.providers.probeEndpoint(flood.url)).rejects.toThrow("No model server answered");
});

test("the check asks which plan the key is on, with the key, and says it plainly", async () => {
  const fake = feather();
  const app = setup(fake);
  // The Chat plan: the docs' own example answer, flat, 32K, four at a time.
  const r = await app.services.test({ baseUrl: fake.url, apiKey: KEY });
  expect(r.plan).toEqual({ id: "feather_pro_plus", name: "Feather Premium", kind: "chat", maxContext: 32_768, concurrency: 4, checkedAt: expect.any(Number) });
  // One read, with the key as Featherless's docs ask for it, and nothing else carried a body or ran a model.
  expect(fake.planReads().map((s) => [s.method, s.auth])).toEqual([["GET", `Bearer ${KEY}`]]);
  expect(fake.seen.every((s) => s.method === "GET" || JSON.stringify(s.body) === "{}")).toBe(true);

  // The Developer plan: paid per token from credits, agents allowed, and no cap of its own on a chat (each model's own
  // context applies, 256K at most), as Featherless's own plan list names and sizes it.
  fake.setPlan(DEVELOPER_PLAN);
  expect((await app.services.test({ baseUrl: fake.url, apiKey: KEY })).plan).toMatchObject({ id: "feather_request_pricing", name: "Request Pricing", kind: "credits", maxContext: null, concurrency: 100 });
  // A check reads it again every time, so a plan switched on Featherless's billing page shows at once.
  expect(fake.planReads()).toHaveLength(2);

  // A service without the address (or one it keeps from this key): that says nothing about the plan, so what was read
  // for this key last stands; for a key never read, the check says nothing about a plan at all.
  fake.setPlan(404);
  expect((await app.services.test({ baseUrl: fake.url, apiKey: KEY })).plan).toMatchObject({ id: "feather_request_pricing", kind: "credits" });
  expect((await setup(fake).services.test({ baseUrl: fake.url, apiKey: KEY })).plan).toBeUndefined();
  // An answer that isn't a plan: nothing about a plan either.
  fake.setPlan({ unexpected: true });
  expect((await app.services.test({ baseUrl: fake.url, apiKey: KEY })).plan).toBeUndefined();
  // A refused key has no plan to talk about, and no key is never asked about.
  fake.setPlan(CHAT_PLAN);
  expect((await app.services.test({ baseUrl: fake.url, apiKey: "rc_not_a_key" })).plan).toBeUndefined();
  const reads = fake.planReads().length;
  expect((await app.services.test({ baseUrl: fake.url })).plan).toBeUndefined();
  expect(fake.planReads()).toHaveLength(reads);
});

test("what a plan means for an agent: the Chat plan doesn't allow one, the Developer plan does, the rest aren't guessed", () => {
  // Featherless's own plans by id, as the plan list behind its pricing page names them (4 November 2026): the three for a
  // person typing, which its terms keep to interactive use...
  for (const [id, name] of [[CHAT_PLAN_ID, "Feather Premium"], [CHAT_PLAN_ID, "Feather Chat (formerly Premium)"], ["feather_pro", "Feather Basic"], ["feather_lite", "Feather Lite"]]) expect(planKind(id, name)).toBe("chat");
  // ...the Developer plan, billed per token...
  expect(planKind(DEVELOPER_PLAN_ID, "Request Pricing")).toBe("credits");
  // ...and the paused flat plans built for agents, whose terms aren't published any more: nothing is claimed either way.
  for (const [id, name] of [["feather_max", "Featherless Max"], ["feather_229b_full_context", "Feather 229B Full Context"], ["feather_claw_standard", "Feather Agent Standard"], ["feather_claw_pro", "Feather Agent Pro"]]) expect(planKind(id, name)).toBe("other");
  // A plan the list doesn't have (yet) goes by its words.
  expect(planKind("feather_chat", "Featherless Chat")).toBe("chat");
  expect(planKind("feather_payg", "Pay-As-You-Go")).toBe("credits");
  for (const [id, name] of [["feather_scale", "Feather Scale"], ["dedicated_b300", "Dedicated GPUs"]]) expect(planKind(id, name)).toBe("other");
  // What the words call each: Chat and Developer, as the pricing page does, whatever the list names them; any other plan
  // its own name, without "Feather" in front.
  expect(planLabel({ id: CHAT_PLAN_ID, name: "Feather Chat (formerly Premium)", kind: "chat" })).toBe("Chat");
  expect(planLabel({ id: CHAT_PLAN_ID, name: "Feather Premium", kind: "chat" })).toBe("Chat");
  expect(planLabel({ id: DEVELOPER_PLAN_ID, name: "Request Pricing", kind: "credits" })).toBe("Developer");
  expect(planLabel({ id: "feather_pro", name: "Feather Basic", kind: "chat" })).toBe("Basic");
  expect(planLabel({ id: "feather_max", name: "Featherless Max", kind: "other" })).toBe("Max");
  expect(planLabel({ id: "feather_payg", name: "Pay-As-You-Go plan", kind: "credits" })).toBe("Pay-As-You-Go");
  expect(planLabel({ id: "feather_payg", name: "feather_payg", kind: "credits" })).toBe("Developer");
  // The answer as GET /v1/plan gives it, and what isn't one.
  expect(planFrom(DEVELOPER_PLAN, 5)).toEqual({ id: DEVELOPER_PLAN_ID, name: "Request Pricing", kind: "credits", maxContext: null, concurrency: 100, checkedAt: 5 });
  expect(planFrom({ id: "feather_request_pricing", max_context_length: 262_144 }, 5)).toEqual({ id: DEVELOPER_PLAN_ID, name: DEVELOPER_PLAN_ID, kind: "credits", maxContext: 262_144, concurrency: null, checkedAt: 5 });
  expect(planFrom({ name: "no id" }, 5)).toBeNull();
  expect(planFrom("Forbidden", 5)).toBeNull();
  // A price as its row gives it: per million, else per token in strings, else none.
  expect(priceOfRow({ input: 0.6, output: 2.5 })).toEqual({ input: 0.6, output: 2.5, cached: null });
  expect(priceOfRow({ prompt: "0.0000016", completion: "0.000012" })).toEqual({ input: 1.6, output: 12, cached: null });
  expect(priceOfRow({ prompt: "-1" })).toBeNull();
  expect(priceOfRow(undefined)).toBeNull();
});

test("the note in a chat names the plan the key is on, says what agents need, and writes out Featherless's plans to link", () => {
  const plan = (id: string, name: string) => planFrom({ id, name, max_context_length: 32_768, concurrency: 2 }, 0);
  // Its older Basic plan is a plan for a person typing too (its terms keep "individual plans" to interactive use).
  expect(chatNotice(plan("feather_pro", "Feather Basic"))).toBe(
    "Featherless says this key is on its Basic plan, which doesn't allow agents or API use: Featherless can cancel an account used that way without a refund. Agents need its Developer plan: paid per token, so set a spending limit in Settings → Costs. See https://featherless.ai/pricing.",
  );
  // The Chat plan under the name its plan list gives it now, and under the docs' older one: the same words.
  expect(chatNotice(plan(CHAT_PLAN_ID, "Feather Chat (formerly Premium)"))).toBe(chatNotice(planFrom(CHAT_PLAN, 0)));
  expect(chatNotice(planFrom(CHAT_PLAN, 0))).toStartWith("Featherless says this key is on its Chat plan, which doesn't allow agents or API use");
  // The Developer plan: nothing to say in a chat. A paused plan built for agents: named, never guessed at.
  expect(chatNotice(planFrom(DEVELOPER_PLAN, 0))).toBeNull();
  expect(chatNotice(plan("feather_max", "Featherless Max"))).toBe(
    "Featherless says this key is on “Featherless Max”, a plan Crosstalk doesn't know: check what it allows. Featherless's $25 Chat plan doesn't allow agents or API use: Featherless can cancel an account used that way without a refund. Its Developer plan allows them, paid per token, so set a spending limit in Settings → Costs. See https://featherless.ai/pricing.",
  );
  // Whichever it is, the way to Featherless's plans is the whole address (the app makes it a link), and never "flat" or
  // "unlimited": every chat here is an agent driving it through the API.
  for (const p of [plan("feather_pro", "Feather Basic"), plan("feather_max", "Featherless Max"), null]) {
    expect(chatNotice(p)).toEndWith("set a spending limit in Settings → Costs. See https://featherless.ai/pricing.");
    expect(chatNotice(p)).not.toMatch(/flat|unlimited/i);
  }
});

test("what a chat says: the Chat plan's terms in every chat on that key, an unknown plan's once, the Developer plan nothing", async () => {
  const fake = feather();
  const app = setup(fake);
  const { account } = addFeatherless(app, fake.url);
  const dir = mkdtempSync(join(tmpdir(), "ct-feather-chat-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const chat = () => app.chats.create({ provider: "codex", account: account.id, model: PICK, cwd: dir } as never);
  const notes = (roomId: string) => app.store.listMessages(roomId).filter((m) => m.authorKind === "system").map((m) => m.text);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Bun.sleep(5);
  };

  // A key on the Chat plan: said in the chat, before anything else happens in it.
  const first = chat();
  await settle();
  expect(notes(first.id)).toEqual(["Featherless says this key is on its Chat plan, which doesn't allow agents or API use: Featherless can cancel an account used that way without a refund. Agents need its Developer plan: paid per token, so set a spending limit in Settings → Costs. See https://featherless.ai/pricing."]);
  expect(app.store.listMessages(first.id)).toHaveLength(1);
  // Only once in that chat, however often its agent's status changes...
  for (const m of app.store.listMembers(first.id)) for (let i = 0; i < 3; i++) app.bus.emit({ t: "member", member: m });
  await settle();
  expect(notes(first.id)).toHaveLength(1);
  // ...and again in the next chat on that key: every chat on it is an agent the plan doesn't allow.
  const second = chat();
  await settle();
  expect(notes(second.id)).toHaveLength(1);
  // The plan was read once for all of that (it's kept ten minutes), with the key.
  expect(fake.planReads()).toHaveLength(1);

  // Switched to the Developer plan on Featherless: the next chat says nothing (the terms allow it, and the sheet and
  // Settings say it's paid per token).
  fake.setPlan(DEVELOPER_PLAN);
  await app.services.catalog.planOf(KEY, true);
  const third = chat();
  await settle();
  expect(notes(third.id)).toEqual([]);

  // Nothing of the key is in what was kept about it.
  expect(app.store.kvGet("featherless.notices")).not.toContain(KEY);
  expect(app.store.kvGet("featherless.plans")).not.toContain(KEY);

  // A chat on any other service says nothing about Featherless.
  const local = app.providers.setEndpointAccount("codex", { label: "Local", baseUrl: "http://127.0.0.1:9", apiKey: "", models: ["qwen3"], contextWindow: 32_768, protocol: "chat" });
  const fourth = app.chats.create({ provider: "codex", account: local.id, model: "qwen3", cwd: dir } as never);
  await settle();
  expect(notes(fourth.id)).toEqual([]);

  // NanoGPT at the same address (the test hubs point both at one closed port): NanoGPT's, never told about Featherless,
  // whatever plan the stand-in would say the key is on.
  fake.setPlan(CHAT_PLAN);
  const shared = setup(fake);
  shared.services.nanogpt.origin = fake.url;
  const nanoChat = shared.chats.create({ provider: "codex", account: addFeatherless(shared, fake.url, { label: "NanoGPT" }).account.id, model: PICK, cwd: dir } as never);
  await settle();
  expect(shared.store.listMessages(nanoChat.id)).toEqual([]);
  expect(shared.services.flatRate("codex", shared.chats.member(nanoChat.id)!.config!.account as string, fake.url)).toBe(false);

  // A key whose plan Featherless doesn't say (or one Crosstalk doesn't know): said once, in its first chat, and not after.
  fake.setPlan(404);
  const other = setup(fake);
  const otherAccount = addFeatherless(other, fake.url).account;
  const otherChat = () => other.chats.create({ provider: "codex", account: otherAccount.id, model: PICK, cwd: dir } as never);
  const fifth = otherChat();
  await settle();
  expect(other.store.listMessages(fifth.id).map((m) => m.text)).toEqual(["Crosstalk couldn't tell which Featherless plan this key is on. Featherless's $25 Chat plan doesn't allow agents or API use: Featherless can cancel an account used that way without a refund. Agents need its Developer plan: paid per token, so set a spending limit in Settings → Costs. See https://featherless.ai/pricing."]);
  const sixth = otherChat();
  await settle();
  expect(other.store.listMessages(sixth.id)).toEqual([]);
  // A plan it doesn't know is named, once, the same way.
  fake.setPlan({ id: "feather_scale", name: "Feather Scale", max_context_length: 32_768, concurrency: 8 });
  const scale = setup(fake);
  const scaleChat = scale.chats.create({ provider: "codex", account: addFeatherless(scale, fake.url).account.id, model: PICK, cwd: dir } as never);
  await settle();
  expect(scale.store.listMessages(scaleChat.id).map((m) => m.text)).toEqual([expect.stringMatching(/^Featherless says this key is on “Feather Scale”, a plan Crosstalk doesn't know: check what it allows\. Featherless's \$25 Chat plan doesn't allow agents/)]);
});

test("a key on the Chat plan is the plan's to pay for; on the Developer plan each reply is priced at the model's own rate", async () => {
  const fake = feather();
  const app = setup(fake);
  const { account } = addFeatherless(app, fake.url, { models: [PICK, "moonshotai/Kimi-K2-Instruct"] });
  // What the hub knows before a reply ends, read here from the stand-in: the prices (its model menu reads its models by
  // name) and which plan the key is on. A key never read is priced, never called free: its plan isn't known.
  await app.providers.models("codex", account.id);
  expect(app.services.flatRate("codex", account.id, fake.url)).toBe(false);
  await app.services.catalog.planOf(KEY, true);
  expect(app.services.flatRate("codex", account.id, fake.url)).toBe(true);
  // A model the hub hasn't seen in the list yet isn't guessed at: it's looked up by name, for the next reply.
  const unseen = "huihui-ai/Huihui-Qwen3-8B-abliterated-v2";
  const host = `127.0.0.1:${fake.port}`;
  expect(app.services.catalog.priceFor(host, unseen)).toBeNull();
  await Bun.sleep(50);
  expect(app.services.catalog.priceFor(host, unseen)).toEqual([0.3, 2.4, null]);
  // Another service's address never takes these prices, nor a model server on this machine (another port, or none).
  expect(app.services.catalog.priceFor("api.example.com", PICK)).toBeNull();
  expect(app.services.catalog.priceFor(`127.0.0.1:${fake.port + 1}`, PICK)).toBeNull();
  expect(app.services.catalog.priceFor("127.0.0.1", PICK)).toBeNull();

  // The account itself is on Featherless's real address, because a stand-in on 127.0.0.1 is a model server on this
  // machine to the ledger, whose replies are free. Nothing below may ask Featherless anything: every request to it fails
  // the test.
  const reached: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith("featherless.ai")) {
      reached.push(url.href);
      return Promise.reject(new Error("a test reached the real Featherless"));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  cleanups.push(() => void (globalThis.fetch = realFetch));
  const onReal = () => {
    app.services.catalog.origin = "https://api.featherless.ai";
    const all = JSON.parse(app.store.kvGet("accounts") ?? "[]") as { id: string; baseUrl: string }[];
    app.store.kvSet("accounts", JSON.stringify(all.map((a) => (a.id === account.id ? { ...a, baseUrl: "https://api.featherless.ai" } : a))));
  };
  onReal();
  const reply = (model = PICK) => ({ provider: "codex" as const, account: account.id, model, inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0 });
  const book = (model = PICK) => app.spend.record({ source: "turn", roomId: null, chatName: "A chat", ...reply(model), ...app.spend.priceReply(reply(model)) });
  const kept = () => app.store.db.query("SELECT cost_usd AS cost, basis FROM spend_ledger ORDER BY id DESC").get();

  // On the Chat plan: one fee for the month, so a reply adds nothing to the bill and no limit can count it.
  book();
  expect(kept()).toEqual({ cost: 0, basis: "plan" });
  expect(app.spend.accounts().find((a) => a.account === account.id)).toMatchObject({ flat: true, budget: null });
  expect(() => app.spend.setBudget("codex", account.id, { limitUsd: 10 })).toThrow("Featherless's Chat plan: one flat fee for the month, so there's nothing for a limit to count. That plan doesn't allow agents.");

  // Switched to the Developer plan (read from the stand-in again): each reply at that model's own price in Featherless's
  // list, and a limit counts it.
  fake.setPlan(DEVELOPER_PLAN);
  app.services.catalog.origin = fake.url;
  await app.services.catalog.planOf(KEY, true);
  onReal();
  book("moonshotai/Kimi-K2-Instruct");
  expect(kept()).toEqual({ cost: 0.85, basis: "estimated" }); // 1M in at $0.60, 100k out at $2.50
  expect(app.spend.accounts().find((a) => a.account === account.id)?.flat).toBeUndefined();
  app.spend.setBudget("codex", account.id, { limitUsd: 1 });
  expect(app.spend.checkBudget("codex", account.id)).toBeNull();
  book();
  expect(kept()).toEqual({ cost: 0.54, basis: "estimated" }); // 1M in at $0.30, 100k out at $2.40
  expect(app.spend.checkBudget("codex", account.id)).toBe("Featherless reached its $1.00 limit, so this reply didn't start.");
  expect(reached).toEqual([]);
});

test("the plan read is kept by a hash of the key, across restarts, and an account's row can ask for it", async () => {
  const fake = feather({ plan: DEVELOPER_PLAN });
  let store: string | null = null;
  const keep = { get: () => store, set: (v: string) => void (store = v) };
  const one = new Featherless(keep);
  one.origin = fake.url;
  expect(await one.planOf(KEY)).toMatchObject({ kind: "credits" });
  expect(store).not.toContain(KEY);
  // A hub started again knows it without asking.
  const two = new Featherless(keep);
  two.origin = fake.url;
  expect(two.lastPlan(KEY)).toMatchObject({ id: DEVELOPER_PLAN_ID, kind: "credits", maxContext: null, concurrency: 100 });
  expect(fake.planReads()).toHaveLength(1);
  // Featherless turns the key down: said as that, and not tried again at once.
  await expect(two.planOf("rc_wrong_key", true)).rejects.toBeInstanceOf(KeyRefused);

  // The row in Settings → AI services: GET /api/accounts/:p/:id/plan, for Featherless accounts only.
  const app = setup(fake);
  const { account } = addFeatherless(app, fake.url);
  const plan = serviceRoutes(app).find((r) => r.method === "GET" && r.pattern.test(`/api/accounts/codex/${account.id}/plan`))!;
  const ask = (id: string) => plan.handler({ params: { p: "codex", id }, url: new URL(`http://hub/api/accounts/codex/${id}/plan`) } as never);
  expect(await ask(account.id)).toEqual({ plan: expect.objectContaining({ kind: "credits", maxContext: null }) });
  const local = app.providers.setEndpointAccount("codex", { label: "Local", baseUrl: "http://127.0.0.1:9", apiKey: "", models: ["qwen3"], contextWindow: 32_768, protocol: "chat" });
  await expect(ask(local.id)).rejects.toThrow("isn't on Featherless");
});

test("a 403 or 404 from /v1/plan keeps what was last read for the key: only a key whose plan was never read is unknown", async () => {
  const fake = feather({ plan: DEVELOPER_PLAN });
  const app = setup(fake);
  const catalog = app.services.catalog;
  // Read right, as the Add sheet's check does: the Developer plan.
  expect(await catalog.planOf(KEY, true)).toMatchObject({ id: DEVELOPER_PLAN_ID, kind: "credits" });
  // Then a block on the way, or a route Featherless keeps from this key: that says nothing about the plan, so it stands.
  // (Before, one such answer erased it: the Chat plan's 32K for models saved without a size, and "couldn't tell which
  // plan" said in its next chat to someone already on the Developer plan.)
  for (const status of [403, 404]) {
    fake.setPlan(status);
    expect(await catalog.planOf(KEY, true)).toMatchObject({ id: DEVELOPER_PLAN_ID, kind: "credits" });
    expect(catalog.lastPlan(KEY)).toMatchObject({ kind: "credits", maxContext: null });
    expect(catalog.capFor(KEY)).toBeNull();
  }
  expect(fake.planReads()).toHaveLength(3);
  const { account } = addFeatherless(app, fake.url);
  const dir = mkdtempSync(join(tmpdir(), "ct-feather-kept-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const chat = app.chats.create({ provider: "codex", account: account.id, model: PICK, cwd: dir } as never);
  for (let i = 0; i < 20; i++) await Bun.sleep(5);
  expect(app.store.listMessages(chat.id)).toEqual([]);
  // A real answer still changes it.
  fake.setPlan(CHAT_PLAN);
  expect(await catalog.planOf(KEY, true)).toMatchObject({ kind: "chat" });
  expect(catalog.lastPlan(KEY)).toMatchObject({ kind: "chat" });
  // A key whose plan was never read (another hub): a 403 leaves it unknown.
  fake.setPlan(403);
  expect(await setup(fake).services.catalog.planOf(KEY, true)).toBeNull();
});

test("a model saved without a size is given what its key's plan reads at once: its own on Developer, 32K on Chat or unknown", async () => {
  // Saved with no size of its own (an account from an older version, say): its plan decides, from the first read on.
  const sized = async (plan: Record<string, unknown> | number, read: boolean) => {
    const fake = feather({ plan });
    const app = setup(fake);
    if (read) await app.services.catalog.planOf(KEY, true).catch(() => null);
    const { account } = addFeatherless(app, fake.url, { models: ["moonshotai/Kimi-K2-Instruct"], contextWindow: null, contexts: {} });
    return (await app.providers.models("codex", account.id, { fresh: true })).models.map((m) => m.contextWindow);
  };
  // The Developer plan has no cap of its own: the model's own 131K stands (and so would a cap the plan did give, past it).
  expect(await sized(DEVELOPER_PLAN, true)).toEqual([131_072]);
  expect(await sized({ ...DEVELOPER_PLAN, max_context_length: 262_144 }, true)).toEqual([131_072]);
  expect(await sized({ ...DEVELOPER_PLAN, max_context_length: 65_536 }, true)).toEqual([65_536]);
  // The Chat plan reads 32K, and a key whose plan isn't known is held to that too, so no chat overflows.
  expect(await sized(CHAT_PLAN, true)).toEqual([32_768]);
  expect(await sized(DEVELOPER_PLAN, false)).toEqual([CONTEXT_CAP]);
  expect(await sized(404, true)).toEqual([CONTEXT_CAP]);
});

test("a Featherless address isn't added by a one-tap New chat: it says where to pick a model", async () => {
  const fake = feather();
  const app = setup(fake);
  await expect(app.services.accountForChat({ baseUrl: fake.url, apiKey: KEY })).rejects.toThrow("Add Featherless in Settings → AI services, where you can search its models");
});
