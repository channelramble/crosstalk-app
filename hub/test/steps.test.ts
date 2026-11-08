// Streaming a step (activity) to the phone: what it adds goes as deltas, in batches; whole steps only when they're
// replaced. Older apps still get whole steps (now and then), and history sends finished steps' long details short.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, Member, Room, ServerEvent } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import type { AgentDriver, TurnSink } from "../src/agents/driver";
import { newId } from "../src/util/ids";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { registerDriver } from "../src/agents";
import { MockDriver } from "../src/agents/mock";

type Script = (sink: TurnSink) => Promise<void>;

function engineSetup(script: Script) {
  const store = new Store(":memory:");
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  const engine = new Engine({
    store,
    bus,
    createDriver: (): AgentDriver => ({
      provider: "mock",
      runTurn: async (_input, sink) => {
        await script(sink);
        return { ok: true, text: "Done." };
      },
      interrupt: async () => {},
      dispose: async () => {},
    }),
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  const member: Member = { id: newId("mb"), roomId: room.id, handle: "agent", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 };
  store.insertMember(member);
  const steps = (t: ServerEvent["t"]) => events.filter((e) => e.t === t);
  return { store, engine, room, events, steps };
}

/** Rebuilds a step's detail from the events a new app gets: the whole step, then each delta where it says. */
function replay(events: ServerEvent[], id: string): Activity | null {
  let a: Activity | null = null;
  for (const e of events) {
    if (e.t === "activity" && e.activity.id === id) a = { ...e.activity };
    else if (e.t === "activity.delta" && e.activityId === id && a) {
      const cur: Activity = a;
      expect(e.offset).toBe(cur.detail.length); // contiguous: nothing lost, nothing repeated
      a = { ...cur, detail: cur.detail + e.delta, ...(e.status ? { status: e.status } : {}), ...(e.title ? { title: e.title } : {}) };
    }
  }
  return a;
}

describe("streaming a step", () => {
  test("what a step adds goes out as deltas in a few batches, and a status change goes at once with what was waiting", async () => {
    let id = "";
    const t = engineSetup(async (sink) => {
      id = sink.activity({ kind: "thinking", title: "Thinking", detail: "" });
      for (let i = 0; i < 300; i++) {
        sink.updateActivity(id, { appendDetail: `piece ${i} ` });
        if (i % 50 === 49) await Bun.sleep(5);
      }
      sink.updateActivity(id, { status: "done" });
    });
    t.engine.postHumanMessage(t.room.id, "think", "Mac");
    await t.engine.whenIdle();
    const whole = t.steps("activity");
    const deltas = t.steps("activity.delta") as Extract<ServerEvent, { t: "activity.delta" }>[];
    expect(whole.length).toBe(1); // created; never resent whole
    expect(deltas.length).toBeLessThan(5); // 300 pieces in a couple of batches
    expect(deltas.at(-1)!.status).toBe("done");
    const expected = Array.from({ length: 300 }, (_, i) => `piece ${i} `).join("");
    expect(replay(t.events, id)).toMatchObject({ detail: expected, status: "done" });
    // Saved as it went out.
    expect(t.store.getActivity(id)).toMatchObject({ detail: expected, status: "done" });
    await t.engine.shutdown();
  });

  test("a replaced detail goes whole; one that only adds to what was sent goes as the addition", async () => {
    let id = "";
    const t = engineSetup(async (sink) => {
      id = sink.activity({ kind: "command", title: "npm test", detail: "" });
      sink.updateActivity(id, { appendDetail: "ok 1\n" });
      await Bun.sleep(260);
      sink.updateActivity(id, { detail: "ok 1\nok 2\n" }); // Codex's final output: the same plus more
      await Bun.sleep(260);
      sink.updateActivity(id, { detail: "3 passed\n", status: "done", title: "npm test (exit 0)" }); // a real replacement
    });
    t.engine.postHumanMessage(t.room.id, "test", "Mac");
    await t.engine.whenIdle();
    const kinds = t.events.filter((e) => (e.t === "activity" || e.t === "activity.delta") && ("activity" in e ? e.activity.id === id : e.activityId === id)).map((e) => e.t);
    expect(kinds).toEqual(["activity", "activity.delta", "activity.delta", "activity"]);
    expect(t.store.getActivity(id)).toMatchObject({ detail: "3 passed\n", status: "done", title: "npm test (exit 0)" });
    await t.engine.shutdown();
  });

  test("past the size limit the oldest output goes in one cut, and what comes after streams as deltas again", async () => {
    let id = "";
    const t = engineSetup(async (sink) => {
      id = sink.activity({ kind: "command", title: "yes", detail: "" });
      for (let i = 0; i < 80; i++) {
        sink.updateActivity(id, { appendDetail: `${String(i).padStart(4, "0")}${"y".repeat(995)}\n` });
        await Bun.sleep(1);
      }
      sink.updateActivity(id, { status: "done" });
    });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    const whole = t.events.filter((e) => e.t === "activity" && e.activity.id === id) as Extract<ServerEvent, { t: "activity" }>[];
    expect(whole.length).toBe(2); // created, then cut back once (not on every piece after the limit)
    expect(whole[1].activity.detail.startsWith("…(earlier output trimmed)\n")).toBe(true);
    const final = replay(t.events, id)!;
    expect(final.detail.length).toBeLessThanOrEqual(64_000);
    expect(final.detail.endsWith(`0079${"y".repeat(995)}\n`)).toBe(true);
    expect(t.store.getActivity(id)!.detail).toBe(final.detail);
    await t.engine.shutdown();
  });
});

describe("what apps download", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  async function hub(script: Script) {
    registerDriver("mock", () => ({
      provider: "mock",
      runTurn: async (_input, sink) => {
        await script(sink);
        return { ok: true, text: "Done." };
      },
      interrupt: async () => {},
      dispose: async () => {},
    }));
    const dir = mkdtempSync(join(tmpdir(), "ct-steps-"));
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
    await app.start();
    const server = startServer(app);
    const { token } = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "iPhone"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const sockets: WebSocket[] = [];
    cleanup = async () => {
      for (const ws of sockets) ws.close();
      server.stop(true);
      await app.engine.shutdown();
      app.store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(app.computers.dir, { recursive: true, force: true });
      registerDriver("mock", (ctx) => new MockDriver(ctx));
    };
    const connect = async (query: string) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws?token=${token}${query}`);
      sockets.push(ws);
      const got = { events: [] as ServerEvent[], bytes: 0 };
      ws.onmessage = (e) => {
        got.bytes += String(e.data).length;
        got.events.push(JSON.parse(String(e.data)));
      };
      await new Promise((res) => (ws.onopen = res));
      return got;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
    return { app, connect, get };
  }

  test("a long thought: new apps get deltas, older apps the whole step about once a second, both far less than before", async () => {
    let id = "";
    const h = await hub(async (sink) => {
      id = sink.activity({ kind: "thinking", title: "Thinking", detail: "" });
      for (let i = 0; i < 600; i++) {
        sink.updateActivity(id, { appendDetail: `${"word ".repeat(7)}${String(i).padStart(5, "0")} ` }); // 41 characters
        if (i % 10 === 9) await Bun.sleep(25);
      }
      sink.updateActivity(id, { status: "done" });
    });
    const older = await h.connect("");
    const newer = await h.connect("&v=2");
    const room = h.app.createRoom({ name: "Think", mode: "direct" });
    h.app.addMember(room.id, { provider: "mock", handle: "agent" });
    h.app.engine.postHumanMessage(room.id, "think hard", "Phone");
    await Bun.sleep(50);
    await h.app.engine.whenIdle();
    await Bun.sleep(1200); // an older app's last catch-up
    const detail = h.app.store.getActivity(id)!.detail;
    expect(detail.length).toBe(600 * 41);

    expect(newer.events.some((e) => e.t === "activity.delta")).toBe(true);
    expect(replay(newer.events, id)).toMatchObject({ detail, status: "done" });
    const newerSteps = newer.events.filter((e) => e.t === "activity" || e.t === "activity.delta");
    expect(newerSteps.length).toBeLessThan(40);

    // Older apps never see a delta: whole steps, a few times, ending with the finished one.
    expect(older.events.some((e) => e.t === "activity.delta")).toBe(false);
    const olderSteps = older.events.filter((e) => e.t === "activity") as Extract<ServerEvent, { t: "activity" }>[];
    expect(olderSteps.length).toBeGreaterThan(1);
    expect(olderSteps.length).toBeLessThan(10);
    expect(olderSteps.at(-1)!.activity).toMatchObject({ detail, status: "done" });

    // Before this, every piece re-sent the whole step: about 600 × 12 KB (7 MB) for this one 24 KB thought.
    const stepBytes = (events: ServerEvent[]) => events.filter((e) => e.t === "activity" || e.t === "activity.delta").reduce((n, e) => n + JSON.stringify(e).length, 0);
    expect(stepBytes(newer.events)).toBeLessThan(detail.length * 1.5);
    expect(stepBytes(older.events)).toBeLessThan(detail.length * 10);
  });

  test("history sends finished steps' long details short to new apps, whole to older ones; a step loads whole by id", async () => {
    let longId = "";
    let liveId = "";
    let release = () => {};
    const h = await hub(async (sink) => {
      longId = sink.activity({ kind: "command", title: "npm test", detail: "" });
      sink.updateActivity(longId, { appendDetail: "ok\n".repeat(2000), status: "done" });
      sink.activity({ kind: "command", title: "ls", detail: "README.md\n", status: "done" });
      liveId = sink.activity({ kind: "command", title: "npm run build", detail: "" });
      sink.updateActivity(liveId, { appendDetail: "building\n".repeat(400) });
      await new Promise<void>((res) => (release = res));
    });
    const room = h.app.createRoom({ name: "History", mode: "direct" });
    h.app.addMember(room.id, { provider: "mock", handle: "agent" });
    h.app.engine.postHumanMessage(room.id, "test", "Phone");
    while (!liveId) await Bun.sleep(5);
    expect(h.app.engine.liveActivity(liveId)?.status).toBe("running");
    await Bun.sleep(300); // its output so far is saved

    const newer = await h.get(`/api/rooms/${room.id}/history?limit=80&v=2`);
    const older = await h.get(`/api/rooms/${room.id}/history?limit=80`);
    const find = (res: { activities: Activity[] }, id: string) => res.activities.find((a) => a.id === id)!;
    expect(find(newer, longId)).toMatchObject({ detailLength: 6000, status: "done" });
    expect(find(newer, longId).detail.length).toBeLessThanOrEqual(1200);
    expect(find(newer, liveId).detailLength).toBeUndefined(); // running: whole, its output keeps coming
    expect(find(newer, liveId).detail.length).toBe(3600);
    expect(find(older, longId).detail.length).toBe(6000);
    expect(find(older, longId).detailLength).toBeUndefined();
    expect(JSON.stringify(newer).length).toBeLessThan(JSON.stringify(older).length - 4000);

    expect(await h.get(`/api/activities/${longId}`)).toMatchObject({ id: longId, detail: "ok\n".repeat(2000) });
    expect((await h.get(`/api/activities/${liveId}`)).detail).toBe("building\n".repeat(400));
    release();
    await h.app.engine.whenIdle();
  });
});
