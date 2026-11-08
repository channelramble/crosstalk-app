// A stand-in Venice (venice.ai) on a loopback port, for the Venice tests: its own address shapes (/api/v1/models and
// /api/v1/chat/completions, /api/v1/responses as the beta address Venice does have, 404 for the Messages one it hasn't),
// its model list the way the real one answers (data[].model_spec.capabilities, checked against the public GET
// /api/v1/models on 29 October 2026, which needs no key and costs nothing), and a Chat Completions stream. No model runs
// here and nothing leaves this machine.
//
// Like the real one, the model list needs no key (swagger `security: [{}, BearerAuth]`; a GET with a wrong key answers
// 200 just the same), while every POST does. The request's `model` picks what a chat does: "ratelimited" answers 429 with
// the x-ratelimit-* headers Venice sends (docs.venice.ai/api-reference/rate-limiting: a unix time in milliseconds),
// anything else streams "Hello world". Every request is recorded in `seen`.

export interface VeniceModel {
  id: string;
  context: number;
  tools: boolean;
  name?: string;
}

export interface VeniceSeen {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** Three of the models Venice listed on 29 October 2026, with their own contexts: two that can run tools and one that can't. */
export const VENICE_MODELS: VeniceModel[] = [
  { id: "zai-org-glm-5", context: 198_000, tools: true, name: "GLM 5" },
  { id: "venice-uncensored-1-2", context: 128_000, tools: true, name: "Venice Uncensored 1.2" },
  { id: "hermes-3-llama-3.1-405b", context: 128_000, tools: false, name: "Hermes 3 405B" },
];

/** One row of Venice's /api/v1/models: context_length beside model_spec, which carries the context again and the capabilities. */
const row = (m: VeniceModel) => ({
  id: m.id,
  object: "model",
  type: "text",
  created: 1_791_849_600,
  owned_by: "venice.ai",
  context_length: m.context,
  model_spec: {
    name: m.name ?? m.id,
    availableContextTokens: m.context,
    maxCompletionTokens: 8192,
    capabilities: {
      optimizedForCode: m.tools,
      quantization: "fp8",
      supportsFunctionCalling: m.tools,
      supportsReasoning: true,
      supportsVision: false,
      supportsWebSearch: true,
      supportsLogProbs: false,
      supportsResponseSchema: m.tools,
    },
    pricing: { input: { usd: 0.5 }, output: { usd: 2 } },
    privacy: "private",
    offline: false,
    traits: m.tools ? ["default_code"] : ["most_uncensored"],
  },
});

const encoder = new TextEncoder();
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "chatcmpl-venice",
  object: "chat.completion.chunk",
  created: 1,
  model: "fake",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

export interface FakeVeniceOptions {
  /** The Bearer key every POST needs; anything else gets Venice's 401 (the model list is public, as the real one is). */
  key?: string;
  models?: VeniceModel[];
  /** Seconds from now that the 429's x-ratelimit-reset-requests names (Venice names a unix time). */
  resetInSecs?: number;
  /** How that reset is written: Venice's own milliseconds, or the seconds other services use. */
  resetUnit?: "ms" | "s";
}

export function fakeVenice(o: FakeVeniceOptions = {}) {
  const seen: VeniceSeen[] = [];
  const models = o.models ?? VENICE_MODELS;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      const text = await req.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* not JSON: the body stays empty */
      }
      seen.push({ method: req.method, path, auth, body });
      // The model list is a discovery address: no key, and a key that isn't one of Venice's makes no difference to it.
      if (path === "/api/v1/models" && req.method === "GET") return Response.json({ object: "list", type: "text", data: models.map(row) });
      // Venice's own refusal shape, and the message it gives for a key that isn't one of its own.
      if (o.key && auth !== `Bearer ${o.key}`) return Response.json({ error: "Authentication failed" }, { status: 401 });
      // Venice's Responses address (beta) exists, so the free probe's empty POST is turned down for its missing fields
      // rather than 404. Crosstalk pins Venice to the chat lane (web/src/presets.ts), so nothing else should arrive here:
      // a full request gets the stand-in's own refusal, which says so in the test's output.
      if (path === "/api/v1/responses" && req.method === "POST") {
        if (!body.model || !body.input) return Response.json({ error: "Validation failed", details: { model: ["Required"], input: ["Required"] } }, { status: 400 });
        return Response.json({ error: "the stand-in Venice doesn't run the Responses lane: Crosstalk should be using /api/v1/chat/completions" }, { status: 501 });
      }
      if (path !== "/api/v1/chat/completions" || req.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });
      // An empty body is what the free probe sends: turned down before anything would run, as the real one does.
      if (!body.model) return Response.json({ error: "Validation failed", details: { model: ["Required"] } }, { status: 400 });
      if (body.model === "ratelimited") {
        const secs = o.resetInSecs ?? 30;
        // Venice writes these as a unix time in milliseconds; "s" is the seconds other services write there.
        const at = (plus: number) => String(o.resetUnit === "s" ? Math.floor(Date.now() / 1000) + secs + plus : Date.now() + (secs + plus) * 1000);
        return Response.json({ error: "Rate limit exceeded" }, {
          status: 429,
          headers: {
            "x-ratelimit-limit-requests": "50",
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-reset-requests": at(0),
            "x-ratelimit-limit-tokens": "1000000",
            "x-ratelimit-remaining-tokens": "0",
            "x-ratelimit-reset-tokens": at(10),
          },
        });
      }
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
    /** As the hub reaches it: Venice's base address ends in /api, and each API path is added to that. */
    url: `http://127.0.0.1:${server.port}/api`,
    port: server.port as number,
    seen,
    /** The body of the last chat request it was sent. */
    lastChat: () => seen.filter((s) => s.path === "/api/v1/chat/completions" && s.method === "POST").at(-1)?.body,
    stop: () => void server.stop(true),
  };
}
