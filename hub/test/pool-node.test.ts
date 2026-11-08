// The model pool's machine layer (hub/src/pool: llama.ts, models.ts, node.ts) against fakes only: a fake GitHub with
// a release tarball made here, a fake Hugging Face, fake llama-server / ggml-rpc-server programs and a fake tailscale.
// Everything listens on 127.0.0.1; nothing is downloaded from the internet and nothing is left running.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { PoolBackend, PoolModel, PoolNodeInfo } from "@crosstalk/shared";
import { App } from "../src/app";
import { HOME } from "../src/config";
import { HttpError } from "../src/engine/engine";
import { startServer } from "../src/server";
import { assetsFor, findInstall, hostPlatform, install, installedBuilds, listDevices, llamaDir, parseDevices } from "../src/pool/llama";
import { checkModel, choices, download, groupModels, modelPath, modelsDir, modelsOnDisk, parseRepoInput, quantOf, revisionFile, toTrash } from "../src/pool/models";
import { PoolNodeRuntime, serverArgs, tailscaleIPv4 } from "../src/pool/node";
import { cudartTarball, fakeGitHub, fakeHuggingFace, freePort, installScript, llamaTarball, sha256, type FakeRepo } from "./fixtures/pool-fakes";

const BUILD = "b11669";
const BACKEND: PoolBackend = hostPlatform().os === "macos" ? "metal" : "vulkan";
const MAC = hostPlatform().os === "macos";
const KEY = "pool-test-key-0123456789abcdef";
const TOKEN = "hf_testtoken0123456789";
const TS_IP = "100.101.102.103";

const work = realpathSync(mkdtempSync(join(tmpdir(), "ct-pool-")));
const llamaLog = join(work, "llama.jsonl");
const rpcLog = join(work, "rpc.jsonl");
const fakeTailscale = join(work, "tailscale");
const ENV = [
  "CROSSTALK_GITHUB_API",
  "CROSSTALK_LLAMA_RELEASES",
  "CROSSTALK_HF_URL",
  "CROSSTALK_TAILSCALE_BIN",
  "CROSSTALK_POOL_LOOPBACK",
  "CROSSTALK_UPLOAD_RESERVE_BYTES",
  "FAKE_TAILSCALE_IP",
  "FAKE_LLAMA_LOG",
  "FAKE_RPC_LOG",
  "FAKE_LLAMA_DEVICES",
  "FAKE_LLAMA_LOAD_MS",
  "FAKE_LLAMA_RPC_DEVICES",
  "FAKE_LLAMA_RPC_HANG",
];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const bytes = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 8)) & 255;
  return b;
};
const FILES = {
  "Tiny-Q4_K_M.gguf": bytes(300_000, 1),
  "Tiny-Q8_0.gguf": bytes(520_000, 2),
  "Tiny-UD-Q6_K_XL.gguf": bytes(410_000, 3),
  "mmproj-Tiny-F16.gguf": bytes(90_000, 4),
  "BF16/Tiny-BF16-00002-of-00002.gguf": bytes(350_000, 5),
  "BF16/Tiny-BF16-00001-of-00002.gguf": bytes(400_000, 6),
  "IQ4_XS/Tiny-IQ4_XS-00001-of-00003.gguf": bytes(100_000, 7),
  "Slow-Q2_K.gguf": bytes(1_200_000, 8),
  "README.md": new TextEncoder().encode("# Tiny"),
};
const BROKEN = new TextEncoder().encode("BROKEN model file, not GGUF");
/** A repo whose file is uploaded again during the tests (Hugging Face keeps the old commit). */
const changing: FakeRepo = { files: { "Changing-Q4_K_M.gguf": bytes(600_000, 11) } };

let gh: ReturnType<typeof fakeGitHub>;
let hf: ReturnType<typeof fakeHuggingFace>;
const nodes: PoolNodeRuntime[] = [];

const model = (file: keyof typeof FILES, repo = "acme/Tiny-GGUF"): PoolModel => ({ repo, files: [file], quant: quantOf(file), sizeBytes: FILES[file].length, gated: false });
const runtime = (opts: { stateFile?: string } = {}) => {
  const node = new PoolNodeRuntime({ hubId: () => "h_testnode0001", name: () => "Test machine", ...opts });
  node.trashOptions = { home: join(work, "trash-home"), gio: false };
  nodes.push(node);
  return node;
};
const runs = (file: string): { argv: string[]; pid: number; apiKey?: string | null; cache: string | null; cwd: string; crosstalkEnv?: string[] }[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
}
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected it to fail");
};
const ensureInstalled = () => install(BUILD, BACKEND);
const ensureModel = async (m: PoolModel) => {
  if (!existsSync(modelPath(m))) await download(m, null, () => {});
};

beforeAll(async () => {
  const tarball = await llamaTarball(work, BUILD);
  const older = await llamaTarball(work, "b10999", { rpcName: "rpc-server" });
  const cudart = await cudartTarball(work);
  const assets = (build: string, archive: Uint8Array, digest?: string | null) => {
    const a = (b: Uint8Array) => (digest === undefined ? { bytes: b } : { bytes: b, digest });
    return {
      [`llama-${build}-bin-macos-arm64.tar.gz`]: a(archive),
      [`llama-${build}-bin-ubuntu-vulkan-x64.tar.gz`]: a(archive),
      [`llama-${build}-bin-ubuntu-x64.tar.gz`]: a(archive),
      [`llama-${build}-bin-ubuntu-cuda-12.8-x64.tar.gz`]: a(archive),
      [`cudart-llama-${build}-bin-ubuntu-cuda-12.8-x64.tar.gz`]: a(cudart),
    };
  };
  gh = fakeGitHub({
    [BUILD]: assets(BUILD, tarball),
    b11670: assets("b11670", tarball, `sha256:${"0".repeat(64)}`),
    b11671: assets("b11671", tarball, null),
    b10999: assets("b10999", older),
  });
  hf = fakeHuggingFace(
    {
      "acme/Tiny-GGUF": { files: FILES },
      "acme/Gated-GGUF": { gated: "manual", files: { "Gated-Q4_K_M.gguf": bytes(200_000, 9) } },
      "acme/Broken-GGUF": { files: { "Broken-Q4_0.gguf": BROKEN } },
      "acme/Docs": { files: { "README.md": new TextEncoder().encode("no models") } },
      "acme/Changing-GGUF": changing,
    },
    { token: TOKEN, pageSize: 4 },
  );
  hf.slow.add("acme/Tiny-GGUF/Slow-Q2_K.gguf");
  installScript("fake-tailscale", fakeTailscale);
  Object.assign(process.env, {
    CROSSTALK_GITHUB_API: gh.api,
    CROSSTALK_LLAMA_RELEASES: gh.releases,
    CROSSTALK_HF_URL: hf.url,
    CROSSTALK_TAILSCALE_BIN: fakeTailscale,
    FAKE_LLAMA_LOG: llamaLog,
    FAKE_RPC_LOG: rpcLog,
  });
});

afterAll(async () => {
  await Promise.all(nodes.map((n) => n.shutdown()));
  gh?.stop();
  hf?.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // The hub's home is shared by the test run: leave no builds or models for other tests to find.
  rmSync(llamaDir(), { recursive: true, force: true });
  rmSync(modelsDir(), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("llama.cpp builds", () => {
  test("asset names per platform, and plain refusals for the ones llama.cpp doesn't make", () => {
    expect(assetsFor(BUILD, "macos", "arm64", "metal")).toEqual(["llama-b11669-bin-macos-arm64.tar.gz"]);
    expect(assetsFor(BUILD, "linux", "x64", "vulkan")).toEqual(["llama-b11669-bin-ubuntu-vulkan-x64.tar.gz"]);
    expect(assetsFor(BUILD, "linux", "x64", "cpu")).toEqual(["llama-b11669-bin-ubuntu-x64.tar.gz"]);
    expect(assetsFor(BUILD, "linux", "x86_64", "cuda")).toEqual(["llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz", "cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz"]);
    expect(assetsFor(BUILD, "windows", "x64", "vulkan")).toEqual(["llama-b11669-bin-win-vulkan-x64.zip"]);
    expect(assetsFor(BUILD, "windows", "x64", "cuda")).toEqual(["llama-b11669-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"]);
    const refusal = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as HttpError;
      }
      throw new Error("expected a refusal");
    };
    expect(refusal(() => assetsFor(BUILD, "macos", "arm64", "vulkan"))).toMatchObject({ status: 400, message: expect.stringContaining("pick Metal") });
    expect(refusal(() => assetsFor(BUILD, "macos", "x64", "metal")).message).toContain("Apple silicon");
    expect(refusal(() => assetsFor(BUILD, "linux", "arm64", "vulkan")).message).toContain("x64");
    expect(refusal(() => assetsFor(BUILD, "linux", "x64", "metal")).message).toContain("Vulkan, CUDA or CPU");
    expect(refusal(() => assetsFor("11669", "linux", "x64", "cpu")).status).toBe(400);
  });

  test("install downloads the build, checks its digest, unpacks it in one step and finds the programs", async () => {
    const progress: number[] = [];
    const before = gh.hits.length;
    const [a, b] = await Promise.all([install(BUILD, BACKEND, (p) => progress.push(p.doneBytes)), install(BUILD, BACKEND)]);
    expect(a).toEqual(b);
    expect(a.dir).toBe(join(HOME, "llama", `${BUILD}-${BACKEND}`));
    expect(a.server).toBe(join(a.dir, `llama-${BUILD}`, "llama-server"));
    expect(a.rpc).toBe(join(a.dir, `llama-${BUILD}`, "ggml-rpc-server"));
    // The libraries stay next to the programs, which are executable.
    expect(existsSync(join(a.dir, `llama-${BUILD}`, "libggml-rpc.dylib"))).toBe(true);
    for (const bin of [a.server, a.rpc!]) expect(statSync(bin).mode & 0o111).toBe(0o111);
    // One download for both calls: the release JSON and one file (through GitHub's redirect).
    const asset = assetsFor(BUILD, hostPlatform().os, hostPlatform().arch, BACKEND)[0];
    expect(gh.hits.slice(before)).toEqual([`/api/repos/ggml-org/llama.cpp/releases/tags/${BUILD}`, `/download/${BUILD}/${asset}`, `/objects/${BUILD}/${asset}`]);
    expect(progress.length).toBeGreaterThan(0);
    expect(installedBuilds()).toContain(`${BUILD}-${BACKEND}`);
    // Nothing left of the staging folder; installing again does nothing.
    expect(readdirSync(llamaDir()).filter((n) => n.startsWith("."))).toEqual([]);
    const hits = gh.hits.length;
    expect(await install(BUILD, BACKEND)).toEqual(a);
    expect(gh.hits.length).toBe(hits);
  });

  test("a download that doesn't match GitHub's digest is refused and nothing is installed", async () => {
    const e = await rejection(install("b11670", BACKEND));
    expect(e).toBeInstanceOf(HttpError);
    expect(e.message).toContain("doesn't match the checksum GitHub lists");
    expect(e.message).toContain("Try again");
    expect(existsSync(join(llamaDir(), `b11670-${BACKEND}`))).toBe(false);
    expect(findInstall("b11670", BACKEND)).toBeNull();
    expect(readdirSync(llamaDir()).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a release without digests still installs; an unknown build says to check its name", async () => {
    expect((await install("b11671", BACKEND)).rpc).toEndWith("ggml-rpc-server");
    expect(installedBuilds()).toContain(`b11671-${BACKEND}`);
    const e = await rejection(install("b99999", BACKEND));
    expect(e).toMatchObject({ status: 404, message: expect.stringContaining("check the build name") });
    rmSync(join(llamaDir(), `b11671-${BACKEND}`), { recursive: true });
  });

  test("CUDA on Linux: the runtime companion's libraries go next to the programs", async () => {
    const inst = await install(BUILD, "cuda", undefined, { platform: { os: "linux", arch: "x64" } });
    const binDir = join(inst.dir, `llama-${BUILD}`);
    expect(inst.server).toBe(join(binDir, "llama-server"));
    expect(readFileSync(join(binDir, "libcudart.so.12"), "utf8")).toBe("fake cudart");
    expect(existsSync(join(binDir, "libcublas.so.12"))).toBe(true);
    rmSync(inst.dir, { recursive: true });
  });

  test("older builds name the RPC server rpc-server", async () => {
    const inst = await install("b10999", BACKEND);
    expect(inst.rpc).toBe(join(inst.dir, "llama-b10999", "rpc-server"));
  });
});

describe("devices", () => {
  test("parses --list-devices: real lines, RPC devices, (none), and devices without memory left out", () => {
    const real = [
      "Available devices:",
      "  MTL0: Apple M4 (12124 MiB, 12123 MiB free)",
      "  BLAS: Accelerate (0 MiB, 0 MiB free)",
      "  RPC0: 127.0.0.1:50177 (12124 MiB, 12123 MiB free)",
      "  Vulkan0: AMD Radeon RX 7600 XT (RADV NAVI33) (16304 MiB, 15890 MiB free)",
      "  RPC[100.64.0.2:50052]: 100.64.0.2:50052 (8192 MiB, 7900 MiB free)",
      "load_backend: loaded RPC backend from /x/libggml-rpc.so",
    ].join("\n");
    expect(parseDevices(real)).toEqual([
      { name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 },
      { name: "RPC0", description: "127.0.0.1:50177", totalMiB: 12124, freeMiB: 12123 },
      { name: "Vulkan0", description: "AMD Radeon RX 7600 XT (RADV NAVI33)", totalMiB: 16304, freeMiB: 15890 },
      { name: "RPC[100.64.0.2:50052]", description: "100.64.0.2:50052", totalMiB: 8192, freeMiB: 7900 },
    ]);
    expect(parseDevices("Available devices:\n  (none)\n")).toEqual([]);
    expect(parseDevices("")).toEqual([]);
  });

  test("lists this machine's GPUs and, with --rpc first, a helper's; an unreachable helper is said plainly", async () => {
    const inst = await ensureInstalled();
    expect(await listDevices(inst.server)).toEqual([{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }]);
    const helper = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const devices = await listDevices(inst.server, [`127.0.0.1:${helper.port}`]);
      expect(devices.map((d) => d.name)).toEqual(["MTL0", "RPC0"]);
      expect(runs(llamaLog).at(-1)!.argv).toEqual(["--rpc", `127.0.0.1:${helper.port}`, "--list-devices"]);
    } finally {
      helper.stop(true);
    }
    const gone = freePort();
    const e = await rejection(listDevices(inst.server, [`127.0.0.1:${gone}`]));
    expect(e.message).toBe(`Couldn't reach the helper at 127.0.0.1:${gone}: check that it's running and on Tailscale, then check again.`);
    process.env.FAKE_LLAMA_DEVICES = "none";
    try {
      expect(await listDevices(inst.server)).toEqual([]);
    } finally {
      delete process.env.FAKE_LLAMA_DEVICES;
    }
  });
});

describe("Hugging Face", () => {
  test("reads repo names, repo links and file links", () => {
    expect(parseRepoInput("acme/Tiny-GGUF")).toEqual({ repo: "acme/Tiny-GGUF", file: null });
    expect(parseRepoInput(" https://huggingface.co/acme/Tiny-GGUF/ ")).toEqual({ repo: "acme/Tiny-GGUF", file: null });
    expect(parseRepoInput("https://huggingface.co/acme/Tiny-GGUF/tree/main")).toEqual({ repo: "acme/Tiny-GGUF", file: null });
    expect(parseRepoInput("huggingface.co/acme/Tiny-GGUF/blob/main/Tiny-Q8_0.gguf")).toEqual({ repo: "acme/Tiny-GGUF", file: "Tiny-Q8_0.gguf" });
    expect(parseRepoInput("https://hf.co/acme/Tiny-GGUF/resolve/main/BF16/Tiny-BF16-00001-of-00002.gguf?download=true")).toEqual({ repo: "acme/Tiny-GGUF", file: "BF16/Tiny-BF16-00001-of-00002.gguf" });
    for (const bad of ["", "acme", "https://example.com/acme/Tiny-GGUF", "https://huggingface.co/datasets/acme/x", "../etc/passwd", "acme/../x", "https://huggingface.co/acme/Tiny-GGUF/blob/main/..%2F..%2Fx.gguf"]) {
      expect(() => parseRepoInput(bad)).toThrow(HttpError);
    }
  });

  test("reads the quant from file names", () => {
    const cases: Record<string, string | null> = {
      "Qwen3-8B-Q4_K_M.gguf": "Q4_K_M",
      "Qwen3-8B-IQ4_XS.gguf": "IQ4_XS",
      "Qwen3-30B-A3B-UD-Q6_K_XL.gguf": "UD-Q6_K_XL",
      "UD-Q6_K/Qwen3-UD-Q6_K-00001-of-00002.gguf": "UD-Q6_K",
      "gpt-oss-20b-MXFP4.gguf": "MXFP4",
      "model-f16.gguf": "F16",
      "Model-BF16-00001-of-00003.gguf": "BF16",
      "llama-2-7b.Q8_0.gguf": "Q8_0",
      "DeepSeek-R1-UD-IQ1_S.gguf": "UD-IQ1_S",
      "Qwen2.5-Coder-7B-Instruct-IQ2_XXS.gguf": "IQ2_XXS",
      "tiny-Q4_0_4_4.gguf": "Q4_0_4_4",
      "plain-model.gguf": null,
    };
    for (const [name, quant] of Object.entries(cases)) expect([name, quantOf(name)]).toEqual([name, quant]);
  });

  test("groups split parts in order, leaves out mmproj files and incomplete models, smallest first", () => {
    const files = Object.entries(FILES).map(([path, b]) => ({ path, size: b.length }));
    const models = groupModels("acme/Tiny-GGUF", files, false);
    expect(models.map((m) => m.files)).toEqual([
      ["Tiny-Q4_K_M.gguf"],
      ["Tiny-UD-Q6_K_XL.gguf"],
      ["Tiny-Q8_0.gguf"],
      ["BF16/Tiny-BF16-00001-of-00002.gguf", "BF16/Tiny-BF16-00002-of-00002.gguf"],
      ["Slow-Q2_K.gguf"],
    ]);
    expect(models[3]).toEqual({ repo: "acme/Tiny-GGUF", files: ["BF16/Tiny-BF16-00001-of-00002.gguf", "BF16/Tiny-BF16-00002-of-00002.gguf"], quant: "BF16", sizeBytes: 750_000, gated: false });
  });

  test("choices: info and every page of the file tree; a file link puts its model first; the token only when given", async () => {
    const before = hf.requests.length;
    const c = await choices("acme/Tiny-GGUF");
    expect(c.repo).toBe("acme/Tiny-GGUF");
    expect(c.gated).toBe(false);
    expect(c.models.map((m) => m.quant)).toEqual(["Q4_K_M", "UD-Q6_K_XL", "Q8_0", "BF16", "Q2_K"]);
    const seen = hf.requests.slice(before);
    expect(seen[0].path).toBe("/api/models/acme/Tiny-GGUF");
    expect(seen.slice(1).map((r) => r.path)).toEqual([
      "/api/models/acme/Tiny-GGUF/tree/main?recursive=true",
      "/api/models/acme/Tiny-GGUF/tree/main?recursive=true&cursor=4",
      "/api/models/acme/Tiny-GGUF/tree/main?recursive=true&cursor=8",
    ]);
    expect(seen.every((r) => r.auth === null)).toBe(true);
    const linked = await choices("https://huggingface.co/acme/Tiny-GGUF/blob/main/BF16/Tiny-BF16-00002-of-00002.gguf", TOKEN);
    expect(linked.models[0].quant).toBe("BF16");
    expect(linked.models).toHaveLength(5);
    expect(hf.requests.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    const gated = await choices("acme/Gated-GGUF");
    expect(gated.gated).toBe(true);
    expect(gated.models[0]).toMatchObject({ files: ["Gated-Q4_K_M.gguf"], gated: true });
    expect((await rejection(choices("acme/Missing-GGUF"))).message).toContain("Couldn't find acme/Missing-GGUF on Hugging Face: check the name");
    expect((await rejection(choices("acme/Docs"))).message).toContain("has no GGUF model files");
  });

  test("download writes to the models folder; the token goes to Hugging Face only, never to its storage", async () => {
    const m = model("Tiny-Q8_0.gguf");
    const path = await download(m, TOKEN, () => {});
    expect(path).toBe(join(HOME, "models", "acme", "Tiny-GGUF", "Tiny-Q8_0.gguf"));
    expect(path).toBe(modelPath(m));
    expect(sha256(new Uint8Array(readFileSync(path)))).toBe(sha256(FILES["Tiny-Q8_0.gguf"]));
    expect(existsSync(`${path}.part`)).toBe(false);
    // From the repo's newest commit, which the download was pinned to when it began.
    expect(hf.requests.at(-2)).toMatchObject({ path: "/api/models/acme/Tiny-GGUF", auth: `Bearer ${TOKEN}` });
    // (Checked field by field: Bun's toMatchObject puts an expect.stringMatching into the object it checks.)
    expect(hf.requests.at(-1)!.path).toMatch(/^\/acme\/Tiny-GGUF\/resolve\/[0-9a-f]{40}\/Tiny-Q8_0\.gguf$/);
    expect(hf.requests.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    expect(hf.storageRequests.at(-1)).toMatchObject({ auth: null });
    expect(modelsOnDisk()).toContain("acme/Tiny-GGUF/Tiny-Q8_0.gguf");
    // A split model: every part, in its folder.
    const split = groupModels("acme/Tiny-GGUF", Object.entries(FILES).map(([p, b]) => ({ path: p, size: b.length })), false).find((x) => x.quant === "BF16")!;
    expect(await download(split, null, () => {})).toBe(join(HOME, "models", "acme", "Tiny-GGUF", "BF16", "Tiny-BF16-00001-of-00002.gguf"));
    expect(hf.requests.at(-1)!.auth).toBeNull();
    expect(readFileSync(join(HOME, "models", "acme", "Tiny-GGUF", "BF16", "Tiny-BF16-00002-of-00002.gguf")).length).toBe(350_000);
  });

  test("an interrupted download picks up where it stopped (HTTP Range)", async () => {
    const m = model("Tiny-UD-Q6_K_XL.gguf");
    hf.cutOnce.add("acme/Tiny-GGUF/Tiny-UD-Q6_K_XL.gguf");
    const e = await rejection(download(m, null, () => {}));
    expect(e.message).toContain("picks up where it stopped");
    const part = `${modelPath(m)}.part`;
    const had = statSync(part).size;
    expect(had).toBe(205_000);
    expect(existsSync(modelPath(m))).toBe(false);
    await download(m, null, () => {});
    expect(hf.storageRequests.at(-1)!.range).toBe(`bytes=${had}-`);
    expect(sha256(new Uint8Array(readFileSync(modelPath(m))))).toBe(sha256(FILES["Tiny-UD-Q6_K_XL.gguf"]));
    expect(existsSync(part)).toBe(false);
  });

  test("a download stays with the version it began with: a file uploaded again meanwhile is never joined to the old bytes", async () => {
    const m: PoolModel = { repo: "acme/Changing-GGUF", files: ["Changing-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 600_000, gated: false };
    const first = changing.files["Changing-Q4_K_M.gguf"];
    const began = changing.sha!;
    hf.cutOnce.add("acme/Changing-GGUF/Changing-Q4_K_M.gguf");
    expect((await rejection(download(m, null, () => {}))).message).toContain("picks up where it stopped");
    // Pinned to the commit it began with, kept beside the unfinished file.
    expect(readFileSync(revisionFile(m), "utf8").trim()).toBe(began);
    const part = statSync(`${modelPath(m)}.part`).size;
    expect(part).toBeGreaterThan(0);
    // Uploaded again on main meanwhile (Hugging Face keeps the old commit).
    changing.history = { [began]: { "Changing-Q4_K_M.gguf": first } };
    changing.files = { "Changing-Q4_K_M.gguf": bytes(600_000, 12) };
    changing.sha = "c".repeat(40);
    await download(m, null, () => {});
    expect(Buffer.compare(readFileSync(modelPath(m)), Buffer.from(first))).toBe(0);
    expect(hf.requests.filter((r) => r.path.includes("/resolve/")).slice(-1)[0].path).toBe(`/acme/Changing-GGUF/resolve/${began}/Changing-Q4_K_M.gguf`);
    expect(existsSync(revisionFile(m))).toBe(false);

    // A commit that's gone (its history rewritten): a download with nothing finished starts again from the newest.
    rmSync(modelPath(m), { force: true });
    hf.cutOnce.add("acme/Changing-GGUF/Changing-Q4_K_M.gguf");
    await rejection(download(m, null, () => {}));
    expect(readFileSync(revisionFile(m), "utf8").trim()).toBe("c".repeat(40));
    changing.history = {};
    changing.files = { "Changing-Q4_K_M.gguf": bytes(600_000, 13) };
    changing.sha = "d".repeat(40);
    await download(m, null, () => {});
    expect(Buffer.compare(readFileSync(modelPath(m)), Buffer.from(changing.files["Changing-Q4_K_M.gguf"]))).toBe(0);
    expect(existsSync(revisionFile(m))).toBe(false);
  });

  test("progress comes at most twice a second", async () => {
    const m = model("Slow-Q2_K.gguf");
    const at: number[] = [];
    await download(m, null, (p) => {
      at.push(Date.now());
      expect(p.totalBytes).toBe(1_200_000);
      expect(p.file).toBe("Slow-Q2_K.gguf");
    });
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(495);
    rmSync(modelPath(m));
  });

  test("a gated model without the token says to accept its terms and save a token", async () => {
    const m: PoolModel = { repo: "acme/Gated-GGUF", files: ["Gated-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 200_000, gated: true };
    for (const token of [null, "hf_wrong_token_00000"]) {
      const e = await rejection(download(m, token, () => {}));
      expect(e.status).toBe(403);
      expect(e.message).toBe("Hugging Face won't let this download acme/Gated-GGUF yet: open huggingface.co/acme/Gated-GGUF, accept the model's terms, then save a Hugging Face token (from the same account) and try again.");
      expect(e.message).not.toContain("hf_wrong");
    }
    expect(await download(m, TOKEN, () => {})).toBe(modelPath(m));
  });

  test("refuses to start when the disk would be left with less than 2 GB free", async () => {
    const m: PoolModel = { repo: "acme/Tiny-GGUF", files: ["Tiny-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 10 ** 15, gated: false };
    const before = hf.requests.length;
    const e = await rejection(download(m, null, () => {}));
    expect(e).toMatchObject({ status: 507, code: "low_disk" });
    expect(e.message).toContain("Not enough free space");
    expect(e.message).toContain("pick a smaller quant");
    expect(hf.requests.length).toBe(before);
    expect(existsSync(`${modelPath(m)}.part`)).toBe(false);
  });

  test("checks a model from another hub strictly", () => {
    const ok = model("Tiny-Q4_K_M.gguf");
    expect(checkModel(ok)).toEqual(ok);
    const bad: unknown[] = [
      null,
      { ...ok, repo: "../etc" },
      { ...ok, repo: "acme/Tiny-GGUF/extra" },
      { ...ok, files: ["../../secrets.gguf"] },
      { ...ok, files: ["/etc/passwd.gguf"] },
      { ...ok, files: ["Tiny-Q4_K_M.txt"] },
      { ...ok, files: [] },
      { ...ok, files: ["mmproj-Tiny-F16.gguf"] },
      { ...ok, files: ["BF16/Tiny-BF16-00001-of-00002.gguf"] },
      { ...ok, files: ["BF16/Tiny-BF16-00002-of-00002.gguf", "BF16/Tiny-BF16-00001-of-00002.gguf"] },
      { ...ok, files: ["a\\b.gguf"] },
      { ...ok, sizeBytes: -1 },
    ];
    for (const m of bad) expect(() => checkModel(m)).toThrow(HttpError);
  });

  test("toTrash moves files into the Trash under free names, never deleting them", async () => {
    const home = join(work, "trash-test");
    const a = join(work, "one", "Tiny-Q4_K_M.gguf");
    const b = join(work, "two", "Tiny-Q4_K_M.gguf");
    for (const p of [a, b]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "model");
    }
    const moved = await toTrash([a, b, join(work, "missing.gguf")], { home, platform: "darwin" });
    expect(moved).toEqual([join(home, ".Trash", "Tiny-Q4_K_M.gguf"), join(home, ".Trash", "Tiny-Q4_K_M 2.gguf")]);
    expect(existsSync(a) || existsSync(b)).toBe(false);
    for (const p of moved) expect(readFileSync(p, "utf8")).toBe("model");
    // Linux without gio: the freedesktop.org Trash, with a .trashinfo for each.
    writeFileSync(a, "model");
    writeFileSync(b, "model");
    const linux = await toTrash([a, b], { home, platform: "linux", gio: false });
    const trash = join(home, ".local", "share", "Trash");
    expect(linux).toEqual([join(trash, "files", "Tiny-Q4_K_M.gguf"), join(trash, "files", "Tiny-Q4_K_M.2.gguf")]);
    const info = readFileSync(join(trash, "info", "Tiny-Q4_K_M.2.gguf.trashinfo"), "utf8");
    expect(info).toStartWith(`[Trash Info]\nPath=${b}\nDeletionDate=`);
    expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
  });

  test("a file on another drive goes in that drive's own Trash, never copied onto this disk; without one it stays where it is", async () => {
    const home = join(work, "trash-drive-home");
    const drive = join(work, "drive");
    const file = join(drive, "models", "acme", "Tiny-GGUF", "Tiny-Q4_K_M.gguf");
    mkdirSync(dirname(file), { recursive: true });
    const uid = String(process.getuid?.() ?? 0);
    // A pretend machine: the drive folder is another device than everything else.
    const deviceOf = (p: string) => (!existsSync(p) ? null : realpathSync(p) === drive || realpathSync(p).startsWith(drive + sep) ? 2 : 1);
    // A Mac: the Finder's <drive>/.Trashes/<uid>, made as the Finder makes it.
    writeFileSync(file, "model");
    expect(await toTrash([file], { home, platform: "darwin", deviceOf })).toEqual([join(drive, ".Trashes", uid, "Tiny-Q4_K_M.gguf")]);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(home, ".Trash"))).toEqual([]);
    expect(statSync(join(drive, ".Trashes")).mode & 0o7777).toBe(0o1333);
    // As the Finder makes it, no one can list it: opened up again so the test's folder can go.
    chmodSync(join(drive, ".Trashes"), 0o755);
    // Linux: the drive's .Trash-<uid>, its path from the drive's top; an administrator's shared .Trash when there is one.
    writeFileSync(file, "model");
    expect(await toTrash([file], { home, platform: "linux", gio: false, deviceOf })).toEqual([join(drive, `.Trash-${uid}`, "files", "Tiny-Q4_K_M.gguf")]);
    expect(readFileSync(join(drive, `.Trash-${uid}`, "info", "Tiny-Q4_K_M.gguf.trashinfo"), "utf8")).toStartWith("[Trash Info]\nPath=models/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf\nDeletionDate=");
    expect(existsSync(join(home, ".local", "share", "Trash", "files", "Tiny-Q4_K_M.gguf"))).toBe(false);
    mkdirSync(join(drive, ".Trash"));
    chmodSync(join(drive, ".Trash"), 0o1777);
    writeFileSync(file, "model");
    expect(await toTrash([file], { home, platform: "linux", gio: false, deviceOf })).toEqual([join(drive, ".Trash", uid, "files", "Tiny-Q4_K_M.gguf")]);
    // A drive whose Trash can't be made: it stays, and the words say what to do instead.
    if (process.getuid?.() !== 0) {
      rmSync(join(drive, ".Trashes"), { recursive: true, force: true });
      rmSync(join(drive, ".Trash"), { recursive: true, force: true });
      rmSync(join(drive, `.Trash-${uid}`), { recursive: true, force: true });
      writeFileSync(file, "model");
      chmodSync(drive, 0o555);
      try {
        for (const platform of ["darwin", "linux"] as const) {
          const err = await toTrash([file], { home, platform, gio: false, deviceOf }).catch((e) => e);
          expect(err).toMatchObject({ status: 409, code: "no_trash" });
          expect(err.message).toBe(`Tiny-Q4_K_M.gguf is on another drive, and Crosstalk can't use that drive's Trash: delete it for good instead, or delete it in ${platform === "darwin" ? "the Finder" : "the file manager"}.`);
          expect(readFileSync(file, "utf8")).toBe("model");
        }
      } finally {
        chmodSync(drive, 0o755);
      }
    }
  });
});

describe("the pool node", () => {
  test("reports itself: Tailscale address, builds, GPUs (cached), models and free disk", async () => {
    await ensureInstalled();
    await ensureModel(model("Tiny-Q4_K_M.gguf"));
    process.env.FAKE_TAILSCALE_IP = TS_IP;
    try {
      const node = runtime();
      const listed = runs(llamaLog).length;
      const info = await node.info();
      expect(info).toMatchObject({ hubId: "h_testnode0001", name: "Test machine", os: hostPlatform().os, arch: process.arch, address: TS_IP, busy: null });
      expect(info.installed).toContain(`${BUILD}-${BACKEND}`);
      expect(info.devices).toEqual([{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }]);
      expect(info.models).toContain("acme/Tiny-GGUF/Tiny-Q4_K_M.gguf");
      // With their sizes, and unfinished ones too (so the ones no longer used can be found and removed).
      expect(info.files).toContainEqual({ file: "acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", bytes: FILES["Tiny-Q4_K_M.gguf"].length, partial: false });
      const unfinished = join(modelsDir(), "acme", "Tiny-GGUF", "Unfinished-Q2_K.gguf.part");
      writeFileSync(unfinished, "half");
      expect(node.snapshot().files).toContainEqual({ file: "acme/Tiny-GGUF/Unfinished-Q2_K.gguf", bytes: 4, partial: true });
      expect(node.snapshot().models).not.toContain("acme/Tiny-GGUF/Unfinished-Q2_K.gguf");
      rmSync(unfinished);
      expect(info.freeDiskBytes).toBeGreaterThan(0);
      expect(info.helper).toEqual({ running: false, port: null, detail: null });
      expect(info.server).toEqual({ running: false, port: null, healthy: false, detail: null, log: [] });
      // The GPU list is kept: asked once, then again only when asked to.
      await node.info();
      expect(runs(llamaLog).length).toBe(listed + 1);
      await node.info({ refresh: true });
      expect(runs(llamaLog).length).toBe(listed + 2);
      expect(await tailscaleIPv4()).toBe(TS_IP);
    } finally {
      delete process.env.FAKE_TAILSCALE_IP;
    }
  });

  test("the helper refuses to start without Tailscale", async () => {
    await ensureInstalled();
    delete process.env.CROSSTALK_POOL_LOOPBACK;
    delete process.env.FAKE_TAILSCALE_IP;
    const node = runtime();
    const before = runs(rpcLog).length;
    for (const bin of [fakeTailscale, join(work, "no-such-tailscale")]) {
      process.env.CROSSTALK_TAILSCALE_BIN = bin;
      const e = await rejection(node.startHelper({ build: BUILD, backend: BACKEND, port: freePort() }));
      expect(e).toMatchObject({ status: 409, code: "no_tailscale" });
      expect(e.message).toContain("Tailscale isn't running on this machine: open Tailscale and sign in");
    }
    process.env.CROSSTALK_TAILSCALE_BIN = fakeTailscale;
    expect(runs(rpcLog).length).toBe(before);
    expect(node.snapshot().helper.running).toBe(false);
  });

  test("the helper runs ggml-rpc-server -H <address> -p <port> -c with LLAMA_CACHE; stop ends it", async () => {
    await ensureInstalled();
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    try {
      const node = runtime();
      const port = freePort();
      const info = await node.startHelper({ build: BUILD, backend: BACKEND, port });
      expect(info.helper).toEqual({ running: true, port, detail: `Lending its GPU at 127.0.0.1:${port}` });
      const run = runs(rpcLog).at(-1)!;
      // Exactly this machine's GPUs (never its CPU), as llama.cpp lists them here.
      expect(run.argv).toEqual(["-H", "127.0.0.1", "-p", String(port), "-d", "MTL0", "-c"]);
      expect(run.cache).toBe(join(HOME, "llama", "cache"));
      expect(existsSync(join(HOME, "llama", "cache", "rpc"))).toBe(true);
      const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      socket.end();
      // Asking again with the same settings leaves it running.
      await node.startHelper({ build: BUILD, backend: BACKEND, port });
      expect(runs(rpcLog).at(-1)!.pid).toBe(run.pid);
      await node.stopHelper();
      expect(alive(run.pid)).toBe(false);
      expect(node.snapshot().helper).toEqual({ running: false, port: null, detail: null });
    } finally {
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  });

  test("requests at the same time are taken one by one: never two helpers, none left untracked", async () => {
    await ensureInstalled();
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    try {
      const node = runtime();
      const before = runs(rpcLog).length;
      const [p1, p2] = [freePort(), freePort()];
      await Promise.all([node.startHelper({ build: BUILD, backend: BACKEND, port: p1 }), node.startHelper({ build: BUILD, backend: BACKEND, port: p1 }), node.startHelper({ build: BUILD, backend: BACKEND, port: p2 })]);
      const started = runs(rpcLog).slice(before);
      expect(started.map((r) => r.argv[3])).toEqual([String(p1), String(p2)]);
      expect(started.map((r) => alive(r.pid))).toEqual([false, true]);
      expect(node.snapshot().helper).toMatchObject({ running: true, port: p2 });
      await node.stopHelper();
      expect(alive(started[1].pid)).toBe(false);
    } finally {
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  });

  test("a helper on a taken port, an old build, or one that dies: each said plainly", async () => {
    await ensureInstalled();
    await install("b10999", BACKEND);
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const node = runtime();
      const e = await rejection(node.startHelper({ build: BUILD, backend: BACKEND, port: blocker.port }));
      expect(e.message).toBe(`The helper's port ${blocker.port} is already taken on this machine: close the program that uses it (an old helper window, say), then start again.`);
      expect(node.snapshot().helper).toMatchObject({ running: false, detail: e.message });
      const old = await rejection(node.startHelper({ build: "b10999", backend: BACKEND, port: freePort() }));
      expect(old).toMatchObject({ status: 400, message: expect.stringContaining("too old to lend a GPU safely") });
      // Supervision: a helper that dies is noticed, with what happened.
      await node.startHelper({ build: BUILD, backend: BACKEND, port: freePort() });
      const pid = runs(rpcLog).at(-1)!.pid;
      process.kill(pid, "SIGKILL");
      await until(() => !node.snapshot().helper.running);
      expect(node.snapshot().helper.detail).toBe("The helper stopped unexpectedly (it was killed, perhaps because the machine ran low on memory). Start it again; if it keeps happening, look at its log.");
    } finally {
      blocker.stop(true);
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  });

  test("the server: --rpc before -dev, the key kept out of argv, healthy once /health answers 200, stop ends it", async () => {
    await ensureInstalled();
    const m = model("Tiny-Q4_K_M.gguf");
    await ensureModel(m);
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    process.env.FAKE_LLAMA_LOAD_MS = "1500";
    try {
      const node = runtime();
      const helperPort = freePort();
      await node.startHelper({ build: BUILD, backend: BACKEND, port: helperPort });
      const port = freePort();
      const started = await node.startServer({ build: BUILD, backend: BACKEND, model: m, rpc: [`127.0.0.1:${helperPort}`], devices: ["RPC0"], contextSize: 8192, alias: "pool-test", port, host: "127.0.0.1", apiKey: KEY });
      expect(started.server).toMatchObject({ running: true, port, healthy: false, detail: expect.stringContaining("Loading the model") });
      // Loading: /health answers 503 first.
      let first = 0;
      await until(async () => {
        first = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status, () => 0);
        return first !== 0;
      });
      expect(first).toBe(503);
      await until(() => node.snapshot().server.healthy);
      expect(node.snapshot().server).toMatchObject({ running: true, port, healthy: true, detail: null });

      const run = runs(llamaLog).at(-1)!;
      const argv = run.argv;
      expect(argv.slice(0, 4)).toEqual(["--rpc", `127.0.0.1:${helperPort}`, "-dev", "RPC0"]);
      expect(argv.slice(4)).toEqual(["-m", modelPath(m), "-c", "8192", "-np", "1", "-ngl", "all", "-a", "pool-test", "--host", "127.0.0.1", "--port", String(port), "--cache-ram", "0", "--metrics", ...(MAC ? ["--load-mode", "none"] : [])]);
      expect(argv.join(" ")).not.toContain(KEY);
      expect(run.apiKey).toBe(KEY);
      expect(run.crosstalkEnv).toEqual([]);
      expect(run.cwd).toBe(realpathSync(join(HOME, "llama", `${BUILD}-${BACKEND}`, `llama-${BUILD}`)));

      expect((await fetch(`http://127.0.0.1:${port}/props`)).status).toBe(401);
      const auth = { headers: { authorization: `Bearer ${KEY}` } };
      const props = (await (await fetch(`http://127.0.0.1:${port}/props`, auth)).json()) as { default_generation_settings: { n_ctx: number } };
      expect(props.default_generation_settings.n_ctx).toBe(8192);
      const listed = (await (await fetch(`http://127.0.0.1:${port}/v1/models`, auth)).json()) as { data: { id: string }[] };
      expect(listed.data[0].id).toBe("pool-test");
      expect(node.snapshot().server.log.some((l) => l.includes("listening on"))).toBe(true);

      const stopped = await node.stopServer();
      expect(alive(run.pid)).toBe(false);
      expect(stopped.server).toMatchObject({ running: false, port: null, healthy: false, detail: null });
      await node.stopHelper();
    } finally {
      delete process.env.CROSSTALK_POOL_LOOPBACK;
      delete process.env.FAKE_LLAMA_LOAD_MS;
    }
  });

  test("argv without helpers: no --rpc, -dev only when given ([] is none), --load-mode only with helpers on a Mac", () => {
    const o = { rpc: [], devices: null, contextSize: 0, alias: "m", host: "127.0.0.1", port: 9931 };
    // One request at a time with the whole context (-np 1), and every layer on the GPUs (-ngl all).
    expect(serverArgs("/x/llama-server", o, "/m.gguf", "macos")).toEqual(["/x/llama-server", "-m", "/m.gguf", "-c", "0", "-np", "1", "-ngl", "all", "-a", "m", "--host", "127.0.0.1", "--port", "9931", "--cache-ram", "0", "--metrics"]);
    // No GPU at all: nothing to put layers on.
    expect(serverArgs("/x/llama-server", { ...o, devices: [] }, "/m.gguf", "linux")).toEqual(["/x/llama-server", "-dev", "none", "-m", "/m.gguf", "-c", "0", "-np", "1", "-a", "m", "--host", "127.0.0.1", "--port", "9931", "--cache-ram", "0", "--metrics"]);
    expect(serverArgs("/x/llama-server", { ...o, rpc: ["100.64.0.2:50052", "100.64.0.3:50052"], devices: ["Vulkan0", "RPC0", "RPC1"] }, "/m.gguf", "linux")).toEqual([
      "/x/llama-server", "--rpc", "100.64.0.2:50052,100.64.0.3:50052", "-dev", "Vulkan0,RPC0,RPC1", "-m", "/m.gguf", "-c", "0", "-np", "1", "-ngl", "all", "-a", "m", "--host", "127.0.0.1", "--port", "9931", "--cache-ram", "0", "--metrics",
    ]);
  });

  test("a server that stops on its own gets a plain detail from its last lines", async () => {
    await ensureInstalled();
    const broken: PoolModel = { repo: "acme/Broken-GGUF", files: ["Broken-Q4_0.gguf"], quant: "Q4_0", sizeBytes: BROKEN.length, gated: false };
    await ensureModel(broken);
    const node = runtime();
    await node.startServer({ build: BUILD, backend: BACKEND, model: broken, rpc: [], devices: null, contextSize: 4096, alias: "broken", port: freePort(), host: "127.0.0.1", apiKey: KEY });
    await until(() => !node.snapshot().server.running);
    const s = node.snapshot().server;
    expect(s.detail).toBe("llama.cpp couldn't load the model: download it again or pick another quant, then start again.");
    expect(s.log.some((l) => l.includes("exiting due to model loading error"))).toBe(true);
    // Not downloaded, not installed: refused before anything runs.
    expect((await rejection(node.startServer({ build: BUILD, backend: BACKEND, model: model("Tiny-Q8_0.gguf", "acme/Other-GGUF"), rpc: [], devices: null, contextSize: 0, alias: "x", port: freePort(), host: "127.0.0.1", apiKey: KEY }))).code).toBe("no_model");
    expect((await rejection(node.startServer({ build: "b11672", backend: BACKEND, model: broken, rpc: [], devices: null, contextSize: 0, alias: "x", port: freePort(), host: "127.0.0.1", apiKey: KEY }))).code).toBe("not_installed");
  });

  test("downloads in the background: busy shows progress, cancel keeps what's there, the next one continues", async () => {
    const node = runtime();
    const m = model("Slow-Q2_K.gguf");
    rmSync(modelPath(m), { force: true });
    rmSync(`${modelPath(m)}.part`, { force: true });
    const changes: PoolNodeInfo[] = [];
    node.onChange((i) => changes.push(i));
    await node.downloadModel(m, null);
    await until(() => (node.snapshot().busy?.doneBytes ?? 0) > 0);
    expect(node.snapshot().busy).toMatchObject({ what: "download", file: "Slow-Q2_K.gguf", totalBytes: 1_200_000 });
    await node.cancelDownload();
    expect(node.snapshot().busy).toBeNull();
    expect(node.snapshot().lastError).toBeNull();
    const part = statSync(`${modelPath(m)}.part`).size;
    expect(part).toBeGreaterThan(0);
    expect(part).toBeLessThan(1_200_000);
    await node.downloadModel(m, null);
    await node.whenIdle();
    expect(hf.storageRequests.at(-1)!.range).toBe(`bytes=${part}-`);
    expect(node.snapshot().models).toContain("acme/Tiny-GGUF/Slow-Q2_K.gguf");
    expect(changes.some((c) => c.busy?.what === "download")).toBe(true);
    // A failed one says why (a gated model without the token).
    rmSync(join(modelsDir(), "acme", "Gated-GGUF"), { recursive: true, force: true });
    await node.downloadModel({ repo: "acme/Gated-GGUF", files: ["Gated-Q4_K_M.gguf"], quant: null, sizeBytes: 200_000, gated: true }, null);
    await node.whenIdle();
    expect(node.snapshot().lastError).toMatchObject({ what: "download", detail: expect.stringContaining("accept the model's terms") });
    expect(node.snapshot().busy).toBeNull();
    // Too big for the disk: refused at once, before anything is asked of Hugging Face.
    const asked = hf.requests.length;
    const e = await rejection(node.downloadModel({ ...m, files: ["Huge-Q4_K_M.gguf"], sizeBytes: 10 ** 15 }, null));
    expect(e).toMatchObject({ status: 507, code: "low_disk" });
    expect(hf.requests.length).toBe(asked);
  });

  test("removing a model moves it to the Trash, but never one the server is using", async () => {
    const node = runtime();
    const m = model("Tiny-Q4_K_M.gguf");
    await ensureModel(m);
    writeFileSync(`${modelPath(model("Tiny-Q8_0.gguf"))}.part`, "half");
    const info = await node.removeModels(["acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", "acme/Tiny-GGUF/Tiny-Q8_0.gguf"]);
    expect(info.models).not.toContain("acme/Tiny-GGUF/Tiny-Q4_K_M.gguf");
    expect(info.models).not.toContain("acme/Tiny-GGUF/Tiny-Q8_0.gguf");
    const trashed = readdirSync(MAC ? join(work, "trash-home", ".Trash") : join(work, "trash-home", ".local", "share", "Trash", "files"));
    expect(trashed).toEqual(expect.arrayContaining(["Tiny-Q4_K_M.gguf", "Tiny-Q8_0.gguf", "Tiny-Q8_0.gguf.part"]));
    // A repo folder left empty goes too; its owner's folder stays while it holds other repos.
    await ensureModel({ repo: "acme/Broken-GGUF", files: ["Broken-Q4_0.gguf"], quant: "Q4_0", sizeBytes: BROKEN.length, gated: false });
    await node.removeModels(["acme/Broken-GGUF/Broken-Q4_0.gguf"]);
    expect(existsSync(join(modelsDir(), "acme", "Broken-GGUF"))).toBe(false);
    expect(existsSync(join(modelsDir(), "acme", "Tiny-GGUF"))).toBe(true);
    // Something that isn't on this machine is no error; a path out of the models folder is.
    await node.removeModels(["acme/Tiny-GGUF/Not-Here-Q4_0.gguf"]);
    expect((await rejection(node.removeModels(["acme/Tiny-GGUF/../../../etc/x.gguf"]))).status).toBe(400);
    await ensureModel(m);
    await ensureInstalled();
    await node.startServer({ build: BUILD, backend: BACKEND, model: m, rpc: [], devices: null, contextSize: 0, alias: "m", port: freePort(), host: "127.0.0.1", apiKey: KEY });
    expect((await rejection(node.removeModels(["acme/Tiny-GGUF/Tiny-Q4_K_M.gguf"]))).code).toBe("in_use");
    await node.stopServer();
    expect(existsSync(modelPath(m))).toBe(true);
  });

  test("App.shutdown ends the helper and the server", async () => {
    await ensureInstalled();
    const m = model("Tiny-Q4_K_M.gguf");
    await ensureModel(m);
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
    try {
      await app.poolNode.startHelper({ build: BUILD, backend: BACKEND, port: freePort() });
      const helper = runs(rpcLog).at(-1)!.pid;
      const count = runs(llamaLog).length;
      await app.poolNode.startServer({ build: BUILD, backend: BACKEND, model: m, rpc: [], devices: null, contextSize: 0, alias: "m", port: freePort(), host: "127.0.0.1", apiKey: KEY });
      await until(() => runs(llamaLog).length > count);
      const server = runs(llamaLog).at(-1)!.pid;
      expect(runs(llamaLog).at(-1)!.argv).toContain("--metrics");
      expect([alive(helper), alive(server)]).toEqual([true, true]);
      await app.shutdown();
      expect([alive(helper), alive(server)]).toEqual([false, false]);
    } finally {
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  });

  test("processes a crashed hub left running are ended when the hub starts again", async () => {
    await ensureInstalled();
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    try {
      const stateFile = join(work, "run", "pool-processes.json");
      const crashed = runtime({ stateFile });
      await crashed.startHelper({ build: BUILD, backend: BACKEND, port: freePort() });
      const pid = runs(rpcLog).at(-1)!.pid;
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual([{ pid, bin: expect.stringContaining("ggml-rpc-server"), role: "helper" }]);
      const next = runtime({ stateFile });
      await next.start();
      expect(alive(pid)).toBe(false);
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual([]);
    } finally {
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  });
});

describe("helpers' GPUs, whose pool runs what, and the weight cache", () => {
  const MAC_MINI = "h_hubaaaa0001";
  const STUDIO = "h_hubbbbb0002";
  const owner = (hub: string, run = "r_run0001") => ({ hub, name: hub === MAC_MINI ? "Mac mini" : "Studio", run });

  test("the server asks each helper first: every device each serves, and a busy or unreachable one said plainly", async () => {
    await ensureInstalled();
    const m = model("Tiny-Q4_K_M.gguf");
    await ensureModel(m);
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    const helpers = [runtime(), runtime()];
    const node = runtime();
    node.helperCheckMs = 800;
    try {
      const ports = [freePort(), freePort()];
      for (const [i, h] of helpers.entries()) await h.startHelper({ build: BUILD, backend: BACKEND, port: ports[i] });
      const rpc = ports.map((p) => `127.0.0.1:${p}`);
      // The first serves two devices (a box with two GPUs): llama.cpp names them RPC0 and RPC1, the next helper's RPC2.
      process.env.FAKE_LLAMA_RPC_DEVICES = JSON.stringify({ [rpc[0]]: 2 });
      const start = { build: BUILD, backend: BACKEND, model: m, rpc, devices: "helpers" as const, contextSize: 4096, alias: "m", port: freePort(), host: "127.0.0.1", apiKey: KEY };
      const before = runs(llamaLog).length;
      await node.startServer(start);
      await until(() => runs(llamaLog).slice(before).some((r) => r.argv.includes("-m")));
      const ran = runs(llamaLog).slice(before);
      // Each helper on its own, then the server with every device the helpers serve.
      expect(ran.filter((r) => r.argv.includes("--list-devices")).map((r) => r.argv[1]).sort()).toEqual([...rpc].sort());
      expect(ran.find((r) => r.argv.includes("-m"))!.argv.slice(0, 4)).toEqual(["--rpc", rpc.join(","), "-dev", "RPC0,RPC1,RPC2"]);
      await node.stopServer();
      // Another program holds the second helper: it never answers llama.cpp.
      process.env.FAKE_LLAMA_RPC_HANG = rpc[1];
      const busy = await rejection(node.startServer(start));
      expect(busy).toMatchObject({ status: 409, code: "helper_busy", message: `The helper at ${rpc[1]} doesn't answer llama.cpp here: another program may be using it.` });
      delete process.env.FAKE_LLAMA_RPC_HANG;
      await helpers[1].stopHelper();
      const gone = await rejection(node.startServer(start));
      expect(gone).toMatchObject({ status: 409, code: "helper_unreachable", message: `Couldn't reach the helper at ${rpc[1]} from this machine: check that it's running and on Tailscale.` });
      expect(node.snapshot().server.running).toBe(false);
    } finally {
      delete process.env.FAKE_LLAMA_RPC_DEVICES;
      delete process.env.FAKE_LLAMA_RPC_HANG;
      delete process.env.CROSSTALK_POOL_LOOPBACK;
      for (const h of helpers) await h.stopHelper();
    }
  }, 30_000);

  test("one pool at a time: another hub's pool is refused while this one asks; what it ran ends by itself once it stops asking", async () => {
    await ensureInstalled();
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    const node = runtime();
    try {
      const port = freePort();
      const helper = (o: ReturnType<typeof owner>) => node.handle("helper", { action: "start", build: BUILD, backend: BACKEND, port, owner: o });
      expect((await helper(owner(MAC_MINI))).helper).toMatchObject({ running: true, owner: { hub: MAC_MINI, name: "Mac mini", run: "r_run0001" } });
      const first = runs(rpcLog).at(-1)!.pid;
      const refused = await rejection(helper(owner(STUDIO)));
      expect(refused).toMatchObject({ status: 409, code: "in_use" });
      expect(refused.message).toBe(
        "This machine already lends its GPU for the model pool on Mac mini: stop that pool there first, or switch this machine off in it, then start again. It also ends by itself 10 minutes after Mac mini stops asking for it.",
      );
      // The other hub's stop leaves it alone; its own start again keeps it.
      await node.handle("helper", { action: "stop", owner: owner(STUDIO) });
      await helper(owner(MAC_MINI));
      expect([alive(first), runs(rpcLog).at(-1)!.pid]).toEqual([true, first]);
      // The same pool's next start gets a helper of its own (no client from before).
      await helper(owner(MAC_MINI, "r_run0002"));
      expect(alive(first)).toBe(false);
      const second = runs(rpcLog).at(-1)!.pid;
      // While Mac mini asks about it, it lasts; once it stops asking (it crashed, say), it ends by itself.
      node.leaseMs = 500;
      await node.infoFor(new URLSearchParams({ owner: MAC_MINI }));
      await Bun.sleep(300);
      await node.infoFor(new URLSearchParams({ owner: MAC_MINI }));
      await Bun.sleep(300);
      expect(alive(second)).toBe(true);
      await until(() => !node.snapshot().helper.running, 5000);
      expect(alive(second)).toBe(false);
      expect(node.snapshot().helper.detail).toBe("Ended by itself: the model pool on Mac mini stopped asking for it.");
      // Then another hub's pool may have it.
      expect((await helper(owner(STUDIO))).helper).toMatchObject({ running: true, owner: { hub: STUDIO } });
      await node.stopHelper();
    } finally {
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  }, 30_000);

  test("a machine where llama.cpp finds no GPU doesn't lend its CPU", async () => {
    await ensureInstalled();
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    process.env.FAKE_LLAMA_DEVICES = "none";
    try {
      const node = runtime();
      const before = runs(rpcLog).length;
      const e = await rejection(node.startHelper({ build: BUILD, backend: BACKEND, port: freePort() }));
      expect(e).toMatchObject({ status: 409, code: "no_gpu", message: "llama.cpp found no GPU on this machine: switch it off in the pool (lending its CPU would make the whole pool very slow), then start again." });
      expect(runs(rpcLog).length).toBe(before);
    } finally {
      delete process.env.FAKE_LLAMA_DEVICES;
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  }, 30_000);

  test("the weight cache: used only with room for the helper's share, oldest files out first, cleared after the disk filled up", async () => {
    await ensureInstalled();
    process.env.CROSSTALK_POOL_LOOPBACK = "1";
    const cache = join(HOME, "llama", "cache", "rpc");
    const old = join(cache, "old-tensor");
    try {
      const node = runtime();
      node.diskWatchMs = 50;
      mkdirSync(cache, { recursive: true });
      writeFileSync(old, "weights");
      // A share no disk here has room for: the cache is emptied to make room, and still the helper does without it.
      const big = await node.startHelper({ build: BUILD, backend: BACKEND, port: freePort(), cacheBytes: 10 ** 15 });
      expect(runs(rpcLog).at(-1)!).toMatchObject({ argv: expect.not.arrayContaining(["-c"]), cache: null });
      expect(big.helper.detail).toContain("(without its weight cache: the disk has too little room for it)");
      expect(existsSync(old)).toBe(false);
      // A small one is kept.
      writeFileSync(old, "weights");
      await node.startHelper({ build: BUILD, backend: BACKEND, port: freePort(), cacheBytes: 1_000_000 });
      expect(runs(rpcLog).at(-1)!.argv.at(-1)).toBe("-c");
      expect(existsSync(old)).toBe(true);
      // The disk gets almost full while it runs: it's said, and the cache is cleared before the helper's next start.
      process.env.CROSSTALK_UPLOAD_RESERVE_BYTES = String(10 ** 15);
      await until(() => /disk is almost full/.test(node.snapshot().helper.detail ?? ""));
      delete process.env.CROSSTALK_UPLOAD_RESERVE_BYTES;
      await node.startHelper({ build: BUILD, backend: BACKEND, port: freePort(), cacheBytes: 1_000_000 });
      expect(existsSync(old)).toBe(false);
      await node.stopHelper();
    } finally {
      delete process.env.CROSSTALK_UPLOAD_RESERVE_BYTES;
      delete process.env.CROSSTALK_POOL_LOOPBACK;
    }
  }, 30_000);
});

describe("node routes", () => {
  let app: App;
  let server: ReturnType<typeof startServer>;
  let full: string;
  let peer: string;
  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });

  beforeAll(async () => {
    app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
    app.poolNode.trashOptions = { home: join(work, "trash-home"), gio: false };
    server = startServer(app);
    full = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!.token;
    peer = (await app.auth.pair((await app.auth.createPairingCode(undefined, { scope: "peer", hubId: "h_otherhub0001" })).code, "Other machine (hub)", "Crosstalk hub"))!.token;
  });
  afterAll(async () => {
    server.stop(true);
    await app.shutdown();
  });

  test("a peer sign-in (another machine's agents) gets 403 on every node route", async () => {
    for (const [method, path] of [["GET", "/api/pool/node"], ["POST", "/api/pool/node/install"], ["POST", "/api/pool/node/helper"], ["POST", "/api/pool/node/model"], ["POST", "/api/pool/node/server"]]) {
      const res = await call(peer, method, path, method === "POST" ? { action: "stop" } : undefined);
      expect([path, res.status]).toEqual([path, 403]);
      expect(((await res.json()) as { code?: string }).code).toBe("peer_scope");
    }
  });

  test("a full sign-in gets the machine's info and can stop things", async () => {
    await ensureInstalled();
    const res = await call(full, "GET", "/api/pool/node");
    expect(res.status).toBe(200);
    const info = (await res.json()) as PoolNodeInfo;
    expect(info).toMatchObject({ hubId: app.hubId(), name: app.machineName(), os: hostPlatform().os, busy: null });
    expect(info.installed).toContain(`${BUILD}-${BACKEND}`);
    expect((await call(full, "GET", `/api/pool/node?refresh=1&build=${BUILD}&backend=${BACKEND}`)).status).toBe(200);
    for (const path of ["/api/pool/node/helper", "/api/pool/node/server"]) expect((await call(full, "POST", path, { action: "stop" })).status).toBe(200);
    expect((await call(full, "POST", "/api/pool/node/model", { action: "cancel" })).status).toBe(200);
    expect((await call(full, "POST", "/api/pool/node/install", { build: BUILD, backend: BACKEND })).status).toBe(200);
  });

  test("bad input is refused with a plain reason", async () => {
    await ensureInstalled();
    const m = model("Tiny-Q4_K_M.gguf");
    await ensureModel(m);
    process.env.FAKE_TAILSCALE_IP = TS_IP;
    const start = { action: "start", build: BUILD, backend: BACKEND, model: m, rpc: [], devices: null, contextSize: 4096, alias: "pool", port: freePort(), host: "127.0.0.1", apiKey: KEY };
    const cases: [string, unknown][] = [
      ["install", "not json"],
      ["install", []],
      ["install", { build: "11669", backend: BACKEND }],
      ["install", { build: "b1", backend: BACKEND }],
      ["install", { build: "b11669; rm -rf ~", backend: BACKEND }],
      ["install", { build: BUILD, backend: "rocm" }],
      ["helper", { action: "launch" }],
      ["helper", { action: "start", build: BUILD, backend: BACKEND, port: 80 }],
      ["helper", { action: "start", build: BUILD, backend: BACKEND, port: 70000 }],
      ["helper", { action: "start", build: BUILD, backend: BACKEND, port: "5005x" }],
      ["helper", { action: "start", build: "../b11669", backend: BACKEND, port: 50052 }],
      ["model", { action: "download", model: { ...m, repo: "../etc" } }],
      ["model", { action: "download", model: { ...m, files: ["../../secrets.gguf"] } }],
      ["model", { action: "download", model: { ...m, files: ["Tiny-Q4_K_M.txt"] } }],
      ["model", { action: "download", model: { ...m, files: ["BF16/Tiny-BF16-00001-of-00002.gguf"] } }],
      ["model", { action: "download", model: m, hfToken: "has spaces in it" }],
      ["model", { action: "remove", files: ["acme/Tiny-GGUF/../../../x.gguf"] }],
      ["model", { action: "remove", files: [] }],
      ["server", { ...start, host: "0.0.0.0" }],
      ["server", { ...start, host: "192.168.1.20" }],
      ["server", { ...start, host: "100.101.102.104" }],
      ["server", { ...start, alias: "bad alias!" }],
      ["server", { ...start, alias: "a".repeat(65) }],
      ["server", { ...start, rpc: ["example.com:50052"] }],
      ["server", { ...start, rpc: ["192.168.1.5:50052"] }],
      ["server", { ...start, rpc: ["100.64.0.2:80"] }],
      ["server", { ...start, rpc: ["100.64.0.2:50052", "100.64.0.2:50052"] }],
      ["server", { ...start, devices: ["RPC0; rm"] }],
      ["server", { ...start, apiKey: "short" }],
      ["server", { ...start, apiKey: "comma,separated-key-0123456789" }],
      ["server", { ...start, contextSize: 100 }],
      ["server", { ...start, contextSize: "8192" }],
      ["server", { ...start, port: 1023 }],
      ["server", { ...start, model: { ...m, files: ["/etc/passwd.gguf"] } }],
      ["server", { ...start, devices: "helpers" }],
      ["server", { ...start, owner: { hub: "not-a-hub", name: "x", run: "r_1234" } }],
      ["helper", { action: "start", build: BUILD, backend: BACKEND, port: 50052, cacheBytes: -1 }],
      ["helper", { action: "start", build: BUILD, backend: BACKEND, port: 50052, owner: "Mac mini" }],
      ["helper", { action: "stop", owner: { hub: "h_abcd", run: "x y" } }],
    ];
    try {
      for (const [what, body] of cases) {
        const res = await call(full, "POST", `/api/pool/node/${what}`, body);
        const out = (await res.json()) as { error?: string };
        expect([what, JSON.stringify(body).slice(0, 80), res.status]).toEqual([what, JSON.stringify(body).slice(0, 80), 400]);
        expect(out.error?.length).toBeGreaterThan(10);
      }
      // The machine's own Tailscale address is allowed; another one isn't. (Checked without starting a server there:
      // a request to a 100.x address could reach the real tailnet.)
      await app.poolNode.checkHost(TS_IP);
      await app.poolNode.checkHost("127.0.0.1");
      expect((await rejection(app.poolNode.checkHost("100.101.102.104"))).message).toBe(`The server can only listen on 127.0.0.1 or this machine's Tailscale address (${TS_IP}).`);
      delete process.env.FAKE_TAILSCALE_IP;
      expect((await rejection(app.poolNode.checkHost(TS_IP))).message).toContain("Tailscale isn't running on this machine");
      expect(app.poolNode.snapshot().server.running).toBe(false);
    } finally {
      delete process.env.FAKE_TAILSCALE_IP;
    }
  });
});
