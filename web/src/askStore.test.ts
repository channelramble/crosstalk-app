import { afterEach, expect, test } from "bun:test";
import type { Ask, Room } from "@crosstalk/shared";

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
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  send() {}
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
const ask = (id: string, patch: Partial<Ask> = {}): Ask => ({
  id, roomId: "r1", messageId: "m1", target: { provider: "codex", account: "default", model: "gpt-5.5", effort: null }, label: "Codex · GPT-5.5",
  status: "done", answer: "Fine.", error: null, cost: null, note: null, local: false, createdAt: AT + Number(id.charCodeAt(0)), startedAt: AT, endedAt: AT + 1000, ...patch,
});

/** A hub store on a fake hub: one room, an empty history, and whatever `asksAnswer` says to the asks list. */
async function openChat(asksAnswer: () => Response | Promise<Response>, chat = true) {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/" });
  replace("navigator", { userAgent: "test" });
  const room = { id: "r1", name: "Chat", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: AT, updatedAt: AT, archived: false, ...(chat ? { chat: { provider: "claude", origin: "web" } } : {}) } as Room;
  const snapshot = { hub: { id: "h", name: "Mac" }, device: { id: "d", name: "Phone" }, rooms: [room], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {} };
  const history = { room, messages: [], turns: [], activities: [], approvals: [], totals: null, hasMore: false, tasks: {} };
  const asked: string[] = [];
  replace("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/api/state")) return new Response(JSON.stringify(snapshot));
    if (u.includes("/history")) return new Response(JSON.stringify(history));
    if (u.includes("/asks")) {
      asked.push(u);
      return asksAnswer();
    }
    return new Response("{}");
  });
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, { toast() {}, openRoomId: () => "r1", roomGone() {}, signedOut() {}, approval() {}, ptyData() {} });
  await store.getState().start();
  Socket.instances[0].open();
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(5);
  };
  await until(() => !!store.getState().roomData.r1?.loaded);
  return { store, socket: Socket.instances[0], asked, until };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ids = (list: Ask[] | undefined) => (list ?? []).map((a) => a.id);

test("a chat's asks load with its history, and live events keep them current", async () => {
  const { store, socket, asked, until } = await openChat(() => json([ask("b", { status: "running", answer: null }), ask("a")]));
  try {
    await until(() => (store.getState().asks.r1?.length ?? 0) === 2);
    expect(asked[0]).toContain("/api/rooms/r1/asks");
    expect(ids(store.getState().asks.r1)).toEqual(["a", "b"]);
    socket.message({ t: "ask", ask: ask("b") });
    expect(store.getState().asks.r1.find((a) => a.id === "b")!.status).toBe("done");
    socket.message({ t: "ask", ask: ask("c") });
    expect(ids(store.getState().asks.r1)).toEqual(["a", "b", "c"]);
    socket.message({ t: "ask.removed", id: "a", roomId: "r1" });
    expect(ids(store.getState().asks.r1)).toEqual(["b", "c"]);
    socket.message({ t: "room.deleted", roomId: "r1" });
    expect(store.getState().asks.r1).toBeUndefined();
  } finally {
    store.getState().stop();
  }
});

test("what live events said while the list was on its way wins over the list", async () => {
  let release!: () => void;
  const held = new Promise<Response>((res) => (release = () => res(json([ask("a"), ask("b")]))));
  const { store, socket, asked, until } = await openChat(() => held);
  try {
    await until(() => asked.length > 0);
    // `a` is removed and `c` is asked while the hub's list (from before both) is still coming.
    socket.message({ t: "ask.removed", id: "a", roomId: "r1" });
    socket.message({ t: "ask", ask: ask("c") });
    release();
    await until(() => (store.getState().asks.r1?.length ?? 0) === 2);
    expect(ids(store.getState().asks.r1)).toEqual(["b", "c"]);
    // One list at a time: more history loads while it was on its way asked nothing else.
    expect(asked).toHaveLength(1);
  } finally {
    store.getState().stop();
  }
});

test("a hub from before Ask others, or a room that isn't a chat, just has no cards", async () => {
  const old = await openChat(() => json({ error: "Not found" }, 404));
  try {
    await old.until(() => old.asked.length > 0);
    await Bun.sleep(20);
    expect(old.store.getState().asks).toEqual({});
    expect(old.store.getState().roomData.r1.error).toBeNull();
  } finally {
    old.store.getState().stop();
  }
  const group = await openChat(() => json([ask("a")]), false);
  try {
    await Bun.sleep(30);
    expect(group.asked).toEqual([]);
    expect(group.store.getState().asks).toEqual({});
  } finally {
    group.store.getState().stop();
  }
});
