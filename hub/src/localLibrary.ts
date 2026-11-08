// Settings → Local models, getting models: what this machine has for them (the "fits this machine?" verdict's inputs),
// the folder downloads go to (one the person sees and can change, an external drive too), the GGUF models in it,
// Hugging Face search and downloads (the model pool's resumable, pinned downloads, into that folder) and Ollama's own
// pulls into an Ollama server on this machine. Every download keeps the hub's disk reserve free, can be stopped, and
// picks up where it stopped when started again. The Hugging Face token is the model pool's (this hub's secrets): it
// only ever goes to Hugging Face and is never sent back, logged or kept with a download.

import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { access, open, readFile, stat, statfs } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { LocalDownload, LocalDownloadStart, LocalFolder, LocalLibrary as LibraryView, LocalMachine, LocalModelFile, LocalOllamaInfo, LocalRepoFiles, LocalSearchHit, PoolDevice, PoolModel, PoolModelFile } from "@crosstalk/shared";
import type { App } from "./app";
import { readSecrets } from "./config";
import { HttpError } from "./engine/engine";
import { ggufMetadata, kvShape, type KvShape } from "./gguf";
import { localRunnersOf } from "./localRunners";
import { errText, gb, listDevices } from "./pool/llama";
import { checkModel, choices, download, downloadingBy, DOWNLOADERS, existingParent, fileHead, groupModels, haveModel, hfBase, hfFetch, modelFiles, modelFilesIn, modelFilesOnDisk, modelsDir, mountPoint, quantOf, repoError, spaceFor, splitModelFile, toTrash, type TrashOptions } from "./pool/models";
import { gpuName, HF_SECRET } from "./pool/pool";
import { diskSpace } from "./storage";
import { diskReserve } from "./uploads";
import { logger } from "./util/log";

const log = logger("local-models");

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
/** kv: the folder downloads go to (absent: Crosstalk's models folder, the pool's). */
const FOLDER_KEY = "localModels.folder";
/** kv: downloads that aren't finished, so a stopped one can be picked up again after a restart. */
const DOWNLOADS_KEY = "localModels.downloads";
/** How much of a GGUF file is read for its header: the shape comes well before the tokenizer's lists. */
const HEAD_BYTES = 1024 * 1024;
/** Downloads running at once. */
const MAX_RUNNING = 3;
/** A GPU list from a llama-server found here (not the pool's) is asked again after this long. */
const DEVICES_TTL = 10 * 60_000;
/**
 * The page looks at the library every second while a download runs: the machine's facts (which may run llama.cpp to
 * list the GPUs) are kept a minute and looked at again behind the scenes, and the free ports ten seconds.
 */
const MACHINE_TTL = 60_000;
const PORTS_TTL = 10_000;
/** The folder's models are kept this long between looks (a whole drive may have been chosen), unless something changed them. */
const FILES_TTL = 5_000;
/** A look at the folder is used this long: the page asks every second while something runs, and requests at once share one. */
const LOOK_TTL = 900;
/** Ollama's model names: "qwen3:8b", "user/model:tag", "hf.co/owner/repo:Q4_K_M". */
const OLLAMA_NAME = /^(?!.*\.\.)[A-Za-z0-9][\w.\-/:]{0,199}$/;
/** Where drives are mounted: /Volumes on a Mac; /media, /run/media and /mnt on Linux. */
const DRIVE_DIRS = ["/Volumes", "/run/media", "/media", "/mnt"];
/** The folder the system makes for a drive as it's plugged in, and takes away when it's unplugged: /Volumes/<name>, /run/media/<user>/<name>, /media/<user>/<name>. */
const AUTO_MOUNTS = [/^\/Volumes\/[^/]+/, /^\/run\/media\/[^/]+\/[^/]+/, /^\/media\/[^/]+\/[^/]+/];

const shown = (path: string) => {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};
const dev = (path: string): number | null => {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
};

// ---- What this machine has ----

/**
 * The machine's memory for models. Apple silicon shares it with the GPU up to Metal's working set, which llama.cpp
 * reports as its GPU's size (read it, don't work it out); without llama.cpp yet it's about two thirds of the memory up
 * to 36 GB and three quarters above (what macOS gives by default). Elsewhere, the GPUs' free memory as llama.cpp lists
 * it, or none (models then run on the processor, in the memory).
 */
export function machineFrom(ramBytes: number, unified: boolean, devices: PoolDevice[]): LocalMachine {
  const gpus = devices.map((d) => ({ name: gpuName(d.description), totalBytes: d.totalMiB * MiB, freeBytes: d.freeMiB * MiB }));
  if (unified) {
    const metal = devices.find((d) => /^MTL\d/.test(d.name) && d.totalMiB > 0);
    if (metal) return { ramBytes, unified, gpuBytes: metal.totalMiB * MiB, gpuFrom: "llama.cpp", gpus };
    return { ramBytes, unified, gpuBytes: Math.round(ramBytes * (ramBytes <= 36 * GiB ? 2 / 3 : 3 / 4)), gpuFrom: "estimate", gpus };
  }
  const free = devices.filter((d) => !/^(MTL|BLAS|CPU)/i.test(d.name)).reduce((n, d) => n + Math.max(0, d.freeMiB) * MiB, 0);
  return { ramBytes, unified, gpuBytes: free > 0 ? free : null, gpuFrom: free > 0 ? "llama.cpp" : null, gpus };
}

// ---- The folder ----

/**
 * The removable drive a path is on ("/Volumes/Untitled"), and whether it's plugged in (mounted) now; null for this
 * machine's own disks. Plugged in: the path is on a drive mounted in one of the places drives go (wherever in there:
 * /mnt/data/disk2 too). Not plugged in: the folder the system makes for the drive is missing (or a plain folder on this
 * disk, which downloads would fill), or this machine's fstab mounts a drive there and it isn't. Anything else under
 * /mnt is a folder on this disk.
 */
export function driveOf(path: string, deviceOf: (p: string) => number | null = dev, listed: () => string[] = fstabMounts): { mount: string; name: string; mounted: boolean } | null {
  const dir = DRIVE_DIRS.find((d) => path.startsWith(d + sep));
  if (!dir) return null;
  const mount = mountPoint(path, deviceOf);
  if (mount && mount.startsWith(dir + sep)) return { mount, name: basename(mount), mounted: true };
  const fstab = listed().filter((m) => m.startsWith(dir + sep) && (path === m || path.startsWith(m + sep))).sort((a, b) => b.length - a.length)[0];
  const gone = fstab ?? AUTO_MOUNTS.map((re) => re.exec(path)?.[0]).find((m): m is string => !!m);
  return gone ? { mount: gone, name: basename(gone), mounted: false } : null;
}

/** The mount points an fstab names (Linux): drives this machine mounts by itself. */
const fstabParse = (text: string): string[] =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .map((l) => l.trim().split(/\s+/)[1] ?? "")
    .filter((m) => m.startsWith("/"))
    .map((m) => m.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))).replace(/\/+$/, "") || "/");

function fstabMounts(): string[] {
  try {
    return fstabParse(readFileSync("/etc/fstab", "utf8"));
  } catch {
    return [];
  }
}

/** A path as typed ("~/Models", "/Volumes/Untitled/models"), checked and made absolute. */
export function checkFolder(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.length > 1024 || /[\u0000-\u001f]/.test(raw)) throw new HttpError(400, "Type the folder's full path, like ~/Models or /Volumes/Untitled/models.");
  const path = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(path)) throw new HttpError(400, "Type the folder's full path, starting with / or ~/ (like ~/Models).");
  return resolve(path);
}

/** Why downloads can't go to this folder now, in plain words with what to do; null when they can. */
export function folderProblem(path: string, deviceOf: (p: string) => number | null = dev): string | null {
  const drive = driveOf(path, deviceOf);
  if (drive && !drive.mounted) return problemFrom(path, drive, "missing", false);
  let kind: Kind = "missing";
  if (existsSync(path)) {
    try {
      kind = statSync(path).isDirectory() ? "dir" : "file";
    } catch {
      return `Crosstalk can't look in ${shown(path)}: pick another folder.`;
    }
  }
  let writable = true;
  try {
    accessSync(existingParent(path), constants.W_OK);
  } catch {
    writable = false;
  }
  return problemFrom(path, drive, kind, writable);
}

type Kind = "missing" | "dir" | "file";

/** Why downloads can't go to a folder, from what's known of it: its drive, what's at its path, and whether the nearest folder there takes a write. */
function problemFrom(path: string, drive: ReturnType<typeof driveOf>, kind: Kind, writable: boolean): string | null {
  if (drive && !drive.mounted) return `The drive ${drive.name} isn't plugged in: plug it in, or change the folder.`;
  if (kind === "file") return `${shown(path)} is a file, not a folder: pick a folder.`;
  if (!writable) return `Crosstalk can't write to ${shown(path)}${drive ? ` (the drive ${drive.name} may be read-only: a Windows drive is, on a Mac)` : ""}: pick another folder.`;
  return null;
}

/**
 * The folder as folderView shows it, with every look at the disk asynchronous: a drive waking up takes seconds to
 * answer and a network folder that's gone much longer, and the hub mustn't stop answering everyone meanwhile.
 */
export async function folderLater(path: string): Promise<LocalFolder> {
  const chain: string[] = [];
  for (let p = path; ; p = dirname(p)) {
    chain.push(p);
    if (dirname(p) === p) break;
  }
  const stats = new Map(await Promise.all(chain.map(async (p) => [p, await stat(p).catch(() => null)] as const)));
  const deviceOf = (p: string) => stats.get(p)?.dev ?? null;
  const fstab = DRIVE_DIRS.some((d) => path.startsWith(d + sep)) ? await readFile("/etc/fstab", "utf8").then(fstabParse, () => []) : [];
  const drive = driveOf(path, deviceOf, () => fstab);
  const base = { path, shown: shown(path), isDefault: path === modelsDir(), drive: drive?.name ?? null };
  if (drive && !drive.mounted) return { ...base, freeBytes: null, totalBytes: null, problem: problemFrom(path, drive, "missing", false) };
  const here = stats.get(path);
  const kind: Kind = here ? (here.isDirectory() ? "dir" : "file") : "missing";
  const existing = chain.find((p) => stats.get(p)) ?? "/";
  const writable = await access(existing, constants.W_OK).then(() => true, () => false);
  const space = await statfs(existing).then((s) => ({ total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) }), () => null);
  return { ...base, freeBytes: space?.free ?? null, totalBytes: space?.total ?? null, problem: problemFrom(path, drive, kind, writable) };
}

/** A folder that hasn't answered yet, as the page shows it until it does. */
const waitingFor = (path: string): LocalFolder => ({
  path,
  shown: shown(path),
  isDefault: path === modelsDir(),
  drive: null,
  freeBytes: null,
  totalBytes: null,
  problem: `${shown(path)} hasn't answered yet (a drive waking up, or a network folder that's gone?): wait a moment, or change the folder.`,
  pending: true,
});

/** How a write in a folder went, from another process: fine, or what it said (`waited`: it didn't finish in time). */
export type Probe = { ok: true } | { ok: false; waited: boolean; said: string };

/**
 * Makes the folder and writes (and removes) a file in it from another process, within a time limit. On a Mac a drive,
 * or a folder such as Documents or Desktop, makes macOS ask on the screen whether the hub may use it, and the process
 * asking waits for the answer: that mustn't be the hub, which would stop answering everyone meanwhile. (A permission
 * check alone also misses a read-only drive.)
 */
export function probeFolder(path: string, timeoutMs = 8000): Promise<Probe> {
  const script = 'mkdir -p -- "$1" && f="$1/.crosstalk-write-test-$$" && : > "$f" && rm -f -- "$f"';
  return new Promise((done) => {
    let said = "";
    let answered = false;
    const answer = (p: Probe) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      done(p);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // A process group of its own: at the limit the whole group goes (sh, and the mkdir it waits on).
      child = spawn("/bin/sh", ["-c", script, "sh", path], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      return done({ ok: false, waited: false, said: errText(e) });
    }
    // Answered at the limit, without waiting for it to end: one macOS holds for its question (or a network folder
    // that's gone) may not end at once, and holds its output open until it does.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Ended meanwhile.
      }
      answer({ ok: false, waited: true, said: said.trim() });
    }, timeoutMs);
    child.stderr?.on("data", (b: Buffer) => {
      if (said.length < 4000) said += b.toString();
    });
    child.on("error", (e) => answer({ ok: false, waited: false, said: errText(e) }));
    child.on("close", (code) => answer(code === 0 ? { ok: true } : { ok: false, waited: false, said: said.trim() }));
  });
}

/** What a failed write in a folder means, in plain words with what to do. */
export function probeProblem(path: string, probe: Exclude<Probe, { ok: true }>, machine: string, mac = process.platform === "darwin"): string {
  const where = shown(path);
  if (probe.waited) {
    return mac
      ? `macOS is asking on ${machine}'s screen whether Crosstalk may use ${where}: allow it there, then save again.`
      : `${where} didn't answer in time (a drive that's asleep, or a network folder that's gone?): check it, then save again.`;
  }
  if (/read-only file system/i.test(probe.said)) return `${where} is on a read-only drive${mac ? " (a Windows drive is, on a Mac)" : ""}: pick another folder.`;
  if (/no space left/i.test(probe.said)) return `The drive ${where} is on is full: free up space, or pick another folder.`;
  if (mac && /operation not permitted/i.test(probe.said)) return `macOS didn't let Crosstalk use ${where}: allow it in System Settings → Privacy & Security → Files and Folders, then save again.`;
  return `Crosstalk can't write to ${where}: pick another folder.`;
}

// ---- A GGUF file's shape ----

/** The shape of a GGUF file on this machine, from its first bytes. */
function localShape(path: string): KvShape | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = new Uint8Array(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const meta = ggufMetadata(buf.subarray(0, n));
    return meta ? kvShape(meta) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** localShape, without holding up the hub while the disk answers. */
async function shapeLater(path: string): Promise<KvShape | null> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return null;
  try {
    const buf = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const meta = ggufMetadata(buf.subarray(0, bytesRead));
    return meta ? kvShape(meta) : null;
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** What view() shows of the folder: how it stands, the models in it, and what stopped downloads have on disk (by id). */
interface Look {
  folder: LocalFolder;
  files: LocalModelFile[];
  had: Map<string, number>;
}

// ---- Downloads ----

interface Job {
  id: string;
  source: LocalDownload["source"];
  name: string;
  model: PoolModel | null;
  ollama: { model: string; serverId: string } | null;
  /** The folder it downloads into (a later change of folder doesn't move it). */
  root: string;
  state: LocalDownload["state"];
  doneBytes: number;
  totalBytes: number;
  bytesPerSec: number | null;
  error: string | null;
  code: string | null;
  step: string | null;
  updatedAt: number;
  /** It was running when the hub stopped (or the hub stopped without saying): it carries on when the hub starts again. */
  resume: boolean;
  /** Something to know while it runs (an Ollama whose disk can't be watched). */
  note: string | null;
  ctrl: AbortController | null;
  done: Promise<void> | null;
}

const hfId = (m: PoolModel) => `hf:${m.repo}/${m.files[0]}`;
/** A remove that deletes instead of moving to the Trash (`{ forGood: true }`). */
const forGood = (body: unknown) => !!body && typeof body === "object" && (body as { forGood?: unknown }).forGood === true;
const ollamaId = (serverId: string, model: string) => `ollama:${serverId}:${model}`;
const repoName = (repo: string) => {
  let name = repo.split("/").pop() ?? repo;
  name = name.replace(/[-_.]?gguf$/i, "");
  return /^[a-z0-9-]+_(.{3,})$/.exec(name)?.[1] ?? name;
};
/** Free bytes on the disk a folder is on (null when it can't be told). */
const freeIn = (folder: string): number | null => {
  try {
    return diskSpace(existingParent(folder)).free;
  } catch {
    return null;
  }
};

/** Where an Ollama with the hub's own settings keeps its models (OLLAMA_MODELS, else ~/.ollama/models): one Crosstalk starts. */
const ollamaModels = () => process.env.OLLAMA_MODELS || join(homedir(), ".ollama", "models");
/** Where Ollama's Linux service keeps them (its own user's home). */
const OLLAMA_SERVICE_MODELS = "/usr/share/ollama/.ollama/models";
/** Said beside a pull whose disk can't be told, so no one counts on Crosstalk stopping it in time. */
const UNWATCHED = "Crosstalk can't see which disk this Ollama keeps its models on, so it won't stop the pull before that disk is full: keep some room free there.";

export class LocalLibrary {
  /** This machine's memory in bytes (tests give their own). */
  ramBytes: () => number = () => totalmem();
  /** Apple silicon: the GPU shares the memory. */
  unified = process.platform === "darwin" && process.arch === "arm64";
  /** The GPUs llama.cpp lists here: the model pool's install, else a llama-server Crosstalk found (tests give their own). */
  devices: () => Promise<PoolDevice[]> = () => this.listGpus();
  /** Where removed model files go (tests use a temporary home's Trash). */
  trashOptions: TrashOptions = {};
  /** How often a running download looks at the disk. */
  diskCheckMs = 2000;
  /** Where an Ollama Crosstalk didn't start may keep its models (tests give their own). */
  ollamaPlaces: () => string[] = () => [...new Set([ollamaModels(), ...(process.platform === "linux" ? [OLLAMA_SERVICE_MODELS] : [])])];
  private jobs = new Map<string, Job>();
  private loaded = false;
  private found: { at: number; bin: string; list: PoolDevice[] } | null = null;
  private machineSeen: { at: number; value: LocalMachine } | null = null;
  private machineJob: Promise<LocalMachine> | null = null;
  private portsSeen: { at: number; value: LibraryView["ports"] } | null = null;
  private filesSeen: { root: string; at: number; list: LocalModelFile[] } | null = null;
  /** The last look at the folder, the one under way, and the models found the last time it was walked (kept longer). */
  private seen: { root: string; at: number; look: Look } | null = null;
  private looking: { root: string; job: Promise<Look> } | null = null;
  private walked: { root: string; at: number; list: LocalModelFile[] } | null = null;
  /** Bumped when something changes the folder: a look begun before isn't kept. */
  private generation = 0;
  /** How long view() waits for a look at the folder before answering with the last one (tests give their own). */
  lookWaitMs = 1500;
  private shapes = new Map<string, KvShape | null>();
  /** Downloads and models being moved to the Trash now: a second Remove waits for the first. */
  private removing = new Set<string>();
  private closed = false;

  constructor(private readonly app: App) {}

  // ---- The folder ----

  /** The folder downloads go to now. */
  folder(): string {
    const saved = this.app.store.kvGet(FOLDER_KEY);
    return saved && isAbsolute(saved) ? saved : modelsDir();
  }

  folderView(path = this.folder()): LocalFolder {
    const problem = folderProblem(path);
    const drive = driveOf(path);
    let space: { total: number; free: number } | null = null;
    try {
      space = problem && drive && !drive.mounted ? null : diskSpace(existingParent(path));
    } catch {
      space = null;
    }
    return { path, shown: shown(path), isDefault: path === modelsDir(), drive: drive?.name ?? null, freeBytes: space?.free ?? null, totalBytes: space?.total ?? null, problem };
  }

  /** How a new folder is tried (tests give their own). */
  probe: (path: string) => Promise<Probe> = (path) => probeFolder(path);

  /** PUT /api/local-models/folder `{ path }`: a folder this hub can write to (made if it's missing); null or "" goes back to Crosstalk's own. */
  async setFolder(body: unknown): Promise<LocalFolder> {
    const input = body && typeof body === "object" ? (body as { path?: unknown }).path : undefined;
    if (input === null || input === "") {
      this.app.store.kvDelete(FOLDER_KEY);
      return this.folderView();
    }
    const path = checkFolder(input);
    if (path !== modelsDir()) {
      // Only what can be told without opening anything first (an unplugged drive, a file in the way), then a real write.
      const problem = folderProblem(path);
      if (problem) throw new HttpError(409, problem, "folder");
      const tried = await this.probe(path);
      if (!tried.ok) throw new HttpError(409, probeProblem(path, tried, this.app.machineName()), "folder");
    }
    if (path === modelsDir()) this.app.store.kvDelete(FOLDER_KEY);
    else this.app.store.kvSet(FOLDER_KEY, path);
    this.changed();
    log.info(`downloads go to ${shown(path)}`);
    return this.folderView(path);
  }

  // ---- What's here ----

  /** GET /api/local-models/library */
  async view(): Promise<LibraryView> {
    this.load();
    const runners = localRunnersOf(this.app);
    const fresh = this.portsSeen && Date.now() - this.portsSeen.at < PORTS_TTL ? this.portsSeen.value : null;
    const [machine, ports, look] = await Promise.all([this.machine(), fresh ?? runners.freePorts(), this.look()]);
    if (!fresh) this.portsSeen = { at: Date.now(), value: ports };
    return {
      machine,
      folder: look.folder,
      files: look.files,
      downloads: [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((j) => this.wire(j, look.had)),
      programs: runners.programs(),
      started: runners.list(),
      hasHfToken: !!this.token(),
      reserveBytes: diskReserve(),
      ports,
    };
  }

  /** The machine's facts: kept a minute (an older look is answered with while a new one runs), or looked at now with `fresh`. */
  async machine(fresh = false): Promise<LocalMachine> {
    const seen = this.machineSeen;
    if (!fresh && seen && Date.now() - seen.at < MACHINE_TTL) return seen.value;
    this.machineJob ??= this.readMachine().then((value) => {
      this.machineSeen = { at: Date.now(), value };
      return value;
    }).finally(() => (this.machineJob = null));
    return !fresh && seen ? seen.value : this.machineJob;
  }

  private async readMachine(): Promise<LocalMachine> {
    let devices: PoolDevice[] = [];
    try {
      devices = await this.devices();
    } catch (e) {
      log.debug(`couldn't list the GPUs: ${errText(e)}`);
    }
    return machineFrom(this.ramBytes(), this.unified, devices);
  }

  /** The GPUs: the model pool's llama.cpp lists them when it's installed; else a llama-server found on this machine, now and then. */
  private async listGpus(): Promise<PoolDevice[]> {
    const pooled = await this.app.poolNode.gpus();
    if (pooled.length) return pooled;
    const bin = localRunnersOf(this.app).programs().find((p) => p.kind === "llamacpp")?.path;
    if (!bin) return [];
    if (this.found?.bin === bin && Date.now() - this.found.at < DEVICES_TTL) return this.found.list;
    // Kept even when it fails, so a broken program isn't run on every look.
    this.found = { at: Date.now(), bin, list: [] };
    this.found.list = await listDevices(bin, [], 20_000).catch(() => []);
    return this.found.list;
  }

  /** The GGUF models finished in the folder (a split model once all its parts are), biggest first. */
  files(root = this.folder()): LocalModelFile[] {
    const seen = this.filesSeen;
    if (seen && seen.root === root && Date.now() - seen.at < FILES_TTL) return seen.list;
    const list = this.readFiles(root);
    this.filesSeen = { root, at: Date.now(), list };
    return list;
  }

  /** Something in the folder changed (a download ended, a model went): the next look reads it again. */
  private changed() {
    this.filesSeen = null;
    this.seen = null;
    this.looking = null;
    this.walked = null;
    this.generation++;
  }

  /**
   * The folder, its models and what stopped downloads have, as view() shows them, looked at without holding up the hub
   * (a drive waking up, a network folder that's gone): one look at a time, and one that takes longer than a moment is
   * answered with the last (marked `pending`, so the page asks again until the folder answers).
   */
  private async look(): Promise<Look> {
    const root = this.folder();
    const seen = this.seen?.root === root ? this.seen : null;
    if (seen && Date.now() - seen.at < LOOK_TTL) return seen.look;
    let job = this.looking?.root === root ? this.looking.job : null;
    if (!job) {
      const generation = this.generation;
      const started: Promise<Look> = this.lookNow(root).then((look) => {
        if (generation === this.generation) this.seen = { root, at: Date.now(), look };
        return look;
      });
      started
        .finally(() => {
          if (this.looking?.job === started) this.looking = null;
        })
        .catch(() => {}); // A failed look is answered by the request awaiting it.
      this.looking = { root, job: started };
      job = started;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), this.lookWaitMs)));
    const look = await Promise.race([job, late]).finally(() => clearTimeout(timer));
    if (look) return look;
    const last = seen?.look ?? { folder: waitingFor(root), files: [], had: new Map<string, number>() };
    return { ...last, folder: { ...last.folder, pending: true } };
  }

  private async lookNow(root: string): Promise<Look> {
    const walked = this.walked?.root === root && Date.now() - this.walked.at < FILES_TTL ? this.walked.list : null;
    const generation = this.generation;
    const [folder, files, had] = await Promise.all([
      folderLater(root),
      walked ?? this.readFilesLater(root).then((list) => {
        if (generation === this.generation) this.walked = { root, at: Date.now(), list };
        return list;
      }),
      this.hadLater(),
    ]);
    return { folder, files, had };
  }

  /** What each stopped Hugging Face download has on disk: its finished parts and .part files. */
  private async hadLater(): Promise<Map<string, number>> {
    const size = (p: string) => stat(p).then((s) => s.size, () => 0);
    const stopped = [...this.jobs.values()].filter((j) => j.state !== "downloading" && j.model);
    return new Map(await Promise.all(stopped.map(async (j) => [j.id, (await Promise.all(modelFiles(j.model!, j.root).map(async (p) => (await size(p)) || (await size(`${p}.part`))))).reduce((a, b) => a + b, 0)] as const)));
  }

  /** The finished models among a folder's files (a split model once all its parts are), with where each one's first file is. */
  private groupsIn(root: string, onDisk: PoolModelFile[]): { repo: string; model: PoolModel; first: string }[] {
    const byRepo = new Map<string, { path: string; size: number }[]>();
    for (const f of onDisk) {
      if (f.partial) continue;
      let entry: { repo: string; file: string };
      try {
        entry = splitModelFile(f.file);
      } catch {
        continue;
      }
      byRepo.set(entry.repo, [...(byRepo.get(entry.repo) ?? []), { path: entry.file, size: f.bytes }]);
    }
    const out: { repo: string; model: PoolModel; first: string }[] = [];
    for (const [repo, list] of byRepo) {
      for (const model of groupModels(repo, list, false)) {
        // One still downloading (its first part finished, say) isn't a model yet.
        if (this.jobs.get(hfId(model))?.state !== "downloading") out.push({ repo, model, first: modelFiles(model, root)[0] });
      }
    }
    return out;
  }

  private static fileOf({ repo, model: m }: { repo: string; model: PoolModel }, shape: KvShape | null): LocalModelFile {
    return { id: `${repo}/${m.files[0]}`, repo, files: m.files, quant: m.quant, bytes: m.sizeBytes, kvBytesPerToken: shape?.bytesPerToken ?? null, contextLength: shape?.contextLength ?? null };
  }

  private readFiles(root: string): LocalModelFile[] {
    const list = this.groupsIn(root, modelFilesOnDisk(root)).map((g) => LocalLibrary.fileOf(g, this.shapeOf(g.first)));
    return list.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
  }

  private async readFilesLater(root: string): Promise<LocalModelFile[]> {
    const groups = this.groupsIn(root, await modelFilesIn(root));
    const shapes = await Promise.all(groups.map((g) => this.shapeOfLater(g.first)));
    return groups.map((g, i) => LocalLibrary.fileOf(g, shapes[i])).sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
  }

  /** A finished model in the folder by its id ("<owner>/<repo>/<file>"), with where its first file is. */
  fileById(id: unknown): { file: LocalModelFile; path: string } {
    const { repo, file } = splitModelFile(id);
    const root = this.folder();
    // Read now, not the list kept for the page: this is for starting or removing it.
    const found = this.readFiles(root).find((f) => f.repo === repo && f.files[0] === file);
    if (!found) throw new HttpError(404, "That model isn't in the downloads folder any more. Look at what's there, then pick one.");
    return { file: found, path: modelFiles({ repo, files: found.files, quant: found.quant, sizeBytes: found.bytes, gated: false }, root)[0] };
  }

  private shapeOf(path: string): KvShape | null {
    let key = path;
    try {
      const s = statSync(path);
      key = `${path}\n${s.size}\n${s.mtimeMs}`;
    } catch {
      return null;
    }
    if (!this.shapes.has(key)) this.shapes.set(key, localShape(path));
    return this.shapes.get(key) ?? null;
  }

  private async shapeOfLater(path: string): Promise<KvShape | null> {
    const s = await stat(path).catch(() => null);
    if (!s) return null;
    const key = `${path}\n${s.size}\n${s.mtimeMs}`;
    if (!this.shapes.has(key)) this.shapes.set(key, await shapeLater(path));
    return this.shapes.get(key) ?? null;
  }

  // ---- Hugging Face ----

  private token(): string | null {
    return readSecrets()[HF_SECRET] || null;
  }

  /** GET /api/local-models/search?q=: GGUF models on Hugging Face whose names match, most downloaded first. */
  async search(q: unknown): Promise<LocalSearchHit[]> {
    const query = typeof q === "string" ? q.trim() : "";
    if (query.length < 2 || query.length > 100) throw new HttpError(400, "Type at least two letters of a model's name, like qwen3 or gemma.");
    const params = new URLSearchParams({ search: query, filter: "gguf", sort: "downloads", direction: "-1", limit: "20" });
    for (const e of ["downloads", "gated", "gguf"]) params.append("expand[]", e);
    const token = this.token();
    const { res } = await hfFetch(`${hfBase()}/api/models?${params}`, token, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw repoError(res, query, token);
    const list = (await res.json().catch(() => null)) as { id?: unknown; downloads?: unknown; gated?: unknown; gguf?: { total?: unknown; context_length?: unknown } }[] | null;
    if (!Array.isArray(list)) throw new HttpError(502, "Hugging Face sent a list Crosstalk can't read: try again in a few minutes.");
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    return list
      .filter((m) => typeof m?.id === "string" && /^[^/]+\/[^/]+$/.test(m.id))
      .map((m) => ({ repo: m.id as string, downloads: n(m.downloads) ?? 0, gated: !!m.gated, params: n(m.gguf?.total), contextLength: n(m.gguf?.context_length) }));
  }

  /** GET /api/local-models/files?repo=: a repo's GGUF models (smallest first), and its shape from the smallest one's header. */
  async repoFiles(repo: unknown): Promise<LocalRepoFiles> {
    if (typeof repo !== "string" || !repo.trim()) throw new HttpError(400, "Paste a Hugging Face link or a model name like owner/model-GGUF.");
    const token = this.token();
    const c = await choices(repo, token);
    const first = [...c.models].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
    const head = first ? await fileHead(c.repo, first.files[0], token, HEAD_BYTES).catch(() => null) : null;
    const meta = head ? ggufMetadata(head) : null;
    const shape = meta ? kvShape(meta) : null;
    return { ...c, kvBytesPerToken: shape?.bytesPerToken ?? null, contextLength: shape?.contextLength ?? null };
  }

  // ---- Downloads ----

  /** POST /api/local-models/downloads: starts a download, or picks a stopped one up where it stopped. */
  async startDownload(body: unknown): Promise<LibraryView> {
    this.load();
    if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
    const b = (body && typeof body === "object" ? body : {}) as Partial<Record<string, unknown>>;
    if (b.source === "huggingface") this.startHf(checkModel(b.model));
    else if (b.source === "ollama") await this.startOllama(b.serverId, b.model);
    else throw new HttpError(400, "Say what to download: a Hugging Face model, or a model for Ollama.");
    return this.view();
  }

  private running() {
    return [...this.jobs.values()].filter((j) => j.state === "downloading").length;
  }

  private refuseBusy() {
    if (this.running() >= MAX_RUNNING) throw new HttpError(409, `${MAX_RUNNING} downloads are running: wait for one to finish, or stop one.`, "busy");
  }

  /** The downloads running now that fill the same disk as `folder`, with what each has still to come. */
  private runningOn(folder: string): { name: string; left: number }[] {
    const disk = dev(existingParent(folder));
    if (disk === null) return [];
    return [...this.jobs.values()]
      .filter((j) => j.state === "downloading" && dev(existingParent(j.root)) === disk)
      .map((j) => ({ name: j.name, left: Math.max(0, j.totalBytes - j.doneBytes) }));
  }

  private startHf(m: PoolModel) {
    const id = hfId(m);
    const cur = this.jobs.get(id);
    if (cur?.state === "downloading") return;
    // A stopped download carries on in its own folder; a new one goes to the folder chosen now.
    const root = cur?.root ?? this.folder();
    const problem = folderProblem(root);
    if (problem) throw new HttpError(409, problem, "folder");
    if (haveModel(m, root)) {
      this.jobs.delete(id);
      this.save();
      return;
    }
    this.refuseBusy();
    // The model pool downloads into Crosstalk's folder too.
    const by = downloadingBy(modelFiles(m, root));
    if (by) throw new HttpError(409, DOWNLOADERS[by], "busy");
    const name = `${repoName(m.repo)}${m.quant ? ` ${m.quant}` : ""}`;
    const { remaining, free } = spaceFor(m, root);
    const reserve = diskReserve();
    // Downloads still running on the same disk need their share of what's free first.
    const others = this.runningOn(root);
    const room = free - others.reduce((n, o) => n + o.left, 0) - reserve;
    if (room < remaining) {
      const after = others.length ? ` once ${others.map((o) => o.name).join(" and ")} ${others.length === 1 ? "has" : "have"} finished` : "";
      throw new HttpError(
        507,
        `Not enough free space in ${shown(root)} for ${name}: it needs ${gb(remaining)} more and ${room > 0 ? `${gb(room)} is` : "nothing is"} free${after} (keeping ${gb(reserve)} free). ${others.length ? `Wait for ${others.length === 1 ? "it" : "them"} or stop ${others.length === 1 ? "it" : "one"}, change the folder, or pick a smaller file.` : "Free up space, change the folder, or pick a smaller file."}`,
        "low_disk",
      );
    }
    const ctrl = new AbortController();
    const job: Job = { id, source: "huggingface", name, model: m, ollama: null, root, state: "downloading", doneBytes: m.sizeBytes - remaining, totalBytes: m.sizeBytes, bytesPerSec: null, error: null, code: null, step: null, updatedAt: Date.now(), resume: false, note: null, ctrl, done: null };
    this.jobs.set(id, job);
    job.done = download(m, this.token(), (p) => {
      job.doneBytes = p.doneBytes;
      job.totalBytes = p.totalBytes;
      job.bytesPerSec = p.bytesPerSec;
      job.updatedAt = Date.now();
    }, ctrl.signal, root, "local").then(
      () => {
        this.jobs.delete(id);
        log.info(`downloaded ${m.repo} ${m.files[0]} to ${shown(root)}`);
      },
      (e) => this.ended(job, e),
    ).finally(() => {
      job.ctrl = null;
      this.changed();
      this.save();
    });
    this.save();
  }

  private async startOllama(serverId: unknown, model: unknown) {
    if (typeof serverId !== "string" || !serverId) throw new HttpError(400, "Say which Ollama on this machine to pull the model into.");
    const name = typeof model === "string" ? model.trim() : "";
    if (!OLLAMA_NAME.test(name)) throw new HttpError(400, "Type a model's name as Ollama's library writes it, like qwen3:8b.");
    const id = ollamaId(serverId, name);
    if (this.jobs.get(id)?.state === "downloading") return;
    const { servers } = await this.app.services.localServers({ fresh: true });
    const server = servers.find((s) => s.id === serverId);
    if (!server || server.kind !== "ollama") throw new HttpError(404, "That Ollama isn't running any more. Start it, then press Rescan.");
    let url: URL;
    try {
      url = new URL(server.baseUrl);
    } catch {
      throw new HttpError(404, "That Ollama isn't running any more. Start it, then press Rescan.");
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new HttpError(409, "Only an Ollama on this machine can pull models from here.");
    this.refuseBusy();
    // One Crosstalk started keeps its models where the hub's settings say. Another's folder isn't known: before the pull
    // the place that looks like an Ollama's (it has blobs) is the guess, and the pull itself shows which it is.
    const known = localRunnersOf(this.app).at(Number(url.port))?.kind === "ollama" ? ollamaModels() : null;
    const guess = known ?? this.ollamaPlaces().find((p) => existsSync(join(p, "blobs"))) ?? null;
    const reserve = diskReserve();
    const free = guess ? freeIn(guess) : null;
    const others = guess ? this.runningOn(guess) : [];
    if (free !== null && free - others.reduce((n, o) => n + o.left, 0) < reserve) {
      const wait = others.length ? `wait for ${others.map((o) => o.name).join(" and ")} or stop ${others.length === 1 ? "it" : "one"}, or free up space` : "free up space";
      throw new HttpError(507, `The disk Ollama keeps its models on is almost full (keeping ${gb(reserve)} free): ${wait}, then try again.`, "low_disk");
    }
    const ctrl = new AbortController();
    const job: Job = { id, source: "ollama", name, model: null, ollama: { model: name, serverId }, root: guess ?? ollamaModels(), state: "downloading", doneBytes: 0, totalBytes: 0, bytesPerSec: null, error: null, code: null, step: "Starting…", updatedAt: Date.now(), resume: false, note: null, ctrl, done: null };
    this.jobs.set(id, job);
    job.done = this.pull(job, `${url.origin}/api/pull`, ctrl, known).then(
      () => {
        this.jobs.delete(id);
        log.info(`Ollama pulled ${name}`);
      },
      (e) => this.ended(job, e),
    ).finally(() => {
      job.ctrl = null;
      this.save();
    });
    this.save();
  }

  /** Of the places an Ollama may keep its models, the one holding the part file Ollama writes for a layer it's downloading. */
  private partsIn(digests: string[]): string | null {
    return this.ollamaPlaces().find((place) => digests.some((d) => /^sha256:[0-9a-f]{64}$/.test(d) && existsSync(join(place, "blobs", `${d.replace(":", "-")}-partial`)))) ?? null;
  }

  /**
   * Ollama's pull: its progress comes as a line of JSON per step (one per layer it downloads, with `total` and
   * `completed`). Stopping ends the request: Ollama keeps what it has, and the next pull of the model picks it up,
   * unless an Ollama started meanwhile cleared it (each start clears parts it doesn't know, unless OLLAMA_NOPRUNE is
   * set, as it is for one Crosstalk starts while a pull waits). The disk is watched meanwhile: a pull that would leave
   * less than the reserve is stopped first. That disk is the folder `known` (a server Crosstalk started), else the
   * place where the part file of a layer it's downloading appears; when none does, the download says it isn't watched.
   */
  private async pull(job: Job, url: string, ctrl: AbortController, known: string | null): Promise<void> {
    const name = job.ollama!.model;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, stream: true }), redirect: "manual", signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw e;
      throw new HttpError(502, "Couldn't reach Ollama on this machine: check it's still running, then try again.");
    }
    if (!res.ok || !res.body) {
      const said = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      throw new HttpError(502, said ? ollamaError(String(said), name) : `Ollama answered with error ${res.status}: try again in a minute.`);
    }
    const totals = new Map<string, number>();
    const completed = new Map<string, number>();
    const samples: [number, number][] = [];
    let checked = Date.now();
    let success = false;
    let watched = known;
    let looked = 0;
    const reserve = diskReserve();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += value;
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { status?: unknown; digest?: unknown; total?: unknown; completed?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) throw new HttpError(502, ollamaError(String(msg.error), name));
        if (typeof msg.status === "string") job.step = msg.status;
        if (typeof msg.digest === "string" && typeof msg.total === "number") {
          totals.set(msg.digest, msg.total);
          completed.set(msg.digest, typeof msg.completed === "number" ? msg.completed : (completed.get(msg.digest) ?? 0));
        }
        if (msg.status === "success") success = true;
      }
      const now = Date.now();
      job.totalBytes = [...totals.values()].reduce((a, b) => a + b, 0);
      job.doneBytes = [...completed.values()].reduce((a, b) => a + b, 0);
      samples.push([now, job.doneBytes]);
      while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
      job.bytesPerSec = now - samples[0][0] >= 400 ? Math.round(((job.doneBytes - samples[0][1]) * 1000) / (now - samples[0][0])) : job.bytesPerSec;
      job.updatedAt = now;
      if (now - checked >= this.diskCheckMs) {
        checked = now;
        if (!watched) {
          watched = this.partsIn([...totals.keys()].filter((d) => (completed.get(d) ?? 0) < (totals.get(d) ?? 0)));
          if (watched) {
            job.root = watched;
            job.note = null;
          } else if (totals.size && ++looked >= 3) job.note = UNWATCHED;
        }
        const free = watched ? freeIn(watched) : null;
        const left = Math.max(0, job.totalBytes - job.doneBytes);
        if (free !== null && free - left < reserve) {
          await reader.cancel().catch(() => {});
          throw new HttpError(507, `Not enough free space for ${name}: it needs ${gb(left)} more and ${free > reserve ? `${gb(free - reserve)} is` : "nothing is"} free (keeping ${gb(reserve)} free). Free up space, then ${PULL_AGAIN}.`, "low_disk");
        }
      }
    }
    if (!success) throw new HttpError(502, `Ollama stopped before ${name} was all there: ${PULL_AGAIN}.`);
  }

  /** A download ended without finishing: stopped by the person, or what went wrong (what's downloaded stays). */
  private ended(job: Job, e: unknown) {
    job.bytesPerSec = null;
    job.updatedAt = Date.now();
    if (job.ctrl?.signal.aborted) {
      job.state = "stopped";
      job.error = null;
      job.code = null;
      return;
    }
    job.state = "failed";
    job.error = e instanceof HttpError || e instanceof Error ? e.message : String(e);
    job.code = e instanceof HttpError ? (e.code ?? null) : null;
    log.warn(`downloading ${job.name} failed: ${job.error}`);
  }

  /** POST /api/local-models/downloads/stop `{ id }`: stops it; what's downloaded stays, and starting it again picks it up. */
  async stopDownload(body: unknown): Promise<LibraryView> {
    this.load();
    const job = this.job(body);
    if (job.state === "downloading") {
      job.resume = false;
      job.ctrl?.abort();
      await job.done;
      log.info(`download of ${job.name} stopped`);
    }
    return this.view();
  }

  /**
   * POST /api/local-models/downloads/remove `{ id, forGood? }`: a stopped download goes. What a Hugging Face one had
   * downloaded goes to the Trash (`forGood`: deleted, when its drive's Trash can't be used and the person said so
   * again); Ollama clears what it had of its own pull by itself. One the model pool finished meanwhile is only
   * forgotten: the model is there, and may be in use.
   */
  async removeDownload(body: unknown): Promise<LibraryView> {
    this.load();
    const job = this.job(body);
    if (job.state === "downloading") throw new HttpError(409, "It's still downloading: stop it first.", "busy");
    const model = job.model;
    if (model && !haveModel(model, job.root)) {
      const by = downloadingBy(modelFiles(model, job.root));
      if (by) throw new HttpError(409, DOWNLOADERS[by], "busy");
      const paths = modelFiles(model, job.root).flatMap((p) => [p, `${p}.part`]).filter((p) => existsSync(p));
      await this.discard(job.id, paths, forGood(body));
      rmSync(`${modelFiles(model, job.root)[0]}.rev`, { force: true });
    }
    this.jobs.delete(job.id);
    this.changed();
    this.save();
    return this.view();
  }

  /** POST /api/local-models/files/remove `{ id, forGood? }`: a downloaded model's files go to the Trash (never while a server Crosstalk started serves it). */
  async removeFile(body: unknown): Promise<LibraryView> {
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    const { file } = this.fileById(id);
    const root = this.folder();
    const model: PoolModel = { repo: file.repo, files: file.files, quant: file.quant, sizeBytes: file.bytes, gated: false };
    const paths = modelFiles(model, root);
    if (localRunnersOf(this.app).serving(paths[0])) throw new HttpError(409, "A llama.cpp server Crosstalk started is using this model: stop it first.", "in_use");
    if (this.app.poolNode.serving(paths[0])) throw new HttpError(409, "The model pool is using this model: stop the pool first.", "in_use");
    await this.discard(`file:${file.id}`, paths, forGood(body));
    this.changed();
    log.info(`${forGood(body) ? "deleted" : "moved to the Trash"} ${file.id}`);
    return this.view();
  }

  /** Moves files to the Trash, or deletes them when the person asked for that (twice: their drive's Trash can't be used); one at a time per download or model. */
  private async discard(key: string, paths: string[], deleting: boolean) {
    if (this.removing.has(key)) throw new HttpError(409, "It's being moved to the Trash already: wait a moment.", "busy");
    this.removing.add(key);
    try {
      if (deleting) for (const p of paths) rmSync(p, { force: true });
      else if (paths.length) await toTrash(paths, this.trashOptions);
    } finally {
      this.removing.delete(key);
    }
  }

  private job(body: unknown): Job {
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    const job = typeof id === "string" ? this.jobs.get(id) : undefined;
    if (!job) throw new HttpError(404, "That download isn't there any more. Look at the list again.");
    return job;
  }

  private wire(j: Job, had: Map<string, number>): LocalDownload {
    // A stopped Hugging Face download has what's on disk: finished parts and .part files (as the last look saw them).
    const done = j.state !== "downloading" && j.model ? (had.get(j.id) ?? j.doneBytes) : j.doneBytes;
    return { id: j.id, source: j.source, name: j.name, model: j.model, ollama: j.ollama, state: j.state, doneBytes: done, totalBytes: j.totalBytes, bytesPerSec: j.state === "downloading" ? j.bytesPerSec : null, error: j.error, code: j.code, step: j.source === "ollama" ? j.step : null, note: j.state === "downloading" ? j.note : null, updatedAt: j.updatedAt };
  }

  /** Downloads that hadn't finished when the hub last stopped come back stopped (what they had is on disk). */
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const list = JSON.parse(this.app.store.kvGet(DOWNLOADS_KEY) ?? "[]") as Partial<Job>[];
      for (const j of Array.isArray(list) ? list : []) {
        if (typeof j?.id !== "string" || (j.source !== "huggingface" && j.source !== "ollama") || typeof j.root !== "string") continue;
        let model: PoolModel | null = null;
        if (j.source === "huggingface") {
          try {
            model = checkModel(j.model);
          } catch {
            continue;
          }
        }
        const ollama = j.source === "ollama" && j.ollama && typeof j.ollama.model === "string" && typeof j.ollama.serverId === "string" ? { model: j.ollama.model, serverId: j.ollama.serverId } : null;
        if (j.source === "ollama" && !ollama) continue;
        this.jobs.set(j.id, {
          id: j.id, source: j.source, name: String(j.name ?? j.id), model, ollama, root: j.root,
          state: j.state === "failed" ? "failed" : "stopped",
          doneBytes: Number(j.doneBytes) || 0, totalBytes: Number(j.totalBytes) || 0, bytesPerSec: null,
          error: j.state === "failed" && typeof j.error === "string" ? j.error : null, code: j.state === "failed" && typeof j.code === "string" ? j.code : null,
          // Still "downloading": the hub stopped without saying (a crash, a power cut), so it carries on too.
          step: null, updatedAt: Number(j.updatedAt) || Date.now(), resume: j.resume === true || j.state === "downloading", note: null, ctrl: null, done: null,
        });
      }
    } catch {
      // Nothing kept, or unreadable: nothing to pick up.
    }
  }

  private save() {
    const list = [...this.jobs.values()].map(({ ctrl: _c, done: _d, bytesPerSec: _s, note: _n, ...rest }) => rest);
    this.app.store.kvSet(DOWNLOADS_KEY, JSON.stringify(list));
  }

  /** The hub is stopping: downloads stop where they are, and carry on from there when it starts again. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const running = [...this.jobs.values()].filter((j) => j.state === "downloading");
    for (const j of running) {
      j.resume = true;
      j.ctrl?.abort();
    }
    await Promise.allSettled(running.map((j) => j.done));
  }

  /**
   * The hub has started: downloads it was running when it stopped carry on where they were. One that can't (its drive
   * was unplugged, the disk filled, the Ollama it went into isn't running) says why, with Resume.
   */
  async resumeInterrupted(): Promise<void> {
    this.load();
    for (const j of [...this.jobs.values()].filter((x) => x.resume && x.state !== "downloading")) {
      j.resume = false;
      try {
        if (j.model) this.startHf(j.model);
        else if (j.ollama) await this.startOllama(j.ollama.serverId, j.ollama.model);
        log.info(`carrying on with the download of ${j.name}`);
      } catch (e) {
        j.state = "failed";
        j.error = e instanceof Error ? e.message : String(e);
        j.code = e instanceof HttpError ? (e.code ?? null) : null;
        j.updatedAt = Date.now();
        log.warn(`couldn't carry on with the download of ${j.name}: ${j.error}`);
      }
    }
    this.save();
  }

  /** An Ollama pull is running or waits for Resume: an Ollama Crosstalk starts now keeps the parts in Ollama's folder. */
  pullsWaiting(): boolean {
    this.load();
    return [...this.jobs.values()].some((j) => j.source === "ollama");
  }

  /** Resolves once every download running now has ended: for tests. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
  }

  // ---- Ollama's library ----

  /** GET /api/local-models/ollama?model=: a model's size and quant in Ollama's library, before pulling it. */
  async ollamaInfo(model: unknown): Promise<LocalOllamaInfo> {
    const name = typeof model === "string" ? model.trim() : "";
    if (!OLLAMA_NAME.test(name)) throw new HttpError(400, "Type a model's name as Ollama's library writes it, like qwen3:8b.");
    const [path, tag = "latest"] = name.split(":");
    if (/^(hf\.co|huggingface\.co)\//i.test(path)) throw new HttpError(404, "Ollama gets that one from Hugging Face: its size shows once the pull starts.");
    const repo = path.includes("/") ? path : `library/${path}`;
    if (repo.split("/").length !== 2) throw new HttpError(400, "Type a model's name as Ollama's library writes it, like qwen3:8b.");
    const base = ollamaRegistry();
    const get = async (url: string, accept: string) => {
      try {
        return await registryFetch(url, accept);
      } catch {
        throw new HttpError(502, "Couldn't reach Ollama's library: check this machine's internet connection, then try again.");
      }
    };
    const res = await get(`${base}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, "application/vnd.docker.distribution.manifest.v2+json");
    if (res.status === 404) throw new HttpError(404, `Ollama's library has no ${name}: check the name at ollama.com/library.`);
    if (!res.ok) throw new HttpError(502, `Ollama's library answered ${res.status}: try again in a few minutes.`);
    const manifest = (await res.json().catch(() => null)) as { config?: { digest?: unknown }; layers?: { size?: unknown }[] } | null;
    const layers = Array.isArray(manifest?.layers) ? manifest!.layers : [];
    const sizeBytes = layers.reduce((n, l) => n + (typeof l?.size === "number" && l.size > 0 ? l.size : 0), 0);
    if (!sizeBytes) throw new HttpError(502, "Ollama's library sent something Crosstalk can't read: try again in a few minutes.");
    let quant: string | null = null;
    let params: string | null = null;
    const digest = manifest?.config?.digest;
    if (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)) {
      const config = await get(`${base}/v2/${repo}/blobs/${digest}`, "application/json").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { file_type?: unknown; model_type?: unknown } | null;
      quant = typeof config?.file_type === "string" ? (quantOf(`${config.file_type}.gguf`) ?? config.file_type.slice(0, 20)) : null;
      params = typeof config?.model_type === "string" ? config.model_type.slice(0, 20) : null;
    }
    return { model: name, sizeBytes, quant, params };
  }
}

/** Ollama's library (tests point it at a fake). */
export const ollamaRegistry = () => (process.env.CROSSTALK_OLLAMA_REGISTRY ?? "https://registry.ollama.ai").replace(/\/+$/, "");

/** A GET to Ollama's library, following its redirects (blobs are kept elsewhere) but never from https down to http. */
async function registryFetch(url: string, accept: string): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, { headers: { accept }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const location = res.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
    await res.body?.cancel().catch(() => {});
    const next = new URL(location, current);
    if (next.protocol !== "https:" && !(next.protocol === "http:" && current.protocol === "http:")) throw new Error("unsafe redirect");
    current = next;
  }
  throw new Error("too many redirects");
}

/** What to do after an Ollama pull stopped: Ollama keeps its part, but an Ollama that starts clears parts it doesn't know. */
const PULL_AGAIN = "pull it again (Ollama picks up where it stopped, unless it restarted since)";

/** Ollama's words for a failed pull, with what to do. */
function ollamaError(said: string, name: string): string {
  const text = said.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 200);
  if (/file does not exist|not found|manifest unknown/i.test(text)) return `Ollama's library has no ${name}: check the name at ollama.com/library, then try again.`;
  if (/no space left/i.test(text)) return `The disk Ollama keeps its models on is full: free up space, then ${PULL_AGAIN}.`;
  if (/connection|timeout|i\/o|tls|dial|EOF/i.test(text)) return `Ollama couldn't download ${name} (${text}): check this machine's internet connection, then ${PULL_AGAIN}.`;
  return `Ollama couldn't pull ${name}: ${text}. Try again in a minute.`;
}

const instances = new WeakMap<App, LocalLibrary>();

/** The one LocalLibrary of a hub (it keeps the downloads). */
export function localLibraryOf(app: App): LocalLibrary {
  let lib = instances.get(app);
  if (!lib) instances.set(app, (lib = new LocalLibrary(app)));
  return lib;
}

/** The hub's LocalLibrary if it was ever used. */
export const existingLocalLibrary = (app: App): LocalLibrary | null => instances.get(app) ?? null;

/** Whether a path is inside a folder (after following links, when both exist). */
export function within(path: string, dir: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const p = real(path);
  const d = real(dir);
  return p === d || p.startsWith(d + sep);
}
