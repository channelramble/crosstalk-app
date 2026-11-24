import { create } from "zustand";
import { FOLDED_KEY, readFolded, writtenFolded } from "./chatList";
import type { NewChatTarget } from "./newChat";
import { openedOver } from "./back";

const KEY = "crosstalk.sidebar.collapsed";
const WIDTH_KEY = "crosstalk.sidebar.width";
/** How wide the docked chats are unless dragged wider or narrower, and how far the drag goes. */
export const SIDEBAR_WIDTH = 272;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;

/** A width the docked chats can have: whole pixels, within the limits. */
export const sidebarWidth = (px: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number.isFinite(px) ? px : SIDEBAR_WIDTH)));

/** The width this device left the docked chats at (a browser that refuses storage, or never dragged: the usual one). */
function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n > 0 ? sidebarWidth(n) : SIDEBAR_WIDTH;
  } catch {
    return SIDEBAR_WIDTH;
  }
}
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
  /** How wide the docked chats are, in the page's own pixels: dragged at their edge on a computer, kept on this device. */
  width: number;
  /**
   * Asked for from the keyboard (shortcuts.ts): the search to type in, or the New chat menu. A count, so asking twice
   * asks twice; the list answers when it's drawn (the drawer opens first, on a phone).
   */
  asked: { search: number; create: number };
  /** `keep` false while a drag is still going: kept on this device when it ends. */
  setWidth(px: number, keep?: boolean): void;
  ask(what: "search" | "create"): void;
  setCollapsed(v: boolean): void;
  setDrawer(v: boolean): void;
  setAll(key: string, v: boolean): void;
  setFolded(key: string, v: boolean): void;
  setQuery(q: string): void;
  setScrollTop(top: number): void;
  setCreating(target: NewChatTarget | null): void;
}

/** The open drawer's entry in the browser's history (back.ts): how to take it out again once the drawer has closed. */
let drawerClosed: (() => void) | null = null;

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
  width: savedWidth(),
  asked: { search: 0, create: 0 },
  setWidth(px, keep = true) {
    const width = sidebarWidth(px);
    if (width !== get().width) set({ width });
    if (!keep) return;
    try {
      if (width === SIDEBAR_WIDTH) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // storage unavailable: the width lasts until reload
    }
  },
  ask(what) {
    set({ asked: { ...get().asked, [what]: get().asked[what] + 1 } });
  },
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
    if (!v) {
      set({ drawer: false, closedAt: Date.now() });
      drawerClosed?.();
      drawerClosed = null;
      return;
    }
    // An old search is gone by the next time the drawer opens.
    set({ drawer: true, ...(get().query && Date.now() - get().closedAt > QUERY_KEPT_MS ? { query: "" } : {}) });
    // The phone's Back closes it before it leaves the screen.
    drawerClosed = openedOver(() => get().setDrawer(false));
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
