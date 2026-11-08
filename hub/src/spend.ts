// What each account has cost, and its spending limit (docs/SPEC-0.4.md, track T3).
//
// The ledger is its own table (`spend_ledger`) with no foreign keys: what a chat cost outlives the chat, because deleting a
// chat or rewinding it takes its turns away and never its money. Money is never read from `turns.usage.costUsd`: for Claude
// Code that is a running total per process (and old rows can't be told apart from per-reply figures), so each reply is
// priced when it finishes and the figure is kept here with how sure it is (`basis`):
//   exact      the agent reported it (for Claude Code: this total minus the process's previous one)
//   estimated  worked out from the reply's tokens and a price list (the first reply of a Claude Code process has no
//              previous total; Codex reports no cost)
//   unknown    no price known: cost_usd is null and the reply is counted as "without a price"
//   plan       a plan sign-in: a notional figure, shown but never counted against a limit
//   free       a model on this machine or its own network

import type { Database } from "bun:sqlite";
import { DEFAULT_ACCOUNT, memberAccount, PROVIDER_INFO, type AccountSpend, type Budget, type BudgetState, type ChatSpend, type CostBasis, type Member, type Provider, type Room, type SpendSummary, type SpendTotals, type Turn } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError, type LedgerUsage } from "./engine/engine";
import { Prices, priceTokens } from "./prices";
import { route, type Route } from "./routes";
import { logger } from "./util/log";

const log = logger("spend");

/** Where a limit starts to warn (percent). */
const WARN_AT = 80;
const BUDGETS_KEY = "spend.budgets";
/** kv: for each account, the highest threshold its limit has pushed about in which period (`WarnedMark`). */
const WARNED_KEY = "spend.warned";

/**
 * What an account's limit has already pushed about: 80 (nearing it) or 100 (reached), in the period named. Hubs before
 * 0.6.2 kept only the period's name, for the 80% push: read as that.
 */
type WarnedMark = { period: string; percent: number } | string;

/** The highest threshold a mark already told about in this period (0: nothing yet). */
function toldOf(mark: WarnedMark | undefined, period: string): number {
  if (typeof mark === "string") return mark === period ? WARN_AT : 0;
  return mark && mark.period === period && typeof mark.percent === "number" ? mark.percent : 0;
}

/** The `spend` event goes out at most this often (ms). */
const EMIT_EVERY_MS = 5000;

/** One reply's (or one ask's) usage and cost, as the ledger keeps it. `costUsd` null = no price known. */
export interface SpendEntry {
  source: "turn" | "ask";
  provider: Provider;
  account: string;
  roomId: string | null;
  chatName: string | null;
  turnId?: string | null;
  askId?: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  basis: CostBasis;
  /** Defaults to now. */
  at?: number;
}

interface ReplyTokens {
  provider: Provider;
  account: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface AccountInfo {
  known: boolean;
  label: string;
  kind: AccountSpend["kind"];
  /** A model server on this machine or its own network: its replies are free. */
  local: boolean;
  /** Its key is on one flat fee for the month (a Featherless key last read as on its Chat plan): a reply costs nothing of its own. */
  flat: boolean;
  /** Where an endpoint account's model server is. */
  host: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** A moment's local calendar day ("2026-05-14"): what Today and This month count by. A reply stays in the day it was written. */
export function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local calendar month a moment is in: its first day, the first day of the next month, and a name for it. */
function monthOf(at: number): { from: string; to: string; name: string } {
  const d = new Date(at);
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  return { from: `${name}-01`, to: dayOf(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()), name };
}

/** "$47.20", and whole dollars from $100 ("$200", "$1,235"): the same as the app's usd(). */
export function money(amount: number): string {
  const cents = Math.round(Math.max(0, amount) * 100);
  return cents >= 10_000 ? `$${Math.round(cents / 100).toLocaleString("en-US")}` : `$${(cents / 100).toFixed(2)}`;
}

/** This machine, a private network or a tailnet: a model server there is the person's own, so its replies cost nothing. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal") || h.endsWith(".ts.net")) return true;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:");
  return !h.includes("."); // a bare computer name on the local network
}

const hostOf = (baseUrl: string | undefined | null): string | null => {
  try {
    return baseUrl ? new URL(baseUrl).hostname : null;
  } catch {
    return null;
  }
};

export class Spend {
  readonly prices: Prices;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly emitEvery: number;
  /** The last running total each Claude Code chat's process reported: this reply's cost is the step from it. */
  private readonly lastTotal = new Map<string, number>();
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The hub is shutting down (stop): nothing more goes out, and nothing is put off past the database's closing. */
  private stopped = false;

  constructor(
    private readonly app: App,
    opts: { now?: () => number; prices?: Prices; emitEveryMs?: number } = {},
  ) {
    this.db = app.store.db;
    this.now = opts.now ?? Date.now;
    this.emitEvery = opts.emitEveryMs ?? EMIT_EVERY_MS;
    this.ensure();
    const inMemory = app.opts.dbPath === ":memory:";
    this.prices =
      opts.prices ??
      new Prices({
        kvGet: (k) => app.store.kvGet(k),
        kvSet: (k, v) => app.store.kvSet(k, v),
        enabled: () => app.hubSettings().priceLookup !== false,
        inMemory,
        hosts: () => app.providers.accounts().flatMap((a) => (a.kind === "endpoint" ? [hostOf(a.endpoint?.baseUrl) ?? ""] : [])),
      });
    // A hub that has run before has its lists in kv; a new one gets them now rather than at its first reply. (The compiled-binary
    // check runs with no agent CLIs at all: nothing to price, so no request.)
    if (!inMemory && process.env.CROSSTALK_NO_AGENT_CLIS !== "1") void this.prices.refresh();
  }

  private ensure() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS spend_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      room_id TEXT,
      chat_name TEXT,
      turn_id TEXT,
      ask_id TEXT,
      source TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      basis TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS spend_ledger_at ON spend_ledger(at);
    CREATE INDEX IF NOT EXISTS spend_ledger_account ON spend_ledger(provider, account, at);
    CREATE INDEX IF NOT EXISTS spend_ledger_room ON spend_ledger(room_id)`);
  }

  // ---------------------------------------------------------------- accounts

  /** What kind of account this is, which decides how its replies are priced and counted. A removed one counts as a plan sign-in here (never against a limit); `accounts()` shows what its history says it was. */
  private info(provider: Provider, account: string, list = this.app.providers.accounts()): AccountInfo {
    const a = list.find((x) => x.provider === provider && x.id === account);
    const host = a?.kind === "endpoint" ? hostOf(a.endpoint?.baseUrl) : null;
    if (!a) return { known: false, label: `${PROVIDER_INFO[provider]?.name ?? provider}${account === DEFAULT_ACCOUNT ? "" : " (removed)"}`, kind: "signin", local: false, flat: false, host };
    // Flat only for a Featherless key last read as on its flat Chat plan (featherless.ts flatRate): asked by address and
    // key, not by what was saved on the account, so an account added any way at all is priced the same. Its Developer
    // plan bills each reply per token, and a key whose plan isn't known is priced too, never called free.
    const flat = a.kind === "endpoint" && this.app.services.flatRate(provider, account, a.endpoint?.baseUrl);
    return { known: true, label: a.label, kind: a.kind ?? "signin", local: !!host && isLocalHost(host), flat, host };
  }

  /**
   * What an account that is no longer listed was, from how its replies were kept (nothing else says: a rotated key's spend is
   * real money, not a plan's notional figure). Priced or unpriced replies (exact, estimated, unknown) mean an API key or an online
   * service; only "free" ones a model server on this machine; a plan sign-in's replies are all "plan".
   */
  private removedKind(provider: Provider, account: string): AccountSpend["kind"] {
    const row = this.db
      .query("SELECT COALESCE(MAX(basis IN ('exact', 'estimated', 'unknown')), 0) AS billed, COALESCE(MAX(basis = 'free'), 0) AS free FROM spend_ledger WHERE provider = ? AND account = ?")
      .get(provider, account) as { billed: number; free: number };
    return row.billed ? "apikey" : row.free ? "endpoint" : "signin";
  }

  /** The model a reply ran on: the chat's own, else the agent's default for that account (the price lists need a real id, not an alias). */
  private modelOf(member: Member, account: string, list = this.app.providers.accounts()): string | null {
    const chosen = member.model || null;
    const known = this.app.providers.knownModel(member.provider, account, chosen);
    return known?.resolvedModel ?? known?.id ?? chosen ?? list.find((a) => a.provider === member.provider && a.id === account)?.endpoint?.models?.[0] ?? null;
  }

  // ---------------------------------------------------------------- recording

  /** Keeps a finished reply's usage (called by the engine through EngineDeps.recordUsage). */
  recordTurn(room: Room, member: Member, turn: Turn, usage: LedgerUsage): void {
    const account = memberAccount(member);
    const list = this.app.providers.accounts();
    const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedInputTokens };
    const reply: ReplyTokens = { provider: member.provider, account, model: this.modelOf(member, account, list), ...tokens };
    this.record({ source: "turn", roomId: room.id, chatName: room.name, turnId: turn.id, askId: null, ...reply, ...this.costOf(member, usage, this.info(member.provider, account, list), reply) });
  }

  /** What a finished reply cost and how sure that is: what the agent reported, else its tokens at a listed price, else unknown. */
  private costOf(member: Member, usage: LedgerUsage, info: AccountInfo, reply: ReplyTokens): { costUsd: number | null; basis: CostBasis } {
    let reported: number | null = null;
    if (usage.costTotalUsd !== undefined) {
      // Claude Code reports a running total for its process. This reply cost the step from the last total, when the driver
      // knows that total came from the same process and nothing went backwards; otherwise there's nothing to difference.
      // ("Read it now" gives one reply two results: the driver reports the last total, so the step covers both parts.)
      const total = usage.costTotalUsd;
      const before = this.lastTotal.get(member.id);
      if (total !== null) this.lastTotal.set(member.id, total);
      if (total !== null && before !== undefined && usage.costFromBaseline && total >= before) reported = total - before;
    } else if (typeof usage.costUsd === "number") reported = usage.costUsd; // a driver that reports each reply's own cost
    // A model server of someone's own isn't priced by what the agent says: Claude Code prices names it doesn't know by a guess.
    if (reported !== null && info.kind !== "endpoint") return { costUsd: round6(reported), basis: "exact" };
    // A NanoGPT reply its subscription paid for: nothing came off the balance, so it is the plan's, never counted against a limit.
    if (info.kind === "endpoint" && this.nanoCovered(reply)) return { costUsd: 0, basis: "plan" };
    return this.priceReply(reply);
  }

  /**
   * Whether NanoGPT billed this reply to the account's subscription rather than its balance: the model is one the
   * subscription covers, and the account's last read (nanogpt.ts covers) says the subscription is active and takes covered
   * models now. Nothing is asked here — a read is started for the next reply when the last one is getting old — and
   * anything not known is a no, so a reply is priced rather than called free.
   */
  private nanoCovered(reply: ReplyTokens): boolean {
    const ep = this.app.providers.endpointOf(reply.provider, reply.account);
    if (!ep || !this.app.services.nanogpt.serves(ep.baseUrl)) return false;
    this.app.services.nanogpt.refreshSoon(ep.key);
    return this.app.services.nanogpt.covers(reply.model, ep.key);
  }

  /** What a reply's tokens cost on this model, from the price lists: "estimated", or "unknown" (null) when no price is known. */
  priceReply(input: { provider: Provider; account: string; model: string | null; inputTokens: number; outputTokens: number; cachedTokens: number }): { costUsd: number | null; basis: CostBasis } {
    const host = this.info(input.provider, input.account).host;
    // Featherless prices each model itself (its Developer plan bills that rate), and no other list has its Hugging Face
    // finetunes: its own list goes first (featherless.ts priceFor), as NanoGPT's does for NanoGPT.
    const price = this.app.services.catalog.priceFor(host, input.model) ?? this.prices.lookup(input.model, host);
    return price ? { costUsd: priceTokens(price, input.inputTokens, input.outputTokens, input.cachedTokens), basis: "estimated" } : { costUsd: null, basis: "unknown" };
  }

  /** Keeps any usage the ledger didn't see through a turn (an ask's). */
  record(entry: SpendEntry): void {
    const info = this.info(entry.provider, entry.account);
    const at = entry.at ?? this.now();
    let costUsd = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd) && entry.costUsd >= 0 ? entry.costUsd : null;
    let basis: CostBasis = costUsd === null && (entry.basis === "exact" || entry.basis === "estimated") ? "unknown" : entry.basis;
    if (info.kind === "signin") basis = "plan"; // notional: shown, never counted against a limit
    else if (info.local) {
      costUsd = 0;
      basis = "free";
    } else if (info.flat) {
      // One fee for the month, whatever you send it: this reply added nothing to the bill, and a per-token price list
      // would make up a figure nobody is charged — one that a limit would then refuse new replies over.
      costUsd = 0;
      basis = "plan";
    }
    const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
    this.db
      .query("INSERT INTO spend_ledger (at, day, provider, account, room_id, chat_name, turn_id, ask_id, source, model, input_tokens, output_tokens, cached_tokens, cost_usd, basis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(at, dayOf(at), entry.provider, entry.account, entry.roomId ?? null, entry.chatName ?? null, entry.turnId ?? null, entry.askId ?? null, entry.source, entry.model ?? null, count(entry.inputTokens), count(entry.outputTokens), count(entry.cachedTokens), costUsd, basis);
    let warned = false;
    try {
      warned = this.warn(entry.provider, entry.account, info.label);
    } catch (e) {
      log.warn(`limit check: ${e instanceof Error ? e.message : e}`);
    }
    this.publish(warned);
  }

  // ---------------------------------------------------------------- limits

  private budgets(): Record<string, Budget> {
    return this.readKv<Budget>(BUDGETS_KEY);
  }

  private readKv<T>(key: string): Record<string, T> {
    try {
      const v = JSON.parse(this.app.store.kvGet(key) ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  /** What counts against a limit so far: replies priced exactly or by estimate, in the limit's period (plan and free replies never do). */
  private used(provider: Provider, account: string, b: Budget): number {
    const m = monthOf(this.now());
    const [where, args]: [string, (string | number)[]] = b.period === "month" ? ["day >= ? AND day < ?", [m.from, m.to]] : ["at >= ?", [b.since]];
    const keys = [...new Set([`${provider}:${account}`, ...(b.also ?? [])])];
    const row = this.db.query(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM spend_ledger WHERE provider || ':' || account IN (${keys.map(() => "?").join(", ")}) AND basis IN ('exact', 'estimated') AND ${where}`).get(...keys, ...args) as { usd: number };
    return round6(row.usd);
  }

  private state(provider: Provider, account: string, b: Budget): BudgetState {
    const usedUsd = this.used(provider, account, b);
    const percent = (usedUsd / b.limitUsd) * 100;
    return { ...b, usedUsd, percent, state: percent >= 100 ? "stopped" : percent >= WARN_AT ? "warn" : "ok" };
  }

  /**
   * The plain sentence that refuses a new reply on this account (its limit is used up), else null. Only checked when a
   * reply starts: rooms run in parallel and a running reply's cost isn't known until it ends, so replies already running
   * (and ones that start at the same moment in other chats) can carry the total a little past the limit.
   */
  checkBudget(provider: Provider, account: string): string | null {
    const budget = this.budgets()[`${provider}:${account}`];
    if (!budget) return null;
    const info = this.info(provider, account);
    // Neither is billed for a reply: a plan sign-in, and a key on a plan of one flat fee for the month (an account that
    // was something else before may still have a limit saved, and replies on it must not be refused over old figures).
    if (info.kind === "signin" || info.flat) return null;
    return this.used(provider, account, budget) >= budget.limitUsd ? `${info.label} reached its ${money(budget.limitUsd)} limit, so this reply didn't start.` : null;
  }

  /**
   * At 80% of a limit and again at 100% (when new replies start being refused), once for each threshold, limit and
   * period: a push (the caller sends the `spend` event with it). A reply that crosses both at once sends one, that the
   * limit is reached. Nothing is posted in any chat. Returns whether it warned.
   */
  private warn(provider: Provider, account: string, label: string): boolean {
    const key = `${provider}:${account}`;
    const budgets = this.budgets();
    const budget = budgets[key];
    if (!budget) return false;
    const state = this.state(provider, account, budget);
    const period = budget.period === "month" ? monthOf(this.now()).name : `since ${budget.since}`;
    const level = state.state === "stopped" ? 100 : state.state === "warn" ? WARN_AT : 0;
    const warned = this.readKv<WarnedMark>(WARNED_KEY);
    if (!level || level <= toldOf(warned[key], period)) return false;
    const mark: WarnedMark = { period, percent: level };
    // A service's other rows at the same limit share this count, so the same push isn't owed for them.
    const told = [key, ...(budget.also ?? []).filter((k) => budgets[k]?.limitUsd === budget.limitUsd)];
    this.app.store.kvSet(WARNED_KEY, JSON.stringify({ ...warned, ...Object.fromEntries(told.map((k) => [k, mark])) }));
    void this.app.push
      .send({
        title: state.state === "stopped" ? "Spending limit reached" : "Nearing a spending limit",
        body: `${label} has used ${money(state.usedUsd)} of its ${money(budget.limitUsd)} limit.`,
        url: "./#/settings/costs",
        tag: `spend-${key}`,
      })
      .catch(() => {});
    return true;
  }

  /** Sets, changes (period and the start of a "total" count stay when only the amount changes) or removes (`limitUsd` null) an account's limit. */
  setBudget(providerId: string, account: string, input: { limitUsd?: unknown; period?: unknown } | null): AccountSpend {
    const provider = providerId as Provider;
    if (!PROVIDER_INFO[provider]) throw new HttpError(404, "No such agent");
    const info = this.info(provider, account);
    if (!info.known) throw new HttpError(404, "No such account");
    if (info.kind === "signin") throw new HttpError(400, "A limit works for API keys and online services. A plan sign-in isn't billed for each reply, so there's nothing to cap.");
    if (info.flat) throw new HttpError(400, `${info.label}'s key is on Featherless's Chat plan: one flat fee for the month, so there's nothing for a limit to count. That plan doesn't allow agents. On its Developer plan, paid per token, a limit counts each reply.`);
    const limit = input?.limitUsd;
    if (limit === undefined) throw new HttpError(400, "Say the limit, like { limitUsd: 100 }, or { limitUsd: null } to remove it.");
    if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)) throw new HttpError(400, "A limit is an amount above zero, like 100. Leave it empty to remove the limit.");
    const period = input?.period;
    if (period !== undefined && period !== "month" && period !== "total") throw new HttpError(400, `The period is "month" or "total".`);
    const key = `${provider}:${account}`;
    const budgets = this.budgets();
    const old = budgets[key];
    if (limit === null) delete budgets[key];
    else {
      const next = period ?? old?.period ?? "month";
      budgets[key] = { ...old, limitUsd: limit, period: next, since: old && old.period === next ? old.since : this.now() };
    }
    this.app.store.kvSet(BUDGETS_KEY, JSON.stringify(budgets));
    // The warning is about the limit as it stands: a new limit warns again when it gets near.
    const warned = this.readKv<WarnedMark>(WARNED_KEY);
    delete warned[key];
    this.app.store.kvSet(WARNED_KEY, JSON.stringify(warned));
    this.publish(true);
    return this.accounts().find((a) => a.provider === provider && a.account === account)!;
  }

  /**
   * A service moved to the other agent (Providers.switchServiceAgent) is the same service, spending the same money, so its
   * limit goes with it, with its period and start, and a limit already reached stays reached. An old row that goes hands
   * over what it spent. One that stays for its chats shares one count with the new row, so together they stop at the limit.
   * A limit the new row already has of its own stays, and counts only its own spend.
   */
  budgetMoved(from: Provider, fromId: string, to: Provider, toId: string, oldGoes: boolean): void {
    const [fromKey, toKey] = [`${from}:${fromId}`, `${to}:${toId}`];
    const budgets = this.budgets();
    const warned = this.readKv<WarnedMark>(WARNED_KEY);
    const old = budgets[fromKey];
    const own = budgets[toKey];
    if (old && !own) {
      budgets[toKey] = old;
      if (warned[fromKey] !== undefined) warned[toKey] = warned[fromKey];
    }
    if (oldGoes) {
      delete budgets[fromKey];
      delete warned[fromKey];
      if (!own || own.also?.includes(fromKey)) {
        this.db.query("UPDATE spend_ledger SET provider = ?, account = ? WHERE provider = ? AND account = ?").run(to, toId, from, fromId);
        for (const [key, b] of Object.entries(budgets)) if (b.also?.includes(fromKey)) budgets[key] = { ...b, also: [...new Set(b.also.map((k) => (k === fromKey ? toKey : k)))] };
      }
    } else if (old && !own) {
      const also = [...new Set([...(old.also ?? []), fromKey, toKey])];
      for (const key of also) if (budgets[key]) budgets[key] = { ...budgets[key], also };
    }
    this.app.store.kvSet(BUDGETS_KEY, JSON.stringify(budgets));
    this.app.store.kvSet(WARNED_KEY, JSON.stringify(warned));
    this.publish(true);
  }

  // ---------------------------------------------------------------- what it adds up to

  private totals(where: string, ...args: string[]): Map<string, SpendTotals> {
    const rows = this.db
      .query(`SELECT provider, account, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS replies, COALESCE(SUM(cost_usd IS NULL), 0) AS unpriced, COALESCE(SUM(cost_usd IS NOT NULL AND basis = 'estimated'), 0) AS estimated, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM spend_ledger WHERE ${where} GROUP BY provider, account`)
      .all(...args) as { provider: string; account: string; usd: number; replies: number; unpriced: number; estimated: number; input: number; output: number }[];
    return new Map(rows.map((r) => [`${r.provider}:${r.account}`, { usd: round6(r.usd), replies: r.replies, unpriced: r.unpriced, estimated: r.estimated, inputTokens: r.input, outputTokens: r.output }]));
  }

  /** Every account with spend, a limit, or an API key or model server of its own: today, this month, in total, and its limit. */
  accounts(): AccountSpend[] {
    const now = this.now();
    const m = monthOf(now);
    const today = this.totals("day = ?", dayOf(now));
    const month = this.totals("day >= ? AND day < ?", m.from, m.to);
    const total = this.totals("1 = 1");
    const budgets = this.budgets();
    const list = this.app.providers.accounts();
    const keys = new Set([...total.keys(), ...Object.keys(budgets)]);
    for (const a of list) if (a.kind === "apikey" || a.kind === "endpoint") keys.add(`${a.provider}:${a.id}`);
    const none = (): SpendTotals => ({ usd: 0, replies: 0, unpriced: 0, estimated: 0, inputTokens: 0, outputTokens: 0 });
    const rank = { apikey: 0, endpoint: 1, signin: 2 };
    return [...keys]
      .map((key): AccountSpend => {
        const at = key.indexOf(":");
        const provider = key.slice(0, at) as Provider;
        const account = key.slice(at + 1);
        const info = this.info(provider, account, list);
        // A removed account keeps its history, and the kind that history shows; it has no limit to change (info() holds it to none).
        const kind = info.known ? info.kind : this.removedKind(provider, account);
        const budget = budgets[key];
        return { provider, account, label: info.label, kind, today: today.get(key) ?? none(), month: month.get(key) ?? none(), total: total.get(key) ?? none(), budget: budget && info.kind !== "signin" && !info.flat ? this.state(provider, account, budget) : null, ...(info.flat ? { flat: true } : {}) };
      })
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));
  }

  summary(): SpendSummary {
    return { accounts: this.accounts(), updatedAt: this.now(), prices: this.prices.status() };
  }

  /**
   * What a chat has cost, replies and asks, including the ones whose turns were rewound away; and the same for each account
   * that answered in it (a group chat's agents can be billed differently, so each agent's part is said in its own words).
   */
  chatSpend(roomId: string): ChatSpend {
    const rows = this.db
      .query("SELECT provider, account, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS replies, COALESCE(SUM(cost_usd IS NULL), 0) AS unpriced, COALESCE(SUM(cost_usd IS NOT NULL AND basis IN ('estimated', 'plan')), 0) AS estimated FROM spend_ledger WHERE room_id = ? GROUP BY provider, account ORDER BY provider, account")
      .all(roomId) as { provider: Provider; account: string; usd: number; replies: number; unpriced: number; estimated: number }[];
    const byAccount = rows.map((r) => ({ provider: r.provider, account: r.account, usd: round6(r.usd), replies: r.replies, unpriced: r.unpriced, estimated: r.estimated }));
    const sum = (k: "usd" | "replies" | "unpriced" | "estimated") => rows.reduce((n, r) => n + r[k], 0);
    return { roomId, usd: round6(sum("usd")), replies: sum("replies"), unpriced: sum("unpriced"), estimated: sum("estimated"), byAccount };
  }

  // ---------------------------------------------------------------- telling the apps

  /** The `spend` event, at most once every few seconds (the last change always goes out); `now` skips the wait. */
  private publish(now = false) {
    if (this.stopped) return;
    const wait = this.lastEmit + this.emitEvery - this.now();
    if (now || wait <= 0 || wait > this.emitEvery) this.flush();
    else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => this.flush(), wait);
      this.emitTimer.unref?.();
    }
  }

  private flush() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.lastEmit = this.now();
    try {
      this.app.bus.emit({ t: "spend", accounts: this.accounts() });
    } catch (e) {
      log.warn(`spend event: ${e instanceof Error ? e.message : e}`); // the hub is shutting down
    }
  }

  /**
   * The hub is shutting down (App.shutdown, before the database closes): a `spend` event that was put off goes out now,
   * while the ledger can still be read, and nothing is put off after this. Its timer used to outlive the shutdown and log
   * "spend event: Cannot use a closed database".
   */
  stop() {
    if (this.stopped) return;
    const pending = !!this.emitTimer;
    this.stopped = true;
    if (pending) this.flush();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }
}

export function spendRoutes(app: App): Route[] {
  return [
    route("GET", "/api/spend", () => app.spend.summary()),
    route("GET", "/api/rooms/:id/spend", ({ params }) => app.spend.chatSpend(params.id)),
    route("PUT", "/api/spend/budgets/:provider/:account", async ({ params, body }) => app.spend.setBudget(params.provider, params.account, await body())),
  ];
}
