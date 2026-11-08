// "Send now" says why it didn't send, so the app can say what really holds your message. A chat's Send now once
// answered "It's being answered already, or the reply just ended" while the message was held behind the agent's
// helpers (the chat had been moved from Opus 5 to Opus 5.5 during a reply, and new settings wait for the helpers)
// and nothing was being answered. Meanwhile Claude Code's own replies, as its helpers reported back, ran on the old
// Opus 5 process. Now nothing waits for helpers at all unless it must (the default): see "messages keep flowing".
// Settings → "Keep going while helpers work" off (messagesFlow) brings the hold back, with every safeguard since: see
// "with the switch off". Every agent here is an in-process stand-in whose turns end when the test says; no CLI runs.

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
  /** Send now or Answer now on the bar, with the line's agent. */
  const sendNow = (body: Record<string, unknown> = {}) => post("send-now", { memberId: member.id, ...body }) as Promise<SendNowResult>;
  /** Try again, or Answer now under a message (`currentSettings`). */
  const retry = (body: Record<string, unknown> = {}) => post("retry", body);
  /** Stop, or "Stop and answer my message" (`keepWaiting`). */
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

describe("Send now says why it didn't send", () => {
  test("into the running reply: sent, and nothing else said", async () => {
    const t = chat(true);
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.say("also add tests");
      // No helpers: it waits for the tap (the app's bar), as ever.
      await Bun.sleep(20);
      expect(t.steered).toEqual([]);
      expect(await t.sendNow()).toEqual({ sent: true });
      expect(t.steered).toEqual(["also add tests"]);
      // Tapped again (another device): the reply has it already.
      expect(await t.sendNow()).toEqual({ sent: false, why: "answering" });
      await t.end();
      expect(t.turns()).toBe(1); // no second reply for it
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
      const resetsAt = Date.now() + 33 * 60_000;
      await t.end({ ok: false, error: "You've hit your 5-hour limit", limit: { kind: "usage", label: "5-hour", resetsAt, source: "event" } });
      expect(t.now().status).toBe("waiting");
      const r = await t.sendNow();
      expect(r).toMatchObject({ sent: false, why: "limit", wait: { kind: "usage", resetsAt, provider: "claude" } });
      // The words the app shows for it, in the device's own clock.
      expect(limitQueuedWords(r.wait!, Date.now())).toBe(`Paused until your usage limit resets at ${limitResetTime(resetsAt, Date.now())}. Your message goes first when it does.`);
      // It's still the person's, unread: nothing was handed anywhere.
      expect(t.steered).toEqual([]);
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
    const t = chat(true);
    try {
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.say("also add tests");
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
  // These used to hold the message until the helpers finished, with Answer now as the way around it. Now a new model or
  // the like holds nothing: the message goes, no button, and the words below are what's said instead. An account switch, tighter permissions or a new folder still hold it (further down).
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

  test("an account switch waiting for the helpers: no Answer now, it says which change waits, and the message runs on the new account once they finish", async () => {
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
      // Answer now would run the old account's process on it (and drop what that reply saves): refused, saying why.
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

  test("tighter permissions waiting for the helpers: no Answer now, and no Send now into the agent's own reply on Full access", async () => {
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

describe("messages keep flowing while helpers work", () => {
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

  describe("no reply running, and only what the process may answer around waits", () => {
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

    test("Stop everything under a hold: the message stays unanswered, and Answer now goes at once on the process as it is", async () => {
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

    test("a helper starts with a message of yours already waiting behind the reply: it goes in from there", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.say("also add tests");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        t.tasks([helper("running")]);
        await t.until(() => t.steered.length === 1);
        expect(t.steered).toEqual(["also add tests"]);
        await t.until(() => t.queued() === 0);
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
    /** A reply and a helper at work, and a message that went in by itself and hasn't been read. */
    async function wentIn() {
      const t = chat(true);
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      const yours = t.say("ALSO delete the old build folder");
      await t.until(() => t.queued() === 0);
      expect(t.steered).toEqual(["ALSO delete the old build folder"]);
      t.knobs.dropsHanded = true;
      return { t, yours };
    }
    const unread = (t: ReturnType<typeof chat>, seq: number) => t.app.store.getLastSeen(t.member.id).seq < seq;

    test("Stop everything: it's unread again and starts nothing, and Answer now delivers it once", async () => {
      const { t, yours } = await wentIn();
      try {
        await t.app.engine.stop(t.room.id);
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(unread(t, yours.seq)).toBe(true);
        t.app.engine.retry(t.room.id);
        await t.until(() => t.turns() === 2);
        expect(t.prompts[1]).toContain("ALSO delete the old build folder");
        await t.end();
        expect(t.turns()).toBe(2);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Stop and answer my message: it's answered next, with no tap", async () => {
      const { t, yours } = await wentIn();
      try {
        await t.app.engine.stop(t.room.id, undefined, { keepWaiting: true });
        await t.until(() => t.turns() === 2);
        expect(t.prompts[1]).toContain("ALSO delete the old build folder");
        expect(t.queued()).toBe(0);
        expect(unread(t, yours.seq)).toBe(false);
        await t.end();
        expect(t.turns()).toBe(2);
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
    for (const [what, change, words, apply] of HOLDS) {
      test(`${what}: never into the reply, never around it, and it goes on a new process once the helpers finish`, async () => {
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
    }

    test("Stop everything with no reply running, then another message: as it always was, queued for when the helpers finish", async () => {
      const t = await helperAtWork(true);
      try {
        t.app.updateMember(t.member.id, { permissionMode: "ask" });
        t.say("Delete the old build folder");
        await Bun.sleep(20);
        await t.stop();
        await Bun.sleep(20);
        t.say("Delete the new one too");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        // (Off says what holds it instead, for its Answer now. On has no button here to bring back.)
        expect(t.now()).toMatchObject({ status: "queued", statusDetail: null, held: { change: "permissions", helpers: true } });
        t.tasks([helper("completed")]);
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(2);
        await t.end();
      } finally {
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

    test("a reply the agent owes by itself comes first, as ever; once it runs, a message that waited for it goes in, if other helpers still work", async () => {
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
        expect(await t.sendNow()).toEqual({ sent: false, why: "ownTurn", held: { change: "settings", helpers: true, owed: "report" } });
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
        // They keep writing: from here it waits for the reply, so the reply can end.
        t.say("five");
        t.say("six");
        await Bun.sleep(20);
        expect(t.steered).toEqual(["two", "three", "four"]);
        expect(t.queued()).toBe(1);
        await t.end();
        // The reply's end is the moment: the process is replaced before the next turn starts.
        await t.until(() => t.turns() === 3);
        expect(t.drivers).toEqual({ made: 2, ended: 1 });
        expect(t.ran[2]).toMatchObject({ driver: 2, model: "claude-opus-5-5" });
        expect(t.prompts[2]).toContain("five");
        expect(t.prompts[2]).toContain("six");
        expect(t.notes()).toContain("Now on Opus 5.5: the next reply uses it.");
        expect(t.now().held).toBeUndefined();
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

  describe("no helpers at work: nothing changes", () => {
    const TASKS: [string, BackgroundTask[]][] = [
      ["none has started", []],
      ["one has finished", [helper("completed")]],
      ["a command in the foreground (the reply's own step)", [{ ...helper("running"), id: "bash-1", kind: "local_bash", workflow: null, background: false }]],
    ];
    for (const [what, list] of TASKS) {
      test(`${what}: it waits behind the reply for the tap`, async () => {
        const t = chat(true);
        try {
          t.say("build it");
          await t.until(() => t.turns() === 1);
          t.tasks(list);
          t.say("also add tests");
          await Bun.sleep(30);
          expect(t.steered).toEqual([]);
          expect(t.queued()).toBe(1);
          expect(await t.sendNow()).toEqual({ sent: true });
          expect(t.steered).toEqual(["also add tests"]);
          await t.end();
          expect(t.turns()).toBe(1);
        } finally {
          await t.done();
        }
      });
    }

    test("a command left running in the background counts as a helper: it goes in by itself", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([{ ...helper("running"), id: "bash-1", kind: "local_bash", workflow: null, background: true }]);
        t.say("also add tests");
        expect(t.steered).toEqual(["also add tests"]);
        await t.until(() => t.queued() === 0);
        await t.end();
      } finally {
        t.tasks([{ ...helper("completed"), id: "bash-1", kind: "local_bash", workflow: null, background: true }]);
        await t.done();
      }
    });

    test("new settings waiting for the reply alone: the message waits, on the new settings after it; Send now says so at each tap", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        effort(t, "high");
        expect(t.now().held).toEqual({ change: "settings", helpers: false });
        t.say("also add tests");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        expect(await t.sendNow()).toEqual({ sent: true });
        expect(t.notes().at(-1)).toBe("Answering now with the settings Claude Code started with. Your changes apply from its next reply.");
        t.say("and the docs");
        await Bun.sleep(20);
        expect(t.steered).toEqual(["also add tests"]);
        await t.end();
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(2);
        expect(t.prompts[1]).toContain("and the docs");
        await t.end();
      } finally {
        await t.done();
      }
    });
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

  test("each agent's helpers and settings are its own: @claude's message goes around what waits for its helpers, with one note naming it, and @codex's isn't touched", async () => {
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
      // @codex has no helpers and nothing waiting: its messages are as they always were, and so is its Send now.
      g.say("@codex look at the tests");
      expect(g.agents.codex.ends).toHaveLength(1);
      g.say("@codex and the fixtures");
      await Bun.sleep(20);
      expect(g.agents.codex.steered).toEqual([]);
      expect(g.queued()).toEqual(["codex"]);
      expect(await g.app.engine.sendNowWhy(g.room.id, g.member("codex").id)).toEqual({ sent: true });
      expect(g.notes()).toEqual([note]);
      await g.end("codex");
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

  test("with parallel work, a message goes into the reply of the agent it's for only while that agent's helpers work", async () => {
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
      g.say("@codex and the fixtures");
      await Bun.sleep(20);
      expect(g.agents.codex.steered).toEqual([]);
      expect(g.queued()).toEqual(["codex"]);
      await g.end("codex");
      await g.until(() => g.agents.codex.ends.length === 2);
      await g.end("codex");
      await g.end("claude");
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

  for (const way of ["by itself, while its helpers work", "by Send now's tap"] as const) {
    test(`another agent's reply still being written as a message goes in ${way}: it reaches the agent on its next turn`, async () => {
      const g = group();
      try {
        g.app.updateRoom(g.room.id, { parallel: true });
        g.say("@claude start the API");
        g.say("@codex start the tests");
        await g.until(() => g.agents.claude.ends.length === 1 && g.agents.codex.ends.length === 1);
        if (way !== "by Send now's tap") g.agents.claude.tasks?.([helper("running")]);
        g.say("@claude and the docs");
        if (way === "by Send now's tap") expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id)).toEqual({ sent: true });
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

  for (const off of [false, true]) test(`a message given back by Stop reads as that message, not the note said about it${off ? ", with the switch off" : ""}`, async () => {
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
      if (off) app.setHubSettings({ messagesFlow: false });
      // In by itself, or by the tap, with the note after it.
      say("@claude also this");
      if (off) expect(await app.engine.sendNowWhy(room.id, claude().id)).toEqual({ sent: true });
      await until(() => handed.length === 1 && app.engine.queuedTurns(room.id).length === 0);
      const note = off ? "Answering now with the settings @claude started with. Your changes apply once its reply and its helpers finish." : "Your new settings apply when @claude's helpers finish. Until then it answers with the settings it started with.";
      expect(notes().at(-1)).toBe(note);
      await app.engine.stop(room.id);
      await Bun.sleep(20);
      expect(ends).toHaveLength(1);
      app.engine.retry(room.id, null, { currentSettings: true });
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

describe("with the switch off: messages wait for the helpers, and a tap sends one sooner (as it used to)", () => {
  /** A chat with "Keep going while helpers work" off. */
  function offChat(steer?: boolean, opts: Parameters<typeof chat>[1] = {}) {
    const t = chat(steer, opts);
    t.app.setHubSettings({ messagesFlow: false });
    return t;
  }
  /** Its agent has a helper at work and no reply running. */
  async function helperAtWork(steer?: boolean, opts: Parameters<typeof chat>[1] = {}) {
    const t = offChat(steer, opts);
    t.say("Install the browser");
    await t.until(() => t.turns() === 1);
    t.tasks([helper("running")]);
    await t.end();
    return t;
  }
  const effort = (t: ReturnType<typeof chat>, to: string) => t.app.updateMember(t.member.id, { config: { ...t.now().config, effort: to } });
  /** What the app shows as handed to the running reply and not read yet ("Read it now"). */
  const handedOver = (t: ReturnType<typeof chat>) => t.app.engine.liveTurn(t.app.engine.runningTurns(t.room.id)[0]).unread ?? [];
  const ANSWERING = "Answering now with the settings Claude Code started with. Your changes apply once its helpers finish.";
  const ANSWERING_REPLY = "Answering now with the settings Claude Code started with. Your changes apply once this reply and its helpers finish.";

  // The tests the hold had before messages kept flowing, as they were.
  test("Send now says so instead of 'being answered'; Answer now answers it with the agent as it is; the settings still apply after the helpers", async () => {
    const t = offChat(true);
    try {
      // A reply starts a long background workflow, and the chat is moved from Opus 5 to Opus 5.5 meanwhile.
      t.say("Install the browser and make it a setup step");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
      expect(t.now().held).toEqual({ change: "settings", helpers: true });
      // Their question waits behind the reply, as it should.
      t.say("Did this chat switch my model?");
      await t.end({ ok: true, text: "Installed. A workflow is building the setup step." });
      // The reply ended, but the question doesn't start: the new model waits for the workflow, and so does it.
      expect(t.turns()).toBe(1);
      expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
      expect(t.app.engine.queuedTurns(t.room.id)).toHaveLength(1);
      // Send now: there's no reply to put it into, and it says what is really holding it.
      expect(await t.sendNow()).toEqual({ sent: false, why: "helpers", held: { change: "settings", helpers: true } });
      expect(t.turns()).toBe(1);
      // Answer now: it's answered now, by the agent as it is (its helpers keep going), and the chat says so.
      expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
      await t.until(() => t.turns() === 2);
      expect(t.prompts[1]).toContain("Did this chat switch my model?");
      expect(t.drivers).toEqual({ made: 1, ended: 0 });
      expect(t.ran[1]).toMatchObject({ driver: 1, model: "claude-opus-5" });
      expect(t.notes()).toContain(ANSWERING);
      await t.end();
      // The settings still wait for the helpers, and the next message with them, until asked again.
      expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
      t.say("Send the link too");
      await Bun.sleep(20);
      expect(t.turns()).toBe(2);
      expect(await t.sendNow()).toEqual({ sent: false, why: "helpers", held: { change: "settings", helpers: true } });
      // The workflow finishes: the agent restarts with the new settings and answers what waited.
      t.tasks([helper("completed")]);
      await t.until(() => t.turns() === 3);
      expect(t.drivers).toEqual({ made: 2, ended: 1 });
      expect(t.ran[2]).toMatchObject({ driver: 2, model: "claude-opus-5-5" });
      expect(t.prompts[2]).toContain("Send the link too");
      expect(t.now().held).toBeUndefined();
      await t.end();
    } finally {
      await t.done();
    }
  });

  test("Send now into a reply while new settings wait: it goes in, and the chat says it's answered with the settings it started with", async () => {
    const t = offChat(true);
    try {
      t.say("Install the browser");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
      t.say("Did this chat switch my model?");
      // The reply is still running: Send now puts it in (currentSettings only matters once no reply runs)...
      expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
      expect(t.steered).toEqual(["Did this chat switch my model?"]);
      // ...but the reply runs on Opus 5, and the new model waits for it and its helpers: never silently.
      expect(t.notes()).toContain(ANSWERING_REPLY);
      await t.end();
      expect(t.turns()).toBe(1);
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  test("Claude Code's own reply as its helpers report back runs on the old process; Send now into it says so too", async () => {
    const t = offChat(true);
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
      // While that reply runs, a message waits for it and then for the helpers: the hold rides along with the reply.
      t.say("Did this chat switch my model?");
      await Bun.sleep(20);
      expect(t.steered).toEqual([]);
      expect(t.now().held).toEqual({ change: "settings", helpers: true });
      expect(await t.sendNow()).toEqual({ sent: true });
      expect(t.notes().at(-1)).toBe(ANSWERING_REPLY);
      await t.end();
      // Its reply ended: back to waiting for the helpers.
      expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  test("an account switch waiting for the helpers: no Answer now, it says which change waits, and the message runs on the new account once they finish", async () => {
    const t = offChat(true);
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
      // Answer now would run the old account's process on it (and drop what that reply saves): refused, saying why.
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

  test("tighter permissions waiting for the helpers: no Answer now, and no Send now into the agent's own reply on Full access", async () => {
    const t = offChat(true);
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
    const t = offChat(true);
    try {
      t.app.updateMember(t.member.id, { permissionMode: "ask" });
      t.say("Install the browser");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      await t.end();
      t.app.updateMember(t.member.id, { permissionMode: "full" });
      expect(t.now().held).toEqual({ change: "settings", helpers: true });
      t.say("Carry on");
      expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
      await t.until(() => t.turns() === 2);
      expect(t.ran[1]).toMatchObject({ driver: 1, permissionMode: "ask" });
      expect(t.notes().at(-1)).toBe(ANSWERING);
      await t.end();
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  // What came since.
  describe("each thing the process may answer around holds the message", () => {
    const CHANGES: [string, (t: ReturnType<typeof chat>) => void][] = [
      ["a new model", (t) => t.app.updateMember(t.member.id, { model: "claude-opus-5-5" })],
      ["a new effort", (t) => effort(t, "high")],
      ["fast mode", (t) => t.app.updateMember(t.member.id, { config: { ...t.now().config, fast: true } })],
      ["looser permissions", (t) => t.app.updateMember(t.member.id, { permissionMode: "full" })],
    ];
    for (const [what, change] of CHANGES) {
      test(`${what}: nothing starts until a tap or the helpers' end, and it's said at each tap, never as a hold's one note`, async () => {
        const t = offChat(true);
        try {
          t.app.updateMember(t.member.id, { permissionMode: "ask" });
          t.say("Install the browser");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          await t.end();
          change(t);
          expect(t.now().held).toEqual({ change: "settings", helpers: true });
          t.say("Carry on");
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(t.queued()).toBe(1);
          expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
          await t.until(() => t.turns() === 2);
          expect(t.ran[1].driver).toBe(1);
          await t.end();
          t.say("And again");
          await Bun.sleep(20);
          expect(t.turns()).toBe(2);
          expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
          await t.until(() => t.turns() === 3);
          expect(t.notes().filter((n) => n === ANSWERING)).toHaveLength(2);
          expect(t.notes().some((n) => n === AROUND)).toBe(false);
          await t.end();
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      });
    }

    test("said under the message and above the reply, and a second tap on one that's going says it's going", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        t.say("Carry on");
        expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
        expect(t.app.store.listMessages(t.room.id).slice(-3).map((m) => [m.authorKind, m.text])).toEqual([["human", "Carry on"], ["system", ANSWERING], ["agent", ""]]);
        expect(t.prompts[1]).not.toContain("Answering now");
        expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "answering" });
        expect(t.notes().filter((n) => n === ANSWERING)).toHaveLength(1);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("new settings that wait for the reply alone: the switch changes nothing", async () => {
      const t = offChat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        effort(t, "high");
        expect(t.now().held).toEqual({ change: "settings", helpers: false });
        t.say("also add tests");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        expect(await t.sendNow()).toEqual({ sent: true });
        expect(t.notes().at(-1)).toBe("Answering now with the settings Claude Code started with. Your changes apply from its next reply.");
        t.say("and the docs");
        await t.end();
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(2);
        expect(t.prompts[1]).toContain("and the docs");
        await t.end();
      } finally {
        await t.done();
      }
    });

    test("no settings waiting: a message starts its turn while helpers work, as it always did", async () => {
      const t = await helperAtWork(true);
      try {
        t.say("What's next?");
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(0);
        expect(t.now().held).toBeUndefined();
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("the agent's own wake-up comes first, whatever is tapped, and Answer now isn't promised around it", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        t.knobs.owed = "report";
        t.tasks([helper("running"), { ...helper("completed"), id: "workflow-2" }]);
        t.say("What's next?");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        const owed: SendNowResult = { sent: false, why: "ownTurn", held: { change: "settings", helpers: true, owed: "report" } };
        expect(await t.sendNow({ currentSettings: true })).toEqual(owed);
        expect(await t.sendNow()).toEqual(owed);
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        t.knobs.owed = null;
        expect(t.ownReply()).toBe(true);
        await t.until(() => t.turns() === 2);
        // Its reply runs: the message stays behind it until tapped.
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        expect(await t.sendNow()).toEqual({ sent: true });
        expect(t.steered).toEqual(["What's next?"]);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a usage limit stops the reply: the same words, nothing can send it sooner, and Answer now isn't one", async () => {
      const t = offChat(true);
      try {
        t.say("research what happened");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        const yours = t.say("and send the link");
        const resetsAt = Date.now() + 33 * 60_000;
        await t.end({ ok: false, error: "You've hit your 5-hour limit", limit: { kind: "usage", label: "5-hour", resetsAt, source: "event" } });
        expect(t.now().status).toBe("waiting");
        expect(await t.sendNow({ currentSettings: true })).toMatchObject({ sent: false, why: "limit", wait: { kind: "usage", resetsAt } });
        expect(t.app.store.getLastSeen(t.member.id).seq).toBeLessThan(yours.seq);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a change taken back with nothing waiting leaves no \"Finishing helpers\" behind", async () => {
      const t = offChat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        await t.end();
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

    test("a change taken back lets the message go at once, on the process as it is, with nothing to tap", async () => {
      const t = await helperAtWork(true);
      try {
        const was = t.now().config;
        effort(t, "high");
        t.say("Carry on");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        t.app.updateMember(t.member.id, { config: was });
        await t.until(() => t.turns() === 2);
        expect(t.now().held).toBeUndefined();
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().some((n) => n.startsWith("Answering now") || n === AROUND)).toBe(false);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("nothing goes in mid-reply without a tap", () => {
    test("a reply and a helper at work, with or without settings waiting: it waits behind the reply until Send now, then shows as handed (Read it now)", async () => {
      for (const held of [false, true]) {
        const t = offChat(true);
        try {
          t.say("build it");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          if (held) effort(t, "high");
          const yours = t.say("also add tests");
          await Bun.sleep(30);
          expect(t.steered).toEqual([]);
          expect(t.queued()).toBe(1);
          expect(handedOver(t)).toEqual([]);
          expect(await t.sendNow()).toEqual({ sent: true });
          expect(t.steered).toEqual(["also add tests"]);
          expect(handedOver(t)).toEqual([yours.id]);
          expect(t.queued()).toBe(0);
          // A tap is said each time, and never as the hold's one note.
          expect(t.notes().filter((n) => n === AROUND)).toEqual([]);
          expect(t.notes().filter((n) => n === ANSWERING_REPLY)).toHaveLength(held ? 1 : 0);
          await t.end();
          expect(t.turns()).toBe(1);
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      }
    });

    test("a helper starting with a message already waiting doesn't send it", async () => {
      const t = offChat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.say("also add tests");
        t.tasks([helper("running")]);
        await Bun.sleep(30);
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        await t.end();
        // No settings wait: it starts its own reply as this one ends.
        await t.until(() => t.turns() === 2);
        expect(t.prompts[1]).toContain("also add tests");
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("what holds in both modes", () => {
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
    for (const [what, change, words, apply] of HOLDS) {
      test(`${what}: never into the reply, never around it, no tap sends it, and it goes on a new process once the helpers finish`, async () => {
        const t = offChat(true);
        try {
          t.say("Install the browser");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          apply(t);
          expect(t.now().held).toEqual({ change, helpers: true });
          t.say("Delete the old build folder");
          await Bun.sleep(20);
          expect(t.steered).toEqual([]);
          expect(t.queued()).toBe(1);
          expect(await t.sendNow()).toEqual({ sent: false, why: "settings", held: { change, helpers: true } });
          await t.end();
          await Bun.sleep(20);
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
        const t = offChat(true);
        try {
          t.say("Install the browser");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          await t.end();
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

      test(`${what}: Stop everything with no reply running, then another message: the status says why, with no button`, async () => {
        const t = offChat(true);
        try {
          t.say("Install the browser");
          await t.until(() => t.turns() === 1);
          t.tasks([helper("running")]);
          await t.end();
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
          expect(t.now()).toMatchObject({ status: "working", statusDetail: `Finishing helpers before ${words}`, held: { change, helpers: true } });
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

      test(`${what}: Stop everything, then Answer now under the message: still held, saying why, and nothing claims it's being answered`, async () => {
        const t = offChat(true);
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
          t.app.engine.retry(t.room.id, null, { currentSettings: true });
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
  });

  describe("Stop gives back what wasn't read", () => {
    /** A reply and a helper at work, new settings waiting, and a message Send now handed over that hasn't been read. */
    async function handed(hold = true) {
      const t = offChat(true);
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      if (hold) effort(t, "high");
      const yours = t.say("ALSO delete the old build folder");
      expect(await t.sendNow()).toEqual({ sent: true });
      t.knobs.dropsHanded = true;
      return { t, yours };
    }
    const unread = (t: ReturnType<typeof chat>, seq: number) => t.app.store.getLastSeen(t.member.id).seq < seq;

    test("Stop everything: it's unread again and starts nothing, under a hold too, and Answer now under it delivers it once, at once, saying so", async () => {
      const { t, yours } = await handed();
      try {
        await t.app.engine.stop(t.room.id);
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(unread(t, yours.seq)).toBe(true);
        expect(t.queued()).toBe(0);
        // Only its helpers keep the status "working": what the app takes for that (sendNow.ts onlyFinishingHelpers).
        expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
        t.app.engine.retry(t.room.id, null, { currentSettings: true });
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(0);
        expect(t.prompts[1]).toContain("ALSO delete the old build folder");
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().at(-1)).toBe(ANSWERING);
        await t.end();
        expect(t.turns()).toBe(2);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("no settings waiting: the same, and Answer now has nothing to go around", async () => {
      const { t, yours } = await handed(false);
      try {
        await t.app.engine.stop(t.room.id);
        await Bun.sleep(20);
        expect(unread(t, yours.seq)).toBe(true);
        t.app.engine.retry(t.room.id, null, { currentSettings: true });
        expect(t.turns()).toBe(2);
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Stop and answer my message: answered next on the process as it is, once, saying so", async () => {
      const { t, yours } = await handed();
      try {
        await t.app.engine.stop(t.room.id, undefined, { keepWaiting: true });
        await t.until(() => t.turns() === 2);
        expect(t.prompts[1]).toContain("ALSO delete the old build folder");
        expect(t.ran[1].driver).toBe(1);
        expect(t.queued()).toBe(0);
        expect(unread(t, yours.seq)).toBe(false);
        expect(t.notes().at(-1)).toBe(ANSWERING);
        await t.end();
        expect(t.turns()).toBe(2);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Stop and answer a message still waiting behind the reply: the same", async () => {
      const t = offChat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        await t.app.engine.stop(t.room.id, undefined, { keepWaiting: true });
        await t.until(() => t.turns() === 2);
        expect(t.prompts[1]).toContain("also add tests");
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().at(-1)).toBe(ANSWERING);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("an older app's Answer now under the message waits as any message does, the bar offers the tap, and that tap is used up", async () => {
      const t = offChat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        await t.app.engine.stop(t.room.id);
        await Bun.sleep(20);
        t.app.engine.retry(t.room.id);
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
        await t.until(() => t.turns() === 2);
        await t.end();
        t.say("and the docs");
        await Bun.sleep(20);
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Try again on a failed reply waits like any message, and the app hears the message is unread again, so the bar shows with Answer now", async () => {
      // It had taken the message in: only Try again makes it unread again, with no other reason for a device to hear of it.
      const t = await helperAtWork(true, { working: true });
      try {
        t.say("one");
        expect(t.turns()).toBe(2);
        effort(t, "high");
        await t.end({ ok: false, error: "The API said no." });
        expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
        const told: number[] = [];
        const off = t.app.bus.on((e: ServerEvent) => {
          if (e.t === "member" && e.member.id === t.member.id && e.member.readSeq !== undefined) told.push(e.member.readSeq);
        });
        t.app.engine.retry(t.room.id);
        off();
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(1);
        const one = t.app.store.listMessages(t.room.id).findLast((m) => m.text === "one")!;
        expect(told.at(-1)).toBe(t.app.store.messageSeq(one.id) - 1);
        expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
        await t.until(() => t.turns() === 3);
        expect(t.ran[2].driver).toBe(1);
        expect(t.notes().at(-1)).toBe(ANSWERING);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("no reply running: a tap goes at once, and the bar is there for it", () => {
    /** What the app's bar goes by: it says what holds the turn, so it offers Answer now (web sendNow.ts). */
    const HELD = { status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } };
    /** A helper at work, a new setting waiting, and a message held. */
    async function held(text = "Carry on") {
      const t = await helperAtWork(true);
      effort(t, "high");
      const message = t.say(text);
      await Bun.sleep(20);
      expect(t.turns()).toBe(1);
      expect(t.queued()).toBe(1);
      return { t, message };
    }
    /** The bar's tap: answered now, once, on the process as it is, saying so; and the next message waits again. */
    async function tapGoes(t: ReturnType<typeof chat>, reads: string[]) {
      expect(t.now()).toMatchObject(HELD);
      const before = t.turns();
      expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
      await t.until(() => t.turns() === before + 1);
      for (const text of reads) expect(t.prompts.at(-1)).toContain(text);
      expect(t.ran.at(-1)!.driver).toBe(1);
      expect(t.queued()).toBe(0);
      expect(t.notes().at(-1)).toBe(ANSWERING);
      await t.end();
      await Bun.sleep(20);
      expect(t.turns()).toBe(before + 1);
      expect(t.now()).toMatchObject(HELD);
    }
    const limit = (resetsAt = Date.now() + 33 * 60_000): TurnResult => ({ ok: false, error: "You've hit your 5-hour limit", limit: { kind: "usage", label: "5-hour", resetsAt, source: "event" } });
    /** A reply and a helper at work, a new setting waiting, a message behind the reply, and a usage limit stops the reply. */
    async function limited() {
      const t = offChat(true);
      t.say("build it");
      await t.until(() => t.turns() === 1);
      t.tasks([helper("running")]);
      effort(t, "high");
      t.say("also add tests");
      await t.end(limit());
      expect(t.now().status).toBe("waiting");
      return t;
    }

    test("Stop and answer my message: it starts at once, once, saying so, and the next message waits again", async () => {
      const { t } = await held();
      try {
        // Why Stop is on screen with nothing running.
        expect(t.now()).toMatchObject(HELD);
        await t.stop({ keepWaiting: true });
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(0);
        expect(t.prompts[1]).toContain("Carry on");
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().filter((n) => n === ANSWERING)).toHaveLength(1);
        expect(t.app.store.listMessages(t.room.id).slice(-3).map((m) => [m.authorKind, m.text])).toEqual([["human", "Carry on"], ["system", ANSWERING], ["agent", ""]]);
        await t.end();
        await Bun.sleep(20);
        expect(t.turns()).toBe(2);
        t.say("And the docs");
        await Bun.sleep(20);
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(1);
        // The bar's tap still works after it.
        await tapGoes(t, ["And the docs"]);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Stop and answer with nothing held and nothing running: there's nothing to stop, and nothing changes", async () => {
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

    for (const [how, memberId] of [["Stop everything", false], ["this agent's own Stop", true]] as const) {
      test(`${how}, then another message: the status says what holds it, so the bar is back, and Answer now goes`, async () => {
        const { t } = await held("one");
        try {
          await t.stop(memberId ? { memberId: t.member.id } : {});
          await Bun.sleep(20);
          expect(t.queued()).toBe(0);
          expect(t.now().status).toBe("idle");
          t.say("two");
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(t.queued()).toBe(1);
          await tapGoes(t, ["one", "two"]);
        } finally {
          t.tasks([helper("completed")]);
          await t.done();
        }
      });
    }

    test("a held message unsent, and written again: the bar is back, and Answer now goes", async () => {
      const { t, message } = await held("Delete it");
      try {
        await t.app.engine.reviseMessage(message.id, null, "Phone");
        expect(t.queued()).toBe(0);
        expect(t.now().status).toBe("idle");
        t.say("Delete it all");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        await tapGoes(t, ["Delete it all"]);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Try now during a usage limit's wait: it waits like any message, the bar is back, and Answer now goes", async () => {
      const t = await limited();
      try {
        t.app.engine.tryNow(t.room.id);
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        await tapGoes(t, ["also add tests"]);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a message sent during a usage limit's wait: the same", async () => {
      const t = await limited();
      try {
        t.say("and the docs");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        await tapGoes(t, ["and the docs"]);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("what it owes by itself comes next, with no helpers to wait for: the status doesn't say it's finishing any", async () => {
      const t = offChat(true);
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

    test("Answer now under a message during a usage limit's wait is the tap: it goes at once in a one-agent chat too", async () => {
      const t = await limited();
      try {
        const before = t.notes().length;
        t.app.engine.retry(t.room.id, null, { currentSettings: true });
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(0);
        expect(t.prompts[1]).toContain("also add tests");
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().slice(before)).toEqual([ANSWERING]);
        await t.end();
        await Bun.sleep(20);
        expect(t.turns()).toBe(2);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Try again during a usage limit's wait isn't one: it waits, and the bar offers the tap", async () => {
      const t = await limited();
      try {
        t.app.engine.retry(t.room.id);
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        await tapGoes(t, ["also add tests"]);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("an account past its spending limit: Answer now gets the usual refusal with no 'Answering now', the tap is used up, and the next message gets the bar", async () => {
      const { t, message } = await held("Carry on");
      const refusal = "Work key reached its $5.00 limit, so this reply didn't start.";
      try {
        t.deps.checkBudget = () => refusal;
        expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
        // Nothing ran, and nothing says it's answering.
        expect(t.turns()).toBe(1);
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        expect(t.app.store.listMessages(t.room.id).filter((m) => m.authorKind === "agent").at(-1)).toMatchObject({ text: refusal, status: "error" });
        expect(t.now()).toMatchObject({ status: "error", statusDetail: refusal });
        // Still the person's, unread.
        expect(t.app.store.getLastSeen(t.member.id).seq).toBeLessThan(message.seq);
        // Raised: the next message waits for a tap of its own, and the bar offers it.
        t.deps.checkBudget = () => null;
        t.say("And the docs");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        await tapGoes(t, ["Carry on", "And the docs"]);
        expect(t.notes().filter((n) => n === ANSWERING)).toHaveLength(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("Answer now tapped during a hand-over, and that hand-over ends the reply: it's still the tap", async () => {
      const t = offChat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        t.knobs.steerMs = 150;
        t.knobs.takes = false;
        const handOver = t.sendNow();
        const tap = t.sendNow({ currentSettings: true });
        // Both are on their way, the second waiting for the first, when the reply ends.
        await Bun.sleep(10);
        await t.end();
        expect(await handOver).toEqual({ sent: false, why: "ended" });
        expect(await tap).toEqual({ sent: true });
        await t.until(() => t.turns() === 2);
        expect(t.prompts[1]).toContain("also add tests");
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().at(-1)).toBe(ANSWERING);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("what a new process has to carry on from comes first: Answer now isn't promised around it, and says so", async () => {
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
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
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

    test("through the app's own route: Answer now under a message sends currentSettings and goes; anything else waits like any message", async () => {
      const { t } = await held("one");
      try {
        await t.stop();
        await Bun.sleep(20);
        expect(t.queued()).toBe(0);
        // Try again, and a value that isn't the tap.
        await t.retry({ currentSettings: "yes" });
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        await t.stop();
        await Bun.sleep(20);
        await t.retry({});
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        await t.stop();
        await Bun.sleep(20);
        // Answer now.
        await t.retry({ currentSettings: true });
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(0);
        expect(t.prompts[1]).toContain("one");
        expect(t.ran[1].driver).toBe(1);
        expect(t.notes().at(-1)).toBe(ANSWERING);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });

  describe("per agent, in a group chat", () => {
    function group() {
      const dir = mkdtempSync(join(tmpdir(), "ct-send-now-group-"));
      dirs.push(dir);
      const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
      const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
      type Agent = { ends: ((r: TurnResult) => void)[]; steered: string[]; prompts: string[]; tasks?: DriverContext["onTasks"] };
      const agents: Record<string, Agent> = { claude: { ends: [], steered: [], prompts: [] }, codex: { ends: [], steered: [], prompts: [] } };
      deps.createDriver = (ctx) => {
        const a = agents[ctx.member.handle];
        a.tasks = ctx.onTasks;
        return {
          provider: ctx.member.provider,
          runTurn: (input) => {
            a.prompts.push(input.prompt);
            return new Promise<TurnResult>((res) => a.ends.push(res));
          },
          steer: async (text) => (a.steered.push(text), true),
          interrupt: async () => a.ends.at(-1)?.({ ok: false, error: "stopped" }),
          dispose: async () => {},
        } satisfies AgentDriver;
      };
      deps.agentEnv = () => ({});
      deps.resolveBin = () => "";
      deps.endpointFor = () => null;
      deps.turnNotice = () => null;
      app.storage.check = async () => {};
      app.setHubSettings({ messagesFlow: false });
      const room: Room = app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: dir });
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
    async function claudeHelper(g: ReturnType<typeof group>) {
      g.say("@claude Install the browser");
      await g.until(() => g.agents.claude.ends.length === 1);
      g.agents.claude.tasks?.([helper("running")]);
      await g.end("claude");
      g.app.updateMember(g.member("claude").id, { config: { ...g.member("claude").config, effort: "high" } });
    }
    const ANSWERING_CLAUDE = "Answering now with the settings @claude started with. Your changes apply once its helpers finish.";

    test("one agent's hold holds only that agent's message, and Answer now names it, in a note its reply never reads", async () => {
      const g = group();
      try {
        await claudeHelper(g);
        g.say("@claude and this");
        await Bun.sleep(20);
        expect(g.agents.claude.ends).toHaveLength(1);
        expect(g.queued()).toEqual(["claude"]);
        // The next agent's goes past it (kept with the switch off too).
        g.say("@codex and that");
        await g.until(() => g.agents.codex.ends.length === 1);
        expect(g.queued()).toEqual(["claude"]);
        await g.end("codex");
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        await g.until(() => g.agents.claude.ends.length === 2);
        expect(g.notes().at(-1)).toBe(ANSWERING_CLAUDE);
        expect(g.agents.claude.prompts[1]).toContain("@claude and this");
        expect(g.agents.claude.prompts[1]).not.toContain("Answering now");
        expect(g.app.store.listMessages(g.room.id).slice(-2).map((m) => m.authorKind)).toEqual(["system", "agent"]);
        await g.end("claude");
        // Nor on its next turn.
        g.say("@codex and more");
        await g.until(() => g.agents.codex.ends.length === 2);
        await g.end("codex");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });

    for (const parallel of [false, true]) {
      test(`Stop and answer with no reply running${parallel ? ", with parallel work" : ""}: the held message starts at once, once, saying so`, async () => {
        const g = group();
        try {
          if (parallel) g.app.updateRoom(g.room.id, { parallel: true });
          await claudeHelper(g);
          g.say("@claude and this");
          await Bun.sleep(20);
          expect(g.queued()).toEqual(["claude"]);
          await g.app.engine.stop(g.room.id, undefined, { keepWaiting: true });
          expect(g.agents.claude.ends).toHaveLength(2);
          expect(g.queued()).toEqual([]);
          expect(g.notes().filter((n) => n === ANSWERING_CLAUDE)).toHaveLength(1);
          expect(g.agents.claude.prompts[1]).toContain("@claude and this");
          await g.end("claude");
          await Bun.sleep(20);
          expect(g.agents.claude.ends).toHaveLength(2);
        } finally {
          g.agents.claude.tasks?.([helper("completed")]);
          await g.done();
        }
      });
    }

    test("Stop and answer waits for another agent's reply it isn't stopping: that agent's own Stop leaves the other's reply running, and the turn goes as that ends", async () => {
      const g = group();
      try {
        await claudeHelper(g);
        g.say("@codex look at this");
        await g.until(() => g.agents.codex.ends.length === 1);
        g.say("@claude and this");
        await Bun.sleep(10);
        await g.app.engine.stop(g.room.id, g.member("claude").id, { keepWaiting: true });
        expect(g.agents.claude.ends).toHaveLength(1);
        expect(g.queued()).toEqual(["claude"]);
        await g.end("codex");
        await g.until(() => g.agents.claude.ends.length === 2);
        expect(g.notes().at(-1)).toBe(ANSWERING_CLAUDE);
        await g.end("claude");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });

    test("Stop everything with no reply running, then another message: the agent's own line says what holds it, with Answer now", async () => {
      const g = group();
      try {
        await claudeHelper(g);
        g.say("@claude and this");
        await Bun.sleep(20);
        await g.app.engine.stop(g.room.id);
        await Bun.sleep(20);
        expect(g.queued()).toEqual([]);
        expect(g.member("claude").status).toBe("idle");
        g.say("@claude and that");
        await Bun.sleep(20);
        expect(g.queued()).toEqual(["claude"]);
        // Queued, the app only lists it in the turn order, with no line of its own (WorkingPanel GroupStatus).
        expect(g.member("claude")).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        await g.until(() => g.agents.claude.ends.length === 2);
        expect(g.agents.claude.prompts[1]).toContain("@claude and this");
        expect(g.agents.claude.prompts[1]).toContain("@claude and that");
        await g.end("claude");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });

    test("an Answer now that hasn't started, then its hold ended: the tap went with that hold, and a new one needs its own", async () => {
      const g = group();
      try {
        await claudeHelper(g);
        const high = g.member("claude").config;
        const { effort: _, ...was } = high as Record<string, unknown>;
        g.say("@codex look at this");
        await g.until(() => g.agents.codex.ends.length === 1);
        g.say("@claude and this");
        await Bun.sleep(10);
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        expect(g.queued()).toEqual(["claude"]);
        // Taken back, and changed again, with the turn still behind @codex's reply: a new hold, and nobody tapped for it.
        g.app.updateMember(g.member("claude").id, { config: was });
        await Bun.sleep(10);
        expect(g.member("claude").held).toBeUndefined();
        g.app.updateMember(g.member("claude").id, { config: high });
        expect(g.member("claude").held).toEqual({ change: "settings", helpers: true });
        await g.end("codex");
        await Bun.sleep(20);
        expect(g.agents.claude.ends).toHaveLength(1);
        expect(g.queued()).toEqual(["claude"]);
        expect(g.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        await g.until(() => g.agents.claude.ends.length === 2);
        expect(g.notes().at(-1)).toBe(ANSWERING_CLAUDE);
        await g.end("claude");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });

    test("Answer now under your message goes to whoever it's for", async () => {
      const g = group();
      try {
        await claudeHelper(g);
        const yours = g.say("@claude and this");
        await g.app.engine.stop(g.room.id);
        await Bun.sleep(20);
        expect(g.app.store.getLastSeen(g.member("claude").id).seq).toBeLessThan(yours.seq);
        g.app.engine.retry(g.room.id, null, { currentSettings: true });
        await g.until(() => g.agents.claude.ends.length === 2);
        expect(g.notes().at(-1)).toBe(ANSWERING_CLAUDE);
        await g.end("claude");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });

    test("an Answer now that hasn't started, its turn waiting for another agent's reply: Stop takes it with it, and the next message waits again", async () => {
      const g = group();
      try {
        await claudeHelper(g);
        g.say("@codex look at this");
        await g.until(() => g.agents.codex.ends.length === 1);
        g.say("@claude and this");
        await Bun.sleep(10);
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        expect(g.agents.claude.ends).toHaveLength(1);
        expect(g.queued()).toEqual(["claude"]);
        await g.app.engine.stop(g.room.id);
        await Bun.sleep(20);
        expect(g.queued()).toEqual([]);
        g.say("@claude and that");
        await Bun.sleep(20);
        expect(g.agents.claude.ends).toHaveLength(1);
        expect(g.queued()).toEqual(["claude"]);
        expect(g.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });

    test("an Answer now that hasn't started, then the switch turned on: overtaken, so the hold's one note is all that's said", async () => {
      const g = group();
      const around = "Your new settings apply when @claude's helpers finish. Until then it answers with the settings it started with.";
      try {
        await claudeHelper(g);
        g.say("@codex look at this");
        await g.until(() => g.agents.codex.ends.length === 1);
        g.say("@claude and this");
        await Bun.sleep(10);
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        g.app.setHubSettings({ messagesFlow: true });
        await g.end("codex");
        await g.until(() => g.agents.claude.ends.length === 2);
        expect(g.notes().filter((n) => n === around)).toHaveLength(1);
        await g.end("claude");
        g.say("@claude and that");
        await g.until(() => g.agents.claude.ends.length === 3);
        expect(g.notes().filter((n) => n === around)).toHaveLength(1);
        expect(g.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        await g.end("claude");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });

    test("a Send now's note reads as it did before messages kept flowing: on the agent's next turn, before what came after it", async () => {
      const g = group();
      try {
        await claudeHelper(g);
        g.say("@claude and this");
        await Bun.sleep(10);
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        await g.until(() => g.agents.claude.ends.length === 2);
        g.say("@claude also that");
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id)).toEqual({ sent: true });
        expect(g.notes().at(-1)).toBe("Answering now with the settings @claude started with. Your changes apply once its reply and its helpers finish.");
        await g.end("claude");
        g.say("@claude and then");
        await Bun.sleep(10);
        expect(await g.app.engine.sendNowWhy(g.room.id, g.member("claude").id, { currentSettings: true })).toEqual({ sent: true });
        await g.until(() => g.agents.claude.ends.length === 3);
        const next = g.agents.claude.prompts.at(-1)!;
        expect(next).toContain("@claude and then");
        // Once: this turn's own note goes in after what it reads.
        expect(next.split("Answering now")).toHaveLength(2);
        expect(next.indexOf("Answering now")).toBeLessThan(next.indexOf("@claude and then"));
        await g.end("claude");
      } finally {
        g.agents.claude.tasks?.([helper("completed")]);
        await g.done();
      }
    });
  });
});

describe("flipping the switch mid-hold", () => {
  const off = (t: { app: App }) => t.app.setHubSettings({ messagesFlow: false });
  const on = (t: { app: App }) => t.app.setHubSettings({ messagesFlow: true });
  const effort = (t: ReturnType<typeof chat>, to: string) => t.app.updateMember(t.member.id, { config: { ...t.now().config, effort: to } });
  const arounds = (t: ReturnType<typeof chat>) => t.notes().filter((n) => n === AROUND).length;
  /** Off, a helper at work, no reply running. */
  async function helperAtWork(steer?: boolean) {
    const t = chat(steer);
    off(t);
    t.say("Install the browser");
    await t.until(() => t.turns() === 1);
    t.tasks([helper("running")]);
    await t.end();
    return t;
  }

  describe("turned on", () => {
    test("a held message goes now, once, on the process as it is, with the hold's one note; flipping again sends nothing more", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        t.say("Carry on");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        on(t);
        await t.until(() => t.turns() === 2);
        expect(t.queued()).toBe(0);
        expect(t.prompts[1]).toContain("Carry on");
        expect(t.ran[1].driver).toBe(1);
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        expect(arounds(t)).toBe(1);
        expect(t.notes().some((n) => n.startsWith("Answering now"))).toBe(false);
        expect(t.app.store.listMessages(t.room.id).slice(-3).map((m) => [m.authorKind, m.text])).toEqual([["human", "Carry on"], ["system", AROUND], ["agent", ""]]);
        // Back and forth: nothing is sent twice.
        off(t);
        on(t);
        await Bun.sleep(20);
        expect(t.turns()).toBe(2);
        expect(t.steered).toEqual([]);
        expect(arounds(t)).toBe(1);
        await t.end();
        // From here on it's as if it had always been on: the next goes around with no second note, and the settings still
        // apply after the helpers.
        t.say("And now?");
        expect(t.turns()).toBe(3);
        expect(arounds(t)).toBe(1);
        await t.end();
        t.tasks([helper("completed")]);
        await t.until(() => t.drivers.ended === 1);
        expect(t.now().held).toBeUndefined();
      } finally {
        await t.done();
      }
    });

    test("several messages held together: one turn reads them all, each once", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        t.say("first");
        t.say("second");
        t.say("third");
        await Bun.sleep(20);
        expect(t.queued()).toBe(1);
        on(t);
        await t.until(() => t.turns() === 2);
        for (const m of ["first", "second", "third"]) expect(t.prompts[1].split(m)).toHaveLength(2);
        await t.end();
        await Bun.sleep(20);
        expect(t.turns()).toBe(2);
        expect(arounds(t)).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a reply running: a message waiting behind it goes into it, once, with the one note", async () => {
      const t = chat(true);
      try {
        off(t);
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        await Bun.sleep(20);
        expect(t.steered).toEqual([]);
        on(t);
        await t.until(() => t.steered.length === 1);
        expect(t.steered).toEqual(["also add tests"]);
        await t.until(() => t.queued() === 0);
        expect(arounds(t)).toBe(1);
        on(t);
        await Bun.sleep(20);
        expect(t.steered).toHaveLength(1);
        await t.end();
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("an agent with no mid-reply form: it goes when the reply ends, not when the helpers finish", async () => {
      const t = chat();
      try {
        off(t);
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        on(t);
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        await t.end();
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(1);
        expect(t.prompts[1]).toContain("also add tests");
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a model change's own note was the one: nothing more is said", async () => {
      const t = await helperAtWork();
      try {
        t.app.updateMember(t.member.id, { model: "claude-opus-5-5" });
        const said = t.notes().at(-1);
        expect(said).toBe("Model changed from Opus 5 to Opus 5.5. Claude Code answers on Opus 5 until its helpers finish.");
        t.say("Carry on");
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        on(t);
        await t.until(() => t.turns() === 2);
        expect(t.notes().at(-1)).toBe(said!);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    for (const [what, change] of [
      ["an account switch", "account"],
      ["tighter permissions", "permissions"],
    ] as const) {
      test(`${what}: stays held, says so, and nothing is released`, async () => {
        const t = await helperAtWork(true);
        try {
          if (change === "account") {
            const work = t.app.providers.setEndpointAccount("claude", { label: "Work server", baseUrl: "http://127.0.0.1:9", models: ["work-model"] });
            t.app.updateMember(t.member.id, { config: { ...t.now().config, account: work.id }, model: "work-model" });
          } else t.app.updateMember(t.member.id, { permissionMode: "ask" });
          t.say("Delete the old build folder");
          await Bun.sleep(20);
          on(t);
          await Bun.sleep(20);
          expect(t.turns()).toBe(1);
          expect(t.queued()).toBe(1);
          expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: false, why: "helpers", held: { change, helpers: true } });
          expect(arounds(t)).toBe(0);
          t.tasks([helper("completed")]);
          await t.until(() => t.turns() === 2);
          expect(t.ran[1].driver).toBe(2);
          await t.end();
        } finally {
          await t.done();
        }
      });
    }

    test("each agent in a group chat goes once, in turn, with its own one note", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ct-send-now-flip-"));
      dirs.push(dir);
      const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
      const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
      const agents: Record<string, { ends: ((r: TurnResult) => void)[]; tasks?: DriverContext["onTasks"]; prompts: string[] }> = { claude: { ends: [], prompts: [] }, codex: { ends: [], prompts: [] } };
      deps.createDriver = (ctx) => {
        const a = agents[ctx.member.handle];
        a.tasks = ctx.onTasks;
        return { provider: ctx.member.provider, runTurn: (input) => (a.prompts.push(input.prompt), new Promise<TurnResult>((res) => a.ends.push(res))), interrupt: async () => a.ends.at(-1)?.({ ok: false, error: "stopped" }), dispose: async () => {} } satisfies AgentDriver;
      };
      deps.agentEnv = () => ({});
      deps.resolveBin = () => "";
      deps.endpointFor = () => null;
      deps.turnNotice = () => null;
      app.storage.check = async () => {};
      off({ app });
      const room: Room = app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: dir });
      const member = (h: string) => app.store.listMembers(room.id).find((m) => m.handle === h)!;
      const say = (text: string) => app.engine.postHumanMessage(room.id, text, "Phone");
      const until = async (what: () => unknown) => {
        for (const end = Date.now() + 5000; Date.now() < end; await Bun.sleep(5)) if (what()) return;
        throw new Error("timed out waiting");
      };
      const finish = async (h: string) => {
        agents[h].ends.at(-1)!({ ok: true, text: `${h} answered.` });
        await Bun.sleep(10);
      };
      const notes = () => app.store.listMessages(room.id).filter((m) => m.authorKind === "system").map((m) => m.text);
      try {
        for (const h of ["claude", "codex"]) {
          say(`@${h} start`);
          await until(() => agents[h].ends.length === 1);
          agents[h].tasks?.([{ ...helper("running"), id: `workflow-${h}` }]);
          await finish(h);
          app.updateMember(member(h).id, { config: { ...member(h).config, effort: "high" } });
        }
        say("@claude one");
        say("@codex two");
        await Bun.sleep(20);
        expect(app.engine.queuedTurns(room.id)).toHaveLength(2);
        on({ app });
        await until(() => agents.claude.ends.length === 2);
        expect(agents.codex.ends).toHaveLength(1);
        await finish("claude");
        await until(() => agents.codex.ends.length === 2);
        expect(agents.claude.prompts[1]).toContain("@claude one");
        expect(agents.codex.prompts[1]).toContain("@codex two");
        await finish("codex");
        await Bun.sleep(20);
        expect(agents.claude.ends).toHaveLength(2);
        expect(agents.codex.ends).toHaveLength(2);
        for (const h of ["claude", "codex"]) expect(notes().filter((n) => n === `Your new settings apply when @${h}'s helpers finish. Until then it answers with the settings it started with.`)).toHaveLength(1);
      } finally {
        for (const h of ["claude", "codex"]) agents[h].tasks?.([{ ...helper("completed"), id: `workflow-${h}` }]);
        for (const a of Object.values(agents)) for (const e of a.ends) e({ ok: false, error: "stopped" });
        await app.shutdown();
      }
    });
  });

  describe("turned off", () => {
    test("a message already in the reply stays there: nothing is taken back or sent again, it shows as handed, and the next one waits for a tap", async () => {
      const t = chat(true);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        const first = t.say("in by itself");
        await t.until(() => t.queued() === 0);
        expect(t.steered).toEqual(["in by itself"]);
        off(t);
        await Bun.sleep(20);
        expect(t.steered).toEqual(["in by itself"]);
        expect(t.app.engine.liveTurn(t.app.engine.runningTurns(t.room.id)[0]).unread).toEqual([first.id]);
        // The next waits behind the reply, with Send now.
        t.say("after the switch");
        await Bun.sleep(30);
        expect(t.steered).toEqual(["in by itself"]);
        expect(t.queued()).toBe(1);
        expect(await t.sendNow()).toEqual({ sent: true });
        expect(t.steered).toEqual(["in by itself", "after the switch"]);
        await t.end();
        expect(t.turns()).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("a reply already answering around new settings runs on; the next message waits for the helpers, with Answer now", async () => {
      const t = chat(true);
      try {
        t.say("Install the browser");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        await t.end();
        effort(t, "high");
        t.say("Carry on");
        expect(t.turns()).toBe(2);
        expect(arounds(t)).toBe(1);
        off(t);
        await Bun.sleep(20);
        // Nothing happened to it.
        expect(t.app.engine.runningTurns(t.room.id)).toHaveLength(1);
        expect(t.drivers).toEqual({ made: 1, ended: 0 });
        await t.end();
        t.say("And now?");
        await Bun.sleep(20);
        expect(t.turns()).toBe(2);
        expect(t.queued()).toBe(1);
        expect(await t.sendNow()).toEqual({ sent: false, why: "helpers", held: { change: "settings", helpers: true } });
        expect(await t.sendNow({ currentSettings: true })).toEqual({ sent: true });
        await t.until(() => t.turns() === 3);
        expect(arounds(t)).toBe(1);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("what hadn't gone yet falls under it: a message waiting for the reply's end now waits for the helpers too", async () => {
      const t = chat();
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        effort(t, "high");
        t.say("also add tests");
        const replying = t.now();
        off(t);
        // The reply goes on saying what it's doing.
        expect(t.now()).toMatchObject({ status: replying.status, statusDetail: replying.statusDetail });
        await t.end();
        await Bun.sleep(20);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
        expect(t.now()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply" });
        t.tasks([helper("completed")]);
        await t.until(() => t.turns() === 2);
        expect(t.ran[1].driver).toBe(2);
        await t.end();
      } finally {
        await t.done();
      }
    });

    test("a message that was only waiting its turn says what holds it from now on: the bar is there, and nothing starts without its tap", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ct-send-now-flip-"));
      dirs.push(dir);
      const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
      const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
      const ends: Record<string, ((r: TurnResult) => void)[]> = { claude: [], codex: [] };
      let tasks: DriverContext["onTasks"];
      deps.createDriver = (ctx) => {
        if (ctx.member.handle === "claude") tasks = ctx.onTasks;
        return {
          provider: ctx.member.provider,
          runTurn: () => new Promise<TurnResult>((res) => ends[ctx.member.handle].push(res)),
          interrupt: async () => ends[ctx.member.handle].at(-1)?.({ ok: false, error: "stopped" }),
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
      const queued = () => app.engine.queuedTurns(room.id).map((x) => app.store.getMember(x.memberId)!.handle);
      const until = async (what: () => unknown) => {
        for (const end = Date.now() + 5000; Date.now() < end; await Bun.sleep(5)) if (what()) return;
        throw new Error("timed out waiting");
      };
      try {
        say("@claude Install the browser");
        await until(() => ends.claude.length === 1);
        tasks?.([helper("running")]);
        ends.claude.at(-1)!({ ok: true, text: "Installing." });
        await Bun.sleep(10);
        app.updateMember(claude().id, { config: { ...claude().config, effort: "high" } });
        say("@codex look at this");
        await until(() => ends.codex.length === 1);
        // @claude's own Stop takes the turn its first message had behind @codex's reply.
        say("@claude first this");
        await app.engine.stop(room.id, claude().id);
        expect(claude().status).toBe("idle");
        // On: nothing holds this one, it only waits for @codex's reply to end.
        say("@claude and this");
        await Bun.sleep(10);
        expect(queued()).toEqual(["claude"]);
        expect(claude().status).toBe("queued");
        app.setHubSettings({ messagesFlow: false });
        expect(claude()).toMatchObject({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
        ends.codex.at(-1)!({ ok: true, text: "Looked." });
        await Bun.sleep(20);
        expect(ends.claude).toHaveLength(1);
        expect(queued()).toEqual(["claude"]);
        expect(await app.engine.sendNowWhy(room.id, claude().id, { currentSettings: true })).toEqual({ sent: true });
        await until(() => ends.claude.length === 2);
      } finally {
        tasks?.([helper("completed")]);
        for (const e of [...ends.claude, ...ends.codex]) e({ ok: false, error: "stopped" });
        await app.shutdown();
      }
    });

    test("a reply still starting, asked again in a moment: the next look finds the switch off, and nothing goes in", async () => {
      const t = chat(false);
      try {
        t.say("build it");
        await t.until(() => t.turns() === 1);
        t.tasks([helper("running")]);
        t.say("also add tests");
        await Bun.sleep(20);
        off(t);
        t.knobs.takes = true;
        await Bun.sleep(700); // past FLOW_RETRY_MS
        expect(t.steered).toEqual([]);
        expect(t.queued()).toBe(1);
        await t.end();
        await t.until(() => t.turns() === 2);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });

    test("it stays off: another setting saved, or the same value saved again, releases nothing and tells no device", async () => {
      const t = await helperAtWork(true);
      try {
        effort(t, "high");
        t.say("Carry on");
        await Bun.sleep(20);
        const heard: HubInfo[] = [];
        const stop = t.app.bus.on((e: ServerEvent) => {
          if (e.t === "hub") heard.push(e.hub);
        });
        t.app.setHubSettings({ pauseNearLimit: true });
        off(t);
        await Bun.sleep(20);
        stop();
        expect(heard).toEqual([]);
        expect(t.turns()).toBe(1);
        expect(t.queued()).toBe(1);
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  });
});

describe("the switch itself: Settings → Keep going while helpers work", () => {
  /** New settings waiting for its helpers and a message sent: whether that started a turn. */
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

  test("on by default: what a fresh hub says, and what it does", async () => {
    const t = chat(true);
    try {
      expect(t.app.hubSettings().messagesFlow).toBe(true);
      expect(t.app.hubInfo().messagesFlow).toBe(true);
      expect(await goesAround(t)).toBe(true);
      await t.end();
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  for (const [what, saved] of [
    ["settings saved before the switch, with no value for it", '{"machineName":"Mac mini","pauseNearLimit":true}'],
    ["a value that isn't false", '{"machineName":"Mac mini","pauseNearLimit":true,"messagesFlow":null}'],
    ["settings that can't be read", "{not json"],
  ] as const) {
    test(`${what}: it's on, and it does what it says`, async () => {
      const t = chat(true);
      try {
        t.app.store.kvSet("hubSettings", saved);
        expect(t.app.hubInfo().messagesFlow).toBe(true);
        expect(await goesAround(t)).toBe(true);
        await t.end();
      } finally {
        t.tasks([helper("completed")]);
        await t.done();
      }
    });
  }

  test("settings saved before the switch: saving something else keeps what they had, and tells no device anything", async () => {
    const t = chat(true);
    try {
      t.app.store.kvSet("hubSettings", '{"machineName":"Mac mini","pauseNearLimit":true}');
      const heard: ServerEvent[] = [];
      const stop = t.app.bus.on((e: ServerEvent) => {
        if (e.t === "hub") heard.push(e);
      });
      t.app.setHubSettings({ carryOnAfterLimit: false });
      stop();
      expect(heard).toEqual([]);
      expect(t.app.hubSettings()).toMatchObject({ machineName: "Mac mini", pauseNearLimit: true, carryOnAfterLimit: false, messagesFlow: true });
    } finally {
      await t.done();
    }
  });

  test("saved: off stays off, what else is saved keeps its value, and only false turns it off", async () => {
    const t = chat(true);
    try {
      t.app.setHubSettings({ machineName: "Mac mini", carryOnAfterLimit: false });
      expect(t.app.setHubSettings({ messagesFlow: false })).toMatchObject({ machineName: "Mac mini", carryOnAfterLimit: false, messagesFlow: false });
      expect(JSON.parse(t.app.store.kvGet("hubSettings")!).messagesFlow).toBe(false);
      expect(t.app.hubInfo().messagesFlow).toBe(false);
      // Saving something else leaves it off.
      t.app.setHubSettings({ pauseNearLimit: true });
      expect(t.app.hubSettings().messagesFlow).toBe(false);
      expect(t.app.hubInfo().messagesFlow).toBe(false);
      expect(await goesAround(t)).toBe(false);
      // Absent from the request: unchanged. Anything but false: on, as an absent value is.
      t.app.setHubSettings({});
      expect(t.app.hubSettings().messagesFlow).toBe(false);
      t.app.setHubSettings({ messagesFlow: null as unknown as boolean });
      expect(t.app.hubSettings().messagesFlow).toBe(true);
      await t.until(() => t.turns() === 2);
      await t.end();
    } finally {
      t.tasks([helper("completed")]);
      await t.done();
    }
  });

  test("every open device hears a change at once, on its own socket, with no reload; a device that connects later is told as it does", async () => {
    const t = chat(true);
    const server = startServer(t.app);
    const sockets: WebSocket[] = [];
    try {
      const pair = async (name: string) => (await t.app.auth.pair((await t.app.auth.createPairingCode()).code, name, "Web"))!;
      const phone = await pair("Phone");
      const laptop = await pair("Laptop");
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
      const put = (token: string, body: unknown) => fetch(`http://${base}/api/settings/hub`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const state = async (token: string) => ((await (await fetch(`http://${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()) as { hub: HubInfo }).hub;
      const onPhone = await open(phone.token);
      const onLaptop = await open(laptop.token);
      expect(onPhone[0].hub.messagesFlow).toBe(true);
      // The switch on the phone: its own answer, and both devices' sockets.
      expect(((await (await put(phone.token, { messagesFlow: false })).json()) as { messagesFlow: boolean }).messagesFlow).toBe(false);
      await t.until(() => onPhone.length === 2 && onLaptop.length === 2);
      expect(onPhone[1]).toMatchObject({ t: "hub", hub: { messagesFlow: false, name: t.app.machineName() } });
      expect(onLaptop[1]).toMatchObject({ t: "hub", hub: { messagesFlow: false } });
      // What a device asks for itself says the same.
      expect((await state(laptop.token)).messagesFlow).toBe(false);
      const late = await open(laptop.token);
      expect(late[0]).toMatchObject({ t: "hello", hub: { messagesFlow: false } });
      // Saving what's there already, or something else: nothing to hear.
      await put(phone.token, { messagesFlow: false, pauseNearLimit: true });
      await Bun.sleep(30);
      expect(onLaptop).toHaveLength(2);
      // And back, from the other device.
      expect((await put(laptop.token, { messagesFlow: true })).ok).toBe(true);
      await t.until(() => onPhone.length === 3 && onLaptop.length === 3 && late.length === 2);
      expect(onPhone[2].hub.messagesFlow).toBe(true);
      expect((await state(phone.token)).messagesFlow).toBe(true);
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
