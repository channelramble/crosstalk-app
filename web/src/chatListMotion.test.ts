import { describe, expect, test } from "bun:test";
import { moveOf, type Now } from "./views/ChatListMotion";

// What one line of the chat list does after a change (ChatListMotion.ts): glide from where it was drawn, fade in where
// it is, or nothing. The drawing itself, the budget and what's on screen are in web/e2e/chatListMotion.spec.ts.

const VIEW = 700;
const at = (y: number, over: Partial<Now> = {}): Now => ({ x: 8, y, height: 50, on: y > -50 && y < VIEW, row: true, ...over });

describe("a line that moved glides from where it was drawn", () => {
  test("by how far it moved, in the page's own pixels", () => {
    expect(moveOf({ x: 8, y: 300 }, at(200), VIEW, 1)).toEqual({ glide: [0, 100], lift: true });
    expect(moveOf({ x: 8, y: 250 }, at(300), VIEW, 1)).toEqual({ glide: [0, -50], lift: false });
    // At 150% every page pixel is drawn half as big again: screen pixels are divided back.
    expect(moveOf({ x: 8, y: 300 }, at(150), VIEW, 1.5)).toEqual({ glide: [0, 100], lift: true });
  });

  test("a row going more than a row and a half goes over the rows it passes; other lines never lift", () => {
    expect(moveOf({ x: 8, y: 270 }, at(200), VIEW, 1)).toEqual({ glide: [0, 70], lift: false });
    expect(moveOf({ x: 8, y: 276 }, at(200), VIEW, 1)).toEqual({ glide: [0, 76], lift: true });
    expect(moveOf({ x: 8, y: 400 }, at(200, { row: false }), VIEW, 1)).toEqual({ glide: [0, 200], lift: false });
  });

  test("a line that didn't move, or less than a pixel, stays as it is", () => {
    expect(moveOf({ x: 8, y: 200 }, at(200), VIEW, 1)).toBeNull();
    expect(moveOf({ x: 8.4, y: 200.4 }, at(200), VIEW, 1)).toBeNull();
  });

  test("one pushed out of view slides out of it; one gone far out of view (the list jumped) just goes", () => {
    expect(moveOf({ x: 8, y: 660 }, at(720), VIEW, 1)).toEqual({ glide: [0, -60], lift: false });
    expect(moveOf({ x: 8, y: 400 }, at(1900), VIEW, 1)).toBeNull();
    expect(moveOf({ x: 8, y: 400 }, at(-1400), VIEW, 1)).toBeNull();
  });
});

describe("a line that wasn't on screen", () => {
  test("fades in where it is, if it's on screen now", () => {
    expect(moveOf(undefined, at(200), VIEW, 1)).toBe("enter");
    expect(moveOf(undefined, at(200, { row: false }), VIEW, 1)).toBe("enter");
  });

  test("and nothing is drawn for one that still isn't", () => {
    expect(moveOf(undefined, at(1200), VIEW, 1)).toBeNull();
    expect(moveOf(undefined, at(-400), VIEW, 1)).toBeNull();
  });
});
