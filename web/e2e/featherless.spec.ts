import type { Page, Route } from "@playwright/test";
import type { CatalogModel, CatalogSearch, ServicePlan, ServiceTestResult } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Adding Featherless and finding a model in its catalogue, on a phone screen (390px), and what the app says about its
// plans: its $25 Chat plan's terms don't allow agents or API use, and agents need its Developer plan, paid per token
// (featherless.ai/pricing). The hub's answers are played here: the shared test hub's accounts and settings stay as they
// were, and nothing reaches the real Featherless.
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
/** The machine this app opens from (the test hub), as requests to it are addressed. */
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;

const PICK = "huihui-ai/Huihui-Qwen3.5-27B-abliterated";
const TOTAL = 22_406;
const account = (over: Record<string, unknown>) => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: "me@example.com", plan: "Plus", authMethod: "chatgpt", error: null, checkedAt: Date.now(), ...over });
const CODEX_MAIN = account({});
const CLAUDE_MAIN = account({ provider: "claude", plan: "Max" });

/** A row of Featherless's catalogue as the hub trims it (hub/src/featherless.ts). */
const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({ id: PICK, modelClass: "qwen3.5-27b", params: 27, contextWindow: 32_768, concurrency: 2, gated: false, tools: true, toolsSaid: "docs", ...over });
/** What the hub answers for Featherless: no models to tick, a catalogue to search. */
const CHECKED: ServiceTestResult = {
  reachable: true,
  authOk: true,
  server: null,
  protocols: { responses: "no", messages: "no", chat: "yes" },
  models: [],
  works: [{ provider: "codex", via: "adapter" }],
  problems: [],
  catalog: { name: "featherless", total: TOTAL },
};
/**
 * Which plan a key is on, as the hub reads it (GET /v1/plan): the Chat plan, under the name the docs' example gives it,
 * and the Developer plan as the plan list behind Featherless's pricing page names and sizes it ("Request Pricing", no cap
 * of its own on a chat).
 */
const CHAT_PLAN: ServicePlan = { id: "feather_pro_plus", name: "Feather Premium", kind: "chat", maxContext: 32_768, concurrency: 4, checkedAt: Date.now() };
const DEVELOPER_PLAN: ServicePlan = { id: "feather_request_pricing", name: "Request Pricing", kind: "credits", maxContext: null, concurrency: 100, checkedAt: Date.now() };
const TERMS = "Agents need Featherless's Developer plan. It's paid per token from monthly credits, so set a spending limit in Settings → Costs. The $25 Chat plan doesn't allow agents or API use: Featherless can cancel an account used that way without a refund.";
const CHAT_WARNING = "This key is on Featherless's Chat plan, which doesn't allow agents or API use: using it here could get your account cancelled without a refund. Switch to the Developer plan first (paid per token, so set a spending limit).";
const DEVELOPER_LINE = "This key is on Featherless's Developer plan, which allows agents. Each reply is paid per token from your credits, so set a spending limit in Settings → Costs.";
/** What the hub says in a chat whose agent runs on a key it read as on the Chat plan (hub/src/featherless.ts chatNotice). */
const CHAT_NOTE = "Featherless says this key is on its Chat plan, which doesn't allow agents or API use: Featherless can cancel an account used that way without a refund. Agents need its Developer plan: paid per token, so set a spending limit in Settings → Costs. See https://featherless.ai/pricing.";
/** A Featherless account as the hub lists it once it's added. */
const FEATHER_ACCOUNT = account({ id: "feather1", label: "Featherless", kind: "endpoint", account: null, plan: "Custom model", endpoint: { baseUrl: "https://api.featherless.ai", models: [PICK], contextWindow: 32_768, hasKey: true, protocol: "chat", contexts: { [PICK]: 32_768 } } });

/** With nothing typed: the service's own uncensored models, the ones an agent can use first. */
const SUGGESTED: CatalogModel[] = [
  model(),
  model({ id: "OBLITERATUS/Qwen3.8-27B-OBLITERATED", modelClass: "qwen3_5-27b" }),
  // Its own row says `features.tool_use`, which Featherless's docs don't promise for that family: toolsSaid "list".
  model({ id: "wangzhang/gemma-4-31B-it-abliterated", modelClass: "gemma4-31b", params: 31, tools: false, toolsSaid: "list" }),
  model({ id: "meta-llama/Llama-3.3-70B-Instruct", modelClass: "llama33-70b", params: 70, concurrency: 4, gated: true, tools: false }),
];

async function hub(page: Page) {
  const state = {
    accounts: [CLAUDE_MAIN, CODEX_MAIN] as Record<string, unknown>[],
    tests: [] as Record<string, unknown>[],
    /** What POST /api/services/test answers; a test may make it one whose model list couldn't be read. */
    checked: CHECKED as ServiceTestResult,
    saved: [] as Record<string, unknown>[],
    /** Every catalogue search the app asked for, in order: "" is the one with nothing typed. */
    searches: [] as string[],
    /** What GET /api/accounts/:p/:id/plan answers for a Featherless account's row: its key's plan, or a status (404: an older hub). */
    plan: { status: 404 } as { status: number } | { plan: ServicePlan | null },
    planReads: 0,
    /** What GET /api/services/catalog answers: a search, or a status to fail with. */
    catalog: (q: string): CatalogSearch | { status: number; error: string } =>
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
    return json(route, state.checked);
  });
  await page.route((url) => url.pathname === "/api/services/catalog" && url.origin === "http://127.0.0.1:5198", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    state.searches.push(q);
    const answer = state.catalog(q);
    return "status" in answer ? json(route, { error: answer.error }, answer.status) : json(route, answer);
  });
  await page.route((url) => url.origin === "http://127.0.0.1:5198" && /^\/api\/accounts\/[^/]+\/[^/]+\/plan$/.test(url.pathname), (route) => {
    state.planReads++;
    return "status" in state.plan ? json(route, { error: "not found" }, state.plan.status) : json(route, state.plan);
  });
  await page.route(home("/api/accounts/endpoint"), (route) => {
    const body = route.request().postDataJSON();
    state.saved.push(body);
    const saved = account({ id: "feather1", label: body.label, provider: body.provider, kind: "endpoint", account: null, plan: "Custom model", endpoint: { baseUrl: body.baseUrl, models: body.models, contextWindow: body.contextWindow, hasKey: true, protocol: body.protocol, contexts: body.contexts } });
    state.accounts.push(saved);
    return json(route, saved);
  });
  // A custom model's own list, as the hub gives it once the account exists.
  await page.route((url) => url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/models") && url.origin === "http://127.0.0.1:5198", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("account") ?? "default";
    const saved = state.accounts.find((a) => a.id === id && a.kind === "endpoint") as { endpoint: { models: string[] } } | undefined;
    if (!saved) return route.fallback();
    return json(route, { provider: "codex", accountId: id, live: true, error: null, models: saved.endpoint.models.map((m) => ({ id: m, label: m, description: "On Featherless", efforts: [], defaultEffort: null, isDefault: true, contextWindow: 32_768 })) });
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

test("Featherless: its plan in plain words, a key, and a model found by searching its catalogue", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await expect(dialog.getByRole("button", { name: /^Featherless/ })).toContainText("Agents need its Developer plan, paid per token.");
  await dialog.getByRole("button", { name: /^Featherless/ }).click();

  // Before any key: which plan agents need and what it costs, the plan they can't use and what using it risks, and
  // Featherless's own page about it — said as a warning, not small print, and never "flat" or "unlimited".
  const terms = dialog.getByRole("note");
  await expect(terms).toHaveText(`${TERMS} See featherless.ai/pricing.`);
  const pricing = terms.getByRole("link", { name: "featherless.ai/pricing", exact: true });
  await expect(pricing).toHaveAttribute("href", "https://featherless.ai/pricing");
  await expect(pricing).toHaveAttribute("target", "_blank");
  await expect(dialog.getByText(/flat|unlimited|as many requests/i)).toHaveCount(0);
  await expect(dialog.getByText("Crosstalk searches its 22,000 models instead of listing them.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "featherless.ai/docs", exact: true })).toHaveAttribute("href", "https://featherless.ai/docs");
  const open = dialog.getByRole("link", { name: "Open featherless.ai/account/api-keys", exact: true });
  await expect(open).toHaveAttribute("href", "https://featherless.ai/account/api-keys");
  await expect(open).toHaveAttribute("target", "_blank");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f1-featherless-steps.png"), animations: "disabled" });

  // The key, then Test. The address is the one the preset holds.
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("22,406 models to search", { exact: true })).toBeVisible();
  expect(h.tests).toEqual([{ baseUrl: "https://api.featherless.ai", apiKey: "rc_featherless_key" }]);
  for (const line of ["Reachable", "Key works", "Works with Codex"]) await expect(dialog.getByText(line, { exact: true })).toBeVisible();
  // Chat Completions is all it speaks, so the adapter is in between and the line says so.
  await expect(dialog.getByText("through the chat adapter", { exact: true })).toBeVisible();

  // Nothing is ticked for you: you pick by searching. The first list is the service's own uncensored models.
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(dialog.getByText("A few uncensored ones of the 22,406. Type a name to find another.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(SUGGESTED.length);
  expect(h.searches).toEqual([""]);
  // The facts beside each name, and the marks that say what a model can't do.
  const row = (id: string) => dialog.locator(".svc-model-list li", { hasText: id });
  await expect(row(PICK).getByText("27B · 32k · uses 2 of your 4 at a time", { exact: true })).toBeVisible();
  await expect(row("gemma-4-31B").getByText("No tools", { exact: true })).toBeVisible();
  await expect(row("Llama-3.3-70B").getByText("Gated", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Featherless's docs say tool calls work on the Qwen 3 family and Kimi K2/)).toBeVisible();
  // And where its own list disagrees with its docs, that is said as what isn't promised — not as what a model can't do.
  await expect(dialog.getByText("Featherless's own list says some of those can call tools, but its docs don't promise it for their family, so Crosstalk doesn't count on it.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/agree to its licence/)).toBeVisible();
  await atTop(dialog.getByText("Models", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f2-featherless-suggested.png"), animations: "disabled" });

  // Searching by part of a name, typed a letter at a time (which is how a phone types): one request for the whole word,
  // not one per letter — including right after Test, before any search has come back.
  await dialog.getByRole("textbox", { name: "Search models", exact: true }).pressSequentially("huihui", { delay: 30 });
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await expect(dialog.getByText("1 model matched.", { exact: true })).toBeVisible();
  expect(h.searches).toEqual(["", "huihui"]);
  await dialog.getByRole("checkbox", { name: new RegExp(PICK) }).check();
  await expect(row(PICK).getByText("Default", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f3-featherless-found.png"), animations: "disabled" });

  // Adding it saves the model, its own context and the chat lane.
  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toEqual({
    provider: "codex",
    baseUrl: "https://api.featherless.ai",
    label: "Featherless",
    apiKey: "rc_featherless_key",
    models: [PICK],
    contextWindow: 32_768,
    protocol: "chat",
    contexts: { [PICK]: 32_768 },
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Added. Pick it as the account in a new Codex chat.", { exact: true })).toBeVisible();
  const added = page.getByRole("group", { name: "Codex · Featherless", exact: true });
  await expect(added.getByText("Codex · Custom model · api.featherless.ai · chat adapter", { exact: true })).toBeVisible();
  // A hub that can't say which plan the key is on still says what agents need, on the row.
  await expect(added.getByText("Agents need Featherless's Developer plan, paid per token. Its Chat plan doesn't allow them. See featherless.ai/pricing.", { exact: true })).toBeVisible();
});

test("a key on the Chat plan: the check says plainly that plan doesn't allow agents, and how to get one that does", async ({ page }) => {
  const h = await hub(page);
  h.checked = { ...CHECKED, plan: CHAT_PLAN };
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^Featherless/ }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("22,406 models to search", { exact: true })).toBeVisible();

  // Read out at once, right under what the check found, with Featherless's plans a tap away.
  const warning = dialog.getByRole("alert");
  await expect(warning).toHaveText(`${CHAT_WARNING} See featherless.ai/pricing.`);
  await expect(warning.getByRole("link", { name: "featherless.ai/pricing", exact: true })).toHaveAttribute("href", "https://featherless.ai/pricing");
  // The plan's own figures, until it's switched: 32K of a chat at once, four requests at a time.
  const row = (id: string) => dialog.locator(".svc-model-list li", { hasText: id });
  await expect(row(PICK).getByText("27B · 32k · uses 2 of your 4 at a time", { exact: true })).toBeVisible();
  await atTop(dialog.getByText("Works with Codex", { exact: true }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f7-featherless-chat-plan.png"), animations: "disabled" });

  // It's still the person's to add (they may be switching plans): nothing is blocked, it's said.
  await dialog.getByRole("checkbox", { name: new RegExp(PICK) }).check();
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeEnabled();
});

test("a key on the Developer plan: allowed, paid per token, priced per model, and a 256K model keeps its size", async ({ page }) => {
  const h = await hub(page);
  h.checked = { ...CHECKED, plan: DEVELOPER_PLAN };
  h.catalog = (q) => ({ name: "featherless", q, models: [model({ id: "Qwen/Qwen3-235B-A22B", modelClass: "qwen3moe-235b", params: 235, contextWindow: 262_144, concurrency: 4, price: { input: 0.8, output: 3.4, cached: null } })], matched: 1, total: TOTAL });
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^Featherless/ }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("22,406 models to search", { exact: true })).toBeVisible();

  // No warning about terms that allow it: what it costs, and where to cap that.
  await expect(dialog.getByText(DEVELOPER_LINE)).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  // Its price per million tokens beside the model, and what a big model uses of the plan's 100 at a time.
  const big = dialog.locator(".svc-model-list li", { hasText: "Qwen3-235B" });
  await expect(big.getByText("235B · 256k · uses 4 of your 100 at a time · $0.80 in, $3.4 out per million", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Qwen3-235B/ }).check();
  // The plan has no cap of its own (each model's own applies, 256K at most), so nothing is held to 32K.
  await expect(dialog.getByText(/Your plan reads/)).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f8-featherless-developer.png"), animations: "disabled" });

  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toMatchObject({ models: ["Qwen/Qwen3-235B-A22B"], contextWindow: 262_144, contexts: { "Qwen/Qwen3-235B-A22B": 262_144 } });
});

test("a Featherless account's row says which plan its key is on: the Chat plan warned, the Developer plan with a way to a limit", async ({ page }) => {
  const h = await hub(page);
  h.accounts.push(FEATHER_ACCOUNT);
  h.plan = { plan: CHAT_PLAN };
  await settings(page);
  const added = page.getByRole("group", { name: "Codex · Featherless", exact: true });
  await expect(added.getByText(`${CHAT_WARNING} See featherless.ai/pricing.`, { exact: true })).toBeVisible();
  await expect(added.getByRole("link", { name: "featherless.ai/pricing", exact: true })).toHaveAttribute("href", "https://featherless.ai/pricing");
  await expect(added.getByRole("button", { name: "Set a spending limit", exact: true })).toHaveCount(0);
  await atTop(added);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f9-featherless-row-chat-plan.png"), animations: "disabled" });

  // Switched to the Developer plan on Featherless, then Test: the row reads the plan again and says what it costs.
  h.plan = { plan: DEVELOPER_PLAN };
  const reads = h.planReads;
  await added.getByRole("button", { name: "Test", exact: true }).click();
  await expect.poll(() => h.planReads).toBeGreaterThan(reads);
  await expect(added.getByText(`${DEVELOPER_LINE} See featherless.ai/pricing.`, { exact: true })).toBeVisible();
  await expect(added.getByText(CHAT_WARNING)).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f10-featherless-row-developer.png"), animations: "disabled" });
  // Paid per token: the way to a limit is right there, and it lands on Costs.
  await added.getByRole("button", { name: "Set a spending limit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeInViewport();
});

test("in a chat on such a key, Crosstalk's note says what the plan allows and links Featherless's plans", async ({ page, request, token }) => {
  // A chat on the shared test hub, with the note its hub would have put at the top played into its history: the test
  // hub's Featherless is a closed port, so it never reads a plan itself.
  const room = await (await request.post("http://127.0.0.1:8451/api/chats", { headers: { authorization: `Bearer ${token}` }, data: { provider: "codex", name: "Featherless chat" } })).json();
  await page.route((url) => url.origin === "http://127.0.0.1:5198" && url.pathname === `/api/rooms/${room.id}/history`, async (route) => {
    const history = await (await route.fetch()).json();
    const at = Date.now();
    const note = { id: "m_featherless", roomId: room.id, authorKind: "system", memberId: null, authorName: "Crosstalk", text: CHAT_NOTE, mentions: [], turnId: null, status: "done", createdAt: at, updatedAt: at };
    return route.fulfill({ json: { ...history, messages: [note, ...history.messages] } });
  });
  await phone(page);
  await page.goto(`/#/room/${room.id}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();

  // The words as the hub wrote them, the address shown as every other screen shows one, and a tap away.
  const line = page.locator(".msg.system .sys").first();
  await expect(line).toHaveText(CHAT_NOTE.replace("https://", ""));
  const link = line.getByRole("link", { name: "featherless.ai/pricing", exact: true });
  await expect(link).toHaveAttribute("href", "https://featherless.ai/pricing");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer noopener");
  await expect(line).not.toContainText(/flat|unlimited/i);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f11-featherless-chat-note.png"), animations: "disabled" });
});

test("a model that can't run tools is still yours to pick, and a 256K model is saved at the plan's 32K", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^Featherless/ }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("22,406 models to search", { exact: true })).toBeVisible();

  // A big model whose own context is more than the plan reads at once.
  h.catalog = () => ({ name: "featherless", q: "qwen3-235", models: [model({ id: "Qwen/Qwen3-235B-A22B", modelClass: "qwen3moe-235b", params: 235, contextWindow: 262_144, concurrency: 4 })], matched: 1, total: TOTAL });
  await dialog.getByRole("textbox", { name: "Search models", exact: true }).fill("qwen3-235");
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await dialog.getByRole("checkbox", { name: /Qwen3-235B/ }).check();
  await expect(dialog.getByText("Your plan reads 32k of a chat at once, so a model that could hold more is saved at 32k.", { exact: true })).toBeVisible();

  // One that can't run tools: marked, and picking it is allowed.
  h.catalog = () => ({ name: "featherless", q: "gemma", models: [model({ id: "wangzhang/gemma-4-31B-it-abliterated", modelClass: "gemma4-31b", params: 31, tools: false })], matched: 1, total: TOTAL });
  await dialog.getByRole("textbox", { name: "Search models", exact: true }).fill("gemma");
  await dialog.getByRole("checkbox", { name: /gemma-4-31B/ }).check();
  // The one picked before stays in view, so it can still be unticked or made the default.
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(2);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f4-featherless-no-tools.png"), animations: "disabled" });

  await dialog.getByRole("button", { name: "Add it", exact: true }).click();
  await expect.poll(() => h.saved.length).toBe(1);
  expect(h.saved[0]).toMatchObject({
    models: ["Qwen/Qwen3-235B-A22B", "wangzhang/gemma-4-31B-it-abliterated"],
    contexts: { "Qwen/Qwen3-235B-A22B": 32_768, "wangzhang/gemma-4-31B-it-abliterated": 32_768 },
  });
});

test("a search that nothing matches, and one the hub can't run, both say what to do next", async ({ page }) => {
  const h = await hub(page);
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^Featherless/ }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("22,406 models to search", { exact: true })).toBeVisible();

  h.catalog = (q) => ({ name: "featherless", q, models: [], matched: 0, total: TOTAL });
  await dialog.getByRole("textbox", { name: "Search models", exact: true }).fill("zzznothing");
  await expect(dialog.getByText("Nothing matched “zzznothing”. Try part of a model's name, like qwen3 or abliterated.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add it", exact: true })).toBeDisabled();

  // The hub couldn't read the catalogue: the service's own words, and what to do about them.
  h.catalog = () => ({ status: 502, error: "Featherless didn't answer within 8 seconds. Try again." });
  await dialog.getByRole("textbox", { name: "Search models", exact: true }).fill("qwen3");
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("The search didn't run: Featherless didn't answer within 8 seconds. Try again.");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f5-featherless-search-failed.png"), animations: "disabled" });

  // The way out is right there: Try again asks for the same words again.
  h.catalog = (q) => ({ name: "featherless", q, models: SUGGESTED.slice(0, 2), matched: 2, total: TOTAL });
  await alert.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // And a one-tap search brings the whole shortlist back.
  h.catalog = () => ({ name: "featherless", q: "", models: SUGGESTED, matched: 544, total: TOTAL });
  await dialog.getByRole("button", { name: "Uncensored", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(SUGGESTED.length);
});

test("a check that couldn't read the catalogue still offers the search, not 22,406 names to type by hand", async ({ page }) => {
  const h = await hub(page);
  // The hub's answer when Featherless's list didn't come back: still a catalogue service, with nothing counted.
  h.checked = { ...CHECKED, authOk: null, catalog: { name: "featherless", total: 0 }, problems: ["Featherless's model list answered with error 500. Try again in a minute. Crosstalk needs its model list to find a model for you."] };
  await settings(page);
  await page.getByRole("button", { name: "Add an AI service", exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole("button", { name: /^Featherless/ }).click();
  await dialog.getByLabel("API key", { exact: true }).fill("rc_featherless_key");
  await dialog.getByRole("button", { name: "Test", exact: true }).click();

  // What went wrong, and the search box all the same — never "type the ones you want, separated by commas".
  await expect(dialog.getByText("Couldn't read its model list", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Crosstalk needs its model list to find a model for you/)).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Search models", exact: true })).toBeVisible();
  await expect(dialog.getByText(/Type the ones you want, separated by commas/)).toHaveCount(0);
  await expect(dialog.getByText("Far too many models to list, so you search for the one you want. Pick up to 20; the first is the default.", { exact: true })).toBeVisible();
  // The list itself answers, so the models are there to pick: nothing has to be typed.
  await expect(dialog.getByRole("checkbox")).toHaveCount(SUGGESTED.length);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("f6-featherless-list-unread.png"), animations: "disabled" });
});
