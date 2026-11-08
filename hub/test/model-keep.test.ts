// A chat keeps the model and effort its person picked on every start of its agent: the resume after its idle process
// was ended, the carry-on after a usage limit, and a Claude Code that comes up on another model by itself. And a change
// of the chat's model is never silent (a change made while a workflow runs takes effect later, and must be said in the
// chat when it does).
// Everything here runs the fake Claude Code (fixtures/fake-claude): never the real one, whose model check costs money.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, BackgroundTask, Member, Room } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import { ClaudeDriver } from "../src/agents/claude";
import type { ActivityInput, AgentDriver, DriverContext, TurnResult, TurnSink } from "../src/agents/driver";
import { newId } from "../src/util/ids";
import { App } from "../src/app";
import { registerDriver } from "../src/agents";

const FIX = join(import.meta.dir, "fixtures");
const FAKE = join(FIX, "fake-claude");
const dirs: string[] = [];
const inUse = ClaudeDriver.sessionsInUse;
beforeAll(() => {
  // No `ps` for sessions open in the Claude app: these are the fake's.
  ClaudeDriver.sessionsInUse = () => new Set();
});
afterAll(() => {
  ClaudeDriver.sessionsInUse = inUse;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `ct-keep-${name}-`));
  dirs.push(dir);
  return dir;
};
const jsonLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await Bun.sleep(10);
  expect(ok()).toBe(true);
};

/** The fake Claude Code's line for a reply that went through (its default answer). */
const ANSWER = "Looking at the files.\n\nDone. @codex please review.";
/** The 0.4-era pin left from a start that came up on Opus 5: the old code passed it as --model on every later start. */
const STALE_PIN = { model: "claude-opus-5", modelRequested: "claude-opus-5-5" };

/** A one-agent chat on Claude Code (the fake), set to Opus 5.5 at max effort. */
function chat(opts: { env?: Record<string, string>; clock?: { now: number }; member?: Partial<Member> } = {}) {
  const dir = scratch("chat");
  const files = { args: join(dir, "args.jsonl"), inputs: join(dir, "inputs.jsonl") };
  const store = new Store(":memory:");
  const engine = new Engine({
    store,
    bus: new Bus(),
    idleEndMs: 150,
    createDriver: (ctx) => new ClaudeDriver({ ...ctx, env: { PATH: process.env.PATH ?? "", FAKE_CLAUDE_ARGS_OUT: files.args, FAKE_CLAUDE_INPUT_OUT: files.inputs, ...opts.env } }, FAKE),
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    ...(opts.clock ? { now: () => opts.clock!.now } : {}),
  });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "Feature work", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
  const member: Member = { id: newId("mb"), roomId: room.id, handle: "claude", provider: "claude", model: "claude-opus-5-5", role: "", permissionMode: "full", status: "idle", statusDetail: null, config: { effort: "max" }, createdAt: now, position: 0, ...opts.member };
  store.insertMember(member);
  const starts = () => jsonLines<string[]>(files.args);
  const turns = () => store.listTurns(room.id);
  const session = () => store.getMemberSession<Record<string, unknown>>(member.id);
  const say = async (text: string) => {
    engine.postHumanMessage(room.id, text, "iPhone");
    await Bun.sleep(5);
    await engine.whenIdle();
  };
  /** The agent's process is ended for having nothing to do (Engine.endIdle, 150 ms here): its next message resumes the session. */
  const idleEnded = async (count: number) => {
    await Bun.sleep(500);
    expect(starts().length).toBe(count);
  };
  return { dir, files, store, engine, room, member, starts, turns, session, say, idleEnded, inputs: () => jsonLines<string>(files.inputs) };
}

describe("every start and resume runs the chat's own model and effort", () => {
  test("a resume after the idle process was ended starts on the chat's model, never on a model an earlier start pinned", async () => {
    const t = chat();
    try {
      await t.say("hello");
      expect(t.starts()).toHaveLength(1);
      expect(flag(t.starts()[0], "--model")).toBe("claude-opus-5-5");
      expect(flag(t.starts()[0], "--effort")).toBe("max");
      expect(t.session()).toMatchObject({ sessionId: "11111111-2222-3333-4444-555555555555", model: "claude-opus-5-5", modelRequested: "claude-opus-5-5" });
      // Ended while idle (after minutes in a real hub; a moment here).
      await t.idleEnded(1);
      // What the hub kept from a start that came up on Opus 5 (the pin the old code put on the command line).
      t.store.setMemberSession(t.member.id, { ...t.session(), ...STALE_PIN });
      await t.say("Add a retry to the upload step");
      const resumed = t.starts()[1];
      expect(t.starts()).toHaveLength(2);
      expect(flag(resumed, "--resume")).toBe("11111111-2222-3333-4444-555555555555");
      expect(flag(resumed, "--model")).toBe("claude-opus-5-5");
      expect(flag(resumed, "--effort")).toBe("max");
      expect(t.turns().every((x) => x.status === "done")).toBe(true);
      // The pin is the chat's model again.
      expect(t.session()).toMatchObject({ model: "claude-opus-5-5", modelRequested: "claude-opus-5-5" });
    } finally {
      await t.engine.shutdown();
    }
  });

  test("a carry-on after a usage limit resumes on the chat's model and effort", async () => {
    const clock = { now: Date.now() };
    // The first start's replies hit the 5-hour limit; later starts go through.
    const t = chat({ clock, env: { FAKE_CLAUDE_RUN_LIMITS: "1" } });
    try {
      await t.say("Test every feature again");
      const waited = t.turns().at(-1)!;
      expect(waited.status).toBe("waiting");
      expect(waited.wait).toMatchObject({ label: "5-hour" });
      // The waiting chat's process is ended while idle, as it is during a long wait.
      await t.idleEnded(1);
      t.store.setMemberSession(t.member.id, { ...t.session(), ...STALE_PIN });
      // The reset comes: Crosstalk carries on by itself.
      clock.now = waited.wait!.runAt;
      t.engine.checkWaits();
      await Bun.sleep(5);
      await t.engine.whenIdle();
      await until(() => t.turns().at(-1)!.status === "done");
      const carried = t.starts()[1];
      expect(t.starts()).toHaveLength(2);
      expect(flag(carried, "--resume")).toBe("11111111-2222-3333-4444-555555555555");
      expect(flag(carried, "--model")).toBe("claude-opus-5-5");
      expect(flag(carried, "--effort")).toBe("max");
      expect(t.store.getMessage(t.turns().at(-1)!.replyMessageId!)?.text).toBe(ANSWER);
    } finally {
      await t.engine.shutdown();
    }
  });

  test('"Default" and an alias keep the model they meant when the chat began; a pin from another choice is never used', async () => {
    const alias = chat({ member: { model: "opus" } });
    try {
      alias.store.setMemberSession(alias.member.id, { sessionId: "11111111-2222-3333-4444-555555555555", model: "claude-opus-5-5", modelRequested: "opus" });
      await alias.say("hello");
      expect(flag(alias.starts()[0], "--model")).toBe("claude-opus-5-5");
      expect(flag(alias.starts()[0], "--effort")).toBe("max");
    } finally {
      await alias.engine.shutdown();
    }
    // Kept for another choice (a model picked before the person picked Opus): Claude Code says what "opus" is now.
    const other = chat({ member: { model: "opus" }, env: { FAKE_CLAUDE_INIT_MODEL: "claude-opus-5-5" } });
    try {
      other.store.setMemberSession(other.member.id, { sessionId: "11111111-2222-3333-4444-555555555555", model: "claude-opus-4-8", modelRequested: "claude-opus-4-8" });
      await other.say("hello");
      expect(flag(other.starts()[0], "--model")).toBe("opus");
      expect(other.session()).toMatchObject({ model: "claude-opus-5-5", modelRequested: "opus" });
    } finally {
      await other.engine.shutdown();
    }
  });
});

describe("a Claude Code that comes up on another model is stopped before it answers", () => {
  test("the reply stops at once, saying why and what to do; nothing it came up on is kept; it isn't started again on the same check", async () => {
    // The first start comes up on Opus 5 (as when Claude Code runs its default in place of a model this account can't use).
    const t = chat({ env: { FAKE_CLAUDE_RUN_MODELS: "claude-opus-5," } });
    try {
      await t.say("Add a retry to the upload step");
      // One start, by name: starting again with the same --model would only repeat Claude Code's paid check and fail the same way.
      expect(t.starts()).toHaveLength(1);
      expect(flag(t.starts()[0], "--model")).toBe("claude-opus-5-5");
      expect(t.inputs()).toEqual(["Add a retry to the upload step"]);
      const turn = t.turns().at(-1)!;
      expect(turn.status).toBe("error");
      expect(turn.error).toBe("Claude Code started on Opus 5 instead of Opus 5.5, this chat's model, so Crosstalk stopped it before it answered. This account can't use Opus 5.5 right now. Pick another model in the model menu.");
      // Opus 5 was never kept as the chat's model, and the message is still the person's (unread), for Try again.
      expect(t.session().model).toBeUndefined();
      expect(t.store.getLastSeen(t.member.id).seq).toBe(0);
      // Once the account can use it again (or another model is picked), the next message starts on the chat's model.
      await t.say("hello again");
      expect(t.starts()).toHaveLength(2);
      expect(flag(t.starts()[1], "--model")).toBe("claude-opus-5-5");
      expect(t.turns().at(-1)!.status).toBe("done");
      expect(t.session().model).toBe("claude-opus-5-5");
    } finally {
      await t.engine.shutdown();
    }
  });

  function sink() {
    const abort = new AbortController();
    const rec = { activities: [] as ActivityInput[], session: {} as Record<string, unknown> };
    const s: TurnSink = {
      signal: abort.signal,
      text: () => {},
      setText: () => {},
      activity: (a) => (rec.activities.push(a), `a${rec.activities.length}`),
      updateActivity: () => {},
      approval: async () => "approve" as ApprovalDecision,
      usage: () => {},
      rateLimit: () => {},
      status: () => {},
      saveSession: (p) => Object.assign(rec.session, p),
    };
    return { sink: s, rec };
  }

  function driver(name: string, env: Record<string, string>, chat: DriverContext["chat"] = { helper: null, notes: null }) {
    const dir = scratch(name);
    const files = { args: join(dir, "args.jsonl"), inputs: join(dir, "inputs.jsonl") };
    const room: Room = { id: "r1", name: "Chat", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
    const member: Member = { id: "m1", roomId: "r1", handle: "claude", provider: "claude", model: "claude-opus-5-5", role: "", permissionMode: "full", status: "idle", statusDetail: null, config: { effort: "max" }, createdAt: 0, position: 0 };
    const ctx: DriverContext = { room, member, session: {}, mcp: { command: "true", args: [], env: {} }, env: { PATH: process.env.PATH ?? "", FAKE_CLAUDE_ARGS_OUT: files.args, FAKE_CLAUDE_INPUT_OUT: files.inputs, ...env }, bin: FAKE, chat };
    return { d: new ClaudeDriver(ctx, FAKE), inputs: () => jsonLines<string>(files.inputs), starts: () => jsonLines<string[]>(files.args) };
  }

  test("an ask on a model this account can't use says it was the model you picked, not the chat's", async () => {
    const { d } = driver("ask", { FAKE_CLAUDE_RUN_MODELS: "claude-opus-5" }, { helper: null, notes: null, ephemeral: true });
    try {
      const r = await d.runTurn({ turnId: "t1", prompt: "What do you think of this?", systemNote: null }, sink().sink);
      expect(r).toEqual({ ok: false, error: "Claude Code started on Opus 5 instead of Opus 5.5, the model you picked, so Crosstalk stopped it before it answered. This account can't use Opus 5.5 right now. Pick another model." });
    } finally {
      await d.dispose();
    }
  });

  test("a message put in with Send now before Claude Code's init isn't handed to a process that may be ended for its model: it waits for the next reply", async () => {
    const t = driver("early", { FAKE_CLAUDE_RUN_MODELS: "claude-opus-5," });
    try {
      // The reply starts a new process; before its init says which model it's on, Send now is tapped for a second message.
      const first = t.d.runTurn({ turnId: "t1", prompt: "first message", systemNote: null, messageIds: ["m1"] }, sink().sink);
      expect(await t.d.steer("second message (Send now)", ["m2"])).toBe(false);
      // That start came up on Opus 5 and was ended: only the reply's own message ever went to it.
      expect((await first).ok).toBe(false);
      expect(t.inputs()).toEqual(["first message"]);
      // The second message is still waiting (the engine keeps its turn queued), and the next reply gets it.
      const s = sink();
      expect(await t.d.runTurn({ turnId: "t2", prompt: "second message (Send now)", systemNote: null, messageIds: ["m2"] }, s.sink)).toEqual({ ok: true });
      expect(t.inputs()).toEqual(["first message", "second message (Send now)"]);
      expect(t.starts().map((a) => flag(a, "--model"))).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    } finally {
      await t.d.dispose();
    }
  });

  test("once its init has named the chat's model, Send now goes in as before", async () => {
    const t = driver("later", { FAKE_CLAUDE_QUEUE: "1" });
    try {
      const first = t.d.runTurn({ turnId: "t1", prompt: "LONG_STEP first message", systemNote: null, messageIds: ["m1"] }, sink().sink);
      await until(() => t.inputs().length === 1);
      // Its init comes as it starts on the message: from then on Send now goes in.
      let took = false;
      for (const end = Date.now() + 5000; !took && Date.now() < end; await Bun.sleep(20)) took = await t.d.steer("second message (Send now)", ["m2"]);
      expect(took).toBe(true);
      await until(() => t.inputs().length === 2);
      expect(t.inputs()).toEqual(["LONG_STEP first message", "second message (Send now)"]);
      await t.d.interrupt();
      await first;
    } finally {
      await t.d.dispose();
    }
  });
});

describe("a change to a chat's model is never silent", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());
  /** A hub whose Claude Code is a stand-in (`driver`; by default one that answers "ok" at once): no CLI runs. */
  function app(driver: (ctx: DriverContext) => AgentDriver = () => ({ provider: "claude", runTurn: async () => ({ ok: true, text: "ok" }), interrupt: async () => {}, dispose: async () => {} }), model = "claude-opus-5-5") {
    const dir = scratch("app");
    const a = new App({ dbPath: ":memory:", config: { host: "127.0.0.1", port: 0, publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    registerDriver("claude", driver);
    restore = () => registerDriver("claude", (c) => new ClaudeDriver(c, c.bin));
    const room = a.chats.create({ provider: "claude", cwd: dir, model });
    const member = a.store.listMembers(room.id)[0];
    return { app: a, room, member, notes: () => a.store.listMessages(room.id).filter((m) => m.authorKind === "system").map((m) => m.text), done: async () => { await a.engine.shutdown(); a.store.close(); } };
  }

  test("a chat with a conversation says its model changed, from what to what and on which device; an unchanged model, or a chat with nothing in it yet, says nothing", async () => {
    const t = app();
    try {
      // Nothing in the chat yet: the model menu shows the change, and the chat's first screen stays as it is.
      const empty = t.notes().length;
      t.app.updateMember(t.member.id, { model: "claude-sonnet-5-5" }, "iPhone");
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5" }, "iPhone");
      expect(t.app.store.maxSeq(t.room.id)).toBe(0);
      expect(t.notes()).toHaveLength(empty);
      t.app.engine.postHumanMessage(t.room.id, "hello", "iPhone");
      await t.app.engine.whenIdle();
      const before = t.notes().length;
      // The settings dialog sends the model with every change: the same model says nothing.
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5", config: { effort: "max" } }, "iPhone");
      expect(t.notes()).toHaveLength(before);
      // Nothing is running: the next reply starts on it.
      t.app.updateMember(t.member.id, { model: "claude-opus-5" }, "iPad");
      expect(t.notes().at(-1)).toBe("Model changed from Opus 5.5 to Opus 5 on iPad. The next reply uses it.");
      t.app.updateMember(t.member.id, { model: null });
      expect(t.notes().at(-1)).toBe("Model changed from Opus 5 to Default. The next reply uses it.");
      expect(t.notes()).toHaveLength(before + 2);
    } finally {
      await t.done();
    }
  });

  test("changed while a reply and its helpers run: the chat says it applies once they finish and which model answers until then, and says so again when it does", async () => {
    // A workflow runs, the chat is moved from Opus 5 back to Opus 5.5 on the phone, and Claude
    // Code's own replies as its helpers report back still run on the Opus 5 process.
    const made: { model: string | null; ctx: DriverContext }[] = [];
    const ends: ((r: TurnResult) => void)[] = [];
    const t = app((ctx) => {
      made.push({ model: ctx.member.model, ctx });
      return { provider: "claude", runTurn: () => new Promise<TurnResult>((res) => ends.push(res)), interrupt: async () => ends.at(-1)?.({ ok: false, error: "stopped" }), dispose: async () => {} };
    }, "claude-opus-5");
    const task = (status: BackgroundTask["status"]): BackgroundTask => ({ id: "wf1", kind: "local_workflow", description: "Build the setup step", agentType: null, workflow: "setup-step", background: true, status, startedAt: 0, endedAt: status === "running" ? null : 1, tokens: null, toolUses: null, lastTool: null, summary: null, error: null });
    const member = () => t.app.store.getMember(t.member.id)!;
    try {
      t.app.engine.postHumanMessage(t.room.id, "Add the browser as a setup step", "iPhone");
      await until(() => ends.length === 1);
      made[0].ctx.onTasks?.([task("running")]);
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5" }, "iPhone");
      expect(t.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until this reply and its helpers finish.");
      expect(member().held).toEqual({ change: "settings", helpers: true });
      ends[0]({ ok: true, text: "Installed. A workflow builds the setup step." });
      await until(() => member().statusDetail === "Finishing helpers before your new settings apply");
      // A helper reports back: Claude Code's own reply runs on the Opus 5 process, and the spend ledger says so.
      const own = made[0].ctx.onOwnTurn?.(async (sink) => {
        sink.usage({ inputTokens: 1000, outputTokens: 50, costUsd: null });
        return { ok: true, text: "The workflow finished one part." };
      }, "Claude Code picked up where its helpers left off.");
      expect(own).toBe(true);
      await until(() => t.app.store.listTurns(t.room.id).filter((x) => x.status === "done").length === 2);
      expect(made).toHaveLength(1);
      const booked = t.app.store.db.query("SELECT model FROM spend_ledger ORDER BY id").all() as { model: string | null }[];
      expect(booked.at(-1)?.model).toBe("claude-opus-5");
      expect(t.notes().some((n) => n.startsWith("Now on"))).toBe(false);
      // The workflow ends: the process is replaced, and the chat says the change applies now.
      made[0].ctx.onTasks?.([task("completed")]);
      await until(() => t.notes().at(-1) === "Now on Opus 5.5: the next reply uses it.");
      expect(member()).toMatchObject({ status: "idle", statusDetail: null });
      expect(member().held).toBeUndefined();
      t.app.engine.postHumanMessage(t.room.id, "Which model is this?", "iPhone");
      await until(() => ends.length === 2);
      expect(made.map((d) => d.model)).toEqual(["claude-opus-5", "claude-opus-5-5"]);
      ends[1]({ ok: true, text: "Opus 5.5." });
      await t.app.engine.whenIdle();
      // Said once each: the change, and when it applied.
      expect(t.notes().filter((n) => n.startsWith("Model changed") || n.startsWith("Now on"))).toEqual(["Model changed from Opus 5 to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until this reply and its helpers finish.", "Now on Opus 5.5: the next reply uses it."]);
    } finally {
      for (const e of ends) e({ ok: false, error: "stopped" });
      await t.done();
    }
  });

  test("changed while only a reply runs: it applies once that reply finishes, and a group chat says whose model it is", async () => {
    const ends: ((r: TurnResult) => void)[] = [];
    const t = app(() => ({ provider: "claude", runTurn: () => new Promise<TurnResult>((res) => ends.push(res)), interrupt: async () => ends.at(-1)?.({ ok: false, error: "stopped" }), dispose: async () => {} }), "claude-opus-5");
    try {
      t.app.engine.postHumanMessage(t.room.id, "hello", "iPhone");
      await until(() => ends.length === 1);
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5" }, "iPhone");
      expect(t.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until this reply finishes.");
      ends[0]({ ok: true, text: "Hi." });
      await until(() => t.notes().at(-1) === "Now on Opus 5.5: the next reply uses it.");
    } finally {
      for (const e of ends) e({ ok: false, error: "stopped" });
      await t.done();
    }
  });
});
