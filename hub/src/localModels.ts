// Local models (docs/SPEC-0.5.md, track T10): what's running on this machine, the memory it uses, and a switch per model that
// frees its memory or loads it again. It builds on Services.localServers() (model servers on 127.0.0.1 only) and adds the
// memory of each server's processes (lsof says who listens on its port, ps what they use), what each server says it holds
// per model (Ollama's /api/ps, llama.cpp's router list) and the switch itself (Ollama: /api/generate with a keep_alive and
// no prompt; llama.cpp's router: /models/load and /models/unload). Never a model request, never another host (the loopback
// address only), and never a signal to any process: a model is freed by asking its server, not by ending anything.
// Getting models (localLibrary.ts) and starting and stopping servers (localRunners.ts, the only place that ends one, and
// only one it started) have their own modules; their routes are here.

import { existsSync } from "node:fs";
import type { LocalModel, LocalModelServer, LocalModelsView, LocalModelSwitch, LocalServer } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";
import { existingLocalLibrary, localLibraryOf } from "./localLibrary";
import { existingLocalRunners, localRunnersOf } from "./localRunners";
import { route, type Route } from "./routes";
import { SERVER_NAMES, ask } from "./serviceProbes";

// ---- who uses the memory ----

/** Runs a command and gives what it printed; null when the command isn't on this machine. Tests give their own, so none runs a real lsof or ps. */
export type Runner = (argv: string[]) => Promise<string | null>;

const LSOF = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
const PS = existsSync("/bin/ps") ? "/bin/ps" : "ps";
const COMMAND_MS = 5000;

export const runCommand: Runner = async (argv) => {
  const bin = argv[0].startsWith("/") ? (existsSync(argv[0]) ? argv[0] : null) : Bun.which(argv[0]);
  if (!bin) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([bin, ...argv.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    // A command that hangs is given up on, not ended: nothing here sends a signal.
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), COMMAND_MS)));
    return await Promise.race([new Response(child.stdout).text(), late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Process numbers in `lsof -t` output (each once). */
export const pidsIn = (text: string): number[] => [...new Set(text.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1))];

export type ProcessTable = Map<number, { ppid: number; kb: number }>;

/** `ps -A -o pid=,ppid=,rss=` as a table: every process with its parent and the kilobytes it holds in memory. */
export function processTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(kb)) table.set(pid, { ppid, kb });
  }
  return table;
}

/**
 * The bytes these processes hold, with every process they started (and those started by those): a server's model often
 * runs in a process of its own (Ollama's runner, each of llama.cpp's router models). Each process counts once. Null when
 * none of them is in the table, or they hold nothing.
 */
export function treeBytes(table: ProcessTable, roots: number[]): number | null {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const mine = new Set<number>();
  const queue = roots.filter((pid) => table.has(pid));
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    if (mine.has(pid)) continue;
    mine.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  const kb = [...mine].reduce((n, pid) => n + table.get(pid)!.kb, 0);
  return kb > 0 ? kb * 1024 : null;
}

/** Who listens on each of these ports (one `lsof` each). Empty for a port nobody holds, or a machine without lsof. */
export async function listenersOn(ports: number[], run: Runner): Promise<Map<number, number[]>> {
  const found = await Promise.all(ports.map(async (port) => [port, pidsIn((await run([LSOF, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])) ?? "")] as const));
  return new Map(found);
}

/**
 * What the servers listening on these ports use in memory, by port: who listens (lsof), then what they and what they started
 * hold (one look at ps). A port nobody can be found for, or a machine without lsof or ps, gives null: it can't be told.
 */
export async function processMemory(ports: number[], run: Runner): Promise<Map<number, number | null>> {
  const listening = [...(await listenersOn(ports, run))];
  const out = new Map<number, number | null>(ports.map((port) => [port, null]));
  if (!listening.some(([, pids]) => pids.length)) return out;
  const text = await run([PS, "-A", "-o", "pid=,ppid=,rss="]);
  if (text === null) return out;
  const table = processTable(text);
  for (const [port, pids] of listening) out.set(port, treeBytes(table, pids));
  return out;
}

// ---- what each server says about its models ----

/** Only the loopback address is ever called: never another host, never a Tailscale (100.x) address. */
export function onThisMachine(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

interface State {
  loaded: boolean;
  loading: boolean;
  memoryBytes: number | null;
  vramBytes: number | null;
  expiresAt: number | null;
}
interface Detail {
  /** llama.cpp in router mode: its models are loaded and freed on request. */
  router: boolean;
  /** Each model the server named, by id. Models Ollama doesn't name aren't loaded. */
  states: Map<string, State>;
}

const DETAIL_MS = 3000;
const YEAR_MS = 365 * 24 * 3600 * 1000;
const positive = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
const rowsOf = (v: unknown): any[] | null => (Array.isArray(v) ? v : null); // eslint-disable-line @typescript-eslint/no-explicit-any
/** Ollama's `expires_at`: a time within the year. A model kept for ever shows a date centuries away (or the zero time): that isn't a time. */
const expiry = (v: unknown): number | null => {
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(at) && at > 0 && at < Date.now() + YEAR_MS ? at : null;
};

/** Whether Crosstalk can switch a server's models, and when it can't, what to do instead in plain words. */
function switchability(kind: LocalServer["kind"], router: boolean): { canSwitch: boolean; why: string | null } {
  if (kind === "ollama" || (kind === "llamacpp" && router)) return { canSwitch: true, why: null };
  const why: Record<string, string> = {
    llamacpp: "This llama.cpp server holds one model, chosen when it started. Quit it on this machine to free its memory.",
    lmstudio: "LM Studio is switched in its own app.",
    vllm: "vLLM keeps its model loaded while it runs. Quit it on this machine to free its memory.",
    mlx: "mlx-lm doesn't say which model it has loaded, and Crosstalk can't switch it. Quit it on this machine to free its memory.",
    other: "Crosstalk can't switch this server's models. Use the program that runs it.",
  };
  return { canSwitch: false, why: why[kind] };
}

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} second${Math.round(ms / 1000) <= 1 ? "" : "s"}`;
const hostOf = (server: LocalServer) => new URL(server.baseUrl).host;
const portOf = (server: LocalServer) => Number(new URL(server.baseUrl).port) || 80;

/** What a refusal says, in the server's words (Ollama's "model requires more system memory…" is the useful one). */
function reasonOf(answer: { status: number; json: any }): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const e = answer.json?.error;
  const text = (typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  return text ? (text.length > 200 ? `${text.slice(0, 199)}…` : text) : `it answered with error ${answer.status}`;
}

interface Sent {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  failed: "timeout" | "network" | null;
}

/** A JSON POST that never follows a redirect (a server never sends the request on to another address). */
async function post(url: string, body: unknown, signal: AbortSignal): Promise<Sent> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), redirect: "manual", signal });
    return { status: res.status, json: await res.json().catch(() => null), failed: null };
  } catch {
    return { status: 0, json: null, failed: signal.aborted ? "timeout" : "network" };
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** Resolves (to null) when the signal aborts: the time is up. */
const over = (signal: AbortSignal) => new Promise<null>((resolve) => (signal.aborted ? resolve(null) : signal.addEventListener("abort", () => resolve(null), { once: true })));

/** A switch under way: which way, and the request still out when the answer's limit came (see `send`). */
interface Switching {
  on: boolean;
  late: Promise<unknown> | null;
}

export class LocalModels {
  /** What reads the machine (lsof, ps): tests replace it. */
  run: Runner = runCommand;
  /** How long a switch may take to answer (20 seconds; tests shorten it), and how often it looks whether the server is done. */
  limitMs = 20_000;
  pollMs = 250;
  /** How long a load is left to carry on once the answer has been given without it (5 minutes, for a big model on a slow disk; tests shorten it). */
  ceilingMs = 5 * 60_000;
  /** The models being switched now (server id, a line break, model): one switch per model at a time, a load that outlasts its answer included. */
  private readonly switching = new Map<string, Switching>();

  constructor(private readonly app: App) {}

  /** The servers on this machine with their memory and models. Without `fresh` the hub's scan of the last 10 seconds is used (what each says it holds is read again every time). */
  async list(fresh = false): Promise<LocalModelsView> {
    const { servers, scannedAt } = await this.app.services.localServers({ fresh });
    // A model this hub is loading says so, though its server may not yet (Ollama lists a model once it is in memory).
    const loading = (s: LocalModelServer): LocalModelServer => ({ ...s, models: s.models.map((m) => (this.switching.get(`${s.id}\n${m.id}`)?.on ? { ...m, loading: true } : m)) });
    return { servers: (await this.describe(servers)).map(loading), scannedAt };
  }

  /**
   * Turns a model on (loads it) or off (frees its memory) and answers its server as it is read right afterwards.
   * 409 when the server can't be switched or the model is being switched already, 404 when the server or model has gone.
   */
  async switch(input: unknown): Promise<LocalModelServer> {
    const { serverId, model, on } = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof LocalModelSwitch, unknown>>;
    if (typeof serverId !== "string" || !serverId || typeof model !== "string" || !model || typeof on !== "boolean") throw new HttpError(400, "Say which server and model to switch, and whether to turn it on or off.");
    const key = `${serverId}\n${model}`;
    const busy = this.switching.get(key);
    if (busy) throw new HttpError(409, busy.late ? `${model} is still ${busy.on ? "loading" : "being freed"}. Press Rescan in a moment to see.` : `${model} is being switched already. Wait for that to finish.`);
    const mine: Switching = { on, late: null };
    this.switching.set(key, mine);
    try {
      return await this.move(serverId, model, on, mine);
    } finally {
      // A request still out (the load that the answer didn't wait for) keeps the model held until it has ended.
      if (mine.late) void mine.late.then(() => this.switching.delete(key));
      else this.switching.delete(key);
    }
  }

  private async move(serverId: string, model: string, on: boolean, hold: Switching): Promise<LocalModelServer> {
    const server = await this.find(serverId);
    if (!onThisMachine(server.baseUrl)) throw new HttpError(409, "Only servers on this machine can be switched from here.");
    // The model is looked for among what the server says now: a router lists models the scan's own list may leave out.
    const [now] = await this.describe([server]);
    const m = now.models.find((x) => x.id === model);
    if (!m) throw new HttpError(404, `${SERVER_NAMES[server.kind]} doesn't list ${model} any more. Press Rescan to see what it has.`);
    if (!m.canSwitch) throw new HttpError(409, m.why ?? "Crosstalk can't switch this model.");
    // Already as asked: nothing to send. Already loading (the router's own look): wait for it, don't ask again.
    if (m.loaded === on && !m.loading) return now;
    await this.send(server, model, on, server.kind === "llamacpp", on && m.loading, hold);
    const [fresh] = await this.describe([await this.find(serverId)]);
    return fresh;
  }

  private async find(id: string): Promise<LocalServer> {
    const { servers } = await this.app.services.localServers({ fresh: true });
    const server = servers.find((s) => s.id === id);
    if (!server) throw new HttpError(404, "That server isn't running any more. Press Rescan to see what is.");
    return server;
  }

  /**
   * Asks the server to load or free the model, then waits, within the limit, until the server says it's done. The limit is on
   * the answer, not on the work: Ollama answers a load only once the model is in memory (a big one from a cold disk takes more
   * than 20 seconds) and drops a load when the request that asked for it ends. So that request is never cut at the limit: it
   * carries on to a ceiling of its own, the model stays held (`hold`) until it has ended, and the answer says it's still loading.
   * llama.cpp's router answers at once and loads in the background, whatever becomes of the request.
   */
  private async send(server: LocalServer, model: string, on: boolean, router: boolean, waitOnly: boolean, hold: Switching) {
    const name = SERVER_NAMES[server.kind];
    const limit = AbortSignal.timeout(this.limitMs);
    const tooSlow = () => new HttpError(504, `${name} didn't finish within ${seconds(this.limitMs)}. It may still be working: press Rescan in a moment to see.`);
    const gone = () => new HttpError(502, `Couldn't reach ${name} at ${hostOf(server)} any more. Check that it's still running, then press Rescan.`);
    const refused = (reason: string) => new HttpError(502, `${name} couldn't ${on ? "load" : "free"} ${model}: ${reason}.`);
    const heard = (sent: Sent) => {
      if (sent.failed) throw sent.failed === "timeout" ? tooSlow() : gone();
      if (sent.status < 200 || sent.status >= 300) throw refused(reasonOf(sent));
    };
    if (!waitOnly && router) {
      heard(await post(`${server.baseUrl}/models/${on ? "load" : "unload"}`, { model }, limit));
    } else if (!waitOnly) {
      // Ollama: a /api/generate with no prompt only loads (keep_alive "30m") or frees (keep_alive 0) the model.
      const request = post(`${server.baseUrl}/api/generate`, { model, keep_alive: on ? "30m" : 0 }, AbortSignal.timeout(this.ceilingMs));
      const sent = await Promise.race([request, over(limit)]);
      if (!sent) {
        hold.late = request;
        throw new HttpError(504, on ? `${name} is still loading ${model}. A big model can take a minute or more: press Rescan in a moment to see.` : `${name} is still freeing ${model}: press Rescan in a moment to see.`);
      }
      heard(sent);
    }
    for (;;) {
      const now = await this.stateOf(server, model, limit);
      if (now === "gone") throw limit.aborted ? tooSlow() : gone();
      if (typeof now === "object") throw refused(now.failed);
      if (now === (on ? "on" : "off")) return;
      if (limit.aborted) throw tooSlow();
      await sleep(this.pollMs, limit);
    }
  }

  /** Where one model stands now. The router can also say it stopped while loading. */
  private async stateOf(server: LocalServer, model: string, signal: AbortSignal): Promise<"on" | "off" | "loading" | "gone" | { failed: string }> {
    if (server.kind !== "llamacpp") {
      const answer = await ask(`${server.baseUrl}/api/ps`, { signal });
      const rows = rowsOf(answer.json?.models);
      return !rows ? "gone" : rows.some((r) => r?.name === model || r?.model === model) ? "on" : "off";
    }
    const rows = rowsOf((await ask(`${server.baseUrl}/models`, { signal })).json?.data);
    if (!rows) return "gone";
    const status = rows.find((r) => r?.id === model)?.status;
    if (status?.value === "loaded") return "on";
    if (status?.value === "loading") return "loading";
    return status?.failed === true ? { failed: `it stopped while loading${typeof status.exit_code === "number" ? ` (exit code ${status.exit_code})` : ""}. Look at its log` } : "off";
  }

  /** The servers with their processes' memory, each model's state and whether it can be switched, and which Crosstalk started. */
  private async describe(servers: LocalServer[]): Promise<LocalModelServer[]> {
    if (!servers.length) return [];
    const runners = localRunnersOf(this.app);
    await runners.ready();
    const ports = servers.map(portOf);
    const [memory, details] = await Promise.all([processMemory(ports, this.run), Promise.all(servers.map((s) => this.detail(s)))]);
    const pool = this.app.poolNode.snapshot().server;
    return servers.map((s, i) => {
      const built = this.build(s, details[i], memory.get(ports[i]) ?? null);
      const run = runners.at(ports[i]);
      // Stop is offered for what Crosstalk started; anything else says how to stop it where it runs.
      return run && run.kind === s.kind ? { ...built, startedId: run.id, stopWhy: null } : { ...built, startedId: null, stopWhy: runners.stopWhy(s, pool.running ? pool.port : null) };
    });
  }

  /** What a server says about its models right now. Null when it says no more than the scan did (or isn't asked: only 127.0.0.1 is). */
  private async detail(server: LocalServer): Promise<Detail | null> {
    if (!onThisMachine(server.baseUrl)) return null;
    const get = (path: string) => ask(server.baseUrl + path, { signal: AbortSignal.timeout(DETAIL_MS) });
    const states = new Map<string, State>();
    if (server.kind === "ollama") {
      const rows = rowsOf((await get("/api/ps")).json?.models);
      if (!rows) return null;
      for (const r of rows) {
        for (const id of [r?.name, r?.model]) {
          if (typeof id === "string") states.set(id, { loaded: true, loading: false, memoryBytes: positive(r.size), vramBytes: positive(r.size_vram), expiresAt: expiry(r.expires_at) });
        }
      }
      return { router: false, states };
    }
    if (server.kind === "llamacpp") {
      // A single-model llama-server answers /models too (the same list as /v1/models): only the router's entries say `status`.
      const rows = rowsOf((await get("/models")).json?.data);
      if (!rows?.some((r) => typeof r?.status?.value === "string")) return null;
      for (const r of rows) {
        if (typeof r?.id === "string") states.set(r.id, { loaded: r.status?.value === "loaded", loading: r.status?.value === "loading", memoryBytes: null, vramBytes: null, expiresAt: null });
      }
      return { router: true, states };
    }
    return null;
  }

  private build(server: LocalServer, detail: Detail | null, processBytes: number | null): LocalModelServer {
    // The router lists models the scan may not have (it lists the ones that are loaded).
    const extra = detail?.router ? [...detail.states.keys()].filter((id) => !server.models.some((m) => m.id === id)) : [];
    const listed = [...server.models, ...extra.map((id) => ({ id, contextWindow: null, sizeBytes: null, loaded: false }))];
    const { canSwitch, why } = switchability(server.kind, !!detail?.router);
    const models = listed.map((m): LocalModel => {
      const s = detail?.states.get(m.id);
      // Without a better look: what the scan saw. mlx-lm and servers Crosstalk doesn't know don't say what they have loaded.
      const loaded = detail ? !!s?.loaded : server.kind === "mlx" || server.kind === "other" ? null : m.loaded;
      return { id: m.id, loaded, loading: !!s?.loading, contextWindow: m.contextWindow, sizeBytes: m.sizeBytes, memoryBytes: loaded ? s?.memoryBytes ?? null : null, vramBytes: loaded ? s?.vramBytes ?? null : null, expiresAt: loaded ? s?.expiresAt ?? null : null, canSwitch, why };
    });
    const held = models.reduce((n, m) => n + (m.memoryBytes ?? 0), 0) || null;
    // The processes' memory includes a model that runs inside them; what the models say includes one that runs in a process Crosstalk can't see: the larger is the better answer.
    const memoryBytes = processBytes === null ? held : held === null ? processBytes : Math.max(processBytes, held);
    return { ...server, models, processBytes, memoryBytes };
  }
}

const instances = new WeakMap<App, LocalModels>();

/** The one LocalModels of a hub (it keeps which switches are running). */
export function localModelsOf(app: App): LocalModels {
  let lm = instances.get(app);
  if (!lm) instances.set(app, (lm = new LocalModels(app)));
  return lm;
}

export function localModelRoutes(app: App): Route[] {
  const lm = localModelsOf(app);
  const lib = localLibraryOf(app);
  const runners = localRunnersOf(app);
  const input = (body: () => Promise<unknown>) => body().catch(() => null);
  return [
    route("GET", "/api/local-models", ({ url }) => lm.list(url.searchParams.get("fresh") === "1")),
    route("POST", "/api/local-models/switch", async ({ body }) => lm.switch(await input(body))),
    // Getting models (localLibrary.ts): each change answers the library as it is then.
    route("GET", "/api/local-models/library", () => lib.view()),
    route("PUT", "/api/local-models/folder", async ({ body }) => lib.setFolder(await input(body))),
    route("GET", "/api/local-models/search", ({ url }) => lib.search(url.searchParams.get("q"))),
    route("GET", "/api/local-models/files", ({ url }) => lib.repoFiles(url.searchParams.get("repo"))),
    route("GET", "/api/local-models/ollama", ({ url }) => lib.ollamaInfo(url.searchParams.get("model"))),
    route("POST", "/api/local-models/downloads", async ({ body }) => lib.startDownload(await input(body))),
    route("POST", "/api/local-models/downloads/stop", async ({ body }) => lib.stopDownload(await input(body))),
    route("POST", "/api/local-models/downloads/remove", async ({ body }) => lib.removeDownload(await input(body))),
    route("POST", "/api/local-models/files/remove", async ({ body }) => lib.removeFile(await input(body))),
    // Starting and stopping servers (localRunners.ts).
    route("POST", "/api/local-models/start", async ({ body }) => {
      await runners.start(await input(body));
      return lib.view();
    }),
    route("POST", "/api/local-models/stop", async ({ body }) => {
      await runners.stop(await input(body));
      return lib.view();
    }),
  ];
}

/** The hub has started: the servers an earlier run started are Crosstalk's again (a pull may go into one), and downloads it was running carry on. */
export async function startLocalModels(app: App): Promise<void> {
  await localRunnersOf(app).ready();
  await localLibraryOf(app).resumeInterrupted();
}

/** The hub is stopping: downloads stop where they are (the next start picks them up); servers Crosstalk started keep running. */
export async function shutdownLocalModels(app: App): Promise<void> {
  await existingLocalLibrary(app)?.shutdown();
  existingLocalRunners(app)?.shutdown();
}
