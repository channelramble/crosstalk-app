import { expect, test } from "bun:test";
import { limitResetTime, limitWaitWords, limitCarriedOnWords, limitGaveUpWords, type LimitWait } from "@crosstalk/shared";
import { countdownTickMs, limitBackWords, limitCountdown, limitWaitLine } from "./limitWait";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const MIN = 60_000;
const wait = (patch: Partial<LimitWait> = {}): LimitWait => ({
  provider: "claude",
  account: "default",
  accountLabel: null,
  kind: "usage",
  label: "5-hour",
  resetsAt: NOW + 60 * MIN,
  runAt: NOW + 61 * MIN,
  tries: 1,
  since: NOW,
  source: "event",
  ...patch,
});

test("the sentence names the agent and when it comes back", () => {
  const at = limitResetTime(NOW + 60 * MIN, NOW);
  expect(limitWaitWords(wait(), NOW)).toBe(`Claude Code is out of messages until ${at}. It'll carry on then.`);
  // A second account is told apart by its name.
  expect(limitWaitWords(wait({ account: "work", accountLabel: "Work" }), NOW)).toStartWith("Claude Code (Work) is out of messages until");
  // A rate limit is not the same as running out of messages.
  expect(limitWaitWords(wait({ kind: "rate" }), NOW)).toBe(`Claude Code has hit a rate limit until ${at}. It'll carry on then.`);
});

test("with no reset time it says soon, never a time", () => {
  const words = limitWaitWords(wait({ resetsAt: null, source: "none" }), NOW);
  expect(words).toBe("Claude Code is out of messages until its limit resets. It'll carry on soon.");
  expect(words).not.toContain(":");
});

test("a reset that has come round reads as any moment", () => {
  expect(limitWaitWords(wait({ resetsAt: NOW - MIN }), NOW)).toBe("Claude Code is out of messages. It'll carry on any moment.");
  expect(limitWaitWords(wait({ resetsAt: NOW + 10_000 }), NOW)).toEndWith("It'll carry on any moment.");
});

test("a reset on another day says which day", () => {
  const tomorrow = NOW + 26 * 3600_000;
  expect(limitResetTime(tomorrow, NOW)).toBe(new Date(tomorrow).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }));
  expect(limitResetTime(NOW + 60 * MIN, NOW)).toBe(new Date(NOW + 60 * MIN).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
});

test("the countdown is in a few plain words", () => {
  expect(limitCountdown(NOW + 42 * MIN, NOW)).toBe("in 42 min");
  expect(limitCountdown(NOW + 125 * MIN, NOW)).toBe("in 2 h 5 min");
  expect(limitCountdown(NOW + 120 * MIN, NOW)).toBe("in 2 h");
  expect(limitCountdown(NOW + 20_000, NOW)).toBe("any moment");
  expect(limitCountdown(NOW - 5 * MIN, NOW)).toBe("any moment");
});

test("the line under the reply: the time with a countdown, or only when it tries again", () => {
  const at = limitResetTime(NOW + 60 * MIN, NOW);
  expect(limitWaitLine(wait(), NOW)).toBe(`Carries on at ${at} · in 1 h 1 min`);
  expect(limitWaitLine(wait({ resetsAt: null, runAt: NOW + 5 * MIN }), NOW)).toBe("Trying again in 5 min");
  expect(limitWaitLine(wait({ runAt: NOW + 10_000 }), NOW)).toBe("Carrying on any moment");
});

test("the chat list's few words say when the chat comes back", () => {
  expect(limitBackWords(wait(), NOW)).toBe(`Back at ${limitResetTime(NOW + 60 * MIN, NOW)}`);
  // Nothing said when: never a made-up time.
  expect(limitBackWords(wait({ resetsAt: null }), NOW)).toBe("Back soon");
  expect(limitBackWords(wait({ resetsAt: NOW + 10_000 }), NOW)).toBe("Back soon");
});

test("the countdown redraws oftener as the time comes", () => {
  expect(countdownTickMs(NOW + 60 * MIN, NOW)).toBe(30_000);
  expect(countdownTickMs(NOW + 2 * MIN, NOW)).toBe(15_000);
});

test("carried on, and gave up, say what happened in plain words", () => {
  expect(limitCarriedOnWords(wait())).toBe("Waited for the 5-hour limit to reset, then carried on.");
  expect(limitCarriedOnWords(wait({ label: null }))).toBe("Waited for the limit to reset, then carried on.");
  const gave = limitGaveUpWords(wait(), 5, NOW);
  expect(gave).toContain("Crosstalk waited 5 times and stopped trying.");
  expect(gave).toContain(`It comes back at ${limitResetTime(NOW + 60 * MIN, NOW)}.`);
  expect(gave).toEndWith("Tap Try again when you want it to carry on.");
  // Never waited at all (a reset more than a day out): it says so without a count.
  expect(limitGaveUpWords(wait({ resetsAt: NOW + 30 * 3600_000 }), 0, NOW)).toContain("Crosstalk doesn't wait more than a day");
});
