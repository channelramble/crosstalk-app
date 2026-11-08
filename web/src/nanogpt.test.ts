// What Settings → AI services says about NanoGPT (web/src/services.ts): its search's summary and chips, a model's price
// beside its name, and what an account has left to spend — as plain functions, without a hub.
import { expect, test } from "bun:test";
import type { AgentAccount, CatalogModel, CatalogSearch, ServiceFunds, ServiceTestResult } from "@crosstalk/shared";
import { servicePreset } from "./presets";
import { NANOGPT_CHIPS, catalogChips, catalogFacts, catalogPath, catalogPlaceholder, catalogSummary, chooseAgent, fundsLines, fundsWords, isNanoGpt, kindLine, priceLine, protocolFor, serviceFixLine, testLines, tokenCount, usd } from "./services";

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: "deepseek/deepseek-v4.1-flash-uncensored",
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
  ...over,
});
const search = (over: Partial<CatalogSearch> = {}): CatalogSearch => ({ name: "nanogpt", q: "", filter: "uncensored", models: [model()], matched: 43, total: 644, ...over });
const funds = (over: Partial<ServiceFunds> = {}): ServiceFunds => ({ balanceUsd: 5, plan: null, checkedAt: 0, ...over });
const plan = (over: Partial<NonNullable<ServiceFunds["plan"]>> = {}): NonNullable<ServiceFunds["plan"]> => ({ active: true, billing: "subscription", weekly: { used: 2_500_000, limit: 60_000_000, resetAt: null }, daily: null, renewsAt: null, ...over });

test("the NanoGPT preset: Crosstalk's own agent first, Codex through the adapter, and what it costs in plain words", () => {
  const p = servicePreset("nanogpt")!;
  expect(p).toMatchObject({ title: "NanoGPT", baseUrl: "https://nano-gpt.com/api", kind: "hosted", agent: "builtin", protocol: "chat", keyPage: { url: "https://nano-gpt.com/api" } });
  expect(p.plan).toContain("$12-a-month subscription");
  expect(p.note).toContain("no other agent involved");
  const checked: ServiceTestResult = {
    reachable: true,
    authOk: true,
    server: null,
    protocols: { responses: "yes", messages: "yes", chat: "yes" },
    models: [],
    works: [{ provider: "builtin", via: "chat" }, { provider: "opencode", via: "chat" }, { provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }],
    problems: [],
    catalog: { name: "nanogpt", total: 644 },
  };
  // Crosstalk's agent is picked for you; it and OpenCode speak Chat Completions themselves, Codex through the adapter, Claude Code Messages.
  expect(chooseAgent(checked, p.agent)).toBe("builtin");
  expect(chooseAgent(checked, p.agent, null, { opencode: false })).toBe("builtin");
  expect(protocolFor(checked, "builtin", p)).toBe("chat");
  expect(protocolFor(checked, "opencode", p)).toBe("chat");
  expect(protocolFor(checked, "codex", p)).toBe("chat");
  expect(protocolFor(checked, "claude", p)).toBe("messages");
  // Only Codex's line says "through the chat adapter": Crosstalk's agent and OpenCode have no adapter in between.
  expect(testLines(checked, p).filter((l) => l.text.startsWith("Works with")).map((l) => [l.text, !!l.adapter])).toEqual([
    ["Works with Crosstalk agent", false],
    ["Works with OpenCode", false],
    ["Works with Codex", true],
    ["Works with Claude Code", false],
  ]);
});

test("a NanoGPT account on Crosstalk's agent: its row's words, and where it is changed and removed", () => {
  const a: AgentAccount = { provider: "builtin", id: "nano1", label: "NanoGPT", kind: "endpoint", signedIn: true, account: null, plan: "Custom model", authMethod: "endpoint", error: null, checkedAt: 0, endpoint: { baseUrl: "https://nano-gpt.com/api", models: ["deepseek/deepseek-v4.1-flash-uncensored"], contextWindow: 1_048_576, hasKey: true, protocol: "chat" } };
  expect(kindLine(a)).toBe("Crosstalk agent · Custom model · nano-gpt.com");
  expect(serviceFixLine(a)).toBe("Change its address, key or models with Change, or take it away with Remove.");
  expect(kindLine({ ...a, provider: "codex" })).toBe("Codex · Custom model · nano-gpt.com · chat adapter");
  // On OpenCode it reads the same: its services are changed and removed on their own rows too, and no adapter is in between.
  expect(kindLine({ ...a, provider: "opencode" })).toBe("OpenCode · Custom model · nano-gpt.com");
  expect(serviceFixLine({ ...a, provider: "opencode" })).toBe("Change its address, key or models with Change, or take it away with Remove.");
});

test("a model's price beside its name: in and out per million, and cached input when it's priced apart", () => {
  expect(priceLine({ input: 0.33, output: 1.32, cached: 0.00825 })).toBe("$0.33 in, $1.32 out per million (cached $0.008)");
  expect(priceLine({ input: 1.25, output: 2.25, cached: 0.3 })).toBe("$1.25 in, $2.25 out per million (cached $0.30)");
  expect(priceLine({ input: 4, output: 20, cached: null })).toBe("$4 in, $20 out per million");
  // A cache price that isn't cheaper says nothing new.
  expect(priceLine({ input: 0.2, output: 0.9, cached: 0.2 })).toBe("$0.20 in, $0.90 out per million");
  expect(priceLine(undefined)).toBeNull();
  expect(catalogFacts(model())).toBe("1M · $0.33 in, $1.32 out per million (cached $0.008)");
});

test("NanoGPT's search words: what part of its list is on show, and how to narrow it down", () => {
  expect(catalogSummary(search({ models: Array.from({ length: 25 }, () => model()) }))).toBe("43 uncensored models of the 644, the ones that can run tools first, then the newest. These are the first 25 — type more to narrow it down.");
  expect(catalogSummary(search({ filter: "plan", matched: 3, models: [model(), model(), model()] }))).toBe("3 models in NanoGPT's subscription of the 644, the ones that can run tools first, then the newest.");
  expect(catalogSummary(search({ q: "glm", filter: "all", matched: 2, models: [model(), model()] }))).toBe("2 models matched among the models.");
  expect(catalogSummary(search({ q: "kimi", models: [], matched: 0 }))).toBe("No uncensored models matched “kimi”. Try part of a name, like deepseek or glm, or tap All models.");
  // Featherless keeps its own words.
  expect(catalogSummary({ name: "featherless", q: "", models: [model()], matched: 544, total: 22_406 })).toBe("A few uncensored ones of the 22,406. Type a name to find another.");
});

test("NanoGPT's chips switch the part of its list, and its search address says which", () => {
  expect(catalogChips("nanogpt")).toBe(NANOGPT_CHIPS);
  expect(NANOGPT_CHIPS.map((c) => c.label)).toEqual(["Uncensored", "In subscription", "DeepSeek", "GLM", "Qwen", "All models"]);
  expect(catalogChips("featherless").map((c) => c.label)).toEqual(["Uncensored", "Qwen 3", "Kimi K2"]);
  expect(catalogPath("nanogpt", " glm ", "plan")).toBe("/api/services/catalog?name=nanogpt&q=glm&filter=plan");
  // Featherless has no parts: no filter is ever sent there.
  expect(catalogPath("featherless", "qwen3", "plan")).toBe("/api/services/catalog?name=featherless&q=qwen3");
  expect(catalogPlaceholder("nanogpt")).toContain("deepseek");
});

test("what an account has to spend: its balance, its allowance, and an allowance that's used up", () => {
  expect(fundsLines(funds())).toEqual([{ ok: true, text: "Balance $5.00" }]);
  expect(fundsLines(funds({ plan: plan() }))).toEqual([
    { ok: true, text: "Balance $5.00" },
    { ok: true, text: "Subscription active: 2.5M of 60M tokens used this week" },
  ]);
  expect(fundsWords(funds({ balanceUsd: 0, plan: plan({ billing: "paygo", weekly: { used: 60_000_000, limit: 60_000_000, resetAt: null } }) }))).toBe(
    "Balance $0.00 · Subscription allowance used up (60M of 60M tokens used this week): covered models spend your balance until it resets",
  );
  // Nothing left and nothing covering it: a ✗, because every reply would be refused.
  expect(fundsLines(funds({ balanceUsd: 0 }))[0]).toEqual({ ok: false, text: "Balance $0.00" });
  // A balance NanoGPT didn't say is left unsaid, never shown as $0.
  expect(fundsLines(funds({ balanceUsd: null, plan: plan({ active: false }) }))).toEqual([{ ok: false, text: "Subscription not active" }]);
  expect(usd(0.004)).toBe("$0.004");
  expect([tokenCount(950), tokenCount(12_400), tokenCount(2_540_000), tokenCount(60_000_000)]).toEqual(["950", "12k", "2.5M", "60M"]);
});

test("a NanoGPT check lists the balance after what it found; any other check doesn't", () => {
  const r: ServiceTestResult = {
    reachable: true,
    authOk: true,
    server: null,
    protocols: { responses: "yes", messages: "yes", chat: "yes" },
    models: [],
    works: [{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }],
    problems: [],
    catalog: { name: "nanogpt", total: 644 },
    funds: funds({ plan: plan() }),
  };
  expect(testLines(r, servicePreset("nanogpt")).map((l) => l.text)).toEqual(["Reachable", "Key works", "644 models to search", "Works with Codex", "Works with Claude Code", "Balance $5.00", "Subscription active: 2.5M of 60M tokens used this week"]);
  const { funds: _drop, ...plain } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
  expect(testLines(plain).some((l) => l.text.startsWith("Balance"))).toBe(false);
});

test("which accounts are on NanoGPT: its own hosts, whichever way the address was written", () => {
  expect(isNanoGpt("https://nano-gpt.com/api")).toBe(true);
  expect(isNanoGpt("https://api.nano-gpt.com/api/v1")).toBe(true);
  expect(isNanoGpt("https://not-nano-gpt.com.example")).toBe(false);
  expect(isNanoGpt("https://api.venice.ai/api")).toBe(false);
  expect(isNanoGpt(null)).toBe(false);
});
