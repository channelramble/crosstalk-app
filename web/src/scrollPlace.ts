// Keeping your place in a scrolling list when its size changes: a foldable folding or unfolding, a phone turning, a
// window resized, the keyboard opening. The browser moves the scroll position then (it clamps it, or lines things up
// again), and nobody scrolled: a list following its newest message keeps following, and one read further up keeps
// what's at its top where it was. Safari doesn't do the second by itself (no CSS scroll anchoring); others do, roughly.

/**
 * What's at the top of the list and how far below the list's top edge it starts (negative: partly above it). For a
 * part taller than the screen crossing the top edge (a long code block), `frac`: how far through it the edge was.
 */
export interface Place {
  el: Element;
  offset: number;
  frac?: number;
}

/** The scroller's size, to tell a change of size from someone scrolling. */
export const sizeKey = (el: HTMLElement) => `${el.clientWidth}x${el.clientHeight}`;

/** Inside a long message: the parts a reader's place can be kept by (a paragraph, a list item, a code block…). */
const PARTS = "p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, tr, hr, img, .activity";

/**
 * Whether `el` is drawn. Inside a closed details it isn't, though Chromium and Safari still give it a box where it
 * would be (over what follows), so only checkVisibility tells; older browsers give it no box at all.
 */
export function isDrawn(el: Element): boolean {
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
}

/**
 * The first drawn one of `items` whose edge `edge` is past `y`, found by halves (a chat can hold hundreds), or -1.
 * Those not drawn are passed over: where they say they are is out of order with the rest.
 */
function firstPast(items: ArrayLike<Element>, edge: "top" | "bottom", y: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // The first drawn one from the middle on stands for it.
    let m = mid;
    while (m < hi && !isDrawn(items[m])) m++;
    if (m < hi && items[m].getBoundingClientRect()[edge] <= y) lo = m + 1;
    else hi = mid;
  }
  while (lo < items.length && !isDrawn(items[lo])) lo++;
  return lo < items.length ? lo : -1;
}

/** The first drawn one of `items` from `n` on (`step` 1) or back (-1), passing over a few not drawn at most, or -1. */
function nextDrawn(items: ArrayLike<Element>, n: number, step: 1 | -1): number {
  for (let tries = 0; n >= 0 && n < items.length && tries < 50; n += step, tries++) if (isDrawn(items[n])) return n;
  return -1;
}

/**
 * What's being read at the top of `scroller`: the first paragraph (or message) that starts on screen, in the message
 * still showing at the top or the next one. So the line at the top stays put, whatever the messages above it do, and
 * inside a long reply too.
 */
export function placeOf(scroller: HTMLElement, content: HTMLElement | null): Place | null {
  const items = content?.children;
  if (!items?.length) return null;
  const view = scroller.getBoundingClientRect();
  const i = firstPast(items, "bottom", view.top + 1);
  if (i < 0) return null;
  let crossing: Place | null = null;
  for (const row of [items[i], items[nextDrawn(items, i + 1, 1)]]) {
    if (!row) break;
    const r = row.getBoundingClientRect();
    if (r.top >= view.bottom) break;
    if (r.top >= view.top - 1) return { el: row, offset: r.top - view.top };
    const parts = row.querySelectorAll(PARTS);
    const j = firstPast(parts, "top", view.top - 1);
    const part = j >= 0 ? parts[j].getBoundingClientRect() : null;
    if (part && part.height > 0 && part.top < view.bottom) return { el: parts[j], offset: part.top - view.top };
    // None starts on screen: the one the top edge is in (the last drawn one starting above it), by how far through it.
    const k = nextDrawn(parts, (j < 0 ? parts.length : j) - 1, -1);
    const over = k >= 0 ? parts[k].getBoundingClientRect() : null;
    if (!crossing && over && over.height > 0 && over.bottom > view.top) crossing = { el: parts[k], offset: over.top - view.top, frac: (view.top - over.top) / over.height };
  }
  if (crossing) return crossing;
  const el = items[i];
  return { el, offset: el.getBoundingClientRect().top - view.top };
}

/**
 * Puts what was at the top back where it was (nothing to do once it's gone, or no longer drawn: in a details that
 * closed, where it says it is means nothing). Distances on screen are drawn bigger by the page's zoom (zoom.ts) and
 * scroll positions aren't, so the distance is turned into the scroller's own pixels.
 */
export function restorePlace(scroller: HTMLElement, place: Place | null) {
  if (!place?.el.isConnected || !isDrawn(place.el)) return;
  const view = scroller.getBoundingClientRect();
  const r = place.el.getBoundingClientRect();
  // A part taller than the screen is put back by how far through it the top edge was (its lines wrap again).
  const want = place.frac !== undefined ? view.top - place.frac * r.height : view.top + place.offset;
  const moved = r.top - want;
  const scale = scroller.offsetHeight > 0 && view.height > 0 ? view.height / scroller.offsetHeight : 1;
  if (Math.abs(moved) >= 1) scroller.scrollTop += moved / scale;
}
