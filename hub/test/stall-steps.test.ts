// An agent that freezes on a step (a shell command that never ends, usually) is restarted once; the error names that
// step and how long it ran, and a retry that freezes again says so plainly, with what to do.
import { expect, test } from "bun:test";
import type { Room } from "@crosstalk/shared";
import type { TurnInput, TurnSink } from "../src/agents/driver";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import { newId } from "../src/util/ids";

function frozen(step: (sink: TurnSink, call: number) => void) {
  const store = new Store(":memory:");
  const inputs: TurnInput[] = [];
  const engine = new Engine({
    store,
    bus: new Bus(),
    stallMs: 150,
    createDriver: () => ({
      provider: "mock",
      runTurn: (input, sink) => {
        inputs.push(input);
        step(sink, inputs.length);
        return new Promise(() => {}); // never answers again
      },
      interrupt: async () => {},
      dispose: async () => {},
    }),
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
  const turns = () => store.listTurns(room.id, 20).sort((a, b) => a.createdAt - b.createdAt);
  return { store, engine, room, inputs, turns };
}

test("frozen on a command: the error names it and how long it ran; the retry is told not to run it the same way", async () => {
  const t = frozen((sink) => {
    sink.activity({ kind: "thinking", title: "Thinking", detail: "Let me run the tests.", status: "done" });
    sink.activity({ kind: "command", title: "npm test -- --watch", detail: "# Run the tests\nnpm test -- --watch" });
  });
  t.engine.postHumanMessage(t.room.id, "run the tests", "Mac");
  await t.engine.whenIdle();
  const [first, second] = t.turns();
  expect(first.error).toBe("@claude got stuck on `npm test -- --watch` for 1 minute, so Crosstalk restarted it and asked it to continue.");
  expect(t.inputs[1].prompt).toContain("Your last turn stopped responding while on `npm test -- --watch` (running 1 minute)");
  expect(t.inputs[1].prompt).toContain("run it in the background or with a time limit");
  expect(t.inputs[1].prompt).toContain("run the tests"); // the request again
  // The retry froze too: said plainly, with what to do.
  expect(second.error).toBe(
    "@claude froze again after Crosstalk restarted it, stuck on `npm test -- --watch` for 1 minute, so Crosstalk stopped it. That command may be waiting for input or never finish by itself: ask for it to run in the background or with a time limit, or run it yourself in Terminal, then send a message to carry on.",
  );
  expect(t.turns().length).toBe(2); // not retried a second time
  // The steps it froze on end as failed, instead of showing as still running.
  const steps = t.store.listActivities(t.room.id, [first.id, second.id]).filter((a) => a.kind === "command");
  expect(steps.map((a) => a.status)).toEqual(["error", "error"]);
  await t.engine.shutdown();
});

test("frozen elsewhere: the step it was on, by name; with none, how long it went silent", async () => {
  const t = frozen((sink, call) => {
    if (call === 1) sink.activity({ kind: "tool", title: "Fetch https://example.com/huge", detail: "" });
  });
  t.engine.postHumanMessage(t.room.id, "read that page", "Mac");
  await t.engine.whenIdle();
  const [first, second] = t.turns();
  expect(first.error).toBe('@claude got stuck on "Fetch https://example.com/huge" for 1 minute, so Crosstalk restarted it and asked it to continue.');
  expect(t.inputs[1].prompt).not.toContain("background"); // advice for commands only
  expect(second.error).toBe("@claude froze again after Crosstalk restarted it (no sign of life for 1 minute), so Crosstalk stopped it. Send a message to try again. If it keeps freezing, start a fresh session in the chat's settings.");
  await t.engine.shutdown();
});
