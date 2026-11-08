// What the hub asks Tailscale about itself: whether it's up, this machine's tailnet name, its HTTPS certificates, when
// it signs out, and where `tailscale serve` sends https. Read only — nothing here changes Tailscale (setting serve up
// needs the CLI and the person's own hands, and stays in the checklist's fix lines).
//
// Two ways in, because neither works everywhere:
//   1. the CLI (`tailscale status --json`, `tailscale serve status --json`), the only way a Homebrew or Linux install
//      has, and the command the checklist's fixes tell the person to run: if it can't answer, that's worth knowing;
//   2. the macOS app's local API, whose port and token sit in /Library/Tailscale, for an install whose only CLI is the
//      app's own binary. Its token is a credential, so it only ever goes to a listener that refused an unauthenticated
//      read the way tailscaled does (appClient below).
// The CLI goes first for those reasons; the local API picks up whatever it left unanswered. A machine with neither
// gets nothing at all, which reads as "Tailscale isn't installed".
//
// The macOS app's CLI (/Applications/Tailscale.app/Contents/MacOS/Tailscale) decides whether a shell started it: with
// no SHLVL in its environment it tries to open the GUI instead of answering, printing "The Tailscale GUI failed to
// start: …" **to stdout** and exiting **0**. The hub is a LaunchAgent and has no SHLVL, so every call got that text
// and Tailscale read as "installed but didn't answer". So the shell hint goes into the child's environment, and an
// answer only counts when it parses as a JSON object — the exit code never makes text into an answer.

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./util/log";

const log = logger("tailscale");

/** Which way answered: the `tailscale` command, or the macOS app's local API. */
export type TailscaleSource = "cli" | "app";

/** Tailscale's own answers about this machine, each parsed from JSON (null: that question got no answer). */
export interface TailscaleAnswers {
  /** The Tailscale CLI, when one is installed (the checklist's fixes name it); null: there's none. */
  cli: string | null;
  /** Each way tried, in the order tried. Empty: Tailscale isn't on this machine at all. */
  tried: TailscaleSource[];
  /** The way the status came from (null: nothing answered). */
  from: TailscaleSource | null;
  /** `tailscale status --json`. */
  status: Record<string, unknown> | null;
  /** The serve configuration, asked for only with `serve: true`. */
  serve: Record<string, unknown> | null;
}

/** Stand-ins for tests, so none of them reads /Library or this machine's own Tailscale. */
export interface TailscaleDeps {
  bin?: () => string | null;
  /** Where the macOS app keeps `ipnport` and `sameuserproof-<port>`. */
  appDir?: string;
  /** Runs the CLI (default: Bun.spawn with the shell hint). */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string } | null>;
  timeoutMs?: number;
}

/** The Tailscale CLI: CROSSTALK_TAILSCALE_BIN (tests), else on PATH or where its installers put it. */
export function tailscaleBin(): string | null {
  const override = process.env.CROSSTALK_TAILSCALE_BIN;
  if (override) return existsSync(override) ? override : null;
  const onPath = Bun.which("tailscale");
  if (onPath) return onPath;
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => existsSync(p)) ?? null;
}

/** Where the macOS app keeps its local API's port and proof file: CROSSTALK_TAILSCALE_APP_DIR (tests), else /Library/Tailscale. */
export function tailscaleAppDir(): string {
  return process.env.CROSSTALK_TAILSCALE_APP_DIR || "/Library/Tailscale";
}

/**
 * Runs the Tailscale CLI quietly: its exit code and stdout, or null when it couldn't run. The child's environment
 * gets SHLVL, without which the macOS app's CLI opens the GUI instead of answering (see the top of this file).
 */
export async function runTailscaleCli(bin: string, args: string[], timeoutMs = 5000): Promise<{ code: number | null; out: string } | null> {
  try {
    const p = Bun.spawn([bin, ...args], { env: { ...process.env, SHLVL: process.env.SHLVL || "1" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out };
  } catch {
    return null;
  }
}

/**
 * Text as a JSON object, or null when it isn't one. Anything that isn't JSON is never an answer, whatever the exit
 * code said. `emptyOk` is for the serve configuration alone: a Tailscale with nothing served answers with nothing.
 */
export function jsonObject(text: string | null | undefined, emptyOk = false): Record<string, unknown> | null {
  const t = (text ?? "").trim();
  if (!t) return emptyOk ? {} : null;
  try {
    const j = JSON.parse(t);
    // `null` parses, and an array or a number isn't an answer either.
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
    return emptyOk && j === null ? {} : null;
  } catch {
    return null;
  }
}

const STATUS_ARGS = (peers: boolean) => ["status", "--json", ...(peers ? [] : ["--self", "--peers=false"])];
const SERVE_ARGS = ["serve", "status", "--json"];
const statusPath = (peers: boolean) => `/localapi/v0/status${peers ? "" : "?peers=false"}`;
const SERVE_PATH = "/localapi/v0/serve-config";

/**
 * What Tailscale says about this machine. `peers` asks about the whole tailnet (the model pool picking a computer);
 * without it only this machine, so nothing is sent anywhere. `serve` also asks where https goes.
 */
export async function askTailscale(opts: { peers?: boolean; serve?: boolean } = {}, deps: TailscaleDeps = {}): Promise<TailscaleAnswers> {
  const bin = (deps.bin ?? tailscaleBin)();
  const dir = deps.appDir ?? tailscaleAppDir();
  const ms = deps.timeoutMs ?? 5000;
  const run = deps.run ?? runTailscaleCli;
  const tried: TailscaleSource[] = [];
  let status: Record<string, unknown> | null = null;
  let serve: Record<string, unknown> | null = null;
  let from: TailscaleSource | null = null;

  if (bin) {
    tried.push("cli");
    const [s, v] = await Promise.all([
      run(bin, STATUS_ARGS(!!opts.peers), ms).then((r) => jsonObject(r?.out)),
      // Nothing served prints nothing, so an empty answer counts here — but only when the command itself succeeded.
      opts.serve ? run(bin, SERVE_ARGS, ms).then((r) => (r ? jsonObject(r.out, r.code === 0) : null)) : Promise.resolve(null),
    ]);
    if (s) {
      status = s;
      from = "cli";
    }
    if (v) serve = v;
  }
  // The app's own API, for what the CLI left unanswered.
  if ((!status || (opts.serve && !serve)) && appPort(dir) !== null) {
    tried.push("app");
    // One client for both questions: the check that tailscaled is what listens happens once, before any token is sent.
    const api = await appClient(dir, ms);
    const [s, v] = api
      ? await Promise.all([status ? Promise.resolve(null) : api(statusPath(!!opts.peers)), opts.serve && !serve ? api(SERVE_PATH, true) : Promise.resolve(null)])
      : [null, null];
    if (s) {
      status = s;
      from = from ?? "app";
    }
    if (v) serve = v;
  }
  if (tried.length && !status) log.debug(`Tailscale didn't answer (tried ${tried.join(", ")})`);
  return { cli: bin, tried, from, status, serve };
}

/** This machine's Tailscale IPv4 from its status (`Self.TailscaleIPs`), when it has one. */
export function selfTailscaleIPv4(status: Record<string, unknown> | null): string | null {
  const ips = (status?.Self as { TailscaleIPs?: unknown } | undefined)?.TailscaleIPs;
  return (Array.isArray(ips) ? ips : []).find((ip): ip is string => typeof ip === "string" && isTailscaleIPv4(ip)) ?? null;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const octets = (ip: string) => {
  const m = IPV4_RE.exec(ip);
  return m && m.slice(1).every((o) => Number(o) <= 255) ? m.slice(1).map(Number) : null;
};
/** Four numbers from 0 to 255. */
export const isIPv4 = (ip: string) => !!octets(ip);
/** Tailscale's addresses are in 100.64.0.0/10. */
export const isTailscaleIPv4 = (ip: string) => {
  const o = octets(ip);
  return !!o && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
};
/** A Tailscale address of either kind: 100.64.0.0/10, or fd7a:115c:a1e0::/48 for IPv6. */
export const isTailscaleIP = (ip: string) => isTailscaleIPv4(ip) || /^fd7a:115c:a1e0:/i.test(ip);

// ---- the macOS app's local API ----

/**
 * The port the app's local API listens on, from `<dir>/ipnport`. It's a symlink whose target is the number (that's how
 * Tailscale's own code reads it), so a plain read of it finds no file; a file is read too, for an install that keeps
 * one. Null: this isn't an app install, or the port makes no sense.
 */
export function appPort(dir: string): number | null {
  const path = join(dir, "ipnport");
  let text: string | null = null;
  try {
    text = readlinkSync(path);
  } catch {
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  const n = Number((text ?? "").trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * The app's proof token for a port: `<dir>/sameuserproof-<port>`, which the installer leaves readable by this machine's
 * admin users. It is a credential for the whole local API: it is never logged, never returned and never put anywhere
 * but the one request's own header. Null when it isn't there or isn't a plain ASCII token.
 */
function appToken(dir: string, port: number): string | null {
  try {
    const t = readFileSync(join(dir, `sameuserproof-${port}`), "utf8").trim();
    return t && t.length <= 512 && /^[\x21-\x7e]+$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Reads of the app's local API: HTTP on 127.0.0.1 at its own port, with the proof token as an HTTP Basic password (no
 * user) and the socket's name as the Host, the way Tailscale's own clients ask. `/localapi/v0/status` answers the shape
 * of `tailscale status --json`, `/localapi/v0/serve-config` the shape of `tailscale serve status --json`.
 *
 * The token is a credential for the whole local API, and the port is an ordinary high port: it is in macOS's ephemeral
 * range, and nothing promises the pair in /Library is taken away when the daemon stops — exactly the case this way in
 * exists for. So before the token is sent anywhere, the same read is made with no credential at all and tailscaled has
 * to be what refuses it (see `tailscaledRefuses`); any other local program that happened to bind that port is never
 * handed the token. Null: there's no port or token, or what listens isn't tailscaled.
 */
async function appClient(dir: string, timeoutMs: number): Promise<((path: string, emptyOk?: boolean) => Promise<Record<string, unknown> | null>) | null> {
  const port = appPort(dir);
  const token = port === null ? null : appToken(dir, port);
  if (port === null || !token) return null;
  if (!(await tailscaledRefuses(port, timeoutMs))) return null;
  return async (path, emptyOk = false) => {
    try {
      const r = await appFetch(port, path, timeoutMs, `Basic ${btoa(`:${token}`)}`);
      if (!r.ok) {
        // Never the token itself, and never the body: only that it refused.
        log.debug(`the Tailscale app's API refused ${path} (${r.status})`);
        return null;
      }
      return jsonObject(await r.text(), emptyOk);
    } catch (e) {
      log.debug(`the Tailscale app's API didn't answer ${path}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  };
}

/**
 * Whether what listens on that port is Tailscale's own local API, asked without sending anything secret: tailscaled
 * answers an unauthenticated read with 401 and names itself in a `Tailscale-Version` header (older builds only in the
 * body, "auth required"). Anything else — a 200, a 404, a different 401 — means the token stays where it is.
 */
async function tailscaledRefuses(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const r = await appFetch(port, statusPath(false), timeoutMs, null);
    if (r.status !== 401) {
      log.debug(`what listens on port ${port} isn't Tailscale's local API (${r.status}), so the proof token wasn't sent`);
      return false;
    }
    if (r.headers.has("tailscale-version")) return true;
    const ok = (await r.text()).trim().toLowerCase() === "auth required";
    if (!ok) log.debug(`what listens on port ${port} refused in a way Tailscale wouldn't, so the proof token wasn't sent`);
    return ok;
  } catch (e) {
    log.debug(`the Tailscale app's API didn't answer: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** One request to the local API. The Host is the socket's name, the way Tailscale's clients ask it. */
function appFetch(port: number, path: string, timeoutMs: number, auth: string | null): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Host: "local-tailscaled.sock", ...(auth ? { Authorization: auth } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
}
