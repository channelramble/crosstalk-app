// Search across chats and Markdown export (docs/SPEC-0.4.md section 14, track T8). Nothing here runs an agent: chats are
// made with the app's own code and their messages written straight into the store.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownFileName, type Message, type SearchResponse } from "@crosstalk/shared";
import { App } from "../src/app";
import { disposition, exportText, shownText, snippetOf } from "../src/search";
import { startServer } from "../src/server";
import { newId } from "../src/util/ids";

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Chat = { room: { id: string; name: string }; member: { id: string; handle: string } };

/** A hub on port 0 with one device (and one that belongs to another machine's hub), and helpers to fill chats. */
async function hub() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "ct-search-")));
  dirs.push(work);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
  const server = startServer(app);
  cleanups.push(async () => {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
  });
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!;
  const peer = (await app.auth.pair((await app.auth.createPairingCode(undefined, { scope: "peer", hubId: "h_other" })).code, "Other hub", "Hub"))!;
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, token: string | null = device.token) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  let at = Date.parse("2026-10-20T10:00:00Z");
  const chat = (name: string, opts: { privateFromAgents?: boolean; provider?: "claude" | "codex" } = {}): Chat => {
    const room = app.chats.create({ provider: opts.provider ?? "claude", name, model: "claude-test", ...(opts.privateFromAgents ? { privateFromAgents: true } : {}) });
    return { room, member: app.chats.member(room.id)! };
  };
  const say = (c: Chat, kind: "human" | "agent" | "system", text: string, patch: Partial<Message> = {}) => {
    const m: Message = { id: newId("m"), roomId: c.room.id, authorKind: kind, memberId: kind === "agent" ? c.member.id : null, authorName: kind === "agent" ? c.member.handle : "iPhone", text, mentions: [], turnId: null, status: "done", createdAt: (at += 60_000), updatedAt: at, via: null, ...patch };
    return { ...m, seq: app.store.insertMessage(m) };
  };
  const search = async (q: string, extra = "") => (await (await get(`/api/search?q=${encodeURIComponent(q)}${extra}`)).json()) as SearchResponse;
  return { app, get, peerToken: peer.token, chat, say, search, base };
}

describe("search", () => {
  test("finds a word in any case inside any chat, newest first, with who said it, where and a snippet", async () => {
    const h = await hub();
    const fix = h.chat("Fix login");
    const notes = h.chat("Release notes");
    const first = h.say(fix, "human", "The Login page is broken");
    h.say(notes, "agent", "I wrote the notes. Nothing about signing in.");
    const second = h.say(fix, "agent", "Fixed: the login form posted to the wrong URL.");
    const r = await h.search("LOGIN");
    expect(r.results.map((x) => x.messageId)).toEqual([second.id, first.id]);
    expect(r.results[0]).toMatchObject({ roomId: fix.room.id, roomName: "Fix login", who: "agent", seq: second.seq, createdAt: second.createdAt, snippet: "Fixed: the login form posted to the wrong URL." });
    expect(r.results[1]).toMatchObject({ who: "you", seq: first.seq, snippet: "The Login page is broken" });
    expect(r.truncated).toBe(false);
    // The same words typed lower case, with spaces around them, find the same.
    expect((await h.search("  login ")).results.map((x) => x.messageId)).toEqual([second.id, first.id]);
    expect((await h.search("wrong url")).results).toHaveLength(1);
    expect((await h.search("zebra")).results).toEqual([]);
  });

  test("a chat's name matches too, even with no message that does", async () => {
    const h = await hub();
    const plan = h.chat("Alpha plan");
    h.chat("Beta");
    h.say(plan, "human", "Let's go");
    const r = await h.search("ALPHA");
    expect(r.results).toEqual([]);
    expect(r.chats).toEqual([{ roomId: plan.room.id, roomName: "Alpha plan", updatedAt: expect.any(Number) }]);
  });

  test("a query under 2 characters finds nothing (after trimming), and % _ and \\ are text, not wildcards", async () => {
    const h = await hub();
    const c = h.chat("Odd characters");
    h.say(c, "human", "50% off today");
    h.say(c, "human", "fifty percent off");
    h.say(c, "human", "snake_case name");
    h.say(c, "human", "snakeXcase name");
    h.say(c, "human", "a back\\slash path");
    h.say(c, "human", "just a backslash word");
    for (const q of ["", "a", "  a ", "%", "_"]) expect(await h.search(q)).toEqual({ results: [], chats: [], truncated: false });
    expect((await h.search("50%")).results.map((x) => x.snippet)).toEqual(["50% off today"]);
    expect((await h.search("%")).results).toEqual([]);
    expect((await h.search("e_c")).results.map((x) => x.snippet)).toEqual(["snake_case name"]);
    expect((await h.search("k\\s")).results.map((x) => x.snippet)).toEqual(["a back\\slash path"]);
    // Two characters that are all wildcards match only themselves.
    expect((await h.search("%%")).results).toEqual([]);
    expect((await h.search("__")).results).toEqual([]);
  });

  test("skips replies still being written and Crosstalk's own notes; counts a message another chat's agent sent as an agent's", async () => {
    const h = await hub();
    const c = h.chat("Mixed");
    h.say(c, "agent", "needle still streaming", { status: "streaming" });
    h.say(c, "system", "needle in a note");
    const relayed = h.say(c, "human", "needle from another chat", { via: { hubId: "h_x", machine: "Linux box", chatId: "r_other", chatName: "Other", agent: "Codex", hop: 1, kind: "message" } });
    const stopped = h.say(c, "agent", "needle, stopped half way", { status: "stopped" });
    const r = await h.search("needle");
    expect(r.results.map((x) => [x.messageId, x.who, x.agent])).toEqual([[stopped.id, "agent", undefined], [relayed.id, "agent", "Codex"]]);
  });

  test("names the agent of a message another chat's agent sent here, and of a reply copied from another agent; you and the chat's own agent name no one", async () => {
    const h = await hub();
    // Two chats: a search sends at most 3 hits from one.
    const a = h.chat("Claude chat");
    const b = h.chat("Another Claude chat");
    const own = h.say(a, "agent", "needle from this chat's agent");
    const yours = h.say(a, "human", "needle from me");
    const copied = h.say(a, "agent", "needle in a copied reply", { copy: { kind: "reply", agent: "Codex", provider: "codex" } });
    const via = (agent: string) => ({ hubId: "h_x", machine: "Linux box", chatId: "r_other", chatName: "Other", agent, hop: 1, kind: "message" as const });
    const relayed = h.say(b, "human", "needle sent in", { via: via("Codex") });
    const long = h.say(b, "human", "needle from a long name", { via: via(`  ${"A".repeat(100)}  `) });
    const broken = h.say(b, "human", "needle from a name that can't be read", { via: via("Codex") });
    h.app.store.db.run("UPDATE messages SET via = ? WHERE id = ?", ["{not json", broken.id]);
    const r = await h.search("needle");
    expect(r.results.map((x) => [x.messageId, x.who, x.agent])).toEqual([
      [broken.id, "agent", undefined],
      [long.id, "agent", "A".repeat(60)],
      [relayed.id, "agent", "Codex"],
      [copied.id, "agent", "Codex"],
      [yours.id, "you", undefined],
      [own.id, "agent", undefined],
    ]);
    // Nothing is said of who wrote the ones that name no one: the key isn't there at all.
    expect(r.results.filter((x) => "agent" in x).map((x) => x.messageId)).toEqual([long.id, relayed.id, copied.id]);
  });

  test("at most 30 hits and 3 from one chat, newest first, and it says when there were more", async () => {
    const h = await hub();
    const chats = Array.from({ length: 12 }, (_, i) => h.chat(`Chat ${i + 1}`));
    const said: string[] = [];
    for (let round = 0; round < 4; round++) for (const c of chats) said.push(h.say(c, "human", `needle ${c.room.name} round ${round}`).id);
    const r = await h.search("needle");
    expect(r.results).toHaveLength(30);
    expect(r.truncated).toBe(true);
    const per = new Map<string, number>();
    for (const x of r.results) per.set(x.roomId, (per.get(x.roomId) ?? 0) + 1);
    expect(Math.max(...per.values())).toBe(3);
    expect(per.size).toBe(12);
    // Newest first, and the oldest round of each chat is the one left out.
    expect(r.results.map((x) => x.seq)).toEqual([...r.results.map((x) => x.seq)].sort((a, b) => b - a));
    expect(r.results.some((x) => x.snippet.endsWith("round 0"))).toBe(false);
    // `limit` asks for fewer (and never more than 30).
    expect((await h.search("needle", "&limit=5")).results).toHaveLength(5);
    expect((await h.search("needle", "&limit=500")).results).toHaveLength(30);
    expect((await h.search("needle", "&limit=banana")).results).toHaveLength(30);
    // The same query again: nothing was left half-read by stopping early.
    expect((await h.search("needle")).results).toHaveLength(30);
  });

  test("three matches in one chat are all there; a fourth makes it say there are more", async () => {
    const h = await hub();
    const a = h.chat("A");
    const b = h.chat("B");
    for (let i = 0; i < 3; i++) h.say(a, "agent", `thing ${i}`);
    h.say(b, "agent", "thing in b");
    let r = await h.search("thing");
    expect(r.results).toHaveLength(4);
    expect(r.truncated).toBe(false);
    h.say(a, "agent", "thing 3");
    r = await h.search("thing");
    expect(r.results).toHaveLength(4);
    expect(r.truncated).toBe(true);
    expect(r.results.filter((x) => x.roomId === a.room.id).map((x) => x.snippet)).toEqual(["thing 3", "thing 2", "thing 1"]);
  });

  test("goes on listing after it knows there are more: a chat's fourth match doesn't hide older matches in other chats", async () => {
    const h = await hub();
    const [a, b, c] = [h.chat("A"), h.chat("B"), h.chat("C")];
    for (let i = 0; i < 3; i++) {
      h.say(b, "agent", `thing b${i}`);
      h.say(c, "agent", `thing c${i}`);
    }
    for (let i = 0; i < 4; i++) h.say(a, "agent", `thing a${i}`);
    const r = await h.search("thing");
    expect(r.truncated).toBe(true);
    expect(r.results.map((x) => x.roomName).sort()).toEqual(["A", "A", "A", "B", "B", "B", "C", "C", "C"]);
    expect(r.results.slice(0, 3).map((x) => x.snippet)).toEqual(["thing a3", "thing a2", "thing a1"]);
  });

  test("chats kept private from other chats' agents are searched too, and so are group chats; rooms that aren't chats are not", async () => {
    const h = await hub();
    const secret = h.chat("Secret plans", { privateFromAgents: true });
    h.say(secret, "human", "the launch codeword is swordfish");
    // A room made the older way is a group chat now: its messages are searched like any chat's.
    const room = h.app.createRoom({ name: "Old group room", mode: "direct" });
    h.app.store.insertMessage({ id: newId("m"), roomId: room.id, authorKind: "human", memberId: null, authorName: "iPhone", text: "swordfish in a group room", mentions: [], turnId: null, status: "done", createdAt: 1, updatedAt: 1, via: null });
    // A room that's neither (as only an old test's database has) isn't.
    const legacy = { id: newId("r"), name: "Neither", cwd: h.app.config.workspaceRoot, mode: "direct" as const, leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1, updatedAt: 1, archived: false };
    h.app.store.insertRoom(legacy);
    h.app.store.insertMessage({ id: newId("m"), roomId: legacy.id, authorKind: "human", memberId: null, authorName: "iPhone", text: "swordfish nowhere", mentions: [], turnId: null, status: "done", createdAt: 1, updatedAt: 1, via: null });
    const r = await h.search("swordfish");
    expect(r.results.map((x) => x.roomName)).toEqual(["Old group room", "Secret plans"]);
  });

  test("only the person's own devices may search: no sign-in, or another machine's sign-in, is refused", async () => {
    const h = await hub();
    const c = h.chat("Private");
    h.say(c, "human", "swordfish");
    expect((await h.get("/api/search?q=swordfish", null)).status).toBe(401);
    const peer = await h.get("/api/search?q=swordfish", h.peerToken);
    expect(peer.status).toBe(403);
    expect(((await peer.json()) as { code: string }).code).toBe("peer_scope");
    expect((await h.get(`/api/chats/${c.room.id}/export.md`, h.peerToken)).status).toBe(403);
  });

  test("a deleted chat's messages are gone from search", async () => {
    const h = await hub();
    const c = h.chat("Short lived");
    h.say(c, "human", "swordfish");
    expect((await h.search("swordfish")).results).toHaveLength(1);
    await h.app.deleteRoom(c.room.id);
    expect((await h.search("swordfish")).results).toEqual([]);
  });
});

describe("a message with files", () => {
  const UPLOAD = "/api/rooms/r_x/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const FOLDER = "/api/rooms/r_x/folders/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  /** A message as the hub stores it with two files (uploads.ts attachmentText): the chat shows their names only. */
  const withFiles = (prose: string) =>
    `${prose}\n\nAttachments (open these local files only if needed):\n- [login.png](${UPLOAD}_login.png) — local path: "/Users/someone/work/app/login.png"\n- [src/](${FOLDER}/src) (3 files) — local path: "/Users/someone/work/app/src"`;
  const NOTHING = { results: [], chats: [], truncated: false };

  test("is found by its prose and by its files' names, and quoted as the chat shows it: names, with no links and no local paths", async () => {
    const h = await hub();
    const c = h.chat("Screens");
    const m = h.say(c, "human", withFiles("Please look at the screenshot"));
    expect((await h.search("screenshot")).results[0].snippet).toBe("Please look at the screenshot Attachments: - login.png - src/ (3 files)");
    // The note's own heading ("Attachments:") and each file's name, as it's drawn, are on screen too.
    for (const q of ["screenshot", "login.png", "LOGIN", "src/", "3 files", "Attachments"]) {
      const r = await h.search(q);
      expect(r.results.map((x) => x.messageId)).toEqual([m.id]);
      expect(r.results[0].snippet).toMatch(/Attachments: - login\.png - src\/ \(3 files\)$/);
      expect(r.results[0].snippet).not.toMatch(/api\/rooms|local path|local files|\/Users|\]\(/);
    }
  });

  test("is not found by the hub's note about files, a link's address or the machine's local paths: the chat shows none of them", async () => {
    const h = await hub();
    const c = h.chat("Screens");
    h.say(c, "human", withFiles("Please look at the screenshot"));
    for (const q of ["local path", "local files", "only if needed", "Users", "someone", "app/", "uploads", "folders", "api/rooms", "aaaaaaaa", "r_x", "work"]) expect(await h.search(q)).toEqual(NOTHING);
    // A word that is also in its prose finds it, and the snippet quotes the prose.
    const prose = h.say(c, "human", withFiles("Open the work folder please"));
    const r = await h.search("work");
    expect(r.results.map((x) => x.messageId)).toEqual([prose.id]);
    expect(r.results[0].snippet).toBe("Open the work folder please Attachments: - login.png - src/ (3 files)");
  });

  test("matching only in what the chat hides counts for nothing: not toward 3 from a chat, and not as more matches", async () => {
    const h = await hub();
    const c = h.chat("Many files");
    const real = h.say(c, "human", "Where is the local path set?");
    for (let i = 0; i < 5; i++) h.say(c, "human", withFiles(`Screenshot ${i}`));
    const r = await h.search("local path");
    expect(r.results.map((x) => x.messageId)).toEqual([real.id]);
    expect(r.truncated).toBe(false);
  });

  test("shownText: the note says Attachments:, a file is its name, a folder keeps its count, and anything else is as written", () => {
    expect(shownText(`hi\n\nAttachments (open these local files only if needed):\n- [my\\[1\\].txt](${UPLOAD}_my.txt) — local path: "/x/y"\n- [src/](${FOLDER}/src) (3 files) — local path: "/x/src"\n- [one/](${FOLDER}/one) (1 file) — local path: "/x/one"`)).toBe("hi\n\nAttachments:\n- my[1].txt\n- src/ (3 files)\n- one/ (1 file)");
    expect(shownText('- Folder src (3 files) — local path: "/x/src"')).toBe("- Folder src (3 files)");
    const own = `see [docs](https://example.com/uploads/a) — local path: nothing, and ![x](${UPLOAD}_a.png)`;
    expect(shownText(own)).toBe(own);
    expect(shownText("no files here")).toBe("no files here");
  });
});

describe("snippets", () => {
  test("a short text is kept whole; a long one is cut around the first match with … at each cut", () => {
    expect(snippetOf("Hello there", "there")).toBe("Hello there");
    const long = `${"a ".repeat(100)}Login ${"b ".repeat(100)}`;
    const s = snippetOf(long, "login");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain(" Login ");
    expect(s.length).toBeLessThan(160);
    // A match at the start has nothing cut before it.
    expect(snippetOf(`Login ${"b ".repeat(100)}`, "login").startsWith("Login")).toBe(true);
  });

  test("new lines and runs of spaces become single spaces around the match; the match itself stays as written", () => {
    expect(snippetOf("line one\n\n  Login   two\n\nthree", "login")).toBe("line one Login two three");
    expect(snippetOf("a.b(c) and A.B(C)", "a.b(c)")).toBe("a.b(c) and A.B(C)");
    expect(snippetOf("price is $5 [now]", "$5 [now]")).toBe("price is $5 [now]");
  });

  test("never splits an emoji", () => {
    const text = `${"x".repeat(49)}😀 needle ${"y".repeat(88)}😀 and more text after it so it is cut`;
    const s = snippetOf(text, "needle");
    expect(s).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("Markdown export", () => {
  const UPLOAD = "/api/rooms/r_x/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  test("title, agent and model, date, then every message as **You:** or **Agent:**: code kept, images as [image], no steps", async () => {
    const h = await hub();
    const c = h.chat("Fix login");
    h.say(c, "human", `Please fix the login.\n\nAttachments (open these local files only if needed):\n- [shot.png](${UPLOAD}_shot.png) — local path: "/tmp/secret/shot.png"\n- [notes.pdf](${UPLOAD}_notes.pdf) — local path: "/tmp/secret/notes.pdf"`);
    const reply = h.say(c, "agent", "Here is the fix:\n\n```ts\nconst a = '![not an image](x.png)';\n```\n\n![diagram](/api/rooms/r_x/uploads/x.png) and ![remote](https://example.com/a(1).png) and `![inline](code.png)`");
    h.app.store.insertTurn({ id: "t_1", roomId: c.room.id, memberId: c.member.id, triggerMessageId: null, replyMessageId: reply.id, hop: 0, chainId: "ch_1", origin: "human", status: "done", error: null, usage: null, createdAt: 1, startedAt: 1, endedAt: 2 });
    h.app.store.upsertActivity({ id: "a_1", roomId: c.room.id, turnId: "t_1", memberId: c.member.id, kind: "command", title: "Ran the tests", detail: "TOOL OUTPUT THAT MUST NOT BE EXPORTED", status: "done", createdAt: 1, updatedAt: 2 });
    h.say(c, "human", "Thanks, that works");
    const res = await h.get(`/api/chats/${c.room.id}/export.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Fix login.md"; filename*=UTF-8''Fix%20login.md`);
    const md = await res.text();
    expect(md).toMatch(/^# Fix login\n\nClaude Code \(claude-test\) · Exported \d{4}-\d{2}-\d{2} from .+\n\n---\n\n\*\*You:\*\*\n\nPlease fix the login\./);
    expect(md).toContain("Attachments:\n- [image]\n- [file: notes.pdf]");
    expect(md).not.toContain("local path");
    expect(md).not.toContain("/tmp/secret");
    expect(md).toContain("\n\n---\n\n**Claude Code:**\n\nHere is the fix:\n\n```ts\nconst a = '![not an image](x.png)';\n```\n\n[image] and [image] and `![inline](code.png)`");
    expect(md).not.toContain("TOOL OUTPUT");
    // Your last message has no reply yet, and it's there.
    expect(md.endsWith("\n\n---\n\n**You:**\n\nThanks, that works\n")).toBe(true);
    expect(md).not.toContain("Cut short");
  });

  test("a chat at work can be exported; a stopped reply and another chat's agent are labelled", async () => {
    const h = await hub();
    const c = h.chat("Busy one");
    h.say(c, "human", "hello");
    h.say(c, "agent", "half an ans", { status: "stopped" });
    h.say(c, "agent", "still being written", { status: "streaming" });
    h.say(c, "human", "from the other chat", { via: { hubId: "h_x", machine: "Linux box", chatId: "r_o", chatName: 'The "other" one', agent: "Codex", hop: 1, kind: "message" } });
    h.app.engine.isBusy = () => true;
    const res = await h.get(`/api/chats/${c.room.id}/export.md`);
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toContain("**Claude Code (stopped):**\n\nhalf an ans");
    expect(md).toContain(`**Codex (in the chat "The 'other' one", not you):**\n\nfrom the other chat`);
    expect(md).not.toContain("still being written");
  });

  test("says so when a long chat was cut short (the same limits as a copy to another machine)", async () => {
    const h = await hub();
    const c = h.chat("Very long");
    for (let i = 0; i < 5_010; i++) h.say(c, i % 2 ? "agent" : "human", `message ${i}`);
    const md = await (await h.get(`/api/chats/${c.room.id}/export.md`)).text();
    expect(md).toContain("> Cut short: the first 10 messages of this chat aren't here. It's longer than an export holds.");
    expect(md).not.toContain("message 9\n");
    expect(md).toContain("message 10\n");
    expect(md).toContain("message 5009\n");
  });

  test("one message of 100,000 characters or more is cut and says so", async () => {
    const h = await hub();
    const c = h.chat("Huge reply");
    h.say(c, "human", "go");
    h.say(c, "agent", "x".repeat(150_000));
    const md = await (await h.get(`/api/chats/${c.room.id}/export.md`)).text();
    expect(md).toContain("*The rest of this message is left out: it's too long to export.*");
    expect(md.length).toBeLessThan(110_000);
  });

  test("an unknown chat, and a room that isn't a chat, are 404 with a plain sentence", async () => {
    const h = await hub();
    const none = await h.get("/api/chats/r_nope/export.md");
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toBe("No such chat");
    const room = h.app.createRoom({ name: "Old group room", mode: "direct" });
    expect((await h.get(`/api/chats/${room.id}/export.md`)).status).toBe(404);
    expect((await h.get("/api/chats/r_nope/export.md", null)).status).toBe(401);
  });

  test("the JSON export a copy to another machine reads is as it was", async () => {
    const h = await hub();
    const c = h.chat("Unchanged");
    h.say(c, "human", "question");
    h.say(c, "agent", "answer");
    h.say(c, "human", "unanswered");
    const exp = (await (await h.get(`/api/chats/${c.room.id}/export`)).json()) as { messages: { text: string }[] };
    expect(exp.messages.map((m) => m.text)).toEqual(["question", "answer"]);
  });

  test("attachment lines and images: only prose changes, folders are named, and nothing local is left", () => {
    expect(exportText(`see ![a](${UPLOAD}_p.png)`)).toBe("see [image]");
    expect(exportText("- [my\\[1\\].txt](/api/rooms/r_x/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_my.txt) — local path: \"/x/y\"")).toBe("- [file: my[1].txt]");
    expect(exportText("- [src/](/api/rooms/r_x/folders/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/src) (3 files) — local path: \"/x/src\"")).toBe("- [folder: src/]");
    expect(exportText("```\n![x](y.png)\n```")).toBe("```\n![x](y.png)\n```");
    expect(exportText("~~~\n![x](y.png)\n~~~ after ![z](q.jpg)")).toBe("~~~\n![x](y.png)\n~~~ after [image]");
  });

  test("file names: the chat's name without what a file name can't hold; the header gives it in ASCII and in full", () => {
    expect(markdownFileName("Fix login")).toBe("Fix login.md");
    expect(markdownFileName('a/b:c*d?"e')).toBe("a b c d e.md");
    expect(markdownFileName("  ..hidden  ")).toBe("hidden.md");
    expect(markdownFileName("")).toBe("Chat.md");
    expect(markdownFileName("x".repeat(200))).toBe(`${"x".repeat(80)}.md`);
    expect(disposition("Café (v2).md")).toBe(`attachment; filename="Caf_ (v2).md"; filename*=UTF-8''Caf%C3%A9%20%28v2%29.md`);
  });
});
