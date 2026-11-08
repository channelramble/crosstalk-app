import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { startServer } from "../src/server";

const line = (o: unknown) => JSON.stringify(o) + "\n";

/** Runs the agents' MCP helper with `env` and calls one tool. */
async function callTool(env: Record<string, string>, name: string, args: Record<string, unknown> = {}) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "mcp"], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe" });
  proc.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }));
  proc.stdin.flush();
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!buf.includes('"id":2')) buf += new TextDecoder().decode((await reader.read()).value);
  proc.kill();
  const res = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
  return { text: res.result.content[0].text as string, isError: !!res.result.isError };
}

test("agents reach the hub's internal API only on its Unix socket, each with its own member key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-internal-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Team", mode: "direct" });
    const a = app.addMember(room.id, { provider: "mock", handle: "alpha" });
    const b = app.addMember(room.id, { provider: "mock", handle: "beta" });
    expect(statSync(app.internalSocket).mode & 0o777).toBe(0o600);

    // With its own key, a member's helper gets in.
    const ok = await callTool(app.mcpLaunch(a).env, "room_members");
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text).you).toBe("alpha");

    // One member's key can't act as another member.
    const forged = await callTool({ ...app.mcpLaunch(a).env, CROSSTALK_MEMBER_ID: b.id }, "room_members");
    expect(forged).toMatchObject({ isError: true });
    expect(forged.text).toContain("forbidden");

    // The network port (which Tailscale publishes) doesn't serve it at all, even with a valid key.
    const tcp = await fetch(`http://127.0.0.1:${server.port}/internal/members`, {
      method: "POST",
      headers: { "x-crosstalk-member": a.id, "x-crosstalk-token": app.internalToken(a.id) },
      body: "{}",
    });
    expect(tcp.status).toBe(404);
  } finally {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // Stopping the server removes its socket.
  expect(() => statSync(app.internalSocket)).toThrow();
});
