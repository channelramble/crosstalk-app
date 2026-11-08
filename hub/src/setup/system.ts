// What the setup checklist reads from the machine itself: how the hub runs (launchd or systemd), Tailscale and its
// serve settings, a newer build waiting at the hub's path, linked hubs' versions and the hub's own log. All read only.
// Only a hub on its real data folder gets these (app.ts): in-memory hubs (tests) get fakes or nothing.

import { lookup as dnsLookup } from "node:dns/promises";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import type { MacStatus } from "@crosstalk/shared";
import { HOME } from "../config";
import { askTailscale, isIPv4, isTailscaleIP } from "../tailscale";
import { browserOsFacts, type BrowserOsFacts, type McpAgent } from "../browseros";
import type { HttpsAnswer, ServiceFacts, TailscaleFacts } from "./checklist";

/** What the checklist asks the machine; each may be left out (then its items say "not checked"). */
export interface SetupProbes {
  service?: () => Promise<ServiceFacts | null>;
  /** null: Tailscale isn't installed. */
  tailscale?: () => Promise<TailscaleFacts | null>;
  /** Whether the hub's own https address answers, and whether this Crosstalk is what answers there. */
  https?: (url: string) => Promise<HttpsAnswer | null>;
  mac?: () => Promise<MacStatus | null>;
  /** The version of a newer build at the hub's path, waiting for a restart. */
  staged?: () => Promise<string | null>;
  /** A linked hub's version, from its public /api/health. */
  hubVersion?: (url: string) => Promise<string | null>;
  /** The newest lines of the hub's log, as written (redactLog hides what they mustn't show). */
  log?: (lines: number) => Promise<string[] | null>;
  /** restart-when-idle.sh, where it's installed. */
  idleRestart?: () => string | null;
  /**
   * BrowserOS neo: what's installed, the newest build for this machine, the address it serves agents on and which
   * agents point at it (hub/src/browseros.ts). `agents`: the agent CLIs installed here, so only those get a command.
   * Null: it couldn't be read at all.
   */
  browseros?: (agents: McpAgent[]) => Promise<BrowserOsFacts | null>;
}

type Run = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string } | null>;

/** The probes of a hub on this machine. `run` runs a command quietly (app.ts's runQuietly). */
export function systemProbes(run: Run, mac: (() => Promise<MacStatus>) | null): SetupProbes {
  return {
    service: () => hubService(run),
    tailscale: () => tailscaleFacts(),
    https: (url) => httpsAnswers(url),
    ...(mac ? { mac } : {}),
    staged: stagedBuild(run),
    hubVersion: (url) => hubVersion(url),
    log: (lines) => hubLog(run, lines),
    idleRestart: () => idleRestartScript(),
    // Its own `run` keeps stderr: codesign and spctl say what they found there, not on stdout.
    browseros: (agents) => browserOsFacts(agents).catch(() => null),
  };
}

// ---- the service ----

export const DEFAULT_LABEL = "com.crosstalk.hub";
const UNIT = "crosstalk-hub.service";
export const launchAgentFile = (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
export const unitFile = () => join(homedir(), ".config", "systemd", "user", UNIT);

/**
 * How the running hub was started, judged by the hub process itself: launchd's and systemd's variables are inherited by
 * every program it starts (agents included), so only a parent of 1 (launchd) or systemd's own process counts.
 */
export async function hubService(run: Run, env: Record<string, string | undefined> = process.env, ppid = process.ppid, platform = process.platform): Promise<ServiceFacts | null> {
  if (platform === "darwin") {
    const job = env.XPC_SERVICE_NAME;
    const launchd = ppid === 1 && !!job && job !== "0";
    const label = launchd ? job! : env.CROSSTALK_LABEL || DEFAULT_LABEL;
    const file = launchAgentFile(label);
    return { runningUnder: launchd ? "launchd" : "none", label, file, fileExists: existsSync(file) };
  }
  if (platform === "linux") {
    const file = unitFile();
    const systemd = !!env.INVOCATION_ID && readText("/proc/self/cgroup").includes(UNIT) && readText(`/proc/${ppid}/comm`).trim() === "systemd";
    const linger = await run(["loginctl", "show-user", userInfo().username, "--property=Linger", "--value"], 3000);
    return { runningUnder: systemd ? "systemd" : "none", label: UNIT, file, fileExists: existsSync(file), linger: linger?.code === 0 ? linger.out.trim() === "yes" : null };
  }
  return null;
}

/** The service as launchctl or systemctl see it, for the CLI when the hub doesn't answer. */
export async function serviceFromManager(run: Run, env: Record<string, string | undefined> = process.env, platform = process.platform): Promise<ServiceFacts | null> {
  if (platform === "darwin") {
    const label = env.CROSSTALK_LABEL || DEFAULT_LABEL;
    const file = launchAgentFile(label);
    const uid = process.getuid?.() ?? 0;
    const r = await run(["/bin/launchctl", "print", `gui/${uid}/${label}`], 5000);
    const loaded = r ? r.code === 0 : null;
    return { runningUnder: null, label, file, fileExists: existsSync(file), loaded, active: loaded === null ? null : loaded && /^\s*state = running/m.test(r!.out) };
  }
  if (platform === "linux") {
    const [enabled, active] = await Promise.all([run(["systemctl", "--user", "is-enabled", UNIT], 5000), run(["systemctl", "--user", "is-active", UNIT], 5000)]);
    return { runningUnder: null, label: UNIT, file: unitFile(), fileExists: existsSync(unitFile()), loaded: enabled ? enabled.out.trim() === "enabled" : null, active: active ? active.out.trim() === "active" : null };
  }
  return null;
}

// ---- Tailscale ----

export async function tailscaleFacts(): Promise<TailscaleFacts | null> {
  // About this machine only (no peers), asked of the Tailscale running here: nothing is sent anywhere. The CLI first,
  // then the macOS app's own API (tailscale.ts says why in that order).
  const a = await askTailscale({ serve: true });
  if (!a.tried.length) return null;
  const s = parseTailscaleStatus(a.status);
  return { cli: a.cli, tried: a.tried, from: a.from, ...s, serve: a.serve ? parseServeStatus(a.serve, s.dnsName) : null };
}

/** `tailscale status --json`: whether it's up, this machine's name, HTTPS certificates and key expiry. */
export function parseTailscaleStatus(status: unknown): Omit<TailscaleFacts, "cli" | "serve" | "tried" | "from"> {
  const j = (status && typeof status === "object" && !Array.isArray(status) ? status : null) as { BackendState?: unknown; CertDomains?: unknown; Self?: { DNSName?: unknown; KeyExpiry?: unknown } } | null;
  if (!j) return { state: null, dnsName: null, certs: null, keyExpiry: null };
  const state = typeof j.BackendState === "string" ? j.BackendState : null;
  const dns = typeof j.Self?.DNSName === "string" ? j.Self.DNSName.replace(/\.$/, "") : "";
  const expiry = typeof j.Self?.KeyExpiry === "string" ? Date.parse(j.Self.KeyExpiry) : NaN;
  return {
    state,
    dnsName: dns || null,
    // Without HTTPS certificates the list is missing or empty.
    certs: state === "Running" ? Array.isArray(j.CertDomains) && j.CertDomains.length > 0 : null,
    keyExpiry: Number.isFinite(expiry) ? expiry : null,
  };
}

/** The serve configuration (`tailscale serve status --json`): where https on port 443 goes, and whether Funnel opens it to the internet. */
export function parseServeStatus(serve: unknown, dnsName: string | null): TailscaleFacts["serve"] {
  const j = (serve && typeof serve === "object" && !Array.isArray(serve) ? serve : null) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown; Path?: unknown; Text?: unknown }> }>; AllowFunnel?: Record<string, unknown> } | null;
  if (!j) return null;
  const web = j.Web && typeof j.Web === "object" ? j.Web : {};
  const keys = Object.keys(web).filter((k) => k.endsWith(":443"));
  const key = (dnsName && keys.find((k) => k === `${dnsName}:443`)) || keys[0];
  const root = key ? web[key]?.Handlers?.["/"] : undefined;
  const target = typeof root?.Proxy === "string" ? root.Proxy : root?.Path ? "a folder" : root?.Text !== undefined ? "a fixed text" : null;
  return { target, funnel: !!key && j.AllowFunnel?.[key] === true };
}

/** Stand-ins for tests, so no test resolves a name or reads this machine's own addresses. */
export interface HttpsProbeDeps {
  get?: typeof fetch;
  /** A host's addresses, through the system resolver (which is Tailscale's MagicDNS while Tailscale is up). */
  lookup?: (host: string) => Promise<string[]>;
  /** This machine's own addresses, as its network interfaces have them. */
  own?: () => string[];
}

/**
 * Whether the hub's own https address answers, and whether what answers is this Crosstalk (`/api/health`): the one
 * thing the hub can still tell about its address when Tailscale itself can't be asked.
 *
 * Only ever asked of this machine's own tailnet address: the name is looked up first and has to be a Tailscale address
 * (100.64.0.0/10 or fd7a:115c:a1e0::/48) that this machine's own interfaces have. So the request can't leave the
 * machine, and a `publicUrl` that is stale, mistyped or someone else's — the very thing the public-url item is there to
 * catch — is never sent an unasked-for request. Null then: not checked, and the items say so.
 */
export async function httpsAnswers(url: string, deps: HttpsProbeDeps = {}): Promise<HttpsAnswer | null> {
  const get = deps.get ?? fetch;
  const host = httpsHost(url);
  if (!host || !(await isOwnTailnetAddress(host, deps))) return null;
  try {
    const r = await get(`${url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "error", headers: { accept: "application/json" } });
    // Any answer at all counts as answering, a web server's error page included: only Crosstalk's own health says more.
    const text = (await r.text().catch(() => "")).slice(0, 4096);
    let j: { name?: unknown; version?: unknown } | null = null;
    try {
      j = r.ok ? JSON.parse(text) : null;
    } catch {
      j = null;
    }
    const crosstalk = !!j && typeof j === "object" && j.name === "crosstalk";
    return { answers: true, crosstalk, version: crosstalk && typeof j?.version === "string" ? j.version : null };
  } catch {
    return { answers: false, crosstalk: false, version: null };
  }
}

/** The host of an https address, or null when it isn't one (http on this machine says nothing about the tailnet). */
function httpsHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname ? u.hostname.replace(/^\[|]$/g, "") : null;
  } catch {
    return null;
  }
}

/** An address as it compares: no IPv6 zone, one case. */
const bareAddress = (ip: string) => ip.replace(/%.*$/, "").toLowerCase();

/**
 * Whether that host is this machine's own address on the tailnet. The hub's own https name resolves to it through
 * MagicDNS while Tailscale is up; another machine's name, or a name that isn't on the tailnet at all, doesn't.
 */
async function isOwnTailnetAddress(host: string, deps: HttpsProbeDeps): Promise<boolean> {
  const mine = new Set(((deps.own ?? ownAddresses)() ?? []).map(bareAddress));
  const found = isIPv4(host) || host.includes(":") ? [host] : await (deps.lookup ?? resolveHost)(host).catch(() => []);
  return found.some((a) => isTailscaleIP(a) && mine.has(bareAddress(a)));
}

/** This machine's own addresses. */
const ownAddresses = () => Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address));

/** A name's addresses, through the system resolver (Tailscale's MagicDNS answers for tailnet names while it's up). */
const resolveHost = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

// ---- a newer build, other hubs' versions ----

/**
 * A compiled hub replaced at its path (a deploy moves the new build in place): the new file's version, until the hub is
 * restarted with it. In development the program is bun itself, which says nothing about Crosstalk.
 */
function stagedBuild(run: Run): () => Promise<string | null> {
  const path = process.execPath;
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");
  let start: { ino: number; mtime: number; size: number } | null = null;
  try {
    const s = statSync(path);
    start = { ino: s.ino, mtime: s.mtimeMs, size: s.size };
  } catch {
    start = null;
  }
  return async () => {
    if (!compiled || !start) return null;
    try {
      const s = statSync(path);
      if (s.ino === start.ino && s.mtimeMs === start.mtime && s.size === start.size) return null;
    } catch {
      return null;
    }
    const r = await run([path, "version"], 5000);
    const v = r?.code === 0 ? r.out.trim().split("\n")[0] : "";
    return /^\d+\.\d+[\w.-]*$/.test(v) ? v.slice(0, 30) : null;
  };
}

async function hubVersion(url: string): Promise<string | null> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(3000), redirect: "error" });
    const j = (await r.json()) as { version?: unknown };
    return typeof j.version === "string" && /^\d+\.\d+[\w.-]*$/.test(j.version) ? j.version.slice(0, 30) : null;
  } catch {
    return null;
  }
}

function idleRestartScript(): string | null {
  const path = join(HOME, "bin", "restart-when-idle.sh");
  return existsSync(path) ? path : null;
}

// ---- the hub's log ----

/** The Mac hub's log file (the LaunchAgent writes there); on Linux, systemd's journal. */
export const MAC_LOG = join(homedir(), "Library", "Logs", "Crosstalk", "hub.log");

async function hubLog(run: Run, lines: number): Promise<string[] | null> {
  if (process.platform === "darwin") return tailFile(MAC_LOG, lines);
  if (process.platform === "linux") {
    const r = await run(["journalctl", "--user", "-u", UNIT, "-n", String(lines), "-o", "cat", "--no-pager"], 5000);
    return r?.code === 0 ? r.out.split("\n").filter((l) => l.trim()) : null;
  }
  return null;
}

/** The last lines of a file, read from its last 256 KB only (a log can be large). */
export function tailFile(path: string, lines: number): string[] | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, size - len);
    const all = buf.toString("utf8").split("\n");
    // The first line may be cut off at the start of the window.
    if (len < size) all.shift();
    return all.filter((l) => l.trim()).slice(-lines);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * How much of a line the patterns below look at. A line can be 256 KB, and they run inside the hub, where a slow one
 * holds up every chat (unbounded ones once took seconds on a single line). Lines are capped at 400 characters
 * afterwards anyway; this leaves room for what hiding takes out.
 */
const LOOKED_AT = 2000;

/**
 * Log lines safe to hand an agent: pairing codes, tokens and keys, sign-in headers, one-time links and push endpoints
 * hidden, terminal colours and control characters taken out, each line capped.
 */
export function redactLog(lines: string[]): string[] {
  return lines.map((raw) => {
    let l = head(raw, LOOKED_AT).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
    l = l
      // Push endpoints are capabilities: only their host is kept.
      .replace(/https:\/\/([\w.-]*(?:push|fcm|notify|wns)[\w.-]*)\/\S*/gi, "https://$1/[hidden]")
      // One-time links: computer claims, Linux setup, invites, pool helpers.
      .replace(/\/(claim|install|invites|helper)\/[A-Za-z0-9_-]{8,}/g, "/$1/[hidden]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [hidden]")
      // Up to 40 characters of a name before "token" or "key" (any before them stay as they are): read from each word's
      // start to its end, a long dashed word took time that grew with its square.
      .replace(/((?:[\w-]{0,40}(?:token|key)|\b(?:secret|password|passwd|authorization))["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, "$1[hidden]")
      .replace(/\b(?:sk|pk|rk|hf|ct|ghp|gho|ghu|ghs|ghr|xox[abpr]|glpat)[-_][A-Za-z0-9_-]{8,}/g, "[hidden]")
      .replace(/\bAIza[\w-]{20,}/g, "[hidden]")
      // Pairing codes as Crosstalk makes them ("K7QM-2XPA").
      .replace(/\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g, "[code]")
      // Anything else long and random enough to be a token or a hash (letters and digits, or both cases).
      // macOS's privacy services (kTCCServiceSystemPolicyRemovableVolumes) are long words too, and tell what was asked.
      .replace(/[A-Za-z0-9_-]{32,}/g, (m) => (!m.startsWith("kTCCService") && ((/\d/.test(m) && /[A-Za-z]/.test(m)) || (/[a-z]/.test(m) && /[A-Z]/.test(m))) ? "[hidden]" : m))
      // Parts bounded by an address's own limits: unbounded, every start in a long dotted word without "@" read to its end.
      .replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g, "[email]");
    return l.length > 400 ? `${l.slice(0, 399)}…` : l;
  });
}

/** A line's first `max` characters, never stopping inside a word: a token's or an address's start would slip past the patterns. */
function head(line: string, max: number): string {
  if (line.length <= max) return line;
  let end = max;
  while (end > 0 && /[\w.+@-]/.test(line[end - 1]!)) end--;
  return `${line.slice(0, end)}…`;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
