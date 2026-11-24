// What the memory guard (hub/src/memory.ts) asks of the engine when the machine is about to run out: end idle agent
// processes now, hold new replies, put a note into a running reply, stop one so that it offers Try again, and leave the
// reply that froze the machine alone after a restart. No real agent is started here and nothing is signalled: every
// driver is a fake, and its "process" is a number.
import { describe, expect, test } from "bun:test";
import { MEMORY_WAIT, memoryNoResumeLine, type Member, type Room } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine, HttpError } from "../src/engine/engine";
import type { AgentDriver, DriverContext, TurnSink } from "../src/agents/driver";
import { newId } from "../src/util/ids";

type Fake = { ctx: DriverContext; disposed: boolean; prompts: string[]; steered: string[]; sink: TurnSink | null; release: () => void };

/** A chat with one agent whose driver does what a test tells it: `hang` keeps its reply running until released or stopped. */
function setup(o: { hang?: boolean; steer?: boolean; held?: () => boolean; store?: Store; bus?: Bus } = {}) {
  const store = o.store ?? new Store(":memory:");
  const bus = o.bus ?? new Bus();
  const made: Fake[] = [];
  const createDriver = (ctx: DriverContext): AgentDriver => {
    const f: Fake = { ctx, disposed: false, prompts: [], steered: [], sink: null, release: () => {} };
    made.push(f);
    let running = false;
    return {
      provider: "mock",
      runTurn: async (input, sink) => {
        f.prompts.push(input.prompt);
        f.sink = sink;
        running = true;
        sink.taken?.();
        sink.text("Working on it. ");
        if (o.hang) {
          await new Promise<void>((res) => {
            f.release = res;
            sink.signal.addEventListener("abort", () => res(), { once: true });
          });
        }
        running = false;
        return sink.signal.aborted ? { ok: false, error: "stopped" } : { ok: true, text: "Done." };
      },
      interrupt: async () => f.release(),
      ...(o.steer ? { steer: async (text: string) => (running ? (f.steered.push(text), true) : false) } : {}),
      pids: () => [4000 + made.indexOf(f)],
      canEndWhenIdle: () => true,
      dispose: async () => {
        f.disposed = true;
      },
    };
  };
  const engine = new Engine({ store, bus, createDriver, mcpLaunch: () => ({ command: "true", args: [], env: {} }), memoryHold: o.held });
  return { store, bus, engine, made };
}

function chat(store: Store, name = "Shopping") {
  const now = Date.now();
  const room: Room = { id: newId("r"), name, cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
  const member: Member = { id: newId("mb"), roomId: room.id, handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 };
  store.insertMember(member);
  return { room, member };
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(5);
  expect(ok()).toBe(true);
};
const replies = (store: Store, roomId: string) => store.listMessages(roomId, { limit: 50 }).filter((m) => m.authorKind === "agent");
const systemLines = (store: Store, roomId: string) => store.listMessages(roomId, { limit: 50 }).filter((m) => m.authorKind === "system").map((m) => m.text);

describe("the memory guard's hold on new replies", () => {
  test("a new reply waits for memory and says so, a running one goes on, and what waited starts when there is room", async () => {
    let held = false;
    const t = setup({ hang: true, held: () => held });
    const a = chat(t.store, "Shopping");
    const b = chat(t.store, "Notes");
    // A reply is running when the machine runs short.
    t.engine.postHumanMessage(a.room.id, "look at these pages", "Mac");
    await until(() => t.engine.runningTurns(a.room.id).length === 1);
    held = true;
    t.engine.memoryHoldChanged();
    // A message in another chat, and a second one in the first: neither starts.
    t.engine.postHumanMessage(b.room.id, "something else", "Mac");
    t.engine.postHumanMessage(a.room.id, "and one more", "Mac");
    await Bun.sleep(30);
    expect(t.made.length).toBe(1);
    expect(t.store.getMember(b.member.id)).toMatchObject({ status: "queued", statusDetail: MEMORY_WAIT });
    expect(MEMORY_WAIT).toBe("Waiting for memory");
    expect(t.engine.queuedTurns(b.room.id).length).toBe(1);
    // The reply that was running was never touched, and ends by itself.
    expect(t.engine.runningTurns(a.room.id).length).toBe(1);
    t.made[0].release();
    await until(() => t.engine.runningTurns(a.room.id).length === 0);
    // Its own next turn waits too now.
    expect(t.store.getMember(a.member.id)).toMatchObject({ status: "queued", statusDetail: MEMORY_WAIT });
    expect(t.made[0].prompts.length).toBe(1);

    // Room again: both start, and neither says it waits any more.
    held = false;
    t.engine.memoryHoldChanged();
    await until(() => t.made.length === 2 && t.made[0].prompts.length === 2);
    expect(t.store.getMember(b.member.id)?.statusDetail).not.toBe(MEMORY_WAIT);
    for (const f of t.made) f.release();
    await until(() => !t.engine.isBusy());
    await t.engine.shutdown();
  });

  test("a chat started while replies wait says so from its first moment", async () => {
    const t = setup({ held: () => true });
    const a = chat(t.store);
    t.engine.postHumanMessage(a.room.id, "hello", "Mac");
    expect(t.store.getMember(a.member.id)).toMatchObject({ status: "queued", statusDetail: MEMORY_WAIT });
    await Bun.sleep(20);
    expect(t.made.length).toBe(0);
    await t.engine.shutdown();
  });
});

describe("making room without stopping anyone's work", () => {
  test("idle agent processes are ended at once, by the rule that ends them after 20 minutes: never one that is replying", async () => {
    const t = setup({ hang: true });
    const idle = chat(t.store, "Notes");
    const busy = chat(t.store, "Shopping");
    t.engine.postHumanMessage(idle.room.id, "hi", "Mac");
    await until(() => t.made.length === 1);
    t.made[0].release();
    await until(() => !t.engine.isBusy());
    t.engine.postHumanMessage(busy.room.id, "look at these pages", "Mac");
    await until(() => t.engine.runningTurns(busy.room.id).length === 1);
    // Both are known with their processes and chats; only the one replying says so.
    expect(t.engine.agentProcesses().map((p) => [p.chat, p.agent, p.pids, p.replying, p.browsing])).toEqual([["Notes", "Claude Code", [4000], false, false], ["Shopping", "Claude Code", [4001], true, false]]);
    await Bun.sleep(30);
    // Idle for a minute or more: nobody yet.
    expect(t.engine.endIdleNow(60_000)).toBe(0);
    // Idle for 20 ms: the one with nothing to do goes, the one replying stays.
    expect(t.engine.endIdleNow(20)).toBe(1);
    expect(t.made[0].disposed).toBe(true);
    expect(t.made[1].disposed).toBe(false);
    expect(t.engine.agentProcesses().map((p) => p.chat)).toEqual(["Shopping"]);
    // Its next message starts a fresh process, as after the 20-minute rule.
    t.engine.postHumanMessage(idle.room.id, "again", "Mac");
    await until(() => t.made.length === 3);
    for (const f of t.made) f.release();
    await until(() => !t.engine.isBusy());
    await t.engine.shutdown();
  });

  test("a reply that uses a browser is known as the one browsing", async () => {
    const t = setup({ hang: true });
    const a = chat(t.store);
    t.engine.postHumanMessage(a.room.id, "look at these pages", "Mac");
    await until(() => !!t.made[0]?.sink);
    expect(t.engine.agentProcesses()[0].browsing).toBe(false);
    // Looking for the word, or searching the web for it, is not using a browser.
    t.made[0].sink!.activity({ kind: "command", title: "rg -n browser hub/src", detail: "" });
    t.made[0].sink!.activity({ kind: "tool", title: "Search the web: which browser uses least memory", detail: "" });
    t.made[0].sink!.activity({ kind: "tool", title: "Fetch https://browser.example/docs", detail: "" });
    expect(t.engine.agentProcesses()[0].browsing).toBe(false);
    t.made[0].sink!.activity({ kind: "tool", title: "Use mcp__browseros-neo__navigate", detail: "{}" });
    expect(t.engine.agentProcesses()[0]).toMatchObject({ memberId: a.member.id, roomId: a.room.id, browsing: true, replying: true });
    t.made[0].release();
    await until(() => !t.engine.isBusy());
    await t.engine.shutdown();
    // The other agents' words for the same thing.
    for (const title of ["browseros-neo: navigate", "BrowserOS neo: read https://example.com"]) {
      const o = setup({ hang: true });
      const c = chat(o.store);
      o.engine.postHumanMessage(c.room.id, "look at these pages", "Mac");
      await until(() => !!o.made[0]?.sink);
      o.made[0].sink!.activity({ kind: "tool", title, detail: "" });
      expect(o.engine.agentProcesses()[0].browsing).toBe(true);
      o.made[0].release();
      await until(() => !o.engine.isBusy());
      await o.engine.shutdown();
    }
  });

  test("a note goes into the running reply of an agent that can take one, and nowhere when it can't", async () => {
    const t = setup({ hang: true, steer: true });
    const a = chat(t.store);
    // No reply running: nothing to put it into, and nothing is kept for later.
    expect(await t.engine.noteToReply(a.member.id, "Close your tabs.")).toBe(false);
    t.engine.postHumanMessage(a.room.id, "look at these pages", "Mac");
    await until(() => t.engine.runningTurns(a.room.id).length === 1 && !!t.made[0].sink);
    expect(await t.engine.noteToReply(a.member.id, "Close your tabs.")).toBe(true);
    expect(t.made[0].steered).toEqual(["Close your tabs."]);
    // Nothing of the person's was counted as handed over.
    expect(t.engine.queuedTurns(a.room.id).length).toBe(0);
    t.made[0].release();
    await until(() => !t.engine.isBusy());
    await t.engine.shutdown();

    // An agent with no way to take a message mid-reply: the guard is told so, and the reply goes on untouched.
    const plain = setup({ hang: true });
    const b = chat(plain.store);
    plain.engine.postHumanMessage(b.room.id, "look at these pages", "Mac");
    await until(() => plain.engine.runningTurns(b.room.id).length === 1);
    expect(await plain.engine.noteToReply(b.member.id, "Close your tabs.")).toBe(false);
    expect(plain.engine.runningTurns(b.room.id).length).toBe(1);
    plain.made[0].release();
    await until(() => !plain.engine.isBusy());
    await plain.engine.shutdown();
  });
});

describe("stopping the reply that fills the machine", () => {
  test("it ends as a failed reply that says why, and Try again runs it again", async () => {
    const t = setup({ hang: true });
    const a = chat(t.store);
    t.engine.postHumanMessage(a.room.id, "LOOK_AT_THESE pages", "Mac");
    await until(() => t.engine.runningTurns(a.room.id).length === 1 && !!t.made[0].sink);
    const why = "Crosstalk stopped this reply: Mac mini was about to freeze.";
    expect(await t.engine.stopForMemory(a.room.id, a.member.id, why)).toBe(true);
    expect(t.engine.runningTurns(a.room.id).length).toBe(0);
    // Not "stopped" (which offers nothing): failed, with the reason, which is what puts Try again under it.
    const turn = t.store.lastEndedTurn(a.member.id)!;
    expect(turn).toMatchObject({ status: "error", error: why });
    expect(replies(t.store, a.room.id).at(-1)).toMatchObject({ status: "error", text: "Working on it." });
    expect(t.store.getMember(a.member.id)).toMatchObject({ status: "error", statusDetail: why });
    // Nothing to stop the second time.
    expect(await t.engine.stopForMemory(a.room.id, a.member.id, why)).toBe(false);

    // Try again: the same request goes to the agent once more.
    t.engine.retry(a.room.id);
    await until(() => t.made[0].prompts.length === 2);
    expect(t.made[0].prompts[1]).toContain("LOOK_AT_THESE");
    t.made[0].release();
    await until(() => !t.engine.isBusy());
    expect(replies(t.store, a.room.id).at(-1)).toMatchObject({ status: "done" });
    await t.engine.shutdown();
  });
});

describe("after the machine went down out of memory", () => {
  /** A reply was running in each of two chats when the machine froze: what the database holds at the next start. */
  function frozen() {
    const store = new Store(":memory:");
    const now = Date.now();
    const made = ["Shopping", "Notes"].map((name) => {
      const c = chat(store, name);
      const human = newId("m");
      store.insertMessage({ id: human, roomId: c.room.id, authorKind: "human", memberId: null, authorName: "Mac", text: `REQUEST_IN_${name.toUpperCase()}`, mentions: [], turnId: null, status: "done", createdAt: now - 61_000, updatedAt: now - 61_000 });
      store.setLastSeen(c.member.id, store.maxSeq(c.room.id), 1, []);
      const turn = newId("t");
      const reply = newId("m");
      store.insertMessage({ id: reply, roomId: c.room.id, authorKind: "agent", memberId: c.member.id, authorName: "claude", text: "Opened 212 pages so far.", mentions: [], turnId: turn, status: "streaming", createdAt: now - 60_000, updatedAt: now - 30_000 });
      store.insertTurn({ id: turn, roomId: c.room.id, memberId: c.member.id, triggerMessageId: human, replyMessageId: reply, hop: 0, chainId: newId("ch"), origin: "human", status: "running", error: null, usage: null, createdAt: now - 60_000, startedAt: now - 60_000, endedAt: null });
      return { ...c, turn, reply };
    });
    return { store, shopping: made[0], notes: made[1] };
  }

  test("the reply that was filling it isn't started again: its chat says what happened and waits for Try again; the others pick up", async () => {
    const f = frozen();
    const t = setup({ store: f.store });
    const line = memoryNoResumeLine("Mac mini", "2:41 AM");
    t.engine.resumeAfterRestart((m) => (m.id === f.shopping.member.id ? line : null));
    await until(() => !t.engine.isBusy());
    // The other chat's reply was picked up as after any restart.
    expect(t.made.map((d) => d.ctx.member.id)).toEqual([f.notes.member.id]);
    expect(t.made[0].prompts[0]).toContain("REQUEST_IN_NOTES");
    expect(systemLines(f.store, f.notes.room.id)).toEqual(["Crosstalk restarted. Agents that were working are picking up where they left off."]);
    // The one that froze the machine: nothing ran, the chat has the one line, and the reply reads as failed.
    expect(systemLines(f.store, f.shopping.room.id)).toEqual(["Mac mini ran out of memory at 2:41 AM while this was running. Tap Try again to carry on."]);
    expect(f.store.getTurn(f.shopping.turn)).toMatchObject({ status: "error", error: line });
    expect(f.store.getMessage(f.shopping.reply)).toMatchObject({ status: "error", text: "Opened 212 pages so far." });
    expect(t.engine.queuedTurns(f.shopping.room.id).length).toBe(0);

    // Try again is the person's to tap, and it carries on with the same request.
    t.engine.retry(f.shopping.room.id);
    await until(() => t.made.length === 2 && !t.engine.isBusy());
    expect(t.made[1].ctx.member.id).toBe(f.shopping.member.id);
    expect(t.made[1].prompts[0]).toContain("REQUEST_IN_SHOPPING");
    await t.engine.shutdown();
  });

  test("with nothing to leave alone, every interrupted reply is picked up as before", async () => {
    const f = frozen();
    const t = setup({ store: f.store });
    t.engine.resumeAfterRestart(() => null);
    await until(() => t.made.length === 2 && !t.engine.isBusy());
    expect(systemLines(f.store, f.shopping.room.id)).toEqual(["Crosstalk restarted. Agents that were working are picking up where they left off."]);
    // Nothing to try again after that: it was answered.
    expect(() => t.engine.retry(f.shopping.room.id)).toThrow(HttpError);
    await t.engine.shutdown();
  });
});
