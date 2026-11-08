// The model pool's controller (hub/src/pool/pool.ts, commands.ts, tailscale.ts) against fakes only: hubs are real Apps
// on loopback ports linked like Settings → Machines links them, llama.cpp is the fake llama-server / ggml-rpc-server
// from a fake GitHub release, models come from a fake Hugging Face, Tailscale is the fake CLI, and a computer's helper
// is a plain TCP listener. CROSSTALK_POOL_LOOPBACK=1 keeps every helper and server on 127.0.0.1. Nothing connects to a
// Tailscale (100.x) address, nothing is downloaded from the internet, and nothing is left running.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolBackend, PoolMachine, PoolModel, PoolModelChoices, PoolView } from "@crosstalk/shared";
import { App } from "../src/app";
import { readSecrets, writeSecret } from "../src/config";
import { startServer } from "../src/server";
import { helperCommand } from "../src/pool/commands";
import { hostPlatform, llamaDir } from "../src/pool/llama";
import { modelPath, modelsDir, quantOf } from "../src/pool/models";
import { aliasFor, gpuName, HF_SECRET, KEY_SECRET, loadingDetail, parseMetrics, Pool, poolFit } from "../src/pool/pool";
import { goDurationMs, parsePing, parseStatus } from "../src/pool/tailscale";
import { cudartTarball, fakeGitHub, fakeHuggingFace, freePort, installScript, llamaTarball } from "./fixtures/pool-fakes";

const BUILD = "b11669";
const MAC = hostPlatform().os === "macos";
const TOKEN = "hf_pooltesttoken0123456789";
const TS_IP = "100.101.102.103";
/** Starting a pool takes a few seconds (a helper settles for 1.5 s, the model loads, …): flows get longer than the default 5 s. */
const SLOW = 60_000;

const work = realpathSync(mkdtempSync(join(tmpdir(), "ct-pool-ctl-")));
const llamaLog = join(work, "llama.jsonl");
const rpcLog = join(work, "rpc.jsonl");
const pingsFile = join(work, "pings.txt");
const statusFile = join(work, "tailscale-status.json");
const fakeTailscale = join(work, "tailscale");
const ENV = [
  "CROSSTALK_GITHUB_API",
  "CROSSTALK_LLAMA_RELEASES",
  "CROSSTALK_HF_URL",
  "CROSSTALK_TAILSCALE_BIN",
  "CROSSTALK_POOL_LOOPBACK",
  "CROSSTALK_NO_AGENT_CLIS",
  "FAKE_TAILSCALE_IP",
  "FAKE_TAILSCALE_PINGS",
  "FAKE_TAILSCALE_STATUS",
  "FAKE_LLAMA_LOG",
  "FAKE_RPC_LOG",
  "FAKE_LLAMA_LOAD_MS",
  "FAKE_LLAMA_FIT_CTX",
  "FAKE_LLAMA_SPEED",
  "FAKE_LLAMA_DEVICES",
  "FAKE_LLAMA_RPC_DEVICES",
  "FAKE_LLAMA_RPC_HANG",
];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const savedSecrets = { hf: readSecrets()[HF_SECRET] ?? null, key: readSecrets()[KEY_SECRET] ?? null };

const bytes = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 8)) & 255;
  return b;
};
const FILES: Record<string, Uint8Array> = {
  "Tiny-Q4_K_M.gguf": bytes(300_000, 1),
  "Tiny-Q8_0.gguf": bytes(520_000, 2),
  "Slow-Q2_K.gguf": bytes(1_200_000, 8),
  "mmproj-Tiny-F16.gguf": bytes(90_000, 4),
};
const GATED = bytes(200_000, 9);
const BROKEN = new TextEncoder().encode("BROKEN model file, not GGUF");
const tiny = (file: string): PoolModel => ({ repo: "acme/Tiny-GGUF", files: [file], quant: quantOf(file), sizeBytes: FILES[file].length, gated: false });
const gated: PoolModel = { repo: "acme/Gated-GGUF", files: ["Gated-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: GATED.length, gated: true };
const broken: PoolModel = { repo: "acme/Broken-GGUF", files: ["Broken-Q4_0.gguf"], quant: "Q4_0", sizeBytes: BROKEN.length, gated: false };

let gh: ReturnType<typeof fakeGitHub>;
let hf: ReturnType<typeof fakeHuggingFace>;

type Res<T = any> = { status: number; data: T }; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Hub {
  app: App;
  name: string;
  base: string;
  token: string;
  events: { at: number; view: PoolView }[];
  /** Every request the pool's machine layer here was asked to do (POST /api/pool/node/…, or this hub's own pool). */
  asked: { kind: string; body: Record<string, unknown> }[];
  changed: string[];
  api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<Res<T>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  stopServing(): void;
  close(): Promise<void>;
}
const hubs: Hub[] = [];

/** A hub with an in-memory database on a loopback port, a person's device paired to it, and quick pool timers. */
async function hub(name: string): Promise<Hub> {
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: join(work, "workspaces"), maxHopsDefault: 6 } });
  // autoClean off: a test must never clear this Mac's real caches.
  app.setHubSettings({ machineName: name, storage: { autoClean: false, lowSpaceGb: 15 } });
  app.poolNode.trashOptions = { home: join(work, "trash-home"), gio: false };
  app.pool.watchMs = { self: 100, hub: 150 };
  app.pool.metricsMs = 50;
  app.pool.restartDelayMs = 300;
  // A safety net: a computer at a Tailscale address is never really connected to from a test.
  const probe = app.pool.probe;
  app.pool.probe = (host, port) => (host.startsWith("100.") ? Promise.resolve(answering.has(`${host}:${port}`)) : probe(host, port));
  let server: ReturnType<typeof startServer> | null = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  app.config.publicUrl = base;
  const token = (await app.auth.pair((await app.auth.createPairingCode()).code, `${name} phone`, "Web"))!.token;
  const h: Hub = {
    app,
    name,
    base,
    token,
    events: [],
    asked: [],
    changed: [],
    async api(method, path, body, as = token) {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* text */
      }
      return { status: res.status, data: data as never };
    },
    stopServing() {
      server?.stop(true);
      server = null;
    },
    async close() {
      h.stopServing();
      await app.shutdown();
    },
  };
  app.bus.on((e) => {
    if (e.t === "pool") h.events.push({ at: Date.now(), view: e.pool });
  });
  const handle = app.poolNode.handle.bind(app.poolNode);
  app.poolNode.handle = (kind, body) => {
    h.asked.push({ kind, body: (body ?? {}) as Record<string, unknown> });
    return handle(kind, body);
  };
  const memberChanged = app.engine.memberChanged.bind(app.engine);
  app.engine.memberChanged = (id) => {
    h.changed.push(id);
    return memberChanged(id);
  };
  hubs.push(h);
  return h;
}

/** Computers' helpers that answer, for the probe stand-in above ("<address>:<port>"). */
const answering = new Set<string>();

/** A person links `to` from `from` with a pairing code shown on `to` (Settings → Machines). */
async function link(from: Hub, to: Hub) {
  const { code } = await to.app.auth.createPairingCode();
  const r = await from.api("POST", "/api/machines/link", { url: to.base, code });
  expect(r.status).toBe(200);
}

/** A computer's helper: a TCP listener that counts connections (ggml-rpc-server serves one client at a time). */
function helperListener() {
  let connections = 0;
  const l = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        connections++;
      },
      data() {},
    },
  });
  return { port: l.port, connections: () => connections, stop: () => l.stop(true) };
}

const selfMachine = (enabled: boolean, rpcPort = 50052): PoolMachine => ({ id: "self", kind: "self", name: "", address: null, os: null, backend: null, enabled, rpcPort });
const hubMachine = (h: Hub, enabled: boolean, rpcPort: number): PoolMachine => ({ id: h.app.hubId(), kind: "hub", name: h.name, address: null, os: null, backend: null, enabled, rpcPort });
const computer = (id: string, name: string, rpcPort: number, address = "127.0.0.1", extra: Partial<PoolMachine> = {}): PoolMachine => ({
  id,
  kind: "computer",
  name,
  address,
  os: "windows",
  backend: "vulkan",
  enabled: true,
  rpcPort,
  ...extra,
});

const runs = (file: string): { argv: string[]; pid: number; apiKey?: string | null; cache: string | null }[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const state = (h: Hub) => h.app.pool.view().status;
const machineState = (h: Hub, id: string) => h.app.pool.view().machines.find((m) => m.id === id)!;
async function settled(h: Hub, ms = 30_000) {
  await until(() => ["running", "error", "off"].includes(state(h).state), `${h.name}'s pool to settle`, ms);
  return state(h);
}
async function put(h: Hub, config: Record<string, unknown>) {
  const r = await h.api<PoolView>("PUT", "/api/pool", { config });
  expect([r.status, (r.data as unknown as { error?: string }).error ?? null]).toEqual([200, null]);
  return r.data;
}
async function stopPool(h: Hub) {
  const r = await h.api<PoolView>("POST", "/api/pool/stop");
  expect(r.status).toBe(200);
  expect(r.data.status.state).toBe("off");
  return r.data;
}

beforeAll(async () => {
  const tarball = await llamaTarball(work, BUILD);
  const cudart = await cudartTarball(work);
  gh = fakeGitHub({
    [BUILD]: {
      [`llama-${BUILD}-bin-macos-arm64.tar.gz`]: { bytes: tarball },
      [`llama-${BUILD}-bin-ubuntu-vulkan-x64.tar.gz`]: { bytes: tarball },
      [`llama-${BUILD}-bin-ubuntu-x64.tar.gz`]: { bytes: tarball },
      [`llama-${BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`]: { bytes: tarball },
      [`cudart-llama-${BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`]: { bytes: cudart },
    },
  });
  hf = fakeHuggingFace(
    {
      "acme/Tiny-GGUF": { files: FILES },
      "acme/Gated-GGUF": { gated: "manual", files: { "Gated-Q4_K_M.gguf": GATED } },
      "acme/Broken-GGUF": { files: { "Broken-Q4_0.gguf": BROKEN } },
    },
    { token: TOKEN },
  );
  hf.slow.add("acme/Tiny-GGUF/Slow-Q2_K.gguf");
  installScript("fake-tailscale", fakeTailscale);
  // The release files the helper command downloads, for the fake curl.
  mkdirSync(join(work, "assets"));
  for (const name of [`llama-${BUILD}-bin-ubuntu-vulkan-x64.tar.gz`, `llama-${BUILD}-bin-macos-arm64.tar.gz`, `llama-${BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`]) writeFileSync(join(work, "assets", name), tarball);
  writeFileSync(join(work, "assets", `cudart-llama-${BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`), cudart);
  Object.assign(process.env, {
    CROSSTALK_GITHUB_API: gh.api,
    CROSSTALK_LLAMA_RELEASES: gh.releases,
    CROSSTALK_HF_URL: hf.url,
    CROSSTALK_TAILSCALE_BIN: fakeTailscale,
    CROSSTALK_POOL_LOOPBACK: "1",
    // Never find (or start) the real agent CLIs.
    CROSSTALK_NO_AGENT_CLIS: "1",
    FAKE_TAILSCALE_PINGS: pingsFile,
    FAKE_LLAMA_LOG: llamaLog,
    FAKE_RPC_LOG: rpcLog,
    FAKE_LLAMA_LOAD_MS: "300",
  });
  delete process.env.FAKE_TAILSCALE_IP;
  delete process.env.FAKE_TAILSCALE_STATUS;
  writeSecret(HF_SECRET, null);
});

afterAll(async () => {
  for (const h of hubs.splice(0)) await h.close().catch(() => {});
  gh?.stop();
  hf?.stop();
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  writeSecret(HF_SECRET, savedSecrets.hf);
  writeSecret(KEY_SECRET, savedSecrets.key);
  // The "Model pool" accounts' copies of the key (the secrets file is shared by the test run).
  for (const [k, v] of Object.entries(readSecrets())) if (k.startsWith("apikey:") && v.startsWith("ctpool-")) writeSecret(k, null);
  // The hub's home is shared by the test run: leave no builds or models for other tests to find.
  rmSync(llamaDir(), { recursive: true, force: true });
  rmSync(modelsDir(), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("plain helpers", () => {
  test("a short name for chats from the model's repo", () => {
    expect(aliasFor({ repo: "unsloth/Qwen3.8-27B-GGUF" })).toBe("qwen3.8-27b");
    expect(aliasFor({ repo: "orcarouter/Qwen3.8-27B-Instruct-GGUF" })).toBe("qwen3.8-27b-instruct");
    expect(aliasFor({ repo: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF" })).toBe("kimi-linear-48b-a3b-instruct");
    expect(aliasFor({ repo: "ggml-org/gpt-oss-20b-GGUF" })).toBe("gpt-oss-20b");
    expect(aliasFor({ repo: "acme/Tiny-GGUF" })).toBe("tiny");
    expect(aliasFor({ repo: "acme/---" })).toBe("pool-model");
    expect(aliasFor(null)).toBe("");
  });

  test("tailscale ping: direct or through a relay, and its round trip", () => {
    expect(parsePing("pong from linux-box (100.64.0.2) via DERP(nyc) in 45ms\n")).toEqual({ ms: 45, direct: false });
    expect(parsePing("pong from win-pc (100.64.0.3, 51234) via 192.168.1.20:41641 in 3ms")).toEqual({ ms: 3, direct: true });
    expect(parsePing("pong from mac (100.64.0.4) via [2001:db8::1]:41641 in 1.234s")).toEqual({ ms: 1234, direct: true });
    expect(parsePing('ping "100.64.0.5" timed out\n')).toBeNull();
    expect(goDurationMs("512µs")).toBe(0.5);
    expect(goDurationMs("1m2s")).toBe(62_000);
    expect(goDurationMs("soon")).toBeNull();
  });

  test("tailscale status: the other devices, this hub left out, direct from CurAddr", () => {
    const peers = parseStatus({
      BackendState: "Running",
      Self: { HostName: "mac-mini", TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"], OS: "macOS", Online: true },
      Peer: {
        "nodekey:a": { HostName: "gaming-rig", DNSName: "gaming-rig.tail1234.ts.net.", TailscaleIPs: ["100.64.0.9", "fd7a:115c:a1e0::9"], OS: "windows", Online: true, CurAddr: "192.168.1.20:41641" },
        "nodekey:b": { HostName: "linux-box", TailscaleIPs: ["100.64.0.2"], OS: "linux", Online: true, CurAddr: "", Relay: "fra" },
        "nodekey:c": { HostName: "", DNSName: "my-phone.tail1234.ts.net.", TailscaleIPs: ["100.64.0.10"], OS: "iOS", Online: false, CurAddr: "" },
        "nodekey:d": { HostName: "ipv6-only", TailscaleIPs: ["fd7a:115c:a1e0::20"], OS: "linux", Online: true },
        "nodekey:e": { HostName: "mac-mini-again", TailscaleIPs: ["100.64.0.1"], OS: "macOS", Online: true },
      },
    });
    expect(peers).toEqual([
      { name: "gaming-rig", address: "100.64.0.9", os: "windows", online: true, direct: true },
      { name: "linux-box", address: "100.64.0.2", os: "linux", online: true, direct: false },
      { name: "my-phone", address: "100.64.0.10", os: "iOS", online: false, direct: null },
    ]);
    expect(parseStatus({ BackendState: "Running", Self: {}, Peer: null })).toEqual([]);
  });

  test("the speed from /metrics, once there's been a reply", () => {
    const text = "# HELP x\nllamacpp:prompt_tokens_total 32\nllamacpp:prompt_tokens_seconds 349.6\nllamacpp:predicted_tokens_seconds 18.23\n";
    expect(parseMetrics(text)).toEqual({ prompt: 349.6, generation: 18.2 });
    expect(parseMetrics("llamacpp:prompt_tokens_seconds 0\nllamacpp:predicted_tokens_seconds 0\n")).toEqual({ prompt: null, generation: null });
    expect(parseMetrics("")).toEqual({ prompt: null, generation: null });
  });

  test("GPU names and what loading looks like", () => {
    expect(gpuName("AMD Radeon RX 7600 XT (RADV NAVI33)")).toBe("RX 7600 XT");
    expect(gpuName("NVIDIA GeForce RTX 3060")).toBe("RTX 3060");
    expect(gpuName("NVIDIA GeForce RTX 4070 SUPER")).toBe("RTX 4070 Super");
    expect(gpuName("Apple M4")).toBe("Apple M4");
    expect(gpuName("AMD Radeon Graphics (RADV RAPHAEL_MENDOCINO)")).toBe("AMD Radeon Graphics");
    expect(loadingDetail(["I srv    load_model: loading model 'x.gguf'"], 2_000, "Linux box", true)).toBe("Loading the model on Linux box: reading the model.");
    expect(loadingDetail(["load_tensors: offloaded 20/49 layers to GPU"], 125_000, "Linux box", true)).toBe(
      "Loading the model on Linux box: 20 of 49 layers placed (2 min so far). The helpers get their part over the network, which takes a while the first time.",
    );
    expect(loadingDetail([], 0, "Mac mini", false)).toBe("Loading the model on Mac mini.");
  });
});

describe("the fit", () => {
  const mac: PoolMachine = { id: "self", kind: "self", name: "Mac mini", address: null, os: "macos", backend: null, enabled: false, rpcPort: 50052 };
  const linux: PoolMachine = { id: "h_linuxbox01", kind: "hub", name: "Linux box", address: "100.64.0.2", os: "linux", backend: null, enabled: true, rpcPort: 50052 };
  const pc: PoolMachine = { id: "pc_gaming01", kind: "computer", name: "Gaming PC", address: "100.64.0.9", os: "windows", backend: "cuda", enabled: true, rpcPort: 50052 };
  const GiB = 1024 ** 3;
  const devices: Record<string, { name: string; description: string; totalMiB: number; freeMiB: number }[]> = {
    self: [{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }],
    h_linuxbox01: [{ name: "Vulkan0", description: "AMD Radeon RX 7600 XT (RADV NAVI33)", totalMiB: 16304, freeMiB: 15890 }],
  };
  const of = (m: PoolMachine) => (m.kind === "computer" ? null : (devices[m.id] ?? null));
  const model = (gb: number): PoolModel => ({ repo: "acme/Big-GGUF", files: ["Big-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: gb * GiB, gated: false });

  test("needs the model, its context and 1 GiB per machine; fitting one GPU says to run it there alone", () => {
    const fit = poolFit({ model: model(10), contextSize: 32768, machines: [mac, linux, pc] }, of)!;
    // 10 GiB + 32768 × 96 KiB (3 GiB) + 2 × 1 GiB.
    expect(fit.needMiB).toBe(10240 + 3072 + 2048);
    // The Mac is left out, and a computer's memory isn't known.
    expect(fit.haveMiB).toBe(15890);
    expect(fit.fits).toBe(true);
    expect(fit.note).toBe("Fits the RX 7600 XT alone: leave the others out to run it at full speed.");
    // Already alone there: nothing to say.
    expect(poolFit({ model: model(10), contextSize: 32768, machines: [mac, linux, { ...pc, enabled: false }] }, of)!.note).toBeNull();
  });

  test("too big: says what isn't counted, or how much more it needs", () => {
    const big = poolFit({ model: model(30), contextSize: 32768, machines: [mac, linux, pc] }, of)!;
    expect(big.fits).toBe(false);
    expect(big.note).toBe("Crosstalk can't see the GPU memory of Gaming PC, so it isn't counted here.");
    const known = poolFit({ model: model(30), contextSize: 32768, machines: [{ ...mac, enabled: true }, linux] }, of)!;
    expect(known).toMatchObject({ needMiB: 30720 + 3072 + 2048, haveMiB: 12123 + 15890, fits: false });
    expect(known.note).toBe(`Needs about ${((30720 + 3072 + 2048 - 12123 - 15890) / 1024).toFixed(1)} GB more: switch on another machine, or pick a smaller quant or context.`);
    const unchecked = poolFit({ model: model(30), contextSize: 32768, machines: [mac, linux] }, (m) => (m.kind === "hub" ? null : of(m)))!;
    expect(unchecked).toMatchObject({ haveMiB: 0, fits: false, note: "Check the machines to count the GPU of Linux box." });
    expect(poolFit({ model: null, contextSize: 32768, machines: [mac] }, of)).toBeNull();
  });
});

describe("helper commands", () => {
  const base = { build: BUILD, port: 50052, address: "100.64.0.9" };

  test("Windows with Vulkan: a PowerShell one-liner that pins the build and runs the helper on the Tailscale address", () => {
    const { command, notes } = helperCommand({ ...base, os: "windows", backend: "vulkan" });
    expect(command).toStartWith("& { ");
    expect(command).not.toContain("\n");
    for (const part of [
      "$b='b11669'",
      "$k='vulkan'",
      "$p=50052",
      "$want='100.64.0.9'",
      "Join-Path $env:LOCALAPPDATA 'Crosstalk\\llama'",
      '$d=Join-Path $root "$b-$k"',
      "@($env:ProgramW6432, $env:ProgramFiles)",
      "Join-Path $_ 'Tailscale\\tailscale.exe'",
      "Get-Command tailscale",
      "& $ts ip -4",
      "https://github.com/ggml-org/llama.cpp/releases/download/$b/llama-b11669-bin-win-vulkan-x64.zip",
      "-Filter 'ggml-rpc-server.exe'",
      "-Filter 'rpc-server.exe'",
      "$cache=Join-Path $root 'cache'",
      "$env:LLAMA_CACHE=$cache",
      // The weight cache only with room for it (and cleared when the disk is nearly full).
      "if((Get-Free) -lt $min -and (Test-Path $cache)){ Remove-Item $cache -Recurse -Force",
      "$c=@('-c'); if((Get-Free) -lt $min){ $c=@()",
      "& ($exe.FullName) -H $ip -p $p @c",
    ]) {
      expect([part, command.includes(part)]).toEqual([part, true]);
    }
    // It refuses without Tailscale, and when the PC's own address isn't the one the pool has.
    expect(command).toContain("Tailscale isn't installed on this PC");
    expect(command).toContain("Tailscale isn't running on this PC");
    expect(command).toContain("but Crosstalk has $want for it");
    expect(command).not.toContain("cudart");
    expect(notes).toEqual(expect.arrayContaining(["Leave the window open while you use the pool: closing it stops the helper.", "If Windows asks, allow it on private networks."]));
    expect(notes.join(" ")).toContain("only listens on this PC's Tailscale address");
  });

  test("Windows with NVIDIA: the CUDA 12.4 build and its runtime, unpacked next to the helper", () => {
    const { command, notes } = helperCommand({ ...base, os: "windows", backend: "cuda" });
    expect(command).toContain("$k='cuda'");
    expect(command).toContain("/llama-b11669-bin-win-cuda-12.4-x64.zip");
    expect(command).toContain("/cudart-llama-bin-win-cuda-12.4-x64.zip");
    expect(command.indexOf("llama-b11669-bin-win-cuda-12.4-x64.zip")).toBeLessThan(command.indexOf("cudart-llama-bin-win-cuda-12.4-x64.zip"));
    expect(command).toContain("-DestinationPath ($exe.DirectoryName)");
    expect(notes.join(" ")).toContain("551.61");
  });

  test("Linux and Mac: an sh one-liner into the per-user folder", () => {
    const linux = helperCommand({ ...base, os: "linux", backend: "vulkan" });
    expect(linux.command).toStartWith("sh -c '");
    expect(linux.command.endsWith("'")).toBe(true);
    expect(linux.command).not.toContain("\n");
    // Only the outer quotes: nothing inside can end them.
    expect(linux.command.slice(7, -1)).not.toContain("'");
    for (const part of ["B=b11669", "K=vulkan", "P=50052", "WANT=100.64.0.9", '${XDG_DATA_HOME:-$HOME/.local/share}/crosstalk/llama', "llama-b11669-bin-ubuntu-vulkan-x64.tar.gz", "command -v tailscale", '"$TS" ip -4', 'C="$R/cache"', 'export LLAMA_CACHE="$C"', 'exec "$BIN" -H "$IP" -p "$P" $CACHE']) {
      expect([part, linux.command.includes(part)]).toEqual([part, true]);
    }
    expect(linux.notes.join(" ")).toContain("~/.local/share/crosstalk/llama");
    const cuda = helperCommand({ ...base, os: "linux", backend: "cuda" });
    expect(cuda.command).toContain("llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz");
    expect(cuda.command).toContain("cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz");
    const mac = helperCommand({ ...base, os: "macos", backend: "metal" });
    expect(mac.command).toContain('R="$HOME/Library/Application Support/Crosstalk/llama"');
    expect(mac.command).toContain("llama-b11669-bin-macos-arm64.tar.gz");
    expect(mac.command).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    // Without an address the pool has, nothing is compared.
    expect(helperCommand({ ...base, address: null, os: "linux", backend: "cpu" }).command).toContain('WANT=""');
  });

  test("only checked values go in: impossible systems and backends, old builds and bad ports are refused", () => {
    const refused = (o: Parameters<typeof helperCommand>[0]) => {
      try {
        helperCommand(o);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("expected a refusal");
    };
    expect(refused({ ...base, os: "windows", backend: "metal" })).toContain("Metal is for Macs");
    expect(refused({ ...base, os: "macos", backend: "vulkan" })).toContain("pick Metal for a Mac");
    expect(refused({ ...base, os: "linux", backend: "rocm" as PoolBackend })).toContain("Pick Metal, Vulkan, CUDA or CPU");
    expect(refused({ ...base, os: "beos" as "linux", backend: "cpu" })).toContain("Windows, Linux or Mac");
    expect(refused({ ...base, build: "b10999", os: "linux", backend: "cpu" })).toContain("too old");
    expect(refused({ ...base, build: "b11669'; rm -rf ~", os: "linux", backend: "cpu" })).toContain("like b11669");
    expect(refused({ ...base, port: 80, os: "linux", backend: "cpu" })).toContain("1024 to 65535");
    // A typed address that isn't a Tailscale one is never put in the command.
    expect(helperCommand({ ...base, address: "1.2.3.4; rm -rf /", os: "linux", backend: "cpu" }).command).toContain('WANT=""');
  });

  test("the sh command really installs the pinned build once, finds the helper and runs it on the Tailscale address", async () => {
    const bin = join(work, "cmd-bin");
    mkdirSync(bin, { recursive: true });
    const curlLog = join(work, "curl.log");
    // curl -fL --retry 3 -o <file> <url>: the file from the assets folder.
    writeFileSync(
      join(bin, "curl"),
      '#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --retry) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\necho "$url" >> "$FAKE_CURL_LOG"\nf="$FAKE_ASSETS/$(basename "$url")"\n[ -f "$f" ] || exit 22\ncp "$f" "$out"\n',
    );
    writeFileSync(join(bin, "uname"), '#!/bin/sh\ncase "$1" in -m) echo "$FAKE_UNAME_M";; *) echo "$FAKE_UNAME_S";; esac\n');
    for (const f of ["curl", "uname"]) chmodSync(join(bin, f), 0o755);
    installScript("fake-tailscale", join(bin, "tailscale"));
    const noTs = join(work, "cmd-bin-no-tailscale");
    mkdirSync(noTs, { recursive: true });
    for (const f of ["curl", "uname"]) writeFileSync(join(noTs, f), readFileSync(join(bin, f), "utf8"), { mode: 0o755 });
    const run = async (command: string, home: string, env: Record<string, string>, path = bin) => {
      const p = Bun.spawn(["/bin/sh", "-c", command], {
        // Room for the weight cache whatever this disk has free (a run below says what happens without it).
        env: { PATH: `${path}:/usr/bin:/bin`, HOME: home, FAKE_ASSETS: join(work, "assets"), FAKE_CURL_LOG: curlLog, FAKE_RPC_LOG: join(home, "rpc.jsonl"), FAKE_RPC_EXIT: "1", FAKE_TAILSCALE_IP: TS_IP, CROSSTALK_HELPER_MIN_FREE_GB: "0", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    };

    for (const [os, backend, uname, dir] of [
      ["linux", "vulkan", { FAKE_UNAME_S: "Linux", FAKE_UNAME_M: "x86_64" }, [".local", "share", "crosstalk", "llama"]],
      ["linux", "cuda", { FAKE_UNAME_S: "Linux", FAKE_UNAME_M: "x86_64" }, [".local", "share", "crosstalk", "llama"]],
      ["macos", "metal", { FAKE_UNAME_S: "Darwin", FAKE_UNAME_M: "arm64" }, ["Library", "Application Support", "Crosstalk", "llama"]],
    ] as const) {
      const home = realpathSync(mkdtempSync(join(work, `home-${os}-`)));
      const { command } = helperCommand({ build: BUILD, os, backend, port: 50199, address: TS_IP });
      const before = existsSync(curlLog) ? readFileSync(curlLog, "utf8").split("\n").filter(Boolean).length : 0;
      const first = await run(command, home, uname);
      expect([os, backend, first.code, first.out]).toEqual([os, backend, 0, expect.stringContaining(`at ${TS_IP}:50199`)]);
      const root = join(home, ...dir);
      const ran = runs(join(home, "rpc.jsonl")).at(-1)!;
      expect(ran.argv).toEqual(["-H", TS_IP, "-p", "50199", "-c"]);
      expect(ran.cache).toBe(join(root, "cache"));
      expect(existsSync(join(root, `${BUILD}-${backend}`, ".crosstalk-ok"))).toBe(true);
      if (backend === "cuda") expect(readFileSync(join(root, `${BUILD}-cuda`, `llama-${BUILD}`, "libcudart.so.12"), "utf8")).toBe("fake cudart");
      const fetched = readFileSync(curlLog, "utf8").split("\n").filter(Boolean).slice(before);
      expect(fetched.length).toBe(backend === "cuda" ? 2 : 1);
      // Again: nothing downloaded, the same helper runs.
      const again = await run(command, home, uname);
      expect(again.code).toBe(0);
      expect(readFileSync(curlLog, "utf8").split("\n").filter(Boolean).length).toBe(before + fetched.length);
      expect(runs(join(home, "rpc.jsonl"))).toHaveLength(2);
      // A disk with too little room: the cache it had goes, and the helper runs without one.
      writeFileSync(join(root, "cache", "rpc", "old-tensor"), "weights");
      const full = await run(command, home, { ...uname, CROSSTALK_HELPER_MIN_FREE_GB: "1000000" });
      expect(full.code).toBe(0);
      expect(full.out).toContain("Cleared the weight cache of the helper: the disk is nearly full.");
      expect(full.out).toContain("Not keeping the model weights here: the disk has less than 40 GB free.");
      expect(runs(join(home, "rpc.jsonl")).at(-1)!.argv).toEqual(["-H", TS_IP, "-p", "50199"]);
      expect(existsSync(join(root, "cache", "rpc", "old-tensor"))).toBe(false);
    }

    const home = realpathSync(mkdtempSync(join(work, "home-refusals-")));
    const linux = { FAKE_UNAME_S: "Linux", FAKE_UNAME_M: "x86_64" };
    // The wrong computer: its Tailscale address isn't the one the pool has.
    const wrong = await run(helperCommand({ build: BUILD, os: "linux", backend: "cpu", port: 50199, address: "100.64.0.9" }).command, home, linux);
    expect(wrong).toEqual({ code: 1, out: expect.stringContaining(`This computer has the Tailscale address ${TS_IP}, but Crosstalk has 100.64.0.9 for it.`) });
    // Tailscale stopped, or not there at all.
    const cmd = helperCommand({ build: BUILD, os: "linux", backend: "cpu", port: 50199, address: null }).command;
    expect(await run(cmd, home, { ...linux, FAKE_TAILSCALE_IP: "" })).toEqual({ code: 1, out: expect.stringContaining("Tailscale is not running here.") });
    if (!existsSync("/usr/bin/tailscale") && !existsSync("/bin/tailscale")) {
      expect(await run(cmd, home, linux, noTs)).toEqual({ code: 1, out: expect.stringContaining("Tailscale is not installed here.") });
    }
    // The command for another system says so.
    expect(await run(cmd, home, { FAKE_UNAME_S: "Darwin", FAKE_UNAME_M: "arm64" })).toEqual({ code: 1, out: expect.stringContaining("This command is for Linux") });
    expect(runs(join(home, "rpc.jsonl"))).toHaveLength(0);
  }, SLOW);

  test.if(!!Bun.which("pwsh"))("PowerShell reads the Windows commands without a syntax error", async () => {
    for (const backend of ["vulkan", "cuda", "cpu"] as const) {
      const { command } = helperCommand({ build: BUILD, os: "windows", backend, port: 50052, address: TS_IP });
      // Parsed only, never run.
      const p = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:CMD, [ref]$null, [ref]$e); $e.Count"], {
        env: { ...process.env, CMD: command },
        stdout: "pipe",
      });
      expect((await new Response(p.stdout).text()).trim()).toBe("0");
    }
  }, SLOW);
});

describe("the pool on this hub", () => {
  let a: Hub;
  let helper: ReturnType<typeof helperListener>;
  let serverPort: number;

  beforeAll(async () => {
    a = await hub("Mac mini");
    helper = helperListener();
    serverPort = freePort();
  });
  afterAll(() => helper.stop());

  test("defaults: this hub only (a Mac left out, and why), the pinned build, no model", async () => {
    const r = await a.api<PoolView>("GET", "/api/pool");
    expect(r.status).toBe(200);
    const v = r.data;
    expect(v.config).toEqual({
      build: "b11669",
      machines: [{ id: "self", kind: "self", name: "Mac mini", address: null, os: hostPlatform().os, backend: null, enabled: !MAC, rpcPort: 50052 }],
      mainId: "self",
      model: null,
      // 64k: Claude Code needs about 20k just to start, and chats summarize at three quarters of it.
      contextSize: 65536,
      alias: "",
      port: 9931,
      autostart: false,
    });
    expect(v.status).toEqual({ state: "off", detail: null, download: null, endpoint: null, accounts: {}, startedAt: null, speed: null, log: [] });
    expect(v.fit).toBeNull();
    expect(v.hasHfToken).toBe(false);
    expect(v.machines[0]).toMatchObject({ id: "self", state: "unknown", devices: [], link: null, checkedAt: 0 });
    if (MAC) expect(v.machines[0].detail).toBe("Left out: slowest GPU, and it runs your chats. Switch it on to lend it too.");
  }, SLOW);

  test("PUT checks every field and keeps nothing of a bad change", async () => {
    const ok = { model: tiny("Tiny-Q4_K_M.gguf") };
    const cases: [string, unknown][] = [
      ["not json", "{"],
      ["no config", {}],
      ["config not an object", { config: [] }],
      ["machines not a list", { config: { machines: "self" } }],
      ["unknown kind", { config: { machines: [{ ...selfMachine(true), kind: "laptop" }] } }],
      ["self id", { config: { machines: [{ ...selfMachine(true), id: "me" }] } }],
      ["hub id", { config: { machines: [{ ...selfMachine(true), id: "linux", kind: "hub" }] } }],
      ["computer id", { config: { machines: [computer("box", "Box", 50052)] } }],
      ["kind and id", { config: { machines: [computer("h_abcdefgh", "Box", 50052)] } }],
      ["no name", { config: { machines: [computer("pc_box00001", "  ", 50052)] } }],
      ["LAN address", { config: { machines: [computer("pc_box00001", "Box", 50052, "192.168.1.20")] } }],
      ["not an address", { config: { machines: [computer("pc_box00001", "Box", 50052, "100.64.0.300")] } }],
      ["leading zero", { config: { machines: [computer("pc_box00001", "Box", 50052, "100.064.0.1")] } }],
      ["a name", { config: { machines: [computer("pc_box00001", "Box", 50052, "gaming-pc.tail1234.ts.net")] } }],
      ["port 80", { config: { machines: [computer("pc_box00001", "Box", 80)] } }],
      ["port text", { config: { machines: [computer("pc_box00001", "Box", "5005x" as unknown as number)] } }],
      ["enabled missing", { config: { machines: [{ ...computer("pc_box00001", "Box", 50052), enabled: undefined }] } }],
      ["os", { config: { machines: [computer("pc_box00001", "Box", 50052, "127.0.0.1", { os: "beos" as "linux" })] } }],
      ["backend", { config: { machines: [computer("pc_box00001", "Box", 50052, "127.0.0.1", { backend: "rocm" as PoolBackend })] } }],
      ["metal on windows", { config: { machines: [computer("pc_box00001", "Box", 50052, "127.0.0.1", { backend: "metal" })] } }],
      ["twice", { config: { machines: [selfMachine(true), selfMachine(false)] } }],
      ["same helper", { config: { machines: [computer("pc_box00001", "Box", 50052), computer("pc_box00002", "Box 2", 50052)] } }],
      ["too many", { config: { machines: Array.from({ length: 33 }, (_, i) => computer(`pc_box${String(i).padStart(5, "0")}`, `Box ${i}`, 50052 + i)) } }],
      ["main not linked", { config: { mainId: "h_notlinked01" } }],
      ["main a computer", { config: { mainId: "pc_box00001" } }],
      ["main nothing", { config: { mainId: 7 } }],
      ["model repo", { config: { model: { ...ok.model, repo: "../etc" } } }],
      ["model file", { config: { model: { ...ok.model, files: ["../../secrets.gguf"] } } }],
      ["model vision", { config: { model: { ...ok.model, files: ["mmproj-Tiny-F16.gguf"] } } }],
      ["model split part", { config: { model: { ...ok.model, files: ["BF16/Tiny-BF16-00001-of-00002.gguf"] } } }],
      ["model size", { config: { model: { ...ok.model, sizeBytes: -1 } } }],
      ["context small", { config: { contextSize: 1024 } }],
      ["context big", { config: { contextSize: 2_000_000 } }],
      ["context text", { config: { contextSize: "32768" } }],
      ["alias space", { config: { alias: "bad alias" } }],
      ["alias long", { config: { alias: "a".repeat(65) } }],
      ["port low", { config: { port: 1023 } }],
      ["hub's own port", { config: { port: a.app.config.port || Number(new URL(a.base).port) } }],
      ["autostart", { config: { autostart: "yes" } }],
      ["old build", { config: { build: "b10999" } }],
      ["build name", { config: { build: "11669" } }],
    ];
    // The hub's own port, as configured (0 here picks one): set it so the check applies.
    a.app.config.port = Number(new URL(a.base).port);
    const before = a.app.store.kvGet("pool");
    for (const [what, body] of cases) {
      const r = await a.api<{ error?: string }>("PUT", "/api/pool", body);
      expect([what, r.status]).toEqual([what, 400]);
      expect([what, (r.data.error ?? "").length > 15]).toEqual([what, true]);
    }
    expect(a.app.store.kvGet("pool")).toBe(before);
    a.app.config.port = 0;
  }, SLOW);

  test("a change is saved and sent to every device; the name in chats follows the model until it's set", async () => {
    const seen = a.events.length;
    const v = await put(a, { model: tiny("Tiny-Q4_K_M.gguf"), contextSize: 8192, port: serverPort, machines: [selfMachine(true), computer("pc_box00001", "Box", helper.port)] });
    expect(v.config).toMatchObject({ model: tiny("Tiny-Q4_K_M.gguf"), contextSize: 8192, port: serverPort, alias: "tiny", mainId: "self" });
    expect(v.config.machines.map((m) => [m.id, m.kind, m.name, m.enabled])).toEqual([["self", "self", "Mac mini", true], ["pc_box00001", "computer", "Box", true]]);
    expect(a.events.length).toBeGreaterThan(seen);
    expect(a.events.at(-1)!.view.config.alias).toBe("tiny");
    // The fit: the computer's memory can't be known here; this hub's GPUs aren't checked yet.
    expect(v.fit).toMatchObject({ haveMiB: 0, fits: false, note: "Check the machines to count the GPU of Mac mini." });
    expect((await put(a, { alias: "pool-test" })).config.alias).toBe("pool-test");
    expect((await put(a, { model: tiny("Tiny-Q8_0.gguf") })).config.alias).toBe("pool-test");
    expect((await put(a, { alias: "" })).config.alias).toBe("tiny");
    expect((await put(a, { model: tiny("Tiny-Q4_K_M.gguf") })).config.alias).toBe("tiny");
  }, SLOW);

  test("the Hugging Face token: saved on the hub only, never sent back; models are listed with it", async () => {
    expect((await a.api("PUT", "/api/pool/hf-token", {})).status).toBe(400);
    expect((await a.api("PUT", "/api/pool/hf-token", { token: "has spaces in it" })).status).toBe(400);
    const saved = await a.api<{ hasHfToken: boolean }>("PUT", "/api/pool/hf-token", { token: ` ${TOKEN} ` });
    expect(saved).toEqual({ status: 200, data: { hasHfToken: true } });
    expect(readSecrets()[HF_SECRET]).toBe(TOKEN);
    const view = (await a.api<PoolView>("GET", "/api/pool")).data;
    expect(view.hasHfToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    const listed = await a.api<PoolModelChoices>("GET", "/api/pool/models?repo=acme/Gated-GGUF");
    expect(listed.status).toBe(200);
    expect(listed.data).toMatchObject({ repo: "acme/Gated-GGUF", gated: true, models: [{ files: ["Gated-Q4_K_M.gguf"], gated: true }] });
    expect(hf.requests.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    const tinyList = await a.api<PoolModelChoices>("GET", `/api/pool/models?repo=${encodeURIComponent("https://huggingface.co/acme/Tiny-GGUF")}`);
    expect(tinyList.data.models.map((m) => m.files[0])).toEqual(["Tiny-Q4_K_M.gguf", "Tiny-Q8_0.gguf", "Slow-Q2_K.gguf"]);
    expect((await a.api<{ error: string }>("GET", "/api/pool/models?repo=")).status).toBe(400);
    expect(await a.api("PUT", "/api/pool/hf-token", { token: null })).toEqual({ status: 200, data: { hasHfToken: false } });
    expect(readSecrets()[HF_SECRET]).toBeUndefined();
  }, SLOW);

  test("starting: llama.cpp installed, the model downloaded, the server on 127.0.0.1 with the computer's helper, the accounts made", async () => {
    const before = runs(llamaLog).length;
    const started = await a.api<PoolView>("POST", "/api/pool/start");
    expect(started.status).toBe(200);
    expect(started.data.status.state).toBe("preparing");
    const done = await settled(a);
    expect([done.state, done.detail]).toEqual(["running", "Running on the GPUs of Mac mini and Box."]);
    const states: string[] = a.events.map((e) => e.view.status.state);
    for (const s of ["preparing", "downloading", "starting", "running"]) expect(states).toContain(s);
    expect(a.events.some((e) => e.view.status.download?.file === "Tiny-Q4_K_M.gguf")).toBe(true);

    const run = runs(llamaLog).slice(before).find((r) => r.argv.includes("-m"))!;
    const key = readSecrets()[KEY_SECRET];
    expect(key).toMatch(/^ctpool-[\w-]{40,}$/);
    // This hub's GPU takes part: no -dev. The key only in the environment.
    expect(run.argv).toEqual([
      "--rpc",
      `127.0.0.1:${helper.port}`,
      "-m",
      modelPath(tiny("Tiny-Q4_K_M.gguf")),
      "-c",
      "8192",
      // One request at a time with the whole context, and every layer on the GPUs.
      "-np",
      "1",
      "-ngl",
      "all",
      "-a",
      "tiny",
      "--host",
      "127.0.0.1",
      "--port",
      String(serverPort),
      "--cache-ram",
      "0",
      "--metrics",
      ...(MAC ? ["--load-mode", "none"] : []),
    ]);
    expect(run.apiKey).toBe(key);
    expect(run.argv.join(" ")).not.toContain(key!);

    // Chats reach it as the "Model pool" custom model, for Claude Code and Codex.
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    expect(done.endpoint).toEqual({ baseUrl, model: "tiny", contextWindow: 8192 });
    expect(Object.keys(done.accounts).sort()).toEqual(["claude", "codex"]);
    for (const p of ["claude", "codex"] as const) {
      const acct = a.app.providers.account(p, done.accounts[p]!);
      expect(acct).toMatchObject({ kind: "endpoint", label: "Model pool", endpoint: { baseUrl, models: ["tiny"], contextWindow: 8192, hasKey: true } });
      expect(a.app.providers.endpointOf(p, acct.id)!.key).toBe(key!);
    }
    // Claude Code on it: every model it would pick is the server's.
    const env = a.app.providers.agentEnv("claude", done.accounts.claude!);
    for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
      expect([k, env[k]]).toEqual([k, "tiny"]);
    }
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key });
    expect(machineState(a, "self")).toMatchObject({ state: "running", detail: "Runs the model server." });
    expect(machineState(a, "pc_box00001")).toMatchObject({ state: "running", detail: "Lending its GPU to the pool." });
    expect(a.app.store.kvGet("pool.wasRunning")).toBe("1");
  }, SLOW);

  test("while it runs: a check never connects to the computer's helper; the speed is read", async () => {
    process.env.FAKE_LLAMA_SPEED = "349.6,18.2";
    const connections = helper.connections();
    const v = (await a.api<PoolView>("POST", "/api/pool/check")).data;
    expect(helper.connections()).toBe(connections);
    expect(v.machines.find((m) => m.id === "pc_box00001")).toMatchObject({ state: "running", detail: "Lending its GPU to the pool." });
    expect(v.machines.find((m) => m.id === "self")).toMatchObject({ state: "running", devices: [{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }] });
    // The fake server was started before the speed was set: it reports no reply yet (0), so none is shown.
    await Bun.sleep(300);
    expect(state(a).speed).toBeNull();
    delete process.env.FAKE_LLAMA_SPEED;
  }, SLOW);

  test("stopping: the server goes, the computer's helper keeps running (and the detail says so)", async () => {
    const server = runs(llamaLog).filter((r) => r.argv.includes("-m")).at(-1)!.pid;
    expect(alive(server)).toBe(true);
    const off = await stopPool(a);
    expect(off.status.detail).toBe("The helper on Box keeps running there: close its window to stop it.");
    expect(off.status.endpoint).toBeNull();
    expect(alive(server)).toBe(false);
    expect(a.app.poolNode.snapshot().server.running).toBe(false);
    expect(off.machines.find((m) => m.id === "pc_box00001")).toMatchObject({ state: "ready", detail: "Its helper keeps running there: close its window to stop it." });
    expect(off.machines.find((m) => m.id === "self")!.state).toBe("ready");
    // The accounts stay, for the next start.
    expect(Object.keys(off.status.accounts).sort()).toEqual(["claude", "codex"]);
    expect(a.app.store.kvGet("pool.wasRunning")).toBe("0");
  }, SLOW);

  test("starting again reuses the accounts and restarts the chats on them; the speed shows once there are replies", async () => {
    const accounts = state(a).accounts;
    const room = a.app.createRoom({ name: "Pool chat", cwd: join(work, "chats", "pool") });
    const onClaude = a.app.addMember(room.id, { provider: "claude", config: { account: accounts.claude } });
    const onCodex = a.app.addMember(room.id, { provider: "codex", config: { account: accounts.codex } });
    const elsewhere = a.app.addMember(room.id, { provider: "claude" });
    a.changed.length = 0;
    process.env.FAKE_LLAMA_SPEED = "349.6,18.2";
    try {
      const from = a.events.length;
      a.app.pool.start();
      const done = await settled(a);
      expect(done.state).toBe("running");
      // The model was there already: no download this time.
      expect(a.events.slice(from).some((e) => e.view.status.state === "downloading")).toBe(false);
      expect(done.accounts).toEqual(accounts);
      expect(a.app.providers.accounts().filter((x) => x.kind === "endpoint").map((x) => [x.provider, x.id]).sort()).toEqual(Object.entries(accounts).sort());
      expect(a.changed).toContain(onClaude.id);
      expect(a.changed).toContain(onCodex.id);
      expect(a.changed).not.toContain(elsewhere.id);
      await until(() => state(a).speed !== null, "the speed");
      expect(state(a).speed).toEqual({ prompt: 349.6, generation: 18.2 });
    } finally {
      delete process.env.FAKE_LLAMA_SPEED;
    }
    await stopPool(a);
  }, SLOW);

  test("with this hub's GPU left out, the server uses exactly the helpers' GPUs, every one each serves", async () => {
    await put(a, { machines: [selfMachine(false), computer("pc_box00001", "Box", helper.port)] });
    // Box has two GPUs: llama.cpp names them RPC0 and RPC1 (one name per device, not per helper).
    process.env.FAKE_LLAMA_RPC_DEVICES = JSON.stringify({ [`127.0.0.1:${helper.port}`]: 2 });
    try {
      const before = runs(llamaLog).length;
      a.app.pool.start();
      expect((await settled(a)).state).toBe("running");
      const run = runs(llamaLog).slice(before).find((r) => r.argv.includes("-m"))!;
      expect(run.argv.slice(0, 4)).toEqual(["--rpc", `127.0.0.1:${helper.port}`, "-dev", "RPC0,RPC1"]);
      expect(state(a).detail).toBe("Running on the GPU of Box.");
    } finally {
      delete process.env.FAKE_LLAMA_RPC_DEVICES;
    }
    await stopPool(a);
  }, SLOW);

  test("a PC's GPU memory is learned through the main machine's llama.cpp while the pool is off, so the fit counts it", async () => {
    await put(a, { machines: [selfMachine(false), computer("pc_box00001", "Box", helper.port)] });
    process.env.FAKE_LLAMA_RPC_DEVICES = JSON.stringify({ [`127.0.0.1:${helper.port}`]: 2 });
    try {
      const view = await a.app.pool.check();
      const box = view.machines.find((m) => m.id === "pc_box00001")!;
      expect(box.state).toBe("ready");
      expect(box.devices.map((d) => [d.name, d.description, d.totalMiB, d.freeMiB])).toEqual([
        ["RPC0", "GPU of Box", 16304, 15890],
        ["RPC1", "GPU of Box", 16304, 15890],
      ]);
      // Counted now: the fit no longer says Crosstalk can't see it.
      expect(view.fit!.haveMiB).toBe(2 * 15890);
      expect(view.fit!.note ?? "").not.toContain("can't see the GPU memory");
    } finally {
      delete process.env.FAKE_LLAMA_RPC_DEVICES;
    }
  }, SLOW);

  test("a server that stops on its own: said from its last lines, started again once, then left stopped", async () => {
    await put(a, { machines: [selfMachine(true), computer("pc_box00001", "Box", helper.port)] });
    a.app.pool.start();
    expect((await settled(a)).state).toBe("running");
    const first = runs(llamaLog).filter((r) => r.argv.includes("-m")).at(-1)!.pid;
    process.kill(first, "SIGKILL");
    await until(() => state(a).state === "error", "the pool to notice");
    expect(state(a).detail).toBe(
      "The model server on Mac mini stopped: The model server stopped unexpectedly (it was killed, perhaps because the machine ran low on memory). Start it again; if it keeps happening, look at its log. Crosstalk starts it again in a moment if every helper still answers.",
    );
    expect(state(a).log.length).toBeGreaterThan(0);
    await until(() => state(a).state === "running", "the automatic restart");
    const second = runs(llamaLog).filter((r) => r.argv.includes("-m")).at(-1)!.pid;
    expect(second).not.toBe(first);
    process.kill(second, "SIGKILL");
    await until(() => state(a).state === "error", "the pool to notice again");
    expect(state(a).detail).toContain("It had already been started again once: start the pool again when the machines are ready.");
    const count = runs(llamaLog).length;
    await Bun.sleep(800);
    expect([state(a).state, runs(llamaLog).length]).toEqual(["error", count]);
    await stopPool(a);
  }, SLOW);

  test("failures say what to do: no model, no GPU, a helper that doesn't answer, a model that won't load, too little room", async () => {
    const fail = async (config: Record<string, unknown>, detail: string | RegExp) => {
      await put(a, config);
      a.app.pool.start();
      const s = await settled(a);
      expect(s.state).toBe("error");
      if (typeof detail === "string") expect(s.detail).toBe(detail);
      else expect(s.detail).toMatch(detail);
      return s;
    };
    await fail({ model: null }, "Choose a model first (Model → Choose a model), then start the pool.");
    await fail({ model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(false)] }, "No GPU takes part yet: switch on at least one machine under Machines in the pool, then start again.");
    const gone = freePort();
    const s = await fail({ machines: [selfMachine(true), computer("pc_gone0001", "Gaming PC", gone)] }, `The helper on Gaming PC doesn't answer at 127.0.0.1:${gone}. Run its helper command there (Helper command next to it), then start again.`);
    expect(s.state).toBe("error");
    expect(machineState(a, "pc_gone0001")).toMatchObject({ state: "offline", detail: expect.stringContaining("doesn't answer") });
    const loads = await fail({ model: broken, machines: [selfMachine(true)] }, "The model server on Mac mini stopped as it started: llama.cpp couldn't load the model: download it again or pick another quant, then start again.");
    expect(loads.log.some((l) => l.includes("exiting due to model loading error"))).toBe(true);
    process.env.FAKE_LLAMA_FIT_CTX = "1024";
    try {
      // With -c set llama.cpp never cuts the context to fit: less than asked is what the model holds.
      await fail({ model: tiny("Tiny-Q4_K_M.gguf") }, "Tiny (Q4_K_M) only holds 1,024 tokens of context, too few for chats: choose another model, then start again.");
    } finally {
      delete process.env.FAKE_LLAMA_FIT_CTX;
    }
    // A failed start leaves nothing running.
    await until(() => !a.app.poolNode.snapshot().server.running, "the server to be stopped");
    expect((await stopPool(a)).status.detail).toBeNull();
  }, SLOW);

  test("a computer's helper that another program holds: said by its name, before the server would wait on it for good", async () => {
    await put(a, { model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(true), computer("pc_box00001", "Box", helper.port)] });
    a.app.poolNode.helperCheckMs = 500;
    process.env.FAKE_LLAMA_RPC_HANG = `127.0.0.1:${helper.port}`;
    try {
      a.app.pool.start();
      const s = await settled(a);
      expect([s.state, s.detail]).toEqual(["error", "The helper on Box is busy with another program (another pool's model server, say): close that, or run its helper command there again (Helper command), then start again."]);
      expect(machineState(a, "pc_box00001")).toMatchObject({ state: "error", detail: `Its helper at 127.0.0.1:${helper.port} is busy with another program.` });
      expect(a.app.poolNode.snapshot().server.running).toBe(false);
    } finally {
      delete process.env.FAKE_LLAMA_RPC_HANG;
      a.app.poolNode.helperCheckMs = 20_000;
    }
    await stopPool(a);
  }, SLOW);

  test("a gated model: the terms message without a token; with one, it's sent for the download only", async () => {
    rmSync(join(modelsDir(), "acme", "Gated-GGUF"), { recursive: true, force: true });
    await put(a, { model: gated, machines: [selfMachine(true)] });
    a.app.pool.start();
    const noToken = await settled(a);
    expect(noToken.state).toBe("error");
    expect(noToken.detail).toBe("Hugging Face won't let this download acme/Gated-GGUF yet: open huggingface.co/acme/Gated-GGUF, accept the model's terms, then save a Hugging Face token (from the same account) and try again.");
    await a.api("PUT", "/api/pool/hf-token", { token: TOKEN });
    a.asked.length = 0;
    a.app.pool.start();
    expect((await settled(a)).state).toBe("running");
    const download = a.asked.find((x) => x.kind === "model" && x.body.action === "download")!;
    expect(download.body.hfToken).toBe(TOKEN);
    // Nothing else was sent the token.
    expect(a.asked.filter((x) => JSON.stringify(x.body).includes(TOKEN))).toHaveLength(1);
    expect(hf.requests.filter((r) => r.path.startsWith("/acme/Gated-GGUF/resolve/")).at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    expect(hf.storageRequests.at(-1)!.auth).toBeNull();
    await stopPool(a);
    await a.api("PUT", "/api/pool/hf-token", { token: null });
  }, SLOW);

  test("download progress goes out at most twice a second", async () => {
    const m = tiny("Slow-Q2_K.gguf");
    rmSync(modelPath(m), { force: true });
    await put(a, { model: m, machines: [selfMachine(true)] });
    const from = a.events.length;
    a.app.pool.start();
    expect((await settled(a)).state).toBe("running");
    const downloading = a.events.slice(from).filter((e) => e.view.status.state === "downloading");
    expect(downloading.length).toBeGreaterThanOrEqual(3);
    expect(downloading.some((e) => (e.view.status.download?.doneBytes ?? 0) > 0)).toBe(true);
    for (let i = 1; i < downloading.length; i++) expect(downloading[i].at - downloading[i - 1].at).toBeGreaterThanOrEqual(450);
    await stopPool(a);
  }, SLOW);

  test("removing the download: refused while it runs, then moved to the Trash on the main machine", async () => {
    const m = tiny("Tiny-Q4_K_M.gguf");
    await put(a, { model: m, machines: [selfMachine(true)] });
    a.app.pool.start();
    expect((await settled(a)).state).toBe("running");
    const busy = await a.api<{ error: string; code: string }>("POST", "/api/pool/model/remove", { files: m.files });
    expect(busy).toEqual({ status: 409, data: { error: "Stop the pool first, then remove the download.", code: "in_use" } });
    await stopPool(a);
    // The main machine's model files with their sizes, so ones no longer used can be found.
    expect(a.app.pool.view().mainFiles).toContainEqual({ file: "acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", bytes: FILES["Tiny-Q4_K_M.gguf"].length, partial: false });
    expect((await a.api("POST", "/api/pool/model/remove", { files: [] })).status).toBe(400);
    expect((await a.api("POST", "/api/pool/model/remove", { files: ["../../../etc/passwd.gguf"] })).status).toBe(400);
    const removed = await a.api<PoolView>("POST", "/api/pool/model/remove", { files: m.files });
    expect(removed.status).toBe(200);
    expect(existsSync(modelPath(m))).toBe(false);
    expect(removed.data.mainFiles?.some((f) => f.file === "acme/Tiny-GGUF/Tiny-Q4_K_M.gguf")).toBe(false);
    expect(existsSync(join(work, "trash-home", MAC ? ".Trash" : ".local/share/Trash/files", "Tiny-Q4_K_M.gguf"))).toBe(true);
  }, SLOW);

  test("starting again when it was running: the hub's start brings it back if that's switched on", async () => {
    await put(a, { model: tiny("Tiny-Q8_0.gguf"), machines: [selfMachine(true)], autostart: false });
    a.app.store.kvSet("pool.wasRunning", "1");
    a.app.pool.resume(10);
    await Bun.sleep(100);
    expect(state(a).state).toBe("off");
    await put(a, { autostart: true });
    a.app.pool.resume(10);
    await until(() => state(a).state !== "off", "the pool to start by itself");
    expect((await settled(a)).state).toBe("running");
    await stopPool(a);
    expect(a.app.store.kvGet("pool.wasRunning")).toBe("0");
    await put(a, { autostart: false });
  }, SLOW);

  test("started by the hub, a machine that isn't up yet is tried again for a while, and it still counts as running", async () => {
    const late = freePort();
    await put(a, { model: tiny("Tiny-Q8_0.gguf"), machines: [selfMachine(true), computer("pc_late0001", "Late PC", late)], autostart: true });
    a.app.store.kvSet("pool.wasRunning", "1");
    a.app.pool.resumeDelayMs = 150;
    let listener: { stop(closeActive?: boolean): void } | null = null;
    try {
      a.app.pool.resume(10);
      await until(() => state(a).state === "error", "the first try");
      expect(state(a).detail).toBe(`The helper on Late PC doesn't answer at 127.0.0.1:${late}. Run its helper command there (Helper command next to it), then start again. Crosstalk tries again in a moment: the machines may still be starting.`);
      // So the next start of the hub tries too.
      expect(a.app.store.kvGet("pool.wasRunning")).toBe("1");
      // Its helper comes up meanwhile: a later try runs the pool.
      listener = Bun.listen({ hostname: "127.0.0.1", port: late, socket: { data() {} } });
      await until(() => state(a).state === "running", "a later try", 30_000);
    } finally {
      listener?.stop(true);
      a.app.pool.resumeDelayMs = 10_000;
    }
    await stopPool(a);
    await put(a, { autostart: false, machines: [selfMachine(true)] });
  }, SLOW);
});

describe("linked hubs and other computers", () => {
  let a: Hub;
  let b: Hub;
  let serverPort: number;

  beforeAll(async () => {
    a = await hub("Studio");
    b = await hub("Linux box");
    serverPort = freePort();
  });

  test("a linked hub joins the list switched on and becomes the main machine by default; unlinked, it leaves", async () => {
    const heard = a.events.length;
    await link(a, b);
    // The screen hears of it at once (a pool event), without being opened again.
    await until(() => a.events.length > heard && a.events.at(-1)!.view.config.machines.some((m) => m.id === b.app.hubId()), "the link to reach the pool screen");
    const v = a.app.pool.view();
    expect(v.config.machines.map((m) => [m.id, m.kind, m.name, m.enabled])).toEqual([
      ["self", "self", "Studio", !MAC],
      [b.app.hubId(), "hub", "Linux box", true],
    ]);
    expect(v.config.mainId).toBe(b.app.hubId());
    // A hub this hub only has an agents' sign-in on can't run anything for the pool: it's listed switched off, and why.
    const links = JSON.parse(a.app.store.kvGet("machines.links")!);
    const peerOnly = { ...links[0], id: "h_peeronly001", name: "Peer box", url: "http://127.0.0.1:9", token: "peer-token-0123456789", deviceId: "d_peeronly", scope: "peer", agents: "two-way", relayId: null };
    a.app.store.kvSet("machines.links", JSON.stringify([...links, peerOnly]));
    const withPeer = a.app.pool.view();
    expect(withPeer.config.machines.find((m) => m.id === "h_peeronly001")).toMatchObject({ kind: "hub", enabled: false });
    expect(withPeer.machines.find((m) => m.id === "h_peeronly001")).toMatchObject({ state: "error", detail: expect.stringContaining("This hub can only reach chats on Peer box: link Peer box from this hub") });
    const refused = await a.api<{ error: string }>("PUT", "/api/pool", { config: { mainId: "h_peeronly001" } });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain("This hub can only reach chats on Peer box");
    a.app.store.kvSet("machines.links", JSON.stringify(links));
    expect(a.app.pool.view().config.machines.map((m) => m.id)).toEqual(["self", b.app.hubId()]);
    // A linked hub where llama.cpp finds no GPU is switched off by default: it would only lend its CPU.
    process.env.FAKE_LLAMA_DEVICES = "none";
    try {
      const none = (await a.api<PoolView>("POST", "/api/pool/check")).data;
      expect(none.config.machines.find((m) => m.id === b.app.hubId())!.enabled).toBe(false);
      expect(none.machines.find((m) => m.id === b.app.hubId())!.detail).toBe("llama.cpp found no GPU there.");
    } finally {
      delete process.env.FAKE_LLAMA_DEVICES;
    }
    expect((await a.api<PoolView>("POST", "/api/pool/check")).data.config.machines.find((m) => m.id === b.app.hubId())!.enabled).toBe(true);
  }, SLOW);

  test("checking: each hub's GPUs and state, the round trip over Tailscale, and computers by a connection that closes at once", async () => {
    const listener = helperListener();
    process.env.FAKE_TAILSCALE_IP = TS_IP;
    writeFileSync(
      pingsFile,
      [`${TS_IP} pong from linux-box (${TS_IP}) via 192.168.1.20:41641 in 3ms`, "100.64.0.9 pong from gaming-pc (100.64.0.9) via DERP(fra) in 45ms"].join("\n") + "\n",
    );
    answering.add("100.64.0.9:50052");
    try {
      await put(a, {
        model: tiny("Tiny-Q4_K_M.gguf"),
        machines: [
          selfMachine(false),
          hubMachine(b, true, freePort()),
          computer("pc_gaming001", "Gaming PC", 50052, "100.64.0.9", { backend: "cuda" }),
          computer("pc_office001", "Office PC", 50052, "100.64.0.10", { enabled: false }),
          computer("pc_local0001", "Local box", listener.port),
        ],
      });
      const v = (await a.api<PoolView>("POST", "/api/pool/check")).data;
      const st = (id: string) => v.machines.find((m) => m.id === id)!;
      expect(st(b.app.hubId())).toMatchObject({ link: { ms: 3, direct: true }, devices: [{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }] });
      expect(st(b.app.hubId()).checkedAt).toBeGreaterThan(0);
      expect(st("self").link).toBeNull();
      expect(st("pc_gaming001")).toMatchObject({ state: "ready", link: { ms: 45, direct: false }, detail: "Its helper answers at 100.64.0.9:50052." });
      expect(st("pc_office001")).toMatchObject({ state: "offline", link: { ms: null, direct: null }, detail: "Office PC doesn't answer over Tailscale: turn it on and open Tailscale there, then check again." });
      // A plain TCP connection, closed at once; then the main machine's llama.cpp lists the GPU it lends.
      expect(st("pc_local0001")).toMatchObject({ state: "ready", link: null, devices: [{ name: "RPC0", description: "GPU of Local box", totalMiB: 16304, freeMiB: 15890 }] });
      expect(listener.connections()).toBe(2);
      // One whose helper llama.cpp couldn't reach keeps no GPUs (and isn't counted).
      expect(st("pc_gaming001").devices).toEqual([]);
      // This hub's address and the linked hub's, as each reports it; kept for when this hub starts again.
      expect(v.config.machines.find((m) => m.id === b.app.hubId())!.address).toBe(TS_IP);
      expect(new Pool(a.app).config().machines.find((m) => m.id === b.app.hubId())!.address).toBe(TS_IP);
      // The fit counts the hubs' GPUs (this one is left out) and a computer's once the main machine has listed them.
      expect(v.fit).toMatchObject({ haveMiB: 12123 + 15890 });
    } finally {
      listener.stop();
      answering.clear();
      delete process.env.FAKE_TAILSCALE_IP;
      writeFileSync(pingsFile, "");
    }
  }, SLOW);

  test("the Tailscale devices to pick a computer from", async () => {
    writeFileSync(
      statusFile,
      JSON.stringify({
        BackendState: "Running",
        Self: { HostName: "studio", TailscaleIPs: ["100.64.0.1"], OS: "macOS", Online: true },
        Peer: { "nodekey:a": { HostName: "gaming-rig", TailscaleIPs: ["100.64.0.9"], OS: "windows", Online: true, CurAddr: "192.168.1.20:41641" } },
      }),
    );
    expect((await a.api<{ error: string }>("GET", "/api/pool/tailscale")).data.error).toBe(
      "Tailscale isn't running on this hub: open Tailscale and sign in, then try again. You can also type the computer's address.",
    );
    process.env.FAKE_TAILSCALE_STATUS = statusFile;
    try {
      expect(await a.api("GET", "/api/pool/tailscale")).toEqual({ status: 200, data: { peers: [{ name: "gaming-rig", address: "100.64.0.9", os: "windows", online: true, direct: true }] } });
    } finally {
      delete process.env.FAKE_TAILSCALE_STATUS;
    }
  }, SLOW);

  test("helper commands: only for computers in the pool; the build named is noted, and a changed build is caught", async () => {
    const r = await a.api<{ command: string; notes: string[] }>("GET", "/api/pool/helper-command?machine=pc_gaming001&os=windows&backend=cuda");
    expect(r.status).toBe(200);
    expect(r.data.command).toContain("cudart-llama-bin-win-cuda-12.4-x64.zip");
    expect(r.data.command).toContain("$want='100.64.0.9'");
    // The machine's name never goes into a command.
    expect(r.data.command).not.toContain("Gaming PC");
    expect((await a.api("GET", "/api/pool/helper-command?machine=pc_nothere01&os=windows&backend=vulkan")).status).toBe(404);
    expect((await a.api<{ error: string }>("GET", `/api/pool/helper-command?machine=${b.app.hubId()}&os=linux&backend=vulkan`)).data.error).toBe("Crosstalk starts the helper on Linux box itself: it needs no command.");
    expect((await a.api("GET", "/api/pool/helper-command?machine=pc_gaming001&os=windows&backend=metal")).status).toBe(400);
    expect((await a.api("GET", "/api/pool/helper-command?machine=pc_gaming001&os=amiga&backend=cpu")).status).toBe(400);
    // Only over plain http here: no short command (the computer would run what it fetched unchecked).
    expect(r.data).not.toHaveProperty("short");
    // Over https (the hub's Tailscale address), a short one to type instead, which fetches the long one from the hub.
    a.app.config.publicUrl = "https://studio.tail1234.ts.net";
    try {
      const withShort = (await a.api<{ command: string; short?: string }>("GET", "/api/pool/helper-command?machine=pc_gaming001&os=windows&backend=cuda")).data;
      const token = /\/api\/pool\/helper\/([a-z0-9]{20}) \| iex$/.exec(withShort.short ?? "")?.[1];
      expect(withShort.short).toBe(`[Net.ServicePointManager]::SecurityProtocol=3072; irm https://studio.tail1234.ts.net/api/pool/helper/${token} | iex`);
      // The same each time, so the short command keeps working after the PC restarts.
      expect((await a.api<{ short?: string }>("GET", "/api/pool/helper-command?machine=pc_gaming001&os=windows&backend=cuda")).data.short).toBe(withShort.short);
      // No sign-in there: the token is the permission.
      const script = await fetch(`${a.base}/api/pool/helper/${token}`);
      expect([script.status, await script.text()]).toEqual([200, `${withShort.command}\n`]);
      const stale = await fetch(`${a.base}/api/pool/helper/${"x".repeat(20)}`);
      expect(await stale.text()).toBe('echo "This helper command is out of date: get the new one in Crosstalk (Model pool, Helper command next to the computer)."\n');
    } finally {
      a.app.config.publicUrl = a.base;
    }
    await put(a, { build: "b11670" });
    a.app.pool.start();
    const s = await settled(a);
    expect(s).toMatchObject({ state: "error", detail: "Gaming PC's helper command is for llama.cpp b11669, but the pool now uses b11670: run its new helper command there (Helper command), then start again." });
    await put(a, { build: BUILD });
    await stopPool(a);
  }, SLOW);

  test("a linked hub as a helper: llama.cpp there, its helper started over /api/pool/node, the server here using it", async () => {
    const rpcPort = freePort();
    await put(a, { mainId: "self", port: serverPort, model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(false), hubMachine(b, true, rpcPort)] });
    b.asked.length = 0;
    const before = runs(llamaLog).length;
    a.app.pool.start();
    const s = await settled(a);
    expect([s.state, s.detail]).toEqual(["running", "Running on the GPU of Linux box."]);
    expect(b.asked.map((x) => [x.kind, x.body.action ?? null])).toEqual([["helper", "start"]]);
    // For this hub's pool and this start, with about how much of the model it gets (all of it here: one GPU).
    expect(b.asked[0].body).toEqual({ action: "start", build: BUILD, backend: MAC ? "metal" : "vulkan", port: rpcPort, owner: { hub: a.app.hubId(), name: "Studio", run: expect.stringMatching(/^r_/) }, cacheBytes: 300_000 });
    expect(b.app.poolNode.snapshot().helper).toMatchObject({ running: true, port: rpcPort });
    expect(runs(rpcLog).at(-1)!.argv).toEqual(["-H", "127.0.0.1", "-p", String(rpcPort), "-d", "MTL0", "-c"]);
    const run = runs(llamaLog).slice(before).find((r) => r.argv.includes("-m"))!;
    expect(run.argv.slice(0, 4)).toEqual(["--rpc", `127.0.0.1:${rpcPort}`, "-dev", "RPC0"]);
    expect(machineState(a, b.app.hubId())).toMatchObject({ state: "running" });
    const off = await stopPool(a);
    expect(off.status.detail).toBeNull();
    expect(b.app.poolNode.snapshot().helper.running).toBe(false);
    expect(a.app.poolNode.snapshot().server.running).toBe(false);
  }, SLOW);

  test("a linked hub as the main machine: the model downloaded there with the token for that only, its server, this hub as a helper", async () => {
    rmSync(join(modelsDir(), "acme", "Gated-GGUF"), { recursive: true, force: true });
    await a.api("PUT", "/api/pool/hf-token", { token: TOKEN });
    const selfPort = freePort();
    await put(a, { mainId: b.app.hubId(), port: serverPort, model: gated, machines: [selfMachine(true, selfPort), hubMachine(b, true, freePort())] });
    b.asked.length = 0;
    a.asked.length = 0;
    const before = runs(llamaLog).length;
    a.app.pool.start();
    const s = await settled(a);
    expect([s.state, s.detail]).toEqual(["running", "Running on the GPUs of Linux box and Studio."]);
    // This hub lends its GPU; the linked hub downloads the model (with the token) and runs the server.
    expect(a.asked.map((x) => [x.kind, x.body.action ?? null])).toEqual([["helper", "start"]]);
    expect(b.asked.map((x) => [x.kind, x.body.action ?? null])).toEqual([["model", "download"], ["server", "start"]]);
    expect(b.asked[0].body.hfToken).toBe(TOKEN);
    expect(JSON.stringify(b.asked[1].body)).not.toContain(TOKEN);
    expect(b.asked[1].body).toMatchObject({ rpc: [`127.0.0.1:${selfPort}`], devices: null, host: "127.0.0.1", port: serverPort, alias: "gated", apiKey: readSecrets()[KEY_SECRET] });
    expect(JSON.stringify(b.app.store.kvGet("pool") ?? "")).not.toContain(TOKEN);
    expect(b.app.poolNode.snapshot().server).toMatchObject({ running: true, healthy: true, port: serverPort });
    const run = runs(llamaLog).slice(before).find((r) => r.argv.includes("-m"))!;
    expect(run.argv.slice(0, 2)).toEqual(["--rpc", `127.0.0.1:${selfPort}`]);
    expect(run.argv).not.toContain("-dev");
    expect(s.endpoint).toEqual({ baseUrl: `http://127.0.0.1:${serverPort}`, model: "gated", contextWindow: 65536 });
    expect(a.app.providers.account("claude", s.accounts.claude!).endpoint).toMatchObject({ baseUrl: `http://127.0.0.1:${serverPort}`, models: ["gated"] });
    await stopPool(a);
    expect(b.app.poolNode.snapshot().server.running).toBe(false);
    expect(a.app.poolNode.snapshot().helper.running).toBe(false);
    await a.api("PUT", "/api/pool/hf-token", { token: null });
  }, SLOW);

  test("a linked hub's model server that stops on its own is noticed from here", async () => {
    await put(a, { mainId: b.app.hubId(), model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(false), hubMachine(b, true, freePort())] });
    a.app.pool.restartDelayMs = 60_000;
    try {
      a.app.pool.start();
      expect((await settled(a)).state).toBe("running");
      const pid = runs(llamaLog).filter((r) => r.argv.includes("-m")).at(-1)!.pid;
      process.kill(pid, "SIGKILL");
      await until(() => state(a).state === "error", "the pool to notice");
      expect(state(a).detail).toStartWith("The model server on Linux box stopped: The model server stopped unexpectedly (it was killed");
      expect(state(a).detail).toContain("Crosstalk starts it again in 60 seconds if every helper still answers.");
    } finally {
      a.app.pool.restartDelayMs = 300;
    }
    await stopPool(a);
  }, SLOW);

  test("App.shutdown ends what the pool runs, here and on the linked hub", async () => {
    const c = await hub("Shutdown test");
    await link(c, b);
    const rpcPort = freePort();
    const port = freePort();
    await put(c, { mainId: "self", port, model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(true), hubMachine(b, true, rpcPort)] });
    c.app.pool.start();
    expect((await settled(c)).state).toBe("running");
    const server = runs(llamaLog).filter((r) => r.argv.includes("-m")).at(-1)!.pid;
    const helperPid = runs(rpcLog).at(-1)!.pid;
    expect([alive(server), alive(helperPid), b.app.poolNode.snapshot().helper.running]).toEqual([true, true, true]);
    // It ran when the hub stopped: the hub's next start brings it back, when that's switched on.
    expect(c.app.store.kvGet("pool.wasRunning")).toBe("1");
    hubs.splice(hubs.indexOf(c), 1);
    await c.close();
    expect([alive(server), alive(helperPid), b.app.poolNode.snapshot().helper.running]).toEqual([false, false, false]);
  }, SLOW);

  test("a hub's helper that stops on its own while the pool runs: noticed from its hub, started again with the server", async () => {
    const rpcPort = freePort();
    await put(a, { mainId: "self", port: serverPort, model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(true), hubMachine(b, true, rpcPort)] });
    a.app.pool.start();
    expect((await settled(a)).state).toBe("running");
    const first = runs(rpcLog).at(-1)!.pid;
    const server = runs(llamaLog).filter((r) => r.argv.includes("-m")).at(-1)!.pid;
    process.kill(first, "SIGKILL");
    await until(() => state(a).state === "error", "the pool to notice");
    expect(state(a).detail).toBe(
      "The helper on Linux box stopped: The helper stopped unexpectedly (it was killed, perhaps because the machine ran low on memory). Start it again; if it keeps happening, look at its log. Crosstalk starts the pool again in a moment if every machine answers by then.",
    );
    await until(() => state(a).state === "running", "the pool to start again");
    const second = runs(rpcLog).at(-1)!.pid;
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);
    // The server too: it had lost one of its helpers.
    expect(alive(server)).toBe(false);
    await stopPool(a);
    expect(alive(second)).toBe(false);
  }, SLOW);

  test("starting again from a problem first ends what the last start still ran there", async () => {
    const rpcPort = freePort();
    await put(a, { mainId: "self", port: serverPort, model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(true), hubMachine(b, true, rpcPort)] });
    a.app.pool.restartDelayMs = 60_000;
    try {
      a.app.pool.start();
      expect((await settled(a)).state).toBe("running");
      const helperPid = runs(rpcLog).at(-1)!.pid;
      process.kill(runs(llamaLog).filter((r) => r.argv.includes("-m")).at(-1)!.pid, "SIGKILL");
      await until(() => state(a).state === "error", "the pool to notice");
      // Waiting to start the server again, the helper on Linux box still runs; switched off, the next start doesn't use it.
      expect(b.app.poolNode.snapshot().helper.running).toBe(true);
      await put(a, { machines: [selfMachine(true), hubMachine(b, false, rpcPort)] });
      a.app.pool.start();
      expect((await settled(a)).state).toBe("running");
      expect(alive(helperPid)).toBe(false);
      expect(b.app.poolNode.snapshot().helper.running).toBe(false);
    } finally {
      a.app.pool.restartDelayMs = 300;
    }
    await stopPool(a);
  }, SLOW);

  test("what this hub's pool left on a linked hub when it stopped without ending it ends once it's back, and at a check", async () => {
    const rpcPort = freePort();
    await put(a, { mainId: "self", port: serverPort, model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(true), hubMachine(b, true, rpcPort)] });
    a.app.pool.start();
    expect((await settled(a)).state).toBe("running");
    const helperPid = runs(rpcLog).at(-1)!.pid;
    expect(JSON.parse(a.app.store.kvGet("pool.left")!)).toEqual({ [b.app.hubId()]: ["helper"] });
    // The hub stops without ending it (a crash, a power cut): its pool is gone, but not the helper on Linux box. (This
    // hub's own server is ended by its next start: node.ts.)
    const gone = a.app.pool as unknown as { run: { cancel(): void }; closed: boolean };
    gone.run.cancel();
    gone.closed = true;
    await a.app.poolNode.stopServer();
    expect(alive(helperPid)).toBe(true);
    // Back: the pool ends it first thing.
    const back = new Pool(a.app);
    Object.assign(back, { watchMs: a.app.pool.watchMs, metricsMs: a.app.pool.metricsMs, restartDelayMs: a.app.pool.restartDelayMs, probe: a.app.pool.probe });
    (a.app as unknown as { pool: Pool }).pool = back;
    back.recover();
    await until(() => !alive(helperPid), "the helper it left to end");
    expect(JSON.parse(a.app.store.kvGet("pool.left")!)).toEqual({});
    expect(state(a).state).toBe("off");
    // One an earlier start left there that nothing noted (a stop that couldn't reach it): the next check ends it.
    await b.app.poolNode.handle("helper", { action: "start", build: BUILD, backend: MAC ? "metal" : "vulkan", port: rpcPort, owner: { hub: a.app.hubId(), name: "Studio", run: "r_earlier001" } });
    expect(b.app.poolNode.snapshot().helper.running).toBe(true);
    await a.api("POST", "/api/pool/check");
    expect(b.app.poolNode.snapshot().helper.running).toBe(false);
  }, SLOW);

  test("unlinking a hub the pool uses stops the pool first, while this hub can still sign in there", async () => {
    const rpcPort = freePort();
    await put(a, { mainId: "self", port: serverPort, model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(true), hubMachine(b, true, rpcPort)] });
    a.app.pool.start();
    expect((await settled(a)).state).toBe("running");
    const helperPid = runs(rpcLog).at(-1)!.pid;
    expect((await a.api("DELETE", `/api/machines/${b.app.hubId()}`)).status).toBe(200);
    expect([state(a).state, state(a).detail]).toEqual(["off", "Stopped: Linux box was unlinked."]);
    expect(alive(helperPid)).toBe(false);
    expect(a.app.pool.view().config.machines.map((m) => m.id)).toEqual(["self"]);
    await link(a, b);
  }, SLOW);

  test("a linked hub that no longer accepts this hub's sign-in, or doesn't answer, is said plainly", async () => {
    await put(a, { mainId: "self", model: tiny("Tiny-Q4_K_M.gguf"), machines: [selfMachine(false), hubMachine(b, true, freePort())] });
    // Signed out there (say, the sign-in was removed on that machine).
    const linkToB = JSON.parse(a.app.store.kvGet("machines.links")!).find((l: { id: string }) => l.id === b.app.hubId());
    b.app.auth.revoke(linkToB.deviceId);
    a.app.pool.start();
    const out = await settled(a);
    expect(out).toMatchObject({ state: "error", detail: "Linux box no longer accepts this hub's sign-in: link it again in Settings → Machines, then try again." });
    expect(a.app.machines.list().find((m) => m.id === b.app.hubId())!.agents).toBe("signed-out");
    await stopPool(a);
    // Linked again, then switched off (or out of reach).
    await link(a, b);
    b.stopServing();
    a.app.pool.start();
    const down = await settled(a);
    expect(down).toMatchObject({ state: "error", detail: "Linux box doesn't answer: check that it's on and connected to Tailscale, then try again." });
    const v = (await a.api<PoolView>("POST", "/api/pool/check")).data;
    expect(v.machines.find((m) => m.id === b.app.hubId())).toMatchObject({ state: "offline", detail: "Linux box doesn't answer: check that it's on and connected to Tailscale, then try again." });
    await stopPool(a);
  }, SLOW);

  test("controller routes: a person's device or a full sign-in only, never another machine's agents", async () => {
    const peer = (await a.app.auth.pair((await a.app.auth.createPairingCode(undefined, { scope: "peer", hubId: "h_otherhub0001" })).code, "Other machine (hub)", "Crosstalk hub"))!.token;
    for (const [method, path, body] of [
      ["GET", "/api/pool"],
      ["PUT", "/api/pool", { config: { contextSize: 65536 } }],
      ["POST", "/api/pool/check"],
      ["POST", "/api/pool/start"],
      ["POST", "/api/pool/stop"],
      ["GET", "/api/pool/models?repo=acme/Tiny-GGUF"],
      ["PUT", "/api/pool/hf-token", { token: null }],
      ["GET", "/api/pool/helper-command?machine=pc_gaming001"],
      ["GET", "/api/pool/tailscale"],
      ["POST", "/api/pool/model/remove", { files: ["x.gguf"] }],
    ] as [string, string, unknown?][]) {
      const r = await a.api<{ code?: string }>(method, path, body, peer);
      expect([path, r.status, r.data.code]).toEqual([path, 403, "peer_scope"]);
    }
    expect(state(a).state).toBe("off");
    expect((await a.api("GET", "/api/pool", undefined, "not-a-token")).status).toBe(401);
  }, SLOW);
});
