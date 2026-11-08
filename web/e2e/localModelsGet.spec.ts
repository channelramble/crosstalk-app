import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { LocalDownload, LocalLibrary, LocalModelFile, LocalModelServer, LocalOllamaInfo, LocalRepoFiles, LocalSearchHit, LocalStarted, PoolModel } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Settings → Local models: getting a model (Hugging Face or Ollama's library, each file with whether it fits this machine),
// the downloads folder, and starting and stopping servers (hub/src/localLibrary.ts, localRunners.ts), with the hub's answers
// played here: nothing is downloaded, no server is started or stopped, and the shared test hub's settings stay as they were.
// CT_SHOTS: a folder to save the 390 px screens in (Chromium 390 only), to look at them.

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;
const protocols = { responses: "yes", messages: "no", chat: "yes" } as const;
const TOKEN = "hf_browserTestToken123456";

/** Qwen3 8B's files, in GiB, with a shape of 72 KiB a token: at 32k Q6_K fits a 16 GB Mac (Metal's 11.8 GB), Q8_0 is tight and F16 too big. */
const QWEN: LocalRepoFiles = {
  repo: "unsloth/Qwen3-8B-GGUF",
  gated: false,
  kvBytesPerToken: 73728,
  contextLength: 131072,
  models: (
    [
      ["Q2_K", 3],
      ["Q4_K_M", 5],
      ["Q6_K", 6.5],
      ["Q8_0", 8.5],
      ["F16", 16],
    ] as const
  ).map(([quant, gb]) => ({ repo: "unsloth/Qwen3-8B-GGUF", files: [`Qwen3-8B-${quant}.gguf`], quant, sizeBytes: gb * GiB, gated: false })),
};
const GATED: LocalRepoFiles = { repo: "orcarouter/Qwen3.8-27B-GGUF", gated: true, kvBytesPerToken: null, contextLength: null, models: [{ repo: "orcarouter/Qwen3.8-27B-GGUF", files: ["Qwen3.8-27B-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 3 * GiB, gated: true }] };
const HITS: LocalSearchHit[] = [
  { repo: "unsloth/Qwen3-8B-GGUF", downloads: 45_600, gated: false, params: 8_190_000_000, contextLength: 40960 },
  { repo: "orcarouter/Qwen3.8-27B-GGUF", downloads: 830, gated: true, params: 27_000_000_000, contextLength: null },
];

const library = (over: Partial<LocalLibrary> = {}): LocalLibrary => ({
  machine: { ramBytes: 16 * GiB, unified: true, gpuBytes: 12124 * MiB, gpuFrom: "llama.cpp", gpus: [{ name: "Apple M4", totalBytes: 12124 * MiB, freeBytes: 12123 * MiB }] },
  folder: { path: "/Users/me/.crosstalk/models", shown: "~/.crosstalk/models", isDefault: true, drive: null, freeBytes: 120 * GiB, totalBytes: 460 * GiB, problem: null },
  files: [],
  downloads: [],
  programs: [
    { kind: "ollama", path: "/opt/homebrew/bin/ollama", from: "Homebrew" },
    { kind: "llamacpp", path: "/opt/homebrew/bin/llama-server", from: "Homebrew" },
  ],
  started: [],
  hasHfToken: false,
  reserveBytes: 2 * GiB,
  ports: { ollama: 11434, llamacpp: 8080 },
  ...over,
});
const fileOf = (m: PoolModel): LocalModelFile => ({ id: `${m.repo}/${m.files[0]}`, repo: m.repo, files: m.files, quant: m.quant, bytes: m.sizeBytes, kvBytesPerToken: 73728, contextLength: 131072 });
const OLLAMA_SERVER = (over: Partial<LocalModelServer> = {}): LocalModelServer => ({
  id: "ollama-11434", kind: "ollama", label: "Ollama (port 11434)", baseUrl: "http://127.0.0.1:11434", protocols, accountIds: [], processBytes: 0.4 * GiB, memoryBytes: 0.4 * GiB,
  models: [], startedId: null, stopWhy: "Crosstalk didn't start this Ollama, so it leaves it alone: quit it from its menu bar icon, or where it was started.", ...over,
});
const LM_STUDIO: LocalModelServer = {
  id: "lmstudio-1234", kind: "lmstudio", label: "LM Studio (port 1234)", baseUrl: "http://127.0.0.1:1234", protocols, accountIds: [], processBytes: 5 * GiB, memoryBytes: 5 * GiB,
  models: [{ id: "qwen2.5-coder-7b", loaded: true, loading: false, contextWindow: null, sizeBytes: null, memoryBytes: null, vramBytes: null, expiresAt: null, canSwitch: false, why: "LM Studio is switched in its own app." }],
  startedId: null, stopWhy: "LM Studio is managed in LM Studio: start and stop it there.",
};

type Fail = { status: number; error: string; code?: string };

/** The hub's side of Local models: what the app sent is recorded; change the state to change what the hub says. */
async function hub(page: Page, init: { library?: LocalLibrary | number; servers?: LocalModelServer[] } = {}) {
  const state = {
    library: init.library ?? library(),
    servers: init.servers ?? ([] as LocalModelServer[]),
    repos: { [QWEN.repo]: QWEN, [GATED.repo]: GATED } as Record<string, LocalRepoFiles>,
    ollama: { "qwen3:8b": { model: "qwen3:8b", sizeBytes: 4.9 * GiB, quant: "Q4_K_M", params: "8.2B" } } as Record<string, LocalOllamaInfo>,
    /** Every request that changed something, in order. */
    sent: [] as { method: string; path: string; body: unknown }[],
    searches: [] as string[],
    /** The next request to this path fails with this. */
    fail: {} as Record<string, Fail>,
  };
  const lib = () => state.library as LocalLibrary;
  const answer = (path: string, ok: () => unknown) => (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    const body = route.request().method() === "GET" ? null : route.request().postDataJSON();
    if (route.request().method() !== "GET") state.sent.push({ method: route.request().method(), path, body });
    const f = state.fail[path];
    if (f) {
      delete state.fail[path];
      return route.fulfill({ status: f.status, json: { error: f.error, ...(f.code ? { code: f.code } : {}) } });
    }
    return route.fulfill({ json: ok() });
  };
  const body = <T>(route: Parameters<Parameters<Page["route"]>[1]>[0]) => route.request().postDataJSON() as T;
  await page.route(home("/api/local-models"), (route) => route.fulfill({ json: { servers: state.servers, scannedAt: Date.now() } }));
  await page.route(home("/api/local-models/library"), (route) => {
    const f = state.fail["/api/local-models/library"];
    if (f) {
      delete state.fail["/api/local-models/library"];
      return route.fulfill({ status: f.status, json: { error: f.error } });
    }
    return typeof state.library === "number" ? route.fulfill({ status: state.library, json: { error: "not found" } }) : route.fulfill({ json: state.library });
  });
  await page.route(home("/api/local-models/search"), (route) => {
    state.searches.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return answer("/api/local-models/search", () => HITS)(route);
  });
  await page.route(home("/api/local-models/files"), (route) => {
    const repo = new URL(route.request().url()).searchParams.get("repo")!;
    const found = state.repos[repo];
    return found ? route.fulfill({ json: found }) : route.fulfill({ status: 404, json: { error: `Couldn't find ${repo} on Hugging Face: check the name. If it's private, save a Hugging Face token first.` } });
  });
  await page.route(home("/api/local-models/ollama"), (route) => {
    const model = new URL(route.request().url()).searchParams.get("model")!;
    const found = state.ollama[model];
    return found ? route.fulfill({ json: found }) : route.fulfill({ status: 404, json: { error: "Ollama gets that one from Hugging Face: its size shows once the pull starts." } });
  });
  await page.route(home("/api/local-models/downloads"), (route) =>
    answer("/api/local-models/downloads", () => {
      const b = body<{ source: "huggingface"; model: PoolModel } | { source: "ollama"; serverId: string; model: string }>(route);
      const l = lib();
      const id = b.source === "huggingface" ? `hf:${b.model.repo}/${b.model.files[0]}` : `ollama:${b.serverId}:${b.model}`;
      const had = l.downloads.find((d) => d.id === id);
      const d: LocalDownload =
        b.source === "huggingface"
          ? { id, source: "huggingface", name: `${b.model.repo.split("/")[1].replace(/-GGUF$/, "")} ${b.model.quant}`, model: b.model, ollama: null, state: "downloading", doneBytes: had?.doneBytes ?? 0, totalBytes: b.model.sizeBytes, bytesPerSec: 25 * MiB, error: null, code: null, step: null, updatedAt: Date.now() }
          : { id, source: "ollama", name: b.model, model: null, ollama: { model: b.model, serverId: b.serverId }, state: "downloading", doneBytes: 0, totalBytes: 0, bytesPerSec: null, error: null, code: null, step: "pulling manifest", updatedAt: Date.now() };
      l.downloads = [d, ...l.downloads.filter((x) => x.id !== id)];
      return l;
    })(route),
  );
  await page.route(home("/api/local-models/downloads/stop"), (route) =>
    answer("/api/local-models/downloads/stop", () => {
      const l = lib();
      l.downloads = l.downloads.map((d) => (d.id === body<{ id: string }>(route).id ? { ...d, state: "stopped", bytesPerSec: null } : d));
      return l;
    })(route),
  );
  await page.route(home("/api/local-models/downloads/remove"), (route) =>
    answer("/api/local-models/downloads/remove", () => {
      const l = lib();
      l.downloads = l.downloads.filter((d) => d.id !== body<{ id: string }>(route).id);
      return l;
    })(route),
  );
  await page.route(home("/api/local-models/files/remove"), (route) =>
    answer("/api/local-models/files/remove", () => {
      const l = lib();
      l.files = l.files.filter((f) => f.id !== body<{ id: string }>(route).id);
      return l;
    })(route),
  );
  await page.route(home("/api/local-models/start"), (route) =>
    answer("/api/local-models/start", () => {
      const b = body<{ kind: "ollama" | "llamacpp"; port: number; model?: string; context?: number }>(route);
      const l = lib();
      const s: LocalStarted = { id: `${b.kind}-${b.port}`, kind: b.kind, port: b.port, baseUrl: `http://127.0.0.1:${b.port}`, model: b.model ?? null, context: b.context ?? null, state: "starting", detail: b.kind === "llamacpp" ? "Loading the model…" : "Starting…", log: `~/.crosstalk/run/local-servers/${b.kind}-${b.port}/server.log`, startedAt: Date.now() };
      l.started = [...l.started.filter((x) => x.id !== s.id), s];
      return l;
    })(route),
  );
  await page.route(home("/api/local-models/stop"), (route) =>
    answer("/api/local-models/stop", () => {
      const id = body<{ id: string }>(route).id;
      const l = lib();
      l.started = l.started.filter((x) => x.id !== id);
      state.servers = state.servers.filter((s) => s.startedId !== id);
      return l;
    })(route),
  );
  await page.route(home("/api/local-models/folder"), (route) =>
    answer("/api/local-models/folder", () => {
      const path = body<{ path: string | null }>(route).path;
      const l = lib();
      l.folder = path ? { path, shown: path, isDefault: false, drive: path.startsWith("/Volumes/") ? path.split("/")[2] : null, freeBytes: 900 * GiB, totalBytes: 1000 * GiB, problem: null } : library().folder;
      return l.folder;
    })(route),
  );
  await page.route(home("/api/pool/hf-token"), (route) =>
    answer("/api/pool/hf-token", () => {
      lib().hasHfToken = !!body<{ token: string | null }>(route).token;
      return { hasHfToken: lib().hasHfToken };
    })(route),
  );
  /** A download moves on (and the next look shows it). */
  const progress = (id: string, doneBytes: number) => {
    lib().downloads = lib().downloads.map((d) => (d.id === id ? { ...d, doneBytes } : d));
  };
  /** A Hugging Face download finishes: it's a model in the folder now. */
  const finish = (id: string) => {
    const d = lib().downloads.find((x) => x.id === id)!;
    lib().downloads = lib().downloads.filter((x) => x.id !== id);
    if (d.model) lib().files = [fileOf(d.model), ...lib().files];
  };
  return { state, progress, finish, lib };
}

const settings = async (page: Page, width = 390) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/#/settings/local-models");
  await expect(page.getByRole("heading", { name: "Local models", exact: true })).toBeVisible();
};
const modelsCard = (page: Page) => page.getByRole("region", { name: /^Models on / });
const startCard = (page: Page) => page.getByRole("region", { name: "Start a server", exact: true });
const getDialog = (page: Page) => page.getByRole("dialog", { name: "Get a model", exact: true });
const fileRow = (dialog: Locator, quant: string) => dialog.getByRole("list", { name: "Files" }).getByRole("listitem").filter({ has: dialog.page().locator(".local-file-title", { hasText: new RegExp(`^${quant}$`) }) });
const openGet = async (page: Page) => {
  await modelsCard(page).getByRole("button", { name: "Get a model", exact: true }).click();
  await expect(getDialog(page)).toBeVisible();
  return getDialog(page);
};
const openQwen = async (dialog: Locator) => {
  await dialog.getByLabel("Search Hugging Face, or paste a link").fill("qwen3");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await dialog.getByRole("list", { name: "Models found" }).getByRole("button", { name: /^Qwen3-8B by unsloth/ }).click();
  await expect(dialog.getByRole("list", { name: "Files" })).toBeVisible();
};

/** A two-step button's second tap counts only after a moment (a quick double tap isn't two). */
const pastDoubleTap = (page: Page) => page.waitForTimeout(450);

/** Saves the phone screen (390 px Chromium only) with the element at the top. */
async function shot(page: Page, name: string, target?: Locator) {
  const dir = process.env.CT_SHOTS;
  if (!dir || test.info().project.name !== "chromium-390") return;
  if (target) await target.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: join(dir, name), animations: "disabled" });
}

test("Get a model: search, a repo's files with their size, quant and whether each fits, the one to pick, and a download that stops and picks up", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await expect(modelsCard(page).getByText("No models downloaded here yet. Get one from Hugging Face, then start it in llama.cpp.", { exact: true })).toBeVisible();
  await expect(modelsCard(page).locator(".local-folder-path")).toHaveText("~/.crosstalk/models · 120 GB free");
  const dialog = await openGet(page);
  await expect(dialog.locator(".local-get-machine")).toContainText(/has 16\.0 GB of memory, shared with its GPU: models can use 11\.8 GB of it\./);
  await dialog.getByLabel("Search Hugging Face, or paste a link").fill("qwen3");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  const results = dialog.getByRole("list", { name: "Models found" });
  await expect(results.getByRole("listitem")).toHaveCount(2);
  await expect(results.getByRole("listitem").first()).toContainText("by unsloth · 8.2B · 46k downloads");
  await expect(results.getByRole("listitem").nth(1)).toContainText("Gated");
  expect(h.state.searches).toEqual(["qwen3"]);
  await noHorizontalOverflow(page);
  await shot(page, "20-search.png");

  // Each result is a button in its list item, announced as something to press.
  await expect(results.getByRole("listitem").first().getByRole("button")).toHaveCount(1);
  await results.getByRole("button", { name: /^Qwen3-8B by unsloth · 8\.2B · 46k downloads$/ }).click();
  // At 32k: Q6_K is the biggest that fits well (and is suggested), Q8_0 is tight, F16 is too big; Q2_K says it's less accurate.
  await expect(fileRow(dialog, "Q6_K").locator(".pill")).toHaveText(["Fits", "Suggested"]);
  await expect(fileRow(dialog, "Q4_K_M").locator(".pill")).toHaveText(["Fits"]);
  await expect(fileRow(dialog, "Q4_K_M").locator(".local-fit-line")).toHaveText(/^Fits on .+: needs about 8\.3 GB of the 11\.8 GB models can use\.$/);
  await expect(fileRow(dialog, "Q8_0").locator(".pill")).toHaveText(["Tight"]);
  await expect(fileRow(dialog, "F16").locator(".pill")).toHaveText(["Too big"]);
  await expect(fileRow(dialog, "F16").locator(".local-fit-line")).toHaveText(/^Too big for .+: needs about 19\.3 GB of the 11\.8 GB models can use\. Pick a smaller file or context\.$/);
  await expect(fileRow(dialog, "Q2_K")).toContainText("3.0 GB · smaller, and noticeably less accurate");
  await expect(dialog).toContainText("At 32k context it needs the file plus about 2.3 GB for the chat.");
  await noHorizontalOverflow(page);
  await shot(page, "21-files-fit.png");

  // More context takes more memory: at 64k only the smallest fits, and that's the suggestion.
  await dialog.getByRole("radiogroup", { name: "Context" }).getByRole("radio", { name: "64k" }).click();
  await expect(fileRow(dialog, "Q4_K_M").locator(".pill")).toHaveText(["Tight"]);
  await expect(fileRow(dialog, "Q6_K").locator(".pill")).toHaveText(["Too big"]);
  await expect(fileRow(dialog, "Q2_K").locator(".pill")).toHaveText(["Fits", "Suggested"]);
  await dialog.getByRole("radiogroup", { name: "Context" }).getByRole("radio", { name: "32k" }).click();

  // Download: its progress shows here and in the section.
  await fileRow(dialog, "Q4_K_M").getByRole("button", { name: "Download Q4_K_M", exact: true }).click();
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/downloads", body: { source: "huggingface", model: QWEN.models[1] } });
  const id = "hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
  h.progress(id, 1.9 * GiB);
  await expect(fileRow(dialog, "Q4_K_M").getByRole("progressbar")).toHaveAttribute("aria-valuetext", "38% · 1.9 GB of 5.0 GB · 25 MB/s · about 2 min left");
  await noHorizontalOverflow(page);
  await shot(page, "22-downloading.png", fileRow(dialog, "Q4_K_M"));
  await fileRow(dialog, "Q4_K_M").getByRole("button", { name: "Stop", exact: true }).click();
  await expect(fileRow(dialog, "Q4_K_M")).toContainText("Stopped at 38% · 1.9 GB of 5.0 GB");
  await expect(fileRow(dialog, "Q4_K_M").getByRole("button", { name: "Resume Q4_K_M", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // The section has it too, stopped, with Resume and Remove; Resume picks it up.
  const row = modelsCard(page).getByRole("list", { name: "Downloads" }).getByRole("listitem", { name: "Qwen3-8B Q4_K_M" });
  await expect(row).toContainText("Stopped at 38% · 1.9 GB of 5.0 GB");
  await expect(row.getByRole("button", { name: "Remove the download of Qwen3-8B Q4_K_M" })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, "23-stopped-in-section.png", modelsCard(page));
  await row.getByRole("button", { name: "Resume: Qwen3-8B Q4_K_M", exact: true }).click();
  await expect(row.getByRole("button", { name: "Stop the download of Qwen3-8B Q4_K_M", exact: true })).toBeVisible();
  expect(h.state.sent.filter((s) => s.path === "/api/local-models/downloads")).toHaveLength(2);
  // Done: it's a model here, with how it fits and Start in llama.cpp.
  h.finish(id);
  const done = modelsCard(page).getByRole("list", { name: "Downloaded" }).getByRole("listitem", { name: "Qwen3-8B · Q4_K_M" });
  await expect(done).toBeVisible({ timeout: 5000 });
  await expect(done.locator(".pill")).toHaveText(["Fits"]);
  await expect(done).toContainText("5.0 GB · at 32k context");
  await expect(done.getByRole("button", { name: "Start Qwen3-8B · Q4_K_M in llama.cpp", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, "24-downloaded.png", modelsCard(page));
});

test("not enough room: Download waits with what it needs, Change folder takes an external drive, and a refusal from the hub says why", async ({ page }) => {
  const h = await hub(page, { library: library({ folder: { path: "/Users/me/.crosstalk/models", shown: "~/.crosstalk/models", isDefault: true, drive: null, freeBytes: 6 * GiB, totalBytes: 460 * GiB, problem: null } }) });
  await settings(page);
  const dialog = await openGet(page);
  await openQwen(dialog);
  const q4 = fileRow(dialog, "Q4_K_M");
  await expect(q4.locator(".local-warn")).toHaveText("Not enough room in ~/.crosstalk/models: it needs 5.0 GB and 4.0 GB is free (keeping 2.0 GB free). Free up space, or change the folder.");
  await expect(q4.getByRole("button", { name: "Download Q4_K_M", exact: true })).toBeDisabled();
  // The smallest still fits on the disk.
  await expect(fileRow(dialog, "Q2_K").getByRole("button", { name: "Download Q2_K", exact: true })).toBeEnabled();
  await noHorizontalOverflow(page);
  await shot(page, "25-no-room.png", q4);

  await q4.getByRole("button", { name: "Change folder", exact: true }).click();
  const folder = page.getByRole("dialog", { name: "Downloads folder", exact: true });
  await expect(folder).toBeVisible();
  // A drive that isn't plugged in: the hub says so, and the folder stays as it was.
  h.state.fail["/api/local-models/folder"] = { status: 409, error: "The drive Gone isn't plugged in: plug it in, or change the folder.", code: "folder" };
  await folder.getByLabel("Folder", { exact: true }).fill("/Volumes/Gone/models");
  await folder.getByRole("button", { name: "Save", exact: true }).click();
  await expect(folder.getByRole("alert")).toHaveText("The drive Gone isn't plugged in: plug it in, or change the folder.");
  await shot(page, "26-drive-unplugged.png");
  await folder.getByLabel("Folder", { exact: true }).fill("/Volumes/Untitled/models");
  await folder.getByRole("button", { name: "Save", exact: true }).click();
  await expect(folder).toHaveCount(0);
  expect(h.state.sent.filter((s) => s.path === "/api/local-models/folder").map((s) => s.body)).toEqual([{ path: "/Volumes/Gone/models" }, { path: "/Volumes/Untitled/models" }]);
  // Room on the drive: Download is there now.
  await expect(q4.locator(".local-warn")).toHaveCount(0);
  await expect(q4.getByRole("button", { name: "Download Q4_K_M", exact: true })).toBeEnabled();
  // The hub still refuses (the disk filled meanwhile): its words, and the way out.
  h.state.fail["/api/local-models/downloads"] = { status: 507, error: "Not enough free space in /Volumes/Untitled/models for Qwen3-8B Q4_K_M: it needs 5.0 GB more and 1.2 GB is free (keeping 2.0 GB free). Free up space, change the folder, or pick a smaller file.", code: "low_disk" };
  await q4.getByRole("button", { name: "Download Q4_K_M", exact: true }).click();
  await expect(q4.getByRole("alert")).toContainText("Free up space, change the folder, or pick a smaller file.");
  await expect(q4.getByRole("alert").getByRole("button", { name: "Change folder", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(modelsCard(page).locator(".local-folder-path")).toHaveText("/Volumes/Untitled/models (on Untitled) · 900 GB free");
  await noHorizontalOverflow(page);
});

test("a gated model asks for the Hugging Face token: saved on the hub, never shown again", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const dialog = await openGet(page);
  await dialog.getByLabel("Search Hugging Face, or paste a link").fill("https://huggingface.co/orcarouter/Qwen3.8-27B-GGUF");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  // A link opens the repo straight away.
  expect(h.state.searches).toEqual([]);
  await expect(dialog.getByText("Gated", { exact: true }).first()).toBeVisible();
  await expect(dialog).toContainText("Its files didn't say how much memory a chat takes, so the fit is a guess.");
  const field = dialog.getByLabel("Hugging Face token", { exact: true });
  await expect(field).toHaveAttribute("type", "password");
  await field.fill(TOKEN);
  await dialog.getByRole("button", { name: "Save token", exact: true }).click();
  await expect(dialog.locator(".local-token .pill")).toHaveText("Saved");
  await expect(dialog.getByLabel("Hugging Face token", { exact: true })).toHaveCount(0);
  expect(h.state.sent.find((s) => s.path === "/api/pool/hf-token")?.body).toEqual({ token: TOKEN });
  expect(await page.content()).not.toContain(TOKEN);
  await noHorizontalOverflow(page);
  await shot(page, "27-token-saved.png");

  // The terms weren't accepted: the hub's words, and the token field opens again.
  h.state.fail["/api/local-models/downloads"] = { status: 403, error: "Hugging Face won't let this download orcarouter/Qwen3.8-27B-GGUF yet: open huggingface.co/orcarouter/Qwen3.8-27B-GGUF, accept the model's terms, then save a Hugging Face token (from the same account) and try again.", code: "hf_terms" };
  await fileRow(dialog, "Q4_K_M").getByRole("button", { name: "Download Q4_K_M", exact: true }).click();
  await expect(fileRow(dialog, "Q4_K_M").getByRole("alert")).toContainText("accept the model's terms");
  await expect(dialog.getByLabel("Hugging Face token", { exact: true })).toBeFocused();
});

test("a repo that can't be found says why, with Try again and the token for a private one", async ({ page }) => {
  await hub(page);
  await settings(page);
  const dialog = await openGet(page);
  await dialog.getByLabel("Search Hugging Face, or paste a link").fill("someone/private-GGUF");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/^Couldn't find someone\/private-GGUF on Hugging Face: check the name\. If it's private, save a Hugging Face token first\./);
  await expect(dialog.getByRole("alert").getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Hugging Face token", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("Ollama: a model from its library with its size and whether it fits, pulled into the Ollama running here", async ({ page }) => {
  const h = await hub(page, { servers: [OLLAMA_SERVER()] });
  await settings(page);
  const card = page.getByRole("region", { name: "Ollama (port 11434) on 127.0.0.1:11434", exact: true });
  await expect(card.locator(".local-why").last()).toHaveText("Crosstalk didn't start this Ollama, so it leaves it alone: quit it from its menu bar icon, or where it was started.");
  await expect(card.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  // Another Ollama would share this one's models: the Start row says to pull into it.
  await expect(startCard(page)).toContainText("Ollama runs on port 11434: pull models into that one with Get a model.");
  const dialog = await openGet(page);
  await dialog.getByRole("radiogroup", { name: "Where from" }).getByRole("radio", { name: "Ollama" }).click();
  await dialog.getByLabel("Model name", { exact: true }).fill("qwen3:8b");
  await dialog.getByRole("button", { name: "Look up", exact: true }).click();
  const found = dialog.getByRole("group", { name: "qwen3:8b" });
  await expect(found).toContainText("4.9 GB · Q4_K_M · 8.2B parameters");
  await expect(found.locator(".pill")).toHaveText("Fits");
  await noHorizontalOverflow(page);
  await shot(page, "28-ollama-found.png");
  await found.getByRole("button", { name: "Download", exact: true }).click();
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/downloads", body: { source: "ollama", serverId: "ollama-11434", model: "qwen3:8b" } });
  await expect(found.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Looking it up…");
  h.lib().downloads = h.lib().downloads.map((d) => ({ ...d, step: "pulling a3de86cd1c13", doneBytes: 2.45 * GiB, totalBytes: 4.9 * GiB, bytesPerSec: 50 * MiB }));
  await expect(found.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "50% · 2.5 GB of 4.9 GB · 50 MB/s · under a minute left");
  await found.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(found).toContainText("Stopped at 50%");

  // One the library can't say (Ollama gets it from Hugging Face): it can still be pulled.
  await dialog.getByLabel("Model name", { exact: true }).fill("hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M");
  await dialog.getByRole("button", { name: "Look up", exact: true }).click();
  const other = dialog.getByRole("group", { name: "hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M" });
  await expect(other).toContainText("Ollama gets that one from Hugging Face: its size shows once the pull starts.");
  await expect(other.getByRole("button", { name: "Download anyway", exact: true })).toBeVisible();
  // A name Ollama can't have is caught here.
  await dialog.getByLabel("Model name", { exact: true }).fill("two words");
  await dialog.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Type a model's name as Ollama's library writes it, like qwen3:8b.");
  await noHorizontalOverflow(page);
});

test("without Ollama running, the Ollama tab says how to start it", async ({ page }) => {
  await hub(page);
  await settings(page);
  const dialog = await openGet(page);
  await dialog.getByRole("radiogroup", { name: "Where from" }).getByRole("radio", { name: "Ollama" }).click();
  await expect(dialog.getByRole("status")).toContainText(/^Ollama isn't running on .+\. Start it under Start a server \(or open the Ollama app\), then press Rescan\.$/);
});

test("starting llama.cpp with a downloaded model, its port and context; it shows loading, then its card has Stop, which asks first", async ({ page }) => {
  const files = [fileOf(QWEN.models[1])];
  const h = await hub(page, { library: library({ files }) });
  await settings(page);
  const start = startCard(page);
  await expect(start.getByRole("listitem")).toHaveCount(2);
  await expect(start).toContainText("From Homebrew. Pulls models from its library.");
  await expect(start).toContainText("LM Studio is managed in LM Studio: start it there, then press Rescan.");
  await noHorizontalOverflow(page);
  await shot(page, "29-start-card.png", start);
  await start.getByRole("button", { name: "Start llama.cpp", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start llama.cpp", exact: true });
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue(files[0].id);
  await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("8080");
  await expect(dialog.locator(".local-fit-line .pill")).toHaveText("Fits");
  await dialog.getByLabel("Port", { exact: true }).fill("80");
  await expect(dialog.getByText("Use a port from 1024 to 65535.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await dialog.getByLabel("Port", { exact: true }).fill("8081");
  await dialog.getByRole("radiogroup", { name: "Context" }).getByRole("radio", { name: "64k" }).click();
  await noHorizontalOverflow(page);
  await shot(page, "30-start-dialog.png");
  // Taken after all: the hub's words, and the dialog stays to pick another.
  h.state.fail["/api/local-models/start"] = { status: 409, error: "Port 8081 is taken on this machine: pick another.", code: "port_taken" };
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Port 8081 is taken on this machine: pick another.");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(h.state.sent.filter((s) => s.path === "/api/local-models/start").at(-1)?.body).toEqual({ kind: "llamacpp", port: 8081, model: files[0].id, context: 65536 });

  const starting = start.getByRole("group", { name: "llama.cpp on port 8081" });
  await expect(starting).toContainText("Loading the model…");
  await expect(starting).toContainText("Qwen3-8B-Q4_K_M.gguf");
  await noHorizontalOverflow(page);
  await shot(page, "31-starting.png", start);
  // It answers: the page looks for servers again and its card has Stop.
  h.state.servers = [{ id: "llamacpp-8081", kind: "llamacpp", label: "llama.cpp (port 8081)", baseUrl: "http://127.0.0.1:8081", protocols, accountIds: [], processBytes: 6 * GiB, memoryBytes: 6 * GiB, models: [{ id: "qwen3-8b-q4_k_m", loaded: true, loading: false, contextWindow: 65536, sizeBytes: null, memoryBytes: null, vramBytes: null, expiresAt: null, canSwitch: false, why: "This llama.cpp server holds one model, chosen when it started. Quit it on this machine to free its memory." }], startedId: "llamacpp-8081", stopWhy: null }];
  h.lib().started = h.lib().started.map((s) => ({ ...s, state: "running", detail: null }));
  const card = page.getByRole("region", { name: "llama.cpp (port 8081) on 127.0.0.1:8081", exact: true });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(starting).toHaveCount(0);
  await expect(card.locator(".local-stop")).toContainText("Crosstalk started it.");
  await expect(modelsCard(page).getByRole("listitem", { name: "Qwen3-8B · Q4_K_M" }).locator(".pill")).toHaveText(["Fits", "Running"]);
  await noHorizontalOverflow(page);
  await shot(page, "32-started-card.png", card);
  await card.getByRole("button", { name: "Stop llama.cpp (port 8081)", exact: true }).click();
  await expect(card.getByRole("group", { name: "Stop it? Chats using it stop answering." })).toBeVisible();
  await shot(page, "33-stop-asks.png", card);
  await pastDoubleTap(page);
  await card.getByRole("button", { name: "Stop it", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/stop", body: { id: "llamacpp-8081" } });
});

test("a server that didn't start says why, with Try again and Dismiss; Ollama starts at its own port", async ({ page }) => {
  const failed: LocalStarted = { id: "llamacpp-8080", kind: "llamacpp", port: 8080, baseUrl: "http://127.0.0.1:8080", model: "unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf", context: 32768, state: "failed", detail: "llama.cpp couldn't load the model: download it again or pick another quant, then start again.", log: "~/.crosstalk/run/local-servers/llamacpp-8080/server.log", startedAt: 1 };
  const h = await hub(page, { library: library({ files: [fileOf(QWEN.models[1])], started: [failed] }) });
  await settings(page);
  const row = startCard(page).getByRole("group", { name: "llama.cpp on port 8080" });
  await expect(row).toContainText("llama.cpp couldn't load the model: download it again or pick another quant, then start again.");
  await expect(row).toContainText("Its log: ~/.crosstalk/run/local-servers/llamacpp-8080/server.log");
  await noHorizontalOverflow(page);
  await shot(page, "34-start-failed.png", row);
  await row.getByRole("button", { name: "Try again", exact: true }).click();
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/start", body: { kind: "llamacpp", port: 8080, model: failed.model, context: 32768 } });
  await expect(row).toContainText("Loading the model…");
  await expect(row.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  // It fails again (the page looks every second while it starts); Dismiss puts it away.
  h.lib().started = [failed];
  await expect(row.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible({ timeout: 5000 });
  await row.getByRole("button", { name: "Dismiss", exact: true }).click();
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/stop", body: { id: "llamacpp-8080" } });
  await expect(startCard(page).getByRole("group", { name: "llama.cpp on port 8080" })).toHaveCount(0);

  await startCard(page).getByRole("button", { name: "Start Ollama", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start Ollama", exact: true });
  await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("11434");
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/start", body: { kind: "ollama", port: 11434 } });
});

test("servers Crosstalk didn't start say how to stop them, and nothing installed says where to get it", async ({ page }) => {
  await hub(page, { library: library({ programs: [] }), servers: [LM_STUDIO] });
  await settings(page);
  const studio = page.getByRole("region", { name: "LM Studio (port 1234) on 127.0.0.1:1234", exact: true });
  await expect(studio.getByText("LM Studio is managed in LM Studio: start and stop it there.", { exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  const start = startCard(page);
  await expect(start).toContainText("Not installed here. Get it at ollama.com/download, then press Rescan.");
  await expect(start).toContainText("Not installed here. Install it with Homebrew (brew install llama.cpp), or start the model pool once to get its build, then press Rescan.");
  await expect(start.getByRole("button", { name: /^Start / })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, "35-not-installed.png", start);
});

test("removing a downloaded model or a stopped download asks first, then moves it to the Trash", async ({ page }) => {
  const m = QWEN.models[1];
  const stopped: LocalDownload = { id: `hf:${QWEN.repo}/${QWEN.models[2].files[0]}`, source: "huggingface", name: "Qwen3-8B Q6_K", model: QWEN.models[2], ollama: null, state: "stopped", doneBytes: 2 * GiB, totalBytes: QWEN.models[2].sizeBytes, bytesPerSec: null, error: null, code: null, step: null, updatedAt: 1 };
  const h = await hub(page, { library: library({ files: [fileOf(m)], downloads: [stopped] }) });
  await settings(page);
  const file = modelsCard(page).getByRole("listitem", { name: "Qwen3-8B · Q4_K_M" });
  await file.getByRole("button", { name: "Remove Qwen3-8B · Q4_K_M", exact: true }).click();
  await expect(file.getByRole("group", { name: "Move this model to the Trash?" })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, "36-remove-asks.png", modelsCard(page));
  await pastDoubleTap(page);
  await file.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await expect(file).toHaveCount(0);
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/files/remove", body: { id: fileOf(m).id } });
  const dl = modelsCard(page).getByRole("listitem", { name: "Qwen3-8B Q6_K" });
  await dl.getByRole("button", { name: "Remove the download of Qwen3-8B Q6_K", exact: true }).click();
  await dl.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(h.state.sent).toHaveLength(1);
  await dl.getByRole("button", { name: "Remove the download of Qwen3-8B Q6_K", exact: true }).click();
  await pastDoubleTap(page);
  await dl.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await expect(dl).toHaveCount(0);
  await expect(modelsCard(page).getByText("No models downloaded here yet. Get one from Hugging Face, then start it in llama.cpp.", { exact: true })).toBeVisible();
});

test("a model on a drive whose Trash can't be used: the hub's words, then Delete for good, which asks again", async ({ page }) => {
  const m = QWEN.models[1];
  const h = await hub(page, { library: library({ files: [fileOf(m)] }) });
  await settings(page);
  const file = modelsCard(page).getByRole("listitem", { name: "Qwen3-8B · Q4_K_M" });
  h.state.fail["/api/local-models/files/remove"] = { status: 409, error: "Qwen3-8B-Q4_K_M.gguf is on another drive, and Crosstalk can't use that drive's Trash: delete it for good instead, or delete it in the Finder.", code: "no_trash" };
  await file.getByRole("button", { name: "Remove Qwen3-8B · Q4_K_M", exact: true }).click();
  await pastDoubleTap(page);
  await file.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await expect(file.getByRole("alert")).toHaveText(/^Qwen3-8B-Q4_K_M\.gguf is on another drive, and Crosstalk can't use that drive's Trash/);
  await expect(file.getByRole("button", { name: "Remove Qwen3-8B · Q4_K_M", exact: true })).toHaveCount(0);
  await file.getByRole("button", { name: "Delete Qwen3-8B · Q4_K_M for good", exact: true }).click();
  await expect(file.getByRole("group", { name: "Delete it for good? It can't be got back." })).toBeVisible();
  await noHorizontalOverflow(page);
  await pastDoubleTap(page);
  await file.getByRole("button", { name: "Delete it", exact: true }).click();
  await expect(file).toHaveCount(0);
  expect(h.state.sent.filter((s) => s.path === "/api/local-models/files/remove").map((s) => s.body)).toEqual([{ id: fileOf(m).id }, { id: fileOf(m).id, forGood: true }]);
});

test("a look that fails while a download runs (the hub restarting, say) doesn't stop the bar: the next look moves it on", async ({ page }) => {
  const running: LocalDownload = { id: `hf:${QWEN.repo}/${QWEN.models[2].files[0]}`, source: "huggingface", name: "Qwen3-8B Q6_K", model: QWEN.models[2], ollama: null, state: "downloading", doneBytes: 2 * GiB, totalBytes: QWEN.models[2].sizeBytes, bytesPerSec: 50 * MiB, error: null, code: null, step: null, updatedAt: 1 };
  const h = await hub(page, { library: library({ downloads: [running] }) });
  await settings(page);
  const bar = modelsCard(page).getByRole("list", { name: "Downloads" }).getByRole("listitem", { name: "Qwen3-8B Q6_K" }).getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "30");
  h.state.fail["/api/local-models/library"] = { status: 502, error: "The hub didn't answer." };
  await expect.poll(() => "/api/local-models/library" in h.state.fail, { timeout: 5000 }).toBe(false);
  h.progress(running.id, 4 * GiB);
  await expect(bar).toHaveAttribute("aria-valuenow", "61", { timeout: 5000 });
});

test("a folder that hasn't answered the hub yet (a drive waking up) is looked at again until it has", async ({ page }) => {
  const asleep = { path: "/Volumes/Untitled/models", shown: "/Volumes/Untitled/models", isDefault: false, drive: null, freeBytes: null, totalBytes: null, problem: "/Volumes/Untitled/models hasn't answered yet (a drive waking up, or a network folder that's gone?): wait a moment, or change the folder.", pending: true };
  const h = await hub(page, { library: library({ folder: asleep }) });
  await settings(page);
  await expect(modelsCard(page).getByRole("alert")).toHaveText(asleep.problem);
  h.lib().folder = { path: asleep.path, shown: asleep.shown, isDefault: false, drive: "Untitled", freeBytes: 900 * GiB, totalBytes: 1000 * GiB, problem: null };
  await expect(modelsCard(page).locator(".local-folder-path")).toHaveText("/Volumes/Untitled/models (on Untitled) · 900 GB free", { timeout: 5000 });
  await expect(modelsCard(page).getByRole("alert")).toHaveCount(0);
});

test("a model trained for less than 32k starts with its own context, and says it's little for Claude Code", async ({ page }) => {
  // Sizes are shown to a tenth of a GB: this one stays off a .x5 boundary, where which way it rounds is floating point's to decide.
  const short: LocalModelFile = { id: "meta/Llama-3-8B-GGUF/Llama-3-8B-Q8_0.gguf", repo: "meta/Llama-3-8B-GGUF", files: ["Llama-3-8B-Q8_0.gguf"], quant: "Q8_0", bytes: 7.9 * GiB, kvBytesPerToken: 131072, contextLength: 8192 };
  const h = await hub(page, { library: library({ files: [short] }) });
  await settings(page);
  await expect(modelsCard(page).getByRole("listitem", { name: "Llama-3-8B · Q8_0" })).toContainText("7.9 GB · at 8k context");
  await startCard(page).getByRole("button", { name: "Start llama.cpp", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start llama.cpp", exact: true });
  await expect(dialog.getByRole("radiogroup", { name: "Context" }).getByRole("radio")).toHaveText(["8k"]);
  await expect(dialog).toContainText("It holds at most 8k, which is little for Claude Code: it needs about 20k just to start.");
  await noHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  expect(h.state.sent.at(-1)?.body).toEqual({ kind: "llamacpp", port: 8080, model: short.id, context: 8192 });
});

test("a stopped download resumes in its own folder: the folder chosen now being unplugged doesn't hold it back", async ({ page }) => {
  const stopped: LocalDownload = { id: `hf:${QWEN.repo}/${QWEN.models[2].files[0]}`, source: "huggingface", name: "Qwen3-8B Q6_K", model: QWEN.models[2], ollama: null, state: "stopped", doneBytes: 2 * GiB, totalBytes: QWEN.models[2].sizeBytes, bytesPerSec: null, error: null, code: null, step: null, updatedAt: 1 };
  const unplugged = { path: "/Volumes/Untitled/models", shown: "/Volumes/Untitled/models", isDefault: false, drive: "Untitled", freeBytes: null, totalBytes: null, problem: "The drive Untitled isn't plugged in: plug it in, or change the folder." };
  const h = await hub(page, { library: library({ downloads: [stopped], folder: unplugged }) });
  await settings(page);
  const dialog = await openGet(page);
  await openQwen(dialog);
  // A new download would go to the unplugged drive: it waits, with the drive's words.
  await expect(fileRow(dialog, "Q4_K_M").getByRole("button", { name: "Download Q4_K_M", exact: true })).toBeDisabled();
  await expect(fileRow(dialog, "Q4_K_M").locator(".local-warn")).toHaveText("The drive Untitled isn't plugged in: plug it in, or change the folder.");
  // The stopped one carries on where it began.
  await fileRow(dialog, "Q6_K").getByRole("button", { name: "Resume Q6_K", exact: true }).click();
  expect(h.state.sent.at(-1)).toEqual({ method: "POST", path: "/api/local-models/downloads", body: { source: "huggingface", model: QWEN.models[2] } });
});

test("an older hub without these parts shows its servers as before", async ({ page }) => {
  await hub(page, { library: 404, servers: [LM_STUDIO] });
  await settings(page);
  await expect(page.getByRole("region", { name: "LM Studio (port 1234) on 127.0.0.1:1234", exact: true })).toBeVisible();
  await expect(startCard(page)).toHaveCount(0);
  await expect(modelsCard(page)).toHaveCount(0);
});

for (const width of [320, 390]) {
  test(`nothing runs off the edge at ${width} px: long names, a failed download, the dialogs open`, async ({ page }) => {
    const longRepo = "someone-with-a-long-name/Qwen3-Coder-30B-A3B-Instruct-1M-Abliterated-Uncensored-GGUF";
    const long: PoolModel = { repo: longRepo, files: ["Qwen3-Coder-30B-A3B-Instruct-1M-Abliterated-Uncensored-UD-Q4_K_XL-00001-of-00002.gguf", "Qwen3-Coder-30B-A3B-Instruct-1M-Abliterated-Uncensored-UD-Q4_K_XL-00002-of-00002.gguf"], quant: "UD-Q4_K_XL", sizeBytes: 17.7 * GiB, gated: false };
    const failedDl: LocalDownload = { id: `hf:${longRepo}/${long.files[0]}`, source: "huggingface", name: "Qwen3-Coder-30B-A3B-Instruct-1M-Abliterated-Uncensored UD-Q4_K_XL", model: long, ollama: null, state: "failed", doneBytes: 3 * GiB, totalBytes: long.sizeBytes, bytesPerSec: null, error: "The disk is almost full (keeping 2.0 GB free): free up space, then start the download again (it picks up where it stopped).", code: "low_disk", step: null, updatedAt: 1 };
    await hub(page, {
      library: library({ files: [fileOf(QWEN.models[1]), { ...fileOf(long), id: `${longRepo}/${long.files[0]}` }], downloads: [failedDl], folder: { path: "/Volumes/A-very-long-drive-name-for-models/llm/models", shown: "/Volumes/A-very-long-drive-name-for-models/llm/models", isDefault: false, drive: "A-very-long-drive-name-for-models", freeBytes: 812 * GiB, totalBytes: 1000 * GiB, problem: null } }),
      servers: [LM_STUDIO, OLLAMA_SERVER()],
    });
    await settings(page, width);
    await expect(modelsCard(page).getByRole("listitem", { name: failedDl.name }).getByRole("button", { name: "Change folder", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    for (const el of await page.locator(".local-start, .local-library, .local-server").all()) expect(await el.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
    // Every button is at least 44 px tall on a phone (a "?" is a small circle with a 44 px area around it).
    for (const button of await page.locator(".local-start button:not(.help-tip-btn), .local-library button:not(.help-tip-btn)").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    const dialog = await openGet(page);
    await openQwen(dialog);
    await noHorizontalOverflow(page);
    expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
    for (const button of await dialog.locator(".local-file button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await startCard(page).getByRole("button", { name: "Start llama.cpp", exact: true }).click();
    await noHorizontalOverflow(page);
    await page.getByRole("dialog", { name: "Start llama.cpp", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await modelsCard(page).getByRole("button", { name: "Change", exact: true }).click();
    await noHorizontalOverflow(page);
  });
}
