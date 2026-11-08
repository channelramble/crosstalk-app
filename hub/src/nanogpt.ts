// NanoGPT (nano-gpt.com) as an AI service: finding a model among the several hundred it sells, what each one costs, and
// what the account has left to spend. NanoGPT puts models from many makers behind one key and bills each request at that
// model's own price, or out of its $12-a-month subscription for the models the subscription covers.
//
// What this knows about NanoGPT comes from its docs (docs.nano-gpt.com, read on 1 November 2026) and its public model
// list, read the same day:
// - GET /api/v1/models?detailed=true needs no key and answers every model at once (666 models, about 800 KB): its name,
//   `context_length`, `capabilities.tool_calling` and `.reasoning`, `pricing` (`prompt` and `completion` in USD per million
//   tokens, `cacheReadInputPer1kTokens` per thousand), `subscription.included`, and a `category` — 42 of them filed under
//   "Uncensored". Without `detailed=true` the same list is ids only (62 KB). The list is small enough to hold, so the hub
//   reads it whole every half hour and searches it itself (Featherless's 22,000 models are searched on the service instead).
// - POST /api/check-balance with the key (x-api-key) answers `usd_balance`; GET /api/subscription/v1/usage with the key
//   answers whether the subscription is active, its weekly and daily input-token allowances (`used`, `remaining`,
//   `resetAt` in ms), when its month ends, and `routing.recommendedMode`: whether a covered model's reply is billed to the
//   allowance ("subscription") or the balance ("paygo") right now. Both are free and run no model.
// - Its Messages (/api/v1/messages) and Responses (/api/v1/responses) addresses take the same key, so Claude Code and
//   Codex both reach it directly; the address saved on an account is https://nano-gpt.com/api.
// - "Decision" models (Jev, Decider, Clef…) answer only non-streaming JSON questions: no use to an agent, never listed.
//
// No request here runs a model. The key is only ever sent to NanoGPT's own address, and is never logged or kept here.

import { createHash } from "node:crypto";
import { CATALOG_SHOWN, type Allowance, type CatalogFilter, type CatalogModel, type CatalogSearch, type ServiceFunds, type TokenPrice } from "@crosstalk/shared";
import { sameHost } from "./featherless";

/** Where NanoGPT's API is, as its docs give it (it also answers at api.nano-gpt.com). */
export const NANOGPT_ORIGIN = "https://nano-gpt.com";
/** The address an account is saved with: the hub adds /v1/… for each agent (Codex's /v1/responses, Claude Code's /v1/messages). */
export const NANOGPT_BASE_URL = `${NANOGPT_ORIGIN}/api`;
const LIST_PATH = "/api/v1/models?detailed=true";
/** The list changes when NanoGPT adds or reprices a model: read again after half an hour, on the next search. */
const LIST_TTL_MS = 30 * 60_000;
/** A balance or allowance read is kept this long, so opening Settings twice doesn't ask twice. */
const FUNDS_TTL_MS = 5 * 60_000;
/** Whether a covered model's reply comes out of the subscription is only trusted from a read this recent. */
const COVER_TTL_MS = 30 * 60_000;
/** The whole detailed list is about 800 KB: past this, something other than the list answered, and it is dropped. */
const MAX_BYTES = 4_000_000;
/** The most a query can be, so a pasted paragraph never becomes a search. */
const MAX_QUERY = 120;
/** Accounts whose balance is remembered at once. */
const MAX_FUNDS = 32;

/** One model of NanoGPT's list, as the hub keeps it: what a phone shows, and when it was added (newest first among equals). */
export interface NanoModel extends CatalogModel {
  created: number;
}

/**
 * Words in a name that mean the guard rails were taken out, for models NanoGPT files under another category (its
 * roleplay tunes, an "-abliterated" build): its own "Uncensored" category covers only some of them.
 */
const UNCENSORED_NAME = /uncensor|abliterat|heretic|derestrict|unrestrict|unfilter|obliterat/i;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? Math.floor(n) : null;
};
/** A price as a list states it: a number of dollars, never below zero. */
const dollars = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

/**
 * What a model costs per million tokens, from its list row. Input and output are given per million already; the cache
 * price per thousand. A row with no input or output price (an image model, a free tier that doesn't say) has no price.
 */
export function priceOf(pricing: unknown): TokenPrice | null {
  const p = (pricing ?? {}) as Record<string, unknown>;
  if (typeof p.currency === "string" && p.currency.toUpperCase() !== "USD") return null;
  if (typeof p.unit === "string" && p.unit !== "per_million_tokens") return null;
  const input = dollars(p.prompt);
  const output = dollars(p.completion);
  if (input === null || output === null) return null;
  const perThousand = dollars(p.cacheReadInputPer1kTokens);
  return { input, output, cached: perThousand === null ? null : Number((perThousand * 1000).toPrecision(9)) };
}

/** One row of NanoGPT's detailed list, kept down to what a phone shows; null for a row an agent can't use at all. */
export function rowOf(raw: Record<string, unknown>): NanoModel | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  // A name with a space in it can't be passed to an agent as a model name (serviceModelsKept drops those too).
  if (!id || id.length > 200 || /\s/.test(id)) return null;
  const category = typeof raw.category === "string" ? raw.category : "";
  // A decision model answers only non-streaming JSON questions, and one that writes no text isn't a chat model.
  if (/^decisions?$/i.test(category)) return null;
  const out = (raw.architecture as { output_modalities?: unknown } | null | undefined)?.output_modalities;
  if (Array.isArray(out) && out.length && !out.includes("text")) return null;
  const caps = (raw.capabilities ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  const price = priceOf(raw.pricing);
  return {
    id,
    modelClass: typeof raw.owned_by === "string" ? raw.owned_by : null,
    params: null,
    contextWindow: int(raw.context_length),
    concurrency: null,
    gated: false,
    tools: caps.tool_calling === true,
    toolsSaid: "service",
    ...(name ? { name } : {}),
    ...(price ? { price } : {}),
    inPlan: (raw.subscription as { included?: unknown } | null | undefined)?.included === true,
    uncensored: /^uncensored$/i.test(category) || UNCENSORED_NAME.test(id) || UNCENSORED_NAME.test(name ?? ""),
    reasoning: caps.reasoning === true,
    created: int(raw.created) ?? 0,
  };
}

/** A query as it is searched: trimmed, and never long enough to be anything but a name. */
export const cleanQuery = (q: unknown): string => String(q ?? "").trim().slice(0, MAX_QUERY);

/** The part of the list a search looks in; with nothing typed and nothing asked, the uncensored models. */
export function cleanFilter(f: unknown, q: string): CatalogFilter {
  return f === "uncensored" || f === "plan" || f === "all" ? f : q ? "all" : "uncensored";
}

/** Whether a model is in a filter's part of the list. */
const inFilter = (m: NanoModel, f: CatalogFilter) => (f === "uncensored" ? !!m.uncensored : f === "plan" ? !!m.inPlan : true);

/** Lowercase words of what was typed: each one must be in the model's id or its name ("deepseek uncensored"). */
const wordsOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Best first: the name typed exactly, then the models an agent can work with (tool calls), and within those the closest
 * name — one whose model name (after the maker) starts with what was typed before one it merely appears in — then the
 * newest (NanoGPT adds models as they come out, and the newest of a family is almost always the one wanted), then the
 * roomiest. The list's own order breaks what's left.
 */
export function rank(models: NanoModel[], q: string): NanoModel[] {
  const want = q.toLowerCase().trim();
  const tail = (id: string) => (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id).toLowerCase();
  const match = (m: NanoModel) => {
    if (!want) return 0;
    const id = m.id.toLowerCase();
    const name = (m.name ?? "").toLowerCase();
    if (id === want || tail(m.id) === want || name === want) return 0;
    if (tail(m.id).startsWith(want) || id.startsWith(want) || name.startsWith(want)) return 1;
    return 2;
  };
  return models
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        Number(want !== "" && match(b.m) === 0) - Number(want !== "" && match(a.m) === 0) ||
        Number(b.m.tools) - Number(a.m.tools) ||
        match(a.m) - match(b.m) ||
        b.m.created - a.m.created ||
        (b.m.contextWindow ?? 0) - (a.m.contextWindow ?? 0) ||
        a.i - b.i,
    )
    .map(({ m }) => m);
}

/** A row as it goes to a phone: without the hub's own bookkeeping. */
const shown = ({ created: _created, ...m }: NanoModel): CatalogModel => m; // eslint-disable-line @typescript-eslint/no-unused-vars

/** What went wrong, in words a person can act on. */
const problem = (what: string) => new Error(what);

/** A JSON body read in pieces, given up on once it is bigger than NanoGPT's list could be. */
async function readJson(res: Response, what: string): Promise<unknown> {
  const reader = res.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw problem(`NanoGPT sent back far more than its ${what} should be. Try again in a minute.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw problem(`NanoGPT's ${what} wasn't readable. Try again in a minute.`);
  }
}

/** A subscription allowance as the usage answer gives it (`{used, remaining, resetAt}`), with its limit from `limits`. */
function allowanceOf(v: unknown, limit: unknown): Allowance | null {
  const a = (v ?? null) as Record<string, unknown> | null;
  const max = num(limit);
  if (!a && max === null) return null;
  const used = num(a?.used);
  const remaining = num(a?.remaining);
  return {
    used: used !== null && used >= 0 ? used : null,
    limit: max !== null && max >= 0 ? max : used !== null && remaining !== null ? used + remaining : null,
    resetAt: int(a?.resetAt),
  };
}

/** The subscription part of what an account has to spend, from GET /api/subscription/v1/usage. */
export function planOf(body: unknown): ServiceFunds["plan"] {
  const b = (body ?? {}) as Record<string, unknown>;
  const limits = (b.limits ?? {}) as Record<string, unknown>;
  const weekly = allowanceOf(b.weeklyInputTokens, limits.weeklyInputTokens);
  const daily = allowanceOf(b.dailyInputTokens, limits.dailyInputTokens);
  const active = b.active === true;
  // An account that has never had a subscription answers inactive with no allowances: that is "no subscription", not one to show.
  if (!active && !weekly?.limit && !daily?.limit) return null;
  const mode = (b.routing as { recommendedMode?: unknown } | null | undefined)?.recommendedMode;
  const end = (b.period as { currentPeriodEnd?: unknown } | null | undefined)?.currentPeriodEnd;
  const renews = typeof end === "string" ? Date.parse(end) : NaN;
  return {
    active,
    billing: mode === "subscription" || mode === "paygo" || mode === "unavailable" ? mode : null,
    weekly,
    daily,
    renewsAt: Number.isFinite(renews) ? renews : null,
  };
}

/** A key as the hub remembers what was read with it: a hash, never the key. */
const keyRef = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

/**
 * NanoGPT's catalogue, read whole and remembered for half an hour; the balance and subscription of each key, remembered
 * for a few minutes. Searches are answered from the list the hub holds, so typing costs NanoGPT nothing.
 */
export class NanoGpt {
  /** How long one request may take; the services check sets it, and tests shorten it. */
  timeoutMs = 8000;
  /**
   * Where the requests go. CROSSTALK_NANOGPT_URL replaces it, which is how the tests point it at a stand-in on a loopback
   * port (and how the test hubs make sure they never reach the real service).
   */
  origin = process.env.CROSSTALK_NANOGPT_URL || NANOGPT_ORIGIN;

  private list: { at: number; job: Promise<NanoModel[]> } | null = null;
  /** The last list that was read, kept when a later read fails, so a hiccup never empties the model menu. */
  private last: NanoModel[] | null = null;
  private readonly funds = new Map<string, { at: number; job: Promise<ServiceFunds> }>();
  /** The last answer per key, kept past its time, for deciding how a reply is billed without asking NanoGPT mid-reply. */
  private readonly lastFunds = new Map<string, ServiceFunds>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether an account or address is NanoGPT (nano-gpt.com or api.nano-gpt.com, or the stand-in the tests point at). */
  serves(baseUrl: string | null | undefined): boolean {
    if (sameHost(baseUrl, this.origin)) return true;
    if (this.origin !== NANOGPT_ORIGIN) return false;
    try {
      const host = new URL(String(baseUrl ?? "")).host.toLowerCase();
      return host === "nano-gpt.com" || host === "api.nano-gpt.com" || host === "www.nano-gpt.com";
    } catch {
      return false;
    }
  }

  /** The whole list, read again once it is half an hour old. The request in flight is shared, so two phones ask once. */
  models(fresh = false): Promise<NanoModel[]> {
    if (!this.list || fresh || this.now() - this.list.at >= LIST_TTL_MS) {
      const job = this.read();
      this.list = { at: this.now(), job };
      job.then(
        (rows) => (this.last = rows),
        () => {
          // A failed read isn't kept: the next search asks again rather than repeating the error for half an hour. The
          // last good list still answers in the meantime (see `listed`).
          if (this.list?.job === job) this.list = null;
        },
      );
    }
    const job = this.list.job;
    return this.last ? job.catch(() => this.last as NanoModel[]) : job;
  }

  /** The list the hub already holds, without asking for it (null until it has been read once). */
  listed(): NanoModel[] | null {
    return this.last;
  }

  private async read(): Promise<NanoModel[]> {
    let res: Response;
    try {
      res = await fetch(this.origin + LIST_PATH, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw problem((e as Error)?.name === "TimeoutError" ? `NanoGPT didn't answer within ${Math.round(this.timeoutMs / 1000)} seconds. Try again.` : "Couldn't reach NanoGPT. Check this machine's internet connection, then try again.");
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw problem(`NanoGPT's model list answered with error ${res.status}. Try again in a minute.`);
    }
    const body = (await readJson(res, "model list")) as { data?: unknown } | null;
    const raw = Array.isArray(body?.data) ? body.data : null;
    if (!raw) throw problem("NanoGPT's model list wasn't readable. Try again in a minute.");
    const seen = new Set<string>();
    const rows: NanoModel[] = [];
    for (const r of raw) {
      const row = rowOf((r ?? {}) as Record<string, unknown>);
      if (row && !seen.has(row.id)) {
        seen.add(row.id);
        rows.push(row);
      }
    }
    if (!rows.length) throw problem("NanoGPT's model list came back empty. Try again in a minute.");
    return rows;
  }

  /** How many models the list has (and whether it can be read at all). */
  async total(): Promise<number> {
    return (await this.models()).length;
  }

  /**
   * The models to show for what was typed, in one part of the list: its uncensored models (NanoGPT's own "Uncensored"
   * category, and the abliterated and heretic builds it files elsewhere), the ones its subscription covers, or all of
   * them. `matched` is how many there are in all, so the app can say "type more to narrow it down".
   */
  async search(input: unknown, filterInput?: unknown): Promise<CatalogSearch> {
    const q = cleanQuery(input);
    const filter = cleanFilter(filterInput, q);
    const all = await this.models();
    const words = wordsOf(q);
    const hits = all.filter((m) => inFilter(m, filter) && words.every((w) => m.id.toLowerCase().includes(w) || (m.name ?? "").toLowerCase().includes(w)));
    return { name: "nanogpt", q, filter, models: rank(hits, q).slice(0, CATALOG_SHOWN).map(shown), matched: hits.length, total: all.length };
  }

  /** What the list says about models already saved on an account, for its model menu; one the list no longer has is left out. */
  async saved(ids: string[]): Promise<CatalogModel[]> {
    const wanted = new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean));
    if (!wanted.size) return [];
    return (await this.models()).filter((m) => wanted.has(m.id.toLowerCase())).map(shown);
  }

  /**
   * What an account has to spend: its balance and its subscription, read with its key (two free requests), remembered
   * for five minutes. A part that couldn't be read is null, never a guess; a key NanoGPT refuses throws, in plain words.
   */
  fundsOf(key: string, fresh = false): Promise<ServiceFunds> {
    if (!key) return Promise.reject(problem("This NanoGPT account has no key. Add one in its settings."));
    const ref = keyRef(key);
    const hit = this.funds.get(ref);
    if (hit && !fresh && this.now() - hit.at < FUNDS_TTL_MS) return hit.job;
    const job = this.readFunds(key);
    this.funds.set(ref, { at: this.now(), job });
    job.then(
      (f) => this.lastFunds.set(ref, f),
      () => this.funds.get(ref)?.job === job && this.funds.delete(ref),
    );
    // Oldest out first, so keys that were tried and dropped can't pile up.
    while (this.funds.size > MAX_FUNDS) this.funds.delete(this.funds.keys().next().value as string);
    while (this.lastFunds.size > MAX_FUNDS) this.lastFunds.delete(this.lastFunds.keys().next().value as string);
    return job;
  }

  private async readFunds(key: string): Promise<ServiceFunds> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const get = async (path: string, init: RequestInit) => {
      try {
        const res = await fetch(this.origin + path, { ...init, signal, redirect: "error" });
        if (res.status === 401 || res.status === 403) {
          void res.body?.cancel().catch(() => {});
          return { refused: true, body: null };
        }
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          return { refused: false, body: null };
        }
        return { refused: false, body: await readJson(res, "account answer").catch(() => null) };
      } catch {
        return { refused: false, body: null };
      }
    };
    const [balance, usage] = await Promise.all([
      get("/api/check-balance", { method: "POST", headers: { accept: "application/json", "x-api-key": key } }),
      get("/api/subscription/v1/usage", { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${key}` } }),
    ]);
    if (balance.refused && usage.refused) throw problem("NanoGPT refused this key. Check that you copied all of it, or make a new one at nano-gpt.com/api.");
    const usd = num((balance.body as { usd_balance?: unknown } | null)?.usd_balance);
    return { balanceUsd: usd !== null && usd >= 0 ? Number(usd.toFixed(4)) : null, plan: usage.body ? planOf(usage.body) : null, checkedAt: this.now() };
  }

  /**
   * Whether a reply on this model, on an account with this key, comes out of the subscription rather than the balance:
   * the list says the subscription covers the model, and the account's last read (at most half an hour old) says its
   * subscription is active and NanoGPT bills covered models to it right now. Anything not known is a no, so a reply
   * is priced rather than called free. Nothing is asked here: the ledger asks this as a reply ends.
   */
  covers(model: string | null, key: string): boolean {
    if (!model || !key || !this.last) return false;
    const row = this.last.find((m) => m.id.toLowerCase() === model.trim().toLowerCase());
    if (!row?.inPlan) return false;
    const f = this.lastFunds.get(keyRef(key));
    if (!f || this.now() - f.checkedAt >= COVER_TTL_MS) return false;
    return !!f.plan?.active && f.plan.billing === "subscription";
  }

  /** Reads an account's funds again in the background when the last read is getting old (a reply just ended on it). */
  refreshSoon(key: string): void {
    if (!key) return;
    const f = this.lastFunds.get(keyRef(key));
    if (!f || this.now() - f.checkedAt >= FUNDS_TTL_MS) void this.fundsOf(key).catch(() => {});
    if (!this.last) void this.models().catch(() => {});
  }
}

/** A price in the words a model row uses: "$0.33 in · $1.32 out per million tokens", the cached input when it's listed. */
export function priceWords(p: TokenPrice | undefined | null): string | null {
  if (!p) return null;
  const usd = (n: number) => (n === 0 ? "free" : n < 0.01 ? `$${Number(n.toPrecision(2))}` : `$${n.toFixed(2).replace(/\.00$/, "")}`);
  return `${usd(p.input)} in · ${usd(p.output)} out per million tokens`;
}
