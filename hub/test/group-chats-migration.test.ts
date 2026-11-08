// Group chats from older databases: the multi-agent rooms made before group chats open as group chats, with everything
// they had (messages, replies, steps, approvals, agents and their sessions). Each test builds a database file the way an
// older hub left it, then opens it with this hub's Store. Only temp files: never the live database.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { App } from "../src/app";
import { MockDriver } from "../src/agents/mock";
import type { EngineDeps } from "../src/engine/engine";

const dir = mkdtempSync(join(tmpdir(), "ct-group-migration-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The tables as hubs 0.4 and 0.5 (before group chats) made them: chats for one-agent chats, rooms for the rest. */
const SCHEMA_05 = `
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'relay', lead_member_id TEXT,
  max_hops INTEGER NOT NULL DEFAULT 6, rounds INTEGER NOT NULL DEFAULT 1, parallel INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  private_agents INTEGER NOT NULL DEFAULT 0, last_reply_at INTEGER, read_at INTEGER, pinned_at INTEGER, pin_order REAL
);
CREATE TABLE members (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, handle TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT, role TEXT NOT NULL DEFAULT '', permission_mode TEXT NOT NULL DEFAULT 'ask', status TEXT NOT NULL DEFAULT 'idle',
  status_detail TEXT, config TEXT NOT NULL DEFAULT '{}', session TEXT NOT NULL DEFAULT '{}', last_seen_seq INTEGER NOT NULL DEFAULT 0,
  roster_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  pending_seen TEXT NOT NULL DEFAULT '[]', UNIQUE(room_id, handle)
);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL, member_id TEXT, author_name TEXT NOT NULL, text TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]',
  turn_id TEXT, status TEXT NOT NULL DEFAULT 'done', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, via TEXT, copy TEXT
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member_id TEXT NOT NULL,
  trigger_message_id TEXT, reply_message_id TEXT, hop INTEGER NOT NULL DEFAULT 0, chain_id TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, usage TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, provider TEXT, origin TEXT
);
CREATE TABLE activities (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, turn_id TEXT NOT NULL, member_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member_id TEXT NOT NULL, turn_id TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, decision TEXT, decided_by TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER, questions TEXT, answers TEXT, always TEXT, delivery TEXT, auto_resolve_at INTEGER,
  auto_resolve_ms INTEGER
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE chats (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, provider TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'web',
  local_id TEXT, sync TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);`;

/** The tables as a 0.2-era hub made them: no chats at all, and none of the columns added since. */
const SCHEMA_02 = `
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'relay', lead_member_id TEXT,
  max_hops INTEGER NOT NULL DEFAULT 6, rounds INTEGER NOT NULL DEFAULT 1, parallel INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE members (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, handle TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT, role TEXT NOT NULL DEFAULT '', permission_mode TEXT NOT NULL DEFAULT 'ask', status TEXT NOT NULL DEFAULT 'idle',
  status_detail TEXT, config TEXT NOT NULL DEFAULT '{}', session TEXT NOT NULL DEFAULT '{}', last_seen_seq INTEGER NOT NULL DEFAULT 0,
  roster_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id, handle)
);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL, member_id TEXT, author_name TEXT NOT NULL, text TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]',
  turn_id TEXT, status TEXT NOT NULL DEFAULT 'done', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member_id TEXT NOT NULL,
  trigger_message_id TEXT, reply_message_id TEXT, hop INTEGER NOT NULL DEFAULT 0, chain_id TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, usage TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
CREATE TABLE activities (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, turn_id TEXT NOT NULL, member_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member_id TEXT NOT NULL, turn_id TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, decision TEXT, decided_by TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

const T = 1_780_000_000_000;

/** A database file as an older hub left it: a Build & review room, a round-robin one, an empty one, and (when the hub had chats) a one-agent chat. */
function olderDatabase(name: string, schema: string, withChats: boolean): string {
  const path = join(dir, `${name}.db`);
  const db = new Database(path, { create: true });
  db.exec(schema);
  const room = db.query("INSERT INTO rooms (id, name, cwd, mode, lead_member_id, max_hops, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 5, ?, ?)");
  const member = db.query("INSERT INTO members (id, room_id, handle, provider, model, permission_mode, config, session, last_seen_seq, created_at, position) VALUES (?, ?, ?, ?, ?, 'edits', ?, ?, ?, ?, ?)");
  const message = db.query("INSERT INTO messages (id, room_id, author_kind, member_id, author_name, text, turn_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const turn = db.query("INSERT INTO turns (id, room_id, member_id, trigger_message_id, reply_message_id, chain_id, status, usage, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, 'ch_1', 'done', ?, ?, ?, ?)");
  room.run("r_review", "Payments API", dir, "review", "mb_builder", T, T + 50);
  member.run("mb_builder", "r_review", "builder", "claude", "claude-opus-5-5", JSON.stringify({ effort: "high" }), JSON.stringify({ sessionId: "s-builder" }), 3, T, 0);
  member.run("mb_reviewer", "r_review", "reviewer", "codex", "gpt-5.5", JSON.stringify({ account: "work" }), JSON.stringify({ threadId: "th-reviewer" }), 3, T, 1);
  message.run("m_ask", "r_review", "human", null, "iPhone", "Build the checkout", null, T + 10, T + 10);
  message.run("m_built", "r_review", "agent", "mb_builder", "builder", "Built it: checkout.ts", "t_build", T + 20, T + 20);
  message.run("m_reviewed", "r_review", "agent", "mb_reviewer", "reviewer", "APPROVED: looks right", "t_review", T + 30, T + 30);
  turn.run("t_build", "r_review", "mb_builder", "m_ask", "m_built", JSON.stringify({ inputTokens: 900, outputTokens: 120, cachedInputTokens: 0, costUsd: 0.02 }), T + 11, T + 12, T + 20);
  turn.run("t_review", "r_review", "mb_reviewer", "m_built", "m_reviewed", null, T + 21, T + 22, T + 30);
  db.query("INSERT INTO activities (id, room_id, turn_id, member_id, kind, title, detail, status, created_at, updated_at) VALUES ('a_1', 'r_review', 't_build', 'mb_builder', 'command', 'bun test', '12 pass', 'done', ?, ?)").run(T + 15, T + 15);
  db.query("INSERT INTO approvals (id, room_id, member_id, turn_id, kind, title, status, decision, decided_by, created_at, decided_at) VALUES ('ap_1', 'r_review', 'mb_builder', 't_build', 'command', 'bun test', 'approved', 'approve', 'iPhone', ?, ?)").run(T + 13, T + 14);

  room.run("r_turns", "Everyone weighs in", dir, "roundrobin", null, T + 100, T + 200);
  member.run("mb_one", "r_turns", "one", "mock", null, "{}", "{}", 0, T + 100, 0);
  member.run("mb_two", "r_turns", "two", "mock", null, "{}", "{}", 0, T + 100, 1);

  room.run("r_empty", "Nobody here yet", dir, "relay", null, T + 300, T + 300);

  if (withChats) {
    room.run("r_chat", "Fix the login", dir, "direct", "mb_solo", T + 400, T + 400);
    member.run("mb_solo", "r_chat", "claude", "claude", null, "{}", JSON.stringify({ sessionId: "s-solo" }), 0, T + 400, 0);
    db.query("INSERT INTO chats (room_id, provider, origin, local_id, created_at) VALUES ('r_chat', 'claude', 'claude-app', 's-solo', ?)").run(T + 400);
  }
  db.close();
  return path;
}

const rowCount = (path: string, table: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("rooms from before group chats", () => {
  for (const [era, schema, withChats] of [["0.5", SCHEMA_05, true], ["0.2", SCHEMA_02, false]] as const) {
    test(`a ${era} database: every multi-agent room is a group chat, with everything it had`, () => {
      const path = olderDatabase(`old-${era}`, schema, withChats);
      const chatsBefore = withChats ? rowCount(path, "chats") : 0;
      const store = new Store(path);
      try {
        const rooms = Object.fromEntries(store.listRooms().map((r) => [r.id, r]));
        // A group chat is shown as its lead's kind of agent (older apps show one), else its first agent's, else Claude Code.
        expect(rooms.r_review.chat).toEqual({ provider: "claude", origin: "web", group: true });
        expect(rooms.r_turns.chat).toEqual({ provider: "mock", origin: "web", group: true });
        expect(rooms.r_empty.chat).toEqual({ provider: "claude", origin: "web", group: true });
        if (withChats) expect(rooms.r_chat.chat).toEqual({ provider: "claude", origin: "claude-app" });
        // Nothing else of the room changes: its mode, lead, limits and times.
        expect(rooms.r_review).toMatchObject({ name: "Payments API", mode: "review", leadMemberId: "mb_builder", maxHops: 5, createdAt: T, updatedAt: T + 50, archived: false });
        expect(rooms.r_turns.mode).toBe("roundrobin");

        // Its agents keep their settings, their sessions and what they've read.
        const members = store.listMembers("r_review");
        expect(members.map((m) => [m.handle, m.provider, m.model, m.permissionMode, m.config])).toEqual([
          ["builder", "claude", "claude-opus-5-5", "edits", { effort: "high" }],
          ["reviewer", "codex", "gpt-5.5", "edits", { account: "work" }],
        ]);
        expect(store.getMemberSession<Record<string, unknown>>("mb_builder")).toEqual({ sessionId: "s-builder" });
        expect(store.getMemberSession<Record<string, unknown>>("mb_reviewer")).toEqual({ threadId: "th-reviewer" });
        expect(store.getLastSeen("mb_reviewer").seq).toBe(3);

        // Its conversation, the replies' turns and steps, and the approvals are all there.
        expect(store.listMessages("r_review").map((m) => [m.authorKind, m.memberId, m.text])).toEqual([
          ["human", null, "Build the checkout"],
          ["agent", "mb_builder", "Built it: checkout.ts"],
          ["agent", "mb_reviewer", "APPROVED: looks right"],
        ]);
        expect(store.listTurns("r_review").map((t) => [t.id, t.memberId, t.status, t.usage?.outputTokens ?? null])).toEqual([
          ["t_build", "mb_builder", "done", 120],
          ["t_review", "mb_reviewer", "done", null],
        ]);
        expect(store.listActivities("r_review", ["t_build"]).map((a) => a.title)).toEqual(["bun test"]);
        expect(store.listApprovals("r_review").map((a) => [a.id, a.status])).toEqual([["ap_1", "approved"]]);
        expect(store.roomTokenTotals("r_review")).toMatchObject({ inputTokens: 900, outputTokens: 120 });
      } finally {
        store.close();
      }
      // Kept on the room, not as a chat: an older hub opening this database later still finds its rooms, as rooms.
      if (withChats) expect(rowCount(path, "chats")).toBe(chatsBefore);
    });
  }

  test("opening it again changes nothing more, and a later chat with one agent stays one", () => {
    const path = olderDatabase("again", SCHEMA_05, true);
    new Store(path).close();
    const store = new Store(path);
    try {
      expect(store.foldRooms()).toBe(0);
      expect(store.listRooms().filter((r) => r.chat?.group).map((r) => r.id).sort()).toEqual(["r_empty", "r_review", "r_turns"]);
      expect(store.getRoom("r_chat")?.chat?.group).toBeUndefined();
      // The old modes work like the lead answering; everyone in turn and Build & review stay as they were.
      store.normalizeRoomModes();
      expect(["r_review", "r_turns", "r_empty"].map((id) => store.getRoom(id)?.mode)).toEqual(["review", "roundrobin", "direct"]);
      // A group chat's lead decides how older apps show it.
      store.updateRoom("r_review", { leadMemberId: "mb_reviewer" });
      expect(store.getRoom("r_review")?.chat?.provider).toBe("codex");
    } finally {
      store.close();
    }
  });
});

describe("an older database opened by the hub", () => {
  test("its rooms are group chats that work: everyone in turn answers, each reading the replies before it", async () => {
    const path = olderDatabase("app", SCHEMA_05, true);
    const app = new App({ dbPath: path, config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
    const deps = (app.engine as unknown as { deps: EngineDeps }).deps;
    deps.createDriver = (ctx) => new MockDriver(ctx);
    deps.agentEnv = () => ({});
    deps.resolveBin = () => "";
    deps.endpointFor = () => null;
    deps.turnNotice = () => null;
    try {
      // What the app lists: the rooms as group chats, the relay room working like the lead answering.
      const rooms = Object.fromEntries(app.snapshot({ id: "d", name: "Phone", platform: "", createdAt: 0, lastSeenAt: null }).rooms.map((r) => [r.id, r]));
      expect(rooms.r_turns.chat?.group).toBe(true);
      expect(rooms.r_empty.mode).toBe("direct");
      app.engine.postHumanMessage("r_turns", "hello", "Phone");
      await Bun.sleep(5);
      await app.engine.whenIdle();
      const replies = app.store.listMessages("r_turns").filter((m) => m.authorKind === "agent");
      expect(replies.map((m) => [m.authorName, m.status])).toEqual([["one", "done"], ["two", "done"]]);
      // The mock quotes the last line it read: the second one read the first one's reply.
      expect(replies[1].text).toContain(replies[0].text);
    } finally {
      await app.engine.shutdown();
      app.store.close();
    }
  });
});
