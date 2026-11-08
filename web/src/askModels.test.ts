import { expect, test } from "bun:test";
import type { Ask, AskChoice, AskModel } from "@crosstalk/shared";
import { askCostHint, askEffortWords, askMemo, askModelCostLine, askPickerFor, askRowKey, askTargetKey, fixedModelLine, initialPick, nextPick, pickableModels, pickedModel, withPick } from "./asks";

// Picking the model in Ask others (newer than 0.6.1): what a row's pick means for what's asked, what it's called, what it costs, and what
// the hub is asked to keep. The rows are as GET /api/asks/targets?models=1 sends them.

const model = (id: string, label: string, patch: Partial<AskModel> = {}): AskModel => ({ id, label, description: null, efforts: [], defaultEffort: null, isDefault: false, paid: "no", typicalCostUsd: null, ...patch });
const CODEX_MODELS = [
  model("gpt-5.5", "GPT-5.5", { isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 }),
  model("gpt-5.5-mini", "GPT-5.5 Mini", { efforts: ["low", "medium"], defaultEffort: "low" }),
  model("gpt-chat", "GPT Chat", { noTools: true }),
];
const row = (patch: Partial<AskChoice> = {}): AskChoice => ({
  target: { provider: "codex", account: "default", model: "gpt-5.5", effort: "medium" },
  label: "Codex · GPT-5.5",
  sub: "Plan",
  handle: "codex",
  paid: "no",
  local: false,
  available: true,
  why: null,
  typicalCostUsd: null,
  models: CODEX_MODELS,
  ...patch,
});
const KEY_MODELS = [model("opus", "Opus 5.5", { isDefault: true, paid: "yes", typicalCostUsd: 0.12 }), model("sonnet", "Sonnet 4.6", { paid: "yes", typicalCostUsd: 0.03 }), model("haiku", "Haiku 4.5", { paid: "yes" })];
const KEY = row({ target: { provider: "claude", account: "work", model: "opus", effort: null }, label: "Claude Code (Work) · Opus 5.5", sub: "API key", handle: "work", paid: "yes", typicalCostUsd: 0.12, models: KEY_MODELS });
const PC = { id: "h_pc", name: "PC" };
const REMOTE = row({ target: { provider: "claude", account: "default", model: "opus", effort: null, machine: PC.id }, label: "Claude Code · Opus 5.5 · on the PC", handle: "claude-on-pc", machine: PC, models: [model("opus", "Opus 5.5", { isDefault: true }), model("sonnet", "Sonnet 4.6")] });

test("a row is the same row whichever model it's on: the agent, the account and the machine", () => {
  expect(askRowKey(row().target)).toBe("codex|default");
  expect(askRowKey({ ...row().target, model: "gpt-chat", effort: null })).toBe("codex|default");
  expect(askRowKey(REMOTE.target)).toBe("claude|default|h_pc");
  // The old key changes with the model, which is why the sheet doesn't use it for what's ticked.
  expect(askTargetKey(row().target)).not.toBe(askTargetKey({ ...row().target, model: "gpt-chat" }));
});

test("a row opens on the pick the hub kept for it, else on its defaults", () => {
  expect(initialPick(row())).toEqual({ model: "", effort: "" });
  expect(initialPick(row({ remembered: { model: "gpt-5.5-mini", effort: null } }))).toEqual({ model: "gpt-5.5-mini", effort: "" });
  expect(initialPick(row({ remembered: { model: null, effort: "high" } }))).toEqual({ model: "", effort: "high" });
});

test("a picker only where there's something to pick", () => {
  expect(pickableModels(row())).toBe(CODEX_MODELS);
  // One model, but effort levels: still worth a picker.
  expect(pickableModels(row({ models: [CODEX_MODELS[0]] }))).toHaveLength(1);
  // One model and no levels, none at all, an older hub's row, a row that can't be asked, a fixed model: nothing.
  expect(pickableModels(row({ models: [CODEX_MODELS[2]] }))).toBeNull();
  expect(pickableModels(row({ models: [] }))).toBeNull();
  expect(pickableModels(row({ models: undefined }))).toBeNull();
  expect(pickableModels(row({ available: false, why: "Not signed in" }))).toBeNull();
  expect(pickableModels(row({ fixedModel: "pool" }))).toBeNull();
});

test("the default pick stands for the model the hub's list marks, whatever the row was on", () => {
  expect(pickedModel(row(), { model: "", effort: "" })!.id).toBe("gpt-5.5");
  expect(pickedModel(row({ target: { ...row().target, model: "gpt-5.5-mini" }, remembered: { model: "gpt-5.5-mini", effort: null } }), { model: "", effort: "" })!.id).toBe("gpt-5.5");
  expect(pickedModel(row(), { model: "gpt-chat", effort: "" })!.label).toBe("GPT Chat");
  // A list with nothing marked: the model the hub put the row on.
  expect(pickedModel(row({ models: CODEX_MODELS.map((m) => ({ ...m, isDefault: false })) }), { model: "", effort: "" })!.id).toBe("gpt-5.5");
  expect(pickedModel(row(), { model: "gone", effort: "" })).toBeUndefined();
});

test("a new model that doesn't take the effort picked goes back to its own default effort", () => {
  expect(nextPick(row(), { model: "gpt-5.5-mini", effort: "high" })).toEqual({ model: "gpt-5.5-mini", effort: "" });
  expect(nextPick(row(), { model: "gpt-5.5-mini", effort: "medium" })).toEqual({ model: "gpt-5.5-mini", effort: "medium" });
  expect(nextPick(row(), { model: "gpt-chat", effort: "low" })).toEqual({ model: "gpt-chat", effort: "" });
  expect(nextPick(row(), { model: "", effort: "high" })).toEqual({ model: "", effort: "high" });
});

test("the row as it will be asked: the model and effort named, its name on that model, and that model's cost", () => {
  // The defaults: the model and effort the hub would use, named, so the card and the costs say which.
  expect(withPick(row(), { model: "", effort: "" })).toMatchObject({ target: { provider: "codex", account: "default", model: "gpt-5.5", effort: "medium" }, label: "Codex · GPT-5.5" });
  expect(withPick(row(), { model: "gpt-5.5-mini", effort: "medium" })).toMatchObject({ target: { model: "gpt-5.5-mini", effort: "medium" }, label: "Codex · GPT-5.5 Mini", handle: "codex" });
  // A model with no levels runs at none.
  expect(withPick(row(), { model: "gpt-chat", effort: "" }).target.effort).toBeNull();
  // An API key: what asks on that model cost, for the badge and the sum under the list.
  const sonnet = withPick(KEY, { model: "sonnet", effort: "" });
  expect(sonnet).toMatchObject({ label: "Claude Code (Work) · Sonnet 4.6", paid: "yes", typicalCostUsd: 0.03, target: { provider: "claude", account: "work", model: "sonnet", effort: null } });
  expect(askCostHint([sonnet])).toBe("Costs money: about $0.03");
  expect(askCostHint([withPick(KEY, { model: "haiku", effort: "" })])).toBe("Costs money. We can't guess how much yet.");
  // On another machine: the machine stays at the end of its name, and in its target.
  expect(withPick(REMOTE, { model: "sonnet", effort: "" })).toMatchObject({ label: "Claude Code · Sonnet 4.6 · on the PC", target: { model: "sonnet", machine: "h_pc" } });
  // What the picker doesn't cover is asked exactly as the hub listed it.
  const old = row({ models: undefined });
  expect(withPick(old, { model: "gpt-chat", effort: "" })).toBe(old);
  const pool = row({ models: undefined, fixedModel: "pool" });
  expect(withPick(pool, { model: "", effort: "" })).toBe(pool);
  expect(withPick(row(), undefined)).toEqual(row());
});

test("what the hub is asked to keep: the pick as the sheet showed it, null for a default; nothing for a row with no picker", () => {
  expect(askMemo(row(), { model: "", effort: "" }, true)).toEqual({ provider: "codex", account: "default", model: null, effort: null });
  expect(askMemo(row(), { model: "gpt-5.5-mini", effort: "low" }, true)).toEqual({ provider: "codex", account: "default", model: "gpt-5.5-mini", effort: "low" });
  expect(askMemo(REMOTE, { model: "sonnet", effort: "" }, true)).toEqual({ provider: "claude", account: "default", machine: "h_pc", model: "sonnet", effort: null });
  expect(askMemo(row({ models: undefined }), { model: "", effort: "" }, true)).toBeNull();
  expect(askMemo(row({ fixedModel: "pool", models: undefined }), { model: "", effort: "" }, true)).toBeNull();
});

test("a row asked as it opened is kept only when it opened on a kept pick: one on its default because its kept model is missing for now forgets nothing", () => {
  // The hub kept GPT-5.5 Mini, but Codex's list doesn't have it right now: the row opened on its default (no `remembered`).
  // Asked untouched, nothing is sent for it, so the pick is still there when the model is listed again.
  expect(askMemo(row(), { model: "", effort: "" }, false)).toBeNull();
  // Picked here, even back to the default: that's the person's pick.
  expect(askMemo(row(), { model: "", effort: "" }, true)).toEqual({ provider: "codex", account: "default", model: null, effort: null });
  // Opened on the kept pick and asked as it is: kept again (it stays the newest).
  const kept = row({ target: { provider: "codex", account: "default", model: "gpt-5.5-mini", effort: "medium" }, remembered: { model: "gpt-5.5-mini", effort: "medium" } });
  expect(askMemo(kept, initialPick(kept), false)).toEqual({ provider: "codex", account: "default", model: "gpt-5.5-mini", effort: "medium" });
});

test("who a picker is for, and why a row has none, in plain words with where to change it", () => {
  expect(askPickerFor(row())).toBe("Codex");
  expect(askPickerFor(KEY)).toBe("Claude Code (Work)");
  expect(askPickerFor(REMOTE)).toBe("Claude Code on the PC");
  expect(fixedModelLine(row({ fixedModel: "pool" }))).toBe("The model pool runs one model at a time. To ask another, change it in Settings → Model pool.");
  expect(fixedModelLine({ fixedModel: "pool", machine: PC })).toBe("The model pool runs one model at a time. To ask another, change it in Settings → Model pool on the PC.");
  expect(fixedModelLine({ fixedModel: "update", machine: PC })).toBe("To pick its model from here, update Crosstalk on the PC. Until then it answers with the model the PC uses.");
  expect(fixedModelLine(row())).toBeNull();
});

test("what asks on the picked model have cost: only money, only from earlier asks", () => {
  expect(askModelCostLine(KEY_MODELS[1])).toBe("Asks on Sonnet 4.6 have cost about $0.03 each.");
  expect(askModelCostLine(KEY_MODELS[2])).toBeNull(); // no asks on it yet
  expect(askModelCostLine(model("gpt-5.5", "GPT-5.5", { paid: "no", typicalCostUsd: 0.2 }))).toBeNull(); // a plan's figure isn't a bill
  expect(askModelCostLine(model("qwen", "qwen", { paid: "unknown", typicalCostUsd: 0.01 }), true)).toBeNull(); // on this machine: free
  expect(askModelCostLine(model("kimi-k2", "kimi-k2", { paid: "unknown", typicalCostUsd: 0.004 }))).toBe("Asks on kimi-k2 have cost about <$0.01 each.");
  expect(askModelCostLine(undefined)).toBeNull();
});

test("a card says how hard it was asked to think, beside the model in its name", () => {
  const card = (effort: string | null) => askEffortWords({ target: { provider: "codex", account: "default", model: "gpt-5.5", effort } } as Pick<Ask, "target">);
  expect(card("high")).toBe("High effort");
  expect(card("xhigh")).toBe("Extra high effort");
  expect(card("ultra")).toBe("Ultra effort");
  expect(card("turbo")).toBe("turbo effort");
  expect(card(null)).toBeNull();
});
