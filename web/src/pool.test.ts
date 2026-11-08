import { expect, test } from "bun:test";
import type { PoolConfig, PoolDevice, PoolMachine, PoolMachineState, PoolView } from "@crosstalk/shared";
import {
  aliasProblem,
  bytesText,
  contextLabel,
  downloadText,
  estimateNeedMiB,
  fitBadge,
  fitTone,
  gpuLine,
  gpuName,
  gpus,
  computerNamed,
  isTailscaleIPv4,
  linkText,
  mibText,
  modelName,
  modelSummary,
  namesText,
  parseHfLink,
  peerOs,
  poolRoom,
  poolWriter,
  portProblem,
  recoveriesFor,
  downloadsOf,
  isChosenDownload,
  roleLabel,
  speedText,
  timeLeftText,
  uncountedMachines,
  withMachine,
} from "./pool";
import { KIMI_PRESET, presetFields } from "./presets";

const GiB = 1024 ** 3;
const dev = (description: string, totalMiB: number, freeMiB = totalMiB, name = "GPU0"): PoolDevice => ({ name, description, totalMiB, freeMiB });
const machine = (id: string, enabled: boolean, extra: Partial<PoolMachine> = {}): PoolMachine => ({ id, kind: id === "self" ? "self" : "computer", name: id, address: null, os: null, backend: null, enabled, rpcPort: 50052, ...extra });
const state = (id: string, devices: PoolDevice[]): PoolMachineState => ({ id, devices, link: null, state: "ready", detail: null, checkedAt: 1 });
const config = (machines: PoolMachine[]): PoolConfig => ({ build: "b11669", machines, mainId: "self", model: null, contextSize: 65536, alias: "pool-model", port: 9931, autostart: false });

test("GPU names come out short, memory as a card is sold", () => {
  expect(gpuName("AMD Radeon RX 7600 XT (RADV NAVI33)")).toBe("RX 7600 XT");
  expect(gpuName("NVIDIA GeForce RTX 3060")).toBe("RTX 3060");
  expect(gpuName("NVIDIA GeForce RTX 4070 SUPER")).toBe("RTX 4070 Super");
  expect(gpuName("Intel(R) Arc(TM) A770 Graphics (DG2)")).toBe("Arc A770");
  expect(gpuName("Apple M4")).toBe("Apple M4");
  expect(gpuName("AMD Radeon Graphics (RADV RAPHAEL_MENDOCINO)")).toBe("AMD Radeon Graphics");
  expect(gpuName("")).toBe("GPU");
  expect(mibText(16304)).toBe("16 GB");
  expect(mibText(12124)).toBe("11.8 GB");
  expect(mibText(8192)).toBe("8 GB");
  expect(mibText(512)).toBe("512 MB");
  expect(gpuLine(dev("AMD Radeon RX 7600 XT (RADV NAVI33)", 16304, 15800))).toBe("RX 7600 XT · 16 GB");
  // What other apps hold matters: the model is split by free memory.
  expect(gpuLine(dev("NVIDIA GeForce RTX 3060", 8192, 5120))).toBe("RTX 3060 · 8 GB (5 GB free)");
  // llama.cpp lists the CPU's BLAS as a device with no memory: it isn't a GPU.
  expect(gpus([dev("Apple M4", 12124, 12123, "MTL0"), dev("Accelerate", 0, 0, "BLAS")]).map((d) => d.name)).toEqual(["MTL0"]);
});

test("the network line says direct or relayed, and that a relay is slower", () => {
  expect(linkText({ ms: 8.2, direct: true })).toBe("Direct · 8 ms");
  expect(linkText({ ms: 40, direct: false })).toBe("Through a relay · 40 ms: slower");
  expect(linkText({ ms: null, direct: false })).toBe("Through a relay: slower");
  expect(linkText({ ms: 0.3, direct: true })).toBe("Direct · under 1 ms");
  expect(linkText({ ms: 12, direct: null })).toBe("12 ms");
  // Not asked (no Tailscale on the hub, or no address): nothing to say. Asked without an answer: said so.
  expect(linkText(null)).toBeNull();
  expect(linkText({ ms: null, direct: null })).toBe("No answer over Tailscale");
});

test("roles: the main machine, helpers and machines left out", () => {
  expect(roleLabel({ id: "self", enabled: false }, "self")).toBe("Main machine");
  expect(roleLabel({ id: "h_1", enabled: true }, "self")).toBe("Helper");
  expect(roleLabel({ id: "pc_1", enabled: false }, "self")).toBe("Left out");
});

test("model names and summaries read like the model, not the repo", () => {
  expect(modelName("unsloth/Qwen3.8-27B-GGUF")).toBe("Qwen3.8-27B");
  expect(modelName("orcarouter/Qwen3.8-27B-GGUF")).toBe("Qwen3.8-27B");
  expect(modelName("ggml-org/gpt-oss-20b-GGUF")).toBe("gpt-oss-20b");
  expect(modelName("bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF")).toBe("Kimi-Linear-48B-A3B-Instruct");
  expect(modelName("someone/plain-model")).toBe("plain-model");
  expect(modelSummary({ quant: "Q4_K_M", sizeBytes: 16.8e9, files: ["a.gguf"] })).toBe("Q4_K_M · 15.6 GB");
  expect(modelSummary({ quant: null, sizeBytes: 60 * GiB, files: ["a-00001-of-00002.gguf", "a-00002-of-00002.gguf"] })).toBe("60.0 GB · in 2 parts");
  expect(bytesText(640 * 1024 ** 2)).toBe("640 MB");
});

test("Hugging Face links: pages, files, llama.cpp's repo:quant, and not datasets or other sites", () => {
  expect(parseHfLink("https://huggingface.co/unsloth/Qwen3.8-27B-GGUF")).toEqual({ repo: "unsloth/Qwen3.8-27B-GGUF", file: null, quant: null });
  expect(parseHfLink("  hf.co/unsloth/Qwen3.8-27B-GGUF/  ")).toEqual({ repo: "unsloth/Qwen3.8-27B-GGUF", file: null, quant: null });
  expect(parseHfLink("unsloth/Qwen3.6-35B-A3B-GGUF")?.repo).toBe("unsloth/Qwen3.6-35B-A3B-GGUF");
  expect(parseHfLink("https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/blob/main/gpt-oss-20b-mxfp4.gguf?download=true")).toEqual({ repo: "ggml-org/gpt-oss-20b-GGUF", file: "gpt-oss-20b-mxfp4.gguf", quant: null });
  expect(parseHfLink("https://huggingface.co/unsloth/X-GGUF/resolve/main/UD-Q4_K_XL/X-UD-Q4_K_XL-00001-of-00002.gguf")?.file).toBe("UD-Q4_K_XL/X-UD-Q4_K_XL-00001-of-00002.gguf");
  expect(parseHfLink("https://huggingface.co/unsloth/X-GGUF/tree/main")).toEqual({ repo: "unsloth/X-GGUF", file: null, quant: null });
  expect(parseHfLink("unsloth/Qwen3.8-27B-GGUF:Q4_K_M")).toEqual({ repo: "unsloth/Qwen3.8-27B-GGUF", file: null, quant: "Q4_K_M" });
  expect(parseHfLink("https://huggingface.co/models/unsloth/Qwen3.8-27B-GGUF")?.repo).toBe("unsloth/Qwen3.8-27B-GGUF");
  expect(parseHfLink("https://huggingface.co/datasets/foo/bar")).toBeNull();
  expect(parseHfLink("https://huggingface.co/spaces/foo/bar")).toBeNull();
  expect(parseHfLink("https://github.com/ggml-org/llama.cpp")).toBeNull();
  expect(parseHfLink("just-a-name")).toBeNull();
  expect(parseHfLink("")).toBeNull();
  expect(parseHfLink("https://huggingface.co/unsloth/X-GGUF/discussions/3")).toBeNull();
});

test("fit badges weigh a file against each GPU and the whole pool, as the hub counts it", () => {
  const rx = dev("AMD Radeon RX 7600 XT (RADV NAVI33)", 16304, 15832, "Vulkan0");
  const rtx = dev("NVIDIA GeForce RTX 3060", 8192, 7900, "CUDA0");
  const view = {
    config: { ...config([machine("self", false), machine("h_linux", true, { kind: "hub" }), machine("pc_games", true)]), contextSize: 32768 },
    machines: [state("self", [dev("Apple M4", 12124, 12123, "MTL0")]), state("h_linux", [rx]), state("pc_games", [rtx])],
    fit: null,
  } as Pick<PoolView, "config" | "machines" | "fit">;
  const room = poolRoom(view);
  // The Mac is left out, so its memory doesn't count.
  expect(room).toEqual({ devices: [{ name: "RX 7600 XT", freeMiB: 15832 }, { name: "RTX 3060", freeMiB: 7900 }], haveMiB: 23732, uncounted: [], taking: 2, contextSize: 32768 });
  // The hub's sum (hub/src/pool/pool.ts poolFit): the file, 96 KiB a token of context, 1 GiB a machine taking part.
  expect(estimateNeedMiB(16_812_390_656, 32768, 2)).toBe(21154);
  expect(estimateNeedMiB(4 * GiB, 16384)).toBe(4096 + 1536 + 1024);
  expect(fitBadge(10_742_311_424, room)).toEqual({ kind: "alone", label: "Fits alone on RX 7600 XT" });
  expect(fitBadge(16_812_390_656, room)).toEqual({ kind: "pool", label: "Fits the pool" });
  expect(fitBadge(17.5 * GiB, room)?.label).toBe("Tight");
  expect(fitBadge(30 * GiB, room)).toEqual({ kind: "big", label: "Too big" });
  // Nothing checked yet: no badge rather than a guess.
  expect(fitBadge(1 * GiB, { devices: [], haveMiB: 0, uncounted: [], taking: 1, contextSize: 32768 })).toBeNull();
  // The hub's own room count wins when it has one.
  expect(poolRoom({ ...view, fit: { needMiB: 1, haveMiB: 30000, fits: true, note: null } }).haveMiB).toBe(30000);
  expect(fitTone({ needMiB: 10, haveMiB: 100, fits: true })).toBe("good");
  expect(fitTone({ needMiB: 95, haveMiB: 100, fits: true })).toBe("tight");
  expect(fitTone({ needMiB: 120, haveMiB: 100, fits: false })).toBe("over");
});

test("a PC's GPU can't be seen from here: files that need it say how much more it must add", () => {
  const rx = dev("AMD Radeon RX 7600 XT (RADV NAVI33)", 16304, 15832, "Vulkan0");
  // As the hub sends a PC after a check: its helper answers, its GPUs unknown.
  const pc: PoolMachineState = { id: "pc_games", devices: [], link: { ms: 41, direct: false }, state: "ready", detail: "Its helper answers at 100.88.12.40:50052.", checkedAt: 1 };
  const view = {
    config: { ...config([machine("self", false), machine("h_linux", true, { kind: "hub", name: "linux-box" }), machine("pc_games", true, { name: "gaming-pc" })]), contextSize: 32768 },
    machines: [state("self", []), state("h_linux", [rx]), pc],
    fit: { needMiB: 21154, haveMiB: 15832, fits: false, note: "Crosstalk can't see the GPU memory of gaming-pc, so it isn't counted here." },
  } as Pick<PoolView, "config" | "machines" | "fit">;
  expect(uncountedMachines(view).map((m) => m.name)).toEqual(["gaming-pc"]);
  const room = poolRoom(view);
  expect(room.uncounted).toEqual(["gaming-pc"]);
  expect(fitBadge(10_742_311_424, room)?.label).toBe("Fits alone on RX 7600 XT");
  expect(fitBadge(16_812_390_656, room)).toEqual({ kind: "more", label: "Needs 5.2 GB more" });
  // It may fit: the chosen model's bar says "Maybe", not "Too big".
  expect(fitTone(view.fit!, room.uncounted.length)).toBe("maybe");
  // No machine counted yet (the hub not checked): each file says what it needs.
  const unchecked = { ...view, machines: [state("self", []), pc], fit: null };
  expect(uncountedMachines(unchecked).map((m) => m.name)).toEqual(["linux-box", "gaming-pc"]);
  expect(fitBadge(16_812_390_656, poolRoom(unchecked))).toEqual({ kind: "more", label: "Needs 20.7 GB" });
  expect(namesText(["linux-box", "gaming-pc"])).toBe("linux-box and gaming-pc");
  expect(namesText(["a", "b", "c"])).toBe("a, b and c");
});

test("download progress says how much, how fast and how long", () => {
  expect(downloadText({ file: "m.gguf", doneBytes: 7.1 * GiB, totalBytes: 16.8 * GiB, bytesPerSec: 38 * 1024 ** 2 })).toBe("42% · 7.1 GB of 16.8 GB · 38 MB/s · about 4 min left");
  expect(downloadText({ file: "m.gguf", doneBytes: 0, totalBytes: 0, bytesPerSec: null })).toBe("1 KB");
  expect(downloadText({ file: "m.gguf", doneBytes: 1 * GiB, totalBytes: 2 * GiB, bytesPerSec: null })).toBe("50% · 1.0 GB of 2.0 GB");
  expect(timeLeftText(30)).toBe("under a minute left");
  expect(timeLeftText(2 * 3600 + 10 * 60)).toBe("about 2 h 10 min left");
  expect(timeLeftText(3600)).toBe("about 1 h left");
  expect(speedText({ prompt: 420.4, generation: 18.27 })).toBe("reads 420 tokens/s · writes 18.3 tokens/s");
  expect(speedText({ prompt: null, generation: null })).toBeNull();
  expect(speedText(null)).toBeNull();
});

test("context sizes read like the menu", () => {
  expect([16384, 32768, 65536, 131072, 262144].map(contextLabel)).toEqual(["16k", "32k", "64k", "128k", "256k"]);
  expect(contextLabel(1048576)).toBe("1M");
  expect(contextLabel(39936)).toBe("39k");
});

test("a problem's detail names what to do about it, in the hub's own words", () => {
  const kinds = (detail: string | null) => recoveriesFor(detail).map((r) => r.kind);
  // Phrases the hub uses (hub/src/pool/models.ts, llama.ts, node.ts).
  expect(kinds("Hugging Face won't let this download a/b yet: open huggingface.co/a/b, accept the model's terms, then save a Hugging Face token (from the same account) and try again.")).toEqual(["terms", "token"]);
  expect(kinds("Hugging Face didn't accept the saved token: make a new one on huggingface.co (Settings → Access Tokens) and save it.")).toEqual(["token"]);
  expect(kinds("Couldn't find a/b on Hugging Face: check the name. If it's private, save a Hugging Face token first.")).toEqual(["model", "token"]);
  expect(kinds("Not enough free space for a/b (Q4_K_M): it needs 12.3 GB more and 2.1 GB is free (keeping 2.0 GB free). Free up space or pick a smaller quant.")).toEqual(["storage", "model"]);
  expect(kinds("The GPUs ran out of memory for this model: pick a smaller quant or a smaller context, or add a machine, then start again.")).toEqual(["model"]);
  expect(kinds("llama.cpp couldn't load the model: download it again or pick another quant, then start again.")).toEqual(["model"]);
  expect(kinds("Port 9931 is already taken on this machine (or the address isn't this machine's): pick another port, then start again.")).toEqual(["port"]);
  // Only the model server's own port is the app's to change; a helper's is that machine's program to close.
  expect(recoveriesFor("linux-box: Port 9931 is already taken on this machine (or the address isn't this machine's): pick another port, then start again.", 9931).map((r) => r.kind)).toEqual(["port"]);
  expect(recoveriesFor("linux-box: The helper's port 50052 is already taken on this machine: close the program that uses it (an old helper window, say), then start again.", 9931)).toEqual([]);
  // Two helpers on one address: their ports aren't in the app (the server's port is), so no port fix.
  expect(kinds("gaming-pc and desktop have the same address and port (100.88.12.40:50052): give one of them another port, then start again.")).toEqual([]);
  // A PC's helper isn't running: its helper command is the fix, ahead of checking again.
  const helper = "The helper on gaming-pc doesn't answer at 100.88.12.40:50052. Run its helper command there (Helper command next to it), then start again.";
  expect(recoveriesFor(helper)).toEqual([{ kind: "command", label: "Show the helper command" }, { kind: "machines", label: "Check the machines" }]);
  expect(kinds("gaming-pc's helper command is for llama.cpp b11669, but the pool now uses b11887: run its new helper command there (Helper command), then start again.")).toEqual(["command", "machines"]);
  const pcs = [machine("pc_a", true, { name: "PC" }), machine("pc_b", true, { name: "PC 2" }), machine("h_box", true, { kind: "hub", name: "linux-box" })];
  expect(computerNamed("The helper on PC 2 doesn't answer at 100.64.0.9:50052. Run its helper command there.", pcs)?.id).toBe("pc_b");
  expect(computerNamed("linux-box doesn't answer: check that it's on.", pcs)).toBeNull();
  expect(computerNamed(null, pcs)).toBeNull();
  expect(kinds("Couldn't reach the helper at 100.64.0.3:50052: check that it's running and on Tailscale, then start again.")).toEqual(["machines"]);
  expect(kinds("Tailscale isn't running on this machine: open Tailscale and sign in, then start again.")).toEqual(["machines"]);
  expect(kinds("llama.cpp doesn't know one of the GPUs it was given: check the machines again, then start again.")).toEqual(["machines"]);
  // Nothing in the app fixes these: Try again is the way.
  expect(kinds("Couldn't reach Hugging Face (timeout): check this machine's internet connection, then try again.")).toEqual([]);
  expect(kinds("Vulkan isn't set up on this machine: install its GPU's Vulkan driver, then start again.")).toEqual([]);
  expect(kinds("The server stopped after 4096 tokens.")).toEqual([]);
  expect(kinds(null)).toEqual([]);
  expect(recoveriesFor("Gaming PC isn't answering: start its helper.")[0]).toEqual({ kind: "machines", label: "Check the machines" });
});

test("Tailscale addresses, peers' systems, names and ports", () => {
  expect(isTailscaleIPv4("100.101.102.103")).toBe(true);
  expect(isTailscaleIPv4(" 100.64.0.1 ")).toBe(true);
  expect(isTailscaleIPv4("100.128.0.1")).toBe(false);
  expect(isTailscaleIPv4("192.168.1.20")).toBe(false);
  expect(isTailscaleIPv4("100.64.0.256")).toBe(false);
  expect(isTailscaleIPv4("gaming-pc.tail1234.ts.net")).toBe(false);
  // The hub takes addresses written plainly.
  expect(isTailscaleIPv4("100.088.12.40")).toBe(false);
  expect(isTailscaleIPv4("100.88.12.0")).toBe(true);
  expect(peerOs("windows")).toBe("windows");
  expect(peerOs("linux")).toBe("linux");
  expect(peerOs("macOS")).toBe("macos");
  expect(peerOs("iOS")).toBeNull();
  expect(peerOs("android")).toBeNull();
  expect(aliasProblem("pool-model")).toBeNull();
  expect(aliasProblem("qwen3.8_27b:q4-k-m")).toBeNull();
  expect(aliasProblem("my model")).not.toBeNull();
  expect(aliasProblem("owner/model")).not.toBeNull();
  expect(aliasProblem("  ")).not.toBeNull();
  expect(portProblem("9931")).toBeNull();
  expect(portProblem("80")).not.toBeNull();
  expect(portProblem("70000")).not.toBeNull();
  expect(portProblem("")).not.toBeNull();
});

test("pool changes queue up, so two quick switches don't undo each other", async () => {
  let server = config([machine("self", false), machine("pc_a", false), machine("pc_b", false)]);
  const sent: Partial<PoolConfig>[] = [];
  const put = async (change: Partial<PoolConfig>) => {
    sent.push(change);
    await new Promise((r) => setTimeout(r, 5));
    server = { ...server, ...change };
    return { config: server } as PoolView;
  };
  // The screen's copy stays stale (as when events lag): each change must still start from the one before it.
  const stale = server;
  const write = poolWriter(put, () => stale);
  await Promise.all([
    write((c) => ({ machines: withMachine(c, "pc_a", { enabled: true }) })),
    write((c) => ({ machines: withMachine(c, "pc_b", { enabled: true }) })),
  ]);
  expect(server.machines.map((m) => m.enabled)).toEqual([false, true, true]);
  expect(sent).toHaveLength(2);
  // A failed change doesn't stop the next one.
  const failing = poolWriter(async () => {
    throw new Error("The hub said no");
  }, () => server);
  await expect(failing(() => ({ autostart: true }))).rejects.toThrow("The hub said no");
  await expect(write(() => ({ autostart: true }))).resolves.toBeTruthy();
  expect(server.autostart).toBe(true);
  // Nothing loaded yet: it says so instead of sending half a change.
  await expect(poolWriter(put, () => null)(() => ({ autostart: false }))).rejects.toThrow("hasn't loaded");
});

test("the Kimi preset fills in Moonshot's address for each agent", () => {
  expect(presetFields(KIMI_PRESET, "claude")).toEqual({ baseUrl: "https://api.moonshot.ai/anthropic", models: "kimi-k3.1-pro, kimi-k3.1-pro-highspeed", context: "1048576", label: "Kimi K3.1 Pro" });
  expect(presetFields(KIMI_PRESET, "codex")?.baseUrl).toBe("https://api.moonshot.ai");
  expect(presetFields(KIMI_PRESET, "gemini")).toBeNull();
  expect(KIMI_PRESET.title).toBe("Kimi K3.1 Pro (Moonshot API)");
  expect(KIMI_PRESET.help).toContain("about $2 per million tokens in and $10 out (Oct 2026)");
  expect(KIMI_PRESET.keyFrom.label).toBe("platform.kimi.ai");
});

test("a pool view missing parts (or with states this app doesn't know) still reads safely", async () => {
  const { normalizePool } = await import("./pool");
  const partial = normalizePool({ config: { machines: [machine("self", false)], mainId: "self" }, status: { state: "rebooting" }, machines: [{ id: "self", state: "dreaming" }] } as unknown as PoolView);
  expect(partial.status.state).toBe("off");
  expect(partial.status.log).toEqual([]);
  expect(partial.status.accounts).toEqual({});
  expect(partial.machines[0].state).toBe("unknown");
  expect(partial.machines[0].devices).toEqual([]);
  expect(partial.config.model).toBeNull();
  expect(partial.config.machines).toHaveLength(1);
  expect(partial.fit).toBeNull();
  expect(partial.hasHfToken).toBe(false);
  // A whole view comes through as it was.
  const whole: PoolView = { config: config([machine("self", true)]), machines: [state("self", [])], status: { state: "running", detail: "Running", download: null, endpoint: null, accounts: { claude: "pool" }, startedAt: 1, speed: null, log: ["ok"] }, fit: { needMiB: 1, haveMiB: 2, fits: true, note: null }, hasHfToken: true, mainFiles: [{ file: "a/b/c.gguf", bytes: 3, partial: false }] };
  expect(normalizePool(whole)).toEqual(whole);
  // The main machine's files: unknown from a hub older than the list.
  expect(partial.mainFiles).toBeNull();
});

test("the main machine's downloads: a split model's parts as one, unfinished ones said, biggest first", () => {
  const files = [
    { file: "acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", bytes: 300, partial: false },
    { file: "acme/Tiny-GGUF/BF16/Tiny-BF16-00001-of-00002.gguf", bytes: 400, partial: false },
    { file: "acme/Tiny-GGUF/BF16/Tiny-BF16-00002-of-00002.gguf", bytes: 350, partial: true },
    { file: "other/Big-GGUF/Big-Q8_0.gguf", bytes: 90, partial: true },
  ];
  const d = downloadsOf(files);
  expect(d.map((x) => [x.name, x.bytes, x.partial, x.files.length])).toEqual([
    ["Tiny-BF16.gguf", 750, true, 2],
    ["Tiny-Q4_K_M.gguf", 300, false, 1],
    ["Big-Q8_0.gguf", 90, true, 1],
  ]);
  expect(d[0].files).toEqual(["acme/Tiny-GGUF/BF16/Tiny-BF16-00001-of-00002.gguf", "acme/Tiny-GGUF/BF16/Tiny-BF16-00002-of-00002.gguf"]);
  const chosen = { repo: "acme/Tiny-GGUF", files: ["Tiny-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 300, gated: false };
  expect(d.map((x) => isChosenDownload(x, chosen))).toEqual([false, true, false]);
  expect(downloadsOf(null)).toEqual([]);
});
