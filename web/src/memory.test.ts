import { expect, test } from "bun:test";
import type { MachineMemory } from "@crosstalk/shared";
import { MEMORY_PILL, memoryLine, memorySummary, memorySwap, memoryTaken, memoryWays, showMemory } from "./memory";

// Settings → Memory: what the card says. Measured numbers from a 16 GB Mac mini that ran out of memory are the
// example, so the words are checked against a state a machine really can be in.

const GiB = 1024 ** 3;
const incident = (over: Partial<MachineMemory> = {}): MachineMemory => ({
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

test("the card is only on screen while there is something to say", () => {
  expect(showMemory(null)).toBe(false);
  expect(showMemory(incident({ band: "fine" }))).toBe(false);
  // A hub that can't read its machine says nothing rather than something misleading.
  expect(showMemory(incident({ band: "unknown", blind: "Crosstalk only watches memory on macOS and Linux hubs." }))).toBe(false);
  expect(showMemory(incident({ band: "busy" }))).toBe(true);
  expect(showMemory(incident())).toBe(true);
  expect(MEMORY_PILL.full).toEqual({ label: "Full", tone: "red" });
  expect(MEMORY_PILL.busy).toEqual({ label: "Getting full", tone: "orange" });
  expect(MEMORY_PILL.unknown).toBeNull();
});

test("it says what is wrong, what is holding the machine, and the one or two things that would help", () => {
  const m = incident();
  expect(memoryLine(m, "Mac mini")).toBe("Mac mini is out of memory. Replies and edits can take minutes until something stops. The biggest thing running is the image editor (16.9 GB).");
  expect(memoryTaken(m)).toBe("20.7 GB of 16.0 GB");
  expect(memorySwap(m)).toBe("9.6 GB has moved to the disk, and it is still moving. That is why everything feels slow.");
  // Crosstalk's own thing gets a button; the person's own gets words, because the hub never ends what it didn't start.
  expect(memoryWays(m)).toEqual([
    { text: "Turn the image editor off", section: "image-editor" },
    { text: "Quit the model server on port 8080 on this machine", section: null },
  ]);
  // At most two: a phone screen holds two choices, not five.
  expect(memoryWays(incident({ holders: [...m.holders, { what: "llama.cpp on port 9000", ours: true, section: "local-models", bytes: GiB }] })).length).toBe(2);
  expect(memorySummary(m, "Mac mini")).toContain("Turn the image editor off.");
});

test("what can't be measured is left out of the words instead of being guessed at", () => {
  expect(memoryTaken(incident({ takenBytes: null }))).toBeNull();
  expect(memorySwap(incident({ swapUsedBytes: null }))).toBeNull();
  expect(memorySwap(incident({ swapPagesPerSec: 0 }))).toBe("9.6 GB has moved to the disk. That is why everything feels slow.");
  expect(memoryLine(incident({ holders: [] }), "Mac mini")).toBe("Mac mini is out of memory. Replies and edits can take minutes until something stops.");
  expect(memoryLine(incident({ band: "unknown", blind: "This hub can't read its machine's memory." }), "Server")).toBe("This hub can't read its machine's memory.");
});
