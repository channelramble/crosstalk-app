// Agent-assisted setup (docs/SETUP-FOR-AGENTS.md): what's left to set up on this machine, for the person (Settings →
// Set up with an AI agent, `crosstalk-hub setup`) and for an agent already on the machine (`setup --json`, the
// setup-mcp tools, /setup.md). Agents reach it on the hub's Unix socket with the setup key, the way the agents' own
// MCP helpers reach it with theirs, so only this user's programs on this machine can; a sandbox that blocks that socket
// reaches the same API on the hub's own port, where it answers only a request made on this machine straight to the hub
// (directLocal below) and only with that key. Nothing answers to another machine without a device sign-in, and nothing
// here hands out a credential: steps that need a password, a sign-in or a system setting come back as the exact step
// for the person.

import { createHmac, timingSafeEqual } from "node:crypto";
import { arch as osArch, homedir, platform as osPlatform, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { PROVIDER_INFO, type Device, type PtyInfo, type ServiceTestResult, type SetupChecklist } from "@crosstalk/shared";
import type { App } from "../app";
import { pairingCodeHash } from "../auth";
import { HOME, HUB_VERSION } from "../config";
import { HttpError } from "../engine/engine";
import { json, route, type Route } from "../routes";
import { logger } from "../util/log";
import type { McpAgent } from "../browseros";
import { pairingUrl, setupChecklist, sh, type SetupFacts } from "./checklist";
import { redactLog, type SetupProbes } from "./system";
// The guide for agents, kept in the repo and served as is at /setup.md (on this machine only).
import GUIDE from "../../../docs/SETUP-FOR-AGENTS.md" with { type: "text" };

export { GUIDE as SETUP_GUIDE };

const log = logger("setup");

/** Agents may ask in a loop: a checklist is reused this long (it runs a few commands). */
const CACHE_MS = 5000;
/** Codes made by setup agents that may wait unused at once. */
const MAX_CODES = 2;

/** The setup tools' key for the hub's socket: made from the hub's internal secret, never equal to a member's key. */
export function setupKeyFor(secret: string): string {
  return createHmac("sha256", secret).update("\0setup").digest("hex");
}

export class Setup {
  private cache: { at: number; job: Promise<SetupChecklist> } | null = null;
  /** Pairing codes setup agents made: how many still wait unused. */
  private codes: { hash: string; expiresAt: number }[] = [];
  private readonly key: string;

  /** `self`: the argv that runs this program (the hub's binary, or bun with main.ts). */
  constructor(
    private readonly app: App,
    private readonly self: string[],
    public probes: SetupProbes = {},
  ) {
    this.key = setupKeyFor(app.internalSecret);
    // A sign-in, an install, a dialog on the Mac or the pool changing: the next list is worked out afresh.
    app.bus.on((e) => {
      if (e.t === "provider" || e.t === "account" || e.t === "macDialogs" || e.t === "pool") this.cache = null;
    });
  }

  /** Whether `token` is the setup key (compared in constant time). */
  checkKey(token: string): boolean {
    const want = Buffer.from(this.key);
    const got = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * The checklist, reused for a few seconds. `fresh` (the CLI and the setup tools: an agent checks again right after a
   * fix) reuses only one started in the last second, so a burst of calls still makes one.
   */
  checklist(opts: { fresh?: boolean } = {}): Promise<SetupChecklist> {
    if (this.cache && Date.now() - this.cache.at < (opts.fresh ? 1000 : CACHE_MS)) return this.cache.job;
    const job = this.facts().then(setupChecklist);
    this.cache = { at: Date.now(), job };
    job.catch(() => {
      if (this.cache?.job === job) this.cache = null;
    });
    return job;
  }

  /** Everything the checklist needs, each part asked in parallel with its own time limit (a slow one reads as unknown). */
  async facts(): Promise<SetupFacts> {
    const app = this.app;
    const p = this.probes;
    const machines = app.machines.list();
    const url = app.config.publicUrl?.replace(/\/+$/, "") ?? "";
    // Only the agents installed here get a BrowserOS command, so nobody is handed one for a CLI they haven't got.
    const mcpAgents = app.providers
      .list()
      .filter((s) => s.installed && (s.provider === "claude" || s.provider === "codex" || s.provider === "gemini"))
      .map((s) => s.provider as McpAgent);
    const [service, tailscale, https, mac, staged, local, versions, browseros] = await Promise.all([
      p.service ? within(p.service(), 6000) : null,
      p.tailscale ? within(p.tailscale(), 8000) : undefined,
      // Its own https address, asked of itself: what the hub can still say when Tailscale can't be asked.
      p.https && /^https:\/\//.test(url) ? within(p.https(url), 8000) : undefined,
      p.mac ? within(p.mac(), 10_000) : undefined,
      p.staged ? within(p.staged(), 6000) : null,
      within(app.services.localServers(), 3000),
      Promise.all(machines.map((m) => (p.hubVersion ? within(p.hubVersion(m.url), 4000) : null))),
      // GitHub can be slow: longer than the others, still short enough that the checklist never waits on it (a probe
      // that times out reads as "couldn't check", which the item says in plain words). The probe's own worst case fits
      // inside this: it reads the bundle, then asks GitHub and the browser's own port at the same time, and both of
      // those answers are kept (six hours for the releases, ten minutes for the address), so a cold one is rare.
      p.browseros ? within(p.browseros(mcpAgents), 15_000) : undefined,
    ]);
    const pool = app.pool.view();
    return {
      now: Date.now(),
      hub: {
        running: true,
        version: HUB_VERSION,
        name: app.machineName(),
        platform: osPlatform(),
        arch: osArch(),
        port: app.config.port,
        publicUrl: app.config.publicUrl,
        // The environment wins over config.json (config.ts), so a fix has to go where it's set.
        publicUrlFrom: process.env.CROSSTALK_PUBLIC_URL ? "env" : app.config.publicUrl ? "config" : null,
        binary: this.self.map(sh).join(" "),
        home: HOME,
        defaultHome: HOME === resolve(join(homedir(), ".crosstalk")),
        user: userInfo().username,
      },
      offline: null,
      service: service ?? null,
      staged: staged ?? null,
      idleRestart: p.idleRestart?.() ?? null,
      tailscale,
      https: p.https && /^https:\/\//.test(url) ? (https ?? null) : undefined,
      // A probe that failed or took too long: couldn't check.
      mac: p.mac ? (mac ?? null) : undefined,
      devices: app.store.listDevices().filter(personal).map((d) => ({ name: d.name, platform: d.platform })),
      push: app.push.summary(),
      providers: app.providers.list().filter((s) => s.provider !== "mock"),
      accounts: app.providers.accounts(),
      localServers: local ? local.servers.map((s) => ({ label: s.label, used: s.accountIds.length > 0 })) : null,
      machines,
      machineVersions: Object.fromEntries(machines.map((m, i) => [m.id, versions[i] ?? null])),
      browseros: p.browseros ? (browseros ?? null) : undefined,
      pool: { configured: !!pool.config.model, state: pool.status.state, detail: pool.status.detail, alias: pool.config.alias, machines: pool.config.machines.filter((m) => m.enabled).length },
    };
  }

  /** Agents were checked again (installed, signed in): the checklist with that. */
  async recheckAgents(): Promise<SetupChecklist> {
    await this.app.providers.refreshAll();
    return this.checklist({ fresh: true });
  }

  /**
   * A one-time code that pairs a person's device, for a setup agent to hand the person. Short-lived, at most two unused
   * at once, logged, and every paired phone is told: an agent that's been misled could otherwise pair a device itself.
   */
  async pairCode(minutes: unknown): Promise<{ code: string; expiresAt: number; minutes: number; url: string | null; localUrl: string }> {
    const m = Math.max(5, Math.min(60, Math.round(Number(minutes ?? 15)) || 15));
    // Where the phone opens it, asked now (an agent may just have set up tailscale serve). Null: nowhere a phone can
    // reach yet. Asked before the count below, so two calls at once can't both pass it while this runs.
    const tailscale = this.probes.tailscale ? await within(this.probes.tailscale(), 8000) : undefined;
    const url = pairingUrl({ hub: { publicUrl: this.app.config.publicUrl, port: this.app.config.port }, tailscale });
    const now = Date.now();
    const used = (hash: string) => !!(this.app.store.db.query("SELECT used_at FROM pairing_codes WHERE code_hash = ?").get(hash) as { used_at: number | null } | null)?.used_at;
    this.codes = this.codes.filter((c) => c.expiresAt > now && !used(c.hash));
    if (this.codes.length >= MAX_CODES) throw new HttpError(429, `Setup agents made ${MAX_CODES} codes that are still unused. Have the person type one of those, or wait until they expire.`, "too_many_codes");
    const { code, expiresAt } = await this.app.auth.createPairingCode(m * 60_000);
    this.codes.push({ hash: await pairingCodeHash(code), expiresAt });
    const machine = this.app.machineName();
    log.info(`a setup agent made a pairing code, valid ${m} minutes`);
    void this.app.push.send({ title: "Crosstalk", body: `A setup agent on ${machine} made a code to pair a device, valid ${m} minutes. If nobody asked for one, check Settings → Devices.`, url: "./#/settings/devices", tag: "setup-pair-code" });
    return { code, expiresAt, minutes: m, url, localUrl: `http://127.0.0.1:${this.app.config.port}` };
  }

  /** An AI service checked with free requests (services.ts). No key comes from the agent: a saved one is used by its account's id, inside the hub. */
  testService(b: { address?: unknown; agent?: unknown; account?: unknown }): Promise<ServiceTestResult> {
    const address = String(b.address ?? "").trim();
    if (!address) throw new HttpError(400, "Give the service's address, like http://127.0.0.1:11434.");
    const provider = b.agent === "claude" || b.agent === "codex" ? b.agent : undefined;
    return this.app.services.test({ baseUrl: address, provider, accountId: typeof b.account === "string" && b.account ? b.account : undefined });
  }

  /** The newest lines of the hub's log, with codes, keys and tokens hidden. */
  async log(lines: unknown): Promise<string[]> {
    const n = Math.max(1, Math.min(200, Math.round(Number(lines ?? 50)) || 50));
    if (!this.probes.log) throw new HttpError(404, "This hub keeps no log file to read.", "no_log");
    const got = await within(this.probes.log(n), 6000);
    if (!got) throw new HttpError(404, "Couldn't read the hub's log.", "no_log");
    return redactLog(got.slice(-n));
  }

  /**
   * "Add for me" in Settings: the agent's own `mcp add` for the setup tools, user-wide, in a terminal on the hub. A fixed
   * command: nothing typed goes into it.
   */
  connect(agent: unknown): PtyInfo {
    if (agent !== "claude" && agent !== "codex") throw new HttpError(400, "Add the setup tools to which agent? claude or codex.");
    const name = PROVIDER_INFO[agent].name;
    const bin = this.app.providers.which(agent);
    if (!bin) throw new HttpError(409, `${name} isn't installed on ${this.app.machineName()}. Install it first, under AI services.`, "not_installed");
    const home = HOME === resolve(join(homedir(), ".crosstalk")) ? [] : [agent === "claude" ? "-e" : "--env", `CROSSTALK_HOME=${HOME}`];
    const argv = agent === "claude" ? [bin, "mcp", "add", "--scope", "user", "crosstalk-setup", ...home, "--", ...this.self, "setup-mcp"] : [bin, "mcp", "add", "crosstalk-setup", ...home, "--", ...this.self, "setup-mcp"];
    log.info(`adding the setup tools to ${name}`);
    return this.app.pty.spawn(argv, { title: `Add setup tools to ${name}`, purpose: "install", provider: agent, cwd: homedir(), env: this.app.providers.agentEnv() });
  }
}

/**
 * A person's device, not another machine's hub: neither a peer sign-in nor one tied to a link, nor the full sign-in a
 * hub makes when it links this one (platform "Crosstalk hub", as Settings → Devices tells them), which stays untied
 * while the link is one-way.
 */
const personal = (d: Device) => d.scope !== "peer" && !d.hubId && d.platform !== "Crosstalk hub";

/** A promise's value, or undefined when it fails or takes longer than `ms`. */
function within<T>(job: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(undefined), ms);
    job.then(
      (v) => {
        clearTimeout(timer);
        done(v);
      },
      () => {
        clearTimeout(timer);
        done(undefined);
      },
    );
  });
}

// ---- who may ask ----

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Headers proxies add: `tailscale serve` hands every tailnet request to 127.0.0.1 with its Host kept and these set. */
const PROXIED = /^(x-forwarded-.*|forwarded|via|x-real-ip|tailscale-.*)$/i;

const proxied = (req: Request) => [...req.headers.keys()].some((h) => PROXIED.test(h));

/**
 * A request made on this machine, straight to the hub: from a loopback address, to a loopback name, and through no
 * proxy. A request over `tailscale serve` also comes from 127.0.0.1, so the address alone proves nothing.
 */
export function directLocal(req: Request, ip: string | null): boolean {
  if (!ip || !LOOPBACK.has(ip) || proxied(req)) return false;
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/** GET /setup.md: the guide for agents, to requests made on this machine only (anything else finds nothing there). */
export function setupGuideResponse(req: Request, ip: string | null): Response {
  if (req.method !== "GET" || !directLocal(req, ip)) return new Response("not found", { status: 404 });
  return new Response(GUIDE, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** One item's part of the guide: its "## <id>" section. */
export function guideSection(id: string, doc: string = GUIDE): string | null {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${id}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n").trim();
}

// ---- routes ----

/** For people's devices (route(): never another machine's sign-in). */
export function setupRoutes(app: App): Route[] {
  return [
    route("GET", "/api/setup", ({ url }) => app.setup.checklist({ fresh: url.searchParams.get("fresh") === "1" })),
    route("POST", "/api/setup/recheck", () => app.setup.recheckAgents()),
    route("POST", "/api/setup/connect", async ({ body }) => app.setup.connect(((await body().catch(() => null)) as { agent?: unknown } | null)?.agent)),
  ];
}

/**
 * The setup tools' calls, each with the setup key: on the hub's Unix socket (internal-server.ts), and on the hub's port
 * for a request made on this machine straight to it (server.ts checks that with `directLocal` before this is reached).
 */
export async function handleSetupInternal(app: App, req: Request, url: URL): Promise<Response> {
  // Nothing is meant to proxy either way in: a request that went through one is refused, key or not (on the port
  // server.ts has already turned such a request away; this is the socket's own check, and the port's second).
  if (proxied(req)) return json({ error: "forbidden" }, 403);
  if (!app.setup.checkKey(req.headers.get("x-crosstalk-setup") ?? "")) return json({ error: "This isn't the setup key of the Crosstalk running here.", code: "setup_key" }, 403);
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  try {
    switch (url.pathname) {
      case "/internal/setup/status":
        return json(await app.setup.checklist({ fresh: body.fresh === true }));
      case "/internal/setup/recheck":
        return json(await app.setup.recheckAgents());
      case "/internal/setup/pair-code":
        return json(await app.setup.pairCode(body.minutes));
      case "/internal/setup/test-service":
        return json(await app.setup.testService(body));
      case "/internal/setup/log":
        return json({ lines: await app.setup.log(body.lines) });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
