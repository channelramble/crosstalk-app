import { expect, test } from "bun:test";
import { limitResetTime } from "@crosstalk/shared";
import { usageResetLine, usageShareText } from "./usageWords";

const NOW = new Date(2026, 9, 31, 10, 0).getTime();
const MIN = 60_000;

test("a window's reset counts down in minutes, hours and days", () => {
  expect(usageResetLine(NOW + 30_000, NOW)).toBe("Resets in 1 min");
  expect(usageResetLine(NOW + 7 * MIN, NOW)).toBe("Resets in 7 min");
  expect(usageResetLine(NOW + 125 * MIN, NOW)).toBe("Resets in 2 h 5 min");
  expect(usageResetLine(NOW + 180 * MIN, NOW)).toBe("Resets in 3 h");
  expect(usageResetLine(NOW + (3 * 24 + 4) * 60 * MIN, NOW)).toBe("Resets in 3 d 4 h");
});

test("a reset that has gone by says when it was and how to see the share now, never \"Resets in now\"", () => {
  for (const ago of [0, 400, 4 * MIN, 14 * MIN]) {
    const line = usageResetLine(NOW - ago, NOW);
    expect(line).toBe(`Reset at ${limitResetTime(NOW - ago, NOW)}. Tap Refresh to see what's used now.`);
    expect(line).not.toContain("Resets in now");
  }
});

test("a meter whose share nobody knows is never read out as 0% used", () => {
  expect(usageShareText(null)).toBe("Not known");
  expect(usageShareText(Number.NaN)).toBe("Not known");
  expect(usageShareText(0)).toBe("0% used");
  expect(usageShareText(41.6)).toBe("42% used");
  expect(usageShareText(100)).toBe("100% used");
});
