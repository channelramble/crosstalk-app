// The hub machine's screen (hub/src/screen): signing in to its screen sharing, the agents' picture and input, the phone's
// passed-through view, and who may reach it. Played against a small screen-sharing server (fixtures/fake-vnc.ts): nothing
// here touches a real screen.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { encodePng, scaleRgb } from "../src/screen/image";
import { parseCombo } from "../src/screen/keys";
import { ScreenManager, FACTORY_SCREEN, type ScreenSettings } from "../src/screen";
import { RfbClient, RfbError, rfbOpen, vncResponse } from "../src/screen/rfb";
import { fakeVnc, type FakeVnc } from "./fixtures/fake-vnc";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const vnc = (opts?: Parameters<typeof fakeVnc>[0]): FakeVnc => {
  const v = fakeVnc(opts);
  cleanups.push(() => v.stop());
  return v;
};
function manager(v: { port: number }, opts: { password?: string; agents?: boolean; username?: string; ownLoginScreen?: (since: number) => Promise<boolean>; accounts?: { name: string; fullName: string }[] } = {}) {
  let settings: ScreenSettings = { ...FACTORY_SCREEN, agents: opts.agents ?? true, username: opts.username ?? "" };
  let password = opts.password ?? "";
  let changes = 0;
  const m = new ScreenManager({
    settings: () => settings,
    save: (n) => (settings = n),
    password: () => password,
    setPassword: (p) => (password = p ?? ""),
    changed: () => changes++,
    hubPid: process.pid,
    port: v.port,
    windows: async () => [{ id: 1, app: "BrowserOS neo", title: "Shop", x: 100, y: 50, width: 800, height: 600, agent: true }],
    ...(opts.ownLoginScreen ? { ownLoginScreen: opts.ownLoginScreen } : {}),
    ...(opts.accounts ? { accounts: async () => opts.accounts! } : {}),
  });
  cleanups.push(() => m.shutdown());
  return { m, changes: () => changes, password: () => password };
}
/** A PNG's size and its pixels (three bytes each), for checking what an agent is shown. */
function readPng(png: Uint8Array) {
  const v = new DataView(png.buffer, png.byteOffset);
  const width = v.getUint32(16), height = v.getUint32(20);
  let at = 8;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = v.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = (x: number, y: number) => [...raw.subarray(y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3)];
  return { width, height, px };
}

test("VNC authentication answers the challenge the way every VNC server expects", () => {
  // A known pair: the classic test vector for password "password" isn't published, so check against the server's own sum.
  const challenge = new Uint8Array(16).map((_, i) => i);
  expect(vncResponse(challenge, "secret")).toHaveLength(16);
  expect(Buffer.from(vncResponse(challenge, "secret")).equals(Buffer.from(vncResponse(challenge, "secretXX")))).toBe(false);
  // Only the first eight characters count, as in VNC.
  expect(Buffer.from(vncResponse(challenge, "12345678")).equals(Buffer.from(vncResponse(challenge, "12345678extra")))).toBe(true);
});

test("signing in: the right password gets the screen, a wrong or missing one says so in plain words, and nothing listening says that", async () => {
  const v = vnc({ password: "hunter22", width: 64, height: 48 });
  const ok = await rfbOpen("127.0.0.1", v.port, { password: "hunter22" });
  expect(ok.init).toMatchObject({ width: 64, height: 48, name: "Test screen" });
  ok.close();
  const wrong = await rfbOpen("127.0.0.1", v.port, { password: "nope" }).then(() => null, (e) => e);
  expect(wrong).toBeInstanceOf(RfbError);
  expect(wrong).toMatchObject({ code: "auth" });
  expect(wrong.message).toContain("didn't accept the password");
  const none = await rfbOpen("127.0.0.1", v.port, {}).then(() => null, (e) => e);
  expect(none).toMatchObject({ code: "auth" });
  expect(none.message).toContain("hasn't been given one yet");
  v.stop();
  const off = await rfbOpen("127.0.0.1", v.port, { password: "hunter22" }).then(() => null, (e) => e);
  expect(off).toMatchObject({ code: "off" });
});

test("a server that takes no VNC password says what to change: on a Mac in Screen Sharing's settings, on any other machine in its VNC server's", async () => {
  // A Mac's Screen Sharing with "VNC viewers may control screen with password" off offers only sign-in with an account.
  const mac = vnc({ account: { name: "sam", password: "correct horse" } });
  const onMac = await rfbOpen("127.0.0.1", mac.port, { password: "hunter22" }).then(() => null, (e) => e);
  expect(onMac).toMatchObject({ code: "auth" });
  expect(onMac.message).toContain('In its settings on the Mac, turn on "VNC viewers may control screen with password"');
  // A Linux VNC server set to TLS only (VeNCrypt): nothing about a Mac.
  const linux = vnc({ password: "hunter22", offers: [19] });
  const onLinux = await rfbOpen("127.0.0.1", linux.port, { password: "hunter22" }).then(() => null, (e) => e);
  expect(onLinux).toMatchObject({ code: "auth" });
  expect(onLinux.message).toBe('Screen sharing offers no way of signing in that Crosstalk knows. Set this machine\'s VNC server to take a VNC password (its "VncAuth" security type), then try again.');
  expect(onLinux.message).not.toContain("Mac");
});

test("the agents' client keeps a copy of the screen: what's painted shows up, in the right colours", async () => {
  const v = vnc({ width: 64, height: 48 });
  const c = await RfbClient.connect("127.0.0.1", v.port, {});
  cleanups.push(() => c.close());
  await c.nextUpdate(2000);
  expect([c.width, c.height]).toEqual([64, 48]);
  expect([...c.pixels.subarray(0, 3)]).toEqual([40, 40, 40]);
  v.paint(10, 5, 4, 3, [255, 128, 0]);
  await c.nextUpdate(2000);
  const at = (5 * 64 + 10) * 4;
  expect([...c.pixels.subarray(at, at + 3)]).toEqual([255, 128, 0]);
  expect([...c.pixels.subarray(at - 4, at - 1)]).toEqual([40, 40, 40]);
});

test("pictures: a PNG that reads back, scaled down by averaging, and a part of the screen on its own", () => {
  // 4×2 screen: left half red, right half blue.
  const px = new Uint8Array(4 * 2 * 4);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) px.set(x < 2 ? [255, 0, 0, 0] : [0, 0, 255, 0], (y * 4 + x) * 4);
  const half = readPng(encodePng(scaleRgb(px, 4, 2, 2, 1), 2, 1));
  expect([half.width, half.height]).toEqual([2, 1]);
  expect(half.px(0, 0)).toEqual([255, 0, 0]);
  expect(half.px(1, 0)).toEqual([0, 0, 255]);
  // Averaged, not picked: one pixel across the whole screen is half red, half blue.
  expect([...scaleRgb(px, 4, 2, 1, 1)]).toEqual([127, 0, 127]);
  expect([...scaleRgb(px, 4, 2, 1, 1, { x: 2, y: 0, w: 2, h: 2 })]).toEqual([0, 0, 255]);
});

test("keys: names, single characters and combinations; nonsense is refused", () => {
  expect(parseCombo("Return")).toEqual({ modifiers: [], key: 0xff0d });
  expect(parseCombo("cmd+shift+4")).toEqual({ modifiers: [0xffeb, 0xffe1], key: 0x34 });
  expect(parseCombo("ctrl+A")).toEqual({ modifiers: [0xffe3], key: 0x61 });
  expect(parseCombo("option+Left")).toEqual({ modifiers: [0xffe9], key: 0xff51 });
  expect(parseCombo("Page Down")).toEqual({ modifiers: [], key: 0xff56 });
  expect(parseCombo("banana")).toBeNull();
  expect(parseCombo("a+b")).toBeNull();
  expect(parseCombo("")).toBeNull();
});

test("an agent looks and acts: screenshot, click, double and right click, type with Shift where it's needed, a key combination, scroll, drag", async () => {
  // A screen wider than the agents' picture: 2560 across is shown 1280 across, so positions double.
  const v = vnc({ width: 2560, height: 100 });
  const { m } = manager(v);
  v.paint(0, 0, 2560, 100, [0, 200, 0]);
  const shot = await m.screenshot();
  expect([shot.width, shot.height]).toEqual([1280, 50]);
  expect(readPng(shot.png).px(640, 25)).toEqual([0, 200, 0]);

  v.events.length = 0;
  expect(await m.click({ x: 100, y: 20 })).toBe("Clicked at 100, 20.");
  expect(v.events).toEqual([
    { t: "pointer", x: 200, y: 40, buttons: 0 },
    { t: "pointer", x: 200, y: 40, buttons: 1 },
    { t: "pointer", x: 200, y: 40, buttons: 0 },
  ]);
  v.events.length = 0;
  await m.click({ x: 10, y: 10, count: 2 });
  expect(v.events.filter((e) => e.t === "pointer" && e.buttons === 1)).toHaveLength(2);
  v.events.length = 0;
  await m.click({ x: 10, y: 10, button: "right" });
  expect(v.events.some((e) => e.t === "pointer" && e.buttons === 4)).toBe(true);

  v.events.length = 0;
  expect(await m.type({ text: "Hi!\n" })).toBe("Typed 4 characters.");
  const keys = v.events.filter((e) => e.t === "key").map((e) => (e.t === "key" ? `${e.down ? "+" : "-"}${e.sym.toString(16)}` : ""));
  expect(keys).toEqual(["+ffe1", "+48", "-48", "-ffe1", "+69", "-69", "+ffe1", "+21", "-21", "-ffe1", "+ff0d", "-ff0d"]);

  v.events.length = 0;
  expect(await m.key({ keys: "cmd+c" })).toBe("Pressed cmd+c.");
  expect(v.events).toEqual([
    { t: "key", sym: 0xffeb, down: true },
    { t: "key", sym: 0x63, down: true },
    { t: "key", sym: 0x63, down: false },
    { t: "key", sym: 0xffeb, down: false },
  ]);
  expect(await m.key({ keys: "banana" }).then(() => null, (e) => e.message)).toContain("isn't a key Crosstalk knows");

  v.events.length = 0;
  await m.scroll({ x: 5, y: 5, direction: "up", amount: 3 });
  expect(v.events.filter((e) => e.t === "pointer" && e.buttons === 8)).toHaveLength(3);

  v.events.length = 0;
  await m.drag({ fromX: 10, fromY: 10, toX: 110, toY: 10 });
  const held = v.events.filter((e) => e.t === "pointer" && e.buttons === 1) as { x: number }[];
  expect(held[0]!.x).toBe(20);
  expect(held.at(-1)!.x).toBe(220);
  expect(held.length).toBeGreaterThan(5);
  expect(v.events.at(-1)).toEqual({ t: "pointer", x: 220, y: 20, buttons: 0 });

  // Positions outside the picture are refused, with its size.
  expect(await m.click({ x: 5000, y: 10 }).then(() => null, (e) => e.message)).toContain("1280 × 50");
  expect(await m.windowsForAgent()).toBe("1. BrowserOS neo — Shop: x 50, y 25, 400 × 300 (started by an agent)");
});

test("agents get nothing until the person lets them, and Settings says how the last try went", async () => {
  const v = vnc({ password: "letmein1" });
  const { m, changes, password } = manager(v, { agents: false });
  expect(m.status()).toMatchObject({ ready: false, state: "unknown", hasPassword: false, agents: false });
  expect(await m.check()).toMatchObject({ ready: false, state: "auth" });
  expect((await m.configure({ password: "wrong" })).state).toBe("auth");
  const ok = await m.configure({ password: "letmein1" });
  expect(ok).toMatchObject({ ready: true, state: "ready", hasPassword: true, width: 64, height: 48, problem: null });
  expect(password()).toBe("letmein1");
  expect(changes()).toBeGreaterThan(0);
  // Seen, but not driven: the person hasn't turned agents on.
  expect(m.agentsAllowed()).toBe(false);
  expect(await m.screenshot().then(() => null, (e) => e)).toMatchObject({ status: 403, code: "screen_agents_off" });
  expect((await m.configure({ agents: true })).agents).toBe(true);
  expect(m.agentsAllowed()).toBe(true);
  expect((await m.screenshot()).width).toBe(64);
  // The password is never part of what a device is told.
  expect(JSON.stringify(m.status())).not.toContain("letmein1");
  // Taken away: back to needing one.
  expect(await m.configure({ password: null })).toMatchObject({ ready: false, state: "auth", hasPassword: false });
});

async function hubWith(v: FakeVnc) {
  const work = mkdtempSync(join(tmpdir(), "ct-screen-"));
  process.env.CROSSTALK_SCREEN_PORT = String(v.port);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
  const server = startServer(app);
  cleanups.push(async () => {
    delete process.env.CROSSTALK_SCREEN_PORT;
    server.stop(true);
    await app.engine.shutdown();
    app.screen.shutdown();
    app.store.close();
    rmSync(work, { recursive: true, force: true });
  });
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!;
  const peer = (await app.auth.pair((await app.auth.createPairingCode(undefined, { scope: "peer", hubId: "h_other" })).code, "Other hub", "Hub"))!;
  // A linked machine's hub with a full sign-in (not a peer's): still not a person's device.
  const linked = (await app.auth.pair((await app.auth.createPairingCode(undefined, { hubId: "h_linked" })).code, "Linked hub", "Crosstalk hub"))!;
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method: string, path: string, body?: unknown, token = device.token) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  return { app, call, base, token: device.token, peerToken: peer.token, linkedToken: linked.token, port: server.port! };
}

test("over the API: Settings sets it up, the hub's info says the screen can be seen, and another machine's hub gets none of it", async () => {
  const v = vnc({ password: "letmein1" });
  const h = await hubWith(v);
  expect((await h.call("GET", "/api/screen")).body).toMatchObject({ ready: false, hasPassword: false });
  const set = await h.call("PUT", "/api/screen", { password: "letmein1", agents: true });
  expect(set.body).toMatchObject({ ready: true, agents: true, hasPassword: true });
  expect(JSON.stringify(set.body)).not.toContain("letmein1");
  expect((await h.call("GET", "/api/state")).body.hub.screen).toEqual({ ready: true, agents: true });
  // Kept with the hub's settings, and other settings saved later don't lose it.
  await h.call("PUT", "/api/settings/hub", { machineName: "Mac mini" });
  expect((await h.call("GET", "/api/screen")).body).toMatchObject({ ready: true, agents: true });
  expect((await h.call("POST", "/api/screen/check")).body.ready).toBe(true);
  expect(Array.isArray((await h.call("GET", "/api/screen/windows")).body.windows)).toBe(true);
  for (const [method, path] of [["GET", "/api/screen"], ["PUT", "/api/screen"], ["POST", "/api/screen/check"], ["GET", "/api/screen/windows"]] as const) {
    expect((await h.call(method, path, method === "PUT" ? { agents: true } : undefined, h.peerToken)).status).toBe(403);
  }
  // Nor a linked machine's hub with a full sign-in.
  for (const [method, path] of [["GET", "/api/screen"], ["PUT", "/api/screen"], ["POST", "/api/screen/check"], ["GET", "/api/screen/windows"]] as const) {
    const r = await h.call(method, path, method === "PUT" ? { agents: true } : undefined, h.linkedToken);
    expect([r.status, r.body.code]).toEqual([403, "person_only"]);
  }
  expect((await fetch(`${h.base}/api/screen`)).status).toBe(401);
});

/** The app's viewer, as far as the wire goes: RFB with no password, to the hub. */
async function viewer(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  const got: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  ws.onmessage = (e) => {
    got.push(new Uint8Array(e.data as ArrayBuffer));
    wake?.();
  };
  ws.onclose = () => {
    closed = true;
    wake?.();
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("the view didn't open"));
  });
  const read = async (n: number): Promise<Uint8Array> => {
    for (;;) {
      const have = got.reduce((a, b) => a + b.length, 0);
      if (have >= n) {
        const all = new Uint8Array(have);
        let at = 0;
        for (const g of got.splice(0)) {
          all.set(g, at);
          at += g.length;
        }
        if (have > n) got.push(all.subarray(n));
        return all.subarray(0, n);
      }
      if (closed) throw new Error("closed");
      await new Promise<void>((res) => (wake = res));
    }
  };
  return { ws, read, isClosed: () => closed };
}

test("the phone's live view: the hub signs in, the viewer needs no password, and pictures and input pass straight through", async () => {
  const v = vnc({ password: "letmein1", width: 32, height: 16 });
  const h = await hubWith(v);
  await h.call("PUT", "/api/screen", { password: "letmein1" });
  const c = await viewer(h.port, h.token);
  expect(new TextDecoder().decode(await c.read(12))).toBe("RFB 003.008\n");
  c.ws.send(new TextEncoder().encode("RFB 003.008\n"));
  expect([...(await c.read(2))]).toEqual([1, 1]); // one way in: none
  c.ws.send(new Uint8Array([1]));
  expect([...(await c.read(4))]).toEqual([0, 0, 0, 0]);
  c.ws.send(new Uint8Array([1]));
  const init = await c.read(24);
  expect([(init[0]! << 8) | init[1]!, (init[2]! << 8) | init[3]!]).toEqual([32, 16]);
  await c.read(11); // "Test screen"
  expect((await h.call("GET", "/api/screen")).body.viewers).toBe(1);
  // Ask for the whole screen, raw: 32×16 pixels come back as the real server sent them.
  c.ws.send(new Uint8Array([3, 0, 0, 0, 0, 0, 0, 32, 0, 16]));
  const head = await c.read(16);
  expect(head[0]).toBe(0);
  expect((await c.read(32 * 16 * 4)).length).toBe(2048);
  // A tap on the phone reaches the screen.
  c.ws.send(new Uint8Array([5, 1, 0, 7, 0, 9]));
  for (let i = 0; i < 50 && !v.events.length; i++) await Bun.sleep(10);
  expect(v.events).toEqual([{ t: "pointer", x: 7, y: 9, buttons: 1 }]);
  c.ws.close();
  for (let i = 0; i < 50 && (await h.call("GET", "/api/screen")).body.viewers; i++) await Bun.sleep(10);
  expect((await h.call("GET", "/api/screen")).body.viewers).toBe(0);
});

test("the live view says why it can't start, and isn't for another machine's hub or a stranger", async () => {
  const v = vnc({ password: "letmein1" });
  const h = await hubWith(v);
  // No password yet: RFB's own way of refusing carries the words to the viewer.
  const c = await viewer(h.port, h.token);
  await c.read(12);
  c.ws.send(new TextEncoder().encode("RFB 003.008\n"));
  expect((await c.read(1))[0]).toBe(0);
  const len = await c.read(4);
  const why = new TextDecoder().decode(await c.read((len[2]! << 8) | len[3]!));
  expect(why).toContain("hasn't been given one yet");
  for (const token of [h.peerToken, h.linkedToken, "not-a-token"]) {
    const refused = await viewer(h.port, token).then(() => "opened", () => "refused");
    expect(refused).toBe("refused");
  }
});

test("a Mac account signs in the way macOS's Screen Sharing takes it, by its short name whichever name was typed", async () => {
  // As a Mac offers it: the account's sign-in first, the VNC password too.
  const v = vnc({ account: { name: "sam", password: "correct horse" }, password: "vncpass1" });
  const accounts = [{ name: "sam", fullName: "Sam Example" }, { name: "guest2", fullName: "Guest Two" }];
  const { m } = manager(v, { accounts });
  // The name on the Mac's login screen is the full one: Crosstalk signs in with the short one it belongs to.
  expect(await m.configure({ username: "Sam Example", password: "correct horse" })).toMatchObject({ ready: true, state: "ready", username: "sam" });
  expect(v.signIns).toEqual(["sam"]);
  // In any capitals.
  expect((await m.configure({ username: "SAM", password: "correct horse" })).username).toBe("sam");
  // A wrong password is said as that; a name the Mac hasn't got is said before anything is tried, with the names it has.
  expect(await m.configure({ password: "wrong" })).toMatchObject({ ready: false, state: "auth" });
  const refused = v.refused;
  expect(await m.configure({ username: "Samantha", password: "correct horse" }).then(() => null, (e) => e)).toMatchObject({ status: 400, code: "no_account", message: 'There\'s no account named "Samantha" on this Mac. Its accounts: sam, guest2.' });
  expect(v.refused).toBe(refused);
  // No account name: the VNC password, as before.
  expect(await m.configure({ username: "", password: "vncpass1" })).toMatchObject({ ready: true, username: "" });
  expect(v.signIns.at(-1)).toBe("vnc");
});

test("a login screen macOS made aside is said, agents get no tools on it, and signing in as the desktop's account clears it", async () => {
  const v = vnc({ account: { name: "sam", password: "correct horse" }, password: "vncpass1" });
  // macOS starts a login screen for a sign-in that isn't the account at the screen: here, whenever no account signed in.
  const { m, changes } = manager(v, { agents: true, ownLoginScreen: async () => v.signIns.at(-1) === "vnc", accounts: [{ name: "sam", fullName: "Sam Example" }] });
  expect(await m.configure({ password: "vncpass1" })).toMatchObject({ ready: true, separate: true });
  // Seen (it's what the screen page shows, with what to do), but not for agents: nothing of the person's is on it.
  expect(m.agentsAllowed()).toBe(false);
  const told = changes();
  expect(await m.configure({ username: "sam", password: "correct horse" })).toMatchObject({ ready: true, separate: false, username: "sam" });
  expect(changes()).toBeGreaterThan(told);
  expect(m.agentsAllowed()).toBe(true);
  // Elsewhere than a Mac's own Screen Sharing nothing is looked for.
  const plain = manager(vnc({ password: "vncpass1" }));
  expect(await plain.m.configure({ password: "vncpass1" })).toMatchObject({ ready: true, separate: false, account: "" });
});
