// Each chat's agent process stays alive between turns (a few hundred MB each). One with nothing to do for a while is
// ended, and the next message starts a fresh one that resumes the session. Never while it works on its own.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTask, Member, Room } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import type { AgentDriver, DriverContext } from "../src/agents/driver";
import { ClaudeDriver, nextCronTime } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import { newId } from "../src/util/ids";

const FIX = join(import.meta.dir, "fixtures");

function setup(createDriver: (ctx: DriverContext) => AgentDriver, cwd = "/tmp") {
  const store = new Store(":memory:");
  const engine = new Engine({ store, bus: new Bus(), idleEndMs: 120, createDriver, mcpLaunch: () => ({ command: "true", args: [], env: {} }) });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "Chat", cwd, mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
  const member: Member = { id: newId("mb"), roomId: room.id, handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 };
  store.insertMember(member);
  return { store, engine, room, member };
}

describe("ending idle agent processes", () => {
  test("an idle process is ended; the next message starts a fresh one with the saved session", async () => {
    const made: { ctx: DriverContext; disposed: boolean; tasks: (t: BackgroundTask[]) => void }[] = [];
    let ok = true;
    let hold: Promise<void> | null = null;
    const t = setup((ctx) => {
      const d = { ctx, disposed: false, tasks: (x: BackgroundTask[]) => ctx.onTasks?.(x) };
      made.push(d);
      return {
        provider: "mock",
        runTurn: async (_input, sink) => {
          sink.saveSession({ sessionId: "session-1" });
          if (hold) await hold;
          return { ok: true, text: "Done." };
        },
        interrupt: async () => {},
        canEndWhenIdle: () => ok,
        dispose: async () => {
          d.disposed = true;
        },
      };
    });
    t.engine.postHumanMessage(t.room.id, "first", "Mac");
    await t.engine.whenIdle();
    await Bun.sleep(400);
    expect(made.length).toBe(1);
    expect(made[0].disposed).toBe(true); // ended while idle
    t.engine.postHumanMessage(t.room.id, "second", "Mac");
    await t.engine.whenIdle();
    expect(made.length).toBe(2);
    expect(made[1].ctx.session.sessionId).toBe("session-1"); // the new process resumes the conversation

    // Background work running: kept, however long; ended once it's done.
    const helper: BackgroundTask = { id: "task1", kind: "local_agent", description: "Check the build", agentType: null, workflow: null, background: true, status: "running", startedAt: Date.now(), endedAt: null, tokens: null, toolUses: null, lastTool: null, summary: null, error: null };
    made[1].tasks([helper]);
    await Bun.sleep(400);
    expect(made[1].disposed).toBe(false);
    made[1].tasks([{ ...helper, status: "completed", endedAt: Date.now() }]);
    await Bun.sleep(400);
    expect(made[1].disposed).toBe(true);

    // The driver can refuse (its session is open in another app); a long turn is never cut off.
    t.engine.postHumanMessage(t.room.id, "third", "Mac");
    await t.engine.whenIdle();
    ok = false;
    await Bun.sleep(400);
    expect(made[2].disposed).toBe(false);
    ok = true;
    let release = () => {};
    hold = new Promise((res) => (release = res));
    t.engine.postHumanMessage(t.room.id, "a long one", "Mac");
    await Bun.sleep(400);
    expect(made[2].disposed).toBe(false); // busy
    release();
    await t.engine.whenIdle();
    await Bun.sleep(400);
    expect(made[2].disposed).toBe(true);
    await t.engine.shutdown();
  });

  test("drivers that can't say are left running", async () => {
    let disposed = 0;
    const t = setup(() => ({ provider: "mock", runTurn: async () => ({ ok: true, text: "Done." }), interrupt: async () => {}, dispose: async () => void disposed++ }));
    t.engine.postHumanMessage(t.room.id, "hi", "Mac");
    await t.engine.whenIdle();
    await Bun.sleep(400);
    expect(disposed).toBe(0);
    await t.engine.shutdown();
  });

  test("Claude Code: the idle process exits and the next message resumes its session; one open in the Claude app is kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-idle-"));
    const args = join(dir, "args.jsonl");
    const inUse = ClaudeDriver.sessionsInUse;
    try {
      const t = setup((ctx) => new ClaudeDriver({ ...ctx, env: { PATH: process.env.PATH ?? "", FAKE_CLAUDE_ARGS_OUT: args } }, join(FIX, "fake-claude")), dir);
      const spawns = () => (existsSync(args) ? readFileSync(args, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
      t.engine.postHumanMessage(t.room.id, "hello", "Mac");
      await t.engine.whenIdle();
      expect(spawns().length).toBe(1);
      await Bun.sleep(500); // ended while idle
      t.engine.postHumanMessage(t.room.id, "again", "Mac");
      await t.engine.whenIdle();
      const after = spawns();
      expect(after.length).toBe(2);
      expect(after[1][after[1].indexOf("--resume") + 1]).toBe("11111111-2222-3333-4444-555555555555");

      // The same session open in the Claude app: this chat's process stays, so the chat can still continue it.
      ClaudeDriver.sessionsInUse = () => new Set(["11111111-2222-3333-4444-555555555555"]);
      await Bun.sleep(500);
      t.engine.postHumanMessage(t.room.id, "still here?", "Mac");
      await t.engine.whenIdle();
      expect(spawns().length).toBe(2); // no new process: the old one was kept
      expect(t.store.listMessages(t.room.id, { limit: 20 }).filter((m) => m.authorKind === "agent").every((m) => m.status === "done")).toBe(true);
      await t.engine.shutdown();
    } finally {
      ClaudeDriver.sessionsInUse = inUse;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Claude Code: not while a prompt it scheduled for later waits to run (it would never run); after it's cancelled, it is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-idle-cron-"));
    const args = join(dir, "args.jsonl");
    try {
      const t = setup((ctx) => new ClaudeDriver({ ...ctx, env: { PATH: process.env.PATH ?? "", FAKE_CLAUDE_ARGS_OUT: args } }, join(FIX, "fake-claude")), dir);
      const spawns = () => (existsSync(args) ? readFileSync(args, "utf8").trim().split("\n").length : 0);
      // "Check the CI again in an hour": a one-shot job, session-only.
      const inAnHour = new Date(Date.now() + 3600_000);
      t.engine.postHumanMessage(t.room.id, `SCHEDULE:${inAnHour.getMinutes()}_${inAnHour.getHours()}_${inAnHour.getDate()}_${inAnHour.getMonth() + 1}_*`, "Mac");
      await t.engine.whenIdle();
      await Bun.sleep(500);
      t.engine.postHumanMessage(t.room.id, "hello", "Mac");
      await t.engine.whenIdle();
      expect(spawns()).toBe(1); // kept: the job still waits
      // A recurring job keeps it too, until it's cancelled.
      t.engine.postHumanMessage(t.room.id, "UNSCHEDULE:job42", "Mac");
      await t.engine.whenIdle();
      t.engine.postHumanMessage(t.room.id, "SCHEDULE_EVERY:*/30_*_*_*_*", "Mac");
      await t.engine.whenIdle();
      await Bun.sleep(500);
      expect(spawns()).toBe(1);
      t.engine.postHumanMessage(t.room.id, "UNSCHEDULE:job42", "Mac");
      await t.engine.whenIdle();
      await Bun.sleep(500); // nothing waits now: ended while idle
      t.engine.postHumanMessage(t.room.id, "again", "Mac");
      await t.engine.whenIdle();
      expect(spawns()).toBe(2);
      // A /loop wakeup keeps it as well.
      t.engine.postHumanMessage(t.room.id, "WAKEUP:600", "Mac");
      await t.engine.whenIdle();
      await Bun.sleep(500);
      t.engine.postHumanMessage(t.room.id, "and again", "Mac");
      await t.engine.whenIdle();
      expect(spawns()).toBe(2);
      await t.engine.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("when a cron schedule next runs, in local time", () => {
    const from = new Date(2026, 9, 25, 10, 15, 30).getTime(); // Sunday 25 October 2026, 10:15:30
    expect(nextCronTime("30 14 25 10 *", from)).toBe(new Date(2026, 9, 25, 14, 30).getTime());
    expect(nextCronTime("*/20 * * * *", from)).toBe(new Date(2026, 9, 25, 10, 20).getTime());
    expect(nextCronTime("0 9 * * mon-fri", from)).toBe(new Date(2026, 9, 26, 9, 0).getTime());
    expect(nextCronTime("5 10 * * *", from)).toBe(new Date(2026, 9, 26, 10, 5).getTime());
    // A day of the month or a day of the week, as cron reads both.
    expect(nextCronTime("0 8 1 * 1", from)).toBe(new Date(2026, 9, 26, 8, 0).getTime());
    expect(nextCronTime("0 8 30 2 *", from)).toBeNull(); // never
    expect(nextCronTime("every hour", from)).toBeNull();
  });

  test("Codex: not while a command it left running after its turn (a dev server) still runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-idle-codex-"));
    try {
      const made: CodexDriver[] = [];
      const t = setup((ctx) => {
        const d = new CodexDriver({ ...ctx, env: { PATH: process.env.PATH ?? "", CODEX_HOME: join(dir, "codex-home") } }, join(FIX, "fake-codex-app"));
        made.push(d);
        return d;
      }, dir);
      t.engine.postHumanMessage(t.room.id, "BACKGROUND_TERMINAL: start the dev server and leave it running", "Mac");
      await t.engine.whenIdle();
      expect(made[0].canEndWhenIdle()).toBe(false);
      await Bun.sleep(500);
      t.engine.postHumanMessage(t.room.id, "STOP_TERMINAL: stop it now", "Mac");
      await t.engine.whenIdle();
      expect(made.length).toBe(1); // the same app-server all along
      expect(made[0].canEndWhenIdle()).toBe(true);
      await t.engine.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
