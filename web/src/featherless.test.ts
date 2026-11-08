// Featherless in the app: its preset, what its plans allow an agent (said where it's added, under the check and on its
// row), the words beside a model found in its catalogue, what the Add sheet saves, and the way a long model list is
// narrowed in a menu. Nothing here makes a request.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CatalogModel, CatalogSearch, ModelOption, ServicePlan, ServiceTestResult } from "@crosstalk/shared";
import { FEATHERLESS_PRICING, FEATHERLESS_REMINDER, FEATHERLESS_TERMS, isFeatherless, planWords } from "./featherless";
import { SERVICE_PRESETS, presetSteps, servicePreset } from "./presets";
import { CATALOG_CHIPS, CATALOG_GATED_WORDS, CATALOG_LIST_TOOLS_WORDS, CATALOG_TOOLS_WORDS, capContext, capWords, catalogFacts, catalogIntro, catalogSummary, planAtOnce, planCap, rememberRows, saveBody, testLines } from "./services";
import { chatSpendLine, FLAT_RATE_NOTE } from "./spend";
import { MODEL_FIND_FROM, findModels } from "./models";
import { PlanNote } from "./views/FeatherlessPlan";
import { NoteText, noteParts } from "./views/NoteText";
import { ModelChoices } from "./views/ModelChoices";

const none = { responses: "no", messages: "no", chat: "no" } as const;
const result = (over: Partial<ServiceTestResult> = {}): ServiceTestResult => ({ reachable: true, authOk: true, server: null, protocols: { ...none }, models: [], works: [], problems: [], ...over });
const PICK = "huihui-ai/Huihui-Qwen3.5-27B-abliterated";
const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({ id: PICK, modelClass: "qwen3.5-27b", params: 27, contextWindow: 32_768, concurrency: 2, gated: false, tools: true, toolsSaid: "docs", ...over });
const search = (over: Partial<CatalogSearch> = {}): CatalogSearch => ({ name: "featherless", q: "", models: [model()], matched: 1, total: 22_406, ...over });
const option = (id: string, over: Partial<ModelOption> = {}): ModelOption => ({ id, label: id, description: null, efforts: [], defaultEffort: null, isDefault: false, ...over });
/**
 * GET /v1/plan as the hub reads it: the Chat plan (the docs' own example), the Developer plan (as the plan list behind
 * Featherless's pricing page names and sizes it: "Request Pricing", no cap of its own on a chat), and one nobody here knows.
 */
const CHAT: ServicePlan = { id: "feather_pro_plus", name: "Feather Premium", kind: "chat", maxContext: 32_768, concurrency: 4, checkedAt: 0 };
const DEVELOPER: ServicePlan = { id: "feather_request_pricing", name: "Request Pricing", kind: "credits", maxContext: null, concurrency: 100, checkedAt: 0 };
const OTHER: ServicePlan = { id: "feather_scale", name: "Feather Scale", kind: "other", maxContext: 32_768, concurrency: 8, checkedAt: 0 };

test("the Featherless preset: where it lives, where its key comes from, and which plan an agent needs, in plain words", () => {
  const p = servicePreset("featherless")!;
  expect(SERVICE_PRESETS.map((s) => s.id)).toContain("featherless");
  expect([p.title, p.baseUrl, p.kind, p.agent]).toEqual(["Featherless", "https://api.featherless.ai", "hosted", "codex"]);
  // Chat Completions is the only lane it has, so Codex reaches it through Crosstalk's own translator.
  expect(p.protocol).toBe("chat");
  // Until the check reads the key's own plan, the Chat plan's figures hold: 32K of a chat at once, four at a time.
  expect(p.contextCap).toBe(32_768);
  expect(p.atOnce).toBe(4);
  expect(p.keyPage).toEqual({ label: "featherless.ai/account/api-keys", url: "https://featherless.ai/account/api-keys" });
  expect(p.docs).toEqual({ label: "featherless.ai/docs", url: "https://featherless.ai/docs" });
  // The line in the list says which plan agents need, and never "one flat price" or "unlimited" any more.
  expect(p.help).toBe("Any open model from Hugging Face, uncensored ones included. Agents need its Developer plan, paid per token.");
  // Said where it's added, before any key is checked (the plan is picked on Featherless before the key is made): the
  // plan agents need and what it costs, the plan they can't use and what using it anyway risks, and its plans linked.
  expect(p.plan).toBe(FEATHERLESS_TERMS);
  expect(p.plan).toBe("Agents need Featherless's Developer plan. It's paid per token from monthly credits, so set a spending limit in Settings → Costs. The $25 Chat plan doesn't allow agents or API use: Featherless can cancel an account used that way without a refund.");
  expect(p.pricing).toEqual({ label: "featherless.ai/pricing", url: "https://featherless.ai/pricing" });
  expect(p.pricing).toBe(FEATHERLESS_PRICING);
  for (const words of [p.help, p.plan, p.note]) expect(words).not.toMatch(/flat|unlimited|as many requests/i);
  // What Crosstalk does for it, in one short line (the tool rule is said over the models themselves, where it matters).
  expect(p.note).toBe("Crosstalk searches its 22,000 models instead of listing them.");
  expect(p.note!.length).toBeLessThan(90);
  expect(presetSteps(p)).toEqual(["Get a key at featherless.ai/account/api-keys.", "Paste it here.", "Press Test."]);
  // Nothing of its own goes into a chat request: it needs no body fields, so none are sent.
  expect(p.extra).toBeUndefined();
});

test("a service with a catalogue says how many models there are to search, instead of a model count", () => {
  const r = result({ works: [{ provider: "codex", via: "adapter" }], catalog: { name: "featherless", total: 22_406 } });
  expect(testLines(r).map((l) => [l.ok, l.text])).toEqual([
    [true, "Reachable"],
    [true, "Key works"],
    [true, "22,406 models to search"],
    [true, "Works with Codex"],
  ]);
  // A service that lists its models the usual way still counts them.
  expect(testLines(result({ models: [{ id: "a", contextWindow: null }] }))[2].text).toBe("1 model found");
});

test("the facts beside a found model: its size, its context, and what a request of it uses of the plan's four", () => {
  const atOnce = servicePreset("featherless")!.atOnce;
  expect(atOnce).toBe(4);
  expect(catalogFacts(model(), atOnce)).toBe("27B · 32k · uses 2 of your 4 at a time");
  // A small model takes one of the four, which is the ordinary case and needs no words.
  expect(catalogFacts(model({ params: 8, concurrency: 1, contextWindow: 32_768 }), atOnce)).toBe("8B · 32k");
  expect(catalogFacts(model({ params: 235, contextWindow: 262_144, concurrency: 4 }), atOnce)).toBe("235B · 256k · uses 4 of your 4 at a time");
  // A plan whose at-a-time figure isn't known still says what a big model's request counts as.
  expect(catalogFacts(model())).toBe("27B · 32k · counts as 2 requests at a time");
  // A class that doesn't say the size, and a model whose context the list left out: the line just says less.
  expect(catalogFacts(model({ params: null, contextWindow: null, concurrency: 1 }), atOnce)).toBe("");
});

test("why a model can or can't run tools is worded as what the maker says, and a gated one says what to do", () => {
  expect(CATALOG_TOOLS_WORDS).toContain("Featherless's docs say");
  expect(CATALOG_TOOLS_WORDS).toContain("Qwen 3 family and Kimi K2");
  // An agent needs them, the rest are marked the way every no-tools model is, and picking one anyway is allowed.
  expect(CATALOG_TOOLS_WORDS).toContain("read files or run commands");
  expect(CATALOG_TOOLS_WORDS).toContain("No tools");
  expect(CATALOG_TOOLS_WORDS).toContain("you can still pick one");
  expect(CATALOG_GATED_WORDS).toContain("agree to its licence");
  expect(CATALOG_GATED_WORDS).toContain("refuse every request");
  // A model the docs don't cover whose own row claims tool calls: said as what isn't promised, not as what it can't do.
  expect(CATALOG_LIST_TOOLS_WORDS).toContain("own list says some of those can call tools");
  expect(CATALOG_LIST_TOOLS_WORDS).toContain("docs don't promise it");
  expect(CATALOG_LIST_TOOLS_WORDS).not.toContain("can't");
});

test("a catalogue whose list couldn't be read still gets a search box, with nothing to type by hand", () => {
  // The hub sends the catalogue line whatever happened to the list, with 0 when it couldn't be read: the check says so,
  // and the sheet shows the search (and its own Try again) rather than "type the model names, separated by commas".
  // (`authOk` is null here as the hub sends it: the list is what says a key works, and it couldn't be read.)
  const r = result({ authOk: null, works: [{ provider: "codex", via: "adapter" }], catalog: { name: "featherless", total: 0 }, problems: ["Featherless's model list answered with error 500. Try again in a minute. Crosstalk needs its model list to find a model for you."] });
  expect(testLines(r).map((l) => [l.ok, l.text])).toEqual([
    [true, "Reachable"],
    [false, "Couldn't read its model list"],
    [true, "Works with Codex"],
  ]);
  expect(catalogIntro(0)).toBe("Far too many models to list, so you search for the one you want.");
  expect(catalogIntro(22_406)).toBe("22,406 models, so you search for the one you want.");
});

test("a picked model keeps its facts however many searches follow it", () => {
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => model({ id: `owner/model-${from + i}`, tools: false }));
  // Ticked, then search after search: the picked row stays, so it can still be unticked, made the default, and saved
  // with its own size — only the ones nobody picked are forgotten.
  let seen = rememberRows([], [model(), ...rows(0, 5)], []);
  for (let i = 0; i < 10; i++) seen = rememberRows(seen, rows(100 * (i + 1), 5), [PICK]);
  expect(seen.find((m) => m.id === PICK)).toMatchObject({ contextWindow: 32_768, params: 27 });
  // The rest are held to what was asked for, newest kept, and a row seen twice isn't kept twice.
  const small = rememberRows(rememberRows([], [model(), ...rows(0, 3)], [PICK]), [model(), ...rows(3, 3)], [PICK], 4);
  expect(small.map((m) => m.id)).toEqual([PICK, "owner/model-2", "owner/model-3", "owner/model-4", "owner/model-5"]);
});

test("a key on the flat Chat plan shows no price for a reply, and its card says that plan doesn't allow agents", () => {
  const chat = { roomId: "r", usd: 0, replies: 3, unpriced: 0, estimated: 0 };
  // The hub keeps every reply on a Chat-plan key at nothing (basis "plan"), so the figure would read "$0.00" on a plan you
  // do pay $25 a month for: a dash, and what covers it, instead. (A key on the Developer plan is priced per token.)
  expect(chatSpendLine(chat, false, true)).toBe("This chat: — · included in your plan");
  expect(chatSpendLine(chat, false, false)).toBe("This chat: $0.00");
  expect(chatSpendLine({ ...chat, replies: 0 }, false, true)).toBeNull();
  // What its card in Settings → Costs says where another account would have a limit: why there's no figure, that the
  // plan doesn't allow agents, and what does.
  expect(FLAT_RATE_NOTE).toBe("This key is on Featherless's Chat plan: one flat fee for the month, so replies have no price here and nothing for a limit to count. That plan doesn't allow agents or API use. Agents need its Developer plan, paid per token, which a limit here can count.");
});

test("which plan a checked key is on, in plain words: the Chat plan warned, the Developer plan priced, an unknown one named", () => {
  // The Chat plan: what the terms say, what using it anyway risks, and the way out.
  expect(planWords(CHAT)).toEqual({
    tone: "bad",
    text: "This key is on Featherless's Chat plan, which doesn't allow agents or API use: using it here could get your account cancelled without a refund. Switch to the Developer plan first (paid per token, so set a spending limit).",
  });
  // The Chat plan under the name Featherless's own list gives it now: the same words.
  expect(planWords({ ...CHAT, name: "Feather Chat (formerly Premium)" })).toEqual(planWords(CHAT));
  // Its older Basic plan is one for a person typing too, said by its own name.
  expect(planWords({ ...CHAT, id: "feather_pro", name: "Feather Basic", concurrency: 2 })).toEqual({
    tone: "bad",
    text: "This key is on Featherless's Basic plan, which doesn't allow agents or API use: using it here could get your account cancelled without a refund. Switch to the Developer plan first (paid per token, so set a spending limit).",
  });
  // The Developer plan: allowed, and paid per token, so a limit is worth setting — no warning about terms that allow it.
  // Featherless's own list calls it "Request Pricing"; it's said as its pricing page says it.
  expect(planWords(DEVELOPER)).toEqual({ tone: "ok", text: "This key is on Featherless's Developer plan, which allows agents. Each reply is paid per token from your credits, so set a spending limit in Settings → Costs." });
  expect(planWords({ ...DEVELOPER, id: "feather_payg", name: "Pay-As-You-Go" }).text).toContain("Featherless's Pay-As-You-Go plan, which allows agents");
  // A name that's only an id still reads as a plan.
  expect(planWords({ ...DEVELOPER, name: "feather_request_pricing" }).text).toContain("Featherless's Developer plan");
  expect(planWords({ ...DEVELOPER, id: "feather_payg", name: "feather_payg" }).text).toContain("Featherless's Developer plan");
  expect(planWords(DEVELOPER).text).not.toContain("cancel");
  // One Crosstalk doesn't know: named, never guessed at, with what to check.
  expect(planWords(OTHER)).toEqual({ tone: "warn", text: "Featherless says this key is on “Feather Scale”, a plan Crosstalk doesn't know. Check that it allows agents: the Chat plan doesn't, the Developer plan does (paid per token)." });
  // What a row says when the plan can't be told.
  expect(FEATHERLESS_REMINDER).toBe("Agents need Featherless's Developer plan, paid per token. Its Chat plan doesn't allow them.");

  // As drawn: Featherless's plans linked, opening in the phone's own browser, and the Chat plan's warning read out at
  // once when a check has just found it.
  const note = (plan: ServicePlan, announce = false) => renderToStaticMarkup(createElement(PlanNote, { plan, announce }));
  expect(note(CHAT, true)).toContain('role="alert"');
  expect(note(CHAT, true)).toContain('href="https://featherless.ai/pricing" target="_blank" rel="noreferrer noopener">featherless.ai/pricing</a>');
  expect(note(CHAT)).toContain('role="status"');
  expect(note(DEVELOPER, true)).toContain('role="status"');
  expect(note(CHAT)).toContain('class="svc-plan bad"');
  expect(note(DEVELOPER)).toContain('class="svc-plan ok"');
  expect(note(OTHER)).toContain('class="svc-plan warn"');

  // Which accounts are Featherless's.
  expect(isFeatherless("https://api.featherless.ai")).toBe(true);
  expect(isFeatherless("https://api.featherless.ai/v1")).toBe(true);
  expect(isFeatherless("https://nano-gpt.com/api")).toBe(false);
  expect(isFeatherless("https://featherless.ai.example.com")).toBe(false);
  expect(isFeatherless(null)).toBe(false);
});

test("the key's own plan decides how much of a chat a model is saved with, and what a big model uses of it", () => {
  const preset = servicePreset("featherless")!;
  const r = result({ protocols: { responses: "no", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "adapter" }], catalog: { name: "featherless", total: 22_406 } });
  // Not read (an older hub, or Featherless didn't say): the Chat plan's figures, so no chat is told it has room a plan won't serve.
  expect([planCap(r, preset), planAtOnce(r, preset)]).toEqual([32_768, 4]);
  expect([planCap({ ...r, plan: CHAT }, preset), planAtOnce({ ...r, plan: CHAT }, preset)]).toEqual([32_768, 4]);
  // The Developer plan has no cap of its own (each model's own applies, 256K at most), 100 at a time; a plan that does
  // give one holds a model to it.
  expect([planCap({ ...r, plan: DEVELOPER }, preset), planAtOnce({ ...r, plan: DEVELOPER }, preset)]).toEqual([undefined, 100]);
  expect(planCap({ ...r, plan: { ...DEVELOPER, maxContext: 262_144 } }, preset)).toBe(262_144);
  expect(catalogFacts(model({ params: 235, contextWindow: 262_144, concurrency: 4 }), planAtOnce({ ...r, plan: DEVELOPER }, preset))).toBe("235B · 256k · uses 4 of your 100 at a time");
  // What Featherless's list says a model costs on the Developer plan is said beside it.
  expect(catalogFacts(model({ price: { input: 0.3, output: 2.4, cached: null } }), 100)).toBe("27B · 32k · uses 2 of your 100 at a time · $0.30 in, $2.4 out per million");

  // Saved: a 256K model keeps its size on the Developer plan, and is held to 32K on the Chat plan.
  const big = model({ id: "Qwen/Qwen3-235B-A22B", contextWindow: 262_144, params: 235, concurrency: 4 });
  const save = (plan?: ServicePlan) => saveBody({ agent: "codex", result: { ...r, ...(plan ? { plan } : {}) }, preset, baseUrl: "https://api.featherless.ai", apiKey: "rc_key", label: "Featherless", models: [big.id], context: "", found: [big] });
  expect(save(DEVELOPER)).toMatchObject({ contextWindow: 262_144, contexts: { [big.id]: 262_144 } });
  expect(save(CHAT)).toMatchObject({ contextWindow: 32_768, contexts: { [big.id]: 32_768 } });
  expect(save()).toMatchObject({ contextWindow: 32_768, contexts: { [big.id]: 32_768 } });
  expect(capWords([big], planCap({ ...r, plan: DEVELOPER }, preset))).toBeNull();
  expect(capWords([big], planCap({ ...r, plan: CHAT }, preset))).toBe("Your plan reads 32k of a chat at once, so a model that could hold more is saved at 32k.");
});

test("Crosstalk's note in a chat links Featherless's plans: the whole address is the link, the full stop after it isn't", () => {
  // What the hub says in a chat on a key it read as on the Chat plan (hub/src/featherless.ts chatNotice).
  const note = "Featherless says this key is on its Chat plan, which doesn't allow agents or API use: Featherless can cancel an account used that way without a refund. Agents need its Developer plan: paid per token, so set a spending limit in Settings → Costs. See https://featherless.ai/pricing.";
  expect(noteParts(note)).toEqual([
    { text: "Featherless says this key is on its Chat plan, which doesn't allow agents or API use: Featherless can cancel an account used that way without a refund. Agents need its Developer plan: paid per token, so set a spending limit in Settings → Costs. See " },
    { url: "https://featherless.ai/pricing", label: "featherless.ai/pricing" },
    { text: "." },
  ]);
  // Opening in the phone's own browser, said the way every other screen says an address.
  expect(renderToStaticMarkup(createElement(NoteText, { text: note }))).toContain('See <a href="https://featherless.ai/pricing" target="_blank" rel="noreferrer noopener">featherless.ai/pricing</a>.');
  // Every other note stays the plain text it is: no address, or one that isn't https.
  for (const plain of ["Crosstalk restarted. Agents that were working are picking up where they left off.", "Open http://127.0.0.1:8188 on this machine.", 'Copied from "https://" (Claude Code)', ""]) {
    expect(noteParts(plain).every((p) => "text" in p)).toBe(true);
    expect(renderToStaticMarkup(createElement(NoteText, { text: plain }))).not.toContain("<a");
  }
  // Two addresses, one of them in brackets.
  expect(noteParts("Plans (https://featherless.ai/pricing), docs https://featherless.ai/docs").filter((p) => "url" in p)).toEqual([
    { url: "https://featherless.ai/pricing", label: "featherless.ai/pricing" },
    { url: "https://featherless.ai/docs", label: "featherless.ai/docs" },
  ]);
});

test("the line under the search box: a shortlist, a narrowing, an exact match, or nothing found", () => {
  expect(catalogSummary(search())).toBe("A few uncensored ones of the 22,406. Type a name to find another.");
  expect(catalogSummary(search({ q: "qwen3", matched: 1 }))).toBe("1 model matched.");
  expect(catalogSummary(search({ q: "qwen", models: Array.from({ length: 25 }, (_, i) => model({ id: `m${i}` })), matched: 6478 }))).toBe("6,478 matched. These are the first 25 — type more to narrow it down.");
  expect(catalogSummary(search({ q: "zzz", models: [], matched: 0 }))).toBe("Nothing matched “zzz”. Try part of a model's name, like qwen3 or abliterated.");
  // The service answered, but with nothing at all: that is a failure of the list, not an empty search.
  expect(catalogSummary(search({ models: [], matched: 0 }))).toBe("Couldn't list any models just now. Press Test again.");
});

test("the plan's limit holds a model's context down, and says so when it does", () => {
  expect(capContext(262_144, 32_768)).toBe(32_768);
  expect(capContext(32_768, 32_768)).toBe(32_768);
  expect(capContext(8_192, 32_768)).toBe(8_192);
  // No plan limit (every other service): a model's own size stands.
  expect(capContext(262_144, undefined)).toBe(262_144);
  expect(capContext(null, 32_768)).toBeNull();
  expect(capWords([model({ contextWindow: 262_144 })], 32_768)).toBe("Your plan reads 32k of a chat at once, so a model that could hold more is saved at 32k.");
  // Nothing to say when every model picked fits the plan anyway.
  expect(capWords([model()], 32_768)).toBeNull();
  expect(capWords([model({ contextWindow: 262_144 })], undefined)).toBeNull();
});

test("adding Featherless saves the model found by searching, with the context the plan really gives", () => {
  const preset = servicePreset("featherless")!;
  const r = result({ protocols: { responses: "no", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "adapter" }], catalog: { name: "featherless", total: 22_406 } });
  const body = saveBody({
    agent: "codex",
    result: r,
    preset,
    baseUrl: "https://api.featherless.ai",
    apiKey: "rc_key",
    label: "Featherless",
    models: [PICK, "Qwen/Qwen3-235B-A22B"],
    context: "",
    found: [model(), model({ id: "Qwen/Qwen3-235B-A22B", contextWindow: 262_144, params: 235, concurrency: 4 })],
  });
  expect(body).toEqual({
    provider: "codex",
    baseUrl: "https://api.featherless.ai",
    label: "Featherless",
    apiKey: "rc_key",
    models: [PICK, "Qwen/Qwen3-235B-A22B"],
    // The default model's size is what older hubs read; each model's own goes beside it, none of them bigger than the
    // 32K the plan serves at once.
    contextWindow: 32_768,
    protocol: "chat",
    contexts: { [PICK]: 32_768, "Qwen/Qwen3-235B-A22B": 32_768 },
  });
});

test("the one-tap searches are the ones that find a good uncensored model", () => {
  expect(CATALOG_CHIPS.map((c) => [c.label, c.q])).toEqual([
    ["Uncensored", ""],
    ["Qwen 3", "qwen3"],
    ["Kimi K2", "kimi-k2"],
  ]);
});

test("a long model list can be narrowed in a menu, by name or by id", () => {
  const models = [option("gpt-6.1-sol", { label: "GPT-6.1 Sol" }), option(PICK), option("Qwen/Qwen3-235B-A22B")];
  expect(findModels(models, "qwen3").map((m) => m.id)).toEqual([PICK, "Qwen/Qwen3-235B-A22B"]);
  expect(findModels(models, "SOL").map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
  expect(findModels(models, " ").map((m) => m.id)).toEqual(models.map((m) => m.id)); // nothing typed: nothing hidden
  expect(findModels(models, "nothing")).toEqual([]);

  // The box only appears on a list long enough to need it.
  const menu = (n: number) => renderToStaticMarkup(createElement(ModelChoices, { models: Array.from({ length: n }, (_, i) => option(`model-${i}`)), current: "model-0", note: "", onChoose: () => {} }));
  expect(menu(MODEL_FIND_FROM - 1)).not.toContain('aria-label="Find a model"');
  expect(menu(MODEL_FIND_FROM)).toContain('aria-label="Find a model"');
});
