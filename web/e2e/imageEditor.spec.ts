import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Settings → Image editor, against the test hub's own image editor code (hub/src/imageEditor.ts): the test sets up an
// install in the hub's workspace laid out like the real one (ai-models/image-editor with its start.sh, ComfyUI/main.py
// and editor page), where main.py is the hub tests' stand-in for ComfyUI on a free port. Nothing here starts ComfyUI or
// loads a model, and the real editor on this Mac is never looked at.

const HUB = "http://127.0.0.1:8451";
const FAKE = fileURLToPath(new URL("../../hub/test/fixtures/fake-comfy", import.meta.url));
const BUN = execFileSync("which", ["bun"]).toString().trim();

/** A command's output, or "" when it fails: pgrep exits 1 when nothing matches (no editor running), lsof when the process just ended. */
function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch {
    return "";
  }
}
const hubState = () => JSON.parse(readFileSync(join(tmpdir(), "crosstalk-browser-state-8451.json"), "utf8")) as { token: string; workspaceRoot: string };
const installDir = () => join(hubState().workspaceRoot, "ai-models", "image-editor");

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** An install like the real one, its server playing what `config` says (see fake-comfy). */
async function install(config: Record<string, unknown> = {}) {
  const dir = installDir();
  mkdirSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor"), { recursive: true });
  const port = await freePort();
  writeFileSync(join(dir, "ComfyUI", "main.py"), readFileSync(FAKE));
  writeFileSync(join(dir, "start.sh"), `#!/bin/sh\ncd "$(dirname "$0")"\nexec "${BUN}" ComfyUI/main.py --listen 0.0.0.0 --port ${port}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor", "editor.html"), "<script>const MODELS = { unet: 'qwen-image.gguf', clip: 'text-encoder.gguf', vae: 'vae.safetensors' };</script>");
  writeFileSync(join(dir, "fake-comfy.json"), JSON.stringify({ startMs: 400, warmMs: 600, ...config }));
  return { port, configure: (c: Record<string, unknown>) => writeFileSync(join(dir, "fake-comfy.json"), JSON.stringify(c)) };
}

/** Servers a test started itself, beside the hub, and their folders (ended and removed when it ends). */
const strangers: { pid: number; other: string }[] = [];

/** Something else answering on the editor's port: the stand-in, run from another folder. */
function stranger(port: number) {
  const other = mkdtempSync(join(tmpdir(), "ct-e2e-other-"));
  const child = spawn(BUN, [FAKE, "--port", String(port)], { cwd: other, detached: true, stdio: "ignore" });
  child.unref();
  const s = { pid: child.pid!, other };
  strangers.push(s);
  return s;
}

const end = (pid: number) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Ended.
    }
  }
};

test.afterEach(async ({ playwright }) => {
  for (const s of strangers.splice(0)) {
    end(s.pid);
    rmSync(s.other, { recursive: true, force: true });
  }
  // Off whatever a test left on (the hub ends the server it started), then the install goes.
  const api = await playwright.request.newContext({ baseURL: HUB, extraHTTPHeaders: { authorization: `Bearer ${hubState().token}` } });
  try {
    const s = await (await api.get("/api/image-editor")).json();
    if (s.installed && s.state !== "off") {
      await api.post("/api/image-editor", { data: { on: false, force: true } });
      await expect.poll(async () => (await (await api.get("/api/image-editor")).json()).state, { timeout: 15_000 }).toMatch(/^(off|error)$/);
      await api.post("/api/image-editor", { data: { on: false } });
    }
  } finally {
    await api.dispose();
    // Anything still running from the install (a test that stopped early) ends with it.
    let root = "";
    try {
      root = realpathSync(installDir());
    } catch {
      root = "";
    }
    if (root) {
      for (const pid of run("/usr/bin/pgrep", ["-f", "ComfyUI/main.py"]).split(/\s+/).map(Number).filter(Boolean)) {
        const cwd = run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find((l) => l.startsWith("n"))?.slice(1);
        if (cwd && (cwd === root || cwd.startsWith(root + "/"))) end(pid);
      }
    }
    rmSync(join(hubState().workspaceRoot, "ai-models"), { recursive: true, force: true });
  }
});

const section = (page: Page) => page.locator(".image-editor");
const theSwitch = (page: Page) => section(page).getByRole("checkbox", { name: "AI image editor" });

async function openSettings(page: Page) {
  await page.goto("/#/settings/image-editor");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

/** CT_SHOTS: a folder for the screens (390 px Chromium only), the image editor's card at the top. */
async function shot(page: Page, name: string) {
  const dir = process.env.CT_SHOTS;
  if (!dir || test.info().project.name !== "chromium-390") return;
  await page.locator("#image-editor").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: join(dir, name), animations: "disabled" });
}

test("a machine without the image editor doesn't show it", async ({ page }) => {
  await openSettings(page);
  // The tab it would be in opens all the same (the model pool is there too); the section itself just isn't there.
  await expect(page.getByRole("heading", { name: "Model pool", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Image editor" })).toHaveCount(0);
});

test("switching it on starts it, loads the model and shows the link; off frees it", async ({ page }) => {
  const { port } = await install();
  await openSettings(page);
  await expect(page.getByRole("heading", { name: "Image editor" })).toBeVisible();
  await expect(section(page)).toContainText("Off. Uses no memory.");
  await expect(section(page)).toContainText("loads the model, about a minute");
  await expect(theSwitch(page)).not.toBeChecked();
  await expect(section(page).getByRole("link", { name: "Open the editor" })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, "image-editor-off.png");

  await theSwitch(page).click({ force: true });
  await expect(theSwitch(page)).toBeChecked();
  await expect(section(page)).toContainText(/Starting on .+…|Loading the model…/);
  await expect(section(page)).toContainText("Loading the model…", { timeout: 10_000 });
  await shot(page, "image-editor-loading.png");
  await expect(section(page).locator(".image-editor-state")).toHaveText(/^On · \d+(\.\d)? (MB|GB) of memory$/, { timeout: 10_000 });
  const link = section(page).getByRole("link", { name: "Open the editor" });
  await expect(link).toHaveAttribute("href", new RegExp(`^http://[\\d.]+:${port}/editor$`));
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(section(page).locator(".image-editor-url")).toHaveText(new RegExp(`^[\\d.]+:${port}/editor$`));
  await noHorizontalOverflow(page);
  await shot(page, "image-editor-on.png");

  await theSwitch(page).click({ force: true });
  await expect(section(page)).toContainText("Off. Uses no memory.", { timeout: 15_000 });
  await expect(theSwitch(page)).not.toBeChecked();
  await expect(section(page).getByRole("link", { name: "Open the editor" })).toHaveCount(0);
  await expect.poll(() => fetch(`http://127.0.0.1:${port}/system_stats`).then(() => true, () => false)).toBe(false);
});

test("one that can't start says why, with Try again and Dismiss", async ({ page }) => {
  const { configure } = await install({ fail: "RuntimeError: MPS backend out of memory (MPS allocated: 9.1 GB)" });
  await openSettings(page);
  await theSwitch(page).click({ force: true });
  const problem = section(page).getByRole("alert");
  await expect(problem).toContainText("It stopped while starting: RuntimeError: MPS backend out of memory (MPS allocated: 9.1 GB). Its log:", { timeout: 10_000 });
  await expect(section(page)).toContainText("Stopped.");
  await expect(theSwitch(page)).not.toBeChecked();
  await noHorizontalOverflow(page);
  await shot(page, "image-editor-problem.png");
  await problem.getByRole("button", { name: "Dismiss" }).click();
  await expect(section(page).getByRole("alert")).toHaveCount(0);
  await expect(section(page)).toContainText("Off. Uses no memory.");

  // Try again, once whatever it was is fixed.
  configure({ fail: "ImportError: No module named torch" });
  await theSwitch(page).click({ force: true });
  await expect(problem).toContainText("ImportError: No module named torch", { timeout: 10_000 });
  configure({ startMs: 200, warmMs: 200 });
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect(section(page)).toContainText(/On · /, { timeout: 10_000 });
});

test("turning it off during an edit asks first", async ({ page }) => {
  const { configure } = await install({ startMs: 100, warmMs: 100 });
  await openSettings(page);
  await theSwitch(page).click({ force: true });
  await expect(section(page)).toContainText(/On · /, { timeout: 10_000 });
  configure({ busy: true });
  await theSwitch(page).click({ force: true });
  const ask = section(page).getByRole("alert");
  await expect(ask).toContainText("It's working on an edit. Turning it off now stops that edit.");
  // The switch stays on until it's decided, and the line under it says it's editing.
  await expect(theSwitch(page)).toBeChecked();
  await expect(section(page)).toContainText("On · editing");
  await shot(page, "image-editor-busy.png");
  await ask.getByRole("button", { name: "Keep it on" }).click();
  await expect(section(page).getByRole("alert")).toHaveCount(0);
  await expect(section(page)).toContainText(/On · /);
  await theSwitch(page).click({ force: true });
  await section(page).getByRole("alert").getByRole("button", { name: "Turn off anyway" }).click();
  await expect(section(page)).toContainText("Off. Uses no memory.", { timeout: 15_000 });
});

test("a turn-off that didn't work shows it still on: Try again turns it off, Keep it on leaves it", async ({ page }) => {
  const { port } = await install({ startMs: 100, warmMs: 100 });
  // Another server, from another folder, answers on the editor's port: the hub never ends it.
  const other = stranger(port);
  await expect.poll(() => fetch(`http://127.0.0.1:${port}/system_stats`).then(() => true, () => false)).toBe(true);
  await openSettings(page);
  // It answers, so it shows as on (its memory isn't counted: it isn't the editor's).
  await expect(section(page).locator(".image-editor-state")).toHaveText("On", { timeout: 10_000 });
  await expect(theSwitch(page)).toBeChecked();
  await theSwitch(page).click({ force: true });
  const problem = section(page).getByRole("alert");
  await expect(problem).toContainText(`Something else answers on port ${port}: end it on this machine, then try again.`, { timeout: 10_000 });
  await expect(section(page)).toContainText("Didn't turn off.");
  await expect(theSwitch(page)).toBeChecked();
  await expect(problem.getByRole("button", { name: "Keep it on" })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, "image-editor-stuck.png");
  // Keep it on: it's on, as it is.
  await problem.getByRole("button", { name: "Keep it on" }).click();
  await expect(section(page).locator(".image-editor-state")).toHaveText("On", { timeout: 10_000 });
  await expect(section(page).getByRole("alert")).toHaveCount(0);
  // Once the other one is ended, turning it off works.
  await theSwitch(page).click({ force: true });
  await expect(problem).toContainText("Something else answers", { timeout: 10_000 });
  end(other.pid);
  await expect.poll(() => fetch(`http://127.0.0.1:${port}/system_stats`).then(() => true, () => false)).toBe(false);
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect(section(page)).toContainText("Off. Uses no memory.", { timeout: 15_000 });
});
