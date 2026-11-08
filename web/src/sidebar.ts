import { create } from "zustand";
import { FOLDED_KEY, readFolded, writtenFolded } from "./chatList";
import type { NewChatTarget } from "./newChat";

const KEY = "crosstalk.sidebar.collapsed";
/** The drawer's search is kept this long after it closes. */
const QUERY_KEPT_MS = 5 * 60_000;

function saved(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** The groups this device folded last time (a browser that refuses storage starts them all open). */
function savedFolded(): Record<string, boolean> {
  try {
    return readFolded(localStorage.getItem(FOLDED_KEY));
  } catch {
    return {};
  }
}

interface SidebarState {
  collapsed: boolean;
  drawer: boolean;
  /**
   * What the chat list keeps while the drawer is closed (it isn't drawn then): which groups show all their chats (by
   * group key: an agent, a service of yours, or "group"; chatIdentity.ts), the search (for a few minutes) and where the
   * list was scrolled to.
   */
  all: Partial<Record<string, boolean>>;
  /**
   * Which groups are folded away, by the same keys (Pinned is "pinned"): only the folded ones are in it. Kept on this
   * device (chatList.ts FOLDED_KEY), because it's about this screen, not the chats.
   */
  folded: Partial<Record<string, boolean>>;
  query: string;
  scrollTop: number;
  /** When the drawer last closed. */
  closedAt: number;
  /**
   * What a New chat dialog is open for: an agent, a service of yours, a server on this machine to add first, or a group
   * chat (newChat.ts). Kept here, and the dialog drawn by the app around the list, so it stays open (with what's filled
   * in) when the drawer turns into the docked list as a foldable unfolds, and back.
   */
  creating: NewChatTarget | null;
  setCollapsed(v: boolean): void;
  setDrawer(v: boolean): void;
  setAll(key: string, v: boolean): void;
  setFolded(key: string, v: boolean): void;
  setQuery(q: string): void;
  setScrollTop(top: number): void;
  setCreating(target: NewChatTarget | null): void;
}

/** The chat sidebar: docked (and collapsible) on wide screens, a slide-in drawer on phones. */
export const useSidebar = create<SidebarState>((set, get) => ({
  collapsed: saved(),
  drawer: false,
  all: {},
  folded: savedFolded(),
  query: "",
  scrollTop: 0,
  closedAt: 0,
  creating: null,
  setCollapsed(v) {
    set({ collapsed: v });
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      // storage unavailable: the choice lasts until reload
    }
  },
  setDrawer(v) {
    if (v === get().drawer) return;
    if (!v) set({ drawer: false, closedAt: Date.now() });
    // An old search is gone by the next time the drawer opens.
    else set({ drawer: true, ...(get().query && Date.now() - get().closedAt > QUERY_KEPT_MS ? { query: "" } : {}) });
  },
  setAll(key, v) {
    set({ all: { ...get().all, [key]: v } });
  },
  setFolded(key, v) {
    // Already that way: nothing to write (unpinning a chat asks its group to open, folded or not).
    if (!!get().folded[key] === v) return;
    const folded = { ...get().folded, [key]: v };
    if (!v) delete folded[key];
    set({ folded });
    try {
      localStorage.setItem(FOLDED_KEY, writtenFolded(folded));
    } catch {
      // storage unavailable: the choice lasts until reload
    }
  },
  setQuery(q) {
    set({ query: q });
  },
  setScrollTop(top) {
    set({ scrollTop: top });
  },
  setCreating(target) {
    set({ creating: target });
  },
}));
