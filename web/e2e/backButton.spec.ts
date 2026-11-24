import type { Page } from "@playwright/test";
import type { Room } from "@crosstalk/shared";
import { test, expect } from "./fixtures";

// The browser's (and the phone's) Back (web/src/back.ts): it goes to the screen the one on screen was opened from, and
// closes what's open over the screen first (the chat list on a phone, a dialog). Chats are made through the hub and
// nothing is sent in them: no agent runs.

const HUB = "http://127.0.0.1:8451";
const title = (page: Page) => page.locator(".topbar h1");
const hash = (page: Page) => page.evaluate(() => location.hash);
const home = (page: Page) => page.getByRole("heading", { name: "What agent do you want to use?", exact: true });
const phone = () => /-(320|390)$/.test(test.info().project.name);
/** Home's address: "#/", or none when the app was opened without one (its first screen keeps the address it came with). */
const atHome = (page: Page) => expect.poll(() => hash(page)).toMatch(/^(#\/)?$/);
/** A page that isn't the app, to come from and go back to. */
const OUTSIDE = `${HUB}/api/health`;

/** Two chats on the test hub (the fixture deletes them after the test). */
async function chats(request: import("@playwright/test").APIRequestContext, token: string): Promise<[Room, Room]> {
  const headers = { authorization: `Bearer ${token}` };
  const tag = Math.random().toString(36).slice(2, 6);
  const make = async (name: string) => (await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", name: `${name} ${tag}` } })).json()) as Room;
  return [await make("Back one"), await make("Back two")];
}

/** The chat list: a drawer on a phone (opened here), docked beside the screen on a wide one. */
async function chatList(page: Page) {
  const show = page.getByRole("button", { name: /^Show chats/ });
  if (await show.count()) await show.click();
  const list = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(list).toBeVisible();
  return list;
}

test("Home, a chat, Back: Home again; another chat from the list takes the chat's place", async ({ page, request, token }) => {
  const [one, two] = await chats(request, token);
  await page.goto("/");
  const recent = page.getByRole("region", { name: "Recent chats", exact: true });
  await recent.getByRole("button").filter({ hasText: one.name }).click();
  await expect(title(page)).toContainText(one.name);
  expect(await hash(page)).toBe(`#/room/${one.id}`);
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);

  // Chat after chat from the list: Back still leads to Home, not through every chat looked at.
  await recent.getByRole("button").filter({ hasText: one.name }).click();
  await expect(title(page)).toContainText(one.name);
  await (await chatList(page)).getByRole("button").filter({ hasText: two.name }).first().click();
  await expect(title(page)).toContainText(two.name);
  await expect.poll(() => hash(page)).toBe(`#/room/${two.id}`);
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);
});

test("Home, an agent's page, a chat: Back goes up one at a time", async ({ page, request, token }) => {
  const [one] = await chats(request, token);
  await page.goto("/");
  await page.locator(".agent-card").filter({ hasText: "Codex" }).click();
  await expect(page.getByRole("region", { name: "Your chats", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Your chats", exact: true }).getByRole("button").filter({ hasText: one.name }).click();
  await expect(title(page)).toContainText(one.name);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Your chats", exact: true })).toBeVisible();
  expect(await hash(page)).toBe("#/agent/codex");
  await page.goBack();
  await expect(home(page)).toBeVisible();
  // Forward works too.
  await page.goForward();
  await expect(page.getByRole("region", { name: "Your chats", exact: true })).toBeVisible();
});

test("a chat, Settings, Back: the chat again", async ({ page, request, token }) => {
  const [one] = await chats(request, token);
  await page.goto("/");
  await page.getByRole("region", { name: "Recent chats", exact: true }).getByRole("button").filter({ hasText: one.name }).click();
  await expect(title(page)).toContainText(one.name);
  await (await chatList(page)).getByRole("button", { name: "Settings", exact: true }).click();
  await expect(title(page)).toHaveText("Settings");
  await expect.poll(() => hash(page)).toBe("#/settings");
  await page.goBack();
  await expect(title(page)).toContainText(one.name);
  expect(await hash(page)).toBe(`#/room/${one.id}`);
  await page.goBack();
  await expect(home(page)).toBeVisible();
});

test("on a phone, Back closes the chat list and stays on the screen; closed by its own button, it leaves nothing behind", async ({ page, request, token }) => {
  test.skip(!phone(), "The chat list is a drawer on phone widths: the 320 and 390 projects.");
  const [one] = await chats(request, token);
  await page.goto("/");
  await page.getByRole("region", { name: "Recent chats", exact: true }).getByRole("button").filter({ hasText: one.name }).click();
  await expect(title(page)).toContainText(one.name);

  const list = await chatList(page);
  await page.goBack();
  await expect(list).toHaveCount(0);
  await expect(title(page)).toContainText(one.name);
  expect(await hash(page)).toBe(`#/room/${one.id}`);

  // Opened again and closed with its own button: the next Back leaves the chat, it doesn't stop on a closed list.
  await chatList(page);
  await list.getByRole("button", { name: "Close", exact: true }).click();
  await expect(list).toHaveCount(0);
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);
});

test("Back closes a dialog and stays on the screen; closed by its own button, it leaves nothing behind", async ({ page }) => {
  await page.goto("/");
  await page.locator(".agent-card").filter({ hasText: "Codex" }).click();
  const newChat = page.locator(".agent-hero").getByRole("button", { name: "New chat", exact: true });
  await newChat.click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(newChat).toBeVisible();
  expect(await hash(page)).toBe("#/agent/codex");

  // Opened again and cancelled: the next Back leaves the agent's page for Home.
  await newChat.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);
});

test("a dialog with unsaved changes asks before Back closes it, and Back works as before once it has closed", async ({ page }) => {
  await page.goto("/");
  await page.locator(".agent-card").filter({ hasText: "Codex" }).click();
  await page.locator(".agent-hero").getByRole("button", { name: "New chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  // A first message written from a template: closing would lose it.
  await dialog.getByRole("combobox", { name: "From a template", exact: true }).selectOption({ label: "Review my changes" });
  const message = dialog.getByRole("textbox", { name: "First message", exact: true });
  await message.fill("Review the changes, and the tests too");
  const asks = dialog.getByText("Discard changes?", { exact: true });

  await page.goBack();
  await expect(asks).toBeVisible();
  expect(await hash(page)).toBe("#/agent/codex");
  // Back again: keep editing, as Escape does. Nothing is lost and the screen under it hasn't moved.
  await page.goBack();
  await expect(asks).toHaveCount(0);
  await expect(message).toHaveValue("Review the changes, and the tests too");
  expect(await hash(page)).toBe("#/agent/codex");

  await page.goBack();
  await expect(asks).toBeVisible();
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);
});

test("a chat started from a dialog: Back is the screen the dialog was on", async ({ page }) => {
  await page.goto("/");
  await page.locator(".agent-card").filter({ hasText: "Codex" }).click();
  await page.locator(".agent-hero").getByRole("button", { name: "New chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Back from a new chat");
  const start = dialog.getByRole("button", { name: "Start chat", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(title(page)).toContainText("Back from a new chat");
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Your chats", exact: true })).toBeVisible();
  expect(await hash(page)).toBe("#/agent/codex");
  await page.goBack();
  await expect(home(page)).toBeVisible();
});

test("after a reload at a chat, Back still goes to Home; a chat opened by its address has nothing behind it", async ({ page, request, token }) => {
  const [one] = await chats(request, token);
  await page.goto("/");
  await page.getByRole("region", { name: "Recent chats", exact: true }).getByRole("button").filter({ hasText: one.name }).click();
  await expect(title(page)).toContainText(one.name);
  await page.reload();
  await expect(title(page)).toContainText(one.name);
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);

  // A fresh load at the chat's address: Back leaves the app (nobody is kept in it), and coming back opens the chat.
  await page.goto(OUTSIDE);
  await page.goto(`/#/room/${one.id}`);
  await expect(title(page)).toContainText(one.name);
  await page.goBack();
  await expect(page).toHaveURL(OUTSIDE);
  await page.goForward();
  await expect(title(page)).toContainText(one.name);
});

/** The part of Settings on screen: "Settings" is its list of pages, anything else a page's name. */
const settingsOn = (page: Page) => page.locator("#settings-panel");
const pageRow = (page: Page, name: string) => page.getByRole("navigation", { name: "Settings pages" }).locator(".settings-page-row .title").getByText(name, { exact: true });

test("a link to a section of Settings still opens it, and Back from it leaves the app as any first screen does", async ({ page }) => {
  await page.goto(OUTSIDE);
  await page.goto("/#/settings/machines");
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Machines");
  // The address is left as it came, so a reload opens the same section.
  expect(await hash(page)).toBe("#/settings/machines");
  await page.reload();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Machines");
  await page.goBack();
  await expect(page).toHaveURL(OUTSIDE);
});

test("a page of Settings: Back is the list of pages, then the screen Settings was opened from", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  await expect.poll(() => hash(page)).toBe("#/settings");
  await pageRow(page, "Accounts").click();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Accounts");
  await expect.poll(() => hash(page)).toBe("#/settings/accounts");

  // Back: the list, and Forward the page again.
  await page.goBack();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  await expect.poll(() => hash(page)).toBe("#/settings");
  await page.goForward();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Accounts");
  await expect.poll(() => hash(page)).toBe("#/settings/accounts");

  // The page's own Back button is the same step: nothing is left behind it, so Back from the list is Home.
  await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  await expect.poll(() => hash(page)).toBe("#/settings");
  // Page after page from the list: still one step each way.
  await pageRow(page, "This device").click();
  await expect.poll(() => hash(page)).toBe("#/settings/device");
  await page.goBack();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);
});

test("a page of Settings opened by its address: its Back button shows the list, and a reload stays on the list", async ({ page }) => {
  await page.goto(OUTSIDE);
  await page.goto("/#/settings/accounts");
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Accounts");
  await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  await expect.poll(() => hash(page)).toBe("#/settings");
  await page.reload();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  // The list took the page's place: nothing of the app is behind it.
  await page.goBack();
  await expect(page).toHaveURL(OUTSIDE);
});

test("unsaved changes that refuse to be left keep their screen and their address when Back is pressed", async ({ page }) => {
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: { mode: "review", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: {} } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  await pageRow(page, "New chats").click();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "New chats");
  const row = page.getByRole("group", { name: "New Codex chat defaults", exact: true });
  await expect.poll(async () => (await row.getAttribute("open")) !== null || !(await row.locator("summary").innerText()).trim().endsWith("…")).toBe(true);
  if ((await row.getAttribute("open")) === null) await row.locator("summary").click();
  await row.getByRole("radio", { name: "Full access", exact: true }).click();
  let discard = false;
  let asked = 0;
  page.on("dialog", (d) => { asked++; void (discard ? d.accept() : d.dismiss()); });

  // Keep editing: still the page, with its address, and Back hasn't been used up.
  await page.goBack();
  await expect.poll(() => asked).toBe(1);
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "New chats");
  await expect.poll(() => hash(page)).toBe("#/settings/new-chats");
  await expect(row.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  // Discard: Back goes to the list of pages, and from there to Home.
  discard = true;
  await page.goBack();
  await expect(settingsOn(page)).toHaveAttribute("aria-label", "Settings");
  await expect.poll(() => hash(page)).toBe("#/settings");
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await atHome(page);
});
