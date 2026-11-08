import { Component, createElement, useRef, type HTMLAttributes, type RefObject } from "react";
import { leave, ms, reduced, token } from "../motion";
import { layoutZoom, zoomFactor } from "../zoom";

/*
 * The chat list's motion (ChatSidebar.tsx): when its lines change places they glide there (FLIP: where each line was
 * drawn is read before React changes the page, and each one that moved is drawn there and eased home), new ones fade
 * in where they are (never from smaller: a row is a 44 px target from its first frame), and ones that went leave a copy
 * that fades (motion.ts `leave`). Only what's on screen moves, and at most 24 lines: a list of hundreds costs what a
 * screenful does.
 *
 * - Nothing waits for it. React's page, the focus and the rows' roles are final at once; a row gliding takes a tap
 *   wherever it's drawn. The glide is only ever drawn, after the whole commit (`play`, a microtask): a focus put back on
 *   a pinned row (ChatRow.tsx) has already brought it into view by then, from where it's laid out (`revealInList`).
 * - Never while searching (filtering as you type is instant), while a machine's chats are still coming in, while the
 *   text size is being changed, or under Reduce Motion. The drawer's scroll position, put back as it opens, never
 *   moves either: the list only moves on a change, never when it's drawn.
 * - The scroll position is never animated. A scroll that comes with a change (a row put back in view) is a jump, and
 *   only what was on screen before and after glides.
 *
 * Why not motion.ts `FlipGroup` (the notices use it): the list scrolls, so "on screen" is its own box and not the
 * window, a row coming into view from off screen must fade in rather than spend the budget on rows no one sees, the
 * glide has to wait for the focus move, and its lines are told apart by what they are (`lineKey`) rather than by a
 * `data-flip` on each.
 */

/** The list's lines: a chat's row, a group's heading, "No chats yet.", Show all, what a folded group holds, and the
 *  lines above the groups (a machine down or linked elsewhere, requests waiting). */
export const LINES = ".csb-item, .csb-group-head, .csb-empty, .csb-more, .csb-fold-said, [data-line]";

/** Lines moving at once, at most (a phone shows about 15), and lines leaving with a copy. */
const MOST_MOVING = 24;
const MOST_LEAVING = 6;
/** A row going further than this many of its own heights passes over others: it goes over them, not under. */
const LIFT_ROWS = 1.5;

/**
 * What a line of the list is called, the same in the list's `order` (ChatSidebar.tsx): `r:` a chat's row (its
 * machine/room), `g:` a group's heading, `e:` its "No chats yet.", `a:` its Show all, `s:` what it holds folded (`g`
 * and the rest by the group's key, GroupFold.tsx), and a line's own `data-line` (`m:` a machine down, `l:` one linked
 * elsewhere, `w` requests waiting). `t:` (a row's options open) is in the order only: the row grows, nothing new is
 * drawn as a line. Null for anything else (search results).
 */
export function lineKey(el: Element): string | null {
  const own = (el as HTMLElement).dataset;
  if (own.line) return own.line;
  if (own.pinRow) return `r:${own.pinRow}`;
  const group = el.closest<HTMLElement>("[data-group]")?.dataset.group;
  if (group === undefined) return null;
  if (el.classList.contains("csb-group-head")) return `g:${group}`;
  if (el.classList.contains("csb-empty")) return `e:${group}`;
  if (el.classList.contains("csb-more")) return `a:${group}`;
  if (el.classList.contains("csb-fold-said")) return `s:${group}`;
  return null;
}

/** Where a line was drawn, in screen pixels. */
export interface Seen {
  x: number;
  y: number;
}

/** A line now: where it's drawn (screen pixels), how tall it is, and whether any of it is in the list's box. */
export interface Now {
  x: number;
  y: number;
  height: number;
  on: boolean;
  row: boolean;
}

/** What one line does: glide from where it was (in the page's own pixels), fade in where it is, or nothing. */
export type Move = { glide: [number, number]; lift: boolean } | "enter" | null;

/**
 * What a line does after a change. `was`: where it was drawn, if it was on screen. `view`: the list's height, and
 * `zoom` the text size (screen pixels are the page's own times it).
 */
export function moveOf(was: Seen | undefined, now: Now, view: number, zoom: number): Move {
  // New, or come into view from off screen: it fades in where it is. Off screen either way: nothing to draw.
  if (!was) return now.on ? "enter" : null;
  const dx = (was.x - now.x) / zoom;
  const dy = (was.y - now.y) / zoom;
  if (Math.abs(dx) + Math.abs(dy) < 1) return null;
  // Gone far out of view (the list jumped to a row put back in view): it just goes.
  if (!now.on && Math.abs(dy) * zoom > view) return null;
  return { glide: [dx, dy], lift: now.row && Math.abs(dy) * zoom > LIFT_ROWS * now.height };
}

type Props = HTMLAttributes<HTMLElement> & {
  /** Every line of the list, in order (`lineKey`, one per line): the lines move only when it changes. */
  order: string;
  /** Draw this change as it is: a search on (or just started or cleared), or chats still coming in. */
  still: boolean;
  /** The list's own box: the element this draws (a `nav`), which scrolls. */
  scroller: RefObject<HTMLElement | null>;
};

/** Whether the list may move now: motion on, and the text size not in the middle of a change. */
const canMove = () => !reduced() && layoutZoom() === Math.round(zoomFactor() * 100);

/**
 * The chat list's scrolling box, whose lines glide to their new places when `order` changes (see the top of this
 * file). It draws the `nav` the list scrolls in.
 */
export class ListMotion extends Component<Props> {
  /** A glide drawn after the commit; a second commit before it's drawn keeps the first one's places (on screen still). */
  private pending: { seen: Map<string, Seen>; n: number } | null = null;
  private plays = 0;
  /** The glides drawn now. */
  private gliding = new Set<Animation>();
  /**
   * Rows lifted over the others while they glide (a chat going to the top), each with the glide that lifts it: a plain
   * z-index for as long as the glide runs, never an animation of it (that would be sampled on the main thread every
   * frame, a reply streaming or not).
   */
  private lifted = new Map<HTMLElement, Animation>();

  getSnapshotBeforeUpdate(prev: Props): Map<string, Seen> | null {
    if (prev.order === this.props.order) return null;
    const box = this.props.scroller.current;
    if (this.props.still || prev.still || !box || !canMove()) {
      // Searching, loading, or no motion: everything is where it is, now.
      this.pending = null;
      this.settle();
      return null;
    }
    const band = box.getBoundingClientRect();
    if (!band.height) return null;
    const keep = new Set(this.props.order.split("\n"));
    // Groups that go as a whole (the last pinned chat unpinned): one copy of the group, not one per line in it.
    const goneGroups = new Set<string>();
    const sections = Array.from(box.querySelectorAll<HTMLElement>("section[data-group]"));
    for (const s of sections) if (!keep.has(`g:${s.dataset.group}`)) goneGroups.add(s.dataset.group ?? "");
    // A commit before the last one's glide was drawn: the screen still shows what that one measured.
    const seen = this.pending?.seen ?? new Map<string, Seen>();
    const measure = !this.pending;
    let gone = 0;
    for (const el of Array.from(box.querySelectorAll<HTMLElement>(LINES))) {
      const r = el.getBoundingClientRect();
      // Lines are in order down the list: far below its box, the rest are too.
      if (r.top > band.bottom + band.height) break;
      if (r.bottom <= band.top || r.top >= band.bottom || !r.height) continue;
      const key = lineKey(el);
      if (!key) continue;
      if (measure) seen.set(key, { x: r.left, y: r.top });
      const group = el.closest<HTMLElement>("section[data-group]")?.dataset.group;
      if (!keep.has(key) && !(group !== undefined && goneGroups.has(group)) && gone < MOST_LEAVING) {
        leave(el, "row");
        gone++;
      }
    }
    for (const s of sections) {
      if (!goneGroups.has(s.dataset.group ?? "") || gone >= MOST_LEAVING) continue;
      const r = s.getBoundingClientRect();
      if (r.bottom <= band.top || r.top >= band.bottom) continue;
      // Its copy fades without the rows that only moved elsewhere: they glide from here instead.
      const staying = Array.from(s.querySelectorAll<HTMLElement>(LINES)).filter((l) => keep.has(lineKey(l) ?? ""));
      staying.forEach((l) => l.setAttribute("data-staying", ""));
      leave(s, "row");
      staying.forEach((l) => l.removeAttribute("data-staying"));
      gone++;
    }
    return seen;
  }

  componentDidUpdate(_prev: Props, _state: unknown, seen: Map<string, Seen> | null) {
    if (!seen) return;
    const n = ++this.plays;
    this.pending = { seen, n };
    // After the whole commit: a focus put back (and the row brought into view with it) comes first.
    queueMicrotask(() => {
      if (this.pending?.n !== n) return;
      this.pending = null;
      this.play(seen);
    });
  }

  componentWillUnmount() {
    this.pending = null;
    this.lower();
  }

  /** Lines still gliding land where they're going, at once. */
  private settle() {
    for (const a of this.gliding) a.cancel();
    this.gliding.clear();
    this.lower();
  }

  /** Lifted rows go back among the others (`only`: the one whose glide just ended, if it's still the one lifting it). */
  private lower(only?: [HTMLElement, Animation]) {
    for (const [el, glide] of only ? [only] : [...this.lifted]) {
      if (this.lifted.get(el) !== glide) continue;
      el.style.zIndex = "";
      this.lifted.delete(el);
    }
  }

  private play(seen: Map<string, Seen>) {
    const box = this.props.scroller.current;
    if (!box?.isConnected || !canMove()) return;
    // What's still gliding stops where it's drawn now (that's where `seen` has it), and glides on from there.
    this.settle();
    const band = box.getBoundingClientRect();
    const zoom = zoomFactor();
    const flip = { duration: ms("--dur-flip"), easing: token("--ease-smooth") || "ease" };
    const appear = { duration: ms("--dur-enter"), easing: token("--ease-fade") || "ease" };
    const glide = (el: HTMLElement, [dx, dy]: [number, number]) => {
      const a = el.animate({ transform: [`translate(${dx}px, ${dy}px)`, "translate(0px, 0px)"] }, flip);
      this.gliding.add(a);
      return a;
    };
    // Each group's heading's glide: what comes into that group while it moves comes along with it.
    const headings = new Map<string, [number, number]>();
    let left = MOST_MOVING;
    for (const el of Array.from(box.querySelectorAll<HTMLElement>(LINES))) {
      if (!left) break;
      const r = el.getBoundingClientRect();
      if (r.top > band.bottom + band.height) break;
      const key = lineKey(el);
      if (!key) continue;
      const on = r.bottom > band.top && r.top < band.bottom && r.height > 0;
      const move = moveOf(seen.get(key), { x: r.left, y: r.top, height: r.height, on, row: el.classList.contains("csb-item") }, band.height, zoom);
      if (!move) continue;
      left--;
      if (move === "enter") {
        // It fades in where it is, at its full size: what's in it is where a tap goes from the first frame.
        el.animate({ opacity: [0, 1] }, appear);
        const along = headings.get(el.closest<HTMLElement>("[data-group]")?.dataset.group ?? "");
        if (along) glide(el, along);
        continue;
      }
      if (key.startsWith("g:")) headings.set(key.slice(2), move.glide);
      const a = glide(el, move.glide);
      // Going up past others (a chat to the top, a pin), it goes over them, until it lands.
      if (move.lift) {
        el.style.zIndex = "1";
        this.lifted.set(el, a);
        const down = () => this.lower([el, a]);
        a.finished.then(down, down);
      }
    }
  }

  render() {
    const { order: _order, still: _still, scroller, children, ...rest } = this.props;
    return createElement("nav", { ...rest, ref: scroller }, children);
  }
}

/**
 * Brings a row of the list into view, at once, from where it's laid out: not from where a glide draws it for the
 * moment, which a focus move's own scrolling would go by (and leave the row out of sight once it lands). As a focus
 * move does: nothing if it's in view, the nearest edge if part of it is, centred if none of it is.
 */
export function revealInList(row: HTMLElement) {
  const list = row.closest<HTMLElement>(".csb-scroll");
  if (!list) return;
  // Its place in the list's content, through boxes that never count a glide (the list is the box rows are placed in).
  let top = 0;
  let at: HTMLElement | null = row;
  while (at && at !== list) {
    top += at.offsetTop;
    at = at.offsetParent as HTMLElement | null;
  }
  if (at !== list) {
    row.scrollIntoView({ block: "nearest" });
    return;
  }
  const height = row.offsetHeight;
  const from = list.scrollTop;
  const to = from + list.clientHeight;
  if (top >= from && top + height <= to) return;
  if (top + height > from && top < to) list.scrollTop = top < from ? top : top + height - list.clientHeight;
  else list.scrollTop = top - (list.clientHeight - height) / 2;
}

/** A dot's newness lasts this long: long enough for its pop, so a redraw meanwhile doesn't cut it short. */
const FRESH_MS = 600;

/**
 * Which of the list's marks (a row's dot: a reply, working, needs you…) just came on: those pop, once. Marks drawn with
 * the list (the drawer opening), on a row just come into the list, or the same as before, never do. Returns a check to
 * call for each row as it's drawn, with its key and its mark ("" for none).
 */
export function useFreshMarks(): (key: string, mark: string) => boolean {
  const marks = useRef<Map<string, string> | null>(null);
  const fresh = useRef(new Map<string, number>());
  const first = marks.current === null;
  const seen = (marks.current ??= new Map());
  const now = typeof performance === "undefined" ? 0 : performance.now();
  return (key, mark) => {
    const was = seen.get(key);
    seen.set(key, mark);
    if (!first && was !== undefined && was !== mark && mark) fresh.current.set(key, now);
    const at = fresh.current.get(key);
    if (at === undefined) return false;
    if (now - at < FRESH_MS) return true;
    fresh.current.delete(key);
    return false;
  };
}
