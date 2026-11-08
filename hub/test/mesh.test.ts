// Linking hubs both ways (machines.ts): typed-code links that become two-way, peer sign-ins and what they may do,
// introductions between three hubs, the peer route's checks, re-links, retries, unlinking (with the other hub off,
// from the other hub, and the cascade to a third), the installer's claim, and dropping refused notification forwards.
// Every hub here is a real App with an in-memory database, served on a random loopback port.
// Regression tests cover failed links, stale sign-ins and concurrent handshakes.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Device, MachineAgentLink, MachineInfo, MachineInvite, MachineInviteStatus, Member, Room } from "@crosstalk/shared";
import { App } from "../src/app";
import type { PushNote } from "../src/push";
import { resetFailureLimits, startServer } from "../src/server";
import { newId } from "../src/util/ids";

/** A link as machines.ts keeps it (kv "machines.links"), sign-ins included. */
interface RawLink extends MachineInfo {
  token: string;
  deviceId: string;
  scope: "full" | "peer";
  relayId: string | null;
  inboundDeviceId: string | null;
  agents: MachineAgentLink;
  error: string | null;
  introducedBy: string | null;
  retryAt: number | null;
  retries: number;
}

interface Intro {
  a: string;
  b: string;
  state: string;
  error: string | null;
  retryAt: number | null;
}

interface Res<T> {
  status: number;
  data: T;
}

const SLOW = 30_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(base: string, method: string, path: string, token?: string | null, body?: unknown): Promise<Res<T>> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, data: data as T };
}

const open: { close(): Promise<void> }[] = [];

/** A hub on a random loopback port, with a person's device ("phone") paired to it. */
async function hub(name: string, opts: { agents?: boolean; id?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-mesh-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  if (opts.id) app.store.kvSet("hubId", opts.id);
  // autoClean off: a test must never clear this Mac's real caches.
  app.setHubSettings({ machineName: name, agentsAcrossChats: !!opts.agents, storage: { autoClean: false, lowSpaceGb: 15 } });
  const sent: PushNote[] = [];
  const realSend = app.push.send.bind(app.push);
  app.push.send = async (note, o) => {
    sent.push(note);
    return realSend(note, o);
  };
  let server: ReturnType<typeof startServer> | null = null;
  const h = {
    app,
    name,
    id: app.hubId(),
    base: "",
    sent,
    phone: null as unknown as { token: string; device: Device },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api<T = any>(method: string, path: string, body?: unknown, token?: string | null): Promise<Res<T>> {
      return call<T>(h.base, method, path, token === undefined ? h.phone.token : token, body);
    },
    /** Serves the hub (again): on `port`, or a new random one; that address becomes its public address. */
    start(port = 0) {
      app.config.port = port;
      server = startServer(app);
      h.base = `http://127.0.0.1:${server.port}`;
      app.config.publicUrl = h.base;
    },
    stop() {
      server?.stop(true);
      server = null;
    },
    async close() {
      h.stop();
      await app.engine.shutdown();
      app.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  h.start();
  h.phone = (await app.auth.pair((await app.auth.createPairingCode()).code, `${name} phone`, "Web"))!;
  open.push(h);
  return h;
}
type Hub = Awaited<ReturnType<typeof hub>>;

beforeEach(() => resetFailureLimits());
afterEach(async () => {
  for (const h of open.splice(0)) await h.close().catch(() => {});
});

const rawLinks = (h: Hub): RawLink[] => JSON.parse(h.app.store.kvGet("machines.links") ?? "[]");
const linkOn = (h: Hub, other: { id: string }): RawLink | null => rawLinks(h).find((l) => l.id === other.id) ?? null;
const forwards = (h: Hub): { url: string; token: string; name: string }[] => JSON.parse(h.app.store.kvGet("machines.forwards") ?? "[]");
const relays = (h: Hub): { id: string }[] => JSON.parse(h.app.store.kvGet("machines.relays") ?? "[]");
const intros = (h: Hub): Intro[] => JSON.parse(h.app.store.kvGet("machines.intros") ?? "[]");
const names = (h: Hub) => h.app.store.listDevices().map((d) => d.name);

async function until(ok: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
/** For checks that something did NOT happen in the background. */
const settle = () => Bun.sleep(150);

/** A person links `to` from `from` with a code shown on `to`. */
async function link(from: Hub, to: Hub): Promise<MachineInfo> {
  const { code } = await to.app.auth.createPairingCode();
  const r = await from.api<MachineInfo>("POST", "/api/machines/link", { url: to.base, code });
  expect(r.status).toBe(200);
  return r.data;
}

async function twoWay(x: Hub, y: Hub) {
  await until(() => linkOn(x, y)?.agents === "two-way" && linkOn(y, x)?.agents === "two-way", `${x.name} and ${y.name} to link two-way`);
}

/** A one-agent chat (mock agent) on a hub. */
function addChat(app: App, name: string): { room: Room; member: Member } {
  const now = Date.now();
  const room: Room = { id: newId("r"), name, cwd: app.config.workspaceRoot, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  app.store.insertRoom(room);
  app.store.insertChat({ roomId: room.id, provider: "mock", origin: "web", localId: null });
  const member: Member = { id: newId("mb"), roomId: room.id, handle: "mock", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: { reply: "ok", delayMs: 5 }, createdAt: now, position: 0 };
  app.store.insertMember(member);
  return { room, member };
}

/** A loopback port nothing listens on. */
function closedPort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** Records every outgoing fetch (hub-to-hub calls go through the global fetch); `onCall` runs once each has started. */
function spyFetch(onCall?: (url: string) => void) {
  const real = globalThis.fetch;
  const calls: { method: string; url: string; done: Promise<unknown> }[] = [];
  const spy = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const p = real(input, init);
    calls.push({ method: init?.method ?? "GET", url, done: p.then(() => null, () => null) });
    onCall?.(url);
    return p;
  };
  globalThis.fetch = Object.assign(spy, { preconnect: real.preconnect }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** A hub from before two-way links: it pairs, and answers 404 to everything else. */
function olderHub(id: string, name: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/api/pair" && req.method === "POST"
        ? Response.json({ token: "older-hub-token-0123456789", device: { id: "d_olderhubdev1" }, hub: { id, name, version: "0.0.9" } })
        : Response.json({ error: "not found" }, { status: 404 }),
  });
}

/** Lets every pending retry come due now (instead of waiting minutes). */
function expireRetries(h: Hub) {
  h.app.store.kvSet("machines.links", JSON.stringify(rawLinks(h).map((l) => (l.retryAt ? { ...l, retryAt: 1 } : l))));
  h.app.store.kvSet("machines.intros", JSON.stringify(intros(h).map((i) => (i.retryAt ? { ...i, retryAt: 1 } : i))));
}

// ------------------------------------------------------------------------------------------------ linking

test(
  "a typed-code link with agents on becomes two-way: each hub gets a sign-in on the other, bound to it",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    const linked = await link(a, b);
    expect(linked).toMatchObject({ id: b.id, name: "Linux box", url: b.base, scope: "full" });
    await twoWay(a, b);

    // Settings → Machines on each side.
    expect((await a.api<MachineInfo[]>("GET", "/api/machines")).data).toEqual([
      expect.objectContaining({ id: b.id, name: "Linux box", url: b.base, scope: "full", agents: "two-way", error: null, introducedBy: null }),
    ]);
    expect((await b.api<MachineInfo[]>("GET", "/api/machines")).data).toEqual([
      expect.objectContaining({ id: a.id, name: "Mac mini", url: a.base, scope: "peer", agents: "two-way", error: null, introducedBy: null }),
    ]);

    const ab = linkOn(a, b)!;
    const ba = linkOn(b, a)!;
    // B's sign-in on A came from a peer code tagged for B: peer scope, tied to B, and it's what A's link is bound to.
    const bOnA = a.app.store.getDevice(ab.inboundDeviceId!)!;
    expect(bOnA).toMatchObject({ id: ba.deviceId, name: "Linux box (hub)", platform: "Crosstalk hub", scope: "peer", hubId: b.id });
    expect(a.app.store.devicesOfHub(b.id).map((d) => d.id)).toEqual([bOnA.id]);
    // A's sign-in on B is the full one from the typed code (never peer because of its platform), now bound to A.
    const aOnB = b.app.store.getDevice(ba.inboundDeviceId!)!;
    expect(aOnB).toMatchObject({ id: ab.deviceId, name: "Mac mini (hub)", platform: "Crosstalk hub", scope: "full", hubId: a.id });

    // Notifications: only A ← B (the link a person made); the link-back adds none.
    expect(ab.relayId).toBeString();
    expect(ba.relayId).toBeNull();
    expect(relays(a).map((r) => r.id)).toEqual([ab.relayId!]);
    expect(relays(b)).toEqual([]);
    expect(forwards(b).map((f) => f.url)).toEqual([`${a.base}/api/push/relay`]);
    expect(forwards(a)).toEqual([]);

    // The Devices list says which hub a sign-in belongs to.
    const devices = (await a.api<Device[]>("GET", "/api/devices")).data;
    expect(devices.find((d) => d.id === bOnA.id)).toMatchObject({ scope: "peer", hubId: b.id });
    expect(devices.find((d) => d.id === a.phone.device.id)).toMatchObject({ scope: "full", hubId: null });

    // Each sign-in works on the other hub's peer endpoint, which says what it is.
    expect((await call(a.base, "GET", "/api/machines/peer", ba.token)).data).toMatchObject({
      hub: { id: a.id, name: "Mac mini", url: a.base },
      you: { deviceId: bOnA.id, scope: "peer" },
      agentsAcrossChats: true,
    });
    expect((await call(b.base, "GET", "/api/machines/peer", ab.token)).data).toMatchObject({ hub: { id: b.id, name: "Linux box" }, you: { deviceId: aOnB.id, scope: "full" }, agentsAcrossChats: false });
  },
  SLOW,
);

test(
  "peer codes: a full sign-in gets a one-time two-minute code tagged for one hub, which pairs a peer sign-in",
  async () => {
    const b = await hub("Linux box");
    const before = Date.now();
    const r = await b.api<{ code: string; expiresAt: number }>("POST", "/api/machines/peer-code", { forHub: "h_macmini0001" });
    expect(r.status).toBe(200);
    expect(r.data.expiresAt - before).toBeGreaterThanOrEqual(2 * 60_000);
    expect(r.data.expiresAt - Date.now()).toBeLessThanOrEqual(2 * 60_000);
    expect((await b.api("POST", "/api/machines/peer-code", { forHub: "not a hub" })).status).toBe(400);
    // The sign-in it makes is peer scope and tied to that hub; /api/pair says so.
    const paired = await call<{ device: Device; hub: { id: string } }>(b.base, "POST", "/api/pair", null, { code: r.data.code, name: "Mac mini (hub)", platform: "Crosstalk hub" });
    expect(paired.status).toBe(200);
    expect(paired.data.device).toMatchObject({ scope: "peer", hubId: "h_macmini0001" });
    expect(paired.data.hub.id).toBe(b.id);
    expect((await call(b.base, "POST", "/api/pair", null, { code: r.data.code, name: "Again", platform: "Crosstalk hub" })).status).toBe(401);
    // A person's code makes a full sign-in, whatever platform the device claims.
    const full = await call<{ device: Device }>(b.base, "POST", "/api/pair", null, { code: (await b.app.auth.createPairingCode()).code, name: "Not a hub", platform: "Crosstalk hub" });
    expect(full.data.device).toMatchObject({ scope: "full", hubId: null });
  },
  SLOW,
);

test(
  "a linked hub's new name is picked up the next time this hub connects to it",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    b.app.setHubSettings({ machineName: "Build server" });
    expect((await a.api("POST", `/api/machines/${b.id}/connect`)).status).toBe(200);
    await until(() => linkOn(a, b)?.name === "Build server" && linkOn(a, b)?.agents === "two-way", "A to note B's new name");
    expect((await a.api<MachineInfo[]>("GET", "/api/machines")).data.map((m) => m.name)).toEqual(["Build server"]);
  },
  SLOW,
);

test(
  "with agents off a link stays one-way and Connect is refused; turning agents on completes it",
  async () => {
    const a = await hub("Mac mini");
    const b = await hub("Linux box");
    await link(a, b);
    await settle();
    expect(linkOn(a, b)).toMatchObject({ scope: "full", agents: "one-way", inboundDeviceId: null });
    expect(rawLinks(b)).toEqual([]);
    expect(a.app.store.devicesOfHub(b.id)).toEqual([]);
    expect(b.app.store.getDevice(linkOn(a, b)!.deviceId)).toMatchObject({ scope: "full", hubId: null });

    const tap = await a.api<{ error: string }>("POST", `/api/machines/${b.id}/connect`);
    expect(tap.status).toBe(409);
    expect(tap.data.error).toContain("Let agents reach your other chats");
    await settle();
    expect(linkOn(a, b)!.agents).toBe("one-way");
    expect(a.app.store.devicesOfHub(b.id)).toEqual([]);

    a.app.setHubSettings({ agentsAcrossChats: true });
    await twoWay(a, b);
    expect(a.app.store.devicesOfHub(b.id).map((d) => d.scope)).toEqual(["peer"]);
    expect(b.app.store.getDevice(linkOn(a, b)!.deviceId)).toMatchObject({ scope: "full", hubId: a.id });
  },
  SLOW,
);

test(
  "a peer sign-in reaches only what agents need",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    addChat(a.app, "Side project");
    await link(a, b);
    await twoWay(a, b);
    const peer = linkOn(b, a)!.token; // B's sign-in on A

    const refusals: [string, string, unknown?][] = [
      ["GET", "/api/state"],
      ["POST", "/api/pty", {}],
      ["PUT", "/api/settings/hub", { agentsAcrossChats: false }],
      ["POST", "/api/approvals/x", { decision: "approve" }],
      ["POST", "/api/pairing-codes", {}],
      ["POST", "/api/machines/peer-code", { forHub: b.id }],
      ["DELETE", `/api/devices/${a.phone.device.id}`],
      ["GET", "/api/machines"],
      ["POST", `/api/machines/${b.id}/connect`],
    ];
    for (const [method, path, body] of refusals) {
      const r = await call<{ code?: string }>(a.base, method, path, peer, body);
      expect({ method, path, status: r.status, code: r.data?.code }).toEqual({ method, path, status: 403, code: "peer_scope" });
    }
    // Live events (terminals included) are for people's devices only.
    expect((await fetch(`${a.base}/api/ws`, { headers: { authorization: `Bearer ${peer}` } })).status).toBe(403);
    // Introductions need a full sign-in, even with a well-formed request.
    const intro = await call<{ code: string }>(a.base, "POST", "/api/machines/peer", peer, {
      kind: "introduce",
      url: "https://macbook.tail1234.ts.net",
      code: "ABCD-EFGH",
      hub: { id: "h_thirdmachine", name: "MacBook" },
    });
    expect(intro.status).toBe(403);
    expect(intro.data.code).toBe("peer_scope");
    // Unlinking a machine is a person's act (a peer sign-in may only say ?peer=1).
    expect((await call(a.base, "DELETE", `/api/machines/${b.id}`, peer)).status).toBe(403);
    // None of it went through.
    expect(a.app.hubSettings().agentsAcrossChats).toBe(true);
    expect(a.app.store.getDevice(a.phone.device.id)).not.toBeNull();
    expect(linkOn(a, b)!.agents).toBe("two-way");

    // What it is for: B's agents find the chats here, while agents may reach other chats here.
    expect((await call(a.base, "GET", "/api/machines/peer", peer)).status).toBe(200);
    const chats = await call<{ hub: { id: string }; chats: { name: string }[] }>(a.base, "GET", "/api/machines/chats", peer);
    expect(chats.status).toBe(200);
    expect(chats.data.hub.id).toBe(a.id);
    expect(chats.data.chats.map((c) => c.name)).toEqual(["Side project"]);
    // A person's device isn't a linked machine.
    const own = await a.api<{ code: string }>("GET", "/api/machines/chats");
    expect([own.status, own.data.code]).toEqual([403, "not_linked"]);

    // The person turns it off here (Settings → Teamwork).
    expect((await a.api<{ agentsAcrossChats: boolean }>("PUT", "/api/settings/hub", { agentsAcrossChats: false })).data.agentsAcrossChats).toBe(false);
    const off = await call<{ code: string }>(a.base, "GET", "/api/machines/chats", peer);
    expect([off.status, off.data.code]).toEqual([403, "off"]);
  },
  SLOW,
);

test(
  "three hubs: A links B and C, then introduces them, and B and C link two-way with peer sign-ins",
  async () => {
    // Fixed ids, so the introduction's order is known: A asks B (the lower id) to pair with C.
    const a = await hub("Mac mini", { agents: true, id: "h_aaaaaaaaaaaa" });
    const b = await hub("Linux box", { id: "h_bbbbbbbbbbbb" });
    const c = await hub("MacBook", { id: "h_cccccccccccc" });
    await link(a, b);
    await twoWay(a, b);
    await link(a, c);
    await twoWay(a, c);
    await twoWay(b, c);
    await until(() => intros(a).length > 0, "A to record the introduction");
    expect(intros(a)).toEqual([expect.objectContaining({ a: b.id, b: c.id, state: "done", error: null })]);

    expect(linkOn(b, c)).toMatchObject({ url: c.base, scope: "peer", agents: "two-way", relayId: null, introducedBy: a.id });
    expect(linkOn(c, b)).toMatchObject({ url: b.base, scope: "peer", agents: "two-way", relayId: null });
    // Each holds one peer sign-in on the other, tied to it, and each link is bound to the other's sign-in.
    for (const [x, y] of [
      [b, c],
      [c, b],
    ] as const) {
      const signIns = x.app.store.devicesOfHub(y.id);
      expect(signIns.map((d) => ({ id: d.id, scope: d.scope, name: d.name }))).toEqual([{ id: linkOn(x, y)!.inboundDeviceId!, scope: "peer", name: `${y.name} (hub)` }]);
      expect(linkOn(y, x)!.deviceId).toBe(signIns[0].id);
    }
    // A, through its full sign-in on B, sees B connected with C.
    const there = await call<MachineInfo[]>(b.base, "GET", "/api/machines", linkOn(a, b)!.token);
    expect(there.data).toContainEqual(expect.objectContaining({ id: c.id, scope: "peer", agents: "two-way" }));
    // Only the hub a person linked them from adds them with one tap, and only it gets their notifications.
    expect((await b.api("POST", `/api/machines/${c.id}/pair-code`)).status).toBe(400);
    expect(forwards(b).map((f) => f.url)).toEqual([`${a.base}/api/push/relay`]);
    expect(forwards(c).map((f) => f.url)).toEqual([`${a.base}/api/push/relay`]);
  },
  SLOW,
);

test(
  "an introduction whose link-back fails is retried until both machines connect",
  async () => {
    const a = await hub("Mac mini", { agents: true, id: "h_aaaaaaaaaaaa" });
    const b = await hub("Linux box", { id: "h_bbbbbbbbbbbb" });
    const c = await hub("MacBook", { id: "h_cccccccccccc" });
    // B's own address doesn't answer for now (A reaches B at the address it was linked with).
    const realUrl = b.base;
    b.app.config.publicUrl = `http://127.0.0.1:${closedPort()}`;
    await link(a, b);
    await twoWay(a, b);
    await link(a, c);
    await twoWay(a, c);
    // A asks B to pair with C: B does, but C can't pair back with B.
    await until(() => intros(a).length > 0, "A to record the introduction");
    expect(linkOn(b, c)).toMatchObject({ scope: "peer", agents: "failed" });
    expect(linkOn(c, b)).toBeNull();
    // B holds only a peer sign-in on C, so it never retries (1.7); A, which holds full sign-ins on both, must.
    // Expected: the pair is "failed" with a retry time. Actual: "done" (peer() answers ok whatever connectLink did).
    expect(intros(a)).toEqual([expect.objectContaining({ a: b.id, b: c.id, state: "failed" })]);

    // Once B answers at its address, the retry timers connect them.
    b.app.config.publicUrl = realUrl;
    expireRetries(a);
    expireRetries(b);
    await a.app.machines.retryTick();
    await b.app.machines.retryTick();
    await twoWay(b, c);
  },
  SLOW,
);

// ------------------------------------------------------------------------------------------------ the peer route

test(
  "peer route: when another hub answers at the address, the pairing is refused and its sign-in there removed",
  async () => {
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    // B is asked to pair back with "h_notthisone00" at C's address, with a code C made: C answers instead.
    const { code } = await c.app.auth.createPairingCode();
    const r = await b.api<{ error: string }>("POST", "/api/machines/peer", { kind: "back", url: c.base, code, hub: { id: "h_notthisone00", name: "Fake" } });
    expect(r.status).toBe(403);
    expect(r.data.error).toContain("different machine");
    expect(rawLinks(b)).toEqual([]);
    // B signed straight out of C again.
    expect(names(c)).toEqual(["MacBook phone"]);
  },
  SLOW,
);

test(
  "a mismatched peer pairing signs itself out of the other hub",
  async () => {
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    // The codes hubs hand each other are peer codes: the sign-in B gets from one can't call DELETE /api/devices/:id.
    const { code } = await c.app.auth.createPairingCode(2 * 60_000, { scope: "peer", hubId: b.id });
    const r = await b.api("POST", "/api/machines/peer", { kind: "back", url: c.base, code, hub: { id: "h_notthisone00", name: "Fake" } });
    expect(r.status).toBe(403);
    expect(rawLinks(b)).toEqual([]);
    // Expected: only C's own phone. Actual: "Linux box (hub)" is still signed in on C, held by nobody.
    expect(names(c)).toEqual(["MacBook phone"]);
  },
  SLOW,
);

test(
  "peer route: a known hub at another address is refused unless its own bound sign-in reports the move",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const elsewhere = "https://mac-mini.tail1234.ts.net";
    // B's person (not A's sign-in) can't introduce A at another address, nor link it back there.
    const intro = await b.api<{ error: string }>("POST", "/api/machines/peer", { kind: "introduce", url: elsewhere, code: "ABCD-EFGH", hub: { id: a.id, name: "Mac mini" } });
    expect(intro.status).toBe(409);
    expect(intro.data.error).toContain("another address");
    expect((await b.api("POST", "/api/machines/peer", { kind: "back", url: elsewhere, code: "ABCD-EFGH", hub: { id: a.id, name: "Mac mini" } })).status).toBe(409);
    expect(linkOn(b, a)).toMatchObject({ url: a.base, agents: "two-way" });

    // A itself moves (another port, so another address) and reports it with its own sign-in on B: accepted.
    const before = a.base;
    a.stop();
    a.start();
    expect(a.base).not.toBe(before);
    expect((await a.api("POST", `/api/machines/${b.id}/connect`)).status).toBe(200);
    await until(() => linkOn(b, a)?.url === a.base && linkOn(a, b)?.agents === "two-way", "B to take A's new address");
    expect(linkOn(b, a)).toMatchObject({ url: a.base, agents: "two-way", inboundDeviceId: linkOn(a, b)!.deviceId });
    expect(a.app.store.getDevice(linkOn(a, b)!.inboundDeviceId!)).toMatchObject({ scope: "peer", hubId: b.id });
    expect((await call(a.base, "GET", "/api/machines/peer", linkOn(b, a)!.token)).status).toBe(200);
  },
  SLOW,
);

test(
  "moving a linked hub revokes its stale peer sign-ins",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const old = linkOn(a, b)!.inboundDeviceId!; // B's sign-in on A
    a.stop();
    a.start();
    await a.api("POST", `/api/machines/${b.id}/connect`);
    await until(() => linkOn(b, a)?.url === a.base && linkOn(a, b)?.agents === "two-way" && linkOn(a, b)?.inboundDeviceId !== old, "B to take A's new address");
    // B paired again at the new address and dropped the old token, then tried to delete the old sign-in with its new
    // (peer) one, which DELETE /api/devices/:id refuses. Expected: only the new sign-in is left for B on A.
    expect(a.app.store.devicesOfHub(b.id).map((d) => d.id)).toEqual([linkOn(a, b)!.inboundDeviceId!]);
    expect(a.app.store.getDevice(old)).toBeNull();
  },
  SLOW,
);

test(
  "peer route: https or loopback addresses only, and a redirect isn't followed",
  async () => {
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    for (const url of ["http://192.168.1.20:7420", "http://linux-box.example.com"]) {
      const r = await b.api<{ error: string }>("POST", "/api/machines/peer", { kind: "back", url, code: "ABCD-EFGH", hub: { id: "h_somemachine", name: "Some" } });
      expect(r.status).toBe(400);
      expect(r.data.error).toContain("https");
    }
    // A loopback address that redirects to C: B doesn't follow, so C's code never gets there.
    const redirect = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => Response.redirect(c.base + new URL(req.url).pathname, 307) });
    try {
      const { code } = await c.app.auth.createPairingCode(2 * 60_000, { scope: "peer", hubId: b.id });
      const r = await b.api<{ code: string }>("POST", "/api/machines/peer", { kind: "back", url: `http://127.0.0.1:${redirect.port}`, code, hub: { id: c.id, name: "MacBook" } });
      expect(r.status).toBe(502);
      expect(r.data.code).toBe("unreachable");
      expect(names(c)).toEqual(["MacBook phone"]);
      expect(rawLinks(b)).toEqual([]);
    } finally {
      redirect.stop(true);
    }
  },
  SLOW,
);

test(
  "peer route: a sign-in bound to one hub can't link back for another",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    await link(a, b);
    await twoWay(a, b);
    const { code } = await c.app.auth.createPairingCode(2 * 60_000, { scope: "peer", hubId: a.id });
    const back = { kind: "back", url: c.base, code, hub: { id: c.id, name: "MacBook" } };
    // B's peer sign-in on A, tied to B.
    const r = await call<{ code: string }>(a.base, "POST", "/api/machines/peer", linkOn(b, a)!.token, back);
    expect([r.status, r.data.code]).toEqual([403, "peer_scope"]);
    // A's full sign-in on B, bound to A since the link-back.
    const r2 = await call<{ code: string }>(b.base, "POST", "/api/machines/peer", linkOn(a, b)!.token, back);
    expect([r2.status, r2.data.code]).toEqual([403, "peer_scope"]);
    // C's code was never used.
    expect(linkOn(a, c)).toBeNull();
    expect(linkOn(b, c)).toBeNull();
    expect(names(c)).toEqual(["MacBook phone"]);
  },
  SLOW,
);

test(
  "a repeated link-back is idempotent: no new sign-ins on either hub",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const ab = linkOn(a, b)!;
    const ba = linkOn(b, a)!;
    const devA = a.app.store.listDevices().map((d) => d.id);
    const devB = b.app.store.listDevices().map((d) => d.id);

    // A's call timed out after B had paired back: A asks again with a new code, and B answers with the same sign-in.
    const { code } = await a.app.auth.createPairingCode(2 * 60_000, { scope: "peer", hubId: b.id });
    const again = await call<{ ok: boolean; deviceId: string; hub: { id: string } }>(b.base, "POST", "/api/machines/peer", ab.token, {
      kind: "back",
      url: a.base,
      code,
      hub: { id: a.id, name: "Mac mini" },
    });
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ ok: true, deviceId: ab.inboundDeviceId, hub: { id: b.id } });

    // The person taps Connect on the two-way link.
    expect((await a.api("POST", `/api/machines/${b.id}/connect`)).status).toBe(200);
    await until(() => linkOn(a, b)?.agents === "two-way", "A's link to settle");

    expect(a.app.store.listDevices().map((d) => d.id)).toEqual(devA);
    expect(b.app.store.listDevices().map((d) => d.id)).toEqual(devB);
    expect(linkOn(a, b)).toMatchObject({ token: ab.token, deviceId: ab.deviceId, inboundDeviceId: ab.inboundDeviceId });
    expect(linkOn(b, a)).toMatchObject({ token: ba.token, deviceId: ba.deviceId, inboundDeviceId: ba.inboundDeviceId });
  },
  SLOW,
);

test(
  "linking again replaces both old sign-ins",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const old = linkOn(a, b)!;

    await link(a, b);
    // Right away: A's old sign-in on B is deleted (with the new one), and B's old sign-in on A is revoked.
    expect(b.app.store.getDevice(old.deviceId)).toBeNull();
    expect(a.app.store.getDevice(old.inboundDeviceId!)).toBeNull();
    expect((await call(b.base, "GET", "/api/machines/peer", old.token)).status).toBe(401);

    // Agents connect again, with fresh sign-ins on both sides.
    await until(() => linkOn(a, b)?.agents === "two-way" && linkOn(b, a)?.inboundDeviceId === linkOn(a, b)?.deviceId, "the new link to connect");
    const now = linkOn(a, b)!;
    expect(now.deviceId).not.toBe(old.deviceId);
    expect(now.inboundDeviceId).not.toBe(old.inboundDeviceId);
    expect(b.app.store.listDevices().filter((d) => d.name === "Mac mini (hub)").map((d) => d.id)).toEqual([now.deviceId]);
    expect(a.app.store.devicesOfHub(b.id).map((d) => d.id)).toEqual([now.inboundDeviceId!]);
    expect(linkOn(b, a)!.deviceId).toBe(now.inboundDeviceId!);
    expect((await call(a.base, "GET", "/api/machines/peer", linkOn(b, a)!.token)).status).toBe(200);
    // One notification relay each way, the new one.
    expect(relays(a).map((r) => r.id)).toEqual([now.relayId!]);
    expect(forwards(b)).toHaveLength(1);
  },
  SLOW,
);

test(
  "linking from the other machine preserves both person-created full sign-ins",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box", { agents: true });
    await link(a, b);
    await twoWay(a, b);
    expect((await a.api("POST", `/api/machines/${b.id}/pair-code`)).status).toBe(200);
    // B's person links A from B too (one-tap Add of A on B's devices, A's notifications there).
    await link(b, a);
    await until(() => linkOn(b, a)?.scope === "full" && linkOn(b, a)?.agents === "two-way", "B's new link to connect");
    expect((await b.api("POST", `/api/machines/${a.id}/pair-code`)).status).toBe(200);
    // A's link was made by a person too and still shows as full (with its Add button): it must keep working.
    // Actual: B revoked A's full sign-in as an "old inbound device", and A's link-back handler then stored a peer
    // token under the full link, so B refuses it (403 peer_scope, passed on as 502).
    expect(linkOn(a, b)!.scope).toBe("full");
    const add = await a.api<{ error?: string }>("POST", `/api/machines/${b.id}/pair-code`);
    expect([add.status, add.data.error]).toEqual([200, undefined]);
  },
  SLOW,
);

test(
  "hubs linked from both sides connect when agents are enabled",
  async () => {
    const a = await hub("Mac mini");
    const b = await hub("Linux box");
    await link(a, b);
    await link(b, a);
    a.app.setHubSettings({ agentsAcrossChats: true });
    await until(() => !["one-way", "connecting"].includes(linkOn(a, b)!.agents), "A's link to settle");
    b.app.setHubSettings({ agentsAcrossChats: true });
    await settle();
    // Expected: two-way both ways. Actual: B's link-back finds its own (full) link to A and answers with its full
    // sign-in there, which A's check rejects ("didn't sign in here as expected"): A's link fails and retries forever.
    expect(linkOn(a, b)).toMatchObject({ agents: "two-way", error: null });
    expect(linkOn(b, a)).toMatchObject({ agents: "two-way", error: null });
  },
  SLOW,
);

// ------------------------------------------------------------------------------------------------ retries

test(
  "a link that failed while the other hub was off backs off, then connects on the retry tick once it's back",
  async () => {
    const a = await hub("Mac mini");
    const b = await hub("Linux box");
    await link(a, b); // agents off: one-way
    const port = Number(new URL(b.base).port);
    b.stop();
    a.app.setHubSettings({ agentsAcrossChats: true });
    await until(() => linkOn(a, b)?.agents === "failed", "the link to fail");
    const failed = linkOn(a, b)!;
    expect(failed.error).toContain("Couldn't reach");
    expect(failed.retries).toBe(1);
    // First backoff: a minute. Not due yet, so the tick leaves it.
    expect(failed.retryAt! - Date.now()).toBeGreaterThan(50_000);
    expect(failed.retryAt! - Date.now()).toBeLessThanOrEqual(60_000);
    await a.app.machines.retryTick();
    expect(linkOn(a, b)).toMatchObject({ agents: "failed", retries: 1, retryAt: failed.retryAt });
    // Due while B is still off: the next wait is 5 minutes.
    expireRetries(a);
    await a.app.machines.retryTick();
    expect(linkOn(a, b)).toMatchObject({ agents: "failed", retries: 2 });
    expect(linkOn(a, b)!.retryAt! - Date.now()).toBeGreaterThan(4 * 60_000);

    b.start(port); // back, at the same address
    expireRetries(a);
    await a.app.machines.retryTick();
    expect(linkOn(a, b)).toMatchObject({ agents: "two-way", error: null, retryAt: null, retries: 0 });
    await twoWay(a, b);
  },
  SLOW,
);

test(
  "an older hub (404) needs an update and a revoked sign-in (401) is signed out: neither is retried",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const older = { id: "h_olderhub0001" };
    const old = olderHub(older.id, "Old box");
    try {
      expect((await a.api("POST", "/api/machines/link", { url: `http://127.0.0.1:${old.port}`, code: "ABCD-EFGH" })).status).toBe(200);
      await until(() => linkOn(a, older)?.agents === "needs-update", "the older hub to need an update");
      expect(linkOn(a, older)).toMatchObject({ retryAt: null, error: expect.stringContaining("older Crosstalk") });
      expireRetries(a);
      await a.app.machines.retryTick();
      await a.app.machines.complete();
      expect(linkOn(a, older)!.agents).toBe("needs-update");
    } finally {
      old.stop(true);
    }

    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const bOnA = linkOn(a, b)!.inboundDeviceId!;
    // B's person signs A's hub out (Settings → Devices); A finds out on its next try.
    expect((await b.api("DELETE", `/api/devices/${linkOn(a, b)!.deviceId}`)).status).toBe(200);
    expect((await a.api("POST", `/api/machines/${b.id}/connect`)).status).toBe(200);
    await until(() => linkOn(a, b)?.agents === "signed-out", "A's link to show signed out");
    expect(linkOn(a, b)).toMatchObject({ retryAt: null, error: expect.stringContaining("no longer accepts this machine's sign-in") });
    expireRetries(a);
    await a.app.machines.retryTick();
    await a.app.machines.complete();
    expect(linkOn(a, b)!.agents).toBe("signed-out");
    // No automatic revokes: B's sign-in here stays until a person acts.
    expect(a.app.store.getDevice(bOnA)).not.toBeNull();
  },
  SLOW,
);

test(
  "a wrong callback address is a retryable pairing failure",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    // A's public address answers, but it isn't A (another web server has that name now).
    const notAHub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "not found" }, { status: 404 }) });
    try {
      a.app.config.publicUrl = `http://127.0.0.1:${notAHub.port}`;
      await link(a, b);
      await until(() => !["one-way", "connecting"].includes(linkOn(a, b)!.agents), "A's link to settle");
      // B is current and A's sign-in there works: the 404 came from B's pairing call to A's address, passed through
      // B's peer route as is. Expected: "failed" (retried). Actual: "needs-update", "Linux box runs an older Crosstalk".
      expect((await call(b.base, "GET", "/api/machines/peer", linkOn(a, b)!.token)).status).toBe(200);
      expect(linkOn(a, b)).toMatchObject({ agents: "failed" });
    } finally {
      notAHub.stop(true);
    }
  },
  SLOW,
);

// ------------------------------------------------------------------------------------------------ unlinking

test(
  "unlinking with the other hub off still signs it out here; its calls then get 401 and its forward goes",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const bOnA = linkOn(a, b)!.inboundDeviceId!;
    const bToken = linkOn(b, a)!.token;

    b.stop();
    const started = Date.now();
    expect((await a.api("DELETE", `/api/machines/${b.id}`)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rawLinks(a)).toEqual([]);
    expect(a.app.store.getDevice(bOnA)).toBeNull();
    expect(a.app.store.devicesOfHub(b.id)).toEqual([]);
    expect(relays(a)).toEqual([]);

    // B was off, so it still has its link; its sign-in on A no longer works.
    b.start();
    expect(linkOn(b, a)).not.toBeNull();
    expect((await call(a.base, "GET", "/api/machines/peer", bToken)).status).toBe(401);
    expect((await call(a.base, "GET", "/api/machines/chats", bToken)).status).toBe(401);
    // A refuses B's notifications now, and B stops sending them.
    await b.app.push.send({ title: "After the unlink", body: "", url: "./", tag: "after" });
    await until(() => forwards(b).length === 0, "B's forward to A to go");
    expect(a.sent.some((n) => n.title === "After the unlink")).toBe(false);
  },
  SLOW,
);

test(
  "a hub unlinked while offline marks its link signed-out on a 401",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box", { agents: true });
    const { member } = addChat(b.app, "Side project");
    await link(a, b);
    await twoWay(a, b);
    b.stop();
    expect((await a.api("DELETE", `/api/machines/${b.id}`)).status).toBe(200);
    b.start();
    // B's agents are told A no longer accepts B's sign-in...
    expect(await b.app.xchat.toolList(member, {})).toContain("Mac mini (no longer accepts this machine's sign-in)");
    // ...but Settings → Machines on B still says "Agents: two-way" (spec 1.10 and test 8: B shows signed-out).
    expect((await b.api<MachineInfo[]>("GET", "/api/machines")).data).toEqual([expect.objectContaining({ id: a.id, agents: "signed-out" })]);
  },
  SLOW,
);

test(
  "a peer unlink drops the link and signs the caller out, without calling back",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const aToken = linkOn(a, b)!.token; // A's sign-in on B
    const aOnB = linkOn(b, a)!.inboundDeviceId!;
    const bOnA = linkOn(a, b)!.inboundDeviceId!;

    // Only a sign-in bound to A may tell B that A unlinked it.
    expect((await b.api("DELETE", `/api/machines/${a.id}?peer=1`)).status).toBe(403);
    expect(linkOn(b, a)).not.toBeNull();

    const spy = spyFetch();
    let res: Res<unknown>;
    try {
      res = await call(b.base, "DELETE", `/api/machines/${a.id}?peer=1`, aToken);
    } finally {
      spy.restore();
    }
    expect(res.status).toBe(200);
    expect(rawLinks(b)).toEqual([]);
    expect(b.app.store.getDevice(aOnB)).toBeNull();
    expect(forwards(b)).toEqual([]);
    expect((await call(b.base, "GET", "/api/machines/peer", aToken)).status).toBe(401);
    // B didn't call A back: no request went to A, and A still has its link and B's sign-in.
    expect(spy.calls.filter((c) => c.url.startsWith(`${a.base}/`))).toEqual([]);
    expect(linkOn(a, b)).toMatchObject({ agents: "two-way", inboundDeviceId: bOnA });
    expect(a.app.store.getDevice(bOnA)).not.toBeNull();
  },
  SLOW,
);

test(
  "unlinking cascades: the hub A introduced B to drops B too",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    await link(a, b);
    await twoWay(a, b);
    await link(a, c);
    await twoWay(a, c);
    await twoWay(b, c);
    await until(() => intros(a).some((i) => i.state === "done"), "the introduction");
    const cOnB = linkOn(b, c)!.inboundDeviceId!;

    expect((await a.api("DELETE", `/api/machines/${b.id}`)).status).toBe(200);
    expect(rawLinks(a).map((l) => l.id)).toEqual([c.id]);
    expect(intros(a)).toEqual([]);
    expect(relays(a)).toHaveLength(1); // C's
    expect(forwards(b)).toEqual([]);
    // C drops B (and signs B out); C tells B, so B drops C too. C's link to B was a peer link: it stops there.
    await until(() => linkOn(c, b) === null && linkOn(b, c) === null, "C and B to drop each other");
    expect(c.app.store.devicesOfHub(b.id)).toEqual([]);
    expect(b.app.store.getDevice(cOnB)).toBeNull();
    expect(rawLinks(b)).toEqual([]);
    expect(names(b)).toEqual(["Linux box phone"]);
    // A and C stay linked.
    expect(linkOn(a, c)!.agents).toBe("two-way");
    expect(linkOn(c, a)!.agents).toBe("two-way");
    expect((await call(c.base, "GET", "/api/machines/peer", linkOn(a, c)!.token)).status).toBe(200);
  },
  SLOW,
);

test(
  "unlink cascades stop at the introduced hubs and preserve unrelated full links",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box", { agents: true });
    const c = await hub("MacBook", { agents: true });
    const d = await hub("Raspberry Pi", { agents: true });
    await link(a, b);
    await twoWay(a, b);
    await link(a, c);
    await twoWay(a, c);
    await twoWay(b, c); // the Mac introduced them
    await link(c, d); // the MacBook's person links the Pi
    await twoWay(c, d);
    await link(d, b); // and the Pi's person links the Linux box
    await twoWay(d, b);
    // The Mac's person unlinks the Linux box: the cascade reaches the MacBook, which drops it.
    const spy = spyFetch();
    try {
      expect((await a.api("DELETE", `/api/machines/${b.id}`)).status).toBe(200);
      await until(() => linkOn(c, b) === null, "the MacBook to drop the Linux box");
      await settle();
    } finally {
      spy.restore();
    }
    expect(spy.calls.filter((x) => x.method === "DELETE" && x.url === `${c.base}/api/machines/${b.id}`)).toHaveLength(1);
    // Spec 1.8: the MacBook "runs steps 1-4 itself" (no cascade of its own). Actual: it sends the same DELETE to the Pi,
    // which then drops the link its own person made to the Linux box.
    expect(spy.calls.filter((x) => x.url.startsWith(`${d.base}/`)).map((x) => `${x.method} ${x.url.slice(d.base.length)}`)).toEqual([]);
    expect(linkOn(d, b)).toMatchObject({ scope: "full", agents: "two-way" });
  },
  SLOW,
);

test(
  "unlinking from a hub that holds only peer links tells the other hub but doesn't cascade",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    await link(a, b);
    await twoWay(a, b);
    await link(a, c);
    await twoWay(a, c);
    await twoWay(b, c);
    await until(() => intros(a).some((i) => i.state === "done"), "the introduction");
    // On B, whose links are all peer links, its person unlinks A.
    expect((await b.api("DELETE", `/api/machines/${a.id}`)).status).toBe(200);
    expect(linkOn(b, a)).toBeNull();
    expect(linkOn(a, b)).toBeNull();
    expect(a.app.store.devicesOfHub(b.id)).toEqual([]);
    expect(b.app.store.devicesOfHub(a.id)).toEqual([]);
    expect(relays(a)).toHaveLength(1); // C's
    // No cascade: B and C stay linked, and so do A and C.
    await settle();
    expect([linkOn(b, c)?.agents, linkOn(c, b)?.agents, linkOn(a, c)?.agents, linkOn(c, a)?.agents]).toEqual(["two-way", "two-way", "two-way", "two-way"]);
  },
  SLOW,
);

test(
  "an unlink a restart interrupted is finished by the retry tick",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    await link(a, b);
    await twoWay(a, b);
    const bOnA = linkOn(a, b)!.inboundDeviceId!;
    const aOnB = linkOn(b, a)!.inboundDeviceId!;
    // The hub stopped right after marking the link as being removed.
    a.app.store.kvSet("machines.links", JSON.stringify(rawLinks(a).map((l) => ({ ...l, agents: "removing" }))));
    // Meanwhile B's sign-in no longer counts as a linked machine here.
    const r = await call<{ code: string }>(a.base, "GET", "/api/machines/chats", linkOn(b, a)!.token);
    expect([r.status, r.data.code]).toEqual([403, "not_linked"]);
    await a.app.machines.retryTick();
    expect(rawLinks(a)).toEqual([]);
    expect(a.app.store.getDevice(bOnA)).toBeNull();
    expect(rawLinks(b)).toEqual([]);
    expect(b.app.store.getDevice(aOnB)).toBeNull();
  },
  SLOW,
);

// ------------------------------------------------------------------------------------------------ the installer's claim

test(
  "the install claim: https or loopback, on this hub's tailnet, works once, and never connects agents by itself",
  async () => {
    const a = await hub("Mac mini", { agents: true });
    const b = await hub("Linux box");
    const inv = (await a.api<MachineInvite>("POST", "/api/machines/invite")).data;
    const claim = (body: unknown) => call<MachineInfo>(a.base, "POST", `/api/machines/install/${inv.token}/claim`, null, body);
    const status = async () => (await a.api<MachineInviteStatus>("GET", `/api/machines/invites/${inv.token}`)).data;

    const plain = await claim({ url: "http://192.168.1.20:7420", code: "ABCD-EFGH" });
    expect(plain.status).toBe(400);
    expect(String(plain.data)).toContain("https");
    // On a tailnet, the machine must be on the same one.
    a.app.config.publicUrl = "https://mac-mini.tail1234.ts.net";
    const other = await claim({ url: "https://linux-box.tail9999.ts.net", code: "ABCD-EFGH" });
    a.app.config.publicUrl = a.base;
    expect(other.status).toBe(400);
    expect(String(other.data)).toContain("same Tailscale network");
    // Two failures don't use it up.
    expect(await status()).toMatchObject({ status: "waiting" });

    const ok = await claim({ url: b.base, code: (await b.app.auth.createPairingCode()).code });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ id: b.id, url: b.base, scope: "full" });
    expect(await status()).toMatchObject({ status: "done", machine: { id: b.id } });
    // Linked, with notifications, but no agents: even with agents on here, that's a separate tap.
    await settle();
    expect(linkOn(a, b)).toMatchObject({ scope: "full", agents: "one-way", inboundDeviceId: null });
    expect(a.app.store.listDevices().filter((d) => d.scope === "peer")).toEqual([]);
    expect(rawLinks(b)).toEqual([]);
    expect(forwards(b).map((f) => f.url)).toEqual([`${a.base}/api/push/relay`]);

    // Used up: a replay is refused, even with a good code, and makes no sign-in.
    const again = await claim({ url: b.base, code: (await b.app.auth.createPairingCode()).code });
    expect(again.status).toBe(401);
    expect(String(again.data)).toContain("already used");
    expect(names(b).filter((n) => n === "Mac mini (hub)")).toHaveLength(1);

    // The "Connect agents" tap.
    const tap = await a.api<MachineInfo>("POST", `/api/machines/${b.id}/connect`);
    expect(tap.status).toBe(200);
    expect(tap.data).toMatchObject({ id: b.id, agents: "connecting" });
    await twoWay(a, b);
  },
  SLOW,
);

test(
  "the install claim: three failed claims use it up",
  async () => {
    const a = await hub("Mac mini");
    const b = await hub("Linux box");
    const inv = (await a.api<MachineInvite>("POST", "/api/machines/invite")).data;
    const claim = (body: unknown) => call(a.base, "POST", `/api/machines/install/${inv.token}/claim`, null, body);
    for (let i = 0; i < 3; i++) expect((await claim({ url: b.base, code: "WRNG-CODE" })).status).toBe(401);
    expect((await a.api<MachineInviteStatus>("GET", `/api/machines/invites/${inv.token}`)).data).toMatchObject({ status: "failed" });

    const late = await claim({ url: b.base, code: (await b.app.auth.createPairingCode()).code });
    expect(late.status).toBe(401);
    expect(rawLinks(a)).toEqual([]);
    expect(names(b)).toEqual(["Linux box phone"]);
    // The script is refused too.
    expect((await fetch(`${a.base}/api/machines/install/${inv.token}`)).status).toBe(401);
  },
  SLOW,
);

test(
  "concurrent install claims consume an invitation only once",
  async () => {
    const a = await hub("Mac mini");
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    const inv = (await a.api<MachineInvite>("POST", "/api/machines/invite")).data;
    const claim = async (h: Hub) => call(a.base, "POST", `/api/machines/install/${inv.token}/claim`, null, { url: h.base, code: (await h.app.auth.createPairingCode()).code });
    const results = await Promise.all([claim(b), claim(c)]);
    // Expected: one 200 and one 401 "already used". Actual: both link.
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(rawLinks(a)).toHaveLength(1);
  },
  SLOW,
);

// ------------------------------------------------------------------------------------------------ notification forwards

test(
  "a notification forward whose hub answers 401 is dropped; one that can't be reached is kept",
  async () => {
    const a = await hub("Mac mini");
    const b = await hub("Linux box");
    const c = await hub("MacBook");
    await link(a, b); // B forwards to A
    // Two more on B: one to a hub that never handed out this key (a relay key of a removed link, say), one to nowhere.
    const refused = `${c.base}/api/push/relay`;
    const gone = `http://127.0.0.1:${closedPort()}/api/push/relay`;
    for (const url of [refused, gone]) expect((await b.api("PUT", "/api/push/forward", { url, token: "k".repeat(32), name: "Old" })).status).toBe(200);
    expect(forwards(b)).toHaveLength(3);

    const spy = spyFetch();
    try {
      await b.app.push.send({ title: "Side project", body: "Codex finished: Done.", url: "./", tag: "t1" });
      await Promise.all(spy.calls.map((x) => x.done));
    } finally {
      spy.restore();
    }
    expect(spy.calls.map((x) => x.url).sort()).toEqual([`${a.base}/api/push/relay`, gone, refused].sort());
    await until(() => !forwards(b).some((f) => f.url === refused), "the refused forward to go");
    expect(forwards(b).map((f) => f.url).sort()).toEqual([`${a.base}/api/push/relay`, gone].sort());
    // Relayed with the machine it came from in the title.
    await until(() => a.sent.some((n) => n.title === "Side project · Linux box"), "A to get the notification");
  },
  SLOW,
);

test(
  "a stale forward rejection preserves the replacement key",
  async () => {
    const a = await hub("Mac mini");
    const b = await hub("Linux box");
    await link(a, b);
    const good = forwards(b)[0];
    // B sends with a key A no longer accepts (A re-linked B a moment ago), and the new key lands while that's under way.
    b.app.machines.setForward({ url: good.url, token: "s".repeat(32), name: good.name });
    const spy = spyFetch(() => b.app.machines.setForward({ url: good.url, token: good.token, name: good.name }));
    try {
      b.app.machines.forward({ title: "In flight", body: "", url: "./", tag: "f" });
    } finally {
      spy.restore();
    }
    expect(spy.calls.map((x) => x.url)).toEqual([good.url]);
    await Promise.all(spy.calls.map((x) => x.done));
    await settle();
    // Expected: the new key stays (only the refused key's entry goes). Actual: B stops forwarding to A altogether.
    expect(forwards(b)).toEqual([good]);
  },
  SLOW,
);

test("a second peer sign-in tagged for a hub cannot impersonate its bound sign-in", async () => {
  const a = await hub("Mac mini", { agents: true });
  const b = await hub("Linux box");
  await link(a, b);
  await twoWay(a, b);
  const extra = (await a.app.auth.pair((await a.app.auth.createPairingCode(60_000, { scope: "peer", hubId: b.id })).code, "Extra", "Crosstalk hub"))!;
  expect(a.app.machines.hubOfDevice(extra.device)).toBeNull();
  const res = await call(a.base, "GET", "/api/machines/chats", extra.token);
  expect([res.status, res.data.code]).toEqual([403, "not_linked"]);
  expect((await call(a.base, "DELETE", `/api/devices/${extra.device.id}`, extra.token)).status).toBe(200);
  expect(a.app.store.getDevice(linkOn(a, b)!.inboundDeviceId!)).not.toBeNull();
}, SLOW);

test("peer handshakes never promote a link to full from the remote's claimed scope", async () => {
  const a = await hub("Mac mini");
  const b = await hub("Linux box");
  // A person-generated code intentionally yields full on B; peer() still must save a peer link on A.
  const code = (await b.app.auth.createPairingCode()).code;
  const res = await a.api("POST", "/api/machines/peer", { kind: "back", url: b.base, code, hub: { id: b.id, name: b.name } });
  expect(res.status).toBe(200);
  expect(linkOn(a, b)).toMatchObject({ scope: "peer", relayId: null });
  expect((await a.api("POST", `/api/machines/${b.id}/pair-code`)).status).toBe(400);
}, SLOW);

test("a peer cannot move a person-created full link to another address", async () => {
  const a = await hub("Mac mini", { agents: true });
  const b = await hub("Linux box");
  await link(a, b);
  await twoWay(a, b);
  const res = await call(a.base, "POST", "/api/machines/peer", linkOn(b, a)!.token, { kind: "back", url: "https://other.example", code: "ABCD-EFGH", hub: { id: b.id, name: b.name } });
  expect(res.status).toBe(409);
  expect(linkOn(a, b)).toMatchObject({ scope: "full", url: b.base });
}, SLOW);

test("claimed links still require Connect after completion runs and settings changes", async () => {
  const a = await hub("Mac mini", { agents: true });
  const b = await hub("Linux box");
  const inv = (await a.api<MachineInvite>("POST", "/api/machines/invite")).data;
  const res = await call(a.base, "POST", `/api/machines/install/${inv.token}/claim`, null, { url: b.base, code: (await b.app.auth.createPairingCode()).code });
  expect(res.status).toBe(200);
  await a.app.machines.complete();
  a.app.setHubSettings({ agentsAcrossChats: false });
  a.app.setHubSettings({ agentsAcrossChats: true });
  await settle();
  expect(linkOn(a, b)).toMatchObject({ agents: "one-way", inboundDeviceId: null });
  expect(rawLinks(b)).toEqual([]);
}, SLOW);

test("simultaneous Connect on two full links completes without a reciprocal-lock deadlock", async () => {
  const a = await hub("Mac mini");
  const b = await hub("Linux box");
  await link(a, b);
  await link(b, a);
  a.app.setHubSettings({ agentsAcrossChats: true });
  b.app.setHubSettings({ agentsAcrossChats: true });
  await twoWay(a, b);
  expect((await a.api("POST", `/api/machines/${b.id}/pair-code`)).status).toBe(200);
  expect((await b.api("POST", `/api/machines/${a.id}/pair-code`)).status).toBe(200);
}, SLOW);

test("linking again after the offline other hub missed an unlink replaces its stale binding", async () => {
  const a = await hub("Mac mini", { agents: true });
  const b = await hub("Linux box");
  await link(a, b);
  await twoWay(a, b);
  const oldCaller = linkOn(b, a)!.inboundDeviceId!;
  const port = Number(new URL(b.base).port);
  b.stop();
  await a.app.machines.remove(b.id);
  b.start(port);
  await link(a, b);
  await twoWay(a, b);
  expect(linkOn(b, a)!.inboundDeviceId).not.toBe(oldCaller);
  expect(b.app.store.getDevice(oldCaller)).toBeNull();
}, SLOW);
