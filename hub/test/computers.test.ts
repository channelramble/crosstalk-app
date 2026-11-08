import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { buildSystemNote } from "../src/engine/prompt";

test("connecting a computer: one-time command, claim, ssh config, agent briefing, disconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-computers-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Mac", "Web"))!;
    const auth = { authorization: `Bearer ${device.token}` };
    // Only paired devices can make a connect command.
    expect((await fetch(`${base}/api/computers/invite`, { method: "POST" })).status).toBe(401);
    const invite = (await (await fetch(`${base}/api/computers/invite`, { method: "POST", headers: auth })).json()) as { command: string };
    const token = invite.command.match(/claim\/([A-Za-z0-9]+)\/script/)![1];
    expect(invite.command).toBe(`curl -fsSL '${base}/api/computers/claim/${token}/script' | sh`);
    // The script it downloads authorizes the hub's key and reports back, without needing a pairing.
    const script = await (await fetch(`${base}/api/computers/claim/${token}/script`)).text();
    expect(script).toContain(app.computers.publicKey());
    expect(script).toContain(`${base}/api/computers/claim/${token}`);
    expect(script).toContain("authorized_keys");
    expect((await fetch(`${base}/api/computers/claim/wrongtoken123/script`)).status).toBe(401);
    // Bad reports are refused; a good one saves the computer under a short name.
    const claim = (body: object) => fetch(`${base}/api/computers/claim/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await claim({ user: "bad user; rm -rf", host: "100.64.0.7", label: "x" })).status).toBe(400);
    const saved = (await (await claim({ user: "jane", host: "127.0.0.1", label: "Jane's MacBook Pro" })).json()) as { name: string; online: boolean };
    expect(saved.name).toBe("macbook");
    expect(saved.online).toBe(false); // no sshd accepting our key in the test
    // The code is single-use.
    expect((await claim({ user: "jane", host: "127.0.0.1", label: "again" })).status).toBe(401);
    const config = readFileSync(app.computers.configPath, "utf8");
    expect(config).toContain("Host macbook\n  HostName 127.0.0.1\n  User jane");
    expect(config).toContain(`IdentityFile "${app.computers.keyPath}"`);
    expect(existsSync(app.computers.keyPath)).toBe(true);
    // Agents are told about it in their room briefing.
    const room = app.createRoom({ name: "R", mode: "direct" });
    const me = { id: "m", roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 } as never;
    expect(buildSystemNote(room, [me], me, app.computers.briefing())).toContain(`ssh -F "${app.computers.configPath}" macbook`);
    const list = (await (await fetch(`${base}/api/computers`, { headers: auth })).json()) as { name: string }[];
    expect(list.map((c) => c.name)).toEqual(["macbook"]);
    const del = await fetch(`${base}/api/computers/macbook`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ revoked: false }); // nothing listening in the test, so access couldn't be removed
    expect(app.computers.list()).toEqual([]);
    expect(app.computers.briefing()).toBeNull();
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("connect script: keeps keys on their own lines, adds ours once, and only says Connected when sign-in works", async () => {
  const { Computers } = await import("../src/computers");
  const { Store } = await import("../src/db");
  const dir = mkdtempSync(join(tmpdir(), "ct-script-"));
  try {
    const computers = new Computers(new Store(":memory:"), join(dir, "hub ssh"));
    const { token } = computers.invite();
    const script = join(dir, "connect.sh");
    await Bun.write(script, computers.script(token, "https://hub.example"));
    // Stand-ins for the tools the script calls, so it runs here without sshd, Tailscale or the network.
    const bin = join(dir, "bin");
    const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    mkdirSync(bin);
    const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    stub("nc", "exit 0");
    stub("tailscale", "echo 100.64.0.7");
    stub("scutil", "echo \"Jane's MacBook Pro\"");
    const home = join(dir, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh/authorized_keys"), "ssh-ed25519 AAAAexisting someone@else"); // no final newline
    const run = (online: boolean) => {
      stub("curl", `echo '{"name":"macbook","online":${online}}'`);
      return Bun.spawnSync(["sh", script], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
    };
    const ok = run(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("Connected to Crosstalk");
    const lines = readFileSync(join(home, ".ssh/authorized_keys"), "utf8").trim().split("\n");
    expect(lines).toEqual(["ssh-ed25519 AAAAexisting someone@else", computers.publicKey()]);
    // Running it again doesn't add the key twice; a failed sign-in is reported, not "Connected".
    const failed = run(false);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.toString()).toContain("couldn't sign in");
    expect(failed.stdout.toString()).not.toContain("Connected to Crosstalk");
    expect(readFileSync(join(home, ".ssh/authorized_keys"), "utf8").trim().split("\n").length).toBe(2);
    // A storage path with spaces still gives an ssh config that ssh accepts.
    const { token: t2 } = computers.invite();
    await computers.claim(t2, { user: "jane", host: "127.0.0.1", label: "MacBook" });
    const parsed = Bun.spawnSync(["ssh", "-G", "-F", computers.configPath, "macbook"]);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.toString()).toContain(`identityfile ${computers.keyPath}`);
    // Dropped connections fail fast instead of hanging an agent's command.
    expect(parsed.stdout.toString()).toContain("serveraliveinterval 15");
    expect(parsed.stdout.toString()).toContain("serveralivecountmax 3");
    // A config written by an older hub is refreshed when the hub starts.
    writeFileSync(computers.configPath, "Host macbook\n  HostName 127.0.0.1\n");
    const store = (computers as unknown as { store: unknown }).store;
    const again = new Computers(store as never, computers.dir);
    expect(readFileSync(again.configPath, "utf8")).toContain("ServerAliveInterval 15");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("reconnecting the same computer keeps its name and completes its own invite; disconnect reports revocation", async () => {
  const { Computers } = await import("../src/computers");
  const { Store } = await import("../src/db");
  const dir = mkdtempSync(join(tmpdir(), "ct-reconnect-"));
  try {
    const computers = new Computers(new Store(":memory:"), dir);
    const a = computers.invite();
    await computers.claim(a.token, { user: "jane", host: "127.0.0.1", label: "Jane's MacBook Pro" });
    const b = computers.invite();
    expect(await computers.inviteStatus(b.token)).toEqual({ connected: null, waiting: true });
    await computers.claim(b.token, { user: "jane", host: "127.0.0.1", label: "Jane's MacBook Pro" });
    const status = await computers.inviteStatus(b.token);
    expect(status.connected?.name).toBe("macbook");
    expect(computers.list().map((c) => c.name)).toEqual(["macbook"]);
    // Unreachable computer: still removed from the list, but the caller learns access may remain.
    expect(await computers.remove("macbook")).toEqual({ revoked: false });
    expect(computers.list()).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

test("revoking access removes only our key, and a failure never touches the other keys", async () => {
  const { Computers } = await import("../src/computers");
  const { Store } = await import("../src/db");
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ct-revoke-"));
  try {
    const computers = new Computers(new Store(":memory:"), join(dir, "hub"));
    const ours = computers.publicKey();
    const home = join(dir, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const ak = join(home, ".ssh/authorized_keys");
    const run = (path = "/usr/bin:/bin") => Bun.spawnSync(["sh", "-c", computers.revokeScript()], { env: { HOME: home, PATH: path } });
    // Normal case: our key goes, the others stay.
    writeFileSync(ak, `ssh-ed25519 AAAAother1 a@b\n${ours}\nssh-rsa AAAAother2 c@d\n`);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(ak, "utf8")).toBe("ssh-ed25519 AAAAother1 a@b\nssh-rsa AAAAother2 c@d\n");
    // Our key was the only one: the file ends up empty, which is success.
    writeFileSync(ak, `${ours}\n`);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(ak, "utf8")).toBe("");
    // If reading fails, the original file is left exactly as it was and the result is a failure.
    const original = `ssh-ed25519 AAAAother1 a@b\n${ours}\n`;
    writeFileSync(ak, original);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "grep"), "#!/bin/sh\necho 'grep: read error' >&2\nexit 2\n");
    chmodSync(join(bin, "grep"), 0o755);
    expect(run(`${bin}:/usr/bin:/bin`).exitCode).not.toBe(0);
    expect(readFileSync(ak, "utf8")).toBe(original);
    expect(Bun.spawnSync(["ls", "-a", join(home, ".ssh")]).stdout.toString()).not.toContain(".crosstalk.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows: a PowerShell connect script, saved as Windows, and agents told to use cmd/PowerShell there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-computers-win-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Mac", "Web"))!;
    const invite = (await (await fetch(`${base}/api/computers/invite`, { method: "POST", headers: { authorization: `Bearer ${device.token}` } })).json()) as { command: string; windowsCommand: string };
    const token = invite.command.match(/claim\/([A-Za-z0-9]+)\/script/)![1];
    expect(invite.windowsCommand).toBe(`irm '${base}/api/computers/claim/${token}/ps1' | iex`);
    const ps1 = await (await fetch(`${base}/api/computers/claim/${token}/ps1`)).text();
    expect(ps1).toContain(app.computers.publicKey());
    expect(ps1).toContain(`'${base}/api/computers/claim/${token}'`);
    expect(ps1).toContain("administrators_authorized_keys");
    expect(ps1).toContain("Add-WindowsCapability");
    expect(ps1).toContain("os = 'windows'");
    expect(ps1).not.toContain("${"); // nothing left un-filled from the template
    expect(ps1).toContain("Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'");
    // The PC reports back; it's saved as Windows, and the briefing says how to run commands there.
    const r = await fetch(`${base}/api/computers/claim/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "user", host: "127.0.0.1", label: "GAMING-PC", os: "windows" }) });
    expect(r.status).toBe(200);
    expect(app.computers.list()[0]).toMatchObject({ name: "gaming-pc", os: "windows", user: "user" });
    const b = app.computers.briefing()!;
    expect(b).toContain("gaming-pc (GAMING-PC, Windows)");
    expect(b).toContain("cmd.exe");
    expect(b).not.toContain("$SHELL");
  } finally {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
