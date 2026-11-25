import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { resetFailureLimits, startServer } from "../src/server";

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the socket");
}

test("signing out a device closes its live sockets, clears pushes and leaves other devices connected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-revoke-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  const pair = async (name: string) => (await app.auth.pair((await app.auth.createPairingCode()).code, name, "Web"))!;
  const owner = await pair("Owner");
  const lost = await pair("Lost phone");
  const base = `http://127.0.0.1:${server.port}`;
  const connect = (token: string) => new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?token=${token}`);
  const active = connect(owner.token);
  const revoked = connect(lost.token);
  const received: string[] = [];
  const remaining: string[] = [];
  revoked.onmessage = (e) => received.push(JSON.parse(String(e.data)).t);
  active.onmessage = (e) => remaining.push(JSON.parse(String(e.data)).t);
  const endpoint = "https://example.invalid/push/lost-phone";
  try {
    await eventually(() => received.includes("hello") && remaining.includes("hello"));
    revoked.send(JSON.stringify({ t: "presence", visible: true }));
    await eventually(() => app.push.anyVisible());
    app.push.subscribe(lost.device.id, endpoint);
    app.store.db.query("UPDATE push_subs SET latest = ? WHERE endpoint = ?").run(JSON.stringify({ title: "Private", body: "Reply", url: "./", tag: "reply" }), endpoint);
    const response = await fetch(`${base}/api/devices/${lost.device.id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
    expect(response.status).toBe(200);
    await eventually(() => revoked.readyState === WebSocket.CLOSED);
    expect(app.push.anyVisible()).toBe(false);
    expect(app.push.hasSubscription(lost.device.id)).toBe(false);
    expect(app.push.latest(endpoint)).toBeNull();
    expect(app.store.db.query("SELECT 1 FROM push_subs WHERE device_id = ?").get(lost.device.id)).toBeNull();
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${lost.token}` } })).status).toBe(401);
    received.length = 0;
    app.bus.emit({ t: "pty.data", ptyId: "test", data: "private terminal output" });
    await eventually(() => remaining.includes("pty.data"));
    expect(received).toEqual([]);
    expect(active.readyState).toBe(WebSocket.OPEN);
  } finally { active.close(); revoked.close(); server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a socket rechecks device access before accepting terminal input or sending events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-revoke-race-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  const pair = async () => (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!;
  const inputDevice = await pair();
  const outputDevice = await pair();
  const inputSocket = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?token=${inputDevice.token}`);
  const outputSocket = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?token=${outputDevice.token}`);
  let writes = 0;
  let resizes = 0;
  let output = "";
  app.pty.write = () => { writes++; };
  app.pty.resize = () => { resizes++; };
  outputSocket.onmessage = (e) => { output += String(e.data); };
  try {
    await eventually(() => inputSocket.readyState === WebSocket.OPEN && output.includes("hello"));
    // Direct store revocation stands in for a connection racing an external sign-out.
    app.store.revokeDevice(inputDevice.device.id);
    inputSocket.send(JSON.stringify({ t: "pty.input", ptyId: "test", data: "ignored" }));
    inputSocket.send(JSON.stringify({ t: "pty.resize", ptyId: "test", cols: 10, rows: 10 }));
    await eventually(() => inputSocket.readyState === WebSocket.CLOSED);
    expect(writes).toBe(0);
    expect(resizes).toBe(0);
    app.store.revokeDevice(outputDevice.device.id);
    output = "";
    app.bus.emit({ t: "pty.data", ptyId: "test", data: "must not leave the hub" });
    await eventually(() => outputSocket.readyState === WebSocket.CLOSED);
    expect(output).toBe("");
  } finally { inputSocket.close(); outputSocket.close(); server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("wrong pairing and connect codes are throttled per caller after 20 failures; every API route needs a paired device", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-security-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  resetFailureLimits();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    // Callers behind the proxy on this machine are told apart by the address it forwards for; no header is this machine itself.
    const from = (ip?: string): Record<string, string> => (ip ? { "x-forwarded-for": ip } : {});
    const pair = (code: string, ip?: string) => fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json", ...from(ip) }, body: JSON.stringify({ code, name: "x" }) });
    for (let i = 0; i < 20; i++) expect((await pair("WRONG-CODE", "203.0.113.5")).status).toBe(401);
    // Locked for the caller who guessed: even a real code waits until the window passes.
    const real = await app.auth.createPairingCode();
    expect((await pair(real.code, "203.0.113.5")).status).toBe(429);
    for (let i = 0; i < 20; i++) expect((await fetch(`${base}/api/computers/claim/wrongtoken${i}/script`, { headers: from("203.0.113.5") })).status).toBe(401);
    expect((await fetch(`${base}/api/computers/claim/wrongtokenX/script`, { headers: from("203.0.113.5") })).status).toBe(429);
    // Nobody else is locked out by it: another caller's wrong code is just wrong, and their good code pairs.
    expect((await fetch(`${base}/api/computers/claim/wrongtokenX/script`, { headers: from("203.0.113.6") })).status).toBe(401);
    expect((await pair("WRONG-CODE", "203.0.113.6")).status).toBe(401);
    expect((await pair(real.code, "203.0.113.6")).status).toBe(200);
    expect((await pair((await app.auth.createPairingCode()).code)).status).toBe(200);
    resetFailureLimits();
    expect((await pair((await app.auth.createPairingCode()).code, "203.0.113.5")).status).toBe(200);
    // Without a device token, the app's API refuses everything except the few public endpoints.
    for (const [method, path] of [["GET", "/api/state"], ["GET", "/api/rooms/x/history"], ["POST", "/api/rooms"], ["GET", "/api/settings/defaults"], ["GET", "/api/computers"], ["POST", "/api/computers/invite"], ["GET", "/api/rooms/x/files?path=a"], ["POST", "/api/rooms/x/uploads"], ["GET", "/api/devices"], ["GET", "/api/pty"], ["GET", "/api/setup"], ["POST", "/api/setup/connect"]] as const) {
      expect([method, path, (await fetch(base + path, { method })).status]).toEqual([method, path, 401]);
    }
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  } finally { resetFailureLimits(); server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
