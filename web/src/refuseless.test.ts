// What Settings → AI services says about Refuseless (web/src/services.ts): its preset, its models with their names,
// prices and the uncensored ones ticked, and what the account has left to spend — as plain functions, without a hub.
import { expect, test } from "bun:test";
import { permissionInfo, type ServiceTestResult } from "@crosstalk/shared";
import { presetSteps, servicePreset } from "./presets";
import { UNCENSORED_PICK_WORDS, choiceFacts, chooseAgent, fundsEmpty, fundsLines, fundsSite, fundsWords, initialSelection, isRefuseless, modelChoices, protocolFor, showsFunds, testLines } from "./services";

const PICK = "deepseek-v4.1-flash-abliterated";

/** A check of Refuseless as a 0.6.5 hub answers it (hub/test/refuseless.test.ts): its lineup in order, with what the hub knows. */
const checked = (over: Partial<ServiceTestResult> = {}): ServiceTestResult => ({
  reachable: true,
  authOk: true,
  server: null,
  protocols: { responses: "yes", messages: "yes", chat: "yes" },
  models: [
    { id: PICK, contextWindow: 1_048_576, name: "DeepSeek V4.1 Flash 1017 Abliterated", price: { input: 0.12, output: 0.45, cached: 0.025 }, uncensored: true },
    { id: "glm-5.3-abliterated", contextWindow: 1_048_576, name: "GLM 5.3 Abliterated", price: { input: 1, output: 2, cached: 0.15 }, uncensored: true },
    { id: "deepseek-v4.1-flash-fast", contextWindow: 1_048_576, name: "DeepSeek V4.1 Flash 1017", price: { input: 0.01, output: 0.08, cached: 0.002 }, uncensored: false },
  ],
  works: [
    { provider: "opencode", via: "chat" },
    { provider: "builtin", via: "chat" },
    { provider: "codex", via: "responses" },
    { provider: "claude", via: "messages" },
  ],
  problems: [],
  funds: { balanceUsd: 41.3, heldUsd: 1.2, plan: null, checkedAt: 0 },
  ...over,
});

test("the Refuseless preset: OpenCode first, on its chat address, with where the key comes from", () => {
  const p = servicePreset("refuseless")!;
  expect(p).toMatchObject({ title: "Refuseless", baseUrl: "https://api.refuseless.com", kind: "hosted", agent: "opencode", protocol: "chat", keyPage: { label: "refuseless.com/console", url: "https://refuseless.com/console" }, docs: { url: "https://docs.refuseless.com" } });
  expect(p.help).toContain("refusals taken out of the weights");
  // What you pay for, and what runs it: the things OpenCode really does for a chat, none of them a promise it can't keep.
  expect(p.plan).toContain("4 November 2026");
  for (const words of ["OpenCode runs it", "open-source coding agent", "no refusal rules of its own", "Plan card", "AGENTS.md (or CLAUDE.md)", "approvals", "BrowserOS neo"]) expect(p.note).toContain(words);
  expect(presetSteps(p)).toEqual(["Get a key at refuseless.com/console.", "Paste it here.", "Press Test."]);
  // Added for OpenCode, which speaks its chat address itself, as Crosstalk's own agent does; Codex would go through the adapter.
  const r = checked();
  expect(chooseAgent(r, p.agent)).toBe("opencode");
  expect(protocolFor(r, "opencode", p)).toBe("chat");
  expect(protocolFor(r, "builtin", p)).toBe("chat");
  expect(protocolFor(r, "codex", p)).toBe("chat");
  expect(protocolFor(r, "claude", p)).toBe("messages");
  // Where OpenCode isn't installed and nobody has picked it, the first agent that is comes before it. An older hub's check
  // doesn't list it at all, and the preset falls to whatever it does list.
  expect(chooseAgent(r, p.agent, null, { opencode: false })).toBe("builtin");
  expect(chooseAgent(r, p.agent, "opencode", { opencode: false })).toBe("opencode");
  expect(chooseAgent(checked({ works: [{ provider: "builtin", via: "chat" }, { provider: "codex", via: "responses" }] }), p.agent, "opencode")).toBe("builtin");
});

test("what a chat's permission setting means on OpenCode, as the rules the hub writes for it", () => {
  expect(permissionInfo("opencode", "ask")).toMatchObject({ short: "Asks first", help: "Can read the project. Asks you before reading elsewhere, and before file edits, commands, web fetches and the browser, except ones you've already allowed." });
  expect(permissionInfo("opencode", "edits")).toMatchObject({ short: "Can edit", help: "Edits files in the project on its own. Asks you before anything outside it, and before commands, web fetches and the browser." });
  // No safety check of its own stands behind Auto, unlike Claude Code's: it's a short list of read commands, and that's said.
  expect(permissionInfo("opencode", "auto")).toMatchObject({ short: "Auto", help: "Edits files in the project and runs simple read commands (ls, cat, grep, git status, git diff, git log) on its own. Asks you before anything outside it, and before other commands, web fetches and the browser." });
  expect(permissionInfo("opencode", "full")).toMatchObject({ short: "Full access", tone: "red" });
});

test("its models: names and prices beside them, the uncensored ones ticked and the stock ones left to tick", () => {
  const r = checked();
  const choices = modelChoices(r);
  expect(initialSelection(choices)).toEqual([PICK, "glm-5.3-abliterated"]);
  expect(choiceFacts(choices[0])).toBe("1M · $0.12 in, $0.45 out per million (cached $0.025)");
  expect(choiceFacts({ id: "x", contextWindow: null })).toBe("");
  expect(UNCENSORED_PICK_WORDS).toContain("refusals and all");
  // A service that marks none as uncensored keeps the usual pick: everything that can run tools.
  expect(initialSelection([{ id: "a", contextWindow: null }, { id: "b", contextWindow: null, tools: false }])).toEqual(["a"]);
});

test("what the account has to spend: what a new reply can use, and what running replies hold", () => {
  expect(isRefuseless("https://api.refuseless.com")).toBe(true);
  expect(isRefuseless("https://refuseless.com")).toBe(false);
  expect(showsFunds("https://api.refuseless.com")).toBe(true);
  expect(showsFunds("https://nano-gpt.com/api")).toBe(true);
  expect(showsFunds("https://api.deepseek.com")).toBe(false);
  const f = checked().funds!;
  expect(fundsLines(f)).toEqual([
    { ok: true, text: "Balance $41.30" },
    { ok: true, text: "$1.20 held by replies still running" },
  ]);
  expect(fundsWords({ ...f, heldUsd: null })).toBe("Balance $41.30");
  expect(fundsLines({ ...f, balanceUsd: 0, heldUsd: null })).toEqual([{ ok: false, text: "Balance $0.00" }]);
  // All of it held by replies still running isn't empty: what they don't use comes back when they end.
  expect(fundsLines({ ...f, balanceUsd: 0 })).toEqual([
    { ok: true, text: "Balance $0.00" },
    { ok: true, text: "$1.20 held by replies still running" },
  ]);
  expect(fundsEmpty({ ...f, balanceUsd: 0 })).toBe(false);
  expect(fundsEmpty({ ...f, balanceUsd: 0, heldUsd: null })).toBe(true);
  // An empty account is sent to its own service to add money: Refuseless's console, NanoGPT's site.
  expect(fundsSite("https://api.refuseless.com")).toEqual({ name: "Refuseless", label: "refuseless.com", url: "https://refuseless.com/console" });
  expect(fundsSite("https://nano-gpt.com/api")).toMatchObject({ name: "NanoGPT", url: "https://nano-gpt.com" });
  // The check's lines end with the balance, after the agents that can run it.
  expect(testLines(checked(), servicePreset("refuseless")).map((l) => l.text)).toEqual([
    "Reachable",
    "Key works",
    "3 models found",
    "Works with OpenCode",
    "Works with Crosstalk agent",
    "Works with Codex",
    "Works with Claude Code",
    "Balance $41.30",
    "$1.20 held by replies still running",
  ]);
});
