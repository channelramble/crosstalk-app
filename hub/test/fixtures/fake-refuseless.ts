// A stand-in Refuseless (api.refuseless.com) on a loopback port, for the Refuseless tests: its model list, its credit
// read and its three chat addresses, the way its docs give them (docs.refuseless.com and its OpenAPI file, read on
// 4 November 2026). No real Refuseless request was made to build it: every call there needs a paid account's key.
//
// What the real service does, and this copies:
// - Every call needs `Authorization: Bearer <key>`: 401 {error: {code: "invalid_key", message, type: "api_error"}}
//   without it ("Missing bearer API key.") or with a wrong one ("Invalid API key.").
// - GET /v1/models answers {object: "list", data: [{id, object: "model", created, owned_by: "refuseless", abliterated,
//   context_length}]}; GET /v1/credits {object: "credits", balance, reserved, available, key_limit, unit: "usd",
//   updated_at}.
// - /v1/chat/completions, /v1/responses and /v1/messages turn down a body without a model (400 bad_request): the three
//   free probes a check sends. A chat request streams Chat Completions events ending in data: [DONE]; a stream that runs
//   out of credit sends an {error: {code: "insufficient_credits"}} event, then [DONE].
// - 429 model_busy (retry-after: 15) and model_warming (retry-after: 30) when a model is busy or starting.
// - In front of it all, Cloudflare: `challenge` makes every answer its browser check (403, an HTML "Just a moment..."
//   page, `cf-mitigated: challenge`), as an unauthenticated request without a browser got on 4 November 2026.
//
// No model runs here and nothing leaves this machine.

import { type ScriptedReply, streamOf } from "./fake-nanogpt";

export interface RefuselessRow {
  id: string;
  abliterated: boolean;
  context?: number;
  /** The thinking levels it takes, and the one it uses unless asked. */
  efforts?: string[];
  effortDefault?: string;
}

/** A lineup in an order that isn't the hub's own, so its ordering shows: two stock models among the abliterated ones. */
export const REFUSELESS_ROWS: RefuselessRow[] = [
  { id: "glm-5.3-flash-abliterated", abliterated: true, context: 1_048_576 },
  { id: "minimax-m3.1-flash", abliterated: false, context: 1_048_576 },
  { id: "deepseek-v4.1-flash-abliterated", abliterated: true, context: 1_048_576, efforts: ["off", "low", "high", "max"], effortDefault: "high" },
  { id: "glm-5.3-abliterated", abliterated: true, context: 1_048_576 },
  { id: "deepseek-v4.1-flash-fast", abliterated: false, context: 1_048_576 },
];

export interface RefuselessReply extends ScriptedReply {
  /** The error's code, with `status`. */
  code?: string;
  /** A retry-after header, with `status`. */
  retryAfter?: string;
  /** After its text, the stream ends with this error event (credit that ran out mid-answer). */
  streamError?: { code: string; message: string };
  /** How long it thinks first: time for something written by the last tool call to take effect, if it would. */
  delayMs?: number;
}

export interface FakeRefuselessOptions {
  /** The one key it accepts. */
  key?: string;
  models?: RefuselessRow[];
  credits?: { balance: number; reserved?: number };
  /** Everything answers Cloudflare's browser check instead — or only these paths. */
  challenge?: boolean | string[];
  /** This path answers one of Cloudflare's other error pages (HTML, not the browser check), with this status. */
  htmlError?: { path: string; status: number };
  /** What each chat request answers, in order (a request past the last gets plain text "Done."). */
  replies?: RefuselessReply[];
}

const ERROR_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>api.refuseless.com | 522: Connection timed out</title></head><body><h1>Connection timed out</h1><p>Error code 522</p></body></html>`;

const CHALLENGE_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body><div class="main-content"><noscript>Enable JavaScript and cookies to continue</noscript></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;

const apiError = (status: number, code: string, message: string, headers: Record<string, string> = {}) => Response.json({ error: { code, message, type: "api_error" } }, { status, headers });

export function fakeRefuseless(o: FakeRefuselessOptions = {}) {
  const seen: { method: string; path: string; key: string | null; body: string }[] = [];
  const state = { challenge: (o.challenge ?? false) as boolean | string[], credits: o.credits ?? { balance: 42.5, reserved: 1.2 }, replies: [...(o.replies ?? [])], chats: [] as Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows = o.models ?? REFUSELESS_ROWS;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
      const body = await req.text();
      seen.push({ method: req.method, path, key, body });
      if (state.challenge === true || (Array.isArray(state.challenge) && state.challenge.includes(path)))
        return new Response(CHALLENGE_PAGE, { status: 403, headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" } });
      if (o.htmlError?.path === path) return new Response(ERROR_PAGE, { status: o.htmlError.status, headers: { "content-type": "text/html; charset=UTF-8" } });
      if (!key) return apiError(401, "invalid_key", "Missing bearer API key.");
      if (key !== o.key) return apiError(401, "invalid_key", "Invalid API key.");

      if (path === "/v1/models" && req.method === "GET") {
        return Response.json({ object: "list", data: rows.map((r) => ({ id: r.id, object: "model", created: 1_700_000_000, owned_by: "refuseless", abliterated: r.abliterated, ...(r.context ? { context_length: r.context } : {}), ...(r.efforts ? { reasoning_efforts: r.efforts, reasoning_default: r.effortDefault } : {}) })) });
      }
      if (path === "/v1/credits" && req.method === "GET") {
        const { balance, reserved = 0 } = state.credits;
        return Response.json({ object: "credits", balance, reserved, available: Number((balance - reserved).toFixed(6)), key_limit: null, unit: "usd", updated_at: 1_793_836_800 });
      }
      if (["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(path) && req.method === "POST") {
        const asked = (() => {
          try {
            return JSON.parse(body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
          } catch {
            return {};
          }
        })();
        if (path === "/v1/chat/completions" && Array.isArray(asked.messages) && asked.model) {
          state.chats.push(asked);
          const r = state.replies.shift() ?? { text: "Done." };
          if (r.delayMs) await Bun.sleep(r.delayMs);
          if (r.status) return apiError(r.status, r.code ?? "upstream_error", r.error ?? "failed", r.retryAfter ? { "retry-after": r.retryAfter } : {});
          if (r.streamError) {
            const chunk = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: asked.model, choices: [{ index: 0, delta: { content: r.text ?? "" }, finish_reason: null }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ error: r.streamError })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
          }
          return new Response(streamOf(r, state.chats.length), { headers: { "content-type": "text/event-stream" } });
        }
        // A body without a model is turned down before anything would run: no model is ever asked anything here.
        return apiError(400, "bad_request", "Missing model.");
      }
      return apiError(404, "not_found", "Not found.");
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { url, base: url, seen, state, stop: () => server.stop(true) };
}
