// Telling a usage limit that resets from everything that only looks like one (hub/src/agents/limits.ts). The point of
// these tests is the lookalikes: a credit or quota failure that was retried hours later would hang silently.

import { describe, expect, test } from "bun:test";
import { claudeLimitHit, codexLimitHit, epochMs, resetFromText, textLimitHit } from "../src/agents/limits";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const IN = (ms: number) => NOW + ms;

describe("epoch times", () => {
  test("both agents' seconds and plain milliseconds come out as milliseconds", () => {
    expect(epochMs(Math.floor(NOW / 1000))).toBe(NOW);
    expect(epochMs(NOW)).toBe(NOW);
    expect(epochMs(0)).toBe(null);
    expect(epochMs("1800")).toBe(null);
    expect(epochMs(null)).toBe(null);
  });
});

describe("a reset time said in words", () => {
  test("an HTTP retry-after, in seconds or minutes", () => {
    expect(resetFromText("Too many requests. Retry-After: 120", NOW)).toEqual({ resetsAt: IN(120_000), source: "retry-after" });
    expect(resetFromText("retry after 5 minutes", NOW)).toEqual({ resetsAt: IN(5 * 60_000), source: "retry-after" });
  });
  test("Gemini's retryDelayMs", () => {
    expect(resetFromText('{"error":{"status":"RESOURCE_EXHAUSTED","retryDelayMs":45000}}', NOW)).toEqual({ resetsAt: IN(45_000), source: "retry-after" });
  });
  test("a wait in words", () => {
    expect(resetFromText("Rate limited: try again in 2 hours", NOW)).toEqual({ resetsAt: IN(2 * 3600_000), source: "text" });
    expect(resetFromText("resets in 30 minutes", NOW)).toEqual({ resetsAt: IN(30 * 60_000), source: "text" });
  });
  test("a clock time, taken as the next time it comes round", () => {
    // NOW is 12:00 UTC; the fixture's clock is the machine's, so compare with a local 3:20 PM / 3:20 AM.
    const pm = resetFromText("You've hit your session limit · resets at 3:20pm · progress saved", NOW)!;
    const at = new Date(pm.resetsAt);
    expect([at.getHours(), at.getMinutes()]).toEqual([15, 20]);
    expect(pm.resetsAt).toBeGreaterThan(NOW);
    expect(pm.source).toBe("text");
    // A time already gone today is tomorrow's, never a negative wait.
    const gone = resetFromText("Try again at 1:00am", NOW)!;
    expect(gone.resetsAt).toBeGreaterThan(NOW);
    expect(gone.resetsAt - NOW).toBeLessThanOrEqual(24 * 3600_000);
  });
  test("nothing readable, or nothing at all", () => {
    expect(resetFromText("You've hit your weekly limit", NOW)).toBe(null);
    expect(resetFromText("", NOW)).toBe(null);
    expect(resetFromText(null, NOW)).toBe(null);
  });
});

describe("Claude Code", () => {
  const limit = (over: Record<string, unknown> = {}) => claudeLimitHit({ now: NOW, ...over });

  test("a rejected rate_limit_event with the API's 429 waits, with the window's reset", () => {
    const hit = limit({
      apiErrorStatus: 429,
      text: "You've hit your session limit · resets 1pm · progress saved",
      rejected: { label: "5-hour", usedPercent: 100, resetsAt: IN(1800_000) },
      windows: [{ label: "5-hour", usedPercent: 100, resetsAt: IN(1800_000) }],
    });
    expect(hit).toEqual({ kind: "usage", label: "5-hour", resetsAt: IN(1800_000), source: "event" });
  });

  // `rejected` is only ever a window Claude Code said it *refused* a request on, and the driver forgets it as soon as
  // the model answers again (claude.ts): a window merely full (paid extra usage covers it) never reaches here.
  test("either signal alone is enough: a 429 with no event, and a rejected event with no 429", () => {
    expect(limit({ apiErrorStatus: 429, text: "rate_limit_error: too many requests" })).toMatchObject({ kind: "rate", source: "none" });
    expect(limit({ text: "stream closed", rejected: { label: "Weekly", usedPercent: 100, resetsAt: IN(7200_000) } })).toMatchObject({ kind: "usage", label: "Weekly", resetsAt: IN(7200_000) });
  });

  test("with no reset anywhere it still waits, saying nothing about when", () => {
    const hit = limit({ apiErrorStatus: 429, text: "You've hit your session limit · progress saved", rejected: { label: "5-hour", usedPercent: 100, resetsAt: null } });
    expect(hit).toEqual({ kind: "usage", label: "5-hour", resetsAt: null, source: "none" });
  });

  test("a reset only in the words is read from them", () => {
    const hit = limit({ apiErrorStatus: 429, text: "You've hit your weekly limit · resets in 90 minutes" });
    expect(hit).toMatchObject({ resetsAt: IN(90 * 60_000), source: "text" });
  });

  test("the fullest window stands in when the event didn't say", () => {
    const hit = limit({ apiErrorStatus: 429, text: "usage limit reached", windows: [{ label: "Weekly", usedPercent: 46, resetsAt: IN(99_000_000) }, { label: "5-hour", usedPercent: 100, resetsAt: IN(600_000) }] });
    expect(hit).toEqual({ kind: "usage", label: "5-hour", resetsAt: IN(600_000), source: "snapshot" });
  });

  test("credits are never a wait, however much they read like one", () => {
    expect(limit({ apiErrorStatus: 429, apiError: "model_requires_usage_credits", text: "Claude plan limit reached: credits_required" })).toBe(null);
    expect(limit({ apiErrorStatus: 429, apiError: "long_context_credits_required", text: "rate limit" })).toBe(null);
    expect(limit({ apiErrorStatus: 429, text: "credits_required: add credit to use this model" })).toBe(null);
    expect(limit({ apiErrorStatus: 429, text: "service_spend_limit_reached" })).toBe(null);
  });

  test("anything else is a plain failure", () => {
    expect(limit({ apiErrorStatus: 500, text: "api_error: overloaded" })).toBe(null);
    expect(limit({ text: "Not logged in · Please run /login" })).toBe(null);
    expect(limit({ apiErrorStatus: null, text: "Claude plan limit reached: usage limit" })).toBe(null); // words alone never count
  });
});

describe("Codex", () => {
  const snapshot = {
    limitName: null,
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(IN(1800_000) / 1000) },
    secondary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: Math.floor(IN(400_000_00) / 1000) },
    planType: "pro",
    rateLimitReachedType: "rate_limit_reached",
  };

  test("usageLimitExceeded waits, with the reset from the account's own windows", () => {
    const hit = codexLimitHit({ info: "usageLimitExceeded", message: "You've hit your usage limit for 5h.", snapshot, now: NOW });
    expect(hit).toEqual({ kind: "usage", label: "5-hour", resetsAt: IN(1800_000), source: "snapshot" });
  });

  test("rateLimitExceeded is a rate limit", () => {
    expect(codexLimitHit({ info: "rateLimitExceeded", message: "Rate limit reached.", snapshot, now: NOW })).toMatchObject({ kind: "rate" });
  });

  test("with no snapshot, a time in the words", () => {
    const hit = codexLimitHit({ info: "usageLimitExceeded", message: "You've hit your usage limit for 5h. Try again in 45 minutes.", now: NOW });
    expect(hit).toMatchObject({ resetsAt: IN(45 * 60_000), source: "text", label: null });
  });

  test("with nothing saying when, it waits without a time", () => {
    expect(codexLimitHit({ info: "usageLimitExceeded", message: "You've hit your usage limit.", now: NOW })).toEqual({ kind: "usage", label: null, resetsAt: null, source: "none" });
  });

  test("a custom model server behind the chat adapter: its 429 words carry the retry-after", () => {
    // The adapter turns an upstream 429 into rate_limit_exceeded with the Retry-After in the words; Codex retries that
    // itself, and when it gives up the hub reads the time back out (hub/src/adapter/index.ts upstreamProblem).
    const hit = codexLimitHit({ info: "rateLimitExceeded", message: "Kimi is busy right now. Wait a moment and try again. Try again in 30 seconds.", now: NOW });
    expect(hit).toEqual({ kind: "rate", label: null, resetsAt: IN(30_000), source: "text" });
    // The adapter's quota-or-credit wording is a different Codex error entirely, and never waits.
    expect(codexLimitHit({ info: "badRequest", message: "Kimi says you're out of quota or credit.", now: NOW })).toBe(null);
  });

  test("Codex's own budget, a full conversation and credits are not waits", () => {
    expect(codexLimitHit({ info: "sessionBudgetExceeded", message: "This session has reached its budget.", now: NOW })).toBe(null);
    expect(codexLimitHit({ info: "contextWindowExceeded", message: "The conversation is too long.", now: NOW })).toBe(null);
    expect(codexLimitHit({ info: "unauthorized", message: "Not signed in.", now: NOW })).toBe(null);
    expect(codexLimitHit({ info: null, message: "You've hit your usage limit.", now: NOW })).toBe(null);
    expect(codexLimitHit({ info: "usageLimitExceeded", message: "Out of credits.", snapshot: { ...snapshot, rateLimitReachedType: "workspace_owner_credits_depleted" }, now: NOW })).toBe(null);
  });
});

describe("the agents with no typed error (Muse, Gemini, a custom model server)", () => {
  const hit = (text: string, opts: Parameters<typeof textLimitHit>[1] = {}) => textLimitHit(text, { now: NOW, ...opts });

  test("a clear limit waits; a retry-after header sets the time", () => {
    expect(hit("The server answered 429: too many requests")).toMatchObject({ kind: "rate", resetsAt: null });
    expect(hit("429 too many requests", { retryAfter: "90" })).toMatchObject({ resetsAt: IN(90_000), source: "retry-after" });
    expect(hit("RESOURCE_EXHAUSTED: the free tier's daily limit", { windows: [{ label: "Daily", usedPercent: 100, resetsAt: IN(3600_000) }] })).toMatchObject({ kind: "usage", label: "Daily", resetsAt: IN(3600_000) });
  });

  test("money never waits, and a vague 'quota' alone isn't enough", () => {
    expect(hit("Kimi says you're out of quota or credit. Add credit with Kimi, then try again.")).toBe(null);
    expect(hit("429: insufficient_quota, please check your plan and billing details")).toBe(null);
    expect(hit("quota exceeded")).toBe(null);
    // The same words with a time are a limit that resets.
    expect(hit("quota exceeded, try again in 10 minutes")).toMatchObject({ resetsAt: IN(10 * 60_000) });
  });

  test("ordinary failures are left alone", () => {
    expect(hit("Muse Code isn't signed in on the hub.")).toBe(null);
    expect(hit("fetch failed: ECONNREFUSED 127.0.0.1:8080")).toBe(null);
    expect(hit("")).toBe(null);
    expect(hit("The conversation is longer than the model can read")).toBe(null);
  });
});
