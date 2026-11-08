import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route, WebSocketRoute } from "@playwright/test";
import type { PoolMachine, PoolMachineState, PoolModel, PoolModelChoices, PoolNodeInfo, PoolStatus, PoolView, ServerEvent } from "@crosstalk/shared";
import { test as base, expect, noHorizontalOverflow, settingsTab } from "./fixtures";

// Settings → Model pool with three machines (docs/MODEL-POOL.md): this Mac left out, the Linux hub linux-box
// (16 GB GPU) as the main machine, and the Windows PC gaming-pc (8 GB GPU) lending its GPU
// through a Tailscale relay. Every /api/pool request is answered by the hub's own pool code (e2e/poolHub.ts), so what
// the page shows and sends is what the hub makes and takes; only the network around it is played: linux-box's
// answers, Tailscale, Hugging Face's file list and the PC's helper. Starting the pool is played as the hub's events,
// in its words. Nothing here starts llama.cpp, reaches Tailscale or downloads from Hugging Face.

// ---- The machines ----

const MAC = { name: "Mac mini", address: "100.72.5.18" };
const LINUX_BOX = { id: "h_7k2m9qx4bdr3", name: "linux-box", address: "100.64.0.9" };
const WIN = { id: "pc_4n8w2k7d", name: "gaming-pc", address: "100.88.12.40" };
const REPO = "orcarouter/Qwen3.8-27B-GGUF";
const Q4 = "Qwen3.8-27B-Q4_K_M.gguf";
/** 16.81 GB, as Hugging Face lists it. */
const Q4_BYTES = 16_812_390_656;
/** Not a real token: the hub only checks that it looks like one. */
const HF_TOKEN = "hf_BrowserTestNotARealToken0000000000";

/** What a hub says about itself as a pool machine (GET /api/pool/node) while it runs nothing for the pool. */
const nodeInfo = (o: Pick<PoolNodeInfo, "hubId" | "name" | "os" | "arch" | "address" | "installed" | "devices" | "freeDiskBytes">): PoolNodeInfo => ({
  busy: null,
  helper: { running: false, port: null, detail: null },
  server: { running: false, port: null, healthy: false, detail: null, log: [] },
  models: [],
  lastError: null,
  ...o,
});
// This Mac: left out, so Crosstalk never put llama.cpp on it and doesn't know its GPU.
const macInfo = nodeInfo({ hubId: "h_3qd8v2mz6kxw", name: MAC.name, os: "macos", arch: "arm64", address: MAC.address, installed: [], devices: [], freeDiskBytes: 118_400_000_000 });
// linux-box has llama.cpp b11669 for Vulkan from an earlier start, and lists its GPU as llama.cpp names it.
const linuxInfo = nodeInfo({
  hubId: LINUX_BOX.id,
  name: LINUX_BOX.name,
  os: "linux",
  arch: "x64",
  address: LINUX_BOX.address,
  installed: ["b11669-vulkan"],
  devices: [{ name: "Vulkan0", description: "AMD Radeon RX 7600 XT (RADV NAVI33)", totalMiB: 16304, freeMiB: 15832 }],
  freeDiskBytes: 402_700_000_000,
});
/** gaming-pc, as the PC dialog saves it: picked from Tailscale, NVIDIA (CUDA). */
const winMachine: PoolMachine = { id: WIN.id, kind: "computer", name: WIN.name, address: WIN.address, os: "windows", backend: "cuda", enabled: true, rpcPort: 50052 };

// This hub's `tailscale status --json` (the parts the hub reads), and `tailscale ping` from here.
const tailscaleStatus = {
  Version: "1.88.3-t9b4e2c71d-g5f0a8c3e2",
  BackendState: "Running",
  Self: { HostName: "Mac-mini", DNSName: "mac-mini.tail4f2a1.ts.net.", OS: "macOS", TailscaleIPs: [MAC.address, "fd7a:115c:a1e0::6a01:512"], Online: true, CurAddr: "" },
  Peer: {
    "nodekey:6c1f0d2a": { HostName: "linux-box", DNSName: "linux-box.tail4f2a1.ts.net.", OS: "linux", TailscaleIPs: [LINUX_BOX.address, "fd7a:115c:a1e0::5d01:2540"], Online: true, CurAddr: "192.168.1.42:41641", Relay: "nyc" },
    "nodekey:9b2e47c1": { HostName: "gaming-pc", DNSName: "gaming-pc.tail4f2a1.ts.net.", OS: "windows", TailscaleIPs: [WIN.address, "fd7a:115c:a1e0::8b01:c28"], Online: true, CurAddr: "", Relay: "nyc" },
    "nodekey:a47d93e5": { HostName: "iPhone", DNSName: "iphone.tail4f2a1.ts.net.", OS: "iOS", TailscaleIPs: ["100.80.44.9", "fd7a:115c:a1e0::2c01:2c09"], Online: true, CurAddr: "", Relay: "nyc" },
  },
};
const pings = {
  [LINUX_BOX.address]: `pong from linux-box (${LINUX_BOX.address}) via 192.168.1.42:41641 in 2ms`,
  [WIN.address]: `pong from gaming-pc (${WIN.address}) via DERP(nyc) in 41ms`,
};
// The repo's files as Hugging Face lists them: the quants, BF16 in two parts and the vision add-on.
const hfFiles = [
  { path: ".gitattributes", size: 2_383 },
  { path: "README.md", size: 7_421 },
  { path: "BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf", size: 49_890_000_000 },
  { path: "BF16/Qwen3.8-27B-BF16-00002-of-00002.gguf", size: 5_047_466_880 },
  { path: "Qwen3.8-27B-IQ4_XS.gguf", size: 14_917_312_512 },
  { path: "Qwen3.8-27B-Q2_K.gguf", size: 10_742_311_424 },
  { path: "Qwen3.8-27B-Q3_K_M.gguf", size: 13_605_017_088 },
  { path: Q4, size: Q4_BYTES },
  { path: "Qwen3.8-27B-Q5_K_M.gguf", size: 19_589_144_576 },
  { path: "Qwen3.8-27B-Q6_K.gguf", size: 22_536_548_352 },
  { path: "Qwen3.8-27B-Q8_0.gguf", size: 29_188_771_840 },
  { path: "mmproj-Qwen3.8-27B-F16.gguf", size: 931_299_840 },
];

// linux-box's llama-server output (b11669's own format), loading and then answering a chat.
const MODEL_PATH = `/home/user/.crosstalk/models/${REPO}/${Q4}`;
const LOADING = [
  "0.00.000.611 I srv  llama_server: initializing ...",
  "0.00.029.870 I cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)",
  `0.00.041.377 I srv    load_model: loading model '${MODEL_PATH}'`,
];
const LOADED = [
  ...LOADING,
  "1.48.612.904 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 65536, kv_unified = 'false'",
  "1.48.614.233 I srv  llama_server: model loaded",
  `1.48.614.241 I srv  llama_server: listening on http://${LINUX_BOX.address}:9931`,
];
const REPLIED = [
  ...LOADED,
  "2.31.407.118 I slot print_timing: id  0 | task 0 | prompt eval time =   12071.86 ms /  1982 tokens (    6.09 ms per token,   164.21 tokens per second)",
  "2.31.407.121 I slot print_timing: id  0 | task 0 |        eval time =   48931.15 ms /   412 tokens (  118.76 ms per token,     8.42 tokens per second)",
];
const METRICS = [
  "# HELP llamacpp:prompt_tokens_seconds Average prompt throughput in tokens/s.",
  "# TYPE llamacpp:prompt_tokens_seconds gauge",
  "llamacpp:prompt_tokens_seconds 164.213",
  "# HELP llamacpp:predicted_tokens_seconds Average generation throughput in tokens/s.",
  "# TYPE llamacpp:predicted_tokens_seconds gauge",
  "llamacpp:predicted_tokens_seconds 8.42",
].join("\n");

// ---- The hub ----

type HubState = {
  name: string;
  kv: Record<string, string>;
  states: PoolMachineState[];
  infos: Record<string, PoolNodeInfo>;
  status: PoolStatus | null;
  links: { id: string; name: string; scope: "full" | "peer"; node: PoolNodeInfo | null }[];
  self: PoolNodeInfo;
  pings: Record<string, string>;
  tailscale: unknown;
  helpers: string[];
  hf: Record<string, { gated: false | "auto" | "manual"; files: { path: string; size: number }[] }>;
};
type Answer = { ok: true; result: unknown; events: ServerEvent[]; hub: HubState } | { ok: false; status: number; error: string; code?: string };

const script = fileURLToPath(new URL("./poolHub.ts", import.meta.url));

/** The hub the pool is set up on, answering the screen with its own pool code. */
class PoolHub {
  private readonly dir = mkdtempSync(join(tmpdir(), "crosstalk-pool-browser-"));
  socket: WebSocketRoute | undefined;
  /** What the screen sent, as the hub got it. */
  readonly puts: { config: Partial<PoolView["config"]> }[] = [];
  readonly tokens: (string | null)[] = [];
  readonly commands: string[] = [];
  starts = 0;
  /** The last helper command the hub gave, and the short one to type. */
  command: string | null = null;
  short: string | null = null;
  /** Requests the hub has no route for, and changes it refused: neither may happen. */
  readonly unexpected: string[] = [];
  readonly refused: string[] = [];
  state: HubState = {
    name: MAC.name,
    kv: {},
    states: [],
    infos: {},
    status: null,
    links: [{ id: LINUX_BOX.id, name: LINUX_BOX.name, scope: "full", node: linuxInfo }],
    self: macInfo,
    pings,
    tailscale: tailscaleStatus,
    // The PowerShell window with gaming-pc's helper is open.
    helpers: [`${WIN.address}:50052`],
    hf: { [REPO]: { gated: "manual", files: hfFiles } },
  };

  /** Runs one of the hub's pool calls (poolHub.ts); what it changed is kept for the next. */
  run(op: Record<string, unknown>): Answer {
    // A Crosstalk variable from the shell (the live hub's) must never reach the hub's code.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CROSSTALK_")));
    const p = spawnSync("bun", [script], {
      input: JSON.stringify({ ...op, hub: this.state }),
      env: { ...env, CROSSTALK_HOME: join(this.dir, "home"), CROSSTALK_WORKSPACES: join(this.dir, "workspaces") },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (p.status !== 0) throw new Error(`The hub's pool code failed (${op.op}): ${p.stderr || p.error?.message}`);
    const out = JSON.parse(p.stdout) as Answer;
    if (out.ok) this.state = out.hub;
    return out;
  }

  result<T>(op: Record<string, unknown>): T {
    const out = this.run(op);
    if (!out.ok) throw new Error(`The hub refused ${op.op}: ${out.error}`);
    return out.result as T;
  }

  view = () => this.result<PoolView>({ op: "view" });

  // Getting the hub ready before the screen opens.
  check = () => this.result<PoolView>({ op: "check" });
  addPc = () => this.result<PoolView>({ op: "update", body: { config: { machines: [...this.view().config.machines, winMachine] } } });
  choose(quant: string): PoolModel {
    const model = this.result<PoolModelChoices>({ op: "models", repo: REPO }).models.find((m) => m.quant === quant)!;
    this.result({ op: "update", body: { config: { model } } });
    return model;
  }
  saveToken = () => this.result({ op: "hfToken", body: { token: HF_TOKEN } });

  // The hub at work: what a start, a check or a stop changes, then its event.
  setStatus(change: Partial<PoolStatus>) {
    // Asked first: a call replaces `state`.
    const now = this.view().status;
    this.state.status = { ...now, ...change };
  }
  setMachine(id: string, change: Partial<Omit<PoolMachineState, "id">>) {
    const cur = this.state.states.find((s) => s.id === id) ?? { id, devices: [], link: null, state: "unknown" as const, detail: null, checkedAt: 0 };
    this.state.states = [...this.state.states.filter((s) => s.id !== id), { ...cur, ...change, id }];
  }
  /** The hub's `pool` event with its view now. */
  push(): PoolView {
    if (!this.socket) throw new Error("The page isn't connected to the hub yet.");
    const view = this.view();
    this.socket.send(JSON.stringify({ t: "pool", pool: view }));
    return view;
  }
  /** What a start says while linux-box loads the model (loadingDetail). */
  loading = (lines: string[], elapsedMs: number) => this.result<string>({ op: "loading", loading: { lines, elapsedMs, where: LINUX_BOX.name, helpers: true } });
  speed = () => this.result<PoolStatus["speed"]>({ op: "metrics", metrics: METRICS });
  /** The server answers: the custom-model accounts are offered and every machine taking part shows its part (serve()). */
  running(log: string[]) {
    this.setMachine(LINUX_BOX.id, { state: "running", detail: "Runs the model server." });
    this.setMachine(WIN.id, { state: "running", detail: "Lending its GPU to the pool." });
    this.setStatus({
      state: "running",
      detail: "Running on the GPUs of linux-box and gaming-pc.",
      download: null,
      endpoint: { baseUrl: `http://${LINUX_BOX.address}:9931`, model: "qwen3.8-27b", contextWindow: 65536 },
      accounts: { claude: "3f9c1a2b", codex: "b07e44d1" },
      startedAt: Date.now(),
      log,
    });
  }

  /** Answers the screen: the routes in docs/MODEL-POOL.md. */
  async serve(page: Page) {
    await page.routeWebSocket("**/api/ws?**", (ws) => {
      this.socket = ws;
      ws.onMessage((data) => {
        if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      });
    });
    await page.route(/\/api\/pool(?:[/?]|$)/, (route) => this.answer(route));
  }

  private async answer(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const at = `${req.method()} ${url.pathname}`;
    // As the hub does: its events first, then the answer.
    const reply = (out: Answer) => {
      if (!out.ok) {
        if (at === "PUT /api/pool") this.refused.push(out.error);
        return route.fulfill({ status: out.status, json: { error: out.error, ...(out.code ? { code: out.code } : {}) } });
      }
      for (const e of out.events) this.socket?.send(JSON.stringify(e));
      return route.fulfill({ json: out.result });
    };
    if (at === "GET /api/pool") return reply(this.run({ op: "view" }));
    if (at === "PUT /api/pool") {
      const body = req.postDataJSON();
      this.puts.push(body);
      return reply(this.run({ op: "update", body }));
    }
    if (at === "POST /api/pool/check") return reply(this.run({ op: "check" }));
    if (at === "GET /api/pool/models") return reply(this.run({ op: "models", repo: url.searchParams.get("repo") ?? "" }));
    if (at === "PUT /api/pool/hf-token") {
      const body = req.postDataJSON();
      this.tokens.push(body.token);
      return reply(this.run({ op: "hfToken", body }));
    }
    if (at === "GET /api/pool/helper-command") {
      this.commands.push(url.search);
      const out = this.run({ op: "helperCommand", query: url.search.slice(1) });
      if (out.ok) {
        const r = out.result as { command: string; short?: string };
        this.command = r.command;
        this.short = r.short ?? null;
      }
      return reply(out);
    }
    if (at === "GET /api/pool/tailscale") return reply(this.run({ op: "tailscale" }));
    if (at === "POST /api/pool/start") {
      // start(): it answers at once, and the rest follows as events.
      this.starts++;
      this.setStatus({ state: "preparing", detail: "Asking the machines…", download: null, endpoint: null, speed: null, startedAt: null, log: [] });
      return route.fulfill({ json: this.push() });
    }
    if (at === "POST /api/pool/stop") {
      // stop() and halt(): the server first; a PC's helper is its window's to close.
      if (this.view().status.state === "off") return route.fulfill({ json: this.view() });
      this.setStatus({ state: "stopping", detail: "Stopping the model pool…" });
      this.push();
      if (this.state.states.find((s) => s.id === LINUX_BOX.id)?.state === "running") this.setMachine(LINUX_BOX.id, { state: "ready", detail: null });
      if (this.state.states.find((s) => s.id === WIN.id)?.state === "running") this.setMachine(WIN.id, { state: "ready", detail: "Its helper keeps running there: close its window to stop it." });
      this.setStatus({ state: "off", detail: "The helper on gaming-pc keeps running there: close its window to stop it.", download: null, endpoint: null, speed: null, startedAt: null });
      return route.fulfill({ json: this.push() });
    }
    this.unexpected.push(at);
    return route.fulfill({ status: 404, json: { error: "not found" } });
  }

  close() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const test = base.extend<{ hub: PoolHub }>({
  hub: async ({ page }, use) => {
    const hub = new PoolHub();
    await hub.serve(page);
    try {
      await use(hub);
    } finally {
      hub.close();
    }
    expect(hub.unexpected, "The screen only uses routes the hub has").toEqual([]);
    expect(hub.refused, "The hub takes every change the screen sends").toEqual([]);
  },
});

// ---- The screen ----

const region = (page: Page) => page.getByRole("region", { name: "Model pool", exact: true });
const row = (page: Page, name: string) => region(page).locator(".pool-machine").filter({ hasText: name });
/** The pool's state, as the pill at the top says it. */
const pill = (page: Page) => region(page).locator(".pool-head").getByRole("status");
/** A two-step button ignores a second tap that comes right after the first (a double tap): wait it out. */
const pastDoubleTap = (page: Page) => page.waitForTimeout(450);

async function openPool(page: Page, hub: PoolHub) {
  await page.goto("/#/settings/model-pool");
  await expect(region(page)).toBeVisible();
  await expect.poll(() => !!hub.socket).toBe(true);
  await page.locator("#model-pool").evaluate((el) => el.scrollIntoView({ block: "start" }));
}

/** What the page copies goes to `window.copied` instead of the clipboard (which tests can't read in every engine). */
async function catchCopies(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void w.copied.push(text) } });
  });
}
const copies = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied);

/**
 * Where sheets, dialogs and the layout end up, not where their animation has them: a transition a resize starts
 * begins on the next frame, so two frames go by first.
 */
const settle = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });

/** Nothing on the pool's screen, or in a dialog open on it, reaches past a 390 or a 320 px wide phone. */
async function fitsPhones(page: Page) {
  const size = page.viewportSize()!;
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: size.height });
    await settle(page);
    await noHorizontalOverflow(page);
    const wide = await page.evaluate(() => {
      const out: string[] = [];
      for (const root of document.querySelectorAll('section[aria-label="Model pool"], [role="dialog"]')) {
        for (const el of [root, ...root.querySelectorAll("*")]) {
          const r = el.getBoundingClientRect();
          // Not drawn (a closed Advanced section): where it would be doesn't matter.
          if (!r.width || !r.height || el.checkVisibility?.() === false) continue;
          if (r.left < -1 || r.right > innerWidth + 1) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}" spans ${Math.round(r.left)} to ${Math.round(r.right)} on a ${innerWidth}px screen`);
        }
      }
      return out;
    });
    expect(wide, `At ${width} px`).toEqual([]);
  }
  await page.setViewportSize(size);
  await settle(page);
}

/**
 * CT_SHOTS: a folder to save the screens in. The 390 px Chromium ones are the ones to look at; others go in a folder per
 * screen size. `whole`: the screen as tall as the pool's section, to see all of it at once.
 */
async function shot(page: Page, name: string, { whole = false } = {}) {
  const dir = process.env.CT_SHOTS;
  if (!dir) return;
  const project = test.info().project.name;
  const size = page.viewportSize()!;
  const top = () => page.locator("#model-pool").evaluate((el) => el.scrollIntoView({ block: "start" }));
  if (whole) {
    await page.setViewportSize({ width: size.width, height: 2400 });
    await top();
    const end = await region(page).evaluate((el) => el.getBoundingClientRect().bottom);
    await page.setViewportSize({ width: size.width, height: Math.ceil(Math.min(2400, end + 24)) });
    await top();
  }
  await settle(page);
  await page.screenshot({ path: project === "chromium-390" ? join(dir, name) : join(dir, project, name), animations: "disabled" });
  if (whole) {
    await page.setViewportSize(size);
    await settle(page);
  }
}

// ---- The tests ----

test("a pool: this Mac left out, linux-box holds the model, gaming-pc lends its GPU through a relay", async ({ page, hub }) => {
  hub.addPc();
  await openPool(page, hub);
  // Never checked: the screen asks the hub to check its machines once, by itself.
  await expect(row(page, "gaming-pc")).toContainText("Its helper answers at 100.88.12.40:50052.");
  const pool = region(page);
  await expect(pill(page)).toHaveText("Off");
  await expect(pool).toContainText("Choose a model below, then start it.");
  await expect(pool.getByRole("button", { name: "Start", exact: true })).toBeDisabled();

  // This Mac: left out, saying why in one line.
  const mac = row(page, "Mac mini");
  await expect(mac.locator(".pill")).toHaveText("Left out");
  await expect(mac).toContainText("Left out: slowest GPU, and it runs your chats. Switch it on to lend it too.");
  await expect(mac).not.toContainText("Its GPUs show once llama.cpp is on it");
  await expect(mac.getByRole("checkbox", { name: "Use the GPU on Mac mini", exact: true })).not.toBeChecked();
  await expect(mac.getByRole("button", { name: "Make this the main machine (Mac mini)", exact: true })).toBeVisible();

  // linux-box: the main machine, its RX 7600 XT, straight over the home network.
  const box = row(page, "linux-box");
  await expect(box.locator(".pill")).toHaveText("Main machine");
  await expect(box).toContainText("Holds the model and answers chats.");
  await expect(box).toContainText("RX 7600 XT · 16 GB");
  await expect(box).toContainText("Direct · 2 ms");
  await expect(box.getByRole("checkbox", { name: "Use the GPU on linux-box", exact: true })).toBeChecked();

  // gaming-pc: a helper through a relay. Its GPU can't be seen from here, which isn't "No GPU found".
  const pc = row(page, "gaming-pc");
  await expect(pc.locator(".pill")).toHaveText("Helper");
  await expect(pc).toContainText("Through a relay · 41 ms: slower");
  await expect(pc).toContainText("100.88.12.40 · Windows · NVIDIA (CUDA)");
  await expect(pc).not.toContainText("No GPU found");
  await expect(pc.getByRole("button", { name: "Helper command for gaming-pc", exact: true })).toBeVisible();
  await expect(pool).toContainText("Keep your tailnet to your own devices: a helper has no password of its own.");
  await fitsPhones(page);
});

test("adding gaming-pc: picked from Tailscale, saved as a computer the hub takes, its helper command shown and copied", async ({ page, hub }) => {
  await catchCopies(page);
  hub.check();
  await openPool(page, hub);
  await region(page).getByRole("button", { name: "Add a Windows or other PC", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // This hub's tailnet: the Windows PC is offered; the iPhone can't lend a GPU and linux-box is in the pool already.
  const which = dialog.getByRole("radiogroup", { name: "Which PC", exact: true });
  await expect(which.getByRole("radio")).toHaveCount(1);
  const peer = which.getByRole("radio", { name: /gaming-pc/ });
  await expect(peer).toContainText("100.88.12.40 · Windows · online, through a relay");
  await peer.click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("gaming-pc");
  await expect(dialog.getByRole("textbox", { name: "Or type its Tailscale address", exact: true })).toHaveValue("100.88.12.40");
  // A keypad with a dot in every region ("decimal" has a comma in some), and the helper's port, which can be changed.
  await expect(dialog.getByRole("textbox", { name: "Or type its Tailscale address", exact: true })).toHaveAttribute("inputmode", "url");
  await expect(dialog.getByRole("textbox", { name: "Helper port", exact: true })).toHaveValue("50052");
  await expect(dialog.getByRole("radiogroup", { name: "Its system", exact: true }).getByRole("radio", { name: "Windows", exact: true })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("radio", { name: /NVIDIA \(CUDA, faster\)/ }).click();
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();

  // Saved the way the hub takes it (its own checks ran on what was sent).
  await expect.poll(() => hub.puts.length).toBe(1);
  const added = hub.puts[0].config.machines!.at(-1)!;
  expect(added).toMatchObject({ kind: "computer", name: "gaming-pc", address: "100.88.12.40", os: "windows", backend: "cuda", enabled: true, rpcPort: 50052 });
  expect(added.id).toMatch(/^pc_[a-z0-9]{8}$/);
  expect(hub.puts[0].config.machines!.map((m) => m.id)).toEqual(["self", LINUX_BOX.id, added.id]);

  // The command leads the dialog now: a short one to type on the PC (it fetches the long one from this hub over
  // Tailscale), then the hub's own full PowerShell line for this PC, its address and CUDA, to paste instead.
  await expect(dialog.getByRole("heading", { name: "gaming-pc", exact: true })).toBeVisible();
  const [short, code] = [dialog.locator(".command-box code").first(), dialog.locator(".command-box code").last()];
  expect(hub.commands).toEqual([`?machine=${added.id}&os=windows&backend=cuda`]);
  expect(hub.short).toMatch(/^\[Net\.ServicePointManager\]::SecurityProtocol=3072; irm https:\/\/mac-mini\.tail4f2a1\.ts\.net\/api\/pool\/helper\/[a-z0-9]{20} \| iex$/);
  await expect(short).toHaveText(hub.short!);
  await expect(dialog).toContainText("On the PC, open PowerShell, type this and press Enter. Keep the window open while you use the pool, and run it again after the PC restarts.");
  await expect(dialog).toContainText("On your phone?");
  await expect(dialog).toContainText("Or paste the full command");
  await expect(code).toContainText("$b='b11669'; $k='cuda'; $p=50052; $want='100.88.12.40'");
  await expect(code).toHaveText(hub.command!);
  await expect(dialog).toContainText("Needs NVIDIA driver 551.61 or newer: update it from nvidia.com if the helper doesn't start.");
  await shot(page, "pool-add-pc.png");
  await dialog.getByRole("button", { name: "Copy short command", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
  expect(await copies(page)).toEqual([hub.short, hub.command]);
  await fitsPhones(page);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // In the list as a helper, not checked yet; checking reaches its helper through the relay.
  const pc = row(page, "gaming-pc");
  await expect(pc.locator(".pill")).toHaveText("Helper");
  await expect(pc).toContainText("Not checked yet");
  await region(page).getByRole("button", { name: "Check the machines", exact: true }).click();
  await expect(pc).toContainText("Its helper answers at 100.88.12.40:50052.");
  await expect(pc).toContainText("Through a relay · 41 ms: slower");
});

test("choosing orcarouter/Qwen3.8-27B-GGUF Q4_K_M: each quant says how it fits, then the token it needs", async ({ page, hub }) => {
  hub.addPc();
  hub.check();
  await openPool(page, hub);
  const pool = region(page);
  await pool.getByRole("button", { name: "Choose a model", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model", exact: true });
  await expect(dialog).toContainText("The machines taking part have about 15.5 GB free that Crosstalk has counted, plus what gaming-pc has: its GPU memory is counted once its helper runs and you check the machines.");
  await dialog.getByLabel("Hugging Face link", { exact: true }).fill(REPO);
  await dialog.getByRole("button", { name: "Show files", exact: true }).click();

  const files = dialog.getByRole("region", { name: "Qwen3.8-27B files", exact: true });
  await expect(files).toContainText("Gated: accept its terms on its page first, then add your Hugging Face token under Model.");
  // Smallest first, as the hub lists them: BF16's two parts as one model, the vision add-on left out.
  await expect(files.locator(".pool-file .pool-repo")).toHaveText([
    "Qwen3.8-27B-Q2_K.gguf",
    "Qwen3.8-27B-Q3_K_M.gguf",
    "Qwen3.8-27B-IQ4_XS.gguf",
    Q4,
    "Qwen3.8-27B-Q5_K_M.gguf",
    "Qwen3.8-27B-Q6_K.gguf",
    "Qwen3.8-27B-Q8_0.gguf",
    "Qwen3.8-27B-BF16-00001-of-00002.gguf",
  ]);
  // Each weighed as the hub does (file + 64k of context + 1 GB a machine): the RX 7600 XT's 15.5 GB is all it can
  // count, so each file says what gaming-pc's GPU has to add.
  const file = (quant: string) => files.getByRole("button", { name: new RegExp(`^${quant} `) });
  await expect(file("Q2_K")).toContainText("Needs 2.5 GB more");
  await expect(file("Q3_K_M")).toContainText("Needs 5.2 GB more");
  await expect(file("Q4_K_M")).toContainText("Needs 8.2 GB more");
  await expect(file("Q4_K_M")).toContainText("15.7 GB");
  await expect(file("Q5_K_M")).toContainText("Needs 10.8 GB more");
  await expect(file("BF16")).toContainText("51.2 GB in 2 parts");
  await expect(files.getByText("Too big", { exact: true })).toHaveCount(0);
  await shot(page, "pool-choose-model.png");
  await fitsPhones(page);
  await file("Q4_K_M").click();
  await expect(dialog).toHaveCount(0);

  // What the hub listed went back to it as it was.
  expect(hub.puts).toEqual([{ config: { model: { repo: REPO, files: [Q4], quant: "Q4_K_M", sizeBytes: Q4_BYTES, gated: true } } }]);
  await expect(pool.locator(".pool-model-name")).toHaveText("Qwen3.8-27B Gated");
  await expect(pool).toContainText("Q4_K_M · 15.7 GB");
  // The hub's fit: more than the RX 7600 XT has, but the PC isn't counted, so it may fit (at 64k it needs 8.2 GB there,
  // and its RTX 3060 has 8 GB: a smaller context or quant would fit).
  const fit = pool.locator(".pool-fit");
  await expect(fit).toContainText("Needs about 23.7 GB of 15.5 GB counted");
  await expect(fit.locator(".pill")).toHaveText("Maybe");
  await expect(fit).toContainText("Crosstalk can't see the GPU memory of gaming-pc, so it isn't counted here.");
  await expect(fit).toContainText("It fits if gaming-pc has about 8.2 GB free on its GPU.");

  // Gated: the token is asked for at once, saved on the hub and never shown again.
  const token = pool.getByLabel("Hugging Face token", { exact: true });
  await expect(token).toBeFocused();
  await token.fill(HF_TOKEN);
  await pool.getByRole("button", { name: "Save token", exact: true }).click();
  await expect(pool.locator(".pool-token-head")).toContainText("Saved");
  expect(hub.tokens).toEqual([HF_TOKEN]);
  await expect(token).toHaveCount(0);
  await expect(pool).not.toContainText(HF_TOKEN);
  await expect(pool).toContainText("Ready to start Qwen3.8-27B.");
});

test("starting: pool events take it through downloading and starting to running, and Stop leaves the PC's helper to its window", async ({ page, hub }) => {
  hub.addPc();
  hub.check();
  hub.choose("Q4_K_M");
  hub.saveToken();
  await openPool(page, hub);
  const pool = region(page);
  await expect(pool).toContainText("Ready to start Qwen3.8-27B.");
  await pool.getByRole("button", { name: "Start", exact: true }).click();
  await expect(pill(page)).toHaveText("Preparing");
  await expect(pool).toContainText("Asking the machines…");
  expect(hub.starts).toBe(1);

  // The hub checks the PC's helper…
  hub.setStatus({ detail: "Checking the helper on gaming-pc…" });
  hub.push();
  await expect(pool).toContainText("Checking the helper on gaming-pc…");
  hub.setMachine(WIN.id, { state: "ready", detail: `Its helper answers at ${WIN.address}:50052.`, checkedAt: Date.now() });

  // …downloads the model to linux-box (with the token, for that only)…
  hub.setStatus({ state: "downloading", detail: "Downloading Qwen3.8-27B (Q4_K_M) to linux-box…", download: { file: Q4, doneBytes: 0, totalBytes: Q4_BYTES, bytesPerSec: null } });
  hub.push();
  await expect(pill(page)).toHaveText("Downloading");
  hub.setStatus({ download: { file: Q4, doneBytes: 7_062_204_416, totalBytes: Q4_BYTES, bytesPerSec: 41_943_040 } });
  hub.push();
  const bar = pool.getByRole("progressbar", { name: "Model download", exact: true });
  await expect(bar).toHaveAttribute("aria-valuenow", "42");
  await expect(pool).toContainText("42% · 6.6 GB of 15.7 GB · 40 MB/s · about 4 min left");
  await expect(pool).toContainText("Downloading Qwen3.8-27B (Q4_K_M) to linux-box…");
  await expect(pool.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await fitsPhones(page);

  // …and starts its server, the helper's part going over the network.
  hub.setMachine(LINUX_BOX.id, { state: "running", detail: "Loading the model…" });
  hub.setStatus({ state: "starting", detail: "Starting the model server on linux-box…", download: null, endpoint: null });
  hub.push();
  await expect(pill(page)).toHaveText("Starting");
  await expect(bar).toHaveCount(0);
  await expect(row(page, "linux-box")).toContainText("Loading the model…");
  hub.setStatus({ detail: hub.loading(LOADING, 75_000), log: LOADING });
  hub.push();
  await expect(pool).toContainText("Loading the model on linux-box: reading the model (1 min so far). The helpers get their part over the network, which takes a while the first time.");

  // Running: where chats reach it, the context llama.cpp gave, and each machine's part; the fit is what's known now.
  hub.running(LOADED);
  hub.push();
  await expect(pill(page)).toHaveText("Running");
  await expect(pool).toContainText("Running on the GPUs of linux-box and gaming-pc.");
  await expect(pool).toContainText(`Chats reach it at http://${LINUX_BOX.address}:9931 as qwen3.8-27b`);
  await expect(pool).toContainText("It gave 64k tokens of context.");
  await expect(pool.locator(".pool-fit")).toContainText("It fits: it's running now.");
  await expect(pool.locator(".pool-fit")).not.toContainText("Maybe");
  await expect(pool).toContainText("Use it in a chat: start a Claude Code or Codex chat and pick the Model pool account.");
  await expect(row(page, "linux-box")).toContainText("Runs the model server.");
  await expect(row(page, "gaming-pc")).toContainText("Lending its GPU to the pool.");
  // After a reply, how fast it reads and writes (from llama-server's /metrics).
  hub.setStatus({ speed: hub.speed(), log: REPLIED });
  hub.push();
  await expect(pool).toContainText("Speed: reads 164 tokens/s · writes 8.4 tokens/s");
  await shot(page, "pool-overview.png", { whole: true });
  const output = pool.locator("details.pool-log");
  await output.locator("summary").click();
  await expect(output.locator("pre")).toContainText(`listening on http://${LINUX_BOX.address}:9931`);
  await expect(output.locator("pre")).toContainText("8.42 tokens per second");
  await fitsPhones(page);

  // Stop: the server ends; the PC's helper is its own window's to close.
  await pool.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(pill(page)).toHaveText("Off");
  await expect(pool).toContainText("The helper on gaming-pc keeps running there: close its window to stop it.");
  await expect(row(page, "gaming-pc")).toContainText("Its helper keeps running there: close its window to stop it.");
  await expect(pool.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
});

test("a problem: gaming-pc's helper isn't running, its helper command is the fix, then Try again starts the pool", async ({ page, hub }) => {
  await catchCopies(page);
  hub.addPc();
  hub.check();
  hub.choose("Q4_K_M");
  hub.saveToken();
  // The PowerShell window on the PC was closed since: its helper doesn't answer.
  hub.state.helpers = [];
  await openPool(page, hub);
  const pool = region(page);
  await pool.getByRole("button", { name: "Start", exact: true }).click();
  await expect(pill(page)).toHaveText("Preparing");
  hub.setStatus({ detail: "Checking the helper on gaming-pc…" });
  hub.push();
  // checkComputers(): in the hub's words, on the PC's row and for the whole pool.
  hub.setMachine(WIN.id, { state: "offline", detail: `Its helper doesn't answer at ${WIN.address}:50052: run its helper command there.`, checkedAt: Date.now() });
  hub.setStatus({ state: "error", detail: `The helper on gaming-pc doesn't answer at ${WIN.address}:50052. Run its helper command there (Helper command next to it), then start again.`, download: null, endpoint: null, speed: null, startedAt: null });
  hub.push();
  await expect(pill(page)).toHaveText("Problem");
  await expect(pool.locator(".pool-detail")).toHaveText("The helper on gaming-pc doesn't answer at 100.88.12.40:50052. Run its helper command there (Helper command next to it), then start again.");
  // Its fixes: the PC's command first (the main button), checking again, then Try again and Stop.
  const actions = pool.locator(".pool-actions").getByRole("button");
  await expect(actions).toHaveText(["Show the helper command", "Check the machines", "Try again", "Stop"]);
  await expect(actions.first()).toHaveClass(/primary/);
  await expect(row(page, "gaming-pc")).toContainText("Its helper doesn't answer at 100.88.12.40:50052: run its helper command there.");
  await shot(page, "pool-problem.png");
  await fitsPhones(page);

  // The fix opens the PC's dialog with its command, to copy and run there.
  await actions.getByText("Show the helper command", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "gaming-pc", exact: true });
  await expect(dialog).toContainText("Run this on gaming-pc");
  await expect(dialog.locator(".command-box code").first()).toHaveText(hub.short!);
  await expect(dialog.locator(".command-box code").last()).toContainText("$want='100.88.12.40'");
  await expect(dialog.locator(".command-box code").last()).toHaveText(hub.command!);
  await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
  expect(await copies(page)).toEqual([hub.command]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Run there: checking again finds the helper…
  hub.state.helpers = [`${WIN.address}:50052`];
  await pool.locator(".pool-actions").getByRole("button", { name: "Check the machines", exact: true }).click();
  await expect(row(page, "gaming-pc")).toContainText("Its helper answers at 100.88.12.40:50052.");
  // …and Try again starts the pool.
  await pool.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(pill(page)).toHaveText("Preparing");
  expect(hub.starts).toBe(2);
  hub.running(LOADED);
  hub.push();
  await expect(pill(page)).toHaveText("Running");
  await expect(pool.locator(".pool-actions").getByRole("button")).toHaveText(["Stop"]);
});

test("a problem: Hugging Face won't let linux-box download the gated model yet; its page and the token are the fixes", async ({ page, hub }) => {
  hub.addPc();
  hub.check();
  hub.choose("Q4_K_M");
  await openPool(page, hub);
  const pool = region(page);
  await pool.getByRole("button", { name: "Start", exact: true }).click();
  await expect(pill(page)).toHaveText("Preparing");
  hub.setStatus({ state: "downloading", detail: "Downloading Qwen3.8-27B (Q4_K_M) to linux-box…", download: { file: Q4, doneBytes: 0, totalBytes: Q4_BYTES, bytesPerSec: null } });
  hub.push();
  await expect(pill(page)).toHaveText("Downloading");
  // models.ts termsError, through linux-box's download.
  hub.setStatus({
    state: "error",
    detail: `linux-box: Hugging Face won't let this download ${REPO} yet: open huggingface.co/${REPO}, accept the model's terms, then save a Hugging Face token (from the same account) and try again.`,
    download: null,
    endpoint: null,
    speed: null,
    startedAt: null,
  });
  hub.push();
  await expect(pill(page)).toHaveText("Problem");
  const actions = pool.locator(".pool-actions");
  await expect(actions.getByRole("link", { name: "Open the model's page", exact: true })).toHaveAttribute("href", `https://huggingface.co/${REPO}`);
  await expect(actions.getByRole("button")).toHaveText(["Add your Hugging Face token", "Try again", "Stop"]);
  await actions.getByRole("button", { name: "Add your Hugging Face token", exact: true }).click();
  const token = pool.getByLabel("Hugging Face token", { exact: true });
  await expect(token).toBeFocused();
  await token.fill(HF_TOKEN);
  await pool.getByRole("button", { name: "Save token", exact: true }).click();
  await expect(pool.locator(".pool-token-head")).toContainText("Saved");
  expect(hub.tokens).toEqual([HF_TOKEN]);
  await fitsPhones(page);
  await actions.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(pill(page)).toHaveText("Preparing");
  expect(hub.starts).toBe(2);
});

test("a repo Hugging Face won't list without a token: the model dialog leads straight to the token field", async ({ page, hub }) => {
  hub.check();
  await openPool(page, hub);
  await region(page).getByRole("button", { name: "Choose a model", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model", exact: true });
  await dialog.getByLabel("Hugging Face link", { exact: true }).fill("someone/Private-Model-GGUF");
  await dialog.getByRole("button", { name: "Show files", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Couldn't find someone/Private-Model-GGUF on Hugging Face: check the name. If it's private, save a Hugging Face token first.");
  // Back to the suggestions is a full-size button on a phone, not a thin link.
  const back = dialog.getByRole("button", { name: "Suggestions", exact: true });
  if (page.viewportSize()!.width <= 760) expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await fitsPhones(page);
  await dialog.getByRole("button", { name: "Add your Hugging Face token", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(region(page).getByLabel("Hugging Face token", { exact: true })).toBeFocused();
});

test("Kimi K3.1 Pro can't run on these machines: its entry opens the Moonshot preset for Claude Code and for Codex", async ({ page, hub }) => {
  hub.addPc();
  hub.check();
  await openPool(page, hub);
  const choose = async () => {
    await region(page).getByRole("button", { name: "Choose a model", exact: true }).click();
    const kimi = page.getByRole("dialog", { name: "Choose a model", exact: true }).getByRole("group", { name: "Kimi K3.1 Pro", exact: true });
    await expect(kimi).toContainText("It doesn't fit here: about 600 GB even at 1-bit, and its weights are only due Nov 4. Moonshot's API runs it instead, paid per use.");
    return kimi;
  };
  await (await choose()).getByRole("button", { name: "Use it in Claude Code", exact: true }).click();
  const claude = page.getByRole("dialog", { name: "Add a custom model for Claude Code", exact: true });
  await expect(claude.getByRole("radio", { name: /Kimi K3\.1 Pro \(Moonshot API\)/ })).toHaveAttribute("aria-checked", "true");
  await expect(claude).toContainText("Paid per use: about $2 per million tokens in and $10 out (Oct 2026).");
  await expect(claude.getByLabel(/^Server address/)).toHaveValue("https://api.moonshot.ai/anthropic");
  await expect(claude.getByLabel(/^Models/)).toHaveValue("kimi-k3.1-pro, kimi-k3.1-pro-highspeed");
  await expect(claude.getByLabel(/^Context size/)).toHaveValue("1048576");
  await expect(claude.getByLabel(/^Name/)).toHaveValue("Kimi K3.1 Pro");
  // Moonshot bills the key: nothing is saved without it (and nothing here asks Moonshot anything).
  await expect(claude.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  // The key comes first; what the preset filled in is folded away under Details.
  const key = claude.getByLabel(/^API key/);
  await expect(key).toBeVisible();
  await expect(claude.getByLabel(/^Server address/)).toBeHidden();
  await claude.locator("summary", { hasText: "Details" }).click();
  await expect(claude.getByLabel(/^Server address/)).toBeVisible();
  await fitsPhones(page);
  // A pasted key isn't lost to a stray tap or Escape: it asks first.
  await key.fill("sk-not-a-real-key-0000");
  await page.keyboard.press("Escape");
  await expect(claude.getByRole("alert")).toContainText("Discard changes?");
  await claude.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(key).toHaveValue("sk-not-a-real-key-0000");
  await claude.getByRole("button", { name: "Cancel", exact: true }).click();
  await claude.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(claude).toHaveCount(0);

  await (await choose()).getByRole("button", { name: "Use it in Codex", exact: true }).click();
  const codex = page.getByRole("dialog", { name: "Add a custom model for Codex", exact: true });
  await expect(codex.getByLabel(/^Server address/)).toHaveValue("https://api.moonshot.ai");
  await expect(codex.getByLabel(/^Models/)).toHaveValue("kimi-k3.1-pro, kimi-k3.1-pro-highspeed");
  await codex.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(codex).toHaveCount(0);
});

test("switching gaming-pc off, then removing it in two steps: each sends the whole machine list, and the hub takes both", async ({ page, hub }) => {
  hub.addPc();
  hub.check();
  await openPool(page, hub);
  const pc = row(page, "gaming-pc");
  await pc.getByRole("checkbox", { name: "Use the GPU on gaming-pc", exact: true }).uncheck();
  await expect.poll(() => hub.puts.length).toBe(1);
  expect(hub.puts[0].config.machines?.map((m) => [m.id, m.enabled])).toEqual([["self", false], [LINUX_BOX.id, true], [WIN.id, false]]);
  await expect(pc.locator(".pill")).toHaveText("Left out");

  // The first tap only asks.
  await pc.getByRole("button", { name: "Remove gaming-pc", exact: true }).click();
  const ask = region(page).getByRole("group", { name: "Remove gaming-pc from the pool?", exact: true });
  await expect(ask).toBeVisible();
  expect(hub.puts).toHaveLength(1);
  await pastDoubleTap(page);
  await ask.getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(() => hub.puts.length).toBe(2);
  expect(hub.puts[1].config.machines?.map((m) => m.id)).toEqual(["self", LINUX_BOX.id]);
  await expect(pc).toHaveCount(0);
  await expect(row(page, "linux-box")).toBeVisible();
});

test("Add a Linux machine explains itself and opens Machines → Set up a Linux machine", async ({ page, hub }) => {
  hub.check();
  await page.route("**/api/machines/invite", (route) => route.fulfill({ json: { token: "browser-invite", command: "curl -fsSL https://hub.example/linux-setup | sh", expiresAt: Date.now() + 3_600_000 } }));
  await page.route("**/api/machines/invites/*", (route) => route.fulfill({ json: { status: "waiting" } }));
  await openPool(page, hub);
  await region(page).getByRole("button", { name: "Add a Linux machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Linux machine", exact: true });
  await expect(dialog).toContainText("it does everything there itself");
  await expect(dialog).toContainText("Once it's linked, it shows up here, switched on (it becomes the main machine unless you picked another).");
  await dialog.getByRole("button", { name: "Set up a Linux machine", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Machines is a tab of its own: it opens, with the setup there.
  await expect(page.getByRole("tab", { name: "Machines", exact: true })).toHaveAttribute("aria-selected", "true");
  const command = page.getByText("curl -fsSL https://hub.example/linux-setup | sh", { exact: true });
  await expect(command).toBeVisible();
  // Asked for once: leaving the tab and coming back doesn't open the setup again by itself.
  await settingsTab(page, "Devices");
  await settingsTab(page, "Machines");
  await expect(command).toHaveCount(0);
});
