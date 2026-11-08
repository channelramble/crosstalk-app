import type { APIRequestContext, Page, Route } from "@playwright/test";
import type { PoolOffer, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Chatting with the model pool on a phone (docs/MODEL-POOL.md): one entry in New chat whatever state the pool is in,
// what tapping it does in each state, and the chat that follows saying it is the pool and its model. The pool itself is
// played: the hub's offer (StateSnapshot.pool) is patched into the state the app loads, and POST /api/pool/start is
// answered here, so no test ever starts a real pool, installs llama.cpp or downloads a model. The hub's own side is
// checked in hub/test/pool-chat.test.ts with the pool's fakes.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
/** The phone flow, at 390 px (the width this was designed for). */
const onPhone = () => test.skip(!/-390$/.test(test.info().project.name), "The phone flow: the 390 project.");

const MODEL = "qwen3.8-27b";
/** The pool as the hub offers it running on three machines: the Mac holds nothing, linux-box runs the model. */
const running: PoolOffer = {
  label: "Model pool",
  state: "running",
  detail: "Running on the GPUs of linux-box and gaming-pc.",
  setUp: true,
  ready: true,
  model: MODEL,
  modelName: "Qwen3.8-27B",
  machines: ["linux-box", "gaming-pc", "Mac mini"],
  missing: [],
  accounts: {},
};
const offer = (over: Partial<PoolOffer> = {}): PoolOffer => ({ ...running, ...over });

/** The pool the app sees, patched into the state it loads (the hub's own pool is never set up in a browser test). */
async function poolOffer(page: Page, pool: PoolOffer) {
  await page.route("**/api/state", async (route: Route) => {
    const res = await route.fetch();
    await route.fulfill({ json: { ...(await res.json()), pool } });
  });
}

/** Every start the page asked for. The route is answered here: a browser test must never start a real pool. */
async function holdStarts(page: Page) {
  const starts: string[] = [];
  await page.route("**/api/pool/start", async (route: Route) => {
    starts.push(route.request().method());
    await route.fulfill({ json: { config: { machines: [] }, machines: [], status: { state: "preparing", detail: "Asking the machines…", download: null, endpoint: null, accounts: {}, startedAt: null, speed: null, log: [] }, fit: null, hasHfToken: false } });
  });
  return starts;
}

/** Every check of the machines the page asked for, answered here: a test never asks a real machine anything. */
async function holdChecks(page: Page) {
  const checks: string[] = [];
  await page.route("**/api/pool/check", async (route: Route) => {
    checks.push(route.request().method());
    await route.fulfill({ json: { config: { machines: [] }, machines: [], status: { state: "off", detail: null, download: null, endpoint: null, accounts: {}, startedAt: null, speed: null, log: [] }, fit: null, hasHfToken: false } });
  });
  return checks;
}

/** A model list for a chat on the pool's account: the pool serves one model, so that's all there is. */
async function poolModels(page: Page) {
  await page.route("**/api/providers/*/models**", (route: Route) =>
    route.fulfill({ json: { provider: "claude", live: true, error: null, models: [{ id: MODEL, label: MODEL, description: null, efforts: [], defaultEffort: null, isDefault: true, contextWindow: 65536 }] } }),
  );
}

/** Opens the chats drawer and taps New chat. */
async function openNewChat(page: Page) {
  await page.getByRole("button", { name: /^Show chats/ }).click();
  const list = page.locator(".chat-sidebar.drawer");
  await list.getByRole("button", { name: "New chat", exact: true }).click();
  const menu = list.getByRole("menu", { name: "New chat", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * The pool's accounts, as its runs save them: one per agent, both called "Model pool". Their address is a port nothing
 * listens on (never llama.cpp's own 9931, which may be a real server on this Mac): the model list is answered by the
 * page, and no test here sends a message.
 */
async function poolAccounts(request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const made: Record<string, string> = {};
  for (const provider of ["claude", "codex"]) {
    const data = { provider, label: "Model pool", baseUrl: "http://127.0.0.1:9097", apiKey: "", models: [MODEL], contextWindow: 65536 };
    made[provider] = (await (await request.post(`${HUB}/api/accounts/endpoint`, { headers, data })).json()).id;
  }
  return made;
}

test("the New chat menu has one entry for the model pool, with its model and where it runs", async ({ page }) => {
  onPhone();
  await poolOffer(page, running);
  await page.goto("/");
  const menu = await openNewChat(page);
  // One entry, not one per agent, and it's a model of yours: above Group chat, with the agents above it.
  await expect(menu.getByRole("menuitem", { name: /Model pool/ })).toHaveCount(1);
  await expect(menu.getByText(`${MODEL} · across 3 machines · Ready`, { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([/Claude Code/, /Codex/, /Model pool/, /Group chat/]);
  await page.screenshot({ ...shot("new-chat-pool-390.png") });
  await noHorizontalOverflow(page);
});

test("the entry says what state the pool is in", async ({ page }) => {
  onPhone();
  const line = async (pool: PoolOffer) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await poolOffer(page, pool);
    await page.goto("/");
    const menu = await openNewChat(page);
    return (await menu.getByRole("menuitem", { name: /Model pool/ }).locator(".nc-item-help").textContent()) ?? "";
  };
  expect(await line(offer({ state: "off", ready: false, detail: null }))).toBe(`${MODEL} · across 3 machines · Off`);
  expect(await line(offer({ state: "downloading", ready: false, detail: "Downloading the model to linux-box…" }))).toBe(`${MODEL} · across 3 machines · Downloading…`);
  // A machine it needs didn't answer when Crosstalk last looked: the entry names it.
  expect(await line(offer({ state: "off", ready: false, missing: ["gaming-pc"] }))).toBe(`${MODEL} · across 3 machines · Needs gaming-pc`);
  // Never set up: it says what the pool would be, and goes last among your models.
  expect(await line(offer({ state: "off", ready: false, setUp: false, model: null, modelName: null, machines: ["Mac mini"], accounts: {} }))).toBe("One big model across your machines · Set it up");
  await noHorizontalOverflow(page);
});

test("a stopped pool offers to start it, says what that does, and starts nothing until you tap", async ({ page }) => {
  onPhone();
  const starts = await holdStarts(page);
  await poolOffer(page, offer({ state: "off", ready: false, detail: null }));
  await page.goto("/");
  const menu = await openNewChat(page);
  await menu.getByRole("menuitem", { name: /Model pool/ }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Model pool", exact: true });
  await expect(dialog).toBeVisible();
  // What starting does, and that it takes a while: the person is told before anything runs on any machine.
  await expect(dialog.getByText(/runs qwen3\.8-27b across 3 machines/)).toBeVisible();
  await expect(dialog.getByText(/installs llama\.cpp/)).toBeVisible();
  await expect(dialog.getByText(/few minutes/)).toBeVisible();
  expect(starts).toEqual([]);
  await page.screenshot({ ...shot("pool-start-ask-390.png") });
  await noHorizontalOverflow(page);
  // Only the tap starts it, and the chat waits for the pool to be running.
  await dialog.getByRole("button", { name: "Start the pool", exact: true }).click();
  await expect.poll(() => starts).toEqual(["POST"]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("a pool nobody has set up sends you to Settings → Model pool", async ({ page }) => {
  onPhone();
  const starts = await holdStarts(page);
  await poolOffer(page, offer({ state: "off", ready: false, setUp: false, model: null, modelName: null, machines: ["Mac mini"], accounts: {} }));
  await page.goto("/");
  const menu = await openNewChat(page);
  await menu.getByRole("menuitem", { name: /Model pool/ }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Model pool", exact: true });
  await expect(dialog.getByText(/runs one big model across your own machines/)).toBeVisible();
  await dialog.getByRole("button", { name: "Set up the model pool", exact: true }).click();
  // Settings, at the Model pool card, and nothing was started.
  await expect(page.getByRole("heading", { name: "Model pool", exact: true })).toBeVisible();
  expect(starts).toEqual([]);
});

test("one tap on a running pool starts a chat that says it is the pool and its model", async ({ page, request, token }) => {
  onPhone();
  const headers = { authorization: `Bearer ${token}` };
  const accounts = await poolAccounts(request, token);
  try {
    await poolModels(page);
    await poolOffer(page, offer({ accounts: { claude: accounts.claude, codex: accounts.codex } }));
    await page.goto("/");
    const menu = await openNewChat(page);
    await menu.getByRole("menuitem", { name: /Model pool/ }).click();
    const dialog = page.getByRole("dialog", { name: "New chat with Model pool", exact: true });
    await expect(dialog.getByText(`${MODEL} across 3 machines · driven by Claude Code`, { exact: true })).toBeVisible();
    // Which agent drives it stays yours to pick (the pool keeps an account for each).
    const agent = dialog.getByLabel("Agent", { exact: true });
    await expect(agent).toHaveValue("claude");
    await expect(agent.locator("option")).toHaveText(["Claude Code", "Codex"]);
    await page.screenshot({ ...shot("pool-new-chat-390.png") });
    await noHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(dialog).toBeHidden();
    // The chat is the pool: its name, its model and its own avatar in the header.
    const header = page.locator("header.topbar");
    await expect(header.getByText(`Model pool · ${MODEL}`, { exact: false })).toBeVisible();
    await expect(header.locator(".svc-avatar")).toBeVisible();
    await page.screenshot({ ...shot("pool-chat-390.png") });
    // Its model menu tells the truth: a pool runs one model at a time, and where that is changed.
    await page.locator("button.ctl-model").click();
    await expect(page.getByText(/Model pool runs one model at a time: qwen3\.8-27b\. Change it in Settings → Model pool\./)).toBeVisible();
    // The pool runs one model, so that's all the menu offers.
    await expect(page.locator(".pop-item")).toHaveCount(1);
    await noHorizontalOverflow(page);
  } finally {
    // The chat the app made goes with the test: cleanHub removes what a test added, rooms before accounts.
    for (const [provider, id] of Object.entries(accounts)) await request.delete(`${HUB}/api/accounts/${provider}/${id}`, { headers });
  }
});

test("a pool chat left without a pool says so in plain words, with a way out", async ({ page, request, token }) => {
  onPhone();
  const headers = { authorization: `Bearer ${token}` };
  const accounts = await poolAccounts(request, token);
  let roomId = "";
  try {
    await poolModels(page);
    // A chat on the pool, made while it ran; then the pool is stopped (a machine dropping off reads the same).
    const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Pool chat", account: accounts.claude, model: MODEL } })).json();
    roomId = room.id;
    await poolOffer(page, offer({ state: "error", ready: false, detail: "The helper on gaming-pc stopped: its window was closed.", accounts: { claude: accounts.claude, codex: accounts.codex } }));
    await page.goto(`/#/room/${room.id}`);
    await expect(page.locator("header.topbar").getByText(/Model pool/)).toBeVisible();
    // The model menu says what happened and the ways out that exist: start the pool again, or move the chat to another
    // account in its settings (this menu holds the pool's one model, so it never says "pick another model" here).
    await page.locator("button.ctl-model").click();
    await expect(page.getByText(/Model pool isn't running, so qwen3\.8-27b can't answer\. Start it in Settings → Model pool, or move this chat to another account in its settings\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Model pool", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("pool-chat-stopped-390.png") });
    // It leads to the one place the pool is started again.
    await page.getByRole("button", { name: "Open Model pool", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Model pool", exact: true })).toBeVisible();
  } finally {
    if (roomId) await request.delete(`${HUB}/api/rooms/${roomId}`, { headers });
    for (const [provider, id] of Object.entries(accounts)) await request.delete(`${HUB}/api/accounts/${provider}/${id}`, { headers });
  }
});

test("a machine that didn't answer is checked again from the entry, and still nothing starts on its own", async ({ page }) => {
  onPhone();
  const starts = await holdStarts(page);
  const checks = await holdChecks(page);
  await poolOffer(page, offer({ state: "off", ready: false, detail: null, missing: ["gaming-pc"] }));
  await page.goto("/");
  const menu = await openNewChat(page);
  await expect(menu.getByText(`${MODEL} · across 3 machines · Needs gaming-pc`, { exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Model pool/ }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with Model pool", exact: true });
  // What is known is what the last look found, and the button looks again: a machine that is back clears itself here.
  await expect(dialog.getByText(/gaming-pc didn't answer the last time Crosstalk looked/)).toBeVisible();
  await dialog.getByRole("button", { name: "Check the machines", exact: true }).click();
  await expect.poll(() => checks).toEqual(["POST"]);
  await expect(dialog.getByText(/Checked just now, and it still doesn't answer/)).toBeVisible();
  // Settings → Model pool stays a tap away, and nothing was started on anyone's machine.
  await expect(dialog.getByRole("button", { name: "Open Model pool", exact: true })).toBeVisible();
  expect(starts).toEqual([]);
  await page.screenshot({ ...shot("pool-missing-390.png") });
  await noHorizontalOverflow(page);
});

test("the pool is on both agents' screens, driven by the agent whose screen it is", async ({ page }) => {
  onPhone();
  const starts = await holdStarts(page);
  // Stopped, with the accounts its last run left behind: one per agent, so either can drive it.
  await poolOffer(page, offer({ state: "off", ready: false, detail: null, accounts: { claude: "pl1", codex: "pl2" } }));
  for (const [agent, name] of [["codex", "Codex"], ["claude", "Claude Code"]] as const) {
    await page.goto(`/#/agent/${agent}`);
    const card = page.getByRole("region", { name: `Models on ${name}`, exact: true });
    const row = card.getByRole("button", { name: /Model pool/ });
    await expect(row).toHaveCount(1);
    await row.click();
    const dialog = page.getByRole("dialog", { name: "New chat with Model pool", exact: true });
    await expect(dialog.getByText(new RegExp(`driven by ${name}`))).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  expect(starts).toEqual([]);
  await noHorizontalOverflow(page);
});
