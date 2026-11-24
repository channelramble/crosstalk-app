// llama.cpp on this machine, for Settings → Local models: the builds in Crosstalk's own folder
// (~/.crosstalk/llama/<build>-<backend>/, each with a manifest naming its llama-server; Crosstalk up to 0.8.1 installed
// them there, and one that's there still serves when no other llama-server is found), asking llama-server which GPUs
// it sees, and saying in plain words why it stopped.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { HOME } from "../config";
import { HttpError } from "../engine/engine";

/** Which GPU backend a llama.cpp build was made for. */
export type LlamaBackend = "metal" | "vulkan" | "cuda" | "cpu";

/** A GPU (or other accelerator) llama.cpp found on this machine, as `llama-server --list-devices` reports it. */
export interface GpuDevice {
  /** llama.cpp's name for it: MTL0, Vulkan0, CUDA0… */
  name: string;
  /** e.g. "Apple M4" or "AMD Radeon RX 7900 XTX (RADV NAVI31)". */
  description: string;
  totalMiB: number;
  freeMiB: number;
}

const BACKENDS: readonly LlamaBackend[] = ["metal", "vulkan", "cuda", "cpu"];
/** A llama.cpp release tag, e.g. b11669. */
const BUILD_RE = /^b\d{3,6}$/;

/** Where Crosstalk's own builds are, one folder per build and backend. */
export const llamaDir = () => join(HOME, "llama");

const MANIFEST = "crosstalk-install.json";

/** An installed build. */
export interface LlamaInstall {
  /** "<build>-<backend>", its folder's name. */
  id: string;
  build: string;
  backend: LlamaBackend;
  dir: string;
  /** llama-server. */
  server: string;
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/** The install of that build and backend, if it's complete. */
export function findInstall(build: string, backend: LlamaBackend): LlamaInstall | null {
  if (!BUILD_RE.test(build) || !BACKENDS.includes(backend)) return null;
  const id = `${build}-${backend}`;
  const dir = join(llamaDir(), id);
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { server?: unknown };
    if (typeof m.server !== "string") return null;
    const server = join(dir, m.server);
    if (!inside(server, dir) || !isFile(server)) return null;
    return { id, build, backend, dir, server };
  } catch {
    return null;
  }
}

/** Builds installed here, newest first, e.g. ["b11669-vulkan"]. */
export function installedBuilds(): string[] {
  let names: string[];
  try {
    names = readdirSync(llamaDir());
  } catch {
    return [];
  }
  return names
    .map((n) => /^(b\d{3,6})-(metal|vulkan|cuda|cpu)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m && !!findInstall(m[1], m[2] as LlamaBackend))
    .sort((a, b) => Number(b[1].slice(1)) - Number(a[1].slice(1)) || a[0].localeCompare(b[0]))
    .map((m) => m[0]);
}

/**
 * The environment llama.cpp's programs run with: the hub's, without its own settings and secrets (and without
 * llama.cpp's LLAMA_ARG_* settings, so only what Crosstalk passes counts), with the build's folder on Linux's
 * library path.
 */
function llamaEnv(bin: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CROSSTALK_|LLAMA_ARG_)/.test(k) || k === "LLAMA_API_KEY" || k === "HF_TOKEN" || k === "LLAMA_CACHE") continue;
    env[k] = v;
  }
  if (process.platform === "linux") env.LD_LIBRARY_PATH = [dirname(bin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  return env;
}

/**
 * Devices from `llama-server --list-devices`: lines like `  Vulkan0: AMD Radeon RX 7600 XT (RADV NAVI33) (16304 MiB,
 * 15890 MiB free)`, or `  (none)`. Devices without memory of their own (BLAS on a Mac) are left out: they can't hold
 * any of the model.
 */
export function parseDevices(text: string): GpuDevice[] {
  const out: GpuDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(\S+?):\s+(.*?)\s*\((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
    if (!m) continue;
    const totalMiB = Number(m[3]);
    if (totalMiB > 0) out.push({ name: m[1], description: m[2], totalMiB, freeMiB: Number(m[4]) });
  }
  return out;
}

/** The GPUs llama-server sees on this machine (`llama-server --list-devices`); code "timeout" when it never finished. */
export async function listDevices(serverBin: string, timeoutMs = 30_000): Promise<GpuDevice[]> {
  let p;
  try {
    p = Bun.spawn([serverBin, "--list-devices"], { cwd: dirname(serverBin), env: llamaEnv(serverBin), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new HttpError(500, `llama.cpp didn't start on this machine (${errText(e)}): install it again.`);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    if (/Available devices:/.test(out)) return parseDevices(out);
    if (timedOut) throw new HttpError(504, "llama.cpp took too long to list this machine's GPUs: check again, and restart the machine if it keeps happening.", "timeout");
    throw new HttpError(502, explainExit("devices", (out + "\n" + err).split("\n"), code, p.signalCode ?? null));
  } finally {
    clearTimeout(timer);
  }
}

/** A GPU's short name: "AMD Radeon RX 7600 XT (RADV NAVI33)" is "RX 7600 XT", "NVIDIA GeForce RTX 4070 SUPER" "RTX 4070 Super". */
export function gpuName(description: string): string {
  const full = description
    .replace(/\((R|TM|C)\)/gi, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!full) return "GPU";
  const short = full
    .replace(/^(AMD Radeon|NVIDIA GeForce|NVIDIA|Intel)\s+/i, "")
    .replace(/\s+Graphics$/i, "")
    .replace(/\bSUPER\b/g, "Super");
  return /\d/.test(short) ? short : full;
}

/** Backtrace frames, blank lines and llama.cpp's notes about backtraces: never what went wrong. */
const NOISE = /^\s*$|^\s*\d+\s+\S+\s+0x[0-9a-f]+|^WARNING: |^See: https:\/\/github\.com\/ggml-org|^ggml_metal_/i;

/**
 * What went wrong when llama-server stopped (or `--list-devices` failed), from its last lines, in plain words with
 * what to do next.
 */
export function explainExit(what: "server" | "devices", lines: string[], code: number | null, signal: string | null, ctx: { port?: number | null } = {}): string {
  const text = lines.join("\n");
  const has = (re: RegExp) => re.test(text);
  const again = what === "devices" ? "then check again" : "then start again";
  if (has(/couldn't bind|Failed to create server socket|address already in use|bind failed/i)) {
    return `Port ${ctx.port ?? "it uses"} is already taken on this machine: pick another port, ${again}.`;
  }
  if (has(/out of memory|failed to allocate|unable to allocate|ErrorOutOfDeviceMemory|cudaMalloc failed|not enough memory|insufficient memory/i)) {
    return `The GPUs ran out of memory for this model: pick a smaller quant or a smaller context, ${again}.`;
  }
  if (has(/error while loading shared libraries: \S*vulkan/i)) return `Vulkan isn't set up on this machine: install its GPU's Vulkan driver, ${again}.`;
  if (has(/CUDA driver version is insufficient|no CUDA-capable device|cuda.*driver/i)) return `The NVIDIA driver is missing or too old for this llama.cpp: update the driver, ${again}.`;
  if (has(/error while loading shared libraries|Library not loaded|image not found/i)) return `llama.cpp is missing one of its files on this machine: install it again, ${again}.`;
  if (has(/failed to load model|error loading model|exiting due to model loading error|failed to open GGUF/i)) {
    return `llama.cpp couldn't load the model: download it again or pick another quant, ${again}.`;
  }
  // The last line that reads like an error (llama.cpp marks its own with " E "), if any.
  const last = [...lines]
    .reverse()
    .map((l) => l.trim())
    .find((l) => !NOISE.test(l) && (/ E |error|fail|abort|fatal|exception|cannot|can't|couldn't|unable|denied|invalid|not found/i.test(l)));
  const who = what === "server" ? "The model server" : "llama.cpp";
  const how =
    code !== null
      ? `exit code ${code}`
      : signal === "SIGKILL"
        ? "it was killed, perhaps because the machine ran low on memory"
        : signal && ["SIGSEGV", "SIGBUS", "SIGILL", "SIGABRT", "SIGFPE"].includes(signal)
          ? "it crashed"
          : `signal ${signal ?? "unknown"}`;
  const clean = last?.replace(/^\d+\.\d+\.\d+\.\d+ [IWE] /, "").slice(0, 200);
  return `${who} stopped unexpectedly (${how})${clean ? `: ${clean}` : ""}. ${what === "devices" ? "Check again" : "Start it again"}; if it keeps happening, look at its log.`;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const gb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.ceil(n / 1024 ** 2)} MB` : `${Math.ceil(n / 1024)} KB`);
