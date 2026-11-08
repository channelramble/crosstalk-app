// `crosstalk-hub setup [--json]` against an in-memory hub (its facts stubbed: nothing of this machine is read), the hub
// not running, a socket a sandbox keeps it out of, a wrong key and an older hub; and who can reach the setup routes:
// the socket with the setup key, the hub's own port with the setup key for a request made on this machine, /api/setup
// with a person's device only, /setup.md from this machine only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupChecklist } from "@crosstalk/shared";
import { App } from "../src/app";
import { HUB_VERSION } from "../src/config";
import { startServer } from "../src/server";
import { setupKeyFor } from "../src/setup";
import { noWayIn } from "../src/setup/cli";

const MAIN = join(import.meta.dir, "../src/main.ts");
const dir = mkdtempSync(join(tmpdir(), "ct-setup-cli-"));
let app: App;
let server: ReturnType<typeof startServer>;
let base: string;
let key: string;

beforeAll(() => {
  app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: "https://mini.tail1.ts.net", workspaceRoot: dir, maxHopsDefault: 6 } });
  // What this machine would say, played: the test never looks at its real service, Tailscale or log.
  app.setup.probes = {
    service: async () => ({ runningUnder: "launchd", label: "com.crosstalk.hub", file: "/Users/me/Library/LaunchAgents/com.crosstalk.hub.plist", fileExists: true }),
    tailscale: async () => ({ cli: "tailscale", tried: ["cli"], from: "cli", state: "Running", dnsName: "mini.tail1.ts.net", certs: true, keyExpiry: null, serve: { target: null, funnel: false } }),
    staged: async () => null,
    idleRestart: () => null,
  };
  app.providers.list = () => [
    { provider: "claude", installed: true, version: "2.1.0", binPath: "/usr/local/bin/claude", signedIn: true, account: "person@example.com", plan: "Claude Max", authMethod: null, error: null, checkedAt: Date.now() },
    { provider: "codex", installed: true, version: "0.160.0", binPath: "/usr/local/bin/codex", signedIn: false, account: null, plan: null, authMethod: null, error: null, checkedAt: Date.now() },
  ];
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  key = setupKeyFor(app.internalSecret);
});

afterAll(async () => {
  server.stop(true);
  await app.engine.shutdown();
  app.store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI as a person or agent would, pointed at the test hub (never this Mac's service: a label that isn't there). */
async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", MAIN, "setup", ...args], {
    // Codex's sandbox variables only where a test sets them (these tests may run inside one).
    env: { ...process.env, CODEX_SANDBOX: "", CODEX_SANDBOX_NETWORK_DISABLED: "", CROSSTALK_HUB_SOCKET: app.internalSocket, CROSSTALK_SETUP_KEY: key, CROSSTALK_PORT: "9", CROSSTALK_HOST: "127.0.0.1", CROSSTALK_LABEL: "com.crosstalk.test-none", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

const item = (c: SetupChecklist, id: string) => c.items.find((i) => i.id === id);

test("setup --json is the running hub's checklist, as documented", async () => {
  const r = await cli(["--json"]);
  expect(r.code).toBe(0);
  const c = JSON.parse(r.out) as SetupChecklist;
  expect(c.schema).toBe(1);
  expect(c.hub).toMatchObject({ running: true, version: HUB_VERSION, url: "https://mini.tail1.ts.net", service: "launchd", update: null });
  expect(c.items.map((i) => i.id)).toEqual(["service", "version", "tailscale", "https", "public-url", "devices", "push", "agent.claude", "agent.codex", "services", "machines"]);
  expect(item(c, "service")?.state).toBe("done");
  expect(item(c, "https")).toMatchObject({ state: "missing", fix: { command: expect.stringContaining("tailscale serve --bg --https=443 http://127.0.0.1:") } });
  expect(item(c, "public-url")?.state).toBe("done");
  expect(item(c, "agent.codex")).toMatchObject({ state: "user", fix: { target: "agent-codex" } });
  expect(c.summary.total).toBe(c.summary.done + c.summary.missing + c.summary.user + c.summary.unknown);
  // The hub's own program adds the setup tools (under bun test, bun and the test file), with its data folder.
  expect(c.connect.claude).toMatch(/^claude mcp add --scope user crosstalk-setup -e CROSSTALK_HOME=\S+ -- \S+ \S+ setup-mcp$/);
  expect(c.connect.codex).toMatch(/^codex mcp add crosstalk-setup --env CROSSTALK_HOME=\S+ -- \S+ \S+ setup-mcp$/);
  // What a device gets is the same checklist.
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "iPhone"))!;
  const api = (await (await fetch(`${base}/api/setup`, { headers: { authorization: `Bearer ${device.token}` } })).json()) as SetupChecklist;
  expect(api.items.map((i) => [i.id, i.state])).toEqual(c.items.map((i) => [i.id, i.state]));
  app.auth.revoke(device.device.id);
});

test("setup prints it in words: marks, what to do with each command whole, and how to add an agent", async () => {
  const r = await cli([]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(new RegExp(`^Crosstalk setup on .+ \\(${HUB_VERSION.replace(/\./g, "\\.")}\\)\\n\\d+ of \\d+ done`));
  expect(r.out).toContain("✓ Runs as a service: Runs as a LaunchAgent (com.crosstalk.hub)");
  expect(r.out).toContain("! HTTPS address: tailscale serve is off");
  expect(r.out).toMatch(/\n {6}\$ tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:\d+\n/);
  expect(r.out).toContain("• Codex: Codex 0.160.0 is installed but not signed in.");
  expect(r.out).toContain("In the app: Settings → AI services → Codex → Sign in");
  expect(r.out).toContain("(asks for your password: run it yourself)");
  expect(r.out).toContain('Then tell it: "Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password."');
  // Nobody's email, though the hub knows the sign-in's.
  expect(r.out).not.toContain("person@example.com");
});

test("with no hub answering, it prints what it can tell by itself, and makes nothing in the data folder", async () => {
  const home = join(dir, "never-started");
  // No key given: it would be read from the hub's run folder, which isn't there.
  const r = await cli(["--json"], { CROSSTALK_HOME: home, CROSSTALK_HUB_SOCKET: "", CROSSTALK_SETUP_KEY: "" });
  expect(r.code).toBe(0);
  const c = JSON.parse(r.out) as SetupChecklist;
  expect(c.hub.running).toBe(false);
  expect(c.items.map((i) => i.id)).toEqual(["service", "version", "tailscale", "https", "public-url", "devices", "push", "agent.claude", "agent.codex"]);
  if (process.platform === "darwin") expect(item(c, "service")).toMatchObject({ state: "missing", detail: "Crosstalk isn't installed as a service here.", fix: { command: "./install-macos.sh" } });
  for (const i of c.items.slice(2)) expect(i).toMatchObject({ state: "unknown", detail: "Start Crosstalk first, then check again." });
  expect(existsSync(home)).toBe(false);
  // A socket left behind by a hub that stopped reads the same.
  const stale = await cli(["--json"], { CROSSTALK_HUB_SOCKET: join(dir, "gone.sock") });
  expect((JSON.parse(stale.out) as SetupChecklist).hub.running).toBe(false);
});

/** A socket nothing answers on (its server was killed before it could remove it): what a sandbox in the way looks like. */
let refusing = "";
async function refusingSocket(): Promise<string> {
  if (refusing) return refusing;
  const sock = join(dir, "refusing.sock");
  await Bun.spawn(["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, "SIGKILL"))`]).exited;
  expect(existsSync(sock)).toBe(true);
  refusing = sock;
  return sock;
}

/** No item may ever be told to use the setup tools: the tools print these same words when they're the ones shut out. */
const namesTheTools = (c: SetupChecklist) => /crosstalk-setup|MCP|setup tools/i.test(JSON.stringify(c.items));

test("with no way in at all, it names both ways tried and the one thing the person can do, never the tools the caller is", async () => {
  const sock = await refusingSocket();
  // Nothing here says the hub runs (its service isn't this machine's), so a socket that refuses reads as stopped.
  const stopped = JSON.parse((await cli(["--json"], { CROSSTALK_HUB_SOCKET: sock })).out) as SetupChecklist;
  expect(item(stopped, "devices")?.detail).toBe("Start Crosstalk first, then check again.");
  // Codex runs commands in its sandbox with CODEX_SANDBOX set (and there a live hub's socket refuses too). Port 9
  // (discard) stands in for a hub whose own address answers nothing either.
  const boxed = JSON.parse((await cli(["--json"], { CROSSTALK_HUB_SOCKET: sock, CODEX_SANDBOX: "seatbelt" })).out) as SetupChecklist;
  expect(item(boxed, "devices")?.detail).toBe("Crosstalk can't be reached from here: its socket (it refused the connection) and http://127.0.0.1:9 (nothing answered). Run this again in a terminal on this machine, outside the agent's sandbox.");
  expect(namesTheTools(boxed)).toBe(false);
  expect(namesTheTools(stopped)).toBe(false);
});

test("a sandbox that blocks the socket but allows localhost: the same checks, really checked", async () => {
  const port = String(server.port);
  // A socket that isn't there, and one that is but isn't this program's to open: both are the sandbox's doing.
  const missing = join(dir, "not-there.sock");
  const denied = join(dir, "denied.sock");
  const keep = Bun.serve({ unix: denied, fetch: () => new Response("no", { status: 500 }) } as unknown as Parameters<typeof Bun.serve>[0]);
  chmodSync(denied, 0o000);
  try {
    const [live, viaMissing, viaDenied] = await Promise.all([cli(["--json"]), cli(["--json"], { CROSSTALK_HUB_SOCKET: missing, CROSSTALK_PORT: port }), cli(["--json"], { CROSSTALK_HUB_SOCKET: denied, CROSSTALK_PORT: port })]);
    const asked = JSON.parse(live.out) as SetupChecklist;
    for (const [where, out] of [["no socket", viaMissing.out], ["socket denied", viaDenied.out]] as [string, string][]) {
      const c = JSON.parse(out) as SetupChecklist;
      expect([where, c.hub.running]).toEqual([where, true]);
      // Not one "unknown" with a reason: the real checklist, item for item, as over the socket.
      expect([where, c.items.map((i) => [i.id, i.state])]).toEqual([where, asked.items.map((i) => [i.id, i.state])]);
      expect([where, c.summary]).toEqual([where, asked.summary]);
      expect([where, item(c, "devices")?.detail]).toEqual([where, item(asked, "devices")?.detail]);
      expect([where, item(c, "service")?.state]).toEqual([where, "done"]);
    }
  } finally {
    chmodSync(denied, 0o600);
    void keep.stop(true);
  }
});

test("over the hub's own address, a key that isn't the hub's gets the same answer as over the socket", async () => {
  const wrong = { CROSSTALK_SETUP_KEY: "0".repeat(64) };
  const words = "Crosstalk didn't accept this program's setup key: check that CROSSTALK_HOME is the hub's.";
  const local = JSON.parse((await cli(["--json"], { ...wrong, CROSSTALK_HUB_SOCKET: join(dir, "not-there.sock"), CROSSTALK_PORT: String(server.port) })).out) as SetupChecklist;
  expect(item(local, "devices")?.detail).toBe(words);
  expect(item(local, "agent.claude")?.state).toBe("unknown");
});

test("without a settings file the hub's own address is never guessed, and nothing is made in the data folder", async () => {
  const home = join(dir, "no-config");
  const r = await cli(["--json"], { CROSSTALK_HOME: home, CROSSTALK_HUB_SOCKET: await refusingSocket(), CROSSTALK_PORT: "", CODEX_SANDBOX: "seatbelt" });
  const c = JSON.parse(r.out) as SetupChecklist;
  expect(item(c, "devices")?.detail).toBe(`Crosstalk can't be reached from here: its socket (it refused the connection) and its address on this machine (not known: no port in ${join(home, "config.json")}). Run this again in a terminal on this machine, outside the agent's sandbox.`);
  expect(existsSync(home)).toBe(false);
});

test("a sandbox that keeps this program from the setup key says that, not that the hub is gone", async () => {
  // Without the key there's nothing to send either way in: the one thing in the way is the file it's made from.
  const home = join(dir, "key-out-of-reach");
  mkdirSync(join(home, "run"), { recursive: true });
  const secret = join(home, "run", "internal-secret");
  writeFileSync(secret, app.internalSecret);
  chmodSync(secret, 0o000);
  try {
    const c = JSON.parse((await cli(["--json"], { CROSSTALK_HOME: home, CROSSTALK_HUB_SOCKET: "", CROSSTALK_SETUP_KEY: "" })).out) as SetupChecklist;
    expect(item(c, "devices")?.detail).toBe("Crosstalk can't be reached from here: its setup key (this program isn't allowed to read it). Run this again in a terminal on this machine, outside the agent's sandbox.");
    expect(namesTheTools(c)).toBe(false);
  } finally {
    chmodSync(secret, 0o600);
  }
});

/** A hub started from an earlier build: it answers /api/health as itself, and has no setup API on its port. */
const earlierBuild = (version: string) => Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/api/health" ? Response.json({ ok: true, version, name: "crosstalk" }) : new Response("not found", { status: 404 })) });

test("a hub that answers at its own address but has no setup API there: no build is claimed to be waiting, and no restart asked for", async () => {
  // Today's live hub: the same version as the program asking, started before the port knew the setup API. A 404 there
  // is that build having no route, which says nothing about what is installed at the hub's path.
  const hub = earlierBuild(HUB_VERSION);
  try {
    const c = JSON.parse((await cli(["--json"], { CROSSTALK_HUB_SOCKET: join(dir, "not-there.sock"), CROSSTALK_PORT: String(hub.port) })).out) as SetupChecklist;
    expect(c.hub.update).toBe(null);
    expect(item(c, "version")).toMatchObject({ state: "unknown", detail: `Crosstalk ${HUB_VERSION} is installed.`, fix: null });
    expect(JSON.stringify(c.items)).not.toMatch(/waits for a restart|starts at its next restart|kickstart/);
    // It answered for itself, so the hub runs, and the words say which way in did what.
    expect(c.hub.running).toBe(true);
    expect(item(c, "devices")?.detail).toBe(`Crosstalk can't be reached from here: its socket (it isn't there) and http://127.0.0.1:${hub.port} (it answers, but the build it runs has no setup API there). Run this again in a terminal on this machine, outside the agent's sandbox.`);
    expect(namesTheTools(c)).toBe(false);
  } finally {
    hub.stop(true);
  }
});

test("a hub at its own address that really is an older version says so, with the restart that fixes it", async () => {
  const hub = earlierBuild("0.5.1");
  try {
    const c = JSON.parse((await cli(["--json"], { CROSSTALK_HUB_SOCKET: join(dir, "not-there.sock"), CROSSTALK_PORT: String(hub.port) })).out) as SetupChecklist;
    expect(item(c, "version")).toMatchObject({ state: "missing", detail: `Crosstalk 0.5.1 runs. ${HUB_VERSION} is installed and starts at its next restart.` });
    expect(c.hub.update).toEqual({ version: HUB_VERSION, source: "staged" });
  } finally {
    hub.stop(true);
  }
});

test("the setup key never goes through a proxy variable the agent inherited: the local call is made straight to the hub", async () => {
  const seen: string[] = [];
  // What a proxy variable may point at: it answers as a Crosstalk hub, so a call made through it would be believed —
  // and would have handed over the setup key, which mints pairing codes, maybe off this machine.
  const proxy = Bun.serve({
    port: 0,
    fetch: (req) => {
      seen.push(`${req.method} ${req.url} key=${req.headers.get("x-crosstalk-setup") ?? "-"}`);
      return Response.json({ ok: true, name: "crosstalk", version: "9.9.9" });
    },
  });
  try {
    const at = `http://127.0.0.1:${proxy.port}`;
    const [asked, proxied] = await Promise.all([cli(["--json"]), cli(["--json"], { CROSSTALK_HUB_SOCKET: join(dir, "not-there.sock"), CROSSTALK_PORT: String(server.port), HTTP_PROXY: at, http_proxy: at, HTTPS_PROXY: at, ALL_PROXY: at })]);
    const c = JSON.parse(proxied.out) as SetupChecklist;
    // Nothing reached the proxy at all: not the health probe, not the call with the key.
    expect(seen).toEqual([]);
    expect(c.items.map((i) => [i.id, i.state])).toEqual((JSON.parse(asked.out) as SetupChecklist).items.map((i) => [i.id, i.state]));
    expect(c.hub.version).toBe(HUB_VERSION);
  } finally {
    proxy.stop(true);
  }
});

test("with no way in, a hub whose service runs is blocked, not stopped: the sandbox that sets nothing to know it by", async () => {
  const tried = [{ via: "socket" as const, address: join(dir, "hub.sock"), why: "it refused the connection" }];
  const boxed = process.env.CODEX_SANDBOX;
  delete process.env.CODEX_SANDBOX;
  try {
    // Claude Code's sandbox: the socket refuses as a stopped hub's would and nothing in the environment says sandbox,
    // so the service manager is what tells the two apart — for the checklist and for every tool alike.
    expect(await noWayIn("refused", tried, async () => true)).toEqual({ code: "blocked", tried });
    expect(await noWayIn("refused", tried, async () => false)).toEqual({ code: "stopped", detail: "refused", tried });
    // Nothing could be asked about the service: don't claim a hub is there.
    expect(await noWayIn("refused", tried, async () => null)).toEqual({ code: "stopped", detail: "refused", tried });
    // No socket at all, service or not: a hub running here would have made one (the service item says to check HOME).
    expect(await noWayIn("missing", tried, async () => true)).toEqual({ code: "stopped", detail: "missing", tried });
    // A socket this program isn't allowed to open is always something in the way: the hub made it as this same user.
    expect(await noWayIn("denied", tried, async () => false)).toEqual({ code: "blocked", tried });
    // Codex's sandbox says so itself, and then the service manager needn't be asked at all.
    process.env.CODEX_SANDBOX = "seatbelt";
    let asked = 0;
    expect(
      await noWayIn("refused", tried, async () => {
        asked++;
        return false;
      }),
    ).toEqual({ code: "blocked", tried });
    expect(asked).toBe(0);
  } finally {
    if (boxed === undefined) delete process.env.CODEX_SANDBOX;
    else process.env.CODEX_SANDBOX = boxed;
  }
});

test("a key that isn't the hub's gets nothing from it", async () => {
  const r = await cli(["--json"], { CROSSTALK_SETUP_KEY: "0".repeat(64) });
  const c = JSON.parse(r.out) as SetupChecklist;
  expect(item(c, "devices")?.detail).toBe("Crosstalk didn't accept this program's setup key: check that CROSSTALK_HOME is the hub's.");
  expect(c.items.some((i) => i.id === "agent.claude" && i.state !== "unknown")).toBe(false);
  // A member's key isn't the setup key either.
  const room = app.createRoom({ name: "Keys", mode: "direct" });
  const m = app.addMember(room.id, { provider: "mock", handle: "keys" });
  const asMember = await cli(["--json"], { CROSSTALK_SETUP_KEY: app.internalToken(m.id) });
  expect((JSON.parse(asMember.out) as SetupChecklist).items.find((i) => i.id === "devices")?.state).toBe("unknown");
  await app.deleteRoom(room.id);
});

test("an older hub (no setup API on its socket): its version from /api/health, and the new build at its next restart", async () => {
  const sock = join(dir, "older.sock");
  // As an older hub's socket answers anything without a member's key.
  const older = Bun.serve({ unix: sock, fetch: () => Response.json({ error: "forbidden" }, { status: 403 }) } as unknown as Parameters<typeof Bun.serve>[0]);
  const health = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api/health" ? Response.json({ ok: true, version: "0.4.0", name: "crosstalk" }) : new Response("no", { status: 404 })) });
  try {
    const r = await cli(["--json"], { CROSSTALK_HUB_SOCKET: sock, CROSSTALK_PORT: String(health.port) });
    const c = JSON.parse(r.out) as SetupChecklist;
    expect(c.hub).toMatchObject({ running: true, version: "0.4.0", update: { version: HUB_VERSION, source: "staged" } });
    expect(item(c, "version")).toMatchObject({ state: "missing", detail: `Crosstalk 0.4.0 runs. ${HUB_VERSION} is installed and starts at its next restart.` });
  } finally {
    void older.stop(true);
    void health.stop(true);
  }
});

test("the checklist is reused for a few seconds, but asked afresh after a fix, and again once an agent's status changes", async () => {
  let asked = 0;
  const service = app.setup.probes.service!;
  app.setup.probes.service = async () => (asked++, service());
  // Earlier tests' lists (the last may be under a second old) go: an agent's status changed.
  app.bus.emit({ t: "provider", status: app.providers.list()[0] });
  try {
    const first = app.setup.checklist({ fresh: true });
    // The web's own loads in quick succession share it, and so does a burst of fresh calls.
    expect(app.setup.checklist()).toBe(first);
    expect(app.setup.checklist({ fresh: true })).toBe(first);
    await first;
    await Bun.sleep(1100);
    expect(app.setup.checklist()).toBe(first);
    // An agent checking again after a fix gets a new one.
    const again = app.setup.checklist({ fresh: true });
    expect(again).not.toBe(first);
    await again;
    // A sign-in somewhere: the next one is new, even for the web.
    app.bus.emit({ t: "provider", status: app.providers.list()[0] });
    const afterSignIn = app.setup.checklist();
    expect(afterSignIn).not.toBe(again);
    await afterSignIn;
    expect(asked).toBe(3);
  } finally {
    app.setup.probes.service = service;
  }
});

test("a usage mistake exits 1; --help explains", async () => {
  const bad = await cli(["--jsno"]);
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("Usage: crosstalk-hub setup [--json]");
  const help = await cli(["--help"]);
  expect([help.code, help.out.startsWith("Usage: crosstalk-hub setup")]).toEqual([0, true]);
});

test("the setup API answers on the hub's socket, and on its port only to a request made on this machine, each with the setup key", async () => {
  const call = (headers: Record<string, string>) => fetch("http://crosstalk/internal/setup/status", { method: "POST", unix: app.internalSocket, headers: { "content-type": "application/json", ...headers }, body: "{}" } as RequestInit);
  const none = await call({});
  expect(none.status).toBe(403);
  expect(((await none.json()) as { code?: string }).code).toBe("setup_key");
  expect((await call({ "x-crosstalk-setup": key })).status).toBe(200);
  // Nothing proxies this socket: a request that went through a proxy is refused, key or not.
  for (const h of ["x-forwarded-for", "forwarded", "tailscale-user-login"]) expect([h, (await call({ "x-crosstalk-setup": key, [h]: "1" })).status]).toEqual([h, 403]);
  // The port answers the setup API too: that's the way left to a program whose sandbox blocks Unix sockets. It takes
  // the same key, and only a request made on this machine straight to the hub.
  const tcp = (headers: Record<string, string> = {}, path = "/internal/setup/status", method = "POST") => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: "{}" } : {}) });
  expect((await tcp({ "x-crosstalk-setup": key })).status).toBe(200);
  const noKey = await tcp();
  expect([noKey.status, ((await noKey.json()) as { code?: string }).code]).toEqual([403, "setup_key"]);
  // As tailscale serve hands a tailnet request on (its own headers, the tailnet name kept): nothing is there, key or not.
  for (const h of ["x-forwarded-for", "forwarded", "via", "x-real-ip", "tailscale-user-login"]) expect([h, (await tcp({ "x-crosstalk-setup": key, [h]: "1" })).status]).toEqual([h, 404]);
  expect((await tcp({ "x-crosstalk-setup": key, host: "mini.tail1.ts.net" })).status).toBe(404);
  // Only the setup API, and only POST: the agents' own internal API stays on the socket.
  expect((await tcp({ "x-crosstalk-setup": key }, "/internal/setup/status", "GET")).status).toBe(404);
  for (const path of ["/internal/members", "/internal/read", "/internal/xchat/list"]) expect([path, (await tcp({ "x-crosstalk-setup": key }, path)).status]).toEqual([path, 404]);
  // Nothing of it is readable from a web page: no CORS headers, whatever the origin.
  const cors = await tcp({ "x-crosstalk-setup": key, origin: "https://evil.example" });
  expect(cors.headers.get("access-control-allow-origin")).toBe(null);
});

test("/api/setup is for people's devices: none without a sign-in, none for another machine's hub", async () => {
  expect((await fetch(`${base}/api/setup`)).status).toBe(401);
  expect((await fetch(`${base}/api/setup/recheck`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${base}/api/setup/connect`, { method: "POST", body: '{"agent":"claude"}' })).status).toBe(401);
  const peer = (await app.auth.pair((await app.auth.createPairingCode(60_000, { scope: "peer", hubId: "h_other" })).code, "Other hub", "Crosstalk hub"))!;
  expect((await fetch(`${base}/api/setup`, { headers: { authorization: `Bearer ${peer.token}` } })).status).toBe(403);
  app.auth.revoke(peer.device.id);
});

test("another machine's hub signed in here is no person's device, even while its link is one-way", async () => {
  const count = async () => {
    const f = await app.setup.facts();
    return { names: f.devices!.map((d) => d.name), push: f.push! };
  };
  const before = await count();
  // How another hub links this one (machines.ts link()): a full sign-in, tied to that hub only once the link is two-way.
  const hub = (await app.auth.pair((await app.auth.createPairingCode()).code, "Mac mini (hub)", "Crosstalk hub"))!;
  const phone = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "iPhone"))!;
  app.push.subscribe(hub.device.id, "https://web.push.apple.com/a-hub-subscription");
  app.push.subscribe(phone.device.id, "https://web.push.apple.com/a-phone-subscription");
  try {
    const after = await count();
    expect(after.names).toEqual([...before.names, "Phone"]);
    expect(after.push).toMatchObject({ devices: before.push.devices + 1, apple: before.push.apple + 1 });
  } finally {
    app.auth.revoke(hub.device.id);
    app.auth.revoke(phone.device.id);
  }
});

test("Add for me runs the agent's own mcp add, user-wide, in a terminal: only for Claude Code or Codex, once installed", async () => {
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "iPhone"))!;
  const spawned: { argv: string[]; title: string }[] = [];
  const spawn = app.pty.spawn.bind(app.pty);
  app.pty.spawn = (argv, opts) => {
    spawned.push({ argv, title: opts.title });
    return { id: "pty_t", title: opts.title, command: argv.join(" "), purpose: opts.purpose, provider: opts.provider ?? null, alive: true, exitCode: null, createdAt: Date.now() };
  };
  const which = app.providers.which.bind(app.providers);
  app.providers.which = (p) => (p === "claude" ? "/usr/local/bin/claude" : null);
  const post = (agent: string) => fetch(`${base}/api/setup/connect`, { method: "POST", headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: JSON.stringify({ agent }) });
  try {
    const ok = await post("claude");
    expect(ok.status).toBe(200);
    expect(spawned[0].title).toBe("Add setup tools to Claude Code");
    expect(spawned[0].argv.slice(0, 6)).toEqual(["/usr/local/bin/claude", "mcp", "add", "--scope", "user", "crosstalk-setup"]);
    expect(spawned[0].argv.slice(-1)).toEqual(["setup-mcp"]);
    expect(spawned[0].argv).toContain("--");
    const missing = await post("codex");
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { error: string }).error).toContain("isn't installed");
    expect((await post("gemini")).status).toBe(400);
    expect(spawned).toHaveLength(1);
  } finally {
    app.pty.spawn = spawn;
    app.providers.which = which;
    app.auth.revoke(device.device.id);
  }
});

test("/setup.md is the guide, for requests made on this machine only", async () => {
  const direct = await fetch(`${base}/setup.md`);
  expect(direct.status).toBe(200);
  expect(direct.headers.get("content-type")).toContain("text/markdown");
  const text = await direct.text();
  expect(text).toContain("# Setting up Crosstalk: a guide for AI agents");
  expect(text).toContain("## Rules");
  // As tailscale serve hands it on: from 127.0.0.1, with the tailnet name kept and its headers added.
  for (const headers of [{ host: "mini.tail1.ts.net" }, { "x-forwarded-for": "100.100.1.2" }, { "x-forwarded-host": "mini.tail1.ts.net" }, { forwarded: "for=100.100.1.2" }, { "tailscale-user-login": "person@example.com" }] as Record<string, string>[]) {
    expect([headers, (await fetch(`${base}/setup.md`, { headers })).status]).toEqual([headers, 404]);
  }
  expect((await fetch(`${base}/setup.md`, { method: "POST" })).status).toBe(404);
});

/**
 * A hub that answers at its own address and then stops in the middle of an answer: /api/health comes back whole (so
 * the setup key may be sent there), and the setup call gets its headers and the first bytes of the checklist before the
 * connection goes. That is what a restart landing in that window looks like — and the version and service items are
 * what ask for restarts.
 */
async function diesMidAnswer(version: string) {
  const { createServer } = await import("node:net");
  const open: import("node:net").Socket[] = [];
  const server = createServer((sock) => {
    open.push(sock);
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      const head = buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      // The whole request, body included: a server that answered early would make the client fail writing it, which is
      // not what this is about.
      const length = Number(/content-length:\s*(\d+)/i.exec(buf.slice(0, head))?.[1] ?? 0);
      if (buf.length < head + 4 + length) return;
      if (buf.startsWith("GET /api/health")) {
        const body = JSON.stringify({ ok: true, version, name: "crosstalk" });
        sock.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        return;
      }
      buf = "";
      sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 4096\r\nconnection: close\r\n\r\n{"schema":1,"checkedAt":');
      setTimeout(() => sock.end(), 20);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as { port: number }).port,
    stop: () => {
      for (const s of open) s.destroy();
      server.close();
    },
  };
}

/**
 * EXPECTED TO FAIL on today's code. hub/src/setup/cli.ts `localJson` listens for `end` on the answer and `error` on the
 * request, and its only clock is `req.setTimeout` — a socket inactivity timer, which cannot fire once the socket is
 * gone. So an answer that starts and never finishes leaves that promise pending for ever (measured on Bun 1.4.2, with
 * both a clean close and a reset, with content-length and chunked): `crosstalk-hub setup` prints nothing and never
 * exits, and a setup tool call never comes back. The socket way in cannot do this — `sendSocket` uses
 * `AbortSignal.timeout`, an absolute deadline — so this is the fallback's own hole, in the one place it is the only way
 * in (a sandbox that blocks the socket).
 *
 * A premature close has to be noticed, not waited out: a person in a terminal is looking at nothing, so the 60-second
 * deadline the call carries is not an answer either. The budget below is generous for anything that notices it.
 */
test("a hub that stops in the middle of its answer: the command comes back instead of hanging for ever", async () => {
  const hub = await diesMidAnswer(HUB_VERSION);
  try {
    const proc = Bun.spawn(["bun", MAIN, "setup", "--json"], {
      env: { ...process.env, CODEX_SANDBOX: "", CODEX_SANDBOX_NETWORK_DISABLED: "", CROSSTALK_HUB_SOCKET: join(dir, "not-there.sock"), CROSSTALK_SETUP_KEY: key, CROSSTALK_PORT: String(hub.port), CROSSTALK_HOST: "127.0.0.1", CROSSTALK_LABEL: "com.crosstalk.test-none" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const ended = await Promise.race([proc.exited, new Promise<"never">((done) => setTimeout(() => done("never"), 12_000))]);
    if (ended === "never") proc.kill();
    expect(ended, "setup must not hang when the hub's answer is cut short").not.toBe("never");
    const c = JSON.parse(await new Response(proc.stdout).text()) as SetupChecklist;
    // Something went wrong mid-answer: say so and let the person check again. Never "start Crosstalk first" — it ran.
    expect(item(c, "devices")?.detail).toContain("Check again in a minute.");
    expect(namesTheTools(c)).toBe(false);
  } finally {
    hub.stop();
  }
}, 30_000);
