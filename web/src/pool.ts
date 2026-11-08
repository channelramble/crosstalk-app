import type { PoolConfig, PoolDevice, PoolFit, PoolMachine, PoolMachineState, PoolModel, PoolModelFile, PoolState, PoolStatus, PoolView } from "@crosstalk/shared";
import { bytesText } from "@crosstalk/shared";

// Settings → Model pool: words, sizes and fit badges, kept apart from the screen so they can be tested.

export const POOL_STATE: Record<PoolState, { label: string; pill: "" | "blue" | "green" | "red" }> = {
  off: { label: "Off", pill: "" },
  preparing: { label: "Preparing", pill: "blue" },
  downloading: { label: "Downloading", pill: "blue" },
  starting: { label: "Starting", pill: "blue" },
  running: { label: "Running", pill: "green" },
  stopping: { label: "Stopping", pill: "" },
  error: { label: "Problem", pill: "red" },
};

/** The pool is doing something on its way to running (Stop cancels it). */
export const isBusy = (s: PoolState) => s === "preparing" || s === "downloading" || s === "starting";

export const MACHINE_STATE: Record<PoolMachineState["state"], { label: string; dot: "ok" | "wait" | "bad" | "idle" }> = {
  unknown: { label: "Not checked yet", dot: "idle" },
  offline: { label: "Offline", dot: "bad" },
  ready: { label: "Ready", dot: "ok" },
  installing: { label: "Installing llama.cpp…", dot: "wait" },
  running: { label: "Running", dot: "ok" },
  error: { label: "Problem", dot: "bad" },
};

/**
 * A pool view with every part the screen reads, so a hub that leaves something out (older, or newer with states this
 * app doesn't know) can't break Settings: missing lists are empty, unknown states read as "off" and "unknown".
 */
export function normalizePool(v: PoolView): PoolView {
  const config: Partial<PoolConfig> = v?.config ?? {};
  const status: Partial<PoolStatus> = v?.status ?? {};
  return {
    config: {
      build: "",
      mainId: "self",
      contextSize: 65536,
      alias: "",
      port: 9931,
      ...config,
      autostart: !!config.autostart,
      model: config.model ? { ...config.model, files: Array.isArray(config.model.files) ? config.model.files : [] } : null,
      machines: Array.isArray(config.machines) ? config.machines : [],
    },
    machines: (Array.isArray(v?.machines) ? v.machines : []).map((m) => ({
      ...m,
      devices: Array.isArray(m.devices) ? m.devices : [],
      state: Object.hasOwn(MACHINE_STATE, m.state) ? m.state : "unknown",
    })),
    status: {
      detail: null,
      download: null,
      endpoint: null,
      accounts: {},
      startedAt: null,
      speed: null,
      ...status,
      state: status.state && Object.hasOwn(POOL_STATE, status.state) ? status.state : "off",
      log: Array.isArray(status.log) ? status.log : [],
    },
    fit: v?.fit ?? null,
    hasHfToken: !!v?.hasHfToken,
    mainFiles: Array.isArray(v?.mainFiles) ? v.mainFiles.filter((f) => f && typeof f.file === "string" && Number.isFinite(f.bytes)) : null,
  };
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** A file or download size, like the rest of the app shows them (ui.tsx formatBytes): "15.6 GB", "640 MB". It lives in shared because the hub's memory guard writes the same sizes. */
export { bytesText };

/** GPU memory as llama.cpp reports it (MiB): "16 GB" for a 16 GB card's 16304 MiB, "11.8 GB" for a Mac's working set. */
export function mibText(mib: number): string {
  if (mib < 1024) return `${Math.max(0, Math.round(mib))} MB`;
  const gb = mib / 1024;
  const whole = Math.round(gb);
  if (Math.abs(gb - whole) < 0.1 || gb >= 100) return `${whole} GB`;
  return `${gb.toFixed(1)} GB`;
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
  // "AMD Radeon Graphics" (a built-in GPU) has no model number to keep: say it whole.
  return /\d/.test(short) ? short : full;
}

/** The GPUs llama.cpp can put a model on: the CPU's BLAS "device" reports no memory. */
export function gpus(devices: PoolDevice[] | undefined): PoolDevice[] {
  return (devices ?? []).filter((d) => d.totalMiB > 0);
}

/** "RX 7600 XT · 16 GB", with what's free when other apps hold a good part of it. */
export function gpuLine(d: PoolDevice): string {
  const base = `${gpuName(d.description)} · ${mibText(d.totalMiB)}`;
  return d.freeMiB < d.totalMiB * 0.85 ? `${base} (${mibText(d.freeMiB)} free)` : base;
}

/**
 * How this hub reaches a machine over Tailscale: "Direct · 8 ms", "Through a relay · 40 ms: slower", or "No answer over
 * Tailscale" when the check got none. Null when there's nothing to say (not asked: no Tailscale here, or no address).
 */
export function linkText(link: PoolMachineState["link"] | undefined): string | null {
  if (!link) return null;
  if (link.ms === null && link.direct === null) return "No answer over Tailscale";
  const ms = link.ms === null ? null : link.ms < 0.5 ? "under 1 ms" : `${Math.round(link.ms)} ms`;
  if (link.direct === false) return `Through a relay${ms ? ` · ${ms}` : ""}: slower`;
  if (link.direct === true) return `Direct${ms ? ` · ${ms}` : ""}`;
  return ms!;
}

export type PoolRole = "Main machine" | "Helper" | "Left out";

/** The main machine runs the server (its own GPU may still be left out); the others lend their GPU or are left out. */
export function roleLabel(m: Pick<PoolMachine, "id" | "enabled">, mainId: string): PoolRole {
  if (m.id === mainId) return "Main machine";
  return m.enabled ? "Helper" : "Left out";
}

/** A Hugging Face repo's model name: "unsloth/Qwen3.8-27B-GGUF" is "Qwen3.8-27B", bartowski's "org_Model-GGUF" "Model". */
export function modelName(repo: string): string {
  let name = repo.split("/").pop() ?? repo;
  name = name.replace(/[-_.]?gguf$/i, "");
  const unprefixed = /^[a-z0-9-]+_(.{3,})$/.exec(name);
  return (unprefixed ? unprefixed[1] : name) || repo;
}

/** "Q4_K_M · 15.6 GB", and "in 2 parts" for a split model. */
export function modelSummary(m: Pick<PoolModel, "quant" | "sizeBytes" | "files">): string {
  return [m.quant, bytesText(m.sizeBytes), m.files.length > 1 ? `in ${m.files.length} parts` : null].filter(Boolean).join(" · ");
}

/** A file's own name, without its folder in the repo. */
export const fileName = (path: string) => path.split("/").pop() ?? path;

export const hfModelUrl = (repo: string) => `https://huggingface.co/${repo}`;

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";

/**
 * A Hugging Face model from what was pasted: "owner/repo", its page (huggingface.co or hf.co, any tab), a file's link
 * (blob/resolve) or llama.cpp's "owner/repo:Q4_K_M". Null for anything else, datasets and Spaces included.
 */
export function parseHfLink(input: string): { repo: string; file: string | null; quant: string | null } | null {
  let s = input.trim();
  if (!s) return null;
  let quant: string | null = null;
  const fromUrl = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/(.*)$/i.exec(s);
  // huggingface.co/models/owner/repo is the same page.
  if (fromUrl) s = fromUrl[1].replace(/^models\//i, "");
  else if (/^[a-z]+:\/\//i.test(s)) return null;
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (/^(datasets|spaces|collections|docs|settings|papers)\//i.test(s)) return null;
  const parts = s.split("/");
  if (parts.length < 2) return null;
  const owner = parts[0];
  let repo = parts[1];
  const tagged = /^(.*):([A-Za-z0-9_.-]+)$/.exec(repo);
  if (tagged && parts.length === 2) {
    repo = tagged[1];
    quant = tagged[2];
  }
  if (!new RegExp(`^${NAME}$`).test(owner) || !new RegExp(`^${NAME}$`).test(repo)) return null;
  let file: string | null = null;
  if (parts.length > 2) {
    // …/blob/main/sub/file.gguf, …/resolve/main/file.gguf, …/tree/main/folder: the branch is skipped.
    if (!["blob", "resolve", "tree"].includes(parts[2])) return null;
    const rest = parts.slice(4).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    }).join("/");
    if (rest && /\.gguf$/i.test(rest)) file = rest;
  }
  return { repo: `${owner}/${repo}`, file, quant };
}

/**
 * The room a model takes, as the hub counts it (hub/src/pool/pool.ts poolFit), so a file's badge and the chosen
 * model's fit agree: the file, its context (about 96 KiB a token) and 1 GiB for each machine taking part.
 */
export function estimateNeedMiB(sizeBytes: number, contextSize: number, machines = 1): number {
  return Math.ceil(sizeBytes / MiB + (contextSize * 96) / 1024 + 1024 * Math.max(1, machines));
}

/** What the machines taking part have free: each GPU, and all of them together. */
export interface PoolRoom {
  devices: { name: string; freeMiB: number }[];
  haveMiB: number;
  /** Machines taking part whose GPU memory isn't known here (a PC's can't be seen; a hub's until it's checked). */
  uncounted: string[];
  /** How many machines take part, and the context they're asked for (both add to what a model needs). */
  taking: number;
  contextSize: number;
}

/**
 * Machines taking part whose GPU memory the hub can't count: computers (Crosstalk only checks that their helper
 * answers), and hubs not checked yet or without llama.cpp yet. Their room isn't in the hub's fit.
 */
export function uncountedMachines(view: Pick<PoolView, "config" | "machines">): PoolMachine[] {
  return view.config.machines.filter((m) => {
    if (!m.enabled) return false;
    const st = view.machines.find((s) => s.id === m.id);
    return !st?.checkedAt || !gpus(st.devices).length;
  });
}

export function poolRoom(view: Pick<PoolView, "config" | "machines" | "fit">): PoolRoom {
  const taking = view.config.machines.filter((m) => m.enabled);
  const devices = taking.flatMap((m) => gpus(view.machines.find((s) => s.id === m.id)?.devices)).map((d) => ({ name: gpuName(d.description), freeMiB: d.freeMiB }));
  const sum = devices.reduce((n, d) => n + d.freeMiB, 0);
  return { devices, haveMiB: view.fit?.haveMiB || sum, uncounted: uncountedMachines(view).map((m) => m.name), taking: taking.length, contextSize: view.config.contextSize };
}

export type FitKind = "alone" | "pool" | "tight" | "more" | "big";

/**
 * A model file against the pool's room: "Fits alone on RX 7600 XT", "Fits the pool", "Tight" or "Too big". When a
 * machine taking part can't be counted (a PC), a file bigger than the rest says how much more that machine must add:
 * "Needs 5.2 GB more".
 */
export function fitBadge(sizeBytes: number, room: PoolRoom): { kind: FitKind; label: string } | null {
  const need = estimateNeedMiB(sizeBytes, room.contextSize, room.taking);
  const roomiest = [...room.devices].sort((a, b) => b.freeMiB - a.freeMiB)[0];
  if (roomiest && estimateNeedMiB(sizeBytes, room.contextSize, 1) <= roomiest.freeMiB) return { kind: "alone", label: `Fits alone on ${roomiest.name}` };
  if (room.haveMiB > 0 && need <= room.haveMiB * 0.9) return { kind: "pool", label: "Fits the pool" };
  if (room.haveMiB > 0 && need <= room.haveMiB) return { kind: "tight", label: "Tight" };
  if (room.uncounted.length) return { kind: "more", label: room.haveMiB > 0 ? `Needs ${mibText(need - room.haveMiB)} more` : `Needs ${mibText(need)}` };
  if (room.haveMiB <= 0) return null;
  return { kind: "big", label: "Too big" };
}

export const FIT_PILL: Record<FitKind, string> = { alone: "green", pool: "blue", tight: "orange", more: "orange", big: "red" };

/**
 * How full the chosen model leaves the pool: the fit bar's color. "maybe": it needs more than the GPUs the hub can
 * count, and a machine taking part can't be counted (a PC), so it may still fit.
 */
export function fitTone(fit: Pick<PoolFit, "needMiB" | "haveMiB" | "fits">, uncounted = 0): "good" | "tight" | "maybe" | "over" {
  if (!fit.fits || fit.needMiB > fit.haveMiB) return uncounted > 0 ? "maybe" : "over";
  return fit.needMiB > fit.haveMiB * 0.9 ? "tight" : "good";
}

/** "gaming-pc", "A and B", "A, B and C". */
export function namesText(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function timeLeftText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "under a minute left";
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `about ${h} h ${m} min left` : `about ${h} h left`;
}

/** "42% · 7.1 GB of 16.8 GB · 38 MB/s · about 4 min left". */
export function downloadText(d: NonNullable<PoolStatus["download"]>): string {
  const pct = d.totalBytes > 0 ? `${Math.min(100, Math.floor((d.doneBytes / d.totalBytes) * 100))}%` : null;
  const of = d.totalBytes > 0 ? `${bytesText(d.doneBytes)} of ${bytesText(d.totalBytes)}` : bytesText(d.doneBytes);
  const speed = d.bytesPerSec && d.bytesPerSec > 0 ? `${bytesText(d.bytesPerSec)}/s` : null;
  const left = speed && d.totalBytes > d.doneBytes ? timeLeftText((d.totalBytes - d.doneBytes) / d.bytesPerSec!) : null;
  return [pct, of, speed, left].filter(Boolean).join(" · ");
}

/** "reads 420 tokens/s · writes 18 tokens/s", once there's been a reply. */
export function speedText(speed: PoolStatus["speed"]): string | null {
  if (!speed) return null;
  const n = (x: number) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toLocaleString("en-US");
  const parts = [speed.prompt ? `reads ${n(speed.prompt)} tokens/s` : null, speed.generation ? `writes ${n(speed.generation)} tokens/s` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The context sizes offered (tokens): under 32k, Claude Code's first message alone doesn't fit. */
export const CONTEXT_SIZES = [32768, 65536, 131072, 262144];

/** Claude Code needs about 20k tokens just to start, and chats summarize at three quarters of the context. */
export const CLAUDE_CONTEXT_MIN = 32768;
export const CONTEXT_COMFORT = 65536;

/** "16k", "128k", "1M". */
export function contextLabel(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}M`;
  if (n < 1024) return String(n);
  return `${Math.round(n / 1024)}k`;
}

/** What to do about a problem, from the words the hub used to say what's wrong. */
export interface Recovery {
  kind: "terms" | "token" | "model" | "storage" | "port" | "command" | "machines";
  label: string;
}

// Matched against the hub's own wording (hub/src/pool: "accept the model's terms", "save a Hugging Face token",
// "pick a smaller quant", "Free up space", "pick another port", "run its helper command there (Helper command)",
// "check that it's running and on Tailscale"…).
const RECOVERIES: [RegExp, Recovery][] = [
  [/\bterms\b/i, { kind: "terms", label: "Open the model's page" }],
  [/hugging ?face token|\btoken\b|\bgated\b/i, { kind: "token", label: "Add your Hugging Face token" }],
  [/smaller model|another model|choose a model|pick a model|pick the model again|pick a repo|another quant|smaller quant|check the name|too big|doesn'?t fit|does not fit|won'?t fit|ran out of memory/i, { kind: "model", label: "Choose another model" }],
  [/\bdisk\b|free (up )?space|storage|space left/i, { kind: "storage", label: "Free up space" }],
  // The server's port (Advanced), only when the problem names it (recoveriesFor's `serverPort`): a helper's port is
  // the program on that machine that holds it to close, and "give one of them another port" is about two helpers.
  [/pick another port|port \d+ is (already )?(taken|in use)/i, { kind: "port", label: "Change the port" }],
  [/helper command/i, { kind: "command", label: "Show the helper command" }],
  [/check (the|your|its) machines?|check again|offline|can'?t reach|cannot reach|unreachable|not reachable|isn'?t answering|tailscale|helper/i, { kind: "machines", label: "Check the machines" }],
];

/**
 * The fixes a problem's detail names, in the order it names them (at most two). Running a PC's helper command is
 * the fix whenever the hub names it, so it comes first. With `serverPort`, changing the port is offered only when the
 * problem is about that port (the model server's, which Advanced changes).
 */
export function recoveriesFor(detail: string | null | undefined, serverPort?: number): Recovery[] {
  if (!detail) return [];
  // A helper's port held by another program there: closing it is the fix, which nothing here does (Try again after).
  if (/helper's port \d+ is already taken/i.test(detail)) return [];
  const ownPort = serverPort === undefined || new RegExp(`\\bport ${serverPort}\\b`, "i").test(detail);
  return RECOVERIES.map(([re, r]) => ({ r, at: r.kind === "command" ? -1 : detail.search(re), found: re.test(detail) && (r.kind !== "port" || ownPort) }))
    .filter((x) => x.found)
    .sort((a, b) => a.at - b.at)
    .slice(0, 2)
    .map((x) => x.r);
}

/** A model's files on the main machine, together: a split model's parts as one, unfinished ones said. */
export interface PoolDownload {
  /** "owner/repo/file" of each part (what POST /api/pool/model/remove takes). */
  files: string[];
  repo: string;
  /** The file's name (a split model's first part), and its quant when the name says it. */
  name: string;
  bytes: number;
  partial: boolean;
}

const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** The main machine's model files (PoolView.mainFiles) as downloads, biggest first. */
export function downloadsOf(files: PoolModelFile[] | null | undefined): PoolDownload[] {
  const groups = new Map<string, PoolDownload>();
  for (const f of files ?? []) {
    const parts = f.file.split("/");
    if (parts.length < 3) continue;
    const repo = parts.slice(0, 2).join("/");
    const path = parts.slice(2).join("/");
    const split = SPLIT.exec(path);
    const key = `${repo}\u0000${split ? split[1] : path}`;
    const g = groups.get(key) ?? { files: [], repo, name: fileName(split ? `${split[1]}.gguf` : path), bytes: 0, partial: false };
    g.files.push(f.file);
    g.bytes += f.bytes;
    g.partial ||= f.partial;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, files: [...new Set(g.files)].sort() })).sort((a, b) => b.bytes - a.bytes);
}

/** A download is the chosen model's (it can't be removed while the pool runs). */
export const isChosenDownload = (d: PoolDownload, model: PoolModel | null) => !!model && d.repo === model.repo && d.files.some((f) => model.files.some((x) => f === `${model.repo}/${x}`));

/**
 * The PC a problem is about, when its detail names one in the pool (the longest name that fits, so "PC" doesn't win
 * over "PC 2"): its helper command is what to run.
 */
export function computerNamed(detail: string | null | undefined, machines: PoolMachine[]): PoolMachine | null {
  if (!detail) return null;
  return machines.filter((m) => m.kind === "computer" && m.name && detail.includes(m.name)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

/**
 * A Tailscale IPv4 address (100.64.0.0/10): helpers bind to it, so a name or another address won't do. Written
 * plainly, without leading zeros, as the hub takes it.
 */
export function isTailscaleIPv4(s: string): boolean {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return false;
  if (m.slice(1).some((o) => String(Number(o)) !== o)) return false;
  const [b, c, d] = m.slice(1).map(Number);
  return b >= 64 && b <= 127 && c <= 255 && d <= 255;
}

/** A Tailscale peer's OS ("windows", "linux", "macOS"…) as the pool names it; phones and others can't be helpers. */
export function peerOs(os: string | null | undefined): PoolMachine["os"] {
  const s = (os ?? "").toLowerCase();
  if (s.startsWith("win")) return "windows";
  if (s.startsWith("linux")) return "linux";
  if (s.startsWith("mac") || s === "darwin") return "macos";
  return null;
}

/** An id for a computer added by its address ("pc_" and 8 letters or digits); works on plain-http pages too. */
export function newComputerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `pc_${Array.from(bytes, (b) => (b % 36).toString(36)).join("")}`;
}

/** The model's name in chats becomes a model id: no spaces. */
export function aliasProblem(alias: string): string | null {
  const a = alias.trim();
  if (!a) return "Give it a name, like pool-model.";
  if (a.length > 64) return "Keep it under 64 letters.";
  // As the hub takes it (hub/src/pool/node.ts ALIAS_RE).
  if (!/^[\w.:-]+$/.test(a)) return "Use letters, numbers, dots, dashes, colons or underscores, without spaces.";
  return null;
}

export function portProblem(port: string): string | null {
  const n = Number(port);
  if (!/^\d+$/.test(port) || n < 1024 || n > 65535) return "Use a port from 1024 to 65535.";
  return null;
}

/**
 * Pool changes go out one at a time, each built from the newest settings: the hub replaces `machines` whole, so two
 * quick switches must not undo each other. While changes are queued, each starts from what the last one returned
 * (events may lag behind it); once the queue is empty, from the screen's current settings again.
 */
export function poolWriter(put: (change: Partial<PoolConfig>) => Promise<PoolView>, current: () => PoolConfig | null) {
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let latest: PoolConfig | null = null;
  return (build: (config: PoolConfig) => Partial<PoolConfig>): Promise<PoolView> => {
    queued++;
    const run = chain.then(async () => {
      const config = latest ?? current();
      if (!config) throw new Error("The model pool hasn't loaded yet. Try again in a moment.");
      const view = await put(build(config));
      latest = view.config;
      return view;
    });
    chain = run
      .catch(() => {})
      .finally(() => {
        if (--queued === 0) latest = null;
      });
    return run;
  };
}

/** The machines with one changed. */
export const withMachine = (config: PoolConfig, id: string, change: Partial<PoolMachine>): PoolMachine[] => config.machines.map((m) => (m.id === id ? { ...m, ...change } : m));

/** Models worth trying, each with a line on what it is. */
export const SUGGESTED_MODELS: { repo: string; note: string; gated?: boolean }[] = [
  { repo: "unsloth/Qwen3.8-27B-GGUF", note: "Qwen3.8 27B: strong all-round. All of it works on every word, so it's slower than the A3B ones below." },
  { repo: "unsloth/Qwen3.6-35B-A3B-GGUF", note: "35B, but only 3B of it works on each word (A3B): quick for its size." },
  { repo: "ggml-org/gpt-oss-20b-GGUF", note: "OpenAI's open 20B: small and quick, fits one 16 GB GPU." },
  { repo: "ornith-ai/Ornith-1.5-35B-A3B-GGUF", note: "Ornith 1.5: 35B, with 3B of it working on each word (A3B)." },
  { repo: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF", note: "Moonshot's Kimi Linear: 48B with 3B working on each word, made for long chats." },
];
