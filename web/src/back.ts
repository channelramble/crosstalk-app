// What the browser's (or the phone's) Back does. The app keeps a short trail of places behind the one on screen, one
// history entry each: Home, then what was opened from it, then anything open over the screen (the chat list on a phone,
// a dialog). Back goes one place down the trail: it closes what's on top first, then leaves the screen for the one it was
// opened from. A fresh load has nothing behind it, so Back there leaves the app, as it should.
//
// The rules are plain functions (trailAfter, historyStep); the rest of the file makes the browser's history match them.

/** A place in the trail: a screen's address ("#/", "#/room/r1"), or something open over the screen ("+1"). */
export type Place = string;

const isOver = (p: Place) => p.startsWith("+");

type Kind = "home" | "agent" | "chat" | "page";
function kindOf(place: Place): Kind {
  const view = place.replace(/^#\/?/, "").split("/")[0];
  return view === "" ? "home" : view === "agent" ? "agent" : view === "room" ? "chat" : "page";
}
/**
 * Pages sit at levels: Settings, Bookmarks, Screen… take each other's place; a page of Settings (and Usage, by its
 * older address) goes over those, and one page of Settings takes another's place; Terminal, which Settings' Machines
 * page opens, goes over them all.
 */
const pageLevel = (place: Place) => (place === "#/terminal" ? 3 : /^#\/usage$|^#\/settings\/./.test(place) ? 2 : 1);

/**
 * The trail of screens once `to` is opened from the last one in `trail`:
 * - a screen already in the trail: back to it, and what was over it goes;
 * - Home, or an agent's page: chats are under these, so the trail starts over from there;
 * - a chat over a chat: the new one takes its place, so Back from a chat leads to where chats were opened from, however
 *   many were looked at; a page over a page (Settings, Bookmarks…) likewise;
 * - anything else goes on top: Back from it is the screen it was opened from.
 */
export function trailAfter(trail: Place[], to: Place): Place[] {
  const at = trail.indexOf(to);
  if (at >= 0) return trail.slice(0, at + 1);
  const kind = kindOf(to);
  let keep = trail.length;
  if (kind === "home") keep = 0;
  else if (kind === "agent") keep = trail.length > 0 && kindOf(trail[0]) === "home" ? 1 : 0;
  else if (kind === "chat") keep -= keep > 0 && kindOf(trail[keep - 1]) === "chat" ? 1 : 0;
  else while (keep > 0 && kindOf(trail[keep - 1]) === "page" && pageLevel(trail[keep - 1]) >= pageLevel(to)) keep--;
  return [...trail.slice(0, keep), to];
}

export type HistoryStep = { op: "pop"; by: number } | { op: "replace"; place: Place } | { op: "push"; place: Place };

/**
 * The next thing to do to the browser's history so its entries (`have`, the last one current) become `want`: go back
 * over the entries that shouldn't be there, change the first one that differs in place, add the rest. Null: nothing.
 * The first entry is never gone back over: what's behind it isn't the app's.
 */
export function historyStep(have: Place[], want: Place[]): HistoryStep | null {
  if (!want.length) return null;
  let same = 0;
  while (same < have.length && same < want.length && have[same] === want[same]) same++;
  const keep = same < want.length ? same + 1 : same;
  if (have.length > keep) return { op: "pop", by: have.length - keep };
  if (same < have.length) return { op: "replace", place: want[same] };
  if (same < want.length) return { op: "push", place: want[same] };
  return null;
}

// ---- the browser's history, kept to the trail ----

/** What the app shows for the address: `asked` is the screen it names, `shown` the one on screen after (leaving can be refused). */
type Show = () => { asked: Place; shown: Place };

/** Set once the app has started in a browser (not in a test without one). */
let show: Show | null = null;
/** The history entries the app has, up to the one the browser is on. Each entry carries its own (`history.state.ct`), so a reload knows what's behind it. */
let have: Place[] = [];
/** What they should be: `settle` gets there. */
let want: Place[] = [];
/** A step back of the app's own is on its way (the browser takes it later): how many entries there'll be when it lands. */
let moving: number | null = null;
let lost: ReturnType<typeof setTimeout> | undefined;
/** The browser moved and the app is catching up: what it opens and closes meanwhile isn't a new place. */
let following = false;
/** What's open over the screen, in the order it opened, each with what Back does to it (true: it's still open after). */
const over = new Map<Place, () => boolean | void>();
let overSeq = 0;

function trailOf(state: unknown): Place[] | null {
  const ct = (state as { ct?: unknown } | null)?.ct;
  return Array.isArray(ct) && ct.length > 0 && ct.every((p) => typeof p === "string") && !isOver(ct[0]) ? (ct as Place[]) : null;
}

/** The address of an entry: its screen's, or for something open over a screen, that screen's. */
const addressOf = (trail: Place[]) => [...trail].reverse().find((p) => !isOver(p));

function settle() {
  if (!show || following) return;
  while (moving === null) {
    const step = historyStep(have, want);
    if (!step) return;
    if (step.op === "pop") {
      have = have.slice(0, -step.by);
      moving = have.length;
      // Never seen, but a step back the browser doesn't take must not hold up every later one: then nothing is behind.
      lost = setTimeout(() => {
        moving = null;
        have = [trailOf(history.state)?.pop() ?? (location.hash || "#/")];
        history.replaceState({ ct: have }, "");
        settle();
      }, 4000);
      history.go(-step.by);
    } else if (step.op === "replace") {
      have = [...have.slice(0, -1), step.place];
      history.replaceState({ ct: have }, "", addressOf(have));
    } else {
      have = [...have, step.place];
      // Something open over the screen keeps the screen's address.
      history.pushState({ ct: have }, "", isOver(step.place) ? undefined : step.place);
    }
  }
}

/** The browser is on another entry: Back, Forward, a link to another screen, an address typed in, or a step of `settle`'s. */
function arrived() {
  if (!show) return;
  const kept = trailOf(history.state);
  if (moving !== null) {
    // The app's own step back: landed, or not yet (this is about an earlier move).
    if (kept?.length !== moving) return;
    moving = null;
    clearTimeout(lost);
    settle();
    return;
  }
  // An entry the app made says what's under it (less what the app has changed there since); one the browser made (a
  // link, a typed address) is new, on top.
  const landed = kept ? [...kept.slice(0, -1).map((p, i) => have[i] ?? p), kept[kept.length - 1]] : [...have, location.hash || "#/"];
  // Browsers tell of one move twice (popstate, then hashchange).
  if (kept && landed.length === have.length && landed.every((p, i) => p === have[i])) return;
  have = landed;
  let went = false;
  const staying: Place[] = [];
  following = true;
  try {
    // What's open over the screen and no longer in the history closes, the top one first.
    for (const place of [...over.keys()].reverse()) if (!have.includes(place) && over.get(place)?.() === true) staying.unshift(place);
    const { asked, shown } = show();
    went = asked === shown;
    if (went && !kept) have = [...have.slice(0, -1), asked];
  } finally {
    following = false;
  }
  history.replaceState({ ct: have }, "");
  // The history is now what's on screen. Something that was over the screen and is in the history again (Forward) can't
  // be opened from here, and something that stayed open (a dialog asking about unsaved changes first) gets its entry
  // back. A screen that refused to be left: `want` stands, and the address goes back to it.
  if (went) want = [...have.filter((p) => !isOver(p) || over.has(p)), ...staying];
  settle();
}

/**
 * Starts keeping the history, with `shown` on screen. A reload finds the trail it had on the entry it's on; anything
 * else (a first load, a link from outside) starts with nothing behind it.
 */
export function startHistory(shown: Place, showAddress: Show) {
  if (typeof history === "undefined" || typeof window === "undefined" || typeof history.pushState !== "function") return;
  show = showAddress;
  const kept = trailOf(history.state);
  have = kept ?? [shown];
  // What was open over the screen isn't after a reload.
  want = [...have.filter((p) => !isOver(p)).slice(0, -1), shown];
  if (!kept) history.replaceState({ ct: have }, "");
  settle();
  window.addEventListener("popstate", arrived);
  window.addEventListener("hashchange", arrived);
}

/** The app opened a screen itself (a tap, not the browser's Back): the trail follows (trailAfter). */
export function wentTo(place: Place) {
  if (!show || following) return;
  want = [...trailAfter(want.filter((p) => !isOver(p)), place), ...want.filter(isOver)];
  settle();
}

/**
 * Something opened over the screen (the chat list on a phone, a dialog): Back closes it (`back` is asked to, and says
 * true if it's still open after: it asked about unsaved changes first) before it leaves the screen. Returns what to
 * call when it has closed, however it did: closed by its own button, its entry is taken back out of the history.
 */
export function openedOver(back: () => boolean | void): () => void {
  if (!show) return () => {};
  const place = `+${++overSeq}`;
  over.set(place, back);
  want = [...want, place];
  settle();
  return () => {
    if (!over.delete(place) || !want.includes(place)) return;
    want = want.filter((p) => p !== place);
    settle();
  };
}
