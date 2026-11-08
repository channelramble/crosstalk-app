// Every process a hub test starts, and the check that none is left running. hub/test/preload.ts installs both before any
// test file loads.
//
// A process started in a process group of its own (`detached`, as the image editor's start.sh and Local models' servers
// are, so they outlive the hub) is not ended when its test ends, nor when `bun test` exits: without this, every
// run would leave one more `bun ComfyUI/main.py --port <n>` running under launchd, from editor-source.test.ts's temp
// installs. `bun test` leaves even a plain child running when it exits.
//
// So every process started through Bun.spawn -- node:child_process's spawn is Bun.spawn underneath, which
// standins.test.ts checks -- is noted here, whoever started it (a test, or the hub code it runs), and:
//  - a test file that starts stand-ins calls `endStarted()` in its afterEach, which runs whether the test passed, failed
//    or timed out: everything the test started ends, each process group whole;
//  - after each test (the preload's afterEach, which runs after the file's own), a process group the test started that
//    still has anything running fails that test, and is ended;
//  - after the run (the preload's afterAll), anything the run started that still runs fails the run, and is ended.
// The stand-in servers in fixtures/ also end by themselves once whoever started them has gone, for a run that was killed
// before any of this could happen. Tests run one at a time (no `test.concurrent`), which is what lets a process belong
// to the test that was running when it started.
//
// Except when a test's own code goes on after its test ended: a test that timed out runs on in the background while the
// next ones run (bun can't stop it), and what it starts then would be laid at the door of whichever test is running.
// bun:test can't say which test's code is running (an AsyncLocalStorage store entered in a beforeEach doesn't reach the
// test's body, measured with bun 1.4.2, and bun:test can't be wrapped), so the line that started it says: when that line
// is in another test file than the one running, or in a test of this file that ran before this one (tests run in the
// order they're written, which `testsOf` checks it can count on), it was that test's code. It's ended when the running
// test ends, which isn't failed for it, and the run fails at its end naming the test whose code it was.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Subprocess } from "bun";

export type Started = {
  pid: number;
  /** In a process group of its own, which it leads: it and whatever it starts outlive the run unless they're ended. */
  group: boolean;
  /** The test it was started in (numbered from 1), or null: while a file loaded, or in a beforeAll or afterAll. */
  test: number | null;
  command: string;
  cwd: string;
  /** The line that started it: in a test file, else in the hub's own code. */
  from: string;
  /** Every line on the way to it, innermost first ("<path>:<line>"). */
  stack: string[];
  /** The test file running when it started (bun's `Bun.main` in a test). */
  file: string | null;
  /** Its own exit was seen (others in its group may still run). */
  exited: boolean;
};

/** How long what a test started gets to end by itself (a server the hub is stopping, say) before it counts as left. */
const GRACE_MS = 1500;
const ROOT = join(import.meta.dir, "..", "..");

const started = new Set<Started>();
let tests = 0;
let current: number | null = null;
/** The test file running, and how many of its tests have begun (the running one's place in it, from 1). */
let currentFile: string | null = null;
let inFile = 0;
let noting = false;
/** Processes a test's code started after its test had ended: ended at once, and reported when the run ends. */
const late: { started: Started; test: TestAt; command: string }[] = [];

function stackNow(): string[] {
  return (new Error().stack ?? "")
    .split("\n")
    .map((l) => /(\/[^\s()]+):(\d+):\d+\)?\s*$/.exec(l.trim()))
    .flatMap((m) => (m && m[1] !== import.meta.path ? [`${m[1]}:${m[2]}`] : []));
}

/** A path as the messages give it: from the repo's root when it's in the repo. */
const shown = (path: string) => (path.startsWith(ROOT) ? relative(ROOT, path) : path);

function startedFrom(frames: string[]): string {
  // A test file's line when the stack has one (hub code a test runs often starts things after an await, without it).
  const at = frames.find((f) => /\.test\.[jt]sx?:\d+$/.test(f)) ?? frames.find((f) => f.startsWith(ROOT)) ?? frames[0];
  return at ? shown(at) : "";
}

/** A test as its file has it: its place among the file's tests (from 1), its name, and the line it starts on. */
export type TestAt = { file: string; place: number; name: string; line: number };
type Tests = { tests: TestAt[]; ends: number[]; inOrder: boolean };
const parsed = new Map<string, Tests | null>();
/** A line that starts a test: `test(` or `it(`, its name on that line or the next. */
const START = /^(\s*)(?:test|it)\s*\(/;
const NAME = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const count = (text: string, c: string) => text.split(c).length - 1;

/**
 * The tests a test file writes, in order, each with the lines its body takes: from its `test(` to the line that closes
 * it, at the same indentation (`});`, `}, 30_000);`, or `);` for a call written over several lines), or that line alone
 * when it closes there. `inOrder`: they run one each, in the order written, so the n-th to begin is the n-th here (no
 * skip, only, todo, each, if, concurrent, or names made in a loop).
 */
export function testsOf(file: string): Tests | null {
  if (parsed.has(file)) return parsed.get(file)!;
  let text: string | null;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  let out: Tests | null = null;
  if (text !== null) {
    const lines = text.split("\n");
    const tests: TestAt[] = [];
    const ends: number[] = [];
    lines.forEach((l, i) => {
      const m = START.exec(l);
      if (!m) return;
      const rest = l.slice(m[0].length);
      const named = NAME.exec(rest) ?? NAME.exec(lines.slice(i + 1).find((x) => x.trim()) ?? "");
      tests.push({ file, place: tests.length + 1, name: named?.[2] ?? "", line: i + 1 });
      // Closed on its own line (a one-line test), else at the first line back at its indentation that closes something.
      const closes = (x: string) => x.length - x.trimStart().length === m[1].length && /^[})]/.test(x.trim());
      const shut = l.trimEnd().endsWith(");") && count(l, "(") === count(l, ")") ? i : lines.findIndex((x, k) => k > i && closes(x));
      ends.push((shut < 0 ? lines.length - 1 : shut) + 1);
    });
    // One that runs into the next means what was read isn't the file's tests as they run (a test file written out in
    // a string, say): then nothing here is taken as their order.
    const overlap = tests.some((t, i) => i + 1 < tests.length && ends[i] >= tests[i + 1].line);
    const inOrder = !overlap && !/\b(?:test|it|describe)\.(?:skip|only|todo|each|if|skipIf|todoIf|failing|concurrent|serial)\b|\bx(?:it|test|describe)\b/.test(text) && !tests.some((t) => t.name.includes("${"));
    out = { tests, ends, inOrder };
  }
  parsed.set(file, out);
  return out;
}

/** The test whose body holds a line of `stack` (the innermost such line): whose code started it. */
export function testOf(stack: string[]): TestAt | null {
  for (const frame of stack) {
    const m = /^(.*\.test\.[jt]sx?):(\d+)$/.exec(frame);
    if (!m) continue;
    const found = testsOf(m[1]);
    const line = Number(m[2]);
    const i = found?.tests.findIndex((t, k) => t.line <= line && line <= found.ends[k]) ?? -1;
    if (found && i >= 0) return found.tests[i];
  }
  return null;
}

/**
 * Whether the code that started it was a test that had already ended (one that timed out goes on in the background):
 * its line is in another test file than the one running, or in a test of this file that began before the running one.
 */
function startedLate(s: Started): TestAt | null {
  const by = testOf(s.stack);
  if (!by || !s.file) return null;
  if (by.file !== s.file) return by;
  const here = testsOf(s.file);
  return here?.inOrder && by.place < inFile ? by : null;
}

function note(proc: Subprocess, args: unknown[]) {
  type Options = { cmd?: string[]; cwd?: string; detached?: boolean };
  const first = args[0] as string[] | Options;
  const options = (Array.isArray(first) ? args[1] : first) as Options | undefined;
  const command = ((Array.isArray(first) ? first : options?.cmd) ?? []).join(" ");
  const stack = stackNow();
  const s: Started = {
    pid: proc.pid,
    group: options?.detached === true,
    test: current,
    command: command.length > 160 ? `${command.slice(0, 160)}…` : command,
    cwd: options?.cwd ?? process.cwd(),
    from: startedFrom(stack),
    stack,
    file: current === null ? null : currentFile,
    exited: false,
  };
  started.add(s);
  const exited = () => {
    s.exited = true;
  };
  proc.exited.then(exited, exited);
}

/** Notes every process started through Bun.spawn from now on. */
export function noteSpawns() {
  if (noting) return;
  noting = true;
  const real = Bun.spawn as unknown as (...args: unknown[]) => Subprocess;
  (Bun as unknown as { spawn: unknown }).spawn = function spawn(this: unknown, ...args: unknown[]) {
    const proc = real.apply(this ?? Bun, args);
    note(proc, args);
    return proc;
  };
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** It, or anything in its process group, still runs. */
export const running = (s: Started) => !s.exited || (s.group && groupAlive(s.pid));

function signal(target: number) {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Ended meanwhile.
  }
}

/** SIGKILL to its process group, and to it while it runs: never to a number that has stopped being it. */
function end(s: Started) {
  if (s.group) signal(-s.pid);
  if (!s.exited) signal(s.pid);
}

async function settle(list: Started[], ms: number) {
  const until = Date.now() + ms;
  while (list.some(running) && Date.now() < until) await Bun.sleep(20);
}

/** Forgets what has ended, group and all. */
function tidy() {
  for (const s of started) if (!running(s)) started.delete(s);
}

/** What has been noted and still runs. */
export const noted = () => [...started].filter(running);

/** The test that runs now, or null between tests. */
export const currentTest = () => current;

/**
 * Ends everything the running test started -- each process group whole -- and waits until it's gone. A test file that
 * starts stand-ins, or runs hub code that does, calls it from its afterEach, which runs whether the test passed, failed
 * or timed out.
 */
export async function endStarted(): Promise<void> {
  if (!noting) throw new Error("Nothing notes the processes tests start: run hub tests with hub/test/preload.ts (bunfig.toml at the repo root or in hub/).");
  if (current === null) return;
  const mine = [...started].filter((s) => s.test === current && running(s));
  mine.forEach(end);
  await settle(mine, 5000);
  tidy();
}

type Row = { pid: number; ppid: number; pgid: number; zombie: boolean; command: string };

/**
 * Every process on this machine, as `ps` lists them (none where it can't be run): asked only once something was left,
 * and once at the end of a run.
 */
function processes(): Row[] {
  let ps: ReturnType<typeof Bun.spawnSync>;
  try {
    ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,command="], { stdout: "pipe", stderr: "ignore" });
  } catch {
    return [];
  }
  return (ps.stdout?.toString() ?? "")
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .flatMap((m) => (m && Number(m[1]) !== ps.pid ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), zombie: m[4].includes("Z"), command: m[5] }] : []));
}

/** One line per process left: what started, where and from which line, and what of it runs now. */
function named(left: Started[], rows: Row[]): string {
  return left
    .map((s) => {
      const now = rows.filter((r) => !r.zombie && (r.pid === s.pid || (s.group && r.pgid === s.pid))).map((r) => `\`${r.command}\``);
      const where = `\`${s.command}\` in ${s.cwd}${s.from ? `, started at ${s.from}` : ""}`;
      return `\n  pid ${s.pid}${s.group ? " (its own process group)" : ""}: ${where}${now.length ? `; running: ${now.join(", ")}` : ""}`;
    })
    .join("");
}

/** The preload's beforeEach: what is started from here until its afterEach is this test's. */
export function testBegins() {
  current = ++tests;
  const file = (Bun as { main?: string }).main ?? null;
  if (file !== currentFile) {
    currentFile = file;
    inFile = 0;
  }
  inFile++;
}

/** The preload's afterEach (after the file's own): a process group the test started must not still be running. */
export async function testEnds(): Promise<void> {
  const test = current;
  current = null;
  if (test === null) return;
  const groups = [...started].filter((s) => s.test === test && s.group);
  await settle(groups, GRACE_MS);
  const still = groups.filter(running);
  if (!still.length) return tidy();
  const rows = processes();
  // Started by a test that had already ended: not this test's doing. Ended now; the run says whose it was.
  const left = still.filter((s) => {
    const by = startedLate(s);
    if (by) late.push({ started: s, test: by, command: named([s], rows) });
    return !by;
  });
  still.forEach(end);
  await settle(still, 2000);
  tidy();
  if (!left.length) return;
  throw new Error(
    `This test left ${left.length === 1 ? "a process group" : `${left.length} process groups`} running, and \`bun test\` never ends one (ended now):${named(left, rows)}` +
      "\nEnd everything a test starts in its afterEach: `await endStarted()` (hub/test/standins.ts) ends all of it, process groups whole.",
  );
}

/** The preload's afterAll: nothing the run started may still be running when `bun test` exits, which leaves it so. */
export async function runEnds(): Promise<void> {
  current = null;
  const lateOnes = late.splice(0);
  const all = [...started];
  await settle(all, GRACE_MS);
  const left = all.filter(running);
  const rows = processes();
  // Children that never went through Bun.spawn, so nothing above saw them start.
  const ours = rows.find((r) => r.pid === process.pid)?.pgid;
  const known = new Set(all.map((s) => s.pid));
  const strays = rows.filter((r) => r.ppid === process.pid && !r.zombie && !known.has(r.pid));
  left.forEach(end);
  for (const r of strays) {
    if (r.pgid === r.pid && r.pgid !== ours) signal(-r.pid);
    signal(r.pid);
  }
  await settle(left, 2000);
  tidy();
  const lateWords = lateOnes.map((l) => `\n  the test "${l.test.name}" (${shown(l.test.file)}:${l.test.line}), after it had ended (one that timed out goes on running):${l.command}`).join("");
  const lateTail = lateOnes.length
    ? `\n${lateOnes.length === 1 ? "A test's code" : "Tests' code"} started ${lateOnes.length === 1 ? "a process group" : "process groups"} after ${lateOnes.length === 1 ? "its test" : "their tests"} ended, while another ran (ended then, and not blamed on that one):${lateWords}`
    : "";
  if (!left.length && !strays.length) {
    if (lateTail) throw new Error(lateTail.slice(1));
    return;
  }
  const count = left.length + strays.length;
  throw new Error(
    `The run left ${count === 1 ? "a process" : `${count} processes`} running, which \`bun test\` doesn't end (ended now):${named(left, rows)}` +
      strays.map((r) => `\n  pid ${r.pid}: \`${r.command}\`, never seen starting`).join("") +
      "\nEnd everything a test starts in its afterEach (`await endStarted()` from hub/test/standins.ts), and what a file starts in its afterAll." +
      lateTail,
  );
}
