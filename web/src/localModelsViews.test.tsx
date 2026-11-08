import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalDownload, LocalLibrary, LocalStarted } from "@crosstalk/shared";
import type { LibraryActions } from "./views/LocalModelsLibrary";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { DownloadBar, TokenField } = await import("./views/LocalModelsGet");
const { ModelsHere, StartServers } = await import("./views/LocalModelsLibrary");

// Settings → Local models below the servers, drawn without a browser: what each part says and offers (the dialogs and the
// clicks are in web/e2e/localModelsGet.spec.ts).

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const library = (over: Partial<LocalLibrary> = {}): LocalLibrary => ({
  machine: { ramBytes: 16 * GiB, unified: true, gpuBytes: 12124 * MiB, gpuFrom: "llama.cpp", gpus: [] },
  folder: { path: "/Users/me/.crosstalk/models", shown: "~/.crosstalk/models", isDefault: true, drive: null, freeBytes: 120 * GiB, totalBytes: 460 * GiB, problem: null },
  files: [],
  downloads: [],
  programs: [{ kind: "ollama", path: "/opt/homebrew/bin/ollama", from: "Homebrew" }, { kind: "llamacpp", path: "/opt/homebrew/bin/llama-server", from: "the model pool's llama.cpp b11669" }],
  started: [],
  hasHfToken: false,
  reserveBytes: 2 * GiB,
  ports: { ollama: 11434, llamacpp: 8080 },
  ...over,
});
const actions = (over: Partial<LibraryActions> = {}): LibraryActions => ({ send: async () => true, busy: null, problems: {}, clear: () => {}, ...over });
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const draw = (el: Parameters<typeof renderToStaticMarkup>[0]) => decode(renderToStaticMarkup(el));
const QWEN = { id: "unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf", repo: "unsloth/Qwen3-8B-GGUF", files: ["Qwen3-8B-Q4_K_M.gguf"], quant: "Q4_K_M", bytes: 5 * GiB, kvBytesPerToken: 73728, contextLength: 131072 };

test("Start a server: where each program came from, Start for what's installed, and LM Studio's own app", () => {
  const html = draw(createElement(StartServers, { library: library({ files: [QWEN] }), shownPorts: [], actions: actions(), onStart: () => {} }));
  expect(html).toContain('aria-label="Start a server"');
  expect(html).toContain("From Homebrew. Pulls models from its library.");
  expect(html).toContain("From the model pool's llama.cpp b11669. Serves one downloaded model.");
  expect(html).toContain('aria-label="Start Ollama"');
  expect(html).toContain('aria-label="Start llama.cpp"');
  expect(html).toContain("LM Studio is managed in LM Studio: start it there, then press Rescan.");
  // No model yet: llama.cpp says to get one, and has no Start.
  const none = draw(createElement(StartServers, { library: library(), shownPorts: [], actions: actions(), onStart: () => {} }));
  expect(none).toContain("Get a model below first: it serves one downloaded model.");
  expect(none).not.toContain('aria-label="Start llama.cpp"');
  // Nothing installed: where to get each.
  const bare = draw(createElement(StartServers, { library: library({ programs: [] }), shownPorts: [], actions: actions(), onStart: () => {} }));
  expect(bare).toContain("Not installed here. Get it at ollama.com/download, then press Rescan.");
  expect(bare).toContain("brew install llama.cpp");
  expect(bare).not.toContain('aria-label="Start Ollama"');
  expect(bare).not.toContain('aria-label="Start llama.cpp"');
});

test("servers Crosstalk started: one starting has Stop, one that stopped says why with its log, Try again and Dismiss; a running one with a card isn't repeated", () => {
  const s = (over: Partial<LocalStarted>): LocalStarted => ({ id: "llamacpp-8080", kind: "llamacpp", port: 8080, baseUrl: "http://127.0.0.1:8080", model: QWEN.id, context: 32768, state: "starting", detail: "Loading the model…", log: "~/.crosstalk/run/local-servers/llamacpp-8080/server.log", startedAt: 1, ...over });
  const starting = draw(createElement(StartServers, { library: library({ started: [s({})] }), shownPorts: [], actions: actions(), onStart: () => {} }));
  expect(starting).toContain('aria-label="llama.cpp on port 8080"');
  expect(starting).toContain("Loading the model…");
  expect(starting).toContain("Qwen3-8B-Q4_K_M.gguf");
  expect(starting).toMatch(/<button[^>]*>Stop<\/button>/);
  const failed = draw(createElement(StartServers, { library: library({ started: [s({ state: "failed", detail: "llama.cpp couldn't load the model: download it again or pick another quant, then start again." })] }), shownPorts: [], actions: actions(), onStart: () => {} }));
  expect(failed).toContain("llama.cpp couldn't load the model");
  expect(failed).toContain("Its log: ~/.crosstalk/run/local-servers/llamacpp-8080/server.log");
  expect(failed).toContain(">Try again</button>");
  expect(failed).toContain(">Dismiss</button>");
  expect(failed).toContain('role="group"');
  const shown = draw(createElement(StartServers, { library: library({ started: [s({ state: "running", detail: null })] }), shownPorts: [8080], actions: actions(), onStart: () => {} }));
  expect(shown).not.toContain("llama.cpp on port 8080");
  // Its stop that failed says so.
  const refused = draw(createElement(StartServers, { library: library({ started: [s({})] }), shownPorts: [], actions: actions({ problems: { "stop:llamacpp-8080": { text: "Crosstalk didn't start that server, so it leaves it alone. Press Rescan to see what runs.", code: null } } }), onStart: () => {} }));
  expect(refused).toContain('role="alert"');
  expect(refused).toContain("Crosstalk didn't start that server");
});

test("the models here: the folder, a download with its bar, a stopped one with Resume and Remove, a failed one with its way out, and each model's fit", () => {
  const d = (over: Partial<LocalDownload>): LocalDownload => ({ id: "hf:a/b/c.gguf", source: "huggingface", name: "Qwen3-8B Q6_K", model: { repo: "a/b", files: ["c.gguf"], quant: "Q6_K", sizeBytes: 6 * GiB, gated: false }, ollama: null, state: "downloading", doneBytes: 3 * GiB, totalBytes: 6 * GiB, bytesPerSec: 30 * MiB, error: null, code: null, step: null, updatedAt: 1, ...over });
  const html = draw(
    createElement(ModelsHere, {
      library: library({ files: [QWEN], downloads: [d({}), d({ id: "hf:x", name: "Stopped one", state: "stopped", bytesPerSec: null }), d({ id: "hf:y", name: "Full disk", state: "failed", error: "The disk is almost full (keeping 2.0 GB free): free up space, then start the download again (it picks up where it stopped).", code: "low_disk" })] }),
      machine: "Mac mini",
      actions: actions(),
      onGet: () => {},
      onFolder: () => {},
      onStart: () => {},
    }),
  );
  expect(html).toContain('aria-label="Models on Mac mini"');
  expect(html).toContain("~/.crosstalk/models · 120 GB free");
  expect(html).toContain(">Get a model</button>");
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuetext="50% · 3.0 GB of 6.0 GB · 30 MB/s · about 2 min left"');
  expect(html).toContain('aria-label="Stop the download of Qwen3-8B Q6_K"');
  expect(html).toContain('aria-label="Resume: Stopped one"');
  expect(html).toContain('aria-label="Remove the download of Stopped one"');
  // The failed one: its words, Try again, and the folder as the way out.
  expect(html).toContain("The disk is almost full");
  expect(html).toContain('aria-label="Try again: Full disk"');
  expect(html).toContain(">Change folder</button>");
  // The model here: its fit at 32k, Start in llama.cpp and Remove.
  expect(html).toContain('aria-label="Qwen3-8B · Q4_K_M"');
  expect(html).toContain("5.0 GB · at 32k context");
  expect(html).toContain("Fits on Mac mini: needs about 8.3 GB of the 11.8 GB models can use.");
  expect(html).toContain('aria-label="Start Qwen3-8B · Q4_K_M in llama.cpp"');
  expect(html).toContain('aria-label="Remove Qwen3-8B · Q4_K_M"');
  // Empty: what to do.
  const empty = draw(createElement(ModelsHere, { library: library(), machine: "Mac mini", actions: actions(), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(empty).toContain("No models downloaded here yet. Get one from Hugging Face, then start it in llama.cpp.");
  // A drive that isn't plugged in says so.
  const unplugged = draw(createElement(ModelsHere, { library: library({ folder: { path: "/Volumes/Untitled/models", shown: "/Volumes/Untitled/models", isDefault: false, drive: "Untitled", freeBytes: null, totalBytes: null, problem: "The drive Untitled isn't plugged in: plug it in, or change the folder." } }), machine: "Mac mini", actions: actions(), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(unplugged).toContain("/Volumes/Untitled/models (on Untitled)");
  expect(unplugged).toContain('role="alert"');
  expect(unplugged).toContain("The drive Untitled isn't plugged in");
  // A model a server Crosstalk started serves: Running, and it can't be removed or started again.
  const serving = draw(createElement(ModelsHere, { library: library({ files: [QWEN], started: [{ id: "llamacpp-8080", kind: "llamacpp", port: 8080, baseUrl: "http://127.0.0.1:8080", model: QWEN.id, context: 32768, state: "running", detail: null, log: "", startedAt: 1 }] }), machine: "Mac mini", actions: actions(), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(serving).toContain(">Running</span>");
  expect(serving).not.toContain("in llama.cpp\"");
  expect(serving).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove Qwen3-8B · Q4_K_M"/);
});

test("the pill is about the machine as it is: what the heavy things hold comes off the top, as the hub counts it", () => {
  const files = library({ files: [QWEN] });
  // Nothing else running: a 5 GB model on a 16 GB Mac fits, and the pill is the same as it always was.
  const idle = draw(createElement(ModelsHere, { library: files, machine: "Mac mini", actions: actions(), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(idle).toContain(">Fits</span>");
  expect(idle).toContain("Fits on Mac mini: needs about 8.3 GB of the 11.8 GB models can use.");
  // The image editor holding 12.5 GB: the hub would answer 409 "nothing is free" on tapping Start, so the pill has to
  // say so first. A green Fits followed by a refusal is the phone and the hub giving two answers.
  const busy = draw(createElement(ModelsHere, { library: files, machine: "Mac mini", taken: Math.round(12.5 * GiB), actions: actions(), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(busy).toContain(">Too big</span>");
  expect(busy).toContain("none of the 11.8 GB models can use is free");
  expect(busy).not.toContain(">Fits</span>");
  // And in between, the pill is honest about it being close, and the sentence says how much is left.
  const some = draw(createElement(ModelsHere, { library: files, machine: "Mac mini", taken: 3 * GiB, actions: actions(), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(some).toContain(">Tight</span>");
  expect(some).toContain("needs about 8.3 GB, and 8.8 GB of the 11.8 GB models can use is free");
});

test("a download's bar says Ollama's steps in plain words; a failed one has no bar", () => {
  const ollama: LocalDownload = { id: "ollama:o:qwen3:8b", source: "ollama", name: "qwen3:8b", model: null, ollama: { model: "qwen3:8b", serverId: "o" }, state: "downloading", doneBytes: 0, totalBytes: 0, bytesPerSec: null, error: null, code: null, step: "pulling manifest", updatedAt: 1 };
  const running = draw(createElement(DownloadBar, { d: ollama }));
  expect(running).toContain('aria-valuetext="Looking it up…"');
  // The line moves every second: it isn't read out as it does, and the state line has nothing to say yet.
  expect(running).not.toMatch(/class="local-download-line"[^>]*aria-live/);
  expect(running).toContain('<span class="local-sr" aria-live="polite"></span>');
  const failed = draw(createElement(DownloadBar, { d: { ...ollama, state: "failed", error: "Ollama's library has no qwen3:8b: check the name at ollama.com/library, then try again." } }));
  expect(failed).not.toContain('role="progressbar"');
  expect(failed).toContain("Ollama's library has no qwen3:8b");
  // A change of state is said once: where it stopped, or what went wrong.
  expect(failed).toContain('<span class="local-sr" aria-live="polite">qwen3:8b: Ollama\'s library has no qwen3:8b');
  expect(draw(createElement(DownloadBar, { d: { ...ollama, state: "stopped", totalBytes: 0 } }))).toContain('<span class="local-sr" aria-live="polite">qwen3:8b: Stopped</span>');
  // An Ollama whose disk can't be watched: said under the bar while it runs.
  const note = "Crosstalk can't see which disk this Ollama keeps its models on, so it won't stop the pull before that disk is full: keep some room free there.";
  expect(draw(createElement(DownloadBar, { d: { ...ollama, note } }))).toContain(`<p class="help local-download-note">${note}</p>`);
  expect(draw(createElement(DownloadBar, { d: { ...ollama, state: "stopped", note } }))).not.toContain("local-download-note");
});

test("a model or download on a drive whose Trash can't be used offers Delete for good, which asks first", () => {
  const stopped: LocalDownload = { id: "hf:a/b/c.gguf", source: "huggingface", name: "Qwen3-8B Q6_K", model: { repo: "a/b", files: ["c.gguf"], quant: "Q6_K", sizeBytes: 6 * GiB, gated: false }, ollama: null, state: "stopped", doneBytes: 3 * GiB, totalBytes: 6 * GiB, bytesPerSec: null, error: null, code: null, step: null, updatedAt: 1 };
  const said = { text: "Qwen3-8B-Q4_K_M.gguf is on another drive, and Crosstalk can't use that drive's Trash: delete it for good instead, or delete it in the Finder.", code: "no_trash" };
  const html = draw(createElement(ModelsHere, { library: library({ files: [QWEN], downloads: [stopped] }), machine: "Mac mini", actions: actions({ problems: { [`file:${QWEN.id}`]: said, "dl:hf:a/b/c.gguf": said } }), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(html).toContain('aria-label="Delete Qwen3-8B · Q4_K_M for good"');
  expect(html).toContain('aria-label="Delete Qwen3-8B Q6_K for good"');
  expect(html).not.toContain('aria-label="Remove Qwen3-8B · Q4_K_M"');
  expect(html).not.toContain('aria-label="Remove the download of Qwen3-8B Q6_K"');
  expect(html).toContain("can't use that drive's Trash");
  // Anything else keeps Remove (to the Trash).
  const other = draw(createElement(ModelsHere, { library: library({ files: [QWEN] }), machine: "Mac mini", actions: actions({ problems: { [`file:${QWEN.id}`]: { text: "A llama.cpp server Crosstalk started is using this model: stop it first.", code: "in_use" } } }), onGet: () => {}, onFolder: () => {}, onStart: () => {} }));
  expect(other).toContain('aria-label="Remove Qwen3-8B · Q4_K_M"');
  expect(other).not.toContain("for good");
});

test("Start a server says when an Ollama already runs here: pull into that one", () => {
  const html = draw(createElement(StartServers, { library: library(), shownPorts: [11434], ollamaPorts: [11434], actions: actions(), onStart: () => {} }));
  expect(html).toContain("Ollama runs on port 11434: pull models into that one with Get a model.");
  expect(html).not.toContain("Pulls models from its library.");
});

test("the token field: a password field until one is saved, then only Replace and Remove; it never shows the token", () => {
  const empty = draw(createElement(TokenField, { has: false, repo: "orcarouter/Gated-GGUF", onSaved: () => {} }));
  expect(empty).toContain('type="password"');
  expect(empty).toContain('aria-label="Hugging Face token"');
  expect(empty).toContain('href="https://huggingface.co/orcarouter/Gated-GGUF"');
  expect(empty).toContain("The Model pool uses the same one.");
  const saved = draw(createElement(TokenField, { has: true, repo: null, onSaved: () => {} }));
  expect(saved).toContain(">Saved</span>");
  expect(saved).toContain(">Replace token</button>");
  expect(saved).toContain(">Remove token</button>");
  expect(saved).not.toContain('type="password"');
});
