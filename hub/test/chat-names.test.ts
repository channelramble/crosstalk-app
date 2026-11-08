import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Room } from "@crosstalk/shared";
import { App } from "../src/app";
import { NEW_CHAT } from "../src/chats";
import { buildRoutes } from "../src/server";

/** A dated new folder in the workspaces folder ("chat-2026-10-28", or "-2" after it when that one was taken). */
const dated = (root: string, cwd: string) => cwd.startsWith(`${root}/`) && /^chat-\d{4}-\d{2}-\d{2}(-\d+)?$/.test(cwd.slice(root.length + 1));

/** A hub whose routes are called directly. No agent ever runs: a message is only noted. */
function hub() {
  const dir = mkdtempSync(join(tmpdir(), "ct-chat-names-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const sent: string[] = [];
  app.engine.postHumanMessage = ((roomId: string, text: string) => (sent.push(text), { id: `m${sent.length}`, roomId, seq: sent.length })) as never;
  const routes = buildRoutes(app);
  const device = { id: "dev", name: "Phone", platform: "Web", createdAt: 0, lastSeenAt: null } as never;
  const call = async <T = Room>(method: string, path: string, body: unknown = {}): Promise<T> => {
    const url = new URL(`http://hub${path}`);
    for (const r of routes) {
      const m = r.method === method ? r.pattern.exec(url.pathname) : null;
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return (await r.handler({ req: new Request(url.href, { method }), url, params, device, body: async () => body })) as T;
    }
    throw new Error(`No route for ${method} ${path}`);
  };
  const say = (room: Room, text: string) => call("POST", `/api/rooms/${room.id}/messages`, { text });
  return { app, dir, sent, call, say, done: async () => (await app.engine.shutdown(), app.store.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("a chat named when it's made keeps its name, and its new folder is named after it", async () => {
  const t = hub();
  try {
    const room = await t.call("POST", "/api/chats", { provider: "codex", name: "  Fix   the\nlogin page  " });
    expect(room.name).toBe("Fix the login page");
    expect(room.cwd).toBe(join(t.dir, "fix-the-login-page"));
    expect(existsSync(room.cwd)).toBe(true);
    // Its first message doesn't rename it.
    await t.say(room, "The password field rejects emoji");
    expect(t.sent).toEqual(["The password field rejects emoji"]);
    expect(t.app.store.getRoom(room.id)?.name).toBe("Fix the login page");
    // The same name again: a folder of its own.
    expect((await t.call("POST", "/api/chats", { provider: "claude", name: "Fix the login page" })).cwd).toBe(join(t.dir, "fix-the-login-page-2"));
    // Up to 80 characters of name; the folder's is shorter.
    const long = await t.call("POST", "/api/chats", { provider: "codex", name: `Plan ${"x".repeat(100)}` });
    expect(long.name).toBe(`Plan ${"x".repeat(75)}`);
    expect(long.cwd).toBe(join(t.dir, `plan-${"x".repeat(27)}`));
    // A name with nothing a folder name can use keeps its words; its folder is dated.
    const words = await t.call("POST", "/api/chats", { provider: "codex", name: "Привет, мир" });
    expect(words.name).toBe("Привет, мир");
    expect(dated(t.dir, words.cwd)).toBe(true);
    // A folder that was picked stays as it is, name or not.
    expect((await t.call("POST", "/api/chats", { provider: "codex", name: "Elsewhere", cwd: t.dir })).cwd).toBe(t.dir);
  } finally {
    await t.done();
  }
});

test("a chat made without a name is named from its first message, once", async () => {
  const t = hub();
  try {
    const room = await t.call("POST", "/api/chats", { provider: "codex" });
    expect(room.name).toBe(NEW_CHAT);
    expect(dated(t.dir, room.cwd)).toBe(true);
    // Only spaces: no name either.
    expect((await t.call("POST", "/api/chats", { provider: "codex", name: "   " })).name).toBe(NEW_CHAT);
    const first = `  Why does   the build\nfail on ${"Linux ".repeat(20)}`;
    await t.say(room, first);
    expect(t.app.store.getRoom(room.id)?.name).toBe(first.replace(/\s+/g, " ").trim().slice(0, 60));
    expect(t.app.store.getRoom(room.id)?.name).toHaveLength(60);
    await t.say(room, "And on the Mac?");
    expect(t.app.store.getRoom(room.id)?.name).toBe(first.replace(/\s+/g, " ").trim().slice(0, 60));
  } finally {
    await t.done();
  }
});

test("renaming later still works, and a name that isn't text never breaks making a chat", async () => {
  const t = hub();
  try {
    const room = await t.call("POST", "/api/chats", { provider: "codex", name: "Release notes" });
    const renamed = await t.call("PATCH", `/api/rooms/${room.id}`, { name: "  Release notes 0.5  " });
    expect(renamed.name).toBe("Release notes 0.5");
    await t.say(room, "Draft them");
    expect(t.app.store.getRoom(room.id)?.name).toBe("Release notes 0.5");
    // Renamed from its first message's name to one of yours: kept too.
    const unnamed = await t.call("POST", "/api/chats", { provider: "claude" });
    await t.call("PATCH", `/api/rooms/${unnamed.id}`, { name: "Mine" });
    await t.say(unnamed, "Start here");
    expect(t.app.store.getRoom(unnamed.id)?.name).toBe("Mine");
    // A number, an object or null for a name: no name, as if none was given (it used to fail with a 500).
    for (const name of [42, { text: "x" }, null, ["a"]]) {
      const made = await t.call("POST", "/api/chats", { provider: "codex", name });
      expect(made.name).toBe(NEW_CHAT);
    }
  } finally {
    await t.done();
  }
});

// EXPECTED TO FAIL until the cut is fixed. A first message is cut to 60 characters with a plain `slice` (server.ts,
// POST /api/rooms/:id/messages), and `place`/`updateRoom` cut a name at 80 the same way. JavaScript counts those in
// UTF-16 units, so a cut can fall between the two halves of an emoji; the half that is left can't be written as UTF-8,
// and SQLite hands it back as "\uFFFD\uFFFD\uFFFD". The chat is then called "Why the build fails \u{1F680}\u{1F680}\uFFFD\uFFFD\uFFFD" in the list, the
// header, every notification and the Markdown export's file name. The hub already takes care of this where it quotes a
// message (search.ts snippetOf: "Never cut an emoji in two"), and so does the app (search.ts saidInError).
const WHOLE = (name: string) => [...name].every((c) => c.codePointAt(0)! < 0xd800 || (c.codePointAt(0)! > 0xdfff && c.codePointAt(0)! !== 0xfffd));

test("a message that names a chat is never cut through the middle of a character", async () => {
  const t = hub();
  try {
    const room = await t.call("POST", "/api/chats", { provider: "codex" });
    // One letter, then rockets: the 60th UTF-16 unit is the first half of the 30th one.
    await t.say(room, `a${"\u{1F680}".repeat(40)}`);
    expect(WHOLE(t.app.store.getRoom(room.id)!.name)).toBe(true);
    // A name typed in New chat is cut at 80 the same way, and so is one saved from Chat settings.
    expect(WHOLE((await t.call<Room>("POST", "/api/chats", { provider: "codex", name: `a${"\u{1F680}".repeat(50)}` })).name)).toBe(true);
    expect(WHOLE((await t.call<Room>("PATCH", `/api/rooms/${room.id}`, { name: `a${"\u{1F680}".repeat(50)}` })).name)).toBe(true);
  } finally {
    await t.done();
  }
});
