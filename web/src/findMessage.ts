// Opening a chat at a message a search found (docs/SPEC-0.4.md section 14, track T8): the target the sidebar sets, and
// paging back through the chat's history until the message is loaded. The chat screen scrolls to it (views/useFindMessage.ts).

import { create } from "zustand";

/** The message a search hit points at. */
export interface Find {
  roomId: string;
  messageId: string;
  /** The words that found it (the chat scrolls to where they show in it). */
  query: string;
  /** When it was set: one the person didn't wait for is dropped. */
  at: number;
}

export const useFind = create<{
  find: Find | null;
  set(f: Find): void;
  /** Done with `f` (a newer target stays). */
  clear(f: Find): void;
}>((set) => ({
  find: null,
  set: (f) => set({ find: f }),
  clear: (f) => set((s) => (s.find === f ? { find: null } : s)),
}));

/** The most history pages one search tap loads (80 messages each) before it stops and offers to go on. */
export const MAX_PAGES = 60;

/** The part of a machine's store this reads. */
export interface History {
  roomData: Record<string, { loaded: boolean; loading: boolean; hasMore: boolean; messages: { id: string }[] } | undefined>;
  loadHistory(roomId: string, older?: boolean): Promise<void>;
}

/**
 * Loads the chat's history, page by page back from the newest, until it has `messageId`: "found", "gone" (the whole
 * history is loaded and it isn't there: it was edited or taken back since), or "failed" (a page didn't load, or it's
 * further back than MAX_PAGES: asking again goes on from there).
 */
export async function loadUntil(roomId: string, messageId: string, store: { getState(): History }, wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))): Promise<"found" | "gone" | "failed"> {
  const data = () => store.getState().roomData[roomId];
  const has = () => !!data()?.messages.some((m) => m.id === messageId);
  // A load already going (the chat opening) is waited for, not started twice; a stuck one (20 seconds) is given up on.
  const idle = async () => {
    for (let i = 0; i < 800 && data()?.loading; i++) await wait(25);
    return !data()?.loading;
  };
  let before = -1;
  let asked = false;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    if (!(await idle())) return "failed";
    if (has()) return "found";
    const d = data();
    const size = d?.messages.length ?? 0;
    if (d?.loaded) {
      if (!d.hasMore) return "gone";
      // The last page brought nothing new: it failed (the chat says why).
      if (size === before) return "failed";
    } else if (asked) {
      // The chat's first load didn't work.
      return "failed";
    }
    before = size;
    asked = true;
    await store.getState().loadHistory(roomId, !!d?.loaded);
  }
  return (await idle()) && has() ? "found" : "failed";
}
