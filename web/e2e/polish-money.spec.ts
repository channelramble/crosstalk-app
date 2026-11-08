// Money (costs, limits and usage), the states the existing specs don't reach: a group chat, where every money word on
// screen is picked from whichever agent happens to be first in the store rather than the one the screen is about, and
// the Usage page's own limits, where a window whose reset has gone by and one whose share nothing says are both drawn
// as if they were known.
//
// web/e2e/costs.spec.ts covers one-agent chats; this file is only the gaps. Each test says whether it is EXPECTED TO
// FAIL on today's code and why. The hub's money answers are mocked, so the shared test hub's own state stays as it was
// (the rooms and the account these make are removed in `finally`, and the cleanHub fixture checks it).
import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import type { AccountSpend, BudgetState, Member, SpendTotals } from "@crosstalk/shared";

const hub = "http://127.0.0.1:8451";

const totals = (usd: number, replies: number, unpriced = 0, estimated?: number): SpendTotals => ({
  usd,
  replies,
  unpriced,
  inputTokens: replies * 1200,
  outputTokens: replies * 300,
  ...(estimated === undefined ? {} : { estimated }),
});

const budget = (usedUsd: number, limitUsd = 250, period: "month" | "total" = "month"): BudgetState => ({
  limitUsd,
  period,
  since: Date.UTC(2026, 9, 3, 12),
  usedUsd,
  percent: Math.floor((usedUsd / limitUsd) * 100),
  state: usedUsd >= limitUsd ? "stopped" : usedUsd >= limitUsd * 0.8 ? "warn" : "ok",
});

/** What the hub says each account has cost (the test hub's ledger is empty). */
async function mockSpend(page: Page, accounts: AccountSpend[]) {
  await page.route("**/api/spend", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { accounts, updatedAt: Date.now(), prices: null } }) : r.fallback()));
}

/**
 * A group chat of two agents on two different accounts — @claude on the plan sign-in (nothing billed for its replies)
 * and @keys on an API key — with the history mocked, so nothing is ever sent to an agent. @claude is added first, so it
 * is the lead and the first member of this room in the app's store.
 */
async function moneyGroup(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  // POST /api/rooms makes a group chat (app.ts: "Every room is a chat now"); its agents join it one at a time.
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Money group", mode: "direct" } })).json();
  const key = await (await request.post(`${hub}/api/accounts`, { headers, data: { provider: "codex", label: "Money key" } })).json();
  const planner: Member = await (await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "claude", handle: "claude" } })).json();
  const keys: Member = await (await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "codex", handle: "keys", config: { account: key.id } } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  // Both agents have read everything: a group chat only offers Try again when every agent says what it has read.
  for (const m of snapshot.members as Member[]) if (m.roomId === room.id) Object.assign(m, { readSeq: 2, status: "idle" });
  const history: Record<string, unknown> = { room, messages: [], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let seq = 0;
  const message = (kind: "human" | "agent", text: string, memberId: string | null = null, turnId: string | null = null, status = "done") => ({
    id: `money-${++seq}`,
    seq,
    roomId: room.id,
    authorKind: kind,
    authorName: kind === "human" ? "Phone" : "agent",
    memberId,
    text,
    mentions: [],
    turnId,
    status,
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
  });
  const turn = (id: string, memberId: string, patch: Record<string, unknown> = {}) => ({
    id,
    roomId: room.id,
    memberId,
    triggerMessageId: null,
    replyMessageId: null,
    hop: 0,
    chainId: id,
    origin: "human",
    status: "done",
    error: null,
    usage: null,
    createdAt: seq * 1000,
    startedAt: seq * 1000,
    endedAt: null,
    ...patch,
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return {
    room,
    planner,
    keys,
    account: key,
    history,
    message,
    turn,
    open,
    cleanup: async () => {
      await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
      await request.delete(`${hub}/api/accounts/codex/${key.id}`, { headers });
    },
  };
}

/**
 * EXPECTED TO FAIL on today's code: ChatCost.tsx's ChatCostLine takes
 * `Object.values(s.members).find((m) => m.roomId === roomId)` — the room's first member — and not the agent whose
 * popup it is drawn in, so in a group chat the chat's money is described by another agent's billing. Here the popup is
 * switched to @keys (an API key: its replies are real money), and the line still says the plan covers them.
 */
test("a group chat's cost line follows the agent whose popup it is in, not whichever agent is first", async ({ page, request, token }) => {
  const s = await moneyGroup(page, request, token);
  await mockSpend(page, [
    { provider: "claude", account: "default", label: "Main", kind: "signin", today: totals(0.4, 1), month: totals(12.3, 20, 0, 20), total: totals(48, 60, 0, 60), budget: null },
    { provider: "codex", account: s.account.id, label: "Money key", kind: "apikey", today: totals(2.5, 3), month: totals(200, 40, 0, 0), total: totals(300, 90), budget: budget(200) },
  ]);
  await page.route(`**/api/rooms/${s.room.id}/spend`, (r) => r.fulfill({ json: { roomId: s.room.id, usd: 12.3, replies: 4, unpriced: 0, estimated: 4 } }));
  s.history.messages = [s.message("human", "Plan the release"), s.message("agent", "Planned.", s.keys.id, "t1")];
  s.history.turns = [s.turn("t1", s.keys.id, { replyMessageId: "money-2", triggerMessageId: "money-1" })];
  try {
    await s.open();
    // The controls are for one agent at a time: pick the one on the API key.
    await page.getByRole("button", { name: /^Settings for @claude\./ }).click();
    // A menu item is named by its title and the help under it ("@keys" then the agent and model).
    await page.getByRole("menuitemradio", { name: /^@keys\b/ }).click();
    await expect(page.getByRole("button", { name: /^Settings for @keys\./ })).toBeVisible();
    await page.getByRole("button", { name: /Show context and plan limits/ }).click();
    const pop = page.getByRole("dialog", { name: "Context and plan limits", exact: true });
    const line = pop.locator(".chat-cost");
    await expect(line).toBeVisible();
    // @keys is billed per reply: nothing here may say a plan covers this chat.
    await expect(line).not.toContainText("included in your plan");
    await expect(line).not.toContainText("API prices");
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

/**
 * The figures the way a hub of 0.6.2 or later sends them, split by account (`byAccount`; the test above has an older hub's).
 * Each agent's popup says that agent's own part, and the rest of the chat's money is said under it in every popup: here
 * $3.10 for a question put with Ask others to a model on an OpenRouter key that no agent in the chat uses, which the hub
 * books to this chat on that key (hub/src/asks.ts `finish`). Without that line it was in no popup at all.
 */
test("a group chat's popups say each agent's part, and the asks and earlier accounts that are no agent's part", async ({ page, request, token }) => {
  const s = await moneyGroup(page, request, token);
  await mockSpend(page, [
    { provider: "claude", account: "default", label: "Main", kind: "signin", today: totals(0.4, 1), month: totals(12.3, 20, 0, 20), total: totals(48, 60, 0, 60), budget: null },
    { provider: "codex", account: s.account.id, label: "Money key", kind: "apikey", today: totals(2.5, 3), month: totals(200, 40, 0, 0), total: totals(300, 90), budget: budget(200) },
    { provider: "codex", account: "openrouter", label: "OpenRouter", kind: "endpoint", today: totals(3.1, 1), month: totals(3.1, 1), total: totals(3.1, 1), budget: null },
  ]);
  const part = (provider: "claude" | "codex", account: string, usd: number, replies: number, estimated = 0) => ({ provider, account, usd, replies, unpriced: 0, estimated });
  const byAccount = [part("claude", "default", 4.1, 4, 4), part("codex", s.account.id, 8.2, 2), part("codex", "openrouter", 3.1, 1)];
  await page.route(`**/api/rooms/${s.room.id}/spend`, (r) => r.fulfill({ json: { roomId: s.room.id, usd: 15.4, replies: 7, unpriced: 0, estimated: 4, byAccount } }));
  s.history.messages = [s.message("human", "Plan the release"), s.message("agent", "Planned.", s.keys.id, "t1")];
  s.history.turns = [s.turn("t1", s.keys.id, { replyMessageId: "money-2", triggerMessageId: "money-1" })];
  const context = page.getByRole("button", { name: /Show context and plan limits/ });
  const pop = page.getByRole("dialog", { name: "Context and plan limits", exact: true });
  const rest = "Asks and earlier accounts in this chat: $3.10";
  try {
    await s.open();
    await context.click();
    await expect(pop.locator(".chat-cost")).toHaveText("@claude in this chat: ≈$4.10 at API prices, included in your plan");
    await expect(pop.locator(".chat-cost-rest")).toHaveText(rest);
    await noHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await page.getByRole("button", { name: /^Settings for @claude\./ }).click();
    await page.getByRole("menuitemradio", { name: /^@keys\b/ }).click();
    await expect(page.getByRole("button", { name: /^Settings for @keys\./ })).toBeVisible();
    await context.click();
    await expect(pop.locator(".chat-cost")).toHaveText("@keys in this chat: $8.20");
    // The same $3.10, billed, and in no way said to be covered by @claude's plan.
    await expect(pop.locator(".chat-cost-rest")).toHaveText(rest);
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

/**
 * EXPECTED TO FAIL on today's code: ChatCost.tsx's RaiseLimit looks up the room's first member too (ChatScreen passes
 * `memberId` to TryAgain but not to RaiseLimit), so `stopped` is worked out from @claude's figures — a plan sign-in
 * with no limit — and the button that is the only way out of the refusal never appears. Try again is then the only
 * thing offered, and it runs straight into the same used-up limit.
 */
test("in a group chat, a reply refused by one agent's limit still offers Raise limit", async ({ page, request, token }) => {
  const s = await moneyGroup(page, request, token);
  const refusal = "Money key reached its $250 limit, so this reply didn't start.";
  await mockSpend(page, [
    { provider: "claude", account: "default", label: "Main", kind: "signin", today: totals(0.4, 1), month: totals(12.3, 20), total: totals(48, 60), budget: null },
    { provider: "codex", account: s.account.id, label: "Money key", kind: "apikey", today: totals(2.5, 3), month: totals(251, 40), total: totals(351, 90), budget: budget(251) },
  ]);
  await page.route(`**/api/rooms/${s.room.id}/spend`, (r) => r.fulfill({ json: { roomId: s.room.id, usd: 1.2, replies: 2, unpriced: 0 } }));
  const asked = s.message("human", "@keys ship it");
  const refused = s.message("agent", refusal, s.keys.id, "fail-1", "error");
  s.history.messages = [asked, refused];
  s.history.turns = [s.turn("fail-1", s.keys.id, { status: "error", error: refusal, triggerMessageId: asked.id, replyMessageId: refused.id })];
  try {
    await s.open();
    const reply = page.locator(".agent-reply").last();
    await expect(reply).toContainText(refusal);
    await expect(reply.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    const raise = reply.getByRole("button", { name: "Raise limit", exact: true });
    await expect(raise).toBeVisible();
    await raise.click();
    // And it raises the limit of the account that refused the reply, not the first agent's.
    const dialog = page.getByRole("dialog", { name: "Raise limit", exact: true });
    await expect(dialog).toContainText("Money key");
    await expect(dialog.getByRole("textbox", { name: "Limit in dollars", exact: true })).toHaveValue("250");
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

/** The Usage page with windows the hub hasn't been able to refresh yet (it looks again every 15 minutes). */
async function mockUsage(page: Page, windows: { label: string; usedPercent: number | null; resetsAt: number | null }[]) {
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    snap.usage = [{ provider: "codex", accountId: "default", account: "me@example.com", plan: "Test plan", windows, updatedAt: Date.now() - 9 * 60_000 }];
    await route.fulfill({ json: snap });
  });
  await page.goto("/#/usage");
  await expect(page.locator(".topbar h1")).toHaveText("Usage");
  const card = page.locator(".card").filter({ hasText: "Codex · Main" });
  await expect(card).toBeVisible();
  return card;
}

/**
 * EXPECTED TO FAIL on today's code: UsagePage.tsx draws `Resets in {timeUntil(w.resetsAt)}`, and ui.tsx's timeUntil
 * answers "now" for a time that has gone — so a window whose reset passed before the hub's next 15-minute look reads
 * "Resets in now", beside a share that is no longer true. Plain words for a reset that has already happened, please
 * (the chat's own waiting row says "Back soon" for exactly this).
 */
test("a usage window whose reset has gone by doesn't say it resets in now", async ({ page }) => {
  const card = await mockUsage(page, [{ label: "5-hour", usedPercent: 100, resetsAt: Date.now() - 4 * 60_000 }]);
  await expect(card).not.toContainText("Resets in now");
  await noHorizontalOverflow(page);
});

/**
 * EXPECTED TO FAIL on today's code: UsagePage.tsx draws every window's meter with `aria-valuenow={w.usedPercent ?? 0}`
 * and no aria-valuetext, so a window whose share nothing says shows "—" to the eye and is read out as 0 — "none of it
 * used" — to a screen reader. A reader must be told it isn't known.
 */
test("a usage window with no percentage isn't read out as 0% used", async ({ page }) => {
  const card = await mockUsage(page, [{ label: "Weekly", usedPercent: null, resetsAt: null }]);
  await expect(card).toContainText("—");
  const meter = card.getByRole("meter", { name: "Weekly limit", exact: true });
  const told = await meter.evaluate((el) => el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow") ?? "");
  expect(told, "what a screen reader is told about a share nobody knows").not.toBe("0");
  await noHorizontalOverflow(page);
});
