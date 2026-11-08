// Search across chats and Markdown export (docs/SPEC-0.4.md section 14, track T8).
//
// Search reads what is already in the messages table: a case-insensitive substring match (SQL LIKE, so only ASCII letters
// fold case), newest first, with no index and no migration (a live database can be 100 MB). The LIKE only narrows the rows
// down: what has to match, and what a snippet quotes, is the message as the chat shows it (`shownText`), not the links and
// the machine's local paths the hub adds for a message's files. It is for people's own devices only (`route`, never
// `peerRoute`) and it includes chats kept private from other chats' agents: that setting limits agents, not the person.

import { SEARCH_MAX_HITS, SEARCH_MIN_CHARS, SEARCH_PER_CHAT, markdownFileName, type ChatExport, type CopiedMessage, type SearchChat, type SearchHit, type SearchResponse } from "@crosstalk/shared";
import type { App } from "./app";
import { TEXT_MAX, exportChat } from "./duplicate";
import { route, type Route } from "./routes";

/** What a snippet keeps of the text before and after the first match. */
const BEFORE = 50;
const AFTER = 90;
/** A longer query would be refused by SQLite's LIKE; nobody types this much. */
const QUERY_MAX = 200;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The LIKE pattern for "contains": the query's own % _ and \ are text, not wildcards. */
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;
const oneLine = (s: string) => s.replace(/\s+/g, " ");

// What the hub adds to a message with files (uploads.ts attachmentText): a line each, with the local path the agent reads.
// Its groups: the file's name (escaped there), "uploads" or "folders", and a folder's " (3 files)".
const ATTACHED = /^- \[((?:\\.|[^\]\\\n])*)\]\(\/api\/rooms\/[^/\s)]+\/(uploads|folders)\/[^)\n]*\)( \(\d+ files?\))? — local path: .*$/gm;

/**
 * A message as the chat shows it where the hub has added to it: its note about files. Search matches and quotes this. As in
 * `shownText` (web/src/views/RoomView.tsx) the note reads "Attachments:" and the machine's local paths are gone; here each
 * file is also just its name, without the link behind it (the chat draws a name or a picture there, never a link's address).
 */
export function shownText(text: string): string {
  // Few messages have files: leave the rest alone, quickly (a search reads every row that holds its words).
  if (!text.includes("Attachments (open these") && !text.includes(" — local path: ")) return text;
  return text
    .replace(/^Attachments \(open these local files only if needed\):$/m, "Attachments:")
    .replace(ATTACHED, (_, name: string, _kind: string, count?: string) => `- ${name.replace(/\\(.)/g, "$1")}${count ?? ""}`)
    // How a folder was listed before it had a link.
    .replace(/^(- Folder [^\n]+? \(\d+ files?\)) — local path: .*$/gm, "$1");
}

/**
 * About 140 characters of `text` around the first place `query` shows (in any case), on one line, with the match itself
 * as written (the app marks it again by looking for the query in it). A cut is marked with "…".
 */
export function snippetOf(text: string, query: string): string {
  const found = new RegExp(escapeRegExp(query), "i").exec(text);
  const at = found?.index ?? 0;
  const len = found?.[0].length ?? 0;
  let from = Math.max(0, at - BEFORE);
  let to = Math.min(text.length, at + len + AFTER);
  // Never cut an emoji in two.
  if (from > 0 && /[\udc00-\udfff]/.test(text[from])) from++;
  if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to--;
  return `${from > 0 ? "…" : ""}${oneLine(text.slice(from, at)).trimStart()}${text.slice(at, at + len)}${oneLine(text.slice(at + len, to)).trimEnd()}${to < text.length ? "…" : ""}`;
}

interface Row {
  seq: number;
  id: string;
  room_id: string;
  name: string;
  author_kind: string;
  via: string | null;
  copy: string | null;
  text: string;
  created_at: number;
  group_chat: number;
  /** The agent that wrote it (its @handle), when it's still in the chat. */
  handle: string | null;
}

/**
 * The agent that wrote a message when it isn't this chat's own, as the chat labels it: another chat's agent that sent it
 * here (`via`), or the agent whose reply was copied here (`copy`). Undefined for you and for this chat's own agent.
 */
function outsideAgent(r: Row): string | undefined {
  const raw = r.author_kind === "human" ? r.via : r.copy;
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { kind?: unknown; agent?: unknown } | null;
    if (r.author_kind === "agent" && v?.kind !== "reply") return undefined;
    const name = typeof v?.agent === "string" ? v.agent.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The messages in any chat that contain `query` (in what the chat shows of them), newest first: at most `limit` (30), at
 * most 3 from one chat, and the chats whose names contain it. A reply still being written, and the notes Crosstalk adds
 * itself (system), are skipped.
 */
export function searchChats(app: App, query: string, limit = SEARCH_MAX_HITS): SearchResponse {
  const q = query.trim().slice(0, QUERY_MAX);
  if (q.length < SEARCH_MIN_CHARS) return { results: [], chats: [], truncated: false };
  const max = Math.max(1, Math.min(SEARCH_MAX_HITS, Math.floor(limit) || SEARCH_MAX_HITS));
  const like = likeOf(q);
  const db = app.store.db;
  // Newest first by place in the table (the rowid, so a common word stops after the newest few rows) rather than by time:
  // a copied chat's old messages are new rows.
  // Not a cached statement (`db.query`): stopping early would leave it half-read for the next search.
  const stmt = db.prepare(
    `SELECT m.seq, m.id, m.room_id, r.name, m.author_kind, m.via, m.copy, m.text, m.created_at, r.group_chat, mb.handle
       FROM messages m JOIN rooms r ON r.id = m.room_id LEFT JOIN members mb ON mb.id = m.member_id
      WHERE (r.group_chat = 1 OR EXISTS (SELECT 1 FROM chats c WHERE c.room_id = r.id))
        AND m.author_kind IN ('human', 'agent') AND m.status != 'streaming' AND m.text LIKE ? ESCAPE '\\'
      ORDER BY m.seq DESC`,
  );
  const results: SearchHit[] = [];
  const per = new Map<string, number>();
  const shows = new RegExp(escapeRegExp(q), "i");
  let truncated = false;
  try {
    for (const r of stmt.iterate(like) as IterableIterator<Row>) {
      const n = per.get(r.room_id) ?? 0;
      // Once it's known there are more than it sends, only a row it can still send is worth reading: when it's full, that's
      // all; when this row's chat has its 3, there's nothing to learn from it.
      if (truncated) {
        if (results.length >= max) break;
        if (n >= SEARCH_PER_CHAT) continue;
      }
      // The LIKE only narrows it down. A row that matches only in what the chat hides (a file's link, its local path) is
      // not a match, and counts for nothing: not toward the limits, and not as more matches than it sends.
      const text = shownText(r.text);
      if (!shows.test(text)) continue;
      if (results.length >= max) {
        truncated = true;
        break;
      }
      if (n >= SEARCH_PER_CHAT) {
        truncated = true;
        continue;
      }
      per.set(r.room_id, n + 1);
      // In a group chat, which of its agents wrote it.
      const agent = outsideAgent(r) ?? (r.group_chat && r.author_kind === "agent" && r.handle ? `@${r.handle}` : undefined);
      results.push({ roomId: r.room_id, roomName: r.name, messageId: r.id, seq: r.seq, who: r.author_kind === "human" && !r.via ? "you" : "agent", ...(agent ? { agent } : {}), snippet: snippetOf(text, q), createdAt: r.created_at });
    }
  } finally {
    stmt.finalize();
  }
  const chats = (
    db.query(`SELECT r.id, r.name, r.updated_at FROM rooms r WHERE (r.group_chat = 1 OR EXISTS (SELECT 1 FROM chats c WHERE c.room_id = r.id)) AND r.name LIKE ? ESCAPE '\\' ORDER BY r.updated_at DESC LIMIT ?`).all(like, max) as { id: string; name: string; updated_at: number }[]
  ).map((r): SearchChat => ({ roomId: r.id, roomName: r.name, updatedAt: r.updated_at }));
  return { results, chats, truncated };
}

// ---------------------------------------------------------------------------------------------------- Markdown export

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|heic|heif|svg)$/i;
// Code (fenced blocks and `inline`) stays exactly as written; only the prose around it is changed.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;
const MD_IMAGE = /!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g;

/** A message as the export has it: images as [image], attachments without the hub's local paths, code as written. */
export function exportText(text: string): string {
  return text
    .replace(/^Attachments \(open these local files only if needed\):$/m, "Attachments:")
    .replace(ATTACHED, (_, name: string, kind: string) => (kind === "uploads" && IMAGE_FILE.test(name) ? "- [image]" : `- [${kind === "folders" ? "folder" : "file"}: ${name.replace(/\\(.)/g, "$1")}]`))
    .split(CODE)
    .map((part, i) => (i % 2 ? part : part.replace(MD_IMAGE, "[image]")))
    .join("");
}

/** Who said a message, as the export labels it. A message another chat's agent sent never passes for yours. */
const who = (m: CopiedMessage, exp: ChatExport): string => {
  if (m.role === "agent") return `${m.agent || exp.chat.agent}${m.stopped ? " (stopped)" : ""}`;
  return m.via ? `${m.via.agent} (in the chat "${m.via.chatName.replace(/"/g, "'")}", not you)` : "You";
};

const dateOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * A chat as Markdown: its title, the agent and model, the date, then every message as **You:** or **<Agent>:** with its text.
 * No steps or tool output. It reads the chat the way a copy to another machine does (exportChat, with its size limits), and
 * says so when it was cut short.
 */
export async function exportMarkdown(app: App, roomId: string, now = new Date()): Promise<{ markdown: string; fileName: string }> {
  const exp = await exportChat(app, roomId, true);
  const members = app.store.listMembers(roomId);
  const modelOf = (m: (typeof members)[number] | undefined) => m?.resolvedModel ?? m?.model;
  // A group chat names each of its agents, with its model.
  const agents = app.store.getRoom(roomId)?.chat?.group
    ? members.map((m) => `@${m.handle}${modelOf(m) ? ` (${modelOf(m)})` : ""}`).join(", ")
    : `${exp.chat.agent}${modelOf(members[0]) ? ` (${modelOf(members[0])})` : ""}`;
  const head = [`# ${exp.chat.name.replace(/\s+/g, " ")}`, `${agents} · Exported ${dateOf(now)}${exp.machine.name ? ` from ${exp.machine.name}` : ""}`];
  if (exp.left) head.push(`> Cut short: the first ${exp.left.toLocaleString("en-US")} message${exp.left === 1 ? "" : "s"} of this chat aren't here. It's longer than an export holds.`);
  const blocks = exp.messages.map((m) => {
    const cut = m.text.length >= TEXT_MAX ? "\n\n*The rest of this message is left out: it's too long to export.*" : "";
    return `**${who(m, exp)}:**\n\n${exportText(m.text).trim()}${cut}`;
  });
  return { markdown: `${[head.join("\n\n"), ...blocks].join("\n\n---\n\n")}\n`, fileName: markdownFileName(exp.chat.name) };
}

/** A download's Content-Disposition: the name in plain ASCII, and in full for browsers that read UTF-8 names. */
export function disposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_");
  const full = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${full}`;
}

export function searchRoutes(app: App): Route[] {
  return [
    route("GET", "/api/search", ({ url }) => searchChats(app, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit")) || SEARCH_MAX_HITS)),
    route("GET", "/api/chats/:id/export.md", async ({ params }) => {
      const { markdown, fileName } = await exportMarkdown(app, params.id);
      return new Response(markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": disposition(fileName), "cache-control": "no-store" } });
    }),
  ];
}
