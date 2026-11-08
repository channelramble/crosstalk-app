import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page, PlaywrightWorkerArgs } from "@playwright/test";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Signing an agent in again from the phone, against a hub of the test's own (e2e/signinHub.ts): the hub's real sign-in
// code and stale-login recovery, with the hub tests' fake Claude Code and Codex, whose sign-in is a file the test reads
// and writes. A Claude Code chat can stop with "Failed to authenticate: OAuth session expired and could not be
// refreshed" while the setup checklist still says signed in, leaving a terminal on the hub's machine as the only fix. Here the
// chat says so with one button, the sheet signs it in from the phone, and Try again carries on. Nothing here runs a real
// agent CLI or signs in to anything; the sign-in pages are stand-ins.

const BUN = execFileSync("which", ["bun"]).toString().trim();
const HUB_SCRIPT = fileURLToPath(new URL("./signinHub.ts", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
/** The code part of what Claude Code's sign-in page shows (`code#state`). */
const PAGE_CODE = "ac_Zx81kq3Lmw9TbP2vYh7";
const SHARED_HUB_API = "http://127.0.0.1:5198/api/**";

/** The whole flow: once per engine, on a phone (390 px). */
const onPhone = () => test.skip(!test.info().project.name.endsWith("-390"), "Once per engine, on a phone (390 px).");

type SignInHub = { base: string; token: string; dir: string; api: APIRequestContext; log: () => string; stop: () => Promise<void> };
const running: SignInHub[] = [];
test.afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});

/** Starts a hub of this test's own; it ends with the test (and with the run, should the run be killed). */
async function signInHub(playwright: PlaywrightWorkerArgs["playwright"], opts: { staleStarts?: string; codex?: "in" | "out" } = {}): Promise<SignInHub> {
  const child = spawn(BUN, [HUB_SCRIPT], { cwd: WEB, env: { ...process.env, SIGNIN_HUB_OPTS: JSON.stringify({ pageCode: PAGE_CODE, ...opts }) }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
  child.stderr!.on("data", (b: Buffer) => (out += b.toString()));
  const ready = await new Promise<{ port: number; token: string; dir: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The sign-in hub didn't start:\n${out}`)), 20_000);
    const look = () => {
      const m = /SIGNIN_HUB (\{.*\})/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      child.stdout!.off("data", look);
      resolve(JSON.parse(m[1]));
    };
    child.stdout!.on("data", look);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The sign-in hub ended (${code}):\n${out}`));
    });
  });
  const base = `http://127.0.0.1:${ready.port}`;
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer ${ready.token}` } });
  const hub: SignInHub = {
    base,
    token: ready.token,
    dir: ready.dir,
    api,
    log: () => out,
    stop: async () => {
      await api.dispose();
      if (child.exitCode !== null) return;
      const ended = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
      child.kill("SIGTERM");
      if (!(await Promise.race([ended, new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]))) {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Gone.
        }
      }
    },
  };
  running.push(hub);
  return hub;
}

/**
 * Opens the app on that hub only (this device's one machine), at `hash`. The browser suite's own hub is never asked
 * anything: a request to it fails the test (`strays`).
 */
async function openOn(page: Page, hub: SignInHub, hash: string) {
  const strays: string[] = [];
  await page.route(SHARED_HUB_API, (route) => {
    strays.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(({ base, token }) => {
    localStorage.setItem("crosstalk.machines.v1", JSON.stringify({ list: [{ baseUrl: base, token, deviceName: "Browser tests" }], active: base }));
  }, { base: hub.base, token: hub.token });
  await page.goto(`/${hash}`);
  return strays;
}

/** CT_SHOTS: a folder for the screens (390 px Chromium only). */
async function shot(page: Page, name: string) {
  const dir = process.env.CT_SHOTS;
  if (!dir || !["chromium-390", "chromium-320"].includes(test.info().project.name)) return;
  await page.screenshot({ path: join(dir, `signin-${name}.png`), animations: "disabled" });
}

async function newChat(hub: SignInHub, name: string): Promise<string> {
  const res = await hub.api.post("/api/chats", { data: { provider: "claude", name } });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).id as string;
}

async function lastTurn(hub: SignInHub, roomId: string): Promise<{ status: string } | undefined> {
  const h = await (await hub.api.get(`/api/rooms/${roomId}/history?limit=20`)).json();
  return (h.turns as { status: string; createdAt: number }[]).sort((a, b) => a.createdAt - b.createdAt).at(-1);
}

test("a chat whose Claude Code sign-in was cleared: one button, the sign-in from the phone, then Try again", async ({ page, playwright, browserName }) => {
  onPhone();
  test.setTimeout(120_000);
  const hub = await signInHub(playwright);
  const roomId = await newChat(hub, "Release prep");
  const otherId = await newChat(hub, "Release notes");
  // The checklist still says signed in (its status is from the hub's start); then Claude Code clears the shared sign-in.
  writeFileSync(join(hub.dir, "claude-auth"), "out");
  await hub.api.post(`/api/rooms/${roomId}/messages`, { data: { text: "Plan the next release" } });
  await expect.poll(async () => (await (await hub.api.get("/api/signin")).json()).needs.length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await lastTurn(hub, roomId))?.status, { timeout: 15_000 }).toBe("error");

  const asked: { url: string; body: string }[] = [];
  page.on("request", (r) => asked.push({ url: r.url(), body: r.postData() ?? "" }));
  const strays = await openOn(page, hub, `#/room/${roomId}`);

  // The failed reply says it in plain words, with one button, in place of an error that only pointed to Settings.
  const card = page.getByRole("group", { name: "Sign in to Claude Code on Mac mini" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Claude Code is signed out on Mac mini, so it couldn't answer. Sign it in again from this device, then tap Try again.");
  await expect(card.getByRole("button")).toHaveCount(1);
  await expect(card.getByRole("button")).toHaveAccessibleName("Sign in to Claude Code on Mac mini");
  await expect(page.locator(".messages")).not.toContainText("Settings → Agents → Claude Code → Sign in");
  await expect(page.locator(".messages")).toContainText("Claude Code's sign-in had gone stale in this chat. Crosstalk started it again, but its sign-in failed again.");
  await noHorizontalOverflow(page);
  await shot(page, "1-chat");

  // Another chat on the same account says so before it's tried: it would stop the same way.
  await page.goto(`/#/room/${otherId}`);
  await expect(card).toContainText("Claude Code is signed out on Mac mini, so it can't answer here until it's signed in again.");
  await page.goto(`/#/room/${roomId}`);
  await expect(card).toContainText("so it couldn't answer");

  // Settings → Agents says it too: on Claude Code's own card, and on the setup checklist's item.
  await page.goto(`/#/settings/agent-claude`);
  const agentCard = page.locator("#agent-claude");
  await expect(agentCard.getByRole("group", { name: "Sign in to Claude Code on Mac mini" })).toContainText("Its chats can't answer until it's signed in again. A chat stopped on it.");
  await agentCard.getByRole("group", { name: "Sign in to Claude Code on Mac mini" }).scrollIntoViewIfNeeded();
  await shot(page, "1b-settings-agent");
  const checklist = page.locator(".agent-setup");
  const item = checklist.getByRole("group", { name: "Sign in to Claude Code on Mac mini" });
  await expect(item).toContainText("From here: no need to be at Mac mini.");
  await item.scrollIntoViewIfNeeded();
  await shot(page, "1c-settings-checklist");
  await noHorizontalOverflow(page);
  await page.goto(`/#/room/${roomId}`);

  // The sheet: the sign-in page as a big link that opens in this phone's browser, and the box for the code it shows.
  await card.getByRole("button").click();
  const sheet = page.getByRole("dialog", { name: "Sign in to Claude Code on Mac mini" });
  const link = sheet.getByRole("link", { name: "Open the sign-in page" });
  await expect(link).toHaveAttribute("href", /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  const state = readFileSync(join(hub.dir, "login-state"), "utf8").trim();
  expect(new URL((await link.getAttribute("href"))!).searchParams.get("state")).toBe(state);
  // The keyboard (and a screen reader) is on the link once it's ready.
  await expect(link).toBeFocused();
  const field = sheet.getByRole("textbox", { name: "Code from the sign-in page" });
  await expect(field).toBeEnabled();
  await expect(field).toHaveAttribute("autocomplete", "one-time-code");
  await expect(field).not.toHaveAttribute("name", /.*/);
  await noHorizontalOverflow(page);
  await shot(page, "2-sheet");

  // Put away and opened again: the same sign-in carries on (the same link), and nothing typed was kept.
  await field.fill("ac_half-typed");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await card.getByRole("button").click();
  await expect(link).toHaveAttribute("href", new RegExp(`state=${state}$`));
  await expect(field).toHaveValue("");
  // One sign-in on the hub all along: opening the sheet (twice) started exactly one.
  expect((await (await hub.api.get("/api/signin")).json()).sessions.map((s: { state: string }) => s.state)).toEqual(["open"]);

  // The page opens in a browser of its own (a stand-in here); back from it, the box is where the keyboard is.
  await page.context().route("https://claude.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Claude</title><p>Paste this code into Claude Code</p>" }));
  const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  expect(popup.url()).toContain("https://claude.com/cai/oauth/authorize?");
  await popup.close();
  await expect.poll(() => field.evaluate((el) => el === document.activeElement)).toBe(true);

  // Half the code: Claude Code turns it down, the sheet says so at once and wants the whole of it.
  await field.fill(PAGE_CODE);
  await sheet.getByRole("button", { name: "Sign in", exact: true }).click();
  const words = sheet.locator(".signin-words");
  await expect(words).toHaveText("Claude Code didn't take that code. Copy the whole code from the sign-in page and paste it again.");
  await expect(words).toHaveAttribute("aria-live", "assertive");
  await expect(field).toHaveValue("");
  await expect.poll(() => field.evaluate((el) => el === document.activeElement)).toBe(true);
  await shot(page, "3-refused");

  // The whole code, with Paste (what this browser lets a test copy), else typed in.
  const whole = `${PAGE_CODE}#${state}`;
  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate((text) => navigator.clipboard.writeText(text), whole);
    await sheet.getByRole("button", { name: "Paste" }).click();
    await expect(field).toHaveValue(whole);
  } else {
    await field.fill(whole);
  }
  await sheet.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(words).toHaveText(/^Claude Code is signed in on Mac mini \(/, { timeout: 20_000 });
  await expect(sheet).toContainText("Tap Try again in the chat to carry on.");
  await expect(sheet.getByRole("button", { name: "Done" })).toBeFocused();
  await shot(page, "4-signed-in");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);

  // Signed in: the card has gone, the chat says it can carry on, and the keyboard is on its Try again.
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Claude Code is signed in again on Mac mini. Tap Try again to carry on.")).toBeVisible();
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeFocused();
  await tryAgain.click();
  await expect.poll(async () => (await lastTurn(hub, roomId))?.status, { timeout: 20_000 }).toBe("done");
  await shot(page, "5-carried-on");

  // The code went to the hub once, in the request that hands it to Claude Code, and nowhere else: not in any address,
  // not kept by this page, not in the hub's log.
  for (const secret of [whole, PAGE_CODE]) {
    expect(asked.filter((r) => r.url.includes(secret)).map((r) => r.url)).toEqual([]);
    expect(new Set(asked.filter((r) => r.body.includes(secret)).map((r) => r.url.replace(/si_\w+/, "si_…")))).toEqual(new Set([`${hub.base}/api/signin/si_…/code`]));
    expect(await page.evaluate((s) => JSON.stringify({ ...localStorage }).includes(s) || JSON.stringify({ ...sessionStorage }).includes(s), secret)).toBe(false);
    expect(hub.log().includes(secret)).toBe(false);
  }
  expect(strays).toEqual([]);
});

test("an agent that picked itself back up: the hub's note in the reply, and nothing to do", async ({ page, playwright }) => {
  onPhone();
  test.setTimeout(60_000);
  // The first Claude Code process holds a sign-in gone stale; one started afresh reads the good one.
  const hub = await signInHub(playwright, { staleStarts: "1" });
  const roomId = await newChat(hub, "Build notes");
  await hub.api.post(`/api/rooms/${roomId}/messages`, { data: { text: "Plan the next release" } });
  await expect.poll(async () => (await lastTurn(hub, roomId))?.status, { timeout: 30_000 }).toBe("done");
  const strays = await openOn(page, hub, `#/room/${roomId}`);
  const note = page.getByRole("note").filter({ hasText: "Claude Code's sign-in had gone stale in this chat: Crosstalk started it again and it carried on." });
  await expect(note).toBeVisible();
  await expect(page.getByRole("group", { name: /^Sign in to / })).toHaveCount(0);
  expect((await (await hub.api.get("/api/signin")).json()).needs).toEqual([]);
  await noHorizontalOverflow(page);
  await shot(page, "6-recovered");
  expect(strays).toEqual([]);
});

test("a new machine's first sign-in from the setup checklist: Codex's device code, Cancel, then approved", async ({ page, playwright, browserName }) => {
  onPhone();
  test.setTimeout(90_000);
  const hub = await signInHub(playwright, { codex: "out" });
  const strays = await openOn(page, hub, "#/settings/agent-setup");
  const checklist = page.locator(".agent-setup");
  const prompt = checklist.getByRole("group", { name: "Sign in to Codex on Mac mini" });
  await expect(prompt).toContainText("From here: no need to be at Mac mini.");
  await expect(prompt.getByRole("button")).toHaveCount(1);
  await prompt.getByRole("button").click();

  const sheet = page.getByRole("dialog", { name: "Sign in to Codex on Mac mini" });
  const link = sheet.getByRole("link", { name: "Open the sign-in page" });
  await expect(link).toHaveAttribute("href", "https://example.com/device");
  await expect(link).toBeFocused();
  await expect(sheet.locator(".code-big")).toHaveText("ABCD-EFGH");
  await expect(sheet).toContainText("Enter this code there:");
  await expect(sheet).toContainText("Waiting for you to approve in the browser…");
  await expect(sheet.getByRole("textbox")).toHaveCount(0);
  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await sheet.getByRole("button", { name: "Copy code" }).click();
    await expect(sheet.getByRole("button", { name: "Copy code: copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("ABCD-EFGH");
  }
  await noHorizontalOverflow(page);
  await shot(page, "7-device-code");

  // Cancel stops it on the hub; the prompt starts a new one.
  const first = (await (await hub.api.get("/api/signin")).json()).sessions[0].id as string;
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(async () => (await (await hub.api.get(`/api/signin/${first}`)).json()).state).toBe("cancelled");
  await prompt.getByRole("button").click();
  await expect(sheet.locator(".code-big")).toHaveText("ABCD-EFGH");
  const sessions = (await (await hub.api.get("/api/signin")).json()).sessions as { id: string; state: string }[];
  expect(sessions.filter((s) => s.state === "open").map((s) => s.id)).not.toContain(first);

  // Approved on the page: signed in, and the checklist's item is done.
  writeFileSync(join(hub.dir, "codex-approved"), "yes");
  await expect(sheet.locator(".signin-words")).toHaveText(/^Codex is signed in on Mac mini/, { timeout: 20_000 });
  await expect(sheet).toContainText("Chats on Codex can answer again.");
  await shot(page, "8-codex-signed-in");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(prompt).toHaveCount(0, { timeout: 15_000 });
  // The keyboard isn't lost with the prompt: it's on the line saying how the list stands now.
  await expect(checklist.locator("[data-focus-here]")).toBeFocused();
  expect(strays).toEqual([]);
});

test("the narrowest phone (320 px): the prompts and both kinds of sign-in fit, nothing wider than the screen", async ({ page, playwright }) => {
  test.skip(!test.info().project.name.endsWith("-320"), "Once per engine, on the narrowest phone.");
  test.setTimeout(60_000);
  // A new machine: neither agent signed in yet.
  const hub = await signInHub(playwright, { codex: "out" });
  writeFileSync(join(hub.dir, "claude-auth"), "out");
  await hub.api.post("/api/providers/claude/refresh");
  const strays = await openOn(page, hub, "#/settings/agent-setup");
  const checklist = page.locator(".agent-setup");
  for (const agent of ["Claude Code", "Codex"]) {
    const prompt = checklist.getByRole("group", { name: `Sign in to ${agent} on Mac mini` });
    await prompt.scrollIntoViewIfNeeded();
    await noHorizontalOverflow(page);
    await prompt.getByRole("button").click();
    const sheet = page.getByRole("dialog", { name: `Sign in to ${agent} on Mac mini` });
    await expect(sheet.getByRole("link", { name: "Open the sign-in page" })).toBeVisible();
    if (agent === "Codex") await expect(sheet.locator(".code-big")).toHaveText("ABCD-EFGH");
    else await expect(sheet.getByRole("textbox", { name: "Code from the sign-in page" })).toBeEnabled();
    await noHorizontalOverflow(page);
    // Everything in the sheet is inside the screen: the link, the code, the box and its buttons, the foot.
    const box = await sheet.boundingBox();
    for (const el of await sheet.locator("a, button, input, .code-big").all()) {
      const r = await el.boundingBox();
      if (r) expect(r.x + r.width, await el.evaluate((n) => n.outerHTML.slice(0, 80))).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
    }
    await shot(page, `9-narrow-${agent === "Codex" ? "device" : "paste"}`);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
  }
  expect(strays).toEqual([]);
});
