import { expect, test } from "bun:test";
import { largestFitting, ZOOM_STEPS } from "./zoom";

test("a bigger text and page size never lays the page out narrower than a small phone", () => {
  expect(ZOOM_STEPS).toEqual([80, 90, 100, 110, 125, 150]);
  // 150% fits the usual iPhones (390 and 430 wide, and the 375-wide minis).
  for (const width of [375, 390, 393, 430, 1440]) expect(largestFitting(width)).toBe(150);
  // The oldest small phones get the largest size that still leaves 250 points.
  expect(largestFitting(320)).toBe(125);
  expect(largestFitting(300)).toBe(110);
  // 100% always fits, however narrow.
  expect(largestFitting(240)).toBe(100);
  expect(largestFitting(0)).toBe(100);
});

/**
 * A fresh zoom.ts, loaded on a stand-in page that can zoom (zoom.ts looks at the browser as it loads), on a screen
 * `width` px wide; `resize` makes the screen that wide, as a fold, a turn or a window resized would. `done` puts the
 * real globals back.
 */
async function standIn(load: () => Promise<unknown>, width: number) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  const resized: (() => void)[] = [];
  const window = { innerWidth: width, visualViewport: null, addEventListener: (type: string, fn: () => void) => type === "resize" && resized.push(fn) };
  const page = {
    CSS: { supports: () => true },
    document: { documentElement: { style: { setProperty() {}, removeProperty() {} } } },
    window,
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) },
  };
  for (const [key, value] of Object.entries(page)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const done = () => {
    for (const [key, d] of originals) {
      if (d) Object.defineProperty(globalThis, key, d);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  try {
    const zoom = (await load()) as typeof import("./zoom");
    zoom.initZoom();
    const resize = (to: number) => {
      window.innerWidth = to;
      for (const fn of resized) fn();
    };
    return { zoom, resize, done };
  } catch (e) {
    done();
    throw e;
  }
}

test("while the size is changed in Settings, the layout keeps the size it had until it's let go", async () => {
  const { zoom, done } = await standIn(() => import("./zoom.ts?layout-hold"), 1000);
  try {
    const told: number[] = [];
    zoom.onZoom(() => told.push(zoom.layoutZoom()));
    zoom.setZoom(125);
    expect(zoom.layoutZoom()).toBe(125);
    // Stepping in Settings: the page zooms, the layout (chats docked or in a drawer) stays as it was.
    const release = zoom.holdLayout();
    zoom.setZoom(150);
    zoom.setZoom(110);
    expect(zoom.zoomFactor()).toBe(1.1);
    expect(zoom.layoutZoom()).toBe(125);
    // Leaving Settings: it follows the size again, and whatever follows the size is told.
    release();
    expect(zoom.layoutZoom()).toBe(110);
    expect(told.at(-1)).toBe(110);
    const heard = told.length;
    release();
    expect(told.length).toBe(heard);
    zoom.setZoom(150);
    expect(zoom.layoutZoom()).toBe(150);
  } finally {
    done();
  }
});

test("a fold or a turn while the size is held lets the layout follow the size again", async () => {
  // A folded phone's cover screen, 344 px wide, stepped from 100% to 125% in Settings.
  const { zoom, resize, done } = await standIn(() => import("./zoom.ts?fold"), 344);
  try {
    const told: number[] = [];
    zoom.onZoom(() => told.push(zoom.layoutZoom()));
    const release = zoom.holdLayout();
    zoom.setZoom(125);
    expect(zoom.layoutZoom()).toBe(100);
    // Only shorter (the keyboard, the browser's bars): still held.
    resize(344);
    expect(zoom.layoutZoom()).toBe(100);
    // Unfolded: laid out as 125% is on a screen this wide (one screen at a time), and whatever follows the size is told.
    resize(882);
    expect(zoom.layoutZoom()).toBe(125);
    expect(told.at(-1)).toBe(125);
    // The next press holds it again, from here; the hold that was let go can't end the new one.
    const again = zoom.holdLayout();
    zoom.setZoom(150);
    release();
    expect(zoom.layoutZoom()).toBe(125);
    again();
    expect(zoom.layoutZoom()).toBe(150);
  } finally {
    done();
  }
});
