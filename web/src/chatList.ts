/** What the chat list (the drawer, Home's Recent and the Show chats button) works out about chats and machines. */

import { PROVIDER_INFO, type Approval, type MachineInfo, type Member, type Room } from "@crosstalk/shared";
import { normalizeBaseUrl } from "./api";

/**
 * A chat with a reply you haven't read, on any device: its last reply ended after you last read it. A hub that doesn't
 * say when replies end (no lastReplyAt) never marks one.
 */
export function isUnread(room: Pick<Room, "lastReplyAt" | "readAt">): boolean {
  return typeof room.lastReplyAt === "number" && room.lastReplyAt > (room.readAt ?? 0);
}

/**
 * What a chat's row says about its agent: it needs you, it's working, it's waiting for a usage limit to reset (it
 * carries on by itself), or it stopped with an error.
 */
export type RowState = "needs" | "busy" | "waiting" | "error";

const WORKING = ["thinking", "working", "queued"];

/** Each chat's row state on one machine, by room id (chats with nothing to say are left out). */
export function rowStates(members: Record<string, Member>, approvals: Record<string, Approval>): Map<string, RowState> {
  const out = new Map<string, RowState>();
  const rank: Record<RowState, number> = { needs: 4, busy: 3, waiting: 2, error: 1 };
  const put = (roomId: string, state: RowState) => {
    const cur = out.get(roomId);
    if (!cur || rank[state] > rank[cur]) out.set(roomId, state);
  };
  for (const m of Object.values(members)) {
    if (m.status === "approval") put(m.roomId, "needs");
    else if (WORKING.includes(m.status)) put(m.roomId, "busy");
    else if (m.status === "waiting") put(m.roomId, "waiting");
    else if (m.status === "error") put(m.roomId, "error");
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

/** How many rows a group lists before "Show all". */
export const SHOWN = 8;

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

// ---- Folded groups: a whole group of the list folded away, remembered on the device that folded it ----

/** The list's own two groups, beside the agents' and the services' (chatIdentity.ts gives those their keys). */
export const PINNED_GROUP = "pinned";
export const GROUP_CHATS_GROUP = "group";

/** Where this device keeps the groups it folded. */
export const FOLDED_KEY = "crosstalk.sidebar.folded";

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
 * Whether a group shows folded now: you folded it on this device, and nothing is being searched for — a search shows
 * its matches wherever they are, as "Show all" already does. A group with no chats folds too: the agents' groups are
 * always there, so folding one away is how a list with only your own models stops saying "Claude Code / No chats yet."
 */
export function isFolded(folded: Partial<Record<string, boolean>>, key: string, searching: boolean): boolean {
  return !!folded[key] && !searching;
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
  if (status === 401) return { why: "other", text: `This device was signed out of ${machine}. Add it again in Settings → Machines.` };
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

/** How many requests and questions wait for you on every machine, leaving out the chat on screen (`onScreen`). */
export function needsYou(machines: { approvals: Record<string, Approval> }[], onScreen: string | null): number {
  let n = 0;
  for (const m of machines) for (const a of Object.values(m.approvals)) if (a.status === "pending" && a.roomId !== onScreen) n++;
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
