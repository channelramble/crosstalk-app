// Ask others on the person's other linked machines (docs/SPEC-0.5.md, T11), hub side. Two real hubs (Apps with servers on
// loopback port 0) are linked the way a person links them; the agents on both are a scripted stand-in, so nothing ever starts
// a real agent CLI or reaches a network. Machine A is where the person is (the "Mac mini"); machine B answers (the "PC").

import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT, type AccountSpend, type AgentAccount, type Ask, type AskTarget, type ChatProvider, type Member, type Message, type ModelOption, type Room } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { App } from "../src/app";
import { ensureAsks } from "../src/asks";
import { PEER_ANSWER, PEER_BODY, PEER_CHARS, PEER_RATE, PeerLists, peerProblem, readCapped, readPeerModels, readPeerRows, remoteHandle, theMachine } from "../src/asksRemote";
import { ASK_QUESTION } from "../src/duplicate";
import { startServer } from "../src/server";
import type { SpendEntry } from "../src/spend";
import { newId } from "../src/util/ids";

setDefaultTimeout(30_000);

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

async function until(cond: () => boolean, what = "something", ms = 8_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

// ------------------------------------------------------------------------------------------------ the agents

interface Made {
  ctx: DriverContext;
  inputs: TurnInput[];
  disposed: boolean;
  /** Where the agent was started, and what that folder held at that moment. */
  folder: { cwd: string; entries: string[] };
}
type Behave = (c: { ctx: DriverContext; input: TurnInput; sink: TurnSink }) => TurnResult | Promise<TurnResult>;
const made: Made[] = [];
const answers: Behave = ({ ctx }) => ({ ok: true, text: `Answer from ${ctx.member.provider}` });
let behave: Behave = answers;

class Scripted implements AgentDriver {
  readonly provider;
  private rec: Made;
  constructor(private ctx: DriverContext) {
    this.provider = ctx.member.provider;
    const cwd = ctx.room.cwd;
    this.rec = { ctx, inputs: [], disposed: false, folder: { cwd, entries: existsSync(cwd) ? readdirSync(cwd) : ["(missing)"] } };
    made.push(this.rec);
  }
  async runTurn(input: TurnInput, sink: TurnSink) {
    this.rec.inputs.push(input);
    return behave({ ctx: this.ctx, input, sink });
  }
  async interrupt() {}
  async dispose() {
    this.rec.disposed = true;
  }
}

const untilStopped = (sink: TurnSink) => new Promise<TurnResult>((res) => sink.signal.addEventListener("abort", () => res({ ok: false, error: "stopped" }), { once: true }));
const stuck = () => new Promise<TurnResult>(() => {});

const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  behave = answers;
  made.length = 0;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  // Back to what providers/all.ts registers.
  registerDriver("claude", (ctx) => {
    if (!ctx.bin) throw new Error("Claude Code isn't installed on the hub. Install it under Agents & sign-ins.");
    return new ClaudeDriver(ctx, ctx.bin);
  });
  registerDriver("codex", (ctx) => {
    if (!ctx.bin) throw new Error("Codex isn't installed on the hub. Install it under Agents & sign-ins.");
    return new CodexDriver(ctx, ctx.bin);
  });
});

// ------------------------------------------------------------------------------------------------ machines

const signin = (provider: ChatProvider): AgentAccount => ({ provider, id: DEFAULT_ACCOUNT, label: "Main", kind: "signin", workspaceId: null, endpoint: null, signedIn: true, account: "me@example.com", plan: "Max", authMethod: "oauth", error: null, checkedAt: 0 });
const apiKey = (provider: ChatProvider, id: string, label: string): AgentAccount => ({ ...signin(provider), id, label, kind: "apikey", plan: null, authMethod: "apikey" });
const model = (id: string, label: string, more: Partial<ModelOption> = {}): ModelOption => ({ id, label, description: null, efforts: [], defaultEffort: null, isDefault: false, ...more });
const FIX = join(import.meta.dir, "fixtures");

/** A hub with a signed-in Claude Code and Codex, a server of its own on loopback, and its agents scripted. Nothing leaves this process. */
async function machine(name: string, o: { on?: boolean } = {}) {
  registerDriver("claude", (ctx) => new Scripted(ctx));
  registerDriver("codex", (ctx) => new Scripted(ctx));
  process.env.CLAUDE_CONFIG_DIR = temp("ct-remote-claude-");
  process.env.CODEX_HOME = join(temp("ct-remote-codex-"), "codex-home");
  const workspaces = temp("ct-remote-work-");
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: workspaces, maxHopsDefault: 6 } });
  app.providers.which = (p) => (p === "claude" ? join(FIX, "fake-claude") : p === "codex" ? join(FIX, "fake-codex-app") : null);
  const main: Record<ChatProvider, AgentAccount> = { claude: signin("claude"), codex: signin("codex") };
  const extra: AgentAccount[] = [];
  const saved = app.providers.accounts.bind(app.providers);
  app.providers.accounts = () => (["claude", "codex"] as const).flatMap((p) => [main[p], ...saved().filter((a) => a.provider === p && a.id !== DEFAULT_ACCOUNT), ...extra.filter((a) => a.provider === p)]);
  const lists: Record<ChatProvider, ModelOption[]> = {
    claude: [model("opus", "Opus 5.5", { resolvedModel: "claude-opus-5-5", isDefault: true }), model("sonnet", "Sonnet 4.6")],
    codex: [model("gpt-test", "GPT Test", { isDefault: true, defaultEffort: "medium", efforts: ["low", "medium", "high"] })],
  };
  /** While set, this machine can't read a model list (a slow machine): a test opens the gate when it's done with it. */
  const slow = { gate: null as Promise<void> | null };
  app.providers.models = async (p, account = DEFAULT_ACCOUNT) => {
    await slow.gate;
    const server = app.providers.endpointOf(p, account);
    const models = server ? server.models.map((m, i) => model(m, m, { isDefault: i === 0 })) : lists[p as ChatProvider];
    return { provider: p, accountId: account, models, live: true, error: null };
  };
  const spent: SpendEntry[] = [];
  const limits = new Map<string, string>();
  const caps = new Map<string, number>();
  const nothing = { usd: 0, replies: 0, unpriced: 0, inputTokens: 0, outputTokens: 0 };
  app.spend.record = (e) => void spent.push(e);
  app.spend.checkBudget = (p, a) => limits.get(`${p}:${a}`) ?? null;
  app.spend.accounts = () =>
    [...caps].map(([key, limitUsd]): AccountSpend => {
      const [provider, account] = key.split(":");
      return { provider: provider as ChatProvider, account, label: account, kind: "apikey", today: nothing, month: nothing, total: nothing, budget: { limitUsd, period: "month", since: 0, usedUsd: limitUsd, percent: 100, state: "stopped" } };
    });
  // No disk checks (when space is low they clear this Mac's caches) and no notifications.
  app.storage.check = async () => {};
  app.push.send = async () => ({ sent: 0, failed: 0 });
  app.setHubSettings({ machineName: name, agentsAcrossChats: o.on ?? true });
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  app.config.publicUrl = base;
  const token = (await app.auth.pair((await app.auth.createPairingCode()).code, `${name} phone`, "Web"))!.token;
  cleanups.push(async () => {
    app.asks.limits.graceMs = 20;
    await app.asks.shutdown();
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
  });

  let at = Date.parse("2026-10-28T09:00:00Z");
  const folders: string[] = [];
  const chat = (provider: ChatProvider = "claude", chatName = "Fix login") => {
    const cwd = temp("ct-remote-cwd-");
    folders.push(cwd);
    const room = app.chats.create({ provider, name: chatName, cwd, model: null, effort: null });
    return { room, member: app.chats.member(room.id)! as Member };
  };
  const say = (c: { room: Room; member: Member }, from: Message["authorKind"], text: string): Message => {
    const msg: Message = { id: newId("m"), roomId: c.room.id, authorKind: from, memberId: from === "agent" ? c.member.id : null, authorName: from === "agent" ? c.member.handle : "iPhone", text, mentions: [], turnId: null, status: "done", createdAt: (at += 60_000), updatedAt: at, via: null };
    app.store.insertMessage(msg);
    return msg;
  };
  return { app, name, base, token, server, main, extra, lists, slow, spent, limits, caps, workspaces, folders, chat, say };
}
type Machine = Awaited<ReturnType<typeof machine>>;

/** The person's machine (A) and another of theirs (B), linked from A with a code from B, both with agents across chats on: the link becomes two-way. */
async function pair(): Promise<{ a: Machine; b: Machine }> {
  const a = await machine("Mac mini");
  const b = await machine("PC");
  const code = (await b.app.auth.createPairingCode()).code;
  const res = await fetch(`${a.base}/api/machines/link`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: JSON.stringify({ url: b.base, code }) });
  expect(res.status).toBe(200);
  await until(() => a.app.machines.list()[0]?.agents === "two-way" && b.app.machines.list()[0]?.agents === "two-way", "both sides of the link to be two-way", 10_000);
  return { a, b };
}

/** A calling B with A's own sign-in on B, as its hub does. */
function asHub(from: Machine, to: Machine) {
  const token = from.app.machines.linkOf(to.app.hubId())!.token;
  return async (method: string, path: string, body?: unknown, as: string = token) => {
    const res = await fetch(`${to.base}${path}`, { method, headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

const settled = (m: Machine, id: string) => until(() => !["queued", "running"].includes(m.app.asks.get(id)!.status), `ask ${id} to end`);
/** The row on A that B offered (by B's handle). */
async function rowOf(a: Machine, c: { room: Room }, handle: string, refresh = false) {
  const row = (await a.app.asks.targetsFor(c.room.id, { refresh })).choices.find((r) => r.handle === handle);
  if (!row) throw new Error(`no row ${handle}`);
  return row;
}
const THE_PC = "the PC";

// ================================================================================================ who can be asked

describe("who can be asked on the other machines", () => {
  test("B's accounts appear on A with the machine named, unique handles, and what B says about each; A's own rows stay as they were", async () => {
    const { a, b } = await pair();
    b.extra.push(apiKey("claude", "k1", "Work key"));
    b.limits.set("claude:k1", "API key has reached its $250 limit, so this reply won't start.");
    b.caps.set("claude:k1", 250);
    b.main.codex.signedIn = false;
    const qwen = b.app.providers.setEndpointAccount("claude", { label: "Qwen3", baseUrl: "http://127.0.0.1:8080", models: ["qwen3-30b"], contextWindow: 65536 });
    const c = a.chat("claude");
    const found = await a.app.asks.targetsFor(c.room.id);
    expect(found.machines).toEqual([]);
    const here = found.choices.filter((r) => !r.machine);
    expect(here.map((r) => r.handle)).toEqual(["codex"]); // A's own: the chat's own agent left out, as before
    expect(here.every((r) => !("machine" in r.target))).toBe(true);
    const there = found.choices.filter((r) => r.machine);
    // B's list as it is for B's own chat, the chat's own agent kind included (B has no chat here).
    expect(there.map((r) => r.handle)).toEqual(["claude-on-pc", "qwen3-on-pc", "work-key-on-pc", "codex-on-pc"]);
    const by = Object.fromEntries(there.map((r) => [r.handle, r]));
    const pc = { id: b.app.hubId(), name: "PC" };
    expect(by["qwen3-on-pc"]).toMatchObject({ machine: pc, label: "Qwen3 · qwen3-30b · on the PC", paid: "no", local: true, available: true, why: null, sub: "", target: { provider: "claude", account: qwen.id, model: "qwen3-30b", machine: pc.id } });
    expect(by["claude-on-pc"]).toMatchObject({ machine: pc, label: "Claude Code · Opus 5.5 · on the PC", sub: "Plan", paid: "no", local: false, available: true, target: { provider: "claude", account: "default", model: "opus", machine: pc.id } });
    expect(by["work-key-on-pc"]).toMatchObject({ available: false, why: "Over its $250 limit", paid: "yes" });
    // Codex isn't asked from another machine (its sandbox isn't confined to the scratch folder), whether it is signed in or not.
    expect(by["codex-on-pc"]).toMatchObject({ available: false, why: "Codex can't be asked from another machine yet" });
    // The same account name on both machines stays two rows.
    expect(by["claude-on-pc"].target.account).toBe("default");
    expect(found.choices.filter((r) => r.target.account === "default" && r.target.provider === "claude").map((r) => r.machine?.name)).toEqual(["PC"]);
  });

  test("the route gives apps from before 0.5 this machine's plain list, and with ?machines=1 every machine's rows and the machines that couldn't say", async () => {
    const { a, b } = await pair();
    const c = a.chat("claude");
    const get = async (query: string) => {
      const res = await fetch(`${a.base}/api/asks/targets?room=${c.room.id}${query}`, { headers: { authorization: `Bearer ${a.token}` } });
      return res.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    let hits = 0;
    const real = b.app.asks.peerTargets.bind(b.app.asks);
    b.app.asks.peerTargets = () => (hits++, real());
    const plain = await get("");
    expect(Array.isArray(plain)).toBe(true);
    expect(plain.map((r: { handle: string }) => r.handle)).toEqual(["codex"]); // an older app's list: this machine only, and the other machines weren't asked
    expect(hits).toBe(0);
    const both = await get("&machines=1");
    expect(both.machines).toEqual([]);
    expect(both.choices.filter((r: { machine?: unknown }) => !r.machine)).toEqual(plain);
    expect(both.choices.some((r: { machine?: unknown }) => r.machine)).toBe(true);
    expect(hits).toBe(1);
    // B turns the switch off: its rows go, and the line says why.
    b.app.setHubSettings({ agentsAcrossChats: false });
    const off = await get("&machines=1&refresh=1");
    expect(off.choices.some((r: { machine?: unknown }) => r.machine)).toBe(false);
    expect(off.machines).toEqual([{ id: b.app.hubId(), name: "PC", why: "Agents across chats is off on the PC: turn it on in its Settings." }]);
  });

  test("answers are kept 30 seconds, asked again on refresh or when old, and asked once when two ask together", async () => {
    const { a, b } = await pair();
    const c = a.chat("claude");
    let hits = 0;
    const real = b.app.asks.peerTargets.bind(b.app.asks);
    b.app.asks.peerTargets = () => (hits++, real());
    await Promise.all([a.app.asks.targets(c.room.id), a.app.asks.targets(c.room.id)]);
    expect(hits).toBe(1);
    await a.app.asks.targets(c.room.id);
    expect(hits).toBe(1);
    await a.app.asks.targets(c.room.id, { refresh: true });
    expect(hits).toBe(2);
    expect(a.app.asks.peerLimits.keepMs).toBe(30_000);
    a.app.asks.peerLimits.keepMs = 40;
    await Bun.sleep(60);
    await a.app.asks.targets(c.room.id);
    expect(hits).toBe(3);
  });

  test("a machine that's off, or too slow, adds a line and nothing else, and never holds the sheet up", async () => {
    const { a, b } = await pair();
    const c = a.chat("claude");
    // Slow: it gets a few seconds (here a fraction of one), then it's left out.
    a.app.asks.peerLimits.listMs = 150;
    let open!: () => void;
    b.slow.gate = new Promise<void>((res) => (open = res));
    const t0 = Date.now();
    const slow = await a.app.asks.targetsFor(c.room.id);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(slow.choices.some((r) => r.machine)).toBe(false);
    expect(slow.choices.map((r) => r.handle)).toEqual(["codex"]);
    expect(slow.machines).toEqual([{ id: b.app.hubId(), name: "PC", why: "The PC didn't answer." }]);
    // Said again from what was kept (not asked again for 30 seconds), and a refresh asks again.
    const again = Date.now();
    expect((await a.app.asks.targetsFor(c.room.id)).machines).toHaveLength(1);
    expect(Date.now() - again).toBeLessThan(100);
    open();
    b.slow.gate = null;
    expect((await a.app.asks.targetsFor(c.room.id, { refresh: true })).machines).toEqual([]);
    // Switched off, then not running at all.
    b.server.stop(true);
    const gone = await a.app.asks.targetsFor(c.room.id, { refresh: true });
    expect(gone.choices.some((r) => r.machine)).toBe(false);
    expect(gone.machines[0].why).toBe("The PC didn't answer.");
  });

  test("a machine that didn't answer last time isn't waited for again: its last word is used at once while it's asked again behind the scenes", async () => {
    const { a, b } = await pair();
    const c = a.chat("claude");
    a.app.asks.peerLimits.listMs = 400;
    let hits = 0;
    const real = b.app.asks.peerTargets.bind(b.app.asks);
    b.app.asks.peerTargets = () => (hits++, real());
    let open!: () => void;
    b.slow.gate = new Promise<void>((res) => (open = res));
    // Nothing is known of B yet: the first look waits for it, up to the limit.
    const t0 = Date.now();
    expect((await a.app.asks.targetsFor(c.room.id)).machines).toEqual([{ id: b.app.hubId(), name: "PC", why: "The PC didn't answer." }]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(hits).toBe(1);
    // Its word gets old while it's still silent: the sheet doesn't wait for it again, and B is asked again meanwhile.
    a.app.asks.peerLimits.keepMs = 40;
    await Bun.sleep(60);
    const t1 = Date.now();
    const quick = await a.app.asks.targetsFor(c.room.id);
    expect(Date.now() - t1).toBeLessThan(150);
    expect(quick.machines).toHaveLength(1);
    expect(quick.choices.some((r) => r.machine)).toBe(false);
    await until(() => hits === 2, "B to be asked again behind the scenes");
    // B answers: the look under way keeps its rows, and the next sheet has them at once.
    open();
    b.slow.gate = null;
    a.app.asks.peerLimits.keepMs = 30_000;
    let rows = 0;
    for (const end = Date.now() + 5_000; !rows && Date.now() < end; ) {
      rows = (await a.app.asks.targetsFor(c.room.id)).choices.filter((r) => r.machine).length;
      if (!rows) await Bun.sleep(20);
    }
    expect(rows).toBeGreaterThan(0);
    // "Try again" is a person asking: it waits for B, and asks it again whatever was kept.
    const before = hits;
    expect((await a.app.asks.targetsFor(c.room.id, { refresh: true })).machines).toEqual([]);
    expect(hits).toBe(before + 1);
  });

  test("a machine older than 0.5, or one that failed some other way, adds nothing, not even a line", async () => {
    const { a, b } = await pair();
    const c = a.chat("claude");
    b.app.asks.peerTargets = () => Promise.reject(new Error("boom")); // a 500
    const found = await a.app.asks.targetsFor(c.room.id, { refresh: true });
    expect(found.machines).toEqual([]);
    expect(found.choices.some((r) => r.machine)).toBe(false);
  });

  test("what another hub says is checked: odd rows are dropped, long lines cut, at most 60 rows", () => {
    const good = { target: { provider: "claude", account: "default", model: "opus", effort: null }, label: "Claude Code · Opus 5.5", sub: "Plan", handle: "claude", paid: "no", local: false, available: true, why: null, typicalCostUsd: 0.1 };
    const rows = readPeerRows([
      good,
      { ...good, target: { ...good.target, provider: "gemini" } },
      { ...good, target: { ...good.target, account: "../etc" } },
      { ...good, target: { ...good.target, model: "no spaces allowed" } },
      { ...good, label: "" },
      { ...good, label: `Line\none ${"x".repeat(200)}`, paid: "maybe", available: false, why: undefined, typicalCostUsd: -3 },
      "nonsense",
      null,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(good as never);
    expect(rows[1].label).toHaveLength(80);
    expect(rows[1].label.startsWith("Line one xxx")).toBe(true);
    expect(rows[1]).toMatchObject({ paid: "unknown", available: false, why: "Not available right now", typicalCostUsd: null });
    expect(readPeerRows(Array.from({ length: 100 }, () => good))).toHaveLength(60);
    expect(readPeerRows({ not: "a list" })).toEqual([]);
  });

  test("handles are unique across machines and read as @name-on-machine", () => {
    expect(remoteHandle("qwen", "PC", new Set())).toBe("qwen-on-pc");
    expect(remoteHandle("qwen", "PC", new Set(["qwen-on-pc"]))).toBe("qwen-on-pc-2");
    expect(remoteHandle("claude", "Anna's MacBook Pro (work)", new Set())).toBe("claude-on-anna-s-macbook-p");
    expect(remoteHandle("", "###", new Set())).toBe("agent-on-other");
    expect(theMachine("PC")).toBe("the PC");
    expect(theMachine("Anna's laptop")).toBe("Anna's laptop");
    expect(theMachine("The Studio")).toBe("The Studio");
  });
});

// ================================================================================================ asking

describe("asking a model on another machine", () => {
  test("it runs on B's agent, and the answer lands in a card on A that names the machine; nothing is kept as a chat on B", async () => {
    const { a, b } = await pair();
    b.extra.push(apiKey("claude", "k1", "Work key"));
    const c = a.chat("codex", "Fix login");
    a.say(c, "human", "Fix the login bug");
    a.say(c, "agent", "Fixed it.");
    const msg = a.say(c, "human", "Now add tests");
    behave = ({ sink }) => {
      sink.usage({ inputTokens: 1200, outputTokens: 80, cachedInputTokens: 0, costUsd: 0.04 });
      return { ok: true, text: "Check the refresh race." };
    };
    const row = await rowOf(a, c, "work-key-on-pc");
    const events: string[] = [];
    a.app.bus.on((e) => e.t === "ask" && events.push(e.ask.status));
    const [started] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target], note: "Is this safe?" });
    expect(started).toMatchObject({ status: "running", local: false, label: "Claude Code (Work key) · Opus 5.5 · on the PC", target: { provider: "claude", account: "k1", model: "opus", machine: b.app.hubId() } });
    await settled(a, started.id);
    const done = a.app.asks.get(started.id)!;
    expect(done).toMatchObject({ status: "done", answer: "Check the refresh race.", error: null, local: false, note: "Is this safe?", cost: { costUsd: 0.04, basis: "exact", inputTokens: 1200, outputTokens: 80 } });
    expect(events).toEqual(["queued", "running", "done"]); // the first one is seen once it was made, then once it began
    // The card is on A like any ask: listed with the chat, in A's table, with the machine.
    expect(a.app.asks.list(c.room.id).map((x) => x.id)).toEqual([started.id]);
    expect(a.app.asks.list(c.room.id)[0].target.machine).toBe(b.app.hubId());

    // B ran it once, as B's own account and model, with the briefing, the person's question, read-only and unsaved.
    expect(made).toHaveLength(1);
    const run = made[0];
    expect(run.ctx.member).toMatchObject({ provider: "claude", model: "opus", permissionMode: "ask" });
    expect(run.ctx.member.config).toEqual({ account: "k1" });
    expect(run.ctx.chat).toMatchObject({ ephemeral: true, helper: null });
    expect(run.inputs[0].prompt).toBe("Is this safe?");
    const note = run.inputs[0].systemNote!;
    expect(note).toContain("▶ [The user]\nNow add tests");
    expect(note).toContain("[Codex]\nFixed it.");
    expect(note).toContain("The chat works in a folder on another machine that you can't open.");
    expect(note).not.toContain(c.room.cwd); // A's folder names stay home
    expect(b.app.store.listRooms()).toHaveLength(0);
    expect(b.app.store.listMessages(run.ctx.room.id, { limit: 10 })).toHaveLength(0);
    expect(b.app.engine.runningTurns()).toHaveLength(0);
    // B's ledger has it as an ask from A (with B's figure); A's has nothing (those aren't A's accounts).
    expect(b.spent).toEqual([expect.objectContaining({ source: "ask", provider: "claude", account: "k1", roomId: null, chatName: "Asked from Mac mini", model: "opus", inputTokens: 1200, outputTokens: 80, costUsd: 0.04, basis: "exact" })]);
    expect(a.spent).toEqual([]);
    // B's asks table keeps a plain row (no answer, no chat) of what was asked of it.
    const kept = b.app.store.db.query("SELECT room_id, message_id, status, label, answer, cost_usd FROM asks").all();
    expect(kept).toEqual([{ room_id: `peer:${a.app.hubId()}`, message_id: "peer", status: "done", label: "Asked from Mac mini", answer: null, cost_usd: 0.04 }]);
  });

  test("a card is titled as B calls the model: through a failed look, after A restarted, and never as the program that talks to B's model server", async () => {
    const { a, b } = await pair();
    b.app.providers.setEndpointAccount("claude", { label: "Qwen3", baseUrl: "http://127.0.0.1:8080", models: ["qwen3-30b"], contextWindow: 65536 });
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "qwen3-on-pc");
    expect(row.label).toBe("Qwen3 · qwen3-30b · on the PC");
    behave = () => ({ ok: false, error: "Rate limited." });
    const ask = async (target: AskTarget) => {
      const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [target] });
      await settled(a, one.id);
      return a.app.asks.get(one.id)!;
    };
    // As after a restart: nothing is known of any machine.
    const restart = () => {
      (a.app.asks as unknown as { peers: PeerLists }).peers = new PeerLists(a.app);
    };
    // A look at B that failed: its rows aren't offered meanwhile, but what they were called isn't forgotten.
    const real = b.app.asks.peerTargets.bind(b.app.asks);
    b.app.asks.peerTargets = () => Promise.reject(new Error("boom"));
    expect((await a.app.asks.targetsFor(c.room.id, { refresh: true })).choices.some((r) => r.machine)).toBe(false);
    expect(await ask(row.target)).toMatchObject({ label: "Qwen3 · qwen3-30b · on the PC", error: "Qwen3 on the PC couldn't answer: Rate limited." });
    // Restarted, and B answers when looked at (once, before the card is made): B's name for it.
    b.app.asks.peerTargets = real;
    restart();
    expect(await ask(row.target)).toMatchObject({ label: "Qwen3 · qwen3-30b · on the PC", error: "Qwen3 on the PC couldn't answer: Rate limited." });
    // Restarted, and B can't say what it calls it: the model and the machine. "Claude Code" is only the program that talks to the model server.
    b.app.asks.peerTargets = () => Promise.reject(new Error("boom"));
    restart();
    expect(await ask(row.target)).toMatchObject({ label: "qwen3-30b · on the PC", error: "qwen3-30b on the PC couldn't answer: Rate limited." });
    // B's own Claude Code sign-in is Claude Code.
    restart();
    expect(await ask({ ...row.target, account: "default", model: "opus" })).toMatchObject({ label: "Claude Code · opus · on the PC" });
  });

  test("with no question typed, B is asked the usual one; the model B would use by default is B's, and a plan sign-in's figure is notional", async () => {
    const { a, b } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    behave = ({ sink }) => {
      sink.usage({ inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.02 });
      return { ok: true, text: "Looks fine." };
    };
    const row = await rowOf(a, c, "claude-on-pc");
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [{ ...row.target, model: null }] });
    await settled(a, one.id);
    expect(made[0].inputs[0].prompt).toBe(ASK_QUESTION);
    expect(made[0].ctx.member.model).toBe("opus");
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "done", cost: { costUsd: 0.02, basis: "plan" } });
    expect(b.spent[0]).toMatchObject({ costUsd: 0.02, basis: "plan" });
  });

  test("a model on B's own machine is free, and says so on A's card", async () => {
    const { a, b } = await pair();
    b.app.providers.setEndpointAccount("claude", { label: "Qwen3", baseUrl: "http://127.0.0.1:8080", models: ["qwen3-30b"], contextWindow: 65536 });
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    behave = ({ sink }) => {
      sink.usage({ inputTokens: 900, outputTokens: 60, cachedInputTokens: 0, costUsd: null });
      return { ok: true, text: "Fine." };
    };
    const row = await rowOf(a, c, "qwen3-on-pc");
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, one.id);
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "done", label: "Qwen3 · qwen3-30b · on the PC", cost: { costUsd: 0, basis: "free" } });
  });

  test("B's agent failing, or running out of time, is said as B's, in plain words", async () => {
    const { a, b } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    behave = () => ({ ok: false, error: "Rate limited." });
    const [bad] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, bad.id);
    expect(a.app.asks.get(bad.id)).toMatchObject({ status: "error", error: "Claude Code on the PC couldn't answer: Rate limited." });
    a.app.asks.limits.timeoutMs = 60;
    b.app.asks.limits.timeoutMs = 60;
    behave = ({ sink }) => untilStopped(sink);
    const [late] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, late.id);
    expect(a.app.asks.get(late.id)).toMatchObject({ status: "error", error: "Claude Code on the PC took longer than 1 minute, so Crosstalk stopped it." });
    behave = () => ({ ok: true, text: "" });
    const [empty] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, empty.id);
    expect(a.app.asks.get(empty.id)).toMatchObject({ status: "error", error: "Claude Code on the PC finished without writing an answer." });
  });

  test("an answer is cut at 8,000 characters on B; A never keeps more than it was sent", async () => {
    const { a } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    behave = () => ({ ok: true, text: "y".repeat(20_000) });
    const row = await rowOf(a, c, "claude-on-pc");
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, one.id);
    expect(a.app.asks.get(one.id)!.answer).toBe(`${"y".repeat(PEER_ANSWER)}\n…(cut short)`);
  });

  test("B runs it in a fresh empty folder that is not a project, then removes it", async () => {
    const { a, b } = await pair();
    const own = b.chat("claude", "B's own project"); // a real chat on B, with a folder of its own
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, one.id);
    const { cwd, entries } = made[0].folder;
    expect(entries).toEqual([]); // empty when the agent started
    for (const project of [...b.folders, ...a.folders, b.workspaces, a.workspaces, own.room.cwd]) {
      expect(cwd.startsWith(`${project}/`) || cwd === project).toBe(false);
      expect(project.startsWith(`${cwd}/`)).toBe(false);
    }
    expect(cwd).toContain("crosstalk-peer-ask-");
    expect(existsSync(cwd)).toBe(false); // gone afterwards
    expect(made[0].ctx.room.cwd).toBe(cwd);
    expect(made[0].ctx.member.permissionMode).toBe("ask");
    // Every approval the agent could raise is refused.
    behave = async ({ sink }) => ({ ok: true, text: `approval: ${await sink.approval({ kind: "command", title: "rm -rf", detail: "" } as never)}` });
    const [two] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, two.id);
    expect(a.app.asks.get(two.id)!.answer).toBe("approval: deny");
  });

  test("B's spending limit refuses: its row says so, and asking anyway ends in a plain card without starting anything", async () => {
    const { a, b } = await pair();
    b.limits.set("claude:default", "Claude Code reached its $12 limit, so this reply didn't start.");
    b.caps.set("claude:default", 12);
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const stale = await rowOf(a, c, "claude-on-pc"); // listed before the limit was reached... it says so already
    expect(stale).toMatchObject({ available: false, why: "Over its $12 limit" });
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [stale.target] });
    await settled(a, one.id);
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "error", error: "On the PC: Claude Code reached its $12 limit, so this reply didn't start. Raise its limit in Settings there, or pick another." });
    expect(made).toHaveLength(0);
    expect(b.spent).toEqual([]);
  });

  test("with Agents across chats off on B, asking is a plain card that says to turn it on there, and nothing runs", async () => {
    const { a, b } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc"); // listed while it was on
    b.app.setHubSettings({ agentsAcrossChats: false });
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, one.id);
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "error", error: "Agents across chats is off on the PC: turn it on in its Settings." });
    expect(made).toHaveLength(0);
    // B's own words, for anyone calling it by hand.
    const direct = await asHub(a, b)("POST", "/api/asks/peer", { target: row.target, systemNote: "", prompt: "Hi" });
    expect(direct).toMatchObject({ status: 403, data: { code: "off", error: "Turn on Agents across chats on PC in Settings, then ask again." } });
    expect((await asHub(a, b)("GET", "/api/asks/peer-targets")).status).toBe(403);
    // Local asks on B itself are not touched by the switch.
    const bChat = b.chat("codex");
    const bMsg = b.say(bChat, "human", "Hi");
    const [local] = await b.app.asks.start({ roomId: bChat.room.id, messageId: bMsg.id, targets: [{ provider: "claude", account: "default", model: null, effort: null }] });
    await settled(b, local.id);
    expect(b.app.asks.get(local.id)!.status).toBe("done");
  });

  test("B not answering is a plain card with Try again; B too slow is the same, and B stops what it was running", async () => {
    const { a, b } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    // Too slow: A gives up a little after its own time cap, hangs up, and B ends the agent it started.
    a.app.asks.limits.timeoutMs = 300;
    a.app.asks.limits.graceMs = 20;
    behave = ({ sink }) => untilStopped(sink);
    const [slow] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, slow.id);
    expect(a.app.asks.get(slow.id)).toMatchObject({ status: "error", error: "The PC didn't answer. Check it's on, then Try again." });
    await until(() => made[0]?.disposed === true, "B to let go of the agent");
    await until(() => b.app.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE status = 'running'").get()!["n" as never] === 0, "B's row to end");
    expect(existsSync(made[0].folder.cwd)).toBe(false);
    // Not running at all.
    b.server.stop(true);
    const [none] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, none.id);
    expect(a.app.asks.get(none.id)).toMatchObject({ status: "error", error: "The PC didn't answer. Check it's on, then Try again." });
    expect(made).toHaveLength(1);
  });

  test("Stop on A ends the call, and B ends the agent and removes its folder", async () => {
    const { a, b } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    behave = ({ sink }) => untilStopped(sink);
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await until(() => made.length === 1, "B's agent to start");
    expect(b.app.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE status = 'running'").get()).toEqual({ n: 1 }); // the idle watcher sees it
    expect(a.app.asks.stop(one.id).status).toBe("stopped"); // at once
    await until(() => made[0].disposed, "B's agent to let go");
    await until(() => !existsSync(made[0].folder.cwd), "B's folder to go");
    await until(() => b.app.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE status = 'running'").get()!["n" as never] === 0, "B's row to end");
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "stopped", answer: null, error: null });
    // A stopped card stays stopped; asking again works.
    behave = answers;
    const [again] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, again.id);
    expect(a.app.asks.get(again.id)!.status).toBe("done");
  });

  test("A shutting down ends what it sent: the card says it didn't finish, and B ends the agent", async () => {
    const { a } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    behave = ({ sink }) => untilStopped(sink);
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await until(() => made.length === 1, "B's agent to start");
    await a.app.asks.shutdown();
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "error", error: "Crosstalk restarted before this answered." });
    await until(() => made[0].disposed, "B's agent to let go");
  });

  test("a card for a chat that's deleted, or a message that's taken back, stops the call", async () => {
    const { a } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    behave = ({ sink }) => untilStopped(sink);
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await until(() => made.length === 1, "B's agent to start");
    a.app.asks.roomRemoved(c.room.id);
    await until(() => made[0].disposed, "B's agent to let go");
    expect(a.app.asks.get(one.id)).toBeNull();
  });

  test("a card whose machine was unlinked while it waited says so, and nothing is sent", async () => {
    const { a, b } = await pair();
    const c = a.chat("claude");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    a.app.asks.limits.running = 0; // waits
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    expect(one.status).toBe("queued");
    await a.app.machines.remove(b.app.hubId());
    a.app.asks.limits.running = 3;
    (a.app.asks as unknown as { pump(): void }).pump();
    await settled(a, one.id);
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "error", error: "That machine isn't connected for this any more. Check Settings → Machines, then Try again." });
    expect(made).toHaveLength(0);
  });

  test("local and remote asks share A's caps: a chat's 6 waiting count both, and the sixth over is refused", async () => {
    const { a } = await pair();
    const c = a.chat("claude");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "claude-on-pc");
    behave = ({ sink }) => untilStopped(sink);
    a.app.asks.limits.running = 1;
    const asked = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target, row.target, { provider: "codex", account: "default", model: null, effort: null }] });
    expect(asked.map((x) => x.status)).toEqual(["running", "queued", "queued"]);
    expect(a.app.asks.get(asked[1].id)!.status).toBe("queued"); // waiting its turn
    await expect(a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target, row.target, row.target, row.target] })).rejects.toMatchObject({ status: 409, code: "busy" });
    for (const x of asked) a.app.asks.stop(x.id);
  });
});

// ================================================================================================ who may call B, and what a call may do

describe("a request to run a model here", () => {
  test("only a linked machine's hub may call: a person's device and a missing or wrong sign-in are refused, and nothing runs", async () => {
    const { a, b } = await pair();
    const call = asHub(a, b);
    const body = { target: { provider: "claude", account: "default", model: "opus", effort: null }, systemNote: "", prompt: "Hi" };
    const phone = await call("POST", "/api/asks/peer", body, b.token);
    expect(phone).toMatchObject({ status: 403, data: { code: "not_linked" } });
    expect(await call("GET", "/api/asks/peer-targets", undefined, b.token)).toMatchObject({ status: 403, data: { code: "not_linked" } });
    expect((await call("POST", "/api/asks/peer", body, "nonsense")).status).toBe(401);
    const none = await fetch(`${b.base}/api/asks/peer`, { method: "POST", body: JSON.stringify(body) });
    expect(none.status).toBe(401);
    expect(made).toHaveLength(0);
    // The linked hub itself gets through.
    expect(await call("POST", "/api/asks/peer", body)).toMatchObject({ status: 200, data: { ok: true, text: "Answer from claude" } });
    expect(made).toHaveLength(1);
  });

  test("a hub that is signed in but not (or no longer) linked is refused too", async () => {
    const { a, b } = await pair();
    // A hub's peer-scope sign-in on B that no link there binds to a hub (as after an unlink).
    const code = (await b.app.auth.createPairingCode(60_000, { scope: "peer", hubId: "h_stranger0001" })).code;
    const paired = await fetch(`${b.base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Stranger", platform: "Crosstalk hub" }) });
    const token = ((await paired.json()) as { token: string }).token;
    const res = await asHub(a, b)("POST", "/api/asks/peer", { target: { provider: "claude", account: "default", model: "opus", effort: null }, systemNote: "", prompt: "Hi" }, token);
    expect(res).toMatchObject({ status: 403, data: { code: "not_linked" } });
    expect((await asHub(a, b)("GET", "/api/asks/peer-targets", undefined, token)).status).toBe(403);
    expect(made).toHaveLength(0);
  });

  test("a machine that isn't linked is never called: not for the list, and not when a card names it", async () => {
    const { a } = await pair();
    // Something listening on loopback that a typed address or a made-up hub could point at.
    const seen: string[] = [];
    const stranger = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(new URL(req.url).pathname), new Response("{}")) });
    cleanups.push(() => void stranger.stop(true));
    const c = a.chat("claude");
    const msg = a.say(c, "human", "Fix it");
    await a.app.asks.targets(c.room.id, { refresh: true });
    expect(seen).toEqual([]);
    const target = { provider: "claude", account: "default", model: "opus", effort: null } as const;
    for (const machine of ["h_unknown00001", `http://127.0.0.1:${stranger.port}`, ""]) {
      await expect(a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [{ ...target, machine }] })).rejects.toMatchObject({ status: 404 });
    }
    expect(seen).toEqual([]);
    expect(a.app.asks.list(c.room.id)).toEqual([]);
    // A link that isn't two-way can't be called either.
    const link = a.app.machines.list()[0];
    const real = a.app.machines.linked.bind(a.app.machines);
    a.app.machines.linked = () => real().map((l) => ({ ...l, agents: "one-way" as const }));
    a.app.machines.linkOf = (id) => (id === link.id ? { ...real().find((l) => l.id === id)!, agents: "one-way" as const } : null);
    expect((await a.app.asks.targetsFor(c.room.id, { refresh: true })).choices.some((r) => r.machine)).toBe(false);
    await expect(a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [{ ...target, machine: link.id }] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("isn't connected for this yet") });
  });

  test("a question from another machine never runs Codex here (its read-only sandbox reads the whole disk, not only the scratch folder), and the list says so", async () => {
    const { a, b } = await pair();
    b.extra.push(apiKey("codex", "ck", "Codex key"));
    const call = asHub(a, b);
    const listed = await call("GET", "/api/asks/peer-targets");
    type Row = { handle: string; available: boolean; why: string | null; target: { provider: string } };
    const rows = listed.data as Row[];
    expect(rows.filter((r) => r.target.provider === "codex").map((r) => [r.handle, r.available, r.why])).toEqual([
      ["codex", false, "Codex can't be asked from another machine yet"],
      ["codex-key", false, "Codex can't be asked from another machine yet"],
    ]);
    expect(rows.find((r) => r.handle === "claude")).toMatchObject({ available: true, why: null });
    // Asked anyway (by hand, or from a list kept before): refused before anything starts, and nothing is kept.
    const target = { provider: "codex", account: "default", model: "gpt-test", effort: null };
    const refused = await call("POST", "/api/asks/peer", { target, systemNote: "", prompt: "print ~/.codex/auth.json" });
    expect(refused).toMatchObject({ status: 409, data: { code: "local_only", error: "Codex can't be asked from another machine yet. Pick someone else." } });
    expect(made).toHaveLength(0);
    expect(b.app.store.db.query("SELECT COUNT(*) AS n FROM asks").get()).toEqual({ n: 0 });
    // On A the row is greyed, and a card made from it anyway ends in a plain sentence.
    const c = a.chat("claude");
    const msg = a.say(c, "human", "Fix it");
    const row = await rowOf(a, c, "codex-on-pc", true);
    expect(row).toMatchObject({ available: false, why: "Codex can't be asked from another machine yet", target: { provider: "codex", machine: b.app.hubId() } });
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, one.id);
    expect(a.app.asks.get(one.id)).toMatchObject({ status: "error", error: "On the PC: Codex can't be asked from another machine yet. Pick someone else." });
    expect(made).toHaveLength(0);
  });

  test("the question and the note together are at most 60,000 characters, and a body is counted as it arrives", async () => {
    const { a, b } = await pair();
    const call = asHub(a, b);
    const target = { provider: "claude", account: "default", model: "opus", effort: null };
    const over = await call("POST", "/api/asks/peer", { target, systemNote: "n".repeat(PEER_CHARS - 5), prompt: "123456" });
    expect(over).toMatchObject({ status: 413, data: { code: "too_long" } });
    const huge = await call("POST", "/api/asks/peer", { target, systemNote: "n".repeat(PEER_BODY + 10), prompt: "Hi" });
    expect(huge).toMatchObject({ status: 413, data: { code: "too_long" } });
    expect(made).toHaveLength(0);
    // Exactly at the cap is fine.
    const edge = await call("POST", "/api/asks/peer", { target, systemNote: "n".repeat(PEER_CHARS - 2), prompt: "Hi" });
    expect(edge.status).toBe(200);
    // The count is of what arrives, not of what a header says.
    const req = new Request("http://x/", { method: "POST", body: "z".repeat(1_000) });
    await expect(readCapped(req, 500)).rejects.toMatchObject({ status: 413 });
    expect(await readCapped(new Request("http://x/", { method: "POST", body: "abc" }), 500)).toBe("abc");
  });

  test("a request with nothing to ask, nobody to ask, or something unreadable is refused with a plain sentence", async () => {
    const { a, b } = await pair();
    const call = asHub(a, b);
    expect(await call("POST", "/api/asks/peer", { target: { provider: "claude", account: "default" }, prompt: "  " })).toMatchObject({ status: 400, data: { error: "There's no question to ask." } });
    expect(await call("POST", "/api/asks/peer", { prompt: "Hi" })).toMatchObject({ status: 400, data: { error: "Say who to ask." } });
    expect(await call("POST", "/api/asks/peer", "{not json")).toMatchObject({ status: 400, data: { error: "That isn't a question Crosstalk can read." } });
    expect(await call("POST", "/api/asks/peer", { target: { provider: "gemini", account: "default" }, prompt: "Hi" })).toMatchObject({ status: 400, data: { error: "You can ask Claude Code or Codex." } });
    expect(await call("POST", "/api/asks/peer", { target: { provider: "claude", account: "nobody" }, prompt: "Hi" })).toMatchObject({ status: 404 });
    expect(await call("POST", "/api/asks/peer", { target: { provider: "claude", account: "default", model: "bad model!" }, prompt: "Hi" })).toMatchObject({ status: 400 });
    expect(made).toHaveLength(0);
  });

  test("B runs at most 3 at once, together with its own asks; one more is told it's busy, and it's taken again when one ends", async () => {
    const { a, b } = await pair();
    const call = asHub(a, b);
    behave = ({ sink }) => untilStopped(sink);
    const body = { target: { provider: "claude", account: "default", model: "opus", effort: null }, systemNote: "", prompt: "Hi" };
    const first = [0, 1, 2].map(() => call("POST", "/api/asks/peer", body));
    await until(() => made.length === 3, "three to run");
    const full = await call("POST", "/api/asks/peer", body);
    expect(full).toMatchObject({ status: 429, data: { code: "busy", error: "PC is answering other questions right now. Try again in a moment." } });
    // B's own person's asks wait their turn behind them (they share the three).
    const bChat = b.chat("codex");
    const bMsg = b.say(bChat, "human", "Hi");
    const [mine] = await b.app.asks.start({ roomId: bChat.room.id, messageId: bMsg.id, targets: [{ provider: "claude", account: "default", model: null, effort: null }] });
    expect(b.app.asks.get(mine.id)!.status).toBe("queued");
    await b.app.asks.shutdown(); // ends all three and the waiting one
    const ended = await Promise.all(first);
    expect(ended.every((r) => r.status === 200 && r.data.stopped === true)).toBe(true);
    expect(made.every((m) => m.disposed)).toBe(true);
    expect(await call("POST", "/api/asks/peer", body)).toMatchObject({ status: 503, data: { code: "busy" } });
  });

  test("one machine may send 20 questions in 10 minutes; the 21st is told to wait", async () => {
    const { a, b } = await pair();
    const call = asHub(a, b);
    const now = Date.now();
    const insert = b.app.store.db.query("INSERT INTO asks (id, room_id, message_id, provider, account, label, status, created_at, ended_at) VALUES (?, ?, 'peer', 'claude', 'default', 'x', 'done', ?, ?)");
    for (let i = 0; i < PEER_RATE.n; i++) insert.run(`ask_old${i}`, `peer:${a.app.hubId()}`, now - 1_000, now - 500);
    const body = { target: { provider: "claude", account: "default", model: "opus", effort: null }, systemNote: "", prompt: "Hi" };
    expect(await call("POST", "/api/asks/peer", body)).toMatchObject({ status: 429, data: { code: "rate" } });
    expect(made).toHaveLength(0);
    // A's card says what B said (for how long), not "busy for a moment".
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const [card] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [(await rowOf(a, c, "claude-on-pc")).target] });
    await settled(a, card.id);
    expect(a.app.asks.get(card.id)).toMatchObject({ status: "error", error: "The PC is taking no more questions from this machine for a few minutes. Try again later, or pick someone on this machine." });
    // Another machine's count is its own, and older ones fall out of the window.
    b.app.store.db.query("UPDATE asks SET created_at = ? WHERE room_id LIKE 'peer:%'").run(now - PEER_RATE.ms - 1_000);
    expect((await call("POST", "/api/asks/peer", body)).status).toBe(200);
  });

  test("a running question shows as running to the idle watcher, and a finished one keeps no answer", async () => {
    const { a, b } = await pair();
    const call = asHub(a, b);
    behave = async ({ sink }) => {
      sink.text("secret answer");
      await Bun.sleep(150);
      return { ok: true, text: "secret answer" };
    };
    const running = call("POST", "/api/asks/peer", { target: { provider: "claude", account: "default", model: "opus", effort: null }, systemNote: "", prompt: "Hi" });
    await until(() => made.length === 1, "it to start");
    const rows = () => b.app.store.db.query("SELECT room_id, status, answer, started_at FROM asks").all() as { room_id: string; status: string; answer: string | null; started_at: number | null }[];
    expect(rows()).toEqual([expect.objectContaining({ room_id: `peer:${a.app.hubId()}`, status: "running", answer: null })]);
    expect((await running).data.text).toBe("secret answer");
    expect(rows()).toEqual([expect.objectContaining({ status: "done", answer: null })]);
    // A hub that was stopped mid-answer leaves nothing "running" behind.
    b.app.store.db.query("UPDATE asks SET status = 'running'").run();
    await b.app.asks.shutdown();
    expect(rows()[0].status).toBe("error");
  });

  test("a failure while answering frees the slot and ends the row, so B isn't left busy or looking busy", async () => {
    const { a, b } = await pair();
    const call = asHub(a, b);
    b.app.asks.limits.running = 1;
    behave = ({ sink }) => {
      sink.usage({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costUsd: null });
      return { ok: true, text: "ok" };
    };
    const real = b.app.spend.priceReply;
    b.app.spend.priceReply = () => {
      throw new Error("the price list broke");
    };
    const body = { target: { provider: "claude", account: "default", model: "opus", effort: null }, systemNote: "", prompt: "Hi" };
    expect((await call("POST", "/api/asks/peer", body)).status).toBe(500);
    expect(b.app.store.db.query("SELECT status FROM asks WHERE room_id LIKE 'peer:%'").all()).toEqual([{ status: "error" }]);
    expect(existsSync(made[0].folder.cwd)).toBe(false);
    // The one slot is free again.
    b.app.spend.priceReply = real;
    expect((await call("POST", "/api/asks/peer", body)).status).toBe(200);
  });

  test("A's own Costs don't change; B's ledger says whose question it was", async () => {
    const { a, b } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    behave = ({ sink }) => {
      sink.usage({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costUsd: null });
      return { ok: true, text: "ok" };
    };
    const row = await rowOf(a, c, "claude-on-pc");
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [row.target] });
    await settled(a, one.id);
    expect(a.spent).toEqual([]);
    expect(b.spent.map((e) => [e.source, e.chatName, e.askId?.startsWith("ask_")])).toEqual([["ask", "Asked from Mac mini", true]]);
  });
});

// ================================================================================================ plain words, and the table

describe("what a failed call says", () => {
  const url = "http://127.0.0.1:7777";
  const err = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, code });
  test("each way a linked machine can fail is a sentence with a way out", () => {
    expect(peerProblem(err(502, "Couldn't reach 127.0.0.1:7777: refused", "unreachable"), "PC", url)).toBe("The PC didn't answer. Check it's on, then Try again.");
    expect(peerProblem(err(403, "127.0.0.1:7777: Turn on Agents across chats on PC in Settings, then ask again.", "off"), "PC", url)).toBe("Agents across chats is off on the PC: turn it on in its Settings.");
    expect(peerProblem(err(401, "127.0.0.1:7777: unauthorized"), "Linux box", url)).toBe("The Linux box no longer accepts this machine's sign-in. Link it again under Settings → Machines, then Try again.");
    expect(peerProblem(err(403, "x", "not_linked"), "PC", url)).toBe("The PC doesn't have this machine linked for this yet. Check Settings → Machines, then Try again.");
    expect(peerProblem(err(404, "127.0.0.1:7777: not found", "not_found"), "PC", url)).toBe("The PC needs a Crosstalk update before it can answer. Update it, then Try again.");
    expect(peerProblem(err(429, "127.0.0.1:7777: PC is answering other questions right now.", "busy"), "PC", url)).toBe("The PC is busy with other questions. Try again in a moment.");
    expect(peerProblem(err(409, "127.0.0.1:7777: Codex isn't signed in. Sign in under Settings → AI services, then ask again.", "not_signed_in"), "PC", url)).toBe("On the PC: Codex isn't signed in. Sign in under Settings → AI services, then ask again.");
    expect(peerProblem(err(409, "127.0.0.1:7777: API key reached its $5 limit, so this reply didn't start.", "budget"), "Anna's laptop", url)).toBe("On Anna's laptop: API key reached its $5 limit, so this reply didn't start. Raise its limit in Settings there, or pick another.");
    expect(peerProblem(err(500, ""), "PC", url)).toBe("The PC couldn't answer. Try again.");
    // A plan window is not a money limit: B's sentence already says what to do, and there is nothing to raise.
    expect(peerProblem(err(409, "127.0.0.1:7777: Claude Code's plan is at 100% of its 5-hour limit. Ask again after it resets, or pick another.", "budget"), "PC", url)).toBe("On the PC: Claude Code's plan is at 100% of its 5-hour limit. Ask again after it resets, or pick another.");
    // B's stop for too many questions from this machine says so, and for how long, not "busy for a moment".
    expect(peerProblem(err(429, "127.0.0.1:7777: PC is taking no more questions from Mac mini for a while.", "rate"), "PC", url)).toBe("The PC is taking no more questions from this machine for a few minutes. Try again later, or pick someone on this machine.");
  });
});

describe("the asks table", () => {
  test("a table made before 0.5 gets the machine column, and its rows still read", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE asks (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL, model TEXT, effort TEXT, label TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, error TEXT, cost_usd REAL, basis TEXT, in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, note TEXT, is_local INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER)");
    db.exec("INSERT INTO asks (id, room_id, message_id, provider, account, label, status, created_at) VALUES ('a1', 'r1', 'm1', 'codex', 'default', 'Codex', 'done', 1)");
    ensureAsks(db);
    ensureAsks(db); // and again: nothing to do
    expect(db.query("SELECT id, machine FROM asks").all()).toEqual([{ id: "a1", machine: null }]);
    expect((db.query("PRAGMA table_info(asks)").all() as { name: string }[]).map((c) => c.name).filter((n) => n === "machine")).toHaveLength(1);
  });
});

// A target's `Ask` type: the card on A is a plain ask with the machine in its target.
const _typed: Ask["target"] = { provider: "claude", account: "default", model: null, effort: null, machine: "h_x" } satisfies AskTarget;
void _typed;

// ================================================================================================ picking the model (newer than 0.6.1)

describe("picking the model of another machine's agent", () => {
  test("B's rows come with B's models and what each costs there; a pick is asked on B, named on A's card, and kept on A", async () => {
    const { a, b } = await pair();
    b.lists.claude = [model("opus", "Opus 5.5", { resolvedModel: "claude-opus-5-5", isDefault: true, efforts: ["low", "high"], contextWindow: 1_000_000 }), model("sonnet", "Sonnet 4.6", { efforts: ["low", "high"], contextWindow: 200_000 })];
    b.extra.push(apiKey("claude", "k1", "Work key"));
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const sheet = async () => Object.fromEntries((await a.app.asks.targetsFor(c.room.id, { models: true, refresh: true })).choices.map((r) => [r.handle, r]));
    const rows = await sheet();
    // B's list, as B's pickers have it, with what an ask on each costs on B (a plan's isn't money, a key's is).
    expect(rows["claude-on-pc"].models!.map((m) => [m.id, m.label, m.contextWindow, m.efforts, m.paid])).toEqual([
      ["opus", "Opus 5.5", 1_000_000, ["low", "high"], "no"],
      ["sonnet", "Sonnet 4.6", 200_000, ["low", "high"], "no"],
    ]);
    expect(rows["work-key-on-pc"].models!.map((m) => m.paid)).toEqual(["yes", "yes"]);
    // Codex on B can't be asked from here at all, so it has nothing to pick.
    expect(rows["codex-on-pc"].models).toBeUndefined();
    expect(rows["codex-on-pc"].fixedModel).toBeUndefined();

    behave = ({ sink }) => (sink.usage({ inputTokens: 900, outputTokens: 60, cachedInputTokens: 0, costUsd: 0.03 }), { ok: true, text: "Looks fine." });
    const pick = { provider: "claude" as const, account: "default", machine: b.app.hubId(), model: "sonnet", effort: "high" };
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [{ ...rows["claude-on-pc"].target, model: "sonnet", effort: "high" }], remember: [pick] });
    // A's card is named as B names the account, with the model picked.
    expect(one).toMatchObject({ label: "Claude Code · Sonnet 4.6 · on the PC", target: { provider: "claude", account: "default", model: "sonnet", effort: "high", machine: b.app.hubId() } });
    await settled(a, one.id);
    // B ran exactly that model and effort.
    expect(made.map((x) => [x.ctx.member.model, x.ctx.member.config.effort])).toEqual([["sonnet", "high"]]);
    // A keeps the pick (B keeps nothing of it): A's next list, and an @name, start on it; B's own list is on its default.
    const next = await sheet();
    expect(next["claude-on-pc"]).toMatchObject({ label: "Claude Code · Sonnet 4.6 · on the PC", target: { model: "sonnet", effort: "high", machine: b.app.hubId() }, remembered: { model: "sonnet", effort: "high" } });
    const popup = (await a.app.asks.targetsFor(c.room.id)).choices.find((r) => r.handle === "claude-on-pc")!;
    expect(popup).toMatchObject({ target: { model: "sonnet", effort: "high" } });
    expect("models" in popup).toBe(false);
    expect(Object.keys(JSON.parse(a.app.store.kvGet("asks.picks")!))).toEqual([`${b.app.hubId()}|claude|default`]);
    expect(b.app.store.kvGet("asks.picks")).toBeNull();
    expect((await b.app.asks.peerTargets()).find((r) => r.target.provider === "claude" && r.target.account === "default")!.target.model).toBe("opus");
    // What asks on it have cost is counted from A's own asks of B's model, per model.
    expect(next["claude-on-pc"].models!.map((m) => [m.id, m.typicalCostUsd])).toEqual([["opus", null], ["sonnet", 0.03]]);
    expect(next["claude-on-pc"].typicalCostUsd).toBe(0.03);
    // The same account on A (A's own Claude Code) keeps its own default: picks are per machine.
    expect(next.claude.target.model).toBe("opus");
  });

  test("asked on the defaults while B's list is missing the kept model for now: A keeps the pick, and it stands again once B lists it", async () => {
    const { a, b } = await pair();
    const both = () => [model("opus", "Opus 5.5", { resolvedModel: "claude-opus-5-5", isDefault: true, efforts: ["low", "high"] }), model("sonnet", "Sonnet 4.6", { efforts: ["low", "high"] })];
    b.lists.claude = both();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = async () => (await a.app.asks.targetsFor(c.room.id, { models: true, refresh: true })).choices.find((r) => r.handle === "claude-on-pc")!;
    const pick = { provider: "claude" as const, account: "default", machine: b.app.hubId(), model: "sonnet", effort: "high" };
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [{ ...(await row()).target, model: "sonnet", effort: "high" }], remember: [pick] });
    await settled(a, one.id);
    // B stops listing Sonnet for a while: A's row is on B's default, and asking it like that keeps the pick.
    b.lists.claude = both().filter((m) => m.id !== "sonnet");
    const onDefault = await row();
    expect(onDefault.remembered).toBeUndefined();
    const [two] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [onDefault.target], remember: [{ ...pick, model: null, effort: null }] });
    await settled(a, two.id);
    expect(JSON.parse(a.app.store.kvGet("asks.picks")!)[`${b.app.hubId()}|claude|default`]).toMatchObject({ model: "sonnet", effort: "high" });
    // B lists it again: A's row is back on the pick.
    b.lists.claude = both();
    expect(await row()).toMatchObject({ target: { model: "sonnet", effort: "high" }, remembered: { model: "sonnet", effort: "high" } });
  });

  test("a machine whose Crosstalk sends no models says so in its row, and is asked with its own model", async () => {
    const { a, b } = await pair();
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    // An older hub ignores ?models=1: its rows come without models.
    const real = b.app.asks.peerTargets.bind(b.app.asks);
    b.app.asks.peerTargets = async () => (await real()).map(({ models: _none, ...r }) => r);
    const row = (await a.app.asks.targetsFor(c.room.id, { models: true, refresh: true })).choices.find((r) => r.handle === "claude-on-pc")!;
    expect(row).toMatchObject({ fixedModel: "update", available: true, target: { model: "opus" }, label: "Claude Code · Opus 5.5 · on the PC" });
    expect(row.models).toBeUndefined();
    // A pick kept from before isn't applied to it (nothing says that machine still has that model).
    await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [{ ...row.target, model: "sonnet" }], remember: [{ provider: "claude", account: "default", machine: b.app.hubId(), model: "sonnet", effort: null }] });
    expect((await a.app.asks.targetsFor(c.room.id, { models: true })).choices.find((r) => r.handle === "claude-on-pc")).toMatchObject({ target: { model: "opus" }, label: "Claude Code · Opus 5.5 · on the PC" });
  });

  test("B's model pool runs one model: its row says so on A, and nothing is offered to pick", async () => {
    const { a, b } = await pair();
    const pool = b.app.providers.setEndpointAccount("claude", { label: "Model pool", baseUrl: "http://127.0.0.1:18080", models: ["qwen-pool", "qwen-other"], contextWindow: 65536 });
    b.app.store.kvSet("pool.accounts", JSON.stringify({ claude: pool.id }));
    const c = a.chat("codex");
    const row = (await a.app.asks.targetsFor(c.room.id, { models: true, refresh: true })).choices.find((r) => r.handle === "model-pool-on-pc")!;
    expect(row).toMatchObject({ fixedModel: "pool", available: true, label: "Model pool · qwen-pool · on the PC" });
    expect(row.models).toBeUndefined();
  });

  test("what another hub says about its models is checked: odd names dropped, lines cut, levels it names, sizes that are sizes, at most 100", () => {
    const good = { id: "sonnet", label: "Sonnet 4.6", description: "Fast", efforts: ["low", "high"], defaultEffort: "high", isDefault: false, contextWindow: 200_000, paid: "yes", typicalCostUsd: 0.02 };
    const models = readPeerModels([
      good,
      { ...good, id: "sonnet" }, // twice: once
      { ...good, id: "no spaces allowed" },
      { ...good, id: "opus", label: `Opus\n${"x".repeat(200)}`, efforts: ["low", "LOUD", 7, "low"], defaultEffort: "medium", contextWindow: -5, maxContextWindow: 1e12, paid: "maybe", typicalCostUsd: -1, noTools: "yes", more: true, toolCost: { tools: 1 } },
      null,
    ])!;
    expect(models.map((m) => m.id)).toEqual(["sonnet", "opus"]);
    expect(models[0]).toEqual({ ...good, paid: "yes" } as never);
    expect(models[1]).toMatchObject({ efforts: ["low"], defaultEffort: null, contextWindow: null, paid: "unknown", typicalCostUsd: null, more: true });
    expect(models[1].label).toHaveLength(80);
    expect(models[1].label.startsWith("Opus xxx")).toBe(true);
    expect("maxContextWindow" in models[1]).toBe(false);
    expect("noTools" in models[1]).toBe(false);
    expect("toolCost" in models[1]).toBe(false);
    expect(readPeerModels(Array.from({ length: 150 }, (_, i) => ({ ...good, id: `m${i}` })))).toHaveLength(100);
    // No list at all (an older hub): undefined, not an empty list.
    expect(readPeerModels(undefined)).toBeUndefined();
    expect(readPeerModels("all of them")).toBeUndefined();
    // A row keeps its models only when it can be asked; all the rows together hold at most 1,000.
    const row = { target: { provider: "claude", account: "default", model: "opus", effort: null }, label: "Claude Code · Opus 5.5", sub: "Plan", handle: "claude", paid: "no", local: false, available: true, why: null, typicalCostUsd: null };
    const many = Array.from({ length: 100 }, (_, i) => ({ ...good, id: `m${i}` }));
    const rows = readPeerRows([{ ...row, models: [good] }, { ...row, available: false, why: "Not signed in", models: [good] }, ...Array.from({ length: 12 }, () => ({ ...row, models: many }))]);
    expect(rows[0].models).toHaveLength(1);
    expect(rows[1].models).toBeUndefined();
    expect(rows.reduce((n, r) => n + (r.models?.length ?? 0), 0)).toBe(1_000);
    expect(readPeerRows([{ ...row, fixedModel: "pool" }, { ...row, fixedModel: "update" }]).map((r) => r.fixedModel)).toEqual(["pool", undefined]);
  });

  test("a card for another of B's models is named as B names the account, through a failed look too", async () => {
    const { a, b } = await pair();
    b.app.providers.setEndpointAccount("claude", { label: "Qwen3", baseUrl: "http://127.0.0.1:8080", models: ["qwen3-30b", "qwen3-8b"], contextWindow: 65536 });
    const c = a.chat("codex");
    const msg = a.say(c, "human", "Fix it");
    const row = (await a.app.asks.targetsFor(c.room.id, { models: true })).choices.find((r) => r.handle === "qwen3-on-pc")!;
    expect(row.models!.map((m) => m.id)).toEqual(["qwen3-30b", "qwen3-8b"]);
    b.app.asks.peerTargets = () => Promise.reject(new Error("boom"));
    await a.app.asks.targetsFor(c.room.id, { refresh: true });
    const [one] = await a.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [{ ...row.target, model: "qwen3-8b" }] });
    expect(one.label).toBe("Qwen3 · qwen3-8b · on the PC");
  });
});
