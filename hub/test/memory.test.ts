import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineMemory } from "@crosstalk/shared";
import { MEMORY_BANDS, MEMORY_STEER, MEMORY_STEER_OWN, THRASH_PAGES_PER_SEC, memoryBandOf, memoryBriefing, memoryLine, memoryNoResumeLine, memoryNotice, memoryRefusal, memoryWays, thrashPagesPerSec } from "@crosstalk/shared";
import { MEMORY_ACT, MemoryGuard, blindReader, groupProcesses, linuxReader, programName, readerFor, type AgentProcess, type HolderProbe, type MemoryActions, type MemoryReader, type ProcessRow, type Reading } from "../src/memory";
import { ImageEditor, editorNeedBytes } from "../src/imageEditor";
import { LocalRunners } from "../src/localRunners";
import { HttpError } from "../src/engine/engine";

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

test("one process is one holder, however many ways the hub knows of it", async () => {
  const guard = guardOn({
    footprints: { 42: 10 * GiB },
    listeners: async (port) => (port === 8090 ? [42] : []),
    holders: [
      { what: "llama.cpp on port 8090", ours: true, section: "local-models", pid: 42 },
      // A custom-model account points at 127.0.0.1:8090, which is this very process.
      { what: "the model server on port 8090", ours: false, section: null, port: 8090 },
    ],
  });
  const v = await guard.verdict({ what: "the image editor", needBytes: GiB, on: "ram" });
  expect(v.holders.map((h) => h.what)).toEqual(["llama.cpp on port 8090"]);
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

// ---- who holds the memory ----

const MiB = 1024 ** 2;
const NEO = "/Applications/BrowserOS neo.app/Contents";
const NEO_PAGE = `${NEO}/Frameworks/BrowserOS neo Framework.framework/Versions/155.0/Helpers/BrowserOS neo Helper (Renderer).app/Contents/MacOS/BrowserOS neo Helper (Renderer)`;
const NEO_GPU = `${NEO}/Frameworks/BrowserOS neo Framework.framework/Versions/155.0/Helpers/BrowserOS neo Helper (GPU).app/Contents/MacOS/BrowserOS neo Helper (GPU)`;
const CHROME = "/Applications/Google Chrome.app/Contents";
const CLAUDE = "/Users/u/.local/share/claude/versions/2.1.330";

/** An agent as the engine reports it: Claude Code in the chat "Shopping", replying and using the browser. */
const shopper = (over: Partial<AgentProcess> = {}): AgentProcess => ({ memberId: "mb_shop", roomId: "r_shop", agent: "Claude Code", chat: "Shopping", pids: [200], replying: true, browsing: true, ...over });

/**
 * A process table like the one on 2026-11-21: the hub's Claude Code with its helpers, the agents' browser with `pages`
 * page processes (sizes in MiB), and the person's own Chrome, which must only ever be named.
 */
function table(pages: number[], extra: ProcessRow[] = []): ProcessRow[] {
  return [
    { pid: 200, ppid: 100, path: CLAUDE, bytes: 400 * MiB },
    { pid: 201, ppid: 200, path: "/opt/homebrew/bin/node", bytes: 60 * MiB },
    { pid: 300, ppid: 1, path: `${NEO}/MacOS/BrowserOS neo`, bytes: 300 * MiB, args: "" },
    { pid: 301, ppid: 300, path: NEO_GPU, bytes: 200 * MiB },
    ...pages.map((mb, i) => ({ pid: 310 + i, ppid: 300, path: NEO_PAGE, bytes: mb * MiB })),
    { pid: 400, ppid: 1, path: `${CHROME}/MacOS/Google Chrome`, bytes: 700 * MiB, args: "" },
    { pid: 401, ppid: 400, path: `${CHROME}/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)`, bytes: 500 * MiB },
    { pid: 500, ppid: 1, path: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", bytes: 90 * MiB },
    // Another user's process: it can be seen, not measured.
    { pid: 88, ppid: 1, path: "WindowServer", bytes: null },
    ...extra,
  ];
}

test("a look at the process table is sorted into agents by chat, the agents' browser, and the three biggest other programs", () => {
  const rows = table([900, 700, 500], [
    { pid: 600, ppid: 1, path: "/usr/local/bin/ollama", bytes: 300 * MiB },
    { pid: 601, ppid: 1, path: "/Applications/Slack.app/Contents/MacOS/Slack", bytes: 280 * MiB },
    { pid: 602, ppid: 1, path: "/Applications/Notes.app/Contents/MacOS/Notes", bytes: 270 * MiB },
    // A headless browser the agent started itself counts with the agents' browser, not with the agent or the person.
    { pid: 210, ppid: 200, path: "/Users/u/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium", bytes: 150 * MiB, args: "--headless" },
    { pid: 211, ppid: 210, path: "/Users/u/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Helpers/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer)", bytes: 250 * MiB },
  ]);
  const got = groupProcesses(rows, { agents: [shopper()], self: 100 });
  const browser = got.find((h) => h.kind === "browser")!;
  expect(browser).toMatchObject({ what: "the agents' browser", ours: true, section: null, bytes: (300 + 200 + 900 + 700 + 500 + 150 + 250) * MiB, roomId: "r_shop", chat: "Shopping", memberId: "mb_shop" });
  // Only page processes can ever be asked to quit, biggest first: never the browser itself or its GPU process.
  expect(browser.pages).toEqual([{ pid: 310, bytes: 900 * MiB }, { pid: 311, bytes: 700 * MiB }, { pid: 312, bytes: 500 * MiB }, { pid: 211, bytes: 250 * MiB }]);
  // The agent's own processes, under its chat's name, without the browser it started.
  expect(got.find((h) => h.kind === "agent")).toMatchObject({ what: "Claude Code in Shopping", bytes: 460 * MiB, roomId: "r_shop", memberId: "mb_shop", pids: [200, 201] });
  // The person's Chrome is one row under the app's name, helpers and all; then the next two; Notes and Finder don't make it.
  expect(got.filter((h) => h.kind === "other").map((h) => [h.what, h.bytes, h.ours])).toEqual([["Google Chrome", 1200 * MiB, false], ["ollama", 300 * MiB, false], ["Slack", 280 * MiB, false]]);
  // Biggest first, as the phone lists them.
  expect(got.map((h) => h.what)).toEqual(["the agents' browser", "Google Chrome", "Claude Code in Shopping", "ollama", "Slack"]);
  // What is counted elsewhere (a model server Crosstalk reports by itself) is left out, with all it started.
  expect(groupProcesses(rows, { agents: [shopper()], claimed: [600] }).some((h) => h.what === "ollama")).toBe(false);
  expect(groupProcesses(rows, { agents: [shopper()], claimed: [200] }).some((h) => h.kind === "agent")).toBe(false);
});

test("the browser is put down to a chat only when one agent is plainly the one using it", () => {
  const rows = table([900, 700]);
  const other = shopper({ memberId: "mb_code", roomId: "r_code", chat: "Refactor", pids: [], browsing: false });
  // One reply uses it: that chat.
  expect(groupProcesses(rows, { agents: [shopper(), other] }).find((h) => h.kind === "browser")).toMatchObject({ roomId: "r_shop" });
  // Nobody's reply has used a browser, or the one that did has ended: no chat is named, so none can be stopped for it.
  for (const agents of [[shopper({ browsing: false }), other], [shopper({ replying: false })], []]) {
    const browser = groupProcesses(rows, { agents }).find((h) => h.kind === "browser")!;
    expect(browser.roomId).toBeUndefined();
    expect(browser.memberId).toBeUndefined();
  }
  // Two replies use it at once: neither is named (stopping the wrong chat would be worse than naming none).
  expect(groupProcesses(rows, { agents: [shopper(), { ...other, pids: [], browsing: true }] }).find((h) => h.kind === "browser")!.memberId).toBeUndefined();
});

test("a program is named by its app, or by the folder that says what it is when its file is only a version number", () => {
  expect(programName(`${CHROME}/Frameworks/X.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)`)).toBe("Google Chrome");
  expect(programName(CLAUDE)).toBe("claude");
  expect(programName("/opt/homebrew/Cellar/python@3.12/3.12.4/bin/python3.12")).toBe("python3.12");
  expect(programName("WindowServer")).toBe("WindowServer");
});

test("a Linux hub lists its processes from /proc with no process spawned, and reads a browser's command line", () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemTotal:       16000000 kB\nMemFree:          400000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       4000000 kB\nSwapFree:        1000000 kB\n",
    "/proc/vmstat": "nr_free_pages 100000\npswpin 1\npswpout 1\n",
    // "pid (name) state ppid ...": the 24th field is its resident pages (4 KiB here).
    "/proc/10/stat": `10 (claude) S 1 ${"0 ".repeat(19)}200000 0`,
    "/proc/11/stat": `11 (chrome (x)) S 10 ${"0 ".repeat(19)}100000 0`,
    "/proc/11/cmdline": "/opt/browseros-neo/browseros-neo\0--type=renderer\0--lang=en\0",
    "/proc/12/stat": `12 (kworker/0:1) I 2 ${"0 ".repeat(19)}0 0`,
  };
  const links: Record<string, string> = { "/proc/10/exe": "/home/u/.local/share/claude/versions/2.1.330", "/proc/11/exe": "/opt/browseros-neo/browseros-neo" };
  const r = linuxReader(
    (p) => files[p] ?? (() => { throw new Error("no such file"); })(),
    { list: () => ["10", "11", "12", "999", "self", "meminfo"], link: (p) => links[p] ?? (() => { throw new Error("not allowed"); })() },
  );
  r.read();
  const rows = r.processes!((path) => path.includes("browseros"))!;
  expect(rows).toEqual([
    { pid: 10, ppid: 1, path: "/home/u/.local/share/claude/versions/2.1.330", bytes: 200000 * 4096 },
    { pid: 11, ppid: 10, path: "/opt/browseros-neo/browseros-neo", bytes: 100000 * 4096, args: "/opt/browseros-neo/browseros-neo --type=renderer --lang=en" },
    // A kernel thread: no program to point at and nothing resident, so it is named and not measured.
    { pid: 12, ppid: 2, path: "kworker/0:1", bytes: null },
  ]);
  // The browser's page process is found by its command line there, and counted with the agents' browser.
  const browser = groupProcesses(rows, { agents: [shopper({ pids: [10] })] }).find((h) => h.kind === "browser")!;
  expect(browser.pages).toEqual([{ pid: 11, bytes: 100000 * 4096 }]);
});

test("this machine's own process table can be read (read-only: nothing is spawned, signalled or changed)", () => {
  const r = readerFor(process.platform);
  if (r.blind || !r.processes) return;
  const rows = r.processes((path) => path === process.execPath)!;
  const me = rows.find((p) => p.pid === process.pid)!;
  expect(me.ppid).toBe(process.ppid);
  expect(me.bytes).toBeGreaterThan(0);
  expect(me.path).toContain("bun");
  expect(me.args).toContain("test");
  expect(rows.length).toBeGreaterThan(10);
});

// ---- what the guard does about it ----

/** A machine a test moves by hand: its level, its swap, and its process table. Nothing real is read or touched. */
function squeezable(o: { level: number; rows: () => ProcessRow[] }) {
  let level = o.level;
  let swapPages = 0;
  let swapUsed = 2 * GiB;
  const reader: MemoryReader = {
    blind: null,
    ramBytes: () => 16 * GiB,
    pageBytes: () => 16 * 1024,
    read: () => ({ level, freeBytes: Math.round((level / 100) * 16 * GiB), swapPages, swapUsedBytes: swapUsed }),
    footprint: () => null,
    processes: () => o.rows(),
  };
  return { reader, level: (n: number) => void (level = n), now: () => level, swap: (pages: number, used = swapUsed) => void ((swapPages = pages), (swapUsed = used)) };
}

/** A guard on such a machine, with every action written down in the order it happened instead of done. */
function acting(o: { rows: () => ProcessRow[]; agents?: () => AgentProcess[]; acts?: boolean | (() => boolean); steer?: boolean; holders?: HolderProbe[]; act?: Partial<MemoryActions>; state?: { text: string | null } }) {
  const m = squeezable({ level: 60, rows: o.rows });
  const calls: string[] = [];
  const notes: { title: string; body: string; roomId?: string; acted?: boolean }[] = [];
  let now = 1_000_000;
  let replying = true;
  const guard = new MemoryGuard({
    machineName: () => "Mac mini",
    holders: async () => o.holders ?? [],
    reader: m.reader,
    now: () => now,
    notify: (n) => (calls.push(`notify ${n.title}`), void notes.push(n)),
    acts: typeof o.acts === "function" ? o.acts : () => o.acts !== false,
    agents: o.agents ?? (() => [shopper({ replying })]),
    pause: async () => {},
    ...(o.state ? { readState: () => o.state!.text, writeState: (text: string) => void (o.state!.text = text) } : {}),
    act: {
      endIdle: (ms) => (calls.push(`endIdle ${ms}`), 2),
      hold: (on) => void calls.push(`hold ${on}`),
      steer: async (id, text) => (calls.push(`steer ${id} ${text}`), o.steer !== false),
      stop: async (room, id, error) => (calls.push(`stop ${room} ${id} ${error}`), (replying = false), true),
      say: (room, text) => void calls.push(`say ${room} ${text}`),
      endPage: (pid) => void calls.push(`endPage ${pid}`),
      ...o.act,
    },
  });
  /** One look, `secs` later, at this level; then everything it started has finished. */
  const look = async (level: number, secs = 10) => {
    now += secs * 1000;
    m.level(level);
    guard.tick();
    await guard.settled();
  };
  return { guard, m, calls, notes, look, at: () => now };
}

test("a browser that keeps growing brings the tight step, then the full one, in that order and each once", async () => {
  // The browser's pages, growing look by look, until some are closed.
  let pages = [600, 500, 400];
  const closed: number[] = [];
  const rows = () => table(pages).filter((r) => !closed.includes(r.pid));
  const t = acting({
    rows,
    act: {
      // A page asked to quit goes, and the machine gets some memory back.
      endPage: (pid) => {
        t.calls.push(`endPage ${pid}`);
        closed.push(pid);
        t.m.level(t.m.now() + 6);
      },
    },
  });
  await t.look(60); // the very first look: nothing is ever done from one reading
  await t.look(40); // getting full: who holds it is looked at from here on
  expect(t.guard.status().holders.map((h) => h.what)).toEqual(["the agents' browser", "Google Chrome", "Claude Code in Shopping"]);
  expect(t.calls).toEqual([]);

  // Tight, with the browser a good deal bigger than when the machine left "fine".
  pages = [1500, 1200, 900, 500];
  await t.look(33);
  const steer = `steer mb_shop ${MEMORY_STEER}`;
  expect(t.calls).toEqual([
    `endIdle ${MEMORY_ACT.idleMs}`,
    "hold true",
    steer,
    "say r_shop Mac mini is nearly out of memory. Crosstalk asked Claude Code to close the pages it opened, and will stop this reply if it keeps growing.",
    "notify Mac mini is nearly out of memory",
  ]);
  expect(MEMORY_STEER).toBe("This machine is nearly out of memory. Close every browser tab you opened and work one page at a time.");
  expect(t.notes[0]).toMatchObject({ body: "The agents' browser in Shopping holds 4.5 GB. Crosstalk asked Claude Code to close pages and will stop that reply if it keeps growing.", roomId: "r_shop" });
  expect(t.guard.holding()).toBe(true);
  // Still tight: nothing again.
  await t.look(31);
  expect(t.calls.length).toBe(5);

  // It gets worse: the phone hears of the full band at once, but nothing is stopped on one reading.
  pages = [2600, 2200, 1800, 1500, 1400];
  await t.look(22);
  expect(t.calls.slice(5)).toEqual(["notify Mac mini is out of memory"]);
  expect(t.notes[1].body).toContain("The biggest thing running is the agents' browser (9.8 GB)");
  expect(t.notes[1].body).not.toContain("stops nothing by itself");
  await t.look(21);
  expect(t.calls.length).toBe(6);
  // Twenty seconds under the full line: the reply is stopped, and the browser's biggest pages are asked to quit until
  // the machine is out of the tight band again (20 -> 26 -> 32 -> 38).
  await t.look(20);
  expect(t.calls.slice(6)).toEqual([
    "stop r_shop mb_shop Crosstalk stopped this reply: Mac mini was about to freeze.",
    "say r_shop Stopped Claude Code: Mac mini was about to freeze (its browser held 9.8 GB). Tap Try again when you're ready.",
    "endPage 310",
    "endPage 311",
    "endPage 312",
    "notify Mac mini was about to freeze",
  ]);
  expect(t.notes[2]).toMatchObject({ body: "Stopped Claude Code: Mac mini was about to freeze (its browser held 9.8 GB). Tap Try again when you're ready. It also closed 3 pages in the agents' browser.", roomId: "r_shop", acted: true });
  // Never the browser itself (300), its GPU process (301), or anything of the person's Chrome (400, 401). Two pages
  // are left open: the machine had room again.
  expect(closed).toEqual([310, 311, 312]);

  // Out of trouble, but not for long enough yet: replies still wait, and nothing is done.
  await t.look(38);
  await t.look(39, 40);
  expect(t.calls.length).toBe(12);
  expect(t.guard.holding()).toBe(true);
  // A minute of room: what waited starts.
  await t.look(41, 20);
  expect(t.calls.slice(12)).toEqual(["hold false"]);
  expect(t.guard.holding()).toBe(false);
  t.guard.stop();
});

test("nothing is done twice in one spell, however long the machine stays full; a new spell starts over", async () => {
  let pages = [1500, 1200];
  const t = acting({ rows: () => table(pages) });
  await t.look(60);
  await t.look(40);
  pages = [2500, 2000];
  await t.look(20); // straight into the full band: still the tight step first
  expect(t.calls.filter((c) => c.startsWith("stop")).length).toBe(0);
  expect(t.calls.filter((c) => c.startsWith("steer")).length).toBe(1);
  await t.look(20);
  await t.look(20);
  // The pages stay (this machine's fake ones don't go when asked): both are asked once, and that is all.
  const done = [...t.calls];
  expect(done.filter((c) => c.startsWith("stop")).length).toBe(1);
  expect(done.filter((c) => c.startsWith("endPage"))).toEqual(["endPage 310", "endPage 311"]);
  for (let i = 0; i < 30; i++) await t.look(i % 2 ? 20 : 30);
  // Thirty more looks, in and out of the full band: one more thing only, the replies that waited start after three minutes.
  expect(t.calls.slice(done.length)).toEqual(["hold false"]);
  expect(t.calls.filter((c) => c.startsWith("notify")).length).toBe(2);

  // A minute and more of room, then trouble again: that is a new spell, and it is acted on again.
  await t.look(60, 30);
  await t.look(60, 40);
  await t.look(60, 30);
  await t.look(40);
  pages = [2600, 2100];
  await t.look(30);
  expect(t.calls.filter((c) => c.startsWith("endIdle")).length).toBe(2);
  t.guard.stop();
});

test("pages stop being closed once the browser is back under 3 GB, and none is closed while it is smaller than that", async () => {
  // Under 3 GB at the full step: the reply is stopped, the browser is left alone.
  let pages = [600, 500];
  const small = acting({ rows: () => table(pages) });
  await small.look(60);
  await small.look(40);
  pages = [1300, 1000];
  for (const level of [20, 20, 20]) await small.look(level);
  expect(small.calls.some((c) => c.startsWith("stop r_shop"))).toBe(true);
  expect(small.calls.some((c) => c.startsWith("endPage"))).toBe(false);
  expect(small.notes.at(-1)!.body).toBe("Stopped Claude Code: Mac mini was about to freeze (its browser held 2.7 GB). Tap Try again when you're ready.");
  small.guard.stop();

  // 5.4 GB, and the level never comes back: the two biggest pages take it under 3 GB, and the rest stay open.
  pages = [600, 500];
  const closed: number[] = [];
  const big = acting({ rows: () => table(pages).filter((r) => !closed.includes(r.pid)), act: { endPage: (pid) => void closed.push(pid) } });
  await big.look(60);
  await big.look(40);
  pages = [2000, 1500, 800, 400, 300];
  for (const level of [20, 20, 20]) await big.look(level);
  expect(closed).toEqual([310, 311]);
  big.guard.stop();
});

test("with Free memory by itself off nothing is done: the phone is told, with who holds what, and that nothing is stopped", async () => {
  let pages = [600, 500, 400];
  const t = acting({ rows: () => table(pages), acts: false });
  await t.look(60);
  await t.look(40);
  pages = [1500, 1200, 900, 500];
  await t.look(33);
  pages = [2200, 1800, 1300, 800, 300];
  for (const level of [22, 21, 20, 19, 18, 18, 18, 18]) await t.look(level);
  // (6.7 GB: 6,400 MiB of pages and the browser's own 500.)
  expect(t.calls).toEqual(["notify Mac mini is nearly out of memory", "notify Mac mini is out of memory"]);
  expect(t.notes[0]).toMatchObject({ body: "The agents' browser in Shopping holds 4.5 GB. Stop that reply to free it. Crosstalk stops nothing by itself.", roomId: "r_shop" });
  expect(t.notes[1].body).toContain("the agents' browser (6.7 GB)");
  expect(t.notes[1].body).toContain("Crosstalk stops nothing by itself.");
  expect(t.guard.holding()).toBe(false);
  expect(t.guard.status().acts).toBe(false);
  t.guard.stop();
});

test("an agent that can't take a message mid-reply is only watched, and the notice doesn't claim it was asked", async () => {
  let pages = [600, 500];
  const t = acting({ rows: () => table(pages), steer: false });
  await t.look(60);
  await t.look(40);
  pages = [2000, 1500];
  await t.look(33);
  expect(t.calls).toContain("say r_shop Mac mini is nearly out of memory. Crosstalk will stop this reply if it keeps growing.");
  expect(t.notes[0].body).toBe("The agents' browser in Shopping holds 3.9 GB. Crosstalk will stop that reply if it keeps growing.");
  t.guard.stop();
});

test("no reply is stopped, and none waits, when what fills the machine isn't the agents': the image editor is named instead", async () => {
  // The editor holds 12 GB; the agent's own processes grow to 2.5 GB beside it. Stopping its reply would free little.
  let agent = 400;
  const rows = () => [{ pid: 200, ppid: 100, path: CLAUDE, bytes: agent * MiB }, { pid: 700, ppid: 1, path: "/opt/homebrew/bin/python3.12", bytes: 12 * GiB }];
  const t = acting({ rows, agents: () => [shopper({ browsing: false })], holders: [{ what: "the image editor", ours: true, section: "image-editor", bytes: 12 * GiB, claims: [700] }] });
  await t.look(60);
  await t.look(40);
  agent = 2500;
  await t.look(30);
  for (const level of [20, 20, 20, 20, 20]) await t.look(level);
  expect(t.calls.filter((c) => !c.startsWith("notify"))).toEqual([`endIdle ${MEMORY_ACT.idleMs}`]);
  expect(t.notes[0].body).toContain("The biggest thing running is the image editor (12.0 GB)");
  expect(t.notes[0].body).toContain("Turn the image editor off");
  expect(t.notes[0].roomId).toBeUndefined();
  // The editor's own process isn't listed a second time under "python3.12".
  expect(t.guard.status().holders.map((h) => h.what)).toEqual(["the image editor", "Claude Code in Shopping"]);
  // What the next model has to fit beside is still only the editor.
  expect(t.guard.status().takenBytes).toBe(12 * GiB);
  t.guard.stop();
});

test("an agent whose own processes fill the machine is told so in its own words, and stopped the same way", async () => {
  // No browser at all: a build under the agent grows to 5 GB.
  let build = 300;
  const rows = () => [{ pid: 200, ppid: 100, path: CLAUDE, bytes: 400 * MiB }, { pid: 220, ppid: 200, path: "/usr/bin/clang", bytes: build * MiB }];
  const t = acting({ rows, agents: () => [shopper({ chat: "Build", browsing: false })] });
  await t.look(60);
  await t.look(40);
  build = 4700;
  await t.look(33);
  expect(t.calls).toContain(`steer mb_shop ${MEMORY_STEER_OWN}`);
  expect(MEMORY_STEER_OWN).toBe("This machine is nearly out of memory, and what you are running holds most of it. End the commands and programs you no longer need, and run one thing at a time.");
  expect(t.notes[0].body).toBe("Claude Code in Build holds 5.0 GB. Crosstalk asked Claude Code to end what it doesn't need and will stop that reply if it keeps growing.");
  for (const level of [20, 20, 20]) await t.look(level);
  expect(t.calls).toContain("say r_shop Stopped Claude Code: Mac mini was about to freeze (it held 5.0 GB). Tap Try again when you're ready.");
  expect(t.calls.some((c) => c.startsWith("endPage"))).toBe(false);
  t.guard.stop();
});

test("the full step also comes from heavy swapping for 30 s, or a level still falling a minute after the tight step", async () => {
  // Swapping: tight, then the swap counters move faster than the kernel's thrashing line for half a minute.
  let pages = [600, 500];
  const a = acting({ rows: () => table(pages) });
  await a.look(60);
  await a.look(40);
  pages = [2000, 1500];
  await a.look(33);
  let swapped = 0;
  for (let i = 0; i < 3; i++) {
    a.m.swap((swapped += THRASH_PAGES_PER_SEC * 10 + 10));
    await a.look(32);
    expect(a.calls.some((c) => c.startsWith("stop"))).toBe(false);
  }
  a.m.swap((swapped += THRASH_PAGES_PER_SEC * 10 + 10));
  await a.look(32);
  expect(a.calls.some((c) => c.startsWith("stop r_shop mb_shop"))).toBe(true);
  a.guard.stop();

  // Falling: tight at 34, and a minute later it is five points lower without ever reaching the full band.
  pages = [600, 500];
  const b = acting({ rows: () => table(pages) });
  await b.look(60);
  await b.look(40);
  pages = [2000, 1500];
  await b.look(34);
  for (const level of [33, 32, 31, 30, 29]) await b.look(level);
  expect(b.calls.some((c) => c.startsWith("stop"))).toBe(false); // 50 s after, and already five lower: not yet
  await b.look(29);
  expect(b.calls.some((c) => c.startsWith("stop r_shop mb_shop"))).toBe(true);
  b.guard.stop();
});

test("getting full with swap still growing fast counts as tight before the level gets there", async () => {
  let pages = [600, 500];
  const t = acting({ rows: () => table(pages) });
  await t.look(60);
  t.m.swap(0, 2 * GiB);
  await t.look(42);
  pages = [2000, 1500];
  // Swap in use grows a little: not enough.
  t.m.swap(0, 2 * GiB + 100 * MiB);
  await t.look(41);
  expect(t.calls).toEqual([]);
  // Then by more than half a gigabyte inside a minute, with the level still above the tight line.
  t.m.swap(0, 2 * GiB + 700 * MiB);
  await t.look(40);
  expect(t.calls[0]).toBe(`endIdle ${MEMORY_ACT.idleMs}`);
  expect(t.notes[0].title).toBe("Mac mini is nearly out of memory");
  t.guard.stop();
});

test("what the guard last saw is kept, so a hub that comes back after the machine froze knows which reply was filling it", async () => {
  const state = { text: null as string | null };
  let pages = [600, 500];
  const t = acting({ rows: () => table(pages), state });
  expect(t.guard.wentDown()).toBeNull();
  await t.look(60);
  await t.look(40);
  expect(state.text).toBeNull(); // nothing is written while nothing is wrong
  pages = [2000, 1500];
  await t.look(33);
  expect(JSON.parse(state.text!)).toEqual({ band: "tight", step: "tight", roomId: "r_shop", memberId: "mb_shop", at: t.at() });
  const written = state.text;
  await t.look(32);
  expect(state.text).toBe(written); // only when something changes
  // The machine freezes here: the hub never stops on purpose. The next hub reads what was kept.
  const next = new MemoryGuard({ machineName: () => "Mac mini", holders: async () => [], reader: blindReader("test"), readState: () => state.text });
  expect(next.wentDown()).toEqual({ at: JSON.parse(written!).at, band: "tight", roomId: "r_shop", memberId: "mb_shop" });
  // It is read once: the hub that read it clears it, so being killed later on a quiet machine isn't taken for this again.
  const again = { text: written };
  expect(new MemoryGuard({ machineName: () => "Mac mini", holders: async () => [], reader: blindReader("test"), readState: () => again.text, writeState: (text) => void (again.text = text) }).wentDown()).not.toBeNull();
  expect(JSON.parse(again.text!)).toMatchObject({ band: "fine", step: "none" });
  // The line its chat gets instead of the reply starting again by itself.
  expect(memoryNoResumeLine("Mac mini", "2:41 AM")).toBe("Mac mini ran out of memory at 2:41 AM while this was running. Tap Try again to carry on.");

  // A hub that stops on purpose (a restart, an update) clears it: the next start is an ordinary one.
  t.guard.stop();
  expect(JSON.parse(state.text!)).toMatchObject({ band: "fine", step: "none" });
  expect(new MemoryGuard({ machineName: () => "Mac mini", holders: async () => [], reader: blindReader("test"), readState: () => state.text }).wentDown()).toBeNull();
  // Nothing kept, or something unreadable, is an ordinary start too.
  expect(new MemoryGuard({ machineName: () => "Mac mini", holders: async () => [], reader: blindReader("test"), readState: () => "{not json" }).wentDown()).toBeNull();
});

test("turning Free memory by itself off lets the replies that waited start, and every device hears the switch", async () => {
  let on = true;
  let pages = [600, 500];
  const sent: MachineMemory[] = [];
  const t = acting({ rows: () => table(pages), acts: () => on });
  await t.look(60);
  await t.look(40);
  pages = [2000, 1500];
  await t.look(33);
  expect(t.guard.holding()).toBe(true);
  expect(t.guard.status().acts).toBe(true);
  on = false;
  t.guard.settingChanged();
  expect(t.guard.holding()).toBe(false);
  expect(t.calls.at(-1)).toBe("hold false");
  expect(t.guard.status().acts).toBe(false);
  void sent;
  t.guard.stop();
});

test("the notice no longer says Crosstalk stops nothing once it may, and agents on a small machine are told to keep few pages open", () => {
  const m: MachineMemory = { band: "tight", level: 30, blind: null, ramBytes: 16 * GiB, takenBytes: null, swapPagesPerSec: 0, swapUsedBytes: null, holders: [{ what: "the agents' browser", ours: true, section: null, bytes: 6 * GiB, kind: "browser" }], at: 1 };
  expect(memoryNotice(m, "Mac mini").body).toBe("Mac mini is nearly out of memory, so everything on it is slow. The biggest thing running is the agents' browser (6.0 GB). Close pages in the agents' browser. Crosstalk stops nothing by itself.");
  expect(memoryNotice({ ...m, acts: false }, "Mac mini").body).toContain("Crosstalk stops nothing by itself.");
  expect(memoryNotice({ ...m, acts: true }, "Mac mini").body).toBe("Mac mini is nearly out of memory, so everything on it is slow. The biggest thing running is the agents' browser (6.0 GB). Close pages in the agents' browser.");
  expect(memoryWays({ ...m, holders: [{ what: "Claude Code in Shopping", ours: true, section: null, bytes: 3 * GiB, kind: "agent" }, { what: "Google Chrome", ours: false, section: null, bytes: GiB, kind: "other" }] }).map((w) => w.text)).toEqual(["Stop Claude Code in Shopping", "Quit Google Chrome on this machine"]);
  // 16 GB and below get the line; a bigger machine doesn't.
  expect(memoryBriefing(16 * GiB)).toContain("close each tab as soon as you're done with it");
  expect(memoryBriefing(8 * GiB)).not.toBeNull();
  expect(memoryBriefing(32 * GiB)).toBeNull();
  expect(memoryBriefing(0)).toBeNull();
});
