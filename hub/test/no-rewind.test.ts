// A chat whose agent can't go back to an earlier message (NO_REWIND_AGENTS: OpenCode has no form for it over ACP). What it
// has read stays as it is, and asking anyway changes nothing; what it hasn't read can still be changed or taken back.
import { describe, expect, test } from "bun:test";
import { NO_REWIND_AGENTS, isNoRewindAgent, type Room } from "@crosstalk/shared";
import { BuiltinDriver } from "../src/agents/builtin";
import type { AgentDriver, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { OpenCodeDriver } from "../src/agents/opencode";
import { Bus } from "../src/bus";
import { Store } from "../src/db";
import { Engine } from "../src/engine/engine";
import { newId } from "../src/util/ids";

test("the agents the app offers no Rewind or Send now for are the ones whose drivers have neither", () => {
  expect([...NO_REWIND_AGENTS]).toEqual(["opencode"]);
  expect(isNoRewindAgent("opencode")).toBe(true);
  for (const p of ["builtin", "claude", "codex", undefined]) expect(isNoRewindAgent(p)).toBe(false);
  const openCode: Partial<AgentDriver> = OpenCodeDriver.prototype;
  expect(openCode.rewind).toBeUndefined();
  expect(openCode.steer).toBeUndefined();
  expect(BuiltinDriver.prototype.rewind).toBeFunction();
  expect(BuiltinDriver.prototype.steer).toBeFunction();
});

/** An agent with no `rewind`, stopped by a usage limit that says when it resets while `limited` is set. */
class NoWayBack implements AgentDriver {
  readonly provider = "mock" as const;
  static limited = false;
  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    if (NoWayBack.limited) return { ok: false, error: "Out of messages", limit: { kind: "usage", label: "5-hour", resetsAt: Date.now() + 3_600_000, source: "event" } };
    sink.taken?.();
    sink.text(`Answer to: ${input.prompt.slice(-20)}`);
    return { ok: true };
  }
  async interrupt() {}
  async dispose() {}
}

function setup() {
  NoWayBack.limited = false;
  const store = new Store(":memory:");
  const engine = new Engine({ store, bus: new Bus(), createDriver: () => new NoWayBack(), mcpLaunch: () => ({ command: "true", args: [], env: {} }), carryOnAfterLimit: () => true });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "Chat", cwd: "/tmp", mode: "relay", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false, chat: { provider: "mock", origin: "web" } };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "mock", origin: "web", localId: null });
  const member = { id: newId("mb"), roomId: room.id, handle: "tester", provider: "mock" as const, model: null, role: "", permissionMode: "ask" as const, status: "idle" as const, statusDetail: null, config: {}, createdAt: now, position: 0 };
  store.insertMember(member);
  const say = async (text: string) => {
    const m = engine.postHumanMessage(room.id, text, "Phone");
    await Bun.sleep(5);
    await engine.whenIdle();
    await Bun.sleep(5);
    return m;
  };
  const newest = () => store.listTurns(room.id).at(-1)!;
  return { store, engine, room, member, say, newest, done: async () => { await engine.shutdown(); store.close(); } };
}

const REFUSED = { status: 400, message: "This agent can't go back to an earlier message" };

describe("a chat whose agent can't go back", () => {
  test("a read message can't be edited or unsent, and the chat stays as it was", async () => {
    const h = setup();
    try {
      const first = await h.say("First");
      await h.say("Second");
      const before = h.store.listMessages(h.room.id).map((m) => [m.id, m.text]);
      await expect(h.engine.reviseMessage(first.id, "Changed", "Phone")).rejects.toMatchObject(REFUSED);
      await expect(h.engine.reviseMessage(first.id, null, "Phone")).rejects.toMatchObject(REFUSED);
      expect(h.store.listMessages(h.room.id).map((m) => [m.id, m.text])).toEqual(before);
    } finally {
      await h.done();
    }
  });

  test("a refused edit of a read message doesn't end the wait for a limit", async () => {
    const h = setup();
    try {
      const read = await h.say("First");
      NoWayBack.limited = true;
      await h.say("Second");
      expect(h.newest().status).toBe("waiting");
      const reply = h.store.getMessage(h.newest().replyMessageId!)!.text;
      await expect(h.engine.reviseMessage(read.id, "Changed", "Phone")).rejects.toMatchObject(REFUSED);
      expect(h.newest().status).toBe("waiting");
      expect(h.newest().wait).not.toBeNull();
      expect(h.store.getMember(h.member.id)!.status).toBe("waiting");
      expect(h.store.getMessage(h.newest().replyMessageId!)!.text).toBe(reply);
      expect(h.store.getMessage(read.id)!.text).toBe("First");
    } finally {
      await h.done();
    }
  });

  test("what it hasn't read can still be changed and taken back", async () => {
    const h = setup();
    try {
      await h.say("First");
      NoWayBack.limited = true;
      const waiting = await h.say("Second");
      expect(h.store.messageSeq(waiting.id)).toBeGreaterThan(h.store.getLastSeen(h.member.id).seq);
      await h.engine.reviseMessage(waiting.id, "Second, changed", "Phone");
      expect(h.store.getMessage(waiting.id)!.text).toBe("Second, changed");
      const { removed } = await h.engine.reviseMessage(waiting.id, null, "Phone");
      expect(removed).toContain(waiting.id);
      expect(h.store.getMessage(waiting.id)).toBeFalsy();
    } finally {
      await h.done();
    }
  });
});
