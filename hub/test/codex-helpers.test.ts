// A Codex helper agent that outlives the reply that started it (multi_agent_v2, Codex 0.160): when it finishes with no
// reply of the chat's running, its final answer is queued for the chat's next turn in the app-server's memory only
// (notify_parent_of_terminal_turn with trigger_turn false; the mailbox, core/src/session/input_queue.rs, is never written
// to the thread), and no turn starts. Ending that app-server (an idle end, a settings change replacing it) used to end a
// helper still working, or lose the answer: the next reply, on a fresh app-server, resumed the thread without it. Here the
// app-server is the fake (fixtures/fake-codex-app: HELPER_OUTLIVES), in a Codex home of its own: never the person's Codex
// or the Codex app's server, no sign-in, no paid request.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTask, Member } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { CodexDriver } from "../src/agents/codex";
import type { DriverContext, TurnSink } from "../src/agents/driver";
import { App } from "../src/app";
import { endStarted } from "./standins";

setDefaultTimeout(30_000);
const FAKE = join(import.meta.dir, "fixtures", "fake-codex-app");
const ANSWER = "The tests pass: 412 of 412.";
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  await endStarted();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  // Back to what providers/all.ts registers.
  registerDriver("codex", (ctx) => {
    if (!ctx.bin) throw new Error("Codex isn't installed on the hub. Install it under Agents & sign-ins.");
    return new CodexDriver(ctx, ctx.bin);
  });
});

const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
async function until(cond: () => boolean, what: string, ms = 10_000) {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(10)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const lines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
type Rpc = { method?: string; params?: { input?: { text?: string }[] } };
/** What each turn/start sent Codex, in order. */
const turnTexts = (rpcLog: string) => lines<Rpc>(rpcLog).filter((m) => m.method === "turn/start").map((m) => m.params?.input?.[0]?.text ?? "");

/** The fake's knobs, in a folder of the test's own (a Codex home too: a chat never reaches the Codex app's server). */
function knobs(dir: string) {
  return { PATH: process.env.PATH ?? "", CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_RPC_LOG: join(dir, "rpc.jsonl"), FAKE_CODEX_MAILBOX_LOG: join(dir, "mailbox.jsonl"), FAKE_CODEX_HELPER_DONE: join(dir, "helper-done") };
}

/** The driver alone, with the hub's side played by the test. */
function driver() {
  const dir = temp("ct-codex-helpers-");
  const env = knobs(dir);
  const reports: BackgroundTask[][] = [];
  const sink = () => ({ text() {}, setText() {}, activity: () => "a", updateActivity() {}, approval: async () => "deny" as const, usage() {}, rateLimit() {}, status() {}, saveSession() {}, signal: new AbortController().signal }) as unknown as TurnSink;
  const ctx = {
    room: { id: "r1", name: "Release", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false },
    member: { id: "m1", roomId: "r1", handle: "codex", provider: "codex", model: "gpt-test", role: "", permissionMode: "full", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 },
    session: {},
    mcp: { command: "true", args: [], env: {} },
    env,
    bin: FAKE,
    chat: { helper: null, notes: null },
    onTasks: (t: BackgroundTask[]) => reports.push(t),
  } as unknown as DriverContext;
  const d = new CodexDriver(ctx, FAKE);
  cleanups.push(() => d.dispose());
  const turn = (prompt: string) => d.runTurn({ turnId: `t-${Math.random()}`, prompt, systemNote: null }, sink());
  return { d, env, reports, turn, helper: () => reports.at(-1)?.find((t) => t.id === "th-late"), finish: () => writeFileSync(env.FAKE_CODEX_HELPER_DONE, "") };
}

test("a helper that outlives its reply is background work until it finishes, and its app-server isn't ended under it", async () => {
  const h = driver();
  expect(await h.turn("Run the tests with a helper and tell me later. HELPER_OUTLIVES")).toEqual({ ok: true });
  // The reply is over; the helper still works. (Before, nothing said so: an idle end or a new setting ended it.)
  expect(h.helper()).toMatchObject({ kind: "local_agent", description: "Tests", status: "running", background: true });
  expect(h.d.canEndWhenIdle()).toBe(false);
  expect(h.d.carryNote()).toBeNull();
  h.finish();
  await until(() => h.helper()?.status === "completed", "the helper to finish");
  expect(h.d.canEndWhenIdle()).toBe(true);
  // Its answer waits for the chat's next turn, in this app-server only: said to any other that would take over.
  expect(h.d.carryNote()).toContain(ANSWER);
  // The next turn on the same app-server: Codex gives it the answer itself, so nothing more is said.
  expect(await h.turn("What did the tests say?")).toEqual({ ok: true });
  expect(lines<{ mail: { text: string }[] }>(h.env.FAKE_CODEX_MAILBOX_LOG).map((x) => x.mail.map((m) => m.text))).toEqual([[ANSWER]]);
  expect(turnTexts(h.env.FAKE_CODEX_RPC_LOG).at(-1)).not.toContain("helper agent of yours");
  expect(h.d.carryNote()).toBeNull();
});

test("an app-server that went before the next turn: that turn is told the helper's answer in words", async () => {
  const h = driver();
  await h.turn("Run the tests with a helper. HELPER_OUTLIVES");
  h.finish();
  await until(() => h.helper()?.status === "completed", "the helper to finish");
  // The app-server goes (it crashed, say): its mailbox with it.
  await (h.d as unknown as { rpc: { kill(): Promise<void> } }).rpc.kill();
  expect(await h.turn("What did the tests say?")).toEqual({ ok: true });
  const text = turnTexts(h.env.FAKE_CODEX_RPC_LOG).at(-1)!;
  expect(text).toStartWith("(Note from Crosstalk: a helper agent of yours finished while no reply of yours was running.");
  expect(text).toContain(`Tests:\n${ANSWER}`);
  expect(text).toEndWith("What did the tests say?");
  expect(lines(h.env.FAKE_CODEX_MAILBOX_LOG)).toEqual([]); // the new app-server had nothing of it
  expect(h.d.carryNote()).toBeNull();
});

test("a helper whose end went unheard is found finished by reading its thread, so it never holds the chat for good", async () => {
  const was = CodexDriver.helperPollMs;
  CodexDriver.helperPollMs = 100;
  cleanups.push(() => void (CodexDriver.helperPollMs = was));
  const h = driver();
  await h.turn("Run the tests with a helper. HELPER_OUTLIVES");
  // As if the helper's turn/completed never reached the hub: the helper's thread says it's done.
  (h.d as unknown as { trackHelpers: (m: string, p: unknown) => void }).trackHelpers = () => {};
  h.finish();
  await until(() => h.helper()?.status === "completed", "the poll to find it finished", 3000);
  expect(h.d.canEndWhenIdle()).toBe(true);
  expect(h.d.carryNote()).toContain(ANSWER);
});

test("in a chat: new settings wait for the helper, and once it's done the new app-server's first turn is told its answer", async () => {
  const dir = temp("ct-codex-helpers-hub-");
  const env = knobs(dir);
  const made: CodexDriver[] = [];
  registerDriver("codex", (ctx) => {
    const d = new CodexDriver({ ...ctx, env: { ...ctx.env, ...env } }, FAKE);
    made.push(d);
    return d;
  });
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(() => app.shutdown());
  const chat = app.chats.create({ provider: "codex", name: "Release", cwd: join(dir, "project"), model: "gpt-test", permissionMode: "full" } as never);
  const member = app.store.listMembers(chat.id)[0];
  const now = (): Member => app.store.getMember(member.id)!;
  const notes = () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "system").map((m) => m.text);
  const idle = async () => {
    await Bun.sleep(20);
    await app.engine.whenIdle();
    await Bun.sleep(20);
  };
  app.engine.postHumanMessage(chat.id, "Run the tests with a helper and tell me later. HELPER_OUTLIVES", "iPhone 18 Pro Max");
  await idle();
  await until(() => app.engine.tasksIn(chat.id)[member.id]?.some((t) => t.status === "running") ?? false, "the helper to be reported");
  expect(app.engine.busyWork()).toEqual([{ roomId: chat.id, memberId: member.id, why: "background" }]);
  // A new effort while the helper works: it waits for the helper (ending this app-server would end the helper).
  app.updateMember(member.id, { config: { ...now().config, effort: "high" } }, "iPhone 18 Pro Max");
  expect(now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
  writeFileSync(env.FAKE_CODEX_HELPER_DONE, "");
  await until(() => !now().held, "the change to apply");
  // The app-server that held the helper's answer is gone; what it held waits for the next turn, kept on the hub (a
  // restart keeps it too), so nothing holds a restart for it.
  expect(made).toHaveLength(1);
  expect(app.store.kvGet("carryNotes")).toContain(ANSWER);
  expect(app.engine.busyWork()).toEqual([]);
  app.engine.postHumanMessage(chat.id, "What did the tests say?", "iPhone 18 Pro Max");
  await idle();
  expect(made).toHaveLength(2);
  const text = turnTexts(env.FAKE_CODEX_RPC_LOG).at(-1)!;
  expect(text).toContain(ANSWER);
  expect(text).toContain("What did the tests say?");
  expect(lines(env.FAKE_CODEX_MAILBOX_LOG)).toEqual([]);
  expect(app.store.kvGet("carryNotes")).toBeNull();
  expect(notes().some((n) => n.includes("helper"))).toBe(false);
});

test("in a chat: a message while the helper works goes on its app-server at once, says when the new settings apply, and the helper is left working", async () => {
  // Helpers can work in the background while the person keeps iterating.
  const dir = temp("ct-codex-helpers-flow-");
  const env = knobs(dir);
  const made: CodexDriver[] = [];
  registerDriver("codex", (ctx) => {
    const d = new CodexDriver({ ...ctx, env: { ...ctx.env, ...env } }, FAKE);
    made.push(d);
    return d;
  });
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(() => app.shutdown());
  const chat = app.chats.create({ provider: "codex", name: "Release", cwd: join(dir, "project"), model: "gpt-test", permissionMode: "full" } as never);
  const member = app.store.listMembers(chat.id)[0];
  const now = (): Member => app.store.getMember(member.id)!;
  const notes = () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "system").map((m) => m.text);
  const replies = () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "agent");
  const idle = async () => {
    await Bun.sleep(20);
    await app.engine.whenIdle();
    await Bun.sleep(20);
  };
  app.engine.postHumanMessage(chat.id, "Run the tests with a helper and tell me later. HELPER_OUTLIVES", "iPhone 18 Pro Max");
  await idle();
  await until(() => app.engine.tasksIn(chat.id)[member.id]?.some((t) => t.status === "running") ?? false, "the helper to be reported");
  app.updateMember(member.id, { config: { ...now().config, effort: "high" } }, "iPhone 18 Pro Max");
  expect(now().held).toEqual({ change: "settings", helpers: true });
  app.engine.postHumanMessage(chat.id, "While that runs, look at the docs", "iPhone 18 Pro Max");
  await idle();
  expect(replies()).toHaveLength(2);
  expect(made).toHaveLength(1);
  expect(notes()).toEqual(["Your new settings apply when Codex's helpers finish. Until then it answers with the settings it started with."]);
  expect(app.engine.tasksIn(chat.id)[member.id]?.some((t) => t.status === "running")).toBe(true);
  expect(now().held).toEqual({ change: "settings", helpers: true });
  // The helper finishes: the app-server goes, what it held goes to the next turn, on a new one.
  writeFileSync(env.FAKE_CODEX_HELPER_DONE, "");
  await until(() => !now().held, "the change to apply");
  app.engine.postHumanMessage(chat.id, "What did the tests say?", "iPhone 18 Pro Max");
  await idle();
  expect(made).toHaveLength(2);
  expect(turnTexts(env.FAKE_CODEX_RPC_LOG).at(-1)).toContain(ANSWER);
});

describe("a message that goes into Codex's reply by itself while its helper works", () => {
  const MESSAGE = "ALSO delete the old build folder";
  /** A chat whose helper works and whose reply is on a long step: what a message meets while helpers work. `more`: the fake's knobs. */
  async function atWork(more: Record<string, string> = {}) {
    const dir = temp("ct-codex-flow-");
    const env = { ...knobs(dir), ...more };
    const made: CodexDriver[] = [];
    registerDriver("codex", (ctx) => {
      const d = new CodexDriver({ ...ctx, env: { ...ctx.env, ...env } }, FAKE);
      made.push(d);
      return d;
    });
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    cleanups.push(() => app.shutdown());
    const chat = app.chats.create({ provider: "codex", name: "Release", cwd: join(dir, "project"), model: "gpt-test", permissionMode: "full" } as never);
    const member = app.store.listMembers(chat.id)[0];
    const idle = async () => {
      await Bun.sleep(20);
      await app.engine.whenIdle();
      await Bun.sleep(20);
    };
    const rpc = (method: string) => lines<Rpc>(env.FAKE_CODEX_RPC_LOG).filter((m) => m.method === method);
    const helperStatus = () => app.engine.tasksIn(chat.id)[member.id]?.[0]?.status;
    app.engine.postHumanMessage(chat.id, "Run the tests with a helper and tell me later. HELPER_OUTLIVES", "iPhone 18 Pro Max");
    await idle();
    await until(() => helperStatus() === "running", "the helper to be reported");
    app.engine.postHumanMessage(chat.id, "LONG_STEP: run the long check", "iPhone 18 Pro Max");
    await until(() => app.store.listActivities(chat.id, app.engine.runningTurns(chat.id).map((t) => t.id)).some((a) => a.kind === "command" && a.status === "running"), "the long step");
    return {
      app,
      chat,
      member,
      env,
      made,
      idle,
      rpc,
      helperStatus,
      now: (): Member => app.store.getMember(member.id)!,
      notes: () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "system").map((m) => m.text),
      say: (text: string) => app.engine.postHumanMessage(chat.id, text, "iPhone 18 Pro Max"),
      /** The message goes in with no tap: Codex has it by turn/steer, and the turn that waited for it is dropped. */
      goesIn: async () => {
        const yours = app.engine.postHumanMessage(chat.id, MESSAGE, "iPhone 18 Pro Max");
        await until(() => rpc("turn/steer").length === 1 && app.engine.queuedTurns(chat.id).length === 0, "the message to go in");
        return yours;
      },
      turnStarts: () => turnTexts(env.FAKE_CODEX_RPC_LOG).filter((t) => t.includes(MESSAGE)),
    };
  }

  test("it goes in with no tap, is read in that turn, and starts no turn of its own", async () => {
    const h = await atWork();
    const yours = await h.goesIn();
    const reply = h.app.engine.runningTurns(h.chat.id)[0];
    expect(h.app.engine.liveTurn(h.app.store.getTurn(reply.id)!).unread).toEqual([yours.id]);
    expect(h.turnStarts()).toEqual([]);
    expect(h.rpc("turn/steer")[0].params?.input?.[0]?.text).toBe(MESSAGE);
    expect(h.helperStatus()).toBe("running");
    await h.app.engine.stop(h.chat.id);
    await h.idle();
  });

  test("Stop after it went in: the turn drops it, so it's unread again, nothing starts, and Answer now delivers it once", async () => {
    const h = await atWork();
    const yours = await h.goesIn();
    await h.app.engine.stop(h.chat.id);
    await h.idle();
    // (Before: read as far as anyone could tell, with no Not answered, no Answer now, and Try again refused.)
    expect(h.now().readSeq).toBeLessThan(yours.seq);
    expect(h.turnStarts()).toEqual([]);
    expect(h.app.store.listTurns(h.chat.id).at(-1)?.status).toBe("stopped");
    h.app.engine.retry(h.chat.id);
    await h.idle();
    expect(h.turnStarts()).toHaveLength(1);
    expect(h.now().readSeq).toBeGreaterThanOrEqual(yours.seq);
    expect(h.app.store.listMessages(h.chat.id).filter((m) => m.authorKind === "agent").at(-1)?.text).toBe("Done.");
    // Nothing was asked of a new app-server, and the helper works on.
    expect(h.made).toHaveLength(1);
    expect(h.rpc("thread/resume")).toEqual([]);
    expect(h.helperStatus()).toBe("running");
  });

  test("Stop and answer my message: answered next, on the same app-server, with the helper working on", async () => {
    const h = await atWork();
    await h.goesIn();
    await h.app.engine.stop(h.chat.id, undefined, { keepWaiting: true });
    await h.idle();
    expect(h.turnStarts()).toHaveLength(1);
    expect(h.made).toHaveLength(1);
    expect(h.rpc("thread/resume")).toEqual([]);
    expect(h.helperStatus()).toBe("running");
  });

  test("a message Codex took in just as it stopped is read: it isn't given back or sent again", async () => {
    const h = await atWork({ FAKE_CODEX_TAKE_ON_INTERRUPT: "1" });
    const yours = await h.goesIn();
    await h.app.engine.stop(h.chat.id);
    await h.idle();
    expect(h.now().readSeq).toBeGreaterThanOrEqual(yours.seq);
    expect(() => h.app.engine.retry(h.chat.id)).toThrow();
    expect(h.turnStarts()).toEqual([]);
  });

  test("a turn that fails after it went in drops it too: unread, and Try again delivers it", async () => {
    const h = await atWork({ FAKE_CODEX_FAIL_ON_STEER: "1" });
    const yours = await h.goesIn();
    await h.idle();
    expect(h.now().status).toBe("error");
    expect(h.now().readSeq).toBeLessThan(yours.seq);
    h.app.engine.retry(h.chat.id);
    await h.idle();
    expect(h.turnStarts()).toHaveLength(1);
  });

  test("a message sent as the stopped turn winds down waits for that turn: the app-server, and the helper in it, stay", async () => {
    const h = await atWork({ FAKE_CODEX_STOP_MS: "400" });
    const stopping = h.app.engine.stop(h.chat.id);
    h.say(MESSAGE);
    await stopping;
    await h.idle();
    expect(h.turnStarts()).toHaveLength(1);
    expect(h.made).toHaveLength(1);
    expect(h.rpc("thread/resume")).toEqual([]);
    expect(h.helperStatus()).toBe("running");
    expect(h.notes()).toEqual([]);
  });

  describe("with the switch off", () => {
    /** Nothing goes in by itself: it waits behind the reply, and Send now puts it in. */
    async function waiting(more: Record<string, string> = {}) {
      const h = await atWork(more);
      h.app.setHubSettings({ messagesFlow: false });
      const yours = h.say(MESSAGE);
      await Bun.sleep(100);
      expect(h.rpc("turn/steer")).toEqual([]);
      expect(h.app.engine.queuedTurns(h.chat.id)).toHaveLength(1);
      return { h, yours };
    }

    test("Send now puts it in, and it's read in that turn, starting no turn of its own", async () => {
      const { h, yours } = await waiting();
      expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
      expect(h.rpc("turn/steer")).toHaveLength(1);
      const reply = h.app.engine.runningTurns(h.chat.id)[0];
      expect(h.app.engine.liveTurn(h.app.store.getTurn(reply.id)!).unread).toEqual([yours.id]);
      expect(h.turnStarts()).toEqual([]);
      await h.app.engine.stop(h.chat.id);
      await h.idle();
    });

    test("Stop after a Send now: the turn drops it, so it's unread again, nothing starts, and Answer now delivers it once", async () => {
      const { h, yours } = await waiting();
      expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
      await h.app.engine.stop(h.chat.id);
      await h.idle();
      expect(h.now().readSeq).toBeLessThan(yours.seq);
      expect(h.turnStarts()).toEqual([]);
      h.app.engine.retry(h.chat.id, null, { currentSettings: true });
      await h.idle();
      expect(h.turnStarts()).toHaveLength(1);
      expect(h.made).toHaveLength(1);
      expect(h.rpc("thread/resume")).toEqual([]);
      expect(h.helperStatus()).toBe("running");
    });

    test("flipped on: it goes in by itself, once", async () => {
      const { h } = await waiting();
      h.app.setHubSettings({ messagesFlow: true });
      await until(() => h.rpc("turn/steer").length === 1 && h.app.engine.queuedTurns(h.chat.id).length === 0, "the message to go in");
      h.app.setHubSettings({ messagesFlow: false });
      h.app.setHubSettings({ messagesFlow: true });
      await Bun.sleep(100);
      expect(h.rpc("turn/steer")).toHaveLength(1);
      expect(h.turnStarts()).toEqual([]);
      await h.app.engine.stop(h.chat.id);
      await h.idle();
    });
  });
});

test("a stopped turn whose app-server never ends it: that goes after the grace time, the helper is listed as stopped, the chat says it's lost, once, and a fresh app-server answers", async () => {
  const dir = temp("ct-codex-stuck-");
  const env = { ...knobs(dir), FAKE_CODEX_STUCK_INTERRUPT: "1" };
  registerDriver("codex", (ctx) => new CodexDriver({ ...ctx, env: { ...ctx.env, ...env } }, FAKE));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(() => app.shutdown());
  const chat = app.chats.create({ provider: "codex", name: "Release", cwd: join(dir, "project"), model: "gpt-test", permissionMode: "full" } as never);
  const member = app.store.listMembers(chat.id)[0];
  const helperStatus = () => app.engine.tasksIn(chat.id)[member.id]?.[0]?.status;
  app.engine.postHumanMessage(chat.id, "Run the tests with a helper and tell me later. HELPER_OUTLIVES", "iPhone 18 Pro Max");
  await app.engine.whenIdle();
  await until(() => helperStatus() === "running", "the helper to be reported");
  app.engine.postHumanMessage(chat.id, "LONG_STEP: run the long check", "iPhone 18 Pro Max");
  await until(() => app.store.listActivities(chat.id, app.engine.runningTurns(chat.id).map((t) => t.id)).some((a) => a.kind === "command" && a.status === "running"), "the long step");
  const stopping = app.engine.stop(chat.id);
  app.engine.postHumanMessage(chat.id, "Do this instead", "iPhone 18 Pro Max");
  await stopping;
  await until(() => helperStatus() === "stopped", "the helper to be listed as stopped", 8000);
  await until(() => turnTexts(env.FAKE_CODEX_RPC_LOG).some((t) => t.includes("Do this instead")), "a fresh app-server to answer", 8000);
  await app.engine.whenIdle();
  expect(lines<Rpc>(env.FAKE_CODEX_RPC_LOG).filter((m) => m.method === "thread/resume")).toHaveLength(1);
  expect(app.store.listMessages(chat.id).filter((m) => m.authorKind === "system").map((m) => m.text)).toEqual(['Codex\'s process ended. It was running the helper "Tests" in the background. That ended with the old process, so what it was doing is lost: ask again if you still need it.']);
  expect(app.engine.busyWork()).toEqual([]);
});

test("an app-server that goes with a helper at work: it's listed as stopped, the chat says it's lost, and a change held for it applies", async () => {
  const dir = temp("ct-codex-helpers-gone-");
  const env = knobs(dir);
  const made: CodexDriver[] = [];
  registerDriver("codex", (ctx) => {
    const d = new CodexDriver({ ...ctx, env: { ...ctx.env, ...env } }, FAKE);
    made.push(d);
    return d;
  });
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(() => app.shutdown());
  const chat = app.chats.create({ provider: "codex", name: "Release", cwd: join(dir, "project"), model: "gpt-test", permissionMode: "full" } as never);
  const member = app.store.listMembers(chat.id)[0];
  const now = (): Member => app.store.getMember(member.id)!;
  app.engine.postHumanMessage(chat.id, "Run the tests with a helper and tell me later. HELPER_OUTLIVES", "iPhone 18 Pro Max");
  await app.engine.whenIdle();
  await until(() => app.engine.tasksIn(chat.id)[member.id]?.some((t) => t.status === "running") ?? false, "the helper to be reported");
  app.updateMember(member.id, { config: { ...now().config, effort: "high" } }, "iPhone 18 Pro Max");
  expect(now().held).toEqual({ change: "settings", helpers: true });
  await (made[0] as unknown as { rpc: { kill(): Promise<void> } }).rpc.kill();
  await until(() => !now().held, "the change to apply");
  const said = app.store.listMessages(chat.id).filter((m) => m.authorKind === "system").map((m) => m.text);
  expect(said).toEqual(['Codex\'s process ended. It was running the helper "Tests" in the background. That ended with the old process, so what it was doing is lost: ask again if you still need it.']);
  expect(now()).toMatchObject({ status: "idle", statusDetail: null });
  expect(app.engine.busyWork()).toEqual([]);
});

test("a hub stopping takes what an app-server held for the chat's next turn, for the next hub to say", async () => {
  const dir = temp("ct-codex-helpers-stop-");
  const env = knobs(dir);
  registerDriver("codex", (ctx) => new CodexDriver({ ...ctx, env: { ...ctx.env, ...env } }, FAKE));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  let closed = false;
  cleanups.push(() => (closed ? undefined : app.shutdown()));
  const chat = app.chats.create({ provider: "codex", name: "Release", cwd: join(dir, "project"), model: "gpt-test", permissionMode: "full" } as never);
  const member = app.store.listMembers(chat.id)[0];
  app.engine.postHumanMessage(chat.id, "Run the tests with a helper and tell me later. HELPER_OUTLIVES", "iPhone 18 Pro Max");
  await app.engine.whenIdle();
  writeFileSync(env.FAKE_CODEX_HELPER_DONE, "");
  await until(() => app.engine.tasksIn(chat.id)[member.id]?.some((t) => t.status === "completed") ?? false, "the helper to finish");
  expect(app.store.kvGet("carryNotes")).toBeNull();
  await app.engine.shutdown();
  expect(JSON.parse(app.store.kvGet("carryNotes")!)[member.id]).toContain(ANSWER);
  await app.shutdown();
  closed = true;
});
