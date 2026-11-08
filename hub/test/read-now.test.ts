// "Send now" while the agent is inside one long step: the message waits for that step. "Read it now" stops the step so
// the agent answers right away, in the same reply, and the message is neither lost nor answered twice. Against the
// fake Claude Code (queue mode, like the real CLI) and the fake Codex app-server; never a real agent.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member, Room, ServerEvent } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import { newId } from "../src/util/ids";
import { processesEnding } from "../src/util/process";

const FIX = join(import.meta.dir, "fixtures");

function chat(provider: "claude" | "codex", env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), `ct-readnow-${provider}-`));
  const store = new Store(":memory:");
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  const log = join(dir, "inputs.jsonl");
  const fullEnv = { PATH: process.env.PATH ?? "", ...env, ...(provider === "claude" ? { FAKE_CLAUDE_INPUT_OUT: log } : { FAKE_CODEX_RPC_LOG: log, CODEX_HOME: join(dir, "codex-home") }) };
  const engine = new Engine({
    store,
    bus,
    createDriver: (ctx) => (provider === "claude" ? new ClaudeDriver({ ...ctx, env: fullEnv }, join(FIX, "fake-claude")) : new CodexDriver({ ...ctx, env: fullEnv }, join(FIX, "fake-codex-app"))),
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "Chat", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider, origin: "web", localId: null });
  const member: Member = { id: newId("mb"), roomId: room.id, handle: provider, provider, model: null, role: "", permissionMode: "full", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 };
  store.insertMember(member);
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const conversation = () => store.listMessages(room.id, { limit: 50 }).filter((m) => m.authorKind !== "system").map((m) => `${m.authorKind}: ${m.text}`);
  const until = async (what: () => unknown, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) if (what()) return;
    throw new Error("timed out waiting");
  };
  /** Starts the long step, then sends a message and hands it to the running reply ("Send now"). */
  const handOver = async (text: string) => {
    engine.postHumanMessage(room.id, "LONG_STEP: run the long check", "Phone");
    await until(() => store.listActivities(room.id, engine.runningTurns(room.id).map((t) => t.id)).some((a) => a.kind === "command" && a.status === "running"));
    const sent = engine.postHumanMessage(room.id, text, "Phone");
    expect(await engine.sendNow(room.id)).toBe(true);
    const running = engine.runningTurns(room.id)[0];
    // The app shows under the message that it's read after the current step.
    expect(engine.liveTurn(store.getTurn(running.id)!)).toMatchObject({ unread: [sent.id], readingNow: false });
    expect(events.some((e) => e.t === "turn" && e.turn.id === running.id && e.turn.unread?.includes(sent.id))).toBe(true);
    return { sent, running };
  };
  const close = async () => {
    await engine.stop(room.id);
    await engine.shutdown();
    await processesEnding();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, engine, room, events, lines, conversation, until, handOver, close };
}

describe("Read it now: Claude Code", () => {
  test("Claude Code's own Send now stops the long step; the message is answered once, below it, in the same reply", async () => {
    const t = chat("claude", { FAKE_CLAUDE_QUEUE: "1" });
    try {
      const { sent, running } = await t.handOver("also add tests");
      expect(await t.engine.readNow(t.room.id)).toBe(true);
      await t.engine.whenIdle();
      expect(t.conversation()).toEqual(["human: LONG_STEP: run the long check", "agent: Running the long check.", "human: also add tests", "agent: Got it: also add tests"]);
      expect(t.lines()).toEqual(["LONG_STEP: run the long check", "also add tests"]); // written to Claude Code once
      const turns = t.store.listTurns(t.room.id, 10);
      expect(turns.filter((x) => x.status === "done").map((x) => x.id)).toEqual([running.id]); // one reply, no extra turn
      expect(t.store.getTurn(running.id)!.usage).toMatchObject({ inputTokens: 60, outputTokens: 10 }); // both parts counted
      const step = t.store.listActivities(t.room.id, [running.id]).find((a) => a.title === "sleep 600")!;
      expect(step.status).toBe("error"); // stopped, so it doesn't look finished
      expect(t.engine.liveTurn(t.store.getTurn(running.id)!).unread).toBeUndefined();
      expect(t.events.some((e) => e.t === "turn" && e.turn.id === running.id && e.turn.readingNow)).toBe(true);
      void sent;
    } finally {
      await t.close();
    }
  });

  test("an older Claude Code (no send_now) takes a plain interrupt: the message stays queued and is answered once", async () => {
    const t = chat("claude", { FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_NO_SEND_NOW: "1" });
    try {
      await t.handOver("also add tests");
      expect(await t.engine.readNow(t.room.id)).toBe(true);
      await t.engine.whenIdle();
      expect(t.conversation().slice(-2)).toEqual(["human: also add tests", "agent: Got it: also add tests"]);
      expect(t.lines()).toEqual(["LONG_STEP: run the long check", "also add tests"]);
    } finally {
      await t.close();
    }
  });

  test("a message it had already taken in: nothing is stopped (Send now) — or, after an older one's interrupt, it's asked for the answer without the message again", async () => {
    const newer = chat("claude", { FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_TAKE_IN: "1" });
    try {
      await newer.handOver("also add tests");
      expect(await newer.engine.readNow(newer.room.id)).toBe(false); // it's being read: nothing to stop
      expect(newer.engine.runningTurns(newer.room.id).length).toBe(1); // the long step goes on
    } finally {
      await newer.close();
    }
    const older = chat("claude", { FAKE_CLAUDE_QUEUE: "1", FAKE_CLAUDE_TAKE_IN: "1", FAKE_CLAUDE_NO_SEND_NOW: "1" });
    try {
      await older.handOver("also add tests");
      expect(await older.engine.readNow(older.room.id)).toBe(true);
      await older.engine.whenIdle();
      const inputs = older.lines();
      expect(inputs.filter((l: string) => l === "also add tests").length).toBe(1);
      expect(inputs.at(-1)).toContain("answer my last message right away");
      expect(older.conversation().at(-1)).toContain("Got it: (Crosstalk stopped the step");
    } finally {
      await older.close();
    }
  });

  test("Stop still stops: a Stop while Read it now waits doesn't start the answer, then or a moment later, and Answer now delivers it once", async () => {
    const t = chat("claude", { FAKE_CLAUDE_QUEUE: "1" });
    try {
      const { sent } = await t.handOver("also add tests");
      await t.engine.stop(t.room.id);
      expect(await t.engine.readNow(t.room.id)).toBe(false);
      expect(t.store.listMessages(t.room.id, { limit: 20 }).filter((m) => m.authorKind === "agent").at(-1)?.status).toBe("stopped");
      // Long enough for Claude Code to have started on what it still held. (It used to: "Got it: also add tests", and a
      // note saying so.)
      await Bun.sleep(1000);
      await t.engine.whenIdle();
      expect(t.conversation()).toEqual(["human: LONG_STEP: run the long check", "agent: Running the long check.", "human: also add tests"]);
      expect(t.store.listMessages(t.room.id, { limit: 20 }).filter((m) => m.authorKind === "system")).toEqual([]);
      // Its messages are the person's again, unread.
      expect(t.store.getLastSeen(t.store.listMembers(t.room.id)[0].id).seq).toBeLessThan(t.store.messageSeq(sent.id));
      t.engine.retry(t.room.id);
      await t.engine.whenIdle();
      expect(t.conversation().at(-1)).toBe("agent: Got it: also add tests");
      expect(t.conversation().filter((c) => c === "agent: Got it: also add tests")).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});

describe("Read it now: Codex", () => {
  const rpc = (t: ReturnType<typeof chat>, method: string) => t.lines().filter((m: { method?: string }) => m.method === method);
  const inputText = (m: { params: { input: { text: string }[] } }) => m.params.input[0].text;

  test("the turn stops, and the message it hadn't taken in starts the next one: answered once, in the same reply", async () => {
    const t = chat("codex", {});
    try {
      const { running } = await t.handOver("also add tests");
      expect(rpc(t, "turn/steer").map(inputText)).toEqual(["also add tests"]);
      expect(await t.engine.readNow(t.room.id)).toBe(true);
      await t.engine.whenIdle();
      const starts = rpc(t, "turn/start").map(inputText);
      expect(starts.length).toBe(2);
      expect(starts[1]).toBe("(Crosstalk stopped the step you were on so you could read this right away.)\n\nalso add tests");
      expect(rpc(t, "turn/interrupt").length).toBe(1);
      expect(t.conversation().slice(-2)).toEqual(["human: also add tests", "agent: Answering your message now."]);
      expect(t.store.listTurns(t.room.id, 10).filter((x) => x.status === "done").map((x) => x.id)).toEqual([running.id]);
      expect(t.store.listActivities(t.room.id, [running.id]).find((a) => a.title === "sleep 600")?.status).toBe("error");
    } finally {
      await t.close();
    }
  });

  test("a message Codex took in just as it stopped isn't sent again: it's asked for the answer", async () => {
    const t = chat("codex", { FAKE_CODEX_TAKE_ON_INTERRUPT: "1" });
    try {
      await t.handOver("also add tests");
      expect(await t.engine.readNow(t.room.id)).toBe(true);
      await t.engine.whenIdle();
      const starts = rpc(t, "turn/start").map(inputText);
      expect(starts[1]).toBe("(Crosstalk stopped the step you were on so you'd answer my last message right away. Answer it now.)");
      expect(starts.join("\n")).not.toContain("also add tests");
    } finally {
      await t.close();
    }
  });

  test("Stop instead of Read it now: the message Codex's stopped turn dropped is unread, starts nothing, and Answer now delivers it once", async () => {
    const t = chat("codex", {});
    try {
      const { sent } = await t.handOver("also add tests");
      await t.engine.stop(t.room.id);
      await t.engine.whenIdle();
      expect(rpc(t, "turn/start").map(inputText).join("\n")).not.toContain("also add tests");
      expect(t.store.getLastSeen(t.store.listMembers(t.room.id)[0].id).seq).toBeLessThan(t.store.messageSeq(sent.id));
      t.engine.retry(t.room.id);
      await t.engine.whenIdle();
      expect(rpc(t, "turn/start").map(inputText).filter((x: string) => x.includes("also add tests"))).toHaveLength(1);
      expect(t.conversation().at(-1)).toBe("agent: Done.");
    } finally {
      await t.close();
    }
  });

  test("a Codex that never stops its turn: its app-server is replaced and the message goes in there", async () => {
    const wait = CodexDriver.readNowWaitMs;
    CodexDriver.readNowWaitMs = 300;
    const t = chat("codex", { FAKE_CODEX_STUCK_INTERRUPT: "1" });
    try {
      await t.handOver("also add tests");
      expect(await t.engine.readNow(t.room.id)).toBe(true);
      await t.engine.whenIdle();
      expect(rpc(t, "thread/resume").length).toBe(1); // a fresh app-server resumed the thread
      expect(rpc(t, "turn/start").map(inputText).at(-1)).toContain("also add tests");
      expect(t.conversation().at(-1)).toBe("agent: Answering your message now.");
    } finally {
      CodexDriver.readNowWaitMs = wait;
      await t.close();
    }
  });
});

test("while the reply waits on your approval, Read it now says to answer that (stopping would strand the card)", async () => {
  const store = new Store(":memory:");
  let stopped = 0;
  const engine = new Engine({
    store,
    bus: new Bus(),
    createDriver: () => ({
      provider: "mock",
      runTurn: async (_input, sink) => {
        const d = await sink.approval({ kind: "command", title: "npm publish", detail: "", always: "Always allow `npm publish` commands" });
        return { ok: true, text: d === "deny" ? "Not published." : "Published." };
      },
      steer: async () => true,
      readNow: async () => (stopped++, true),
      interrupt: async () => {},
      dispose: async () => {},
    }),
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "Chat", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
  store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
  engine.postHumanMessage(room.id, "publish it", "Phone");
  for (let i = 0; i < 200 && !store.listPendingApprovals().length; i++) await Bun.sleep(5);
  engine.postHumanMessage(room.id, "use the beta tag", "Phone");
  expect(await engine.sendNow(room.id)).toBe(true);
  await expect(engine.readNow(room.id)).rejects.toThrow("waiting for your approval");
  expect(stopped).toBe(0);
  engine.decideApproval(store.listPendingApprovals()[0].id, "approve", "Phone");
  await engine.whenIdle();
  await engine.shutdown();
});

test("Read it now that can't stop the step says so: the message is read after it, and it can be tried again", async () => {
  const store = new Store(":memory:");
  let fail = true;
  let release = () => {};
  const engine = new Engine({
    store,
    bus: new Bus(),
    createDriver: () => ({
      provider: "mock",
      runTurn: (_input, sink) => new Promise((res) => (release = () => res({ ok: true, text: sink.signal.aborted ? "" : "Read it." }))),
      steer: async () => true,
      readNow: async () => {
        if (fail) throw new Error("Claude Code didn't answer");
        return true;
      },
      interrupt: async () => {},
      dispose: async () => {},
    }),
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "Chat", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
  store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
  engine.postHumanMessage(room.id, "run the deploy", "Phone");
  for (let i = 0; i < 200 && !engine.runningTurns(room.id).length; i++) await Bun.sleep(5);
  engine.postHumanMessage(room.id, "also bump the version", "Phone");
  expect(await engine.sendNow(room.id)).toBe(true);
  // Not "it has just read it": the step goes on, and the message waits for it.
  await expect(engine.readNow(room.id)).rejects.toThrow("Couldn't stop the step: Claude Code reads this after it.");
  const turn = engine.runningTurns(room.id)[0];
  expect(engine.liveTurn(store.getTurn(turn.id)!)).toMatchObject({ readingNow: false });
  expect(engine.liveTurn(store.getTurn(turn.id)!).unread).toHaveLength(1);
  fail = false;
  expect(await engine.readNow(room.id)).toBe(true);
  release();
  await engine.whenIdle();
  await engine.shutdown();
});
