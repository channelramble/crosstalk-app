// An agent's own wake-up is never lost to a settings change (Engine.memberChanged, AgentDriver.owedTurn). A chat's model
// changed (Default → Opus 5.5) while Claude Code ran the test suite in the background; since 0.6.2 such a change waits
// for the agent's helpers, then replaces its process. When the job finished, Claude Code wrote its <task-notification>
// into the session; in that same moment Crosstalk applied the waiting change, replaced the process and said "Now on
// Opus 5.5: the next reply uses it." The new process never answered the notification (on resume Claude Code closes a
// line nothing answered with its own "No response requested."), and the agent went idle mid-plan until another chat
// nudged it. Nor does the wake-up run where it mustn't:
// under tighter permissions, another account or a new folder its reply is stopped as it starts and a process on the new
// settings carries on from it (Engine.ownTurn, carryOver). One refused before any words (a usage limit) still becomes a
// reply that waits for the limit. Crosstalk's own agent, which starts no reply by itself, never keeps a message handed to
// it for later either. Everything here runs the fakes (fixtures/fake-claude, fake-nanogpt): never the real Claude Code
// or a real service, no sign-in, no paid request.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BackgroundTask, Member, SendNowResult } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { BuiltinDriver } from "../src/agents/builtin";
import { ClaudeDriver } from "../src/agents/claude";
import type { DriverContext, TurnResult, TurnSink } from "../src/agents/driver";
import { App } from "../src/app";
import { registerProvider } from "../src/providers";
import { builtinProvider } from "../src/providers/builtin";
import { claudeProvider } from "../src/providers/claude";
import { fakeNanoGpt, type ScriptedReply } from "./fixtures/fake-nanogpt";
import { endStarted } from "./standins";

setDefaultTimeout(30_000);
const FAKE = join(import.meta.dir, "fixtures", "fake-claude");
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
const KNOBS = ["FAKE_CLAUDE_RECEIPT_MS", "CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_ARGS_OUT", "FAKE_CLAUDE_INPUT_OUT", "FAKE_CLAUDE_TRANSCRIPT", "FAKE_CLAUDE_JOB_DONE", "FAKE_CLAUDE_WAKE_MS", "FAKE_CLAUDE_NO_WAKE", "FAKE_CLAUDE_NO_STATE", "FAKE_CLAUDE_IDLE_BETWEEN", "FAKE_CLAUDE_QUEUE", "FAKE_CLAUDE_RUN_MODELS", "FAKE_CLAUDE_WAKE_LIMIT", "FAKE_CLAUDE_WAKE_STREAM_MS", "FAKE_CLAUDE_CWD_OUT", "FAKE_CLAUDE_INTERRUPT_LOG", "FAKE_CLAUDE_NO_CANCEL_QUEUED", "FAKE_CLAUDE_STOP_MS"];
const savedEnv = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
const sessionsInUse = ClaudeDriver.sessionsInUse;
const quietMs = ClaudeDriver.owedQuietMs;
const graceMs = ClaudeDriver.graceMs;

beforeEach(() => {
  // The real Claude Code driver and provider, whatever another file left registered.
  registerProvider(claudeProvider);
  registerDriver("claude", (ctx) => new ClaudeDriver(ctx, ctx.bin));
  // Nothing of this Mac's own Claude Code sessions is looked at.
  ClaudeDriver.sessionsInUse = () => new Set();
});

afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  ClaudeDriver.sessionsInUse = sessionsInUse;
  ClaudeDriver.owedQuietMs = quietMs;
  ClaudeDriver.graceMs = graceMs;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await endStarted();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
type Line = { role: "user" | "assistant"; text: string; model: string | null; start: number };

/** The whole hub with the fake Claude Code as its agent, and a chat with a background job. `knobs`: the fake's, for this test. */
function hub(knobs: Record<string, string> = {}, model: string | null = null) {
  const dir = temp("ct-wake-");
  const files = { args: join(dir, "args.jsonl"), inputs: join(dir, "inputs.jsonl"), transcript: join(dir, "transcript.jsonl"), jobDone: join(dir, "job-done"), cwds: join(dir, "cwds.jsonl"), interrupts: join(dir, "interrupts.jsonl") };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(dir, "claude-config"), FAKE_CLAUDE_ARGS_OUT: files.args, FAKE_CLAUDE_INPUT_OUT: files.inputs, FAKE_CLAUDE_TRANSCRIPT: files.transcript, FAKE_CLAUDE_JOB_DONE: files.jobDone, FAKE_CLAUDE_CWD_OUT: files.cwds, FAKE_CLAUDE_INTERRUPT_LOG: files.interrupts }, knobs);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.providers.which = (p) => (p === "claude" ? FAKE : null);
  cleanups.push(() => app.shutdown());
  const chat = app.chats.create({ provider: "claude", name: "Release prep", cwd: join(dir, "project"), model, permissionMode: "full" } as never);
  const member = app.store.listMembers(chat.id)[0];
  const say = (text: string) => app.engine.postHumanMessage(chat.id, text, "iPhone");
  const idle = async () => {
    await Bun.sleep(20);
    await app.engine.whenIdle();
    await Bun.sleep(20);
  };
  return {
    app,
    chat,
    member,
    files,
    say,
    idle,
    now: (): Member => app.store.getMember(member.id)!,
    starts: () => lines<string[]>(files.args),
    cwds: () => lines<string>(files.cwds),
    inputs: () => lines<string>(files.inputs),
    interrupts: () => lines<{ request: { subtype: string; cancel_queued?: boolean } }>(files.interrupts).map((l) => l.request),
    transcript: () => lines<Line>(files.transcript),
    notes: () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "system").map((m) => m.text),
    replies: () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "agent").map((m) => m.text),
    job: (): BackgroundTask | undefined => app.engine.tasksIn(chat.id)[member.id]?.find((t) => t.id === "job1"),
  };
}

describe("a settings change waiting for an agent's background job", () => {
  test("the job finishes: its report is answered once, by the process that ran the job, and the new model applies right after", async () => {
    // "Default" came up on Opus 5 here, so the two models can be told apart. The report's first words take 1.5 s (the
    // hub hears the job is done within 0.3 s).
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_MS: "1500" });
    // The agent starts the test suite in the background and ends its reply, the job still running.
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    // The chat's model is changed on the phone. It waits for the job.
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.notes().at(-1)).toBe("Model changed from Default to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until its helpers finish.");
    expect(h.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
    // The job finishes. Claude Code writes its report into the session and asks the model, whose first words
    // take longer than the hub takes to hear the job is done.
    writeFileSync(h.files.jobDone, "");
    await until(() => h.job()?.status === "completed" || h.notes().some((n) => n.startsWith("Now on")), "the hub to hear the job is done");
    // The hub has heard the job is done, and Claude Code hasn't answered it yet: the change still waits, for that answer.
    // (Before the fix it applied right here, the process went with the report in it, and the next one closed the report
    // with "No response requested.": the continuation below never came.)
    expect(h.notes().some((n) => n.startsWith("Now on"))).toBe(false);
    expect(h.starts()).toHaveLength(1);
    expect(h.now().held).toEqual({ change: "settings", helpers: true, owed: "report" });
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    await h.idle();

    // The agent carried on with its plan, once, on the process that ran the job, and the chat said so.
    expect(h.replies()).toEqual(["Starting the test suite in the background.\n\nI'll carry on with the plan when it finishes.", "The test suite passed. Carrying on with the plan: fixing the flaky test next."]);
    const [, own] = h.app.store.listTurns(h.chat.id);
    expect(own).toMatchObject({ status: "done", triggerMessageId: null });
    expect(h.notes()).toEqual([
      "Model changed from Default to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until its helpers finish.",
      "Claude Code picked up where its helpers left off, with the settings it started with: your new settings apply once this reply finishes.",
      "Now on Opus 5.5: the next reply uses it.",
    ]);
    expect(h.now()).toMatchObject({ status: "idle", statusDetail: null });
    expect(h.now().held).toBeUndefined();
    // In the session: the report, answered by the first process (on Opus 5). Nothing was left unanswered.
    const report = h.transcript().findIndex((l) => l.role === "user" && l.text.startsWith("<task-notification>"));
    expect(h.transcript().slice(report + 1, report + 2)).toEqual([{ role: "assistant", text: "The test suite passed. Carrying on with the plan: fixing the flaky test next.", model: "claude-opus-5", start: 1 }]);

    // The next message: a new process on Opus 5.5, resuming the same conversation, handed only that message.
    h.say("What's next on the plan?");
    await h.idle();
    const [first, second] = h.starts();
    expect(flag(first, "--model")).toBe("default");
    expect(flag(second, "--model")).toBe("claude-opus-5-5");
    expect(flag(second, "--resume")).toBe(h.app.store.getMemberSession(h.member.id).sessionId as string);
    expect(h.inputs()).toEqual(["Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB", "What's next on the plan?"]);
    expect(h.transcript().some((l) => l.text === "No response requested.")).toBe(false);
    expect(h.transcript().filter((l) => l.role === "assistant").map((l) => [l.model, l.start])).toEqual([
      ["claude-opus-5", 1],
      ["claude-opus-5", 1],
      ["claude-opus-5-5", 2],
    ]);
  });

  test("a message while the job runs starts at once, on the process that runs it; the new model waits for the job and its report, then applies", async () => {
    // Helpers work in the background while the person keeps iterating.
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_MS: "300" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.now().held).toEqual({ change: "settings", helpers: true });
    // No waiting for the job: answered now, by the process as it is, and the job goes on.
    h.say("While that runs, what's next on the plan?");
    await h.idle();
    expect(h.replies()).toHaveLength(2);
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
    expect(h.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
    // The job finishes: its report is answered once, on that process, and only then the new model applies.
    writeFileSync(h.files.jobDone, "");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    await h.idle();
    expect(h.replies().at(-1)).toBe("The test suite passed. Carrying on with the plan: fixing the flaky test next.");
    expect(h.starts()).toHaveLength(1);
    expect(h.transcript().some((l) => l.text === "No response requested.")).toBe(false);
    // The next message is on the new model, in the same conversation.
    h.say("And after that?");
    await h.idle();
    expect(h.starts()).toHaveLength(2);
    expect(flag(h.starts()[1], "--model")).toBe("claude-opus-5-5");
    expect(flag(h.starts()[1], "--resume")).toBe(h.app.store.getMemberSession(h.member.id).sessionId as string);
  });

  test("a message while the job and a reply both run goes to Claude Code by itself, on the same process, and is answered once", async () => {
    const h = hub({ FAKE_CLAUDE_QUEUE: "1" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.say("Fix the flaky test SLOW:1500");
    await until(() => h.replies().at(-1) === "Working on it.", "the reply to be under way");
    h.say("Also check the retry count");
    await until(() => h.app.engine.queuedTurns(h.chat.id).length === 0, "the message to go in");
    await until(() => h.replies().some((r) => r.includes("Also check the retry count")), "Claude Code to read it");
    await h.idle();
    // Written to the process as the reply ran, with no tap. This reply has one long step, so it ended first, and Claude
    // Code answers the message next in a turn of its own (a real reply reads it at its next step).
    expect(h.inputs().filter((i) => i === "Also check the retry count")).toHaveLength(1);
    expect(h.starts()).toHaveLength(1);
    expect(h.replies().filter((r) => r.includes("Also check the retry count"))).toHaveLength(1);
    expect(h.notes()).toEqual(["Claude Code is answering the message you sent."]);
    expect(h.job()?.status).toBe("running");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.job()?.status === "completed", "the job to finish");
    await h.idle();
  });

  test("a job started just before the reply ends: the hub knows of it as the reply ends, so a change waiting for that reply doesn't take the job with it", async () => {
    // The reply works, the model is changed, the job starts and the reply ends at once, inside the driver's 300 ms batching
    // of task reports. (Before, the hub hadn't heard of the job then: the process was replaced, job and all.)
    const h = hub({}, "claude-opus-5");
    h.say("Run the test suite in the background and carry on. BACKGROUND_JOB JOB_AFTER:300");
    await until(() => h.app.engine.runningTurns(h.chat.id).length === 1, "the reply to be under way");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until this reply finishes.");
    await h.idle();
    expect(h.job()?.status).toBe("running");
    expect(h.notes().some((n) => n.startsWith("Now on"))).toBe(false);
    expect(h.now().held).toEqual({ change: "settings", helpers: true });
    expect(h.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
    await Bun.sleep(350); // past the batching: nothing has ended it meanwhile
    expect(h.job()?.status).toBe("running");
    expect(h.starts()).toHaveLength(1);
    writeFileSync(h.files.jobDone, "");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    await h.idle();
    expect(h.replies().at(-1)).toBe("The test suite passed. Carrying on with the plan: fixing the flaky test next.");
    expect(h.starts()).toHaveLength(1);
  });

  /** Send now while the reply's last words come, and a model change waiting for that reply. `knobs`: the fake's. */
  async function handedAsItEnds(knobs: Record<string, string>) {
    // Claude Code queues a message sent mid-reply and answers it in a turn of its own when the reply ends first.
    const h = hub({ FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_WAKE_MS: "600", ...knobs }, "claude-opus-5");
    h.say("Fix the flaky test SLOW:1500");
    await until(() => h.replies()[0] === "Working on it.", "the reply to be under way");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until this reply finishes.");
    h.say("Also check the retry count");
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
    expect(h.notes().at(-1)).toBe("Answering now with the settings Claude Code started with. Your changes apply from its next reply.");
    // The reply ends before Claude Code has read it: Claude Code answers it next, in a turn of its own. (Before the fix
    // the change applied as the reply ended, and the message, already marked read, went with the process.)
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    await h.idle();
    expect(h.replies()).toEqual(["Working on it.", expect.stringContaining("Also check the retry count")]);
    expect(h.replies()[1]).toStartWith("Got it: ");
    expect(h.notes().slice(-2)).toEqual(["Claude Code is answering the message you sent, with the settings it started with: your new settings apply once this reply finishes.", "Now on Opus 5.5: the next reply uses it."]);
    expect(h.starts()).toHaveLength(1);
    expect(h.transcript().some((l) => l.text === "No response requested.")).toBe(false);
    h.say("Thanks");
    await h.idle();
    expect(h.starts().map((a) => flag(a, "--model"))).toEqual(["claude-opus-5", "claude-opus-5-5"]);
    expect(h.transcript().some((l) => l.text === "No response requested.")).toBe(false);
  }

  test("a message Send now handed to a reply as it ended is answered by that process, then the change applies", () => handedAsItEnds({}));

  test("one still on its way down Claude Code's input as the reply ended: the 'idle' it said before reading it isn't taken for done", async () => {
    // Nothing but the turn that answers it may end the wait here: no quiet spell does.
    ClaudeDriver.owedQuietMs = 60_000;
    await handedAsItEnds({ FAKE_CLAUDE_IDLE_BETWEEN: "1" });
  });

  test("a report Claude Code takes in without a word holds the change only until Claude Code says it's idle", async () => {
    // Claude Code's own word that it's done ends the wait at once: no quiet spell is waited for.
    ClaudeDriver.owedQuietMs = 60_000;
    const h = hub({ FAKE_CLAUDE_NO_WAKE: "1", FAKE_CLAUDE_RUN_MODELS: "claude-opus-5," });
    h.say("Run the full test suite in the background. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    const done = Date.now();
    writeFileSync(h.files.jobDone, "");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply", 5000);
    expect(Date.now() - done).toBeLessThan(3000); // the hub's 300 ms batching of task reports
    expect(h.now().held).toBeUndefined();
    h.say("Carry on");
    await h.idle();
    expect(h.starts().map((a) => flag(a, "--model"))).toEqual(["default", "claude-opus-5-5"]);
  });

  test("from a Claude Code that never says whether it's working, a report it doesn't answer holds the change only until it has clearly not started on it", async () => {
    ClaudeDriver.owedQuietMs = 500;
    const h = hub({ FAKE_CLAUDE_NO_WAKE: "1", FAKE_CLAUDE_NO_STATE: "1", FAKE_CLAUDE_RUN_MODELS: "claude-opus-5," });
    h.say("Run the full test suite in the background. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    const done = Date.now();
    writeFileSync(h.files.jobDone, "");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    expect(Date.now() - done).toBeGreaterThanOrEqual(450);
    expect(h.now().held).toBeUndefined();
    h.say("Carry on");
    await h.idle();
    expect(h.starts().map((a) => flag(a, "--model"))).toEqual(["default", "claude-opus-5-5"]);
  });

  test("a report whose first words are slow: Claude Code said it's working on it, so its silence is never taken for no answer", async () => {
    // A long conversation the API reads afresh can take minutes before its first word; here 1.5 s against a 0.3 s limit
    // for a Claude Code that hasn't started. (Taken for no answer, the process would go with the report in it.)
    ClaudeDriver.owedQuietMs = 300;
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_MS: "1500" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    await h.idle();
    expect(h.replies().at(-1)).toBe("The test suite passed. Carrying on with the plan: fixing the flaky test next.");
    expect(h.starts()).toHaveLength(1);
    const report = h.transcript().findIndex((l) => l.role === "user" && l.text.startsWith("<task-notification>"));
    expect(h.transcript()[report + 1]).toEqual({ role: "assistant", text: "The test suite passed. Carrying on with the plan: fixing the flaky test next.", model: "claude-opus-5", start: 1 });
  });

  test("a job that reports while the reply still works is taken in by that reply: the change applies as it ends", async () => {
    // Helpers usually report mid-reply (a workflow's agents, one by one): nothing is owed after it, so nothing waits.
    const h = hub({}, "claude-opus-5");
    h.say("Run the test suite in the background and carry on. BACKGROUND_JOB FOLDED SLOW:1000");
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until this reply and its helpers finish.");
    await h.idle();
    const ended = Date.now();
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply", 3000);
    expect(Date.now() - ended).toBeLessThan(2000); // the hub's 300 ms batching of task reports, never ClaudeDriver.owedQuietMs
    expect(h.replies()).toEqual(["Starting the test suite in the background.\n\nReading the plan while it runs.\n\nThe test suite passed. Carrying on with the plan: fixing the flaky test next."]);
    expect(h.starts()).toHaveLength(1);
  });

  test("a job that finishes as the reply's last request is on its way: that request hasn't its report, so the change waits for the turn that answers it", async () => {
    // Claude Code goes straight from the reply to the report, saying nothing until its first words (1.5 s, against a
    // 0.3 s limit for one that hasn't started): it never said "idle", so it's working on it.
    ClaudeDriver.owedQuietMs = 300;
    const h = hub({ FAKE_CLAUDE_WAKE_MS: "1500" }, "claude-opus-5");
    h.say("Run the test suite in the background and carry on. BACKGROUND_JOB LATE SLOW:1000");
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until this reply and its helpers finish.");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    await h.idle();
    expect(h.replies()).toEqual(["Starting the test suite in the background.\n\nI'll carry on with the plan when it finishes.", "The test suite passed. Carrying on with the plan: fixing the flaky test next."]);
    expect(h.notes().slice(-2)).toEqual(["Claude Code picked up where its helpers left off, with the settings it started with: your new settings apply once this reply finishes.", "Now on Opus 5.5: the next reply uses it."]);
    expect(h.starts()).toHaveLength(1);
    expect(h.transcript().some((l) => l.text === "No response requested.")).toBe(false);
  });

  test("the hub says it's busy while the job runs and while its report is owed, for the restart scripts (busy.json)", async () => {
    // Neither is in the database: before, the idle watcher restarted the hub under the job after five quiet minutes.
    const h = hub({ FAKE_CLAUDE_WAKE_MS: "1500" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    expect(h.app.engine.busyWork()).toEqual([{ roomId: h.chat.id, memberId: h.member.id, why: "background" }]);
    writeFileSync(h.files.jobDone, "");
    await until(() => h.job()?.status === "completed", "the hub to hear the job is done");
    expect(h.app.engine.busyWork()).toEqual([{ roomId: h.chat.id, memberId: h.member.id, why: "owed" }]);
    await until(() => h.replies().length === 2, "the report to be answered");
    await h.idle();
    expect(h.app.engine.busyWork()).toEqual([]);
  });

  test("Send now while the report is about to be answered by itself: it says so ('ownTurn'), and never 'try again' where the retry would be refused", async () => {
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_MS: "1500", FAKE_CLAUDE_WAKE_STREAM_MS: "2000" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.now().held?.owed === "report", "the report to be owed");
    h.say("What's next on the plan?");
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: false, why: "ownTurn", held: { change: "settings", helpers: true, owed: "report" } });
    // Tighter permissions as well: what holds the message is said first (it used to be "notYet", then "settings").
    h.app.updateMember(h.member.id, { permissionMode: "ask" }, "iPhone");
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: false, why: "helpers", held: { change: "permissions", helpers: true, owed: "report" } });
    expect(h.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
    // The report's reply is stopped as it starts, and the process on Ask carries on from it and answers the message.
    await until(() => h.starts().length === 2, "a process on the new settings");
    await h.idle();
    expect(flag(h.starts()[1], "--permission-mode")).toBe("default");
    expect(h.inputs().at(-1)).toContain("What's next on the plan?");
    expect(h.inputs().at(-1)).toContain("Your background work reported back (above)");
  });

  test("with the switch off, Send now or Answer now while the report is about to be answered by itself: it says so ('ownTurn'), and never 'try again' where the retry would be refused", async () => {
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_MS: "1500", FAKE_CLAUDE_WAKE_STREAM_MS: "2000" });
    h.app.setHubSettings({ messagesFlow: false });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.now().held?.owed === "report", "the report to be owed");
    h.say("What's next on the plan?");
    const owed: SendNowResult = { sent: false, why: "ownTurn", held: { change: "settings", helpers: true, owed: "report" } };
    expect(await h.app.engine.sendNowWhy(h.chat.id, null, { currentSettings: true })).toEqual(owed);
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual(owed);
    // Tighter permissions as well: what holds the message is said first (it used to be "notYet", then "settings").
    h.app.updateMember(h.member.id, { permissionMode: "ask" }, "iPhone");
    expect(await h.app.engine.sendNowWhy(h.chat.id, null, { currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change: "permissions", helpers: true, owed: "report" } });
    expect(h.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
    // The report's reply is stopped as it starts, and the process on Ask carries on from it and answers the message.
    await until(() => h.starts().length === 2, "a process on the new settings");
    await h.idle();
    expect(flag(h.starts()[1], "--permission-mode")).toBe("default");
    expect(h.inputs().at(-1)).toContain("What's next on the plan?");
    expect(h.inputs().at(-1)).toContain("Your background work reported back (above)");
  });

  test("with the switch off, a message while the job runs waits for it, so the new model applies first; Answer now answers it on the process as it is", async () => {
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_MS: "300" });
    h.app.setHubSettings({ messagesFlow: false });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.now().held).toEqual({ change: "settings", helpers: true });
    h.say("While that runs, what's next on the plan?");
    await Bun.sleep(100);
    expect(h.replies()).toHaveLength(1);
    expect(h.app.engine.queuedTurns(h.chat.id)).toHaveLength(1);
    expect(await h.app.engine.sendNowWhy(h.chat.id, null, { currentSettings: true })).toEqual({ sent: true });
    await until(() => h.replies().length === 2, "the answer");
    await h.idle();
    // The same process, job and all, and the chat says so.
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
    expect(h.notes()).toContain("Answering now with the settings Claude Code started with. Your changes apply once its helpers finish.");
    // The next one waits for the job this time: its report is answered on that process, then the new model applies first.
    h.say("And after that?");
    await Bun.sleep(100);
    expect(h.replies()).toHaveLength(2);
    expect(h.starts()).toHaveLength(1);
    writeFileSync(h.files.jobDone, "");
    await until(() => h.starts().length === 2, "a process on the new model");
    await h.idle();
    expect(flag(h.starts()[1], "--model")).toBe("claude-opus-5-5");
    expect(h.inputs().at(-1)).toContain("And after that?");
    expect(h.replies().filter((r) => r === "The test suite passed. Carrying on with the plan: fixing the flaky test next.")).toHaveLength(1);
    expect(h.transcript().some((l) => l.text === "No response requested.")).toBe(false);
  });

  test("flipping the switch on with a message held for the job: it goes now on that process, once, and the new model still waits for the job", async () => {
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_MS: "300" });
    h.app.setHubSettings({ messagesFlow: false });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    h.say("While that runs, what's next on the plan?");
    await Bun.sleep(100);
    expect(h.replies()).toHaveLength(1);
    h.app.setHubSettings({ messagesFlow: true });
    await until(() => h.replies().length === 2, "the answer");
    await h.idle();
    expect(h.inputs().filter((i) => i.includes("While that runs, what's next on the plan?"))).toHaveLength(1);
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
    // The model change's own note said when it applies: nothing more.
    expect(h.notes()).toEqual(["Model changed from Default to Opus 5.5 on iPhone. Claude Code answers on Opus 5 until its helpers finish."]);
    writeFileSync(h.files.jobDone, "");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    await h.idle();
  });

  test("the report's request is refused by the usage limit before any words: the reply waits for the limit, the change applies, and it carries on from the report on the new model", async () => {
    // The job finishes just as the 5-hour window runs out. (Before, nothing opened a reply for the refusal: "idle" settled
    // the report, the change applied, and the agent had stopped mid-plan with nothing said and nothing to carry on.)
    const h = hub({ FAKE_CLAUDE_RUN_MODELS: "claude-opus-5,", FAKE_CLAUDE_WAKE_LIMIT: "1" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.app.store.listTurns(h.chat.id).some((t) => t.status === "waiting"), "the reply to wait for the limit");
    const own = h.app.store.listTurns(h.chat.id).find((t) => t.status === "waiting")!;
    expect(own).toMatchObject({ triggerMessageId: null, wait: { kind: "usage", label: "5-hour" } });
    expect(h.now()).toMatchObject({ status: "waiting" });
    expect(h.notes()).toContain("Claude Code picked up where its helpers left off, with the settings it started with: your new settings apply once this reply finishes.");
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    // Try now (or the reset): it carries on in the same conversation, on the new model, told what it was taking up.
    h.app.engine.retry(h.chat.id);
    await h.idle();
    const [, second] = h.starts();
    expect(flag(second, "--model")).toBe("claude-opus-5-5");
    expect(flag(second, "--resume")).toBe(h.app.store.getMemberSession(h.member.id).sessionId as string);
    expect(h.inputs().at(-1)).toStartWith("(Crosstalk waited for your 5-hour usage limit to reset, and the user asked you to carry on now. What you were taking up when the limit stopped you (your background work reporting back, say) is above");
    expect(h.app.store.getTurn(own.id)?.status).toBe("stopped");
  });
});

describe("Stop while a job runs and a message went in by itself", () => {
  const MESSAGE = "ALSO delete the old build folder";
  /** A job at work and a reply on a long step, and a message that goes into it with no tap, waiting in Claude Code's queue. */
  async function wentIn(knobs: Record<string, string> = {}) {
    const h = hub({ FAKE_CLAUDE_QUEUE: "1", ...knobs });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.say("LONG_STEP: run the long check");
    await until(() => h.replies().at(-1) === "Running the long check.", "the long step");
    const yours = h.say(MESSAGE);
    await until(() => h.app.engine.queuedTurns(h.chat.id).length === 0, "the message to go in");
    expect(h.inputs().filter((i) => i === MESSAGE)).toHaveLength(1);
    return { h, yours };
  }
  const answers = (h: ReturnType<typeof hub>) => h.replies().filter((r) => r.includes(MESSAGE));
  /** Long enough for Claude Code to have started on a message it still held. */
  const settle = async (h: ReturnType<typeof hub>) => {
    await Bun.sleep(1200);
    await h.idle();
  };

  test("Stop everything stops: Claude Code hands the message back, it answers nothing by itself, and Answer now delivers it once", async () => {
    const { h, yours } = await wentIn();
    await h.app.engine.stop(h.chat.id);
    await settle(h);
    expect(h.interrupts()).toEqual([{ subtype: "interrupt", cancel_queued: true }]);
    // (Before: a second later "Claude Code is answering the message you sent." and the message was answered.)
    expect(answers(h)).toEqual([]);
    expect(h.notes()).toEqual([]);
    expect(h.app.store.listTurns(h.chat.id).map((t) => t.status)).toEqual(["done", "stopped", "stopped"]);
    // It's unread, with Answer now, and nothing is left owed that holds anything.
    expect(h.now().readSeq).toBeLessThan(yours.seq);
    expect(h.now().status).toBe("idle");
    expect(h.app.engine.busyWork()).toEqual([{ roomId: h.chat.id, memberId: h.member.id, why: "background" }]);
    h.app.engine.retry(h.chat.id);
    await until(() => answers(h).length === 1, "Answer now to deliver it");
    await h.idle();
    expect(answers(h)).toHaveLength(1);
    expect(h.now().readSeq).toBeGreaterThanOrEqual(yours.seq);
    // The same process throughout, job and all.
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.job()?.status === "completed", "the job to finish");
    await h.idle();
  });

  describe("with the switch off", () => {
    /** The same, but nothing goes in by itself: Send now puts the message into Claude Code's queue. */
    async function tapped() {
      const h = hub({ FAKE_CLAUDE_QUEUE: "1" });
      h.app.setHubSettings({ messagesFlow: false });
      h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
      await h.idle();
      await until(() => h.job()?.status === "running", "the job to be reported running");
      h.say("LONG_STEP: run the long check");
      await until(() => h.replies().at(-1) === "Running the long check.", "the long step");
      const yours = h.say(MESSAGE);
      // It stays behind the reply until tapped.
      await Bun.sleep(100);
      expect(h.app.engine.queuedTurns(h.chat.id)).toHaveLength(1);
      expect(h.inputs()).not.toContain(MESSAGE);
      expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
      expect(h.inputs().filter((i) => i === MESSAGE)).toHaveLength(1);
      return { h, yours };
    }
    const end = async (h: ReturnType<typeof hub>) => {
      writeFileSync(h.files.jobDone, "");
      await until(() => h.job()?.status === "completed", "the job to finish");
      await h.idle();
    };

    test("Stop everything: Claude Code hands the message back, it answers nothing by itself, and Answer now delivers it once", async () => {
      const { h, yours } = await tapped();
      await h.app.engine.stop(h.chat.id);
      await settle(h);
      expect(h.interrupts()).toEqual([{ subtype: "interrupt", cancel_queued: true }]);
      expect(answers(h)).toEqual([]);
      expect(h.now().readSeq).toBeLessThan(yours.seq);
      h.app.engine.retry(h.chat.id, null, { currentSettings: true });
      await until(() => answers(h).length === 1, "Answer now to deliver it");
      await h.idle();
      expect(answers(h)).toHaveLength(1);
      expect(h.starts()).toHaveLength(1);
      expect(h.job()?.status).toBe("running");
      await end(h);
    });

    test("Stop and answer my message: answered next, on the same process, with the job alive", async () => {
      const { h, yours } = await tapped();
      await h.app.engine.stop(h.chat.id, undefined, { keepWaiting: true });
      await until(() => answers(h).length === 1, "the answer");
      await h.idle();
      expect(answers(h)).toHaveLength(1);
      expect(h.now().readSeq).toBeGreaterThanOrEqual(yours.seq);
      expect(h.starts()).toHaveLength(1);
      expect(h.job()?.status).toBe("running");
      await end(h);
    });

    test("new settings waiting too: Stop everything, then Answer now under the message goes on that process, and says so", async () => {
      const { h, yours } = await tapped();
      h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
      await h.app.engine.stop(h.chat.id);
      await settle(h);
      expect(answers(h)).toEqual([]);
      expect(h.now().readSeq).toBeLessThan(yours.seq);
      expect(h.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
      h.app.engine.retry(h.chat.id, null, { currentSettings: true });
      await until(() => answers(h).length === 1, "Answer now to deliver it");
      await h.idle();
      expect(h.starts()).toHaveLength(1);
      expect(h.notes().at(-1)).toBe("Answering now with the settings Claude Code started with. Your changes apply once its helpers finish.");
      await end(h);
    });
  });

  test("a receipt that comes after the reply has ended still counts: the reply waits for it, and the message is unread as it ends", async () => {
    const { h, yours } = await wentIn({ FAKE_CLAUDE_RECEIPT_MS: "150" });
    await h.app.engine.stop(h.chat.id);
    await settle(h);
    expect(answers(h)).toEqual([]);
    expect(h.now().readSeq).toBeLessThan(yours.seq);
    expect(h.notes()).toEqual([]);
    h.app.engine.retry(h.chat.id);
    await until(() => answers(h).length === 1, "Answer now to deliver it");
    await h.idle();
    expect(h.starts()).toHaveLength(1);
  });

  test("Stop and answer my message: answered next, on the same process, with the job alive", async () => {
    const { h, yours } = await wentIn();
    await h.app.engine.stop(h.chat.id, undefined, { keepWaiting: true });
    await until(() => answers(h).length === 1, "the answer");
    await h.idle();
    await Bun.sleep(300);
    expect(answers(h)).toHaveLength(1);
    expect(h.notes()).toEqual([]);
    expect(h.now().readSeq).toBeGreaterThanOrEqual(yours.seq);
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.job()?.status === "completed", "the job to finish");
    await h.idle();
  });

  test("a Claude Code that can't take it back (no interrupt_cancel_queued_v1): it answers the message by itself, once, as it always has", async () => {
    const { h } = await wentIn({ FAKE_CLAUDE_NO_CANCEL_QUEUED: "1" });
    await h.app.engine.stop(h.chat.id);
    await until(() => answers(h).length === 1, "the answer");
    await h.idle();
    expect(h.interrupts()).toEqual([{ subtype: "interrupt" }]);
    expect(h.notes()).toEqual(["Claude Code is answering the message you sent."]);
    expect(answers(h)).toHaveLength(1);
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
  });

  test("a report queued as Stop comes is never dropped with the message (cancel_queued takes those too): it's a plain interrupt, and the message is answered by itself", async () => {
    // The job finishes during the long step, so its report waits in Claude Code's queue, which only that process holds.
    const h = hub({ FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_NO_WAKE: "1" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.say("LONG_STEP: run the long check");
    await until(() => h.replies().at(-1) === "Running the long check.", "the long step");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.job()?.status === "completed", "the job's report");
    // Nothing keeps helpers at work now, so this is a tap.
    h.say(MESSAGE);
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
    await h.app.engine.stop(h.chat.id);
    await until(() => answers(h).length === 1, "the answer");
    await h.idle();
    expect(h.interrupts()).toEqual([{ subtype: "interrupt" }]);
    expect(answers(h)).toHaveLength(1);
    expect(h.starts()).toHaveLength(1);
  });

  test("a message sent as the old turn winds down: it waits for that turn instead of ending the process, job and all", async () => {
    // Stop only writes the request, so the hub is ready for the next turn long before Claude Code has stopped.
    const h = hub({ FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_STOP_MS: "600" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.say("LONG_STEP: run the long check");
    await until(() => h.replies().at(-1) === "Running the long check.", "the long step");
    const stopping = h.app.engine.stop(h.chat.id);
    h.say(MESSAGE);
    await stopping;
    await until(() => answers(h).length === 1, "the answer");
    await h.idle();
    // (Before: a second process, the job gone with the first and still listed as running, for good.)
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
    expect(answers(h)).toHaveLength(1);
    expect(h.notes()).toEqual([]);
    writeFileSync(h.files.jobDone, "");
    await until(() => h.job()?.status === "completed", "the job to finish");
    await h.idle();
  });

  test("nothing goes to a turn that's being stopped: a message sent meanwhile waits until the next one can take it", async () => {
    const h = hub({ FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_STOP_MS: "800" });
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.say("LONG_STEP: run the long check");
    await until(() => h.replies().at(-1) === "Running the long check.", "the long step");
    const stopping = h.app.engine.stop(h.chat.id);
    h.say("Do this instead");
    await stopping;
    // The next reply waits for the old turn to settle, and a message sent now goes into neither.
    h.say(MESSAGE);
    await Bun.sleep(100);
    expect(h.inputs().filter((i) => i === MESSAGE || i === "Do this instead")).toEqual([]);
    await until(() => answers(h).length === 1, "the answer");
    await h.idle();
    expect(h.replies().filter((r) => r.includes("Do this instead"))).toHaveLength(1);
    expect(answers(h)).toHaveLength(1);
    expect(h.notes()).toEqual([]);
    expect(h.starts()).toHaveLength(1);
    expect(h.job()?.status).toBe("running");
  });

  test("one that doesn't stop in time still goes, after the grace time: the job is listed as stopped, the chat says it's lost, once, and nothing holds on it", async () => {
    ClaudeDriver.graceMs = 300;
    const h = hub({ FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_STOP_MS: "60000" }, "claude-opus-5");
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    h.say("LONG_STEP: run the long check");
    await until(() => h.replies().at(-1) === "Running the long check.", "the long step");
    const stopping = h.app.engine.stop(h.chat.id);
    h.say(MESSAGE);
    await stopping;
    await until(() => h.job()?.status === "stopped", "the job to be listed as stopped");
    await h.idle();
    expect(h.starts()).toHaveLength(2);
    expect(answers(h)).toHaveLength(1);
    const lost = 'Claude Code\'s process ended. It was running the command "Run the test suite" in the background. That ended with the old process, so what it was doing is lost: ask again if you still need it.';
    expect(h.notes()).toEqual([lost]);
    expect(h.app.engine.busyWork()).toEqual([]);
  });
});

describe("a process that crashes with a job at work", () => {
  const LOST = 'Claude Code\'s process ended. It was running the command "Run the test suite" in the background. That ended with the old process, so what it was doing is lost: ask again if you still need it.';
  async function jobRunning(model: string | null = null) {
    const h = hub({ FAKE_CLAUDE_QUEUE: "1" }, model);
    h.say("Run the full test suite in the background, then carry on with the plan. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    return h;
  }
  const crash = (h: ReturnType<typeof hub>) => (h.app.engine as unknown as { drivers: Map<string, { proc: { kill(signal: number): void } }> }).drivers.get(h.member.id)!.proc.kill(9);

  test("the job is listed as stopped, the chat says it's lost, and nothing is left saying it's busy", async () => {
    const h = await jobRunning();
    crash(h);
    await until(() => h.job()?.status === "stopped", "the job to be listed as stopped");
    expect(h.job()).toMatchObject({ status: "stopped", error: "Stopped when Claude Code's process ended." });
    expect(h.notes()).toEqual([LOST]);
    expect(h.app.engine.busyWork()).toEqual([]);
    // The next message starts a new process, in the same conversation.
    h.say("Carry on");
    await h.idle();
    expect(h.starts()).toHaveLength(2);
    expect(flag(h.starts()[1], "--resume")).toBe(h.app.store.getMemberSession(h.member.id).sessionId as string);
    expect(h.notes()).toEqual([LOST]); // said once, whatever noticed first
  });

  test("a model change held for that job applies: 'Finishing helpers…' clears", async () => {
    const h = await jobRunning("claude-opus-5");
    h.app.updateMember(h.member.id, { model: "claude-opus-5-5" }, "iPhone");
    expect(h.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
    crash(h);
    await until(() => h.notes().includes("Now on Opus 5.5: the next reply uses it."), "the new model to apply");
    expect(h.notes()).toContain(LOST);
    expect(h.now().held).toBeUndefined();
    expect(h.now()).toMatchObject({ status: "idle", statusDetail: null });
    h.say("Carry on");
    await h.idle();
    expect(flag(h.starts()[1], "--model")).toBe("claude-opus-5-5");
  });

  test("tighter permissions held for that job: the message that waited for them goes", async () => {
    const h = await jobRunning();
    h.app.updateMember(h.member.id, { permissionMode: "ask" }, "iPhone");
    h.say("Delete the old build folder");
    await Bun.sleep(30);
    expect(h.starts()).toHaveLength(1);
    expect(h.app.engine.queuedTurns(h.chat.id)).toHaveLength(1);
    crash(h);
    await until(() => h.starts().length === 2, "a process on the new permissions");
    await h.idle();
    expect(flag(h.starts()[1], "--permission-mode")).toBe("default");
    expect(h.replies().some((r) => r.includes("Delete the old build folder"))).toBe(true);
  });

  test("a message it had in its queue goes back to the person: the reply fails, and it's unread with Try again", async () => {
    const h = await jobRunning();
    h.say("LONG_STEP: run the long check");
    await until(() => h.replies().at(-1) === "Running the long check.", "the long step");
    const yours = h.say("ALSO delete the old build folder");
    await until(() => h.app.engine.queuedTurns(h.chat.id).length === 0, "the message to go in");
    crash(h);
    await until(() => h.now().status === "error", "the reply to fail");
    expect(h.now().readSeq).toBeLessThan(yours.seq);
    h.app.engine.retry(h.chat.id);
    await until(() => h.replies().some((r) => r.includes("ALSO delete the old build folder")), "Try again to deliver it");
    await h.idle();
  });
});

describe("a change the old process may not answer on, waiting for its background job: its continuation never runs there", () => {
  /** The job's chat on Full, the job started and running; the report's answer takes 2 s after its first word. */
  async function jobRunning(knobs: Record<string, string> = {}) {
    const h = hub({ FAKE_CLAUDE_WAKE_MS: "300", FAKE_CLAUDE_WAKE_STREAM_MS: "2000", ...knobs });
    h.say("Run the full test suite in the background, then push and deploy. BACKGROUND_JOB");
    await h.idle();
    await until(() => h.job()?.status === "running", "the job to be reported running");
    return h;
  }
  const reportAt = (h: ReturnType<typeof hub>) => h.transcript().findIndex((l) => l.role === "user" && l.text.startsWith("<task-notification>"));

  test("switched from Full to Ask: the report's reply is stopped before it does anything, and a process on Ask carries on from the report", async () => {
    const h = await jobRunning();
    h.app.updateMember(h.member.id, { permissionMode: "ask" }, "iPhone");
    expect(h.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your permission change applies", held: { change: "permissions", helpers: true } });
    writeFileSync(h.files.jobDone, "");
    await until(() => h.starts().length === 2, "a process on the new permissions");
    await h.idle();
    // The process started with --dangerously-skip-permissions answered nothing after the report: its reply was stopped
    // at its first word. (Before, the whole continuation ran there: every command unapproved.)
    const [first, second] = h.starts();
    expect(first).toContain("--dangerously-skip-permissions");
    expect(second).not.toContain("--dangerously-skip-permissions");
    expect(flag(second, "--permission-mode")).toBe("default");
    expect(flag(second, "--resume")).toBe(h.app.store.getMemberSession(h.member.id).sessionId as string);
    const after = h.transcript().slice(reportAt(h) + 1);
    expect(after.filter((l) => l.role === "assistant" && l.start === 1)).toEqual([]);
    // The new process resumes the conversation that holds the report, told to carry on from it.
    expect(h.inputs().at(-1)).toStartWith("(Your background work reported back (above), and the user changed this chat's settings meanwhile, so Crosstalk started you again in this same conversation with the new settings.");
    expect(after.some((l) => l.role === "assistant" && l.start === 2 && l.model !== "<synthetic>")).toBe(true);
    expect(h.notes()).toEqual(["Claude Code's helpers reported back. Your permission change applies first: Claude Code starts again under your new permissions and carries on from their report."]);
    expect(h.notes().some((n) => n.includes("with the settings it started with"))).toBe(false);
    expect(h.replies()).toHaveLength(2);
    expect(h.app.store.listTurns(h.chat.id).map((t) => t.status)).toEqual(["done", "done"]);
    expect(h.now()).toMatchObject({ status: "idle" });
    expect(h.now().held).toBeUndefined();
  });

  test("moved to another account: the old account's process is let go as the job reports, and the chat says its report wasn't answered", async () => {
    const h = await jobRunning({ FAKE_CLAUDE_WAKE_MS: "1500" });
    const work = h.app.providers.setEndpointAccount("claude", { label: "Work server", baseUrl: "http://127.0.0.1:9", models: ["work-model"] });
    h.app.updateMember(h.member.id, { config: { ...h.now().config, account: work.id }, model: "work-model" }, "iPhone");
    expect(h.now()).toMatchObject({ statusDetail: "Finishing helpers before your account switch applies", held: { change: "account", helpers: true } });
    writeFileSync(h.files.jobDone, "");
    const said = "Claude Code's helpers reported back after you switched accounts. The new account starts a fresh session without that conversation, so their report wasn't answered: ask again if you still need it.";
    await until(() => h.notes().includes(said), "the chat to say the report didn't carry over");
    await Bun.sleep(1800); // past when the old process would have answered it
    // Nothing ran on the account the person moved away from after the job: no reply, nothing in its session.
    expect(h.transcript().slice(reportAt(h) + 1)).toEqual([]);
    expect(h.replies()).toHaveLength(1);
    expect(h.now().held).toBeUndefined();
    expect(h.now().status).toBe("idle");
    // The next message starts the new account's fresh session.
    h.say("Carry on");
    await h.idle();
    expect(h.starts()).toHaveLength(2);
    expect(flag(h.starts()[1], "--resume")).toBeNull();
  });

  test("moved to a new folder: the report's reply is stopped before it does anything, and the agent carries on from the report in the new folder", async () => {
    const h = await jobRunning();
    const moved = join(dirname(h.files.args), "moved");
    mkdirSync(moved, { recursive: true });
    h.app.updateRoom(h.chat.id, { cwd: moved });
    await until(() => h.now().held?.change === "other", "the folder change to wait");
    writeFileSync(h.files.jobDone, "");
    await until(() => h.starts().length === 2, "a process in the new folder");
    await h.idle();
    expect(h.cwds()[1]).toBe(realpathSync(moved));
    expect(flag(h.starts()[1], "--resume")).toBe(h.app.store.getMemberSession(h.member.id).sessionId as string);
    expect(h.transcript().slice(reportAt(h) + 1).filter((l) => l.role === "assistant" && l.start === 1)).toEqual([]);
    expect(h.inputs().at(-1)).toStartWith("(Your background work reported back (above)");
    expect(h.notes()).toEqual(["Claude Code's helpers reported back. Your changes apply first: Claude Code starts again with your changes and carries on from their report."]);
  });
});

describe("Claude Code's driver says when it owes a turn of its own", () => {
  /** The driver alone, on the fake, with the hub's side played by the test. */
  /** `answer`: what the hub says when Claude Code starts a reply of its own (true: show it; "stop": it mustn't run here). */
  function driver(knobs: Record<string, string> = {}, answer: true | "stop" = true) {
    const dir = temp("ct-wake-driver-");
    const done = join(dir, "job-done");
    const transcript = join(dir, "transcript.jsonl");
    const reports: BackgroundTask[][] = [];
    const own: { why: string; result: Promise<TurnResult> }[] = [];
    const stops: { why: string; owed: string | null | undefined; owedAfter?: string | null; canEndAfter?: boolean }[] = [];
    const sink = () => ({ text() {}, setText() {}, activity: () => "a", updateActivity() {}, approval: async () => "deny" as const, usage() {}, rateLimit() {}, status() {}, saveSession() {}, signal: new AbortController().signal }) as unknown as TurnSink;
    const ctx = {
      room: { id: "r1", name: "Release prep", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false },
      member: { id: "m1", roomId: "r1", handle: "claude", provider: "claude", model: "claude-opus-5", role: "", permissionMode: "full", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 },
      session: {},
      mcp: { command: "true", args: [], env: {} },
      env: { PATH: process.env.PATH ?? "", FAKE_CLAUDE_JOB_DONE: done, FAKE_CLAUDE_TRANSCRIPT: transcript, ...knobs },
      bin: FAKE,
      chat: { helper: null },
      onTasks: (t) => reports.push(t),
      onOwnTurn: (run, why, owed) => {
        if (answer === true) return (own.push({ why, result: run(sink()) }), true);
        // What the driver says just after (before Claude Code can have answered the interrupt).
        const stop = { why, owed, owedAfter: undefined as string | null | undefined, canEndAfter: undefined as boolean | undefined };
        stops.push(stop);
        queueMicrotask(() => Object.assign(stop, { owedAfter: d.owedTurn(), canEndAfter: d.canEndWhenIdle() }));
        return "stop" as const;
      },
    } as DriverContext;
    const d = new ClaudeDriver(ctx, FAKE);
    cleanups.push(() => d.dispose());
    return { d, done, reports, own, stops, sink, transcript: () => lines<Line>(transcript) };
  }

  test("a reply of its own the hub says mustn't run here is stopped at its first word: nothing of it shows, and it counts as owed until it has", async () => {
    // Its answer would take 3 s after its first word: it's interrupted long before, and never written into the session.
    const { d, done, reports, own, stops, sink, transcript } = driver({ FAKE_CLAUDE_WAKE_MS: "200", FAKE_CLAUDE_WAKE_STREAM_MS: "3000" }, "stop");
    await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB", systemNote: null }, sink());
    writeFileSync(done, "");
    await until(() => stops.length === 1, "Claude Code to start on the report");
    // While it's being stopped it still counts as owed, so the hub neither replaces nor ends the process under it.
    expect(stops[0]).toEqual({ why: "Claude Code picked up where its helpers left off.", owed: "report", owedAfter: "report", canEndAfter: false });
    const heard = reports.length;
    // Stopped long before its answer would have come (3 s), and the hub hears so.
    await until(() => d.owedTurn() === null && d.canEndWhenIdle(), "it to stop", 1500);
    await until(() => reports.length > heard, "the hub to hear it has stopped");
    expect(d.canEndWhenIdle()).toBe(true);
    expect(own).toEqual([]);
    // In the session: the report, and no answer to it.
    const report = transcript().findIndex((l) => l.role === "user" && l.text.startsWith("<task-notification>"));
    expect(report).toBeGreaterThan(0);
    expect(transcript().slice(report + 1)).toEqual([]);
  });

  test("from a background job's report until Claude Code starts on it, and it isn't ended for being idle meanwhile", async () => {
    const { d, done, reports, own, sink } = driver({ FAKE_CLAUDE_WAKE_MS: "1500" });
    expect(await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB", systemNote: null }, sink())).toMatchObject({ ok: true });
    expect(d.owedTurn()).toBeNull();
    expect(d.canEndWhenIdle()).toBe(false); // its job runs
    writeFileSync(done, "");
    await until(() => reports.at(-1)?.[0]?.status === "completed", "the job's report");
    expect(d.owedTurn()).toBe("report");
    expect(d.canEndWhenIdle()).toBe(false);
    await until(() => own.length === 1, "Claude Code to start on it");
    expect(d.owedTurn()).toBeNull();
    expect(own[0].why).toBe("Claude Code picked up where its helpers left off.");
    expect(await own[0].result).toMatchObject({ ok: true });
    expect(d.canEndWhenIdle()).toBe(true);
  });

  test("a report the reply that's running takes in with a request put together after it isn't owed after it", async () => {
    const { d, sink } = driver();
    expect(await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB FOLDED", systemNote: null }, sink())).toMatchObject({ ok: true });
    expect(d.owedTurn()).toBeNull();
    expect(d.canEndWhenIdle()).toBe(true);
  });

  test("a report that came in as the reply's last request was on its way is still owed after the reply, until its own turn", async () => {
    const { d, own, sink } = driver({ FAKE_CLAUDE_WAKE_MS: "1500" });
    expect(await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB LATE", systemNote: null }, sink())).toMatchObject({ ok: true });
    expect(d.owedTurn()).toBe("report");
    expect(d.canEndWhenIdle()).toBe(false);
    await until(() => own.length === 1, "Claude Code to answer it in a turn of its own");
    expect(d.owedTurn()).toBeNull();
    expect(await own[0].result).toMatchObject({ ok: true });
  });

  test("a report it takes in without a word stops counting when it says it's idle, and the hub hears so", async () => {
    ClaudeDriver.owedQuietMs = 60_000;
    const { d, done, reports, own, sink } = driver({ FAKE_CLAUDE_NO_WAKE: "1" });
    await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB", systemNote: null }, sink());
    const heard = reports.length;
    writeFileSync(done, "");
    await until(() => reports.length > heard && reports.at(-1)?.[0]?.status === "completed", "the hub to hear the job is done");
    expect(d.owedTurn()).toBeNull();
    expect(d.canEndWhenIdle()).toBe(true);
    expect(own).toHaveLength(0);
  });

  test("from a Claude Code that never says its state, a report it doesn't start on stops counting once it has shown no sign of starting, and the hub hears so", async () => {
    ClaudeDriver.owedQuietMs = 300;
    const { d, done, reports, sink } = driver({ FAKE_CLAUDE_NO_WAKE: "1", FAKE_CLAUDE_NO_STATE: "1" });
    await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB", systemNote: null }, sink());
    writeFileSync(done, "");
    await until(() => d.owedTurn() === "report", "the job's report");
    const heard = reports.length;
    await until(() => d.owedTurn() === null, "the report to stop counting", 3000);
    await until(() => reports.length > heard, "the hub to hear it");
    expect(d.canEndWhenIdle()).toBe(true);
  });

  test("once Claude Code says it's working on the report, a first word slower than the quiet limit still counts", async () => {
    ClaudeDriver.owedQuietMs = 200;
    const { d, done, own, sink } = driver({ FAKE_CLAUDE_WAKE_MS: "1200" });
    await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB", systemNote: null }, sink());
    writeFileSync(done, "");
    await until(() => d.owedTurn() === "report", "the job's report");
    await Bun.sleep(600); // three quiet limits: still owed
    expect(d.owedTurn()).toBe("report");
    expect(d.canEndWhenIdle()).toBe(false);
    await until(() => own.length === 1, "Claude Code to start on it");
    expect(d.owedTurn()).toBeNull();
    expect(await own[0].result).toMatchObject({ ok: true });
  });

  test("a report whose request is refused before any words still opens its turn, which fails with the limit for the hub to wait on", async () => {
    const { d, done, own, sink } = driver({ FAKE_CLAUDE_WAKE_LIMIT: "1", FAKE_CLAUDE_WAKE_MS: "200" });
    await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_JOB", systemNote: null }, sink());
    writeFileSync(done, "");
    await until(() => own.length === 1, "the refused request to open its turn");
    expect(own[0].why).toBe("Claude Code picked up where its helpers left off.");
    expect(await own[0].result).toMatchObject({ ok: false, limit: { kind: "usage", label: "5-hour" } });
    expect(d.owedTurn()).toBeNull();
  });

  test("a task a restart left behind wakes nothing: its report isn't owed", async () => {
    const { d, sink } = driver();
    expect(await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, sink())).toMatchObject({ ok: true });
    // As Claude Code says it of a task the process before it left running (a resumed one says so in the conversation).
    d.handle({ type: "system", subtype: "task_notification", task_id: "b0rphan", status: "stopped", reason: "worker_restart", output_file: "", summary: "Stopped by a worker restart: Run the test suite" });
    expect(d.owedTurn()).toBeNull();
    d.handle({ type: "system", subtype: "task_notification", task_id: "amb1", status: "completed", ambient: true, output_file: "", summary: "Memory updated" });
    expect(d.owedTurn()).toBeNull();
  });
});

describe("Crosstalk's own agent never keeps a message for later (it starts no reply by itself)", () => {
  const KEY = "sk-nano-test-key-0001";
  const PICK = "deepseek/deepseek-v4.1-flash-uncensored";
  const OTHER = "z-ai/glm-5.3-flash";

  /**
   * Its chat on the stand-in NanoGPT, whose answer to request number `holdAt` (from 0: its first) waits until `release`
   * (so Send now lands while it's on its way).
   */
  async function agentChat(replies: ScriptedReply[], holdAt = 0) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked = 0;
    let holding = false;
    const gated = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/chat/completions") && asked++ === holdAt) {
        holding = true;
        await held;
      }
      return fetch(url, init);
    }) as typeof fetch;
    registerProvider(builtinProvider);
    // Never the browser the person works in, never a real service.
    registerDriver("builtin", (ctx) => new BuiltinDriver(ctx, { browserUrl: async () => null, fetch: gated }));
    cleanups.push(() => registerDriver("builtin", (ctx) => new BuiltinDriver(ctx, { browserUrl: async () => null })));
    const fake = fakeNanoGpt({ key: KEY, replies });
    cleanups.push(() => fake.stop());
    const dir = temp("ct-wake-agent-");
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    cleanups.push(() => app.shutdown());
    app.services.timeoutMs = 1500;
    app.services.nanogpt.origin = fake.url;
    await app.providers.refresh("builtin");
    const account = app.providers.setEndpointAccount("builtin", { label: "NanoGPT", baseUrl: fake.base, apiKey: KEY, models: [PICK, OTHER], contextWindow: 1_048_576, protocol: "chat" });
    const chat = app.chats.create({ provider: "builtin", account: account.id, model: PICK, permissionMode: "full", cwd: join(dir, "project") } as never);
    const member = app.store.listMembers(chat.id)[0];
    return {
      app,
      fake,
      chat,
      member,
      release,
      holding: () => holding,
      say: (text: string) => app.engine.postHumanMessage(chat.id, text, "iPhone"),
      idle: async () => {
        await Bun.sleep(20);
        await app.engine.whenIdle();
        await Bun.sleep(20);
      },
      notes: () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "system").map((m) => m.text),
      replies: () => app.store.listMessages(chat.id).filter((m) => m.authorKind === "agent").map((m) => m.text),
      now: (): Member => app.store.getMember(member.id)!,
    };
  }

  test("handed over as its last answer is written, it's read in the same reply, on the settings it started with; a new model waiting applies after", async () => {
    const h = await agentChat([{ text: "Here is the plan: retry the network call twice." }, { text: "The retry count is fine: two retries are enough." }, { text: "You're welcome." }]);
    h.say("Fix the flaky test");
    await until(h.holding, "its first answer to be on its way");
    h.app.updateMember(h.member.id, { model: OTHER }, "iPhone");
    expect(h.notes().at(-1)).toEndWith("until this reply finishes.");
    h.say("Also check the retry count");
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
    expect(h.notes().at(-1)).toStartWith("Answering now with the settings");
    h.release();
    await until(() => h.notes().some((n) => n.startsWith("Now on")), "the new model to apply");
    await h.idle();
    // Read before that reply ended, answered below it. (Before, the reply ended with the message only in the driver,
    // counted read, and the new model's driver never had it.)
    expect(h.replies()).toEqual(["Here is the plan: retry the network call twice.", "The retry count is fine: two retries are enough."]);
    const [first, second] = h.fake.state.chats;
    expect([first.model, second.model]).toEqual([PICK, PICK]);
    expect(second.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Also check the retry count") });
    h.say("Thanks");
    await h.idle();
    expect(h.fake.state.chats.map((c) => c.model)).toEqual([PICK, PICK, OTHER]);
    expect(h.replies().at(-1)).toBe("You're welcome.");
  });

  const handedIn = (h: { app: App; chat: { id: string } }, text: string) => h.app.store.listMessages(h.chat.id).find((m) => m.text === text)!;
  const asksWith = (chat: Record<string, unknown> | undefined, text: string) => ((chat?.messages ?? []) as { role: string; content: unknown }[]).some((m) => m.role === "user" && String(m.content).includes(text));

  test("handed over while a reply's request is on its way, and the service refuses the model: unread again, and the next try on the model picked since carries it", async () => {
    const h = await agentChat([{ status: 404, error: "model not found" }, { text: "The retry count is fine: two retries are enough." }]);
    h.say("Fix the flaky test");
    await until(h.holding, "its request to be on its way");
    h.say("Also check the retry count");
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
    h.release();
    await h.idle();
    expect(h.replies()[0]).toStartWith("⚠️ NanoGPT doesn't have the model");
    // Nothing answered it, so it isn't counted read (before, it was, and it lived only in the driver).
    expect(h.now().readSeq).toBeLessThan(handedIn(h, "Also check the retry count").seq!);
    // The person picks another model, as the words say, and taps Try again: the new driver's request carries it.
    h.app.updateMember(h.member.id, { model: OTHER }, "iPhone");
    h.app.engine.retry(h.chat.id);
    await h.idle();
    expect(h.fake.state.chats.map((c) => c.model)).toEqual([PICK, OTHER]);
    expect(asksWith(h.fake.state.chats[1], "Also check the retry count")).toBe(true);
    expect(h.replies().at(-1)).toBe("The retry count is fine: two retries are enough.");
    expect(h.now().readSeq).toBeGreaterThanOrEqual(handedIn(h, "Also check the retry count").seq!);
  });

  test("handed over, then the reply is stopped before it read it: unread again, and the next message brings it along", async () => {
    const h = await agentChat([{ text: "The retry count is fine, and you're welcome." }]);
    h.say("Fix the flaky test");
    await until(h.holding, "its request to be on its way");
    h.say("Also check the retry count");
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: true });
    await h.app.engine.stop(h.chat.id);
    h.release();
    await h.idle();
    expect(h.app.store.listTurns(h.chat.id).map((t) => t.status)).toEqual(["stopped", "stopped"]); // the reply, and the turn Send now took the message from
    expect(h.now().readSeq).toBeLessThan(handedIn(h, "Also check the retry count").seq!);
    h.say("Thanks");
    await h.idle();
    // The stopped request never reached NanoGPT; the next one carries both messages.
    expect(h.fake.state.chats).toHaveLength(1);
    expect(asksWith(h.fake.state.chats[0], "Also check the retry count")).toBe(true);
    expect(asksWith(h.fake.state.chats[0], "Thanks")).toBe(true);
  });

  test("Send now during /compact: it can't take the message (it's a summary, not an answer), and the reply after it answers it", async () => {
    const h = await agentChat([{ text: "Retry the network call twice." }, { text: "The fix is in and the tests pass." }, { text: "The flaky test was planned and fixed." }, { text: "The retry count is fine: two retries are enough." }], 2);
    h.say("Fix the flaky test");
    await h.idle();
    h.say("Make the change");
    await h.idle();
    h.say("/compact");
    await until(h.holding, "the summary's request to be on its way");
    h.say("Also check the retry count");
    expect(await h.app.engine.sendNowWhy(h.chat.id)).toEqual({ sent: false, why: "unsupported" });
    h.release();
    await h.idle();
    expect(h.replies().slice(-2)).toEqual(["Done: the conversation so far is summarised, and the chat goes on from the summary.", "The retry count is fine: two retries are enough."]);
    // The summary's request had no message of the person's in it; the reply after it did.
    expect(asksWith(h.fake.state.chats[2], "Also check the retry count")).toBe(false);
    expect(asksWith(h.fake.state.chats[3], "Also check the retry count")).toBe(true);
  });
});
