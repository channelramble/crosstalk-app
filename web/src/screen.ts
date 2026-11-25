// The machine's screen, seen and driven from the app (hub/src/screen has the contract). Pure parts here (the web unit
// tests have no DOM): where the live view connects, how a window fills the view, and keys as the screen takes them.

import type { ScreenStatus, ScreenWindow } from "@crosstalk/shared";
import type { Connection } from "./api";

/**
 * The live view's address on a machine: its own WebSocket. This device's sign-in goes beside the connection's name
 * (api.ts socketAuth); only for a machine on a version before 0.11 (`inAddress`) is it in the address, as it was.
 */
export function screenSocketUrl(conn: Pick<Connection, "baseUrl" | "token">, origin: string, inAddress = false): string {
  return `${(conn.baseUrl || origin).replace(/^http/, "ws")}/api/screen/ws${inAddress ? `?token=${encodeURIComponent(conn.token)}` : ""}`;
}

/** How far the view can be zoomed: from the whole screen in the view to twice life size. */
export const MAX_ZOOM = 2;

/** The zoom at which the whole screen is as wide as the view. */
export function fitZoom(viewWidth: number, screenWidth: number): number {
  return screenWidth > 0 && viewWidth > 0 ? viewWidth / screenWidth : 1;
}

/**
 * Where to put the view for a window: zoomed so the window is as wide as the view (never past MAX_ZOOM, never smaller
 * than the whole screen fitted), scrolled to its top left corner.
 */
export function windowPlace(w: Pick<ScreenWindow, "x" | "y" | "width">, viewWidth: number, screenWidth: number): { zoom: number; left: number; top: number } {
  const zoom = Math.max(fitZoom(viewWidth, screenWidth), Math.min(MAX_ZOOM, viewWidth / Math.max(1, w.width)));
  return { zoom, left: Math.max(0, w.x * zoom), top: Math.max(0, w.y * zoom) };
}

/** A window's name on its button: the app, and its title when it has one that says more. */
export function windowLabel(w: Pick<ScreenWindow, "app" | "title">): string {
  const title = w.title.trim();
  return title && title !== w.app ? `${w.app}: ${title.length > 28 ? `${title.slice(0, 27)}…` : title}` : w.app;
}

/** The windows to offer, an agent's first, each app's frontmost first (the list comes front to back). */
export function windowButtons(windows: ScreenWindow[]): ScreenWindow[] {
  return [...windows.filter((w) => w.agent), ...windows.filter((w) => !w.agent)].slice(0, 12);
}

/** What stops the screen being seen, as a heading for the setup card. */
export function screenHeading(s: Pick<ScreenStatus, "state" | "hasPassword" | "account">, machine: string): string {
  if (s.state === "off") return `Turn on screen sharing on ${machine}`;
  // A Mac's own Screen Sharing is signed in to as the Mac's account (its desktop); anything else has a screen sharing password.
  if (s.state === "auth") return s.hasPassword ? "That password didn't work" : s.account ? `Sign in to see ${machine}'s screen` : `Give Crosstalk ${machine}'s screen sharing password`;
  if (s.state === "problem") return "The screen can't be reached";
  return `See ${machine}'s screen`;
}

// Keys, as the screen takes them (X11 keysyms; the same as the hub's screen/keys.ts).
export const KEY = { return: 0xff0d, escape: 0xff1b, tab: 0xff09, backspace: 0xff08, shift: 0xffe1, command: 0xffeb, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, space: 0x20 } as const;
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';

/** The key presses that type `text`: each a keysym, with whether Shift is held for it (as a US keyboard would). */
export function keysFor(text: string): { sym: number; shift: boolean }[] {
  return [...text].map((ch) => {
    if (ch === "\n" || ch === "\r") return { sym: KEY.return, shift: false };
    if (ch === "\t") return { sym: KEY.tab, shift: false };
    const cp = ch.codePointAt(0)!;
    return { sym: cp < 0x100 ? cp : 0x01000000 | cp, shift: (ch.length === 1 && ch >= "A" && ch <= "Z") || SHIFTED.includes(ch) };
  });
}
