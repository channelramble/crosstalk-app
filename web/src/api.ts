import { PROTOCOL_VERSION, type ClientEvent, type ServerEvent } from "@crosstalk/shared";
import { ATTACHMENT_URL } from "./links";

const CONN_KEY = "crosstalk.conn.v1";

export interface Connection {
  baseUrl: string; // "" = same origin as the page
  token: string;
  deviceName: string;
}

/** True inside the Tauri shells (desktop + mobile), where the UI is bundled and the hub is remote. */
export const isNative = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || location.protocol === "tauri:" || location.hostname === "tauri.localhost");

export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Connection;
    return c.token ? c : null;
  } catch {
    return null;
  }
}

export function saveConnection(c: Connection | null) {
  try {
    if (c) localStorage.setItem(CONN_KEY, JSON.stringify(c));
    else localStorage.removeItem(CONN_KEY);
  } catch {
    // storage unavailable (private mode): the session just won't persist
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The hub's machine-readable reason, when it gives one ("busy"). */
    public code?: string,
  ) {
    super(message);
  }
}

let conn: Connection | null = loadConnection();

export function currentConnection() {
  return conn;
}

/** The active machine's connection, used by requests that don't name one (machines.ts saves the list). */
export function setConnection(c: Connection | null) {
  conn = c;
}

export function normalizeBaseUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(s) ? "http://" : "https://") + s;
  return s;
}

/**
 * Whether a machine's address is safe to send a pairing code and a sign-in to: https anywhere, and plain http only to
 * this device itself, an address on your own network (10.x, 172.16-31.x, 192.168.x, 169.254.x, Tailscale's 100.64-127.x)
 * or a name with no dots or ending in .local (a computer on the same network). Over plain http to anywhere else, both
 * would cross the internet readable.
 */
export function plainHttpElsewhere(baseUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || !host.includes(".") || /\.(local|lan|home|internal|home\.arpa)$/.test(host)) return false;
  if (/^(fe80|f[cd][0-9a-f]{2}):/.test(host)) return false;
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!ip) return true;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return !(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
}

/**
 * Uploads a file with no overall time limit, so large transfers and slow ZIP unpacking can finish. It fails
 * only if the upload stops making progress for a minute (a stalled connection).
 */
export type UploadOptions = {
  /** Bytes sent so far, as the upload proceeds. */
  onProgress?: (loaded: number, total: number) => void;
  /** All bytes are sent; the hub is now saving or unpacking them. */
  onSent?: () => void;
  signal?: AbortSignal;
};

/** Uploads a file to the hub (see uploadBlob), reporting progress. */
export function uploadFile<T>(path: string, body: Blob, opts: UploadOptions = {}, c: Connection | null = conn): Promise<T> {
  return uploadBlob<T>("POST", (c?.baseUrl ?? "") + path, body, c?.token, opts);
}

function uploadBlob<T>(method: string, url: string, body: Blob, token: string | undefined, opts: UploadOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let cancelled = false;
    if (opts.signal) {
      if (opts.signal.aborted) return reject(new ApiError(0, "Upload cancelled"));
      opts.signal.addEventListener("abort", () => { cancelled = true; xhr.abort(); }, { once: true });
    }
    xhr.open(method, url);
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    let stall: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => xhr.abort(), 60_000);
    };
    xhr.upload.onprogress = (e) => { watch(); opts.onProgress?.(e.loaded, e.lengthComputable ? e.total : body.size); };
    // Once the bytes are sent, the hub may spend a while unpacking; that's progress too, so stop the stall timer.
    xhr.upload.onload = () => { clearTimeout(stall); opts.onSent?.(); };
    xhr.onload = () => {
      clearTimeout(stall);
      let data: unknown = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = { error: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, (data as { error?: string })?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => { clearTimeout(stall); reject(new ApiError(0, "The upload was interrupted. Check your connection and send again; finished files won't be re-sent.")); };
    xhr.onabort = () => { clearTimeout(stall); reject(new ApiError(0, cancelled ? "Upload cancelled" : "The upload stalled: no progress for a minute. Check your connection and try again.")); };
    watch();
    xhr.send(body);
  });
}

/** A request to the hub. It gives up after `timeoutMs` (20 seconds unless a slower route needs longer). */
/** The name this app's live connections go by. */
export const SOCKET_PROTOCOL = "crosstalk";
/**
 * What a live connection offers when it opens: its name, and this device's sign-in beside it (a WebSocket can carry no
 * header of its own from a browser; this is the one place it can say something that isn't its address).
 */
export const socketAuth = (token: string): string[] => [SOCKET_PROTOCOL, `bearer.${token}`];
/** Per machine (its address): whether its live connection has to carry the sign-in in its address, as before 0.11. */
const oldWay = new Map<string, boolean>();

/**
 * Whether a path the app is about to ask a machine for is one it could have built itself: under /api/, with no step
 * up or down the path (plain or percent-encoded) and no backslash, which a browser reads as a slash. Ids from an
 * address someone wrote can't then steer a request to another route.
 */
export function safeApiPath(path: string): boolean {
  const [route] = path.split(/[?#]/, 1);
  return /^\/(api|internal)\//.test(route) && !/\\|%5c|%2e|%2f|(^|\/)\.{1,2}(\/|$)/i.test(route);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, c: Connection | null = conn, timeoutMs = 20_000): Promise<T> {
  if (!safeApiPath(path)) throw new ApiError(400, "That isn't an address this app asks for.");
  if (body instanceof Blob) return uploadBlob<T>(method, (c?.baseUrl ?? "") + path, body, c?.token);
  const headers: Record<string, string> = {};
  if (c?.token) headers.authorization = `Bearer ${c.token}`;
  if (body !== undefined) headers["content-type"] = body instanceof Blob ? "application/octet-stream" : "application/json";
  let res: Response;
  let text: string;
  // Never hang forever: a blocked connection (e.g. Android's local-network permission) should surface as an error.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    res = await fetch((c?.baseUrl ?? "") + path, { method, headers, body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    const timedOut = (e as Error)?.name === "AbortError";
    const android = /Android/.test(navigator.userAgent);
    throw new ApiError(
      0,
      timedOut
        ? `The machine didn't answer.${android && isNative ? " If it's on your home network, allow Crosstalk's local network access in Android Settings → Apps → Crosstalk → Permissions." : ""} Check that Crosstalk is running on it and that this device is on your Tailscale network.`
        : "Can't reach the machine. Check that Crosstalk is running on it and that this device is on your Tailscale network.",
    );
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: unknown } | null;
    throw new ApiError(res.status, err?.error || `Request failed (${res.status})`, typeof err?.code === "string" ? err.code : undefined);
  }
  return data as T;
}

/** Fetch uploads with the device's bearer token; never put tokens in image URLs or chat history. */
export async function attachmentBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  if (!ATTACHMENT_URL.test(path)) throw new ApiError(400, "Invalid attachment URL");
  const res = await fetch((conn?.baseUrl ?? "") + path, { headers: conn?.token ? { authorization: `Bearer ${conn.token}` } : {}, signal });
  if (!res.ok) throw new ApiError(res.status, "Couldn't open the attachment");
  return res.blob();
}

/** A file inside an uploaded folder, fetched with the device's token. */
export async function folderFileBlob(folderUrl: string, rel: string): Promise<Blob> {
  if (!/^\/api\/rooms\/[^/]+\/folders\/[^/]+\/[^/?#]+$/.test(folderUrl)) throw new ApiError(400, "Invalid folder URL");
  const res = await fetch(`${conn?.baseUrl ?? ""}${folderUrl}?file=${encodeURIComponent(rel)}`, { headers: conn?.token ? { authorization: `Bearer ${conn.token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, "Couldn't open the file");
  return res.blob();
}

/** A file from the room's project folder, by absolute or project-relative path. */
export async function projectFileBlob(roomId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`${conn?.baseUrl ?? ""}/api/rooms/${encodeURIComponent(roomId)}/files?path=${encodeURIComponent(path)}`, { headers: conn?.token ? { authorization: `Bearer ${conn.token}` } : {}, signal });
  if (!res.ok) {
    let msg = "Couldn't download the file";
    try { msg = ((await res.json()) as { error?: string }).error || msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.blob();
}

export async function pairDevice(baseUrl: string, code: string, name: string): Promise<Connection> {
  // Not over plain http to somewhere on the internet: the code and the sign-in it buys would cross it readable.
  if (plainHttpElsewhere(baseUrl)) throw new ApiError(400, "That address isn't https. Use the machine's https address, or its address on your own network.");
  const platform = navigator.userAgent.match(/(iPhone|iPad|Android|Macintosh|Windows|Linux)/)?.[1] ?? "Web";
  const res = await api<{ token: string }>("POST", "/api/pair", { code, name, platform: isNative ? `${platform} app` : platform }, { baseUrl, token: "", deviceName: name });
  return { baseUrl, token: res.token, deviceName: name };
}

type Status = "connecting" | "open" | "closed";

/**
 * How Live checks its connection: after `heartbeatMs` without a word from the hub (while the page is visible) it pings,
 * and a ping not answered within `timeoutMs` (`wakeMs` just after the page comes back) means the connection is dead. A
 * new connection gets `connectMs` to open. The last two default to `timeoutMs`.
 */
export interface LiveTiming {
  heartbeatMs: number;
  timeoutMs: number;
  wakeMs?: number;
  connectMs?: number;
}

const TIMING: LiveTiming = { heartbeatMs: 15_000, timeoutMs: 5_000, wakeMs: 3_000, connectMs: 10_000 };

/**
 * Reconnecting WebSocket that delivers hub events. A socket can die quietly while a phone sleeps: when the page comes
 * back, a ping with a short deadline finds out, and a dead one is replaced at once. An answer means the socket stayed
 * up, so nothing was missed: `onResume` then gets how long the page was away (the app catches up only after a while).
 * `onWake` hears of it the moment the page is back, before anyone knows whether the socket lived: how long it was
 * away, so what's on screen can be said to be out of date at once rather than after the ping's deadline.
 */
export class Live {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pulse: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** When the page was hidden (null while it's visible). */
  private hiddenAt: number | null = null;
  /** The page came back and pinged: how long it was away, until the hub answers. */
  private resumed: number | null = null;

  constructor(
    private c: Connection,
    private onEvent: (e: ServerEvent) => void,
    private onStatus: (s: Status) => void,
    private timing: LiveTiming = TIMING,
    private onResume?: (awayMs: number) => void,
    private onWake?: (awayMs: number) => void,
  ) {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") this.hiddenAt = Date.now();
    this.open();
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("online", this.wake);
  }

  private visibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt ??= Date.now();
      return;
    }
    this.wake();
  };

  private wake = () => {
    if (this.closed || document.visibilityState !== "visible") return;
    const away = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (away > 0) this.onWake?.(away);
    if (!this.ws || this.ws.readyState > 1) {
      this.retry = 0;
      this.open();
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.resumed = Math.max(this.resumed ?? 0, away);
      // Not answered: it died while the page was away, and a new one connects at once.
      this.ping(this.timing.wakeMs ?? this.timing.timeoutMs, true);
    }
  };

  private clearHealth() {
    if (this.pulse) clearTimeout(this.pulse);
    if (this.deadline) clearTimeout(this.deadline);
    this.pulse = this.deadline = null;
  }

  private received() {
    this.clearHealth();
    // Quiet while the page is hidden: coming back checks the connection.
    this.pulse = setTimeout(() => document.visibilityState !== "hidden" && this.ping(this.timing.timeoutMs), this.timing.heartbeatMs);
    if (this.resumed !== null) {
      const away = this.resumed;
      this.resumed = null;
      this.onResume?.(away);
    }
  }

  /**
   * A ping the hub must answer within `ms` (a fresh deadline replaces one already running). `now`: without an answer,
   * connect again at once rather than after the usual pause.
   */
  private ping(ms: number, now = false) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    this.clearHealth();
    const ws = this.ws;
    this.deadline = setTimeout(() => this.lost(ws, now), ms);
    try { ws.send(JSON.stringify({ t: "ping" })); } catch { this.lost(ws, now); }
  }

  private lost(ws: WebSocket, now = false) {
    if (this.closed || this.ws !== ws) return;
    this.ws = null; // Old socket callbacks must never change the new connection's state.
    this.resumed = null;
    this.clearHealth();
    ws.close();
    this.onStatus("closed");
    if (now) {
      this.retry = 0;
      this.open();
      return;
    }
    const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 300;
    this.timer = setTimeout(() => this.open(), delay);
  }

  /** The last try was made the new way (the sign-in beside the connection's name) and hasn't opened. */
  private triedNew = false;

  private open() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearHealth();
    const base = this.c.baseUrl || location.origin;
    // Says which protocol this app speaks: steps then stream as deltas (older apps get whole steps).
    // The sign-in travels beside the connection's name (socketAuth), not in its address, where a proxy's log or a
    // copied address would keep it. A machine on a version before that knows only the address: when a try without
    // it never opens, the next one is made the old way, and the way that worked is remembered for this machine.
    const inAddress = oldWay.get(base) ?? this.triedNew;
    const url = base.replace(/^http/, "ws") + (inAddress ? `/api/ws?token=${encodeURIComponent(this.c.token)}&v=${PROTOCOL_VERSION}` : `/api/ws?v=${PROTOCOL_VERSION}`);
    this.onStatus("connecting");
    const ws = inAddress ? new WebSocket(url) : new WebSocket(url, socketAuth(this.c.token));
    this.triedNew = !inAddress && !oldWay.has(base);
    this.ws = ws;
    this.deadline = setTimeout(() => this.lost(ws), this.timing.connectMs ?? this.timing.timeoutMs);
    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      oldWay.set(base, inAddress);
      this.triedNew = false;
      this.retry = 0;
      this.received();
      this.onStatus("open");
    };
    ws.onmessage = (ev) => {
      if (this.closed || this.ws !== ws) return;
      this.received();
      try {
        const event = JSON.parse(ev.data);
        if (event.t !== "pong") this.onEvent(event);
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = () => this.lost(ws);
    ws.onerror = () => this.lost(ws);
  }

  /**
   * Try now: connects again at once instead of waiting out the backoff (up to 15 s after a few failures). An open
   * connection is checked with a ping instead.
   */
  reconnectNow() {
    if (this.closed) return;
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      this.ping(this.timing.wakeMs ?? this.timing.timeoutMs, true);
      return;
    }
    this.retry = 0;
    // A connection still trying is dropped for a fresh one (its late callbacks are ignored: it's no longer this.ws).
    this.ws = null;
    ws?.close();
    this.open();
  }

  send(e: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(e)); } catch { this.lost(this.ws); }
    }
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.clearHealth();
    document.removeEventListener("visibilitychange", this.visibility);
    window.removeEventListener("online", this.wake);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
