import { expect, test } from "bun:test";
import { isDrawn, placeOf, restorePlace } from "./scrollPlace";

/**
 * How a stand-in element is drawn: on screen; `closed`, inside a closed details, where Chromium and Safari still give
 * it a box where it would be; `none`, with no box at all (display: none, or a closed details in an older browser).
 */
type Shown = "drawn" | "closed" | "none";

/** A stand-in for an element: where it is on screen (top, height), how it's drawn, and its parts or messages. */
function el(top: number, height: number, shown: Shown = "drawn", inside: Element[] = [], old = false): Element {
  const rect = () => (shown === "none" ? { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 } : { top, bottom: top + height, height, left: 0, right: 300, width: 300 });
  const fake: Record<string, unknown> = {
    isConnected: true,
    children: inside,
    getBoundingClientRect: rect,
    getClientRects: () => (shown === "none" ? [] : [rect()]),
    querySelectorAll: () => inside,
  };
  // Browsers from before checkVisibility only have the boxes to go by.
  if (!old) fake.checkVisibility = () => shown === "drawn";
  return fake as unknown as Element;
}

/** The chat's scrolling part: its edges on screen, its own (unzoomed) height and where it's scrolled to. */
function scroller(top: number, height: number, ownHeight = height, scrollTop = 1000) {
  return { getBoundingClientRect: () => ({ top, bottom: top + height, height }), offsetHeight: ownHeight, scrollTop } as unknown as HTMLElement & { scrollTop: number };
}

test("a part inside a closed details isn't drawn, though newer browsers still give it a box", () => {
  expect(isDrawn(el(10, 40))).toBe(true);
  expect(isDrawn(el(10, 40, "closed"))).toBe(false);
  expect(isDrawn(el(10, 40, "none"))).toBe(false);
  // Older browsers: no box, not drawn.
  expect(isDrawn(el(10, 40, "drawn", [], true))).toBe(true);
  expect(isDrawn(el(10, 40, "none", [], true))).toBe(false);
});

test("a place inside a details that closed since is left alone: the chat doesn't jump", () => {
  // You were reading a step's output at the top; the turn ended and its steps closed.
  for (const pre of [el(50, 300, "closed"), el(50, 300, "none"), el(50, 300, "none", [], true)]) {
    const sc = scroller(100, 600);
    restorePlace(sc, { el: pre, offset: 20 });
    expect(sc.scrollTop).toBe(1000);
    restorePlace(sc, { el: pre, offset: -40, frac: 0.2 });
    expect(sc.scrollTop).toBe(1000);
  }
  // Gone from the page: the same.
  const sc = scroller(100, 600);
  restorePlace(sc, { el: Object.assign(el(50, 300), { isConnected: false }), offset: 20 });
  expect(sc.scrollTop).toBe(1000);
});

test("a place still drawn is put back, in the scroller's own pixels at a larger text size", () => {
  // 150%: 900 px on screen are the scroller's own 600.
  const sc = scroller(0, 900, 600);
  restorePlace(sc, { el: el(160, 40), offset: 100 });
  expect(sc.scrollTop).toBeCloseTo(1000 + 60 / 1.5);
  // A code block taller than the screen, a quarter of the way through it at the top edge: it is again.
  const tall = scroller(0, 600);
  restorePlace(tall, { el: el(-330, 1200), offset: -300, frac: 0.25 });
  expect(tall.scrollTop).toBe(1000 - 30);
});

test("parts inside a closed details don't hide the paragraph that starts on screen after it", () => {
  // A reply crossing the top edge: a paragraph above, its closed steps (whose hidden output still says it's where it
  // would be, over what follows), then the paragraphs after them, the first 10 px below the top edge.
  const after = el(10, 40);
  const parts = [el(-200, 100), el(-60, 30), el(-30, 500, "closed"), el(470, 200, "closed"), after, el(60, 40)];
  const reply = el(-300, 900, "drawn", parts);
  const content = el(-1200, 1800, "drawn", [el(-1200, 900), reply, el(600, 100)]) as HTMLElement;
  expect(placeOf(scroller(0, 600), content)).toEqual({ el: after, offset: 10 });
});

test("when no part starts on screen, the one the top edge is in is kept, past hidden ones", () => {
  // A code block from 800 px above the top edge to 800 below it, then a step's hidden output.
  const code = el(-800, 1600);
  const reply = el(-3000, 4000, "drawn", [el(-2500, 100), code, el(300, 200, "closed")]);
  const content = el(-3000, 4000, "drawn", [reply]) as HTMLElement;
  expect(placeOf(scroller(0, 600), content)).toEqual({ el: code, offset: -800, frac: 0.5 });
});

test("a message not drawn among them doesn't make the search skip the one at the top", () => {
  // The message crossing the top edge has a paragraph 30 px down; the one after it isn't drawn at all.
  const onScreen = el(30, 70);
  const messages = [el(-900, 400), el(-500, 600, "drawn", [el(-500, 520), onScreen]), el(0, 0, "none"), el(100, 300), el(400, 300)];
  const content = el(-900, 1600, "drawn", messages) as HTMLElement;
  expect(placeOf(scroller(0, 600), content)).toEqual({ el: onScreen, offset: 30 });
  // Read further down, the message after the hidden one starts on screen.
  const next = el(100, 300);
  const later = el(-900, 1600, "drawn", [el(-900, 400), el(-500, 520), el(0, 0, "none"), next]) as HTMLElement;
  expect(placeOf(scroller(0, 600), later)).toEqual({ el: next, offset: 100 });
});
