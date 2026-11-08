import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { LocalLibrary as LibraryView, PoolModel } from "@crosstalk/shared";
import { App } from "../src/app";
import { writeSecret } from "../src/config";
import { checkFolder, driveOf, folderLater, folderProblem, localLibraryOf, machineFrom, probeFolder, probeProblem } from "../src/localLibrary";
import { localRunnersOf } from "../src/localRunners";
import { download as poolDownload, DOWNLOADERS, modelPath, modelsDir } from "../src/pool/models";
import { HF_SECRET } from "../src/pool/pool";
import { startServer } from "../src/server";
import { fakeOllamaLive } from "./fixtures/fake-local-models";
import { fakeLmStudio } from "./fixtures/fake-services";
import { qwenLike } from "./fixtures/gguf";
import { fakeHuggingFace, installScript } from "./fixtures/pool-fakes";

// Settings → Local models, getting models (localLibrary.ts): a fake Hugging Face and a fake Ollama on 127.0.0.1 port 0, folders in
// the temp folder, and a pretend machine. Nothing here downloads a real model, reaches the internet or writes the person's own files.

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const TOKEN = "hf_testtoken1234567890";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const env = (key: string, value: string | undefined) => {
  const was = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  cleanups.push(() => {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  });
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ct-library-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  app.poolNode.gpus = async () => [];
  const lib = localLibraryOf(app);
  lib.trashOptions = { home: join(dir, "home"), platform: process.platform, gio: false };
  lib.ramBytes = () => 16 * GiB;
  lib.unified = true;
  lib.diskCheckMs = 20;
  const runners = localRunnersOf(app);
  runners.find = () => [];
  runners.portFree = () => true;
  // Ollama's own folder, for its pulls' disk check: never the person's ~/.ollama.
  env("OLLAMA_MODELS", join(dir, "ollama"));
  cleanups.push(async () => {
    await lib.shutdown();
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, lib, dir, folder: (name = "models") => join(dir, name) };
}

/** Waits (up to 8 seconds) until it's so. */
const until = async (done: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await done()) && Date.now() < end) await Bun.sleep(15);
  expect(await done()).toBe(true);
};
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []);

/** Hugging Face with a Qwen3 8B repo (two quants, a vision add-on), a smaller one, and a gated one. */
function hugging(opts: { big?: number } = {}) {
  const repos = {
    "unsloth/Qwen3-8B-GGUF": {
      files: { "Qwen3-8B-Q4_K_M.gguf": qwenLike(opts.big ?? 300_000), "Qwen3-8B-Q8_0.gguf": qwenLike(600_000), "mmproj-F16.gguf": qwenLike(10) },
      downloads: 5000,
      params: 8_190_000_000,
      contextLength: 40960,
    },
    "bartowski/Qwen3-8B-GGUF": { files: { "Qwen3-8B-Q4_K_M.gguf": qwenLike(10) }, downloads: 900 },
    "orcarouter/Gated-GGUF": { gated: "manual" as const, files: { "Gated-Q4_K_M.gguf": qwenLike(1000) }, downloads: 10 },
  };
  const hf = fakeHuggingFace(repos, { token: TOKEN });
  env("CROSSTALK_HF_URL", hf.url);
  cleanups.push(() => hf.stop());
  return { hf, repos };
}
const q4 = (repos: ReturnType<typeof hugging>["repos"]): PoolModel => ({ repo: "unsloth/Qwen3-8B-GGUF", files: ["Qwen3-8B-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: repos["unsloth/Qwen3-8B-GGUF"].files["Qwen3-8B-Q4_K_M.gguf"].length, gated: false });
const download = (v: LibraryView, id: string) => v.downloads.find((d) => d.id === id);

test("the machine's memory for models: Metal's working set as llama.cpp says it, else a share of the memory; a PC's free GPU memory; none on the processor", async () => {
  const metal = [{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }, { name: "BLAS", description: "Accelerate", totalMiB: 0, freeMiB: 0 }];
  expect(machineFrom(16 * GiB, true, metal)).toEqual({ ramBytes: 16 * GiB, unified: true, gpuBytes: 12124 * MiB, gpuFrom: "llama.cpp", gpus: [{ name: "Apple M4", totalBytes: 12124 * MiB, freeBytes: 12123 * MiB }, { name: "Accelerate", totalBytes: 0, freeBytes: 0 }] });
  // Without llama.cpp: about two thirds up to 36 GB, three quarters above.
  expect(machineFrom(16 * GiB, true, [])).toMatchObject({ gpuBytes: Math.round((16 * GiB * 2) / 3), gpuFrom: "estimate" });
  expect(machineFrom(64 * GiB, true, [])).toMatchObject({ gpuBytes: 48 * GiB, gpuFrom: "estimate" });
  // A PC: what its GPUs have free, all of them.
  const pc = [{ name: "Vulkan0", description: "AMD Radeon RX 7600 XT (RADV NAVI33)", totalMiB: 16304, freeMiB: 15890 }, { name: "CUDA0", description: "NVIDIA GeForce RTX 3060", totalMiB: 8192, freeMiB: 7900 }];
  expect(machineFrom(32 * GiB, false, pc)).toMatchObject({ unified: false, gpuBytes: (15890 + 7900) * MiB, gpuFrom: "llama.cpp", gpus: [{ name: "RX 7600 XT" }, { name: "RTX 3060" }] });
  expect(machineFrom(32 * GiB, false, [])).toEqual({ ramBytes: 32 * GiB, unified: false, gpuBytes: null, gpuFrom: null, gpus: [] });

  // The hub asks the model pool's llama.cpp first, then a llama-server it found here (the fake lists an Apple M4's GPU).
  const { app, lib, dir } = setup();
  const bin = installScript("fake-llama-server", join(dir, "llama-server"));
  localRunnersOf(app).find = () => [{ kind: "llamacpp", path: bin, from: "Homebrew" }];
  expect(await lib.machine()).toMatchObject({ ramBytes: 16 * GiB, unified: true, gpuBytes: 12124 * MiB, gpuFrom: "llama.cpp" });
  app.poolNode.gpus = async () => [{ name: "MTL0", description: "Apple M4", totalMiB: 10000, freeMiB: 10000 }];
  // Looked at a moment ago: kept (the page asks every second while a download runs) unless asked afresh.
  expect((await lib.machine()).gpuBytes).toBe(12124 * MiB);
  expect((await lib.machine(true)).gpuBytes).toBe(10000 * MiB);
  expect((await lib.machine()).gpuBytes).toBe(10000 * MiB);
});

test("the folder: Crosstalk's own by default, any folder this hub can write to, and back again; plain words when it can't", async () => {
  const { lib, dir, folder } = setup();
  const own = lib.folderView();
  expect(own).toMatchObject({ isDefault: true, drive: null, problem: null });
  expect(own.freeBytes).toBeGreaterThan(0);
  // A new folder is made and kept.
  const mine = await lib.setFolder({ path: folder("mine/models") });
  expect(mine).toMatchObject({ path: folder("mine/models"), isDefault: false, problem: null });
  expect(statSync(folder("mine/models")).isDirectory()).toBe(true);
  expect(lib.folder()).toBe(folder("mine/models"));
  // No write test is left behind.
  expect(readdirSync(folder("mine/models"))).toEqual([]);
  // Back to Crosstalk's own.
  expect((await lib.setFolder({ path: null })).isDefault).toBe(true);
  expect((await lib.setFolder({ path: "" })).isDefault).toBe(true);
  // What it can't use, in plain words.
  await expect(lib.setFolder({ path: "models" })).rejects.toThrow("Type the folder's full path, starting with / or ~/ (like ~/Models).");
  await expect(lib.setFolder({})).rejects.toThrow("Type the folder's full path, like ~/Models or /Volumes/Untitled/models.");
  writeFileSync(join(dir, "a-file"), "x");
  await expect(lib.setFolder({ path: join(dir, "a-file") })).rejects.toThrow("is a file, not a folder: pick a folder.");
  mkdirSync(folder("locked"));
  chmodSync(folder("locked"), 0o555);
  cleanups.push(() => chmodSync(folder("locked"), 0o755));
  if (process.getuid?.() !== 0) await expect(lib.setFolder({ path: folder("locked/models") })).rejects.toThrow(/^Crosstalk can't write to .*locked\/models: pick another folder\.$/);
  expect(lib.folder()).not.toContain("locked");
  // ~ is the home folder.
  expect(checkFolder("~/Models")).toBe(join(homedir(), "Models"));
});

test("a new folder is tried from another process first: macOS may ask on the screen, and the hub mustn't wait on that itself", async () => {
  const { app, lib, dir, folder } = setup();
  // The real try: made, written, and nothing left behind.
  expect(await probeFolder(folder("deep/er/models"))).toEqual({ ok: true });
  expect(readdirSync(folder("deep/er/models"))).toEqual([]);
  mkdirSync(folder("ro"));
  chmodSync(folder("ro"), 0o555);
  cleanups.push(() => chmodSync(folder("ro"), 0o755));
  if (process.getuid?.() !== 0) expect(await probeFolder(folder("ro/models"))).toMatchObject({ ok: false, waited: false, said: expect.stringMatching(/Permission denied/i) });
  // A write that waits (macOS asking on its screen, a network folder that's gone): answered at the limit, without
  // waiting for the waiting mkdir, which is ended with its process group.
  const bin = join(dir, "slow-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "mkdir"), `#!/bin/sh\necho $$ > "${join(dir, "mkdir.pid")}"\nexec sleep 30\n`, { mode: 0o755 });
  env("PATH", `${bin}:${process.env.PATH}`);
  const asked = Date.now();
  expect(await probeFolder(folder("slow/models"), 400)).toEqual({ ok: false, waited: true, said: "" });
  expect(Date.now() - asked).toBeLessThan(2500);
  const waiting = Number(readFileSync(join(dir, "mkdir.pid"), "utf8"));
  await until(() => {
    try {
      process.kill(waiting, 0);
      return false;
    } catch {
      return true;
    }
  });
  env("PATH", process.env.PATH!.slice(bin.length + 1));
  // What each outcome says.
  const name = app.machineName();
  expect(probeProblem("/Volumes/Untitled/models", { ok: false, waited: true, said: "" }, "Mac mini", true)).toBe("macOS is asking on Mac mini's screen whether Crosstalk may use /Volumes/Untitled/models: allow it there, then save again.");
  expect(probeProblem("/mnt/nas/models", { ok: false, waited: true, said: "" }, "Linux box", false)).toBe("/mnt/nas/models didn't answer in time (a drive that's asleep, or a network folder that's gone?): check it, then save again.");
  expect(probeProblem("/Volumes/WIN/models", { ok: false, waited: false, said: "mkdir: /Volumes/WIN/models: Read-only file system" }, "Mac mini", true)).toBe("/Volumes/WIN/models is on a read-only drive (a Windows drive is, on a Mac): pick another folder.");
  expect(probeProblem("/Volumes/Full/models", { ok: false, waited: false, said: "sh: line 1: /Volumes/Full/models/x: No space left on device" }, "Mac mini", true)).toBe("The drive /Volumes/Full/models is on is full: free up space, or pick another folder.");
  expect(probeProblem("/Volumes/Untitled/models", { ok: false, waited: false, said: "mkdir: /Volumes/Untitled/models: Operation not permitted" }, "Mac mini", true)).toBe("macOS didn't let Crosstalk use /Volumes/Untitled/models: allow it in System Settings → Privacy & Security → Files and Folders, then save again.");
  expect(probeProblem("/srv/x", { ok: false, waited: false, said: "mkdir: /srv/x: Permission denied" }, "Linux box", false)).toBe("Crosstalk can't write to /srv/x: pick another folder.");
  // While macOS waits on its screen: the folder isn't changed, and the page says where to answer.
  lib.probe = async () => ({ ok: false, waited: true, said: "" });
  const err = await lib.setFolder({ path: folder("asked") }).catch((e) => e);
  expect(err).toMatchObject({ status: 409, code: "folder" });
  expect(err.message).toBe(process.platform === "darwin" ? `macOS is asking on ${name}'s screen whether Crosstalk may use ${folder("asked")}: allow it there, then save again.` : `${folder("asked")} didn't answer in time (a drive that's asleep, or a network folder that's gone?): check it, then save again.`);
  expect(lib.folder()).not.toBe(folder("asked"));
});

test("a folder on an external drive: its name, and when the drive isn't plugged in, downloads wait for it with the way out", async () => {
  // A pretend machine: this disk is device 1; /Volumes/Untitled is a drive (7), /Volumes/Gone was unplugged, /Volumes/Stale
  // is a folder left on this disk where a drive was; on Linux /media/me/USB was unplugged too.
  const devices: Record<string, number> = { "/": 1, "/Volumes": 1, "/Volumes/Untitled": 7, "/Volumes/Stale": 1, "/media": 1, "/media/me": 1, "/media/me/USB": 1 };
  const deviceOf = (p: string) => devices[p] ?? null;
  const noFstab = () => [];
  expect(driveOf("/Volumes/Untitled/models", deviceOf, noFstab)).toEqual({ mount: "/Volumes/Untitled", name: "Untitled", mounted: true });
  expect(driveOf("/Volumes/Gone/models", deviceOf, noFstab)).toEqual({ mount: "/Volumes/Gone", name: "Gone", mounted: false });
  expect(driveOf("/Volumes/Stale/models", deviceOf, noFstab)).toEqual({ mount: "/Volumes/Stale", name: "Stale", mounted: false });
  expect(driveOf("/media/me/USB/models", deviceOf, noFstab)).toMatchObject({ name: "USB", mounted: false });
  expect(driveOf(join(homedir(), "Models"), deviceOf, noFstab)).toBeNull();
  expect(folderProblem("/Volumes/Gone/models", deviceOf)).toBe("The drive Gone isn't plugged in: plug it in, or change the folder.");
  // /mnt: a drive wherever it's mounted in there, a plain folder on this disk is this disk's, and one fstab mounts there
  // by itself isn't plugged in while it isn't mounted.
  const linux: Record<string, number> = { "/": 1, "/mnt": 1, "/mnt/models": 1, "/mnt/data": 1, "/mnt/data/disk2": 9, "/mnt/data/disk3": 1, "/mnt/c": 4 };
  const linuxOf = (p: string) => linux[p] ?? null;
  const fstab = () => ["/", "/boot/efi", "/mnt/data/disk3"];
  expect(driveOf("/mnt/models/qwen", linuxOf, fstab)).toBeNull();
  expect(folderProblem("/mnt/models/qwen", linuxOf)).not.toContain("isn't plugged in");
  expect(driveOf("/mnt/data/disk2/models", linuxOf, fstab)).toEqual({ mount: "/mnt/data/disk2", name: "disk2", mounted: true });
  expect(driveOf("/mnt/data/disk3/models", linuxOf, fstab)).toEqual({ mount: "/mnt/data/disk3", name: "disk3", mounted: false });
  expect(driveOf("/mnt/c/Users/me/models", linuxOf, fstab)).toMatchObject({ name: "c", mounted: true });

  // The chosen drive is unplugged: the page says so, and a download is refused with the same words.
  const { app, lib } = setup();
  app.store.kvSet("localModels.folder", "/Volumes/ct-test-unplugged-drive/models");
  const view = lib.folderView();
  expect(view).toMatchObject({ drive: "ct-test-unplugged-drive", freeBytes: null, problem: "The drive ct-test-unplugged-drive isn't plugged in: plug it in, or change the folder." });
  await expect(lib.setFolder({ path: "/Volumes/ct-test-unplugged-drive/models" })).rejects.toThrow("The drive ct-test-unplugged-drive isn't plugged in: plug it in, or change the folder.");
});

test("the page's every-second look never waits on the folder: a drive that doesn't answer is shown as it last was, marked pending", async () => {
  const { lib, dir, folder } = setup();
  const { repos } = hugging();
  await lib.setFolder({ path: folder() });
  await lib.startDownload({ source: "huggingface", model: q4(repos) });
  await lib.idle();
  // The look made off the event loop says what the one made on it says (free space aside: it moves between two looks).
  const steady = (f: LibraryView["folder"]) => ({ ...f, freeBytes: typeof f.freeBytes, totalBytes: typeof f.totalBytes });
  writeFileSync(join(dir, "a-file"), "x");
  for (const path of [folder(), join(dir, "not-yet", "models"), join(dir, "a-file"), "/Volumes/ct-test-unplugged-drive/models"]) expect(steady(await folderLater(path))).toEqual(steady(lib.folderView(path)));
  const before = await lib.view();
  expect(before.folder.pending).toBeUndefined();
  expect(before.files.map((f) => f.id)).toEqual(["unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"]);

  // The folder stops answering (a drive asleep, a network folder that's gone): the page gets the last look at once, marked pending.
  const looks = lib as unknown as { lookNow: (root: string) => Promise<unknown>; seen: { at: number } | null };
  const real = looks.lookNow.bind(lib);
  looks.lookNow = () => new Promise(() => {});
  lib.lookWaitMs = 100;
  looks.seen!.at = 0;
  const asked = Date.now();
  const stale = await lib.view();
  expect(Date.now() - asked).toBeLessThan(1000);
  expect(stale.folder).toEqual({ ...before.folder, pending: true });
  expect(stale.files).toEqual(before.files);
  // A folder never looked at yet: said so, with the way out.
  await lib.setFolder({ path: null });
  const first = await lib.view();
  expect(first.folder).toMatchObject({ isDefault: true, freeBytes: null, pending: true, problem: expect.stringMatching(/ hasn't answered yet \(a drive waking up, or a network folder that's gone\?\): wait a moment, or change the folder\.$/) });
  expect(first.files).toEqual([]);
  // It answers again: so does the page.
  looks.lookNow = real;
  await lib.setFolder({ path: folder() });
  expect(steady((await lib.view()).folder)).toEqual(steady(before.folder));
});

test("search and a repo's files: GGUF models, most downloaded first, and the shape read from the smallest file's first bytes", async () => {
  const { lib } = setup();
  const { hf } = hugging();
  const hits = await lib.search("qwen3");
  expect(hits).toEqual([
    { repo: "unsloth/Qwen3-8B-GGUF", downloads: 5000, gated: false, params: 8_190_000_000, contextLength: 40960 },
    { repo: "bartowski/Qwen3-8B-GGUF", downloads: 900, gated: false, params: null, contextLength: null },
  ]);
  const asked = new URL(hf.url + hf.requests.find((r) => r.path.startsWith("/api/models?"))!.path);
  expect(Object.fromEntries(asked.searchParams)).toMatchObject({ search: "qwen3", filter: "gguf", sort: "downloads", direction: "-1", limit: "20" });
  await expect(lib.search("q")).rejects.toThrow("Type at least two letters of a model's name, like qwen3 or gemma.");

  const repo = await lib.repoFiles("https://huggingface.co/unsloth/Qwen3-8B-GGUF");
  expect(repo.repo).toBe("unsloth/Qwen3-8B-GGUF");
  // Smallest first, without the vision add-on, and the shape of a Qwen3 8B: 144 KiB a token, 40,960 tokens.
  expect(repo.models.map((m) => [m.quant, m.files])).toEqual([["Q4_K_M", ["Qwen3-8B-Q4_K_M.gguf"]], ["Q8_0", ["Qwen3-8B-Q8_0.gguf"]]]);
  expect(repo).toMatchObject({ kvBytesPerToken: 147456, contextLength: 40960 });
  // Only its first megabyte was asked for.
  expect(hf.storageRequests.filter((r) => r.path.includes("Q4_K_M")).map((r) => r.range)).toEqual(["bytes=0-1048575"]);

  // A gated repo's header needs the token: without one the shape isn't known (its list still is).
  await expect(lib.repoFiles("nobody/nothing-GGUF")).rejects.toThrow("Couldn't find nobody/nothing-GGUF on Hugging Face");
  const gated = await lib.repoFiles("orcarouter/Gated-GGUF");
  expect(gated).toMatchObject({ gated: true, kvBytesPerToken: null, contextLength: null });
  writeSecret(HF_SECRET, TOKEN);
  cleanups.push(() => writeSecret(HF_SECRET, null));
  const withToken = await lib.repoFiles("orcarouter/Gated-GGUF");
  expect(withToken.kvBytesPerToken).toBe(147456);
  expect(JSON.stringify(withToken)).not.toContain(TOKEN);
});

test("a download shows its progress, stops where it is, and picks up from there into the folder", async () => {
  const { lib, folder } = setup();
  const { hf, repos } = hugging({ big: 1_200_000 });
  hf.slow.add("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf");
  await lib.setFolder({ path: folder() });
  const m = q4(repos);
  const id = "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
  const started = await lib.startDownload({ source: "huggingface", model: m });
  expect(download(started, id)).toMatchObject({ source: "huggingface", name: "Qwen3-8B Q4_K_M", state: "downloading", totalBytes: m.sizeBytes, error: null });
  // Starting it again while it runs changes nothing.
  await lib.startDownload({ source: "huggingface", model: m });
  await until(async () => (download(await lib.view(), id)?.doneBytes ?? 0) > 0);
  const stopped = await lib.stopDownload({ id });
  const d = download(stopped, id)!;
  expect(d.state).toBe("stopped");
  expect(d.doneBytes).toBeGreaterThan(0);
  expect(d.doneBytes).toBeLessThan(m.sizeBytes);
  expect(d.bytesPerSec).toBeNull();
  const part = join(folder(), "unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf.part");
  expect(statSync(part).size).toBe(d.doneBytes);
  // Not a model yet.
  expect(stopped.files).toEqual([]);

  // Resume: the rest only, then it's a model in the folder with its shape, and the download is done with.
  hf.slow.clear();
  await lib.startDownload({ source: "huggingface", model: m });
  await lib.idle();
  const after = await lib.view();
  expect(after.downloads).toEqual([]);
  expect(after.files).toEqual([{ id: "unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf", repo: "unsloth/Qwen3-8B-GGUF", files: ["Qwen3-8B-Q4_K_M.gguf"], quant: "Q4_K_M", bytes: m.sizeBytes, kvBytesPerToken: 147456, contextLength: 40960 }]);
  expect(readFileSync(join(folder(), "unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf")).equals(Buffer.from(repos["unsloth/Qwen3-8B-GGUF"].files["Qwen3-8B-Q4_K_M.gguf"]))).toBe(true);
  expect(hf.storageRequests.filter((r) => r.path.includes("Q4_K_M") && r.range?.startsWith("bytes=") && r.range !== "bytes=0-1048575").map((r) => r.range)).toEqual([`bytes=${d.doneBytes}-`]);
  // Downloading it again is nothing to do.
  expect((await lib.startDownload({ source: "huggingface", model: m })).downloads).toEqual([]);
});

test("a stopped download carries on in its own folder; new ones go to the folder chosen now; a restart keeps it, stopped", async () => {
  const { app, lib, folder } = setup();
  const { hf, repos } = hugging({ big: 1_200_000 });
  hf.slow.add("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf");
  await lib.setFolder({ path: folder("first") });
  const id = "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
  await lib.startDownload({ source: "huggingface", model: q4(repos) });
  await until(async () => (download(await lib.view(), id)?.doneBytes ?? 0) > 0);
  await lib.stopDownload({ id });
  await lib.setFolder({ path: folder("second") });

  // The hub restarts: the download is there, stopped, with what it had.
  const kept = app.store.kvGet("localModels.downloads")!;
  expect(kept).not.toContain(TOKEN);
  const dir2 = mkdtempSync(join(tmpdir(), "ct-library-2-"));
  const app2 = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir2, maxHopsDefault: 6 } });
  cleanups.push(async () => {
    await localLibraryOf(app2).shutdown();
    await app2.engine.shutdown();
    app2.store.close();
    rmSync(dir2, { recursive: true, force: true });
  });
  app2.poolNode.gpus = async () => [];
  localRunnersOf(app2).find = () => [];
  localRunnersOf(app2).portFree = () => true;
  app2.store.kvSet("localModels.downloads", kept);
  app2.store.kvSet("localModels.folder", folder("second"));
  const lib2 = localLibraryOf(app2);
  const back = download(await lib2.view(), id)!;
  expect(back).toMatchObject({ state: "stopped", name: "Qwen3-8B Q4_K_M" });
  expect(back.doneBytes).toBe(statSync(join(folder("first"), "unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf.part")).size);

  // Picked up, it finishes where it began.
  hf.slow.clear();
  await lib2.startDownload({ source: "huggingface", model: q4(repos) });
  await lib2.idle();
  expect(files(folder("first"))).toContain(join("unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf"));
  expect(files(folder("second"))).toEqual([]);
  expect(lib2.files(folder("first")).map((f) => f.id)).toEqual(["unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"]);
  // A new one goes to the folder chosen now.
  await lib2.startDownload({ source: "huggingface", model: { repo: "bartowski/Qwen3-8B-GGUF", files: ["Qwen3-8B-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: repos["bartowski/Qwen3-8B-GGUF"].files["Qwen3-8B-Q4_K_M.gguf"].length, gated: false } });
  await lib2.idle();
  expect((await lib2.view()).files.map((f) => f.id)).toEqual(["bartowski/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"]);
});

/** A second hub (the first one restarted) with what the first kept: its downloads and its folder. */
function restarted(kept: { downloads: string; folder: string }) {
  const dir = mkdtempSync(join(tmpdir(), "ct-library-again-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(async () => {
    await localLibraryOf(app).shutdown();
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  app.poolNode.gpus = async () => [];
  localRunnersOf(app).find = () => [];
  localRunnersOf(app).portFree = () => true;
  app.store.kvSet("localModels.downloads", kept.downloads);
  app.store.kvSet("localModels.folder", kept.folder);
  return localLibraryOf(app);
}

test("downloads running when the hub stopped carry on when it starts again (after a crash too); one the person stopped waits for Resume", async () => {
  const { app, lib, folder } = setup();
  const { hf, repos } = hugging({ big: 1_200_000 });
  const q8: PoolModel = { ...q4(repos), files: ["Qwen3-8B-Q8_0.gguf"], quant: "Q8_0", sizeBytes: repos["unsloth/Qwen3-8B-GGUF"].files["Qwen3-8B-Q8_0.gguf"].length };
  hf.slow.add("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf");
  hf.slow.add("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q8_0.gguf");
  await lib.setFolder({ path: folder() });
  const ids = { q4: "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf", q8: "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q8_0.gguf" };
  await lib.startDownload({ source: "huggingface", model: q8 });
  await until(async () => (download(await lib.view(), ids.q8)?.doneBytes ?? 0) > 0);
  await lib.stopDownload({ id: ids.q8 });
  await lib.startDownload({ source: "huggingface", model: q4(repos) });
  await until(async () => (download(await lib.view(), ids.q4)?.doneBytes ?? 0) > 0);
  // The hub stops (an update, say) while Q4_K_M downloads.
  await lib.shutdown();
  const kept = { downloads: app.store.kvGet("localModels.downloads")!, folder: folder() };

  hf.slow.clear();
  const again = restarted(kept);
  await again.resumeInterrupted();
  expect(download(await again.view(), ids.q4)?.state).toBe("downloading");
  expect(download(await again.view(), ids.q8)?.state).toBe("stopped");
  await again.idle();
  const after = await again.view();
  expect(after.files.map((f) => f.id)).toEqual(["unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"]);
  expect(after.downloads.map((d) => [d.id, d.state])).toEqual([[ids.q8, "stopped"]]);

  // A hub that stopped without saying (a crash): what it noted as downloading carries on too.
  const crashed = JSON.stringify((JSON.parse(kept.downloads) as { id: string; state: string }[]).filter((d) => d.id === ids.q8).map((d) => ({ ...d, state: "downloading" })));
  const third = restarted({ downloads: crashed, folder: folder() });
  await third.resumeInterrupted();
  await third.idle();
  expect((await third.view()).downloads).toEqual([]);
  expect((await third.view()).files.map((f) => f.id)).toContain("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q8_0.gguf");

  // One that can't carry on (its drive isn't there) says why and waits.
  const unplugged = JSON.stringify((JSON.parse(kept.downloads) as { id: string; root: string }[]).filter((d) => d.id === ids.q4).map((d) => ({ ...d, root: "/Volumes/ct-test-unplugged-drive/models", resume: true })));
  const fourth = restarted({ downloads: unplugged, folder: folder() });
  await fourth.resumeInterrupted();
  expect(download(await fourth.view(), ids.q4)).toMatchObject({ state: "failed", code: "folder", error: "The drive ct-test-unplugged-drive isn't plugged in: plug it in, or change the folder." });
});

test("a gated model: plain words on what to do, then it downloads with the saved token, which never comes back", async () => {
  const { lib, folder } = setup();
  const { hf, repos } = hugging();
  await lib.setFolder({ path: folder() });
  const gated: PoolModel = { repo: "orcarouter/Gated-GGUF", files: ["Gated-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: repos["orcarouter/Gated-GGUF"].files["Gated-Q4_K_M.gguf"].length, gated: true };
  const id = "hf:orcarouter/Gated-GGUF/Gated-Q4_K_M.gguf";
  await lib.startDownload({ source: "huggingface", model: gated });
  await lib.idle();
  const failed = download(await lib.view(), id)!;
  expect(failed).toMatchObject({ state: "failed", code: "hf_terms" });
  expect(failed.error).toContain("accept the model's terms, then save a Hugging Face token");
  expect((await lib.view()).hasHfToken).toBe(false);

  writeSecret(HF_SECRET, TOKEN);
  cleanups.push(() => writeSecret(HF_SECRET, null));
  await lib.startDownload({ source: "huggingface", model: gated });
  await lib.idle();
  const done = await lib.view();
  expect(done.hasHfToken).toBe(true);
  expect(done.downloads).toEqual([]);
  expect(done.files.map((f) => f.id)).toEqual(["orcarouter/Gated-GGUF/Gated-Q4_K_M.gguf"]);
  expect(JSON.stringify(done)).not.toContain(TOKEN);
  // The token went to Hugging Face, never to where it sends the file from.
  expect(hf.requests.some((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  expect(hf.storageRequests.every((r) => r.auth === null)).toBe(true);
});

test("not enough room: refused before it starts, with what it needs and the ways out", async () => {
  const { lib, folder } = setup();
  const { repos } = hugging();
  await lib.setFolder({ path: folder() });
  env("CROSSTALK_UPLOAD_RESERVE_BYTES", String(1e15));
  const err = await lib.startDownload({ source: "huggingface", model: q4(repos) }).catch((e) => e);
  expect(err).toMatchObject({ status: 507, code: "low_disk" });
  expect(err.message).toMatch(/^Not enough free space in .+ for Qwen3-8B Q4_K_M: it needs .+ more and nothing is free \(keeping .+ free\)\. Free up space, change the folder, or pick a smaller file\.$/);
  expect((await lib.view()).downloads).toEqual([]);
  expect((await lib.view()).reserveBytes).toBe(1e15);
  // An unplugged drive: refused with that, before anything else.
  env("CROSSTALK_UPLOAD_RESERVE_BYTES", undefined);
  lib.folder = () => "/Volumes/ct-test-unplugged-drive/models";
  await expect(lib.startDownload({ source: "huggingface", model: q4(repos) })).rejects.toMatchObject({ status: 409, code: "folder", message: "The drive ct-test-unplugged-drive isn't plugged in: plug it in, or change the folder." });
  await expect(lib.startDownload({ source: "nowhere" })).rejects.toMatchObject({ status: 400 });
  await expect(lib.startDownload({ source: "huggingface", model: { repo: "../etc", files: ["x.gguf"] } })).rejects.toMatchObject({ status: 400 });
});

test("remove: a stopped download and a downloaded model go to the Trash; never one a server Crosstalk started is using", async () => {
  const { app, lib, dir, folder } = setup();
  const { hf, repos } = hugging({ big: 1_200_000 });
  hf.slow.add("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf");
  await lib.setFolder({ path: folder() });
  const id = "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
  await lib.startDownload({ source: "huggingface", model: q4(repos) });
  await until(async () => (download(await lib.view(), id)?.doneBytes ?? 0) > 0);
  await expect(lib.removeDownload({ id })).rejects.toMatchObject({ status: 409, message: "It's still downloading: stop it first." });
  await lib.stopDownload({ id });
  const gone = await lib.removeDownload({ id });
  expect(gone.downloads).toEqual([]);
  expect(existsSync(join(folder(), "unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf.part"))).toBe(false);
  const trash = process.platform === "darwin" ? join(dir, "home", ".Trash") : join(dir, "home", ".local", "share", "Trash", "files");
  expect(files(trash)).toContain("Qwen3-8B-Q4_K_M.gguf.part");
  await expect(lib.removeDownload({ id })).rejects.toMatchObject({ status: 404 });

  hf.slow.clear();
  await lib.startDownload({ source: "huggingface", model: q4(repos) });
  await lib.idle();
  const fileId = "unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
  const runners = localRunnersOf(app);
  runners.serving = () => true;
  await expect(lib.removeFile({ id: fileId })).rejects.toMatchObject({ status: 409, message: "A llama.cpp server Crosstalk started is using this model: stop it first." });
  runners.serving = () => false;
  expect((await lib.removeFile({ id: fileId })).files).toEqual([]);
  expect(files(trash)).toContain("Qwen3-8B-Q4_K_M.gguf");
  await expect(lib.removeFile({ id: fileId })).rejects.toMatchObject({ status: 404 });
  await expect(lib.removeFile({ id: "../../etc/passwd" })).rejects.toMatchObject({ status: 400 });
});

test("remove on another drive: into that drive's own Trash, never copied onto this disk; without one it says so, and deletes only when asked again", async () => {
  const { lib, dir, folder } = setup();
  const { repos } = hugging();
  mkdirSync(folder("drive"));
  const drive = realpathSync(folder("drive"));
  await lib.setFolder({ path: join(drive, "models") });
  // A pretend machine: the drive folder is another device than the home folder and its Trash.
  lib.trashOptions = { ...lib.trashOptions, deviceOf: (p) => (!existsSync(p) ? null : realpathSync(p) === drive || realpathSync(p).startsWith(drive + sep) ? 2 : 1) };
  const fileId = "unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
  const get = async () => {
    await lib.startDownload({ source: "huggingface", model: q4(repos) });
    await lib.idle();
    expect((await lib.view()).files.map((f) => f.id)).toEqual([fileId]);
  };
  await get();
  expect((await lib.removeFile({ id: fileId })).files).toEqual([]);
  const uid = String(process.getuid?.() ?? 0);
  const driveTrash = process.platform === "darwin" ? join(drive, ".Trashes", uid) : join(drive, `.Trash-${uid}`, "files");
  expect(files(driveTrash)).toEqual(["Qwen3-8B-Q4_K_M.gguf"]);
  // Nothing came onto this machine's disk.
  expect(files(join(dir, "home"))).not.toContain("Qwen3-8B-Q4_K_M.gguf");
  if (process.platform === "darwin") chmodSync(join(drive, ".Trashes"), 0o755);
  rmSync(join(drive, process.platform === "darwin" ? ".Trashes" : `.Trash-${uid}`), { recursive: true, force: true });

  // The drive's Trash can't be made: the model stays, with the way out; deleting takes the person asking again.
  if (process.getuid?.() === 0) return;
  await get();
  chmodSync(drive, 0o555);
  cleanups.push(() => chmodSync(drive, 0o755));
  const err = await lib.removeFile({ id: fileId }).catch((e) => e);
  expect(err).toMatchObject({ status: 409, code: "no_trash" });
  expect(err.message).toStartWith("Qwen3-8B-Q4_K_M.gguf is on another drive, and Crosstalk can't use that drive's Trash: delete it for good instead");
  expect((await lib.view()).files.map((f) => f.id)).toEqual([fileId]);
  expect((await lib.removeFile({ id: fileId, forGood: true })).files).toEqual([]);
  expect(files(join(drive, "models"))).not.toContain(join("unsloth", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf"));
});

test("the model pool and Local models never download one file at once into Crosstalk's folder; one the pool finished is only forgotten", async () => {
  const { app, lib } = setup();
  const { hf, repos } = hugging({ big: 1_200_000 });
  const m = q4(repos);
  const id = "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
  // Crosstalk's own folder (the test run's home) is the pool's too.
  cleanups.push(() => rmSync(join(modelsDir(), "unsloth"), { recursive: true, force: true }));
  expect(lib.folder()).toBe(modelsDir());
  hf.slow.add("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf");
  await lib.startDownload({ source: "huggingface", model: m });
  await until(async () => (download(await lib.view(), id)?.doneBytes ?? 0) > 0);
  // While Local models writes it, the pool is told so (its own route and the download itself).
  await expect(app.poolNode.downloadModel(m)).rejects.toMatchObject({ status: 409, code: "busy", message: DOWNLOADERS.local });
  await expect(poolDownload(m, null, () => {})).rejects.toMatchObject({ status: 409, code: "busy", message: DOWNLOADERS.local });
  await lib.stopDownload({ id });

  // The other way round: while the pool downloads it, Local models says so at once, and its Remove leaves the pool's part alone.
  const pooled = poolDownload(m, null, () => {});
  await expect(lib.startDownload({ source: "huggingface", model: m })).rejects.toMatchObject({ status: 409, code: "busy", message: DOWNLOADERS.pool });
  await expect(lib.removeDownload({ id })).rejects.toMatchObject({ status: 409, code: "busy", message: DOWNLOADERS.pool });
  hf.slow.clear();
  await pooled;
  // One file, as Hugging Face has it.
  expect(readFileSync(modelPath(m)).equals(Buffer.from(repos["unsloth/Qwen3-8B-GGUF"].files["Qwen3-8B-Q4_K_M.gguf"]))).toBe(true);
  // The pool finished it: Remove only forgets the download, and the model stays (it may be in use).
  const after = await lib.removeDownload({ id });
  expect(after.downloads).toEqual([]);
  expect(existsSync(modelPath(m))).toBe(true);
  expect(after.files.map((f) => f.id)).toEqual(["unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"]);
});

test("the room check counts downloads still running on the same disk", async () => {
  const { lib, folder } = setup();
  const { hf, repos } = hugging({ big: 1_200_000 });
  await lib.setFolder({ path: folder() });
  // Sizes as big as the disk: one fits by itself, not two at once (the files themselves are small).
  const { free } = (await import("../src/storage")).diskSpace(folder());
  const big = Math.floor(free * 0.6);
  const q8: PoolModel = { ...q4(repos), files: ["Qwen3-8B-Q8_0.gguf"], quant: "Q8_0", sizeBytes: big };
  hf.slow.add("unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q8_0.gguf");
  await lib.startDownload({ source: "huggingface", model: q8 });
  const err = await lib.startDownload({ source: "huggingface", model: { ...q4(repos), sizeBytes: big } }).catch((e) => e);
  expect(err).toMatchObject({ status: 507, code: "low_disk" });
  expect(err.message).toMatch(/^Not enough free space in .+ for Qwen3-8B Q4_K_M: it needs .+ more and .+ free once Qwen3-8B Q8_0 has finished \(keeping .+ free\)\. Wait for it or stop it, change the folder, or pick a smaller file\.$/);
  await lib.stopDownload({ id: "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q8_0.gguf" });
  // Once it's stopped, there's room.
  await expect(lib.startDownload({ source: "huggingface", model: { ...q4(repos), sizeBytes: big } })).resolves.toBeDefined();
  await lib.idle();
});

test("an Ollama pull: its progress, stopped where it is, and picked up by the next pull until it's in", async () => {
  const { app, lib } = setup();
  const ollama = fakeOllamaLive({ pull: { stepMs: 25, chunk: 40_000 } });
  cleanups.push(() => ollama.stop());
  app.services.scanOptions = { ports: { [ollama.port]: "ollama" }, timeoutMs: 800 };
  const serverId = `ollama-${ollama.port}`;
  const id = `ollama:${serverId}:qwen3:14b`;
  const started = await lib.startDownload({ source: "ollama", serverId, model: " qwen3:14b " });
  expect(download(started, id)).toMatchObject({ source: "ollama", name: "qwen3:14b", ollama: { model: "qwen3:14b", serverId }, state: "downloading", model: null });
  await until(async () => (download(await lib.view(), id)?.doneBytes ?? 0) >= 80_000);
  const mid = download(await lib.view(), id)!;
  expect(mid.totalBytes).toBe(400_000);
  expect(mid.step).toMatch(/^pulling aaaaaaaaaaaa$/);
  const stopped = download(await lib.stopDownload({ id }), id)!;
  expect(stopped.state).toBe("stopped");
  const had = ollama.pulled("qwen3:14b")["sha256:" + "a".repeat(64)];
  expect(had).toBeGreaterThan(0);
  expect(had).toBeLessThan(400_000);

  await lib.startDownload({ source: "ollama", serverId, model: "qwen3:14b" });
  await lib.idle();
  expect((await lib.view()).downloads).toEqual([]);
  expect(ollama.pulls()).toEqual(["qwen3:14b", "qwen3:14b"]);
  expect(ollama.pulled("qwen3:14b")).toEqual({ ["sha256:" + "a".repeat(64)]: 400_000, ["sha256:" + "b".repeat(64)]: 1000 });
  // Ollama lists it now.
  expect((await app.services.localServers({ fresh: true })).servers[0].models.map((m) => m.id)).toContain("qwen3:14b");
  // Every pull asked Ollama to stream its progress.
  for (const s of ollama.seen.filter((x) => x.path === "/api/pull")) expect(JSON.parse(s.body)).toEqual({ model: "qwen3:14b", stream: true });
});

test("an Ollama pull that fails says why in plain words; only an Ollama on this machine is pulled into", async () => {
  const { app, lib, dir } = setup();
  const pullWith = async (fail: "missing" | "cut" | "error") => {
    const ollama = fakeOllamaLive({ pull: { fail } });
    cleanups.push(() => ollama.stop());
    app.services.scanOptions = { ports: { [ollama.port]: "ollama" }, timeoutMs: 800 };
    const serverId = `ollama-${ollama.port}`;
    await lib.startDownload({ source: "ollama", serverId, model: "nosuch:1b" });
    await lib.idle();
    return download(await lib.view(), `ollama:${serverId}:nosuch:1b`)!;
  };
  expect(await pullWith("missing")).toMatchObject({ state: "failed", error: "Ollama's library has no nosuch:1b: check the name at ollama.com/library, then try again." });
  expect(await pullWith("cut")).toMatchObject({ state: "failed", error: "Ollama stopped before nosuch:1b was all there: pull it again (Ollama picks up where it stopped, unless it restarted since)." });
  expect(await pullWith("error")).toMatchObject({ state: "failed", error: "Ollama couldn't pull nosuch:1b: something broke. Try again in a minute." });

  // LM Studio isn't Ollama; a server that went away; a name Ollama can't have; a disk that's almost full.
  const studio = fakeLmStudio();
  cleanups.push(() => studio.stop());
  app.services.scanOptions = { ports: { [studio.port]: "lmstudio" }, timeoutMs: 800 };
  await expect(lib.startDownload({ source: "ollama", serverId: `lmstudio-${studio.port}`, model: "qwen3:8b" })).rejects.toMatchObject({ status: 404, message: "That Ollama isn't running any more. Start it, then press Rescan." });
  await expect(lib.startDownload({ source: "ollama", serverId: "ollama-1", model: "../../x" })).rejects.toMatchObject({ status: 400 });
  const ollama = fakeOllamaLive();
  cleanups.push(() => ollama.stop());
  app.services.scanOptions = { ports: { [ollama.port]: "ollama" }, timeoutMs: 800 };
  env("CROSSTALK_UPLOAD_RESERVE_BYTES", String(1e15));
  // The folder that looks like an Ollama's (it has blobs) is checked before the pull.
  mkdirSync(join(dir, "ollama", "blobs"), { recursive: true });
  await expect(lib.startDownload({ source: "ollama", serverId: `ollama-${ollama.port}`, model: "qwen3:8b" })).rejects.toMatchObject({ status: 507, code: "low_disk" });
  expect(ollama.pulls()).toEqual([]);
});

test("an Ollama pull stops before the disk fills, with what it needs: the disk it writes to, found by its part file", async () => {
  const { app, lib, dir } = setup();
  // This Ollama keeps its models where the hub's own setting says (OLLAMA_MODELS, as setup gives it).
  const ollama = fakeOllamaLive({ pull: { stepMs: 20, chunk: 10_000, layers: [{ digest: "sha256:" + "c".repeat(64), size: 1e15 }], dir: join(dir, "ollama") } });
  cleanups.push(() => ollama.stop());
  app.services.scanOptions = { ports: { [ollama.port]: "ollama" }, timeoutMs: 800 };
  const serverId = `ollama-${ollama.port}`;
  await lib.startDownload({ source: "ollama", serverId, model: "huge:1t" });
  await lib.idle();
  const d = download(await lib.view(), `ollama:${serverId}:huge:1t`)!;
  expect(d).toMatchObject({ state: "failed", code: "low_disk" });
  expect(d.error).toMatch(/^Not enough free space for huge:1t: it needs .+ more and .+ is free \(keeping .+ free\)\. Free up space, then pull it again \(Ollama picks up where it stopped, unless it restarted since\)\.$/);
});

test("an Ollama whose folder can't be told: its pull says the disk isn't watched, and isn't stopped for a disk it can't see; one Crosstalk started is watched from the start", async () => {
  const { app, lib, dir } = setup();
  const huge = { stepMs: 20, chunk: 10_000, layers: [{ digest: "sha256:" + "e".repeat(64), size: 1e15 }] };
  // It writes its parts somewhere none of the places Ollama keeps models (the Ollama app's own "Model location", say).
  const elsewhere = fakeOllamaLive({ pull: { ...huge, dir: join(dir, "elsewhere") } });
  cleanups.push(() => elsewhere.stop());
  app.services.scanOptions = { ports: { [elsewhere.port]: "ollama" }, timeoutMs: 800 };
  const id = `ollama:ollama-${elsewhere.port}:huge:1t`;
  await lib.startDownload({ source: "ollama", serverId: `ollama-${elsewhere.port}`, model: "huge:1t" });
  await until(async () => !!download(await lib.view(), id)?.note);
  expect(download(await lib.view(), id)).toMatchObject({ state: "downloading", note: "Crosstalk can't see which disk this Ollama keeps its models on, so it won't stop the pull before that disk is full: keep some room free there." });
  expect(download(await lib.stopDownload({ id }), id)).toMatchObject({ state: "stopped", note: null });

  // One Crosstalk started has the hub's own setting, so its disk is watched without looking for parts.
  const own = fakeOllamaLive({ pull: huge });
  cleanups.push(() => own.stop());
  app.services.scanOptions = { ports: { [own.port]: "ollama" }, timeoutMs: 800 };
  const runners = localRunnersOf(app);
  runners.at = (port) => (port === own.port ? ({ kind: "ollama" } as ReturnType<typeof runners.at>) : null);
  await lib.startDownload({ source: "ollama", serverId: `ollama-${own.port}`, model: "huge:1t" });
  await lib.idle();
  expect(download(await lib.view(), `ollama:ollama-${own.port}:huge:1t`)).toMatchObject({ state: "failed", code: "low_disk" });
});

test("Ollama's library: a model's size and quant before it's pulled, through its redirects", async () => {
  const { lib } = setup();
  const config = { model_format: "gguf", model_family: "qwen3", model_type: "8.2B", file_type: "Q4_K_M" };
  const digest = `sha256:${"d".repeat(64)}`;
  let base = "";
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (path === "/v2/library/qwen3/manifests/8b") return Response.json({ schemaVersion: 2, config: { digest, size: 300 }, layers: [{ mediaType: "application/vnd.ollama.image.model", size: 5_225_374_752 }, { mediaType: "application/vnd.ollama.image.template", size: 1_723 }] });
      if (path === `/v2/library/qwen3/blobs/${digest}`) return Response.redirect(`${base}/cdn/config`, 307);
      if (path === "/cdn/config") return Response.json(config);
      return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
    },
  });
  base = `http://127.0.0.1:${registry.port}`;
  cleanups.push(() => registry.stop(true));
  env("CROSSTALK_OLLAMA_REGISTRY", base);
  expect(await lib.ollamaInfo("qwen3:8b")).toEqual({ model: "qwen3:8b", sizeBytes: 5_225_376_475, quant: "Q4_K_M", params: "8.2B" });
  await expect(lib.ollamaInfo("qwen3:999b")).rejects.toMatchObject({ status: 404, message: "Ollama's library has no qwen3:999b: check the name at ollama.com/library." });
  await expect(lib.ollamaInfo("hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M")).rejects.toMatchObject({ status: 404, message: "Ollama gets that one from Hugging Face: its size shows once the pull starts." });
  await expect(lib.ollamaInfo("")).rejects.toMatchObject({ status: 400 });
  env("CROSSTALK_OLLAMA_REGISTRY", "http://127.0.0.1:9");
  await expect(lib.ollamaInfo("qwen3:8b")).rejects.toMatchObject({ status: 502, message: "Couldn't reach Ollama's library: check this machine's internet connection, then try again." });
});

test("the routes: the library, the folder, search, downloads and their refusals; never the token", async () => {
  const { app, lib, folder } = setup();
  const { repos } = hugging();
  writeSecret(HF_SECRET, TOKEN);
  cleanups.push(() => writeSecret(HF_SECRET, null));
  const server = startServer(app);
  cleanups.push(() => void server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    expect(text).not.toContain(TOKEN);
    return { status: r.status, body: (text ? JSON.parse(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  expect((await fetch(`${base}/api/local-models/library`)).status).toBe(401);
  const view = await call("GET", "/api/local-models/library");
  expect(view.status).toBe(200);
  expect(view.body).toMatchObject({ machine: { ramBytes: 16 * GiB, unified: true, gpuFrom: "estimate" }, folder: { isDefault: true }, downloads: [], programs: [], started: [], hasHfToken: true, reserveBytes: 2 * GiB, ports: { ollama: 11434, llamacpp: 8080 } });
  expect((await call("PUT", "/api/local-models/folder", { path: folder() })).body).toMatchObject({ path: folder(), isDefault: false });
  expect((await call("PUT", "/api/local-models/folder", { path: "relative" })).status).toBe(400);
  expect((await call("GET", "/api/local-models/search?q=qwen3")).body.map((h: { repo: string }) => h.repo)).toEqual(["unsloth/Qwen3-8B-GGUF", "bartowski/Qwen3-8B-GGUF"]);
  expect((await call("GET", "/api/local-models/search?q=")).status).toBe(400);
  expect((await call("GET", "/api/local-models/files?repo=unsloth/Qwen3-8B-GGUF")).body).toMatchObject({ repo: "unsloth/Qwen3-8B-GGUF", kvBytesPerToken: 147456 });
  const started = await call("POST", "/api/local-models/downloads", { source: "huggingface", model: q4(repos) });
  expect(started.status).toBe(200);
  await lib.idle();
  expect((await call("GET", "/api/local-models/library")).body.files.map((f: { id: string }) => f.id)).toEqual(["unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"]);
  expect((await call("POST", "/api/local-models/downloads", { source: "nowhere" })).status).toBe(400);
  expect((await call("POST", "/api/local-models/downloads/stop", { id: "hf:nope" })).status).toBe(404);
  expect((await call("POST", "/api/local-models/downloads/remove", { id: "hf:nope" })).status).toBe(404);
  expect((await call("POST", "/api/local-models/files/remove", { id: "a/b/c.gguf" })).status).toBe(404);
  const broken = await fetch(`${base}/api/local-models/downloads`, { method: "POST", headers: { authorization: `Bearer ${device.token}` }, body: "{not json" });
  expect(broken.status).toBe(400);
});
