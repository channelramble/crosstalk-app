import type { Locator, Page, Route, WebSocketRoute } from "@playwright/test";
import type { LocalServer, ServiceTestResult } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Settings → AI services, with the hub's answers played here (docs/SPEC-0.4.md section 3): the shared test hub's accounts
// and settings stay as they were, and nothing here reaches an AI service or this Mac's own model servers.
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
/** The machine this app opens from (the test hub), as requests to it are addressed. */
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;
const MARCH_3 = new Date(2026, 2, 3, 12).getTime();

const account = (over: Record<string, unknown>) => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: "me@example.com", plan: "Plus", authMethod: "chatgpt", error: null, checkedAt: Date.now(), ...over });
const endpoint = (over: Record<string, unknown> = {}) => ({ baseUrl: "https://api.moonshot.ai", models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"], contextWindow: 1_048_576, hasKey: true, ...over });
const modelOption = (id: string) => ({ id, label: id, description: null, efforts: [], defaultEffort: null, isDefault: false });
const KIMI = account({ id: "kimi1", label: "Kimi K3.1 Pro", kind: "endpoint", signedIn: true, account: null, plan: "Custom model", endpoint: endpoint() });
const WORK_KEY = account({ provider: "claude", id: "key1", label: "Work key", kind: "apikey", account: null, plan: null });
const CLAUDE_MAIN = account({ provider: "claude", plan: "Max" });
const CODEX_MAIN = account({});

const none = { responses: "no", messages: "no", chat: "no" } as const;
const NAMES = { claude: "Claude Code", codex: "Codex" } as const;
const answer = (over: Partial<ServiceTestResult> = {}): ServiceTestResult => ({ reachable: true, authOk: true, server: null, protocols: { ...none }, models: [], works: [], problems: [], ...over });
const DEEPSEEK = answer({
  protocols: { responses: "no", messages: "no", chat: "yes" },
  models: [{ id: "deepseek-chat", contextWindow: 131_072 }, { id: "deepseek-reasoner", contextWindow: 131_072 }],
  works: [{ provider: "codex", via: "adapter" }],
});

/** The hub's side of the new routes: what the app sent comes in the arrays; `reply` holds what each route answers next. */
async function hub(page: Page, accounts: Record<string, unknown>[] = [CLAUDE_MAIN, WORK_KEY, CODEX_MAIN, KIMI]) {
  const state = {
    accounts: [...accounts],
    tests: [] as Record<string, unknown>[],
    saved: [] as Record<string, unknown>[],
    refreshed: [] as string[],
    /** Each account whose own check was asked ("claude/key1"): the route behind Test on a plan sign-in or a saved key. */
    checked: [] as string[],
    scans: 0,
    /** The query of each scan: "" when Settings opens, "?fresh=1" for Rescan. */
    scanQueries: [] as string[],
    /** The scan the hub keeps for ten seconds, as it does: only ?fresh=1 looks again. */
    scanKept: null as { servers: LocalServer[]; scannedAt: number } | null,
    /** What POST /api/services/test answers: a result, a status to fail with (the hub's own plain "not found", as a hub without the route says it), an answer in the hub's own words, or "drop" to lose the connection. */
    test: (): ServiceTestResult | number | { status: number; error: string } | "drop" => DEEPSEEK,
    /** An account's own check: the account as it stands now (what the agent says), or a status to fail with. */
    check: (a: Record<string, unknown>): Record<string, unknown> | number => a,
    servers: [] as LocalServer[] | number,
    /** POST refresh-models: an account, or a status to fail with. */
    refresh: (): Record<string, unknown> | number => KIMI,
    catalogs: new Map<string, Record<string, unknown>>(),
    /** Agents the hub says aren't installed. */
    missing: [] as string[],
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await page.route(home("/api/accounts"), (route) => (route.request().method() === "GET" ? json(route, state.accounts) : route.fallback()));
  // The app's first look at the hub carries the accounts too: the same list, or a late answer would put the hub's own back.
  await page.route(home("/api/state"), async (route) => {
    const snapshot = await (await route.fetch()).json();
    const providers = snapshot.providers.map((p: { provider: string }) => (state.missing.includes(p.provider) ? { ...p, installed: false } : p));
    return json(route, { ...snapshot, accounts: state.accounts, providers });
  });
  await page.route(home("/api/services/test"), (route) => {
    const asked = route.request().postDataJSON() as { provider?: keyof typeof NAMES };
    state.tests.push(asked);
    const r = state.test();
    if (r === "drop") return route.abort("failed");
    if (typeof r === "number") return json(route, { error: "not found" }, r);
    if ("status" in r) return json(route, { error: r.error }, r.status);
    // As the hub does when an agent is named that can't run the service but the other can.
    const other = r.works[0]?.provider;
    const note = asked.provider && other && !r.works.some((w) => w.provider === asked.provider) ? [`${NAMES[asked.provider]} can't use this server, but ${NAMES[other]} can. Add it under ${NAMES[other]} instead.`] : [];
    return json(route, { ...r, problems: [...r.problems, ...note] });
  });
  await page.route(home("/api/accounts/endpoint"), (route) => {
    const body = route.request().postDataJSON();
    state.saved.push(body);
    const saved = account({ id: "new1", label: body.label ?? body.models[0], provider: body.provider, kind: "endpoint", account: null, plan: "Custom model", endpoint: endpoint({ baseUrl: body.baseUrl, models: body.models, hasKey: !!body.apiKey, protocol: body.protocol, chatPath: body.chatPath, contexts: body.contexts, ...(body.extra ? { extra: body.extra } : {}) }) });
    state.accounts.push(saved);
    return json(route, saved);
  });
  await page.route(home("/api/local-servers"), (route) => {
    state.scans++;
    const query = new URL(route.request().url()).search;
    state.scanQueries.push(query);
    if (typeof state.servers === "number") return json(route, { error: "Not found" }, state.servers);
    if (query !== "?fresh=1" && state.scanKept) return json(route, state.scanKept);
    state.scanKept = { servers: state.servers, scannedAt: Date.now() };
    return json(route, state.scanKept);
  });
  await page.route((url) => /^\/api\/accounts\/[a-z]+\/[\w-]+\/refresh-models$/.test(url.pathname) && url.origin === "http://127.0.0.1:5198", (route) => {
    state.refreshed.push(new URL(route.request().url()).pathname);
    const r = state.refresh();
    return typeof r === "number" ? json(route, { error: "The server didn't answer" }, r) : json(route, r);
  });
  // An account's own check (Test on a plan sign-in or a saved key) must never reach this Mac's real agents.
  await page.route((url) => /^\/api\/accounts\/[a-z]+\/[\w-]+\/refresh$/.test(url.pathname) && url.origin === "http://127.0.0.1:5198", (route) => {
    const [, , , provider, id] = new URL(route.request().url()).pathname.split("/");
    const index = state.accounts.findIndex((a) => a.provider === provider && a.id === id);
    state.checked.push(`${provider}/${id}`);
    const r = index < 0 ? 404 : state.check(state.accounts[index]);
    if (typeof r === "number") return json(route, { error: "No such account" }, r);
    state.accounts[index] = r;
    return json(route, r);
  });
  await page.route((url) => url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/models") && url.origin === "http://127.0.0.1:5198", (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get("account") ?? "default";
    const provider = url.pathname.split("/")[3];
    // A custom model's list is its saved names, as the hub gives it when the server answers.
    const saved = state.accounts.find((a) => a.id === id && a.provider === provider && a.kind === "endpoint") as { endpoint: { models: string[] } } | undefined;
    const catalog = state.catalogs.get(id) ?? (saved ? { provider, accountId: id, live: true, error: null, models: saved.endpoint.models.map(modelOption) } : null);
    // Anyone else's list is the test hub's own stand-in.
    return catalog ? json(route, catalog) : route.fallback();
  });
  return state;
}

/** The app's live updates, played here: only what's sent to it (a spending event). */
async function liveUpdates(page: Page) {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  return { send: (e: unknown) => socket!.send(JSON.stringify(e)), ready: () => expect.poll(() => !!socket).toBe(true) };
}

const totals = (usd: number) => ({ usd, replies: usd ? 3 : 0, unpriced: 0, inputTokens: 0, outputTokens: 0 });
const row = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const addService = (page: Page) => page.getByRole("button", { name: "Add an AI service", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Add an AI service", exact: true });
const openSheet = async (page: Page, service: string) => {
  await addService(page).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: new RegExp(`^${service}`) }).click();
  return dialog;
};
const settings = async (page: Page) => {
  await phone(page);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "AI services", exact: true })).toBeVisible();
};
/** Scrolls so the element starts at the top of the screen (a phone screenshot of just what's being shown). */
const atTop = (target: Locator) => target.evaluate((el) => el.scrollIntoView({ block: "start" }));
const tip = async (button: Locator, text: string) => {
  await button.click();
  await expect(button.locator("xpath=..").getByRole("note")).toHaveText(text);
};

test("the list shows every account with its kind, status, models and what it cost this month", async ({ page }) => {
  const live = await liveUpdates(page);
  await hub(page);
  await settings(page);
  await live.ready();
  live.send({ t: "spend", accounts: [
    { provider: "codex", account: "kimi1", label: "Kimi K3.1 Pro", kind: "endpoint", today: totals(0.4), month: totals(4.2), total: totals(9), budget: { limitUsd: 5, period: "month", since: 0, usedUsd: 4.2, percent: 84, state: "warn" } },
    { provider: "codex", account: "default", label: "Main", kind: "signin", today: totals(1), month: totals(12.4), total: totals(30), budget: null },
  ] });
  await expect(page.getByText("Add any AI that works with Claude Code or Codex. Crosstalk checks it before you use it.", { exact: true })).toBeVisible();
  const kimi = row(page, "Codex · Kimi K3.1 Pro");
  await expect(kimi.getByText("Codex · Custom model · api.moonshot.ai", { exact: true })).toBeVisible();
  await expect(kimi.getByText("Not tested yet", { exact: true })).toBeVisible();
  await expect(kimi.getByText("2 models: kimi-k3.1-pro, kimi-k3.1-pro-highspeed", { exact: true })).toBeVisible();
  await expect(kimi.getByText("$4.20 this month", { exact: true })).toHaveClass(/warn/);
  // A plan sign-in isn't billed: its figure is what the use would cost.
  await expect(row(page, "Codex · Main").getByText("≈$12.40 this month", { exact: true })).toBeVisible();
  await expect(row(page, "Codex · Main").getByText("Signed in", { exact: true })).toBeVisible();
  await expect(row(page, "Claude Code · Work key").getByText("Claude Code · API key, billed per use", { exact: true })).toBeVisible();
  // Every agent's own sign-in comes before its other accounts.
  const names = await page.locator(".svc-row .svc-name").allTextContents();
  expect(names).toEqual(["Main", "Work key", "Main", "Kimi K3.1 Pro"]);
  await atTop(page.getByRole("heading", { name: "AI services", exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("01-ai-services-list.png"), animations: "disabled" });
  await atTop(row(page, "Codex · Kimi K3.1 Pro"));
  await page.screenshot({ ...shot("01b-ai-services-list-end.png"), animations: "disabled" });
});

test("a service on the chat adapter says what Codex's tools cost on it, as last measured, and one never used says nothing", async ({ page }) => {
  // The thing the person could not tell before starting a chat: Codex attaches every tool their own Codex and ChatGPT-app
  // setup offers to each request (hundreds of them and over 100,000 tokens with many connectors), which no 16k model
  // can hold. The hub measures each request that goes through the translator (hub/src/adapter/cost.ts) and the row says it.
  const QWEN = account({
    id: "qwen1",
    label: "Qwen here",
    kind: "endpoint",
    account: null,
    plan: "Custom model",
    endpoint: endpoint({
      baseUrl: "http://127.0.0.1:8080",
      models: ["qwen3-8b"],
      contextWindow: 16_384,
      hasKey: false,
      protocol: "chat",
      toolCost: { at: MARCH_3, model: "qwen3-8b", tools: 133_500, toolCount: 361, prompt: 141_085, window: 16_384, dropped: 343 },
    }),
  });
  await hub(page, [CODEX_MAIN, QWEN, KIMI]);
  await settings(page);
  const qwen = row(page, "Codex · Qwen here");
  await expect(qwen.getByText("Codex's tools take about 134,000 tokens; qwen3-8b holds 16,384. Crosstalk leaves 343 of them out so a chat can start. Measured on March 3.", { exact: true })).toBeVisible();
  // A service no request has gone through borrows nobody else's figure.
  await expect(row(page, "Codex · Kimi K3.1 Pro").getByText(/Codex's tools take/)).toHaveCount(0);
  await expect(row(page, "Codex · Main").getByText(/Codex's tools take/)).toHaveCount(0);
  await atTop(qwen);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("01c-ai-services-tool-cost.png"), animations: "disabled" });
});

test("anchors still scroll: every section keeps its id, and the agents' cards come after the list", async ({ page }) => {
  await hub(page);
  await settings(page);
  // The ids of this tab (the other tabs' own ids, and the address for each, are settingsTabs.spec.ts's).
  for (const id of ["ai-services", "agent-claude", "agent-codex"]) {
    const target = page.locator(`#${id}`);
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
  }
  const [list, card] = await Promise.all([page.locator("#ai-services").boundingBox(), page.locator("#agent-claude").boundingBox()]);
  expect(card!.y).toBeGreaterThan(list!.y);
  // The agents' own cards are all still there.
  await expect(page.locator("#agent-claude").getByRole("region", { name: "Claude Code accounts", exact: true })).toBeVisible();
  await expect(page.locator("#agent-codex").getByRole("button", { name: "Add a custom model", exact: true })).toBeVisible();
});

test("Test on a custom model shows what the check found, and a check that can't run says what to do", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const kimi = row(page, "Codex · Kimi K3.1 Pro");
  h.test = () => answer({ protocols: { responses: "yes", messages: "no", chat: "yes" }, models: [{ id: "kimi-k3.1-pro", contextWindow: 1_048_576 }, { id: "kimi-k3.1-pro-highspeed", contextWindow: 1_048_576 }, { id: "kimi-k2", contextWindow: null }], works: [{ provider: "codex", via: "responses" }] });
  await kimi.getByRole("button", { name: "Test", exact: true }).click();
  await expect(kimi.getByText("3 models found", { exact: true })).toBeVisible();
  await expect(kimi.getByText("Works with Codex", { exact: true })).toBeVisible();
  // The status says Reachable once; the lines under it carry on from there.
  await expect(kimi.getByText("Reachable", { exact: true })).toHaveCount(1);
  // It tested the saved key, at the saved address.
  expect(h.tests).toEqual([{ baseUrl: "https://api.moonshot.ai", accountId: "kimi1", provider: "codex" }]);
  await atTop(kimi);
  await page.screenshot({ ...shot("02-row-tested.png"), animations: "disabled" });

  // The hub can't be reached: it says so, and Test is the way to try again.
  h.test = () => "drop";
  await kimi.getByRole("button", { name: "Test", exact: true }).click();
  await expect(kimi.getByRole("alert")).toContainText("The check didn't run");
  await expect(kimi.getByRole("alert")).toContainText("Press Test to try again.");
  await expect(kimi.getByText("3 models found", { exact: true })).toBeVisible();
  h.test = () => answer({ reachable: false, authOk: null, problems: ["Nothing answered at that address. Check the address, then press Test."] });
  await kimi.getByRole("button", { name: "Test", exact: true }).click();
  await expect(kimi.getByText("Can't reach it", { exact: true })).toHaveCount(1);
  await expect(kimi.getByText("Nothing answered at that address. Check the address, then press Test.", { exact: true })).toBeVisible();
  await expect(kimi.getByRole("alert")).toHaveCount(0);
  await atTop(kimi);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("03-row-unreachable.png"), animations: "disabled" });
});

test("Test on a saved API key is the account's own check, like a plan sign-in's, and shows what the agent says", async ({ page }) => {
  const teamKey = account({ id: "key2", label: "Team key", kind: "apikey", account: null, plan: null });
  const h = await hub(page, [CLAUDE_MAIN, WORK_KEY, CODEX_MAIN, teamKey, KIMI]);
  await settings(page);
  const key = row(page, "Claude Code · Work key");
  await expect(key.getByText("Key accepted", { exact: true })).toBeVisible();
  // The agent stops accepting the key. Test asks it again, through the route Check under Accounts uses.
  h.check = (a) => ({ ...a, signedIn: false });
  await key.getByRole("button", { name: "Test", exact: true }).click();
  await expect(key.getByText("Key not accepted", { exact: true })).toBeVisible();
  await expect(key.getByText("Replace the key under Claude Code below.", { exact: true })).toBeVisible();
  expect(h.checked).toEqual(["claude/key1"]);
  // The service check finds custom models only: it was never asked about the key (it would answer "No such custom model").
  expect(h.tests).toEqual([]);
  await expect(key.getByRole("alert")).toHaveCount(0);
  await atTop(key);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("02b-key-not-accepted.png"), animations: "disabled" });
  // A key that works again.
  h.check = (a) => ({ ...a, signedIn: true });
  await key.getByRole("button", { name: "Test", exact: true }).click();
  await expect(key.getByText("Key accepted", { exact: true })).toBeVisible();
  await expect(key.getByText("Replace the key under Claude Code below.", { exact: true })).toHaveCount(0);
  expect(h.checked).toEqual(["claude/key1", "claude/key1"]);
  // A Codex key is the same.
  const team = row(page, "Codex · Team key");
  await team.getByRole("button", { name: "Test", exact: true }).click();
  await expect(team.getByText("Key accepted", { exact: true })).toBeVisible();
  expect(h.checked.at(-1)).toBe("codex/key2");
  expect(h.tests).toEqual([]);
});

test("a 404 from a hub that has the route is reported as it came: only a hub without the route is too old", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const tooOld = "This machine's hub is too old to check services.";
  // The key's account was removed meanwhile (on another phone, say): the check's route says so in its own words.
  const key = row(page, "Claude Code · Work key");
  h.check = () => 404;
  await key.getByRole("button", { name: "Test", exact: true }).click();
  await expect(key.getByRole("alert")).toHaveText("The check didn't run: No such account. Press Test to try again.");
  // The same for the service check, which finds a custom model among its own.
  const kimi = row(page, "Codex · Kimi K3.1 Pro");
  h.test = () => ({ status: 404, error: "No such custom model" });
  await kimi.getByRole("button", { name: "Test", exact: true }).click();
  await expect(kimi.getByRole("alert")).toHaveText("The check didn't run: No such custom model. Press Test to try again.");
  await expect(page.getByText(tooOld, { exact: false })).toHaveCount(0);
  // A hub without the route says its plain "not found": that one is too old.
  h.test = () => 404;
  await kimi.getByRole("button", { name: "Test", exact: true }).click();
  await expect(kimi.getByRole("alert")).toContainText(tooOld);
});

test("Test on a plan sign-in rechecks it, and a sign-in that's gone says where to fix it", async ({ page }) => {
  const h = await hub(page, [CLAUDE_MAIN, account({ signedIn: false })]);
  await settings(page);
  const main = row(page, "Codex · Main");
  await expect(main.getByText("Not signed in", { exact: true })).toBeVisible();
  await expect(main.getByText("Press Sign in under Codex below.", { exact: true })).toBeVisible();
  // The check is the account's own, the same as Check under Accounts: no service is asked.
  let rechecked = 0;
  await page.route((url) => url.pathname === "/api/accounts/codex/default/refresh", (route) => (rechecked++, route.fulfill({ json: CODEX_MAIN })));
  await main.getByRole("button", { name: "Test", exact: true }).click();
  await expect.poll(() => rechecked).toBe(1);
  expect(h.tests).toEqual([]);
  await expect(main.getByRole("button", { name: "Test", exact: true })).toBeEnabled();
});

test("Add an AI service: pick DeepSeek, follow the steps, Test, choose models and add it", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await addService(page).click();
  const dialog = sheet(page);
  // Every service the spec names, each with a line about it.
  for (const title of ["Kimi", "DeepSeek", "Mistral", "OpenRouter", "Groq", "xAI", "Venice", "Google Gemini", "A server on this machine", "Another server"]) {
    await expect(dialog.getByRole("button", { name: new RegExp(`^${title}`) })).toBeVisible();
  }
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("04-add-sheet-presets.png"), animations: "disabled" });

  await dialog.getByRole("button", { name: /^DeepSeek/ }).click();
  const steps = dialog.getByRole("listitem");
  await expect(steps.nth(0)).toContainText("Get a key at platform.deepseek.com.");
  await expect(steps.nth(1)).toContainText("Paste it here.");
  await expect(steps.nth(2)).toContainText("Press Test.");
  const open = dialog.getByRole("link", { name: "Open platform.deepseek.com", exact: true });
  await expect(open).toHaveAttribute("href", "https://platform.deepseek.com/api_keys");
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", /noreferrer/);
  const testButton = dialog.getByRole("button", { name: "Test", exact: true });
  await expect(testButton).toBeDisabled();
  await tip(dialog.getByRole("button", { name: "What's an API key?", exact: true }), "A long password from the service's website. Crosstalk keeps it on this machine and sends it only to that service.");
  await page.screenshot({ ...shot("05-add-sheet-steps-help.png"), animations: "disabled" });

  await dialog.getByLabel("API key", { exact: true }).fill("sk-deepseek-1234");
  await expect(testButton).toBeEnabled();
  await testButton.click();
  await expect(dialog.getByText("2 models found", { exact: true })).toBeVisible();
  expect(h.tests).toEqual([{ baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek-1234" }]);
  for (const line of ["Reachable", "Key works", "Works with Codex"]) await expect(dialog.getByText(line, { exact: true })).toBeVisible();
  // It only speaks the older chat style: the adapter does the translating, and says so.
  await tip(dialog.getByRole("button", { name: "What's the chat adapter?", exact: true }), "Some services only speak an older style. Crosstalk translates for them on this machine.");
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await expect(dialog.getByRole("checkbox", { name: /deepseek-chat/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /deepseek-reasoner/ })).toBeChecked();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("DeepSeek");
  await atTop(dialog.getByText("Reachable", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("06-test-ok.png"), animations: "disabled" });

  // The first model is the default; another can take its place.
  await expect(dialog.locator(".svc-model-list li").first()).toContainText("Default");
  await dialog.locator(".svc-model-list li").nth(1).getByRole("button", { name: "Make default", exact: true }).click();
  await expect(dialog.locator(".svc-model-list li").nth(1)).toContainText("Default");
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toEqual({
    provider: "codex", baseUrl: "https://api.deepseek.com", label: "DeepSeek", apiKey: "sk-deepseek-1234",
    models: ["deepseek-reasoner", "deepseek-chat"], contextWindow: 131_072, protocol: "chat",
    contexts: { "deepseek-chat": 131_072, "deepseek-reasoner": 131_072 },
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Added. Pick it as the account in a new Codex chat.", { exact: true })).toBeVisible();
  // It's in the list now.
  const added = row(page, "Codex · DeepSeek");
  await expect(added.getByText("Codex · Custom model · api.deepseek.com · chat adapter", { exact: true })).toBeVisible();
  await expect(added.getByText("2 models: deepseek-reasoner, deepseek-chat", { exact: true })).toBeVisible();
});

test("a check with problems shows each with its fix, and Add it stays off until the key is changed and tested", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const dialog = await openSheet(page, "Mistral");
  h.test = () => answer({ authOk: false, protocols: { responses: "no", messages: "no", chat: "yes" }, problems: ["This key was refused. Check it at console.mistral.ai, then paste it again."] });
  await dialog.getByLabel("API key", { exact: true }).fill("wrong-key");
  // A keyboard's Go in the key field is Test.
  await dialog.getByLabel("API key", { exact: true }).press("Enter");
  await expect(dialog.getByText("Key refused", { exact: true })).toBeVisible();
  await expect(dialog.getByText("This key was refused. Check it at console.mistral.ai, then paste it again.", { exact: true })).toBeVisible();
  // The key is what's wrong: nothing is said about the service, which the hub never got to ask.
  await expect(dialog.locator(".svc-lines li")).toHaveText(["✓Reachable", "✗Key refused"]);
  await expect(dialog.getByText("No models listed", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Not usable with Claude Code or Codex yet", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("07-test-problems.png"), animations: "disabled" });
  // A new key: the old answer no longer applies.
  await dialog.getByLabel("API key", { exact: true }).fill("right-key");
  await expect(dialog.getByText("Key refused", { exact: true })).toHaveCount(0);
  h.test = () => answer({ protocols: { responses: "no", messages: "no", chat: "yes" }, models: [{ id: "codestral-latest", contextWindow: 262_144 }], works: [{ provider: "codex", via: "adapter" }] });
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("Works with Codex", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeEnabled();
  expect(h.saved).toEqual([]);
});

test("a service both agents can run lets you choose which one it's added for", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const dialog = await openSheet(page, "OpenRouter");
  h.test = () => answer({
    protocols: { responses: "yes", messages: "yes", chat: "yes" },
    models: [{ id: "anthropic/claude-sonnet-4.6", contextWindow: 1_000_000 }, { id: "openai/gpt-5.5", contextWindow: 400_000 }],
    works: [{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }],
  });
  await dialog.getByLabel("API key", { exact: true }).fill("sk-or-1");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  const choice = dialog.getByRole("radiogroup", { name: "Use it with", exact: true });
  // OpenRouter's preferred agent is Claude Code.
  await expect(choice.getByRole("radio", { name: "Claude Code", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByText("Works with Codex", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Works with Claude Code", { exact: true })).toBeVisible();
  await atTop(dialog.getByText("Reachable", { exact: true }));
  await page.screenshot({ ...shot("08-both-agents.png"), animations: "disabled" });
  await choice.getByRole("radio", { name: "Codex", exact: true }).click();
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toMatchObject({ provider: "codex", protocol: "responses", baseUrl: "https://openrouter.ai/api", label: "OpenRouter", models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5"] });
});

test("a service only the other agent can run says so with a tick, not with a red line to add it there", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  // OpenRouter's preferred agent is Claude Code, and only Codex can run this one: the sheet has already picked Codex.
  const dialog = await openSheet(page, "OpenRouter");
  h.test = () => answer({ protocols: { responses: "yes", messages: "no", chat: "yes" }, models: [{ id: "openai/gpt-5.5", contextWindow: 400_000 }], works: [{ provider: "codex", via: "responses" }] });
  await dialog.getByLabel("API key", { exact: true }).fill("sk-or-1");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("Works with Codex", { exact: true })).toBeVisible();
  // No agent was named in the check, so the hub had nothing to say about the one the preset prefers.
  expect(h.tests).toEqual([{ baseUrl: "https://openrouter.ai/api", apiKey: "sk-or-1" }]);
  await expect(dialog.getByText("can't use this server", { exact: false })).toHaveCount(0);
  await expect(dialog.locator(".svc-problem")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toMatchObject({ provider: "codex", protocol: "responses", label: "OpenRouter", models: ["openai/gpt-5.5"] });
});

test("an agent that isn't installed isn't offered first, and when it's the only one the sheet says what to install", async ({ page }) => {
  const h = await hub(page);
  h.missing = ["codex"];
  await settings(page);
  let dialog = await openSheet(page, "OpenRouter");
  h.test = () => answer({ models: [{ id: "m1", contextWindow: 131_072 }], works: [{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }] });
  await dialog.getByLabel("API key", { exact: true }).fill("sk-or-1");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  // Both can run it; Claude Code is the one that's installed, so it's the one picked.
  const choice = dialog.getByRole("radiogroup", { name: "Use it with", exact: true });
  await expect(choice.getByRole("radio", { name: "Claude Code", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeEnabled();
  await choice.getByRole("radio", { name: "Codex", exact: true }).click();
  const missing = dialog.getByRole("alert").filter({ hasText: "Codex isn't installed" });
  await expect(missing).toHaveText("Codex isn't installed on this machine yet. Close this, press Install under Codex below, then add the service.");
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();
  await atTop(dialog.getByText("Reachable", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("16-agent-not-installed.png"), animations: "disabled" });
  // Leaving with a key typed in asks first.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // A service only Codex can run: the way out is the same.
  h.test = () => answer({ models: [{ id: "m1", contextWindow: 131_072 }], works: [{ provider: "codex", via: "responses" }] });
  dialog = await openSheet(page, "xAI");
  await dialog.getByLabel("API key", { exact: true }).fill("xai-1");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Codex isn't installed" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();
  expect(h.saved).toEqual([]);
});

test("Gemini keeps its chat path; more than 20 models start unpicked, filter and cap at 20", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const dialog = await openSheet(page, "Google Gemini");
  const listed = Array.from({ length: 25 }, (_, i) => ({ id: i % 2 ? `gemini-flash-${i}` : `gemini-pro-${i}`, contextWindow: i === 0 ? 1_048_576 : null }));
  h.test = () => answer({ protocols: { responses: "no", messages: "no", chat: "yes" }, models: listed, works: [{ provider: "codex", via: "adapter" }] });
  await dialog.getByLabel("API key", { exact: true }).fill("AIza-test");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("25 models found", { exact: true })).toBeVisible();
  expect(h.tests[0]).toEqual({ baseUrl: "https://generativelanguage.googleapis.com", apiKey: "AIza-test", chatPath: "/v1beta/openai/chat/completions" });
  // Too many to take them all: none start picked, and Add it waits.
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Filter models", exact: true }).fill("flash");
  await expect(dialog.getByRole("checkbox")).toHaveCount(12);
  await dialog.getByRole("checkbox", { name: /gemini-flash-3/ }).check();
  await dialog.getByRole("textbox", { name: "Filter models", exact: true }).fill("");
  await dialog.getByRole("checkbox", { name: /gemini-pro-0/ }).check();
  await atTop(dialog.getByText("Models", { exact: true }));
  await page.screenshot({ ...shot("09-many-models.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toEqual({
    provider: "codex", baseUrl: "https://generativelanguage.googleapis.com", label: "Gemini", apiKey: "AIza-test", models: ["gemini-flash-3", "gemini-pro-0"],
    // The default's size is what older hubs read; each model's own size goes with it.
    contextWindow: null, protocol: "chat", chatPath: "/v1beta/openai/chat/completions", contexts: { "gemini-pro-0": 1_048_576 },
  });
});

test("Venice: its key page, the line about its own prompt, a model that can't run tools marked and left unticked", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const dialog = await openSheet(page, "Venice");
  await expect(dialog.getByRole("link", { name: "docs.venice.ai", exact: true })).toHaveAttribute("href", "https://docs.venice.ai");
  // One short line about the one thing Crosstalk does for this service.
  await expect(dialog.getByText("Crosstalk turns Venice's own prompt off, so the agent follows its own instructions.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("listitem").nth(0)).toContainText("Get a key at venice.ai/settings/api.");
  await expect(dialog.getByRole("link", { name: "Open venice.ai/settings/api", exact: true })).toHaveAttribute("href", "https://venice.ai/settings/api");
  // Venice answers at its chat address and at its beta Responses one, and says per model whether it can run tool calls.
  h.test = () => answer({
    protocols: { responses: "yes", messages: "no", chat: "yes" },
    models: [{ id: "zai-org-glm-5", contextWindow: 198_000, tools: true }, { id: "venice-uncensored-1-2", contextWindow: 128_000, tools: true }, { id: "hermes-3-llama-3.1-405b", contextWindow: 128_000, tools: false }],
    works: [{ provider: "codex", via: "responses" }],
  });
  await dialog.getByLabel("API key", { exact: true }).fill("sk-venice-1234");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("3 models found", { exact: true })).toBeVisible();
  expect(h.tests).toEqual([{ baseUrl: "https://api.venice.ai/api", apiKey: "sk-venice-1234" }]);
  // Codex can run it, and the line says the adapter is in between: Venice's preset holds it to the chat lane, the only
  // one where Crosstalk can turn Venice's own prompt off.
  await expect(dialog.getByText("Works with Codex", { exact: true })).toBeVisible();
  await expect(dialog.getByText("through the chat adapter", { exact: true })).toBeVisible();
  // The one that can't run tools is marked and not picked for you; the other two are.
  await expect(dialog.getByText(/can't run commands or edit files/)).toBeVisible();
  await expect(dialog.locator(".svc-model-list li", { hasText: "hermes-3-llama-3.1-405b" }).getByText("No tools", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /hermes-3/ })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /zai-org-glm-5/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /venice-uncensored/ })).toBeChecked();
  await atTop(dialog.getByText("Reachable", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("18-venice.png"), animations: "disabled" });

  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toEqual({
    provider: "codex", baseUrl: "https://api.venice.ai/api", label: "Venice", apiKey: "sk-venice-1234",
    models: ["zai-org-glm-5", "venice-uncensored-1-2"], contextWindow: 198_000, protocol: "chat",
    contexts: { "zai-org-glm-5": 198_000, "venice-uncensored-1-2": 128_000 },
    // Saved with the account: the hub's adapter puts it in every chat request, under its own fields.
    extra: { venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true } },
  });
  await expect(row(page, "Codex · Venice").getByText("Codex · Custom model · api.venice.ai · chat adapter", { exact: true })).toBeVisible();
});

test("when nothing answers at a hosted service's address, the address opens so it can be fixed", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const dialog = await openSheet(page, "Groq");
  const address = dialog.getByLabel("Server address", { exact: true });
  // It starts tucked away.
  await expect(address).toBeHidden();
  h.test = () => answer({ reachable: false, authOk: null, problems: ["Nothing answered at https://api.groq.com/openai. Check the address under Server address, then press Test."] });
  await dialog.getByLabel("API key", { exact: true }).fill("gsk-1");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("Can't reach it", { exact: true })).toBeVisible();
  await expect(address).toBeVisible();
  await expect(address).toHaveValue("https://api.groq.com/openai");
  await atTop(dialog.getByText("Server address", { exact: true }).first());
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("15-address-opens.png"), animations: "disabled" });
  // Typing there stays open (and forgets the answer); the new address is what's tested next.
  await address.fill("https://api.groq.com/openai/v1");
  await expect(address).toBeVisible();
  await expect(dialog.getByText("Can't reach it", { exact: true })).toHaveCount(0);
  h.test = () => answer({ models: [{ id: "llama-3.3-70b", contextWindow: 131_072 }], works: [{ provider: "codex", via: "responses" }] });
  await address.press("Enter");
  await expect(dialog.getByText("Works with Codex", { exact: true })).toBeVisible();
  expect(h.tests.at(-1)).toMatchObject({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-1" });
});

test("a service that lists no models can be added with names typed by hand", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  const dialog = await openSheet(page, "Another server");
  await dialog.getByLabel("Server address", { exact: true }).fill("https://llm.example.com");
  await tip(dialog.getByRole("button", { name: "What's a server address?", exact: true }), "Where the server listens, as this machine reaches it, like http://127.0.0.1:11434.");
  h.test = () => answer({ authOk: null, protocols: { responses: "yes", messages: "no", chat: "no" }, works: [{ provider: "codex", via: "responses" }] });
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("No models listed", { exact: true })).toBeVisible();
  const add = dialog.getByRole("button", { name: "Add it", exact: true });
  await expect(add).toBeDisabled();
  await dialog.getByLabel("Model names", { exact: true }).fill("my-model, other-model");
  await tip(dialog.getByRole("button", { name: "What's a context size?", exact: true }), "How much of a chat the model can read at once, counted in tokens (a token is about three quarters of a word). Chats summarize older messages at three quarters of it.");
  await dialog.getByLabel("Context size (tokens, optional)", { exact: true }).fill("65536");
  await expect(add).toBeEnabled();
  await atTop(dialog.getByText("Reachable", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("17-typed-model-names.png"), animations: "disabled" });
  await add.click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toEqual({ provider: "codex", baseUrl: "https://llm.example.com", apiKey: "", models: ["my-model", "other-model"], contextWindow: 65536, protocol: "responses" });
});

test("a name that's taken says how to get past it, and the sheet stays open to try again", async ({ page }) => {
  await hub(page);
  await settings(page);
  const dialog = await openSheet(page, "DeepSeek");
  await page.route(home("/api/accounts/endpoint"), (route) => route.fulfill({ status: 409, json: { error: `There's already a Codex account called "DeepSeek"` } }));
  await dialog.getByLabel("API key", { exact: true }).fill("sk-1");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(`There's already a Codex account called "DeepSeek". Give it another name above, then press Add it.`);
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeEnabled();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("10-name-taken.png"), animations: "disabled" });
  // Leaving with a key typed in asks first.
  await page.mouse.click(8, 8);
  await expect(page.getByRole("alert").filter({ hasText: "Discard changes?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog).toBeVisible();
});

test("Found on this machine: servers with their models and memory, In use, Rescan, and Use it fills the sheet in", async ({ page }) => {
  const h = await hub(page);
  const ollama: LocalServer = {
    id: "ollama", kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434",
    models: [{ id: "qwen3-coder:30b", contextWindow: 262_144, sizeBytes: 19e9, loaded: true }, { id: "llama3.2:3b", contextWindow: 131_072, sizeBytes: 2e9, loaded: false }, { id: "gemma3:4b", contextWindow: null, sizeBytes: 3e9, loaded: false }],
    memoryBytes: 21.5 * 1024 ** 3, protocols: { responses: "yes", messages: "yes", chat: "yes" }, accountIds: [],
  };
  const lmstudio: LocalServer = { id: "lmstudio", kind: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234", models: [{ id: "qwen2.5-coder-7b", contextWindow: 32_768, sizeBytes: 5e9, loaded: true }], memoryBytes: null, protocols: { responses: "yes", messages: "no", chat: "yes" }, accountIds: [{ provider: "codex", id: "kimi1" }] };
  h.servers = [ollama, lmstudio];
  await settings(page);
  const found = page.getByRole("region", { name: "Found on this machine", exact: true });
  await expect(found).toBeVisible();
  const ol = row(page, "Ollama on 127.0.0.1:11434");
  await expect(ol.getByText("3 models · qwen3-coder:30b loaded · 21.5 GB in use", { exact: true })).toBeVisible();
  await expect(ol.getByRole("button", { name: "Use it", exact: true })).toBeVisible();
  const lm = row(page, "LM Studio on 127.0.0.1:1234");
  await expect(lm.getByText("In use", { exact: true })).toBeVisible();
  await expect(lm.getByRole("button", { name: "Use it", exact: true })).toHaveCount(0);
  await tip(found.getByRole("button", { name: "What does this list?", exact: true }), "Model servers running on this machine right now, such as Ollama or LM Studio. Each machine lists its own: switch machines at the top of Settings to see another one's.");
  await atTop(found);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("11-found-on-this-machine.png"), animations: "disabled" });

  // Rescan asks again, once per tap, and shows what's there now. (It scanned when Settings opened, twice in dev mode.)
  // The hub keeps a scan for ten seconds, so Rescan says ?fresh=1; opening Settings takes what it kept.
  const opened = h.scans;
  expect(opened).toBeGreaterThanOrEqual(1);
  expect(h.scanQueries).toEqual(Array(opened).fill(""));
  h.servers = [];
  await found.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(found.getByText("No model server found on this machine. Start Ollama, LM Studio or llama.cpp, then press Rescan.", { exact: true })).toBeVisible();
  expect(h.scans).toBe(opened + 1);
  expect(h.scanQueries.at(-1)).toBe("?fresh=1");
  h.servers = [ollama];
  await found.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(ol).toBeVisible();
  expect(h.scans).toBe(opened + 2);
  expect(h.scanQueries.at(-1)).toBe("?fresh=1");

  // Use it: the same sheet, with the address and name in, and the check already running (no key to paste).
  h.test = () => answer({ authOk: null, protocols: { responses: "yes", messages: "yes", chat: "yes" }, models: ollama.models.map((m) => ({ id: m.id, contextWindow: m.contextWindow })), works: [{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }] });
  await ol.getByRole("button", { name: "Use it", exact: true }).click();
  const dialog = sheet(page);
  await expect(dialog.getByLabel("Server address", { exact: true })).toHaveValue("http://127.0.0.1:11434");
  await expect(dialog.getByText("3 models found", { exact: true })).toBeVisible();
  expect(h.tests).toEqual([{ baseUrl: "http://127.0.0.1:11434" }]);
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Ollama");
  await expect(dialog.getByRole("radio", { name: "Codex", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByText("Context size (tokens, optional)", { exact: true })).toHaveCount(0);
  await atTop(dialog.getByText("Reachable", { exact: true }));
  await page.screenshot({ ...shot("12-use-it-prefilled.png"), animations: "disabled" });
  await dialog.getByRole("checkbox", { name: /gemma3:4b/ }).uncheck();
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  // A server on this machine is saved on the chat lane even though its Responses address answered: that preset pins it
  // (web/src/presets.ts), because these servers' chat templates can refuse what an agent sends to Responses.
  expect(h.saved[0]).toEqual({
    provider: "codex", baseUrl: "http://127.0.0.1:11434", label: "Ollama", apiKey: "", models: ["qwen3-coder:30b", "llama3.2:3b"], contextWindow: 262_144, protocol: "chat",
    contexts: { "qwen3-coder:30b": 262_144, "llama3.2:3b": 131_072 },
  });
});

test("Refresh models updates a custom model's list, and a list that can't be refreshed says where it's from", async ({ page }) => {
  const h = await hub(page);
  h.catalogs.set("kimi1", { provider: "codex", accountId: "kimi1", live: false, error: "Couldn't reach api.moonshot.ai", checkedAt: MARCH_3, models: [modelOption("kimi-k3.1-pro"), modelOption("kimi-k3.1-pro-highspeed")] });
  await settings(page);
  const kimi = row(page, "Codex · Kimi K3.1 Pro");
  await expect(kimi.getByText("Couldn't reach it; showing the list from March 3.", { exact: true })).toBeVisible();
  await expect(kimi.getByText("Can't reach it", { exact: true })).toBeVisible();
  await atTop(kimi);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("13-stale-list.png"), animations: "disabled" });

  // Still down: it says why, keeps the saved list and offers the same button again.
  h.refresh = () => 502;
  await kimi.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(kimi.getByRole("alert")).toHaveText("Couldn't update the list: The server didn't answer. Press Refresh models to try again.");
  await expect(kimi.getByText("Couldn't reach it; showing the list from March 3.", { exact: true })).toBeVisible();
  expect(h.refreshed).toEqual(["/api/accounts/codex/kimi1/refresh-models"]);
  await atTop(kimi);
  await page.screenshot({ ...shot("14-refresh-failed.png"), animations: "disabled" });

  // Back up: the list is the server's now, with three models.
  const fresh = { ...KIMI, endpoint: endpoint({ models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3.2-preview"] }) };
  h.refresh = () => fresh;
  h.catalogs.set("kimi1", { provider: "codex", accountId: "kimi1", live: true, error: null, checkedAt: Date.now(), models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3.2-preview"].map(modelOption) });
  await kimi.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(kimi.getByText("3 models: kimi-k3.1-pro, kimi-k3.1-pro-highspeed, kimi-k3.2-preview", { exact: true })).toBeVisible();
  await expect(kimi.getByText("Model list updated", { exact: true })).toBeVisible();
  await expect(kimi.getByText("Couldn't reach it; showing the list from March 3.", { exact: true })).toHaveCount(0);
  await expect(kimi.getByRole("alert")).toHaveCount(0);
  // Only a custom model's list can be refreshed this way.
  await expect(row(page, "Codex · Main").getByRole("button", { name: "Refresh models", exact: true })).toHaveCount(0);
});

test("an older hub: no scan means no Found block, and a service check that isn't there says to update", async ({ page }) => {
  const h = await hub(page);
  h.servers = 404;
  h.test = () => 404;
  await settings(page);
  await expect(page.getByRole("button", { name: "Add an AI service", exact: true })).toBeVisible();
  await expect.poll(() => h.scans).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole("region", { name: "Found on this machine", exact: true })).toHaveCount(0);
  // (Local models has a Rescan of its own below.)
  await expect(page.getByRole("region", { name: "Found on this machine", exact: true }).getByRole("button", { name: "Rescan", exact: true })).toHaveCount(0);
  const dialog = await openSheet(page, "DeepSeek");
  await dialog.getByLabel("API key", { exact: true }).fill("sk-1");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("This machine's hub is too old to check services. Update it, or use Add a custom model under Claude Code or Codex below.");
});

test("a scan that fails says what to do and Rescan tries again", async ({ page }) => {
  const h = await hub(page);
  h.servers = 500;
  await settings(page);
  const found = page.getByRole("region", { name: "Found on this machine", exact: true });
  await expect(found.getByRole("alert")).toContainText("Couldn't look for servers");
  await expect(found.getByRole("alert")).toContainText("Press Rescan to try again.");
  h.servers = [];
  await found.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(found.getByRole("alert")).toHaveCount(0);
  await expect(found.getByText("No model server found on this machine", { exact: false })).toBeVisible();
});

for (const width of [320, 390]) {
  test(`nothing runs off the edge at ${width} px: the list, the sheet, the results and what's found`, async ({ page }) => {
    const h = await hub(page);
    h.servers = [{ id: "llamacpp", kind: "llamacpp", label: "llama.cpp with a rather long server name", baseUrl: "http://127.0.0.1:8080", models: [{ id: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q4_K_XL", contextWindow: 65_536, sizeBytes: 1, loaded: true }], memoryBytes: 18 * 1024 ** 3, protocols: { ...none }, accountIds: [] }];
    h.catalogs.set("kimi1", { provider: "codex", accountId: "kimi1", live: false, error: "down", checkedAt: MARCH_3, models: [] });
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { name: "AI services", exact: true })).toBeVisible();
    await expect(row(page, "Codex · Kimi K3.1 Pro")).toBeVisible();
    await expect(page.getByRole("region", { name: "Found on this machine", exact: true })).toContainText("llama.cpp with a rather long server name");
    await noHorizontalOverflow(page);
    const dialog = await openSheet(page, "Another server");
    await noHorizontalOverflow(page);
    await dialog.getByLabel("Server address", { exact: true }).fill("https://a-very-long-host-name.example-llm-service.com/some/long/path");
    h.test = () => answer({
      authOk: null, protocols: { responses: "yes", messages: "yes", chat: "yes" },
      models: Array.from({ length: 12 }, (_, i) => ({ id: `organization/a-long-model-name-${i}-instruct-2026-10-27`, contextWindow: 131_072 })),
      works: [{ provider: "codex", via: "adapter" }, { provider: "claude", via: "messages" }],
      problems: ["Claude Code needs a model with at least 64k of context, and this one lists less. Pick a bigger model or use Codex."],
    });
    await dialog.getByRole("button", { name: "Test", exact: true }).click();
    await expect(dialog.getByText("12 models found", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Filter models", exact: true })).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).scrollIntoViewIfNeeded();
    await noHorizontalOverflow(page);
    // Nothing inside the dialog is wider than the dialog either.
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // The buttons on the sheet stay tappable: every one is at least 44 px tall on a phone.
    // (A "?" is a small circle with a 44 px area around it.)
    for (const button of await dialog.locator("button:not(.help-tip-btn)").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  });
}
