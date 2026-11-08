import { expect, test } from "bun:test";
import { screenRoom, type ScreenSize } from "./viewport";

/** An iPhone 390 × 844 held upright, as a home-screen app, at 100%, nothing focused: the sizes a test changes. */
const screen = (s: Partial<ScreenSize>): ScreenSize => ({ width: 390, height: 844, page: 844, tallest: 844, typing: false, shrinks: false, zoom: 1, ...s });
const nothing = { keyboard: false, short: false, cramped: false };

test("typing on a phone held upright keeps the whole header and the controls row, at 125% too", () => {
  expect(screenRoom(screen({}))).toEqual(nothing);
  // iOS: the page stays as tall as it was, the visible part above the keyboard is 470 to 508 px.
  for (const height of [470, 508]) for (const zoom of [1, 1.1, 1.25]) expect(screenRoom(screen({ height, typing: true, zoom }))).toEqual({ ...nothing, keyboard: true });
  // Predictions on and Safari's form bar.
  expect(screenRoom(screen({ page: 798, tallest: 798, height: 418, typing: true }))).toEqual({ ...nothing, keyboard: true });
});

test("not much left above the keyboard: a slimmer header, and the controls row stays", () => {
  // At 150%, 313 to 339 px of the page's own left.
  for (const height of [470, 508]) expect(screenRoom(screen({ height, typing: true, zoom: 1.5 }))).toEqual({ ...nothing, keyboard: true, short: true });
  // An iPhone SE in Safari: about 345 px left, still upright though it's wider than that.
  expect(screenRoom(screen({ width: 375, page: 553, tallest: 553, height: 345, typing: true }))).toEqual({ ...nothing, keyboard: true, short: true });
  // The browser tests' keyboard (phoneQol): an Android-like touch screen 844 px tall left 508 above it, at 150%.
  expect(screenRoom(screen({ page: 508, height: 508, typing: true, shrinks: true, zoom: 1.5 }))).toEqual({ ...nothing, keyboard: true, short: true });
});

test("really little room above the keyboard drops the controls row too", () => {
  // The iPhone SE at 125%: 276 px of the page's own left.
  expect(screenRoom(screen({ width: 375, page: 553, tallest: 553, height: 345, typing: true, zoom: 1.25 }))).toEqual({ keyboard: true, short: true, cramped: true });
});

test("held sideways: a slimmer header, and with the keyboard up no controls row", () => {
  expect(screenRoom(screen({ width: 844, page: 390, tallest: 390, height: 390 }))).toEqual({ ...nothing, short: true });
  expect(screenRoom(screen({ width: 844, page: 390, tallest: 390, height: 170, typing: true }))).toEqual({ keyboard: true, short: true, cramped: true });
  // A folded phone's cover screen turned sideways.
  expect(screenRoom(screen({ width: 882, page: 344, tallest: 344, height: 344 }))).toEqual({ ...nothing, short: true });
  // Zoomed out to 80%, the header has room again; typing, neither it nor the controls do.
  expect(screenRoom(screen({ width: 844, page: 390, tallest: 390, height: 390, zoom: 0.8 }))).toEqual(nothing);
  expect(screenRoom(screen({ width: 844, page: 390, tallest: 390, height: 170, typing: true, zoom: 0.8 }))).toEqual({ keyboard: true, short: true, cramped: true });
  // A tablet held sideways keeps the whole header and the controls while it has room above the keyboard (an iPad), not
  // when it hasn't (an iPad mini).
  expect(screenRoom(screen({ width: 1180, page: 820, tallest: 820, height: 430, typing: true }))).toEqual({ ...nothing, keyboard: true });
  expect(screenRoom(screen({ width: 1133, page: 744, tallest: 744, height: 354, typing: true }))).toEqual({ keyboard: true, short: true, cramped: true });
});

test("on Android the keyboard makes the page shorter: the visible part getting shorter while typing is the keyboard", () => {
  const android = (s: Partial<ScreenSize>) => screen({ width: 412, page: 915, tallest: 915, height: 915, shrinks: true, ...s });
  expect(screenRoom(android({ page: 500, height: 500, typing: true }))).toEqual({ ...nothing, keyboard: true });
  // Shorter with nothing focused (a split screen): no keyboard, and the height it has is what counts.
  expect(screenRoom(android({ page: 500, height: 500 }))).toEqual(nothing);
  expect(screenRoom(android({ page: 400, height: 400 }))).toEqual({ ...nothing, short: true });
  // Held sideways with the keyboard up.
  expect(screenRoom(android({ width: 915, tallest: 412, page: 190, height: 190, typing: true }))).toEqual({ keyboard: true, short: true, cramped: true });
});

test("a computer's or an iPad's window made shorter while typing is no keyboard", () => {
  // A laptop's window snapped to the top half: the slimmer header of a short window, and the controls stay.
  expect(screenRoom(screen({ width: 1440, tallest: 800, page: 400, height: 400, typing: true }))).toEqual({ ...nothing, short: true });
  // An iPad's Stage Manager window made shorter, a keyboard attached: the message box keeps its home-indicator gap.
  expect(screenRoom(screen({ width: 900, tallest: 900, page: 520, height: 520, typing: true }))).toEqual(nothing);
});
