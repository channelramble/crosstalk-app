// Reconnecting: what one machine's store asks the hub for when its socket opens, and what the app is told when the hub
// closes the socket because this device was signed out.
//
// THE FIRST TWO TESTS IN THIS FILE ARE EXPECTED TO FAIL on today's code: each describes a defect, with the mechanism in
// its comment. They are written as the behaviour a person would expect, so fixing the defect makes them pass. The third,
// a connection that drops and opens again, came with the fix for the second.
import { afterEach, expect, test } from "bun:test";
import type { Room } from "@crosstalk/shared";

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
afterEach(() => {
  for (const [key, desc] of originals) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  sent: string[] = [];
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const AT = 1_800_000_000_000;
const room = (): Room =>
  ({ id: "r1", name: "Chat", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: AT - 100_000, updatedAt: AT, archived: false, chat: { provider: "codex", origin: "web" }, lastReplyAt: AT, readAt: AT }) as Room;

/**
 * A machine whose state and history answer at once, counting what was asked of it (`paths`: every request, in order).
 * `unauthorized`: every request 401s.
 */
function hub() {
  const counts = { state: 0, history: 0 };
  const paths: string[] = [];
  const snapshot = { hub: { id: "h", name: "Mac", messagesFlow: true }, device: { id: "d", name: "Phone" }, rooms: [room()], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {} };
  const history = { room: room(), messages: [], turns: [], activities: [], approvals: [], totals: null, hasMore: false, tasks: {} };
  // `stateLands`: when an answer to /api/state, made as it's asked for, gets here (a slow link).
  const control = { unauthorized: false, stateLands: Promise.resolve() };
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/" });
  replace("navigator", { userAgent: "test" });
  replace("fetch", async (url: string) => {
    const u = String(url);
    paths.push(new URL(u).pathname);
    if (control.unauthorized) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    if (u.includes("/api/state")) {
      counts.state++;
      const made = JSON.stringify(snapshot);
      await control.stateLands;
      return new Response(made);
    }
    if (u.includes("/history")) {
      counts.history++;
      return new Response(JSON.stringify(history));
    }
    return new Response("{}");
  });
  return { counts, paths, control };
}

const hooks = (signedOut: () => void) => ({ toast() {}, openRoomId: () => "r1", roomGone() {}, signedOut, approval() {}, ptyData() {} });

test("opening the connection asks the hub for its state once, not twice", async () => {
  // EXPECTED TO FAIL. HubStore.start() fetches /api/state itself (hubStore.ts:570) and Live's "open" status callback
  // fetches it again (hubStore.ts:557 `void get().refresh({ missed: true })`), with nothing to tell the two apart: the
  // socket opens while the first fetch is still in flight. So every app start, page reload and added machine
  // downloads the whole snapshot twice at once, per machine — and when the first one lands first, the open chat's
  // history (which re-pages back through everything already read) is fetched twice too.
  const { counts } = hub();
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, hooks(() => {}));
  try {
    const started = store.getState().start();
    Socket.instances[0].open();
    await started;
    for (let i = 0; i < 60 && !store.getState().roomData.r1?.loaded; i++) await Bun.sleep(5);
    await Bun.sleep(50);
    expect(store.getState().roomData.r1?.loaded).toBe(true);
    expect(counts.state).toBe(1);
    expect(counts.history).toBe(1);
  } finally {
    store.getState().stop();
  }
});

test("a device signed out while the app is open is told so, not left reconnecting", async () => {
  // EXPECTED TO FAIL. The hub closes a revoked device's socket (server.ts `allowed`: close 1008 "This device has been
  // signed out.") and refuses the next /api/ws upgrade with 401. Live ignores the close code and just retries forever,
  // and hubStore only learns of a 401 from a refresh — which it never makes while the socket is down (refresh runs only
  // on status "open"). So hooks.signedOut() is never called: the phone says "Can't reach <machine>. Trying again…" and,
  // after 20 s, "Check that Tailscale is on." for as long as the app stays open.
  const { control } = hub();
  let signedOut = 0;
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, hooks(() => signedOut++));
  try {
    const started = store.getState().start();
    Socket.instances[0].open();
    await started;
    expect(store.getState().status).toBe("open");
    // Signed out from another device: the hub drops the socket and refuses this token.
    control.unauthorized = true;
    Socket.instances[0].close();
    for (let i = 0; i < 100 && !signedOut; i++) await Bun.sleep(10);
    expect(signedOut).toBe(1);
  } finally {
    store.getState().stop();
  }
});

test("a connection that drops and opens again downloads the state once more, not twice", async () => {
  // A phone waking up or changing networks while the hub is up: the socket drops and opens again a moment later. The
  // sign-in check (hubStore.ts signInCheck) asks the hub as the socket closes, and the socket that opens again asks for
  // the state to catch up. Were the check to ask for the state too, every such drop would download all of it twice.
  const { counts, paths } = hub();
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, hooks(() => {}));
  try {
    const started = store.getState().start();
    Socket.instances[0].open();
    await started;
    for (let i = 0; i < 60 && !store.getState().roomData.r1?.loaded; i++) await Bun.sleep(5);
    expect(counts.state).toBe(1);
    const before = paths.length;
    Socket.instances[0].close();
    expect(store.getState().status).toBe("closed");
    // The sign-in check goes out as the socket closes: it is still made.
    for (let i = 0; i < 100 && paths.length === before; i++) await Bun.sleep(5);
    expect(paths.length).toBeGreaterThan(before);
    // The network is back: Live connects again at once (as it would after its short pause), and the socket opens.
    window.dispatchEvent(new Event("online"));
    expect(Socket.instances).toHaveLength(2);
    const reopened = counts.state;
    Socket.instances[1].open();
    for (let i = 0; i < 100 && counts.state === reopened; i++) await Bun.sleep(5);
    await Bun.sleep(50);
    expect(store.getState().status).toBe("open");
    expect(counts.state).toBe(2);
  } finally {
    store.getState().stop();
  }
});

test("back in touch: an agent whose helpers finished meanwhile no longer counts as having any, and one that still has them does", async () => {
  // Its Helpers panel and whether a message of yours gets the Send now bar go by this (sendNow.ts), and the event that
  // said its helpers had finished went by while this device was away.
  hub();
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, hooks(() => {}));
  try {
    const started = store.getState().start();
    Socket.instances[0].open();
    await started;
    const stale = { id: "h1", status: "running" };
    store.setState({ members: { mb1: { id: "mb1", roomId: "r1" }, other: { id: "other", roomId: "r2" } } as never, tasks: { mb1: [stale], other: [stale] } as never });
    await store.getState().loadHistory("r1");
    expect(store.getState().tasks.mb1).toEqual([]);
    // Another chat's agent wasn't part of that answer: left as it was until that chat is loaded.
    expect(store.getState().tasks.other as unknown).toEqual([stale]);
  } finally {
    store.getState().stop();
  }
});

test("the hub changes what it says of itself: this device goes by it at once, with nothing to reload and nothing asked again", async () => {
  // Settings → Keep going while helpers work, changed on any device: whether a message gets a bar goes by HubInfo.messagesFlow.
  const { paths } = hub();
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, hooks(() => {}));
  try {
    const started = store.getState().start();
    Socket.instances[0].open();
    await started;
    for (let i = 0; i < 60 && !store.getState().roomData.r1?.loaded; i++) await Bun.sleep(5);
    const say = (e: unknown) => Socket.instances[0].onmessage?.({ data: JSON.stringify(e) });
    say({ t: "hello", device: { id: "d", name: "Phone" }, hub: { id: "h", name: "Mac", messagesFlow: true } });
    expect(store.getState().hub?.messagesFlow).toBe(true);
    const asked = paths.length;
    say({ t: "hub", hub: { id: "h", name: "Mac", messagesFlow: false } });
    expect(store.getState().hub?.messagesFlow).toBe(false);
    say({ t: "hub", hub: { id: "h", name: "Mac", messagesFlow: true } });
    expect(store.getState().hub?.messagesFlow).toBe(true);
    expect(paths.length).toBe(asked);
    // Who it is on this hub isn't touched.
    expect(store.getState().device?.name).toBe("Phone");
  } finally {
    store.getState().stop();
  }
});

test("the hub's word that comes while a state fetch is on its way isn't undone by that older state", async () => {
  // A phone catching up on a slow link: the hub answers GET /api/state, another device then turns Keep going while helpers
  // work off, and this one hears that before the older answer lands. It would go on showing no Answer now for a message the
  // hub holds, until the next reconnect or flip.
  const { control } = hub();
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, hooks(() => {}));
  try {
    const started = store.getState().start();
    Socket.instances[0].open();
    await started;
    for (let i = 0; i < 60 && !store.getState().roomData.r1?.loaded; i++) await Bun.sleep(5);
    expect(store.getState().hub?.messagesFlow).toBe(true);
    let land = () => {};
    control.stateLands = new Promise((resolve) => (land = resolve));
    const catchingUp = store.getState().refresh();
    Socket.instances[0].onmessage?.({ data: JSON.stringify({ t: "hub", hub: { id: "h", name: "Mac", messagesFlow: false } }) });
    expect(store.getState().hub?.messagesFlow).toBe(false);
    land();
    await catchingUp;
    expect(store.getState().hub?.messagesFlow).toBe(false);
    // With nothing heard meanwhile the state is what counts: it says what this device missed while it was away.
    await store.getState().refresh();
    expect(store.getState().hub?.messagesFlow).toBe(true);
  } finally {
    store.getState().stop();
  }
});
