import type { Page } from "@playwright/test";
import type { MacCrash, MacDialog, MacStatus } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Settings → This Mac and the strip for a dialog waiting on the Mac's screen (hub/src/mac.ts). What the hub reads on
// the Mac, the dialogs it saw and the last time the Mac went down are played here (the test hub runs on a real Mac,
// whose settings mustn't matter), and nothing is opened on its screen: the test answers /api/mac/open itself.

const STATUS: MacStatus = { fullDiskAccess: false, autoLogin: null, fileVault: false, sleepMinutes: 0, restartsAfterPowerCut: false, wakesForNetwork: true, autoUpdates: true, tailscaleExpiry: Date.parse("2027-04-01T12:00:00Z"), dialogs: [], checkedAt: Date.now() };
const DIALOG: MacDialog = { id: "d1", app: "adb (started by an older Crosstalk)", wants: "files on external drives", since: Date.now() - 14 * 60_000, count: 7 };
const HOUR = 60 * 60_000;
// A USB port's fault restarted the Mac, which then waited at the login screen until someone logged in.
const CRASH: MacCrash = {
  at: Date.now() - 7 * HOUR,
  kind: "crash",
  cause: "a fault on a USB port",
  detail: "dart-usb1 (0xfffffe1f8a3c4000): DART(DARTBLK) error: SID 1 read protect exception on read of DVA 0x10000a12000 (SEG 0 PTE 0x3b) ERROR_SID_SUMMARY 0x00003002 TI…",
  devices: ["Portable SSD (Sabrent)", "Card Reader"],
  backAt: Date.now() - 20 * 60_000,
  waitedMs: 6 * HOUR + 39 * 60_000,
};

/** `gone`: the program asking has exited since (or its number is another program's), so Stop finds nothing to stop. */
async function mac(page: Page, status: MacStatus, dialogs: MacDialog[] = [], { gone = false } = {}) {
  const opened: string[] = [];
  const fixes: string[] = [];
  const stopped: string[] = [];
  const closed: string[] = [];
  const crashDismissed: string[] = [];
  let waiting = [...dialogs];
  let lastCrash = status.lastCrash ?? null;
  // A fix runs in a terminal on the Mac: played as one waiting for the password.
  await page.route("**/api/mac/fix", async (r) => {
    fixes.push((r.request().postDataJSON() as { what: string }).what);
    await r.fulfill({ json: { id: "pty_fix", title: "Automatic login", command: "sudo sysadminctl -autologin set", purpose: "shell", provider: null, alive: true, exitCode: null, createdAt: Date.now() } });
  });
  await page.route("**/api/pty/pty_fix", async (r) => {
    if (r.request().method() === "DELETE") {
      closed.push("pty_fix");
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ json: { info: { id: "pty_fix", title: "Automatic login", command: "sudo", purpose: "shell", provider: null, alive: true, exitCode: null, createdAt: Date.now() }, scrollback: "Password:" } });
  });
  await page.route("**/api/mac/dialogs/*/stop", async (r) => {
    stopped.push(r.request().url());
    if (gone) {
      // As the hub then: nothing stopped, and no Stop for it any more (the question stays listed, for Dismiss).
      waiting = waiting.map((d) => ({ ...d, stoppable: false }));
      return r.fulfill({ status: 409, json: { error: "The program that asked has already stopped. The question may still be on Mac mini's screen; it waits for nothing now.", code: "gone" } });
    }
    waiting = [];
    await r.fulfill({ json: { ...status, dialogs: [], lastCrash } });
  });
  await page.route("**/api/mac", (r) => r.fulfill({ json: { ...status, dialogs: waiting, lastCrash } }));
  await page.route("**/api/mac/open", async (r) => {
    opened.push((r.request().postDataJSON() as { pane: string }).pane);
    await r.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/mac/dialogs/*/dismiss", async (r) => {
    waiting = [];
    await r.fulfill({ json: { ...status, dialogs: [], lastCrash } });
  });
  await page.route("**/api/mac/crash/dismiss", async (r) => {
    crashDismissed.push(r.request().method());
    lastCrash = null;
    await r.fulfill({ json: { ...status, dialogs: waiting, lastCrash } });
  });
  // The dialogs come with the hub's state, as from a Mac hub that saw them; the hub is a Mac's.
  await page.route("**/api/state", async (r) => {
    const res = await r.fetch();
    const json = await res.json();
    await r.fulfill({ json: { ...json, hub: { ...json.hub, platform: "darwin" }, macDialogs: waiting } });
  });
  return { opened, fixes, stopped, closed, crashDismissed };
}

async function shot(page: Page, name: string) {
  const dir = process.env.CT_SHOTS;
  if (!dir || test.info().project.name !== "chromium-390") return;
  await page.locator("#this-mac").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: join(dir, name), animations: "disabled" });
}

test("This Mac says what keeps it from running on its own, and fixes it from here: a terminal there for your password", async ({ page }) => {
  const { opened, fixes, closed } = await mac(page, STATUS);
  await page.goto("/#/settings/this-mac");
  const section = page.locator(".mac-server");
  await expect(page.getByRole("heading", { name: "This Mac", exact: true })).toBeVisible();
  await expect(section).toContainText("Starts again after a restart");
  await expect(section).toContainText("waits at the login screen, and Crosstalk can't start until someone logs in. Turn on automatic login from here");
  await expect(section).toContainText("After a power cut it stays off until someone presses its button");
  await expect(section).toContainText("It never sleeps.");
  await expect(section).toContainText("Never asks about files (optional)");
  await expect(section).toContainText("Only someone at");
  await expect(section.locator('.mac-mark[aria-label="Your choice"]')).toHaveCount(1);
  await expect(section).toContainText("then waits at the login screen (see above)");
  await expect(section).toContainText("Tailscale signs");
  await expect(section.getByRole("link", { name: "Open Tailscale's admin console" })).toHaveAttribute("href", "https://login.tailscale.com/admin/machines");
  await noHorizontalOverflow(page);
  await shot(page, "mac-server.png");
  // Automatic login: a terminal on the Mac, with a field for the password (sent to it, never shown).
  await section.getByRole("button", { name: "Turn on automatic login" }).click();
  const sheet = page.getByRole("dialog", { name: "Turn on automatic login" });
  await expect(sheet).toContainText("once for sudo, then once more for the login itself");
  const password = sheet.getByLabel("Mac password");
  await expect(password).toHaveAttribute("type", "password");
  await password.fill("correct horse");
  await sheet.getByRole("button", { name: "Send" }).click();
  await expect(password).toHaveValue("");
  await shot(page, "mac-fix.png");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => closed).toEqual(["pty_fix"]);
  // Staying on after a power cut: the same, with pmset.
  await section.getByRole("button", { name: "Keep it on" }).click();
  await page.getByRole("dialog", { name: "Keep it on" }).getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => fixes).toEqual(["autologin", "power"]);
  // Full Disk Access can only change at the Mac: its page opens there for when someone is.
  await section.getByRole("button", { name: "Open it in System Settings there" }).click();
  await expect.poll(() => opened).toEqual(["fullDisk"]);
});

test("set up as a server, every row is fine and has no button", async ({ page }) => {
  await mac(page, { ...STATUS, fullDiskAccess: true, autoLogin: "jane", restartsAfterPowerCut: true, tailscaleExpiry: null });
  await page.goto("/#/settings/this-mac");
  const section = page.locator(".mac-server");
  await expect(section).toContainText("logs in as jane by itself");
  await expect(section.locator(".mac-mark.ok")).toHaveCount(5);
  await expect(section).toContainText("its key expiry is off");
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(page.locator(".app")).not.toContainText("the Mac");
});

test("a dialog waiting on the Mac shows on every screen, leads to This Mac, and the program asking can be stopped", async ({ page }) => {
  const { stopped } = await mac(page, STATUS, [{ ...DIALOG, stoppable: true }]);
  await page.goto("/#/rooms");
  const strip = page.locator(".mac-strip");
  await expect(strip.getByRole("status")).toBeVisible();
  await expect(strip).toContainText("is waiting for an answer on its screen.");
  await expect(strip).toContainText("adb (started by an older Crosstalk) wants files on external drives.");
  await noHorizontalOverflow(page);
  if (process.env.CT_SHOTS && test.info().project.name === "chromium-390") await page.screenshot({ path: join(process.env.CT_SHOTS, "mac-strip.png"), animations: "disabled" });
  await strip.getByRole("button", { name: "Details" }).click();
  const waiting = page.locator(".mac-waiting");
  await expect(waiting).toContainText("adb (started by an older Crosstalk) wants files on external drives (asked 7 times) · waiting 14 min");
  await shot(page, "mac-waiting.png");
  // Stopping it asks first.
  await waiting.getByRole("button", { name: "Stop adb" }).click();
  // A second tap right after the first doesn't count (ConfirmButton).
  await page.waitForTimeout(450);
  await waiting.getByRole("button", { name: "Stop it" }).click();
  await expect(page.locator(".mac-waiting")).toHaveCount(0);
  expect(stopped).toHaveLength(1);
  await expect(page.getByText(/adb stopped\. Nothing waits on the question now/)).toBeVisible();
});

test("Details from a tab with unsaved defaults open asks once, then lands on This Mac", async ({ page }) => {
  await mac(page, STATUS, [DIALOG]);
  await page.goto("/#/settings");
  // A half-made change in the tab Settings opens on: leaving it asks, and it asks once, not once per way of getting there.
  const defaults = page.getByRole("group", { name: "New Codex chat defaults", exact: true });
  await defaults.locator("summary").click();
  await defaults.getByRole("radio", { name: "Full access", exact: true }).click();
  await expect(defaults.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  let asks = 0;
  page.on("dialog", (d) => {
    asks++;
    void d.accept();
  });
  await page.locator(".mac-strip").getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("tab", { name: "Machines", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".mac-waiting")).toContainText("adb (started by an older Crosstalk) wants files on external drives");
  expect(asks).toBe(1);
});

test("Stop for a program that has exited since says so, and its row keeps only Dismiss", async ({ page }) => {
  const { stopped } = await mac(page, STATUS, [{ ...DIALOG, stoppable: true }], { gone: true });
  await page.goto("/#/settings/this-mac");
  const waiting = page.locator(".mac-waiting");
  await waiting.getByRole("button", { name: "Stop adb" }).click();
  await page.waitForTimeout(450);
  await waiting.getByRole("button", { name: "Stop it" }).click();
  await expect(page.getByText(/The program that asked has already stopped\./)).toBeVisible();
  expect(stopped).toHaveLength(1);
  // Still listed, but with nothing to stop there's no Stop to tap again.
  await expect(waiting).toContainText("adb (started by an older Crosstalk) wants files on external drives");
  await expect(waiting.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await waiting.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".mac-waiting")).toHaveCount(0);
});

test("a hub that isn't on a Mac has no This Mac", async ({ page }) => {
  await page.route("**/api/state", async (r) => {
    const res = await r.fetch();
    const json = await res.json();
    await r.fulfill({ json: { ...json, hub: { ...json.hub, platform: "linux" } } });
  });
  await page.goto("/#/settings/this-mac");
  // The tab This Mac lives in opens all the same, with the rest of it; only This Mac itself isn't there.
  await expect(page.getByRole("heading", { name: "Machines", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "This Mac", exact: true })).toHaveCount(0);
});

test("one that was answered while the hub wasn't watching can be dismissed", async ({ page }) => {
  await mac(page, STATUS, [DIALOG]);
  await page.goto("/#/settings/this-mac");
  const waiting = page.locator(".mac-waiting");
  await expect(waiting.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await waiting.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".mac-waiting")).toHaveCount(0);
});

test("after a crash This Mac says what happened, what was plugged into that port and what to change, until it's dismissed", async ({ page }) => {
  const { crashDismissed } = await mac(page, { ...STATUS, lastCrash: CRASH });
  await page.goto("/#/settings/this-mac");
  const notice = page.locator(".mac-crash");
  await expect(notice.locator(".mac-row-title")).toHaveText(/ crashed and restarted$/);
  await expect(notice).toContainText(": a fault on a USB port.");
  await expect(notice).toContainText("Plugged into that port when it restarted: Portable SSD (Sabrent) and Card Reader.");
  await expect(notice).toContainText("or into a different port, and leave out cheap hubs and adapters: a fault like this restarts the whole machine.");
  await expect(notice).toContainText("Crosstalk was off for 6 h 40 min, until");
  await expect(notice).toContainText("waited at the login screen for someone to log in.");
  // It points at the row below that fixes that.
  await expect(notice).toContainText("Turn on automatic login below and next time it starts by itself.");
  await expect(page.locator(".mac-server").getByRole("button", { name: "Turn on automatic login" })).toBeVisible();
  await expect(notice).toContainText("macOS said: dart-usb1 (0xfffffe1f8a3c4000): DART(DARTBLK) error");
  await expect(notice).not.toContainText("the Mac");
  // At the top of This Mac, before the rows.
  expect(await page.locator("#this-mac ~ .card").first().evaluate((el) => el.classList.contains("mac-crash"))).toBe(true);
  await noHorizontalOverflow(page);
  await shot(page, "mac-crash.png");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".mac-crash")).toHaveCount(0);
  expect(crashDismissed).toEqual(["POST"]);
  await expect(page.locator(".mac-server")).toContainText("Starts again after a restart");
});

test("a restart without shutting down says it may have lost power or frozen, and that automatic login is on now", async ({ page }) => {
  await mac(page, { ...STATUS, autoLogin: "jane", lastCrash: { at: Date.now() - 2 * HOUR, kind: "power", cause: null, detail: null, devices: [], backAt: Date.now() - HOUR, waitedMs: 50 * 60_000 } });
  await page.goto("/#/settings/this-mac");
  const notice = page.locator(".mac-crash");
  await expect(notice.locator(".mac-row-title")).toHaveText(/ restarted without shutting down$/);
  await expect(notice).toContainText(": it may have lost power or frozen.");
  await expect(notice).toContainText("Crosstalk was off for 1 h, until");
  await expect(notice).toContainText("Automatic login is on now, so next time it starts by itself.");
  await expect(notice).not.toContainText("Plugged into");
  await expect(notice).not.toContainText("macOS said");
  await noHorizontalOverflow(page);
});
