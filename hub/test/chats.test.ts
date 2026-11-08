import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexQuestionReply, type Member, type Message, type Room, type ServerEvent } from "@crosstalk/shared";
import { App } from "../src/app";
import { buildRoutes } from "../src/server";
import { registerDriver } from "../src/agents";
import { CodexDriver } from "../src/agents/codex";
import { Bus } from "../src/bus";
import { Store } from "../src/db";
import { Engine } from "../src/engine/engine";
import { buildChatPrompt } from "../src/engine/prompt";
import { MockDriver } from "../src/agents/mock";
import type { AgentDriver, DriverContext, TurnInput, TurnSink } from "../src/agents/driver";
import { SocketRpc } from "../src/agents/jsonrpc";
import { askHelper } from "../src/teamwork";
import { claudeUserText, codexThreadMessages, codexThreadsToSessions, listClaudeSessions, readClaudeTranscript } from "../src/local-sessions";
import { newId } from "../src/util/ids";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const user = (text: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", message: { role: "user", content: text }, timestamp: "2026-10-14T10:00:00Z", cwd: "/work/app", ...extra });
const reply = (text: string, extra: Record<string, unknown> = {}) => line({ type: "assistant", message: { content: [{ type: "text", text }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] }, timestamp: "2026-10-14T10:00:05Z", ...extra });

describe("chat prompts", () => {
  test("a chat's agent gets what the human wrote, as written; a note from Crosstalk comes first", () => {
    const msg = (text: string, authorKind: "human" | "system" | "agent", seq: number) => ({ id: `m${seq}`, roomId: "r", authorKind, memberId: null, authorName: "Phone", text, mentions: [], turnId: null, status: "done" as const, createdAt: seq, updatedAt: seq, seq });
    expect(buildChatPrompt([msg("Fix the login bug", "human", 1)], null)).toBe("Fix the login bug");
    expect(buildChatPrompt([msg("one", "human", 1), msg("joined", "system", 2), msg("two", "human", 3)], null)).toBe("one\n\ntwo");
    expect(buildChatPrompt([msg("go on", "human", 1)], "Crosstalk restarted")).toBe("(Crosstalk restarted)\n\ngo on");
    expect(buildChatPrompt([], null)).toBe("Continue.");
    // "/compact" alone is the agent's command, sent as typed without any note; mixed with a message it's just text.
    expect(buildChatPrompt([msg("/compact", "human", 1)], "Teamwork note")).toBe("/compact");
    expect(buildChatPrompt([msg("fix it", "human", 1), msg("/compact", "human", 2)], null)).toBe("fix it\n\n/compact");
  });

  test("in a chat, the engine sends no group briefing or digest, and only what's new", async () => {
    const store = new Store(":memory:");
    const prompts: TurnInput[] = [];
    const contexts: DriverContext[] = [];
    const engine = new Engine({
      store,
      bus: new Bus(),
      createDriver: (ctx: DriverContext): AgentDriver => {
        contexts.push(ctx);
        const inner = new MockDriver(ctx);
        return { provider: "mock", runTurn: (input: TurnInput, sink: TurnSink) => (prompts.push(input), inner.runTurn(input, sink)), interrupt: () => inner.interrupt(), dispose: () => inner.dispose() };
      },
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    const now = Date.now();
    const room: Room = { id: newId("r"), name: "Chat", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "mock", origin: "web", localId: null });
    const m: Member = { id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: { delayMs: 5, reply: "ok" }, createdAt: now, position: 0 };
    store.insertMember(m);
    engine.postHumanMessage(room.id, "What does main.ts do?", "iPhone");
    await engine.whenIdle();
    engine.postHumanMessage(room.id, "And app.ts?", "iPhone");
    await engine.whenIdle();
    expect(prompts.map((p) => p.prompt)).toEqual(["What does main.ts do?", "And app.ts?"]);
    expect(prompts.every((p) => p.systemNote === null)).toBe(true);
    expect(contexts[0].chat).toEqual({ helper: null });
    await engine.shutdown();
    store.close();
  });
});

describe("conversations from the agents' own apps", () => {
  test("Claude Code transcripts: what people typed and what Claude replied, without tool traffic or commands", () => {
    expect(claudeUserText({ type: "user", message: { content: "<command-name>/usage</command-name>" } })).toBeNull();
    expect(claudeUserText({ type: "user", isMeta: true, message: { content: "Caveat" } })).toBeNull();
    expect(claudeUserText({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } })).toBeNull();
    expect(claudeUserText({ type: "user", message: { content: [{ type: "text", text: " hello " }] } })).toBe("hello");

    const dir = mkdtempSync(join(tmpdir(), "ct-transcript-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("Make a todo app") + reply("Sure.") + reply("Done: index.html.") + user([{ type: "tool_result", content: "ok" }]) + line({ type: "summary", summary: "Todo app" }));
    const first = readClaudeTranscript(path);
    expect(first.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Make a todo app"],
      ["assistant", "Sure.\n\nDone: index.html."],
    ]);
    appendFileSync(path, user("Add dark mode") + reply("Added.") + '{"type":"user","mess'); // the last line is still being written
    const next = readClaudeTranscript(path, first.end);
    expect(next.messages.map((m) => m.text)).toEqual(["Add dark mode", "Added."]);
    expect(readClaudeTranscript(path, next.end).messages).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the session list leaves out checks nobody typed into, and marks sessions a chat already continues", () => {
    const projects = mkdtempSync(join(tmpdir(), "ct-projects-"));
    mkdirSync(join(projects, "-work-app"));
    const real = "11111111-1111-1111-1111-111111111111";
    const check = "22222222-2222-2222-2222-222222222222";
    const room = "33333333-3333-3333-3333-333333333333";
    writeFileSync(join(projects, "-work-app", `${real}.jsonl`), user("Refactor the parser") + reply("On it."));
    writeFileSync(join(projects, "-work-app", `${check}.jsonl`), user("<local-command-stdout>Total cost: $0</local-command-stdout>"));
    writeFileSync(join(projects, "-work-app", `${room}.jsonl`), user("You are @claude, one of several agents"));
    // An old group room's session that no room points to any more: recognized by its briefing.
    writeFileSync(join(projects, "-work-app", "55555555-5555-5555-5555-555555555555.jsonl"), user("You are @claude-2, one of several AI coding agents working together in a group chat"));
    const list = listClaudeSessions({ projectsDir: projects, exclude: new Set([room]), linked: new Map([[real, "r_chat"]]) });
    expect(list.map((s) => [s.id, s.title, s.cwd, s.source, s.chatId])).toEqual([[real, "Refactor the parser", "/work/app", "claude-cli", "r_chat"]]);
    rmSync(projects, { recursive: true, force: true });
  });

  test("Codex threads: subagent and throwaway threads are left out; turns become messages", () => {
    const sessions = codexThreadsToSessions([
      { id: "t1", name: null, preview: "Fix the tests", cwd: "/w", updatedAt: 1_800_000_000, status: { type: "active" } },
      { id: "t2", preview: "sub", parentThreadId: "t1" },
      { id: "t3", preview: "tmp", ephemeral: true },
      { id: "t4", preview: "You are @codex, one of several AI coding agents working together" },
    ]);
    expect(sessions).toEqual([{ provider: "codex", id: "t1", title: "Fix the tests", cwd: "/w", updatedAt: 1_800_000_000_000, source: "codex-app", busy: true, chatId: null }]);
    const msgs = codexThreadMessages({
      turns: [
        { id: "u1", startedAt: 10, completedAt: 20, items: [{ type: "userMessage", content: [{ type: "text", text: "Fix the tests" }] }, { type: "commandExecution" }, { type: "agentMessage", text: "Looking." }, { type: "agentMessage", text: "Fixed." }] },
      ],
    });
    expect(msgs.map((m) => [m.role, m.text, m.turnId])).toEqual([["user", "Fix the tests", "u1"], ["assistant", "Looking.\n\nFixed.", "u1"]]);
  });
});

describe("chats in the app", () => {
  const dirs: string[] = [];
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configDir;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("a chat continuing a Claude Code session brings in its history, then only what's new, and never as new prompts", async () => {
    const work = mkdtempSync(join(tmpdir(), "ct-chat-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "ct-claude-"));
    dirs.push(work, claudeHome);
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const id = "44444444-4444-4444-4444-444444444444";
    mkdirSync(join(claudeHome, "projects", "-work"), { recursive: true });
    const transcript = join(claudeHome, "projects", "-work", `${id}.jsonl`);
    writeFileSync(transcript, user("Plan the release") + reply("Here's the plan."));
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
    try {
      const room = app.chats.create({ provider: "claude", cwd: work, name: "Release", local: { id, origin: "claude-cli" } });
      expect(room.chat).toEqual({ provider: "claude", origin: "claude-cli" });
      expect(await app.chats.sync(room.id)).toBe(2);
      const member = app.chats.member(room.id)!;
      expect(app.store.getMemberSession<Record<string, unknown>>(member.id)).toEqual({ sessionId: id });
      const texts = () => app.store.listMessages(room.id, { limit: 50 }).map((m) => `${m.authorKind}:${m.authorName}:${m.text}`);
      expect(texts()).toEqual(["human:Terminal:Plan the release", `agent:${member.handle}:Here's the plan.`]);
      // Already answered where it was said: the agent's next turn must not get these again.
      expect(app.store.getLastSeen(member.id).seq).toBe(app.store.maxSeq(room.id));
      expect(await app.chats.sync(room.id)).toBe(0);
      appendFileSync(transcript, user("Ship it") + reply("Shipped."));
      expect(await app.chats.sync(room.id)).toBe(2);
      expect(texts().slice(-2)).toEqual(["human:Terminal:Ship it", `agent:${member.handle}:Shipped.`]);
    } finally {
      await app.engine.shutdown();
      app.store.close();
    }
  });

  test("what was said in the terminal before a reply from the phone is still brought in; the reply's own lines aren't", async () => {
    const work = mkdtempSync(join(tmpdir(), "ct-chat-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "ct-claude-"));
    dirs.push(work, claudeHome);
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const id = "45454545-4545-4545-4545-454545454545";
    mkdirSync(join(claudeHome, "projects", "-work"), { recursive: true });
    const transcript = join(claudeHome, "projects", "-work", `${id}.jsonl`);
    writeFileSync(transcript, user("Plan the release") + reply("Here's the plan."));
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
    try {
      const room = app.chats.create({ provider: "claude", cwd: work, name: "Release", local: { id, origin: "claude-cli" } });
      expect(await app.chats.sync(room.id)).toBe(2);
      const member = app.chats.member(room.id)!;
      const texts = () => app.store.listMessages(room.id, { limit: 50 }).map((m) => `${m.authorKind}:${m.text}`);
      // Meanwhile in a terminal (\`claude --resume\`), not brought in yet.
      appendFileSync(transcript, user("Typed in the terminal") + reply("Done in the terminal."));
      // A reply from the phone: it starts after the terminal's lines, writes its own, and ends.
      app.chats.turnStarting(room, member);
      appendFileSync(transcript, user("From the phone") + reply("Answered on the phone."));
      app.engine.systemMessage(room.id, "(stands in for the phone's message and its reply, which the engine writes)");
      app.chats.afterTurn(room, member);
      await Bun.sleep(1700);
      // The next sync brings in the terminal's two messages, and not the phone reply's lines (the chat has those).
      expect(await app.chats.sync(room.id)).toBe(2);
      expect(texts().slice(-2)).toEqual(["human:Typed in the terminal", "agent:Done in the terminal."]);
      expect(texts().join("\n")).not.toContain("From the phone");
      expect(await app.chats.sync(room.id)).toBe(0);
      // With nothing from the terminal before it, a reply moves the marker on as before.
      app.chats.turnStarting(room, member);
      appendFileSync(transcript, user("Again from the phone") + reply("Again answered."));
      app.chats.afterTurn(room, member);
      await Bun.sleep(1700);
      expect(await app.chats.sync(room.id)).toBe(0);
    } finally {
      await app.engine.shutdown();
      app.store.close();
    }
  });

  test("new chats: only Claude Code and Codex, named later from the first message, in a folder of their own", async () => {
    const work = mkdtempSync(join(tmpdir(), "ct-chat-"));
    dirs.push(work);
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
    try {
      expect(() => app.chats.create({ provider: "mock" })).toThrow("Claude Code or Codex");
      const a = app.chats.create({ provider: "codex", effort: "low", permissionMode: "edits" });
      const b = app.chats.create({ provider: "codex" });
      expect(a.name).toBe("New chat");
      expect(a.cwd).not.toBe(b.cwd);
      expect(a.cwd.startsWith(work)).toBe(true);
      const m = app.chats.member(a.id)!;
      expect([m.provider, m.permissionMode, m.config.effort]).toEqual(["codex", "edits", "low"]);
      // No "joined the room" chatter in a chat.
      expect(app.store.listMessages(a.id, { limit: 10 })).toEqual([]);
    } finally {
      await app.engine.shutdown();
      app.store.close();
    }
  });

  test("teamwork: off by default; one question per reply; never spends a plan that's nearly used up", async () => {
    const work = mkdtempSync(join(tmpdir(), "ct-chat-"));
    dirs.push(work);
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
    try {
      const room = app.chats.create({ provider: "claude" });
      const asker = app.chats.member(room.id)!;
      expect(await askHelper(app, asker.id, "Is this safe?")).toContain("Teamwork is off");
      expect(app.chats.context(room, asker).helper).toBeNull();
      app.setHubSettings({ teamwork: { ...app.hubSettings().teamwork, enabled: true } });
      app.store.setUsage({ provider: "codex", account: null, plan: null, windows: [{ label: "5-hour", usedPercent: 92, resetsAt: Date.now() + 3600_000 }], credits: null, note: null, updatedAt: Date.now() });
      expect(await askHelper(app, asker.id, "Is this safe?")).toContain("92% of its 5-hour limit");
      expect(await askHelper(app, asker.id, "And this?")).toContain("already asked Codex once");
    } finally {
      await app.engine.shutdown();
      app.store.close();
    }
  });
});

describe("the Codex app's shared server", () => {
  test("JSON-RPC over a WebSocket on a Unix socket: requests, notifications, requests from the server, close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-sock-"));
    const path = join(dir, "s.sock");
    const server = Bun.serve({
      unix: path,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const m = JSON.parse(String(raw));
          if (m.method === "initialize") {
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "account/updated", params: { ok: true } }));
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "item/commandExecution/requestApproval", params: { command: "ls" } }));
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { codexHome: "/x", big: "y".repeat(70_000) } }));
          } else if (m.id === 99) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "echo", params: m.result }));
        },
      },
    });
    const rpc = new SocketRpc(path, "test server");
    const notes: string[] = [];
    rpc.onNotification((method, p) => notes.push(`${method}:${JSON.stringify(p)}`));
    rpc.onRequest(async (method, p) => ({ decision: method.endsWith("requestApproval") && p.command === "ls" ? "accept" : "decline" }));
    await rpc.ready;
    const res = await rpc.request<{ codexHome: string; big: string }>("initialize", {});
    expect(res.codexHome).toBe("/x");
    expect(res.big.length).toBe(70_000); // a 64-bit length frame
    for (let i = 0; i < 50 && notes.length < 2; i++) await Bun.sleep(10);
    expect(notes).toEqual(['account/updated:{"ok":true}', 'echo:{"decision":"accept"}']);
    await rpc.kill();
    expect(rpc.alive).toBe(false);
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the agents' Crosstalk tools", () => {
  const tools = async (env: Record<string, string>) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "mcp"], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe" });
    proc.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + line({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    let buf = "";
    while (!buf.includes('"id":2')) buf += new TextDecoder().decode((await reader.read()).value);
    proc.kill();
    const list = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
    return list.result.tools.map((t: { name: string }) => t.name);
  };
  test("a chat's agent gets no room tools; the ask tool only with teamwork on", async () => {
    expect(await tools({ CROSSTALK_EXPOSE_APPROVE: "1" })).toEqual(["room_members", "room_read", "room_post", "approve"]);
    expect(await tools({ CROSSTALK_EXPOSE_APPROVE: "1", CROSSTALK_TOOLSET: "chat" })).toEqual(["approve"]);
    expect(await tools({ CROSSTALK_EXPOSE_APPROVE: "1", CROSSTALK_TOOLSET: "chat", CROSSTALK_ASK: "codex" })).toEqual(["ask_codex", "approve"]);
    expect(await tools({ CROSSTALK_TOOLSET: "chat", CROSSTALK_ASK: "claude" })).toEqual(["ask_claude"]);
  });
});

test("live limit updates keep measured percentages until the window resets", async () => {
  const { mergeWindows } = await import("../src/engine/engine");
  const now = 1_000_000;
  const cur = [
    { label: "5-hour", usedPercent: 36, resetsAt: now + 3_600_000 },
    { label: "Weekly", usedPercent: 8, resetsAt: now + 86_400_000 },
  ];
  // A reset time alone keeps the percentage and the other windows.
  expect(mergeWindows(cur, [{ label: "5-hour", usedPercent: null, resetsAt: now + 3_500_000 }], now)).toEqual([
    { label: "5-hour", usedPercent: 36, resetsAt: now + 3_500_000 },
    { label: "Weekly", usedPercent: 8, resetsAt: now + 86_400_000 },
  ]);
  // A window that has already reset loses its old percentage; a new percentage always wins.
  expect(mergeWindows([{ label: "5-hour", usedPercent: 90, resetsAt: now - 1 }], [{ label: "5-hour", usedPercent: null, resetsAt: now + 5 }], now)[0].usedPercent).toBeNull();
  expect(mergeWindows(cur, [{ label: "Weekly", usedPercent: 12, resetsAt: null }], now)[1]).toEqual({ label: "Weekly", usedPercent: 12, resetsAt: now + 86_400_000 });
});

describe("Codex chats open without waiting for Codex", () => {
  const FIX = join(import.meta.dir, "fixtures");
  const KEYS = ["CODEX_HOME", "FAKE_CODEX_READ_DELAY", "FAKE_CODEX_THREAD_TURNS", "FAKE_CODEX_READ_LOG"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const dirs: string[] = [];
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  afterAll(() => {
    // Back to what providers/all.ts registers.
    registerDriver("codex", (ctx) => {
      if (!ctx.bin) throw new Error("Codex isn't installed on the hub. Install it under Agents & sign-ins.");
      return new CodexDriver(ctx, ctx.bin);
    });
  });

  /**
   * A Codex chat continuing a thread from the Codex app, whose Codex is the fixture (with a Codex home of its own, so
   * it never reaches the Codex app's server): reading the thread takes `readMs`. The chat's own replies come from a
   * stand-in that holds its first reply until `release()`.
   */
  function codexChat(readMs: number) {
    const dir = mkdtempSync(join(tmpdir(), "ct-codex-sync-"));
    dirs.push(dir);
    const reads = join(dir, "reads.log");
    process.env.CODEX_HOME = join(dir, "codex-home");
    process.env.FAKE_CODEX_READ_DELAY = String(readMs);
    process.env.FAKE_CODEX_READ_LOG = reads;
    process.env.FAKE_CODEX_THREAD_TURNS = JSON.stringify([
      { id: "u1", startedAt: 1_800_000_000, completedAt: 1_800_000_005, items: [{ type: "userMessage", content: [{ type: "text", text: "Typed in the Codex app" }] }, { type: "agentMessage", text: "Answered in the Codex app" }] },
    ]);
    const prompts: string[] = [];
    let release = () => {};
    let hold: Promise<void> | null = new Promise<void>((res) => (release = res));
    registerDriver("codex", () => ({
      provider: "codex",
      runTurn: async (input: TurnInput, sink: TurnSink) => {
        prompts.push(input.prompt);
        sink.taken?.();
        const wait = hold;
        hold = null;
        if (wait) await wait;
        return { ok: true, text: `Re: ${input.prompt}` };
      },
      interrupt: async () => {},
      dispose: async () => {},
    }));
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    app.providers.which = (p) => (p === "codex" ? join(FIX, "fake-codex-app") : null);
    // What a finished reply marks as already in the chat is another test's business.
    app.chats.afterTurn = () => {};
    const room = app.chats.create({ provider: "codex", cwd: dir, name: "From the Codex app", local: { id: "th-app", origin: "codex-app" } });
    const events: ServerEvent[] = [];
    app.bus.on((e) => events.push(e));
    const route = buildRoutes(app).find((r) => r.method === "GET" && r.pattern.test(`/api/rooms/${room.id}/history`))!;
    const device = { id: "dev", name: "Phone", platform: "Web", createdAt: 0, lastSeenAt: null } as never;
    const history = async () => {
      const url = new URL(`http://hub/api/rooms/${room.id}/history?limit=80&v=2`);
      return (await route.handler({ req: new Request(url.href), url, params: { id: room.id }, device, body: async () => ({}) })) as { messages: Message[] };
    };
    const readCount = () => (existsSync(reads) ? readFileSync(reads, "utf8").split("\n").filter(Boolean).length : 0);
    const texts = () => app.store.listMessages(room.id, { limit: 50 }).map((m) => `${m.authorKind}:${m.text}`);
    return { app, room, events, history, readCount, texts, prompts, release: () => release(), done: async () => (await app.engine.shutdown(), app.store.close()) };
  }
  const until = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await Bun.sleep(10);
    expect(check()).toBe(true);
  };

  test("history answers before a slow Codex read finishes, and what the read brings in arrives as message events", async () => {
    const t = codexChat(800);
    try {
      const started = Date.now();
      const first = await t.history();
      // At once, with what the chat already had: the thread is still being read.
      expect(Date.now() - started).toBeLessThan(400);
      expect(first.messages).toEqual([]);
      await until(() => t.events.filter((e) => e.t === "message").length === 2);
      const live = t.events.filter((e): e is Extract<ServerEvent, { t: "message" }> => e.t === "message").map((e) => e.message);
      expect(live.map((m) => [m.authorKind, m.text])).toEqual([["human", "Typed in the Codex app"], ["agent", "Answered in the Codex app"]]);
      expect(live.every((m) => typeof m.seq === "number")).toBe(true);
      // Already answered where they were said: the agent has read them, and every device's list hears of the chat.
      const member = t.events.findLast((e) => e.t === "member");
      expect(member).toMatchObject({ member: { readSeq: t.app.store.maxSeq(t.room.id) } });
      expect(t.events.some((e) => e.t === "room" && e.room.id === t.room.id)).toBe(true);
      expect(t.texts()).toEqual(["human:Typed in the Codex app", "agent:Answered in the Codex app"]);
    } finally {
      await t.done();
    }
  });

  test("an answer to the agent's questions given in the Codex app closes their cards here when it's brought in", async () => {
    const t = codexChat(0);
    try {
      const member = t.app.chats.member(t.room.id)!;
      // A question Codex asked without waiting, still open here (this chat's connection to Codex had ended since).
      const qid = JSON.stringify(["request_user_input_async", "call_ask1", 0]);
      t.app.store.insertApproval({ id: "ap_async", roomId: t.room.id, memberId: member.id, turnId: null, kind: "question", title: "Ship it?", detail: "", status: "pending", decision: null, decidedBy: null, createdAt: Date.now(), decidedAt: null, questions: [{ id: qid, header: "", question: "Ship it?", options: [{ label: "Yes", description: "" }], multiSelect: false, allowOther: true }], answers: null, delivery: "async" });
      process.env.FAKE_CODEX_THREAD_TURNS = JSON.stringify([
        { id: "u1", startedAt: 1_800_000_000, completedAt: 1_800_000_005, items: [{ type: "userMessage", content: [{ type: "text", text: codexQuestionReply([{ questionItemId: qid, question: "Ship it?", answer: "Yes" }]) }] }, { type: "agentMessage", text: "Shipping." }] },
      ]);
      await t.history();
      await until(() => t.app.store.getApproval("ap_async")?.status === "approved");
      expect(t.app.store.getApproval("ap_async")).toMatchObject({ decidedBy: "another app", answers: { [qid]: ["Yes"] } });
      expect(t.events.some((e) => e.t === "approval" && e.approval.id === "ap_async" && e.approval.status === "approved")).toBe(true);
    } finally {
      await t.done();
    }
  });

  test("a second load within a minute doesn't read the thread again", async () => {
    const t = codexChat(100);
    try {
      // Two devices opening the chat at once: one read.
      await Promise.all([t.history(), t.history()]);
      await until(() => t.texts().length === 2);
      expect(t.readCount()).toBe(1);
      // Opening it again a moment later: no new read (a Codex read can take seconds), and nothing comes in twice.
      const again = await t.history();
      expect(again.messages.map((m) => m.text)).toEqual(["Typed in the Codex app", "Answered in the Codex app"]);
      await Bun.sleep(400);
      expect(t.readCount()).toBe(1);
      expect(t.texts()).toHaveLength(2);
    } finally {
      await t.done();
    }
  });

  test("a message sent while the read runs still gets answered", async () => {
    const t = codexChat(500);
    try {
      void t.history();
      await until(() => t.readCount() === 1);
      // Two messages while the thread is read: the first is being answered, the second waits for it.
      t.app.engine.postHumanMessage(t.room.id, "first", "Phone");
      t.app.engine.postHumanMessage(t.room.id, "second", "Phone");
      await Bun.sleep(800); // the read has come back meanwhile
      t.release();
      await t.app.engine.whenIdle();
      // The read didn't mark the waiting message as read: it was answered, as written.
      expect(t.prompts).toEqual(["first", "second"]);
      // And nothing from the read was put in the middle of the chat's own conversation.
      expect(t.texts()).toEqual(["human:first", "agent:Re: first", "human:second", "agent:Re: second"]);
    } finally {
      await t.done();
    }
  });

  test("a message sent while the read runs: what was said in the Codex app still comes in later, and the chat's own turn doesn't", async () => {
    const t = codexChat(400);
    try {
      // This test is about what a finished reply marks as brought in.
      delete (t.app.chats as unknown as { afterTurn?: unknown }).afterTurn;
      process.env.FAKE_CODEX_THREAD_TURNS = JSON.stringify([
        { id: "u1", startedAt: 1_800_000_000, completedAt: 1_800_000_005, items: [{ type: "userMessage", content: [{ type: "text", text: "Typed in the Codex app" }] }, { type: "agentMessage", text: "Answered in the Codex app" }] },
        { id: "ct1", startedAt: 1_800_000_100, completedAt: 1_800_000_105, items: [{ type: "userMessage", content: [{ type: "text", text: "hello from the phone" }] }, { type: "agentMessage", text: "Re: hello from the phone" }] },
      ]);
      // The chat's agent, as CodexDriver does: it notes the Codex turn it started.
      registerDriver("codex", () => ({
        provider: "codex",
        runTurn: async (input: TurnInput, sink: TurnSink) => {
          sink.taken?.();
          sink.saveSession({ ownTurns: ["ct1"] });
          return { ok: true, text: `Re: ${input.prompt}` };
        },
        interrupt: async () => {},
        dispose: async () => {},
      }));
      void t.history();
      await until(() => t.readCount() === 1);
      // Sent while the thread is read: that read gives up (the chat has a new message), then the reply runs.
      t.app.engine.postHumanMessage(t.room.id, "hello from the phone", "Phone");
      await t.app.engine.whenIdle();
      await Bun.sleep(2200); // the reply's after-turn note (1.5 s), and the read it does
      (t.app.chats as unknown as { codexReadAt: Map<string, number> }).codexReadAt.clear(); // as if a minute had passed
      expect(await t.app.chats.sync(t.room.id)).toBe(2);
      expect(t.texts()).toEqual(["human:hello from the phone", "agent:Re: hello from the phone", "human:Typed in the Codex app", "agent:Answered in the Codex app"]);
    } finally {
      await t.done();
    }
  });
});
