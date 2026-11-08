// Settings → Local models, starting and stopping model servers on this machine: Ollama (`ollama serve`, the Ollama
// app's own program too) and llama.cpp's llama-server with a model from the downloads folder, on 127.0.0.1 at a port
// the person picks. Like the image editor (imageEditor.ts), each runs on its own: its own process group, so on a Mac it
// outlives hub restarts (under systemd it ends with the hub, in the same control group, and the restarted hub forgets
// it). Its number is noted in run/local-servers.json and it runs from a folder of its own (run/local-servers/<id>), so
// a restarted hub can prove it's Crosstalk's: the noted process, still alive, still running from that folder. Only
// those are ever stopped. A server started any other way (the Ollama app, LM Studio, a terminal) is left alone, and
// the page says how to stop it there.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { LocalMachine, LocalModelFile, LocalProgram, LocalServer, LocalServerStart, LocalStarted } from "@crosstalk/shared";
import type { App } from "./app";
import { RUN_DIR } from "./config";
import { HttpError } from "./engine/engine";
import { cwdOf, lastProblem } from "./imageEditor";
import { localLibraryOf } from "./localLibrary";
import { explainExit, findInstall, installedBuilds, type LlamaInstall } from "./pool/llama";
import { aliasFor, POOL_PORT } from "./pool/pool";
import { logger } from "./util/log";

const log = logger("local-models");

type Kind = LocalStarted["kind"];

/** Each program's own port: Ollama's, and llama-server's. */
export const DEFAULT_PORTS: Record<Kind, number> = { ollama: 11434, llamacpp: 8080 };
/** Tokens of context llama-server is given unless another is picked: Claude Code needs about 20k just to start. */
export const DEFAULT_CONTEXT = 32768;
const MIN_CONTEXT = 2048;
const MAX_CONTEXT = 1_048_576;
const NAMES: Record<Kind, string> = { ollama: "Ollama", llamacpp: "llama.cpp" };

const TIMING = {
  /** How long a start may take to answer: llama.cpp reads the whole model first (a big one from a slow drive takes minutes). */
  startMs: { ollama: 60_000, llamacpp: 10 * 60_000 } as Record<Kind, number>,
  /** Between looks while it starts. */
  stepMs: 500,
  /** How often a running one is looked at (still there?). */
  watchMs: 15_000,
  /** How long it may take to end before it's made to. */
  stopMs: 15_000,
};

/** Where each program is usually installed, besides the PATH (the hub's PATH under launchd is short). */
const PLACES: Record<Kind, string[]> = {
  ollama: ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama", join(homedir(), "Applications", "Ollama.app", "Contents", "Resources", "ollama")],
  llamacpp: ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server", "/usr/bin/llama-server", join(homedir(), ".local", "bin", "llama-server")],
};
const BIN: Record<Kind, string> = { ollama: "ollama", llamacpp: "llama-server" };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const shown = (path: string) => {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};

/** Where a program came from, in plain words. */
function fromOf(path: string): string {
  const r = real(path);
  if (/\/Ollama\.app\//.test(path) || /\/Ollama\.app\//.test(r)) return "the Ollama app";
  if (r.includes("/Cellar/") || path.startsWith("/opt/homebrew/") || r.startsWith("/opt/homebrew/")) return "Homebrew";
  return shown(dirname(path));
}

/** One run's note in run/local-servers.json. */
interface Noted {
  id: string;
  kind: Kind;
  port: number;
  pid: number;
  bin: string;
  dir: string;
  model: string | null;
  modelPath: string | null;
  context: number | null;
  startedAt: number;
}

interface Run extends Noted {
  state: LocalStarted["state"];
  detail: string | null;
  /** This hub run's handle on it (none for one an earlier run started). */
  child: ChildProcess | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopping: Promise<void> | null;
}

export interface RunnersDeps {
  /** Each server's own folder goes in here (its working folder, and its log). */
  runDir: string;
  /** Where the servers are noted, so a restarted hub can still tell they're its own (none: not kept). */
  stateFile?: string;
  /** The hub's own port: never offered or taken. */
  hubPort: () => number;
  /** A finished model in the downloads folder, by its id, with where its first file is (throws, in plain words, when it isn't there). */
  model: (id: unknown) => { file: LocalModelFile; path: string };
  /** This machine's memory and GPUs, for where llama.cpp puts a model's layers (none: llama.cpp decides). */
  machine?: () => Promise<LocalMachine>;
  /** An Ollama pull is stopped or running: an Ollama started now mustn't clear its part. */
  pullsWaiting?: () => boolean;
  /**
   * Asked before a server is started, with what it needs in memory (null for Ollama, which loads a model only when a
   * chat asks for one): the memory guard (memory.ts) throws, in plain words with the way out, when it won't fit
   * beside what already runs. Not set: nothing is checked.
   */
  beforeStart?: (o: { what: string; needBytes: number | null; force: boolean }) => Promise<void>;
}

export class LocalRunners {
  readonly t = { ...TIMING, startMs: { ...TIMING.startMs } };
  /** The programs on this machine (tests give their own; in-memory hubs look nowhere unless CROSSTALK_LOCAL_PROGRAMS says where). */
  find: () => LocalProgram[];
  /** Whether a server can have a port of 127.0.0.1 to itself now (tests give their own). */
  portFree: (port: number) => boolean | Promise<boolean> = (port) => loopbackFree(port);
  private runs = new Map<string, Run>();
  /** Ports a start is under way on (it waits for the port check): a second start there is turned down. */
  private claimed = new Set<number>();
  private loading: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly deps: RunnersDeps, lookNowhere = false) {
    this.find = () => findPrograms(lookNowhere);
  }

  // ---- What's here ----

  programs(): LocalProgram[] {
    return this.find();
  }

  /** The servers Crosstalk started, as the page shows them. */
  list(): LocalStarted[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt).map((r) => this.wire(r));
  }

  /** What Crosstalk started and is still running, for the memory guard: its name on the phone and its process. */
  heavy(): { what: string; pid: number }[] {
    return [...this.runs.values()].filter((r) => r.state === "starting" || r.state === "running").map((r) => ({ what: `${NAMES[r.kind]} on port ${r.port}`, pid: r.pid }));
  }

  /** Ports of what Crosstalk started, for the scan for model servers (Services.localServers). */
  ports(): Record<number, Kind> {
    return Object.fromEntries([...this.runs.values()].filter((r) => r.state !== "failed").map((r) => [r.port, r.kind]));
  }

  /** The server Crosstalk started that answers at this port (starting, running or stopping). */
  at(port: number): Run | null {
    return [...this.runs.values()].find((r) => r.port === port && r.state !== "failed") ?? null;
  }

  /** A llama.cpp server Crosstalk started serves this model file. */
  serving(path: string): boolean {
    return [...this.runs.values()].some((r) => r.state !== "failed" && r.modelPath === path);
  }

  /** Why Crosstalk won't stop a server it didn't start, with what to do instead. */
  stopWhy(server: Pick<LocalServer, "kind" | "baseUrl">, poolPort: number | null): string {
    const port = Number(new URL(server.baseUrl).port);
    if (server.kind === "lmstudio") return "LM Studio is managed in LM Studio: start and stop it there.";
    if (poolPort !== null && port === poolPort) return "This is the model pool's server: stop it in Model pool.";
    if (server.kind === "ollama") {
      return process.platform === "darwin"
        ? "Crosstalk didn't start this Ollama, so it leaves it alone: quit it from its menu bar icon, or where it was started."
        : "Crosstalk didn't start this Ollama, so it leaves it alone: stop it where it was started (sudo systemctl stop ollama, when it runs as a service).";
    }
    return "Crosstalk didn't start this server, so it leaves it alone: quit it where it was started.";
  }

  /** Free ports for a new server of each kind: its own default when that's free. */
  async freePorts(): Promise<Record<Kind, number>> {
    await this.ready();
    const pick = async (kind: Kind) => {
      const from = DEFAULT_PORTS[kind];
      for (let p = from; p < from + 100; p++) if (p !== this.deps.hubPort() && p !== POOL_PORT && !this.at(p) && (await this.portFree(p))) return p;
      return from;
    };
    return { ollama: await pick("ollama"), llamacpp: await pick("llamacpp") };
  }

  // ---- Starting ----

  /** POST /api/local-models/start: starts it on its own and answers at once (`starting`); the page looks again until it's `running`. */
  async start(body: unknown): Promise<LocalStarted> {
    await this.ready();
    if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
    const b = (body && typeof body === "object" ? body : {}) as Partial<Record<keyof LocalServerStart, unknown>>;
    if (b.kind !== "ollama" && b.kind !== "llamacpp") throw new HttpError(400, "Say which server to start: Ollama or llama.cpp.");
    const kind: Kind = b.kind;
    const port = b.port === undefined || b.port === null ? DEFAULT_PORTS[kind] : Number(b.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, "Pick a port from 1024 to 65535.");
    if (port === this.deps.hubPort()) throw new HttpError(409, `Port ${port} is the hub's own: pick another.`, "port_taken");
    const program = this.programs().find((p) => p.kind === kind);
    if (!program) throw new HttpError(409, notInstalled(kind), "no_program");
    let model: { id: string; path: string; alias: string; gpu: string[] } | null = null;
    let context: number | null = null;
    /** What llama.cpp will need in memory with this model at this context; null for Ollama, which loads on demand. */
    let need: number | null = null;
    if (kind === "llamacpp") {
      if (typeof b.model !== "string" || !b.model) throw new HttpError(400, "Pick the model llama.cpp should serve.");
      const { file, path } = this.deps.model(b.model);
      context = b.context === undefined || b.context === null ? DEFAULT_CONTEXT : Number(b.context);
      if (!Number.isInteger(context) || context < MIN_CONTEXT || context > MAX_CONTEXT) throw new HttpError(400, `Pick a context from ${MIN_CONTEXT.toLocaleString("en-US")} to ${MAX_CONTEXT.toLocaleString("en-US")} tokens.`);
      // Never past what it was trained for: llama.cpp would hold a cache that big (more memory than the page counted) for a context the model can't use.
      if (file.contextLength && context > file.contextLength) context = file.contextLength;
      need = needBytes(file, context);
      const machine = this.deps.machine ? await this.deps.machine().catch(() => null) : null;
      model = { id: file.id, path, alias: aliasOf(file.repo, file.quant), gpu: gpuLayers(machine, need) };
    }
    // Does it fit beside what already runs here? Asked before the port is claimed and before anything is spawned, so
    // a refusal leaves the machine exactly as it was. `force` is the person's "start anyway" from the dialog.
    if (this.deps.beforeStart) {
      await this.deps.beforeStart({ what: `${NAMES[kind]} on port ${port}`, needBytes: need, force: b.force === true });
    }
    const id = `${kind}-${port}`;
    const other = this.at(port);
    if (other) throw new HttpError(409, other.id === id ? `${NAMES[kind]} is already ${other.state === "starting" ? "starting" : other.state === "stopping" ? "stopping" : "running"} on port ${port}.` : `${NAMES[other.kind]} runs on port ${port}: pick another port.`, "port_taken");
    if (this.claimed.has(port)) throw new HttpError(409, `A server is already starting on port ${port}.`, "port_taken");
    this.claimed.add(port);
    try {
      if (!(await this.portFree(port))) throw new HttpError(409, `Port ${port} is taken on this machine: pick another.`, "port_taken");
      if (this.closed) throw new HttpError(503, "The hub is shutting down: try again once it's back.");
      this.forget(id);
      const run = this.launch({ id, kind, port, bin: program.path, model, context });
      log.info(`started ${NAMES[kind]} on port ${port}${model ? ` with ${model.id}` : ""} (pid ${run.pid})`);
      return this.wire(run);
    } finally {
      this.claimed.delete(port);
    }
  }

  private launch(o: { id: string; kind: Kind; port: number; bin: string; model: { id: string; path: string; alias: string; gpu: string[] } | null; context: number | null }): Run {
    const dir = join(this.deps.runDir, o.id);
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, "server.log");
    const fd = openSync(logFile, "w");
    try {
      const args =
        o.kind === "ollama"
          ? ["serve"]
          : ["-m", o.model!.path, "--host", "127.0.0.1", "--port", String(o.port), "-c", String(o.context), "-a", o.model!.alias, "-np", "1", ...o.model!.gpu];
      const child = spawn(o.bin, args, { cwd: dir, detached: true, stdio: ["ignore", fd, fd], env: serverEnv(o.kind, o.bin, o.port, this.deps.pullsWaiting?.() ?? false) });
      child.unref();
      child.on("error", (e) => log.warn(`${NAMES[o.kind]}: ${e.message}`));
      if (!child.pid) throw new HttpError(500, `${NAMES[o.kind]} didn't start: ${o.bin} couldn't be run. Install it again, then try again.`);
      const run: Run = { id: o.id, kind: o.kind, port: o.port, pid: child.pid, bin: o.bin, dir, model: o.model?.id ?? null, modelPath: o.model?.path ?? null, context: o.context, startedAt: Date.now(), state: "starting", detail: o.kind === "llamacpp" ? "Loading the model…" : "Starting…", child, exit: null, timer: null, stopping: null };
      child.on("exit", (code, signal) => {
        run.exit = { code, signal };
        if (run.child === child) run.child = null;
      });
      this.runs.set(run.id, run);
      this.note();
      this.watch(run, Date.now() + this.t.startMs[o.kind]);
      return run;
    } finally {
      closeSync(fd);
    }
  }

  /** Looks at a server until it answers (then now and then, to see it's still there); one that stops says why. */
  private watch(run: Run, startBy: number | null) {
    let until = startBy;
    // Being stopped, put away or replaced meanwhile: this look is over (a function, so it's read afresh after each wait).
    const over = () => this.closed || this.runs.get(run.id) !== run || run.state === "stopping" || run.state === "failed";
    const tick = async () => {
      run.timer = null;
      if (over()) return;
      if (run.exit || !alive(run.pid)) {
        // Its exit is handled first, so how it ended is known.
        await sleep(50);
        if (over()) return;
        return this.failed(run, run.state === "starting" ? "It stopped while starting" : "It stopped");
      }
      const answer = await answering(run);
      if (over()) return;
      if (answer === "ready") {
        if (run.state !== "running") log.info(`${NAMES[run.kind]} on port ${run.port} answers`);
        run.state = "running";
        run.detail = null;
      } else if (run.state === "starting" && until !== null && Date.now() > until) {
        // Not left running without answering: what was started is ended, so it's stopped as the page says.
        if (await this.end(run)) return this.failed(run, `It didn't answer within ${minutes(this.t.startMs[run.kind])}, so it was stopped`, true);
        if (over()) return;
        // It wouldn't end (stuck reading a drive that went away, say): still Crosstalk's, noted, and Stop tries again.
        until = null;
        run.detail = `It didn't answer within ${minutes(this.t.startMs[run.kind])} and didn't stop: try again, or end it on this machine.`;
        log.warn(`${NAMES[run.kind]} on port ${run.port} didn't answer, and didn't stop`);
      } else if (answer === "loading") run.detail = "Loading the model…";
      run.timer = setTimeout(() => void tick(), run.state === "running" ? this.t.watchMs : this.t.stepMs);
      (run.timer as { unref?: () => void }).unref?.();
    };
    run.timer = setTimeout(() => void tick(), this.t.stepMs);
    (run.timer as { unref?: () => void }).unref?.();
  }

  /** It isn't running any more: why, from how it ended and its last words, with what to do. */
  private failed(run: Run, what: string, ended = false) {
    let text = "";
    try {
      text = readFileSync(join(run.dir, "server.log"), "utf8").slice(-16_000);
    } catch {
      text = "";
    }
    const lines = text.split(/\r?\n/);
    let why: string;
    if (ended) why = `${what}. Its log: ${shown(join(run.dir, "server.log"))}`;
    else if (run.kind === "llamacpp") why = explainExit("server", lines.slice(-200), run.exit?.code ?? null, run.exit?.signal ?? null, { port: run.port });
    else {
      const said = lastProblem(text);
      const how = said ?? (run.exit?.signal === "SIGKILL" ? "it was force-quit" : run.exit?.signal ? "it was quit" : null);
      why = `${what}${how ? `: ${how}` : ""}. Start it again; if it keeps happening, look at its log: ${shown(join(run.dir, "server.log"))}`;
    }
    log.warn(`${NAMES[run.kind]} on port ${run.port}: ${why}`);
    run.state = "failed";
    run.detail = why;
    run.child = null;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.note();
  }

  // ---- Stopping ----

  /**
   * POST /api/local-models/stop `{ id }`: ends a server Crosstalk started (its whole process group, so Ollama's model
   * runners go too); a failed one is just put away. Answers null once it's gone, or the server still running when it
   * wouldn't stop. Nothing else is ever sent a signal: a server whose process can't be proved Crosstalk's is left alone.
   */
  async stop(body: unknown): Promise<LocalStarted | null> {
    await this.ready();
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    const run = typeof id === "string" ? this.runs.get(id) : undefined;
    if (!run) throw new HttpError(404, "Crosstalk didn't start that server, so it leaves it alone. Press Rescan to see what runs.");
    if (run.state === "failed") {
      this.forget(run.id);
      return null;
    }
    run.stopping ??= this.stopNow(run).finally(() => (run.stopping = null));
    await run.stopping;
    return this.runs.get(run.id) === run ? this.wire(run) : null;
  }

  private async stopNow(run: Run) {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    const was = run.state;
    run.state = "stopping";
    run.detail = "Stopping…";
    const ended = await this.end(run);
    if (!ended) {
      run.state = was === "starting" ? "starting" : "running";
      run.detail = "It didn't stop: try again, or end it on this machine.";
      this.watch(run, null);
      return;
    }
    log.info(`stopped ${NAMES[run.kind]} on port ${run.port}`);
    this.forget(run.id);
  }

  /**
   * Ends the server's process group (SIGTERM, then SIGKILL), never once its number has stopped being this server. True
   * when it's gone: also when it can't be proved to be this server any more (it ended, and its number may be another
   * program's now), which is then left alone.
   */
  private async end(run: Run): Promise<boolean> {
    if (!(await this.ours(run))) return true;
    const send = (sig: NodeJS.Signals) => {
      try {
        process.kill(-run.pid, sig);
      } catch {
        // Gone already.
      }
    };
    send("SIGTERM");
    const until = Date.now() + this.t.stopMs;
    while (alive(run.pid) && !run.exit && Date.now() < until) await sleep(100);
    if (alive(run.pid) && !run.exit && (await this.ours(run))) send("SIGKILL");
    for (let i = 0; i < 50 && alive(run.pid) && !run.exit; i++) await sleep(100);
    return !alive(run.pid) || !!run.exit;
  }

  /** The process is this server: this hub's own child still running, or the noted one still running from its folder. */
  private async ours(run: Run): Promise<boolean> {
    if (run.exit || !alive(run.pid)) return false;
    const child = run.child;
    if (child && child.pid === run.pid && child.exitCode === null && child.signalCode === null) return true;
    const cwd = await cwdOf(run.pid);
    return !!cwd && [run.dir, real(run.dir)].some((d) => cwd === d || cwd.startsWith(d + sep));
  }

  // ---- Notes ----

  /** Servers an earlier run of the hub started: those still running from their folder are Crosstalk's again; the rest are forgotten. */
  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load() {
    const file = this.deps.stateFile;
    if (!file) return;
    let list: Noted[] = [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      return;
    }
    for (const n of list) {
      if (typeof n?.id !== "string" || (n.kind !== "ollama" && n.kind !== "llamacpp") || !Number.isInteger(n.pid) || n.pid <= 1 || typeof n.dir !== "string" || !Number.isInteger(n.port)) continue;
      // Only its own folder under the hub's run folder proves it: a note can't point anywhere else (nor out with "..").
      const named = /^(ollama|llamacpp)-(\d+)$/.exec(n.id);
      if (!named || named[1] !== n.kind || Number(named[2]) !== n.port || resolve(n.dir) !== join(this.deps.runDir, n.id)) continue;
      const run: Run = { ...n, model: n.model ?? null, modelPath: n.modelPath ?? null, context: n.context ?? null, state: "starting", detail: null, child: null, exit: null, timer: null, stopping: null };
      if (!(await this.ours(run))) continue;
      this.runs.set(run.id, run);
      this.watch(run, null);
    }
    this.note();
  }

  private note() {
    const file = this.deps.stateFile;
    if (!file) return;
    const list: Noted[] = [...this.runs.values()].filter((r) => r.state !== "failed").map(({ id, kind, port, pid, bin, dir, model, modelPath, context, startedAt }) => ({ id, kind, port, pid, bin, dir, model, modelPath, context, startedAt }));
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(list), { mode: 0o600 });
    } catch (e) {
      // Only a restarted hub needs it; without it, the server runs on and is left alone.
      log.warn(`couldn't note the local servers: ${e instanceof Error ? e.message : e}`);
    }
  }

  private forget(id: string) {
    const run = this.runs.get(id);
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    this.runs.delete(id);
    this.note();
  }

  private wire(r: Run): LocalStarted {
    return { id: r.id, kind: r.kind, port: r.port, baseUrl: `http://127.0.0.1:${r.port}`, model: r.model, context: r.context, state: r.state, detail: r.detail, log: shown(join(r.dir, "server.log")), startedAt: r.startedAt };
  }

  /** The hub is stopping: the servers keep running (they aren't the hub's to end); only the looks at them stop. */
  shutdown() {
    this.closed = true;
    for (const r of this.runs.values()) {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      r.child?.removeAllListeners("exit");
      r.child = null;
    }
  }
}

/** Whether a server answers yet: "ready", "loading" (llama.cpp reading its model) or no. */
async function answering(run: Pick<Run, "kind" | "port">): Promise<"ready" | "loading" | null> {
  const path = run.kind === "ollama" ? "/api/version" : "/health";
  try {
    const r = await fetch(`http://127.0.0.1:${run.port}${path}`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    await r.body?.cancel().catch(() => {});
    return r.ok ? "ready" : r.status === 503 ? "loading" : null;
  } catch {
    return null;
  }
}

/**
 * The environment a server starts with: only what a program needs to run, its own settings, and the address to listen
 * on. `keepParts`: an Ollama pull is stopped or running, and `ollama serve` clears the parts of downloads it doesn't
 * know as it starts (they share Ollama's folder) unless OLLAMA_NOPRUNE is set, so Resume would start over.
 */
function serverEnv(kind: Kind, bin: string, port: number, keepParts = false): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) if (process.env[k]) env[k] = process.env[k]!;
  if (kind === "ollama") {
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("OLLAMA_") && k !== "OLLAMA_HOST" && v !== undefined) env[k] = v;
    env.OLLAMA_HOST = `127.0.0.1:${port}`;
    if (keepParts) env.OLLAMA_NOPRUNE = "1";
  } else if (process.platform === "linux") {
    env.LD_LIBRARY_PATH = [dirname(bin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  return env;
}

/**
 * Whether a server can have this port of 127.0.0.1 to itself: it can be bound there, and nothing answers there or at
 * ::1. On a Mac a bind to 127.0.0.1 succeeds beside a program listening on every address (0.0.0.0 or ::, like a port
 * Docker publishes), and the server bound there would then take that program's localhost connections. Whatever answers
 * is only connected to and let go: nothing is sent to it, and nothing binds beyond 127.0.0.1. Test hubs, which set
 * CROSSTALK_LOCAL_SERVER_PORTS empty (look for no model servers here), only bind: they never reach this machine's own.
 */
export async function loopbackFree(port: number, connect = process.env.CROSSTALK_LOCAL_SERVER_PORTS !== ""): Promise<boolean> {
  try {
    const l = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    l.stop(true);
  } catch {
    return false;
  }
  if (!connect) return true;
  const answered = await Promise.all(["127.0.0.1", "::1"].map((host) => connects(host, port)));
  return !answered.some(Boolean);
}

/** Whether something takes a connection at a loopback address and port (one that hangs counts: it's there, just busy). */
function connects(hostname: string, port: number, ms = 1000): Promise<boolean> {
  return new Promise((done) => {
    let said = false;
    const say = (v: boolean) => {
      if (said) return;
      said = true;
      clearTimeout(timer);
      done(v);
    };
    const timer = setTimeout(() => say(true), ms);
    Bun.connect({ hostname, port, socket: { open: (s) => (s.end(), say(true)), data() {}, error: () => say(false), connectError: () => say(false) } }).catch(() => say(false));
  });
}

/** What a model needs in memory at a context: the file, its KV cache, and llama.cpp's 1 GB of headroom (as the page counts it: web/src/localLibrary.ts needOf). */
export function needBytes(file: Pick<LocalModelFile, "bytes" | "kvBytesPerToken">, context: number): number {
  return file.bytes + (file.kvBytesPerToken ?? 128 * 1024) * context + 1024 ** 3;
}

/**
 * Where llama.cpp puts the model's layers: all on the GPU (`-ngl 999`, which old and new builds take) on a Mac, and on a
 * PC whose GPUs hold it; else llama.cpp decides, and puts what doesn't fit on the processor (the page says "Slow").
 * Without -ngl, a new llama.cpp with -c set would rather move layers to the processor than cut the context, and nothing
 * says so; an old one puts none on the GPU at all.
 */
export function gpuLayers(m: Pick<LocalMachine, "unified" | "gpuBytes"> | null, need: number): string[] {
  if (!m) return [];
  if (m.unified || (m.gpuBytes !== null && m.gpuBytes > 0 && need <= m.gpuBytes)) return ["-ngl", "999"];
  return [];
}

/** The model's name in chats: "qwen3-8b-q4_k_m". */
function aliasOf(repo: string, quant: string | null): string {
  const base = aliasFor({ repo });
  const name = quant ? `${base}-${quant.toLowerCase()}` : base;
  return /^[\w.:-]{1,64}$/.test(name) ? name : base;
}

function notInstalled(kind: Kind): string {
  if (kind === "ollama") return "Ollama isn't installed on this machine: get it at ollama.com/download, then press Rescan.";
  return process.platform === "darwin"
    ? "llama.cpp isn't installed on this machine: install it with Homebrew (brew install llama.cpp), or start the model pool once to get its build, then press Rescan."
    : "llama.cpp isn't installed on this machine: get llama-server from github.com/ggml-org/llama.cpp/releases (or start the model pool once to get its build), then press Rescan.";
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`);

/**
 * The programs on this machine: Ollama and llama-server on the PATH or where their installers put them (the Ollama
 * app keeps its program inside it), and the model pool's llama.cpp. CROSSTALK_LOCAL_PROGRAMS (folders, ":" between
 * them; empty: nowhere) replaces where to look; in-memory hubs (tests) and the compiled-binary check
 * (CROSSTALK_NO_AGENT_CLIS) look nowhere else, so they never find this machine's own.
 */
export function findPrograms(lookNowhere: boolean): LocalProgram[] {
  const only = process.env.CROSSTALK_LOCAL_PROGRAMS;
  const out: LocalProgram[] = [];
  for (const kind of ["ollama", "llamacpp"] as Kind[]) {
    let candidates: string[];
    if (only !== undefined) candidates = only.split(":").filter(Boolean).map((d) => join(d, BIN[kind]));
    else if (lookNowhere || process.env.CROSSTALK_NO_AGENT_CLIS === "1") candidates = [];
    else candidates = [Bun.which(BIN[kind]), ...PLACES[kind]].filter((p): p is string => !!p);
    const path = candidates.find((p) => existsSync(p));
    if (path) {
      out.push({ kind, path, from: fromOf(path) });
      continue;
    }
    if (kind !== "llamacpp" || only !== undefined || lookNowhere || process.env.CROSSTALK_NO_AGENT_CLIS === "1") continue;
    const pool = installedBuilds()
      .map((id) => /^(b\d+)-(\w+)$/.exec(id))
      .map((m) => (m ? findInstall(m[1], m[2] as LlamaInstall["backend"]) : null))
      .find((i): i is LlamaInstall => !!i);
    if (pool) out.push({ kind, path: pool.server, from: `the model pool's llama.cpp ${pool.build}` });
  }
  return out;
}

const instances = new WeakMap<App, LocalRunners>();

/** The one LocalRunners of a hub; its servers' ports join the hub's scan for model servers. */
export function localRunnersOf(app: App): LocalRunners {
  let r = instances.get(app);
  if (r) return r;
  const inMemory = app.opts.dbPath === ":memory:";
  r = new LocalRunners(
    {
      // In-memory hubs (tests) keep their servers' folders in the temp folder and never pick up an earlier run's.
      runDir: inMemory ? join(tmpdir(), `crosstalk-scratch-${process.getuid?.() ?? "user"}`, String(process.pid), `local-servers-${crypto.randomUUID().slice(0, 8)}`) : join(RUN_DIR, "local-servers"),
      stateFile: inMemory ? undefined : join(RUN_DIR, "local-servers.json"),
      hubPort: () => app.config.port,
      model: (id) => localLibraryOf(app).fileById(id),
      machine: () => localLibraryOf(app).machine(),
      pullsWaiting: () => localLibraryOf(app).pullsWaiting(),
      // The memory guard (memory.ts): does it fit beside what's already running here? In-memory hubs have a blind
      // guard, so tests start servers the way they always did.
      beforeStart: (o) => app.memory.check(o).then(() => {}),
    },
    inMemory,
  );
  const runners = r;
  instances.set(app, runners);
  app.services.extraPorts = () => runners.ports();
  return runners;
}

/** The hub's LocalRunners if it was ever used. */
export const existingLocalRunners = (app: App): LocalRunners | null => instances.get(app) ?? null;
