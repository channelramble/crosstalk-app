import { describe, expect, test } from "bun:test";
import { MAX_PAGES, loadUntil, useFind, type Find, type History } from "./findMessage";

type Room = NonNullable<History["roomData"][string]>;

/** A chat whose history comes in pages of `page` messages from the newest back, like the hub's. */
function chat(total: number, page = 80, over: Partial<Room> = {}) {
  const ids = Array.from({ length: total }, (_, i) => `m${i + 1}`);
  const room: Room = { loaded: false, loading: false, hasMore: false, messages: [], ...over };
  const calls: (boolean | undefined)[] = [];
  const state: History = {
    roomData: { r1: room },
    async loadHistory(_id, older) {
      calls.push(older);
      // The next page back from what's loaded (the newest page when nothing is).
      const from = Math.max(0, total - room.messages.length - page);
      room.messages = ids.slice(from).map((id) => ({ id }));
      room.loaded = true;
      room.hasMore = from > 0;
    },
  };
  return { state, room, calls, store: { getState: () => state } };
}
const now = async () => {};

describe("paging back to a message", () => {
  test("a message in the newest page is there at once, once the chat has loaded", async () => {
    const c = chat(200);
    expect(await loadUntil("r1", "m190", c.store, now)).toBe("found");
    expect(c.calls).toEqual([false]);
  });

  test("an older message loads older pages until it's there, and no further", async () => {
    const c = chat(400);
    expect(await loadUntil("r1", "m150", c.store, now)).toBe("found");
    // Pages of 80 from 400: m321.., m241.., m161.., m81..: the fourth has m150.
    expect(c.calls).toEqual([false, true, true, true]);
    expect(c.room.messages[0].id).toBe("m81");
  });

  test("a chat already loaded isn't loaded again from the start", async () => {
    const c = chat(400);
    await c.state.loadHistory("r1", false);
    c.calls.length = 0;
    expect(await loadUntil("r1", "m100", c.store, now)).toBe("found");
    expect(c.calls.every((older) => older === true)).toBe(true);
  });

  test("a message that isn't in the whole history is gone", async () => {
    const c = chat(100);
    expect(await loadUntil("r1", "m_deleted", c.store, now)).toBe("gone");
    expect(c.room.hasMore).toBe(false);
    expect(c.room.messages).toHaveLength(100);
  });

  test("a page that brings nothing new (it didn't load) fails, instead of asking forever", async () => {
    const c = chat(400);
    c.state.loadHistory = async (_id, older) => {
      c.calls.push(older);
      if (!older) {
        c.room.messages = Array.from({ length: 80 }, (_, i) => ({ id: `m${321 + i}` }));
        c.room.loaded = true;
        c.room.hasMore = true;
      }
    };
    expect(await loadUntil("r1", "m10", c.store, now)).toBe("failed");
    expect(c.calls).toEqual([false, true]);
  });

  test("a load that never ends is given up on", async () => {
    const c = chat(100, 80, { loading: true });
    expect(await loadUntil("r1", "m5", c.store, now)).toBe("failed");
    expect(c.calls).toEqual([]);
  });

  test("a chat whose first load fails is given up after one more try, not asked 60 times", async () => {
    const c = chat(100);
    c.state.loadHistory = async (_id, older) => {
      c.calls.push(older);
    };
    expect(await loadUntil("r1", "m5", c.store, now)).toBe("failed");
    expect(c.calls).toEqual([false]);
  });

  test("further back than the page limit stops, and asking again goes on from there", async () => {
    const total = (MAX_PAGES + 10) * 80;
    const c = chat(total);
    expect(await loadUntil("r1", "m1", c.store, now)).toBe("failed");
    expect(c.calls).toHaveLength(MAX_PAGES);
    expect(await loadUntil("r1", "m1", c.store, now)).toBe("found");
  });

  test("a load that's already going (the chat opening) is waited for, not started twice", async () => {
    const c = chat(100, 80, { loading: true });
    let waits = 0;
    const wait = async () => {
      if (++waits === 3) {
        c.room.loading = false;
        c.room.loaded = true;
        c.room.messages = Array.from({ length: 80 }, (_, i) => ({ id: `m${21 + i}` }));
        c.room.hasMore = true;
      }
    };
    expect(await loadUntil("r1", "m50", c.store, wait)).toBe("found");
    expect(c.calls).toEqual([]);
  });

  test("a chat the app has no data for yet is loaded first", async () => {
    const c = chat(50);
    c.state.roomData.r1 = undefined;
    const real = c.state.loadHistory;
    c.state.loadHistory = async (id, older) => {
      c.state.roomData.r1 = c.room;
      await real(id, older);
    };
    expect(await loadUntil("r1", "m5", c.store, now)).toBe("found");
  });
});

describe("the target", () => {
  const f = (messageId: string): Find => ({ roomId: "r1", messageId, query: "x", at: 1 });
  test("a newer target isn't cleared by finishing the older one", () => {
    const [a, b] = [f("a"), f("b")];
    useFind.getState().set(a);
    useFind.getState().set(b);
    useFind.getState().clear(a);
    expect(useFind.getState().find).toBe(b);
    useFind.getState().clear(b);
    expect(useFind.getState().find).toBeNull();
  });
});
