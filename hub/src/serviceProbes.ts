// Free probes of a model server (docs/SPEC-0.4.md, track T5): what it lists, what kind it is and which API addresses it
// has, without ever sending a model request: a GET for its model list, and POSTs of `{}`, which a server turns down
// (400, 422) before it would run anything. Used by services.ts and by the endpoint model lists in providers/index.ts.

import { PROVIDER_INFO, isServiceOnlyAgent, serviceWorks, type LocalServer, type ModelOption, type Protocol, type Provider, type ServiceTestResult, type Support } from "@crosstalk/shared";
import { ADAPTER_FIELDS } from "./adapter/translate";
import { HttpError } from "./engine/engine";

export type ServerKind = LocalServer["kind"];
export type ListedModel = LocalServer["models"][number];

export const CHAT_PATH = "/v1/chat/completions";
export const SERVER_NAMES: Record<ServerKind, string> = { ollama: "Ollama", lmstudio: "LM Studio", llamacpp: "llama.cpp", vllm: "vLLM", mlx: "mlx-lm", other: "Model server" };
/** Models listed per server (OpenRouter has about 500), and the most a model picker is given. */
const MAX_LISTED = 500;
const MAX_PICKER = 100;
/** The context sizes a chat can be given (the same limits as an account's own context field). */
const MIN_CONTEXT = 2048;
const MAX_CONTEXT = 10_000_000;

export interface Answer {
  /** 0: nothing answered (see `failed`). */
  status: number;
  /** The body when it was JSON (GETs only). */
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  failed: "timeout" | "network" | null;
}

/**
 * Whether a redirect may be followed with the key: to the same host and port (or, from an http address, to the same
 * host over https, where the key travels encrypted), never to another port or host, and never from https down to http
 * (the key would travel in the clear). A different port is another server, as it is to a browser.
 */
export function mayFollow(from: URL, to: URL): boolean {
  if (to.hostname !== from.hostname) return false;
  if (from.protocol === "http:" && to.protocol === "https:") return true;
  return to.protocol === from.protocol && to.port === from.port;
}

/**
 * A key pasted into a form, trimmed ("" when there is none). Only visible ASCII can travel in a header: a space or line
 * break inside means more than the key was pasted, and a character like "…" or "—" (smart punctuation, a cut-off copy)
 * makes the request itself fail, which would be reported as a server that doesn't answer.
 */
export function cleanKey(v: unknown): string {
  const key = String(v ?? "").trim();
  if (/[^\x21-\x7e]/.test(key)) throw new HttpError(400, "That key has a space, a line break or another character a key can't have (like … or —) inside it. Paste just the key.");
  return key;
}

/**
 * One free request. A redirect is followed only where mayFollow says so; anything else comes back as its 3xx status.
 */
export async function ask(url: string, opts: { key?: string; post?: boolean; signal: AbortSignal }): Promise<Answer> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.post) headers["content-type"] = "application/json";
  try {
    let target = new URL(url);
    for (let hops = 0; ; hops++) {
      const res = await fetch(target, { method: opts.post ? "POST" : "GET", headers, body: opts.post ? "{}" : undefined, redirect: "manual", signal: opts.signal });
      const where = res.status >= 300 && res.status < 400 && hops < 3 ? res.headers.get("location") : null;
      const next = where ? new URL(where, target) : null;
      if (next && mayFollow(target, next)) {
        void res.body?.cancel().catch(() => {});
        target = next;
        continue;
      }
      if (opts.post) {
        void res.body?.cancel().catch(() => {});
        return { status: res.status, json: null, failed: null };
      }
      return { status: res.status, json: await readJson(res), failed: null };
    }
  } catch {
    return { status: 0, json: null, failed: opts.signal.aborted ? "timeout" : "network" };
  }
}

/**
 * How big an answer here may be. A model list is kilobytes, or a few hundred of them (OpenRouter's 500 models are 768
 * KB). Past this it is dropped instead of held in the hub: Featherless's whole catalogue is 7 MB, and nothing here is
 * ever meant to read it (featherless.ts searches it one bounded page at a time).
 */
const MAX_BODY_BYTES = 4_000_000;

/** The answer's JSON, read in pieces and given up on (null, as an unreadable body already is) once it grows past MAX_BODY_BYTES. */
async function readJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return res.json().catch(() => null);
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return null;
  }
}

const count = (n: unknown): number | null => (typeof n === "number" && Number.isInteger(n) && n >= MIN_CONTEXT && n <= MAX_CONTEXT ? n : null);
const bytes = (n: unknown): number | null => (typeof n === "number" && n > 0 ? n : null);
/** A yes/no a list carries; null when it says nothing, which is never read as a no. */
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export interface Found {
  /** What the model list answered (0: nothing; see `failed`). */
  status: number;
  failed: Answer["failed"];
  /** The answer was a list of models (possibly an empty one). */
  listed: boolean;
  /** What the server turned out to be, from what it answered; null when it didn't say. */
  kind: ServerKind | null;
  models: ListedModel[];
  /** Memory the loaded models use, where the server says (Ollama). */
  memoryBytes: number | null;
}

/**
 * Asks a server for its models and what it is. Beyond the OpenAI-style list: llama.cpp's /props (the context a chat
 * gets), LM Studio's /api/v0/models (loaded or not, and each model's limit), Ollama's /api/ps and /api/tags (what is
 * loaded with the context it was given, sizes). Context sizes the list itself carries (Moonshot, OpenRouter and xAI
 * context_length, Mistral max_context_length, vLLM max_model_len, DeepSeek and Groq context_window, Venice
 * model_spec.availableContextTokens) are read too, and what each model can do where the list says
 * (Venice model_spec.capabilities.supportsFunctionCalling: an agent needs tool calls; Refuseless `abliterated`: its
 * refusals were taken out of the weights).
 * One time limit covers all of it.
 */
export async function readServer(base: string, key: string, o: { listPath?: string; timeoutMs: number }): Promise<Found> {
  const signal = AbortSignal.timeout(o.timeoutMs);
  const get = (path: string) => ask(base + path, { key, signal });
  const list = await get(o.listPath ?? "/v1/models");
  const raw = Array.isArray(list.json) ? list.json : list.json?.data;
  const listed = list.status >= 200 && list.status < 300 && Array.isArray(raw);
  const found: Found = { status: list.status, failed: list.failed, listed, kind: null, models: [], memoryBytes: null };
  if (!listed) return found;
  const entries = (raw as any[]).filter((m) => typeof m?.id === "string" && m.id).slice(0, MAX_LISTED); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [props, v0, ps] = await Promise.all([get("/props"), get("/api/v0/models"), get("/api/ps")]);
  const llama = props.status === 200 && props.json && typeof props.json === "object" ? props.json : null;
  const lmStudio: any[] | null = Array.isArray(v0.json?.data) ? v0.json.data : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ollama: any[] | null = Array.isArray(ps.json?.models) ? ps.json.models : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const owner = (name: string) => entries.some((m) => m.owned_by === name);
  found.kind = llama ? "llamacpp" : lmStudio ? "lmstudio" : ollama ? "ollama" : owner("llamacpp") ? "llamacpp" : owner("library") ? "ollama" : owner("vllm") ? "vllm" : null;
  const tagged = ollama ? (await get("/api/tags")).json?.models : null;
  const tags: any[] = Array.isArray(tagged) ? tagged : []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const named = (rows: any[] | null, id: string) => rows?.find((r) => r?.name === id || r?.model === id || r?.id === id); // eslint-disable-line @typescript-eslint/no-explicit-any
  const window = count(llama?.default_generation_settings?.n_ctx ?? llama?.n_ctx);
  found.models = entries.map((m) => {
    let contextWindow =
      count(m.context_length) ?? count(m.max_context_length) ?? count(m.max_model_len) ?? count(m.context_window) ?? count(m.top_provider?.context_length) ?? count(m.model_spec?.availableContextTokens);
    const tools = flag(m.model_spec?.capabilities?.supportsFunctionCalling);
    let sizeBytes = bytes(m.meta?.size);
    let loaded = found.kind === "llamacpp" || found.kind === "vllm";
    if (found.kind === "llamacpp" && window) contextWindow = window;
    const lm = named(lmStudio, m.id);
    if (lm) {
      loaded = lm.state === "loaded";
      contextWindow = count(loaded ? lm.loaded_context_length : null) ?? count(lm.max_context_length) ?? contextWindow;
      sizeBytes = bytes(lm.size_bytes ?? lm.size) ?? sizeBytes;
    }
    const running = named(ollama, m.id);
    if (running) {
      loaded = true;
      contextWindow = count(running.context_length) ?? contextWindow;
    }
    if (ollama) sizeBytes = bytes(named(tags, m.id)?.size) ?? sizeBytes;
    // Refuseless says per model whether its refusals were taken out of the weights (`abliterated`, always present there).
    const uncensored = flag(m.abliterated);
    // And which thinking levels it takes (`reasoning_efforts`, `reasoning_default`): an agent asking for another gets a 400.
    const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts.filter((e: unknown): e is string => typeof e === "string" && /^[\w-]{1,20}$/.test(e)) : [];
    return {
      id: m.id as string,
      contextWindow,
      sizeBytes,
      loaded,
      tools,
      ...(uncensored === null ? {} : { uncensored }),
      ...(efforts.length ? { efforts, defaultEffort: typeof m.reasoning_default === "string" && efforts.includes(m.reasoning_default) ? m.reasoning_default : null } : {}),
    };
  });
  if (ollama) found.memoryBytes = ollama.reduce((n, r) => n + (bytes(r?.size) ?? 0), 0) || null;
  return found;
}

/** Where a server lists its models, given its chat path (Gemini's is /v1beta/openai/models, DeepSeek's /models). */
export function listPathFor(chatPath: string): string {
  return chatPath.endsWith("/chat/completions") ? `${chatPath.slice(0, -"/chat/completions".length)}/models` : "/v1/models";
}

export const routePaths = (chatPath: string): Record<Protocol, string> => ({ responses: "/v1/responses", messages: "/v1/messages", chat: chatPath });

/** POSTs `{}` to each address (in parallel): a server that has the address turns it down, one that hasn't says 404. */
export async function probeRoutes(base: string, key: string, chatPath: string, timeoutMs: number): Promise<Record<Protocol, Answer>> {
  const paths = routePaths(chatPath);
  const out = {} as Record<Protocol, Answer>;
  await Promise.all((Object.keys(paths) as Protocol[]).map(async (p) => (out[p] = await ask(base + paths[p], { key, post: true, signal: AbortSignal.timeout(timeoutMs) }))));
  return out;
}

/** 400, 401, 403 and 422 mean the address exists; 404 and 405 that it doesn't; anything else is odd. */
export function supportOf(status: number): Support {
  return [400, 401, 403, 422].includes(status) ? "yes" : status === 404 || status === 405 ? "no" : "unknown";
}

/** What each address says. A server that wants a key before it looks at the address answers 401 to all of them: that tells nothing. */
export function protocolsOf(answers: Record<Protocol, Answer>): Record<Protocol, Support> {
  const locked = Object.values(answers).every((a) => a.status === 401 || a.status === 403);
  const out = {} as Record<Protocol, Support>;
  for (const p of Object.keys(answers) as Protocol[]) out[p] = locked ? "unknown" : supportOf(answers[p].status);
  return out;
}

/** How Crosstalk can run a server: Codex on the Responses API, Claude Code on Messages, else Codex through the chat adapter. */
export const worksOf = (p: Record<Protocol, Support>): ServiceTestResult["works"] => serviceWorks(p);

/**
 * The model picker's entries for an endpoint account: the models it was saved with (the first is the default), then
 * the others its server lists now, under More models. Each model's context is what the server says, else what was
 * saved for it, else the account's own number. One the server says can't run tool calls is marked, because an agent
 * on it couldn't read a file or run a command. A service that says more about a model (NanoGPT: its price, whether it is
 * uncensored or covered by the subscription) has that said after where it runs (`about`).
 */
export function endpointModelOptions(
  ep: { label: string; models: string[]; contextWindow: number | null; contexts?: Record<string, number> },
  live: { id: string; contextWindow: number | null; tools?: boolean | null; about?: string; efforts?: string[]; defaultEffort?: string | null }[] | null,
): ModelOption[] {
  const ids = [...new Set([...ep.models, ...(live ?? []).map((m) => m.id)])].slice(0, Math.max(MAX_PICKER, ep.models.length));
  return ids.map((id, i) => ({
    id,
    label: id,
    description: [`On ${ep.label}`, live?.find((m) => m.id === id)?.about].filter(Boolean).join(" · "),
    efforts: live?.find((m) => m.id === id)?.efforts ?? [],
    defaultEffort: live?.find((m) => m.id === id)?.defaultEffort ?? null,
    isDefault: i === 0,
    contextWindow: live?.find((m) => m.id === id)?.contextWindow ?? ep.contexts?.[id] ?? ep.contextWindow,
    ...(ep.models.includes(id) ? {} : { more: true }),
    ...(live?.find((m) => m.id === id)?.tools === false ? { noTools: true } : {}),
  }));
}

// ---- the account fields added in 0.4 (protocol, chatPath, contexts) and 0.5 (extra) ----

export interface EndpointExtras {
  protocol?: Protocol;
  chatPath?: string;
  contexts?: Record<string, number>;
  extra?: Record<string, unknown>;
}

const CHAT_PATH_SHAPE = /^\/[\w.~%:@!$&'()*+,;=/-]{0,198}$/;
/** The most an account's extra body fields can be: a handful of settings (Venice sends one object), not a payload. */
const MAX_EXTRA_KEYS = 10;
const MAX_EXTRA_CHARS = 2000;

/** A chat path from a request: undefined (not given), null (blank: the usual one) or a path starting with "/". */
export function cleanChatPath(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "string" && CHAT_PATH_SHAPE.test(v)) return v;
  throw new HttpError(400, "The chat path starts with /, like /v1/chat/completions");
}

/**
 * Body fields a service needs in every chat request: a plain JSON object of a few settings, with none of the fields the
 * adapter works out itself (a service must not be able to change the model, the messages, the tools or the stream, and a
 * saved account that tried would be refused here rather than quietly dropped).
 */
export function cleanExtra(v: unknown): Record<string, unknown> | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, 'Extra request fields are a JSON object, like {"venice_parameters": {"include_venice_system_prompt": false}}');
  const rows = Object.entries(v as Record<string, unknown>);
  if (!rows.length) return null;
  const taken = rows.map(([k]) => k).filter((k) => ADAPTER_FIELDS.includes(k));
  if (taken.length) throw new HttpError(400, `Crosstalk sets ${taken.join(", ")} itself: an extra request field can't be one of ${ADAPTER_FIELDS.join(", ")}.`);
  if (rows.length > MAX_EXTRA_KEYS || JSON.stringify(v).length > MAX_EXTRA_CHARS) throw new HttpError(400, `Extra request fields are at most ${MAX_EXTRA_KEYS} settings and ${MAX_EXTRA_CHARS} characters.`);
  return Object.fromEntries(rows);
}

/** The new fields of an endpoint account, checked. For each: undefined = not given (keep what the account has), null = take it away. */
export function endpointFields(p: Provider, input: { protocol?: unknown; chatPath?: unknown; contexts?: unknown; extra?: unknown }): { [K in keyof EndpointExtras]?: EndpointExtras[K] | null } {
  const out: { [K in keyof EndpointExtras]?: EndpointExtras[K] | null } = {};
  const { protocol, contexts } = input;
  if (protocol !== undefined) {
    if (protocol !== null && protocol !== "responses" && protocol !== "messages" && protocol !== "chat") throw new HttpError(400, "The protocol is one of responses, messages or chat");
    if (protocol === "chat" && p !== "codex" && !isServiceOnlyAgent(p)) throw new HttpError(400, "Only Codex can use a server that speaks just chat completions. Add it under Codex.");
    // Crosstalk's own agent and OpenCode talk to the service's Chat Completions address themselves: the only way they reach one.
    if (isServiceOnlyAgent(p) && protocol !== null && protocol !== "chat") throw new HttpError(400, `${PROVIDER_INFO[p].name} talks to a service in the Chat Completions style only.`);
    out.protocol = protocol;
  }
  const chatPath = cleanChatPath(input.chatPath);
  if (chatPath !== undefined) out.chatPath = chatPath;
  if (contexts !== undefined) {
    const rows = contexts === null ? [] : contexts && typeof contexts === "object" && !Array.isArray(contexts) ? Object.entries(contexts) : null;
    if (!rows || rows.length > 100 || rows.some(([k, v]) => !k || k.length > 200 || /\s/.test(k) || count(v) === null)) throw new HttpError(400, `Context sizes are model names with a number of tokens (${MIN_CONTEXT} to ${MAX_CONTEXT}), like {"qwen3": 32768}`);
    out.contexts = rows.length ? Object.fromEntries(rows as [string, number][]) : null;
  }
  const extra = cleanExtra(input.extra);
  if (extra !== undefined) out.extra = extra;
  return out;
}

/** An account's saved new fields with a change applied (see endpointFields). */
export function mergeEndpointFields(cur: EndpointExtras | undefined, change: ReturnType<typeof endpointFields>): EndpointExtras {
  const out: EndpointExtras = {};
  for (const k of ["protocol", "chatPath", "contexts", "extra"] as const) {
    const v = change[k] === undefined ? cur?.[k] : change[k];
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
