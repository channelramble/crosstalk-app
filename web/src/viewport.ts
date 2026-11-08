import { onZoom, zoomFactor } from "./zoom";

/** What `screenRoom` looks at, in CSS pixels as the screen has them (before the app's zoom and pinch zoom). */
export interface ScreenSize {
  /** The visible part now. */
  width: number;
  height: number;
  /** The page's own height: iOS keeps it as tall as without the keyboard. */
  page: number;
  /** The tallest the visible part has been at this width. */
  tallest: number;
  /** A field to type in has focus. */
  typing: boolean;
  /** The on-screen keyboard makes the page itself shorter, as on Android. */
  shrinks: boolean;
  /** The app's zoom (zoom.ts): 1.25 for 125%. */
  zoom: number;
}

/** At least this much shorter, the visible part has the keyboard under it. */
const KEYBOARD_MIN = 120;
/** Less height than this without the keyboard, in the page's own lengths (a big text size counts): a slimmer header. */
const SHORT_BELOW = 420;
/** With the keyboard up, less than this left above it (the page's own lengths): a slimmer header too. */
const TIGHT_BELOW = 360;
/** With the keyboard up, less than this left above it (the page's own lengths): no controls row under the box. */
const CRAMPED_BELOW = 300;

/**
 * Whether the keyboard is up, and what room the screen leaves (styles.css `keyboard-open`, `short`, `cramped`).
 *
 * The keyboard: iOS keeps the page as tall as it was and only the visible part gets shorter. Where the keyboard makes
 * the page shorter too (Android), it's told by the visible part getting much shorter than it's been at this width while
 * a field has focus; anywhere else that's a window made shorter (a computer's tiling, an iPad's Stage Manager).
 *
 * `short`: little height even without the keyboard (a phone or a folded phone's cover screen held sideways, a short
 * window), or not much left above the keyboard (a phone at 150%, a small phone): a slimmer header. `cramped`: the
 * keyboard up and little left above it (really little, or not much on a screen held sideways): no controls row under
 * the message box. Typing upright on a usual phone, at up to 125%, is neither.
 */
export function screenRoom(s: ScreenSize): { keyboard: boolean; short: boolean; cramped: boolean } {
  const keyboard = s.page - s.height > KEYBOARD_MIN || (s.shrinks && s.typing && s.tallest - s.height > KEYBOARD_MIN);
  // The height without the keyboard: while it's up, the page's own (iOS) or the tallest at this width (Android).
  const resting = keyboard ? Math.max(s.page, s.tallest, s.height) : s.height;
  const above = s.height / s.zoom;
  return {
    keyboard,
    // Little left above the keyboard: the chat needs the header's room more than its model line (the controls row
    // under the box shows the model too).
    short: resting / s.zoom < SHORT_BELOW || (keyboard && above < TIGHT_BELOW),
    // Sideways is the screen's own shape: above the keyboard, a small phone held upright is wider than tall too.
    cramped: keyboard && (above < CRAMPED_BELOW || (s.width > resting && above < SHORT_BELOW)),
  };
}

/**
 * Keeps the app inside the part of the screen the on-screen keyboard leaves visible.
 *
 * iOS Safari and home-screen web apps don't shrink the page when the keyboard opens (they ignore
 * `interactive-widget=resizes-content`), so a full-height layout leaves the composer under the keyboard.
 * The visual viewport does shrink, so the app takes its height and offset from it (`--app-height`,
 * `--app-top`), and `keyboard-open` drops the home-indicator inset the keyboard now covers.
 * Android browsers do shrink the page, so there the keyboard is told by the visible height dropping while a field
 * has focus (screenRoom). With the page zoomed (zoom.ts), lengths are drawn bigger by the zoom, so these screen sizes
 * are divided by it.
 */
export function trackVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let frame = 0;
  // The tallest the visible part has been at this width: the height without a keyboard (a new width starts again).
  let tallest = { width: 0, height: 0 };
  // Where the keyboard makes the page shorter: a touch screen, but not an iPhone's or an iPad's (an iPad says it's a
  // Mac, one with a touch screen), whose keyboard never does.
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const touch = window.matchMedia("(pointer: coarse)");
  /** Whether the keyboard is up and the room left, from what has focus and the visible part's size; says if typing. */
  const measure = (field: Element | null) => {
    const typing = !!field && (field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement || (field instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(field.type)) || (field as HTMLElement).isContentEditable);
    // Pinch-zoomed, the visible part is smaller but no keyboard came up: its unzoomed size is what counts.
    const height = Math.round(vv.height * vv.scale);
    const width = Math.round(vv.width * vv.scale);
    if (width !== tallest.width) tallest = { width, height };
    else if (height > tallest.height) tallest.height = height;
    const room = screenRoom({ width, height, page: root.clientHeight, tallest: tallest.height, typing, shrinks: touch.matches && !apple, zoom: zoomFactor() });
    const was = root.classList.contains("keyboard-open");
    root.classList.toggle("keyboard-open", room.keyboard);
    root.classList.toggle("short", room.short);
    root.classList.toggle("cramped", room.cramped);
    if (room.keyboard !== was) updateSegments();
    return typing;
  };
  const update = () => {
    frame = 0;
    const scale = vv.scale;
    // Pinch-zoomed: sizes from the screen as they are unzoomed, and the page left where it's been zoomed to.
    const pinched = Math.abs(scale - 1) > 0.01;
    // iOS scrolls the page to reveal a focused field; the app already fits above the keyboard, so undo it.
    if (!pinched && window.scrollY) window.scrollTo(0, 0);
    const zoom = zoomFactor();
    const height = Math.round(vv.height * scale);
    const before = parseFloat(root.style.getPropertyValue("--app-height")) || 0;
    root.style.setProperty("--app-height", `${height / zoom}px`);
    if (!pinched) root.style.setProperty("--app-top", `${Math.round(vv.offsetTop) / zoom}px`);
    const field = document.activeElement;
    const typing = measure(field);
    // Smaller now (the keyboard came up, the phone turned): a field being typed in stays in sight in its page.
    if (typing && height / zoom < before - 1 && !(field as HTMLElement).closest(".composer")) requestAnimationFrame(() => (field as HTMLElement).scrollIntoView({ block: "nearest" }));
    updateSegments();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  // A field taking or losing focus: only whether the keyboard is up (and the room it leaves) is looked at again.
  const typingChanged = () => requestAnimationFrame(() => measure(document.activeElement));
  document.addEventListener("focusin", typingChanged);
  document.addEventListener("focusout", typingChanged);
  // A new size takes effect at once, so the page never shows a frame sized for the old one.
  onZoom(update);
  update();
}

/** How a foldable is held: half-folded like a book (parts side by side), like a laptop (one above the other), or not. */
export type Posture = "book" | "tabletop" | null;

let posture: Posture = null;
const postureListeners = new Set<() => void>();

export const currentPosture = () => posture;

/** Calls `fn` whenever the posture changes; returns how to stop. */
export function onPosture(fn: () => void): () => void {
  postureListeners.add(fn);
  return () => {
    postureListeners.delete(fn);
  };
}

/** Below this, the lower part isn't worth the message box (the keyboard covers most of it): the usual layout. */
const TABLETOP_MIN_LOWER = 240;
const SEG_VARS = ["--seg-l-w", "--seg-r-x", "--seg-r-w", "--seg-t-h", "--seg-b-y", "--seg-b-h"];

/**
 * A foldable half-folded (or a two-screen phone): where the two parts of the screen are, and the posture, for
 * styles.css "foldables" (`fold-book` / `fold-tabletop` on the page) and useBookPosture. The browser's
 * `window.viewport.segments` are in CSS pixels whatever its own page zoom (its env(viewport-segment-*) values aren't);
 * like every size from the screen, they're divided by the app's zoom. Like a laptop only while the lower part has room:
 * with the keyboard up (Android browsers shrink the page for it, so the lower part does too) it's the usual layout.
 */
function updateSegments() {
  const root = document.documentElement;
  const segs = (window as unknown as { viewport?: { segments?: DOMRectReadOnly[] | null } }).viewport?.segments;
  const zoom = zoomFactor();
  const px = (v: number) => `${Math.round(v) / zoom}px`;
  let next: Posture = null;
  const vars: Record<string, string> = {};
  if (segs?.length === 2) {
    const [a, b] = segs;
    if (b.x > a.x) {
      next = "book";
      Object.assign(vars, { "--seg-l-w": px(a.width), "--seg-r-x": px(b.x), "--seg-r-w": px(b.width) });
    } else if (b.height / zoom >= TABLETOP_MIN_LOWER && !root.classList.contains("keyboard-open")) {
      next = "tabletop";
      Object.assign(vars, { "--seg-t-h": px(a.height), "--seg-b-y": px(b.y), "--seg-b-h": px(b.height) });
    }
  }
  for (const n of SEG_VARS) {
    if (vars[n]) root.style.setProperty(n, vars[n]);
    else root.style.removeProperty(n);
  }
  root.classList.toggle("fold-book", next === "book");
  root.classList.toggle("fold-tabletop", next === "tabletop");
  if (next !== posture) {
    posture = next;
    for (const fn of postureListeners) fn();
  }
}

/** Keeps the posture up to date as the screen folds, turns or resizes (and the keyboard comes and goes, above). */
export function trackSegments() {
  window.addEventListener("resize", updateSegments);
  for (const q of ["(horizontal-viewport-segments: 2)", "(vertical-viewport-segments: 2)"]) window.matchMedia(q).addEventListener("change", updateSegments);
  onZoom(updateSegments);
  updateSegments();
}
