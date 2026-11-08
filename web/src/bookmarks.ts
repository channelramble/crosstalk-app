// Bookmarks: messages kept to find again on the Bookmarks screen (hub/src/bookmarks.ts has the contract). Each machine
// keeps the bookmarks of its own chats, so the screen asks every machine and lists them together. Pure functions here
// (the web unit tests have no DOM); views/BookmarksPage.tsx and views/BookmarkButton.tsx use them.

import type { Bookmark, BookmarkList } from "@crosstalk/shared";
import { ApiError, api, type Connection } from "./api";

/** A bookmark with the machine its chat is on. */
export interface FoundBookmark extends Bookmark {
  machineKey: string;
  machineName: string;
}

/** Every machine's bookmarks as one list, newest bookmark first. */
export function allBookmarks(machines: { key: string; name: string; bookmarks: Bookmark[] | null }[]): FoundBookmark[] {
  return machines
    .flatMap((m) => (m.bookmarks ?? []).map((b): FoundBookmark => ({ ...b, machineKey: m.key, machineName: m.name })))
    .sort((a, b) => b.bookmarkedAt - a.bookmarkedAt || b.createdAt - a.createdAt);
}

/**
 * Who wrote a bookmarked message: "You", or its agent. A one-agent chat's own agent goes by its kind ("Claude Code"),
 * as the chat shows it; a group chat's by its @handle; another chat's agent by the name the hub gives.
 */
export function bookmarkWho(b: Pick<Bookmark, "who" | "agent">, chatAgent?: string | null): string {
  if (b.who === "you") return "You";
  if (b.agent?.startsWith("@") && chatAgent) return chatAgent;
  return b.agent || chatAgent || "The agent";
}

/** Why a machine's bookmarks couldn't be listed, as a sentence that says what to do (the line says which machine). */
export function bookmarksProblem(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404 || e.status === 405) return "It runs an older Crosstalk without bookmarks. Update it to keep its messages here.";
    if (e.status === 401) return "It signed this device out. Pair it again in Settings → Machines.";
    if (e.status === 0) return e.message;
    return `It answered with an error (${e.message.replace(/\s+/g, " ").trim().slice(0, 120)}). Try again in a moment.`;
  }
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

/** One machine's bookmarks (GET /api/bookmarks). */
export async function listBookmarks(conn: Connection): Promise<Bookmark[]> {
  const res = await api<BookmarkList>("GET", "/api/bookmarks", undefined, conn, 10_000);
  return Array.isArray(res?.bookmarks) ? res.bookmarks : [];
}

/** Bookmarks a message on its chat's machine (the active one without `conn`), or takes the bookmark off. */
export function saveBookmark(messageId: string, bookmarked: boolean, conn?: Connection) {
  return api<{ messageId: string; roomId: string; at: number | null }>("PUT", `/api/messages/${encodeURIComponent(messageId)}/bookmark`, { bookmarked }, conn);
}

/** A machine's bookmarked messages with one changed (the hub's answer, before its event comes). */
export function withBookmark(bookmarked: Record<string, number> | null, messageId: string, at: number | null): Record<string, number> {
  const next = { ...(bookmarked ?? {}) };
  if (at === null) delete next[messageId];
  else next[messageId] = at;
  return next;
}
