import { afterAll, afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageEditorStatus } from "@crosstalk/shared";
import { ImageEditor, editorModels, footprintMB, lastProblem, listeningInodes, queueContents, startPort, warmupWorkflow } from "../src/imageEditor";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { endStarted } from "./standins";

const FAKE = join(import.meta.dir, "fixtures", "fake-comfy");
const dirs: string[] = [];
const editors: ImageEditor[] = [];

/** Every fake server a test install ever started (each notes its start). */
const startedIn = (dir: string) =>
  existsSync(join(dir, "fake-comfy.log"))
    ? readFileSync(join(dir, "fake-comfy.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { started?: number }).flatMap((e) => (e.started ? [e.started] : []))
    : [];

// Whatever the test got to, everything it started ends, process groups whole: the servers the editor started (start.sh
// runs in a process group of its own, as the real one must to outlive the hub, so nothing else ends it) and the ones a
// test started some other way -- including one still starting, that hasn't noted its start yet.
afterEach(async () => {
  editors.splice(0).forEach((e) => e.shutdown());
  await endStarted();
});
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

const EDITOR_HTML = `<script>
const MODELS = {
  unet: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
  clip: 'qwen3vl_8b-Q4_K_M.gguf',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
};
</script>`;

type Request = { path: string; prompt?: Record<string, { class_type: string; inputs: Record<string, unknown> }>; delete?: string[]; name?: string; bytes?: number; client?: string };

/** A test install laid out like the real one: start.sh runs ComfyUI/main.py (the fake) from its folder, on its own port. */
async function install(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-image-editor-"));
  dirs.push(dir);
  const port = await freePort();
  mkdirSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor"), { recursive: true });
  writeFileSync(join(dir, "ComfyUI", "main.py"), readFileSync(FAKE));
  writeFileSync(join(dir, "start.sh"), `#!/bin/sh\n# Like the real one: from its folder, exec the server.\ncd "$(dirname "$0")"\nexec "${process.execPath}" ComfyUI/main.py --listen 0.0.0.0 --port ${port}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor", "editor.html"), EDITOR_HTML);
  writeFileSync(join(dir, "fake-comfy.json"), JSON.stringify(config));
  const requests = () =>
    existsSync(join(dir, "fake-comfy.log"))
      ? readFileSync(join(dir, "fake-comfy.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Request).filter((r) => r.path)
      : [];
  const configure = (c: Record<string, unknown>) => writeFileSync(join(dir, "fake-comfy.json"), JSON.stringify(c));
  return { dir, port, requests, configure, logFile: join(dir, "server.log"), pidFile: join(dir, "editor-pid.json"), starts: () => startedIn(dir) };
}

/** An image editor on a test install; `tailscale` is only ever written into the link, never contacted. */
function editor(inst: { dir: string; logFile: string; pidFile: string }, timing: Record<string, number> = {}) {
  const events: ImageEditorStatus[] = [];
  const ed = new ImageEditor({
    dir: inst.dir,
    logFile: inst.logFile,
    pidFile: inst.pidFile,
    emit: (s) => events.push(s),
    tailscaleIp: async () => "100.64.0.7",
    timing: { watchMs: 200, startMs: 10_000, warmMs: 10_000, stopMs: 2000, stepMs: 50, ...timing },
  });
  editors.push(ed);
  const states = () => events.map((e) => e.state).filter((s, i, all) => s !== all[i - 1]);
  const until = async (state: ImageEditorStatus["state"], ms = 15_000) => {
    const end = Date.now() + ms;
    while (events.at(-1)?.state !== state) {
      if (Date.now() > end) throw new Error(`Never got to "${state}": ${JSON.stringify(states())} ${events.at(-1)?.detail ?? ""}`);
      await Bun.sleep(20);
    }
    return events.at(-1)!;
  };
  return { ed, events, states, until };
}

const answers = async (port: number) => fetch(`http://127.0.0.1:${port}/system_stats`).then((r) => r.ok, () => false);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The fake server started some other way (from a terminal, say): main.py from the install, or `script` from `cwd`. */
function startedElsewhere(port: number, cwd: string, script = "ComfyUI/main.py") {
  const child = spawn(process.execPath, [script, "--port", String(port)], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

async function untilAnswers(port: number) {
  for (let i = 0; i < 200 && !(await answers(port)); i++) await Bun.sleep(25);
  expect(await answers(port)).toBe(true);
}

test("the editor page's models, start.sh's port, the queue, memory and the line that says what went wrong", () => {
  expect(editorModels(EDITOR_HTML)).toEqual({ unet: "qwen-image-2.1-turbo-Q4_K_M.gguf", clip: "qwen3vl_8b-Q4_K_M.gguf", vae: "qwen_image_2.1_vae_bf16.safetensors" });
  expect(editorModels("<p>no models</p>")).toBeNull();
  expect(startPort("exec python ComfyUI/main.py --listen 0.0.0.0 --port 8188 --disable-auto-launch")).toBe(8188);
  expect(startPort("exec python main.py --port=9001")).toBe(9001);
  expect(startPort("exec python main.py")).toBe(8188);
  expect(footprintMB("python [22513]: 64-bit    Footprint: 2236 MB (16384 bytes per page)")).toBe(2236);
  expect(footprintMB("Footprint: 8.5 GB")).toBe(8704);
  expect(footprintMB("nothing")).toBeNull();
  expect(lastProblem("Starting server\nTraceback (most recent call last):\n  File x\nRuntimeError: MPS backend out of memory\n")).toBe("RuntimeError: MPS backend out of memory");
  expect(lastProblem("Starting server\nTo see the GUI go to: http://0.0.0.0:8188\n")).toBeNull();
  expect(lastProblem("zsh: no such file or directory: .venv/bin/activate")).toBe("zsh: no such file or directory: .venv/bin/activate");
  expect(lastProblem("")).toBeNull();
  // ComfyUI's queue items: [number, prompt_id, prompt, extra_data, outputs]. The hub's warm-up isn't anyone's edit.
  const queue = { queue_running: [[3, "p-warm", {}, { client_id: "crosstalk-hub" }, []]], queue_pending: [[4, "p-phone", {}, { client_id: "f3a1" }, []], [5, "p-api", {}, {}, []]] };
  expect(queueContents(queue)).toEqual({ edits: 2, warmups: ["p-warm"] });
  expect(queueContents({ queue_running: [], queue_pending: [] })).toEqual({ edits: 0, warmups: [] });
  expect(queueContents(null)).toEqual({ edits: 0, warmups: [] });
  // Linux without lsof: the listening socket on the port (0x1FFC = 8188, state 0A) in /proc/net/tcp.
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:1FFC 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41377 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:1FFC 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000        0 41999 1 0000000000000000 20 4 30 10 -1",
    "   2: 00000000:1CF4 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52001 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  expect(listeningInodes(tcp, 8188)).toEqual(["41377"]);
  expect(listeningInodes(tcp, 9000)).toEqual([]);
  // The warm-up is the editor's own workflow, as small as it goes, ending in a preview nothing keeps.
  const w = warmupWorkflow(editorModels(EDITOR_HTML)!, "crosstalk-warmup.png") as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  expect(w["8"].class_type).toBe("PreviewImage");
  expect(w["6"].inputs.steps).toBe(1);
  expect(w["5"].inputs.resolution).toBe(256);
});

test("not set up on this machine: Settings doesn't show it, and switching it on says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-image-editor-none-"));
  dirs.push(dir);
  const { ed } = editor({ dir: join(dir, "ai-models", "image-editor"), logFile: join(dir, "server.log"), pidFile: join(dir, "pid.json") });
  await ed.start();
  expect((await ed.status()).installed).toBe(false);
  await expect(ed.set(true)).rejects.toMatchObject({ status: 404, message: "The image editor isn't set up on this machine." });
});

test("on: starts the server, loads the editor's own models with one tiny edit, gives the link; off ends it", async () => {
  const inst = await install({ startMs: 300 });
  const { ed, states, until } = editor(inst);
  await ed.start();
  expect(await ed.status()).toEqual({ installed: true, state: "off", detail: null, failed: null, url: `http://100.64.0.7:${inst.port}/editor`, memoryMB: null, busy: false });
  const first = await ed.set(true);
  expect(first.state).toBe("starting");
  const ready = await until("ready");
  expect(states()).toEqual(["starting", "loading", "ready"]);
  expect(ready).toMatchObject({ detail: null, failed: null, busy: false });
  expect(ready.memoryMB).toBeGreaterThan(0);
  // The tiny edit: a small picture, then the editor's workflow with its models, then its history entry removed.
  const reqs = inst.requests();
  expect(reqs.map((r) => r.path)).toEqual(["/upload/image", "/prompt", "/history"]);
  expect(reqs[0]).toMatchObject({ name: "crosstalk-warmup.png" });
  expect(reqs[0].bytes).toBeGreaterThan(100);
  const prompt = reqs[1].prompt!;
  expect(reqs[1].client).toBe("crosstalk-hub");
  expect(prompt["1"].inputs.unet_name).toBe("qwen-image-2.1-turbo-Q4_K_M.gguf");
  expect(prompt["2"].inputs).toEqual({ clip_name: "qwen3vl_8b-Q4_K_M.gguf", type: "qwen_image" });
  expect(prompt["3"].inputs.vae_name).toBe("qwen_image_2.1_vae_bf16.safetensors");
  expect(prompt["4"].inputs.image).toBe("crosstalk-warmup.png");
  expect(reqs[2].delete).toEqual(["p1"]);
  // Its output goes to the log, and the server it started is noted for a restarted hub.
  expect(readFileSync(inst.logFile, "utf8")).toContain("Starting server");
  expect(JSON.parse(readFileSync(inst.pidFile, "utf8"))).toEqual({ pid: inst.starts()[0], dir: inst.dir });
  // Switching it on again changes nothing.
  expect((await ed.set(true)).state).toBe("ready");
  expect(inst.starts()).toHaveLength(1);

  expect((await ed.set(false)).state).toBe("stopping");
  const off = await until("off");
  expect(off).toMatchObject({ state: "off", detail: null, memoryMB: null, busy: false });
  expect(await answers(inst.port)).toBe(false);
  expect(alive(inst.starts()[0])).toBe(false);
  expect(existsSync(inst.pidFile)).toBe(false);
});

test("a server that fails to start says what it said last, and turning it off clears that", async () => {
  const inst = await install({ fail: "RuntimeError: MPS backend out of memory (MPS allocated: 9.1 GB)" });
  const { ed, until } = editor(inst);
  await ed.start();
  await ed.set(true);
  const failed = await until("error");
  expect(failed).toMatchObject({ failed: "start", detail: `It stopped while starting: RuntimeError: MPS backend out of memory (MPS allocated: 9.1 GB). Its log: ${inst.logFile}` });
  expect(existsSync(inst.pidFile)).toBe(false);
  // Trying again tries again.
  inst.configure({});
  await ed.set(true);
  await until("ready");
  await ed.set(false);
  await until("off");
  // A problem cleared with the switch: off, nothing to read.
  inst.configure({ fail: "ImportError: No module named torch" });
  await ed.set(true);
  expect((await until("error")).detail).toContain("ImportError: No module named torch");
  expect(await ed.set(false)).toMatchObject({ state: "off", detail: null, failed: null });
});

test("one that stops by itself later shows as stopped, with why", async () => {
  const inst = await install();
  const { ed, until } = editor(inst);
  await ed.start();
  await ed.set(true);
  await until("ready");
  // Killed from outside (the Mac ran out of memory, say).
  process.kill(inst.starts()[0], "SIGKILL");
  expect(await until("error")).toMatchObject({ failed: "start", detail: `It stopped: it was force-quit. Its log: ${inst.logFile}` });
  expect(existsSync(inst.pidFile)).toBe(false);
});

test("one that doesn't answer in time is ended, so it's stopped as the card says", async () => {
  const inst = await install({ startMs: 60_000 });
  const { ed, until } = editor(inst, { startMs: 1500 });
  await ed.start();
  await ed.set(true);
  const late = await until("error");
  expect(late).toMatchObject({ failed: "start", detail: `It didn't answer within 2 seconds, so it was stopped. Try again, or check its log: ${inst.logFile}` });
  for (let i = 0; i < 50 && alive(inst.starts()[0]); i++) await Bun.sleep(20);
  expect(alive(inst.starts()[0])).toBe(false);
  expect(existsSync(inst.pidFile)).toBe(false);
});

test("a server started some other way shows as on, and turning it off ends it; one from another folder is never ended", async () => {
  const inst = await install();
  const pid = startedElsewhere(inst.port, inst.dir);
  await untilAnswers(inst.port);
  const { ed, until } = editor(inst);
  await ed.start();
  expect(await ed.status()).toMatchObject({ state: "ready", busy: false });
  await ed.set(false);
  await until("off");
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20);
  expect(alive(pid)).toBe(false);

  // Something else on the port, run from another folder: shown as on (it answers), but turning it off leaves it be.
  const other = mkdtempSync(join(tmpdir(), "ct-image-editor-other-"));
  dirs.push(other);
  const stranger = startedElsewhere(inst.port, other, FAKE);
  await untilAnswers(inst.port);
  expect((await ed.status()).state).toBe("ready");
  await ed.set(false);
  const refused = await until("error");
  expect(refused).toMatchObject({ failed: "stop", detail: `Something else answers on port ${inst.port}: end it on this machine, then try again.` });
  expect(alive(stranger)).toBe(true);
  // Once that's ended, Try again turns it off.
  process.kill(-stranger, "SIGKILL");
  for (let i = 0; i < 100 && (await answers(inst.port)); i++) await Bun.sleep(20);
  await ed.set(false);
  expect(await until("off")).toMatchObject({ failed: null, detail: null });
});

test("one still starting (started some other way) isn't started twice", async () => {
  const inst = await install();
  const { ed, until } = editor(inst);
  await ed.start();
  inst.configure({ startMs: 1500 });
  startedElsewhere(inst.port, inst.dir);
  for (let i = 0; i < 100 && inst.starts().length === 0; i++) await Bun.sleep(10);
  await ed.set(true);
  await until("ready");
  expect(inst.starts()).toHaveLength(1);
  await ed.set(false);
  await until("off");
});

test("a restarted hub finds the server it started (on, still starting, or still loading the model), and turning it off ends it", async () => {
  const inst = await install();
  const before = editor(inst);
  await before.ed.start();
  await before.ed.set(true);
  await before.until("ready");
  const pid = inst.starts()[0];
  // The hub restarts: the server keeps running.
  before.ed.shutdown();
  const after = editor(inst);
  await after.ed.start();
  expect((await after.ed.status()).state).toBe("ready");
  await after.ed.set(false);
  await after.until("off");
  expect(alive(pid)).toBe(false);
  expect(existsSync(inst.pidFile)).toBe(false);

  // Restarted while it was still starting: waited for, then the model is loaded.
  inst.configure({ startMs: 1500 });
  const starting = editor(inst);
  await starting.ed.start();
  await starting.ed.set(true);
  for (let i = 0; i < 200 && !existsSync(inst.pidFile); i++) await Bun.sleep(10);
  starting.ed.shutdown();
  const resumed = editor(inst);
  await resumed.ed.start();
  await resumed.until("ready");
  expect(resumed.states()).toEqual(["starting", "loading", "ready"]);
  await resumed.ed.set(false);
  await resumed.until("off");

  // Restarted while the model loads: that warm-up is waited for (it's no one's edit), then its history entry goes.
  inst.configure({ warmMs: 1500 });
  const loading = editor(inst);
  await loading.ed.start();
  await loading.ed.set(true);
  await loading.until("loading");
  const prompts = () => inst.requests().filter((r) => r.path === "/prompt").length;
  for (let i = 0; i < 200 && prompts() < 3; i++) await Bun.sleep(10);
  loading.ed.shutdown();
  const waited = editor(inst);
  await waited.ed.start();
  expect(waited.states()).toEqual(["loading"]);
  expect((await waited.until("ready")).busy).toBe(false);
  expect(prompts()).toBe(3);
  const deleted = () => inst.requests().filter((r) => r.path === "/history").length;
  for (let i = 0; i < 100 && deleted() < 3; i++) await Bun.sleep(10);
  expect(inst.requests().at(-1)).toMatchObject({ path: "/history", delete: ["p1"] });
  await waited.ed.set(false);
  await waited.until("off");

  // A note left from before the Mac restarted (its process long gone) is dropped.
  writeFileSync(inst.pidFile, JSON.stringify({ pid: 999_999, dir: inst.dir }));
  const rebooted = editor(inst);
  await rebooted.ed.start();
  expect((await rebooted.ed.status()).state).toBe("off");
  expect(existsSync(inst.pidFile)).toBe(false);
// Three restart scenarios, two 1.5 s configured waits and real process starts and stops: more than bun's 5 s
// default once the machine is busy (it timed out at 5,091 ms during the 0.6.1 run).
}, 30_000);

test("a server picked up after a restart that dies says so at once, and what's noted about it goes", async () => {
  const inst = await install({ warmMs: 60_000 });
  const first = editor(inst);
  await first.ed.start();
  await first.ed.set(true);
  await first.until("loading");
  first.ed.shutdown();
  const next = editor(inst);
  await next.ed.start();
  await next.until("loading");
  process.kill(inst.starts()[0], "SIGKILL");
  const gone = await next.until("error", 5000);
  expect(gone).toMatchObject({ failed: "start", detail: `It stopped while loading the model. Its log: ${inst.logFile}` });
  expect(existsSync(inst.pidFile)).toBe(false);
  // Nothing is noted to end any more: turning it off only clears the problem.
  expect(await next.ed.set(false)).toMatchObject({ state: "off", failed: null });

  // Picked up while starting, and dies: the same.
  inst.configure({ startMs: 60_000 });
  const third = editor(inst);
  await third.ed.start();
  await third.ed.set(true);
  for (let i = 0; i < 200 && !existsSync(inst.pidFile); i++) await Bun.sleep(10);
  third.ed.shutdown();
  const fourth = editor(inst);
  await fourth.ed.start();
  await fourth.until("starting");
  // The server the hub noted (its own note of starting may not be written yet).
  process.kill((JSON.parse(readFileSync(inst.pidFile, "utf8")) as { pid: number }).pid, "SIGKILL");
  expect((await fourth.until("error", 5000)).detail).toStartWith("It stopped while starting");
  expect(existsSync(inst.pidFile)).toBe(false);
});

test("turning it off with an edit to do asks first, while on or while loading; the hub's own warm-up doesn't count", async () => {
  const inst = await install();
  const { ed, until } = editor(inst);
  await ed.start();
  await ed.set(true);
  await until("ready");
  inst.configure({ busy: true });
  expect((await ed.status()).busy).toBe(true);
  await expect(ed.set(false)).rejects.toMatchObject({ status: 409, code: "busy", message: "It's working on an edit. Turning it off now stops that edit." });
  expect((await ed.set(false, true)).state).toBe("stopping");
  await until("off");

  // While the model loads, only its warm-up is in the queue: off goes ahead.
  inst.configure({ warmMs: 60_000 });
  await ed.set(true);
  await until("loading");
  for (let i = 0; i < 200 && inst.requests().filter((r) => r.path === "/prompt").length < 2; i++) await Bun.sleep(10);
  await ed.set(false);
  await until("off");
  expect(await answers(inst.port)).toBe(false);

  // Someone's edit waits behind the warm-up: asked first.
  inst.configure({ warmMs: 60_000, busy: true });
  await ed.set(true);
  await until("loading");
  await expect(ed.set(false)).rejects.toMatchObject({ status: 409, code: "busy" });
  await ed.set(false, true);
  await until("off");
});

test("a model that doesn't load first isn't a failure: the first edit loads it", async () => {
  const inst = await install({ reject: "Prompt outputs failed validation" });
  const { ed, until } = editor(inst);
  await ed.start();
  await ed.set(true);
  expect((await until("ready")).detail).toBe("The model loads with the first edit, so that one takes longer.");
  await ed.set(false);
  await until("off");
  inst.configure({ warmError: "Allocation on device" });
  await ed.set(true);
  expect((await until("ready")).detail).toBe("The model loads with the first edit, so that one takes longer.");
  await ed.set(false);
  await until("off");
});

test("the hub's routes: what Settings reads, and switching it says what it needs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ct-image-editor-hub-"));
  dirs.push(root);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: root, maxHopsDefault: 6 } });
  await app.start();
  const server = startServer(app);
  try {
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Test", "Web"))!;
    const call = (method: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${server.port}/api/image-editor`, { method, headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await call("GET");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ installed: false, state: "off" });
    expect((await call("POST", { on: "yes" })).status).toBe(400);
    const missing = await call("POST", { on: true });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "The image editor isn't set up on this machine.", code: "not_installed" });
  } finally {
    server.stop(true);
    await app.shutdown();
  }
});
