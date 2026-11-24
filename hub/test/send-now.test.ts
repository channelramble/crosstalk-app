// A message sent while the agent works goes into its running reply by itself, at its next step, whether or not its helpers
// are at work: see "messages go to a working agent by themselves". There's no button for it and no setting (until 0.8 it
// waited behind the reply for a tap on Send now unless helpers were at work, and Settings → "Keep going while helpers work"
// could turn even that off). Only what may not be answered around holds it: an account switch, tighter permissions, a new
// folder. A reply that can't take it gets it as the reply ends.
//
// "Send now" is still a call an older app can make, and it says why it didn't send, so that app can say what really holds
// your message. A chat's Send now once answered "It's being answered already, or the reply just ended" while the message
// was held behind the agent's helpers (the chat had been moved from Opus 5 to Opus 5.5 during a reply, and new settings
// wait for the helpers) and nothing was being answered. Meanwhile Claude Code's own replies, as its helpers reported back,
// ran on the old Opus 5 process. Every agent here is an in-process stand-in whose turns end when the test says; no CLI runs.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitQueuedWords, limitResetTime, type BackgroundTask, type HubInfo, type Member, type Room, type SendNowResult, type ServerEvent } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, TurnResult } from "../src/agents/driver";
import type { EngineDeps } from "../src/engine/engine";
import { App } from "../src/app";
import { buildRoutes, startServer } from "../src/server";

setDefaultTimeout(20_000);

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The chat's one note per hold, while messages go around new settings that wait for the helpers. */
const AROUND = "Your new settings apply when Claude Code's helpers finish. Until then it answers with the settings it started with.";

const helper = (status: BackgroundTask["status"]): BackgroundTask => ({ id: "workflow-1", kind: "local_workflow", description: "Build the setup step", agentType: null, workflow: "setup-step", background: true, status, startedAt: Date.now(), endedAt: status === "running" ? null : Date.now(), tokens: null, toolUses: null, lastTool: null, summary: null, error: null });

/**
 * A one-agent chat on a hub of its own, on Opus 5.
 * Each turn the agent takes waits until the test ends it (`end`). `steer`: the agent takes a message mid-reply (true),
 * refuses it (false), or can't at all (absent). `working`: each reply has the message in hand as it starts, as a real
 * agent does once it's working on it (a refused message then means the reply was ending). `knobs` changes what its
 * process does from then on: whether it takes a message now, how long a hand-over takes (Codex's is a call to its server),
 * what it owes by itself.
 */
function chat(steer?: boolean, opts: { working?: boolean; provider?: "claude" | "codex" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-send-now-"));
  dirs.push(dir);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
  const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
  const prompts: string[] = [];
  const steered: string[] = [];
  const ends: ((r: TurnResult) => void)[] = [];
  const drivers = { made: 0, ended: 0 };
  const knobs: { takes: boolean; steerMs: number; stopMs: number; owed: "report" | "message" | null; dropsHanded: boolean; carry: string | null } = { takes: !!steer, steerMs: 0, stopMs: 0, owed: null, dropsHanded: false, carry: null };
  /** What was handed to the reply, by message id: gone when a reply it never read ends (knobs.dropsHanded), as on Codex. */
  const handed: string[] = [];
  /** Which process (1 for the first driver made) answered each reply, the agent's own included, and on what it was started with. */
  const ran: { driver: number; model: string | null; permissionMode: string; account: unknown }[] = [];
  let tasks: DriverContext["onTasks"];
  /** The newest process's way to start a reply of its own, and what it was started with. */
  let own: { start: DriverContext["onOwnTurn"]; started: (typeof ran)[number] } | null = null;
  deps.createDriver = (ctx) => {
    const no = ++drivers.made;
    tasks = ctx.onTasks;
    const started = { driver: no, model: ctx.member.model, permissionMode: ctx.member.permissionMode, account: ctx.member.config.account };
    own = { start: ctx.onOwnTurn, started };
    const d: AgentDriver = {
      provider: ctx.member.provider,
      runTurn: (input, sink) => {
        prompts.push(input.prompt);
        ran.push(started);
        if (opts.working) sink.taken?.();
        return new Promise<TurnResult>((res) => ends.push(res));
      },
      interrupt: async () => {
        if (knobs.stopMs) await Bun.sleep(knobs.stopMs);
        ends.at(-1)?.({ ok: false, error: "stopped" });
      },
      dispose: async () => void drivers.ended++,
      owedTurn: () => knobs.owed,
      takeUnread: () => (knobs.dropsHanded ? handed.splice(0) : []),
      carryNote: (take) => {
        const note = knobs.carry;
        if (take) knobs.carry = null;
        return note;
      },
    };
    if (steer !== undefined) {
      d.steer = async (text, ids) => {
        if (knobs.steerMs) await Bun.sleep(knobs.steerMs);
        if (!knobs.takes) return false;
        steered.push(text);
        handed.push(...(ids ?? []));
        return true;
      };
    }
    return d;
  };
  deps.agentEnv = () => ({});
  deps.resolveBin = () => "";
  deps.endpointFor = () => null;
  deps.turnNotice = () => null;
  app.storage.check = async () => {};
  const room: Room = app.chats.create({ provider: opts.provider ?? "claude", cwd: dir, model: "claude-opus-5" });
  const member: Member = app.store.listMembers(room.id)[0];
  app.updateMember(member.id, { permissionMode: "full" });
  const routes = buildRoutes(app);
  /** The app's tap: POST /api/rooms/:id/<what>. */
  const post = (what: string, body: Record<string, unknown>) => {
    const path = `/api/rooms/${room.id}/${what}`;
    const r = routes.find((x) => x.method === "POST" && x.pattern.test(path))!;
    return r.handler({ req: new Request("http://hub"), url: new URL(`http://hub${path}`), params: { id: room.id }, device: { id: "d", name: "Phone", platform: "", createdAt: 0, lastSeenAt: null }, body: async () => body });
  };
  /** An older app's Send now, or its Answer now (`currentSettings`, which means nothing any more), with the line's agent. */
  const sendNow = (body: Record<string, unknown> = {}) => post("send-now", { memberId: member.id, ...body }) as Promise<SendNowResult>;
  /** Try again (an older app's Answer now under a message sends `currentSettings` with it: the same thing now). */
  const retry = (body: Record<string, unknown> = {}) => post("retry", body);
  /** Stop, or Interrupt under a message that waits for the reply's end (`keepWaiting`: stop, and answer what waits). */
  const stop = (body: Record<string, unknown> = {}) => post("stop", body);
  const until = async (what: () => unknown, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(5)) if (what()) return;
    throw new Error("timed out waiting");
  };
  /** Ends the reply that's running now (the newest turn the agent started). */
  const end = async (r: TurnResult = { ok: true, text: "Done." }) => {
    const n = ends.length;
    ends[n - 1](r);
    await Bun.sleep(10);
  };
  const say = (text: string) => app.engine.postHumanMessage(room.id, text, "Phone");
  const now = () => app.store.getMember(member.id)!;
  const done = async () => {
    for (const e of ends) e({ ok: false, error: "stopped" });
    // The whole hub, so nothing of it (a usage-limit note settling) fires after its database has closed.
    await app.shutdown();
  };
  /** Claude Code carries on by itself as a helper reports back (onOwnTurn): a reply of its own, ended by the test like any other. */
  const ownReply = () =>
    own?.start?.(() => {
      ran.push(own!.started);
      return new Promise<TurnResult>((res) => ends.push(res));
    }, "Claude Code picked up where its helpers left off.") ?? false;
  const notes = () => app.store.listMessages(room.id).filter((m) => m.authorKind === "system").map((m) => m.text);
  return { app, deps, room, member, prompts, steered, drivers, knobs, ran, sendNow, retry, stop, until, end, say, now, done, notes, ownReply, tasks: (list: BackgroundTask[]) => tasks?.(list), turns: () => ends.length, queued: () => app.engine.queuedTurns(room.id).length };
}

// The app has no button for it any more (a message goes in by itself). An older app's tap still gets a true answer.
describe("Send now says why it didn't send", () => {
  test("into the running reply: it went in by itself, so a tap finds it being answered, and nothing else is said", async () => {
    const t = chat(true);
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      const yours = t.say("also add tests");
      // No helpers, no tap: it's in the reply already, and the turn that waited for it is gone.
      expect(t.steered).toEqual(["also add tests"]);
      await t.until(() => t.queued() === 0);
      expect(t.app.store.getLastSeen(t.member.id).seq).toBeGreaterThanOrEqual(yours.seq);
      expect(t.notes()).toEqual([]);
      // Tapped all the same (an older app, another device): the reply has it already.
      expect(await t.sendNow()).toEqual({ sent: false, why: "answering" });
      expect(t.steered).toEqual(["also add tests"]);
      await t.end();
      expect(t.turns()).toBe(1); // no second reply for it
    } finally {
      await t.done();
    }
  });

  test("a tap that gets there first (the reply was still starting): sent, once, and the hub's own next look hands nothing twice", async () => {
    const t = chat(false);
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.say("also add tests");
      await Bun.sleep(20);
      // It couldn't take it yet: the hub asks again in a moment. The tap comes before that.
      expect(t.steered).toEqual([]);
      expect(t.queued()).toBe(1);
      t.knobs.takes = true;
      expect(await t.sendNow()).toEqual({ sent: true });
      expect(t.steered).toEqual(["also add tests"]);
      expect(t.queued()).toBe(0);
      await Bun.sleep(700); // past the hub's own next look (FLOW_RETRY_MS)
      expect(t.steered).toEqual(["also add tests"]);
      await t.end();
      expect(t.turns()).toBe(1);
    } finally {
      await t.done();
    }
  });

  test("the reply ran into a usage limit: limit, with the reset, and the reply that carries on reads the message first", async () => {
    const t = chat(true);
    try {
      t.say("research what happened");
      await t.until(() => t.turns() === 1);
      const yours = t.say("and send the link");
      await t.until(() => t.queued() === 0);
      expect(t.steered).toEqual(["and send the link"]);
      const resetsAt = Date.now() + 33 * 60_000;
      await t.end({ ok: false, error: "You've hit your 5-hour limit", limit: { kind: "usage", label: "5-hour", resetsAt, source: "event" } });
      expect(t.now().status).toBe("waiting");
      const r = await t.sendNow();
      expect(r).toMatchObject({ sent: false, why: "limit", wait: { kind: "usage", resetsAt, provider: "claude" } });
      // The words the app shows for it, in the device's own clock.
      expect(limitQueuedWords(r.wait!, Date.now())).toBe(`Paused until your usage limit resets at ${limitResetTime(resetsAt, Date.now())}. Your message goes first when it does.`);
      // It went into the reply the limit stopped: it's the person's again, unread.
      expect(t.app.store.getLastSeen(t.member.id).seq).toBeLessThan(yours.seq);
      // When it carries on (Try now here, the reset itself otherwise), that reply reads it.
      t.app.engine.tryNow(t.room.id);
      await t.until(() => t.turns() === 2);
      expect(t.prompts[1]).toContain("and send the link");
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("the agent's turn for it has started: answering", async () => {
    // The reply was ending and took nothing, so the message got a turn of its own.
    const t = chat(false, { working: true });
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.say("also add tests");
      await Bun.sleep(20);
      expect(t.queued()).toBe(1);
      await t.end();
      await t.until(() => t.turns() === 2);
      expect(t.prompts[1]).toContain("also add tests");
      expect(await t.sendNow()).toEqual({ sent: false, why: "answering" });
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("nothing of yours is waiting: nothing", async () => {
    const t = chat(true);
    try {
      expect(await t.sendNow()).toEqual({ sent: false, why: "nothing" });
    } finally {
      await t.done();
    }
  });

  test("the reply was ending and took nothing: ended, and the next reply answers it", async () => {
    const t = chat(false, { working: true });
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.say("also add tests");
      expect(await t.sendNow()).toEqual({ sent: false, why: "ended" });
      await t.end();
      await t.until(() => t.turns() === 2);
      expect(t.prompts[1]).toContain("also add tests");
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("the reply is still starting (Claude Code takes nothing before its init names the chat's model): not yet, and the message still goes next", async () => {
    const t = chat(false);
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.say("also add tests");
      expect(await t.sendNow()).toEqual({ sent: false, why: "notYet" });
      expect(t.steered).toEqual([]);
      await t.end();
      await t.until(() => t.turns() === 2);
      expect(t.prompts[1]).toContain("also add tests");
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("an agent that can't take a message mid-reply: unsupported", async () => {
    const t = chat();
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.say("also add tests");
      expect(await t.sendNow()).toEqual({ sent: false, why: "unsupported" });
      await t.end();
      await t.until(() => t.turns() === 2);
      await t.end();
    } finally {
      await t.done();
    }
  });
});

describe("new settings waiting for the agent's helpers", () => {
  // These used to hold the message until the helpers finished, with Answer now as the way around it. A new model or the
  // like holds nothing: the message goes, no button, and the words below are what's said instead. An account switch,
  // tighter permissions or a new folder still hold it (further down), and nothing an older app taps sends it sooner.
  test("the message starts at once on the agent as it is, says so once, and the settings still apply after the helpers", async () => {
    const t = chat(true);
    try {
      // A reply starts a long background workflow, and the chat is moved from Opus 5 to Opus 5.5 meanwhile.
      t.say("Install the browser and make it a setup step");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
      expect(t.now().held).toEqual({ change: "settings", helpers: true });
      await t.end({ ok: true, text: "Installed. A workflow is building the setup step." });
      // The reply ended, the workflow goes on, and the status says what the new model waits for.
      expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
      // Their question starts at once, on the process as it is (its helpers keep going): nothing to tap.
      t.say("Did this chat switch my model?");
      expect(t.turns()).toBe(2);
      expect(t.queued()).toBe(0);
      expect(t.prompts[1]).toContain("Did this chat switch my model?");
      expect(t.drivers).toEqual({ made: 1, ended: 0 });
      expect(t.ran[1]).toMatchObject({ driver: 1, model: "claude-opus-5" });
      // An older app still taps Answer now: the message is being answered already, and nothing more happens.
      expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "answering" });
      expect(t.turns()).toBe(2);
      await t.end();
      // Still waiting for the helpers, and the next message goes the same way.
      expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
      t.say("Send the link too");
      expect(t.turns()).toBe(3);
      expect(t.ran[2]).toMatchObject({ driver: 1, model: "claude-opus-5" });
      await t.end();
      // The change's own note said when it applies: no other note, however many messages went.
      expect(t.notes().filter((n) => n.includes("helpers finish"))).toEqual(["Model changed from Opus 5 to Opus 5.5. Claude Code answers on Opus 5 until this reply and its helpers finish."]);
      // The workflow finishes, with no reply running: the process is replaced there and then, and the next reply is new.
      expect(t.drivers).toEqual({ made: 1, ended: 0 });
      t.tasks([helper("completed")]);
      await t.until(() => t.drivers.ended === 1);
      expect(t.now().held).toBeUndefined();
      expect(t.notes().at(-1)).toBe("Now on Opus 5.5: the next reply uses it.");
      t.say("And now?");
      await t.until(() => t.turns() === 4);
      expect(t.ran[3]).toMatchObject({ driver: 2, model: "claude-opus-5-5" });
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("Claude Code's own reply as its helpers report back runs on the old process; a message goes into it by itself, with nothing more said", async () => {
    const t = chat(true);
    try {
      t.say("Install the browser");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
      await t.end();
      // A helper reports back and Claude Code carries on by itself, on the Opus 5 process.
      expect(t.ownReply()).toBe(true);
      await t.until(() => t.turns() === 2);
      expect(t.ran[1]).toMatchObject({ driver: 1, model: "claude-opus-5" });
      const said = t.notes().at(-1);
      expect(said).toBe("Claude Code picked up where its helpers left off, with the settings it started with: your new settings apply once this reply and its helpers finish.");
      t.say("Did this chat switch my model?");
      await t.until(() => t.steered.length === 1);
      expect(t.steered).toEqual(["Did this chat switch my model?"]);
      expect(t.queued()).toBe(0);
      expect(t.notes().at(-1)).toBe(said!);
      expect(t.now().held).toEqual({ change: "settings", helpers: true });
      await t.end();
      // Its reply ended: back to waiting for the helpers.
      expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  test("an account switch waiting for the helpers: the message waits for them, it says which change waits, and it runs on the new account once they finish", async () => {
    const t = chat(true);
    try {
      const work = t.app.providers.setEndpointAccount("claude", { label: "Work server", baseUrl: "http://127.0.0.1:9", models: ["work-model"] });
      t.say("Install the browser");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      await t.end();
      t.app.updateMember(t.member.id, { config: { ...t.now().config, account: work.id }, model: "work-model" });
      expect(t.notes().some((n) => n.startsWith("@claude now uses the Work server account"))).toBe(true);
      expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your account switch applies", held: { change: "account", helpers: true } });
      t.say("Did this chat switch my model?");
      await Bun.sleep(20);
      expect(t.turns()).toBe(1);
      // An older app's Answer now would run the old account's process on it (and drop what that reply saves): refused, saying why.
      expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change: "account", helpers: true } });
      await Bun.sleep(20);
      expect(t.turns()).toBe(1);
      expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
      // The helpers finish: the message runs on a new process, on the Work server.
      t.tasks([helper("completed")]);
      await t.until(() => t.turns() === 2);
      expect(t.ran[1]).toMatchObject({ driver: 2, account: work.id });
      expect(t.prompts[1]).toContain("Did this chat switch my model?");
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("tighter permissions waiting for the helpers: the message waits for them, and nothing goes into the agent's own reply on Full access", async () => {
    const t = chat(true);
    try {
      t.say("Install the browser");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      await t.end();
      t.app.updateMember(t.member.id, { permissionMode: "ask" });
      expect(t.now()).toMatchObject({ statusDetail: "Finishing helpers before your permission change applies", held: { change: "permissions", helpers: true } });
      t.say("Delete the old build folder");
      expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change: "permissions", helpers: true } });
      // A reply of Claude Code's own would run on the Full access process: it's stopped as it starts, before it does
      // anything, and nothing is handed to it. (It used to run there whole, with no approval asked.)
      expect(t.ownReply()).toBe("stop");
      await Bun.sleep(20);
      expect(t.turns()).toBe(1);
      expect(await t.sendNow()).toEqual({ sent: false, why: "helpers", held: { change: "permissions", helpers: true } });
      expect(t.steered).toEqual([]);
      // Back to Full access: the process still holds what it was always allowed before, which the change took back, so
      // it still waits.
      t.app.updateMember(t.member.id, { permissionMode: "full" });
      expect(t.now().held).toEqual({ change: "permissions", helpers: true });
      t.app.updateMember(t.member.id, { permissionMode: "ask" });
      // The helpers finish: a new process, under Ask, carries on from what the stopped reply had taken up, and answers
      // the message, in one reply.
      t.tasks([helper("completed")]);
      await t.until(() => t.turns() === 2);
      expect(t.ran[1]).toMatchObject({ driver: 2, permissionMode: "ask" });
      expect(t.prompts.at(-1)).toContain("You had started on something by yourself (above)");
      expect(t.prompts.at(-1)).toContain("Delete the old build folder");
      expect(t.notes().at(-1)).toBe("Claude Code had started on something by itself. Your permission change applies first: Claude Code starts again under your new permissions and carries on with it.");
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("looser permissions waiting for the helpers: the process as it is may answer (it only asks more), and the chat says so", async () => {
    const t = chat(true);
    try {
      t.app.updateMember(t.member.id, { permissionMode: "ask" });
      t.say("Install the browser");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      await t.end();
      t.app.updateMember(t.member.id, { permissionMode: "full" });
      expect(t.now().held).toEqual({ change: "settings", helpers: true });
      t.say("Carry on");
      expect(t.turns()).toBe(2);
      expect(t.ran[1]).toMatchObject({ driver: 1, permissionMode: "ask" });
      expect(t.notes().at(-1)).toBe(AROUND);
      await t.end();
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });
});

describe("messages go to a working agent by themselves", () => {
  /** A chat whose agent has a helper at work and no reply running. `steer`: as for chat. */
  async function helperAtWork(steer?: boolean, opts: Parameters<typeof chat>[1] = {}) {
    const t = chat(steer, opts);
    t.say("Install the browser");
    await t.until(() => t.turns() === 1);
    t.tasks([helper("running")]);
    await t.end();
    return t;
  }
  const effort = (t: ReturnType<typeof chat>, to: string) => t.app.updateMember(t.member.id, { config: { ...t.now().config, effort: to } });
  const arounds = (t: ReturnType<typeof chat>) => t.notes().filter((n) => n === AROUND).length;
  /** What the process as it is may not answer around: a message for it waits until a new one runs. */
  const HOLDS: [string, "account" | "permissions" | "other", string, (t: ReturnType<typeof chat>) => void][] = [
    [
      "an account switch",
      "account",
      "your account switch applies",
      (t) => {
        const work = t.app.providers.setEndpointAccount("claude", { label: "Work server", baseUrl: "http://127.0.0.1:9", models: ["work-model"] });
        t.app.updateMember(t.member.id, { config: { ...t.now().config, account: work.id }, model: "work-model" });
      },
    ],
    ["tighter permissions", "permissions", "your permission change applies", (t) => t.app.updateMember(t.member.id, { permissionMode: "ask" })],
    [
      "a new folder",
      "other",
      "your changes apply",
      (t) => {
        const moved = mkdtempSync(join(tmpdir(), "ct-send-now-moved-"));
        dirs.push(moved);
        t.app.updateRoom(t.room.id, { cwd: moved });
      },
    ],
  ];

  describe("helpers at work and no reply running, and at most what the process may answer around waits", () => {
    test("no settings waiting: a message starts its turn while helpers work, as it always did", async () => {
      const t = await helperAtWork(true);
      try {
        t.say("What's next?");
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(0);
        expect(t.now().held).toBeUndefined();
        expect(t.notes()).toEqual([]);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    const CHANGES: [string, (t: ReturnType<typeof chat>) => void][] = [
      ["a new model", (t) => t.app.updateMember(t.member.id, { model: "claude-opus-5-5" })],
      ["a new effort", (t) => effort(t, "high")],
      ["fast mode", (t) => t.app.updateMember(t.member.id, { config: { ...t.now().config, fast: true } })],
      ["looser permissions", (t) => t.app.updateMember(t.member.id, { permissionMode: "full" })],
    ];
    for (const [what, change] of CHANGES) {
      test(`${what}: the message starts a turn at once, on the process as it is, with no way for it to wait`, async () => {
        const t = chat(true);
        try {
          t.app.updateMember(t.member.id, { permissionMode: "ask" });
          t.say("Install the browser");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          await t.end();
          change(t);
          expect(t.now().held).toEqual({ change: "settings", helpers: true });
          t.say("Carry on");
          // At once: it never sat in the queue.
          expect(t.turns()).toBe(2);
          expect(t.queued()).toBe(0);
          expect(t.prompts[1]).toContain("Carry on");
          expect(t.ran[1]).toMatchObject({ driver: 1, model: "claude-opus-5", permissionMode: "ask" });
          expect(t.drivers).toEqual({ made: 1, ended: 0 });
          await t.end();
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      });
    }

    test("one note per hold, not one per message, whichever way the messages go; a new hold says it again", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        // Nothing's been answered around yet: nothing to say.
        expect(arounds(t)).toBe(0);
        t.say("one");
        expect(t.turns()).toBe(2);
        expect(arounds(t)).toBe(1);
        // Said before the reply it's about: under the message, above the answer.
        expect(t.app.store.listMessages(t.room.id).slice(-3).map((m) => [m.authorKind, m.text])).toEqual([["human", "one"], ["system", AROUND], ["agent", ""]]);
        // Into the reply: no second note.
        t.say("two");
        await t.until(() => t.steered.length === 1);
        expect(arounds(t)).toBe(1);
        await t.end();
        // A turn of its own: no second note.
        t.say("three");
        expect(t.turns()).toBe(3);
        expect(arounds(t)).toBe(1);
        await t.end();
        // Another change in the same hold: nor then.
        t.app.updateMember(t.member.id, { config: { ...t.now().config, fast: true } });
        t.say("four");
        expect(t.turns()).toBe(4);
        expect(arounds(t)).toBe(1);
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        await t.end();
        // The hold ends with its helpers.
        t.tasks([helper("completed")]);
        await t.until(() => t.drivers.ended === 1);
        // A new process, new helpers, a new change: a new hold says it once more.
        t.say("five");
        await t.until(() => t.turns() === 5);
        t.tasks([{ ...helper("running"), id: "workflow-2" }]);
        await t.end();
        effort(t, "low");
        t.say("six");
        expect(t.turns()).toBe(6);
        expect(arounds(t)).toBe(2);
        await t.end();
      } finally {
        t.tasks([{ ...helper("completed"), id: "workflow-2" }]);
        await t.done();
      }
    });

    test("a model change whose own note said it applies when the helpers finish adds no other", async () => {
      const t = await helperAtWork();
      try {
        t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
        expect(t.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5. Claude Code answers on Opus 5 until its helpers finish.");
        t.say("one");
        expect(t.turns()).toBe(2);
        expect(t.notes().at(-1)).toBe("Model changed from Opus 5 to Opus 5.5. Claude Code answers on Opus 5 until its helpers finish.");
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("said again on a reply after a long hold, and sooner once a newer helper has put it off: a chat is never left on old settings with nothing said", async () => {
      // A chat could run for hours on an old model with nothing saying so. A dev server left running can do that here.
      const t = chat(true);
      const again = "Claude Code still answers with the settings it started with. Your new settings apply when its helpers finish.";
      const said = () => t.notes().filter((n) => n === AROUND || n === again);
      let clock = Date.now();
      t.deps.now = () => clock;
      const dev = (): BackgroundTask => ({ ...helper("running"), id: "bash-dev", kind: "local_bash", description: "npm run dev", workflow: null, background: true, startedAt: clock });
      try {
        t.say("Start the dev server");
        await t.until(() => t.turns() === 1);
        t.tasks([dev()]);
        await t.end();
        effort(t, "high");
        t.say("one");
        expect(said()).toEqual([AROUND]);
        await t.end();
        // Well within the hour: nothing more, however many messages go.
        clock += 59 * 60_000;
        t.say("two");
        expect(said()).toEqual([AROUND]);
        await t.end();
        clock += 2 * 60_000;
        t.say("three");
        expect(said()).toEqual([AROUND, again]);
        // Under the message and above the reply it's about, and only once for that reply and what goes into it.
        expect(t.app.store.listMessages(t.room.id).slice(-3).map((m) => [m.authorKind, m.text])).toEqual([["human", "three"], ["system", again], ["agent", ""]]);
        t.say("four");
        await t.until(() => t.steered.length === 1);
        expect(said()).toEqual([AROUND, again]);
        await t.end();
        // A newer helper puts the moment off again: said sooner, but not with every reply that starts one.
        clock += 5 * 60_000;
        t.tasks([dev(), { ...helper("running"), id: "workflow-2", startedAt: clock }]);
        t.say("five");
        expect(said()).toEqual([AROUND, again]);
        await t.end();
        clock += 6 * 60_000;
        t.say("six");
        expect(said()).toEqual([AROUND, again, again]);
        await t.end();
        // The helpers are never ended for it.
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
      } finally {
        t.tasks([{ ...dev(), status: "completed" }]);
        await t.done();
      }
    });

    test("a reply that fails under a hold: the status still says what waits, nothing runs or waits in the way, and Try again goes at once", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        t.say("one");
        expect(t.turns()).toBe(2);
        await t.end({ ok: false, error: "The API said no." });
        // What the app takes for "only waiting for its helpers" (sendNow.ts onlyFinishingHelpers), with nothing else going on.
        expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
        expect(t.app.engine.runningTurns(t.room.id)).toEqual([]);
        expect(t.queued()).toBe(0);
        t.app.engine.retry(t.room.id);
        expect(t.turns()).toBe(3);
        expect(t.ran[2].driver).toBe(1);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Stop everything under a hold: the message stays unanswered, and Try again goes at once on the process as it is", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.knobs.takes = false;
        t.say("also add tests");
        await t.app.engine.stop(t.room.id);
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
        t.app.engine.retry(t.room.id);
        expect(t.turns()).toBe(2);
        expect(t.prompts[1]).toContain("also add tests");
        expect(t.ran[1].driver).toBe(1);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("the same for Codex, with its own name", async () => {
      const t = await helperAtWork(true, { provider: "codex" });
      try {
        effort(t, "high");
        t.say("one");
        expect(t.turns()).toBe(2);
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().at(-1)).toBe("Your new settings apply when Codex's helpers finish. Until then it answers with the settings it started with.");
        t.say("two");
        await t.until(() => t.steered.length === 1);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("a reply running as well", () => {
    test("the message goes into it as Send now would, with no tap, and with nothing waiting there's nothing to say", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        const yours = t.say("also add tests");
        expect(t.steered).toEqual(["also add tests"]);
        await t.until(() => t.queued() === 0);
        // Read now, and the app shows it as handed over.
        expect(t.app.store.getLastSeen(t.member.id).seq).toBeGreaterThanOrEqual(yours.seq);
        const turn = t.app.store.listTurns(t.room.id).find((x) => x.status === "running")!;
        expect(t.app.engine.liveTurn(turn).unread).toEqual([yours.id]);
        expect(t.notes()).toEqual([]);
        // A tap from an older app has nothing left to do.
        expect(await t.sendNow()).toEqual({ sent: false, why: "answering" });
        await t.end();
        expect(t.turns()).toBe(1); // no second reply for it
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("new settings waiting: it goes in all the same, on the settings it started with, said once", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        t.say("and the docs");
        await t.until(() => t.queued() === 0);
        expect(t.steered.join("\n\n")).toBe("also add tests\n\nand the docs");
        expect(arounds(t)).toBe(1);
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("three quick messages, on an agent whose hand-over takes a moment: each goes in once, in order", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.knobs.steerMs = 30;
        t.say("one");
        t.say("two");
        t.say("three");
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["one", "two\n\nthree"]);
        await t.end();
        expect(t.turns()).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a reply still starting can't take it yet: it's asked again by itself, and the message goes in", async () => {
      const t = chat(false);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.say("also add tests");
        await Bun.sleep(30);
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        t.knobs.takes = true; // its init has named the chat's model, say
        await t.until(() => t.steered.length === 1);
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["also add tests"]);
        await t.end();
        expect(t.turns()).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a reply that was ending takes nothing: it goes by itself as the reply ends, and never waits for the helpers", async () => {
      const t = chat(false, { working: true });
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        await Bun.sleep(30);
        expect(t.steered).toEqual([]);
        await t.end();
        expect(t.turns()).toBe(2);
        expect(t.prompts[1]).toContain("also add tests");
        expect(t.ran[1].driver).toBe(1);
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("an agent with no mid-reply form queues quietly: it goes when the reply ends, never later, whatever waits for the helpers", async () => {
      const t = chat();
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.say("also add tests");
        expect(t.queued()).toBe(1);
        // A settings change while it waits doesn't hold it either.
        effort(t, "high");
        await t.end();
        expect(t.turns()).toBe(2);
        expect(t.prompts[1]).toContain("also add tests");
        expect(t.ran[1].driver).toBe(1);
        expect(arounds(t)).toBe(1);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a helper starts after a message of yours went in: it's in the reply already, and goes in once", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.say("also add tests");
        expect(t.steered).toEqual(["also add tests"]);
        await t.until(() => t.queued() === 0);
        t.tasks([helper("running")]);
        await Bun.sleep(20);
        expect(t.steered).toEqual(["also add tests"]);
        await t.end();
        expect(t.turns()).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a command goes as typed when the reply ends, and a summary being made takes nothing", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.say("/compact");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        await t.end();
        expect(t.prompts[1]).toBe("/compact");
        // While it summarises, a message waits for the reply after it.
        t.say("then carry on");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        await t.end();
        expect(t.prompts[2]).toContain("then carry on");
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a reply being stopped takes nothing: the message starts the next reply", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.knobs.stopMs = 50;
        const stopping = t.app.engine.stop(t.room.id);
        t.say("do this instead");
        await Bun.sleep(10);
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        await stopping;
        await t.until(() => t.turns() === 2);
        expect(t.prompts[1]).toContain("do this instead");
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("another chat's agent's message doesn't go in by itself: it starts its own turn when the reply ends", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.app.engine.postRelayMessage(t.room.id, "Is the release tagged?", { hubId: "h", machine: "Mac mini", chatId: "c2", chatName: "Other", agent: "Codex", hop: 1, kind: "message" }, "Codex");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        await t.end();
        expect(t.turns()).toBe(2);
        expect(t.prompts[1]).toContain("Is the release tagged?");
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a reply to another chat's agent takes nothing: your message goes as a turn, or it would be sent back with that reply", async () => {
      const t = chat(true);
      try {
        t.app.engine.postRelayMessage(t.room.id, "Is the release tagged?", { hubId: "h", machine: "Mac mini", chatId: "c2", chatName: "Other", agent: "Codex", hop: 1, kind: "message" }, "Codex");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.say("Private: what do you think of my co-founder's PR?");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        await t.end();
        expect(t.turns()).toBe(2);
        expect(t.prompts[1]).toContain("Private");
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("an account past its spending limit: nothing goes in, and the message gets the usual refusal as the reply ends", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        const refusal = "Work key reached its $5.00 limit, so this reply didn't start.";
        t.deps.checkBudget = () => refusal;
        const yours = t.say("also add tests");
        await Bun.sleep(20);
        // Going in would only have spent more, with nothing said.
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        await t.end();
        expect(t.turns()).toBe(1);
        expect(t.app.store.listMessages(t.room.id).filter((m) => m.authorKind === "agent").at(-1)).toMatchObject({ text: refusal, status: "error" });
        expect(t.now()).toMatchObject({ status: "error", statusDetail: refusal });
        // It's still the person's, unread.
        expect(t.app.store.getLastSeen(t.member.id).seq).toBeLessThan(yours.seq);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("Stop after a message went in by itself", () => {
    /** A reply and a helper at work, and a message that went in by itself and hasn't been read. `hold`: new settings wait too. */
    async function wentIn(hold = false) {
      const t = chat(true);
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      if (hold) effort(t, "high");
      const yours = t.say("ALSO delete the old build folder");
      await t.until(() => t.queued() === 0);
      expect(t.steered).toEqual(["ALSO delete the old build folder"]);
      t.knobs.dropsHanded = true;
      return { t, yours };
    }
    const unread = (t: ReturnType<typeof chat>, seq: number) => t.app.store.getLastSeen(t.member.id).seq < seq;

    for (const hold of [false, true]) {
      test(`Stop everything${hold ? ", with new settings waiting for the helpers" : ""}: it's unread again and starts nothing, and Try again delivers it once, at once`, async () => {
        const { t, yours } = await wentIn(hold);
        try {
          await t.app.engine.stop(t.room.id);
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(unread(t, yours.seq)).toBe(true);
          expect(t.queued()).toBe(0);
          // Only its helpers keep the status "working" then: what the app takes for that (sendNow.ts onlyFinishingHelpers).
          if (hold) expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
          // Try again under the message (an older app's Answer now sends currentSettings with it: the same thing).
          await t.retry(hold ? { currentSettings: true } : {});
          expect(t.turns()).toBe(2);
          expect(t.queued()).toBe(0);
          expect(t.prompts[1]).toContain("ALSO delete the old build folder");
          expect(t.ran[1].driver).toBe(1);
          // Said once for the hold, when it went in: nothing more for answering it again.
          expect(arounds(t)).toBe(hold ? 1 : 0);
          expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
          await t.end();
          expect(t.turns()).toBe(2);
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      });

      test(`Stop and answer my message${hold ? ", with new settings waiting for the helpers" : ""}: it's answered next on the process as it is, once, with no tap`, async () => {
        const { t, yours } = await wentIn(hold);
        try {
          await t.app.engine.stop(t.room.id, undefined, { keepWaiting: true });
          await t.until(() => t.turns() === 2);
          expect(t.prompts[1]).toContain("ALSO delete the old build folder");
          expect(t.ran[1].driver).toBe(1);
          expect(t.queued()).toBe(0);
          expect(unread(t, yours.seq)).toBe(false);
          expect(arounds(t)).toBe(hold ? 1 : 0);
          expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
          await t.end();
          expect(t.turns()).toBe(2);
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      });

      test(`Interrupt under a message still waiting behind a reply that can't take it${hold ? ", with new settings waiting for the helpers" : ""}: the reply stops, and it's answered next, once`, async () => {
        const t = chat();
        try {
          t.say("build it");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          if (hold) effort(t, "high");
          const yours = t.say("also add tests");
          expect(t.queued()).toBe(1);
          // The app's Interrupt: stop, and answer what waits.
          await t.stop({ keepWaiting: true });
          await t.until(() => t.turns() === 2);
          expect(t.prompts[1]).toContain("also add tests");
          expect(t.ran[1].driver).toBe(1);
          expect(t.queued()).toBe(0);
          expect(unread(t, yours.seq)).toBe(false);
          expect(arounds(t)).toBe(hold ? 1 : 0);
          await t.end();
          await Bun.sleep(20);
          expect(t.turns()).toBe(2);
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      });
    }

    test("Stop and answer with nothing waiting and nothing running: there's nothing to stop, and nothing changes", async () => {
      const t = await helperAtWork(true);
      try {
        await t.stop({ keepWaiting: true });
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(0);
        expect(t.now().status).toBe("idle");
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a driver that only finds out late: a message the reply already split below is given back all the same", async () => {
      const { t, yours } = await wentIn();
      try {
        // As Claude Code's receipt can say of a message counted as read: it went in just after the request that came back.
        const running = (t.app.engine as unknown as { running: Map<string, { steered?: unknown[] }> }).running;
        for (const r of running.values()) r.steered = undefined;
        await t.app.engine.stop(t.room.id);
        expect(unread(t, yours.seq)).toBe(true);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("what must still hold", () => {
    for (const [what, change, words, apply] of HOLDS) {
      test(`${what}: never into the reply, never around it, nothing an older app taps sends it, and it goes on a new process once the helpers finish`, async () => {
        const t = chat(true);
        try {
          t.say("Install the browser");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          apply(t);
          expect(t.now().held).toEqual({ change, helpers: true });
          t.say("Delete the old build folder");
          await Bun.sleep(20);
          // The reply as it runs never takes it...
          expect(t.steered).toEqual([]);
          expect(t.queued()).toBe(1);
          expect(await t.sendNow()).toEqual({ sent: false, why: "settings", held: { change, helpers: true } });
          await t.end();
          await Bun.sleep(20);
          // ...and no new turn starts on the old process once it ends.
          expect(t.turns()).toBe(1);
          expect(t.now()).toMatchObject({ status: "working", statusDetail: `Finishing helpers before ${words}`, held: { change, helpers: true } });
          expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change, helpers: true } });
          expect(await t.sendNow()).toEqual({ sent: false, why: "helpers", held: { change, helpers: true } });
          expect(t.turns()).toBe(1);
          expect(t.notes().some((n) => n === AROUND || n.startsWith("Answering now"))).toBe(false);
          t.tasks([helper("completed")]);
          await t.until(() => t.turns() === 2);
          expect(t.ran[1].driver).toBe(2);
          expect(t.prompts[1]).toContain("Delete the old build folder");
          await t.end();
        } finally {
          await t.done();
        }
      });

      test(`${what}: Stop and answer with no reply running: still held, and nothing claims it's being answered`, async () => {
        const t = await helperAtWork(true);
        try {
          apply(t);
          t.say("Delete the old build folder");
          await Bun.sleep(20);
          await t.stop({ keepWaiting: true });
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(t.queued()).toBe(1);
          expect(t.notes().some((n) => n === AROUND || n.startsWith("Answering now"))).toBe(false);
          expect(t.now()).toMatchObject({ status: "working", statusDetail: `Finishing helpers before ${words}`, held: { change, helpers: true } });
          t.tasks([helper("completed")]);
          await t.until(() => t.turns() === 2);
          expect(t.ran[1].driver).toBe(2);
          expect(t.prompts[1]).toContain("Delete the old build folder");
          await t.end();
        } finally {
          await t.done();
        }
      });

      test(`${what}: Stop everything with no reply running, then another message: it waits for the helpers, saying so, whatever is tapped`, async () => {
        const t = await helperAtWork(true);
        try {
          apply(t);
          t.say("Delete the old build folder");
          await Bun.sleep(20);
          await t.stop();
          await Bun.sleep(20);
          expect(t.queued()).toBe(0);
          t.say("Delete the new one too");
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(t.queued()).toBe(1);
          // And it says what it waits for, as a message sent under the hold does.
          expect(t.now()).toMatchObject({ status: "working", held: { change, helpers: true } });
          expect(t.now().statusDetail).toStartWith("Finishing helpers before ");
          expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change, helpers: true } });
          expect(t.turns()).toBe(1);
          t.tasks([helper("completed")]);
          await t.until(() => t.turns() === 2);
          expect(t.ran[1].driver).toBe(2);
          await t.end();
        } finally {
          await t.done();
        }
      });

      test(`${what}: Stop everything, then Try again under the message: still held, saying why, and nothing claims it's being answered`, async () => {
        const t = chat(true);
        try {
          t.say("build it");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          apply(t);
          expect(t.now().held).toEqual({ change, helpers: true });
          t.say("also add tests");
          await t.app.engine.stop(t.room.id);
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(t.queued()).toBe(0);
          // (An older app's Answer now sends currentSettings with it: nothing goes by that.)
          await t.retry({ currentSettings: true });
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(t.queued()).toBe(1);
          expect(t.notes().some((n) => n === AROUND || n.startsWith("Answering now"))).toBe(false);
          expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change, helpers: true } });
          t.tasks([helper("completed")]);
          await t.until(() => t.turns() === 2);
          expect(t.ran[1].driver).toBe(2);
          expect(t.prompts[1]).toContain("also add tests");
          await t.end();
        } finally {
          await t.done();
        }
      });
    }

    test("Try again on a failed reply under such a hold waits for the helpers too, and the app hears the message is unread again", async () => {
      // It had taken the message in: only Try again makes it unread again, with no other reason for a device to hear of it.
      const t = await helperAtWork(true, { working: true });
      try {
        t.say("one");
        expect(t.turns()).toBe(2);
        t.app.updateMember(t.member.id, { permissionMode: "ask" });
        await t.end({ ok: false, error: "The API said no." });
        expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your permission change applies", held: { change: "permissions", helpers: true } });
        const told: number[] = [];
        const off = t.app.bus.on((e: ServerEvent) => {
          if (e.t === "member" && e.member.id === t.member.id && e.member.readSeq !== undefined) told.push(e.member.readSeq);
        });
        await t.retry();
        off();
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(1);
        const one = t.app.store.listMessages(t.room.id).findLast((m) => m.text === "one")!;
        expect(told.at(-1)).toBe(t.app.store.messageSeq(one.id) - 1);
        // The helpers finish: tried again on a new process, under the new permissions.
        t.tasks([helper("completed")]);
        await t.until(() => t.turns() === 3);
        expect(t.ran[2]).toMatchObject({ driver: 2, permissionMode: "ask" });
        expect(t.prompts[2]).toContain("one");
        await t.end();
      } finally {
        await t.done();
      }
    });

    test("what a new process has to carry on from comes first: the message waits for it, and nothing an older app taps goes around it", async () => {
      const t = await helperAtWork(true);
      try {
        // Claude Code starts a reply of its own while a change it may not answer around waits: stopped, for a new process to carry on from.
        const was = t.now().config;
        t.app.updateMember(t.member.id, { config: { ...was, helperModel: "claude-haiku-4-5" } });
        expect(t.now().held).toEqual({ change: "other", helpers: true });
        expect(t.ownReply()).toBe("stop");
        // Taken back, with a new effort: only what it may answer around waits now, and that carry-on still comes first.
        t.app.updateMember(t.member.id, { config: { ...was, effort: "high" } });
        expect(t.now().held).toEqual({ change: "settings", helpers: true });
        t.say("Carry on");
        await Bun.sleep(20);
        expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change: "settings", helpers: true } });
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        expect(t.notes().some((n) => n === AROUND || n.startsWith("Answering now"))).toBe(false);
        // The helper finishes: a new process carries on, and reads the message.
        t.tasks([helper("completed")]);
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(2);
        expect(t.prompts[1]).toContain("Carry on");
        await t.end();
      } finally {
        await t.done();
      }
    });

    test("what it owes by itself comes next, with no helpers to wait for: the status doesn't say it's finishing any", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        effort(t, "high");
        t.knobs.owed = "message";
        await t.end();
        expect(t.now()).toMatchObject({ status: "idle", held: { change: "settings", helpers: false, owed: "message" } });
        t.say("and this");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        expect(t.now()).toMatchObject({ status: "queued", statusDetail: null });
        // Its own reply has been: the setting applies, and the message goes on the new process.
        t.knobs.owed = null;
        t.tasks([]);
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(2);
        await t.end();
      } finally {
        await t.done();
      }
    });

    test("a change taken back with nothing waiting leaves no \"Finishing helpers\" behind", async () => {
      const t = await helperAtWork(true);
      try {
        const was = t.now().config;
        effort(t, "high");
        await t.until(() => /^Finishing helpers/.test(t.now().statusDetail ?? ""));
        t.app.updateMember(t.member.id, { config: was });
        await t.until(() => !/^Finishing helpers/.test(t.now().statusDetail ?? ""));
        expect(t.now().status).toBe("idle");
        expect(t.now().held).toBeUndefined();
        t.tasks([helper("completed")]);
        await Bun.sleep(20);
        expect(t.now().status).toBe("idle");
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("what no longer waits lets the message go: a change taken back, with new settings left, is answered around at once", async () => {
      const t = await helperAtWork(true);
      try {
        // Anything else in its config it may not answer around (a helper model, here): held...
        t.app.updateMember(t.member.id, { config: { ...t.now().config, helperModel: "claude-sonnet-4-6" } });
        expect(t.now().held).toEqual({ change: "other", helpers: true });
        t.say("Carry on");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        // ...until it's taken back, leaving nothing it may not answer around.
        t.app.updateMember(t.member.id, { model: "claude-opus-5-5", config: { ...t.now().config, helperModel: null } });
        expect(t.now().held).toEqual({ change: "settings", helpers: true });
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(1);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a usage limit stops the reply: the same words, nothing can send it sooner, and the reply that carries on reads it", async () => {
      for (const steer of [true, undefined]) {
        const t = chat(steer);
        try {
          t.say("research what happened");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          effort(t, "high");
          const yours = t.say("and send the link");
          await Bun.sleep(20);
          const resetsAt = Date.now() + 33 * 60_000;
          await t.end({ ok: false, error: "You've hit your 5-hour limit", limit: { kind: "usage", label: "5-hour", resetsAt, source: "event" } });
          expect(t.now().status).toBe("waiting");
          expect(await t.sendNow()).toMatchObject({ sent: false, why: "limit", wait: { kind: "usage", resetsAt } });
          expect(await t.sendNow({ currentSettings: true })).toMatchObject({ sent: false, why: "limit", wait: { kind: "usage", resetsAt } });
          // It's still the person's, unread, handed to the reply or not.
          expect(t.app.store.getLastSeen(t.member.id).seq).toBeLessThan(yours.seq);
          t.app.engine.tryNow(t.room.id);
          await t.until(() => t.turns() === 2);
          expect(t.prompts[1]).toContain("and send the link");
          await t.end();
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      }
    });

    test("a reply the agent owes by itself comes first, as ever; once it runs, a message that waited for it goes in", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        // One helper reported back, another works on (the driver tells the hub through onTasks).
        t.knobs.owed = "report";
        t.tasks([helper("running"), { ...helper("completed"), id: "workflow-2" }]);
        t.say("What's next?");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        expect(t.now().held).toEqual({ change: "settings", helpers: true, owed: "report" });
        // Whatever an older app taps: nothing is promised around it.
        const owed: SendNowResult = { sent: false, why: "ownTurn", held: { change: "settings", helpers: true, owed: "report" } };
        expect(await t.sendNow()).toEqual(owed);
        expect(await t.sendNow({ currentSettings: true })).toEqual(owed);
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        t.knobs.owed = null;
        expect(t.ownReply()).toBe(true);
        await t.until(() => t.steered.length === 1);
        expect(t.steered).toEqual(["What's next?"]);
        await t.until(() => t.queued() === 0);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("new settings still apply: at the first moment no helper and no reply runs", () => {
    test("a stream of messages into the reply never holds them off, and never ends a helper", async () => {
      const t = await helperAtWork(true);
      try {
        t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
        // The person keeps writing while the helper works: one reply, on and on.
        t.say("one");
        expect(t.turns()).toBe(2);
        for (const m of ["two", "three", "four"]) {
          t.say(m);
          await t.until(() => t.queued() === 0);
        }
        expect(t.steered).toEqual(["two", "three", "four"]);
        // Nothing has ended the process the helper runs in.
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        // The helper finishes in the middle of it. A reply still runs: not yet.
        t.tasks([helper("completed")]);
        await Bun.sleep(20);
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        expect(t.now().held).toEqual({ change: "settings", helpers: false });
        // They keep writing: it still goes into the reply, which is said once now that only the reply is in the way.
        t.say("five");
        t.say("six");
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["two", "three", "four", "five", "six"]);
        expect(t.notes().filter((n) => n.startsWith("Answering now"))).toEqual(["Answering now with the settings Claude Code started with. Your changes apply from its next reply."]);
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        await t.end();
        // The reply's end is the moment: no helper and no reply runs, and the process is replaced there and then.
        await t.until(() => t.drivers.ended === 1);
        expect(t.turns()).toBe(2);
        expect(t.notes()).toContain("Now on Opus 5.5: the next reply uses it.");
        expect(t.now().held).toBeUndefined();
        t.say("seven");
        await t.until(() => t.turns() === 3);
        expect(t.drivers).toEqual({ made: 2, ended: 1 });
        expect(t.ran[2]).toMatchObject({ driver: 2, model: "claude-opus-5-5" });
        expect(t.prompts[2]).toContain("seven");
        await t.end();
      } finally {
        await t.done();
      }
    });

    test("a stream of messages that each start a turn doesn't either, on an agent with no mid-reply form", async () => {
      const t = await helperAtWork();
      try {
        t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
        t.say("one");
        expect(t.turns()).toBe(2);
        // A message behind each reply, each going as the last ends: there's always a reply or one about to start.
        for (let i = 2; i < 5; i++) {
          t.say(`next ${i}`);
          expect(t.queued()).toBe(1);
          await t.end();
          expect(t.turns()).toBe(i + 1);
          expect(t.ran[i]).toMatchObject({ driver: 1, model: "claude-opus-5" });
          expect(t.drivers).toEqual({ made: 1, ended: 0 });
        }
        // The helper finishes while the last reply runs, with another message behind it.
        t.say("last");
        t.tasks([helper("completed")]);
        await Bun.sleep(20);
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        await t.end();
        await t.until(() => t.turns() === 6);
        expect(t.ran[5]).toMatchObject({ driver: 2, model: "claude-opus-5-5" });
        expect(t.prompts[5]).toContain("last");
        expect(t.drivers).toEqual({ made: 2, ended: 1 });
        await t.end();
      } finally {
        await t.done();
      }
    });

    test("helpers finish between replies: replaced there and then, with nothing to wait for", async () => {
      const t = await helperAtWork();
      try {
        effort(t, "high");
        t.say("one");
        await t.end();
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        t.tasks([helper("completed")]);
        await t.until(() => t.drivers.ended === 1);
        expect(t.now().held).toBeUndefined();
        expect(t.now()).toMatchObject({ status: "idle", statusDetail: null });
      } finally {
        await t.done();
      }
    });
  });

  describe("no helpers at work: the same", () => {
    const TASKS: [string, BackgroundTask[]][] = [
      ["none has started", []],
      ["one has finished", [helper("completed")]],
      ["a command in the foreground (the reply's own step)", [{ ...helper("running"), id: "bash-1", kind: "local_bash", workflow: null, background: false }]],
      ["a command left running in the background", [{ ...helper("running"), id: "bash-1", kind: "local_bash", workflow: null, background: true }]],
    ];
    for (const [what, list] of TASKS) {
      test(`${what}: it goes into the reply by itself, once, and nothing waits behind it`, async () => {
        const t = chat(true);
        try {
          t.say("build it");
          await t.until(() => t.turns() === 1);
          t.tasks(list);
          const yours = t.say("also add tests");
          expect(t.steered).toEqual(["also add tests"]);
          await t.until(() => t.queued() === 0);
          // Read at its next step, and the app shows it as handed over (with Interrupt, to be read sooner).
          expect(t.app.store.getLastSeen(t.member.id).seq).toBeGreaterThanOrEqual(yours.seq);
          expect(t.app.engine.liveTurn(t.app.engine.runningTurns(t.room.id)[0]).unread).toEqual([yours.id]);
          expect(t.notes()).toEqual([]);
          // An older app's tap has nothing left to do.
          expect(await t.sendNow()).toEqual({ sent: false, why: "answering" });
          expect(t.steered).toEqual(["also add tests"]);
          await t.end();
          expect(t.turns()).toBe(1);
        } finally {
          t.tasks(list.map((x) => ({ ...x, status: "completed" })));
          await t.done();
        }
      });
    }

    test("three quick messages, on an agent whose hand-over takes a moment: each goes in once, in order", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.knobs.steerMs = 30;
        t.say("one");
        t.say("two");
        t.say("three");
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["one", "two\n\nthree"]);
        await t.end();
        expect(t.turns()).toBe(1);
      } finally {
        await t.done();
      }
    });

    test("new settings waiting for the reply alone: the message goes in all the same, said once for the reply, and the settings apply as it ends", async () => {
      const t = chat(true);
      const said = "Answering now with the settings Claude Code started with. Your changes apply from its next reply.";
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        effort(t, "high");
        expect(t.now().held).toEqual({ change: "settings", helpers: false });
        t.say("also add tests");
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["also add tests"]);
        expect(t.notes().at(-1)).toBe(said);
        // The next one too, with nothing more to say: the reply is the same one.
        t.say("and the docs");
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["also add tests", "and the docs"]);
        expect(t.notes().filter((n) => n === said)).toHaveLength(1);
        // An older app's Send now has nothing left to send.
        expect(await t.sendNow()).toEqual({ sent: false, why: "answering" });
        await t.end();
        // The reply's end is the moment the settings apply: the next reply runs on a new process.
        await t.until(() => t.drivers.ended === 1);
        expect(t.turns()).toBe(1);
        expect(t.now().held).toBeUndefined();
        t.say("and now?");
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(2);
        expect(t.prompts[1]).toContain("and now?");
        await t.end();
      } finally {
        await t.done();
      }
    });

    for (const [what, change, , apply] of HOLDS) {
      test(`${what} waiting for the reply alone: never into the reply, and it goes on a new process as the reply ends`, async () => {
        const t = chat(true);
        try {
          t.say("Install the browser");
          await t.until(() => t.turns() === 1);
          apply(t);
          expect(t.now().held).toEqual({ change, helpers: false });
          t.say("Delete the old build folder");
          await Bun.sleep(20);
          expect(t.steered).toEqual([]);
          expect(t.queued()).toBe(1);
          expect(await t.sendNow()).toEqual({ sent: false, why: "settings", held: { change, helpers: false } });
          expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "settings", held: { change, helpers: false } });
          expect(t.steered).toEqual([]);
          expect(t.notes().some((n) => n === AROUND || n.startsWith("Answering now"))).toBe(false);
          await t.end();
          await t.until(() => t.turns() === 2);
          expect(t.ran[1].driver).toBe(2);
          expect(t.prompts[1]).toContain("Delete the old build folder");
          expect(t.steered).toEqual([]);
          await t.end();
        } finally {
          await t.done();
        }
      });
    }
  });
});

describe("per agent, in a group chat", () => {
  /** Claude Code (the lead) and Codex in a group chat, each stand-in's turns ended by the test. */
  function group(more: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ct-send-now-group-"));
    dirs.push(dir);
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
    const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
    type Agent = { made: number; ended: number; ends: ((r: TurnResult) => void)[]; steered: string[]; prompts: string[]; ran: number[]; tasks?: DriverContext["onTasks"] };
    const agents: Record<string, Agent> = { claude: { made: 0, ended: 0, ends: [], steered: [], prompts: [], ran: [] }, codex: { made: 0, ended: 0, ends: [], steered: [], prompts: [], ran: [] } };
    deps.createDriver = (ctx) => {
      const a = agents[ctx.member.handle];
      const no = ++a.made;
      a.tasks = ctx.onTasks;
      return {
        provider: ctx.member.provider,
        runTurn: (input) => {
          a.prompts.push(input.prompt);
          a.ran.push(no);
          return new Promise<TurnResult>((res) => a.ends.push(res));
        },
        steer: async (text) => (a.steered.push(text), true),
        interrupt: async () => a.ends.at(-1)?.({ ok: false, error: "stopped" }),
        dispose: async () => void a.ended++,
      } satisfies AgentDriver;
    };
    deps.agentEnv = () => ({});
    deps.resolveBin = () => "";
    deps.endpointFor = () => null;
    deps.turnNotice = () => null;
    app.storage.check = async () => {};
    const room: Room = app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: dir, ...more });
    const member = (handle: string) => app.store.listMembers(room.id).find((m) => m.handle === handle)!;
    const until = async (what: () => unknown, ms = 5000) => {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(5)) if (what()) return;
      throw new Error("timed out waiting");
    };
    return {
      app,
      room,
      agents,
      member,
      until,
      say: (text: string) => app.engine.postHumanMessage(room.id, text, "Phone"),
      end: async (handle: string) => {
        agents[handle].ends.at(-1)!({ ok: true, text: `${handle} answered.` });
        await Bun.sleep(10);
      },
      notes: () => app.store.listMessages(room.id).filter((m) => m.authorKind === "system").map((m) => m.text),
      queued: () => app.engine.queuedTurns(room.id).map((t) => app.store.getMember(t.memberId)!.handle),
      done: async () => {
        for (const a of Object.values(agents)) for (const e of a.ends) e({ ok: false, error: "stopped" });
        await app.shutdown();
      },
    };
  }

  /** @claude has a helper at work and no reply running. */
  async function claudeHelper(g: ReturnType<typeof group>) {
    g.say("@claude Install the browser");
    await g.until(() => g.agents.claude.ends.length === 1);
    g.agents.claude.tasks?.([helper("running")]);
    await g.end("claude");
  }

  test("each agent's helpers and settings are its own: @claude's message goes around what waits for its helpers, with one note naming it, and @codex's goes into its own reply with nothing said", async () => {
    const g = group();
    try {
      await claudeHelper(g);
      g.app.updateMember(g.member("claude").id, { config: { ...g.member("claude").config, effort: "high" } });
      g.say("@claude and this");
      expect(g.agents.claude.ends).toHaveLength(2);
      expect(g.agents.claude.ran).toEqual([1, 1]);
      const note = "Your new settings apply when @claude's helpers finish. Until then it answers with the settings it started with.";
      expect(g.notes()).toEqual([note]);
      await g.end("claude");
      g.say("@claude and that");
      expect(g.agents.claude.ends).toHaveLength(3);
      await g.end("claude");
      expect(g.notes()).toEqual([note]);
      // @codex has no helpers and nothing waiting: its message goes into its reply by itself, with nothing to say about it.
      g.say("@codex look at the tests");
      expect(g.agents.codex.ends).toHaveLength(1);
      g.say("@codex and the fixtures");
      await g.until(() => g.agents.codex.steered.length === 1 && g.queued().length === 0);
      expect(g.agents.codex.steered).toEqual(["[Human · Phone]\n@codex and the fixtures"]);
      expect(g.agents.claude.steered).toEqual([]);
      // An older app's Send now on its line has nothing left to send.
      expect(await g.app.engine.sendNowWhy(g.room.id, g.member("codex").id)).toEqual({ sent: false, why: "answering" });
      expect(g.notes()).toEqual([note]);
      await g.end("codex");
      expect(g.agents.codex.ends).toHaveLength(1);
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("a change that holds one agent's message holds only that agent's: the next agent's goes", async () => {
    const g = group();
    try {
      await claudeHelper(g);
      const work = g.app.providers.setEndpointAccount("claude", { label: "Work server", baseUrl: "http://127.0.0.1:9", models: ["work-model"] });
      g.app.updateMember(g.member("claude").id, { config: { ...g.member("claude").config, account: work.id }, model: "work-model" });
      expect(g.member("claude").held).toEqual({ change: "account", helpers: true });
      g.say("@claude delete the old build");
      await Bun.sleep(20);
      expect(g.agents.claude.ends).toHaveLength(1);
      expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id)).toEqual({ sent: false, why: "helpers", held: { change: "account", helpers: true } });
      // @claude's turn is first in the queue, and may be there for hours: @codex's doesn't wait behind it.
      g.say("@codex look at the tests");
      expect(g.agents.codex.ends).toHaveLength(1);
      expect(g.queued()).toEqual(["claude"]);
      await g.end("codex");
      expect(g.agents.claude.ends).toHaveLength(1);
      // The helper finishes: @claude's message runs, on the new account.
      g.agents.claude.tasks?.([helper("completed")]);
      await g.until(() => g.agents.claude.ends.length === 2);
      expect(g.agents.claude.ran).toEqual([1, 2]);
      expect(g.agents.claude.prompts[1]).toContain("@claude delete the old build");
      await g.end("claude");
    } finally {
      await g.done();
    }
  });

  test("with parallel work, a turn refused as it starts is refused once, and never starts itself again", async () => {
    const g = group();
    try {
      g.app.updateRoom(g.room.id, { parallel: true });
      const refusal = "Work key reached its $5.00 limit, so this reply didn't start.";
      const deps = (g.app.engine as unknown as { deps: EngineDeps }).deps;
      deps.checkBudget = (_room, member) => (member.handle === "claude" ? refusal : null);
      const refused = () => g.app.store.listMessages(g.room.id).filter((m) => m.authorKind === "agent" && m.text === refusal);
      g.say("@claude start the API");
      await Bun.sleep(30);
      expect(refused()).toHaveLength(1);
      expect(g.queued()).toEqual([]);
      // The other agent isn't held up by it, and starts once.
      g.say("@codex start the tests");
      await g.until(() => g.agents.codex.ends.length === 1);
      await Bun.sleep(20);
      expect(g.agents.codex.ends.length).toBe(1);
      expect(refused()).toHaveLength(1);
      await g.end("codex");
      await g.until(() => g.queued().length === 0);
    } finally {
      await g.done();
    }
  });

  test("with parallel work, a message goes into the reply of the agent it's for, helpers or not, and only that one", async () => {
    const g = group();
    try {
      g.app.updateRoom(g.room.id, { parallel: true });
      g.say("@claude start the API");
      g.say("@codex start the tests");
      await g.until(() => g.agents.claude.ends.length === 1 && g.agents.codex.ends.length === 1);
      g.agents.claude.tasks?.([helper("running")]);
      g.say("@claude and the docs");
      // Labelled as in its turns, as Send now does: what @codex has to do says so.
      expect(g.agents.claude.steered).toEqual(["[Human · Phone]\n@codex start the tests\n(For @codex, not you: they answer it in their own turn.)\n\n[Human · Phone]\n@claude and the docs"]);
      await g.until(() => g.queued().length === 0);
      expect(g.agents.codex.steered).toEqual([]);
      // @codex has no helper at work: its message goes into its reply all the same, and @claude's reply isn't given it again.
      g.say("@codex and the fixtures");
      await g.until(() => g.agents.codex.steered.length === 1 && g.queued().length === 0);
      expect(g.agents.codex.steered).toEqual(["[Human · Phone]\n@claude and the docs\n(For @claude, not you: they answer it in their own turn.)\n\n[Human · Phone]\n@codex and the fixtures"]);
      expect(g.agents.claude.steered).toHaveLength(1);
      await g.end("codex");
      await g.end("claude");
      await Bun.sleep(20);
      // Each answered in the reply it had: no second one for either.
      expect(g.agents.claude.ends).toHaveLength(1);
      expect(g.agents.codex.ends).toHaveLength(1);
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("another agent's reply it hasn't read: the message goes as a turn when the reply ends, so nothing is skipped", async () => {
    const g = group();
    try {
      g.app.updateRoom(g.room.id, { parallel: true });
      g.say("@claude start the API");
      g.say("@codex start the tests");
      await g.until(() => g.agents.claude.ends.length === 1 && g.agents.codex.ends.length === 1);
      g.agents.claude.tasks?.([helper("running")]);
      await g.end("codex");
      g.say("@claude and the docs");
      await Bun.sleep(20);
      // Send now's hand-over counts everything so far as read: @claude would never see what @codex wrote.
      expect(g.agents.claude.steered).toEqual([]);
      expect(g.queued()).toEqual(["claude"]);
      await g.end("claude");
      await g.until(() => g.agents.claude.ends.length === 2);
      expect(g.agents.claude.prompts[1]).toContain("codex answered.");
      expect(g.agents.claude.prompts[1]).toContain("@claude and the docs");
      await g.end("claude");
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  for (const way of ["while its helpers work", "with no helper at work"] as const) {
    test(`another agent's reply still being written as a message goes in ${way}: it reaches the agent on its next turn`, async () => {
      const g = group();
      try {
        g.app.updateRoom(g.room.id, { parallel: true });
        g.say("@claude start the API");
        g.say("@codex start the tests");
        await g.until(() => g.agents.claude.ends.length === 1 && g.agents.codex.ends.length === 1);
        if (way === "while its helpers work") g.agents.claude.tasks?.([helper("running")]);
        g.say("@claude and the docs");
        await g.until(() => g.agents.claude.steered.length === 1 && g.queued().length === 0);
        // @codex ends only now. (Counted as read with everything else, it was never seen again.)
        g.agents.codex.ends.at(-1)!({ ok: true, text: "CODEX-FOUND-THE-BUG" });
        await Bun.sleep(10);
        await g.end("claude");
        g.say("@claude what now?");
        await g.until(() => g.agents.claude.ends.length === 2);
        expect(g.agents.claude.prompts[1]).toContain("CODEX-FOUND-THE-BUG");
        expect(g.agents.claude.prompts[1]).toContain("@claude what now?");
        await g.end("claude");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });
  }

  test("the hold's note is for the person: it's never the newest thing an agent reads, and its reply answers the message", async () => {
    const g = group();
    try {
      await claudeHelper(g);
      g.app.updateMember(g.member("claude").id, { config: { ...g.member("claude").config, effort: "high" } });
      g.say("@claude and this");
      expect(g.notes()).toEqual(["Your new settings apply when @claude's helpers finish. Until then it answers with the settings it started with."]);
      // In the chat: under the message and above the reply. In what the agent reads: not at all.
      expect(g.app.store.listMessages(g.room.id).slice(-3).map((m) => m.authorKind)).toEqual(["human", "system", "agent"]);
      expect(g.agents.claude.prompts[1]).toContain("@claude and this");
      expect(g.agents.claude.prompts[1]).not.toContain("Your new settings apply");
      await g.end("claude");
      // Nor on its next turn: it counts as read.
      g.say("@claude and that");
      expect(g.agents.claude.prompts[2]).not.toContain("Your new settings apply");
      await g.end("claude");
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("a note about what waits reads as it always did: another agent reads it as news, and the agent it's about reads one said at a hand-over on its next turn, before what came after it", async () => {
    const g = group();
    const note = "Your new settings apply when @claude's helpers finish. Until then it answers with the settings it started with.";
    try {
      g.say("@claude build it");
      await g.until(() => g.agents.claude.ends.length === 1);
      g.agents.claude.tasks?.([helper("running")]);
      g.app.updateMember(g.member("claude").id, { config: { ...g.member("claude").config, effort: "high" } });
      g.say("@claude also this");
      await g.until(() => g.agents.claude.steered.length === 1 && g.queued().length === 0);
      expect(g.notes()).toEqual([note]);
      await g.end("claude");
      g.say("@claude and that");
      await g.until(() => g.agents.claude.ends.length === 2);
      const next = g.agents.claude.prompts[1];
      expect(next).toContain(note);
      expect(next.indexOf(note)).toBeLessThan(next.indexOf("@claude and that"));
      await g.end("claude");
      g.say("@codex look at the tests");
      await g.until(() => g.agents.codex.ends.length === 1);
      expect(g.agents.codex.prompts[0]).toContain(note);
      await g.end("codex");
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("a message given back by Stop reads as that message, not the note said about it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-send-now-note-"));
    dirs.push(dir);
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
    const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
    const ends: ((r: TurnResult) => void)[] = [];
    const prompts: string[] = [];
    let handed: string[] = [];
    let tasks: DriverContext["onTasks"];
    deps.createDriver = (ctx) => {
      tasks = ctx.onTasks;
      return {
        provider: ctx.member.provider,
        runTurn: (input) => (prompts.push(input.prompt), new Promise<TurnResult>((res) => ends.push(res))),
        steer: async (_text, ids) => (handed.push(...(ids ?? [])), true),
        takeUnread: () => handed.splice(0),
        interrupt: async () => ends.at(-1)?.({ ok: false, error: "stopped" }),
        dispose: async () => {},
      } satisfies AgentDriver;
    };
    deps.agentEnv = () => ({});
    deps.resolveBin = () => "";
    deps.endpointFor = () => null;
    deps.turnNotice = () => null;
    app.storage.check = async () => {};
    const room: Room = app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: dir });
    const claude = () => app.store.listMembers(room.id).find((m) => m.handle === "claude")!;
    const say = (text: string) => app.engine.postHumanMessage(room.id, text, "Phone");
    const until = async (what: () => unknown) => {
      for (const end = Date.now() + 5000; Date.now() < end; await Bun.sleep(5)) if (what()) return;
      throw new Error("timed out waiting");
    };
    const notes = () => app.store.listMessages(room.id).filter((m) => m.authorKind === "system").map((m) => m.text);
    try {
      say("@claude build it");
      await until(() => ends.length === 1);
      tasks?.([helper("running")]);
      app.updateMember(claude().id, { config: { ...claude().config, effort: "high" } });
      // In by itself, with the note after it.
      say("@claude also this");
      await until(() => handed.length === 1 && app.engine.queuedTurns(room.id).length === 0);
      const note = "Your new settings apply when @claude's helpers finish. Until then it answers with the settings it started with.";
      expect(notes().at(-1)).toBe(note);
      await app.engine.stop(room.id);
      await Bun.sleep(20);
      expect(ends).toHaveLength(1);
      // Try again under the message: it goes to whoever it's for.
      app.engine.retry(room.id);
      await until(() => ends.length === 2);
      expect(prompts[1]).toContain("@claude also this");
      expect(prompts[1]).not.toContain(note);
    } finally {
      tasks?.([helper("completed")]);
      for (const e of ends) e({ ok: false, error: "stopped" });
      await app.shutdown();
    }
  });

  test("Stop and answer in a group chat: what the reply never read is answered next only if it's that agent's to answer", async () => {
    const g = group();
    try {
      g.app.updateRoom(g.room.id, { parallel: true });
      // What @claude's stand-in says it never read when it's stopped.
      const deps = (g.app.engine as unknown as { deps: EngineDeps }).deps;
      const was = deps.createDriver;
      let unread: string[] = [];
      deps.createDriver = (ctx) => {
        const d = was(ctx);
        return ctx.member.handle === "claude" ? { ...d, takeUnread: () => unread.splice(0) } : d;
      };
      g.say("@claude start the API");
      await g.until(() => g.agents.claude.ends.length === 1);
      g.agents.claude.tasks?.([helper("running")]);
      // Handed over together, as Send now labels them: one is @codex's to answer, and it does.
      const forCodex = g.say("@codex start the tests");
      await g.until(() => g.agents.codex.ends.length === 1);
      const forClaude = g.say("@claude and the docs");
      await g.until(() => g.agents.claude.steered.length === 1 && g.queued().length === 0);
      unread = [forCodex.id, forClaude.id];
      await g.app.engine.stop(g.room.id, g.member("claude").id, { keepWaiting: true });
      await g.until(() => g.agents.claude.ends.length === 2);
      expect(g.agents.claude.prompts[1]).toContain("@claude and the docs");
      expect(g.app.store.getTurn(g.app.engine.runningTurns(g.room.id).find((t) => t.memberId === g.member("claude").id)!.id)!.triggerMessageId).toBe(forClaude.id);
      expect(g.agents.codex.ends).toHaveLength(1);
      // Only another agent's came back: there's nothing here for this agent to answer.
      unread = [forCodex.id];
      await g.app.engine.stop(g.room.id, g.member("claude").id, { keepWaiting: true });
      await Bun.sleep(20);
      expect(g.agents.claude.ends).toHaveLength(2);
      expect(g.queued()).toEqual([]);
      await g.end("codex");
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("Stop and answer for one agent leaves another agent's reply running: its turn waits for that reply, and goes as it ends", async () => {
    const g = group();
    try {
      await claudeHelper(g);
      g.app.updateMember(g.member("claude").id, { config: { ...g.member("claude").config, effort: "high" } });
      g.say("@codex look at this");
      await g.until(() => g.agents.codex.ends.length === 1);
      // Not @codex's to take: it waits for its own agent's turn.
      g.say("@claude and this");
      await Bun.sleep(10);
      expect(g.agents.codex.steered).toEqual([]);
      await g.app.engine.stop(g.room.id, g.member("claude").id, { keepWaiting: true });
      expect(g.agents.claude.ends).toHaveLength(1);
      expect(g.agents.codex.ends).toHaveLength(1);
      expect(g.queued()).toEqual(["claude"]);
      await g.end("codex");
      await g.until(() => g.agents.claude.ends.length === 2);
      expect(g.agents.claude.prompts[1]).toContain("@claude and this");
      // On the process as it is, said once for the hold.
      expect(g.agents.claude.ran).toEqual([1, 1]);
      expect(g.notes()).toEqual(["Your new settings apply when @claude's helpers finish. Until then it answers with the settings it started with."]);
      await g.end("claude");
      await Bun.sleep(20);
      expect(g.agents.claude.ends).toHaveLength(2);
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("a question to the reviewer during its review stays a turn of its own: its answer is never judged as the review", async () => {
    const g = group();
    try {
      g.app.updateRoom(g.room.id, { mode: "review" });
      g.say("Build it");
      await g.until(() => g.agents.claude.ends.length === 1);
      await g.end("claude");
      // The loop's turn for @codex: the review, with a helper at work.
      await g.until(() => g.agents.codex.ends.length === 1);
      g.agents.codex.tasks?.([helper("running")]);
      g.say("@codex what is the release date in the changelog?");
      await Bun.sleep(20);
      expect(g.agents.codex.steered).toEqual([]);
      expect(g.queued()).toEqual(["codex"]);
      g.agents.codex.ends.at(-1)!({ ok: true, text: "APPROVED: looks right." });
      await g.until(() => g.agents.codex.ends.length === 2);
      expect(g.agents.codex.prompts[1]).toContain("what is the release date in the changelog?");
      // Its answer goes to the person: the builder isn't told to fix anything.
      g.agents.codex.ends.at(-1)!({ ok: true, text: "The changelog says the release is on 12 November." });
      await Bun.sleep(20);
      expect(g.agents.claude.ends).toHaveLength(1);
      expect(g.queued()).toEqual([]);
    } finally {
      g.agents.codex.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("a reply to another agent's @mention takes nothing either: what you say to it isn't part of what it says back", async () => {
    const g = group();
    try {
      g.app.store.updateRoom(g.room.id, { mode: "relay" }); // as a room from before lead and relay went; a review room's @mention is the same
      g.say("@claude start the API");
      await g.until(() => g.agents.claude.ends.length === 1);
      g.agents.claude.ends.at(-1)!({ ok: true, text: "@codex please check the schema" });
      await g.until(() => g.agents.codex.ends.length === 1);
      g.agents.codex.tasks?.([helper("running")]);
      g.say("@codex and while you're there, the logs");
      await Bun.sleep(20);
      expect(g.agents.codex.steered).toEqual([]);
      expect(g.queued()).toEqual(["codex"]);
      await g.end("codex");
      await g.until(() => g.agents.codex.ends.length === 2);
      expect(g.agents.codex.prompts[1]).toContain("the logs");
      await g.end("codex");
    } finally {
      g.agents.codex.tasks?.([helper("completed")]);
      await g.done();
    }
  });

  test("everyone answering in turn: a turn with its own instructions isn't dropped for a hand-over, and the message still goes when the reply ends", async () => {
    const g = group({ answers: "turns" });
    try {
      g.say("Start");
      await g.until(() => g.agents.claude.ends.length === 1);
      g.agents.claude.tasks?.([helper("running")]);
      g.say("And the docs");
      await Bun.sleep(20);
      expect(g.agents.claude.steered).toEqual([]);
      await g.end("claude");
      await g.until(() => g.agents.codex.ends.length === 1);
      await g.end("codex");
      await g.until(() => g.agents.claude.ends.length === 2);
      expect(g.agents.claude.prompts[1]).toContain("And the docs");
      await g.end("claude");
      await g.until(() => g.agents.codex.ends.length === 2);
      await g.end("codex");
    } finally {
      g.agents.claude.tasks?.([helper("completed")]);
      await g.done();
    }
  });
});

describe("the switch is gone (Settings → Keep going while helpers work, until 0.8)", () => {
  /** New settings waiting for its helpers and a message sent: whether that started a turn at once, on the process as it is. */
  async function goesAround(t: ReturnType<typeof chat>) {
    t.say("Install the browser");
    await t.until(() => t.turns() === 1);
    t.tasks([helper("running")]);
    await t.end();
    t.app.updateMember(t.member.id, { config: { ...t.now().config, effort: "high" } });
    t.say("Carry on");
    await Bun.sleep(20);
    return t.turns() === 2;
  }

  test("what a hub says of itself: messages go in by themselves, always", async () => {
    const t = chat(true);
    try {
      expect(t.app.hubInfo()).toMatchObject({ messagesFlow: true, flowsIn: true });
      expect(await goesAround(t)).toBe(true);
      await t.end();
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  for (const [what, saved] of [
    ["settings saved before there was a switch", '{"machineName":"Mac mini","pauseNearLimit":true}'],
    ["the switch saved off, before it went", '{"machineName":"Mac mini","pauseNearLimit":true,"messagesFlow":false}'],
    ["settings that can't be read", "{not json"],
  ] as const) {
    test(`${what}: nothing is held for it, with helpers at work or without`, async () => {
      const t = chat(true);
      try {
        t.app.store.kvSet("hubSettings", saved);
        expect(t.app.hubInfo()).toMatchObject({ messagesFlow: true, flowsIn: true });
        // New settings waiting for the helpers: the message starts at once on the process as it is.
        expect(await goesAround(t)).toBe(true);
        // A reply running: the next one goes into it.
        t.say("And the docs");
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["And the docs"]);
        await t.end();
        expect(t.turns()).toBe(2);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  }

  test("an older app turns the switch off: nothing is held, no device is told anything, and the other settings keep their values", async () => {
    const t = chat(true);
    try {
      t.app.setHubSettings({ machineName: "Mac mini", carryOnAfterLimit: false });
      const heard: ServerEvent[] = [];
      const stop = t.app.bus.on((e: ServerEvent) => {
        if (e.t === "hub") heard.push(e);
      });
      expect(t.app.setHubSettings({ messagesFlow: false })).toMatchObject({ machineName: "Mac mini", carryOnAfterLimit: false });
      t.app.setHubSettings({ pauseNearLimit: true });
      stop();
      expect(heard).toEqual([]);
      expect(t.app.hubSettings()).toMatchObject({ machineName: "Mac mini", carryOnAfterLimit: false, pauseNearLimit: true });
      expect(t.app.hubInfo()).toMatchObject({ messagesFlow: true, flowsIn: true });
      expect(await goesAround(t)).toBe(true);
      await t.end();
      // No reply running and nothing waiting: a message sent then starts its turn as ever.
      t.say("And now?");
      expect(t.turns()).toBe(3);
      await t.end();
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  test("through the server: a device is told so as it connects, and an older app's switch gets an answer and changes nothing", async () => {
    const t = chat(true);
    const server = startServer(t.app);
    const sockets: WebSocket[] = [];
    try {
      const phone = (await t.app.auth.pair((await t.app.auth.createPairingCode()).code, "Phone", "Web"))!;
      const base = `127.0.0.1:${server.port}`;
      /** A device's connection, and everything it hears about the hub. */
      const open = async (token: string) => {
        const heard: Extract<ServerEvent, { t: "hello" | "hub" }>[] = [];
        const ws = new WebSocket(`ws://${base}/api/ws?token=${encodeURIComponent(token)}&v=2`);
        sockets.push(ws);
        ws.onmessage = (e) => {
          const event = JSON.parse(String(e.data)) as ServerEvent;
          if (event.t === "hello" || event.t === "hub") heard.push(event);
        };
        await t.until(() => heard.length === 1);
        return heard;
      };
      const put = (body: unknown) => fetch(`http://${base}/api/settings/hub`, { method: "PUT", headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const state = async () => ((await (await fetch(`http://${base}/api/state`, { headers: { authorization: `Bearer ${phone.token}` } })).json()) as { hub: HubInfo }).hub;
      const onPhone = await open(phone.token);
      expect(onPhone[0]).toMatchObject({ t: "hello", hub: { messagesFlow: true, flowsIn: true } });
      expect((await put({ messagesFlow: false })).ok).toBe(true);
      await Bun.sleep(30);
      expect(onPhone).toHaveLength(1);
      expect(await state()).toMatchObject({ messagesFlow: true, flowsIn: true });
      const late = await open(phone.token);
      expect(late[0]).toMatchObject({ t: "hello", hub: { messagesFlow: true, flowsIn: true } });
    } finally {
      for (const ws of sockets) ws.close();
      server.stop(true);
      await t.done();
    }
  });
});

describe("what a process held for its next turn outlives it, however it goes (AgentDriver.carryNote)", () => {
  const CARRIED = "(Note from Crosstalk: a helper agent of yours finished while no reply of yours was running.)";

  test("frozen: the watchdog replaces it, and the retry is told", async () => {
    const t = chat(true);
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.knobs.carry = CARRIED;
      (t.app.engine as unknown as { checkStalls(ms: number): void }).checkStalls(0);
      await t.until(() => t.turns() === 2);
      expect(t.drivers.made).toBe(2);
      expect(t.prompts[1]).toStartWith(CARRIED);
      expect(t.app.store.kvGet("carryNotes")).toBeNull();
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("its sign-in went stale: the fresh process carries on, and the next turn is told", async () => {
    const t = chat(true);
    try {
      t.deps.signIn = { covers: () => true, names: () => ({ agent: "Claude Code", machine: "Mac mini" }), isNeeded: () => false, check: async () => true, needed: () => "", stillFailing: () => "", worked: () => {} };
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.knobs.carry = CARRIED;
      await t.end({ ok: false, error: "Failed to authenticate", auth: { kind: "stale", said: "Failed to authenticate" } });
      await t.until(() => t.turns() === 2);
      expect(t.drivers.made).toBe(2);
      expect(JSON.parse(t.app.store.kvGet("carryNotes")!)[t.member.id]).toBe(CARRIED);
      await t.end();
      t.say("what now?");
      await t.until(() => t.turns() === 3);
      expect(t.prompts[2]).toStartWith(CARRIED);
      await t.end();
    } finally {
      await t.done();
    }
  });
});
