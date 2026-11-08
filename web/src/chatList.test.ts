import { expect, test } from "bun:test";
import type { Approval, MachineInfo, Member, Room } from "@crosstalk/shared";
import { GROUP_CHATS_GROUP, PINNED_GROUP, SHOWN, chatMatches, foldLabel, foldMark, foldedWords, folderName, isFolded, isUnread, keepInView, linkedNotHere, machineTag, needsYou, readFolded, requestWords, rowStates, shownRows, writtenFolded } from "./chatList";

const room = (id: string, extra: Partial<Room> = {}): Room => ({ id, name: `Chat ${id}`, cwd: `/work/${id}`, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1, updatedAt: 1, archived: false, chat: { provider: "codex", origin: "web" }, ...extra });
const member = (roomId: string, status: Member["status"]): Member => ({ id: `mb-${roomId}`, roomId, handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status, statusDetail: null, config: {}, createdAt: 1, position: 0 });
const approval = (id: string, roomId: string, status: Approval["status"] = "pending", kind: Approval["kind"] = "command"): Approval => ({ id, roomId, memberId: `mb-${roomId}`, turnId: null, kind, title: "Run tests", detail: "", status, decision: null, decidedBy: null, createdAt: 1, decidedAt: null });

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
  expect(foldLabel("group", false, 4, 0)).toBe("Hide group chats");
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
  expect(foldedWords(rows.length, rows.filter(look).length)).toBe("14 chats, 5 need a look");
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
  const folded = { codex: true, [PINNED_GROUP]: true, [GROUP_CHATS_GROUP]: true };
  expect(isFolded(folded, "codex", false)).toBe(true);
  // Per group: another one stays open.
  expect(isFolded(folded, "claude", false)).toBe(false);
  expect(isFolded(folded, "svc:codex:a1", false)).toBe(false);
  // Searching ignores folding: matches show wherever they are, as "Show all" already does.
  expect(isFolded(folded, "codex", true)).toBe(false);
  expect(isFolded({}, "codex", false)).toBe(false);
});
