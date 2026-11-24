// llama.cpp on this machine for Settings → Local models (hub/src/local/llama.ts): the builds in Crosstalk's own
// folder, the GPUs a llama-server lists (a fake one here), and why one stopped, in plain words.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/engine/engine";
import { explainExit, findInstall, gpuName, installedBuilds, listDevices, llamaDir, parseDevices } from "../src/local/llama";
import { installScript } from "./fixtures/local-fakes";

const work = realpathSync(mkdtempSync(join(tmpdir(), "ct-llama-")));

afterAll(() => {
  // The hub's home is shared by the test run: leave no builds for other tests to find.
  rmSync(llamaDir(), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

/** A build folder as Crosstalk's installs left them: the programs in a folder of their own, and a manifest naming llama-server. */
function build(id: string, manifest: unknown = { server: "bin/llama-server" }) {
  const dir = join(llamaDir(), id);
  mkdirSync(join(dir, "bin"), { recursive: true });
  installScript("fake-llama-server", join(dir, "bin", "llama-server"));
  if (manifest !== null) writeFileSync(join(dir, "crosstalk-install.json"), JSON.stringify(manifest));
  return dir;
}

describe("builds in Crosstalk's folder", () => {
  test("a complete build is found by its build and backend; the newest comes first", () => {
    const dir = build("b11669-metal");
    build("b12001-vulkan");
    expect(findInstall("b11669", "metal")).toEqual({ id: "b11669-metal", build: "b11669", backend: "metal", dir, server: join(dir, "bin", "llama-server") });
    expect(installedBuilds()).toEqual(["b12001-vulkan", "b11669-metal"]);
    expect(findInstall("b11669", "cuda")).toBeNull();
    expect(findInstall("../x", "metal")).toBeNull();
  });

  test("a folder without its manifest, or whose manifest points outside it or at nothing, isn't a build", () => {
    build("b11700-cpu", null);
    build("b11701-cpu", { server: "../b11669-metal/bin/llama-server" });
    build("b11702-cpu", { server: "bin/gone" });
    const linked = build("b11703-cpu", { server: "bin/link" });
    symlinkSync("/bin/sh", join(linked, "bin", "link"));
    for (const b of ["b11700", "b11701", "b11702", "b11703"]) expect(findInstall(b, "cpu")).toBeNull();
    expect(installedBuilds().filter((id) => id.endsWith("-cpu"))).toEqual([]);
  });
});

describe("devices", () => {
  test("parses --list-devices: real lines, (none), and devices without memory left out", () => {
    const real = [
      "Available devices:",
      "  MTL0: Apple M4 (12124 MiB, 12123 MiB free)",
      "  BLAS: Accelerate (0 MiB, 0 MiB free)",
      "  Vulkan0: AMD Radeon RX 7600 XT (RADV NAVI33) (16304 MiB, 15890 MiB free)",
      "load_backend: loaded Vulkan backend from /x/libggml-vulkan.so",
    ].join("\n");
    expect(parseDevices(real)).toEqual([
      { name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 },
      { name: "Vulkan0", description: "AMD Radeon RX 7600 XT (RADV NAVI33)", totalMiB: 16304, freeMiB: 15890 },
    ]);
    expect(parseDevices("Available devices:\n  (none)\n")).toEqual([]);
    expect(parseDevices("")).toEqual([]);
  });

  test("asks a llama-server for this machine's GPUs; one that can't say is said plainly", async () => {
    const server = installScript("fake-llama-server", join(work, "llama-server"));
    expect(await listDevices(server)).toEqual([{ name: "MTL0", description: "Apple M4", totalMiB: 12124, freeMiB: 12123 }]);
    const broken = join(work, "broken-server");
    writeFileSync(broken, "#!/bin/sh\necho 'error while loading shared libraries: libvulkan.so.1: cannot open shared object file' >&2\nexit 127\n");
    chmodSync(broken, 0o755);
    const e = (await listDevices(broken).catch((x) => x)) as HttpError;
    expect(e).toBeInstanceOf(HttpError);
    expect(e.message).toBe("Vulkan isn't set up on this machine: install its GPU's Vulkan driver, then check again.");
    const stuck = join(work, "stuck-server");
    writeFileSync(stuck, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(stuck, 0o755);
    expect(await listDevices(stuck, 200).catch((x) => x)).toMatchObject({ status: 504, code: "timeout" });
  });

  test("a GPU's short name", () => {
    expect(gpuName("AMD Radeon RX 7600 XT (RADV NAVI33)")).toBe("RX 7600 XT");
    expect(gpuName("NVIDIA GeForce RTX 3060")).toBe("RTX 3060");
    expect(gpuName("NVIDIA GeForce RTX 4070 SUPER")).toBe("RTX 4070 Super");
    expect(gpuName("Apple M4")).toBe("Apple M4");
    expect(gpuName("AMD Radeon Graphics (RADV RAPHAEL_MENDOCINO)")).toBe("AMD Radeon Graphics");
  });
});

describe("why llama-server stopped", () => {
  test("its last lines become plain words with what to do", () => {
    expect(explainExit("server", ["0.00.100.000 E srv start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8080"], 1, null, { port: 8080 })).toBe("Port 8080 is already taken on this machine: pick another port, then start again.");
    expect(explainExit("server", ["ggml_vulkan: Device memory allocation of size 123 failed.", "vk::Device::allocateMemory: ErrorOutOfDeviceMemory"], null, "SIGABRT")).toBe(
      "The GPUs ran out of memory for this model: pick a smaller quant or a smaller context, then start again.",
    );
    expect(explainExit("server", ["E llama_model_load: error loading model: failed to load model from /x.gguf"], 1, null)).toBe("llama.cpp couldn't load the model: download it again or pick another quant, then start again.");
    expect(explainExit("server", ["dyld: Library not loaded: @rpath/libllama.dylib"], 6, null)).toBe("llama.cpp is missing one of its files on this machine: install it again, then start again.");
  });

  test("nothing it knows: how it ended and the last line that reads like an error, never a backtrace frame", () => {
    const lines = ["0.00.200.000 I srv  llama_server: initializing ...", "0.00.300.000 E something went wrong inside", "0   libggml-base.0.27.0.dylib           0x00000001053013f0 ggml_print_backtrace + 276", ""];
    expect(explainExit("server", lines, 3, null)).toBe("The model server stopped unexpectedly (exit code 3): something went wrong inside. Start it again; if it keeps happening, look at its log.");
    expect(explainExit("server", [], null, "SIGKILL")).toBe("The model server stopped unexpectedly (it was killed, perhaps because the machine ran low on memory). Start it again; if it keeps happening, look at its log.");
    expect(explainExit("devices", [], null, "SIGSEGV")).toBe("llama.cpp stopped unexpectedly (it crashed). Check again; if it keeps happening, look at its log.");
  });
});
