import { afterEach, expect, test } from "bun:test";
import type { Room } from "@crosstalk/shared";
import { isUnread } from "./chatList";
import { keepRead } from "./hubStore";

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
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const AT = 1_800_000_000_000;
const room = (patch: Partial<Room> = {}): Room => ({ id: "r1", name: "Chat", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: AT - 100_000, updatedAt: AT, archived: false, chat: { provider: "codex", origin: "web" }, lastReplyAt: AT, readAt: AT - 60_000, ...patch }) as Room;

test("a copy of a room fetched before it was read keeps the read", () => {
  const read = room({ readAt: AT });
  expect(keepRead(read, room())).toEqual(read);
  expect(isUnread(keepRead(read, room()))).toBe(false);
  // Read further on the machine: that's taken.
  expect(keepRead(room(), read)).toBe(read);
  // A room this device didn't have, or never read: as it came.
  const fresh = room({ readAt: undefined });
  expect(keepRead(undefined, fresh)).toBe(fresh);
  expect(keepRead(fresh, fresh)).toBe(fresh);
});

test("a history answer served before a read doesn't make the chat unread again", async () => {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/" });
  replace("navigator", { userAgent: "test" });
  const unreadCopy = room();
  const snapshot = { hub: { id: "h", name: "Mac" }, device: { id: "d", name: "Phone" }, rooms: [unreadCopy], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {} };
  const history = { room: unreadCopy, messages: [], turns: [], activities: [], approvals: [], totals: null, hasMore: false, tasks: {} };
  let held: ((r: Response) => void) | null = null;
  let histories = 0;
  replace("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/api/state")) return new Response(JSON.stringify(snapshot));
    if (u.includes("/history")) {
      // The second load (the reconnect's catch-up) is held: it was served before the read.
      if (++histories === 1) return new Response(JSON.stringify(history));
      return new Promise<Response>((res) => (held = res));
    }
    return new Response("{}");
  });
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, { toast() {}, openRoomId: () => "r1", roomGone() {}, signedOut() {}, approval() {}, ptyData() {} });
  try {
    await store.getState().start();
    const socket = Socket.instances[0];
    socket.open();
    for (let i = 0; i < 50 && !store.getState().roomData.r1?.loaded; i++) await Bun.sleep(5);
    expect(store.getState().roomData.r1?.loaded).toBe(true);
    expect(isUnread(store.getState().rooms.r1)).toBe(true);
    // Back from the lock screen: the app catches up, and meanwhile this device marks the chat read.
    const catchingUp = store.getState().refresh({ missed: true });
    for (let i = 0; i < 50 && !held; i++) await Bun.sleep(5);
    expect(held).not.toBeNull();
    socket.message({ t: "room", room: room({ readAt: AT }) });
    expect(isUnread(store.getState().rooms.r1)).toBe(false);
    // The history the machine served before the read comes in now.
    held!(new Response(JSON.stringify(history)));
    await catchingUp;
    expect(store.getState().rooms.r1.readAt).toBe(AT);
    expect(isUnread(store.getState().rooms.r1)).toBe(false);
  } finally {
    store.getState().stop();
  }
});
