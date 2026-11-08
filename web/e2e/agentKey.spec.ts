import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page, PlaywrightWorkerArgs } from "@playwright/test";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Crosstalk's own agent beside agent sign-in, on a phone (390 px), against a hub of the test's own (e2e/signinHub.ts with
// its stand-in NanoGPT, the hub tests' fixtures/fake-nanogpt.ts). That agent has no sign-in: it runs on an AI service's
// key. A NanoGPT chat whose key the service refuses says so in plain words with Open AI services as the way there, and
// nothing anywhere offers to sign the agent in; Test on the service's row then says the key was refused, and with the
// right key Try again answers. No real AI service, BrowserOS neo, agent CLI or sign-in is asked anything.

const BUN = execFileSync("which", ["bun"]).toString().trim();
const HUB_SCRIPT = fileURLToPath(new URL("./signinHub.ts", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
const SHARED_HUB_API = "http://127.0.0.1:5198/api/**";
/** The one key the stand-in NanoGPT takes. */
const KEY = "sk-nano-test-key-0001";
const PICK = "deepseek/deepseek-v4.1-flash-uncensored";
const REFUSED = "NanoGPT refused the key — check it in Settings → AI services, then tap Try again.";

/** Once per engine, on a phone (390 px). */
const onPhone = () => test.skip(!test.info().project.name.endsWith("-390"), "Once per engine, on a phone (390 px).");

type Hub = { base: string; token: string; nano: string; api: APIRequestContext; stop: () => Promise<void> };
const running: Hub[] = [];
test.afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});

/** A hub of this test's own with the stand-in NanoGPT; it ends with the test (and with the run, should the run be killed). */
async function hubWithNano(playwright: PlaywrightWorkerArgs["playwright"]): Promise<Hub> {
  const child = spawn(BUN, [HUB_SCRIPT], { cwd: WEB, env: { ...process.env, SIGNIN_HUB_OPTS: JSON.stringify({ nano: true }) }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
  child.stderr!.on("data", (b: Buffer) => (out += b.toString()));
  const ready = await new Promise<{ port: number; token: string; nano: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The hub didn't start:\n${out}`)), 20_000);
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
      reject(new Error(`The hub ended (${code}):\n${out}`));
    });
  });
  const base = `http://127.0.0.1:${ready.port}`;
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer ${ready.token}` } });
  const hub: Hub = {
    base,
    token: ready.token,
    nano: ready.nano,
    api,
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

/** The app on that hub only, at `hash`: the browser suite's own hub is never asked anything (`strays`). */
async function openOn(page: Page, hub: Hub, hash: string) {
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
  if (!dir || test.info().project.name !== "chromium-390") return;
  await page.screenshot({ path: join(dir, `agent-key-${name}.png`), animations: "disabled" });
}

test("a NanoGPT chat on Crosstalk's agent whose key is refused: the key and Open AI services, never a sign-in", async ({ page, playwright }) => {
  onPhone();
  test.setTimeout(90_000);
  const hub = await hubWithNano(playwright);
  // Saved the way the Add sheet saves it, with a key NanoGPT turns down.
  const saved = await hub.api.post("/api/accounts/endpoint", { data: { provider: "builtin", label: "NanoGPT", baseUrl: hub.nano, apiKey: "sk-nano-wrong", models: [PICK], contextWindow: 1_048_576, protocol: "chat" } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const account = (await saved.json()) as { id: string };
  const chat = await hub.api.post("/api/chats", { data: { provider: "builtin", account: account.id, model: PICK, permissionMode: "full" } });
  expect(chat.ok(), await chat.text()).toBe(true);
  const roomId = ((await chat.json()) as { id: string }).id;
  await hub.api.post(`/api/rooms/${roomId}/messages`, { data: { text: "Say hello" } });
  const lastTurn = async () => {
    const h = await (await hub.api.get(`/api/rooms/${roomId}/history?limit=20`)).json();
    return (h.turns as { status: string; error: string | null; createdAt: number }[]).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  };
  await expect.poll(async () => (await lastTurn())?.status, { timeout: 15_000 }).toBe("error");
  expect((await lastTurn())?.error).toBe(REFUSED);
  // The hub never took it for a sign-in: nothing signed out, no sign-in started.
  expect(await (await hub.api.get("/api/signin")).json()).toEqual({ needs: [], sessions: [] });

  const strays = await openOn(page, hub, `#/room/${roomId}`);
  const messages = page.locator(".messages");
  await expect(messages.getByText(REFUSED)).toBeVisible();
  // The way there, beside Try again; and no Sign in anywhere on the screen.
  const open = messages.getByRole("button", { name: "Open AI services", exact: true });
  await expect(open).toBeVisible();
  await expect(messages.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
  await expect(page.locator(".signin-prompt")).toHaveCount(0);
  await expect(page.getByText(/is signed out/)).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, "1-chat");

  // It goes to Settings → AI services, where the service's row is, with Test and Change and no Sign in.
  await open.click();
  await expect(page.locator("#ai-services")).toBeInViewport();
  const row = page.getByRole("group", { name: "Crosstalk agent · NanoGPT", exact: true });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: /Sign in to Crosstalk agent/ })).toHaveCount(0);
  // Under Agents it's listed as what it is: it runs NanoGPT itself, with no sign-in; the sign-in there is Claude Code's and
  // Codex's (both signed in on this hub, so their own sign-ins are services above too).
  await expect(page.locator(".svc-agents-line")).toHaveText(
    "Claude Code and Codex run the other services above. Crosstalk's own agent runs NanoGPT itself, with the key above, and needs no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.",
  );
  // Test checks the key for real, and says what the chat said.
  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(row.locator(".svc-status")).toHaveText("Key refused");
  await expect(row.getByText(/This key was refused\. Check that you copied all of it/)).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await shot(page, "2-ai-services");

  // With the right key (what the row's Change saves), Try again answers in the same chat, and the way there goes.
  const fixed = await hub.api.post("/api/accounts/endpoint", { data: { provider: "builtin", id: account.id, baseUrl: hub.nano, apiKey: KEY, models: [PICK], contextWindow: 1_048_576 } });
  expect(fixed.ok(), await fixed.text()).toBe(true);
  await page.goto(`/#/room/${roomId}`);
  await messages.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(messages.getByText("Hello from NanoGPT.", { exact: true })).toBeVisible();
  await expect(messages.getByRole("button", { name: "Open AI services", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
  expect(await (await hub.api.get("/api/signin")).json()).toEqual({ needs: [], sessions: [] });
  await shot(page, "3-answered");
  expect(strays).toEqual([]);
});
