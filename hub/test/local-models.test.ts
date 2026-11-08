import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalModelServer, LocalModelSwitch } from "@crosstalk/shared";
import { App } from "../src/app";
import { localModelsOf, onThisMachine, pidsIn, processMemory, processTable, treeBytes, type Runner } from "../src/localModels";
import { startServer } from "../src/server";
import { fakeLlamaRouter, fakeOllamaLive } from "./fixtures/fake-local-models";
import { fakeLmStudio, fakeService, type Fake } from "./fixtures/fake-services";

// Settings → Local models (docs/SPEC-0.5.md, T10), against stand-in servers on port 0 and a pretend lsof and ps: nothing here
// runs a model, reads this machine's real processes or looks beyond 127.0.0.1. setup() gives every test a pretend machine (no
// listeners at all); a test that needs memory figures gives its own. A real lsof or ps started anywhere in this file fails the test
// (anything else that is started is none of this file's business and runs as it would).

const cleanups: (() => void | Promise<void>)[] = [];
const spawned: string[][] = [];
const realSpawn = Bun.spawn as (...args: unknown[]) => unknown;
beforeEach(() => {
  spawned.length = 0;
  (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
    const cmd = args[0] as string[] | { cmd: string[] };
    const argv = Array.isArray(cmd) ? cmd : cmd.cmd;
    if (!/(^|\/)(lsof|ps)$/.test(argv[0])) return realSpawn.apply(Bun, args);
    spawned.push(argv);
    throw new Error("a test started a real lsof or ps");
  };
});
afterEach(async () => {
  (Bun as { spawn: unknown }).spawn = realSpawn;
  for (const c of cleanups.splice(0).reverse()) await c();
  expect(spawned).toEqual([]);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ct-localmodels-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  const lm = localModelsOf(app);
  lm.run = machine({});
  lm.pollMs = 20;
  lm.limitMs = 3000;
  cleanups.push(async () => {
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, lm };
}
const keep = <T extends Fake>(f: T): T => {
  cleanups.push(() => f.stop());
  return f;
};

/** What lsof and ps would say: who listens on which port (a process number per port), and the process table (pid, parent, kilobytes). */
function machine(listeners: Record<number, number[]>, table = ""): Runner & { asked: string[][] } {
  const asked: string[][] = [];
  const run = Object.assign(
    async (argv: string[]) => {
      asked.push(argv);
      const port = argv.find((a) => a.startsWith("-iTCP:"))?.slice("-iTCP:".length);
      if (port) return (listeners[Number(port)] ?? []).join("\n");
      return argv.includes("pid=,ppid=,rss=") ? table : null;
    },
    { asked },
  );
  return run;
}
const looks = (app: App, ports: Record<number, "ollama" | "lmstudio" | "llamacpp" | "mlx" | "other">) => (app.services.scanOptions = { ports, timeoutMs: 800 });
const sentTo = (f: Fake, path: string) => f.seen.filter((s) => s.method === "POST" && s.path === path).map((s) => JSON.parse(s.body));
const by = (s: LocalModelServer, id: string) => s.models.find((m) => m.id === id)!;
/** Waits (up to 3 seconds) until something a fake server does has happened. */
const until = async (done: () => boolean) => {
  for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(10);
  expect(done()).toBe(true);
};

test("memory of a server's processes: who listens, then what they and what they started hold; null when it can't be told", async () => {
  const table = processTable(["    1     0   20240", "  100     1  102400", "  101   100 6000000", "  102   101   50000", "  200     1  999999", "  300     1   30000", "not a row", ""].join("\n"));
  // The listener and what it started (a child and its child), each once, and nothing else.
  expect(treeBytes(table, [100])).toBe((102400 + 6000000 + 50000) * 1024);
  expect(treeBytes(table, [100, 101])).toBe((102400 + 6000000 + 50000) * 1024);
  expect(treeBytes(table, [300])).toBe(30000 * 1024);
  expect(treeBytes(table, [999])).toBeNull();
  expect(treeBytes(table, [])).toBeNull();
  expect(treeBytes(processTable("5 5 100\n"), [5])).toBe(100 * 1024); // its own parent: no loop
  expect(pidsIn("123\n123\n456\n1\n0\nnope\n")).toEqual([123, 456]);
  expect(processTable("  7  1  oops\n  8  1  64\n").size).toBe(1);

  const text = "  100     1  102400\n  101   100 6000000\n  300     1   30000\n";
  const run = machine({ 11434: [100], 1234: [], 9931: [300] }, text);
  const memory = await processMemory([11434, 1234, 9931], run);
  expect([...memory]).toEqual([[11434, (102400 + 6000000) * 1024], [1234, null], [9931, 30000 * 1024]]);
  // Each port was asked who listens (lsof -t on that port, nothing else), and the process table once.
  expect(run.asked.filter((a) => a.some((x) => x.startsWith("-iTCP:"))).map((a) => a.slice(1))).toEqual([["-nP", "-iTCP:11434", "-sTCP:LISTEN", "-t"], ["-nP", "-iTCP:1234", "-sTCP:LISTEN", "-t"], ["-nP", "-iTCP:9931", "-sTCP:LISTEN", "-t"]]);
  expect(run.asked.filter((a) => a.includes("pid=,ppid=,rss=")).length).toBe(1);
  // Nobody listens: ps isn't asked. No lsof on the machine, or no ps: it can't be told.
  const nobody = machine({}, text);
  expect([...(await processMemory([11434], nobody))]).toEqual([[11434, null]]);
  expect(nobody.asked.some((a) => a.includes("pid=,ppid=,rss="))).toBe(false);
  expect([...(await processMemory([11434], async () => null))]).toEqual([[11434, null]]);
  expect([...(await processMemory([11434], async (argv) => (argv.some((a) => a.startsWith("-iTCP:")) ? "100" : null)))]).toEqual([[11434, null]]);
});

test("the list: the server's memory, each model loaded or not, what the server says it holds and when it frees it", async () => {
  const { app, lm } = setup();
  const ollama = keep(
    fakeOllamaLive({
      models: [
        { name: "qwen3:8b", size: 6_100_000_000, loaded: true, expiresInMs: 4 * 60_000 },
        { name: "gemma3:12b", size: 8_100_000_000, vram: 5_000_000_000, loaded: true, expiresInMs: 10 * 60_000 },
        { name: "llama3.2:3b", size: 2_019_393_189 },
      ],
    }),
  );
  looks(app, { [ollama.port]: "ollama" });
  // Ollama's own processes hold little (its models run in processes of their own): the models' memory is the larger.
  lm.run = machine({ [ollama.port]: [100] }, "  100     1  200000\n  101   100 3000000\n");
  const before = Date.now();
  const { servers, scannedAt } = await lm.list();
  expect(scannedAt).toBeGreaterThanOrEqual(before - 5);
  const s = servers[0];
  expect(s).toMatchObject({ id: `ollama-${ollama.port}`, kind: "ollama", baseUrl: ollama.url, accountIds: [], processBytes: 3_200_000 * 1024, memoryBytes: 14_200_000_000 });
  expect(by(s, "qwen3:8b")).toMatchObject({ loaded: true, loading: false, contextWindow: 4096, sizeBytes: 6_100_000_000, memoryBytes: 6_100_000_000, vramBytes: 6_100_000_000, canSwitch: true, why: null });
  expect(by(s, "qwen3:8b").expiresAt!).toBeGreaterThan(before + 3 * 60_000);
  expect(by(s, "qwen3:8b").expiresAt!).toBeLessThan(before + 5 * 60_000);
  expect(by(s, "gemma3:12b")).toMatchObject({ loaded: true, memoryBytes: 8_100_000_000, vramBytes: 5_000_000_000 });
  expect(by(s, "llama3.2:3b")).toEqual({ id: "llama3.2:3b", loaded: false, loading: false, contextWindow: null, sizeBytes: 2_019_393_189, memoryBytes: null, vramBytes: null, expiresAt: null, canSwitch: true, why: null });

  // Processes that hold more than the models say (a model in a process Crosstalk can't see, the server's own cache) are the answer then.
  lm.run = machine({ [ollama.port]: [100] }, "  100     1  20000000\n");
  expect((await lm.list(true)).servers[0]).toMatchObject({ processBytes: 20_000_000 * 1024, memoryBytes: 20_000_000 * 1024 });
  // Nothing found about the processes: what the models say.
  lm.run = machine({});
  expect((await lm.list(true)).servers[0]).toMatchObject({ processBytes: null, memoryBytes: 14_200_000_000 });

  // What a server says is read again each time, within the hub's remembered scan: a model loaded meanwhile shows.
  await fetch(`${ollama.url}/api/generate`, { method: "POST", body: JSON.stringify({ model: "llama3.2:3b", keep_alive: "30m" }) });
  const again = await lm.list();
  expect(by(again.servers[0], "llama3.2:3b")).toMatchObject({ loaded: true, memoryBytes: 2_019_393_189 });

  // A model kept for ever (Ollama shows a date centuries away, or its zero time) has no time to be freed.
  for (const expiresAt of ["2318-06-23T10:00:00Z", "0001-01-01T00:00:00Z"]) {
    const kept = keep(fakeOllamaLive({ expiresAt }));
    looks(app, { [kept.port]: "ollama" });
    expect(by((await lm.list(true)).servers[0], "qwen3:8b")).toMatchObject({ loaded: true, expiresAt: null });
  }
});

test("turning an Ollama model off frees it and on loads it, with keep_alive and no prompt, and answers the server as it is then", async () => {
  const { app, lm } = setup();
  const ollama = keep(fakeOllamaLive({ unloadMs: 120 }));
  looks(app, { [ollama.port]: "ollama" });
  lm.run = machine({ [ollama.port]: [100] }, "  100     1  100000\n");
  const id = `ollama-${ollama.port}`;

  const started = Date.now();
  const off = await lm.switch({ serverId: id, model: "qwen3:8b", on: false });
  // Ollama frees a model a moment after it says so: the answer waits until it's really gone.
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(sentTo(ollama, "/api/generate")).toEqual([{ model: "qwen3:8b", keep_alive: 0 }]);
  expect(ollama.loaded()).toEqual([]);
  expect(by(off, "qwen3:8b")).toMatchObject({ loaded: false, memoryBytes: null, expiresAt: null });
  expect(off.memoryBytes).toBe(100_000 * 1024);

  const before = Date.now();
  const on = await lm.switch({ serverId: id, model: "llama3.2:3b", on: true });
  expect(sentTo(ollama, "/api/generate")).toEqual([{ model: "qwen3:8b", keep_alive: 0 }, { model: "llama3.2:3b", keep_alive: "30m" }]);
  expect(ollama.loaded()).toEqual(["llama3.2:3b"]);
  expect(by(on, "llama3.2:3b")).toMatchObject({ loaded: true, memoryBytes: 2_019_393_189, vramBytes: 2_019_393_189 });
  // It frees itself in 30 minutes, which the page can say.
  expect(by(on, "llama3.2:3b").expiresAt!).toBeGreaterThan(before + 29 * 60_000);
  expect(by(on, "llama3.2:3b").expiresAt!).toBeLessThan(before + 31 * 60_000);
  expect(on.memoryBytes).toBe(2_019_393_189);

  // Already as asked: nothing is sent.
  await lm.switch({ serverId: id, model: "llama3.2:3b", on: true });
  await lm.switch({ serverId: id, model: "qwen3:8b", on: false });
  expect(sentTo(ollama, "/api/generate").length).toBe(2);

  // Never a model request: the only POSTs are the scan's empty probes and those two documented bodies (no prompt, no messages).
  for (const p of ollama.seen.filter((s) => s.method === "POST")) {
    if (p.path === "/api/generate") expect(Object.keys(JSON.parse(p.body)).sort()).toEqual(["keep_alive", "model"]);
    else expect(p.body).toBe("{}");
  }
});

test("a switch that doesn't work says why in plain words and leaves the model as it was", async () => {
  const { app, lm } = setup();
  const id = (f: Fake) => `ollama-${f.port}`;

  // Ollama refuses (here for lack of memory): its own words.
  const full = keep(fakeOllamaLive({ generate: "error" }));
  looks(app, { [full.port]: "ollama" });
  await expect(lm.switch({ serverId: id(full), model: "llama3.2:3b", on: true })).rejects.toMatchObject({
    status: 502,
    message: "Ollama couldn't load llama3.2:3b: model requires more system memory (28.4 GiB) than is available (9.1 GiB).",
  });
  expect(full.loaded()).toEqual(["qwen3:8b"]);

  // It says ok and changes nothing: given up on after the limit.
  lm.limitMs = 400;
  const stuck = keep(fakeOllamaLive({ generate: "ignore" }));
  looks(app, { [stuck.port]: "ollama" });
  const t0 = Date.now();
  await expect(lm.switch({ serverId: id(stuck), model: "qwen3:8b", on: false })).rejects.toMatchObject({ status: 504, message: "Ollama didn't finish within 1 second. It may still be working: press Rescan in a moment to see." });
  expect(Date.now() - t0).toBeLessThan(2500);
  // Never answers at all: the same.
  const hung = keep(fakeOllamaLive({ generate: "hang" }));
  looks(app, { [hung.port]: "ollama" });
  await expect(lm.switch({ serverId: id(hung), model: "qwen3:8b", on: false })).rejects.toMatchObject({ status: 504 });

  // The server goes away while it's switching.
  lm.limitMs = 3000;
  const going = keep(fakeOllamaLive({ generate: "drop" }));
  looks(app, { [going.port]: "ollama" });
  await expect(lm.switch({ serverId: id(going), model: "qwen3:8b", on: false })).rejects.toMatchObject({
    status: 502,
    message: `Couldn't reach Ollama at 127.0.0.1:${going.port} any more. Check that it's still running, then press Rescan.`,
  });
  // Gone before the switch: the server isn't there to be found.
  await expect(lm.switch({ serverId: id(going), model: "qwen3:8b", on: false })).rejects.toMatchObject({ status: 404, message: "That server isn't running any more. Press Rescan to see what is." });

  // Not a model of that server, and a request that doesn't say what to switch.
  const ok = keep(fakeOllamaLive());
  looks(app, { [ok.port]: "ollama" });
  await expect(lm.switch({ serverId: id(ok), model: "nope:1b", on: true })).rejects.toMatchObject({ status: 404, message: "Ollama doesn't list nope:1b any more. Press Rescan to see what it has." });
  for (const bad of [null, {}, { serverId: id(ok), model: "qwen3:8b" }, { serverId: id(ok), model: "", on: true }, { serverId: 5, model: "qwen3:8b", on: true }, { serverId: id(ok), model: "qwen3:8b", on: "yes" }]) {
    await expect(lm.switch(bad)).rejects.toMatchObject({ status: 400 });
  }
  expect(sentTo(ok, "/api/generate")).toEqual([]);
});

test("LM Studio, vLLM, mlx-lm and others are listed with what's loaded, but are switched in their own programs", async () => {
  const { app, lm } = setup();
  const studio = keep(fakeLmStudio());
  const vllm = keep(fakeService({ list: [{ id: "meta-llama/Llama-3.1-8B", owned_by: "vllm", max_model_len: 32768 }], routes: ["responses", "chat"] }));
  const mlx = keep(fakeService({ list: [{ id: "mlx-community/Qwen3-4B-4bit" }], routes: ["chat"] }));
  const single = keep(fakeLlamaRouter({ single: true, models: [{ id: "qwen3.8-27b", loaded: true }] }));
  looks(app, { [studio.port]: "lmstudio", [vllm.port]: "other", [mlx.port]: "mlx", [single.port]: "llamacpp" });
  lm.run = machine({ [studio.port]: [100] }, "  100     1  800000\n  101   100  400000\n");
  const { servers } = await lm.list();
  const kind = (k: string) => servers.find((s) => s.kind === k)!;

  const s = kind("lmstudio");
  expect(s).toMatchObject({ processBytes: 1_200_000 * 1024, memoryBytes: 1_200_000 * 1024 });
  expect(by(s, "qwen2.5-coder-7b")).toMatchObject({ loaded: true, memoryBytes: null, contextWindow: 8192, canSwitch: false, why: "LM Studio is switched in its own app." });
  expect(by(s, "gemma-3-12b")).toMatchObject({ loaded: false, canSwitch: false });
  expect(by(kind("vllm"), "meta-llama/Llama-3.1-8B")).toMatchObject({ loaded: true, canSwitch: false, why: "vLLM keeps its model loaded while it runs. Quit it on this machine to free its memory." });
  // mlx-lm doesn't say what it has loaded.
  expect(by(kind("mlx"), "mlx-community/Qwen3-4B-4bit")).toMatchObject({ loaded: null, canSwitch: false });
  expect(by(kind("mlx"), "mlx-community/Qwen3-4B-4bit").why).toContain("mlx-lm doesn't say which model it has loaded");
  // One llama.cpp model, chosen when it started (it answers /models too, with no status): not a router.
  expect(by(kind("llamacpp"), "qwen3.8-27b")).toMatchObject({ loaded: true, canSwitch: false, why: "This llama.cpp server holds one model, chosen when it started. Quit it on this machine to free its memory." });

  // A switch is refused in the same words and nothing is sent to the server.
  await expect(lm.switch({ serverId: s.id, model: "qwen2.5-coder-7b", on: false })).rejects.toMatchObject({ status: 409, message: "LM Studio is switched in its own app." });
  await expect(lm.switch({ serverId: kind("llamacpp").id, model: "qwen3.8-27b", on: false })).rejects.toMatchObject({ status: 409 });
  for (const f of [studio, single]) expect(f.seen.filter((x) => x.method === "POST").every((x) => x.body === "{}")).toBe(true);
});

test("llama.cpp in router mode: its models are loaded and freed with /models/load and /models/unload, and the answer waits until it says so", async () => {
  const { app, lm } = setup();
  const router = keep(fakeLlamaRouter({ loadMs: 150 }));
  looks(app, { [router.port]: "llamacpp" });
  // Each model runs in a process the router started: they count with it.
  lm.run = machine({ [router.port]: [100] }, "  100     1   50000\n  101   100 4000000\n");
  const id = `llamacpp-${router.port}`;
  const gemma = "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M";
  const qwen = "unsloth/Qwen3-8B-GGUF:Q4_K_M";

  const first = (await lm.list()).servers[0];
  expect(first).toMatchObject({ kind: "llamacpp", processBytes: 4_050_000 * 1024, memoryBytes: 4_050_000 * 1024 });
  expect(by(first, gemma)).toMatchObject({ loaded: true, loading: false, canSwitch: true, why: null });
  expect(by(first, qwen)).toMatchObject({ loaded: false, loading: false, canSwitch: true });

  const off = await lm.switch({ serverId: id, model: gemma, on: false });
  expect(sentTo(router, "/models/unload")).toEqual([{ model: gemma }]);
  expect(by(off, gemma).loaded).toBe(false);
  const started = Date.now();
  const on = await lm.switch({ serverId: id, model: qwen, on: true });
  // The router answers at once and loads in the background ("loading"): the answer is the server once it has loaded.
  expect(Date.now() - started).toBeGreaterThanOrEqual(120);
  expect(sentTo(router, "/models/load")).toEqual([{ model: qwen }]);
  expect(by(on, qwen)).toMatchObject({ loaded: true, loading: false });
  expect(router.status()).toEqual({ [gemma]: "unloaded", [qwen]: "loaded" });
  for (const p of router.seen.filter((s) => s.method === "POST" && !s.path.startsWith("/models/"))) expect(p.body).toBe("{}");

  // One that is loading when the list is read says so (and its switch isn't offered by the page meanwhile).
  const slow = keep(fakeLlamaRouter({ loadMs: 800 }));
  looks(app, { [slow.port]: "llamacpp" });
  const loading = lm.switch({ serverId: `llamacpp-${slow.port}`, model: qwen, on: true });
  await until(() => slow.status()[qwen] === "loading");
  expect(by((await lm.list(true)).servers[0], qwen)).toMatchObject({ loaded: false, loading: true });
  await loading;

  // A load the router couldn't finish says so.
  const broken = keep(fakeLlamaRouter({ failLoad: true }));
  looks(app, { [broken.port]: "llamacpp" });
  await expect(lm.switch({ serverId: `llamacpp-${broken.port}`, model: qwen, on: true })).rejects.toMatchObject({
    status: 502,
    message: `llama.cpp couldn't load ${qwen}: it stopped while loading (exit code 1). Look at its log.`,
  });
  // The router's own refusal is passed on, in its words.
  const refusing = keep(fakeLlamaRouter({ refuse: "model is busy" }));
  looks(app, { [refusing.port]: "llamacpp" });
  await expect(lm.switch({ serverId: `llamacpp-${refusing.port}`, model: qwen, on: true })).rejects.toMatchObject({ status: 502, message: `llama.cpp couldn't load ${qwen}: model is busy.` });
  // A model already loading is waited for, not asked for again.
  const waiting = keep(fakeLlamaRouter({ loadMs: 300 }));
  looks(app, { [waiting.port]: "llamacpp" });
  void fetch(`${waiting.url}/models/load`, { method: "POST", body: JSON.stringify({ model: qwen }) });
  await until(() => waiting.status()[qwen] === "loading");
  const waited = await lm.switch({ serverId: `llamacpp-${waiting.port}`, model: qwen, on: true });
  expect(by(waited, qwen)).toMatchObject({ loaded: true, loading: false });
  expect(sentTo(waiting, "/models/load")).toHaveLength(1);
});

test("one switch per model at a time; other models can switch meanwhile", async () => {
  const { app, lm } = setup();
  const ollama = keep(fakeOllamaLive({ loadMs: 300 }));
  looks(app, { [ollama.port]: "ollama" });
  const id = `ollama-${ollama.port}`;
  const first = lm.switch({ serverId: id, model: "llama3.2:3b", on: true });
  await expect(lm.switch({ serverId: id, model: "llama3.2:3b", on: false })).rejects.toMatchObject({ status: 409, message: "llama3.2:3b is being switched already. Wait for that to finish." });
  const other = lm.switch({ serverId: id, model: "qwen3:8b", on: false });
  await Promise.all([first, other]);
  expect(sentTo(ollama, "/api/generate")).toHaveLength(2);
  expect(sentTo(ollama, "/api/generate")).toEqual(expect.arrayContaining([{ model: "llama3.2:3b", keep_alive: "30m" }, { model: "qwen3:8b", keep_alive: 0 }]));
  // Once it has finished (or failed), the model can be switched again.
  await lm.switch({ serverId: id, model: "llama3.2:3b", on: false });
  expect(ollama.loaded()).toEqual([]);
});

test("a load that takes longer than the limit isn't cut off: the answer says it's still loading, and the load finishes by itself", async () => {
  const { app, lm } = setup();
  // Like Ollama, this one drops a load when the request that asked for it ends.
  const ollama = keep(fakeOllamaLive({ loadMs: 1000, cancelOnClose: true }));
  looks(app, { [ollama.port]: "ollama" });
  lm.limitMs = 300;
  const id = `ollama-${ollama.port}`;
  const model = "llama3.2:3b";
  const move = (name: string, on: boolean) => lm.switch({ serverId: id, model: name, on });

  const t0 = Date.now();
  await expect(move(model, true)).rejects.toMatchObject({ status: 504, message: `Ollama is still loading ${model}. A big model can take a minute or more: press Rescan in a moment to see.` });
  expect(Date.now() - t0).toBeLessThan(900); // the answer came at the limit, not when the model was in memory
  expect(ollama.loaded()).toEqual(["qwen3:8b"]);
  // Meanwhile it says it's loading (the page looks again until it has), a second tap is told so instead of starting another load, and other models can be switched.
  expect(by((await lm.list(true)).servers[0], model)).toMatchObject({ loaded: false, loading: true });
  await expect(move(model, true)).rejects.toMatchObject({ status: 409, message: `${model} is still loading. Press Rescan in a moment to see.` });
  await expect(move(model, false)).rejects.toMatchObject({ status: 409 });
  expect(by(await move("qwen3:8b", false), "qwen3:8b").loaded).toBe(false);

  // Nothing cut the load: it finishes after the answer, and then the model can be switched again.
  await until(() => ollama.loaded().includes(model));
  expect(ollama.cancelled()).toEqual([]);
  expect(sentTo(ollama, "/api/generate")).toEqual([{ model, keep_alive: "30m" }, { model: "qwen3:8b", keep_alive: 0 }]);
  let done = (await lm.list(true)).servers[0];
  for (let i = 0; i < 100 && by(done, model).loading; i++) {
    await Bun.sleep(20);
    done = (await lm.list(true)).servers[0];
  }
  expect(by(done, model)).toMatchObject({ loaded: true, loading: false, memoryBytes: 2_019_393_189 });
  expect(by(await move(model, false), model).loaded).toBe(false);

  // A request that never ends is left to a ceiling of its own, and the model is free again after that.
  const hung = keep(fakeOllamaLive({ generate: "hang" }));
  looks(app, { [hung.port]: "ollama" });
  lm.limitMs = 100;
  lm.ceilingMs = 400;
  const stuck = () => lm.switch({ serverId: `ollama-${hung.port}`, model, on: true }).then(() => 200, (e: { status: number }) => e.status);
  expect(await stuck()).toBe(504);
  expect(await stuck()).toBe(409);
  for (let i = 0; i < 100 && (await stuck()) === 409; i++) await Bun.sleep(20);
  expect(sentTo(hung, "/api/generate")).toHaveLength(2);
});

test("a router model that only /models lists (the scan's /v1/models leaves it out) is switched like the others", async () => {
  const { app, lm } = setup();
  const gemma = "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M";
  const qwen = "unsloth/Qwen3-8B-GGUF:Q4_K_M";
  const router = keep(fakeLlamaRouter({ hidden: [qwen] }));
  looks(app, { [router.port]: "llamacpp" });
  const id = `llamacpp-${router.port}`;
  // The hub's own scan doesn't know the model: the list adds it from the router's /models, and the switch has to find it there too.
  expect((await app.services.localServers({ fresh: true })).servers[0].models.map((m) => m.id)).toEqual([gemma]);
  expect(by((await lm.list(true)).servers[0], qwen)).toMatchObject({ loaded: false, canSwitch: true });
  const on = await lm.switch({ serverId: id, model: qwen, on: true });
  expect(by(on, qwen)).toMatchObject({ loaded: true, loading: false });
  expect(sentTo(router, "/models/load")).toEqual([{ model: qwen }]);
  const off = await lm.switch({ serverId: id, model: qwen, on: false });
  expect(by(off, qwen).loaded).toBe(false);
  expect(sentTo(router, "/models/unload")).toEqual([{ model: qwen }]);
  // A model that neither lists is still not found.
  await expect(lm.switch({ serverId: id, model: "nope", on: true })).rejects.toMatchObject({ status: 404, message: "llama.cpp doesn't list nope any more. Press Rescan to see what it has." });
});

test("only 127.0.0.1 is ever called: a server by any other address is refused and nothing is sent to it", async () => {
  expect([onThisMachine("http://127.0.0.1:11434"), onThisMachine("http://localhost:11434"), onThisMachine("http://[::1]:11434"), onThisMachine("http://100.101.102.103:11434"), onThisMachine("http://192.168.1.5:11434"), onThisMachine("https://127.0.0.1:11434"), onThisMachine("nonsense")]).toEqual([true, false, false, false, false, false, false]);
  const { app, lm } = setup();
  const ollama = keep(fakeOllamaLive());
  // A scan that came back with the server under another name (a stand-in for any other host): it is only listed, never asked or switched.
  const named = { id: "ollama-1", kind: "ollama" as const, label: "Ollama", baseUrl: `http://localhost:${ollama.port}`, models: [{ id: "qwen3:8b", contextWindow: null, sizeBytes: null, loaded: true }], memoryBytes: null, protocols: { responses: "yes", messages: "no", chat: "yes" } as const, accountIds: [] };
  app.services.localServers = async () => ({ servers: [named], scannedAt: 1 });
  lm.run = machine({});
  const listed = await lm.list();
  expect(listed.servers[0].models[0]).toMatchObject({ loaded: true, memoryBytes: null });
  await expect(lm.switch({ serverId: "ollama-1", model: "qwen3:8b", on: false })).rejects.toMatchObject({ status: 409, message: "Only servers on this machine can be switched from here." });
  expect(ollama.seen).toEqual([]);
});

test("the routes: the list, a fresh look on request, and a switch with its refusals", async () => {
  const { app, lm } = setup();
  const server = startServer(app);
  cleanups.push(() => void server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const unauthorized = await fetch(`${base}/api/local-models`);
  expect(unauthorized.status).toBe(401);

  // A test hub looks nowhere (CROSSTALK_LOCAL_SERVER_PORTS is empty): nothing is found and no command runs.
  const ran = machine({});
  lm.run = ran;
  const nothing = await call("GET", "/api/local-models");
  expect(nothing.status).toBe(200);
  expect(nothing.body).toEqual({ servers: [], scannedAt: expect.any(Number) });
  expect(ran.asked).toEqual([]);

  const ollama = keep(fakeOllamaLive());
  const studio = keep(fakeLmStudio());
  looks(app, { [ollama.port]: "ollama", [studio.port]: "lmstudio" });
  const found = await call("GET", "/api/local-models");
  expect(found.body.servers.map((s: LocalModelServer) => s.kind).sort()).toEqual(["lmstudio", "ollama"]);
  const probes = () => ollama.seen.filter((s) => s.method === "POST").length;
  const kept = probes();
  await call("GET", "/api/local-models"); // the hub's remembered look
  expect(probes()).toBe(kept);
  await call("GET", "/api/local-models?fresh=1");
  expect(probes()).toBeGreaterThan(kept);
  // The older list of servers is as it was.
  expect((await call("GET", "/api/local-servers")).body.servers.map((s: { kind: string }) => s.kind).sort()).toEqual(["lmstudio", "ollama"]);

  const id = `ollama-${ollama.port}`;
  const body: LocalModelSwitch = { serverId: id, model: "qwen3:8b", on: false };
  const done = await call("POST", "/api/local-models/switch", body);
  expect(done.status).toBe(200);
  expect(done.body.id).toBe(id);
  expect(done.body.models.find((m: { id: string }) => m.id === "qwen3:8b").loaded).toBe(false);
  const refused = await call("POST", "/api/local-models/switch", { serverId: `lmstudio-${studio.port}`, model: "gemma-3-12b", on: true });
  expect(refused).toEqual({ status: 409, body: { error: "LM Studio is switched in its own app." } });
  expect((await call("POST", "/api/local-models/switch", { serverId: "ollama-1", model: "x", on: true })).status).toBe(404);
  expect((await call("POST", "/api/local-models/switch", {})).status).toBe(400);
  const broken = await fetch(`${base}/api/local-models/switch`, { method: "POST", headers: { authorization: `Bearer ${device.token}` }, body: "{not json" });
  expect(broken.status).toBe(400);
});

test("nothing in this module ever sends a signal to a process", () => {
  const source = readFileSync(join(import.meta.dir, "../src/localModels.ts"), "utf8");
  expect(source).not.toMatch(/\.kill\(|process\.kill|SIGTERM|SIGKILL|SIGINT|killall|pkill/);
});
