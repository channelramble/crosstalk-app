import { expect, test } from "bun:test";
import type { Room } from "@crosstalk/shared";
import { jargonIn } from "./helpCopy";
import { chatHasMessage, dismissWelcome, nextWelcomeStep, WELCOME_KEY, welcomeDismissed, welcomeShows, welcomeSteps } from "./welcome";

const AT = 1_000_000;
/** A chat nobody has written in yet (the hub makes a room with createdAt equal to updatedAt). */
const chat = (patch: Partial<Room> = {}) => ({ chat: { provider: "claude", origin: "web" }, createdAt: AT, updatedAt: AT, ...patch }) as Room;
const done = (signedIn: boolean, rooms: Room[]) => welcomeSteps({ signedIn, rooms }).map((s) => s.done);

test("a new person has done nothing: all three steps wait", () => {
  expect(done(false, [])).toEqual([false, false, false]);
  expect(welcomeSteps({ signedIn: false, rooms: [] }).map((s) => s.title)).toEqual(["Sign in an agent", "Pick a folder", "Say hello"]);
});

test("step 1 is done once an agent is signed in, whatever else there is", () => {
  expect(done(true, [])).toEqual([true, false, false]);
});

test("step 2 is done once a chat exists, step 3 once something was said in one", () => {
  expect(done(true, [chat()])).toEqual([true, true, false]);
  // A message was sent (the chat changed after it was made), the reply not in yet.
  expect(done(true, [chat({ updatedAt: AT + 5000 })])).toEqual([true, true, true]);
  // A reply has ended.
  expect(done(true, [chat({ updatedAt: AT + 9000, lastReplyAt: AT + 9000 })])).toEqual([true, true, true]);
  // Any one chat is enough, even among empty ones.
  expect(done(true, [chat(), chat({ lastReplyAt: AT + 1 }), chat()])).toEqual([true, true, true]);
});

test("older group rooms are not chats", () => {
  const room = { ...chat({ updatedAt: AT + 5000, lastReplyAt: AT + 5000 }), chat: null } as Room;
  const absent = { createdAt: AT, updatedAt: AT + 5000 } as Room;
  expect(done(true, [room, absent])).toEqual([true, false, false]);
});

test("signed out again with chats kept: only step 1 is left", () => {
  expect(done(false, [chat({ lastReplyAt: AT + 1 })])).toEqual([false, true, true]);
});

test("a chat has a message when a reply ended or it changed after it was made", () => {
  expect(chatHasMessage({ createdAt: AT, updatedAt: AT })).toBe(false);
  expect(chatHasMessage({ createdAt: AT, updatedAt: AT, lastReplyAt: null })).toBe(false);
  expect(chatHasMessage({ createdAt: AT, updatedAt: AT + 1 })).toBe(true);
  expect(chatHasMessage({ createdAt: AT, updatedAt: AT, lastReplyAt: AT })).toBe(true);
});

test("the next step is the first one not done", () => {
  const next = (signedIn: boolean, rooms: Room[]) => nextWelcomeStep(welcomeSteps({ signedIn, rooms }));
  expect(next(false, [])).toBe("signin");
  expect(next(true, [])).toBe("folder");
  expect(next(true, [chat()])).toBe("hello");
  expect(next(false, [chat({ lastReplyAt: AT + 1 })])).toBe("signin");
  expect(next(true, [chat({ lastReplyAt: AT + 1 })])).toBeNull();
});

test("the card shows only when the hub's state is in, it wasn't skipped and something is left to do", () => {
  const todo = welcomeSteps({ signedIn: false, rooms: [] });
  const all = welcomeSteps({ signedIn: true, rooms: [chat({ lastReplyAt: AT + 1 })] });
  expect(welcomeShows({ loaded: true, dismissed: false, steps: todo })).toBe(true);
  // Before the state arrives every step looks undone: a returning person must not see a flash of the card.
  expect(welcomeShows({ loaded: false, dismissed: false, steps: todo })).toBe(false);
  expect(welcomeShows({ loaded: true, dismissed: true, steps: todo })).toBe(false);
  expect(welcomeShows({ loaded: true, dismissed: false, steps: all })).toBe(false);
});

/** What a browser's `localStorage` does, for these tests (they have no DOM). */
function storage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

test("a dismissal is kept per device and read back", () => {
  const s = storage();
  expect(welcomeDismissed(s)).toBe(false);
  dismissWelcome(s);
  expect(s.data.get(WELCOME_KEY)).toBe("1");
  expect(welcomeDismissed(s)).toBe(true);
  // Another device (another storage) starts with the card.
  expect(welcomeDismissed(storage())).toBe(false);
});

test("a browser that refuses storage never breaks the screen", () => {
  const refusing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(welcomeDismissed(refusing)).toBe(false);
  expect(() => dismissWelcome(refusing)).not.toThrow();
  expect(welcomeDismissed(undefined)).toBe(false);
  expect(() => dismissWelcome(undefined)).not.toThrow();
});

test("the steps are plain words, one sentence each", () => {
  for (const s of welcomeSteps({ signedIn: false, rooms: [] })) {
    expect(s.text.match(/[.!?](\s|$)/g)?.length, s.title).toBe(1);
    expect(s.text.length, s.title).toBeLessThanOrEqual(100);
    expect(jargonIn(s.text), s.title).toBeNull();
    expect(jargonIn(s.title), s.title).toBeNull();
  }
});
