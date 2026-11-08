import type { Page, Route, WebSocketRoute } from "@playwright/test";
import { test, expect, noHorizontalOverflow } from "./fixtures";

const alpha = { name: "alpha", label: "Alpha Mac", user: "owner", host: "100.64.0.2", online: false, detail: "Asleep" };
const beta = { ...alpha, name: "beta", label: "Beta Mac", host: "100.64.0.3" };
const card = (page: Page) => page.getByRole("region", { name: "Computers agents can use", exact: true });
const row = (page: Page, label: string) => card(page).locator(".list-row").filter({ hasText: label });

// Every computer endpoint is intercepted: these tests must never generate real SSH keys or connect to a machine.
async function computers(page: Page, handle: (route: Route, path: string) => Promise<void>) {
  await page.route(/\/api\/computers(?:\/|$)/, (route) => handle(route, new URL(route.request().url()).pathname));
}

async function closeConnectDialog(page: Page) {
  await page.getByRole("dialog", { name: "Connect a computer", exact: true }).getByRole("button", { name: "Close", exact: true }).last().click();
}

test("computer list retries a failed load and refreshes after reconnect", async ({ page }) => {
  let fail = true;
  let listed = [alpha];
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?*", (ws) => { socket = ws; });
  await computers(page, async (route, path) => {
    expect(path).toBe("/api/computers");
    await route.fulfill(fail ? { status: 503, json: { error: "Computers unavailable" } } : { json: listed });
  });
  await page.goto("/#/settings/computers");
  await expect(card(page).getByRole("alert")).toContainText("Computers unavailable");
  fail = false;
  await card(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(row(page, alpha.label)).toContainText("Offline");
  listed = [{ ...alpha, online: true, detail: "Connected" }];
  await expect.poll(() => !!socket).toBe(true);
  await socket!.close({ code: 1012, reason: "Browser test reconnect" });
  await expect(row(page, alpha.label)).toContainText("Connected");
  await noHorizontalOverflow(page);
});

test("concurrent computer tests stay locked independently and recover from failure", async ({ page }) => {
  const tests = new Map<string, Route>();
  await computers(page, async (route, path) => {
    if (path === "/api/computers") return route.fulfill({ json: [alpha, beta] });
    expect(path).toMatch(/^\/api\/computers\/(alpha|beta)\/test$/);
    tests.set(path.split("/")[3], route);
  });
  await page.goto("/#/settings/computers");
  const a = row(page, alpha.label);
  const b = row(page, beta.label);
  await a.getByRole("button", { name: "Test", exact: true }).click();
  await b.getByRole("button", { name: "Test", exact: true }).click();
  await expect.poll(() => tests.size).toBe(2);
  await expect(a.getByRole("button", { name: "Testing…", exact: true })).toBeDisabled();
  await expect(a.getByRole("button", { name: "Disconnect", exact: true })).toBeDisabled();
  await tests.get("alpha")!.fulfill({ status: 503, json: { error: "Alpha test failed" } });
  await expect(page.getByText("Alpha test failed", { exact: true })).toBeVisible();
  await expect(a.getByRole("button", { name: "Test", exact: true })).toBeEnabled();
  await expect(b.getByRole("button", { name: "Testing…", exact: true })).toBeDisabled();
  await expect(b.getByRole("button", { name: "Disconnect", exact: true })).toBeDisabled();
  await tests.get("beta")!.fulfill({ json: { ...beta, online: true, detail: "Connected" } });
  await expect(b).toContainText("Connected");
  await expect(b.getByRole("button", { name: "Test", exact: true })).toBeEnabled();
  await noHorizontalOverflow(page);
});

test("a late computer refresh cannot replace a completed test and a failed refresh cannot undo disconnect", async ({ page }) => {
  let holdList = false;
  let failList = false;
  let refresh: Route | undefined;
  let removal: Route | undefined;
  await computers(page, async (route, path) => {
    if (path === "/api/computers") {
      if (failList) return route.fulfill({ status: 503, json: { error: "Refresh unavailable" } });
      if (holdList) { refresh = route; return; }
      return route.fulfill({ json: [alpha] });
    }
    if (path === "/api/computers/invite") return route.fulfill({ json: { invite: "refreshInvite", command: "test connect command" } });
    if (path.startsWith("/api/computers/invites/")) return route.fulfill({ json: { connected: null, waiting: true } });
    if (path === "/api/computers/alpha/test") return route.fulfill({ json: { ...alpha, online: true, detail: "Connected" } });
    expect(route.request().method()).toBe("DELETE");
    expect(path).toBe("/api/computers/alpha");
    removal = route;
  });
  await page.goto("/#/settings/computers");
  const a = row(page, alpha.label);
  await expect(a).toBeVisible();
  await card(page).getByRole("button", { name: "Connect a computer", exact: true }).click();
  holdList = true;
  await closeConnectDialog(page);
  await expect.poll(() => !!refresh).toBe(true);
  await a.getByRole("button", { name: "Test", exact: true }).click();
  await expect(a).toContainText("Connected");
  await refresh!.fulfill({ json: [alpha] });
  // Wait for the old response to be consumed before checking the status it must preserve.
  await expect(card(page)).toHaveAttribute("aria-busy", "false");
  await expect(a).toContainText("Connected");
  page.once("dialog", (dialog) => dialog.accept());
  await a.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect.poll(() => !!removal).toBe(true);
  await expect(a.getByRole("button", { name: "Disconnecting…", exact: true })).toBeDisabled();
  await expect(a.getByRole("button", { name: "Test", exact: true })).toBeDisabled();
  failList = true;
  await removal!.fulfill({ json: { revoked: false } });
  await expect(card(page).getByRole("alert")).toContainText("Refresh unavailable");
  await expect(a).toHaveCount(0);
  await expect(page.getByText(/Alpha Mac was removed from the list, but it couldn't be reached to remove access/)).toBeVisible();
  await noHorizontalOverflow(page);
});

test("a failed disconnect keeps the computer available for retry", async ({ page }) => {
  let fail = true;
  let listed = [alpha];
  await computers(page, async (route, path) => {
    if (path === "/api/computers") return route.fulfill({ json: listed });
    expect(path).toBe("/api/computers/alpha");
    expect(route.request().method()).toBe("DELETE");
    if (fail) return route.fulfill({ status: 503, json: { error: "Disconnect unavailable" } });
    listed = [];
    return route.fulfill({ json: { revoked: true } });
  });
  await page.goto("/#/settings/computers");
  const a = row(page, alpha.label);
  page.on("dialog", (dialog) => dialog.accept());
  await a.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Disconnect unavailable", { exact: true })).toBeVisible();
  await expect(a.getByRole("button", { name: "Disconnect", exact: true })).toBeEnabled();
  fail = false;
  await a.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(a).toHaveCount(0);
  await expect(page.getByText("Alpha Mac is disconnected and its access was removed.", { exact: true })).toBeVisible();
});

test("computer invites retry creation and polling, disable expired commands, and reconnect an existing computer", async ({ page }) => {
  let failInvite = true;
  let inviteNumber = 0;
  let polls = 0;
  let current = alpha;
  await computers(page, async (route, path) => {
    if (path === "/api/computers") return route.fulfill({ json: [current] });
    if (path === "/api/computers/invite") {
      if (failInvite) return route.fulfill({ status: 503, json: { error: "Invite unavailable" } });
      inviteNumber++;
      return route.fulfill({ json: { invite: `invite${inviteNumber}`, command: `test command ${inviteNumber}` } });
    }
    expect(path).toBe(`/api/computers/invites/invite${inviteNumber}`);
    polls++;
    if (polls === 1) return route.fulfill({ status: 503, json: { error: "Connection check unavailable" } });
    if (inviteNumber === 1) return route.fulfill({ json: { connected: null, waiting: false } });
    current = { ...alpha, online: true, detail: "Connected" };
    return route.fulfill({ json: { connected: current, waiting: false } });
  });
  await page.goto("/#/settings/computers");
  await expect(row(page, alpha.label)).toContainText("Offline");
  await page.clock.install();
  await card(page).getByRole("button", { name: "Connect a computer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a computer", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("Invite unavailable");
  failInvite = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.locator("code")).toHaveText("test command 1");
  await page.clock.fastForward(2600);
  await expect(dialog.getByRole("status")).toContainText("Connection check unavailable");
  await page.clock.fastForward(2600);
  await expect(dialog.getByRole("alert")).toContainText("This command expired.");
  await expect(dialog.getByRole("button", { name: "Copy command", exact: true })).toBeDisabled();
  await page.clock.fastForward(2600);
  expect(polls).toBe(2);
  await dialog.getByRole("button", { name: "Make a new command", exact: true }).click();
  await expect(dialog.locator("code")).toHaveText("test command 2");
  await expect(dialog.getByRole("button", { name: "Copy command", exact: true })).toBeEnabled();
  await page.clock.fastForward(2600);
  await expect(dialog).toContainText("Alpha Mac is connected.");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(row(page, alpha.label)).toContainText("Connected");
  await expect(card(page).locator(".list-row")).toHaveCount(1);
  await noHorizontalOverflow(page);
});

test("copying a computer command handles browsers without clipboard access", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = () => false;
  });
  await computers(page, async (route, path) => {
    if (path === "/api/computers") return route.fulfill({ json: [] });
    if (path === "/api/computers/invite") return route.fulfill({ json: { invite: "clipboardInvite", command: "test clipboard command" } });
    return route.fulfill({ json: { connected: null, waiting: true } });
  });
  await page.goto("/#/settings/computers");
  await card(page).getByRole("button", { name: "Connect a computer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a computer", exact: true });
  await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
  await expect(page.getByText("Couldn't copy. Select the command and copy it instead.", { exact: true })).toBeVisible();
  await expect(dialog.locator("code")).toHaveText("test clipboard command");
});

test("a test started before a same-name reconnect cannot replace the new computer details", async ({ page }) => {
  let current = alpha;
  let pendingTest: Route | undefined;
  await computers(page, async (route, path) => {
    if (path === "/api/computers") return route.fulfill({ json: [current] });
    if (path === "/api/computers/alpha/test") { pendingTest = route; return; }
    if (path === "/api/computers/invite") return route.fulfill({ json: { invite: "reconnectInvite", command: "test reconnect command" } });
    expect(path).toBe("/api/computers/invites/reconnectInvite");
    current = { ...alpha, user: "newowner", online: true, detail: "Connected" };
    return route.fulfill({ json: { connected: current, waiting: false } });
  });
  await page.goto("/#/settings/computers");
  const a = row(page, alpha.label);
  await a.getByRole("button", { name: "Test", exact: true }).click();
  await expect.poll(() => !!pendingTest).toBe(true);
  await page.clock.install();
  await card(page).getByRole("button", { name: "Connect a computer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a computer", exact: true });
  await expect(dialog.locator("code")).toHaveText("test reconnect command");
  await page.clock.fastForward(2600);
  await expect(dialog).toContainText("Alpha Mac is connected.");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(a).toContainText("newowner@100.64.0.2");
  await expect(card(page)).toHaveAttribute("aria-busy", "false");
  await pendingTest!.fulfill({ json: alpha });
  await expect(a.getByRole("button", { name: "Test", exact: true })).toBeEnabled();
  await expect(a).toContainText("newowner@100.64.0.2");
  await expect(a).toContainText("Connected");
});
