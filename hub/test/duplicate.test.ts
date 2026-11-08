import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatExport, CopiedMessage, Member, Message, Room } from "@crosstalk/shared";
import { App } from "../src/app";
import { registerDriver } from "../src/agents";
import { ClaudeDriver, claudeSupports } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { copiedMessages, duplicateChat, exportChat, handoffBudget, handoffNote, markDuplicated, receiveDuplicate } from "../src/duplicate";
import { claudeProjectDirName, claudeTranscriptPath, listClaudeSessions } from "../src/local-sessions";
import { newId } from "../src/util/ids";

const FIX = join(import.meta.dir, "fixtures");
const SRC = "44444444-4444-4444-4444-444444444444";
const FORK = "99999999-8888-7777-6666-555555555555";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  // Back to what providers/all.ts registers.
  registerDriver("claude", (ctx) => {
    if (!ctx.bin) throw new Error("Claude Code isn't installed on the hub. Install it under Agents & sign-ins.");
    return new ClaudeDriver(ctx, ctx.bin);
  });
  registerDriver("codex", (ctx) => {
    if (!ctx.bin) throw new Error("Codex isn't installed on the hub. Install it under Agents & sign-ins.");
    return new CodexDriver(ctx, ctx.bin);
  });
});

/**
 * A hub whose Claude Code and Codex are the fixtures, with a Claude home and Codex home of its own: nothing here can
 * reach the real agents, their sign-ins or the Codex app's server.
 */
function hub(opts: { workspaceRoot?: string; name?: string } = {}) {
  const claudeHome = temp("ct-dup-claude-");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = join(temp("ct-dup-codex-"), "codex-home");
  const work = opts.workspaceRoot ?? temp("ct-dup-work-");
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
  app.providers.which = (p) => (p === "claude" ? join(FIX, "fake-claude") : p === "codex" ? join(FIX, "fake-codex-app") : null);
  if (opts.name) app.setHubSettings({ machineName: opts.name });
  const projects = join(claudeHome, "projects");
  let at = Date.parse("2026-10-24T10:00:00Z");
  /** A chat with a finished conversation, written the way the engine writes it. */
  const chat = (provider: "claude" | "codex", name: string, said: [string, string][], cwd = temp("ct-dup-src-")) => {
    const room = app.chats.create({ provider, name, cwd, model: provider === "claude" ? "opus" : "gpt-test", effort: "high", permissionMode: "edits" });
    const member = app.chats.member(room.id)!;
    for (const [q, a] of said) {
      insert(room.id, { authorKind: "human", memberId: null, authorName: "iPhone", text: q, status: "done", createdAt: (at += 60_000) });
      insert(room.id, { authorKind: "agent", memberId: member.id, authorName: member.handle, text: a, status: "done", createdAt: (at += 60_000) });
    }
    app.store.setLastSeen(member.id, app.store.maxSeq(room.id), 0);
    return { room, member };
  };
  const insert = (roomId: string, m: Pick<Message, "authorKind" | "memberId" | "authorName" | "text" | "status" | "createdAt"> & Partial<Message>) => {
    const msg: Message = { id: newId("m"), roomId, mentions: [], turnId: null, updatedAt: m.createdAt, via: null, ...m };
    app.store.insertMessage(msg);
    return msg;
  };
  /** The Claude Code transcript of a chat's session, in its folder's project directory (with the entry ids a fork ends at). */
  const transcript = (room: Room, member: Member, id = SRC) => {
    const dir = join(projects, claudeProjectDirName(realpathSync(room.cwd)));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    const lines = [
      { type: "user", uuid: "u-1", parentUuid: null, cwd: realpathSync(room.cwd), sessionId: id, message: { role: "user", content: "Fix the login bug" } },
      { type: "assistant", uuid: "a-1", parentUuid: "u-1", sessionId: id, message: { content: [{ type: "text", text: "Fixed it." }] } },
      { type: "summary", summary: "Login fix", leafUuid: "a-1" },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l) + "\n").join(""));
    app.store.setMemberSession(member.id, { sessionId: id });
    // The chat has read all of it (afterTurn does this after each turn).
    app.store.setChatSync(room.id, { claudeSession: id, claudeOffset: statSync(path).size });
    return path;
  };
  const texts = (roomId: string) => app.store.listMessages(roomId, { limit: 500 }).map((m) => `${m.authorKind}:${m.memberId ? "member" : m.authorName}:${m.text}`);
  const idle = async () => {
    for (let i = 0; i < 400 && app.engine.isBusy(); i++) await Bun.sleep(10);
    await Bun.sleep(30);
  };
  return { app, work, projects, chat, insert, transcript, texts, idle, close: async () => (await app.engine.shutdown(), app.store.close()) };
}

const req = (o: Record<string, unknown> = {}) => ({ provider: "claude", account: "default", model: "opus", effort: "high", helperModel: null, folder: "same", name: "", ...o });

describe("what a duplicate brings along", () => {
  const m = (authorKind: Message["authorKind"], text: string, status: Message["status"] = "done", extra: Partial<Message> = {}): Message => ({ id: newId("m"), roomId: "r", authorKind, memberId: authorKind === "agent" ? "mb" : null, authorName: authorKind === "human" ? "iPhone" : authorKind === "agent" ? "claude" : "Crosstalk", text, mentions: [], turnId: null, status, createdAt: 1, updatedAt: 1, ...extra });
  const who = () => ({ agent: "Claude Code", provider: "claude" as const });

  test("the user's messages and finished replies, up to the last finished reply; no notes, failures or unanswered messages", () => {
    const out = copiedMessages(
      [
        m("system", "Crosstalk restarted."),
        m("human", "Fix the login bug"),
        m("agent", "⚠️ Claude Code exited", "error"),
        m("human", "Try again"),
        m("agent", "Half a repl", "stopped"),
        m("agent", "", "done"),
        m("agent", "Fixed it.", "done"),
        m("human", "And the signup page?"),
        m("agent", "Looking at sig", "streaming"),
      ],
      who,
    );
    expect(out.map((c) => `${c.role}:${c.text}${c.stopped ? " (stopped)" : ""}`)).toEqual(["user:Fix the login bug", "user:Try again", "agent:Half a repl (stopped)", "agent:Fixed it."]);
    expect(out[3]).toMatchObject({ agent: "Claude Code", provider: "claude", authorName: "claude" });
    expect(copiedMessages([m("human", "Hello"), m("agent", "⚠️ Not signed in", "error")], who)).toEqual([]);
  });

  test("replies a chat copied from another agent keep that agent's name; messages from other chats keep where they came from", () => {
    const via = { hubId: "h1", machine: "Mac mini", chatId: "r_other", chatName: "Release", agent: "Codex", hop: 1, kind: "message" as const };
    const out = copiedMessages([m("human", "Review this", "done", { via }), m("agent", "Looks good.", "done", { memberId: null, copy: { kind: "reply", agent: "Codex", provider: "codex" } }), m("agent", "Shipped.")], who);
    expect(out.map((c) => [c.role, c.agent ?? null, c.via?.chatName ?? null])).toEqual([["user", null, "Release"], ["agent", "Codex", null], ["agent", "Claude Code", null]]);
  });
});

describe("the handoff note", () => {
  const msgs = (n: number, size = 20): CopiedMessage[] =>
    Array.from({ length: n }, (_, i) => (i % 2 ? { role: "agent", authorName: "claude", agent: "Claude Code", provider: "claude", text: `Reply ${i} ${"r".repeat(size)}`, createdAt: i } : { role: "user", authorName: "iPhone", text: `Question ${i} ${"q".repeat(size)}`, createdAt: i }));
  const from = { name: "Fix login", agent: "Claude Code", machine: null, cwd: "/work/app" };

  test("the conversation so far, labelled by who wrote it, with where it worked", () => {
    const via = { hubId: "h", machine: "Mac mini", chatId: "r1", chatName: "Release", agent: "Codex", hop: 1, kind: "message" as const };
    const note = handoffNote(from, "/work/app", [...msgs(2), { role: "user", authorName: "Codex · Mac mini", text: "Can you check the build?", createdAt: 3, via }]);
    expect(note.startsWith('(Note from Crosstalk: the user duplicated the chat "Fix login" (Claude Code) to go on with it here, with you.')).toBe(true);
    expect(note).toContain("without the tool steps.");
    expect(note).not.toContain("left out");
    expect(note).toContain("It worked in this same folder, /work/app.");
    expect(note).toContain(`[The user]\nQuestion 0 ${"q".repeat(20)}`);
    expect(note).toContain(`[Claude Code]\nReply 1 ${"r".repeat(20)}`);
    expect(note).toContain(`[Codex in the chat "Release", another chat's agent (not the user)]\nCan you check the build?`);
    expect(handoffNote(from, "/work/new", msgs(2))).toContain("It worked in /work/app; this chat works in /work/new, a new empty folder.");
    expect(handoffNote({ ...from, machine: "Mac mini" }, "/home/me/new", msgs(2))).toContain("It was on Mac mini, in /work/app: its files aren't on this machine");
  });

  test("trimmed to fit: the newest kept, saying how many earlier messages were left out; a long one keeps its start and end", () => {
    const note = handoffNote(from, "/work/app", msgs(100, 200), 5_000);
    expect(note.length).toBeLessThanOrEqual(5_600);
    expect(note).toContain("Reply 99");
    expect(note).not.toContain("Question 0 ");
    const kept = (note.match(/^\[(The user|Claude Code)\]$/gm) ?? []).length;
    expect(note).toContain(`${100 - kept} earlier messages were left out to fit.`);
    // Some never came over from another machine either.
    expect(handoffNote(from, "/work/app", msgs(100, 200), 5_000, 7)).toContain(`${107 - kept} earlier messages were left out to fit.`);
    const long = handoffNote(from, "/work/app", [{ role: "agent", authorName: "claude", agent: "Claude Code", text: `START${"x".repeat(50_000)}END`, createdAt: 1 }], 10_000);
    expect(long).toContain("START");
    expect(long).toContain("END");
    expect(long).toMatch(/\[… [\d,]+ characters left out …\]/);
    expect(long.length).toBeLessThan(4_000);
  });

  test("a custom model's context size bounds it", () => {
    const h = hub();
    try {
      const ep = h.app.providers.setEndpointAccount("codex", { label: "Qwen local", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b"], contextWindow: 8192 });
      expect(handoffBudget(h.app, "codex", ep.id)).toBe(8192);
      expect(handoffBudget(h.app, "codex", "default")).toBe(100_000);
    } finally {
      void h.close();
    }
  });
});

describe("duplicating a chat on this machine", () => {
  test("same agent and account: a fork of Claude Code's session, the messages as its own, and a line at each end", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."], ["Add a test", "Added login.test.ts."]]);
      h.app.store.updateMember(src.member.id, { config: { ...src.member.config, fast: true, ultracode: true, helperModel: "sonnet" } });
      h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req({ model: "opus", effort: "max", helperModel: "haiku" }));
      expect(copy.name).toBe("Fix login (copy)");
      expect(copy.cwd).toBe(src.room.cwd);
      const m = h.app.chats.member(copy.id)!;
      // Exactly what the popup showed; what the original may do and its chat settings come along.
      expect([m.provider, m.model, m.config.effort, m.config.helperModel, m.permissionMode, m.config.fast, m.config.ultracode, m.config.forkNext]).toEqual(["claude", "opus", "max", "haiku", "edits", true, true, true]);
      // Its first process forks the original's session where it ends now (the summary line isn't an entry).
      expect(h.app.store.getMemberSession<Record<string, unknown>>(m.id)).toEqual({ sessionId: SRC, forkDone: false, forkAt: "a-1" });
      expect(h.app.chats.context(copy, m).fork).toBe(true);
      expect(h.texts(copy.id)).toEqual([
        'system:Crosstalk:Copied from "Fix login" (Claude Code)',
        "human:iPhone:Fix the login bug",
        "agent:member:Fixed it.",
        "human:iPhone:Add a test",
        "agent:member:Added login.test.ts.",
      ]);
      const [top, first] = h.app.store.listMessages(copy.id, { limit: 500 });
      expect(top.copy).toEqual({ kind: "from", agent: "Claude Code", provider: "claude", chatId: src.room.id, chatName: "Fix login" });
      // The app shows messages in time order: the line stays at the top.
      expect(top.createdAt).toBeLessThan(first.createdAt);
      // Its agent has read them all (a fork remembers them).
      expect(h.app.store.getLastSeen(m.id).seq).toBe(h.app.store.maxSeq(copy.id));
      const line = h.app.store.listMessages(src.room.id, { limit: 1 })[0];
      expect([line.authorKind, line.text, line.copy]).toEqual(["system", 'Duplicated to "Fix login (copy)"', { kind: "to", agent: "Claude Code", provider: "claude", chatId: copy.id, chatName: "Fix login (copy)" }]);
      // The session is still the original's chat; the copy brings nothing in from it.
      const local = await h.app.chats.localSessions("claude");
      expect(local.find((s) => s.id === SRC)?.chatId).toBe(src.room.id);
      expect(await h.app.chats.sync(copy.id)).toBe(0);
    } finally {
      await h.close();
    }
  });

  test("Claude Code forks on the copy's first reply, ending where it was duplicated, then continues the copy", async () => {
    const h = hub();
    const args = join(temp("ct-dup-args-"), "args.jsonl");
    registerDriver("claude", (ctx) => new ClaudeDriver({ ...ctx, env: { ...ctx.env, FAKE_CLAUDE_ARGS_OUT: args, FAKE_CLAUDE_PROJECTS: h.projects } }, join(FIX, "fake-claude")));
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      const path = h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req());
      // The original goes on meanwhile: the copy doesn't get what's said there after it was made.
      writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify({ type: "user", uuid: "u-2", parentUuid: "a-1", sessionId: SRC, message: { role: "user", content: "Later, in the original" } }) + "\n");
      h.app.engine.postHumanMessage(copy.id, "Now the signup page", "iPhone");
      await h.idle();
      const runs = readFileSync(args, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
      expect(runs[0][runs[0].indexOf("--resume") + 1]).toBe(SRC);
      expect(runs[0]).toContain("--fork-session");
      expect(runs[0][runs[0].indexOf("--resume-session-at") + 1]).toBe("a-1");
      const m = h.app.chats.member(copy.id)!;
      expect(h.app.store.getMemberSession(m.id)).toMatchObject({ sessionId: FORK, forkDone: true });
      const forked = readFileSync(join(h.projects, claudeProjectDirName(realpathSync(src.room.cwd)), `${FORK}.jsonl`), "utf8");
      expect(forked).toContain("Fix the login bug");
      expect(forked).not.toContain("Later, in the original");
      // The next process continues the copy, never the original.
      await h.app.engine.memberChanged(m.id);
      h.app.engine.postHumanMessage(copy.id, "And the tests", "iPhone");
      await h.idle();
      const again = readFileSync(args, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).at(-1)!;
      expect(again[again.indexOf("--resume") + 1]).toBe(FORK);
      expect(again).not.toContain("--fork-session");
      expect(h.texts(copy.id).slice(-2)).toEqual(["human:iPhone:And the tests", "agent:member:Looking at the files.\n\nDone. @codex please review."]);
    } finally {
      await h.close();
    }
  });

  test("a new folder: the transcript goes to that folder's project directory first, and is removed once forked", async () => {
    // A workspace path that isn't its real path (macOS's /var → /private/var): Claude Code names the folder by the real one.
    const root = mkdtempSync(join(tmpdir(), "ct-dup-ws-"));
    dirs.push(root);
    const h = hub({ workspaceRoot: root });
    const args = join(temp("ct-dup-args-"), "args.jsonl");
    registerDriver("claude", (ctx) => new ClaudeDriver({ ...ctx, env: { ...ctx.env, FAKE_CLAUDE_ARGS_OUT: args, FAKE_CLAUDE_PROJECTS: h.projects } }, join(FIX, "fake-claude")));
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      const original = h.transcript(src.room, src.member);
      const before = readFileSync(original, "utf8");
      const copy = await duplicateChat(h.app, src.room.id, req({ folder: "new", name: "Login, take two" }));
      expect(copy.cwd).not.toBe(src.room.cwd);
      expect(copy.cwd.startsWith(root)).toBe(true);
      expect(readdirSync(copy.cwd)).toEqual([]);
      const m = h.app.chats.member(copy.id)!;
      const copies = h.app.store.getMemberSession<{ forkCopies: { path: string }[] }>(m.id).forkCopies.map((c) => c.path);
      const real = join(h.projects, claudeProjectDirName(realpathSync(copy.cwd)), `${SRC}.jsonl`);
      expect(copies).toContain(real);
      expect(readFileSync(real, "utf8")).toBe(before);
      // While it's there, the session is still found in (and listed from) its own folder.
      expect(claudeTranscriptPath(SRC)).toBe(original);
      expect(listClaudeSessions({ projectsDir: h.projects }).filter((s) => s.id === SRC)).toHaveLength(1);
      h.app.engine.postHumanMessage(copy.id, "Go on here", "iPhone");
      await h.idle();
      // The fake finds the session only in the copy's folder: the turn worked, and forked there.
      expect(h.texts(copy.id).at(-1)).toContain("Done.");
      const run = JSON.parse(readFileSync(args, "utf8").trim().split("\n")[0]) as string[];
      expect(run[run.indexOf("--resume") + 1]).toBe(SRC);
      expect(existsSync(join(h.projects, claudeProjectDirName(realpathSync(copy.cwd)), `${FORK}.jsonl`))).toBe(true);
      for (const p of copies) expect(existsSync(p)).toBe(false);
      expect(h.app.store.getMemberSession(m.id).forkCopies).toBeUndefined();
      expect(readFileSync(original, "utf8")).toBe(before);
    } finally {
      await h.close();
    }
  });

  test("deleting a copy before it forked removes its transcript copy, never the original", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      const original = h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req({ folder: "new" }));
      const copies = h.app.store.getMemberSession<{ forkCopies: { path: string }[] }>(h.app.chats.member(copy.id)!.id).forkCopies.map((c) => c.path);
      expect(copies.length).toBeGreaterThan(0);
      await h.app.deleteRoom(copy.id);
      for (const p of copies) expect(existsSync(p)).toBe(false);
      expect(existsSync(original)).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("Codex: the copy's thread is a thread/fork of the original's, through its last turn, on the model the copy shows", async () => {
    const h = hub();
    const forks = join(temp("ct-dup-fork-"), "forks.jsonl");
    const rpc = join(temp("ct-dup-rpc-"), "rpc.jsonl");
    // The original's thread was left on high effort, which a fork keeps unless told otherwise.
    registerDriver("codex", (ctx) => new CodexDriver({ ...ctx, env: { ...ctx.env, CODEX_HOME: process.env.CODEX_HOME!, FAKE_CODEX_FORK_LOG: forks, FAKE_CODEX_RPC_LOG: rpc, FAKE_CODEX_FORK_EFFORT: "high" } }, join(FIX, "fake-codex-app")));
    try {
      const src = h.chat("codex", "Release script", [["Write the release script", "Wrote release.sh."]]);
      h.app.store.setMemberSession(src.member.id, { threadId: "th-src", lastTurn: "tu-src-2" });
      // Default model: the copy runs on Codex's default now, not on whatever the original used.
      const copy = await duplicateChat(h.app, src.room.id, req({ provider: "codex", model: null, effort: null, folder: "new" }));
      const m = h.app.chats.member(copy.id)!;
      expect(h.app.store.getMemberSession<Record<string, unknown>>(m.id)).toEqual({ forkFrom: "th-src", forkAt: "tu-src-2" });
      expect([m.model, m.config.effort, m.config.forkNext]).toEqual([null, undefined, undefined]);
      expect(h.texts(copy.id)).toEqual(['system:Crosstalk:Copied from "Release script" (Codex)', "human:iPhone:Write the release script", "agent:member:Wrote release.sh."]);
      h.app.engine.postHumanMessage(copy.id, "Add a dry run", "iPhone");
      await h.idle();
      const params = JSON.parse(readFileSync(forks, "utf8").trim().split("\n")[0]);
      expect(params).toMatchObject({ threadId: "th-src", lastTurnId: "tu-src-2", cwd: copy.cwd, model: "gpt-test", sandbox: "workspace-write" });
      // "Default" effort is the model's default, as the popup showed it: set on the first turn, then the thread keeps it.
      expect(h.app.store.getMemberSession(m.id)).toMatchObject({ threadId: "th-fork", forkFrom: null, model: "gpt-test", effort: "medium" });
      expect(h.texts(copy.id).at(-1)).toBe("agent:member:Done.");
      h.app.engine.postHumanMessage(copy.id, "And a changelog", "iPhone");
      await h.idle();
      const turns = readFileSync(rpc, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.method === "turn/start");
      expect(turns.map((t) => [t.params.threadId, t.params.effort ?? null])).toEqual([["th-fork", "medium"], ["th-fork", null]]);
    } finally {
      await h.close();
    }
  });

  test("an older Claude Code without --resume-session-at still forks the copy (the whole session)", async () => {
    const h = hub();
    const dir = temp("ct-dup-old-");
    const args = join(dir, "args.jsonl");
    // An "older" CLI: rejects the option the way Commander does, otherwise behaves like the fake.
    const old = join(dir, "old-claude");
    writeFileSync(old, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--resume-session-at" ] && { echo "error: unknown option '--resume-session-at'" >&2; exit 1; }; done\nexec "${join(FIX, "fake-claude")}" "$@"\n`);
    chmodSync(old, 0o755);
    registerDriver("claude", (ctx) => new ClaudeDriver({ ...ctx, env: { ...ctx.env, FAKE_CLAUDE_ARGS_OUT: args } }, old));
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req());
      h.app.engine.postHumanMessage(copy.id, "Go on", "iPhone");
      await h.idle();
      expect(h.texts(copy.id).at(-1)).toContain("Done.");
      const run = JSON.parse(readFileSync(args, "utf8").trim().split("\n")[0]) as string[];
      expect(run).toContain("--fork-session");
      expect(run).not.toContain("--resume-session-at");
      expect(h.app.store.getMemberSession(h.app.chats.member(copy.id)!.id)).toMatchObject({ sessionId: FORK, forkDone: true });
    } finally {
      claudeSupports.resumeAt = true; // what this "older" Claude Code taught the driver
      await h.close();
    }
  });

  test("Codex: a fork point that's gone (the original was rewound) forks the whole thread instead", async () => {
    const h = hub();
    const forks = join(temp("ct-dup-fork-"), "forks.jsonl");
    registerDriver("codex", (ctx) => new CodexDriver({ ...ctx, env: { ...ctx.env, CODEX_HOME: process.env.CODEX_HOME!, FAKE_CODEX_FORK_LOG: forks, FAKE_CODEX_NO_TURN: "tu-gone" } }, join(FIX, "fake-codex-app")));
    try {
      const src = h.chat("codex", "Release script", [["Write the release script", "Wrote release.sh."]]);
      h.app.store.setMemberSession(src.member.id, { threadId: "th-src", lastTurn: "tu-gone" });
      const copy = await duplicateChat(h.app, src.room.id, req({ provider: "codex", model: "gpt-test", effort: "high" }));
      h.app.engine.postHumanMessage(copy.id, "Add a dry run", "iPhone");
      await h.idle();
      const calls = readFileSync(forks, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(calls.map((c) => c.lastTurnId ?? null)).toEqual(["tu-gone", null]);
      expect(h.texts(copy.id).at(-1)).toBe("agent:member:Done.");
    } finally {
      await h.close();
    }
  });
});

/** Stands in for an agent: records what each turn was given, answers, and rewinds to before a message it was given. */
class Recorder implements AgentDriver {
  static inputs: TurnInput[] = [];
  readonly provider: "claude" | "codex";
  private seen: string[] = [];
  constructor(private ctx: DriverContext) {
    this.provider = ctx.member.provider as "claude" | "codex";
  }
  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    Recorder.inputs.push(input);
    this.seen.push(...(input.messageIds ?? []));
    sink.saveSession({ threadId: "th-rec" });
    sink.text(`Answer to: ${input.prompt}`);
    return { ok: true };
  }
  async rewind(messageId: string): Promise<string[]> {
    this.seen = this.seen.slice(0, this.seen.indexOf(messageId));
    return [messageId];
  }
  async interrupt() {}
  async dispose() {}
}

describe("a handoff to another agent, account or custom model", () => {
  test("Claude Code to Codex: replies keep Claude Code's name, and Codex's first turn gets the conversation, once", async () => {
    const h = hub();
    registerDriver("codex", (ctx) => new Recorder(ctx));
    Recorder.inputs = [];
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."], ["Add a test", "Added login.test.ts."]]);
      h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req({ provider: "codex", model: "gpt-test", effort: "high", name: "Login on Codex" }));
      const m = h.app.chats.member(copy.id)!;
      // Codex starts from its own defaults for what it may do, like any new chat with it.
      expect([m.provider, m.model, m.config.effort, m.permissionMode, m.config.forkNext]).toEqual(["codex", "gpt-test", "high", "ask", undefined]);
      expect(h.texts(copy.id)).toEqual([
        'system:Crosstalk:Copied from "Fix login" (Claude Code)',
        "human:iPhone:Fix the login bug",
        "agent:claude:Fixed it.",
        "human:iPhone:Add a test",
        "agent:claude:Added login.test.ts.",
      ]);
      expect(h.app.store.listMessages(copy.id, { limit: 500 })[2].copy).toEqual({ kind: "reply", agent: "Claude Code", provider: "claude" });
      const note = h.app.store.getMemberSession<{ handoff: string }>(m.id).handoff;
      expect(note).toContain('the user duplicated the chat "Fix login" (Claude Code)');
      expect(note).toContain("[Claude Code]\nAdded login.test.ts.");
      expect(h.texts(src.room.id).at(-1)).toBe('system:Crosstalk:Duplicated to "Login on Codex"');

      const first = h.app.engine.postHumanMessage(copy.id, "Carry on", "iPhone");
      await h.idle();
      expect(Recorder.inputs.map((i) => [i.prompt, i.systemNote])).toEqual([["Carry on", note]]);
      expect(h.app.store.getMemberSession(m.id).handoffWith).toEqual([first.id]);
      h.app.engine.postHumanMessage(copy.id, "Next", "iPhone");
      await h.idle();
      expect(Recorder.inputs[1].systemNote).toBeNull();
      // Rewinding past the turn that brought it: the next turn brings it again.
      await h.app.reviseMessage(first.id, "Carry on, please", "iPhone");
      await h.idle();
      expect(Recorder.inputs.at(-1)).toMatchObject({ prompt: "Carry on, please", systemNote: note });
    } finally {
      await h.close();
    }
  });

  test("a custom model gets a note that fits its context, saying how much was left out", async () => {
    const h = hub();
    try {
      const ep = h.app.providers.setEndpointAccount("claude", { label: "Qwen local", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b"], contextWindow: 8192 });
      const said = Array.from({ length: 40 }, (_, i) => [`Question ${i} ${"q".repeat(300)}`, `Answer ${i} ${"a".repeat(300)}`] as [string, string]);
      const src = h.chat("claude", "Long chat", said);
      h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req({ account: ep.id, model: null, effort: null }));
      const m = h.app.chats.member(copy.id)!;
      expect(m.config.account).toBe(ep.id);
      // Another account: no fork, even of the same kind of agent.
      expect(m.config.forkNext).toBeUndefined();
      const note = h.app.store.getMemberSession<{ handoff: string }>(m.id).handoff;
      expect(note.length).toBeLessThanOrEqual(8192 + 600);
      expect(note).toContain(`Answer 39 ${"a".repeat(300)}`);
      expect(note).toMatch(/ \d+ earlier messages were left out to fit\./);
      // The copied replies are still Claude Code's, not the custom model's.
      const all = h.app.store.listMessages(copy.id, { limit: 500 });
      expect(all).toHaveLength(81);
      expect(all[0].copy?.kind).toBe("from");
      expect(all[2].copy).toEqual({ kind: "reply", agent: "Claude Code", provider: "claude" });
      expect(all[1].copy).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  test("not while the agent is working, not to an agent that isn't signed in, and never without a model choice", async () => {
    const h = hub();
    registerDriver("claude", (ctx) => new (class extends Recorder {
      override async runTurn(input: TurnInput, sink: TurnSink) {
        await Bun.sleep(300);
        return super.runTurn(input, sink);
      }
    })(ctx));
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      h.app.engine.postHumanMessage(src.room.id, "One more thing", "iPhone");
      await expect(duplicateChat(h.app, src.room.id, req())).rejects.toThrow("Claude Code is working. Wait for it to finish, or stop it, then duplicate this chat.");
      await h.idle();
      await expect(duplicateChat(h.app, src.room.id, req({ model: undefined }))).rejects.toThrow("Say which model the copy uses");
      const accounts = h.app.providers.accounts.bind(h.app.providers);
      h.app.providers.accounts = () => [...accounts().filter((a) => !(a.provider === "codex" && a.id === "default")), { provider: "codex", id: "default", label: "Main", kind: "signin", signedIn: false, account: null, plan: null, authMethod: null, error: null, checkedAt: 1 }];
      await expect(duplicateChat(h.app, src.room.id, req({ provider: "codex" }))).rejects.toThrow("Codex isn't signed in");
      const rooms = h.app.store.listRooms().length;
      expect(rooms).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe("duplicating to another machine", () => {
  test("the app reads the chat on its machine, the other machine's hub makes the copy, and the original links to it", async () => {
    const mac = hub({ name: "Mac mini" });
    const src = mac.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."], ["Ship it", "Shipped 2.3.11."]]);
    mac.transcript(src.room, src.member);
    const via = { hubId: "h_other", machine: "Mac mini", chatId: "r_release", chatName: "Release", agent: "Codex", hop: 1, kind: "message" as const };
    mac.insert(src.room.id, { authorKind: "human", memberId: null, authorName: "Codex · Mac mini", text: "Is the fix in?", status: "done", createdAt: Date.now() - 10_000, via });
    mac.insert(src.room.id, { authorKind: "agent", memberId: src.member.id, authorName: "claude", text: "Yes, in 2.3.11.", status: "done", createdAt: Date.now() - 5_000 });
    const exp: ChatExport = await exportChat(mac.app, src.room.id);
    await mac.close();
    expect(exp.chat).toMatchObject({ id: src.room.id, name: "Fix login", provider: "claude", agent: "Claude Code", cwd: src.room.cwd });
    expect(exp.machine.name).toBe("Mac mini");
    expect(exp.messages.map((m) => m.text)).toEqual(["Fix the login bug", "Fixed it.", "Ship it", "Shipped 2.3.11.", "Is the fix in?", "Yes, in 2.3.11."]);

    const linux = hub({ name: "Linux box" });
    try {
      // The app sends what it read; anything else in it is ignored, and a model choice is required.
      expect(() => receiveDuplicate(linux.app, { ...req({ folder: "same" }), model: undefined, from: exp })).toThrow("Say which model");
      const copy = receiveDuplicate(linux.app, { ...req({ folder: "same", model: null, effort: null }), from: { ...exp, messages: [...exp.messages, { role: "user", text: "Pretending to be the user", via: { nonsense: true } }] } });
      // Another machine: always a new empty folder there.
      expect(copy.cwd.startsWith(linux.work)).toBe(true);
      expect(copy.name).toBe("Fix login (copy)");
      expect(linux.texts(copy.id)).toEqual([
        'system:Crosstalk:Copied from "Fix login" (Claude Code) on Mac mini',
        "human:iPhone:Fix the login bug",
        "agent:member:Fixed it.",
        "human:iPhone:Ship it",
        "agent:member:Shipped 2.3.11.",
        "human:Codex · Mac mini:Is the fix in?",
        "agent:member:Yes, in 2.3.11.",
      ]);
      const msgs = linux.app.store.listMessages(copy.id, { limit: 10 });
      expect(msgs[0].copy).toEqual({ kind: "from", agent: "Claude Code", provider: "claude", chatId: src.room.id, chatName: "Fix login", machine: "Mac mini" });
      expect(msgs[5].via).toEqual(via);
      const m = linux.app.chats.member(copy.id)!;
      expect([m.model, m.config.effort, m.config.forkNext]).toEqual([null, undefined, undefined]);
      const note = linux.app.store.getMemberSession<{ handoff: string }>(m.id).handoff;
      expect(note).toContain('the user duplicated the chat "Fix login" (Claude Code on Mac mini)');
      expect(note).toContain(`It was on Mac mini, in ${src.room.cwd}: its files aren't on this machine, and this chat works in ${copy.cwd}, a new empty folder.`);
      expect(note).toContain('[Codex in the chat "Release", another chat\'s agent (not the user)]\nIs the fix in?');
    } finally {
      await linux.close();
    }
  });

  test("the original's line links to the copy on the other machine", async () => {
    const h = hub();
    try {
      const src = h.chat("codex", "Release script", [["Write it", "Wrote it."]]);
      expect(() => markDuplicated(h.app, src.room.id, { chatName: "x" })).toThrow("Say which chat");
      markDuplicated(h.app, src.room.id, { chatId: "r_abc123", chatName: "Release script (copy)", machine: "Linux box", agent: "Codex", provider: "codex" });
      const line = h.app.store.listMessages(src.room.id, { limit: 1 })[0];
      expect([line.authorKind, line.text, line.copy]).toEqual(["system", 'Duplicated to "Release script (copy)" on Linux box', { kind: "to", agent: "Codex", provider: "codex", chatId: "r_abc123", chatName: "Release script (copy)", machine: "Linux box" }]);
    } finally {
      await h.close();
    }
  });
});

describe("what a copy and its original keep apart", () => {
  const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  const sessionOf = (h: ReturnType<typeof hub>, room: Room) => h.app.store.getMemberSession<Record<string, unknown>>(h.app.chats.member(room.id)!.id);

  test("a fork point that's gone (the original was rewound since) forks the whole conversation, and the copy says so", async () => {
    const h = hub();
    const args = join(temp("ct-dup-args-"), "args.jsonl");
    registerDriver("claude", (ctx) => new ClaudeDriver({ ...ctx, env: { ...ctx.env, FAKE_CLAUDE_ARGS_OUT: args, FAKE_CLAUDE_PROJECTS: h.projects } }, join(FIX, "fake-claude")));
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      const path = h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req());
      // The original goes back to before its first message and on from there: where the copy ends is off its path.
      writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify({ type: "user", uuid: "u-1b", parentUuid: null, sessionId: SRC, message: { role: "user", content: "Something else" } }) + "\n");
      h.app.engine.postHumanMessage(copy.id, "Now the signup page", "iPhone");
      await h.idle();
      const runs = lines(args);
      expect(runs[0][runs[0].indexOf("--resume-session-at") + 1]).toBe("a-1");
      expect(runs[1]).toContain("--fork-session");
      expect(runs[1]).not.toContain("--resume-session-at");
      expect(sessionOf(h, copy)).toMatchObject({ sessionId: FORK, forkDone: true, forkAt: null });
      const reply = h.app.store.listMessages(copy.id, { limit: 500 }).at(-1)!;
      expect([reply.status, reply.text]).toEqual(["done", "Looking at the files.\n\nDone. @codex please review."]);
      expect(h.app.store.listActivities(copy.id, [reply.turnId!]).find((a) => a.kind === "notice")?.title).toBe("The original chat changed since this copy was made");
    } finally {
      await h.close();
    }
  });

  test("Claude Code: the fork ends at the last finished reply, as the copy's messages do, not at a request stopped after it", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Migrations", [["Add a users table", "Added it."]]);
      const path = h.transcript(src.room, src.member);
      const q = h.insert(src.room.id, { authorKind: "human", memberId: null, authorName: "iPhone", text: "Drop the old migrations and regenerate them", status: "done", createdAt: Date.now() - 2_000 });
      h.insert(src.room.id, { authorKind: "agent", memberId: src.member.id, authorName: "claude", text: "Dropping 0001…", status: "stopped", createdAt: Date.now() - 1_000 });
      const stopped = [
        { type: "user", uuid: "u-2", parentUuid: "a-1", sessionId: SRC, message: { role: "user", content: "Drop the old migrations and regenerate them" } },
        { type: "assistant", uuid: "a-2", parentUuid: "u-2", sessionId: SRC, message: { content: [{ type: "text", text: "Dropping 0001…" }] } },
        { type: "user", uuid: "u-3", parentUuid: "a-2", sessionId: SRC, message: { role: "user", content: "[Request interrupted by user]" } },
      ];
      writeFileSync(path, readFileSync(path, "utf8") + stopped.map((l) => JSON.stringify(l) + "\n").join(""));
      // The chat wrote those itself (they're in it already), and Claude Code was given that message as u-2.
      h.app.store.setChatSync(src.room.id, { claudeSession: SRC, claudeOffset: statSync(path).size });
      h.app.store.setMemberSession(src.member.id, { sessionId: SRC, msgRefs: { [q.id]: "u-2" } });
      const copy = await duplicateChat(h.app, src.room.id, req());
      expect(h.texts(copy.id).join("\n")).not.toContain("Drop the old migrations");
      expect(sessionOf(h, copy).forkAt).toBe("a-1");
      // A message its agent wasn't given yet changes nothing: the fork ends at the newest reply.
      h.app.store.setMemberSession(src.member.id, { sessionId: SRC });
      expect(sessionOf(h, await duplicateChat(h.app, src.room.id, req())).forkAt).toBe("a-2");
    } finally {
      await h.close();
    }
  });

  test("Codex: the fork stops before a reply of the chat's own that didn't finish, and takes turns from the Codex app", async () => {
    const h = hub();
    try {
      const src = h.chat("codex", "Release script", [["Write the release script", "Wrote release.sh."]]);
      const q = h.insert(src.room.id, { authorKind: "human", memberId: null, authorName: "iPhone", text: "Now publish it", status: "done", createdAt: Date.now() - 1_000 });
      h.app.store.setMemberSession(src.member.id, { threadId: "th-src", lastTurn: "tu-1", msgRefs: { [q.id]: "tu-2" } });
      // The thread's turns as the chat last read them (reading it again before duplicating finds nothing new).
      process.env.FAKE_CODEX_NO_READ = "1";
      const dup = (turns: string[]) => {
        h.app.store.setChatSync(src.room.id, { codexThread: "th-src", codexTurns: turns });
        return duplicateChat(h.app, src.room.id, req({ provider: "codex", model: "gpt-test", effort: "high" }));
      };
      // Its own "publish" reply (tu-2) was stopped: the copy ends before it, so the turn after it can't come along.
      expect(sessionOf(h, await dup(["tu-1", "tu-2", "tu-app"]))).toEqual({ forkFrom: "th-src", forkAt: "tu-1" });
      expect(sessionOf(h, await dup(["tu-1", "tu-app"])).forkAt).toBe("tu-app");
    } finally {
      delete process.env.FAKE_CODEX_NO_READ;
      await h.close();
    }
  });

  test("Start fresh, or another account, on a copy that hadn't forked: it isn't waiting to fork any more", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      h.transcript(src.room, src.member);
      for (const how of ["fresh", "account"] as const) {
        const copy = await duplicateChat(h.app, src.room.id, req());
        const m = h.app.chats.member(copy.id)!;
        expect(h.app.chats.context(copy, m).fork).toBe(true);
        if (how === "fresh") await h.app.engine.resetSession(m);
        else {
          const ep = h.app.providers.setEndpointAccount("claude", { label: "Qwen local", baseUrl: "http://127.0.0.1:8080", models: ["qwen3"] });
          h.app.updateMember(m.id, { config: { ...m.config, account: ep.id } });
        }
        const after = h.app.chats.member(copy.id)!;
        expect(after.config.forkNext).toBeUndefined();
        // Its next session is its own: it forks nothing, and it's that conversation's chat.
        h.app.store.setMemberSession(after.id, { sessionId: "11111111-2222-3333-4444-555555555555" });
        expect(h.app.chats.context(copy, after).fork).toBe(false);
      }
    } finally {
      await h.close();
    }
  });

  test("a chat kept from other chats' agents stays kept from them in its copy, on this machine or another", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Secrets", [["Rotate the keys", "Rotated."]]);
      h.app.updateRoom(src.room.id, { privateFromAgents: true });
      const copy = await duplicateChat(h.app, src.room.id, req({ provider: "codex", model: "gpt-test", effort: "high" }));
      expect(h.app.store.getRoom(copy.id)!.privateFromAgents).toBe(true);
      expect(h.app.xchat.offered(copy, h.app.chats.member(copy.id)!)).toBe(false);
      const exp = await exportChat(h.app, src.room.id);
      expect(exp.chat.privateFromAgents).toBe(true);
      const there = receiveDuplicate(h.app, { ...req({ model: null, effort: null }), from: exp });
      expect(h.app.store.getRoom(there.id)!.privateFromAgents).toBe(true);
      // And one that isn't stays reachable.
      h.app.updateRoom(src.room.id, { privateFromAgents: false });
      expect(h.app.store.getRoom((await duplicateChat(h.app, src.room.id, req())).id)!.privateFromAgents).toBe(false);
    } finally {
      await h.close();
    }
  });

  test("files and images in the messages open from the copy itself; a copy in a new folder gets its own copies of them", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Screens", []);
      const uploads = join(realpathSync(src.room.cwd), ".crosstalk", "uploads");
      mkdirSync(uploads, { recursive: true });
      const shot = "0f2c4d6e-1a3b-4c5d-8e9f-0a1b2c3d4e5f_shot (1).png";
      writeFileSync(join(uploads, shot), "png bytes");
      const url = `/api/rooms/${src.room.id}/uploads/${encodeURIComponent(shot).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
      h.insert(src.room.id, { authorKind: "human", memberId: null, authorName: "iPhone", text: `Look at this\n\nAttachments (open these local files only if needed):\n- [shot (1).png](${url}) — local path: ${JSON.stringify(join(uploads, shot))}`, status: "done", createdAt: Date.now() - 2_000 });
      h.insert(src.room.id, { authorKind: "agent", memberId: src.member.id, authorName: "claude", text: `Here it is: ![shot](${url})`, status: "done", createdAt: Date.now() - 1_000 });

      const fresh = await duplicateChat(h.app, src.room.id, req({ folder: "new" }));
      const copied = join(realpathSync(fresh.cwd), ".crosstalk", "uploads", shot);
      expect(readFileSync(copied, "utf8")).toBe("png bytes");
      const [, asked, answered] = h.app.store.listMessages(fresh.id, { limit: 10 });
      expect(asked.text).toContain(`/api/rooms/${fresh.id}/uploads/`);
      expect(asked.text).toContain(JSON.stringify(copied));
      expect(answered.text).toBe(`Here it is: ![shot](/api/rooms/${fresh.id}/uploads/${url.split("/uploads/")[1]})`);

      // Same folder: nothing to copy, the links are the copy's own.
      const same = await duplicateChat(h.app, src.room.id, req());
      expect(h.app.store.listMessages(same.id, { limit: 10 })[2].text).toContain(`/api/rooms/${same.id}/uploads/`);
      // The original can go: both copies still have the file.
      await h.app.deleteRoom(src.room.id);
      const { getUpload } = await import("../src/uploads");
      expect(readFileSync(getUpload(h.app.store.getRoom(fresh.id)!, shot).path, "utf8")).toBe("png bytes");
      expect(readFileSync(getUpload(h.app.store.getRoom(same.id)!, shot).path, "utf8")).toBe("png bytes");
    } finally {
      await h.close();
    }
  });

  test("the clean-up of unsent uploads keeps a file another chat still links to (one a copy couldn't take along)", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Screens", []);
      const other = h.chat("claude", "Elsewhere", []);
      const uploads = join(realpathSync(src.room.cwd), ".crosstalk", "uploads");
      mkdirSync(uploads, { recursive: true });
      const shot = "1f2c4d6e-1a3b-4c5d-8e9f-0a1b2c3d4e5f_big.png";
      writeFileSync(join(uploads, shot), "png bytes");
      const dayAgo = (Date.now() - 2 * 24 * 3600_000) / 1000;
      utimesSync(join(uploads, shot), dayAgo, dayAgo);
      // The original no longer mentions it (that message was unsent); the other chat, in another folder, links to it.
      h.insert(other.room.id, { authorKind: "agent", memberId: other.member.id, authorName: "claude", text: `![big](/api/rooms/${src.room.id}/uploads/${shot})`, status: "done", createdAt: Date.now() });
      h.app.cleanupUploads();
      expect(existsSync(join(uploads, shot))).toBe(true);
      // Once nothing links to it, it goes.
      h.app.store.deleteMessagesFrom(other.room.id, 0);
      h.app.cleanupUploads();
      expect(existsSync(join(uploads, shot))).toBe(false);
    } finally {
      await h.close();
    }
  });

  test("an older app's Continue in a copy still works: the chat's next message forks its own session", async () => {
    const h = hub();
    try {
      const src = h.chat("claude", "Open elsewhere", [["Fix the login bug", "Fixed it."]]);
      await expect(h.app.chats.continueInCopy(src.room.id)).rejects.toThrow("no Claude Code session yet");
      h.transcript(src.room, src.member);
      await h.app.chats.continueInCopy(src.room.id);
      const m = h.app.chats.member(src.room.id)!;
      expect(m.config.forkNext).toBe(true);
      expect(sessionOf(h, src.room)).toMatchObject({ sessionId: SRC, forkDone: false });
      expect(sessionOf(h, src.room).forkAt).toBeUndefined(); // all of it
      expect(h.app.chats.context(src.room, m).fork).toBe(true);
      expect(h.texts(src.room.id).at(-1)).toBe("system:Crosstalk:Your next message continues in a copy of this conversation. The original stays as it is in the Claude app.");
    } finally {
      await h.close();
    }
  });

  test("a transcript copy someone went on with (claude --continue in the new folder) isn't deleted", async () => {
    const h = hub();
    const args = join(temp("ct-dup-args-"), "args.jsonl");
    registerDriver("claude", (ctx) => new ClaudeDriver({ ...ctx, env: { ...ctx.env, FAKE_CLAUDE_ARGS_OUT: args, FAKE_CLAUDE_PROJECTS: h.projects } }, join(FIX, "fake-claude")));
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req({ folder: "new" }));
      const [made] = sessionOf(h, copy).forkCopies as { path: string; size: number; mtimeMs: number }[];
      expect(made).toMatchObject({ size: statSync(made.path).size });
      // In a terminal there, before the copy's first reply.
      writeFileSync(made.path, readFileSync(made.path, "utf8") + JSON.stringify({ type: "user", uuid: "u-t", parentUuid: "a-1", sessionId: SRC, message: { role: "user", content: "From the terminal" } }) + "\n");
      h.app.engine.postHumanMessage(copy.id, "Go on here", "iPhone");
      await h.idle();
      expect(sessionOf(h, copy)).toMatchObject({ forkDone: true });
      expect(sessionOf(h, copy).forkCopies).toBeUndefined();
      expect(readFileSync(made.path, "utf8")).toContain("From the terminal");
    } finally {
      await h.close();
    }
  });

  test("the note goes once even when the first reply is stopped after the agent took it in, and again when it didn't", async () => {
    const h = hub();
    const inputs: (string | null)[] = [];
    let mode: "taken" | "early" | "ok" = "taken";
    registerDriver("codex", () => ({
      provider: "codex",
      runTurn: async (input: TurnInput, sink: TurnSink): Promise<TurnResult> => {
        inputs.push(input.systemNote);
        if (mode === "ok") return { ok: true, text: "Done." };
        if (mode === "taken") sink.taken?.();
        return { ok: false, error: mode === "taken" ? "stopped mid-way" : "Codex didn't start" };
      },
      interrupt: async () => {},
      dispose: async () => {},
    }));
    try {
      const src = h.chat("claude", "Fix login", [["Fix the login bug", "Fixed it."]]);
      h.transcript(src.room, src.member);
      const copy = await duplicateChat(h.app, src.room.id, req({ provider: "codex", model: "gpt-test", effort: "high" }));
      const note = sessionOf(h, copy).handoff as string;
      // It failed before Codex had the message: the next one brings the note.
      mode = "early";
      h.app.engine.postHumanMessage(copy.id, "Carry on", "iPhone");
      await h.idle();
      // This one had it (then failed): the note went, once.
      mode = "taken";
      h.app.engine.postHumanMessage(copy.id, "Try again", "iPhone");
      await h.idle();
      mode = "ok";
      h.app.engine.postHumanMessage(copy.id, "And now", "iPhone");
      await h.idle();
      expect(inputs).toEqual([note, note, null]);
    } finally {
      await h.close();
    }
  });
});
