// The spend ledger and limits (hub/src/spend.ts), through a real App whose Claude Code is the fake CLI (with scripted running
// totals) and whose other agent is the mock driver; never a real agent, a real price list or a real push.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountSpend, ServerEvent } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import type { AgentDriver, TurnSink } from "../src/agents/driver";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import { MockDriver } from "../src/agents/mock";
import { App } from "../src/app";
import { HttpError } from "../src/engine/engine";
import { priceTokens } from "../src/prices";
import type { PushNote } from "../src/push";
import type { Ctx } from "../src/routes";
import { buildRoutes } from "../src/server";
import { Spend, dayOf, isLocalHost, money } from "../src/spend";
import { processesEnding } from "../src/util/process";

const FIX = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
/** Every hub a test made, closed after it (a test that closes its own first is closed once). */
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
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

interface Row {
  id: number;
  at: number;
  day: string;
  provider: string;
  account: string;
  room_id: string | null;
  chat_name: string | null;
  turn_id: string | null;
  ask_id: string | null;
  source: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number | null;
  basis: string;
}

const ACCOUNTS = [
  { provider: "claude", id: "key1", label: "API key", kind: "apikey" },
  { provider: "codex", id: "key1", label: "API key", kind: "apikey" },
  { provider: "codex", id: "mine", label: "My Mac", kind: "endpoint", baseUrl: "http://127.0.0.1:8080", models: ["qwen3"] },
  { provider: "codex", id: "kimi", label: "Kimi", kind: "endpoint", baseUrl: "https://api.moonshot.ai", models: ["kimi-k2"] },
];
const PRICES = { "claude-sonnet-4-5": [3, 15, 0.3], "kimi-k2": [0.6, 2.5, null], "gpt-priced": [1.25, 10, 0.125] };
/** What fake-claude's usual reply (1500 tokens in, 300 of them cached, 80 out) costs on claude-sonnet-4-5 by the price list. */
const ESTIMATE = priceTokens([3, 15, 0.3], 1500, 80, 300);

/**
 * A hub with Claude Code as the fake CLI (`totals`: the running totals each new process reports, in turn) and Codex as the
 * mock driver (reports `costUsd` from the member's config for each reply, or none with `noCost`, as the real Codex does), prices
 * from a kept list, and pushes noted.
 */
function hub(opts: { totals?: string[][]; queue?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-spend-"));
  dirs.push(dir);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.store.kvSet("accounts", JSON.stringify(ACCOUNTS));
  app.store.kvSet("prices.cache", JSON.stringify({ "models.dev": { fetchedAt: Date.now(), table: PRICES } }));
  const scripts = [...(opts.totals ?? [])];
  registerDriver("claude", (ctx) => new ClaudeDriver({ ...ctx, env: { ...ctx.env, FAKE_CLAUDE_TOTALS: (scripts.shift() ?? []).join(","), ...(opts.queue ? { FAKE_CLAUDE_QUEUE: "1" } : {}) } }, join(FIX, "fake-claude")));
  registerDriver("codex", (ctx) => {
    const inner = new MockDriver(ctx);
    const quiet = (sink: TurnSink): TurnSink => ({ ...sink, usage: (u) => sink.usage({ ...u, costUsd: undefined }) });
    const noCost = !!(ctx.member.config as { noCost?: boolean }).noCost;
    return { provider: "codex", runTurn: (input, sink) => inner.runTurn(input, noCost ? quiet(sink) : sink), interrupt: () => inner.interrupt(), dispose: () => inner.dispose(), rewind: async () => [] } satisfies AgentDriver;
  });
  const pushes: PushNote[] = [];
  app.push.send = async (note) => {
    pushes.push(note);
    return { sent: 0, failed: 0 };
  };
  const events: ServerEvent[] = [];
  app.bus.on((e) => events.push(e));
  const chat = (provider: "claude" | "codex", account: string, config: Record<string, unknown> = {}, model = provider === "claude" ? "claude-sonnet-4-5" : "gpt-test") => {
    const room = app.chats.create({ provider, name: "Side project", cwd: dir, account, model });
    const member = app.chats.member(room.id)!;
    app.store.updateMember(member.id, { config: { ...member.config, delayMs: 20, ...config } });
    return room;
  };
  const say = async (roomId: string, text: string) => {
    app.engine.postHumanMessage(roomId, text, "Phone");
    await app.engine.whenIdle();
  };
  const rows = () => app.store.db.query("SELECT * FROM spend_ledger ORDER BY id").all() as Row[];
  const summary = (provider: string, account: string) => app.spend.accounts().find((a) => a.provider === provider && a.account === account) as AccountSpend;
  let closed = false;
  const done = async () => {
    if (closed) return;
    closed = true;
    await app.engine.shutdown();
    await processesEnding();
    // As App.shutdown does: no spend event is put off past the database's closing.
    app.spend.stop();
    app.store.close();
  };
  open.push(done);
  return { app, dir, chat, say, rows, summary, pushes, events, done };
}

const until = async (what: () => unknown, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) if (what()) return;
  throw new Error("timed out waiting");
};

const entry = (provider: string, account: string, costUsd: number | null, more: Record<string, unknown> = {}) =>
  ({ source: "ask" as const, provider, account, roomId: "r1", chatName: "Chat", askId: "a1", model: null, inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd, basis: costUsd === null ? ("unknown" as const) : ("exact" as const), ...more }) as Parameters<Spend["record"]>[0];

describe("what a reply cost", () => {
  test("Claude Code: the step between a process's totals is exact; the first reply of a process is estimated; a restart starts over", async () => {
    // The second process's first total (0.90) is above the first one's last (0.80): only the process knows it's a new one.
    const t = hub({ totals: [["0.50", "0.80"], ["0.90", "1.30"]] });
    try {
      const room = t.chat("claude", "key1");
      await t.say(room.id, "one");
      await t.say(room.id, "two");
      await t.app.engine.memberChanged(t.app.chats.member(room.id)!.id); // the process ends; the next reply starts another
      await t.say(room.id, "three");
      await t.say(room.id, "four");
      expect(t.rows().map((r) => [r.basis, r.cost_usd])).toEqual([["estimated", ESTIMATE], ["exact", 0.3], ["estimated", ESTIMATE], ["exact", 0.4]]);
      expect(t.rows()[0]).toMatchObject({ provider: "claude", account: "key1", source: "turn", model: "claude-sonnet-4-5", room_id: room.id, chat_name: "Side project", ask_id: null, input_tokens: 1500, output_tokens: 80, cached_tokens: 300 });
      expect(t.rows()[0].turn_id).toStartWith("t_");
      expect(t.rows()[0].day).toBe(dayOf(t.rows()[0].at));
      expect(t.app.spend.chatSpend(room.id)).toEqual({ roomId: room.id, usd: 0.70978, replies: 4, unpriced: 0, estimated: 2, byAccount: [{ provider: "claude", account: "key1", usd: 0.70978, replies: 4, unpriced: 0, estimated: 2 }] });
      expect(t.summary("claude", "key1")).toMatchObject({ kind: "apikey", label: "API key", today: { usd: 0.70978, replies: 4 }, month: { usd: 0.70978 }, total: { usd: 0.70978, inputTokens: 6000, outputTokens: 320 }, budget: null });
    } finally {
      await t.done();
    }
  });

  test("a total that goes down inside one process isn't a step: that reply is estimated, the next one carries on from the lower total", async () => {
    const t = hub({ totals: [["0.50", "0.20", "0.35"]] });
    try {
      const room = t.chat("claude", "key1");
      for (const text of ["one", "two", "three"]) await t.say(room.id, text);
      expect(t.rows().map((r) => [r.basis, r.cost_usd])).toEqual([["estimated", ESTIMATE], ["estimated", ESTIMATE], ["exact", 0.15]]);
    } finally {
      await t.done();
    }
  });

  test("\"Read it now\" gives one reply two results: it costs the step from before it to the last total, with the carried part counted once", async () => {
    // "hello" ends at 0.20; the long step is cut at 0.45 and the answer ends at 0.60: the reply cost 0.40.
    const t = hub({ queue: true, totals: [["0.20", "0.45", "0.60"]] });
    try {
      const room = t.chat("claude", "key1");
      await t.say(room.id, "hello");
      t.app.engine.postHumanMessage(room.id, "LONG_STEP: run the long check", "Phone");
      await until(() => t.app.store.listActivities(room.id, t.app.engine.runningTurns(room.id).map((x) => x.id)).some((a) => a.kind === "command" && a.status === "running"));
      t.app.engine.postHumanMessage(room.id, "also add tests", "Phone");
      expect(await t.app.engine.sendNow(room.id)).toBe(true);
      expect(await t.app.engine.readNow(room.id)).toBe(true);
      await t.app.engine.whenIdle();
      const rows = t.rows();
      expect(rows.map((r) => [r.basis, r.cost_usd])).toEqual([["estimated", priceTokens([3, 15, 0.3], 20, 6, 0)], ["exact", 0.4]]);
      expect(rows[1]).toMatchObject({ input_tokens: 60, output_tokens: 10 }); // both parts' tokens
      // What the turn keeps is unchanged: costUsd there is still the total plus the carried part, and nothing of the ledger's.
      const turn = t.app.store.listTurns(room.id, 10).find((x) => x.id === rows[1].turn_id)!;
      expect(turn.usage!.costUsd).toBeCloseTo(1.05, 6);
      expect(Object.keys(turn.usage!)).not.toContain("costTotalUsd");
    } finally {
      await t.done();
    }
  });

  test("a plan sign-in is notional (shown, never counted); a model with no price is unknown, not zero", async () => {
    const t = hub({ totals: [["0.50", "0.80"], ["0.50"]] });
    try {
      const plan = t.chat("claude", "default");
      await t.say(plan.id, "one");
      await t.say(plan.id, "two");
      expect(t.rows().map((r) => [r.basis, r.cost_usd])).toEqual([["plan", ESTIMATE], ["plan", 0.3]]);
      expect(t.summary("claude", "default")).toMatchObject({ kind: "signin", month: { usd: 0.30489 } });
      const mystery = t.chat("claude", "key1", {}, "mystery-model");
      await t.say(mystery.id, "one");
      expect(t.rows().at(-1)).toMatchObject({ basis: "unknown", cost_usd: null, model: "mystery-model" });
      expect(t.app.spend.chatSpend(mystery.id)).toEqual({ roomId: mystery.id, usd: 0, replies: 1, unpriced: 1, estimated: 0, byAccount: [{ provider: "claude", account: "key1", usd: 0, replies: 1, unpriced: 1, estimated: 0 }] });
      expect(t.summary("claude", "key1").month).toMatchObject({ usd: 0, replies: 1, unpriced: 1 });
    } finally {
      await t.done();
    }
  });

  test("an agent that reports each reply's cost is believed, except on a model server of the person's own", async () => {
    const t = hub();
    try {
      const keyed = t.chat("codex", "key1", { costUsd: 0.25 });
      await t.say(keyed.id, "one");
      const online = t.chat("codex", "kimi", { costUsd: 9 }, "kimi-k2");
      await t.say(online.id, "one");
      const local = t.chat("codex", "mine", { costUsd: 9 }, "qwen3");
      await t.say(local.id, "one");
      const [a, b, c] = t.rows();
      expect([a.basis, a.cost_usd]).toEqual(["exact", 0.25]);
      expect(b.basis).toBe("estimated"); // what Claude Code or Codex says about a model it may not know isn't taken as the price
      expect(b.cost_usd).toBe(priceTokens([0.6, 2.5, null], b.input_tokens, b.output_tokens, 0));
      expect([c.basis, c.cost_usd]).toEqual(["free", 0]);
    } finally {
      await t.done();
    }
  });

  test("an account's totals count its estimated replies, so Costs can mark them ≈: a Claude Code process's first reply and a Codex reply do; an exact one, an unpriced one and a plan's notional one don't", async () => {
    const t = hub({ totals: [["0.50", "0.80"], ["0.50"]] });
    try {
      // Claude Code on an API key: the first reply of its process has no total to step from (estimated), the second has (exact).
      const claude = t.chat("claude", "key1");
      await t.say(claude.id, "one");
      await t.say(claude.id, "two");
      expect(t.rows().map((r) => r.basis)).toEqual(["estimated", "exact"]);
      expect(t.summary("claude", "key1")).toMatchObject({ today: { replies: 2, estimated: 1 }, month: { replies: 2, estimated: 1 }, total: { replies: 2, estimated: 1 } });
      // Codex reports no cost, so its reply is worked out from its tokens (estimated); one that reports its own is exact, and one on a model with no price is unknown.
      await t.say(t.chat("codex", "key1", { noCost: true }, "gpt-priced").id, "one");
      await t.say(t.chat("codex", "key1", { costUsd: 0.25 }, "gpt-priced").id, "one");
      await t.say(t.chat("codex", "key1", { noCost: true }, "mystery-model").id, "one");
      expect(t.rows().slice(2).map((r) => r.basis)).toEqual(["estimated", "exact", "unknown"]);
      expect(t.summary("codex", "key1")).toMatchObject({ total: { replies: 3, unpriced: 1, estimated: 1 } });
      // An estimate from last month is in the total and not in today or this month.
      t.app.spend.record(entry("codex", "key1", 0.2, { basis: "estimated", at: Date.now() - 40 * 86_400_000 }));
      expect(t.summary("codex", "key1")).toMatchObject({ today: { replies: 3, estimated: 1 }, month: { replies: 3, estimated: 1 }, total: { replies: 4, estimated: 2 } });
      // A plan's figures are all notional (its kind says so), and an account with no replies yet has none to mark.
      await t.say(t.chat("claude", "default").id, "one");
      expect(t.summary("claude", "default")).toMatchObject({ kind: "signin", total: { replies: 1, estimated: 0 } });
      expect(t.summary("codex", "kimi")).toMatchObject({ total: { replies: 0, estimated: 0 } });
    } finally {
      await t.done();
    }
  });
});

describe("the ledger", () => {
  test("survives rewinding a chat and deleting it, and is made in its own table with no foreign keys", async () => {
    const t = hub();
    try {
      const room = t.chat("codex", "key1", { costUsd: 0.5 });
      await t.say(room.id, "first");
      await t.say(room.id, "second");
      const first = t.app.store.listMessages(room.id).find((m) => m.authorKind === "agent")!;
      expect(t.app.store.listTurns(room.id, 10)).toHaveLength(2);
      await t.app.rewindTo(first.id, "Phone");
      expect(t.app.store.listTurns(room.id, 10)).toHaveLength(1); // the second reply's turn left with its message
      expect(t.app.spend.chatSpend(room.id)).toMatchObject({ usd: 1, replies: 2 });
      await t.app.deleteRoom(room.id);
      expect(t.app.store.listTurns(room.id, 10)).toHaveLength(0);
      expect(t.app.spend.chatSpend(room.id)).toEqual({ roomId: room.id, usd: 1, replies: 2, unpriced: 0, estimated: 0, byAccount: [{ provider: "codex", account: "key1", usd: 1, replies: 2, unpriced: 0, estimated: 0 }] });
      expect(t.summary("codex", "key1")).toMatchObject({ kind: "apikey", today: { usd: 1, replies: 2 }, month: { usd: 1 }, total: { usd: 1 } });
      expect(t.rows().every((r) => r.chat_name === "Side project")).toBe(true);
      const db = t.app.store.db;
      expect(db.query("PRAGMA foreign_key_list(spend_ledger)").all()).toEqual([]);
      expect((db.query("PRAGMA index_list(spend_ledger)").all() as { name: string }[]).map((i) => i.name)).toEqual(expect.arrayContaining(["spend_ledger_at", "spend_ledger_account"]));
    } finally {
      await t.done();
    }
  });

  test("plan sign-ins are notional, models on this machine are free, unpriced replies are counted as such, removed accounts still show, asks count with their chat", () => {
    const t = hub();
    const spend = t.app.spend;
    const base = { model: "kimi-k2", inputTokens: 1000, outputTokens: 100 };
    spend.record(entry("claude", "default", 0.2, base)); // a plan sign-in
    spend.record(entry("codex", "mine", 0.3, { ...base, basis: "estimated" })); // on this machine
    spend.record(entry("codex", "kimi", null, base)); // online, no price
    spend.record(entry("codex", "gone", 1, { ...base, roomId: "r2" })); // an account since removed
    expect(t.rows().map((r) => [r.account, r.basis, r.cost_usd])).toEqual([["default", "plan", 0.2], ["mine", "free", 0], ["kimi", "unknown", null], ["gone", "plan", 1]]);
    expect(t.summary("claude", "default")).toMatchObject({ kind: "signin", label: "Main", month: { usd: 0.2 } });
    expect(t.summary("codex", "mine")).toMatchObject({ kind: "endpoint", label: "My Mac", month: { usd: 0, replies: 1, unpriced: 0 } });
    expect(t.summary("codex", "kimi")).toMatchObject({ kind: "endpoint", label: "Kimi", month: { usd: 0, replies: 1, unpriced: 1 } });
    expect(t.summary("codex", "gone")).toMatchObject({ kind: "signin", label: "Codex (removed)", total: { usd: 1 } });
    expect(spend.chatSpend("r1")).toEqual({
      roomId: "r1",
      usd: 0.2,
      replies: 3,
      unpriced: 1,
      estimated: 1, // the plan's notional figure counts as one to show "≈" for
      // Each account's part, said in its own words: a group chat's agents can be billed differently.
      byAccount: [
        { provider: "claude", account: "default", usd: 0.2, replies: 1, unpriced: 0, estimated: 1 },
        { provider: "codex", account: "kimi", usd: 0, replies: 1, unpriced: 1, estimated: 0 },
        { provider: "codex", account: "mine", usd: 0, replies: 1, unpriced: 0, estimated: 0 },
      ],
    });
    expect(spend.chatSpend("nobody")).toEqual({ roomId: "nobody", usd: 0, replies: 0, unpriced: 0, estimated: 0, byAccount: [] });
    // The API-key and model-server accounts are listed even before they've cost anything, first.
    expect(spend.accounts().map((a) => `${a.provider}:${a.account}`).slice(0, 4)).toEqual(["claude:key1", "codex:key1", "codex:kimi", "codex:mine"]);
    // What a price list says a reply cost, and nothing when it says nothing.
    const asked = { provider: "codex" as const, account: "kimi", inputTokens: 1000, outputTokens: 100, cachedTokens: 0 };
    expect(spend.priceReply({ ...asked, model: "kimi-k2" })).toEqual({ costUsd: 0.00085, basis: "estimated" });
    expect(spend.priceReply({ ...asked, model: "mystery" })).toEqual({ costUsd: null, basis: "unknown" });
    expect(spend.priceReply({ ...asked, model: null })).toEqual({ costUsd: null, basis: "unknown" });
  });

  test("an account that was removed is shown as what its replies were billed as: a rotated key's spend isn't a plan sign-in's", () => {
    const t = hub();
    const spend = t.app.spend;
    const extra = [
      { provider: "codex", id: "old", label: "Old key", kind: "apikey" },
      { provider: "codex", id: "nokey", label: "Unpriced key", kind: "apikey" },
      { provider: "codex", id: "lan", label: "Studio", kind: "endpoint", baseUrl: "http://192.168.1.5:8080", models: ["qwen3"] },
      { provider: "claude", id: "work", label: "Work plan" },
    ];
    t.app.store.kvSet("accounts", JSON.stringify([...ACCOUNTS, ...extra]));
    spend.record(entry("codex", "old", 0.25)); // exact
    spend.record(entry("codex", "old", 0.1, { basis: "estimated" }));
    spend.record(entry("codex", "nokey", null)); // no price known
    spend.record(entry("codex", "lan", 0.3, { basis: "estimated" })); // free: a model server on this network
    spend.record(entry("claude", "work", 2)); // a plan's notional figure
    spend.setBudget("codex", "old", { limitUsd: 5 });
    const shown = () => Object.fromEntries(extra.map((a) => [a.id, spend.accounts().find((s) => s.provider === a.provider && s.account === a.id)!]));
    expect(Object.values(shown()).map((a) => [a.kind, a.label])).toEqual([["apikey", "Old key"], ["apikey", "Unpriced key"], ["endpoint", "Studio"], ["signin", "Work plan"]]);
    // Removed (as removeAccount does it): the history stays, and so does what it says each one was.
    t.app.store.kvSet("accounts", JSON.stringify(ACCOUNTS));
    const gone = shown();
    expect(gone.old).toMatchObject({ kind: "apikey", label: "Codex (removed)", total: { usd: 0.35, replies: 2, estimated: 1 }, budget: null }); // its limit isn't shown: nothing can change it now
    expect(gone.nokey).toMatchObject({ kind: "apikey", label: "Codex (removed)", total: { usd: 0, replies: 1, unpriced: 1 } });
    expect(gone.lan).toMatchObject({ kind: "endpoint", label: "Codex (removed)", total: { usd: 0, replies: 1 } });
    expect(gone.work).toMatchObject({ kind: "signin", label: "Claude Code (removed)", total: { usd: 2, replies: 1 } });
  });

  test("the spend event goes out at most every few seconds, and the last change always goes out", async () => {
    const t = hub();
    const spend = new Spend(t.app, { emitEveryMs: 60 });
    const seen = () => t.events.filter((e): e is Extract<ServerEvent, { t: "spend" }> => e.t === "spend");
    const month = (e: { accounts: AccountSpend[] }) => e.accounts.find((a) => a.provider === "claude" && a.account === "key1")!.month.usd;
    for (let i = 0; i < 3; i++) spend.record(entry("claude", "key1", 1));
    expect(seen()).toHaveLength(1);
    expect(month(seen()[0])).toBe(1); // the first goes at once
    await Bun.sleep(150);
    expect(seen()).toHaveLength(2);
    expect(month(seen()[1])).toBe(3); // the one after carries all three
  });

  test("stopped (the hub shutting down), the spend event that was put off goes out at once, and nothing is put off after", async () => {
    const t = hub();
    const spend = new Spend(t.app, { emitEveryMs: 100 });
    const seen = () => t.events.filter((e): e is Extract<ServerEvent, { t: "spend" }> => e.t === "spend");
    spend.record(entry("claude", "key1", 1));
    spend.record(entry("claude", "key1", 1)); // put off: within the moment after the first
    expect(seen()).toHaveLength(1);
    spend.stop();
    expect(seen()).toHaveLength(2);
    // A reply booked while the hub stops is still in the ledger, but no event is put off past the database's closing.
    spend.record(entry("claude", "key1", 1));
    await Bun.sleep(200);
    expect(seen()).toHaveLength(2);
    expect(t.rows()).toHaveLength(3);
  });

  test("App.shutdown sends the spend event that was put off before it closes the database", async () => {
    // Its timer used to outlive the shutdown: the event never went, and "spend event: Cannot use a closed database" was logged.
    const dir = mkdtempSync(join(tmpdir(), "ct-spend-stop-"));
    dirs.push(dir);
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    app.store.kvSet("accounts", JSON.stringify(ACCOUNTS));
    const events: ServerEvent[] = [];
    app.bus.on((e) => events.push(e));
    const seen = () => events.filter((e): e is Extract<ServerEvent, { t: "spend" }> => e.t === "spend");
    app.spend.record(entry("claude", "key1", 1));
    app.spend.record(entry("claude", "key1", 1)); // put off: within the few seconds after the first
    expect(seen()).toHaveLength(1);
    await app.shutdown();
    expect(seen()).toHaveLength(2);
    expect(seen()[1].accounts.find((a) => a.provider === "claude" && a.account === "key1")!.month.usd).toBe(2);
  });
});

describe("limits", () => {
  test("a reply that would start over the limit doesn't: the sentence says so, nothing is billed, and Try again works once it's raised", async () => {
    const t = hub();
    try {
      const room = t.chat("codex", "key1", { costUsd: 0.6 });
      t.app.spend.setBudget("codex", "key1", { limitUsd: 1 });
      await t.say(room.id, "one");
      expect(t.app.spend.checkBudget("codex", "key1")).toBeNull(); // $0.60 of $1.00
      expect(t.pushes).toHaveLength(0);
      await t.say(room.id, "two"); // $1.20: the reply that crossed it wasn't cut
      const refusal = "API key reached its $1.00 limit, so this reply didn't start.";
      expect(t.app.spend.checkBudget("codex", "key1")).toBe(refusal);
      expect(t.pushes.map((p) => p.body)).toEqual(["API key has used $1.20 of its $1.00 limit."]);
      await t.say(room.id, "three");
      const reply = t.app.store.listMessages(room.id).at(-1)!;
      expect(reply).toMatchObject({ authorKind: "agent", status: "error", text: refusal });
      expect(t.app.store.listTurns(room.id, 10).find((x) => x.status === "error")).toMatchObject({ error: refusal });
      expect(t.rows()).toHaveLength(2); // nothing was recorded for it
      expect(t.pushes).toHaveLength(1); // and nobody was told again
      expect(t.summary("codex", "key1").budget).toMatchObject({ limitUsd: 1, period: "month", usedUsd: 1.2, state: "stopped" });
      // The limit is the account's, not the chat's: another chat on the same key is held too.
      const other = t.chat("codex", "key1", { costUsd: 0.6 });
      await t.say(other.id, "hello");
      expect(t.app.store.listMessages(other.id).at(-1)).toMatchObject({ authorKind: "agent", status: "error", text: refusal });
      // Raise the limit, then Try again.
      t.app.spend.setBudget("codex", "key1", { limitUsd: 5 });
      t.app.engine.retry(room.id);
      await t.app.engine.whenIdle();
      expect(t.rows()).toHaveLength(3);
      expect(t.app.store.listMessages(room.id).at(-1)).toMatchObject({ authorKind: "agent", status: "done" });
      expect(t.summary("codex", "key1").budget).toMatchObject({ usedUsd: 1.8, state: "ok" });
    } finally {
      await t.done();
    }
  });

  test("the 80% warning goes out once for each limit and period, and a new month counts from nothing", () => {
    const t = hub();
    let clock = new Date(2026, 9, 15, 12, 0).getTime();
    const spend = new Spend(t.app, { now: () => clock });
    const add = (usd: number) => spend.record(entry("claude", "key1", usd));
    const key1 = () => spend.accounts().find((a) => a.provider === "claude" && a.account === "key1")!;
    spend.setBudget("claude", "key1", { limitUsd: 100 });
    add(50);
    expect(t.pushes).toHaveLength(0);
    add(35); // 85%
    expect(t.pushes.map((p) => [p.title, p.body])).toEqual([["Nearing a spending limit", "API key has used $85.00 of its $100 limit."]]);
    add(5); // 90%: this month's warning has gone
    expect(t.pushes).toHaveLength(1);
    add(10); // 100%: reaching the limit is a push of its own (see the next test)
    expect(spend.checkBudget("claude", "key1")).toBe("API key reached its $100 limit, so this reply didn't start.");
    expect(t.pushes.map((p) => p.title)).toEqual(["Nearing a spending limit", "Spending limit reached"]);
    // The first of the next month: counted from nothing; "today" is only today's.
    clock = new Date(2026, 10, 1, 0, 10).getTime();
    expect(spend.checkBudget("claude", "key1")).toBeNull();
    expect(key1()).toMatchObject({ today: { usd: 0 }, month: { usd: 0 }, total: { usd: 100, replies: 4 }, budget: { usedUsd: 0, percent: 0, state: "ok" } });
    add(75);
    expect(t.pushes).toHaveLength(2);
    add(10); // 85% of November
    expect(t.pushes).toHaveLength(3);
    expect(t.pushes.at(-1)!.title).toBe("Nearing a spending limit");
    expect(key1()).toMatchObject({ today: { usd: 85 }, month: { usd: 85 }, total: { usd: 185 }, budget: { state: "warn" } });
    // A different limit is a different warning: it comes again once the new limit is near.
    spend.setBudget("claude", "key1", { limitUsd: 200 });
    add(80); // 165 of 200
    expect(t.pushes).toHaveLength(4);
    // A limit on the total counts from when it was set, and keeps that start when only the amount changes.
    clock += 1000;
    const total = spend.setBudget("claude", "key1", { limitUsd: 50, period: "total" }).budget!;
    expect(total).toMatchObject({ period: "total", since: clock, usedUsd: 0 });
    clock += 1000;
    add(30);
    expect(spend.setBudget("claude", "key1", { limitUsd: 80 }).budget).toMatchObject({ period: "total", since: total.since, usedUsd: 30, limitUsd: 80 });
    expect(spend.checkBudget("claude", "key1")).toBeNull();
    add(50);
    expect(spend.checkBudget("claude", "key1")).toBe("API key reached its $80.00 limit, so this reply didn't start.");
  });

  // Until 0.6.2 `warn()` kept one kv mark per account and period (WARNED_KEY held the period name, not the threshold), so
  // once 80% had warned this month nothing more went out — the "Spending limit reached" title it works out for a stopped
  // limit could only ever be sent by a single reply that jumps from under 80% to over 100%. The moment that matters most
  // (replies are refused from now on) reached a phone that isn't looking at the app with no notification at all.
  // docs/SPEC-0.4.md asks for one "once per threshold and period".
  test("reaching the limit is a push of its own, even when 80% already warned in the same period", () => {
    const t = hub();
    const clock = new Date(2026, 9, 15, 12, 0).getTime();
    const spend = new Spend(t.app, { now: () => clock });
    const add = (usd: number) => spend.record(entry("claude", "key1", usd));
    spend.setBudget("claude", "key1", { limitUsd: 100 });
    add(85); // 85%: nearing it
    expect(t.pushes.map((p) => p.title)).toEqual(["Nearing a spending limit"]);
    add(20); // 105%: from here every new reply on this account is refused
    expect(spend.checkBudget("claude", "key1")).toBe("API key reached its $100 limit, so this reply didn't start.");
    // Whole dollars from $100, as `money()` (and the app's usd()) writes every amount: "$105", like the "$100" beside it.
    expect(t.pushes.map((p) => [p.title, p.body])).toEqual([
      ["Nearing a spending limit", "API key has used $85.00 of its $100 limit."],
      ["Spending limit reached", "API key has used $105 of its $100 limit."],
    ]);
    // Once is enough: the replies it refuses from here push nothing more.
    add(1);
    expect(t.pushes).toHaveLength(2);
  });

  test("a hub updated in the middle of a month doesn't push 80% again, and still says when the limit is reached", () => {
    const t = hub();
    const clock = new Date(2026, 9, 15, 12, 0).getTime();
    const spend = new Spend(t.app, { now: () => clock });
    spend.setBudget("claude", "key1", { limitUsd: 100 });
    // What a hub before 0.6.2 kept once its 80% push had gone out this month: the month's name alone.
    t.app.store.kvSet("spend.warned", JSON.stringify({ "claude:key1": "2026-10" }));
    spend.record(entry("claude", "key1", 90));
    expect(t.pushes).toHaveLength(0);
    spend.record(entry("claude", "key1", 15));
    expect(t.pushes.map((p) => p.title)).toEqual(["Spending limit reached"]);
  });

  test("nothing is posted in any chat when a limit warns, and plan sign-ins are never held to one", async () => {
    const t = hub();
    try {
      const room = t.chat("codex", "key1", { costUsd: 0.85 });
      t.app.spend.setBudget("codex", "key1", { limitUsd: 1 });
      const before = t.app.store.listMessages(room.id).length;
      await t.say(room.id, "one");
      expect(t.pushes).toHaveLength(1);
      expect(t.app.store.listMessages(room.id).filter((m) => m.authorKind === "system")).toHaveLength(0);
      expect(t.app.store.listMessages(room.id)).toHaveLength(before + 2); // the message and its reply, nothing else
      expect(t.events.some((e) => e.t === "spend" && e.accounts.some((a) => a.budget?.state === "warn"))).toBe(true);
      expect(t.app.spend.checkBudget("claude", "default")).toBeNull();
    } finally {
      await t.done();
    }
  });
});

describe("routes", () => {
  async function call(app: App, method: string, path: string, body?: unknown) {
    for (const r of buildRoutes(app)) {
      const m = r.method === method ? r.pattern.exec(path) : null;
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      try {
        return { status: 200, body: (await r.handler({ params, body: async () => body ?? {} } as unknown as Ctx)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      } catch (e) {
        if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
        throw e;
      }
    }
    return { status: 404, body: null };
  }

  test("GET /api/spend and /api/rooms/:id/spend", async () => {
    const t = hub();
    try {
      const empty = await call(t.app, "GET", "/api/spend");
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ prices: { source: expect.any(String), fetchedAt: expect.any(Number) }, updatedAt: expect.any(Number) });
      expect(empty.body.accounts.map((a: AccountSpend) => `${a.provider}:${a.account}`)).toEqual(["claude:key1", "codex:key1", "codex:kimi", "codex:mine"]);
      t.app.spend.record(entry("claude", "key1", 0.5, { roomId: "r7" }));
      expect((await call(t.app, "GET", "/api/rooms/r7/spend")).body).toEqual({ roomId: "r7", usd: 0.5, replies: 1, unpriced: 0, estimated: 0, byAccount: [{ provider: "claude", account: "key1", usd: 0.5, replies: 1, unpriced: 0, estimated: 0 }] });
      expect((await call(t.app, "GET", "/api/rooms/nobody/spend")).body).toEqual({ roomId: "nobody", usd: 0, replies: 0, unpriced: 0, estimated: 0, byAccount: [] });
    } finally {
      await t.done();
    }
  });

  test("PUT /api/spend/budgets/:provider/:account takes an amount above zero or null, and only for an API key or a model server", async () => {
    const t = hub();
    try {
      const put = (provider: string, account: string, body: unknown) => call(t.app, "PUT", `/api/spend/budgets/${provider}/${account}`, body);
      for (const bad of [{ limitUsd: 0 }, { limitUsd: -5 }, { limitUsd: "250" }, { limitUsd: true }, JSON.parse('{"limitUsd":1e999}'), {}, { limitUsd: 5, period: "week" }]) {
        const r = await put("claude", "key1", bad);
        expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
      }
      expect((await put("claude", "default", { limitUsd: 5 })).status).toBe(400); // a plan sign-in isn't billed for each reply
      expect((await put("claude", "default", { limitUsd: 5 })).body.error).toContain("plan sign-in");
      expect((await put("claude", "nope", { limitUsd: 5 })).status).toBe(404);
      expect((await put("nothing", "key1", { limitUsd: 5 })).status).toBe(404);
      expect(t.app.store.kvGet("spend.budgets")).toBeNull(); // none of that was kept
      const set = await put("claude", "key1", { limitUsd: 250 });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ provider: "claude", account: "key1", budget: { limitUsd: 250, period: "month", usedUsd: 0, percent: 0, state: "ok" } });
      expect((await put("claude", "key1", { limitUsd: 400, period: "total" })).body.budget).toMatchObject({ limitUsd: 400, period: "total" });
      expect((await put("claude", "key1", { limitUsd: 500 })).body.budget).toMatchObject({ limitUsd: 500, period: "total" }); // the period stays
      expect((await call(t.app, "GET", "/api/spend")).body.accounts.find((a: AccountSpend) => a.account === "key1" && a.provider === "claude").budget.limitUsd).toBe(500);
      const removed = await put("claude", "key1", { limitUsd: null });
      expect(removed.body.budget).toBeNull();
      expect(JSON.parse(t.app.store.kvGet("spend.budgets")!)).toEqual({});
      expect(t.app.spend.checkBudget("claude", "key1")).toBeNull();
    } finally {
      await t.done();
    }
  });

  test("Look up prices online is a hub setting that's on unless it's switched off", () => {
    const t = hub();
    expect(t.app.hubSettings().priceLookup).toBeUndefined(); // absent: on
    expect(t.app.setHubSettings({ priceLookup: false }).priceLookup).toBe(false);
    expect(t.app.hubSettings().priceLookup).toBe(false);
    expect(t.app.setHubSettings({ priceLookup: true }).priceLookup).toBe(true);
  });
});

describe("helpers", () => {
  test("money reads like the app's: cents below $100, whole dollars from there", () => {
    expect([money(250), money(200.2), money(47.2), money(1235), money(1), money(0.005)]).toEqual(["$250", "$200", "$47.20", "$1,235", "$1.00", "$0.01"]);
  });

  test("a model server on this machine or its own network is the person's own; an address on the internet isn't", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "192.168.1.20", "10.0.0.2", "172.20.1.1", "100.100.1.2", "gpu-box", "mac.local", "pc.tail1234.ts.net", "169.254.1.1", "fd12::1"]) expect([host, isLocalHost(host)]).toEqual([host, true]);
    for (const host of ["api.moonshot.ai", "openrouter.ai", "8.8.8.8", "172.32.0.1", "100.128.0.1", "generativelanguage.googleapis.com"]) expect([host, isLocalHost(host)]).toEqual([host, false]);
  });
});
