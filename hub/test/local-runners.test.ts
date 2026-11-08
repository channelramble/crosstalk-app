import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalLibrary as LibraryView, LocalModelServer } from "@crosstalk/shared";
import { App } from "../src/app";
import { localLibraryOf } from "../src/localLibrary";
import { localModelsOf, type Runner } from "../src/localModels";
import { findPrograms, gpuLayers, LocalRunners, localRunnersOf, loopbackFree } from "../src/localRunners";
import { POOL_PORT } from "../src/pool/pool";
import { startServer } from "../src/server";
import { fakeOllamaLive } from "./fixtures/fake-local-models";
import { fakeLmStudio } from "./fixtures/fake-services";
import { ggufBytes, qwenLike } from "./fixtures/gguf";
import { freePort, installScript } from "./fixtures/pool-fakes";
import { endStarted } from "./standins";

// Settings → Local models, starting and stopping servers (localRunners.ts): a fake `ollama` and a fake `llama-server`, started
// for real on 127.0.0.1 at free ports, from folders in the temp folder. Every process a test starts is ended after it, whatever
// the test got to; nothing here starts this machine's own programs or touches its own servers.

const cleanups: (() => void | Promise<void>)[] = [];
// First everything the test started ends, process groups whole: the servers Local models started (each in a process
// group of its own, as they must outlive the hub) with the runners they started, and the ones a test started by hand.
// Then the hubs and their folders go.
afterEach(async () => {
  await endStarted();
  for (const c of cleanups.splice(0).reverse()) await c();
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (done: () => boolean | Promise<boolean>, ms = 10_000) => {
  const stop = Date.now() + ms;
  while (!(await done()) && Date.now() < stop) await Bun.sleep(25);
  expect(await done()).toBe(true);
};
/** Who started each fake, as its log says: the server and (Ollama's) runner. */
const logged = (file: string): { pid: number; runner?: number | null; cwd: string; argv?: string[]; env: string[]; host?: string | null }[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** A pretend lsof and ps: nothing listens (the memory column isn't what these tests are about). */
const nobody: Runner = async (argv) => (argv.some((a) => a.startsWith("-iTCP:")) ? "" : argv.includes("pid=,ppid=,rss=") ? "" : null);

/** A hub with a fake ollama and llama-server "installed", a downloads folder holding one model, and quick timings. */
function setup(o: { ollama?: Record<string, unknown>; llama?: Record<string, string> } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ct-runners-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const ollama = installScript("fake-ollama", join(bin, "ollama"));
  const llama = installScript("fake-llama-server", join(bin, "llama-server"));
  const ollamaLog = join(dir, "ollama.log");
  const llamaLog = join(dir, "llama.log");
  writeFileSync(`${ollama}.json`, JSON.stringify({ log: ollamaLog, ...o.ollama }));
  writeFileSync(`${llama}.json`, JSON.stringify({ FAKE_LLAMA_LOG: llamaLog, FAKE_LLAMA_LOAD_MS: "300", ...o.llama }));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  app.services.scanOptions = { ports: {}, timeoutMs: 800 };
  app.poolNode.gpus = async () => [];
  const lib = localLibraryOf(app);
  // A pretend Mac with 16 GB (llama.cpp isn't asked for its GPUs).
  lib.ramBytes = () => 16 * 1024 ** 3;
  lib.unified = true;
  lib.devices = async () => [];
  app.store.kvSet("localModels.folder", join(dir, "models"));
  const model = join(dir, "models", "unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf");
  mkdirSync(join(model, ".."), { recursive: true });
  writeFileSync(model, qwenLike(1000));
  const runners = localRunnersOf(app);
  runners.find = () => [{ kind: "ollama", path: ollama, from: "Homebrew" }, { kind: "llamacpp", path: llama, from: "Homebrew" }];
  quick(runners);
  localModelsOf(app).run = nobody;
  cleanups.push(async () => {
    runners.shutdown();
    await lib.shutdown();
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, lib, runners, dir, ollama, llama, ollamaLog, llamaLog, model, modelId: "unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf" };
}
function quick(r: LocalRunners) {
  r.t.stepMs = 50;
  r.t.watchMs = 150;
  r.t.stopMs = 3000;
  r.t.startMs.ollama = 8000;
  r.t.startMs.llamacpp = 8000;
}
const state = (r: LocalRunners, id: string) => r.list().find((s) => s.id === id)?.state ?? null;
const pgid = (pid: number) => Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim());
const answers = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);

test("llama.cpp starts on its own with the chosen model, port and context, is listed as Crosstalk's, and Stop ends it", async () => {
  const { app, runners, dir, llamaLog, model, modelId } = setup();
  const port = freePort();
  const was = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-never-passed-on";
  const first = await runners.start({ kind: "llamacpp", port, model: modelId, context: 8192 }).finally(() => (was === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = was)));
  const id = `llamacpp-${port}`;
  expect(first).toMatchObject({ id, kind: "llamacpp", port, baseUrl: `http://127.0.0.1:${port}`, model: modelId, context: 8192, state: "starting", detail: "Loading the model…" });
  await until(() => logged(llamaLog).length === 1);
  const [run] = logged(llamaLog);
  // Every layer on the GPU: a Mac's.
  expect(run.argv).toEqual(["-m", model, "--host", "127.0.0.1", "--port", String(port), "-c", "8192", "-a", "qwen3-8b-q4_k_m", "-np", "1", "-ngl", "999"]);
  // From a folder of its own, in its own process group (so it outlives the hub), with a short environment.
  expect(run.cwd).toBe(realpathSync(join((runners as unknown as { deps: { runDir: string } }).deps.runDir, id)));
  expect(pgid(run.pid)).toBe(run.pid);
  expect(run.env.filter((k) => /KEY|TOKEN|CROSSTALK|FAKE/.test(k))).toEqual([]);
  await until(() => state(runners, id) === "running");
  expect(runners.list()[0]).toMatchObject({ state: "running", detail: null });

  // The scan finds it at its port, as Crosstalk's: Stop is offered.
  const view = await localModelsOf(app).list(true);
  const server = view.servers.find((s) => s.baseUrl === `http://127.0.0.1:${port}`)!;
  expect(server).toMatchObject({ kind: "llamacpp", startedId: id, stopWhy: null });
  expect(server.models.map((m) => m.id)).toEqual(["qwen3-8b-q4_k_m"]);
  // The model it serves can't be removed meanwhile.
  expect(runners.serving(model)).toBe(true);
  await expect(localLibraryOf(app).removeFile({ id: modelId })).rejects.toMatchObject({ status: 409 });

  expect(await runners.stop({ id })).toBeNull();
  expect(alive(run.pid)).toBe(false);
  expect(runners.list()).toEqual([]);
  expect(await answers(port, "/health")).toBe(false);
  expect(existsSync(join(dir, "models", "unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf"))).toBe(true);
});

test("Ollama: `ollama serve` on the chosen port of 127.0.0.1, and Stop ends it with the runners it started", async () => {
  const { runners, ollamaLog } = setup({ ollama: { runner: true } });
  const port = freePort();
  const id = `ollama-${port}`;
  await runners.start({ kind: "ollama", port });
  await until(() => logged(ollamaLog).length === 1);
  const [run] = logged(ollamaLog);
  expect(run.host).toBe(`127.0.0.1:${port}`);
  expect(run.runner).toBeGreaterThan(1);
  await until(() => state(runners, id) === "running");
  expect(await answers(port, "/api/version")).toBe(true);
  await runners.stop({ id });
  expect(alive(run.pid)).toBe(false);
  // The runner was in its process group: it went too.
  await until(() => !alive(run.runner!), 3000);
});

test("a restarted hub proves the servers it started are its own and can stop them; a note that doesn't hold up is forgotten, never signalled", async () => {
  const { dir, llama, llamaLog, modelId, lib } = setup();
  const runDir = join(dir, "run", "local-servers");
  const stateFile = join(dir, "run", "local-servers.json");
  const deps = { runDir, stateFile, hubPort: () => 0, model: (id: unknown) => lib.fileById(id) };
  const make = () => {
    const r = new LocalRunners(deps);
    r.find = () => [{ kind: "llamacpp", path: llama, from: "Homebrew" }];
    quick(r);
    cleanups.push(() => r.shutdown());
    return r;
  };
  const before = make();
  const port = freePort();
  const id = `llamacpp-${port}`;
  await before.start({ kind: "llamacpp", port, model: modelId });
  await until(() => logged(llamaLog).length === 1);
  const pid = logged(llamaLog)[0].pid;
  await until(() => state(before, id) === "running");
  expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual([expect.objectContaining({ id, kind: "llamacpp", port, pid, dir: join(runDir, id), model: modelId })]);
  // The hub stops: the server goes on.
  before.shutdown();
  expect(alive(pid)).toBe(true);

  const after = make();
  await after.ready();
  expect(after.list().map((s) => s.id)).toEqual([id]);
  await until(() => state(after, id) === "running");
  await after.stop({ id });
  expect(alive(pid)).toBe(false);
  expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual([]);

  // A process that isn't one of them, noted as if it were (its number reused, say): forgotten, and left running. (It runs
  // until it's ended, or until whoever started it has gone, as the stand-in servers do.)
  const idle = "const starter = process.ppid; setInterval(() => process.ppid === starter || process.exit(), 500)";
  const stranger = spawn(process.execPath, ["-e", idle], { cwd: dir, detached: true, stdio: "ignore" });
  writeFileSync(stateFile, JSON.stringify([
    { id: "llamacpp-1111", kind: "llamacpp", port: 1111, pid: stranger.pid, bin: llama, dir: join(runDir, "llamacpp-1111"), model: null, modelPath: null, context: null, startedAt: 1 },
    // A note pointing outside the hub's own folder proves nothing, nor one that climbs out of it, nor another run's folder.
    { id: "llamacpp-2222", kind: "llamacpp", port: 2222, pid: stranger.pid, bin: llama, dir, model: null, modelPath: null, context: null, startedAt: 1 },
    // (The stranger runs from the folder this one climbs out to.)
    { id: "llamacpp-3333", kind: "llamacpp", port: 3333, pid: stranger.pid, bin: llama, dir: `${runDir}/../../..`, model: null, modelPath: null, context: null, startedAt: 1 },
    { id: "ollama-5555", kind: "llamacpp", port: 5555, pid: stranger.pid, bin: llama, dir: join(runDir, "ollama-5555"), model: null, modelPath: null, context: null, startedAt: 1 },
  ]));
  const third = make();
  await third.ready();
  expect(third.list()).toEqual([]);
  await expect(third.stop({ id: "llamacpp-1111" })).rejects.toMatchObject({ status: 404 });
  expect(alive(stranger.pid!)).toBe(true);
  expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual([]);
});

test("servers Crosstalk didn't start are left alone, and say how to stop them where they run", async () => {
  const { app, runners, dir, llama, model } = setup();
  // A llama-server started from a terminal.
  const port = freePort();
  const own = spawn(llama, ["-m", model, "--host", "127.0.0.1", "--port", String(port)], { cwd: dir, detached: true, stdio: "ignore" });
  await until(() => answers(port, "/health"));
  const studio = fakeLmStudio();
  const ollama = fakeOllamaLive();
  cleanups.push(() => studio.stop(), () => ollama.stop());
  app.services.scanOptions = { ports: { [port]: "llamacpp", [studio.port]: "lmstudio", [ollama.port]: "ollama" }, timeoutMs: 800 };
  const view = await localModelsOf(app).list(true);
  const by = (p: number) => view.servers.find((s) => s.baseUrl === `http://127.0.0.1:${p}`) as LocalModelServer;
  expect(by(port)).toMatchObject({ startedId: null, stopWhy: "Crosstalk didn't start this server, so it leaves it alone: quit it where it was started." });
  expect(by(studio.port)).toMatchObject({ startedId: null, stopWhy: "LM Studio is managed in LM Studio: start and stop it there." });
  expect(by(ollama.port).stopWhy).toStartWith("Crosstalk didn't start this Ollama, so it leaves it alone:");
  expect(runners.stopWhy({ kind: "llamacpp", baseUrl: `http://127.0.0.1:${POOL_PORT}` }, POOL_PORT)).toBe("This is the model pool's server: stop it in Model pool.");
  // Asked to stop it anyway: refused, and it runs on.
  await expect(runners.stop({ id: `llamacpp-${port}` })).rejects.toMatchObject({ status: 404, message: "Crosstalk didn't start that server, so it leaves it alone. Press Rescan to see what runs." });
  expect(alive(own.pid!)).toBe(true);
  // Nor can one be started on its port.
  await expect(runners.start({ kind: "ollama", port })).rejects.toMatchObject({ status: 409, code: "port_taken", message: `Port ${port} is taken on this machine: pick another.` });
});

test("a start that fails says why in plain words, and is put away with Stop", async () => {
  const { runners, lib, dir } = setup({ ollama: { fail: "bind" } });
  const broken = join(dir, "models", "someone", "Broken-GGUF", "Broken-Q4_K_M.gguf");
  mkdirSync(join(broken, ".."), { recursive: true });
  writeFileSync(broken, "BROKEN, not a model");
  expect(lib.files().map((f) => f.id)).toContain("someone/Broken-GGUF/Broken-Q4_K_M.gguf");
  const port = freePort();
  await runners.start({ kind: "llamacpp", port, model: "someone/Broken-GGUF/Broken-Q4_K_M.gguf" });
  await until(() => state(runners, `llamacpp-${port}`) === "failed");
  expect(runners.list()[0].detail).toBe("llama.cpp couldn't load the model: download it again or pick another quant, then start again.");
  // Its port isn't held: the scan doesn't look there any more.
  expect(runners.ports()).toEqual({});
  expect(await runners.stop({ id: `llamacpp-${port}` })).toBeNull();
  expect(runners.list()).toEqual([]);

  const other = freePort();
  await runners.start({ kind: "ollama", port: other });
  await until(() => state(runners, `ollama-${other}`) === "failed");
  expect(runners.list()[0].detail).toMatch(new RegExp(`^It stopped while starting: Error: listen tcp 127\\.0\\.0\\.1:${other}: bind: address already in use\\. Start it again; if it keeps happening, look at its log: .+/ollama-${other}/server\\.log$`));
  // Trying again replaces it.
  await expect(runners.start({ kind: "ollama", port: other })).resolves.toMatchObject({ state: "starting" });
});

test("a server that doesn't answer in time is stopped, and one that stops by itself says so", async () => {
  const { runners, ollamaLog } = setup({ ollama: { startMs: 60_000 } });
  runners.t.startMs.ollama = 1500;
  const port = freePort();
  await runners.start({ kind: "ollama", port });
  await until(() => logged(ollamaLog).length === 1);
  const slow = logged(ollamaLog)[0].pid;
  await until(() => state(runners, `ollama-${port}`) === "failed", 8000);
  expect(runners.list()[0].detail).toMatch(/^It didn't answer within 2 seconds, so it was stopped\. Its log: .+server\.log$/);
  expect(alive(slow)).toBe(false);

  const { runners: r2, ollamaLog: log2 } = setup();
  const p2 = freePort();
  await r2.start({ kind: "ollama", port: p2 });
  await until(() => state(r2, `ollama-${p2}`) === "running");
  const pid = logged(log2)[0].pid;
  process.kill(pid, "SIGTERM");
  await until(() => state(r2, `ollama-${p2}`) === "failed");
  // Ollama ends cleanly when it's quit, so there's no more to say than that it stopped.
  expect(r2.list()[0].detail).toMatch(/^It stopped\. Start it again; if it keeps happening, look at its log: .+server\.log$/);
});

test("what a start needs: the program, a free port that isn't the hub's, a model in the folder and a sensible context", async () => {
  const { app, runners, modelId } = setup();
  const port = freePort();
  await expect(runners.start({ kind: "vllm" })).rejects.toMatchObject({ status: 400, message: "Say which server to start: Ollama or llama.cpp." });
  await expect(runners.start({ kind: "ollama", port: 80 })).rejects.toMatchObject({ status: 400, message: "Pick a port from 1024 to 65535." });
  await expect(runners.start({ kind: "ollama", port: 1.5 })).rejects.toMatchObject({ status: 400 });
  app.config.port = port;
  await expect(runners.start({ kind: "ollama", port })).rejects.toMatchObject({ status: 409, message: `Port ${port} is the hub's own: pick another.` });
  app.config.port = 0;
  await expect(runners.start({ kind: "llamacpp", port })).rejects.toMatchObject({ status: 400, message: "Pick the model llama.cpp should serve." });
  await expect(runners.start({ kind: "llamacpp", port, model: "a/b/c.gguf" })).rejects.toMatchObject({ status: 404 });
  await expect(runners.start({ kind: "llamacpp", port, model: modelId, context: 100 })).rejects.toMatchObject({ status: 400, message: "Pick a context from 2,048 to 1,048,576 tokens." });
  runners.portFree = () => false;
  await expect(runners.start({ kind: "ollama", port })).rejects.toMatchObject({ status: 409, code: "port_taken" });
  // Two starts on one port at once (two phones, say): the second is turned down while the first checks the port.
  let free: (v: boolean) => void = () => {};
  runners.portFree = () => new Promise<boolean>((done) => (free = done));
  const first = runners.start({ kind: "ollama", port });
  await Bun.sleep(20);
  await expect(runners.start({ kind: "ollama", port })).rejects.toMatchObject({ status: 409, code: "port_taken", message: `A server is already starting on port ${port}.` });
  free(false);
  await expect(first).rejects.toMatchObject({ status: 409, message: `Port ${port} is taken on this machine: pick another.` });
  runners.portFree = () => true;
  runners.find = () => [];
  const missing = await runners.start({ kind: "llamacpp", port, model: modelId }).catch((e) => e);
  expect(missing).toMatchObject({ status: 409, code: "no_program" });
  expect(missing.message).toStartWith("llama.cpp isn't installed on this machine:");
  await expect(runners.start({ kind: "ollama", port })).rejects.toMatchObject({ status: 409, code: "no_program", message: "Ollama isn't installed on this machine: get it at ollama.com/download, then press Rescan." });
});

test("free ports: each program's own when it's free, else the next free one (never the hub's or the pool's)", async () => {
  const { app, runners } = setup();
  const taken = new Set([11434, 11435, 8080]);
  runners.portFree = (p) => !taken.has(p);
  expect(await runners.freePorts()).toEqual({ ollama: 11436, llamacpp: 8081 });
  app.config.port = 8081;
  expect((await runners.freePorts()).llamacpp).toBe(8082);
});

test("where the programs are looked for: the folders CROSSTALK_LOCAL_PROGRAMS names, and nowhere for test hubs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-programs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  installScript("fake-ollama", join(dir, "ollama"));
  installScript("fake-llama-server", join(dir, "llama-server"));
  const was = { only: process.env.CROSSTALK_LOCAL_PROGRAMS, none: process.env.CROSSTALK_NO_AGENT_CLIS };
  cleanups.push(() => {
    for (const [k, v] of [["CROSSTALK_LOCAL_PROGRAMS", was.only], ["CROSSTALK_NO_AGENT_CLIS", was.none]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.CROSSTALK_LOCAL_PROGRAMS = `/nowhere:${dir}`;
  expect(findPrograms(true)).toEqual([{ kind: "ollama", path: join(dir, "ollama"), from: dir }, { kind: "llamacpp", path: join(dir, "llama-server"), from: dir }]);
  process.env.CROSSTALK_LOCAL_PROGRAMS = "";
  expect(findPrograms(false)).toEqual([]);
  delete process.env.CROSSTALK_LOCAL_PROGRAMS;
  expect(findPrograms(true)).toEqual([]);
  process.env.CROSSTALK_NO_AGENT_CLIS = "1";
  expect(findPrograms(false)).toEqual([]);
  // An in-memory hub (every test hub) looks nowhere.
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(async () => {
    await app.engine.shutdown();
    app.store.close();
  });
  delete process.env.CROSSTALK_NO_AGENT_CLIS;
  expect(localRunnersOf(app).programs()).toEqual([]);
});

test("the routes: start and stop answer the library; refusals in plain words", async () => {
  const { app, runners, modelId } = setup();
  const server = startServer(app);
  cleanups.push(() => void server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as LibraryView & { error?: string } };
  };
  expect((await fetch(`${base}/api/local-models/start`, { method: "POST" })).status).toBe(401);
  const port = freePort();
  const on = await call("POST", "/api/local-models/start", { kind: "llamacpp", port, model: modelId });
  expect(on.status).toBe(200);
  expect(on.body.started).toEqual([expect.objectContaining({ id: `llamacpp-${port}`, state: "starting" })]);
  expect(on.body.programs.map((p) => p.kind)).toEqual(["ollama", "llamacpp"]);
  await until(() => state(runners, `llamacpp-${port}`) === "running");
  const again = await call("POST", "/api/local-models/start", { kind: "llamacpp", port, model: modelId });
  expect(again).toEqual({ status: 409, body: { error: `llama.cpp is already running on port ${port}.`, code: "port_taken" } as never });
  const off = await call("POST", "/api/local-models/stop", { id: `llamacpp-${port}` });
  expect(off.status).toBe(200);
  expect(off.body.started).toEqual([]);
  expect((await call("POST", "/api/local-models/stop", { id: "llamacpp-1" })).status).toBe(404);
  expect((await call("POST", "/api/local-models/start", {})).status).toBe(400);
});

test("a model trained for less than the context asked for starts with its own (the cache the page counted), and a PC's GPU too small for it is left to llama.cpp", async () => {
  const { app, runners, lib, dir, llamaLog } = setup();
  const short = join(dir, "models", "meta", "Llama-3-8B-GGUF", "Llama-3-8B-Q8_0.gguf");
  mkdirSync(join(short, ".."), { recursive: true });
  writeFileSync(short, ggufBytes([["general.architecture", "llama"], ["llama.block_count", 32], ["llama.embedding_length", 4096], ["llama.attention.head_count", 32], ["llama.attention.head_count_kv", 8], ["llama.context_length", 8192]]));
  const port = freePort();
  const on = await runners.start({ kind: "llamacpp", port, model: "meta/Llama-3-8B-GGUF/Llama-3-8B-Q8_0.gguf", context: 32768 });
  expect(on.context).toBe(8192);
  await until(() => logged(llamaLog).length === 1);
  expect(logged(llamaLog)[0].argv!.slice(6, 8)).toEqual(["-c", "8192"]);
  await runners.stop({ id: `llamacpp-${port}` });

  // A PC with an 8 GB GPU and a model that needs more: no -ngl, so llama.cpp puts what doesn't fit on the processor (the page says Slow).
  lib.unified = false;
  lib.devices = async () => [{ name: "CUDA0", description: "NVIDIA GeForce RTX 3070", totalMiB: 8192, freeMiB: 2048 }];
  await lib.machine(true);
  const other = freePort();
  await runners.start({ kind: "llamacpp", port: other, model: "meta/Llama-3-8B-GGUF/Llama-3-8B-Q8_0.gguf" });
  await until(() => logged(llamaLog).length === 2);
  expect(logged(llamaLog)[1].argv).not.toContain("-ngl");
  void app;
});

test("where llama.cpp puts the layers: all on a Mac's GPU, all on a PC's that holds the model, else llama.cpp decides", () => {
  const GiB = 1024 ** 3;
  expect(gpuLayers({ unified: true, gpuBytes: 12 * GiB }, 20 * GiB)).toEqual(["-ngl", "999"]);
  expect(gpuLayers({ unified: false, gpuBytes: 16 * GiB }, 10 * GiB)).toEqual(["-ngl", "999"]);
  expect(gpuLayers({ unified: false, gpuBytes: 8 * GiB }, 10 * GiB)).toEqual([]);
  expect(gpuLayers({ unified: false, gpuBytes: null }, GiB)).toEqual([]);
  expect(gpuLayers(null, GiB)).toEqual([]);
});

test("Ollama started while a pull waits keeps the pull's part (OLLAMA_NOPRUNE); otherwise it clears what it likes", async () => {
  const { runners, lib, ollamaLog } = setup();
  const waiting = freePort();
  lib.pullsWaiting = () => true;
  await runners.start({ kind: "ollama", port: waiting });
  await until(() => logged(ollamaLog).length === 1);
  expect(logged(ollamaLog)[0].env).toContain("OLLAMA_NOPRUNE");
  lib.pullsWaiting = () => false;
  const plain = freePort();
  await runners.start({ kind: "ollama", port: plain });
  await until(() => logged(ollamaLog).length === 2);
  expect(logged(ollamaLog)[1].env).not.toContain("OLLAMA_NOPRUNE");
});

test("a start that didn't answer in time and didn't stop stays Crosstalk's, says so, and Stop can try again", async () => {
  const { runners, ollamaLog } = setup({ ollama: { startMs: 60_000 } });
  runners.t.startMs.ollama = 1500;
  // It won't end (stuck reading a drive that went away, say).
  const real = (runners as unknown as { end: (r: unknown) => Promise<boolean> }).end.bind(runners);
  (runners as unknown as { end: () => Promise<boolean> }).end = async () => false;
  const port = freePort();
  const id = `ollama-${port}`;
  await runners.start({ kind: "ollama", port });
  await until(() => logged(ollamaLog).length === 1);
  const pid = logged(ollamaLog)[0].pid;
  await until(() => !!runners.list()[0]?.detail?.includes("didn't stop"));
  expect(runners.list()[0]).toMatchObject({ id, state: "starting", detail: "It didn't answer within 2 seconds and didn't stop: try again, or end it on this machine." });
  expect(runners.ports()).toEqual({ [port]: "ollama" });
  expect(alive(pid)).toBe(true);
  // Stop ends it once it can.
  (runners as unknown as { end: (r: unknown) => Promise<boolean> }).end = real;
  expect(await runners.stop({ id })).toBeNull();
  expect(alive(pid)).toBe(false);
});

test("a port is free only when a server can have it to itself: nothing bound to 127.0.0.1, and nothing answering at 127.0.0.1 or ::1", async () => {
  // Test hubs only bind (they look for no model servers on this machine): asked to connect too, as a real hub does.
  const port = freePort();
  expect(await loopbackFree(port, true)).toBe(true);
  const four = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  cleanups.push(() => four.stop(true));
  expect(await loopbackFree(port, true)).toBe(false);
  expect(await loopbackFree(port)).toBe(false);
  // A listener the 127.0.0.1 bind doesn't see, as on a Mac one on every address (0.0.0.0 or ::) isn't: it answers, so it's taken.
  const six = (() => {
    try {
      return Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    } catch {
      return null; // No IPv6 here.
    }
  })();
  if (six) {
    cleanups.push(() => six.stop(true));
    expect(await loopbackFree(six.port, true)).toBe(false);
    // A test hub doesn't connect, so it can't tell (and never reaches what runs here).
    expect(await loopbackFree(six.port)).toBe(true);
  }
});
