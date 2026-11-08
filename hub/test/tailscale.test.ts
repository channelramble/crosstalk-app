// The one way the hub asks Tailscale about itself (hub/src/tailscale.ts): the CLI with the shell hint the macOS app's
// own binary needs, that app's local API as the fallback, output that isn't JSON never taken for an answer, and the
// app's proof token kept out of everything the hub returns or logs. Nothing here reads /Library or this machine's own
// Tailscale: the CLI is a fake, the local API a stand-in server, and its folder a temporary one.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appPort, askTailscale, jsonObject, runTailscaleCli, selfTailscaleIPv4 } from "../src/tailscale";
import { httpsAnswers, parseServeStatus, parseTailscaleStatus, tailscaleFacts } from "../src/setup/system";

const FAKE_CLI = join(import.meta.dir, "fixtures", "fake-tailscale-app");
const PROBE = join(import.meta.dir, "fixtures", "tailscale-probe.ts");
const dirs: string[] = [];
const dir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `ct-ts-${name}-`));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** As Tailscale answers about this machine; `tailscale status --json --self --peers=false` and the local API agree. */
const STATUS = {
  BackendState: "Running",
  CertDomains: ["mini.tail1.ts.net"],
  Self: { DNSName: "mini.tail1.ts.net.", KeyExpiry: null, TailscaleIPs: ["100.64.0.9", "fd7a:115c:a1e0::9"] },
};
/** The serve configuration that sends https to this hub, and one that sends it somewhere else. */
const SERVES_HUB = { TCP: { "443": { HTTPS: true } }, Web: { "mini.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7420" } } } } };
const SERVES_ELSE = { TCP: { "443": { HTTPS: true } }, Web: { "mini.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } }, AllowFunnel: { "mini.tail1.ts.net:443": true } };

/**
 * A fake CLI on disk, with the files it answers from. The fixture is copied with this bun as its shebang: it must be
 * bun rather than a shell, because a shell would set SHLVL itself and the fake is there to show what happens without
 * one. Returns the fake's path, the environment to put it in, and its log of runs.
 */
function fakeCli(opts: { status?: unknown; serve?: unknown; gui?: boolean; ip4?: string } = {}) {
  const d = dir("cli");
  const bin = join(d, "tailscale");
  writeFileSync(bin, readFileSync(FAKE_CLI, "utf8").replace(/^#!.*\n/, `#!${process.execPath}\n`), { mode: 0o755 });
  const env: Record<string, string> = { FAKE_TS_LOG: join(d, "runs.log") };
  if (opts.status !== undefined) {
    writeFileSync(join(d, "status.json"), JSON.stringify(opts.status));
    env.FAKE_TS_STATUS = join(d, "status.json");
  }
  if (opts.serve !== undefined) {
    writeFileSync(join(d, "serve.json"), JSON.stringify(opts.serve));
    env.FAKE_TS_SERVE = join(d, "serve.json");
  }
  if (opts.gui) env.FAKE_TS_GUI = "1";
  if (opts.ip4) env.FAKE_TS_IP4 = opts.ip4;
  const log = join(d, "runs.log");
  return { bin, env, runs: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []) };
}

/**
 * Puts the fake's own variables in this process's environment for one test, and puts back what was there afterwards:
 * the preloaded CROSSTALK_TAILSCALE_* (hub/test/preload.ts) must survive, or a later test file would find this Mac's
 * real Tailscale and read /Library.
 */
const saved = new Map<string, string | undefined>();
function withEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

/**
 * The macOS app's local API, as a stand-in: a server on 127.0.0.1 whose port is the `ipnport` symlink's target and
 * whose password is the proof file's token, with every request's Host and Authorization kept for the test to check.
 */
function fakeApp(opts: { status?: unknown; serve?: unknown; token?: string } = {}) {
  const d = dir("app");
  const token = opts.token ?? "s3cret-proof-token-xyz";
  const seen: { path: string; host: string | null; auth: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: `${url.pathname}${url.search}`, host: req.headers.get("host"), auth: req.headers.get("authorization") });
      const auth = req.headers.get("authorization");
      // As tailscaled refuses an unauthenticated read: 401, naming itself in a header (hub/src/tailscale.ts checks
      // this before any token is sent).
      if (!auth) return new Response("auth required", { status: 401, headers: { "Tailscale-Version": "1.102.4-t3caf7d9e7" } });
      if (auth !== `Basic ${btoa(`:${token}`)}`) return new Response("bad password", { status: 403 });
      if (url.pathname === "/localapi/v0/status") return Response.json(opts.status ?? STATUS);
      if (url.pathname === "/localapi/v0/serve-config") return opts.serve === undefined ? new Response("") : Response.json(opts.serve);
      return new Response("not found", { status: 404 });
    },
  });
  // The port lives in a symlink's target, the way the real one does.
  symlinkSync(String(server.port), join(d, "ipnport"));
  writeFileSync(join(d, `sameuserproof-${server.port}`), `${token}\n`, { mode: 0o640 });
  return { dir: d, token, seen, port: server.port, stop: () => server.stop(true) };
}

test("the CLI answers: this machine's status and where serve sends https, asked about this machine only", async () => {
  const cli = fakeCli({ status: STATUS, serve: SERVES_HUB });
  withEnv({ ...cli.env, CROSSTALK_TAILSCALE_BIN: cli.bin });
  const a = await askTailscale({ serve: true }, { appDir: join(dir("none"), "nothing") });
  expect({ cli: a.cli, tried: a.tried, from: a.from }).toEqual({ cli: cli.bin, tried: ["cli"], from: "cli" });
  expect(parseTailscaleStatus(a.status)).toEqual({ state: "Running", dnsName: "mini.tail1.ts.net", certs: true, keyExpiry: null });
  expect(parseServeStatus(a.serve, "mini.tail1.ts.net")).toEqual({ target: "http://127.0.0.1:7420", funnel: false });
  expect(selfTailscaleIPv4(a.status)).toBe("100.64.0.9");
  // No peers unless they're asked for: nothing about the tailnet is read when only this machine is the question.
  // (Both questions go at once, so the log's order isn't the asking order.)
  expect(cli.runs().sort()).toEqual(["serve status --json shlvl=yes", "status --json --self --peers=false shlvl=yes"]);
  const peers = await askTailscale({ peers: true }, { appDir: "/nonexistent" });
  expect(peers.from).toBe("cli");
  expect(cli.runs().at(-1)).toBe("status --json shlvl=yes");
});

test("the shell hint reaches the CLI, so the macOS app's own binary answers instead of trying to open the GUI", async () => {
  const cli = fakeCli({ status: STATUS });
  const had = process.env.SHLVL;
  delete process.env.SHLVL;
  try {
    withEnv({ ...cli.env, CROSSTALK_TAILSCALE_BIN: cli.bin });
    // The hub is a LaunchAgent: no SHLVL of its own, and the fake behaves as the real binary does without one.
    const bare = Bun.spawn([cli.bin, "status", "--json"], { env: { ...process.env } as Record<string, string>, stdout: "pipe", stderr: "ignore" });
    expect(await new Response(bare.stdout).text()).toContain("The Tailscale GUI failed to start");
    expect(await bare.exited).toBe(0);
    // Through the hub's runner it answers, and says it was given the hint.
    const r = await runTailscaleCli(cli.bin, ["status", "--json"]);
    expect(jsonObject(r?.out)).toMatchObject({ BackendState: "Running" });
    expect(cli.runs().at(-1)).toBe("status --json shlvl=yes");
    expect((await askTailscale({}, { appDir: "/nonexistent" })).from).toBe("cli");
  } finally {
    if (had !== undefined) process.env.SHLVL = had;
  }
});

test("the GUI error on stdout with exit 0 is never an answer: the app's own API answers instead", async () => {
  const cli = fakeCli({ status: STATUS, serve: SERVES_HUB, gui: true });
  const app = fakeApp({ serve: SERVES_HUB });
  try {
    withEnv({ ...cli.env, CROSSTALK_TAILSCALE_BIN: cli.bin });
    const a = await askTailscale({ serve: true }, { appDir: app.dir });
    // The CLI is still the command the fixes name, even when only the app's API could answer.
    expect({ cli: a.cli, tried: a.tried, from: a.from }).toEqual({ cli: cli.bin, tried: ["cli", "app"], from: "app" });
    expect(parseTailscaleStatus(a.status)).toMatchObject({ state: "Running", dnsName: "mini.tail1.ts.net", certs: true });
    expect(parseServeStatus(a.serve, "mini.tail1.ts.net")).toEqual({ target: "http://127.0.0.1:7420", funnel: false });
    // Asked the documented way: the socket's name as Host, the token as an HTTP Basic password with no user — and
    // before any of that, one read with no credential at all, to see that tailscaled is what listens there.
    expect(app.seen.map((s) => s.path)).toEqual(["/localapi/v0/status?peers=false", "/localapi/v0/status?peers=false", "/localapi/v0/serve-config"]);
    expect(app.seen.every((s) => s.host === "local-tailscaled.sock")).toBe(true);
    expect(app.seen.map((s) => s.auth)).toEqual([null, `Basic ${btoa(`:${app.token}`)}`, `Basic ${btoa(`:${app.token}`)}`]);
  } finally {
    app.stop();
  }
});

test("the app's API answers with no CLI on the machine at all, and nothing at all answers without either", async () => {
  const app = fakeApp({ serve: SERVES_ELSE });
  try {
    withEnv({ CROSSTALK_TAILSCALE_BIN: "/nonexistent/tailscale" });
    const a = await askTailscale({ serve: true }, { appDir: app.dir });
    expect({ cli: a.cli, tried: a.tried, from: a.from }).toEqual({ cli: null, tried: ["app"], from: "app" });
    // A serve configuration that sends https somewhere else, with Funnel on: both read the same from either way in.
    expect(parseServeStatus(a.serve, "mini.tail1.ts.net")).toEqual({ target: "http://127.0.0.1:3000", funnel: true });
    const none = await askTailscale({ serve: true }, { appDir: join(a.cli ?? app.dir, "nope") });
    expect(none).toEqual({ cli: null, tried: [], from: null, status: null, serve: null });
  } finally {
    app.stop();
  }
});

test("a proof file that isn't the server's, or none at all, gets no answer and no second try", async () => {
  const app = fakeApp({ token: "the-real-token" });
  const wrong = dir("wrong");
  symlinkSync(String(app.port), join(wrong, "ipnport"));
  writeFileSync(join(wrong, `sameuserproof-${app.port}`), "not-the-right-token\n", { mode: 0o640 });
  const noProof = dir("noproof");
  symlinkSync(String(app.port), join(noProof, "ipnport"));
  try {
    withEnv({ CROSSTALK_TAILSCALE_BIN: "/nonexistent/tailscale" });
    expect((await askTailscale({}, { appDir: wrong })).status).toBeNull();
    expect(app.seen.at(-1)?.auth).toBe(`Basic ${btoa(":not-the-right-token")}`);
    // No proof file: nothing is sent at all, so an unauthenticated read never happens.
    const before = app.seen.length;
    const r = await askTailscale({}, { appDir: noProof });
    expect([r.tried, r.status, app.seen.length]).toEqual([["app"], null, before]);
  } finally {
    app.stop();
  }
});

test("a listener that isn't tailscaled never gets the proof token, whatever it answers", async () => {
  // ipnport's number is an ordinary ephemeral port and the pair in /Library outlives the daemon, so when tailscaled is
  // down — the very case this way in is for — any local program can be what listens there.
  const strays: { stop: () => void }[] = [];
  const stray = (answer: (path: string) => Response) => {
    const d = dir("stray");
    const seen: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(req.headers.get("authorization"));
        return answer(new URL(req.url).pathname);
      },
    });
    strays.push({ stop: () => server.stop(true) });
    symlinkSync(String(server.port), join(d, "ipnport"));
    writeFileSync(join(d, `sameuserproof-${server.port}`), "proof-token-for-tailscaled\n", { mode: 0o640 });
    return { dir: d, seen };
  };
  // A dev server that answers everything; one that happens to want HTTP Basic too, but isn't Tailscale; and one that
  // refuses the way tailscaled does, which is the only one the token may go to.
  const open = stray(() => Response.json({ hello: "a dev server" }));
  const locked = stray(() => new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Basic" } }));
  const real = stray((path) => (path === "/localapi/v0/status" ? new Response("auth required", { status: 401, headers: { "Tailscale-Version": "1.102.4" } }) : new Response("nope", { status: 403 })));
  try {
    withEnv({ CROSSTALK_TAILSCALE_BIN: "/nonexistent/tailscale" });
    for (const s of [open, locked]) {
      const a = await askTailscale({ serve: true }, { appDir: s.dir });
      expect([a.tried, a.from, a.status, a.serve]).toEqual([["app"], null, null, null]);
      // It was asked once, with nothing to lose: no Authorization header ever reached it.
      expect(s.seen).toEqual([null]);
    }
    // The one that refuses like tailscaled is asked again, with the token (it answers nothing useful here).
    expect((await askTailscale({}, { appDir: real.dir })).status).toBeNull();
    expect(real.seen).toEqual([null, `Basic ${btoa(":proof-token-for-tailscaled")}`]);
  } finally {
    strays.forEach((s) => s.stop());
  }
});

test("the port comes from ipnport, whether that's a symlink or a plain file, and only when it's a port", () => {
  const sym = dir("port-sym");
  symlinkSync("49177", join(sym, "ipnport"));
  expect(appPort(sym)).toBe(49177);
  const plain = dir("port-file");
  writeFileSync(join(plain, "ipnport"), "51234\n");
  expect(appPort(plain)).toBe(51234);
  const junk = dir("port-junk");
  writeFileSync(join(junk, "ipnport"), "not a port\n");
  expect(appPort(junk)).toBeNull();
  const big = dir("port-big");
  writeFileSync(join(big, "ipnport"), "99999\n");
  expect(appPort(big)).toBeNull();
  expect(appPort(join(sym, "nothing-here"))).toBeNull();
});

test("nothing but a JSON object counts as an answer, whatever the exit code said", () => {
  expect(jsonObject('{"BackendState":"Running"}')).toEqual({ BackendState: "Running" });
  for (const text of ["The Tailscale GUI failed to start: The operation couldn't be completed. (Tailscale.CLIError error 3.)", "", "   ", "null", "[1,2]", "7", '"Running"', "{broken", undefined, null]) {
    expect([text, jsonObject(text)]).toEqual([text, null]);
  }
  // The serve configuration alone may be empty: a Tailscale with nothing served prints nothing.
  expect(jsonObject("", true)).toEqual({});
  expect(jsonObject("null", true)).toEqual({});
  expect(jsonObject("The Tailscale GUI failed to start: …", true)).toBeNull();
  expect(parseServeStatus(jsonObject("", true), null)).toEqual({ target: null, funnel: false });
});

test("the serve configuration is only empty-means-nothing when the command itself succeeded", async () => {
  // A command that failed with nothing on stdout says nothing about serve; one that succeeded says nothing is served.
  const failed = await askTailscale({ serve: true }, { bin: () => "/fake/tailscale", appDir: "/nonexistent", run: async (_b, args) => ({ code: args[0] === "serve" ? 1 : 0, out: args[0] === "serve" ? "" : JSON.stringify(STATUS) }) });
  expect(failed.serve).toBeNull();
  const ok = await askTailscale({ serve: true }, { bin: () => "/fake/tailscale", appDir: "/nonexistent", run: async (_b, args) => ({ code: 0, out: args[0] === "serve" ? "" : JSON.stringify(STATUS) }) });
  expect(ok.serve).toEqual({});
  // Exit 0 with the GUI error is still no answer at all.
  const gui = await askTailscale({ serve: true }, { bin: () => "/fake/tailscale", appDir: "/nonexistent", run: async () => ({ code: 0, out: "The Tailscale GUI failed to start: …" }) });
  expect([gui.status, gui.serve, gui.from]).toEqual([null, null, null]);
});

test("the app's proof token never reaches what the hub returns or logs, even with every log line on", async () => {
  const app = fakeApp({ token: "Tr0ub4dor-proof-token-never-logged" });
  try {
    const p = Bun.spawn([process.execPath, PROBE, app.dir], {
      env: { ...process.env, CROSSTALK_LOG: "debug", CROSSTALK_TAILSCALE_BIN: "/nonexistent/tailscale", CROSSTALK_TAILSCALE_APP_DIR: app.dir } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(0);
    // It did ask, and through the folder named in the environment.
    expect(out).toContain('"state":"Running"');
    expect(app.seen.length).toBeGreaterThan(0);
    for (const text of [out, err]) {
      expect(text.includes(app.token)).toBe(false);
      expect(text.includes(btoa(`:${app.token}`))).toBe(false);
    }
  } finally {
    app.stop();
  }
});

test("the checklist's facts: what answered, and nothing at all when Tailscale isn't on the machine", async () => {
  const cli = fakeCli({ status: STATUS, serve: SERVES_HUB });
  withEnv({ ...cli.env, CROSSTALK_TAILSCALE_BIN: cli.bin, CROSSTALK_TAILSCALE_APP_DIR: "/nonexistent/Tailscale" });
  expect(await tailscaleFacts()).toEqual({
    cli: cli.bin,
    tried: ["cli"],
    from: "cli",
    state: "Running",
    dnsName: "mini.tail1.ts.net",
    certs: true,
    keyExpiry: null,
    serve: { target: "http://127.0.0.1:7420", funnel: false },
  });
  // The GUI error and no app API either: installed, and it didn't answer (the checklist says which ways were tried).
  const gui = fakeCli({ status: STATUS, gui: true });
  withEnv({ ...gui.env, CROSSTALK_TAILSCALE_BIN: gui.bin, CROSSTALK_TAILSCALE_APP_DIR: "/nonexistent/Tailscale" });
  expect(await tailscaleFacts()).toMatchObject({ cli: gui.bin, tried: ["cli"], from: null, state: null, serve: null });
  // Nothing installed at all: the item becomes "Tailscale isn't installed", not "didn't answer".
  withEnv({ CROSSTALK_TAILSCALE_BIN: "/nonexistent/tailscale", CROSSTALK_TAILSCALE_APP_DIR: "/nonexistent/Tailscale" });
  expect(await tailscaleFacts()).toBeNull();
});

test("the hub's own https address, asked of itself: whether it answers and whether this Crosstalk is what answers", async () => {
  const asked: { url: string; redirect?: string }[] = [];
  const serving = (body: unknown, status = 200): typeof fetch =>
    (async (u: unknown, init?: RequestInit) => {
      asked.push({ url: String(u), redirect: init?.redirect });
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
  // This machine: its own tailnet name resolves to the Tailscale address one of its interfaces has.
  const own = () => ["127.0.0.1", "192.168.1.9", "100.64.0.9", "fd7a:115c:a1e0:ab12::9"];
  const here = (get: typeof fetch) => ({ get, own, lookup: async () => ["100.64.0.9"] });
  // This very hub answering there: the one thing that makes the network items safe to call done without Tailscale.
  expect(await httpsAnswers("https://mini.tail1.ts.net/", here(serving({ ok: true, version: "0.5.0", name: "crosstalk" })))).toEqual({ answers: true, crosstalk: true, version: "0.5.0" });
  // Its health is the only thing asked, and a redirect away from the tailnet name is never followed.
  expect(asked).toEqual([{ url: "https://mini.tail1.ts.net/api/health", redirect: "error" }]);
  // Something else at that address: it answers, but it isn't Crosstalk.
  expect(await httpsAnswers("https://mini.tail1.ts.net", here(serving({ hello: "nginx" })))).toEqual({ answers: true, crosstalk: false, version: null });
  expect(await httpsAnswers("https://mini.tail1.ts.net", here(serving({ ok: true, version: "0.5.0", name: "crosstalk" }, 502)))).toEqual({ answers: true, crosstalk: false, version: null });
  // A web server's own page there answers too, and says nothing about Crosstalk.
  const page = (async () => new Response("<html>nginx</html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  expect(await httpsAnswers("https://mini.tail1.ts.net", here(page))).toEqual({ answers: true, crosstalk: false, version: null });
  // Nothing answers (refused, timed out, TLS refused): the whole point of asking.
  const broken = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  expect(await httpsAnswers("https://mini.tail1.ts.net", here(broken))).toEqual({ answers: false, crosstalk: false, version: null });
  // The address itself is asked too, and an IPv6-only tailnet answers the same way.
  expect(await httpsAnswers("https://100.64.0.9", here(serving({ ok: true, version: "0.5.0", name: "crosstalk" })))).toMatchObject({ answers: true, crosstalk: true });
  expect(await httpsAnswers("https://[fd7a:115c:a1e0:ab12::9]", here(serving({ ok: true, version: "0.5.0", name: "crosstalk" })))).toMatchObject({ answers: true, crosstalk: true });
  // Only an https address is ever asked: http://127.0.0.1 is no use to a phone and proves nothing about the tailnet.
  for (const url of ["http://127.0.0.1:7420", "", "ws://mini.tail1.ts.net", "https://"]) expect([url, await httpsAnswers(url, here(serving({})))]).toEqual([url, null]);
});

test("the https probe only ever asks an address this machine has, so nothing it asks can leave the machine", async () => {
  // The address the hub thinks is its own can be stale, mistyped or someone else's — the very thing the public-url
  // item is there to catch. Nothing is sent to it then: the item reads "not checked" instead.
  const never: typeof fetch = (async (u: unknown) => {
    throw new Error(`sent a request to ${String(u)}`);
  }) as unknown as typeof fetch;
  const own = () => ["127.0.0.1", "192.168.1.9", "100.64.0.9"];
  const cases: [string, string[]][] = [
    // Another machine on the tailnet (a publicUrl left pointing at a different hub).
    ["https://other.tail1.ts.net", ["100.64.0.7"]],
    // Not on the tailnet at all: someone else's web site.
    ["https://crosstalk.example.com", ["93.184.216.34"]],
    // This machine, but not its tailnet address: that says nothing about what a phone can reach.
    ["https://mini.local", ["192.168.1.9"]],
    // Tailscale down, so MagicDNS answers nothing.
    ["https://mini.tail1.ts.net", []],
  ];
  for (const [url, found] of cases) expect([url, await httpsAnswers(url, { get: never, own, lookup: async () => found })]).toEqual([url, null]);
  // A name that can't be looked up at all is simply not checked.
  expect(
    await httpsAnswers("https://mini.tail1.ts.net", {
      get: never,
      own,
      lookup: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    }),
  ).toBeNull();
});
