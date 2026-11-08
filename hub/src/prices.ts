// Model prices, looked up online and kept in the database (docs/SPEC-0.4.md, track T3). Never hard-coded: a price is what
// a public list said on the day it was fetched, matched by model id. A model that isn't on a list is "unknown", never guessed.
//
// Lists: models.dev's (every provider, `cost` per million tokens) and, for an account on OpenRouter, OpenRouter's own; for
// an account on NanoGPT, NanoGPT's own (its public detailed model list: each model at NanoGPT's price, which is what the
// account is billed — an uncensored build of a model is on no other list at all).
// xAI's own list isn't read: it needs the account's key and its units aren't confirmed, and models.dev has xAI's models.
// The one exception to "looked up online" is Refuseless: its prices are published only on a page behind Cloudflare's
// browser check and on no list, so the hub carries that page as read on a given day (refuseless.ts REFUSELESS_MODELS),
// for an account on Refuseless only.
// A list is fetched with a plain GET (no key, no chat, nothing about the person) at most once a day, kept in kv with its
// fetch date, and the last copy is used when offline, however old it is.

import { NANOGPT_ORIGIN, priceOf } from "./nanogpt";
import { REFUSELESS_ORIGIN, refuselessPrice } from "./refuseless";
import { logger } from "./util/log";

const log = logger("prices");

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const DAY_MS = 24 * 3600_000;
/** After a fetch fails (offline), the next try waits this long. */
const RETRY_MS = 30 * 60_000;
const CACHE_KEY = "prices.cache";

/** USD per million tokens: input, output, and cached input (null: the list gives no separate price for it). */
export type Price = readonly [input: number, output: number, cacheRead: number | null];
type Table = Record<string, Price>;
type Source = "models.dev" | "openrouter" | "nanogpt";
type Cache = Partial<Record<Source, { fetchedAt: number; table: Table }>>;

export interface PricesOptions {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  /** Settings → "Look up prices online" (default on). Off: no request is ever made; what was fetched before is still used. */
  enabled?: () => boolean;
  /** An in-memory hub (tests) never fetches unless `url` names where. */
  inMemory?: boolean;
  /** Where models.dev's list is (CROSSTALK_PRICES_URL, else models.dev itself). */
  url?: string;
  openRouterUrl?: string;
  /** Where NanoGPT's detailed model list is (CROSSTALK_NANOGPT_URL's, else NanoGPT's own). */
  nanoGptUrl?: string;
  /** Hosts of the online services the accounts use: "openrouter.ai" among them adds OpenRouter's own list, "nano-gpt.com" NanoGPT's. */
  hosts?: () => string[];
  now?: () => number;
}

/** A non-negative number from a list's number or numeric string; anything else (a missing price, "-1") is null. */
function amount(v: unknown): number | null {
  const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const perMillion = (perToken: number) => Number((perToken * 1e6).toPrecision(9));

function parseModelsDev(json: unknown): Table {
  const table: Table = {};
  for (const provider of Object.values((json ?? {}) as Record<string, { models?: Record<string, unknown> } | null>)) {
    for (const [key, entry] of Object.entries(provider?.models ?? {})) {
      const m = entry as { id?: unknown; cost?: Record<string, unknown> } | null;
      const input = amount(m?.cost?.input);
      const output = amount(m?.cost?.output);
      if (input === null || output === null) continue;
      const id = (typeof m?.id === "string" ? m.id : key).toLowerCase();
      // Several providers sell one model: the first priced entry wins, unless it's a free tier's zero.
      const have = table[id];
      if (!have || (have[0] === 0 && have[1] === 0)) table[id] = [input, output, amount(m?.cost?.cache_read)];
    }
  }
  return table;
}

function parseOpenRouter(json: unknown): Table {
  const table: Table = {};
  const list = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return table;
  for (const entry of list) {
    const m = entry as { id?: unknown; pricing?: Record<string, unknown> } | null;
    const input = amount(m?.pricing?.prompt); // dollars per token; "-1" means it's priced some other way
    const output = amount(m?.pricing?.completion);
    if (typeof m?.id !== "string" || input === null || output === null) continue;
    const cache = amount(m.pricing?.input_cache_read);
    table[m.id.toLowerCase()] = [perMillion(input), perMillion(output), cache === null ? null : perMillion(cache)];
  }
  return table;
}

/** NanoGPT's detailed model list: `pricing.prompt`/`completion` per million tokens, the cache read per thousand (nanogpt.ts priceOf). */
function parseNanoGpt(json: unknown): Table {
  const table: Table = {};
  const list = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return table;
  for (const entry of list) {
    const m = entry as { id?: unknown; pricing?: unknown } | null;
    const p = priceOf(m?.pricing);
    if (typeof m?.id === "string" && p) table[m.id.toLowerCase()] = [p.input, p.output, p.cached];
  }
  return table;
}

const isOpenRouter = (host: string) => /(^|\.)openrouter\.ai$/i.test(host);
/** NanoGPT's own hosts, and the stand-in the tests point CROSSTALK_NANOGPT_URL at. */
function isNanoGpt(host: string): boolean {
  if (/(^|\.)nano-gpt\.com$/i.test(host)) return true;
  try {
    return !!process.env.CROSSTALK_NANOGPT_URL && new URL(process.env.CROSSTALK_NANOGPT_URL).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Refuseless's API host, and the stand-in the tests point CROSSTALK_REFUSELESS_URL at. */
function isRefuseless(host: string): boolean {
  try {
    return [REFUSELESS_ORIGIN, process.env.CROSSTALK_REFUSELESS_URL].some((o) => !!o && new URL(o).host.toLowerCase() === host.toLowerCase());
  } catch {
    return false;
  }
}

/** The ids a model may be listed under: as given, without Claude Code's "[1m]", without a "vendor/" front, without a date at the end. */
function idsOf(model: string): string[] {
  const m = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  const tail = m.slice(m.lastIndexOf("/") + 1);
  const undated = (s: string) => s.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  return [...new Set([m, undated(m), tail, undated(tail)])];
}

/** What tokens cost at a price; cached input is charged at the cache price when the list has one. */
export function priceTokens(price: Price, inputTokens: number, outputTokens: number, cachedTokens: number): number {
  const cached = Math.min(Math.max(cachedTokens, 0), Math.max(inputTokens, 0));
  const dollars = ((Math.max(inputTokens, 0) - cached) * price[0] + cached * (price[2] ?? price[0]) + Math.max(outputTokens, 0) * price[1]) / 1e6;
  return Number(dollars.toFixed(8));
}

export class Prices {
  private cache: Cache | null = null;
  private job: Promise<boolean> | null = null;
  private retryAt = 0;
  private readonly now: () => number;

  constructor(private readonly o: PricesOptions) {
    this.now = o.now ?? Date.now;
  }

  private urls(): Record<Source, string> {
    return {
      "models.dev": this.o.url ?? process.env.CROSSTALK_PRICES_URL ?? MODELS_DEV_URL,
      openrouter: this.o.openRouterUrl ?? OPENROUTER_URL,
      nanogpt: this.o.nanoGptUrl ?? `${process.env.CROSSTALK_NANOGPT_URL || NANOGPT_ORIGIN}/api/v1/models?detailed=true`,
    };
  }

  private canFetch(): boolean {
    return (this.o.enabled?.() ?? true) && (!this.o.inMemory || this.o.url !== undefined);
  }

  private saved(): Cache {
    if (!this.cache) {
      try {
        const parsed = JSON.parse(this.o.kvGet(CACHE_KEY) ?? "{}");
        this.cache = parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        this.cache = {};
      }
    }
    return this.cache!;
  }

  /** The lists to keep: models.dev's, and OpenRouter's or NanoGPT's when an account uses it. */
  private wanted(): Source[] {
    const hosts = this.o.hosts?.() ?? [];
    return ["models.dev", ...(hosts.some(isOpenRouter) ? ["openrouter" as const] : []), ...(hosts.some(isNanoGpt) ? ["nanogpt" as const] : [])];
  }

  private stale(): Source[] {
    const now = this.now();
    return this.wanted().filter((s) => {
      const have = this.saved()[s];
      return !have || now - have.fetchedAt >= DAY_MS;
    });
  }

  /**
   * A model's price from the lists fetched so far, or null when it isn't on one (the caller says "unknown"). Starts a fetch
   * in the background when a list is a day old, so this answer comes from the copy kept; `host`: where the account's model
   * server is (OpenRouter's own list goes first for OpenRouter, NanoGPT's for NanoGPT).
   */
  lookup(model: string | null, host?: string | null): Price | null {
    if (!model) return null;
    // Refuseless's own prices, as its page had them (no list to fetch): its models are on no other list anyway.
    if (host && isRefuseless(host)) {
      const own = refuselessPrice(model);
      if (own) return own;
    }
    if (this.canFetch() && !this.job && this.now() >= this.retryAt && this.stale().length) void this.refresh();
    const order: Source[] = host && isOpenRouter(host) ? ["openrouter", "models.dev"] : host && isNanoGpt(host) ? ["nanogpt", "models.dev"] : ["models.dev"];
    for (const id of idsOf(model)) for (const s of order) if (this.saved()[s]?.table[id]) return this.saved()[s]!.table[id];
    return null;
  }

  /** Fetches the lists a day old (all of them with `force`). Never throws; resolves true when a list was updated. */
  refresh(force = false): Promise<boolean> {
    if (!this.canFetch()) return Promise.resolve(false);
    this.job ??= this.fetchLists(force)
      .catch((e) => {
        log.warn(`prices: ${e instanceof Error ? e.message : e}`); // the database closed under it, say
        return false;
      })
      .finally(() => {
        this.job = null;
      });
    return this.job;
  }

  private async fetchLists(force: boolean): Promise<boolean> {
    const urls = this.urls();
    let updated = false;
    for (const s of force ? this.wanted() : this.stale()) {
      try {
        const res = await fetch(urls[s], { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const table = (s === "models.dev" ? parseModelsDev : s === "nanogpt" ? parseNanoGpt : parseOpenRouter)(await res.json());
        // An error page or a changed format has no prices: the copy kept stays.
        if (!Object.keys(table).length) throw new Error("no prices in it");
        this.saved()[s] = { fetchedAt: this.now(), table };
        updated = true;
      } catch (e) {
        this.retryAt = this.now() + RETRY_MS;
        log.info(`price list ${s} not fetched: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (updated) this.o.kvSet(CACHE_KEY, JSON.stringify(this.saved()));
    return updated;
  }

  /** Where the prices come from and when they were fetched; null when no list has been fetched yet. */
  status(): { source: string; fetchedAt: number | null } | null {
    const s: Source = this.saved()["models.dev"] ? "models.dev" : "openrouter";
    const have = this.saved()[s];
    if (!have) return null;
    let source: string = this.urls()[s];
    try {
      source = new URL(source).host;
    } catch {
      /* an address that isn't one: shown as written */
    }
    return { source, fetchedAt: have.fetchedAt };
  }
}
