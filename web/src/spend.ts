// What the phone says about spending (docs/SPEC-0.4.md, track T4): the maths and the words, with no screen in them, so
// they can be tested on their own. Settings → Costs, the chat's cost line and the notices at 80% and 100% use them.
import { memberAccount, PROVIDER_INFO, type AccountSpend, type Budget, type ChatSpend, type Member, type SpendTotals } from "@crosstalk/shared";
import { usd } from "./money";

/** From this share of a limit used, its bar warns. (The shared `.meter` switches at 70 and 90: costs.css has its own colours.) */
export const WARN_AT = 0.8;

export type MeterState = "ok" | "warn" | "stopped";

/** A limit's state: quiet below 80%, a warning from 80%, stopped at 100% (the hub refuses new replies then). */
export function meterState(usedUsd: number, limitUsd: number): MeterState {
  if (!(limitUsd > 0) || !Number.isFinite(usedUsd)) return "ok";
  const share = usedUsd / limitUsd;
  return share >= 1 ? "stopped" : share >= WARN_AT ? "warn" : "ok";
}

/**
 * What a limit's bar shows: the whole percent used (it can pass 100, as replies already running overshoot), the bar's
 * width (never past full) and its state. The percent rounds down, so "100%" only ever says the limit is reached.
 */
export function limitMeter(b: { usedUsd: number; limitUsd: number }): { percent: number; width: number; state: MeterState } {
  const percent = b.limitUsd > 0 && Number.isFinite(b.usedUsd) ? Math.floor((Math.max(0, b.usedUsd) / b.limitUsd) * 100 + 1e-9) : 0;
  return { percent, width: Math.min(100, percent), state: meterState(b.usedUsd, b.limitUsd) };
}

/** "$200 of $250", with "≈" before what's used when some of it was worked out from tokens (see `limitApproximate`). */
export function usedOfLimit(b: { usedUsd: number; limitUsd: number }, estimate = false): string {
  return `${estimate ? "≈" : ""}${usd(b.usedUsd)} of ${usd(b.limitUsd)}`;
}

/** A service moved to another agent with its old row still there: why this row's count can be more than its own figures. */
export function sharedLimitNote(b: Pick<Budget, "also">): string | null {
  return (b.also?.length ?? 0) > 1 ? "This also counts what the service spent on its other row." : null;
}

/** What a limit counts: "this month", or "since Oct 3" for one counted in total. */
export function periodWords(b: Pick<Budget, "period" | "since">): string {
  if (b.period === "month") return "this month";
  if (!(b.since > 0)) return "in total";
  return `since ${new Date(b.since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/**
 * What choosing "In total" says it counts. A limit that is counted in total already keeps its start when only the amount
 * changes (the hub restarts the count for a new limit, or a changed period), so raising it says so.
 */
export function totalHelp(start: Pick<Budget, "period" | "since"> | null | undefined): string {
  return start?.period === "total" && start.since > 0 ? `Keeps counting ${periodWords(start)}, and doesn't start over.` : "Counts everything from the day you save it, and doesn't start over.";
}

/** The three periods an account shows, in order. */
export const PERIODS = [
  { id: "today", label: "Today" },
  { id: "month", label: "This month" },
  { id: "total", label: "Total" },
] as const;

/**
 * A period's figures as the hub sends them. `estimated` counts the replies whose cost was worked out from tokens and a
 * price list (it isn't in the contract yet: a hub may send it, an older one doesn't).
 */
export type CostTotals = SpendTotals & { estimated?: number };

/** "3 replies without a price": replies whose cost couldn't be worked out, which the totals leave out. Null when there are none. */
export function unpricedLine(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? "reply" : "replies"} without a price` : null;
}

const NONE: Required<CostTotals> = { usd: 0, replies: 0, unpriced: 0, estimated: 0, inputTokens: 0, outputTokens: 0 };

/** Adds up totals (every billed account's, say), the replies that were estimated with the rest. */
export function sumTotals(list: CostTotals[]): Required<CostTotals> {
  return list.reduce<Required<CostTotals>>(
    (sum, t) => ({
      usd: sum.usd + t.usd,
      replies: sum.replies + t.replies,
      unpriced: sum.unpriced + t.unpriced,
      estimated: sum.estimated + (t.estimated ?? 0),
      inputTokens: sum.inputTokens + t.inputTokens,
      outputTokens: sum.outputTokens + t.outputTokens,
    }),
    NONE,
  );
}

/** A period that has replies and not one of them has a price: nothing to add up. */
const noPrice = (t: CostTotals) => t.replies > 0 && t.unpriced >= t.replies;

/** Whether a period's dollars are drawn with "≈": some of its replies were priced from tokens and a price list. */
export function approximate(t: CostTotals): boolean {
  return (t.estimated ?? 0) > 0 && !noPrice(t);
}

/** A period's dollars: "≈$200" when some replies were estimated, "—" when it has replies and none has a price. */
export function totalsLabel(t: CostTotals): string {
  return noPrice(t) ? "—" : `${approximate(t) ? "≈" : ""}${usd(t.usd)}`;
}

/** Whether a limit's used figure is drawn with "≈": the period the limit counts has replies priced from tokens. */
export function limitApproximate(a: Pick<AccountSpend, "month" | "total" | "budget">): boolean {
  return !!a.budget && approximate(a.budget.period === "month" ? a.month : a.total);
}

/** Whether any of these accounts has a figure drawn with "≈", so the screen says what that means. */
export function anyApproximate(list: Pick<AccountSpend, "today" | "month" | "total">[]): boolean {
  return list.some((a) => approximate(a.today) || approximate(a.month) || approximate(a.total));
}

/** What "≈" means, said once under the figures when any is shown. */
export const APPROX_NOTE = "≈ means worked out from a reply's tokens and a price list.";

const KIND_WORDS: Record<AccountSpend["kind"], string> = { signin: "Plan sign-in", apikey: "API key", endpoint: "AI service" };

/**
 * Said on the card of an account whose key is on a plan of one flat fee for the month: only a Featherless key the hub
 * read as on its Chat plan (hub/src/featherless.ts flatRate). Its replies carry no price, so there is no figure to add up
 * and nothing for a limit to count — and that plan's terms don't allow agents, which every reply here is, so it says
 * that too, and what agents need instead. Featherless's Developer plan is billed per token and priced like any other.
 */
export const FLAT_RATE_NOTE = "This key is on Featherless's Chat plan: one flat fee for the month, so replies have no price here and nothing for a limit to count. That plan doesn't allow agents or API use. Agents need its Developer plan, paid per token, which a limit here can count.";

/** The line under an account's name: how the account is billed. (The name has the agent in it already: see `accountName`.) */
export function accountSub(a: Pick<AccountSpend, "kind">): string {
  return KIND_WORDS[a.kind] ?? "";
}

/** An account's name, on its card and in a sentence: its label, with the agent when the label doesn't say it ("Main · Claude Code"). */
export function accountName(a: Pick<AccountSpend, "provider" | "label">): string {
  const agent = PROVIDER_INFO[a.provider]?.name ?? a.provider;
  return a.label.includes(agent) ? a.label : `${a.label} · ${agent}`;
}

/** The accounts worth a card: any that can have a limit (an API key or an AI service), and plan sign-ins that have replied. */
export function visibleAccounts(list: AccountSpend[]): AccountSpend[] {
  return list.filter((a) => a.kind !== "signin" || a.total.replies > 0 || !!a.budget);
}

/** The accounts that are billed: API keys and AI services. A plan sign-in's figures are what its use would cost, so they're never added to these. */
export function billedAccounts(list: AccountSpend[]): AccountSpend[] {
  return list.filter((a) => a.kind !== "signin");
}

/**
 * What the figures leave out: the hub's record starts empty when this version first runs, and never reads older replies,
 * so what you spent earlier this month isn't in the figures, and a monthly limit can't count it. Said once under the
 * figures in Settings → Costs, and in a limit's help.
 */
export const BEFORE_COSTS = "Figures start when this version was installed, so earlier use this month isn't included.";

/** What "?" says about a limit. Replies already running can't be stopped by it, and the hub only knows a reply's cost when it ends. */
export const LIMIT_HELP = `Once this account has spent this much, new replies won't start until you raise or remove the limit. Replies already running can go a little over it, because a reply's cost is only known when it ends. ${BEFORE_COSTS}`;

// ---- Notices: crossing 80% and 100% ----

export interface SpendNotice {
  level: "warn" | "error";
  text: string;
}

/** "API key has used $200 of its $250 limit." */
export function warnText(a: Pick<AccountSpend, "label">, b: { usedUsd: number; limitUsd: number }): string {
  return `${a.label} has used ${usd(b.usedUsd)} of its ${usd(b.limitUsd)} limit.`;
}

/** What a notice says when a limit is reached (the refused reply itself says "so this reply didn't start"). */
export function stoppedText(a: Pick<AccountSpend, "label">, b: { limitUsd: number }): string {
  return `${a.label} reached its ${usd(b.limitUsd)} limit, so new replies won't start.`;
}

const RANK: Record<MeterState, number> = { ok: 0, warn: 1, stopped: 2 };

/**
 * What to tell you after the hub sent new figures: each account that went from under 80% to over it, or to its limit.
 * Nothing without an earlier look (`prev` null: opening the app while an account is already at 80% isn't news), and
 * nothing for a limit that was just set, changed or removed (that was you).
 */
export function newNotices(prev: AccountSpend[] | null, next: AccountSpend[]): SpendNotice[] {
  if (!prev) return [];
  const out: SpendNotice[] = [];
  for (const a of next) {
    const now = a.budget;
    const before = prev.find((p) => p.provider === a.provider && p.account === a.account)?.budget;
    if (!now || !before || before.limitUsd !== now.limitUsd || before.period !== now.period) continue;
    const to = meterState(now.usedUsd, now.limitUsd);
    if (RANK[to] <= RANK[meterState(before.usedUsd, before.limitUsd)]) continue;
    out.push(to === "warn" ? { level: "warn", text: warnText(a, now) } : { level: "error", text: stoppedText(a, now) });
  }
  return out;
}

/**
 * Whether a failed reply's text is the hub refusing it for a used-up limit ("API key reached its $250 limit, so this
 * reply didn't start."). Used when the account's figures aren't loaded to say so.
 */
export function limitRefusal(text: string | null | undefined): boolean {
  return !!text && /reached its .{0,30}?limit\b[^.]*didn.t start/i.test(text);
}

// ---- The limit field ----

/** The dollars typed for a limit ("50", "$1,200.50", " 75 "), as a positive amount in whole cents; null when it isn't one. */
export function parseLimit(text: string): number | null {
  const t = text.replace(/[\s$,]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents / 100 : null;
}

/** An amount as the field shows it: "50", "12.50". */
export function limitText(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** The field with `add` dollars more in it (+$50, +$100); an empty or unreadable field counts as nothing. */
export function addToLimit(text: string, add: number): string {
  return limitText(Math.round(((parseLimit(text) ?? 0) + add) * 100) / 100);
}

/** What's wrong with the field, in words that say what to type; null when it's fine. */
export function limitProblem(text: string): string | null {
  if (!text.trim()) return "Type how many dollars, like 50.";
  return parseLimit(text) === null ? "Use an amount above $0, like 50." : null;
}

// ---- A chat's cost ----

/** What `GET /api/rooms/:id/spend` says. `estimated` (replies priced from tokens) isn't in the contract yet: a hub may send it. */

/** The figures of the account a chat's agent signs in with, once the hub has sent them. */
export function accountOfMember(figures: AccountSpend[] | null | undefined, m: Pick<Member, "provider" | "config">): AccountSpend | undefined {
  return figures?.find((a) => a.provider === m.provider && a.account === memberAccount(m));
}

/** What a plan sign-in's chat line says after its figure: the plan covers the use, so nothing is billed. */
export const PLAN_INCLUDED = "included in your plan";

/** A chat's figures, or one account's part of them. */
export type ChatFigures = Pick<ChatSpend, "usd" | "replies" | "unpriced" | "estimated">;

/**
 * The line in a chat: "This chat: $1.23". "≈" when it isn't exact (some replies were priced from tokens, or have no
 * price and are left out, or `plan`: a plan sign-in's figure is only what the use would cost), "—" when none has a
 * price, nothing before the first reply. A plan sign-in's line says what the figure is and that it isn't a bill:
 * "This chat: ≈$12.30 at API prices, included in your plan". `label`: whose figures they are, when not the whole
 * chat's ("@keys in this chat").
 */
export function chatSpendLine(c: ChatFigures | null | undefined, plan = false, flat = false, label = "This chat"): string | null {
  if (!c || !(c.replies > 0)) return null;
  return `${label}: ${figureWords(c, plan, flat)}`;
}

/** What `chatSpendLine` says after its label: "$1.23", "≈$12.30 at API prices, included in your plan", "—". */
function figureWords(c: ChatFigures, plan: boolean, flat: boolean): string {
  // A flat monthly plan has no per-reply price at all, and the hub keeps every reply on it at nothing: a dash, with
  // what covers it, instead of "$0.00" on a service you do pay for.
  if (flat) return `— · ${PLAN_INCLUDED}`;
  if (c.unpriced >= c.replies) return plan ? `— · ${PLAN_INCLUDED}` : "—";
  const figure = `${plan || c.unpriced > 0 || (c.estimated ?? 0) > 0 ? "≈" : ""}${usd(c.usd)}`;
  return plan ? `${figure} at API prices, ${PLAN_INCLUDED}` : figure;
}

type Agent = Pick<Member, "provider" | "config" | "handle">;

/**
 * The figures a chat's line in `member`'s popup is about: the chat's, or in a group chat (from a hub that splits them by
 * account, `byAccount`) that agent's account's part — null when it has none yet.
 */
export function lineFigures(c: ChatSpend | null | undefined, member: Pick<Member, "provider" | "config">, group: boolean): ChatFigures | null | undefined {
  if (!group || !c?.byAccount) return c;
  return c.byAccount.find((a) => a.provider === member.provider && a.account === memberAccount(member)) ?? null;
}

/**
 * A group chat's line, in the popup of one of its agents (`member`; `agents`: everyone in the chat). Its agents can be
 * billed differently — a plan sign-in beside an API key — so the line is that agent's part of the chat, said the way its
 * own account is billed: "@keys in this chat: $8.20", "@claude in this chat: ≈$4.10 at API prices, included in your
 * plan". The hub keeps a chat's figures by account, so agents on one account share a line ("@claude and @opus in this
 * chat"). From a hub that doesn't split them (before 0.6.2): the chat's whole figure, said to be covered by a plan only
 * when every agent's account is (it's part of the bill otherwise).
 */
export function groupSpendLine(c: ChatSpend | null | undefined, member: Agent, agents: readonly Agent[], figures: AccountSpend[] | null | undefined): string | null {
  if (c?.byAccount) {
    const same = (m: Pick<Member, "provider" | "config">) => m.provider === member.provider && memberAccount(m) === memberAccount(member);
    const account = accountOfMember(figures, member);
    const part = lineFigures(c, member, true);
    const names = agents.filter(same).map((m) => `@${m.handle}`);
    if (!names.length) names.push(`@${member.handle}`);
    const who = names.length < 2 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return chatSpendLine(part, account?.kind === "signin", !!account?.flat, `${who} in this chat`);
  }
  const all = agents.length ? agents : [member];
  const accounts = all.map((m) => accountOfMember(figures, m));
  return chatSpendLine(c, accounts.every((a) => a?.kind === "signin"), accounts.every((a) => !!a?.flat));
}

/** What a group chat's line calls its spend that is no agent's part (`groupRestLine`). */
export const GROUP_REST = "Asks and earlier accounts in this chat";

type Part = NonNullable<ChatSpend["byAccount"]>[number];

/** Adds parts of a chat's figures together. */
const addParts = (parts: readonly Part[]): ChatFigures =>
  parts.reduce<ChatFigures>((sum, p) => ({ usd: sum.usd + p.usd, replies: sum.replies + p.replies, unpriced: sum.unpriced + p.unpriced, estimated: (sum.estimated ?? 0) + (p.estimated ?? 0) }), { usd: 0, replies: 0, unpriced: 0, estimated: 0 });

/**
 * The parts of a group chat's figures that none of its agents' lines covers, because no agent in it now answers on their
 * account: asks to agents outside the chat (Ask others books each one in the chat, on the account it asked), and the
 * accounts its agents answered on before they were switched to another one, or agents that have left. Empty from a hub
 * that doesn't split a chat's figures by account: its line is the whole chat's already.
 */
export function groupRest(c: ChatSpend | null | undefined, agents: readonly Pick<Member, "provider" | "config">[]): Part[] {
  return (c?.byAccount ?? []).filter((p) => p.replies > 0 && !agents.some((m) => m.provider === p.provider && memberAccount(m) === p.account));
}

/** Those parts added together (for what the line leaves out); null when there are none. */
export function groupRestFigures(c: ChatSpend | null | undefined, agents: readonly Pick<Member, "provider" | "config">[]): ChatFigures | null {
  const rest = groupRest(c, agents);
  return rest.length ? addParts(rest) : null;
}

/**
 * The line under an agent's part of a group chat for the spend that is no agent's (`groupRest`), so a chat's money is all
 * said somewhere: "Asks and earlier accounts in this chat: $3.10". Its accounts can be billed differently too, and each is
 * said the way an agent's part would be: what plan sign-ins used is what it would cost, covered by the plan and never
 * added to what was billed ("…: $3.10, plus ≈$1.20 at API prices, included in your plan"), and a service charging one flat
 * fee for the month adds nothing reply by reply. An account the figures don't have counts as billed: a plan covers only
 * what is known to be a plan's. Null when there is none.
 */
export function groupRestLine(c: ChatSpend | null | undefined, agents: readonly Pick<Member, "provider" | "config">[], figures: AccountSpend[] | null | undefined): string | null {
  const rest = groupRest(c, agents);
  if (!rest.length) return null;
  const of = (p: Part) => figures?.find((a) => a.provider === p.provider && a.account === p.account);
  const plan = rest.filter((p) => of(p)?.kind === "signin");
  const billed = rest.filter((p) => of(p)?.kind !== "signin" && !of(p)?.flat);
  // A figure for each kind that has one; replies without a price are said after the line, like an agent's.
  const priced = (parts: Part[]) => parts.some((p) => p.unpriced < p.replies);
  const words: string[] = [];
  if (priced(billed)) words.push(figureWords(addParts(billed), false, false));
  if (priced(plan)) words.push(figureWords(addParts(plan), true, false));
  // Nothing with a price: a dash, said to be covered when nothing in it is billed.
  if (!words.length) words.push(billed.length ? "—" : `— · ${PLAN_INCLUDED}`);
  return `${GROUP_REST}: ${words.join(", plus ")}`;
}
