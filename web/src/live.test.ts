import { afterEach, expect, test } from "bun:test";
import { Live } from "./api";

const originals = new Map<string, PropertyDescriptor | undefined>();
const lives: Live[] = [];
function replace(key: string, value: unknown) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  sent: string[] = [];
  constructor(public url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function setup(timing: ConstructorParameters<typeof Live>[3] = { heartbeatMs: 20, timeoutMs: 30 }) {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost" });
  const statuses: string[] = [];
  const events: unknown[] = [];
  const resumed: number[] = [];
  const live = new Live({ baseUrl: "", token: "test", deviceName: "test" }, (e) => events.push(e), (s) => statuses.push(s), timing, (away) => resumed.push(away));
  lives.push(live);
  return { live, statuses, events, resumed, socket: Socket.instances[0] };
}
/** The page goes to the background (another app, the phone locked) and, `ms` later, comes back. */
async function away(ms: number) {
  const doc = document as unknown as { visibilityState: string };
  doc.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(ms);
  doc.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
}
const pings = (s: Socket) => s.sent.filter((x) => JSON.parse(x).t === "ping").length;
afterEach(() => {
  for (const live of lives.splice(0)) live.close();
  for (const [key, desc] of originals) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test("a socket stuck connecting stops claiming it is connecting forever", async () => {
  const { statuses, socket } = setup();
  await Bun.sleep(60);
  expect(socket.readyState).toBe(3);
  expect(statuses).toEqual(["connecting", "closed"]);
});

test("an open but unresponsive socket is replaced on wake, and late old events are ignored", async () => {
  const { statuses, socket, events } = setup();
  socket.open();
  await Bun.sleep(75);
  expect(socket.sent).toContain(JSON.stringify({ t: "ping" }));
  expect(statuses.at(-1)).toBe("closed");
  window.dispatchEvent(new Event("online"));
  const next = Socket.instances[1];
  expect(next).toBeDefined();
  next.open();
  socket.message({ t: "notice", level: "error", text: "stale" });
  socket.onopen?.();
  expect(events).toEqual([]);
  expect(statuses.at(-1)).toBe("open");
});

test("pong keeps an idle connection open and close ignores already queued callbacks", async () => {
  const { live, statuses, events, socket } = setup();
  socket.open();
  await Bun.sleep(25);
  socket.message({ t: "pong" });
  await Bun.sleep(25);
  socket.message({ t: "pong" });
  expect(statuses.at(-1)).toBe("open");
  expect(events).toEqual([]);
  live.close();
  const count = statuses.length;
  socket.onopen?.();
  socket.message({ t: "notice", level: "error", text: "stale" });
  await Bun.sleep(70);
  expect(events).toEqual([]);
  expect(statuses).toHaveLength(count);
  expect(Socket.instances).toHaveLength(1);
});

test("waking with an open socket pings with a short deadline and replaces it without a pong", async () => {
  // A long heartbeat, so only the wake check pings.
  const { statuses, socket, resumed } = setup({ heartbeatMs: 10_000, timeoutMs: 5_000, wakeMs: 30, connectMs: 5_000 });
  socket.open();
  expect(pings(socket)).toBe(0);
  await away(20);
  // At once, not after the 10 s heartbeat.
  expect(pings(socket)).toBe(1);
  expect(statuses.at(-1)).toBe("open");
  // No answer within 30 ms: this socket died while the page was away, and a new one connects right away.
  await Bun.sleep(60);
  expect(socket.readyState).toBe(3);
  expect(statuses.slice(-3)).toEqual(["open", "closed", "connecting"]);
  expect(Socket.instances).toHaveLength(2);
  expect(resumed).toEqual([]);
  Socket.instances[1].open();
  expect(statuses.at(-1)).toBe("open");
});

test("a pong on wake changes nothing", async () => {
  const { statuses, socket, resumed, events } = setup({ heartbeatMs: 10_000, timeoutMs: 5_000, wakeMs: 30, connectMs: 5_000 });
  socket.open();
  await away(25);
  expect(pings(socket)).toBe(1);
  socket.message({ t: "pong" });
  await Bun.sleep(60);
  // The same socket, still open, and nothing for the app to catch up on: it hears how long the page was away.
  expect(statuses).toEqual(["connecting", "open"]);
  expect(Socket.instances).toHaveLength(1);
  expect(events).toEqual([]);
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toBeGreaterThanOrEqual(20);
  // A second wake with an answer: told again.
  await away(5);
  socket.message({ t: "pong" });
  expect(resumed).toHaveLength(2);
});

test("reconnectNow skips the backoff", async () => {
  const { live, statuses, socket } = setup({ heartbeatMs: 10_000, timeoutMs: 5_000, wakeMs: 30, connectMs: 5_000 });
  socket.open();
  // After a run of failures, the next try waits 15 s.
  (live as unknown as { retry: number }).retry = 8;
  socket.close();
  expect(statuses.at(-1)).toBe("closed");
  await Bun.sleep(20);
  expect(Socket.instances).toHaveLength(1);
  live.reconnectNow();
  expect(Socket.instances).toHaveLength(2);
  expect(statuses.at(-1)).toBe("connecting");
  Socket.instances[1].open();
  expect(statuses.at(-1)).toBe("open");
  // A try still connecting is dropped for a fresh one, and its late callbacks change nothing.
  Socket.instances[1].close();
  live.reconnectNow();
  const stuck = Socket.instances[2];
  live.reconnectNow();
  expect(Socket.instances).toHaveLength(4);
  stuck.open();
  expect(statuses.at(-1)).toBe("connecting");
  // An open connection is checked with a ping instead of replaced.
  Socket.instances[3].open();
  live.reconnectNow();
  expect(Socket.instances).toHaveLength(4);
  expect(pings(Socket.instances[3])).toBe(1);
});
