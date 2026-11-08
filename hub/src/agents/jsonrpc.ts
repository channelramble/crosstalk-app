import { endProcess } from "../util/process";
import type { Subprocess } from "bun";
import { logger } from "../util/log";
import { UdsWebSocket } from "./udsws";

const log = logger("rpc");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RpcMessage {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: Json,
  ) {
    super(message);
  }
}

/**
 * JSON-RPC 2.0 peer: our requests, the other side's notifications, and requests it sends us. Subclasses carry the
 * messages (a child process's stdio, or a socket).
 */
export abstract class JsonRpc {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
  private notifyHandlers = new Set<(method: string, params: Json) => void>();
  private requestHandler: ((method: string, params: Json, id: number | string) => Promise<Json>) | null = null;
  protected closed = false;
  /** Resolves (with an exit code, or 0 for a socket) once the connection is gone. */
  abstract readonly exited: Promise<number>;
  stderrTail = "";

  constructor(protected readonly name: string) {}

  get alive() {
    return !this.closed;
  }

  /** Sends one message; quietly does nothing once the connection is gone. */
  protected abstract send(line: string): void;

  /** Ends the connection; resolves once it's gone. */
  abstract kill(): Promise<void>;

  /** Rejects everything still waiting for an answer: the other side has gone. */
  protected closeWith(reason: string) {
    this.closed = true;
    const err = new RpcError(-32000, reason);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  onNotification(fn: (method: string, params: Json) => void): () => void {
    this.notifyHandlers.add(fn);
    return () => this.notifyHandlers.delete(fn);
  }

  onRequest(fn: (method: string, params: Json, id: number | string) => Promise<Json>) {
    this.requestHandler = fn;
  }

  request<T = Json>(method: string, params?: Json, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(-32000, `${this.name} has gone`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32001, `${method} timed out`));
      }, timeoutMs) : null;
      this.pending.set(id, {
        method,
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: Json) {
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  private write(msg: RpcMessage) {
    if (this.closed) return;
    try {
      this.send(JSON.stringify(msg));
    } catch (e) {
      log.debug(`${this.name}: write failed: ${e}`);
    }
  }

  protected handleLine(line: string) {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      // A request from the other side to us.
      const id = msg.id;
      const handler = this.requestHandler;
      if (!handler) return this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unhandled: ${msg.method}` } });
      handler(msg.method, msg.params, id)
        .then((result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }))
        .catch((e) => this.write({ jsonrpc: "2.0", id, error: { code: e instanceof RpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } }));
      return;
    }
    if (msg.method) {
      for (const fn of this.notifyHandlers) {
        try {
          fn(msg.method, msg.params);
        } catch (e) {
          log.warn(`notification handler for ${msg.method} threw: ${e}`);
        }
      }
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }
}

/**
 * Newline-delimited JSON-RPC over a child process's stdio (Codex app-server, ACP agents).
 */
export class StdioRpc extends JsonRpc {
  readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  readonly exited: Promise<number>;

  constructor(argv: string[], opts: { cwd?: string; env?: Record<string, string>; name: string }) {
    super(opts.name);
    this.proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.exited = this.proc.exited.then((code) => {
      this.closeWith(`${opts.name} exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
      return code;
    });
    void this.readLoop();
    void this.readStderr(opts.name);
  }

  protected send(line: string) {
    this.proc.stdin.write(line + "\n");
    this.proc.stdin.flush();
  }

  private async readLoop() {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch (e) {
      log.debug(`read loop ended: ${e}`);
    }
  }

  private async readStderr(name: string) {
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.proc.stderr) {
        const s = dec.decode(chunk, { stream: true });
        this.stderrTail = (this.stderrTail + s).slice(-4000);
        log.debug(`${name} stderr: ${s.trim().slice(0, 300)}`);
      }
    } catch {
      // ignore
    }
  }

  /** Ends the process; resolves once it has exited (SIGKILL after the grace period if it ignores SIGTERM). */
  kill(): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    return endProcess(this.proc);
  }
}

/**
 * JSON-RPC over a WebSocket on a Unix socket: how clients reach a shared, long-running server such as the Codex
 * app's app-server daemon. Ending this connection never ends the server.
 */
export class SocketRpc extends JsonRpc {
  private ws: UdsWebSocket;
  readonly exited: Promise<number>;
  readonly ready: Promise<void>;

  constructor(path: string, name: string) {
    super(name);
    this.ws = new UdsWebSocket(path);
    this.ws.onmessage = (text) => this.handleLine(text);
    this.exited = new Promise((resolve) => {
      this.ws.onclose = () => {
        this.closeWith(`${name} connection closed`);
        resolve(0);
      };
    });
    this.ready = this.ws.ready;
    // A failed connection counts as closed, so nothing waits on it.
    this.ready.catch((e) => this.closeWith(`${name}: ${e instanceof Error ? e.message : e}`));
  }

  protected send(line: string) {
    this.ws.send(line);
  }

  async kill(): Promise<void> {
    if (this.closed) return;
    this.ws.close();
    await Promise.race([this.exited, Bun.sleep(1000)]);
    this.closed = true;
  }
}
