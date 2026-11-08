// Stand-in for a server that only speaks Chat Completions (Gemini's OpenAI-compatible endpoint, mlx-lm, vLLM, ...), for the chat
// adapter's tests. It listens on a loopback port and serves /v1/chat/completions and Gemini's /v1beta/openai/chat/completions. The
// request's `model` picks what it does (below); every request is recorded. Streams are Server-Sent Events like the real ones: chunks
// with deltas, tool-call arguments split across chunks, a last chunk with `usage` and no choices, then [DONE].
//
//   text        "Hello world", stop, usage          think       reasoning_content, then text, stop, usage
//   tools       reasoning, text, three tool calls (arguments in fragments, two interleaved), tool_calls, usage
//   length      text cut off by the token limit     filter      text stopped by the content filter
//   errorchunk  text, then an {error} chunk         cut         text, then the connection closes (no finish, no [DONE])
//   hung        one chunk, then silence until the client leaves         slow   the text script, 80 ms between chunks
//   unauthorized 401 (Gemini's array body)          echo        400 whose message repeats the Authorization header
//   ratelimit   429 busy    quota  429 out of quota    toolong  400 "maximum context length"    missing  404
//   overctx     400 the way llama.cpp refuses a prompt longer than the context: with n_prompt_tokens and n_ctx in the body
//   plain       200 text/plain "ok": a stand-in that ignores `stream: true` and answers in one piece
//   json        200 a whole (non-streaming) Chat Completions answer, same thing in JSON
//   fail500     500 every time        flaky  500 once, then the text script (the adapter's own single try again)
// `plain` and `json` are the two shapes that had Codex re-sending one identical 560 KB request 92 times in a turn.
// With `key`, any request without `Authorization: Bearer <key>` gets the 401.

export interface SeenRequest {
  path: string;
  auth: string | null;
    body: Record<string, any>;
}

type Chunk = Record<string, unknown>;
const encoder = new TextEncoder();
const chunk = (delta: Record<string, unknown>, finish: string | null = null): Chunk => ({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = (): Chunk => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 1,
  model: "fake",
  choices: [],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } },
});
const call = (index: number, fn: { name?: string; arguments?: string }, id?: string): Chunk => chunk({ tool_calls: [{ index, ...(id ? { id, type: "function" } : {}), function: fn }] });

const text = () => [chunk({ role: "assistant", content: "" }), chunk({ content: "Hello" }), chunk({ content: " world" }), chunk({}, "stop"), usage()];
const SCRIPTS: Record<string, () => Chunk[]> = {
  text,
  slow: text,
  think: () => [chunk({ role: "assistant", reasoning_content: "Let me " }), chunk({ reasoning_content: "think." }), chunk({ content: "Done." }), chunk({}, "stop"), usage()],
  tools: () => [
    chunk({ role: "assistant", reasoning_content: "Two things to do." }),
    chunk({ content: "Looking." }),
    call(0, { name: "shell", arguments: "" }, "call_a"),
    call(0, { arguments: '{"comm' }),
    call(1, { name: "mcp__docs__lookup", arguments: '{"q":' }, "call_b"),
    call(0, { arguments: 'and":["ls"]}' }),
    call(1, { arguments: '"typo"}' }),
    call(2, { name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' }, "call_c"),
    chunk({}, "tool_calls"),
    usage(),
  ],
  length: () => [chunk({ content: "Cut " }), chunk({ content: "off" }), chunk({}, "length"), usage()],
  filter: () => [chunk({ content: "I can't" }), chunk({}, "content_filter")],
  errorchunk: () => [chunk({ content: "Start" }), { error: { message: "The model is overloaded.", code: 503 } }],
};

export function fakeChatServer(opts: { key?: string } = {}) {
  const seen: SeenRequest[] = [];
  let aborted = 0;
  /** How many requests each model has had, for the ones whose answer changes between tries (flaky). */
  const calls: Record<string, number> = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/v1/chat/completions" && path !== "/v1beta/openai/chat/completions") return new Response("not found", { status: 404 });
      const auth = req.headers.get("authorization");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      seen.push({ path, auth, body });
      const refused = () => Response.json([{ error: { code: 401, message: "API key not valid. Please pass a valid API key.", status: "UNAUTHENTICATED" } }], { status: 401 });
      if (opts.key && auth !== `Bearer ${opts.key}`) return refused();
      const model = String(body.model);
      calls[model] = (calls[model] ?? 0) + 1;
      if (model === "unauthorized") return refused();
      // A server that ignores `stream: true`: a plain body, or a whole answer in one piece.
      if (model === "plain") return new Response("ok", { headers: { "content-type": "text/plain" } });
      if (model === "json") return Response.json({ id: "chatcmpl-fake", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 } });
      if (model === "fail500" || (model === "flaky" && calls[model] === 1)) return Response.json({ error: { message: "internal server error" } }, { status: 500 });
      if (model === "echo") return Response.json({ error: { message: `Bad request. The header was ${auth}.`, type: "invalid_request_error" } }, { status: 400 });
      if (model === "ratelimit") return Response.json({ error: { message: "Rate limit reached for requests", type: "rate_limit_error" } }, { status: 429 });
      if (model === "quota") return Response.json({ error: { message: "You exceeded your current quota, please check your plan and billing details." } }, { status: 429 });
      if (model === "toolong") return Response.json({ error: { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", code: "context_length_exceeded" } }, { status: 400 });
      // llama.cpp's own refusal, which counts the prompt for you (n_prompt_tokens) instead of leaving it to be guessed.
      if (model === "overctx") return Response.json({ error: { code: 400, message: "request (20024 tokens) exceeds the available context size (16384 tokens), try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 20024, n_ctx: 16384 } }, { status: 400 });
      if (model === "missing") return Response.json({ error: { message: "model not found" } }, { status: 404 });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const send = (v: unknown) => c.enqueue(encoder.encode(`data: ${typeof v === "string" ? v : JSON.stringify(v)}\n\n`));
          void (async () => {
            try {
              if (model === "hung") return send(chunk({ content: "Start" }));
              if (model === "cut") {
                send(chunk({ content: "Half" }));
                return c.close();
              }
              for (const part of (SCRIPTS[model] ?? SCRIPTS.text)()) {
                send(part);
                if (model === "slow") await Bun.sleep(80);
              }
              send("[DONE]");
              c.close();
            } catch {
              /* the client left */
            }
          })();
        },
        cancel() {
          aborted++;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, seen, aborted: () => aborted, calls: (model: string) => calls[model] ?? 0, stop: () => server.stop(true) };
}
