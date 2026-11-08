import type { Page } from "@playwright/test";
import type { Member, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow, openGroupSettings } from "./fixtures";

// Group chats: several agents in one chat. Claude Code and Codex agents here are only ever set up, never sent a message
// (the test hub's agents would be the real CLIs): anything that runs a reply uses the scripted mock agent.

const HUB = "http://127.0.0.1:8451";
const phone = (page: Page) => page.viewportSize()!.width <= 760;

/** The chat list: the drawer on a phone (opened), the docked sidebar otherwise. */
async function chatList(page: Page) {
  if (phone(page)) await page.getByRole("button", { name: /^Show chats/ }).click();
  const list = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(list).toBeVisible();
  return list;
}

/** A group chat of mock agents, made the way older apps made rooms (POST /api/rooms, then its agents). */
async function mockGroup(request: import("@playwright/test").APIRequestContext, token: string, name: string, agents: { handle: string; config?: Record<string, unknown> }[], mode = "direct") {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode } })).json();
  const members: Member[] = [];
  for (const a of agents) members.push(await (await request.post(`${HUB}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: a.handle, config: { delayMs: 30, ...a.config } } })).json());
  return { room, members, headers, remove: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

test("New chat starts a group chat: its agents each with their own settings, who answers, and the lead", async ({ page }) => {
  await page.goto("/");
  // Home offers it too.
  await page.getByRole("button", { name: "Start a group chat", exact: true }).click();
  const fromHome = page.getByRole("dialog", { name: "New group chat", exact: true });
  await expect(fromHome).toBeVisible();
  await fromHome.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(fromHome).toHaveCount(0);
  const list = await chatList(page);
  await list.getByRole("button", { name: "New chat", exact: true }).click();
  await list.getByRole("menuitem", { name: "Group chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New group chat", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Release plan");
  const agents = dialog.getByRole("list", { name: "Agents in the chat", exact: true });
  // Claude Code and Codex to start with, each from its defaults.
  await expect(agents.getByRole("listitem")).toHaveCount(2);
  await expect(agents.getByRole("button", { name: /^Claude Code: @claude · / })).toBeVisible();
  // Codex gets its own effort and a name of its own in the chat.
  await agents.getByRole("button", { name: /^Codex: @codex · / }).click();
  await agents.getByRole("combobox", { name: "Effort", exact: true }).selectOption("high");
  await agents.getByRole("textbox", { name: "Name in the chat", exact: true }).fill("reviewer");
  await expect(agents.getByRole("button", { name: /^Codex: @reviewer · .* · High effort\./ })).toBeVisible();
  // At least two: the last two can't be removed.
  await expect(agents.getByRole("button", { name: "Remove Codex", exact: true })).toBeDisabled();
  await dialog.getByRole("radio", { name: /^Everyone answers in turn/ }).click();
  await dialog.getByRole("combobox", { name: "Lead", exact: true }).selectOption("1");
  await noHorizontalOverflow(page);
  await dialog.screenshot({ path: test.info().outputPath("new-group-chat.png") });
  const started = page.waitForRequest((req) => req.url().endsWith("/api/chats/group") && req.method() === "POST");
  await dialog.getByRole("button", { name: "Start group chat", exact: true }).click();
  const body = (await started).postDataJSON();
  expect(body).toMatchObject({ name: "Release plan", answers: "turns", lead: 1 });
  expect(body.members.map((m: { provider: string }) => m.provider)).toEqual(["claude", "codex"]);
  expect(body.members[1]).toMatchObject({ effort: "high", handle: "reviewer" });

  // It opens in the chat screen, saying who answers and in what order.
  await expect(page.locator(".topbar h1")).toHaveText("Release plan");
  await expect(page.locator(".topbar .sub")).toContainText("@claude and @reviewer");
  await expect(page.locator(".messages")).toContainText("Group chat with @claude and @reviewer");
  const answers = page.locator(".group-answers");
  await expect(answers).toHaveText("Everyone answers, in turn: @reviewer, then @claude.");
  // @name means that agent answers (not Ask others): the chip row and the button say so.
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("@claude what's left?");
  await expect(answers).toHaveText("Only @claude will answer. The others read it on their next turn.");
  await expect(page.getByRole("button", { name: "Send to @claude", exact: true })).toHaveText("Send to @claude");
  await message.fill("");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath("group-chat.png") });

  // It's in the chat list with the other group chats.
  const after = await chatList(page);
  await expect(after.getByRole("region", { name: "Group chats", exact: true })).toContainText("Release plan");
});

test("the controls under the message box are for one agent at a time", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats/group`, { headers, data: { name: "Two models", members: [{ provider: "claude" }, { provider: "codex", handle: "checker" }], answers: "lead" } })).json();
  const members: Member[] = (await (await request.get(`${HUB}/api/state`, { headers })).json()).members.filter((m: Member) => m.roomId === room.id);
  const checker = members.find((m) => m.handle === "checker")!;
  try {
    await page.goto(`/#/room/${room.id}`);
    // The lead's to begin with.
    const pick = page.getByRole("button", { name: "Settings for @claude. Pick another agent", exact: true });
    await expect(pick).toBeVisible();
    await pick.click();
    await expect(page.getByRole("button", { name: "claude model", exact: true })).toBeVisible();
    const menu = page.getByRole("dialog", { name: "Settings for", exact: true });
    await menu.getByRole("menuitemradio", { name: /^@checker/ }).click();
    await expect(page.getByRole("button", { name: "Settings for @checker. Pick another agent", exact: true })).toBeVisible();
    // Its own model and model list, and a change goes to it alone.
    await page.getByRole("button", { name: "codex model", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Model", exact: true })).toContainText("codex model");
    await page.keyboard.press("Escape");
    const saved = page.waitForRequest((req) => req.url().endsWith(`/api/members/${checker.id}`) && req.method() === "PATCH");
    await page.getByRole("button", { name: /^Permissions: / }).click();
    await page.getByRole("dialog", { name: "Permissions", exact: true }).getByRole("menuitemradio", { name: /^Can edit(?! &)/ }).click();
    expect((await saved).postDataJSON().permissionMode).toBe("edits");
    // Compact now isn't offered: in a group chat "/compact" would be a message for whoever answers.
    await page.getByRole("button", { name: /Show context and plan limits$/ }).click();
    await expect(page.getByRole("button", { name: "Compact now", exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await request.delete(`${HUB}/api/rooms/${room.id}`, { headers }); }
});

test("everyone in turn: each answers, and Try again under a failed reply asks that agent again", async ({ page, request, token }) => {
  const g = await mockGroup(request, token, "In turn", [{ handle: "first" }, { handle: "second", config: { fail: true } }], "roundrobin");
  const second = g.members[1];
  try {
    await page.goto(`/#/room/${g.room.id}`);
    await expect(page.locator(".group-answers")).toHaveText("Everyone answers, in turn: @first, then @second.");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Check the build");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // Both answer, each under its own name: the second one's reply failed. The "@first joined the chat" lines share the
    // reply wrapper, so count the replies themselves (two wrappers are there from the start).
    const replies = page.locator(".agent-reply:has(.msg.agent)");
    await expect(replies).toHaveCount(2);
    await expect(replies.first()).toContainText("@first");
    await expect(replies.last()).toContainText("@second");
    await expect(replies.last()).toContainText("Mock failure");
    const retried = page.waitForRequest((req) => req.url().endsWith(`/api/rooms/${g.room.id}/retry`) && req.method() === "POST");
    await replies.last().getByRole("button", { name: "Try again", exact: true }).click();
    expect((await retried).postDataJSON()).toEqual({ memberId: second.id });
    await noHorizontalOverflow(page);
  } finally { await g.remove(); }
});

test("@ in a group chat names who answers; Ask others stays in a message's actions", async ({ page, request, token }) => {
  const h = await mockGroup(request, token, "Two helpers", [{ handle: "first", config: { reply: "First here." } }, { handle: "second", config: { reply: "Second here." } }]);
  // Who can be asked is answered here: nothing reaches the hub's agents.
  await page.route("**/api/asks/targets**", (route) => route.fulfill({ json: { choices: [{ target: { provider: "codex", account: "default", model: "codex-model", effort: null }, label: "Codex · codex model", sub: "Plan", handle: "codex", paid: "no", local: false, available: true, why: null, typicalCostUsd: null }], machines: [] } }));
  try {
    await page.goto(`/#/room/${h.room.id}`);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    // The @ popup lists the chat's own agents (and everyone), not others to ask.
    await message.fill("@");
    const pop = page.getByRole("listbox");
    await expect(pop.getByRole("option")).toHaveText([/@first/, /@second/, /@all/]);
    await pop.getByRole("option", { name: /@second/ }).click();
    await expect(message).toHaveValue("@second ");
    // Typed after the pick, so the message keeps its @name: only @second answers, and the lead doesn't.
    await message.pressSequentially("Say hello");
    await expect(message).toHaveValue("@second Say hello");
    await expect(page.locator(".group-answers")).toHaveText("Only @second will answer. The others read it on their next turn.");
    const sent = page.waitForResponse((res) => res.url().endsWith(`/api/rooms/${h.room.id}/messages`) && res.request().method() === "POST");
    await page.getByRole("button", { name: "Send to @second", exact: true }).click();
    expect(await (await sent).json()).toMatchObject({ text: "@second Say hello", mentions: [h.members[1].id] });
    const reply = page.locator(".agent-reply").filter({ hasText: "Second here." });
    await expect(reply).toBeVisible();
    await expect(reply).toContainText("@second");
    await expect(page.locator(".agent-reply").filter({ hasText: "First here." })).toHaveCount(0);
    await reply.getByText("Second here.").click();
    await reply.getByRole("button", { name: "Ask others", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Ask others about this message", exact: true });
    await expect(sheet).toContainText("Codex · codex model");
    await noHorizontalOverflow(page);
  } finally { await h.remove(); }
});

// The rooms already in a database (folded into group chats when the hub opens it) are checked against real old database
// files in hub/test/group-chats-migration.test.ts: a browser test hub starts empty. This is the room an older app makes.
test("a room an older app makes (POST /api/rooms, then its agents) opens as a group chat, with its agents in its settings", async ({ page, request, token }) => {
  const g = await mockGroup(request, token, "Old team room", [{ handle: "builder", config: { reply: "Built." } }, { handle: "checker", config: { reply: "Checked." } }]);
  try {
    await request.post(`${HUB}/api/rooms/${g.room.id}/messages`, { headers: g.headers, data: { text: "@all go" } });
    await expect.poll(async () => (await (await request.get(`${HUB}/api/rooms/${g.room.id}/history`, { headers: g.headers })).json()).messages.filter((m: { authorKind: string; status: string }) => m.authorKind === "agent" && m.status === "done").length).toBe(2);
    await page.goto(`/#/room/${g.room.id}`);
    await expect(page.locator(".messages")).toContainText("Built.");
    await expect(page.locator(".messages")).toContainText("Checked.");
    await expect(page.locator(".group-answers")).toHaveText("@builder answers. Type @ to pick who answers.");
    const settings = await openGroupSettings(page);
    const agents = settings.getByRole("list", { name: "Agents in this chat", exact: true });
    await expect(agents.getByRole("listitem")).toHaveCount(2);
    await expect(agents.getByRole("listitem").first()).toContainText("Lead");
    await expect(settings.getByRole("button", { name: "Add an agent", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
  } finally { await g.remove(); }
});
