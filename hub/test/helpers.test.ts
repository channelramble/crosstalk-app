// Helpers on another account (hub/src/helpers.ts): a chat's agent hands work to a helper that Crosstalk runs on the
// account the person chose. Nothing here starts a real agent CLI or reaches a network: the agents are a scripted stand-in
// (each test says what the chat's agent and its helper do) or, where a test wants the real driver, fixtures/fake-claude.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CROSSTALK_HELPER, DEFAULT_ACCOUNT, helperAccountLabel, helpersOf, type AgentAccount, type BackgroundTask, type ChatProvider, type HelpersOn, type Member, type ModelOption, type PermissionMode, type Room, type ServerEvent } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { alongsideNote } from "../src/agents/alongside";
import { helperNote } from "../src/agents/model-lock";
import { App } from "../src/app";
import { handleInternal } from "../src/mcp/internal";
import { describeToolCall } from "../src/mcp/describe";
import { askable } from "../src/teamwork";

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
/** What the chat's own agent does with a turn, and what a helper does with its task. */
let chatAgent: Behave = () => ({ ok: true, text: "Done." });
let helper: Behave = () => ({ ok: true, text: "Report: all 12 tests pass." });
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
    return (this.ctx.chat?.ephemeral ? helper : chatAgent)({ ctx: this.ctx, input, sink });
  }
  async interrupt() {}
  async dispose() {
    this.rec.disposed = true;
  }
}

/** Work that ends only when it's stopped. */
const untilStopped = (sink: TurnSink) => new Promise<TurnResult>((res) => sink.signal.addEventListener("abort", () => res({ ok: false, error: "stopped" }), { once: true }));
/** Work that ends when the test says so. */
function gate() {
  let open!: (r: TurnResult) => void;
  const done = new Promise<TurnResult>((res) => (open = res));
  return { done, open };
}

const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  chatAgent = () => ({ ok: true, text: "Done." });
  helper = () => ({ ok: true, text: "Report: all 12 tests pass." });
  real = false;
  made.length = 0;
  for (const k of ["FAKE_CLAUDE_ARGS_OUT"]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  registerDriver("claude", (ctx) => {
    if (!ctx.bin) throw new Error("Claude Code isn't installed on the machine. Install it under Agents & sign-ins.");
    return new ClaudeDriver(ctx, ctx.bin);
  });
  registerDriver("codex", (ctx) => {
    if (!ctx.bin) throw new Error("Codex isn't installed on the machine. Install it under Agents & sign-ins.");
    return new CodexDriver(ctx, ctx.bin);
  });
});

// ------------------------------------------------------------------------------------------------ a hub

const signin = (provider: ChatProvider): AgentAccount => ({ provider, id: DEFAULT_ACCOUNT, label: "Main", kind: "signin", workspaceId: null, endpoint: null, signedIn: true, account: "me@example.com", plan: "Max", authMethod: "oauth", error: null, checkedAt: 0 });
const apiKey = (provider: ChatProvider, id: string, label: string): AgentAccount => ({ ...signin(provider), id, label, kind: "apikey", plan: null, authMethod: "apikey" });
const model = (id: string, label: string, more: Partial<ModelOption> = {}): ModelOption => ({ id, label, description: null, efforts: [], defaultEffort: null, isDefault: false, ...more });
const KEY: HelpersOn = { provider: "claude", account: "key1" };

/** A hub with Claude Code and Codex signed in on their plans and a Claude API key account ("key1"); `dbPath` for one that outlives the App. */
function hub(dbPath = ":memory:", workspaceRoot = temp("ct-helpers-work-")) {
  registerDriver("claude", (ctx) => (real ? new ClaudeDriver(ctx, ctx.bin) : new Scripted(ctx)));
  registerDriver("codex", (ctx) => (real ? new CodexDriver(ctx, ctx.bin) : new Scripted(ctx)));
  process.env.CLAUDE_CONFIG_DIR = temp("ct-helpers-claude-");
  process.env.CODEX_HOME = join(temp("ct-helpers-codex-"), "codex-home");
  const app = new App({ dbPath, config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot, maxHopsDefault: 6 } });
  app.providers.which = (p) => (p === "claude" ? join(FIX, "fake-claude") : p === "codex" ? join(FIX, "fake-codex-app") : null);
  const accounts: AgentAccount[] = [signin("claude"), apiKey("claude", "key1", "Work"), signin("codex")];
  app.providers.accounts = () => accounts;
  app.providers.hasAccount = (p, id) => accounts.some((a) => a.provider === p && a.id === id);
  const lists: Record<ChatProvider, ModelOption[]> = {
    claude: [model("opus", "Opus 5.5", { resolvedModel: "claude-opus-5-5", isDefault: true }), model("sonnet", "Sonnet 4.6", { resolvedModel: "claude-sonnet-4-6" })],
    codex: [model("gpt-test", "GPT Test", { isDefault: true })],
  };
  app.providers.models = async (p, account = DEFAULT_ACCOUNT) => ({ provider: p, accountId: account, models: lists[p as ChatProvider] ?? [], live: true, error: null });
  const events: ServerEvent[] = [];
  app.bus.on((e) => events.push(e));
  const chat = (o: { provider?: ChatProvider; helpers?: HelpersOn | null; permissionMode?: PermissionMode } = {}) => {
    const room = app.chats.create({ provider: o.provider ?? "claude", name: "Fix login", cwd: temp("ct-helpers-cwd-"), model: null, effort: null, helpers: o.helpers === undefined ? KEY : o.helpers, ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}) });
    return { room, member: app.chats.member(room.id)! };
  };
  const tool = async (member: Member, name: "start" | "result", body: Record<string, unknown>, signal?: AbortSignal) => {
    const req = new Request(`http://hub/internal/helper/${name}`, { method: "POST", headers: { "x-crosstalk-member": member.id, "x-crosstalk-token": app.internalToken(member.id) }, body: JSON.stringify(body), signal });
    return (await (await handleInternal(app, req, new URL(req.url))).json()) as { text: string; error?: boolean };
  };
  const send = (c: { room: Room }, text: string) => app.engine.postHumanMessage(c.room.id, text, "Phone");
  const idle = (c: { room: Room }) => until(() => !app.engine.isBusy(c.room.id), "the chat to be idle");
  const rows = (c: { member: Member }): BackgroundTask[] => app.engine.tasksIn(c.member.roomId)[c.member.id] ?? [];
  const texts = (c: { room: Room }) => app.store.listMessages(c.room.id, { limit: 50 }).map((m) => `${m.authorKind}: ${m.text}`);
  const helpersMade = () => made.filter((m) => m.ctx.chat?.ephemeral);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    app.helpers.limits.graceMs = 20;
    await app.asks.shutdown();
    await app.helpers.shutdown();
    await app.engine.shutdown();
    app.store.close();
  };
  cleanups.push(close);
  return { app, accounts, events, chat, tool, send, idle, rows, texts, helpersMade, close };
}

// ================================================================================================ the tests

describe("a helper on another account", () => {
  test("does the work on that account, in the chat's folder, and its report is the tool's result while the reply runs", async () => {
    const h = hub();
    const c = h.chat({ permissionMode: "edits" });
    let got = "";
    chatAgent = async ({ ctx }) => {
      got = (await h.tool(ctx.member, "start", { task: "Run the test suite and say what fails.", name: "Check the build", files: ["src/login.ts"] })).text;
      return { ok: true, text: `The helper says: ${got}` };
    };
    let during: BackgroundTask[] = [];
    helper = ({ sink }) => {
      sink.activity({ kind: "command", title: "bun test" });
      sink.usage({ inputTokens: 1200, outputTokens: 300, costUsd: 0.25 });
      during = h.rows(c);
      return { ok: true, text: "Report: all 12 tests pass." };
    };
    h.send(c, "Check the build with a helper");
    await h.idle(c);

    expect(got).toContain("Helper “Check the build” on Claude API key finished");
    expect(got).toContain("Report: all 12 tests pass.");
    expect(h.texts(c).at(-1)).toContain("The helper says: Helper “Check the build”");
    // The helper: a fresh, unsaved agent on the key account, in the chat's folder, with the chat's own permission level.
    const [run] = h.helpersMade();
    expect(run.ctx.member.config.account).toBe("key1");
    expect(run.ctx.member.permissionMode).toBe("edits");
    expect(run.ctx.room.cwd).toBe(c.room.cwd);
    expect(h.app.store.getMember(run.ctx.member.id)).toBeNull();
    expect(run.inputs[0].prompt).toContain("Run the test suite and say what fails.");
    expect(run.inputs[0].prompt).toContain("- src/login.ts");
    expect(run.disposed).toBe(true);
    // It was a row in the Helpers panel while it worked, and stays listed once done, with its account.
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ kind: CROSSTALK_HELPER, status: "running", description: "Check the build", account: "Claude API key", background: true });
    expect(h.rows(c)[0]).toMatchObject({ status: "completed", account: "Claude API key", costUsd: 0.25, costBasis: "exact", toolUses: 1 });
    expect(h.rows(c)[0].summary).toContain("all 12 tests pass");
    // Nothing waits for a restart, and nothing is busy.
    expect(h.app.store.kvGet("helpers.kept")).toBeNull();
    expect(h.app.engine.busyWork()).toEqual([]);
    // No reply of its own for a report the call already returned.
    expect(h.texts(c).filter((t) => t.startsWith("system:"))).toEqual([]);
  });

  test("its cost is booked on its own account, not the chat's", async () => {
    const h = hub();
    const c = h.chat();
    chatAgent = async ({ ctx, sink }) => {
      await h.tool(ctx.member, "start", { task: "Count the files." });
      sink.usage({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
      return { ok: true, text: "Counted." };
    };
    helper = ({ sink }) => {
      sink.usage({ inputTokens: 5000, outputTokens: 900, costUsd: 0.4 });
      return { ok: true, text: "41 files." };
    };
    h.send(c, "Count the files");
    await h.idle(c);
    const ledger = h.app.store.db.query("SELECT provider, account, source, cost_usd, basis, room_id, input_tokens FROM spend_ledger ORDER BY rowid").all() as Record<string, unknown>[];
    expect(ledger).toContainEqual({ provider: "claude", account: "key1", source: "helper", cost_usd: 0.4, basis: "exact", room_id: c.room.id, input_tokens: 5000 });
    // The chat's own reply is the plan's, as ever.
    expect(ledger.filter((r) => r.account === DEFAULT_ACCOUNT).every((r) => r.source === "turn" && r.basis === "plan")).toBe(true);
    expect(h.app.spend.accounts().find((a) => a.account === "key1")?.total.usd).toBeCloseTo(0.4);
  });

  test("its spending limit stops a new helper, in words that say which account and what to do", async () => {
    const h = hub();
    const c = h.chat();
    h.app.spend.record({ source: "helper", provider: "claude", account: "key1", roomId: c.room.id, chatName: "Fix login", model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 6, basis: "exact" });
    h.app.spend.setBudget("claude", "key1", { limitUsd: 5, period: "month" });
    const said = await h.tool(c.member, "start", { task: "Count the files." });
    expect(said.error).toBe(true);
    expect(said.text).toBe("No helper was started: Work reached its $5.00 limit, so a helper can't start on it. The person can raise the limit under Settings → Usage & costs → Costs, or pick another account for helpers. The person lets you use your own helpers when this happens: do this piece of work with them, or yourself.");
    expect(h.helpersMade()).toHaveLength(0);
    // With "use the agent's own helpers when that account can't" off, it's told not to.
    h.app.updateMember(c.member.id, { config: { ...c.member.config, helpersOn: { ...KEY, fallback: false } } });
    const strict = await h.tool(h.app.store.getMember(c.member.id)!, "start", { task: "Count the files." });
    expect(strict.text).toContain("The person chose that your own helpers aren't used instead");
  });

  test("a signed-out or removed account fails in plain words, before anything starts", async () => {
    const h = hub();
    const c = h.chat();
    h.accounts[1].signedIn = false;
    expect((await h.tool(c.member, "start", { task: "x" })).text).toStartWith("No helper was started: Claude API key is signed out. The person can sign in under Settings → ");
    h.accounts.splice(1, 1);
    const gone = await h.tool(c.member, "start", { task: "x" });
    expect(gone.text).toStartWith(`No helper was started: The account picked for helpers isn't on this machine any more. The person can pick another under "Helpers run on" in this chat's settings.`);
    expect(gone.error).toBe(true);
    expect(h.helpersMade()).toHaveLength(0);
    expect(h.rows(c)).toEqual([]);
  });

  test("a key refused or a limit hit while it works says so, with what the agent may do", async () => {
    const h = hub();
    const c = h.chat();
    helper = () => ({ ok: false, error: "Invalid API key · Please run /login", auth: { kind: "signedOut", said: "401" } });
    const refused = await h.tool(c.member, "start", { task: "x", name: "Lint" });
    expect(refused.error).toBe(true);
    expect(refused.text).toStartWith("Helper “Lint” on Claude API key couldn't finish: Claude API key refused its key (the person can check it under Settings → ");
    expect(refused.text).toContain("The person lets you use your own helpers when this happens");
    helper = () => ({ ok: false, error: "limit", limit: { kind: "usage", resetsAt: null, label: null } as never });
    expect((await h.tool(c.member, "start", { task: "x", name: "Lint" })).text).toContain("couldn't finish: Claude API key is out of messages.");
    expect(h.rows(c).map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  test("a report that comes after the reply ended wakes the agent in a reply of its own, with the report under a step", async () => {
    const h = hub();
    const c = h.chat();
    const work = gate();
    let started = "";
    chatAgent = async ({ ctx, input }) => {
      if (input.prompt.includes("reported back")) return { ok: true, text: "The helper found the bug in login.ts." };
      started = (await h.tool(ctx.member, "start", { task: "Find the login bug.", name: "Find the bug", wait: false })).text;
      return { ok: true, text: "A helper is looking." };
    };
    helper = () => work.done;
    h.send(c, "Find the login bug");
    await until(() => h.texts(c).some((t) => t.includes("A helper is looking.")), "the first reply");
    await h.idle(c);
    expect(started).toMatch(/^Started helper “Find the bug” on Claude API key \(id hp_\w+\)\. Carry on with other work/);
    // The reply is over and the helper still works: the chat is busy for a restart, and the row says so.
    expect(h.rows(c)[0]).toMatchObject({ status: "running", description: "Find the bug" });
    expect(h.app.engine.busyWork()).toEqual([{ roomId: c.room.id, memberId: c.member.id, why: "background" }]);
    expect(h.app.workingChats()).toEqual(["Fix login"]);

    work.open({ ok: true, text: "The bug is in login.ts line 40." });
    await until(() => h.texts(c).some((t) => t.includes("The helper found the bug")), "the woken reply");
    await h.idle(c);
    expect(h.texts(c)).toContain("system: A helper on Claude API key finished “Find the bug”. Claude Code is reading its report.");
    const woken = made.find((m) => !m.ctx.chat?.ephemeral)!.inputs.at(-1)!;
    expect(woken.prompt).toContain("A helper you started reported back after your reply ended.");
    expect(woken.prompt).toContain("The bug is in login.ts line 40.");
    const turn = h.app.store.listMessages(c.room.id, { limit: 5 }).at(-1)!.turnId!;
    const steps = h.app.store.listActivities(c.room.id, [turn]);
    expect(steps.map((s) => [s.title, s.status])).toEqual([["Helper on Claude API key: Find the bug", "done"]]);
    expect(steps[0].detail).toContain("The bug is in login.ts line 40.");
    // Handed over once: nothing more to collect, nothing kept for a restart.
    expect((await h.tool(c.member, "result", {})).text).toBe("No helper of yours is working, and every report has been given to you.");
    expect(h.app.store.kvGet("helpers.kept")).toBeNull();
    expect(h.app.engine.busyWork()).toEqual([]);
  });

  test("one that finishes while the reply still runs waits for helper_result, or for the reply's end", async () => {
    const h = hub();
    const c = h.chat();
    const reply = gate();
    let collected = "";
    chatAgent = async ({ ctx, input }) => {
      if (input.prompt.includes("reported back")) return { ok: true, text: "Read the second report." };
      await h.tool(ctx.member, "start", { task: "one", name: "First", wait: false });
      await until(() => h.rows(c)[0]?.status === "completed", "the first helper");
      await Bun.sleep(30);
      // Nothing was started for it while this reply runs.
      expect(h.texts(c).filter((t) => t.startsWith("system:"))).toEqual([]);
      collected = (await h.tool(ctx.member, "result", {})).text;
      await h.tool(ctx.member, "start", { task: "two", name: "Second", wait: false });
      await until(() => h.rows(c).every((r) => r.status === "completed"), "the second helper");
      return reply.done;
    };
    h.send(c, "Two helpers");
    await until(() => h.rows(c).length === 2 && h.rows(c).every((r) => r.status === "completed"), "both helpers");
    expect(collected).toContain("Helper “First” on Claude API key finished");
    await Bun.sleep(30);
    expect(h.texts(c).filter((t) => t.startsWith("system:"))).toEqual([]);
    reply.open({ ok: true, text: "Ending without reading the second." });
    await until(() => h.texts(c).some((t) => t.includes("Read the second report.")), "the woken reply");
    expect(h.texts(c)).toContain("system: A helper on Claude API key finished “Second”. Claude Code is reading its report.");
    const woken = made.find((m) => !m.ctx.chat?.ephemeral)!.inputs.at(-1)!.prompt;
    expect(woken).toContain("Helper “Second”");
    expect(woken).not.toContain("Helper “First”");
  });

  test("several work at once, helper_result collects them all, and the cap is said in words", async () => {
    const h = hub();
    const c = h.chat();
    const gates = [gate(), gate(), gate(), gate()];
    let n = 0;
    helper = () => gates[n++].done;
    for (const name of ["A", "B", "C", "D"]) expect((await h.tool(c.member, "start", { task: `task ${name}`, name, wait: false })).error).toBeUndefined();
    expect(h.rows(c).filter((r) => r.status === "running")).toHaveLength(4);
    const fifth = await h.tool(c.member, "start", { task: "task E", name: "E", wait: false });
    expect(fifth).toEqual({ text: "4 helpers are already working in this chat, the most at once. Call helper_result to wait for one, then start this one.", error: true });
    const all = h.tool(c.member, "result", {});
    gates.forEach((g, i) => g.open({ ok: true, text: `report ${i}` }));
    const text = (await all).text;
    for (const i of [0, 1, 2, 3]) expect(text).toContain(`report ${i}`);
    expect(text.split("\n\n---\n\n")).toHaveLength(4);
    // A wait that runs out says who is still working instead of hanging.
    helper = ({ sink }) => untilStopped(sink);
    h.app.helpers.limits.waitMs = 40;
    const slow = await h.tool(c.member, "start", { task: "slow", name: "Slow" });
    expect(slow.text).toMatch(/^Helper “Slow” on Claude API key \(id hp_\w+\) is still working after \d+ s\. Call helper_result to keep waiting/);
    expect((await h.tool(c.member, "result", { wait_minutes: 0 })).text).toContain("is still working");
  });
});

describe("what a helper may do", () => {
  test("anything above the chat's permissions is a card in the chat, on the running reply or on the one that started it", async () => {
    const h = hub();
    const c = h.chat({ permissionMode: "ask" });
    const decisions: string[] = [];
    helper = async ({ sink, ctx }) => {
      expect(ctx.member.permissionMode).toBe("ask");
      decisions.push(await sink.approval({ kind: "command", title: "rm -rf build", detail: "rm -rf build", always: "Always allow rm" }));
      return { ok: true, text: "Cleaned." };
    };
    const reply = gate();
    chatAgent = async ({ ctx, input }) => {
      if (input.prompt.includes("reported back")) return { ok: true, text: "Read the clean report." };
      await h.tool(ctx.member, "start", { task: "Clean the build folder.", name: "Clean", wait: false });
      return reply.done;
    };
    h.send(c, "Clean up");
    const pending = () => h.app.store.listApprovals(c.room.id).filter((a) => a.status === "pending");
    await until(() => pending().length === 1, "the card");
    const turn = h.app.engine.runningTurns(c.room.id)[0];
    expect(pending()[0]).toMatchObject({ title: "Helper on Claude API key: rm -rf build", kind: "command", memberId: c.member.id, turnId: turn.id, always: null });
    expect(h.app.store.getMember(c.member.id)!.status).toBe("approval");
    h.app.engine.decideApproval(pending()[0].id, "approve", "Phone");
    await until(() => decisions.length === 1, "the decision");
    expect(decisions).toEqual(["approve"]);
    reply.open({ ok: true, text: "Started it." });
    await until(() => h.texts(c).some((t) => t.includes("Read the clean report.")), "the report's reply");
    await h.idle(c);

    // After the reply ended: the card goes on the reply that started the helper, and a no is a no.
    const first = gate();
    helper = async ({ sink }) => {
      await first.done;
      decisions.push(await sink.approval({ kind: "command", title: "git push", detail: "git push" }));
      return { ok: true, text: "Not pushed." };
    };
    chatAgent = async ({ ctx, input }) => {
      if (input.prompt.includes("reported back")) return { ok: true, text: "Read it." };
      await h.tool(ctx.member, "start", { task: "Push it.", name: "Push", wait: false });
      return { ok: true, text: "Asked a helper to push." };
    };
    h.send(c, "Push");
    await until(() => h.texts(c).some((t) => t.includes("Asked a helper to push.")), "the reply");
    await h.idle(c);
    const started = h.app.store.listMessages(c.room.id, { limit: 20 }).find((m) => m.text === "Asked a helper to push.")!.turnId;
    first.open({ ok: true });
    await until(() => pending().length === 1, "the second card");
    expect(pending()[0]).toMatchObject({ title: "Helper on Claude API key: git push", turnId: started });
    h.app.engine.decideApproval(pending()[0].id, "deny", "Phone");
    await until(() => decisions.length === 2, "the second decision");
    expect(decisions[1]).toBe("deny");
    await until(() => h.texts(c).some((t) => t.includes("Read it.")), "the woken reply");
  });

  test("Claude Code's permission prompt for a helper reaches the chat; nothing else of the hub's tools knows a helper", async () => {
    const h = hub();
    const c = h.chat();
    let helperId = "";
    const asked = gate();
    helper = async ({ ctx }) => {
      helperId = ctx.member.id;
      return asked.done;
    };
    await h.tool(c.member, "start", { task: "Edit a file.", name: "Edit", wait: false });
    await until(() => !!helperId, "the helper");
    const call = (path: string, body: Record<string, unknown>) => {
      const req = new Request(`http://hub${path}`, { method: "POST", headers: { "x-crosstalk-member": helperId, "x-crosstalk-token": h.app.internalToken(helperId) }, body: JSON.stringify(body) });
      return handleInternal(h.app, req, new URL(req.url));
    };
    const approve = call("/internal/approve", { tool_name: "Bash", input: { command: "bun test" } }).then((r) => r.json());
    await until(() => h.app.store.listApprovals(c.room.id).some((a) => a.status === "pending"), "the card");
    const card = h.app.store.listApprovals(c.room.id).find((a) => a.status === "pending")!;
    expect(card.title).toBe("Helper on Claude API key: bun test");
    h.app.engine.decideApproval(card.id, "approve", "Phone");
    expect(await approve).toEqual({ behavior: "allow", updatedInput: { command: "bun test" } });
    // No questions for the person, no helpers of its own, no other chats.
    expect(await (await call("/internal/approve", { tool_name: "AskUserQuestion", input: { questions: [] } })).json()).toMatchObject({ behavior: "deny" });
    for (const path of ["/internal/helper/start", "/internal/xchat/list", "/internal/members", "/internal/ask"]) expect([path, (await call(path, { task: "x" })).status]).toEqual([path, 404]);
    asked.open({ ok: true, text: "Edited." });
  });
});

describe("stopping", () => {
  test("Stop on the reply ends the helpers it waits for, and nothing starts by itself afterwards", async () => {
    const h = hub();
    const c = h.chat();
    let aborted = false;
    helper = ({ sink }) => {
      sink.signal.addEventListener("abort", () => (aborted = true));
      return untilStopped(sink);
    };
    chatAgent = async ({ ctx, sink, input }) => {
      if (input.prompt.includes("stopped by the person")) return { ok: true, text: "Understood, it was stopped." };
      const ctl = new AbortController();
      sink.signal.addEventListener("abort", () => ctl.abort());
      await h.tool(ctx.member, "start", { task: "Long work.", name: "Long" }, ctl.signal);
      return { ok: false, error: "stopped" };
    };
    h.send(c, "Do long work");
    await until(() => h.rows(c)[0]?.status === "running", "the helper");
    await h.app.engine.stop(c.room.id);
    await until(() => h.rows(c)[0]?.status === "stopped", "the helper to stop");
    expect(aborted).toBe(true);
    expect(h.rows(c)[0]).toMatchObject({ status: "stopped", error: "You stopped it." });
    await Bun.sleep(60);
    // No reply of its own after a Stop; the agent hears of it with the person's next message.
    expect(h.app.engine.isBusy(c.room.id)).toBe(false);
    expect(h.texts(c).filter((t) => t.startsWith("system:"))).toEqual([]);
    h.send(c, "What happened?");
    await until(() => h.texts(c).some((t) => t.includes("Understood, it was stopped.")), "the next reply");
    expect(made.find((m) => !m.ctx.chat?.ephemeral)!.inputs.at(-1)!.prompt).toContain("Helper “Long” on Claude API key was stopped by the person before it finished.");
  });

  test("Stop helpers ends one still working after the reply ended", async () => {
    const h = hub();
    const c = h.chat();
    helper = ({ sink }) => untilStopped(sink);
    chatAgent = async ({ ctx }) => {
      await h.tool(ctx.member, "start", { task: "Long work.", name: "Long", wait: false });
      return { ok: true, text: "Started." };
    };
    h.send(c, "Do long work");
    await until(() => h.texts(c).some((t) => t.includes("Started.")), "the reply");
    await h.idle(c);
    expect(h.app.engine.busyWork()).toHaveLength(1);
    expect(await h.app.engine.stopHelpers(c.room.id, c.member.id)).toBe(1);
    await until(() => h.rows(c)[0]?.status === "stopped", "the helper to stop");
    expect(h.app.engine.busyWork()).toEqual([]);
    await Bun.sleep(40);
    expect(h.app.engine.isBusy(c.room.id)).toBe(false);
    expect(h.helpersMade()[0].disposed).toBe(true);
  });

  test("deleting the chat ends its helpers", async () => {
    const h = hub();
    const c = h.chat();
    helper = ({ sink }) => untilStopped(sink);
    await h.tool(c.member, "start", { task: "Long work.", wait: false });
    await h.app.deleteRoom(c.room.id);
    await until(() => h.helpersMade()[0].disposed, "the helper's process to go");
    expect(h.app.engine.busyWork()).toEqual([]);
  });
});

describe("a restart in the middle", () => {
  test("leaves nothing working or waiting: the next hub says what didn't finish and tells the agent", async () => {
    const dir = temp("ct-helpers-db-");
    const work = temp("ct-helpers-work-");
    const a = hub(join(dir, "hub.db"), work);
    const c = a.chat();
    helper = async ({ sink }) => {
      void sink.approval({ kind: "command", title: "bun test", detail: "" });
      return untilStopped(sink);
    };
    chatAgent = async ({ ctx }) => {
      await a.tool(ctx.member, "start", { task: "Long work.", name: "Long", wait: false });
      return { ok: true, text: "Started." };
    };
    a.send(c, "Do long work");
    await until(() => a.texts(c).some((t) => t.includes("Started.")), "the reply");
    await a.idle(c);
    await until(() => a.app.store.listApprovals(c.room.id).some((x) => x.status === "pending"), "its card");
    expect(JSON.parse(a.app.store.kvGet("helpers.kept")!)).toMatchObject({ [a.rows(c)[0].id]: { state: "running", name: "Long", label: "Claude API key", memberId: c.member.id } });
    await a.close();
    expect(a.helpersMade()[0].disposed).toBe(true);

    made.length = 0;
    const b = hub(join(dir, "hub.db"), work);
    chatAgent = () => ({ ok: true, text: "I'll start it again." });
    b.app.helpers.restore();
    await until(() => b.texts(c).some((t) => t.includes("I'll start it again.")), "the agent's reply");
    expect(b.texts(c)).toContain("system: Crosstalk restarted while a helper on Claude API key was working (“Long”). It didn't finish; Claude Code has been told.");
    expect(made[0].inputs[0].prompt).toContain("Helper “Long” on Claude API key was stopped when Crosstalk restarted, before it finished. Start it again if the work is still needed.");
    expect(b.rows(c)).toEqual([]);
    expect(b.app.engine.busyWork()).toEqual([]);
    expect(b.app.store.listApprovals(c.room.id).filter((x) => x.status === "pending")).toEqual([]);
    expect(b.app.store.kvGet("helpers.kept")).toBeNull();
    // Told once.
    b.app.helpers.restore();
    await Bun.sleep(30);
    expect(b.texts(c).filter((t) => t.includes("Crosstalk restarted while"))).toHaveLength(1);
  });
});

describe("who helps, and what the agent is told", () => {
  test("own helpers is today's chat: no tools, no note, the same instructions; another account adds them", async () => {
    const h = hub();
    const own = h.chat({ helpers: null });
    expect(own.member.config).toEqual({});
    expect(h.app.chats.context(own.room, own.member)).not.toHaveProperty("helpers");
    expect((await h.tool(own.member, "start", { task: "x" })).text).toStartWith("This chat's helpers are your own now");

    const other = h.chat();
    expect(helpersOf(other.member.config)).toEqual({ provider: "claude", account: "key1", model: null, effort: null, fallback: true });
    const ctx = h.app.chats.context(other.room, other.member).helpers!;
    expect(ctx).toMatchObject({ label: "Claude API key", only: false });
    expect(ctx.note).toContain("Helper work in this chat is done by helpers on Claude API key");
    expect(ctx.note).toContain("Use your own helpers only when start_helper says Claude API key can't run one.");
    h.app.updateMember(other.member.id, { config: { helpersOn: { ...KEY, fallback: false } } });
    const strict = h.app.chats.context(other.room, h.app.store.getMember(other.member.id)!).helpers!;
    expect(strict.only).toBe(true);
    expect(strict.note).toContain("Don't use your own helpers in this chat.");
    // An account that isn't this machine's is refused when it's picked; picking nothing is the agent's own helpers.
    expect(() => h.app.updateMember(other.member.id, { config: { helpersOn: { provider: "claude", account: "nope" } } })).toThrow("That account isn't on this machine any more");
    h.app.updateMember(other.member.id, { config: { helpersOn: null } });
    expect(h.app.store.getMember(other.member.id)!.config).toEqual({});
  });

  test("the real Claude Code driver: today's command line for own helpers; tools, note and the switch for another account", async () => {
    const h = hub();
    real = true;
    const out = join(temp("ct-helpers-args-"), "args.jsonl");
    process.env.FAKE_CLAUDE_ARGS_OUT = out;
    const starts = () => readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const arg = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
    const env = (args: string[]) => (JSON.parse(readFileSync(arg(args, "--mcp-config")!, "utf8")) as { mcpServers: { crosstalk: { env: Record<string, string> } } }).mcpServers.crosstalk.env;

    const own = h.chat({ helpers: null });
    h.send(own, "hello");
    await until(() => h.texts(own).some((t) => t.startsWith("agent: ") && t.length > 8), "the reply");
    await h.idle(own);
    const first = starts()[0];
    // Exactly what a chat was started with before helpers could run elsewhere.
    expect(arg(first, "--append-system-prompt")).toBe([h.app.chats.context(own.room, own.member).notes, helperNote("claude", null, true), alongsideNote("claude", own.room)].filter(Boolean).join("\n\n"));
    expect(arg(first, "--allowedTools")).toBe("mcp__crosstalk__use_helper_model");
    expect(first).not.toContain("--disallowedTools");
    expect(Object.keys(env(first)).filter((k) => k.startsWith("CROSSTALK_")).sort()).toEqual(["CROSSTALK_EXPOSE_APPROVE", "CROSSTALK_HELPER_MODEL", "CROSSTALK_HUB_SOCKET", "CROSSTALK_MEMBER_ID", "CROSSTALK_MEMBER_TOKEN", "CROSSTALK_TOOLSET"]);

    const other = h.chat({ helpers: { ...KEY, fallback: false } });
    h.send(other, "hello");
    await until(() => h.texts(other).some((t) => t.startsWith("agent: ") && t.length > 8), "the reply");
    await h.idle(other);
    const second = starts()[1];
    expect(arg(second, "--append-system-prompt")).toContain("Helper work in this chat is done by helpers on Claude API key");
    expect(arg(second, "--append-system-prompt")).not.toContain("Helper agents you start run on");
    expect(arg(second, "--allowedTools")).toBe("mcp__crosstalk__use_helper_model,mcp__crosstalk__start_helper,mcp__crosstalk__helper_result");
    expect(arg(second, "--disallowedTools")).toBe("Agent,Task,Workflow");
    expect(env(second).CROSSTALK_HELPERS).toBe("1");
  });

  test("a real helper process: Claude Code on the key account does the task and reports", async () => {
    const h = hub();
    const c = h.chat();
    real = true;
    const said = await h.tool(c.member, "start", { task: "Say hello.", name: "Hello" });
    expect(said.error).toBeUndefined();
    expect(said.text).toStartWith("Helper “Hello” on Claude API key finished in ");
    expect(h.rows(c)[0]).toMatchObject({ status: "completed", account: "Claude API key" });
  });

  test("the machine's default applies to new chats only, and never to a chat on that same account", async () => {
    const h = hub();
    const before = h.chat({ helpers: null });
    expect(h.app.setHubSettings({ helpers: KEY }).helpers).toEqual(KEY);
    const room = h.app.chats.create({ provider: "codex", name: "New", cwd: temp("ct-helpers-cwd-") });
    expect(helpersOf(h.app.chats.member(room.id)!.config)).toMatchObject({ provider: "claude", account: "key1" });
    const same = h.app.chats.create({ provider: "claude", account: "key1", name: "On the key", cwd: temp("ct-helpers-cwd-") });
    expect(helpersOf(h.app.chats.member(same.id)!.config)).toBeNull();
    expect(helpersOf(h.app.store.getMember(before.member.id)!.config)).toBeNull();
    // Asked for the agent's own helpers in New chat: the default doesn't apply.
    const asked = h.app.chats.create({ provider: "codex", name: "Own", cwd: temp("ct-helpers-cwd-"), helpers: null });
    expect(helpersOf(h.app.chats.member(asked.id)!.config)).toBeNull();
    expect(() => h.app.setHubSettings({ helpers: { provider: "claude", account: "gone" } })).toThrow("That account isn't on this machine any more");
    expect(h.app.setHubSettings({ helpers: null }).helpers).toBeUndefined();
  });

  test("a quick question goes to any account the person ticked, read-only, and is booked on that account", async () => {
    const h = hub();
    const c = h.chat({ helpers: null });
    // Nothing ticked: the other agent's main sign-in, through the tool named after it, as ever.
    h.app.setHubSettings({ teamwork: { ...h.app.hubSettings().teamwork, enabled: true } });
    h.app.providers.get = ((p: ChatProvider) => ({ installed: true, signedIn: true, provider: p })) as never;
    expect(h.app.chats.context(c.room, c.member).helper).toMatchObject({ provider: "codex" });
    // Ticked: the API key account and Codex; the chat's own account is never one of them.
    const tw = h.app.setHubSettings({ teamwork: { ...h.app.hubSettings().teamwork, who: [{ provider: "claude", account: "key1" }, { provider: "codex", account: DEFAULT_ACCOUNT }, { provider: "claude", account: DEFAULT_ACCOUNT }, { provider: "claude", account: "gone" }] } }).teamwork;
    expect(tw.who).toEqual([{ provider: "claude", account: "key1" }, { provider: "codex", account: DEFAULT_ACCOUNT }, { provider: "claude", account: DEFAULT_ACCOUNT }]);
    expect(askable(h.app, c.member).list).toEqual([
      { provider: "claude", account: "key1", handle: "claude-api-key", name: "Claude API key" },
      { provider: "codex", account: DEFAULT_ACCOUNT, handle: "codex", name: "Codex" },
    ]);
    const ctx = h.app.chats.context(c.room, c.member).helper!;
    expect(ctx.provider).toBe("agent");
    expect(ctx.note).toContain('The person lets you ask: Claude API key (who: "claude-api-key"), Codex (who: "codex").');
    helper = ({ ctx, sink }) => {
      sink.usage({ inputTokens: 900, outputTokens: 100, costUsd: 0.02 });
      return { ok: true, text: `Answer from ${ctx.member.config.account ?? "main"} (${ctx.member.permissionMode})` };
    };
    const call = async (body: Record<string, unknown>) => {
      const req = new Request("http://hub/internal/ask", { method: "POST", headers: { "x-crosstalk-member": c.member.id, "x-crosstalk-token": h.app.internalToken(c.member.id) }, body: JSON.stringify(body) });
      return ((await (await handleInternal(h.app, req, new URL(req.url))).json()) as { answer: string }).answer;
    };
    expect(await call({ question: "Is this safe?", who: "claude-api-key" })).toBe("(Claude API key · 1k tokens)\n\nAnswer from key1 (ask)");
    expect(h.app.store.db.query("SELECT provider, account, source, cost_usd, basis FROM spend_ledger").all()).toEqual([{ provider: "claude", account: "key1", source: "ask", cost_usd: 0.02, basis: "exact" }]);
    expect(await call({ question: "And this?", who: "nobody" })).toBe('There\'s nobody called "nobody" to ask. You can ask: Claude API key (who: "claude-api-key"), Codex (who: "codex").');
    expect(describeToolCall("mcp__crosstalk__ask_agent", { question: "Is this safe?", who: "codex" }).title).toBe("Asked codex: Is this safe?");
    // Back to "the other agent" when the choice is cleared.
    expect(h.app.setHubSettings({ teamwork: { ...h.app.hubSettings().teamwork, who: null as never } }).teamwork.who).toBeUndefined();
  });

  test("the words: account labels and step titles", () => {
    const all = [signin("claude"), apiKey("claude", "k1", "Work"), apiKey("claude", "k2", "Home"), apiKey("codex", "k3", "Key")];
    expect(helperAccountLabel(all[0], all)).toBe("Claude Code");
    expect(helperAccountLabel(all[1], all)).toBe("Claude API key (Work)");
    expect(helperAccountLabel(all[3], all)).toBe("OpenAI API key");
    expect(helperAccountLabel({ provider: "codex", id: "ep", label: "DeepSeek", kind: "endpoint" }, all)).toBe("DeepSeek");
    expect(helperAccountLabel({ provider: "codex", id: "work", label: "Work", kind: "signin" }, all)).toBe("Codex (Work)");
    expect(describeToolCall("mcp__crosstalk__start_helper", { task: "Run the tests and report", name: "Check the build" }, "Claude API key")).toEqual({ kind: "tool", title: "Started a helper on Claude API key: Check the build", detail: "Run the tests and report" });
    expect(describeToolCall("mcp__crosstalk__helper_result", {}).title).toBe("Waited for helpers");
  });
});
