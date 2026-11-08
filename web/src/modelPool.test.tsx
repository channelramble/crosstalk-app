import { afterAll, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PoolMachine, PoolMachineState, PoolView } from "@crosstalk/shared";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// No network: the hub answers from here, and sockets only deliver what a test hands them.
const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
type Handler = (path: string, init?: RequestInit) => Promise<Response> | Response;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const snapshot = { hub: { version: "0.2.2", hostname: "mini.local", platform: "darwin", workspaceRoot: "/tmp", publicUrl: null, id: "h_self", name: "Mac mini" }, rooms: [], members: [], approvals: [], usage: [], providers: [], accounts: [], roomActivity: {}, device: { id: "d1", name: "Tests" } };
let handler: Handler = () => json({ error: "Not found" }, 404);
replace("WebSocket", Socket);
replace("fetch", async (input: string, init?: RequestInit) => {
  const path = new URL(String(input), "http://test").pathname;
  return path === "/api/state" ? json(snapshot) : handler(path, init);
});
afterAll(() => {
  for (const [key, desc] of originals) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

const GiB = 1024 ** 3;
const machines: PoolMachine[] = [
  { id: "self", kind: "self", name: "Mac mini", address: "100.64.0.1", os: "macos", backend: "metal", enabled: false, rpcPort: 50052 },
  { id: "h_linux", kind: "hub", name: "Linux box", address: "100.64.0.2", os: "linux", backend: "vulkan", enabled: true, rpcPort: 50052 },
  { id: "pc_games", kind: "computer", name: "Gaming PC", address: "100.64.0.3", os: "windows", backend: "cuda", enabled: true, rpcPort: 50052 },
];
const states: PoolMachineState[] = [
  { id: "self", devices: [{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }, { name: "BLAS", description: "Accelerate", totalMiB: 0, freeMiB: 0 }], link: null, state: "ready", detail: null, checkedAt: Date.now() - 60_000 },
  { id: "h_linux", devices: [{ name: "Vulkan0", description: "AMD Radeon RX 7600 XT (RADV NAVI33)", totalMiB: 16304, freeMiB: 16000 }], link: { ms: 8, direct: true }, state: "ready", detail: null, checkedAt: Date.now() - 60_000 },
  { id: "pc_games", devices: [{ name: "CUDA0", description: "NVIDIA GeForce RTX 3060", totalMiB: 8192, freeMiB: 7900 }], link: { ms: 40, direct: false }, state: "offline", detail: "Not answering: run the helper command on it again.", checkedAt: Date.now() - 60_000 },
];
const model = { repo: "orcarouter/Qwen3.8-27B-GGUF", files: ["Qwen3.8-27B-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 16.8e9, gated: true };
function view(change: { status?: Partial<PoolView["status"]>; config?: Partial<PoolView["config"]> } & Partial<Omit<PoolView, "status" | "config">> = {}): PoolView {
  const { status, config, ...rest } = change;
  return {
    config: { build: "b11669", machines, mainId: "self", model: null, contextSize: 65536, alias: "pool-model", port: 9931, autostart: false, ...config },
    machines: states,
    status: { state: "off", detail: null, download: null, endpoint: null, accounts: {}, startedAt: null, speed: null, log: [], ...status },
    fit: null,
    hasHfToken: false,
    ...rest,
  };
}
/** The words on screen: tags stripped, entities read. */
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const hooks = { toast() {}, openRoomId: () => null, roomGone() {}, signedOut() {}, approval() {}, ptyData() {} };

test("the hub store keeps pool events, and an answer that raced one never rolls it back", async () => {
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://pool-hub", token: "t", deviceName: "Tests" }, hooks);
  await store.getState().start();
  const socket = Socket.instances.at(-1)!;
  expect(store.getState().pool).toBeNull();
  socket.deliver({ t: "pool", pool: view({ status: { state: "preparing" } }) });
  expect(store.getState().pool?.status.state).toBe("preparing");

  // The start answers "preparing" late, after the download's event: the event stays.
  let answer: (r: Response) => void = () => {};
  handler = (path) => (path === "/api/pool/start" ? new Promise<Response>((r) => (answer = r)) : json(view()));
  const started = store.getState().poolCall("POST", "/api/pool/start");
  await Promise.resolve();
  socket.deliver({ t: "pool", pool: view({ status: { state: "downloading" } }) });
  answer(json(view({ status: { state: "preparing" } })));
  expect((await started).status.state).toBe("preparing");
  expect(store.getState().pool?.status.state).toBe("downloading");

  // With no event meanwhile, the answer is the newest word.
  handler = () => json(view({ config: { contextSize: 131072 } }));
  await store.getState().poolCall("PUT", "/api/pool", { config: { contextSize: 131072 } });
  expect(store.getState().pool?.config.contextSize).toBe(131072);

  // An older hub has no pool: the error says so (404), and nothing is kept.
  handler = () => json({ error: "Not found" }, 404);
  await expect(store.getState().loadPool()).rejects.toMatchObject({ status: 404 });
  store.getState().stop();
  expect(store.getState().pool).toBeNull();
});

test("the Model pool screen shows each state in plain words", async () => {
  const { ModelPool } = await import("./views/ModelPool");
  const render = (v: PoolView) => renderToStaticMarkup(createElement(ModelPool, { onSetUpLinux() {}, view: v }));
  // Nothing chosen: Off, what to do first, and Start waits for a model.
  let html = render(view());
  let text = words(html);
  expect(text).toContain("Off");
  expect(text).toContain("Choose a model below, then start it.");
  expect(html).toMatch(/<button class="btn primary" disabled="">[^]*?Start<\/button>/);
  // Each machine: role, GPU and memory, network, state and the switch.
  expect(text).toContain("Mac mini Main machine");
  expect(text).toContain("Holds the model and answers chats. Its GPU is left out.");
  expect(text).toContain("Apple M4 · 11.8 GB");
  expect(text).not.toContain("Accelerate");
  // Why it's left out is the hub's to say (in one line); the screen adds no second one.
  expect(text).not.toContain("Left out by default");
  expect(text).toContain("Linux box Helper");
  expect(text).toContain("RX 7600 XT · 16 GB");
  expect(text).toContain("Direct · 8 ms");
  expect(text).toContain("RTX 3060 · 8 GB");
  expect(text).toContain("Through a relay · 40 ms: slower");
  expect(text).toContain("Not answering: run the helper command on it again.");
  expect(html).toContain('aria-label="Use the GPU on Gaming PC"');
  expect(html).toContain('aria-label="Make this the main machine (Linux box)"');
  expect(html).toContain('aria-label="Remove Gaming PC"');
  expect(html).not.toContain('aria-label="Make this the main machine (Mac mini)"');
  expect(text).toContain("Add a Windows or other PC");
  expect(text).toContain("Add a Linux machine");
  expect(text).toContain("Keep your tailnet to your own devices");
  expect(text).toContain("Choose a model");
  expect(html).toContain('aria-label="Context size"');
  // Below 32k Claude Code's first message alone doesn't fit: not offered.
  expect(text).toContain("32k 64k 128k 256k");
  expect(text).not.toContain("16k");
  expect(text).not.toContain("get summarized after a few messages");
  expect(text).toContain("b11669");
  // Not gated: the token is only in Advanced.
  expect(html.match(/aria-label="Hugging Face token"/g)?.length).toBe(1);

  // A gated model downloading: progress with size and speed, the fit, and the token beside the model.
  html = render(view({ config: { model }, status: { state: "downloading", detail: "Downloading the model to Mac mini…", download: { file: "Qwen3.8-27B-Q4_K_M.gguf", doneBytes: 7.1 * GiB, totalBytes: 16.8 * GiB, bytesPerSec: 38 * 1024 ** 2 } }, fit: { needMiB: 18432, haveMiB: 23900, fits: true, note: "Fits the pool: the RX 7600 XT and RTX 3060 share it." } }));
  text = words(html);
  expect(text).toContain("Downloading Downloading the model to Mac mini…");
  expect(text).toContain("42% · 7.1 GB of 16.8 GB · 38 MB/s · about 4 min left");
  expect(html).toContain('role="progressbar"');
  expect(text).toContain("Stop");
  expect(text).toContain("Qwen3.8-27B Gated");
  expect(text).toContain("Q4_K_M · 15.6 GB");
  expect(text).toContain("Needs about 18 GB of 23.3 GB Fits");
  expect(text).toContain("Fits the pool: the RX 7600 XT and RTX 3060 share it.");
  expect(html.match(/aria-label="Hugging Face token"/g)?.length).toBe(1);
  expect(html).toContain('href="https://huggingface.co/settings/tokens"');
  expect(html).toContain('href="https://huggingface.co/orcarouter/Qwen3.8-27B-GGUF"');

  // Saved token: "Saved", replace or remove; never the token.
  text = words(render(view({ config: { model }, hasHfToken: true })));
  expect(text).toContain("Hugging Face token Saved");
  expect(text).toContain("Replace token");
  expect(text).toContain("Remove token");

  // Running: where chats reach it, the context it gave, speed, how to use it, and the server's output.
  html = render(view({ config: { model }, hasHfToken: true, status: { state: "running", endpoint: { baseUrl: "http://127.0.0.1:9931", model: "pool-model", contextWindow: 49152 }, speed: { prompt: 420, generation: 18.2 }, log: ["srv  llama_server: listening on http://127.0.0.1:9931"], startedAt: Date.now() } }));
  text = words(html);
  expect(text).toContain("Running");
  expect(text).toContain("Chats reach it at http://127.0.0.1:9931 as pool-model");
  expect(text).toContain("It gave 48k tokens of context (you asked for 64k: the model holds at most 48k).");
  expect(text).toContain("Speed: reads 420 tokens/s · writes 18.2 tokens/s");
  expect(text).toContain("Use it in a chat: start a Claude Code or Codex chat and pick the Model pool account.");
  expect(html).toMatch(/<details class="pool-log"><summary>Server output<\/summary>/);

  // A problem: the fix its detail names, then Try again.
  text = words(render(view({ config: { model }, status: { state: "error", detail: "Hugging Face refused the download: add your Hugging Face token, then try again." } })));
  expect(text).toContain("Problem");
  expect(text).toMatch(/Add your Hugging Face token .*Try again/);
  text = words(render(view({ config: { model }, status: { state: "error", detail: "Gaming PC isn't answering: check the machines." } })));
  expect(text).toMatch(/Check the machines .*Try again/);
  // Two fixes, in the order the hub names them; the first is the main button.
  html = render(view({ config: { model }, status: { state: "error", detail: "Not enough free space for a/b (Q4_K_M): it needs 12.3 GB more and 2.1 GB is free (keeping 2.0 GB free). Free up space or pick a smaller quant." } }));
  expect(words(html)).toMatch(/Free up space Choose another model .*Try again/);
  expect(html).toContain('<button class="btn primary">Free up space</button>');
  // Settings → Storage is this machine's disk: no use when the model lives on another one.
  expect(words(render(view({ config: { model, mainId: "h_linux" }, status: { state: "error", detail: "Not enough free space on Linux box. Free up space or pick a smaller quant." } })))).not.toContain("Free up space Choose");
  expect(words(render(view({ config: { model }, status: { state: "error", detail: "Port 9931 is already taken on this machine: pick another port, then start again." } })))).toMatch(/Change the port .*Try again/);
  // A helper's port isn't the app's to change: no such fix.
  expect(words(render(view({ config: { model }, status: { state: "error", detail: "Linux box: The helper's port 50052 is already taken on this machine: close the program that uses it (an old helper window, say), then start again." } })))).not.toContain("Change the port");
  // 32k: Claude Code chats summarize after a few messages, and the screen says so.
  expect(words(render(view({ config: { contextSize: 32768 } })))).toContain("At 32k, Claude Code chats get summarized after a few messages: pick 64k if the bar above says it fits.");
  // Running: the fit is what's known, not a guess.
  text = words(render(view({ config: { model }, status: { state: "running", endpoint: { baseUrl: "http://127.0.0.1:9931", model: "pool-model", contextWindow: 65536 } }, fit: { needMiB: 21154, haveMiB: 15832, fits: false, note: "Crosstalk can't see the GPU memory of Gaming PC, so it isn't counted here." } })));
  expect(text).toContain("It fits: it's running now. Running");
  expect(text).not.toContain("Maybe");
  expect(text).not.toContain("It fits if");
  // Too little context for Claude Code: said while it runs.
  expect(words(render(view({ config: { model, contextSize: 32768 }, status: { state: "running", endpoint: { baseUrl: "http://127.0.0.1:9931", model: "pool-model", contextWindow: 16384 } } })))).toContain("Too little for Claude Code, which needs about 20k just to start");
  // The main machine's models, each removable in two steps.
  html = render(view({ config: { model }, mainFiles: [{ file: `${model.repo}/${model.files[0]}`, bytes: 16.8e9, partial: false }, { file: "acme/Old-GGUF/Old-Q4_0.gguf", bytes: 60 * GiB, partial: true }] }));
  text = words(html);
  expect(text).toContain("Models on Mac mini");
  expect(text).toContain("Old-Q4_0.gguf Old · 60.0 GB · unfinished");
  expect(text).toContain("Qwen3.8-27B-Q4_K_M.gguf Qwen3.8-27B · 15.6 GB · the chosen model");
  expect(html).toContain('aria-label="Remove Old-Q4_0.gguf"');
});

test("a PC's GPU, as the hub reports it (unknown), never reads as missing or too small", async () => {
  const { ModelPool } = await import("./views/ModelPool");
  const render = (v: PoolView) => renderToStaticMarkup(createElement(ModelPool, { onSetUpLinux() {}, view: v }));
  // As the hub sends three machines after a check: this Mac without llama.cpp, the Linux hub's GPU, and the
  // PC whose helper answers but whose GPU it can't see.
  const real = view({
    config: { model, mainId: "h_linux", contextSize: 32768 },
    machines: [
      { id: "self", devices: [], link: null, state: "ready", detail: "Its GPUs show once llama.cpp is on it (the pool installs it there when it takes part).", checkedAt: Date.now() - 60_000 },
      { id: "h_linux", devices: [{ name: "Vulkan0", description: "AMD Radeon RX 7600 XT (RADV NAVI33)", totalMiB: 16304, freeMiB: 15832 }], link: { ms: 2, direct: true }, state: "ready", detail: null, checkedAt: Date.now() - 60_000 },
      { id: "pc_games", devices: [], link: { ms: 41, direct: false }, state: "ready", detail: "Its helper answers at 100.64.0.3:50052.", checkedAt: Date.now() - 60_000 },
    ],
    fit: { needMiB: 21154, haveMiB: 15832, fits: false, note: "Crosstalk can't see the GPU memory of Gaming PC, so it isn't counted here." },
  });
  let text = words(render(real));
  expect(text).not.toContain("No GPU found");
  expect(text).not.toContain("Too big");
  expect(text).toContain("Needs about 20.7 GB of 15.5 GB counted Maybe");
  expect(text).toContain("It fits if Gaming PC has about 5.2 GB free on its GPU.");
  // The Mac's own words from the hub, once: the screen adds none of its own.
  expect(text).toContain("Its GPUs show once llama.cpp is on it");
  expect(text).not.toContain("Left out by default");
  const leftOut = { ...real, machines: [{ ...real.machines[0], detail: "Left out: slowest GPU, and it runs your chats. Switch it on to lend it too." }, ...real.machines.slice(1)] };
  expect(words(render(leftOut)).match(/Left out: slowest GPU/g)?.length).toBe(1);
  // Checked before the hub restarted: not "not checked yet", just when it was.
  const restarted = { ...real, machines: [real.machines[0], { ...real.machines[1], state: "unknown" as const, detail: null }, real.machines[2]] };
  text = words(render(restarted));
  expect(text).not.toContain("Not checked yet");
  expect(text).toContain("Direct · 2 ms Checked 1m ago");
  // A PC's helper that doesn't answer: its helper command is the first fix.
  const html = render({ ...real, status: { ...real.status, state: "error", detail: "The helper on Gaming PC doesn't answer at 100.64.0.3:50052. Run its helper command there (Helper command next to it), then start again." } });
  text = words(html);
  expect(text).toMatch(/Show the helper command Check the machines .*Try again/);
  expect(html).toContain('<button class="btn primary">Show the helper command</button>');
  // A helper command named for a machine that isn't a PC isn't offered.
  expect(words(render({ ...real, status: { ...real.status, state: "error", detail: "Linux box's helper command is for llama.cpp b11669: start again." } }))).not.toContain("Show the helper command");
});
