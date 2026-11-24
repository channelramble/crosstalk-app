import type { APIRequestContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import { test, expect, noHorizontalOverflow, chatSettings } from "./fixtures";

// Helpers on another account, the phone side: the "Helpers run on" control (a chat's settings, and Settings → Agents
// together as what new chats start with), a helper's row in the Helpers panel, and its step under the reply. Nothing
// here starts an agent: the chat's history and the machine's answers are scripted.

const HUB = "http://127.0.0.1:8451";

/** CT_SHOTS: a folder to save the screens in (the 390 and 1440 px Chromium projects only), to look at them. */
const shot = async (target: Page | Locator, name: string) => {
  const project = test.info().project.name;
  const width = project === "chromium-390" ? "390" : project === "chromium-1440" ? "1440" : null;
  if (process.env.CT_SHOTS && width) await target.screenshot({ path: `${process.env.CT_SHOTS}/helpers-${name}-${width}.png`, animations: "disabled" });
};

async function tall(target: Locator) {
  const box = await target.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

const MODELS = {
  claude: { provider: "claude", live: true, models: [{ id: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5", isDefault: true, efforts: ["low", "high"], defaultEffort: "high", description: null }, { id: "sonnet", label: "Sonnet 4.6", resolvedModel: "claude-sonnet-4-6", isDefault: false, efforts: ["low", "high"], defaultEffort: "high", description: null }] },
  codex: { provider: "codex", live: true, models: [{ id: "gpt-big", label: "GPT Big", isDefault: true, efforts: ["low", "high"], defaultEffort: "low", description: null }, { id: "gpt-mini", label: "GPT Mini", isDefault: false, efforts: [], defaultEffort: null, description: null }] },
};

async function scenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Helpers elsewhere" } })).json();
  const snapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: { roomId: string }) => m.roomId === room.id);
  const history = { room, messages: [] as unknown[], turns: [] as unknown[], activities: [] as unknown[], approvals: [], tasks: {} as Record<string, unknown[]>, totals: null, hasMore: false };
  let live: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    live = socket;
    socket.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: MODELS.claude }));
  await page.route("**/api/providers/codex/models**", (r) => r.fulfill({ json: MODELS.codex }));
  // What the menu saves, answered as the machine would: the agent with its new settings, to every device.
  const patches: { config: Record<string, unknown> }[] = [];
  await page.route(`**/api/members/${member.id}`, (r) => {
    if (r.request().method() !== "PATCH") return r.fallback();
    const body = r.request().postDataJSON();
    patches.push(body);
    Object.assign(member, body);
    live?.send(JSON.stringify({ t: "member", member }));
    return r.fulfill({ json: member });
  });
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, member, history, patches, open, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

test("a chat's settings, Helpers: helpers run on the agent's own helpers or on another account, with one tick for what happens when it can't", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  try {
    await s.open();
    const menu = await chatSettings(page, "Helpers");
    const on = menu.getByRole("combobox", { name: "Helpers run on", exact: true });
    // The agent's own helpers, as ever, with their model inside the same control; the chat's own account isn't offered.
    await expect(on.locator("option:checked")).toHaveText("Claude Code's own helpers");
    await expect(on.locator("option")).toContainText(["Claude Code's own helpers", "Codex"]);
    await expect(on.locator("option").filter({ hasText: /^Claude Code$/ })).toHaveCount(0);
    await expect(menu.getByRole("combobox", { name: "Helper agents use", exact: true })).toBeVisible();
    await expect(menu.getByRole("checkbox", { name: /own helpers when that account can't/ })).toHaveCount(0);
    await shot(page, "menu-own");

    // Another account: saved at once as this chat's choice.
    await on.selectOption({ label: "Codex" });
    await expect.poll(() => s.patches.length).toBe(1);
    expect(s.patches[0].config.helpersOn).toEqual({ provider: "codex", account: "default" });
    await expect(on.locator("option:checked")).toHaveText("Codex");
    await expect(menu).toContainText("Your agent hands helper work to Codex, which pays for it.");
    await expect(menu.getByRole("combobox", { name: "Helper agents use", exact: true })).toHaveCount(0);
    // Which model, from that account's own list; and one tick, on by default.
    const model = menu.getByRole("combobox", { name: "Helper model", exact: true });
    await expect(model.locator("option")).toHaveText(["Its default model", "GPT Big", "GPT Mini"]);
    await model.selectOption({ label: "GPT Mini" });
    await expect.poll(() => s.patches.length).toBe(2);
    expect(s.patches[1].config.helpersOn).toEqual({ provider: "codex", account: "default", model: "gpt-mini" });
    const tick = menu.getByRole("checkbox", { name: "Use the agent's own helpers when that account can't run one", exact: true });
    await expect(tick).toBeChecked();
    await tall(menu.locator(".helpers-on-tick"));
    await tick.uncheck();
    await expect.poll(() => s.patches.length).toBe(3);
    expect(s.patches[2].config.helpersOn).toEqual({ provider: "codex", account: "default", model: "gpt-mini", fallback: false });
    await expect(tick).not.toBeChecked();
    await noHorizontalOverflow(page);
    await shot(page, "menu-other");
    // The row under the message box marks it.
    await page.keyboard.press("Escape");
    await expect(page.locator('.chat-controls [aria-label="Helpers run on Codex"]')).toHaveCount(1);

    // Back to its own helpers: nothing of the choice is kept.
    await chatSettings(page, "Helpers");
    await on.selectOption({ label: "Claude Code's own helpers" });
    await expect.poll(() => s.patches.length).toBe(4);
    expect(s.patches[3].config).not.toHaveProperty("helpersOn");
    await expect(menu.getByRole("combobox", { name: "Helper agents use", exact: true })).toBeVisible();
  } finally {
    await s.cleanup();
  }
});

test("a helper on another account is a row in the Helpers panel with its account, and a step under the reply with its report", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  const now = Date.now();
  const at = now - 120_000;
  const msg = (id: string, seq: number, kind: string, text: string, turnId: string | null) => ({ id, seq, roomId: s.room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : "claude", memberId: kind === "agent" ? s.member.id : null, text, mentions: [], turnId, status: "done", createdAt: at + seq * 1000, updatedAt: at + seq * 1000, via: null });
  s.history.messages.push(msg("m1", 1, "human", "Check the build and the docs", null), msg("m2", 2, "agent", "The build is fine; a helper is still on the docs.", "t1"));
  s.history.turns.push({ id: "t1", roomId: s.room.id, memberId: s.member.id, triggerMessageId: "m1", replyMessageId: "m2", hop: 0, chainId: "c1", origin: "human", status: "done", error: null, usage: null, createdAt: at, startedAt: at, endedAt: at + 60_000 });
  s.history.activities.push({ id: "a1", roomId: s.room.id, turnId: "t1", memberId: s.member.id, kind: "tool", title: "Started a helper on Claude API key: Check the build", detail: "Run the test suite and say what fails.\nHelper “Check the build” on Claude API key finished in 48 s. Its report:\n\nAll 212 tests pass.", status: "done", createdAt: at + 500, updatedAt: at + 50_000 });
  s.member.config = { helpersOn: { provider: "claude", account: "key1" } };
  s.history.tasks[s.member.id] = [
    { id: "hp_1", kind: "crosstalk_helper", description: "Check the build", agentType: null, workflow: null, background: true, status: "completed", startedAt: at, endedAt: at + 48_000, tokens: 5200, toolUses: 6, lastTool: null, summary: "All 212 tests pass.", error: null, model: "claude-sonnet-4-6", effort: null, account: "Claude API key", costUsd: 0.25, costBasis: "exact" },
    { id: "hp_2", kind: "crosstalk_helper", description: "Proofread the docs", agentType: null, workflow: null, background: true, status: "running", startedAt: now - 30_000, endedAt: null, tokens: null, toolUses: 3, lastTool: null, summary: "Read docs/GETTING-STARTED.md", error: null, model: "claude-sonnet-4-6", effort: null, account: "Claude API key" },
  ];
  const stops: unknown[] = [];
  await page.route(`**/api/rooms/${s.room.id}/helpers/stop`, (r) => {
    stops.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true, stopped: 1 } });
  });
  try {
    await s.open();
    const panel = page.getByRole("region", { name: "Helpers", exact: true });
    await expect(panel.locator(".helpers-title")).toHaveText("1 helper working · 1 done");
    const rows = panel.locator("li.helper");
    await expect(rows).toHaveCount(2);
    // Working first: what it's called, which account and model it runs on, what it's doing.
    await expect(rows.nth(0)).toContainText("Proofread the docs");
    await expect(rows.nth(0).locator(".hchip").first()).toHaveText("On Claude API key");
    await expect(rows.nth(0)).toContainText("Sonnet 4.6");
    await expect(rows.nth(0)).toContainText("Read docs/GETTING-STARTED.md");
    // Done: what it found, and what it cost on its own account.
    await expect(rows.nth(1)).toContainText("Check the build");
    await expect(rows.nth(1)).toContainText("6 steps · done · $0.25");
    await expect(rows.nth(1)).toContainText("All 212 tests pass.");
    await noHorizontalOverflow(page);
    await shot(page, "panel");
    // Stop asks first, then ends it.
    const stop = panel.getByRole("button", { name: "Stop", exact: true });
    await stop.click();
    await panel.getByRole("button", { name: "Stop it?", exact: true }).click();
    await expect.poll(() => stops.length).toBe(1);
    // Under the reply: the step that started it, with the task and the report folded inside.
    await page.locator(".activity > summary").first().click();
    const step = page.locator(".act-row").filter({ hasText: "Started a helper on Claude API key: Check the build" });
    await expect(step).toBeVisible();
    await step.locator("summary").click();
    await expect(step).toContainText("All 212 tests pass.");
    await shot(page, "step");
  } finally {
    await s.cleanup();
  }
});

test("Settings → Agents together: who does helper work, quick questions and whom, reaching other chats", async ({ page }) => {
  let hub: Record<string, unknown> = { machineName: "", agentsAcrossChats: false, pauseNearLimit: false, teamwork: { enabled: false, perReply: 2, skipAbovePercent: 70, helper: { claude: { model: "claude-sonnet", effort: "low" }, codex: { model: null, effort: null } } }, storage: { autoClean: true, lowSpaceGb: 15 } };
  const puts: Record<string, unknown>[] = [];
  await page.route("**/api/settings/hub", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      puts.push(body);
      hub = { ...hub, ...body };
      if (body.helpers === null) delete hub.helpers;
    }
    return route.fulfill({ json: hub });
  });
  await page.route("**/api/providers/codex/models**", (r) => r.fulfill({ json: MODELS.codex }));
  await page.goto("/#/settings/together");
  const together = page.getByRole("region", { name: "Agents together", exact: true });
  // Three things, a sentence each.
  await expect(together.locator("section.card")).toHaveCount(3);
  const helpers = page.getByRole("region", { name: "Helpers run on", exact: true });
  const questions = page.getByRole("region", { name: "Let agents ask another agent a quick question", exact: true });
  await expect(page.getByRole("region", { name: "Let agents reach your other chats", exact: true })).toBeVisible();

  // Who does helper work in new chats.
  const on = helpers.getByRole("combobox", { name: "Helpers run on", exact: true });
  await expect(on.locator("option:checked")).toHaveText("Each agent's own helpers");
  await expect(on.locator("option")).toContainText(["Each agent's own helpers", "Claude Code", "Codex"]);
  await expect(helpers).toContainText("What new chats start with.");
  await on.selectOption({ label: "Codex" });
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ helpers: { provider: "codex", account: "default" } });
  await expect(helpers.getByRole("checkbox", { name: "Use the agent's own helpers when that account can't run one", exact: true })).toBeChecked();
  await expect(helpers.getByRole("combobox", { name: "Helper model", exact: true }).locator("option")).toHaveText(["Its default model", "GPT Big", "GPT Mini"]);
  await expect(helpers).toContainText("Saves as you change it.");

  // Quick questions: off shows no list; on shows who can be asked, the agents' own sign-ins ticked as before.
  const toggle = questions.getByRole("checkbox", { name: "Let agents ask another agent a quick question", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(questions.getByRole("group", { name: "Who they can ask", exact: true })).toHaveCount(0);
  await toggle.check();
  await expect.poll(() => puts.length).toBe(2);
  // What the machine saved for the rest goes back untouched.
  expect(puts[1]).toEqual({ teamwork: { enabled: true, perReply: 2, skipAbovePercent: 70, helper: { claude: { model: "claude-sonnet", effort: "low" }, codex: { model: null, effort: null } } } });
  const who = questions.getByRole("group", { name: "Who they can ask", exact: true });
  const claude = who.getByRole("checkbox", { name: "Claude Code", exact: true });
  await expect(claude).toBeChecked();
  await expect(who.getByRole("checkbox", { name: "Codex", exact: true })).toBeChecked();
  await tall(who.locator("label").first());
  await claude.uncheck();
  await expect.poll(() => puts.length).toBe(3);
  expect((puts[2].teamwork as { who: unknown }).who).toEqual([{ provider: "codex", account: "default" }]);
  await expect(claude).not.toBeChecked();
  await noHorizontalOverflow(page);
  await shot(page, "settings");
  await questions.getByRole("button", { name: "More about quick questions", exact: true }).click();
  await expect(questions.getByRole("note")).toContainText("sees only the question, never your chat");

  // Back to each agent's own helpers.
  await on.selectOption({ label: "Each agent's own helpers" });
  await expect.poll(() => puts.length).toBe(4);
  expect(puts[3]).toEqual({ helpers: null });
  await expect(helpers.getByRole("combobox", { name: "Helper model", exact: true })).toHaveCount(0);
});
