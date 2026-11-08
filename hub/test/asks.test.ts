// Ask others, hub side: the one-shot runner (oneshot.ts), the asks (asks.ts) and the briefing an ask's agent gets
// (duplicate.ts). Nothing here starts a real agent CLI or reaches a network: the two agents are a scripted stand-in
// (each test says what it does) or, where a test wants the real drivers, the fake CLIs in fixtures/ with homes of their own.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT, limitResetTime, type AccountSpend, type AgentAccount, type Ask, type AskChoice, type AskTarget, type ChatProvider, type Member, type Message, type ModelOption, type PermissionMode, type Room, type ServerEvent } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { helperNote } from "../src/agents/model-lock";
import { App } from "../src/app";
import { Asks, askHandle } from "../src/asks";
import { ASK_CHARS, ASK_QUESTION, askBriefing, askable, copiedMessages } from "../src/duplicate";
import { HttpError } from "../src/engine/engine";
import { startServer } from "../src/server";
import type { SpendEntry } from "../src/spend";
import { newId } from "../src/util/ids";

setDefaultTimeout(30_000);
const FIX = join(import.meta.dir, "fixtures");

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
}
type Behave = (c: { ctx: DriverContext; input: TurnInput; sink: TurnSink }) => TurnResult | Promise<TurnResult>;
const made: Made[] = [];
const answers: Behave = ({ ctx }) => ({ ok: true, text: `Answer from ${ctx.member.provider}` });
let behave: Behave = answers;
/** Run the real drivers on the fake CLIs instead of the scripted agent. */
let real = false;

class Scripted implements AgentDriver {
  readonly provider;
  private rec: Made;
  constructor(private ctx: DriverContext) {
    this.provider = ctx.member.provider;
    this.rec = { ctx, inputs: [], disposed: false };
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

/** A turn that ends only when it's stopped, like an agent working on something long. */
const untilStopped = (sink: TurnSink) => new Promise<TurnResult>((res) => sink.signal.addEventListener("abort", () => res({ ok: false, error: "stopped" }), { once: true }));
/** A turn that never ends, even when stopped, like a stuck agent. */
const stuck = () => new Promise<TurnResult>(() => {});

function useDrivers() {
  registerDriver("claude", (ctx) => (real ? new ClaudeDriver(ctx, ctx.bin) : new Scripted(ctx)));
  registerDriver("codex", (ctx) => (real ? new CodexDriver(ctx, ctx.bin) : new Scripted(ctx)));
}

const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  behave = answers;
  real = false;
  made.length = 0;
  for (const k of ["FAKE_CODEX_LOG", "FAKE_CLAUDE_ENV_OUT", "FAKE_CLAUDE_ARGS_OUT"]) delete process.env[k];
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

// ------------------------------------------------------------------------------------------------ a hub

const signin = (provider: ChatProvider): AgentAccount => ({ provider, id: DEFAULT_ACCOUNT, label: "Main", kind: "signin", workspaceId: null, endpoint: null, signedIn: true, account: "me@example.com", plan: "Max", authMethod: "oauth", error: null, checkedAt: 0 });
const apiKey = (provider: ChatProvider, id: string, label: string): AgentAccount => ({ ...signin(provider), id, label, kind: "apikey", plan: null, authMethod: "apikey" });
const model = (id: string, label: string, more: Partial<ModelOption> = {}): ModelOption => ({ id, label, description: null, efforts: [], defaultEffort: null, isDefault: false, ...more });

/**
 * A hub with a main sign-in for Claude Code and for Codex (signed in; model lists as given here; spend stubbed: limits
 * and recorded entries are in `limits` and `spent`), whose agents are the scripted stand-in.
 */
function hub() {
  useDrivers();
  process.env.CLAUDE_CONFIG_DIR = temp("ct-asks-claude-");
  process.env.CODEX_HOME = join(temp("ct-asks-codex-"), "codex-home");
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: temp("ct-asks-work-"), maxHopsDefault: 6 } });
  app.providers.which = (p) => (p === "claude" ? join(FIX, "fake-claude") : p === "codex" ? join(FIX, "fake-codex-app") : null);
  const main: Record<ChatProvider, AgentAccount> = { claude: signin("claude"), codex: signin("codex") };
  /** Accounts that exist only here (key accounts, say); saved ones (custom models) come from the hub as usual. */
  const extra: AgentAccount[] = [];
  const saved = app.providers.accounts.bind(app.providers);
  app.providers.accounts = () => (["claude", "codex"] as const).flatMap((p) => [main[p], ...saved().filter((a) => a.provider === p && a.id !== DEFAULT_ACCOUNT), ...extra.filter((a) => a.provider === p)]);
  const lists: Record<ChatProvider, ModelOption[]> = {
    claude: [model("opus", "Opus 5.5", { resolvedModel: "claude-opus-5-5", isDefault: true }), model("sonnet", "Sonnet 4.6", { resolvedModel: "claude-sonnet-4-6" })],
    codex: [model("gpt-test", "GPT Test", { isDefault: true, defaultEffort: "medium", efforts: ["low", "medium", "high"] })],
  };
  /** Model lists that can't be read right now (`provider:account` to why, in the hub's words), like a server that isn't running. */
  const down = new Map<string, string>();
  const realModels = app.providers.models.bind(app.providers);
  // Every list is answered here, so nothing reaches a model server or an agent's CLI: a server of your own offers the models saved for it.
  app.providers.models = async (p, account = DEFAULT_ACCOUNT, opts) => {
    const server = app.providers.endpointOf(p, account);
    if (!server && account !== DEFAULT_ACCOUNT && !extra.some((a) => a.id === account)) return realModels(p, account, opts);
    const models = server ? server.models.map((m, i) => model(m, m, { isDefault: i === 0 })) : lists[p as ChatProvider];
    const why = down.get(`${p}:${account}`) ?? null;
    return { provider: p, accountId: account, models, live: !why, error: why };
  };
  const spent: SpendEntry[] = [];
  const limits = new Map<string, string>();
  /** The dollar limit of an account in `limits`, as the spend module's account list gives it. */
  const caps = new Map<string, number>();
  const nothing = { usd: 0, replies: 0, unpriced: 0, inputTokens: 0, outputTokens: 0 };
  app.spend.record = (e) => void spent.push(e);
  app.spend.checkBudget = (p, a) => limits.get(`${p}:${a}`) ?? null;
  app.spend.accounts = () =>
    [...caps].map(([key, limitUsd]): AccountSpend => {
      const [provider, account] = key.split(":");
      return { provider: provider as ChatProvider, account, label: account, kind: "apikey", today: nothing, month: nothing, total: nothing, budget: { limitUsd, period: "month", since: 0, usedUsd: limitUsd, percent: 100, state: "stopped" } };
    });
  const events: ServerEvent[] = [];
  app.bus.on((e) => events.push(e));
  let server: ReturnType<typeof startServer> | null = null;

  const chat = (provider: ChatProvider = "codex", name = "Fix login", o: { model?: string | null; privateFromAgents?: boolean; permissionMode?: PermissionMode } = {}) => {
    const room = app.chats.create({ provider, name, cwd: temp("ct-asks-cwd-"), model: o.model ?? null, effort: null, ...(o.privateFromAgents ? { privateFromAgents: true } : {}), ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}) });
    return { room, member: app.chats.member(room.id)! };
  };
  let at = Date.parse("2026-10-27T09:00:00Z");
  const say = (c: { room: Room; member: Member }, from: Message["authorKind"], text: string, more: Partial<Message> = {}): Message => {
    const msg: Message = { id: newId("m"), roomId: c.room.id, authorKind: from, memberId: from === "agent" ? c.member.id : null, authorName: from === "agent" ? c.member.handle : "iPhone", text, mentions: [], turnId: null, status: "done", createdAt: (at += 60_000), updatedAt: at, via: null, ...more };
    app.store.insertMessage(msg);
    return msg;
  };
  const target = (provider: ChatProvider, account = DEFAULT_ACCOUNT, m: string | null = null, effort: string | null = null): AskTarget => ({ provider, account, model: m, effort });
  const ask = (c: { room: Room }, message: Message, targets: AskTarget[], note?: string) => app.asks.start({ roomId: c.room.id, messageId: message.id, targets, note });
  const settled = (id: string) => until(() => !["queued", "running"].includes(app.asks.get(id)!.status), `ask ${id} to end`);
  const seen = (id: string) => events.flatMap((e) => (e.t === "ask" && e.ask.id === id ? [e.ask.status] : []));
  /** What a refused request says (a plain object, so it can be compared). */
  const refused = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("expected the request to be refused");
      },
      (e: HttpError) => ({ status: e.status, code: e.code, message: e.message }),
    );
  /** The hub's HTTP API, for a paired phone. */
  const base = () => `http://127.0.0.1:${(server ??= startServer(app)).port}`;
  const api = async <T = any>(method: string, path: string, body?: unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const token = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!.token;
    const res = await fetch(`${base()}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => null)) as T };
  };
  cleanups.push(async () => {
    app.asks.limits.graceMs = 20;
    await app.asks.shutdown();
    server?.stop(true);
    await app.engine.shutdown();
    app.store.close();
  });
  return { app, main, extra, lists, spent, limits, caps, down, events, chat, say, target, ask, settled, seen, refused, base, api };
}

// ================================================================================================ the briefing

describe("the briefing an ask's agent gets", () => {
  const m = (authorKind: Message["authorKind"], text: string, more: Partial<Message> = {}): Message => ({ id: newId("m"), roomId: "r", authorKind, memberId: authorKind === "agent" ? "mb" : null, authorName: authorKind === "human" ? "iPhone" : "claude", text, mentions: [], turnId: null, status: "done", createdAt: 1, updatedAt: 1, ...more });
  const who = () => ({ agent: "Claude Code", provider: "claude" as const });
  const HEAD = "A user is working with a coding agent in a chat. They want your view on the message marked ▶. You can read files but must not change anything. Answer in under 200 words, plain Markdown, no preamble.";

  test("it ends at the asked message, even one the agent hasn't answered, and leaves out everything after it", () => {
    const list = [m("human", "Fix the login bug"), m("agent", "Fixed it."), m("human", "Now add tests"), m("agent", "Added three tests."), m("human", "Ship it")];
    // The default still stops at the last finished reply (a copy's rule); an ask names its own end.
    expect(copiedMessages(list, who).map((c) => c.text)).toEqual(["Fix the login bug", "Fixed it.", "Now add tests", "Added three tests."]);
    const upToAsked = copiedMessages(list, who, 2);
    expect(upToAsked.map((c) => c.text)).toEqual(["Fix the login bug", "Fixed it.", "Now add tests"]);
    const unanswered = copiedMessages(list, who, 4);
    expect(unanswered.at(-1)!.text).toBe("Ship it");
    const note = askBriefing(upToAsked, "/work/login");
    expect(note.startsWith(`(${HEAD} The chat works in /work/login.)\n\n`)).toBe(true);
    expect(note).toContain("[The user]\nFix the login bug\n\n[Claude Code]\nFixed it.\n\n▶ [The user]\nNow add tests");
    expect(note.endsWith("▶ [The user]\nNow add tests")).toBe(true);
    expect(note).not.toContain("Added three tests");
    expect(note.match(/▶/g)).toHaveLength(2); // the head names it once, the message carries it once
  });

  test("the asked message is kept in full; earlier long ones keep their start and end", () => {
    const long = (c: string, n: number) => `${c.repeat(n)}`;
    const note = askBriefing(copiedMessages([m("human", long("a", 10_000)), m("agent", "ok"), m("human", long("z", 10_000))], who, 2), "/w");
    expect(note).toContain(long("z", 10_000)); // asked: whole
    expect(note).not.toContain(long("a", 10_000)); // earlier: cut to about a quarter of the size cap
    expect(note).toContain("characters left out");
    // Past the size cap even the asked message keeps its start and end.
    const huge = askBriefing(copiedMessages([m("human", "hello"), m("human", long("y", 50_000))], who, 1), "/w");
    expect(huge.length).toBeLessThan(ASK_CHARS + 600);
    expect(huge).toContain("characters left out");
    expect(huge).toContain("1 earlier message was left out to fit.");
  });

  test("it keeps the newest messages within 24,000 characters and says how many it left out", () => {
    const list = Array.from({ length: 101 }, (_, i) => m(i % 2 ? "agent" : "human", `message ${String(i).padStart(3, "0")} ${"x".repeat(990)}`));
    const note = askBriefing(copiedMessages(list, who, 100), "/w");
    const kept = [...note.matchAll(/message (\d{3}) /g)].map((x) => Number(x[1]));
    expect(kept.at(-1)).toBe(100); // the asked one
    expect(kept.at(-2)).toBe(99); // then the newest before it
    expect(kept[0]).toBeGreaterThan(70); // about 23 fit
    expect(kept).not.toContain(0);
    const body = note.slice(note.indexOf("\n\n") + 2);
    expect(body.length).toBeLessThanOrEqual(ASK_CHARS);
    expect(note).toContain(`${101 - kept.length} earlier messages were left out to fit.`);
    expect(askBriefing(copiedMessages(list, who, 100), "/w", 5_000).length).toBeLessThan(5_000 + 600); // the cap is a parameter
  });

  test("only the user's messages and finished replies can be asked about", () => {
    expect(askable(m("human", "Fix it"))).toBe(true);
    expect(askable(m("agent", "Fixed."))).toBe(true);
    expect(askable(m("agent", "Stopped halfway", { status: "stopped" }))).toBe(true);
    expect(askable(m("human", "   "))).toBe(false);
    expect(askable(m("agent", "⚠️ exited", { status: "error" }))).toBe(false);
    expect(askable(m("agent", "Writing…", { status: "streaming" }))).toBe(false);
    expect(askable(m("system", "Crosstalk restarted."))).toBe(false);
  });
});

describe("handles", () => {
  test("a main sign-in has its agent's own handle; other accounts a short slug of their name, never twice", () => {
    expect(askHandle("claude", DEFAULT_ACCOUNT, "Main")).toBe("claude");
    expect(askHandle("codex", DEFAULT_ACCOUNT, "Main")).toBe("codex");
    expect(askHandle("claude", "e1", "Kimi")).toBe("kimi");
    expect(askHandle("claude", "e2", "Local Qwen 3.8 (27B)")).toBe("local-qwen-3-8-27b");
    expect(askHandle("claude", "k1", "Claude", new Set(["claude"]))).toBe("claude-2");
    expect(askHandle("claude", "k2", "Claude", new Set(["claude", "claude-2"]))).toBe("claude-3");
    expect(askHandle("codex", "x", "日本語", new Set(["codex"]))).toBe("codex-2"); // nothing to slug: the agent's own
    expect(askHandle("claude", "e3", "A very long name for a model server that someone made")).toBe("a-very-long-name-for-a-m");
    expect(askHandle("claude", "e4", "  --  ")).toBe("claude");
  });
});

// ================================================================================================ one ask

describe("asking", () => {
  test("an ask is answered into a card with its model and cost, and leaves no trace in the chat", async () => {
    const h = hub();
    const c = h.chat("codex");
    const first = h.say(c, "human", "Fix the login bug");
    const reply = h.say(c, "agent", "Fixed: the token was never refreshed.");
    h.say(c, "human", "Thanks. Now the signup page.");
    const before = { messages: h.app.store.listMessages(c.room.id).length, session: JSON.stringify(h.app.store.getMemberSession(c.member.id)) };
    behave = ({ sink }) => {
      sink.usage({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 100, costUsd: 0.0421 });
      return { ok: true, text: "  Looks right, but check the refresh race.  " };
    };

    const [one] = await h.ask(c, reply, [h.target("claude")], "Is this right?");
    expect(one).toMatchObject({ roomId: c.room.id, messageId: reply.id, note: "Is this right?", local: false, label: "Claude Code · Opus 5.5", target: { provider: "claude", account: "default", model: "opus", effort: null } });
    await h.settled(one.id);
    expect(h.app.asks.get(one.id)).toMatchObject({
      status: "done",
      answer: "Looks right, but check the refresh race.",
      error: null,
      // A plan sign-in isn't billed: Claude Code's own figure is what the reply would cost.
      cost: { costUsd: 0.0421, basis: "plan", inputTokens: 1200, outputTokens: 300 },
    });
    expect(h.app.asks.get(one.id)!.startedAt).toBeGreaterThan(0);
    expect(h.app.asks.get(one.id)!.endedAt).toBeGreaterThanOrEqual(h.app.asks.get(one.id)!.startedAt!);
    expect(h.seen(one.id)).toEqual(["queued", "running", "done"]);
    expect(h.app.asks.list(c.room.id).map((a) => a.id)).toEqual([one.id]);

    // The agent: a fresh one-off process, read-only, in the chat's folder, told about the chat up to the message asked about.
    expect(made).toHaveLength(1);
    const { ctx, inputs, disposed } = made[0];
    expect(ctx.chat).toEqual({ helper: null, ephemeral: true });
    expect(ctx.crossChat ?? false).toBe(false);
    expect(ctx.session).toEqual({});
    expect(ctx.room.cwd).toBe(c.room.cwd);
    expect(ctx.member).toMatchObject({ provider: "claude", model: "opus", permissionMode: "ask", roomId: c.room.id });
    expect(ctx.member.id.startsWith("ask_")).toBe(true);
    expect(h.app.store.getMember(ctx.member.id)).toBeNull(); // never saved: the hub's tools refuse it
    expect(disposed).toBe(true);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].prompt).toBe("Is this right?");
    expect(inputs[0].systemNote).toContain("They want your view on the message marked ▶");
    expect(inputs[0].systemNote).toContain("▶ [Codex]\nFixed: the token was never refreshed.");
    expect(inputs[0].systemNote).toContain("[The user]\nFix the login bug");
    expect(inputs[0].systemNote).not.toContain("signup page"); // after the asked message
    expect(first.text).toBe("Fix the login bug");

    // The money is kept in the ledger.
    expect(h.spent).toEqual([{ source: "ask", provider: "claude", account: "default", roomId: c.room.id, chatName: "Fix login", askId: one.id, model: "opus", inputTokens: 1200, outputTokens: 300, cachedTokens: 100, costUsd: 0.0421, basis: "plan" }]);

    // The chat itself is as it was: no message, no turn, no change to its agent's session.
    expect(h.app.store.listMessages(c.room.id)).toHaveLength(before.messages);
    expect(h.app.store.listTurns(c.room.id)).toHaveLength(0);
    expect(JSON.stringify(h.app.store.getMemberSession(c.member.id))).toBe(before.session);
    expect(h.app.engine.runningTurns(c.room.id)).toHaveLength(0);
  });

  test("an ask can't change anything: it runs in Ask-first mode whatever the chat's own setting is, and every approval it asks for is refused", async () => {
    const h = hub();
    const c = h.chat("claude", "Full access", { permissionMode: "full" });
    expect(c.member.permissionMode).toBe("full"); // this chat's agent may do anything; an ask's agent may not
    const decided: string[] = [];
    behave = async ({ sink }) => {
      decided.push(await sink.approval({ kind: "command", title: "Run `rm -rf build`", detail: "rm -rf build" }));
      decided.push(await sink.approval({ kind: "file_change", title: "Edit src/login.ts", detail: "+ const token = null;", always: "Edits to src/login.ts" }));
      decided.push(await sink.approval({ kind: "permission", title: "Use the network", detail: "curl https://example.com" }));
      return { ok: true, text: "Looks fine." };
    };
    const [one] = await h.ask(c, h.say(c, "human", "Fix it"), [h.target("codex")]);
    await h.settled(one.id);
    expect(h.app.asks.get(one.id)).toMatchObject({ status: "done", answer: "Looks fine." });
    expect(decided).toEqual(["deny", "deny", "deny"]);
    expect(made[0].ctx.member.permissionMode).toBe("ask");
  });

  test("without a question of its own the prompt is the default one; an unanswered message can be asked about", async () => {
    const h = hub();
    const c = h.chat("claude");
    h.say(c, "human", "Fix it");
    h.say(c, "agent", "Done.");
    const open = h.say(c, "human", "Also, rename the file");
    const [one] = await h.ask(c, open, [h.target("codex")]);
    await h.settled(one.id);
    expect(made[0].inputs[0].prompt).toBe(ASK_QUESTION);
    expect(made[0].inputs[0].prompt).toBe("What do you think? Anything wrong or missing?");
    expect(made[0].inputs[0].systemNote!.endsWith("▶ [The user]\nAlso, rename the file")).toBe(true);
    expect(h.app.asks.get(one.id)).toMatchObject({ note: null, target: { provider: "codex", model: "gpt-test", effort: "medium" } });
  });

  test("how an ask went wrong is said in plain words, once, and the cost of what was used is still kept", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const outcome = async (b: Behave) => {
      behave = b;
      const [one] = await h.ask(c, msg, [h.target("codex")]);
      await h.settled(one.id);
      return h.app.asks.get(one.id)!;
    };
    expect(await outcome(() => ({ ok: false, error: "Rate limited. " }))).toMatchObject({ status: "error", error: "Codex couldn't answer: Rate limited.", answer: null });
    expect(await outcome(() => { throw new Error("spawn failed"); })).toMatchObject({ status: "error", error: "Codex couldn't answer: spawn failed." });
    expect(await outcome(() => ({ ok: true, text: "  " }))).toMatchObject({ status: "error", error: "Codex finished without writing an answer." });
    const partial = await outcome(({ sink }) => {
      sink.usage({ inputTokens: 500, outputTokens: 20, cachedInputTokens: 0, costUsd: null });
      return { ok: false, error: "The model is overloaded" };
    });
    expect(partial).toMatchObject({ status: "error", error: "Codex couldn't answer: The model is overloaded." });
    expect(partial.cost).toMatchObject({ inputTokens: 500, outputTokens: 20 });
    expect(h.spent).toHaveLength(1); // the three that used nothing aren't in the ledger
  });

  test("Stop ends a waiting or running ask, frees its place, and a stopped one stays stopped", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    behave = ({ sink }) => untilStopped(sink);
    const asks = await h.ask(c, msg, [h.target("codex"), h.target("codex"), h.target("codex"), h.target("codex")]);
    expect(asks.map((a) => a.status)).toEqual(["running", "running", "running", "queued"]);

    const stopped = h.app.asks.stop(asks[0].id);
    expect(stopped.status).toBe("stopped"); // at once, before the agent has let go
    expect(stopped.endedAt).toBeGreaterThan(0);
    await until(() => h.app.asks.get(asks[3].id)!.status === "running", "the waiting one to take its place");
    expect(made).toHaveLength(4);
    await until(() => made[0].disposed, "the stopped one's agent to let go");
    expect(h.app.asks.get(asks[0].id)).toMatchObject({ status: "stopped", answer: null, error: null }); // the agent's own ending doesn't change it

    // A waiting one that is stopped never starts.
    const [waiting] = await h.ask(c, msg, [h.target("codex")]);
    expect(waiting.status).toBe("queued");
    expect(h.app.asks.stop(waiting.id).status).toBe("stopped");
    h.app.asks.stop(asks[1].id);
    h.app.asks.stop(asks[2].id);
    await until(() => made[1].disposed && made[2].disposed, "the others to let go");
    expect(made).toHaveLength(4);
    expect(h.app.asks.get(waiting.id)).toMatchObject({ status: "stopped", startedAt: null });
    expect(h.app.asks.stop(asks[0].id).status).toBe("stopped");
    expect(() => h.app.asks.stop("ask_nope")).toThrow("gone");
    // One that's over is left as it is.
    behave = answers;
    const [over] = await h.ask(c, msg, [h.target("claude")]);
    await h.settled(over.id);
    expect(h.app.asks.stop(over.id).status).toBe("done");
  });

  test("a question takes at most 3 minutes; an agent that ignores the stop is let go of", async () => {
    const h = hub();
    expect(h.app.asks.limits).toEqual({ running: 3, pending: 6, timeoutMs: 180_000, graceMs: 10_000 });
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    h.app.asks.limits.timeoutMs = 60;
    behave = ({ sink }) => untilStopped(sink);
    const [slow] = await h.ask(c, msg, [h.target("codex")]);
    await h.settled(slow.id);
    expect(h.app.asks.get(slow.id)).toMatchObject({ status: "error", error: "Codex took longer than 1 minute, so Crosstalk stopped it." });

    h.app.asks.limits.graceMs = 40;
    behave = stuck;
    const [hung] = await h.ask(c, msg, [h.target("codex")]);
    await h.settled(hung.id);
    expect(h.app.asks.get(hung.id)).toMatchObject({ status: "error", error: expect.stringContaining("took longer") });
    expect(made.map((x) => x.disposed)).toEqual([true, true]); // its process was ended
  });

  test("what the agent had written when it was stopped, or hit the time cap, stays on the card as its answer", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    behave = ({ sink }) => {
      sink.text("  The refresh race is real: ");
      sink.text("two tabs can both refresh.  ");
      return untilStopped(sink);
    };
    const [one] = await h.ask(c, msg, [h.target("codex")]);
    h.app.asks.stop(one.id);
    await until(() => h.app.asks.get(one.id)!.answer !== null, "what was written to be kept");
    expect(h.app.asks.get(one.id)).toMatchObject({ status: "stopped", answer: "The refresh race is real: two tabs can both refresh.", error: null });

    // Past the time cap: the card says so, with what there was by then (cut where every answer is).
    h.app.asks.limits.timeoutMs = 60;
    behave = ({ sink }) => {
      sink.text("x".repeat(40_000));
      return untilStopped(sink);
    };
    const [slow] = await h.ask(c, msg, [h.target("codex")]);
    await h.settled(slow.id);
    const late = h.app.asks.get(slow.id)!;
    expect(late).toMatchObject({ status: "error", error: "Codex took longer than 1 minute, so Crosstalk stopped it." });
    expect(late.answer).toBe(`${"x".repeat(30_000)}\n…(cut short)`);
  });
});

// ================================================================================================ limits and the queue

describe("limits", () => {
  test("3 run at once on the hub, the rest wait their turn in order, and a chat has at most 6 pending", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const release: ((text: string) => void)[] = [];
    behave = () => new Promise<TurnResult>((res) => release.push((text) => res({ ok: true, text })));
    const asks = await h.ask(c, msg, Array.from({ length: 5 }, () => h.target("codex")));
    expect(asks.map((a) => a.status)).toEqual(["running", "running", "running", "queued", "queued"]);
    expect(made).toHaveLength(3);

    // 5 pending: one more fits, two don't (and nothing was started or kept for the refused ones).
    expect(await h.refused(h.ask(c, msg, [h.target("codex"), h.target("codex")]))).toEqual({ status: 409, code: "busy", message: "This chat already has 5 questions waiting. Let some finish or remove them, then ask again." });
    expect(h.app.asks.list(c.room.id)).toHaveLength(5);
    const sixth = await h.ask(c, msg, [h.target("codex")]);
    expect(sixth[0].status).toBe("queued");
    expect(await h.refused(h.ask(c, msg, [h.target("codex")]))).toMatchObject({ status: 409, code: "busy" });

    // Another chat is limited by the hub's 3, not by this chat's 6: its ask waits behind.
    const other = h.chat("claude", "Other chat");
    const otherMsg = h.say(other, "human", "Hello");
    const [elsewhere] = await h.ask(other, otherMsg, [h.target("codex")]);
    expect(elsewhere.status).toBe("queued");

    // One ends: the oldest waiting one starts (not the newest).
    release[0]("first");
    await until(() => h.app.asks.get(asks[3].id)!.status === "running", "the 4th to start");
    expect(h.app.asks.get(asks[0].id)).toMatchObject({ status: "done", answer: "first" });
    expect(h.app.asks.get(asks[4].id)!.status).toBe("queued");
    expect(made).toHaveLength(4);
    release[1]("second");
    release[2]("third");
    await until(() => made.length === 6, "two more to start");
    expect(h.app.asks.get(asks[4].id)!.status).toBe("running");
    expect(h.app.asks.get(sixth[0].id)!.status).toBe("running");
    expect(h.app.asks.get(elsewhere.id)!.status).toBe("queued"); // the oldest first, across chats
    // A finished ask isn't pending any more.
    release.splice(0).forEach((r) => r("ok"));
    await until(() => h.app.asks.get(elsewhere.id)!.status === "running", "the other chat's ask to start");
    const again = await h.ask(c, msg, [h.target("codex")]);
    expect(again).toHaveLength(1);
  });

  test("a chat's asks are deleted with it, and one still running is stopped", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    behave = ({ sink }) => untilStopped(sink);
    const [running] = await h.ask(c, msg, [h.target("codex")]);
    const other = h.chat("claude", "Keep this");
    const [kept] = await h.ask(other, h.say(other, "human", "Hello"), [h.target("codex")]);
    expect(made).toHaveLength(2);
    await h.app.deleteRoom(c.room.id);
    expect(h.app.asks.get(running.id)).toBeNull();
    expect(h.app.asks.list(c.room.id)).toEqual([]);
    expect(h.app.asks.get(kept.id)).not.toBeNull();
    await until(() => made[0].disposed, "the deleted chat's agent to be let go");
    expect(made[1].disposed).toBe(false);
  });

  test("a message taken back (unsent, or rewound past) takes its questions along: a running one is stopped, a waiting one never starts, the rest are left alone", async () => {
    const h = hub();
    const c = h.chat("claude");
    const first = h.say(c, "human", "Fix it");
    const reply = h.say(c, "agent", "Done.");
    const later = h.say(c, "human", "Now the tests");
    const [finished] = await h.ask(c, later, [h.target("codex")]);
    await h.settled(finished.id);
    behave = ({ sink }) => untilStopped(sink);
    const [kept] = await h.ask(c, first, [h.target("codex")]);
    const [one, two] = await h.ask(c, reply, [h.target("codex"), h.target("codex")]);
    const [waiting] = await h.ask(c, later, [h.target("codex")]);
    expect([kept, one, two, waiting].map((a) => a.status)).toEqual(["running", "running", "running", "queued"]);
    const other = h.chat("claude", "Other chat");
    const [elsewhere] = await h.ask(other, h.say(other, "human", "Hello"), [h.target("codex")]);

    // The engine's own rewind (to the reply, taking it and the message after it back) tells the apps what went, and nothing more.
    h.app.bus.emit({ t: "messages.removed", roomId: other.room.id, ids: [reply.id] }); // not this chat's messages: nothing happens
    expect(h.app.asks.list(c.room.id)).toHaveLength(5);
    const removed = h.app.store.deleteMessagesFrom(c.room.id, h.app.store.messageSeq(reply.id));
    expect(removed.sort()).toEqual([reply.id, later.id].sort());
    h.app.bus.emit({ t: "messages.removed", roomId: c.room.id, ids: removed });
    expect(h.app.asks.list(c.room.id).map((a) => a.id)).toEqual([kept.id]); // the question about the earlier message stays
    for (const a of [finished, one, two, waiting]) expect(h.app.asks.get(a.id)).toBeNull();
    expect(h.app.asks.get(elsewhere.id)).not.toBeNull();
    expect(h.events.filter((e) => e.t === "ask.removed" && e.roomId === c.room.id).map((e) => (e as { id: string }).id).sort()).toEqual([finished.id, one.id, two.id, waiting.id].sort());
    await until(() => made[2].disposed && made[3].disposed, "the running ones' agents to be let go"); // made[0] was the finished one
    expect(made[1].disposed).toBe(false);
    // The waiting question about the taken-back message never started: the other chat's, queued behind it, took a freed place.
    expect(made).toHaveLength(5);
    expect(made[4].ctx.room.id).toBe(other.room.id);

    // A hub shutting down has stopped listening.
    await h.app.asks.shutdown();
    h.app.bus.emit({ t: "messages.removed", roomId: c.room.id, ids: [first.id] });
    expect(h.app.asks.get(kept.id)).not.toBeNull();
  });

  test("shutdown stops every ask and ends each agent's process, even a stuck one; nothing waiting starts", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    h.app.asks.limits.graceMs = 30;
    behave = ({ sink }) => (made.length === 2 ? stuck() : untilStopped(sink));
    const asks = await h.ask(c, msg, Array.from({ length: 4 }, () => h.target("codex")));
    expect(made).toHaveLength(3);
    await h.app.asks.shutdown();
    expect(made.map((x) => x.disposed)).toEqual([true, true, true]);
    expect(made).toHaveLength(3); // the waiting one never started
    for (const a of asks) expect(h.app.asks.get(a.id)).toMatchObject({ status: "error", error: "Crosstalk restarted before this answered." });
    // ...and the table says nothing is queued or running, which is what the idle watcher reads.
    expect(h.app.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE status IN ('queued', 'running')").get()).toEqual({ n: 0 });
  });

  test("asks a stopped hub left running are ended the next time it starts, with a way to try again", () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    for (const [id, status] of [["a1", "running"], ["a2", "queued"], ["a3", "done"]]) {
      h.app.store.db.query("INSERT INTO asks (id, room_id, message_id, provider, account, label, status, created_at) VALUES (?, ?, ?, 'codex', 'default', 'Codex', ?, 1)").run(id, c.room.id, msg.id, status);
    }
    new Asks(h.app); // a hub starting up again on the same database
    expect(h.app.asks.get("a1")).toMatchObject({ status: "error", error: "Crosstalk restarted before this answered." });
    expect(h.app.asks.get("a2")!.status).toBe("error");
    expect(h.app.asks.get("a3")!.status).toBe("done");
  });
});

// ================================================================================================ who can be asked

describe("targets", () => {
  test("every account of Claude Code and Codex, with a handle, what it costs, and the model that would answer", async () => {
    const h = hub();
    h.extra.push(apiKey("claude", "k1", "Claude"));
    const local = h.app.providers.setEndpointAccount("claude", { label: "Local Qwen", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b", "other"], contextWindow: 65536 });
    const kimi = h.app.providers.setEndpointAccount("codex", { label: "Kimi", baseUrl: "https://api.example.com", models: ["kimi-k2"], apiKey: "sk-test" });
    const c = h.chat("codex"); // the chat's own agent (Codex's main sign-in, its default model) isn't offered
    const rows = await h.app.asks.targets(c.room.id);
    expect(rows.map((r) => r.handle)).toEqual(["claude", "local-qwen", "claude-2", "kimi"]);
    const by = Object.fromEntries(rows.map((r) => [r.handle, r]));

    expect(by.claude).toMatchObject({ label: "Claude Code · Opus 5.5", sub: "Plan", paid: "no", local: false, available: true, why: null, typicalCostUsd: null, target: { provider: "claude", account: "default", model: "opus", effort: null } });
    expect(by["claude-2"]).toMatchObject({ label: "Claude Code (Claude) · Opus 5.5", sub: "API key", paid: "yes", local: false, available: true, target: { account: "k1", model: "opus" } });
    expect(by["local-qwen"]).toMatchObject({ label: "Local Qwen · qwen3.8-27b", paid: "no", local: true, available: true, target: { provider: "claude", account: local.id, model: "qwen3.8-27b" } });
    expect(["On this Mac", "On this machine"]).toContain(by["local-qwen"].sub);
    expect(by.kimi).toMatchObject({ label: "Kimi · kimi-k2", sub: "Online", paid: "unknown", local: false, available: true, target: { provider: "codex", account: kimi.id, model: "kimi-k2" } });
    // An online service is known to cost money once the spend module has a price for it.
    h.app.spend.priceReply = () => ({ costUsd: 0.5, basis: "estimated" });
    expect((await h.app.asks.targets(c.room.id)).find((r) => r.handle === "kimi")!.paid).toBe("yes");
    expect((await h.app.asks.targets(c.room.id)).find((r) => r.handle === "local-qwen")!.paid).toBe("no"); // on this machine: free whatever any list says
    // The chat's own agent comes back when another model of it would answer.
    const sonnet = h.chat("claude", "On Sonnet", { model: "sonnet" });
    expect((await h.app.asks.targets(sonnet.room.id)).map((r) => r.handle)).toContain("claude");
    const onDefault = h.chat("claude", "On the default", { model: "opus" });
    expect((await h.app.asks.targets(onDefault.room.id)).map((r) => r.handle)).not.toContain("claude");
    const byFullName = h.chat("claude", "On its full name", { model: "claude-opus-5-5" });
    expect((await h.app.asks.targets(byFullName.room.id)).map((r) => r.handle)).not.toContain("claude");
    expect((await h.app.asks.targets(c.room.id)).map((r) => r.handle)).not.toContain("codex");
  });

  test("an account that can't be asked says why, in the sheet's words", async () => {
    const h = hub();
    h.extra.push(apiKey("claude", "k1", "Work key"), apiKey("claude", "k2", "Old key"), apiKey("claude", "k3", "Small key"));
    h.main.codex.signedIn = false;
    h.limits.set("claude:k1", "API key has reached its $250 limit, so this reply won't start.");
    h.caps.set("claude:k1", 250);
    h.limits.set("claude:k3", "API key has reached its $12.50 limit, so this reply won't start.");
    h.caps.set("claude:k3", 12.5);
    h.app.store.setUsage({ provider: "claude", accountId: "k2", account: null, plan: null, windows: [{ label: "5-hour", usedPercent: 100, resetsAt: Date.now() + 3_600_000 }], credits: null, note: null, updatedAt: Date.now() });
    const c = h.chat("claude", "Chat", { model: "sonnet" });
    const rows = Object.fromEntries((await h.app.asks.targets(c.room.id)).map((r) => [r.handle, r]));
    expect(rows.codex).toMatchObject({ available: false, why: "Not signed in", target: { provider: "codex", model: null } });
    // Short in the sheet (the whole sentence is what a refusal says, see "the rules for asking").
    expect(rows["work-key"]).toMatchObject({ available: false, why: "Over its $250 limit", label: "Claude Code (Work key) · Opus 5.5" });
    expect(rows["small-key"]).toMatchObject({ available: false, why: "Over its $12.50 limit" });
    expect(rows["old-key"]).toMatchObject({ available: false, why: "Plan at 100% of its 5-hour limit" });
    expect(rows.claude.available).toBe(true);
    // A window that has reset no longer counts.
    h.app.store.setUsage({ provider: "claude", accountId: "k2", account: null, plan: null, windows: [{ label: "5-hour", usedPercent: 100, resetsAt: Date.now() - 1000 }], credits: null, note: null, updatedAt: Date.now() });
    expect((await h.app.asks.targets(c.room.id)).find((r) => r.handle === "old-key")!.available).toBe(true);
    // A limit the spend module has no figure for is still said short.
    h.caps.delete("claude:k1");
    expect((await h.app.asks.targets(c.room.id)).find((r) => r.handle === "work-key")).toMatchObject({ available: false, why: "Over its limit" });
    // Nothing installed: the agent can't be asked at all.
    h.app.providers.which = () => null;
    expect((await h.app.asks.targets(c.room.id)).every((r) => !r.available && r.why === "Not installed")).toBe(true);
  });

  test("a model list with no default can't be asked on its own, and says so", async () => {
    const h = hub();
    h.lists.codex = [model("gpt-test", "GPT Test")];
    const c = h.chat("claude");
    expect((await h.app.asks.targets(c.room.id)).find((r) => r.handle === "codex")).toMatchObject({ available: false, why: "Couldn't read its models", target: { model: null } });
  });

  test("a model server that isn't answering keeps the model saved for it, and its row says why it can't be asked; a sign-in's unread list gives no default", async () => {
    const h = hub();
    const local = h.app.providers.setEndpointAccount("claude", { label: "Local Qwen", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b", "other"], contextWindow: 65536 });
    const c = h.chat("codex");
    const msg = h.say(c, "human", "Fix it");
    const row = async (handle: string) => (await h.app.asks.targets(c.room.id)).find((r) => r.handle === handle)!;
    const nothing = "Nothing answered at http://127.0.0.1:8080. Is the server running?";
    h.down.set(`claude:${local.id}`, nothing);
    h.down.set("claude:default", "claude: couldn't list models (exit 1)"); // a sign-in's list is suggestions only until the agent answers
    expect(await row("local-qwen")).toMatchObject({ available: false, why: nothing, label: "Local Qwen · qwen3.8-27b", local: true, target: { provider: "claude", account: local.id, model: "qwen3.8-27b" } });
    expect(await row("claude")).toMatchObject({ available: false, why: "Couldn't read its models", target: { model: null } });

    // Asked directly, the server isn't refused for want of a default model (it has its first saved one); the sign-in still is.
    expect(await h.refused(h.ask(c, msg, [h.target("claude")]))).toMatchObject({ status: 409, code: "model_choice" });
    const [one] = await h.ask(c, msg, [h.target("claude", local.id)]);
    expect(one.target).toEqual({ provider: "claude", account: local.id, model: "qwen3.8-27b", effort: null });
    await h.settled(one.id);
    expect(h.app.asks.get(one.id)).toMatchObject({ status: "done", local: true });

    // The server answering again: the row is back.
    h.down.clear();
    expect(await row("local-qwen")).toMatchObject({ available: true, why: null });
    expect(await row("claude")).toMatchObject({ available: true, why: null, target: { model: "opus" } });
  });

  test("what the target's finished asks cost, on average", async () => {
    const h = hub();
    h.extra.push(apiKey("codex", "k1", "Key"));
    h.app.spend.priceReply = ({ inputTokens }) => ({ costUsd: inputTokens / 1000, basis: "estimated" });
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    for (const tokens of [40, 60]) {
      behave = ({ sink }) => (sink.usage({ inputTokens: tokens, outputTokens: 1, cachedInputTokens: 0, costUsd: null }), { ok: true, text: "ok" });
      const [one] = await h.ask(c, msg, [h.target("codex", "k1")]);
      await h.settled(one.id);
    }
    const row = (await h.app.asks.targets(c.room.id)).find((r) => r.handle === "key")!;
    expect(row.typicalCostUsd).toBeCloseTo(0.05, 5);
    expect((await h.app.asks.targets(c.room.id)).find((r) => r.handle === "codex")!.typicalCostUsd).toBeNull();
  });
});

// ================================================================================================ the rules for asking

describe("the rules for asking", () => {
  test("a target with no model gets the account's default, recorded in the ask; a named model is kept as named", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const [byDefault, named, effort] = await h.ask(c, msg, [h.target("codex"), h.target("claude", DEFAULT_ACCOUNT, "sonnet"), h.target("codex", DEFAULT_ACCOUNT, null, "high")]);
    expect(byDefault.target).toEqual({ provider: "codex", account: "default", model: "gpt-test", effort: "medium" });
    expect(named.target).toEqual({ provider: "claude", account: "default", model: "sonnet", effort: null });
    expect(named.label).toBe("Claude Code · Sonnet 4.6");
    expect(effort.target.effort).toBe("high");
    for (const a of [byDefault, named, effort]) await h.settled(a.id);
    // The agent is started on exactly that model and effort.
    expect(made.map((x) => [x.ctx.member.provider, x.ctx.member.model, x.ctx.member.config.effort])).toEqual([["codex", "gpt-test", "medium"], ["claude", "sonnet", undefined], ["codex", "gpt-test", "high"]]);
  });

  test("with no model named and none to default to, nothing starts: 409 model_choice, with what to do", async () => {
    const h = hub();
    h.lists.codex = [model("gpt-test", "GPT Test")];
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const err = await h.refused(h.ask(c, msg, [h.target("claude"), h.target("codex")]));
    expect(err).toMatchObject({ status: 409, code: "model_choice" });
    expect(err.message).toContain("Codex has no default model to ask");
    expect(err.message).toContain("Settings → AI services");
    expect(made).toHaveLength(0);
    expect(h.app.asks.list(c.room.id)).toEqual([]);
    // Naming the model is enough.
    const [ok] = await h.ask(c, msg, [h.target("codex", DEFAULT_ACCOUNT, "gpt-test")]);
    expect(ok.target.model).toBe("gpt-test");
  });

  test("refusals have a code and a plain sentence: not signed in, over its limit, still being written, and mistakes", async () => {
    const h = hub();
    h.extra.push(apiKey("claude", "k1", "Work key"));
    const c = h.chat("codex");
    const msg = h.say(c, "human", "Fix it");
    const refusal = (targets: AskTarget[], m: Message = msg) => h.refused(h.ask(c, m, targets));

    h.main.claude.signedIn = false;
    expect(await refusal([h.target("claude")])).toMatchObject({ status: 409, code: "not_signed_in", message: "Claude Code isn't signed in. Sign in under Settings → AI services, then ask again." });
    h.main.claude.signedIn = true;

    h.limits.set("claude:k1", "API key reached its $250 limit, so this reply didn't start.");
    expect(await refusal([h.target("claude"), h.target("claude", "k1")])).toMatchObject({ status: 409, code: "budget", message: "API key reached its $250 limit, so this reply didn't start." });
    expect(made).toHaveLength(0); // nothing started for the one that could have been asked, either

    const resetsAt = Date.now() + 86_400_000;
    h.app.store.setUsage({ provider: "codex", account: null, plan: null, windows: [{ label: "weekly", usedPercent: 100, resetsAt }], credits: null, note: null, updatedAt: Date.now() });
    // A plan that's used up says when it comes back, so the person knows when asking again is worth it.
    expect(await refusal([h.target("codex")])).toMatchObject({ status: 409, code: "budget", message: `Codex's plan is at 100% of its weekly limit. It comes back at ${limitResetTime(resetsAt)}. Ask again after it resets, or pick another.` });

    const writing = h.say(c, "agent", "Working on", { status: "streaming" });
    expect(await refusal([h.target("claude")], writing)).toMatchObject({ status: 409, code: "busy", message: "That reply is still being written. Ask once it's done." });

    expect(await refusal([])).toMatchObject({ status: 400, message: "Pick who to ask." });
    expect(await refusal([{ ...h.target("claude"), provider: "gemini" as ChatProvider }])).toMatchObject({ status: 400 });
    expect(await refusal([h.target("claude", DEFAULT_ACCOUNT, "--dangerous")])).toMatchObject({ status: 400 });
    expect(await refusal([h.target("claude", DEFAULT_ACCOUNT, null, "Max!")])).toMatchObject({ status: 400 });
    expect(await refusal([h.target("claude", "nope")])).toMatchObject({ status: 404 });
    expect(await refusal([h.target("claude")], h.say(c, "system", "Crosstalk restarted."))).toMatchObject({ status: 400 });
    expect(await h.refused(h.app.asks.start({ roomId: "r_nope", messageId: msg.id, targets: [h.target("claude")] }))).toMatchObject({ status: 404 });
    const elsewhere = h.chat("claude", "Elsewhere");
    expect(await h.refused(h.app.asks.start({ roomId: elsewhere.room.id, messageId: msg.id, targets: [h.target("claude")] }))).toMatchObject({ status: 404 }); // not that chat's message
    // A group chat's messages can be asked about like any chat's (not another chat's message, though); a room that's no
    // chat at all can't.
    const group = h.app.createRoom({ name: "Old room", cwd: temp("ct-asks-group-"), mode: "direct" });
    expect(await h.refused(h.app.asks.start({ roomId: group.id, messageId: msg.id, targets: [h.target("claude")] }))).toMatchObject({ status: 404 });
    const legacy = { id: newId("r"), name: "Neither", cwd: temp("ct-asks-room-"), mode: "direct" as const, leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1, updatedAt: 1, archived: false };
    h.app.store.insertRoom(legacy);
    expect(await h.refused(h.app.asks.start({ roomId: legacy.id, messageId: msg.id, targets: [h.target("claude")] }))).toMatchObject({ status: 400, message: "Ask others works in chats." });
    expect(Array.isArray(await h.app.asks.targets(group.id))).toBe(true);
    expect(await h.refused(h.app.asks.targets(legacy.id))).toMatchObject({ status: 400 });
    expect(await h.refused(h.app.asks.targets("r_nope"))).toMatchObject({ status: 404 });
    // An agent that isn't installed has no account to ask at all.
    h.app.providers.accounts = () => [];
    h.app.providers.which = () => null;
    expect(await refusal([h.target("claude")])).toEqual({ status: 409, code: "not_signed_in", message: "Claude Code isn't installed on this machine. Install it, then ask again." });
    expect(made).toHaveLength(0);
  });

  test("a limit used up while an ask waited refuses it when its turn comes, without starting anything", async () => {
    const h = hub();
    h.extra.push(apiKey("claude", "k1", "Work key"));
    const c = h.chat("codex");
    const msg = h.say(c, "human", "Fix it");
    const release: (() => void)[] = [];
    behave = () => new Promise<TurnResult>((res) => release.push(() => res({ ok: true, text: "ok" })));
    const asks = await h.ask(c, msg, [h.target("codex"), h.target("codex"), h.target("codex"), h.target("claude", "k1")]);
    expect(asks[3].status).toBe("queued");
    h.limits.set("claude:k1", "API key reached its $250 limit, so this reply didn't start.");
    release[0]();
    await h.settled(asks[3].id);
    expect(h.app.asks.get(asks[3].id)).toMatchObject({ status: "error", error: "API key reached its $250 limit, so this reply didn't start.", cost: null });
    expect(made.filter((x) => x.ctx.member.provider === "claude")).toHaveLength(0);
  });

  test("a chat kept from other chats' agents can still be asked about; the ask says whether it stays on this machine", async () => {
    const h = hub();
    const local = h.app.providers.setEndpointAccount("codex", { label: "Local Qwen", baseUrl: "http://localhost:8080", models: ["qwen3.8-27b"] });
    const c = h.chat("claude", "Private", { privateFromAgents: true });
    expect(h.app.store.getRoom(c.room.id)!.privateFromAgents).toBe(true);
    const msg = h.say(c, "human", "My secret plan");
    const [online, onThisMachine] = await h.ask(c, msg, [h.target("codex"), h.target("codex", local.id)]);
    expect(online.local).toBe(false);
    expect(onThisMachine.local).toBe(true);
    await h.settled(online.id);
    await h.settled(onThisMachine.id);
    expect(made).toHaveLength(2);
  });
});

// ================================================================================================ what it cost

describe("cost", () => {
  const costs = async (provider: ChatProvider, account: AgentAccount | null, usage: Partial<{ inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number | null }> | null) => {
    const h = hub();
    if (account) h.extra.push(account);
    h.app.spend.priceReply = ({ inputTokens, outputTokens }) => ({ costUsd: (inputTokens + outputTokens) / 10_000, basis: "estimated" });
    const c = h.chat("claude");
    behave = ({ sink }) => {
      if (usage) sink.usage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null, ...usage });
      return { ok: true, text: "ok" };
    };
    const [one] = await h.ask(c, h.say(c, "human", "Fix it"), [h.target(provider, account?.id)]);
    await h.settled(one.id);
    return { cost: h.app.asks.get(one.id)!.cost, spent: h.spent };
  };
  const used = { inputTokens: 3000, outputTokens: 1000, cachedInputTokens: 500, costUsd: 0.0421 };

  test("a fresh Claude Code process's own figure is exact on an API key, and only what a plan sign-in would cost on a plan", async () => {
    expect((await costs("codex", apiKey("codex", "k1", "Key"), used)).cost).toEqual({ costUsd: 0.4, basis: "estimated", inputTokens: 3000, outputTokens: 1000 }); // tokens priced by the spend module
    const key = await costs("claude", apiKey("claude", "k2", "Key"), used);
    expect(key.cost).toEqual({ costUsd: 0.0421, basis: "exact", inputTokens: 3000, outputTokens: 1000 });
    expect(key.spent[0]).toMatchObject({ source: "ask", provider: "claude", account: "k2", costUsd: 0.0421, basis: "exact", inputTokens: 3000, outputTokens: 1000, cachedTokens: 500 });
    expect((await costs("claude", null, used)).cost).toMatchObject({ costUsd: 0.0421, basis: "plan" });
    // Codex reports tokens only: priced from the lists, and on a plan, shown as what it would cost.
    expect((await costs("codex", null, { ...used, costUsd: null })).cost).toEqual({ costUsd: 0.4, basis: "plan", inputTokens: 3000, outputTokens: 1000 });
  });

  test("no price known stays unknown, never a made-up zero; a reply that reported nothing is unknown", async () => {
    const h = hub();
    h.extra.push(apiKey("codex", "k1", "Key"));
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    behave = ({ sink }) => (sink.usage({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: null }), { ok: true, text: "ok" });
    const [priced] = await h.ask(c, msg, [h.target("codex", "k1")]); // the spend stub has no price
    await h.settled(priced.id);
    expect(h.app.asks.get(priced.id)!.cost).toEqual({ costUsd: null, basis: "unknown", inputTokens: 100, outputTokens: 10 });
    h.app.spend.priceReply = () => ({ costUsd: 0, basis: "estimated" }); // even a price list that would call this free: with no tokens reported it's unknown, not $0
    behave = () => ({ ok: true, text: "ok" });
    const [silent] = await h.ask(c, msg, [h.target("codex", "k1")]);
    await h.settled(silent.id);
    expect(h.app.asks.get(silent.id)!.cost).toEqual({ costUsd: null, basis: "unknown", inputTokens: 0, outputTokens: 0 });
    expect(h.spent.map((e) => [e.costUsd, e.basis])).toEqual([[null, "unknown"], [null, "unknown"]]); // both still counted as replies
  });

  test("a model on this machine is free, whatever the agent claims", async () => {
    const h = hub();
    const local = h.app.providers.setEndpointAccount("claude", { label: "Local Qwen", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b"] });
    const c = h.chat("codex");
    behave = ({ sink }) => (sink.usage({ inputTokens: 3000, outputTokens: 1000, cachedInputTokens: 0, costUsd: 0.0123 }), { ok: true, text: "ok" });
    const [one] = await h.ask(c, h.say(c, "human", "Fix it"), [h.target("claude", local.id)]);
    await h.settled(one.id);
    expect(h.app.asks.get(one.id)).toMatchObject({ local: true, cost: { costUsd: 0, basis: "free", inputTokens: 3000, outputTokens: 1000 } });
    expect(h.spent[0]).toMatchObject({ costUsd: 0, basis: "free", account: local.id });
  });

  test("a figure Claude Code makes up for a model server's model isn't trusted: it's priced from the lists or unknown", async () => {
    const h = hub();
    const online = h.app.providers.setEndpointAccount("claude", { label: "Kimi", baseUrl: "https://api.example.com", models: ["kimi-k2"] });
    const c = h.chat("codex");
    behave = ({ sink }) => (sink.usage({ inputTokens: 3000, outputTokens: 1000, cachedInputTokens: 0, costUsd: 99 }), { ok: true, text: "ok" });
    const [one] = await h.ask(c, h.say(c, "human", "Fix it"), [h.target("claude", online.id)]);
    await h.settled(one.id);
    expect(h.app.asks.get(one.id)!.cost).toEqual({ costUsd: null, basis: "unknown", inputTokens: 3000, outputTokens: 1000 });
  });
});

// ================================================================================================ custom models reach the agent

describe("accounts that run on a model server of your own", () => {
  test("the agent is given the server, its key and its model, and the translator's address for a server it can't speak to", async () => {
    const h = hub();
    const kimi = h.app.providers.setEndpointAccount("codex", { label: "Kimi", baseUrl: "https://api.example.com", apiKey: "sk-kimi", models: ["kimi-k2", "kimi-k2-thinking"], contextWindow: 131072 });
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const [one] = await h.ask(c, msg, [h.target("codex", kimi.id)]);
    await h.settled(one.id);
    expect(one.target.model).toBe("kimi-k2"); // the server's first
    expect(made[0].ctx.endpoint).toEqual({ id: kimi.id, label: "Kimi", baseUrl: "https://api.example.com", models: ["kimi-k2", "kimi-k2-thinking"], contextWindow: 131072, key: "sk-kimi" });
    expect(made[0].ctx.member.config.account).toBe(kimi.id);
    expect(made[0].ctx.env.CODEX_HOME).toBe(process.env.CODEX_HOME as string);
    // The main sign-in has no server.
    const [plain] = await h.ask(c, msg, [h.target("codex")]);
    await h.settled(plain.id);
    expect(made[1].ctx.endpoint).toBeNull();
    expect(made[1].ctx.member.config.account).toBeUndefined();
    // A translator (T6) for a server that only speaks Chat Completions gives the agent its own address and key.
    h.app.adapter.urlFor = (provider, id) => (provider === "codex" && id === kimi.id ? { baseUrl: "http://127.0.0.1:9123", key: "adapter-key" } : null);
    const [via] = await h.ask(c, msg, [h.target("codex", kimi.id)]);
    await h.settled(via.id);
    expect(made[2].ctx.endpoint).toMatchObject({ id: kimi.id, baseUrl: "http://127.0.0.1:9123", key: "adapter-key" });
  });

  test("an ask is given its model server exactly as the engine gives it to a chat's agent (the two wirings are kept alike)", async () => {
    const h = hub();
    const kimi = h.app.providers.setEndpointAccount("codex", { label: "Kimi", baseUrl: "https://api.example.com", apiKey: "sk-kimi", models: ["kimi-k2"], contextWindow: 131072 });
    h.app.adapter.urlFor = (provider, id) => (provider === "codex" && id === kimi.id ? { baseUrl: "http://127.0.0.1:9123", key: "adapter-key" } : null);
    const c = h.chat("claude");
    // What the engine itself does for an agent of a chat on this account (its private driver cache, so this is its own wiring).
    const inChat: Member = { ...c.member, provider: "codex", model: "kimi-k2", config: { account: kimi.id } };
    (h.app.engine as unknown as { getDriver(room: Room, member: Member): AgentDriver }).getDriver(c.room, inChat);
    const [one] = await h.ask(c, h.say(c, "human", "Fix it"), [h.target("codex", kimi.id)]);
    await h.settled(one.id);
    expect(made).toHaveLength(2);
    expect(made[0].ctx.endpoint).toMatchObject({ id: kimi.id, baseUrl: "http://127.0.0.1:9123", key: "adapter-key" });
    expect(made[1].ctx.endpoint).toEqual(made[0].ctx.endpoint);
  });

  test("Codex starts a one-off thread on the server's Responses API with its model, its key and no tools of the hub", async () => {
    const h = hub();
    real = true;
    const log = join(temp("ct-asks-log-"), "thread.json");
    process.env.FAKE_CODEX_LOG = log;
    const qwen = h.app.providers.setEndpointAccount("codex", { label: "Qwen local", baseUrl: "http://127.0.0.1:8080", apiKey: "sk-local", models: ["qwen3.8-27b", "other"], contextWindow: 65536 });
    const c = h.chat("claude");
    const [one] = await h.ask(c, h.say(c, "human", "Fix it"), [h.target("codex", qwen.id)]);
    await h.settled(one.id);
    expect(h.app.asks.get(one.id)).toMatchObject({ status: "done", answer: "Done.", local: true });
    const thread = JSON.parse(readFileSync(log, "utf8"));
    expect(thread.ephemeral).toBe(true);
    expect(thread.model).toBe("qwen3.8-27b");
    expect(thread.config.model_provider).toBe(`crosstalk_${qwen.id}`);
    expect(thread.config.model_providers[`crosstalk_${qwen.id}`]).toMatchObject({ name: "Qwen local", base_url: "http://127.0.0.1:8080/v1", wire_api: "responses", http_headers: { Authorization: "Bearer sk-local" } });
    expect(thread.config.model_context_window).toBe(65536);
    expect(thread.config.mcp_servers).toBeUndefined();
    // One question, once: nobody sends it anything else, so nothing about working alongside the person (alongside.ts).
    expect(thread.developerInstructions).toBe(helperNote("codex", null, false));
    // "They can't change anything": nothing it runs can write, and what would need a say is put to the hub, which refuses.
    expect(thread.sandbox).toBe("read-only");
    expect(thread.approvalPolicy).toBe("on-request");
  });

  test("Claude Code starts a one-off process pointed at the server, with the model asked for and no saved session", async () => {
    const h = hub();
    real = true;
    const dir = temp("ct-asks-log-");
    process.env.FAKE_CLAUDE_ARGS_OUT = join(dir, "args.jsonl");
    process.env.FAKE_CLAUDE_ENV_OUT = join(dir, "env.jsonl");
    const qwen = h.app.providers.setEndpointAccount("claude", { label: "Qwen local", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b"], contextWindow: 65536 });
    const c = h.chat("codex");
    const [one] = await h.ask(c, h.say(c, "human", "Fix it"), [h.target("claude", qwen.id)], "Is this right?");
    await h.settled(one.id);
    expect(h.app.asks.get(one.id)).toMatchObject({ status: "done", local: true, cost: { costUsd: 0, basis: "free" } });
    expect(h.app.asks.get(one.id)!.answer).toContain("Done.");
    const args = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ARGS_OUT, "utf8").trim().split("\n")[0]) as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("qwen3.8-27b");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default"); // "ask": nothing is allowed without an approval, and every approval is refused
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    // Anything that isn't read-only is put to the hub's approval tool (which refuses an agent it doesn't know); nothing is allowed ahead of time.
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__crosstalk__approve");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
    // One question, once: nobody sends it anything else, so nothing about working alongside the person (alongside.ts).
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(helperNote("claude", null, false));
    const env = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ENV_OUT, "utf8").trim().split("\n")[0]);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1"); // the endpoint account's environment reached the process
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("16384");
  });
});

// ================================================================================================ over HTTP

describe("routes", () => {
  test("the sheet's list, asking, listing, stopping and removing, as a phone does them", async () => {
    const h = hub();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix the login bug");
    const rows = (await h.api<{ handle: string; available: boolean; target: AskTarget }[]>("GET", `/api/asks/targets?room=${c.room.id}`)).data;
    expect(rows.map((r) => r.handle)).toEqual(["codex"]);

    behave = ({ sink }) => untilStopped(sink);
    const posted = await h.api<Ask[]>("POST", "/api/asks", { roomId: c.room.id, messageId: msg.id, targets: [rows[0].target], note: "Anything wrong?" });
    expect(posted.status).toBe(200);
    expect(posted.data).toHaveLength(1);
    expect(posted.data[0]).toMatchObject({ roomId: c.room.id, messageId: msg.id, status: "running", note: "Anything wrong?", label: "Codex · GPT Test" });
    const id = posted.data[0].id;
    expect((await h.api<Ask[]>("GET", `/api/rooms/${c.room.id}/asks`)).data.map((a) => a.id)).toEqual([id]);

    const stopped = await h.api<Ask>("POST", `/api/asks/${id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.data).toMatchObject({ id, status: "stopped" });
    expect((await h.api("DELETE", `/api/asks/${id}`)).data).toEqual({ ok: true });
    expect((await h.api<Ask[]>("GET", `/api/rooms/${c.room.id}/asks`)).data).toEqual([]);
    expect(h.events.some((e) => e.t === "ask.removed" && e.id === id && e.roomId === c.room.id)).toBe(true);
    expect((await h.api("DELETE", `/api/asks/${id}`)).data).toEqual({ ok: true }); // twice is fine

    // A refusal arrives as an error with its code.
    h.limits.set("codex:default", "API key reached its $250 limit, so this reply didn't start.");
    const refused = await h.api("POST", "/api/asks", { roomId: c.room.id, messageId: msg.id, targets: [{ provider: "codex", account: "default", model: null, effort: null }] });
    expect(refused).toEqual({ status: 409, data: { error: "API key reached its $250 limit, so this reply didn't start.", code: "budget" } });
    expect((await h.api("POST", "/api/asks", {})).status).toBe(404);
    expect((await h.api("GET", "/api/asks/targets?room=r_nope")).status).toBe(404);
    expect((await h.api("GET", "/api/rooms/r_nope/asks")).status).toBe(404);

    // Without a device's sign-in none of it is open.
    for (const [method, path] of [["GET", `/api/asks/targets?room=${c.room.id}`], ["GET", `/api/rooms/${c.room.id}/asks`], ["POST", "/api/asks"], ["POST", `/api/asks/${id}/stop`], ["DELETE", `/api/asks/${id}`]]) {
      expect((await fetch(`${h.base()}${path}`, { method })).status).toBe(401);
    }
  });
});

// ================================================================================================ picking the model (newer than 0.6.1)

describe("picking the model", () => {
  /** The sheet's list (models=1), this machine only, by handle. */
  const sheet = async (h: ReturnType<typeof hub>, roomId: string) => Object.fromEntries((await h.app.asks.targetsFor(roomId, { models: true, machines: false })).choices.map((r) => [r.handle, r]));
  /** The @ popup's list (no models), by handle. */
  const popup = async (h: ReturnType<typeof hub>, roomId: string) => Object.fromEntries((await h.app.asks.targetsFor(roomId, { machines: false })).choices.map((r) => [r.handle, r]));
  const codexList = () => [
    model("gpt-test", "GPT Test", { isDefault: true, defaultEffort: "medium", efforts: ["low", "medium", "high"], contextWindow: 272_000, description: "The usual one." }),
    model("gpt-mini", "GPT Mini", { defaultEffort: "low", efforts: ["low", "medium"], contextWindow: 128_000 }),
    model("gpt-chat", "GPT Chat", { noTools: true, contextWindow: 32_768, more: true }),
  ];

  test("the sheet's list gives each row that can be asked its models, as every model picker has them, each with what an ask on it costs", async () => {
    const h = hub();
    h.lists.codex = codexList();
    h.extra.push(apiKey("claude", "k1", "Work key"), apiKey("claude", "k2", "Full key"));
    h.limits.set("claude:k2", "API key reached its $50 limit, so this reply won't start.");
    const local = h.app.providers.setEndpointAccount("claude", { label: "Local Qwen", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b", "qwen3-8b"], contextWindow: 65536 });
    const kimi = h.app.providers.setEndpointAccount("codex", { label: "Kimi", baseUrl: "https://api.example.com", models: ["kimi-k2", "kimi-new"], apiKey: "sk-test" });
    // The price lists know one of Kimi's models, not the other.
    h.app.spend.priceReply = ({ model: m }) => (m === "kimi-k2" ? { costUsd: 0.5, basis: "estimated" } : { costUsd: null, basis: "unknown" });
    const c = h.chat("claude", "Chat", { model: "sonnet" });
    const rows = await sheet(h, c.room.id);

    // Codex's own list as it is (sizes, levels, "No tools", More models), each model priced as the row is: a plan's isn't money.
    expect(rows.codex.models!.map((m) => [m.id, m.label, m.contextWindow, m.efforts, m.defaultEffort, m.isDefault, !!m.noTools, !!m.more, m.paid, m.typicalCostUsd])).toEqual([
      ["gpt-test", "GPT Test", 272_000, ["low", "medium", "high"], "medium", true, false, false, "no", null],
      ["gpt-mini", "GPT Mini", 128_000, ["low", "medium"], "low", false, false, false, "no", null],
      ["gpt-chat", "GPT Chat", 32_768, [], null, false, true, true, "no", null],
    ]);
    expect(rows.codex.models![0].description).toBe("The usual one.");
    expect(rows.codex).toMatchObject({ target: { model: "gpt-test", effort: "medium" }, label: "Codex · GPT Test" });
    expect(rows.codex.remembered).toBeUndefined();
    expect(rows.codex.fixedModel).toBeUndefined();
    // An API key's every model costs money; a model on this machine is free whichever it is; an online service's when its price is known.
    expect(rows["work-key"].models!.map((m) => [m.id, m.paid])).toEqual([["opus", "yes"], ["sonnet", "yes"]]);
    expect(rows["local-qwen"].models!.map((m) => [m.id, m.paid])).toEqual([["qwen3.8-27b", "no"], ["qwen3-8b", "no"]]);
    expect(rows.kimi.models!.map((m) => [m.id, m.paid])).toEqual([["kimi-k2", "yes"], ["kimi-new", "unknown"]]);
    expect(rows.kimi.target).toEqual({ provider: "codex", account: kimi.id, model: "kimi-k2", effort: null });
    expect(rows["local-qwen"].target.account).toBe(local.id);
    // A row that can't be asked has no picker.
    expect(rows["full-key"]).toMatchObject({ available: false, why: "Over its limit" });
    expect(rows["full-key"].models).toBeUndefined();
    // The @ popup's list (and an older app's) is as it was: no models in it.
    expect(Object.values(await popup(h, c.room.id)).some((r) => "models" in r || "fixedModel" in r)).toBe(false);
    // Reading the lists started nothing.
    expect(made).toHaveLength(0);
  });

  test("a model and effort picked in the sheet are asked, kept, and the next list and an @name start on them", async () => {
    const h = hub();
    h.lists.codex = codexList();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const picked = { provider: "codex" as const, account: DEFAULT_ACCOUNT, model: "gpt-mini", effort: "medium" };
    const [one] = await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex", DEFAULT_ACCOUNT, "gpt-mini", "medium")], remember: [picked] });
    // The card says the model it was asked on.
    expect(one).toMatchObject({ label: "Codex · GPT Mini", target: { provider: "codex", account: "default", model: "gpt-mini", effort: "medium" } });
    await h.settled(one.id);
    expect(made.map((x) => [x.ctx.member.model, x.ctx.member.config.effort])).toEqual([["gpt-mini", "medium"]]);

    // Kept: the sheet opens on it, and the @ popup's row (what an @name asks) is on it too.
    for (const rows of [await sheet(h, c.room.id), await popup(h, c.room.id)]) {
      expect(rows.codex).toMatchObject({ label: "Codex · GPT Mini", target: { provider: "codex", account: "default", model: "gpt-mini", effort: "medium" }, remembered: { model: "gpt-mini", effort: "medium" } });
    }
    // Kept as names only, on this hub.
    expect(JSON.parse(h.app.store.kvGet("asks.picks")!)).toEqual({ "|codex|default": { model: "gpt-mini", effort: "medium", at: expect.any(Number) } });
    // An effort alone (the model left on its default) is a pick too; the defaults again forget it.
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex", DEFAULT_ACCOUNT, "gpt-test", "high")], remember: [{ ...picked, model: null, effort: "high" }] });
    expect((await popup(h, c.room.id)).codex).toMatchObject({ label: "Codex · GPT Test", target: { model: "gpt-test", effort: "high" }, remembered: { model: null, effort: "high" } });
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex")], remember: [{ ...picked, model: null, effort: null }] });
    const back = (await sheet(h, c.room.id)).codex;
    expect(back).toMatchObject({ label: "Codex · GPT Test", target: { model: "gpt-test", effort: "medium" } });
    expect(back.remembered).toBeUndefined();
    expect(JSON.parse(h.app.store.kvGet("asks.picks")!)).toEqual({});
  });

  test("only what was asked is kept: not a target the request didn't ask, not a refused request, not a name that isn't one", async () => {
    const h = hub();
    h.lists.codex = codexList();
    h.extra.push(apiKey("claude", "k1", "Work key"));
    const c = h.chat("claude", "Chat", { model: "sonnet" });
    const msg = h.say(c, "human", "Fix it");
    const memo = (provider: ChatProvider, account: string, m: unknown, effort: unknown = null) => ({ provider, account, model: m, effort });
    // Asking Codex alone: a pick for the work key rides along, and one with a broken name; neither is kept.
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex", DEFAULT_ACCOUNT, "gpt-mini")], remember: [memo("codex", DEFAULT_ACCOUNT, "gpt-mini"), memo("claude", "k1", "sonnet"), memo("codex", DEFAULT_ACCOUNT, "gpt mini; rm -rf /")] });
    expect(Object.keys(JSON.parse(h.app.store.kvGet("asks.picks")!))).toEqual(["|codex|default"]);
    expect((await popup(h, c.room.id))["work-key"].target.model).toBe("opus");
    // A request the hub refuses keeps nothing.
    h.limits.set("claude:k1", "API key reached its $50 limit, so this reply won't start.");
    expect(await h.refused(h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("claude", "k1", "sonnet")], remember: [memo("claude", "k1", "sonnet")] }))).toMatchObject({ status: 409, code: "budget" });
    expect(Object.keys(JSON.parse(h.app.store.kvGet("asks.picks")!))).toEqual(["|codex|default"]);
    // Something that isn't a list of picks at all is no pick.
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex")], remember: "gpt-test" });
    expect(Object.keys(JSON.parse(h.app.store.kvGet("asks.picks")!))).toEqual(["|codex|default"]);
  });

  test("a pick its list no longer has isn't guessed at: the row is back on its default and says which; an effort its model dropped goes alone", async () => {
    const h = hub();
    h.lists.codex = codexList();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex", DEFAULT_ACCOUNT, "gpt-mini", "medium")], remember: [{ provider: "codex", account: DEFAULT_ACCOUNT, model: "gpt-mini", effort: "medium" }] });
    // GPT Mini only takes "low" now: the model stays picked, the effort is the model's own again.
    h.lists.codex = codexList().map((m) => (m.id === "gpt-mini" ? { ...m, efforts: ["low"] } : m));
    expect((await popup(h, c.room.id)).codex).toMatchObject({ label: "Codex · GPT Mini", target: { model: "gpt-mini", effort: "low" }, remembered: { model: "gpt-mini", effort: null } });
    // Codex doesn't list GPT Mini any more: the row is on Codex's default, by name, and nothing says GPT Mini.
    h.lists.codex = codexList().filter((m) => m.id !== "gpt-mini");
    const gone = (await sheet(h, c.room.id)).codex;
    expect(gone).toMatchObject({ label: "Codex · GPT Test", target: { model: "gpt-test", effort: "medium" } });
    expect(gone.remembered).toBeUndefined();
    // Listed again later: the pick stands (it was never replaced).
    h.lists.codex = codexList();
    expect((await popup(h, c.room.id)).codex.target).toMatchObject({ model: "gpt-mini", effort: "medium" });
    // A list that can't be read gives no pick and no default: the row says why, as before.
    h.down.set("codex:default", "codex: couldn't list models (exit 1)");
    expect((await sheet(h, c.room.id)).codex).toMatchObject({ available: false, why: "Couldn't read its models", target: { model: null } });
  });

  test("asked on the defaults while the kept model is missing from the list for now: the pick isn't forgotten, and stands again once it's listed", async () => {
    const h = hub();
    h.lists.codex = codexList();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const kept = { provider: "codex" as const, account: DEFAULT_ACCOUNT, model: "gpt-mini", effort: "medium" };
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex", DEFAULT_ACCOUNT, "gpt-mini", "medium")], remember: [kept] });
    // An update drops GPT Mini for a while: the row opens on Codex's default, and is asked like that (an app that sends
    // its defaults for every row it asks, or a person who changed nothing).
    h.lists.codex = codexList().filter((m) => m.id !== "gpt-mini");
    expect((await sheet(h, c.room.id)).codex.remembered).toBeUndefined();
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex")], remember: [{ ...kept, model: null, effort: null }] });
    expect(JSON.parse(h.app.store.kvGet("asks.picks")!)).toEqual({ "|codex|default": { model: "gpt-mini", effort: "medium", at: expect.any(Number) } });
    // GPT Mini is back: so is the pick, in the sheet and for an @name.
    h.lists.codex = codexList();
    expect((await popup(h, c.room.id)).codex).toMatchObject({ target: { model: "gpt-mini", effort: "medium" }, remembered: { model: "gpt-mini", effort: "medium" } });
    // With the model listed, the defaults do forget it.
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("codex")], remember: [{ ...kept, model: null, effort: null }] });
    expect(JSON.parse(h.app.store.kvGet("asks.picks")!)).toEqual({});
  });

  test("the chat's own agent stays as it was: a pick never makes it offered in its own chat, so @name there still means the chat's agent", async () => {
    const h = hub();
    const asked = h.chat("codex");
    const msg = h.say(asked, "human", "Fix it");
    await h.app.asks.start({ roomId: asked.room.id, messageId: msg.id, targets: [h.target("claude", DEFAULT_ACCOUNT, "sonnet")], remember: [{ provider: "claude", account: DEFAULT_ACCOUNT, model: "sonnet", effort: null }] });
    // In a Codex chat, Claude Code is on the pick.
    expect((await popup(h, asked.room.id)).claude).toMatchObject({ label: "Claude Code · Sonnet 4.6", target: { model: "sonnet" } });
    // In a Claude Code chat on its default model, Claude Code isn't offered at all (as before), pick or not.
    const own = h.chat("claude", "Own", { model: "opus" });
    expect(Object.keys(await sheet(h, own.room.id))).not.toContain("claude");
    // On another model, it's offered on its default, as before (the pick is for when it's asked from elsewhere).
    const onSonnet = h.chat("claude", "On Sonnet", { model: "sonnet" });
    expect((await popup(h, onSonnet.room.id)).claude).toMatchObject({ label: "Claude Code · Opus 5.5", target: { model: "opus" } });
  });

  test("the model pool runs one model: its row says so instead of offering a list, and a pick never moves it", async () => {
    const h = hub();
    const pool = h.app.providers.setEndpointAccount("claude", { label: "Model pool", baseUrl: "http://127.0.0.1:18080", models: ["qwen-pool", "qwen-other"], contextWindow: 65536 });
    h.app.store.kvSet("pool.accounts", JSON.stringify({ claude: pool.id }));
    const c = h.chat("codex");
    const msg = h.say(c, "human", "Fix it");
    await h.app.asks.start({ roomId: c.room.id, messageId: msg.id, targets: [h.target("claude", pool.id, "qwen-pool")], remember: [{ provider: "claude", account: pool.id, model: "qwen-other", effort: null }] });
    const row = (await sheet(h, c.room.id))["model-pool"];
    expect(row).toMatchObject({ fixedModel: "pool", available: true, target: { model: "qwen-pool" }, label: "Model pool · qwen-pool" });
    expect(row.models).toBeUndefined();
    expect(row.remembered).toBeUndefined();
  });

  test("over HTTP: the sheet asks with models=1, and its picks ride along with the question", async () => {
    const h = hub();
    h.lists.codex = codexList();
    const c = h.chat("claude");
    const msg = h.say(c, "human", "Fix it");
    const listed = (await h.api<{ choices: AskChoice[] }>("GET", `/api/asks/targets?room=${c.room.id}&machines=1&models=1`)).data.choices;
    expect(listed.find((r) => r.handle === "codex")!.models!.map((m) => m.id)).toEqual(["gpt-test", "gpt-mini", "gpt-chat"]);
    const plain = (await h.api<AskChoice[]>("GET", `/api/asks/targets?room=${c.room.id}`)).data;
    expect(plain.some((r) => "models" in r)).toBe(false);
    const posted = await h.api<Ask[]>("POST", "/api/asks", { roomId: c.room.id, messageId: msg.id, targets: [{ provider: "codex", account: "default", model: "gpt-chat", effort: null }], remember: [{ provider: "codex", account: "default", model: "gpt-chat", effort: null }] });
    expect(posted.status).toBe(200);
    expect(posted.data[0]).toMatchObject({ label: "Codex · GPT Chat", target: { model: "gpt-chat" } });
    expect((await h.api<AskChoice[]>("GET", `/api/asks/targets?room=${c.room.id}`)).data.find((r) => r.handle === "codex")).toMatchObject({ label: "Codex · GPT Chat", remembered: { model: "gpt-chat", effort: null } });
  });
});
