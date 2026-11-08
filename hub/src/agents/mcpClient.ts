// A small MCP client (Model Context Protocol, streamable HTTP) for Crosstalk's own agent (builtin.ts): enough to list an
// MCP server's tools and call them — which is how that agent drives BrowserOS neo (browseros.ts discoverMcp finds where
// the browser's MCP server is). Requests are JSON-RPC POSTs; a server answers with JSON or with an event stream whose
// `data:` lines carry the answer, and names a session (`mcp-session-id`) that every later request carries. A session the
// server forgot (404) is opened again once.

import { HUB_VERSION } from "../config";

/** One tool as an MCP server lists it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool call answered, made into text for a model: the server's text parts, and a note for each image. */
export interface McpResult {
  text: string;
  isError: boolean;
  /** Images the tool returned (a screenshot), as data URLs, for a model that can look at them. */
  images: string[];
}

const PROTOCOL = "2025-06-18";
/** The most of one answer read (a page read can be long; the model gets a shortened copy anyway). */
const MAX_ANSWER = 8_000_000;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The JSON-RPC answer to request `id` out of a body that is JSON, or an event stream of `data:` lines. */
export function answerOf(text: string, id: number): Json | null {
  const bodies = text.trimStart().startsWith("{") ? [text] : text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  for (const body of bodies) {
    if (!body.startsWith("{")) continue;
    try {
      const j = JSON.parse(body) as Json;
      if (j && j.id === id && ("result" in j || "error" in j)) return j;
    } catch {
      // Not this line: try the next.
    }
  }
  return null;
}

/** A tool result's content made into text (and images kept aside), as a model reads it. */
export function resultText(result: Json): McpResult {
  const parts: string[] = [];
  const images: string[] = [];
  for (const c of Array.isArray(result?.content) ? result.content : []) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type === "image" && typeof c.data === "string") {
      images.push(`data:${typeof c.mimeType === "string" ? c.mimeType : "image/png"};base64,${c.data}`);
      parts.push("[An image came back with this result.]");
    } else if (c?.type === "resource" && typeof c.resource?.text === "string") parts.push(c.resource.text);
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return { text: parts.join("\n"), isError: result?.isError === true, images };
}

export class McpClient {
  private session: string | null = null;
  private nextId = 1;
  private opened: Promise<void> | null = null;

  constructor(
    readonly url: string,
    private readonly opts: { timeoutMs?: number; get?: typeof fetch } = {},
  ) {}

  private get fetcher(): typeof fetch {
    return this.opts.get ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.session ? { "mcp-session-id": this.session, "mcp-protocol-version": PROTOCOL } : {}),
    };
  }

  /** One request and its answer. `signal` stops it (the turn was stopped); `again` is the one retry after a forgotten session. */
  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.opts.timeoutMs ?? 60_000, again = true): Promise<Json> {
    const id = this.nextId++;
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    const res = await this.fetcher(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any(signals) });
    if (res.status === 404 && this.session && again) {
      // The server forgot the session (it restarted): open a new one and ask once more.
      void res.body?.cancel().catch(() => {});
      this.session = null;
      this.opened = null;
      await this.open(signal);
      return this.request(method, params, signal, timeoutMs, false);
    }
    const session = res.headers.get("mcp-session-id");
    if (session) this.session = session;
    const text = await readCapped(res);
    if (!res.ok) throw new Error(`the browser's MCP server answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    const answer = answerOf(text, id);
    if (!answer) throw new Error("the browser's MCP server sent an answer Crosstalk couldn't read");
    if (answer.error) throw new Error(String(answer.error.message ?? "the browser's MCP server refused the request"));
    return answer.result;
  }

  /** The handshake, once per session: initialize, then the `initialized` notice. */
  open(signal?: AbortSignal): Promise<void> {
    this.opened ??= (async () => {
      await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "crosstalk-agent", version: HUB_VERSION } }, signal, 15_000);
      try {
        const r = await this.fetcher(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(5000) });
        void r.body?.cancel().catch(() => {});
      } catch {
        // A notice: nothing answers it, and a server that didn't take it still answers tools/list.
      }
    })().catch((e) => {
      this.opened = null;
      throw e;
    });
    return this.opened;
  }

  /** Every tool the server lists (it may page them). */
  async tools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.open(signal);
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, signal, 20_000);
      for (const t of Array.isArray(r?.tools) ? r.tools : []) {
        if (typeof t?.name !== "string") continue;
        out.push({ name: t.name, description: typeof t.description === "string" ? t.description : "", inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} } });
      }
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** Calls one tool. A tool's own failure comes back as `isError` (the model reads it); a broken connection throws. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 120_000): Promise<McpResult> {
    await this.open(signal);
    return resultText(await this.request("tools/call", { name, arguments: args }, signal, timeoutMs));
  }

  /** Tells the server this session is done (best effort). */
  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.opened = null;
    if (!session) return;
    try {
      const r = await this.fetcher(this.url, { method: "DELETE", headers: { "mcp-session-id": session, accept: "application/json, text/event-stream" }, signal: AbortSignal.timeout(2000) });
      void r.body?.cancel().catch(() => {});
    } catch {
      // It only had to be told.
    }
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER) {
      void reader.cancel().catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
