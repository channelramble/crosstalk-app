// Keeping the hub's disk from filling up. Agents build, download and unpack a lot, and a full disk breaks uploads,
// builds and the Mac itself. On a schedule the hub clears what's downloaded or rebuilt again when needed; Settings →
// Storage shows the chat folders' big items for the human to delete; and both the human and the agents hear about it
// when space runs low.

import { lstatSync, readdirSync, realpathSync, statSync, statfsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Room, StorageChatFolder, StorageCleared, StorageItem, StorageReport, StorageSettings, StorageStatus } from "@crosstalk/shared";
import { HttpError } from "./engine/engine";
import { diskReserve } from "./uploads";
import { logger } from "./util/log";

const log = logger("storage");

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 24 * 60 * 60_000;

/** Chats unused this long get their installed dependencies cleared. */
export const IDLE_CHAT_DAYS = 14;
/** How often the hub checks free space, and how often it clears caches and measures the chat folders. */
const CHECK_EVERY = 15 * 60_000;
const CLEAN_EVERY = 6 * 60 * 60_000;
/** A low-space notification at most this often. */
const NOTIFY_EVERY = 12 * 60 * 60_000;

/**
 * Tool caches in the home folder. Entries untouched for `olderThanDays` are cleared on every run; with `whenLow`, all
 * of it goes when space is low (or when the human asks). Each tool downloads or rebuilds what it needs again.
 */
interface CacheRule {
  what: string;
  path: string;
  olderThanDays?: number;
  whenLow?: boolean;
}
export const CACHES: CacheRule[] = [
  { what: "Xcode build data", path: "Library/Developer/Xcode/DerivedData", olderThanDays: 3, whenLow: true },
  { what: "Simulator caches", path: "Library/Developer/CoreSimulator/Caches", whenLow: true },
  { what: "Homebrew downloads", path: "Library/Caches/Homebrew/downloads", olderThanDays: 14, whenLow: true },
  { what: "pip downloads", path: "Library/Caches/pip", whenLow: true },
  { what: "uv downloads", path: ".cache/uv", whenLow: true },
  { what: "npm downloads", path: ".npm/_cacache", whenLow: true },
  { what: "Bun downloads", path: ".bun/install/cache", whenLow: true },
  { what: "Cargo downloads", path: ".cargo/registry/cache", whenLow: true },
  { what: "Gradle build cache", path: ".gradle/caches/build-cache-1", whenLow: true },
];

/**
 * Installed dependencies inside projects, cleared on their own in chats unused for two weeks when the file that
 * recreates them is beside them (`npm install`, `cargo build`, …). Without that file they're only listed.
 */
const DEPENDENCIES: Record<string, string[]> = {
  node_modules: ["package.json"],
  ".next": ["package.json"],
  ".nuxt": ["package.json"],
  ".svelte-kit": ["package.json"],
  ".turbo": ["package.json"],
  ".parcel-cache": ["package.json"],
  target: ["Cargo.toml", "pom.xml"],
  ".build": ["Package.swift"],
  DerivedData: [],
  ".gradle": ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
  Pods: ["Podfile"],
};
/** Build output: made again by building, but it may hold release files, so only ever listed for the human. */
const BUILD_OUTPUT = ["build", "dist", "out", ".venv", "venv", ".cache", ".desktop-cache", ".bundle-cache", ".gradle-cache"];
const BUILD_OUTPUT_PREFIXES = ["build-", "build_", "cmake-build-", "dist-"];
/** A folder holding one of these is a project: never offered for deletion as a whole. */
const PROJECT_MARKERS = new Set([".git", "package.json", "Package.swift", "Cargo.toml", "pyproject.toml", "setup.py", "go.mod", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "CMakeLists.txt", "Makefile", "pom.xml", "Gemfile", "Podfile", "project.godot"]);

const LIST_FROM = { build: 50 * MB, upload: 100 * MB, large: GB };
const UUID_PREFIX = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}_/;

export interface StorageDeps {
  rooms: () => Room[];
  /** Whether an agent is working in the room: its folder is left alone meanwhile. */
  isBusy: (roomId: string) => boolean;
  settings: () => StorageSettings;
  kvGet: (key: string) => string | null;
  kvSet: (key: string, value: string) => void;
  /** Chat folders the hub made live here: only these get their dependencies cleared on their own. */
  workspaceRoot: string;
  /** The free space or the low-space state changed (or something was cleared). */
  onStatus?: (status: StorageStatus) => void;
  /** Space is low (called at most twice a day). */
  onLow?: (status: StorageStatus) => void;
  home?: string;
  /** The running hub program: older copies kept beside it are cleared after a month. */
  execPath?: string;
  /** Smallest sizes worth listing (tests use tiny files). */
  listFrom?: { build: number; upload: number; large: number };
}

interface Found extends StorageItem {
  /** Real path of the chat folder it's in. */
  folder: string;
  /** Rooms using that folder. */
  roomIds: string[];
  /** Cleared on its own once its chats have been unused for two weeks. */
  auto: boolean;
}

interface Scan {
  at: number;
  chats: StorageChatFolder[];
  items: Found[];
  trash: number | null;
  caches: { what: string; bytes: number }[];
}

/** Runs a measuring command at low priority; on a timeout, whatever it printed so far. */
async function run(cmd: string[], timeoutMs: number): Promise<string> {
  const p = Bun.spawn(["nice", "-n", "15", ...cmd], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  try {
    return await new Response(p.stdout).text();
  } finally {
    clearTimeout(timer);
    await p.exited.catch(() => {});
  }
}

/** Sizes in bytes from `du -k` (one filesystem), by path as printed. */
async function du(paths: string[], args: string[], timeoutMs = 10 * 60_000): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < paths.length; i += 200) {
    const text = await run(["du", "-k", "-x", ...args, "--", ...paths.slice(i, i + 200)], timeoutMs);
    for (const line of text.split("\n")) {
      const m = /^(\d+)\t(.+)$/.exec(line);
      if (m) out.set(m[2], Number(m[1]) * 1024);
    }
  }
  return out;
}

const isDir = (path: string) => {
  try {
    const s = lstatSync(path);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};

const mtime = (path: string) => {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** The newest change to a folder or anything directly in it (a build touches its folders' entries, not the folder). */
function newestChange(path: string): number {
  let newest = mtime(path);
  try {
    for (const name of readdirSync(path)) newest = Math.max(newest, mtime(join(path, name)));
  } catch {
    /* a file, or unreadable */
  }
  return newest;
}

function isProject(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => PROJECT_MARKERS.has(n) || /\.(xcodeproj|xcworkspace|sln)$/.test(n));
  } catch {
    return false;
  }
}

/** A project, or a folder with a project directly inside: deleting it would take source code with it. */
function holdsProject(dir: string): boolean {
  if (!isDir(dir)) return false;
  if (isProject(dir)) return true;
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.isSymbolicLink() && isProject(join(dir, e.name)));
  } catch {
    return false;
  }
}

/** Total and free bytes (free to this user) on the disk that holds `path`. */
export function diskSpace(path: string): { total: number; free: number } {
  const s = statfsSync(path);
  return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
}

const idFor = (path: string) => createHash("sha1").update(path).digest("hex").slice(0, 16);
const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

export class Storage {
  private last: Scan | null = null;
  private scanning: Promise<void> | null = null;
  private cleaning: Promise<number> | null = null;
  private deleting: Promise<void> | null = null;
  private lastDelete: StorageReport["lastDelete"] = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastStatus: StorageStatus | null = null;
  private lastAutoClean = 0;

  constructor(private deps: StorageDeps) {}

  private get home() {
    return this.deps.home ?? homedir();
  }

  status(): StorageStatus {
    const { total, free } = diskSpace(this.home);
    return { total, free, reserve: diskReserve(), low: free < this.deps.settings().lowSpaceGb * GB };
  }

  /** Checks free space every 15 minutes and clears caches every 6 hours (sooner when space runs low). */
  start() {
    // The first cleanup waits a few minutes, so a restart doesn't start with a burst of disk work.
    this.lastAutoClean = Date.now();
    this.timers.push(setInterval(() => void this.check(), CHECK_EVERY));
    this.timers.push(setTimeout(() => void this.autoClean(), 5 * 60_000) as unknown as ReturnType<typeof setInterval>);
    this.timers.push(setInterval(() => void this.autoClean(), CLEAN_EVERY));
    for (const t of this.timers) (t as { unref?: () => void }).unref?.();
    void this.check();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Tells the app when the free space or the low state changed; warns when low; clears sooner when low. */
  async check() {
    let s: StorageStatus;
    try {
      s = this.status();
    } catch (e) {
      log.warn(`couldn't read free space: ${e}`);
      return;
    }
    const prev = this.lastStatus;
    if (!prev || prev.low !== s.low || Math.abs(prev.free - s.free) >= GB / 2) {
      this.lastStatus = s;
      this.deps.onStatus?.(s);
    }
    if (!s.low) return;
    const notified = Number(this.deps.kvGet("storage.notifiedAt") ?? 0);
    if (Date.now() - notified >= NOTIFY_EVERY) {
      this.deps.kvSet("storage.notifiedAt", String(Date.now()));
      this.deps.onLow?.(s);
    }
    if (this.deps.settings().autoClean && Date.now() - this.lastAutoClean > 60 * 60_000) await this.autoClean();
  }

  /** What the Storage page shows: measures again in the background when asked or when the last scan is old. */
  report(rescan = false): StorageReport {
    if (!this.scanning && !this.deleting && (rescan || !this.last || Date.now() - this.last.at > 30 * 60_000)) void this.scan();
    return this.reportNow();
  }

  private reportNow(): StorageReport {
    return {
      status: this.status(),
      scannedAt: this.last?.at ?? null,
      busy: this.deleting ? "deleting" : this.cleaning ? "cleaning" : this.scanning ? "scanning" : null,
      lastDelete: this.lastDelete,
      chats: this.last?.chats ?? [],
      items: (this.last?.items ?? []).map(({ folder: _f, roomIds: _r, auto: _a, ...item }) => item),
      trash: this.last?.trash ?? null,
      caches: this.last?.caches ?? [],
      cleared: this.cleared(),
    };
  }

  cleared(): StorageCleared[] {
    try {
      const list = JSON.parse(this.deps.kvGet("storage.cleared") ?? "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private noteCleared(entries: StorageCleared[]) {
    if (!entries.length) return;
    this.deps.kvSet("storage.cleared", JSON.stringify([...entries, ...this.cleared()].slice(0, 60)));
  }

  /** Measures every chat folder (one scan at a time). */
  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.measure()
      .then((s) => void (this.last = s))
      .catch((e) => log.warn(`storage scan failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => (this.scanning = null));
    return this.scanning;
  }

  /** Chat folders by real path, with the rooms that use each. The home folder itself (or above it) is never scanned. */
  private folders(): Map<string, Room[]> {
    const home = (() => {
      try {
        return realpathSync(this.home);
      } catch {
        return this.home;
      }
    })();
    const out = new Map<string, Room[]>();
    for (const room of this.deps.rooms()) {
      let real: string;
      try {
        real = realpathSync(room.cwd);
      } catch {
        continue; // folder gone
      }
      if (inside(home, real) || !isDir(real)) continue;
      out.set(real, [...(out.get(real) ?? []), room]);
    }
    return out;
  }

  private async measure(): Promise<Scan> {
    const started = Date.now();
    const from = this.deps.listFrom ?? LIST_FROM;
    const items: Found[] = [];
    const chats: StorageChatFolder[] = [];
    const seen = new Set<string>();
    for (const [folder, rooms] of this.folders()) {
      const names = rooms.map((r) => r.name);
      const roomIds = rooms.map((r) => r.id);
      const activeAt = Math.max(...rooms.map((r) => r.updatedAt));
      const add = (item: Omit<Found, "id" | "chats" | "chatActiveAt" | "folder" | "roomIds">) => {
        if (seen.has(item.path)) return;
        seen.add(item.path);
        items.push({ ...item, id: idFor(item.path), chats: names, chatActiveAt: activeAt, folder, roomIds });
      };

      // Build output and installed dependencies, anywhere in the folder (not inside each other).
      const nameTests = [...Object.keys(DEPENDENCIES), ...BUILD_OUTPUT].flatMap((n) => ["-o", "-name", n]).slice(1);
      const prefixTests = BUILD_OUTPUT_PREFIXES.flatMap((p) => ["-o", "-name", `${p}*`]);
      const found = (await run(["find", folder, "-xdev", "(", "-name", ".git", "-o", "-name", ".crosstalk", ")", "-prune", "-o", "-type", "d", "(", ...nameTests, ...prefixTests, ")", "-print", "-prune"], 3 * 60_000))
        .split("\n")
        .filter((p) => p && p !== folder);
      const buildDirs: string[] = [];
      for (const path of found) {
        const name = basename(path);
        const parent = dirname(path);
        const deps = DEPENDENCIES[name];
        // A "target" folder without Cargo.toml or pom.xml beside it could be anything.
        if (name === "target" && !deps!.some((m) => existsIn(parent, m))) continue;
        buildDirs.push(path);
      }
      const buildSizes = await du(buildDirs, ["-s"]);
      for (const path of buildDirs) {
        const bytes = buildSizes.get(path) ?? 0;
        if (bytes < from.build) continue;
        const name = basename(path);
        const deps = DEPENDENCIES[name];
        const rebuilt = !!deps && (deps.length === 0 || deps.some((m) => existsIn(dirname(path), m)));
        add({
          kind: "build",
          name: relative(folder, path),
          path,
          bytes,
          modifiedAt: newestChange(path),
          note: deps
            ? "Installed dependencies: installed again by the next build."
            : name === ".venv" || name === "venv"
              ? "Python environment: made again by reinstalling the project's packages."
              : "Build output: made again by the next build. It may hold release files you haven't kept anywhere else.",
          auto: rebuilt,
        });
      }

      // The folder's total, and its big folders and files two levels down (du lists folders; find the big files).
      const sizes = await du([folder], ["-d", "2"]);
      const bigFiles = await run(["find", folder, "-mindepth", "1", "-maxdepth", "2", "-type", "f", "-size", `+${Math.max(1, Math.floor(from.large / 1024))}k`], 2 * 60_000);
      for (const path of bigFiles.split("\n").filter(Boolean)) {
        try {
          sizes.set(path, lstatSync(path).size);
        } catch {
          /* gone meanwhile */
        }
      }
      const total = sizes.get(folder) ?? 0;
      chats.push({ path: folder, chats: names, bytes: total, activeAt });
      const top = [...sizes.entries()].filter(([p]) => p !== folder);
      // Never a project or anything holding one, never inside .git or the chat's own .crosstalk, and never what's
      // already listed as build output.
      const qualifies = (path: string, bytes: number) => {
        const first = relative(folder, path).split(sep)[0];
        if (bytes < from.large || first === ".git" || first === ".crosstalk") return false;
        if (buildDirs.some((b) => inside(path, b))) return false;
        return !holdsProject(path);
      };
      const large = (path: string, bytes: number) =>
        add({ kind: "large", name: relative(folder, path), path, bytes, modifiedAt: newestChange(path), note: "Not made again on its own: check what it is before deleting it.", auto: false });
      for (const [path, bytes] of top) {
        // Inside a project only its build output is offered (listed above), never its other folders.
        if (relative(folder, path).split(sep).length !== 1 || isProject(path)) continue;
        // A big folder whose bulk is a few big folders: list those, so each can be kept or deleted.
        const kids = top.filter(([p, b]) => dirname(p) === path && qualifies(p, b));
        if (kids.length) for (const [p, b] of kids) large(p, b);
        else if (qualifies(path, bytes)) large(path, bytes);
      }

      // What the human sent in the chat.
      const uploads = join(folder, ".crosstalk", "uploads");
      if (isDir(uploads)) {
        const sent = await du([uploads], ["-d", "1"]);
        for (const entry of readdirSync(uploads)) {
          const path = join(uploads, entry);
          let bytes = sent.get(path);
          if (bytes === undefined) {
            try {
              bytes = lstatSync(path).size;
            } catch {
              continue;
            }
          }
          if (bytes < from.upload) continue;
          let name = entry.replace(UUID_PREFIX, "");
          if (isDir(path)) {
            const inner = readdirSync(path).filter((n) => !n.startsWith("."));
            name = inner.length === 1 ? `${inner[0]}/` : `${entry}/`;
          }
          add({ kind: "upload", name, path, bytes, modifiedAt: mtime(path), note: "You sent this in the chat. Its message will show it as missing.", auto: false });
        }
      }
    }
    items.sort((a, b) => b.bytes - a.bytes);
    chats.sort((a, b) => b.bytes - a.bytes);

    const caches: { what: string; bytes: number }[] = [];
    const cacheSizes = await du(CACHES.map((c) => join(this.home, c.path)).filter(isDir), ["-s"]);
    for (const c of CACHES) {
      const bytes = cacheSizes.get(join(this.home, c.path));
      if (bytes !== undefined) caches.push({ what: c.what, bytes });
    }
    const trashPath = join(this.home, ".Trash");
    const trash = isDir(trashPath) ? (await du([trashPath], ["-s"], 30_000)).get(trashPath) ?? null : null;
    log.info(`measured ${chats.length} chat folder(s) in ${Math.round((Date.now() - started) / 1000)} s: ${items.length} item(s) to review`);
    return { at: Date.now(), chats, items: items.slice(0, 200), trash, caches };
  }

  /**
   * Clears what's downloaded or rebuilt again when needed: tool caches (old entries always; everything when space is
   * low or `everything` is set), installed dependencies in hub-made chat folders unused for two weeks, and hub copies
   * older than a month. Returns the bytes cleared.
   */
  autoClean(everything = false): Promise<number> {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.clean(everything)
      .catch((e) => {
        log.warn(`cleanup failed: ${e instanceof Error ? e.message : e}`);
        return 0;
      })
      .finally(() => (this.cleaning = null));
    return this.cleaning;
  }

  private async clean(everything: boolean): Promise<number> {
    if ((!everything && !this.deps.settings().autoClean) || this.deleting) return 0;
    this.lastAutoClean = Date.now();
    const low = everything || this.status().low;
    const cleared: StorageCleared[] = [];
    const now = Date.now();

    for (const c of CACHES) {
      const dir = join(this.home, c.path);
      if (!isDir(dir)) continue;
      const whole = low && c.whenLow;
      if (!whole && !c.olderThanDays) continue;
      // Even when clearing it all, what was used in the last hour stays: a build may be using it right now.
      const entries = readdirSync(dir)
        .map((n) => join(dir, n))
        .filter((p) => now - newestChange(p) > (whole ? 60 * 60_000 : c.olderThanDays! * DAY));
      if (!entries.length) continue;
      const sizes = await du(entries, ["-s"]);
      let bytes = 0;
      for (const p of entries) {
        try {
          await rm(p, { recursive: true, force: true });
          bytes += sizes.get(p) ?? 0;
        } catch (e) {
          log.debug(`couldn't clear ${p}: ${e}`);
        }
      }
      if (bytes) cleared.push({ at: now, what: whole ? c.what : `Old ${c.what.charAt(0).toLowerCase()}${c.what.slice(1)}`, bytes, auto: true });
    }

    // Older copies of the hub program kept beside it (from updates): the newest two stay, others go after a month.
    const exe = this.deps.execPath;
    if (exe && basename(exe) === "crosstalk-hub") {
      const dir = dirname(exe);
      const copies = readdirSync(dir)
        .filter((n) => n.startsWith("crosstalk-hub."))
        .map((n) => join(dir, n))
        .filter((p) => lstatSync(p).isFile())
        .sort((a, b) => mtime(b) - mtime(a));
      for (const p of copies.slice(2)) {
        if (now - mtime(p) < 30 * DAY) continue;
        const bytes = statSync(p).size;
        await rm(p, { force: true });
        cleared.push({ at: now, what: `Old hub version (${basename(p)})`, bytes, auto: true });
      }
    }

    // Installed dependencies in chats unused for two weeks, in folders the hub made for chats.
    await this.scan();
    let root: string;
    try {
      root = realpathSync(this.deps.workspaceRoot);
    } catch {
      root = this.deps.workspaceRoot;
    }
    for (const item of this.last?.items ?? []) {
      if (!item.auto || !inside(item.folder, root) || item.folder === root) continue;
      if ((item.chatActiveAt ?? 0) > now - IDLE_CHAT_DAYS * DAY || newestChange(item.path) > now - IDLE_CHAT_DAYS * DAY) continue;
      if (item.roomIds.some((id) => this.deps.isBusy(id))) continue;
      try {
        await this.removeChecked(item);
        cleared.push({ at: now, what: `${item.name} in ${item.chats[0] ?? basename(item.folder)}`, bytes: item.bytes, auto: true });
      } catch (e) {
        log.debug(`couldn't clear ${item.path}: ${e}`);
      }
    }

    this.noteCleared(cleared);
    const total = cleared.reduce((n, c) => n + c.bytes, 0);
    if (total) {
      log.info(`cleared ${gb(total)}: ${cleared.map((c) => c.what).join(", ")}`);
      if (this.last) this.last.caches = (await this.measureCaches()) ?? this.last.caches;
      this.lastStatus = null;
      void this.check();
    }
    return total;
  }

  private async measureCaches() {
    const sizes = await du(CACHES.map((c) => join(this.home, c.path)).filter(isDir), ["-s"]);
    return CACHES.flatMap((c) => {
      const bytes = sizes.get(join(this.home, c.path));
      return bytes === undefined ? [] : [{ what: c.what, bytes }];
    });
  }

  /** Deletes an item from the last scan after checking it's still the same thing, in the same chat folder. */
  private async removeChecked(item: Found) {
    let info;
    try {
      info = lstatSync(item.path);
    } catch {
      return; // already gone
    }
    if (info.isSymbolicLink()) throw new HttpError(409, `${item.name} changed since the scan`);
    const real = realpathSync(item.path);
    if (real === item.folder || !inside(real, item.folder)) throw new HttpError(409, `${item.name} isn't in its chat folder anymore`);
    if (item.kind === "large" && holdsProject(real)) throw new HttpError(409, `${item.name} now holds a project`);
    await rm(real, { recursive: true, force: true });
  }

  /**
   * Deletes items the human picked on the Storage page (only items from the last scan), in the background: a big
   * folder can take minutes. The page checks back for `lastDelete`.
   */
  remove(ids: unknown): StorageReport {
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => typeof i !== "string")) throw new HttpError(400, "Pick what to delete");
    if (this.deleting || this.scanning || this.cleaning) throw new HttpError(409, "The hub is busy with storage right now: try again in a moment");
    const items = this.last?.items ?? [];
    const picked = [...new Set(ids as string[])].map((id) => items.find((i) => i.id === id));
    if (picked.some((i) => !i)) throw new HttpError(409, "The list changed: scan again and pick again");
    this.deleting = this.removeNow(picked as Found[])
      .catch((e) => log.warn(`delete failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => (this.deleting = null));
    return this.reportNow();
  }

  /** Resolves once a delete started with `remove` has finished (for tests). */
  whenIdle(): Promise<unknown> {
    return Promise.all([this.deleting, this.cleaning, this.scanning]);
  }

  private async removeNow(picked: Found[]) {
    let bytes = 0;
    const failed: { name: string; error: string }[] = [];
    const cleared: StorageCleared[] = [];
    const deleted: string[] = [];
    // Something inside another picked folder goes with it.
    const outer = picked.filter((i) => !picked.some((o) => o !== i && o.path !== i.path && inside(i.path, o.path)));
    for (const item of outer) {
      if (item.roomIds.some((id) => this.deps.isBusy(id))) {
        failed.push({ name: item.name, error: "Its chat is working: try again when it's done" });
        continue;
      }
      try {
        await this.removeChecked(item);
        deleted.push(item.path);
        bytes += item.bytes;
        cleared.push({ at: Date.now(), what: `${item.name} in ${item.chats[0] ?? basename(item.folder)}`, bytes: item.bytes, auto: false });
      } catch (e) {
        failed.push({ name: item.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const removed = deleted.length;
    if (this.last) this.last.items = this.last.items.filter((i) => !deleted.some((d) => inside(i.path, d)));
    this.noteCleared(cleared);
    this.lastDelete = { at: Date.now(), removed, bytes, failed };
    this.lastStatus = null;
    void this.check();
    if (removed) log.info(`deleted ${removed} item(s) from chat folders (${gb(bytes)})`);
  }

  /** A line for agents' prompts while space is low, so they clean up before building or downloading more. */
  agentNotice(): string | null {
    let s: StorageStatus;
    try {
      s = this.lastStatus ?? this.status();
    } catch {
      return null;
    }
    // Only when it's getting urgent (half the human's warning level): a disk that hovers near the warning level
    // shouldn't add this to every turn.
    const urgent = Math.max((this.deps.settings().lowSpaceGb * GB) / 2, s.reserve * 2);
    if (s.free >= urgent) return null;
    return `Crosstalk: this machine is low on disk space (${gb(s.free)} free). Before building or downloading more, delete what you made that isn't needed anymore, such as old build outputs, releases that are already published, test images and unpacked archives.`;
  }
}

function existsIn(dir: string, name: string): boolean {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}
