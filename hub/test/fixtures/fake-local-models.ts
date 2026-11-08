// Stand-in model servers that keep state, for the Local models tests (docs/SPEC-0.5.md, T10): an Ollama whose /api/ps follows
// what /api/generate loads and frees (and whose /api/pull "downloads" a model in steps, picking up where a stopped pull
// was), and a llama.cpp in router mode. Each is a Bun.serve on 127.0.0.1 port 0 that the test starts
// and stops itself, and every request it gets is noted in `seen`. Neither runs a model: a load or a free only changes a list.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fake } from "./fake-services";

const PROBES = ["/v1/responses", "/v1/chat/completions", "/v1/messages"];

export interface FakeOllamaModel {
  name: string;
  size: number;
  /** The part of it in graphics memory (all of it by default). */
  vram?: number;
  loaded?: boolean;
  /** Loaded, to be freed this many ms from now (4 minutes by default). */
  expiresInMs?: number;
}

export interface FakeOllamaOptions {
  models?: FakeOllamaModel[];
  /** What POST /api/generate does: "ok"; "error" (500, Ollama's own words for too little memory); "drop" (the server goes away without answering); "hang" (never answers); "ignore" (says ok, changes nothing). */
  generate?: "ok" | "error" | "drop" | "hang" | "ignore";
  /** A freed model leaves /api/ps this many ms after the answer (as Ollama's does). */
  unloadMs?: number;
  /** A load answers this many ms late (the model is in memory when it does). */
  loadMs?: number;
  /** A load is dropped when the client's connection closes before the model is in memory, as Ollama drops it ("client connection closed before server finished loading, aborting load"), not finished on its own. */
  cancelOnClose?: boolean;
  /** What /api/ps says about when a model loaded here is freed. */
  expiresAt?: string;
  /**
   * What POST /api/pull does: the layers it "downloads" (each a digest and a size), `chunk` bytes a step, `stepMs` apart,
   * as Ollama's progress lines; a pull that's stopped keeps what it had, and the next pull of the model goes on from there.
   * `fail`: "missing" (the library has no such model), "cut" (the answer ends half way, without success), "error" (a 500).
   * `dir`: the models folder it writes in as Ollama does, <dir>/blobs/sha256-<hex>-partial while a layer comes, then
   * sha256-<hex> (empty files: only their names are looked at).
   */
  pull?: { layers?: { digest: string; size: number }[]; chunk?: number; stepMs?: number; fail?: "missing" | "cut" | "error"; dir?: string };
}

export interface FakeOllama extends Fake {
  /** The models in memory now. */
  loaded(): string[];
  /** The loads dropped because the client's connection closed before they had finished (`cancelOnClose`). */
  cancelled(): string[];
  /** Each pull asked for (the model's name), and how far each layer of a model got (by digest). */
  pulls(): string[];
  pulled(model: string): Record<string, number>;
}

export function fakeOllamaLive(o: FakeOllamaOptions = {}): FakeOllama {
  const models = o.models ?? [{ name: "qwen3:8b", size: 6_100_000_000, loaded: true }, { name: "llama3.2:3b", size: 2_019_393_189 }];
  /** When each loaded model is freed (ms since 1970); absent: not loaded. */
  const until = new Map(models.filter((m) => m.loaded).map((m) => [m.name, Date.now() + (m.expiresInMs ?? 4 * 60_000)]));
  const seen: Fake["seen"] = [];
  const dropped: string[] = [];
  const pullsAsked: string[] = [];
  /** How far each pulled model's layers got, by digest (kept across pulls, as Ollama keeps partial downloads). */
  const progress = new Map<string, Map<string, number>>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.text();
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body });
      if (req.method === "POST" && path === "/api/pull") return pull(req, JSON.parse(body) as { model: string });
      if (req.method === "POST") {
        if (path !== "/api/generate") return PROBES.includes(path) ? Response.json({ error: { message: "missing fields" } }, { status: 400 }) : new Response("no such address", { status: 404 });
        const { model, keep_alive } = JSON.parse(body) as { model: string; keep_alive: number | string };
        if (!models.some((m) => m.name === model)) return Response.json({ error: `model '${model}' not found` }, { status: 404 });
        if (o.generate === "drop") {
          setTimeout(() => void server.stop(true), 10);
          await new Promise(() => {});
        }
        if (o.generate === "hang") await new Promise(() => {});
        if (o.generate === "error") return Response.json({ error: "model requires more system memory (28.4 GiB) than is available (9.1 GiB)" }, { status: 500 });
        if (o.generate !== "ignore") {
          if (keep_alive === 0) {
            if (o.unloadMs) setTimeout(() => until.delete(model), o.unloadMs);
            else until.delete(model);
          } else {
            if (o.loadMs && !o.cancelOnClose) await Bun.sleep(o.loadMs);
            else if (o.loadMs) {
              const stayed = await Promise.race([Bun.sleep(o.loadMs).then(() => true), new Promise<boolean>((resolve) => (req.signal.aborted ? resolve(false) : req.signal.addEventListener("abort", () => resolve(false), { once: true })))]);
              if (!stayed) {
                dropped.push(model);
                return new Response(null, { status: 499 });
              }
            }
            until.set(model, Date.now() + 30 * 60_000);
          }
        }
        return Response.json({ model, response: "", done: true, done_reason: keep_alive === 0 ? "unload" : "load" });
      }
      if (path === "/v1/models") return Response.json({ object: "list", data: models.map((m) => ({ id: m.name, owned_by: "library" })) });
      if (path === "/api/tags") return Response.json({ models: models.map((m) => ({ name: m.name, size: m.size })) });
      if (path === "/api/ps") {
        const running = models.filter((m) => until.has(m.name));
        return Response.json({ models: running.map((m) => ({ name: m.name, model: m.name, size: m.size, size_vram: m.vram ?? m.size, context_length: 4096, expires_at: o.expiresAt ?? new Date(until.get(m.name)!).toISOString() })) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port as number;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    list: [],
    seen,
    stop: () => void server.stop(true),
    loaded: () => models.filter((m) => until.has(m.name)).map((m) => m.name),
    cancelled: () => [...dropped],
    pulls: () => [...pullsAsked],
    pulled: (model) => Object.fromEntries(progress.get(model) ?? []),
  };

  function pull(req: Request, { model }: { model: string }): Response {
    pullsAsked.push(model);
    const p = o.pull ?? {};
    if (p.fail === "error") return Response.json({ error: "something broke" }, { status: 500 });
    const layers = p.layers ?? [{ digest: "sha256:" + "a".repeat(64), size: 400_000 }, { digest: "sha256:" + "b".repeat(64), size: 1_000 }];
    const chunk = p.chunk ?? 100_000;
    const had = progress.get(model) ?? new Map<string, number>();
    progress.set(model, had);
    const line = (x: unknown) => new TextEncoder().encode(JSON.stringify(x) + "\n");
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (req.signal.aborted) return c.close();
        if (step++ === 0) return c.enqueue(line(p.fail === "missing" ? { error: "pull model manifest: file does not exist" } : { status: "pulling manifest" }));
        if (p.fail === "missing") return c.close();
        if (p.stepMs) await Bun.sleep(p.stepMs);
        if (req.signal.aborted) return c.close();
        const layer = layers.find((l) => (had.get(l.digest) ?? 0) < l.size);
        if (layer) {
          const done = Math.min(layer.size, (had.get(layer.digest) ?? 0) + chunk);
          if (p.fail === "cut" && done >= layer.size / 2) return c.close();
          had.set(layer.digest, done);
          if (p.dir) {
            const blob = join(p.dir, "blobs", layer.digest.replace(":", "-"));
            mkdirSync(join(p.dir, "blobs"), { recursive: true });
            if (done < layer.size) writeFileSync(`${blob}-partial`, "");
            else if (existsSync(`${blob}-partial`)) renameSync(`${blob}-partial`, blob);
          }
          return c.enqueue(line({ status: `pulling ${layer.digest.slice(7, 19)}`, digest: layer.digest, total: layer.size, completed: done }));
        }
        if (step > 10_000) return c.close();
        c.enqueue(line({ status: "verifying sha256 digest" }));
        c.enqueue(line({ status: "writing manifest" }));
        c.enqueue(line({ status: "success" }));
        if (!models.some((m) => m.name === model)) models.push({ name: model, size: layers.reduce((n, l) => n + l.size, 0) });
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  }
}

export interface FakeRouterOptions {
  models?: { id: string; loaded?: boolean }[];
  /** A load takes this many ms (the model reads "loading" meanwhile). */
  loadMs?: number;
  /** A load ends with the model stopped (the router says it failed). */
  failLoad?: boolean;
  /** Every load and unload is turned down with this message (a 400, as the router does). */
  refuse?: string;
  /** A single-model llama-server: answers /models with the same list as /v1/models, no status, and has no load or unload. */
  single?: boolean;
  /** Models that /models lists but /v1/models leaves out (so the hub's scan doesn't know them). */
  hidden?: string[];
}

export interface FakeRouter extends Fake {
  /** Each model's status now ("loaded", "loading", "unloaded"). */
  status(): Record<string, string>;
}

export function fakeLlamaRouter(o: FakeRouterOptions = {}): FakeRouter {
  const models = o.models ?? [{ id: "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M", loaded: true }, { id: "unsloth/Qwen3-8B-GGUF:Q4_K_M" }];
  const status = new Map(models.map((m) => [m.id, m.loaded ? "loaded" : "unloaded"]));
  const failed = new Set<string>();
  const seen: Fake["seen"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.text();
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body });
      const refuse = (message: string) => Response.json({ error: { code: 400, message, type: "invalid_request_error" } }, { status: 400 });
      if (req.method === "POST") {
        if (PROBES.includes(path)) return Response.json({ error: { message: "missing fields" } }, { status: 400 });
        const { model } = (body ? JSON.parse(body) : {}) as { model?: string };
        if (o.single || (path !== "/models/load" && path !== "/models/unload")) return new Response("no such address", { status: 404 });
        if (!model || !status.has(model)) return Response.json({ error: { code: 404, message: "model is not found", type: "not_found_error" } }, { status: 404 });
        if (o.refuse) return refuse(o.refuse);
        if (path === "/models/unload") {
          if (status.get(model) !== "loaded") return refuse("model is not loaded");
          status.set(model, "unloaded");
        } else {
          if (status.get(model) === "loaded") return refuse("model is already loaded");
          failed.delete(model);
          status.set(model, "loading");
          setTimeout(() => {
            if (o.failLoad) failed.add(model);
            status.set(model, o.failLoad ? "unloaded" : "loaded");
          }, o.loadMs ?? 0);
        }
        return Response.json({ success: true });
      }
      if (path === "/v1/models") return Response.json({ object: "list", data: models.filter((m) => !o.hidden?.includes(m.id)).map((m) => ({ id: m.id, object: "model", owned_by: "llamacpp" })) });
      if (path === "/props") return Response.json(o.single ? { default_generation_settings: { n_ctx: 8192 }, total_slots: 1 } : { role: "router", max_instances: 4, models_autoload: true });
      if (path === "/models") {
        if (o.single) return Response.json({ object: "list", data: models.map((m) => ({ id: m.id, object: "model" })) });
        const rows = models.map((m) => ({ id: m.id, in_cache: true, path: `/models/${m.id.split("/").pop()}.gguf`, status: { value: status.get(m.id), args: ["llama-server", "-ctx", "4096"], ...(failed.has(m.id) ? { failed: true, exit_code: 1 } : {}) } }));
        return Response.json({ data: rows });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port as number;
  return { port, url: `http://127.0.0.1:${port}`, list: [], seen, stop: () => void server.stop(true), status: () => Object.fromEntries(status) };
}
