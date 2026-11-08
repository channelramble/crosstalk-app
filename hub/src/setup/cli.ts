// `crosstalk-hub setup [--json]`: the setup checklist from the running hub, in words for people or as JSON for agents.
// It asks the hub over its Unix socket with the setup key, made from the hub's internal secret (a file only this user
// can read), as the agents' MCP helpers do; when a sandbox blocks that socket it asks the same hub at its own address
// on this machine instead (askHub). When the hub doesn't answer at all it still prints what it can tell by itself. It
// never runs loadConfig (that makes folders) and never opens the database.

import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { arch, homedir, hostname, platform, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { SetupChecklist, SetupGroup, SetupItem, SetupState } from "@crosstalk/shared";
import { CONFIG_PATH, HOME, HUB_VERSION, RUN_DIR } from "../config";
import { setupChecklist, setupCliCommand, sh, type Offline, type ServiceFacts } from "./checklist";
import { setupKeyFor } from "./index";
import { serviceFromManager } from "./system";

/** What the hub said: its answer, its own error, or why it couldn't be asked. */
export type HubAnswer<T> = { kind: "ok"; data: T } | { kind: "error"; status: number; error: string; code?: string } | { kind: "offline"; offline: Offline };

/** The `setup` command or the setup MCP server: the two programs that ask the hub from outside it. */
export type Asker = "cli" | "mcp";

/** `crosstalk-hub setup` as a person types it in a terminal here, for words that hand the job back to them. */
export const selfSetupCommand = (self: string[]) => setupCliCommand(self.map(sh).join(" "), HOME === resolve(join(homedir(), ".crosstalk")) ? null : HOME);

/** Why a way in didn't work, in the words the checklist shows. */
const REACH_WHY: Record<"missing" | "refused" | "denied", string> = {
  missing: "it isn't there",
  refused: "it refused the connection",
  denied: "this program isn't allowed to open it",
};

/**
 * One call to the running hub's setup API. CROSSTALK_HUB_SOCKET and CROSSTALK_SETUP_KEY point it at another hub
 * (tests); otherwise it's the hub whose data is in CROSSTALK_HOME (~/.crosstalk).
 *
 * The socket comes first: it needs no port and no guesswork, and only this user can open it. But an agent's sandbox can
 * block Unix sockets while leaving localhost alone — measured inside Claude Code's on a Mac, where
 * `curl --unix-socket ~/.crosstalk/run/hub.sock` can't connect while `curl http://127.0.0.1:<port>/api/health` answers
 * 200 — and then every check came back "unknown". So when the socket can't be reached, the same call goes to the hub's
 * own address on this machine (its port from CROSSTALK_PORT or config.json), with the same key and the same answers.
 *
 * That hands out nothing new. The key is made from run/internal-secret, a mode-600 file of this user's: a program that
 * can read it can already read the hub's database, its secrets and every token in them, so letting it ask the hub over
 * 127.0.0.1 adds no power it didn't have. And the hub answers the setup API on its port only for a request made on this
 * machine straight to it — loopback peer address, loopback Host, no proxy headers (`directLocal`, setup/index.ts) — so
 * nothing arriving through `tailscale serve` or any other proxy can reach it, with or without the key. The call out
 * goes straight there too, never through an HTTP_PROXY the agent happens to have inherited (localJson below).
 */
export async function askHub<T>(path: string, body: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<HubAnswer<T>> {
  const socket = process.env.CROSSTALK_HUB_SOCKET || join(RUN_DIR, "hub.sock");
  let key = process.env.CROSSTALK_SETUP_KEY || "";
  if (!key) {
    const secret = join(RUN_DIR, "internal-secret");
    try {
      key = setupKeyFor(readFileSync(secret, "utf8").trim());
    } catch (e) {
      // Never started with this data folder, or a sandbox keeps this program out of it. Without the key there's nothing
      // to send, so neither way in is tried: say which one it is.
      if (denied(e)) return { kind: "offline", offline: { code: "blocked", tried: [{ via: "key", address: secret, why: "this program isn't allowed to read it" }] } };
      return { kind: "offline", offline: { code: "stopped", tried: [{ via: "key", address: secret, why: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "it isn't there: Crosstalk has never run with this data folder" : "it couldn't be read" }] } };
    }
  }
  const reach = await canConnect(socket);
  if (reach === "ok") return call<T>(() => sendSocket(socket, path, key, body, timeoutMs), "socket", null);
  const tried: NonNullable<Offline["tried"]> = [{ via: "socket", address: socket, why: REACH_WHY[reach] }];
  // The socket is out of reach: the hub's own address on this machine, the one way left that a sandbox may allow.
  const local = localBase();
  if (!local) tried.push({ via: "local", address: "", why: `not known: no port in ${CONFIG_PATH}` });
  else {
    // The key only ever goes to something that answered as a Crosstalk hub: whatever listens on a local port may be
    // any program of this user's (tailscale.ts holds its token the same way).
    const health = await hubHealth(local);
    if (health.ok) {
      // It answered for itself there, so the hub runs. A 404 for the setup API is then the build it runs having none
      // on its port (this way in came with it, so every hub started before it answers that way, the one running here
      // included). That is not a newer build waiting: `staged` is what the program at the hub's path is, which this
      // says nothing about, and a checklist that turns a missing route into "restart for the new build" asks for a
      // restart of the person's hub for nothing. Only the hub's own version, when it differs, means "older".
      const noSetupApi: Offline =
        health.version && health.version !== HUB_VERSION
          ? { code: "older", version: health.version, answered: true }
          : { code: "blocked", version: health.version, answered: true, tried: [...tried, { via: "local", address: local, why: "it answers, but the build it runs has no setup API there" }] };
      return call<T>(() => sendLocal(`${local}${path}`, key, body, timeoutMs), "local", noSetupApi);
    }
    tried.push({ via: "local", address: local, why: health.why });
  }
  return { kind: "offline", offline: await noWayIn(reach, tried, async () => (await serviceNow())?.active) };
}

/**
 * What it means that no way in worked, decided here and once: the checklist's words (offlineChecklist) and every
 * tool's (mcp/setup.ts `failed`) must say the same thing about the same machine, or one tells the agent the hub is
 * gone while the other describes it running.
 *
 * "Blocked" is something in the way of a hub that is there, "stopped" is no hub to reach. A hub that runs makes its
 * socket afresh, so a socket that refuses while the service runs is no leftover of a stopped hub: something is between
 * the two (a sandbox). That, not a guessed environment variable, is what catches Claude Code's sandbox, where the
 * socket refuses exactly as a dead hub's would. `serviceActive` is asked only when it can change the answer.
 */
export async function noWayIn(reach: "missing" | "refused" | "denied", tried: NonNullable<Offline["tried"]>, serviceActive: () => Promise<boolean | null | undefined>): Promise<Offline> {
  const blocked = reach === "denied" || (reach === "refused" && (sandboxed() || (await serviceActive()) === true));
  return blocked ? { code: "blocked", tried } : { code: "stopped", detail: reach, tried };
}

/** What a way in brought back, read the same way whichever one it was. */
type Reply = { status: number; ok: boolean; data: Record<string, unknown> };

const setupHeaders = (key: string) => ({ "content-type": "application/json", "x-crosstalk-setup": key });

/** The call over the hub's Unix socket: Bun's fetch opens one with `unix`, and no proxy variable touches that. */
async function sendSocket(socket: string, path: string, key: string, body: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
  const res = await fetch(`http://crosstalk${path}`, { unix: socket, method: "POST", headers: setupHeaders(key), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
  return { status: res.status, ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The same call to the hub's own address on this machine (localJson: straight there, never through a proxy). */
const sendLocal = (url: string, key: string, body: Record<string, unknown>, timeoutMs: number): Promise<Reply> => localJson("POST", url, setupHeaders(key), JSON.stringify(body), timeoutMs);

/**
 * A request to the hub's own address on this machine, made with node:http and not fetch.
 *
 * Why not fetch: Bun's sends even a 127.0.0.1 request through HTTP_PROXY/http_proxy/ALL_PROXY when one is set, and
 * `{ proxy: "" }` doesn't stop it (both measured on Bun 1.4.2). An agent inherits those variables from the person's
 * shell, and then the setup key — which mints pairing codes — would go to whatever the proxy is, perhaps off this
 * machine, and whatever answered it would stand in for the hub. node:http ignores them, so this request really never
 * leaves the machine, as docs/SETUP-FOR-AGENTS.md says. (The socket call can't be proxied at all.)
 *
 * It always settles. An answer the connection dropped part way through — the hub restarting between its headers and
 * the end of its body, which is what the version and service items ask for — never reaches `end`: Bun's node:http
 * reports it on the answer itself (`aborted`, an `error`, a `close` with `complete` false), never on the request
 * (measured on Bun 1.4.2: content-length cut short then FIN or RST, and chunked with no last chunk). And
 * `req.setTimeout` is a quiet-socket timer that can't fire once the socket is gone, so the call also has a deadline of
 * its own, as the socket way in has (`AbortSignal.timeout`).
 */
function localJson(method: string, url: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<Reply> {
  return new Promise((done, fail) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      finish();
    };
    const req = httpRequest(url, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      // The hub's own answer, but a cap all the same: a local port can be held by any program of this user's.
      res.on("data", (c: string) => {
        if (text.length < 8_000_000) text += c;
      });
      res.on("end", () =>
        settle(() => {
          let data: Record<string, unknown> = {};
          try {
            const j = JSON.parse(text);
            if (j && typeof j === "object" && !Array.isArray(j)) data = j as Record<string, unknown>;
          } catch {
            // Not JSON: no data, and the status says the rest.
          }
          const status = res.statusCode ?? 0;
          done({ status, ok: status >= 200 && status < 300, data });
        }),
      );
      const cut = () => settle(() => fail(new Error("its answer stopped part way, as when Crosstalk restarts")));
      res.on("aborted", cut);
      res.on("error", cut);
      res.on("close", () => {
        if (!res.complete) cut();
      });
    });
    const deadline = setTimeout(() => req.destroy(timeoutError()), timeoutMs);
    req.setTimeout(timeoutMs, () => req.destroy(timeoutError()));
    req.on("error", (e) => settle(() => fail(e)));
    req.end(body ?? undefined);
  });
}

function timeoutError(): Error {
  const e = new Error("it didn't answer in time");
  e.name = "TimeoutError";
  return e;
}

const timedOut = (e: unknown) => (e as Error)?.name === "TimeoutError";

/**
 * The service manager's word on the hub (`launchctl print`, `systemctl is-active`), asked once per program run: the
 * decision above and the checklist below both need it, and neither should spawn it twice.
 */
let serviceAsked: Promise<ServiceFacts | null> | null = null;
const serviceNow = () => (serviceAsked ??= serviceFromManager(runQuiet));

/**
 * What the hub's answer means, the same for both ways in: the same path, the same key, the same words out.
 * `noSetupApi`: what a 404 means for this way in (askHub works that out), null where a 404 is just an odd answer.
 */
async function call<T>(send: () => Promise<Reply>, via: "socket" | "local", noSetupApi: Offline | null): Promise<HubAnswer<T>> {
  let res: Reply;
  try {
    res = await send();
  } catch (e) {
    return { kind: "offline", offline: { code: "error", detail: timedOut(e) ? "it didn't answer in time" : String(e instanceof Error ? e.message : e) } };
  }
  if (res.ok) return { kind: "ok", data: res.data as T };
  if (res.status === 403 && res.data.code === "setup_key") return { kind: "offline", offline: { code: "key" } };
  // An older hub's socket knows only its agents' helpers, and refuses anything else.
  if (res.status === 403 && via === "socket") return { kind: "offline", offline: { code: "older", version: await runningVersion() } };
  // On the port the hub says 403 only for a key it doesn't know (above) or a request it took for a proxied one.
  if (res.status === 403) return { kind: "error", status: 403, error: "Crosstalk wouldn't take this at its own address: it looked like the request came through a proxy." };
  if (res.status === 404 && noSetupApi) return { kind: "offline", offline: noSetupApi };
  return { kind: "error", status: res.status, error: typeof res.data.error === "string" ? res.data.error : `Crosstalk answered ${res.status}.`, ...(typeof res.data.code === "string" ? { code: res.data.code } : {}) };
}

const denied = (e: unknown) => ["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException)?.code ?? "");

/**
 * Codex runs shell commands in its sandbox with these set, and there the hub's socket refuses connections as if the hub
 * had stopped (checked with `codex sandbox`, Codex 0.160 on macOS).
 *
 * Nothing wider is guessed from the environment, because nothing wider is provable: Claude Code sets no sandbox
 * variable at all — inside its Bash tool `env` shows CLAUDECODE=1 and CLAUDE_CODE_* whether its sandbox is on or off,
 * and the MCP servers it starts inherit the same ones, so none of them can mean "sandboxed". Nor are those servers
 * outside the sandbox: this whole fallback exists because one of them was inside it — `setup_status` through Claude
 * Code's own crosstalk-setup server couldn't open ~/.crosstalk/run/hub.sock while 127.0.0.1 answered 200 (measured on
 * macOS, Claude Code 2.1.289). What is in the way is found by trying instead: the socket, then the hub's own local
 * address, and a hub whose service runs while neither can be reached is what says "blocked" (askHub above).
 */
const sandboxed = () => !!(process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED);

/**
 * Whether the socket takes a connection. fetch says only "failed" whatever the cause; this tells no socket (ENOENT),
 * one that refuses (ECONNREFUSED: left by a hub that stopped, or a sandbox in the way) and one that isn't ours to open.
 */
function canConnect(path: string): Promise<"ok" | "missing" | "refused" | "denied"> {
  return new Promise((done) => {
    const c = createConnection(path);
    const finish = (v: "ok" | "missing" | "refused" | "denied") => {
      clearTimeout(timer);
      c.destroy();
      done(v);
    };
    const timer = setTimeout(() => finish("refused"), 3000);
    c.once("connect", () => finish("ok"));
    c.once("error", (e) => finish(denied(e) ? "denied" : (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "refused"));
  });
}

/** The hub's settings file, read only (never made). */
function configFile(): { port?: unknown; host?: unknown; publicUrl?: unknown } {
  try {
    return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

/** The hub's port, as config.ts works it out: the environment, then config.json, then 7420. */
function localPort(): number {
  const n = Number(process.env.CROSSTALK_PORT || configFile().port || 7420);
  return Number.isInteger(n) && n > 0 ? n : 7420;
}

/**
 * The hub's own address on this machine, for a call that carries the setup key: the port from CROSSTALK_PORT, then
 * config.json. Null when neither says one — 7420 is guessed only where nothing secret goes (hubHealth below), because
 * a guessed port is as easily another program's as the hub's.
 *
 * Always loopback, whatever host the hub also listens on: this asks the hub on this machine and must never leave it.
 */
function localBase(): string | null {
  const file = configFile();
  const n = Number(process.env.CROSSTALK_PORT || file.port || 0);
  if (!Number.isInteger(n) || n <= 0 || n >= 65_536) return null;
  const host = String(process.env.CROSSTALK_HOST || file.host || "");
  return `http://${host === "::1" || host === "[::1]" ? "[::1]" : "127.0.0.1"}:${n}`;
}

/**
 * Whether a Crosstalk hub answers at `base` (its public /api/health, which needs no key), and its version. This is
 * what says the setup key may be sent there: a local port can be held by any program of this user's.
 */
async function hubHealth(base: string, timeoutMs = 3000): Promise<{ ok: boolean; version: string | null; why: string }> {
  try {
    const r = await localJson("GET", `${base}/api/health`, {}, null, timeoutMs);
    const d = r.data as { ok?: unknown; name?: unknown; version?: unknown };
    const version = typeof d.version === "string" && /^\d+\.\d+[\w.-]*$/.test(d.version) ? d.version.slice(0, 30) : null;
    if (r.ok && d.ok === true && d.name === "crosstalk") return { ok: true, version, why: "" };
    return { ok: false, version: null, why: "something that isn't Crosstalk answered there" };
  } catch (e) {
    return { ok: false, version: null, why: timedOut(e) ? "it didn't answer in time" : "nothing answered" };
  }
}

/** The running hub's version, from its public /api/health on this machine (no secret goes with it). */
async function runningVersion(): Promise<string | null> {
  return (await hubHealth(`http://127.0.0.1:${localPort()}`, 2000)).version;
}

async function runQuiet(args: string[], timeoutMs = 5000): Promise<{ code: number; out: string } | null> {
  try {
    const p = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out };
  } catch {
    return null;
  }
}

/** This machine's name without the hub's settings: macOS's Computer Name, or the host name. */
function machineName(): string {
  if (platform() === "darwin") {
    try {
      const r = Bun.spawnSync(["scutil", "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore" });
      const name = r.stdout.toString().trim();
      if (name) return name.slice(0, 40);
    } catch {
      /* the host name, then */
    }
  }
  return hostname().replace(/\.local$/, "").split(".")[0] || "This machine";
}

/** What can be told without the hub: its service (launchctl or systemctl) and its version, the rest "unknown". */
export async function offlineChecklist(reason: Offline, self: string[], asker: Asker = "cli"): Promise<SetupChecklist> {
  const service = await serviceNow();
  // Why no way in worked was decided in askHub, which knows what it tried: nothing is reconsidered here, so the words
  // and every tool's say the same thing.
  const offline = reason;
  const file = configFile();
  const envUrl = process.env.CROSSTALK_PUBLIC_URL || null;
  const publicUrl = envUrl ?? (typeof file.publicUrl === "string" && file.publicUrl ? file.publicUrl : null);
  const idle = join(HOME, "bin", "restart-when-idle.sh");
  return setupChecklist({
    now: Date.now(),
    hub: {
      // It answered, just not with a checklist.
      running: offline.answered === true || offline.code === "older" || offline.code === "key" || offline.code === "error" || service?.active === true,
      version: HUB_VERSION,
      name: machineName(),
      platform: platform(),
      arch: arch(),
      port: localPort(),
      publicUrl,
      publicUrlFrom: envUrl ? "env" : publicUrl ? "config" : null,
      binary: self.map(sh).join(" "),
      home: HOME,
      defaultHome: HOME === resolve(join(homedir(), ".crosstalk")),
      user: userInfo().username,
    },
    offline,
    asker,
    service: service && { ...service, runningUnder: service.active ? (platform() === "darwin" ? "launchd" : "systemd") : null },
    staged: null,
    idleRestart: existsSync(idle) ? idle : null,
    tailscale: undefined,
    https: undefined,
    devices: null,
    push: null,
    providers: null,
    accounts: null,
    localServers: null,
    mac: undefined,
    machines: null,
    machineVersions: {},
    pool: null,
  });
}

/** The running hub's checklist (checked afresh: it's asked for after a fix), or the one this program can make without it. */
export async function currentChecklist(self: string[], asker: Asker = "cli", fresh = true): Promise<SetupChecklist> {
  return (await checklistNow(self, asker, fresh)).checklist;
}

/**
 * The checklist, and whether the hub made it. `fromHub` false: this program made it from what it can tell by itself
 * (offlineChecklist), which holds only a few items — an item missing from it wasn't checked, which is not the same as
 * not applying to this machine.
 */
export async function checklistNow(self: string[], asker: Asker = "cli", fresh = true): Promise<{ checklist: SetupChecklist; fromHub: boolean }> {
  const r = await askHub<SetupChecklist>("/internal/setup/status", { fresh });
  if (r.kind === "ok") return { checklist: r.data, fromHub: true };
  return { checklist: await offlineChecklist(r.kind === "offline" ? r.offline : { code: "error", detail: r.error }, self, asker), fromHub: false };
}

// ---- words ----

const MARK: Record<SetupState, string> = { done: "✓", missing: "!", user: "•", unknown: "?" };
const GROUP: Record<SetupGroup, string> = { hub: "Crosstalk", network: "Network", devices: "Devices", agents: "Agents", services: "AI services", mac: "This Mac", machines: "Machines", pool: "Model pool" };

/** "9 of 11 done · 1 to do · 1 needs you". */
export function summaryLine(c: SetupChecklist): string {
  const s = c.summary;
  return [`${s.done} of ${s.total} done`, s.missing ? `${s.missing} to do` : "", s.user ? `${s.user} need${s.user === 1 ? "s" : ""} you` : "", s.unknown ? `${s.unknown} not checked` : ""].filter(Boolean).join(" · ");
}

/** The checklist for a terminal: grouped, what to do under each item, commands whole (to copy), then how to add an agent. */
export function formatChecklist(c: SetupChecklist, width = 100): string {
  const w = Math.max(60, Math.min(width, 120));
  const out = [`Crosstalk setup on ${c.hub.name} (${c.hub.version}${c.hub.running ? "" : ", not running"})`, summaryLine(c), `${MARK.done} done   ${MARK.missing} to do (an agent can, with your OK)   ${MARK.user} needs you   ${MARK.unknown} not checked`];
  let group = "";
  for (const i of c.items.filter((x) => !x.optional)) {
    if (i.group !== group) out.push("", GROUP[i.group] ?? i.group);
    group = i.group;
    out.push(...row(i, w));
  }
  const optional = c.items.filter((x) => x.optional);
  if (optional.length) out.push("", "Optional", ...optional.flatMap((i) => row(i, w)));
  out.push("", "An AI agent on this machine can help: add its setup tools once.", `  ${c.connect.claude}`, `  ${c.connect.codex}`, `Then tell it: "${c.connect.prompt}"`, `For agents: ${c.connect.cli}  ·  ${c.connect.guide}`);
  return out.join("\n");
}

function row(i: SetupItem, width: number): string[] {
  const lines = wrap(`${MARK[i.state]} ${i.title}: ${i.detail}`, width, "  ", "    ");
  if (!i.fix || i.state === "done") return lines;
  lines.push(...wrap(i.fix.text, width, "    ", "    "));
  if (i.fix.command) lines.push(`      $ ${i.fix.command}${i.fix.password ? "   (asks for your password: run it yourself)" : ""}`);
  if (i.fix.screen) lines.push(...wrap(`In the app: ${i.fix.screen}`, width, "    ", "    "));
  if (i.fix.url) lines.push(`    ${i.fix.url}`);
  return lines;
}

/** Words wrapped at `width`, the first line after `first` and the others after `rest`. */
function wrap(text: string, width: number, first: string, rest: string): string[] {
  const out: string[] = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const lead = out.length ? rest : first;
    if (line.length > lead.length && line.length + 1 + word.length > width) {
      out.push(line);
      line = rest + word;
    } else line += (line.length > lead.length ? " " : "") + word;
  }
  out.push(line);
  return out;
}

const USAGE = "Usage: crosstalk-hub setup [--json]\n  What's left to set up in Crosstalk on this machine. --json: the same for AI agents (docs/SETUP-FOR-AGENTS.md).";

export async function runSetupCli(args: string[], self: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (args.some((a) => a !== "--json")) {
    console.error(USAGE);
    return 1;
  }
  const c = await currentChecklist(self);
  console.log(args.includes("--json") ? JSON.stringify(c, null, 2) : formatChecklist(c, process.stdout.isTTY ? (process.stdout.columns ?? 100) : 100));
  return 0;
}
