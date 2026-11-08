// A stand-in Featherless (featherless.ai) on a loopback port, for the Featherless tests: its model list the way the real
// one answers it, its address shapes, and its refusals. Checked against the real public GET
// https://api.featherless.ai/v1/models on 29 October 2026 (no key, nothing charged) and against its docs the same day.
//
// What the real service does, and this copies:
// - The list needs no key, and answers `{ data: [...] }`. Each row has id, is_gated, created, model_class, owned_by,
//   context_length, concurrency_cost, pricing and, on most rows, features and max_completion_tokens.
// - `q` searches the name or id. `status=active` leaves out models that aren't deployed (without it the service counts
//   53,203 models against 22,414). `training=abliterated` is the tag its own catalogue uses for uncensored models.
// - `page=1` is what bounds an answer: with it the service sends at most 100 rows and a `pagination.total_items` with
//   the real count. Without it, a filter's every match comes back (190 KB and up) and `per_page` is ignored either way.
// - A completion needs a key (401 without one), 403 means a gated model whose licence hasn't been agreed, and a request
//   that would take the plan over its concurrent units is refused with 429
//   (featherless.ai/docs/api-reference-error-codes, /docs/concurrency-limits).
// - GET /v1/plan answers which plan the key is on, with the key only: 401 without one, in the shape the real one sent a
//   keyless request on 1 November 2026 (`{ error: { message, type, param, code: "unauthorized" } }`), and with one the
//   docs' own example (featherless.ai/docs/api-reference-plan): `{ id, name, max_context_length, max_model_size,
//   concurrency }`. The Chat plan is `feather_pro_plus`, the Developer plan `feather_request_pricing`
//   (featherless.ai/docs/plans).
//
// No model runs here and nothing leaves this machine.

/** GET /v1/plan for a key on the $25 Chat plan: the docs' own example, under the name it had then. */
export const CHAT_PLAN = { id: "feather_pro_plus", name: "Feather Premium", max_context_length: 32_768, max_model_size: null, concurrency: 4 };
/**
 * The same for a key on the Developer plan (paid per token from credits; 100 concurrent units), as the plan list behind
 * Featherless's pricing page had it on 4 November 2026: named "Request Pricing", with no context cap or model size limit
 * of its own (each model's own context applies, 256K at most). No real Developer key's answer has been seen.
 */
export const DEVELOPER_PLAN = { id: "feather_request_pricing", name: "Request Pricing", max_context_length: null, max_model_size: null, concurrency: 100 };

/** A model name the stand-in answers 429 for, as the plan's concurrent units running out. */
export const BUSY_MODEL = "concurrency";
/** A model name something between the hub and the service answers 403 for: a proxy's own block page, in HTML, not the service's answer at all. */
export const BLOCKED_MODEL = "proxy-block";

export interface FeatherModel {
  id: string;
  /** How the service groups it: family and size ("qwen3.5-27b"). */
  modelClass: string;
  context: number;
  /** Concurrent units one request of it reserves (1 small, 2 larger, 4 very large). */
  units: number;
  gated?: boolean;
  /** The catalogue's own "abliterated" tag (training=abliterated). */
  abliterated?: boolean;
  /** The list's own features.tool_use, which is wider than the families the docs claim: kept so tests can show that. */
  toolUse?: boolean;
  /** Not deployed now: only a search with no status, or status=not_deployed, finds it. */
  inactive?: boolean;
  /** Listed, but not included in this plan: the service answers 403 for it (available_on_current_plan: false). */
  offPlan?: boolean;
  /** Dollars per million tokens in and out, as its row's `pricing` gives them (each model has its own; 0.30 and 2.40 unless said). */
  price?: [input: number, output: number];
}

/**
 * Rows as the real catalogue had them on 29 October 2026, including the one the tests pick
 * (huihui-ai/Huihui-Qwen3.5-27B-abliterated, class qwen3.5-27b, 32768 context, 2 units, not gated).
 *
 * The abliterated ones are in the order the real service answered them in, which is the order it sends (newest first) —
 * not an order that flatters Crosstalk's own ranking. On the day this was written,
 * `GET /v1/models?status=active&page=1&per_page=100&training=abliterated` (544 matches, 35 KB) began
 * OBLITERATUS/Qwen3.8-27B-OBLITERATED, OBLITERATUS/Ornith-1.5-9B-OBLITERATED, wangzhang/gemma-4-31B-it-abliterated,
 * huihui-ai/Huihui-Qwen3.5-27B-abliterated: the tests' pick was the service's fourth, and ranking it to the top of
 * a shortlist is not something a fixture should be able to arrange.
 */
export const FEATHER_MODELS: FeatherModel[] = [
  // Its own price, four times its family's usual one, as the real list had it on 1 November 2026.
  { id: "OBLITERATUS/Qwen3.8-27B-OBLITERATED", modelClass: "qwen3_5-27b", context: 32_768, units: 2, abliterated: true, toolUse: true, price: [1.6, 12] },
  // Abliterated, and a family Featherless's docs don't claim for tool calls: its own list still says tool_use.
  { id: "wangzhang/gemma-4-31B-it-abliterated", modelClass: "gemma4-31b", context: 32_768, units: 2, abliterated: true, toolUse: true },
  { id: "huihui-ai/Huihui-Qwen3.5-27B-abliterated", modelClass: "qwen3.5-27b", context: 32_768, units: 2, abliterated: true, toolUse: true },
  { id: "huihui-ai/Huihui-Qwen3-8B-abliterated-v2", modelClass: "qwen3-8b", context: 32_768, units: 1, abliterated: true, toolUse: true },
  { id: "mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated", modelClass: "llama31-8b", context: 32_768, units: 1, abliterated: true, toolUse: true },
  { id: "Qwen/Qwen3-235B-A22B", modelClass: "qwen3moe-235b", context: 262_144, units: 4, toolUse: true },
  { id: "moonshotai/Kimi-K2-Instruct", modelClass: "kimi-k2", context: 131_072, units: 4, toolUse: true, price: [0.6, 2.5] },
  // Gated on Hugging Face: every completion is a 403 until the licence is agreed on the service's own page.
  { id: "meta-llama/Llama-3.3-70B-Instruct", modelClass: "llama33-70b", context: 32_768, units: 4, gated: true, toolUse: true },
  // In the catalogue, but bigger than this plan includes: a completion gets a 403, whatever the key is.
  { id: "moonshotai/Kimi-K2.5-Instruct", modelClass: "kimi-k25", context: 131_072, units: 4, toolUse: true, offPlan: true },
  // Not a model that holds a conversation: the tool rule must never say yes to one of these.
  { id: "Qwen/Qwen3-Embedding-8B", modelClass: "qwen3-embedding-8b", context: 32_768, units: 1 },
  // Still being deployed: a search of active models leaves it out.
  { id: "huihui-ai/Huihui-Qwen3.5-99B-abliterated", modelClass: "qwen3.5-99b", context: 32_768, units: 4, abliterated: true, toolUse: true, inactive: true },
];

/** A price per million as the list also writes it, per token in a string ("0.0000003"). */
const perToken = (perMillion: number) => (perMillion / 1e6).toFixed(12).replace(/0+$/, "");

/** One row of /v1/models, in the real one's shape (prices as strings per token and numbers per million). */
const row = (m: FeatherModel, [input, output] = m.price ?? [0.3, 2.4]) => ({
  id: m.id,
  is_gated: !!m.gated,
  created: 1_778_789_435,
  model_class: m.modelClass,
  owned_by: "Feather",
  context_length: m.context,
  max_completion_tokens: Math.min(m.context, 32_768),
  concurrency_cost: m.units,
  pricing: { prompt: perToken(input), completion: perToken(output), image: "0", request: "0", input, output },
  ...(m.toolUse ? { features: { tool_use: true } } : {}),
});

const encoder = new TextEncoder();
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "chatcmpl-feather",
  object: "chat.completion.chunk",
  created: 1,
  model: "fake",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

export interface FeatherSeen {
  method: string;
  path: string;
  /** The query as it arrived, so a test can show what was asked for. */
  query: string;
  auth: string | null;
  body: Record<string, unknown>;
}

export interface FakeFeatherlessOptions {
  /** The Bearer key every POST needs; the model list is public, as the real one is. */
  key?: string;
  models?: FeatherModel[];
  /** Answers every match whatever `page` says, and pads each row, so a test can show the hub refuses an answer that big (the real catalogue is 7 MB). */
  flood?: boolean;
  /**
   * The same flood, sent as a stream with no content-length (what a chunked or compressed 7 MB answer looks like): the
   * size can only be found out by reading it, so the hub's per-chunk guard is what has to stop it, not the header.
   */
  floodStream?: boolean;
  /** How much padding a flooded row carries, for a test that needs an answer past a particular size. */
  fillerBytes?: number;
  /** The model list fails with this status instead of answering. */
  listStatus?: number;
  /**
   * What GET /v1/plan answers for the key: a plan (the Chat plan unless a test says otherwise), or a status to answer
   * with instead (404: a service without that address). It can be changed while the stand-in runs (`setPlan`).
   */
  plan?: Record<string, unknown> | number;
}

export function fakeFeatherless(o: FakeFeatherlessOptions = {}) {
  const seen: FeatherSeen[] = [];
  const models = o.models ?? FEATHER_MODELS;
  let plan: Record<string, unknown> | number = o.plan ?? CHAT_PLAN;
  const flooding = !!o.flood || !!o.floodStream;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const auth = req.headers.get("authorization");
      const text = await req.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* not JSON: the body stays empty */
      }
      seen.push({ method: req.method, path, query: url.search.replace(/^\?/, ""), auth, body });

      if (path === "/v1/models" && req.method === "GET") {
        if (o.listStatus) return Response.json({ error: "no" }, { status: o.listStatus });
        const p = url.searchParams;
        const q = (p.get("q") ?? "").toLowerCase();
        const active = (p.get("status") ?? "active").split(",").includes("active");
        let rows = models.filter((m) => (active ? !m.inactive : true));
        if (q) rows = rows.filter((m) => m.id.toLowerCase().includes(q));
        if (p.get("training") === "abliterated") rows = rows.filter((m) => m.abliterated);
        const total = rows.length;
        // `page` is what bounds the answer; `per_page` is ignored, as the real one ignores it.
        const paged = p.get("page") && !flooding;
        const data = (paged ? rows.slice(0, 100) : rows).map((m) => row(m));
        const padded = flooding ? data.map((d) => ({ ...d, filler: "x".repeat(o.fillerBytes ?? 300_000) })) : data;
        const body = paged ? { data: padded, pagination: { current_page: 1, per_page: 100, total_items: total, total_pages: Math.ceil(total / 100) }, total } : { data: padded };
        // No content-length: the answer arrives in pieces, exactly as a big compressed one does.
        if (o.floodStream) {
          const text = encoder.encode(JSON.stringify(body));
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                for (let at = 0; at < text.byteLength; at += 64_000) c.enqueue(text.slice(at, at + 64_000));
                c.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return Response.json(body);
      }
      // Which plan the key is on: only with the key, and nothing else in the answer.
      if (path === "/v1/plan" && req.method === "GET") {
        if (!auth || (o.key && auth !== `Bearer ${o.key}`)) return Response.json({ error: { message: "You must be signed in to access this resource", type: "invalid_request_error", param: null, code: "unauthorized" } }, { status: 401 });
        if (typeof plan === "number") return Response.json({ message: `Route GET:${path} not found`, error: "Not Found", statusCode: plan }, { status: plan });
        return Response.json(plan);
      }
      // The addresses Featherless hasn't got: its docs give only /v1/chat/completions and /v1/completions.
      if (path === "/v1/responses" || path === "/v1/messages") return Response.json({ message: `Route ${req.method}:${path} not found`, error: "Not Found", statusCode: 404 }, { status: 404 });
      if (path !== "/v1/chat/completions" || req.method !== "POST") return Response.json({ message: `Route ${req.method}:${path} not found`, error: "Not Found", statusCode: 404 }, { status: 404 });
      if (o.key && auth !== `Bearer ${o.key}`) return Response.json({ error: { message: "Unauthenticated", type: "invalid_request_error" } }, { status: 401 });
      // What the free probe sends: turned down for its missing fields before anything runs.
      if (!body.model) return Response.json({ error: { message: "model is required", type: "invalid_request_error" } }, { status: 400 });
      // The plan's concurrent units are full: the one model name that stands for that here.
      if (body.model === BUSY_MODEL) return Response.json({ error: { message: "Too many concurrent units reserved for your plan" } }, { status: 429 });
      // Not the service answering at all: a proxy, a firewall or a CDN in the way, with a page that happens to carry
      // words a model refusal would use ("not available", a link with "plan" in it).
      if (body.model === BLOCKED_MODEL) {
        return new Response("<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1><p>This content is not available on this network. See https://example.net/docs/plan</p></body></html>", { status: 403, headers: { "content-type": "text/html" } });
      }
      const asked = models.find((m) => m.id === body.model);
      if (!asked) return Response.json({ error: { message: `model ${String(body.model)} not found` } }, { status: 404 });
      if (asked.gated) return Response.json({ error: { message: "This model is gated. You need to agree to the model's license before using it." } }, { status: 403 });
      if (asked.offPlan) return Response.json({ error: { message: "This model is not available on your current plan" } }, { status: 403 });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const send = (v: unknown) => c.enqueue(encoder.encode(`data: ${typeof v === "string" ? v : JSON.stringify(v)}\n\n`));
          send(chunk({ role: "assistant", content: "Hello" }));
          send(chunk({ content: " world" }));
          send(chunk({}, "stop"));
          send("[DONE]");
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    /** As the hub reaches it (the real one is https://api.featherless.ai, with /v1 added to it). */
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    seen,
    lists: () => seen.filter((s) => s.path === "/v1/models"),
    /** Every plan read, with the key it carried. */
    planReads: () => seen.filter((s) => s.path === "/v1/plan"),
    /** Moves the key to another plan (or makes the address answer a status), as a switch on Featherless's billing page does. */
    setPlan: (next: Record<string, unknown> | number) => void (plan = next),
    lastChat: () => seen.filter((s) => s.path === "/v1/chat/completions" && s.method === "POST").at(-1)?.body,
    stop: () => void server.stop(true),
  };
}

