import type { Locator, Page, Route } from "@playwright/test";
import type { CatalogModel, CatalogSearch, LocalServer, ServiceTestResult } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Models and AI services, the awkward paths: a server added while its row is still on screen, the picking that is
// thrown away without being asked about, a model name the sheet drops without a word, a catalogue search that says
// nothing while it runs, and what a screen reader is told when a check comes back. The hub's answers are played here,
// so the shared test hub's accounts stay as they were and nothing reaches a real AI service or this Mac's own servers.
//
// WHICH OF THESE FAIL ON TODAY'S CODE (each is marked again where it sits):
//  1. "In use" after a found server is added            — fails: web/src/views/AiServices.tsx never asks for the scan again.
//  2. Leaving with models ticked asks first             — fails: `dirty` in AddServiceSheet.tsx ignores the models picked.
//  3. A model name with a space says what's wrong       — fails: web/src/services.ts parseModelNames drops it silently.
//  4. A second catalogue search says it is working      — fails: the status line only says "Searching…" before the first answer.
//  5. The check's answer sits in a live region already there — fails: .svc-result is mounted together with its content.
// The last one (no overflow at the project's own width) is expected to pass: the catalogue sheet is only ever checked
// at 390 today, so it adds the 320–1440 widths the suite has projects for.

const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });

const account = (over: Record<string, unknown>) => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: "me@example.com", plan: "Plus", authMethod: "chatgpt", error: null, checkedAt: Date.now(), ...over });
const CODEX_MAIN = account({});
const CLAUDE_MAIN = account({ provider: "claude", plan: "Max" });

const none = { responses: "no", messages: "no", chat: "no" } as const;
const answer = (over: Partial<ServiceTestResult> = {}): ServiceTestResult => ({ reachable: true, authOk: true, server: null, protocols: { ...none }, models: [], works: [], problems: [], ...over });
/** A llama.cpp-shaped answer: Chat Completions, three models, the lane the "server on this machine" preset pins. */
const LOCAL = answer({
  protocols: { responses: "yes", messages: "yes", chat: "yes" },
  models: [{ id: "qwen3-coder:30b", contextWindow: 32_768 }, { id: "llama3.2:3b", contextWindow: 131_072 }, { id: "gemma3:4b", contextWindow: null }],
  works: [{ provider: "codex", via: "responses" }],
});

const OLLAMA: LocalServer = {
  id: "ollama", kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434",
  models: [{ id: "qwen3-coder:30b", contextWindow: 32_768, sizeBytes: 19e9, loaded: true }, { id: "llama3.2:3b", contextWindow: 131_072, sizeBytes: 2e9, loaded: false }, { id: "gemma3:4b", contextWindow: null, sizeBytes: 3e9, loaded: false }],
  memoryBytes: 21.5 * 1024 ** 3, protocols: { responses: "yes", messages: "yes", chat: "yes" }, accountIds: [],
};

const PICK = "huihui-ai/Huihui-Qwen3.5-27B-abliterated";
const TOTAL = 22_406;
const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({ id: PICK, modelClass: "qwen3.5-27b", params: 27, contextWindow: 32_768, concurrency: 2, gated: false, tools: true, toolsSaid: "docs", ...over });
/** What the hub answers for Featherless: nothing to tick, a catalogue to search. */
const CATALOGUE: ServiceTestResult = answer({ protocols: { responses: "no", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "adapter" }], catalog: { name: "featherless", total: TOTAL } });
const SUGGESTED: CatalogModel[] = [
  model(),
  model({ id: "OBLITERATUS/Qwen3.8-27B-OBLITERATED", modelClass: "qwen3_5-27b" }),
  model({ id: "wangzhang/gemma-4-31B-it-abliterated", modelClass: "gemma4-31b", params: 31, tools: false, toolsSaid: "list" }),
  model({ id: "meta-llama/Llama-3.3-70B-Instruct", modelClass: "llama33-70b", params: 70, concurrency: 4, gated: true, tools: false }),
];

/** The host:port an account's address points at, as the hub compares them (services.ts accountsUsing). */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

async function hub(page: Page) {
  const state = {
    accounts: [CLAUDE_MAIN, CODEX_MAIN] as Record<string, unknown>[],
    servers: [OLLAMA] as LocalServer[],
    saved: [] as Record<string, unknown>[],
    tests: [] as Record<string, unknown>[],
    searches: [] as string[],
    /** What POST /api/services/test answers. */
    test: (): ServiceTestResult => LOCAL,
    /** How long GET /api/services/catalog takes, so a search can be caught while it runs. */
    catalogDelayMs: 0,
    catalog: (q: string): CatalogSearch =>
      q
        ? { name: "featherless", q, models: SUGGESTED.filter((m) => m.id.toLowerCase().includes(q.toLowerCase())), matched: SUGGESTED.filter((m) => m.id.toLowerCase().includes(q.toLowerCase())).length, total: TOTAL }
        : { name: "featherless", q: "", models: SUGGESTED, matched: 544, total: TOTAL },
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await page.route(home("/api/accounts"), (route) => (route.request().method() === "GET" ? json(route, state.accounts) : route.fallback()));
  await page.route(home("/api/state"), async (route) => {
    const snapshot = await (await route.fetch()).json();
    return json(route, { ...snapshot, accounts: state.accounts });
  });
  await page.route(home("/api/services/test"), (route) => {
    state.tests.push(route.request().postDataJSON());
    return json(route, state.test());
  });
  await page.route(home("/api/accounts/endpoint"), (route) => {
    const body = route.request().postDataJSON();
    state.saved.push(body);
    const saved = account({ id: `new${state.saved.length}`, label: body.label || body.models[0], provider: body.provider, kind: "endpoint", account: null, plan: "Custom model", endpoint: { baseUrl: body.baseUrl, models: body.models, contextWindow: body.contextWindow, hasKey: !!body.apiKey, protocol: body.protocol, contexts: body.contexts } });
    state.accounts.push(saved);
    return json(route, saved);
  });
  // The hub works out which accounts use a server every time it answers, cached scan or not (hub/src/services.ts
  // localServers): an account added a moment ago counts. So this does too.
  await page.route(home("/api/local-servers"), (route) => {
    const servers = state.servers.map((s) => ({
      ...s,
      accountIds: state.accounts.filter((a) => a.kind === "endpoint" && hostOf(String((a.endpoint as { baseUrl?: string } | undefined)?.baseUrl ?? "")) === hostOf(s.baseUrl)).map((a) => ({ provider: a.provider, id: a.id })),
    }));
    return json(route, { servers, scannedAt: Date.now() });
  });
  await page.route((url) => url.pathname === "/api/services/catalog" && url.origin === "http://127.0.0.1:5198", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    state.searches.push(q);
    if (state.catalogDelayMs) await new Promise((r) => setTimeout(r, state.catalogDelayMs));
    return json(route, state.catalog(q));
  });
  await page.route((url) => url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/models") && url.origin === "http://127.0.0.1:5198", (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get("account") ?? "default";
    const provider = url.pathname.split("/")[3];
    const saved = state.accounts.find((a) => a.id === id && a.provider === provider && a.kind === "endpoint") as { endpoint: { models: string[] } } | undefined;
    if (!saved) return route.fallback();
    return json(route, { provider, accountId: id, live: true, error: null, models: saved.endpoint.models.map((m) => ({ id: m, label: m, description: null, efforts: [], defaultEffort: null, isDefault: false })) });
  });
  return state;
}

const settings = async (page: Page, { small = true } = {}) => {
  if (small) await phone(page);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "AI services", exact: true })).toBeVisible();
};
const sheet = (page: Page) => page.getByRole("dialog", { name: "Add an AI service", exact: true });
const openSheet = async (page: Page, service: string) => {
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: new RegExp(`^${service}`) }).click();
  return dialog;
};
const row = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const atTop = (target: Locator) => target.evaluate((el) => el.scrollIntoView({ block: "start" }));

// ---------------------------------------------------------------------------------------------------------------

test("a server added from Found on this machine says In use straight away, without a Rescan", async ({ page }) => {
  // EXPECTED TO FAIL on today's code. FoundOnThisMachine keeps the scan in its own state and only asks again on
  // Rescan or on a reconnect after an error (web/src/views/AiServices.tsx), so the row still offers "Use it" for a
  // server that now has an account. Tapping it again re-checks the server and ends in "There's already a Codex
  // account called Ollama" — or, if the person renames it, a second account for the one server. The New chat menu
  // already solves this by reading the accounts it has (web/src/newChat.ts `taken`); this list doesn't.
  const h = await hub(page);
  h.test = () => LOCAL;
  await settings(page);
  const found = page.getByRole("region", { name: "Found on this machine", exact: true });
  const ollama = row(page, "Ollama on 127.0.0.1:11434");
  await expect(ollama.getByRole("button", { name: "Use it", exact: true })).toBeVisible();

  await ollama.getByRole("button", { name: "Use it", exact: true }).click();
  const dialog = sheet(page);
  await expect(dialog.getByText("3 models found", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => h.saved.length).toBe(1);
  await expect(row(page, "Codex · Ollama")).toBeVisible();

  // The server is in use now, and the row a person is looking at should say so rather than offering to add it again.
  await expect(found.getByText("In use", { exact: true })).toBeVisible();
  await expect(ollama.getByRole("button", { name: "Use it", exact: true })).toHaveCount(0);
});

test("closing the Add sheet with models picked asks first, like closing it with a key typed in", async ({ page }) => {
  // EXPECTED TO FAIL on today's code. `dirty` in AddServiceSheet.tsx counts the key, the address, the name, typed
  // model names and a typed context — but not the models ticked, nor the agent picked. A server on this machine needs
  // no key and fills its own address and name in, so nothing counts as a change: one stray tap on the backdrop (easy
  // on a phone, where the sheet fills the screen) throws away the check and every model ticked, with no way back.
  const h = await hub(page);
  h.test = () => LOCAL;
  await settings(page);
  const dialog = await openSheet(page, "A server on this machine");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("3 models found", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /gemma3:4b/ }).uncheck();
  await dialog.getByRole("checkbox", { name: /llama3\.2:3b/ }).uncheck();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(1);

  // A tap on the dark part of the screen, beside the sheet.
  await page.mouse.click(8, 8);
  await expect(page.getByRole("alert").filter({ hasText: "Discard changes?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(1);
});

test("a typed model name with a space in it says what's wrong instead of vanishing", async ({ page }) => {
  // EXPECTED TO FAIL on today's code. web/src/services.ts parseModelNames drops any name with a space in it (an agent
  // passes a model name as one word), so "qwen3 8b" becomes nothing at all: "Add it" goes grey, the context field
  // disappears with it, and not a word on screen says why. The names it keeps are also silently cut to the first 20.
  const h = await hub(page);
  h.test = () => answer({ protocols: { responses: "yes", messages: "no", chat: "no" }, works: [{ provider: "codex", via: "responses" }] });
  await settings(page);
  const dialog = await openSheet(page, "Another server");
  await dialog.getByLabel("Server address", { exact: true }).fill("https://llm.example.com");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("No models listed", { exact: true })).toBeVisible();

  const add = dialog.getByRole("button", { name: "Add it", exact: true });
  await dialog.getByLabel("Model names", { exact: true }).fill("qwen3 8b");
  await expect(add).toBeDisabled();
  // Either the name is taken, or the sheet says a model name is one word: today it does neither.
  await expect(dialog.getByText(/space/i)).toBeVisible();
});

test("a catalogue search says it is working, every time, not only the first time", async ({ page }) => {
  // EXPECTED TO FAIL on today's code. The status line under the search box reads `busy && !answer ? "Searching…" : …`
  // (AddServiceSheet.tsx CatalogPicker), so once one answer has come back the line keeps the last answer's words for
  // the whole of the next search: the old models stay on screen, nothing says a search is running, and a screen
  // reader is told nothing until the answer lands.
  const h = await hub(page);
  h.test = () => CATALOGUE;
  await settings(page);
  const dialog = await openSheet(page, "Featherless");
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("22,406 models to search", { exact: true })).toBeVisible();
  // The first search: before its answer, the line says what is happening.
  await expect(dialog.getByText("A few uncensored ones of the 22,406. Type a name to find another.", { exact: true })).toBeVisible();

  h.catalogDelayMs = 1500;
  await dialog.getByRole("textbox", { name: "Search models", exact: true }).fill("kimi");
  await expect(dialog.getByText("Searching…", { exact: true })).toBeVisible();
  h.catalogDelayMs = 0;
});

test("what a check found is read out: its live region is on the screen before the check runs", async ({ page }) => {
  // EXPECTED TO FAIL on today's code. The ✓ lines land in `<div class="svc-result" aria-live="polite">`
  // (web/src/views/ServiceLines.tsx), but that div is only put on the screen together with its first contents
  // (`{result && <ServiceLines …/>}`), and a live region that appears with its text is not announced: a screen reader
  // user presses Test and hears nothing at all, while a failure (role="alert") is announced. The fix is to keep the
  // empty region there from the start, as the search box's own `role="status"` line already is.
  const h = await hub(page);
  h.test = () => LOCAL;
  await settings(page);
  const dialog = await openSheet(page, "A server on this machine");
  await expect(dialog.locator("[aria-live]")).toHaveCount(1);

  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("3 models found", { exact: true })).toBeVisible();
  await expect(dialog.locator("[aria-live]")).toHaveCount(1);
});

test("the catalogue sheet fits this screen, whatever width it is", async ({ page }) => {
  // Expected to PASS: coverage the suite doesn't have. featherless.spec.ts sets 390 px itself, so the long Hugging
  // Face names, their "No tools" and "Gated" marks and "Make default" beside them are never checked at 320, 768 or
  // 1440 — the widths this suite has projects for.
  const h = await hub(page);
  h.test = () => CATALOGUE;
  await settings(page, { small: false });
  const dialog = await openSheet(page, "Featherless");
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(SUGGESTED.length);
  await dialog.getByRole("checkbox", { name: new RegExp(PICK) }).check();
  await expect(dialog.getByText("Default", { exact: true })).toBeVisible();
  await atTop(dialog.getByText("Models", { exact: true }));
  await noHorizontalOverflow(page);
});
