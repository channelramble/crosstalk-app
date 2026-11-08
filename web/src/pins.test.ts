// Pinned chats in the app: the list's order and the places a move picks (chatList.ts), what a failed pin says, and how
// a pin made here or elsewhere survives answers that were served before it (hubStore.ts keepPin, pins.ts setPin).
import { afterEach, expect, test } from "bun:test";
import type { Room } from "@crosstalk/shared";
import { ApiError } from "./api";
import { comparePins, isPinned, movedPins, newPinOrder, pinOrderAt, pinProblem, pinnedFirst, renumberPins, topPinOrder } from "./chatList";
import { createHubStore, keepPin } from "./hubStore";

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
const room = (id: string, extra: Partial<Room> = {}): Room => ({ id, name: `Chat ${id}`, cwd: `/work/${id}`, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: AT - 100_000, updatedAt: AT, archived: false, chat: { provider: "codex", origin: "web" }, ...extra });
const pin = (id: string, order: number, at = AT, extra: Partial<Room> = {}) => room(id, { pinnedAt: at, pinOrder: order, ...extra });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

test("pinned chats come first, every machine's in one order, and the rest stay newest first", () => {
  const mac = { key: "", name: "Mac mini" };
  const linux = { key: "https://linux-box.example", name: "Linux box" };
  const rows = [
    { room: room("mac-old", { updatedAt: AT - 5000 }), machine: mac },
    { room: pin("mac-b", 1), machine: mac },
    { room: room("linux-new", { updatedAt: AT + 5000 }), machine: linux },
    { room: pin("linux-a", 0.5), machine: linux },
    { room: pin("mac-a", 0), machine: mac },
    { room: pin("linux-c", 2), machine: linux },
    // A chat of an older hub: it says nothing about pins.
    { room: room("older"), machine: linux },
  ];
  const { pinned, rest } = pinnedFirst(rows, (r) => r.room);
  expect(pinned.map((r) => r.room.id)).toEqual(["mac-a", "linux-a", "mac-b", "linux-c"]);
  expect(rest.map((r) => r.room.id)).toEqual(["linux-new", "older", "mac-old"]);
  // The same rows, not copies: each keeps its machine.
  expect(pinned[1]).toBe(rows[3]);

  // Two in the same place: the newest pin first, then by id. Never by machine, whose key differs from device to device.
  const tied = [pin("b", 0, AT), pin("a", 0, AT), pin("c", 0, AT + 10)];
  expect(ids(pinnedFirst(tied, (r) => r).pinned)).toEqual(["c", "a", "b"]);
  expect(ids(pinnedFirst([...tied].reverse(), (r) => r).pinned)).toEqual(["c", "a", "b"]);
  expect(comparePins(pin("x", 1), pin("y", 2))).toBeLessThan(0);

  expect(isPinned(room("x"))).toBe(false);
  expect(isPinned(room("x", { pinnedAt: null, pinOrder: 3 }))).toBe(false);
  expect(isPinned(pin("x", 0))).toBe(true);
});

test("a new pin goes above every machine's pins, those of a machine this device hasn't loaded too", () => {
  const now = AT + 60_000;
  expect(topPinOrder([])).toBeNull();
  expect(topPinOrder([pin("a", 3), pin("b", -2), room("c")])).toBe(-2);
  // At most minus the seconds since 1970: above any pinned earlier, seen or not, and far inside what the hub keeps.
  expect(newPinOrder([], now)).toBe(-now / 1000);
  expect(Math.abs(newPinOrder([]))).toBeLessThan(1e12);
  expect(newPinOrder([pin("a", 3), pin("b", -2)], now)).toBe(-now / 1000);
  // Above a top one that's higher still (pinned within the second, or moved up past it); a place left on a chat that
  // isn't pinned doesn't count.
  expect(newPinOrder([pin("a", -now / 1000 + 0.5), room("c", { pinOrder: -now })], now)).toBe(-now / 1000 - 0.5);
  expect(newPinOrder([pin("a", newPinOrder([], now))], now)).toBe(-now / 1000 - 1);

  // The Linux box's two pins top the list; it's down when the phone opens, and the phone pins a Mac chat to the top.
  // On the laptop, which has both machines, that one is first.
  const linuxA = pin("linux-a", newPinOrder([], AT), AT);
  const linuxB = pin("linux-b", newPinOrder([linuxA], AT + 1000), AT + 1000);
  const macTop = pin("mac-top", 0);
  const fromPhone = pin("mac-new", newPinOrder([macTop], now), now);
  expect(ids(pinnedFirst([macTop, linuxA, fromPhone, linuxB], (r) => r).pinned)).toEqual(["mac-new", "linux-b", "linux-a", "mac-top"]);
  // Moves between such places still find one between.
  expect(pinOrderAt([fromPhone, linuxB, linuxA, macTop], 3, 1)).toBe((fromPhone.pinOrder! + linuxB.pinOrder!) / 2);
});

test("a move picks one new place between the new neighbours, or none when there's no room", () => {
  const list = [pin("a", 0), pin("b", 1), pin("c", 2), pin("d", 3)];
  /** The order after the chat at `from` takes `place`. */
  const after = (rows: Room[], from: number, place: number | null) => ids(pinnedFirst(rows.map((r, i) => (i === from ? { ...r, pinOrder: place } : r)), (r) => r).pinned);
  // Move up: c goes between a and b; Move down: a goes between b and c.
  expect(pinOrderAt(list, 2, 1)).toBe(0.5);
  expect(after(list, 2, pinOrderAt(list, 2, 1))).toEqual(["a", "c", "b", "d"]);
  expect(pinOrderAt(list, 0, 1)).toBe(1.5);
  expect(after(list, 0, pinOrderAt(list, 0, 1))).toEqual(["b", "a", "c", "d"]);
  // To the top and to the bottom: one past the end.
  expect(pinOrderAt(list, 3, 0)).toBe(-1);
  expect(pinOrderAt(list, 0, 3)).toBe(4);
  expect(after(list, 0, pinOrderAt(list, 0, 3))).toEqual(["b", "c", "d", "a"]);
  // Between two chats of other machines (Mac's at 0.5, the Linux box's at 1): only the moved chat changes.
  const mixed = [pin("mac-a", 0), pin("linux-a", 0.5), pin("mac-b", 1), pin("linux-c", 2)];
  expect(pinOrderAt(mixed, 3, 2)).toBe(0.75);
  expect(after(mixed, 3, 0.75)).toEqual(["mac-a", "linux-a", "linux-c", "mac-b"]);
  // A lone pin stays where it is.
  expect(pinOrderAt([pin("a", 7)], 0, 0)).toBe(7);
  // No number between two chats in the same place, or after enough moves between the same two: none.
  expect(pinOrderAt([pin("a", 0), pin("b", 0, AT - 1), pin("c", 5)], 2, 1)).toBeNull();
  expect(pinOrderAt([pin("a", 1), pin("b", 1 + Number.EPSILON), pin("c", 3)], 2, 1)).toBeNull();
  // Nor beyond what the hub keeps.
  expect(pinOrderAt([pin("a", 0), pin("b", 1e12)], 0, 1)).toBeNull();
});

test("numbering the pins again writes only the ones whose place changes", () => {
  const rows = [pin("a", 0), pin("b", 0, AT - 1), pin("c", 5)];
  // c moved up between a and b, which share a place.
  const moved = movedPins(rows, 2, 1);
  expect(ids(moved)).toEqual(["a", "c", "b"]);
  expect(renumberPins(moved, (r) => r.pinOrder).map((c) => [c.row.id, c.order])).toEqual([["c", 1], ["b", 2]]);
  // Numbered already: nothing to write.
  expect(renumberPins([pin("x", 0), pin("y", 1)], (r) => r.pinOrder)).toEqual([]);
  // Past either end: it goes to that end.
  expect(movedPins([1, 2, 3], 0, 10)).toEqual([2, 3, 1]);
  expect(movedPins([1, 2, 3], 2, -1)).toEqual([3, 1, 2]);
});

test("a pin that didn't happen says why: an older Crosstalk, a machine out of reach, or the hub's own words", () => {
  expect(pinProblem(new ApiError(404, "not found"), "Linux box")).toEqual({ why: "older", text: "Update Crosstalk on Linux box to pin its chats." });
  expect(pinProblem(new ApiError(0, "Can't reach the hub. Check that it's running and that this device is on your Tailscale network."), "Linux box")).toEqual({ why: "down", text: "Can't reach Linux box. Try again when it's back." });
  const gone = "That chat is gone. It may have been deleted on another device.";
  expect(pinProblem(new ApiError(404, gone, "no_room"), "Mac mini")).toEqual({ why: "other", text: gone });
  expect(pinProblem(new ApiError(400, "Say whether to pin the chat (pinned: true or false)."), "Mac mini").why).toBe("other");
  expect(pinProblem(new ApiError(401, "unauthorized"), "Linux box").text).toBe("This device was signed out of Linux box. Add it again in Settings → Machines.");
  expect(pinProblem("odd", "Mac mini")).toEqual({ why: "other", text: "odd" });
});

test("a chat's history keeps the pin this device has", () => {
  const pinned = pin("r1", 2);
  const plain = room("r1");
  // Served before the pin: still pinned.
  expect(keepPin(pinned, plain)).toEqual(pinned);
  // Served before an unpin: still unpinned, with no pin fields at all (as the hub sends a chat that isn't pinned).
  const back = keepPin(plain, pinned);
  expect(isPinned(back)).toBe(false);
  expect("pinnedAt" in back || "pinOrder" in back).toBe(false);
  // Served before a move: the place this device has.
  expect(keepPin(pin("r1", -1), pinned).pinOrder).toBe(-1);
  // The rest is the history's (a new name, say); a chat this device didn't have comes as it is.
  expect(keepPin(pinned, { ...plain, name: "Renamed" })).toMatchObject({ name: "Renamed", pinnedAt: AT, pinOrder: 2 });
  expect(keepPin(undefined, pinned)).toBe(pinned);
  expect(keepPin(pinned, pinned)).toBe(pinned);
});

/** A machine's store on a fake hub: its state and its chat's history are whatever `hub` says when they're asked for. */
async function fakeHub(hub: { room: Room }) {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/" });
  replace("navigator", { userAgent: "test" });
  const held: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
  replace("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/api/state")) return new Response(JSON.stringify({ hub: { id: "h", name: "Mac" }, device: { id: "d", name: "Phone" }, rooms: [hub.room], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {} }));
    if (u.includes("/history")) {
      // What the hub had when it served it, whenever that arrives.
      const body = JSON.stringify({ room: hub.room, messages: [], turns: [], activities: [], approvals: [], totals: null, hasMore: false, tasks: {} });
      if (!held.hold) return new Response(body);
      return new Promise<Response>((res) => (held.release = () => res(new Response(body))));
    }
    return new Response("{}");
  });
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, { toast() {}, openRoomId: () => "r1", roomGone() {}, signedOut() {}, approval() {}, ptyData() {} });
  await store.getState().start();
  const socket = Socket.instances[0];
  socket.open();
  for (let i = 0; i < 50 && !store.getState().roomData.r1?.loaded; i++) await Bun.sleep(5);
  expect(store.getState().roomData.r1?.loaded).toBe(true);
  /** Loads the chat's history again, held until `release`: served now, arriving later. */
  const heldHistory = async () => {
    held.hold = true;
    held.release = null;
    const loading = store.getState().loadHistory("r1");
    for (let i = 0; i < 50 && !held.release; i++) await Bun.sleep(5);
    expect(held.release).not.toBeNull();
    held.hold = false;
    return { arrive: async () => (held.release!(), await loading) };
  };
  return { store, socket, heldHistory };
}

test("a history answer served before a pin doesn't unpin the chat, nor one served before an unpin pin it again", async () => {
  const hub = { room: room("r1") };
  const { store, socket, heldHistory } = await fakeHub(hub);
  try {
    expect(isPinned(store.getState().rooms.r1)).toBe(false);
    // The history is served, then the chat is pinned (on any device): its room event comes first.
    let history = await heldHistory();
    hub.room = pin("r1", 0);
    socket.message({ t: "room", room: hub.room });
    expect(store.getState().rooms.r1.pinOrder).toBe(0);
    await history.arrive();
    expect(store.getState().rooms.r1).toMatchObject({ pinnedAt: AT, pinOrder: 0 });
    // And the other way: served pinned, then unpinned.
    history = await heldHistory();
    hub.room = room("r1");
    socket.message({ t: "room", room: hub.room });
    await history.arrive();
    expect(isPinned(store.getState().rooms.r1)).toBe(false);
    // A move too.
    hub.room = pin("r1", 4);
    socket.message({ t: "room", room: hub.room });
    history = await heldHistory();
    hub.room = pin("r1", -1);
    socket.message({ t: "room", room: hub.room });
    await history.arrive();
    expect(store.getState().rooms.r1.pinOrder).toBe(-1);
  } finally {
    store.getState().stop();
  }
});

test("the state after a reconnect takes pins and unpins made while this device wasn't listening", async () => {
  const hub = { room: pin("r1", 3) };
  const { store } = await fakeHub(hub);
  try {
    expect(store.getState().rooms.r1.pinOrder).toBe(3);
    // Unpinned on another device meanwhile.
    hub.room = room("r1");
    await store.getState().refresh({ missed: true });
    expect(isPinned(store.getState().rooms.r1)).toBe(false);
    // Pinned again elsewhere, at the top.
    hub.room = pin("r1", -4, AT + 1000);
    await store.getState().refresh({ missed: true });
    expect(store.getState().rooms.r1).toMatchObject({ pinnedAt: AT + 1000, pinOrder: -4 });
  } finally {
    store.getState().stop();
  }
});

/**
 * The app with one machine, a fake hub at http://hub, through the app's own store (as the chat list and Chat settings
 * use it). The hub takes a pin as it comes, as hub pins.ts does, and its answer waits until `arrive` is called.
 */
async function appWithHub(hub: { room: Room }) {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/", hash: "" });
  replace("navigator", { userAgent: "test" });
  const seen = { states: 0, answer: null as (() => void) | null };
  replace("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/state")) {
      seen.states++;
      return new Response(JSON.stringify({ hub: { id: "h", name: "Mac" }, device: { id: "d", name: "Phone" }, rooms: [hub.room], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {} }));
    }
    if (u.endsWith("/api/rooms/r1/pin") && init?.method === "POST") {
      const b = JSON.parse(String(init.body)) as { pinned: boolean; order: number };
      const { pinnedAt, pinOrder: _order, ...rest } = hub.room;
      hub.room = b.pinned ? { ...rest, pinnedAt: pinnedAt ?? AT, pinOrder: b.order } : rest;
      const body = JSON.stringify(hub.room);
      return new Promise<Response>((res) => (seen.answer = () => res(new Response(body))));
    }
    return new Response("{}");
  });
  // Loaded only now: the app's store listens on the page from the start.
  const { hubStore, useMachines, useStore } = await import("./store");
  const { setPin } = await import("./pins");
  await useStore.getState().addMachine({ baseUrl: "http://hub", token: "t", deviceName: "Phone" });
  const store = hubStore("http://hub")!;
  const socket = Socket.instances[0];
  socket.open();
  // Caught up after connecting (its state once more): nothing else replaces the chat during the test.
  for (let i = 0; i < 100 && (seen.states < 2 || store.getState().syncing); i++) await Bun.sleep(5);
  expect(seen.states).toBe(2);
  const machine = useMachines.getState().list.find((m) => m.key === "http://hub")!;
  return {
    rooms: () => store.getState().rooms,
    /** A change on another device: the hub has it, and says so. */
    elsewhere(r: Room) {
      hub.room = r;
      socket.message({ t: "room", room: r });
    },
    /** The pin's own `room` event, from the hub as it is now. */
    heard: () => socket.message({ t: "room", room: hub.room }),
    /** Pins or unpins the chat from this device: taken by the hub at once, answered when it arrives. */
    async pin(p: { pinned: boolean; order?: number }) {
      seen.answer = null;
      const done = setPin(machine, "r1", p);
      for (let i = 0; i < 100 && !seen.answer; i++) await Bun.sleep(5);
      const answer = seen.answer;
      expect(answer).not.toBeNull();
      return { arrive: async () => (answer!(), await done) };
    },
    stop: () => useStore.getState().removeMachine("http://hub"),
  };
}

test("a pin's answer that comes after newer word on the chat never undoes it", async () => {
  const app = await appWithHub({ room: room("r1") });
  try {
    // Pinned here, then unpinned on another device, both heard before this one's answer: it stays unpinned, though
    // the answer is a pin and the chat has the same pin as before it (none).
    let pinning = await app.pin({ pinned: true, order: -5 });
    app.heard();
    expect(app.rooms().r1.pinOrder).toBe(-5);
    app.elsewhere(room("r1"));
    expect((await pinning.arrive()).pinOrder).toBe(-5);
    expect(isPinned(app.rooms().r1)).toBe(false);

    // With nothing in between, the answer shows the pin at once, before its event.
    pinning = await app.pin({ pinned: true, order: -6 });
    expect(isPinned(app.rooms().r1)).toBe(false);
    await pinning.arrive();
    expect(app.rooms().r1).toMatchObject({ pinnedAt: AT, pinOrder: -6 });
    app.heard();
    expect(app.rooms().r1.pinOrder).toBe(-6);

    // A move here, then one on another device, then this one's answer: the other device's place stays.
    pinning = await app.pin({ pinned: true, order: -8 });
    app.heard();
    app.elsewhere(pin("r1", -9));
    await pinning.arrive();
    expect(app.rooms().r1.pinOrder).toBe(-9);

    // An unpin's answer shows at once too, with no pin fields left.
    pinning = await app.pin({ pinned: false });
    await pinning.arrive();
    expect(isPinned(app.rooms().r1)).toBe(false);
    expect("pinnedAt" in app.rooms().r1 || "pinOrder" in app.rooms().r1).toBe(false);
  } finally {
    app.stop();
  }
});
