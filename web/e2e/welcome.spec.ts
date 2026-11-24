import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import type { AgentAccount, Member, ProviderStatus, Room, RoomActivity } from "@crosstalk/shared";
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
/** What the hub counts once a reply of Claude Code's has finished in that chat (a failed one isn't counted). */
const replied: RoomActivity[] = [{ provider: "claude", turns: 1, outputTokens: 12 }];
/** An account as the hub lists it: an agent's own sign-in ("Main"), or with `over`, another one. */
const account = (provider: string, signedIn: boolean, over: Partial<AgentAccount> = {}): AgentAccount => ({ provider, id: "default", label: "Main", kind: "signin", signedIn, account: null, plan: null, authMethod: null, error: null, checkedAt: Date.now(), ...over }) as AgentAccount;
/** An AI service added with an API key, which Codex drives: what someone with no plan has. */
const service = account("codex", true, { id: "svc1", label: "Venice", kind: "endpoint", plan: "Custom model", authMethod: "endpoint", endpoint: { baseUrl: "https://api.venice.ai/api", models: ["venice-uncensored"], contextWindow: null, hasKey: true } });

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
 * (none by default), `rooms` are the chats (none by default), `replies` the replies finished in them (none) and
 * `accounts` the accounts it lists (none). The rest is the test hub's own.
 */
async function firstRun(page: Page, opts: { signed?: string[]; rooms?: Room[]; members?: Member[]; replies?: Record<string, RoomActivity[]>; accounts?: AgentAccount[]; missing?: () => string[] } = {}) {
  // `missing`: the agents that aren't on the machine (yet).
  const said = (p: ProviderStatus): ProviderStatus => {
    const st = status(p.provider, (opts.signed ?? []).includes(p.provider));
    return opts.missing?.().includes(p.provider) ? { ...st, installed: false, version: null, signedIn: false } : st;
  };
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...s, rooms: opts.rooms ?? [], members: opts.members ?? [], approvals: [], roomActivity: opts.replies ?? {}, accounts: opts.accounts ?? [], providers: s.providers.map(said) },
    });
  });
  // Asked again (a screen that lists accounts does), the hub says the same.
  await page.route("**/api/accounts", (route) => (route.request().method() === "GET" ? route.fulfill({ json: opts.accounts ?? [] }) : route.fallback()));
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
  await expect(welcome(page).getByRole("button")).toHaveText(["Skip", "Sign in to Claude Code", "Sign in to Codex", "Use another kind of account", "Pair a phone"]);
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

  // Opened on the machine itself (as the installer opens it): the card also offers to pair a phone. This machine has
  // no address a phone could open, so that says what's needed instead of making a code.
  await welcome(page).getByRole("button", { name: "Pair a phone", exact: true }).click();
  const pair = page.getByRole("dialog", { name: "Pair a device", exact: true });
  await expect(pair.getByRole("note")).toContainText("Another device can't reach this machine yet.");
  await page.keyboard.press("Escape");
  await expect(pair).toHaveCount(0);

  await welcome(page).getByRole("button", { name: "Use another kind of account", exact: true }).click();
  await expect(page.locator(".topbar h1")).toHaveText("Accounts");
  await expect(page.getByRole("button", { name: "Add an account", exact: true })).toBeInViewport();
  await page.screenshot({ ...shot("02-welcome-ai-services.png"), animations: "disabled" });
});

test("an agent that isn't on the machine yet: Set up installs it on the card, and its sign-in opens by itself when it's in", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  let installed = false;
  let asked = 0;
  await firstRun(page, { missing: () => (installed ? [] : ["claude"]) });
  const pty = { id: "pty_welcome_install", title: "Install claude", purpose: "install", provider: "claude", alive: true, exitCode: null, createdAt: Date.now(), cols: 100, rows: 28 };
  await page.route("**/api/pty", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/providers/claude/install", (r) => (asked++, r.fulfill({ json: pty })));
  // Its terminal: running until the test says the installer has finished.
  await page.route("**/api/pty/pty_welcome_install**", (r) => r.fulfill({ json: { info: { ...pty, alive: !installed, exitCode: installed ? 0 : null }, scrollback: "Installing Claude Code…\r\n" } }));
  await page.route("**/api/providers/claude/refresh", (r) => r.fulfill({ json: { ...status("claude", false), installed } }));
  await page.route("**/api/signin", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 503, json: { error: "Not in a test." } }) : r.fallback()));
  await page.goto("/");
  // Not "Install" and a trip to Settings: one button that does both.
  await expect(welcome(page).getByRole("button")).toHaveText(["Skip", "Set up Claude Code", "Sign in to Codex", "Use another kind of account", "Pair a phone"]);
  await welcome(page).getByRole("button", { name: "Set up Claude Code", exact: true }).click();
  expect(asked).toBe(1);
  const line = welcome(page).locator(".svc-install-line");
  await expect(line).toContainText("Its sign-in opens when it's in.");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("01c-welcome-installing.png"), animations: "disabled" });
  // The installer finishes: Claude Code is there, and its sign-in sheet is up without another tap.
  installed = true;
  const sheet = page.getByRole("dialog", { name: /^Sign in to Claude Code on / });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  // Closed without signing in: the card now has its Sign in button, as for any agent that's installed.
  await expect(welcome(page).getByRole("button", { name: "Sign in to Claude Code", exact: true })).toBeVisible();
});

test("the steps follow what you do: sign in, start a chat, get an answer; then the card is gone for good", async ({ page }) => {
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

  // A message is sent (the hub names the chat from it): that isn't an answer yet, so the last step waits.
  live.send({ t: "room", room: chat({ name: "Hello there", updatedAt: at + 1000 }) });
  live.send({ t: "member", member: { ...agent, status: "working" } });
  await expect(page.getByRole("region", { name: "Recent chats", exact: true })).toContainText("Hello there");
  await done(page, "Say hello", false);
  await expect(welcome(page)).toBeVisible();

  // The first reply fails (no sign-in, a refused key): it ended, but nothing was answered. The card is still there.
  live.send({ t: "member", member: { ...agent, status: "error", statusDetail: "401 Unauthorized" } });
  live.send({ t: "room", room: chat({ name: "Hello again", updatedAt: at + 2000, lastReplyAt: at + 2000 }) });
  await expect(page.getByRole("region", { name: "Recent chats", exact: true })).toContainText("Hello again");
  await done(page, "Say hello", false);
  await expect(welcome(page)).toBeVisible();
  // Trying again doesn't finish it either, until the answer is in.
  live.send({ t: "member", member: { ...agent, status: "working" } });
  live.send({ t: "room", room: chat({ name: "Hello once more", updatedAt: at + 3000, lastReplyAt: at + 2000 }) });
  await expect(page.getByRole("region", { name: "Recent chats", exact: true })).toContainText("Hello once more");
  await done(page, "Say hello", false);
  expect(await page.evaluate((k) => localStorage.getItem(k), DISMISSED)).toBeNull();

  // 3. A reply ends with an answer: all three are done, so the card goes.
  live.send({ t: "member", member: agent });
  live.send({ t: "roomActivity", roomId: "r_welcome", activity: replied });
  live.send({ t: "room", room: chat({ name: "Hello once more", updatedAt: at + 4000, lastReplyAt: at + 4000 }) });
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

test("with no plan but an AI service added, Start a chat starts with that service, not a signed-out agent", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  await firstRun(page, { accounts: [account("claude", false), account("codex", false), service] });
  await page.goto("/");
  // The service is what can answer: step 1 is done without a plan sign-in.
  await done(page, "Sign in an agent", true);
  await welcome(page).getByRole("button", { name: "Start a chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Venice", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("driven by Codex");
  // The chat is the service's: no account to pick, nothing signed out to trip over, and Start is there.
  await expect(dialog.getByRole("radiogroup", { name: "Account", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: /^Sign in to / })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("12-welcome-service-chat.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("New chat picks an account that can answer; on a signed-out one, Sign in takes the place of Start", async ({ page }) => {
  await phone(page);
  await liveUpdates(page);
  await firstRun(page, { accounts: [account("claude", false), account("codex", false), service] });
  await page.goto("/#/agent/codex");
  await page.locator(".agent-hero").getByRole("button", { name: "New chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  const picker = dialog.getByRole("radiogroup", { name: "Account", exact: true });
  // Codex's own sign-in is out, the service can answer: the service is picked, and the chat can start.
  await expect(picker.locator('[aria-checked="true"]')).toHaveAttribute("data-value", "svc1");
  await expect(picker.locator('[aria-checked="true"]')).toContainText("Venice");
  await expect(picker.locator('[aria-checked="true"]')).toContainText("Your own model or service");
  const start = dialog.getByRole("button", { name: "Start chat", exact: true });
  await expect(start).toBeEnabled();

  // Picking the signed-out sign-in by hand: no Start to tap and get an error from. One line says why, and Sign in is there.
  await picker.locator('[role="radio"][data-value="default"]').click();
  await expect(start).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveText("Codex isn't signed in, so it couldn't answer. Sign in, then start the chat.");
  const signIn = dialog.getByRole("button", { name: "Sign in to Codex", exact: true });
  await expect(signIn).toBeVisible();
  await signIn.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("13-new-chat-signed-out.png"), animations: "disabled" });
  // Enter in the name box doesn't start it either.
  let started = false;
  await page.route("**/api/chats", (r) => { if (r.request().method() === "POST") started = true; return r.fallback(); });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).press("Enter");

  // One tap opens the sign-in sheet for it, over New chat. No sign-in really starts in a test.
  await page.route("**/api/signin", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 503, json: { error: "Not in a test." } }) : r.fallback()));
  await signIn.click();
  const sheet = page.getByRole("dialog", { name: /^Sign in to Codex on / });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(started).toBe(false);

  // Back on the service: Start is back.
  await picker.locator('[role="radio"][data-value="svc1"]').click();
  await expect(start).toBeEnabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("at 320 px, New chat on a signed-out account fits: the line, Cancel and Sign in", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await liveUpdates(page);
  // Codex's own sign-in is out, a second one is in, a third is out too.
  await firstRun(page, { accounts: [account("claude", false), account("codex", false), account("codex", true, { id: "work", label: "Work" }), account("codex", false, { id: "old", label: "Old" })] });
  await page.goto("/#/agent/codex");
  await page.locator(".agent-hero").getByRole("button", { name: "New chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  const picker = dialog.getByRole("radiogroup", { name: "Account", exact: true });
  // The sign-in that can answer is the one picked.
  await expect(picker.locator('[aria-checked="true"]')).toHaveAttribute("data-value", "work");
  await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toBeEnabled();

  await picker.locator('[role="radio"][data-value="default"]').click();
  await expect(dialog.getByRole("status")).toHaveText("Codex isn't signed in, so it couldn't answer. Sign in, then start the chat.");
  await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toHaveCount(0);
  const signIn = dialog.getByRole("button", { name: "Sign in to Codex", exact: true });
  await signIn.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  for (const part of [dialog.getByRole("status"), dialog.getByRole("button", { name: "Cancel", exact: true }), signIn]) {
    const box = (await part.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await page.screenshot({ ...shot("14-new-chat-signed-out-320.png"), animations: "disabled" });
  // Another signed-out account, picked by hand, is named in the line.
  await picker.locator('[role="radio"][data-value="old"]').click();
  await expect(dialog.getByRole("status")).toHaveText("Codex's Old account isn't signed in, so it couldn't answer. Sign in, then start the chat.");
  await noHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
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
  await firstRun(page, { signed: ["claude", "codex"], rooms: [chat({ name: "Fix the login bug", updatedAt: at + 4000, lastReplyAt: at + 4000 })], members: [agent], replies: { r_welcome: replied } });
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
  for (const name of ["Sign in to Claude Code", "Sign in to Codex", "Use another kind of account"]) await inside(welcome(page).getByRole("button", { name, exact: true }));
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
  await page.goto("/#/settings/machines");
  await expect(page.getByRole("heading", { name: "Machines", exact: true }).first()).toBeVisible();
}
/** Every technical heading of Settings with its topic, by the page it's in (settingsTabs.ts). */
const HEADINGS: [string, [string, HelpTopic][]][] = [
  [
    "Machines",
    [
      ["Machines", "machines"],
      ["Remote computers", "computers"],
      ["This Mac", "thisMac"],
      ["Storage", "storage"],
    ],
  ],
  ["Usage & costs", [["Plan limits", "usage"]]],
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
  await settingsTab(page, "Machines");
  const storage = await tip(page, "storage", { keepOpen: true });
  await storage.button.evaluate((el) => el.closest(".tip-line")!.scrollIntoView({ block: "start" }));
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("08-tip-settings.png"), animations: "disabled" });
  await storage.button.click();
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
  await expect(dialog.getByText("May do", { exact: true })).toBeVisible();
  const permissions = await tip(page, "permissions", { keepOpen: true });
  await dialog.getByRole("radiogroup", { name: "What it may do", exact: true }).scrollIntoViewIfNeeded();
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
  await expect(dialog.getByRole("radio", { name: "Asks first", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("at 320 px every tip, open, fits the screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await settingsOnAMac(page);
  // The page is narrowest here too: nothing widens it.
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
