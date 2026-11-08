// The chat list's own state (sidebar.ts): the groups folded away are kept on this device, so the list comes back the
// way it was left.
import { expect, test } from "bun:test";
import { FOLDED_KEY } from "./chatList";

/**
 * A fresh sidebar.ts on a stand-in device whose store already holds `kept` (the store is read as the module loads).
 * `broken`: a browser that refuses storage, as private browsing does. `done` puts the real globals back.
 */
async function standIn(load: () => Promise<unknown>, kept: Record<string, string> = {}, broken = false) {
  const stored = new Map(Object.entries(kept));
  const was = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => {
        if (broken) throw new Error("no storage");
        return stored.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (broken) throw new Error("no storage");
        stored.set(k, v);
      },
      removeItem: (k: string) => void stored.delete(k),
    },
  });
  const done = () => {
    if (was) Object.defineProperty(globalThis, "localStorage", was);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
  try {
    const { useSidebar } = (await load()) as typeof import("./sidebar");
    return { useSidebar, stored, done };
  } catch (e) {
    done();
    throw e;
  }
}

test("the groups folded on this device come back, and only the folded ones are kept", async () => {
  const { useSidebar, stored, done } = await standIn(() => import("./sidebar.ts?folded"), { [FOLDED_KEY]: '{"codex":true,"svc:codex:a1":true}' });
  try {
    // Read as the app loads: the list opens folded the way it was left, per group.
    expect(useSidebar.getState().folded).toEqual({ codex: true, "svc:codex:a1": true });
    useSidebar.getState().setFolded("pinned", true);
    expect(useSidebar.getState().folded).toEqual({ codex: true, "svc:codex:a1": true, pinned: true });
    expect(JSON.parse(stored.get(FOLDED_KEY)!)).toEqual({ codex: true, "svc:codex:a1": true, pinned: true });
    // Unfolded: forgotten, not kept as a false.
    useSidebar.getState().setFolded("codex", false);
    expect(useSidebar.getState().folded).toEqual({ "svc:codex:a1": true, pinned: true });
    expect(JSON.parse(stored.get(FOLDED_KEY)!)).toEqual({ "svc:codex:a1": true, pinned: true });
    // Asked to open a group that's already open (an unpin does that, folded or not): nothing changes, nothing written.
    const before = useSidebar.getState().folded;
    const written = stored.get(FOLDED_KEY);
    useSidebar.getState().setFolded("codex", false);
    expect(useSidebar.getState().folded).toBe(before);
    expect(stored.get(FOLDED_KEY)).toBe(written);
    // Nothing else about the list is kept on the device: showing all a group's chats lasts the session.
    useSidebar.getState().setAll("codex", true);
    expect(useSidebar.getState().all).toEqual({ codex: true });
    expect(Object.keys(Object.fromEntries(stored))).toEqual([FOLDED_KEY]);
  } finally {
    done();
  }
});

test("a store that can't be read or written leaves every group open, and folding still works this once", async () => {
  const { useSidebar, done } = await standIn(() => import("./sidebar.ts?no-store"), {}, true);
  try {
    expect(useSidebar.getState().folded).toEqual({});
    useSidebar.getState().setFolded("codex", true);
    expect(useSidebar.getState().folded).toEqual({ codex: true });
  } finally {
    done();
  }
});
