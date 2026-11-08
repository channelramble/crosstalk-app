import { expect, test } from "bun:test";
import { toolCostWords, type ModelCatalog, type ToolCost } from "@crosstalk/shared";
import { contextLabel, contextSize, effortSelection, isCustomModel, isNewModel, measuredWhen, modelGroups, modelHelp, modelOptionText, toolCostLine, NEW_MODEL_MS } from "./models";
import { formatContext } from "./services";

const claude: ModelCatalog = { provider: "claude", live: true, models: [{ id: "opus", label: "Opus", isDefault: true, efforts: ["low", "high", "max"] } as never] };
const codex: ModelCatalog = { provider: "codex", live: true, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna", isDefault: true, efforts: ["low"] } as never] };

test("switching agent type: a model is never judged against the previous agent's list", () => {
  // Codex's saved default checked while Claude's list is still loaded: can't tell yet, so no "Other…" field.
  expect(isCustomModel("gpt-6-luna", claude, "codex")).toBeNull();
  // Once Codex's own list arrives, a listed model is not custom (both ways: this clears an earlier "Other…").
  expect(isCustomModel("gpt-6-luna", codex, "codex")).toBe(false);
  expect(isCustomModel("my-own-model", codex, "codex")).toBe(true);
  expect(isCustomModel("", codex, "codex")).toBe(false);
  expect(isCustomModel("opus", null, "claude")).toBeNull();
});

test("a model with no effort overrides clears a saved override, while an unloaded catalog preserves it", () => {
  const catalog: ModelCatalog = { provider: "antigravity", accountId: "work", live: true, error: null, models: [{ id: "gemini-3.8-flash-high", label: "Flash High", description: null, efforts: [], defaultEffort: "high", isDefault: true }] };
  expect(effortSelection(catalog, "antigravity", "gemini-3.8-flash-high", "max", "work")).toMatchObject({ known: true, levels: [], value: "" });
  expect(effortSelection(null, "antigravity", "gemini-3.8-flash-high", "max", "work")).toMatchObject({ known: false, value: "max" });
  expect(effortSelection(catalog, "antigravity", "gemini-3.8-flash-high", "max", "personal")).toMatchObject({ known: false, value: "max" });
  expect(effortSelection(catalog, "antigravity", "unlisted-model", "max", "work")).toMatchObject({ known: true, levels: [], value: "" });
  expect(effortSelection(codex, "codex", "gpt-6-luna", "high")).toMatchObject({ known: true, levels: ["low"], value: "" });
  expect(effortSelection(codex, "codex", "gpt-6-luna", "low").value).toBe("low");
});

test("a model catalog from another account of the same agent stays out of the selector", () => {
  const work = { ...codex, accountId: "work" };
  expect(isCustomModel("gpt-6-luna", codex, "codex", "work")).toBeNull();
  expect(isCustomModel("gpt-6-luna", work, "codex", "personal")).toBeNull();
  expect(isCustomModel("gpt-6-luna", work, "codex", "work")).toBe(false);
  expect(isCustomModel("my-model", work, "codex", "work")).toBe(true);
});

// EXPECTED TO FAIL on today's code (both expectations below): isCustomModel and effortSelection compare only `m.id`,
// while the chat's model row saves the concrete model (ChatControls.chooseModel: `model: next?.resolvedModel ?? id`).
// So a model picked under the message box ("Haiku 4.5" -> "claude-haiku-4-5-20251001") is judged "not in the list":
// the chat's settings open it in the "Other…" box as a typed-in name, and its effort menu offers every level the
// agent's other models take instead of Haiku's none.
test("a model saved as the concrete name behind its alias is still one of the agent's own", () => {
  const aliased: ModelCatalog = {
    provider: "claude",
    live: true,
    models: [
      { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "high"], isDefault: true },
      { id: "haiku", resolvedModel: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [], isDefault: false },
    ] as never,
  };
  expect(isCustomModel("claude-haiku-4-5-20251001", aliased, "claude")).toBe(false);
  // And its effort levels are Haiku's (none), not every level the other models take.
  expect(effortSelection(aliased, "claude", "claude-haiku-4-5-20251001", "high")).toMatchObject({ known: true, levels: [], value: "" });
});

test("context sizes read short, and a model's line says what it holds and whether it's new", () => {
  expect([1_000_000, 1_050_000, 272_000, 258_400, 200_000, 872_000, 400].map(contextSize)).toEqual(["1M", "1.05M", "272k", "258k", "200k", "872k", "1k"]);
  expect(contextLabel({ contextWindow: 1_000_000 })).toBe("1M context");
  expect(contextLabel({ contextWindow: 272_000, maxContextWindow: 872_000 })).toBe("272k context, up to 872k");
  expect(contextLabel({ contextWindow: 272_000, maxContextWindow: 272_000 })).toBe("272k context");
  expect(contextLabel({ contextWindow: null })).toBeNull();
  const now = Date.now();
  expect(isNewModel({ firstSeen: now - 60_000 }, now)).toBe(true);
  expect(isNewModel({ firstSeen: now - NEW_MODEL_MS - 1 }, now)).toBe(false);
  // 0 (or unknown): it was there when Crosstalk started keeping track.
  expect(isNewModel({ firstSeen: 0 }, now)).toBe(false);
  expect(isNewModel({}, now)).toBe(false);
  const astra = { id: "gpt-6-astra", label: "GPT-6-Astra", description: "Frontier model", efforts: [], defaultEffort: null, isDefault: false, contextWindow: 272_000, maxContextWindow: 872_000, firstSeen: Date.now() - 1000 };
  expect(modelOptionText(astra)).toBe("GPT-6-Astra · 272k · New");
  expect(modelOptionText({ ...astra, contextWindow: null, firstSeen: 0 })).toBe("GPT-6-Astra");
  // A custom model whose service says it can't run tool calls is marked, so a chat isn't started on one by mistake.
  expect(modelOptionText({ ...astra, firstSeen: 0, noTools: true })).toBe("GPT-6-Astra · 272k · No tools");
  expect(modelHelp(astra)).toBe("Frontier model · 272k context, up to 872k");
  expect(modelHelp({ ...astra, description: null, contextWindow: null })).toBeNull();
  expect(modelHelp(undefined)).toBeNull();
});

test("More models: the usual ones first, the agent's others apart, each in the agent's order, and the one in use always in view", () => {
  const m = (id: string, more = false) => ({ id, label: id, description: null, efforts: [], defaultEffort: null, isDefault: false, ...(more ? { more: true } : {}) });
  const ids = (g: { usual: { id: string }[]; more: { id: string }[] }) => [g.usual.map((x) => x.id), g.more.map((x) => x.id)];
  // An agent that names nothing more (Claude Code): no More models at all.
  expect(ids(modelGroups([m("opus"), m("sonnet"), m("haiku")]))).toEqual([["opus", "sonnet", "haiku"], []]);
  // Codex's hidden ones, wherever they are in its list.
  const codexList = [m("gpt-6.1-sol"), m("gpt-reserve", true), m("gpt-6-astra"), m("codex-auto-review", true)];
  expect(ids(modelGroups(codexList))).toEqual([["gpt-6.1-sol", "gpt-6-astra"], ["gpt-reserve", "codex-auto-review"]]);
  // A chat on one of them: it shows with the usual ones too, so the menu opens on it.
  expect(ids(modelGroups(codexList, "gpt-reserve"))).toEqual([["gpt-6.1-sol", "gpt-reserve", "gpt-6-astra"], ["gpt-reserve", "codex-auto-review"]]);
  expect(ids(modelGroups(codexList, "gpt-6-astra"))).toEqual([["gpt-6.1-sol", "gpt-6-astra"], ["gpt-reserve", "codex-auto-review"]]);
  expect(ids(modelGroups([], "anything"))).toEqual([[], []]);

  // The first list that had them dates them all now: they aren't news, so never marked New.
  const now = Date.now();
  expect(isNewModel({ firstSeen: now - 60_000, more: true }, now)).toBe(false);
  expect(isNewModel({ firstSeen: now - 60_000, more: false }, now)).toBe(true);
  const reserve = { ...m("gpt-reserve", true), label: "GPT-Reserve", description: "Fast and affordable agentic coding model.", contextWindow: 272_000, maxContextWindow: 872_000, firstSeen: now - 1000 };
  expect(modelOptionText(reserve)).toBe("GPT-Reserve · 272k");
  // The help under a chosen one says what the agent says of it, as for any model.
  expect(modelHelp(reserve)).toBe("Fast and affordable agentic coding model. · 272k context, up to 872k");
});

// ---- What Codex's tools cost on a model, where it is picked and in Settings → AI services ----
//
// The figures are a real measurement: a first "hi!" to a 16k local model carried 361 tools and 134,000 tokens of schemas, most of
// it ChatGPT app connectors (hub/src/adapter/cost.ts measures each request; nothing is said for a model never used).

const NOON = new Date(2026, 9, 30, 12).getTime();
const cost = (over: Partial<ToolCost> = {}): ToolCost => ({ at: NOON, model: "qwen3-8b", tools: 133_500, toolCount: 361, prompt: 141_085, window: 16_384, dropped: 343, ...over });

test("what the tools cost reads as one plain sentence: the estimate rounded, the model's own size exact, and when it was taken", () => {
  // One plain sentence: what Codex's tools take, then what this model holds.
  expect(toolCostWords(cost(), { when: "today" })).toBe("Codex's tools take about 134,000 tokens; this model holds 16,384. Crosstalk leaves 343 of them out so a chat can start. Measured today.");
  // A service's row covers several models, so there it says which one was measured.
  expect(toolCostWords(cost(), { model: "qwen3-8b", when: "on October 29" })).toBe("Codex's tools take about 134,000 tokens; qwen3-8b holds 16,384. Crosstalk leaves 343 of them out so a chat can start. Measured on October 29.");
  // A server that never said what it holds: the tools still cost what they cost, and nothing is invented to hold them against.
  expect(toolCostWords(cost({ window: null, dropped: undefined }), { when: "today" })).toBe("Codex's tools take about 134,000 tokens. Measured today.");
  // A model with room for all of them says so by saying nothing about what went.
  expect(toolCostWords(cost({ tools: 133_500, window: 1_048_576, dropped: undefined }))).toBe("Codex's tools take about 134,000 tokens; this model holds 1,048,576.");
  // Crosstalk's own tools are 919 of those tokens: a small figure is said as it is, not rounded to nothing.
  expect(toolCostWords(cost({ tools: 919, toolCount: 6, dropped: undefined, window: null }))).toBe("Codex's tools take about 919 tokens.");
  // Nothing measured, or a measurement of nothing: no sentence at all.
  expect(toolCostWords(null)).toBeNull();
  expect(toolCostWords(cost({ tools: 0 }))).toBeNull();
});

test("the line is shown where it changes a decision, and a service's row always shows it", () => {
  // A small local model: the tools are eight times the window, and most of them are left out for a chat to start at all.
  expect(toolCostLine(cost(), { now: NOON })).toContain("Codex's tools take about 134,000 tokens; this model holds 16,384.");
  expect(toolCostLine(cost(), { now: NOON })).toContain("Measured today.");
  // A model with room to spare says nothing under the picker: a figure that changes nothing is noise on a phone.
  const roomy = cost({ tools: 133_500, window: 1_048_576, dropped: undefined });
  expect(toolCostLine(roomy, { now: NOON })).toBeNull();
  // Settings → AI services is where a person goes to look it up, so there it is said whatever it is.
  expect(toolCostLine(roomy, { name: "kimi-k3.1-pro", always: true, now: NOON })).toBe("Codex's tools take about 134,000 tokens; kimi-k3.1-pro holds 1,048,576. Measured today.");
  // Half the window or more, or no window known: worth saying before a chat starts.
  expect(toolCostLine(cost({ tools: 8_200, dropped: undefined }), { now: NOON })).toContain("8,000 tokens");
  expect(toolCostLine(cost({ tools: 8_000, window: 1_000_000, dropped: undefined }), { now: NOON })).toBeNull();
  expect(toolCostLine(cost({ window: null, dropped: undefined }), { now: NOON })).toContain("134,000 tokens");
  // A model no request has gone to has nothing measured, and so says nothing at all.
  expect(toolCostLine(undefined)).toBeNull();
  expect(toolCostLine(null, { always: true })).toBeNull();
});

test("when it was measured is said in the phone's own words, and never guessed", () => {
  expect(measuredWhen(NOON, NOON)).toBe("today");
  expect(measuredWhen(new Date(2026, 9, 30, 0, 5).getTime(), NOON)).toBe("today");
  expect(measuredWhen(new Date(2026, 9, 29, 23, 50).getTime(), NOON)).toBe("yesterday");
  expect(measuredWhen(new Date(2026, 9, 24, 9).getTime(), NOON)).toBe("on October 24");
  // Nothing, or a hub whose clock is ahead of this phone's: say nothing rather than "in the future".
  expect(measuredWhen(0, NOON)).toBeNull();
  expect(measuredWhen(undefined, NOON)).toBeNull();
  expect(measuredWhen(NOON + 3600_000, NOON)).toBeNull();
  // A measurement a minute in the future is the two clocks disagreeing, not a lie: it still counts as today.
  expect(measuredWhen(NOON + 30_000, NOON)).toBe("today");
});

// EXPECTED TO FAIL on today's code: one model, two sizes.
//
// A model's context is written twice in this app. Settings → AI services (and everything in the Add sheet) uses
// `formatContext` in web/src/services.ts, which knows a binary size when it sees one: 32768 is "32k". The model menus,
// the model drop-downs and the chat's context ring use `contextSize` here, which divides by 1000 and rounds: 32768 is
// "33k". So a llama.cpp model at 32,768, and every Featherless model held to the plan's 32,768, is offered as "32k"
// while it is being added and reads "33k context" in the menu where it is picked and "of 33k" on the ring — and
// Kimi's 1,048,576 is "1M" in one place and "1.05M" in the other. Neither is wrong arithmetic; two answers to one
// question is what's wrong. The fix is one function for both (services.ts formatContext handles the decimal sizes
// Claude Code and Codex give too: 272,000 → "272k", 1,050,000 → "1.05M" needs its 2-decimal case keeping).
test("a model's size reads the same wherever it is shown", () => {
  // The sizes a local server, Featherless and the Kimi preset really give.
  expect(contextSize(32_768)).toBe(formatContext(32_768));
  expect(contextSize(131_072)).toBe(formatContext(131_072));
  expect(contextSize(262_144)).toBe(formatContext(262_144));
  expect(contextSize(1_048_576)).toBe(formatContext(1_048_576));
  // What a person calls them.
  expect(contextSize(32_768)).toBe("32k");
  expect(contextLabel({ contextWindow: 32_768 })).toBe("32k context");
  expect(modelOptionText({ id: "qwen3-coder:30b", label: "qwen3-coder:30b", description: null, efforts: [], defaultEffort: null, isDefault: false, contextWindow: 32_768 })).toBe("qwen3-coder:30b · 32k");
});
