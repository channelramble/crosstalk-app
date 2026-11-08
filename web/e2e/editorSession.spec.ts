import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// The image editor's phone page as one shared edit (editor/phone_editor/editor.html), driven against
// hub/test/fixtures/fake-comfy-editor.ts — a stand-in that answers the ComfyUI routes the page uses with the
// shapes the real server uses. Nothing here touches a real ComfyUI: the stand-in runs on a free port
// from its own temporary folder, and a real editor on this machine is never asked anything. Every picture is a
// generated gradient. The stand-in's "edit" keeps the red and green of the picture it was sent and sets its blue,
// so a result put back in the photo says, pixel by pixel, which pixel of the photo it was made from: one blended in
// at the wrong place or the wrong scale shows (blendedAtDot).
//
// CROSSTALK_EDITOR_PAGE=<file> serves another copy of the page instead -- a deliberately broken one, to see a test fail.
//
// "Devices" are separate browser contexts with their own localStorage, so each has its own device id and its
// own websocket id — two devices cannot share one (server.py keeps one socket per client id). Closing a device's
// page and opening another in the same context is that device coming back.

const FAKE = fileURLToPath(new URL("../../hub/test/fixtures/fake-comfy-editor.ts", import.meta.url));
const BUN = execFileSync("which", ["bun"]).toString().trim();
const SESSION = "crosstalk-editor-session.json";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** The gradient every test photo is: what a pixel was before any edit. */
const original = (x: number, y: number) => [(x * 5) % 256, (y * 7) % 256, 160, 255];
/** A real PNG, so the page's createImageBitmap and canvas work as they do with a photo. */
function png(w: number, h: number): Buffer {
  const rows = Buffer.concat(
    Array.from({ length: h }, (_, y) => {
      const row = Buffer.alloc(1 + w * 4);
      for (let x = 0; x < w; x++) row.set(original(x, y), 1 + x * 4);
      return row;
    }),
  );
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const PHOTO = { name: "photo.png", mimeType: "image/png", buffer: png(96, 72) };
/** Big enough that a painted dot is a part of it: 640×480, painted at its middle. */
const WIDE = { name: "photo.png", mimeType: "image/png", buffer: png(640, 480) };
const WIDE_SIZE: [number, number] = [640, 480];
/** What the stand-in's edit makes of a pixel of the photo: its red and green, and the edit's blue. */
const edited = (x: number, y: number, blue = 0) => [...original(x, y).slice(0, 2), blue, 255];
/** Points of the 640×480 photo: the painted dot's middle, 60 px right of it (in the edited area, not painted), and far away. */
const DOT: [number, number] = [320, 240];
const BESIDE: [number, number] = [380, 240];
const FAR: [number, number] = [600, 440];
/**
 * The dot is a 36 px brush at 390 px wide: about 63 photo pixels across, from x 288 to 354, with a 5 px soft edge.
 * paint() paints it that size on every screen, except at 1440 px, where the Brush slider runs out at 120 and it is 54
 * across. So it moves Brush off the page's own 36 on every screen but 390, the phones too: to 29 at 320 and 40 at 430,
 * where 36 would paint about 78 and 57 photo pixels across (with 36, the points outside would sit about 8 px nearer the
 * dot's edge at 320 and the points inside 8 px further in; at 430, 3 px the other way), and up towards the slider's end
 * on the wider screens, where 36 paints too small a dot to reach the points inside. Points well inside it (14 px or more
 * inside its edge), and points 18–20 px outside its edge on every side (23–25 at 1440), the same on every phone. All are
 * away from the places where the photo's gradient wraps from 255 to 0, so resampling can't blur them.
 */
const INSIDE: [number, number][] = [DOT, [332, 232]];
const OUTSIDE: [number, number][] = [[372, 240], [268, 240], [320, 188], [320, 292]];

/** The stand-in: its own folder (pictures and the session file live there, as ComfyUI keeps them on disk). */
class Comfy {
  child: ChildProcess | null = null;
  constructor(readonly dir: string, readonly port: number) {}
  config(c: Record<string, unknown>) {
    writeFileSync(join(this.dir, "fake-comfy-editor.json"), JSON.stringify(c));
  }
  async up() {
    const page = process.env.CROSSTALK_EDITOR_PAGE ? ["--editor", process.env.CROSSTALK_EDITOR_PAGE] : [];
    this.child = spawn(BUN, [FAKE, "--port", String(this.port), "--config", join(this.dir, "fake-comfy-editor.json"), ...page], { cwd: this.dir, stdio: "ignore" });
    const until = Date.now() + 20_000;
    for (;;) {
      if (await fetch(`${this.url}/system_stats`).then((r) => r.ok, () => false)) return;
      if (Date.now() > until) throw new Error("the stand-in never answered");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  down() {
    this.child?.kill("SIGKILL");
    this.child = null;
  }
  async restart() {
    this.down();
    await new Promise((r) => setTimeout(r, 150));
    await this.up();
  }
  get url() {
    return `http://127.0.0.1:${this.port}`;
  }
  /** How many edits the server has queued or running. */
  async jobs(): Promise<number> {
    const q = (await (await fetch(`${this.url}/queue`)).json()) as { queue_running: unknown[]; queue_pending: unknown[] };
    return q.queue_running.length + q.queue_pending.length;
  }
  /** What the stand-in saw: uploads, /view reads, queued jobs, cancels. */
  async log(): Promise<{ kind: string; [k: string]: unknown }[]> {
    return (await fetch(`${this.url}/__fake/log`)).json();
  }
  /** The session file as it is on the server's disk. */
  session(): Record<string, any> | null {
    const path = join(this.dir, "userdata", SESSION);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }
  /** Where a job is, as GET /history/{id} says. */
  async history(id: string): Promise<{ status?: { status_str: string } } | undefined> {
    return ((await (await fetch(`${this.url}/history/${id}`)).json()) as Record<string, { status?: { status_str: string } }>)[id];
  }
  /** Writes the session file as a device would have left it. */
  writeSession(s: Record<string, any>) {
    writeFileSync(join(this.dir, "userdata", SESSION), JSON.stringify(s));
  }
  /** Someone else's edit straight into the queue (the hub's warm-up, or ComfyUI's own page): its prompt_id. */
  async queueOther(): Promise<string> {
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(png(64, 48))], { type: "image/png" }), "warmup.png");
    fd.append("subfolder", "");
    fd.append("overwrite", "true");
    await fetch(`${this.url}/upload/image`, { method: "POST", body: fd });
    const id = randomUUID();
    const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
    const prompt = {
      "1": node("UnetLoaderGGUF", { unet_name: "qwen-image-2.1-turbo-Q4_K_M.gguf" }),
      "2": node("CLIPLoaderGGUF", { clip_name: "qwen3vl_8b-Q4_K_M.gguf", type: "qwen_image" }),
      "3": node("VAELoader", { vae_name: "qwen_image_2.1_vae_bf16.safetensors" }),
      "4": node("LoadImage", { image: "warmup.png" }),
      "5": node("TextEncodeQwenImage21", { clip: ["2", 0], prompt: "warm up", negative_prompt: "", vae: ["3", 0], resolution: 768, "images.image_1": ["4", 0] }),
      "6": node("KSampler", { model: ["1", 0], positive: ["5", 0], negative: ["5", 1], latent_image: ["5", 2], seed: 1, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 }),
      "7": node("VAEDecode", { samples: ["6", 0], vae: ["3", 0] }),
      "8": node("SaveImage", { images: ["7", 0], filename_prefix: "warmup" }),
    };
    const r = await fetch(`${this.url}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, client_id: "hub-warmup", prompt_id: id }) });
    if (!r.ok) throw new Error(`the stand-in refused the other edit: ${await r.text()}`);
    return id;
  }
  /** The pictures the page has put in input/crosstalk-editor. */
  uploads(): string[] {
    const dir = join(this.dir, "files", "input", "crosstalk-editor");
    return existsSync(dir) ? readdirSync(dir) : [];
  }
}

let comfy: Comfy;
const opened: BrowserContext[] = [];
const crashes: string[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-editor-session-"));
  comfy = new Comfy(dir, await freePort());
  comfy.config({ editMs: 300 });
  await comfy.up();
});

test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close();
  comfy.down();
  rmSync(comfy.dir, { recursive: true, force: true });
  expect(crashes.splice(0), "no page may crash").toEqual([]);
});

/**
 * WebKit reports a request that a reload or a closed page cancelled as "<url> due to access control checks" (every
 * request here is same-origin, and the page catches its failed fetches): that is the browser's word for "cancelled",
 * not a page crashing. Anything else counts.
 */
const cancelledByNavigation = /^(Fetch API cannot load )?\S+ due to access control checks\.?$/;
async function open(page: Page, name: string) {
  page.on("pageerror", (e) => {
    if (!cancelledByNavigation.test(e.message)) crashes.push(`${name}: ${e.message}`);
  });
  await page.goto(`${comfy.url}/editor`);
  await expect(page.getByRole("heading", { name: "Image Editor" })).toBeVisible();
  return page;
}
/** One device: its own storage, so its own device id, name and websocket id. */
async function device(browser: Browser, id: string, name: string): Promise<Page> {
  const viewport = test.info().project.use.viewport ?? { width: 390, height: 900 };
  const context = await browser.newContext({ viewport });
  opened.push(context);
  await context.addInitScript(([d, n]) => {
    localStorage.setItem("crosstalk.editor.device", d);
    localStorage.setItem("crosstalk.editor.name", n);
  }, [id, name]);
  return open(await context.newPage(), name);
}
/** The same device coming back: its page closed, a new one opened (same storage, so the same device). */
async function reopen(page: Page, name: string): Promise<Page> {
  const context = page.context();
  if (!page.isClosed()) await page.close();
  return open(await context.newPage(), name);
}

const choosePhoto = (page: Page, photo = PHOTO) => page.locator("#file").setInputFiles(photo);
const shared = (page: Page) => page.locator("#shared");
const problem = (page: Page) => page.locator("#problem");

/** How wide zoom 1 shows the photo on a 390 px phone: its box, inside the page's 12 px margins and the box's border. */
const PHONE_SHOWN = 390 - 2 * 12 - 2;
/**
 * Paints a stroke through these points of a photo of `size` (a single point: a dot), the way a finger would, and as it
 * would on a 390 px phone whatever the screen. Zoom 1 fits the photo to its box's width, so a wider screen shows it
 * bigger (1414 px across at 1440): the 36 px brush covers fewer of its pixels there (and a 320 px phone's more), and
 * the photo can be taller than its box, which then scrolls (as a portrait photo's box does on a phone). So Brush is set
 * to cover what 36 px covers on the 390 px phone, as a person would set it (29 at 320, 40 at 430: see INSIDE), and the
 * box is scrolled to the first point (a wheel, or the Move tool) and brought onto the screen before the finger goes
 * down. On a 390 px phone neither changes anything.
 */
async function paint(page: Page, points: [number, number][], size: [number, number] = WIDE_SIZE) {
  const mask = page.locator("#mask");
  const wrap = page.locator("#wrap");
  const brush = page.locator("#brush");
  const shown = await mask.evaluate((m) => m.getBoundingClientRect().width);
  const want = String(Math.min(120, Math.round((36 * shown) / PHONE_SHOWN)));
  if ((await brush.inputValue()) !== want) await brush.fill(want);
  await wrap.evaluate((w, [fx, fy]) => {
    const stage = w.querySelector<HTMLElement>("#stage")!;
    w.scrollTo(fx * stage.offsetWidth - w.clientWidth / 2, fy * stage.offsetHeight - w.clientHeight / 2);
  }, [points[0][0] / size[0], points[0][1] / size[1]]);
  await wrap.scrollIntoViewIfNeeded();
  const box = (await mask.boundingBox())!;
  const at = ([x, y]: [number, number]) => [box.x + (x * box.width) / size[0], box.y + (y * box.height) / size[1]] as const;
  const [sx, sy] = at(points[0]);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (const p of points.length > 1 ? points.slice(1) : [[points[0][0] + 2, points[0][1]] as [number, number]]) {
    const [x, y] = at(p);
    await page.mouse.move(x, y, { steps: 6 });
  }
  await page.mouse.up();
}
/** A pixel of the photo on a page's canvas. */
const pixel = (page: Page, [x, y]: [number, number]) =>
  page.evaluate(([x, y]) => [...document.querySelector<HTMLCanvasElement>("#base")!.getContext("2d")!.getImageData(x, y, 1, 1).data], [x, y]);
const close = (a: number[], b: number[], within = 3) => a.every((v, i) => Math.abs(v - b[i]) <= within);
/**
 * The edit came back blended through the painted dot, at the job's crop and scale. Inside the dot every pixel is the
 * edit's own: its blue, and the red and green of the very pixel of the photo it was made from (resampled twice, so
 * within a step of the gradient) -- a composite a few pixels off, or not scaled back to the crop, has another pixel's
 * there. Just outside the paint, beside it and far away, the photo is exactly as it was.
 */
async function blendedAtDot(page: Page, blue = 0) {
  await expect.poll(async () => close(await pixel(page, DOT), edited(...DOT, blue), 8), { timeout: 20_000 }).toBe(true);
  for (const at of INSIDE) expect(close(await pixel(page, at), edited(...at, blue), 8), `the edit's own pixel at ${at}: ${await pixel(page, at)}`).toBe(true);
  for (const at of [...OUTSIDE, BESIDE, FAR]) expect(await pixel(page, at), `untouched at ${at}`).toEqual(original(...at));
}
/**
 * A photo, a painted dot, the words, and Edit: what someone does before leaving. Returns the job's id once the job is
 * recorded and (unless `sent` is false) has reached the stand-in, so closing the page afterwards can't stop it going.
 */
async function startMaskedEdit(page: Page, sent = true) {
  await choosePhoto(page, WIDE);
  await expect(shared(page)).toContainText("a photo is loaded", { timeout: 15_000 });
  await paint(page, [DOT]);
  await page.locator("#prompt").fill("a green dot");
  await page.locator("#go").click();
  await expect(shared(page)).toContainText("an edit is running", { timeout: 15_000 });
  const id = comfy.session()!.job.id as string;
  if (sent) await expect.poll(async () => (await comfy.log()).some((e) => e.kind === "prompt" && e.id === id), { timeout: 15_000 }).toBe(true);
  return id;
}
/** The job is in ComfyUI's queue, and the session says it got there. */
const sentAndNoted = async (id: string) =>
  expect.poll(async () => (await comfy.log()).some((e) => e.kind === "prompt" && e.id === id) && typeof comfy.session()?.job?.queued === "number", { timeout: 15_000 }).toBe(true);
/** Which cancels of this job reached the stand-in. */
const cancelsOf = async (id: string) => (await comfy.log()).filter((e) => e.kind === "cancel" && e.id === id).length;
const untilDone = async (id: string) => expect.poll(async () => (await comfy.history(id))?.status?.status_str, { timeout: 20_000 }).toBe("success");
/** Uploads of a kind ("base", "crop", "mask") the stand-in took with a picture in them (not one WebKit sent empty). */
const uploadsOf = async (kind: string) => (await comfy.log()).filter((e) => e.kind === "upload" && Number(e.size) > 0 && String(e.filename).includes(`-${kind}-`));

test("one shared edit: the photo and the words are the same on both devices", async ({ browser }) => {
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a red hat");

  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#prompt")).toHaveValue("a red hat", { timeout: 15_000 });
  await expect(shared(laptop)).toContainText("a photo is loaded");
  await expect(laptop.locator("#empty")).toBeHidden();
  // The same photo, not a placeholder.
  expect(await laptop.evaluate(() => [document.querySelector<HTMLCanvasElement>("#base")!.width, document.querySelector<HTMLCanvasElement>("#base")!.height])).toEqual([96, 72]);
  await noHorizontalOverflow(laptop);
  await noHorizontalOverflow(phone);
});

test("the result lands on the device that did not start the edit", async ({ browser }) => {
  comfy.config({ editMs: 1200 });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a red hat");
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#prompt")).toHaveValue("a red hat", { timeout: 15_000 });

  await phone.locator("#go").click();
  // The laptop started nothing, so it has no execution events: it follows the job through the queue.
  await expect(laptop.locator("#go")).toContainText("Editing on Phone", { timeout: 15_000 });
  await expect(laptop.locator("#go")).toBeDisabled();

  await expect(laptop.locator("#status")).toContainText("Done", { timeout: 25_000 });
  await expect(shared(laptop)).toContainText("a result is waiting");
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 15_000 });
  await expect(laptop.locator("#undo")).toBeEnabled();
  expect(await comfy.jobs()).toBe(0);
});

test("words typed on one device are offered on the other, never overwritten under your hands", async ({ browser }) => {
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a red hat");
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#prompt")).toHaveValue("a red hat", { timeout: 15_000 });

  // The phone's box still has the focus, so what the laptop typed is offered rather than dropped in.
  await laptop.locator("#prompt").fill("a blue scarf");
  await expect(phone.locator("#words")).toBeVisible({ timeout: 15_000 });
  await expect(phone.locator("#words")).toContainText("a blue scarf");
  await expect(phone.locator("#words")).toContainText("Laptop");
  await expect(phone.locator("#prompt")).toHaveValue("a red hat");

  await phone.getByRole("button", { name: "Use their words" }).click();
  await expect(phone.locator("#prompt")).toHaveValue("a blue scarf");
  await expect(phone.locator("#words")).toBeHidden();
});

test("clear starts a new edit on every device, and asks first", async ({ browser }) => {
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a red hat");
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#prompt")).toHaveValue("a red hat", { timeout: 15_000 });
  await phone.locator("#go").click();
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 25_000 });

  await phone.getByRole("button", { name: "Clear & start new edit" }).click();
  const ask = phone.locator("#ask");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("on every device");
  // The server reuses a few names per device, so it doesn't promise to keep the pictures: it says to save them.
  await expect(ask).toContainText("Save any photo you want to keep first: the server keeps only the last few.");
  await expect(ask).not.toContainText("stay");
  await ask.getByRole("button", { name: "Keep it" }).click();
  await expect(ask).toBeHidden();
  await expect(shared(phone)).toContainText("a result is waiting");

  await phone.getByRole("button", { name: "Clear & start new edit" }).click();
  await ask.getByRole("button", { name: "Start new" }).click();
  await expect(phone.locator("#status")).toContainText("Cleared");
  await expect(shared(phone)).toContainText("Nothing in it yet");
  await expect(laptop.locator("#status")).toContainText("Cleared on another device", { timeout: 15_000 });
  await expect(shared(laptop)).toContainText("Nothing in it yet");
  await expect(laptop.locator("#empty")).toBeVisible();
  await expect(laptop.locator("#prompt")).toHaveValue("");
});

test("an edit the server forgot is said to be gone, not waited for", async ({ browser }) => {
  comfy.config({ editMs: 60_000 });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a red hat");
  await phone.locator("#go").click();
  await expect(shared(phone)).toContainText("an edit is running", { timeout: 15_000 });
  await sentAndNoted(comfy.session()!.job.id);

  // As a restarted ComfyUI would: the job is in neither the queue nor the history any more, and it saved nothing.
  comfy.config({ editMs: 60_000, lose: true });
  await expect(problem(phone)).toContainText("gone", { timeout: 25_000 });
  await expect(problem(phone)).toContainText("ComfyUI restarted");
  await expect(phone.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(phone.locator("#go")).toBeEnabled();
  await expect(shared(phone)).not.toContainText("an edit is running");
});

for (const older of [false, true]) test(`two devices pressing Edit at the same moment queue one edit, and the other is told${older ? " (a ComfyUI without the move route)" : ""}`, async ({ browser }) => {
  // Without the move route the claim falls back to ?overwrite=false and reading it back.
  comfy.config({ editMs: 3000, noMoveRoute: older });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a red hat");
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#prompt")).toHaveValue("a red hat", { timeout: 15_000 });
  await expect(laptop.locator("#go")).toBeEnabled();

  // Both taps land in the same moment: dispatched straight to each page, neither waiting on the other.
  await Promise.all([phone, laptop].map((p) => p.evaluate(() => document.querySelector<HTMLButtonElement>("#go")!.click())));

  // Exactly one edit is queued, and the device that lost says so instead of overwriting the other.
  await expect.poll(() => comfy.jobs(), { timeout: 15_000 }).toBe(1);
  const told = /is starting an edit|already running/;
  await expect
    .poll(async () => (await Promise.all([phone, laptop].map((p) => p.locator("#problem").textContent()))).filter((t) => told.test(t ?? "")).length, { timeout: 15_000 })
    .toBe(1);
  expect(await comfy.jobs()).toBe(1);
  // And it stays one: the loser does not queue a second one behind it.
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 30_000 });
  expect(await comfy.jobs()).toBe(0);
});

test("a session the server refuses to save says so, and Edit keeps the photo and the words", async ({ browser }) => {
  comfy.config({ editMs: 300, userdataWrite: 403 });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone, WIDE);
  await expect(problem(phone)).toContainText("403", { timeout: 15_000 });
  await expect(problem(phone)).toContainText("still here on this device");
  await expect(phone.getByRole("button", { name: "Share again" })).toBeVisible();
  // The photo is on this device even though it could not be shared.
  await expect(phone.locator("#empty")).toBeHidden();
  expect(await phone.evaluate(() => document.querySelector<HTMLCanvasElement>("#base")!.width)).toBe(640);

  // Review finding 3: pressing Edit on a session the server doesn't have used to empty the page. It keeps both now.
  await phone.locator("#prompt").fill("a red hat");
  await phone.locator("#go").click();
  await expect(problem(phone)).toContainText("isn't shared", { timeout: 15_000 });
  await expect(phone.locator("#prompt")).toHaveValue("a red hat");
  await expect(phone.locator("#empty")).toBeHidden();
  expect(await phone.evaluate(() => document.querySelector<HTMLCanvasElement>("#base")!.width)).toBe(640);
  expect(await pixel(phone, FAR)).toEqual(original(...FAR));
  expect(await comfy.jobs()).toBe(0);

  // Once the server takes writes again, one tap shares the photo with those words and starts the edit.
  comfy.config({ editMs: 300 });
  await phone.getByRole("button", { name: "Share and edit" }).click();
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  expect(comfy.session()!.prompt).toBe("a red hat");
});

test("the session survives a page reload and a ComfyUI restart", async ({ browser }) => {
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a red hat");
  await phone.locator("#go").click();
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 25_000 });

  await phone.reload();
  await expect(phone.locator("#prompt")).toHaveValue("a red hat", { timeout: 15_000 });
  await expect(shared(phone)).toContainText("a result is waiting");
  await expect(phone.locator("#empty")).toBeHidden();

  // The session and the pictures are files on the server, so a restart keeps them.
  await comfy.restart();
  await phone.reload();
  await expect(phone.locator("#prompt")).toHaveValue("a red hat", { timeout: 15_000 });
  await expect(shared(phone)).toContainText("a result is waiting");
  await expect(problem(phone)).toBeHidden();
  expect(await phone.evaluate(() => document.querySelector<HTMLCanvasElement>("#base")!.width)).toBe(96);
});

test("a tap on Edit isn't lost when the session is read again in the middle of it", async ({ browser }) => {
  // Safari drops a click when the text inside the pressed button is replaced before the finger lifts, and leaving the
  // words box shares them at once — so their read-back redraws the buttons exactly while Edit is being tapped.
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone, WIDE);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a green dot");
  // Scrolled to first, as a finger would: on a screen wider than a phone the photo's box is taller and pushes Edit off
  // the bottom of the screen.
  await phone.locator("#go").scrollIntoViewIfNeeded();
  const go = (await phone.locator("#go").boundingBox())!;
  await phone.mouse.move(go.x + go.width / 2, go.y + go.height / 2);
  await phone.mouse.down();
  // What a session read landing at that moment does: the page's own adopt(), run in its global scope.
  await phone.evaluate("adopt(session, true)");
  await phone.mouse.up();
  await expect(shared(phone)).toContainText(/an edit is running|a result is waiting/, { timeout: 15_000 });
});

// ---- the way back to an edit: whoever finishes it blends it in from what the server holds ----

test("closed for the whole edit: reopening the device brings the edited photo, blended through the uploaded paint", async ({ browser }) => {
  comfy.config({ editMs: 1500 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  await phone.close();
  // Nobody is watching while it finishes.
  await untilDone(id);
  expect(comfy.session()!.job.id).toBe(id);

  const back = await reopen(phone, "Phone");
  await expect(shared(back)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(back);
  await expect(back.locator("#status")).toContainText("Done");
  // Blended through the painted area the job uploaded: this page read it back from the server.
  const masks = (await comfy.log()).filter((e) => e.kind === "view" && e.method === "GET" && String(e.filename).includes("-mask-"));
  expect(masks.length).toBeGreaterThan(0);
  // One photo chosen, one photo with the result in it.
  expect((await uploadsOf("base")).length).toBe(2);
  const s = comfy.session()!;
  expect(s.job).toBeNull();
  expect(s.result.jobId).toBe(id);
  expect(s.result.whole).toBe(false);
  expect(s.undo).toHaveLength(1);
  await noHorizontalOverflow(back);
});

test("closed for the whole edit: another device opened afterwards puts it in, and the first finds it there", async ({ browser }) => {
  comfy.config({ editMs: 1500 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  await phone.close();
  await untilDone(id);

  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(shared(laptop)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(laptop);
  expect(comfy.session()!.result.finishedByName).toBe("Laptop");

  // The phone comes back to the finished photo; it doesn't put the result in a second time.
  const back = await reopen(phone, "Phone");
  await expect(shared(back)).toContainText("a result is waiting", { timeout: 15_000 });
  await blendedAtDot(back);
  await expect(back.locator("#status")).toContainText("put in on Laptop");
  expect((await uploadsOf("base")).length).toBe(2);
});

test("a reload in the middle of an edit still blends the result through the painted area", async ({ browser }) => {
  comfy.config({ editMs: 3000 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  await phone.reload();
  await expect(shared(phone)).toContainText("an edit is running", { timeout: 15_000 });
  // The reloaded page shows the area being changed, from the server: its own paint went with the reload.
  await expect.poll(() => phone.evaluate(() => { const m = document.querySelector<HTMLCanvasElement>("#mask")!; return m.getContext("2d")!.getImageData(320, 240, 1, 1).data[3]; }), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(phone.locator("#detail")).toContainText("Editing a 384×384 area");
  await untilDone(id);
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(phone);
});

test("moving to another device mid-edit: it follows the edit and brings the result", async ({ browser }) => {
  comfy.config({ editMs: 4000 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  await phone.close();

  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#go")).toContainText("Editing on Phone", { timeout: 15_000 });
  await expect(laptop.locator("#status")).toContainText(/Editing on Phone|Waiting/, { timeout: 15_000 });
  await untilDone(id);
  await expect(shared(laptop)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(laptop);
});

test("two devices open when the edit finishes: one puts it in, both show it", async ({ browser }) => {
  comfy.config({ editMs: 3500 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  // Reloaded, the phone's page didn't start the edit either: both pages race for the finish, and one wins it.
  await phone.reload();
  await expect(shared(phone)).toContainText("an edit is running", { timeout: 15_000 });
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#go")).toContainText("Editing on Phone", { timeout: 15_000 });
  await untilDone(id);
  for (const p of [phone, laptop]) await expect(shared(p)).toContainText("a result is waiting", { timeout: 20_000 });
  for (const p of [phone, laptop]) await blendedAtDot(p);
  // Give a second finisher every chance to show up: there isn't one.
  await phone.waitForTimeout(2500);
  expect((await uploadsOf("base")).length).toBe(2);
  expect(comfy.session()!.done).toBe(1);
});

test("two tabs on one device: one of them puts the result in", async ({ browser }) => {
  comfy.config({ editMs: 2500 });
  const first = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(first);
  const second = await open(await first.context().newPage(), "Phone, second tab");
  await expect(shared(second)).toContainText("an edit is running", { timeout: 15_000 });
  await untilDone(id);
  for (const p of [first, second]) await expect(shared(p)).toContainText("a result is waiting", { timeout: 20_000 });
  for (const p of [first, second]) await blendedAtDot(p);
  await first.waitForTimeout(2500);
  expect((await uploadsOf("base")).length).toBe(2);
});

test("one page puts a finished edit in once, even when two of its looks find it done together", async ({ browser }) => {
  // ComfyUI's events at the end of an edit (executed, execution_success, status) each ask the page to look again, so
  // its looks overlap. A look that found the edit done after another look of the same page had taken the finish claim
  // used to put it in as well: the photo blended and uploaded again (it failed "a picture that reaches the server
  // empty…" in WebKit 5 runs in 30). Here the overlap is made on purpose: each look waits at /history, the first is let
  // through, and the rest only once it is uploading the finished photo.
  test.setTimeout(60_000);
  comfy.config({ editMs: 2000 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  let holdLooks = true;
  const looks: (() => void)[] = [];
  await phone.route("**/history/**", async (route) => {
    if (holdLooks) await new Promise<void>((go) => looks.push(go));
    await route.continue();
  });
  // The photo, its crop and its paint went up already: from here an upload is the finished photo, or a second one.
  let holdUploads = true;
  const uploads: (() => void)[] = [];
  let again!: () => void;
  const uploadedAgain = new Promise<void>((done) => (again = done));
  await phone.route("**/upload/image", async (route) => {
    if (holdUploads) {
      const held = new Promise<void>((go) => uploads.push(go));
      if (uploads.length > 1) again();
      await held;
    }
    await route.continue();
  });
  await untilDone(id);
  // A look is waiting at /history, and a second starts beside it: the page's own poll(), as ComfyUI's events start one.
  await expect.poll(() => looks.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const second = phone.evaluate("poll()");
  await expect.poll(() => looks.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  // The first finds the edit done, takes the finish claim and uploads the finished photo...
  looks.shift()!();
  await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
  // ... and then the others find it done too: each leaves it to the first (its look ends), or uploads it again.
  holdLooks = false;
  for (const go of looks.splice(0)) go();
  await Promise.race([second, uploadedAgain]);
  holdUploads = false;
  for (const go of uploads.splice(0)) go();
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  await second;
  await blendedAtDot(phone);
  // The photo chosen and the finished one: two pictures went up, not three.
  expect((await uploadsOf("base")).length).toBe(2);
  expect(comfy.session()!.done).toBe(1);
});

test("an edit with nothing painted changes the whole photo, on whichever device comes back", async ({ browser }) => {
  comfy.config({ editMs: 1200 });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone, WIDE);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await expect(phone.locator("#detail")).toContainText("Whole 640×480 photo");
  await phone.locator("#prompt").fill("all green");
  await phone.locator("#go").click();
  await expect(shared(phone)).toContainText("an edit is running", { timeout: 15_000 });
  const id = comfy.session()!.job.id as string;
  expect(comfy.session()!.job.whole).toBe(true);
  await phone.close();
  await untilDone(id);
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(shared(laptop)).toContainText("a result is waiting", { timeout: 20_000 });
  // Every pixel is the edit's (its blue), and where the gradient is smooth, made from the pixel it replaces.
  for (const at of [DOT, BESIDE, FAR, [0, 0] as [number, number]]) await expect.poll(async () => (await pixel(laptop, at))[2], { timeout: 10_000 }).toBeLessThanOrEqual(3);
  for (const at of [DOT, BESIDE]) expect(close(await pixel(laptop, at), edited(...at), 8), `made from the pixel at ${at}`).toBe(true);
});

test("the painted area never reached the server: it says so and offers the result as the model made it", async ({ browser }) => {
  comfy.config({ editMs: 1200, uploadFail: "-mask-" });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone, WIDE);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await paint(phone, [DOT]);
  await phone.locator("#prompt").fill("a green dot");
  await phone.locator("#go").click();
  const ask = phone.locator("#ask");
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await expect(ask).toContainText("couldn't be saved on the server");
  await ask.getByRole("button", { name: "Edit anyway" }).click();
  await expect(shared(phone)).toContainText("an edit is running", { timeout: 15_000 });
  const id = comfy.session()!.job.id as string;
  expect(comfy.session()!.job.mask).toBeNull();
  // Left while it runs; another device brings it back.
  await phone.close();
  await untilDone(id);
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(shared(laptop)).toContainText("a result is waiting", { timeout: 20_000 });
  await expect(laptop.locator("#status")).toContainText("not blended in");
  await expect(laptop.locator("#status")).toContainText("never reached the server");
  // Not a wrong blend: the photo is untouched, painted spot included.
  expect(await pixel(laptop, DOT)).toEqual(original(...DOT));
  expect(comfy.session()!.undo).toHaveLength(0);
  await laptop.getByRole("button", { name: "See what the model made" }).click();
  await expect(laptop.locator("#saveview")).toBeVisible();
  await expect(laptop.locator("#saveimg")).toHaveAttribute("src", /phone_edit/);
  await expect.poll(() => laptop.locator("#saveimg").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await noHorizontalOverflow(laptop);
});

test("an edit that finished just before ComfyUI restarted still comes back", async ({ browser }) => {
  comfy.config({ editMs: 1200 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  await phone.close();
  await untilDone(id);
  // The restart forgets every job; the picture it saved stays on disk under a name only that job has.
  await comfy.restart();
  expect(await comfy.history(id)).toBeUndefined();
  const back = await reopen(phone, "Phone");
  await expect(shared(back)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(back);
});

// ---- stopping ----

test("stop this edit from the device that didn't start it: asked first, and said to be stopping until ComfyUI has", async ({ browser }) => {
  // One-second steps, and the step the stop lands in taking as long as the test likes (holdStop): on a 16 GB Mac a
  // step is 107 s, or twenty minutes when it swaps, and ComfyUI only stops between steps.
  comfy.config({ editMs: 60_000, steps: 60, holdStop: true });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  const laptop = await device(browser, "d_laptop", "Laptop");
  const stop = laptop.getByRole("button", { name: /Stop this edit/ });
  await expect(stop).toBeVisible({ timeout: 15_000 });

  await stop.click();
  const ask = laptop.locator("#ask");
  await expect(ask).toContainText("Stop this edit?");
  await expect(ask).toContainText("started on Phone");
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await laptop.waitForTimeout(500);
  expect(await comfy.jobs()).toBe(1);

  await stop.click();
  await ask.getByRole("button", { name: "Stop it" }).click();
  // ComfyUI's own cancel, for this job, sent before anything was written down.
  await expect.poll(() => cancelsOf(id), { timeout: 10_000 }).toBe(1);
  // ComfyUI is still on the step it was in: every device says it is stopping, and why it takes a while.
  await expect(laptop.locator("#status")).toContainText("Stopping… ComfyUI stops after the step it's on", { timeout: 15_000 });
  await expect(phone.locator("#status")).toContainText("Stopping on Laptop… ComfyUI stops after the step it's on", { timeout: 15_000 });
  await expect(phone.locator("#stop")).toHaveText("Stopping on Laptop…");
  for (const p of [phone, laptop]) await expect(p.locator("#stop")).toBeDisabled();
  await expect(laptop.locator("#stop")).toHaveText("Stopping…");
  expect(await comfy.jobs()).toBe(1);
  expect(comfy.session()!.job.stopping.byName).toBe("Laptop");

  // The step ends, and so does the edit.
  comfy.config({ editMs: 60_000, steps: 60 });
  await expect.poll(() => comfy.jobs(), { timeout: 10_000 }).toBe(0);
  await expect(laptop.locator("#status")).toContainText("Stopped. The photo is as it was.", { timeout: 15_000 });
  await expect(phone.locator("#status")).toContainText("Stopped on Laptop", { timeout: 15_000 });
  for (const p of [phone, laptop]) {
    await expect(shared(p)).not.toContainText("an edit is", { timeout: 15_000 });
    await expect(p.locator("#go")).toBeEnabled();
    await expect(p.getByRole("button", { name: /Stop this edit/ })).toBeHidden();
    expect(await pixel(p, DOT)).toEqual(original(...DOT));
  }
  expect((await comfy.history(id))?.status?.status_str).toBe("error");
  expect(comfy.session()!.stopped.jobId).toBe(id);
  expect(await cancelsOf(id)).toBe(1);
});

test("a stop that never left the device doesn't lock Stop on the others", async ({ browser }) => {
  comfy.config({ editMs: 60_000, steps: 60 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.getByRole("button", { name: /Stop this edit/ })).toBeVisible({ timeout: 15_000 });

  // The phone is locked right after "Stop it": its cancel never gets out, and the page hangs there.
  await phone.route("**/api/jobs/*/cancel", () => {});
  await phone.getByRole("button", { name: /Stop this edit/ }).click();
  await phone.locator("#ask").getByRole("button", { name: "Stop it" }).click();
  await expect(phone.locator("#status")).toContainText("Stopping");
  await laptop.waitForTimeout(2500);
  // Nothing was sent, so nothing says it is stopping: the laptop still offers Stop, and it works.
  expect(comfy.session()!.job.stopping ?? null).toBeNull();
  expect(await cancelsOf(id)).toBe(0);
  const stop = laptop.getByRole("button", { name: /Stop this edit/ });
  await expect(stop).toBeEnabled();
  await stop.click();
  await laptop.locator("#ask").getByRole("button", { name: "Stop it" }).click();
  await expect(laptop.locator("#status")).toContainText("Stopped", { timeout: 15_000 });
  await expect.poll(() => comfy.jobs(), { timeout: 10_000 }).toBe(0);
  expect(await cancelsOf(id)).toBe(1);
  expect(comfy.session()!.stopped.byName).toBe("Laptop");
});

test("clear while an edit runs asks whether to stop it too", async ({ browser }) => {
  comfy.config({ editMs: 60_000, steps: 60 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#go")).toContainText("Editing on Phone", { timeout: 15_000 });

  await phone.getByRole("button", { name: "Clear & start new edit" }).click();
  const ask = phone.locator("#ask");
  await expect(ask).toContainText("This stops it");
  await ask.getByRole("button", { name: "Keep it" }).click();
  await phone.waitForTimeout(500);
  expect(await comfy.jobs()).toBe(1);
  await expect(shared(phone)).toContainText("an edit is running");

  await phone.getByRole("button", { name: "Clear & start new edit" }).click();
  await ask.getByRole("button", { name: "Stop it and clear" }).click();
  await expect.poll(() => comfy.jobs(), { timeout: 10_000 }).toBe(0);
  expect(await cancelsOf(id)).toBe(1);
  await expect(shared(phone)).toContainText("Nothing in it yet", { timeout: 15_000 });
  await expect(shared(laptop)).toContainText("Nothing in it yet", { timeout: 15_000 });
  expect(comfy.session()).toBeNull();
});

test("a ComfyUI without the jobs routes is still stopped: the running edit is interrupted", async ({ browser }) => {
  comfy.config({ editMs: 60_000, steps: 60, noCancelRoute: true });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  await expect.poll(async () => (await comfy.history(id)) === undefined && (await comfy.jobs()) === 1).toBe(true);
  await phone.getByRole("button", { name: /Stop this edit/ }).click();
  await phone.locator("#ask").getByRole("button", { name: "Stop it" }).click();
  await expect.poll(() => comfy.jobs(), { timeout: 10_000 }).toBe(0);
  const log = await comfy.log();
  expect(log.filter((e) => e.kind === "interrupt").map((e) => [e.id, e.running])).toEqual([[id, id]]);
  await expect(phone.locator("#status")).toContainText("Stopped", { timeout: 15_000 });
});

test("a ComfyUI without the jobs routes takes a waiting edit out of the queue, never interrupting the one ahead", async ({ browser }) => {
  // An older ComfyUI: no cancel route, and /interrupt stops whatever runs, whatever prompt_id it is given.
  comfy.config({ editMs: 8000, steps: 80, noCancelRoute: true, oldInterrupt: true });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone, WIDE);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await paint(phone, [DOT]);
  await phone.locator("#prompt").fill("a green dot");
  // Someone else's edit runs when this one is sent: the hub's warm-up, or one from ComfyUI's own page.
  const theirs = await comfy.queueOther();
  await phone.locator("#go").click();
  await expect(phone.locator("#status")).toContainText("Waiting in the queue behind 1 other edit", { timeout: 15_000 });
  const id = comfy.session()!.job.id as string;
  await phone.getByRole("button", { name: /Stop this edit/ }).click();
  await phone.locator("#ask").getByRole("button", { name: "Stop it" }).click();
  await expect(phone.locator("#status")).toContainText("Stopped", { timeout: 15_000 });
  const log = await comfy.log();
  expect(log.some((e) => e.kind === "queue-delete" && (e.ids as string[]).includes(id))).toBe(true);
  // No interrupt was sent, so the edit ahead of it ran to the end.
  expect(log.filter((e) => e.kind === "interrupt")).toEqual([]);
  await expect.poll(async () => (await comfy.history(theirs))?.status?.status_str, { timeout: 15_000 }).toBe("success");
  expect(await comfy.history(id)).toBeUndefined();
});

// ---- sending an edit: recorded first, then sent, and never left running with nobody following it ----

test("an edit that is slow to reach ComfyUI isn't called gone by the other device", async ({ browser }) => {
  test.setTimeout(60_000);
  comfy.config({ editMs: 1500 });
  const phone = await device(browser, "d_phone", "Phone");
  const laptop = await device(browser, "d_laptop", "Laptop");
  // Only the phone's sending is slow: 7 s, as a poor link (or a phone locked for a moment) makes it.
  await phone.route("**/prompt", async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 7000));
    await route.continue();
  });
  const id = await startMaskedEdit(phone, false);
  await expect(laptop.locator("#status")).toContainText("Starting on Phone…", { timeout: 15_000 });
  // Well past the three looks that used to call it gone.
  await laptop.waitForTimeout(4500);
  await expect(problem(laptop)).toBeHidden();
  await expect(shared(laptop)).toContainText("an edit is running");
  await sentAndNoted(id);
  await untilDone(id);
  for (const p of [phone, laptop]) await expect(shared(p)).toContainText("a result is waiting", { timeout: 20_000 });
  for (const p of [phone, laptop]) await blendedAtDot(p);
  expect(comfy.session()!.done).toBe(1);
  expect(await cancelsOf(id)).toBe(0);
});

test("an edit whose device went away before sending it: said so, and stopped if it turns up after all", async ({ browser }) => {
  test.setTimeout(60_000);
  comfy.config({ editMs: 1500 });
  const phone = await device(browser, "d_phone", "Phone");
  // The phone hangs on its way to ComfyUI: locked, or out of signal.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await phone.route("**/prompt", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  const id = await startMaskedEdit(phone, false);
  // ... for longer than another device waits for a recorded edit to reach ComfyUI.
  const s = comfy.session()!;
  comfy.writeSession({ ...s, job: { ...s.job, at: Date.now() - 120_000 } });

  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(problem(laptop)).toContainText("That edit never reached ComfyUI: the page on Phone closed or lost its connection before sending it.", { timeout: 20_000 });
  await expect(laptop.locator("#go")).toBeEnabled();
  expect(comfy.session()!.job).toBeNull();
  expect(existsSync(join(comfy.dir, "userdata", "crosstalk-editor-claim.json"))).toBe(false);

  // The phone comes back and its edit reaches ComfyUI after all: nobody follows it any more, so it is stopped.
  release();
  await expect(problem(phone)).toContainText("reached ComfyUI too late", { timeout: 15_000 });
  await expect.poll(() => cancelsOf(id), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => comfy.jobs(), { timeout: 10_000 }).toBe(0);
  expect((await comfy.history(id))?.status?.status_str).not.toBe("success");
  expect(comfy.session()!.job).toBeNull();
  await expect(phone.locator("#go")).toBeEnabled();
});

// ---- how much detail the model gets ----

test("the detail line says how many pixels the painted area is sent at, and when to paint tighter", async ({ browser }) => {
  test.setTimeout(60_000);
  const phone = await device(browser, "d_phone", "Phone");
  const detail = phone.locator("#detail");
  const tip = detail.locator("#detailTip");
  await choosePhoto(phone, WIDE);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  // 640×480 at Standard: the model works at 1184×896, about 1030 px — more than the photo has, so no tip.
  await expect(detail.locator("#detailText")).toHaveText("Whole 640×480 photo → sent at about 1030 px");
  await expect(tip).toHaveText("");
  await paint(phone, [DOT]);
  await expect(detail.locator("#detailText")).toHaveText("Editing a 384×384 area → sent at about 1024 px");
  // High: ComfyUI rounds 1328/32 = 41.5 to the even 42, so a square goes in at 1344.
  await phone.locator("#res").selectOption("1328");
  await expect(detail.locator("#detailText")).toHaveText("Editing a 384×384 area → sent at about 1344 px");
  await phone.getByRole("button", { name: "Clear paint" }).click();
  await expect(detail).toContainText("Whole 640×480 photo");

  // A photo bigger than what the model gets at Standard, as every phone photo is.
  await phone.locator("#res").selectOption("1024");
  const big = { name: "big.png", mimeType: "image/png", buffer: png(1600, 1200) };
  await choosePhoto(phone, big);
  await expect(detail).toContainText("Whole 1600×1200 photo", { timeout: 15_000 });
  // Just loaded, nothing typed: no verdict on the photo.
  await expect(tip).toHaveText("");
  // About to send it unpainted: advice, in the dim colour — not the yellow warning a big painted area gets.
  await phone.locator("#prompt").fill("all green");
  await expect(tip).toHaveText("Whole photo: fine detail is lost. Paint just the part to keep it.");
  await expect(detail.locator(".tip")).toHaveCount(0);
  await paint(phone, [[800, 600]], [1600, 1200]);
  await expect(detail).toContainText("Editing a 384×384 area");
  await expect(tip).toHaveText("");
  // The readout is two rows that stay put, so the buttons below don't move as the tip comes and goes.
  const go = async () => (await phone.locator("#go").boundingBox())!.y;
  const before = await go();
  await paint(phone, [[150, 150], [1450, 150], [1450, 1050], [150, 1050]], [1600, 1200]);
  await expect(detail.locator(".tip")).toHaveText("Big area: detail is lost. Paint tighter or zoom in.");
  expect(await go()).toBe(before);

  // An edit that has just come back leaves nothing painted, but that's no verdict on the result either.
  await phone.getByRole("button", { name: "Clear paint" }).click();
  await phone.locator("#go").click();
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  await expect(detail).toContainText("Whole 1600×1200 photo");
  await expect(tip).toHaveText("");
  // New words for the next edit: the advice comes back.
  await phone.locator("#prompt").fill("all blue");
  await expect(tip).toHaveText("Whole photo: fine detail is lost. Paint just the part to keep it.");
  await noHorizontalOverflow(phone);
});

// ---- the review's other findings ----

test("a photo chosen on one device survives the other's typing landing in the same moment", async ({ browser }) => {
  test.setTimeout(60_000);
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(shared(laptop)).toContainText("a photo is loaded", { timeout: 15_000 });

  // Every session write now takes two seconds to land, so the two writes cross: the laptop reads the session before
  // the phone's new photo is in it, and its words land after.
  comfy.config({ editMs: 300, stallMs: 2000, stallFile: SESSION });
  await Promise.all([choosePhoto(phone, WIDE), laptop.locator("#prompt").fill("a blue scarf")]);
  await expect.poll(() => comfy.session()?.prompt, { timeout: 15_000 }).toBe("a blue scarf");

  // The phone puts its photo back; the laptop's words stay.
  await expect.poll(() => comfy.session()?.image?.w, { timeout: 20_000 }).toBe(640);
  expect(comfy.session()!.prompt).toBe("a blue scarf");
  for (const p of [phone, laptop]) {
    await expect.poll(() => p.evaluate(() => document.querySelector<HTMLCanvasElement>("#base")!.width), { timeout: 20_000 }).toBe(640);
  }
  await expect(phone.locator("#prompt")).toHaveValue("a blue scarf", { timeout: 15_000 });
});

test("an edit that's gone while the server won't save anything doesn't leave the page stuck", async ({ browser }) => {
  comfy.config({ editMs: 60_000 });
  const phone = await device(browser, "d_phone", "Phone");
  await sentAndNoted(await startMaskedEdit(phone));
  comfy.config({ editMs: 60_000, lose: true, userdataWrite: 403 });
  await expect(problem(phone)).toContainText("That edit is gone", { timeout: 25_000 });
  // The tidy-up write is refused, but the page is not pinned to the dead edit, and its explanation stays.
  await expect(phone.locator("#go")).toBeEnabled();
  await phone.waitForTimeout(4000);
  await expect(problem(phone)).toContainText("That edit is gone");
  await expect(shared(phone)).not.toContainText("an edit is running");
  const prompts = (await comfy.log()).filter((e) => e.kind === "prompt").length;

  // Edit now says the server won't save it, and queues nothing it couldn't follow.
  await phone.locator("#go").click();
  await expect(problem(phone)).toContainText("403", { timeout: 15_000 });
  expect((await comfy.log()).filter((e) => e.kind === "prompt").length).toBe(prompts);
  expect(await comfy.jobs()).toBe(0);
});

test("edit again re-edits the painted area, not the whole photo", async ({ browser }) => {
  test.setTimeout(60_000);
  comfy.config({ editMs: 600 });
  const phone = await device(browser, "d_phone", "Phone");
  await startMaskedEdit(phone);
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(phone);
  const first = comfy.session()!.result;

  comfy.config({ editMs: 600, editBlue: 90 });
  await phone.getByRole("button", { name: "↻ Edit again" }).click();
  await expect.poll(() => { const id = comfy.session()?.result?.jobId; return !!id && id !== first.jobId; }, { timeout: 20_000 }).toBe(true);
  const again = comfy.session()!.result;
  expect(again.whole).toBe(false);
  expect(again.crop).toEqual(first.crop);
  // The same painted area as before, sent again rather than uploaded again.
  expect(again.mask).toEqual(first.mask);
  // From the photo as it was, the same spot: the new edit at the dot, nothing else touched.
  await blendedAtDot(phone, 90);
  expect(comfy.session()!.undo).toHaveLength(1);
});

test("input/ holds a few reused pictures per device, never writing over one the session still points at", async ({ browser }) => {
  test.setTimeout(120_000);
  comfy.config({ editMs: 100 });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("one more shade");
  // Nine whole-photo edits, each its own colour, so every photo in the undo history can be told apart.
  const colour = (i: number): [number, number, number] => [20 * i, 255 - 20 * i, 40];
  for (let i = 1; i <= 9; i++) {
    comfy.config({ editMs: 100, editColor: colour(i) });
    await expect(phone.locator("#go")).toBeEnabled({ timeout: 15_000 });
    await phone.locator("#go").click();
    await expect.poll(() => comfy.session()?.done, { timeout: 15_000 }).toBe(i);
  }
  // One photo and nine edits made ten base pictures and nine crops: they went round 8 and 3 names.
  expect((await uploadsOf("base")).length).toBe(10);
  const names = comfy.uploads();
  expect(names.filter((n) => n.includes("-base-")).length).toBeLessThanOrEqual(8);
  expect(names.filter((n) => n.includes("-crop-")).length).toBeLessThanOrEqual(3);
  // The photo and each undo step are still the pictures they were: none was written over.
  const s = comfy.session()!;
  expect(s.undo).toHaveLength(5);
  const steps = [...s.undo, s.image] as { filename: string; subfolder: string }[];
  for (const [k, ref] of steps.entries()) {
    const step = 9 - (steps.length - 1 - k);
    const got = await phone.evaluate(async (r) => {
      const img = new Image();
      img.src = `/view?filename=${encodeURIComponent(r.filename)}&subfolder=${encodeURIComponent(r.subfolder)}&type=input&t=${Date.now()}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return [...g.getImageData(5, 5, 1, 1).data];
    }, ref);
    expect(close(got, [...colour(step), 255]), `undo step ${step} is still its own picture`).toBe(true);
  }
});

test("an edit that fails says why, and the next one can start", async ({ browser }) => {
  comfy.config({ editMs: 300, editError: "Out of memory on the GPU" });
  const phone = await device(browser, "d_phone", "Phone");
  await startMaskedEdit(phone);
  await expect(problem(phone)).toContainText("Out of memory on the GPU", { timeout: 20_000 });
  await expect(phone.getByRole("button", { name: "Try again" })).toBeVisible();
  // The painted area stays for the retry, and nothing is left claimed.
  comfy.config({ editMs: 300 });
  await phone.getByRole("button", { name: "Try again" }).click();
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(phone);
});

test("an edit the server refuses says why, and nothing is left running or claimed", async ({ browser }) => {
  comfy.config({ editMs: 300, reject: "Value not in list: unet_name" });
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone, WIDE);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  await phone.locator("#prompt").fill("a green dot");
  await phone.locator("#go").click();
  await expect(problem(phone)).toContainText("Value not in list", { timeout: 15_000 });
  await expect(shared(phone)).not.toContainText("an edit is running");
  expect(comfy.session()!.job).toBeNull();
  expect(existsSync(join(comfy.dir, "userdata", "crosstalk-editor-claim.json"))).toBe(false);
  comfy.config({ editMs: 300 });
  await phone.getByRole("button", { name: "Try again" }).click();
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
});

// ---- the second review's findings ----

test("an Edit again that doesn't start, or fails, keeps the finished result", async ({ browser }) => {
  test.setTimeout(90_000);
  comfy.config({ editMs: 600 });
  const phone = await device(browser, "d_phone", "Phone");
  await startMaskedEdit(phone);
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  await blendedAtDot(phone);
  const first = comfy.session()!;
  /** The photo, the result and the undo history, exactly: the same pictures, not just the same names. */
  const what = (s: Record<string, any>) => JSON.stringify([s.image, s.result?.jobId ?? null, s.undo]);
  const again = phone.getByRole("button", { name: "↻ Edit again" });

  // ComfyUI refuses the new edit: nothing about the result changed, on the server or on screen.
  comfy.config({ editMs: 600, reject: "Value not in list: unet_name" });
  await again.click();
  await expect(problem(phone)).toContainText("Value not in list", { timeout: 15_000 });
  expect(what(comfy.session()!)).toBe(what(first));
  await expect(again).toBeEnabled();
  await expect(shared(phone)).toContainText("a result is waiting");
  await blendedAtDot(phone);

  // It starts this time, and fails while it runs: the result is put back as it was.
  comfy.config({ editMs: 600, editError: "Out of memory on the GPU" });
  await phone.getByRole("button", { name: "Try again" }).click();
  await expect(problem(phone)).toContainText("Out of memory on the GPU", { timeout: 20_000 });
  await expect.poll(() => what(comfy.session()!), { timeout: 10_000 }).toBe(what(first));
  await expect(shared(phone)).toContainText("a result is waiting");
  await blendedAtDot(phone);

  // Try again is Edit again: the same area of the photo from before the first edit, and its own result.
  comfy.config({ editMs: 600, editBlue: 90 });
  await phone.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => { const id = comfy.session()?.result?.jobId; return !!id && id !== first.result.jobId; }, { timeout: 20_000 }).toBe(true);
  const now = comfy.session()!;
  expect(now.result.crop).toEqual(first.result.crop);
  expect(now.undo).toEqual(first.undo);
  await blendedAtDot(phone, 90);
});

test("an edit that finishes while ComfyUI won't save is still shown, ready to save, and shared once it can", async ({ browser }) => {
  test.setTimeout(60_000);
  comfy.config({ editMs: 2500 });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(laptop.locator("#go")).toContainText("Editing on Phone", { timeout: 15_000 });
  // The user folder refuses writes from here on (a full disk, a read-only folder); pictures can still be read.
  comfy.config({ editMs: 2500, userdataWrite: 403 });
  await untilDone(id);
  for (const p of [phone, laptop]) {
    await expect(problem(p)).toContainText("ComfyUI can't save right now (403)", { timeout: 20_000 });
    await expect(problem(p)).toContainText("Free up disk space on the computer running ComfyUI, then tap Try again.");
    await expect(p.locator("#status")).toContainText("On this device only for now");
    await blendedAtDot(p);
    await expect(p.getByRole("button", { name: "See what the model made" })).toBeVisible();
    await expect(p.getByRole("button", { name: /Stop this edit/ })).toBeHidden();
    await expect(p.locator("#save")).toBeEnabled();
  }
  // Save keeps the edited photo, and the model's own picture can be looked at.
  await phone.locator("#save").click();
  await expect(phone.locator("#saveview")).toBeVisible();
  const saved = await phone.locator("#saveimg").evaluate(async (i: HTMLImageElement, [x, y]) => {
    await i.decode();
    const c = document.createElement("canvas");
    c.width = i.naturalWidth;
    c.height = i.naturalHeight;
    c.getContext("2d")!.drawImage(i, 0, 0);
    return [...c.getContext("2d")!.getImageData(x, y, 1, 1).data];
  }, DOT);
  expect(close(saved, edited(...DOT), 8)).toBe(true);
  await phone.getByRole("button", { name: "Close" }).click();
  await laptop.getByRole("button", { name: "See what the model made" }).click();
  await expect(laptop.locator("#saveimg")).toHaveAttribute("src", /phone_edit/);
  await laptop.getByRole("button", { name: "Close" }).click();
  await noHorizontalOverflow(phone);

  // ComfyUI saves again: Try again shares it, once, and both devices have the one result.
  comfy.config({ editMs: 2500 });
  await phone.getByRole("button", { name: "Try again" }).click();
  for (const p of [phone, laptop]) await expect(shared(p)).toContainText("a result is waiting", { timeout: 20_000 });
  await expect(problem(laptop)).toBeHidden({ timeout: 15_000 });
  await expect(problem(phone)).toBeHidden();
  const s = comfy.session()!;
  expect(s.result.jobId).toBe(id);
  expect(s.done).toBe(1);
  expect(s.job).toBeNull();
  for (const p of [phone, laptop]) await blendedAtDot(p);
});

test("a new photo the server wouldn't share stays on screen, as the page says, until another device changes the edit", async ({ browser }) => {
  const phone = await device(browser, "d_phone", "Phone");
  await choosePhoto(phone, WIDE);
  await expect(shared(phone)).toContainText("a photo is loaded", { timeout: 15_000 });
  const width = () => phone.evaluate(() => document.querySelector<HTMLCanvasElement>("#base")!.width);

  // A new photo; its upload works, the session write is refused.
  comfy.config({ editMs: 300, userdataWrite: 403 });
  await choosePhoto(phone);
  await expect(problem(phone)).toContainText("still here on this device", { timeout: 15_000 });
  // Several reads of the session later, it is still the photo on screen.
  await phone.waitForTimeout(4000);
  expect(await width()).toBe(96);
  await expect(problem(phone)).toContainText("still here on this device");
  // Edit doesn't edit the old one behind it: it says this one isn't shared.
  await phone.locator("#prompt").fill("a red hat");
  await phone.locator("#go").click();
  await expect(problem(phone)).toContainText("isn't shared", { timeout: 15_000 });
  expect(await width()).toBe(96);
  expect(await comfy.jobs()).toBe(0);

  // Another device puts a photo of its own in meanwhile: theirs is newer, and the page says what happened to this one.
  const fd = new FormData();
  fd.append("image", new Blob([new Uint8Array(png(200, 150))], { type: "image/png" }), "theirs.png");
  fd.append("subfolder", "crosstalk-editor");
  fd.append("overwrite", "true");
  await fetch(`${comfy.url}/upload/image`, { method: "POST", body: fd });
  const s = comfy.session()!;
  comfy.writeSession({ ...s, image: { filename: "theirs.png", subfolder: "crosstalk-editor", type: "input", v: "theirs01", w: 200, h: 150 }, by: "d_laptop", byName: "Laptop", rev: s.rev + 1 });
  await expect.poll(width, { timeout: 15_000 }).toBe(200);
  await expect(problem(phone)).toContainText("Your new photo wasn't shared, and the edit was changed on another device since");
});

test("a picture that reaches the server empty is sent again, never shared empty", async ({ browser }) => {
  // WebKit has been seen to send an upload's form with the picture left out (a photo drawn on screen and then sent at
  // once, under load): the server keeps an empty file and answers 200, and every other device said the photo was gone.
  comfy.config({ editMs: 1200, emptyOnce: "-base-" });
  const phone = await device(browser, "d_phone", "Phone");
  const id = await startMaskedEdit(phone);
  await untilDone(id);
  await expect(shared(phone)).toContainText("a result is waiting", { timeout: 20_000 });
  // The photo chosen and the finished one both arrived empty the first time, and were sent again.
  const log = await comfy.log();
  expect(log.filter((e) => e.kind === "upload-emptied").map((e) => e.filename)).toEqual(["d_phone-base-1.png", "d_phone-base-2.png"]);
  const s = comfy.session()!;
  for (const ref of [s.image, ...s.undo] as { filename: string }[]) {
    expect(statSync(join(comfy.dir, "files", "input", "crosstalk-editor", ref.filename)).size, ref.filename).toBeGreaterThan(0);
  }
  const laptop = await device(browser, "d_laptop", "Laptop");
  await expect(shared(laptop)).toContainText("a result is waiting", { timeout: 15_000 });
  await blendedAtDot(laptop);
  await expect(problem(laptop)).toBeHidden();
});
