import type { Page, Route } from "@playwright/test";
import type { ProviderStatus, PtyInfo, ServiceFunds, ServiceTestResult } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Adding Refuseless and its abliterated models on a phone screen (390px), with OpenCode to run them: installed from the
// sheet itself when it isn't there yet. The hub's answers are played here: the shared test hub's accounts and settings stay
// as they were, nothing reaches the real Refuseless, and no installer ever runs.
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
/** The machine this app opens from (the test hub), as requests to it are addressed. */
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;

const PICK = "deepseek-v4.1-flash-abliterated";
const UNCENSORED = [PICK, "glm-5.3-abliterated", "glm-5.3-flash-abliterated"];
const account = (over: Record<string, unknown>) => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: "me@example.com", plan: "Plus", authMethod: "chatgpt", error: null, checkedAt: Date.now(), ...over });

const FUNDS: ServiceFunds = { balanceUsd: 41.3, heldUsd: 1.2, plan: null, checkedAt: Date.now() };
const M = 1_048_576;
/** What the hub answers for Refuseless (hub/test/refuseless.test.ts): its lineup in order, with names, prices and the uncensored ones. */
const CHECKED: ServiceTestResult = {
  reachable: true,
  authOk: true,
  server: null,
  protocols: { responses: "yes", messages: "yes", chat: "yes" },
  models: [
    { id: PICK, contextWindow: M, name: "DeepSeek V4.1 Flash 1017 Abliterated", price: { input: 0.12, output: 0.45, cached: 0.025 }, uncensored: true },
    { id: "glm-5.3-abliterated", contextWindow: M, name: "GLM 5.3 Abliterated", price: { input: 1, output: 2, cached: 0.15 }, uncensored: true },
    { id: "glm-5.3-flash-abliterated", contextWindow: M, name: "GLM 5.3 Flash Abliterated", price: { input: 0.12, output: 0.5, cached: 0.03 }, uncensored: true },
    { id: "deepseek-v4.1-flash-fast", contextWindow: M, name: "DeepSeek V4.1 Flash 1017", price: { input: 0.01, output: 0.08, cached: 0.002 }, uncensored: false },
    { id: "minimax-m3.1-flash", contextWindow: M, name: "Minimax M3.1 Flash", price: { input: 0.02, output: 0.08, cached: 0.002 }, uncensored: false },
  ],
  works: [{ provider: "opencode", via: "chat" }, { provider: "builtin", via: "chat" }, { provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }],
  problems: [],
  funds: FUNDS,
};

/** OpenCode as the hub says it (hub/src/providers/opencode.ts): at the version it pins, nothing to sign in to. */
const OPENCODE: ProviderStatus = { provider: "opencode", installed: true, signedIn: true, version: "2.2.5", binPath: "/Users/me/.npm-global/bin/opencode", account: null, plan: null, authMethod: "AI service", error: null, checkedAt: Date.now() };
const NO_OPENCODE: ProviderStatus = { ...OPENCODE, installed: false, signedIn: null, version: null, binPath: null, authMethod: null };
/** The terminal an install runs in, as the hub reports it. */
const PTY: PtyInfo = { id: "pty_opencode", title: "Install opencode", command: "npm install -g", purpose: "install", provider: "opencode", alive: true, exitCode: null, createdAt: Date.now() };

/** A Refuseless service already saved (under Crosstalk's agent, as the running 0.6.5 saved it). */
const saved = (over: Record<string, unknown> = {}) => account({ id: "rl0", label: "Refuseless", provider: "builtin", kind: "endpoint", account: null, plan: "Custom model", endpoint: { baseUrl: "https://api.refuseless.com", models: UNCENSORED, contextWindow: M, hasKey: true, protocol: "chat" }, ...over });

async function hub(page: Page, opencode: ProviderStatus = OPENCODE) {
  const state = {
    accounts: [account({ provider: "claude", plan: "Max" }), account({})] as Record<string, unknown>[],
    tests: [] as Record<string, unknown>[],
    saved: [] as Record<string, unknown>[],
    fundsReads: 0,
    opencode,
    /** Installs asked for. */
    installs: 0,
    /** How the install's terminal stands: null while it runs. */
    ended: null as { exitCode: number | null; output: string } | null,
    /** What it has printed so far. */
    printed: "added 1 package in 2s\r\n",
    /** Terminals stopped from the app. */
    stops: 0,
    /** POST /api/accounts/:p/:id/agent asked for: where from, and the body. */
    moves: [] as { path: string; body: unknown }[],
    /** How a move goes: the hub's answer, or a status and words to fail with. */
    move: null as null | ((path: string, to: string) => Record<string, unknown> | { status: number; error: string }),
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await page.route(home("/api/accounts"), (route) => (route.request().method() === "GET" ? json(route, state.accounts) : route.fallback()));
  await page.route(home("/api/state"), async (route) => {
    const snapshot = await (await route.fetch()).json();
    return json(route, { ...snapshot, accounts: state.accounts, providers: [...snapshot.providers, state.opencode] });
  });
  await page.route(home("/api/services/test"), (route) => {
    state.tests.push(route.request().postDataJSON());
    return json(route, CHECKED);
  });
  await page.route(home("/api/accounts/endpoint"), (route) => {
    const body = route.request().postDataJSON();
    state.saved.push(body);
    const made = account({ id: "rl1", label: body.label, provider: body.provider, kind: "endpoint", account: null, plan: "Custom model", endpoint: { baseUrl: body.baseUrl, models: body.models, contextWindow: body.contextWindow, hasKey: true, protocol: body.protocol, contexts: body.contexts } });
    state.accounts.push(made);
    return json(route, made);
  });
  await page.route((url) => url.origin === "http://127.0.0.1:5198" && /^\/api\/accounts\/[a-z]+\/[\w-]+\/funds$/.test(url.pathname), (route) => {
    state.fundsReads++;
    return json(route, FUNDS);
  });
  await page.route((url) => url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/models") && url.origin === "http://127.0.0.1:5198", async (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get("account") ?? "default";
    const found = state.accounts.find((a) => a.id === id && a.kind === "endpoint") as { endpoint: { models: string[] } } | undefined;
    if (!found) return route.fallback();
    return json(route, { provider: url.pathname.split("/")[3], accountId: id, live: true, error: null, models: found.endpoint.models.map((m, i) => ({ id: m, label: m, description: "On Refuseless · uncensored", efforts: [], defaultEffort: null, isDefault: i === 0, contextWindow: M })) });
  });
  // OpenCode's install: its terminal and how it ends are the test's to say, and the hub's check after it reads `opencode`.
  await page.route(home("/api/providers/opencode/install"), (route) => {
    state.installs++;
    state.ended = null;
    return json(route, { ...PTY, id: `pty_opencode${state.installs}` });
  });
  await page.route(home("/api/providers/opencode/refresh"), (route) => json(route, state.opencode));
  await page.route((url) => url.origin === "http://127.0.0.1:5198" && url.pathname.startsWith("/api/pty/pty_opencode"), (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    if (route.request().method() === "DELETE") {
      state.stops++;
      state.ended = { exitCode: 143, output: state.printed };
      return json(route, { ok: true });
    }
    return json(route, { info: { ...PTY, id, alive: !state.ended, exitCode: state.ended?.exitCode ?? null }, scrollback: state.ended?.output ?? state.printed });
  });
  await page.route((url) => url.origin === "http://127.0.0.1:5198" && /^\/api\/accounts\/[a-z]+\/[\w-]+\/agent$/.test(url.pathname), (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as { to: string };
    state.moves.push({ path, body });
    const answer = state.move?.(path, body.to);
    if (answer && "status" in answer) return json(route, { error: answer.error }, answer.status as number);
    return json(route, answer);
  });
  return state;
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Add an AI service", exact: true });
/** Scrolls so the element starts at the top of the screen (a phone screenshot of just what's being shown). */
const atTop = (target: ReturnType<Page["getByRole"]>) => target.evaluate((el) => el.scrollIntoView({ block: "start" }));
const settings = async (page: Page) => {
  await phone(page);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "AI services", exact: true })).toBeVisible();
};
/** The sheet on Refuseless with its key in and its check back. */
const checkedSheet = async (page: Page) => {
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^Refuseless/ }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("abl_test_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("5 models found", { exact: true })).toBeVisible();
  return dialog;
};

test("Refuseless: a key, its credit, its abliterated models ticked with their names and prices, OpenCode to run them, and the account's credit after", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  // In the list, what it is in a line; picked, what you pay for and what runs it, and where the key comes from.
  await expect(dialog.getByRole("button", { name: /^Refuseless/ })).toContainText("refusals taken out of the weights");
  await dialog.getByRole("button", { name: /^Refuseless/ }).click();
  await expect(dialog.getByText(/estimates what each reply cost from Refuseless's prices of 4 November 2026/)).toBeVisible();
  await expect(dialog.getByText("OpenCode runs it: an open-source coding agent Crosstalk drives, with no refusal rules of its own. It keeps a Plan card, reads your project's AGENTS.md (or CLAUDE.md), asks for approvals the way your chat is set, and can use BrowserOS neo.", { exact: true })).toBeVisible();
  const open = dialog.getByRole("link", { name: "Open refuseless.com/console", exact: true });
  await expect(open).toHaveAttribute("href", "https://refuseless.com/console");
  await expect(dialog.getByRole("link", { name: "docs.refuseless.com", exact: true })).toHaveAttribute("href", "https://docs.refuseless.com");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r1-refuseless-steps.png"), animations: "disabled" });

  await dialog.getByLabel("API key", { exact: true }).fill("abl_test_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("5 models found", { exact: true })).toBeVisible();
  expect(h.tests).toEqual([{ baseUrl: "https://api.refuseless.com", apiKey: "abl_test_key" }]);
  for (const line of ["Key works", "Works with OpenCode", "Works with Crosstalk agent", "Works with Codex", "Works with Claude Code", "Balance $41.30", "$1.20 held by replies still running"]) await expect(dialog.getByText(line, { exact: true })).toBeVisible();
  // OpenCode is offered first, and picked; it's installed, so nothing stands in the way.
  const choice = dialog.getByRole("radiogroup", { name: "Use it with", exact: true });
  await expect(choice.getByRole("radio")).toHaveText(["OpenCode", "Crosstalk agent", "Codex", "Claude Code"]);
  await expect(choice.getByRole("radio", { name: "OpenCode", exact: true })).toBeChecked();
  await expect(dialog.getByText(/OpenCode is an open-source coding agent program that Crosstalk drives/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Install OpenCode", exact: true })).toHaveCount(0);
  await atTop(dialog.getByText("Use it with", { exact: true }).first());
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r5-refuseless-agents.png"), animations: "disabled" });
  // Each of the others says what it is when it's picked.
  await choice.getByRole("radio", { name: "Crosstalk agent", exact: true }).click();
  await expect(dialog.getByText(/follows your project's AGENTS.md: no other agent program involved, and nothing to install/)).toBeVisible();
  await choice.getByRole("radio", { name: "Codex", exact: true }).click();
  await expect(dialog.getByText("Codex can run it too, with its own instructions and tools on top.", { exact: true })).toBeVisible();
  await choice.getByRole("radio", { name: "OpenCode", exact: true }).click();

  // The abliterated models are ticked for you, best for coding first; the makers' own weights are there to tick.
  const row = (id: string) => dialog.locator(".svc-model-list li", { hasText: id });
  for (const id of UNCENSORED) await expect(row(id).getByRole("checkbox")).toBeChecked();
  for (const id of ["deepseek-v4.1-flash-fast", "minimax-m3.1-flash"]) await expect(row(id).getByRole("checkbox")).not.toBeChecked();
  await expect(row(PICK).getByText("DeepSeek V4.1 Flash 1017 Abliterated", { exact: true })).toBeVisible();
  await expect(row(PICK).getByText("1M · $0.12 in, $0.45 out per million (cached $0.025)", { exact: true })).toBeVisible();
  await expect(row(PICK).getByText("Uncensored", { exact: true })).toBeVisible();
  await expect(row(PICK).getByText("Default", { exact: true })).toBeVisible();
  await expect(row("minimax-m3.1-flash").getByText("Uncensored", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/The uncensored ones are picked for you/)).toBeVisible();
  await atTop(dialog.getByText("Models", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r2-refuseless-models.png"), animations: "disabled" });

  // Adding it saves them for OpenCode, on Refuseless's chat address, each with its own 1M context.
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toEqual({
    provider: "opencode",
    baseUrl: "https://api.refuseless.com",
    label: "Refuseless",
    apiKey: "abl_test_key",
    models: UNCENSORED,
    contextWindow: M,
    protocol: "chat",
    contexts: Object.fromEntries(UNCENSORED.map((id) => [id, M])),
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Added. Start a chat on Refuseless from New chat.", { exact: true })).toBeVisible();
  const added = page.getByRole("group", { name: "OpenCode · Refuseless", exact: true });
  await expect(added.getByText("OpenCode · Custom model · api.refuseless.com", { exact: true })).toBeVisible();
  await expect(added.getByText("Balance $41.30 · $1.20 held by replies still running", { exact: true })).toBeVisible();
  await expect(added.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(added.getByText("Change its address, key or models with Change, or take it away with Remove.", { exact: true })).toBeVisible();
  expect(h.fundsReads).toBeGreaterThan(0);
  // The Agents line says what runs it, and it has no "Accounts below" to go to.
  await expect(page.getByText("Claude Code and Codex run the other services above. OpenCode runs Refuseless, with the key above, and needs no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.", { exact: true })).toBeVisible();
  await atTop(added);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r3-refuseless-row.png"), animations: "disabled" });
});

test("OpenCode isn't installed: Install is right there in the sheet, the key and the ticks stay, and Add it comes on once it's in", async ({ page }) => {
  const h = await hub(page, NO_OPENCODE);
  const dialog = await checkedSheet(page);
  // OpenCode stays the one picked, as the preset says, because it can be put right here.
  const choice = dialog.getByRole("radiogroup", { name: "Use it with", exact: true });
  await expect(choice.getByRole("radio", { name: "OpenCode", exact: true })).toBeChecked();
  const line = dialog.locator(".svc-install-line");
  await expect(line).toHaveText("OpenCode isn't installed on this machine yet. Crosstalk can install it now, and what you've filled in here stays.");
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();
  // The way that throws the key away isn't suggested.
  await expect(dialog.getByText(/Close this/)).toHaveCount(0);
  await atTop(dialog.getByText("Use it with", { exact: true }).first());
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r6-install-offered.png"), animations: "disabled" });
  expect(h.installs).toBe(0);

  // Pressing it starts the one install, right here: what it says, what it prints, and a way to stop it.
  const untick = dialog.locator(".svc-model-list li", { hasText: "glm-5.3-abliterated" }).getByRole("checkbox");
  await untick.uncheck();
  await dialog.getByRole("button", { name: "Install OpenCode", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(line).toHaveText(/^Installing OpenCode on .+…\s*What you've filled in here stays\.$/);
  expect(h.installs).toBe(1);
  // The same button goes on to be Stop, so the keyboard stays where it was, and a phone opens none over the sheet.
  await expect(dialog.getByRole("button", { name: "Stop", exact: true })).toBeFocused();
  await expect(dialog.locator(".term-box")).toContainText("added 1 package in 2s");
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();
  // Nothing else in the sheet moved: the key, the check and the ticks are as they were.
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("abl_test_key");
  await expect(dialog.getByText("5 models found", { exact: true })).toBeVisible();
  await expect(untick).not.toBeChecked();
  await atTop(dialog.locator(".svc-install"));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r7-installing.png"), animations: "disabled" });

  // It ends well and the hub finds it: said, the terminal goes, and Add it comes on.
  h.opencode = OPENCODE;
  h.ended = { exitCode: 0, output: "Installed: 2.2.5\r\n" };
  await expect(line).toHaveText("OpenCode 2.2.5 is installed. You can add the service now.");
  await expect(dialog.locator(".term-box")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  // With nothing left to press there, the keyboard lands on the line that says how it went.
  await expect(line).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeEnabled();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r8-installed.png"), animations: "disabled" });

  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toMatchObject({ provider: "opencode", apiKey: "abl_test_key", models: [PICK, "glm-5.3-flash-abliterated"] });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Added. Start a chat on Refuseless from New chat.", { exact: true })).toBeVisible();
});

test("an install that fails says so with what it printed, never lets Add it on, and leaves a way forward", async ({ page }) => {
  const h = await hub(page, NO_OPENCODE);
  const dialog = await checkedSheet(page);
  const line = dialog.locator(".svc-install-line");
  // The installer's own words for what's missing, in the terminal it ran in.
  h.printed = "OpenCode needs Node.js (npm). Install it first.\r\n";
  await dialog.getByRole("button", { name: "Install OpenCode", exact: true }).click();
  await expect(line).toHaveText(/^Installing OpenCode/);
  await expect(dialog.locator(".term-box")).toContainText("OpenCode needs Node.js (npm). Install it first.");
  h.ended = { exitCode: 1, output: h.printed };
  await expect(line).toHaveText("OpenCode didn't install (exit 1). What it printed is below.");
  await expect(dialog.locator(".term-box")).toContainText("OpenCode needs Node.js (npm). Install it first.");
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();
  await expect(dialog.getByText("Or pick Crosstalk agent above: it needs nothing installed.", { exact: true })).toBeVisible();
  await atTop(dialog.locator(".svc-install"));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r9-install-failed.png"), animations: "disabled" });

  // It finished without a fault and the hub still can't find it: not called installed.
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(line).toHaveText(/^Installing OpenCode/);
  expect(h.installs).toBe(2);
  h.ended = { exitCode: 0, output: "Installed: \r\n" };
  await expect(line).toHaveText(/^The installer finished, but OpenCode isn't where Crosstalk looks for it on .+\. What it printed is below\.$/);
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();

  // Stopped: said as that, and it can go again.
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(line).toHaveText(/^Installing OpenCode/);
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(line).toHaveText("You stopped the install.");
  expect(h.stops).toBe(1);
  await expect(dialog.getByRole("button", { name: "Try again", exact: true })).toBeVisible();

  // The other way forward, without a key typed again: Crosstalk's own agent needs nothing installed.
  await dialog.getByRole("radiogroup", { name: "Use it with", exact: true }).getByRole("radio", { name: "Crosstalk agent", exact: true }).click();
  await expect(line).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toMatchObject({ provider: "builtin", apiKey: "abl_test_key" });
});

test("a hub that refuses the install says why, and the sheet stays as it was", async ({ page }) => {
  await hub(page, NO_OPENCODE);
  await page.route(home("/api/providers/opencode/install"), (route) => route.fulfill({ status: 500, json: { error: "Couldn't start a terminal" } }));
  const dialog = await checkedSheet(page);
  await dialog.getByRole("button", { name: "Install OpenCode", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "The install didn't start" })).toHaveText("The install didn't start: Couldn't start a terminal. Try again in a moment.");
  await expect(dialog.getByRole("button", { name: "Install OpenCode", exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("abl_test_key");
});

test("OpenCode's card says if it's installed and which version, offers Install or Update, and nothing about signing in or plans", async ({ page }) => {
  const h = await hub(page, NO_OPENCODE);
  await settings(page);
  const card = page.getByRole("region", { name: "OpenCode", exact: true });
  await expect(card.getByRole("heading", { name: "OpenCode", exact: true })).toBeVisible();
  await expect(card.getByText("Not installed", { exact: true })).toBeVisible();
  await expect(card).not.toContainText(/sign|plan/i);
  // After Codex's card, as the Agents part below the list.
  await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r10-card-not-installed.png"), animations: "disabled" });

  // Install, on the card itself: how it goes, then the card as it now stands.
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await expect(card.locator(".svc-install-line")).toHaveText(/^Installing OpenCode on .+…$/);
  await expect(card.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(card.locator(".term-box")).toContainText("added 1 package in 2s");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r11-card-installing.png"), animations: "disabled" });
  h.opencode = OPENCODE;
  h.ended = { exitCode: 0, output: "Installed: 2.2.5\r\n" };
  await expect(card.locator(".svc-install-line")).toHaveText("OpenCode 2.2.5 is installed.");
  await expect(card.getByText("Installed", { exact: true })).toBeVisible();
  await expect(card.getByText("Open source, from Anomaly · v2.2.5", { exact: true })).toBeVisible();
  // The version Crosstalk was checked with has nothing to press but Check.
  await expect(card.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await expect(card).not.toContainText(/sign|plan/i);
  await atTop(card);
  await page.screenshot({ ...shot("r12-card-installed.png"), animations: "disabled" });

  // Another version: Update puts the checked one on it, and Check reads the hub again.
  h.opencode = { ...OPENCODE, version: "2.2.4" };
  await card.getByRole("button", { name: "Check", exact: true }).click();
  await expect(card.getByText("Other version", { exact: true })).toBeVisible();
  await expect(card.getByText("Crosstalk was checked with OpenCode 2.2.5. This machine has 2.2.4. Update puts 2.2.5 on it.", { exact: true })).toBeVisible();
  const installs = h.installs;
  await card.getByRole("button", { name: "Update", exact: true }).click();
  await expect(card.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(h.installs).toBe(installs + 1);
  await atTop(card);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r13-card-update.png"), animations: "disabled" });
  h.opencode = OPENCODE;
  h.ended = { exitCode: 0, output: "Installed: 2.2.5\r\n" };
  await expect(card.getByText("Installed", { exact: true })).toBeVisible();

  // A version 1 can't run these chats: the hub's words, with the button they name.
  h.opencode = { ...OPENCODE, version: "1.14.0", signedIn: null, error: "OpenCode 1.14.0 is installed, and Crosstalk needs version 2. Press Install to get it." };
  await card.getByRole("button", { name: "Check", exact: true }).click();
  await expect(card.getByText("Can't be used", { exact: true })).toBeVisible();
  await expect(card.getByText("OpenCode 1.14.0 is installed, and Crosstalk needs version 2. Press Install to get it.", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Install", exact: true })).toBeVisible();
});

test("an install already running there is taken up rather than started again, and a hub that doesn't know OpenCode shows no card", async ({ page }) => {
  const h = await hub(page, NO_OPENCODE);
  // Started before this page loaded: only the hub's own list says so.
  await page.route(home("/api/pty"), (route) => route.fulfill({ json: [{ ...PTY, id: "pty_opencode_running" }] }));
  await settings(page);
  const card = page.getByRole("region", { name: "OpenCode", exact: true });
  await expect(card.locator(".svc-install-line")).toHaveText(/^Installing OpenCode on .+…$/);
  await expect(card.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  expect(h.installs).toBe(0);
  // The same one in the sheet opened over it.
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^Refuseless/ }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("abl_test_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.locator(".svc-install-line")).toHaveText(/^Installing OpenCode on .+…/);
  await expect(dialog.getByRole("button", { name: "Install OpenCode", exact: true })).toHaveCount(0);
  h.opencode = OPENCODE;
  h.ended = { exitCode: 0, output: "" };
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(card.getByText("Installed", { exact: true })).toBeVisible();

  // The test hub on its own lists no OpenCode, as a hub older than it wouldn't.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Claude Code", exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("a service saved under Crosstalk's agent moves to OpenCode without its key being typed again, and back", async ({ page }) => {
  const h = await hub(page);
  h.accounts.push(saved());
  h.move = (path, to) => {
    const was = h.accounts.findIndex((a) => path.endsWith(`/${a.provider}/${a.id}/agent`));
    const now = saved({ provider: to, id: to === "opencode" ? "rl2" : "rl0" });
    h.accounts.splice(was, 1, now);
    return now;
  };
  await settings(page);
  const old = page.getByRole("group", { name: "Crosstalk agent · Refuseless", exact: true });
  await expect(page.getByText(/Crosstalk's own agent runs Refuseless itself/)).toBeVisible();
  await atTop(old);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r14-switch-offered.png"), animations: "disabled" });
  await old.getByRole("button", { name: "Run it with OpenCode", exact: true }).click();
  await expect(page.getByText("Refuseless now runs with OpenCode, with the same key.", { exact: true })).toBeVisible();
  expect(h.moves).toEqual([{ path: "/api/accounts/builtin/rl0/agent", body: { to: "opencode" } }]);
  // The row is OpenCode's now: there's no Crosstalk agent row left, and the way back is one tap.
  const moved = page.getByRole("group", { name: "OpenCode · Refuseless", exact: true });
  await expect(moved.getByText("OpenCode · Custom model · api.refuseless.com", { exact: true })).toBeVisible();
  await expect(old).toHaveCount(0);
  await expect(page.getByText(/OpenCode runs Refuseless/)).toBeVisible();
  await atTop(moved);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r15-switched.png"), animations: "disabled" });
  await moved.getByRole("button", { name: "Run it with Crosstalk agent", exact: true }).click();
  await expect(old).toBeVisible();
  expect(h.moves[1]).toEqual({ path: "/api/accounts/opencode/rl2/agent", body: { to: "builtin" } });
});

test("a move says when chats keep the old row, and why it failed", async ({ page }) => {
  const h = await hub(page);
  h.accounts.push(saved());
  // The hub's own words, then a hub too old to have the route, then chats still on the old account (it stays beside the new one).
  h.move = () => ({ status: 400, error: "OpenCode isn't installed on this machine yet. Install it under Settings → AI services first." });
  await settings(page);
  const old = page.getByRole("group", { name: "Crosstalk agent · Refuseless", exact: true });
  const button = old.getByRole("button", { name: "Run it with OpenCode", exact: true });
  await button.click();
  await expect(old.getByRole("alert")).toHaveText("Couldn't move it: OpenCode isn't installed on this machine yet. Install it under Settings → AI services first. Press Run it with OpenCode to try again.");
  h.move = () => ({ status: 404, error: "not found" });
  await button.click();
  await expect(old.getByRole("alert")).toHaveText("This machine's hub is too old to move a service to another agent. Update it first.");
  await expect(page.getByRole("group", { name: "OpenCode · Refuseless", exact: true })).toHaveCount(0);
  h.move = () => {
    const now = saved({ provider: "opencode", id: "rl2" });
    h.accounts.push(now);
    return now;
  };
  await button.click();
  await expect(page.getByText("Refuseless now runs with OpenCode, with the same key. Chats already on it stay with Crosstalk agent, so that row stays. Press Remove on it once they're deleted.", { exact: true })).toBeVisible();
  // Both rows now, and neither offers to move onto the other.
  await expect(old).toBeVisible();
  await expect(page.getByRole("group", { name: "OpenCode · Refuseless", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Run it with/ })).toHaveCount(0);
  await expect(page.getByText("Claude Code and Codex run the other services above. OpenCode runs Refuseless and Crosstalk's own agent runs Refuseless itself, with the keys above, and need no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.", { exact: true })).toBeVisible();
});

test("the move waits for OpenCode to be installed, and says so", async ({ page }) => {
  const h = await hub(page, NO_OPENCODE);
  h.accounts.push(saved());
  await settings(page);
  const old = page.getByRole("group", { name: "Crosstalk agent · Refuseless", exact: true });
  const button = old.getByRole("button", { name: "Run it with OpenCode", exact: true });
  await expect(button).toBeDisabled();
  await expect(old.getByText("OpenCode isn't installed on this machine yet. Press Install under OpenCode below, then run it with OpenCode.", { exact: true })).toBeVisible();
  await atTop(old);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r16-switch-waits.png"), animations: "disabled" });
  // Once it is, the button is on, with nothing left to explain.
  h.opencode = OPENCODE;
  await page.getByRole("region", { name: "OpenCode", exact: true }).getByRole("button", { name: "Check", exact: true }).click();
  await expect(button).toBeEnabled();
  await expect(old.getByText(/isn't installed/)).toHaveCount(0);
});

test("Test on a service only OpenCode or Crosstalk's agent runs runs the real check, shows its lines and reads the balance again", async ({ page }) => {
  const h = await hub(page);
  h.accounts.push(saved({ provider: "opencode", id: "rl2" }), saved({ provider: "builtin", id: "nano", label: "NanoGPT", endpoint: { baseUrl: "https://nano-gpt.com/api", models: ["m"], contextWindow: M, hasKey: true, protocol: "chat" } }));
  await settings(page);
  const row = page.getByRole("group", { name: "OpenCode · Refuseless", exact: true });
  await expect(row.getByText("Not tested yet", { exact: true })).toBeVisible();
  await expect(row.getByText("Balance $41.30 · $1.20 held by replies still running", { exact: true })).toBeVisible();
  const reads = h.fundsReads;
  await row.getByRole("button", { name: "Test", exact: true }).click();
  // The dot says it's reachable, then the lines; the balance isn't said twice, and it was read again with the check.
  await expect(row.getByText("Reachable", { exact: true })).toBeVisible();
  for (const line of ["Key works", "5 models found", "Works with OpenCode", "Works with Crosstalk agent"]) await expect(row.getByText(line, { exact: true })).toBeVisible();
  await expect(row.getByText("Balance $41.30", { exact: true })).toHaveCount(0);
  await expect.poll(() => h.fundsReads).toBeGreaterThan(reads);
  // Named by its id, with no agent: the hub's check takes only Claude Code or Codex as one, and finds this by id.
  expect(h.tests).toEqual([{ baseUrl: "https://api.refuseless.com", accountId: "rl2" }]);
  await atTop(row);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("r17-tested.png"), animations: "disabled" });
  // The same on Crosstalk's agent.
  const nano = page.getByRole("group", { name: "Crosstalk agent · NanoGPT", exact: true });
  await nano.getByRole("button", { name: "Test", exact: true }).click();
  await expect(nano.getByText("Key works", { exact: true })).toBeVisible();
  expect(h.tests[1]).toEqual({ baseUrl: "https://nano-gpt.com/api", accountId: "nano" });
});

test("a Refuseless service on OpenCode is a row in New chat, its chat is Refuseless's driven by OpenCode, and its effort goes as any agent's", async ({ page, request, token }) => {
  const HUB = "http://127.0.0.1:8451";
  const headers = { authorization: `Bearer ${token}` };
  await phone(page);
  // Saved the way the Add sheet saves it, on the real test hub. Its address is a closed port, so the hub never reaches
  // Refuseless (or anything) with the key while the menu asks for the account's models.
  const made = await (await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "opencode", label: "Refuseless", baseUrl: "http://127.0.0.1:9", apiKey: "abl_test", models: [PICK, "glm-5.3-abliterated"], contextWindow: M, protocol: "chat" } })).json();
  let roomId = "";
  try {
    expect(made).toMatchObject({ provider: "opencode", kind: "endpoint", label: "Refuseless" });
    // The menu entries as the hub lists them: DeepSeek says the levels Refuseless takes and the one it uses unless asked, GLM says none.
    const option = (id: string, efforts: string[], isDefault: boolean) => ({ id, label: id, description: "On Refuseless · $0.12 in · $0.45 out per million tokens · uncensored", efforts, defaultEffort: efforts.length ? "high" : null, isDefault, contextWindow: M });
    await page.route("**/api/providers/opencode/models**", (route: Route) => route.fulfill({ json: { provider: "opencode", accountId: made.id, live: true, error: null, models: [option(PICK, ["off", "low", "high", "max"], true), option("glm-5.3-abliterated", [], false)] } }));
    await page.goto("/");
    await page.getByRole("button", { name: /^Show chats/ }).click();
    const list = page.locator(".chat-sidebar.drawer");
    await list.getByRole("button", { name: "New chat", exact: true }).click();
    const menu = list.getByRole("menu", { name: "New chat", exact: true });
    const row = menu.getByRole("menuitem", { name: /Refuseless/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText(PICK);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("r18-new-chat-menu.png"), animations: "disabled" });
    await row.click();

    const dialog = page.getByRole("dialog", { name: "New chat with Refuseless", exact: true });
    await expect(dialog.getByText(/driven by OpenCode$/)).toBeVisible();
    const model = dialog.getByRole("combobox", { name: "Model", exact: true });
    await expect(model).toHaveValue(PICK);
    // The levels the model takes, in plain words; none for a model that lists none.
    const effort = dialog.getByRole("combobox", { name: "Effort", exact: true });
    await expect(effort.getByRole("option")).toHaveText(["Default (High)", "Off", "Low", "High", "Max"]);
    await model.selectOption("glm-5.3-abliterated");
    await expect(effort).toHaveCount(0);
    await model.selectOption(PICK);
    await effort.selectOption("low");
    // What it may do without asking is said as OpenCode's own rules, not as another agent's.
    await expect(dialog.getByText("Can read the project. Asks you before reading elsewhere, and before file edits, commands, web fetches and the browser, except ones you've already allowed.", { exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("r19-new-chat-dialog.png"), animations: "disabled" });
    // OpenCode has nothing of the helpers Claude Code and Codex have, and no account to swap the chat out from under itself.
    await expect(dialog.getByRole("combobox", { name: "Helper agents use", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: "Account", exact: true })).toHaveCount(0);

    // Started like any chat: on its account, with OpenCode, and the effort picked.
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/chats" && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    const res = await started;
    expect(res.request().postDataJSON()).toMatchObject({ provider: "opencode", account: made.id, model: PICK, effort: "low" });
    const room = (await res.json()) as { id?: string };
    roomId = room.id ?? "";
    expect(roomId).toBeTruthy();

    // It's Refuseless you message, and its empty state says OpenCode drives it.
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveAttribute("placeholder", "Message Refuseless");
    await expect(page.getByText(/driven by OpenCode\./)).toBeVisible();
    const top = page.locator("header.topbar");
    await expect(top).toContainText("Refuseless");
    await expect(top).toContainText(PICK);
    await expect(top).not.toContainText("Codex");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("r4-refuseless-chat.png"), animations: "disabled" });

    // The row under the message box shows the effort, and changes it the way it does for Claude Code and Codex.
    const memberId = ((await (await request.get(`${HUB}/api/state`, { headers })).json()).members as { id: string; roomId: string }[]).find((m) => m.roomId === roomId)!.id;
    const bar = page.locator(".chat-controls");
    await expect(bar.getByRole("button", { name: "Low", exact: true })).toBeVisible();
    await bar.getByRole("button", { name: "Low", exact: true }).click();
    const patched = page.waitForRequest((r) => r.url().endsWith(`/api/members/${memberId}`) && r.method() === "PATCH");
    await page.locator(".effort-ticks").getByRole("button", { name: "Max", exact: true, includeHidden: true }).click();
    expect((await patched).postDataJSON()).toMatchObject({ config: { effort: "max", account: made.id } });
    await expect(bar.getByRole("button", { name: "Max", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    // So do the chat's settings: what drives it in a line, and the same Effort.
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    const chatSettings = page.getByRole("dialog", { name: "Chat settings", exact: true });
    await expect(chatSettings.getByText(/· driven by OpenCode\.$/)).toBeVisible();
    await expect(chatSettings.getByText(/helper agents follow/)).toHaveCount(0);
    const chatEffort = chatSettings.getByRole("combobox", { name: "Effort", exact: true });
    await expect(chatEffort).toHaveValue("max");
    await chatEffort.selectOption("off");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("r20-chat-settings.png"), animations: "disabled" });
    const saved = page.waitForRequest((r) => r.url().endsWith(`/api/members/${memberId}`) && r.method() === "PATCH");
    await chatSettings.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).postDataJSON()).toMatchObject({ model: PICK, config: { effort: "off", account: made.id } });
    await expect(chatSettings).toHaveCount(0);

    // A model that lists no levels has no Effort there either.
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await chatSettings.getByRole("combobox", { name: "Model", exact: true }).selectOption("glm-5.3-abliterated");
    await expect(chatEffort).toHaveCount(0);

    // Deleted, it goes Home: OpenCode has no screen of its own to go back to, and is never asked for one.
    const asked: string[] = [];
    page.on("request", (r) => asked.push(new URL(r.url()).pathname + new URL(r.url()).search));
    await chatSettings.getByRole("button", { name: "Delete chat", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete this chat?", exact: true }).getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("dialog", { name: "Are you sure?", exact: true }).getByRole("button", { name: "Yes, delete", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
    await expect(page.locator(".agent-card").first()).toBeVisible();
    await expect(page.locator(".agent-hero")).toHaveCount(0);
    expect(asked.filter((u) => u.startsWith("/api/chats/local"))).toEqual([]);
  } finally {
    if (roomId) await request.delete(`${HUB}/api/rooms/${roomId}`, { headers });
    await request.delete(`${HUB}/api/accounts/opencode/${made.id}`, { headers });
  }
});

test("a service on OpenCode isn't offered in New chat while OpenCode isn't installed; its chat's heading says what to do and goes to the card", async ({ page, request, token }) => {
  const HUB = "http://127.0.0.1:8451";
  const headers = { authorization: `Bearer ${token}` };
  await phone(page);
  const made = await (await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "opencode", label: "Refuseless", baseUrl: "http://127.0.0.1:9", apiKey: "abl_test", models: [PICK], contextWindow: M, protocol: "chat" } })).json();
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "opencode", account: made.id, model: PICK } })).json();
  try {
    await page.route("**/api/providers/opencode/models**", (route: Route) => route.fulfill({ json: { provider: "opencode", accountId: made.id, live: true, error: null, models: [{ id: PICK, label: PICK, description: null, efforts: [], defaultEffort: null, isDefault: true, contextWindow: M }] } }));
    await page.route(home("/api/state"), async (route) => {
      const snapshot = await (await route.fetch()).json();
      return route.fulfill({ json: { ...snapshot, providers: [...snapshot.providers, NO_OPENCODE] } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: /^Show chats/ }).click();
    const list = page.locator(".chat-sidebar.drawer");
    await list.getByRole("button", { name: "New chat", exact: true }).click();
    const menu = list.getByRole("menu", { name: "New chat", exact: true });
    await expect(menu.getByRole("menuitem", { name: /Claude Code/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Refuseless/ })).toHaveCount(0);
    await list.getByRole("button", { name: "New chat", exact: true }).click();
    // The chat already there keeps its heading, and starting another there says what it needs, with the way to it.
    await list.getByRole("button", { name: /^New chat with Refuseless/ }).click();
    const dialog = page.getByRole("dialog", { name: "New chat with Refuseless", exact: true });
    const missing = dialog.getByRole("alert");
    await expect(missing).toContainText("OpenCode isn't installed on");
    await expect(missing).toContainText("OpenCode is the agent that would run Refuseless, so the chat couldn't answer yet. Install it from Settings, then start the chat.");
    await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toBeDisabled();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("r21-new-chat-not-installed.png"), animations: "disabled" });
    await missing.getByRole("button", { name: "Open settings", exact: true }).click();
    const card = page.getByRole("region", { name: "OpenCode", exact: true });
    await expect(card.getByRole("button", { name: "Install", exact: true })).toBeInViewport();
  } finally {
    await request.delete(`${HUB}/api/rooms/${room.id}`, { headers });
    await request.delete(`${HUB}/api/accounts/opencode/${made.id}`, { headers });
  }
});
