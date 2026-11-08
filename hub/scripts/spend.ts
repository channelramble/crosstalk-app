// What a chat's agent has cost so far at API prices, from the cost Claude Code reports with each reply. Read only.
// Claude Code reports a running total per process, helpers included. A total lower than the one before means a new
// process, which starts again from part of the old total (what its session file kept), so the reply right after a
// restart can't be priced and counts as nothing: the exact bill is on console.anthropic.com (Usage).
//
//   bun hub/scripts/spend.ts               this chat (its CLAUDE_CODE_SESSION_ID), else the chats with costs today
//   bun hub/scripts/spend.ts <room id>     that chat
//   bun hub/scripts/spend.ts --since <ms>  only replies since then

import { Database } from "bun:sqlite";
import { DB_PATH } from "../src/config";

const args = process.argv.slice(2);
const sinceAt = args.indexOf("--since");
const since = sinceAt >= 0 ? Number(args[sinceAt + 1]) || 0 : 0;
const named = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--since");

const db = new Database(DB_PATH, { readonly: true });

function spent(roomId: string): { usd: number; replies: number; restarts: number; first: number | null; last: number | null } {
  const rows = db.query("SELECT usage, created_at FROM turns WHERE room_id = ? AND usage IS NOT NULL ORDER BY created_at").all(roomId) as { usage: string; created_at: number }[];
  let usd = 0;
  let before = 0;
  let replies = 0;
  let restarts = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const r of rows) {
    let total = 0;
    try {
      total = Number((JSON.parse(r.usage) as { costUsd?: unknown }).costUsd) || 0;
    } catch {
      continue;
    }
    const restarted = total < before;
    const cost = restarted ? 0 : total - before;
    before = total;
    if (r.created_at < since) continue;
    usd += cost;
    replies++;
    if (restarted) restarts++;
    first ??= r.created_at;
    last = r.created_at;
  }
  return { usd, replies, restarts, first, last };
}

const name = (roomId: string) => (db.query("SELECT name FROM rooms WHERE id = ?").get(roomId) as { name?: string } | null)?.name ?? roomId;
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "-");

let rooms: string[] = [];
if (named) rooms = [named];
else {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const own = session ? (db.query("SELECT room_id FROM members WHERE json_extract(session, '$.sessionId') = ? LIMIT 1").get(session) as { room_id?: string } | null) : null;
  if (own?.room_id) rooms = [own.room_id];
  else {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    rooms = (db.query("SELECT DISTINCT room_id FROM turns WHERE usage IS NOT NULL AND created_at >= ?").all(Math.max(since, today.getTime())) as { room_id: string }[]).map((r) => r.room_id);
  }
}

if (!rooms.length) console.log("No replies with a cost yet (a chat's first reply is counted once it ends).");
for (const id of rooms) {
  const s = spent(id);
  const gaps = s.restarts ? `; ${s.restarts} repl${s.restarts === 1 ? "y" : "ies"} right after a restart not counted` : "";
  console.log(`${name(id)}: $${s.usd.toFixed(2)} over ${s.replies} replies (${when(s.first)} to ${when(s.last)}${gaps})`);
}
