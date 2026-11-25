// The live connection carries this device's sign-in beside its name, not in its address; a machine on a version that
// knows only the address gets it there on the next try, and that's remembered for the machine.
import { afterEach, expect, test } from "bun:test";

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
  static made: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    Socket.made.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

function page() {
  Socket.made = [];
  replace("WebSocket", Socket);
  replace("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  replace("window", { addEventListener() {}, removeEventListener() {} });
  replace("location", { origin: "https://mini.example.ts.net" });
}
const TIMING = { heartbeatMs: 60_000, timeoutMs: 60_000, connectMs: 60_000 };

test("a new connection offers the sign-in beside its name, and its address says nothing of it", async () => {
  page();
  const { Live, socketAuth } = await import("./api");
  expect(socketAuth("abc-DEF_123")).toEqual(["crosstalk", "bearer.abc-DEF_123"]);
  const live = new Live({ baseUrl: "https://new.example.ts.net", token: "abc-DEF_123", deviceName: "Phone" }, () => {}, () => {}, TIMING as never);
  const s = Socket.made[0];
  expect(s.url).toMatch(/^wss:\/\/new\.example\.ts\.net\/api\/ws\?v=\d+$/);
  expect(s.url).not.toContain("abc-DEF_123");
  expect(s.protocols).toEqual(["crosstalk", "bearer.abc-DEF_123"]);
  s.readyState = 1;
  s.onopen?.();
  live.close();
});

test("a machine that knows only the address gets the sign-in there on the next try, and from then on", async () => {
  page();
  const { Live } = await import("./api");
  const statuses: string[] = [];
  const live = new Live({ baseUrl: "https://old.example.ts.net", token: "tok", deviceName: "Phone" }, () => {}, (s) => statuses.push(s), TIMING as never);
  const first = Socket.made[0];
  expect(first.protocols).toEqual(["crosstalk", "bearer.tok"]);
  // It never opens (an older machine refuses a connection with no sign-in in its address).
  first.onclose?.();
  live.reconnectNow();
  const second = Socket.made.at(-1)!;
  expect(second).not.toBe(first);
  expect(second.url).toMatch(/^wss:\/\/old\.example\.ts\.net\/api\/ws\?token=tok&v=\d+$/);
  expect(second.protocols).toBeUndefined();
  second.readyState = 1;
  second.onopen?.();
  // Dropped later and connected again: the way that worked, at once.
  second.onclose?.();
  live.reconnectNow();
  const third = Socket.made.at(-1)!;
  expect(third.url).toContain("?token=tok");
  live.close();
});
