import { expect, test } from "bun:test";
import { OPENCODE_VERSION, type AccountSpend, type AgentAccount, type LocalServer, type ModelCatalog, type ProviderStatus, type ServiceTestResult } from "@crosstalk/shared";
import { servicePreset } from "./presets";
import {
  agentChoiceHelp, agentsFor, agentsLine, bytes, chooseAgent, errorMessage, formatContext, initialSelection, installFailure, installWords, kindLine, makeDefault, MAX_MODELS, modelChoices, modelNames, modelsLine, noDot, noTools, openCodeState, parseModelNames, protocolFor,
  routeMissing, saveBody, serverInUse, serverLine, serviceFixLine, serviceList, serviceOutcome, spendChip, staleLine, statusOf, switchAgent, switchedWords, switchFailure, testBody, testFailure, testLines, toggleModel, typedModelNames,
} from "./services";

const none = { responses: "no", messages: "no", chat: "no" } as const;
const result = (over: Partial<ServiceTestResult> = {}): ServiceTestResult => ({ reachable: true, authOk: true, server: null, protocols: { ...none }, models: [], works: [], problems: [], ...over });
const models = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `model-${i + 1}`, contextWindow: null }));
const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: null, plan: null, authMethod: null, error: null, checkedAt: 0, ...over });
const catalog = (over: Partial<ModelCatalog> = {}): ModelCatalog => ({ provider: "codex", models: [], live: true, error: null, ...over });

test("a good check reads Reachable, Key works, the model count and which agent it works with", () => {
  const r = result({ models: models(12), works: [{ provider: "codex", via: "responses" }] });
  expect(testLines(r)).toEqual([
    { ok: true, text: "Reachable" },
    { ok: true, text: "Key works" },
    { ok: true, text: "12 models found" },
    { ok: true, text: "Works with Codex", adapter: false },
  ]);
  expect(testLines(result({ models: models(1), works: [{ provider: "claude", via: "messages" }] })).map((l) => l.text)).toEqual(["Reachable", "Key works", "1 model found", "Works with Claude Code"]);
});

test("the chat adapter marks its line, and a service that needs no key has no key line", () => {
  const lines = testLines(result({ authOk: null, models: models(2), works: [{ provider: "codex", via: "adapter" }] }));
  expect(lines.map((l) => l.text)).toEqual(["Reachable", "2 models found", "Works with Codex"]);
  expect(lines[2].adapter).toBe(true);
});

test("problems keep their fix, and a service that doesn't answer shows only that line", () => {
  const down = serviceOutcome(result({ reachable: false, authOk: null, problems: ["Nothing answered at that address. Check the address and that the server is running."] }));
  expect(down.lines).toEqual([{ ok: false, text: "Can't reach it" }]);
  expect(down.problems).toEqual(["Nothing answered at that address. Check the address and that the server is running."]);
  expect([down.tone, down.text]).toEqual(["bad", "Can't reach it"]);

  // A refused key proves nothing about the service, so the rows stop at the refusal: "No models listed" and "Not usable
  // with Claude Code or Codex yet" would be verdicts on the service that the hub never reached.
  const refused = serviceOutcome(result({ authOk: false, models: [], problems: ["This key was refused. Check it at platform.deepseek.com."] }));
  expect(refused.lines.map((l) => [l.ok, l.text])).toEqual([[true, "Reachable"], [false, "Key refused"]]);
  expect(refused.problems).toEqual(["This key was refused. Check it at platform.deepseek.com."]);
  expect([refused.tone, refused.text]).toEqual(["bad", "Key refused"]);

  const odd = serviceOutcome(result({ models: models(3), works: [] }));
  expect([odd.tone, odd.text]).toEqual(["warn", "Can't be used yet"]);
  expect(serviceOutcome(result({ works: [{ provider: "codex", via: "responses" }] })).tone).toBe("ok");
});

test("the check picks the agent: the one tapped, else the preset's, else the first that can, preferring one that's installed", () => {
  const both = result({ works: [{ provider: "claude", via: "messages" }, { provider: "codex", via: "responses" }] });
  expect(agentsFor(both)).toEqual(["claude", "codex"]);
  expect(chooseAgent(both, "codex")).toBe("codex");
  expect(chooseAgent(both, "claude")).toBe("claude");
  expect(chooseAgent(both, "codex", "claude")).toBe("claude");
  expect(chooseAgent(both, "codex", null, { codex: false })).toBe("claude");
  // Neither installed: still the preset's, so the sheet can say what to install.
  expect(chooseAgent(both, "codex", null, { codex: false, claude: false })).toBe("codex");
  const one = result({ works: [{ provider: "claude", via: "messages" }] });
  expect(chooseAgent(one, "codex")).toBe("claude");
  expect(chooseAgent(one, "codex", "codex")).toBe("claude");
  expect(chooseAgent(result(), "codex")).toBeNull();
});

test("what's saved speaks the service's own style, or chat when the adapter translates", () => {
  const r = result({ works: [{ provider: "codex", via: "adapter" }, { provider: "claude", via: "messages" }] });
  expect(protocolFor(r, "codex")).toBe("chat");
  expect(protocolFor(r, "claude")).toBe("messages");
  expect(protocolFor(result({ works: [{ provider: "codex", via: "responses" }] }), "codex")).toBe("responses");
  expect(protocolFor(result(), "codex")).toBeNull();
});

test("a preset can pin the style, as long as the service has that address and the agent speaks it", () => {
  // Venice answers at both addresses, so the check prefers Responses; its preset pins the chat lane, which is the one
  // that goes through Crosstalk's adapter (where the account's own body fields are added).
  const both = result({ protocols: { responses: "yes", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "responses" }] });
  expect(protocolFor(both, "codex")).toBe("responses");
  expect(protocolFor(both, "codex", servicePreset("venice"))).toBe("chat");
  // The line about it says the adapter is in between, because that's what will be saved.
  expect(testLines(both, servicePreset("venice")).at(-1)).toEqual({ ok: true, text: "Works with Codex", adapter: true });
  // A service that stops answering at the pinned address is still added the way it does work.
  const onlyResponses = result({ protocols: { responses: "yes", messages: "no", chat: "no" }, works: [{ provider: "codex", via: "responses" }] });
  expect(protocolFor(onlyResponses, "codex", servicePreset("venice"))).toBe("responses");
  // And a pin an agent can't speak is ignored: Claude Code is never given the chat translator.
  const forClaude = result({ protocols: { responses: "no", messages: "yes", chat: "yes" }, works: [{ provider: "claude", via: "messages" }] });
  expect(protocolFor(forClaude, "claude", servicePreset("venice"))).toBe("messages");
  // No preset pins anything for the other services.
  expect(protocolFor(both, "codex", servicePreset("deepseek"))).toBe("responses");
});

test("model choices drop names the hub would drop; up to 20 start picked, more start empty", () => {
  const r = result({ models: [{ id: "a", contextWindow: 1 }, { id: "a", contextWindow: 2 }, { id: "has space", contextWindow: null }, { id: "", contextWindow: null }, { id: "x".repeat(201), contextWindow: null }, { id: "b", contextWindow: null }] });
  expect(modelChoices(r).map((m) => m.id)).toEqual(["a", "b"]);
  expect(initialSelection(models(MAX_MODELS))).toHaveLength(20);
  expect(initialSelection(models(MAX_MODELS + 1))).toEqual([]);
  // A long list is a list you pick from, however many of its models say they can't run tools: the count is every model
  // listed, not the ones left after that.
  const long = models(MAX_MODELS + 5).map((m, i) => (i < 6 ? { ...m, tools: false } : m));
  expect(initialSelection(long)).toEqual([]);
});

// The ticks and the picker below them must count the same models: a name the hub drops (a space in it, a repeat, over
// 200 characters) is never offered, so counting it would tick "3 models found" over the box that says none were listed.
test("the model count is the models that can be picked, and says how many names were skipped", () => {
  const works = [{ provider: "codex", via: "responses" } as const];
  // A vLLM --served-model-name, or mlx-lm run from a path with a space in it: nothing here can be used.
  const spaced = result({ models: [{ id: "my model a", contextWindow: null }, { id: "my model b", contextWindow: null }], works });
  expect(modelChoices(spaced)).toEqual([]);
  expect(testLines(spaced).map((l) => [l.ok, l.text])).toEqual([[true, "Reachable"], [true, "Key works"], [false, "None of its model names can be used"], [true, "Works with Codex"]]);
  // Some kept, some not: the count is what's left, and the line says the rest went.
  const mixed = result({ models: [{ id: "ok-1", contextWindow: null }, { id: "my model", contextWindow: null }, { id: "ok-1", contextWindow: null }], works });
  expect(modelChoices(mixed).map((m) => m.id)).toEqual(["ok-1"]);
  expect(testLines(mixed)[2]).toEqual({ ok: true, text: "1 model found, 2 names skipped" });
  // A service that really listed nothing still says that.
  expect(testLines(result({ models: [], works }))[2]).toEqual({ ok: false, text: "No models listed" });
});

// Settings -> AI services could test a service of your own and change it nowhere: the row's words name where each kind
// is changed, and a custom model is changed on the row itself (its address, key and models).
test("every row says where its service is changed", () => {
  expect(serviceFixLine(account({ kind: "endpoint", provider: "codex", endpoint: { baseUrl: "http://127.0.0.1:8080", models: ["qwen3-8b"], contextWindow: null, hasKey: false, protocol: "chat" } }))).toBe("Change its address, key or models with Change. Remove it under Codex → Accounts below.");
  expect(serviceFixLine(account({ kind: "apikey", signedIn: false, provider: "claude" }))).toBe("Replace the key under Claude Code below.");
  expect(serviceFixLine(account({ signedIn: false }))).toBe("Press Sign in under Codex below.");
  // Nothing to fix on a sign-in that works, or a key the agent accepts.
  expect(serviceFixLine(account({ signedIn: true }))).toBeNull();
  expect(serviceFixLine(account({ kind: "apikey", signedIn: true }))).toBeNull();
});

test("a model the service says can't run tools is marked and never picked for you, but can still be ticked", () => {
  // Venice's list says this per model (supportsFunctionCalling); a service that says nothing is never read as a no.
  const r = result({ models: [{ id: "glm-5", contextWindow: 198_000, tools: true }, { id: "hermes-3", contextWindow: 128_000, tools: false }, { id: "quiet", contextWindow: null }] });
  const choices = modelChoices(r);
  expect(choices.map(noTools)).toEqual([false, true, false]);
  expect(initialSelection(choices)).toEqual(["glm-5", "quiet"]);
  expect(toggleModel(initialSelection(choices), "hermes-3")).toEqual(["glm-5", "quiet", "hermes-3"]);
  // Every model saying no still leaves a list to pick from (the check's problem line says what it means).
  expect(initialSelection(modelChoices(result({ models: [{ id: "hermes-3", contextWindow: 1024, tools: false }] })))).toEqual([]);
});

test("Venice saves the body fields it needs in every request, and other services save none", () => {
  // Venice as it really answers: both addresses, so the check prefers Responses and the preset's pin is what keeps the
  // account on the chat lane — the only one the fields below ever reach.
  const r = result({
    protocols: { responses: "yes", messages: "no", chat: "yes" },
    models: [{ id: "zai-org-glm-5", contextWindow: 198_000, tools: true }],
    works: [{ provider: "codex", via: "responses" }],
  });
  const body = saveBody({ agent: "codex", result: r, preset: servicePreset("venice"), baseUrl: "https://api.venice.ai/api", apiKey: "sk-venice-1", label: "Venice", models: ["zai-org-glm-5"], context: "" });
  expect(body).toEqual({
    provider: "codex",
    baseUrl: "https://api.venice.ai/api",
    label: "Venice",
    apiKey: "sk-venice-1",
    models: ["zai-org-glm-5"],
    contextWindow: 198_000,
    protocol: "chat",
    contexts: { "zai-org-glm-5": 198_000 },
    // Venice's own system prompt off, so the agent's instructions are what the model follows, and no <think> blocks in
    // the answer (they would be read as the reply and sent back on every later turn).
    extra: { venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true } },
  });
  expect(saveBody({ agent: "codex", result: r, preset: servicePreset("deepseek"), baseUrl: "https://api.deepseek.com", apiKey: "k", label: "", models: ["zai-org-glm-5"], context: "" }).extra).toBeUndefined();
});

test("picking models: new ones go last, dropped ones go, 20 is the limit, and the default can be moved first", () => {
  expect(toggleModel(["a"], "b")).toEqual(["a", "b"]);
  expect(toggleModel(["a", "b"], "a")).toEqual(["b"]);
  const full = models(MAX_MODELS).map((m) => m.id);
  expect(toggleModel(full, "extra")).toBe(full);
  expect(toggleModel(full, "model-3")).toHaveLength(19);
  expect(makeDefault(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  expect(makeDefault(["a"], "zzz")).toEqual(["a"]);
});

test("typed model names are split on commas, deduplicated and capped", () => {
  expect(parseModelNames(" deepseek-chat, deepseek-reasoner ,, deepseek-chat, two words ")).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  expect(parseModelNames(models(30).map((m) => m.id).join(","))).toHaveLength(MAX_MODELS);
  expect(parseModelNames("")).toEqual([]);
});

test("a typed name the sheet can't keep is said, with what to do about it", () => {
  // Nothing wrong: nothing to say.
  expect(typedModelNames(" deepseek-chat, deepseek-reasoner ")).toEqual({ names: ["deepseek-chat", "deepseek-reasoner"], problem: null });
  expect(typedModelNames("")).toEqual({ names: [], problem: null });
  // A space in a name: dropped (an agent passes a model name as one word), so the box says so instead of the name
  // vanishing as it's typed, taking "Add it" and the context field with it.
  const spaced = typedModelNames("qwen3 8b");
  expect(spaced.names).toEqual([]);
  expect(spaced.problem).toContain("space");
  expect(spaced.problem).toContain("qwen3 8b");
  expect(spaced.problem).toContain("qwen3-8b");
  // A name quoted back is cut short, so the message still fits a phone.
  expect(typedModelNames(`${"q".repeat(40)} 8b`).problem).toContain(`"${"q".repeat(24)}…"`);
  // Far too long for a name.
  const long = typedModelNames("a".repeat(201));
  expect(long.names).toEqual([]);
  expect(long.problem).toContain("too long");
  // Past the twentieth: it says the first 20 are what's added, rather than the rest going quietly.
  const many = typedModelNames(models(30).map((m) => m.id).join(","));
  expect(many.names).toHaveLength(MAX_MODELS);
  expect(many.problem).toContain("30 names");
  expect(many.problem).toContain(String(MAX_MODELS));
});

test("saving sends the agent, protocol, chat path, models in order and each model's own context", () => {
  const r = result({
    models: [{ id: "gem-pro", contextWindow: 1_048_576 }, { id: "gem-flash", contextWindow: null }, { id: "gem-tiny", contextWindow: 100 }],
    works: [{ provider: "codex", via: "adapter" }],
  });
  expect(saveBody({ agent: "codex", result: r, preset: servicePreset("gemini"), baseUrl: " https://generativelanguage.googleapis.com ", apiKey: " AIza-key ", label: " Gemini ", models: ["gem-pro", "gem-flash", "gem-tiny"], context: "" })).toEqual({
    provider: "codex",
    baseUrl: "https://generativelanguage.googleapis.com",
    label: "Gemini",
    apiKey: "AIza-key",
    models: ["gem-pro", "gem-flash", "gem-tiny"],
    contextWindow: 1_048_576,
    protocol: "chat",
    chatPath: "/v1beta/openai/chat/completions",
    // 100 tokens isn't a context size the hub accepts: it's left out, not sent.
    contexts: { "gem-pro": 1_048_576 },
  });
});

test("a context typed by hand fills in when the service didn't say, and a nameless local server is named by the hub", () => {
  const r = result({ authOk: null, models: [{ id: "qwen3-coder", contextWindow: null }], works: [{ provider: "claude", via: "messages" }] });
  const body = saveBody({ agent: "claude", result: r, preset: servicePreset("local"), baseUrl: "http://127.0.0.1:11434", apiKey: "", label: "", models: ["qwen3-coder"], context: "65536" });
  expect(body).toEqual({ provider: "claude", baseUrl: "http://127.0.0.1:11434", apiKey: "", models: ["qwen3-coder"], contextWindow: 65536, protocol: "messages" });
  expect(saveBody({ agent: "claude", result: r, preset: null, baseUrl: "x", apiKey: "", label: "", models: ["qwen3-coder"], context: "12" }).contextWindow).toBeNull();
});

test("the list has Claude Code then Codex, each agent's own sign-in first, and nothing else", () => {
  const all: Record<string, AgentAccount> = {
    "codex:k": account({ id: "k", label: "Kimi", kind: "endpoint" }),
    codex: account(),
    "claude:w": account({ provider: "claude", id: "w", label: "Work" }),
    claude: account({ provider: "claude" }),
    gemini: account({ provider: "gemini" }),
    "claude:a": account({ provider: "claude", id: "a", label: "API key", kind: "apikey" }),
  };
  expect(serviceList(all).map((a) => `${a.provider}/${a.label}`)).toEqual(["claude/Main", "claude/API key", "claude/Work", "codex/Main", "codex/Kimi"]);
  // The two agents that run only on services list those, after Claude Code's and Codex's; never a stray sign-in of theirs.
  const onServices: Record<string, AgentAccount> = {
    ...all,
    "opencode:r": account({ provider: "opencode", id: "r", label: "Refuseless", kind: "endpoint" }),
    "builtin:n": account({ provider: "builtin", id: "n", label: "NanoGPT", kind: "endpoint" }),
    opencode: account({ provider: "opencode" }),
    builtin: account({ provider: "builtin" }),
  };
  expect(serviceList(onServices).map((a) => `${a.provider}/${a.label}`)).toEqual(["claude/Main", "claude/API key", "claude/Work", "codex/Main", "codex/Kimi", "builtin/NanoGPT", "opencode/Refuseless"]);
});

test("the Agents line says truthfully which agent runs which service", () => {
  const codex = account();
  const refuseless = account({ provider: "opencode", id: "r", label: "Refuseless", kind: "endpoint" });
  const nano = account({ provider: "builtin", id: "n", label: "NanoGPT", kind: "endpoint" });
  // The whole line now, what it's for included: "sign in to your plan" only ever names Claude Code and Codex, and the agents
  // that run on a service's key say they have no sign-in (web/src/builtinSignIn.test.ts).
  expect(agentsLine([codex])).toBe("Claude Code and Codex run every service above. Install them, sign in to your plan or add accounts here.");
  expect(agentsLine([codex, refuseless])).toBe("Claude Code and Codex run the other services above. OpenCode runs Refuseless, with the key above, and needs no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.");
  expect(agentsLine([codex, nano])).toBe("Claude Code and Codex run the other services above. Crosstalk's own agent runs NanoGPT itself, with the key above, and needs no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.");
  expect(agentsLine([codex, nano, refuseless])).toBe("Claude Code and Codex run the other services above. OpenCode runs Refuseless and Crosstalk's own agent runs NanoGPT itself, with the keys above, and need no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.");
  expect(agentsLine([refuseless])).toBe("OpenCode runs Refuseless, with the key above: no sign-in, and no Claude Code or Codex needed. To use those too, install them, sign in to your plan or add accounts here.");
  expect(agentsLine([nano])).toBe("Crosstalk's own agent runs NanoGPT itself, with the key above: no sign-in, and no Claude Code or Codex needed. To use those too, install them, sign in to your plan or add accounts here.");
  expect(agentsLine([refuseless, nano])).toBe("OpenCode runs Refuseless and Crosstalk's own agent runs NanoGPT itself, with the keys above: no sign-in, and no Claude Code or Codex needed. To use those too, install them, sign in to your plan or add accounts here.");
  expect(agentsLine([refuseless, { ...refuseless, id: "r2", label: "Refuseless work" }])).toBe("OpenCode runs Refuseless and Refuseless work, with the keys above: no sign-in, and no Claude Code or Codex needed. To use those too, install them, sign in to your plan or add accounts here.");
});

test("Use it with says what the agent picked is, where that is the choice", () => {
  // Any other service is the same under either agent.
  expect(agentChoiceHelp(["codex", "claude"], "codex")).toBe("Both can run it. Pick the one you want to chat with.");
  const all = ["opencode", "builtin", "codex", "claude"] as const;
  expect(agentChoiceHelp([...all], "opencode")).toContain("no refusal rules of its own");
  expect(agentChoiceHelp([...all], "builtin")).toContain("nothing to install");
  expect(agentChoiceHelp([...all], "codex")).toBe("Codex can run it too, with its own instructions and tools on top.");
  expect(agentChoiceHelp([...all], "claude")).toBe("Claude Code can run it too, with its own instructions and tools on top.");
});

const openCode = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({ provider: "opencode", installed: true, signedIn: true, version: OPENCODE_VERSION, binPath: "/h/.npm-global/bin/opencode", account: null, plan: null, authMethod: "AI service", error: null, checkedAt: 1, ...over });

test("OpenCode's card: Install when it isn't there, Update when it's another version, nothing to press when it's the right one", () => {
  expect(openCodeState(openCode())).toEqual({ word: "Installed", tone: "green", action: null, line: null });
  expect(openCodeState(openCode({ installed: false, version: null, binPath: null, signedIn: null, authMethod: null }))).toMatchObject({ word: "Not installed", action: "Install" });
  expect(openCodeState(openCode({ installed: false, checkedAt: 0 }))).toEqual({ word: "Checking…", tone: "", action: null, line: null });
  const other = openCodeState(openCode({ version: "2.2.4" }));
  expect(other).toMatchObject({ word: "Other version", tone: "orange", action: "Update" });
  expect(other.line).toBe(`Crosstalk was checked with OpenCode ${OPENCODE_VERSION}. This machine has 2.2.4. Update puts ${OPENCODE_VERSION} on it.`);
  expect(openCodeState(openCode({ version: null })).line).toContain("didn't say its version");
  // A version 1 can't run these chats, and the hub's own words for it say Install: the button says the same.
  const old = "OpenCode 1.14.0 is installed, and Crosstalk needs version 2. Press Install to get it.";
  expect(openCodeState(openCode({ version: "1.14.0", error: old, signedIn: null }))).toEqual({ word: "Can't be used", tone: "orange", action: "Install", line: old });
  // Nothing about signing in or plans: services are on their own rows.
  for (const s of [openCodeState(openCode({ installed: false })), other]) expect(s.line).not.toMatch(/sign|plan/i);
});

test("an install's one line, from start to end, and honest about how it ended", () => {
  const words = (over: Partial<Parameters<typeof installWords>[0]>) => installWords({ name: "OpenCode", machine: "Mac mini", phase: "idle", exitCode: null, stopped: false, status: undefined, ...over });
  expect(words({})).toBe("");
  expect(words({ phase: "starting" })).toBe("Starting the install on Mac mini…");
  expect(words({ phase: "running" })).toBe("Installing OpenCode on Mac mini…");
  expect(words({ phase: "checking", exitCode: 0 })).toBe("The install has ended. Checking OpenCode…");
  expect(words({ phase: "done", exitCode: 0, status: openCode({ version: "2.2.5" }) })).toBe("OpenCode 2.2.5 is installed.");
  expect(words({ phase: "failed", exitCode: 1 })).toBe("OpenCode didn't install (exit 1). What it printed is below.");
  expect(words({ phase: "failed", exitCode: 143, stopped: true })).toBe("You stopped the install.");
  // Ended well and still not there: said as that, never as installed.
  expect(words({ phase: "failed", exitCode: 0, status: openCode({ installed: false }) })).toBe("The installer finished, but OpenCode isn't where Crosstalk looks for it on Mac mini. What it printed is below.");
  expect(words({ phase: "failed", exitCode: 0, status: openCode({ error: "OpenCode 1.14.0 is installed, and Crosstalk needs version 2." }) })).toBe("OpenCode 1.14.0 is installed, and Crosstalk needs version 2.");
  // The hub no longer has its terminal (it restarted).
  expect(words({ phase: "failed", exitCode: null })).toBe("Couldn't see how the install ended: Mac mini no longer has its terminal.");
  expect(installFailure("OpenCode", "Couldn't start a terminal.", 500)).toBe("The install didn't start: Couldn't start a terminal. Try again in a moment.");
  expect(installFailure("OpenCode", "not found", 404)).toBe("This machine's hub is too old to install OpenCode from here. Update it first.");
});

test("a Refuseless or NanoGPT service can move between the two agents that run only on services, and nothing else can", () => {
  const on = (provider: AgentAccount["provider"], baseUrl: string, over: Partial<AgentAccount> = {}) => account({ provider, id: "s1", label: "Refuseless", kind: "endpoint", endpoint: { baseUrl, models: ["m"], contextWindow: null, hasKey: true, protocol: "chat" }, ...over });
  const refuseless = "https://api.refuseless.com";
  const nano = "https://nano-gpt.com/api";
  expect(switchAgent(on("builtin", refuseless), [])).toBe("opencode");
  expect(switchAgent(on("opencode", refuseless), [])).toBe("builtin");
  expect(switchAgent(on("builtin", nano), [])).toBe("opencode");
  expect(switchAgent(on("opencode", nano), [])).toBe("builtin");
  // Not another address (nothing says either agent can run it), nor one Claude Code or Codex runs, nor anything but a service.
  expect(switchAgent(on("builtin", "https://api.deepseek.com"), [])).toBeNull();
  expect(switchAgent(on("codex", refuseless), [])).toBeNull();
  expect(switchAgent(on("claude", nano), [])).toBeNull();
  expect(switchAgent(account({ provider: "builtin" }), [])).toBeNull();
  // Already on the other agent (an old row stays while chats use it, and the hub would only answer with that one): nothing to move.
  const twin = on("opencode", refuseless, { id: "s2" });
  expect(switchAgent(on("builtin", refuseless), [twin])).toBeNull();
  expect(switchAgent(on("builtin", refuseless, { label: "Work" }), [twin])).toBeNull();
  expect(switchAgent(on("builtin", nano), [twin])).toBe("opencode");
  // The toast and the error say what happened.
  expect(switchedWords("Refuseless", "builtin", "opencode", false)).toBe("Refuseless now runs with OpenCode, with the same key.");
  expect(switchedWords("Refuseless", "builtin", "opencode", true)).toBe("Refuseless now runs with OpenCode, with the same key. Chats already on it stay with Crosstalk agent, so that row stays. Press Remove on it once they're deleted.");
  expect(switchFailure("Run it with OpenCode", "OpenCode isn't installed.", 400)).toBe("Couldn't move it: OpenCode isn't installed. Press Run it with OpenCode to try again.");
  expect(switchFailure("Run it with OpenCode", "not found", 404)).toBe("This machine's hub is too old to move a service to another agent. Update it first.");
  // A hub that has the route says 404 in its own words: that isn't "too old".
  expect(switchFailure("Run it with OpenCode", "No such account", 404)).toBe("Couldn't move it: No such account. Press Run it with OpenCode to try again.");
});

test("a row says the agent and what the account is", () => {
  expect(kindLine(account({ provider: "claude", plan: "Max", account: "me@example.com" }))).toBe("Claude Code · Max · me@example.com");
  expect(kindLine(account({ kind: "apikey" }))).toBe("Codex · API key, billed per use");
  const endpoint = { baseUrl: "https://api.moonshot.ai", models: ["kimi"], contextWindow: null, hasKey: true };
  expect(kindLine(account({ kind: "endpoint", endpoint }))).toBe("Codex · Custom model · api.moonshot.ai");
  expect(kindLine(account({ kind: "endpoint", endpoint: { ...endpoint, protocol: "chat" } }))).toBe("Codex · Custom model · api.moonshot.ai · chat adapter");
});

test("the dot: a plan or a key shows the agent's live state; a custom model shows the last check, else what the model list says", () => {
  expect(statusOf(account({ signedIn: true }), null, null)).toEqual({ tone: "ok", text: "Signed in" });
  expect(statusOf(account({ signedIn: false }), null, null)).toEqual({ tone: "warn", text: "Not signed in" });
  expect(statusOf(account({ signedIn: null }), null, null)).toEqual({ tone: "idle", text: "Sign-in not confirmed" });
  const endpoint = account({ kind: "endpoint" });
  expect(statusOf(endpoint, null, null)).toEqual({ tone: "idle", text: "Not tested yet" });
  expect(statusOf(endpoint, null, catalog({ live: true }))).toEqual({ tone: "idle", text: "Not tested yet" });
  expect(statusOf(endpoint, null, catalog({ live: false }))).toEqual({ tone: "bad", text: "Can't reach it" });
  expect(statusOf(endpoint, serviceOutcome(result({ works: [{ provider: "codex", via: "responses" }] })), catalog({ live: false }))).toEqual({ tone: "ok", text: "Reachable" });
  // A saved key is checked the way a plan sign-in is, so its row shows the agent's live state too.
  expect(statusOf(account({ kind: "apikey", signedIn: false }), null, null)).toEqual({ tone: "warn", text: "Key not accepted" });
  expect(statusOf(account({ kind: "apikey", signedIn: true }), null, null)).toEqual({ tone: "ok", text: "Key accepted" });
  expect(statusOf(account({ kind: "apikey", signedIn: null }), null, null)).toEqual({ tone: "idle", text: "Key not confirmed" });
  expect(statusOf(account({ kind: "apikey", signedIn: false }), serviceOutcome(result({ works: [{ provider: "codex", via: "responses" }] })), null).text).toBe("Key not accepted");
  // A plan's old check never overrides its live state.
  expect(statusOf(account({ signedIn: false }), serviceOutcome(result({ works: [{ provider: "codex", via: "responses" }] })), null).text).toBe("Not signed in");
});

test("a row lists a custom model's live names, or its saved ones when no list came", () => {
  const endpoint = account({ kind: "endpoint", endpoint: { baseUrl: "https://x.example", models: ["saved-a", "saved-b"], contextWindow: null, hasKey: false } });
  expect(modelNames(endpoint, null)).toEqual(["saved-a", "saved-b"]);
  const live = catalog({ models: [{ id: "live-1", label: "Live 1", description: null, efforts: [], defaultEffort: null, isDefault: true }] });
  expect(modelNames(endpoint, live)).toEqual(["live-1"]);
  // An agent's own list counts only when the agent was asked.
  expect(modelNames(account(), { ...live, live: false })).toEqual([]);
  expect(modelNames(account(), live)).toEqual(["Live 1"]);
  expect(modelsLine(["a"])).toBe("1 model: a");
  expect(modelsLine(["a", "b", "c"])).toBe("3 models: a, b, c");
  expect(modelsLine(["a", "b", "c", "d", "e"])).toBe("5 models: a, b, c and 2 more");
});

test("a list that couldn't be fetched says so plainly, with the date it's from", () => {
  const when = new Date(2026, 2, 3, 12).getTime();
  expect(staleLine(catalog({ live: false, checkedAt: when }))).toBe("Couldn't reach it; showing the list from March 3.");
  expect(staleLine(catalog({ live: false }))).toBe("Couldn't reach it; showing the saved list.");
  expect(staleLine(catalog({ live: true, checkedAt: when }))).toBeNull();
  expect(staleLine(null)).toBeNull();
});

test("the spending chip shows this month's cost, ≈ for a plan, and how the limit stands", () => {
  const totals = (usd: number) => ({ usd, replies: 3, unpriced: 0, inputTokens: 0, outputTokens: 0 });
  const spend = (over: Partial<AccountSpend> = {}): AccountSpend => ({ provider: "codex", account: "k", label: "Kimi", kind: "endpoint", today: totals(0), month: totals(4.2), total: totals(9), budget: null, ...over });
  expect(spendChip(spend())).toEqual({ text: "$4.20 this month", tone: "ok" });
  expect(spendChip(spend({ kind: "signin" }))).toEqual({ text: "≈$4.20 this month", tone: "ok" });
  const budget = { limitUsd: 5, period: "month" as const, since: 0, usedUsd: 4.2, percent: 84 };
  expect(spendChip(spend({ budget: { ...budget, state: "warn" } }))?.tone).toBe("warn");
  expect(spendChip(spend({ budget: { ...budget, state: "stopped" } }))?.tone).toBe("stopped");
  expect(spendChip(spend({ month: totals(0) }))).toBeNull();
  expect(spendChip(undefined)).toBeNull();
});

test("a custom model is tested with its saved key, at its own address; a key or plan sign-in is tested by its own check", () => {
  const endpoint = { baseUrl: "https://api.deepseek.com", models: ["deepseek-chat"], contextWindow: null, hasKey: true };
  expect(testBody(account({ id: "d", kind: "endpoint", endpoint }))).toEqual({ baseUrl: "https://api.deepseek.com", accountId: "d", provider: "codex" });
  expect(testBody(account({ id: "g", kind: "endpoint", endpoint: { ...endpoint, protocol: "chat", chatPath: "/v1beta/openai/chat/completions" } }))?.chatPath).toBe("/v1beta/openai/chat/completions");
  // POST /api/services/test finds the account among custom models only: an API key's id there is "No such custom model",
  // so a saved key (either agent) has no service check. Its Test is POST /api/accounts/:provider/:id/refresh, like a plan's.
  expect(testBody(account({ provider: "claude", id: "k", kind: "apikey" }))).toBeNull();
  expect(testBody(account({ id: "k", kind: "apikey" }))).toBeNull();
  expect(testBody(account())).toBeNull();
  expect(testBody(account({ provider: "gemini", kind: "apikey" }))).toBeNull();
  // A custom model whose address is missing has nothing to check either.
  expect(testBody(account({ id: "d", kind: "endpoint", endpoint: null }))).toBeNull();
  // Crosstalk's own agent and OpenCode: the real check too. The hub only takes Claude Code or Codex as `provider`, and finds these by id.
  for (const provider of ["builtin", "opencode"] as const) {
    expect(testBody(account({ provider, id: "r", kind: "endpoint", endpoint: { ...endpoint, baseUrl: "https://api.refuseless.com", protocol: "chat" } }))).toEqual({ baseUrl: "https://api.refuseless.com", accountId: "r" });
    expect(testBody(account({ provider, id: "r", kind: "endpoint", endpoint: null }))).toBeNull();
  }
  // Nor anyone else's: an agent that can't run a service has no service check.
  expect(testBody(account({ provider: "gemini", kind: "endpoint", endpoint }))).toBeNull();
});

test("a check that can't run says what to do; only a hub without the route is too old", () => {
  expect(testFailure("Failed to fetch.")).toBe("The check didn't run: Failed to fetch. Press Test to try again.");
  // The hub's own words for a route it doesn't have (any case, and a text answer's newline).
  for (const message of ["not found", "Not found", "not found\n"]) {
    expect(testFailure(message, 404)).toContain("too old to check services");
    expect(routeMissing(message, 404)).toBe(true);
  }
  // A 404 from a hub that has the route is about something else (a removed account, say): it's reported as it came.
  expect(testFailure("No such custom model", 404)).toBe("The check didn't run: No such custom model. Press Test to try again.");
  expect(testFailure("No such account", 404)).not.toContain("too old");
  expect(testFailure("room not found", 404)).not.toContain("too old");
  // Neither is "not found" with another status.
  expect(testFailure("not found", 500)).toBe("The check didn't run: not found. Press Test to try again.");
  expect(routeMissing("not found")).toBe(false);
});

test("a found server says how many models, which are loaded and the memory it uses", () => {
  const server = (over: Partial<LocalServer> = {}): LocalServer => ({
    id: "ollama", kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434",
    models: [{ id: "llama3.2:3b", contextWindow: 131072, sizeBytes: 2e9, loaded: true }, { id: "qwen3:8b", contextWindow: null, sizeBytes: 5e9, loaded: false }],
    memoryBytes: 4.4 * 1024 ** 3, protocols: { ...none }, accountIds: [], ...over,
  });
  expect(serverLine(server())).toBe("2 models · llama3.2:3b loaded · 4.4 GB in use");
  expect(serverLine(server({ memoryBytes: null, models: [{ id: "m", contextWindow: null, sizeBytes: null, loaded: false }] }))).toBe("1 model");
  expect(serverLine(server({ models: ["a", "b", "c"].map((id) => ({ id, contextWindow: null, sizeBytes: null, loaded: true })), memoryBytes: null }))).toBe("3 models · a, b and 1 more loaded");

  // In use is the scan *and* the accounts: an account added a moment ago is here before the next scan is, so the row
  // says "In use" instead of offering to add the same server again (and ending in "that name is taken").
  const using = (baseUrl: string) => [account({ kind: "endpoint", endpoint: { baseUrl, models: ["m"], contextWindow: null, hasKey: false } })];
  expect(serverInUse(server(), [])).toBe(false);
  expect(serverInUse(server({ accountIds: [{ provider: "codex", id: "kimi1" }] }), [])).toBe(true);
  expect(serverInUse(server(), using("http://127.0.0.1:11434"))).toBe(true);
  // The same server by another of this machine's names, and with a trailing slash.
  expect(serverInUse(server(), using("http://localhost:11434/"))).toBe(true);
  // A different port, a service out on the web, and a plan sign-in: not this server.
  expect(serverInUse(server(), using("http://127.0.0.1:1234"))).toBe(false);
  expect(serverInUse(server(), using("https://api.deepseek.com"))).toBe(false);
  expect(serverInUse(server(), [account({})])).toBe(false);
});

test("sizes read the way models and files are named", () => {
  expect([128 * 1024, 200_000, 1_048_576, 1_000_000, 32768, 1_500_000, 512].map(formatContext)).toEqual(["128k", "200k", "1M", "1M", "32k", "1.5M", "512"]);
  expect([bytes(4.4 * 1024 ** 3), bytes(640 * 1024 ** 2), bytes(12 * 1024)]).toEqual(["4.4 GB", "640 MB", "12 KB"]);
});

test("an error's words end without a dot, so the next sentence can follow", () => {
  expect(errorMessage(new Error("The server didn't answer."))).toBe("The server didn't answer.");
  expect(errorMessage("plain")).toBe("plain");
  expect(noDot("It failed. ")).toBe("It failed");
  expect(noDot("No dot")).toBe("No dot");
});
