import type { Page, Route } from "@playwright/test";
import type { CatalogFilter, CatalogModel, CatalogSearch, ServiceFunds, ServiceTestResult } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Adding NanoGPT and finding an uncensored model in its list, on a phone screen (390px). The hub's answers are played
// here: the shared test hub's accounts and settings stay as they were, and nothing reaches the real NanoGPT.
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
/** The machine this app opens from (the test hub), as requests to it are addressed. */
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;

const PICK = "deepseek/deepseek-v4.1-flash-uncensored";
const TOTAL = 644;
const account = (over: Record<string, unknown>) => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: "me@example.com", plan: "Plus", authMethod: "chatgpt", error: null, checkedAt: Date.now(), ...over });
const CODEX_MAIN = account({});
const CLAUDE_MAIN = account({ provider: "claude", plan: "Max" });

/** A row of NanoGPT's list as the hub trims it (hub/src/nanogpt.ts), with the facts and price it had on 1 November 2026. */
const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: PICK,
  modelClass: "deepseek",
  params: null,
  contextWindow: 1_048_576,
  concurrency: null,
  gated: false,
  tools: true,
  toolsSaid: "service",
  name: "DeepSeek V4.1 Flash Uncensored",
  price: { input: 0.33, output: 1.32, cached: 0.00825 },
  inPlan: false,
  uncensored: true,
  reasoning: true,
  ...over,
});
const UNCENSORED: CatalogModel[] = [
  model({ id: "pqhaz/DeepSeek-V4.1-Flash-1017-heretic", name: "DeepSeek V4.1 Flash Heretic", contextWindow: 512_000, price: { input: 0.19, output: 0.74, cached: 0.012 } }),
  model(),
  model({ id: "z-ai/glm-5.3-flash-uncensored", name: "GLM 5.3 Flash Uncensored", modelClass: "z-ai", price: { input: 0.2, output: 0.8, cached: 0.07 }, inPlan: true }),
  model({ id: "venice-uncensored", name: "Venice Uncensored 1.2", modelClass: "venice", contextWindow: 131_072, tools: false, price: { input: 0.2, output: 0.9, cached: null }, inPlan: true, reasoning: false }),
];
const IN_PLAN: CatalogModel[] = [
  model({ id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", modelClass: "z-ai", price: { input: 0.1, output: 0.3, cached: 0.025 }, inPlan: true, uncensored: false }),
  UNCENSORED[2],
];
const FUNDS: ServiceFunds = { balanceUsd: 5, plan: { active: true, billing: "subscription", weekly: { used: 2_500_000, limit: 60_000_000, resetAt: null }, daily: null, renewsAt: null }, checkedAt: Date.now() };
/** What the hub answers for NanoGPT: no models to tick, a catalogue to search, both agents directly, and the key's balance. */
const CHECKED: ServiceTestResult = {
  reachable: true,
  authOk: true,
  server: null,
  protocols: { responses: "yes", messages: "yes", chat: "yes" },
  models: [],
  works: [{ provider: "builtin", via: "chat" }, { provider: "opencode", via: "chat" }, { provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }],
  problems: [],
  catalog: { name: "nanogpt", total: TOTAL },
  funds: FUNDS,
};

async function hub(page: Page) {
  const state = {
    accounts: [CLAUDE_MAIN, CODEX_MAIN] as Record<string, unknown>[],
    tests: [] as Record<string, unknown>[],
    saved: [] as Record<string, unknown>[],
    /** Every catalogue search the app asked for, in order, as "query|filter". */
    searches: [] as string[],
    fundsReads: 0,
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await page.route(home("/api/accounts"), (route) => (route.request().method() === "GET" ? json(route, state.accounts) : route.fallback()));
  await page.route(home("/api/state"), async (route) => {
    const snapshot = await (await route.fetch()).json();
    // A hub with OpenCode installed: one that doesn't list it offers no move to it.
    return json(route, { ...snapshot, accounts: state.accounts, providers: [...snapshot.providers, { provider: "opencode", installed: true, signedIn: true, version: "2.2.5" }] });
  });
  await page.route(home("/api/services/test"), (route) => {
    state.tests.push(route.request().postDataJSON());
    return json(route, CHECKED);
  });
  await page.route((url) => url.pathname === "/api/services/catalog" && url.origin === "http://127.0.0.1:5198", (route) => {
    const p = new URL(route.request().url()).searchParams;
    const q = p.get("q") ?? "";
    const filter = (p.get("filter") ?? "uncensored") as CatalogFilter;
    state.searches.push(`${q}|${filter}`);
    const part = filter === "plan" ? IN_PLAN : UNCENSORED;
    const models = part.filter((m) => !q || m.id.includes(q.toLowerCase()) || (m.name ?? "").toLowerCase().includes(q.toLowerCase()));
    const answer: CatalogSearch = { name: "nanogpt", q, filter, models, matched: q ? models.length : filter === "plan" ? 308 : 43, total: TOTAL };
    return json(route, answer);
  });
  await page.route(home("/api/accounts/endpoint"), (route) => {
    const body = route.request().postDataJSON();
    state.saved.push(body);
    const saved = account({ id: "nano1", label: body.label, provider: body.provider, kind: "endpoint", account: null, plan: "Custom model", endpoint: { baseUrl: body.baseUrl, models: body.models, contextWindow: body.contextWindow, hasKey: true, protocol: body.protocol, contexts: body.contexts } });
    state.accounts.push(saved);
    return json(route, saved);
  });
  await page.route(home("/api/accounts/builtin/nano1/funds"), (route) => {
    state.fundsReads++;
    return json(route, FUNDS);
  });
  // The account's own model menu, as the hub gives it once it exists: each model with NanoGPT's price after where it runs.
  await page.route((url) => url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/models") && url.origin === "http://127.0.0.1:5198", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("account") ?? "default";
    const saved = state.accounts.find((a) => a.id === id && a.kind === "endpoint") as { endpoint: { models: string[] } } | undefined;
    if (!saved) return route.fallback();
    return json(route, { provider: "codex", accountId: id, live: true, error: null, models: saved.endpoint.models.map((m) => ({ id: m, label: m, description: "On NanoGPT · $0.33 in · $1.32 out per million tokens · uncensored", efforts: [], defaultEffort: null, isDefault: true, contextWindow: 1_048_576 })) });
  });
  return state;
}

const settings = async (page: Page) => {
  await phone(page);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "AI services", exact: true })).toBeVisible();
};
const sheet = (page: Page) => page.getByRole("dialog", { name: "Add an AI service", exact: true });
/** Scrolls so the element starts at the top of the screen (a phone screenshot of just what's being shown). */
const atTop = (target: ReturnType<Page["getByRole"]>) => target.evaluate((el) => el.scrollIntoView({ block: "start" }));

test("NanoGPT: a key, its balance, an uncensored model found by its price and tags, and the account's balance after", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^NanoGPT/ }).click();

  // What you pay for, in plain words, and where the key comes from.
  await expect(dialog.getByText(/unless its \$12-a-month subscription covers the model/)).toBeVisible();
  await expect(dialog.getByText("Crosstalk's own agent runs it directly, with commands, files and BrowserOS neo: no other agent involved. Crosstalk searches its models, shows each one's price and your balance.", { exact: true })).toBeVisible();
  const open = dialog.getByRole("link", { name: "Open nano-gpt.com/api", exact: true });
  await expect(open).toHaveAttribute("href", "https://nano-gpt.com/api");
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(dialog.getByRole("link", { name: "docs.nano-gpt.com", exact: true })).toHaveAttribute("href", "https://docs.nano-gpt.com");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("n1-nanogpt-steps.png"), animations: "disabled" });

  // The key, then Test: both agents reach it directly, and the key's balance and subscription come with the check.
  await dialog.getByLabel("API key", { exact: true }).fill("sk-nano-key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("644 models to search", { exact: true })).toBeVisible();
  expect(h.tests).toEqual([{ baseUrl: "https://nano-gpt.com/api", apiKey: "sk-nano-key" }]);
  for (const line of ["Key works", "Works with Crosstalk agent", "Works with OpenCode", "Works with Codex", "Works with Claude Code", "Balance $5.00", "Subscription active: 2.5M of 60M tokens used this week"]) await expect(dialog.getByText(line, { exact: true })).toBeVisible();
  // Only Codex goes through Crosstalk's chat adapter; Crosstalk's own agent, OpenCode and Claude Code talk to NanoGPT themselves.
  await expect(dialog.getByText("through the chat adapter", { exact: true })).toHaveCount(1);
  // Crosstalk's own agent is offered first — no other agent involved — and says what it is; the others are a tap away.
  await expect(dialog.getByRole("radiogroup", { name: "Use it with", exact: true }).getByRole("radio")).toHaveText(["Crosstalk agent", "OpenCode", "Codex", "Claude Code"]);
  await expect(dialog.getByRole("radio", { name: "Crosstalk agent", exact: true })).toBeChecked();
  await expect(dialog.getByText(/Crosstalk agent talks to it directly, with tools for commands, files, a plan and BrowserOS neo/)).toBeVisible();

  // Nothing ticked for you: the first list is its uncensored models, each with NanoGPT's own name and price.
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
  // The hub sends a page of them (25 of the 43; this stand-in, 4): the words say there are more, and how to narrow it down.
  await expect(dialog.getByText("43 uncensored models of the 644, the ones that can run tools first, then the newest. These are the first 4 — type more to narrow it down.", { exact: true })).toBeVisible();
  expect(h.searches).toEqual(["|uncensored"]);
  const row = (id: string) => dialog.locator(".svc-model-list li", { hasText: id });
  await expect(row(PICK).getByText("DeepSeek V4.1 Flash Uncensored", { exact: true })).toBeVisible();
  await expect(row(PICK).getByText("1M · $0.33 in, $1.32 out per million (cached $0.008)", { exact: true })).toBeVisible();
  await expect(row(PICK).getByText("Uncensored", { exact: true })).toBeVisible();
  await expect(row("glm-5.3-flash-uncensored").getByText("In subscription", { exact: true })).toBeVisible();
  await expect(row("venice-uncensored").getByText("No tools", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/NanoGPT's list says which models can call tools/)).toBeVisible();
  await expect(dialog.getByText(/come out of the weekly allowance instead of your balance/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Uncensored", exact: true })).toHaveAttribute("aria-pressed", "true");
  await atTop(dialog.getByText("Models", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("n2-nanogpt-uncensored.png"), animations: "disabled" });

  // The subscription's models, a tap away.
  await dialog.getByRole("button", { name: "In subscription", exact: true }).click();
  await expect(dialog.getByText("308 models in NanoGPT's subscription of the 644, the ones that can run tools first, then the newest. These are the first 2 — type more to narrow it down.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "In subscription", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(h.searches).toEqual(["|uncensored", "|plan"]);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("n3-nanogpt-subscription.png"), animations: "disabled" });

  // Back to the uncensored ones, typed a letter at a time: one request for the word, then the pick.
  await dialog.getByRole("button", { name: "Uncensored", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Search models", exact: true }).pressSequentially("deepseek", { delay: 30 });
  await expect(dialog.getByText("2 models matched among the uncensored models.", { exact: true })).toBeVisible();
  expect(h.searches.at(-1)).toBe("deepseek|uncensored");
  await dialog.getByRole("checkbox", { name: new RegExp(PICK) }).check();
  await expect(row(PICK).getByText("Default", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("n4-nanogpt-picked.png"), animations: "disabled" });

  // Adding it saves the model with its own 1M context, for Crosstalk's own agent, which speaks Chat Completions itself.
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toEqual({
    provider: "builtin",
    baseUrl: "https://nano-gpt.com/api",
    label: "NanoGPT",
    apiKey: "sk-nano-key",
    models: [PICK],
    contextWindow: 1_048_576,
    protocol: "chat",
    contexts: { [PICK]: 1_048_576 },
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Added. Start a chat on NanoGPT from New chat.", { exact: true })).toBeVisible();
  // Its row in Settings says what runs it and what the account has left to spend, and can remove it (no agent card below).
  const added = page.getByRole("group", { name: "Crosstalk agent · NanoGPT", exact: true });
  await expect(added.getByText("Crosstalk agent · Custom model · nano-gpt.com", { exact: true })).toBeVisible();
  await expect(added.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(added.getByText("Balance $5.00 · Subscription active: 2.5M of 60M tokens used this week", { exact: true })).toBeVisible();
  expect(h.fundsReads).toBeGreaterThan(0);
  // It can move to OpenCode with its key, and a Test on it is the service's own check.
  await expect(added.getByRole("button", { name: "Run it with OpenCode", exact: true })).toBeEnabled();
  await added.getByRole("button", { name: "Test", exact: true }).click();
  await expect(added.getByText("Key works", { exact: true })).toBeVisible();
  expect(h.tests.at(-1)).toEqual({ baseUrl: "https://nano-gpt.com/api", accountId: "nano1" });
  // The Agents part below doesn't say Claude Code or Codex run it.
  await expect(page.getByText(/Crosstalk's own agent runs NanoGPT itself/)).toBeVisible();
  await atTop(added);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("n5-nanogpt-row.png"), animations: "disabled" });
});

test("a NanoGPT service on Crosstalk's agent is a row in New chat, and its chat is NanoGPT's — no Codex or Claude Code", async ({ page, request, token }) => {
  const HUB = "http://127.0.0.1:8451";
  const headers = { authorization: `Bearer ${token}` };
  await phone(page);
  // Saved the way the Add sheet saves it, on the real test hub. Its address is a closed port, so the hub never reaches
  // NanoGPT (or anything) with the key while the menu asks for the account's models.
  const account = await (
    await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "builtin", label: "NanoGPT", baseUrl: "http://127.0.0.1:9/api", apiKey: "sk-nano-test", models: [PICK], contextWindow: 1_048_576, protocol: "chat" } })
  ).json();
  let roomId = "";
  try {
    expect(account).toMatchObject({ provider: "builtin", kind: "endpoint", label: "NanoGPT" });
    await page.route("**/api/providers/builtin/models**", (route: Route) =>
      route.fulfill({ json: { provider: "builtin", accountId: account.id, live: true, error: null, models: [{ id: PICK, label: PICK, description: "On NanoGPT · $0.33 in · $1.32 out per million tokens · uncensored", efforts: [], defaultEffort: null, isDefault: true, contextWindow: 1_048_576 }] } }),
    );
    await page.goto("/");
    await page.getByRole("button", { name: /^Show chats/ }).click();
    const list = page.locator(".chat-sidebar.drawer");
    await list.getByRole("button", { name: "New chat", exact: true }).click();
    const menu = list.getByRole("menu", { name: "New chat", exact: true });
    // A row of its own, under its own name and model — not a Codex or Claude Code account.
    const row = menu.getByRole("menuitem", { name: /NanoGPT/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText(PICK);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("n6-nanogpt-new-chat.png"), animations: "disabled" });
    await row.click();

    const dialog = page.getByRole("dialog", { name: "New chat with NanoGPT", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(PICK);
    await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("n7-nanogpt-new-chat-dialog.png"), animations: "disabled" });
    // A service already added starts like any chat (POST /api/chats), on its account and with Crosstalk's own agent.
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/chats" && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    const res = await started;
    expect(res.request().postDataJSON()).toMatchObject({ provider: "builtin", account: account.id, model: PICK });
    roomId = ((await res.json()) as { id?: string }).id ?? "";
    expect(roomId).toBeTruthy();

    // The chat opens as NanoGPT's, on that model: it's NanoGPT you message.
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveAttribute("placeholder", "Message NanoGPT");
    const top = page.locator("header.topbar");
    await expect(top).toContainText("NanoGPT");
    await expect(top).toContainText(PICK);
    await expect(top).not.toContainText("Codex");
    await expect(top).not.toContainText("Claude Code");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("n8-nanogpt-chat.png"), animations: "disabled" });
  } finally {
    if (roomId) await request.delete(`${HUB}/api/rooms/${roomId}`, { headers });
    await request.delete(`${HUB}/api/accounts/builtin/${account.id}`, { headers });
  }
});
