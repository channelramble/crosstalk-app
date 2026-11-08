import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineMemory } from "@crosstalk/shared";
import { MEMORY_BANDS, THRASH_PAGES_PER_SEC, memoryBandOf, memoryLine, memoryNotice, memoryRefusal, memoryWays, thrashPagesPerSec } from "@crosstalk/shared";
import { MemoryGuard, blindReader, linuxReader, readerFor, type HolderProbe, type MemoryReader, type Reading } from "../src/memory";
import { ImageEditor, editorNeedBytes } from "../src/imageEditor";
import { LocalRunners } from "../src/localRunners";
import { HttpError } from "../src/engine/engine";
import { poolNeedBytes } from "../src/pool/node";

// The memory guard (hub/src/memory.ts). Nothing here starts a process, reads one of the user's, or touches their
// ComfyUI or llama-server: the machine is a fake reader, and the one test that does look at this Mac only reads a
// sysctl and accepts whatever it says.

const GiB = 1024 ** 3;
const dirs: string[] = [];
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
};
const cleanUp = () => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));

/** A machine that reads exactly what a test says, and never spawns anything. */
function fakeReader(o: { level: number; swapPages?: number; ram?: number; footprints?: Record<number, number>; pageBytes?: number }): MemoryReader & { set: (r: Partial<Reading>) => void } {
  let level = o.level;
  let swapPages = o.swapPages ?? 0;
  return {
    blind: null,
    ramBytes: () => o.ram ?? 16 * GiB,
    // A Mac's pages, where the thrashing line was measured.
    pageBytes: () => o.pageBytes ?? 16 * 1024,
    // What is really free is the level as bytes, as a Mac reads it.
    read: () => ({ level, freeBytes: Math.round((level / 100) * (o.ram ?? 16 * GiB)), swapPages, swapUsedBytes: 9 * GiB }),
    footprint: (pid) => o.footprints?.[pid] ?? null,
    set: (r) => {
      if (r.level !== undefined) level = r.level;
      if (r.swapPages !== undefined && r.swapPages !== null) swapPages = r.swapPages;
    },
  };
}

// ---- the bands ----

test("the bands follow the measurement that set them, and thrashing alone is enough to say the machine is busy", () => {
  expect(memoryBandOf(60, 0)).toBe("fine");
  expect(memoryBandOf(MEMORY_BANDS.busy, 0)).toBe("fine");
  expect(memoryBandOf(MEMORY_BANDS.busy - 1, 0)).toBe("busy");
  expect(memoryBandOf(MEMORY_BANDS.tight - 1, 0)).toBe("tight");
  expect(memoryBandOf(MEMORY_BANDS.full - 1, 0)).toBe("full");
  // A level at which an image step took 1,725 s instead of 107 s.
  expect(memoryBandOf(18, null)).toBe("full");
  // A machine with room to spare that is still moving swap faster than the kernel's own thrashing line.
  expect(memoryBandOf(80, THRASH_PAGES_PER_SEC)).toBe("busy");
  expect(memoryBandOf(80, THRASH_PAGES_PER_SEC - 1)).toBe("fine");
});

// ---- reading a machine ----

test("a Linux hub reads MemAvailable and the swap counters from /proc, not free memory", () => {
  const proc: Record<string, string> = {
    "/proc/meminfo": "MemTotal:       32000000 kB\nMemFree:          200000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       4000000 kB\nSwapFree:        1000000 kB\n",
    "/proc/vmstat": "pgfault 1\npswpin 100\npswpout 400\n",
  };
  const r = linuxReader((p) => proc[p] ?? (() => { throw new Error("no such file"); })());
  const got = r.read()!;
  // 8 of 32 GB available: a quarter. MemFree alone would have said 0.6% and been wrong.
  expect(got.level).toBe(25);
  expect(got.swapPages).toBe(500);
  expect(got.swapUsedBytes).toBe(3_000_000 * 1024);
  expect(r.ramBytes()).toBe(32_000_000 * 1024);
});

test("a Linux hub with no /proc, and a hub on a machine neither reader knows, say so instead of guessing", () => {
  expect(linuxReader(() => { throw new Error("gone"); }).read()).toBeNull();
  const win = readerFor("win32");
  expect(win.blind).toContain("macOS and Linux");
  expect(win.read()).toBeNull();
});

test("this machine's own reader answers with a believable level (read-only: one sysctl, no process)", () => {
  const r = readerFor(process.platform);
  if (r.blind) return; // not a Mac or a Linux box: nothing to check
  const got = r.read();
  expect(got).not.toBeNull();
  expect(got!.level).toBeGreaterThanOrEqual(0);
  expect(got!.level).toBeLessThanOrEqual(100);
  expect(r.ramBytes()).toBeGreaterThan(GiB);
  // It can measure a process of this user's: its own.
  expect(r.footprint(process.pid)).toBeGreaterThan(0);
  // And says nothing about a process that isn't there.
  expect(r.footprint(0x7fffffff)).toBeNull();
});

// ---- what the guard knows ----

test("a blind hub stands in the way of nothing and says why, rather than claiming the machine is fine", async () => {
  const guard = new MemoryGuard({ machineName: () => "Server", holders: async () => [], reader: blindReader("This hub can't read its machine's memory.") });
  guard.start();
  const s = guard.status();
  expect(s.band).toBe("unknown");
  expect(s.level).toBeNull();
  expect(s.blind).toBe("This hub can't read its machine's memory.");
  expect(memoryLine(s, "Server")).toBe("This hub can't read its machine's memory.");
  // Even a request for more than the machine has goes through.
  await expect(guard.check({ what: "the image editor", needBytes: 500 * GiB })).resolves.toMatchObject({ ok: true });
  guard.stop();
});

test("the heavy things are counted biggest first, measured by process or by port, and the small ones left out", async () => {
  const reader = fakeReader({ level: 20, footprints: { 11: 12 * GiB, 22: 40 * 1024 ** 2 } });
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader,
    listeners: async (port) => (port === 8080 ? [33] : []),
    holders: async () => [
      { what: "llama.cpp on port 9000", ours: true, section: "local-models", pid: 22 },
      { what: "the model server on port 8080", ours: false, section: null, port: 8080 },
      { what: "the image editor", ours: true, section: "image-editor", bytes: 12 * GiB },
      { what: "llama.cpp on port 9100", ours: true, section: "local-models", pid: 11 },
    ],
  });
  // Port 8080's listener can't be measured here, so it keeps its row with no size rather than being dropped.
  const v = await guard.verdict({ what: "the image editor", needBytes: GiB });
  expect(v.holders.map((h) => h.what)).toEqual(["the image editor", "llama.cpp on port 9100", "the model server on port 8080"]);
  expect(v.holders[0].bytes).toBe(12 * GiB);
  expect(v.holders[2].bytes).toBeNull();
  // The 40 MB one isn't worth a row on a phone (this is how the hub's own 42 MB never shows up).
  expect(v.holders.some((h) => h.what === "llama.cpp on port 9000")).toBe(false);
  expect(guard.status().takenBytes).toBe(24 * GiB);
});

test("a server measured through its port is summed from its listeners", async () => {
  const reader = fakeReader({ level: 60, footprints: { 7: 3 * GiB, 8: 2 * GiB } });
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader,
    listeners: async () => [7, 8],
    holders: async () => [{ what: "the model server on port 8080", ours: false, section: null, port: 8080 }],
  });
  const v = await guard.verdict({ what: "llama.cpp on port 9000", needBytes: GiB });
  expect(v.holders[0].bytes).toBe(5 * GiB);
});

// ---- before something heavy starts ----

/** The case, as numbers: a 16 GB Mac already holding ComfyUI's image models, asked for a 10 GB chat model. */
function incident() {
  const reader = fakeReader({ level: 60, footprints: {} });
  return new MemoryGuard({
    machineName: () => "Mac mini",
    reader,
    holders: async () => [{ what: "the image editor", ours: true, section: "image-editor", bytes: 12.5 * GiB }],
    machine: async () => ({ ramBytes: 16 * GiB, unified: true, gpuBytes: Math.round(10.67 * GiB), gpuFrom: "llama.cpp", gpus: [] }),
  });
}

test("the second model is refused in words that name what is holding the memory and what to do", async () => {
  const guard = incident();
  const v = await guard.verdict({ what: "llama.cpp on port 8080", needBytes: Math.round(10.04 * GiB) });
  expect(v.ok).toBe(false);
  expect(v.text).toBe("llama.cpp on port 8080 needs about 10.0 GB and nothing is free on Mac mini. the image editor (12.5 GB) is holding the rest: turn it off in Settings, or start llama.cpp on port 8080 anyway.");
  // It throws as a 409 with the code the phone turns into "Start anyway", never a silent failure.
  const failed = await guard.check({ what: "llama.cpp on port 8080", needBytes: Math.round(10.04 * GiB) }).catch((e) => e);
  expect(failed).toMatchObject({ status: 409, code: "memory" });
  expect(failed.message).toBe(v.text);
  // And the person's own tap goes through.
  await expect(guard.check({ what: "llama.cpp on port 8080", needBytes: Math.round(10.04 * GiB), force: true })).resolves.toMatchObject({ ok: false });
});

test("the same model on the same machine with nothing else running is allowed", async () => {
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader: fakeReader({ level: 60 }),
    holders: async () => [],
    machine: async () => ({ ramBytes: 16 * GiB, unified: true, gpuBytes: Math.round(10.67 * GiB), gpuFrom: "llama.cpp", gpus: [] }),
  });
  await expect(guard.check({ what: "llama.cpp on port 8080", needBytes: Math.round(10.04 * GiB) })).resolves.toMatchObject({ ok: true });
});

test("a machine already in the tight band refuses even something small, and says it is the machine, not the size", async () => {
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader: fakeReader({ level: MEMORY_BANDS.tight - 1 }),
    holders: async () => [{ what: "the model server on port 8080", ours: false, section: null, bytes: 4 * GiB }],
  });
  const v = await guard.verdict({ what: "the image editor", needBytes: null });
  expect(v.ok).toBe(false);
  expect(v.band).toBe("tight");
  expect(v.text).toContain("Mac mini is nearly out of memory");
  // It is the person's own server, so the words never offer to stop it.
  expect(v.text).toContain("quit it on Mac mini");
  expect(v.text).not.toContain("turn it off");
});

test("a machine that is thrashing refuses a start even while the level still looks survivable", async () => {
  const reader = fakeReader({ level: 70, swapPages: 0 });
  const guard = new MemoryGuard({ machineName: () => "Mac mini", reader, holders: async () => [], now: () => now });
  let now = 1000;
  guard.tick();
  now = 11_000;
  reader.set({ swapPages: 10 * THRASH_PAGES_PER_SEC * 10 });
  guard.tick();
  expect(guard.status().swapPagesPerSec).toBe(10 * THRASH_PAGES_PER_SEC);
  expect(guard.status().band).toBe("busy");
  const v = await guard.verdict({ what: "the image editor", needBytes: GiB });
  expect(v.ok).toBe(false);
  expect(v.text).toContain("nearly out of memory");
});

// ---- while things run ----

test("the state goes out when it changes and not on every look, and the phone is told once per spell", async () => {
  const reader = fakeReader({ level: 70 });
  const sent: MachineMemory[] = [];
  const notes: { title: string; body: string }[] = [];
  let now = 1000;
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader,
    holders: async () => [{ what: "the image editor", ours: true, section: "image-editor", bytes: 12 * GiB }],
    emit: (m) => sent.push(m),
    notify: (n) => notes.push(n),
    now: () => now,
  });
  guard.tick();
  expect(sent.length).toBe(1);
  // Four more looks at the same machine: nothing new to say.
  for (let i = 0; i < 4; i++) {
    now += 10_000;
    guard.tick();
  }
  expect(sent.length).toBe(1);
  expect(notes.length).toBe(0);
  // Now it falls into the full band.
  now += 10_000;
  reader.set({ level: 10 });
  guard.tick();
  await Bun.sleep(5);
  expect(sent.at(-1)!.band).toBe("full");
  expect(notes.length).toBe(1);
  expect(notes[0].title).toBe("Mac mini is out of memory");
  expect(notes[0].body).toContain("the image editor (12.0 GB)");
  expect(notes[0].body).toContain("Turn the image editor off");
  expect(notes[0].body).toContain("Crosstalk stops nothing by itself");
  // Still full ten seconds later: it is not told twice.
  now += 10_000;
  guard.tick();
  await Bun.sleep(5);
  expect(notes.length).toBe(1);
  guard.stop();
});

test("counting the heavy things never runs twice at once, and a count that throws leaves the last one standing", async () => {
  let calls = 0;
  let fail = false;
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader: fakeReader({ level: 20 }),
    holders: async () => {
      calls++;
      await Bun.sleep(20);
      if (fail) throw new Error("lsof went away");
      return [{ what: "the image editor", ours: true, section: "image-editor", bytes: 12 * GiB }];
    },
  });
  const [a, b] = await Promise.all([guard.verdict({ what: "x", needBytes: GiB }), guard.verdict({ what: "y", needBytes: GiB })]);
  expect(calls).toBe(1);
  expect(a.holders.length).toBe(1);
  expect(b.holders.length).toBe(1);
  fail = true;
  const c = await guard.verdict({ what: "z", needBytes: GiB });
  expect(c.holders.map((h) => h.what)).toEqual(["the image editor"]);
});

test("a slow look at the machine never holds up a start: the guard answers with what it already knows", async () => {
  let slow = false;
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader: fakeReader({ level: 60 }),
    holders: async () => {
      // An `lsof` on a machine deep in swap can take seconds; the guard's own deadline is 3.
      if (slow) await Bun.sleep(5000);
      return [{ what: "the image editor", ours: true, section: "image-editor", bytes: 2 * GiB }];
    },
    // The machine's facts can cost a llama.cpp run that waits 20 s for a GPU list; the guard waits 2.
    machine: () => new Promise(() => {}),
  });
  const first = await guard.verdict({ what: "llama.cpp on port 8080", needBytes: GiB });
  expect(first.holders.map((h) => h.what)).toEqual(["the image editor"]);
  // Without the machine's facts it falls back to holding a quarter of the memory back for the system: 12 of 16 GB.
  expect(first.freeBytes).toBe(12 * GiB - 2 * GiB);
  slow = true;
  const began = Date.now();
  const second = await guard.verdict({ what: "llama.cpp on port 8080", needBytes: GiB });
  // Well under the five seconds the holder count takes, and the two waits overlap rather than adding up.
  expect(Date.now() - began).toBeLessThan(4500);
  expect(second.holders.map((h) => h.what)).toEqual(["the image editor"]);
}, 15_000);

// ---- what each heavy thing needs ----

test("one image edit is counted from the files the editor page names, wherever ComfyUI keeps them", () => {
  const dir = tempDir("ct-editor-need-");
  mkdirSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor"), { recursive: true });
  writeFileSync(
    join(dir, "ComfyUI", "custom_nodes", "phone_editor", "editor.html"),
    "<script>const MODELS = { unet: 'diff.gguf', clip: 'text.gguf', vae: 'vae.safetensors' };</script>",
  );
  // Nothing on disk yet: nothing is claimed.
  expect(editorNeedBytes(dir)).toBeNull();
  // The real install keeps the unet under diffusion_models and the clip under text_encoders.
  for (const [sub, file, size] of [["diffusion_models", "diff.gguf", 4 * GiB], ["text_encoders", "text.gguf", 5 * GiB], ["vae", "vae.safetensors", GiB]] as const) {
    mkdirSync(join(dir, "ComfyUI", "models", sub), { recursive: true });
    writeFileSync(join(dir, "ComfyUI", "models", sub, file), Buffer.alloc(1024));
    // A sparse file, so the test doesn't write 10 GB.
    const fd = Bun.file(join(dir, "ComfyUI", "models", sub, file));
    void fd;
    truncate(join(dir, "ComfyUI", "models", sub, file), size);
  }
  const need = editorNeedBytes(dir)!;
  // Ten gigabytes of files, which load as about 13.5, plus ComfyUI's own 1.2 GB of room.
  expect(need).toBeGreaterThan(14 * GiB);
  expect(need).toBeLessThan(15 * GiB);
  // An editor that isn't there at all claims nothing.
  expect(editorNeedBytes(join(dir, "nope"))).toBeNull();
  cleanUp();
});

test("the model pool's server counts its files plus llama.cpp's cache and headroom", () => {
  const dir = tempDir("ct-pool-need-");
  const file = join(dir, "model.gguf");
  writeFileSync(file, Buffer.alloc(1024));
  truncate(file, 4 * GiB);
  // 4 GB of weights, 8,192 tokens of cache at the fallback 128 KiB a token, and 1 GB of headroom.
  expect(poolNeedBytes([file], 8192)).toBe(4 * GiB + 8192 * 128 * 1024 + GiB);
  // A context of 0 is the model's own, which can't be counted beforehand: only the files are.
  expect(poolNeedBytes([file], 0)).toBe(4 * GiB);
  expect(poolNeedBytes([join(dir, "gone.gguf")], 8192)).toBeNull();
  // Named devices of this machine's own: it holds the model, so it is charged for it.
  expect(poolNeedBytes([file], 8192, ["Metal0"])).toBe(4 * GiB + 8192 * 128 * 1024 + GiB);
  // Every layer on the helpers (which is every pool whose main machine lends no GPU): the weights and the cache live
  // on their GPUs and this machine only streams tensors through, so none of the model is this machine's to hold.
  // Charging it the whole model refused the pool on the one configuration a pool is for.
  expect(poolNeedBytes([file], 8192, "helpers")).toBeNull();
  cleanUp();
});

// ---- the words ----

test("the words say what is wrong, what is holding it, and what a person can do", () => {
  const m: MachineMemory = {
    band: "full",
    level: 18,
    blind: null,
    ramBytes: 16 * GiB,
    takenBytes: Math.round(16.5 * GiB),
    swapPagesPerSec: 18_000,
    swapUsedBytes: Math.round(9.6 * GiB),
    holders: [
      { what: "the image editor", ours: true, section: "image-editor", bytes: Math.round(16.9 * GiB) },
      { what: "the model server on port 8080", ours: false, section: null, bytes: Math.round(3.8 * GiB) },
    ],
    at: 1,
  };
  expect(memoryLine(m, "Mac mini")).toBe("Mac mini is out of memory. Replies and edits can take minutes until something stops. The biggest thing running is the image editor (16.9 GB).");
  expect(memoryWays(m)).toEqual([
    { text: "Turn the image editor off", section: "image-editor" },
    { text: "Quit the model server on port 8080 on this machine", section: null },
  ]);
  expect(memoryNotice(m, "Mac mini").title).toBe("Mac mini is out of memory");
  // Nothing measured at all still gives a sentence a person can act on.
  expect(memoryRefusal({ what: "the image editor", needBytes: 10 * GiB, freeBytes: 0, machine: "Mac mini", holders: [], why: "space" })).toBe(
    "the image editor needs about 10.0 GB and nothing is free on Mac mini. Close what you don't need on Mac mini, or start it anyway.",
  );
});

/** Grows a file to `size` without writing it (a sparse file), so a test can weigh 10 GB of models. */
function truncate(path: string, size: number) {
  const fd = require("node:fs").openSync(path, "r+");
  try {
    require("node:fs").ftruncateSync(fd, size);
  } finally {
    require("node:fs").closeSync(fd);
  }
}

// ---- what each start is judged against (the two pools of memory) ----

/** A 16 GB Mac: shared with the GPU, of which llama.cpp reports 10.67 GB as Metal's working set. */
const mac16 = () => ({ ramBytes: 16 * GiB, unified: true, gpuBytes: Math.round(10.67 * GiB), gpuFrom: "llama.cpp" as const, gpus: [] });
/** What `editorNeedBytes` answers on a typical install: 9.22 GiB of files, loaded, plus ComfyUI's room. */
const EDITOR_NEED = 14_657_351_437;

const guardOn = (o: { level?: number; holders?: HolderProbe[]; footprints?: Record<number, number>; listeners?: (port: number) => Promise<number[]> }) =>
  new MemoryGuard({
    machineName: () => "Mac mini",
    reader: fakeReader({ level: o.level ?? 60, footprints: o.footprints }),
    holders: async () => o.holders ?? [],
    listeners: o.listeners,
    machine: async () => mac16(),
  });

test("the image editor is judged against the machine's memory, not llama.cpp's working set", async () => {
  // It runs on a 16 GB Mac (measured at 12.48 GiB resident), so an idle machine must not refuse it: the
  // ceiling for ComfyUI is the memory, not Metal's working set, which is two thirds of this machine.
  const idle = guardOn({});
  await expect(idle.check({ what: "the image editor", needBytes: EDITOR_NEED, on: "ram" })).resolves.toMatchObject({ ok: true });
  // The same number asked for llama.cpp is still refused, because there the working set really is the limit.
  const llama = await idle.verdict({ what: "llama.cpp on port 8080", needBytes: EDITOR_NEED });
  expect(llama.ok).toBe(false);
  expect(llama.freeBytes).toBe(Math.round(10.67 * GiB));
  // And beside a chat model the editor is refused, a pairing that can take a hub down: 16 GB less
  // the 10.9 GB llama-server is not 13.7 GB.
  const beside = guardOn({ holders: [{ what: "the model server on port 8080", ours: false, section: null, bytes: Math.round(10.9 * GiB) }] });
  const no = await beside.verdict({ what: "the image editor", needBytes: EDITOR_NEED, on: "ram" });
  expect(no.ok).toBe(false);
  expect(no.text).toBe(
    "the image editor needs about 13.7 GB and 5.1 GB is free on Mac mini. the model server on port 8080 (10.9 GB) is holding the rest: quit it on Mac mini, or start the image editor anyway.",
  );
});

test("on a PC the GPU's memory and the machine's are two pools, and neither is subtracted from the other", async () => {
  const pc = { ramBytes: 32 * GiB, unified: false, gpuBytes: 16 * GiB, gpuFrom: "llama.cpp" as const, gpus: [{ name: "RTX 4080", totalBytes: 16 * GiB, freeBytes: 16 * GiB }] };
  const guard = new MemoryGuard({
    machineName: () => "the PC",
    reader: fakeReader({ level: 60, ram: 32 * GiB, footprints: { 99: 20 * GiB } }),
    holders: async () => [{ what: "the model server on port 8080", ours: false, section: null, pid: 99 }],
    machine: async () => pc,
  });
  // 20 GB of the machine's memory held by another program says nothing about a card that is empty: `gpuBytes` is
  // already free VRAM, so taking host memory off it would refuse every start on an idle GPU.
  const v = await guard.verdict({ what: "llama.cpp on port 8080", needBytes: 10 * GiB });
  expect(v.ok).toBe(true);
  expect(v.freeBytes).toBe(16 * GiB);
});

// ---- what the guard didn't start, and what hasn't finished starting ----

test("a ComfyUI the hub didn't start is found on the editor's port and counted", async () => {
  const guard = guardOn({
    footprints: { 55: Math.round(12.48 * GiB) },
    listeners: async (port) => (port === 8188 ? [55] : []),
    holders: [{ what: "the image editor", ours: true, section: "image-editor", bytes: null, port: 8188 }],
  });
  const v = await guard.verdict({ what: "llama.cpp on port 8080", needBytes: Math.round(10.04 * GiB) });
  expect(v.ok).toBe(false);
  expect(v.holders[0]).toEqual({ what: "the image editor", ours: true, section: "image-editor", bytes: Math.round(12.48 * GiB) });
  // Settings can turn that one off as well, so the words say so rather than sending the person to quit it.
  expect(v.text).toContain("turn it off in Settings");
});

test("the pool's own server is one holder, however many ways the hub knows of it", async () => {
  const guard = guardOn({
    footprints: { 42: 10 * GiB },
    listeners: async (port) => (port === 8090 ? [42] : []),
    holders: [
      { what: "the model pool's server", ours: true, section: "model-pool", pid: 42 },
      // The "Model pool" account points at 127.0.0.1:8090, which is this very process.
      { what: "the model server on port 8090", ours: false, section: null, port: 8090 },
    ],
  });
  const v = await guard.verdict({ what: "the image editor", needBytes: GiB, on: "ram" });
  expect(v.holders.map((h) => h.what)).toEqual(["the model pool's server"]);
  // 16 GB less one 10 GB model, not less two of them: counted twice, this refused everything after it.
  expect(guard.status().takenBytes).toBe(10 * GiB);
  expect(v.freeBytes).toBe(6 * GiB);
  expect(v.ok).toBe(true);
});

test("a model server that isn't running is not listed as holding the machine", async () => {
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    reader: fakeReader({ level: 20 }),
    listeners: async () => [],
    holders: async () => [
      // Their llama-server is quit; their custom-model account still points at the port.
      { what: "the model server on port 8080", ours: false, section: null, port: 8080 },
      { what: "llama.cpp on port 9000", ours: true, section: "local-models", pid: 11 },
    ],
  });
  const v = await guard.verdict({ what: "the image editor", needBytes: null, on: "ram" });
  expect(v.holders.map((h) => h.what)).toEqual(["llama.cpp on port 9000"]);
  expect(v.text).not.toContain("port 8080");
  // A process that is there but couldn't be measured is a different thing to say, and keeps its row.
  expect(v.holders[0].bytes).toBeNull();
});

test("what a start replaces isn't counted as holding the machine", async () => {
  const guard = guardOn({ footprints: { 7: 5 * GiB }, holders: [{ what: "the model pool's helper", ours: true, section: "model-pool", pid: 7 }] });
  // A run that was cancelled leaves a helper here, and the next run ends it as part of starting: judging the new one
  // beside the old one asked for twice the room on the same machine, and the pool has no "Start anyway".
  await expect(guard.verdict({ what: "the model pool's helper", needBytes: 6 * GiB })).resolves.toMatchObject({ ok: false });
  const v = await guard.verdict({ what: "the model pool's helper", needBytes: 6 * GiB, replacing: 7 });
  expect(v.ok).toBe(true);
  expect(v.holders).toEqual([]);
});

// ---- the signals: a rate worth dividing by, pages of the right size, and a band that scales ----

test("the swap rate is only worked out over a window worth dividing by", () => {
  const reader = fakeReader({ level: 79, swapPages: 1000 });
  let now = 1000;
  const guard = new MemoryGuard({ machineName: () => "Mac mini", reader, holders: async () => [], now: () => now });
  guard.tick();
  // A start that lands a tenth of a second after a look, with an ordinary burst of paging behind it: 250 pages is
  // 4 MB, which used to read as 2,083 pages a second and refuse the start on a machine with 12 GB free.
  now = 1120;
  reader.set({ swapPages: 1250 });
  guard.tick();
  expect(guard.status().swapPagesPerSec).toBeNull();
  expect(guard.status().band).toBe("fine");
  // Ten seconds on, the same 250 pages are what they are.
  now = 11_000;
  guard.tick();
  expect(guard.status().swapPagesPerSec).toBe(25);
});

test("the thrashing line is a rate of bytes, so Linux's smaller pages aren't read as four times the swap", () => {
  expect(thrashPagesPerSec(16 * 1024)).toBe(THRASH_PAGES_PER_SEC);
  expect(thrashPagesPerSec(4096)).toBe(4 * THRASH_PAGES_PER_SEC);
  // 2,000 pages a second on Linux is 8 MB/s: a hub with steady swap or zswap traffic, not a thrashing one.
  expect(memoryBandOf(80, 2000, { pageBytes: 4096 })).toBe("fine");
  expect(memoryBandOf(80, 8000, { pageBytes: 4096 })).toBe("busy");
  // The same rate of bytes on a Mac's 16 KiB pages still trips it.
  expect(memoryBandOf(80, 2000, { pageBytes: 16 * 1024 })).toBe("busy");
});

test("a low share of a big machine is not nearly out of memory, and doesn't refuse a model", async () => {
  // 20 GB of 64 is 31%: tight by the share alone, which is how a hub with 20 GB free refused a 4 GB model.
  expect(memoryBandOf(31, 0, { freeBytes: 20 * GiB })).toBe("busy");
  expect(memoryBandOf(31, 0, { freeBytes: 2 * GiB })).toBe("tight");
  // The 16 GB Mac the bands were measured on is unchanged: 34% of it really is 5.4 GB.
  expect(memoryBandOf(MEMORY_BANDS.tight - 1, 0, { freeBytes: Math.round(((MEMORY_BANDS.tight - 1) / 100) * 16 * GiB) })).toBe("tight");
  const hub = new MemoryGuard({
    machineName: () => "the server",
    reader: { blind: null, read: () => ({ level: 31, freeBytes: 20 * GiB, swapPages: 0, swapUsedBytes: 0 }), footprint: () => null, ramBytes: () => 64 * GiB, pageBytes: () => 4096 },
    holders: async () => [{ what: "the model server on port 8080", ours: false, section: null, bytes: 40 * GiB }],
  });
  const v = await hub.verdict({ what: "llama.cpp on port 8081", needBytes: 4 * GiB });
  expect(v.band).toBe("busy");
  expect(v.ok).toBe(true);
});

test("a Linux hub works out its own page size from /proc, and one that can't read /proc says so", () => {
  const proc: Record<string, string> = {
    "/proc/meminfo": "MemTotal:       32000000 kB\nMemFree:          400000 kB\nMemAvailable:    8000000 kB\n",
    // 400,000 kB over 100,000 pages: 4 KiB pages, worked out with no process spawned.
    "/proc/vmstat": "nr_free_pages 100000\npswpin 10\npswpout 20\n",
  };
  const r = linuxReader((p) => proc[p] ?? (() => { throw new Error("no such file"); })());
  expect(r.pageBytes()).toBe(4096);
  expect(r.read()!.freeBytes).toBe(8_000_000 * 1024);
  // A container or hardened host where /proc can't be read: it says so, instead of reporting that memory is fine
  // for ever (every read fails, so nothing would ever move the band off "fine").
  const blind = linuxReader(() => {
    throw new Error("gone");
  });
  const why = blind.blind!;
  expect(why).toContain("/proc");
  const guard = new MemoryGuard({ machineName: () => "the server", holders: async () => [], reader: blind });
  guard.start();
  const s = guard.status();
  expect(s.band).toBe("unknown");
  expect(memoryLine(s, "the server")).toBe(why);
  expect(memoryLine(s, "the server")).not.toContain("Memory is fine");
  guard.stop();
});

test("a refusal only offers Start anyway where the screen that asked has one", () => {
  const holders = [{ what: "the image editor", ours: true, section: "image-editor" as const, bytes: 12 * GiB }];
  const words = memoryRefusal({ what: "the model pool's server", needBytes: 40 * GiB, freeBytes: 2 * GiB, machine: "Mac mini", holders, why: "space", canForce: false });
  expect(words).toBe(
    "the model pool's server needs about 40.0 GB and 2.0 GB is free on Mac mini. the image editor (12.0 GB) is holding the rest: turn it off in Settings, then start the model pool's server again.",
  );
  expect(words).not.toContain("anyway");
  // Nothing measured at all still leaves something to do.
  expect(memoryRefusal({ what: "the model pool's server", needBytes: null, freeBytes: 0, machine: "Mac mini", holders: [], why: "pressure", canForce: false })).toBe(
    "Mac mini is nearly out of memory (nothing is free), so starting the model pool's server now would make everything on it slow. Close what you don't need on Mac mini, then start the model pool's server again.",
  );
});

// ---- the two places that start something heavy ----

test("a local model server is refused before anything is spawned, and Start anyway gets through", async () => {
  const dir = tempDir("ct-runners-mem-");
  const modelPath = join(dir, "model.gguf");
  writeFileSync(modelPath, Buffer.alloc(1024));
  const file = { id: "owner/repo/model.gguf", repo: "owner/repo", files: ["model.gguf"], quant: "Q4_K_M", bytes: 9 * GiB, kvBytesPerToken: 128 * 1024, contextLength: 32768 };
  const guard = incident();
  const asked: { what: string; needBytes: number | null; force: boolean }[] = [];
  const runners = new LocalRunners(
    {
      runDir: join(dir, "run"),
      hubPort: () => 7000,
      model: () => ({ file, path: modelPath }),
      beforeStart: async (o) => {
        asked.push(o);
        await guard.check(o);
      },
    },
    true,
  );
  runners.find = () => [{ kind: "llamacpp", path: "/bin/echo", from: "a test" }, { kind: "ollama", path: "/bin/echo", from: "a test" }];
  const port = 56_789;
  const failed = await runners.start({ kind: "llamacpp", port, model: file.id, context: 8192 }).catch((e) => e);
  expect(failed).toMatchObject({ status: 409, code: "memory" });
  // Asked for exactly what llama.cpp would hold: the file, 8,192 tokens of cache, and llama.cpp's 1 GB of headroom.
  expect(asked[0]).toEqual({ what: "llama.cpp on port 56789", needBytes: 9 * GiB + 8192 * 128 * 1024 + GiB, force: false });
  // Nothing was started, and the port was never claimed.
  expect(runners.list()).toEqual([]);
  // Ollama can't be sized beforehand (it loads a model when a chat asks for one), and says so with a null.
  await runners.start({ kind: "ollama", port, force: true }).catch(() => {});
  expect(asked[1]).toMatchObject({ what: "Ollama on port 56789", needBytes: null, force: true });
  runners.shutdown();
  cleanUp();
});

test("the image editor counts while it is still loading, and one the hub didn't start is looked for on its port", async () => {
  const dir = tempDir("ct-editor-heavy-");
  mkdirSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor"), { recursive: true });
  // A port no one is on, and a start.sh that starts nothing: nothing here reaches a real ComfyUI.
  writeFileSync(join(dir, "start.sh"), "#!/bin/sh\n# --port 45678\nexit 0\n");
  writeFileSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor", "editor.html"), "<script>const MODELS = { unet: 'd.gguf', clip: 't.gguf', vae: 'v.safetensors' };</script>");
  for (const [sub, name, size] of [["diffusion_models", "d.gguf", 4 * GiB], ["text_encoders", "t.gguf", 5 * GiB], ["vae", "v.safetensors", GiB]] as const) {
    mkdirSync(join(dir, "ComfyUI", "models", sub), { recursive: true });
    writeFileSync(join(dir, "ComfyUI", "models", sub, name), Buffer.alloc(1024));
    truncate(join(dir, "ComfyUI", "models", sub, name), size);
  }
  const editor = new ImageEditor({ dir, logFile: join(dir, "server.log"), emit: () => {}, tailscaleIp: async () => null });
  // Off as far as the hub knows: nothing is claimed, and its port is handed to the guard so a ComfyUI the person
  // started themselves is measured there. It used to be invisible until somebody opened Settings → Image editor.
  expect(editor.heavy()).toEqual({ bytes: null, port: 45678 });
  await editor.set(true);
  expect(editor.lastStatus().state).toBe("starting");
  // Nothing has measured it yet -- it is three minutes starting and six loading its weights -- and that window is
  // exactly when a 10 GB chat model was still allowed beside it. Until something is measured, what one edit needs
  // is the floor, so the guard counts the editor from the moment it is switched on.
  expect(editor.lastStatus().memoryMB).toBeNull();
  const on = editor.heavy();
  expect(on.port).toBeNull();
  expect(on.bytes).toBeGreaterThan(14 * GiB);
  editor.shutdown();
  cleanUp();
});

test("the image editor is refused with its own measured need, and nothing of the editor's is touched", async () => {
  const dir = tempDir("ct-editor-mem-");
  mkdirSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor"), { recursive: true });
  // A port no one is on: nothing here ever reaches, starts or stops a real ComfyUI.
  writeFileSync(join(dir, "start.sh"), "#!/bin/sh\necho --port 45678\n");
  writeFileSync(join(dir, "ComfyUI", "custom_nodes", "phone_editor", "editor.html"), "<script>const MODELS = { unet: 'd.gguf', clip: 't.gguf', vae: 'v.safetensors' };</script>");
  for (const [sub, name, size] of [["diffusion_models", "d.gguf", 4 * GiB], ["text_encoders", "t.gguf", 5 * GiB], ["vae", "v.safetensors", GiB]] as const) {
    mkdirSync(join(dir, "ComfyUI", "models", sub), { recursive: true });
    writeFileSync(join(dir, "ComfyUI", "models", sub, name), Buffer.alloc(1024));
    truncate(join(dir, "ComfyUI", "models", sub, name), size);
  }
  const guard = incident();
  let asked: number | null = -1;
  let forced = false;
  const editor = new ImageEditor({
    dir,
    logFile: join(dir, "server.log"),
    emit: () => {},
    tailscaleIp: async () => null,
    beforeStart: async (need, force) => {
      asked = need;
      forced = force;
      // `on: "ram"`, exactly as app.ts asks: ComfyUI is not llama.cpp and is not held to Metal's working set.
      await guard.check({ what: "the image editor", needBytes: need, on: "ram", force });
      // Nothing is really started here: a real editor on this machine is left alone, and this test only checks the gate.
      throw new HttpError(409, "the test stops here", "test");
    },
  });
  const failed = await editor.set(true).catch((e) => e);
  expect(failed).toMatchObject({ status: 409, code: "memory" });
  expect(failed.message).toContain("the image editor needs about");
  expect(failed.message).toContain("the image editor (12.5 GB) is holding the rest");
  // Its own models were weighed, not a number someone typed in.
  expect(asked).toBeGreaterThan(14 * GiB);
  // Nothing was started: it is still off.
  expect(editor.lastStatus()).toMatchObject({ installed: true, state: "off" });
  // The person's "Start anyway" reaches the gate as a yes, and the guard lets it by.
  const anyway = await editor.set(true, true).catch((e) => e);
  expect(forced).toBe(true);
  expect(anyway).toMatchObject({ code: "test" });
  expect(editor.lastStatus().state).toBe("off");
  editor.shutdown();
  cleanUp();
});
