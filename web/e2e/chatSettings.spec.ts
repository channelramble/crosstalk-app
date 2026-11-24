// A chat's settings: one sheet with a row per section (Answers with, May do, Helpers, Memory, This chat), opened from
// the top bar or from the summary row under the message box, which says what's in force in words. Each choice is saved
// as it's made and says when it applies. A group chat's sheet has how its agents work together, then a block per agent.
//
// The one-agent chat's hub answers are given by the page itself (as polish-agents.spec.ts does), so no agent runs and
// what the sheet sends can be read; the group chat is the test hub's own.
import { test, expect, chatSettings, closeChatSettings, effortInForce, modelInForce, noHorizontalOverflow, openFold, permissionCards, pickEffort, pickModel, pickPermission } from "./fixtures";
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";

const hub = "http://127.0.0.1:8451";

const OPUS = { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", description: "Most capable, for complex work", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: null, contextWindow: 1_000_000, fast: { label: "Fast", description: "About twice as fast. Uses your plan faster." } };
const SONNET = { id: "sonnet", resolvedModel: "claude-sonnet-5", label: "Sonnet 5", description: "Best for everyday tasks", isDefault: false, efforts: ["low", "high"], defaultEffort: null, contextWindow: 200_000 };
const OLDER = { id: "opus-4", resolvedModel: "claude-opus-4-1", label: "Opus 4.1", description: "An older model", isDefault: false, more: true, efforts: [], defaultEffort: null, contextWindow: 200_000 };
const CLAUDE_MODELS = { provider: "claude", accountId: "default", live: true, error: null, models: [OPUS, SONNET, OLDER] };
const WORK = { provider: "claude", id: "work", label: "Work", kind: "signin", workspaceId: null, endpoint: null, signedIn: true, account: "work@example.com", plan: "Max", authMethod: null, error: null, checkedAt: 1 };

type Patch = Record<string, unknown> & { config?: Record<string, unknown> };

/** A one-agent chat whose answers the page gives itself: a change comes back the way the machine sends it. */
async function chat(page: Page, request: APIRequestContext, token: string, opts: { member?: Record<string, unknown>; accounts?: unknown[]; defaults?: Record<string, unknown> } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Importer fix" } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: { roomId: string }) => m.roomId === room.id);
  Object.assign(member, opts.member ?? {});
  if (opts.accounts) snapshot.accounts.push(...opts.accounts);
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  // The sheet asks for the machine's accounts as they are now: the same ones.
  await page.route("**/api/accounts", (r) => (r.request().method() === "GET" ? r.fulfill({ json: snapshot.accounts }) : r.continue()));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: { room, messages: [], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } }));
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: CLAUDE_MODELS }));
  const patches: Patch[] = [];
  await page.route(`**/api/members/${member.id}`, async (r) => {
    if (r.request().method() !== "PATCH") return r.continue();
    const body = r.request().postDataJSON();
    patches.push(body);
    Object.assign(member, body);
    socket?.send(JSON.stringify({ t: "member", member }));
    return r.fulfill({ json: member });
  });
  const defaults = { mode: "direct", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: { claude: { permissionMode: "ask", model: null, effort: null, ...(opts.defaults ?? {}) } } };
  const saved: Record<string, unknown>[] = [];
  await page.route("**/api/settings/defaults**", async (r) => {
    if (r.request().method() === "PATCH") {
      saved.push(r.request().postDataJSON());
      Object.assign(defaults.agent.claude, r.request().postDataJSON());
    }
    return r.fulfill({ json: defaults });
  });
  await page.goto(`/#/room/${room.id}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  const send = (m: Record<string, unknown>) => {
    Object.assign(member, m);
    socket?.send(JSON.stringify({ t: "member", member }));
  };
  return { room, member, patches, saved, send };
}

const row = (page: Page) => page.getByRole("group", { name: "This chat's settings", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Chat settings", exact: true });

test("the row says what's in force, and switching the model is two taps from the chat", async ({ page, request, token }) => {
  const c = await chat(page, request, token);
  await expect(row(page).getByRole("button", { name: "Permissions: Asks first", exact: true })).toBeVisible();
  const model = row(page).getByRole("button", { name: "Model: Opus 5.5", exact: true });
  await expect(model).toHaveText("Opus 5.5");

  // Tap one: the chip. The sheet opens with Answers with open, and only it.
  await model.click();
  const answers = sheet(page).getByRole("region", { name: "Answers with", exact: true });
  await expect(answers.locator("> .cs-fold-head")).toHaveAttribute("aria-expanded", "true");
  await expect(sheet(page).locator('.cs-fold-head[aria-expanded="true"]')).toHaveCount(1);
  await expect(modelInForce(answers)).toContainText("Opus 5.5");
  // It says when a change applies, before one is made.
  await expect(answers).toContainText("A change applies from Claude Code's next reply.");
  // Tap two: the model. It's saved at once, as the model behind the agent's own name for it.
  await pickModel(answers, "Sonnet 5");
  await expect.poll(() => c.patches.at(-1)?.model).toBe("claude-sonnet-5");
  await expect(modelInForce(answers)).toContainText("Sonnet 5");
  // The sheet stays, for the effort that goes with it; the row behind it already says the new model.
  await pickEffort(answers, "high");
  await expect.poll(() => c.patches.at(-1)?.config?.effort).toBe("high");
  await closeChatSettings(page);
  await expect(row(page).locator(".ctl-model")).toHaveText("Sonnet 5 · High");

  // The other chip and the ring open their own sections.
  await row(page).getByRole("button", { name: /^Permissions:/ }).click();
  await expect(sheet(page).locator('.cs-fold-head[aria-expanded="true"]')).toHaveText(/May do/);
  await closeChatSettings(page);
  await row(page).getByRole("button", { name: /^Memory/ }).click();
  await expect(sheet(page).locator('.cs-fold-head[aria-expanded="true"]')).toHaveText(/Memory/);
});

test("from the top bar the sheet is an overview: a row per section that says what's in force", async ({ page, request, token }) => {
  const c = await chat(page, request, token, { member: { permissionMode: "edits", model: "claude-sonnet-5", config: { effort: "low" } } });
  const s = await chatSettings(page);
  await expect(s.locator(".cs-fold-title")).toHaveText(["Answers with", "May do", "Helpers", "Memory", "This chat"]);
  await expect(s.locator('.cs-fold-head[aria-expanded="true"]')).toHaveCount(0);
  await expect(s.getByRole("region", { name: "Answers with", exact: true }).locator(".cs-fold-sum")).toHaveText("Sonnet 5 · Low");
  await expect(s.getByRole("region", { name: "May do", exact: true }).locator(".cs-fold-sum")).toHaveText("Can edit");
  await expect(s.getByRole("region", { name: "Helpers", exact: true }).locator(".cs-fold-sum")).toHaveText("Claude Code's own, on the same model");
  await expect(s.getByRole("region", { name: "This chat", exact: true }).locator(".cs-fold-sum")).toHaveText("Importer fix");

  // Answers with: the usual models as cards with a line each, the rest behind More models; effort as steps; the model's extras.
  const answers = await chatSettings(page, "Answers with");
  await expect(answers.getByRole("menuitemradio")).toHaveCount(2);
  await expect(answers.getByRole("menuitemradio").first()).toContainText("Most capable, for complex work");
  await expect(answers.getByRole("button", { name: "More models (1)", exact: true })).toBeVisible();
  await expect(effortInForce(answers)).toHaveAttribute("data-value", "low");
  // Fast mode only where the model has it: Sonnet doesn't, Opus does.
  await expect(answers.getByText("Fast mode", { exact: true })).toHaveCount(0);
  await pickModel(answers, "Opus 5.5");
  await expect(answers.getByText("Fast mode", { exact: true })).toBeVisible();
  await answers.getByRole("checkbox", { name: "Fast mode", exact: true }).click({ force: true });
  await expect.poll(() => c.patches.at(-1)?.config?.fast).toBe(true);

  // May do: a card per level with the sentence that says what it allows.
  const may = await chatSettings(page, "May do");
  await expect(permissionCards(may).getByRole("radio")).toHaveCount(4);
  await expect(permissionCards(may).getByRole("radio", { name: "Can edit", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(may).toContainText("Edits files on its own. Asks you before running commands.");
  await pickPermission(may, "ask");
  await expect.poll(() => c.patches.at(-1)?.permissionMode).toBe("ask");
  // Full access is asked about first, in the app's own sheet; Cancel leaves the chat as it was.
  const before = c.patches.length;
  await pickPermission(may, "full");
  const ask = page.getByRole("dialog", { name: "Give Claude Code full access?", exact: true });
  await ask.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(ask).toHaveCount(0);
  expect(c.patches.length).toBe(before);
  await pickPermission(may, "full");
  await ask.getByRole("button", { name: "Give full access", exact: true }).click();
  await expect.poll(() => c.patches.at(-1)?.permissionMode).toBe("full");

  // Helpers: who does helper work.
  const helpers = await chatSettings(page, "Helpers");
  await expect(helpers.getByRole("combobox", { name: "Helpers run on", exact: true })).toBeVisible();

  // Memory: in plain words, with summarizing and starting fresh.
  const memory = await chatSettings(page, "Memory");
  await expect(memory.getByRole("button", { name: "Summarize now", exact: true })).toBeEnabled();
  await memory.getByRole("combobox", { name: "Summarize by itself at", exact: true }).selectOption("100000");
  await expect.poll(() => c.patches.at(-1)?.config?.autoCompact).toBe(100_000);
  await expect(memory).not.toContainText(/compact|context window/i);
  await memory.getByRole("button", { name: "Start fresh", exact: true }).click();
  const fresh = page.getByRole("dialog", { name: "Start Claude Code fresh?", exact: true });
  await expect(fresh).toContainText("forgets what was said so far and starts over. The messages here stay.");
  await fresh.getByRole("button", { name: "Cancel", exact: true }).click();

  // This chat: its name, pin, folder, and its own actions; deleting asks twice.
  const own = await chatSettings(page, "This chat");
  await expect(own.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Importer fix");
  await expect(own.getByRole("button", { name: "Save name", exact: true })).toHaveCount(0);
  await own.getByRole("textbox", { name: "Name", exact: true }).fill("Importer, fixed");
  const renamed = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith(`/api/rooms/${c.room.id}`));
  await own.getByRole("button", { name: "Save name", exact: true }).click();
  expect((await renamed).postDataJSON()).toEqual({ name: "Importer, fixed" });
  for (const name of ["Duplicate chat…", "Export as Markdown", "Delete chat"]) await expect(own.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(own.getByRole("checkbox", { name: "Pinned", exact: true })).not.toBeChecked();
  await own.getByRole("button", { name: "Delete chat", exact: true }).click();
  const del = page.getByRole("dialog", { name: "Delete this chat?", exact: true });
  await del.getByRole("button", { name: "Continue", exact: true }).click();
  const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
  await expect(sure.getByRole("button", { name: "Yes, delete", exact: true })).toBeVisible();
  await sure.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet(page)).toBeVisible();
});

test("it says what will happen: at the next reply, after this one, once helpers finish, or a fresh start", async ({ page, request, token }) => {
  const c = await chat(page, request, token, { accounts: [WORK] });
  const answers = await chatSettings(page, "Answers with");
  await expect(answers).toContainText("A change applies from Claude Code's next reply. The chat carries on as it is.");
  // An account switch starts the agent fresh: said beside the accounts, then asked once.
  await expect(answers).toContainText("Switching accounts starts Claude Code fresh: it forgets what was said so far. The messages stay.");
  await answers.getByRole("radiogroup", { name: "Account", exact: true }).getByRole("radio", { name: "Work", exact: true }).click();
  const ask = page.getByRole("dialog", { name: "Switch to Work?", exact: true });
  await expect(ask).toContainText("Claude Code starts fresh on Work");
  expect(c.patches.length).toBe(0);
  await ask.getByRole("button", { name: "Switch account", exact: true }).click();
  await expect.poll(() => c.patches.at(-1)).toMatchObject({ model: null, config: { account: "work" } });

  // While it replies, a change waits for the reply to end.
  c.send({ status: "working" });
  await expect(answers).toContainText("Claude Code is replying now. A change here applies once this reply ends.");
  const memory = await chatSettings(page, "Memory");
  await expect(memory.getByRole("button", { name: "Summarize now", exact: true })).toBeDisabled();
  await expect(memory).toContainText("Available once Claude Code finishes this reply.");
  // A change that's waiting on its helpers says so at the top of the sheet.
  c.send({ held: { change: "settings", helpers: true } });
  await expect(sheet(page).getByRole("status").filter({ hasText: "Your new settings apply once Claude Code finishes its helpers." })).toBeVisible();
  c.send({ status: "idle", held: null });
  await expect(sheet(page).getByText("Your new settings apply once")).toHaveCount(0);
});

test("Use these for new chats too saves the chat's choices as what new chats start with", async ({ page, request, token }) => {
  const c = await chat(page, request, token, { member: { permissionMode: "edits", model: "claude-sonnet-5", config: { effort: "high" } } });
  const may = await chatSettings(page, "May do");
  await expect(may).toContainText("New Claude Code chats would start with Sonnet 5 · High · Can edit.");
  await may.getByRole("button", { name: "Use these for new chats too", exact: true }).click();
  await expect.poll(() => c.saved.at(-1)).toEqual({ permissionMode: "edits", model: "claude-sonnet-5", effort: "high", helperModel: null });
  // Nothing more to offer once they're the same, here and in Answers with.
  await expect(may.getByText("New Claude Code chats start like this too.")).toBeVisible();
  await expect(may.getByRole("button", { name: "Use these for new chats too", exact: true })).toHaveCount(0);
  // A change to the chat offers it again.
  await pickPermission(may, "ask");
  await expect(may.getByRole("button", { name: "Use these for new chats too", exact: true })).toBeVisible();
});

test("a group chat's sheet: how they work together, then a block per agent with the same sections", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats/group`, { headers, data: { name: "Build and check", members: [{ provider: "claude" }, { provider: "codex", handle: "checker" }], answers: "lead" } })).json();
  await page.goto(`/#/room/${room.id}`);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
  // The row is the lead's, and says how many more agents there are.
  await expect(row(page).getByRole("button", { name: /^@claude's Permissions: / })).toBeVisible();
  await row(page).getByRole("button", { name: "1 more agent. Open this chat's settings", exact: true }).click();
  const s = sheet(page);
  await expect(s.locator(".cs-sheet > .cs-fold > .cs-fold-head .cs-fold-title")).toHaveText(["Working together", /^@claude/, "@checker", "This chat"]);
  await expect(s.getByRole("button", { name: "Add an agent", exact: true })).toBeVisible();

  // How they work together is the same choice New group chat has, saved as it's made.
  const together = await openFold(s, "Working together");
  const changed = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith(`/api/rooms/${room.id}`));
  await together.getByRole("radio", { name: /^Everyone answers in turn/ }).click();
  expect((await changed).postDataJSON()).toEqual({ mode: "roundrobin" });
  await expect(together.getByRole("radio", { name: /^Everyone answers in turn/ })).toHaveAttribute("aria-checked", "true");

  // An agent's block has the sections a one-agent chat has, and its name and role.
  const checker = await openFold(s, "@checker");
  await expect(checker.locator(".cs-fold-title")).toHaveText(["@checker", "Answers with", "May do", "Helpers", "Memory", "Name and role"]);
  const may = await openFold(checker, "May do");
  await pickPermission(may, "edits");
  await expect(permissionCards(may).locator('[aria-checked="true"]')).toHaveAttribute("data-value", "edits");
  await expect(checker.locator("> .cs-fold-head .cs-fold-sum")).toContainText("Can edit");
  const name = await openFold(checker, "Name and role");
  await expect(name.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("checker");
  await expect(name.getByRole("button", { name: "Make lead", exact: true })).toBeEnabled();
  await expect(name.getByRole("button", { name: "Remove from chat", exact: true })).toBeVisible();
  // The chip opens the sheet on the lead's own block and section.
  await closeChatSettings(page);
  await row(page).getByRole("button", { name: /^@claude's Model: / }).click();
  await expect(s.getByRole("region", { name: "@claude", exact: true }).getByRole("region", { name: "Answers with", exact: true }).locator("> .cs-fold-head")).toHaveAttribute("aria-expanded", "true");
});

test("on the smallest phone the row is one line and the sheet fits the screen", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await chat(page, request, token, { member: { permissionMode: "auto", model: "claude-sonnet-5", config: { effort: "high", fast: true } } });
  const boxes = await row(page).getByRole("button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: r.left, right: r.right, w: r.width, h: r.height })));
  expect(boxes.length).toBe(3);
  // One line: every chip on the same middle line, none past the screen's edge, none over another. (That each takes a
  // tap 44 px tall is tapTargets.spec.ts's: they're drawn smaller and take taps above and below themselves.)
  for (const [i, b] of boxes.entries()) {
    expect(Math.abs((b.top + b.bottom) / 2 - (boxes[0].top + boxes[0].bottom) / 2)).toBeLessThanOrEqual(2);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(320);
    if (i) expect(b.left).toBeGreaterThanOrEqual(boxes[i - 1].right - 0.5);
  }
  await noHorizontalOverflow(page);
  await row(page).locator(".ctl-model").click();
  const s = sheet(page);
  for (const name of ["Answers with", "May do", "Helpers", "Memory", "This chat"] as const) await openFold(s, name);
  const fits = await s.evaluate((el) => {
    const d = el.getBoundingClientRect();
    const body = el.querySelector(".dialog-body")!;
    const wide = [...body.querySelectorAll<HTMLElement>("button, select, input, p, .cs-fold")].filter((x) => x.getClientRects().length && (x.getBoundingClientRect().right > d.right + 0.5 || x.getBoundingClientRect().left < d.left - 0.5)).map((x) => x.className || x.tagName);
    const small = [...body.querySelectorAll<HTMLElement>(".cs-fold-head, .cs-card, .cs-step, .pop-item, .cs-actions .btn")].filter((x) => x.getClientRects().length && x.getBoundingClientRect().height < 44).map((x) => x.className);
    return { left: d.left, right: d.right, top: d.top, bottom: d.bottom, scrolls: body.scrollHeight > body.clientHeight, sideways: body.scrollWidth > body.clientWidth + 1, wide, small };
  });
  expect(fits.left).toBeGreaterThanOrEqual(0);
  expect(fits.right).toBeLessThanOrEqual(320);
  expect(fits.top).toBeGreaterThanOrEqual(0);
  expect(fits.bottom).toBeLessThanOrEqual(568);
  // It scrolls inside itself, never sideways; nothing in it is wider than it, and every choice is a full target.
  expect(fits.scrolls).toBe(true);
  expect(fits.sideways).toBe(false);
  expect(fits.wide).toEqual([]);
  expect(fits.small).toEqual([]);
  await noHorizontalOverflow(page);
});

test("with a keyboard: Enter opens, arrows move between choices, Escape closes and the focus goes back", async ({ page, request, token }) => {
  const c = await chat(page, request, token);
  const chip = row(page).locator(".ctl-model");
  await chip.focus();
  await page.keyboard.press("Enter");
  const s = sheet(page);
  await expect(s).toBeVisible();
  // The focus is inside the sheet, and Tab stays in it.
  expect(await s.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  const answers = s.getByRole("region", { name: "Answers with", exact: true });
  await modelInForce(answers).focus();
  await page.keyboard.press("ArrowDown");
  await expect(answers.getByRole("menuitemradio").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(answers.getByRole("menuitemradio").first()).toBeFocused();
  // Moving doesn't choose; Enter does.
  expect(c.patches.length).toBe(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => c.patches.at(-1)?.model).toBe("claude-sonnet-5");
  // The same in the steps and the cards.
  await answers.getByRole("radiogroup", { name: "Effort", exact: true }).getByRole("radio").first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(answers.getByRole("radiogroup", { name: "Effort", exact: true }).getByRole("radio").nth(1)).toBeFocused();
  for (let i = 0; i < 40 && (await s.evaluate((el) => el.contains(document.activeElement))); i++) await page.keyboard.press("Tab");
  expect(await s.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(s).toHaveCount(0);
  await expect(chip).toBeFocused();
});
