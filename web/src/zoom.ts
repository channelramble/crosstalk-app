import { useSyncExternalStore } from "react";

/**
 * Text and page size on this device (Settings → Display): the whole app is drawn larger or smaller with CSS `zoom` on
 * the page, which iOS Safari, home-screen apps and Chromium apply the same way. Phone web apps often can't be
 * pinch-zoomed, so this is how to make everything bigger there.
 *
 * Zoom scales every length, but not the screen: whatever is sized from the screen is divided by it (`--zoom`): the
 * visible height (viewport.ts), the notch and home-indicator insets and the few vw sizes (styles.css).
 */
export const ZOOM_STEPS = [80, 90, 100, 110, 125, 150];

const KEY = "crosstalk.zoom";
/** The page is never laid out narrower than this, so a big size on a small phone still fits. */
export const NARROWEST = 250;

const supported = typeof CSS !== "undefined" && !!CSS.supports?.("zoom", "1");
let chosen = read();
let applied = 100;
// While the size is being changed in Settings (holdLayout): the size the screen's layout stays at, and how wide the
// screen was then.
let held: { zoom: number; width: number } | null = null;
const listeners = new Set<() => void>();

function read(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return ZOOM_STEPS.includes(n) ? n : 100;
  } catch {
    return 100;
  }
}

/**
 * How wide the screen is, in CSS pixels, whether or not it's pinch-zoomed: Safari's innerWidth is the zoomed-in part's
 * width (WebKit bug 174362), and pinching must never change the layout under the fingers.
 */
export function screenWidth(): number {
  const vv = window.visualViewport;
  return vv ? Math.round(vv.width * vv.scale) : window.innerWidth;
}

/** The largest size that fits a screen this wide (100% always does). */
export function largestFitting(width: number): number {
  return Math.max(100, ...ZOOM_STEPS.filter((s) => (width * 100) / s >= NARROWEST));
}

function apply() {
  const next = supported ? Math.min(chosen, largestFitting(screenWidth())) : 100;
  if (next !== applied) {
    applied = next;
    if (next === 100) document.documentElement.style.removeProperty("--zoom");
    else document.documentElement.style.setProperty("--zoom", String(next / 100));
  }
  for (const fn of listeners) fn();
}

/** Applies the size saved on this device. Runs before the first render, so nothing changes size once it's shown. */
export function initZoom() {
  apply();
  // Turning the phone or resizing the window changes what fits.
  window.addEventListener("resize", () => {
    // A fold or a turn moves everything anyway, so there's nothing left under the finger to keep in place: the layout
    // follows the size again (holdLayout).
    const turned = held !== null && screenWidth() !== held.width;
    if (turned) held = null;
    if (turned || Math.min(chosen, largestFitting(screenWidth())) !== applied) apply();
  });
  // Another tab of the app changed it.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    chosen = read();
    apply();
  });
}

/** Changes the size on this device, at once, and keeps it for next time. */
export function setZoom(percent: number) {
  chosen = ZOOM_STEPS.includes(percent) ? percent : 100;
  try {
    if (chosen === 100) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(chosen));
  } catch {
    // kept for this visit only
  }
  apply();
}

/** How much the page is zoomed now: 1.25 for 125%. */
export function zoomFactor(): number {
  return applied / 100;
}

/** Calls `fn` whenever the size changes; returns how to stop. */
export function onZoom(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The size the screen's layout follows (useIsMobile: the chats beside the chat, or in a drawer): the size in use, or
 * while it's being changed in Settings, the one it had then (holdLayout). Calls to onZoom's `fn` tell of changes.
 */
export function layoutZoom(): number {
  return held?.zoom ?? applied;
}

/**
 * Keeps the screen laid out as it is now while the size is changed (Settings → Display: the chats docked beside it
 * coming or going would move the − and + buttons sideways), until the screen gets wider or narrower (a fold, a turn);
 * returns what lets the layout follow the size again. Held already, it stays as it was.
 */
export function holdLayout(): () => void {
  const hold = (held ??= { zoom: applied, width: screenWidth() });
  return () => {
    // Let go already (or the screen changed since): a newer hold isn't this one's to end.
    if (held !== hold) return;
    held = null;
    for (const fn of listeners) fn();
  };
}

/** The size chosen on this device and the size in use (smaller when the screen is too narrow for the chosen one). */
export function useZoom(): { chosen: number; applied: number; supported: boolean } {
  const chosenNow = useSyncExternalStore(onZoom, () => chosen);
  const appliedNow = useSyncExternalStore(onZoom, () => applied);
  return { chosen: chosenNow, applied: appliedNow, supported };
}
