// A chat waiting for a usage limit is on the hub, not in memory: it still carries on after a restart, a deploy or a
// reboot, and a reset that went by while the hub was down runs at once. One Store stands in for the database file; a
// second Engine over it is the next hub process.

import { describe, expect, test } from "bun:test";
import type { Member, Room } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import { MockDriver } from "../src/agents/mock";
import { newId } from "../src/util/ids";

const START = Date.UTC(2026, 9, 28, 12, 0, 0);
const MIN = 60_000;

function hub(store: Store, clock: { now: number }) {
  const bus = new Bus();
  const prompts: string[] = [];
  const engine = new Engine({
    store,
    bus,
    createDriver: (ctx) => {
      const inner = new MockDriver(ctx);
      return {
        provider: ctx.member.provider,
        runTurn: (input, sink) => {
          prompts.push(input.prompt);
          return inner.runTurn(input, sink);
        },
        interrupt: () => inner.interrupt(),
        dispose: () => inner.dispose(),
      };
    },
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    now: () => clock.now,
  });
  const idle = async () => {
    await Bun.sleep(5);
    await engine.whenIdle();
    await Bun.sleep(5);
  };
  return { engine, bus, prompts, idle };
}

function chatWith(store: Store, config: Record<string, unknown>): { room: Room; member: Member } {
  const now = Date.now();
  const room: Room = {
    id: newId("r"),
    name: "Waiting chat",
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
  };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "mock", origin: "web", localId: null });
  const member: Member = {
    id: newId("mb"),
    roomId: room.id,
    handle: "tester",
    provider: "mock",
    model: null,
    role: "",
    permissionMode: "ask",
    status: "idle",
    statusDetail: null,
    config: { delayMs: 10, ...config },
    createdAt: Date.now(),
    position: 0,
  };
  store.insertMember(member);
  return { room, member };
}

describe("a wait survives a restart", () => {
  test("the row is still waiting, the agent still says so, and a reset that passed runs at once", async () => {
    const store = new Store(":memory:");
    const clock = { now: START };
    const { room, member } = chatWith(store, { limit: { label: "5-hour", resetsAt: START + 60 * MIN, times: 1 } });
    const first = hub(store, clock);
    const msg = first.engine.postHumanMessage(room.id, "please build it", "Phone");
    await first.idle();
    const waited = store.listTurns(room.id).at(-1)!;
    expect(waited.status).toBe("waiting");
    await first.engine.shutdown();

    // Crosstalk restarts. Nothing marks the wait as interrupted work, and nothing fails it.
    expect(store.unfinishedTurns()).toEqual([]);
    expect(store.getTurn(waited.id)!.status).toBe("waiting");

    // It comes back after the reset (a deploy, or a machine that was down for hours), and the limit has gone.
    clock.now = waited.wait!.runAt + 5 * MIN;
    store.updateMember(member.id, { config: { delayMs: 10 } });
    const second = hub(store, clock);
    try {
      // The new process knows the chat is waiting, in the same words, and still hands devices the wait itself (so each
      // says the time in its own clock).
      expect(store.getMember(member.id)).toMatchObject({ status: "waiting", statusDetail: waited.error!, wait: { label: "5-hour", resetsAt: START + 60 * MIN } });
      expect(second.engine.limitWaiting(room.id)!.id).toBe(waited.id);
      second.engine.resumeAfterRestart();
      await second.idle();
      const fresh = store.listTurns(room.id).at(-1)!;
      expect(fresh.id).not.toBe(waited.id);
      expect(fresh.status).toBe("done");
      expect(fresh.triggerMessageId).toBe(msg.id);
      expect(second.prompts.at(-1)!).toContain("waited for your 5-hour usage limit to reset");
      expect(second.prompts.at(-1)!).toContain("please build it");
      expect(store.getMember(member.id)!.status).toBe("idle");
    } finally {
      await second.engine.shutdown();
      store.close();
    }
  });

  test("a wait whose time hasn't come keeps waiting across the restart, and isn't started twice", async () => {
    const store = new Store(":memory:");
    const clock = { now: START };
    const { room, member } = chatWith(store, { limit: { label: "Weekly", resetsAt: START + 6 * 3600_000, times: 1 } });
    const first = hub(store, clock);
    first.engine.postHumanMessage(room.id, "hello", "Phone");
    await first.idle();
    const waited = store.listTurns(room.id).at(-1)!;
    await first.engine.shutdown();

    const second = hub(store, clock);
    try {
      second.engine.resumeAfterRestart();
      await second.idle();
      expect(store.getTurn(waited.id)!.status).toBe("waiting");
      expect(store.listTurns(room.id).length).toBe(1);
      // Its time comes (and the limit has gone): it runs once, however often the round comes.
      clock.now = waited.wait!.runAt;
      store.updateMember(member.id, { config: { delayMs: 10 } });
      second.engine.checkWaits();
      second.engine.checkWaits();
      await second.idle();
      expect(store.listTurns(room.id).filter((t) => t.status === "done").length).toBe(1);
      expect(store.listTurns(room.id).length).toBe(2);
    } finally {
      await second.engine.shutdown();
      store.close();
    }
  });

  test("the try count is kept on the hub, so a restart loop can't wait forever", async () => {
    const store = new Store(":memory:");
    const clock = { now: START };
    const { room } = chatWith(store, { limit: { label: "5-hour", resetsAt: null } });
    const first = hub(store, clock);
    first.engine.postHumanMessage(room.id, "hello", "Phone");
    await first.idle();
    expect(store.listTurns(room.id).at(-1)!.wait!.tries).toBe(1);
    await first.engine.shutdown();

    const second = hub(store, clock);
    try {
      clock.now = store.listTurns(room.id).at(-1)!.wait!.runAt;
      second.engine.checkWaits();
      await second.idle();
      // The second try counts as the second, not the first again, and keeps the first try's start time.
      const again = store.listTurns(room.id).at(-1)!;
      expect(again.wait).toMatchObject({ tries: 2, since: START });
      expect(again.wait!.runAt - clock.now).toBe(15 * MIN);
    } finally {
      await second.engine.shutdown();
      store.close();
    }
  });
});
