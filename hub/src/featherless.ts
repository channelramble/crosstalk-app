// Featherless (featherless.ai) as an AI service: finding a model among the 22,000+ it serves, and what each one means
// for a chat. Featherless runs open-weight models straight from Hugging Face, so its model list is the whole catalogue
// (GET https://api.featherless.ai/v1/models, about 7 MB, no key needed) — far too much to hold, to send to a phone, or
// to put in a picker. So nothing here ever reads the whole list: every search is one bounded page of the service's own
// search, and the few facts a person needs are kept from it.
//
// What this knows about Featherless comes from its docs, read on 29 October 2026:
// - featherless.ai/docs/api-reference-models: /v1/models takes `q` (name or id), `training`, `context_length_min`,
//   `page`/`per_page` and `status`; it answers with or without a key. `page=1` is what bounds an answer: with it the
//   service sends at most 100 rows (~35 KB) and the true match count, instead of every match (190 KB and up).
// - `status=active` matters: without it the service counts models that aren't deployed (53,203 against 22,414), and a
//   request for one of those would fail.
// - featherless.ai/docs/tool-calling: native tool calling is documented for the Qwen 3 family and Kimi K2 only.
// - featherless.ai/docs/concurrency-limits: a request reserves its model's concurrent units while it runs (1 for small
//   models, 2 for larger, 4 for very large), and one that would go over the plan's budget is refused with a 429.
// - featherless.ai/docs/api-reference-error-codes: 403 means a gated model whose licence hasn't been agreed yet.
//
// Its plans, and what each allows, from featherless.ai/pricing, /docs/plans (edited 15 September 2026),
// /docs/request-pricing-and-credits and /terms, read on 1 November 2026 and again on 4 November 2026:
// - Chat, $25 a month, flat: unlimited tokens, 32K of a chat at once, 4 concurrent units. "Chat plan is for interactive,
//   human-driven use by the purchaser. Not for reselling, app/API traffic, background automation, or benchmarking. Misuse
//   may lead to cancellation without refund." Its table says no to coding agents, production API and background
//   automation. Its id is `feather_pro_plus`: the plan list behind the pricing page names it "Feather Chat (formerly
//   Premium)", the /v1/plan docs' example "Feather Premium".
// - Developer, from $50 of credits a month: billed per token from prepaid credits (each model at its own rate, the one
//   /v1/models lists; only successful requests), up to 256K, 100 concurrent units; agents, API traffic and automation
//   allowed. When the credits run out, requests stop until more are added; unused credits don't expire. Its id is
//   `feather_request_pricing`, which that plan list names "Request Pricing", with no context cap of its own (each model's
//   own applies, 256K at most); Pay-As-You-Go is billed the same way.
// - The terms (/terms): "Individual plans are for interactive use or proto-typing and experimentation by the purchaser.
//   Persons making use of individual plans for other purposes will have their plan terminated and no refund will be
//   provided." The plan list also has two older plans for a person typing, Feather Basic (`feather_pro`, $10, off the
//   pricing page) and Feather Lite (`feather_lite`, free, no API access at all), and four paused flat plans built for
//   agents ($100 and $200, 256K: `feather_max`, `feather_229b_full_context`, `feather_claw_standard`,
//   `feather_claw_pro`), whose terms aren't published any more.
// Every chat Crosstalk runs on Featherless is an agent (Codex) driving it through the API, so the Chat plan is never the
// right one for it. featherless.ai/docs/api-reference-plan: GET /v1/plan answers, with the key, which plan the key is on
// ({ id, name, max_context_length, max_model_size, concurrency }; 401 without a key, as a keyless request got on 1 and
// 4 November 2026), so the hub asks it (one free read, nothing runs) and warns where it matters, instead of nagging every
// person on every plan. What it answers with a Developer key hasn't been seen here (no key of anyone's is used to look):
// the plan list's id, name and figures are what it is read against.
//
// The model list needs no key and none of these requests runs a model. The only one that carries a key is that plan read.

import { createHash } from "node:crypto";
import { CATALOG_SHOWN, planLabel, type CatalogModel, type CatalogSearch, type ServicePlan, type TokenPrice } from "@crosstalk/shared";
import type { Price } from "./prices";

/** The one catalogue the hub searches today. */
export const FEATHERLESS_HOST = "api.featherless.ai";

/** The $25 Chat plan's id, as GET /v1/plan answers it (featherless.ai/docs/plans links each plan by its id). */
export const CHAT_PLAN_ID = "feather_pro_plus";
/** The Developer plan's id: paid per token from prepaid credits. */
export const DEVELOPER_PLAN_ID = "feather_request_pricing";
/** A plan read is kept this long before it's read again: a switch of plan shows up within it. */
export const PLAN_TTL_MS = 10 * 60_000;
/** Keys whose plan is remembered at once (each by a hash, never the key). */
const MAX_PLANS = 20;
/** A plan is a handful of fields: an answer past this isn't one. */
const MAX_PLAN_BYTES = 64_000;
/** Models whose price is remembered for pricing a finished reply (each search adds at most 100). */
const MAX_PRICES = 2000;

/**
 * Featherless's plans by id, as the plan list behind its pricing page had them on 4 November 2026 (see the top of this
 * file): the three for a person typing (Chat, Basic and the free Lite, "individual plans" in its terms), the Developer
 * plan billed per token, and the paused flat plans built for agents, which Crosstalk can't vouch for either way.
 */
const PLAN_KINDS: Record<string, ServicePlan["kind"]> = {
  [CHAT_PLAN_ID]: "chat",
  feather_pro: "chat",
  feather_lite: "chat",
  [DEVELOPER_PLAN_ID]: "credits",
  feather_max: "other",
  feather_229b_full_context: "other",
  feather_claw_standard: "other",
  feather_claw_pro: "other",
};

/**
 * What a plan means for an agent, from the id and name GET /v1/plan gives it: by its id when Featherless's plan list has
 * it (PLAN_KINDS), else by its words: "credits" for the plans billed per token (Developer and Pay-As-You-Go — "request
 * pricing" is the docs' own word for that billing), "chat" for the flat plans made for a person typing, and "other" for
 * anything else — a business plan, a plan made since — about which nothing is claimed either way.
 */
export function planKind(id: string, name: string): ServicePlan["kind"] {
  const known = PLAN_KINDS[id.trim().toLowerCase()];
  if (known) return known;
  const said = `${id} ${name}`.toLowerCase();
  if (/request.?pricing|pay.?as.?you.?go|\bpayg\b|developer|credit/.test(said)) return "credits";
  if (/\bchat\b|premium|basic/.test(said)) return "chat";
  return "other";
}

/** A /v1/plan answer as the app reads it, or null when it isn't one (no id). */
export function planFrom(body: unknown, checkedAt: number): ServicePlan | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id.trim().slice(0, 100) : "";
  if (!id) return null;
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 100) : id;
  return { id, name, kind: planKind(id, name), maxContext: int(b.max_context_length), concurrency: int(b.concurrency), checkedAt };
}

/** Featherless's plans and what each allows, linked wherever Crosstalk says what they allow. */
export const PRICING_URL = "https://featherless.ai/pricing";

/**
 * Said in a chat whose agent runs on Featherless (Services.featherlessChat): on a key the hub read as on a plan for a
 * person typing (its Chat plan), once in each such chat; on a key whose plan it couldn't tell, or one it can't vouch for,
 * once, in that key's first chat. A key on the Developer plan gets nothing here: the terms allow it, and the Add sheet and
 * its row in Settings say it's paid per token. The address is written out whole: the app makes it a link
 * (web/src/views/NoteText.tsx), and an older one shows it as it is.
 */
export function chatNotice(plan: ServicePlan | null): string | null {
  if (plan?.kind === "credits") return null;
  const risk = "Featherless can cancel an account used that way without a refund.";
  const limit = `paid per token, so set a spending limit in Settings → Costs. See ${PRICING_URL}.`;
  if (plan?.kind === "chat") return `Featherless says this key is on its ${planLabel(plan)} plan, which doesn't allow agents or API use: ${risk} Agents need its Developer plan: ${limit}`;
  const chatPlan = `Featherless's $25 Chat plan doesn't allow agents or API use: ${risk}`;
  // A plan it names that Crosstalk can't vouch for (one of the paused plans built for agents, say): what the two plans on
  // sale allow, and the person checks theirs — never "agents need another plan" to someone whose plan may allow them.
  if (plan) return `Featherless says this key is on “${plan.name}”, a plan Crosstalk doesn't know: check what it allows. ${chatPlan} Its Developer plan allows them, ${limit}`;
  return `Crosstalk couldn't tell which Featherless plan this key is on. ${chatPlan} Agents need its Developer plan: ${limit}`;
}

/** A key as the hub remembers what was read with it, or said about it: a hash, never the key. */
export const keyRef = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

/** Featherless turned the key down when its plan was asked for: there's nothing to say about a plan then. */
export class KeyRefused extends Error {}

/**
 * How much of a chat the Chat plan reads at once, whatever a model could hold (featherless.ai/docs/plans: 32K, against
 * the Developer plan's 256K). It lives here, beside the catalogue, because the hub is what hands a chat its context: a
 * model saved from the Add sheet was capped there too (web/src/services.ts capContext), but one typed into Settings →
 * Accounts, or added to an account's model list later, never passed through it.
 */
export const CONTEXT_CAP = 32_768;

/**
 * Every answer is one page: `page=1` holds the service to 100 rows and makes it report how many matched in all, so a
 * broad search ("a" matches 20,746 models) is still 35 KB. `status=active` leaves out models that aren't deployed.
 */
const PAGE = "status=active&page=1&per_page=100";
/** The tag Featherless's own catalogue uses for models with the guard rails trained out (featherless.ai/models?training=abliterated). */
const UNCENSORED = "training=abliterated";
/** A search answer is kept this long, so backspacing a query doesn't ask the service again. */
const SEARCH_TTL_MS = 10 * 60_000;
/** How big the catalogue is changes slowly, and the answer costs a request: kept for a day. */
const SIZE_TTL_MS = 24 * 3600_000;
/** Searches remembered at once (each is at most 100 trimmed rows). */
const MAX_CACHED = 24;
/**
 * Nothing this reads should be big: one bounded page is about 35 KB. A body past this is a service that ignored `page`,
 * and is dropped rather than held in the hub (the whole catalogue is 7 MB).
 */
const MAX_BYTES = 1_000_000;
/** The most a query can be, so a pasted paragraph never becomes a request. */
const MAX_QUERY = 120;

/** Whether an address is the service's API, whichever way it was typed. */
export function sameHost(baseUrl: string | null | undefined, origin: string): boolean {
  try {
    return new URL(String(baseUrl ?? "")).host.toLowerCase() === new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Whether Featherless documents native tool calling for this model's family (featherless.ai/docs/tool-calling: "the
 * following model families: moonshotai/Kimi-K2-Instruct, Qwen 3 family"). An agent needs tool calls to read a file or
 * run a command, so this is what decides whether a model is offered for a chat.
 *
 * It is the docs' rule on purpose, not the model list's own `features.tool_use`: that field says yes for 16,026 of the
 * 22,406 models, including families the docs don't claim, where tool calls only work through prompting and JSON. The
 * narrower rule is the one Crosstalk can stand behind; `CatalogModel.toolsSaid` keeps the list's own claim apart from
 * it ("list"), so a model the docs don't cover is worded as not promised rather than as not able.
 */
export function toolsByDocs(modelClass: string | null | undefined): boolean {
  const c = String(modelClass ?? "").toLowerCase();
  // Not a model that holds a conversation at all, whatever its family: an embedding or speech model has no tools either.
  if (/embedding|tts|rerank|classifier/.test(c)) return false;
  // qwen3-32b, qwen3.5-27b, qwen3_5moe-35b, qwen3vl-8b, qwen3next-80b, qwen38-2400b: the Qwen 3 family as the service
  // classes it. kimi-k2 and kimi-k25 are Kimi K2; kimi3, kimi-linear and k2-horizon are other models, so they aren't in.
  return /^qwen3/.test(c) || /^kimi-k2/.test(c);
}

/** Billions of parameters as the class writes them: "qwen3.5-27b" is 27, "qwen3-0b6" is 0.6, "k2-horizon-5b1" is 5.1. */
export function paramsOf(modelClass: string | null | undefined): number | null {
  const m = /(\d+)b(\d+)?$/.exec(String(modelClass ?? "").toLowerCase());
  if (!m) return null;
  const whole = Number(m[1]);
  return Number.isFinite(whole) ? whole + (m[2] ? Number(`0.${m[2]}`) : 0) : null;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

/** A non-negative amount from a number or a numeric string; anything else is null. */
function amount(v: unknown): number | null {
  const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A model's price per million tokens as its row in /v1/models gives it: `input` and `output` per million, else `prompt`
 * and `completion` per token (the same price written the other way). Each model has its own: a niche finetune can cost
 * four times its family's usual rate (on 1 November 2026 Qwen/Qwen3.5-27B was $0.30 in and $2.40 out, unsloth's copy of it
 * $1.20 and $9.60), which is what the Developer plan bills. The list has no cached-input price, so none is claimed.
 */
export function priceOfRow(pricing: unknown): TokenPrice | null {
  const p = (pricing ?? {}) as Record<string, unknown>;
  const input = amount(p.input);
  const output = amount(p.output);
  if (input !== null && output !== null) return { input, output, cached: null };
  const prompt = amount(p.prompt);
  const completion = amount(p.completion);
  if (prompt === null || completion === null) return null;
  return { input: Number((prompt * 1e6).toPrecision(9)), output: Number((completion * 1e6).toPrecision(9)), cached: null };
}

/** One row of /v1/models, kept down to what a phone shows. */
function rowOf(raw: Record<string, unknown>): CatalogModel | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  // A name with a space in it can't be passed to an agent as a model name (serviceModelsKept drops those too).
  if (!id || id.length > 200 || /\s/.test(id)) return null;
  const modelClass = typeof raw.model_class === "string" ? raw.model_class : null;
  const tools = toolsByDocs(modelClass);
  // What the list itself claims for this model (features.tool_use: true on 16,026 of the 22,406 rows). It never turns a
  // no into a yes — the docs' narrower rule is the one Crosstalk stands behind — but it is the difference between "the
  // docs don't promise this family" and "this model can't", which is how the words read (CATALOG_LIST_TOOLS_WORDS).
  const claimed = (raw.features as { tool_use?: unknown } | null | undefined)?.tool_use === true;
  const price = priceOfRow(raw.pricing);
  return {
    id,
    modelClass,
    params: paramsOf(modelClass),
    contextWindow: int(raw.context_length),
    concurrency: int(raw.concurrency_cost),
    gated: raw.is_gated === true,
    tools,
    toolsSaid: tools || !claimed ? "docs" : "list",
    // What a reply on it costs on the Developer plan, said beside the model where it's picked.
    ...(price ? { price } : {}),
  };
}

/** A query as it goes to the service: trimmed, and never long enough to be anything but a name. */
export const cleanQuery = (q: unknown): string => String(q ?? "").trim().slice(0, MAX_QUERY);

/**
 * Best first: the name typed exactly, then the models an agent can actually work with (tool calls), and within those
 * the closest name — one whose model name (after the owner) starts with what was typed before one it merely appears in
 * — then the roomiest, then the biggest (the one likelier to manage an agent's work; what each costs per token is said
 * beside it), then the cheapest in concurrent units. Models the service put first (its own order: newest first) keep
 * their place among equals, so a search for nothing in particular still reads as the service's own shortlist.
 */
export function rank(models: CatalogModel[], q: string): CatalogModel[] {
  const want = q.toLowerCase();
  const name = (id: string) => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id).toLowerCase();
  const match = (m: CatalogModel) => {
    if (!want) return 0;
    const id = m.id.toLowerCase();
    if (id === want || name(m.id) === want) return 0;
    if (name(m.id).startsWith(want) || id.startsWith(want)) return 1;
    return id.includes(want) ? 2 : 3;
  };
  return models
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        Number(match(b.m) === 0) - Number(match(a.m) === 0) ||
        Number(b.m.tools) - Number(a.m.tools) ||
        match(a.m) - match(b.m) ||
        (b.m.contextWindow ?? 0) - (a.m.contextWindow ?? 0) ||
        (b.m.params ?? 0) - (a.m.params ?? 0) ||
        (a.m.concurrency ?? 9) - (b.m.concurrency ?? 9) ||
        a.i - b.i,
    )
    .map(({ m }) => m);
}

interface Page {
  rows: CatalogModel[];
  /** How many matched in all, as the service's pagination says (its own count, not ours). */
  matched: number;
}

/** What went wrong, in words a person can act on. */
const problem = (what: string) => new Error(what);

/**
 * One bounded GET of the model list. The body is read in pieces and dropped if it grows past MAX_BYTES: an answer that
 * ignored `page` would be the whole 7 MB catalogue, which must never sit in the hub's memory.
 */
async function readPage(url: string, timeoutMs: number): Promise<Page> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw problem((e as Error)?.name === "TimeoutError" ? `Featherless didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Try again.` : "Couldn't reach Featherless. Check this machine's internet connection, then try again.");
  }
  const length = Number(res.headers.get("content-length"));
  if (res.status === 401 || res.status === 403) throw problem("Featherless wouldn't show its model list. Try again in a minute.");
  if (!res.ok) throw problem(`Featherless's model list answered with error ${res.status}. Try again in a minute.`);
  if (Number.isFinite(length) && length > MAX_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw problem("Featherless sent back far more than Crosstalk asked for. Try again in a minute.");
  }
  const text = await readBody(res);
  let body: { data?: unknown; pagination?: { total_items?: unknown }; total?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw problem("Featherless's model list wasn't readable. Try again in a minute.");
  }
  const raw = Array.isArray(body.data) ? body.data : null;
  if (!raw) throw problem("Featherless's model list wasn't readable. Try again in a minute.");
  const rows = raw.map((r) => rowOf((r ?? {}) as Record<string, unknown>)).filter((r): r is CatalogModel => !!r);
  return { rows, matched: int(body.pagination?.total_items) ?? int(body.total) ?? rows.length };
}

/** The body, given up on once it is bigger than one page could be (a service that ignored `page` would send 7 MB). */
async function readBody(res: Response, max = MAX_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      throw problem("Featherless sent back far more than Crosstalk asked for. Try again in a minute.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Where the plans read are kept across restarts (the hub's kv), so a key's plan is known from the first reply after one. */
export interface PlanStore {
  get(): string | null;
  set(value: string): void;
}

/** A failed plan read is tried again after this long, not on every reply. */
const PLAN_RETRY_MS = 60_000;

/**
 * Featherless's catalogue, searched one bounded page at a time and remembered for a few minutes. Nothing here holds the
 * whole list: a search is 100 rows at most, trimmed to the handful of facts a phone shows, and the same query asked
 * twice (typing, then backspacing) is answered from what was kept. Also which plan each key is on (GET /v1/plan), and
 * each model's price as the list gives it, for the ledger.
 */
export class Featherless {
  /** How long one request may take; the services check sets it, and tests shorten it. */
  timeoutMs = 8000;
  /**
   * Where the requests go. CROSSTALK_FEATHERLESS_URL replaces it, which is how the tests point it at a stand-in on a
   * loopback port (and how the test hubs make sure they never reach the real service).
   */
  origin = process.env.CROSSTALK_FEATHERLESS_URL || `https://${FEATHERLESS_HOST}`;

  private readonly cache = new Map<string, { at: number; job: Promise<Page> }>();
  private size: { at: number; job: Promise<Page> } | null = null;
  /** Each model's price as the list last gave it (by its id in lower case), for pricing a finished reply without asking. */
  private readonly prices = new Map<string, TokenPrice>();
  /** Plan reads, in flight or answered, per key hash, until `until`. */
  private readonly plans = new Map<string, { until: number; job: Promise<ServicePlan | null> }>();
  /** The last plan read per key hash, kept past its time and across restarts (`keep`); loaded when first asked. */
  private known: Map<string, ServicePlan> | null = null;

  constructor(
    private readonly keep?: PlanStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether this account or address is Featherless, so its model list is searched instead of read. */
  serves(baseUrl: string | null | undefined): boolean {
    return sameHost(baseUrl, this.origin);
  }

  /**
   * The same, for a host as the ledger keeps it ("api.featherless.ai"). Its port has to be Featherless's too, so a model
   * server on this machine is never taken for the stand-in the tests put on a loopback port.
   */
  servesHost(host: string | null | undefined): boolean {
    if (!host) return false;
    try {
      const asked = new URL(`https://${host}`);
      const own = new URL(this.origin);
      return asked.hostname.toLowerCase() === own.hostname.toLowerCase() && asked.port === own.port;
    } catch {
      return false;
    }
  }

  /**
   * Whether a reply on this account costs nothing of its own: only when its key was last read as being on a flat chat
   * plan, one fee a month however much is sent — a plan whose terms don't allow agents, as every screen that adds
   * Featherless, and every chat run on such a key, says. Any other key (the Developer plan, Pay-As-You-Go, a plan
   * Crosstalk doesn't know, one never read) is priced per token, at the model's own price in Featherless's list: anything
   * not known is priced, never called free. Asking starts a read of an old answer, for the next reply.
   */
  flatRate(baseUrl: string | null | undefined, key: string | null | undefined): boolean {
    return !!key && this.serves(baseUrl) && this.lastPlan(key, true)?.kind === "chat";
  }

  /**
   * How much of a chat a model saved without a size of its own may be given on this key: its plan's own cap when the plan
   * was read (null: the plan has none, the model's own size stands), else the Chat plan's 32K, so no chat is told it has
   * room a plan won't serve.
   */
  capFor(key: string | null | undefined): number | null {
    const plan = this.lastPlan(key);
    return plan ? plan.maxContext : CONTEXT_CAP;
  }

  /**
   * Which plan this key is on (GET /v1/plan, with the key: free, nothing runs), remembered for ten minutes, and the last
   * answer kept past that. Null when its answer isn't a plan, or the address answers 403 or 404 for a key whose plan was
   * never read (for one that was, the last plan read stands: such an answer says nothing about the plan). A key it turns down is
   * a KeyRefused; anything else that goes wrong, an Error in plain words (tried again after a minute, not at once). The
   * key goes only to the service's own address, never after a redirect, and is never logged or kept: only a hash of it.
   */
  planOf(key: string, fresh = false): Promise<ServicePlan | null> {
    if (!key) return Promise.reject(new KeyRefused("This Featherless account has no key. Add one with Change."));
    const ref = keyRef(key);
    const hit = this.plans.get(ref);
    if (hit && !fresh && this.now() < hit.until) return hit.job;
    const job = this.readPlan(key);
    this.plans.set(ref, { until: this.now() + PLAN_TTL_MS, job });
    job.then(
      // Only the newest read for a key counts: an older one that answers late doesn't undo it.
      (plan) => this.plans.get(ref)?.job === job && this.remember(ref, plan),
      () => {
        const now = this.plans.get(ref);
        if (now?.job === job) now.until = this.now() + PLAN_RETRY_MS;
      },
    );
    // Oldest out first, so keys that were tried and dropped can't pile up.
    while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value as string);
    return job;
  }

  /**
   * The last plan read for this key, however old (null: never read, or the service didn't say), without asking. With
   * `refresh`, an answer over ten minutes old (or none) starts a read in the background, for the next time it's asked.
   */
  lastPlan(key: string | null | undefined, refresh = false): ServicePlan | null {
    if (!key) return null;
    const plan = this.saved().get(keyRef(key)) ?? null;
    if (refresh && (!plan || this.now() - plan.checkedAt >= PLAN_TTL_MS)) void this.planOf(key).catch(() => {});
    return plan;
  }

  private async readPlan(key: string): Promise<ServicePlan | null> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}/v1/plan`, { headers: { accept: "application/json", authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw problem((e as Error)?.name === "TimeoutError" ? `Featherless didn't say which plan this key is on within ${Math.round(this.timeoutMs / 1000)} seconds.` : "Couldn't reach Featherless to ask which plan this key is on.");
    }
    const drop = () => void res.body?.cancel().catch(() => {});
    if (res.status === 401) {
      drop();
      throw new KeyRefused("Featherless refused this key. Paste a working one with Change.");
    }
    // No such address (any more), or not one this key may read just now (a block on the way, a route Featherless keeps
    // from this key): that says nothing about the plan. What was last read for this key stands, so a Developer key
    // checked at the Add sheet never becomes "which plan?" (and the Chat plan's 32K) over one 403. Only a key whose plan
    // was never read is unknown.
    if (res.status === 403 || res.status === 404) {
      drop();
      return this.saved().get(keyRef(key)) ?? null;
    }
    if (!res.ok) {
      drop();
      throw problem(`Featherless answered with error ${res.status} when asked which plan this key is on. Try again in a minute.`);
    }
    try {
      return planFrom(JSON.parse(await readBody(res, MAX_PLAN_BYTES)), this.now());
    } catch {
      return null;
    }
  }

  private saved(): Map<string, ServicePlan> {
    if (!this.known) {
      this.known = new Map();
      try {
        const kept = JSON.parse(this.keep?.get() ?? "{}") as Record<string, Partial<ServicePlan> | null>;
        for (const [ref, p] of Object.entries(kept ?? {})) {
          const plan = p && typeof p.checkedAt === "number" ? planFrom({ id: p.id, name: p.name, max_context_length: p.maxContext, concurrency: p.concurrency }, p.checkedAt) : null;
          if (plan) this.known.set(ref, plan);
        }
      } catch {
        // Unreadable: every key's plan is read again when it's next asked about.
      }
    }
    return this.known;
  }

  /** Keeps (or, for an answer that wasn't a plan, forgets) what a key's plan is. A 403 or 404 keeps the last one (readPlan). */
  private remember(ref: string, plan: ServicePlan | null) {
    const all = this.saved();
    all.delete(ref);
    if (plan) all.set(ref, plan);
    while (all.size > MAX_PLANS) all.delete(all.keys().next().value as string);
    try {
      this.keep?.set(JSON.stringify(Object.fromEntries(all)));
    } catch {
      // The database closed under it (a hub shutting down): what was read still counts until then.
    }
  }

  /** Keeps each listed model's price, newest last, so the ledger can price a reply without asking. */
  private notePrices(rows: CatalogModel[]) {
    for (const r of rows) {
      if (!r.price) continue;
      const id = r.id.toLowerCase();
      this.prices.delete(id);
      this.prices.set(id, r.price);
    }
    while (this.prices.size > MAX_PRICES) this.prices.delete(this.prices.keys().next().value as string);
  }

  /**
   * What a reply on this model costs per million tokens on this host (in, out, cached), as Featherless's own list prices
   * it — the rate its Developer plan bills, which no other price list has for a Hugging Face finetune. From the rows the
   * hub has read already (a search, an account's model menu): null when `host` isn't Featherless's, or the model hasn't
   * been seen yet, and then it is looked up by name in the background, so the next reply has it.
   */
  priceFor(host: string | null | undefined, model: string | null | undefined): Price | null {
    if (!model || !this.servesHost(host)) return null;
    const p = this.prices.get(model.trim().toLowerCase());
    if (p) return [p.input, p.output, p.cached];
    void this.models([model]).catch(() => {});
    return null;
  }

  /** One query, from what was kept when it's fresh. The in-flight request is shared, so two phones typing the same thing ask once. */
  private page(query: string, ttl: number): Promise<Page> {
    const hit = this.cache.get(query);
    if (hit && Date.now() - hit.at < ttl) return hit.job;
    const job = this.ask(query);
    this.cache.set(query, { at: Date.now(), job });
    // A failed request isn't kept: the next search tries again rather than repeating the error for ten minutes.
    job.catch(() => this.cache.delete(query));
    // Oldest out first, so a long session of typing can't grow this without end.
    while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value as string);
    return job;
  }

  private async ask(query: string): Promise<Page> {
    const page = await readPage(`${this.origin}/v1/models?${query}`, this.timeoutMs);
    this.notePrices(page.rows);
    return page;
  }

  /** How many models the catalogue has (kept for a day), and whether it can be read at all. */
  async total(): Promise<number> {
    if (!this.size || Date.now() - this.size.at >= SIZE_TTL_MS) {
      const job = this.ask(PAGE);
      this.size = { at: Date.now(), job };
      job.catch(() => (this.size = null));
    }
    return (await this.size.job).matched;
  }

  /**
   * The models to show for what was typed: the service's own search when there's a query, else its abliterated models
   * (the tag its own catalogue uses), ranked so an agent-ready model comes first. `matched` is how many the service
   * found in all, so the app can say "type more to narrow it down" rather than pretending these are all of them.
   */
  async search(input: unknown): Promise<CatalogSearch> {
    const q = cleanQuery(input);
    const query = q ? `${PAGE}&q=${encodeURIComponent(q)}` : `${PAGE}&${UNCENSORED}`;
    const [page, total] = await Promise.all([this.page(query, SEARCH_TTL_MS), this.total().catch(() => 0)]);
    return { name: "featherless", q, models: rank(page.rows, q).slice(0, CATALOG_SHOWN), matched: page.matched, total };
  }

  /**
   * What the catalogue says about models that are already saved on an account, for its model menu: each one is asked for
   * by name, which is a tiny answer, instead of reading the catalogue. One the catalogue no longer has is left out, and
   * the saved facts stand for it.
   */
  async models(ids: string[]): Promise<{ id: string; contextWindow: number | null; tools: boolean }[]> {
    const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 20);
    if (!wanted.length) return [];
    const answers = await Promise.all(
      wanted.map(async (id) => {
        try {
          const page = await this.page(`${PAGE}&q=${encodeURIComponent(id)}`, SEARCH_TTL_MS);
          const row = page.rows.find((r) => r.id.toLowerCase() === id.toLowerCase());
          return row ? { id: row.id, contextWindow: row.contextWindow, tools: row.tools } : null;
        } catch (e) {
          return e as Error;
        }
      }),
    );
    const rows = answers.filter((a): a is { id: string; contextWindow: number | null; tools: boolean } => !!a && !(a instanceof Error));
    // Only when not one of them could be asked is this a failure: otherwise the models that answered are the list, and
    // the rest keep what the account saved for them.
    const failed = answers.find((a): a is Error => a instanceof Error);
    if (!rows.length && failed) throw failed;
    return rows;
  }
}
