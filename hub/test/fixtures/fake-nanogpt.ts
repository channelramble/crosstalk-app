// A stand-in NanoGPT (nano-gpt.com) on a loopback port, for the NanoGPT tests: its detailed model list the way the real
// one answers it, its balance and subscription reads, and its address shapes. Checked against the real public GET
// https://nano-gpt.com/api/v1/models?detailed=true on 1 November 2026 (no key, nothing charged) and its docs the same day
// (docs.nano-gpt.com: check-balance, subscription-usage, the Messages and Responses endpoints).
//
// What the real service does, and this copies:
// - The model list needs no key and answers `{ object: "list", data: [...] }`. With `detailed=true` each row has name,
//   context_length, capabilities (tool_calling, reasoning…), pricing (prompt and completion in USD per million tokens,
//   cacheReadInputPer1kTokens per thousand), subscription.included and a category ("Uncensored", "Decisions"…); without
//   it, ids only.
// - POST /api/check-balance takes the key as `x-api-key` and answers `usd_balance` (and nano_balance, a deposit address).
// - GET /api/subscription/v1/usage takes it as a Bearer token and answers `active`, `limits`, `weeklyInputTokens` and
//   `dailyInputTokens` (`used`, `remaining`, `percentUsed`, `resetAt` in ms), `period.currentPeriodEnd` and
//   `routing.recommendedMode`.
// - /api/v1/messages, /api/v1/responses and /api/v1/chat/completions want the key (401 without it) and turn down an empty
//   body (400) with it: the three free probes a check sends.
//
// No model runs here and nothing leaves this machine.

export interface NanoRow {
  id: string;
  name: string;
  context: number;
  tools: boolean;
  /** USD per million tokens, input and output; the cache read per million (sent per thousand, as the real one does). */
  price: [input: number, output: number, cached?: number];
  inPlan?: boolean;
  category?: string;
  reasoning?: boolean;
  /** When NanoGPT added it (seconds). */
  created: number;
  /** What it writes: an image model writes no text. */
  output?: string[];
}

/**
 * Rows as the real list had them on 1 November 2026, in the order it sent them (not an order that flatters Crosstalk's
 * own ranking): a DeepSeek model among them, a subscription model, a decision model an agent can't use, and an
 * uncensored build NanoGPT files under roleplay rather than "Uncensored".
 */
export const NANO_MODELS: NanoRow[] = [
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", context: 1_048_576, tools: true, price: [0.1, 0.3, 0.025], inPlan: true, category: "More", reasoning: true, created: 1_787_702_400 },
  { id: "deepseek/deepseek-v4.1-flash-uncensored", name: "DeepSeek V4.1 Flash Uncensored", context: 1_048_576, tools: true, price: [0.33, 1.32, 0.00825], category: "Uncensored", reasoning: true, created: 1_790_812_800 },
  { id: "z-ai/glm-5.3-flash-uncensored", name: "GLM 5.3 Flash Uncensored", context: 1_048_576, tools: true, price: [0.2, 0.8, 0.07], inPlan: true, category: "Uncensored", reasoning: true, created: 1_788_048_000 },
  // Filed as roleplay, uncensored by its name: the hub must still count it as uncensored.
  { id: "gemma-4-26b-a4b-it-chimeraxheretic", name: "Gemma 4 26B A4B Chimera X Heretic", context: 262_144, tools: true, price: [0.12, 0.38, 0.06], inPlan: true, category: "Roleplay/storytelling models", created: 1_789_000_000 },
  // Uncensored, but its list says it can't call tools: an agent can't work with it.
  { id: "venice-uncensored", name: "Venice Uncensored 1.2", context: 131_072, tools: false, price: [0.2, 0.9], inPlan: true, category: "Uncensored", created: 1_780_000_000 },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", context: 1_000_000, tools: true, price: [4, 20, 0.4], category: "More", reasoning: true, created: 1_790_035_200 },
  // A decision model: non-streaming JSON questions only, so never offered to an agent.
  { id: "typesafe/jev-1.14", name: "Jev 1.14", context: 32_768, tools: false, price: [0.1, 0], category: "Decisions", created: 1_790_900_000 },
  // An image model: it writes no text at all.
  { id: "image/flux-3", name: "Flux 3", context: 4096, tools: false, price: [0, 0], category: "More", created: 1_790_000_100, output: ["image"] },
];

/** One row of the detailed list, in the real one's shape. */
function detailed(m: NanoRow) {
  return {
    id: m.id,
    object: "model",
    created: m.created,
    owned_by: m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "nanogpt",
    name: m.name,
    description: `${m.name}, as NanoGPT describes it.`,
    context_length: m.context,
    max_output_tokens: 32_768,
    architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: m.output ?? ["text"] },
    capabilities: { vision: false, reasoning: !!m.reasoning, tool_calling: m.tools, parallel_tool_calls: false, structured_output: false },
    pricing: { prompt: m.price[0], completion: m.price[1], ...(m.price[2] !== undefined ? { cacheReadInputPer1kTokens: m.price[2] / 1000 } : {}), currency: "USD", unit: "per_million_tokens" },
    category: m.category ?? "More",
    subscription: { included: !!m.inPlan, inputTokenMultiplier: 1, note: m.inPlan ? "Included in subscription" : "Not included in subscription" },
  };
}

export interface NanoSeen {
  method: string;
  path: string;
  query: string;
  /** The key as it arrived, from whichever header carried it. */
  key: string | null;
  body: string;
}

/**
 * One scripted model answer for Crosstalk's own agent (agents/builtin.ts): text, thinking and tool calls, streamed the way
 * Chat Completions streams them (a call's arguments arrive in two pieces), then a usage chunk. `status` fails the request.
 */
export interface ScriptedReply {
  text?: string;
  reasoning?: string;
  /** `id` stands in for the one the stream would make up: some services use the same ones again. */
  calls?: { name: string; args: Record<string, unknown> | string; id?: string }[];
  usage?: { prompt: number; completion: number; cached?: number };
  status?: number;
  error?: string;
  /** Ends without its finish (a stream cut short by the output limit). */
  finish?: "stop" | "tool_calls" | "length";
}

export interface FakeNanoGptOptions {
  /** The one key it accepts. */
  key?: string;
  models?: NanoRow[];
  /** What check-balance answers (USD). */
  balance?: number;
  /** The subscription: absent = never had one. */
  plan?: { active: boolean; weeklyUsed: number; weeklyLimit: number; mode?: "subscription" | "paygo" | "unavailable" };
  /** The model list fails with this status instead of answering. */
  listStatus?: number;
  /** check-balance fails with this status (the subscription read still answers). */
  balanceStatus?: number;
  /** What each chat request answers, in order (a request past the last gets plain text "Done."). */
  replies?: ScriptedReply[];
}

/** A scripted answer as the event stream Chat Completions sends. */
export function streamOf(r: ScriptedReply, n: number): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] });
  const out: unknown[] = [];
  if (r.reasoning) out.push(chunk({ role: "assistant", reasoning_content: r.reasoning }));
  if (r.text) {
    const half = Math.ceil(r.text.length / 2);
    out.push(chunk({ content: r.text.slice(0, half) }), chunk({ content: r.text.slice(half) }));
  }
  (r.calls ?? []).forEach((c, i) => {
    const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
    const half = Math.ceil(args.length / 2);
    out.push(chunk({ tool_calls: [{ index: i, id: c.id ?? `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: args.slice(0, half) } }] }));
    out.push(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] }));
  });
  out.push(chunk({}, r.finish ?? (r.calls?.length ? "tool_calls" : "stop")));
  const u = r.usage ?? { prompt: 1000, completion: 50 };
  out.push({ id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: "fake", choices: [], usage: { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.prompt + u.completion, prompt_tokens_details: { cached_tokens: u.cached ?? 0 } } });
  return `${out.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("")}data: [DONE]\n\n`;
}

export function fakeNanoGpt(o: FakeNanoGptOptions = {}) {
  const seen: NanoSeen[] = [];
  const state = { listStatus: o.listStatus ?? 0, balance: o.balance ?? 5, plan: o.plan ?? null, replies: [...(o.replies ?? [])], chats: [] as Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const models = o.models ?? NANO_MODELS;
  const keyOf = (req: Request) => req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const key = keyOf(req);
      const body = await req.text();
      seen.push({ method: req.method, path, query: url.search.replace(/^\?/, ""), key, body });
      const ok = !!o.key && key === o.key;

      if (path === "/api/v1/models" && req.method === "GET") {
        if (state.listStatus) return Response.json({ error: "no" }, { status: state.listStatus });
        const rows = url.searchParams.get("detailed") === "true" ? models.map(detailed) : models.map((m) => ({ id: m.id, object: "model", created: m.created, owned_by: "nanogpt" }));
        return Response.json({ object: "list", data: rows });
      }
      if (path === "/api/check-balance" && req.method === "POST") {
        if (!ok) return Response.json({ error: "Invalid API key" }, { status: 401 });
        if (o.balanceStatus) return Response.json({ error: "no" }, { status: o.balanceStatus });
        return Response.json({ usd_balance: String(state.balance), nano_balance: "0", nanoDepositAddress: "nano_1stand1n" });
      }
      if ((path === "/api/subscription/v1/usage" || path === "/api/v1/subscription/usage") && req.method === "GET") {
        if (!ok) return Response.json({ error: "Invalid API key" }, { status: 401 });
        const p = state.plan;
        if (!p) return Response.json({ active: false, state: "none", limits: { weeklyInputTokens: null, dailyInputTokens: null }, weeklyInputTokens: null, dailyInputTokens: null, period: { currentPeriodEnd: null }, routing: { recommendedMode: "paygo", subscriptionQuotaAvailable: null } });
        const left = Math.max(p.weeklyLimit - p.weeklyUsed, 0);
        return Response.json({
          active: p.active,
          state: p.active ? "active" : "canceled",
          limits: { weeklyInputTokens: p.weeklyLimit, dailyInputTokens: null, dailyImages: 100 },
          weeklyInputTokens: { used: p.weeklyUsed, remaining: left, percentUsed: p.weeklyUsed / p.weeklyLimit, resetAt: 1_793_664_000_000 },
          dailyInputTokens: null,
          dailyImages: { used: 0, remaining: 100, percentUsed: 0, resetAt: 1_793_577_600_000 },
          period: { currentPeriodEnd: "2026-11-30T00:00:00.000Z" },
          routing: { recommendedMode: p.mode ?? (p.active && left > 0 ? "subscription" : "paygo"), subscriptionQuotaAvailable: left > 0 },
        });
      }
      if (["/api/v1/messages", "/api/v1/responses", "/api/v1/chat/completions"].includes(path) && req.method === "POST") {
        if (!ok) return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
        // A real chat request (Crosstalk's own agent): the next scripted answer, streamed, or as one JSON body when the
        // request didn't ask for a stream (a summary).
        const asked = (() => {
          try {
            return JSON.parse(body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
          } catch {
            return {};
          }
        })();
        if (path === "/api/v1/chat/completions" && Array.isArray(asked.messages)) {
          state.chats.push(asked);
          const r = state.replies.shift() ?? { text: "Done." };
          if (r.status) return Response.json({ error: { message: r.error ?? "failed" } }, { status: r.status });
          if (asked.stream === false) {
            const u = r.usage ?? { prompt: 1000, completion: 50 };
            return Response.json({ id: "chatcmpl-summary", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: r.text ?? "" }, finish_reason: "stop" }], usage: { prompt_tokens: u.prompt, completion_tokens: u.completion } });
          }
          return new Response(streamOf(r, state.chats.length), { headers: { "content-type": "text/event-stream" } });
        }
        // An empty body turns into a 400 before anything would run: no model is ever asked anything here.
        return Response.json({ error: { message: "model is required" } }, { status: 400 });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    /** The address an account is saved with (NanoGPT's own is https://nano-gpt.com/api). */
    base: `${url}/api`,
    seen,
    state,
    lists: () => seen.filter((s) => s.path === "/api/v1/models"),
    stop: () => server.stop(true),
  };
}
