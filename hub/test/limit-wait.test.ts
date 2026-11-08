// "Carry on when the limit resets": a reply a usage limit stopped waits instead of failing, and picks itself back up
// when the limit resets (hub/src/engine/engine.ts, the LimitWaits section). Stand-in agents only (the mock driver's
// `limit` knob reports a limit the way the real drivers do), and the engine's clock is injected, so nothing here waits
// for real time.

import { describe, expect, test } from "bun:test";
import type { LimitWait, Member, Room, ServerEvent, Turn } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import { MockDriver } from "../src/agents/mock";
import type { AgentDriver, DriverContext, TurnInput, TurnSink } from "../src/agents/driver";
import { newId } from "../src/util/ids";
import { App } from "../src/app";
import type { EngineDeps } from "../src/engine/engine";
import type { PushNote } from "../src/push";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const START = Date.UTC(2026, 9, 28, 12, 0, 0);
const MIN = 60_000;

function setup(opts: { carryOn?: boolean } = {}) {
  const store = new Store(":memory:");
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  const prompts: { handle: string; prompt: string }[] = [];
  const notes: { kind: string; roomId: string; wait: LimitWait }[] = [];
  const clock = { now: START };
  // The setting can be switched while chats wait, as a user does in Settings.
  const settings = { carryOn: opts.carryOn !== false };
  const engine = new Engine({
    store,
    bus,
    createDriver: (ctx: DriverContext): AgentDriver => {
      const inner = new MockDriver(ctx);
      return {
        provider: ctx.member.provider,
        runTurn: (input: TurnInput, sink: TurnSink) => {
          prompts.push({ handle: ctx.member.handle, prompt: input.prompt });
          // Like Claude Code: each message a turn delivers can be gone back to (engine.reviseGroupMessage reads these).
          if (input.messageIds?.length) sink.saveSession({ msgRefs: Object.fromEntries(input.messageIds.map((id) => [id, input.turnId])) });
          return inner.runTurn(input, sink);
        },
        rewind: async (messageId: string) => [messageId],
        interrupt: () => inner.interrupt(),
        dispose: () => inner.dispose(),
      };
    },
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    now: () => clock.now,
    carryOnAfterLimit: () => settings.carryOn,
    accountLabel: (m) => (m.config?.account === "work" ? "Work" : null),
    onLimitWait: (e) => notes.push({ kind: e.kind, roomId: e.room.id, wait: e.wait }),
  });
  const rooms: Room[] = [];
  const chat = (patch: Partial<Room> = {}): Room => {
    const now = Date.now();
    const room: Room = {
      id: newId("r"),
      name: `Chat ${rooms.length + 1}`,
      cwd: "/tmp",
      mode: "relay",
      leadMemberId: null,
      maxHops: 6,
      rounds: 1,
      parallel: false,
      createdAt: now,
      updatedAt: now,
      archived: false,
      chat: { provider: "mock", origin: "web" },
      ...patch,
    };
    store.insertRoom(room);
    // A chat (not an older multi-agent room), as hub/src/chats.ts makes one: a chats row for one agent, and for a group
    // chat the room's own group_chat flag and no chats row (db.ts ROOM_SELECT).
    if (!room.chat?.group) store.insertChat({ roomId: room.id, provider: room.chat!.provider, origin: "web", localId: null });
    const saved = store.getRoom(room.id)!;
    rooms.push(saved);
    return saved;
  };
  const add = (room: Room, handle: string, config: Record<string, unknown> = {}): Member => {
    const m: Member = {
      id: newId("mb"),
      roomId: room.id,
      handle,
      provider: "mock",
      model: null,
      role: "",
      permissionMode: "ask",
      status: "idle",
      statusDetail: null,
      config: { delayMs: 10, ...config },
      createdAt: Date.now(),
      position: store.listMembers(room.id).length,
    };
    store.insertMember(m);
    return m;
  };
  const idle = async () => {
    await Bun.sleep(5);
    await engine.whenIdle();
    await Bun.sleep(5);
  };
  const say = async (room: Room, text: string) => {
    const msg = engine.postHumanMessage(room.id, text, "Phone");
    await idle();
    return msg;
  };
  const turns = (room: Room) => store.listTurns(room.id);
  const newest = (room: Room) => turns(room).at(-1)!;
  const done = async () => {
    await engine.shutdown();
    store.close();
  };
  return { store, bus, engine, events, prompts, notes, clock, settings, chat, add, idle, say, turns, newest, done };
}

/** A limit that says when it resets, and one that says nothing. */
const atReset = (ms: number) => ({ limit: { label: "5-hour", resetsAt: START + ms, times: 1 } });
const noReset = { limit: { label: "5-hour", resetsAt: null } };

describe("a usage limit makes the reply wait", () => {
  test("the turn waits, the reply isn't an error, and the message stays unanswered", async () => {
    const h = setup();
    try {
      const room = h.chat();
      const member = h.add(room, "tester", atReset(60 * MIN));
      const msg = await h.say(room, "please build it");
      const turn = h.newest(room);
      expect(turn.status).toBe("waiting");
      expect(turn.wait).toMatchObject({ provider: "mock", account: "default", kind: "usage", label: "5-hour", tries: 1, since: START, source: "event" });
      // Just after the reset, not at it.
      expect(turn.wait!.runAt).toBe(START + 60 * MIN + 60_000);
      expect(turn.error).toContain("Test agent is out of messages until");
      expect(turn.error).toContain("It'll carry on then.");
      // The reply says why in plain words, and is not styled as an error (no ⚠️, status "stopped").
      const reply = h.store.getMessage(turn.replyMessageId!)!;
      expect(reply.status).toBe("stopped");
      expect(reply.text).toBe(turn.error!);
      expect(reply.text).not.toContain("⚠️");
      // The message it was answering is the user's again: unread, unanswered.
      expect(h.store.getLastSeen(member.id).seq).toBe(0);
      expect(h.store.messageSeq(msg.id)).toBe(1);
      // The agent says so too, in the same words.
      const fresh = h.store.getMember(member.id)!;
      expect(fresh.status).toBe("waiting");
      expect(fresh.statusDetail).toBe(turn.error);
      // Nothing is queued or running: a deploy can still restart the hub while a chat waits.
      expect(h.engine.isBusy()).toBe(false);
      expect(h.store.unfinishedTurns()).toEqual([]);
      // One grouped notification's worth of news.
      expect(h.notes).toMatchObject([{ kind: "waiting", roomId: room.id }]);
    } finally {
      await h.done();
    }
  });

  test("a second account's name is in the words", async () => {
    const h = setup();
    try {
      const room = h.chat();
      h.add(room, "tester", { ...atReset(30 * MIN), account: "work" });
      await h.say(room, "hello");
      expect(h.newest(room).error).toContain("Test agent (Work) is out of messages");
    } finally {
      await h.done();
    }
  });

  test("with no reset time it says soon and backs off, and the words never name a time", async () => {
    const h = setup();
    try {
      const room = h.chat();
      h.add(room, "tester", noReset);
      await h.say(room, "hello");
      const turn = h.newest(room);
      expect(turn.wait).toMatchObject({ resetsAt: null, source: "none", runAt: START + 5 * MIN });
      expect(turn.error).toBe("Test agent is out of messages until its limit resets. It'll carry on soon.");
    } finally {
      await h.done();
    }
  });

  test("off in Settings: the reply just fails, as before", async () => {
    const h = setup({ carryOn: false });
    try {
      const room = h.chat();
      const member = h.add(room, "tester", atReset(30 * MIN));
      await h.say(room, "hello");
      const turn = h.newest(room);
      expect(turn.status).toBe("error");
      expect(turn.error).toContain("Mock plan limit reached");
      expect(h.store.getMessage(turn.replyMessageId!)!.status).toBe("error");
      expect(h.store.getMember(member.id)!.status).toBe("error");
      expect(h.notes).toEqual([]);
    } finally {
      await h.done();
    }
  });

  test("a failure that isn't a limit is never made to wait", async () => {
    const h = setup();
    try {
      const room = h.chat();
      h.add(room, "tester", { fail: true });
      await h.say(room, "hello");
      expect(h.newest(room).status).toBe("error");
      expect(h.engine.limitWaiting(room.id)).toBe(null);
    } finally {
      await h.done();
    }
  });
});

describe("carrying on by itself", () => {
  test("at the reset it re-runs the same trigger, with a note, and the reply ends up answered", async () => {
    const h = setup();
    try {
      const room = h.chat();
      const member = h.add(room, "tester", atReset(60 * MIN));
      const msg = await h.say(room, "please build it");
      const waited = h.newest(room);

      // Nothing happens before the reset.
      h.clock.now = waited.wait!.runAt - 1;
      h.engine.checkWaits();
      await h.idle();
      expect(h.store.getTurn(waited.id)!.status).toBe("waiting");

      h.clock.now = waited.wait!.runAt;
      h.engine.checkWaits();
      await h.idle();
      // The reply that waited is over, and its line is in the past tense.
      const after = h.store.getTurn(waited.id)!;
      expect(after.status).toBe("stopped");
      expect(after.wait ?? null).toBe(null);
      expect(h.store.getMessage(after.replyMessageId!)!.text).toBe("Waited for the 5-hour limit to reset, then carried on.");
      // A new turn answered the very same message.
      const fresh = h.newest(room);
      expect(fresh.id).not.toBe(waited.id);
      expect(fresh.status).toBe("done");
      expect(fresh.triggerMessageId).toBe(msg.id);
      expect(h.prompts.at(-1)!.prompt).toContain("waited for your 5-hour usage limit to reset");
      expect(h.prompts.at(-1)!.prompt).toContain("please build it");
      expect(h.store.getMember(member.id)!.status).toBe("idle");
      expect(h.notes.map((n) => n.kind)).toEqual(["waiting", "carried"]);
    } finally {
      await h.done();
    }
  });

  test("stopped again by the same limit: it backs off, then gives up with Try again", async () => {
    const h = setup();
    try {
      const room = h.chat();
      const member = h.add(room, "tester", noReset);
      await h.say(room, "hello");
      const waits: number[] = [];
      for (let i = 0; i < 5; i++) {
        const turn = h.newest(room);
        expect(turn.status).toBe("waiting");
        waits.push(turn.wait!.runAt - h.clock.now);
        expect(turn.wait!.tries).toBe(i + 1);
        h.clock.now = turn.wait!.runAt;
        h.engine.checkWaits();
        await h.idle();
      }
      // 5, 15, 30, 60 and 120 minutes between tries.
      expect(waits).toEqual([5 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN]);
      // The sixth is one too many: a plain failed reply, in plain words, with a way out.
      const last = h.newest(room);
      expect(last.status).toBe("error");
      expect(last.error).toContain("Crosstalk waited 5 times and stopped trying.");
      expect(last.error).toContain("Try again");
      expect(h.store.getMessage(last.replyMessageId!)!.status).toBe("error");
      expect(h.store.getMember(member.id)!.status).toBe("error");
      expect(h.engine.limitWaiting(room.id)).toBe(null);
      expect(h.notes.at(-1)!.kind).toBe("gave-up");
      // And Try again works from there: the user asking starts the budget again, so it waits afresh from try 1.
      h.engine.retry(room.id);
      await h.idle();
      expect(h.newest(room)).toMatchObject({ status: "waiting", wait: { tries: 1 } });
    } finally {
      await h.done();
    }
  });

  test("stopped again the moment it carries on, nothing says it carried on", async () => {
    const h = setup();
    try {
      const room = h.chat();
      // The window opens a minute later than the agent said: the carry-on is refused before it writes a word.
      h.add(room, "tester", { limit: { label: "5-hour", resetsAt: START + 30 * MIN, times: 2 } });
      await h.say(room, "please build it");
      const waited = h.newest(room);
      h.clock.now = waited.wait!.runAt;
      h.engine.checkWaits();
      await h.idle();
      // It is waiting again, and the phone was never told it had carried on.
      expect(h.newest(room).status).toBe("waiting");
      expect(h.notes.map((n) => n.kind)).toEqual(["waiting", "waiting"]);
      expect(h.newest(room).wait!.tries).toBe(2);
    } finally {
      await h.done();
    }
  });

  test("a reset more than a day out isn't waited for at all", async () => {
    const h = setup();
    try {
      const room = h.chat();
      h.add(room, "tester", { limit: { label: "Weekly", resetsAt: START + 30 * 3600_000 } });
      await h.say(room, "hello");
      const turn = h.newest(room);
      expect(turn.status).toBe("error");
      expect(turn.error).toContain("Crosstalk");
      expect(turn.error).toContain("Try again");
    } finally {
      await h.done();
    }
  });
});

describe("one wait per agent", () => {
  test("a message that arrived while it worked isn't a second wait, and is answered once", async () => {
    const h = setup();
    try {
      const room = h.chat();
      const member = h.add(room, "tester", { ...atReset(60 * MIN), delayMs: 300 });
      const one = h.engine.postHumanMessage(room.id, "msg one", "Phone");
      await Bun.sleep(60); // its reply is running: the next message is queued behind it
      const two = h.engine.postHumanMessage(room.id, "msg two", "Phone");
      await h.idle();

      // One wait, not two: the turn queued behind the limit would have run straight into it.
      const waiting = h.turns(room).filter((t) => t.status === "waiting");
      expect(waiting).toHaveLength(1);
      expect(waiting[0].triggerMessageId).toBe(one.id);
      expect(waiting[0].wait!.tries).toBe(1);
      expect(h.turns(room).some((t) => t.status === "done")).toBe(false);
      // The queued turn ended quietly, with no reply of its own to explain and nothing for Try again to pick up.
      const dropped = h.turns(room).find((t) => t.id !== waiting[0].id)!;
      expect(dropped).toMatchObject({ status: "stopped", replyMessageId: null });
      // Both messages are the user's again, and one notification covers the chat.
      expect(h.store.getLastSeen(member.id).seq).toBe(0);
      expect(h.notes).toMatchObject([{ kind: "waiting" }]);

      // At the reset one reply answers both, so nothing is answered twice.
      h.clock.now = waiting[0].wait!.runAt;
      h.engine.checkWaits();
      await h.idle();
      const done = h.turns(room).filter((t) => t.status === "done");
      expect(done).toHaveLength(1);
      expect(h.prompts.at(-1)!.prompt).toContain("msg one");
      expect(h.prompts.at(-1)!.prompt).toContain("msg two");
      expect(two.id).not.toBe(one.id);
    } finally {
      await h.done();
    }
  });

  test("a message from another chat during a wait folds into it: no second wait, no second try", async () => {
    const h = setup();
    try {
      const room = h.chat();
      const member = h.add(room, "tester", { limit: { label: "5-hour", resetsAt: START + 60 * MIN, times: 2 } });
      await h.say(room, "please build it");
      const waiting = h.engine.limitWaiting(room.id)!;
      const via = { hubId: "h1", machine: "Mac mini", chatId: "r_other", chatName: "Other chat", agent: "Codex", hop: 1, kind: "message" as const };
      h.engine.postRelayMessage(room.id, "@tester can you look at this?", via, "Codex");
      await h.idle();

      // Still the one wait, with its try count untouched: the relay's own turn ended and left the wait to carry both on.
      expect(h.engine.limitWaiting(room.id)!.id).toBe(waiting.id);
      expect(h.turns(room).filter((t) => t.status === "waiting")).toHaveLength(1);
      expect(h.store.getTurn(waiting.id)!.wait!.tries).toBe(1);
      expect(JSON.parse(h.store.kvGet(`limitWait:${waiting.chainId}:${member.id}`)!).tries).toBe(1);
      expect(h.store.getMember(member.id)!.status).toBe("waiting");
      expect(h.notes).toMatchObject([{ kind: "waiting" }]);
      // The relay is unanswered and unread, so the carry-on reads it with the rest.
      expect(h.store.getLastSeen(member.id).seq).toBe(0);
      h.clock.now = h.engine.limitWaiting(room.id)!.wait.runAt;
      h.engine.checkWaits();
      await h.idle();
      expect(h.prompts.at(-1)!.prompt).toContain("please build it");
      expect(h.prompts.at(-1)!.prompt).toContain("can you look at this?");
    } finally {
      await h.done();
    }
  });

  test("Answer now in a group chat carries the waiting agent on instead of queuing a second try", async () => {
    const h = setup();
    try {
      const room = h.chat({ chat: { provider: "mock", origin: "web", group: true } });
      const stuck = h.add(room, "one", atReset(60 * MIN));
      h.add(room, "two");
      await h.say(room, "@one please build it");
      expect(h.engine.limitWaiting(room.id, stuck.id)).not.toBe(null);
      h.engine.retry(room.id); // Answer now, under the message nothing has answered
      await h.idle();
      expect(h.engine.limitWaiting(room.id, stuck.id)).toBe(null);
      expect(h.turns(room).filter((t) => t.memberId === stuck.id && t.status === "done")).toHaveLength(1);
      expect(h.prompts.at(-1)!.prompt).toContain("the user asked you to carry on now");
    } finally {
      await h.done();
    }
  });
});

describe("several chats and several accounts", () => {
  test("one account's chats carry on oldest first, a few at a time; another account is untouched", async () => {
    const h = setup();
    try {
      const chats = [h.chat(), h.chat(), h.chat()];
      for (const room of chats) h.add(room, "tester", atReset(30 * MIN));
      // A second account, whose own limit resets an hour later.
      const other = h.chat();
      h.add(other, "tester", { ...atReset(90 * MIN), account: "work" });
      for (const room of [...chats, other]) await h.say(room, `work in ${room.name}`);
      const waiting = [...chats, other].map((room) => h.newest(room));
      expect(waiting.map((t) => t.status)).toEqual(["waiting", "waiting", "waiting", "waiting"]);

      // The first account's limit resets; the other account's hasn't.
      h.clock.now = waiting[0].wait!.runAt;
      h.engine.checkWaits();
      await h.idle();
      const state = () => [...chats, other].map((room) => h.store.getTurn(h.turns(room)[0].id)!.status);
      // At most two of one account's chats start per round: the third follows, so a reset never starts a dozen replies.
      expect(state()).toEqual(["stopped", "stopped", "waiting", "waiting"]);
      h.engine.checkWaits();
      await h.idle();
      expect(state()).toEqual(["stopped", "stopped", "stopped", "waiting"]);
      for (const room of chats) expect(h.newest(room).status).toBe("done");
      // The other account's chat waited on its own limit all along, and carries on at its own time.
      expect(h.engine.limitWaiting(other.id)!.wait.account).toBe("work");
      h.clock.now = waiting[3].wait!.runAt;
      h.engine.checkWaits();
      await h.idle();
      expect(h.newest(other).status).toBe("done");
    } finally {
      await h.done();
    }
  });

  test("in a group chat the waiting agent doesn't hold up the others", async () => {
    const h = setup();
    try {
      const room = h.chat({ mode: "roundrobin", chat: { provider: "mock", origin: "web", group: true } });
      const stuck = h.add(room, "one", atReset(30 * MIN));
      const fine = h.add(room, "two");
      await h.say(room, "both of you please");
      const mine = (id: string) => h.turns(room).filter((t) => t.memberId === id);
      expect(mine(stuck.id).at(-1)!.status).toBe("waiting");
      expect(mine(fine.id).at(-1)!.status).toBe("done");
      expect(h.store.getMember(fine.id)!.status).toBe("idle");
      // And the waiting one carries on later, on its own.
      h.clock.now = mine(stuck.id).at(-1)!.wait!.runAt;
      h.engine.checkWaits();
      await h.idle();
      expect(mine(stuck.id).at(-1)!.status).toBe("done");
    } finally {
      await h.done();
    }
  });
});

describe("the ways out", () => {
  const waitingChat = async (h: ReturnType<typeof setup>) => {
    const room = h.chat();
    const member = h.add(room, "tester", atReset(60 * MIN));
    const msg = await h.say(room, "please build it");
    return { room, member, msg };
  };

  test("Try now runs it at once", async () => {
    const h = setup();
    try {
      const { room, msg } = await waitingChat(h);
      const turn = h.engine.tryNow(room.id);
      expect(turn.triggerMessageId).toBe(msg.id);
      await h.idle();
      expect(h.newest(room).status).toBe("done");
      expect(h.prompts.at(-1)!.prompt).toContain("the user asked you to carry on now");
      expect(h.engine.limitWaiting(room.id)).toBe(null);
      // Nothing left waiting: asking again says so plainly.
      expect(() => h.engine.tryNow(room.id)).toThrow("isn't waiting for a limit any more");
    } finally {
      await h.done();
    }
  });

  test("Don't wait leaves a failed reply with Try again", async () => {
    const h = setup();
    try {
      const { room, member } = await waitingChat(h);
      const turn = h.engine.dontWait(room.id);
      expect(turn.status).toBe("error");
      expect(turn.error).toContain("Tap Try again");
      expect(h.store.getMessage(turn.replyMessageId!)!.status).toBe("error");
      expect(h.store.getMessage(turn.replyMessageId!)!.text).toStartWith("⚠️");
      expect(h.store.getMember(member.id)!.status).toBe("error");
      expect(h.engine.limitWaiting(room.id)).toBe(null);
      // The failed reply is the newest ended turn, so Try again picks it up.
      expect(h.store.lastEndedTurn(member.id)!.id).toBe(turn.id);
      h.engine.retry(room.id);
      await h.idle();
      expect(h.newest(room).status).toBe("done");
    } finally {
      await h.done();
    }
  });

  test("a new message cancels the wait and is answered now", async () => {
    const h = setup();
    try {
      const { room, msg } = await waitingChat(h);
      const waited = h.newest(room);
      const second = await h.say(room, "never mind, do this instead");
      expect(h.store.getTurn(waited.id)!.status).toBe("stopped");
      expect(h.store.getMessage(waited.replyMessageId!)!.text).toContain("your new message is being answered instead");
      expect(h.engine.limitWaiting(room.id)).toBe(null);
      const fresh = h.newest(room);
      expect(fresh.status).toBe("done");
      expect(fresh.triggerMessageId).toBe(second.id);
      // Neither message was lost: the agent read both.
      expect(h.prompts.at(-1)!.prompt).toContain("please build it");
      expect(h.prompts.at(-1)!.prompt).toContain("never mind");
      expect(h.store.getLastSeen(h.store.listMembers(room.id)[0].id).seq).toBe(h.store.messageSeq(second.id));
      expect(msg.id).not.toBe(second.id);
    } finally {
      await h.done();
    }
  });

  test("Stop everything ends the wait too", async () => {
    const h = setup();
    try {
      const { room, member } = await waitingChat(h);
      await h.engine.stop(room.id);
      expect(h.engine.limitWaiting(room.id)).toBe(null);
      expect(h.store.getMember(member.id)!.status).toBe("idle");
      h.clock.now = START + 100 * MIN;
      h.engine.checkWaits();
      await h.idle();
      // Nothing ran by itself after the Stop.
      expect(h.turns(room).filter((t) => t.status === "done")).toEqual([]);
    } finally {
      await h.done();
    }
  });

  test("switching the setting off ends the waits that already exist", async () => {
    const h = setup();
    try {
      const { room, member } = await waitingChat(h);
      const waited = h.newest(room);
      // Switched off at 11am precisely so nothing replies by itself: a wait from before must not run at 3:20pm either.
      h.settings.carryOn = false;
      h.engine.checkWaits();
      await h.idle();
      const after = h.store.getTurn(waited.id)!;
      expect(after.status).toBe("error");
      expect(after.error).toContain("Tap Try again");
      expect(h.store.getMessage(after.replyMessageId!)!.status).toBe("error");
      expect(h.store.getMember(member.id)!.status).toBe("error");
      expect(h.engine.limitWaiting(room.id)).toBe(null);
      h.clock.now = waited.wait!.runAt + MIN;
      h.engine.checkWaits();
      await h.idle();
      expect(h.turns(room).filter((t) => t.status === "done")).toEqual([]);
    } finally {
      await h.done();
    }
  });

  test("Try now doesn't spend the waiting, so the chat still carries on by itself", async () => {
    const h = setup();
    try {
      const room = h.chat();
      const member = h.add(room, "tester", { limit: { label: "5-hour", resetsAt: START + 60 * MIN, times: 6 } });
      await h.say(room, "please build it");
      const chainId = h.newest(room).chainId;
      // Five impatient taps while the limit is still closed: each is refused and waits again, from try one.
      for (let i = 0; i < 5; i++) {
        expect(h.engine.tryNow(room.id)).toBeTruthy();
        await h.idle();
        const turn = h.newest(room);
        expect(turn.status).toBe("waiting");
        expect(turn.wait!.tries).toBe(1);
        expect(turn.error).not.toContain("stopped trying");
      }
      expect(JSON.parse(h.store.kvGet(`limitWait:${chainId}:${member.id}`)!).tries).toBe(1);
      // And the limit's own reset still carries it on, as if nothing had been tapped.
      h.clock.now = h.newest(room).wait!.runAt;
      h.engine.checkWaits();
      await h.idle();
      expect(h.newest(room).status).toBe("done");
    } finally {
      await h.done();
    }
  });

  test("Try again while it waits carries on, with the same messages", async () => {
    const h = setup();
    try {
      const { room, msg } = await waitingChat(h);
      const turn = h.engine.retry(room.id);
      expect(turn.triggerMessageId).toBe(msg.id);
      await h.idle();
      expect(h.newest(room).status).toBe("done");
      expect(h.prompts.at(-1)!.prompt).toContain("usage limit to reset");
    } finally {
      await h.done();
    }
  });
});

describe("a rewind only ends the waits it takes back", () => {
  test("editing a message for another agent leaves a waiting agent waiting", async () => {
    const h = setup();
    try {
      const room = h.chat({ parallel: true, chat: { provider: "mock", origin: "web", group: true } });
      const stuck = h.add(room, "one", atReset(60 * MIN));
      h.add(room, "two", { delayMs: 400 });
      await h.say(room, "@one please build it");
      const waiting = h.engine.limitWaiting(room.id, stuck.id)!;
      expect(waiting).not.toBe(null);
      // @two is working on a message of its own; another one for @two arrives behind it, unread.
      h.engine.postHumanMessage(room.id, "@two take your time", "Phone");
      await Bun.sleep(60);
      const mine = h.engine.postHumanMessage(room.id, "@two and this", "Phone");
      await h.engine.reviseMessage(mine.id, "@two and this instead", "Phone");
      // Nothing of @one's was taken back, so its reply still carries on by itself.
      expect(h.engine.limitWaiting(room.id, stuck.id)!.id).toBe(waiting.id);
      expect(h.store.getMember(stuck.id)!.status).toBe("waiting");
      await h.idle();
      h.clock.now = waiting.wait.runAt;
      h.engine.checkWaits();
      await h.idle();
      expect(h.turns(room).filter((t) => t.memberId === stuck.id && t.status === "done")).toHaveLength(1);
    } finally {
      await h.done();
    }
  });

  test("editing the message it was answering does end its wait", async () => {
    const h = setup();
    try {
      const room = h.chat();
      const member = h.add(room, "tester", atReset(60 * MIN));
      const msg = await h.say(room, "please build it");
      const waited = h.newest(room);
      await h.engine.reviseMessage(msg.id, "please build it, carefully", "Phone");
      expect(h.store.getTurn(waited.id)!.status).toBe("stopped");
      expect(h.engine.limitWaiting(room.id)).toBe(null);
      expect(h.store.getMember(member.id)!.wait ?? null).toBe(null);
      await h.idle();
    } finally {
      await h.done();
    }
  });
});

/** A hub with its own notifications collected, and chats whose agent is out of messages. */
function noteHub(names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ct-limit-note-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
  const sent: PushNote[] = [];
  const dropped: string[] = [];
  app.push.send = async (note) => (sent.push(note), { sent: 1, failed: 0 });
  const drop = app.push.drop.bind(app.push);
  app.push.drop = (tag: string, text?: string) => {
    dropped.push(tag);
    drop(tag, text);
  };
  const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
  deps.createDriver = (ctx) => new MockDriver(ctx);
  deps.resolveBin = () => "";
  deps.agentEnv = () => ({});
  app.storage.check = async () => {};
  const rooms = names.map((name) => app.createRoom({ name }));
  for (const room of rooms) app.addMember(room.id, { provider: "mock", handle: "tester", config: { delayMs: 10, limit: { label: "5-hour", resetsAt: Date.now() + 3600_000, times: 1 } } });
  const settle = async () => {
    await app.engine.whenIdle();
    await Bun.sleep(1200); // the notes of one account settle for a moment, then go as one
  };
  const done = async () => {
    await app.engine.shutdown();
    // As App.shutdown does: no spend event is put off past the database's closing.
    app.spend.stop();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, rooms, sent, dropped, settle, done };
}

describe("telling the user", () => {
  test("several chats waiting on one account make one notification, and one when they carry on", async () => {
    const h = noteHub(["Checkout", "Billing"]);
    const { app, rooms, sent } = h;
    try {
      for (const room of rooms) app.engine.postHumanMessage(room.id, "hello", "Phone");
      await app.engine.whenIdle();
      // The notes of one account settle for a moment, then go as one: no storm when a plan runs out mid-morning.
      await Bun.sleep(1200);
      const waiting = sent.filter((n) => n.tag.startsWith("limit-wait-"));
      expect(waiting).toHaveLength(1);
      expect(waiting[0].tag).toBe("limit-wait-mock-default");
      expect(waiting[0].body).toContain("Test agent is out of messages until");
      expect(waiting[0].body).toContain("+1 other chat.");
      expect(waiting[0].title).toBe("2 chats");
      // No "stopped with an error" notification for a reply that's only waiting.
      expect(sent.some((n) => n.tag.startsWith("err-"))).toBe(false);

      // Both carry on: one note again, not one per chat.
      sent.length = 0;
      for (const room of rooms) app.engine.tryNow(room.id);
      await app.engine.whenIdle();
      await Bun.sleep(1200);
      const back = sent.filter((n) => n.tag.startsWith("limit-back-"));
      expect(back).toHaveLength(1);
      expect(back[0].body).toContain("Test agent carried on where it left off.");
      expect(back[0].body).toContain("+1 other chat.");
    } finally {
      await h.done();
    }
  });

  test("one chat carrying on leaves the account's note standing for the chats still waiting", async () => {
    const h = noteHub(["Checkout", "Billing", "Shipping"]);
    const { app, rooms, sent, dropped } = h;
    try {
      for (const room of rooms) app.engine.postHumanMessage(room.id, "hello", "Phone");
      await h.settle();
      sent.length = 0;

      // The first chat carries on; the other two are still out of messages.
      app.engine.tryNow(rooms[0].id);
      await h.settle();
      expect(dropped).toEqual([]); // the one note about the others wasn't taken away
      const standing = sent.filter((n) => n.tag === "limit-wait-mock-default");
      expect(standing).toHaveLength(1);
      expect(standing[0].body).toContain("Test agent is out of messages until");
      expect(standing[0].body).toContain("+1 other chat."); // two chats left
      expect(sent.filter((n) => n.tag.startsWith("limit-back-"))).toHaveLength(1);

      // The last of them carries on: now the note goes.
      sent.length = 0;
      app.engine.tryNow(rooms[1].id);
      app.engine.tryNow(rooms[2].id);
      await h.settle();
      expect([...new Set(dropped)]).toEqual(["limit-wait-mock-default"]);
      expect(sent.filter((n) => n.tag === "limit-wait-mock-default")).toEqual([]);
    } finally {
      await h.done();
    }
  });
});

describe("what devices are told", () => {
  test("the waiting turn and the agent's status go out, with the wait on the turn", async () => {
    const h = setup();
    try {
      const room = h.chat();
      h.add(room, "tester", atReset(45 * MIN));
      await h.say(room, "hello");
      const turnEvents = h.events.filter((e): e is ServerEvent & { t: "turn"; turn: Turn } => e.t === "turn");
      const waiting = turnEvents.filter((e) => e.turn.status === "waiting");
      expect(waiting.length).toBe(1);
      expect(waiting[0].turn.wait).toMatchObject({ label: "5-hour", kind: "usage" });
      const member = h.events.filter((e) => e.t === "member").at(-1)!;
      expect(member).toMatchObject({ t: "member", member: { status: "waiting" } });
    } finally {
      await h.done();
    }
  });
});
