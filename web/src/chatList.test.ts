import { expect, test } from "bun:test";
import type { Approval, BackgroundTask, MachineInfo, Member, Room } from "@crosstalk/shared";
import { PINNED_GROUP, SECTIONS, SECTION_TITLE, SHOWN, agoWords, canFold, chatMatches, compareInSection, foldLabel, foldMark, foldedSaid, foldedWords, folderName, folderRepeatsName, heldSections, isFolded, isUnread, keepInView, linkedNotHere, listSections, machineTag, needsYou, placesOf, readFolded, requestWords, requestsByRoom, rowLabel, rowStateWords, rowStates, sectionFold, sectionOf, shownRows, workedWords, writtenFolded, type ListRow, type RowFacts } from "./chatList";

const room = (id: string, extra: Partial<Room> = {}): Room => ({ id, name: `Chat ${id}`, cwd: `/work/${id}`, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1, updatedAt: 1, archived: false, chat: { provider: "codex", origin: "web" }, ...extra });
const member = (roomId: string, status: Member["status"]): Member => ({ id: `mb-${roomId}`, roomId, handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status, statusDetail: null, config: {}, createdAt: 1, position: 0 });
const approval = (id: string, roomId: string, status: Approval["status"] = "pending", kind: Approval["kind"] = "command", createdAt = 1): Approval => ({ id, roomId, memberId: `mb-${roomId}`, turnId: null, kind, title: "Run tests", detail: "", status, decision: null, decidedBy: null, createdAt, decidedAt: null });
const task = (extra: Partial<BackgroundTask> = {}): BackgroundTask => ({ id: "t", kind: "local_agent", description: "Checking", agentType: null, workflow: null, background: true, status: "running", startedAt: 1, endedAt: null, tokens: null, toolUses: null, lastTool: null, summary: null, error: null, ...extra });

test("unread when the last reply is newer than read", () => {
  expect(isUnread({ lastReplyAt: 2000, readAt: 1000 })).toBe(true);
  // A chat nobody has read yet (a new chat: the hub hasn't stored a read time).
  expect(isUnread({ lastReplyAt: 2000 })).toBe(true);
  expect(isUnread({ lastReplyAt: 2000, readAt: 2000 })).toBe(false);
  expect(isUnread({ lastReplyAt: 2000, readAt: 3000 })).toBe(false);
});

test("no dot without lastReplyAt", () => {
  // Older hubs say nothing about replies; nothing is marked then, read or not.
  expect(isUnread({})).toBe(false);
  expect(isUnread({ readAt: 1000 })).toBe(false);
  expect(isUnread({ lastReplyAt: null, readAt: null })).toBe(false);
});

test("unread rows stay above the cut", () => {
  const rows = Array.from({ length: 12 }, (_, i) => room(`r${i}`, { lastReplyAt: 10, readAt: i === 10 ? 5 : 20 }));
  const shown = shownRows(rows, (r) => keepInView(r, undefined), 8);
  // The newest eight, then the unread one far down the list, in its place.
  expect(shown.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r10"]);
  // Nothing kept: just the newest eight.
  expect(shownRows(rows, () => false, 8)).toHaveLength(8);
});

test("working, waiting and errored rows stay above the cut", () => {
  const rows = Array.from({ length: 12 }, (_, i) => room(`r${i}`));
  const members = Object.fromEntries([member("r8", "working"), member("r9", "error"), member("r11", "idle"), member("r3", "queued")].map((m) => [m.id, m]));
  const states = rowStates(members, { a1: approval("a1", "r10") });
  expect(states.get("r8")).toBe("busy");
  expect(states.get("r9")).toBe("error");
  expect(states.get("r10")).toBe("needs");
  expect(states.get("r3")).toBe("busy");
  expect(states.has("r11")).toBe(false);
  const shown = shownRows(rows, (r) => keepInView(r, states.get(r.id)), 8);
  expect(shown.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10"]);
  // Waiting for a usage limit: its own state, kept in view, below working and needing you but above an error.
  const waits = rowStates({ w: member("r5", "waiting"), e: { ...member("r5", "error"), id: "e" } }, {});
  expect(waits.get("r5")).toBe("waiting");
  expect(keepInView(room("r5"), waits.get("r5"))).toBe(true);
  expect(rowStates({ w: member("r6", "waiting"), b: { ...member("r6", "working"), id: "b" } }, {}).get("r6")).toBe("busy");
  // Waiting for you wins over an error (a member asking while another stopped), and over working.
  const both = rowStates({ x: member("r1", "error"), y: { ...member("r1", "working"), id: "y" } }, { a: approval("a", "r1") });
  expect(both.get("r1")).toBe("needs");
  // An answered request isn't waiting.
  expect(rowStates({}, { a: approval("a", "r1", "approved") }).has("r1")).toBe(false);
});

test("the needs-you count leaves out the chat on screen and covers every machine", () => {
  const mac = { approvals: { a1: approval("a1", "mac-chat"), a2: approval("a2", "on-screen"), a3: approval("a3", "mac-chat", "approved") } };
  const linux = { approvals: { b1: approval("b1", "linux-chat", "pending", "question"), b2: approval("b2", "linux-other") } };
  expect(needsYou([mac, linux], "on-screen")).toBe(3);
  expect(needsYou([mac, linux], null)).toBe(4);
  expect(needsYou([mac], "mac-chat")).toBe(1);
  expect(needsYou([], null)).toBe(0);
  // A chat whose reply failed counts until it's looked at; one that also asks counts once (its request), and an
  // archived one or the one on screen doesn't.
  const failed = (id: string, extra: Record<string, unknown> = {}) => ({ id, lastReplyAt: 20, readAt: 10, archived: false, ...extra });
  const broken = {
    approvals: { c1: approval("c1", "asks-too") },
    members: { m1: member("new-failure", "error"), m2: { ...member("seen-failure", "error"), id: "m2" }, m3: { ...member("asks-too", "error"), id: "m3" }, m4: { ...member("put-away", "error"), id: "m4" }, m5: { ...member("fine", "idle"), id: "m5" } },
    rooms: { "new-failure": failed("new-failure"), "seen-failure": failed("seen-failure", { readAt: 30 }), "asks-too": failed("asks-too"), "put-away": failed("put-away", { archived: true }), fine: failed("fine") },
  };
  expect(needsYou([broken], null)).toBe(2);
  expect(needsYou([broken], "new-failure")).toBe(1);
  expect(needsYou([mac, broken], "on-screen")).toBe(3);
  expect(requestWords({ kind: "command" }, "Fix login", "Codex")).toBe("Fix login · Codex needs your OK");
  expect(requestWords({ kind: "question" }, "Fix login", "Claude Code")).toBe("Fix login · Claude Code has a question");
  expect(requestWords({ kind: "file_change" }, undefined, "@builder")).toBe("@builder needs your OK");
});

test("search matches the name, folder name, agent and machine, not the whole path", () => {
  const deep = room("a", { name: "Fix login", cwd: "/Users/you/dev/projects/site" });
  const crosstalk = room("b", { name: "Streaming", cwd: "/Users/you/dev/Crosstalk-main/Crosstalk/" });
  const web = room("c", { name: "Styles", cwd: "/Users/you/dev/Crosstalk/web", chat: { provider: "claude", origin: "web" } });
  // Not by a folder high up the path: "dev" doesn't match the chats under /Users/you/dev, nor "claude" the Codex ones.
  expect(chatMatches(deep, "dev")).toBe(false);
  expect(chatMatches(crosstalk, "dev")).toBe(false);
  expect(chatMatches(deep, "claude")).toBe(false);
  expect(chatMatches(crosstalk, "claude")).toBe(false);
  expect(chatMatches(deep, "users")).toBe(false);
  // By the agent: the Claude Code chat does.
  expect(chatMatches(web, "claude")).toBe(true);
  expect(chatMatches(deep, "codex")).toBe(true);
  // By the folder's last one or two parts.
  expect(chatMatches(deep, "site")).toBe(true);
  expect(chatMatches(deep, "projects")).toBe(true);
  expect(chatMatches(crosstalk, "crosstalk")).toBe(true);
  expect(chatMatches(web, "crosstalk")).toBe(true);
  expect(chatMatches(deep, "crosstalk")).toBe(false);
  // By name, in any case, and by machine when one is given.
  expect(chatMatches(deep, "  LOGIN ")).toBe(true);
  expect(chatMatches(deep, "linux")).toBe(false);
  expect(chatMatches(deep, "linux", "Linux box")).toBe(true);
  expect(chatMatches(deep, "")).toBe(true);
  expect(folderName("/Users/you/dev/Crosstalk/")).toBe("Crosstalk");
  expect(folderName("/")).toBe("/");
});

test("machine tags tell machines apart", () => {
  const tags = (names: string[]) => names.map((n) => machineTag(n, names));
  // The first word when it does (as before).
  expect(tags(["Mac mini", "Linux box"])).toEqual(["Mac", "Linux"]);
  // Not when two machines share it: the shortest word that tells them apart.
  expect(tags(["Mac mini", "Mac Studio"])).toEqual(["mini", "Studio"]);
  expect(tags(["MacBook Pro", "MacBook Air", "Mac mini"])).toEqual(["Pro", "Air", "Mac"]);
  expect(tags(["Mac mini", "mini PC"])).toEqual(["Mac", "mini PC"]);
  // Short or shared words only as the whole name.
  expect(tags(["PC", "Mac"])).toEqual(["PC", "Mac"]);
  expect(tags(["Home Mac", "Office Mac"])).toEqual(["Home", "Office"]);
  // A one-word host name is split where it changes to capitals, or at a dash: what's left fits the tag.
  expect(tags(["homeSERVER", "Linux box"])).toEqual(["home", "Linux"]);
  expect(tags(["homeSERVER", "homeBACKUP"])).toEqual(["SERVER", "BACKUP"]);
  expect(tags(["MacBook", "linux-box"])).toEqual(["MacBook", "linux"]);
  for (const names of [["Mac mini", "Mac Studio", "Linux box"], ["Build server", "Build box", "Server room"]]) {
    const t = tags(names);
    expect(new Set(t).size).toBe(names.length);
  }
});

test("machines linked elsewhere are offered unless this device has them, or they're for agents only", () => {
  const info = (id: string, url: string, scope: MachineInfo["scope"] = "full"): MachineInfo => ({ id, name: id, url, addedAt: 1, scope });
  const linked = [info("h_linux", "https://linux-box.tail.ts.net"), info("h_pc", "https://pc.tail.ts.net/"), info("h_peer", "https://peer.tail.ts.net", "peer")];
  const here = [{ hub: { id: "h_mac" }, conn: { baseUrl: "" } }, { hub: null, conn: { baseUrl: "https://pc.tail.ts.net" } }];
  expect(linkedNotHere(linked, here).map((m) => m.id)).toEqual(["h_linux"]);
  expect(linkedNotHere(linked, [...here, { hub: { id: "h_linux" }, conn: { baseUrl: "https://other" } }])).toEqual([]);
});

test("a folded group says what it holds, and its control says what it folds", () => {
  // Folded, the heading says how many chats are inside and how many need a look: folding hides those rows too.
  expect(foldedWords(3, 0)).toBe("3 chats");
  expect(foldedWords(1, 0)).toBe("1 chat");
  expect(foldedWords(3, 1)).toBe("3 chats, 1 needs a look");
  expect(foldedWords(12, 4)).toBe("12 chats, 4 need a look");
  expect(foldedWords(1, 1)).toBe("1 chat, 1 needs a look");
  expect(foldedWords(0, 0)).toBe("no chats");
  // The control's own name: what it folds, and what's inside while it's folded.
  expect(foldLabel("Claude Code", false, 3, 1)).toBe("Hide Claude Code chats");
  expect(foldLabel("Claude Code", true, 3, 1)).toBe("Show Claude Code chats, 3 chats, 1 needs a look");
  expect(foldLabel("qwen3-8b", true, 2, 0)).toBe("Show qwen3-8b chats, 2 chats");
  expect(foldLabel("pinned", true, 1, 0)).toBe("Show pinned chats, 1 chat");
  expect(foldLabel("recent", false, 4, 0)).toBe("Hide recent chats");
  expect(foldLabel("Claude Code", true, 0, 0)).toBe("Show Claude Code chats, no chats");
  // Two machines running a model of one name: where it runs tells the two controls apart, as it does the headings.
  expect(foldLabel("Qwen here · Codex", false, 2, 0, "on the mini")).toBe("Hide Qwen here · Codex chats, on the mini");
  expect(foldLabel("Qwen here · Codex", true, 2, 1, "on the Linux box")).toBe("Show Qwen here · Codex chats, on the Linux box, 2 chats, 1 needs a look");
  // The mark's colour carries the strongest state, because orange means "waiting for you" everywhere else in the list.
  expect(foldMark(["needs", "busy", "error"])).toBe("needs");
  expect(foldMark(["error", "busy", undefined])).toBe("error");
  expect(foldMark(["busy", "waiting", undefined])).toBe("");
  expect(foldMark([])).toBe("");
});

test("a folded group counts exactly the chats the newest-few cut would have kept in view", () => {
  // One group's rows, oldest last: a chat per state the list marks, an unread reply, and plain ones to push them past
  // the cut. The fold summary and the cut run off the same predicate, so this fixture drives both.
  const rows = [...Array.from({ length: SHOWN }, (_, i) => room(`plain${i}`)), room("needs"), room("busy"), room("waiting"), room("error"), room("unread", { lastReplyAt: 2000, readAt: 1000 }), room("quiet")];
  const states = rowStates({ a: member("needs", "approval"), b: member("busy", "thinking"), c: member("waiting", "waiting"), d: member("error", "error") }, {});
  const look = (r: Room) => keepInView(r, states.get(r.id));
  // Past the cut, the rows that stay are the ones the folded heading counts — nothing more, nothing less.
  expect(shownRows(rows, look).slice(SHOWN).map((r) => r.id)).toEqual(["needs", "busy", "waiting", "error", "unread"]);
  expect(rows.filter(look).map((r) => r.id)).toEqual(["needs", "busy", "waiting", "error", "unread"]);
  expect(foldedWords(rows.length, rows.filter(look).length)).toBe(`${SHOWN + 6} chats, 5 need a look`);
  // An approval outranks the rest, so the mark is the needs-you one; without it, a stopped chat's red.
  expect(foldMark(rows.map((r) => states.get(r.id)))).toBe("needs");
  expect(foldMark(rows.filter((r) => r.id !== "needs").map((r) => states.get(r.id)))).toBe("error");
});

test("a folded group is remembered per group, and a search overrides it", () => {
  // Only the folded ones are written: unfolding forgets the group rather than keeping a false.
  expect(writtenFolded({ codex: true, claude: false, "svc:codex:a1": true })).toBe('{"codex":true,"svc:codex:a1":true}');
  expect(readFolded(writtenFolded({ codex: true, pinned: true }))).toEqual({ codex: true, pinned: true });
  // Anything else in the store starts every group open, rather than throwing.
  expect(readFolded(null)).toEqual({});
  expect(readFolded("")).toEqual({});
  expect(readFolded("not json")).toEqual({});
  expect(readFolded('["codex"]')).toEqual({});
  expect(readFolded('{"codex":"yes","claude":true,"":true}')).toEqual({ claude: true });
  const folded = { recent: true, [PINNED_GROUP]: true };
  expect(isFolded(folded, "recent", false)).toBe(true);
  expect(isFolded(folded, "pinned", false)).toBe(true);
  // Per section: another one stays open.
  expect(isFolded(folded, "working", false)).toBe(false);
  // Searching ignores folding: matches show wherever they are, as "Show all" already does.
  expect(isFolded(folded, "recent", true)).toBe(false);
  expect(isFolded({}, "recent", false)).toBe(false);
});

// ---- The list by state ----

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const row = (id: string, state: ListRow["state"], extra: Partial<Room> = {}, askedAt: number | null = null): ListRow => ({ room: room(id, extra), state, askedAt });
const ids = (rows: ListRow[]) => rows.map((r) => r.room.id);

test("a chat's section follows its state, and a pinned one stays under Pinned whatever it's doing", () => {
  expect(SECTIONS).toEqual(["pinned", "needs", "working", "recent"]);
  expect(SECTIONS.map((s) => SECTION_TITLE[s])).toEqual(["Pinned", "Needs you", "Working", "Recent"]);
  // Needs you: a request or a question waits, or the newest reply failed.
  expect(sectionOf(row("a", "needs"))).toBe("needs");
  expect(sectionOf(row("a", "error"))).toBe("needs");
  // Working: an agent works, only its helpers do, or it waits for a usage limit (it carries on by itself).
  expect(sectionOf(row("a", "busy"))).toBe("working");
  expect(sectionOf(row("a", "helpers"))).toBe("working");
  expect(sectionOf(row("a", "waiting"))).toBe("working");
  // Recent: the rest, read or not.
  expect(sectionOf(row("a", undefined))).toBe("recent");
  expect(sectionOf(row("a", undefined, { lastReplyAt: 9, readAt: 1 }))).toBe("recent");
  // Pinned: there in every state. Unpinned (null, or 0 from an older hub), it's back with the others.
  for (const state of ["needs", "error", "busy", "helpers", "waiting", undefined] as const) expect(sectionOf(row("a", state, { pinnedAt: 5 }))).toBe("pinned");
  expect(sectionOf(row("a", "needs", { pinnedAt: null }))).toBe("needs");
  expect(sectionOf(row("a", undefined, { pinnedAt: 0 }))).toBe("recent");
});

test("helpers at work after a reply ended are a state of their own, under everything an agent says of itself", () => {
  const idle = member("r1", "idle");
  // A helper, a workflow or a command left in the background: the chat still works. A foreground command is a step.
  expect(rowStates({ a: idle }, {}, { [idle.id]: [task()] }).get("r1")).toBe("helpers");
  expect(rowStates({ a: idle }, {}, { [idle.id]: [task({ kind: "local_workflow" })] }).get("r1")).toBe("helpers");
  expect(rowStates({ a: idle }, {}, { [idle.id]: [task({ kind: "local_bash", background: true })] }).get("r1")).toBe("helpers");
  expect(rowStates({ a: idle }, {}, { [idle.id]: [task({ kind: "local_bash", background: false })] }).has("r1")).toBe(false);
  // Finished ones, or none known (an older hub, tasks never sent): nothing to say.
  expect(rowStates({ a: idle }, {}, { [idle.id]: [task({ status: "completed" }), task({ status: "failed" })] }).has("r1")).toBe(false);
  expect(rowStates({ a: idle }, {}).has("r1")).toBe(false);
  // The agent's own state says more: working, waiting for you or a limit, failed.
  const tasks = (m: Member) => ({ [m.id]: [task()] });
  for (const [status, state] of [["working", "busy"], ["thinking", "busy"], ["approval", "needs"], ["waiting", "waiting"], ["error", "error"]] as const) {
    const m = member("r2", status);
    expect(rowStates({ a: m }, {}, tasks(m)).get("r2")).toBe(state);
  }
  // Tasks of an agent that's gone say nothing about any chat.
  expect(rowStates({}, {}, { gone: [task()] }).size).toBe(0);
  // Kept in view like every other state.
  expect(keepInView(room("r1"), "helpers")).toBe(true);
});

test("inside a section: your order when pinned, what asked last first, else the newest activity first", () => {
  // Pinned: by place, then the newest pin.
  const pinned = [row("b", "busy", { pinnedAt: 5, pinOrder: 2, updatedAt: 900 }), row("a", undefined, { pinnedAt: 6, pinOrder: 1, updatedAt: 100 }), row("c", "needs", { pinnedAt: 7, pinOrder: 3, updatedAt: 999 })];
  expect(ids(pinned.slice().sort((x, y) => compareInSection("pinned", x, y)))).toEqual(["a", "b", "c"]);
  // Needs you: the newest request first; a failed reply (no request) counts from when it ended.
  const needs = [row("old", "needs", { updatedAt: 9000 }, 1000), row("new", "needs", { updatedAt: 100 }, 5000), row("failed", "error", { updatedAt: 3000 })];
  expect(ids(needs.slice().sort((x, y) => compareInSection("needs", x, y)))).toEqual(["new", "failed", "old"]);
  // Working and Recent: newest activity first; the same moment falls back on the id, so the order never flickers.
  const work = [row("x", "busy", { updatedAt: 10 }), row("z", "helpers", { updatedAt: 30 }), row("y", "waiting", { updatedAt: 20 }), row("w", "busy", { updatedAt: 20 })];
  expect(ids(work.slice().sort((x, y) => compareInSection("working", x, y)))).toEqual(["z", "w", "y", "x"]);
  expect(ids(work.slice().reverse().sort((x, y) => compareInSection("recent", x, y)))).toEqual(["z", "w", "y", "x"]);
});

test("the list's sections come in order, each sorted, and an empty one isn't there", () => {
  const rows = [
    row("recent-old", undefined, { updatedAt: 10 }),
    row("working", "busy", { updatedAt: 50 }),
    row("recent-new", undefined, { updatedAt: 90, lastReplyAt: 90, readAt: 1 }),
    row("asks", "needs", { updatedAt: 20 }, 70),
    row("pin-2", "error", { pinnedAt: 3, pinOrder: 2 }),
    row("failed", "error", { updatedAt: 60 }),
    row("limit", "waiting", { updatedAt: 40 }),
    row("pin-1", undefined, { pinnedAt: 4, pinOrder: 1 }),
    row("helpers", "helpers", { updatedAt: 45 }),
  ];
  const sections = listSections(rows);
  expect(sections.map((s) => s.section)).toEqual(["pinned", "needs", "working", "recent"]);
  expect(sections.map((s) => ids(s.rows))).toEqual([["pin-1", "pin-2"], ["asks", "failed"], ["working", "helpers", "limit"], ["recent-new", "recent-old"]]);
  // Nothing waiting and nothing pinned: just Working and Recent. No chats: no sections.
  expect(listSections(rows.filter((r) => ["working", "recent-old"].includes(r.room.id))).map((s) => s.section)).toEqual(["working", "recent"]);
  expect(listSections([])).toEqual([]);
  // A chat moves as its state does: working, then done with a reply no one has read (Recent's top), then asking.
  const moving = (state: ListRow["state"], extra: Partial<Room> = {}) => listSections([row("other", undefined, { updatedAt: 500 }), row("it", state, { updatedAt: 100, ...extra })]);
  expect(moving("busy").map((s) => [s.section, ids(s.rows)])).toEqual([["working", ["it"]], ["recent", ["other"]]]);
  expect(moving(undefined, { updatedAt: 600, lastReplyAt: 600, readAt: 1 }).map((s) => [s.section, ids(s.rows)])).toEqual([["recent", ["it", "other"]]]);
  expect(moving("needs").map((s) => [s.section, ids(s.rows)])).toEqual([["needs", ["it"]], ["recent", ["other"]]]);
});

test("each chat's waiting requests: how many, how many are questions, and the newest", () => {
  const approvals = { a: approval("a", "r1", "pending", "command", 100), b: approval("b", "r1", "pending", "question", 300), c: approval("c", "r1", "approved", "command", 900), d: approval("d", "r2", "pending", "question", 50) };
  const by = requestsByRoom({}, approvals);
  expect(by.get("r1")).toEqual({ count: 2, questions: 1, newest: 300 });
  expect(by.get("r2")).toEqual({ count: 1, questions: 1, newest: 50 });
  expect(by.has("r3")).toBe(false);
  // An agent that waits for you before its request has come in (or on an older hub): one, a question if it says so.
  expect(requestsByRoom({ m: member("r3", "approval") }, {}).get("r3")).toEqual({ count: 1, questions: 0, newest: null });
  expect(requestsByRoom({ m: { ...member("r3", "approval"), statusDetail: "Asks: which folder?" } }, {}).get("r3")).toEqual({ count: 1, questions: 1, newest: null });
  // The requests themselves say more than the status.
  expect(requestsByRoom({ m: member("r2", "approval") }, approvals).get("r2")).toEqual({ count: 1, questions: 1, newest: 50 });
});

const facts = (extra: Partial<RowFacts> = {}): RowFacts => ({ name: "Fix login", cwd: "/work/my-app", updatedAt: NOW - 2 * MIN, state: undefined, ...extra });

test("a row's second line says its state in words", () => {
  const words = (extra: Partial<RowFacts>) => rowStateWords(facts(extra), NOW);
  // Needs you.
  expect(words({ state: "needs", requests: { count: 1, questions: 0, newest: 1 } })).toBe("Needs your OK");
  expect(words({ state: "needs", requests: { count: 1, questions: 1, newest: 1 } })).toBe("Asked you a question");
  expect(words({ state: "needs", requests: { count: 2, questions: 0, newest: 1 } })).toBe("Needs your OK · 2");
  expect(words({ state: "needs", requests: { count: 3, questions: 1, newest: 1 } })).toBe("Needs your OK · 3");
  expect(words({ state: "needs", requests: { count: 2, questions: 2, newest: 1 } })).toBe("Asked you 2 questions");
  // Nothing known about the request itself: it still needs your OK.
  expect(words({ state: "needs" })).toBe("Needs your OK");
  // Failed: no reason beside it (the agents' own words for one aren't plain).
  expect(words({ state: "error" })).toBe("Failed");
  // Working: how long the reply has run, by the minute; just "Working" in its first minute or when that isn't known.
  expect(words({ state: "busy", workingSince: NOW - 12 * MIN - 40_000 })).toBe("Working · 12m");
  expect(words({ state: "busy", workingSince: NOW - 59_000 })).toBe("Working");
  expect(words({ state: "busy", workingSince: NOW - 60_000 })).toBe("Working · 1m");
  expect(words({ state: "busy", workingSince: NOW - 65 * MIN })).toBe("Working · 1h 5m");
  expect(words({ state: "busy", workingSince: NOW - 120 * MIN })).toBe("Working · 2h");
  expect(words({ state: "busy" })).toBe("Working");
  expect(words({ state: "busy", workingSince: null })).toBe("Working");
  // A clock a little ahead of this one never says a time that makes no sense.
  expect(words({ state: "busy", workingSince: NOW + 5000 })).toBe("Working");
  // Only helpers.
  expect(words({ state: "helpers", helpers: 1 })).toBe("1 helper working");
  expect(words({ state: "helpers", helpers: 3 })).toBe("3 helpers working");
  expect(words({ state: "helpers" })).toBe("1 helper working");
  // Waiting for a usage limit: when it's back, in this device's own clock; "Back soon" when the agent never said.
  expect(words({ state: "waiting", wait: { resetsAt: NOW + 3 * 60 * MIN } })).toMatch(/^Back at \d{1,2}:\d\d\s?(AM|PM)?$/i);
  expect(words({ state: "waiting", wait: { resetsAt: null } })).toBe("Back soon");
  expect(words({ state: "waiting", wait: null })).toBe("Back soon");
  expect(words({ state: "waiting" })).toBe("Back soon");
  // No state says "Waiting for you in the chat": that's Needs you.
  for (const state of ["needs", "error", "busy", "helpers", "waiting", undefined] as const) expect(words({ state })).not.toMatch(/waiting for you/i);
});

test("with no state, the second line says where the chat lives and when, without repeating its name", () => {
  const words = (extra: Partial<RowFacts>) => rowStateWords(facts(extra), NOW);
  expect(words({})).toBe("my-app · 2m ago");
  expect(words({ updatedAt: NOW - 10_000 })).toBe("my-app · just now");
  expect(words({ updatedAt: NOW - 3 * 60 * MIN })).toBe("my-app · 3h ago");
  expect(words({ updatedAt: NOW - 2 * 24 * 60 * MIN })).toBe("my-app · 2d ago");
  // The folder a new chat gets is its name as a folder name: said twice, it says nothing. Then just when.
  expect(words({ name: "Fix the login page", cwd: "/work/fix-the-login-page" })).toBe("2m ago");
  expect(words({ name: "Fix the login page", cwd: "/work/fix-the-login-page/" })).toBe("2m ago");
  // The same name taken already: the number tells nothing either.
  expect(words({ name: "Fix the login page", cwd: "/work/fix-the-login-page-2" })).toBe("2m ago");
  expect(words({ name: "Crosstalk", cwd: "/Users/me/Crosstalk" })).toBe("2m ago");
  // A long name's folder is cut where the hub cuts it (32 characters).
  expect(folderRepeatsName("A chat with a very long name that goes on", "/work/a-chat-with-a-very-long-name-tha")).toBe(true);
  // A folder of its own is said, even one that starts like the name.
  expect(words({ name: "Fix the login page", cwd: "/work/site" })).toBe("site · 2m ago");
  expect(words({ name: "Fix login", cwd: "/work/fix-login-page" })).toBe("fix-login-page · 2m ago");
  expect(words({ name: "Fix login", cwd: "/work/fix-login-v2" })).toBe("fix-login-v2 · 2m ago");
  expect(folderRepeatsName("Fix login", "/work/fix-login-")).toBe(false);
  // A group chat says who's in it instead of its folder.
  expect(words({ who: "@claude and @codex" })).toBe("@claude and @codex · 2m ago");
  // A state's words never carry the folder.
  expect(words({ state: "busy", workingSince: NOW - 5 * MIN })).not.toContain("my-app");
});

test("times in a few letters, and read out in full", () => {
  expect(agoWords(NOW - 44_000, NOW)).toBe("just now");
  expect(agoWords(NOW - 45_000, NOW)).toBe("1m ago");
  expect(agoWords(NOW - 59 * MIN, NOW)).toBe("59m ago");
  expect(agoWords(NOW - 60 * MIN, NOW)).toBe("1h ago");
  expect(agoWords(NOW - 60 * MIN, NOW, true)).toBe("1 hour ago");
  expect(agoWords(NOW - 5 * MIN, NOW, true)).toBe("5 minutes ago");
  expect(agoWords(NOW - 3 * 24 * 60 * MIN, NOW, true)).toBe("3 days ago");
  expect(workedWords(30_000)).toBe("");
  expect(workedWords(MIN)).toBe("1m");
  expect(workedWords(MIN, true)).toBe("1 minute");
  expect(workedWords(125 * MIN)).toBe("2h 5m");
  expect(workedWords(125 * MIN, true)).toBe("2 hours 5 minutes");
  expect(workedWords(60 * MIN, true)).toBe("1 hour");
});

test("a row has one label for a screen reader: its name, its state and when", () => {
  expect(rowLabel(facts(), {}, NOW)).toBe("Fix login, my-app, 2 minutes ago");
  expect(rowLabel(facts(), { unread: true }, NOW)).toBe("Fix login, new reply, my-app, 2 minutes ago");
  expect(rowLabel(facts({ name: "Fix the login page", cwd: "/work/fix-the-login-page" }), { machine: "Mac mini" }, NOW)).toBe("Fix the login page, 2 minutes ago, on Mac mini");
  // With a state: the state, then when it was last active (the second line has no room for that).
  expect(rowLabel(facts({ state: "needs", requests: { count: 1, questions: 0, newest: 1 } }), {}, NOW)).toBe("Fix login, Needs your OK, 2 minutes ago");
  expect(rowLabel(facts({ state: "needs", requests: { count: 2, questions: 0, newest: 1 } }), {}, NOW)).toBe("Fix login, Needs your OK, 2 requests, 2 minutes ago");
  expect(rowLabel(facts({ state: "error" }), { machine: "Linux box" }, NOW)).toBe("Fix login, Failed, 2 minutes ago, on Linux box");
  expect(rowLabel(facts({ state: "busy", workingSince: NOW - 12 * MIN }), {}, NOW)).toBe("Fix login, Working for 12 minutes, 2 minutes ago");
  expect(rowLabel(facts({ state: "helpers", helpers: 2 }), { unread: true }, NOW)).toBe("Fix login, new reply, 2 helpers working, 2 minutes ago");
  expect(rowLabel(facts({ state: "waiting", wait: null }), {}, NOW)).toBe("Fix login, Back soon, 2 minutes ago");
});

test("what a folded section counts, and which one never folds", () => {
  expect(SECTIONS.filter(canFold)).toEqual(["pinned", "working", "recent"]);
  // Needs you stays open whatever this device kept (an older version's key, or a store someone edited).
  expect(isFolded({ needs: true }, "needs", false)).toBe(false);
  const rows = [row("asks", "needs"), row("failed", "error"), row("busy", "busy"), row("helpers", "helpers"), row("limit", "waiting"), row("unread", undefined, { lastReplyAt: 2000, readAt: 1000 }), row("quiet", undefined)];
  // Pinned holds chats in every state: it counts each one the list would never cut off, and its mark is the strongest.
  expect(sectionFold("pinned", rows)).toEqual({ count: 7, attention: 6, mark: "needs" });
  expect(sectionFold("pinned", rows.slice(1))).toEqual({ count: 6, attention: 5, mark: "error" });
  expect(sectionFold("pinned", rows.slice(2))).toEqual({ count: 5, attention: 4, mark: "" });
  // Recent: its unread replies — the same rows "Show all" never cuts off.
  const recent = [...Array.from({ length: SHOWN }, (_, i) => row(`plain${i}`, undefined)), row("unread", undefined, { lastReplyAt: 2000, readAt: 1000 }), row("quiet", undefined)];
  const look = (r: ListRow) => keepInView(r.room, r.state);
  expect(sectionFold("recent", recent)).toEqual({ count: SHOWN + 2, attention: 1, mark: "" });
  expect(ids(shownRows(recent, look).slice(SHOWN))).toEqual(["unread"]);
  expect(ids(recent.filter(look))).toEqual(["unread"]);
  expect(foldedWords(sectionFold("recent", recent).count, sectionFold("recent", recent).attention)).toBe("14 chats, 1 needs a look");
  // Working: how many, and no more — none of them waits for you, and the heading says what they're doing.
  const working = rows.filter((r) => sectionOf(r) === "working");
  expect(sectionFold("working", working)).toEqual({ count: 3, attention: 0, mark: "" });
  expect(foldLabel("working", true, 3, 0)).toBe("Show working chats, 3 chats");
  // Under a folded heading (which has the count): only that something needs a look, or nothing at all.
  expect(foldedSaid(0)).toBe("");
  expect(foldedSaid(1)).toBe("1 needs a look");
  expect(foldedSaid(4)).toBe("4 need a look");
  expect(foldedSaid(sectionFold("working", working).attention)).toBe("");
  expect(foldLabel("recent", false, 14, 1)).toBe("Hide recent chats");
  expect(sectionFold("recent", [])).toEqual({ count: 0, attention: 0, mark: "" });
});

test("while a finger is on the list every chat keeps its place; when it lifts, the list is as it is", () => {
  const key = (r: ListRow) => r.room.id;
  const before = listSections([row("asks", "needs", { updatedAt: 50 }), row("busy", "busy", { updatedAt: 40 }), row("a", undefined, { updatedAt: 30 }), row("b", undefined, { updatedAt: 20 })]);
  const was = placesOf(before, key);
  expect(was).toEqual([{ section: "needs", keys: ["asks"] }, { section: "working", keys: ["busy"] }, { section: "recent", keys: ["a", "b"] }]);
  // Meanwhile: the working one finished with a new reply (Recent's top), "b" started working, the request was answered.
  const live = listSections([row("asks", undefined, { updatedAt: 50 }), row("busy", undefined, { updatedAt: 90, lastReplyAt: 90 }), row("a", undefined, { updatedAt: 30 }), row("b", "busy", { updatedAt: 95 })]);
  expect(live.map((s) => [s.section, ids(s.rows)])).toEqual([["working", ["b"]], ["recent", ["busy", "asks", "a"]]]);
  // Held: nothing moved, and each row is the chat as it is now (its words follow it).
  const held = heldSections(was, live, key);
  expect(held.map((s) => [s.section, ids(s.rows)])).toEqual([["needs", ["asks"]], ["working", ["busy"]], ["recent", ["a", "b"]]]);
  expect(held[1].rows[0].state).toBeUndefined();
  expect(held[2].rows[1].state).toBe("busy");
  // A chat that came meanwhile goes to the end of its own section; one that went is gone, and so is a section left empty.
  const more = listSections([row("busy", undefined, { updatedAt: 90 }), row("a", undefined, { updatedAt: 30 }), row("b", "busy", { updatedAt: 95 }), row("new", undefined, { updatedAt: 99 }), row("pin", undefined, { pinnedAt: 5 })]);
  expect(heldSections(was, more, key).map((s) => [s.section, ids(s.rows)])).toEqual([["pinned", ["pin"]], ["working", ["busy"]], ["recent", ["a", "b", "new"]]]);
  // Nothing held (the list just drawn): as it is.
  expect(heldSections(placesOf(live, key), live, key)).toEqual(live);
  expect(heldSections([], live, key)).toEqual(live);
});
