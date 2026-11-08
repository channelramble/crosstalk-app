// The model pool, run from the hub where the user sets it up (docs/MODEL-POOL.md): its settings (kv "pool"), the
// machines in it (this hub, linked hubs, other computers), checking them, and starting it: the llama.cpp build on
// every hub taking part, their helpers, the model on the main machine and its server, which chats then use as the
// "Model pool" custom model for Claude Code and Codex. Hubs are asked over /api/pool/node… (this hub directly). A
// computer runs its helper itself (the command from helperCommand), so it's only ever checked with a TCP connection
// that closes at once, and never while the pool's server may be using it: a helper serves one client at a time.
// What a start runs on a hub is this pool's (its owner, node.ts) while it keeps asking about it; what a hub that
// stopped without ending it (a crash, a power cut) left on the others is noted (kv pool.left) and ended when it's back.

import {
  memberAccount,
  type Member,
  type PoolBackend,
  type PoolConfig,
  type PoolDevice,
  type PoolFit,
  type PoolMachine,
  type PoolMachineState,
  type PoolModel,
  type PoolModelChoices,
  type PoolNodeInfo,
  type PoolOffer,
  type PoolOwner,
  type PoolStatus,
  type PoolView,
  type Provider,
} from "@crosstalk/shared";
import type { App } from "../app";
import { readSecrets, writeSecret } from "../config";
import { HttpError } from "../engine/engine";
import { hubCall } from "../machines";
import { newId, secretToken } from "../util/ids";
import { logger } from "../util/log";
import { checkHelperOs, defaultBackend, helperCommand as makeHelperCommand, shortHelperCommand, type HelperCommand, type HelperOs } from "./commands";
import { assetsFor, BUILD_RE, checkBackend, checkBuild, errText, hostPlatform, OLDEST_SAFE_HELPER_BUILD, POOL_BACKENDS } from "./llama";
import { checkModel, choices, splitModelFile } from "./models";
import { ALIAS_RE, checkPort, LEASE_MS, type HelperGpus } from "./node";
import { isTailscaleIPv4 } from "../tailscale";
import { tailscalePeers, tailscalePing, type TailscaleLink, type TailscalePeer } from "./tailscale";

const log = logger("pool");

/** The llama.cpp build a new pool pins (every machine runs exactly this one). */
export const POOL_BUILD = "b11669";
/** llama-server's own default port. */
export const POOL_PORT = 9931;
/** ggml-rpc-server's own default port. */
export const RPC_PORT = 50052;
/** Claude Code needs about 20k tokens just to start, and chats summarize at three quarters of the context. */
export const DEFAULT_CONTEXT = 65536;
export const MIN_CONTEXT = 2048;
export const MAX_CONTEXT = 1_048_576;
/** What the custom-model accounts are called. */
export const ACCOUNT_LABEL = "Model pool";
/** Where the server's API key is kept (this hub's secrets file), made once. */
export const KEY_SECRET = "pool:apikey";
/** The user's Hugging Face token (this hub's secrets file): sent to the main machine only with a download. */
export const HF_SECRET = "HF_TOKEN";
/** Machines in one pool, at most. */
const MAX_MACHINES = 32;
/** Lines of the main machine's server output in the status. */
const LOG_LINES = 60;
const MiB = 1024 * 1024;
const PROVIDERS: Provider[] = ["claude", "codex"];
const HUB_ID = /^h_[\w-]{4,40}$/;
const COMPUTER_ID = /^pc_[\w-]{1,40}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HF_TOKEN = /^[\x21-\x7e]{8,400}$/;
const ACTIVE: PoolStatus["state"][] = ["preparing", "downloading", "starting", "running"];
/** How long "Start when the hub starts" keeps trying while a machine isn't up yet (after a power cut they start in any order). */
const RESUME_FOR_MS = 15 * 60_000;
/** A computer's helper-command link (GET /api/pool/helper/<token>): short enough to type. */
const SCRIPT_TOKEN = /^[a-z0-9]{20}$/;

/** Tests only (CROSSTALK_POOL_LOOPBACK=1): helpers and servers listen on 127.0.0.1, so a pool fits on one machine. */
const loopback = () => process.env.CROSSTALK_POOL_LOOPBACK === "1";

/** A short command's token: 20 letters and digits that can't be mistaken for each other when typed (100 bits). */
function shortToken(): string {
  const letters = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => letters[b & 31]).join("");
}

/** A numeric IPv4, written plainly (no leading zeros). */
export function isIPv4(v: unknown): v is string {
  const m = typeof v === "string" ? IPV4.exec(v) : null;
  return !!m && m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
}

/** A short name for the model in chats, from its repo: "unsloth/Qwen3.8-27B-GGUF" is "qwen3.8-27b". */
export function aliasFor(model: Pick<PoolModel, "repo"> | null): string {
  if (!model) return "";
  let name = model.repo.split("/").pop() ?? model.repo;
  name = name.replace(/[-_.]?gguf$/i, "");
  // bartowski's "org_Model": the model's own name.
  const unprefixed = /^[a-z0-9-]+_(.{3,})$/.exec(name);
  if (unprefixed) name = unprefixed[1];
  name = name
    .toLowerCase()
    .replace(/[^\w.:-]+/g, "-")
    .replace(/^[-.:]+|[-.:]+$/g, "")
    .slice(0, 48)
    .replace(/[-.:]+$/, "");
  return ALIAS_RE.test(name) ? name : "pool-model";
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

const sizeText = (mib: number) => (mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.max(1, Math.ceil(mib))} MB`);

/** "Gaming PC", "Gaming PC and Linux box", "A, B and C". */
const names = (list: { name: string }[]) => {
  const n = list.map((x) => x.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

/** "in a moment", "in 10 seconds". */
const waitText = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 1 ? "in a moment" : `in ${s} second${s === 1 ? "" : "s"}`;
};

/** What another hub's pool started on a hub ends by itself this many minutes after that pool stops asking (node.ts). */
const LEASE_MIN = Math.round(LEASE_MS / 60_000);

/** Why a machine's GPUs aren't known. */
export type UnknownGpus = "unchecked" | "no-llama" | "computer";

/**
 * The room the model needs against what the machines taking part have free. Needed: the model, its context (about
 * 96 KiB a token) and 1 GiB per machine taking part. `devicesOf` gives a machine's GPUs as last checked, or null
 * when they aren't known, and `why` says why (by default: a computer, whose memory Crosstalk can't see, or a hub that
 * wasn't checked yet).
 */
export function poolFit(
  config: Pick<PoolConfig, "model" | "contextSize" | "machines">,
  devicesOf: (m: PoolMachine) => PoolDevice[] | null,
  why: (m: PoolMachine) => UnknownGpus = (m) => (m.kind === "computer" ? "computer" : "unchecked"),
): PoolFit | null {
  const model = config.model;
  if (!model) return null;
  const base = model.sizeBytes / MiB + (config.contextSize * 96) / 1024;
  const need = (machines: number) => Math.ceil(base + 1024 * Math.max(1, machines));
  const taking = config.machines.filter((m) => m.enabled);
  const needMiB = need(taking.length);
  let have = 0;
  const unknown: PoolMachine[] = [];
  for (const m of taking) {
    const devices = devicesOf(m);
    if (devices === null) unknown.push(m);
    else have += devices.reduce((n, d) => n + Math.max(0, d.freeMiB), 0);
  }
  const haveMiB = Math.floor(have);
  const fits = haveMiB > 0 && needMiB <= haveMiB;
  // A model that fits one GPU (or one machine's GPUs) runs fastest there alone: pooling buys room, not speed.
  const one = need(1);
  const options: { m: PoolMachine; gpu: PoolDevice | null; free: number }[] = [];
  for (const m of config.machines) {
    const devices = devicesOf(m) ?? [];
    for (const gpu of devices) options.push({ m, gpu, free: gpu.freeMiB });
    if (devices.length > 1) options.push({ m, gpu: null, free: devices.reduce((n, d) => n + d.freeMiB, 0) });
  }
  const alone = options
    .filter((o) => o.free >= one)
    .sort((a, b) => Number(b.m.enabled) - Number(a.m.enabled) || Number(!a.gpu) - Number(!b.gpu) || b.free - a.free)[0];
  let note: string | null = null;
  if (alone && !(taking.length === 1 && taking[0].id === alone.m.id)) {
    note = `Fits ${alone.gpu ? `the ${gpuName(alone.gpu.description)}` : alone.m.name} alone: leave the others out to run it at full speed.`;
  } else if (!fits) {
    const of = (kind: UnknownGpus) => unknown.filter((m) => why(m) === kind);
    const [unchecked, noLlama, computers] = [of("unchecked"), of("no-llama"), of("computer")];
    if (unchecked.length) note = `Check the machines to count the GPU${unchecked.length === 1 ? "" : "s"} of ${names(unchecked)}.`;
    else if (noLlama.length) note = `The GPU${noLlama.length === 1 ? "" : "s"} of ${names(noLlama)} ${noLlama.length === 1 ? "is" : "are"} counted once llama.cpp is on ${noLlama.length === 1 ? "it" : "them"}: the pool installs it when it starts.`;
    else if (computers.length) note = `Crosstalk can't see the GPU memory of ${names(computers)}, so ${computers.length === 1 ? "it isn't" : "they aren't"} counted here.`;
    else if (haveMiB > 0) note = `Needs about ${sizeText(needMiB - haveMiB)} more: switch on another machine, or pick a smaller quant or context.`;
  }
  return { needMiB, haveMiB, fits, note };
}

/** What the main machine's server is doing while it loads, in plain words, from its newest output lines. */
export function loadingDetail(lines: string[], elapsedMs: number, where: string, helpers: boolean): string {
  let phase: string | null = null;
  for (let i = lines.length - 1; i >= 0 && !phase; i--) {
    const l = lines[i];
    const layers = /offloaded (\d+)\/(\d+) layers/i.exec(l);
    if (layers) phase = `${layers[1]} of ${layers[2]} layers placed`;
    else if (/model loaded|listening on|warming up|warmup/i.test(l)) phase = "almost ready";
    else if (/llama_context|kv[ _-]?cache|n_ctx/i.test(l)) phase = "setting up the context";
    else if (/load_tensors|loading model|load_model|model_loader/i.test(l)) phase = "reading the model";
  }
  const min = Math.floor(elapsedMs / 60_000);
  const slow = helpers && min >= 1 ? " The helpers get their part over the network, which takes a while the first time." : "";
  return `Loading the model on ${where}${phase ? `: ${phase}` : ""}${min >= 1 ? ` (${min} min so far)` : ""}.${slow}`;
}

/** Tokens per second from llama-server's /metrics (Prometheus text), each null until there's been a reply. */
export function parseMetrics(text: string): { prompt: number | null; generation: number | null } {
  const value = (name: string) => {
    const m = new RegExp(`^llamacpp:${name}(?:\\{[^}]*\\})?\\s+(\\S+)`, "m").exec(text);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
  };
  return { prompt: value("prompt_tokens_seconds"), generation: value("predicted_tokens_seconds") };
}

/** The backend a hub runs when none was picked: Metal on a Mac, else the one installed for the build, else Vulkan. */
export function autoBackend(info: Pick<PoolNodeInfo, "os" | "installed">, build: string): PoolBackend {
  if (info.os === "macos") return "metal";
  for (const b of ["cuda", "vulkan", "cpu"] as const) if (info.installed.includes(`${build}-${b}`)) return b;
  return "vulkan";
}

/**
 * Opens a TCP connection and closes it at once: a computer's helper answers. Short, and closed straight away, because
 * a helper serves one client at a time and an open connection would block it.
 */
export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.end();
          done(true);
        },
        data() {},
        error() {
          done(false);
        },
        connectError() {
          done(false);
        },
      },
    }).catch(() => done(false));
  });
}

const bad = (message: string) => new HttpError(400, message);

/** A problem that stops the pool: its words are the status's detail. `retry`: a machine that isn't up (yet). */
class Problem extends Error {
  constructor(
    message: string,
    readonly log?: string[],
    readonly retry = false,
  ) {
    super(message);
  }
}

/** The run was stopped (Stop, a new start, the hub shutting down). */
class Cancelled extends Error {
  constructor() {
    super("stopped");
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- Talking to the machines ----

type NodeKind = "install" | "helper" | "model" | "server";

/** A hub in the pool: this one (its PoolNodeRuntime) or a linked one (its /api/pool/node routes). */
interface NodeClient {
  /** What it is and does, asking Tailscale and llama.cpp when that's old (GET /api/pool/node). */
  info(q?: { refresh?: boolean; build?: string; backend?: PoolBackend }): Promise<PoolNodeInfo>;
  /** The same, as cheaply as it can be had (this hub: what it knows now), for polling. */
  poll(): Promise<PoolNodeInfo>;
  post(kind: NodeKind, body: unknown, timeoutMs?: number): Promise<PoolNodeInfo>;
  /** The GPUs helpers elsewhere lend, as llama.cpp there sees them (GET /api/pool/node/helpers). */
  helpers(build: string, backend: PoolBackend, addresses: string[]): Promise<HelperGpus[]>;
}

const helpersQuery = (build: string, backend: PoolBackend, addresses: string[]) => new URLSearchParams([["build", build], ["backend", backend], ...addresses.map((a): [string, string] => ["address", a])]);

interface LinkInfo {
  id: string;
  name: string;
  url: string;
  token: string;
  scope: "full" | "peer";
}

const peerOnly = (name: string) =>
  `This hub can only reach chats on ${name}: link ${name} from this hub (Settings → Machines, with a pairing code from ${name}) to use it in the pool.`;

/** A hub that's older or newer may leave fields out: the ones read here always exist. */
function normalizeInfo(x: unknown, name: string): PoolNodeInfo {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new HttpError(502, `${name} answered something Crosstalk can't read: update Crosstalk there, then try again.`);
  const i = x as Partial<PoolNodeInfo>;
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  const owner = (o: unknown): PoolOwner | null => {
    const v = (o && typeof o === "object" ? o : {}) as Partial<PoolOwner>;
    return typeof v.hub === "string" && typeof v.run === "string" ? { hub: v.hub, name: String(v.name ?? ""), run: v.run } : null;
  };
  return {
    hubId: String(i.hubId ?? ""),
    name: String(i.name ?? name),
    os: i.os === "macos" || i.os === "windows" ? i.os : "linux",
    arch: String(i.arch ?? ""),
    address: typeof i.address === "string" && isIPv4(i.address) ? i.address : null,
    installed: list(i.installed).filter((s): s is string => typeof s === "string"),
    busy: i.busy && typeof i.busy === "object" ? i.busy : null,
    devices: list(i.devices).filter((d) => d && typeof d.name === "string" && Number.isFinite(d.freeMiB)),
    helper: { running: !!i.helper?.running, port: i.helper?.port ?? null, detail: i.helper?.detail ?? null, owner: owner(i.helper?.owner) },
    server: { running: !!i.server?.running, port: i.server?.port ?? null, healthy: !!i.server?.healthy, detail: i.server?.detail ?? null, log: list(i.server?.log).map(String), owner: owner(i.server?.owner) },
    models: list(i.models).filter((s): s is string => typeof s === "string"),
    ...(Array.isArray(i.files) ? { files: i.files.filter((f) => f && typeof f.file === "string" && Number.isFinite(f.bytes)).map((f) => ({ file: f.file, bytes: f.bytes, partial: !!f.partial })) } : {}),
    freeDiskBytes: typeof i.freeDiskBytes === "number" ? i.freeDiskBytes : null,
    lastError: i.lastError && typeof i.lastError === "object" ? i.lastError : null,
  };
}

/**
 * A linked hub, through this hub's (full) sign-in there. Its problems come back in words that name it. Every question
 * says it's this hub's pool asking (?owner=), which keeps what the pool runs there going (node.ts LEASE_MS).
 */
function hubNode(app: App, link: LinkInfo): NodeClient {
  const host = (() => {
    try {
      return new URL(link.url).host;
    } catch {
      return link.url;
    }
  })();
  const call = async (method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<PoolNodeInfo> => {
    const info = normalizeInfo(await send(method, path, body, timeoutMs), link.name);
    if (info.name) app.machines.noteName(link.id, info.name);
    return info;
  };
  const send = async (method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<unknown> => {
    try {
      return await hubCall<unknown>(link.url, path, { method, token: link.token, body, timeoutMs, raw: true });
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(502, errText(e));
      const said = err.message.startsWith(`${host}: `) ? err.message.slice(host.length + 2) : err.message;
      if (err.status === 401) {
        app.machines.signedOut(link.id);
        throw new HttpError(401, `${link.name} no longer accepts this hub's sign-in: link it again in Settings → Machines, then try again.`, "signed_out");
      }
      if (err.code === "peer_scope") throw new HttpError(403, peerOnly(link.name), "peer_scope");
      if (err.status === 404 && /^not found$/i.test(said.trim())) throw new HttpError(404, `${link.name} runs an older Crosstalk without the model pool: update Crosstalk there, then try again.`, "old_hub");
      if (err.code === "unreachable") throw new HttpError(502, `${link.name} doesn't answer: check that it's on and connected to Tailscale, then try again.`, "unreachable");
      throw new HttpError(err.status, `${link.name}: ${said}`, err.code);
    }
  };
  const query = (q: { refresh?: boolean; build?: string; backend?: PoolBackend } = {}) => {
    const p = new URLSearchParams();
    if (q.refresh) p.set("refresh", "1");
    if (q.build && q.backend) {
      p.set("build", q.build);
      p.set("backend", q.backend);
    }
    p.set("owner", app.hubId());
    return `?${p.toString()}`;
  };
  return {
    info: (q) => call("GET", `/api/pool/node${query(q)}`, undefined, 45_000),
    poll: () => call("GET", `/api/pool/node${query()}`, undefined, 20_000),
    post: (kind, body, timeoutMs) => call("POST", `/api/pool/node/${kind}`, body, timeoutMs),
    helpers: async (build, backend, addresses) => {
      const out = (await send("GET", `/api/pool/node/helpers?${helpersQuery(build, backend, addresses)}`, undefined, 60_000)) as { helpers?: unknown };
      return Array.isArray(out?.helpers) ? (out.helpers as HelperGpus[]) : [];
    },
  };
}

// ---- A start, from asking the machines to the server answering ----

/** A machine taking part, as a start found it. */
interface Part {
  m: PoolMachine;
  /** null: a computer (it runs its helper itself). */
  node: NodeClient | null;
  backend: PoolBackend;
  /** Where the other machines reach it: its Tailscale IPv4 (127.0.0.1 in tests). */
  address: string | null;
}

/** Everything a start needs, fixed when it begins (settings saved meanwhile apply to the next start). */
interface Plan {
  build: string;
  model: PoolModel;
  main: Part & { node: NodeClient };
  /** The helpers, in the order llama.cpp names their devices RPC0, RPC1… */
  helpers: Part[];
  rpc: string[];
  /** null: every GPU (the main machine's too); "helpers": only the helpers' (the main machine's GPU left out). */
  devices: null | "helpers";
  host: string;
  port: number;
  alias: string;
  contextSize: number;
  baseUrl: string;
}

class Run {
  /** Which start this is: what it runs on the hubs says so (their owner). */
  readonly id = newId("r");
  readonly ctrl = new AbortController();
  plan: Plan | null = null;
  /** What this run started, so a stop or a failure ends it (computers' helpers aren't Crosstalk's to end). */
  started = { server: false, download: false, helpers: new Set<string>() };
  /** It started the server again once after it (or a helper) stopped on its own. */
  restarted = false;
  /** What it started has been (or is being) ended: nothing of it is left to stop. */
  halted = false;
  /** "Start when the hub starts" began it, and it hasn't run yet: a machine that isn't up yet is tried again. */
  auto = false;
  /** Resolves when the start (or the restart) has finished: running, failed or stopped. */
  settled: Promise<void> = Promise.resolve();
  /** A start or a restart is on its way (its requests may still start something after a stop). */
  busy = false;
  timer: ReturnType<typeof setTimeout> | null = null;
  /** Keeps telling the hubs it uses that it still needs what they run for it. */
  beat: ReturnType<typeof setInterval> | null = null;
  get cancelled() {
    return this.ctrl.signal.aborted;
  }
  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    this.ctrl.abort();
  }
}

/** Waits, unless the run is stopped first. */
function pause(ms: number, run: Run): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = run.ctrl.signal;
    if (signal.aborted) return reject(new Cancelled());
    const onAbort = () => {
      clearTimeout(t);
      reject(new Cancelled());
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bytes per second over the last few seconds. */
class Rate {
  private samples: [number, number][] = [];
  add(done: number): number | null {
    const now = Date.now();
    this.samples.push([now, done]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 5000) this.samples.shift();
    const [t0, d0] = this.samples[0];
    return now - t0 >= 900 ? Math.max(0, Math.round(((done - d0) * 1000) / (now - t0))) : null;
  }
}

const progress = (what: string, busy: PoolNodeInfo["busy"]) =>
  busy?.totalBytes ? `${what}: ${Math.min(99, Math.floor(((busy.doneBytes ?? 0) / busy.totalBytes) * 100))}%` : `${what}…`;

const modelLabel = (m: PoolModel) => `${modelName(m.repo)}${m.quant ? ` (${m.quant})` : ""}`;

/** A model's own name from its repo: "unsloth/Qwen3.8-27B-GGUF" is "Qwen3.8-27B" (web/src/pool.ts shows the same). */
function modelName(repo: string): string {
  const name = (repo.split("/").pop() ?? repo).replace(/[-_.]?gguf$/i, "");
  // bartowski's "org_Model": the model's own name.
  const unprefixed = /^[a-z0-9-]+_(.{3,})$/.exec(name);
  return (unprefixed ? unprefixed[1] : name) || repo;
}

/** The model pool set up on this hub (app.pool). */
export class Pool {
  private status: PoolStatus;
  private states = new Map<string, PoolMachineState>();
  /** What each hub in the pool last said about itself. */
  private infos = new Map<string, PoolNodeInfo>();
  private run: Run | null = null;
  /** Ending what a failed start left running: the next start waits for it. */
  private cleaning: Promise<void> = Promise.resolve();
  private checking: Promise<PoolView> | null = null;
  private stopping: Promise<PoolView> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmit = 0;
  /** The offer as it last went out, so an unchanged one isn't sent again (emitNow). */
  private lastOffer = "";
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** "Start when the hub starts" tries until then, and how many times it tried. */
  private resumeUntil = 0;
  private resumeTries = 0;
  private closed = false;
  /** How long after the server (or a helper) stopped on its own it's started again (once). */
  restartDelayMs = 10_000;
  /** How often a running pool's server is looked at (this hub / a linked hub as the main machine). */
  watchMs = { self: 5000, hub: 10_000 };
  /** How often a running pool asks Tailscale whether its computers are still there. */
  pingMs = 30_000;
  /** How often a start tells the hubs it uses that it still needs what they run for it (well within node.ts LEASE_MS). */
  beatMs = 60_000;
  /** The first wait before "Start when the hub starts" tries again (then twice as long each time, up to a minute). */
  resumeDelayMs = 10_000;
  /** How often the speed is read while it runs. */
  metricsMs = 15_000;
  /** How long a start waits for the model to load (over the network it's slow). */
  healthTimeoutMs = 45 * 60_000;
  installTimeoutMs = 20 * 60_000;
  /** How a computer's helper is checked (tests may replace it, so nothing connects to a real Tailscale address). */
  probe: (host: string, port: number) => Promise<boolean> = (host, port) => tcpProbe(host, port);

  constructor(private app: App) {
    this.status = { state: "off", detail: null, download: null, endpoint: null, accounts: this.accountIds(), startedAt: null, speed: null, log: [] };
    try {
      const saved = JSON.parse(app.store.kvGet("pool.states") ?? "[]") as PoolMachineState[];
      for (const s of Array.isArray(saved) ? saved : []) {
        if (!s || typeof s.id !== "string") continue;
        // What a machine was doing went with the hub that asked it.
        const state = s.state === "installing" || s.state === "running" ? "unknown" : s.state;
        this.states.set(s.id, { id: s.id, devices: Array.isArray(s.devices) ? s.devices : [], link: s.link ?? null, state, detail: state === "unknown" ? null : (s.detail ?? null), checkedAt: Number(s.checkedAt) || 0 });
      }
    } catch {
      // unreadable: checked again
    }
  }

  // ---- What the pool keeps between runs of the hub ----

  private kvJson<T extends object>(key: string): T {
    try {
      const v = JSON.parse(this.app.store.kvGet(key) ?? "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : ({} as T);
    } catch {
      return {} as T;
    }
  }

  /** Each hub's Tailscale address as it last said (kv pool.addresses), so it's known before it's asked again. */
  private addresses(): Record<string, string> {
    return this.kvJson<Record<string, string>>("pool.addresses");
  }

  /**
   * What a start ran on linked hubs and nothing has ended yet (kv pool.left): a hub that stopped without ending it (a
   * crash, a power cut) ends it when it's back. This hub's own are ended by node.ts.
   */
  private leftovers(): Record<string, ("server" | "helper")[]> {
    return this.kvJson<Record<string, ("server" | "helper")[]>>("pool.left");
  }

  private noteLeft(id: string, role: "server" | "helper", running: boolean) {
    if (id === "self") return;
    const left = this.leftovers();
    const roles = new Set((Array.isArray(left[id]) ? left[id] : []).filter((r) => r === "server" || r === "helper"));
    if (running) roles.add(role);
    else roles.delete(role);
    if (roles.size) left[id] = [...roles];
    else delete left[id];
    this.app.store.kvSet("pool.left", JSON.stringify(left));
  }

  /** What a start says it is, to the hubs it runs things on. */
  private owner(run: Run | null): PoolOwner {
    return { hub: this.app.hubId(), name: this.app.machineName(), run: run?.id ?? "leftovers" };
  }

  // ---- Settings ----

  private saved(): Partial<PoolConfig> {
    try {
      const v = JSON.parse(this.app.store.kvGet("pool") ?? "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  /** The linked hubs, with the kind of sign-in this hub has there (only a full one can run things there). */
  private links(): LinkInfo[] {
    const scopes = new Map(this.app.machines.list().map((m) => [m.id, m.scope === "peer" ? ("peer" as const) : ("full" as const)]));
    return this.app.machines
      .linked()
      .filter((l) => l.agents !== "removing")
      .map((l) => ({ id: l.id, name: l.name, url: l.url, token: l.token, scope: scopes.get(l.id) ?? "full" }));
  }

  /**
   * The pool's settings, with this hub and every linked hub in the machine list (hubs come and go: a hub that was
   * unlinked leaves it, a new one joins it switched on). This Mac is left out by default.
   */
  config(): PoolConfig {
    const s = this.saved();
    const links = this.links();
    const savedMachines = Array.isArray(s.machines) ? s.machines : [];
    const selfSaved = savedMachines.find((m) => m?.id === "self");
    const self: PoolMachine = {
      id: "self",
      kind: "self",
      name: this.app.machineName(),
      address: this.infos.get("self")?.address ?? this.addresses().self ?? null,
      os: hostPlatform().os,
      backend: selfSaved?.backend && POOL_BACKENDS.includes(selfSaved.backend) ? selfSaved.backend : null,
      enabled: typeof selfSaved?.enabled === "boolean" ? selfSaved.enabled : !this.selfLeftOut(),
      rpcPort: validPort(selfSaved?.rpcPort) ? selfSaved!.rpcPort : RPC_PORT,
    };
    const machines: PoolMachine[] = [];
    for (const m of savedMachines) {
      if (!m || typeof m !== "object") continue;
      if (m.id === "self") machines.push(self);
      else if (m.kind === "hub") {
        const link = links.find((l) => l.id === m.id);
        if (link) machines.push(this.hubMachine(link, m));
      } else if (m.kind === "computer" && typeof m.id === "string") machines.push(m);
    }
    if (!machines.some((m) => m.id === "self")) machines.unshift(self);
    for (const l of links) if (!machines.some((m) => m.id === l.id)) machines.push(this.hubMachine(l, null));
    const usable = (id: unknown) => id === "self" || links.some((l) => l.id === id && l.scope === "full");
    const mainId = usable(s.mainId) ? (s.mainId as string) : (links.find((l) => l.scope === "full")?.id ?? "self");
    let model: PoolModel | null = null;
    try {
      model = s.model ? checkModel(s.model) : null;
    } catch {
      model = null;
    }
    return {
      build: typeof s.build === "string" && BUILD_RE.test(s.build) ? s.build : POOL_BUILD,
      machines,
      mainId,
      model,
      contextSize: validContext(s.contextSize) ? s.contextSize! : DEFAULT_CONTEXT,
      alias: (typeof s.alias === "string" && ALIAS_RE.test(s.alias) ? s.alias : "") || aliasFor(model),
      port: validPort(s.port) ? s.port! : POOL_PORT,
      autostart: s.autostart === true,
    };
  }

  /** A Mac that runs the hub's chats lends its GPU only when asked: it's the slowest, and Metal memory can't be swapped. */
  private selfLeftOut() {
    return process.platform === "darwin";
  }

  private hubMachine(link: LinkInfo, saved: Partial<PoolMachine> | null): PoolMachine {
    const info = this.infos.get(link.id);
    return {
      id: link.id,
      kind: "hub",
      name: link.name,
      address: info?.address ?? this.addresses()[link.id] ?? null,
      os: info?.os ?? (saved?.os === "macos" || saved?.os === "linux" || saved?.os === "windows" ? saved.os : null),
      backend: saved?.backend && POOL_BACKENDS.includes(saved.backend) ? saved.backend : null,
      // A hub this hub only has an agents' sign-in on can't run anything for the pool; one where llama.cpp found no GPU
      // would only lend its CPU.
      enabled: typeof saved?.enabled === "boolean" ? saved.enabled : link.scope === "full" && !this.noGpu(link.id),
      rpcPort: validPort(saved?.rpcPort) ? saved!.rpcPort! : RPC_PORT,
    };
  }

  /** llama.cpp is on that hub and found no GPU there when it was last checked. */
  private noGpu(id: string): boolean {
    const st = this.states.get(id);
    return !!this.infos.get(id)?.installed.length && !!st?.checkedAt && !st.devices.length;
  }

  /** PUT /api/pool: every field given is checked; `machines` replaces the list as a whole. */
  update(input: unknown): PoolView {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Send the changes as { config: { … } }.");
    const c = input as Record<string, unknown>;
    const links = this.links();
    const cur = this.config();
    const next: Partial<PoolConfig> = { ...this.saved() };
    if ("build" in c) {
      const build = checkBuild(c.build);
      if (Number(build.slice(1)) < OLDEST_SAFE_HELPER_BUILD) throw bad(`llama.cpp ${build} is too old for the pool (its helpers can be taken over): pick b${OLDEST_SAFE_HELPER_BUILD} or newer.`);
      next.build = build;
    }
    if ("machines" in c) next.machines = parseMachines(c.machines, links);
    if ("mainId" in c) {
      const id = c.mainId;
      if (id !== "self") {
        const link = typeof id === "string" ? links.find((l) => l.id === id) : undefined;
        if (typeof id === "string" && COMPUTER_ID.test(id)) throw bad("A computer can't be the main machine: the main machine needs Crosstalk to hold the model and run the server. Pick this hub or a linked one.");
        if (!link) throw bad("The main machine is this hub or a linked hub: link it in Settings → Machines first.");
        if (link.scope !== "full") throw bad(peerOnly(link.name));
      }
      next.mainId = id as string;
    }
    if ("model" in c) {
      next.model = c.model === null ? null : checkModel(c.model);
      // A name that came from the old model follows the new one.
      if (!("alias" in c) && (!next.alias || next.alias === aliasFor(cur.model))) next.alias = "";
    }
    if ("contextSize" in c) {
      if (!validContext(c.contextSize)) throw bad(`Pick a context size from ${MIN_CONTEXT.toLocaleString("en-US")} to ${MAX_CONTEXT.toLocaleString("en-US")} tokens.`);
      next.contextSize = c.contextSize as number;
    }
    if ("alias" in c) {
      if (c.alias !== "" && (typeof c.alias !== "string" || !ALIAS_RE.test(c.alias))) throw bad("Name the model with up to 64 letters, digits, dots, dashes, colons or underscores, without spaces.");
      next.alias = c.alias as string;
    }
    if ("port" in c) {
      const port = checkPort(c.port, "server port");
      if (port === this.app.config.port) throw bad(`Port ${port} is this hub's own: pick another one for the model server.`);
      next.port = port;
    }
    if ("autostart" in c) {
      if (typeof c.autostart !== "boolean") throw bad("Say whether the pool starts with the hub (true or false).");
      next.autostart = c.autostart;
    }
    this.app.store.kvSet("pool", JSON.stringify(next));
    this.emitNow();
    return this.view();
  }

  /** PUT /api/pool/hf-token `{ token }`: saved in this hub's secrets (never shown again); null or "" removes it. */
  setHfToken(body: unknown): { hasHfToken: boolean } {
    if (!body || typeof body !== "object" || Array.isArray(body) || !("token" in body)) throw bad("Send the token as { token: \"hf_…\" }, or { token: null } to remove it.");
    const input = (body as { token: unknown }).token;
    if (input === null || input === "") writeSecret(HF_SECRET, null);
    else {
      const token = typeof input === "string" ? input.trim() : "";
      if (!HF_TOKEN.test(token)) throw bad("That doesn't look like a Hugging Face token: copy it again from huggingface.co/settings/tokens.");
      writeSecret(HF_SECRET, token);
    }
    const hasHfToken = this.hasHfToken();
    this.emitNow();
    return { hasHfToken };
  }

  private hasHfToken() {
    return !!readSecrets()[HF_SECRET];
  }

  /** The server's API key: made once, kept in this hub's secrets. */
  private apiKey(): string {
    const saved = readSecrets()[KEY_SECRET];
    if (saved && /^[\x21-\x2b\x2d-\x7e]{16,256}$/.test(saved)) return saved;
    const key = `ctpool-${secretToken()}`;
    writeSecret(KEY_SECRET, key);
    return key;
  }

  /** Whether a member runs on the pool's server (one of its custom-model accounts). */
  servesMember(m: { provider: Provider; config?: Record<string, unknown> }): boolean {
    const id = this.accountIds()[m.provider];
    return !!id && memberAccount(m) === id;
  }

  private accountIds(): Partial<Record<Provider, string>> {
    try {
      const ids = JSON.parse(this.app.store.kvGet("pool.accounts") ?? "{}") as Partial<Record<Provider, string>>;
      const out: Partial<Record<Provider, string>> = {};
      for (const p of PROVIDERS) if (typeof ids[p] === "string" && this.app.providers.endpointOf(p, ids[p]!)) out[p] = ids[p];
      return out;
    } catch {
      return {};
    }
  }

  // ---- The view and its events ----

  /** Everything the Model pool screen shows (GET /api/pool and the "pool" event). */
  view(): PoolView {
    const config = this.config();
    return {
      config,
      machines: config.machines.map((m) => this.machineState(m)),
      status: { ...this.status, accounts: { ...this.status.accounts }, log: [...this.status.log] },
      fit: poolFit(
        config,
        (m) => this.devicesOf(m),
        (m) => (m.kind === "computer" ? "computer" : this.infos.get(m.id) && !this.infos.get(m.id)!.installed.length ? "no-llama" : "unchecked"),
      ),
      hasHfToken: this.hasHfToken(),
      mainFiles: this.infos.get(config.mainId)?.files ?? null,
    };
  }

  /**
   * The pool as one model to chat with (`PoolOffer`), for the state snapshot and the "poolOffer" event: what it's
   * called, what state it's in, the model it runs, the machines it runs on, and its accounts. Everywhere a chat starts
   * reads this, so a pool that has never run is still one entry that says what to do next.
   */
  chatOffer(): PoolOffer {
    const config = this.config();
    const taking = config.machines.filter((m) => m.enabled || m.id === config.mainId);
    const main = taking.find((m) => m.id === config.mainId);
    // The main machine first: it holds the model and answers the chats.
    const machines = [...(main ? [main] : []), ...taking.filter((m) => m.id !== config.mainId)];
    // A machine the pool needs that didn't answer when it was last checked (a PC with its helper window closed, a hub
    // that's off). Never one that was never checked: nothing is known about it yet.
    const missing = machines.filter((m) => {
      const st = this.states.get(m.id);
      return !!st?.checkedAt && (st.state === "offline" || st.state === "error");
    });
    return {
      label: ACCOUNT_LABEL,
      state: this.status.state,
      detail: this.status.detail,
      // A model and a machine to run it on: without either, Settings → Model pool is where to go.
      setUp: !!config.model && !!main,
      ready: this.status.state === "running" && !!this.status.endpoint,
      model: this.status.endpoint?.model || config.alias || aliasFor(config.model) || null,
      modelName: config.model ? modelName(config.model.repo) : null,
      machines: machines.map((m) => m.name || this.app.machineName()),
      missing: missing.map((m) => m.name || this.app.machineName()),
      accounts: this.accountIds(),
    };
  }

  /**
   * Why a chat on the pool can't be answered right now, in plain words with a way out: the engine refuses a reply with
   * it before the agent starts (as a used-up spending limit does), and a reply the pool died under ends with it instead
   * of the agent's own "connection refused". Null while the pool runs, and for a chat that isn't on the pool.
   */
  chatProblem(m: { provider: Provider; config?: Record<string, unknown> }): string | null {
    if (!this.servesMember(m) || this.status.state === "running") return null;
    const model = this.chatOffer().model;
    const what = model ? `${ACCOUNT_LABEL} (${model})` : ACCOUNT_LABEL;
    // Not "pick another model": a pool chat's model menu holds the pool's one model (that's the point of a pool), so
    // the other way out is the chat's own Account, in its settings (web/src/poolChat.ts poolModelNote says the same).
    const out = "Start it again in Settings → Model pool, or move this chat to another account in its settings.";
    if (ACTIVE.includes(this.status.state)) return `${what} is still starting. ${this.status.detail ?? ""} Send this again once it says Running in Settings → Model pool.`.replace(/\s+/g, " ");
    // The pool's own words say what went wrong and what to do about that; this adds the chat's own way out.
    if (this.status.state === "error") return `${what} stopped. ${this.status.detail ?? ""} ${out}`.replace(/\s+/g, " ").trim();
    return `${what} isn't running, so this chat has no model to answer with. ${out}`;
  }

  private machineState(m: PoolMachine): PoolMachineState {
    const st = this.states.get(m.id) ?? { id: m.id, devices: [], link: null, state: "unknown" as const, detail: null, checkedAt: 0 };
    // A Mac left out says why, in one line (what installing llama.cpp there would do doesn't matter while it's out).
    if (m.kind === "self" && !m.enabled && this.selfLeftOut() && (st.state === "unknown" || st.state === "ready")) {
      return { ...st, devices: [...st.devices], detail: "Left out: slowest GPU, and it runs your chats. Switch it on to lend it too." };
    }
    if (m.kind === "hub" && !st.detail && st.state === "unknown") {
      const link = this.links().find((l) => l.id === m.id);
      if (link?.scope === "peer") return { ...st, state: "error", detail: peerOnly(link.name) };
    }
    return { ...st, devices: [...st.devices] };
  }

  /** A machine's GPUs as last checked; null when they aren't known (never checked, no llama.cpp there yet, a computer). */
  private devicesOf(m: PoolMachine): PoolDevice[] | null {
    // A computer's, once the main machine's llama.cpp has listed them (learnComputerGpus).
    if (m.kind === "computer") return this.states.get(m.id)?.devices.length ? this.states.get(m.id)!.devices : null;
    const info = this.infos.get(m.id);
    if (info && !info.installed.length) return null;
    const st = this.states.get(m.id);
    return st?.checkedAt ? st.devices : null;
  }

  private setMachine(id: string, change: Partial<Omit<PoolMachineState, "id">>) {
    const cur = this.states.get(id) ?? { id, devices: [], link: null, state: "unknown" as const, detail: null, checkedAt: 0 };
    this.states.set(id, { ...cur, ...change, id });
    this.emitSoon();
  }

  private saveStates() {
    const ids = new Set(this.config().machines.map((m) => m.id));
    this.app.store.kvSet("pool.states", JSON.stringify([...this.states.values()].filter((s) => ids.has(s.id))));
  }

  /** What a hub said about itself: its address, GPUs and when. */
  private noteInfo(m: PoolMachine, info: PoolNodeInfo) {
    this.infos.set(m.id, info);
    const cur = this.states.get(m.id);
    this.states.set(m.id, { id: m.id, devices: info.devices, link: cur?.link ?? null, state: cur?.state ?? "unknown", detail: cur?.detail ?? null, checkedAt: Date.now() });
    const addresses = this.addresses();
    if (info.address && addresses[m.id] !== info.address) {
      addresses[m.id] = info.address;
      this.app.store.kvSet("pool.addresses", JSON.stringify(addresses));
    }
  }

  /** The machines linked with this hub changed (machines.ts): the list here follows. */
  linksChanged() {
    this.emitSoon();
  }

  private setStatus(change: Partial<PoolStatus>, soon = false) {
    this.status = { ...this.status, ...change };
    if (soon) this.emitSoon();
    else this.emitNow();
  }

  private emitNow() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (this.closed) return;
    this.lastEmit = Date.now();
    try {
      this.app.bus.emit({ t: "pool", pool: this.view() });
      // The offer goes out only when it actually changed: every screen that starts a chat follows it, and a download's
      // progress (twice a second) changes nothing about it.
      const offer = JSON.stringify(this.chatOffer());
      if (offer !== this.lastOffer) {
        this.lastOffer = offer;
        this.app.bus.emit({ t: "poolOffer", offer: JSON.parse(offer) as PoolOffer });
      }
    } catch (e) {
      // Called from timers too: never thrown out of one (a store that was closed, say).
      log.warn(`couldn't send the pool's view: ${message(e)}`);
    }
  }

  /** Progress (a download, the server's output) goes out at most twice a second. */
  private emitSoon() {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => this.emitNow(), Math.max(0, 500 - (Date.now() - this.lastEmit)));
  }

  // ---- The machines ----

  private nodeFor(m: PoolMachine): NodeClient {
    if (m.kind === "self") return this.selfNode;
    if (m.kind !== "hub") throw new HttpError(400, `${m.name} runs its helper itself: there's nothing Crosstalk can ask it.`);
    const link = this.links().find((l) => l.id === m.id);
    if (!link) throw new HttpError(404, `${m.name} isn't linked with this hub any more: link it again in Settings → Machines.`);
    if (link.scope !== "full") throw new HttpError(403, peerOnly(link.name), "peer_scope");
    return hubNode(this.app, link);
  }

  /** This hub, asked directly. Its problems name it, like a linked hub's. */
  private readonly selfNode: NodeClient = {
    info: (q) => this.selfCall(() => this.app.poolNode.info(q ?? {})),
    poll: async () => this.app.poolNode.snapshot(),
    post: (kind, body) => this.selfCall(() => this.app.poolNode.handle(kind, body)),
    helpers: async (build, backend, addresses) => (await this.selfCall(() => this.app.poolNode.helperGpus(helpersQuery(build, backend, addresses)))).helpers,
  };

  private async selfCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, errText(e));
      throw new HttpError(err.status, `${this.app.machineName()}: ${err.message}`, err.code);
    }
  }

  /**
   * POST /api/pool/check: every machine's state and GPUs, and the round trip from this hub over Tailscale. A
   * computer's helper is checked with a connection that closes at once, but not while the pool's server uses it.
   */
  check(): Promise<PoolView> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const config = this.config();
      const inUse = new Set(ACTIVE.includes(this.status.state) ? (this.run?.plan?.helpers.map((p) => p.m.id) ?? []) : []);
      await Promise.all(config.machines.map((m) => this.checkMachine(m, config, inUse.has(m.id)).catch((e) => log.warn(`checking ${m.name}: ${message(e)}`))));
      // A PC's helper serves one client at a time: its GPUs are only asked about while the pool is off.
      if (!ACTIVE.includes(this.status.state)) await this.learnComputerGpus(config).catch((e) => log.warn(`asking the PCs' helpers about their GPUs: ${message(e)}`));
      this.saveStates();
      this.emitNow();
      return this.view();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkMachine(m: PoolMachine, config: PoolConfig, inUse: boolean) {
    if (m.kind === "computer") return this.checkComputer(m, inUse);
    let info: PoolNodeInfo;
    try {
      const node = this.nodeFor(m);
      info = await node.info({ refresh: true });
      // The GPUs as the pool's own build sees them, when it's installed there.
      const backend = m.backend ?? autoBackend(info, config.build);
      if (info.installed.includes(`${config.build}-${backend}`)) info = await node.info({ build: config.build, backend });
      info = await this.endStale(m, node, info);
    } catch (e) {
      const err = e as HttpError;
      // No answer: an old round trip would read as if it still answered.
      this.setMachine(m.id, { state: err.code === "unreachable" ? "offline" : "error", detail: message(e), link: null, checkedAt: Date.now() });
      return;
    }
    this.noteInfo(m, info);
    const link = m.kind === "self" || !info.address ? null : await tailscalePing(info.address);
    this.setMachine(m.id, { ...describeNode(info, m, config, this.app.hubId()), link, devices: info.devices, checkedAt: Date.now() });
  }

  /**
   * A helper or server this pool started on a hub that no start of it uses now (one a stop couldn't reach then, or
   * that a crash left behind): ended, so nothing keeps a GPU busy for nothing.
   */
  private async endStale(m: PoolMachine, node: NodeClient, info: PoolNodeInfo): Promise<PoolNodeInfo> {
    const me = this.app.hubId();
    const current = this.run && !this.run.halted ? this.run.id : null;
    const stale = (o: PoolOwner | null | undefined) => !!o && o.hub === me && o.run !== current;
    const roles = [info.server.running && stale(info.server.owner) ? "server" : null, info.helper.running && stale(info.helper.owner) ? "helper" : null].filter((r): r is "server" | "helper" => !!r);
    for (const role of roles) {
      info = await node.post(role, { action: "stop", owner: this.owner(null) }, 20_000);
      this.noteLeft(m.id, role, false);
      log.info(`ended the ${role === "server" ? "model server" : "helper"} an earlier start of the pool left on ${m.name}`);
    }
    return info;
  }

  /**
   * The GPUs a PC's helper lends, as the main machine's llama.cpp lists them (`--rpc … --list-devices`). Crosstalk
   * can't ask the PC itself, so this is how the fit counts its memory. Only helpers that answered the check, and only
   * once llama.cpp is on the main machine.
   */
  private async learnComputerGpus(config: PoolConfig) {
    const main = config.machines.find((m) => m.id === config.mainId);
    if (!main || main.kind === "computer") return;
    const info = this.infos.get(main.id);
    const backend = main.backend ?? (info ? autoBackend(info, config.build) : null);
    if (!info || !backend || !info.installed.includes(`${config.build}-${backend}`)) return;
    const pcs = config.machines.filter((m) => m.kind === "computer" && m.address && this.states.get(m.id)?.state === "ready");
    if (!pcs.length) return;
    const where = (m: PoolMachine) => `${m.address}:${m.rpcPort}`;
    const found = await this.nodeFor(main).helpers(config.build, backend, pcs.map(where));
    for (const m of pcs) {
      const got = found.find((h) => h.address === where(m));
      // llama.cpp names a helper's GPUs by its address, not their model: say whose they are.
      if (got?.devices.length) this.setMachine(m.id, { devices: got.devices.map((d) => ({ ...d, description: `GPU of ${m.name}` })), checkedAt: Date.now() });
      else if (got?.error) log.info(`couldn't list the GPUs of ${m.name}: ${got.error}`);
    }
  }

  private async checkComputer(m: PoolMachine, inUse: boolean) {
    const address = m.address;
    const link: TailscaleLink | null = address && isTailscaleIPv4(address) ? await tailscalePing(address) : null;
    const where = `${address}:${m.rpcPort}`;
    if (!address) return this.setMachine(m.id, { state: "error", detail: "Add its Tailscale address: tap Helper command.", link: null, checkedAt: Date.now() });
    // The pool's server is connected to it: a check would get in its way.
    if (inUse) return this.setMachine(m.id, { state: "running", detail: "Lending its GPU to the pool.", link, checkedAt: Date.now() });
    if (await this.probe(address, m.rpcPort)) return this.setMachine(m.id, { state: "ready", detail: `Its helper answers at ${where}.`, link, checkedAt: Date.now() });
    const unreachable = link !== null && link.ms === null;
    this.setMachine(m.id, {
      state: "offline",
      detail: unreachable
        ? `${m.name} doesn't answer over Tailscale: turn it on and open Tailscale there, then check again.`
        : `Its helper doesn't answer at ${where}: run its helper command there (Helper command), then check again.`,
      link,
      checkedAt: Date.now(),
    });
  }

  // ---- Starting and stopping ----

  /**
   * POST /api/pool/start: starts in the background (progress follows as "pool" events). `auto`: "Start when the hub
   * starts" (a machine that isn't up yet is tried again for a while).
   */
  start(opts: { auto?: boolean } = {}): PoolView {
    if (this.closed) throw new HttpError(503, "The hub is shutting down: start the pool once it's back.");
    if (this.stopping) throw new HttpError(409, "The pool is stopping: wait a moment, then start it again.");
    if (this.run && ACTIVE.includes(this.status.state)) return this.view();
    // A person's start takes over from the hub's own tries.
    if (!opts.auto && this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const prev = this.run;
    if (prev) {
      prev.cancel();
      // A start that stopped on a problem without ending what it runs (a server waiting to be started again, a main
      // machine that stopped answering): it's ended before this one begins.
      if (!prev.halted) {
        prev.halted = true;
        const before = this.cleaning;
        this.cleaning = before.then(() => this.halt(prev)).then(
          () => {},
          () => {},
        );
      }
    }
    const run = new Run();
    run.auto = !!opts.auto;
    this.run = run;
    this.setStatus({ state: "preparing", detail: "Asking the machines…", download: null, endpoint: null, speed: null, startedAt: null, log: [] });
    run.busy = true;
    run.settled = this.runStart(run).finally(() => {
      run.busy = false;
    });
    return this.view();
  }

  private alive(run: Run) {
    if (run.cancelled || this.run !== run || this.closed) throw new Cancelled();
  }

  private async runStart(run: Run): Promise<void> {
    try {
      // What a failed start (or a crash) left running is ended first.
      await this.cleaning;
      this.alive(run);
      const plan = await this.prepare(run);
      run.plan = plan;
      this.keepAlive(run);
      await this.installAll(run, plan);
      // Computers before a download that may take hours: a helper that isn't running is said at once.
      await this.checkComputers(run, plan);
      await this.ensureModel(run, plan);
      // The hubs lend their GPUs once the model is there (not for the length of a download).
      await this.startHelpers(run, plan);
      await this.serve(run, plan);
    } catch (e) {
      if (e instanceof Cancelled || run.cancelled || this.run !== run) return;
      this.failed(run, e);
    }
  }

  /**
   * A start (or a restart) that went wrong: what it started is ended, and the detail says what to do. Started by the
   * hub itself, a machine that isn't up yet (after a power cut, say) is tried again for a while.
   */
  private failed(run: Run, e: unknown) {
    let detail = message(e);
    log.warn(`model pool: ${detail}`);
    const retry = run.auto && e instanceof Problem && e.retry && Date.now() < this.resumeUntil && !this.closed;
    let wait = 0;
    if (retry) {
      wait = Math.min(60_000, this.resumeDelayMs * 2 ** this.resumeTries++);
      detail = `${detail} Crosstalk tries again ${waitText(wait)}: the machines may still be starting.`;
    }
    this.setStatus({ state: "error", detail, download: null, endpoint: null, speed: null, startedAt: null, ...(e instanceof Problem && e.log ? { log: e.log.slice(-LOG_LINES) } : {}) });
    // What the hub itself started keeps "it was running" (the next hub start tries again); a person's start doesn't.
    if (!run.auto) this.app.store.kvSet("pool.wasRunning", "0");
    run.halted = true;
    const before = this.cleaning;
    this.cleaning = before.then(() => this.halt(run)).then(
      () => {},
      () => {},
    );
    if (retry) {
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        if (this.closed || this.stopping || this.run !== run || this.status.state !== "error") return;
        log.info("starting the model pool again: a machine wasn't up yet");
        try {
          this.start({ auto: true });
        } catch (err) {
          log.warn(`couldn't start the model pool again: ${message(err)}`);
        }
      }, wait);
    }
  }

  /** The hubs this start runs something on hear from it every minute (their lease on it, node.ts). */
  private keepAlive(run: Run) {
    if (run.beat) clearInterval(run.beat);
    run.beat = setInterval(() => {
      const plan = run.plan;
      if (run.cancelled || this.run !== run || !plan) return;
      const parts = [plan.main, ...plan.helpers].filter((p) => p.m.kind === "hub" && (p === plan.main ? run.started.server || run.started.download : run.started.helpers.has(p.m.id)));
      for (const p of parts) void p.node!.poll().catch(() => {});
    }, this.beatMs);
    (run.beat as { unref?: () => void }).unref?.();
  }

  /** Checks what a start needs and asks the hubs taking part about themselves. */
  private async prepare(run: Run): Promise<Plan> {
    const config = this.config();
    const model = config.model;
    if (!model) throw new Problem("Choose a model first (Model → Choose a model), then start the pool.");
    const mainM = config.machines.find((m) => m.id === config.mainId)!;
    const helperMs = config.machines.filter((m) => m.enabled && m.id !== mainM.id);
    if (!mainM.enabled && !helperMs.length) throw new Problem("No GPU takes part yet: switch on at least one machine under Machines in the pool, then start again.");
    const made = this.commands();
    for (const m of helperMs) {
      if (m.kind !== "computer") continue;
      if (!m.address) throw new Problem(`${m.name} has no Tailscale address yet: add it with Helper command, then start again.`);
      const cmd = made[m.id];
      if (cmd && cmd.build !== config.build) {
        throw new Problem(`${m.name}'s helper command is for llama.cpp ${cmd.build}, but the pool now uses ${config.build}: run its new helper command there (Helper command), then start again.`);
      }
    }
    const parts = await Promise.all(
      [mainM, ...helperMs].map(async (m): Promise<Part> => {
        if (m.kind === "computer") return { m, node: null, backend: m.backend ?? defaultBackend(m.os ?? "windows"), address: m.address };
        let node: NodeClient;
        let info: PoolNodeInfo;
        try {
          node = this.nodeFor(m);
          info = await node.info();
        } catch (e) {
          const away = (e as HttpError).code === "unreachable";
          this.setMachine(m.id, { state: away ? "offline" : "error", detail: message(e), ...(away ? { link: null } : {}) });
          throw new Problem(message(e), undefined, away);
        }
        this.alive(run);
        this.noteInfo(m, info);
        const backend = m.backend ?? autoBackend(info, config.build);
        try {
          assetsFor(config.build, info.os, info.arch, backend);
        } catch (e) {
          this.setMachine(m.id, { state: "error", detail: message(e) });
          throw new Problem(`${m.name}: ${message(e)}`);
        }
        const address = loopback() ? "127.0.0.1" : info.address;
        // Helpers listen on their Tailscale address; so does a main machine other than this hub.
        if (!address && !(m.id === mainM.id && m.kind === "self")) {
          const detail = `Tailscale isn't running on ${m.name}: open Tailscale there and sign in, then start again.`;
          this.setMachine(m.id, { state: "error", detail });
          throw new Problem(detail, undefined, true);
        }
        return { m, node, backend, address };
      }),
    );
    this.alive(run);
    const [main, ...helpers] = parts;
    const rpc = helpers.map((p) => `${p.address}:${p.m.rpcPort}`);
    const twice = rpc.findIndex((r, i) => rpc.indexOf(r) !== i);
    if (twice >= 0) {
      const first = helpers[rpc.indexOf(rpc[twice])];
      throw new Problem(`${first.m.name} and ${helpers[twice].m.name} have the same address and port (${rpc[twice]}): give one of them another port, then start again.`);
    }
    const host = main.m.kind === "self" || loopback() ? "127.0.0.1" : main.address!;
    return {
      build: config.build,
      model,
      main: main as Part & { node: NodeClient },
      helpers,
      rpc,
      // The main machine's GPU left out: every GPU the helpers serve (a helper may serve more than one).
      devices: main.m.enabled ? null : "helpers",
      host,
      port: config.port,
      alias: config.alias || aliasFor(model),
      contextSize: config.contextSize,
      baseUrl: `http://${host}:${config.port}`,
    };
  }

  /** Runs a step on a hub: its problem marks it and stops the start. */
  private async step<T>(run: Run, p: Part, work: () => Promise<T>): Promise<T> {
    try {
      const out = await work();
      this.alive(run);
      return out;
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      this.alive(run);
      const away = (e as HttpError).code === "unreachable";
      this.setMachine(p.m.id, { state: away ? "offline" : "error", detail: message(e) });
      throw new Problem(message(e), undefined, away);
    }
  }

  /** The pool's llama.cpp build on every hub taking part that doesn't have it. */
  private async installAll(run: Run, plan: Plan) {
    const hubs = [plan.main, ...plan.helpers].filter((p) => p.node && !this.infos.get(p.m.id)?.installed.includes(`${plan.build}-${p.backend}`));
    if (!hubs.length) return;
    this.setStatus({ detail: `Installing llama.cpp ${plan.build} on ${names(hubs.map((p) => p.m))}…` });
    await Promise.all(hubs.map((p) => this.installOn(run, plan, p)));
  }

  private async installOn(run: Run, plan: Plan, p: Part) {
    const id = `${plan.build}-${p.backend}`;
    const node = p.node!;
    const what = `Installing llama.cpp ${plan.build}`;
    let info = await this.step(run, p, () => node.post("install", { build: plan.build, backend: p.backend }));
    const until = Date.now() + this.installTimeoutMs;
    let idle = 0;
    while (!info.installed.includes(id)) {
      if (info.lastError?.what === "install") {
        const detail = info.lastError.detail;
        this.setMachine(p.m.id, { state: "error", detail });
        throw new Problem(`${p.m.name}: ${detail}`);
      }
      // The install ended without installing it, and without saying why.
      idle = info.busy?.what === "install" ? 0 : idle + 1;
      if (idle > 3) throw new Problem(`llama.cpp didn't install on ${p.m.name}: start again.`);
      if (Date.now() > until) throw new Problem(`Installing llama.cpp on ${p.m.name} takes too long: check its internet connection, then start again.`);
      this.setMachine(p.m.id, { state: "installing", detail: progress(what, info.busy) });
      await pause(p.m.kind === "self" ? 300 : 1000, run);
      info = await this.step(run, p, () => node.poll());
    }
    this.noteInfo(p.m, info);
    this.setMachine(p.m.id, { state: "ready", detail: null });
  }

  /** The helpers on the hubs taking part (other than the main machine). */
  private async startHelpers(run: Run, plan: Plan) {
    const hubs = plan.helpers.filter((p) => p.node);
    if (!hubs.length) return;
    this.setStatus({ detail: `Starting the helper on ${names(hubs.map((p) => p.m))}…` });
    await Promise.all(hubs.map((p) => this.startHelper(run, plan, p)));
  }

  /** One hub's helper, for this start (a new start gets a helper of its own there, with no client from before). */
  private async startHelper(run: Run, plan: Plan, p: Part) {
    // Noted before it's asked: a stop meanwhile ends it too, and so does this hub's next start after a crash.
    run.started.helpers.add(p.m.id);
    this.noteLeft(p.m.id, "helper", true);
    const body = { action: "start", build: plan.build, backend: p.backend, port: p.m.rpcPort, owner: this.owner(run), cacheBytes: this.shareOf(plan, p) };
    const info = await this.step(run, p, () => p.node!.post("helper", body, 60_000));
    this.noteInfo(p.m, info);
    this.setMachine(p.m.id, { state: "running", detail: info.helper.detail ?? "Lending its GPU to the pool." });
  }

  /**
   * About how much of the model a helper is sent (for its weight cache): its GPUs' part of the free memory of every
   * machine taking part, with room to spare; the whole model when that isn't known (a computer's memory can't be).
   */
  private shareOf(plan: Plan, p: Part): number {
    const size = plan.model.sizeBytes;
    const free = (m: PoolMachine) => (this.devicesOf(m) ?? []).reduce((n, d) => n + Math.max(0, d.freeMiB), 0);
    const taking = [plan.main, ...plan.helpers].filter((x) => x.m.enabled);
    if (taking.some((x) => this.devicesOf(x.m) === null)) return size;
    const total = taking.reduce((n, x) => n + free(x.m), 0);
    const mine = free(p.m);
    return total > 0 && mine > 0 ? Math.min(size, Math.ceil((size * mine * 1.25) / total)) : size;
  }

  /** Every computer taking part answers at its address (before the pool's server connects to them). */
  private async checkComputers(run: Run, plan: Plan) {
    const computers = plan.helpers.filter((p) => !p.node);
    if (!computers.length) return;
    this.setStatus({ detail: `Checking the helper on ${names(computers.map((p) => p.m))}…` });
    const answers = await Promise.all(computers.map((p) => this.probe(p.address!, p.m.rpcPort)));
    this.alive(run);
    const missing = computers.find((_, i) => !answers[i]);
    for (const [i, p] of computers.entries()) {
      if (answers[i]) this.setMachine(p.m.id, { state: "ready", detail: `Its helper answers at ${p.address}:${p.m.rpcPort}.`, checkedAt: Date.now() });
    }
    if (missing) {
      const detail = `The helper on ${missing.m.name} doesn't answer at ${missing.address}:${missing.m.rpcPort}. Run its helper command there (Helper command next to it), then start again.`;
      this.setMachine(missing.m.id, { state: "offline", detail: `Its helper doesn't answer at ${missing.address}:${missing.m.rpcPort}: run its helper command there.`, checkedAt: Date.now() });
      throw new Problem(detail, undefined, true);
    }
  }

  /** The model on the main machine: downloaded there when it's missing (with the Hugging Face token, for that only). */
  private async ensureModel(run: Run, plan: Plan) {
    const main = plan.main;
    const files = plan.model.files.map((f) => `${plan.model.repo}/${f}`);
    const have = (i: PoolNodeInfo) => files.every((f) => i.models.includes(f));
    let info = this.infos.get(main.m.id) ?? (await this.step(run, main, () => main.node.info()));
    if (have(info)) return;
    const token = readSecrets()[HF_SECRET] ?? null;
    this.setStatus({
      state: "downloading",
      detail: `Downloading ${modelLabel(plan.model)} to ${main.m.name}…`,
      download: { file: plan.model.files[0], doneBytes: 0, totalBytes: plan.model.sizeBytes, bytesPerSec: null },
    });
    run.started.download = true;
    info = await this.step(run, main, () => main.node.post("model", { action: "download", model: plan.model, ...(token ? { hfToken: token } : {}) }));
    const rate = new Rate();
    let idle = 0;
    let misses = 0;
    while (!have(info)) {
      if (info.lastError?.what === "download") throw new Problem(main.m.kind === "self" ? info.lastError.detail : `${main.m.name}: ${info.lastError.detail}`);
      const busy = info.busy?.what === "download" ? info.busy : null;
      idle = busy ? 0 : idle + 1;
      if (idle > 3) throw new Problem(`The download to ${main.m.name} stopped: start the pool again to continue it (it picks up where it stopped).`);
      if (busy) {
        const done = busy.doneBytes ?? 0;
        this.setStatus({ download: { file: busy.file ?? plan.model.files[0], doneBytes: done, totalBytes: busy.totalBytes || plan.model.sizeBytes, bytesPerSec: rate.add(done) } }, true);
      }
      await pause(main.m.kind === "self" ? 500 : 1000, run);
      try {
        info = await main.node.poll();
        misses = 0;
      } catch (e) {
        this.alive(run);
        // A long download outlasts a short network hiccup.
        if (++misses >= 30) throw new Problem(`${message(e)} The download picks up where it stopped.`);
      }
      this.alive(run);
    }
    run.started.download = false;
    this.noteInfo(main.m, info);
    // Said with the next step (an event now would come sooner than twice a second after the last progress).
    this.status = { ...this.status, download: null };
  }

  /** The server on the main machine; once it answers, the custom-model accounts and the chats on them. */
  private async serve(run: Run, plan: Plan, again = false) {
    const main = plan.main;
    this.setStatus({ state: "starting", detail: again ? `Starting the model server on ${main.m.name} again…` : `Starting the model server on ${main.m.name}…`, download: null, endpoint: null });
    run.started.server = true;
    this.noteLeft(main.m.id, "server", true);
    const body = {
      action: "start",
      build: plan.build,
      backend: main.backend,
      model: plan.model,
      rpc: plan.rpc,
      devices: plan.devices,
      contextSize: plan.contextSize,
      alias: plan.alias,
      port: plan.port,
      host: plan.host,
      apiKey: this.apiKey(),
      owner: this.owner(run),
    };
    let info: PoolNodeInfo;
    try {
      // The main machine first asks each helper which devices it serves (up to 20 seconds for one that's busy).
      info = await main.node.post("server", body, 60_000);
      this.alive(run);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      this.alive(run);
      throw this.serverProblem(plan, e);
    }
    this.setMachine(main.m.id, { state: "running", detail: "Loading the model…" });
    const began = Date.now();
    let misses = 0;
    while (!(info.server.running && info.server.healthy)) {
      if (!info.server.running) {
        throw new Problem(`The model server on ${main.m.name} stopped as it started: ${info.server.detail ?? "it didn't say why. Look at its output below, then start again."}`, info.server.log);
      }
      if (Date.now() - began > this.healthTimeoutMs) {
        throw new Problem(`The model server on ${main.m.name} wasn't ready after ${Math.round(this.healthTimeoutMs / 60_000)} minutes: check the machines' network, or pick a smaller quant, then start again.`, info.server.log);
      }
      this.setStatus({ detail: loadingDetail(info.server.log, Date.now() - began, main.m.name, plan.helpers.length > 0), log: info.server.log.slice(-LOG_LINES) }, true);
      await pause(main.m.kind === "self" ? 300 : 1500, run);
      try {
        info = await main.node.poll();
        misses = 0;
      } catch (e) {
        this.alive(run);
        if (++misses >= 10) throw new Problem(message(e));
      }
      this.alive(run);
    }
    const contextWindow = await this.servedContext(plan);
    this.alive(run);
    const accounts = this.offer(plan, contextWindow);
    const taking = [main, ...plan.helpers].filter((p) => p.m.enabled);
    this.setMachine(main.m.id, { state: "running", detail: "Runs the model server." });
    for (const p of plan.helpers) this.setMachine(p.m.id, { state: "running", detail: "Lending its GPU to the pool." });
    this.setStatus({
      state: "running",
      detail: `Running on the GPU${taking.length === 1 ? "" : "s"} of ${names(taking.map((p) => p.m))}.`,
      endpoint: { baseUrl: plan.baseUrl, model: plan.alias, contextWindow },
      accounts,
      startedAt: Date.now(),
      log: info.server.log.slice(-LOG_LINES),
    });
    this.app.store.kvSet("pool.wasRunning", "1");
    // Replies a hub restart interrupted on the pool's server pick up now.
    this.app.engine.resumeHeld((m) => this.servesMember(m));
    // It ran: what goes wrong from now on is a problem to show, not a machine still starting up.
    run.auto = false;
    this.resumeTries = 0;
    log.info(`the model pool runs ${plan.model.repo} on ${main.m.name} at ${plan.baseUrl}${plan.rpc.length ? ` with ${plan.rpc.length} helper(s)` : ""}`);
    this.watch(run, plan);
  }

  /**
   * Why the main machine didn't start the server, in words that name the machine at fault: a helper that another
   * program holds never answers llama.cpp, and one out of reach can't be used.
   */
  private serverProblem(plan: Plan, e: unknown): Problem {
    const code = (e as HttpError).code;
    const helper = code === "helper_busy" || code === "helper_unreachable" ? plan.helpers.find((p) => message(e).includes(`${p.address}:${p.m.rpcPort}`)) : undefined;
    if (!helper) {
      const away = code === "unreachable";
      this.setMachine(plan.main.m.id, { state: away ? "offline" : "error", detail: message(e) });
      return new Problem(message(e), undefined, away);
    }
    const where = `${helper.address}:${helper.m.rpcPort}`;
    if (code === "helper_busy") {
      const fix = helper.node ? "stop that (or switch the machine off here), then start again." : "close that, or run its helper command there again (Helper command), then start again.";
      this.setMachine(helper.m.id, { state: "error", detail: `Its helper at ${where} is busy with another program.` });
      return new Problem(`The helper on ${helper.m.name} is busy with another program (another pool's model server, say): ${fix}`);
    }
    this.setMachine(helper.m.id, { state: "offline", detail: `${plan.main.m.name} can't reach its helper at ${where}.` });
    return new Problem(
      `${plan.main.m.name} can't reach the helper on ${helper.m.name} at ${where}: check that both are on Tailscale${helper.node ? "" : " and that its helper command still runs there (Helper command)"}, then start again.`,
      undefined,
      true,
    );
  }

  /** The context the server really gave (never more than the model holds), from its /props. */
  private async servedContext(plan: Plan): Promise<number> {
    let n: unknown;
    try {
      const res = await fetch(`${plan.baseUrl}/props`, { headers: { authorization: `Bearer ${this.apiKey()}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const props = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
      n = props.default_generation_settings?.n_ctx ?? props.n_ctx;
    } catch (e) {
      throw new Problem(`This hub can't reach the model server on ${plan.main.m.name} at ${plan.host}:${plan.port} (${message(e)}): check Tailscale on both machines, then start again.`);
    }
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) throw new Problem(`The model server on ${plan.main.m.name} didn't say its context size: start again.`);
    // With -c set, llama.cpp never cuts the context to fit (the start fails instead); a model trained on a shorter
    // one gets that.
    if (n < MIN_CONTEXT) {
      throw new Problem(`${modelLabel(plan.model)} only holds ${n.toLocaleString("en-US")} tokens of context, too few for chats: choose another model, then start again.`);
    }
    return n;
  }

  /**
   * The "Model pool" custom-model accounts for Claude Code and Codex, pointing at the server (the same accounts every
   * time), and every chat on them restarted with the new settings.
   */
  private offer(plan: Plan, contextWindow: number): Partial<Record<Provider, string>> {
    const ids = this.accountIds();
    const accounts: Partial<Record<Provider, string>> = {};
    const fields = { baseUrl: plan.baseUrl, apiKey: this.apiKey(), models: [plan.alias], contextWindow };
    for (const p of PROVIDERS) {
      const known = ids[p] ?? this.app.providers.accounts().find((a) => a.provider === p && a.kind === "endpoint" && a.label === ACCOUNT_LABEL)?.id;
      try {
        accounts[p] = this.app.providers.setEndpointAccount(p, { id: known, label: ACCOUNT_LABEL, ...fields }).id;
      } catch (e) {
        // Another account already has the name.
        if (known || !(e instanceof HttpError) || e.status !== 409) throw e;
        accounts[p] = this.app.providers.setEndpointAccount(p, { label: `${ACCOUNT_LABEL} (llama.cpp)`, ...fields }).id;
      }
    }
    this.app.store.kvSet("pool.accounts", JSON.stringify(accounts));
    for (const r of this.app.store.listRooms()) {
      for (const m of this.app.store.listMembers(r.id)) {
        const id = accounts[m.provider];
        if (!id || memberAccount(m) !== id) continue;
        // A pool serves one model at a time: a chat still naming the one it ran before would be refused by the server,
        // so it follows the new one, and says so in the chat.
        if (m.model && m.model !== plan.alias) this.followModel(m, plan.alias);
        void this.app.engine.memberChanged(m.id);
      }
    }
    return accounts;
  }

  /** A chat on the pool put on the model the pool now runs, told in its own words (the pool runs one at a time). */
  private followModel(m: Member, alias: string) {
    const was = m.model;
    const next = this.app.store.updateMember(m.id, { model: alias });
    if (!next) return;
    this.app.engine.invalidateModel(m.id);
    this.app.bus.emit({ t: "member", member: next });
    this.app.engine.systemMessage(m.roomId, `${ACCOUNT_LABEL} now runs ${alias}, not ${was}. This chat runs it too: the pool serves one model at a time.`);
  }

  /**
   * Looks at the running pool now and then: the main machine's server, each hub lending its GPU (its node info, never
   * its helper's port) and, every half minute, each computer over Tailscale (never its helper, which the server holds).
   * Whatever stopped is said in plain words, and the pool is started again once, after a pause, if every machine
   * answers by then. Reads the speed too.
   */
  private watch(run: Run, plan: Plan) {
    const every = plan.main.m.kind === "self" ? this.watchMs.self : this.watchMs.hub;
    let misses = 0;
    let metricsAt = 0;
    let pingedAt = Date.now();
    const helperMisses = new Map<string, number>();
    const pcMisses = new Map<string, number>();
    const live = () => !run.cancelled && this.run === run && !this.closed && this.status.state === "running";
    const next = () => {
      if (live()) run.timer = setTimeout(() => void tick().catch((e) => log.warn(`watching the model pool: ${message(e)}`)), every);
    };
    const tick = async () => {
      run.timer = null;
      if (!live()) return;
      let info: PoolNodeInfo;
      try {
        info = await plan.main.node.poll();
        misses = 0;
      } catch (e) {
        if (!live()) return;
        if (++misses >= 3) {
          this.setStatus({ state: "error", detail: `${message(e)} Chats can't use the model pool until it answers again: then start the pool again.`, endpoint: null, speed: null });
          this.app.store.kvSet("pool.wasRunning", "0");
          return;
        }
        return next();
      }
      if (!live()) return;
      if (!info.server.running) {
        const why = info.server.detail ?? "it didn't say why.";
        return this.lost(run, plan, { m: plan.main.m, head: `The model server on ${plan.main.m.name} stopped: ${why}`, detail: `Its model server stopped: ${why}`, log: info.server.log });
      }
      // Another start (of this pool, or another hub's once this one stopped asking) replaced it.
      const owner = info.server.owner;
      if (owner && owner.run !== run.id) {
        const other = owner.hub === this.app.hubId() ? "" : ` (the pool on ${owner.name})`;
        this.setStatus({ state: "error", detail: `Another start took over the model server on ${plan.main.m.name}${other}: start this pool again to use it.`, endpoint: null, speed: null });
        return;
      }
      for (const p of plan.helpers) {
        if (!p.node) continue;
        let h: PoolNodeInfo;
        try {
          h = await p.node.poll();
          helperMisses.set(p.m.id, 0);
        } catch (e) {
          if (!live()) return;
          const n = (helperMisses.get(p.m.id) ?? 0) + 1;
          helperMisses.set(p.m.id, n);
          if (n >= 3) return this.lost(run, plan, { m: p.m, head: message(e), state: "offline", detail: message(e) });
          continue;
        }
        if (!live()) return;
        if (!h.helper.running) {
          const why = h.helper.detail ?? "it didn't say why.";
          return this.lost(run, plan, { m: p.m, head: `The helper on ${p.m.name} stopped: ${why}`, detail: `Its helper stopped: ${why}` });
        }
      }
      if (Date.now() - pingedAt >= this.pingMs) {
        pingedAt = Date.now();
        for (const p of plan.helpers) {
          if (p.node || !p.address || !isTailscaleIPv4(p.address)) continue;
          const link = await tailscalePing(p.address);
          if (!live()) return;
          // null: Tailscale isn't on this hub (nothing known); no answer three times running: it's gone.
          const n = link && link.ms === null ? (pcMisses.get(p.m.id) ?? 0) + 1 : 0;
          pcMisses.set(p.m.id, n);
          if (n >= 3) {
            const gone = `${p.m.name} doesn't answer over Tailscale any more, so its GPU can't take part.`;
            return this.lost(run, plan, { m: p.m, head: gone, state: "offline", detail: `${p.m.name} doesn't answer over Tailscale: turn it on and open Tailscale there.` });
          }
        }
      }
      const lines = info.server.log.slice(-LOG_LINES);
      if (lines.join("\n") !== this.status.log.join("\n")) this.setStatus({ log: lines }, true);
      if (Date.now() - metricsAt >= this.metricsMs) {
        metricsAt = Date.now();
        await this.readSpeed(plan);
      }
      next();
    };
    run.timer = setTimeout(() => void tick().catch((e) => log.warn(`watching the model pool: ${message(e)}`)), every);
  }

  private async readSpeed(plan: Plan) {
    try {
      const res = await fetch(`${plan.baseUrl}/metrics`, { headers: { authorization: `Bearer ${this.apiKey()}` }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const speed = parseMetrics(await res.text());
      if (!speed.prompt && !speed.generation) return;
      const cur = this.status.speed;
      if (cur?.prompt !== speed.prompt || cur?.generation !== speed.generation) this.setStatus({ speed }, true);
    } catch {
      // read again next time
    }
  }

  /**
   * Something the running pool needs stopped on its own: the main machine's server, a hub's helper, or a computer
   * that left Tailscale. Said in plain words (`head`), and the pool is started again once, after a pause.
   */
  private lost(run: Run, plan: Plan, what: { m: PoolMachine; head: string; detail: string; state?: "error" | "offline"; log?: string[] }) {
    const server = what.m.id === plan.main.m.id;
    // Nothing runs there any more (a hub that doesn't answer may still run it: its note stays).
    if (server) {
      run.started.server = false;
      this.noteLeft(what.m.id, "server", false);
    } else if (what.state !== "offline") this.noteLeft(what.m.id, "helper", false);
    const again = !run.restarted;
    const when = waitText(this.restartDelayMs);
    log.warn(`the model pool lost ${what.m.name}: ${what.head}`);
    this.setMachine(what.m.id, { state: what.state ?? "error", detail: what.detail });
    const next = !again
      ? " It had already been started again once: start the pool again when the machines are ready."
      : server
        ? ` Crosstalk starts it again ${when} if every helper still answers.`
        : ` Crosstalk starts the pool again ${when} if every machine answers by then.`;
    this.setStatus({ state: "error", detail: `${what.head}${next}`, endpoint: null, speed: null, ...(what.log ? { log: what.log.slice(-LOG_LINES) } : {}) });
    if (!again) {
      this.failed(run, new Problem(this.status.detail ?? what.head, what.log));
      return;
    }
    run.restarted = true;
    run.timer = setTimeout(() => {
      run.timer = null;
      run.busy = true;
      run.settled = this.restart(run, plan).finally(() => {
        run.busy = false;
      });
    }, this.restartDelayMs);
  }

  /**
   * The one automatic restart, once every machine answers: a server still running lets go of the helpers first, a
   * hub's helper that stopped (its hub restarted, say) is started again, and a computer's must answer.
   */
  private async restart(run: Run, plan: Plan) {
    try {
      this.alive(run);
      if (run.started.server) {
        this.setStatus({ detail: `Starting the pool again: stopping the model server on ${plan.main.m.name} first…` });
        await this.step(run, plan.main, () => plan.main.node.post("server", { action: "stop", owner: this.owner(run) }, 20_000));
        run.started.server = false;
        this.noteLeft(plan.main.m.id, "server", false);
      }
      for (const p of plan.helpers) {
        if (p.node) {
          const info = await this.step(run, p, () => p.node!.poll());
          if (!info.helper.running) await this.startHelper(run, plan, p);
        } else if (!(await this.probe(p.address!, p.m.rpcPort))) {
          this.alive(run);
          throw new Problem(`The helper on ${p.m.name} doesn't answer at ${p.address}:${p.m.rpcPort}: run its helper command there (Helper command), then start the pool again.`);
        }
        this.alive(run);
      }
      await this.serve(run, plan, true);
    } catch (e) {
      if (e instanceof Cancelled || run.cancelled || this.run !== run) return;
      this.failed(run, e);
    }
  }

  /**
   * POST /api/pool/stop: the server first, then the hubs' helpers. Computers keep theirs running. With no start to
   * end, what an earlier one left on the hubs (a crash, a stop that couldn't reach them) goes. `reason` is said first.
   */
  stop(reason?: string): Promise<PoolView> {
    if (this.stopping) return this.stopping;
    // A stop also ends the hub's own tries to start it ("Start when the hub starts").
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const run = this.run;
    if (!run || this.status.state === "off") {
      if (!Object.keys(this.leftovers()).length) return Promise.resolve(this.view());
      this.stopping = (async () => {
        const problems = await this.endLeftovers();
        this.setStatus({ detail: [reason, ...problems].filter(Boolean).join(" ") || this.status.detail });
        return this.view();
      })().finally(() => {
        this.stopping = null;
      });
      return this.stopping;
    }
    this.stopping = (async () => {
      const inFlight = run.busy;
      run.cancel();
      run.halted = true;
      this.setStatus({ state: "stopping", detail: "Stopping the model pool…" });
      await this.cleaning;
      const note = await this.halt(run);
      this.setStatus({ state: "off", detail: [reason, note].filter(Boolean).join(" ") || null, download: null, endpoint: null, speed: null, startedAt: null });
      this.app.store.kvSet("pool.wasRunning", "0");
      this.saveStates();
      // A request that was on its way when the stop came may still start something: ended once the start lets go.
      if (inFlight) {
        void run.settled.then(() => {
          if (this.run === run && !this.closed) void this.halt(run).catch(() => {});
        });
      }
      return this.view();
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** Ends what a run started: a download (kept for next time), the server, the hubs' helpers. */
  private async halt(run: Run, timeoutMs = 20_000): Promise<string | null> {
    const plan = run.plan;
    if (!plan) return null;
    const problems: string[] = [];
    const main = plan.main;
    const owner = this.owner(run);
    // What a hub that can't be asked now runs ends by itself there once this pool stops asking about it.
    const mayRun = (m: PoolMachine, what: string, e: unknown) => {
      const itself = m.kind === "hub" ? ` there may still run: it ends by itself within ${LEASE_MIN} minutes.` : " may still run: stop the pool again in a moment.";
      return (e as HttpError).status === 401 ? `${m.name} no longer accepts this hub's sign-in, so ${what}${itself}` : `${message(e)} ${what[0].toUpperCase()}${what.slice(1)}${itself}`;
    };
    // Asking again is harmless (a second pass after a request that was on its way when the stop came).
    if (run.started.download) await main.node.post("model", { action: "cancel" }, timeoutMs).catch(() => {});
    if (run.started.server) {
      await main.node
        .post("server", { action: "stop", owner }, timeoutMs)
        .then((info) => {
          this.noteInfo(main.m, info);
          this.noteLeft(main.m.id, "server", false);
        })
        .catch((e) => problems.push(mayRun(main.m, "its model server", e)));
      this.calm(main.m.id);
    }
    const helpers = plan.helpers.filter((p) => p.node && run.started.helpers.has(p.m.id));
    await Promise.all(
      helpers.map((p) =>
        p
          .node!.post("helper", { action: "stop", owner }, timeoutMs)
          .then((info) => {
            this.noteInfo(p.m, info);
            this.noteLeft(p.m.id, "helper", false);
          })
          .catch((e) => problems.push(mayRun(p.m, "its helper", e)))
          .finally(() => this.calm(p.m.id)),
      ),
    );
    const computers = plan.helpers.filter((p) => !p.node).map((p) => p.m);
    for (const m of computers) {
      if (this.states.get(m.id)?.state === "running") this.setMachine(m.id, { state: "ready", detail: "Its helper keeps running there: close its window to stop it." });
    }
    const keep = computers.length
      ? `The helper${computers.length === 1 ? "" : "s"} on ${names(computers)} ${computers.length === 1 ? "keeps" : "keep"} running there: close ${computers.length === 1 ? "its window" : "their windows"} to stop ${computers.length === 1 ? "it" : "them"}.`
      : null;
    return [keep, ...problems].filter(Boolean).join(" ") || null;
  }

  /** A machine that ran something for the pool is idle again (a problem it had stays). */
  private calm(id: string) {
    const st = this.states.get(id);
    if (st && (st.state === "running" || st.state === "installing")) this.setMachine(id, { state: "ready", detail: null });
  }

  /**
   * Ends what kv pool.left lists (`only`: on that hub): what a hub that stopped without ending it left on the others.
   * What can't be reached stays listed (and ends by itself there); what's said is what didn't end.
   */
  private async endLeftovers(only?: string, timeoutMs = 15_000): Promise<string[]> {
    const links = this.links();
    const config = this.config();
    const problems: string[] = [];
    await Promise.all(
      Object.entries(this.leftovers())
        .filter(([id]) => !only || id === only)
        .map(async ([id, roles]) => {
          const link = links.find((l) => l.id === id);
          const m = config.machines.find((x) => x.id === id);
          const list = (Array.isArray(roles) ? roles : []).filter((r) => r === "server" || r === "helper");
          // Not linked (with a full sign-in) any more: nothing can be asked there, and it ends by itself.
          if (!link || link.scope !== "full" || !m) {
            for (const r of list) this.noteLeft(id, r, false);
            return;
          }
          const node = hubNode(this.app, link);
          for (const role of list) {
            try {
              const info = await node.post(role, { action: "stop", owner: this.owner(null) }, timeoutMs);
              this.noteInfo(m, info);
              this.noteLeft(id, role, false);
              this.calm(id);
              log.info(`ended the ${role === "server" ? "model server" : "helper"} an earlier run of the pool left on ${link.name}`);
            } catch (e) {
              problems.push(`${message(e)} What the pool ran there ends by itself within ${LEASE_MIN} minutes.`);
              return;
            }
          }
        }),
    );
    if (problems.length) log.warn(`couldn't end what the pool left on other hubs: ${problems.join(" ")}`);
    return problems;
  }

  /**
   * Settings → Machines is unlinking a hub (machines.ts): while this hub can still sign in there, the pool stops if it
   * uses it, and what an earlier start left there ends. A hub that doesn't answer doesn't hold the unlink up for
   * long: what runs there ends by itself (node.ts LEASE_MS).
   */
  async release(id: string): Promise<void> {
    const work = (async () => {
      const run = this.run;
      const uses = !!run?.plan && !run.halted && [run.plan.main, ...run.plan.helpers].some((p) => p.m.id === id);
      if (uses && this.status.state !== "off") {
        const name = this.config().machines.find((m) => m.id === id)?.name ?? "A machine in it";
        await this.stop(`Stopped: ${name} was unlinked.`);
      }
      await this.endLeftovers(id, 10_000);
    })();
    await Promise.race([work.catch(() => {}), Bun.sleep(15_000)]);
  }

  // ---- The hub starting and stopping ----

  /**
   * When the hub starts (main.ts), before resume(): what this pool ran on other hubs when this hub last stopped without
   * ending it (a crash, a power cut) is ended. A start waits for that.
   */
  recover() {
    if (!Object.keys(this.leftovers()).length) return;
    const before = this.cleaning;
    this.cleaning = before.then(() => this.endLeftovers()).then(
      () => {},
      () => {},
    );
  }

  /**
   * When the hub starts (main.ts): the pool starts again if it ran when the hub stopped and that's switched on. A
   * machine that isn't up yet is tried again for a while (after a power cut, the hubs start in any order).
   */
  resume(delayMs = 5000) {
    if (!this.config().autostart || this.app.store.kvGet("pool.wasRunning") !== "1") return;
    this.resumeUntil = Date.now() + delayMs + RESUME_FOR_MS;
    this.resumeTries = 0;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.closed || (this.run && (ACTIVE.includes(this.status.state) || this.stopping))) return;
      log.info("starting the model pool again: it was running when the hub stopped");
      try {
        this.start({ auto: true });
      } catch (e) {
        log.warn(`couldn't start the model pool again: ${message(e)}`);
      }
    }, delayMs);
  }

  /** The hub is shutting down: what the pool runs is ended (it starts again with the hub if it's set to). */
  async shutdown(): Promise<void> {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    const run = this.run;
    this.closed = true;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (!run) return;
    const active = !run.halted && this.status.state !== "off";
    run.cancel();
    await Promise.race([this.cleaning, Bun.sleep(5000)]);
    if (active) await Promise.race([this.halt(run, 5000).catch(() => null), Bun.sleep(8000)]);
  }

  // ---- The other routes ----

  /** GET /api/pool/models?repo=…: a Hugging Face repo's GGUF models (with the saved token, if any). */
  models(repo: string): Promise<PoolModelChoices> {
    return choices(repo, readSecrets()[HF_SECRET] ?? null);
  }

  /** GET /api/pool/tailscale: the devices on this hub's tailnet. */
  async tailscale(): Promise<{ peers: TailscalePeer[] }> {
    return { peers: await tailscalePeers() };
  }

  /** The helper commands handed out, by computer: the build each named, and the token of its short command. */
  private commands(): Record<string, { build: string; at: number; token?: string }> {
    return this.kvJson<Record<string, { build: string; at: number; token?: string }>>("pool.commands");
  }

  /** Notes the build a computer's command names now (a start says when the pool's build changed since). */
  private noteCommand(config: PoolConfig, m: PoolMachine): string {
    const made = this.commands();
    const token = made[m.id]?.token && SCRIPT_TOKEN.test(made[m.id].token!) ? made[m.id].token! : shortToken();
    made[m.id] = { build: config.build, at: Date.now(), token };
    for (const k of Object.keys(made)) if (!config.machines.some((x) => x.id === k)) delete made[k];
    this.app.store.kvSet("pool.commands", JSON.stringify(made));
    return token;
  }

  /**
   * GET /api/pool/helper-command?machine=…&os=…&backend=…: the command that runs a computer's helper, and, when this
   * hub has an https address (`hubUrl`, which the computer reaches over Tailscale), a short one to type instead that
   * fetches it from here (GET /api/pool/helper/<token>). The build it names is noted, so a start can say when the
   * pool's build changed since.
   */
  helperCommand(query: URLSearchParams, hubUrl?: string | null): HelperCommand & { short?: string } {
    const config = this.config();
    const id = query.get("machine") ?? "";
    const m = config.machines.find((x) => x.id === id);
    if (!m) throw new HttpError(404, "That computer isn't in the pool: add it first (Add a Windows or other PC).");
    if (m.kind !== "computer") throw bad(`Crosstalk starts the helper on ${m.name} itself: it needs no command.`);
    const os: HelperOs = query.get("os") ? checkHelperOs(query.get("os")) : (m.os ?? "windows");
    const backend = query.get("backend") ? checkBackend(query.get("backend")) : (m.backend ?? defaultBackend(os));
    const out = makeHelperCommand({ build: config.build, os, backend, port: m.rpcPort, address: m.address });
    const token = this.noteCommand(config, m);
    // Only over https: the computer runs what it fetches.
    const base = (hubUrl ?? "").replace(/\/+$/, "");
    const short = /^https:\/\/[\w.-]+(:\d+)?$/.test(base) && os === (m.os ?? "windows") && backend === (m.backend ?? defaultBackend(os)) ? shortHelperCommand(os, `${base}/api/pool/helper/${token}`) : undefined;
    return { ...out, ...(short ? { short } : {}) };
  }

  /**
   * GET /api/pool/helper/<token> (no sign-in: the token is the permission, and what it gives away is no secret): the
   * helper command of the computer the token was made for, as it is now (its build, address, system and GPU kind).
   */
  helperScript(token: string): string {
    const config = this.config();
    const entry = SCRIPT_TOKEN.test(token) ? Object.entries(this.commands()).find(([, c]) => c.token === token) : undefined;
    const m = entry && config.machines.find((x) => x.id === entry[0] && x.kind === "computer");
    if (!m) throw new HttpError(404, "This helper command is out of date: get the new one in Crosstalk (Model pool, Helper command next to the computer).");
    const os = m.os ?? "windows";
    const out = makeHelperCommand({ build: config.build, os, backend: m.backend ?? defaultBackend(os), port: m.rpcPort, address: m.address });
    this.noteCommand(config, m);
    return `${out.script}\n`;
  }

  /**
   * POST /api/pool/model/remove: moves the model's files to the Trash on the main machine. Files are the model's own
   * (as its repo lists them) or the main machine's entries ("owner/repo/file").
   */
  async removeModel(input: unknown): Promise<PoolView> {
    if (!Array.isArray(input) || !input.length || input.length > 256 || !input.every((f) => typeof f === "string")) throw bad("Say which model files to remove.");
    const config = this.config();
    const entries = (input as string[]).map((f) => {
      if (config.model?.files.includes(f)) return `${config.model.repo}/${f}`;
      const { repo, file } = splitModelFile(f);
      return `${repo}/${file}`;
    });
    // While the pool runs (or starts, or stops), the model it uses stays; others on the main machine can go.
    if (ACTIVE.includes(this.status.state) || this.status.state === "stopping") {
      const used = [this.run?.plan?.model, config.model].flatMap((m) => (m ? m.files.map((f) => `${m.repo}/${f}`) : []));
      if (!this.run?.plan || entries.some((e) => used.includes(e))) throw new HttpError(409, "Stop the pool first, then remove the download.", "in_use");
    }
    const main = config.machines.find((m) => m.id === config.mainId)!;
    const info = await this.nodeFor(main).post("model", { action: "remove", files: entries }, 60_000);
    this.noteInfo(main, info);
    this.emitNow();
    return this.view();
  }
}

/** What a hub's own report says about it as a pool machine (`me`: this hub's id, to tell another hub's pool apart). */
function describeNode(info: PoolNodeInfo, m: PoolMachine, config: PoolConfig, me: string): Pick<PoolMachineState, "state" | "detail"> {
  const backend = m.backend ?? autoBackend(info, config.build);
  const other = (o: PoolOwner | null | undefined) => (o && o.hub !== me ? o.name : null);
  if (info.busy?.what === "install") return { state: "installing", detail: progress("Installing llama.cpp", info.busy) };
  if (info.server.running) {
    const pool = other(info.server.owner);
    return { state: "running", detail: pool ? `Runs the model server for the pool on ${pool}.` : info.server.healthy ? "Runs the model server." : "Loading the model…" };
  }
  if (info.helper.running) {
    const pool = other(info.helper.owner);
    return { state: "running", detail: pool ? `Lends its GPU to the pool on ${pool}.` : (info.helper.detail ?? "Lending its GPU.") };
  }
  if (info.lastError && info.lastError.what !== "download") return { state: "error", detail: info.lastError.detail };
  if (info.server.detail) return { state: "error", detail: info.server.detail };
  if (info.helper.detail) return { state: "error", detail: info.helper.detail };
  const takesPart = m.enabled || m.id === config.mainId;
  // Other machines reach a helper, or a main machine other than this hub, at its Tailscale address.
  const reached = m.kind === "hub" || config.mainId !== "self";
  if (reached && takesPart && !info.address && !loopback()) return { state: "error", detail: "Tailscale isn't running there: open Tailscale on it and sign in, then check again." };
  if (takesPart && !info.installed.includes(`${config.build}-${backend}`)) return { state: "ready", detail: `llama.cpp ${config.build} gets installed there when the pool starts${info.installed.length ? "" : ": then its GPUs show here"}.` };
  if (!info.installed.length) return { state: "ready", detail: "Its GPUs show once llama.cpp is on it (the pool installs it there when it takes part)." };
  if (!info.devices.length) return { state: "ready", detail: "llama.cpp found no GPU there." };
  return { state: "ready", detail: null };
}

function validPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

function validContext(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_CONTEXT && v <= MAX_CONTEXT;
}

/** The machine list from PUT /api/pool, checked: ids, kinds, names, addresses (numeric IPv4), systems, backends, ports. */
export function parseMachines(input: unknown, links: { id: string }[]): PoolMachine[] {
  if (!Array.isArray(input)) throw bad("Send the machines as a list.");
  if (input.length > MAX_MACHINES) throw bad(`A pool can have up to ${MAX_MACHINES} machines.`);
  const list = input.map(parseMachine);
  const ids = new Set<string>();
  for (const m of list) {
    if (ids.has(m.id)) throw bad(`${m.name || "A machine"} is in the list twice: pick the machines again.`);
    ids.add(m.id);
  }
  const computers = list.filter((m) => m.kind === "computer" && m.address);
  for (const [i, a] of computers.entries()) {
    const b = computers.slice(i + 1).find((x) => x.address === a.address && x.rpcPort === a.rpcPort);
    if (b) throw bad(`${a.name} and ${b.name} have the same address and port: remove one of them, or give one another port.`);
  }
  // Hubs that were unlinked meanwhile leave the list (linked ones join it in every view).
  return list.filter((m) => m.kind !== "hub" || links.some((l) => l.id === m.id));
}

function parseMachine(x: unknown, i: number): PoolMachine {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw bad(`Machine ${i + 1} in the list isn't set up right: pick the machines again.`);
  const m = x as Record<string, unknown>;
  const kind = m.kind;
  if (kind !== "self" && kind !== "hub" && kind !== "computer") throw bad("Each machine is this hub, a linked hub or a computer: pick the machines again.");
  const id = typeof m.id === "string" ? m.id : "";
  if (kind === "self" ? id !== "self" : kind === "hub" ? !HUB_ID.test(id) : !COMPUTER_ID.test(id)) throw bad("A machine's id doesn't match what it is: pick the machines again.");
  const name = typeof m.name === "string" ? m.name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const label = name || (kind === "computer" ? "the computer" : "this machine");
  if (typeof m.enabled !== "boolean") throw bad(`Say whether ${label} lends its GPU (enabled: true or false).`);
  const rpcPort = m.rpcPort === undefined ? RPC_PORT : checkPort(m.rpcPort, "helper port");
  const os = m.os === undefined || m.os === null ? null : checkHelperOs(m.os);
  const backend = m.backend === undefined || m.backend === null ? null : checkBackend(m.backend);
  let address: string | null = null;
  if (m.address !== undefined && m.address !== null && m.address !== "") {
    if (!isIPv4(m.address)) throw bad(`Type ${label}'s Tailscale address as four numbers, like 100.101.102.103.`);
    address = m.address;
  }
  if (kind === "computer") {
    if (!name) throw bad("Give each computer a name, like Gaming PC.");
    if (address && !isTailscaleIPv4(address) && !(loopback() && address === "127.0.0.1")) {
      throw bad(`${name}'s address must be its Tailscale address (100.64.0.0 to 100.127.255.255): the Tailscale app on it shows it.`);
    }
    if (os && backend) {
      try {
        assetsFor(POOL_BUILD, os, os === "macos" ? "arm64" : "x64", backend);
      } catch (e) {
        throw bad(`${name}: ${message(e)}`);
      }
    }
  }
  return { id, kind, name, address, os, backend, enabled: m.enabled, rpcPort };
}
