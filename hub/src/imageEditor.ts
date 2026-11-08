// The local AI image editor: ComfyUI with Qwen Image and the phone page (custom node phone_editor), set up
// in <workspace>/ai-models/image-editor. Settings → Image editor switches it on (its start.sh, then one tiny
// edit so the model is in memory before the first real one) and off (the server ends, which frees all its memory).
//
// The server runs on its own: on a Mac a hub restart leaves it as it was (launchd ends only the hub's process group,
// and the server has its own). Under systemd it ends with the hub (same control group), and the restarted hub shows it
// off. One started some other way (a terminal) is found by its port, or by its main.py running from the editor's
// folder, and only ever that process is ended. start.sh must exec the server, as it does.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ImageEditorStatus } from "@crosstalk/shared";
import { EDITOR_NODE, editorDiff, syncEditor, syncWords } from "./editorSource";
import { HttpError } from "./engine/engine";
import { logger } from "./util/log";

const log = logger("image-editor");

const TIMING = {
  /** How often a running server is looked at: still there, its memory, whether it's editing. */
  watchMs: 20_000,
  /** How long the server may take to answer once started (Python and PyTorch load first). */
  startMs: 3 * 60_000,
  /** How long loading the model may take (read from disk the first time after the Mac starts). */
  warmMs: 6 * 60_000,
  /** How long it may take to end before it's made to. */
  stopMs: 15_000,
  /** Between looks at a starting server and a loading model. */
  stepMs: 1000,
};

export interface ImageEditorDeps {
  /** The editor's folder: its start.sh starts the server. */
  dir: string;
  /** The server's output from its last start (its stdout and stderr). */
  logFile: string;
  /** Where the server started from here is noted, so a restarted hub can still end it (none: not kept). */
  pidFile?: string;
  emit: (status: ImageEditorStatus) => void;
  /** This machine's Tailscale IPv4, for the editor's link. */
  tailscaleIp: () => Promise<string | null>;
  /**
   * Put this build's phone page into the install on its own (editorSource.ts). **Off unless asked for.** The install
   * is the user's: their page may be one they edited by hand, and replacing it changes what their phone is served at
   * the next reload. So the hub only ever writes it when someone asked for that moment, never merely because it
   * started. See docs/IMAGE-EDITOR.md.
   */
  syncPage?: boolean;
  /**
   * Asked before the editor is switched on, with what one edit needs in memory (null when that can't be worked out):
   * the memory guard (memory.ts) throws, in plain words, when it won't fit beside what already runs. Not set: nothing
   * is checked. A server already running when the hub started is never re-checked -- it is not the hub's to refuse.
   */
  beforeStart?: (need: number | null, force: boolean) => Promise<void>;
  timing?: Partial<typeof TIMING>;
}

type State = ImageEditorStatus["state"];

/** The warm-up's client id in the server's queue: it's no one's edit. */
const WARMUP_CLIENT = "crosstalk-hub";

const FIRST_EDIT = "The model loads with the first edit, so that one takes longer.";

/** A small gray picture: the tiny edit that loads the model edits this. */
const WARMUP_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAB+UlEQVR42u3TMQ0AAAzDsEIv9N7DMBtCpKTwWCTAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAbAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGgGs8MBaBo6VkSAAAAABJRU5ErkJggg==";

/** The models the editor page uses (its MODELS), so the warm-up loads exactly those. */
export function editorModels(html: string): { unet: string; clip: string; vae: string } | null {
  const block = /const MODELS\s*=\s*\{([^}]*)\}/.exec(html)?.[1];
  if (!block) return null;
  const name = (key: string) => new RegExp(`\\b${key}\\s*:\\s*(['"])([^'"]+)\\1`).exec(block)?.[2] ?? null;
  const unet = name("unet");
  const clip = name("clip");
  const vae = name("vae");
  return unet && clip && vae ? { unet, clip, vae } : null;
}

/** Where ComfyUI keeps each kind of model: both the older folder names and the ones it uses now. */
const MODEL_DIRS: Record<"unet" | "clip" | "vae", string[]> = {
  unet: ["unet", "diffusion_models"],
  clip: ["clip", "text_encoders"],
  vae: ["vae"],
};

/**
 * How much more memory the weights take than their files do, and ComfyUI's own room for the run.
 *
 * Measured from the editor's own log: files of 4,199 + 5,028 + 676 MB = 9.22 GiB
 * loaded as 4,197 + 7,938 + 644 MB = 12.48 GiB resident (a Q4 text encoder is unpacked as it loads), so x1.35. On top
 * of that ComfyUI holds `minimum_inference_memory()` = 0.8 GiB plus its 400 MB default `--reserve-vram`, which is why
 * the extra room is 1.2 GiB. So one edit wants 13.7 GiB: too much for a 16 GiB machine already holding a 7.5 GB chat
 * model.
 */
export const EDITOR_LOAD = 1.35;
export const EDITOR_ROOM = Math.round(1.2 * 1024 ** 3);

/**
 * What one edit needs in memory: the three models the page names, as they weigh once loaded, plus ComfyUI's own room.
 * Null when the page or its files can't be read -- then nothing is claimed and nothing is held back.
 */
export function editorNeedBytes(dir: string): number | null {
  let models: { unet: string; clip: string; vae: string } | null = null;
  try {
    models = editorModels(readFileSync(join(dir, EDITOR_NODE, "editor.html"), "utf8"));
  } catch {
    return null;
  }
  if (!models) return null;
  let bytes = 0;
  for (const kind of ["unet", "clip", "vae"] as const) {
    const name = models[kind];
    // A name may itself hold a folder ("qwen/model.gguf"); only the file's own size is wanted, never a path out of here.
    if (!name || name.includes("..")) return null;
    const found = MODEL_DIRS[kind]
      .map((sub) => join(dir, "ComfyUI", "models", sub, name))
      .map((path) => {
        try {
          return statSync(path).size;
        } catch {
          return 0;
        }
      })
      .find((size) => size > 0);
    if (!found) return null;
    bytes += found;
  }
  return Math.round(bytes * EDITOR_LOAD) + EDITOR_ROOM;
}

/** The editor page's workflow, as small as it goes (256 pixels, one step), ending in a preview nothing keeps. */
export function warmupWorkflow(models: { unet: string; clip: string; vae: string }, image: string): Record<string, unknown> {
  return {
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: models.unet } },
    "2": { class_type: "CLIPLoaderGGUF", inputs: { clip_name: models.clip, type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: models.vae } },
    "4": { class_type: "LoadImage", inputs: { image } },
    "5": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], prompt: "a gray square", negative_prompt: "", vae: ["3", 0], resolution: 256, "images.image_1": ["4", 0] } },
    "6": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["5", 0], negative: ["5", 1], latent_image: ["5", 2], seed: 1, steps: 1, cfg: 1.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0 } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
    "8": { class_type: "PreviewImage", inputs: { images: ["7", 0] } },
  };
}

/**
 * What's in the server's queue (GET /queue: items are [number, prompt_id, prompt, extra_data, outputs]): people's
 * edits, running or waiting, and the hub's own warm-ups (by their client id), which aren't anyone's.
 */
export function queueContents(queue: unknown): { edits: number; warmups: string[] } {
  const q = (queue && typeof queue === "object" ? queue : {}) as { queue_running?: unknown; queue_pending?: unknown };
  const items = [q.queue_running, q.queue_pending].flatMap((l) => (Array.isArray(l) ? l : []));
  let edits = 0;
  const warmups: string[] = [];
  for (const item of items) {
    const id = Array.isArray(item) && typeof item[1] === "string" ? item[1] : null;
    const extra = Array.isArray(item) && item[3] && typeof item[3] === "object" ? (item[3] as { client_id?: unknown }) : null;
    if (id && extra?.client_id === WARMUP_CLIENT) warmups.push(id);
    else edits++;
  }
  return { edits, warmups };
}

/** The port start.sh gives the server (`--port 8188`). */
export function startPort(script: string): number {
  const port = Number(/--port[=\s]+(\d{2,5})\b/.exec(script)?.[1] ?? 8188);
  return port > 0 && port < 65536 ? port : 8188;
}

/** "Footprint: 2236 MB" (macOS `footprint`: the memory Activity Monitor shows for the process) in MB. */
export function footprintMB(text: string): number | null {
  const m = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b/.exec(text);
  if (!m) return null;
  const mb = Number(m[1]) * { B: 1 / 1024 ** 2, KB: 1 / 1024, MB: 1, GB: 1024 }[m[2] as "B" | "KB" | "MB" | "GB"];
  return Number.isFinite(mb) ? Math.round(mb) : null;
}

/** The last line of the server's output that says what went wrong, if one does. */
export function lastProblem(logText: string): string | null {
  const lines = logText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /error|exception|killed|denied|not found|no such|address already in use/i.test(l) && !/^traceback/i.test(l));
  return line ? (line.length > 220 ? `${line.slice(0, 219)}…` : line) : null;
}

/** The inodes of sockets listening on `port` in /proc/net/tcp or tcp6 (Linux, where lsof may be missing). */
export function listeningInodes(table: string, port: number): string[] {
  const out: string[] = [];
  for (const line of table.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (f[3] === "0A" && parseInt(f[1].split(":")[1] ?? "", 16) === port && f[9] !== "0") out.push(f[9]);
  }
  return out;
}

const isPrivateIPv4 = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** This machine's address on its home network. */
function lanIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && isPrivateIPv4(a.address)) return a.address;
  }
  return null;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

const within = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** Process numbers in a command's output, never the hub's own. */
const pidsIn = (text: string) => text.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1 && n !== process.pid);

const listDir = (path: string) => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/** A command's output, or null when it isn't on this machine. */
async function output(args: string[], timeoutMs = 5000): Promise<string | null> {
  const bin = args[0].startsWith("/") ? (existsSync(args[0]) ? args[0] : null) : Bun.which(args[0]);
  if (!bin) return null;
  try {
    const p = Bun.spawn([bin, ...args.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    return out;
  } catch {
    return null;
  }
}

const LSOF = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
const PGREP = existsSync("/usr/bin/pgrep") ? "/usr/bin/pgrep" : "pgrep";

/** Where a process runs from. */
export async function cwdOf(pid: number): Promise<string | null> {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    const out = await output([LSOF, "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return out?.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
  }
}

/** The processes listening on a TCP port (lsof, or /proc on Linux without it). */
async function portListeners(port: number): Promise<number[]> {
  const out = await output([LSOF, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (out !== null) return pidsIn(out);
  const inodes = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((f) => {
    try {
      return listeningInodes(readFileSync(f, "utf8"), port);
    } catch {
      return [];
    }
  });
  if (!inodes.length) return [];
  const sockets = new Set(inodes.map((i) => `socket:[${i}]`));
  const found: number[] = [];
  for (const name of listDir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    for (const fd of listDir(`/proc/${name}/fd`)) {
      try {
        if (sockets.has(readlinkSync(`/proc/${name}/fd/${fd}`))) {
          found.push(Number(name));
          break;
        }
      } catch {
        // Gone, or not this user's.
      }
    }
  }
  return found;
}

export class ImageEditor {
  private readonly t: typeof TIMING;
  private state: State = "off";
  private detail: string | null = null;
  private failed: ImageEditorStatus["failed"] = null;
  private memoryMB: number | null = null;
  private busy = false;
  private url: string | null = null;
  /** Counts state changes: a look at the server that took a while is dropped if the state moved meanwhile. */
  private version = 0;
  /** What's starting it or loading its model, ended by turning it off. */
  private job: AbortController | null = null;
  private stopping: Promise<void> | null = null;
  /** The server the hub started (this run, or a hub before a restart): its process group ends with it. */
  private started: number | null = null;
  private child: ChildProcess | null = null;
  /** How the server this hub started last ended, when a signal ended it (from outside). */
  private ended: NodeJS.Signals | null = null;
  /** The page in the repo differs from the installed one, and an edit was running when it was last tried. */
  private pageWaiting = false;
  /** One look at the page at a time: it is started from the watcher as well as from start and switch-on. */
  private syncing = false;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private sent = "";

  constructor(private deps: ImageEditorDeps) {
    this.t = { ...TIMING, ...deps.timing };
  }

  private get startScript() {
    return join(this.deps.dir, "start.sh");
  }

  installed(): boolean {
    return existsSync(this.startScript);
  }

  private port(): number {
    try {
      return startPort(readFileSync(this.startScript, "utf8"));
    } catch {
      return 8188;
    }
  }

  private base() {
    return `http://127.0.0.1:${this.port()}`;
  }

  /**
   * At hub start: a server running already (a restart left it, or it was started some other way) shows as on; one
   * still loading the model, or still starting, is waited for.
   */
  async start(): Promise<void> {
    // Looked at even before it's set up: one set up while the hub runs is watched too.
    this.watcher ??= setInterval(() => void this.watch(), this.t.watchMs);
    this.watcher.unref?.();
    if (!this.installed()) return;
    void this.syncPage();
    const v = this.version;
    this.started = await this.noted();
    this.url = await this.urlNow();
    if (await this.answering()) {
      const m = await this.measured();
      if (v !== this.version) return;
      // A warm-up a hub before this one sent is still running: it's waited for.
      if (m.warmups.length) return this.begin(false, m.warmups[0]);
      this.memoryMB = m.memoryMB;
      this.busy = m.busy;
      this.setState("ready", null);
      return;
    }
    const starting = this.started ?? (await this.listener()) ?? (await this.folderServer());
    if (starting && v === this.version) this.begin(false);
  }

  /**
   * Puts this build's phone page into the install (editorSource.ts). Never starts, stops or signals anything: a
   * running server serves the new page the next time a device opens it. While someone's edit is running -- or while
   * the server can't say whether one is -- the page is left alone and put in place later, so a reload in the middle
   * of an edit can't swap the page under them. Does nothing at all unless `deps.syncPage` asked for it.
   */
  private async syncPage(): Promise<void> {
    if (!this.deps.syncPage || !this.installed() || this.syncing) return;
    this.syncing = true;
    try {
      await this.syncNow();
    } catch (e) {
      log.warn(`the editor page: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.syncing = false;
    }
  }

  private async syncNow(): Promise<void> {
    const diff = editorDiff(this.deps.dir);
    if (diff.problem) {
      this.pageWaiting = false;
      log.warn(`the editor page: ${diff.problem}`);
      return;
    }
    if (!diff.changed.length) {
      this.pageWaiting = false;
      return;
    }
    if (await this.answering()) {
      // An unreadable queue counts as busy. A server loading ~10 GB of models blocks its own event loop, so /queue
      // times out exactly when an edit is most likely to be running; reading that as "nothing running" would swap
      // the page under that edit. Waiting costs a watcher tick; guessing costs someone's edit.
      const q = await this.queue();
      if (!q || q.edits > 0) {
        const why = q ? "nothing is being edited" : "it can say what it's doing";
        if (!this.pageWaiting) log.info(`the editor page is newer than the installed one (${diff.changed.join(", ")}); it goes in when ${why}`);
        this.pageWaiting = true;
        return;
      }
    }
    this.pageWaiting = false;
    const said = syncWords(syncEditor(this.deps.dir));
    if (said) log.info(said);
  }

  /** The hub is stopping: the server stays as it is (on, or still starting: the next hub carries on). */
  shutdown() {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    this.job?.abort();
    this.job = null;
    this.child?.removeAllListeners("exit");
    this.child = null;
  }

  /** What Settings shows (GET /api/image-editor): the server is looked at first, as it may have been started or stopped some other way. */
  async status(): Promise<ImageEditorStatus> {
    await this.lookUpUrl();
    await this.watch(false);
    return this.snapshot();
  }

  /** What it was last seen doing, with no fresh look at the server: for the memory guard, which must stay cheap. */
  lastStatus(): ImageEditorStatus {
    return this.snapshot();
  }

  /**
   * What the memory guard counts for the editor, with no look at the server (`editorNeedBytes` weighs three files).
   *
   *  - `bytes` while it is on: what it holds, or what one edit needs, whichever is bigger. Bigger matters twice. For
   *    the nine minutes it is starting and loading (`startMs` + `warmMs`) nothing has measured it, and that window is
   *    exactly when a second model used to be allowed beside it -- the pairing that doesn't fit, allowed again. And an idle
   *    ComfyUI that has unloaded its models reads small now while the next edit still wants all of it.
   *  - `port` when the hub knows of nothing of its own running: a ComfyUI the person started themselves listens
   *    there, and the guard measures it like any other server it didn't start (the switch in Settings can turn that
   *    one off too, which is why it is still "ours").
   */
  heavy(): { bytes: number | null; port: number | null } {
    const on = this.state !== "off" && this.state !== "error";
    const measured = on && this.memoryMB !== null ? this.memoryMB * 1024 ** 2 : 0;
    const most = on ? Math.max(measured, editorNeedBytes(this.deps.dir) ?? 0) : 0;
    return most > 0 ? { bytes: most, port: null } : { bytes: null, port: this.port() };
  }

  private snapshot(): ImageEditorStatus {
    const on = this.state !== "off" && this.state !== "error";
    return {
      installed: this.installed(),
      state: this.state,
      detail: this.detail,
      failed: this.state === "error" ? this.failed : null,
      url: this.url,
      memoryMB: on ? this.memoryMB : null,
      busy: on && this.busy,
    };
  }

  /**
   * Switches it on or off (POST /api/image-editor); what follows comes as `imageEditor` events. Turning it off while
   * people's edits are running or waiting says so (409 "busy") unless `force`; switching it on when its models won't
   * fit beside what else is running says so (409 "memory"), unless `force` -- both are the same "do it anyway" tap.
   */
  async set(on: boolean, force = false): Promise<ImageEditorStatus> {
    if (!this.installed()) throw new HttpError(404, "The image editor isn't set up on this machine.", "not_installed");
    if (on) {
      void this.syncPage();
      if (this.state === "stopping") throw new HttpError(409, "It's still turning off. Try again in a moment.", "stopping");
      if (this.state === "off" || this.state === "error") {
        // Does one edit fit beside what already runs here? The guard throws in plain words when it doesn't, and
        // `force` is the person's "start it anyway" (the machine is theirs). Nothing has been started yet.
        if (this.deps.beforeStart) await this.deps.beforeStart(editorNeedBytes(this.deps.dir), force);
        this.begin(true);
      }
      return this.snapshot();
    }
    if (this.state === "stopping") return this.snapshot();
    if (this.state === "error" && this.failed !== "stop") {
      // Turning off what didn't start clears the problem (nothing runs: a start that failed ends what it started).
      this.setState("off", null);
      return this.snapshot();
    }
    if ((this.state === "ready" || this.state === "loading") && !force && ((await this.queue())?.edits ?? 0) > 0) {
      throw new HttpError(409, "It's working on an edit. Turning it off now stops that edit.", "busy");
    }
    if (this.state !== "off" || this.started || (await this.answering())) void this.stop();
    return this.snapshot();
  }

  // ---- Starting and loading ----

  /** Starts the server unless one runs or is starting (`launchIt`), then loads the model, or waits for `warmup`. */
  private begin(launchIt: boolean, warmup?: string) {
    this.job?.abort();
    const job = new AbortController();
    this.job = job;
    if (warmup) this.setState("loading", "Loading the model…");
    else this.setState("starting", "Starting the server…");
    void this.run(job.signal, launchIt, warmup)
      .catch((e) => {
        if (job.signal.aborted) return;
        log.warn(`couldn't start: ${e instanceof Error ? e.message : e}`);
        this.fail(`Couldn't start it: ${e instanceof Error ? e.message : String(e)}.`);
      })
      .finally(() => {
        if (this.job === job) this.job = null;
      });
  }

  private async run(signal: AbortSignal, launchIt: boolean, warmup?: string) {
    let id = warmup ?? null;
    if (!id) {
      if (!(await this.answering(signal))) {
        if (signal.aborted) return;
        // One running or starting already isn't started twice (two servers on one port, and its log emptied).
        let pid = this.started && alive(this.started) ? this.started : ((await this.listener()) ?? (await this.folderServer()));
        if (signal.aborted) return;
        if (!pid && launchIt) pid = this.launch();
        if (!pid) return this.fail(this.stoppedText("It stopped while starting", false));
        const ours = pid === this.started;
        const until = Date.now() + this.t.startMs;
        while (!(await this.answering(signal))) {
          if (signal.aborted) return;
          if (!alive(pid)) {
            // Its exit is handled first, so how it ended is known.
            await sleep(50);
            if (signal.aborted) return;
            if (ours) this.forget();
            return this.fail(this.stoppedText("It stopped while starting", ours));
          }
          if (Date.now() > until) {
            // Not left running without answering: what was started is ended, so it's stopped as the card says.
            const target = await this.serverProcess();
            if (target) await this.kill(target);
            if (signal.aborted) return;
            const late = `It didn't answer within ${minutes(this.t.startMs)}`;
            if (target && alive(target.pid)) return this.fail(`${late}, and it didn't turn off. Try again, or end it on this machine.`, "stop");
            this.forget();
            return this.fail(`${late}, so it was stopped. Try again, or check its log: ${this.logShown()}`);
          }
          await sleep(this.t.stepMs, signal);
        }
      }
      if (signal.aborted) return;
      this.setState("loading", "Loading the model…");
    }
    let problem: string | null = null;
    if (!id) {
      const queued = await this.queueWarmup(signal).catch((e) => ({ problem: e instanceof Error ? e.message : String(e) }));
      if (signal.aborted) return;
      if ("id" in queued) id = queued.id;
      else problem = queued.problem;
    }
    if (id) {
      const done = await this.awaitPrompt(id, signal);
      if (signal.aborted) return;
      if (done === "gone") {
        const ours = this.started !== null;
        this.forget();
        return this.fail(this.stoppedText("It stopped while loading the model", ours));
      }
      problem = done;
    }
    if (problem) log.warn(`loading the model: ${problem}`);
    const v = this.version;
    const m = await this.measured();
    if (signal.aborted || v !== this.version) return;
    this.memoryMB = m.memoryMB;
    this.busy = m.busy;
    this.setState("ready", problem ? FIRST_EDIT : null);
  }

  /** Runs start.sh on its own (its own process group, outliving the hub), its output going to the log. */
  private launch(): number {
    mkdirSync(dirname(this.deps.logFile), { recursive: true });
    const fd = openSync(this.deps.logFile, "w");
    try {
      const script = this.startScript;
      const runnable = (statSync(script).mode & 0o111) !== 0;
      const env: Record<string, string> = {};
      for (const k of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) if (process.env[k]) env[k] = process.env[k]!;
      const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
      const child = spawn(runnable ? script : shell, runnable ? [] : [script], { cwd: this.deps.dir, detached: true, stdio: ["ignore", fd, fd], env });
      child.unref();
      child.on("error", (e) => log.warn(`start.sh: ${e.message}`));
      if (!child.pid) throw new Error("start.sh didn't run");
      const pid = child.pid;
      this.child = child;
      this.started = pid;
      this.ended = null;
      child.on("exit", (_code, signal) => {
        if (this.child === child) this.child = null;
        if (this.started !== pid) return;
        this.ended = signal;
        this.forget();
        // Ended by itself (not turned off; while starting, the start notices): what it said last says why.
        if (this.state === "ready" || this.state === "loading") {
          const what = this.state === "loading" ? "It stopped while loading the model" : "It stopped";
          this.job?.abort();
          this.job = null;
          this.fail(this.stoppedText(what, true));
        }
      });
      if (this.deps.pidFile) {
        try {
          writeFileSync(this.deps.pidFile, JSON.stringify({ pid, dir: this.deps.dir }), { mode: 0o600 });
        } catch (e) {
          // Only a restarted hub needs it, to end this server; without it, the server is still found by its port.
          log.warn(`couldn't note the server: ${e instanceof Error ? e.message : e}`);
        }
      }
      return pid;
    } finally {
      closeSync(fd);
    }
  }

  /** Sends one tiny edit with the editor's own models, so they're in memory before the first real edit. */
  private async queueWarmup(signal: AbortSignal): Promise<{ id: string } | { problem: string }> {
    let models: ReturnType<typeof editorModels> = null;
    try {
      models = editorModels(readFileSync(join(this.deps.dir, EDITOR_NODE, "editor.html"), "utf8"));
    } catch {
      models = null;
    }
    if (!models) return { problem: "the editor page doesn't say which models it uses" };
    const base = this.base();
    const form = new FormData();
    form.append("image", new Blob([Buffer.from(WARMUP_PNG, "base64")], { type: "image/png" }), "crosstalk-warmup.png");
    form.append("overwrite", "true");
    const up = await fetch(`${base}/upload/image`, { method: "POST", body: form, signal: within(30_000, signal) });
    if (!up.ok) return { problem: `the picture wasn't taken (${up.status})` };
    const saved = (await up.json().catch(() => ({}))) as { name?: string; subfolder?: string };
    if (!saved.name) return { problem: "the picture wasn't taken" };
    const image = saved.subfolder ? `${saved.subfolder}/${saved.name}` : saved.name;
    const queued = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: warmupWorkflow(models, image), client_id: WARMUP_CLIENT }),
      signal: within(30_000, signal),
    });
    const q = (await queued.json().catch(() => ({}))) as { prompt_id?: string; error?: { message?: string } };
    if (!queued.ok || !q.prompt_id) return { problem: q.error?.message ?? `the edit wasn't taken (${queued.status})` };
    return { id: q.prompt_id };
  }

  /** Waits for a warm-up to finish: null when it did, what went wrong, or "gone" when the server went. */
  private async awaitPrompt(id: string, signal: AbortSignal): Promise<string | null | "gone"> {
    const base = this.base();
    const until = Date.now() + this.t.warmMs;
    try {
      while (Date.now() < until) {
        await sleep(this.t.stepMs, signal);
        if (signal.aborted) return null;
        const r = await fetch(`${base}/history/${encodeURIComponent(id)}`, { signal: within(10_000, signal) }).catch(() => null);
        if (signal.aborted) return null;
        if (!r) {
          // No answer: busy, or gone.
          if (this.started ? !alive(this.started) : !(await this.listener())) return "gone";
          continue;
        }
        if (!r.ok) continue;
        type Entry = { status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] } };
        const h = ((await r.json().catch(() => ({}))) as Record<string, Entry>)[id];
        if (!h) continue;
        if (h.status?.status_str === "error") return h.status.messages?.find((m) => m[0] === "execution_error")?.[1]?.exception_message ?? "the edit failed";
        if (h.status?.completed || h.status?.status_str === "success") return null;
      }
      return `the model took more than ${minutes(this.t.warmMs)} to load`;
    } finally {
      // Its entry in the server's history isn't anyone's edit.
      if (!signal.aborted) void fetch(`${base}/history`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [id] }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }

  // ---- Stopping ----

  private stop(): Promise<void> {
    this.stopping ??= this.end().finally(() => (this.stopping = null));
    return this.stopping;
  }

  private async end() {
    this.job?.abort();
    this.job = null;
    this.setState("stopping", "Turning off…");
    const target = await this.serverProcess();
    if (target) await this.kill(target);
    if (await this.answering()) {
      // Still running: Try again turns it off again, Keep it on leaves it on.
      this.fail(target ? "It didn't turn off. Try again, or end it on this machine." : `Something else answers on port ${this.port()}: end it on this machine, then try again.`, "stop");
      return;
    }
    this.forget();
    this.memoryMB = null;
    this.busy = false;
    this.setState("off", null);
  }

  /** Ends a server's process, then makes it end; never once that number has stopped being the editor's. */
  private async kill(target: { pid: number; group: boolean }) {
    const send = (sig: NodeJS.Signals) => {
      try {
        // What the hub started ends with everything it started; one started some other way, just itself.
        process.kill(target.group ? -target.pid : target.pid, sig);
      } catch {
        // Gone already.
      }
    };
    send("SIGTERM");
    const until = Date.now() + this.t.stopMs;
    while (alive(target.pid) && Date.now() < until) await sleep(200);
    if (alive(target.pid) && (await this.inFolder(target.pid))) send("SIGKILL");
    for (let i = 0; i < 25 && alive(target.pid); i++) await sleep(200);
  }

  /**
   * The server's process: the one the hub started (checked again when a hub before this one started it: its number
   * may have been reused since), else whatever runs the server from the editor's folder.
   */
  private async serverProcess(): Promise<{ pid: number; group: boolean } | null> {
    if (this.started && alive(this.started)) {
      const own = !!this.child && this.child.pid === this.started && this.child.exitCode === null && this.child.signalCode === null;
      if (own || (await this.inFolder(this.started))) return { pid: this.started, group: true };
    }
    if (this.started) this.forget();
    const pid = (await this.listener()) ?? (await this.folderServer());
    return pid ? { pid, group: false } : null;
  }

  /** What listens on the editor's port, if it runs from the editor's folder (nothing else is ever ended). */
  private async listener(): Promise<number | null> {
    for (const pid of await portListeners(this.port())) if (await this.inFolder(pid)) return pid;
    return null;
  }

  /** A server's main.py running from the editor's folder: one still starting isn't listening yet. */
  private async folderServer(): Promise<number | null> {
    for (const pid of pidsIn((await output([PGREP, "-f", "main\\.py"])) ?? "")) if (await this.inFolder(pid)) return pid;
    return null;
  }

  private async inFolder(pid: number): Promise<boolean> {
    const cwd = await cwdOf(pid);
    if (!cwd) return false;
    let real = this.deps.dir;
    try {
      real = realpathSync(this.deps.dir);
    } catch {
      // Gone: nothing runs from it.
    }
    return [this.deps.dir, real].some((d) => cwd === d || cwd.startsWith(d + sep));
  }

  // ---- Looking at it ----

  private async answering(signal?: AbortSignal): Promise<boolean> {
    try {
      const r = await fetch(`${this.base()}/system_stats`, { signal: within(3000, signal) });
      if (!r.ok) return false;
      const j = (await r.json()) as { system?: unknown } | null;
      return !!j && typeof j === "object" && !!j.system;
    } catch {
      return false;
    }
  }

  /** What's in its queue (null when it doesn't answer). */
  private async queue(): Promise<{ edits: number; warmups: string[] } | null> {
    try {
      const r = await fetch(`${this.base()}/queue`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? queueContents(await r.json()) : null;
    } catch {
      return null;
    }
  }

  /** Every so often while it's on (and whenever Settings asks): is it still there, how much memory, is it editing. */
  private async watch(timer = true) {
    if (!this.installed() || this.state === "starting" || this.state === "loading" || this.state === "stopping") return;
    if (timer && this.state === "off") return;
    const v = this.version;
    if (this.pageWaiting) void this.syncPage();
    // The server the hub started is gone: what's noted about it goes too (its number could be reused).
    if (this.started && !alive(this.started)) this.forget();
    const up = await this.answering();
    if (v !== this.version) return;
    if (up) {
      const m = await this.measured();
      if (v !== this.version) return;
      this.memoryMB = m.memoryMB;
      this.busy = m.busy;
      if (this.state !== "ready") this.setState("ready", null);
      else this.publish();
      return;
    }
    if (this.state === "ready") {
      // Not answering, but still there: busy, say. It's looked at again next time.
      if ((this.started && alive(this.started)) || (await this.listener())) return;
      if (v !== this.version) return;
      const ours = this.started !== null;
      this.forget();
      if (ours) return this.fail(this.stoppedText("It stopped", true));
      // One started some other way was stopped the same way.
      this.memoryMB = null;
      this.busy = false;
      this.setState("off", null);
      return;
    }
    // Off, but one is starting (started some other way): it's waited for and its model loaded, as switching on would.
    if (!timer && this.state === "off" && ((await this.listener()) ?? (await this.folderServer())) && v === this.version) this.begin(false);
  }

  /** Its memory (what Activity Monitor shows), whether people's edits are running or waiting, and warm-ups. */
  private async measured(): Promise<{ memoryMB: number | null; busy: boolean; warmups: string[] }> {
    const pid = (await this.listener()) ?? (this.started && alive(this.started) ? this.started : null);
    let mb: number | null = null;
    if (pid) {
      try {
        const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
        mb = Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null;
      } catch {
        mb = footprintMB((await output(["/usr/bin/footprint", "-p", String(pid)])) ?? "");
      }
    }
    const q = await this.queue();
    return { memoryMB: mb, busy: (q?.edits ?? 0) > 0, warmups: q?.warmups ?? [] };
  }

  private async urlNow(): Promise<string | null> {
    const host = (await this.deps.tailscaleIp().catch(() => null)) ?? lanIPv4();
    return host ? `http://${host}:${this.port()}/editor` : null;
  }

  private async lookUpUrl() {
    const url = await this.urlNow();
    if (url === this.url) return;
    this.url = url;
    this.publish();
  }

  /** Why a server stopped: for one the hub started, what it said last, or that it was ended from outside. */
  private stoppedText(what: string, ours: boolean) {
    if (!ours) return `${what}.`;
    let said: string | null = null;
    try {
      said = lastProblem(readFileSync(this.deps.logFile, "utf8").slice(-8000));
    } catch {
      said = null;
    }
    const how = said ?? (this.ended === "SIGKILL" ? "it was force-quit" : this.ended ? "it was quit" : null);
    return `${what}${how ? `: ${how}` : ""}. Its log: ${this.logShown()}`;
  }

  /** The log's path as people write it (~/Library/Logs/…). */
  private logShown() {
    const home = homedir();
    return this.deps.logFile.startsWith(home + sep) ? `~${this.deps.logFile.slice(home.length)}` : this.deps.logFile;
  }

  // ---- State ----

  /** The server a hub started before this one, if it's still running from the editor's folder. */
  private async noted(): Promise<number | null> {
    if (!this.deps.pidFile) return null;
    try {
      const n = JSON.parse(readFileSync(this.deps.pidFile, "utf8")) as { pid?: unknown; dir?: unknown };
      if (typeof n.pid === "number" && n.dir === this.deps.dir && alive(n.pid) && (await this.inFolder(n.pid))) return n.pid;
    } catch {
      // Nothing noted.
    }
    rmSync(this.deps.pidFile, { force: true });
    return null;
  }

  private forget() {
    this.started = null;
    if (this.deps.pidFile) rmSync(this.deps.pidFile, { force: true });
  }

  /** A problem: starting it didn't work (nothing runs), or turning it off didn't (it still runs). */
  private fail(detail: string, failed: "start" | "stop" = "start") {
    this.memoryMB = null;
    this.busy = false;
    this.setState("error", detail, failed);
  }

  private setState(state: State, detail: string | null, failed: ImageEditorStatus["failed"] = null) {
    this.version++;
    this.state = state;
    this.detail = detail;
    this.failed = state === "error" ? failed : null;
    this.publish();
  }

  /** Sends the state when it changed (memory in tenths of a GB, so small moves don't count). */
  private publish() {
    const s = this.snapshot();
    const key = JSON.stringify({ ...s, memoryMB: s.memoryMB === null ? null : Math.round(s.memoryMB / 100) });
    if (key === this.sent) return;
    this.sent = key;
    this.deps.emit(s);
  }
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`);
