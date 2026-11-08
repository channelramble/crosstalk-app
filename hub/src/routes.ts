// What a route is, and how to declare one. Kept apart from server.ts so each feature module (asks.ts, spend.ts,
// services.ts) can define its own routes without importing the server.

import type { Device } from "@crosstalk/shared";

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

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

