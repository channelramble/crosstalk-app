// Bookmarks: messages the person keeps, to find again together on the Bookmarks screen (the contract is in
// shared/src/protocol.ts). Each lives on the hub of its chat, in the `bookmarks` table, and goes with its message (the
// table's foreign keys): a message unsent or rewound away, or a deleted chat, takes its bookmark with it. For people's
// own devices only (`route`, never `peerRoute`): what someone keeps is theirs, not other machines' agents'.

import { BOOKMARK_TEXT_MAX, type Bookmark, type BookmarkList } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";
import { route, type Route } from "./routes";
import { shownText } from "./search";

/** The bookmarked messages, by id, with when each was bookmarked (the state's `bookmarked`). */
export function bookmarkedIds(app: App): Record<string, number> {
  const rows = app.store.db.query("SELECT message_id, created_at FROM bookmarks").all() as { message_id: string; created_at: number }[];
  return Object.fromEntries(rows.map((r) => [r.message_id, r.created_at]));
}

/** Who wrote a message that isn't the chat's own agent's: another chat's agent (`via`), or a copied reply's (`copy`). */
function otherAgent(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { agent?: unknown } | null;
    const name = typeof v?.agent === "string" ? v.agent.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Every bookmark on this hub, newest bookmark first, with what the chat shows of its message. */
export function listBookmarks(app: App): BookmarkList {
  const rows = app.store.db
    .query(
      `SELECT b.created_at AS at, m.seq, m.id, m.room_id, r.name, m.author_kind, m.author_name, m.via, m.copy, m.text, m.created_at, mb.handle
         FROM bookmarks b JOIN messages m ON m.id = b.message_id JOIN rooms r ON r.id = m.room_id LEFT JOIN members mb ON mb.id = m.member_id
        ORDER BY b.created_at DESC, m.seq DESC`,
    )
    .all() as { at: number; seq: number; id: string; room_id: string; name: string; author_kind: string; author_name: string; via: string | null; copy: string | null; text: string; created_at: number; handle: string | null }[];
  const bookmarks = rows.map((r): Bookmark => {
    const sent = r.author_kind === "human" ? otherAgent(r.via) : undefined;
    const who = r.author_kind === "human" && !sent ? "you" : "agent";
    const agent = who === "you" ? undefined : (sent ?? (r.copy && JSON.parse(r.copy)?.kind === "reply" ? otherAgent(r.copy) : undefined) ?? (r.handle ? `@${r.handle}` : r.author_name));
    const text = shownText(r.text).trim();
    return { messageId: r.id, roomId: r.room_id, roomName: r.name, seq: r.seq, who, ...(agent ? { agent } : {}), text: text.slice(0, BOOKMARK_TEXT_MAX), cut: text.length > BOOKMARK_TEXT_MAX, createdAt: r.created_at, bookmarkedAt: r.at };
  });
  return { bookmarks };
}

/** Bookmarks a message or takes its bookmark off, and tells every device. Bookmarking one again keeps when it was first. */
export function setBookmark(app: App, messageId: string, body: unknown): { messageId: string; roomId: string; at: number | null } {
  const b = (body && typeof body === "object" ? body : {}) as { bookmarked?: unknown };
  if (typeof b.bookmarked !== "boolean") throw new HttpError(400, "Say whether to bookmark the message (bookmarked: true or false).");
  const m = app.store.getMessage(messageId);
  // Never the bare "not found" of a route a hub doesn't have: the app takes that for a hub from before bookmarks.
  if (!m) throw new HttpError(404, "That message is gone: it was unsent, or its chat was deleted.", "no_message");
  if (m.status === "streaming") throw new HttpError(409, "That reply is still being written. Bookmark it once it's done.");
  let at: number | null = null;
  if (b.bookmarked) {
    app.store.db.query("INSERT OR IGNORE INTO bookmarks (message_id, room_id, created_at) VALUES (?, ?, ?)").run(m.id, m.roomId, Date.now());
    at = (app.store.db.query("SELECT created_at FROM bookmarks WHERE message_id = ?").get(m.id) as { created_at: number }).created_at;
  } else {
    app.store.db.query("DELETE FROM bookmarks WHERE message_id = ?").run(m.id);
  }
  app.bus.emit({ t: "bookmark", roomId: m.roomId, messageId: m.id, at });
  return { messageId: m.id, roomId: m.roomId, at };
}

export function bookmarkRoutes(app: App): Route[] {
  return [
    route("GET", "/api/bookmarks", () => listBookmarks(app)),
    route("PUT", "/api/messages/:id/bookmark", async ({ params, body }) => setBookmark(app, params.id, await body())),
  ];
}
