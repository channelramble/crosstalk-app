// This hub as one of the model pool's machines (docs/MODEL-POOL.md). Every hub can install a llama.cpp build, lend its
// GPU as a helper (ggml-rpc-server on its Tailscale address), download the model and, as the main machine, run the
// pool's server (llama-server). The hub that runs the pool asks for these over /api/pool/node/… (or calls them
// directly when it's this hub). Nothing started here outlives the hub: processes are ended on stop and on shutdown,
// and ones a crashed hub left behind are ended when it starts again. What runs for another hub's pool is that pool's
// alone while it keeps asking about it, and ends by itself once it stops asking (LEASE_MS).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Subprocess } from "bun";
import type { PoolBackend, PoolDevice, PoolModel, PoolNodeInfo, PoolOwner } from "@crosstalk/shared";
import { needOf } from "@crosstalk/shared";
import { HttpError } from "../engine/engine";
import { diskSpace } from "../storage";
import { diskReserve } from "../uploads";
import { endProcess, processGrace } from "../util/process";
import { logger } from "../util/log";
import { askTailscale, isIPv4, isTailscaleIPv4, runTailscaleCli, selfTailscaleIPv4, tailscaleBin } from "../tailscale";
import {
  assetsFor,
  checkBackend,
  checkBuild,
  errText,
  explainExit,
  findInstall,
  helperDevices,
  hostPlatform,
  install as installBuild,
  installedBuilds,
  listDevices,
  llamaCacheDir,
  llamaEnv,
  OLDEST_SAFE_HELPER_BUILD,
  RPC_ADDRESS_RE,
  type InstallProgress,
  type LlamaInstall,
} from "./llama";
import {
  checkModel,
  checkSpace,
  download as downloadFiles,
  downloadingBy,
  DOWNLOADERS,
  filePath,
  haveModel,
  modelFiles,
  modelFilesOnDisk,
  modelsDir,
  splitModelFile,
  toTrash,
  type DownloadProgress,
  type TrashOptions,
} from "./models";

const log = logger("pool");

/** Lines of the server's output kept (and shown). */
export const SERVER_LOG_LINES = 200;
/** A device list is used this long before llama.cpp is asked again (only while neither the helper nor the server runs). */
const DEVICES_TTL = 2 * 60_000;
const ADDRESS_TTL = 30_000;
const GB = 1024 ** 3;
/**
 * A helper or server another hub's pool started here ends by itself once that hub hasn't asked about it for this
 * long: its pool is gone (that hub crashed, lost power, or was unlinked). A pool asks every minute while it runs.
 */
export const LEASE_MS = 10 * 60_000;

export interface HelperStart {
  build: string;
  backend: PoolBackend;
  port: number;
  /** The pool it lends its GPU to: the hub that runs that pool, and which start. */
  owner?: PoolOwner | null;
  /** About how much of the model it will be sent: its weight cache (-c) is only used when the disk has room for that. */
  cacheBytes?: number | null;
}

export interface ServerStart {
  build: string;
  backend: PoolBackend;
  model: PoolModel;
  /** Helpers as "<Tailscale IPv4>:<port>", in the order llama.cpp names their devices RPC0, RPC1… */
  rpc: string[];
  /**
   * The devices to use (-dev): null: all; []: none (CPU); "helpers": every device the helpers serve (RPC0, RPC1…, one
   * per device each serves, asked from here first), leaving this machine's GPU out.
   */
  devices: string[] | null | "helpers";
  /** Tokens of context (-c); 0: the model's own. */
  contextSize: number;
  /** The model's id in chats (-a). */
  alias: string;
  port: number;
  /** 127.0.0.1, or this machine's Tailscale address when other machines' chats use it. */
  host: string;
  /** Required on every request but /health (given to llama-server as LLAMA_API_KEY, so it never shows in `ps`). */
  apiKey: string;
  /** The pool it runs for: the hub that runs that pool, and which start. */
  owner?: PoolOwner | null;
}

export interface PoolNodeDeps {
  hubId: () => string;
  name: () => string;
  /** Where the processes it started are noted, so a hub that crashed ends them when it starts again. */
  stateFile?: string;
  /**
   * Asked before llama.cpp or a helper is started on this machine, with what it needs in memory: the memory guard
   * (hub/src/memory.ts) throws, in plain words, when it won't fit beside what already runs here. Not set (tests, and
   * hubs that never look): nothing is checked. The guard only ever speaks for *this* machine; a pool asking another
   * machine to start gets that machine's own answer, from its own guard.
   *
   * `replacing` is the process this start ends on its way (the helper or server already here): it holds nothing by
   * the time the new one runs, so it is left out of what the machine is holding. `canForce` is false because the
   * Model pool screen has no "Start anyway" tap, so a refusal must not promise one.
   */
  beforeStart?: (o: { what: string; needBytes: number | null; replacing?: number | null; canForce?: boolean }) => Promise<void>;
}

/**
 * What the pool's server needs in memory here: the model's files plus llama.cpp's KV cache and headroom, the same
 * arithmetic the download screens show ("fits this machine?"). The header's own KV size isn't to hand on this side,
 * so a mid-size model's is assumed (`needOf`'s fallback); a context of 0 is the model's own, which can't be counted
 * beforehand, so only the files are.
 *
 * `devices` is what llama.cpp is told to run on here. "helpers" (which is every pool whose main machine lends no GPU
 * of its own) means the weights and the cache live on the helpers' GPUs and this machine only streams tensors
 * through, so none of the model is this machine's to hold: charging it the whole 40 GB refused the pool on the one
 * configuration a pool is for. What it does hold while it streams can't be worked out beforehand, so it says null.
 */
export function poolNeedBytes(files: string[], contextSize: number, devices: ServerStart["devices"] = null): number | null {
  if (devices === "helpers") return null;
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += statSync(f).size;
    } catch {
      return null;
    }
  }
  if (!bytes) return null;
  return contextSize > 0 ? needOf(bytes, null, contextSize, null).bytes : bytes;
}

type Role = "helper" | "server";

interface Running {
  role: Role;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  install: LlamaInstall;
  host: string;
  port: number;
  /** The newest lines of its output (stdout and stderr). */
  lines: string[];
  stopping: boolean;
  exited: boolean;
  healthy: boolean;
  model: PoolModel | null;
  /** Whose pool it runs for, and when that pool last asked about it (its lease, which starts once it's running). */
  owner: PoolOwner | null;
  seenAt: number;
  starting: boolean;
  /** A helper keeping the weights it's sent in its cache (-c). */
  cache: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves once its exit has been handled. */
  closed: Promise<void>;
}

interface Noted {
  pid: number;
  bin: string;
  role: Role;
}

// ---- Tailscale ----

/**
 * This machine's Tailscale IPv4 (`tailscale ip -4`), or null when Tailscale isn't installed, up or signed in. Run
 * through the shared runner, so the macOS app's CLI answers instead of trying to open the GUI (tailscale.ts); its
 * status is the fallback, for an install where only the app's own API answers.
 */
export async function tailscaleIPv4(): Promise<string | null> {
  const bin = tailscaleBin();
  const r = bin ? await runTailscaleCli(bin, ["ip", "-4"]) : null;
  // Only ever an address in Tailscale's range: a helper must never listen on another network.
  const own = r?.code === 0 ? (r.out.split(/\s+/).find(isTailscaleIPv4) ?? null) : null;
  if (own) return own;
  return selfTailscaleIPv4((await askTailscale()).status);
}

// ---- Checking requests (the node routes) ----

export const ALIAS_RE = /^[\w.:-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z][\w.:[\]-]{0,63}$/;
/** Printable ASCII without spaces or commas (llama.cpp reads a comma as a second key). */
const API_KEY_RE = /^[\x21-\x2b\x2d-\x7e]{16,256}$/;
const HF_TOKEN_RE = /^[\x21-\x7e]{1,400}$/;

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Send the request as a JSON object.");
  return input as Record<string, unknown>;
}

function action<T extends string>(v: unknown, actions: T[]): T {
  if (typeof v !== "string" || !actions.includes(v as T)) throw new HttpError(400, `Say what to do: ${actions.map((a) => `"${a}"`).join(" or ")}.`);
  return v as T;
}

export function checkPort(v: unknown, what = "port"): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new HttpError(400, `Pick a ${what} from 1024 to 65535.`);
  return n;
}

/** A helper's address for --rpc: its Tailscale IPv4 (or 127.0.0.1) and a port from 1024 to 65535. */
/** What a helper elsewhere lends, as this machine's llama.cpp lists it (GET /api/pool/node/helpers). */
export interface HelperGpus {
  address: string;
  devices: PoolDevice[];
  error: string | null;
}

export function checkHelperAddress(v: unknown): string {
  const m = typeof v === "string" ? RPC_ADDRESS_RE.exec(v) : null;
  const ip = m ? m.slice(1, 5).join(".") : "";
  const port = m ? Number(m[5]) : 0;
  if (!m || !isIPv4(ip) || (!isTailscaleIPv4(ip) && ip !== "127.0.0.1") || port < 1024 || port > 65535) {
    throw new HttpError(400, "Helpers are reached at their Tailscale address and port, like 100.64.0.2:50052.");
  }
  return `${ip}:${port}`;
}

export function parseInstallBody(input: unknown): { build: string; backend: PoolBackend } {
  const b = object(input);
  return { build: checkBuild(b.build), backend: checkBackend(b.backend) };
}

const HUB_ID_RE = /^h_[\w-]{4,40}$/;
const RUN_ID_RE = /^[\w-]{4,40}$/;

/** Whose pool a request is for ({ hub, name, run }), or null when it doesn't say. */
export function parseOwner(v: unknown): PoolOwner | null {
  if (v === undefined || v === null) return null;
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  if (typeof o.hub !== "string" || !HUB_ID_RE.test(o.hub) || typeof o.run !== "string" || !RUN_ID_RE.test(o.run)) {
    throw new HttpError(400, "Say whose pool this is for, as { hub, name, run }.");
  }
  const name = typeof o.name === "string" ? o.name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { hub: o.hub, name: name || "another hub", run: o.run };
}

export function parseHelperBody(input: unknown): { action: "stop"; owner: PoolOwner | null } | ({ action: "start" } & HelperStart) {
  const b = object(input);
  const a = action(b.action, ["start", "stop"]);
  const owner = parseOwner(b.owner);
  if (a === "stop") return { action: a, owner };
  let cacheBytes: number | null = null;
  if (b.cacheBytes !== undefined && b.cacheBytes !== null) {
    if (typeof b.cacheBytes !== "number" || !Number.isSafeInteger(b.cacheBytes) || b.cacheBytes < 0) throw new HttpError(400, "Say how much of the model the helper gets in bytes (cacheBytes), or leave it out.");
    cacheBytes = b.cacheBytes;
  }
  return { action: a, build: checkBuild(b.build), backend: checkBackend(b.backend), port: checkPort(b.port, "helper port"), owner, cacheBytes };
}

export function parseModelBody(input: unknown): { action: "cancel" } | { action: "download"; model: PoolModel; hfToken: string | null } | { action: "remove"; files: string[] } {
  const b = object(input);
  const a = action(b.action, ["download", "cancel", "remove"]);
  if (a === "cancel") return { action: a };
  if (a === "remove") {
    if (!Array.isArray(b.files) || !b.files.length || b.files.length > 256) throw new HttpError(400, "Pick model files as this machine lists them (owner/repo/file.gguf).");
    for (const f of b.files) splitModelFile(f);
    return { action: a, files: b.files as string[] };
  }
  const token = b.hfToken;
  if (token !== undefined && token !== null && (typeof token !== "string" || !HF_TOKEN_RE.test(token))) throw new HttpError(400, "That Hugging Face token isn't valid: save it again.");
  return { action: a, model: checkModel(b.model), hfToken: typeof token === "string" ? token : null };
}

export function parseServerBody(input: unknown): { action: "stop"; owner: PoolOwner | null } | ({ action: "start" } & ServerStart) {
  const b = object(input);
  const a = action(b.action, ["start", "stop"]);
  const owner = parseOwner(b.owner);
  if (a === "stop") return { action: a, owner };
  const build = checkBuild(b.build);
  const backend = checkBackend(b.backend);
  const model = checkModel(b.model);
  if (!Array.isArray(b.rpc) || b.rpc.length > 64) throw new HttpError(400, "List the helpers as addresses like 100.64.0.2:50052.");
  const rpc = b.rpc.map(checkHelperAddress);
  if (new Set(rpc).size !== rpc.length) throw new HttpError(400, "The same helper is listed twice: list each helper once.");
  let devices: ServerStart["devices"] = null;
  if (b.devices === "helpers") {
    if (!rpc.length) throw new HttpError(400, "Only the helpers' GPUs were asked for, but no helper is listed: list them in rpc.");
    devices = "helpers";
  } else if (b.devices !== null && b.devices !== undefined) {
    if (!Array.isArray(b.devices) || b.devices.length > 64 || !b.devices.every((d) => typeof d === "string" && DEVICE_RE.test(d))) {
      throw new HttpError(400, "List the devices by llama.cpp's names for them, like RPC0 or Vulkan0.");
    }
    devices = b.devices as string[];
  }
  const contextSize = typeof b.contextSize === "number" ? b.contextSize : NaN;
  if (!Number.isInteger(contextSize) || (contextSize !== 0 && (contextSize < 256 || contextSize > 16_777_216))) {
    throw new HttpError(400, "Pick a context size from 256 to 16,777,216 tokens (or 0 for the model's own).");
  }
  if (typeof b.alias !== "string" || !ALIAS_RE.test(b.alias)) throw new HttpError(400, "Name the model with up to 64 letters, digits, dots, dashes, colons or underscores.");
  const port = checkPort(b.port, "server port");
  if (typeof b.host !== "string" || (b.host !== "127.0.0.1" && !isTailscaleIPv4(b.host))) throw new HttpError(400, "The server listens on 127.0.0.1 or this machine's Tailscale address.");
  if (typeof b.apiKey !== "string" || !API_KEY_RE.test(b.apiKey)) throw new HttpError(400, "The server needs an API key of 16 to 256 letters, digits or symbols, without spaces or commas.");
  return { action: a, build, backend, model, rpc, devices, contextSize, alias: b.alias, port, host: b.host, apiKey: b.apiKey, owner };
}

/**
 * llama-server's arguments: --rpc first (it adds the helpers' devices, which -dev then names), then -dev, the model's
 * first file (llama.cpp finds a split model's other parts beside it), and the rest. The API key isn't here: it goes in
 * the environment, so it never shows in `ps` or the logs.
 */
export function serverArgs(bin: string, o: Pick<ServerStart, "rpc" | "contextSize" | "alias" | "host" | "port"> & { devices: string[] | null }, model: string, os: PoolNodeInfo["os"] = hostPlatform().os): string[] {
  return [
    bin,
    ...(o.rpc.length ? ["--rpc", o.rpc.join(",")] : []),
    ...(o.devices ? ["-dev", o.devices.length ? o.devices.join(",") : "none"] : []),
    "-m",
    model,
    "-c",
    String(o.contextSize),
    // One request at a time, each with the whole context: llama-server's own default (several slots sharing one -c
    // cache) fails every request that overlaps once together they need more than -c.
    "-np",
    "1",
    // Every layer on the GPUs: with -c set, --fit would rather move layers to this machine's CPU (very slow, and
    // nothing says so) than cut the context. A model that doesn't fit then stops with "out of memory".
    ...(o.devices && !o.devices.length ? [] : ["-ngl", "all"]),
    "-a",
    o.alias,
    "--host",
    o.host,
    "--port",
    String(o.port),
    // Saving the prompt cache aborts the server under RPC.
    "--cache-ram",
    "0",
    "--metrics",
    // On a Mac, Metal would keep the whole memory-mapped model resident even when its GPU takes no part.
    ...(os === "macos" && o.rpc.length ? ["--load-mode", "none"] : []),
  ];
}

/** Reads a process's output line by line (without terminal colours), until it closes. */
async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const emit = (raw: string) => onLine(raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r$/, "").slice(0, 2000));
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        emit(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      // A line that never ends (a progress bar of dots) is kept in pieces.
      if (buf.length > 8000) {
        emit(buf);
        buf = "";
      }
    }
  } catch {
    // the process went away
  }
  buf += decoder.decode();
  if (buf) emit(buf);
}

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

const BACKEND_ORDER: PoolBackend[] = ["cuda", "vulkan", "metal", "cpu"];

/** This hub as a machine in a model pool: one per hub (app.poolNode). */
export class PoolNodeRuntime {
  private helper: Running | null = null;
  private server: Running | null = null;
  private helperDetail: string | null = null;
  private serverDetail: string | null = null;
  /** The last server's output, kept after it stops so what went wrong can be read. */
  private serverLines: string[] = [];
  private installJob: { id: string; progress: InstallProgress | null; ctrl: AbortController; done: Promise<void> } | null = null;
  private downloadJob: { model: PoolModel; progress: DownloadProgress; ctrl: AbortController; done: Promise<void> } | null = null;
  private lastError: NonNullable<PoolNodeInfo["lastError"]> | null = null;
  private devicesCache: { key: string; list: PoolNodeInfo["devices"]; at: number } | null = null;
  private devicesJob: Promise<void> | null = null;
  private addressCache: { value: string | null; at: number } | null = null;
  /** The install used last (installed or started), whose devices are listed. */
  private lastUsed: string | null = null;
  private listeners = new Set<(info: PoolNodeInfo) => void>();
  private soon: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Starting and stopping the helper (or the server) one request at a time, so none is ever left running untracked. */
  private queues = new Map<Role, Promise<unknown>>();
  /** The helper's weight cache may hold a file cut short (the disk filled up while it ran): cleared before its next start. */
  private cacheSuspect = false;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where model files go when removed (tests use a temporary home's Trash). */
  trashOptions: TrashOptions = {};
  private lease = LEASE_MS;
  /** How long a server start waits for each helper to answer llama.cpp (one another program holds never does). */
  helperCheckMs = 20_000;
  /** How often a helper's disk is looked at while it fills its weight cache. */
  diskWatchMs = 15_000;

  constructor(private deps: PoolNodeDeps) {}

  /** How long what runs for another hub's pool lasts once that pool stops asking about it (tests shorten it). */
  get leaseMs(): number {
    return this.lease;
  }

  set leaseMs(ms: number) {
    this.lease = ms;
    if (!this.leaseTimer) return;
    clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.watchLease();
  }

  private serial<T>(role: Role, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(role) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(role, next.catch(() => {}));
    return next;
  }

  /** Ends llama.cpp processes that a hub which didn't shut down properly (a crash, a power cut) left running. */
  async start(): Promise<void> {
    const mine = () => [this.helper?.proc.pid, this.server?.proc.pid];
    const left = this.noted().filter((n) => !mine().includes(n.pid));
    if (!left.length) return;
    for (const n of left) {
      if (mine().includes(n.pid) || !(await isOurs(n))) continue;
      log.info(`ending the ${n.role} (pid ${n.pid}) a previous run of the hub left running`);
      await endPid(n.pid);
    }
    // Only those: what this run started meanwhile stays noted.
    this.note((list) => list.filter((n) => !left.some((l) => l.pid === n.pid)));
  }

  /** Hears about every change (progress at most twice a second): the pool on this hub updates its view. */
  onChange(listener: (info: PoolNodeInfo) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed() {
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
    if (!this.listeners.size) return;
    const info = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(info);
      } catch (e) {
        log.warn(`pool listener failed: ${errText(e)}`);
      }
    }
  }

  /** A change worth telling about, but at most twice a second (progress, new output lines). */
  private changedSoon() {
    if (this.soon || !this.listeners.size) return;
    this.soon = setTimeout(() => this.changed(), 500);
  }

  /** What this machine is and does, from what it knows now (no waiting on Tailscale or llama.cpp). */
  snapshot(): PoolNodeInfo {
    const { os, arch } = hostPlatform();
    let freeDiskBytes: number | null = null;
    try {
      let dir = modelsDir();
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      freeDiskBytes = diskSpace(dir).free;
    } catch {
      // unreadable: unknown
    }
    const files = modelFilesOnDisk();
    const owner = (run: Running | null) => (run?.owner ? { owner: { ...run.owner } } : {});
    return {
      hubId: this.deps.hubId(),
      name: this.deps.name(),
      os,
      arch,
      address: this.addressCache?.value ?? null,
      installed: installedBuilds(),
      busy: this.busy(),
      devices: this.devicesCache?.list ?? [],
      helper: { running: !!this.helper, port: this.helper?.port ?? null, detail: this.helperDetail, ...owner(this.helper) },
      server: { running: !!this.server, port: this.server?.port ?? null, healthy: !!this.server?.healthy, detail: this.serverDetail, log: [...this.serverLines], ...owner(this.server) },
      models: files.filter((f) => !f.partial).map((f) => f.file),
      files,
      freeDiskBytes,
      lastError: this.lastError,
    };
  }

  /** The pool on `hub` still asks about what it runs here: its lease goes on. */
  touch(hub: string) {
    const now = Date.now();
    for (const run of [this.helper, this.server]) if (run?.owner?.hub === hub) run.seenAt = now;
  }

  /** Looks at the leases now and then, while a helper or server runs for a pool (and only then). */
  private watchLease() {
    if (this.leaseTimer || this.closed) return;
    this.leaseTimer = setTimeout(
      () => {
        this.leaseTimer = null;
        try {
          this.expire();
        } catch (e) {
          log.warn(`couldn't look at the pool's leases: ${errText(e)}`);
        }
        if ([this.helper, this.server].some((r) => r?.owner && !r.exited)) this.watchLease();
      },
      Math.max(50, Math.min(30_000, this.leaseMs / 4)),
    );
    (this.leaseTimer as { unref?: () => void }).unref?.();
  }

  /** Ends what another hub's pool started here once that pool stopped asking about it (it crashed, or was unlinked). */
  private expire() {
    if (this.closed) return;
    const due = [this.helper, this.server].filter((run): run is Running => !!run?.owner && !run.starting && !run.stopping && !run.exited && Date.now() - run.seenAt >= this.leaseMs);
    if (!due.length) return;
    const own = this.deps.hubId();
    for (const run of due) {
      if (run.owner!.hub === own) continue;
      const what = run.role === "server" ? "model server" : "helper";
      const pool = run.owner!.name;
      log.info(`ending the ${what}: the model pool on ${pool} hasn't asked about it for ${Math.round(this.leaseMs / 1000)} s`);
      const detail = `Ended by itself: the model pool on ${pool} stopped asking for it.`;
      void (run.role === "server" ? this.stopServer() : this.stopHelper())
        .then(() => {
          if (run.role === "server" && !this.server) this.serverDetail = detail;
          if (run.role === "helper" && !this.helper) this.helperDetail = detail;
          this.changed();
        })
        .catch(() => {});
    }
  }

  /** Another hub's pool runs something here and still asks about it: this machine lends its GPU to one pool at a time. */
  private refuseTaken(owner: PoolOwner | null) {
    if (!owner) return;
    for (const run of [this.helper, this.server]) {
      if (!run?.owner || run.stopping || run.owner.hub === owner.hub || Date.now() - run.seenAt >= this.leaseMs) continue;
      const doing = run.role === "server" ? "runs the model server" : "lends its GPU";
      throw new HttpError(
        409,
        `This machine already ${doing} for the model pool on ${run.owner.name}: stop that pool there first, or switch this machine off in it, then start again. It also ends by itself ${Math.round(this.leaseMs / 60_000)} minutes after ${run.owner.name} stops asking for it.`,
        "in_use",
      );
    }
  }

  /**
   * What this machine is and does (GET /api/pool/node): asks Tailscale for its address, and llama.cpp for its GPUs when
   * that list is old (or `refresh`) and nothing of llama.cpp runs here. `build`/`backend` pick the install whose GPUs
   * are listed (default: the one used last, else the newest).
   */
  async info(opts: { refresh?: boolean; build?: string; backend?: PoolBackend } = {}): Promise<PoolNodeInfo> {
    await Promise.all([this.address(opts.refresh), this.refreshDevices(opts)]);
    return this.snapshot();
  }

  /** This machine's GPUs as llama.cpp lists them (asked again once the list is old and nothing of llama.cpp runs here; none without an install): Settings → Local models. */
  async gpus(): Promise<PoolDevice[]> {
    await this.refreshDevices({}).catch(() => {});
    return this.devicesCache?.list ?? [];
  }

  /** The pool's server here serves the model file at `path`. */
  serving(path: string): boolean {
    return !!this.server?.model && modelFiles(this.server.model).includes(path);
  }

  /**
   * GET /api/pool/node: ?refresh=1 asks llama.cpp again; ?build=…&backend=… picks the install whose GPUs are listed;
   * ?owner=<hub id>: the pool on that hub still asks about what it runs here.
   */
  infoFor(query: URLSearchParams): Promise<PoolNodeInfo> {
    const build = query.get("build");
    const backend = query.get("backend");
    if (!!build !== !!backend) throw new HttpError(400, "Give both the build and the backend, or neither.");
    const owner = query.get("owner");
    if (owner !== null) {
      if (!HUB_ID_RE.test(owner)) throw new HttpError(400, "Say whose pool asks with its hub id, like h_abc123.");
      this.touch(owner);
    }
    return this.info({ refresh: query.get("refresh") === "1", ...(build && backend ? { build: checkBuild(build), backend: checkBackend(backend) } : {}) });
  }

  /**
   * GET /api/pool/node/helpers?build=…&backend=…&address=ip:port…: the GPUs helpers on other machines lend, as
   * llama.cpp here sees them (`--rpc … --list-devices`), so the pool can count a PC's GPU memory before it starts.
   * Never while this machine's model server runs: a helper serves one client at a time, and that's the server.
   */
  async helperGpus(query: URLSearchParams): Promise<{ helpers: HelperGpus[] }> {
    const build = checkBuild(query.get("build"));
    const backend = checkBackend(query.get("backend"));
    const addresses = [...new Set(query.getAll("address").map(checkHelperAddress))];
    if (!addresses.length || addresses.length > 8) throw new HttpError(400, "Name one to eight helpers to ask, like address=100.64.0.2:50052.");
    if (this.server) throw new HttpError(409, "The pool's model server runs here, and its helpers are busy with it: check again once the pool is stopped.", "server_running");
    const inst = findInstall(build, backend);
    if (!inst) throw new HttpError(409, `llama.cpp ${build} isn't on this machine yet: it's installed the first time the pool starts.`, "not_installed");
    const helpers = await Promise.all(
      addresses.map(async (address): Promise<HelperGpus> => {
        try {
          return { address, devices: await helperDevices(inst.server, address, this.helperCheckMs), error: null };
        } catch (e) {
          return { address, devices: [], error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return { helpers };
  }

  /** The node routes' requests, checked strictly (POST /api/pool/node/install, /helper, /model, /server). */
  async handle(kind: "install" | "helper" | "model" | "server", input: unknown): Promise<PoolNodeInfo> {
    if (kind === "install") {
      const b = parseInstallBody(input);
      return this.install(b.build, b.backend);
    }
    if (kind === "helper") {
      const b = parseHelperBody(input);
      if (b.owner) this.touch(b.owner.hub);
      return b.action === "stop" ? this.stopHelper(b.owner) : this.startHelper(b);
    }
    if (kind === "model") {
      const b = parseModelBody(input);
      if (b.action === "cancel") return this.cancelDownload();
      if (b.action === "remove") return this.removeModels(b.files);
      return this.downloadModel(b.model, b.hfToken);
    }
    const b = parseServerBody(input);
    if (b.owner) this.touch(b.owner.hub);
    return b.action === "stop" ? this.stopServer(b.owner) : this.startServer(b);
  }

  /** This machine's Tailscale IPv4 (asked again after 30 seconds, or when `fresh`). */
  async address(fresh = false): Promise<string | null> {
    const c = this.addressCache;
    if (!fresh && c && Date.now() - c.at < ADDRESS_TTL) return c.value;
    const value = await tailscaleIPv4();
    this.addressCache = { value, at: Date.now() };
    return value;
  }

  private busy(): PoolNodeInfo["busy"] {
    if (this.downloadJob) {
      const p = this.downloadJob.progress;
      return { what: "download", file: p.file, doneBytes: p.doneBytes, totalBytes: p.totalBytes };
    }
    if (this.installJob) {
      const p = this.installJob.progress;
      return p ? { what: "install", file: p.file, doneBytes: p.doneBytes, totalBytes: p.totalBytes } : { what: "install" };
    }
    return null;
  }

  /** Neither the helper nor the server runs here: its GPUs can be listed again. */
  private idle() {
    return !this.helper && !this.server;
  }

  private preferredInstall(): LlamaInstall | null {
    const running = this.server?.install ?? this.helper?.install;
    if (running) return running;
    const parse = (id: string) => {
      const m = /^(b\d+)-(\w+)$/.exec(id);
      return m ? findInstall(m[1], m[2] as PoolBackend) : null;
    };
    if (this.lastUsed) {
      const used = parse(this.lastUsed);
      if (used) return used;
    }
    const ids = installedBuilds();
    const newest = ids[0]?.split("-")[0];
    const best = ids.filter((id) => id.startsWith(`${newest}-`)).sort((a, b) => BACKEND_ORDER.indexOf(a.split("-")[1] as PoolBackend) - BACKEND_ORDER.indexOf(b.split("-")[1] as PoolBackend))[0];
    return best ? parse(best) : null;
  }

  private refreshDevices(opts: { refresh?: boolean; build?: string; backend?: PoolBackend }): Promise<void> {
    const inst = opts.build && opts.backend ? findInstall(opts.build, opts.backend) : this.preferredInstall();
    if (!inst) {
      if (opts.build) throw new HttpError(404, `llama.cpp ${opts.build}-${opts.backend} isn't installed here: install it first.`);
      this.devicesCache = { key: "", list: [], at: Date.now() };
      return Promise.resolve();
    }
    const c = this.devicesCache;
    if (!opts.refresh && c && c.key === inst.id && Date.now() - c.at < DEVICES_TTL) return Promise.resolve();
    // While the helper or the server runs, the list it has is kept (it's only made then if there's none yet, say
    // after the hub restarted with the pool running).
    if ((!this.idle() && c?.key === inst.id) || this.closed) return Promise.resolve();
    if (this.devicesJob) return this.devicesJob;
    this.devicesJob = listDevices(inst.server)
      .then(
        (list) => {
          this.devicesCache = { key: inst.id, list, at: Date.now() };
          if (this.lastError?.what === "devices") this.lastError = null;
        },
        (e) => {
          // Not asked again until the list is old, so a broken install doesn't run llama.cpp on every request.
          this.devicesCache = { key: inst.id, list: c?.key === inst.id ? c.list : [], at: Date.now() };
          this.lastError = { what: "devices", detail: errText(e), at: Date.now() };
          log.warn(`couldn't list the GPUs with llama.cpp ${inst.id}: ${errText(e)}`);
        },
      )
      .finally(() => {
        this.devicesJob = null;
        this.changed();
      });
    return this.devicesJob;
  }

  private requireInstall(build: string, backend: PoolBackend): LlamaInstall {
    const inst = findInstall(build, backend);
    if (!inst) throw new HttpError(409, `llama.cpp ${build} (${backend}) isn't installed on this machine: install it first.`, "not_installed");
    return inst;
  }

  // ---- Installing llama.cpp ----

  /** Installs a llama.cpp build in the background (`busy` shows it; `lastError` says if it failed). */
  async install(build: string, backend: PoolBackend): Promise<PoolNodeInfo> {
    checkBuild(build);
    checkBackend(backend);
    const { os, arch } = hostPlatform();
    assetsFor(build, os, arch, backend);
    const id = `${build}-${backend}`;
    if (findInstall(build, backend)) return this.snapshot();
    if (this.installJob) {
      if (this.installJob.id === id) return this.snapshot();
      throw new HttpError(409, `llama.cpp ${this.installJob.id} is being installed here: wait for it to finish, then try again.`, "busy");
    }
    if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
    if (this.lastError?.what === "install") this.lastError = null;
    const ctrl = new AbortController();
    const job = { id, progress: null as InstallProgress | null, ctrl, done: Promise.resolve() };
    job.done = installBuild(build, backend, (p) => {
      job.progress = p;
      this.changedSoon();
    }, { signal: ctrl.signal })
      .then(
        (inst) => {
          this.lastUsed = inst.id;
          this.devicesCache = null;
        },
        (e) => {
          if (ctrl.signal.aborted) return;
          this.lastError = { what: "install", detail: errText(e), at: Date.now() };
          log.warn(`installing llama.cpp ${id} failed: ${errText(e)}`);
        },
      )
      .finally(() => {
        if (this.installJob === job) this.installJob = null;
        this.changed();
        // Its GPUs, now that it's installed.
        if (!this.closed) void this.refreshDevices({}).catch(() => {});
      });
    this.installJob = job;
    this.changed();
    return this.snapshot();
  }

  // ---- Lending this machine's GPU ----

  /**
   * Runs `ggml-rpc-server -H <Tailscale IPv4> -p <port> -d <its GPUs> [-c]`; refused without Tailscale (it has no auth
   * of its own), without a GPU, and while it lends its GPU to another hub's pool.
   */
  startHelper(opts: HelperStart): Promise<PoolNodeInfo> {
    return this.serial("helper", () => this.startHelperNow(opts));
  }

  /** Ends the helper; with `owner`, only one that runs for that hub's pool (or for none). */
  stopHelper(owner: PoolOwner | null = null): Promise<PoolNodeInfo> {
    return this.serial("helper", () => (owner && this.helper?.owner && this.helper.owner.hub !== owner.hub ? Promise.resolve(this.snapshot()) : this.stopHelperNow()));
  }

  private async startHelperNow(opts: HelperStart): Promise<PoolNodeInfo> {
    const inst = this.requireInstall(opts.build, opts.backend);
    if (Number(opts.build.slice(1)) < OLDEST_SAFE_HELPER_BUILD) {
      throw new HttpError(400, `llama.cpp ${opts.build} is too old to lend a GPU safely: pick b${OLDEST_SAFE_HELPER_BUILD} or newer for the pool.`);
    }
    if (!inst.rpc) throw new HttpError(409, `llama.cpp ${inst.id} has no ggml-rpc-server: install another build.`);
    const owner = opts.owner ?? null;
    this.refuseTaken(owner);
    // CROSSTALK_POOL_LOOPBACK=1 (tests only) lets a helper listen on 127.0.0.1.
    const host = process.env.CROSSTALK_POOL_LOOPBACK === "1" ? "127.0.0.1" : await this.address(true);
    if (!host) {
      throw new HttpError(409, "Tailscale isn't running on this machine: open Tailscale and sign in, then start again. A helper only listens on Tailscale, never on other networks.", "no_tailscale");
    }
    const cur = this.helper;
    // The same pool's same start asking again keeps it; a new start gets a helper of its own, with no client from before.
    const sameStart = !owner || !cur?.owner || (cur.owner.hub === owner.hub && cur.owner.run === owner.run);
    if (cur && !cur.stopping && cur.install.id === inst.id && cur.port === opts.port && cur.host === host && sameStart) {
      if (owner) {
        cur.owner = owner;
        this.watchLease();
      }
      cur.seenAt = Date.now();
      return this.snapshot();
    }
    // A server an earlier start of the same pool left here: in one pool a machine is the main machine or a helper.
    // (Not waited for: a server start waiting on the helper's queue meanwhile would wait on this one.)
    if (owner && this.server?.owner?.hub === owner.hub && this.server.owner.run !== owner.run) void this.stopServer().catch(() => {});
    // A helper already here is ended as part of this start, so it is not what the new one has to fit beside: a run
    // that crashed or was cancelled used to leave one up, and the next run was then refused for twice its own size.
    if (this.deps.beforeStart) {
      await this.deps.beforeStart({ what: "the model pool's helper", needBytes: opts.cacheBytes ?? null, replacing: cur?.proc.pid ?? null, canForce: false });
    }
    if (cur) await this.stopHelperNow();
    if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
    // Exactly this machine's GPUs, as llama.cpp names them here: never its CPU, which would make the whole pool crawl.
    const gpus = await this.gpusOf(inst);
    const cache = this.prepareCache(opts.cacheBytes ?? null);
    const args = [inst.rpc, "-H", host, "-p", String(opts.port), "-d", gpus.map((d) => d.name).join(","), ...(cache ? ["-c"] : [])];
    const run = this.spawn("helper", inst, args, cache ? { LLAMA_CACHE: llamaCacheDir() } : {}, host, opts.port);
    run.owner = owner;
    run.cache = cache;
    if (owner) this.watchLease();
    this.helper = run;
    this.helperDetail = null;
    this.lastUsed = inst.id;
    this.changed();
    // It's started once it has said what it serves and kept running a moment; a taken port ends it at once.
    const ok = await settle(run, /^\s*transport\s*:|^Devices:|^\s*endpoint\s*:/, 1500, 15_000);
    if (!ok) {
      await run.closed;
      throw new HttpError(409, this.helperDetail ?? "The helper stopped as it started: start it again.", "helper_failed");
    }
    // Its lease starts now that it's running.
    run.seenAt = Date.now();
    run.starting = false;
    this.helperDetail = `Lending its GPU at ${host}:${opts.port}${cache ? "" : " (without its weight cache: the disk has too little room for it)"}`;
    log.info(`helper running: llama.cpp ${inst.id} on ${host}:${opts.port}${owner ? ` for the pool on ${owner.name}` : ""}${cache ? "" : ", without its weight cache"}`);
    if (cache) this.watchDisk(run);
    this.changed();
    return this.snapshot();
  }

  /** This machine's GPUs for that install, as llama.cpp lists them (asked again when the list is old). */
  private async gpusOf(inst: LlamaInstall): Promise<PoolDevice[]> {
    const c = this.devicesCache;
    if (!(c?.key === inst.id && c.list.length && Date.now() - c.at < DEVICES_TTL)) await this.refreshDevices({ build: inst.build, backend: inst.backend, refresh: true });
    const list = this.devicesCache?.key === inst.id ? this.devicesCache.list : [];
    if (list.length) return list;
    if (this.lastError?.what === "devices") throw new HttpError(409, `llama.cpp couldn't list this machine's GPUs: ${this.lastError.detail}`, "no_gpu");
    throw new HttpError(409, "llama.cpp found no GPU on this machine: switch it off in the pool (lending its CPU would make the whole pool very slow), then start again.", "no_gpu");
  }

  private async stopHelperNow(): Promise<PoolNodeInfo> {
    const run = this.helper;
    if (run) {
      run.stopping = true;
      await endProcess(run.proc);
      await run.closed;
      log.info("helper stopped");
    }
    this.helperDetail = null;
    this.changed();
    return this.snapshot();
  }

  /**
   * Whether the helper keeps the weights it's sent (-c, one file per tensor, no size limit of its own): only with room
   * on the disk for this start's share of the model on top of the hub's reserve and 10 GB more, because a full disk
   * corrupts the cache without a word. The oldest files go first to make that room, and to keep the cache within a
   * quarter of the disk. A cache that may hold a file cut short (the disk filled up while it ran) is cleared first.
   */
  private prepareCache(share: number | null): boolean {
    const dir = llamaCacheDir();
    const rpcCache = join(dir, "rpc");
    try {
      mkdirSync(dir, { recursive: true });
      if (this.cacheSuspect) {
        rmSync(rpcCache, { recursive: true, force: true });
        this.cacheSuspect = false;
        log.info("cleared the helper's weight cache: the disk filled up while it was written");
      }
      const need = (share ?? 0) + diskReserve() + 10 * GB;
      const { total, free } = diskSpace(dir);
      const budget = Math.max(share ?? 0, total / 4);
      const files = cacheFiles(rpcCache);
      let size = files.reduce((n, f) => n + f.bytes, 0);
      let room = free;
      let removed = 0;
      for (const f of files) {
        if (room >= need && size <= budget) break;
        rmSync(f.path, { force: true });
        room += f.bytes;
        size -= f.bytes;
        removed++;
      }
      if (removed) log.info(`removed ${removed} file(s) from the helper's weight cache, oldest first, to keep room on the disk`);
      return diskSpace(dir).free >= need;
    } catch (e) {
      log.warn(`couldn't check the helper's weight cache: ${errText(e)}`);
      return false;
    }
  }

  /** While the helper fills its weight cache: a disk that gets almost full may cut a file short, so it's cleared next time. */
  private watchDisk(run: Running) {
    const tick = () => {
      run.timer = null;
      if (this.helper !== run || run.exited || run.stopping) return;
      try {
        if (!this.cacheSuspect && diskSpace(llamaCacheDir()).free < diskReserve()) {
          this.cacheSuspect = true;
          this.helperDetail = "The disk is almost full, so the helper's weight cache may be damaged: free up space on this machine. Crosstalk clears the cache the next time the helper starts.";
          log.warn("the disk is almost full while the helper writes its weight cache: it's cleared before the helper's next start");
          this.changed();
        }
      } catch {
        // unreadable: looked at again
      }
      run.timer = setTimeout(tick, this.diskWatchMs);
      (run.timer as { unref?: () => void }).unref?.();
    };
    run.timer = setTimeout(tick, this.diskWatchMs);
    (run.timer as { unref?: () => void }).unref?.();
  }

  // ---- Models ----

  /** Downloads a model in the background (resumable; refused at once when the disk is too full). */
  async downloadModel(model: PoolModel, hfToken?: string | null): Promise<PoolNodeInfo> {
    const m = checkModel(model);
    const cur = this.downloadJob;
    if (cur) {
      if (cur.model.repo === m.repo && cur.model.files.join("\n") === m.files.join("\n")) return this.snapshot();
      throw new HttpError(409, `${cur.model.repo} is downloading here: wait for it, or cancel it first.`, "busy");
    }
    if (haveModel(m)) return this.snapshot();
    if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
    // Settings → Local models may be downloading it into the same folder.
    const by = downloadingBy(modelFiles(m));
    if (by) throw new HttpError(409, DOWNLOADERS[by], "busy");
    checkSpace(m);
    if (this.lastError?.what === "download") this.lastError = null;
    const ctrl = new AbortController();
    const job = { model: m, progress: { file: m.files[0], doneBytes: 0, totalBytes: m.sizeBytes, bytesPerSec: null } as DownloadProgress, ctrl, done: Promise.resolve() };
    job.done = downloadFiles(m, hfToken ?? null, (p) => {
      job.progress = p;
      this.changedSoon();
    }, ctrl.signal)
      .then(
        () => undefined,
        (e) => {
          if (ctrl.signal.aborted) return;
          this.lastError = { what: "download", detail: errText(e), at: Date.now() };
          log.warn(`downloading ${m.repo} failed: ${errText(e)}`);
        },
      )
      .finally(() => {
        if (this.downloadJob === job) this.downloadJob = null;
        this.changed();
      });
    this.downloadJob = job;
    this.changed();
    return this.snapshot();
  }

  /** Stops the download; what's downloaded stays, and the next download continues from there. */
  async cancelDownload(): Promise<PoolNodeInfo> {
    const job = this.downloadJob;
    if (job) {
      job.ctrl.abort();
      await job.done;
      log.info(`download of ${job.model.repo} cancelled`);
    }
    return this.snapshot();
  }

  /** Moves model files ("<owner>/<repo>/<file>", as `models` lists them) to the Trash, with their unfinished parts. */
  async removeModels(entries: string[]): Promise<PoolNodeInfo> {
    const onDisk = new Set(modelFilesOnDisk().filter((f) => !f.partial).map((f) => f.file));
    const paths: string[] = [];
    const inUse = (run: Running | null) => (run?.model ? modelFiles(run.model) : []);
    for (const entry of entries) {
      const { repo, file } = splitModelFile(entry);
      const path = filePath(repo, file);
      if (inUse(this.server).includes(path)) throw new HttpError(409, "The pool's server is using this model: stop the pool first.", "in_use");
      if (this.downloadJob && modelFiles(this.downloadJob.model).includes(path)) throw new HttpError(409, "This model is downloading: cancel the download first.", "busy");
      const by = downloadingBy([path]);
      if (by) throw new HttpError(409, DOWNLOADERS[by], "busy");
      if (onDisk.has(`${repo}/${file}`)) paths.push(path);
      if (isFile(`${path}.part`)) paths.push(`${path}.part`);
    }
    if (paths.length) {
      await toTrash(paths, this.trashOptions);
      // The note of the version a download was pinned to (a line of text) goes with it.
      for (const p of paths) rmSync(`${p.replace(/\.part$/, "")}.rev`, { force: true });
      // Folders this leaves empty go too (only empty ones, never the models folder itself).
      for (const p of paths) removeEmptyFolders(dirname(p));
      log.info(`moved ${paths.length} model file(s) to the Trash`);
    }
    this.changed();
    return this.snapshot();
  }

  // ---- The pool's server ----

  /**
   * Runs llama-server for the pool (healthy once /health answers 200), after each helper answered llama.cpp from here.
   * A running one is replaced, unless it runs for another hub's pool that still asks about it.
   */
  startServer(opts: ServerStart): Promise<PoolNodeInfo> {
    return this.serial("server", () => this.startServerNow(opts));
  }

  /** Ends the server; with `owner`, only one that runs for that hub's pool (or for none). */
  stopServer(owner: PoolOwner | null = null): Promise<PoolNodeInfo> {
    return this.serial("server", () => (owner && this.server?.owner && this.server.owner.hub !== owner.hub ? Promise.resolve(this.snapshot()) : this.stopServerNow()));
  }

  private async startServerNow(opts: ServerStart): Promise<PoolNodeInfo> {
    const inst = this.requireInstall(opts.build, opts.backend);
    const m = checkModel(opts.model);
    const files = modelFiles(m);
    if (!files.every(isFile)) throw new HttpError(409, "The model isn't fully downloaded on this machine: download it first.", "no_model");
    // Does it fit beside what else is running here? Before anything is spawned, so a refusal changes nothing.
    if (this.deps.beforeStart) {
      await this.deps.beforeStart({
        what: "the model pool's server",
        needBytes: poolNeedBytes(files, opts.contextSize, opts.devices),
        // The server this start replaces stops first, so it isn't counted as holding the memory this one wants.
        replacing: this.server?.proc.pid ?? null,
        canForce: false,
      });
    }
    const owner = opts.owner ?? null;
    this.refuseTaken(owner);
    await this.checkHost(opts.host);
    // A helper an earlier start of the same pool left here: in one pool a machine is the main machine or a helper.
    // (Not waited for: a helper start waiting on the server's queue meanwhile would wait on this one.)
    if (owner && this.helper?.owner?.hub === owner.hub && this.helper.owner.run !== owner.run) void this.stopHelper().catch(() => {});
    if (this.server) await this.stopServerNow();
    if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
    // Every helper answers llama.cpp from here first (a helper serves one client at a time, so one that another
    // program holds would leave the server waiting for good), and says how many devices it serves.
    const served = await Promise.all(opts.rpc.map((address) => helperDevices(inst.server, address, this.helperCheckMs)));
    if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
    let devices: string[] | null;
    if (opts.devices === "helpers") {
      // llama.cpp names them across the helpers in --rpc order, one per device each serves.
      const count = served.reduce((n, list) => n + list.length, 0);
      if (!count) throw new HttpError(502, "llama.cpp here didn't list the helpers' GPUs: check that every machine runs the same llama.cpp build, then start again.");
      devices = Array.from({ length: count }, (_, i) => `RPC${i}`);
    } else devices = opts.devices;
    const run = this.spawn("server", inst, serverArgs(inst.server, { ...opts, devices }, files[0]), { LLAMA_API_KEY: opts.apiKey }, opts.host, opts.port);
    run.model = m;
    run.owner = owner;
    run.starting = false;
    if (owner) this.watchLease();
    this.server = run;
    this.serverLines = run.lines;
    this.serverDetail = "Loading the model: this can take a few minutes.";
    this.lastUsed = inst.id;
    log.info(`model server starting: llama.cpp ${inst.id}, ${m.repo}${opts.rpc.length ? ` with ${opts.rpc.length} helper(s)` : ""}, on ${opts.host}:${opts.port}`);
    void this.watchHealth(run);
    this.changed();
    return this.snapshot();
  }

  /** What the pool is running on this machine, for the memory guard: its name on the phone and its process. */
  heavy(): { what: string; pid: number; port: number }[] {
    const out: { what: string; pid: number; port: number }[] = [];
    for (const [what, run] of [["the model pool's server", this.server], ["the model pool's helper", this.helper]] as const) {
      // The port comes too: the memory guard needs it to know that the "Model pool" account pointing at
      // 127.0.0.1:<port> is this very process, and not a second program holding another copy of the model.
      if (run && !run.exited && !run.stopping && run.proc.pid) out.push({ what, pid: run.proc.pid, port: run.port });
    }
    return out;
  }

  /** The server listens on 127.0.0.1, or on this machine's own Tailscale address (never anywhere else). */
  async checkHost(host: string): Promise<void> {
    if (host === "127.0.0.1") return;
    const own = await this.address(true);
    if (host === own && own) return;
    throw new HttpError(400, own ? `The server can only listen on 127.0.0.1 or this machine's Tailscale address (${own}).` : "Tailscale isn't running on this machine: open Tailscale and sign in, or keep the server on 127.0.0.1.");
  }

  private async stopServerNow(): Promise<PoolNodeInfo> {
    const run = this.server;
    if (run) {
      run.stopping = true;
      await endProcess(run.proc);
      await run.closed;
      log.info("model server stopped");
    }
    this.serverDetail = null;
    this.changed();
    return this.snapshot();
  }

  /** Waits for the server's /health to answer 200 (503 while it loads the model). */
  private async watchHealth(run: Running) {
    const url = `http://${run.host}:${run.port}/health`;
    const started = Date.now();
    while (this.server === run && !run.exited && !run.stopping) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        await res.body?.cancel().catch(() => {});
        if (res.status === 200 && this.server === run && !run.exited) {
          run.healthy = true;
          this.serverDetail = null;
          log.info(`model server ready on ${run.host}:${run.port}`);
          this.changed();
          return;
        }
      } catch {
        // not listening yet
      }
      await Bun.sleep(Date.now() - started < 15_000 ? 250 : 1000);
    }
  }

  // ---- Processes ----

  private spawn(role: Role, inst: LlamaInstall, args: string[], env: Record<string, string>, host: string, port: number): Running {
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(args, { cwd: dirname(args[0]), env: llamaEnv(args[0], env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      throw new HttpError(500, `llama.cpp didn't start on this machine (${errText(e)}): install the build again.`);
    }
    const lines: string[] = [];
    const keep = (line: string) => {
      lines.push(line);
      if (lines.length > SERVER_LOG_LINES) lines.splice(0, lines.length - SERVER_LOG_LINES);
      if (role === "server") this.changedSoon();
    };
    const output = Promise.all([readLines(proc.stdout, keep), readLines(proc.stderr, keep)]);
    const run: Running = { role, proc, install: inst, host, port, lines, stopping: false, exited: false, healthy: false, model: null, owner: null, seenAt: Date.now(), starting: true, cache: false, timer: null, closed: Promise.resolve() };
    this.note((list) => [...list.filter((n) => n.pid !== proc.pid), { pid: proc.pid, bin: args[0], role }]);
    run.closed = proc.exited.then(async () => {
      run.exited = true;
      // Its last lines say what went wrong: wait (briefly) for the output to be read.
      await Promise.race([output, Bun.sleep(1000)]);
      this.exited(run);
    });
    return run;
  }

  /** A process ended: as asked (stop), or on its own, which is said in plain words from its last lines. */
  private exited(run: Running) {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.note((list) => list.filter((n) => n.pid !== run.proc.pid));
    const code = run.proc.exitCode;
    const signal = run.proc.signalCode ?? null;
    const detail = run.stopping ? null : explainExit(run.role, run.lines, code, signal, { port: run.port });
    if (run.role === "helper" && this.helper === run) {
      this.helper = null;
      this.helperDetail = detail;
    } else if (run.role === "server" && this.server === run) {
      this.server = null;
      this.serverDetail = detail;
    } else return;
    if (detail) log.warn(`the ${run.role === "server" ? "model server" : "helper"} stopped on its own (${code ?? signal}): ${detail}`);
    this.changed();
  }

  private noted(): Noted[] {
    if (!this.deps.stateFile) return [];
    try {
      const list = JSON.parse(readFileSync(this.deps.stateFile, "utf8"));
      return Array.isArray(list) ? list.filter((n) => Number.isInteger(n?.pid) && typeof n?.bin === "string") : [];
    } catch {
      return [];
    }
  }

  private note(update: (list: Noted[]) => Noted[]) {
    const file = this.deps.stateFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(update(this.noted())), { mode: 0o600 });
    } catch (e) {
      log.warn(`couldn't note the pool's processes: ${errText(e)}`);
    }
  }

  /** Stops everything it runs (helper, server, download, install): the hub is shutting down. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.downloadJob?.ctrl.abort();
    this.installJob?.ctrl.abort();
    await Promise.allSettled([this.stopHelper(), this.stopServer()]);
    const jobs = [this.downloadJob?.done, this.installJob?.done, this.devicesJob].filter(Boolean);
    if (jobs.length) await Promise.race([Promise.allSettled(jobs), Bun.sleep(5000)]);
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
    this.listeners.clear();
  }

  /** Resolves once background work (an install, a download, a device list) has finished: for tests. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([this.downloadJob?.done, this.installJob?.done, this.devicesJob].filter(Boolean));
  }
}

/**
 * Resolves true once the process has printed a line matching `ready` and kept running `graceMs` after it (or after
 * `maxMs` in any case), false if it exits first.
 */
async function settle(run: Running, ready: RegExp, graceMs: number, maxMs: number): Promise<boolean> {
  const started = Date.now();
  let seenAt: number | null = null;
  while (!run.exited) {
    if (seenAt === null && run.lines.some((l) => ready.test(l))) seenAt = Date.now();
    if (seenAt !== null && Date.now() - seenAt >= graceMs) return true;
    if (Date.now() - started >= maxMs) return true;
    await Bun.sleep(50);
  }
  return false;
}

/** The helper's weight cache files, least recently used first (by when each was last read or written). */
function cacheFiles(dir: string): { path: string; bytes: number; at: number }[] {
  const out: { path: string; bytes: number; at: number }[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (e.isFile()) {
        try {
          const s = lstatSync(path);
          out.push({ path, bytes: s.size, at: Math.max(s.atimeMs, s.mtimeMs) });
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.at - b.at);
}

/** Removes `dir` and the folders above it while they're empty, up to (not including) the models folder. */
function removeEmptyFolders(dir: string) {
  const root = modelsDir();
  for (let d = dir; d.startsWith(root + sep); d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return; // not empty, or gone
    }
  }
}

/** A noted process is still one of the pool's: alive, and its command line runs that llama.cpp program. */
async function isOurs(n: Noted): Promise<boolean> {
  try {
    process.kill(n.pid, 0);
  } catch {
    return false;
  }
  try {
    const p = Bun.spawn(["ps", "-o", "command=", "-p", String(n.pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const cmd = await new Response(p.stdout).text();
    await p.exited;
    return cmd.includes(n.bin);
  } catch {
    return false;
  }
}

/** Ends a process this hub didn't start itself: SIGTERM, then SIGKILL after the grace period. */
async function endPid(pid: number): Promise<void> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const until = Date.now() + processGrace.ms;
  while (alive() && Date.now() < until) await Bun.sleep(100);
  if (!alive()) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const end = Date.now() + 1000;
  while (alive() && Date.now() < end) await Bun.sleep(50);
}
