// The memory guard: the one place in the hub that knows what heavy things are running on this machine, whether the
// next one fits beside them, and when the machine is close to thrashing.
//
// Why it exists. A phone can lose its hub on a 16 GB machine without the hub ever being killed or losing its
// listeners: with ComfyUI holding 12.5 GiB of image weights and llama-server another ~10.9 GiB working set, the
// machine swaps 16,000+ pages a second, and the hub (42 MB, 0.26% of the machine) simply can't be paged back in and
// scheduled inside the phone's 5-second ping deadline. Nothing anywhere had asked whether the second
// model fitted beside the first. `needOf`/`fitOf` in shared knew how to ask -- but only two Settings screens ever
// called them, only about one model at a time, and only against an empty machine.
//
// What this does and does not do:
//  - Before anything heavy starts (a local model server, the image editor, the model pool's server) it answers
//    "does this fit beside what is already running?" in the words of the same verdict the download screens use.
//  - While things run it watches the real pressure signal -- not "free memory", which reads 0.1 GB on a healthy Mac --
//    and tells the phone what is squeezing the machine and the one or two things that would help.
//  - It never stops anything by itself, and above all never one of the person's own processes. A ComfyUI or
//    llama-server the person started is only ever read; the hub says what it sees.
//  - Its own work is two sysctl reads (a Mac) or two small file reads (Linux) every 10 seconds, with no process
//    spawned and nothing synchronous that can take more than microseconds: a guard that blocked the event loop would
//    be the very fault it was built to report.

import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { LocalMachine, MachineMemory, MemoryBand, MemoryHolder, MemorySection } from "@crosstalk/shared";
import { MEMORY_SMALL, THRASH_PAGE_BYTES, memoryBandOf, memoryNotice, memoryRefusal, ramRoom, roomFor, thrashPagesPerSec, type MemoryPool } from "@crosstalk/shared";
import { HttpError } from "./engine/engine";
import { logger } from "./util/log";

const log = logger("memory");

/**
 * How often the machine is read. Ten seconds is Firefox's own interval on the same macOS signal while pressure
 * lasts, and it is slow enough that the swap rate between two looks is a sustained rate rather than a spike.
 */
const SAMPLE_MS = 10_000;
/** The heavy things are only counted this often, and only when something asks: counting them can cost an `lsof`. */
const HOLDERS_MS = 60_000;
/** One notification per spell of trouble, at most this often. */
const NOTIFY_MS = 30 * 60_000;
/**
 * How long a start may wait on the guard before it answers with what it already knows. Both of the slow steps have
 * their own long deadlines (`listDevices` waits 20 s for a GPU list, each `lsof` 5 s), and a phone gives up on a
 * request after 20 s: a guard that made a switch time out would be the very fault it exists to report.
 */
const CEILING_WAIT_MS = 2000;
const GATHER_WAIT_MS = 3000;
/**
 * The shortest window a swap rate is worked out over. The timer samples every ten seconds and a start takes a look of
 * its own: without a floor, two looks a tenth of a second apart turn one ordinary burst of paging into thousands of
 * pages a second. Two seconds is long enough that the number means a sustained rate.
 */
const RATE_MIN_MS = 2000;

/** `job`'s answer, or null when it hasn't come within `ms` (it is left to finish on its own). */
function waitAtMost<T>(job: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    void job.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(null)),
    );
  });
}

/** What one look at the machine gives. */
export interface Reading {
  /** 0 to 100: memory that is neither wired nor held by the compressor (a Mac), or MemAvailable's share (Linux). */
  level: number;
  /**
   * About how much memory could really be had now: the share above as bytes. The bands need it because a share is
   * the wrong unit on a big machine (31% of a 64 GB hub is 20 GB free, which is nobody's "nearly out of memory").
   */
  freeBytes: number | null;
  /** Swap pages moved in and out since the machine started; null where it isn't counted. */
  swapPages: number | null;
  swapUsedBytes: number | null;
}

/** How a machine is read. One per platform; a machine with none is honest about knowing nothing. */
export interface MemoryReader {
  /** Why this machine's memory can't be read, in plain words; null when it can. */
  blind: string | null;
  read(): Reading | null;
  /** What one process holds, as Activity Monitor counts it; null when it can't be measured. */
  footprint(pid: number): number | null;
  ramBytes(): number;
  /**
   * The size of the pages `swapPages` counts, so the thrashing line can be a rate of bytes rather than of pages:
   * 16 KiB on Apple silicon, 4 KiB on most Linux. Null where it isn't known (nothing is then refused for thrashing
   * at a rate that may be four times off).
   */
  pageBytes(): number | null;
}

// ---- Reading a Mac ----

/**
 * macOS, through libSystem, with no process spawned:
 *  - `kern.memorystatus_level` is the number jetsam itself compares against. Checked against `vm_stat` on this Mac:
 *    it is 100 x (free + active + inactive) / pages, i.e. the share of memory that is neither wired nor compressed.
 *    "Pages free" is the wrong signal -- it read 0.11 GB on a machine that was working fine.
 *  - `vm.swapusage` gives swap used, and `host_statistics64` the swapin/swapout counters whose difference between two
 *    looks is the thrash rate.
 *  - `proc_pid_rusage(..., RUSAGE_INFO_V4)` gives another process of this user its `ri_phys_footprint` -- the same
 *    number Activity Monitor's Memory column shows, and the only one worth having: resident size collapses to
 *    near zero under pressure (llama-server measured 720 KB resident against a 3.8 GB footprint).
 */
function macReader(): MemoryReader | null {
  let symbols: {
    sysctlbyname: (name: Uint8Array, out: unknown, len: unknown, set: null, setLen: bigint) => number;
    mach_host_self: () => number;
    host_statistics64: (host: number, flavor: number, out: unknown, count: unknown) => number;
    proc_pid_rusage: (pid: number, flavor: number, out: unknown) => number;
  };
  let toPtr: (v: unknown) => unknown;
  try {
    // Imported here, not at the top, so a hub on a machine without it still loads.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    toPtr = ffi.ptr as unknown as (v: unknown) => unknown;
    symbols = ffi.dlopen("libSystem.B.dylib", {
      sysctlbyname: { args: ["cstring", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
      mach_host_self: { args: [], returns: "u32" },
      host_statistics64: { args: ["u32", "i32", "ptr", "ptr"], returns: "i32" },
      proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
    }).symbols as unknown as typeof symbols;
  } catch (e) {
    log.warn(`this Mac's memory can't be read: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  const name = (s: string) => new TextEncoder().encode(`${s}\0`);
  const sysctl = (key: string, bytes: number): DataView | null => {
    const out = new Uint8Array(bytes);
    const len = new BigUint64Array(1);
    len[0] = BigInt(bytes);
    if (symbols.sysctlbyname(name(key), toPtr(out), toPtr(len), null, 0n) !== 0) return null;
    return new DataView(out.buffer, 0, Number(len[0]));
  };
  const sysctlInt = (key: string): number | null => {
    const v = sysctl(key, 8);
    if (!v) return null;
    return v.byteLength >= 8 ? Number(v.getBigUint64(0, true)) : v.byteLength >= 4 ? v.getUint32(0, true) : null;
  };
  const ram = sysctlInt("hw.memsize") ?? totalmem();
  // The swap counters below are in pages, and the kernel's thrashing line is a rate of bytes: 16 KiB on Apple silicon.
  const page = sysctlInt("vm.pagesize") ?? sysctlInt("hw.pagesize") ?? THRASH_PAGE_BYTES;
  /** `struct vm_statistics64`: swapins at 112 and swapouts at 120, both 64-bit (checked against the local SDK header). */
  const HOST_VM_INFO64 = 4;
  const VM_COUNT = 38;
  const swapPages = (): number | null => {
    const out = new Uint8Array(VM_COUNT * 4 + 64);
    const count = new Uint32Array(1);
    count[0] = VM_COUNT;
    if (symbols.host_statistics64(symbols.mach_host_self(), HOST_VM_INFO64, toPtr(out), toPtr(count)) !== 0) return null;
    const v = new DataView(out.buffer);
    return Number(v.getBigUint64(112, true)) + Number(v.getBigUint64(120, true));
  };

  return {
    blind: null,
    ramBytes: () => ram,
    pageBytes: () => page,
    read() {
      const level = sysctlInt("kern.memorystatus_level");
      if (level === null || level < 0 || level > 100) return null;
      // `struct xsw_usage`: total, available, used, each 64-bit.
      const swap = sysctl("vm.swapusage", 32);
      return { level, freeBytes: Math.round((level / 100) * ram), swapPages: swapPages(), swapUsedBytes: swap && swap.byteLength >= 24 ? Number(swap.getBigUint64(16, true)) : null };
    },
    footprint(pid) {
      // `struct rusage_info_v4`: ri_phys_footprint at offset 72 (the same offset in every version since v0).
      const out = new Uint8Array(512);
      if (symbols.proc_pid_rusage(pid, 4, toPtr(out)) !== 0) return null;
      const bytes = Number(new DataView(out.buffer).getBigUint64(72, true));
      return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
    },
  };
}

// ---- Reading a Linux hub ----

const fieldKb = (text: string, key: string): number | null => {
  const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
  return m ? Number(m[1]) * 1024 : null;
};

/**
 * Linux, from /proc, with no process spawned. `MemAvailable` is the kernel's own estimate of what can be had without
 * swapping -- the closest thing Linux has to the Mac's level, and the right answer for the same reason: `MemFree`
 * alone says a machine with a healthy page cache is out of memory. `pswpin`/`pswpout` in /proc/vmstat are the swap
 * counters. A Linux hub gets a real verdict from this, not a shrug.
 *
 * One reading is taken here, at construction: a hub whose /proc can't be read at all (a container, a hardened host)
 * must say so, because `tick` returns early on every failed read and the band would otherwise sit on "fine" for ever
 * -- the hub claiming memory is fine on the one machine it knows nothing about.
 */
export function linuxReader(read: (path: string) => string = (p) => readFileSync(p, "utf8")): MemoryReader {
  const r = procReader(read);
  if (r.read() === null) return blindReader("Crosstalk can't read /proc on this hub, so it can't say how its memory is doing. Nothing is held back.");
  return r;
}

function procReader(read: (path: string) => string): MemoryReader {
  let ram = 0;
  let pageSize = 0;
  return {
    blind: null,
    ramBytes: () => ram || totalmem(),
    pageBytes: () => pageSize || null,
    read() {
      let info: string;
      let vmstat = "";
      try {
        info = read("/proc/meminfo");
      } catch {
        return null;
      }
      try {
        vmstat = read("/proc/vmstat");
      } catch {
        // No swap counters: the level still works.
      }
      const total = fieldKb(info, "MemTotal");
      const available = fieldKb(info, "MemAvailable");
      if (!total || available === null) return null;
      ram = total;
      const swapTotal = fieldKb(info, "SwapTotal");
      const swapFree = fieldKb(info, "SwapFree");
      const counter = (key: string) => {
        const m = new RegExp(`^${key} (\\d+)`, "m").exec(vmstat);
        return m ? Number(m[1]) : null;
      };
      const inPages = counter("pswpin");
      const outPages = counter("pswpout");
      // How big a page is here, from the kernel's own two views of the same number (MemFree in kB, nr_free_pages in
      // pages), rounded to a power of two: 4 KiB on x86_64, 16 or 64 KiB on some arm64. No process is spawned for it,
      // so `getconf PAGESIZE` is out; 4 KiB when it can't be worked out, which is what most Linux uses.
      if (!pageSize) {
        const freeBytes = fieldKb(info, "MemFree");
        const freePages = counter("nr_free_pages");
        const guess = freeBytes !== null && freePages ? 2 ** Math.round(Math.log2(freeBytes / freePages)) : 0;
        pageSize = guess >= 4096 && guess <= 64 * 1024 ? guess : 4096;
      }
      return {
        level: Math.max(0, Math.min(100, Math.round((available / total) * 100))),
        // MemAvailable itself: the kernel's own estimate of what can be had without swapping.
        freeBytes: available,
        swapPages: inPages === null || outPages === null ? null : inPages + outPages,
        swapUsedBytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
      };
    },
    // Linux has no per-process footprint; VmRSS is what there is, and it is read straight from /proc.
    footprint(pid) {
      try {
        const kb = Number(/VmRSS:\s+(\d+)/.exec(read(`/proc/${pid}/status`))?.[1]);
        return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
      } catch {
        return null;
      }
    },
  };
}

/** A hub on a machine neither of those reads. It says so and stands in the way of nothing. */
export const blindReader = (why: string): MemoryReader => ({ blind: why, read: () => null, footprint: () => null, ramBytes: () => totalmem(), pageBytes: () => null });

/** The reader for the machine this hub is on. */
export function readerFor(platform: NodeJS.Platform): MemoryReader {
  if (platform === "darwin") return macReader() ?? blindReader("Crosstalk can't read this Mac's memory, so it won't stand in the way of anything starting.");
  if (platform === "linux") return linuxReader();
  return blindReader(`Crosstalk only watches memory on macOS and Linux hubs, so it can't say how this ${platform} machine is doing. Nothing is held back.`);
}

// ---- The guard ----

/** A heavy thing the hub knows about, before it has been measured. */
export interface HolderProbe {
  what: string;
  /** Crosstalk started it (Settings can turn it off), or it is the person's own (never touched). */
  ours: boolean;
  section: MemorySection | null;
  /** Its process, when the hub knows it: measured here with no process spawned. */
  pid?: number | null;
  /**
   * Already measured elsewhere (the image editor measures itself every few seconds), or what it is going to hold
   * while it loads and nothing has measured it yet.
   */
  bytes?: number | null;
  /**
   * A server the hub didn't start: who listens there is looked up, and only when the holders are counted. Nothing
   * listening means nothing to report, so the holder is dropped rather than shown with no size.
   */
  port?: number | null;
}

/** A heavy thing as the guard measured it. The processes stay here and never go to a phone: they are how one process
 * counted twice (the pool's server is both a process the hub started and the address its account points at) becomes
 * one row, and how a start can leave out the thing it is about to stop. */
interface Held extends MemoryHolder {
  pids: number[];
}

const plain = (h: Held): MemoryHolder => ({ what: h.what, ours: h.ours, section: h.section, bytes: h.bytes });

/** What something about to start asks the guard about. */
export interface MemoryWant {
  what: string;
  /** What it will hold; null when that can't be worked out beforehand (Ollama, a pool server running on helpers). */
  needBytes: number | null;
  /**
   * Which memory it draws on. llama.cpp and the pool's server live inside the GPU's (Metal's working set, or a card's
   * VRAM); the image editor is ComfyUI, which doesn't, and is measured against the machine's memory instead.
   */
  on?: MemoryPool;
  /** A process this start replaces: it is stopped as part of the start, so it isn't counted as holding anything. */
  replacing?: number | null;
  /** False where the screen that asked has no "Start anyway", so the words don't promise one (the model pool). */
  canForce?: boolean;
}

/** What the guard says about starting something. */
export interface MemoryVerdict {
  ok: boolean;
  /** Why not, in plain words with the choice a person can make; empty when it's fine. */
  text: string;
  /** What is free for this start in the memory it draws on (the GPU's, or the machine's), less what is held. */
  freeBytes: number;
  holders: MemoryHolder[];
  band: MemoryBand;
}

export interface MemoryDeps {
  machineName: () => string;
  /** The heavy things running now. Gathered on demand only -- never on the timer. */
  holders: () => Promise<HolderProbe[]>;
  /** Who listens on a port this hub didn't start (one `lsof`); none: such a holder goes unmeasured. */
  listeners?: (port: number) => Promise<number[]>;
  /** This machine's memory and GPUs, so the guard's ceiling is the same one the download screens show. */
  machine?: () => Promise<LocalMachine>;
  /** The band or what's holding the machine changed. */
  emit?: (memory: MachineMemory) => void;
  /** Tell the phone the machine is nearly out (at most one per spell). */
  notify?: (note: { title: string; body: string }) => void;
  reader?: MemoryReader;
  sampleMs?: number;
  now?: () => number;
}

/** Worst last, for telling whether a band got worse. */
const BANDS: MemoryBand[] = ["unknown", "fine", "busy", "tight", "full"];

export class MemoryGuard {
  /** How this machine is read (tests give their own, so none of them looks at the machine running them). */
  reader: MemoryReader;
  private sampleMs: number;
  private now: () => number;
  private last: Reading | null = null;
  private lastAt = 0;
  /** Where the swap rate is measured from: moved only when a window long enough to divide by has gone by. */
  private swap: { pages: number; at: number } | null = null;
  private rate: number | null = null;
  private band: MemoryBand = "unknown";
  private holders: Held[] = [];
  private holdersAt = 0;
  private gathering: Promise<Held[]> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notifiedAt: number | null = null;
  private sent = "";

  constructor(private readonly deps: MemoryDeps) {
    this.reader = deps.reader ?? readerFor(process.platform);
    this.sampleMs = deps.sampleMs ?? SAMPLE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.band = this.reader.blind ? "unknown" : "fine";
  }

  /** Starts looking. The timer is unref'd, so it never keeps the hub alive by itself. */
  start() {
    if (this.timer || this.reader.blind) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.sampleMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One look at the machine: two sysctls or two small files, microseconds, no process, nothing awaited. Everything
   * that could take time (counting the heavy things, notifying a phone) is started from here, never waited for.
   */
  tick() {
    const r = this.reader.read();
    if (!r) return;
    const at = this.now();
    const first = this.last === null;
    this.last = r;
    this.lastAt = at;
    // The swap rate is only recomputed over a window long enough to mean something, and the baseline only moves when
    // it is used. `verdict` takes a look of its own, and a start that landed 120 ms after the timer's look used to
    // divide that sliver into whatever paging an app launch had just done: 250 pages read as 2,083 a second and
    // refused the start on a machine with 12 GB free. The other way round too -- a pair of looks in a quiet gap on a
    // thrashing machine read as 0 and lifted the refusal.
    if (r.swapPages !== null) {
      if (!this.swap || r.swapPages < this.swap.pages) this.swap = { pages: r.swapPages, at };
      else if (at - this.swap.at >= RATE_MIN_MS) {
        this.rate = Math.max(0, Math.round((r.swapPages - this.swap.pages) / ((at - this.swap.at) / 1000)));
        this.swap = { pages: r.swapPages, at };
      }
    }
    const band = memoryBandOf(r.level, this.rate, { pageBytes: this.reader.pageBytes(), freeBytes: r.freeBytes });
    const worse = BANDS.indexOf(band) > BANDS.indexOf(this.band);
    this.band = band;
    this.publish();
    // The heavy things cost an `lsof` to count, so they are only counted when the machine is in trouble, and at most
    // once a minute. `gather` publishes again once it knows them.
    if ((band === "tight" || band === "full") && at - this.holdersAt >= HOLDERS_MS) void this.gather().catch(() => {});
    // Never from the very first look: one reading has no swap rate behind it, and a hub that restarts into a busy
    // machine shouldn't open with a notification before it has seen the machine move.
    if (worse && !first && (band === "tight" || band === "full")) void this.tell().catch(() => {});
  }

  /** What the phone and Settings see. Cheap and synchronous: the last look, never a new one. */
  status(): MachineMemory {
    const measured = this.holders.filter((h) => h.bytes !== null);
    return {
      band: this.reader.blind ? "unknown" : this.band,
      level: this.last?.level ?? null,
      blind: this.reader.blind,
      ramBytes: this.reader.ramBytes(),
      takenBytes: measured.length ? measured.reduce((n, h) => n + (h.bytes ?? 0), 0) : null,
      swapPagesPerSec: this.rate,
      swapUsedBytes: this.last?.swapUsedBytes ?? null,
      holders: this.holders.map(plain),
      at: this.lastAt,
    };
  }

  /**
   * Before something heavy starts. Three tests, all of which have to pass, and all three of which the swapping case
   * at the top of this file would have failed:
   *   1. the machine isn't in the tight or full band (which now takes a share *and* little really left: 31% of a
   *      64 GB hub is 20 GB free, which is no reason to refuse a 4 GB model),
   *   2. it isn't thrashing,
   *   3. what this needs, plus what the other heavy things hold, fits in the memory it draws on.
   * A machine the guard can't read never refuses anything.
   */
  async verdict(want: MemoryWant): Promise<MemoryVerdict> {
    if (this.reader.blind) return { ok: true, text: "", freeBytes: 0, holders: [], band: "unknown" };
    // A fresh look: it costs nothing, and the sampler may be nine seconds old.
    this.tick();
    // Both at once, each with its own deadline: a start waits for the slower of the two, never for both in turn.
    const [held, machine] = await Promise.all([this.gather(), this.facts()]);
    // What this start replaces is stopped as part of it, so it isn't holding anything by the time the new one runs.
    const counted = want.replacing ? held.filter((h) => !h.pids.includes(want.replacing as number)) : held;
    const holders = counted.map(plain);
    const taken = counted.reduce((n, h) => n + (h.bytes ?? 0), 0);
    const freeBytes = this.room(machine, taken, want.on ?? "gpu");
    const band = this.band;
    const thrashing = this.rate !== null && this.rate >= thrashPagesPerSec(this.reader.pageBytes());
    const tooBig = want.needBytes !== null && want.needBytes > freeBytes;
    // The band itself only reaches tight or full when the machine really has little left (`MEMORY_FLOOR`), so this
    // no longer refuses a 4 GB model on a 64 GB hub with 20 GB free just because 20 of 64 is 31%.
    if (band !== "tight" && band !== "full" && !thrashing && !tooBig) return { ok: true, text: "", freeBytes, holders, band };
    const name = this.deps.machineName();
    const text = memoryRefusal({ what: want.what, needBytes: want.needBytes, freeBytes, machine: name, holders, why: tooBig ? "space" : "pressure", canForce: want.canForce });
    return { ok: false, text, freeBytes, holders, band };
  }

  /**
   * The same, but it throws the refusal as a 409 with the code "memory", which is what makes the phone offer
   * "Start anyway" instead of a dead end. `force` is that tap: the machine is the person's.
   */
  async check(want: MemoryWant & { force?: boolean }): Promise<MemoryVerdict> {
    const v = await this.verdict(want);
    if (!v.ok && !want.force) throw new HttpError(409, v.text, "memory");
    if (!v.ok) log.info(`${want.what} started anyway: ${v.text}`);
    return v;
  }

  /**
   * This machine's facts, for the ceiling. They can cost a llama.cpp run that waits up to 20 s for a GPU list, and the
   * guard must never be the slow thing in a request. The answer is cached for a minute on the other side, so the wait
   * is paid once; null is "not in time", and then the ceiling comes from the memory alone.
   */
  private async facts(): Promise<LocalMachine | null> {
    if (!this.deps.machine) return null;
    return (await waitAtMost(this.deps.machine().catch(() => null), CEILING_WAIT_MS)) ?? null;
  }

  /**
   * What is free for this start: the download screens' own ceiling for anything inside the GPU's memory, and the
   * machine's own memory for anything that isn't llama.cpp (`roomFor`, in shared, is the one copy of that arithmetic).
   * Without the machine's facts, a quarter of the memory is held back for the system, as the screens do.
   */
  private room(m: LocalMachine | null, taken: number, on: MemoryPool): number {
    const ram = this.reader.ramBytes();
    if (m) {
      const r = roomFor(m, taken, on);
      if (r.totalBytes > 0) return r.freeBytes;
    }
    return Math.max(0, (on === "ram" ? ram : ramRoom(ram)) - taken);
  }

  /**
   * Counts the heavy things, one count at a time, at most one `lsof` per server the hub didn't start. A count that
   * drags on (an `lsof` on a machine deep in swap) is left to finish on its own, and the last one answers meanwhile:
   * the whole point of this module is that nothing waits on a machine that is already too slow.
   */
  private gather(): Promise<Held[]> {
    if (this.gathering) return waitAtMost(this.gathering, GATHER_WAIT_MS).then((list) => list ?? this.holders);
    const job = this.measure()
      .then((list) => {
        this.holders = list;
        this.holdersAt = this.now();
        this.publish();
        return list;
      })
      .catch((e) => {
        log.warn(`couldn't see what's running: ${e instanceof Error ? e.message : e}`);
        return this.holders;
      })
      .finally(() => {
        this.gathering = null;
      });
    this.gathering = job;
    return waitAtMost(job, GATHER_WAIT_MS).then((list) => list ?? this.holders);
  }

  private async measure(): Promise<Held[]> {
    const probes = await this.deps.holders();
    // All at once: the ports the hub didn't start each cost an `lsof`, and one after another they add up.
    const out = await Promise.all(
      probes.map(async (p): Promise<Held & { found: boolean }> => {
        const pids = p.pid ? [p.pid] : [];
        let bytes = p.pid ? this.reader.footprint(p.pid) : null;
        const given = typeof p.bytes === "number" && p.bytes > 0;
        if (bytes === null && given) bytes = p.bytes as number;
        let found = pids.length > 0 || given;
        if (bytes === null && p.port && this.deps.listeners) {
          const listening = await this.deps.listeners(p.port).catch(() => []);
          // Nothing listens there, so there is nothing to report: the person's llama-server is quit and their
          // custom-model account still points at the port. A row reading "size unknown", with "Quit it on this
          // machine", would send them after a program that isn't running -- and name it as what is holding the
          // machine. A size that couldn't be read is a different thing, and keeps its row.
          found = listening.length > 0;
          pids.push(...listening);
          const sum = listening.map((pid) => this.reader.footprint(pid)).filter((n): n is number => n !== null).reduce((n, v) => n + v, 0);
          if (sum > 0) bytes = sum;
        }
        return { what: p.what, ours: p.ours, section: p.section, bytes, pids, found };
      }),
    );
    // One process is one holder, whichever way it was found. The pool's own server is both a process the hub started
    // and the address its "Model pool" account points at: counted twice, a 10 GB model read as 20 GB taken on a 16 GB
    // machine, which refused every start after it and named a holder that didn't exist.
    const claimed = new Set<number>();
    const once = out.filter((h) => {
      if (h.pids.some((pid) => claimed.has(pid))) return false;
      for (const pid of h.pids) claimed.add(pid);
      return true;
    });
    // Biggest first, and nothing too small to be worth a row on a phone (the hub's own 42 MB never is).
    return once
      .filter((h) => (h.bytes === null ? h.found : h.bytes >= MEMORY_SMALL))
      .map((h) => ({ what: h.what, ours: h.ours, section: h.section, bytes: h.bytes, pids: h.pids }))
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  }

  /** One notification per spell of trouble: it names what's holding the machine and what would free it. */
  private async tell() {
    const at = this.now();
    if (!this.deps.notify || (this.notifiedAt !== null && at - this.notifiedAt < NOTIFY_MS)) return;
    this.notifiedAt = at;
    await this.gather().catch(() => {});
    const s = this.status();
    if (s.band !== "tight" && s.band !== "full") return;
    this.deps.notify(memoryNotice(s, this.deps.machineName()));
  }

  /** Sends the state on only when it says something new: no event per look. */
  private publish() {
    const s = this.status();
    const key = JSON.stringify([s.band, s.blind, s.holders.map((h) => [h.what, h.bytes === null ? null : Math.round((h.bytes / 1024 ** 3) * 10)])]);
    if (key === this.sent) return;
    this.sent = key;
    this.deps.emit?.(s);
  }
}

