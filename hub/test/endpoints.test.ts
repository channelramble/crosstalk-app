import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { endpointAddress } from "../src/providers";
import { startServer } from "../src/server";

/** A stand-in llama.cpp server: its model list and its /props with the context size. */
function fakeLlama(opts: { key?: string } = {}) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (opts.key && req.headers.get("authorization") !== `Bearer ${opts.key}`) return new Response("{}", { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: "qwen3.8-27b", object: "model", owned_by: "llamacpp" }] });
      if (path === "/props") return Response.json({ default_generation_settings: { n_ctx: 65536 }, model_path: "/models/q.gguf" });
      return new Response("not found", { status: 404 });
    },
  });
}

test("model server addresses: scheme added, /v1 and trailing slashes dropped", () => {
  expect(endpointAddress("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(endpointAddress("http://localhost:8080/v1/")).toBe("http://localhost:8080");
  expect(endpointAddress("https://gpu-box.tailnet.ts.net/llm/v1")).toBe("https://gpu-box.tailnet.ts.net/llm");
  expect(() => endpointAddress("http://user:pw@host")).toThrow("API key field");
});

test("custom models: checking a server, the account, Claude Code's environment and the model list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-endpoint-"));
  const server = fakeLlama({ key: "sk-local-123" });
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Checking: models, context size and what kind of server it is; a missing key is called out.
    await expect(app.providers.probeEndpoint(base)).rejects.toThrow("wants an API key");
    expect(await app.providers.probeEndpoint(`${base}/v1`, "sk-local-123")).toEqual({ baseUrl: base, models: ["qwen3.8-27b"], contextWindow: 65536, server: "llama.cpp" });
    await expect(app.providers.probeEndpoint("http://127.0.0.1:1")).rejects.toThrow("No model answered");

    // The account: listed as a custom model, ready to use, with no sign-in.
    expect(() => app.providers.setEndpointAccount("claude", { baseUrl: base, models: [] })).toThrow("at least one model");
    expect(() => app.providers.setEndpointAccount("claude", { baseUrl: base, models: ["q"], contextWindow: 12 })).toThrow("number of tokens");
    const account = app.providers.setEndpointAccount("claude", { label: "Qwen local", baseUrl: `${base}/v1`, apiKey: "sk-local-123", models: "qwen3.8-27b, other-model", contextWindow: 65536 });
    expect(account).toMatchObject({ kind: "endpoint", label: "Qwen local", signedIn: true, plan: "Your own model", endpoint: { baseUrl: base, models: ["qwen3.8-27b", "other-model"], contextWindow: 65536, hasKey: true } });

    // Claude Code talks to the server, with every model it would pick set to the server's, never the hub's own key.
    process.env.ANTHROPIC_API_KEY = "sk-ant-main-account";
    const env = app.providers.agentEnv("claude", account.id);
    delete process.env.ANTHROPIC_API_KEY;
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: "sk-local-123",
      ANTHROPIC_MODEL: "qwen3.8-27b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.8-27b",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.8-27b",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "qwen3.8-27b",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3.8-27b",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16384",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined(); // sessions stay where the Claude app finds them

    // The chat's model list is what the server serves.
    const catalog = await app.providers.models("claude", account.id);
    expect(catalog.models.map((m) => [m.id, m.isDefault])).toEqual([["qwen3.8-27b", true], ["other-model", false]]);

    // Changing it keeps the key unless a new one is given; an empty one removes it (a server without a key).
    const changed = app.providers.setEndpointAccount("claude", { id: account.id, baseUrl: base, models: ["qwen3.8-27b"] });
    expect(changed.endpoint).toMatchObject({ models: ["qwen3.8-27b"], contextWindow: null, hasKey: true });
    const keyless = app.providers.setEndpointAccount("claude", { id: account.id, baseUrl: base, models: ["qwen3.8-27b"], apiKey: "" });
    expect(keyless.endpoint?.hasKey).toBe(false);
    expect(app.providers.agentEnv("claude", account.id).ANTHROPIC_AUTH_TOKEN).toBe("crosstalk-local");

    app.providers.removeAccount("claude", account.id);
    expect(app.providers.accounts().some((a) => a.id === account.id)).toBe(false);
  } finally {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hub that once ran a model pool: its rows and its account stay as they were, nothing of it starts, and its routes are gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-had-pool-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  // What Crosstalk 0.8.1 left in the database: the pool's settings and notes, and the account it made for its server.
  const left = app.providers.setEndpointAccount("codex", { label: "Model pool", baseUrl: "http://127.0.0.1:9931", apiKey: "ctpool-0123456789abcdef", models: ["qwen3-235b"], contextWindow: 65536 });
  const rows: Record<string, string> = {
    pool: JSON.stringify({ build: "b11669", machines: [{ id: "self", kind: "self", name: "Mac mini", address: null, os: "macos", backend: "metal", enabled: true, rpcPort: 50052 }], mainId: "self", model: { repo: "unsloth/Qwen3-235B-GGUF", files: ["Qwen3-235B-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 1, gated: false }, contextSize: 65536, alias: "qwen3-235b", port: 9931, autostart: true }),
    "pool.accounts": JSON.stringify({ codex: left.id }),
    "pool.wasRunning": "1",
    "pool.states": "[]",
    "pool.left": JSON.stringify([{ hub: "h_gone0001", run: "r1" }]),
    "pool.commands": "{}",
  };
  for (const [k, v] of Object.entries(rows)) app.store.kvSet(k, v);
  await app.start();
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
    const call = (method: string, path: string) => fetch(base + path, { method, headers: { authorization: `Bearer ${device.token}` } });
    // The app is told of no pool, and the account is an ordinary model server's at its address.
    const state = (await (await call("GET", "/api/state")).json()) as { pool?: unknown; accounts: { id: string; kind?: string; label: string; endpoint?: { baseUrl: string; models: string[] } }[] };
    expect(state.pool).toBeUndefined();
    expect(state.accounts.find((a) => a.id === left.id)).toMatchObject({ kind: "endpoint", label: "Model pool", endpoint: { baseUrl: "http://127.0.0.1:9931", models: ["qwen3-235b"] } });
    // What an older linked machine (or an app that hasn't reloaded) still asks for is simply not there.
    for (const [method, path] of [["GET", "/api/pool"], ["POST", "/api/pool/start"], ["POST", "/api/pool/stop"], ["GET", "/api/pool/node"], ["POST", "/api/pool/node/server"], ["PUT", "/api/pool/hf-token"]] as const) {
      expect([path, (await call(method, path)).status]).toEqual([path, 404]);
    }
    // Nothing was read, changed or cleared.
    for (const [k, v] of Object.entries(rows)) expect([k, app.store.kvGet(k)]).toEqual([k, v]);
  } finally {
    server.stop(true);
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
