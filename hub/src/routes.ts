// What a route is, and how to declare one. Kept apart from server.ts so each feature module (asks.ts, spend.ts,
// services.ts) can define its own routes without importing the server.

import type { Device } from "@crosstalk/shared";
import { HttpError } from "./engine/engine";

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  device: Device;
  body: () => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Open to other machines' hubs (peer sign-ins); every other route is for people's devices only. */
  peer?: boolean;
}

/** A route other machines' hubs may call with their peer sign-in (only what their agents need). */
export function peerRoute(method: string, path: string, handler: Handler): Route {
  return { ...route(method, path, handler), peer: true };
}

export function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  return { method, pattern, keys, handler };
}

/** What every JSON answer carries: a browser never guesses another type for it. */
export const JSON_HEADERS = { "content-type": "application/json", "x-content-type-options": "nosniff" };

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });

/** The most a request without a sign-in may send (a pairing code, an invite's answer, a notification): 64 KB. */
export const SMALL_BODY = 64 * 1024;
/** How long such a request has to send it: one that opens and then says nothing isn't waited for. */
export const SMALL_BODY_MS = 10_000;

/**
 * A request's body as text, read no further than `max` bytes (413 past it: the header's word isn't trusted, the bytes
 * are counted) and, with `timeoutMs`, no longer than that (408). Nothing is kept of a body that is refused.
 */
export async function readBody(req: Request, max: number, timeoutMs = 0): Promise<string> {
  const tooBig = () => new HttpError(413, `That's more than this takes in one request (${max >= 1024 * 1024 ? `${Math.round(max / (1024 * 1024))} MB` : `${Math.round(max / 1024)} KB`}).`, "too_long");
  const told = Number(req.headers.get("content-length"));
  if (Number.isFinite(told) && told > max) throw tooBig();
  const reader = req.body?.getReader();
  if (!reader) return "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => {
    if (timeoutMs > 0) timer = setTimeout(() => reject(new HttpError(408, "The request took too long to arrive. Try again.", "too_slow")), timeoutMs);
  });
  late.catch(() => undefined);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) break;
      size += value.byteLength;
      if (size > max) throw tooBig();
      parts.push(value);
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * A request's JSON body, capped like readBody. Nothing sent is `{}`. A body that isn't JSON is refused (400), or read
 * as `{}` with `lenient` (the routes without a sign-in, where it then simply holds no code).
 */
export async function readJson(req: Request, max: number, opts: { timeoutMs?: number; lenient?: boolean } = {}): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const text = await readBody(req, max, opts.timeoutMs ?? 0);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (opts.lenient) return {};
    throw new HttpError(400, "That request wasn't readable (it should be JSON).", "bad_json");
  }
}

