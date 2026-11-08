import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";

test("usage pause starts off, saves immediately, and persists on and off", async ({ page, request, token }) => {
  const url = "http://127.0.0.1:8451/api/settings/hub";
  const headers = { authorization: `Bearer ${token}` };
  await request.put(url, { headers, data: { pauseNearLimit: false } });
  try {
    await page.goto("/#/settings/usage");
    const card = page.getByRole("region", { name: "Usage preferences", exact: true });
    const toggle = card.getByRole("checkbox", { name: "Pause near usage limits", exact: true });
    await expect(toggle).not.toBeChecked();
    await expect(card).toContainText("90%");
    await noHorizontalOverflow(page);
    await toggle.check();
    await expect(toggle).toBeEnabled();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).pauseNearLimit).toBe(true);
    await page.reload();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).toBeEnabled();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).pauseNearLimit).toBe(false);
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByRole("button", { name: "View usage for every account", exact: true })).toBeVisible();
  } finally {
    await request.put(url, { headers, data: { pauseNearLimit: false } });
  }
});

test("usage preferences recover from load and save errors", async ({ page }) => {
  let failLoad = true;
  let failSave = true;
  let saved = false;
  await page.route("**/api/settings/hub", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(failLoad ? { status: 503, json: { error: "Preferences unavailable" } } : { json: { pauseNearLimit: saved } });
    }
    if (failSave) return route.fulfill({ status: 503, json: { error: "Try again" } });
    saved = route.request().postDataJSON().pauseNearLimit;
    return route.fulfill({ json: { pauseNearLimit: saved } });
  });
  await page.goto("/#/settings/usage");
  const card = page.getByRole("region", { name: "Usage preferences", exact: true });
  await expect(card.getByRole("alert")).toContainText("Preferences unavailable");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  failLoad = false;
  await card.getByRole("button", { name: "Retry usage preferences" }).click();
  const toggle = card.getByRole("checkbox", { name: "Pause near usage limits", exact: true });
  await expect(toggle).not.toBeChecked();
  // The failed save immediately rolls back, so don't require the click to leave it checked.
  await toggle.click();
  await expect(card.getByRole("alert")).toContainText("Couldn't save: Try again");
  await expect(toggle).not.toBeChecked();
  failSave = false;
  await toggle.check();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
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

test("teamwork picks show in their rows and save without a Save tap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let hub = hubSettings();
  const puts: { teamwork: typeof hub.teamwork }[] = [];
  await page.route("**/api/settings/hub", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      if (body.teamwork) puts.push(body);
      hub = { ...hub, ...body };
    }
    return route.fulfill({ json: hub });
  });
  await models(page);
  await page.goto("/#/settings/teamwork");
  const teamwork = page.getByRole("region", { name: "Teamwork", exact: true });
  const claude = teamwork.getByRole("group", { name: "Claude Code helper model", exact: true });
  const codex = teamwork.getByRole("group", { name: "Codex helper model", exact: true });
  // What each one answers with, without opening the rows.
  await expect(claude.locator(".defaults-picks")).toHaveText("Sonnet · Low effort");
  await expect(codex.locator(".defaults-picks")).toHaveText("Codex's default model (GPT Big)");
  await expect(teamwork.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(teamwork).toContainText("Changes save as you make them.");
  await claude.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("teamwork-rows.png"), animations: "disabled" });

  // A change in a row saves by itself.
  await codex.locator("summary").click();
  await codex.getByRole("combobox", { name: "Model", exact: true }).selectOption("gpt-mini");
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].teamwork.helper.codex).toEqual({ model: "gpt-mini", effort: null });
  await expect(codex.locator(".defaults-picks")).toHaveText("GPT Mini");
  // A burst of + taps saves once, with the last value.
  await teamwork.getByRole("button", { name: "Increase Questions per reply", exact: true }).click();
  await teamwork.getByRole("button", { name: "Increase Questions per reply", exact: true }).click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1].teamwork.perReply).toBe(3);
  // Leaving right after a change doesn't lose it.
  await teamwork.getByRole("button", { name: "Decrease Questions per reply", exact: true }).click();
  await page.evaluate(() => { location.hash = "#/usage"; });
  await expect(page.locator(".topbar h1")).toHaveText("Usage");
  await expect.poll(() => puts.length).toBe(3);
  expect(puts[2].teamwork.perReply).toBe(2);
});

test("with /api/settings/hub failing, Teamwork and cross-chat say so, and Retry recovers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  let socket: import("@playwright/test").WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });
  });
  await page.route("**/api/settings/hub", (route) => route.fulfill(fail ? { status: 503, json: { error: "The hub is restarting." } } : { json: hubSettings() }));
  await models(page);
  await page.goto("/#/settings/teamwork");
  const teamwork = page.getByRole("alert").filter({ hasText: "Couldn't load teamwork settings" });
  await expect(teamwork).toContainText("Couldn't load teamwork settings: The hub is restarting.");
  const cross = page.getByRole("region", { name: "Let agents reach your other chats", exact: true });
  await expect(cross.getByRole("alert")).toContainText("Couldn't load this setting: The hub is restarting.");
  await teamwork.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("settings-load-failed.png"), animations: "disabled" });
  // Storage, in the Machines tab, says the same rather than showing nothing.
  await settingsTab(page, "Machines");
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't load the cleanup settings" })).toContainText("The hub is restarting.");

  await settingsTab(page, "Agents");
  await expect(teamwork).toContainText("Couldn't load teamwork settings: The hub is restarting.");
  // A half-made change to the new-chat defaults, in this tab: the cards beside it failing, retrying and coming back
  // (they load the same /api/settings/hub) must not reset it.
  const defaults = page.getByRole("group", { name: "New Codex chat defaults", exact: true });
  await defaults.locator("summary").click();
  const full = defaults.getByRole("radio", { name: "Full access", exact: true });
  await full.click();
  const save = defaults.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  fail = false;
  await teamwork.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("region", { name: "Teamwork", exact: true }).getByRole("checkbox", { name: "Let agents ask each other for help", exact: true })).toBeChecked();
  // The others come back by themselves once the machine is back.
  await expect.poll(() => !!socket).toBe(true);
  await socket!.close({ code: 1012, reason: "Browser test restart" });
  await expect(cross.getByRole("checkbox", { name: "Let agents reach your other chats", exact: true })).not.toBeChecked();
  await expect(cross.getByRole("alert")).toHaveCount(0);
  // Still chosen, still waiting to be saved.
  await expect(full).toBeChecked();
  await expect(save).toBeEnabled();
  // Leaving the tab with it asks first (settingsTabs.spec.ts); saying yes moves on.
  page.once("dialog", (d) => void d.accept());
  await settingsTab(page, "Machines");
  await expect(page.getByRole("checkbox", { name: "Clear caches on its own", exact: true })).toBeChecked();
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

test("teamwork doesn't save what its options correct by themselves, only what you change", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Saved with an effort its model doesn't take: the row shows it corrected, but nothing is saved for that alone.
  let hub = { ...hubSettings(), teamwork: { ...hubSettings().teamwork, helper: { claude: { model: "claude-sonnet", effort: "low" }, codex: { model: "gpt-mini", effort: "high" } } } };
  const puts: { teamwork: typeof hub.teamwork }[] = [];
  await page.route("**/api/settings/hub", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      if (body.teamwork) puts.push(body);
      hub = { ...hub, ...body };
    }
    return route.fulfill({ json: hub });
  });
  await models(page);
  await page.goto("/#/settings/teamwork");
  const teamwork = page.getByRole("region", { name: "Teamwork", exact: true });
  await expect(teamwork.getByRole("group", { name: "Codex helper model", exact: true }).locator(".defaults-picks")).toHaveText("GPT Mini");
  await page.waitForTimeout(1200);
  expect(puts).toEqual([]);
  // Your change saves, with the correction in it.
  await teamwork.getByRole("button", { name: "Increase Questions per reply", exact: true }).click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].teamwork).toMatchObject({ perReply: 2, helper: { codex: { model: "gpt-mini", effort: null } } });
});

test("the Notifications card says when it couldn't check, and Retry recovers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  await page.route("**/api/push/key", async (route) => (fail ? route.fulfill({ status: 503, json: { error: "The hub is restarting." } }) : route.continue()));
  await page.goto("/#/settings/devices");
  const supported = await page.evaluate(() => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
  test.skip(!supported, "This browser engine has no push");
  const card = page.getByRole("region", { name: "Notifications on this device", exact: true });
  // Not a grey button with no reason: what went wrong, and Retry.
  await expect(card.getByRole("alert")).toContainText("Couldn't check notifications on");
  await expect(card.getByRole("alert")).toContainText("The hub is restarting.");
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
    if (failSave) return route.fulfill({ status: 503, json: { error: "The hub is restarting." } });
    hub = { ...hub, ...route.request().postDataJSON() };
    return route.fulfill({ json: hub });
  });
  await models(page);
  await page.goto("/#/settings/teamwork");
  const teamwork = page.getByRole("region", { name: "Teamwork", exact: true });
  const questions = teamwork.getByRole("group", { name: "Questions per reply", exact: true });
  await expect(questions.locator("output")).toHaveText("1");
  await questions.getByRole("button", { name: "Increase Questions per reply", exact: true }).click();
  // What's shown is what agents get: back to 1, with why and what to do.
  await expect(teamwork.getByRole("alert")).toHaveText("Couldn't save: The hub is restarting. Change it again to retry.");
  await expect(questions.locator("output")).toHaveText("1");
  failSave = false;
  await questions.getByRole("button", { name: "Increase Questions per reply", exact: true }).click();
  await expect(teamwork.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => hub.teamwork.perReply).toBe(2);
  await expect(questions.locator("output")).toHaveText("2");
});
