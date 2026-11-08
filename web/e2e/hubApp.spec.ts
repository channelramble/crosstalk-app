import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// The Crosstalk Hub app's window (native/hub-tray/ui), at every width. The page talks only to the app through
// window.__TAURI__, which is played here: each command answers from a fixture and is recorded, and events (the hub's
// status every few seconds, the installer's output) are sent by the test. Nothing reaches a service or a hub.

const UI = fileURLToPath(new URL("../../native/hub-tray/ui", import.meta.url));
const WINDOW_MIN_WIDTH = (JSON.parse(readFileSync(fileURLToPath(new URL("../../native/hub-tray/src-tauri/tauri.conf.json", import.meta.url)), "utf8")) as { app: { windows: { minWidth: number }[] } }).app.windows[0].minWidth;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const ACTIONS = { open: false, pair: false, start: false, stop: false, restart: false, restartNow: false, cancelRestart: false, install: false, logs: true };
const RUNNING = {
  state: "running",
  tone: "ok",
  title: "Running",
  detail: "It starts by itself at the next login and comes back if it stops.",
  version: "0.4.1",
  installedVersion: "0.4.1",
  updateWaiting: false,
  port: 7420,
  address: "http://127.0.0.1:7420",
  publicUrl: "https://mini.example.ts.net",
  openUrl: "https://mini.example.ts.net",
  service: "LaunchAgent com.crosstalk.hub",
  serviceFile: "/Users/someone/Library/LaunchAgents/com.crosstalk.hub.plist",
  bin: "/Users/someone/.local/bin/crosstalk-hub",
  dataHome: "/Users/someone/.crosstalk",
  pid: 4242,
  restart: null,
  actions: { ...ACTIONS, open: true, pair: true, stop: true, restart: true, restartNow: true },
  os: "mac",
  fake: false,
  checkedAt: 0,
};
const STOPPED = { ...RUNNING, state: "stopped", tone: "off", title: "Stopped", detail: "Phones can't reach it. It starts again when you tap Start, or at the next login.", version: null, pid: null, actions: { ...ACTIONS, start: true } };
const NOT_INSTALLED = { ...STOPPED, state: "notInstalled", title: "Not installed", detail: "Crosstalk isn't set up on this computer yet.", installedVersion: null, publicUrl: null, openUrl: "http://127.0.0.1:7420", actions: { ...ACTIONS, install: true, logs: false } };
const QR = '<?xml version="1.0" standalone="yes"?><svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#fff"/></svg>';
const CODE = { code: "H24X-C77J", expiresAt: Date.parse("2026-10-28T17:30:00Z"), base: "https://mini.example.ts.net", link: "https://mini.example.ts.net/#pair=H24X-C77J", qrSvg: QR };
const PLAN = {
  possible: true,
  whyNot: null,
  serviceOnly: false,
  steps: ["Copies the hub to ~/.local/bin/crosstalk-hub.", "Adds a background service (~/Library/LaunchAgents/com.crosstalk.hub.plist) that starts the hub when you log in."],
  choices: [
    { id: "tailscale", label: "Reach it from your phone", detail: "Publishes it to your own Tailscale devices over HTTPS.", on: true },
    { id: "power", label: "Keep the Mac awake", detail: "Stops sleep and restarts after a power cut (pmset). macOS asks for your password.", on: true },
  ],
};

interface Fake {
  answers: Record<string, unknown>;
  /** Commands that fail, with the app's Problem ({ message, fix }). */
  fail?: Record<string, { message: string; fix: string | null }>;
}

/** Opens the window's page with the app played by `fake`. Returns the commands it was asked, in order. */
async function openApp(page: Page, fake: Fake) {
  // The window is never narrower than its minWidth (native/hub-tray/src-tauri/tauri.conf.json): at the 320 px
  // projects, try it at that width.
  const size = page.viewportSize();
  if (size && size.width < WINDOW_MIN_WIDTH) await page.setViewportSize({ width: WINDOW_MIN_WIDTH, height: size.height });
  await page.route("http://hub-app.test/**", (r) => {
    const file = new URL(r.request().url()).pathname.replace(/^\//, "") || "index.html";
    return r.fulfill({ body: readFileSync(join(UI, file)), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
  });
  await page.addInitScript((fake: Fake) => {
    const w = window as unknown as Record<string, unknown>;
    const calls: [string, unknown][] = [];
    const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
    w.__calls = calls;
    w.__answers = fake.answers;
    w.__fail = fake.fail ?? {};
    w.__emit = (name: string, payload: unknown) => (listeners[name] ?? []).forEach((cb) => cb({ payload }));
    w.__TAURI__ = {
      core: {
        invoke: async (cmd: string, args?: unknown) => {
          calls.push([cmd, args ?? null]);
          const fail = (w.__fail as Record<string, unknown>)[cmd];
          if (fail) throw fail;
          return (w.__answers as Record<string, unknown>)[cmd] ?? null;
        },
      },
      event: {
        listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
          (listeners[name] ??= []).push(cb);
          return () => {};
        },
      },
    };
  }, fake);
  await page.goto("http://hub-app.test/index.html");
  return {
    calls: () => page.evaluate(() => (window as unknown as { __calls: [string, unknown][] }).__calls.map(([c]) => c)),
    emit: (name: string, payload: unknown) => page.evaluate(([n, p]) => (window as unknown as { __emit: (n: string, p: unknown) => void }).__emit(n as string, p), [name, payload] as const),
    answer: (cmd: string, value: unknown) => page.evaluate(([c, v]) => ((window as unknown as { __answers: Record<string, unknown> }).__answers[c as string] = v), [cmd, value] as const),
    fail: (cmd: string, problem: { message: string; fix: string | null } | null) =>
      page.evaluate(([c, p]) => ((window as unknown as { __fail: Record<string, unknown> }).__fail[c as string] = p ?? undefined), [cmd, problem] as const),
  };
}

const base = (status: unknown = RUNNING) => ({
  status,
  app_info: { version: "0.4.1", os: "mac", trial: false, tray: true, service: "LaunchAgent com.crosstalk.hub" },
  login_item: { state: "on", trial: false },
  take_opening: { view: null, notice: null },
  pair: CODE,
  logs: { hub: "17:00:00.000 INFO  [main] Crosstalk hub 0.4.1 · data in /Users/someone/.crosstalk", hubSource: "/Users/someone/Library/Logs/Crosstalk/hub.log", watcher: null, watcherSource: "", problem: null },
  install_plan: PLAN,
  start: "Starting…",
  stop: "Stopped.",
  restart_when_quiet: "It restarts once it has been quiet for five minutes: no replies running and no helpers writing.",
  restart_now: "Restarting…",
  set_login_item: { state: "off", trial: false },
});

test("a running hub: how it is, its address and what can be done", async ({ page }) => {
  const app = await openApp(page, { answers: base() });
  await expect(page.getByRole("heading", { name: "Running" })).toBeVisible();
  await expect(page.getByText("0.4.1", { exact: true })).toBeVisible();
  await expect(page.getByText("https://mini.example.ts.net", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Crosstalk" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pair a phone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop…" })).toBeVisible();
  // Nothing that doesn't apply now.
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Install Crosstalk…" })).toBeHidden();
  await expect(page.getByRole("switch", { name: /Start this app at login/ })).toBeChecked();
  await noHorizontalOverflow(page);

  // A status event a few seconds later changes it in place.
  await app.emit("status", STOPPED);
  await expect(page.getByRole("heading", { name: "Stopped" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop…" })).toBeHidden();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(app.calls).toContain("start");
  await expect(page.getByRole("status").filter({ hasText: "Starting…" })).toBeVisible();
});

test("Stop asks twice before it stops anything", async ({ page }) => {
  const app = await openApp(page, { answers: base() });
  await page.getByRole("button", { name: "Stop…" }).click();
  await expect(page.getByRole("heading", { name: "Stop Crosstalk?" })).toBeVisible();
  await expect(page.getByText("Your phone can't reach Crosstalk until you tap Start here, or until the next login.")).toBeVisible();
  await page.getByRole("button", { name: "Stop Crosstalk", exact: true }).click();
  await expect(page.getByText("Are you sure? Agents replying now are cut off.")).toBeVisible();
  await noHorizontalOverflow(page);
  expect(await app.calls()).not.toContain("stop");
  await page.getByRole("button", { name: "Yes, stop it" }).click();
  await expect.poll(app.calls).toContain("stop");
  await expect(page.getByRole("heading", { name: "Running" })).toBeVisible();

  // Backing out at either step stops nothing.
  await page.getByRole("button", { name: "Stop…" }).click();
  await page.getByRole("button", { name: "Keep it running" }).click();
  expect((await app.calls()).filter((c) => c === "stop")).toHaveLength(1);
});

test("Restart waits for quiet first; Restart now asks again", async ({ page }) => {
  const app = await openApp(page, { answers: base() });
  await page.getByRole("button", { name: "Restart…" }).click();
  await expect(page.getByRole("heading", { name: "Restart Crosstalk" })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "Restart when it's quiet" }).click();
  await expect.poll(app.calls).toContain("restart_when_quiet");

  // Waiting: it says so, and it can be cancelled instead of started again.
  await app.emit("status", { ...RUNNING, restart: { pid: 900, ownGroup: true, script: "restart-when-idle.sh", waited: 125 }, actions: { ...RUNNING.actions, restart: false, cancelRestart: true } });
  await expect(page.getByText("Waiting for five quiet minutes (2 minutes so far)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel the waiting restart" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart…" })).toBeHidden();

  await app.emit("status", RUNNING);
  await page.getByRole("button", { name: "Restart…" }).click();
  await page.getByRole("button", { name: "Restart now…" }).click();
  await expect(page.getByText("Restart now? Agents replying now are cut off.")).toBeVisible();
  expect(await app.calls()).not.toContain("restart_now");
  await page.getByRole("button", { name: "Yes, restart now" }).click();
  await expect.poll(app.calls).toContain("restart_now");
});

test("with a restart waiting, Stop and Restart now say they cancel it", async ({ page }) => {
  const waiting = { ...RUNNING, restart: { pid: 900, ownGroup: true, script: "restart-when-idle.sh", waited: 125 }, actions: { ...RUNNING.actions, restart: false, cancelRestart: true } };
  const app = await openApp(page, { answers: { ...base(waiting), stop: "Stopped. The waiting restart is cancelled." } });
  const note = (view: string) => page.getByRole("region", { name: view }).getByText("It also cancels the waiting restart.");
  await page.getByRole("button", { name: "Stop…" }).click();
  await page.getByRole("button", { name: "Stop Crosstalk", exact: true }).click();
  await expect(note("Stop Crosstalk?")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "Keep it running" }).click();

  // Home offers Restart now… while one waits (not Restart…), and its last step says the same.
  await page.getByRole("button", { name: "Restart now…" }).click();
  await page.getByRole("button", { name: "Restart now…" }).click();
  await expect(note("Restart Crosstalk")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Stop…" }).click();
  await page.getByRole("button", { name: "Stop Crosstalk", exact: true }).click();
  await page.getByRole("button", { name: "Yes, stop it" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Stopped. The waiting restart is cancelled." })).toBeVisible();

  // Nothing waiting: nothing about it.
  await app.emit("status", RUNNING);
  await page.getByRole("button", { name: "Stop…" }).click();
  await page.getByRole("button", { name: "Stop Crosstalk", exact: true }).click();
  await expect(note("Stop Crosstalk?")).toBeHidden();
});

test("Pair a phone: a one-time code, its QR and when it expires", async ({ page }) => {
  const app = await openApp(page, { answers: base() });
  await page.getByRole("button", { name: "Pair a phone" }).click();
  await expect(page.getByRole("heading", { name: "Pair a phone" })).toBeVisible();
  await expect(page.getByLabel("Pairing code")).toHaveText("H24X-C77J");
  await expect(page.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
  await expect(page.getByText(/^Works once · expires at /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  await noHorizontalOverflow(page);

  // Not on Tailscale: the code, and why a phone can't use it yet; no QR to a place it can't reach.
  await app.answer("pair", { ...CODE, base: null, link: null, qrSvg: null });
  await page.getByRole("button", { name: "Make another" }).click();
  await expect(page.getByText(/This hub isn't on your Tailscale network yet/)).toBeVisible();
  await expect(page.getByRole("img", { name: "Pairing QR code" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeHidden();
  expect((await app.calls()).filter((c) => c === "pair")).toHaveLength(2);
});

test("an error says what happened and offers a way out", async ({ page }) => {
  const app = await openApp(page, {
    answers: base(STOPPED),
    fail: { start: { message: "macOS didn't let the hub start. If Crosstalk is switched off under Login Items & Extensions (Allow in the Background), switch it on, then tap Start again.", fix: "loginItems" } },
  });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("macOS didn't let the hub start.");
  await expect(alert.getByRole("button", { name: "Open Login Items" })).toBeVisible();
  await noHorizontalOverflow(page);
  await alert.getByRole("button", { name: "Open Login Items" }).click();
  await expect.poll(app.calls).toContain("open_login_items");
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toBeHidden();

  // A refusal the log explains goes to the log; anything can be tried again.
  await app.fail("start", { message: "Starting didn't work: Bootstrap failed: 37: Operation already in progress", fix: "logs" });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect.poll(async () => (await app.calls()).filter((c) => c === "start").length).toBe(3);
  await alert.getByRole("button", { name: "Show logs" }).click();
  await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible();
  await expect(page.getByLabel("The hub's log")).toContainText("Crosstalk hub 0.4.1");
});

test("Try again after a failed Stop or Restart now asks again, and an old error doesn't wait for later", async ({ page }) => {
  const app = await openApp(page, { answers: base(), fail: { restart_now: { message: "Restarting didn't work: exit 5", fix: "logs" } } });
  const count = async (cmd: string) => (await app.calls()).filter((c) => c === cmd).length;
  await page.getByRole("button", { name: "Restart…" }).click();
  await page.getByRole("button", { name: "Restart now…" }).click();
  await page.getByRole("button", { name: "Yes, restart now" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Restarting didn't work");
  // Later, from home: Try again goes back to the last step instead of restarting at once.
  await page.getByRole("button", { name: "‹ Back" }).first().click();
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Restart now? Agents replying now are cut off.")).toBeVisible();
  expect(await count("restart_now")).toBe(1);
  await noHorizontalOverflow(page);

  await app.answer("take_opening", { view: "home", notice: null });
  await app.fail("stop", { message: "Stopping didn't work: exit 5", fix: "logs" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Stop…" }).click();
  await page.getByRole("button", { name: "Stop Crosstalk", exact: true }).click();
  await page.getByRole("button", { name: "Yes, stop it" }).click();
  await expect(alert).toContainText("Stopping didn't work");
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Are you sure? Agents replying now are cut off.")).toBeVisible();
  expect(await count("stop")).toBe(1);

  // Hidden to the menu bar: the error and the half-made choice go.
  await page.getByRole("button", { name: "Yes, stop it" }).click();
  await expect(alert).toContainText("Stopping didn't work");
  await app.emit("hidden", null);
  await expect(alert).toBeHidden();
  await expect(page.getByRole("heading", { name: "Running" })).toBeVisible();

  // Opened again on another view (the menu's Show window): nothing left from before either.
  await app.fail("open_crosstalk", { message: "Couldn't open it: no browser", fix: null });
  await page.getByRole("button", { name: "Open Crosstalk" }).click();
  await expect(alert).toContainText("Couldn't open it");
  await app.emit("opening", null);
  await expect(alert).toBeHidden();
});

test("an error from the menu offers Try again, never only Dismiss", async ({ page }) => {
  const app = await openApp(page, { answers: base(STOPPED) });
  const alert = page.getByRole("alert");
  const fromMenu = async (notice: { message: string; fix: string | null; retry: string }) => {
    await app.answer("take_opening", { view: null, notice: { tone: "error", ...notice } });
    await app.emit("opening", null);
    await expect(alert).toContainText(notice.message);
  };
  // The menu's Start timed out: Try again starts it the window's way.
  await fromMenu({ message: "launchctl didn't finish within 30 seconds", fix: "retry", retry: "start" });
  await noHorizontalOverflow(page);
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect.poll(app.calls).toContain("start");
  await expect(page.getByRole("status").filter({ hasText: "Starting…" })).toBeVisible();

  // No fix of its own: still a way out.
  await fromMenu({ message: "The restart helper isn't in this copy of the app. Use Restart now instead.", fix: null, retry: "restart-quiet" });
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect.poll(app.calls).toContain("restart_when_quiet");

  // A refusal the log explains: Try again and Show logs.
  await fromMenu({ message: "Starting didn't work: Bootstrap failed: 37", fix: "logs", retry: "start" });
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  await alert.getByRole("button", { name: "Show logs" }).click();
  await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible();

  // Only the setting helps: Open Login Items, not Try again.
  await fromMenu({ message: "macOS didn't let the hub start.", fix: "loginItems", retry: "start" });
  await expect(alert.getByRole("button", { name: "Open Login Items" })).toBeVisible();
  await expect(alert.getByRole("button", { name: "Try again" })).toBeHidden();
});

test("no hub yet: what Install changes, its output as it runs, then pairing", async ({ page }) => {
  const app = await openApp(page, { answers: base(NOT_INSTALLED) });
  await expect(page.getByRole("heading", { name: "Not installed" })).toBeVisible();
  await page.getByRole("button", { name: "Install Crosstalk…" }).click();
  await expect(page.getByRole("heading", { name: "Install Crosstalk" })).toBeVisible();
  await expect(page.getByText("Copies the hub to ~/.local/bin/crosstalk-hub.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Reach it from your phone/ })).toBeChecked();
  await page.getByRole("checkbox", { name: /Keep the Mac awake/ }).uncheck();
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __calls: [string, unknown][] }).__calls.find(([c]) => c === "install")?.[1])).toEqual({ tailscale: true, power: false });
  await app.emit("install", { kind: "line", text: "1/5  Installing the hub" });
  await app.emit("install", { kind: "line", text: "    Pairing code: AB23-9XYZ  (valid until 6:32 PM)" });
  await expect(page.getByLabel("What the installer says")).toContainText("1/5  Installing the hub");
  await app.emit("install", { kind: "done", ok: true, message: "Crosstalk is installed and running.", pairingCode: "AB23-9XYZ", fixes: [] });
  await expect(page.getByText("Crosstalk is installed and running.")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "Pair a phone" }).click();
  await expect(page.getByLabel("Pairing code")).toHaveText("H24X-C77J");
});

test("the tray opens the window where it was asked, and Start at login switches off", async ({ page }) => {
  const app = await openApp(page, { answers: base() });
  await expect(page.getByRole("heading", { name: "Running" })).toBeVisible();
  await app.answer("take_opening", { view: "stop", notice: null });
  await app.emit("opening", null);
  await expect(page.getByRole("heading", { name: "Stop Crosstalk?" })).toBeVisible();
  await page.getByRole("button", { name: "‹ Back" }).first().click();

  await page.getByRole("switch", { name: /Start this app at login/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __calls: [string, unknown][] }).__calls.find(([c]) => c === "set_login_item")?.[1])).toEqual({ on: false });
  await expect(page.getByRole("switch", { name: /Start this app at login/ })).not.toBeChecked();
  await expect(page.getByText(/Off: open it yourself when you want it/)).toBeVisible();
});
