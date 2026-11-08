import type { Page } from "@playwright/test";
import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";

// Settings in tabs (web/src/settingsTabs.ts, views/AppSettings.tsx): the row on a phone, the keyboard, the tab this
// device comes back to, and every address that names a part of Settings landing in the right tab.

const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Settings", exact: true });
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const NAMES = ["Agents", "Models", "Machines", "Devices", "Usage"];

test("on a phone the tabs are all reachable without scrolling the page, and the one you're on is clear", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  await expect(tabs(page)).toBeVisible();
  await expect(tabs(page).getByRole("tab")).toHaveText(NAMES);
  // Settings opens on the first tab, which is what it's opened for most.
  await expect(tab(page, "Agents")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Agents", exact: true })).toBeVisible();
  // The row is beside the header, not down the page: every tab is one tap away however long the page is.
  const row = (await tabs(page).boundingBox())!;
  expect(row.y + row.height).toBeLessThan(200);
  // Each one is a finger's width and height, as every other control on a phone is, and the names never widen the page.
  for (const name of NAMES) {
    const box = (await tab(page, name).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await noHorizontalOverflow(page);
  // The last tab can be reached (the row scrolls sideways when the names don't fit).
  await settingsTab(page, "Usage");
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeVisible();
  await expect(tab(page, "Usage")).toBeInViewport();
  await noHorizontalOverflow(page);
});

test("the keyboard moves between the tabs, opens one, and lands in its settings", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  await tab(page, "Agents").focus();
  // Arrow keys move between the tabs without opening one (the panels ask their machine for things).
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Models")).toBeFocused();
  await expect(tab(page, "Agents")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tab(page, "Usage")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Agents")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Usage")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab(page, "Agents")).toBeFocused();
  // Enter opens the one you moved to, and focus goes into its settings, not back to the tabs.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(tab(page, "Machines")).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("tabpanel", { name: "Machines", exact: true });
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("heading", { name: "Machines", exact: true }).first()).toBeVisible();
  // Space opens one too.
  await tab(page, "Devices").focus();
  await page.keyboard.press(" ");
  await expect(tab(page, "Devices")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Display", exact: true })).toBeVisible();
});

test("the tab you were last on comes back when you open Settings again on this device", async ({ page }) => {
  await page.goto("/#/settings");
  await settingsTab(page, "Machines");
  // Away and back.
  await page.goto("/#/rooms");
  await page.goto("/#/settings");
  await expect(tab(page, "Machines")).toHaveAttribute("aria-selected", "true");
  // A reload too: it's kept on this device, not in the address.
  await page.reload();
  await expect(tab(page, "Machines")).toHaveAttribute("aria-selected", "true");
  // Another device starts at the first tab (this one's choice is its own).
  await page.evaluate(() => localStorage.removeItem("crosstalk.settings.tab.v1"));
  await page.goto("/#/rooms");
  await page.goto("/#/settings");
  await expect(tab(page, "Agents")).toHaveAttribute("aria-selected", "true");
});

test("every address for a part of Settings opens its tab and lands on its section", async ({ page }) => {
  await phone(page);
  // The sections the hub's setup checklist and its push notifications name (hub/src/setup/checklist.ts, app.ts, spend.ts).
  for (const [section, name, heading] of [
    ["devices", "Devices", "Devices"],
    ["machines", "Machines", "Machines"],
    ["model-pool", "Models", "Model pool"],
    ["ai-services", "Agents", "AI services"],
    ["storage", "Machines", "Storage"],
    ["costs", "Usage", "Costs"],
    ["agent-setup", "Agents", "Set up with an AI agent"],
    ["templates", "Agents", "Templates"],
    ["local-models", "Models", "Local models"],
    ["teamwork", "Agents", "Teamwork"],
  ]) {
    await page.goto(`/#/settings/${section}`);
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    const there = page.getByRole("heading", { name: heading, exact: true }).first();
    await expect(there).toBeVisible();
    await expect(there).toBeInViewport();
  }
  // An agent's own card, as Machines → Sign in and the checklist's sign-in fixes ask for it.
  await page.goto("/#/settings/agent-claude");
  await expect(tab(page, "Agents")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#agent-claude")).toBeInViewport();
  // A tab's own name opens that tab, and a name that's no part of Settings opens it where it was.
  await page.goto("/#/settings/models");
  await expect(tab(page, "Models")).toHaveAttribute("aria-selected", "true");
  await page.goto("/#/settings/made-up-section");
  await expect(tab(page, "Models")).toHaveAttribute("aria-selected", "true");
  // The older addresses for parts of Settings still open what they say.
  await page.goto("/#/devices");
  await expect(tab(page, "Devices")).toHaveAttribute("aria-selected", "true");
  await page.goto("/#/setup");
  await expect(tab(page, "Agents")).toHaveAttribute("aria-selected", "true");
});

test("a tab tapped right after a deep link stays open", async ({ page }) => {
  await phone(page);
  // The low-space push lands on Storage and holds it in view for a few seconds while the page fills in.
  await page.goto("/#/settings/storage");
  const storage = page.getByRole("heading", { name: "Storage", exact: true }).first();
  await expect(storage).toBeInViewport();
  // Tapping a tab in that time wins: the hold would pull you back as soon as the new tab's own cards loaded in.
  await settingsTab(page, "Devices");
  const display = page.getByRole("heading", { name: "Display", exact: true });
  await expect(display).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(tab(page, "Devices")).toHaveAttribute("aria-selected", "true");
  await expect(display).toBeVisible();
  await expect(storage).toHaveCount(0);
});

test("leaving a tab with unsaved new-chat defaults asks first, as leaving Settings does", async ({ page }) => {
  await phone(page);
  await page.goto("/#/settings");
  const defaults = page.getByRole("group", { name: "New Codex chat defaults", exact: true });
  await defaults.locator("summary").click();
  await defaults.getByRole("radio", { name: "Full access", exact: true }).click();
  await expect(defaults.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  // Cancel keeps you here, with the change still in the card.
  page.once("dialog", (d) => void d.dismiss());
  await tab(page, "Usage").click();
  await expect(tab(page, "Agents")).toHaveAttribute("aria-selected", "true");
  await expect(defaults.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  // Saying yes moves on.
  page.once("dialog", (d) => void d.accept());
  await settingsTab(page, "Usage");
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeVisible();
});

test("a link from elsewhere in Settings opens the right tab, even with Settings already on screen", async ({ page }) => {
  await phone(page);
  // Costs is in Usage; Raise limit in a chat's costs line goes there from wherever Settings is (spendNotices.ts).
  await page.goto("/#/settings/machines");
  await page.evaluate(async (path) => (await import(path)).openCosts(), "/src/spendNotices.ts");
  await expect(tab(page, "Usage")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeInViewport();
  // And from another screen altogether.
  await page.goto("/#/rooms");
  await page.evaluate(async (path) => (await import(path)).openCosts(), "/src/spendNotices.ts");
  await expect(page.locator(".topbar h1")).toHaveText("Settings");
  await expect(tab(page, "Usage")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeInViewport();
});
