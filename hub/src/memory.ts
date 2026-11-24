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
//  - Before anything heavy starts (a local model server, the image editor) it answers
//    "does this fit beside what is already running?" in the words of the same verdict the download screens use.
//  - While things run it watches the real pressure signal -- not "free memory", which reads 0.1 GB on a healthy Mac --
//    and tells the phone what is squeezing the machine and the one or two things that would help.
//  - It never stops one of the person's own processes. A ComfyUI or llama-server the person started is only ever
//    read; the hub says what it sees.
//  - Its own work is two sysctl reads (a Mac) or two small file reads (Linux) every 10 seconds, with no process
//    spawned and nothing synchronous that can take more than microseconds: a guard that blocked the event loop would
//    be the very fault it was built to report. While the machine is below "fine" it also reads the process table
//    (a few milliseconds, still no process spawned) to say who holds the memory.
//
// What it does about it ("Free memory by itself", on unless turned off in Settings). On 2026-11-21 an agent drove the
// agents' browser through hundreds of pages on a 16 GB Mac. The guard saw it coming, sent one notification that named
// neither the browser nor the chat, and then watched for 22 minutes until the machine froze. So now, in two steps:
//  - Tight: agent processes with nothing to do are ended, new replies wait ("Waiting for memory") while agents are
//    what fills the machine, the agent that is filling it is told so in the middle of its reply, and the phone is
//    told who holds what.
//  - Full: that agent's reply is stopped, and if the agents' browser still holds more than 3 GB its page processes
//    are asked to quit, biggest first, until there is room again. Never the browser itself (its tabs then show
//    "reload" and every sign-in stays), and never a process that isn't the agents' browser's.
// What it saw last is kept in a small file, so a hub that comes back after the machine froze doesn't start the same
// reply again by itself (`wentDown`).

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { totalmem } from "node:os";
import type { LocalMachine, MachineMemory, MemoryBand, MemoryCulprit, MemoryHolder, MemorySection } from "@crosstalk/shared";
import {
  MEMORY_BANDS,
  MEMORY_SMALL,
  THRASH_PAGE_BYTES,
  bytesText,
  holderText,
  memoryAskedLine,
  memoryBandOf,
  memoryCulpritNotice,
  memoryNotice,
  memoryRefusal,
  memoryStopError,
  memorySteer,
  memoryStoppedLine,
  ramRoom,
  roomFor,
  thrashPagesPerSec,
  type MemoryPool,
} from "@crosstalk/shared";
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
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/**
 * When Crosstalk acts, and how far it goes. All in one place so they can be tuned. They sit on the same scale as the
 * bands (`MEMORY_BANDS` in shared: the level is the share of memory still to be had, tight under 35, full under 25),
 * and like the bands they never fire on a big machine with plenty really left (`MEMORY_FLOOR`).
 */
export const MEMORY_ACT = {
  // ---- The tight step: the tight band (level under 35), or already getting full while swap keeps growing. ----
  /** Swap in use growing by this much within `swapGrowingMs`, in the busy band, is tight too: the level only holds
   * because the machine is moving memory to the disk as fast as it is asked for. */
  swapGrowingBytes: 512 * MiB,
  swapGrowingMs: 60_000,
  /** That early tight only counts with less than this really left: the busy band's share of the 16 GB the bands were measured on. */
  earlyFloorBytes: Math.round((MEMORY_BANDS.busy / 100) * 16 * GiB),
  /** An agent process with nothing to do for this long is ended at the tight step (the engine's own rule waits 20 minutes). */
  idleMs: 60_000,
  /** New replies wait at most this long for memory, then start anyway: someone is waiting for them. */
  holdMaxMs: 3 * 60_000,

  // ---- The full step, which only ever follows the tight one. Any of: ----
  /** the full band (level under 25) for this long, */
  fullMs: 20_000,
  /** swap moving faster than the kernel's own thrashing line (`THRASH_PAGES_PER_SEC`) for this long, */
  thrashMs: 30_000,
  /** or, this long after the tight step, a level this many points below where it was then. */
  fallingMs: 60_000,
  fallingPoints: 5,

  // ---- Whose fault it is. ----
  /** A holder is growing once it has gained this much since the machine left "fine". */
  growthBytes: 512 * MiB,
  /** The one that leads is the one growing most, unless something else holds more than twice as much (then that one
   * is the cause, and stopping a reply would free little: the image editor's 12 GB beside an agent's 2). */
  leadShare: 0.5,
  /** An agent's processes, or the agents' browser, are only acted on from this size up: an agent at rest is a few hundred MB. */
  actMinBytes: 2 * GiB,
  /** At the full step, the agents' browser's page processes are asked to quit while it holds more than this. */
  browserMaxBytes: 3 * GiB,
  /** How long one page process is given to go before the level is read again, and how many are ever asked in one go. */
  rendererPauseMs: 1000,
  renderersMax: 80,

  /** Trouble is over once the machine has been out of it for this long: only then can either step happen again. */
  calmMs: 60_000,
} as const;
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

/** One process, as a look at the process table gives it. */
export interface ProcessRow {
  pid: number;
  /** The process that started it. */
  ppid: number;
  /** Its program's full path; only its name where the path can't be read (another user's process). */
  path: string;
  /** What it holds, as `footprint` counts it; null when it can't be measured (another user's process). */
  bytes: number | null;
  /** Its command line, where the look was asked for it (`wantArgs`): how a browser's page process is told from the rest. */
  args?: string | null;
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
  /**
   * Every process on the machine, with no process spawned to list them; null (or left out) where they can't be listed.
   * `wantArgs`: the programs whose command line is worth a second read.
   */
  processes?(wantArgs?: (path: string) => boolean): ProcessRow[] | null;
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
 *  - The process table comes from `proc_listallpids`, each process's parent from `proc_pidinfo` and its program from
 *    `proc_pidpath`: 775 processes read in 7 ms on this Mac, against 130 ms and a child process for one `ps`.
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
  // The process table is opened on its own: a Mac where these can't be had still reads its memory.
  type Procs = {
    proc_listallpids: (out: unknown, bytes: number) => number;
    proc_pidinfo: (pid: number, flavor: number, arg: bigint, out: unknown, bytes: number) => number;
    proc_pidpath: (pid: number, out: unknown, bytes: number) => number;
    sysctl: (mib: unknown, n: number, out: unknown, len: unknown, set: null, setLen: bigint) => number;
  };
  let procs: Procs | null = null;
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    procs = ffi.dlopen("libSystem.B.dylib", {
      proc_listallpids: { args: ["ptr", "i32"], returns: "i32" },
      proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
      proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
      sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
    }).symbols as unknown as Procs;
  } catch (e) {
    log.warn(`this Mac's processes can't be listed, so Crosstalk can't say who holds its memory: ${e instanceof Error ? e.message : e}`);
  }
  const text = new TextDecoder();
  const footprint = (pid: number): number | null => {
    // `struct rusage_info_v4`: ri_phys_footprint at offset 72 (the same offset in every version since v0).
    const out = new Uint8Array(512);
    if (symbols.proc_pid_rusage(pid, 4, toPtr(out)) !== 0) return null;
    const bytes = Number(new DataView(out.buffer).getBigUint64(72, true));
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  };
  /**
   * A process's command line (`sysctl kern.procargs2`: the argument count, the program, then the arguments, each
   * ended by a zero, then its environment). One buffer, made on first use and big enough for a long environment: into
   * one that is too small the kernel writes zeros and still says it worked (checked here), which reads as no
   * arguments at all -- a page process then simply isn't recognised as one.
   */
  let argsBuffer: Uint8Array | null = null;
  const argsOf = (pid: number): string | null => {
    if (!procs) return null;
    const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2
    const out = (argsBuffer ??= new Uint8Array(256 * 1024));
    const len = new BigUint64Array(1);
    len[0] = BigInt(out.byteLength);
    if (procs.sysctl(toPtr(mib), 3, toPtr(out), toPtr(len), null, 0n) !== 0) return null;
    const size = Math.min(Number(len[0]), out.byteLength);
    if (size < 8) return null;
    const count = new DataView(out.buffer).getInt32(0, true);
    const parts = text.decode(out.subarray(4, size)).split("\0").filter(Boolean);
    return parts.slice(1, 1 + Math.max(0, count)).join(" ");
  };
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
    footprint,
    processes(wantArgs) {
      if (!procs) return null;
      const pids = new Int32Array(16 * 1024);
      const n = procs.proc_listallpids(toPtr(pids), pids.byteLength);
      if (n <= 0) return null;
      // `struct proc_bsdshortinfo` (PROC_PIDT_SHORTBSDINFO, which answers for other users' processes too): the parent
      // at offset 4 and the 16-byte name at 16.
      const short = new Uint8Array(64);
      const view = new DataView(short.buffer);
      const path = new Uint8Array(4096);
      const rows: ProcessRow[] = [];
      for (let i = 0; i < Math.min(n, pids.length); i++) {
        const pid = pids[i];
        if (pid <= 0 || procs.proc_pidinfo(pid, 13, 0n, toPtr(short), 64) !== 64) continue;
        const len = procs.proc_pidpath(pid, toPtr(path), path.byteLength);
        const program = len > 0 ? text.decode(path.subarray(0, len)) : text.decode(short.subarray(16, 32)).replace(/\0[\s\S]*$/, "");
        rows.push({ pid, ppid: view.getUint32(4, true), path: program, bytes: footprint(pid), ...(wantArgs?.(program) ? { args: argsOf(pid) } : {}) });
      }
      return rows;
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
export function linuxReader(read: (path: string) => string = (p) => readFileSync(p, "utf8"), fs: ProcFs = REAL_PROC): MemoryReader {
  const r = procReader(read, fs);
  if (r.read() === null) return blindReader("Crosstalk can't read /proc on this machine, so it can't say how its memory is doing. Nothing is held back.");
  return r;
}

/** The two things about /proc a file read can't do (tests give their own): what is in it, and where a link points. */
export interface ProcFs {
  list: (dir: string) => string[];
  link: (path: string) => string;
}
const REAL_PROC: ProcFs = { list: (dir) => readdirSync(dir), link: (path) => readlinkSync(path) };

function procReader(read: (path: string) => string, fs: ProcFs): MemoryReader {
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
    // One small file per process (`stat`: its parent and its resident pages), and where its `exe` link points.
    processes(wantArgs) {
      let names: string[];
      try {
        names = fs.list("/proc");
      } catch {
        return null;
      }
      const rows: ProcessRow[] = [];
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        try {
          // "1234 (a name (with) brackets) S 1 ...": everything after the last bracket is fields 3 onwards.
          const stat = read(`/proc/${pid}/stat`);
          const open = stat.indexOf("(");
          const close = stat.lastIndexOf(")");
          const rest = stat.slice(close + 2).split(" ");
          const pages = Number(rest[21]);
          let program = stat.slice(open + 1, close);
          try {
            program = fs.link(`/proc/${pid}/exe`) || program;
          } catch {
            // Another user's process (or a kernel thread): its name is what there is.
          }
          let args: string | null | undefined;
          if (wantArgs?.(program)) {
            try {
              args = read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ");
            } catch {
              args = null;
            }
          }
          rows.push({ pid, ppid: Number(rest[1]) || 0, path: program, bytes: Number.isFinite(pages) && pages > 0 ? pages * (pageSize || 4096) : null, ...(args !== undefined ? { args } : {}) });
        } catch {
          // Gone between the listing and the read.
        }
      }
      return rows;
    },
  };
}

/** A hub on a machine neither of those reads. It says so and stands in the way of nothing. */
export const blindReader = (why: string): MemoryReader => ({ blind: why, read: () => null, footprint: () => null, ramBytes: () => totalmem(), pageBytes: () => null });

/** The reader for the machine this hub is on. */
export function readerFor(platform: NodeJS.Platform): MemoryReader {
  if (platform === "darwin") return macReader() ?? blindReader("Crosstalk can't read this Mac's memory, so it won't stand in the way of anything starting.");
  if (platform === "linux") return linuxReader();
  return blindReader(`Crosstalk only watches memory on macOS and Linux, so it can't say how this ${platform} machine is doing. Nothing is held back.`);
}

// ---- Who holds the memory ----

/** An agent process the hub runs, as the engine knows it (Engine.agentProcesses). */
export interface AgentProcess {
  memberId: string;
  roomId: string;
  /** The agent as its chat names it: "Claude Code", or "@claude" in a group chat. */
  agent: string;
  /** The chat's name. */
  chat: string;
  /** The processes the hub started for it; everything they started in turn is found from these. */
  pids: number[];
  /** One of its replies is running now. */
  replying: boolean;
  /** That reply has used a browser (one of its steps says so). */
  browsing: boolean;
}

/** A holder as the guard keeps it. The processes stay here and never go to a phone. */
interface Held extends MemoryHolder {
  pids: number[];
  /** The agent it belongs to: an agent's own processes, or the agent that is using the browser. */
  memberId?: string;
  /** The agents' browser's page processes, biggest first: the only processes Crosstalk ever asks to quit for memory. */
  pages?: { pid: number; bytes: number }[];
}

/** The agents' own browser (browseros.ts): every process inside its app on a Mac, or of its install on Linux. */
const AGENTS_BROWSER = /\/BrowserOS neo\.app\/|(^|\/)browseros-neo(\/|$)|BrowserOS_neo/i;
/** A browser an agent started for itself (Playwright's or Puppeteer's Chromium, a headless Chrome). Only ever looked for among an agent's own processes: the person's Chrome is theirs. */
const STARTED_BROWSER = /chrom(e|ium)|headless[_-]shell/i;
/** A browser's page process: a Mac names the helper so, and elsewhere its command line says it. */
const isPage = (r: ProcessRow) => r.path.includes("Helper (Renderer)") || /(^|\s)--type=renderer(\s|$)/.test(r.args ?? "");
/** The programs whose command line is read too: a browser's processes that their name alone doesn't tell apart. */
export const wantsArgs = (path: string) => (AGENTS_BROWSER.test(path) || STARTED_BROWSER.test(path)) && !path.includes("Helper (");

/** What the agents' browser is called wherever a person reads it. */
export const BROWSER_WHAT = "the agents' browser";

/**
 * What a program is called, from its path: the app it is part of ("Google Chrome" for every one of Chrome's
 * helpers, so they count as one thing), else its file's name. A program kept under its version number (Claude Code is
 * ~/.local/share/claude/versions/2.1.330) is named by the folder that says what it is.
 */
export function programName(path: string): string {
  const app = /\/([^/]+)\.app\//.exec(path);
  if (app) return app[1];
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) if (!/^(\d+(\.\d+)*|bin|versions?|current)$/i.test(parts[i])) return parts[i];
  return parts.at(-1) ?? path;
}

/**
 * Sorts one look at the process table into who holds the memory:
 *  - each agent's processes, everything they started included, under its chat's name;
 *  - the agents' browser: every process of BrowserOS neo, and any browser found among an agent's own processes;
 *  - the three biggest other programs, named only. Nothing here is ever touched.
 * `claimed`: processes already counted elsewhere (the image editor, model servers), left out with all they started.
 * `self`: the hub's own process, never named. Holders too small to matter (`MEMORY_SMALL`) are left out.
 */
export function groupProcesses(rows: ProcessRow[], o: { agents?: AgentProcess[]; claimed?: Iterable<number>; self?: number } = {}): Held[] {
  const agents = o.agents ?? [];
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  /** A process and everything it started that nobody has taken yet. */
  const taken = new Set<number>();
  const tree = (roots: number[]): ProcessRow[] => {
    const out: ProcessRow[] = [];
    const todo = [...roots];
    while (todo.length) {
      const pid = todo.pop() as number;
      if (taken.has(pid)) continue;
      taken.add(pid);
      const row = byPid.get(pid);
      if (row) out.push(row);
      todo.push(...(children.get(pid) ?? []));
    }
    return out;
  };
  const sum = (list: ProcessRow[]) => list.reduce((n, r) => n + (r.bytes ?? 0), 0);
  // What is counted elsewhere goes first, so an agent that started a model server doesn't count it twice.
  tree([...(o.claimed ?? [])]);
  if (o.self) taken.add(o.self);

  const out: Held[] = [];
  const browser: ProcessRow[] = [];
  /** Agents with a browser among their own processes: the surest sign of who is using one. */
  const started = new Map<string, number>();
  for (const a of agents) {
    const own = tree(a.pids);
    const theirs = own.filter((r) => STARTED_BROWSER.test(r.path) || AGENTS_BROWSER.test(r.path));
    browser.push(...theirs);
    if (theirs.length) started.set(a.memberId, sum(theirs));
    const rest = own.filter((r) => !theirs.includes(r));
    out.push({ what: `${a.agent} in ${a.chat}`, ours: true, section: null, kind: "agent", bytes: sum(rest) || null, roomId: a.roomId, chat: a.chat, memberId: a.memberId, pids: rest.map((r) => r.pid) });
  }
  for (const r of rows) {
    if (taken.has(r.pid) || !AGENTS_BROWSER.test(r.path)) continue;
    taken.add(r.pid);
    browser.push(r);
  }
  if (browser.length) {
    // Whose it is right now: the agent whose reply has used a browser. With several, the one that started one of its
    // own, else nobody is named: stopping the wrong chat's reply would be worse than naming none.
    const using = agents.filter((a) => a.replying && (a.browsing || started.has(a.memberId)));
    const by = using.length === 1 ? using[0] : using.filter((a) => started.has(a.memberId)).sort((a, b) => (started.get(b.memberId) ?? 0) - (started.get(a.memberId) ?? 0))[0];
    const pages = browser
      .filter((r) => isPage(r) && r.bytes !== null)
      .map((r) => ({ pid: r.pid, bytes: r.bytes as number }))
      .sort((a, b) => b.bytes - a.bytes);
    out.push({ what: BROWSER_WHAT, ours: true, section: null, kind: "browser", bytes: sum(browser) || null, pids: browser.map((r) => r.pid), pages, ...(by ? { roomId: by.roomId, chat: by.chat, memberId: by.memberId } : {}) });
  }
  // Everything else, one row per program.
  const others = new Map<string, Held>();
  for (const r of rows) {
    if (taken.has(r.pid) || r.bytes === null) continue;
    const what = programName(r.path);
    const h = others.get(what);
    if (h) {
      h.bytes = (h.bytes ?? 0) + r.bytes;
      h.pids.push(r.pid);
    } else others.set(what, { what, ours: false, section: null, kind: "other", bytes: r.bytes, pids: [r.pid] });
  }
  const size = (h: Held) => h.bytes ?? 0;
  const top = [...others.values()].sort((a, b) => size(b) - size(a)).slice(0, 3);
  return [...out, ...top].filter((h) => size(h) >= MEMORY_SMALL).sort((a, b) => size(b) - size(a));
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
  /**
   * Its processes when `bytes` already counts them (the image editor measures its own server): they are this holder,
   * so a look at the process table doesn't list them a second time under their program's name.
   */
  claims?: number[];
}

// A heavy thing as the guard measured it is a `Held` too. Its processes are how one process found two ways (by its
// own number, and as what listens at an address an account points at) becomes one row.

const plain = (h: Held): MemoryHolder => ({
  what: h.what,
  ours: h.ours,
  section: h.section,
  bytes: h.bytes,
  ...(h.kind ? { kind: h.kind } : {}),
  ...(h.roomId ? { roomId: h.roomId } : {}),
  ...(h.chat ? { chat: h.chat } : {}),
});

/** What tells one holder from another across looks, for seeing which one grows. */
const keyOf = (h: Held) => (h.kind === "agent" ? `agent:${h.memberId}` : h.kind === "browser" ? "browser" : `${h.kind ?? "heavy"}:${h.what}`);

/** What something about to start asks the guard about. */
export interface MemoryWant {
  what: string;
  /** What it will hold; null when that can't be worked out beforehand (Ollama). */
  needBytes: number | null;
  /**
   * Which memory it draws on. llama.cpp lives inside the GPU's (Metal's working set, or a card's VRAM); the image
   * editor is ComfyUI, which doesn't, and is measured against the machine's memory instead.
   */
  on?: MemoryPool;
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
  /**
   * Tell the phone: each time the machine gets worse, and what was done about it. `roomId`: the chat it is about.
   * `acted`: it says what Crosstalk stopped or closed, so it must not replace (or be replaced by) the notice before it.
   */
  notify?: (note: { title: string; body: string; roomId?: string; acted?: boolean }) => void;
  reader?: MemoryReader;
  sampleMs?: number;
  now?: () => number;
  /** "Free memory by itself" (Settings). Off, or left out: the guard only tells, as it always did. */
  acts?: () => boolean;
  /** The agent processes the hub runs now, so their memory is counted under their chats. */
  agents?: () => AgentProcess[];
  /** What the guard may do when "Free memory by itself" is on. Each is one call into the hub; none is called twice in one spell of trouble. */
  act?: MemoryActions;
  /** What the guard last saw is kept here across restarts (RUN_DIR/memory.json), so a hub that comes back after the machine froze knows. */
  readState?: () => string | null;
  writeState?: (text: string) => void;
  /** Waits between two page processes asked to quit (tests: no wait). */
  pause?: (ms: number) => Promise<void>;
}

/** What the guard does about a machine running out, as calls into the hub (app.ts wires them; tests watch them). */
export interface MemoryActions {
  /** Ends agent processes that have had nothing to do for `idleMs` (the engine's own idle rule, now). Returns how many. */
  endIdle(idleMs: number): number;
  /** New replies wait for memory (true), or go again (false). */
  hold(on: boolean): void;
  /** Puts a message into the agent's running reply, read at its next step. False: that agent can't take one, or no reply runs. */
  steer(memberId: string, text: string): Promise<boolean>;
  /** Stops the agent's running reply, which then says `error` and offers Try again. False: none was running. */
  stop(roomId: string, memberId: string, error: string): Promise<boolean>;
  /** Says a line in a chat. */
  say(roomId: string, text: string): void;
  /** Asks one of the agents' browser's page processes to quit (SIGTERM). Only ever called for those. */
  endPage(pid: number): void;
}

/** What `wentDown` says: the hub last stopped, without stopping on purpose, while the machine was out of memory. */
export interface MemoryDown {
  at: number;
  band: MemoryBand;
  /** The reply that was filling it then, when one was. */
  roomId: string | null;
  memberId: string | null;
}

/** How far the guard has gone in this spell of trouble. */
type Step = "none" | "tight" | "full";

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
  private sent = "";
  /** Who holds the memory, from the last look at the process table (empty while memory is fine: nothing is looked at). */
  private seen: Held[] = [];
  private agents: AgentProcess[] = [];
  /** What each holder held when it was first seen since the machine left "fine": what "growing" is measured from. */
  private first = new Map<string, number>();
  /** Swap in use at the last few looks, for telling that it keeps growing. */
  private swapUsed: { at: number; bytes: number }[] = [];
  /** How far this spell of trouble has gone, and when and where each step was taken. */
  private step: Step = "none";
  private tightAt = 0;
  private tightLevel = 0;
  private fullSince: number | null = null;
  private thrashSince: number | null = null;
  private calmSince: number | null = null;
  /** The worst band the phone has been told of in this spell: it hears of each one once. */
  private told: MemoryBand | null = null;
  /** New replies are waiting for memory; since when; and whether this spell's wait is used up. */
  private held = false;
  private heldAt = 0;
  private holdSpent = false;
  /** The reply that is filling the machine, as last seen in this spell (kept for `wentDown`). */
  private blamed: { roomId: string; memberId: string } | null = null;
  private kept = "";
  private down: MemoryDown | null = null;
  /** What the steps started and haven't finished, one after another (a stop never overtakes the message before it). */
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MemoryDeps) {
    this.reader = deps.reader ?? readerFor(process.platform);
    this.sampleMs = deps.sampleMs ?? SAMPLE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.band = this.reader.blind ? "unknown" : "fine";
    this.down = readDown(deps.readState);
    // Read once: left in the file, a hub killed later on a quiet machine would be taken for one that went down in trouble.
    if (this.down) this.keep(true);
  }

  /**
   * The hub last stopped without stopping on purpose (the machine froze or lost power, or the hub was killed) while
   * the machine was nearly or wholly out of memory: when, and which reply was filling it. Null after an ordinary
   * restart, which clears what was kept (`stop`). Asked once at start, before interrupted replies are picked up again.
   */
  wentDown(): MemoryDown | null {
    return this.down;
  }

  /** New replies wait for memory right now (Engine reads this before it starts one). */
  holding(): boolean {
    return this.held;
  }

  /**
   * "Free memory by itself" was switched in Settings: every device hears it, and replies that were waiting for memory
   * start if it was turned off.
   */
  settingChanged() {
    if (this.held && !this.acts()) {
      this.release("Free memory by itself was turned off");
      this.holdSpent = true;
    }
    this.publish();
  }

  /** Resolves once everything the last look started has finished (tests). */
  settled(): Promise<void> {
    return this.work;
  }

  /** Starts looking. The timer is unref'd, so it never keeps the hub alive by itself. */
  start() {
    if (this.timer || this.reader.blind) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.sampleMs);
    this.timer.unref?.();
  }

  /** The hub is stopping on purpose: what was kept is cleared, so the next start knows this wasn't the machine going down. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.keep(true);
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
    const was = this.band;
    this.band = band;
    if (r.swapUsedBytes !== null) {
      this.swapUsed.push({ at, bytes: r.swapUsedBytes });
      while (this.swapUsed.length > 1 && at - this.swapUsed[0].at > MEMORY_ACT.swapGrowingMs) this.swapUsed.shift();
    }
    // Who holds the memory is only looked at while the machine is below fine: a few milliseconds, no process spawned.
    if (band !== "fine") this.look();
    if (band !== was) this.logBand(was, band, r);
    // Fine again (said above with what was holding it a moment ago): nothing is looked at until it isn't.
    if (band === "fine") this.forget();
    this.publish();
    // The heavy things cost an `lsof` to count, so they are only counted when the machine is in trouble, and at most
    // once a minute. `gather` publishes again once it knows them.
    if ((band === "tight" || band === "full") && at - this.holdersAt >= HOLDERS_MS) void this.gather().catch(() => {});
    // Never from the very first look: one reading has no swap rate behind it, and a hub that restarts into a busy
    // machine shouldn't open with a notification, or stop anything, before it has seen the machine move.
    if (!first) this.steps(at, r, band);
  }

  // ---- Who holds it ----

  /** One look at the process table, sorted into holders (`groupProcesses`), and what each has gained since the first. */
  private look() {
    let rows: ProcessRow[] | null = null;
    try {
      rows = this.reader.processes?.(wantsArgs) ?? null;
      this.agents = rows ? this.deps.agents?.() ?? [] : [];
    } catch (e) {
      log.warn(`couldn't see who holds the memory: ${e instanceof Error ? e.message : e}`);
      rows = null;
    }
    this.seen = rows ? groupProcesses(rows, { agents: this.agents, claimed: this.holders.flatMap((h) => h.pids), self: process.pid }) : [];
    for (const h of this.all()) if (h.bytes !== null && !this.first.has(keyOf(h))) this.first.set(keyOf(h), h.bytes);
  }

  /** Memory is fine again: nothing is looked at, and what "growing" was measured from starts afresh next time. */
  private forget() {
    this.seen = [];
    this.agents = [];
    this.first.clear();
  }

  /** Everything known to hold memory, biggest first: who the process table shows, and the model servers and image editor. */
  private all(): Held[] {
    return [...this.seen, ...this.holders].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  }

  private grown(h: Held): number {
    return h.bytes === null ? 0 : h.bytes - (this.first.get(keyOf(h)) ?? h.bytes);
  }

  /**
   * The holder the trouble is put down to: the one that has grown most since the machine left "fine", as long as it
   * isn't dwarfed by something else (`leadShare`); when nothing is growing, simply the biggest.
   */
  private lead(): Held | null {
    const all = this.all().filter((h) => h.bytes !== null);
    if (!all.length) return null;
    const most = all[0].bytes as number;
    const growing = all.filter((h) => this.grown(h) >= MEMORY_ACT.growthBytes && (h.bytes as number) >= most * MEMORY_ACT.leadShare);
    return growing.sort((a, b) => this.grown(b) - this.grown(a))[0] ?? all[0];
  }

  /** Agents are what fills the machine: the lead is an agent's processes or the agents' browser, and big enough to matter. */
  private agentsLead(): Held | null {
    const lead = this.lead();
    return lead && (lead.kind === "agent" || lead.kind === "browser") && (lead.bytes ?? 0) >= MEMORY_ACT.actMinBytes ? lead : null;
  }

  /** The reply to speak to, and to stop if it comes to that: the agent behind the lead holder, while it is replying. */
  private culprit(): { agent: AgentProcess; holder: Held } | null {
    const holder = this.agentsLead();
    const agent = holder?.memberId ? this.agents.find((a) => a.memberId === holder.memberId) : null;
    return holder && agent?.replying ? { agent, holder } : null;
  }

  private logBand(was: MemoryBand, band: MemoryBand, r: Reading) {
    const top = this.all().slice(0, 3).map(holderText);
    const swap = r.swapUsedBytes ? `, ${bytesText(r.swapUsedBytes)} in swap` : "";
    log.info(`${this.deps.machineName()}'s memory went from ${was} to ${band} (level ${r.level}${swap}). ${top.length ? `Holding most: ${top.join(", ")}` : "Nothing big is known to hold it"}`);
  }

  // ---- What it does about it ----

  private acts(): boolean {
    return this.deps.acts?.() === true;
  }

  /** Getting full with swap still growing fast: tight in all but the level, which only holds because memory is going to the disk. */
  private early(r: Reading, band: MemoryBand): boolean {
    if (band !== "busy" || r.level >= MEMORY_BANDS.busy || this.swapUsed.length < 2) return false;
    if (r.freeBytes !== null && r.freeBytes >= MEMORY_ACT.earlyFloorBytes) return false;
    return this.swapUsed[this.swapUsed.length - 1].bytes - this.swapUsed[0].bytes >= MEMORY_ACT.swapGrowingBytes;
  }

  /**
   * Where this look leaves the two steps. Trouble starts the tight step, once; the full step follows only from there,
   * once; and neither can happen again until the machine has been out of trouble for `calmMs`. With "Free memory by
   * itself" off the steps are still walked, so the phone is told the same things at the same moments: nothing is done.
   */
  private steps(at: number, r: Reading, band: MemoryBand) {
    const trouble = band === "tight" || band === "full" || this.early(r, band);
    if (!trouble) {
      this.fullSince = this.thrashSince = null;
      if (this.step === "none") return;
      this.calmSince ??= at;
      if (at - this.calmSince >= MEMORY_ACT.calmMs) this.calm();
      else this.holdCheck(at);
      return;
    }
    this.calmSince = null;
    this.fullSince = band === "full" ? this.fullSince ?? at : null;
    const thrashing = this.rate !== null && this.rate >= thrashPagesPerSec(this.reader.pageBytes());
    this.thrashSince = thrashing ? this.thrashSince ?? at : null;
    const c = this.culprit();
    if (c) this.blamed = { roomId: c.agent.roomId, memberId: c.agent.memberId };
    if (this.step === "none") this.tight(at, r, band, c);
    else {
      // Every band worse than the last one told is news (the full band, after a tight step taken in the tight one),
      // and it is told before anything the full step does about it.
      if (this.told !== null && BANDS.indexOf(band) > BANDS.indexOf(this.told)) {
        this.told = band;
        this.later(() => this.tell(null, false));
      }
      const why = this.step === "tight" ? this.fullWhy(at, r) : null;
      if (why) this.full(why, c);
    }
    this.holdCheck(at);
    this.keep();
  }

  /** The tight step: make room without stopping anyone's work, and say who is filling the machine. */
  private tight(at: number, r: Reading, band: MemoryBand, c: { agent: AgentProcess; holder: Held } | null) {
    this.step = "tight";
    this.tightAt = at;
    this.tightLevel = r.level;
    this.told = band;
    const acts = this.acts() && !!this.deps.act;
    let ended = 0;
    if (acts) {
      try {
        ended = this.deps.act!.endIdle(MEMORY_ACT.idleMs);
      } catch (e) {
        log.warn(`couldn't end idle agent processes: ${e instanceof Error ? e.message : e}`);
      }
    }
    log.info(`tight step at level ${r.level}: ${acts ? `ended ${ended} idle agent process(es)` : "only telling (Free memory by itself is off)"}${c ? `; ${c.holder.what} is filling it, for ${c.agent.agent} in ${c.agent.chat}` : ""}`);
    this.later(() => this.tell(c, acts));
  }

  /** Why the full step is due now, in words for the log; null while it isn't. */
  private fullWhy(at: number, r: Reading): string | null {
    if (this.fullSince !== null && at - this.fullSince >= MEMORY_ACT.fullMs) return `the level has been under ${MEMORY_BANDS.full} for ${Math.round((at - this.fullSince) / 1000)} s`;
    if (this.thrashSince !== null && at - this.thrashSince >= MEMORY_ACT.thrashMs) return `it has been swapping heavily for ${Math.round((at - this.thrashSince) / 1000)} s`;
    if (at - this.tightAt >= MEMORY_ACT.fallingMs && r.level <= this.tightLevel - MEMORY_ACT.fallingPoints) return `the level kept falling after the tight step (${this.tightLevel} to ${r.level})`;
    return null;
  }

  /** The full step: stop the reply that is filling the machine, and get memory back from the agents' browser. */
  private full(why: string, c: { agent: AgentProcess; holder: Held } | null) {
    this.step = "full";
    const acts = this.acts() && !!this.deps.act;
    log.info(`full step, because ${why}: ${!acts ? "only telling (Free memory by itself is off)" : c ? `stopping ${c.agent.agent} in ${c.agent.chat} (${holderText(c.holder)})` : "no reply is behind it, so none is stopped"}`);
    if (acts) this.later(() => this.free(c));
  }

  /** New replies wait while agents are what fills the machine: from the tight step, for `holdMaxMs` at most, once a spell. */
  private holdCheck(at: number) {
    if (this.holdSpent) return;
    const acts = this.acts() && !!this.deps.act;
    if (!this.held) {
      if (!acts || this.step === "none" || !this.agentsLead()) return;
      this.held = true;
      this.heldAt = at;
      log.info("new replies wait for memory");
      this.deps.act!.hold(true);
      return;
    }
    if (acts && at - this.heldAt < MEMORY_ACT.holdMaxMs) return;
    this.release(acts ? `they have waited ${Math.round(MEMORY_ACT.holdMaxMs / 60_000)} minutes` : "Free memory by itself was turned off");
    this.holdSpent = true;
  }

  private release(why: string) {
    if (!this.held) return;
    this.held = false;
    log.info(`replies that waited for memory start now: ${why}`);
    try {
      this.deps.act?.hold(false);
    } catch (e) {
      log.warn(`couldn't start the replies that waited for memory: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The machine has been out of trouble long enough: the spell is over, and both steps can happen again. */
  private calm() {
    log.info(`${this.deps.machineName()} has had memory to spare for ${Math.round(MEMORY_ACT.calmMs / 1000)} s: the trouble is over`);
    this.release("there is room again");
    this.step = "none";
    this.told = null;
    this.calmSince = this.fullSince = this.thrashSince = null;
    this.holdSpent = false;
    this.blamed = null;
    this.keep();
  }

  /** Runs after whatever the steps started before it, and never throws into a look. */
  private later(job: () => Promise<void>) {
    this.work = this.work.then(job).catch((e) => log.warn(`memory step failed: ${e instanceof Error ? e.message : e}`));
  }

  private culpritOf(c: { agent: AgentProcess; holder: Held }): MemoryCulprit {
    return { agent: c.agent.agent, chat: c.agent.chat, holder: { what: c.holder.what, bytes: c.holder.bytes, kind: c.holder.kind } };
  }

  /**
   * Tells the phone what the machine is doing and who holds it. With a reply behind it (`c`) and "Free memory by
   * itself" on, that reply's agent is told first, in the middle of its reply, and its chat says so.
   */
  private async tell(c: { agent: AgentProcess; holder: Held } | null, acts: boolean) {
    await this.gather().catch(() => {});
    const s = this.status();
    const machine = this.deps.machineName();
    if (!c) {
      this.deps.notify?.(memoryNotice(s, machine));
      return;
    }
    const who = this.culpritOf(c);
    let did: "asked" | "watching" | "told" = "told";
    if (acts) {
      // Not every agent can take a message in the middle of a reply: where it can't, the reply is only watched.
      const asked = await this.deps.act!.steer(c.agent.memberId, memorySteer(who)).catch(() => false);
      did = asked ? "asked" : "watching";
      log.info(asked ? `told ${c.agent.agent} in ${c.agent.chat} that it is filling the machine` : `${c.agent.agent} in ${c.agent.chat} can't be told in the middle of its reply`);
      this.deps.act!.say(c.agent.roomId, memoryAskedLine(machine, who, asked));
    }
    this.deps.notify?.({ ...memoryCulpritNotice(s, machine, who, did), roomId: c.agent.roomId });
  }

  /** The full step's work: the reply first, then the agents' browser's pages if it is still big. */
  private async free(c: { agent: AgentProcess; holder: Held } | null) {
    const machine = this.deps.machineName();
    const act = this.deps.act!;
    const who = c ? this.culpritOf(c) : null;
    let stopped = false;
    if (c && who) {
      stopped = await act.stop(c.agent.roomId, c.agent.memberId, memoryStopError(machine)).catch(() => false);
      if (stopped) act.say(c.agent.roomId, memoryStoppedLine(machine, who));
    }
    const closed = await this.closePages();
    const pages = closed === 1 ? "1 page" : `${closed} pages`;
    if (stopped && c && who) this.deps.notify?.({ title: `${machine} was about to freeze`, body: `${memoryStoppedLine(machine, who)}${closed ? ` It also closed ${pages} in ${BROWSER_WHAT}.` : ""}`, roomId: c.agent.roomId, acted: true });
    else if (closed) this.deps.notify?.({ title: `${machine} was about to freeze`, body: `Crosstalk closed ${pages} in ${BROWSER_WHAT} to free memory. They load again when they're opened.`, acted: true });
  }

  /**
   * While the agents' browser holds more than `browserMaxBytes`, its page processes are asked to quit, biggest first,
   * until the machine is out of the tight band (or the browser is back under that size: by then it isn't what fills
   * the machine). The process table is read again before each one, so a number is never used after its process went. The browser itself, its GPU and network processes, and anything that isn't the
   * agents' browser are never asked. Returns how many were.
   */
  private async closePages(): Promise<number> {
    const asked = new Set<number>();
    const pause = this.deps.pause ?? ((ms: number) => Bun.sleep(ms));
    while (asked.size < MEMORY_ACT.renderersMax) {
      this.look();
      const browser = this.seen.find((h) => h.kind === "browser");
      if ((browser?.bytes ?? 0) <= MEMORY_ACT.browserMaxBytes) break;
      const r = this.reader.read();
      if (r) {
        const band = memoryBandOf(r.level, this.rate, { pageBytes: this.reader.pageBytes(), freeBytes: r.freeBytes });
        if (band !== "tight" && band !== "full") break;
      }
      const next = browser?.pages?.find((p) => !asked.has(p.pid));
      // Never the hub itself or a system process, whatever a process table says.
      if (!next || next.pid <= 1 || next.pid === process.pid) break;
      asked.add(next.pid);
      try {
        this.deps.act!.endPage(next.pid);
      } catch (e) {
        log.warn(`couldn't close one of the browser's pages: ${e instanceof Error ? e.message : e}`);
      }
      await pause(MEMORY_ACT.rendererPauseMs);
    }
    if (asked.size) log.info(`asked ${asked.size} of the agents' browser's page processes to quit`);
    return asked.size;
  }

  /**
   * Keeps what a hub that comes back needs to know: the band, how far the steps had gone, and the reply that was
   * filling the machine. Written only when one of those changes, and cleared when the trouble is over or the hub stops
   * on purpose.
   */
  private keep(clear = false) {
    if (!this.deps.writeState) return;
    const inTrouble = !clear && this.step !== "none";
    const said = JSON.stringify(inTrouble ? { band: this.band, step: this.step, roomId: this.blamed?.roomId ?? null, memberId: this.blamed?.memberId ?? null } : { band: "fine", step: "none" });
    if (said === this.kept) return;
    this.kept = said;
    try {
      this.deps.writeState(JSON.stringify({ ...JSON.parse(said), at: this.now() }));
    } catch (e) {
      log.warn(`couldn't keep how the memory is doing: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** What the phone and Settings see. Cheap and synchronous: the last look, never a new one. */
  status(): MachineMemory {
    // Only the model servers and the image editor: what the next model has to fit beside (MachineMemory.takenBytes).
    const measured = this.holders.filter((h) => h.bytes !== null);
    return {
      band: this.reader.blind ? "unknown" : this.band,
      level: this.last?.level ?? null,
      blind: this.reader.blind,
      ramBytes: this.reader.ramBytes(),
      takenBytes: measured.length ? measured.reduce((n, h) => n + (h.bytes ?? 0), 0) : null,
      swapPagesPerSec: this.rate,
      swapUsedBytes: this.last?.swapUsedBytes ?? null,
      holders: this.all().map(plain),
      at: this.lastAt,
      ...(this.deps.acts ? { acts: this.deps.acts() === true } : {}),
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
    const holders = held.map(plain);
    const taken = held.reduce((n, h) => n + (h.bytes ?? 0), 0);
    const freeBytes = this.room(machine, taken, want.on ?? "gpu");
    const band = this.band;
    const thrashing = this.rate !== null && this.rate >= thrashPagesPerSec(this.reader.pageBytes());
    const tooBig = want.needBytes !== null && want.needBytes > freeBytes;
    // The band itself only reaches tight or full when the machine really has little left (`MEMORY_FLOOR`), so this
    // no longer refuses a 4 GB model on a 64 GB hub with 20 GB free just because 20 of 64 is 31%.
    if (band !== "tight" && band !== "full" && !thrashing && !tooBig) return { ok: true, text: "", freeBytes, holders, band };
    const name = this.deps.machineName();
    const text = memoryRefusal({ what: want.what, needBytes: want.needBytes, freeBytes, machine: name, holders, why: tooBig ? "space" : "pressure" });
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
        // Their processes are known now: a look that listed one under its program's name leaves it out from here on.
        if (this.seen.length) this.look();
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
        const pids = [...(p.pid ? [p.pid] : []), ...(p.claims ?? [])];
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
    // One process is one holder, whichever way it was found: a server the hub started that is also the address an
    // account points at would otherwise count twice, a 10 GB model read as 20 GB taken on a 16 GB machine, which
    // refuses every start after it and names a holder that doesn't exist.
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

  /** Sends the state on only when it says something new: no event per look. */
  private publish() {
    const s = this.status();
    const key = JSON.stringify([s.band, s.blind, s.acts, s.holders.map((h) => [h.what, h.bytes === null ? null : Math.round((h.bytes / 1024 ** 3) * 10)])]);
    if (key === this.sent) return;
    this.sent = key;
    this.deps.emit?.(s);
  }
}


/** What the last run kept, when it shows the hub went down in trouble (`MemoryGuard.wentDown`); null otherwise. */
function readDown(read: (() => string | null) | undefined): MemoryDown | null {
  try {
    const k = JSON.parse(read?.() ?? "null") as { at?: unknown; band?: unknown; step?: unknown; roomId?: unknown; memberId?: unknown } | null;
    if (!k || typeof k.at !== "number" || (k.step !== "tight" && k.step !== "full")) return null;
    const band = k.band === "full" || k.band === "tight" || k.band === "busy" ? k.band : "tight";
    return { at: k.at, band, roomId: typeof k.roomId === "string" ? k.roomId : null, memberId: typeof k.memberId === "string" ? k.memberId : null };
  } catch {
    return null;
  }
}
