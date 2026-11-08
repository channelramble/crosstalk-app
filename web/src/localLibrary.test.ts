import { expect, test } from "bun:test";
import type { LocalDownload, LocalFolder, LocalMachine, LocalStarted } from "@crosstalk/shared";
import { capacity, contextsFor, startChoice, downloadLine, downloadPct, downloadsText, downloadWayOut, fileTitle, fitOf, folderLine, lookFor, lowQuality, machineText, needOf, ollamaNameProblem, paramsText, ramRoom, roomFor, roomProblem, startedLine, startedTitle, suggestedFile } from "./localLibrary";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const mac = (over: Partial<LocalMachine> = {}): LocalMachine => ({ ramBytes: 16 * GiB, unified: true, gpuBytes: 12124 * MiB, gpuFrom: "llama.cpp", gpus: [{ name: "Apple M4", totalBytes: 12124 * MiB, freeBytes: 12123 * MiB }], ...over });
const pc = (over: Partial<LocalMachine> = {}): LocalMachine => ({ ramBytes: 32 * GiB, unified: false, gpuBytes: 15890 * MiB, gpuFrom: "llama.cpp", gpus: [{ name: "RX 7600 XT", totalBytes: 16304 * MiB, freeBytes: 15890 * MiB }], ...over });
const cpu = (over: Partial<LocalMachine> = {}): LocalMachine => ({ ramBytes: 32 * GiB, unified: false, gpuBytes: null, gpuFrom: null, gpus: [], ...over });

test("what a model needs: the file, its KV cache at the context (never past what it was trained for), and llama.cpp's headroom", () => {
  // Qwen3 8B Q4_K_M: 5 GB, 144 KiB a token, 32k context: 5 + 4.5 + 1 GB.
  expect(needOf(5 * GiB, 147456, 32768, 40960)).toEqual({ bytes: 5 * GiB + 147456 * 32768 + GiB, context: 32768, sure: true });
  // Trained for 8k: 128k counts as 8k.
  expect(needOf(GiB, 1000, 131072, 8192)).toEqual({ bytes: GiB + 1000 * 8192 + GiB, context: 8192, sure: true });
  // The header wasn't read: a mid-size model's 128 KiB a token, and not sure.
  expect(needOf(GiB, null, 32768, null)).toEqual({ bytes: GiB + 128 * 1024 * 32768 + GiB, context: 32768, sure: false });
});

test("the verdict: fits up to 85% of what the machine can give, tight to 100%, slow on a PC when the rest fits its memory, else too big", () => {
  // A Mac with 16 GB: Metal's 11.8 GB.
  expect(capacity(mac())).toEqual({ bytes: 12124 * MiB, on: "gpu" });
  expect(fitOf(6 * GiB, mac(), "Mac mini")).toEqual({ kind: "fits", label: "Fits", tone: "green", line: "Fits on Mac mini: needs about 6.0 GB of the 11.8 GB models can use." });
  expect(fitOf(11 * GiB, mac(), "Mac mini")).toEqual({ kind: "tight", label: "Tight", tone: "orange", line: "Tight: needs about 11.0 GB of the 11.8 GB models can use. Close other apps, or pick a smaller file or context." });
  // A Mac never runs it "partly on the processor": past Metal's share, it's too big.
  expect(fitOf(13 * GiB, mac(), "Mac mini")).toEqual({ kind: "big", label: "Too big", tone: "red", line: "Too big for Mac mini: needs about 13.0 GB of the 11.8 GB models can use. Pick a smaller file or context." });
  // A PC: its GPU's free memory, then the rest on the processor while its memory holds it.
  expect(fitOf(10 * GiB, pc(), "the PC").kind).toBe("fits");
  expect(fitOf(15 * GiB, pc(), "the PC").kind).toBe("tight");
  expect(fitOf(30 * GiB, pc(), "the PC")).toEqual({ kind: "slow", label: "Slow", tone: "orange", line: "Runs, but slowly: it needs about 30.0 GB and the GPU has 15.5 GB, so part of it runs on the processor." });
  expect(fitOf(45 * GiB, pc(), "the PC").kind).toBe("big");
  // No GPU: the memory, less what the system keeps (a quarter, at least 4 GB), and it says replies come slowly.
  expect(ramRoom(32 * GiB)).toBe(24 * GiB);
  expect(ramRoom(8 * GiB)).toBe(4 * GiB);
  expect(ramRoom(2 * GiB)).toBe(0);
  expect(fitOf(10 * GiB, cpu(), "Linux box")).toEqual({ kind: "fits", label: "Fits", tone: "green", line: "Fits on Linux box: needs about 10.0 GB of the 24.0 GB models can use. With no GPU it runs on the processor, so replies come slowly." });
  expect(fitOf(23 * GiB, cpu(), "Linux box").kind).toBe("tight");
  expect(fitOf(25 * GiB, cpu(), "Linux box").kind).toBe("big");
  // A machine with too little memory to give anything: too big.
  expect(fitOf(GiB, cpu({ ramBytes: 2 * GiB }), "Pi").kind).toBe("big");
});

test("the machine in a sentence", () => {
  expect(machineText(mac(), "Mac mini")).toBe("Mac mini has 16.0 GB of memory, shared with its GPU: models can use 11.8 GB of it.");
  expect(machineText(mac({ gpuBytes: Math.round((16 * GiB * 2) / 3), gpuFrom: "estimate", gpus: [] }), "Mac mini")).toBe("Mac mini has 16.0 GB of memory, shared with its GPU: models can use about 10.7 GB of it.");
  expect(machineText(pc(), "the PC")).toBe("the PC has 32.0 GB of memory, and its RX 7600 XT has 15.5 GB free.");
  expect(machineText(pc({ gpus: [{ name: "A", totalBytes: GiB, freeBytes: GiB }, { name: "B", totalBytes: GiB, freeBytes: GiB }] }), "the PC")).toBe("the PC has 32.0 GB of memory, and its 2 GPUs have 15.5 GB free.");
  expect(machineText(cpu(), "Linux box")).toBe("Linux box has 32.0 GB of memory and no GPU llama.cpp found: models run on the processor.");
});

test("the suggested file: the biggest of Q8_0, Q6_K, Q5_K_M and Q4_K_M that fits, else the biggest that fits, else none", () => {
  const m = (quant: string | null, gb: number) => ({ files: [`M-${quant}.gguf`], quant, sizeBytes: gb * GiB });
  const files = [m("Q2_K", 3), m("Q3_K_M", 4), m("Q4_K_M", 5), m("Q5_K_M", 6), m("Q6_K", 7), m("Q8_0", 9), m("F16", 16)];
  const under = (gb: number) => (x: { sizeBytes: number }) => (x.sizeBytes <= gb * GiB ? ("fits" as const) : ("big" as const));
  expect(suggestedFile(files, under(10))).toBe("M-Q8_0.gguf");
  expect(suggestedFile(files, under(6.5))).toBe("M-Q5_K_M.gguf");
  // F16 fits but isn't the suggestion when a quant that keeps the quality does.
  expect(suggestedFile(files, under(20))).toBe("M-Q8_0.gguf");
  // Only the low ones fit: the biggest of those.
  expect(suggestedFile(files, under(4.5))).toBe("M-Q3_K_M.gguf");
  expect(suggestedFile(files, under(1))).toBeNull();
  expect(suggestedFile([m("UD-Q4_K_XL", 5), m("IQ4_XS", 4.5)], under(10))).toBe("M-UD-Q4_K_XL.gguf");
  expect(suggestedFile([m(null, 5)], under(10))).toBe("M-null.gguf");
  // Below 4 bits is said.
  expect(["Q2_K", "Q3_K_M", "IQ3_XXS", "UD-IQ1_S", "TQ1_0"].every(lowQuality)).toBe(true);
  expect(["Q4_K_M", "IQ4_XS", "Q8_0", "MXFP4", "F16", null].some(lowQuality)).toBe(false);
});

test("room on the disk: the folder's problem first, then what's free past the reserve, with the ways out", () => {
  const folder = (over: Partial<LocalFolder> = {}): LocalFolder => ({ path: "/Users/me/.crosstalk/models", shown: "~/.crosstalk/models", isDefault: true, drive: null, freeBytes: 20 * GiB, totalBytes: 500 * GiB, problem: null, ...over });
  expect(roomProblem(10 * GiB, folder(), 2 * GiB)).toBeNull();
  expect(roomProblem(19 * GiB, folder(), 2 * GiB)).toBe("Not enough room in ~/.crosstalk/models: it needs 19.0 GB and 18.0 GB is free (keeping 2.0 GB free). Free up space, or change the folder.");
  // Nothing past the reserve: said so, not "1 KB".
  expect(roomProblem(GiB, folder({ freeBytes: GiB }), 2 * GiB)).toBe("Not enough room in ~/.crosstalk/models: it needs 1.0 GB and nothing is free (keeping 2.0 GB free). Free up space, or change the folder.");
  expect(roomProblem(GiB, folder({ freeBytes: 2 * GiB }), 2 * GiB)).toContain("and nothing is free");
  expect(roomProblem(GiB, folder({ problem: "The drive Untitled isn't plugged in: plug it in, or change the folder." }), 2 * GiB)).toBe("The drive Untitled isn't plugged in: plug it in, or change the folder.");
  // Free space not known: the hub checks it as the download starts.
  expect(roomProblem(GiB, folder({ freeBytes: null }), 2 * GiB)).toBeNull();
  expect(folderLine(folder())).toBe("~/.crosstalk/models · 20.0 GB free");
  expect(folderLine(folder({ shown: "/Volumes/Untitled/models", drive: "Untitled", freeBytes: null }))).toBe("/Volumes/Untitled/models (on Untitled)");
});

test("a download's line: progress, where it stopped, Ollama's steps in plain words, and what went wrong with its way out", () => {
  const d = (over: Partial<LocalDownload> = {}): LocalDownload => ({ id: "hf:x", source: "huggingface", name: "Qwen3-8B Q4_K_M", model: null, ollama: null, state: "downloading", doneBytes: 2 * GiB, totalBytes: 5 * GiB, bytesPerSec: 50 * MiB, error: null, code: null, step: null, updatedAt: 1, ...over });
  expect(downloadLine(d())).toBe("40% · 2.0 GB of 5.0 GB · 50 MB/s · about 1 min left");
  expect(downloadLine(d({ bytesPerSec: null }))).toBe("40% · 2.0 GB of 5.0 GB");
  expect(downloadLine(d({ state: "stopped", bytesPerSec: null }))).toBe("Stopped at 40% · 2.0 GB of 5.0 GB");
  expect(downloadLine(d({ state: "stopped", totalBytes: 0, doneBytes: 0 }))).toBe("Stopped");
  expect(downloadLine(d({ source: "ollama", totalBytes: 0, doneBytes: 0, step: "pulling manifest" }))).toBe("Looking it up…");
  expect(downloadLine(d({ source: "ollama", step: "verifying sha256 digest" }))).toBe("Checking it…");
  expect(downloadLine(d({ source: "ollama", step: "pulling a3de86cd1c13" }))).toBe("40% · 2.0 GB of 5.0 GB · 50 MB/s · about 1 min left");
  expect(downloadLine(d({ totalBytes: 0, doneBytes: 0 }))).toBe("Starting…");
  expect(downloadLine(d({ state: "failed", error: "Hugging Face answered 500: try again in a few minutes." }))).toBe("Hugging Face answered 500: try again in a few minutes.");
  expect(downloadPct(d())).toBe(40);
  expect(downloadPct(d({ totalBytes: 0 }))).toBe(0);
  expect(downloadPct(d({ doneBytes: 6 * GiB }))).toBe(100);
  expect(downloadWayOut({ code: "low_disk", source: "huggingface" })).toBe("folder");
  expect(downloadWayOut({ code: "folder", source: "huggingface" })).toBe("folder");
  // Ollama's folder is Ollama's own: changing Crosstalk's doesn't help.
  expect(downloadWayOut({ code: "low_disk", source: "ollama" })).toBeNull();
  expect(downloadWayOut({ code: "hf_terms", source: "huggingface" })).toBe("token");
  expect(downloadWayOut({ code: null, source: "huggingface" })).toBeNull();
});

test("a started server's title and line", () => {
  const s = (over: Partial<LocalStarted> = {}): LocalStarted => ({ id: "llamacpp-8080", kind: "llamacpp", port: 8080, baseUrl: "http://127.0.0.1:8080", model: "a/b/c.gguf", context: 32768, state: "starting", detail: "Loading the model…", log: "~/.crosstalk/run/local-servers/llamacpp-8080/server.log", startedAt: 1, ...over });
  expect(startedTitle(s())).toBe("llama.cpp on port 8080");
  expect(startedTitle(s({ kind: "ollama", port: 11434 }))).toBe("Ollama on port 11434");
  expect(startedLine(s())).toBe("Loading the model…");
  expect(startedLine(s({ detail: null }))).toBe("Starting…");
  expect(startedLine(s({ state: "running", detail: null }))).toBe("Running");
  expect(startedLine(s({ state: "running", detail: "It didn't stop: try again, or end it on this machine." }))).toBe("It didn't stop: try again, or end it on this machine.");
  expect(startedLine(s({ state: "stopping" }))).toBe("Stopping…");
  expect(startedLine(s({ state: "failed", detail: "llama.cpp couldn't load the model: download it again or pick another quant, then start again." }))).toBe("llama.cpp couldn't load the model: download it again or pick another quant, then start again.");
});

test("small words: a file's title, what was typed in the search box, parameters, downloads, Ollama's names, the contexts on offer", () => {
  expect(fileTitle({ repo: "unsloth/Qwen3-8B-GGUF", quant: "Q4_K_M", files: ["Qwen3-8B-Q4_K_M.gguf"] })).toBe("Qwen3-8B · Q4_K_M");
  expect(fileTitle({ repo: "bartowski/google_gemma-3-12b-it-GGUF", quant: null, files: ["sub/odd.gguf"] })).toBe("gemma-3-12b-it · odd.gguf");
  expect(lookFor("  qwen3 coder ")).toEqual({ q: "qwen3 coder" });
  expect(lookFor("unsloth/Qwen3-8B-GGUF")).toEqual({ repo: "unsloth/Qwen3-8B-GGUF" });
  expect(lookFor("https://huggingface.co/unsloth/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf")).toEqual({ repo: "unsloth/Qwen3-8B-GGUF" });
  expect(lookFor("q")).toBeNull();
  expect(lookFor("   ")).toBeNull();
  expect(paramsText(8_190_000_000)).toBe("8.2B");
  expect(paramsText(30_500_000_000)).toBe("30.5B");
  expect(paramsText(235_000_000_000)).toBe("235B");
  expect(paramsText(600_000_000)).toBe("600M");
  expect(paramsText(null)).toBeNull();
  expect(downloadsText(1)).toBe("1 download");
  expect(downloadsText(830)).toBe("830 downloads");
  expect(downloadsText(1234)).toBe("1.2k downloads");
  expect(downloadsText(45_600)).toBe("46k downloads");
  expect(downloadsText(1_250_000)).toBe("1.3M downloads");
  expect(ollamaNameProblem("qwen3:8b")).toBeNull();
  expect(ollamaNameProblem("hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M")).toBeNull();
  expect(ollamaNameProblem("../x")).toBe("Type a model's name as Ollama's library writes it, like qwen3:8b.");
  expect(ollamaNameProblem("two words")).not.toBeNull();
  expect(contextsFor(null)).toEqual([32768, 65536, 131072]);
  expect(contextsFor(40960)).toEqual([32768]);
  // Trained for less than 32k: only its own, which is what llama.cpp is started with.
  expect(contextsFor(8192)).toEqual([8192]);
  expect(contextsFor(262144)).toEqual([32768, 65536, 131072]);
});

test("llama.cpp starts with the biggest model here that fits at 32k, else the biggest that's tight, else the smallest", () => {
  const f = (id: string, gb: number) => ({ id, repo: "a/b", files: [`${id}.gguf`], quant: null, bytes: gb * GiB, kvBytesPerToken: 73728, contextLength: null });
  // A 16 GB Mac: 11.8 GB for models; at 32k a file needs itself plus 3.25 GB.
  expect(startChoice([f("small", 3), f("huge", 16), f("mid", 6)], mac())).toBe("mid");
  // Nothing fits well: the biggest that's tight (8 GB needs 11.25 of 11.8).
  expect(startChoice([f("tight", 8), f("huge", 16), f("bigger", 20)], mac())).toBe("tight");
  // Nothing runs: the least too big, never the biggest.
  expect(startChoice([f("huge", 16), f("bigger", 20)], mac())).toBe("huge");
  expect(startChoice([], mac())).toBeNull();
});

test("on Apple silicon the system keeps its share too, so a small Mac is never told a model fits when it can't", () => {
  // 16 GB: Metal's working set (11.8 GB) is already less than the quarter held back, so nothing changes.
  expect(capacity(mac()).bytes).toBe(12124 * MiB);
  // 8 GB: macOS would hand Metal 5.3 GB of it, which leaves the system nothing. The verdict holds 4 GB back instead.
  const small = mac({ ramBytes: 8 * GiB, gpuBytes: Math.round((8 * GiB * 2) / 3), gpuFrom: "estimate" });
  expect(capacity(small).bytes).toBe(ramRoom(8 * GiB));
  expect(fitOf(5 * GiB, small, "the MacBook").kind).toBe("big");
});

test("the two pools of memory are kept apart: a card's free memory is not the machine's, and the editor is not llama.cpp", () => {
  // One machine, one pool: on Apple silicon the GPU's memory *is* the machine's, so what others hold comes off it.
  expect(roomFor(mac(), Math.round(12.5 * GiB))).toEqual({ freeBytes: 0, totalBytes: 12124 * MiB, on: "gpu" });
  expect(roomFor(mac(), 2 * GiB).freeBytes).toBe(12124 * MiB - 2 * GiB);
  // A discrete GPU: `gpuBytes` is already the card's free memory, and `taken` is the machine's. A 20 GB build on the
  // host says nothing about an empty card -- subtracting it refused every start on an idle GPU, and a program holding
  // 15 GB of VRAM with a small footprint would have been invisible either way.
  expect(roomFor(pc(), 20 * GiB)).toEqual({ freeBytes: 15890 * MiB, totalBytes: 15890 * MiB, on: "gpu" });
  expect(fitOf(10 * GiB, pc(), "the PC", 20 * GiB).kind).toBe("fits");
  // No GPU at all: the memory, less what is held, with a quarter kept for the system.
  expect(roomFor(cpu(), 4 * GiB)).toEqual({ freeBytes: ramRoom(32 * GiB) - 4 * GiB, totalBytes: ramRoom(32 * GiB), on: "memory" });
  // "ram": what the image editor is judged against. All of the machine's memory, less what is held -- ComfyUI is not
  // llama.cpp and is not held to Metal's working set, which is less than one edit needs on a 16 GB Mac.
  expect(roomFor(mac(), 0, "ram")).toEqual({ freeBytes: 16 * GiB, totalBytes: 16 * GiB, on: "memory" });
  expect(roomFor(mac(), Math.round(10.9 * GiB), "ram").freeBytes).toBe(16 * GiB - Math.round(10.9 * GiB));
});

test("the verdict can be asked about the machine as it is, not an empty one: what is already running comes off the top", () => {
  // A 16 GB Mac with the image editor's 12.5 GB loaded, asked for a 10 GB chat model.
  const taken = Math.round(12.5 * GiB);
  expect(fitOf(10 * GiB, mac(), "Mac mini").kind).toBe("fits");
  expect(fitOf(10 * GiB, mac(), "Mac mini", taken)).toEqual({
    kind: "big",
    label: "Too big",
    tone: "red",
    line: "Too big for Mac mini: needs about 10.0 GB, and none of the 11.8 GB models can use is free. Pick a smaller file or context.",
  });
  // With a little running it is still fine, and the sentence says how much is left.
  expect(fitOf(5 * GiB, mac(), "Mac mini", 2 * GiB).line).toBe("Fits on Mac mini: needs about 5.0 GB, and 9.8 GB of the 11.8 GB models can use is free.");
  // Nothing running: word for word what it always said.
  expect(fitOf(6 * GiB, mac(), "Mac mini", 0)).toEqual(fitOf(6 * GiB, mac(), "Mac mini"));
});
