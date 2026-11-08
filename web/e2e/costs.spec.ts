// Settings -> Costs, the chat's cost line, and the notices about spending limits (docs/SPEC-0.4.md, track T4).
// The hub's answers are mocked here, so the shared test hub's state stays as it was.
import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { AccountSpend, BudgetState, SpendTotals } from "@crosstalk/shared";
import { join } from "node:path";

const hub = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
// (Animations finish first, so a popup or a notice that is still fading in isn't caught half drawn.)
const shot = (name: string) => ({ animations: "disabled" as const, ...(process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {}) });

// `estimated`: how many replies were priced from tokens, as a hub that counts them sends it (it isn't in the contract yet).
const totals = (usd: number, replies: number, unpriced = 0, estimated?: number): SpendTotals => ({ usd, replies, unpriced, inputTokens: replies * 1200, outputTokens: replies * 300, ...(estimated === undefined ? {} : { estimated }) });
const SINCE = Date.UTC(2026, 9, 3, 12);
const budget = (usedUsd: number, limitUsd = 250, period: "month" | "total" = "month"): BudgetState => ({
  limitUsd,
  period,
  since: SINCE,
  usedUsd,
  percent: Math.floor((usedUsd / limitUsd) * 100),
  state: usedUsd >= limitUsd ? "stopped" : usedUsd >= limitUsd * 0.8 ? "warn" : "ok",
});
// The hub calls a default sign-in "Main", whichever agent it belongs to.
const acct = (over: Partial<AccountSpend>): AccountSpend => ({ provider: "claude", account: "default", label: "Main", kind: "signin", today: totals(0.4, 3), month: totals(12.3, 40), total: totals(48, 120), budget: null, ...over });
const apiKey = (over: Partial<AccountSpend> = {}) => acct({ label: "API key", kind: "apikey", today: totals(2.5, 4), month: totals(200, 60), total: totals(300, 200), ...over });

/** The page's height for a screenshot of a long screen (its width stays the project's). */
const tall = (page: Page, height: number) => page.setViewportSize({ width: page.viewportSize()!.width, height });

/** The hub's cost answers (the test hub has none of its own), and the limits the page asked for. */
async function mockSpend(page: Page, accounts: AccountSpend[]) {
  const state = { accounts, status: 200, putFails: 0 };
  const puts: { provider: string; account: string; body: { limitUsd: number | null; period?: string } }[] = [];
  await page.route("**/api/spend", (r) => {
    if (r.request().method() !== "GET") return r.fallback();
    if (state.status !== 200) return r.fulfill({ status: state.status, json: { error: "Not found" } });
    return r.fulfill({ json: { accounts: state.accounts, updatedAt: Date.now(), prices: { source: "models.dev", fetchedAt: Date.now() - 3 * 3600_000 } } });
  });
  await page.route("**/api/spend/budgets/**", (r) => {
    const [, provider, account] = new URL(r.request().url()).pathname.match(/budgets\/([^/]+)\/([^/]+)$/)!;
    const body = r.request().postDataJSON();
    puts.push({ provider, account: decodeURIComponent(account), body });
    if (state.putFails > 0) {
      state.putFails--;
      return r.fulfill({ status: 500, json: { error: "The hub is busy" } });
    }
    const a = state.accounts.find((x) => x.provider === provider && x.account === decodeURIComponent(account))!;
    const period = body.period ?? a.budget?.period ?? "month";
    const used = a.budget && a.budget.period === period ? a.budget.usedUsd : period === "total" ? a.total.usd : a.month.usd;
    a.budget = body.limitUsd === null ? null : budget(used, body.limitUsd, period as "month" | "total");
    return r.fulfill({ json: a });
  });
  return { state, puts };
}

const settingsOf = (priceLookup?: boolean) => ({
  machineName: "",
  agentsAcrossChats: false,
  pauseNearLimit: false,
  teamwork: { enabled: true, perReply: 1, skipAbovePercent: 80, helper: { claude: { model: "claude-sonnet", effort: "low" }, codex: { model: null, effort: null } } },
  storage: { autoClean: true, lowSpaceGb: 15 },
  ...(priceLookup === undefined ? {} : { priceLookup }),
});

async function openCosts(page: Page) {
  await page.goto("/#/settings/costs");
  const heading = page.getByRole("heading", { name: "Costs", exact: true });
  await expect(heading).toBeVisible();
  await page.evaluate(() => document.getElementById("costs")!.scrollIntoView({ block: "start" }));
  return heading;
}

test("costs lists each account with today, this month and total, and where it stands on its limit", async ({ page }) => {
  await mockSpend(page, [
    acct({ total: totals(48, 120, 5) }),
    // Both agents' default sign-ins are called "Main": the cards tell them apart by the agent.
    acct({ provider: "codex", today: totals(0.2, 2), month: totals(3, 8), total: totals(9, 20) }),
    apiKey({ account: "work", label: "Work key", today: totals(1, 5), month: totals(100, 30), total: totals(150, 90), budget: budget(100) }),
    // Some of this key's replies were priced from tokens: its month and total are drawn with ≈, and so is its limit.
    apiKey({ account: "key", provider: "codex", month: totals(200, 60, 0, 12), total: totals(300, 200, 0, 30), budget: budget(200) }),
    apiKey({ account: "team", provider: "codex", label: "Team key", today: totals(0, 0), month: totals(251, 50), total: totals(251, 50), budget: budget(251) }),
    acct({ provider: "codex", account: "kimi", label: "Kimi on Together", kind: "endpoint", today: totals(0.1, 1), month: totals(1, 6), total: totals(2.6, 12) }),
    // A plan sign-in that never replied has nothing to show: no card.
    acct({ account: "spare", label: "Spare", today: totals(0, 0), month: totals(0, 0), total: totals(0, 0) }),
  ]);
  await tall(page, 2300);
  await openCosts(page);
  await expect(page.getByText("What your AI accounts cost at API prices. Plan sign-ins show what the use would cost; only API keys and online services are billed.")).toBeVisible();

  // What is billed is added up, and the plan sign-ins' notional figures are not in it: with the two plans' $0.60, $15.30
  // and $57 it would read $4.20, $567 and $761. The key whose replies were partly estimated makes the sums ≈ as well.
  const all = page.getByRole("region", { name: "Costs for billed accounts", exact: true });
  await expect(all.locator(".cost-name")).toHaveText("Billed accounts");
  await expect(all).toContainText("$3.60");
  await expect(all).toContainText("≈$552");
  await expect(all).toContainText("≈$704");
  for (const withPlans of ["$4.20", "$567", "$761"]) await expect(all).not.toContainText(withPlans);
  await expect(page.getByRole("region", { name: "Costs for all accounts" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Costs for Spare · Claude Code", exact: true })).toHaveCount(0);

  // Every card is a region of its own: two cards never share a name, a title or a name for a screen reader.
  const regions = await page.locator("section.cost-card").evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label"), e.querySelector(".cost-name")?.textContent]));
  // The billed total and six accounts (the plan sign-in that never replied has none).
  expect(regions.length).toBe(7);
  expect(new Set(regions.map(([label]) => label)).size).toBe(regions.length);
  expect(new Set(regions.map(([, title]) => title)).size).toBe(regions.length);
  const plan = page.getByRole("region", { name: "Costs for Main · Claude Code", exact: true });
  await expect(plan.locator(".cost-name")).toHaveText("Main · Claude Code");
  for (const word of ["Today", "This month", "Total", "$0.40", "$12.30", "$48.00", "Plan sign-in", "5 replies without a price"]) await expect(plan).toContainText(word);
  await expect(plan.getByRole("button", { name: "Set a limit" })).toHaveCount(0);
  await expect(plan).toContainText("isn't billed per reply");
  // The other agent's sign-in is "Main" too: a card of its own, with its own figures and region name.
  const other = page.getByRole("region", { name: "Costs for Main · Codex", exact: true });
  await expect(other).toContainText("Plan sign-in");
  await expect(other).toContainText("$9.00");

  // Under 80%: a quiet bar, with Change limit and Remove limit.
  const ok = page.getByRole("region", { name: "Costs for Work key · Claude Code", exact: true });
  await expect(ok.getByRole("meter")).toHaveAttribute("aria-valuenow", "40");
  await expect(ok).toContainText("$100 of $250 this month · 40%");
  await expect(ok.getByRole("meter")).toHaveClass(/cost-ok/);
  await expect(ok).not.toContainText("≈");
  await expect(ok.getByRole("status")).toHaveCount(0);
  await expect(ok.getByRole("button", { name: "Change limit", exact: true })).toBeVisible();
  await expect(ok.getByRole("button", { name: "Remove limit", exact: true })).toBeVisible();

  // From 80%: orange, and it says so in the spec's words.
  const warn = page.getByRole("region", { name: "Costs for API key · Codex", exact: true });
  await expect(warn.getByRole("meter")).toHaveClass(/cost-warn/);
  await expect(warn.getByRole("status")).toHaveText("API key has used $200 of its $250 limit.");
  // Part of what is used was estimated from tokens: the limit's line says ≈, and so do the month and the total but not today.
  await expect(warn).toContainText("≈$200 of $250 this month · 80%");
  await expect(warn.getByRole("meter")).toHaveAttribute("aria-valuetext", "≈$200 of $250 this month");
  await expect(warn.locator(".cost-cell").filter({ hasText: "This month" })).toContainText("≈$200");
  await expect(warn.locator(".cost-cell").filter({ hasText: "Total" })).toContainText("≈$300");
  await expect(warn.locator(".cost-cell").filter({ hasText: "Today" })).toContainText("$2.50");
  await expect(warn.locator(".cost-cell").filter({ hasText: "Today" })).not.toContainText("≈");
  await expect(warn.getByRole("button", { name: "Change limit", exact: true })).toBeVisible();

  // At the limit: red, new replies won't start, and Raise limit takes the place of Change limit.
  const stopped = page.getByRole("region", { name: "Costs for Team key · Codex", exact: true });
  await expect(stopped.getByRole("meter")).toHaveClass(/cost-stopped/);
  await expect(stopped.getByRole("status")).toHaveText("Team key reached its $250 limit, so new replies won't start.");
  await expect(stopped.getByRole("button", { name: "Raise limit", exact: true })).toBeVisible();
  await expect(stopped.getByRole("button", { name: "Change limit" })).toHaveCount(0);

  // An AI service has no limit yet: it can get one.
  const service = page.getByRole("region", { name: "Costs for Kimi on Together · Codex", exact: true });
  await expect(service.locator(".cost-name")).toHaveText("Kimi on Together · Codex");
  await expect(service.locator(".cost-sub")).toHaveText("AI service");
  await expect(service.getByRole("button", { name: "Set a limit", exact: true })).toBeVisible();
  await expect(service).toContainText("No limit.");

  await expect(page.getByText("Crosstalk adds up what each reply reports. The exact bill is on your provider's site.")).toBeVisible();
  // Estimates are drawn here, so the screen says what ≈ means; and it says where the figures start, so this month's earlier use isn't expected in them.
  await expect(page.getByText("≈ means worked out from a reply's tokens and a price list.", { exact: true })).toBeVisible();
  await expect(page.getByText("Figures start when this version was installed, so earlier use this month isn't included.", { exact: true })).toBeVisible();
  await expect(page.getByText("Prices from models.dev, checked 3h ago.")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot(shot("01-costs-accounts.png"));
});

test("a limit is set from a dialog with the amount, a quick add, and what it counts", async ({ page }) => {
  const spend = await mockSpend(page, [apiKey({ account: "work", label: "Work key", today: totals(1, 5), month: totals(20, 30), total: totals(150, 90) })]);
  await openCosts(page);
  const card = page.getByRole("region", { name: "Costs for Work key · Claude Code", exact: true });
  await expect(card).toContainText("No limit.");
  // Nothing was estimated here: no ≈, and no line that explains it.
  await expect(card).not.toContainText("≈");
  await expect(page.getByText(/^≈ means/)).toHaveCount(0);
  await card.getByRole("button", { name: "Set a limit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Set a limit", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Work key · Claude Code. Spent so far: $20.00 this month, $150 in total.");
  const field = dialog.getByRole("textbox", { name: "Limit in dollars", exact: true });
  const save = dialog.getByRole("button", { name: "Save limit", exact: true });

  // What's wrong with it says what to type, and nothing is sent.
  await field.fill("lots");
  await save.click();
  await expect(dialog.getByRole("alert")).toHaveText("Use an amount above $0, like 50.");
  await page.screenshot(shot("02-limit-dialog-problem.png"));
  await field.fill("");
  await save.click();
  await expect(dialog.getByRole("alert")).toHaveText("Type how many dollars, like 50.");
  expect(spend.puts).toEqual([]);
  // Typing again clears it. The quick buttons add to what's there.
  await field.fill("10");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await field.fill("");
  await dialog.getByRole("button", { name: "Add $100", exact: true }).click();
  await dialog.getByRole("button", { name: "Add $100", exact: true }).click();
  await expect(field).toHaveValue("200");
  await dialog.getByRole("button", { name: "Add $50", exact: true }).click();
  await expect(field).toHaveValue("250");
  await field.fill("200");

  // The month is the default; In total says how it counts, and "?" says what a limit does.
  await expect(dialog.getByRole("radio", { name: "Each month", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(dialog).toContainText("Starts again on the 1st of each month.");
  await dialog.getByRole("radio", { name: "In total", exact: true }).click();
  await expect(dialog).toContainText("Counts everything from the day you save it, and doesn't start over.");
  await dialog.getByRole("button", { name: "What's a limit?", exact: true }).click();
  await expect(dialog.getByRole("note")).toContainText("Replies already running can go a little over it");
  await expect(dialog.getByRole("note")).toContainText("new replies won't start");
  await expect(dialog.getByRole("note")).toContainText("Figures start when this version was installed, so earlier use this month isn't included.");
  await page.screenshot(shot("03-limit-dialog-set.png"));
  await noHorizontalOverflow(page);

  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(spend.puts).toEqual([{ provider: "claude", account: "work", body: { limitUsd: 200, period: "total" } }]);
  await expect(page.locator(".toast").filter({ hasText: "Limit is now $200 in total." })).toBeVisible();
  await expect(card).toContainText("$150 of $200 since Oct 3 · 75%");
  await expect(card.getByRole("meter")).toHaveClass(/cost-ok/);
  await expect(card.getByRole("button", { name: "Change limit", exact: true })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot(shot("04-costs-limit-set.png"));
  await noHorizontalOverflow(page);
});

test("a limit is changed, removed after asking, and a save that fails says so and can be tried again", async ({ page }) => {
  const spend = await mockSpend(page, [apiKey({ label: "Work key", account: "work", budget: budget(200) })]);
  await openCosts(page);
  const card = page.getByRole("region", { name: "Costs for Work key · Claude Code", exact: true });
  await expect(card.getByRole("status")).toContainText("has used $200 of its $250 limit");
  await card.getByRole("button", { name: "Change limit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change limit", exact: true });
  const field = dialog.getByRole("textbox", { name: "Limit in dollars", exact: true });
  await expect(field).toHaveValue("250");
  // A limit by the month counted in total instead is a new count, from the day it is saved.
  await dialog.getByRole("radio", { name: "In total", exact: true }).click();
  await expect(dialog).toContainText("Counts everything from the day you save it, and doesn't start over.");
  await dialog.getByRole("radio", { name: "Each month", exact: true }).click();
  await dialog.getByRole("button", { name: "Add $50", exact: true }).click();
  await expect(field).toHaveValue("300");

  // The hub can't save it right now: the dialog stays, says why, and Save limit tries again.
  spend.state.putFails = 1;
  await dialog.getByRole("button", { name: "Save limit", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The hub is busy. Try again, or tap Cancel.");
  await expect(field).toHaveValue("300");
  await page.screenshot(shot("05-limit-dialog-save-failed.png"));
  await dialog.getByRole("button", { name: "Save limit", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(spend.puts.map((p) => p.body)).toEqual([{ limitUsd: 300, period: "month" }, { limitUsd: 300, period: "month" }]);
  // 200 of 300 is 66%: the warning goes away with the new limit.
  await expect(card).toContainText("$200 of $300 this month · 66%");
  await expect(card.getByRole("status")).toHaveCount(0);

  // Removing asks twice, right there.
  await card.getByRole("button", { name: "Remove limit", exact: true }).click();
  const ask = card.getByRole("group", { name: "Remove this limit?", exact: true });
  await expect(ask).toBeVisible();
  await expect(card).toContainText("$200 of $300");
  await page.screenshot(shot("06-costs-remove-asks.png"));
  await ask.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card).toContainText("$200 of $300");
  await card.getByRole("button", { name: "Remove limit", exact: true }).click();
  await page.waitForTimeout(450); // a quick double tap doesn't count as the second step
  await card.getByRole("button", { name: "Yes, remove", exact: true }).click();
  await expect(card.getByRole("button", { name: "Set a limit", exact: true })).toBeVisible();
  expect(spend.puts.at(-1)!.body).toEqual({ limitUsd: null });
  await expect(page.locator(".toast").filter({ hasText: "Limit removed." })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("raising a limit that counts in total says it keeps its start, and the limit's figure is ≈ only for the period it counts", async ({ page }) => {
  // This month has estimated replies, the total has none: a limit counted in total is exact, though the month isn't.
  await mockSpend(page, [apiKey({ account: "work", label: "Work key", month: totals(200, 60, 0, 6), total: totals(300, 200), budget: budget(300, 500, "total") })]);
  await openCosts(page);
  const card = page.getByRole("region", { name: "Costs for Work key · Claude Code", exact: true });
  await expect(card).toContainText("$300 of $500 since Oct 3 · 60%");
  await expect(card.getByRole("meter")).toHaveAttribute("aria-valuetext", "$300 of $500 since Oct 3");
  await card.getByRole("button", { name: "Change limit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change limit", exact: true });
  await expect(dialog).toContainText("Work key · Claude Code. Spent so far: ≈$200 this month, $300 in total.");
  await expect(dialog.getByRole("radio", { name: "In total", exact: true })).toHaveAttribute("aria-checked", "true");
  // Raising it doesn't start the count over: the hub keeps the start while the period stays.
  await expect(dialog).toContainText("Keeps counting since Oct 3, and doesn't start over.");
  await expect(dialog).not.toContainText("from the day you save it");
  await page.screenshot(shot("19-limit-dialog-keeps-start.png"));
  await noHorizontalOverflow(page);
  // Looking at the month and back is no change to the saved limit, so the sentence stays true.
  await dialog.getByRole("radio", { name: "Each month", exact: true }).click();
  await expect(dialog).toContainText("Starts again on the 1st of each month.");
  await dialog.getByRole("radio", { name: "In total", exact: true }).click();
  await expect(dialog).toContainText("Keeps counting since Oct 3, and doesn't start over.");
});

test("costs say when there are no replies yet, and when the hub is too old, with a way to try again", async ({ page }) => {
  const spend = await mockSpend(page, []);
  await openCosts(page);
  const empty = page.getByRole("status").filter({ hasText: "No replies yet" });
  await expect(empty).toContainText("What your accounts cost shows up here after their first replies.");
  await expect(page.getByRole("checkbox", { name: "Look up prices online", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot(shot("07-costs-empty.png"));

  // An API key with no replies still gets a card, so a limit can be set before the first reply.
  spend.state.accounts = [apiKey({ account: "new", label: "New key", today: totals(0, 0), month: totals(0, 0), total: totals(0, 0) })];
  await page.reload();
  const card = page.getByRole("region", { name: "Costs for New key · Claude Code", exact: true });
  await expect(card).toContainText("No replies yet");
  await expect(card.getByRole("button", { name: "Set a limit", exact: true })).toBeVisible();

  // An older hub has no /api/spend.
  spend.state.status = 404;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeVisible();
  const problem = page.getByRole("alert").filter({ hasText: "can't show costs yet" });
  await expect(problem).toContainText("This machine's hub is older and can't show costs yet. Update Crosstalk on it, then try again.");
  await expect(page.getByRole("checkbox", { name: "Look up prices online" })).toHaveCount(0);
  await problem.scrollIntoViewIfNeeded();
  await page.screenshot(shot("08-costs-older-hub.png"));
  await noHorizontalOverflow(page);
  spend.state.status = 200;
  await problem.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("region", { name: "Costs for New key · Claude Code", exact: true })).toBeVisible();
});

test("the price lookup switch is on until turned off, saves at once, and a failed save can be tried again", async ({ page }) => {
  await mockSpend(page, [apiKey()]);
  const settings = settingsOf();
  const puts: Record<string, unknown>[] = [];
  let failNext = 0;
  await page.route("**/api/settings/hub", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: settings });
    const body = r.request().postDataJSON();
    puts.push(body);
    if (failNext > 0) {
      failNext--;
      return r.fulfill({ status: 503, json: { error: "Settings are busy" } });
    }
    Object.assign(settings, body);
    return r.fulfill({ json: settings });
  });
  await openCosts(page);
  const prices = page.getByRole("region", { name: "Price lookup", exact: true });
  const toggle = prices.getByRole("checkbox", { name: "Look up prices online", exact: true });
  // The hub says nothing about it: on.
  await expect(toggle).toBeChecked();
  await prices.getByRole("button", { name: "What's price lookup?", exact: true }).click();
  await expect(prices.getByRole("note")).toContainText("It sends nothing about you or your chats.");
  // Off, the hub makes no request but still prices from the list it kept (hub/test/prices.test.ts): the help says so.
  await expect(prices.getByRole("note")).toContainText("Turned off, Crosstalk makes no request and uses the last list it kept.");
  await prices.scrollIntoViewIfNeeded();
  await page.screenshot(shot("09-costs-price-lookup.png"));

  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  expect(puts).toEqual([{ priceLookup: false }]);
  await page.reload();
  await expect(page.getByRole("region", { name: "Price lookup", exact: true }).getByRole("checkbox", { name: "Look up prices online", exact: true })).not.toBeChecked();

  // A save that fails puts the switch back, says why, and Try again repeats it.
  failNext = 1;
  const again = page.getByRole("region", { name: "Price lookup", exact: true });
  // A tap, not check(): the save fails at once and the switch is back before check() looks at its state (WebKit is quick enough to show it).
  await again.getByRole("checkbox", { name: "Look up prices online", exact: true }).click();
  await expect(again.getByRole("alert")).toContainText("Couldn't save: Settings are busy");
  await expect(again.getByRole("checkbox", { name: "Look up prices online", exact: true })).not.toBeChecked();
  await again.scrollIntoViewIfNeeded();
  await page.screenshot(shot("10-costs-price-lookup-failed.png"));
  await again.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(again.getByRole("checkbox", { name: "Look up prices online", exact: true })).toBeChecked();
  await expect(again.getByRole("alert")).toHaveCount(0);
  expect(puts.at(-1)).toEqual({ priceLookup: true });
  await noHorizontalOverflow(page);
});

// ---- In a chat ----

async function chatScenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Costs checks" } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: { roomId: string }) => m.roomId === room.id);
  const history: { room: unknown; messages: unknown[]; turns: unknown[]; activities: unknown[]; approvals: unknown[]; tasks: object; totals: null; hasMore: boolean } = { room, messages: [], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let seq = 0;
  const message = (kind: "human" | "agent", text: string, turnId: string | null = null, status = "done") => ({ id: `cost-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : "claude", memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId, status, createdAt: seq * 1000, updatedAt: seq * 1000 });
  const turn = (id: string, patch: Record<string, unknown> = {}) => ({ id, roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: id, origin: "human", status: "done", error: null, usage: null, createdAt: seq * 1000, startedAt: seq * 1000, endedAt: null, ...patch });
  let live: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    live = socket;
    socket.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  const send = (e: unknown) => live!.send(JSON.stringify(e));
  return { room, member, history, message, turn, open, send, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

test("a chat says what it has cost, with ≈ when some replies have no price, and updates as the hub reports", async ({ page, request, token }) => {
  const s = await chatScenario(page, request, token);
  await mockSpend(page, [apiKey({ account: "default", budget: budget(100) })]);
  let cost = { roomId: s.room.id, usd: 1.234, replies: 4, unpriced: 0 };
  await page.route(`**/api/rooms/${s.room.id}/spend`, (r) => r.fulfill({ json: cost }));
  s.history.messages.push(s.message("human", "Fix the login page"), s.message("agent", "Fixed it.", "t1"));
  s.history.turns.push(s.turn("t1", { replyMessageId: "cost-2", triggerMessageId: "cost-1" }));
  Object.assign(s.member, { readSeq: 2 });
  try {
    await s.open();
    await page.getByRole("button", { name: /Show context and plan limits/ }).click();
    const pop = page.getByRole("dialog", { name: "Context and plan limits", exact: true });
    await expect(pop.getByText("This chat: $1.23", { exact: true })).toBeVisible();
    await expect(pop).not.toContainText("without a price");
    // This chat's account is an API key: its cost is billed, with nothing about a plan.
    await expect(pop).not.toContainText("included in your plan");
    await expect(pop).not.toContainText("API prices");
    await page.screenshot(shot("11-chat-cost-line.png"));
    await noHorizontalOverflow(page);

    // The hub reports a reply that has no price: the figure is approximate now, and says why.
    cost = { ...cost, usd: 1.5, replies: 5, unpriced: 1 };
    s.send({ t: "spend", accounts: [apiKey({ account: "default", budget: budget(101) })] });
    await expect(pop.getByText("This chat: ≈$1.50")).toBeVisible();
    await expect(pop).toContainText("1 reply without a price");
    await page.screenshot(shot("12-chat-cost-line-approximate.png"));
    await noHorizontalOverflow(page);

    // No replies yet: no line at all.
    cost = { roomId: s.room.id, usd: 0, replies: 0, unpriced: 0 };
    s.send({ t: "spend", accounts: [apiKey({ account: "default", budget: budget(102) })] });
    await expect(pop.getByText(/This chat:/)).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test("a chat on a plan sign-in says its figure is what the use would cost, not a bill", async ({ page, request, token }) => {
  const s = await chatScenario(page, request, token);
  // This chat's agent uses the default sign-in of its plan: nothing is billed for its replies.
  await mockSpend(page, [acct({ account: "default" })]);
  await page.route(`**/api/rooms/${s.room.id}/spend`, (r) => r.fulfill({ json: { roomId: s.room.id, usd: 12.3, replies: 4, unpriced: 0, estimated: 4 } }));
  s.history.messages.push(s.message("human", "Fix the login page"), s.message("agent", "Fixed it.", "t1"));
  s.history.turns.push(s.turn("t1", { replyMessageId: "cost-2", triggerMessageId: "cost-1" }));
  Object.assign(s.member, { readSeq: 2 });
  try {
    await s.open();
    await page.getByRole("button", { name: /Show context and plan limits/ }).click();
    const pop = page.getByRole("dialog", { name: "Context and plan limits", exact: true });
    await expect(pop.locator(".chat-cost")).toHaveText("This chat: ≈$12.30 at API prices, included in your plan");
    await page.screenshot(shot("20-chat-cost-line-plan.png"));
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

test("a plan chat's figure waits for its account's figures, so it never shows as if it were a bill", async ({ page, request, token }) => {
  const s = await chatScenario(page, request, token);
  await mockSpend(page, [acct({ account: "default" })]);
  // The account figures are on their way: until they come, nothing says whether this chat's account is billed.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/spend", async (r) => {
    if (r.request().method() === "GET") await held;
    return r.fallback();
  });
  await page.route(`**/api/rooms/${s.room.id}/spend`, (r) => r.fulfill({ json: { roomId: s.room.id, usd: 12.3, replies: 4, unpriced: 0, estimated: 4 } }));
  s.history.messages.push(s.message("human", "Fix the login page"), s.message("agent", "Fixed it.", "t1"));
  s.history.turns.push(s.turn("t1", { replyMessageId: "cost-2", triggerMessageId: "cost-1" }));
  Object.assign(s.member, { readSeq: 2 });
  try {
    await s.open();
    const answered = page.waitForResponse((res) => res.url().endsWith(`/api/rooms/${s.room.id}/spend`));
    await page.getByRole("button", { name: /Show context and plan limits/ }).click();
    const pop = page.getByRole("dialog", { name: "Context and plan limits", exact: true });
    await expect(pop).toBeVisible();
    // The chat's own figure is here, and the line still isn't drawn: it would say "$12.30" with no word about the plan.
    await answered;
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(pop.locator(".chat-cost")).toHaveCount(0);
    release();
    await expect(pop.locator(".chat-cost")).toHaveText("This chat: ≈$12.30 at API prices, included in your plan");
    await noHorizontalOverflow(page);
  } finally {
    release();
    await s.cleanup();
  }
});

test("passing 80% gives one notice, and Raise limit takes you to Settings → Costs", async ({ page, request, token }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 844 });
  const s = await chatScenario(page, request, token);
  await mockSpend(page, [apiKey({ account: "default", budget: budget(150) })]);
  s.history.messages.push(s.message("human", "Hi"), s.message("agent", "Hello", "t1"));
  s.history.turns.push(s.turn("t1", { replyMessageId: "cost-2", triggerMessageId: "cost-1" }));
  Object.assign(s.member, { readSeq: 2 });
  const figures = (used: number) => ({ t: "spend", accounts: [apiKey({ account: "default", budget: budget(used) })] });
  try {
    await s.open();
    // The first figures, and figures that haven't crossed anything, are no news. 80% of $250 is $200.
    s.send(figures(150));
    s.send(figures(160));
    s.send(figures(200));
    const toasts = page.locator(".toast");
    await expect(toasts).toHaveCount(1);
    await expect(toasts.first()).toContainText("API key has used $200 of its $250 limit.");
    await expect(toasts.first().getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await page.screenshot(shot("13-notice-80.png"));
    await noHorizontalOverflow(page);
    await toasts.first().getByRole("button", { name: "Raise limit", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeInViewport();
    await expect(page.getByRole("region", { name: "Costs for API key · Claude Code", exact: true })).toBeVisible();
    await page.screenshot(shot("14-notice-opens-costs.png"));
  } finally {
    await s.cleanup();
  }
});

test("reaching the limit gives its own notice, and more use over it gives none", async ({ page, request, token }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 844 });
  const s = await chatScenario(page, request, token);
  await mockSpend(page, [apiKey({ account: "default", budget: budget(150) }), apiKey({ provider: "codex", account: "other", label: "Home key", budget: budget(10, 100) })]);
  s.history.messages.push(s.message("human", "Hi"), s.message("agent", "Hello", "t1"));
  s.history.turns.push(s.turn("t1", { replyMessageId: "cost-2", triggerMessageId: "cost-1" }));
  Object.assign(s.member, { readSeq: 2 });
  const figures = (used: number, home: number) => ({ t: "spend", accounts: [apiKey({ account: "default", budget: budget(used) }), apiKey({ provider: "codex", account: "other", label: "Home key", budget: budget(home, 100) })] });
  try {
    await s.open();
    s.send(figures(150, 10));
    // A big reply goes from under 80% to over the limit: it says the limit is reached.
    s.send(figures(251, 10));
    const toasts = page.locator(".toast");
    await expect(toasts).toHaveCount(1);
    await expect(toasts.first()).toContainText("API key reached its $250 limit, so new replies won't start.");
    await expect(toasts.first().getByRole("button", { name: "Raise limit", exact: true })).toBeVisible();
    // More use over it says nothing; another account passing 80% is the second notice, not a third.
    s.send(figures(260, 10));
    s.send(figures(260, 85));
    await expect(toasts).toHaveCount(2);
    await expect(toasts.nth(1)).toContainText("Home key has used $85.00 of its $100 limit.");
    await page.screenshot(shot("15-notice-limit.png"));
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

const REFUSAL = "API key reached its $250 limit, so this reply didn't start.";

async function refusedChat(page: Page, request: APIRequestContext, token: string, text = REFUSAL) {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 844 });
  const s = await chatScenario(page, request, token);
  const asked = s.message("human", "Fix the login page");
  const refused = s.message("agent", text, "fail-1", "error");
  s.history.messages.push(asked, refused);
  s.history.turns.push(s.turn("fail-1", { status: "error", error: text, triggerMessageId: asked.id, replyMessageId: refused.id }));
  Object.assign(s.member, { status: "error", statusDetail: text, readSeq: 2 });
  await page.route(`**/api/rooms/${s.room.id}/retry`, (r) => r.fulfill({ json: { turn: s.turn("again", { status: "queued" }) } }));
  return s;
}

test("a reply refused for a used-up limit offers Raise limit beside Try again, right there", async ({ page, request, token }) => {
  const s = await refusedChat(page, request, token);
  const spend = await mockSpend(page, [apiKey({ account: "default", budget: budget(251) })]);
  try {
    await s.open();
    const reply = page.locator(".agent-reply").last();
    await expect(reply).toContainText(REFUSAL);
    await expect(reply.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    const raise = reply.getByRole("button", { name: "Raise limit", exact: true });
    await expect(raise).toBeVisible();
    await page.screenshot(shot("16-chat-refused-raise-limit.png"));
    await noHorizontalOverflow(page);

    await raise.click();
    const dialog = page.getByRole("dialog", { name: "Raise limit", exact: true });
    const field = dialog.getByRole("textbox", { name: "Limit in dollars", exact: true });
    await expect(field).toHaveValue("250");
    await dialog.getByRole("button", { name: "Add $50", exact: true }).click();
    await expect(field).toHaveValue("300");
    await page.screenshot(shot("17-chat-raise-limit-dialog.png"));
    await noHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Save limit", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(spend.puts).toEqual([{ provider: "claude", account: "default", body: { limitUsd: 300, period: "month" } }]);
    await expect(page.locator(".toast").filter({ hasText: "Limit is now $300 a month." })).toBeVisible();
    // The limit is no longer the problem: Raise limit goes, Try again stays.
    await expect(reply.getByRole("button", { name: "Raise limit" })).toHaveCount(0);
    await expect(reply.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await page.screenshot(shot("18-chat-limit-raised.png"));
  } finally {
    await s.cleanup();
  }
});

test("Raise limit opens Settings → Costs when the chat's account isn't in the figures", async ({ page, request, token }) => {
  const s = await refusedChat(page, request, token);
  // The hub's figures are for another account: only the refusal's own words say it's the limit.
  await mockSpend(page, [apiKey({ provider: "codex", account: "other", budget: budget(10) })]);
  try {
    await s.open();
    await page.locator(".agent-reply").last().getByRole("button", { name: "Raise limit", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeInViewport();
  } finally {
    await s.cleanup();
  }
});

test("a reply that failed for another reason has no Raise limit", async ({ page, request, token }) => {
  const s = await refusedChat(page, request, token, "⚠️ API Error: overloaded");
  await mockSpend(page, [apiKey({ account: "default", budget: budget(10) })]);
  try {
    await s.open();
    const reply = page.locator(".agent-reply").last();
    await expect(reply.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(reply.getByRole("button", { name: "Raise limit" })).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test("a refused reply has no Raise limit once the account has no limit at all", async ({ page, request, token }) => {
  const s = await refusedChat(page, request, token);
  await mockSpend(page, [apiKey({ account: "default", budget: null })]);
  try {
    await s.open();
    const reply = page.locator(".agent-reply").last();
    await expect(reply).toContainText(REFUSAL);
    await expect(reply.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    // Until the figures arrive the refusal's own words offer it; then the figures say the limit is gone.
    await expect(reply.getByRole("button", { name: "Raise limit" })).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});
