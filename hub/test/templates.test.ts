import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_STARTERS, type PromptTemplate, type ServerEvent, type StateSnapshot } from "@crosstalk/shared";
import { App } from "../src/app";
import { Store } from "../src/db";
import { startServer } from "../src/server";
import { STARTERS, ensureTemplates } from "../src/templates";

async function eventually(check: () => boolean, what: string) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10);
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

/** A hub with its server, a paired phone, and a way to call it as that phone. */
async function hub() {
  const dir = mkdtempSync(join(tmpdir(), "ct-templates-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  const pair = async (name: string) => (await app.auth.pair((await app.auth.createPairingCode()).code, name, "Web"))!;
  const phone = await pair("iPhone");
  const base = `http://127.0.0.1:${server.port}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: string, path: string, body?: unknown, token = phone.token): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  const done = async () => {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, dir, server, phone, pair, call, done };
}

const names = (list: PromptTemplate[]) => list.map((t) => t.name);

test("a new hub has the three starters, in the state and the list, for any agent and folder", async () => {
  const h = await hub();
  try {
    const list = (await h.call("GET", "/api/templates")).body as PromptTemplate[];
    expect(names(list)).toEqual(["Fix a bug", "Plan it first", "Review my changes"]);
    for (const [i, t] of list.entries()) {
      expect(t).toMatchObject({ agent: null, account: null, model: null, effort: null, folder: null, starter: STARTERS[i].key, text: STARTERS[i].text });
      expect(t.id).toMatch(/^tp_/);
    }
    // Every device gets them with the rest of the hub's state.
    const state = (await h.call("GET", "/api/state")).body as StateSnapshot;
    expect(state.templates).toEqual(list);
    // Each starter asks in plain words and has blanks, except the review (it works on the folder as it is).
    expect(list.map((t) => (t.text.match(/\{[^{}]+\}/g) ?? []).length)).toEqual([2, 1, 0]);
    // The app knows them all (to offer back the ones deleted).
    expect(STARTERS.map((s) => s.key)).toEqual([...TEMPLATE_STARTERS]);
  } finally {
    await h.done();
  }
});

test("adding, editing, renaming, moving and deleting reach every device, each answered with the list in order", async () => {
  const h = await hub();
  const mac = await h.pair("Mac");
  const heard: Record<"phone" | "mac", PromptTemplate[][]> = { phone: [], mac: [] };
  const listen = (who: "phone" | "mac", token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/api/ws?token=${token}&v=2`);
    ws.onmessage = (e) => {
      const ev = JSON.parse(String(e.data)) as ServerEvent;
      if (ev.t === "templates") heard[who].push(ev.templates);
    };
    return ws;
  };
  const sockets = [listen("phone", h.phone.token), listen("mac", mac.token)];
  /** Both devices heard this list since `since` (how many lists each had heard then). */
  const both = (since: { phone: number; mac: number }, list: PromptTemplate[], what: string) =>
    eventually(() => [heard.phone.slice(since.phone), heard.mac.slice(since.mac)].every((l) => l.some((x) => JSON.stringify(x) === JSON.stringify(list))), what);
  const mark = () => ({ phone: heard.phone.length, mac: heard.mac.length });
  try {
    await eventually(() => sockets.every((s) => s.readyState === WebSocket.OPEN), "the sockets");

    // Added: first in the list, with what was given (the account given as the main sign-in is kept as none).
    let since = mark();
    const added = await h.call("POST", "/api/templates", { name: "  Release   notes ", agent: "codex", account: "default", model: "gpt-5.5", effort: "high", folder: "~/Projects/site", text: "\r\nWrite the release notes for {version}.\r\nKeep them short.\n" });
    expect(added.status).toBe(200);
    const list = added.body as PromptTemplate[];
    expect(names(list)).toEqual(["Release notes", "Fix a bug", "Plan it first", "Review my changes"]);
    const mine = list[0];
    expect(mine).toMatchObject({ agent: "codex", account: null, model: "gpt-5.5", effort: "high", folder: "~/Projects/site", text: "Write the release notes for {version}.\nKeep them short." });
    expect(mine.starter).toBeUndefined();
    expect(mine.updatedAt).toBe(mine.createdAt);
    await both(since, list, "the new template on both devices");

    // A rename changes the name only.
    since = mark();
    const renamed = (await h.call("PATCH", `/api/templates/${mine.id}`, { name: "Notes for a release" })).body as PromptTemplate[];
    expect(renamed[0]).toMatchObject({ ...mine, name: "Notes for a release", updatedAt: renamed[0].updatedAt });
    expect(renamed[0].updatedAt).toBeGreaterThan(mine.updatedAt);
    await both(since, renamed, "the rename on both devices");

    // An edit: another agent drops the model and effort picked for the one before, unless it gives its own.
    let edited = (await h.call("PATCH", `/api/templates/${mine.id}`, { agent: "claude" })).body as PromptTemplate[];
    expect(edited[0]).toMatchObject({ agent: "claude", account: null, model: null, effort: null, folder: "~/Projects/site" });
    edited = (await h.call("PATCH", `/api/templates/${mine.id}`, { agent: "codex", model: "gpt-5.5", effort: "low", folder: null })).body as PromptTemplate[];
    expect(edited[0]).toMatchObject({ agent: "codex", model: "gpt-5.5", effort: "low", folder: null });
    // No agent: no account, model or effort either (they belong to an agent).
    edited = (await h.call("PATCH", `/api/templates/${mine.id}`, { agent: null, model: "gpt-5.5" })).body as PromptTemplate[];
    expect(edited[0]).toMatchObject({ agent: null, account: null, model: null, effort: null });
    // The same agent again keeps what it has.
    await h.call("PATCH", `/api/templates/${mine.id}`, { agent: "codex", model: "gpt-5.5" });
    expect(((await h.call("PATCH", `/api/templates/${mine.id}`, { agent: "codex", effort: "high" })).body as PromptTemplate[])[0]).toMatchObject({ model: "gpt-5.5", effort: "high" });

    // Moves: down to the end, then back to the top; a place past either end is that end.
    since = mark();
    let moved = (await h.call("POST", `/api/templates/${mine.id}/move`, { to: 3 })).body as PromptTemplate[];
    expect(names(moved)).toEqual(["Fix a bug", "Plan it first", "Review my changes", "Notes for a release"]);
    await both(since, moved, "the move on both devices");
    moved = (await h.call("POST", `/api/templates/${moved[1].id}/move`, { to: 0 })).body as PromptTemplate[];
    expect(names(moved)).toEqual(["Plan it first", "Fix a bug", "Review my changes", "Notes for a release"]);
    moved = (await h.call("POST", `/api/templates/${mine.id}/move`, { to: -5 })).body as PromptTemplate[];
    expect(names(moved)).toEqual(["Notes for a release", "Plan it first", "Fix a bug", "Review my changes"]);
    moved = (await h.call("POST", `/api/templates/${mine.id}/move`, { to: 99 })).body as PromptTemplate[];
    expect(names(moved)).toEqual(["Plan it first", "Fix a bug", "Review my changes", "Notes for a release"]);
    // Moving and renaming never change when it was made.
    expect(moved[3].createdAt).toBe(mine.createdAt);
    // The order is kept: the list and the state say the same.
    expect(names((await h.call("GET", "/api/templates")).body)).toEqual(names(moved));
    expect(names(((await h.call("GET", "/api/state")).body as StateSnapshot).templates!)).toEqual(names(moved));

    // Deleted: gone everywhere, the rest numbered again in their order.
    since = mark();
    const deleted = (await h.call("DELETE", `/api/templates/${mine.id}`)).body as PromptTemplate[];
    expect(names(deleted)).toEqual(["Plan it first", "Fix a bug", "Review my changes"]);
    await both(since, deleted, "the deletion on both devices");
    const again = await h.call("DELETE", `/api/templates/${mine.id}`);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: "That template is gone. It may have been deleted on another device.", code: "no_template" });
    // A new one goes above the rest, after a move as well.
    const top = (await h.call("POST", "/api/templates", { name: "Explain", text: "Explain {file} to me." })).body as PromptTemplate[];
    expect(names(top)).toEqual(["Explain", "Plan it first", "Fix a bug", "Review my changes"]);
  } finally {
    for (const s of sockets) s.close();
    await h.done();
  }
});

test("what a template can't keep is refused in plain words and changes nothing", async () => {
  const h = await hub();
  try {
    const before = (await h.call("GET", "/api/templates")).body as PromptTemplate[];
    const id = before[0].id;
    const bad: [string, string, unknown, RegExp][] = [
      ["POST", "/api/templates", { text: "Hi" }, /name/],
      ["POST", "/api/templates", { name: "   ", text: "Hi" }, /name/],
      ["POST", "/api/templates", { name: "Hi" }, /first message/],
      ["POST", "/api/templates", { name: "Hi", text: " \n " }, /first message/],
      ["POST", "/api/templates", { name: "Hi", text: "x".repeat(20_001) }, /20,000/],
      ["POST", "/api/templates", { name: 7, text: "Hi" }, /text/],
      ["POST", "/api/templates", { name: "Hi", text: "Hi", agent: "gemini" }, /Claude Code or Codex/],
      ["POST", "/api/templates", { name: "Hi", text: "Hi", agent: "codex", account: "nobody" }, /account/],
      ["POST", "/api/templates", { name: "Hi", text: "Hi", folder: "Projects/site" }, /full path/],
      // A chat would get a folder named "~" where the hub runs, not the home folder.
      ["POST", "/api/templates", { name: "Hi", text: "Hi", folder: "~" }, /full path/],
      ["POST", "/api/templates", { name: "Hi", text: "Hi", folder: `/${"a".repeat(1_001)}` }, /too long/],
      ["POST", "/api/templates", "not json", /name/],
      ["POST", "/api/templates", "[]", /name/],
      ["PATCH", `/api/templates/${id}`, { name: "" }, /name/],
      ["PATCH", `/api/templates/${id}`, { text: "" }, /first message/],
      ["PATCH", `/api/templates/${id}`, { agent: "codex", account: "nobody" }, /account/],
      ["POST", `/api/templates/${id}/move`, {}, /where/],
      ["POST", `/api/templates/${id}/move`, { to: "1" }, /where/],
      ["POST", `/api/templates/${id}/move`, { to: 1.5 }, /where/],
    ];
    for (const [method, path, body, words] of bad) {
      const res = await h.call(method, path, body);
      expect({ path, body, status: res.status }).toEqual({ path, body, status: 400 });
      expect(res.body.error).toMatch(words);
    }
    // None of them changed anything.
    expect((await h.call("GET", "/api/templates")).body).toEqual(before);

    // One that's gone says so in words, with a code, for each change: never the bare "not found" of a route a hub doesn't have.
    for (const [method, path, body] of [["PATCH", "/api/templates/tp_missing", { name: "x" }], ["DELETE", "/api/templates/tp_missing", undefined], ["POST", "/api/templates/tp_missing/move", { to: 0 }]] as const) {
      const res = await h.call(method, path, body);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("no_template");
      expect(res.body.error).not.toMatch(/^not found$/i);
    }
    // That one is what the app takes for a hub from before templates.
    expect(await h.call("POST", "/api/templates/tp_x/copy", {})).toEqual({ status: 404, body: { error: "not found" } });

    // A machine keeps up to 100: the 101st is refused with what to do.
    for (let i = before.length; i < 100; i++) expect((await h.call("POST", "/api/templates", { name: `T${i}`, text: "Hi" })).status).toBe(200);
    const full = await h.call("POST", "/api/templates", { name: "One more", text: "Hi" });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ code: "full" });
    expect(full.body.error).toMatch(/up to 100 templates\. Delete one/);
    expect((await h.call("GET", "/api/templates")).body).toHaveLength(100);
  } finally {
    await h.done();
  }
});

test("a template keeps an account that's on this machine, and stays usable when the account goes", async () => {
  const h = await hub();
  try {
    // An extra account, as Settings → AI services adds one (no sign-in needed to be kept).
    h.app.providers.hasAccount = (p, id) => id === "default" || (p === "codex" && id === "work");
    const list = (await h.call("POST", "/api/templates", { name: "Work", agent: "codex", account: "work", model: "gpt-5.5", text: "Hi" })).body as PromptTemplate[];
    expect(list[0]).toMatchObject({ agent: "codex", account: "work", model: "gpt-5.5" });
    // Removed since: renaming and moving still work, and the account is kept (the app falls back when it starts a chat).
    h.app.providers.hasAccount = (_p, id) => id === "default";
    const id = list[0].id;
    const renamed = (await h.call("PATCH", `/api/templates/${id}`, { name: "Work stuff" })).body as PromptTemplate[];
    expect(renamed[0]).toMatchObject({ name: "Work stuff", account: "work" });
    expect((await h.call("POST", `/api/templates/${id}/move`, { to: 2 })).status).toBe(200);
    // Saved with everything it has, as an editor (or an older app) sends it: the account it already had isn't picked again.
    const saved = await h.call("PATCH", `/api/templates/${id}`, { name: "Work stuff", agent: "codex", account: "work", model: "gpt-5.5", effort: "high", folder: null, text: "Hi again" });
    expect(saved.status).toBe(200);
    expect((saved.body as PromptTemplate[]).find((t) => t.id === id)).toMatchObject({ agent: "codex", account: "work", model: "gpt-5.5", effort: "high", text: "Hi again" });
    // Picking one that isn't here is refused, that one too once it's been left: nothing changes.
    for (const body of [{ account: "gone" }, { agent: "claude", account: "work" }]) {
      const res = await h.call("PATCH", `/api/templates/${id}`, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(res.body.error).toBe("That account isn't on this machine. Pick another one.");
    }
    expect((await h.call("PATCH", `/api/templates/${id}`, { account: null })).body.find((t: PromptTemplate) => t.id === id)).toMatchObject({ account: null });
    expect((await h.call("PATCH", `/api/templates/${id}`, { account: "work" })).status).toBe(400);
    expect(((await h.call("GET", "/api/templates")).body as PromptTemplate[]).find((t) => t.id === id)).toMatchObject({ agent: "codex", account: null, model: "gpt-5.5", text: "Hi again" });
  } finally {
    await h.done();
  }
});

test("deleted starters stay deleted until they're asked back, at the end, without doubles", async () => {
  const h = await hub();
  try {
    const start = (await h.call("GET", "/api/templates")).body as PromptTemplate[];
    await h.call("DELETE", `/api/templates/${start[0].id}`);
    await h.call("DELETE", `/api/templates/${start[2].id}`);
    // An edited starter is still that starter.
    await h.call("PATCH", `/api/templates/${start[1].id}`, { name: "Plan first", text: "Plan {this}." });
    await h.call("POST", "/api/templates", { name: "Mine", text: "Hi" });
    expect(names((await h.call("GET", "/api/templates")).body)).toEqual(["Mine", "Plan first"]);
    const back = (await h.call("POST", "/api/templates/starters")).body as PromptTemplate[];
    expect(names(back)).toEqual(["Mine", "Plan first", "Fix a bug", "Review my changes"]);
    expect(back.map((t) => t.starter ?? null)).toEqual([null, "plan", "bug", "review"]);
    // Asked again: nothing to add, nothing changes.
    expect((await h.call("POST", "/api/templates/starters")).body).toEqual(back);
  } finally {
    await h.done();
  }
});

test("another machine's sign-in can't read or change templates", async () => {
  const h = await hub();
  try {
    const peer = (await h.app.auth.pair((await h.app.auth.createPairingCode(60_000, { scope: "peer" })).code, "Linux box", "Crosstalk hub"))!;
    for (const [method, path, body] of [["GET", "/api/templates", undefined], ["POST", "/api/templates", { name: "x", text: "y" }], ["POST", "/api/templates/starters", undefined]] as const) {
      const res = await h.call(method, path, body, peer.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("peer_scope");
    }
    expect((await h.call("GET", "/api/templates")).body).toHaveLength(3);
  } finally {
    await h.done();
  }
});

test("a database from before templates gets the table and the starters once, and nothing else changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-templates-migrate-"));
  const path = join(dir, "crosstalk.db");
  const kv = (s: Store) => ({ get: (k: string) => s.kvGet(k), set: (k: string, v: string) => s.kvSet(k, v) });
  try {
    // A database from before: no templates table, and a room in it.
    const old = new Store(path);
    old.db.query("INSERT INTO rooms (id, name, cwd, mode, created_at, updated_at) VALUES ('r_old', 'Old chat', '/tmp', 'direct', 1000, 5000)").run();
    expect(old.db.query("SELECT name FROM sqlite_master WHERE name = 'templates'").get()).toBeNull();
    old.close();

    const store = new Store(path);
    ensureTemplates(store.db, kv(store));
    const rows = () => store.db.query("SELECT name, position, starter FROM templates ORDER BY position").all();
    expect(rows()).toEqual(STARTERS.map((s, i) => ({ name: s.name, position: i, starter: s.key })));
    // Again (every start): nothing added.
    ensureTemplates(store.db, kv(store));
    expect(rows()).toHaveLength(3);
    // Deleted, they aren't added back by the next start.
    store.db.exec("DELETE FROM templates WHERE starter = 'bug'");
    store.close();
    const again = new Store(path);
    ensureTemplates(again.db, kv(again));
    expect(again.db.query("SELECT starter FROM templates ORDER BY position").all()).toEqual([{ starter: "plan" }, { starter: "review" }]);
    expect(again.getRoom("r_old")).toMatchObject({ name: "Old chat", updatedAt: 5000 });
    again.close();
    const db = new Database(path);
    expect(db.query("SELECT COUNT(*) AS n FROM rooms").get()).toEqual({ n: 1 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
