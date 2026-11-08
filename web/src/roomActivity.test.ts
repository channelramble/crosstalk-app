import { expect, test } from "bun:test";
import { contributionSize, roomContributors } from "./roomActivity";

test("room contributors combine accounts of one provider, preserve old contributors and exclude unused agents", () => {
  expect(roomContributors([
    { provider: "claude", turns: 7, outputTokens: 100 },
    { provider: "codex", turns: 2, outputTokens: 30 },
    { provider: "claude", turns: 3, outputTokens: 50 },
    { provider: "gemini", turns: 0, outputTokens: 0 },
  ])).toEqual([{ provider: "claude", turns: 10, outputTokens: 150 }, { provider: "codex", turns: 2, outputTokens: 30 }]);
});

test("larger contributions get larger icons, tied contributors get equal icons", () => {
  for (const compact of [true, false]) {
    expect(contributionSize(100, 100, compact)).toBeGreaterThan(contributionSize(1, 100, compact));
    const tied = roomContributors([{ provider: "claude", turns: 4, outputTokens: 80 }, { provider: "codex", turns: 4, outputTokens: 10 }]);
    expect(tied.map((a) => contributionSize(a.turns, tied[0].turns, compact))).toEqual([compact ? 22 : 30, compact ? 22 : 30]);
    expect(contributionSize(1, 10000, compact)).toBeGreaterThanOrEqual(compact ? 11 : 15);
  }
});
