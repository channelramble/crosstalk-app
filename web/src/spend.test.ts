import { expect, test } from "bun:test";
import type { AccountSpend, BudgetState, SpendTotals } from "@crosstalk/shared";
import { accountName, accountOfMember, accountSub, addToLimit, anyApproximate, BEFORE_COSTS, billedAccounts, chatSpendLine, groupRestFigures, groupRestLine, groupSpendLine, LIMIT_HELP, lineFigures, limitApproximate, limitMeter, limitProblem, limitRefusal, limitText, meterState, newNotices, parseLimit, periodWords, sharedLimitNote, stoppedText, sumTotals, totalHelp, totalsLabel, unpricedLine, usedOfLimit, visibleAccounts, warnText } from "./spend";

// `estimated` (replies priced from tokens) is only there when a test says so, as an older hub sends none.
const totals = (usd: number, replies = 1, unpriced = 0, estimated?: number): SpendTotals => ({ usd, replies, unpriced, inputTokens: replies * 1000, outputTokens: replies * 200, ...(estimated === undefined ? {} : { estimated }) });
const budget = (usedUsd: number, limitUsd = 250, over: Partial<BudgetState> = {}): BudgetState => ({ limitUsd, period: "month", since: 0, usedUsd, percent: Math.floor((usedUsd / limitUsd) * 100), state: "ok", ...over });
const account = (over: Partial<AccountSpend> = {}): AccountSpend => ({ provider: "claude", account: "work", label: "API key", kind: "apikey", today: totals(0.5), month: totals(12), total: totals(48, 90), budget: null, ...over });

test("the meter warns from 80% and stops at 100%, not at the shared 70 and 90", () => {
  expect(meterState(0, 250)).toBe("ok");
  expect(meterState(174, 250)).toBe("ok"); // 69.6%
  expect(meterState(179, 250)).toBe("ok"); // 71.6%: the old meter would already warn
  expect(meterState(199.99, 250)).toBe("ok");
  expect(meterState(200, 250)).toBe("warn"); // exactly 80%
  expect(meterState(225, 250)).toBe("warn"); // 90%: the old meter would be full
  expect(meterState(249.99, 250)).toBe("warn");
  expect(meterState(250, 250)).toBe("stopped");
  expect(meterState(280, 250)).toBe("stopped");
  expect(meterState(5, 0)).toBe("ok");
  expect(meterState(Number.NaN, 250)).toBe("ok");
});

test("a limit's bar says how much is used, rounding down and never drawn past full", () => {
  expect(limitMeter({ usedUsd: 200, limitUsd: 250 })).toEqual({ percent: 80, width: 80, state: "warn" });
  expect(limitMeter({ usedUsd: 29, limitUsd: 100 })).toEqual({ percent: 29, width: 29, state: "ok" }); // 0.29 * 100 is 28.999… in floating point
  expect(limitMeter({ usedUsd: 249.9, limitUsd: 250 }).percent).toBe(99);
  expect(limitMeter({ usedUsd: 250, limitUsd: 250 })).toEqual({ percent: 100, width: 100, state: "stopped" });
  // Replies already running overshoot: the text can say 112%, the bar stays full.
  expect(limitMeter({ usedUsd: 281, limitUsd: 250 })).toEqual({ percent: 112, width: 100, state: "stopped" });
  expect(limitMeter({ usedUsd: 0, limitUsd: 0 })).toEqual({ percent: 0, width: 0, state: "ok" });
  expect(limitMeter({ usedUsd: -3, limitUsd: 50 }).percent).toBe(0);
});

test("a limit reads as dollars used of the limit, for the period it counts", () => {
  expect(usedOfLimit({ usedUsd: 200, limitUsd: 250 })).toBe("$200 of $250");
  expect(usedOfLimit({ usedUsd: 3.5, limitUsd: 50 })).toBe("$3.50 of $50.00");
  expect(periodWords({ period: "month", since: 0 })).toBe("this month");
  expect(periodWords({ period: "total", since: Date.UTC(2026, 9, 3, 12) })).toBe("since Oct 3");
  expect(periodWords({ period: "total", since: 0 })).toBe("in total");
});

test("replies without a price are counted in words, and only when there are some", () => {
  expect(unpricedLine(0)).toBeNull();
  expect(unpricedLine(1)).toBe("1 reply without a price");
  expect(unpricedLine(3)).toBe("3 replies without a price");
});

test("totals add up across accounts, and an all-unpriced period shows a dash", () => {
  const sum = sumTotals([totals(1.25, 2, 1), totals(0.5, 3), totals(10, 1)]);
  expect(sum).toEqual({ usd: 11.75, replies: 6, unpriced: 1, estimated: 0, inputTokens: 6000, outputTokens: 1200 });
  expect(sumTotals([])).toEqual({ usd: 0, replies: 0, unpriced: 0, estimated: 0, inputTokens: 0, outputTokens: 0 });
  expect(totalsLabel(totals(0.04))).toBe("$0.04");
  expect(totalsLabel(totals(0, 0))).toBe("$0.00");
  expect(totalsLabel(totals(2, 4, 1))).toBe("$2.00");
  expect(totalsLabel(totals(0, 2, 2))).toBe("—");
});

test("figures worked out from tokens are drawn with ≈, including the sums, and never beside a dash", () => {
  // The estimated replies add up with the rest (an account that has none, or an older hub that doesn't say, adds nothing).
  expect(sumTotals([totals(1, 2, 0, 1), totals(2, 3), totals(3, 1, 0, 2)]).estimated).toBe(3);
  expect(totalsLabel(totals(200, 60, 0, 12))).toBe("≈$200");
  expect(totalsLabel(totals(0.04, 1, 0, 1))).toBe("≈$0.04");
  expect(totalsLabel(totals(2, 4, 1, 3))).toBe("≈$2.00");
  expect(totalsLabel(totals(200, 60, 0, 0))).toBe("$200");
  expect(totalsLabel(totals(200, 60))).toBe("$200");
  expect(totalsLabel(totals(0, 2, 2, 1))).toBe("—");
  // The sum over accounts is approximate when any account's figure is.
  expect(totalsLabel(sumTotals([totals(100, 5), totals(1, 1, 0, 1)]))).toBe("≈$101");
  expect(totalsLabel(sumTotals([totals(100, 5), totals(1, 1)]))).toBe("$101");
});

test("a limit's figure is drawn with ≈ when the period it counts has estimated replies", () => {
  expect(usedOfLimit({ usedUsd: 200, limitUsd: 250 }, true)).toBe("≈$200 of $250");
  expect(usedOfLimit({ usedUsd: 200, limitUsd: 250 }, false)).toBe("$200 of $250");
  const monthly = account({ month: totals(200, 60, 0, 5), total: totals(300, 200), budget: budget(200) });
  expect(limitApproximate(monthly)).toBe(true);
  // A limit counted in total looks at the total, not the month.
  const inTotal = { ...monthly, budget: budget(300, 500, { period: "total" as const }) };
  expect(limitApproximate(inTotal)).toBe(false);
  expect(limitApproximate({ ...inTotal, total: totals(300, 200, 0, 1) })).toBe(true);
  // No limit, no line; a period with no price at all is a dash, not an estimate.
  expect(limitApproximate(account({ month: totals(200, 60, 0, 5) }))).toBe(false);
  expect(limitApproximate(account({ month: totals(0, 2, 2, 1), budget: budget(0) }))).toBe(false);
});

test("the screen explains ≈ only when one is drawn", () => {
  const plain = account({ today: totals(1), month: totals(12), total: totals(48, 90, 0, 0) });
  expect(anyApproximate([])).toBe(false);
  expect(anyApproximate([plain, account({ account: "b" })])).toBe(false);
  expect(anyApproximate([plain, account({ account: "b", today: totals(1, 2, 0, 1) })])).toBe(true);
  expect(anyApproximate([account({ total: totals(48, 90, 0, 90) })])).toBe(true);
  expect(anyApproximate([account({ today: totals(0, 0), month: totals(0, 0), total: totals(0, 2, 2, 1) })])).toBe(false);
});

test("an account's line says how it is billed, and leaves the agent to its name", () => {
  expect(accountSub(account())).toBe("API key");
  expect(accountSub(account({ label: "Main", kind: "signin" }))).toBe("Plan sign-in");
  expect(accountSub(account({ provider: "codex", label: "Kimi on Together", kind: "endpoint" }))).toBe("AI service");
});

test("an account's name has its agent, once, so two sign-ins called Main can be told apart", () => {
  expect(accountName(account())).toBe("API key · Claude Code");
  expect(accountName(account({ label: "Claude Code", kind: "signin" }))).toBe("Claude Code");
  expect(accountName(account({ provider: "codex", label: "Kimi on Together" }))).toBe("Kimi on Together · Codex");
  // What the hub calls a default sign-in, for either agent.
  expect(accountName(account({ label: "Main", kind: "signin" }))).toBe("Main · Claude Code");
  expect(accountName(account({ provider: "codex", label: "Main", kind: "signin" }))).toBe("Main · Codex");
});

test("only accounts that can have a limit, or that have replied, get a card", () => {
  const idle = account({ kind: "signin", account: "a", total: totals(0, 0) });
  const used = account({ kind: "signin", account: "b" });
  const limited = account({ kind: "signin", account: "c", total: totals(0, 0), budget: budget(0) });
  const key = account({ account: "d", total: totals(0, 0) });
  expect(visibleAccounts([idle, used, limited, key]).map((a) => a.account)).toEqual(["b", "c", "d"]);
});

test("only billed accounts are added together: a plan sign-in's figure is what its use would cost", () => {
  const plan = account({ kind: "signin", account: "p", label: "Main", month: totals(12.3, 40), total: totals(48, 120) });
  const key = account({ account: "k" });
  const service = account({ kind: "endpoint", account: "s", provider: "codex", label: "Kimi on Together" });
  const idle = account({ account: "i", total: totals(0, 0) });
  expect(billedAccounts([plan, key, service, idle]).map((a) => a.account)).toEqual(["k", "s", "i"]);
  expect(billedAccounts([plan])).toEqual([]);
  // The key's $12 and the service's $12: not the plan's $12.30 as well.
  expect(sumTotals(billedAccounts([plan, key, service]).map((a) => a.month)).usd).toBe(24);
});

test("the notices say 80% and 100% in the spec's words", () => {
  expect(warnText({ label: "API key" }, { usedUsd: 200, limitUsd: 250 })).toBe("API key has used $200 of its $250 limit.");
  expect(stoppedText({ label: "API key" }, { limitUsd: 250 })).toBe("API key reached its $250 limit, so new replies won't start.");
});

test("a notice comes once, when an account crosses 80% or its limit", () => {
  const at = (used: number, over: Partial<BudgetState> = {}) => [account({ budget: budget(used, 250, over) })];
  expect(newNotices(at(100), at(200))).toEqual([{ level: "warn", text: "API key has used $200 of its $250 limit." }]);
  // Still over 80%: nothing more.
  expect(newNotices(at(200), at(220))).toEqual([]);
  expect(newNotices(at(220), at(251))).toEqual([{ level: "error", text: "API key reached its $250 limit, so new replies won't start." }]);
  // A big reply that goes from quiet to over the limit says it has stopped, not that it warns.
  expect(newNotices(at(100), at(255))).toEqual([{ level: "error", text: "API key reached its $250 limit, so new replies won't start." }]);
  expect(newNotices(at(260), at(270))).toEqual([]);
  // Going down (a new month, a raised limit) is no news.
  expect(newNotices(at(220), at(10))).toEqual([]);
});

test("opening the app, or changing a limit yourself, is no news", () => {
  const withLimit = (used: number, limit: number, period: "month" | "total" = "month") => [account({ budget: budget(used, limit, { period }) })];
  // No earlier look: the first figures only set the baseline.
  expect(newNotices(null, withLimit(220, 250))).toEqual([]);
  // The limit was lowered under what's used, or its period changed.
  expect(newNotices(withLimit(100, 500), withLimit(100, 120))).toEqual([]);
  expect(newNotices(withLimit(100, 120), withLimit(100, 120, "total"))).toEqual([]);
  // A limit that was just set, or never had one.
  expect(newNotices([account()], withLimit(220, 250))).toEqual([]);
  expect(newNotices(withLimit(220, 250), [account()])).toEqual([]);
  // A different account's figures don't count for this one.
  expect(newNotices([account({ account: "other", budget: budget(10) })], withLimit(220, 250))).toEqual([]);
});

test("each account that crossed gets its own notice", () => {
  const was = [account({ account: "a", label: "Work key", budget: budget(10, 100) }), account({ account: "b", label: "Home key", budget: budget(10, 100) })];
  const now = [account({ account: "a", label: "Work key", budget: budget(85, 100) }), account({ account: "b", label: "Home key", budget: budget(20, 100) })];
  expect(newNotices(was, now).map((n) => n.text)).toEqual(["Work key has used $85.00 of its $100 limit."]);
});

test("a failed reply's text is recognised as the hub's refusal for a used-up limit", () => {
  expect(limitRefusal("API key reached its $250 limit, so this reply didn't start.")).toBe(true);
  expect(limitRefusal("Work key reached its $47.20 limit, so this reply didn’t start. Raise the limit in Settings → Costs, then tap Try again.")).toBe(true);
  expect(limitRefusal("API Error: overloaded")).toBe(false);
  expect(limitRefusal("This chat's folder isn't there any more: /tmp/x. Put it back, then tap Try again.")).toBe(false);
  expect(limitRefusal(null)).toBe(false);
  expect(limitRefusal(undefined)).toBe(false);
});

test("the limit field takes dollars the way people type them", () => {
  expect(parseLimit("50")).toBe(50);
  expect(parseLimit(" $1,200.50 ")).toBe(1200.5);
  expect(parseLimit("12.5")).toBe(12.5);
  expect(parseLimit(".75")).toBe(0.75);
  expect(parseLimit("20.")).toBe(20);
  expect(parseLimit("10.456")).toBe(10.46);
  for (const bad of ["", "   ", "0", "0.00", "0.004", "-5", "abc", "1e3", "12 dollars", "1.2.3", "$"]) expect(parseLimit(bad)).toBeNull();
  expect(parseLimit("9".repeat(400))).toBeNull();
  expect(limitText(50)).toBe("50");
  expect(limitText(12.5)).toBe("12.50");
});

test("the quick buttons add to what's in the field", () => {
  expect(addToLimit("250", 50)).toBe("300");
  expect(addToLimit("$250", 100)).toBe("350");
  expect(addToLimit("12.50", 50)).toBe("62.50");
  expect(addToLimit("", 50)).toBe("50");
  expect(addToLimit("nonsense", 100)).toBe("100");
  expect(addToLimit(addToLimit("", 50), 50)).toBe("100");
});

test("a bad limit says what to type", () => {
  expect(limitProblem("50")).toBeNull();
  expect(limitProblem("")).toBe("Type how many dollars, like 50.");
  expect(limitProblem("  ")).toBe("Type how many dollars, like 50.");
  expect(limitProblem("0")).toBe("Use an amount above $0, like 50.");
  expect(limitProblem("lots")).toBe("Use an amount above $0, like 50.");
});

test("a chat's cost line is exact, approximate or a dash, and absent before the first reply", () => {
  const chat = (usd: number, replies: number, unpriced = 0, estimated?: number) => ({ roomId: "r", usd, replies, unpriced, ...(estimated === undefined ? {} : { estimated }) });
  expect(chatSpendLine(null)).toBeNull();
  expect(chatSpendLine(undefined)).toBeNull();
  expect(chatSpendLine(chat(0, 0))).toBeNull();
  expect(chatSpendLine(chat(1.234, 4))).toBe("This chat: $1.23");
  expect(chatSpendLine(chat(1.234, 4, 1))).toBe("This chat: ≈$1.23");
  expect(chatSpendLine(chat(1.234, 4, 0, 2))).toBe("This chat: ≈$1.23");
  expect(chatSpendLine(chat(0, 3, 0, 0))).toBe("This chat: $0.00");
  expect(chatSpendLine(chat(0, 2, 2))).toBe("This chat: —");
});

test("a plan sign-in's chat is always approximate, and says it's at API prices and included in the plan", () => {
  const chat = (usd: number, replies: number, unpriced = 0, estimated?: number) => ({ roomId: "r", usd, replies, unpriced, ...(estimated === undefined ? {} : { estimated }) });
  // Even from a hub that sends no `estimated`.
  expect(chatSpendLine(chat(12.3, 4), true)).toBe("This chat: ≈$12.30 at API prices, included in your plan");
  expect(chatSpendLine(chat(12.3, 4, 0, 4), true)).toBe("This chat: ≈$12.30 at API prices, included in your plan");
  expect(chatSpendLine(chat(1.234, 4, 1), true)).toBe("This chat: ≈$1.23 at API prices, included in your plan");
  // Nothing has a price: no figure to explain, and still nothing is billed.
  expect(chatSpendLine(chat(0, 2, 2), true)).toBe("This chat: — · included in your plan");
  expect(chatSpendLine(chat(0, 0), true)).toBeNull();
  expect(chatSpendLine(null, true)).toBeNull();
  // An account that is billed stays exact when nothing is estimated, and never mentions a plan.
  expect(chatSpendLine(chat(12.3, 4), false)).toBe("This chat: $12.30");
  for (const billed of [chat(12.3, 4), chat(12.3, 4, 1), chat(12.3, 4, 0, 2), chat(0, 2, 2)]) expect(chatSpendLine(billed, false)).not.toContain("plan");
});

test("a chat's account is the one the hub's figures have for its agent and sign-in", () => {
  const figures = [
    account({ provider: "claude", account: "default", kind: "signin", label: "Main" }),
    account({ provider: "claude", account: "work", label: "Work key" }),
    account({ provider: "codex", account: "default", kind: "signin", label: "Main" }),
  ];
  expect(accountOfMember(figures, { provider: "claude", config: {} })?.kind).toBe("signin");
  expect(accountOfMember(figures, { provider: "claude", config: { account: "work" } })?.label).toBe("Work key");
  expect(accountOfMember(figures, { provider: "codex", config: {} })?.provider).toBe("codex");
  // An account the figures don't have (yet), or no figures yet.
  expect(accountOfMember(figures, { provider: "codex", config: { account: "other" } })).toBeUndefined();
  expect(accountOfMember(null, { provider: "claude", config: {} })).toBeUndefined();
});

test("a group chat's line is about the agent whose popup it is in, in its own account's words", () => {
  const figures = [account({ provider: "claude", account: "default", kind: "signin", label: "Main" }), account({ provider: "codex", account: "key", label: "Money key" })];
  // @claude on the plan sign-in, @keys on an API key, @opus on the same plan as @claude.
  const claude = { provider: "claude" as const, config: {}, handle: "claude" };
  const keys = { provider: "codex" as const, config: { account: "key" }, handle: "keys" };
  const opus = { provider: "claude" as const, config: { account: "default" }, handle: "opus" };
  const part = (provider: "claude" | "codex", acct: string, usd: number, replies: number, unpriced = 0, estimated = 0) => ({ provider, account: acct, usd, replies, unpriced, estimated });
  const cost = { roomId: "r", usd: 12.3, replies: 6, unpriced: 0, estimated: 4, byAccount: [part("claude", "default", 4.1, 4, 0, 4), part("codex", "key", 8.2, 2)] };
  // The API key's part is billed: nothing about a plan, and none of the plan's notional figure in it.
  expect(groupSpendLine(cost, keys, [claude, keys], figures)).toBe("@keys in this chat: $8.20");
  // The plan's part is what the use would cost, covered by the plan; the API key's spend isn't said to be.
  expect(groupSpendLine(cost, claude, [claude, keys], figures)).toBe("@claude in this chat: ≈$4.10 at API prices, included in your plan");
  // Two agents on one account share its part, and the line says so.
  expect(groupSpendLine(cost, opus, [claude, keys, opus], figures)).toBe("@claude and @opus in this chat: ≈$4.10 at API prices, included in your plan");
  // An agent that hasn't answered yet has no line.
  expect(groupSpendLine({ ...cost, byAccount: [part("codex", "key", 8.2, 2)] }, claude, [claude, keys], figures)).toBeNull();
  expect(lineFigures({ ...cost, byAccount: [] }, keys, true)).toBeNull();
  expect(lineFigures(cost, keys, true)).toMatchObject({ usd: 8.2, replies: 2 });
  // A one-agent chat's line is the whole chat's.
  expect(lineFigures(cost, keys, false)).toBe(cost);
  // A hub that doesn't split them: the whole chat's figure, covered by a plan only when every agent's account is.
  const whole = { roomId: "r", usd: 12.3, replies: 6, unpriced: 0, estimated: 4 };
  expect(groupSpendLine(whole, keys, [claude, keys], figures)).toBe("This chat: ≈$12.30");
  expect(groupSpendLine(whole, claude, [claude, keys], figures)).toBe("This chat: ≈$12.30");
  expect(groupSpendLine(whole, claude, [claude, opus], figures)).toBe("This chat: ≈$12.30 at API prices, included in your plan");
  expect(lineFigures(whole, keys, true)).toBe(whole);
});

test("a group chat's spend on accounts no agent in it uses now (asks, earlier accounts) is said too, in its own words", () => {
  const figures = [
    account({ provider: "claude", account: "default", kind: "signin", label: "Main" }),
    account({ provider: "codex", account: "key", label: "Money key" }),
    account({ provider: "codex", account: "openrouter", kind: "endpoint", label: "OpenRouter" }),
    account({ provider: "codex", account: "default", kind: "signin", label: "Main" }),
    account({ provider: "codex", account: "featherless", kind: "endpoint", label: "Featherless", flat: true }),
  ];
  const claude = { provider: "claude" as const, config: {}, handle: "claude" };
  const keys = { provider: "codex" as const, config: { account: "key" }, handle: "keys" };
  const agents = [claude, keys];
  const part = (provider: "claude" | "codex", acct: string, usd: number, replies: number, unpriced = 0, estimated = 0) => ({ provider, account: acct, usd, replies, unpriced, estimated });
  const chat = (...byAccount: ReturnType<typeof part>[]) => ({ roomId: "r", ...sumTotals(byAccount.map((p) => ({ ...p, inputTokens: 0, outputTokens: 0 }))), byAccount });
  // Ask others put a model on an OpenRouter key no agent here uses to work: $3.10, booked to this chat on that key.
  const asked = chat(part("claude", "default", 4.1, 4, 0, 4), part("codex", "key", 8.2, 2), part("codex", "openrouter", 3.1, 1));
  // Each agent's line keeps its own part, and the $3.10 is said under it (the popup shows it whoever's popup it is).
  expect(groupSpendLine(asked, claude, agents, figures)).toBe("@claude in this chat: ≈$4.10 at API prices, included in your plan");
  expect(groupSpendLine(asked, keys, agents, figures)).toBe("@keys in this chat: $8.20");
  expect(groupRestLine(asked, agents, figures)).toBe("Asks and earlier accounts in this chat: $3.10");
  // So nothing the chat cost is left out: the agents' parts and the rest add up to the whole chat.
  expect(4.1 + 8.2 + groupRestFigures(asked, agents)!.usd).toBeCloseTo(asked.usd, 6);
  // @keys was on the API key before it was switched to the Codex plan: what it spent there stays said, as billed.
  const keysNow = { ...keys, config: { account: "default" } };
  const switched = chat(part("claude", "default", 4.1, 4, 0, 4), part("codex", "key", 8.2, 2), part("codex", "default", 1.2, 1, 0, 1));
  expect(groupSpendLine(switched, keysNow, [claude, keysNow], figures)).toBe("@keys in this chat: ≈$1.20 at API prices, included in your plan");
  expect(groupRestLine(switched, [claude, keysNow], figures)).toBe("Asks and earlier accounts in this chat: $8.20");
  // An agent that has left: its part is the rest's now.
  expect(groupRestLine(asked, [claude], figures)).toBe("Asks and earlier accounts in this chat: $11.30");
  // Asked on a plan sign-in: what it would cost, covered by the plan, never said to be billed.
  expect(groupRestLine(chat(part("claude", "default", 4.1, 4, 0, 4), part("codex", "default", 1.2, 1, 0, 1)), agents, figures)).toBe("Asks and earlier accounts in this chat: ≈$1.20 at API prices, included in your plan");
  // Both: the billed figure, and the plan's apart from it, not added to it.
  expect(groupRestLine(chat(part("codex", "openrouter", 3.1, 1), part("codex", "default", 1.2, 1, 0, 1)), agents, figures)).toBe("Asks and earlier accounts in this chat: $3.10, plus ≈$1.20 at API prices, included in your plan");
  // A service with one flat fee for the month: no figure, and covered; beside a billed one it adds nothing to it.
  expect(groupRestLine(chat(part("codex", "featherless", 0, 2, 0, 2)), agents, figures)).toBe("Asks and earlier accounts in this chat: — · included in your plan");
  expect(groupRestLine(chat(part("codex", "featherless", 0, 2, 0, 2), part("codex", "openrouter", 3.1, 1)), agents, figures)).toBe("Asks and earlier accounts in this chat: $3.10");
  // Worked out from tokens, or some without a price: approximate. None with a price: a dash, and the count is said after it.
  expect(groupRestLine(chat(part("codex", "openrouter", 3.1, 2, 0, 2)), agents, figures)).toBe("Asks and earlier accounts in this chat: ≈$3.10");
  expect(groupRestLine(chat(part("codex", "openrouter", 3.1, 2, 1)), agents, figures)).toBe("Asks and earlier accounts in this chat: ≈$3.10");
  expect(groupRestLine(chat(part("codex", "openrouter", 0, 2, 2)), agents, figures)).toBe("Asks and earlier accounts in this chat: —");
  expect(groupRestFigures(chat(part("codex", "openrouter", 0, 2, 2), part("codex", "default", 1.2, 1, 0, 1)), agents)).toMatchObject({ replies: 3, unpriced: 2 });
  // An account the figures don't have is never said to be covered by a plan.
  expect(groupRestLine(chat(part("codex", "gone", 2, 1)), agents, figures)).toBe("Asks and earlier accounts in this chat: $2.00");
  expect(groupRestLine(chat(part("codex", "default", 1.2, 1, 0, 1)), agents, null)).toBe("Asks and earlier accounts in this chat: ≈$1.20");
  // Nothing outside the agents' parts, no spend at all, or a hub that doesn't split a chat by account: no such line.
  expect(groupRestLine(chat(part("claude", "default", 4.1, 4, 0, 4), part("codex", "key", 8.2, 2)), agents, figures)).toBeNull();
  expect(groupRestFigures(chat(part("claude", "default", 4.1, 4, 0, 4), part("codex", "key", 8.2, 2)), agents)).toBeNull();
  expect(groupRestLine(null, agents, figures)).toBeNull();
  expect(groupRestLine({ roomId: "r", usd: 15.4, replies: 7, unpriced: 0, estimated: 4 }, agents, figures)).toBeNull();
});

test("'In total' counts from the day you save it, unless a total limit exists already and keeps its start", () => {
  const saved = "Counts everything from the day you save it, and doesn't start over.";
  const since = Date.UTC(2026, 9, 3, 12);
  expect(totalHelp(null)).toBe(saved);
  expect(totalHelp(undefined)).toBe(saved);
  // A month limit changed to "in total" starts a new count: the hub keeps a start only for the same period.
  expect(totalHelp({ period: "month", since })).toBe(saved);
  expect(totalHelp({ period: "month", since: 0 })).toBe(saved);
  expect(totalHelp({ period: "total", since })).toBe("Keeps counting since Oct 3, and doesn't start over.");
  expect(totalHelp({ period: "total", since: 0 })).toBe(saved);
});

test("the limit's help says running replies can overshoot and that earlier use isn't counted", () => {
  expect(LIMIT_HELP).toContain("Replies already running can go a little over it");
  expect(LIMIT_HELP).toContain(BEFORE_COSTS);
});

test("a limit a moved service's rows share says why its count is more than the row's own figures", () => {
  expect(sharedLimitNote({})).toBeNull();
  expect(sharedLimitNote({ also: ["opencode:new"] })).toBeNull();
  expect(sharedLimitNote({ also: ["builtin:old", "opencode:new"] })).toBe("This also counts what the service spent on its other row.");
});

test("one plain sentence says the figures start with this version, so earlier use this month isn't in them", () => {
  expect(BEFORE_COSTS).toBe("Figures start when this version was installed, so earlier use this month isn't included.");
  // One sentence.
  expect(BEFORE_COSTS.match(/[.!?](\s|$)/g)).toHaveLength(1);
});
