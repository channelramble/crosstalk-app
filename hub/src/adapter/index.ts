// The chat adapter (docs/SPEC-0.4.md, track T6): a translator on 127.0.0.1 that lets Codex, which only speaks the Responses API, use
// a server that only speaks Chat Completions (Gemini's OpenAI-compatible endpoint, mlx-lm, others) and still use its tools.
//
// One Bun.serve on 127.0.0.1, port 0, owned by App: started the first time an account needs it, ended in shutdown(). Never the
// main port (Tailscale publishes that) and never the internal Unix socket. One route family, /a/<accountId>/v1/responses, guarded by
// a random token per account. The token is the "key" Codex is given; the upstream's real key stays here and never reaches the agent.
// The port and the tokens are kept in the database, so a restarted hub answers the address a still-loaded Codex thread remembers.
// The translation itself (translate.ts) is plain functions; this file is the server, the upstream call and the plain-words errors.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Provider } from "@crosstalk/shared";
import type { App } from "../app";
import { autoCompactLimit } from "../agents/driver";
import { logger } from "../util/log";
import { measure, noteToolCost } from "./cost";
import {
  BadRequest,
  NO_RETRY,
  StreamMapper,
  UpstreamError,
  fitToWindow,
  frame,
  groupLabel,
  isObj,
  requestSize,
  sseData,
  str,
  toChatRequest,
  type RequestSize,
  type SseEvent,
  type ToolRoutes,
  type Trimmed,
} from "./translate";

const log = logger("adapter");

/** kv key for what survives a restart: the port and the tokens (see ChatAdapter.resume). */
const KV_KEY = "adapter";

/** No bytes from the upstream for this long ends the reply with an error. Codex's own limit is 5 minutes; it is kept fed meanwhile. */
const IDLE_MS = 5 * 60_000;
/** While the upstream is silent (reading a long prompt, thinking), Codex hears a do-nothing event this often so it keeps waiting. */
const KEEP_ALIVE_MS = 15_000;
/** How long before the adapter's own single try again at the upstream (see callUpstream). */
const RETRY_MS = 400;
/** How long shutdown waits for the replies in flight to tell Codex why they ended, rather than leaving streams that just stop. */
const SHUTDOWN_GRACE_MS = 200;

/** Why an upstream call was given up on. Told apart because the answer Codex gets depends on it (and for `cancel`, there is none). */
const CODEX_LEFT = "codex-left";
const STALLED = "upstream-stalled";
const SHUTTING_DOWN = "hub-shutting-down";

export interface AdapterOptions {
  /** How long the upstream may stay silent before the reply ends with an error. */
  idleMs?: number;
  /** How often Codex hears a do-nothing event while the upstream is silent. */
  keepAliveMs?: number;
}

type Endpoint = NonNullable<ReturnType<App["providers"]["endpointOf"]>>;
interface Failure {
  code: string;
  message: string;
}

/**
 * An error the way the Responses API sends one (before a stream starts): Codex shows `message`. For a request that carries no
 * prompt only — a GET, an unknown path, a token that isn't ours — because Codex re-sends the whole request body for most
 * statuses (404: 6 times, 401: 7, 405: 8, 409: 10, 500: 57; see translate.ts NO_RETRY). Those requests carry nothing to re-send
 * and these statuses are what says a token is good, so they keep them.
 */
const httpError = (status: number, code: string, message: string, param: string | null = null) =>
  Response.json({ error: { message, type: "invalid_request_error", param, code } }, { status });

/**
 * A refusal of a request that carries a prompt: HTTP 400 and a code Codex 0.160 takes as final (translate.ts NO_RETRY), whatever
 * the reason was. Never another status: Codex reads a 409, a 401 or a 500 as a broken stream and POSTs the identical request
 * again — 666 KB of tool schemas and conversation a time in one measured case, 57 times for a 500, to a service that may bill for each.
 * Measured against a real `codex exec`: this shape costs exactly one request.
 */
const refusePrompt = (message: string, param: string | null = null) => httpError(400, NO_RETRY[0], message, param);

const sameToken = (given: string, token: string) => given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
/** A token count in plain words: rounded to the nearest thousand once it's big, because it is an estimate. */
const roughly = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 1000).toLocaleString("en-US")},000`);
/** A size the model itself states, exactly (16,384). */
const exactly = (n: number): string => n.toLocaleString("en-US");
/** Words that came from the upstream never carry our key back (an error that echoes its request would). */
const scrub = (s: string, key: string) => (key.length >= 6 ? s.split(key).join("[key]") : s);
const waited = (ms: number) => {
  const secs = Math.max(1, Math.round(ms / 1000));
  const [n, unit] = secs >= 60 ? [Math.round(secs / 60), "minute"] : [secs, "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};

function upstreamUrl(ep: Endpoint): string {
  const path = ep.chatPath ? (ep.chatPath.startsWith("/") ? ep.chatPath : `/${ep.chatPath}`) : "/v1/chat/completions";
  return ep.baseUrl + path;
}

/** What an upstream error body says, in one short line (OpenAI: {error:{message}}, Gemini: [{error:{message}}], Ollama: {error:"..."}). */
function said(raw: string): string {
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* not JSON: the text is the message */
  }
  const first = Array.isArray(json) ? json[0] : json;
  const err = isObj(first) ? (first.error ?? first) : null;
  const msg = typeof err === "string" ? err : isObj(err) ? str(err.message) || str(err.detail) : json === null ? raw : "";
  return msg.replace(/\s+/g, " ").trim().slice(0, 200).replace(/[.!?\s]+$/, "");
}

/**
 * How long to wait after a 429, in seconds: Retry-After, else the soonest reset the rate-limit headers name
 * (`x-ratelimit-reset-requests` and `-tokens`). Services write those three ways, so the number is read by its size: a unix
 * time in milliseconds (Venice: docs.venice.ai/api-reference/rate-limiting), a unix time in seconds, or a number of seconds
 * from now. Null when nothing says, or says something a person couldn't wait for (over a day).
 */
export function retrySeconds(headers: Headers, now = Date.now()): number | null {
  const wait = (name: string): number | null => {
    const n = Number(headers.get(name));
    if (!Number.isFinite(n) || n <= 0) return null;
    // Told apart by size: 1e11 milliseconds is 1973 and 1e9 seconds is 2001, so anything bigger than those is a time, not
    // a wait. A wait that large is refused below anyway (1e9 seconds is 31 years).
    const secs = n > 1e11 ? (n - now) / 1000 : n > 1e9 ? n - now / 1000 : n;
    return secs > 0 && secs <= 24 * 3600 ? Math.ceil(secs) : null;
  };
  const after = wait("retry-after");
  if (after) return after;
  const resets = [wait("x-ratelimit-reset-requests"), wait("x-ratelimit-reset-tokens")].filter((n): n is number => n !== null);
  return resets.length ? Math.min(...resets) : null;
}

/**
 * The same words, but only when the service itself said them: a body that isn't JSON (a proxy's HTML block page, a
 * gateway's plain text) gives nothing back. Used where the words themselves decide what a refusal means, so something
 * between the hub and the service can't have its 403 read as the service's own answer about a model.
 */
function saidByService(raw: string): string {
  try {
    JSON.parse(raw);
  } catch {
    return "";
  }
  return said(raw);
}

/** What Crosstalk left out of this request, in plain words: how many tools, and which servers they were (see translate.ts toolGroup). */
function leftOutWords(t: Trimmed): string {
  if (!t.dropped) return "";
  const names = t.droppedGroups.map(groupLabel).filter(Boolean);
  const shown = names.slice(0, 2).join(", ");
  const rest = names.length > 2 ? ` and ${names.length - 2} more` : "";
  return ` Crosstalk already left ${t.dropped} tools out${shown ? ` (${shown}${rest})` : ""}.`;
}

/**
 * Words for a request this model plainly can't hold, said before it is sent (see translate.ts `fitToWindow`), naming what is too big:
 * the tools Codex attaches, the agent's own prompt, or what has been said in the chat — whichever of the three is the bulk of it.
 * Crosstalk has already left out every tool group it may (`t.dropped`) by the time this is said, and every branch names what went.
 *
 * The conversation is counted without the agent's own system message: 6,284 of the 6,962 tokens of a first "hi!" are Codex's own
 * instructions, so calling all of that "the conversation" would blame the person for a chat one word long — the thing this is here
 * to stop.
 */
function tooBigWords(model: string, t: Trimmed): string {
  const held = `${model} holds ${exactly(t.window)}`;
  const bigger = "pick a model with a bigger context in the chat's settings";
  const said = Math.max(0, t.size.messages - t.size.instructions);
  const own = t.size.instructions + t.size.tools; // the agent's own prompt and the tools it can't work without
  const already = leftOutWords(t);
  // A long chat: the only one of the three a new chat would fix, so it is the only one that says so.
  if (said > t.size.instructions && said > t.size.tools)
    return `This chat is longer than ${model} can hold: about ${roughly(said)} tokens of what's been said, beside about ${roughly(own)} for Codex's own instructions and tools, and ${held}.${already} Start a new chat, or move this one to a model with a bigger context in its settings.`;
  // The tools are the bulk even after every group that may go has gone (a pinned tool, or a catalogue of Codex's own that grew).
  if (t.size.tools > t.size.instructions)
    return `${model} can't hold the tools Codex sends: about ${roughly(t.size.tools)} tokens of descriptions for ${t.size.toolCount} tools, beside about ${roughly(t.size.instructions)} for Codex's own instructions and ${roughly(said)} for this chat, and ${held}.${already} This isn't the chat's length — ${bigger}.`;
  // The agent's own prompt is the bulk: a new chat would be exactly this big, so saying "start a new chat" would send the person
  // round in circles. This is the case the model is simply too small for, and the only way out is a bigger one.
  return `${model} is too small for Codex: its own instructions and tools come to about ${roughly(own)} tokens before anything you type, and ${held}.${already} So ${bigger}.`;
}

/**
 * How many tokens the server itself counted in the prompt, when its refusal says: llama.cpp's carries `n_prompt_tokens` beside
 * `n_ctx` ({"error":{"message":"request (139930 tokens) exceeds the available context size (16384 tokens), try increasing it",
 * "n_prompt_tokens":139930,"n_ctx":16384}}). Only a number the service's own JSON states counts; nothing is read out of its words.
 */
function serverCounted(raw: string): number | null {
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return null; // not JSON: nothing counted anything
  }
  const err = isObj(body) ? (isObj(body.error) ? body.error : body) : null;
  const n = err ? Number(err.n_prompt_tokens ?? err.prompt_tokens) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** An upstream HTTP error as a Responses failure Codex shows plainly. "invalid_prompt" makes Codex stop instead of retrying. */
function upstreamProblem(status: number, raw: string, label: string, model: string, headers: Headers, size: RequestSize): Failure {
  const stop = (message: string): Failure => ({ code: "invalid_prompt", message });
  const why = said(raw);
  // A gated model is refused until its licence is agreed on the service's own page, and a model the plan doesn't include
  // is refused whatever the key is: neither is a key problem, so neither says the key was refused (Featherless answers
  // 403 for both: featherless.ai/docs/api-reference-error-codes, /docs/api-reference-models). Both of them read the
  // service's own error words only: a 403 from a proxy or a firewall in between is a key or a network problem, and
  // still says so.
  const refused = status === 403 ? saidByService(raw) : "";
  if (/gated|licen[cs]e/i.test(refused)) return stop(`${label} won't run ${model} until you agree to that model's licence on ${label}'s own website. Open the model there, agree, then try again.`);
  if (/\bplan\b|not available/i.test(refused)) return stop(`${label} says ${model} isn't included in your plan. Pick another model in Settings → AI services, or change your plan with ${label}.`);
  if (status === 401 || status === 403) return stop(`${label} refused this key. Paste a working key in Settings → AI services, then try again.`);
  if (status === 404) return stop(`${label} has no model called "${model}" at that address. Check the model name and address in Settings → AI services.`);
  if (status === 429) {
    if (/quota|billing|credit|exceeded your/i.test(raw)) return stop(`${label} says you're out of quota or credit. Add credit with ${label}, then try again.`);
    // The wait goes into the words: Codex retries this itself, and if it gives up the hub reads the time back out
    // of the message to wait for the reset (limits.ts resetFromText).
    const secs = retrySeconds(headers);
    const after = secs ? ` Try again in ${waited(secs * 1000)}.` : "";
    // A plan that allows only so many requests at the same time refuses the one that would go over, which is a wait of
    // seconds while another chat finishes — not a window that resets later (Featherless reserves "concurrent units" per
    // request, more for a bigger model: featherless.ai/docs/concurrency-limits). Saying which it is tells the person
    // what to do; the code stays the same, so the agent may still try again by itself. The short wait is in the words
    // on purpose: Featherless sends no Retry-After for this, and with no time in them the hub would read it as a window
    // it can't see and leave the reply waiting five minutes (limits.ts resetFromText, engine.ts BACKOFF_MS) for a
    // refusal that clears while you watch.
    if (/concurren/i.test(raw)) return { code: "rate_limit_exceeded", message: `${label} is already running as many requests at once as your plan allows. Wait for one of your other chats or asks to finish.${after || " Try again in 20 seconds."}` };
    return { code: "rate_limit_exceeded", message: `${label} is busy right now. Wait a moment and try again.${after}` };
  }
  if (status === 413 || (status === 400 && /context|too many tokens|too long|maximum.*(length|tokens)/i.test(raw))) {
    // Not "this chat is too long": on a small model most of a Codex request is the tool descriptions it attaches to every one of them
    // (hundreds, see translate.ts fitToWindow), so the words say what was actually sent. The code must not be `context_length_exceeded`
    // either: Codex 0.160 throws those words away and shows "Codex ran out of room in the model's context window. Start a new thread or
    // clear earlier history before retrying." instead (checked by sending it both codes), which sends the person off to clear a history
    // that may be one line long. `invalid_prompt` it shows as it is, and doesn't retry.
    const tools = size.toolCount ? `, ${roughly(size.tools)} of them descriptions of ${size.toolCount} tools` : "";
    // Crosstalk's own figure is an estimate (translate.ts textTokens), so where the server counted the prompt itself, its number
    // goes in the words instead: saying "about 16,000" for a prompt the server counted at 20,024 is worse than saying nothing.
    const counted = serverCounted(raw);
    const sent = counted ? `${label} counted ${exactly(counted)} tokens in what Crosstalk sent${tools}` : `Crosstalk sent about ${roughly(size.total)} tokens${tools}`;
    return { code: "invalid_prompt", message: `${label} says this is more than ${model} can hold. ${sent}. Use a model with a bigger context in the chat's settings, or start a new chat.` };
  }
  // Not `server_error`: Codex answers that by re-sending the whole prompt six times (NO_RETRY). The adapter has already tried
  // the server a second time by now (callUpstream), which is the retry that doesn't cost a second copy of the request.
  if (status >= 500) return stop(`${label} had a problem (error ${status}). Try again in a moment.`);
  return stop(`${label} refused the request${why ? `: ${why}` : ""}. Check the model and settings in Settings → AI services.`);
}

export class ChatAdapter {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private closed = false;
  /** Account id -> the token its agent presents. Made on first use, kept in the database with the port (see resume). */
  private readonly tokens = new Map<string, string>();
  private readonly inflight = new Set<AbortController>();
  private readonly idleMs: number;
  private readonly keepAliveMs: number;
  private savedPort = 0;
  private loaded = false;

  constructor(
    private readonly app: App,
    opts: AdapterOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.keepAliveMs = opts.keepAliveMs ?? KEEP_ALIVE_MS;
    // Once the App is built (its store isn't ready inside its constructor).
    queueMicrotask(() => this.resume());
  }

  /**
   * A hub that used the adapter before listens again at start, on the same port and with the same tokens. A Codex thread that the Codex
   * app's shared server still has loaded keeps the address and key it was started with (the server keeps a loaded thread's old
   * config), so after a hub restart it would otherwise call a port nobody answers on.
   */
  private resume() {
    if (this.closed) return;
    this.load();
    if (this.savedPort && [...this.tokens.keys()].some((id) => this.app.providers.endpointOf("codex", id)?.protocol === "chat")) this.listen();
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved: unknown = JSON.parse(this.app.store.kvGet(KV_KEY) ?? "{}");
      if (!isObj(saved)) return;
      this.savedPort = typeof saved.port === "number" ? saved.port : 0;
      if (isObj(saved.tokens)) for (const [id, token] of Object.entries(saved.tokens)) if (typeof token === "string" && token) this.tokens.set(id, token);
    } catch {
      /* nothing usable saved */
    }
  }

  private save() {
    const live = [...this.tokens].filter(([id]) => this.app.providers.endpointOf("codex", id)?.protocol === "chat");
    this.app.store.kvSet(KV_KEY, JSON.stringify({ port: this.server?.port ?? this.savedPort, tokens: Object.fromEntries(live) }));
  }

  /** The server, started if it isn't running: on the port it had last time when that is free, else a new one. */
  private listen() {
    if (this.server) return this.server;
    this.load();
    // idleTimeout 0: a reply can be silent for minutes (a long prompt, a thinking model); the stall timer in pump() is the limit.
    const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (req) => this.handle(req) });
    try {
      this.server = serve(this.savedPort);
    } catch {
      this.server = serve(0); // something else has the old port
    }
    log.info(`chat adapter listening on 127.0.0.1:${this.server.port}`);
    this.save();
    return this.server;
  }

  /**
   * Where the agent should connect for an endpoint account whose server only speaks Chat Completions (account `protocol: "chat"`,
   * provider codex): the adapter's own address and a per-account token. Null for any other account. Codex then talks to
   * `<baseUrl>/v1/responses` as it does with any custom model.
   */
  urlFor(provider: Provider, accountId: string): { baseUrl: string; key: string } | null {
    if (provider !== "codex" || this.closed || this.app.providers.endpointOf(provider, accountId)?.protocol !== "chat") return null;
    const server = this.listen();
    let key = this.tokens.get(accountId);
    if (!key) {
      this.tokens.set(accountId, (key = `ct-${randomBytes(24).toString("base64url")}`));
      this.save();
    }
    return { baseUrl: `http://127.0.0.1:${server.port}/a/${accountId}`, key };
  }

  /**
   * What the model this request names can hold (tokens), the way a chat's own driver is told it: the size saved with the account for
   * that model, else the one the server listed for it, else the account's (App.endpointFor). Null when nothing says, and then nothing
   * is measured or left out — a size Crosstalk doesn't know is not a size to hold a request against.
   *
   * `compactAt` is the size the hub tells Codex to summarise the conversation at for an account like this one (driver.ts
   * `autoCompactLimit`: three quarters of the window). A request bigger than that is compacted the moment it arrives, every turn,
   * and compaction can only shrink the conversation — which on a small model is a twentieth of the prompt — so the request is fitted
   * to that figure as well. A chat whose own settings set a different threshold isn't known here (a request says nothing about the
   * chat it belongs to); this is the one nearly every chat has.
   */
  private sizesFor(ep: Endpoint, model: string): { window: number; compactAt: number | null } | null {
    let window: number | null = null;
    try {
      window = this.app.endpointFor("codex", ep.id, model)?.contextWindow ?? null;
    } catch {
      window = ep.contexts?.[model] ?? ep.contextWindow ?? null;
    }
    return window ? { window, compactAt: autoCompactLimit(undefined, { contextWindow: window }) } : null;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const up of this.inflight) up.abort(SHUTTING_DOWN);
    // A moment for each reply in flight to say why it stopped. A stream that simply closes is one Codex answers by re-sending
    // the whole prompt (seven times, measured), and a hub restart ends every one of them at once.
    for (let waited = 0; this.inflight.size && waited < SHUTDOWN_GRACE_MS; waited += 10) await Bun.sleep(10);
    this.inflight.clear();
    this.tokens.clear();
    const server = this.server;
    this.server = null;
    await server?.stop(true);
  }

  private async handle(req: Request): Promise<Response> {
    // Whether Codex has handed a prompt over: from here on a refusal must be one it won't answer by sending the whole thing
    // again (refusePrompt). Before it, the statuses stand as they are.
    let carriesPrompt = false;
    try {
      const m = /^\/a\/([^/]+)\/v1\/responses\/?$/.exec(new URL(req.url).pathname);
      if (!m) return httpError(404, "not_found", "Not found.");
      const id = m[1];
      const token = this.tokens.get(id);
      const given = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      // A 401 stays a 401 (it is what proves a token good or stale, and this request never reaches the service), even though
      // Codex re-sends the prompt seven times over one. Only a request we accept as this account's gets the other treatment.
      if (!token || !sameToken(given, token)) return httpError(401, "invalid_api_key", "That key isn't valid for Crosstalk's chat adapter.");
      if (req.method !== "POST") return httpError(405, "method_not_allowed", "Use POST.");
      carriesPrompt = true;
      const ep = this.app.providers.endpointOf("codex", id);
      if (ep?.protocol !== "chat") return refusePrompt("This AI service isn't set up for the chat adapter any more. Start the chat again, or check it in Settings → AI services.");
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return refusePrompt("The request wasn't valid JSON.");
      }
      try {
        // The account's own body fields (Venice's venice_parameters) ride along; the translation's own always win.
        const { chat, routes } = toChatRequest(body, ep.extra);
        // What the model can hold, and whether what Codex just handed over fits it. Codex attaches every tool the person's own Codex
        // and ChatGPT-app setup offers to each request (it can be hundreds of them, over 100,000 tokens), which no small local model can
        // read: translate.ts `fitToWindow` leaves out what it may and says what went, and a request that still doesn't fit is
        // refused here, in Crosstalk's own words, instead of travelling to the server to be refused in the model's.
        const model = str(chat.model);
        const sizes = this.sizesFor(ep, model);
        const fit = sizes ? fitToWindow(chat, sizes.window, sizes.compactAt) : null;
        // What this request cost, kept so Settings → AI services and the model picker can say it before the next chat starts
        // (cost.ts). The request as Codex sent it, measured here because here is the only place it is known.
        this.noteCost(ep.id, model, fit?.before ?? requestSize(chat), sizes?.window ?? null, fit);
        if (fit && sizes) {
          if (fit.dropped)
            log.info(`${ep.label}: left ${fit.dropped} of ${fit.before.toolCount} tools out (${fit.droppedGroups.join(", ")}: ${fit.droppedTokens} of ~${fit.before.total} tokens), fitted to ${fit.aim} of the ${sizes.window} ${model} holds`);
          if (fit.over) {
            log.warn(`${ep.label}: refused a request of ~${fit.size.total} tokens (${model} holds ${sizes.window})`);
            return refusePrompt(tooBigWords(model || ep.label, fit));
          }
        }
        return this.reply(ep, chat, routes);
      } catch (e) {
        if (e instanceof BadRequest) return refusePrompt(e.message, e.param);
        throw e;
      }
    } catch (e) {
      log.error("adapter request failed", e);
      // A bug of ours used to be an HTTP 500 here, which Codex answered by re-sending the identical request 57 times in 25
      // seconds (translate.ts NO_RETRY). A prompt is refused for good instead; a request without one keeps the status.
      return carriesPrompt ? refusePrompt("The chat adapter hit a problem. Try again.") : httpError(500, "server_error", "The chat adapter hit a problem. Try again.");
    }
  }

  /** Keeps what a request cost for this account and model (cost.ts), and tells the apps when the figure is new. */
  private noteCost(accountId: string, model: string, size: RequestSize, window: number | null, fit: Trimmed | null) {
    if (!model) return; // nothing to file it under
    try {
      if (noteToolCost(this.app.store, "codex", accountId, measure(model, size, window, fit))) this.app.providers.toolCostChanged("codex", accountId);
    } catch (e) {
      log.debug(`couldn't keep what the tools cost: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The reply to Codex: a Server-Sent Events stream that starts at once and carries whatever the upstream does. */
  private reply(ep: Endpoint, chat: Record<string, unknown>, routes: ToolRoutes): Response {
    const up = new AbortController();
    this.inflight.add(up);
    const encoder = new TextEncoder();
    const map = new StreamMapper(routes, str(chat.model), ep.label);
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (e: SseEvent) => {
          try {
            controller.enqueue(encoder.encode(frame(e)));
          } catch {
            /* Codex already left */
          }
        };
        void this.pump(ep, chat, map, up, send).finally(() => {
          // Belt and braces: no stream of ours ever just stops. Codex reads a stream that closes with no terminal event as a
          // broken one and POSTs the whole prompt again (seven times, measured), so if nothing above ended the response, it
          // ends here. The one silence that is right is Codex having hung up itself: there is nobody to tell.
          if (!map.ended && up.signal.reason !== CODEX_LEFT) for (const e of map.fail(NO_RETRY[0], `${ep.label}'s reply stopped before it finished. Try again.`)) send(e);
          this.inflight.delete(up);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
      // Codex hung up (it was stopped, or gave up waiting): the upstream stops too, so a local server isn't left working for nobody.
      cancel: () => up.abort(CODEX_LEFT),
    });
    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  }

  /**
   * The upstream call, with the adapter's own single try again. Codex would answer a problem like this by re-sending the whole
   * request (six copies of it for a 5xx, and the prompt here can be 666 KB), so a second attempt is made where the request is
   * already in hand, and the reply is then refused for good. Only for a server that can't be reached or that answered 5xx — a
   * refusal the service meant (any 4xx) and a stall are not things a second copy fixes — and only before any of the answer has
   * reached Codex, so nothing is ever said twice.
   */
  private async callUpstream(ep: Endpoint, chat: Record<string, unknown>, up: AbortController, arm: () => void, onConnect: () => void): Promise<Response> {
    const url = upstreamUrl(ep);
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify(chat),
      signal: up.signal,
    };
    for (let attempt = 0; ; attempt++) {
      arm();
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (attempt > 0 || up.signal.aborted) throw e;
        log.warn(`${ep.label}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}; trying once more from here, so Codex doesn't re-send the prompt`);
        await Bun.sleep(RETRY_MS);
        continue;
      }
      onConnect();
      if (res.status < 500 || attempt > 0 || up.signal.aborted) return res;
      await res.text().catch(() => {}); // the body of a try that is being thrown away
      log.warn(`${ep.label}: the server answered ${res.status}; trying once more from here, so Codex doesn't re-send the prompt`);
      await Bun.sleep(RETRY_MS);
    }
  }

  private async pump(ep: Endpoint, chat: Record<string, unknown>, map: StreamMapper, up: AbortController, send: (e: SseEvent) => void): Promise<void> {
    const model = str(chat.model);
    const fail = (f: Failure) => {
      for (const e of map.fail(f.code, scrub(f.message, ep.key))) send(e);
    };
    // Every failure below carries a code Codex takes as final (translate.ts NO_RETRY), because the alternative is the identical
    // request arriving again, prompt and tool catalogue and all. The one exception is a 429 (upstreamProblem), which keeps
    // `rate_limit_exceeded` so the hub can wait for the reset: a refused request isn't billed, so those re-sends cost nothing.
    const stop = (message: string): Failure => ({ code: NO_RETRY[0], message });
    let connected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => up.abort(STALLED), this.idleMs);
    };
    const keep = setInterval(() => send(map.progress()), this.keepAliveMs);
    try {
      send(map.created());
      const res = await this.callUpstream(ep, chat, up, arm, () => {
        connected = true;
      });
      arm();
      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        log.warn(`${ep.label}: the server answered ${res.status}`);
        return fail(upstreamProblem(res.status, raw, ep.label, model, res.headers, requestSize(chat)));
      }
      if (!res.body) throw new Error("empty answer");
      let sawDone = false;
      let events = 0;
      for await (const data of sseData(res.body, arm)) {
        events++;
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // a server's own comment or noise line
        }
        if (isObj(chunk)) for (const e of map.chunk(chunk)) send(e);
      }
      // A 200 with nothing in it that was an event: a server that ignored `stream: true` and answered in one piece, or
      // something in between answering for it. Saying it "dropped the connection" would send the person after a network
      // fault, and these are the two shapes that had Codex re-sending one identical request 92 times.
      if (!events && !sawDone) return fail(stop(`${ep.label} didn't answer as a stream, so Crosstalk couldn't read its reply. Check the address and the model in Settings → AI services.`));
      for (const e of map.end(sawDone)) send(e);
    } catch (e) {
      const why = up.signal.reason;
      if (why === STALLED) fail(stop(`${ep.label} stopped answering for ${waited(this.idleMs)}. Try again, or check that it's still running.`));
      else if (why === CODEX_LEFT) return; // Codex left: nobody to tell
      // The hub is restarting under a reply. Said rather than left as a stream that stops, which Codex re-sends the prompt over.
      else if (why === SHUTTING_DOWN) fail(stop(`Crosstalk restarted while ${ep.label} was answering, so this reply stopped part way. Try again.`));
      else if (e instanceof UpstreamError) fail(stop(`${ep.label} stopped with an error: ${e.message.replace(/[.!?\s]+$/, "")}. Try again.`));
      else if (connected) fail(stop(`${ep.label} dropped the connection before it finished. Try again.`));
      else fail(stop(`Couldn't reach ${ep.label} at ${new URL(ep.baseUrl).host}. Check that it's running and that the address in Settings → AI services is right.`));
      log.warn(`${ep.label}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
      clearInterval(keep);
    }
  }
}
