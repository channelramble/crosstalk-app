import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";

const device = { id: "d", name: "Phone", platform: "", createdAt: 0, lastSeenAt: 0 } as never;

/** Waits until `check` holds (the mock agent works on its own clock). */
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("the state a device loads says since when each reply has run, and which agents' helpers still work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-list-facts-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  await app.start();
  try {
    const quiet = app.createRoom({ name: "Quiet", mode: "direct" });
    const idle = app.addMember(quiet.id, { provider: "mock", handle: "idle", config: { delayMs: 5 } });
    const long = app.createRoom({ name: "Long", mode: "direct" });
    const slow = app.addMember(long.id, { provider: "mock", handle: "slow", config: { delayMs: 400 } });
    const helped = app.createRoom({ name: "Helped", mode: "direct" });
    const lead = app.addMember(helped.id, { provider: "mock", handle: "lead", config: { delayMs: 5, helpers: { ms: 250 } } });

    // Nothing running: both are there, and empty (an older hub leaves them out, and the app then goes by events alone).
    expect(app.snapshot(device).replyStarts).toEqual({});
    expect(app.snapshot(device).tasks).toEqual({});

    // A reply under way: its agent, with the reply's turn and when it started. No other agent is listed.
    const before = Date.now();
    app.engine.postHumanMessage(long.id, "@slow take your time", "Phone");
    await until(() => !!app.snapshot(device).replyStarts?.[slow.id]);
    const start = app.snapshot(device).replyStarts![slow.id];
    const turn = app.store.listTurns(long.id).find((t) => t.memberId === slow.id)!;
    expect(start).toEqual({ turnId: turn.id, at: turn.startedAt ?? turn.createdAt });
    expect(start.at).toBeGreaterThanOrEqual(before);
    expect(Object.keys(app.snapshot(device).replyStarts!)).toEqual([slow.id]);

    // A reply that ended while its helper works on: the agent is idle, and only the state's tasks say it still works.
    app.engine.postHumanMessage(helped.id, "@lead check it", "Phone");
    await until(() => !!app.snapshot(device).tasks?.[lead.id]);
    await until(() => app.store.getMember(lead.id)?.status === "idle");
    const snap = app.snapshot(device);
    expect(snap.tasks![lead.id]).toMatchObject([{ id: "mock-helper", kind: "local_agent", status: "running", background: true }]);
    expect(Object.keys(snap.tasks!)).toEqual([lead.id]);
    expect(snap.replyStarts![lead.id]).toBeUndefined();
    expect(snap.tasks![idle.id]).toBeUndefined();

    // The helper done and the long reply ended: neither is listed any more.
    await until(() => !app.snapshot(device).tasks?.[lead.id]);
    await app.engine.whenIdle();
    await until(() => !app.snapshot(device).replyStarts?.[slow.id]);
    expect(app.snapshot(device).replyStarts).toEqual({});
    expect(app.snapshot(device).tasks).toEqual({});
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
