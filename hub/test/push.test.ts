import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROSSTALK_HOME = mkdtempSync(join(tmpdir(), "ct-push-"));
const { Store } = await import("../src/db");
const { Push } = await import("../src/push");

test("VAPID JWT verifies against the advertised public key, and payload-less pushes carry the note via /latest", async () => {
  const store = new Store(":memory:");
  const push = new Push(store);
  await push.init();
  const pub = push.publicKey();
  const raw = Buffer.from(pub, "base64url");
  expect(raw.length).toBe(65);
  expect(raw[0]).toBe(4); // uncompressed P-256 point

  // Fake push service capturing the request.
  let seen: { auth: string | null; ttl: string | null; body: string } | null = null;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = { auth: req.headers.get("authorization"), ttl: req.headers.get("ttl"), body: await req.text() };
      return new Response(null, { status: 201 });
    },
  });
  const port = srv.port;
  const endpoint = `http://127.0.0.1:${port}/push/abc`;
  store.insertDevice({ id: "d1", name: "Phone", platform: "Web", createdAt: Date.now(), lastSeenAt: Date.now() }, "phone-token-hash");
  // subscribe() only accepts https endpoints; insert the local one directly for the test.
  store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, "d1", Date.now());
  await push.send({ title: "@codex needs approval", body: "npm test", url: "./#/room/r1", tag: "ap1" });
  srv.stop(true);

  expect(seen).not.toBeNull();
  expect(seen!.body).toBe("");
  expect(seen!.ttl).toBe("86400");
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(seen!.auth ?? "");
  expect(m).not.toBeNull();
  expect(m![2]).toBe(pub);
  const [h, b, s] = m![1].split(".");
  const claims = JSON.parse(Buffer.from(b, "base64url").toString());
  expect(claims.aud).toBe(`http://127.0.0.1:${port}`);
  // No https address for the hub: the placeholder contact (Apple needs a real one, see the next test).
  expect(claims.sub).toBe("mailto:hub@crosstalk.invalid");
  const key = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${b}`));
  expect(ok).toBe(true);
  expect(push.latest(endpoint)).toMatchObject({ title: "@codex needs approval", tag: "ap1" });

  // Visible devices are skipped when asked.
  seen = null;
  push.setVisible("d1", 1);
  await push.send({ title: "x", body: "y", url: "./", tag: "t" }, { skipVisible: true });
  expect(seen).toBeNull();
  store.close();
});

test("the hub's https address is the contact in its push signature (Apple refuses one it can't reach)", async () => {
  const store = new Store(":memory:");
  const push = new Push(store, () => "https://mac-mini.tail1234.ts.net/");
  await push.init();
  let auth = "";
  const srv = Bun.serve({ port: 0, fetch: (req) => ((auth = req.headers.get("authorization") ?? ""), new Response(null, { status: 201 })) });
  const endpoint = `http://127.0.0.1:${srv.port}/push/abc`;
  store.insertDevice({ id: "d1", name: "Phone", platform: "Web", createdAt: Date.now(), lastSeenAt: Date.now() }, "phone-token-hash");
  store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, "d1", Date.now());
  const tally = await push.send({ title: "Done", body: "x", url: "./", tag: "t" });
  srv.stop(true);
  // It went out and reached the stand-in. (Once, under a loaded full run, it returned without trying;
  // this names which step said no instead of failing on an empty header below.)
  expect(tally).toEqual({ sent: 1, failed: 0 });
  expect(auth).toMatch(/^vapid t=/);
  const token = /^vapid t=([^,]+),/.exec(auth)![1];
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  expect(claims.sub).toBe("https://mac-mini.tail1234.ts.net");
  expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(24 * 3600);
  store.close();
});

test("revoked devices lose saved notification text and receive no further pushes", async () => {
  const store = new Store(":memory:");
  const push = new Push(store);
  await push.init();
  let deliveries = 0;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { deliveries++; return new Response(null, { status: 201 }); } });
  const endpoint = `http://127.0.0.1:${srv.port}/push/revoked`;
  const note = { title: "Private reply", body: "Done", url: "./", tag: "reply" };
  store.insertDevice({ id: "d1", name: "Phone", platform: "Web", createdAt: Date.now(), lastSeenAt: Date.now() }, "phone-token-hash");
  store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, "d1", Date.now());
  try {
    await push.send(note);
    expect(deliveries).toBe(1);
    expect(push.latest(endpoint)).toEqual(note);
    // Also covers subscriptions left in an existing database by an older hub.
    store.revokeDevice("d1");
    expect(push.hasSubscription("d1")).toBe(false);
    expect(push.latest(endpoint)).toBeNull();
    expect(() => push.subscribe("d1", "https://example.invalid/push")).toThrow("signed out");
    await push.send(note);
    expect(deliveries).toBe(1);
  } finally { srv.stop(true); store.close(); }
});

test("two notifications sent close together each show with their own text and tag; an approval isn't replaced by a later 'finished'", async () => {
  const { pushTopic } = await import("../src/push");
  const store = new Store(":memory:");
  const push = new Push(store);
  await push.init();
  const topics: string[] = [];
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { topics.push(req.headers.get("topic") ?? ""); return new Response(null, { status: 201 }); } });
  const endpoint = `http://127.0.0.1:${srv.port}/push/two`;
  store.insertDevice({ id: "d1", name: "Phone", platform: "Web", createdAt: Date.now(), lastSeenAt: Date.now() }, "phone-token-hash");
  store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, "d1", Date.now());
  try {
    const approval = { title: "@claude needs approval", body: "npm publish · Release", url: "./#/room/r1", tag: "ap_x1" };
    const finished = { title: "Claude Code finished · Release", body: "Published 2.3.11.", url: "./#/room/r1", tag: "done-r1" };
    // Both sent before the phone's service worker asks for either.
    await Promise.all([push.send(approval), push.send(finished)]);
    expect(topics.length).toBe(2);
    // Each push has its own topic, so a push service holding them for an offline phone keeps both.
    expect(new Set(topics).size).toBe(2);
    expect(topics).toContain(pushTopic("ap_x1"));
    expect(pushTopic("done-r1")).toBe(pushTopic("done-r1")); // a newer "finished" for the chat replaces only the older one
    expect(pushTopic("ap_x1").length).toBeLessThanOrEqual(32);
    // The first push's service worker takes both, each as it was sent: nothing shows the second one's text twice.
    expect(push.take(endpoint)).toEqual({ notes: [approval, finished], latest: finished });
    // The second push finds them taken: it shows the newest again (same tag, so it only replaces itself).
    expect(push.take(endpoint)).toEqual({ notes: [], latest: finished });
    // Older service workers still get the latest one.
    expect(push.latest(endpoint)).toEqual(finished);
    // A device that's signed out gets nothing, and its waiting notifications go.
    await push.send(approval);
    store.revokeDevice("d1");
    expect(push.take(endpoint)).toEqual({ notes: [], latest: null });
  } finally {
    srv.stop(true);
    store.close();
  }
});

test("the service worker takes its notifications from the hub without a sign-in, by its subscription only", async () => {
  const { App } = await import("../src/app");
  const { startServer } = await import("../src/server");
  const dir = mkdtempSync(join(tmpdir(), "ct-push-notes-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
  await app.push.init();
  const server = startServer(app);
  const push = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 201 }) });
  try {
    const { device } = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "iPhone"))!;
    const endpoint = `http://127.0.0.1:${push.port}/push/sw`;
    app.store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, device.id, Date.now());
    await app.push.send({ title: "@codex has a question", body: "Which port?", url: "./#/room/r2", tag: "ap_q" });
    await app.push.send({ title: "@codex hit an error", body: "Exited", url: "./#/room/r2", tag: "err-t1" });
    const take = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/api/push/notes`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ notes: { tag: string }[]; latest: unknown }>);
    expect((await take({ endpoint })).notes.map((n) => n.tag)).toEqual(["ap_q", "err-t1"]);
    expect(await take({ endpoint: "https://push.example/unknown" })).toEqual({ notes: [], latest: null });
  } finally {
    push.stop(true);
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(app.computers.dir, { recursive: true, force: true });
  }
});

test("an answered approval's notification isn't shown later, and an older service worker's /latest takes what waited", async () => {
  const store = new Store(":memory:");
  const push = new Push(store);
  await push.init();
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 201 }) });
  const endpoint = `http://127.0.0.1:${srv.port}/push/later`;
  store.insertDevice({ id: "d1", name: "Phone", platform: "Web", createdAt: Date.now(), lastSeenAt: Date.now() }, "phone-token-hash");
  store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, "d1", Date.now());
  try {
    const approval = { title: "@claude needs approval", body: "npm publish", url: "./#/room/r1", tag: "ap_answered" };
    const error = { title: "@claude hit an error", body: "Exited", url: "./#/room/r1", tag: "err-t9" };
    await push.send(approval);
    await push.send(error);
    push.drop("ap_answered"); // answered on the computer before the phone came online
    expect(push.take(endpoint).notes).toEqual([error]);
    // An older service worker only asks for the latest: what waited counts as shown, so an update can't replay it.
    await push.send(approval);
    expect(push.takeLatest(endpoint)).toEqual(approval);
    expect(push.take(endpoint).notes).toEqual([]);
  } finally {
    srv.stop(true);
    store.close();
  }
});

test("a push for an approval answered meanwhile says it's answered, never shows the request again", async () => {
  const store = new Store(":memory:");
  const push = new Push(store);
  await push.init();
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 201 }) });
  const endpoint = `http://127.0.0.1:${srv.port}/push/answered`;
  store.insertDevice({ id: "d1", name: "Phone", platform: "Web", createdAt: Date.now(), lastSeenAt: Date.now() }, "phone-token-hash");
  store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, "d1", Date.now());
  try {
    const approval = { title: "@claude needs approval", body: "npm publish · Release", url: "./#/room/r1", tag: "ap_late" };
    await push.send(approval); // the phone is offline: the push waits
    push.drop("ap_late", "Already answered"); // answered on the computer
    // The push arrives: nothing waits, so it shows the latest, which now says it was answered (same tag and chat).
    expect(push.take(endpoint)).toEqual({ notes: [], latest: { ...approval, title: "Already answered" } });
    expect(push.takeLatest(endpoint)?.title).toBe("Already answered");
    // A newer notification is left as it is.
    const error = { title: "@claude hit an error", body: "Exited", url: "./#/room/r1", tag: "err-t2" };
    await push.send(error);
    push.drop("ap_late");
    expect(push.latest(endpoint)).toEqual(error);
  } finally {
    srv.stop(true);
    store.close();
  }
});

/** A hub whose notifications are caught here instead of being pushed. */
async function notifyingHub() {
  const { App } = await import("../src/app");
  const dir = mkdtempSync(join(tmpdir(), "ct-push-words-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
  await app.start();
  const sent: import("../src/push").PushNote[] = [];
  app.push.send = async (note) => (sent.push(note), { sent: 1, failed: 0 });
  const close = async () => {
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(app.computers.dir, { recursive: true, force: true });
  };
  return { app, sent, close };
}

const approval = (roomId: string, memberId: string, extra: Record<string, unknown>) => ({
  id: `ap_${Math.random().toString(36).slice(2, 8)}`, roomId, memberId, turnId: null, kind: "command", title: "npm test", detail: "", status: "pending", decision: null, decidedBy: null, createdAt: Date.now(), decidedAt: null, ...extra,
}) as import("@crosstalk/shared").Approval;
const turn = (roomId: string, memberId: string, extra: Record<string, unknown>) => ({
  id: `t_${Math.random().toString(36).slice(2, 8)}`, roomId, memberId, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: "c1", status: "running", error: null, usage: null, createdAt: Date.now(), startedAt: Date.now(), endedAt: null, ...extra,
}) as import("@crosstalk/shared").Turn;

test("an approval's notification leads with the chat name and says what's asked", async () => {
  const h = await notifyingHub();
  try {
    const room = h.app.chats.create({ provider: "codex", name: "Fix login" });
    const member = h.app.chats.member(room.id)!;
    h.app.bus.emit({ t: "approval", approval: approval(room.id, member.id, { title: "npm test" }) });
    // The chat is the title, so a lock screen cutting the end off never hides it; the text says who asks for what.
    expect(h.sent.at(-1)).toMatchObject({ title: "Fix login", body: "Codex needs your OK: npm test", url: `./#/room/${room.id}` });
    // In an older group room: the agent's handle.
    const group = h.app.createRoom({ name: "Team room", mode: "direct" });
    const claude = h.app.addMember(group.id, { provider: "claude", handle: "reviewer" });
    h.app.bus.emit({ t: "approval", approval: approval(group.id, claude.id, { title: "Edit app.ts" }) });
    expect(h.sent.at(-1)).toMatchObject({ title: "Team room", body: "@reviewer needs your OK: Edit app.ts" });
  } finally {
    await h.close();
  }
});

test("a question and an error say so, and a reply that finished says which agent", async () => {
  const { setSystemTime } = await import("bun:test");
  const h = await notifyingHub();
  try {
    const room = h.app.chats.create({ provider: "claude", name: "Release notes" });
    const member = h.app.chats.member(room.id)!;
    h.app.bus.emit({ t: "approval", approval: approval(room.id, member.id, { kind: "question", title: "Question", questions: [{ id: "q1", question: "Which port?", options: [], multiSelect: false }] }) });
    expect(h.sent.at(-1)).toMatchObject({ title: "Release notes", body: "Claude Code has a question: Which port?" });
    h.app.bus.emit({ t: "turn", turn: turn(room.id, member.id, { status: "error", error: "Exited with code 1" }) });
    expect(h.sent.at(-1)).toMatchObject({ title: "Release notes", body: "Claude Code stopped with an error: Exited with code 1" });
    h.app.bus.emit({ t: "turn", turn: turn(room.id, member.id, { status: "error", error: null }) });
    expect(h.sent.at(-1)).toMatchObject({ body: "Claude Code stopped with an error." });
    // A long reply (over 30 s) that answered you.
    const running = turn(room.id, member.id, {});
    h.app.bus.emit({ t: "turn", turn: running });
    h.app.engine.systemMessage(room.id, "Published   2.3.11.");
    setSystemTime(new Date(Date.now() + 31_000));
    h.app.bus.emit({ t: "turn", turn: { ...running, status: "done", endedAt: Date.now() } });
    await new Promise((r) => setTimeout(r, 900));
    expect(h.sent.at(-1)).toMatchObject({ title: "Release notes", body: "Claude Code finished: Published 2.3.11.", tag: `done-${room.id}` });
  } finally {
    setSystemTime();
    await h.close();
  }
});

test("a card is notified once, however often it changes while it waits; questions asked together come with one notification", async () => {
  const h = await notifyingHub();
  try {
    const room = h.app.chats.create({ provider: "codex", name: "Release" });
    const member = h.app.chats.member(room.id)!;
    // A question whose countdown starts (a device shows it) and stops (you start answering): still one notification.
    const asked = approval(room.id, member.id, { kind: "question", title: "Ship it?", questions: [{ id: "ship", header: "", question: "Ship it?", options: [], multiSelect: false, allowOther: true }], autoResolveMs: 120_000 });
    h.app.bus.emit({ t: "approval", approval: asked });
    h.app.bus.emit({ t: "approval", approval: { ...asked, autoResolveAt: Date.now() + 120_000 } });
    h.app.bus.emit({ t: "approval", approval: { ...asked, autoResolveMs: null, autoResolveAt: null } });
    expect(h.sent.filter((n) => n.tag === asked.id)).toHaveLength(1);
    // Two questions Codex asked without waiting, a card each, in one go: one notification, the first one's.
    const later = (id: string, question: string) => approval(room.id, member.id, { id, turnId: "t1", kind: "question", title: question, delivery: "async", questions: [{ id: `["request_user_input_async","call_1",${id === "ap_one" ? 0 : 1}]`, header: "", question, options: [], multiSelect: false, allowOther: true }] });
    for (const a of [later("ap_one", "Ship it?"), later("ap_two", "Tell the team?")]) {
      h.app.store.insertApproval(a);
      h.app.bus.emit({ t: "approval", approval: a });
    }
    expect(h.sent.filter((n) => n.tag === "ap_one" || n.tag === "ap_two").map((n) => [n.tag, n.body])).toEqual([["ap_one", "Codex has a question: Ship it?"]]);
  } finally {
    await h.close();
  }
});

test("an answered approval's waiting push keeps the chat name and says it's answered", async () => {
  const store = new Store(":memory:");
  const push = new Push(store);
  await push.init();
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 201 }) });
  const endpoint = `http://127.0.0.1:${srv.port}/push/words`;
  store.insertDevice({ id: "d1", name: "Phone", platform: "Web", createdAt: Date.now(), lastSeenAt: Date.now() }, "phone-token-hash");
  store.db.query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?)").run(endpoint, "d1", Date.now());
  try {
    const asked = { title: "Fix login", body: "Codex needs your OK: npm publish", url: "./#/room/r1", tag: "ap_words" };
    await push.send(asked);
    push.drop("ap_words", "Already answered");
    expect(push.take(endpoint)).toEqual({ notes: [], latest: { ...asked, body: "Already answered" } });
  } finally {
    srv.stop(true);
    store.close();
  }
});

test("a relayed notification puts the machine in the title, as it's called now", async () => {
  const { Machines } = await import("../src/machines");
  const { sha256 } = await import("../src/util/ids");
  const kv = new Map<string, string>();
  const shown: import("../src/push").PushNote[] = [];
  const machines = new Machines({
    kvGet: (k) => kv.get(k) ?? null,
    kvSet: (k, v) => void kv.set(k, v),
    self: () => ({ id: "h_mac", name: "Mac mini", url: null }),
    notify: async (note) => void shown.push(note),
    agentsOn: () => false,
    pairingCode: async () => ({ code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 }),
    getDevice: () => null,
    revokeDevice: () => {},
    setDeviceHub: () => {},
    devicesOfHub: () => [],
  });
  kv.set("machines.relays", JSON.stringify([{ id: "rl1", name: "linux-box", hash: await sha256("relay-key"), createdAt: Date.now() }]));
  await machines.relay("relay-key", { title: "Fix login", body: "Codex needs your OK: npm test", url: "./#/room/r1", tag: "ap1" });
  expect(shown.at(-1)).toEqual({ title: "Fix login · linux-box", body: "Codex needs your OK: npm test", url: "./#/room/r1", tag: "rl1-ap1" });
  // Renamed since it was linked: the name it has now.
  kv.set("machines.links", JSON.stringify([{ id: "h_linux", name: "Linux box", url: "https://linux-box.example", addedAt: 0, token: "t", deviceId: "d", scope: "full", relayId: "rl1" }]));
  await machines.relay("relay-key", { title: "Fix login", body: "Codex finished: Done.", url: "./#/room/r1", tag: "done-r1" });
  expect(shown.at(-1)).toMatchObject({ title: "Fix login · Linux box", body: "Codex finished: Done." });
});
