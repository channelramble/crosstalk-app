// Telling a usage or rate limit that will reset from every other failure, per agent, and working out when it comes
// back (engine.ts waits for that, instead of leaving a failed reply). Detection is structured and per driver — Claude
// Code's api_error_status plus its rate_limit_event, Codex's codexErrorInfo — never a regex over an error sentence:
// credit, quota and spend failures read almost the same and never reset, so retrying one would be a silent hang.
// Every lookalike below has a test in hub/test/limits.test.ts.

import type { LimitSource, UsageWindow } from "@crosstalk/shared";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What a driver reports when a limit (not a plain error) ended the turn. */
export interface LimitHit {
  /** A plan's usage limit (out of messages until it resets), or a rate limit (too many requests just now). */
  kind: "usage" | "rate";
  /** Which limit, in the agent's own words ("5-hour", "Weekly"), or null when it didn't say. */
  label: string | null;
  /** When it comes back (epoch ms), or null when nothing said. */
  resetsAt: number | null;
  source: LimitSource;
}

/**
 * Money, not a limit that resets: these never get an automatic retry, however much they read like one. Claude Code's
 * credit errors, an API key's spend cap, OpenAI's empty wallet, and the chat adapter's own "out of quota or credit".
 */
const MONEY = /credits?_required|requires_usage_credits|usage_credits|credit limit|credit balance|out of credit|insufficient_quota|spend[_ ]limit|billing|payment|top ?up|purchase|invoice|out of quota or credit/i;

/** Claude Code's typed `api_error` values that mean credits, not a window that resets. */
const CLAUDE_MONEY_ERRORS = new Set(["model_requires_usage_credits", "long_context_credits_required", "credits_required", "service_spend_limit_reached"]);

/** Words that mean a limit which resets. Checked only after MONEY has been ruled out. */
const LIMIT_WORDS = /\b429\b|too many requests|rate[_ ]?limit|usage limit|RESOURCE_EXHAUSTED|quota exceeded|out of messages/i;

/** A limit without a reset time anywhere: the engine backs off instead of guessing. */
const UNKNOWN: Pick<LimitHit, "resetsAt" | "source"> = { resetsAt: null, source: "none" };

/** Epoch seconds or milliseconds (both agents send seconds) as milliseconds; null for anything else. */
export function epochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/** How far ahead a reset time is believed: a year out is a wrong unit or a stale message, not a wait. */
const MAX_AHEAD_MS = 7 * 24 * 3600_000;

function believable(at: number | null, now: number): number | null {
  return at !== null && at > now - 3600_000 && at < now + MAX_AHEAD_MS ? at : null;
}

/**
 * A reset time said in words: an HTTP retry-after (seconds), Gemini's retryDelayMs, "resets in 2 hours", or a clock
 * time ("resets at 3:20 PM", Codex's "Try again at 15:04"). A clock time that has gone is taken as tomorrow's, which
 * the engine's day-long cap keeps safe. Null when nothing readable is there.
 */
export function resetFromText(text: string | null | undefined, now = Date.now()): { resetsAt: number; source: LimitSource } | null {
  if (!text) return null;
  const s = String(text);
  const ms = /retry[-_ ]?delay[-_ ]?ms["':\s]+(\d+)/i.exec(s);
  if (ms) return { resetsAt: now + Number(ms[1]), source: "retry-after" };
  const after = /retry[-_ ]?after["':\s]+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hours)?\b/i.exec(s);
  if (after) return { resetsAt: now + Number(after[1]) * unitMs(after[2]), source: "retry-after" };
  const inWhile = /(?:resets?|retry|try again|available|back)\b[^.\n]{0,20}?\bin\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(s);
  if (inWhile) return { resetsAt: now + Number(inWhile[1]) * unitMs(inWhile[2]), source: "text" };
  const at = /(?:resets?|try again|retry|back|available)\b[^.\n]{0,20}?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(s);
  if (at) {
    const meridiem = at[3]?.toLowerCase();
    let hour = Number(at[1]);
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23) return null;
    const when = new Date(now);
    when.setHours(hour, Number(at[2] ?? 0), 0, 0);
    // Before now: the agents' wording means the next time it comes round.
    if (when.getTime() <= now) when.setDate(when.getDate() + 1);
    return { resetsAt: when.getTime(), source: "text" };
  }
  return null;
}

function unitMs(unit: string | undefined): number {
  const u = (unit ?? "s").toLowerCase();
  if (u.startsWith("d")) return 24 * 3600_000;
  if (u.startsWith("h")) return 3600_000;
  if (u.startsWith("m")) return 60_000;
  return 1000;
}

/** The window a limit is about: the one it rejected, else the fullest one whose reset hasn't gone. */
function fromWindows(windows: UsageWindow[] | undefined, now: number): { label: string | null; resetsAt: number | null } | null {
  const usable = (windows ?? []).filter((w) => (w.usedPercent ?? 0) >= 95 && w.resetsAt && w.resetsAt > now);
  const best = usable.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0) || a.resetsAt! - b.resetsAt!)[0];
  return best ? { label: best.label, resetsAt: best.resetsAt } : null;
}

/**
 * Claude Code. Two independent signals, so losing one still works: the turn's `result` carries `api_error_status` 429
 * (a plan limit and a Messages-API 429 both land there), and a `rate_limit_event` of this turn was "rejected" or at
 * 100% (`rejected`). Credit cases are ruled out first: they have no reset. Reset time from the rejected window, else
 * the fullest window, else a time in Claude Code's own wording ("resets 3pm").
 */
export function claudeLimitHit(ev: {
  apiErrorStatus?: unknown;
  apiError?: unknown;
  text?: string | null;
  /** The window a rate_limit_event of this turn said was rejected, if any. */
  rejected?: UsageWindow | null;
  /** Every window the process has reported, for a fallback reset time. */
  windows?: UsageWindow[];
  now?: number;
}): LimitHit | null {
  const now = ev.now ?? Date.now();
  const text = ev.text ?? "";
  if (typeof ev.apiError === "string" && CLAUDE_MONEY_ERRORS.has(ev.apiError)) return null;
  if (MONEY.test(text)) return null;
  const http429 = typeof ev.apiErrorStatus === "number" && ev.apiErrorStatus === 429;
  if (!http429 && !ev.rejected) return null;
  const kind: LimitHit["kind"] = ev.rejected || /usage limit|out of messages/i.test(text) ? "usage" : "rate";
  if (ev.rejected?.resetsAt && ev.rejected.resetsAt > now) return { kind, label: ev.rejected.label, resetsAt: ev.rejected.resetsAt, source: "event" };
  const window = fromWindows(ev.windows, now);
  if (window?.resetsAt) return { kind, label: window.label, resetsAt: window.resetsAt, source: "snapshot" };
  const said = resetFromText(text, now);
  const resetsAt = believable(said?.resetsAt ?? null, now);
  if (said && resetsAt) return { kind, label: ev.rejected?.label ?? window?.label ?? null, resetsAt, source: said.source };
  return { kind, label: ev.rejected?.label ?? window?.label ?? null, ...UNKNOWN };
}

/**
 * Codex. Its TurnError carries the reason as a typed `codexErrorInfo`: only `usageLimitExceeded` and
 * `rateLimitExceeded` reset. `sessionBudgetExceeded` is Codex's own budget for the thread and `contextWindowExceeded`
 * is a full conversation: neither resets, so neither waits. Reset time from the account's own rate-limit snapshot
 * (seconds), else a time in the message.
 */
export function codexLimitHit(ev: { info?: unknown; message?: string | null; details?: string | null; snapshot?: Json; now?: number }): LimitHit | null {
  const now = ev.now ?? Date.now();
  const info = typeof ev.info === "string" ? ev.info : null;
  if (info !== "usageLimitExceeded" && info !== "rateLimitExceeded") return null;
  const text = [ev.message, ev.details].filter(Boolean).join(" ");
  // A workspace out of credits reports the same error info: that one is money, and never retried.
  const reached = typeof ev.snapshot?.rateLimitReachedType === "string" ? ev.snapshot.rateLimitReachedType : "";
  if (/credits_depleted/.test(reached) || MONEY.test(text)) return null;
  const kind: LimitHit["kind"] = info === "usageLimitExceeded" ? "usage" : "rate";
  const window = codexWindow(ev.snapshot, now);
  if (window?.resetsAt) return { kind, label: window.label, resetsAt: window.resetsAt, source: "snapshot" };
  const said = resetFromText(text, now);
  const resetsAt = believable(said?.resetsAt ?? null, now);
  if (said && resetsAt) return { kind, label: window?.label ?? null, resetsAt, source: said.source };
  return { kind, label: window?.label ?? null, ...UNKNOWN };
}

/** The window of a Codex RateLimitSnapshot the limit is about: the fullest one whose reset is still ahead. */
function codexWindow(snapshot: Json, now: number): { label: string | null; resetsAt: number | null } | null {
  if (!snapshot) return null;
  const windows: UsageWindow[] = [];
  for (const [key, w] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]] as const) {
    if (!w) continue;
    windows.push({ label: codexWindowLabel(w.windowDurationMins, snapshot.limitName ?? key), usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : null, resetsAt: epochMs(w.resetsAt) });
  }
  return fromWindows(windows, now) ?? null;
}

/** Codex window durations in words, as codex.ts labels them for the usage page. */
function codexWindowLabel(mins: unknown, fallback: string): string {
  const m = typeof mins === "number" ? mins : 0;
  if (!m) return fallback;
  if (m === 300) return "5-hour";
  if (m === 10080) return "Weekly";
  if (m === 1440) return "Daily";
  if (m % 1440 === 0) return `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}-hour`;
  return `${m}-minute`;
}

/**
 * The agents with no typed error (Muse, Gemini and antigravity over ACP, a custom model server behind the chat
 * adapter): their failures are sentences, so this is deliberately narrow. A clear limit signal (an HTTP 429,
 * RESOURCE_EXHAUSTED, "rate limit", "usage limit"), with nothing about money anywhere, and — for the vaguer "quota"
 * wording — only when something also says when it comes back.
 */
export function textLimitHit(message: string | null | undefined, opts: { retryAfter?: string | number | null; windows?: UsageWindow[]; now?: number } = {}): LimitHit | null {
  const now = opts.now ?? Date.now();
  const text = String(message ?? "");
  if (!text.trim()) return null;
  if (MONEY.test(text)) return null;
  if (!LIMIT_WORDS.test(text)) return null;
  const vague = !/\b429\b|too many requests|rate[_ ]?limit|usage limit|RESOURCE_EXHAUSTED/i.test(text);
  const kind: LimitHit["kind"] = /usage limit|RESOURCE_EXHAUSTED|out of messages/i.test(text) ? "usage" : "rate";
  const header = typeof opts.retryAfter === "number" ? opts.retryAfter : typeof opts.retryAfter === "string" ? Number(opts.retryAfter) : NaN;
  if (Number.isFinite(header) && header > 0) return { kind, label: null, resetsAt: now + header * 1000, source: "retry-after" };
  const window = fromWindows(opts.windows, now);
  if (window?.resetsAt) return { kind, label: window.label, resetsAt: window.resetsAt, source: "snapshot" };
  const said = resetFromText(text, now);
  const resetsAt = believable(said?.resetsAt ?? null, now);
  if (said && resetsAt) return { kind, label: null, resetsAt, source: said.source };
  return vague ? null : { kind, label: window?.label ?? null, ...UNKNOWN };
}
