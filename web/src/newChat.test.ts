import { expect, test } from "bun:test";
import { CODEX_LEAN_TOOLS_BELOW, leanToolsWords, smallWindowWords, type AgentAccount, type LocalServer, type ModelOption } from "@crosstalk/shared";
import { agentStarters, chatStarters, foldStarters, noToolsWords, serverModelOptions, STARTERS_SHOWN, targetChoice } from "./newChat";

const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: null, plan: null, authMethod: null, error: null, checkedAt: 0, ...over });
const endpoint = (label: string, baseUrl: string, models: string[], over: Partial<AgentAccount> = {}): AgentAccount =>
  account({ id: label.toLowerCase().replace(/\W+/g, ""), label, kind: "endpoint", plan: "Custom model", endpoint: { baseUrl, models, contextWindow: null, hasKey: false }, ...over });
const model = (id: string, over: Partial<ModelOption> = {}): ModelOption => ({ id, label: id, description: null, efforts: [], defaultEffort: null, isDefault: false, ...over });
const yes = { responses: "yes", messages: "no", chat: "yes" } as const;
const server = (over: Partial<LocalServer> = {}): LocalServer => ({
  id: "llamacpp-8080",
  kind: "llamacpp",
  label: "llama.cpp (port 8080)",
  baseUrl: "http://127.0.0.1:8080",
  models: [{ id: "qwen3.8-9b", contextWindow: 16384, sizeBytes: null, loaded: true }],
  memoryBytes: null,
  protocols: { ...yes },
  accountIds: [],
  ...over,
});

test("the menu lists the agents, then your services with the model each would run, then servers found here", () => {
  const starters = chatStarters({
    ready: ["claude", "codex"],
    accounts: [account({ provider: "claude" }), account(), endpoint("Qwen here", "http://127.0.0.1:8080", ["qwen3.8-9b", "qwen3.8-27b"]), endpoint("Venice", "https://api.venice.ai/api", ["venice-uncensored"])],
    servers: [server({ baseUrl: "http://127.0.0.1:11434", id: "ollama-11434", label: "Ollama (port 11434)", models: [{ id: "llama3.2:3b", contextWindow: null, sizeBytes: null, loaded: false }] })],
  });
  expect(starters.agents.map((r) => [r.title, r.help])).toEqual([
    ["Claude Code", "Anthropic"],
    ["Codex", "OpenAI"],
  ]);
  // A service of yours: its own name, the model it would start on, how many it has, and where it runs.
  expect(starters.services.map((r) => [r.title, r.help, r.where])).toEqual([
    ["Qwen here", "qwen3.8-9b · 2 models · on this machine", "local"],
    ["Venice", "venice-uncensored · api.venice.ai", "web"],
  ]);
  expect(starters.services[0].target).toEqual({ kind: "service", provider: "codex", account: "qwenhere", model: "qwen3.8-9b", label: "Qwen here", noTools: false });
  // A server running here that no account uses: one tap adds it and starts.
  expect(starters.servers.map((r) => [r.title, r.help])).toEqual([["Ollama (port 11434)", "llama3.2:3b · add it and start"]]);
  expect(starters.servers[0].target).toMatchObject({ kind: "server", provider: "codex", baseUrl: "http://127.0.0.1:11434", label: "Ollama (port 11434)", model: "llama3.2:3b" });
});

test("a machine's name is used where there are several, and a plan sign-in or API key is never a service", () => {
  const starters = chatStarters({
    ready: ["codex"],
    accounts: [account({ kind: "apikey", id: "key1", label: "Work key" }), endpoint("Qwen here", "http://localhost:8080", ["qwen"])],
    machine: "the Mac mini",
  });
  expect(starters.services.map((r) => r.help)).toEqual(["qwen · on the Mac mini"]);
});

test("a server already added, or one neither agent can use, isn't offered again", () => {
  // An account pointing at it counts even before the next look for servers (the scan is kept for a minute).
  const justAdded = chatStarters({ ready: [], accounts: [endpoint("llama.cpp (port 8080)", "http://127.0.0.1:8080", ["qwen3.8-9b"])], servers: [server()] });
  expect(justAdded.servers).toEqual([]);
  expect(justAdded.services.map((r) => r.title)).toEqual(["llama.cpp (port 8080)"]);
  const starters = chatStarters({
    ready: ["codex"],
    accounts: [],
    servers: [
      server({ accountIds: [{ provider: "codex", id: "qwen1" }] }),
      server({ id: "other-9000", label: "Model server (port 9000)", baseUrl: "http://127.0.0.1:9000", protocols: { responses: "no", messages: "no", chat: "no" } }),
      server({ id: "empty-8000", label: "vLLM (port 8000)", baseUrl: "http://127.0.0.1:8000", models: [] }),
    ],
  });
  expect(starters.servers).toEqual([]);
});

test("a server that only speaks Chat Completions is offered under Codex, a Messages one under Claude Code", () => {
  const chat = chatStarters({ ready: [], accounts: [], servers: [server({ protocols: { responses: "no", messages: "no", chat: "yes" } })] });
  expect(chat.servers[0].target).toMatchObject({ provider: "codex" });
  const messages = chatStarters({ ready: [], accounts: [], servers: [server({ protocols: { responses: "no", messages: "yes", chat: "no" } })] });
  expect(messages.servers[0].target).toMatchObject({ provider: "claude" });
  // An agent that isn't installed here comes last, so the row names the one that will really run it.
  const both = chatStarters({ ready: [], accounts: [], servers: [server({ protocols: { responses: "yes", messages: "yes", chat: "yes" } })], installed: { codex: false, claude: true } });
  expect(both.servers[0].target).toMatchObject({ provider: "claude" });
});

test("a service whose agent isn't installed here isn't offered: the chat could never answer", () => {
  const accounts = [endpoint("Venice", "https://api.venice.ai/api", ["venice-uncensored"]), endpoint("Qwen here", "http://127.0.0.1:8080", ["qwen"], { provider: "claude" })];
  const none = chatStarters({ ready: [], accounts, installed: { codex: false, claude: false } });
  expect([none.agents.length, none.services.length]).toEqual([0, 0]);
  // Only the agent that is here keeps its services.
  const claudeOnly = chatStarters({ ready: ["claude"], accounts, installed: { codex: false, claude: true } });
  expect(claudeOnly.services.map((r) => r.title)).toEqual(["Qwen here"]);
  // Nothing is hidden while the hub hasn't said yet (the status arrives after the accounts do).
  expect(chatStarters({ ready: [], accounts }).services.map((r) => r.title)).toEqual(["Qwen here", "Venice"]);
});

test("a service on OpenCode is a row of its own only where OpenCode is installed; Crosstalk's own agent is always there", () => {
  const onOpenCode = endpoint("Refuseless", "https://api.refuseless.com", ["deepseek-v4.1-flash-abliterated"], { provider: "opencode" });
  const onCrosstalk = endpoint("NanoGPT", "https://nano-gpt.com/api", ["deepseek/deepseek-v4.1-flash-uncensored"], { provider: "builtin" });
  const accounts = [onOpenCode, onCrosstalk];
  const titles = (installed?: Parameters<typeof chatStarters>[0]["installed"]) => chatStarters({ ready: ["claude"], accounts, installed }).services.map((r) => r.title);
  expect(titles({ opencode: true })).toEqual(["NanoGPT", "Refuseless"]);
  expect(titles({ opencode: false })).toEqual(["NanoGPT"]);
  // Unknown counts as installed, as for any agent: nothing is hidden while the hub is still being asked.
  expect(titles({})).toEqual(["NanoGPT", "Refuseless"]);
  expect(titles()).toEqual(["NanoGPT", "Refuseless"]);
  // The row starts the chat on that account with that agent, and names no agent while its name is its own.
  const row = chatStarters({ ready: [], accounts: [onOpenCode], installed: { opencode: true } }).services[0];
  expect(row.target).toEqual({ kind: "service", provider: "opencode", account: "refuseless", model: "deepseek-v4.1-flash-abliterated", label: "Refuseless", noTools: false });
  expect(row.help).toBe("deepseek-v4.1-flash-abliterated · api.refuseless.com");
  expect(row.provider).toBe("opencode");
  // It's on no agent's own screen: Claude Code's and Codex's screens list their own services.
  expect(agentStarters([row], "codex")).toEqual([]);
  expect(agentStarters([row], "claude")).toEqual([]);
  // The same name under both is told apart by the agent, which is the whole difference between them.
  const both = chatStarters({ ready: [], accounts: [onOpenCode, { ...onOpenCode, provider: "builtin", id: "old" }] }).services;
  expect(both.map((r) => [r.id, r.help])).toEqual([
    ["service:builtin:old", "deepseek-v4.1-flash-abliterated · api.refuseless.com · Crosstalk agent"],
    ["service:opencode:refuseless", "deepseek-v4.1-flash-abliterated · api.refuseless.com · OpenCode"],
  ]);
});

test("a tap on a service on OpenCode keeps the effort empty until a level of its own model is picked", () => {
  const base = { account: "default", model: "", effort: "high", permissionMode: "ask" as const, helperModel: "" };
  expect(targetChoice(base, { kind: "service", provider: "opencode", account: "r1", model: "deepseek-v4.1-flash-abliterated" })).toEqual({ account: "r1", model: "deepseek-v4.1-flash-abliterated", effort: "", permissionMode: "ask", helperModel: "" });
});

test("two services with the same name are told apart by the agent that drives them", () => {
  // What the model pool makes every time it runs: the same account under both agents, with the same name.
  const pool = (provider: "codex" | "claude") => endpoint("Model pool", "http://100.64.0.3:8080", ["pool-qwen3"], { provider, id: `pool-${provider}` });
  const starters = chatStarters({ ready: ["claude", "codex"], accounts: [pool("codex"), pool("claude")] });
  expect(starters.services.map((r) => [r.id, r.help])).toEqual([
    ["service:claude:pool-claude", "pool-qwen3 · 100.64.0.3:8080 · Claude Code"],
    ["service:codex:pool-codex", "pool-qwen3 · 100.64.0.3:8080 · Codex"],
  ]);
  // A name of its own says all it needs to: the agent is in the chat's settings, not on the row.
  expect(chatStarters({ ready: ["codex"], accounts: [pool("codex")] }).services[0].help).toBe("pool-qwen3 · 100.64.0.3:8080");
});

test("a tap on a service or a server drops the effort and helper model of the account it replaces", () => {
  const defaults = { account: "default", model: "gpt-5.1-codex", effort: "high", permissionMode: "ask" as const, helperModel: "gpt-5.1-codex-mini" };
  // The service's own account and model, and none of the other account's models: a helper locked to one this server
  // doesn't serve would fail every spawn, and an effort chosen for another model isn't this one's.
  expect(targetChoice(defaults, { kind: "service", provider: "codex", account: "qwen1", model: "qwen3.8-9b" })).toEqual({ account: "qwen1", model: "qwen3.8-9b", effort: "", permissionMode: "ask", helperModel: "" });
  // A server that isn't added yet: the hub makes its account, so the choice says "default" until it answers.
  expect(targetChoice(defaults, { kind: "server", provider: "codex", baseUrl: "http://127.0.0.1:8080", label: "llama.cpp (port 8080)", model: "qwen", models: [] })).toMatchObject({ account: "default", model: "qwen", effort: "", helperModel: "" });
  // An agent or a group chat is your defaults as they stand.
  expect(targetChoice(defaults, { kind: "agent", provider: "codex" })).toEqual(defaults);
  expect(targetChoice(defaults, { kind: "group" })).toEqual(defaults);
  // A choice without a helper model (Settings → Defaults' own editors) doesn't grow one.
  expect(targetChoice({ account: "default", model: "", effort: "low" }, { kind: "service", provider: "codex", account: "ven1", model: null })).toEqual({ account: "ven1", model: "", effort: "" });
});

test("a model the service says can't run tools is marked, in the row and on the target", () => {
  const noTools = chatStarters({
    ready: [],
    accounts: [endpoint("Venice", "https://api.venice.ai/api", ["venice-talker"])],
    models: () => [model("venice-talker", { noTools: true })],
  });
  expect(noTools.services[0].noTools).toBe(true);
  expect(noTools.services[0].target).toMatchObject({ noTools: true });
  // A server found here: the scan's own flag says it.
  const found = chatStarters({ ready: [], accounts: [], servers: [server({ models: [{ id: "talker", contextWindow: null, sizeBytes: null, loaded: true, tools: false }] })] });
  expect(found.servers[0].noTools).toBe(true);
  expect(noToolsWords("venice-talker")).toBe("venice-talker can talk, but it can't read files or run commands.");
});

/**
 * Said in the same place as "No tools" and the too-small-to-answer note (views/AgentOptions), for a custom-model account:
 * a model with room to work in but not for the person's own Codex plugins and ChatGPT app connectors runs without them
 * (hub/src/agents/codex.ts), and that is said where the model is picked rather than left to be noticed in the chat.
 */
test("a model too small for your own Codex plugins says so where it's picked, and the two notes never both appear", () => {
  const words = leanToolsWords("codex", "qwen3.8-9b", 16_384)!;
  expect(words).toContain("qwen3.8-9b holds 16,384 tokens");
  expect(words).toContain("Codex's own tools and Crosstalk's only");
  expect(words).not.toContain("undefined");
  // What the person's own catalogue costs is never stated here: only a measurement of their own account knows that, and the
  // line beside this one says it with the day it was taken (toolCostLine). A figure from one Mac would be a guess anywhere else.
  expect(words).not.toMatch(/\d{3},\d{3}/);
  // One note at a time: a model with no room to answer at all is refused in the other note's words.
  expect(smallWindowWords("codex", "qwen3.8-9b", 8_192)).not.toBeNull();
  expect(leanToolsWords("codex", "qwen3.8-9b", 8_192)).toBeNull();
  expect(smallWindowWords("codex", "qwen3.8-9b", 16_384)).toBeNull();
  // A model with room for them, a window nobody stated, and a Claude Code chat (no catalogue of the person's): nothing.
  expect(leanToolsWords("codex", "big", CODEX_LEAN_TOOLS_BELOW)).toBeNull();
  expect(leanToolsWords("codex", "qwen3.8-9b", null)).toBeNull();
  expect(leanToolsWords("claude", "qwen3.8-9b", 16_384)).toBeNull();
});

test("with more models than a phone screen holds, the rest fold away behind one button", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, target: { kind: "agent" as const, provider: "codex" as const }, title: `S${i}`, help: "", provider: "codex" as const, where: null, noTools: false }));
  expect(foldStarters(rows(STARTERS_SHOWN)).folded).toEqual([]);
  const folded = foldStarters(rows(STARTERS_SHOWN + 1));
  // Never folding just one away: the button takes a row's place, so it always stands for two or more.
  expect(folded.first).toHaveLength(STARTERS_SHOWN - 1);
  expect(folded.folded).toHaveLength(2);
});

test("a found server's models make a picker of their own, the first being the one the hub will save", () => {
  const options = serverModelOptions([
    { id: "talker", contextWindow: 8192, sizeBytes: null, loaded: false, tools: false },
    { id: "worker", contextWindow: 16384, sizeBytes: null, loaded: true },
  ]);
  expect(options.map((m) => [m.id, m.isDefault, m.noTools, m.contextWindow])).toEqual([
    ["talker", false, true, 8192],
    ["worker", true, undefined, 16384],
  ]);
  // A name no agent could pass as one word is dropped, as it is in Settings → AI services: the menu and the dialog
  // offer the models the hub will really save, so a tap can't start a chat on a model that never gets added.
  const messy = [{ id: "not a model", contextWindow: null, sizeBytes: null, loaded: false }, { id: "good", contextWindow: 4096, sizeBytes: null, loaded: true }];
  expect(serverModelOptions(messy).map((m) => [m.id, m.isDefault])).toEqual([["good", true]]);
  const starters = chatStarters({ ready: [], accounts: [], servers: [server({ models: messy })] });
  expect([starters.servers[0].target, starters.servers[0].help]).toMatchObject([{ model: "good" }, "good · add it and start"]);
  // A server whose every name is unusable isn't offered at all: there would be nothing to save.
  expect(chatStarters({ ready: [], accounts: [], servers: [server({ models: [messy[0]] })] }).servers).toEqual([]);
});
