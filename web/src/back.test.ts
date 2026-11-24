// Where the browser's Back leads (back.ts): the trail of screens behind the one on screen, and what is done to the
// browser's history to match it.
import { expect, test } from "bun:test";
import { historyStep, trailAfter, type Place } from "./back";

const HOME = "#/";
const CODEX = "#/agent/codex";
const A = "#/room/a";
const B = "#/room/b";
const SETTINGS = "#/settings";
const BOOKMARKS = "#/bookmarks";
const USAGE = "#/usage";
const TERMINAL = "#/terminal";

/** Everything done to the history, in order, to get from `have` to `want`: "push", "replace" or "pop" (with how many). */
function moves(have: Place[], want: Place[]): string[] {
  const done: string[] = [];
  let now = have;
  for (let step = historyStep(now, want); step; step = historyStep(now, want)) {
    done.push(step.op === "pop" ? `pop ${step.by}` : `${step.op} ${step.place}`);
    now = step.op === "pop" ? now.slice(0, -step.by) : step.op === "replace" ? [...now.slice(0, -1), step.place] : [...now, step.place];
    if (done.length > 10) throw new Error("never settles");
  }
  expect(now).toEqual(want);
  return done;
}
/** What opening `to` from the last screen of `trail` does to the history. */
const opening = (trail: Place[], to: Place) => moves(trail, trailAfter(trail, to));

test("going deeper adds an entry: Home, an agent's page, a chat", () => {
  expect(opening([HOME], CODEX)).toEqual([`push ${CODEX}`]);
  expect(opening([HOME, CODEX], A)).toEqual([`push ${A}`]);
  expect(opening([HOME], A)).toEqual([`push ${A}`]);
  expect(trailAfter([HOME, CODEX], A)).toEqual([HOME, CODEX, A]);
});

test("Settings, Bookmarks, Screen, Terminal and Usage go over the screen they were opened from", () => {
  for (const page of [SETTINGS, BOOKMARKS, "#/screen", TERMINAL, USAGE]) {
    expect(opening([HOME], page)).toEqual([`push ${page}`]);
    expect(trailAfter([HOME, A], page)).toEqual([HOME, A, page]);
    expect(trailAfter([HOME, CODEX], page)).toEqual([HOME, CODEX, page]);
  }
});

test("another chat takes the chat's place: Back from a chat is where chats were opened from", () => {
  expect(opening([HOME, A], B)).toEqual([`replace ${B}`]);
  expect(trailAfter([HOME, CODEX, A], B)).toEqual([HOME, CODEX, B]);
  // However many are looked at, one after another.
  let trail = [HOME];
  for (const id of ["a", "b", "c", "d", "e"]) trail = trailAfter(trail, `#/room/${id}`);
  expect(trail).toEqual([HOME, "#/room/e"]);
});

test("a screen already behind is gone back to, not added again", () => {
  expect(opening([HOME, CODEX, A], CODEX)).toEqual(["pop 1"]);
  expect(opening([HOME, A, SETTINGS], A)).toEqual(["pop 1"]);
  expect(opening([HOME, CODEX, A, SETTINGS], HOME)).toEqual(["pop 3"]);
  // The same screen again: nothing.
  expect(opening([HOME, A], A)).toEqual([]);
});

test("Home and an agent's page start the trail over", () => {
  // A chat opened by its address has nothing behind it: Home takes its place, and Back then leaves the app.
  expect(opening([A], HOME)).toEqual([`replace ${HOME}`]);
  expect(opening([A], CODEX)).toEqual([`replace ${CODEX}`]);
  // The chat's own back arrow, from a chat opened on Home: its agent's page, with Home behind it.
  expect(opening([HOME, A], CODEX)).toEqual([`replace ${CODEX}`]);
  expect(trailAfter([HOME, A, SETTINGS], CODEX)).toEqual([HOME, CODEX]);
  expect(trailAfter([HOME, CODEX], "#/agent/claude")).toEqual([HOME, "#/agent/claude"]);
});

test("a page takes another page's place, except Usage and Terminal over Settings", () => {
  expect(opening([HOME, SETTINGS], BOOKMARKS)).toEqual([`replace ${BOOKMARKS}`]);
  expect(opening([HOME, A, SETTINGS], BOOKMARKS)).toEqual([`replace ${BOOKMARKS}`]);
  // Settings opens them itself: Back from them is Settings.
  expect(opening([HOME, SETTINGS], USAGE)).toEqual([`push ${USAGE}`]);
  expect(opening([HOME, SETTINGS, USAGE], SETTINGS)).toEqual(["pop 1"]);
  // Terminal goes over them all (Settings' Machines page opens it).
  expect(opening([HOME, SETTINGS, USAGE], TERMINAL)).toEqual([`push ${TERMINAL}`]);
  // From the list, Settings after Terminal: one page, not two.
  expect(opening([HOME, TERMINAL], SETTINGS)).toEqual([`replace ${SETTINGS}`]);
  expect(trailAfter([HOME, SETTINGS, USAGE], BOOKMARKS)).toEqual([HOME, BOOKMARKS]);
});

test("a chat opened from a page (a bookmark) goes over it; the trail still never grows without end", () => {
  expect(trailAfter([HOME, BOOKMARKS], A)).toEqual([HOME, BOOKMARKS, A]);
  expect(trailAfter([HOME, BOOKMARKS, A], B)).toEqual([HOME, BOOKMARKS, B]);
  // Chat, Settings, chat, Settings…: Settings is gone back to each time.
  let trail = [HOME, A];
  for (const id of ["b", "c", "d", "e"]) trail = trailAfter(trailAfter(trail, SETTINGS), `#/room/${id}`);
  expect(trail).toEqual([HOME, A, SETTINGS, "#/room/e"]);
});

test("the history is changed in as few steps as it takes", () => {
  expect(moves([HOME], [HOME])).toEqual([]);
  // Something open over the screen (the chat list, a dialog) is one entry more, and one back when it closes.
  expect(moves([HOME, A], [HOME, A, "+1"])).toEqual(["push +1"]);
  expect(moves([HOME, A, "+1"], [HOME, A])).toEqual(["pop 1"]);
  // A chat picked in the chat list on a phone: the list's entry goes, the chat under it changes.
  expect(moves([HOME, A, "+1"], [HOME, B])).toEqual(["pop 1", `replace ${B}`]);
  // A chat started from a dialog on Home, the dialog not closed yet: the chat goes under it.
  expect(moves([HOME, "+1"], [HOME, A, "+1"])).toEqual([`replace ${A}`, "push +1"]);
  // The first entry is never gone back over: what's behind it isn't the app's.
  expect(moves([A], [HOME, CODEX])).toEqual([`replace ${HOME}`, `push ${CODEX}`]);
  expect(historyStep([HOME, A], [])).toBeNull();
});

test("a page of Settings goes over its list, one page takes another's place, and Terminal goes over a page", () => {
  const ACCOUNTS = "#/settings/accounts";
  const MACHINES = "#/settings/machines";
  // From the list: Back from the page is the list.
  expect(opening([HOME, SETTINGS], ACCOUNTS)).toEqual([`push ${ACCOUNTS}`]);
  // The page's own Back to the list: one step back, not a new entry.
  expect(opening([HOME, SETTINGS, ACCOUNTS], SETTINGS)).toEqual(["pop 1"]);
  // Search takes you from one page to another: Back is still the list.
  expect(trailAfter([HOME, SETTINGS, ACCOUNTS], MACHINES)).toEqual([HOME, SETTINGS, MACHINES]);
  // Opened straight from a chat (a link to a section): Back is the chat, and the page's Back shows the list in its place.
  expect(trailAfter([HOME, A], ACCOUNTS)).toEqual([HOME, A, ACCOUNTS]);
  expect(opening([HOME, A, ACCOUNTS], SETTINGS)).toEqual([`replace ${SETTINGS}`]);
  // A fresh load on a page has nothing behind it: its Back to the list changes the entry in place.
  expect(opening([ACCOUNTS], SETTINGS)).toEqual([`replace ${SETTINGS}`]);
  // Terminal from Machines → Advanced: Back is Machines.
  expect(trailAfter([HOME, SETTINGS, MACHINES], TERMINAL)).toEqual([HOME, SETTINGS, MACHINES, TERMINAL]);
  // Bookmarks takes all of Settings' place.
  expect(trailAfter([HOME, SETTINGS, MACHINES], BOOKMARKS)).toEqual([HOME, BOOKMARKS]);
});
