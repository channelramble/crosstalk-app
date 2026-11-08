// Group chats: two or more agents in one chat, each with its own account, model and effort. Who answers: whoever a
// message @mentions, else the lead, or everyone in turn (the lead first). Every agent here is a stand-in that records
// what it was given and goes back to before a message the way the real drivers do (by the rewind point each turn
// notes); no real CLI, databases in memory, folders in temp.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAccount, Member, Room, ServerEvent } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import type { EngineDeps } from "../src/engine/engine";
import { App } from "../src/app";
import { buildRoutes } from "../src/server";
import { agentsLabel } from "../src/duplicate";
import { exportMarkdown, searchChats } from "../src/search";

setDefaultTimeout(30_000);

const dirs: string[] = [];
// Claude Code's conversations would be looked for here (Duplicate looks for one to fork): never the real ones.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ct-group-claude-"));
dirs.push(process.env.CLAUDE_CONFIG_DIR);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Given {
  handle: string;
  prompt: string;
  systemNote: string | null;
  messageIds: string[];
  chat: DriverContext["chat"];
}

/**
 * An agent of the group: answers with what it was asked, fails on "FAIL @<its handle>" (after taking the message in,
 * as the real agents do), waits while its handle is in `hold`, and goes back to before the turn that brought a message.
 * Like the real drivers, only Claude Code and Codex say when they have the message (sink.taken) and can go back: an
 * agent of another kind (a room's Gemini) does neither.
 */
class Agent implements AgentDriver {
  readonly provider;
  private turns: string[] = [];
  private refs: Map<string, string>;
  constructor(
    private ctx: DriverContext,
    private h: Harness,
  ) {
    this.provider = ctx.member.provider;
    this.refs = new Map(Object.entries((ctx.session.msgRefs as Record<string, string> | undefined) ?? {}));
  }
  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    const handle = this.ctx.member.handle;
    this.h.given.push({ handle, prompt: input.prompt, systemNote: input.systemNote, messageIds: input.messageIds ?? [], chat: this.ctx.chat });
    const id = crypto.randomUUID();
    this.turns.push(id);
    for (const m of input.messageIds ?? []) this.refs.set(m, id);
    // A conversation of its own, as the real agents note it (a Claude Code session, a Codex thread).
    sink.saveSession({ ...(this.provider === "claude" ? { sessionId: `s-${handle}` } : { threadId: `th-${handle}` }), msgRefs: Object.fromEntries(this.refs) });
    if (this.provider === "claude" || this.provider === "codex") sink.taken?.();
    await this.h.during?.(this.ctx.member, input);
    while (this.h.hold.has(handle) && !sink.signal.aborted) await Bun.sleep(5);
    if (sink.signal.aborted) return { ok: false, error: "stopped" };
    if (input.prompt.includes(`FAIL @${handle}`)) return { ok: false, error: "API Error: overloaded" };
    sink.text(`${handle} answers ${lastAsk(input.prompt)}`);
    sink.usage({ inputTokens: 100, outputTokens: 10, costUsd: null });
    return { ok: true };
  }
  async rewind(messageId: string): Promise<string[]> {
    const id = this.refs.get(messageId);
    if (!id || !this.turns.includes(id)) throw new Error("This message can't be rewound to.");
    this.h.rewound.push(`${this.ctx.member.handle}:${messageId}`);
    this.turns = this.turns.slice(0, this.turns.indexOf(id));
    return [...this.refs].filter(([, t]) => t === id).map(([m]) => m);
  }
  async interrupt() {}
  async dispose() {}
}

/** The newest human line of a group prompt ("[Human · Phone]\n<text>"), for a stand-in's answer. */
function lastAsk(prompt: string): string {
  const said = [...prompt.matchAll(/\[Human · [^\]]+\]\n([^\n]+)/g)].map((m) => m[1]);
  return said.length ? `"${said[said.length - 1]}"` : "nothing new";
}

interface Harness {
  app: App;
  dir: string;
  given: Given[];
  rewound: string[];
  hold: Set<string>;
  /** Called in every agent's turn, once it has the message: what an agent does meanwhile (asks for helpers, say). */
  during?: (member: Member, input: TurnInput) => Promise<unknown> | unknown;
  events: ServerEvent[];
  say(room: Room, text: string): Promise<void>;
  idle(): Promise<void>;
  replies(room: Room): string[];
  done(): Promise<void>;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ct-group-"));
  dirs.push(dir);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
  const h: Harness = {
    app,
    dir,
    given: [],
    rewound: [],
    hold: new Set(),
    events: [],
    async say(room, text) {
      app.engine.postHumanMessage(room.id, text, "Phone");
      await h.idle();
    },
    async idle() {
      await Bun.sleep(5);
      await app.engine.whenIdle();
    },
    replies: (room) => app.store.listMessages(room.id).filter((m) => m.authorKind === "agent").map((m) => `${m.authorName}: ${m.text}`),
    async done() {
      h.hold.clear();
      await app.engine.shutdown();
      app.store.close();
    },
  };
  const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
  deps.createDriver = (ctx) => {
    const agent = new Agent(ctx, h);
    // Only Claude Code's and Codex's drivers can go back to before a message.
    return ctx.member.provider === "claude" || ctx.member.provider === "codex" ? agent : Object.assign(agent, { rewind: undefined });
  };
  deps.agentEnv = () => ({});
  deps.resolveBin = () => "";
  deps.endpointFor = () => null;
  deps.turnNotice = () => null;
  app.storage.check = async () => {};
  app.bus.on((e) => h.events.push(e));
  return h;
}

/** A group of Claude Code (the lead) and Codex unless said otherwise. */
function group(h: Harness, more: Record<string, unknown> = {}): Room {
  return h.app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: h.dir, ...more });
}

const byHandle = (h: Harness, room: Room) => Object.fromEntries(h.app.store.listMembers(room.id).map((m) => [m.handle, m])) as Record<string, Member>;

describe("starting a group chat", () => {
  test("each agent runs on its own account, model and effort; the lead and who answers are kept", async () => {
    const h = harness();
    try {
      h.app.setDefaults({ agent: { codex: { permissionMode: "edits", model: "gpt-default", effort: "low" } } });
      const room = h.app.chats.createGroup({
        name: "Checkout",
        members: [
          { provider: "claude", model: "claude-opus-5-5", effort: "high", permissionMode: "ask" },
          { provider: "codex" },
          { provider: "claude", model: "claude-sonnet-4-6", effort: "low", handle: "Second opinion" },
        ],
        answers: "turns",
        lead: 1,
      });
      const members = h.app.store.listMembers(room.id);
      expect(room).toMatchObject({ name: "Checkout", mode: "roundrobin", leadMemberId: members[1].id, chat: { provider: "codex", origin: "web", group: true } });
      expect(existsSync(room.cwd)).toBe(true);
      expect(members.map((m) => [m.handle, m.provider, m.model, m.config.effort ?? null, m.permissionMode])).toEqual([
        ["claude", "claude", "claude-opus-5-5", "high", "ask"],
        // Nothing picked: Settings → Defaults for that agent.
        ["codex", "codex", "gpt-default", "low", "edits"],
        ["second-opinion", "claude", "claude-sonnet-4-6", "low", "ask"],
      ]);
      // It's in the chat list like any chat, with its agents.
      expect(h.events.filter((e) => e.t === "room").map((e) => (e as { room: Room }).room.id)).toContain(room.id);
      expect(h.events.filter((e) => e.t === "member").length).toBe(3);
      // Two of a kind get their own names.
      const twins = group(h, { members: [{ provider: "claude" }, { provider: "claude" }] });
      expect(h.app.store.listMembers(twins.id).map((m) => m.handle)).toEqual(["claude", "claude-2"]);
      expect(twins).toMatchObject({ name: "New chat", mode: "direct" });
    } finally {
      await h.done();
    }
  });

  test("an agent on another account is named after it, and a request that can't be met says why", async () => {
    const h = harness();
    try {
      const work: AgentAccount = { provider: "codex", id: "work", label: "Work Codex", kind: "apikey", workspaceId: null, endpoint: null, signedIn: true, account: null, plan: null, authMethod: "apikey", error: null, checkedAt: 0 };
      const accounts = h.app.providers.accounts.bind(h.app.providers);
      h.app.providers.accounts = () => [...accounts(), work];
      h.app.providers.hasAccount = (p, id) => id === "default" || (p === "codex" && id === "work");
      const room = group(h, { members: [{ provider: "claude" }, { provider: "codex", account: "work" }] });
      expect(h.app.store.listMembers(room.id).map((m) => [m.handle, m.config.account ?? "default"])).toEqual([["claude", "default"], ["work-codex", "work"]]);
      // One added later is named the same way.
      expect(h.app.addMember(room.id, { provider: "codex", config: { account: "work" } }).handle).toBe("work-codex-2");
      expect(h.app.addMember(room.id, { provider: "claude", handle: "All" }).handle).toBe("all-agent");
      const refused = (body: unknown) => {
        try {
          h.app.chats.createGroup(body);
        } catch (e) {
          return (e as Error).message;
        }
        return "accepted";
      };
      expect(refused({ members: [{ provider: "claude" }] })).toBe("Pick at least 2 agents for a group chat");
      expect(refused({ members: Array.from({ length: 7 }, () => ({ provider: "codex" })) })).toBe("A group chat has at most 6 agents");
      expect(refused({ members: [{ provider: "claude" }, { provider: "gemini" }] })).toBe("Chats are with Claude Code or Codex");
      expect(refused({ members: [{ provider: "claude" }, { provider: "codex", account: "nope" }] })).toBe("That account doesn't exist for this agent");
      expect(refused({ members: [{ provider: "claude" }, { provider: "codex" }], lead: 2 })).toBe("The lead must be one of the agents");
      expect(refused({ members: [{ provider: "claude" }, { provider: "codex" }], answers: "random" })).toBe("Say who answers: the lead, or everyone in turn");
      expect(refused({ members: [{ provider: "claude", effort: 3 }, { provider: "codex" }] })).toBe("bad effort");
    } finally {
      await h.done();
    }
  });

  test("POST /api/chats/group starts one; a chat with one agent never takes a second", async () => {
    const h = harness();
    try {
      const routes = buildRoutes(h.app);
      const call = async (method: string, path: string, body: unknown) => {
        const r = routes.find((x) => x.method === method && x.pattern.test(path))!;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, path.match(r.pattern)![i + 1]]));
        return r.handler({ req: new Request("http://hub"), url: new URL(`http://hub${path}`), params, device: { id: "d", name: "Phone", platform: "", createdAt: 0, lastSeenAt: null }, body: async () => body });
      };
      const room = (await call("POST", "/api/chats/group", { members: [{ provider: "claude" }, { provider: "codex" }], answers: "lead", cwd: h.dir })) as Room;
      expect(room.chat).toEqual({ provider: "claude", origin: "web", group: true });
      // More agents join a group chat; a chat with one agent stays one.
      const added = (await call("POST", `/api/rooms/${room.id}/members`, { provider: "codex", handle: "reviewer" })) as Member;
      expect(added.handle).toBe("reviewer");
      expect(h.app.store.listMessages(room.id).at(-1)?.text).toBe("@reviewer (Codex) joined the chat.");
      const chat = h.app.chats.create({ provider: "claude", cwd: h.dir });
      expect(() => h.app.addMember(chat.id, { provider: "codex" })).toThrow("Start a group chat to have several.");
      // The lead is one of its agents.
      expect(() => h.app.updateRoom(room.id, { leadMemberId: h.app.store.listMembers(chat.id)[0].id })).toThrow("The lead must be one of this chat's agents");
      // A room made the older way is a group chat too, everyone in turn included.
      const old = h.app.createRoom({ name: "Old way", cwd: h.dir, mode: "direct" });
      expect(old.chat).toEqual({ provider: "claude", origin: "web", group: true });
      expect(h.app.createRoom({ name: "In turn", cwd: h.dir, mode: "roundrobin" }).mode).toBe("roundrobin");
      expect(h.app.createRoom({ name: "Relay", cwd: h.dir, mode: "relay" }).mode).toBe("direct");
    } finally {
      await h.done();
    }
  });
});

describe("who answers", () => {
  test("with no @mention the lead answers; an @mention means only who it names; everyone reads the whole chat", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      await h.say(room, "Plan the checkout");
      expect(h.given.map((g) => g.handle)).toEqual(["claude"]);
      const first = h.given[0];
      // A group chat's agent is briefed on who's here and how turns work, and gets the chat labelled.
      expect(first.systemNote).toContain("You are @claude, one of several AI coding agents working together in a group chat");
      expect(first.systemNote).toContain("Who answers: the human's messages go to @claude, the lead, unless they @mention someone");
      expect(first.prompt).toContain("[Human · Phone]\nPlan the checkout");
      expect(first.chat).toEqual({ helper: null, fork: false, notes: null, group: true });
      const ask = h.app.store.listMessages(room.id)[0];
      expect(first.messageIds).toEqual([ask.id]);

      await h.say(room, "@codex review the plan");
      expect(h.given.map((g) => g.handle)).toEqual(["claude", "codex"]);
      // Codex reads the whole chat: your message, Claude Code's reply, then what's asked of it.
      expect(h.given[1].prompt).toContain("[Human · Phone]\nPlan the checkout");
      expect(h.given[1].prompt).toContain(`[@claude (Claude Code)]\nclaude answers "Plan the checkout"`);
      expect(h.given[1].prompt).toContain("The human mentioned you in the latest message.");
      expect(h.app.store.listMessages(room.id).at(-2)?.mentions).toEqual([m.codex.id]);

      // The lead changes: the next message without a mention goes to it.
      h.app.updateRoom(room.id, { leadMemberId: m.codex.id });
      await h.say(room, "Go ahead");
      expect(h.given.map((g) => g.handle)).toEqual(["claude", "codex", "codex"]);
      expect(h.app.store.getRoom(room.id)?.chat?.provider).toBe("codex");
    } finally {
      await h.done();
    }
  });

  test("everyone in turn: the lead first, then the others, each reading what the ones before said", async () => {
    const h = harness();
    try {
      const room = group(h, { members: [{ provider: "claude" }, { provider: "codex" }, { provider: "claude" }], answers: "turns", lead: 1 });
      await h.say(room, "Ideas for the name?");
      expect(h.given.map((g) => g.handle)).toEqual(["codex", "claude", "claude-2"]);
      expect(h.given[0].prompt).toContain("Everyone in this chat answers the human's latest message, in turn: @codex, then @claude, then @claude-2.");
      expect(h.given[2].prompt).toContain(`[@codex (Codex)]\ncodex answers "Ideas for the name?"`);
      expect(h.given[2].prompt).toContain(`[@claude (Claude Code)]\nclaude answers "Ideas for the name?"`);
      expect(h.given[1].systemNote).toContain("everyone answers in turn: @codex, then @claude, then @claude-2");
      // An @mention still means only who it names.
      await h.say(room, "@claude-2 pick one");
      expect(h.given.slice(3).map((g) => g.handle)).toEqual(["claude-2"]);
      // @all in a chat where the lead answers: everyone, the lead first.
      h.app.updateRoom(room.id, { mode: "direct" });
      await h.say(room, "@all thanks");
      expect(h.given.slice(4).map((g) => g.handle)).toEqual(["codex", "claude", "claude-2"]);
    } finally {
      await h.done();
    }
  });

  test("an agent changes its helpers' model at once only when you asked it, not when you asked another agent", async () => {
    const h = harness();
    try {
      const model = (id: string, label: string, isDefault = false) => ({ id, label, description: null, efforts: [], defaultEffort: null, isDefault });
      h.app.providers.models = async (provider) => ({ provider, models: [model("opus", "Opus 5.5", true), model("haiku", "Haiku 4.5")], live: true, error: null });
      const room = group(h);
      const m = byHandle(h, room);
      const answers: string[] = [];
      h.during = async (member, input) => {
        if (member.handle === "claude" && input.prompt.includes("Haiku") && !input.prompt.includes("Helper agents now run")) answers.push(await h.app.useHelperModel(member.id, "haiku"));
      };
      await h.say(room, "@codex, use Haiku for your helper agents");
      // The next message is the lead's: what you told Codex isn't Claude Code's to act on, so it asks first.
      h.app.engine.postHumanMessage(room.id, "Plan the work", "Phone");
      let card: { id: string; title: string } | undefined;
      for (let i = 0; i < 100 && !card; i++) {
        await Bun.sleep(10);
        card = h.app.store.listPendingApprovals().find((a) => a.roomId === room.id);
      }
      expect(card?.title).toBe("Run helper agents on Haiku 4.5?");
      h.app.engine.decideApproval(card!.id, "deny", "Phone");
      await h.idle();
      expect(answers).toEqual(["The user said no: helper agents stay on Opus 5.5."]);
      expect(h.app.store.getMember(m.claude.id)!.config.helperModel).toBeUndefined();
      // Asked of it: done at once.
      await h.say(room, "@claude, use Haiku for your helper agents");
      expect(answers[1]).toStartWith("Done: helper agents run on Haiku 4.5");
      expect(h.app.store.getMember(m.claude.id)!.config.helperModel).toBe("haiku");
    } finally {
      await h.done();
    }
  });

  test("a message from another chat's agent can't come into a group chat", async () => {
    const h = harness();
    try {
      const room = group(h);
      const via = { hubId: "h", machine: "Mac", chatId: "r_other", chatName: "Other", agent: "Codex", hop: 1, kind: "message" as const };
      expect(() => h.app.engine.postRelayMessage(room.id, "hello", via, "Codex · Mac")).toThrow("Only chats with one agent take messages from other chats");
      h.app.setHubSettings({ agentsAcrossChats: true });
      expect(() => h.app.xchat.post({ hubId: "h", machine: "Mac" }, room.id, { text: "hi", requestId: "1" })).toThrow("is a group chat: agents can read it but not message it.");
      expect(h.app.xchat.summary(h.app.store.getRoom(room.id)!)).toMatchObject({ kind: "room", agent: "Claude Code, Codex", provider: null });
    } finally {
      await h.done();
    }
  });
});

describe("Try again, Answer now and Send now in a group chat", () => {
  test("Try again under a failed reply goes to that agent; Answer now to whoever your message is for", async () => {
    const h = harness();
    try {
      const room = group(h, { answers: "turns" });
      const m = byHandle(h, room);
      await h.say(room, "`FAIL @codex` start the build");
      expect(h.app.store.listTurns(room.id).map((t) => [t.memberId === m.claude.id ? "claude" : "codex", t.status])).toEqual([["claude", "done"], ["codex", "error"]]);
      // Codex took the message in before it failed: Try again gives it the message once more, as in a chat with one agent.
      h.app.engine.retry(room.id, m.codex.id);
      await h.idle();
      const last = h.given.at(-1)!;
      expect(last.handle).toBe("codex");
      expect(last.prompt).toContain("Your last reply ended with an error, and the user asked you to try again.");
      // Nothing failed, nothing unread: nothing to try again.
      expect(() => h.app.engine.retry(room.id, m.claude.id)).toThrow("A later reply already answered this.");

      // "Stop everything" left a message nobody read (it waited behind Claude Code's reply): Answer now sends it to who
      // it's for.
      h.hold.add("claude");
      h.app.engine.postHumanMessage(room.id, "@claude one more thing", "Phone");
      await Bun.sleep(30);
      h.app.engine.postHumanMessage(room.id, "@codex and this", "Phone");
      await h.app.engine.stop(room.id);
      h.hold.delete("claude");
      await h.idle();
      const before = h.given.length;
      h.app.engine.retry(room.id);
      await h.idle();
      expect(h.given.slice(before).map((g) => g.handle)).toEqual(["codex"]);
    } finally {
      await h.done();
    }
  });

  test("Try again under an agent's failed reply, after you wrote to another agent, tries its own request again", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      await h.say(room, "@codex `FAIL @codex` build X");
      await h.say(room, "@claude write the docs");
      const [build] = h.app.store.listMessages(room.id);
      expect(h.given.map((g) => g.handle)).toEqual(["codex", "claude"]);
      // Codex failed after it had the request; Claude Code answered its own since. Try again is Codex's request again
      // (never Claude Code's message), with the note to carry on.
      const turn = h.app.engine.retry(room.id, m.codex.id);
      expect(turn.triggerMessageId).toBe(build.id);
      await h.idle();
      const again = h.given.at(-1)!;
      expect(again.handle).toBe("codex");
      expect(again.prompt).toContain("[Human · Phone]\n@codex `FAIL @codex` build X");
      expect(again.prompt).toContain("Your last reply ended with an error, and the user asked you to try again.");
      // Answer now: your newest message was answered, so the reply that failed is tried again.
      const answer = h.app.engine.retry(room.id);
      expect([answer.memberId, answer.triggerMessageId]).toEqual([m.codex.id, build.id]);
      await h.idle();
    } finally {
      await h.done();
    }
  });

  test("an agent that can't say when it has your message keeps it read when its reply fails", async () => {
    const h = harness();
    try {
      const room = group(h);
      const gem = h.app.addMember(room.id, { provider: "gemini", handle: "gem" });
      await h.say(room, "@gem `FAIL @gem` delete the old build folder and rebuild");
      const ask = h.app.store.listMessages(room.id).find((x) => x.text.startsWith("@gem"))!;
      // It may have done some of it: the message isn't given back as unread to be asked afresh (and done twice).
      expect(h.app.store.getLastSeen(gem.id).seq).toBeGreaterThanOrEqual(h.app.store.messageSeq(ask.id));
      h.app.engine.retry(room.id, gem.id);
      await h.idle();
      const again = h.given.at(-1)!;
      expect(again.handle).toBe("gem");
      expect(again.prompt).toContain("Your last reply ended with an error, and the user asked you to try again.");
    } finally {
      await h.done();
    }
  });

  test("with parallel work, Send now and Read it now go into the reply of the agent whose line they're on", async () => {
    const h = harness();
    try {
      const room = group(h);
      h.app.updateRoom(room.id, { parallel: true });
      const m = byHandle(h, room);
      const steered: string[] = [];
      const read: string[] = [];
      const deps = (h.app.engine as unknown as { deps: EngineDeps }).deps;
      const make = deps.createDriver;
      deps.createDriver = (ctx) => Object.assign(make(ctx), { steer: async (text: string) => (steered.push(`${ctx.member.handle}: ${text}`), true), readNow: async () => (read.push(ctx.member.handle), true) });
      h.hold.add("claude");
      h.hold.add("codex");
      h.app.engine.postHumanMessage(room.id, "@claude start the API", "Phone");
      h.app.engine.postHumanMessage(room.id, "@codex start the tests", "Phone");
      await Bun.sleep(30);
      expect(h.app.engine.runningTurns(room.id).map((t) => t.memberId).sort()).toEqual([m.claude.id, m.codex.id].sort());
      // Both have a message of yours waiting. The app says whose line was tapped.
      h.app.engine.postHumanMessage(room.id, "@claude and the docs", "Phone");
      h.app.engine.postHumanMessage(room.id, "@codex and the fixtures", "Phone");
      const routes = buildRoutes(h.app);
      const post = (path: string, body: unknown) => {
        const r = routes.find((x) => x.method === "POST" && x.pattern.test(path))!;
        return r.handler({ req: new Request("http://hub"), url: new URL(`http://hub${path}`), params: { id: room.id }, device: { id: "d", name: "Phone", platform: "", createdAt: 0, lastSeenAt: null }, body: async () => body });
      };
      expect(await post(`/api/rooms/${room.id}/send-now`, { memberId: m.codex.id })).toEqual({ sent: true });
      expect(steered).toEqual(["codex: [Human · Phone]\n@claude and the docs\n(For @claude, not you: they answer it in their own turn.)\n\n[Human · Phone]\n@codex and the fixtures"]);
      expect(await post(`/api/rooms/${room.id}/read-now`, { memberId: m.claude.id })).toEqual({ reading: false });
      expect(await post(`/api/rooms/${room.id}/read-now`, { memberId: m.codex.id })).toEqual({ reading: true });
      expect(read).toEqual(["codex"]);
      // Claude Code's own waiting turn is still there.
      expect(h.app.engine.queuedTurns(room.id).map((t) => t.memberId)).toEqual([m.claude.id]);
      h.hold.clear();
      await h.idle();
    } finally {
      await h.done();
    }
  });

  test("Send now hands your waiting message to the reply that's running when it's for that agent", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      const steered: string[] = [];
      const deps = (h.app.engine as unknown as { deps: EngineDeps }).deps;
      const make = deps.createDriver;
      deps.createDriver = (ctx) => Object.assign(make(ctx), { steer: async (text: string) => (steered.push(`${ctx.member.handle}: ${text}`), true) });
      h.hold.add("claude");
      h.app.engine.postHumanMessage(room.id, "Start on it", "Phone");
      await Bun.sleep(30);
      // A message for Codex waits for Codex's turn: there's nothing to hand to Claude Code.
      h.app.engine.postHumanMessage(room.id, "@codex look at the tests", "Phone");
      expect(await h.app.engine.sendNow(room.id)).toBe(false);
      // One for the lead goes into its reply (with what came before it that it hasn't read).
      h.app.engine.postHumanMessage(room.id, "Also the docs", "Phone");
      expect(await h.app.engine.sendNow(room.id)).toBe(true);
      // Labelled as in its turns: the one for Codex says so, so Claude Code doesn't take it on too.
      expect(steered).toEqual(["claude: [Human · Phone]\n@codex look at the tests\n(For @codex, not you: they answer it in their own turn.)\n\n[Human · Phone]\nAlso the docs"]);
      expect(h.app.engine.queuedTurns(room.id).map((t) => t.memberId)).toEqual([m.codex.id]);
      h.hold.delete("claude");
      await h.idle();
      expect(h.given.map((g) => g.handle)).toEqual(["claude", "codex"]);
    } finally {
      await h.done();
    }
  });
});

describe("going back in a group chat", () => {
  test("unsending a message every agent read takes each back to before it, and only the chat after it goes", async () => {
    const h = harness();
    try {
      const room = group(h);
      await h.say(room, "First, the plan");
      await h.say(room, "@codex check the plan");
      await h.say(room, "Then build it");
      const [plan, , check, , build] = h.app.store.listMessages(room.id);
      expect(h.replies(room)).toEqual(['claude: claude answers "First, the plan"', 'codex: codex answers "@codex check the plan"', 'claude: claude answers "Then build it"']);

      // Both read "check the plan": each goes back, and the chat keeps "First, the plan" and Claude Code's reply.
      const r = await h.app.reviseMessage(check.id, null, "Phone");
      expect(h.rewound.sort()).toEqual([`claude:${check.id}`, `codex:${check.id}`].sort());
      expect(r.removed).toContain(build.id);
      expect(h.app.store.listMessages(room.id).map((x) => x.text)).toEqual(["First, the plan", 'claude answers "First, the plan"']);
      // Codex's turn had brought it your first message and Claude Code's reply too: it reads those again next time.
      await h.say(room, "@codex now?");
      const again = h.given.at(-1)!;
      expect(again.handle).toBe("codex");
      expect(again.prompt).toContain("[Human · Phone]\nFirst, the plan");
      expect(again.prompt).toContain(`[@claude (Claude Code)]\nclaude answers "First, the plan"`);
      expect(again.messageIds).toEqual([plan.id, h.app.store.listMessages(room.id).at(-2)!.id]);
    } finally {
      await h.done();
    }
  });

  test("editing a message only the lead read rewinds the lead alone; one nobody read is just changed", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      await h.say(room, "Write the README");
      const [ask] = h.app.store.listMessages(room.id);
      const { sent } = await h.app.reviseMessage(ask.id, "@codex write the README", "Phone");
      await h.idle();
      expect(h.rewound).toEqual([`claude:${ask.id}`]);
      // The edit goes where it says now.
      expect(sent?.mentions).toEqual([m.codex.id]);
      expect(h.given.map((g) => g.handle)).toEqual(["claude", "codex"]);

      // Waiting behind a reply that's running, nobody has read it: changed in place, for whoever it names now.
      h.hold.add("codex");
      h.app.engine.postHumanMessage(room.id, "@codex and the docs", "Phone");
      await Bun.sleep(30);
      const waiting = h.app.engine.postHumanMessage(room.id, "@codex also tests", "Phone");
      const edited = await h.app.reviseMessage(waiting.id, "@codex also the changelog", "Phone");
      expect(edited.removed).toEqual([]);
      expect(h.app.store.getMessage(waiting.id)?.text).toBe("@codex also the changelog");
      h.hold.delete("codex");
      await h.idle();
      // A reply still running stops it from going back: it says who to stop.
      h.hold.add("claude");
      h.app.engine.postHumanMessage(room.id, "Long job", "Phone");
      await Bun.sleep(30);
      await expect(h.app.reviseMessage(sent!.id, null, "Phone")).rejects.toThrow("@claude is working. Stop it first, then edit or unsend this message.");
    } finally {
      await h.done();
    }
  });

  test("editing a waiting message to name another agent moves it to that agent", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      h.hold.add("claude");
      h.app.engine.postHumanMessage(room.id, "Start the build", "Phone");
      await Bun.sleep(30);
      const waiting = h.app.engine.postHumanMessage(room.id, "@codex check the tests", "Phone");
      expect(h.app.engine.queuedTurns(room.id).map((t) => t.memberId)).toEqual([m.codex.id]);
      await h.app.reviseMessage(waiting.id, "@claude check the tests instead", "Phone");
      // Codex isn't asked any more; Claude Code answers it once the reply it's on ends.
      expect(h.app.engine.queuedTurns(room.id).map((t) => t.memberId)).toEqual([m.claude.id]);
      h.hold.delete("claude");
      await h.idle();
      expect(h.given.map((g) => g.handle)).toEqual(["claude", "claude"]);
      expect(h.given[1].prompt).toContain("check the tests instead");
    } finally {
      await h.done();
    }
  });

  test("unsending a message nobody read yet drops only the turn that was going to answer it", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      h.hold.add("claude");
      h.app.engine.postHumanMessage(room.id, "Start the build", "Phone");
      await Bun.sleep(30);
      const waiting = h.app.engine.postHumanMessage(room.id, "@codex check the tests", "Phone");
      expect(h.app.engine.queuedTurns(room.id).map((t) => t.memberId)).toEqual([m.codex.id]);
      const r = await h.app.reviseMessage(waiting.id, null, "Phone");
      expect(r.removed).toEqual([waiting.id]);
      expect(h.app.engine.queuedTurns(room.id)).toEqual([]);
      // Claude Code's reply goes on, and Codex was never asked.
      expect(h.app.engine.runningTurns(room.id).map((t) => t.memberId)).toEqual([m.claude.id]);
      h.hold.delete("claude");
      await h.idle();
      expect(h.given.map((g) => g.handle)).toEqual(["claude"]);
    } finally {
      await h.done();
    }
  });

  test("an agent of a kind that can't go back says to start it fresh; then the others go back", async () => {
    const h = harness();
    try {
      const room = group(h, { answers: "turns" });
      const gem = h.app.addMember(room.id, { provider: "gemini", handle: "gem" });
      await h.say(room, "Hello all");
      const hello = h.app.store.listMessages(room.id).find((x) => x.text === "Hello all")!;
      expect(h.given.map((g) => g.handle)).toEqual(["claude", "codex", "gem"]);
      await expect(h.app.reviseMessage(hello.id, null, "Phone")).rejects.toThrow("@gem can't go back to an earlier message. Start a fresh session for @gem in the chat's settings, then try again.");
      expect(h.rewound).toEqual([]);
      await h.app.engine.resetSession(h.app.store.getMember(gem.id)!);
      const r = await h.app.reviseMessage(hello.id, null, "Phone");
      expect(r.removed).toContain(hello.id);
      expect(h.rewound.sort()).toEqual([`claude:${hello.id}`, `codex:${hello.id}`].sort());
    } finally {
      await h.done();
    }
  });

  test("an agent that goes back reads again only what it forgot, however long ago its last reply was", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      await h.say(room, "@codex first job: rename the module");
      // 520 messages between you and the lead since.
      const at = Date.now();
      for (let i = 0; i < 260; i++) {
        const base = { roomId: room.id, mentions: [], turnId: null, status: "done" as const, createdAt: at + i, updatedAt: at + i };
        h.app.store.insertMessage({ ...base, id: `m_step${i}`, authorKind: "human", memberId: null, authorName: "Phone", text: `Step ${i}` });
        h.app.store.insertMessage({ ...base, id: `m_done${i}`, authorKind: "agent", memberId: m.claude.id, authorName: "claude", text: `Step ${i} done` });
      }
      await h.say(room, "@codex what now?");
      const now = h.app.store.listMessages(room.id).find((x) => x.text === "@codex what now?")!;
      // A reply still being written when it last read stays owed to it.
      const seen = h.app.store.getLastSeen(m.codex.id);
      const owed = h.app.store.messageSeq("m_done3");
      h.app.store.setLastSeen(m.codex.id, seen.seq, seen.rosterVersion, [owed]);
      await h.app.reviseMessage(now.id, "@codex what's next?", "Phone");
      await h.idle();
      expect(h.rewound).toEqual([`codex:${now.id}`]);
      const again = h.given.at(-1)!;
      expect(again.handle).toBe("codex");
      // It still remembers the first job: it isn't handed it again as new.
      expect(again.prompt).not.toContain("first job: rename the module");
      expect(again.prompt).toContain("[Human · Phone]\n@codex what's next?");
      expect(again.prompt).toContain("Step 3 done");
    } finally {
      await h.done();
    }
  });

  test("an agent that read a message before the chat could go back says what to do", async () => {
    const h = harness();
    try {
      const room = group(h);
      const m = byHandle(h, room);
      await h.say(room, "Hello");
      const [hello] = h.app.store.listMessages(room.id);
      // As if read in the room the chat was before (no rewind point for it).
      h.app.store.setMemberSession(m.claude.id, { standIn: "claude", msgRefs: {} });
      await expect(h.app.reviseMessage(hello.id, null, "Phone")).rejects.toThrow("Start a fresh session for @claude in the chat's settings, then try again.");
      // After Start fresh it has nothing to forget.
      await h.app.engine.resetSession(h.app.store.getMember(m.claude.id)!);
      const r = await h.app.reviseMessage(hello.id, null, "Phone");
      expect(r.removed).toContain(hello.id);
      expect(h.rewound).toEqual([]);
    } finally {
      await h.done();
    }
  });
});

describe("a group chat's copies, exports and searches", () => {
  test("Duplicate copies it with the same agents, each with its own conversation to go on from", async () => {
    const h = harness();
    try {
      const room = group(h, { name: "Release", answers: "turns", lead: 1 });
      await h.say(room, "Ship it?");
      const { duplicateChat } = await import("../src/duplicate");
      const copy = await duplicateChat(h.app, room.id, { group: true, folder: "new", name: "Release (copy)" });
      const members = h.app.store.listMembers(copy.id);
      expect(copy).toMatchObject({ name: "Release (copy)", mode: "roundrobin", leadMemberId: members[1].id, chat: { group: true } });
      expect(members.map((x) => [x.handle, x.provider])).toEqual([["claude", "claude"], ["codex", "codex"]]);
      // The replies stay their own agents'.
      expect(h.app.store.listMessages(copy.id).map((x) => [x.authorKind, x.memberId ? members.find((y) => y.id === x.memberId)?.handle : null, x.text])).toEqual([
        ["system", null, 'Copied from "Release" (Claude Code and Codex)'],
        ["human", null, "Ship it?"],
        ["agent", "codex", 'codex answers "Ship it?"'],
        ["agent", "claude", 'claude answers "Ship it?"'],
      ]);
      // Codex forks its own thread; Claude Code's session isn't on this machine (a stand-in's), so it reads the
      // conversation with its first message instead, after its briefing.
      const session = (handle: string) => h.app.store.getMemberSession<Record<string, unknown>>(members.find((x) => x.handle === handle)!.id);
      expect(session("codex")).toMatchObject({ forkFrom: "th-codex" });
      expect(session("claude").handoff).toBeString();
      await h.say(copy, "Go on");
      const [codex, claude] = h.given.slice(-2);
      expect([codex.handle, claude.handle]).toEqual(["codex", "claude"]);
      expect(codex.systemNote).not.toContain("the user duplicated the chat");
      expect(claude.systemNote).toStartWith("You are @claude");
      expect(claude.systemNote).toContain('the user duplicated the chat "Release" (Claude Code and Codex)');
      expect(claude.systemNote).toContain('[Codex (@codex)]\ncodex answers "Ship it?"');
      expect(h.app.store.listMessages(room.id).at(-1)?.text).toBe('Duplicated to "Release (copy)"');
      expect(agentsLabel(h.app, h.app.store.listMembers(room.id))).toBe("Claude Code and Codex");
    } finally {
      await h.done();
    }
  });

  test("in a copy each agent has read what it had: one behind and one that never spoke read the rest there", async () => {
    const h = harness();
    try {
      const room = group(h, { members: [{ provider: "claude" }, { provider: "codex" }, { provider: "codex", handle: "quiet" }] });
      await h.say(room, "@codex hello");
      await h.say(room, "The deploy key is in kv/alpha");
      await h.say(room, "use blue-green");
      expect(h.given.map((g) => g.handle)).toEqual(["codex", "claude", "claude"]);
      const { duplicateChat } = await import("../src/duplicate");
      const copy = await duplicateChat(h.app, room.id, { group: true, folder: "new", name: "Copy" });
      // Codex forks its own thread (it remembers "hello") and reads what the lead was told since, as it would in the
      // original.
      await h.say(copy, "@codex which strategy?");
      const codex = h.given.at(-1)!;
      expect(codex.handle).toBe("codex");
      expect(codex.prompt).not.toContain("@codex hello");
      expect(codex.prompt).toContain("[Human · Phone]\nThe deploy key is in kv/alpha");
      expect(codex.prompt).toContain(`[@claude (Claude Code)]\nclaude answers "use blue-green"`);
      // One that never spoke reads the whole chat on its first turn, as in the original.
      await h.say(copy, "@quiet anything to add?");
      const quiet = h.given.at(-1)!;
      expect(quiet.handle).toBe("quiet");
      expect(quiet.prompt).toContain("[Human · Phone]\n@codex hello");
      expect(quiet.prompt).toContain("[Human · Phone]\nuse blue-green");
    } finally {
      await h.done();
    }
  });

  test("a copy with one agent reads everyone's replies; Markdown export and search name who wrote each", async () => {
    const h = harness();
    try {
      const room = group(h, { name: "Payments", answers: "turns" });
      await h.say(room, "Find the swordfish bug");
      const { duplicateChat } = await import("../src/duplicate");
      const solo = await duplicateChat(h.app, room.id, { provider: "claude", account: "default", model: null, effort: null, helperModel: null, folder: "new", name: "Solo" });
      expect(solo.chat?.group).toBeUndefined();
      const note = String(h.app.store.getMemberSession(h.app.chats.member(solo.id)!.id).handoff);
      expect(note).toContain('[Codex (@codex)]\ncodex answers "Find the swordfish bug"');

      const md = (await exportMarkdown(h.app, room.id, new Date(2026, 9, 28))).markdown;
      expect(md).toContain("# Payments\n\n@claude, @codex · Exported 2026-10-28");
      expect(md).toContain('**Codex (@codex):**\n\ncodex answers "Find the swordfish bug"');
      const found = searchChats(h.app, "swordfish");
      expect(found.results.filter((x) => x.roomId === room.id).map((x) => [x.who, x.agent ?? null])).toEqual([
        ["agent", "@codex"],
        ["agent", "@claude"],
        ["you", null],
      ]);
    } finally {
      await h.done();
    }
  });

  test("Ask others in a group chat offers who isn't in it", async () => {
    const h = harness();
    try {
      const signin = (provider: "claude" | "codex"): AgentAccount => ({ provider, id: "default", label: "Main", kind: "signin", workspaceId: null, endpoint: null, signedIn: true, account: "me@example.com", plan: "Max", authMethod: "oauth", error: null, checkedAt: 0 });
      h.app.providers.accounts = () => [signin("claude"), signin("codex")];
      h.app.providers.which = () => "/bin/true";
      h.app.providers.models = async (provider) => ({ provider, models: [{ id: `${provider}-model`, label: `${provider} model`, description: null, efforts: [], defaultEffort: null, isDefault: true }], live: true, error: null });
      // Both of the group's agents are Claude Code on the main sign-in, on its default model: only Codex is someone else.
      const room = group(h, { members: [{ provider: "claude" }, { provider: "claude" }] });
      expect((await h.app.asks.targets(room.id)).map((c) => c.target.provider)).toEqual(["codex"]);
      const both = group(h);
      expect(await h.app.asks.targets(both.id)).toEqual([]);
    } finally {
      await h.done();
    }
  });
});
