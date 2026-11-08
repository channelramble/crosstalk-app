// Stand-in model servers for the AI services tests (docs/SPEC-0.4.md, T5), each a Bun.serve on 127.0.0.1 port 0 that the
// test starts and stops itself: servers that have only some of the three API addresses (Responses, Messages, chat),
// a keyed one, and fakes of Ollama, LM Studio and llama.cpp that answer the way their real servers do. Every request
// they get is noted in `seen`, so a test can show what was (and wasn't) asked. None of them runs a model.
import type { Protocol } from "@crosstalk/shared";

export interface FakeOptions {
  /** The Bearer key every request needs; anything else is 401. */
  key?: string;
  /** With a key: an address that doesn't exist answers 404 even without it (the server looks at the address first). */
  routeFirst?: boolean;
  /** The POST addresses that exist (they turn `{}` down with 400); every other address is 404. All three by default. */
  routes?: Protocol[];
  chatPath?: string;
  /** Where the OpenAI-style model list is (/v1/models) and its entries. */
  listAt?: string;
  list?: Record<string, unknown>[];
  /** More GET answers, by path (a JSON body). */
  get?: Record<string, unknown>;
  /** A fixed status for a path, whatever the method (after the key check). */
  status?: Record<string, number>;
  /** A path that answers 307 to somewhere else. */
  redirect?: Record<string, string>;
  /** Wait this long before answering. */
  delayMs?: number;
}

export interface Fake {
  port: number;
  url: string;
  /** The model list's entries (change them to change what the server lists). */
  list: Record<string, unknown>[];
  seen: { method: string; path: string; auth: string | null; body: string }[];
  stop(): void;
}

export function fakeService(o: FakeOptions = {}): Fake {
  const seen: Fake["seen"] = [];
  const list = o.list ?? [{ id: "model-a", object: "model" }, { id: "model-b", object: "model" }];
  const listAt = o.listAt ?? "/v1/models";
  const routes = o.routes ?? ["responses", "messages", "chat"];
  const posts: Record<string, Protocol> = { "/v1/responses": "responses", "/v1/messages": "messages", [o.chatPath ?? "/v1/chat/completions"]: "chat" };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      seen.push({ method: req.method, path, auth, body: await req.text() });
      if (o.delayMs) await Bun.sleep(o.delayMs);
      if (o.redirect?.[path]) return new Response(null, { status: 307, headers: { location: o.redirect[path] } });
      const post = req.method === "POST";
      const exists = post ? routes.includes(posts[path]) : path === listAt || (o.get !== undefined && path in o.get);
      if (o.key && auth !== `Bearer ${o.key}` && (exists || !o.routeFirst)) return Response.json({ error: { message: "Invalid API key", code: 401 } }, { status: 401 });
      if (o.status?.[path]) return new Response("{}", { status: o.status[path] });
      if (post) return exists ? Response.json({ error: { message: "missing fields" } }, { status: 400 }) : new Response("no such address", { status: 404 });
      if (path === listAt) return Response.json({ object: "list", data: list });
      if (o.get && path in o.get) return Response.json(o.get[path]);
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port as number;
  return { port, url: `http://127.0.0.1:${port}`, list, seen, stop: () => void server.stop(true) };
}

export const fakeResponsesOnly = (o: FakeOptions = {}) => fakeService({ routes: ["responses"], ...o });
export const fakeMessagesOnly = (o: FakeOptions = {}) => fakeService({ routes: ["messages"], ...o });
export const fakeChatOnly = (o: FakeOptions = {}) => fakeService({ routes: ["chat"], ...o });

/** Ollama: its list says owned_by "library"; /api/ps has what's loaded with the context it was given, /api/tags the sizes. */
export const fakeOllama = (o: FakeOptions = {}) =>
  fakeService({
    routes: ["responses", "chat"],
    list: [{ id: "llama3.2:3b", owned_by: "library" }, { id: "qwen3:8b", owned_by: "library" }],
    get: {
      "/api/ps": { models: [{ name: "qwen3:8b", model: "qwen3:8b", size: 6_100_000_000, size_vram: 6_100_000_000, context_length: 4096 }] },
      "/api/tags": { models: [{ name: "llama3.2:3b", size: 2_019_393_189 }, { name: "qwen3:8b", size: 5_200_000_000 }] },
    },
    ...o,
  });

/** LM Studio: /api/v0/models says which are loaded, the context each has loaded and the most each can have. */
export const fakeLmStudio = (o: FakeOptions = {}) =>
  fakeService({
    list: [{ id: "qwen2.5-coder-7b", owned_by: "organization_owner" }, { id: "gemma-3-12b", owned_by: "organization_owner" }],
    get: {
      "/api/v0/models": {
        data: [
          { id: "qwen2.5-coder-7b", state: "loaded", max_context_length: 32768, loaded_context_length: 8192 },
          { id: "gemma-3-12b", state: "not-loaded", max_context_length: 131072 },
        ],
      },
    },
    ...o,
  });

/** llama.cpp: owned_by "llamacpp", the model's size in the list, and /props with the context a chat gets. */
export const fakeLlamaCpp = (o: FakeOptions = {}) =>
  fakeService({
    list: [{ id: "qwen3.8-27b", owned_by: "llamacpp", meta: { size: 16_000_000_000, n_ctx_train: 262144 } }],
    get: { "/props": { default_generation_settings: { n_ctx: 65536 }, total_slots: 1 } },
    ...o,
  });
