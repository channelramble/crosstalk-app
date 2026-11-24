import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";

test("Carry on when the limit resets saves at once and persists; the pause switch is gone and what was saved for it is left alone", async ({ page, request, token }) => {
  const url = "http://127.0.0.1:8451/api/settings/hub";
  const headers = { authorization: `Bearer ${token}` };
  const before = await (await request.get(url, { headers })).json();
  try {
    await page.goto("/#/settings/usage");
    // The plan meters are on this page now, not behind a button to another screen.
    await expect(page.getByRole("region", { name: "Plan limits", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View usage for every account", exact: true })).toHaveCount(0);
    const card = page.getByRole("region", { name: "Usage preferences", exact: true });
    const toggle = card.getByRole("checkbox", { name: "Carry on when the limit resets", exact: true });
    await expect(toggle).toBeChecked();
    // One switch: "Pause near usage limits" is a fixed default now.
    await expect(card.getByRole("checkbox")).toHaveCount(1);
    await expect(page.getByText("Pause near usage limits")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await toggle.uncheck();
    await expect(toggle).toBeEnabled();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).carryOnAfterLimit).toBe(false);
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeEnabled();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).carryOnAfterLimit).toBe(true);
    expect((await (await request.get(url, { headers })).json()).pauseNearLimit).toBe(before.pauseNearLimit);
  } finally {
    await request.put(url, { headers, data: { carryOnAfterLimit: before.carryOnAfterLimit ?? true } });
  }
});

test("usage preferences recover from load and save errors", async ({ page }) => {
  let failLoad = true;
  let failSave = true;
  let saved = true;
  await page.route("**/api/settings/hub", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(failLoad ? { status: 503, json: { error: "Preferences unavailable" } } : { json: { pauseNearLimit: false, carryOnAfterLimit: saved } });
    }
    if (failSave) return route.fulfill({ status: 503, json: { error: "Try again" } });
    saved = route.request().postDataJSON().carryOnAfterLimit;
    return route.fulfill({ json: { pauseNearLimit: false, carryOnAfterLimit: saved } });
  });
  await page.goto("/#/settings/usage");
  const card = page.getByRole("region", { name: "Usage preferences", exact: true });
  await expect(card.getByRole("alert")).toContainText("Preferences unavailable");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  failLoad = false;
  await card.getByRole("button", { name: "Retry usage preferences" }).click();
  const toggle = card.getByRole("checkbox", { name: "Carry on when the limit resets", exact: true });
  await expect(toggle).toBeChecked();
  // The failed save immediately rolls back, so don't require the click to leave it unchecked.
  await toggle.click();
  await expect(card.getByRole("alert")).toContainText("Couldn't save: Try again");
  await expect(toggle).toBeChecked();
  failSave = false;
  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await noHorizontalOverflow(page);
});

// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const hubSettings = () => ({
  machineName: "",
  agentsAcrossChats: false,
  pauseNearLimit: false,
  teamwork: { enabled: true, perReply: 1, skipAbovePercent: 80, helper: { claude: { model: "claude-sonnet", effort: "low" }, codex: { model: null, effort: null } } },
  storage: { autoClean: true, lowSpaceGb: 15 },
});
const models = (page: import("@playwright/test").Page) =>
  Promise.all([
    page.route("**/api/providers/claude/models*", (route) => route.fulfill({ json: { provider: "claude", live: true, models: [{ id: "claude-opus", label: "Opus 5.5", isDefault: true, efforts: ["low", "high"] }, { id: "claude-sonnet", label: "Sonnet", efforts: ["low", "high"] }] } })),
    page.route("**/api/providers/codex/models*", (route) => route.fulfill({ json: { provider: "codex", live: true, models: [{ id: "gpt-big", label: "GPT Big", isDefault: true, efforts: ["low", "high"] }, { id: "gpt-mini", label: "GPT Mini", efforts: ["low"] }] } })),
  ]);

// Settings → Agents together itself (who does helper work, quick questions, other chats) is in helpersOn.spec.ts.

test("with /api/settings/hub failing, quick questions and cross-chat say so, and Retry recovers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  let socket: import("@playwright/test").WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });
  });
  await page.route("**/api/settings/hub", (route) => route.fulfill(fail ? { status: 503, json: { error: "Crosstalk is restarting." } } : { json: hubSettings() }));
  await models(page);
  await page.goto("/#/settings/teamwork");
  const teamwork = page.getByRole("region", { name: "Let agents ask another agent a quick question", exact: true });
  await expect(teamwork.getByRole("alert")).toContainText("Couldn't load this setting: Crosstalk is restarting.");
  const cross = page.getByRole("region", { name: "Let agents reach your other chats", exact: true });
  await expect(cross.getByRole("alert")).toContainText("Couldn't load this setting: Crosstalk is restarting.");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("settings-load-failed.png"), animations: "disabled" });
  // Storage, on the Machines page, says the same rather than showing nothing.
  await settingsTab(page, "Machines");
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't load the cleanup settings" })).toContainText("Crosstalk is restarting.");

  await settingsTab(page, "Agents together");
  await expect(teamwork.getByRole("alert")).toContainText("Couldn't load this setting: Crosstalk is restarting.");
  fail = false;
  await teamwork.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(teamwork.getByRole("checkbox", { name: "Let agents ask another agent a quick question", exact: true })).toBeChecked();
  // The other comes back by itself once the machine is back.
  await expect.poll(() => !!socket).toBe(true);
  await socket!.close({ code: 1012, reason: "Browser test restart" });
  await expect(cross.getByRole("checkbox", { name: "Let agents reach your other chats", exact: true })).not.toBeChecked();
  await expect(cross.getByRole("alert")).toHaveCount(0);
  // Storage's line, once it can be read: what the machine does on its own, with no switch to set.
  await settingsTab(page, "Machines");
  const storage = page.locator(".storage-fixed");
  await expect(storage).toContainText("clears tool caches and unused installed dependencies on its own");
  await expect(storage).toContainText("You're warned when less than 15 GB is free.");
  await expect(page.getByRole("checkbox", { name: "Clear caches on its own", exact: true })).toHaveCount(0);
});

test("with another machine picked, the Notifications card says notifications come through the home machine", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { otherMachine, pong } = await import("./otherMachine");
  const linux = await otherMachine(page, token, { port: 8452 });
  // Both machines' live updates are played here (a real one closed while connecting trips Playwright's stand-in).
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const home = (await (await request.get("http://127.0.0.1:8451/api/state", { headers: { authorization: `Bearer ${token}` } })).json()).hub.name as string;
  let links: unknown[] = [{ id: "h_linux", name: "Linux box", url: linux.base, addedAt: Date.now(), scope: "full", agents: "one-way", error: null, introducedBy: null }];
  await page.route((url) => url.origin === "http://127.0.0.1:5198" && url.pathname === "/api/machines", (route) => route.fulfill({ json: links }));
  await page.goto("/#/settings/devices");
  const card = page.getByRole("region", { name: "Notifications on this device", exact: true });
  // The machine the app opens from: nothing to explain.
  await expect(card).toBeVisible();
  await expect(card.getByRole("note")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption(linux.key);
  await expect(card.getByRole("note")).toHaveText(`Notifications from Linux box come through ${home}: turning them on here covers both.`);
  await card.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("notifications-come-through.png"), animations: "disabled" });
  // Not linked with it: its notifications can't come through, and it says what to do.
  links = [];
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption("");
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption(linux.key);
  await expect(card.getByRole("note")).toContainText(`Notifications from Linux box don't reach this device: Linux box isn't linked with ${home}. Link it in Settings → Machines`);
});

test("the Notifications card says when it couldn't check, and Retry recovers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  await page.route("**/api/push/key", async (route) => (fail ? route.fulfill({ status: 503, json: { error: "Crosstalk is restarting." } }) : route.continue()));
  await page.goto("/#/settings/devices");
  const supported = await page.evaluate(() => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
  test.skip(!supported, "This browser engine has no push");
  const card = page.getByRole("region", { name: "Notifications on this device", exact: true });
  // Not a grey button with no reason: what went wrong, and Retry.
  await expect(card.getByRole("alert")).toContainText("Couldn't check notifications on");
  await expect(card.getByRole("alert")).toContainText("Crosstalk is restarting.");
  await card.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("notifications-check-failed.png"), animations: "disabled" });
  fail = false;
  await card.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(card.getByRole("button", { name: "Turn on notifications", exact: true })).toBeEnabled();
});

test("a teamwork change that couldn't be saved goes back, and says so", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let failSave = true;
  let hub = hubSettings();
  await page.route("**/api/settings/hub", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: hub });
    if (failSave) return route.fulfill({ status: 503, json: { error: "Crosstalk is restarting." } });
    hub = { ...hub, ...route.request().postDataJSON() };
    return route.fulfill({ json: hub });
  });
  await models(page);
  await page.goto("/#/settings/teamwork");
  const teamwork = page.getByRole("region", { name: "Let agents ask another agent a quick question", exact: true });
  const toggle = teamwork.getByRole("checkbox", { name: "Let agents ask another agent a quick question", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  // What's shown is what agents get: back on, with why and what to do.
  await expect(teamwork.getByRole("alert")).toHaveText("Couldn't save: Crosstalk is restarting. Change it again to retry.");
  await expect(toggle).toBeChecked();
  failSave = false;
  await toggle.click();
  await expect(teamwork.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => hub.teamwork.enabled).toBe(false);
  await expect(toggle).not.toBeChecked();
});
