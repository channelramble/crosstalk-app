// llama.cpp builds for the model pool (docs/MODEL-POOL.md): which release files a machine needs, installing one build
// under ~/.crosstalk/llama/<build>-<backend>/ (checked against the sha256 GitHub lists for it), and asking
// llama-server which GPUs it sees. Every machine in a pool runs exactly the same build.

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { PoolBackend, PoolDevice, PoolNodeInfo } from "@crosstalk/shared";
import { HOME, HUB_VERSION } from "../config";
import { HttpError } from "../engine/engine";
import { diskSpace } from "../storage";
import { diskReserve } from "../uploads";
import { logger } from "../util/log";

const log = logger("pool");

export const POOL_BACKENDS: readonly PoolBackend[] = ["metal", "vulkan", "cuda", "cpu"];
/** A llama.cpp release tag, e.g. b11669. */
export const BUILD_RE = /^b\d{3,6}$/;
/** Older builds have unauthenticated remote-code-execution bugs in the RPC server: never run one as a helper. */
export const OLDEST_SAFE_HELPER_BUILD = 11000;

export type PoolOs = PoolNodeInfo["os"];

/** Where builds are installed, one folder per build and backend. */
export const llamaDir = () => join(HOME, "llama");
/** LLAMA_CACHE for helpers: `ggml-rpc-server -c` keeps the weights it was sent in its rpc/ folder. */
export const llamaCacheDir = () => join(HOME, "llama", "cache");

const MANIFEST = "crosstalk-install.json";
const BACKEND_NAMES: Record<PoolBackend, string> = { metal: "Metal", vulkan: "Vulkan", cuda: "CUDA", cpu: "CPU" };

export function checkBuild(build: unknown): string {
  if (typeof build !== "string" || !BUILD_RE.test(build)) throw new HttpError(400, "Pick a llama.cpp build like b11669.");
  return build;
}

export function checkBackend(backend: unknown): PoolBackend {
  if (typeof backend !== "string" || !POOL_BACKENDS.includes(backend as PoolBackend)) throw new HttpError(400, "Pick Metal, Vulkan, CUDA or CPU.");
  return backend as PoolBackend;
}

/** This machine, in the names the pool uses. */
export function hostPlatform(): { os: PoolOs; arch: string } {
  const os: PoolOs = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  return { os, arch: process.arch };
}

/**
 * The release files a machine needs from https://github.com/ggml-org/llama.cpp/releases/tag/<build>, in the order
 * they're unpacked: the programs first, then a companion (CUDA's runtime) that goes next to them.
 */
export function assetsFor(build: string, os: PoolOs, arch: string, backend: PoolBackend): string[] {
  checkBuild(build);
  checkBackend(backend);
  const a = arch === "x86_64" || arch === "amd64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  if (os === "macos") {
    if (a !== "arm64") throw new HttpError(400, "The model pool needs a Mac with Apple silicon (M1 or newer).");
    if (backend !== "metal") throw new HttpError(400, "llama.cpp's Mac build uses Metal: pick Metal for a Mac.");
    return [`llama-${build}-bin-macos-arm64.tar.gz`];
  }
  if (os === "linux") {
    if (a !== "x64") throw new HttpError(400, "llama.cpp has ready-made Linux builds for x64 PCs only.");
    if (backend === "vulkan") return [`llama-${build}-bin-ubuntu-vulkan-x64.tar.gz`];
    if (backend === "cpu") return [`llama-${build}-bin-ubuntu-x64.tar.gz`];
    if (backend === "cuda") return [`llama-${build}-bin-ubuntu-cuda-12.8-x64.tar.gz`, `cudart-llama-${build}-bin-ubuntu-cuda-12.8-x64.tar.gz`];
    throw new HttpError(400, "Metal is for Macs: pick Vulkan, CUDA or CPU on Linux.");
  }
  if (a !== "x64") throw new HttpError(400, "llama.cpp has ready-made Windows builds for x64 PCs only.");
  if (backend === "vulkan") return [`llama-${build}-bin-win-vulkan-x64.zip`];
  if (backend === "cuda") return [`llama-${build}-bin-win-cuda-12.4-x64.zip`, "cudart-llama-bin-win-cuda-12.4-x64.zip"];
  if (backend === "cpu") return [`llama-${build}-bin-win-cpu-x64.zip`];
  throw new HttpError(400, "Metal is for Macs: pick Vulkan, CUDA or CPU on Windows.");
}

/** An installed build. */
export interface LlamaInstall {
  /** "<build>-<backend>", as PoolNodeInfo.installed lists it. */
  id: string;
  build: string;
  backend: PoolBackend;
  dir: string;
  /** llama-server. */
  server: string;
  /** ggml-rpc-server (rpc-server before June 2026), or null if the build has none. */
  rpc: string | null;
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};
const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** The install of that build and backend, if it's complete. */
export function findInstall(build: string, backend: PoolBackend): LlamaInstall | null {
  if (!BUILD_RE.test(build) || !POOL_BACKENDS.includes(backend)) return null;
  const id = `${build}-${backend}`;
  const dir = join(llamaDir(), id);
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { server?: unknown; rpc?: unknown };
    if (typeof m.server !== "string") return null;
    const server = join(dir, m.server);
    const rpc = typeof m.rpc === "string" ? join(dir, m.rpc) : null;
    if (!inside(server, dir) || !isFile(server) || (rpc && !inside(rpc, dir))) return null;
    return { id, build, backend, dir, server, rpc: rpc && isFile(rpc) ? rpc : null };
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
    .filter((m): m is RegExpExecArray => !!m && !!findInstall(m[1], m[2] as PoolBackend))
    .sort((a, b) => Number(b[1].slice(1)) - Number(a[1].slice(1)) || a[0].localeCompare(b[0]))
    .map((m) => m[0]);
}

export interface InstallProgress {
  /** The release file being downloaded. */
  file: string;
  doneBytes: number;
  totalBytes: number;
}

export interface InstallOptions {
  signal?: AbortSignal;
  /** The machine the build is for; this one when not given (tests install other platforms' files). */
  platform?: { os: PoolOs; arch: string };
}

/** Installs in progress, by build: one at a time per build. */
const installing = new Map<string, Promise<LlamaInstall>>();

/**
 * Installs a llama.cpp build (if it isn't already): downloads its release files from GitHub, checks each against the
 * sha256 digest GitHub lists for it (refused on a mismatch), unpacks them with tar into a staging folder and moves
 * that into place in one step, so a build folder is always complete.
 */
export function install(build: string, backend: PoolBackend, onProgress?: (p: InstallProgress) => void, opts: InstallOptions = {}): Promise<LlamaInstall> {
  checkBuild(build);
  checkBackend(backend);
  const done = findInstall(build, backend);
  if (done) return Promise.resolve(done);
  const before = installing.get(build);
  const next = (before ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => findInstall(build, backend) ?? installNow(build, backend, onProgress, opts));
  installing.set(build, next);
  void next
    .finally(() => {
      if (installing.get(build) === next) installing.delete(build);
    })
    .catch(() => {});
  return next;
}

async function installNow(build: string, backend: PoolBackend, onProgress: ((p: InstallProgress) => void) | undefined, opts: InstallOptions): Promise<LlamaInstall> {
  const { os, arch } = opts.platform ?? hostPlatform();
  const assets = assetsFor(build, os, arch, backend);
  if (assets.some((a) => !a.endsWith(".tar.gz"))) throw new HttpError(400, "Crosstalk installs llama.cpp on Macs and Linux PCs: on Windows, run the helper command Crosstalk shows.");
  const root = llamaDir();
  mkdirSync(root, { recursive: true });
  clearStale(root);
  const id = `${build}-${backend}`;
  const files = await releaseFiles(build, opts.signal);
  for (const asset of assets) {
    if (!(asset in files)) throw new HttpError(404, `llama.cpp ${build} has no ${BACKEND_NAMES[backend]} build for this machine (${asset}): pick another backend or build.`);
  }
  const staging = join(root, `.staging-${id}-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(join(staging, "downloads"), { recursive: true });
  try {
    for (const asset of assets) await fetchAsset(build, asset, join(staging, "downloads", asset), files[asset], onProgress, opts.signal);
    // The programs, as the release packs them (macOS: llama-<build>/ with the programs at its top).
    const pkg = join(staging, "pkg");
    mkdirSync(pkg);
    await untar(join(staging, "downloads", assets[0]), pkg, opts.signal);
    const server = findFile(pkg, ["llama-server"]);
    if (!server) throw new HttpError(502, `llama.cpp ${build}'s download has no llama-server in it: pick another build.`);
    const rpc = findFile(pkg, ["ggml-rpc-server", "rpc-server"]);
    // A companion (CUDA's runtime libraries) goes next to the programs, where they look for their libraries.
    for (const [i, asset] of assets.slice(1).entries()) {
      const extra = join(staging, `extra-${i}`);
      mkdirSync(extra);
      await untar(join(staging, "downloads", asset), extra, opts.signal);
      moveFilesInto(extra, dirname(server));
    }
    for (const bin of [server, rpc]) if (bin) chmodSync(bin, 0o755);
    writeFileSync(
      join(pkg, MANIFEST),
      JSON.stringify({ build, backend, server: relative(pkg, server), rpc: rpc ? relative(pkg, rpc) : null, assets, installedAt: Date.now() }, null, 2),
    );
    const dest = join(root, id);
    // A folder left from an install that didn't finish (no manifest) makes way for the new one.
    if (lexists(dest)) {
      const old = join(root, `.old-${id}-${crypto.randomUUID().slice(0, 8)}`);
      renameSync(dest, old);
      rmSync(old, { recursive: true, force: true });
    }
    renameSync(pkg, dest);
    log.info(`installed llama.cpp ${id}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const done = findInstall(build, backend);
  if (!done) throw new HttpError(500, `llama.cpp ${build} didn't install properly: install it again.`);
  return done;
}

/** Staging folders that a hub stopped in the middle of an install left behind (older than six hours). */
function clearStale(root: string) {
  for (const name of readdirSync(root)) {
    if (!name.startsWith(".staging-") && !name.startsWith(".old-")) continue;
    const path = join(root, name);
    try {
      if (Date.now() - lstatSync(path).mtimeMs > 6 * 60 * 60_000) rmSync(path, { recursive: true, force: true });
    } catch {
      // gone meanwhile
    }
  }
}

const githubHeaders = () => ({ "user-agent": `crosstalk-hub/${HUB_VERSION}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });

/** A release file as GitHub lists it: its sha256 (null when GitHub lists none) and size (0 when unknown). */
interface ReleaseFile {
  digest: string | null;
  size: number;
}

/** The release's files, by name. */
async function releaseFiles(build: string, signal?: AbortSignal): Promise<Record<string, ReleaseFile>> {
  const api = (process.env.CROSSTALK_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${api}/repos/ggml-org/llama.cpp/releases/tags/${build}`, { headers: githubHeaders(), signal: withTimeout(signal, 30_000) });
  } catch (e) {
    if (signal?.aborted) throw stopped();
    throw new HttpError(502, `Couldn't reach GitHub to get llama.cpp (${errText(e)}): check this machine's internet connection, then try again.`);
  }
  if (res.status === 404) throw new HttpError(404, `llama.cpp has no build called ${build}: check the build name (like b11669).`);
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const minutes = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : null;
    throw new HttpError(503, `GitHub is limiting requests from this machine: try again ${minutes ? `in ${minutes} minute${minutes === 1 ? "" : "s"}` : "in a while"}.`);
  }
  if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status} for llama.cpp ${build}: try again in a few minutes.`);
  const release = (await res.json().catch(() => null)) as { assets?: { name?: unknown; digest?: unknown; size?: unknown }[] } | null;
  const out: Record<string, ReleaseFile> = {};
  for (const a of release?.assets ?? []) {
    if (typeof a?.name !== "string") continue;
    const m = typeof a.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest) : null;
    out[a.name] = { digest: m ? m[1].toLowerCase() : null, size: Number(a.size) > 0 ? Number(a.size) : 0 };
  }
  return out;
}

async function fetchAsset(build: string, asset: string, file: string, listed: ReleaseFile, onProgress: ((p: InstallProgress) => void) | undefined, signal?: AbortSignal) {
  const digest = listed.digest;
  const base = (process.env.CROSSTALK_LLAMA_RELEASES ?? "https://github.com/ggml-org/llama.cpp/releases/download").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/${build}/${asset}`, { headers: { "user-agent": `crosstalk-hub/${HUB_VERSION}` }, signal });
  } catch (e) {
    if (signal?.aborted) throw stopped();
    throw new HttpError(502, `Couldn't download llama.cpp (${errText(e)}): check this machine's internet connection, then try again.`);
  }
  if (!res.ok || !res.body) throw new HttpError(502, `Couldn't download ${asset} (GitHub answered ${res.status}): try again in a few minutes.`);
  // The size from the response, else the one GitHub lists (a streamed answer may not say it).
  const total = Number(res.headers.get("content-length")) || listed.size;
  const free = diskSpace(dirname(file)).free;
  // Room for the download and what it unpacks to, plus the reserve the hub always keeps.
  if (total && free < total * 4 + diskReserve()) {
    await res.body.cancel().catch(() => {});
    throw new HttpError(507, `Not enough free space to install llama.cpp: it needs about ${gb(total * 4)} and ${gb(Math.max(0, free - diskReserve()))} is free (keeping ${gb(diskReserve())} free). Free up space, then try again.`);
  }
  const hasher = new Bun.CryptoHasher("sha256");
  const out = await open(file, "w");
  let done = 0;
  let reported = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      hasher.update(value);
      await out.write(value);
      done += value.length;
      if (Date.now() - reported >= 500) {
        reported = Date.now();
        onProgress?.({ file: asset, doneBytes: done, totalBytes: total || done });
      }
    }
  } catch (e) {
    if (signal?.aborted) throw stopped();
    throw new HttpError(502, `The download of ${asset} was cut off (${errText(e)}): try again.`);
  } finally {
    await out.close();
  }
  onProgress?.({ file: asset, doneBytes: done, totalBytes: total || done });
  if (total && done !== total) throw new HttpError(502, `The download of ${asset} was cut off: try again.`);
  const got = hasher.digest("hex");
  if (!digest) log.warn(`GitHub lists no sha256 for ${asset}: installing it unchecked`);
  else if (got !== digest) {
    log.warn(`sha256 mismatch for ${asset}: got ${got}, GitHub lists ${digest}`);
    throw new HttpError(502, `The download of ${asset} doesn't match the checksum GitHub lists for it, so it wasn't installed. Try again; if it keeps happening, something on this network is changing downloads.`);
  }
}

async function untar(archive: string, into: string, signal?: AbortSignal) {
  const p = Bun.spawn(["tar", "-xzf", archive, "-C", into], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const kill = () => p.kill("SIGKILL");
  signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, 10 * 60_000);
  try {
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    if (signal?.aborted) throw stopped();
    if (code !== 0) throw new HttpError(502, `Couldn't unpack ${basename(archive)} (${err.trim().split("\n")[0] || `tar exit code ${code}`}): try again.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

/** The shallowest regular file with one of these names (earlier names first) inside `root`, never through a symlink. */
function findFile(root: string, names: string[], depth = 4): string | null {
  const realRoot = realpathSync(root);
  let level = [root];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    const found = new Map<string, string>();
    for (const dir of level) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && names.includes(e.name) && !found.has(e.name)) found.set(e.name, join(dir, e.name));
        else if (e.isDirectory()) next.push(join(dir, e.name));
      }
    }
    for (const name of names) {
      const path = found.get(name);
      if (path && inside(realpathSync(path), realRoot)) return path;
    }
    level = next;
  }
  return null;
}

/** Moves every file (and symlink) found under `from` into `dir`, keeping what's already there. */
function moveFilesInto(from: string, dir: string) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const path = join(from, e.name);
    if (e.isDirectory()) moveFilesInto(path, dir);
    else if ((e.isFile() || e.isSymbolicLink()) && !lexists(join(dir, e.name))) renameSync(path, join(dir, e.name));
  }
}

/**
 * The environment llama.cpp's programs run with: the hub's, without its own settings and secrets (and without
 * llama.cpp's LLAMA_ARG_* settings, so only what Crosstalk passes counts), with the build's folder on Linux's
 * library path.
 */
export function llamaEnv(bin: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CROSSTALK_|LLAMA_ARG_)/.test(k) || k === "LLAMA_API_KEY" || k === "HF_TOKEN" || k === "LLAMA_CACHE") continue;
    env[k] = v;
  }
  if (process.platform === "linux") env.LD_LIBRARY_PATH = [dirname(bin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  return { ...env, ...extra };
}

/**
 * Devices from `llama-server --list-devices`: lines like `  Vulkan0: AMD Radeon RX 7600 XT (RADV NAVI33) (16304 MiB,
 * 15890 MiB free)`, or `  (none)`. Devices without memory of their own (BLAS on a Mac) are left out: they can't hold
 * any of the model, and naming one in -dev would put layers on it.
 */
export function parseDevices(text: string): PoolDevice[] {
  const out: PoolDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(\S+?):\s+(.*?)\s*\((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
    if (!m) continue;
    const totalMiB = Number(m[3]);
    if (totalMiB > 0) out.push({ name: m[1], description: m[2], totalMiB, freeMiB: Number(m[4]) });
  }
  return out;
}

/** A helper's address for --rpc: a numeric IPv4 and a port. */
export const RPC_ADDRESS_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;

/**
 * The RPC devices in `llama-server --rpc … --list-devices` output, every one of them (memory or not): llama.cpp numbers
 * them RPC0, RPC1… across the helpers in --rpc order, one per device a helper serves, each described by its address.
 */
export function parseRpcDevices(text: string): PoolDevice[] {
  const out: PoolDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(RPC\d+):\s+(.*?)\s*\((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
    if (m) out.push({ name: m[1], description: m[2], totalMiB: Number(m[3]), freeMiB: Number(m[4]) });
  }
  return out;
}

/** `llama-server [--rpc …] --list-devices`'s output; code "timeout" when it never finished, "helper_unreachable" when a helper couldn't be reached. */
async function listText(serverBin: string, rpc: string[], timeoutMs: number): Promise<string> {
  for (const r of rpc) if (!RPC_ADDRESS_RE.test(r)) throw new HttpError(400, `${r} isn't a helper's address (like 100.64.0.2:50052).`);
  // --rpc must come before --list-devices.
  const args = [serverBin, ...(rpc.length ? ["--rpc", rpc.join(",")] : []), "--list-devices"];
  let p;
  try {
    p = Bun.spawn(args, { cwd: dirname(serverBin), env: llamaEnv(serverBin), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new HttpError(500, `llama.cpp didn't start on this machine (${errText(e)}): install the build again.`);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    if (/Available devices:/.test(out)) return out;
    if (timedOut) throw new HttpError(504, "llama.cpp took too long to list this machine's GPUs: check again, and restart the machine if it keeps happening.", "timeout");
    const lines = (out + "\n" + err).split("\n");
    throw new HttpError(502, explainExit("devices", lines, code, p.signalCode ?? null), /Failed to connect to \S+?:\d+/i.test(out + err) ? "helper_unreachable" : undefined);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The GPUs llama-server sees: this machine's, and with `rpc` the helpers' too (named RPC0, RPC1… in that order, one
 * per device each helper serves). Connecting to a helper takes it over while it runs, so never ask about helpers the
 * pool's server is using.
 */
export async function listDevices(serverBin: string, rpc: string[] = [], timeoutMs = 30_000): Promise<PoolDevice[]> {
  return parseDevices(await listText(serverBin, rpc, timeoutMs));
}

/**
 * The devices one helper serves, as llama-server on this machine sees them (RPC0, RPC1… for that helper alone). A
 * helper serves one client at a time, so one that another program holds never answers: after `timeoutMs` it's said
 * to be busy (code "helper_busy"); one that can't be reached at all has code "helper_unreachable".
 */
export async function helperDevices(serverBin: string, address: string, timeoutMs = 20_000): Promise<PoolDevice[]> {
  let text: string;
  try {
    text = await listText(serverBin, [address], timeoutMs);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : undefined;
    if (code === "timeout") throw new HttpError(409, `The helper at ${address} doesn't answer llama.cpp here: another program may be using it.`, "helper_busy");
    if (code === "helper_unreachable") throw new HttpError(409, `Couldn't reach the helper at ${address} from this machine: check that it's running and on Tailscale.`, "helper_unreachable");
    throw e;
  }
  return parseRpcDevices(text);
}

/** Backtrace frames, blank lines and llama.cpp's notes about backtraces: never what went wrong. */
const NOISE = /^\s*$|^\s*\d+\s+\S+\s+0x[0-9a-f]+|^WARNING: |^See: https:\/\/github\.com\/ggml-org|^ggml_metal_/i;

/**
 * What went wrong when llama-server or ggml-rpc-server stopped (or `--list-devices` failed), from its last lines,
 * in plain words with what to do next.
 */
export function explainExit(what: "server" | "helper" | "devices", lines: string[], code: number | null, signal: string | null, ctx: { port?: number | null } = {}): string {
  const text = lines.join("\n");
  const has = (re: RegExp) => re.test(text);
  const again = what === "devices" ? "then check again" : "then start again";
  if (has(/couldn't bind|Failed to create server socket|address already in use|bind failed/i)) {
    // A helper's port is that machine's own (an old helper window may still hold it); the server's can be changed.
    if (what === "helper") return `The helper's port${ctx.port ? ` ${ctx.port}` : ""} is already taken on this machine: close the program that uses it (an old helper window, say), ${again}.`;
    return `Port ${ctx.port ?? "it uses"} is already taken on this machine (or the address isn't this machine's): pick another port, ${again}.`;
  }
  const rpc = /Failed to connect to (\S+?:\d+)/i.exec(text);
  if (rpc) return `Couldn't reach the helper at ${rpc[1]}: check that it's running and on Tailscale, ${again}.`;
  if (has(/Remote RPC server crashed|returned malformed response|RPC server version mismatch|protocol version/i)) {
    return `A helper stopped answering: check that every machine runs the same llama.cpp build and that its helper is running, ${again}.`;
  }
  if (has(/out of memory|failed to allocate|unable to allocate|ErrorOutOfDeviceMemory|cudaMalloc failed|not enough memory|insufficient memory/i)) {
    return `The GPUs ran out of memory for this model: pick a smaller quant or a smaller context, or add a machine, ${again}.`;
  }
  if (has(/error while loading shared libraries: \S*vulkan/i)) return `Vulkan isn't set up on this machine: install its GPU's Vulkan driver, ${again}.`;
  if (has(/CUDA driver version is insufficient|no CUDA-capable device|cuda.*driver/i)) return `The NVIDIA driver is missing or too old for this build: update the driver (or pick Vulkan), ${again}.`;
  if (has(/error while loading shared libraries|Library not loaded|image not found/i)) return `llama.cpp is missing one of its files on this machine: install the build again, ${again}.`;
  if (has(/invalid device/i)) return `llama.cpp doesn't know one of the GPUs it was given: check the machines again, ${again}.`;
  if (has(/failed to load model|error loading model|exiting due to model loading error|failed to open GGUF/i)) {
    return `llama.cpp couldn't load the model: download it again or pick another quant, ${again}.`;
  }
  // The last line that reads like an error (llama.cpp marks its own with " E "), if any.
  const last = [...lines]
    .reverse()
    .map((l) => l.trim())
    .find((l) => !NOISE.test(l) && (/ E |error|fail|abort|fatal|exception|cannot|can't|couldn't|unable|denied|invalid|not found/i.test(l)));
  const who = what === "server" ? "The model server" : what === "helper" ? "The helper" : "llama.cpp";
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

const stopped = () => new HttpError(409, "Stopped.", "stopped");

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

export const gb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.ceil(n / 1024 ** 2)} MB` : `${Math.ceil(n / 1024)} KB`);
