import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, noHorizontalOverflow, settingsList, settingsTab } from "./fixtures";

// Settings as one list of pages (shared/src/settingsPages.ts, web/src/views/AppSettings.tsx and SettingsIndex.tsx):
// the list on a phone, search, a page and its Back, what needs you, and every address that names a part of Settings
// landing on its section inside its page.
// CT_SHOTS: a folder to save the screens in (390 px Chromium only), to look at them.

const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
const pages = (page: Page) => page.getByRole("navigation", { name: "Settings pages", exact: true });
const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const back = (page: Page) => page.getByRole("button", { name: "Back to Settings", exact: true });
const NAMES = ["Accounts", "New chats", "Agents together", "Usage & costs", "This device", "Machines", "Your own models"];

test("Settings opens on its list of pages: a finger-sized row each, saying what's in it, and nothing wider than the phone", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  await expect(page.locator(".topbar h1")).toHaveText("Settings");
  await expect(pages(page).locator(".settings-page-row .title")).toHaveText(NAMES);
  // No tabs any more, and no shell command on the first screen.
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(region(page, "Settings").locator("code")).toHaveCount(0);
  // Each row is a button at least a finger high, with one line under its name.
  for (const row of await pages(page).locator(".settings-page-row").all()) {
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(row.locator(".subtitle")).not.toBeEmpty();
  }
  // The whole list fits a phone screen without scrolling past the last page.
  await expect(pages(page).locator(".settings-page-row").last()).toBeInViewport();
  await expect(page.getByRole("searchbox", { name: "Search settings", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  // The footer line that sat under every tab is gone: the version and folders are under Machines → Advanced.
  await expect(region(page, "Settings")).not.toContainText("new chat folders go in");
});

test("a page opens over the list with Back to it, and the address follows so a reload comes back", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  await settingsTab(page, "This device");
  await expect(page.locator(".topbar h1")).toHaveText("This device");
  await expect(page).toHaveURL(/#\/settings\/device$/);
  for (const heading of ["Notifications", "Text size", "Paired devices"]) await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  // Back is a finger's size, and returns to the list.
  const box = (await back(page).boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  await page.reload();
  await expect(region(page, "This device")).toBeVisible();
  await back(page).click();
  await expect(pages(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
  // Going back in the address shows the list too (the phone's Back, once the app keeps history).
  await settingsTab(page, "Machines");
  await page.evaluate(() => (location.hash = "#/settings"));
  await expect(pages(page)).toBeVisible();
  // Leaving Settings and coming back starts at the list again.
  await settingsTab(page, "Machines");
  await page.goto("/#/rooms");
  await page.goto("/#/settings");
  await expect(pages(page)).toBeVisible();
});

test("the keyboard opens a page, lands in it, and Back is the first stop", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  await pages(page).locator(".settings-page-row").nth(5).focus();
  await page.keyboard.press("Enter");
  await expect(region(page, "Machines")).toBeFocused();
  await expect(region(page, "Machines").getByRole("heading", { name: "Machines", exact: true }).first()).toBeVisible();
  await back(page).focus();
  await page.keyboard.press("Enter");
  await expect(pages(page)).toBeVisible();
});

test("Search settings finds a page or a section by a word, and a tap lands on it", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  const search = page.getByRole("searchbox", { name: "Search settings", exact: true });
  const results = page.getByRole("region", { name: "Search results", exact: true });
  await search.fill("stor");
  await expect(results.locator(".settings-page-row .title")).toHaveText(["Storage"]);
  await expect(results.locator(".settings-page-row .subtitle")).toHaveText(["Machines"]);
  await expect(pages(page)).toHaveCount(0);
  await results.getByRole("button").first().click();
  await expect(region(page, "Machines")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Storage", exact: true }).first()).toBeInViewport();
  // A keyword: the terminal is under Advanced, which opens by itself when asked for.
  await settingsList(page);
  await search.fill("terminal");
  await results.getByRole("button", { name: /Advanced/ }).click();
  await expect(region(page, "Machines").getByRole("button", { name: /^Terminal/ })).toBeVisible();
  // Nothing found says so, with something to try; clearing brings the pages back.
  await settingsList(page);
  await search.fill("qqqq");
  await expect(results).toContainText("Nothing in Settings matches “qqqq”");
  await page.getByRole("button", { name: "Clear the search", exact: true }).click();
  await expect(pages(page)).toBeVisible();
  await noHorizontalOverflow(page);
});

test("every address for a part of Settings opens its page and lands on its section", async ({ page }) => {
  await phone(page);
  // The sections the hub's setup checklist and its push notifications name (hub/src/setup/checklist.ts, app.ts, spend.ts),
  // and every other id Settings had as five tabs.
  for (const [section, name, heading] of [
    ["devices", "This device", "Paired devices"],
    ["display", "This device", "Text size"],
    ["machines", "Machines", "Machines"],
    ["storage", "Machines", "Storage"],
    ["more", "Machines", "GitHub"],
    ["computers", "Machines", "Remote computers"],
    ["screen", "Machines", "Screen"],
    ["notifications", "This device", "Notifications"],
    ["agent-setup", "Machines", "Set up with an AI agent"],
    ["local-models", "Your own models", "Local models"],
    ["usage", "Usage & costs", "Plan limits"],
    ["costs", "Usage & costs", "Costs"],
    ["templates", "New chats", "Templates"],
  ]) {
    await page.goto(`/#/settings/${section}`);
    await expect(region(page, name)).toBeVisible();
    const there = page.getByRole("heading", { name: heading, exact: true }).first();
    await expect(there).toBeVisible();
    await expect(there).toBeInViewport();
  }
  // Sections that are a card, not a heading.
  for (const [section, name] of [
    ["ai-services", "Accounts"],
    ["agent-claude", "Accounts"],
    ["agent-codex", "Accounts"],
    ["agent-opencode", "Accounts"],
    ["teamwork", "Agents together"],
  ]) {
    await page.goto(`/#/settings/${section}`);
    await expect(region(page, name)).toBeVisible();
    await expect(page.locator(`#${section}`)).toBeInViewport();
  }
  // A switch that's a fixed default now: its address lands on the page it was on. So does a section that was taken out.
  await page.goto("/#/settings/keep-going");
  await expect(region(page, "Agents together")).toBeVisible();
  await page.goto("/#/settings/model-pool");
  await expect(region(page, "Your own models")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Local models", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model pool", exact: true })).toHaveCount(0);
  // A page's own name opens it, the five older tabs' names open the closest page, and a name that's no part of
  // Settings leaves it where it was.
  await page.goto("/#/settings/new-chats");
  await expect(region(page, "New chats")).toBeVisible();
  await page.goto("/#/settings/agents");
  await expect(region(page, "Accounts")).toBeVisible();
  await page.goto("/#/settings/models");
  await expect(region(page, "Your own models")).toBeVisible();
  await page.goto("/#/settings/made-up-section");
  await expect(region(page, "Your own models")).toBeVisible();
  // The older addresses for parts of Settings still open what they say; Usage was a screen of its own.
  await page.goto("/#/devices");
  await expect(region(page, "This device")).toBeVisible();
  await page.goto("/#/usage");
  await expect(region(page, "Usage & costs")).toBeVisible();
  await expect(page.getByRole("region", { name: "Plan limits", exact: true })).toBeVisible();
  await page.goto("/#/setup");
  await expect(region(page, "Machines")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set up with an AI agent", exact: true })).toBeInViewport();
});

test("a page opened right after a deep link stays open", async ({ page }) => {
  await phone(page);
  // The low-space push lands on Storage and holds it in view for a few seconds while the page fills in.
  await page.goto("/#/settings/storage");
  const storage = page.getByRole("heading", { name: "Storage", exact: true }).first();
  await expect(storage).toBeInViewport();
  // Going to another page in that time wins: the hold would pull you back as soon as the new page's own cards loaded in.
  await settingsTab(page, "This device");
  const text = page.getByRole("heading", { name: "Text size", exact: true });
  await expect(text).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(region(page, "This device")).toBeVisible();
  await expect(text).toBeVisible();
  await expect(storage).toHaveCount(0);
});

test("leaving a page with unsaved new-chat defaults asks first, as leaving Settings does", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings/new-chats");
  const defaults = page.getByRole("group", { name: "New Codex chat defaults", exact: true });
  await defaults.locator("summary").click();
  await defaults.getByRole("radio", { name: "Full access", exact: true }).click();
  await expect(defaults.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  // Cancel keeps you here, with the change still in the card.
  page.once("dialog", (d) => void d.dismiss());
  await back(page).click();
  await expect(region(page, "New chats")).toBeVisible();
  await expect(defaults.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  // Saying yes moves on.
  page.once("dialog", (d) => void d.accept());
  await back(page).click();
  await expect(pages(page)).toBeVisible();
});

test("a link from elsewhere in Settings opens the right page, even with Settings already on screen", async ({ page }) => {
  await phone(page);
  // Costs is in Usage & costs; Raise limit in a chat's costs line goes there from wherever Settings is (spendNotices.ts).
  await page.goto("/#/settings/machines");
  await page.evaluate(async (path) => (await import(path)).openCosts(), "/src/spendNotices.ts");
  await expect(region(page, "Usage & costs")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeInViewport();
  // And from another screen altogether.
  await page.goto("/#/rooms");
  await page.evaluate(async (path) => (await import(path)).openCosts(), "/src/spendNotices.ts");
  await expect(page.locator(".topbar h1")).toHaveText("Usage & costs");
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeInViewport();
});

test("Needs you shows only when something does, each row with a button that does it right there", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  await expect(pages(page)).toBeVisible();
  const needs = page.getByRole("region", { name: "Needs you", exact: true });
  // The test machine's agents are ready; the one thing its checklist has for a person is that no device gets
  // notifications yet. That's the only row, said without the checklist's own "(above)".
  await expect(needs.getByRole("group")).toHaveCount(1);
  await expect(needs.getByRole("group", { name: "Notifications", exact: true })).toContainText("No device gets notifications yet");
  await expect(needs).not.toContainText("(above)");
  // Codex signed out, and a question on the Mac's screen: a row each, the Mac's first.
  await page.evaluate(async (path) => {
    const { useStore } = await import(path);
    const s = useStore.getState();
    useStore.setState({
      providers: { ...s.providers, codex: { ...s.providers.codex, installed: true, signedIn: false, checkedAt: Date.now() } },
      accounts: Object.fromEntries(Object.entries(s.accounts).filter(([, a]) => (a as { provider: string }).provider !== "codex")),
      macDialogs: [{ id: "d1", app: "Terminal", wants: "files on external drives", since: Date.now(), count: 1 }],
    });
  }, "/src/store.ts");
  await expect(needs).toBeVisible();
  await expect(needs.getByRole("group")).toHaveCount(3);
  const mac = needs.getByRole("group").first();
  await expect(mac).toContainText("is waiting for an answer on its screen");
  await expect(mac).toContainText("Terminal wants files on external drives.");
  const codex = needs.getByRole("group", { name: "Codex isn't signed in", exact: true });
  await expect(codex.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  // Never a command here, the buttons are a finger high, and nothing is wider than the phone.
  await expect(needs.locator("code")).toHaveCount(0);
  for (const b of await needs.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);
  if (process.env.CT_SHOTS && test.info().project.name === "chromium-390") await page.screenshot({ path: join(process.env.CT_SHOTS, "settings-0-needs-you.png") });
  // See it goes to This Mac, on the Machines page.
  await mac.getByRole("button", { name: "See it", exact: true }).click();
  await expect(region(page, "Machines")).toBeVisible();
});

test("the screens, for looking at", async ({ page }) => {
  const dir = process.env.CT_SHOTS;
  test.skip(!dir || test.info().project.name !== "chromium-390", "CT_SHOTS=/some/dir on chromium-390 saves the screens");
  mkdirSync(dir!, { recursive: true });
  await phone(page);
  await page.goto("/#/settings");
  await expect(pages(page)).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(dir!, "settings-1-list.png") });
  await page.getByRole("searchbox", { name: "Search settings", exact: true }).fill("limit");
  await page.screenshot({ path: join(dir!, "settings-1-search.png") });
  await page.getByRole("button", { name: "Clear the search", exact: true }).click();
  for (const [i, name] of NAMES.entries()) {
    const panel = await settingsTab(page, name);
    await page.waitForTimeout(900);
    // The whole page, however long, in one picture.
    const height = await panel.evaluate((el) => el.scrollHeight);
    await page.setViewportSize({ width: 390, height: Math.min(9000, Math.max(844, height + 80)) });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(dir!, `settings-${i + 2}-${name.toLowerCase().replace(/[^a-z]+/g, "-")}.png`) });
    await phone(page);
    await settingsList(page);
  }
});
