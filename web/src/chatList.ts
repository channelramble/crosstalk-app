/** What the chat list (the drawer, Home's Recent and the Show chats button) works out about chats and machines. */

import { settingsPath, PROVIDER_INFO, helperAtWork, slugHandle, type Approval, type BackgroundTask, type LimitWait, type MachineInfo, type Member, type ReplyStart, type Room } from "@crosstalk/shared";
import { normalizeBaseUrl } from "./api";
import { limitBackWords } from "./limitWait";

/**
 * A chat with a reply you haven't read, on any device: its last reply ended after you last read it. A hub that doesn't
 * say when replies end (no lastReplyAt) never marks one.
 */
export function isUnread(room: Pick<Room, "lastReplyAt" | "readAt">): boolean {
  return typeof room.lastReplyAt === "number" && room.lastReplyAt > (room.readAt ?? 0);
}

/**
 * What a chat's row says about its agent: it needs you, it's working, it's waiting for a usage limit to reset (it
 * carries on by itself), it stopped with an error, or its reply ended and only its helpers still work.
 */
export type RowState = "needs" | "busy" | "waiting" | "error" | "helpers";

const WORKING = ["thinking", "working", "queued"];

/**
 * Each chat's row state on one machine, by room id (chats with nothing to say are left out). `tasks`: each agent's
 * background work, which is all that says a chat still works once its reply has ended.
 */
export function rowStates(members: Record<string, Member>, approvals: Record<string, Approval>, tasks: Record<string, BackgroundTask[]> = {}): Map<string, RowState> {
  const out = new Map<string, RowState>();
  const rank: Record<RowState, number> = { needs: 5, busy: 4, waiting: 3, error: 2, helpers: 1 };
  const put = (roomId: string, state: RowState) => {
    const cur = out.get(roomId);
    if (!cur || rank[state] > rank[cur]) out.set(roomId, state);
  };
  for (const m of Object.values(members)) {
    if (m.status === "approval") put(m.roomId, "needs");
    else if (WORKING.includes(m.status)) put(m.roomId, "busy");
    else if (m.status === "waiting") put(m.roomId, "waiting");
    else if (m.status === "error") put(m.roomId, "error");
    if (tasks[m.id]?.some(helperAtWork)) put(m.roomId, "helpers");
  }
  for (const a of Object.values(approvals)) if (a.status === "pending") put(a.roomId, "needs");
  return out;
}

/** Each room's agents on one machine, in their order (the lead first): what a chat's rows and its identity are read from. */
export function membersByRoom(members: Record<string, Member>): Map<string, Member[]> {
  const out = new Map<string, Member[]>();
  for (const m of Object.values(members)) {
    const list = out.get(m.roomId);
    if (list) list.push(m);
    else out.set(m.roomId, [m]);
  }
  for (const list of out.values()) list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  return out;
}

/** How many rows Recent lists before "Show all". */
export const SHOWN = 12;

/**
 * The rows a group shows before "Show all": the newest `limit`, plus any further one `keep` says must show (a reply you
 * haven't read, an agent working, waiting for you or stopped with an error), in the same order.
 */
export function shownRows<T>(rows: T[], keep: (row: T) => boolean, limit = SHOWN): T[] {
  return rows.filter((row, i) => i < limit || keep(row));
}

/** Whether a chat's row shows even past the cut: a reply you haven't read, or an agent working, waiting for you, waiting for a limit, or stopped with an error. */
export function keepInView(room: Pick<Room, "lastReplyAt" | "readAt">, state: RowState | undefined): boolean {
  return !!state || isUnread(room);
}

// ---- The list by state: Pinned, Needs you, Working, Recent ----

/**
 * The list's sections, in the order they're drawn. Pinned is yours (your order, whatever its chats are doing); the
 * other three answer what the list is for: which chats need you, which are working, and what's new.
 */
export const SECTIONS = ["pinned", "needs", "working", "recent"] as const;
export type ListSection = (typeof SECTIONS)[number];

/** Each section's heading. Its key is what the list folds it by and tells its lines apart by (sidebar.ts, ChatListMotion.ts). */
export const SECTION_TITLE: Record<ListSection, string> = { pinned: "Pinned", needs: "Needs you", working: "Working", recent: "Recent" };

/** One chat as the list sorts it. */
export interface ListRow {
  room: Room;
  state: RowState | undefined;
  /** When it last asked you for something (its newest request waiting), if it has. */
  askedAt?: number | null;
}

/**
 * Which section a chat is in. A pinned one stays under Pinned and says its state on its row. Needs you: a request or a
 * question waits, or its newest reply failed. Working: an agent works, only its helpers do, or it waits for a usage
 * limit (it carries on by itself: nothing for you to do). Recent: the rest.
 */
export function sectionOf(row: { room: Pick<Room, "pinnedAt">; state: RowState | undefined }): ListSection {
  if (isPinned(row.room)) return "pinned";
  if (row.state === "needs" || row.state === "error") return "needs";
  return row.state ? "working" : "recent";
}

const byId = (a: Pick<Room, "id">, b: Pick<Room, "id">) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The order inside a section. Pinned: the order you set. Needs you: what asked last, first (a failed reply counts from
 * when it ended). Working and Recent: the newest activity first — a chat's `updatedAt` moves when a reply starts or
 * ends, not with every step, so working chats don't swap places while they work.
 */
export function compareInSection(section: ListSection, a: ListRow, b: ListRow): number {
  if (section === "pinned") return comparePins(a.room, b.room);
  if (section === "needs") return (b.askedAt ?? b.room.updatedAt) - (a.askedAt ?? a.room.updatedAt) || b.room.updatedAt - a.room.updatedAt || byId(a.room, b.room);
  return b.room.updatedAt - a.room.updatedAt || byId(a.room, b.room);
}

/** The list's sections with their chats in order, top to bottom: a section with nothing in it isn't there. */
export function listSections<T extends ListRow>(rows: T[]): { section: ListSection; rows: T[] }[] {
  const by = new Map<ListSection, T[]>();
  for (const row of rows) {
    const section = sectionOf(row);
    by.set(section, [...(by.get(section) ?? []), row]);
  }
  return SECTIONS.flatMap((section) => {
    const list = by.get(section);
    return list ? [{ section, rows: list.sort((a, b) => compareInSection(section, a, b)) }] : [];
  });
}

/** Where each chat was in the list, by its key: what the list holds on to while a finger is on it. */
export type HeldPlaces = { section: ListSection; keys: string[] }[];

export const placesOf = <T>(sections: { section: ListSection; rows: T[] }[], key: (row: T) => string): HeldPlaces => sections.map((s) => ({ section: s.section, keys: s.rows.map(key) }));

/**
 * The list while a finger is on it: every chat stays in the section and the place it had when the finger came down
 * (`was`), so a row never jumps out from under a tap; what each row says still follows its chat. A chat that came
 * since goes to the end of the section it belongs in, one that went is gone, and a section left empty isn't there.
 * When the finger lifts the list is drawn as it is (`live`), and the rows glide to where they belong.
 */
export function heldSections<T>(was: HeldPlaces, live: { section: ListSection; rows: T[] }[], key: (row: T) => string): { section: ListSection; rows: T[] }[] {
  const rows = new Map(live.flatMap((s) => s.rows.map((row) => [key(row), row] as const)));
  const placed = new Set(was.flatMap((s) => s.keys));
  return SECTIONS.flatMap((section) => {
    const kept = (was.find((s) => s.section === section)?.keys ?? []).flatMap((k) => (rows.has(k) ? [rows.get(k)!] : []));
    const came = (live.find((s) => s.section === section)?.rows ?? []).filter((row) => !placed.has(key(row)));
    return kept.length + came.length ? [{ section, rows: [...kept, ...came] }] : [];
  });
}

/** The requests waiting in one chat: how many, how many of them are questions, and when the newest was asked. */
export interface RowRequests {
  count: number;
  questions: number;
  newest: number | null;
}

/**
 * Each chat's waiting requests on one machine, by room id. An agent that says it waits for you without a request this
 * device knows of (it comes a moment later, or the hub is an older one) counts as one: its status says whether it asks.
 */
export function requestsByRoom(members: Record<string, Member>, approvals: Record<string, Approval>): Map<string, RowRequests> {
  const out = new Map<string, RowRequests>();
  for (const a of Object.values(approvals)) {
    if (a.status !== "pending") continue;
    const cur = out.get(a.roomId) ?? { count: 0, questions: 0, newest: null };
    out.set(a.roomId, { count: cur.count + 1, questions: cur.questions + (a.kind === "question" ? 1 : 0), newest: Math.max(cur.newest ?? 0, a.createdAt) });
  }
  for (const m of Object.values(members)) {
    if (m.status !== "approval" || out.has(m.roomId)) continue;
    out.set(m.roomId, { count: 1, questions: m.statusDetail?.trim().startsWith("Asks:") ? 1 : 0, newest: null });
  }
  return out;
}

/** What a row's second line is worked out from. */
export interface RowFacts {
  name: string;
  cwd: string;
  updatedAt: number;
  state: RowState | undefined;
  /** The requests waiting in it (state "needs"). */
  requests?: RowRequests | null;
  /** Since when its running reply has run, when this device knows (state "busy"). */
  workingSince?: number | null;
  /** How many of its helpers are at work (state "helpers"). */
  helpers?: number;
  /** The usage limit it waits for (state "waiting"); null when the agent never said when it resets. */
  wait?: Pick<LimitWait, "resetsAt"> | null;
  /** A group chat's agents ("@claude and @codex"): said in place of its folder. */
  who?: string | null;
}

/** Whether a chat's folder only repeats its name: the folder a new chat gets is its name as a folder name ("fix-login", or "fix-login-2" when that's taken). */
export function folderRepeatsName(name: string, cwd: string): boolean {
  const folder = folderName(cwd).toLowerCase();
  const slug = slugHandle(name);
  return folder === slug || (folder.startsWith(`${slug}-`) && /^\d+$/.test(folder.slice(slug.length + 1)));
}

/** "just now", "5m ago", "3h ago", "2d ago"; read out, "5 minutes ago". */
export function agoWords(ts: number, now = Date.now(), spoken = false): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  const [n, short, long] = s < 3600 ? [Math.round(s / 60), "m", "minute"] : s < 86400 ? [Math.round(s / 3600), "h", "hour"] : [Math.round(s / 86400), "d", "day"];
  return spoken ? `${n} ${long}${n === 1 ? "" : "s"} ago` : `${n}${short} ago`;
}

/** How long a reply has run, by the minute: "12m", "1h 5m", "2h"; nothing in its first minute. Read out, "12 minutes". */
export function workedWords(ms: number, spoken = false): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const said = (n: number, short: string, long: string) => (spoken ? `${n} ${long}${n === 1 ? "" : "s"}` : `${n}${short}`);
  return [h ? said(h, "h", "hour") : "", m || !h ? said(m, "m", "minute") : ""].filter(Boolean).join(" ");
}

/**
 * A row's second line: its state in words whenever it has one, else where it lives and when. `spoken`: the same for a
 * screen reader, with nothing abbreviated.
 *
 * - Needs you: "Needs your OK", "Asked you a question"; several, "Needs your OK · 2" or "Asked you 2 questions".
 * - "Failed": its newest reply ended in an error (the reason is in the chat: the agents' own words for it aren't plain).
 * - "Working · 12m" (just "Working" in the first minute, or when this device doesn't know since when), "1 helper
 *   working" when only helpers do, "Back at 5:00 AM" while it waits for a usage limit.
 * - Otherwise "my-app · 2m ago": its folder, left out when it only repeats the chat's name; a group chat says who's in it.
 */
export function rowStateWords(f: RowFacts, now = Date.now(), spoken = false): string {
  const dot = spoken ? ", " : " · ";
  switch (f.state) {
    case "needs": {
      const { count, questions } = f.requests ?? { count: 1, questions: 0 };
      if (count > 1) return questions === count ? `Asked you ${count} questions` : spoken ? `Needs your OK, ${count} requests` : `Needs your OK · ${count}`;
      return questions ? "Asked you a question" : "Needs your OK";
    }
    case "error":
      return "Failed";
    case "busy": {
      const worked = f.workingSince ? workedWords(now - f.workingSince, spoken) : "";
      return worked ? (spoken ? `Working for ${worked}` : `Working · ${worked}`) : "Working";
    }
    case "helpers": {
      const n = Math.max(1, f.helpers ?? 1);
      return `${n} helper${n === 1 ? "" : "s"} working`;
    }
    case "waiting":
      return f.wait ? limitBackWords(f.wait, now) : "Back soon";
    default: {
      const where = f.who || (folderRepeatsName(f.name, f.cwd) ? "" : folderName(f.cwd));
      return [where, agoWords(f.updatedAt, now, spoken)].filter(Boolean).join(dot);
    }
  }
}

/**
 * A row's one label for a screen reader: its name, its state, and when ("Fix login, new reply, my-app, 2 minutes ago,
 * on Mac mini"). A chat with a state says when it was last active too, which its second line has no room for.
 */
export function rowLabel(f: RowFacts, extra: { unread?: boolean; machine?: string | null } = {}, now = Date.now()): string {
  return [f.name, extra.unread ? "new reply" : "", rowStateWords(f, now, true), f.state ? agoWords(f.updatedAt, now, true) : "", extra.machine ? `on ${extra.machine}` : ""].filter(Boolean).join(", ");
}

/** Whether a section can be folded away: all but Needs you, which is what the list is for. */
export const canFold = (section: ListSection): boolean => section !== "needs";

/**
 * What a folded section says it holds: how many chats, how many of them need a look, and the mark's colour (foldMark).
 * Pinned and Recent count what the list would never cut off (keepInView). Working counts none: its heading already
 * says what its chats are doing, and none of them waits for you.
 */
export function sectionFold(section: ListSection, rows: { room: Pick<Room, "lastReplyAt" | "readAt">; state: RowState | undefined }[]): { count: number; attention: number; mark: "needs" | "error" | "" } {
  if (section === "working") return { count: rows.length, attention: 0, mark: "" };
  return { count: rows.length, attention: rows.filter((r) => keepInView(r.room, r.state)).length, mark: foldMark(rows.map((r) => r.state)) };
}

// ---- Folded sections: a whole section of the list folded away, remembered on the device that folded it ----

/** Pinned's key, the same as before the list went by state (so a device that folded it keeps it folded). */
export const PINNED_GROUP: ListSection = "pinned";

/** Where this device keeps the sections it folded. */
export const FOLDED_KEY = "crosstalk.sidebar.folded";

/** Where a touch device remembers that "Hold a chat to pin it" has been seen to (a long press, or its ✕): "1" once it has. */
export const HOLD_HINT_KEY = "crosstalk.sidebar.holdHint";

/**
 * The groups folded on this device, read back from its store: only keys set to true count, so a value left by another
 * version — or nothing at all — just starts every group open.
 */
export function readFolded(raw: string | null): Record<string, boolean> {
  try {
    const kept: unknown = JSON.parse(raw ?? "null");
    if (!kept || typeof kept !== "object" || Array.isArray(kept)) return {};
    return Object.fromEntries(
      Object.entries(kept as Record<string, unknown>)
        .filter(([key, on]) => key && on === true)
        .map(([key]) => [key, true]),
    );
  } catch {
    return {};
  }
}

/** What goes back to the store: only the groups folded now, so unfolding one forgets it rather than keeping a false. */
export function writtenFolded(folded: Partial<Record<string, boolean>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(folded).filter(([, on]) => on).map(([key]) => [key, true])));
}

/**
 * Whether a section shows folded now: you folded it on this device, it's one that folds (never Needs you), and nothing
 * is being searched for — a search shows its matches wherever they are, as "Show all" already does. Keys kept from
 * before the list went by state (an agent's, a service's, "group") name nothing now, and are simply never asked for.
 */
export function isFolded(folded: Partial<Record<string, boolean>>, key: string, searching: boolean): boolean {
  return !!folded[key] && !searching && key !== "needs";
}

/**
 * What a folded group says it holds: how many chats, and how many of them need a look (a reply you haven't read, an
 * agent working, waiting for you, waiting for a usage limit, or stopped with an error). Folding is your choice, so it
 * hides those rows too — but never quietly.
 */
export function foldedWords(count: number, attention: number): string {
  if (!count) return "no chats";
  const chats = count === 1 ? "1 chat" : `${count} chats`;
  return attention > 0 ? `${chats}, ${attention === 1 ? "1 needs" : `${attention} need`} a look` : chats;
}

/**
 * What a folded section says under its heading: only that chats inside need a look, and how many — the heading has
 * the count of them all, so a section with nothing to look at folds to its heading alone.
 */
export function foldedSaid(attention: number): string {
  return attention > 0 ? `${attention === 1 ? "1 needs" : `${attention} need`} a look` : "";
}

/**
 * The fold control's name: what it folds, and what's inside while it's folded (the heading's own action keeps its own
 * name). `where` tells two groups of one name apart — two machines can run a model called the same thing — the way the
 * heading's own name does ("on the mini", "api.venice.ai").
 */
export function foldLabel(title: string, folded: boolean, count: number, attention: number, where?: string | null): string {
  const what = where ? `${title} chats, ${where}` : `${title} chats`;
  return folded ? `Show ${what}, ${foldedWords(count, attention)}` : `Hide ${what}`;
}

/**
 * The mark a folded group shows when something inside needs a look: the rows' own orange when an agent really is
 * waiting for you, red when one stopped with an error, and nothing of its own otherwise (working, waiting for a usage
 * limit, or a reply you haven't read). The words say "needs a look" for all of them; the mark must not say "waiting
 * for you" for all of them, because orange means that everywhere else in the list.
 */
export function foldMark(states: (RowState | undefined)[]): "needs" | "error" | "" {
  if (states.includes("needs")) return "needs";
  if (states.includes("error")) return "error";
  return "";
}

// ---- Pinned chats (hub pins.ts): first in the list, every machine's together, in the order you set ----

type PinFields = Pick<Room, "pinnedAt" | "pinOrder">;

/** The hub keeps places only this far from 0 (hub pins.ts MAX_PIN_ORDER): past it, the pins are numbered again. */
const PIN_ORDER_LIMIT = 1e12;

/** A chat pinned to the top of the list (an older hub's never are). */
export function isPinned(room: Pick<Room, "pinnedAt">): boolean {
  return typeof room.pinnedAt === "number" && room.pinnedAt > 0;
}

/**
 * Pinned chats' order: by place (lowest first), then the newest pin, then the chat's id. Never by machine: the hub the
 * page came from has the key "" (machines.ts), which isn't the same machine on every device.
 */
export function comparePins(a: PinFields & Pick<Room, "id">, b: PinFields & Pick<Room, "id">): number {
  return (a.pinOrder ?? 0) - (b.pinOrder ?? 0) || (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The list's rows split: the pinned ones in the order you set (comparePins), and the rest newest first, as before pins. */
export function pinnedFirst<T>(rows: T[], room: (row: T) => Room): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (isPinned(room(row)) ? pinned : rest).push(row);
  pinned.sort((a, b) => comparePins(room(a), room(b)));
  rest.sort((a, b) => room(b).updatedAt - room(a).updatedAt);
  return { pinned, rest };
}

/** The top place among the pinned chats (the lowest), or null when none is pinned. */
export function topPinOrder(pinned: PinFields[]): number | null {
  const places = pinned.filter(isPinned).map((r) => r.pinOrder ?? 0);
  return places.length ? Math.min(...places) : null;
}

/**
 * A new pin's place: above every pinned chat this device has, and above those pinned earlier on a machine it hasn't
 * loaded (down since the app opened, still loading, or not added here), as it's at most minus the seconds since 1970,
 * which only grow (about -1.8e9: far inside PIN_ORDER_LIMIT). The hub does the same for a pin without a place.
 */
export function newPinOrder(pinned: PinFields[], now = Date.now()): number {
  const top = topPinOrder(pinned);
  return Math.min(top === null ? Infinity : top - 1, -now / 1000);
}

/**
 * The place for the pinned chat at `from` moved to `to` (indexes in the pinned list, in its order): halfway between its
 * new neighbours, or 1 beyond the first or last one when it goes to an end. Null when no number fits between them (two
 * chats in the same place, or after many moves between the same two): then the pins are numbered again (renumberPins).
 */
export function pinOrderAt(pinned: PinFields[], from: number, to: number): number | null {
  const others = pinned.filter((_, i) => i !== from);
  const above = to > 0 ? others[to - 1] : undefined;
  const below = others[to];
  const lo = above ? (above.pinOrder ?? 0) : null;
  const hi = below ? (below.pinOrder ?? 0) : null;
  const place = lo === null ? (hi === null ? (pinned[from]?.pinOrder ?? 0) : hi - 1) : hi === null ? lo + 1 : (lo + hi) / 2;
  if (lo !== null && hi !== null && !(place > lo && place < hi)) return null;
  return Math.abs(place) <= PIN_ORDER_LIMIT ? place : null;
}

/** The pinned rows after the one at `from` moves to `to`. */
export function movedPins<T>(rows: T[], from: number, to: number): T[] {
  const out = rows.slice();
  const [row] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, row);
  return out;
}

/** Places 0, 1, 2… for the pinned rows in the order given: only the rows whose place changes. */
export function renumberPins<T>(rows: T[], place: (row: T) => number | null | undefined): { row: T; order: number }[] {
  return rows.flatMap((row, i) => (place(row) === i ? [] : [{ row, order: i }]));
}

/**
 * Why a pin didn't happen, in words: the machine runs a Crosstalk from before pins (its hub answers a route it doesn't
 * have with a bare "not found", as every version has), it can't be reached (no answer: status 0), it signed this
 * device out, or what its hub said.
 */
export function pinProblem(e: unknown, machine: string): { why: "older" | "down" | "other"; text: string } {
  const status = (e as { status?: unknown } | null)?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 404 && /^not found$/i.test(message)) return { why: "older", text: `Update Crosstalk on ${machine} to pin its chats.` };
  if (status === 0) return { why: "down", text: `Can't reach ${machine}. Try again when it's back.` };
  if (status === 401) return { why: "other", text: `This device was signed out of ${machine}. Add it again in ${settingsPath("machines")}.` };
  return { why: "other", text: message };
}

/** The last `parts` parts of a folder ("Crosstalk-main/Crosstalk"): what the folder is known by. */
export function folderTail(cwd: string, parts = 2): string {
  return cwd.replace(/\/+$/, "").split("/").filter(Boolean).slice(-parts).join("/");
}

/** A folder's own name ("Crosstalk" for /Users/me/Crosstalk). */
export function folderName(cwd: string): string {
  return folderTail(cwd, 1) || cwd;
}

/**
 * Whether a chat matches the drawer's search: its name, the last one or two parts of its folder, its agent, the AI
 * service it runs on (`service`, its name and model, for a chat on one), or its machine (`machine`, given when this
 * device has several). Not the whole path, which would make "dev" match every chat under /Users/me/dev.
 */
export function chatMatches(room: Pick<Room, "name" | "cwd" | "chat">, query: string, machine?: string | null, service?: string | null): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const agent = room.chat ? (PROVIDER_INFO[room.chat.provider]?.name ?? "") : "";
  return [room.name, folderTail(room.cwd), agent, machine ?? "", service ?? ""].some((s) => s.toLowerCase().includes(q));
}

/**
 * How many things wait for you on every machine, leaving out the chat on screen (`onScreen`): each request and
 * question, and each chat whose newest reply failed and hasn't been looked at since (one you've seen stays under Needs
 * you in the list, without counting here for ever).
 */
export function needsYou(machines: { approvals: Record<string, Approval>; members?: Record<string, Member>; rooms?: Record<string, Pick<Room, "id" | "lastReplyAt" | "readAt" | "archived">> }[], onScreen: string | null): number {
  let n = 0;
  for (const m of machines) {
    const asking = new Set<string>();
    for (const a of Object.values(m.approvals)) {
      if (a.status !== "pending") continue;
      asking.add(a.roomId);
      if (a.roomId !== onScreen) n++;
    }
    const failed = new Set<string>();
    for (const member of Object.values(m.members ?? {})) if (member.status === "error") failed.add(member.roomId);
    for (const id of failed) {
      const room = m.rooms?.[id];
      if (room && !room.archived && id !== onScreen && !asking.has(id) && isUnread(room)) n++;
    }
  }
  return n;
}

/**
 * A machine name's words: split at spaces, dashes and underscores, and before capitals that follow small letters
 * ("homeSERVER" is "home" and "SERVER"; "MacBook" stays one word).
 */
function nameWords(name: string): string[] {
  return name.replace(/([a-z])([A-Z]{2,})/g, "$1 $2").split(/[\s_-]+/).filter(Boolean);
}

/**
 * A machine's tag beside its chats, when this device has several: its first word when no other machine's name has it
 * ("Mac mini" and "Linux box" show as "Mac" and "Linux"; "homeSERVER" as "home"), else the shortest word of its
 * name that tells it apart ("Mac mini" and "Mac Studio" show as "mini" and "Studio"), else its whole name. Words under
 * 3 letters only as the whole name.
 */
export function machineTag(name: string, names: string[]): string {
  const others = names.filter((n) => n !== name).map((n) => nameWords(n).map((w) => w.toLowerCase()));
  const unique = (w: string) => !others.some((words) => words.includes(w.toLowerCase()));
  const words = nameWords(name);
  const usable = words.filter((w) => w.length >= 3 && unique(w));
  if (!usable.length) return name;
  if (usable[0] === words[0]) return words[0];
  return usable.reduce((a, b) => (b.length < a.length ? b : a));
}

/**
 * Machines linked on another device that this one hasn't added (Settings → Machines adds them with a tap), from the
 * home hub's list. Machines linked machine to machine, for agents only, can't be added from a device.
 */
export function linkedNotHere(linked: MachineInfo[], here: { hub: { id?: string } | null; conn: { baseUrl: string } }[]): MachineInfo[] {
  const has = (info: MachineInfo) => here.some((m) => (m.hub?.id && m.hub.id === info.id) || (!!m.conn.baseUrl && normalizeBaseUrl(m.conn.baseUrl) === normalizeBaseUrl(info.url)));
  return linked.filter((info) => info.scope !== "peer" && !has(info));
}

/**
 * A request's notice, in the same words on screen and in a notification: "Fix login · Codex needs your OK", or "… has
 * a question" for a question. `agent`: the chat's agent ("Codex"), or the asking agent's @handle in a group room.
 */
export function requestWords(a: Pick<Approval, "kind">, roomName: string | undefined, agent: string): string {
  const what = a.kind === "question" ? `${agent} has a question` : `${agent} needs your OK`;
  return roomName ? `${roomName} · ${what}` : what;
}
