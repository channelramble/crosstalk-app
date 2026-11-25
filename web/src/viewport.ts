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
  // What the visible part said when the app was last sized to it.
  let sized = { height: -1, top: -1, scale: -1 };
  const said = () => ({ height: Math.round(vv.height * vv.scale), top: Math.round(vv.offsetTop), scale: Math.round(vv.scale * 100) });
  const update = () => {
    frame = 0;
    sized = said();
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
  // One look per frame, and one all the same when no frame comes (a page that isn't being drawn: a phone switching
  // from its cover screen to its inner one).
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    update();
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(run);
    fallback = setTimeout(run, 250);
  };
  // Some browsers settle the visible part a moment after the size changed (their own bars moving out of the way, a
  // screen switching), with no word of it: looked at again shortly after, so no size is ever left as it was.
  let again: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    schedule();
    clearTimeout(again);
    again = setTimeout(schedule, 400);
  };
  vv.addEventListener("resize", changed);
  vv.addEventListener("scroll", schedule);
  // The window's own word of a new size, a turn, and coming back to the front: the visible part doesn't always say
  // so itself when a foldable changes screens.
  window.addEventListener("resize", changed);
  window.addEventListener("orientationchange", changed);
  window.addEventListener("pageshow", changed);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") changed();
  });
  // And the page's own box: whatever changed it, the app is sized to it again.
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(root);
  // A phone doesn't always say when its keyboard changed the visible part: an iPhone's keyboard brought back by a tap
  // on a field that already had the focus, the app coming back to the front with a field in it, a keyboard that
  // settles after the last word of it. The message box was then left under the keyboard. So the visible part is also
  // read, without being told, around every moment a keyboard could have moved (a field taking or losing the focus, a
  // touch while one has it, a letter typed), and now and then for as long as a field has the focus. Reading it costs
  // nothing; the app is sized again only when it says something new.
  const peek = () => {
    const now = said();
    if (now.height !== sized.height || now.top !== sized.top || now.scale !== sized.scale) schedule();
  };
  const PEEKS = [60, 180, 350, 600, 1000, 1600];
  let peeks: ReturnType<typeof setTimeout>[] = [];
  const soon = () => {
    peeks.forEach(clearTimeout);
    peeks = PEEKS.map((ms) => setTimeout(peek, ms));
  };
  const typingIn = (el: Element | null) => !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(el.type)) || (el as HTMLElement).isContentEditable);
  let watch: ReturnType<typeof setInterval> | undefined;
  const watching = () => {
    const on = touch.matches && typingIn(document.activeElement);
    if (on && !watch) watch = setInterval(peek, 700);
    if (!on && watch) {
      clearInterval(watch);
      watch = undefined;
    }
  };
  // A field taking or losing focus: whether the keyboard is up (and the room it leaves) is looked at again.
  const typingChanged = () => {
    requestAnimationFrame(() => measure(document.activeElement));
    soon();
    watching();
  };
  document.addEventListener("focusin", typingChanged);
  document.addEventListener("focusout", typingChanged);
  const touched = () => {
    if (typingIn(document.activeElement)) soon();
  };
  document.addEventListener("touchend", touched, { passive: true });
  document.addEventListener("beforeinput", peek);
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
/** Narrower than this, a part can't hold the chats or a chat (a fold at the window's edge): the usual layout. */
const BOOK_MIN_PART = 240;
/**
 * A fold counts as half-folded once it has stayed so this long. A phone being opened or closed passes through
 * half-open on its way (Chrome on Android reports it for the whole swing), and laying the app out in halves for that
 * moment cuts the screen in two just as it unfolds: only a phone set down or held half-folded gets those layouts.
 */
export const POSTURE_STEADY_MS = 1000;

/**
 * The layouts in two parts are this device's choice, and off until it's made (Settings → This device, offered only on a
 * device that has reported a fold). Laid out in halves by itself, a foldable looked broken to the people using one: some
 * report the fold as half-open whenever it isn't perfectly flat, so the chat sat on half the screen for good.
 */
export const FOLD_PARTS_KEY = "crosstalk.fold.parts.v1";
/** Kept once this device has reported a fold, so the choice shows only where it means something. */
export const FOLD_SEEN_KEY = "crosstalk.fold.seen.v1";
const kept = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
export const foldParts = () => kept(FOLD_PARTS_KEY);
export const foldKnown = () => kept(FOLD_SEEN_KEY);
/** Turns the two-part layouts on or off for this device; a phone held half-folded right now follows at once. */
export function setFoldParts(on: boolean) {
  try {
    if (on) localStorage.setItem(FOLD_PARTS_KEY, "1");
    else localStorage.removeItem(FOLD_PARTS_KEY);
  } catch {
    // storage unavailable: it stays as it is
  }
  if (fold) foldSince = -Infinity;
  if (typeof document !== "undefined") updateSegments();
}
const SEG_VARS = ["--seg-l-w", "--seg-r-x", "--seg-r-w", "--seg-t-h", "--seg-b-y", "--seg-b-h"];

/** What the browser says of the fold right now: which way the two parts lie, or none. */
let fold: "book" | "tabletop" | null = null;
/** Since when it has said so (performance.now()); -Infinity for how the page started: nothing was passing through. */
let foldSince = -Infinity;
let foldSeen = false;
let steady: ReturnType<typeof setTimeout> | undefined;

/**
 * Which way two parts of the screen lie, if each has room: side by side ("book") or one above the other ("tabletop").
 * Anything else (one part, a part with no room, parts that don't fit the window any more) is a flat screen.
 */
export function foldOf(segs: ArrayLike<{ x: number; y: number; width: number; height: number }> | null | undefined, zoom: number, screen: { width: number; height: number }): "book" | "tabletop" | null {
  if (segs?.length !== 2) return null;
  const [a, b] = [segs[0], segs[1]];
  // Parts of another screen than this one (the size changed and the fold's word of it hasn't come yet).
  if (b.x + b.width > screen.width + 1 || b.y + b.height > screen.height + 1) return null;
  if (b.x > a.x) return Math.min(a.width, b.width) / zoom >= BOOK_MIN_PART ? "book" : null;
  if (b.y > a.y) return a.height > 0 && b.height > 0 ? "tabletop" : null;
  return null;
}

/**
 * A foldable half-folded (or a two-screen phone): where the two parts of the screen are, and the posture, for
 * styles.css "foldables" (`fold-book` / `fold-tabletop` on the page) and useBookPosture. The browser's
 * `window.viewport.segments` are in CSS pixels whatever its own page zoom (its env(viewport-segment-*) values aren't);
 * like every size from the screen, they're divided by the app's zoom. Like a laptop only while the lower part has room:
 * with the keyboard up (Android browsers shrink the page for it, so the lower part does too) it's the usual layout.
 * Only a fold that has stayed half-folded (POSTURE_STEADY_MS) lays the app out in parts; flat again, it's the usual
 * layout at once.
 */
function updateSegments() {
  const root = document.documentElement;
  const segs = (window as unknown as { viewport?: { segments?: DOMRectReadOnly[] | null } }).viewport?.segments;
  const zoom = zoomFactor();
  const px = (v: number) => `${Math.round(v) / zoom}px`;
  const now = performance.now();
  const seen = foldOf(segs, zoom, { width: window.innerWidth, height: window.innerHeight });
  if (seen && !foldKnown()) {
    try {
      localStorage.setItem(FOLD_SEEN_KEY, "1");
    } catch {
      // storage unavailable: Settings just doesn't offer the choice
    }
  }
  if (seen !== fold || !foldSeen) {
    // How the page starts is how the phone is being held; a fold that comes later has to stay.
    foldSince = foldSeen ? now : -Infinity;
    fold = seen;
    foldSeen = true;
    clearTimeout(steady);
    if (fold && foldSince > 0) steady = setTimeout(updateSegments, POSTURE_STEADY_MS + 20);
  }
  let next: Posture = null;
  const vars: Record<string, string> = {};
  if (fold && segs && foldParts() && now - foldSince >= POSTURE_STEADY_MS) {
    const [a, b] = segs;
    if (fold === "book") {
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
  window.visualViewport?.addEventListener("resize", updateSegments);
  for (const q of ["(horizontal-viewport-segments: 2)", "(vertical-viewport-segments: 2)", "(device-posture: folded)"]) window.matchMedia(q).addEventListener("change", updateSegments);
  // Back at the front (the fold may have changed while the page wasn't drawn, and nothing said so).
  window.addEventListener("pageshow", updateSegments);
  document.addEventListener("visibilitychange", updateSegments);
  onZoom(updateSegments);
  updateSegments();
}
