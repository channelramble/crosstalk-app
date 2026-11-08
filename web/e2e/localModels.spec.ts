import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { LocalModel, LocalModelServer } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";

// Settings → Local models (docs/SPEC-0.5.md, track T10), with the hub's answers played here: the shared test hub's settings
// stay as they were, and nothing here loads or frees a real model or looks at this Mac's own model servers.
// CT_SHOTS: a folder to save the 390 px screens in (Chromium 390 only), to look at them.

const GB = 1024 ** 3;
/** The machine this app opens from (the test hub), as requests to it are addressed. */
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;
const protocols = { responses: "yes", messages: "no", chat: "yes" } as const;

const model = (over: Partial<LocalModel>): LocalModel => ({ id: "m", loaded: false, loading: false, contextWindow: null, sizeBytes: null, memoryBytes: null, vramBytes: null, expiresAt: null, canSwitch: true, why: null, ...over });
const OLLAMA = (): LocalModelServer => ({
  id: "ollama-11434", kind: "ollama", label: "Ollama (port 11434)", baseUrl: "http://127.0.0.1:11434", protocols, accountIds: [], processBytes: 0.4 * GB, memoryBytes: 19.4 * GB,
  models: [
    model({ id: "gemma3:12b", sizeBytes: 8.1e9 }),
    model({ id: "qwen3-coder:30b", loaded: true, memoryBytes: 19 * GB, vramBytes: 19 * GB, expiresAt: Date.now() + 4.5 * 60_000, contextWindow: 262_144 }),
    model({ id: "llama3.2:3b", sizeBytes: 2e9 }),
  ],
});
const LM_WHY = "LM Studio is switched in its own app.";
const LM_STUDIO = (): LocalModelServer => ({
  id: "lmstudio-1234", kind: "lmstudio", label: "LM Studio (port 1234)", baseUrl: "http://127.0.0.1:1234", protocols, accountIds: [{ provider: "codex", id: "kimi1" }], processBytes: 5.2 * GB, memoryBytes: 5.2 * GB,
  models: [model({ id: "qwen2.5-coder-7b", loaded: true, canSwitch: false, why: LM_WHY }), model({ id: "gemma-3-12b", canSwitch: false, why: LM_WHY })],
});
const ROUTER = (loading: boolean): LocalModelServer => ({
  id: "llamacpp-9931", kind: "llamacpp", label: "llama.cpp (port 9931)", baseUrl: "http://127.0.0.1:9931", protocols, accountIds: [], processBytes: 6.5 * GB, memoryBytes: 6.5 * GB,
  models: [model({ id: "unsloth/Qwen3-8B-GGUF:Q4_K_M", loaded: !loading, loading }), model({ id: "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M" })],
});
const MLX: LocalModelServer = {
  id: "mlx-8080", kind: "mlx", label: "mlx-lm (port 8080)", baseUrl: "http://127.0.0.1:8080", protocols, accountIds: [], processBytes: null, memoryBytes: null,
  models: [model({ id: "mlx-community/Qwen3-4B-4bit", loaded: null, canSwitch: false, why: "mlx-lm doesn't say which model it has loaded, and Crosstalk can't switch it. Quit it on this machine to free its memory." })],
};

/** The hub's side of Local models: what the app sent comes in the arrays; the servers are changed to change what the hub says. */
async function hub(page: Page, servers: LocalModelServer[] | number = [OLLAMA(), LM_STUDIO()]) {
  const state = {
    /** The servers the hub finds, or a status to fail with. */
    servers,
    /** The query of each look: "" when Settings opens, "?fresh=1" for Rescan. */
    looks: [] as string[],
    switches: [] as { serverId: string; model: string; on: boolean }[],
    tests: [] as unknown[],
    /** The next switches fail with this. */
    fail: null as { status: number; error: string } | null,
    /** The switches wait for this to end before the hub answers. */
    wait: null as Promise<void> | null,
  };
  /** Holds the hub's answers to switches; the function it gives lets them go. */
  const hold = () => {
    let release!: () => void;
    state.wait = new Promise<void>((resolve) => (release = resolve));
    return () => {
      state.wait = null;
      release();
    };
  };
  await page.route(home("/api/local-models"), (route) => {
    state.looks.push(new URL(route.request().url()).search);
    if (typeof state.servers === "number") return route.fulfill({ status: state.servers, json: { error: state.servers === 404 ? "not found" : "The hub couldn't look" } });
    return route.fulfill({ json: { servers: state.servers, scannedAt: Date.now() } });
  });
  await page.route(home("/api/local-models/switch"), async (route) => {
    const body = route.request().postDataJSON() as { serverId: string; model: string; on: boolean };
    state.switches.push(body);
    if (state.wait) await state.wait;
    if (state.fail) return route.fulfill({ status: state.fail.status, json: { error: state.fail.error } });
    const server = (state.servers as LocalModelServer[]).find((s) => s.id === body.serverId)!;
    Object.assign(server.models.find((m) => m.id === body.model)!, body.on ? { loaded: true, memoryBytes: 7.4 * GB, vramBytes: 7.4 * GB, expiresAt: Date.now() + 30 * 60_000 } : { loaded: false, memoryBytes: null, vramBytes: null, expiresAt: null });
    server.memoryBytes = (server.processBytes ?? 0) + server.models.reduce((n, m) => n + (m.memoryBytes ?? 0), 0);
    return route.fulfill({ json: server });
  });
  // "Add to AI services" checks the server as it opens: this answer, so nothing here reaches a real server at 11434.
  await page.route(home("/api/services/test"), (route) => {
    state.tests.push(route.request().postDataJSON());
    return route.fulfill({
      json: { reachable: true, authOk: null, server: "Ollama", protocols, models: [{ id: "qwen3-coder:30b", contextWindow: 262_144 }, { id: "gemma3:12b", contextWindow: null }], works: [{ provider: "codex", via: "responses" }], problems: [] },
    });
  });
  return { state, hold };
}

const settings = async (page: Page, width = 390) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/#/settings/local-models");
  await expect(page.getByRole("heading", { name: "Local models", exact: true })).toBeVisible();
};
const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const OLLAMA_CARD = "Ollama (port 11434) on 127.0.0.1:11434";
const LM_CARD = "LM Studio (port 1234) on 127.0.0.1:1234";
const rescan = (page: Page) => page.locator(".local-bar").getByRole("button", { name: "Rescan", exact: true });
/**
 * A model's switch. Clicked like any control, never with `force`: Settings opened at #/settings/local-models holds the
 * section at the top of the screen while the sections around it load (AppSettings' keepInView), so the page can move
 * just as a click goes down, and a forced click then lands beside the switch and does nothing (seen at 320 and 768 px).
 * An ordinary click waits for the switch to stand still and be enabled, and checks that the click reaches it.
 */
const flip = (card: Locator, name: string) => card.getByRole("checkbox", { name, exact: true });
const stateOf = (card: Locator, name: string) => card.locator(".local-model", { has: card.page().getByText(name, { exact: true }) }).locator(".local-model-state");

/** Scrolls so the element starts at the top of the screen, then saves the phone screen (390 px Chromium only). */
async function shot(page: Page, name: string, target: Locator = page.locator("#local-models")) {
  const dir = process.env.CT_SHOTS;
  if (!dir || test.info().project.name !== "chromium-390") return;
  await target.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: join(dir, name), animations: "disabled" });
}
const tip = async (button: Locator, text: RegExp) => {
  await button.click();
  await expect(button.locator("xpath=..").getByRole("note")).toHaveText(text);
};

test("shows what's running with the memory it uses, each model's state, and why LM Studio's can't be switched", async ({ page }) => {
  await hub(page);
  await settings(page);
  const ollama = card(page, OLLAMA_CARD);
  await expect(ollama.locator(".mono")).toHaveText("127.0.0.1:11434");
  await expect(ollama.locator(".local-memory")).toContainText("Memory in use");
  await expect(ollama.locator(".local-memory-value")).toHaveText("19.4 GB");
  await expect(ollama.getByRole("button", { name: "Add to AI services", exact: true })).toBeVisible();
  // The model in memory comes first, with what it holds and when the server frees it.
  await expect(ollama.locator(".local-model-name")).toHaveText(["qwen3-coder:30b", "gemma3:12b", "llama3.2:3b"]);
  await expect(flip(ollama, "qwen3-coder:30b")).toBeChecked();
  await expect(stateOf(ollama, "qwen3-coder:30b")).toHaveText(/^On · 19\.0 GB · unloads in [45] min$/);
  await expect(flip(ollama, "gemma3:12b")).not.toBeChecked();
  await expect(stateOf(ollama, "gemma3:12b")).toHaveText("Off. Uses no memory.");
  await expect(flip(ollama, "gemma3:12b")).toBeEnabled();

  // LM Studio is switched in its own app: its models show their state, the switches are off limits, and it says why once.
  const studio = card(page, LM_CARD);
  await expect(studio.getByText("In AI services", { exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Add to AI services" })).toHaveCount(0);
  await expect(flip(studio, "qwen2.5-coder-7b")).toBeChecked();
  await expect(flip(studio, "qwen2.5-coder-7b")).toBeDisabled();
  await expect(flip(studio, "gemma-3-12b")).toBeDisabled();
  await expect(studio.getByText(LM_WHY, { exact: true })).toHaveCount(1);
  await expect(studio.locator(".local-memory-value")).toHaveText("5.2 GB");
  await noHorizontalOverflow(page);
  await shot(page, "01-running.png");

  // The "?" on memory.
  await tip(ollama.getByRole("button", { name: "What does memory mean?", exact: true }), /^What the server is holding in .+'s memory right now\.$/);
  await noHorizontalOverflow(page);
  await shot(page, "02-memory-help.png", ollama);
});

test("switching a model off frees its memory and switching it on loads it, with the state shown while it moves", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const ollama = card(page, OLLAMA_CARD);
  const qwen = flip(ollama, "qwen3-coder:30b");
  const release = h.hold();
  await qwen.click();
  await expect(stateOf(ollama, "qwen3-coder:30b")).toHaveText("Freeing memory…");
  // The switch is where it was moved to, and can't be moved again until the hub has answered.
  await expect(qwen).not.toBeChecked();
  await expect(qwen).toBeDisabled();
  expect(h.state.switches).toEqual([{ serverId: "ollama-11434", model: "qwen3-coder:30b", on: false }]);
  await noHorizontalOverflow(page);
  await shot(page, "03-freeing-memory.png", ollama);
  release();
  await expect(stateOf(ollama, "qwen3-coder:30b")).toHaveText("Off. Uses no memory.");
  await expect(qwen).toBeEnabled();
  await expect(ollama.locator(".local-memory-value")).toHaveText("410 MB");

  const gemma = flip(ollama, "gemma3:12b");
  const releaseLoad = h.hold();
  await gemma.click();
  await expect(stateOf(ollama, "gemma3:12b")).toHaveText("Loading…");
  await expect(gemma).toBeChecked();
  await expect(gemma).toBeDisabled();
  await shot(page, "04-loading.png", ollama);
  releaseLoad();
  // Once loaded it comes first, with its memory and the 30 minutes Ollama keeps it.
  await expect(ollama.locator(".local-model-name").first()).toHaveText("gemma3:12b");
  await expect(stateOf(ollama, "gemma3:12b")).toHaveText("On · 7.4 GB · unloads in 30 min");
  await expect(ollama.locator(".local-memory-value")).toHaveText("7.8 GB");
  await expect(gemma).toBeChecked();
  await expect(gemma).toBeEnabled();
  expect(h.state.switches.at(-1)).toEqual({ serverId: "ollama-11434", model: "gemma3:12b", on: true });
  await noHorizontalOverflow(page);
  await shot(page, "05-loaded.png", ollama);
});

test("a switch that fails says why: Try again goes on, Keep it as it was leaves the model alone and looks again", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const ollama = card(page, OLLAMA_CARD);
  const gemma = flip(ollama, "gemma3:12b");
  h.state.fail = { status: 502, error: "Ollama couldn't load gemma3:12b: model requires more system memory (28.4 GiB) than is available (9.1 GiB)." };
  await gemma.click();
  const problem = ollama.getByRole("alert");
  await expect(problem).toContainText("Ollama couldn't load gemma3:12b: model requires more system memory (28.4 GiB) than is available (9.1 GiB).");
  // The switch is back where the model really is, ready for another go.
  await expect(gemma).not.toBeChecked();
  await expect(gemma).toBeEnabled();
  await expect(stateOf(ollama, "gemma3:12b")).toHaveText("Off. Uses no memory.");
  await noHorizontalOverflow(page);
  await shot(page, "06-switch-failed.png", ollama);

  // Try again, once whatever it was is fixed: the same switch is asked for again.
  h.state.fail = null;
  await problem.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(ollama.getByRole("alert")).toHaveCount(0);
  await expect(gemma).toBeChecked();
  expect(h.state.switches).toEqual([{ serverId: "ollama-11434", model: "gemma3:12b", on: true }, { serverId: "ollama-11434", model: "gemma3:12b", on: true }]);

  // Keep it as it was: the failure goes, the model stays as it is, and the page looks again to be sure.
  h.state.fail = { status: 504, error: "Ollama didn't finish within 20 seconds. It may still be working: press Rescan in a moment to see." };
  const llama = flip(ollama, "llama3.2:3b");
  await llama.click();
  await expect(ollama.getByRole("alert")).toContainText("didn't finish within 20 seconds");
  const looks = h.state.looks.length;
  await ollama.getByRole("button", { name: "Keep it as it was", exact: true }).click();
  await expect(ollama.getByRole("alert")).toHaveCount(0);
  await expect(llama).not.toBeChecked();
  await expect.poll(() => h.state.looks.length).toBeGreaterThan(looks);
  expect(h.state.looks.at(-1)).toBe("?fresh=1");
});

test("nothing running says what to do, Rescan looks again, and a look that fails says how to try again", async ({ page }) => {
  const h = await hub(page, []);
  await settings(page);
  await expect(page.getByText("Nothing is running here. Start Ollama, LM Studio or llama.cpp, then press Rescan.", { exact: true })).toBeVisible();
  await expect(page.locator(".local-server")).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, "07-nothing-running.png");
  // Opening Settings looked once without ?fresh=1 (twice in dev mode); Rescan asks for a fresh look.
  expect(h.state.looks.every((q) => q === "")).toBe(true);
  h.state.servers = [OLLAMA()];
  await rescan(page).click();
  await expect(card(page, OLLAMA_CARD)).toBeVisible();
  expect(h.state.looks.at(-1)).toBe("?fresh=1");
  await expect(page.getByText("Nothing is running here.")).toHaveCount(0);

  h.state.servers = 500;
  await rescan(page).click();
  const alert = page.getByRole("alert").filter({ hasText: "Couldn't look for local models" });
  await expect(alert).toContainText("Couldn't look for local models: The hub couldn't look. Press Rescan to try again.");
  await noHorizontalOverflow(page);
  await shot(page, "08-look-failed.png");
  h.state.servers = [];
  await rescan(page).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByText("Nothing is running here.")).toBeVisible();
});

test("Add to AI services opens the same sheet with the server's address and name filled in and checked", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await card(page, OLLAMA_CARD).getByRole("button", { name: "Add to AI services", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add an AI service", exact: true });
  await expect(dialog.getByLabel("Server address", { exact: true })).toHaveValue("http://127.0.0.1:11434");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Ollama (port 11434)");
  await expect(dialog.getByText("2 models found", { exact: true })).toBeVisible();
  expect(h.state.tests).toEqual([{ baseUrl: "http://127.0.0.1:11434" }]);
  await dialog.getByText("Reachable", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
  if (process.env.CT_SHOTS && test.info().project.name === "chromium-390") await page.screenshot({ path: join(process.env.CT_SHOTS, "09-add-to-ai-services.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("the image editor and the model pool have a line each that jumps to their section and says whether they're on", async ({ page }) => {
  await hub(page);
  // The image editor is set up on this machine and on (the test hub has none of its own).
  await page.route(home("/api/image-editor"), (route) => (route.request().method() === "GET" ? route.fulfill({ json: { installed: true, state: "ready", detail: null, failed: null, url: null, memoryMB: 2236, busy: false } }) : route.fallback()));
  await settings(page);
  const also = page.getByRole("region", { name: "Also on this machine", exact: true });
  const editor = also.getByRole("button", { name: /^Go to Image editor/ });
  await expect(editor).toHaveAttribute("aria-label", "Go to Image editor: On · 2.2 GB of memory");
  await expect(editor).toContainText("On · 2.2 GB of memory");
  // The model pool of the test hub is off.
  const pool = also.getByRole("button", { name: /^Go to Model pool/ });
  await expect(pool).toHaveAttribute("aria-label", "Go to Model pool: Off");
  await noHorizontalOverflow(page);
  await shot(page, "10-image-editor-and-pool.png", also);
  await editor.click();
  await expect(page.locator("#image-editor")).toBeInViewport();
  await also.scrollIntoViewIfNeeded();
  await pool.click();
  await expect(page.locator("#model-pool")).toBeInViewport();
});

test("a model that is loading finishes by itself, and a server that doesn't say what it has loaded has no switch", async ({ page }) => {
  const h = await hub(page, [ROUTER(true), MLX]);
  await settings(page);
  const router = card(page, "llama.cpp (port 9931) on 127.0.0.1:9931");
  const qwen = "unsloth/Qwen3-8B-GGUF:Q4_K_M";
  await expect(stateOf(router, qwen)).toHaveText("Loading…");
  await expect(flip(router, qwen)).toBeChecked();
  await expect(flip(router, qwen)).toBeDisabled();
  await expect(flip(router, "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M")).toBeEnabled();
  await shot(page, "11-router-loading.png", router);
  // The page looks again on its own (every few seconds) until it has loaded.
  h.state.servers = [ROUTER(false), MLX];
  await expect(stateOf(router, qwen)).toHaveText("On", { timeout: 10_000 });
  await expect(flip(router, qwen)).toBeEnabled();

  // mlx-lm doesn't say: no switch, and what to do instead; its memory isn't known.
  const mlx = card(page, "mlx-lm (port 8080) on 127.0.0.1:8080");
  await expect(mlx.getByRole("checkbox")).toHaveCount(0);
  await expect(stateOf(mlx, "mlx-community/Qwen3-4B-4bit")).toHaveText("Doesn't say whether it's loaded.");
  await expect(mlx.locator(".local-memory-value")).toHaveText("not known");
  await expect(mlx.locator(".local-why")).toContainText("Quit it on this machine to free its memory.");
  await noHorizontalOverflow(page);
  await shot(page, "12-memory-not-known.png", mlx);
});

test("an older hub has no Local models: nothing is shown", async ({ page }) => {
  const h = await hub(page, 404);
  await page.setViewportSize({ width: 390, height: 844 });
  // The tab it would be in opens all the same; the section itself just isn't there.
  await page.goto("/#/settings/local-models");
  await expect(page.getByRole("tab", { name: "Models", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => h.state.looks.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole("heading", { name: "Local models", exact: true })).toHaveCount(0);
  await expect(page.locator(".local-bar")).toHaveCount(0);
  await settingsTab(page, "Agents");
  await expect(page.getByRole("heading", { name: "AI services", exact: true })).toBeVisible();
});

for (const width of [320, 390]) {
  test(`nothing runs off the edge at ${width} px, with long names, a failure and the "?" open`, async ({ page }) => {
    const long = OLLAMA();
    long.label = "Ollama with a rather long server name (port 11434)";
    long.models[0].id = "hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q4_K_XL-with-a-long-tag";
    const h = await hub(page, [long, LM_STUDIO(), MLX]);
    await settings(page, width);
    const first = page.locator(".local-server").first();
    h.state.fail = { status: 502, error: "Ollama couldn't load hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q4_K_XL-with-a-long-tag: model requires more system memory (28.4 GiB) than is available (9.1 GiB)." };
    // Wait for the switch to be refused before looking for what it says: a scan landing between the two re-draws the
    // row, and the click can otherwise reach a row that is already gone.
    const refused = page.waitForResponse((r) => r.url().includes("/api/local-models/switch") && r.status() === 502);
    // Not forced (see flip): a forced click here was what never reached the switch, and nothing was refused.
    const held = flip(first, long.models[0].id);
    await expect(held).toBeEnabled();
    await held.click();
    await refused;
    await expect(first.getByRole("alert")).toBeVisible();
    await first.getByRole("button", { name: "What does memory mean?", exact: true }).click();
    await expect(first.getByRole("note")).toBeVisible();
    await noHorizontalOverflow(page);
    // Nothing inside a card is wider than the card.
    for (const el of await page.locator(".local-server").all()) expect(await el.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
    // Every button is at least 44 px tall on a phone (a "?" is a small circle with a 44 px area around it).
    for (const button of await page.locator(".local-bar button, .local-server button:not(.help-tip-btn), .local-link").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    await page.getByRole("region", { name: "Also on this machine", exact: true }).scrollIntoViewIfNeeded();
    await noHorizontalOverflow(page);
  });
}
