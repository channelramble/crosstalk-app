import { expect, test } from "bun:test";
import type { AgentAccount, LocalServer, Member, PoolOffer, Room } from "@crosstalk/shared";
import { chatGroups, chatIdentity, identityWhere, isPoolAccount, POOL_GROUP, SERVICE_COLOR } from "./chatIdentity";
import { agentStarters, chatStarters, targetChoice } from "./newChat";
import { normalizeOffer, poolAction, poolAgentFor, poolAgents, poolAsk, poolHelp, poolModelNote, poolStateWords, poolWhereWords, POOL_BUTTON } from "./poolChat";

// Chatting with the model pool: one entry wherever a chat starts, what it says in each state, what a tap does, and what
// a chat on it calls itself. The hub's own side (PoolOffer, the words a stopped pool gives a chat) is in
// hub/test/pool-chat.test.ts.

/** The pool as the hub offers it while it runs on three machines (hub/src/pool/pool.ts chatOffer). */
const running: PoolOffer = {
  label: "Model pool",
  state: "running",
  detail: "Running on the GPUs of linux-box and gaming-pc.",
  setUp: true,
  ready: true,
  model: "qwen3.8-27b",
  modelName: "Qwen3.8-27B",
  machines: ["linux-box", "gaming-pc", "Mac mini"],
  missing: [],
  accounts: { claude: "pl1", codex: "pl2" },
};
const offer = (over: Partial<PoolOffer> = {}): PoolOffer => ({ ...running, ...over });
/** Stopped, with the accounts its last run left behind. */
const off = offer({ state: "off", ready: false, detail: null });
/** Never set up: only this machine (kv pool.states holds only "self"), no model. */
const unset = offer({ state: "off", ready: false, detail: null, setUp: false, model: null, modelName: null, machines: ["Mac mini"], accounts: {} });

const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: null, plan: null, authMethod: null, error: null, checkedAt: 0, ...over });
const endpoint = (provider: "claude" | "codex", id: string, label: string, baseUrl: string, models: string[]): AgentAccount =>
  account({ provider, id, label, kind: "endpoint", plan: "Custom model", endpoint: { baseUrl, models, contextWindow: null, hasKey: false } });
// The pool's two accounts, as it saves them: the same model at the main machine's address, one under each agent.
const POOL_URL = "http://100.64.0.9:9931";
const POOL_ACCOUNTS = {
  "claude:pl1": endpoint("claude", "pl1", "Model pool", POOL_URL, ["qwen3.8-27b"]),
  "codex:pl2": endpoint("codex", "pl2", "Model pool", POOL_URL, ["qwen3.8-27b"]),
  "codex:qwen1": endpoint("codex", "qwen1", "Qwen here", "http://127.0.0.1:8080", ["qwen3.8-9b"]),
};
const member = (over: Partial<Member> = {}): Member => ({ id: "mb1", roomId: "r1", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0, ...over });
const room = (over: Partial<Room> = {}): Room => ({ id: "r1", name: "Chat", cwd: "/work/app", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false, chat: { provider: "codex", origin: "web" }, ...over });

test("one entry in New chat, called what the pool is, with its model and where it runs", () => {
  const starters = chatStarters({ ready: ["claude", "codex"], accounts: Object.values(POOL_ACCOUNTS), pool: running, machineKey: "" });
  // One row for the pool, not one per agent: its two accounts are the same model on the same machines, and they're no
  // longer among your services.
  expect(starters.yours.map((r) => [r.title, r.help])).toEqual([
    ["Model pool", "qwen3.8-27b · across 3 machines · Ready"],
    ["Qwen here", "qwen3.8-9b · on this machine"],
  ]);
  expect(starters.services.map((r) => r.title)).toEqual(["Qwen here"]);
  expect(starters.pool?.where).toBe("pool");
  expect(starters.pool?.target).toEqual({ kind: "pool", provider: "claude", offer: running, machine: "" });
  // A pool of one machine says that machine's name instead of counting.
  expect(poolWhereWords(offer({ machines: ["Mac mini"] }))).toBe("on Mac mini");
  expect(poolWhereWords(offer({ machines: [] }))).toBe("no machines yet");
});

test("the entry says which state the pool is in, and a pool nobody has set up says what it would be", () => {
  const words = (o: PoolOffer) => [poolStateWords(o), poolAction(o), POOL_BUTTON[poolAction(o)]];
  expect(words(running)).toEqual(["Ready", "chat", "Start chat"]);
  expect(words(offer({ state: "downloading", ready: false, detail: "Downloading the model to linux-box…" }))).toEqual(["Downloading…", "watch", "Open Model pool"]);
  expect(words(offer({ state: "starting", ready: false }))).toEqual(["Starting…", "watch", "Open Model pool"]);
  expect(words(off)).toEqual(["Off", "start", "Start the pool"]);
  // A machine it needs didn't answer: that's the state, and checking the machines is the way out.
  expect(words(offer({ state: "off", ready: false, missing: ["gaming-pc"] }))).toEqual(["Needs gaming-pc", "fix", "Check the machines"]);
  expect(words(offer({ state: "error", ready: false, detail: "The helper on gaming-pc stopped: it didn't say why." }))).toEqual(["Problem", "fix", "Check the machines"]);
  expect(words(offer({ state: "stopping", ready: false, detail: null }))).toEqual(["Stopping…", "watch", "Open Model pool"]);
  expect(words(unset)).toEqual(["Not set up", "set-up", "Set up the model pool"]);
  expect(poolHelp(unset)).toBe("One big model across your machines · Set it up");
  expect(poolHelp(off)).toBe("qwen3.8-27b · across 3 machines · Off");
  // Two machines missing, in plain words.
  expect(poolStateWords(offer({ state: "off", ready: false, missing: ["linux-box", "gaming-pc"] }))).toBe("Needs linux-box and gaming-pc");
});

test("a pool that isn't set up is offered last, so it never pushes a model you can use off the screen", () => {
  const server: LocalServer = {
    id: "llamacpp-8080",
    kind: "llamacpp",
    label: "llama.cpp (port 8080)",
    baseUrl: "http://127.0.0.1:9099",
    models: [{ id: "qwen3.8-9b", contextWindow: 16384, sizeBytes: null, loaded: true }],
    memoryBytes: null,
    protocols: { responses: "yes", messages: "unknown", chat: "yes" },
    accountIds: [],
  };
  const rows = chatStarters({ ready: ["codex"], accounts: [POOL_ACCOUNTS["codex:qwen1"]], servers: [server], pool: unset }).yours;
  expect(rows.map((r) => r.title)).toEqual(["Qwen here", "llama.cpp (port 8080)", "Model pool"]);
  // Set up, it's a model of yours like any other, and first.
  expect(chatStarters({ ready: ["codex"], accounts: [POOL_ACCOUNTS["codex:qwen1"]], servers: [server], pool: off }).yours.map((r) => r.title)).toEqual(["Model pool", "Qwen here", "llama.cpp (port 8080)"]);
  // No pool at all (an older hub): nothing about it anywhere.
  const none = chatStarters({ ready: ["codex"], accounts: [POOL_ACCOUNTS["codex:qwen1"]] });
  expect(none.pool).toBeNull();
  expect(none.yours.map((r) => r.title)).toEqual(["Qwen here"]);
});

test("starting the pool is never silent: the dialog says what it will do and how long it takes", () => {
  const ask = poolAsk(off);
  expect(ask.button).toBe("Start the pool");
  expect(ask.words).toContain("runs qwen3.8-27b across 3 machines");
  expect(ask.words).toContain("installs llama.cpp");
  expect(ask.words).toContain("downloads the model");
  expect(ask.words).toContain("a few minutes");
  // Not set up: it says what the pool is and where to set it up, and nothing about starting machines.
  expect(poolAsk(unset).words).toContain("Settings → Model pool");
  expect(poolAsk(unset).words).not.toContain("downloads the model");
  // A problem names it, and what to do about it.
  expect(poolAsk(offer({ state: "error", ready: false, detail: "gaming-pc doesn't answer over Tailscale." })).words).toBe(
    "gaming-pc doesn't answer over Tailscale. Check the machines now: if they answer, you can start the pool here.",
  );
  // On its way: the chat waits for Running, and nothing is started again.
  expect(poolAsk(offer({ state: "starting", ready: false, detail: "Starting the model server on linux-box…" })).words).toContain("once it says Running");
  // On its way out is the other direction: a pool that's stopping is never said to be starting.
  const stopping = poolAsk(offer({ state: "stopping", ready: false, detail: "Stopping the model server on linux-box…" }));
  expect(stopping.words).toBe("Model pool is stopping. Stopping the model server on linux-box… You can start it again in Settings → Model pool once it says Off.");
  expect(stopping.words).not.toContain("is starting");
  // A machine that didn't answer last time is checked again from here: what's known is what the last look found.
  expect(poolAsk(offer({ state: "off", ready: false, detail: null, missing: ["gaming-pc"] })).words).toBe(
    "gaming-pc didn't answer the last time Crosstalk looked. Check the machines now: if they answer, you can start the pool here.",
  );
});

test("the agent that drives it is chosen the way a service's is, and the pool's account follows it", () => {
  expect(poolAgents(running)).toEqual(["claude", "codex"]);
  // An agent that isn't installed here goes last, as a service's does.
  expect(poolAgents(running, { claude: false })).toEqual(["codex", "claude"]);
  expect(poolAgentFor(running, "codex")).toBe("codex");
  expect(poolAgentFor(running, "claude", "codex")).toBe("codex");
  expect(poolAgentFor(offer({ accounts: { codex: "pl2" } }), "claude")).toBe("codex");
  // An agent that isn't on this machine is never the one picked for you: the chat would be made and answer nothing.
  expect(poolAgentFor(running, "claude", null, { claude: false })).toBe("codex");
  expect(poolAgentFor(running, "codex", null, { codex: false })).toBe("claude");
  // One you picked yourself stands (the dialog's Agent select offers both), and so does the order with neither here.
  expect(poolAgentFor(running, "codex", "claude", { claude: false })).toBe("claude");
  expect(poolAgentFor(running, "claude", null, { claude: false, codex: false })).toBe("claude");
  // So the row the menu makes names the agent that can really run it.
  const onlyCodex = chatStarters({ ready: ["codex"], accounts: Object.values(POOL_ACCOUNTS), pool: running, installed: { claude: false } });
  expect(onlyCodex.pool?.target.kind === "pool" && onlyCodex.pool.target.provider).toBe("codex");
  // Never run: no account to drive yet.
  expect(poolAgentFor(unset, "claude")).toBeNull();
  // The dialog's agent fixes the account, and drops an effort and helper model chosen for another account's models.
  const base = { account: "default", model: "gpt-6.1-sol", effort: "high", permissionMode: "ask" as const, helperModel: "gpt-6-astra" };
  expect(targetChoice(base, { kind: "pool", provider: "codex", offer: running })).toEqual({ account: "pl2", model: "qwen3.8-27b", effort: "", permissionMode: "ask", helperModel: "" });
  expect(targetChoice(base, { kind: "pool", provider: "claude", offer: running }).account).toBe("pl1");
});

test("a chat on the pool is the pool and its model, in one group for both agents", () => {
  const onClaude = chatIdentity(room({ chat: { provider: "claude", origin: "web" } }), member({ provider: "claude", config: { account: "pl1" }, model: "qwen3.8-27b" }), POOL_ACCOUNTS, running);
  expect([onClaude.name, onClaude.model, onClaude.where, onClaude.groupKey]).toEqual(["Model pool", "qwen3.8-27b", "pool", POOL_GROUP]);
  expect(onClaude.provider).toBe("claude"); // the agent driving it: the model lock, the helpers and the permissions
  expect(onClaude.color).toBe(SERVICE_COLOR.pool);
  // Where it runs, in the chat's own words: never the main machine's address.
  expect(identityWhere(onClaude, running, "Mac mini")).toBe("across 3 machines");
  const onCodex = chatIdentity(room({ id: "r2" }), member({ config: { account: "pl2" } }), POOL_ACCOUNTS, running);
  expect(onCodex.groupKey).toBe(POOL_GROUP);
  // One heading for the pool, before the services, and it carries the offer so New chat from it starts on the pool.
  const groups = chatGroups(
    [
      { identity: chatIdentity(room({ id: "r3" }), member({ config: { account: "qwen1" } }), POOL_ACCOUNTS, running), machine: "" },
      { identity: onClaude, machine: "" },
      { identity: onCodex, machine: "" },
    ],
    running,
  );
  expect(groups.map((g) => [g.key, g.title])).toEqual([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    [POOL_GROUP, "Model pool"],
    ["svc:codex:qwen1", "Qwen here"],
  ]);
  expect(groups[2].pool).toBe(running);
  expect(groups[3].pool).toBeUndefined();
  // Without the offer (an older hub), a pool chat is just a service of that name: nothing breaks.
  expect(chatIdentity(room(), member({ config: { account: "pl2" } }), POOL_ACCOUNTS).groupKey).toBe("svc:codex:pl2");
  expect(isPoolAccount(POOL_ACCOUNTS["codex:pl2"], running)).toBe(true);
  expect(isPoolAccount(POOL_ACCOUNTS["codex:qwen1"], running)).toBe(false);
  expect(isPoolAccount(POOL_ACCOUNTS["codex:pl2"], null)).toBe(false);
});

test("a chat's model menu tells the truth: one model at a time, and where it's changed", () => {
  expect(poolModelNote(running, "claude")).toBe("Model pool runs one model at a time: qwen3.8-27b. Change it in Settings → Model pool. Driven by Claude Code.");
  // Not "pick another model here": this menu holds the pool's one model, so the other way out is the chat's Account.
  expect(poolModelNote(off, "codex")).toBe("Model pool isn't running, so qwen3.8-27b can't answer. Start it in Settings → Model pool, or move this chat to another account in its settings. Driven by Codex.");
  expect(poolModelNote(off, "codex")).not.toContain("pick another model here");
});

test("both agents' screens list the pool, each driven by its own agent", () => {
  const rows = chatStarters({ ready: ["claude", "codex"], accounts: Object.values(POOL_ACCOUNTS), pool: running, machineKey: "" }).yours;
  const on = (p: "claude" | "codex") => agentStarters(rows, p).map((r) => [r.title, r.provider]);
  // The pool keeps an account for each agent, so it's on both screens — driven by the agent whose screen it's on.
  expect(on("claude")).toEqual([["Model pool", "claude"]]);
  expect(on("codex")).toEqual([["Model pool", "codex"], ["Qwen here", "codex"]]);
  // Its row still carries the pool (the dialog can change the agent), and the machine it runs on.
  const row = agentStarters(rows, "codex")[0];
  expect(row.target).toEqual({ kind: "pool", provider: "codex", offer: running, machine: "" });
  expect(row.where).toBe("pool");
  // A pool that has never run has no account to drive, so it stays on the one screen the menu named it for.
  const never = chatStarters({ ready: ["claude", "codex"], accounts: [], pool: unset }).yours;
  expect(agentStarters(never, "claude").map((r) => r.title)).toEqual(["Model pool"]);
  expect(agentStarters(never, "codex")).toEqual([]);
});

test("an odd offer from a hub can't break the menu", () => {
  const clean = normalizeOffer({ label: "", state: "levitating", detail: 7, setUp: 1, ready: true, model: "", modelName: null, machines: "mini", missing: null, accounts: { claude: "", codex: "pl2", gemini: "x" } } as unknown as PoolOffer);
  expect(clean).toEqual({ label: "Model pool", state: "off", detail: null, setUp: true, ready: false, model: null, modelName: null, machines: [], missing: [], accounts: { codex: "pl2" } });
  // "ready" only counts while it says it runs: an offer that says both would start a chat that can't answer.
  expect(normalizeOffer(offer({ state: "off", ready: true })).ready).toBe(false);
  expect(poolAction(clean)).toBe("set-up");
});
