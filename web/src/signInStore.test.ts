// One machine's store and sign-ins (hubStore.ts): the accounts found signed out and the sign-ins started from the phone
// come with the state and live after it, and the app hears of an account newly signed out once, not for every list.
import { afterEach, expect, test } from "bun:test";
import type { ServerEvent, SignInNeed, SignInSession } from "@crosstalk/shared";

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
  event(e: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

const AT = 1_800_000_000_000;
const need = (over: Partial<SignInNeed> = {}): SignInNeed => ({ provider: "claude", account: "default", accountLabel: null, machine: { id: "h", name: "Mac mini" }, since: AT, rooms: ["r1"], words: "Claude Code is signed out on Mac mini…", ...over });
const session = (over: Partial<SignInSession> = {}): SignInSession => ({ id: "si_1", provider: "claude", account: "default", accountLabel: null, machine: { id: "h", name: "Mac mini" }, method: "paste", state: "open", url: "https://claude.com/cai/oauth/authorize?state=s", userCode: null, wantsCode: true, codesSent: 0, codeRefused: false, words: "Open the sign-in link…", startedAt: AT, expiresAt: AT + 600_000, endedAt: null, ...over });

/** A machine whose state answers at once: `extra` is what this hub's state adds (an older hub's has no sign-ins). */
function hub(extra: Record<string, unknown>) {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/" });
  replace("navigator", { userAgent: "test" });
  const snapshot = { hub: { id: "h", name: "Mac mini" }, device: { id: "d", name: "Phone" }, rooms: [], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {}, ...extra };
  replace("fetch", async (url: string) => new Response(JSON.stringify(String(url).includes("/api/state") ? snapshot : {})));
}

async function started(extra: Record<string, unknown>) {
  hub(extra);
  const heard: SignInNeed[] = [];
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, { toast() {}, openRoomId: () => null, roomGone() {}, signedOut() {}, approval() {}, ptyData() {}, signInNeeded: (n) => heard.push(n) });
  const going = store.getState().start();
  Socket.instances[0].open();
  await going;
  return { store, heard, socket: Socket.instances[0] };
}

test("the state brings the signed-out accounts and this device's sign-ins; live updates keep them current", async () => {
  const known = need();
  const { store, heard, socket } = await started({ signIns: [known], signInSessions: [session()] });
  try {
    expect(store.getState().signIns).toEqual([known]);
    expect(store.getState().signInSessions).toEqual({ si_1: session() });
    // What the state brought isn't news: the chat's card says it.
    expect(heard).toEqual([]);
    // The sign-in moves on.
    socket.event({ t: "signin.session", session: session({ state: "checking", wantsCode: false, codesSent: 1 }) });
    expect(store.getState().signInSessions.si_1.state).toBe("checking");
    socket.event({ t: "signin.session", session: session({ id: "si_2", provider: "codex", method: "device", userCode: "ABCD-EFGH" }) });
    expect(Object.keys(store.getState().signInSessions).sort()).toEqual(["si_1", "si_2"]);
    // Another chat stopped on the same account: the same need, not news.
    socket.event({ t: "signin.needs", needs: [{ ...known, rooms: ["r1", "r2"] }] });
    expect(heard).toEqual([]);
    // Another account signed out: news, once.
    const work = need({ account: "a_work", accountLabel: "Work" });
    socket.event({ t: "signin.needs", needs: [{ ...known, rooms: ["r1", "r2"] }, work] });
    socket.event({ t: "signin.needs", needs: [{ ...known, rooms: ["r1", "r2"] }, work] });
    expect(heard).toEqual([work]);
    // Signed in again: gone from the list.
    socket.event({ t: "signin.needs", needs: [work] });
    expect(store.getState().signIns).toEqual([work]);
  } finally {
    store.getState().stop();
  }
});

test("a hub that can't sign agents in from the phone says nothing about it: null, not an empty list", async () => {
  const { store, heard, socket } = await started({});
  try {
    expect(store.getState().signIns).toBeNull();
    expect(store.getState().signInSessions).toEqual({});
    // Nor is a list that turns up later (the hub updated meanwhile) taken for news: there was nothing to compare with.
    socket.event({ t: "signin.needs", needs: [need()] });
    expect(store.getState().signIns).toEqual([need()]);
    expect(heard).toEqual([]);
  } finally {
    store.getState().stop();
  }
});
