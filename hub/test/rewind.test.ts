import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { ClaudeDriver } from "../src/agents/claude";
import { registerDriver } from "../src/agents";
import { App } from "../src/app";
import { buildRoutes } from "../src/server";

const dirs: string[] = [];
afterAll(() => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  registerDriver("claude", (c) => new ClaudeDriver(c, c.bin));
});

/**
 * Claude Code stand-in: answers each message, fails on "REFUSE" (after taking it in, as Claude Code does), and rewinds
 * to before a message it was given. While `inApp` is set, it refuses before taking anything in, the way Claude Code
 * refuses a session that's open in the Claude app.
 */
class Agent implements AgentDriver {
  readonly provider = "claude" as const;
  static rewound: string[] = [];
  static inApp = false;
  static prompts: string[] = [];
  /** Its conversation was summarized since: it can't go back past that (Claude Code answers rewound: false). */
  static summarized = false;
  private seen: string[] = [];
  constructor(private ctx: DriverContext) {}
  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    if (Agent.inApp) return { ok: false, error: "This conversation is open in the Claude app right now. Close it there, then tap Try again." };
    Agent.prompts.push(input.prompt);
    // A conversation is kept, as Claude Code's is (a fresh session starts without one).
    sink.saveSession({ sessionId: "fake-session" });
    sink.taken?.();
    this.seen.push(...(input.messageIds ?? []));
    if (input.prompt.includes("REFUSE")) return { ok: false, error: "API Error: the safety filter flagged this message." };
    // "ASK:": it asks a question and goes on without waiting (as Codex's request_user_input_async does).
    if (input.prompt.includes("ASK:")) sink.askLater?.("Ship it?", [{ id: "q", header: "", question: "Ship it?", options: [{ label: "Yes", description: "" }], multiSelect: false, allowOther: true }]);
    sink.text(`Answer to: ${input.prompt.slice(-40)}`);
    return { ok: true };
  }
  async rewind(messageId: string): Promise<string[]> {
    if (Agent.summarized) throw new Error("Claude Code can't go back to before that message, usually because it has summarized the conversation since.");
    if (!this.seen.includes(messageId)) throw new Error("This message can't be rewound to.");
    Agent.rewound.push(messageId);
    this.seen = this.seen.slice(0, this.seen.indexOf(messageId));
    return [messageId];
  }
  async interrupt() {}
  async dispose() {}
}

/**
 * Claude Code's conversation as the real driver keeps it: each input goes in with its own id, every message a turn
 * delivers (TurnInput.messageIds) rewinds to just before that turn's input, and a rewind cuts the conversation there.
 * `fail` turns take the message in and then fail; while `inApp` is set, it refuses before taking anything in.
 */
class Session implements AgentDriver {
  readonly provider = "claude" as const;
  static inputs: { uuid: string; prompt: string }[] = [];
  static refs = new Map<string, string>();
  static fail = 0;
  static inApp = false;
  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    if (Session.inApp) return { ok: false, error: "This conversation is open in the Claude app right now. Close it there, then tap Try again." };
    const uuid = crypto.randomUUID();
    Session.inputs.push({ uuid, prompt: input.prompt });
    for (const id of input.messageIds ?? []) Session.refs.set(id, uuid);
    sink.saveSession({ sessionId: "fake-session" });
    sink.taken?.();
    if (Session.fail > 0) {
      Session.fail--;
      sink.text("Started on it…");
      return { ok: false, error: "API Error: overloaded" };
    }
    sink.text(`Done: ${input.prompt.slice(-30)}`);
    return { ok: true };
  }
  async rewind(messageId: string): Promise<string[]> {
    const uuid = Session.refs.get(messageId);
    const at = Session.inputs.findIndex((x) => x.uuid === uuid);
    if (!uuid || at < 0) throw new Error("This message can't be rewound to.");
    Session.inputs = Session.inputs.slice(0, at);
    return [...Session.refs].filter(([, u]) => u === uuid).map(([id]) => id);
  }
  async interrupt() {}
  async dispose() {}
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ct-rewind-"));
  dirs.push(dir);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  registerDriver("claude", (c) => new Agent(c));
  Agent.rewound = [];
  Agent.inApp = false;
  Agent.prompts = [];
  Agent.summarized = false;
  const room = app.chats.create({ provider: "claude", name: "Side project", cwd: dir });
  const events: ServerEvent[] = [];
  app.bus.on((e: ServerEvent) => events.push(e));
  const say = async (text: string) => {
    const m = app.engine.postHumanMessage(room.id, text, "Phone");
    for (let i = 0; i < 100 && app.engine.isBusy(); i++) await Bun.sleep(10);
    await Bun.sleep(20);
    return m;
  };
  const messages = () => app.store.listMessages(room.id).map((m) => `${m.authorKind}:${m.status}:${m.text.slice(0, 30)}`);
  return { app, room, say, messages, events, done: async () => (await app.engine.shutdown(), app.store.close()) };
}

test("rewinding to a reply takes back everything after it, and the failed replies go with their messages", async () => {
  const t = setup();
  try {
    await t.say("Find the bug in the device check");
    await t.say("REFUSE: the request that tripped the filter");
    await t.say("REFUSE again, still reading the old one");
    expect(t.messages()).toHaveLength(6);
    const [, firstReply] = t.app.store.listMessages(t.room.id);
    const failed = t.app.store.listTurns(t.room.id).filter((x) => x.status === "error").map((x) => x.id);
    expect(failed).toHaveLength(2);

    const r = await t.app.rewindTo(firstReply.id, "Phone");
    expect(r.removed).toHaveLength(4);
    expect(t.app.store.listMembers(t.room.id)[0]).toMatchObject({ status: "idle", statusDetail: null });
    expect(t.messages()).toEqual(["human:done:Find the bug in the device che", "agent:done:Answer to: Find the bug in the"]);
    // The agent went back to just before the first message taken back.
    expect(Agent.rewound).toEqual([r.removed[0]]);
    // Their turns, and so their errors, are gone too: nothing is left to show.
    expect(t.app.store.listTurns(t.room.id).filter((x) => x.status === "error")).toEqual([]);
    expect(t.events.find((e) => e.t === "turns.removed")).toMatchObject({ t: "turns.removed", roomId: t.room.id, ids: expect.arrayContaining(failed) });

    // The chat carries on from there.
    await t.say("Now just check the USB detection");
    expect(t.messages().slice(-1)[0]).toStartWith("agent:done:Answer to:");
  } finally {
    await t.done();
  }
});

test("unsending a message the agent read takes its failed reply along (no error left behind)", async () => {
  const t = setup();
  try {
    await t.say("hello");
    const bad = await t.say("REFUSE this");
    expect(t.app.store.listTurns(t.room.id).some((x) => x.status === "error")).toBe(true);
    const r = await t.app.reviseMessage(bad.id, null, "Phone");
    expect(r.removed).toHaveLength(2);
    expect(t.app.store.listTurns(t.room.id).some((x) => x.status === "error")).toBe(false);
  } finally {
    await t.done();
  }
});

test("unsending the message whose reply asked a question without waiting takes that question's card back too", async () => {
  const t = setup();
  try {
    await t.say("hello");
    const asked = await t.say("ASK: should it ship?");
    const card = t.app.store.listPendingApprovals().find((a) => a.roomId === t.room.id);
    expect(card).toMatchObject({ delivery: "async", status: "pending" });
    await t.app.reviseMessage(asked.id, null, "Phone");
    // Closed for every device, then gone with its reply (turns.removed drops answered and closed cards).
    expect(t.events.some((e) => e.t === "approval" && e.approval.id === card!.id && e.approval.status === "expired")).toBe(true);
    expect(t.app.store.getApproval(card!.id)).toBeNull();
    expect(t.app.store.listPendingApprovals()).toEqual([]);
  } finally {
    await t.done();
  }
});

test("rewinding needs a reply with something after it, in a chat", async () => {
  const t = setup();
  try {
    const ask = await t.say("hello");
    const reply = t.app.store.listMessages(t.room.id)[1];
    await expect(t.app.rewindTo(reply.id, "Phone")).rejects.toThrow("Nothing after this reply to take back");
    await expect(t.app.rewindTo(ask.id, "Phone")).rejects.toThrow("unsend it");
    await expect(t.app.rewindTo("m_nope", "Phone")).rejects.toThrow("No such message");
    // A group chat goes back like any chat (here there's nothing after the note); a room that's no chat at all can't.
    const group = t.app.createRoom({ name: "Team", mode: "direct" });
    const sys = t.app.engine.systemMessage(group.id, "Crosstalk restarted.");
    await expect(t.app.rewindTo(sys.id, "Phone")).rejects.toThrow("Nothing after this reply to take back");
    const legacy = { id: "r_legacy", name: "Neither", cwd: t.room.cwd, mode: "direct" as const, leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1, updatedAt: 1, archived: false };
    t.app.store.insertRoom(legacy);
    const old = t.app.engine.systemMessage(legacy.id, "Crosstalk restarted.");
    await expect(t.app.rewindTo(old.id, "Phone")).rejects.toThrow("older rooms can't");
  } finally {
    await t.done();
  }
});

test("errors left by earlier unsends are cleared by the next rewind", async () => {
  const t = setup();
  try {
    await t.say("hello");
    await t.say("REFUSE one");
    // An older hub removed the messages but kept the failed turn.
    const orphan = t.app.store.listTurns(t.room.id).find((x) => x.status === "error")!;
    t.app.store.deleteMessage(orphan.replyMessageId!);
    expect(t.app.store.deleteTurnsWithoutReplies(t.room.id)).toEqual([orphan.id]);
    expect(t.app.store.deleteTurnsWithoutReplies(t.room.id)).toEqual([]);
  } finally {
    await t.done();
  }
});

test("a reply that fails before the agent takes the message in gives it back: Take back removes it without a rewind, Edit changes it and gets an answer, and the next message brings it along", async () => {
  const t = setup();
  try {
    await t.say("hello");
    const member = () => t.app.store.listMembers(t.room.id)[0];
    const seq = (id: string) => t.app.store.messageSeq(id);

    // Open in the Claude app: the reply fails, and the message is the user's again (the agent never read it).
    Agent.inApp = true;
    const login = await t.say("Fix the login page");
    expect(t.messages().slice(-1)[0]).toStartWith("agent:error:⚠️ This conversation is open");
    expect(member().readSeq).toBeLessThan(seq(login.id));
    // Take back: just removed, with its failed reply. No rewind (Claude Code would refuse one: it never had it).
    const back = await t.app.reviseMessage(login.id, null, "Phone");
    expect(back.removed).toHaveLength(2);
    expect(Agent.rewound).toEqual([]);
    expect(t.messages()).toEqual(["human:done:hello", "agent:done:Answer to: hello"]);
    expect(t.app.store.listTurns(t.room.id).some((x) => x.status === "error")).toBe(false);
    expect(member()).toMatchObject({ status: "idle" });

    // Edit: the message changes, and (the Claude app closed now) it's answered.
    const signup = await t.say("Fix the signup page");
    expect(member().readSeq).toBeLessThan(seq(signup.id));
    Agent.inApp = false;
    await t.app.reviseMessage(signup.id, "Fix the signup form", "Phone");
    for (let i = 0; i < 100 && t.app.engine.isBusy(); i++) await Bun.sleep(10);
    expect(Agent.rewound).toEqual([]);
    expect(Agent.prompts.at(-1)).toBe("Fix the signup form");
    const [failed, answer] = t.messages().slice(-2);
    expect(failed).toStartWith("agent:error:⚠️ This conversation is open");
    expect(answer).toBe("agent:done:Answer to: Fix the signup form");
    expect(t.app.store.getMessage(signup.id)?.text).toBe("Fix the signup form");

    // Not taken back or edited: the next message brings it along.
    Agent.inApp = true;
    await t.say("Check the dark mode colors");
    Agent.inApp = false;
    await t.say("and the contrast too");
    expect(Agent.prompts.at(-1)).toBe("Check the dark mode colors\n\nand the contrast too");
    expect(member().readSeq).toBe(t.app.store.maxSeq(t.room.id) - 1); // everything but its own reply, which came after
  } finally {
    await t.done();
  }
});

test("a change the app asked about once (the message wasn't read) is refused once the agent has read it", async () => {
  const t = setup();
  try {
    const route = (method: string) => buildRoutes(t.app).find((r) => r.method === method && r.pattern.test("/api/messages/m_x"))!;
    const call = (method: string, id: string, body: unknown) => {
      const url = new URL(`http://hub/api/messages/${id}`);
      return route(method).handler({ req: new Request(url.href, { method }), url, params: { id }, device: { id: "dev", name: "Phone" } as never, body: async () => body });
    };
    // Read by the agent: a one-step change would be a rewind, so it's refused, to be asked about twice.
    const read = await t.say("hello");
    await expect(call("PATCH", read.id, { text: "hi", ifUnread: true })).rejects.toThrow("has just read this message");
    await expect(call("DELETE", read.id, { ifUnread: true })).rejects.toThrow("has just read this message");
    expect(Agent.rewound).toEqual([]);
    expect(t.messages()).toHaveLength(2);
    // Given back (its reply failed before the agent got it): changed as asked.
    Agent.inApp = true;
    const unread = await t.say("Fix the login page");
    Agent.inApp = false;
    await call("PATCH", unread.id, { text: "Fix the login form", ifUnread: true });
    for (let i = 0; i < 100 && t.app.engine.isBusy(); i++) await Bun.sleep(10);
    expect(Agent.prompts.at(-1)).toBe("Fix the login form");
    expect(Agent.rewound).toEqual([]);
  } finally {
    await t.done();
  }
});

test("after Try again, taking the message back makes the agent forget the failed tries as well", async () => {
  const t = setup();
  registerDriver("claude", () => new Session());
  Session.inputs = [];
  Session.refs = new Map();
  Session.fail = 0;
  Session.inApp = false;
  const idle = async () => {
    for (let i = 0; i < 100 && t.app.engine.isBusy(); i++) await Bun.sleep(10);
    await Bun.sleep(20);
  };
  try {
    await t.say("Set up the project");
    // The first try takes the request in, starts on it, and fails.
    Session.fail = 1;
    const ask = await t.say("Migrate the prod DB");
    expect(t.messages().at(-1)).toStartWith("agent:error:Started on it");
    // Try again can't start (the Claude app has the conversation open); the next one works.
    Session.inApp = true;
    t.app.engine.retry(t.room.id);
    await idle();
    expect(t.app.store.listMembers(t.room.id)[0].readSeq).toBeGreaterThanOrEqual(t.app.store.messageSeq(ask.id));
    Session.inApp = false;
    t.app.engine.retry(t.room.id);
    await idle();
    expect(t.messages().at(-1)).toStartWith("agent:done:Done:");
    expect(Session.inputs).toHaveLength(3);
    // Take back: the agent goes back to before its first try at it, so that try's partial work goes too.
    const r = await t.app.reviseMessage(ask.id, null, "Phone");
    expect(r.removed).toHaveLength(4);
    expect(Session.inputs.map((x) => x.prompt)).toEqual(["Set up the project"]);
    expect(t.messages()).toEqual(["human:done:Set up the project", "agent:done:Done: Set up the project"]);
  } finally {
    await t.done();
  }
});

test("rewinding to a reply over messages the agent never got takes back all of them, with their failed replies", async () => {
  const t = setup();
  try {
    await t.say("Find the bug in the device check");
    // The next two never reach the agent (say the session is open in another app): each fails before it's taken in.
    const failing = (prompt: string) => prompt.includes("NEVER_GOT");
    registerDriver("claude", (c) => {
      const inner = new Agent(c);
      return { provider: "claude", runTurn: (input: TurnInput, sink: TurnSink) => (failing(input.prompt) ? Promise.resolve({ ok: false, error: "This conversation is open in the Claude app right now." }) : inner.runTurn(input, sink)), interrupt: async () => {}, dispose: async () => {}, rewind: (id: string) => inner.rewind(id) };
    });
    await t.app.engine.memberChanged(t.app.store.listMembers(t.room.id)[0].id);
    await t.say("NEVER_GOT one");
    await t.say("NEVER_GOT two");
    expect(t.messages()).toHaveLength(6);
    const [, firstReply] = t.app.store.listMessages(t.room.id);
    const r = await t.app.rewindTo(firstReply.id, "Phone");
    expect(r.removed).toHaveLength(4);
    expect(t.messages()).toEqual(["human:done:Find the bug in the device che", "agent:done:Answer to: Find the bug in the"]);
    expect(t.app.store.listTurns(t.room.id).filter((x) => x.status === "error")).toEqual([]);
  } finally {
    await t.done();
  }
});

test("an agent that can't go back (its conversation was summarized since) says how to unsend: start fresh, then it goes", async () => {
  const t = setup();
  try {
    await t.say("hello");
    const bad = await t.say("REFUSE this");
    Agent.summarized = true;
    const refused = await t.app.reviseMessage(bad.id, null, "Phone").then(() => null, (e) => e);
    expect(refused).toMatchObject({ status: 409, code: "rewind_failed" });
    expect(refused.message).toContain("summarized the conversation since");
    expect(refused.message).toContain("Start fresh to unsend it");
    // Nothing went: the message and its failed reply are still there.
    expect(t.messages()).toHaveLength(4);

    // Started fresh, it has nothing to forget: the message goes, with its failed reply, and the chat carries on.
    await t.app.engine.resetSession(t.app.store.listMembers(t.room.id)[0]!);
    const r = await t.app.reviseMessage(bad.id, null, "Phone");
    // The message, its failed reply, and the note after them that the agent starts fresh.
    expect(r.removed).toHaveLength(3);
    expect(t.messages()).toEqual(["human:done:hello", "agent:done:Answer to: hello"]);
    Agent.summarized = false;
    await t.say("carry on");
    expect(t.messages().slice(-1)[0]).toStartWith("agent:done:Answer to:");
  } finally {
    await t.done();
  }
});
