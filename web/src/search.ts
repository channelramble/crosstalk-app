// Search across chats (docs/SPEC-0.4.md section 14, track T8): what the sidebar asks each machine, and how it shows the
// answers. Pure functions here (the web unit tests have no DOM); useMessageSearch.ts and views/MessageHits.tsx use them.

import { SEARCH_MAX_HITS, SEARCH_MIN_CHARS, type SearchHit, type SearchResponse } from "@crosstalk/shared";
import { ApiError, api, type Connection } from "./api";

/** The sidebar waits this long after the last key before it asks the machines. */
export const DEBOUNCE_MS = 300;
/** Hits listed before "Show all". */
export const SHOWN_HITS = 6;

/** What to search for: the query trimmed, or null while it's too short (the hub finds nothing under 2 characters). */
export function searchTerm(query: string): string | null {
  const q = query.trim();
  return q.length >= SEARCH_MIN_CHARS ? q : null;
}

/** A hit with the machine it was found on, and the words that found it. */
export interface FoundHit extends SearchHit {
  machineKey: string;
  machineName: string;
  query: string;
}

/** One machine's part of a search (see useMessageSearch). */
export interface MachineHits {
  key: string;
  name: string;
  /** What its last finished search found, for `query`. Null before the first answer. */
  answer: { query: string; hits: SearchHit[]; truncated: boolean } | null;
  /** Asked, or about to be, and not answered yet. */
  busy: boolean;
  /** Why it couldn't be searched, in plain words (null: it can). */
  problem: string | null;
}

/** Every machine's hits as one list, newest first. */
export function foundHits(machines: MachineHits[]): FoundHit[] {
  return machines
    .flatMap((m) => (m.answer?.hits ?? []).map((h): FoundHit => ({ ...h, machineKey: m.key, machineName: m.name, query: m.answer!.query })))
    .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
}

/** Hits of one chat, listed together under its name. */
export interface HitGroup {
  key: string;
  roomId: string;
  roomName: string;
  machineKey: string;
  machineName: string;
  hits: FoundHit[];
}

/** Hits (newest first) grouped by chat, in the order of each chat's newest hit. */
export function groupHits(hits: FoundHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const h of hits) {
    const key = `${h.machineKey}/${h.roomId}`;
    const group = groups.get(key) ?? { key, roomId: h.roomId, roomName: h.roomName, machineKey: h.machineKey, machineName: h.machineName, hits: [] };
    group.hits.push(h);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Whether any machine has more matches than it sent. */
export const anyTruncated = (machines: MachineHits[]) => machines.some((m) => m.answer?.truncated);

/** A snippet in parts: `hit` marks where the query shows (in any case), to be drawn in bold. */
export function markSnippet(snippet: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text: snippet, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let last = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts.length ? parts : [{ text: snippet, hit: false }];
}

/** When a message was said: the time today, the day this year, else with the year. */
export function hitTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], d.getFullYear() === n.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** Who said a hit, as the sidebar puts it: "You", the agent the hit names (one in another chat that sent it here), or this chat's own agent. */
export function hitWho(hit: Pick<SearchHit, "who" | "agent">, chatAgent?: string | null): string {
  return hit.who === "you" ? "You" : hit.agent || chatAgent || "The agent";
}

/** What a machine said when it answered with an error: on one line, cut to about 120 characters. */
function saidInError(e: ApiError): string {
  const said = e.message.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  // The app's own "Request failed (500)" says no more than the number.
  if (!said || /^Request failed \(\d+\)$/.test(said)) return String(e.status);
  return said.length > 120 ? `${said.slice(0, 120).replace(/[\ud800-\udbff]$/, "").trimEnd()}…` : said;
}

/** Why a machine couldn't be searched, as a sentence that says what to do (the line says which machine). */
export function searchProblem(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404 || e.status === 405) return "It runs an older Crosstalk that can't search yet. Update it, then try again.";
    if (e.status === 401) return "It signed this device out. Pair it again in Settings → Machines.";
    // Status 0: the app's own plain words (it couldn't reach the machine). Otherwise the machine's own words go in a sentence.
    if (e.status === 0) return e.message;
    return `It answered with an error (${saidInError(e)}). Try again in a moment.`;
  }
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

/** Asks one machine's hub for the messages that match (GET /api/search). */
export async function searchMachine(conn: Connection, term: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const res = await api<SearchResponse>("GET", `/api/search?q=${encodeURIComponent(term)}&limit=${SEARCH_MAX_HITS}`, undefined, conn, 10_000);
  return { hits: Array.isArray(res?.results) ? res.results : [], truncated: !!res?.truncated };
}
