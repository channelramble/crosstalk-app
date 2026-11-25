// Holes a security review showed in the hub's own port, each one closed here. Every hub in this file is a throwaway on
// 127.0.0.1 with a port of its own; names and addresses are made up.
import { afterEach, expect, test } from "bun:test";
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { FIRST_CODE_TTL_MS, HUB_PLATFORM } from "../src/auth";
import { CONFIG_PATH, DB_PATH, HOME, HUB_RUN, HUB_VERSION, RUN_DIR, ensureDirs } from "../src/config";
import { Store } from "../src/db";
import { ANSWER_MAX, hubCall } from "../src/machines";
import { readBody } from "../src/routes";
import { knownHost, originAllowed, resetFailureLimits, startServer } from "../src/server";
import { isPersonDevice } from "../src/signin";

const WRONG = 401;
const LOCKED = 429;

function boot(publicUrl: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "ct-hardening-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  resetFailureLimits();
  const base = `http://127.0.0.1:${server.port}`;
  const device = async (name = "Phone", platform = "Web") => (await app.auth.pair((await app.auth.createPairingCode()).code, name, platform))!;
  const done = async () => {
    resetFailureLimits();
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, app, server, base, device, done };
}

afterEach(() => {
  delete process.env.CROSSTALK_DEV_ORIGINS;
  delete process.env.CROSSTALK_ALLOWED_HOSTS;
});

/** One raw request on its own connection: the head now, the body only when `body()` is called. Resolves with the status line. */
function raw(port: number, head: string): Promise<{ status: Promise<number>; write: (s: string) => void; close: () => void }> {
  return new Promise((ready) => {
    let got!: (n: number) => void;
    const status = new Promise<number>((r) => (got = r));
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          s.write(head);
          ready({ status, write: (t) => void s.write(t), close: () => s.end() });
        },
        data(_s, d) {
          const m = /^HTTP\/1\.1 (\d{3})/.exec(d.toString());
          if (m) got(Number(m[1]));
        },
        close() {
          got(0);
        },
        error() {
          got(0);
        },
      },
    });
  });
}

// ---------------------------------------------------------------------------------- 1. bodies a stranger sends

test("a stranger's oversized body is refused (413) on every route that needs no sign-in, instead of being read into memory", async () => {
  const h = boot();
  try {
    const big = " ".repeat(200_000) + "{}";
    for (const path of ["/api/push/notes", "/api/pair"]) {
      const r = await fetch(h.base + path, { method: "POST", body: big });
      expect([path, r.status]).toEqual([path, 413]);
      expect(((await r.json()) as { error: string }).error).toBe("That's more than this takes in one request (64 KB).");
    }
    // The same without saying how long it is (a stream): the bytes are counted, and the reading stops at the limit.
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const stream = new ReadableStream({
      pull(c) {
        if (sent >= 200 * chunk.length) return c.close();
        c.enqueue(chunk);
        sent += chunk.length;
      },
    });
    const before = process.memoryUsage().rss;
    const status = await fetch(`${h.base}/api/push/notes`, { method: "POST", body: stream, duplex: "half" } as RequestInit).then((r) => r.status, () => 0);
    // 413, or the connection closed under a client that kept sending: either way nothing was kept.
    expect([413, 0]).toContain(status);
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024);
    // Small ones still work.
    expect((await fetch(`${h.base}/api/push/notes`, { method: "POST", body: JSON.stringify({ endpoint: "https://push.example/x" }) })).status).toBe(200);
  } finally {
    await h.done();
  }
}, 60_000);

test("a wrong invite or key is refused before any of the body is read: a request that never sends its body is answered at once", async () => {
  const h = boot();
  try {
    const head = (path: string, extra = "") => `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 50000\r\n${extra}Connection: close\r\n\r\n`;
    for (const [path, extra] of [
      ["/api/computers/claim/wronginvite0001", ""],
      ["/api/machines/install/wrongtoken0000001/claim", ""],
      ["/api/push/relay", "Authorization: Bearer not-a-key\r\n"],
    ]) {
      const c = await raw(h.server.port!, head(path, extra));
      const status = await Promise.race([c.status, Bun.sleep(3000).then(() => -1)]);
      c.close();
      expect([path, status]).toEqual([path, WRONG]);
    }
    // A live invite's body is capped like the rest.
    const invite = h.app.computers.invite().token;
    const r = await fetch(`${h.base}/api/computers/claim/${invite}`, { method: "POST", body: " ".repeat(200_000) });
    expect(r.status).toBe(413);
  } finally {
    await h.done();
  }
});

test("a body that stops arriving isn't waited for (408), and a signed-in device's JSON is capped at a few MB (uploads aren't)", async () => {
  const never = new Request("http://127.0.0.1/x", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), duplex: "half" } as RequestInit);
  const e = await readBody(never, 1024, 60).then(() => null, (x) => x);
  expect([e?.status, e?.message]).toEqual([408, "The request took too long to arrive. Try again."]);
  const h = boot();
  try {
    const dev = await h.device();
    const A = { authorization: `Bearer ${dev.token}` };
    const five = "x".repeat(5 * 1024 * 1024);
    const r = await fetch(`${h.base}/api/rooms`, { method: "POST", headers: A, body: JSON.stringify({ name: five }) });
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toBe("That's more than this takes in one request (4 MB).");
    // A chat copied from another machine may be bigger than that (it has its own limits).
    expect((await fetch(`${h.base}/api/chats/duplicate`, { method: "POST", headers: A, body: JSON.stringify({ pad: five }) })).status).not.toBe(413);
    // An upload streams to disk: no such limit.
    const room = h.app.createRoom({ name: "Up", mode: "direct" });
    expect((await fetch(`${h.base}/api/rooms/${room.id}/uploads?name=big.bin`, { method: "POST", headers: A, body: five })).status).toBe(200);
    // JSON that isn't JSON is the sender's mistake (400), not the machine's (500).
    expect((await fetch(`${h.base}/api/rooms`, { method: "POST", headers: A, body: "{nope" })).status).toBe(400);
  } finally {
    await h.done();
  }
}, 30_000);

test("another machine's answer is read only up to a few MB", async () => {
  const body = "x".repeat(ANSWER_MAX + 1024);
  const told = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(body) });
  let more = 0;
  const streamed = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(new ReadableStream({ pull(c) { if (++more > 64) return c.close(); c.enqueue(new Uint8Array(1024 * 1024).fill(0x78)); } })),
  });
  try {
    for (const s of [told, streamed]) {
      const e = await hubCall(`http://127.0.0.1:${s.port}`, "/api/machines").then(() => null, (x) => x);
      expect([e?.status, e?.code, e?.message]).toEqual([502, "too_long", `127.0.0.1:${s.port} sent more than Crosstalk reads from another machine.`]);
    }
  } finally {
    told.stop(true);
    streamed.stop(true);
  }
});

// ------------------------------------------------------------------------------------- 2 and 3. wrong-code limits

test("twenty wrong codes lock out the caller who sent them, not everyone: another caller still pairs with a good code", async () => {
  const h = boot();
  try {
    const pair = (code: string, from?: string) => fetch(`${h.base}/api/pair`, { method: "POST", headers: from ? { "x-forwarded-for": from } : {}, body: JSON.stringify({ code, name: "x" }) });
    for (let i = 0; i < 20; i++) expect((await pair("WRONG-CODE", "203.0.113.5")).status).toBe(WRONG);
    const good = async () => (await h.app.auth.createPairingCode()).code;
    // That caller waits, good code or not (and the code isn't used up by being refused).
    const held = await good();
    expect((await pair(held, "203.0.113.5")).status).toBe(LOCKED);
    // What it claims to have been forwarded for doesn't count: the nearest proxy's word (the last address) does.
    expect((await pair(held, "198.51.100.9, 203.0.113.5")).status).toBe(LOCKED);
    // Another phone behind the same proxy, and someone at the machine itself, pair as ever.
    expect((await pair(held, "203.0.113.6")).status).toBe(200);
    expect((await pair(await good())).status).toBe(200);
    // The other endpoints keep count per caller too.
    const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 20; i++) expect((await fetch(`${h.base}/api/computers/claim/wrongtoken${i}/script`, from("203.0.113.5"))).status).toBe(WRONG);
    expect((await fetch(`${h.base}/api/computers/claim/wrongtokenX/script`, from("203.0.113.5"))).status).toBe(LOCKED);
    expect((await fetch(`${h.base}/api/computers/claim/wrongtokenX/script`, from("203.0.113.6"))).status).toBe(WRONG);
    for (let i = 0; i < 20; i++) expect((await fetch(`${h.base}/api/machines/install/wrongtoken00000${10 + i}`, from("203.0.113.5"))).status).toBe(WRONG);
    expect((await fetch(`${h.base}/api/machines/install/wrongtoken0000099`, from("203.0.113.5"))).status).toBe(LOCKED);
    expect((await fetch(`${h.base}/api/machines/install/wrongtoken0000099`, from("203.0.113.6"))).status).toBe(WRONG);
    const relay = (ip: string) => fetch(`${h.base}/api/push/relay`, { method: "POST", headers: { "x-forwarded-for": ip, authorization: "Bearer nope" }, body: "{}" });
    for (let i = 0; i < 20; i++) expect((await relay("203.0.113.5")).status).toBe(WRONG);
    expect((await relay("203.0.113.5")).status).toBe(LOCKED);
    expect((await relay("203.0.113.6")).status).toBe(WRONG);
    // A live invite fetched many times is no guess: it never locks.
    const invite = h.app.computers.invite().token;
    for (let i = 0; i < 30; i++) expect((await fetch(`${h.base}/api/computers/claim/${invite}/script`, from("203.0.113.7"))).status).toBe(200);
  } finally {
    await h.done();
  }
});

test("a caller who comes from a thousand addresses meets the ceiling for everyone together", async () => {
  const h = boot();
  try {
    const pair = (n: number) => fetch(`${h.base}/api/pair`, { method: "POST", headers: { "x-forwarded-for": `198.51.${Math.floor(n / 250)}.${n % 250}` }, body: '{"code":"WRONG-CODE"}' }).then((r) => r.status);
    const statuses: number[] = [];
    for (let i = 0; i < 1000; i += 50) statuses.push(...(await Promise.all(Array.from({ length: 50 }, (_, k) => pair(i + k)))));
    expect(statuses.every((s) => s === WRONG)).toBe(true);
    expect(await pair(1001)).toBe(LOCKED);
  } finally {
    await h.done();
  }
}, 30_000);

test("the wrong-code limit can't be passed by sending headers first and codes later: each request counts as it arrives", async () => {
  const h = boot();
  try {
    const N = 60;
    const open = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const body = JSON.stringify({ code: `AAAA-B${String(i).padStart(3, "C")}` });
        return raw(h.server.port!, `POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`).then((c) => ({ ...c, body }));
      }),
    );
    await Bun.sleep(300); // every request has arrived; none has sent its code
    for (const c of open) c.write(c.body);
    const statuses = await Promise.all(open.map((c) => Promise.race([c.status, Bun.sleep(5000).then(() => -1)])));
    for (const c of open) c.close();
    const count = (s: number) => statuses.filter((x) => x === s).length;
    // 20 guesses were looked at, the other 40 refused; before, all of them were.
    expect({ guessed: count(WRONG), refused: count(LOCKED) }).toEqual({ guessed: 20, refused: 40 });
  } finally {
    await h.done();
  }
}, 20_000);

// ------------------------------------------------------------------------------------------ 4. cross-origin answers

test("only the app's own pages may read answers across origins: not any *.ts.net site, not any localhost port", async () => {
  const h = boot("https://mini.example-net.ts.net");
  try {
    const dev = await h.device();
    const port = h.server.port;
    const acao = async (origin: string) => (await fetch(`${h.base}/api/state`, { headers: { origin, authorization: `Bearer ${dev.token}` } })).headers.get("access-control-allow-origin");
    for (const origin of ["tauri://localhost", "https://tauri.localhost", "http://tauri.localhost", "https://mini.example-net.ts.net", "https://laptop.example-net.ts.net", `http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      expect([origin, await acao(origin)]).toEqual([origin, origin]);
    }
    for (const origin of ["https://attacker.other-net.ts.net", "https://example-net.ts.net.evil.example", "http://laptop.example-net.ts.net", "http://localhost:3000", "http://127.0.0.1:9999", "https://evil.example", "null"]) {
      expect([origin, await acao(origin)]).toEqual([origin, null]);
      // A preflight for it is told nothing either.
      expect((await fetch(`${h.base}/api/state`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } })).headers.get("access-control-allow-origin")).toBeNull();
    }
    // A dev server on another port, only when the hub was told about it.
    process.env.CROSSTALK_DEV_ORIGINS = "http://localhost:3000, http://127.0.0.1:5173";
    expect(await acao("http://localhost:3000")).toBe("http://localhost:3000");
    expect(await acao("http://127.0.0.1:9999")).toBeNull();
  } finally {
    await h.done();
  }
  // A hub that doesn't know its own address still knows its tailnet from the name it was asked under.
  const where = { publicUrl: null, port: 7000 };
  const asked = (host: string) => new Request("http://127.0.0.1/api/state", { headers: { host } });
  expect(originAllowed("https://laptop.example-net.ts.net", where, asked("mini.example-net.ts.net"))).toBe(true);
  expect(originAllowed("https://laptop.other-net.ts.net", where, asked("mini.example-net.ts.net"))).toBe(false);
  expect(originAllowed("https://laptop.example-net.ts.net", where, asked("127.0.0.1:7000"))).toBe(false);
});

// ------------------------------------------------------------------------------- 5. Host, and the sockets' Origin

test("a request under a name the hub doesn't know gets 421 (DNS rebinding); the names it goes by all work", async () => {
  const h = boot("https://mini.example-net.ts.net");
  try {
    const dev = await h.device();
    const as = (host: string, path = "/api/health", headers: Record<string, string> = {}) => fetch(h.base + path, { headers: { host, ...headers } });
    for (const path of ["/api/health", "/", "/api/state", "/setup.md"]) {
      const r = await as("attacker.example:7420", path, { authorization: `Bearer ${dev.token}` });
      expect([path, r.status]).toEqual([path, 421]);
      expect(await r.text()).toBe("This address isn't one Crosstalk knows for this machine. If you reach it through your own proxy, set CROSSTALK_ALLOWED_HOSTS.\n");
    }
    expect((await fetch(`${h.base}/api/pair`, { method: "POST", headers: { host: "attacker.example" }, body: "{}" })).status).toBe(421);
    const own = hostname().toLowerCase().replace(/\.local$/, "");
    for (const host of [`127.0.0.1:${h.server.port}`, "localhost:7420", "[::1]:7420", "192.168.1.20:7420", "mini.example-net.ts.net", "other.some-net.ts.net", own, `${own}.local:7420`]) {
      expect([host, (await as(host)).status]).toEqual([host, 200]);
    }
    // What a proxy on this machine says it was asked for is held to the same.
    expect((await as("127.0.0.1", "/api/health", { "x-forwarded-host": "attacker.example" })).status).toBe(421);
    // Someone's own proxy, under a name of their own.
    expect((await as("crosstalk.home.example")).status).toBe(421);
    process.env.CROSSTALK_ALLOWED_HOSTS = "crosstalk.home.example, other.example";
    expect((await as("crosstalk.home.example:8443")).status).toBe(200);
  } finally {
    await h.done();
  }
  // Names that only look like addresses.
  expect(knownHost("127.0.0.1.attacker.example", null)).toBe(false);
  expect(knownHost("localhost.attacker.example", null)).toBe(false);
  expect(knownHost("ts.net.attacker.example", null)).toBe(false);
  expect(knownHost(null, null)).toBe(true);
});

/** Opens a socket and says how it went: the first event's type, or "refused". */
function socket(url: string, opts?: unknown): Promise<{ got: string; protocol: string }> {
  return new Promise((done) => {
    const ws = new WebSocket(url, opts as string[]);
    const end = (got: string) => {
      done({ got, protocol: ws.protocol });
      ws.close();
    };
    ws.onmessage = (e) => end(JSON.parse(String(e.data)).t);
    ws.onerror = () => end("refused");
    ws.onclose = () => end("refused");
    setTimeout(() => end("timeout"), 3000);
  });
}

test("the live sockets refuse a page from elsewhere (Origin), and still take the app's own page, native apps and other hubs", async () => {
  const h = boot("https://mini.example-net.ts.net");
  try {
    const dev = await h.device();
    const port = h.server.port;
    const url = `ws://127.0.0.1:${port}/api/ws?token=${dev.token}`;
    const from = (origin: string, extra: Record<string, string> = {}) => socket(url, { headers: { origin, ...extra } });
    expect((await from("https://evil.example")).got).toBe("refused");
    expect((await from("https://attacker.other-net.ts.net")).got).toBe("refused");
    expect((await from("http://localhost:3000")).got).toBe("refused");
    expect((await fetch(`http://127.0.0.1:${port}/api/screen/ws?token=${dev.token}`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    // No Origin (a native app, another hub, a test), the hub's own address, a sibling machine's page, the native app's page.
    expect((await socket(url)).got).toBe("hello");
    expect((await from("https://mini.example-net.ts.net")).got).toBe("hello");
    expect((await from("https://laptop.example-net.ts.net")).got).toBe("hello");
    expect((await from("tauri://localhost")).got).toBe("hello");
    expect((await from(`http://127.0.0.1:${port}`)).got).toBe("hello");
    // The app's own page, whatever address the hub is reached at: its Origin is the request's own Host.
    expect((await from("http://192.168.1.20:7420", { host: "192.168.1.20:7420" })).got).toBe("hello");
    expect((await from("http://192.168.1.21:7420", { host: "192.168.1.20:7420" })).got).toBe("refused");
    // Behind a proxy on this machine that names the address it was asked for.
    process.env.CROSSTALK_ALLOWED_HOSTS = "crosstalk.home.example";
    expect((await from("https://crosstalk.home.example", { "x-forwarded-host": "crosstalk.home.example" })).got).toBe("hello");
  } finally {
    await h.done();
  }
});

// ------------------------------------------------------------------------------------------------- 6. where a token goes

test("a token in the address is taken only by the two sockets: GET /api/state?token=… is 401", async () => {
  const h = boot();
  try {
    const dev = await h.device();
    const port = h.server.port;
    for (const path of ["/api/state", "/api/devices", "/api/pty", "/api/health"]) {
      const r = await fetch(`${h.base}${path}?token=${dev.token}`, { headers: { "x-forwarded-for": "203.0.113.5" } });
      if (path === "/api/health") expect((await r.json()) as object).toEqual({ ok: true, name: "crosstalk", run: HUB_RUN });
      else expect([path, r.status]).toEqual([path, 401]);
    }
    expect((await fetch(`${h.base}/api/push/relay?token=${dev.token}`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${h.base}/api/state`, { headers: { authorization: `Bearer ${dev.token}` } })).status).toBe(200);
    // Older apps open their sockets with ?token=.
    expect((await socket(`ws://127.0.0.1:${port}/api/ws?token=${dev.token}&v=2`)).got).toBe("hello");
    expect((await socket(`ws://127.0.0.1:${port}/api/ws?token=wrong`)).got).toBe("refused");
    expect((await fetch(`${h.base}/api/screen/ws?token=${dev.token}`)).status).toBe(400); // signed in; this just wasn't a socket
    expect((await fetch(`${h.base}/api/screen/ws`)).status).toBe(401);
  } finally {
    await h.done();
  }
});

test("a socket signs in with its token as a subprotocol (crosstalk, bearer.<token>) and is answered with 'crosstalk' only", async () => {
  const h = boot();
  try {
    const dev = await h.device();
    const port = h.server.port;
    const ok = await socket(`ws://127.0.0.1:${port}/api/ws?v=2`, ["crosstalk", `bearer.${dev.token}`]);
    expect(ok).toEqual({ got: "hello", protocol: "crosstalk" });
    expect((await socket(`ws://127.0.0.1:${port}/api/ws?v=2`, ["crosstalk", "bearer.wrong"])).got).toBe("refused");
    expect((await socket(`ws://127.0.0.1:${port}/api/ws?v=2`, ["crosstalk"])).got).toBe("refused");
    // The answer names the protocol, never the token.
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
    for (const path of ["/api/ws", "/api/screen/ws"]) {
      const answer = await new Promise<string>((done) => {
        let text = "";
        void Bun.connect({
          hostname: "127.0.0.1",
          port: port!,
          socket: {
            open: (s) => void s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: crosstalk, bearer.${dev.token}\r\n\r\n`),
            data(s, d) {
              text += d.toString("latin1");
              if (text.includes("\r\n\r\n")) {
                done(text.split("\r\n\r\n")[0]);
                s.end();
              }
            },
            close: () => done(text),
            error: () => done(text),
          },
        });
      });
      expect([path, answer.split("\r\n")[0]]).toEqual([path, "HTTP/1.1 101 Switching Protocols"]);
      expect(answer.toLowerCase()).toContain("sec-websocket-protocol: crosstalk\r\n".trim());
      expect(answer.toLowerCase().match(/sec-websocket-protocol/g)?.length).toBe(1);
      expect(answer).not.toContain(dev.token);
    }
    // The subprotocol is for the sockets only.
    expect((await fetch(`${h.base}/api/state`, { headers: { "sec-websocket-protocol": `crosstalk, bearer.${dev.token}` } })).status).toBe(401);
  } finally {
    await h.done();
  }
});

// ---------------------------------------------------------------------------- 7. what a linked machine can aim the hub at

test("a linked machine's limited sign-in can't make the hub call this machine's own ports, or read what answers there", async () => {
  const banner = "INTERNAL-SERVICE-BANNER";
  let asked = 0;
  const local = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (asked++, new Response(`${banner} some private page`, { status: 404 })) });
  const peerOf = async (h: ReturnType<typeof boot>) => {
    const code = await h.app.auth.createPairingCode(60_000, { scope: "peer", hubId: "h_peer1234" });
    const peer = (await h.app.auth.pair(code.code, "Other (hub)", HUB_PLATFORM))!;
    return { authorization: `Bearer ${peer.token}`, "content-type": "application/json" };
  };
  const back = (h: ReturnType<typeof boot>, headers: Record<string, string>, url: string) =>
    fetch(`${h.base}/api/machines/peer`, { method: "POST", headers, body: JSON.stringify({ kind: "back", url, code: "x", hub: { id: "h_peer1234", name: "x" } }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error?: string; code?: string } }));
  // A hub with a real address (or none): plain http on this machine is refused outright, and nothing is asked there.
  for (const publicUrl of ["https://mini.example-net.ts.net", null]) {
    const h = boot(publicUrl);
    try {
      const A = await peerOf(h);
      for (const url of [`http://127.0.0.1:${local.port}`, `http://localhost:${local.port}`, `http://[::1]:${local.port}`]) {
        expect(await back(h, A, url)).toEqual({ status: 400, body: { error: "Machines link only over https." } });
      }
      expect(asked).toBe(0);
    } finally {
      await h.done();
    }
  }
  // Hubs that are themselves at a loopback address (tests, two on one machine) may; the answer still isn't passed on.
  const h = boot("http://127.0.0.1:1");
  try {
    const A = await peerOf(h);
    const open = await back(h, A, `http://127.0.0.1:${local.port}`);
    expect(asked).toBe(1);
    expect(open).toEqual({ status: 502, body: { error: "Couldn't reach that machine.", code: "pair_failed" } });
    // A closed port reads the same as an open one.
    expect(await back(h, A, "http://127.0.0.1:9")).toEqual(open);
    // A person's own device still sees why (it could look at that port itself).
    const dev = await h.device();
    const full = await back(h, { authorization: `Bearer ${dev.token}`, "content-type": "application/json" }, `http://127.0.0.1:${local.port}`);
    expect(full.body.error).toContain(banner);
  } finally {
    local.stop(true);
    await h.done();
  }
});

// -------------------------------------------------------------------------------- 8. whose sign-in is a person's

test("a sign-in made with a code for a machine is a machine's, whatever it calls itself", async () => {
  const h = boot();
  try {
    const pairAs = async (opts: Parameters<typeof h.app.auth.createPairingCode>[1], platform: string) => (await h.app.auth.pair((await h.app.auth.createPairingCode(60_000, opts)).code, "Linux box", platform))!.device;
    // A code made for linking a machine: saying "Web" doesn't make it a person's device.
    const lied = await pairAs({ kind: "hub" }, "Web");
    expect([lied.platform, isPersonDevice(lied)]).toEqual([HUB_PLATFORM, false]);
    expect(isPersonDevice(h.app.store.getDevice(lied.id)!)).toBe(false);
    expect(isPersonDevice(await pairAs({ scope: "peer", hubId: "h_other123" }, "Web"))).toBe(false);
    expect(isPersonDevice(await pairAs({ scope: "full", hubId: "h_other123" }, "iOS"))).toBe(false);
    // One that says it is a machine is one (hubs of this version and the one before pair this way).
    expect(isPersonDevice(await pairAs({}, HUB_PLATFORM))).toBe(false);
    // A person's phone.
    const phone = await pairAs({}, "Web");
    expect([phone.platform, isPersonDevice(phone)]).toEqual(["Web", true]);
    // The app asks for a machine's code with { kind: "hub" }; such a sign-in is refused what's for people only.
    const owner = await h.device();
    const made = (await (await fetch(`${h.base}/api/pairing-codes`, { method: "POST", headers: { authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ kind: "hub" }) })).json()) as { code: string };
    const paired = (await (await fetch(`${h.base}/api/pair`, { method: "POST", body: JSON.stringify({ code: made.code, name: "Sneaky", platform: "Web" }) })).json()) as { token: string; device: { platform: string } };
    expect(paired.device.platform).toBe(HUB_PLATFORM);
    expect((await fetch(`${h.base}/api/screen/ws`, { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(403);
    expect((await fetch(`${h.base}/api/screen/ws`, { headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(400);
    // The Linux setup command asks its new hub for such a code.
    expect(h.app.machines.script(h.app.machines.invite("https://mini.example-net.ts.net").token, "https://mini.example-net.ts.net")).toContain("crosstalk-hub\" pair 30 --for-machine |");
    expect(readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8")).toContain('rest.includes("--for-machine") ? { kind: "hub" } : {}');
  } finally {
    await h.done();
  }
});

// ------------------------------------------------------------------------------------------ 9. what's kept on disk

test.skipIf(process.platform === "win32")("the data folder is the user's alone at every start: folder 0700, database and config 0600", () => {
  if (!HOME.includes("crosstalk-tests-")) throw new Error(`not the test home: ${HOME}`);
  const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
  // As an earlier version left them: readable by everyone.
  ensureDirs();
  writeFileSync(CONFIG_PATH, "{}");
  for (const d of [HOME, RUN_DIR]) chmodSync(d, 0o755);
  for (const f of [DB_PATH, CONFIG_PATH]) chmodSync(f, 0o644);
  ensureDirs();
  expect([mode(HOME), mode(RUN_DIR), mode(DB_PATH), mode(CONFIG_PATH)]).toEqual(["700", "700", "600", "600"]);
  // The files SQLite makes beside the database take the database's mode.
  const store = new Store(DB_PATH);
  try {
    store.kvSet("hardening.test", "1");
    for (const f of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) expect([f.slice(DB_PATH.length), mode(f)]).toEqual([f.slice(DB_PATH.length), "600"]);
    expect(existsSync(`${DB_PATH}-wal`)).toBe(true);
  } finally {
    store.close();
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, CONFIG_PATH]) rmSync(f, { force: true });
  }
});

// ------------------------------------------------------------------------------------------------ 10. small things

test("the first pairing code, printed to the service's log, lasts an hour", () => {
  expect(FIRST_CODE_TTL_MS).toBe(60 * 60_000);
  expect(readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8")).toContain("createPairingCode(FIRST_CODE_TTL_MS)");
});

test("/api/health says the version only on this machine itself or to a signed-in device", async () => {
  const h = boot();
  try {
    const dev = await h.device();
    const health = async (headers: Record<string, string> = {}) => (await (await fetch(`${h.base}/api/health`, { headers })).json()) as object;
    // Straight from this machine (the installers, the menu-bar app, `crosstalk-hub setup`).
    expect(await health()).toEqual({ ok: true, version: HUB_VERSION, name: "crosstalk", run: HUB_RUN });
    // Through a proxy (tailscale serve, anyone on the network): that a Crosstalk is here, and a random name for this
    // start of it (by which the hub knows its own answer), nothing more.
    expect(await health({ "x-forwarded-for": "203.0.113.5" })).toEqual({ ok: true, name: "crosstalk", run: HUB_RUN });
    expect(await health({ "tailscale-user-login": "someone@example.com" })).toEqual({ ok: true, name: "crosstalk", run: HUB_RUN });
    expect(await health({ "x-forwarded-for": "203.0.113.5", authorization: "Bearer wrong" })).toEqual({ ok: true, name: "crosstalk", run: HUB_RUN });
    // A signed-in device, from anywhere.
    expect(await health({ "x-forwarded-for": "203.0.113.5", authorization: `Bearer ${dev.token}` })).toEqual({ ok: true, version: HUB_VERSION, name: "crosstalk", run: HUB_RUN });
  } finally {
    await h.done();
  }
});

test("an error nobody planned for goes to the log, not to the app: plain words and a short id come back", async () => {
  const h = boot();
  try {
    const dev = await h.device();
    const A = { authorization: `Bearer ${dev.token}` };
    const secret = "no such table: things at /Users/someone/.crosstalk/crosstalk.db";
    h.app.snapshot = () => {
      throw new TypeError(secret);
    };
    const r = await fetch(`${h.base}/api/state`, { headers: A });
    const j = (await r.json()) as { error: string; code: string; id: string };
    expect([r.status, j.error, j.code]).toEqual([500, "Something went wrong on the machine. Its log has the details.", "went_wrong"]);
    expect(j.id).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(j)).not.toContain("someone");
    // An error with a system's code on it is one from underneath too.
    h.app.snapshot = () => {
      throw Object.assign(new Error(secret), { code: "ENOENT" });
    };
    expect(((await (await fetch(`${h.base}/api/state`, { headers: A })).json()) as { error: string }).error).toBe("Something went wrong on the machine. Its log has the details.");
    // Words the hub wrote for the person still reach the person's own device…
    h.app.folders = () => {
      throw new Error("Stop the agent first.");
    };
    expect(((await (await fetch(`${h.base}/api/folders`, { headers: A })).json()) as { error: string }).error).toBe("Stop the agent first.");
    // …but not a linked machine's limited sign-in, and not a stranger.
    const code = await h.app.auth.createPairingCode(60_000, { scope: "peer", hubId: "h_peer1234" });
    const peer = (await h.app.auth.pair(code.code, "Other (hub)", HUB_PLATFORM))!;
    h.app.machines.peerInfo = () => {
      throw new Error("something only the owner should read");
    };
    const p = await fetch(`${h.base}/api/machines/peer`, { headers: { authorization: `Bearer ${peer.token}` } });
    expect([p.status, ((await p.json()) as { error: string }).error]).toEqual([500, "Something went wrong on the machine. Its log has the details."]);
    h.app.push.take = () => {
      throw new Error("something only the owner should read");
    };
    const s = await fetch(`${h.base}/api/push/notes`, { method: "POST", body: "{}" });
    expect([s.status, ((await s.json()) as { error: string }).error]).toEqual([500, "Something went wrong on the machine. Its log has the details."]);
  } finally {
    await h.done();
  }
});

test("every JSON answer says nosniff", async () => {
  const h = boot();
  try {
    const dev = await h.device();
    const A = { authorization: `Bearer ${dev.token}` };
    const sniff = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(h.base + path, init);
      return [path, r.status, r.headers.get("content-type"), r.headers.get("x-content-type-options")];
    };
    expect(await sniff("/api/health")).toEqual(["/api/health", 200, "application/json", "nosniff"]);
    expect(await sniff("/api/state", { headers: A })).toEqual(["/api/state", 200, "application/json", "nosniff"]);
    expect(await sniff("/api/state")).toEqual(["/api/state", 401, "application/json", "nosniff"]);
    expect(await sniff("/api/nothing-here", { headers: A })).toEqual(["/api/nothing-here", 404, "application/json", "nosniff"]);
    expect(await sniff("/api/pair", { method: "POST", body: "{}" })).toEqual(["/api/pair", 401, "application/json", "nosniff"]);
    // A big answer goes out compressed, by another path in the server.
    for (let i = 0; i < 40; i++) h.app.createRoom({ name: `Chat ${i} ${"x".repeat(200)}`, mode: "direct" });
    const big = await fetch(`${h.base}/api/state`, { headers: { ...A, "accept-encoding": "gzip" } });
    expect([big.headers.get("content-encoding"), big.headers.get("x-content-type-options")]).toEqual(["gzip", "nosniff"]);
  } finally {
    await h.done();
  }
});
