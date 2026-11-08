import { Component, createContext, createElement, createRef, useContext, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { layoutZoom, zoomFactor } from "./zoom";

/*
 * Motion: what the app's animations need from script. How things move is plain CSS in styles/motion.css (every
 * duration and curve, every keyframe, and the one Reduce Motion policy); this file does only what CSS can't.
 *
 * - Nothing waits for an animation. What opens is live and tappable from its first frame. What closes is gone from
 *   React, the focus, the accessibility tree and the tests the moment it closes, and an inert copy plays its way out
 *   (`leave`). Never keep a real element mounted for its exit, and never hold state until animationend.
 * - Reduce Motion (`reduced()`, asked each time, so turning it on applies at once): no copies, no list movement, and a
 *   smooth scroll asked for anywhere is a jump (`initMotion`). CSS swaps movement for a short fade.
 *
 * Hooks for the screens
 * - `leave(el, kind, { part, unless, only })`: in a layout effect's cleanup, which runs while the element is still on
 *   the page: `useLayoutEffect(() => () => leave(ref.current, "menu"), [])`. Once React has removed it, a copy goes in
 *   its place: in a closed shadow root (no selector, text search or test locator finds it), `inert` and `aria-hidden`,
 *   and `[data-ghost="<kind>"]` in motion.css plays its exit, from where the element was drawn and as faint as it was.
 *   `part` is the piece that moves (a sheet's `.dialog` inside its overlay); `unless` is asked after React is done (the
 *   drawer the layout just docked); `only` is a list in it that scrolls, of which only what shows is copied. An element
 *   in the page's flow is lifted out of it (absolute, where it was), so nothing around it waits for the copy either.
 * - `FlipGroup`: a list whose rows (`data-flip={key}`) glide to new places when `order` (the keys in order, one per
 *   line) changes. `enter` fades new rows in; `exit` gives the rows that went a copy of that kind.
 * - `useEntrance()`: "m-enter" for a part that appears on a screen that's already up (a card, a status line), "" for
 *   one drawn with its screen. Each screen (App.tsx) and each dialog (ui.tsx) is an `EntranceScope`.
 * - `fadeIn(els)`: a 150 ms fade for words swapped in place (a dialog's next step).
 * - `token("--dur-fade")`, `ms("--dur-fade")`: motion.css's tokens, for animations started from here.
 * - `ghosts()`: the copies playing their exits right now (tests, and looking into a stutter).
 */

const reduceQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

/** Whether Reduce Motion is on, right now. */
export const reduced = (): boolean => !!reduceQuery?.matches;

/** A motion token from motion.css, as written there ("150ms", "cubic-bezier(…)"); "" before there's a page. */
export function token(name: string): string {
  return typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A duration token in milliseconds. */
export const ms = (name: string): number => toMs(token(name));

/** "150ms" or "0.15s" in milliseconds; 0 for anything else. */
export function toMs(time: string): number {
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(time.trim());
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : 0;
}

/** Runs once, as the app starts (main.tsx). */
export function initMotion(): void {
  // Chromium runs linear() off the main thread, released Safari doesn't (WebKit bug 312407): the exact springs where
  // they're smooth, the cubic-bezier fits elsewhere.
  if (!navigator.vendor?.startsWith("Apple")) document.documentElement.dataset.springs = "exact";
  // Reduce Motion: a smooth scroll asked for anywhere in the app is a jump.
  const scroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    if (arg === undefined) return scroll.call(this);
    return scroll.call(this, reduced() && typeof arg === "object" && arg?.behavior === "smooth" ? { ...arg, behavior: "auto" } : arg);
  };
  // The copies' stylesheet, built while nothing else is going on rather than at the first exit.
  setTimeout(() => void (canCopy() && appSheet()), 1500);
}

// ------------------------------------------------------------------------------------------------ exits

/** What leaves: each kind has its exit in motion.css (`[data-ghost="<kind>"]`). */
export type GhostKind = "sheet" | "drawer" | "scrim" | "toast" | "jump" | "menu" | "row";

type Box = { top: number; left: number; width: number; height: number };
type Leaving = {
  el: HTMLElement;
  parent: Element;
  next: Node | null;
  kind: GhostKind;
  copy: HTMLElement;
  unless?: () => boolean;
  /** The moving piece's selector, its box when it's frozen in place, and how far its entrance still had to go (%). */
  part?: string;
  frozen: Box | null;
  from: [number, number] | null;
  /** How opaque it, its ::before and the moving piece were (an entrance fading in): the exit starts there. */
  opacity: { el: number; before: number; part: number };
  /** Where the element itself sat, when it's lifted out of the page's flow. */
  lifted: Box | null;
  /** What was scrolled in it: the copy's element (found by where it sits) and how far. */
  scrolls: [Element, number, number][];
};

/** More elements than this aren't worth copying (a huge list): it simply goes. */
const MOST_ELEMENTS = 2500;
let queue: Leaving[] = [];
const playing = new Set<HTMLElement>();

/** The copies playing their way out right now. */
export const ghosts = (): HTMLElement[] => [...playing];

const canCopy = () =>
  typeof document !== "undefined" && typeof ShadowRoot !== "undefined" && "adoptedStyleSheets" in ShadowRoot.prototype && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype;

const boxOf = (e: HTMLElement): Box => ({ top: e.offsetTop, left: e.offsetLeft, width: e.offsetWidth, height: e.offsetHeight });

type LeaveOptions = {
  /** The piece that moves (a sheet's `.dialog` inside its overlay). */
  part?: string;
  /** Asked once React is done: true, and there's no exit after all (the drawer the layout just docked). */
  unless?: () => boolean;
  /**
   * A list inside it that scrolls (the drawer's `.csb-scroll`): only what shows of it is copied, the rest of it an empty
   * box of the same size, so a list of hundreds costs what a screenful does, and still leaves.
   */
  only?: string;
};

/**
 * `el` is closing: React removes it in this commit, and its copy plays the exit (see the top of this file). Call it
 * from a layout effect's cleanup. Under Reduce Motion, or for something that can't be copied faithfully (a canvas, a
 * video, thousands of elements), nothing is drawn and it just goes.
 */
export function leave(el: Element | null | undefined, kind: GhostKind, opts: LeaveOptions = {}): void {
  if (!(el instanceof HTMLElement) || !el.isConnected || !el.parentElement || reduced() || !canCopy()) return;
  if (el.querySelector("canvas, video, iframe, object, embed")) return;
  const list = opts.only ? el.querySelector<HTMLElement>(opts.only) : null;
  if (!list && el.getElementsByTagName("*").length > MOST_ELEMENTS) return;
  // An exit is a nicety: it never gets in the way of closing (this runs inside React's commit).
  try {
    copyOf(el, kind, opts, list);
  } catch {
    // it just goes
  }
}

/** Where `node` sits under `root`: the index among its parent's elements, at each level down. */
function pathTo(root: Element, node: Element): number[] {
  const path: number[] = [];
  for (let n = node; n !== root && n.parentElement; n = n.parentElement) path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
  return path;
}
const at = (root: Element, path: number[]): Element | null => path.reduce<Element | null>((n, i) => n?.children[i] ?? null, root);

/**
 * A copy of `el` in which, inside `list`, what's out of the list's sight is an empty box of the same size (itself, with
 * nothing in it): every element keeps its place among its parent's, so what sits where is found the same way in both.
 */
function copyShowing(el: HTMLElement, list: HTMLElement): HTMLElement {
  const band = list.getBoundingClientRect();
  const copy = (node: Element): Element => {
    if (node !== list && !node.contains(list) && !list.contains(node)) return node.cloneNode(true) as Element;
    const own = node.cloneNode(false) as Element;
    const inList = node === list || list.contains(node);
    for (const child of Array.from(node.childNodes)) {
      if (!(child instanceof HTMLElement) || !inList) {
        own.appendChild(child instanceof Element ? copy(child) : child.cloneNode(true));
        continue;
      }
      const r = child.getBoundingClientRect();
      if (!r.width && !r.height) own.appendChild(copy(child)); // no box of its own (display: contents): what's in it decides
      else if (r.bottom <= band.top || r.top >= band.bottom) own.appendChild(emptied(child));
      else if (r.top >= band.top && r.bottom <= band.bottom) own.appendChild(child.cloneNode(true));
      else own.appendChild(copy(child)); // across the list's edge: some of what's in it shows
    }
    return own;
  };
  return copy(el) as HTMLElement;
}

/** `e` with nothing in it, the size it was (its classes keep its margins). */
function emptied(e: HTMLElement): HTMLElement {
  const box = e.cloneNode(false) as HTMLElement;
  Object.assign(box.style, { height: `${e.offsetHeight}px`, minHeight: "0", boxSizing: "border-box", overflow: "hidden" });
  return box;
}

function copyOf(el: HTMLElement, kind: GhostKind, opts: LeaveOptions, list: HTMLElement | null) {
  // Measured now, while it's still laid out.
  const part = (opts.part && el.querySelector<HTMLElement>(opts.part)) || el;
  const style = getComputedStyle(el);
  const copy = list ? copyShowing(el, list) : (el.cloneNode(true) as HTMLElement);
  if (list && copy.getElementsByTagName("*").length > MOST_ELEMENTS) return;
  // What was scrolled, and what was typed or ticked (it lives on the elements, not in their attributes), found in the
  // copy by where it sits (in a list's empty boxes it isn't: it didn't show).
  const scrolls: [Element, number, number][] = [];
  for (const n of Array.from(el.querySelectorAll("*"))) {
    if (!n.scrollTop && !n.scrollLeft) continue;
    const there = at(copy, pathTo(el, n));
    if (there) scrolls.push([there, n.scrollTop, n.scrollLeft]);
  }
  for (const f of Array.from(el.querySelectorAll<HTMLInputElement>("input, textarea, select"))) {
    const there = at(copy, pathTo(el, f)) as HTMLInputElement | null;
    try {
      if (there) {
        there.value = f.value;
        there.checked = f.checked;
      }
    } catch {
      // a file input keeps its own
    }
  }
  // As drawn this moment, before `entranceLeft` looks at where its entrance ends.
  const opacity = { el: Number(style.opacity), before: Number(getComputedStyle(el, "::before").opacity), part: part === el ? Number(style.opacity) : Number(getComputedStyle(part).opacity) };
  queue.push({
    el,
    parent: el.parentElement!,
    next: el.nextSibling,
    kind,
    copy,
    unless: opts.unless,
    part: part === el ? undefined : opts.part,
    frozen: part === el ? null : boxOf(part),
    from: entranceLeft(part),
    opacity,
    lifted: style.position === "static" || style.position === "relative" ? boxOf(el) : null,
    scrolls,
  });
  if (queue.length === 1) queueMicrotask(place);
}

/** How far `t`'s entrance still had to go, in % of its own width and height; null when it wasn't moving in. */
function entranceLeft(t: HTMLElement): [number, number] | null {
  const moving = t.getAnimations().filter((a) => a.playState === "running" && a.currentTime !== null && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
  if (!moving.length) return null;
  const now = t.getBoundingClientRect();
  const times = moving.map((a) => a.currentTime);
  // Where it comes to rest: the entrance played to its end, measured, and put back as it was (StrictMode's rehearsal
  // calls this on something that stays).
  let rest: DOMRect;
  try {
    moving.forEach((a) => a.finish());
    rest = t.getBoundingClientRect();
  } finally {
    moving.forEach((a, i) => {
      try {
        a.currentTime = times[i];
        a.play();
      } catch {
        // left at its end
      }
    });
  }
  if (!rest.width || !rest.height) return null;
  const x = ((now.left - rest.left) / rest.width) * 100;
  const y = ((now.top - rest.top) / rest.height) * 100;
  return Math.abs(x) < 0.1 && Math.abs(y) < 0.1 ? null : [x, y];
}

/** After React's commit: a copy for each element that really went. */
function place() {
  const batch = queue;
  queue = [];
  const sheet = batch.some((b) => b.kind === "sheet" && !b.el.isConnected);
  for (const b of batch) {
    try {
      placeOne(b, sheet);
    } catch {
      // no exit for this one
    }
  }
}

function placeOne(b: Leaving, withSheet: boolean) {
  // Still on the page (StrictMode trying the effects out), or its whole screen went with it.
  if (b.el.isConnected || !b.parent.isConnected || b.unless?.()) return;
  const styles = appSheet();
  if (!styles) return;
  const { copy } = b;
  copy.dataset.ghost = b.kind;
  // The drawer closing with a sheet (New chat): only the sheet moves, the drawer fades.
  if (withSheet && b.kind === "drawer") copy.dataset.quiet = "";
  const pin = (e: HTMLElement, box: Box) =>
    Object.assign(e.style, { position: "absolute", top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px`, margin: "0", boxSizing: "border-box" });
  if (b.lifted) pin(copy, b.lifted);
  const part = b.part ? copy.querySelector<HTMLElement>(b.part) : copy;
  if (part && b.frozen) pin(part, b.frozen);
  if (part && b.from) {
    part.style.setProperty("--m-from-x", `${b.from[0]}%`);
    part.style.setProperty("--m-from-y", `${b.from[1]}%`);
  }
  // Closed while it was still fading in: its exit starts as faint as it was, rather than brightening first. The moving
  // piece always says its own (it would inherit the copy's otherwise).
  const opacity = (o: number) => String(Number.isFinite(o) ? Math.round(o * 1000) / 1000 : 1);
  if (b.opacity.el < 0.999) copy.style.setProperty("--m-from-o", opacity(b.opacity.el));
  if (b.opacity.before < 0.999) copy.style.setProperty("--m-from-o-before", opacity(b.opacity.before));
  if (part && part !== copy) part.style.setProperty("--m-from-o", opacity(b.opacity.part));
  // The host: no box of its own, inert and hidden from screen readers; the copy lives in its closed shadow root.
  const host = document.createElement("div");
  host.dataset.ghost = b.kind;
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.style.cssText = "display: contents; pointer-events: none";
  const root = host.attachShadow({ mode: "closed" });
  root.adoptedStyleSheets = [styles];
  // The copy's ancestors as boxless stand-ins, so rules like `.app.mobile .dialog` still reach it in there.
  let into: Node = root;
  for (const a of ancestry(b.parent)) {
    const stand = document.createElement(a.localName);
    stand.className = a.getAttribute("class") ?? "";
    stand.style.display = "contents";
    into = into.appendChild(stand);
  }
  into.appendChild(copy);
  b.parent.insertBefore(host, b.next?.parentNode === b.parent ? b.next : null);
  for (const [e, top, left] of b.scrolls) e.scrollTo(left, top);
  playing.add(copy);
  const gone = () => {
    playing.delete(copy);
    host.remove();
  };
  const exits = copy.getAnimations({ subtree: true });
  if (!exits.length) return gone();
  void Promise.all(exits.map((a) => a.finished)).then(gone, gone);
  // However it goes, never left on the screen.
  const end = Math.max(...exits.map((a) => Number(a.effect?.getComputedTiming().endTime) || 0));
  setTimeout(gone, Math.min(Number.isFinite(end) ? end : 0, 10_000) + 500);
}

/** From the page's top (under <body>) down to `el`. */
function ancestry(el: Element): Element[] {
  const chain: Element[] = [];
  for (let a: Element | null = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) chain.unshift(a);
  return chain;
}

let built: { from: CSSStyleSheet[]; sheet: CSSStyleSheet } | null = null;

/** The app's styles as one stylesheet every copy's shadow root shares: built once, again only if the styles change. */
function appSheet(): CSSStyleSheet | null {
  const from = Array.from(document.styleSheets);
  if (built && built.from.length === from.length && built.from.every((s, i) => s === from[i])) return built.sheet;
  const text: string[] = [];
  const add = (s: CSSStyleSheet) => {
    let rules: CSSRuleList;
    try {
      rules = s.cssRules;
    } catch {
      return; // another site's stylesheet
    }
    for (const r of Array.from(rules)) {
      if (r instanceof CSSImportRule) {
        if (r.styleSheet) add(r.styleSheet);
      } else text.push(r.cssText);
    }
  };
  for (const s of from) {
    if (s.disabled) continue;
    const media = s.media.mediaText;
    if (media && media !== "all") text.push(`@media ${media} {`);
    add(s);
    if (media && media !== "all") text.push("}");
  }
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text.join("\n"));
    built = { from, sheet };
    return sheet;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ lists

type FlipProps = HTMLAttributes<HTMLDivElement> & {
  /** The rows' keys in the order they're drawn, one per line: the rows move only when it changes. */
  order: string;
  /** New rows fade in from a touch smaller. */
  enter?: boolean;
  /** Rows that went leave a copy of this kind (at most 6). */
  exit?: GhostKind;
};

/**
 * A list whose rows glide to their new places (FLIP: where each row was is read before React changes the page, and
 * each one that moved is drawn there and eased home). Rows are its descendants with `data-flip={key}`; only those on
 * screen move, 24 at most. Never under Reduce Motion, nor while the text size is being changed.
 */
export class FlipGroup extends Component<FlipProps> {
  box = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(prev: FlipProps): Map<string, DOMRect> | null {
    const box = this.box.current;
    if (!box || prev.order === this.props.order || reduced() || layoutZoom() !== Math.round(zoomFactor() * 100) || !box.getClientRects().length) return null;
    const keep = new Set(this.props.order.split("\n"));
    const at = new Map<string, DOMRect>();
    let gone = 0;
    for (const el of Array.from(box.querySelectorAll<HTMLElement>("[data-flip]"))) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const key = el.dataset.flip ?? "";
      at.set(key, r);
      if (this.props.exit && !keep.has(key) && gone++ < 6) leave(el, this.props.exit);
    }
    return at;
  }

  componentDidUpdate(_prev: FlipProps, _state: unknown, at: Map<string, DOMRect> | null) {
    const box = this.box.current;
    if (!at || !box) return;
    const zoom = zoomFactor();
    let moved = 0;
    for (const el of Array.from(box.querySelectorAll<HTMLElement>("[data-flip]"))) {
      if (moved >= 24) break;
      const was = at.get(el.dataset.flip ?? "");
      if (!was) {
        if (this.props.enter) {
          el.animate({ opacity: [0, 1], transform: ["scale(0.98)", "none"] }, { duration: ms("--dur-enter"), easing: token("--ease-snappy") || "ease" });
          moved++;
        }
        continue;
      }
      const now = el.getBoundingClientRect();
      // Screen pixels to the page's own: the text size (zoom) draws every CSS pixel bigger.
      const dx = (was.left - now.left) / zoom;
      const dy = (was.top - now.top) / zoom;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      el.animate({ transform: [`translate(${dx}px, ${dy}px)`, "translate(0px, 0px)"] }, { duration: ms("--dur-flip"), easing: token("--ease-smooth") || "ease", composite: "add" });
      moved++;
    }
  }

  render() {
    const { order: _order, enter: _enter, exit: _exit, children, ...rest } = this.props;
    return createElement("div", { ...rest, ref: this.box }, children);
  }
}

// ------------------------------------------------------------------------------------------------ entrances

const now = () => (typeof performance === "undefined" ? 0 : performance.now());
/** Parts drawn this soon after their screen are part of it, and come in still. */
export const SETTLE_MS = 350;
/** When the scope's screen was drawn (or last took in a batch): read once by each part as it first draws. */
type Start = { at: number };
const ScreenStart = createContext<Start>({ at: 0 });

/**
 * A screen or a dialog: what's drawn with it comes in still; what appears later can move in (`useEntrance`). `since`:
 * when its screen counts from (`useQuietSince` for a chat), else when the scope was drawn.
 *
 * What it gives the parts under it is one object for its whole life, whose time changes in place: a new `since` never
 * draws any of them again. (It was the number itself, and a chat catching up gave a new one on every redraw, which drew
 * every reply's list of steps again each time, past the memo that keeps a long chat cheap.)
 */
export function EntranceScope({ since, children }: { since?: number; children: ReactNode }) {
  const [start] = useState<Start>(() => ({ at: since ?? now() }));
  if (since !== undefined) start.at = since;
  return createElement(ScreenStart.Provider, { value: start }, children);
}

/** "m-enter" when this part appears on a screen that's already up, "" when it's drawn with its screen. Fixed for life. */
export function useEntrance(): "m-enter" | "" {
  const start = useContext(ScreenStart);
  const [entrance] = useState<"m-enter" | "">(() => (now() - start.at > SETTLE_MS ? "m-enter" : ""));
  return entrance;
}

/**
 * When a chat last took in a batch at once (its history, a catch-up after a reconnect, an older page), for its
 * `EntranceScope`: what's drawn with a batch comes in still, and only what arrives after it can move. While one is on its
 * way (`busy`) that's never (Infinity: nothing drawn meanwhile is new), and once it's in, the moment it went quiet, the
 * same on every redraw after.
 */
export function useQuietSince(busy: boolean): number {
  const quiet = useRef<number | null>(null);
  quiet.current = quietSince(quiet.current, busy, now());
  return quiet.current ?? Infinity;
}

/** `useQuietSince`'s rule: null while busy, else when it went quiet (kept once it is). */
export const quietSince = (was: number | null, busy: boolean, at: number): number | null => (busy ? null : was ?? at);

/** Words swapped in place fade in (a dialog's next step), with or without Reduce Motion: it's a fade of 150 ms. */
export function fadeIn(els: Iterable<Element | null | undefined>): void {
  if (typeof document === "undefined") return;
  const duration = ms("--dur-fade");
  const easing = token("--ease-fade") || "ease";
  for (const el of els) el?.animate({ opacity: [0, 1] }, { duration, easing });
}
