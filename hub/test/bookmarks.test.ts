// Bookmarks (bookmarks.ts): kept per message on its chat's hub, listed newest first, gone with their message or chat, and
// for people's own devices only. Nothing here runs an agent: messages are written straight into the store.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOKMARK_TEXT_MAX, type BookmarkList, type Message, type ServerEvent } from "@crosstalk/shared";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { newId } from "../src/util/ids";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function hub() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "ct-bookmarks-")));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
  const server = startServer(app);
  cleanups.push(async () => {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(work, { recursive: true, force: true });
  });
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!;
  const peer = (await app.auth.pair((await app.auth.createPairingCode(undefined, { scope: "peer", hubId: "h_other" })).code, "Other hub", "Hub"))!;
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method: string, path: string, body?: unknown, token = device.token) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  let at = Date.parse("2026-11-01T10:00:00Z");
  const chat = (name: string) => {
    const room = app.chats.create({ provider: "claude", name, model: "claude-test" });
    return { room, member: app.chats.member(room.id)! };
  };
  const say = (c: ReturnType<typeof chat>, kind: "human" | "agent", text: string, patch: Partial<Message> = {}) => {
    const m: Message = { id: newId("m"), roomId: c.room.id, authorKind: kind, memberId: kind === "agent" ? c.member.id : null, authorName: kind === "agent" ? c.member.handle : "iPhone", text, mentions: [], turnId: null, status: "done", createdAt: (at += 60_000), updatedAt: at, via: null, ...patch };
    return { ...m, seq: app.store.insertMessage(m) };
  };
  return { app, call, chat, say, peerToken: peer.token };
}

test("bookmarks: kept, listed newest first with who wrote them, taken off, and told to every device", async () => {
  const h = await hub();
  const events: ServerEvent[] = [];
  h.app.bus.on((e) => void (e.t === "bookmark" && events.push(e)));
  const fix = h.chat("Fix login");
  const notes = h.chat("Release notes");
  const mine = h.say(fix, "human", "The login page is broken");
  const reply = h.say(fix, "agent", "Fixed: the form posted to the wrong URL.");
  const other = h.say(notes, "human", "Draft these", { via: { kind: "chat", agent: "Codex", chatId: "r_x", chatName: "Elsewhere" } as any });

  expect((await h.call("GET", "/api/bookmarks")).body).toEqual({ bookmarks: [] });
  const first = await h.call("PUT", `/api/messages/${reply.id}/bookmark`, { bookmarked: true });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ messageId: reply.id, roomId: fix.room.id });
  expect(typeof first.body.at).toBe("number");
  // Each a moment later: the list is in the order they were bookmarked.
  await Bun.sleep(2);
  await h.call("PUT", `/api/messages/${mine.id}/bookmark`, { bookmarked: true });
  await Bun.sleep(2);
  await h.call("PUT", `/api/messages/${other.id}/bookmark`, { bookmarked: true });
  // Bookmarking again keeps when it was first.
  expect((await h.call("PUT", `/api/messages/${reply.id}/bookmark`, { bookmarked: true })).body.at).toBe(first.body.at);

  const list = (await h.call("GET", "/api/bookmarks")).body as BookmarkList;
  expect(list.bookmarks.map((b) => b.messageId)).toEqual([other.id, mine.id, reply.id]);
  expect(list.bookmarks[0]).toMatchObject({ roomName: "Release notes", who: "agent", agent: "Codex", text: "Draft these", cut: false });
  expect(list.bookmarks[1]).toMatchObject({ roomId: fix.room.id, roomName: "Fix login", who: "you", seq: mine.seq, createdAt: mine.createdAt });
  expect(list.bookmarks[1].agent).toBeUndefined();
  expect(list.bookmarks[2]).toMatchObject({ who: "agent", agent: `@${fix.member.handle}`, text: "Fixed: the form posted to the wrong URL." });
  // In the state too, for marking them in their chats.
  expect(Object.keys((await h.call("GET", "/api/state")).body.bookmarked).sort()).toEqual([mine.id, other.id, reply.id].sort());

  expect((await h.call("PUT", `/api/messages/${mine.id}/bookmark`, { bookmarked: false })).body.at).toBeNull();
  expect(((await h.call("GET", "/api/bookmarks")).body as BookmarkList).bookmarks.map((b) => b.messageId)).toEqual([other.id, reply.id]);
  expect(events.map((e) => e.t === "bookmark" && [e.messageId, e.at === null])).toEqual([
    [reply.id, false],
    [mine.id, false],
    [other.id, false],
    [reply.id, false],
    [mine.id, true],
  ]);
});

test("bookmarks: a long message is cut, one being written or gone is refused, and they go with their message or chat", async () => {
  const h = await hub();
  const c = h.chat("Long");
  const long = h.say(c, "agent", "x".repeat(BOOKMARK_TEXT_MAX + 10));
  const writing = h.say(c, "agent", "Still going", { status: "streaming" });
  const goes = h.say(c, "human", "Unsend me");
  expect((await h.call("PUT", `/api/messages/${writing.id}/bookmark`, { bookmarked: true })).status).toBe(409);
  expect((await h.call("PUT", `/api/messages/m_nope/bookmark`, { bookmarked: true })).status).toBe(404);
  expect((await h.call("PUT", `/api/messages/${long.id}/bookmark`, {})).status).toBe(400);
  await h.call("PUT", `/api/messages/${long.id}/bookmark`, { bookmarked: true });
  await h.call("PUT", `/api/messages/${goes.id}/bookmark`, { bookmarked: true });
  let list = ((await h.call("GET", "/api/bookmarks")).body as BookmarkList).bookmarks;
  const cut = list.find((b) => b.messageId === long.id)!;
  expect(cut.text.length).toBe(BOOKMARK_TEXT_MAX);
  expect(cut.cut).toBe(true);

  h.app.store.db.run("DELETE FROM messages WHERE id = ?", [goes.id]);
  list = ((await h.call("GET", "/api/bookmarks")).body as BookmarkList).bookmarks;
  expect(list.map((b) => b.messageId)).toEqual([long.id]);
  expect((await h.call("DELETE", `/api/rooms/${c.room.id}`)).status).toBeLessThan(300);
  expect(((await h.call("GET", "/api/bookmarks")).body as BookmarkList).bookmarks).toEqual([]);
});

test("bookmarks: another machine's hub can't read or change them, and its state has none", async () => {
  const h = await hub();
  const c = h.chat("Private");
  const m = h.say(c, "human", "Keep this");
  await h.call("PUT", `/api/messages/${m.id}/bookmark`, { bookmarked: true });
  expect((await h.call("GET", "/api/bookmarks", undefined, h.peerToken)).status).toBe(403);
  expect((await h.call("PUT", `/api/messages/${m.id}/bookmark`, { bookmarked: false }, h.peerToken)).status).toBe(403);
  const state = await h.call("GET", "/api/state", undefined, h.peerToken);
  if (state.status === 200) expect(state.body.bookmarked ?? {}).toEqual({});
});
