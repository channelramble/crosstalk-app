import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MachineMemory } from "@crosstalk/shared";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { MemoryCard } = await import("./views/MemorySection");

// Settings → Memory, drawn without a browser (the taps are in web/e2e/memoryGuard.spec.ts).

const GiB = 1024 ** 3;
const memory = (over: Partial<MachineMemory> = {}): MachineMemory => ({
  band: "full",
  level: 18,
  blind: null,
  ramBytes: 16 * GiB,
  takenBytes: Math.round(20.7 * GiB),
  swapPagesPerSec: 18_000,
  swapUsedBytes: Math.round(9.6 * GiB),
  holders: [
    { what: "the image editor", ours: true, section: "image-editor", bytes: Math.round(16.9 * GiB) },
    { what: "the model server on port 8080", ours: false, section: null, bytes: Math.round(3.8 * GiB) },
  ],
  at: 1,
  ...over,
});

const draw = (m: MachineMemory | null) => renderToStaticMarkup(createElement(MemoryCard, { memory: m, machine: "Mac mini" }));

test("the card names what is holding the machine, offers a tap for Crosstalk's own and words for the person's", () => {
  const html = draw(memory());
  expect(html).toContain("Mac mini is out of memory");
  expect(html).toContain("the image editor");
  expect(html).toContain("16.9 GB");
  // Crosstalk started the editor, so there is a button that goes to where it is switched off.
  expect(html).toContain("Turn the image editor off");
  // The server on 8080 is the person's own: no button that would end it, just where to do it.
  expect(html).toContain("Quit it on Mac mini");
  expect(html).not.toContain("Turn the model server on port 8080 off");
  expect(html).toContain("Crosstalk never stops anything by itself");
  expect(html).toContain("Full");
});

test("nothing is on screen while memory is fine, or on a hub that can't read it", () => {
  expect(draw(null)).toBe("");
  expect(draw(memory({ band: "fine" }))).toBe("");
  expect(draw(memory({ band: "unknown", blind: "Crosstalk only watches memory on macOS and Linux hubs." }))).toBe("");
});

test("a holder that couldn't be measured keeps its row and says so, rather than showing a made-up size", () => {
  const html = draw(memory({ band: "busy", takenBytes: null, swapUsedBytes: null, holders: [{ what: "the model server on port 8080", ours: false, section: null, bytes: null }] }));
  expect(html).toContain("size unknown");
  expect(html).toContain("Getting full");
  expect(html).not.toContain("Together they hold");
  expect(html).not.toContain("moved to the disk");
});
