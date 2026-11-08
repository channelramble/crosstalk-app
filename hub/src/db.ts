import { Database } from "bun:sqlite";
import { resolve as resolvePath } from "node:path";
import { PROVIDER_INFO } from "@crosstalk/shared";
import type {
  Activity,
  Approval,
  ChatOrigin,
  Device,
  Member,
  Message,
  Room,
  Turn,
  UsageSnapshot,
  Provider,
  RoomActivity,
} from "@crosstalk/shared";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'relay',
  lead_member_id TEXT,
  max_hops INTEGER NOT NULL DEFAULT 6,
  rounds INTEGER NOT NULL DEFAULT 1,
  parallel INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  group_chat INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  role TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  status TEXT NOT NULL DEFAULT 'idle',
  status_detail TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  session TEXT NOT NULL DEFAULT '{}',
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  roster_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(room_id, handle)
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL,
  member_id TEXT,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, seq);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  trigger_message_id TEXT,
  reply_message_id TEXT,
  hop INTEGER NOT NULL DEFAULT 0,
  chain_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  usage TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS turns_room ON turns(room_id, created_at);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_turn ON activities(turn_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage (
  provider TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_history (
  provider TEXT NOT NULL,
  ts INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_history_p ON usage_history(provider, ts);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One-agent chats (the app's conversations). local_id: the Claude Code session or Codex thread it continues;
-- sync: how much of that conversation's own history has already been brought into the chat.
CREATE TABLE IF NOT EXISTS chats (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'web',
  local_id TEXT,
  sync TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- Messages kept in Bookmarks (bookmarks.ts). One goes with its message: unsent, rewound away, or with its chat.
CREATE TABLE IF NOT EXISTS bookmarks (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
`;

/**
 * Room rows come with their chat (if any), so every room read carries it. A group chat (rooms.group_chat: kept on the
 * room, not in chats, so an older hub still sees a room there) is shown as its lead's kind of agent to older apps.
 */
const ROOM_SELECT = `SELECT r.*, c.provider AS chat_provider, c.origin AS chat_origin,
  CASE WHEN c.room_id IS NULL AND r.group_chat = 1 THEN COALESCE(
    (SELECT m.provider FROM members m WHERE m.id = r.lead_member_id),
    (SELECT m.provider FROM members m WHERE m.room_id = r.id ORDER BY m.position, m.created_at LIMIT 1),
    'claude') END AS group_provider
  FROM rooms r LEFT JOIN chats c ON c.room_id = r.id`;

const j = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const toRoom = (r: any): Room => ({
  id: r.id,
  name: r.name,
  cwd: resolvePath(r.cwd),
  mode: r.mode,
  leadMemberId: r.lead_member_id,
  maxHops: r.max_hops,
  rounds: r.rounds,
  parallel: !!r.parallel,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archived: !!r.archived,
  chat: r.chat_provider ? { provider: r.chat_provider, origin: r.chat_origin } : r.group_provider ? { provider: r.group_provider, origin: "web", group: true } : null,
  privateFromAgents: !!r.private_agents,
  ...(r.last_reply_at ? { lastReplyAt: r.last_reply_at } : {}),
  ...(r.read_at ? { readAt: r.read_at } : {}),
  ...(r.pinned_at ? { pinnedAt: r.pinned_at, pinOrder: r.pin_order ?? 0 } : {}),
});

const toMember = (r: any): Member => ({
  ...(typeof j<Record<string, unknown>>(r.session, {}).model === "string" ? { resolvedModel: j<Record<string, unknown>>(r.session, {}).model as string } : {}),
  id: r.id,
  roomId: r.room_id,
  handle: r.handle,
  provider: r.provider,
  model: r.model,
  role: r.role,
  permissionMode: r.permission_mode,
  status: r.status,
  statusDetail: r.status_detail,
  config: j(r.config, {}),
  createdAt: r.created_at,
  position: r.position,
  readSeq: r.last_seen_seq ?? 0,
  ...(r.wait ? { wait: j<Member["wait"]>(r.wait, null) } : {}),
  ...(r.held ? { held: j<Member["held"]>(r.held, null) } : {}),
});

const toMessage = (r: any): Message => ({
  id: r.id,
  roomId: r.room_id,
  authorKind: r.author_kind,
  memberId: r.member_id,
  authorName: r.author_name,
  text: r.text,
  mentions: j(r.mentions, []),
  turnId: r.turn_id,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  via: r.via ? j(r.via, null) : null,
  ...(r.copy ? { copy: j(r.copy, null) } : {}),
  ...(typeof r.seq === "number" ? { seq: r.seq } : {}),
});

const toTurn = (r: any): Turn => ({
  id: r.id,
  roomId: r.room_id,
  memberId: r.member_id,
  triggerMessageId: r.trigger_message_id,
  replyMessageId: r.reply_message_id,
  hop: r.hop,
  chainId: r.chain_id,
  origin: r.origin ?? null,
  status: r.status,
  error: r.error,
  usage: j(r.usage, null),
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  ...(r.wait ? { wait: j(r.wait, null) as Turn["wait"] } : {}),
});

const toActivity = (r: any): Activity => ({
  id: r.id,
  roomId: r.room_id,
  turnId: r.turn_id,
  memberId: r.member_id,
  kind: r.kind,
  title: r.title,
  detail: r.detail,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toApproval = (r: any): Approval => ({
  id: r.id,
  roomId: r.room_id,
  memberId: r.member_id,
  turnId: r.turn_id,
  kind: r.kind,
  title: r.title,
  detail: r.detail,
  status: r.status,
  decision: r.decision,
  decidedBy: r.decided_by,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  questions: r.questions ? JSON.parse(r.questions) : null,
  answers: r.answers ? JSON.parse(r.answers) : null,
  // Approvals saved before "Always allow" said what it allows have no wording: the app shows its plain button.
  ...(r.always !== null && r.always !== undefined ? { always: r.always === "" ? null : r.always } : {}),
  ...(r.delivery === "async" ? { delivery: "async" as const } : {}),
  ...(typeof r.auto_resolve_ms === "number" ? { autoResolveMs: r.auto_resolve_ms } : {}),
  ...(typeof r.auto_resolve_at === "number" ? { autoResolveAt: r.auto_resolve_at } : {}),
});

const toDevice = (r: any): Device => ({
  id: r.id,
  name: r.name,
  platform: r.platform,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  scope: r.scope === "peer" ? "peer" : "full",
  hubId: r.hub_id ?? null,
});

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Small additive migrations for databases created by older hubs. */
  private migrate() {
    const cols = (this.db.query("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("provider")) {
      // Which kind of agent took each turn, kept even after that agent is removed from the room (room icons).
      this.db.exec("ALTER TABLE turns ADD COLUMN provider TEXT");
      this.db.exec("UPDATE turns SET provider = (SELECT provider FROM members WHERE members.id = turns.member_id) WHERE provider IS NULL");
    }
    // Why each turn was queued (human, loop, mention): decides whether a reviewer's reply continues the loop.
    if (!cols.includes("origin")) this.db.exec("ALTER TABLE turns ADD COLUMN origin TEXT");
    // A reply waiting for a usage limit to reset (Turn.wait, status "waiting"): kept here, so it still carries on
    // after a restart, a deploy or a reboot.
    if (!cols.includes("wait")) this.db.exec("ALTER TABLE turns ADD COLUMN wait TEXT");
    const memberCols = (this.db.query("PRAGMA table_info(members)").all() as { name: string }[]).map((c) => c.name);
    // Replies that were still being written when an agent last read the chat: delivered once they're finished.
    if (!memberCols.includes("pending_seen")) this.db.exec("ALTER TABLE members ADD COLUMN pending_seen TEXT NOT NULL DEFAULT '[]'");
    // The usage limit an agent waits for (Member.wait), so its chats say when it comes back in the reader's own clock.
    if (!memberCols.includes("wait")) this.db.exec("ALTER TABLE members ADD COLUMN wait TEXT");
    // Settings that wait for an agent's reply or helpers to finish (Member.held): only while its process runs.
    if (!memberCols.includes("held")) this.db.exec("ALTER TABLE members ADD COLUMN held TEXT");
    // Questions an agent asks you, and your answers (JSON).
    const approvalCols = (this.db.query("PRAGMA table_info(approvals)").all() as { name: string }[]).map((c) => c.name);
    if (!approvalCols.includes("questions")) this.db.exec("ALTER TABLE approvals ADD COLUMN questions TEXT");
    if (!approvalCols.includes("answers")) this.db.exec("ALTER TABLE approvals ADD COLUMN answers TEXT");
    // What "Always allow" allows, in words ("" when it can only be allowed once; NULL when not said).
    if (!approvalCols.includes("always")) this.db.exec("ALTER TABLE approvals ADD COLUMN always TEXT");
    // Questions the agent didn't wait for ("async", Approval.delivery), and for one it doesn't need, how long it waits
    // once a device shows it and when it goes on without you (Approval.autoResolveMs, autoResolveAt).
    if (!approvalCols.includes("delivery")) this.db.exec("ALTER TABLE approvals ADD COLUMN delivery TEXT");
    if (!approvalCols.includes("auto_resolve_at")) this.db.exec("ALTER TABLE approvals ADD COLUMN auto_resolve_at INTEGER");
    if (!approvalCols.includes("auto_resolve_ms")) this.db.exec("ALTER TABLE approvals ADD COLUMN auto_resolve_ms INTEGER");
    // Sign-ins of other machines' hubs ("peer": only what their agents need), and the codes that make them.
    const deviceCols = (this.db.query("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name);
    if (!deviceCols.includes("scope")) this.db.exec("ALTER TABLE devices ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'");
    if (!deviceCols.includes("hub_id")) this.db.exec("ALTER TABLE devices ADD COLUMN hub_id TEXT");
    const codeCols = (this.db.query("PRAGMA table_info(pairing_codes)").all() as { name: string }[]).map((c) => c.name);
    if (!codeCols.includes("scope")) this.db.exec("ALTER TABLE pairing_codes ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'");
    if (!codeCols.includes("hub_id")) this.db.exec("ALTER TABLE pairing_codes ADD COLUMN hub_id TEXT");
    // Messages from other chats' agents (where they came from, JSON), and chats kept away from other agents.
    const messageCols = (this.db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    if (!messageCols.includes("via")) this.db.exec("ALTER TABLE messages ADD COLUMN via TEXT");
    // A duplicated chat's lines and copied replies (where they link to, who wrote them; JSON).
    if (!messageCols.includes("copy")) this.db.exec("ALTER TABLE messages ADD COLUMN copy TEXT");
    const roomCols = (this.db.query("PRAGMA table_info(rooms)").all() as { name: string }[]).map((c) => c.name);
    if (!roomCols.includes("private_agents")) this.db.exec("ALTER TABLE rooms ADD COLUMN private_agents INTEGER NOT NULL DEFAULT 0");
    // When an agent's reply last ended in each room, and up to when the user has read it (on any device).
    if (!roomCols.includes("last_reply_at")) this.db.exec("ALTER TABLE rooms ADD COLUMN last_reply_at INTEGER");
    if (!roomCols.includes("read_at")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN read_at INTEGER");
      // Rooms from before count as read up to their last activity: nothing looks unread the day this arrives.
      this.db.exec("UPDATE rooms SET read_at = updated_at");
    }
    // Chats pinned to the top of the list on every device (when; NULL: not pinned), and their place there (lowest
    // first). Pinning isn't activity: updated_at stays, so the recency list doesn't move.
    if (!roomCols.includes("pinned_at")) this.db.exec("ALTER TABLE rooms ADD COLUMN pinned_at INTEGER");
    if (!roomCols.includes("pin_order")) this.db.exec("ALTER TABLE rooms ADD COLUMN pin_order REAL");
    // Group chats: several agents in one chat. Every room that isn't a chat with one agent is one (the multi-agent
    // rooms from before them, with all their messages, agents and sessions), so it lists and opens like any chat.
    if (!roomCols.includes("group_chat")) this.db.exec("ALTER TABLE rooms ADD COLUMN group_chat INTEGER NOT NULL DEFAULT 0");
    this.foldRooms();
    // Messages between chats: what arrived here (to deduplicate and to tell which turn read it), and what agents here
    // sent (for their limits and for waiting on replies).
    this.db.exec(`CREATE TABLE IF NOT EXISTS xchat_in (
      request_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL,
      from_hub TEXT NOT NULL,
      kind TEXT NOT NULL,
      turn_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS xchat_out (
      message_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      anchor_id TEXT NOT NULL,
      hub_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  close() {
    this.db.close();
  }

  // ---------- rooms ----------
  /**
   * Finished turns and output tokens per kind of agent, per room (most work first). Each turn records its kind of
   * agent, so agents that were since removed from a room still count.
   */
  roomActivity(roomId?: string): Record<string, RoomActivity[]> {
    const rows = this.db
      .query(
        `SELECT t.room_id AS roomId, t.provider AS provider, COUNT(*) AS turns,
                COALESCE(SUM(CAST(json_extract(t.usage, '$.outputTokens') AS INTEGER)), 0) AS outputTokens
         FROM turns t
         WHERE t.status = 'done' AND t.provider IS NOT NULL ${roomId ? "AND t.room_id = $room" : ""}
         GROUP BY t.room_id, t.provider`,
      )
      .all(roomId ? { room: roomId } : {}) as { roomId: string; provider: Provider; turns: number; outputTokens: number }[];
    const out: Record<string, RoomActivity[]> = {};
    // Turns by a kind of agent this hub no longer supports don't count (there's no icon to show for them).
    for (const r of rows) if (r.provider in PROVIDER_INFO) (out[r.roomId] ??= []).push({ provider: r.provider, turns: r.turns, outputTokens: r.outputTokens });
    for (const list of Object.values(out)) list.sort((a, b) => b.turns - a.turns || b.outputTokens - a.outputTokens);
    return out;
  }

  /**
   * One-time migration: the older modes (lead, relay) work like Off ("direct"), where the lead answers. Build & review
   * stays, and so does round-robin: a group chat where everyone answers in turn.
   */
  normalizeRoomModes() {
    this.db.query("UPDATE rooms SET mode = 'direct' WHERE mode NOT IN ('review','direct','roundrobin')").run();
  }

  /** Rooms that aren't chats with one agent become group chats (nothing else of theirs changes). Returns how many. */
  foldRooms(): number {
    return this.db.query("UPDATE rooms SET group_chat = 1 WHERE group_chat = 0 AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.room_id = rooms.id)").run().changes;
  }

  /** Texts of a room's messages that mention an upload, for working out which uploads are still in use. */
  uploadMentions(roomId: string): string[] {
    return (this.db.query("SELECT text FROM messages WHERE room_id = ? AND text LIKE '%/api/rooms/%'").all(roomId) as { text: string }[]).map((r) => r.text);
  }

  listRooms(): Room[] {
    return this.db.query(`${ROOM_SELECT} WHERE r.archived = 0 ORDER BY r.updated_at DESC`).all().map(toRoom);
  }
  getRoom(id: string): Room | null {
    const r = this.db.query(`${ROOM_SELECT} WHERE r.id = ?`).get(id);
    return r ? toRoom(r) : null;
  }

  // ---------- chats ----------
  insertChat(c: { roomId: string; provider: Provider; origin: ChatOrigin; localId: string | null }) {
    this.db
      .query("INSERT INTO chats (room_id, provider, origin, local_id, created_at) VALUES (?,?,?,?,?)")
      .run(c.roomId, c.provider, c.origin, c.localId, Date.now());
  }
  getChat(roomId: string): { roomId: string; provider: Provider; origin: ChatOrigin; localId: string | null; sync: Record<string, unknown> } | null {
    const r = this.db.query("SELECT * FROM chats WHERE room_id = ?").get(roomId) as any;
    return r ? { roomId: r.room_id, provider: r.provider, origin: r.origin, localId: r.local_id, sync: j(r.sync, {}) } : null;
  }
  setChatSync(roomId: string, sync: Record<string, unknown>) {
    this.db.query("UPDATE chats SET sync = ? WHERE room_id = ?").run(JSON.stringify(sync), roomId);
  }
  setChatLocalId(roomId: string, localId: string) {
    this.db.query("UPDATE chats SET local_id = ? WHERE room_id = ?").run(localId, roomId);
  }
  /** Chat room id for each local conversation (Claude session / Codex thread) a chat continues, for one agent. */
  chatsByLocalId(provider: Provider): Map<string, string> {
    const rows = this.db.query("SELECT room_id, local_id FROM chats WHERE provider = ? AND local_id IS NOT NULL").all(provider) as { room_id: string; local_id: string }[];
    return new Map(rows.map((r) => [r.local_id, r.room_id]));
  }
  insertRoom(r: Room) {
    this.db
      .query(
        `INSERT INTO rooms (id,name,cwd,mode,lead_member_id,max_hops,rounds,parallel,created_at,updated_at,archived,private_agents,group_chat)
         VALUES ($id,$name,$cwd,$mode,$lead,$maxHops,$rounds,$parallel,$createdAt,$updatedAt,$archived,$privateAgents,$group)`,
      )
      .run({
        id: r.id,
        name: r.name,
        cwd: r.cwd,
        mode: r.mode,
        lead: r.leadMemberId,
        maxHops: r.maxHops,
        rounds: r.rounds,
        parallel: r.parallel ? 1 : 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        archived: r.archived ? 1 : 0,
        privateAgents: r.privateFromAgents ? 1 : 0,
        group: r.chat?.group ? 1 : 0,
      });
  }
  updateRoom(id: string, patch: Partial<Room>): Room | null {
    const cur = this.getRoom(id);
    if (!cur) return null;
    const n: Room = { ...cur, ...patch, id, updatedAt: Date.now() };
    this.db
      .query(
        `UPDATE rooms SET name=$name, cwd=$cwd, mode=$mode, lead_member_id=$lead, max_hops=$maxHops, rounds=$rounds,
         parallel=$parallel, updated_at=$updatedAt, archived=$archived, private_agents=$privateAgents WHERE id=$id`,
      )
      .run({
        id,
        name: n.name,
        cwd: n.cwd,
        mode: n.mode,
        lead: n.leadMemberId,
        maxHops: n.maxHops,
        rounds: n.rounds,
        parallel: n.parallel ? 1 : 0,
        updatedAt: n.updatedAt,
        archived: n.archived ? 1 : 0,
        privateAgents: n.privateFromAgents ? 1 : 0,
      });
    return n;
  }
  touchRoom(id: string, at = Date.now()) {
    this.db.query("UPDATE rooms SET updated_at = ? WHERE id = ?").run(at, id);
  }
  /** An agent's reply just ended in a room. */
  noteReply(id: string, at = Date.now()) {
    this.db.query("UPDATE rooms SET last_reply_at = ? WHERE id = ?").run(at, id);
  }
  /** The user has read a room up to `at`: the later of that and what was already read is kept. */
  markRead(id: string, at: number): Room | null {
    this.db.query("UPDATE rooms SET read_at = MAX(COALESCE(read_at, 0), ?) WHERE id = ?").run(at, id);
    return this.getRoom(id);
  }
  /** Pins a room (when, and its place among the pinned) or unpins it (null). Never its updatedAt: that's activity. */
  setPin(id: string, pin: { at: number; order: number } | null): Room | null {
    this.db.query("UPDATE rooms SET pinned_at = ?, pin_order = ? WHERE id = ?").run(pin?.at ?? null, pin?.order ?? null, id);
    return this.getRoom(id);
  }
  /** The top place among this hub's pinned rooms (the lowest), or null when none is pinned. */
  topPinOrder(): number | null {
    const r = this.db.query("SELECT MIN(pin_order) AS top FROM rooms WHERE pinned_at IS NOT NULL AND archived = 0").get() as { top: number | null } | null;
    return r?.top ?? null;
  }
  deleteRoom(id: string) {
    this.db.query("DELETE FROM rooms WHERE id = ?").run(id);
  }

  // ---------- members ----------
  /** Members whose kind of agent isn't one of `known` (a kind this hub no longer supports). */
  membersOfUnknownKind(known: string[]): { id: string; roomId: string; handle: string; provider: string }[] {
    const rows = this.db.query("SELECT id, room_id, handle, provider FROM members").all() as { id: string; room_id: string; handle: string; provider: string }[];
    return rows.filter((r) => !known.includes(r.provider)).map((r) => ({ id: r.id, roomId: r.room_id, handle: r.handle, provider: r.provider }));
  }

  listMembers(roomId?: string): Member[] {
    const rows = roomId
      ? this.db.query("SELECT * FROM members WHERE room_id = ? ORDER BY position, created_at").all(roomId)
      : this.db
          .query(
            "SELECT m.* FROM members m JOIN rooms r ON r.id = m.room_id WHERE r.archived = 0 ORDER BY m.position, m.created_at",
          )
          .all();
    return rows.map(toMember);
  }
  getMember(id: string): Member | null {
    const r = this.db.query("SELECT * FROM members WHERE id = ?").get(id);
    return r ? toMember(r) : null;
  }
  insertMember(m: Member) {
    this.db
      .query(
        `INSERT INTO members (id,room_id,handle,provider,model,role,permission_mode,status,status_detail,config,created_at,position)
         VALUES ($id,$roomId,$handle,$provider,$model,$role,$pm,$status,$sd,$config,$createdAt,$position)`,
      )
      .run({
        id: m.id,
        roomId: m.roomId,
        handle: m.handle,
        provider: m.provider,
        model: m.model,
        role: m.role,
        pm: m.permissionMode,
        status: m.status,
        sd: m.statusDetail,
        config: JSON.stringify(m.config ?? {}),
        createdAt: m.createdAt,
        position: m.position,
      });
  }
  updateMember(id: string, patch: Partial<Member>): Member | null {
    const cur = this.getMember(id);
    if (!cur) return null;
    const n: Member = { ...cur, ...patch, id };
    this.db
      .query(
        `UPDATE members SET handle=$handle, model=$model, role=$role, permission_mode=$pm, status=$status,
         status_detail=$sd, wait=$wait, held=$held, config=$config, position=$position WHERE id=$id`,
      )
      .run({
        id,
        handle: n.handle,
        model: n.model,
        role: n.role,
        pm: n.permissionMode,
        status: n.status,
        sd: n.statusDetail,
        wait: n.wait ? JSON.stringify(n.wait) : null,
        held: n.held ? JSON.stringify(n.held) : null,
        config: JSON.stringify(n.config ?? {}),
        position: n.position,
      });
    return n;
  }
  deleteMember(id: string) {
    this.db.query("DELETE FROM members WHERE id = ?").run(id);
  }
  getMemberSession<T = Record<string, unknown>>(id: string): T {
    const r = this.db.query("SELECT session FROM members WHERE id = ?").get(id) as { session: string } | null;
    return j(r?.session ?? null, {} as T);
  }
  setMemberSession(id: string, session: Record<string, unknown>) {
    this.db.query("UPDATE members SET session = ? WHERE id = ?").run(JSON.stringify(session), id);
  }
  /** What an agent has read: every message up to `seq`, except `pending` (replies that were still being written). */
  getLastSeen(id: string): { seq: number; rosterVersion: number; pending: number[] } {
    const r = this.db.query("SELECT last_seen_seq, roster_version, pending_seen FROM members WHERE id = ?").get(id) as any;
    return { seq: r?.last_seen_seq ?? 0, rosterVersion: r?.roster_version ?? 0, pending: j(r?.pending_seen, [] as number[]) };
  }
  setLastSeen(id: string, seq: number, rosterVersion: number, pending: number[] = []) {
    this.db.query("UPDATE members SET last_seen_seq = ?, roster_version = ?, pending_seen = ? WHERE id = ?").run(seq, rosterVersion, JSON.stringify(pending), id);
  }
  resetAllMemberStatus() {
    this.db.query("UPDATE members SET status = 'idle', status_detail = NULL, wait = NULL WHERE status != 'idle'").run();
    // Nothing waits for a process that a restart ended.
    this.db.query("UPDATE members SET held = NULL WHERE held IS NOT NULL").run();
  }

  // ---------- messages ----------
  insertMessage(m: Message): number {
    const res = this.db
      .query(
        `INSERT INTO messages (id,room_id,author_kind,member_id,author_name,text,mentions,turn_id,status,created_at,updated_at,via,copy)
         VALUES ($id,$roomId,$ak,$memberId,$an,$text,$mentions,$turnId,$status,$createdAt,$updatedAt,$via,$copy)`,
      )
      .run({
        id: m.id,
        roomId: m.roomId,
        ak: m.authorKind,
        memberId: m.memberId,
        an: m.authorName,
        text: m.text,
        mentions: JSON.stringify(m.mentions),
        turnId: m.turnId,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        via: m.via ? JSON.stringify(m.via) : null,
        copy: m.copy ? JSON.stringify(m.copy) : null,
      });
    return Number(res.lastInsertRowid);
  }
  updateMessage(id: string, patch: Partial<Pick<Message, "text" | "status" | "mentions">>): Message | null {
    const cur = this.getMessage(id);
    if (!cur) return null;
    const n = { ...cur, ...patch, updatedAt: Date.now() };
    this.db
      .query("UPDATE messages SET text=$text, status=$status, mentions=$mentions, updated_at=$u WHERE id=$id")
      .run({ id, text: n.text, status: n.status, mentions: JSON.stringify(n.mentions), u: n.updatedAt });
    return n;
  }
  getMessage(id: string): Message | null {
    const r = this.db.query("SELECT * FROM messages WHERE id = ?").get(id);
    return r ? toMessage(r) : null;
  }
  /** Removes a room's messages from `fromSeq` on (a rewind); returns their ids. */
  deleteMessagesFrom(roomId: string, fromSeq: number): string[] {
    const ids = (this.db.query("SELECT id FROM messages WHERE room_id = ? AND seq >= ?").all(roomId, fromSeq) as { id: string }[]).map((r) => r.id);
    this.db.query("DELETE FROM messages WHERE room_id = ? AND seq >= ?").run(roomId, fromSeq);
    return ids;
  }
  /**
   * Turns whose replies are gone from the chat (rewound or unsent), with their steps and answered approvals: nothing
   * shows them any more. Returns their ids.
   */
  deleteTurnsWithoutReplies(roomId: string): string[] {
    const ids = (
      this.db
        .query("SELECT id FROM turns t WHERE t.room_id = ? AND t.status NOT IN ('running', 'queued') AND t.reply_message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = t.reply_message_id)")
        .all(roomId) as { id: string }[]
    ).map((r) => r.id);
    for (const id of ids) {
      this.db.query("DELETE FROM activities WHERE turn_id = ?").run(id);
      this.db.query("DELETE FROM approvals WHERE turn_id = ? AND status != 'pending'").run(id);
      this.db.query("DELETE FROM turns WHERE id = ?").run(id);
    }
    return ids;
  }
  deleteMessage(id: string) {
    this.db.query("DELETE FROM messages WHERE id = ?").run(id);
  }
  messageSeq(id: string): number {
    const r = this.db.query("SELECT seq FROM messages WHERE id = ?").get(id) as { seq: number } | null;
    return r?.seq ?? 0;
  }
  /** The seq of an agent's newest reply before `beforeSeq` in a room, 0 when it has none. */
  lastReplySeq(roomId: string, memberId: string, beforeSeq: number): number {
    const r = this.db.query("SELECT MAX(seq) AS s FROM messages WHERE room_id = ? AND member_id = ? AND author_kind = 'agent' AND seq < ?").get(roomId, memberId, beforeSeq) as { s: number | null } | null;
    return r?.s ?? 0;
  }
  listMessages(roomId: string, opts: { beforeSeq?: number; limit?: number } = {}): (Message & { seq: number })[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.beforeSeq
      ? this.db
          .query("SELECT * FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
          .all(roomId, opts.beforeSeq, limit)
      : this.db.query("SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?").all(roomId, limit);
    return rows.reverse().map((r: any) => ({ ...toMessage(r), seq: r.seq }));
  }
  /** The newest `limit` finished messages after `afterSeq`, oldest first. */
  messagesAfter(roomId: string, afterSeq: number, limit = 500): (Message & { seq: number })[] {
    return this.db
      .query("SELECT * FROM (SELECT * FROM messages WHERE room_id = ? AND seq > ? AND status != 'streaming' ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC")
      .all(roomId, afterSeq, limit)
      .map((r: any) => ({ ...toMessage(r), seq: r.seq }));
  }
  countMessagesAfter(roomId: string, afterSeq: number): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND seq > ? AND status != 'streaming'").get(roomId, afterSeq) as { n: number };
    return r?.n ?? 0;
  }
  /** Instructions after `afterSeq`, however many other messages came since: the human's, and those that @mention `memberId`. */
  instructionsAfter(roomId: string, afterSeq: number, memberId: string): (Message & { seq: number })[] {
    return this.db
      .query(
        `SELECT * FROM messages WHERE room_id = ? AND seq > ? AND status != 'streaming'
           AND (author_kind = 'human' OR EXISTS (SELECT 1 FROM json_each(messages.mentions) WHERE value = ?)) ORDER BY seq ASC`,
      )
      .all(roomId, afterSeq, memberId)
      .map((r: any) => ({ ...toMessage(r), seq: r.seq }));
  }
  /** Finished messages among `seqs` (replies that were still streaming when an agent last read the chat). */
  messagesBySeq(roomId: string, seqs: number[]): (Message & { seq: number })[] {
    if (!seqs.length) return [];
    return this.db
      .query(`SELECT * FROM messages WHERE room_id = ? AND seq IN (${seqs.map(() => "?").join(",")}) AND status != 'streaming' ORDER BY seq ASC`)
      .all(roomId, ...seqs)
      .map((r: any) => ({ ...toMessage(r), seq: r.seq }));
  }
  /** Seqs of other agents' replies that are still being written. */
  streamingSeqs(roomId: string, exceptMemberId: string): number[] {
    return (this.db.query("SELECT seq FROM messages WHERE room_id = ? AND status = 'streaming' AND (member_id IS NULL OR member_id != ?)").all(roomId, exceptMemberId) as { seq: number }[]).map((r) => r.seq);
  }
  /** Finished review-loop turns by one agent in a chain (review rounds). */
  countLoopTurns(chainId: string, memberId: string): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM turns WHERE chain_id = ? AND member_id = ? AND origin = 'loop' AND status = 'done'").get(chainId, memberId) as { n: number };
    return r?.n ?? 0;
  }
  maxSeq(roomId: string): number {
    const r = this.db.query("SELECT MAX(seq) AS s FROM messages WHERE room_id = ?").get(roomId) as { s: number | null };
    return r?.s ?? 0;
  }
  markStreamingStopped() {
    this.db.query("UPDATE messages SET status = 'stopped' WHERE status = 'streaming'").run();
  }

  // ---------- turns ----------
  insertTurn(t: Turn) {
    this.db
      .query(
        `INSERT INTO turns (id,room_id,member_id,trigger_message_id,reply_message_id,hop,chain_id,status,error,usage,created_at,started_at,ended_at,provider,origin)
         VALUES ($id,$roomId,$memberId,$trig,$reply,$hop,$chain,$status,$error,$usage,$createdAt,$startedAt,$endedAt,(SELECT provider FROM members WHERE id = $memberId),$origin)`,
      )
      .run({
        id: t.id,
        roomId: t.roomId,
        memberId: t.memberId,
        trig: t.triggerMessageId,
        reply: t.replyMessageId,
        hop: t.hop,
        chain: t.chainId,
        origin: t.origin ?? null,
        status: t.status,
        error: t.error,
        usage: t.usage ? JSON.stringify(t.usage) : null,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      });
  }
  updateTurn(id: string, patch: Partial<Turn>): Turn | null {
    const cur = this.getTurn(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db
      .query(
        `UPDATE turns SET reply_message_id=$reply, status=$status, error=$error, usage=$usage, started_at=$s, ended_at=$e,
         trigger_message_id=$trigger, hop=$hop, chain_id=$chain, origin=$origin, wait=$wait WHERE id=$id`,
      )
      .run({
        id,
        trigger: n.triggerMessageId,
        hop: n.hop,
        chain: n.chainId,
        origin: n.origin ?? null,
        reply: n.replyMessageId,
        status: n.status,
        error: n.error,
        usage: n.usage ? JSON.stringify(n.usage) : null,
        wait: n.wait ? JSON.stringify(n.wait) : null,
        s: n.startedAt,
        e: n.endedAt,
      });
    return n;
  }
  /** Replies waiting for a usage limit to reset: picked up again when the hub starts (Engine.checkWaits). */
  waitingTurns(): Turn[] {
    return (this.db.query("SELECT * FROM turns WHERE status = 'waiting' ORDER BY created_at").all() as any[]).map(toTurn);
  }
  getTurn(id: string): Turn | null {
    const r = this.db.query("SELECT * FROM turns WHERE id = ?").get(id);
    return r ? toTurn(r) : null;
  }
  listTurns(roomId: string, limit = 200): Turn[] {
    return this.db
      .query("SELECT * FROM turns WHERE room_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(roomId, limit)
      .reverse()
      .map(toTurn);
  }
  /**
   * A member's newest turn that ran and has ended (done, failed or stopped), if any. A turn that waited and was dropped
   * before it started (Send now handed its message to the running reply, Take back removed it) never ran: it's left
   * out, though it was made after the reply that was running.
   */
  lastEndedTurn(memberId: string): Turn | null {
    const r = this.db
      .query("SELECT * FROM turns WHERE member_id = ? AND status IN ('done','error','stopped') AND started_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(memberId);
    return r ? toTurn(r) : null;
  }
  /** The turns that answered (or tried to answer) one message. */
  turnsFor(messageId: string): Turn[] {
    return (this.db.query("SELECT * FROM turns WHERE trigger_message_id = ? ORDER BY created_at").all(messageId) as any[]).map(toTurn);
  }
  /** Turns that were queued or running when the hub stopped (a restart, or a crash). */
  unfinishedTurns(): Turn[] {
    return (this.db.query("SELECT * FROM turns WHERE status IN ('queued','running') ORDER BY created_at").all() as any[]).map(toTurn);
  }
  failUnfinishedTurns() {
    this.db
      .query("UPDATE turns SET status = 'stopped', error = 'Crosstalk restarted', ended_at = ? WHERE status IN ('queued','running')")
      .run(Date.now());
  }
  roomTokenTotals(roomId: string): { inputTokens: number; outputTokens: number; costUsd: number } {
    const rows = this.db.query("SELECT usage FROM turns WHERE room_id = ? AND usage IS NOT NULL").all(roomId) as any[];
    let inputTokens = 0,
      outputTokens = 0,
      costUsd = 0;
    for (const r of rows) {
      const u = j<any>(r.usage, null);
      if (!u) continue;
      inputTokens += u.inputTokens || 0;
      outputTokens += u.outputTokens || 0;
      costUsd += u.costUsd || 0;
    }
    return { inputTokens, outputTokens, costUsd };
  }

  // ---------- activities ----------
  upsertActivity(a: Activity) {
    this.db
      .query(
        `INSERT INTO activities (id,room_id,turn_id,member_id,kind,title,detail,status,created_at,updated_at)
         VALUES ($id,$roomId,$turnId,$memberId,$kind,$title,$detail,$status,$createdAt,$updatedAt)
         ON CONFLICT(id) DO UPDATE SET kind=$kind, title=$title, detail=$detail, status=$status, updated_at=$updatedAt`,
      )
      .run({ id: a.id, roomId: a.roomId, turnId: a.turnId, memberId: a.memberId, kind: a.kind, title: a.title, detail: a.detail, status: a.status, createdAt: a.createdAt, updatedAt: a.updatedAt });
  }
  getActivity(id: string): Activity | null {
    const r = this.db.query("SELECT * FROM activities WHERE id = ?").get(id);
    return r ? toActivity(r) : null;
  }
  listActivities(roomId: string, turnIds: string[]): Activity[] {
    if (!turnIds.length) return [];
    const placeholders = turnIds.map(() => "?").join(",");
    return this.db
      .query(`SELECT * FROM activities WHERE room_id = ? AND turn_id IN (${placeholders}) ORDER BY created_at`)
      .all(roomId, ...turnIds)
      .map(toActivity);
  }

  // ---------- approvals ----------
  insertApproval(a: Approval) {
    this.db
      .query(
        `INSERT INTO approvals (id,room_id,member_id,turn_id,kind,title,detail,status,decision,decided_by,created_at,decided_at,questions,answers,always,delivery,auto_resolve_ms,auto_resolve_at)
         VALUES ($id,$roomId,$memberId,$turnId,$kind,$title,$detail,$status,$decision,$decidedBy,$createdAt,$decidedAt,$questions,$answers,$always,$delivery,$autoResolveMs,$autoResolveAt)`,
      )
      .run({ id: a.id, roomId: a.roomId, memberId: a.memberId, turnId: a.turnId, kind: a.kind, title: a.title, detail: a.detail, status: a.status, decision: a.decision, decidedBy: a.decidedBy, createdAt: a.createdAt, decidedAt: a.decidedAt, questions: a.questions ? JSON.stringify(a.questions) : null, answers: a.answers ? JSON.stringify(a.answers) : null, always: a.always === undefined ? null : a.always ?? "", delivery: a.delivery ?? null, autoResolveMs: a.autoResolveMs ?? null, autoResolveAt: a.autoResolveAt ?? null });
  }
  updateApproval(id: string, patch: Partial<Approval>): Approval | null {
    const cur = this.getApproval(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db
      .query("UPDATE approvals SET status=$status, decision=$decision, decided_by=$by, decided_at=$at, answers=$answers, auto_resolve_ms=$autoResolveMs, auto_resolve_at=$autoResolveAt WHERE id=$id")
      .run({ id, status: n.status, decision: n.decision, by: n.decidedBy, at: n.decidedAt, answers: n.answers ? JSON.stringify(n.answers) : null, autoResolveMs: n.autoResolveMs ?? null, autoResolveAt: n.autoResolveAt ?? null });
    return n;
  }
  getApproval(id: string): Approval | null {
    const r = this.db.query("SELECT * FROM approvals WHERE id = ?").get(id);
    return r ? toApproval(r) : null;
  }
  listPendingApprovals(): Approval[] {
    return this.db.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all().map(toApproval);
  }
  listApprovals(roomId: string, limit = 100): Approval[] {
    return this.db
      .query("SELECT * FROM approvals WHERE room_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(roomId, limit)
      .reverse()
      .map(toApproval);
  }
  /**
   * A restart: what the agents were waiting for goes, except questions they didn't wait for (Approval.delivery
   * "async"), which are answered with a message whenever.
   */
  expirePendingApprovals() {
    this.db.query("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND delivery IS NOT 'async'").run(Date.now());
  }

  // ---------- usage ----------
  setUsage(u: UsageSnapshot) {
    // Keyed per account: the default account keeps the plain provider key, so existing data stays where it was.
    const key = usageKey(u.provider, u.accountId);
    this.db
      .query(
        "INSERT INTO usage (provider,json,updated_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
      )
      .run(key, JSON.stringify(u), u.updatedAt);
    // Keep a coarse history (one point per account per 10 minutes) for the chart.
    const last = this.db
      .query("SELECT ts FROM usage_history WHERE provider = ? ORDER BY ts DESC LIMIT 1")
      .get(key) as { ts: number } | null;
    if (!last || u.updatedAt - last.ts > 10 * 60_000) {
      this.db.query("INSERT INTO usage_history (provider, ts, json) VALUES (?,?,?)").run(key, u.updatedAt, JSON.stringify(u));
    }
  }
  /** Usage for one account (the default account when `accountId` is missing). */
  getUsage(provider: Provider, accountId?: string): UsageSnapshot | undefined {
    const r = this.db.query("SELECT json FROM usage WHERE provider = ?").get(usageKey(provider, accountId)) as { json: string } | null;
    return r ? JSON.parse(r.json) : undefined;
  }
  deleteUsage(provider: Provider, accountId: string) {
    this.db.query("DELETE FROM usage WHERE provider = ?").run(usageKey(provider, accountId));
  }
  listUsage(): UsageSnapshot[] {
    return (this.db.query("SELECT json FROM usage").all() as any[]).map((r) => JSON.parse(r.json));
  }
  usageHistory(provider: Provider, sinceMs: number, accountId?: string): UsageSnapshot[] {
    return (this.db.query("SELECT json FROM usage_history WHERE provider = ? AND ts >= ? ORDER BY ts").all(usageKey(provider, accountId), sinceMs) as any[]).map(
      (r) => JSON.parse(r.json),
    );
  }

  // ---------- devices & pairing ----------
  insertDevice(d: Device, tokenHash: string) {
    this.db
      .query("INSERT INTO devices (id,name,platform,token_hash,created_at,last_seen_at,scope,hub_id) VALUES (?,?,?,?,?,?,?,?)")
      .run(d.id, d.name, d.platform, tokenHash, d.createdAt, d.lastSeenAt, d.scope === "peer" ? "peer" : "full", d.hubId ?? null);
  }
  getDevice(id: string): Device | null {
    const r = this.db.query("SELECT * FROM devices WHERE id = ? AND revoked = 0").get(id);
    return r ? toDevice(r) : null;
  }
  /** Ties a sign-in to the machine (hub) it belongs to. */
  setDeviceHub(id: string, hubId: string | null) {
    this.db.query("UPDATE devices SET hub_id = ? WHERE id = ?").run(hubId, id);
  }
  /** Every sign-in that belongs to a machine's hub. */
  devicesOfHub(hubId: string): Device[] {
    return this.db.query("SELECT * FROM devices WHERE hub_id = ? AND revoked = 0").all(hubId).map(toDevice);
  }
  deviceByTokenHash(hash: string): Device | null {
    const r = this.db.query("SELECT * FROM devices WHERE token_hash = ? AND revoked = 0").get(hash);
    return r ? toDevice(r) : null;
  }
  listDevices(): Device[] {
    return this.db.query("SELECT * FROM devices WHERE revoked = 0 ORDER BY created_at").all().map(toDevice);
  }
  touchDevice(id: string) {
    this.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  }
  revokeDevice(id: string) {
    this.db.query("UPDATE devices SET revoked = 1 WHERE id = ?").run(id);
  }
  renameDevice(id: string, name: string) {
    this.db.query("UPDATE devices SET name = ? WHERE id = ?").run(name, id);
  }
  /** Messages from other chats that a turn read (xchat.ts tells their senders when the reply is done). */
  markRelaysDelivered(messageIds: string[], turnId: string) {
    const q = this.db.query("UPDATE xchat_in SET turn_id = ? WHERE message_id = ?");
    for (const id of messageIds) q.run(turnId, id);
  }
  insertPairingCode(hash: string, expiresAt: number, opts: { scope?: "full" | "peer"; hubId?: string | null } = {}) {
    this.db
      .query("INSERT INTO pairing_codes (code_hash, created_at, expires_at, scope, hub_id) VALUES (?,?,?,?,?)")
      .run(hash, Date.now(), expiresAt, opts.scope === "peer" ? "peer" : "full", opts.hubId ?? null);
  }
  /** Uses up a pairing code: what the sign-in it makes may do (null when the code is wrong, used or expired). */
  consumePairingCode(hash: string): { scope: "full" | "peer"; hubId: string | null } | null {
    const r = this.db
      .query("SELECT * FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(hash, Date.now()) as { scope?: string; hub_id?: string | null } | null;
    if (!r) return null;
    this.db.query("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?").run(Date.now(), hash);
    return { scope: r.scope === "peer" ? "peer" : "full", hubId: r.hub_id ?? null };
  }

  // ---------- kv ----------
  kvGet(key: string): string | null {
    const r = this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }
  kvSet(key: string, value: string) {
    this.db
      .query("INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
  kvDelete(key: string) {
    this.db.query("DELETE FROM kv WHERE key = ?").run(key);
  }
  /** Deletes every key that starts with `prefix`. */
  kvDeletePrefix(prefix: string) {
    this.db.query("DELETE FROM kv WHERE substr(key, 1, length(?)) = ?").run(prefix, prefix);
  }
}

function usageKey(provider: string, accountId?: string): string {
  return accountId && accountId !== "default" ? `${provider}:${accountId}` : provider;
}
