import { afterAll, afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITOR_NODE, editorDiff, editorFiles, syncEditor, syncWords } from "../src/editorSource";
import { ImageEditor, editorModels } from "../src/imageEditor";
import { endStarted } from "./standins";

// The phone page kept in this repository (editor/phone_editor) and how the hub puts it into an install.
// Nothing here starts, stops or signals ComfyUI, and the user's own install is never looked at.

const FAKE = join(import.meta.dir, "fixtures", "fake-comfy");
const dirs: string[] = [];
const editors: ImageEditor[] = [];

// Whatever the test got to, everything it started ends, process groups whole: the stand-ins it started by hand, and the
// one the hub started from start.sh when a test switched the editor on. That one runs in a process group of its own, as
// the real one must to outlive the hub, so nothing else ended it: every run used to leave one running.
afterEach(async () => {
  editors.splice(0).forEach((e) => e.shutdown());
  await endStarted();
});
afterAll(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** An install laid out like the real one, with whatever page `page` says (none: no page file at all). */
function install(page?: string) {
  const dir = mkdtempSync(join(tmpdir(), "ct-editor-source-"));
  dirs.push(dir);
  mkdirSync(join(dir, EDITOR_NODE), { recursive: true });
  writeFileSync(join(dir, "ComfyUI", "main.py"), readFileSync(FAKE));
  if (page !== undefined) writeFileSync(join(dir, EDITOR_NODE, "editor.html"), page);
  return dir;
}
const pageOf = (dir: string) => readFileSync(join(dir, EDITOR_NODE, "editor.html"), "utf8");
/** The page goes in on its own (never holding up a start), so a test waits for it. */
async function untilPage(dir: string, ms = 10_000) {
  const until = Date.now() + ms;
  while (pageOf(dir) !== repoPage()) {
    if (Date.now() > until) throw new Error("the page was never put in place");
    await Bun.sleep(50);
  }
  expect(pageOf(dir)).toBe(repoPage());
}
const repoPage = () => editorFiles().find((f) => f.name === "editor.html")!.text;
const repoInit = () => editorFiles().find((f) => f.name === "__init__.py")!.text;

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** The stand-in server answering on `port` from the install, as one started by hand would. */
async function serve(dir: string, port: number, config: Record<string, unknown>) {
  writeFileSync(join(dir, "fake-comfy.json"), JSON.stringify(config));
  spawn(process.execPath, ["ComfyUI/main.py", "--port", String(port)], { cwd: dir, detached: true, stdio: "ignore" }).unref();
  const until = Date.now() + 15_000;
  while (!(await fetch(`http://127.0.0.1:${port}/system_stats`).then((r) => r.ok, () => false))) {
    if (Date.now() > until) throw new Error("the stand-in never answered");
    await Bun.sleep(50);
  }
  return (c: Record<string, unknown>) => writeFileSync(join(dir, "fake-comfy.json"), JSON.stringify(c));
}

function editor(dir: string, port: number, syncPage = true) {
  const ed = new ImageEditor({
    dir,
    syncPage,
    logFile: join(dir, "server.log"),
    pidFile: join(dir, "editor-pid.json"),
    emit: () => {},
    // Never contacted: the editor only ever writes it into a link.
    tailscaleIp: async () => null,
    timing: { watchMs: 200, startMs: 10_000, warmMs: 10_000, stopMs: 2000, stepMs: 50 },
  });
  // start.sh decides the port the hub looks at.
  writeFileSync(join(dir, "start.sh"), `#!/bin/sh\ncd "$(dirname "$0")"\nexec "${process.execPath}" ComfyUI/main.py --port ${port}\n`, { mode: 0o755 });
  editors.push(ed);
  return ed;
}

test("the page in the repo is the two files of the custom node, and only __init__.py waits for a restart", () => {
  expect(editorFiles().map((f) => [f.name, f.waits])).toEqual([
    ["editor.html", false],
    ["__init__.py", true],
  ]);
  expect(repoPage()).toStartWith("<!doctype html>");
  expect(repoInit()).toContain("PromptServer.instance.routes.get(\"/editor\")");
});

test("the shared session needs no new route, so copying the page never waits for ComfyUI", () => {
  // Every route the custom node registers. One new route here would mean the page only worked after a restart.
  const routes = [...repoInit().matchAll(/routes\.(get|post|delete|put)\("([^"]+)"\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  expect(routes).toEqual(["GET /editor"]);
  // The session is kept through ComfyUI's own user data store and followed through its own queue and history.
  const page = repoPage();
  expect(page).toContain("/userdata/");
  expect(page).toContain("overwrite=false");
  expect(page).toContain("/history/");
  expect(page).toContain("/queue");
  // Claims are taken with the store's own move route, and an edit is stopped with ComfyUI's own cancel: both are
  // ComfyUI's routes (app/user_manager.py, server.py), so nothing here waits for a restart either.
  expect(page).toContain("/move/");
  expect(page).toContain("/api/jobs/");
});

test("the warm-up still loads exactly the models the page in the repo uses", () => {
  expect(editorModels(repoPage())).toEqual({
    unet: "qwen-image-2.1-turbo-Q4_K_M.gguf",
    clip: "qwen3vl_8b-Q4_K_M.gguf",
    vae: "qwen_image_2.1_vae_bf16.safetensors",
  });
});

test("a folder that isn't an install says so instead of being written into", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-editor-none-"));
  dirs.push(dir);
  expect(editorDiff(dir).problem).toContain("no ComfyUI");
  const done = syncEditor(dir);
  expect(done).toEqual({ changed: [], waiting: [], problem: done.problem });
  expect(existsSync(join(dir, EDITOR_NODE))).toBe(false);
  expect(syncWords(done)).toContain("wasn't put in place");
});

test("a fresh install gets both files, and is left alone the second time", () => {
  const dir = install();
  expect(editorDiff(dir).changed).toEqual(["editor.html", "__init__.py"]);
  const first = syncEditor(dir);
  expect(first).toEqual({ changed: ["editor.html", "__init__.py"], waiting: ["__init__.py"], problem: null });
  expect(pageOf(dir)).toBe(repoPage());
  expect(readFileSync(join(dir, EDITOR_NODE, "__init__.py"), "utf8")).toBe(repoInit());
  expect(syncWords(first)).toBe("editor.html updated; devices get it the next time they open the page · __init__.py updated; it starts working when ComfyUI next starts");

  expect(editorDiff(dir).changed).toEqual([]);
  expect(syncEditor(dir)).toEqual({ changed: [], waiting: [], problem: null });
  expect(syncWords({ changed: [], waiting: [], problem: null })).toBeNull();
  // Nothing half-written is left behind.
  expect(existsSync(join(dir, EDITOR_NODE, ".editor.html.new"))).toBe(false);
});

test("a page edited by hand is kept beside the new one", () => {
  const dir = install("<p>mine</p>");
  const done = syncEditor(dir);
  expect(done.changed).toContain("editor.html");
  expect(pageOf(dir)).toBe(repoPage());
  expect(readFileSync(join(dir, EDITOR_NODE, "editor.html.replaced"), "utf8")).toBe("<p>mine</p>");
  // A page already up to date is not backed up again.
  rmSync(join(dir, EDITOR_NODE, "editor.html.replaced"));
  expect(syncEditor(dir).changed).toEqual([]);
  expect(existsSync(join(dir, EDITOR_NODE, "editor.html.replaced"))).toBe(false);
});

test("the hub puts the page in place when it is asked to, without starting the server", async () => {
  const dir = install("<p>old</p>");
  const port = await freePort();
  const ed = editor(dir, port);
  await ed.start();
  await untilPage(dir);
  const status = await ed.status();
  expect(status.state).toBe("off");
  // Nothing was launched to do it.
  expect(existsSync(join(dir, "fake-comfy.log"))).toBe(false);
});

test("the hub leaves the install alone unless it was asked: starting is not asking", async () => {
  const dir = install("<p>mine</p>");
  const port = await freePort();
  const ed = editor(dir, port, false);
  await ed.start();
  await ed.status();
  // Watcher ticks go by (200 ms each) and the page the user has is still theirs.
  await Bun.sleep(700);
  expect(pageOf(dir)).toBe("<p>mine</p>");
  expect(existsSync(join(dir, EDITOR_NODE, "editor.html.replaced"))).toBe(false);
  // Switching the server on is not asking either: that is a request about the server, not about their page. (The server
  // this starts is ended after the test, with everything else it started.)
  await ed.set(true).catch(() => {});
  await Bun.sleep(400);
  expect(pageOf(dir)).toBe("<p>mine</p>");
});

test("a server that can't say what it's doing counts as busy, so the page waits", async () => {
  const dir = install("<p>old</p>");
  const port = await freePort();
  // It answers /system_stats but not /queue, as one loading ~10 GB of models does.
  const configure = await serve(dir, port, { queueDown: true });
  const ed = editor(dir, port);
  await ed.start();
  await Bun.sleep(700);
  // An unreadable queue must not read as "nothing running".
  expect(pageOf(dir)).toBe("<p>old</p>");

  // Once it can answer again the page goes in.
  configure({});
  await untilPage(dir);
});

test("the page is not swapped under a running edit, and goes in once that edit is done", async () => {
  const dir = install("<p>old</p>");
  const port = await freePort();
  const configure = await serve(dir, port, { busy: true });
  const ed = editor(dir, port);
  await ed.start();
  // Someone is editing: the page stays as it is, watcher tick after watcher tick.
  await Bun.sleep(700);
  expect(pageOf(dir)).toBe("<p>old</p>");
  expect((await ed.status()).state).toBe("ready");

  configure({});
  await untilPage(dir);
});
