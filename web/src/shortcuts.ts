// Keyboard shortcuts, for a computer (or a tablet with a keyboard): jump to a chat, start one. The chat list answers
// them (ChatSidebar.tsx), wherever it is: docked, hidden, or in its drawer.
//
//   ⌘K / Ctrl+K   Search chats: type, ↓ and ↑ move through the chats, Enter opens one, Esc gives up
//   ⌥N / Alt+N    New chat
//
// Each is said where it acts: in the search field and in the New chat button's tooltip.

import { useEffect } from "react";
import { useSidebar } from "./sidebar";

const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** How each shortcut is written on this device. */
export const SHORTCUT = { search: apple ? "⌘K" : "Ctrl K", create: apple ? "⌥N" : "Alt N" };
/** The same, as a screen reader's `aria-keyshortcuts` wants it. */
export const SHORTCUT_KEYS = { search: apple ? "Meta+K" : "Control+K", create: "Alt+N" };

/** Which shortcut a key press is, if any. Ctrl+K and ⌘K both search on every device (a Mac keyboard on a PC, say). */
export function shortcutOf(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): "search" | "create" | null {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") return "search";
  // By the key's place: with Option held, a Mac types "˜" for N.
  if (e.altKey && !mod && !e.shiftKey && (e.code === "KeyN" || e.key.toLowerCase() === "n")) return "create";
  return null;
}

/**
 * Listens for the shortcuts while the app is up. `docked`: the chats are beside the screen; otherwise they're brought
 * out first: their drawer on a phone-wide screen (`mobile`), the hidden list shown again on a wide one. Not while a
 * sheet or dialog is open (it has the keyboard).
 */
export function useShortcuts({ docked, mobile }: { docked: boolean; mobile: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const what = shortcutOf(e);
      if (!what || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      const side = useSidebar.getState();
      if (!docked) {
        if (mobile) side.setDrawer(true);
        else side.setCollapsed(false);
      }
      side.ask(what);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [docked, mobile]);
}
