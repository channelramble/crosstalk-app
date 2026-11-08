import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AskChoice, AskModel, ToolCost } from "@crosstalk/shared";
import type { AskModelPick } from "./asks";

// The Ask others sheet's rows with a model picker (newer than 0.6.1), as the person sees them: a row's name and cost badge follow the model
// picked for it, and once it's ticked the model picker the other screens use (AgentOptions) is under it, on the models the hub
// listed, with their sizes, "No tools" marks and the lines that say what a model costs to run. Nothing here sends a request:
// a pick is state until Ask.

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { AskRow } = await import("./views/AskSheet");
const { AskModelPicker } = await import("./views/AskModelPicker");

/** The words on screen: tags stripped, entities read. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x2192;/g, "→").replace(/\s+/g, " ").trim();
/** The choices of the select named `name`, as their words. */
const options = (html: string, name: string) => {
  const select = new RegExp(`<select[^>]*aria-label="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? "";
  return [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
};

const model = (id: string, label: string, patch: Partial<AskModel> = {}): AskModel => ({ id, label, description: null, efforts: [], defaultEffort: null, isDefault: false, paid: "no", typicalCostUsd: null, ...patch });
const CODEX: AskChoice = {
  target: { provider: "codex", account: "default", model: "gpt-5.5", effort: "medium" },
  label: "Codex · GPT-5.5",
  sub: "Plan",
  handle: "codex",
  paid: "no",
  local: false,
  available: true,
  why: null,
  typicalCostUsd: null,
  models: [
    model("gpt-5.5", "GPT-5.5", { isDefault: true, description: "Latest workhorse.", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000, maxContextWindow: 872_000 }),
    model("gpt-5.5-mini", "GPT-5.5 Mini", { efforts: ["low", "medium"], defaultEffort: "low", contextWindow: 200_000 }),
    model("gpt-chat", "GPT Chat", { noTools: true, contextWindow: 32_768, more: true }),
  ],
};
const KEY: AskChoice = {
  ...CODEX,
  target: { provider: "claude", account: "work", model: "opus", effort: null },
  label: "Claude Code (Work) · Opus 5.5",
  sub: "API key",
  handle: "work",
  paid: "yes",
  typicalCostUsd: 0.12,
  models: [model("opus", "Opus 5.5", { isDefault: true, paid: "yes", typicalCostUsd: 0.12 }), model("sonnet", "Sonnet 4.6", { paid: "yes", typicalCostUsd: 0.03 })],
};
const PC = { id: "h_pc", name: "PC" };

const renderRow = (choice: AskChoice, pick: AskModelPick, on = true) => renderToStaticMarkup(createElement("ul", null, createElement(AskRow, { choice, pick, on, detailId: "d1", onToggle: () => {}, onPick: () => {} })));
const renderPicker = (choice: AskChoice, pick: AskModelPick) => renderToStaticMarkup(createElement(AskModelPicker, { choice, pick, onChange: () => {} }));

test("a row's name and badge follow the model picked for it; its picker only shows once it's ticked", () => {
  const off = renderRow(KEY, { model: "sonnet", effort: "" }, false);
  expect(off).toContain('aria-label="Claude Code (Work) · Sonnet 4.6"');
  expect(words(off)).toContain("Claude Code (Work) · Sonnet 4.6 Costs money Online");
  expect(off).not.toContain("<select");
  const on = renderRow(KEY, { model: "sonnet", effort: "" });
  expect(on).toContain('role="group" aria-label="Model for Claude Code (Work)"');
  // The picker is beside the row's checkbox, not inside it: a tap on it doesn't untick the row.
  expect(on.indexOf("</label><div")).toBeGreaterThan(on.indexOf('type="checkbox"'));
  expect(words(on)).toContain("Asks on Sonnet 4.6 have cost about $0.03 each.");
});

test("an agent's picker is the main one: its models with sizes and marks, More models apart, its effort levels, and no typed-in name", () => {
  const html = renderPicker(CODEX, { model: "", effort: "" });
  expect(options(html, "Model")).toEqual(["Default (GPT-5.5)", "GPT-5.5 · 272k", "GPT-5.5 Mini · 200k", "GPT Chat · 32k · No tools"]);
  expect(html).toContain('<optgroup label="More models">');
  // Only models it can say the size and cost of: no "Other…".
  expect(html).not.toContain("Other…");
  expect(words(html)).toContain("Latest workhorse. · 272k context, up to 872k");
  expect(options(html, "Effort")).toEqual(["Default (Medium)", "Low", "Medium", "High"]);
  expect(words(html)).toContain("How hard it thinks before answering.");
  // A plan's asks aren't billed: no money line.
  expect(words(html)).not.toContain("have cost about");
  // A model the service says can't run tools says so where it's picked, and it has no effort levels.
  const chat = renderPicker(CODEX, { model: "gpt-chat", effort: "" });
  expect(words(chat)).toContain("No tools");
  expect(chat).toContain('class="no-tools"');
  expect(chat).not.toContain('aria-label="Effort"');
});

test("what Codex's tools cost on a model is said in the ask's picker too, as in the main one", () => {
  const cost: ToolCost = { at: Date.now(), model: "qwen3-8b", tools: 133_500, toolCount: 361, prompt: 141_085, window: 16_384, dropped: 343 };
  const local: AskChoice = { ...CODEX, target: { provider: "codex", account: "qwen1", model: "qwen3-8b", effort: null }, label: "Qwen here · qwen3-8b", local: true, models: [model("qwen3-8b", "qwen3-8b", { isDefault: true, contextWindow: 16_384, toolCost: cost }), model("qwen3-30b", "qwen3-30b", { contextWindow: 65_536 })] };
  const shown = words(renderPicker(local, { model: "", effort: "" }));
  expect(shown).toContain("Codex's tools take about 134,000 tokens; this model holds 16,384.");
  expect(shown).toContain("Measured today.");
});

test("a row whose model can't be picked here says why, and where to change it", () => {
  const pool: AskChoice = { ...CODEX, target: { provider: "claude", account: "pool1", model: "qwen-pool", effort: null }, label: "Model pool · qwen-pool", models: undefined, fixedModel: "pool" };
  expect(words(renderPicker(pool, { model: "", effort: "" }))).toBe("The model pool runs one model at a time. To ask another, change it in Settings → Model pool.");
  const older: AskChoice = { ...CODEX, target: { ...CODEX.target, machine: PC.id }, label: "Codex · GPT-5.5 · on the PC", machine: PC, models: undefined, fixedModel: "update" };
  expect(words(renderPicker(older, { model: "", effort: "" }))).toBe("To pick its model from here, update Crosstalk on the PC. Until then it answers with the model the PC uses.");
  // A hub of 0.6.1 or older (no models, nothing said): the row is as it always was.
  expect(renderPicker({ ...CODEX, models: undefined }, { model: "", effort: "" })).toBe("");
  // One model and no levels: nothing to pick.
  expect(renderPicker({ ...CODEX, models: [model("only", "only", { isDefault: true })] }, { model: "", effort: "" })).toBe("");
});

test("another machine's agent: its picker says where it runs, and offers that machine's models", () => {
  const remote: AskChoice = { ...KEY, target: { provider: "claude", account: "default", model: "opus", effort: null, machine: PC.id }, label: "Claude Code · Opus 5.5 · on the PC", machine: PC };
  const html = renderRow(remote, { model: "sonnet", effort: "" });
  expect(html).toContain('aria-label="Claude Code · Sonnet 4.6 · on the PC"');
  expect(html).toContain('aria-label="Model for Claude Code on the PC"');
  expect(options(html, "Model")).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Sonnet 4.6"]);
  expect(words(html)).toContain("On another of your machines");
});
