import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import type { Member, ProviderStatus, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";
import { pong } from "./otherMachine";
import { HELP, type HelpTopic } from "../src/helpCopy";

// First run and help (web/src/welcome.ts, views/WelcomeCard.tsx, helpCopy.ts, views/Tip.tsx). What the hub says about who is
// signed in and which chats exist is played here: the shared test hub has its agents signed in, and each test decides
// what a first run looks like. Nothing is sent to an agent and no chat is started.

// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
const DISMISSED = "crosstalk.welcome.dismissed";
const at = Date.now();

const status = (provider: string, signedIn: boolean): ProviderStatus => ({ provider, installed: true, version: "test", binPath: null, signedIn, account: "Browser fixture", plan: "test", authMethod: null, error: null, checkedAt: Date.now() }) as ProviderStatus;
/** A chat nobody has written in yet (the hub makes it with createdAt equal to updatedAt), with the agent that answers in it. */
const chat = (patch: Partial<Room> = {}): Room => ({ id: "r_welcome", name: "New chat", cwd: "/tmp/welcome", mode: "direct", leadMemberId: "mb_welcome", maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "claude", origin: "web" }, ...patch }) as Room;
const agent = { id: "mb_welcome", roomId: "r_welcome", handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: at, position: 0 } as Member;

/** The hub's live updates on this page, played by the test (it answers pings), so nothing real leaks into a played state. */
async function liveUpdates(page: Page) {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    pong(ws);
  });
  return { send: (e: unknown) => socket!.send(JSON.stringify(e)), ready: () => expect.poll(() => !!socket).toBe(true) };
}

/**
 * What the hub says to a person who has just set Crosstalk up: the agents are installed, only `signed` are signed in
 * (none by default), and `rooms` are the chats (none by default). The rest is the test hub's own.
 */
async function firstRun(page: Page, opts: { signed?: string[]; rooms?: Room[]; members?: Member[] } = {}) {
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...s, rooms: opts.rooms ?? [], members: opts.members ?? [], approvals: [], roomActivity: {}, accounts: [], providers: s.providers.map((p: ProviderStatus) => status(p.provider, (opts.signed ?? []).includes(p.provider))) },
    });
  });
}

const welcome = (page: Page) => page.getByRole("region", { name: "Welcome to Crosstalk", exact: true });
const step = (page: Page, title: string) => welcome(page).getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
const done = (page: Page, title: string, is: boolean) => expect(step(page, title)).toHaveAttribute("data-done", String(is));
/** Opens a "?" and checks the sentence it shows; closes it again. */
async function tip(page: Page, topic: HelpTopic, { keepOpen = false } = {}) {
  const button = page.getByRole("button", { name: HELP[topic].label, exact: true }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const note = button.locator("xpath=..").getByRole("note");
  await expect(note).toHaveText(HELP[topic].text);
  await expect(button).toHaveAttribute("aria-expanded", "true");
  if (!keepOpen) {
    await button.click();
    await expect(note).toHaveCount(0);
  }
  return { button, note };
}

test("an empty hub shows the welcome card: each agent's Sign in opens the sign-in sheet, and another service opens Settings", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  await firstRun(page);
  await page.goto("/");
  await expect(welcome(page)).toBeVisible();
  // Three steps in order, none done. Only the next one has a button, and nothing can start a chat before an agent is signed in.
  await expect(welcome(page).getByRole("listitem")).toHaveCount(3);
  await expect(welcome(page).getByRole("heading", { level: 3 })).toHaveText(["Sign in an agent", "Pick a folder", "Say hello"]);
  for (const title of ["Sign in an agent", "Pick a folder", "Say hello"]) await done(page, title, false);
  await expect(welcome(page).getByRole("button")).toHaveText(["Skip", "Sign in to Claude Code", "Sign in to Codex", "Use another AI service"]);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("01-welcome-empty.png"), animations: "disabled" });

  // Sign in opens the sign-in sheet right here, for that agent on this machine. No sign-in really starts in a test.
  await page.route("**/api/signin", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 503, json: { error: "Not in a test." } }) : r.fallback()));
  await step(page, "Sign in an agent").getByRole("button", { name: "Sign in to Claude Code", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: /^Sign in to Claude Code on / });
  await expect(sheet).toBeVisible();
  await page.screenshot({ ...shot("01b-welcome-sign-in-sheet.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  await welcome(page).getByRole("button", { name: "Use another AI service", exact: true }).click();
  await expect(page.locator(".topbar h1")).toHaveText("Settings");
  const heading = page.getByRole("heading", { name: "AI services", exact: true });
  await expect(heading).toBeInViewport();
  await page.screenshot({ ...shot("02-welcome-ai-services.png"), animations: "disabled" });
});

test("the steps follow what you do: sign in, start a chat, say something; then the card is gone for good", async ({ page }) => {
  await phone(page);
  const live = await liveUpdates(page);
  await firstRun(page);
  await page.goto("/");
  await expect(welcome(page)).toBeVisible();
  await live.ready();

  // 1. An agent signs in (the hub tells every screen): step 1 is done and the button moves on to starting a chat.
  live.send({ t: "provider", status: status("claude", true) });
  await done(page, "Sign in an agent", true);
  await expect(step(page, "Sign in an agent").getByRole("heading")).toContainText("done");
  await expect(welcome(page).getByRole("button", { name: /^Sign in to / })).toHaveCount(0);
  await expect(step(page, "Pick a folder").getByRole("button", { name: "Start a chat", exact: true })).toBeVisible();
  await expect(step(page, "Say hello").getByRole("button")).toHaveCount(0);
  await page.screenshot({ ...shot("03-welcome-signed-in.png"), animations: "disabled" });

  // The one button opens the New chat dialog, where the folder is picked. Nothing starts until Start chat.
  await welcome(page).getByRole("button", { name: "Start a chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Claude Code", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Folder", { exact: true })).toBeVisible();
  await page.screenshot({ ...shot("04-welcome-new-chat.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await done(page, "Pick a folder", false);

  // 2. A chat is started: step 2 is done, and the button is on the last step.
  live.send({ t: "room", room: chat() });
  live.send({ t: "member", member: agent });
  await done(page, "Pick a folder", true);
  await done(page, "Say hello", false);
  await expect(step(page, "Say hello").getByRole("button", { name: "Start a chat", exact: true })).toBeVisible();
  await expect(step(page, "Pick a folder").getByRole("button")).toHaveCount(0);
  await page.screenshot({ ...shot("05-welcome-chat-made.png"), animations: "disabled" });
  expect(await page.evaluate((k) => localStorage.getItem(k), DISMISSED)).toBeNull();

  // 3. The first reply ends: all three are done, so the card goes.
  live.send({ t: "room", room: chat({ updatedAt: at + 4000, lastReplyAt: at + 4000 }) });
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), DISMISSED)).toBe("1");

  // Gone for good on this device: the hub starts a fresh screen with nothing done (played above), and it stays away.
  await page.reload();
  await expect(page.getByText("Sign in needed").first()).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

test("Start a chat uses the agent that is signed in", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  await firstRun(page, { signed: ["codex"] });
  await page.goto("/");
  await expect(step(page, "Sign in an agent").getByRole("heading")).toContainText("done");
  await welcome(page).getByRole("button", { name: "Start a chat", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New chat with Codex", exact: true })).toBeVisible();
});

test("Skip asks nothing, and the card stays away on this device", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  const asked: string[] = [];
  page.on("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await firstRun(page);
  await page.goto("/");
  await expect(welcome(page)).toBeVisible();
  await welcome(page).getByRole("button", { name: "Skip the welcome steps", exact: true }).click();
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(asked).toEqual([]);
  expect(await page.evaluate((k) => localStorage.getItem(k), DISMISSED)).toBe("1");
  await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
  await page.screenshot({ ...shot("06-welcome-skipped.png"), animations: "disabled" });

  // Reloading, and coming back later, don't bring it back (the hub still has nothing done).
  await page.reload();
  await expect(page.getByText("Sign in needed").first()).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
  await page.goto("/#/settings");
  await page.goto("/");
  await expect(page.getByText("Sign in needed").first()).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

test("a person whose chats and sign-in are already there never sees the card, not even a flash", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  await page.addInitScript(() => {
    (window as unknown as { welcomeSeen: boolean }).welcomeSeen = false;
    new MutationObserver(() => {
      if (document.querySelector(".welcome")) (window as unknown as { welcomeSeen: boolean }).welcomeSeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await firstRun(page, { signed: ["claude", "codex"], rooms: [chat({ name: "Fix the login bug", updatedAt: at + 4000, lastReplyAt: at + 4000 })], members: [agent] });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Recent chats", exact: true })).toContainText("Fix the login bug");
  await expect(welcome(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { welcomeSeen: boolean }).welcomeSeen)).toBe(false);
});

test("at 320 px the card, its buttons and its steps fit", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const live = await liveUpdates(page);
  await firstRun(page);
  await page.goto("/");
  await expect(welcome(page)).toBeVisible();
  await noHorizontalOverflow(page);
  const inside = async (button: Locator) => {
    const card = (await welcome(page).boundingBox())!;
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(card.x);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
  };
  for (const name of ["Sign in to Claude Code", "Sign in to Codex", "Use another AI service"]) await inside(welcome(page).getByRole("button", { name, exact: true }));
  await inside(welcome(page).getByRole("button", { name: "Skip the welcome steps", exact: true }));
  await live.ready();
  live.send({ t: "provider", status: status("claude", true) });
  await expect(welcome(page).getByRole("button", { name: "Start a chat", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await inside(welcome(page).getByRole("button", { name: "Start a chat", exact: true }));
});

/** Settings as a Mac hub shows it (This Mac is only there for one), with a Mac's own settings played, never read. */
async function settingsOnAMac(page: Page) {
  await liveUpdates(page);
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    await route.fulfill({ json: { ...s, hub: { ...s.hub, platform: "darwin" } } });
  });
  await page.route("**/api/mac", (route) => route.fulfill({ json: { fullDiskAccess: true, autoLogin: "user", fileVault: false, sleepMinutes: 0, restartsAfterPowerCut: true, wakesForNetwork: true, autoUpdates: true, tailscaleExpiry: null, dialogs: [], checkedAt: Date.now() } }));
  await page.route("**/api/computers", (route) => route.fulfill({ json: [] }));
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Teamwork", exact: true })).toBeVisible();
}
/** Every technical heading of Settings with its topic, by the tab it's in (settingsTabs.ts). */
const HEADINGS: [string, [string, HelpTopic][]][] = [
  ["Agents", [["Teamwork", "teamwork"]]],
  ["Models", [["Model pool", "modelPool"]]],
  [
    "Machines",
    [
      ["Machines", "machines"],
      ["Computers agents can use", "computers"],
      ["This Mac", "thisMac"],
      ["Storage", "storage"],
    ],
  ],
  ["Usage", [["Usage", "usage"]]],
];

test("Settings: a ? next to each technical heading opens one plain sentence, and the heading's name stays its words", async ({ page }) => {
  await phone(page);
  await settingsOnAMac(page);
  // The id Settings scrolls to is on the line around a heading and its "?", so the section after it is still its sibling
  // (macServer.spec.ts finds the crash notice as "#this-mac ~ .card").
  await settingsTab(page, "Machines");
  await expect(page.locator("#this-mac ~ .card").first()).toBeVisible();
  await expect(page.locator("#this-mac").getByRole("heading", { name: "This Mac", exact: true })).toBeVisible();
  // As it opens: a small "?" by each heading, nothing else changed (Computers keeps its Connect button).
  await page.getByRole("button", { name: HELP.computers.label, exact: true }).evaluate((el) => el.closest(".tip-line")!.scrollIntoView({ block: "start" }));
  await expect(page.getByRole("note")).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("07-tips-closed.png"), animations: "disabled" });
  for (const [tab, headings] of HEADINGS) {
    await settingsTab(page, tab);
    for (const [name, topic] of headings) {
      // The "?" is beside the heading, not in it.
      await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible();
      await tip(page, topic);
    }
  }
  // One open, as a phone shows it: the sentence under its heading, and Computers' own button kept on the right.
  await settingsTab(page, "Models");
  const pool = await tip(page, "modelPool", { keepOpen: true });
  await pool.button.evaluate((el) => el.closest(".tip-line")!.scrollIntoView({ block: "start" }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("08-tip-settings.png"), animations: "disabled" });
  await pool.button.click();
  await settingsTab(page, "Machines");
  const computers = await tip(page, "computers", { keepOpen: true });
  await expect(page.getByRole("button", { name: "Connect a computer", exact: true })).toBeVisible();
  await computers.button.evaluate((el) => el.closest(".tip-line")!.scrollIntoView({ block: "start" }));
  await page.screenshot({ ...shot("09-tip-computers.png"), animations: "disabled" });
});

test("New chat: a ? by the permission choices and by Helper agents, and the dialog still fits", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  await firstRun(page, { signed: ["claude"] });
  await page.goto("/");
  await welcome(page).getByRole("button", { name: "Start a chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Claude Code", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Helper agents use", exact: true })).toBeVisible();
  await expect(dialog.getByText("Permissions", { exact: true })).toBeVisible();
  const permissions = await tip(page, "permissions", { keepOpen: true });
  await dialog.locator(".seg").scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("10-tip-new-chat-permissions.png"), animations: "disabled" });
  // Both can be open at once; tapping a tip never changes a setting.
  const helpers = await tip(page, "helpers", { keepOpen: true });
  await expect(dialog.getByRole("note")).toHaveCount(2);
  await permissions.button.click();
  await expect(dialog.getByRole("note")).toHaveCount(1);
  await helpers.note.scrollIntoViewIfNeeded();
  await page.screenshot({ ...shot("11-tip-new-chat-helpers.png"), animations: "disabled" });
  await helpers.button.click();
  await expect(dialog.getByRole("note")).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Helper agents use", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("radio", { name: /Asks first/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("at 320 px every tip, open, fits the screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await settingsOnAMac(page);
  // The tabs are narrowest here too: the row scrolls sideways rather than widening the page.
  await noHorizontalOverflow(page);
  for (const [tab, headings] of HEADINGS) {
    await settingsTab(page, tab);
    for (const [, topic] of headings) {
      const { note } = await tip(page, topic, { keepOpen: true });
      await expect(note).toBeVisible();
      await noHorizontalOverflow(page);
    }
  }
});
