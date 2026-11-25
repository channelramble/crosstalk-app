import type { Page, Route } from "@playwright/test";
import type { HubUpdate, UpdateInstall, UpdateStatus } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

// Updates from the app: a newer version is offered on Home and in Settings → Machines, one button downloads it, and the
// update that's ready starts when the chats are quiet (or at Restart now). The machine's answers are played here: the
// test hub runs from its source, which can't update itself, and nothing in these tests asks GitHub anything.

const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;
const onPhone = (page: Page) => page.viewportSize()!.width <= 760;
const NOTES = ["### New", "", "- Updates from the app: one button downloads a new version and starts it when your chats are quiet.", "- A longer line that has to wrap on a phone, with a `code` word and a [link](https://example.com/notes) in it.", ...Array.from({ length: 14 }, (_, i) => `- Fix number ${i + 1}`)].join("\n");

/** CROSSTALK_UPDATE_SHOTS=<folder>: pictures of the banner and the Settings card are kept there. */
async function shot(page: Page, name: string) {
  const dir = process.env.CROSSTALK_UPDATE_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${test.info().project.name}.png` });
}

/**
 * The machine, as far as updates go: what it answers is `status`, which a test moves on with `now` (the app asks how
 * far a download is every second or two).
 */
async function machine(page: Page, start: Partial<UpdateStatus>, origin = "http://127.0.0.1:5198") {
  const at = (path: string) => (url: URL) => url.origin === origin && url.pathname === path;
  // Another machine's answers are read across origins, as its hub allows.
  const headers = origin === "http://127.0.0.1:5198" ? undefined : { "access-control-allow-origin": "http://127.0.0.1:5198" };
  const answer = (route: Route, json: unknown) => (route.request().method() === "OPTIONS" ? route.fallback() : route.fulfill({ json, headers }));
  const m = {
    status: { version: "0.9.1", can: true, why: null, available: null, install: null, notes: null, checkedAt: null, checkFailed: false, ready: null, ...start } as UpdateStatus,
    now(next: Partial<UpdateStatus>) {
      m.status = { ...m.status, ...next };
    },
    /** What Check now finds. */
    found: {} as Partial<UpdateStatus>,
    installs: 0,
    checks: 0,
    restarts: 0,
  };
  // The machine this app opens from is the test hub: its info is its own, with what's played here about updates.
  if (!headers) {
    await page.route(home("/api/state"), async (route) => {
      const snap = await (await route.fetch()).json();
      snap.hub = { ...snap.hub, version: m.status.version, release: { available: m.status.available, install: m.status.install }, update: m.status.ready };
      await route.fulfill({ json: snap });
    });
  }
  await page.route(at("/api/update"), (route) => answer(route, m.status));
  await page.route(at("/api/update/check"), (route) => {
    if (route.request().method() === "POST") {
      m.checks++;
      m.status = { ...m.status, ...m.found };
    }
    return answer(route, m.status);
  });
  await page.route(at("/api/update/install"), (route) => {
    if (route.request().method() === "POST") {
      m.installs++;
      m.status = { ...m.status, install: { version: m.status.available ?? m.status.install?.version ?? "", step: "checking", percent: null } };
    }
    return answer(route, m.status);
  });
  await page.route(at("/api/update/restart"), (route) => {
    if (route.request().method() === "POST") m.restarts++;
    return answer(route, { ok: true });
  });
  return m;
}

const downloading = (percent: number): Partial<UpdateStatus> => ({ install: { version: "0.10.0", step: "downloading", percent } });
const verifying: Partial<UpdateStatus> = { install: { version: "0.10.0", step: "verifying", percent: null } };
const waiting: HubUpdate = { version: "0.10.0", since: Date.now(), working: 1, chats: ["Fix the build"], restarting: false };
const ready: Partial<UpdateStatus> = { install: null, available: null, notes: null, ready: waiting };
const failed = (error: string): Partial<UpdateStatus> => ({ install: { version: "0.10.0", step: "failed", percent: null, error } satisfies UpdateInstall });

/** Every button in `scope` is big enough for a thumb on a phone. */
async function thumbSized(page: Page, scope: ReturnType<Page["locator"]>) {
  if (!onPhone(page)) return;
  for (const b of await scope.getByRole("button").all()) {
    const box = (await b.boundingBox())!;
    expect(Math.round(box.height), await b.innerText()).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
  }
}

test("Home offers a newer version; Update downloads it, shows how far it is, and Restart now starts it", async ({ page }) => {
  const m = await machine(page, { available: "0.10.0", notes: NOTES, checkedAt: Date.now() });
  await page.goto("/#/");
  const card = page.getByRole("region", { name: "Update", exact: true });
  await expect(card.getByRole("status")).toHaveText("Crosstalk 0.10.0 is available.");
  await thumbSized(page, card);
  await noHorizontalOverflow(page);
  await shot(page, "home-available");

  // Tapped twice: one download.
  const update = card.getByRole("button", { name: "Update", exact: true });
  await update.dblclick();
  await expect(card.getByRole("status")).toHaveText("Looking for the update…");
  m.now(downloading(12));
  await expect(card.getByRole("status")).toHaveText("Downloading Crosstalk 0.10.0… 12%", { timeout: 10_000 });
  m.now(downloading(64));
  await expect(card.getByRole("status")).toHaveText("Downloading Crosstalk 0.10.0… 64%", { timeout: 10_000 });
  // While it downloads there's nothing to tap, and nothing to get wrong.
  await expect(card.getByRole("button")).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, "home-downloading");
  m.now(verifying);
  await expect(card.getByRole("status")).toHaveText("Checking the download…", { timeout: 10_000 });
  m.now(ready);
  await expect(card.getByRole("status")).toHaveText("Update 0.10.0 is ready. It starts when the chat that's working is done.", { timeout: 10_000 });
  expect(m.installs).toBe(1);
  await thumbSized(page, card);
  await noHorizontalOverflow(page);
  await shot(page, "home-ready");

  await card.getByRole("button", { name: "Restart now", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("This stops what's working in Fix the build.");
  await dialog.getByRole("button", { name: "Restart now", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(m.restarts).toBe(1);
});

test("Settings → Machines: the version, what's new, Update, its progress, and the update that's ready", async ({ page }) => {
  const m = await machine(page, { available: "0.10.0", notes: NOTES, checkedAt: Date.now() });
  await page.goto("/#/settings/updates");
  const card = page.getByRole("region", { name: "Updates", exact: true });
  await expect(card).toContainText("Crosstalk 0.9.1");
  await expect(card.getByRole("status")).toHaveText("Crosstalk 0.10.0 is available.");
  await expect(card.getByRole("button", { name: "Check now", exact: true })).toBeVisible();
  // What's new: the release's notes, short on the page and scrollable inside.
  const notes = card.getByRole("group", { name: "What's new in 0.10.0" });
  await expect(notes).toContainText("Updates from the app: one button downloads a new version");
  await expect(notes.getByRole("link", { name: "link" })).toHaveAttribute("href", "https://example.com/notes");
  const size = await notes.evaluate((el) => ({ shown: el.clientHeight, all: el.scrollHeight, wide: el.scrollWidth - el.clientWidth }));
  expect(size.shown).toBeLessThanOrEqual(180);
  expect(size.all).toBeGreaterThan(size.shown);
  expect(size.wide).toBeLessThanOrEqual(0);
  await thumbSized(page, card.locator(".machine-update-actions"));
  await noHorizontalOverflow(page);
  await card.scrollIntoViewIfNeeded();
  await shot(page, "settings-available");

  await card.getByRole("button", { name: "Update", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Looking for the update…");
  m.now(downloading(40));
  await expect(card.getByRole("status")).toHaveText("Downloading Crosstalk 0.10.0… 40%", { timeout: 10_000 });
  await expect(card.getByRole("button")).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, "settings-downloading");
  m.now(ready);
  await expect(card.getByRole("status")).toHaveText("Update 0.10.0 is ready. It starts when the chat that's working is done.", { timeout: 10_000 });
  expect(m.installs).toBe(1);
  // Ready: the notes and the offer are gone, and the one thing left to do is not to wait.
  await expect(notes).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveText(["Restart now"]);
  await noHorizontalOverflow(page);
  await shot(page, "settings-ready");
  await card.getByRole("button", { name: "Restart now", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restart now", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(m.restarts).toBe(1);
});

test("up to date: Settings says so after Check now, and Home says nothing", async ({ page }) => {
  const m = await machine(page, {});
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "What agent do you want to use?" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Update", exact: true })).toHaveCount(0);

  await page.goto("/#/settings/updates");
  const card = page.getByRole("region", { name: "Updates", exact: true });
  await expect(card.getByRole("status")).toHaveText("Not checked yet.");
  await expect(card.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  m.found = { checkedAt: Date.now(), checkFailed: false };
  await card.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Up to date. Checked just now.");
  expect(m.checks).toBe(1);
  await thumbSized(page, card);
  await noHorizontalOverflow(page);
  await shot(page, "settings-up-to-date");

  // Check now finds one: it's offered there and then.
  m.found = { available: "0.10.0", notes: NOTES, checkedAt: Date.now() };
  await card.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Crosstalk 0.10.0 is available.");
  await expect(card.getByRole("button", { name: "Update", exact: true })).toBeVisible();
});

test("a machine that can't reach GitHub says it couldn't check where it was asked, and nowhere else", async ({ page }) => {
  const m = await machine(page, { checkFailed: true });
  await page.goto("/#/settings/updates");
  const card = page.getByRole("region", { name: "Updates", exact: true });
  // Nobody asked yet: no complaint.
  await expect(card.getByRole("status")).toHaveText("Not checked yet.");
  m.found = { checkFailed: true };
  await card.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText(/^Couldn't check: .+ couldn't reach GitHub\. It may be offline\.$/);
  // No error notice, and it can be asked again.
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Check now", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, "settings-could-not-check");
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "What agent do you want to use?" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Update", exact: true })).toHaveCount(0);
});

test("a download that fails says why, leaves the offer, and Try again goes through", async ({ page }) => {
  const why = "The download doesn't match its checksum, so nothing was installed. Try again.";
  const m = await machine(page, { available: "0.10.0", checkedAt: Date.now() });
  await page.goto("/#/");
  const card = page.getByRole("region", { name: "Update", exact: true });
  await card.getByRole("button", { name: "Update", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Looking for the update…");
  m.now(failed(why));
  await expect(card.getByRole("status")).toHaveText(`Crosstalk 0.10.0 didn't install. ${why}`, { timeout: 10_000 });
  await thumbSized(page, card);
  await noHorizontalOverflow(page);
  await shot(page, "home-failed");

  // The same in Settings, with the same way on.
  await page.goto("/#/settings/updates");
  const settings = page.getByRole("region", { name: "Updates", exact: true });
  await expect(settings.getByRole("status")).toHaveText(`Crosstalk 0.10.0 didn't install. ${why}`);
  await noHorizontalOverflow(page);
  await settings.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(settings.getByRole("status")).toHaveText("Looking for the update…");
  m.now(ready);
  await expect(settings.getByRole("status")).toHaveText("Update 0.10.0 is ready. It starts when the chat that's working is done.", { timeout: 10_000 });
  expect(m.installs).toBe(2);
});

test("a Crosstalk that can't update itself says why and offers nothing", async ({ page }) => {
  const why = "This Crosstalk runs from its source code, so there's nothing to download: update the code instead.";
  await machine(page, { can: false, why });
  await page.goto("/#/settings/updates");
  const card = page.getByRole("region", { name: "Updates", exact: true });
  await expect(card.getByRole("status")).toHaveText(why);
  await expect(card.getByRole("button")).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test("Later takes the offer off Home on this device; Settings keeps it", async ({ page }) => {
  await machine(page, { available: "0.10.0", checkedAt: Date.now() });
  await page.goto("/#/");
  const card = page.getByRole("region", { name: "Update", exact: true });
  await expect(card.getByRole("status")).toHaveText("Crosstalk 0.10.0 is available.");
  await card.getByRole("button", { name: "Later", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "What agent do you want to use?" })).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.goto("/#/settings/updates");
  await expect(page.getByRole("region", { name: "Updates", exact: true }).getByRole("button", { name: "Update", exact: true })).toBeVisible();
});

test("with several machines each has its own: one is updated without touching the other", async ({ page, token }) => {
  // Both machines' live connections are played here (a real one through the dev server's proxy drops at teardown, and
  // Playwright's stand-in for the other then throws in the page, as polish-machines.spec.ts says).
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const here = await machine(page, { checkedAt: Date.now() });
  const linux = await otherMachine(page, token, { port: 8468 });
  const there = await machine(page, { version: "0.9.1", available: "0.10.0", notes: "- One thing", checkedAt: Date.now() }, linux.base);
  await page.goto("/#/settings/updates");
  const cards = page.locator(".machine-update");
  await expect(cards).toHaveCount(2);
  const other = page.getByRole("region", { name: "Updates for Linux box", exact: true });
  await expect(other.getByRole("status")).toHaveText("Crosstalk 0.10.0 is available.");
  await expect(cards.first().getByRole("status")).toHaveText(/^Up to date\. Checked /);
  await expect(cards.first().getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await thumbSized(page, other.locator(".machine-update-actions"));
  await noHorizontalOverflow(page);
  await other.scrollIntoViewIfNeeded();
  await shot(page, "settings-two-machines");
  await other.getByRole("button", { name: "Update", exact: true }).click();
  await expect(other.getByRole("status")).toHaveText("Looking for the update…");
  there.now(downloading(55));
  await expect(other.getByRole("status")).toHaveText("Downloading Crosstalk 0.10.0… 55%", { timeout: 10_000 });
  there.now({ ...ready, ready: { ...waiting, working: 0, chats: [] } });
  await expect(other.getByRole("status")).toHaveText("Update 0.10.0 is ready. It starts in a moment.", { timeout: 10_000 });
  expect([there.installs, here.installs]).toEqual([1, 0]);
  await expect(cards.first().getByRole("status")).toHaveText(/^Up to date\. Checked /);
});

test("a machine on a version from before updates came from the app says how to get there, with no buttons that could only fail", async ({ page, token }) => {
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  await machine(page, { checkedAt: Date.now() });
  await otherMachine(page, token, { port: 8469 });
  await page.goto("/#/settings/updates");
  const other = page.getByRole("region", { name: "Updates for Linux box", exact: true });
  await expect(other.getByRole("status")).toHaveText("Updates from the app start with a newer version. Run the installer on Linux box once to get it.");
  await expect(other.getByRole("button")).toHaveCount(0);
  await noHorizontalOverflow(page);
});
