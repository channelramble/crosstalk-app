// Refuseless (refuseless.com) as an AI service: open-weight models "abliterated" — the direction that makes a model
// refuse taken out of its weights — behind an OpenAI-compatible API, paid per token from a prepaid balance. Crosstalk's
// own agent runs it as a coding agent (agents/builtin.ts); Codex and Claude Code can too.
//
// What this knows comes from its docs (docs.refuseless.com, read on 4 November 2026) and its pricing page the same day:
// - The API is at https://api.refuseless.com/v1 with `Authorization: Bearer <key>` (keys start abl_), and every call
//   needs the key, the model list too. Chat Completions (/v1/chat/completions: streaming, tools, `reasoning_content`,
//   `usage.prompt_tokens_details.cached_tokens`), the Responses API (/v1/responses, stateless) and Anthropic's Messages
//   (/v1/messages) all answer there. The address saved on an account is https://api.refuseless.com.
// - GET /v1/models gives each model's `id`, `abliterated` (true: refusals removed; its docs say to go by this, not by
//   the id) and `context_length`. GET /v1/credits gives `balance`, `reserved` (held by requests still running: each one
//   reserves its worst case before it starts), `available` (what a new request can reserve) and `key_limit`, in USD.
//   It is free, never charged, and may be read 60 times a minute.
// - Errors share one shape, {error: {code, message, type}}: 401 invalid_key, 402 insufficient_credits, 404
//   model_not_found, 429 model_busy (retry-after 15), model_warming (a cold model starting, retry-after 30) or the
//   account's own limit on requests at once, 502 upstream_error, 503 gateway_down / model_unavailable. A stream that runs
//   out of credit ends with an `insufficient_credits` error event.
// - `reasoning_effort` takes only off, low, high or max (anything else is a 400), so the agents send it only when a chat
//   picked one, as it was picked.
// - Prices are published only on refuseless.com/pricing, behind Cloudflare's browser check, which a program can't pass
//   (and must not try to), and on no public list: models.dev has no Refuseless. So the hub carries that page's prices as
//   read on 4 November 2026 (REFUSELESS_MODELS): Costs estimates a reply from them and the sheet shows them. Update them
//   from the page when they change. The balance is always read live.
//
// No request here runs a model. The key only ever goes to Refuseless's own address, and is never logged or kept here.

import { createHash } from "node:crypto";
import type { ServiceFunds, TokenPrice } from "@crosstalk/shared";
import { sameHost } from "./featherless";
import { priceWords } from "./nanogpt";

/** Where Refuseless's API is. The hub adds /v1/… for each agent (and the agent's /v1/chat/completions). */
export const REFUSELESS_ORIGIN = "https://api.refuseless.com";
/** The day the prices below were read off refuseless.com/pricing. */
export const REFUSELESS_PRICED_ON = "2026-11-04";
/** A balance read is kept this long, so opening Settings twice doesn't ask twice. */
const FUNDS_TTL_MS = 5 * 60_000;
const MAX_FUNDS = 32;

/** One model of Refuseless's lineup, as its pricing page has it. */
export interface RefuselessModel {
  /** Its name on the page. */
  name: string;
  /** USD per million tokens. */
  price: TokenPrice;
  /** Refusals removed from the weights (the page's "Abliterated models"). */
  uncensored: boolean;
  /** The most it writes in one answer (its model page and LiteLLM's table, 26 October 2026); absent where neither says. */
  maxOutput?: number;
}

/**
 * The lineup on 4 November 2026, best for a coding agent first: DeepSeek V4.1 Flash has the lineup's top agentic-coding
 * and terminal scores (DeepSWE 74.2, Terminal Bench 2.1 90.6, DeepSeek's own model card) at its lowest abliterated
 * price; GLM 5.3 is the flagship for hard work at about eight times its input price; then GLM 5.3 Flash. The two stock
 * models (the makers' own weights, refusals and all) come last. Prices with a discount are the discounted ones.
 */
export const REFUSELESS_MODELS: Record<string, RefuselessModel> = {
  "deepseek-v4.1-flash-abliterated": { name: "DeepSeek V4.1 Flash 1017 Abliterated", price: { input: 0.12, output: 0.45, cached: 0.025 }, uncensored: true, maxOutput: 131_072 },
  "glm-5.3-abliterated": { name: "GLM 5.3 Abliterated", price: { input: 1, output: 2, cached: 0.15 }, uncensored: true, maxOutput: 131_072 },
  "glm-5.3-flash-abliterated": { name: "GLM 5.3 Flash Abliterated", price: { input: 0.12, output: 0.5, cached: 0.03 }, uncensored: true, maxOutput: 131_072 },
  "deepseek-v4.1-flash-abliterated-free": { name: "DeepSeek V4.1 Flash 1017 Abliterated FREE", price: { input: 0.14, output: 0.5, cached: 0.035 }, uncensored: true },
  "deepseek-v4.1-flash-fast": { name: "DeepSeek V4.1 Flash 1017", price: { input: 0.01, output: 0.08, cached: 0.002 }, uncensored: false, maxOutput: 262_144 },
  "minimax-m3.1-flash": { name: "Minimax M3.1 Flash", price: { input: 0.02, output: 0.08, cached: 0.002 }, uncensored: false, maxOutput: 512_000 },
};

const known = (id: string): RefuselessModel | null => REFUSELESS_MODELS[id.trim().toLowerCase()] ?? null;

/** What the hub knows of one of Refuseless's models; null for one not on its page. */
export const refuselessModel = known;

/** A model's price per million tokens, as the price list takes it ([input, output, cached]); null for one not on the page. */
export function refuselessPrice(model: string | null | undefined): readonly [number, number, number | null] | null {
  const m = model ? known(model) : null;
  return m ? [m.price.input, m.price.output, m.price.cached] : null;
}

/** The models in the order to offer them: the lineup's own order first, then any newer ones as the service listed them. */
export function refuselessOrder<T extends { id: string }>(models: T[]): T[] {
  const ids = Object.keys(REFUSELESS_MODELS);
  const rank = (m: T) => {
    const i = ids.indexOf(m.id.toLowerCase());
    return i < 0 ? ids.length : i;
  };
  return models.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

/**
 * What the sheet says beside a model: its name and price from the page, and whether it is uncensored — the list's own
 * `abliterated` when it said, else the page's word for it.
 */
export function refuselessFacts(id: string, listed?: boolean): { name?: string; price?: TokenPrice; uncensored?: boolean } {
  const m = known(id);
  const uncensored = listed ?? m?.uncensored;
  return { ...(m ? { name: m.name, price: m.price } : {}), ...(uncensored === undefined ? {} : { uncensored }) };
}

/** The same in the words a model menu has after where it runs: "$0.12 in · $0.45 out per million tokens · uncensored". */
export function refuselessAbout(id: string, listed?: boolean): string | undefined {
  const f = refuselessFacts(id, listed);
  return [priceWords(f.price), f.uncensored ? "uncensored" : null].filter(Boolean).join(" · ") || undefined;
}

/** Whether Cloudflare marked an answer as its browser check (`cf-mitigated: challenge`) rather than the API's own. */
export const challenged = (res: Response): boolean => res.headers.get("cf-mitigated")?.toLowerCase() === "challenge";

/**
 * Whether a body is Cloudflare's browser check page ("Just a moment...", its challenge scripts) — and not one of its other
 * error pages (a rate limit, a server that didn't answer), which are something else to say.
 */
export const challengePage = (body: string): boolean => /<title>\s*Just a moment|cf-chl|\/cdn-cgi\/challenge-platform/i.test(body);

/** What to say when Cloudflare's check answered instead of the API. */
export function challengeWords(label: string): string {
  return `${label}'s Cloudflare check answered instead of its API (it wanted a browser), so the request never reached ${label} and your key wasn't tried. Try again in a few minutes; if it keeps happening, tell ${label}'s support.`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A key as the hub remembers what was read with it: a hash, never the key. */
const keyRef = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

/** Refuseless's balance per key, remembered for a few minutes. */
export class Refuseless {
  /** How long one request may take; the services check sets it, and tests shorten it. */
  timeoutMs = 8000;
  /** Where the requests go. CROSSTALK_REFUSELESS_URL replaces it: the tests' stand-in, so a test hub never reaches the real one. */
  origin = process.env.CROSSTALK_REFUSELESS_URL || REFUSELESS_ORIGIN;
  private readonly funds = new Map<string, { at: number; job: Promise<ServiceFunds> }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether an account or address is Refuseless (api.refuseless.com, or the stand-in the tests point at). */
  serves(baseUrl: string | null | undefined): boolean {
    if (sameHost(baseUrl, this.origin)) return true;
    if (this.origin !== REFUSELESS_ORIGIN) return false;
    try {
      return new URL(String(baseUrl ?? "")).host.toLowerCase() === "api.refuseless.com";
    } catch {
      return false;
    }
  }

  /**
   * What an account has to spend: its credit, read with its key (one free request), remembered for five minutes. A key
   * Refuseless refuses, or an answer that isn't its API, throws in plain words.
   */
  fundsOf(key: string, fresh = false): Promise<ServiceFunds> {
    if (!key) return Promise.reject(new Error("This Refuseless account has no key. Add one in its settings."));
    const ref = keyRef(key);
    const hit = this.funds.get(ref);
    if (hit && !fresh && this.now() - hit.at < FUNDS_TTL_MS) return hit.job;
    const job = this.readFunds(key);
    this.funds.set(ref, { at: this.now(), job });
    job.catch(() => this.funds.get(ref)?.job === job && this.funds.delete(ref));
    while (this.funds.size > MAX_FUNDS) this.funds.delete(this.funds.keys().next().value as string);
    return job;
  }

  private async readFunds(key: string): Promise<ServiceFunds> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}/v1/credits`, { headers: { accept: "application/json", authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    } catch (e) {
      throw new Error((e as Error)?.name === "TimeoutError" ? `Refuseless didn't answer within ${Math.round(this.timeoutMs / 1000)} seconds. Try again.` : "Couldn't reach Refuseless. Check this machine's internet connection, then try again.");
    }
    const fail = (words: string) => {
      void res.body?.cancel().catch(() => {});
      return new Error(words);
    };
    if (challenged(res)) throw fail(challengeWords("Refuseless"));
    // The API answers JSON only: a web page is Cloudflare's, its browser check or one of its error pages.
    if (/text\/html/i.test(res.headers.get("content-type") ?? "")) {
      const page = await res.text().catch(() => "");
      throw new Error(challengePage(page) ? challengeWords("Refuseless") : `Refuseless answered with a web page (error ${res.status}) instead of its API. Try again in a minute.`);
    }
    if (res.status === 401 || res.status === 403) throw fail("Refuseless refused this key. Check that you copied all of it (it starts abl_), or make a new one in its console.");
    if (res.status === 429) throw fail("Refuseless's balance was asked for too often. Try again in a minute.");
    if (!res.ok) throw fail(`Refuseless's balance answered with error ${res.status}. Try again in a minute.`);
    const j = (await res.json().catch(() => null)) as { balance?: unknown; reserved?: unknown; available?: unknown } | null;
    const available = num(j?.available) ?? num(j?.balance);
    const held = num(j?.reserved);
    if (available === null) throw new Error("Refuseless's balance wasn't readable. Try again in a minute.");
    return { balanceUsd: Number(Math.max(available, 0).toFixed(4)), heldUsd: held !== null && held > 0 ? Number(held.toFixed(4)) : null, plan: null, checkedAt: this.now() };
  }
}
