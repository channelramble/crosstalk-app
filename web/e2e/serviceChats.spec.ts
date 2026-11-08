import type { Page, Route } from "@playwright/test";
import type { LocalServer, ModelCatalog, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Starting a chat with a model of your own, on a phone: the New chat menu lists the AI services you've added and the
// model servers running on this machine that aren't added yet, and the chat that follows says which service and model it
// is. The hub's own side of adding a found server is checked in hub/test/service-chats.test.ts; here it is played, so
// nothing reaches this Mac's real model servers.
const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });

const LLAMA = "llama.cpp (port 8080)";
const QWEN = "qwen3.8-9b";

/** A model server the hub says is running here. `accountIds` empty: nothing uses it yet, so the menu offers to add it. */
const found = (over: Partial<LocalServer> = {}): LocalServer => ({
  id: "llamacpp-8080",
  kind: "llamacpp",
  label: LLAMA,
  baseUrl: "http://127.0.0.1:8080",
  models: [{ id: QWEN, contextWindow: 16384, sizeBytes: null, loaded: true }],
  memoryBytes: null,
  // llama.cpp answers at /v1/responses and /v1/chat/completions: Codex speaks the first itself.
  protocols: { responses: "yes", messages: "unknown", chat: "yes" },
  accountIds: [],
  ...over,
});

const catalog = (models: { id: string; noTools?: boolean }[]): ModelCatalog => ({
  provider: "codex",
  live: true,
  error: null,
  models: models.map((m, i) => ({ id: m.id, label: m.id, description: null, efforts: [], defaultEffort: null, isDefault: i === 0, contextWindow: 16384, ...(m.noTools ? { noTools: true } : {}) })),
});

/** The servers the hub reports, and the model list of the service account the chat runs on. */
async function serversAndModels(page: Page, servers: LocalServer[], models: { id: string; noTools?: boolean }[]) {
  await page.route("**/api/local-servers**", (route: Route) => route.fulfill({ json: { servers, scannedAt: Date.now() } }));
  await page.route("**/api/providers/codex/models**", (route: Route) => route.fulfill({ json: catalog(models) }));
}

/** Opens the chats drawer on a phone and taps New chat. */
async function openNewChat(page: Page) {
  await page.getByRole("button", { name: /^Show chats/ }).click();
  const list = page.locator(".chat-sidebar.drawer");
  await list.getByRole("button", { name: "New chat", exact: true }).click();
  const menu = list.getByRole("menu", { name: "New chat", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

test("the New chat menu lists the agents, your services with their model, and a server running here", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  phone(page);
  // A service already added, the way Settings → AI services saves one.
  const service = await (
    await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: "Qwen here", baseUrl: "http://127.0.0.1:8099", apiKey: "", models: [QWEN, "qwen3.8-27b"], contextWindow: 16384 } })
  ).json();
  try {
    await serversAndModels(page, [found()], [{ id: QWEN }]);
    await page.goto("/");
    const menu = await openNewChat(page);
    // The agents first, then the service added, then the server found here, then the model pool (this hub's has no model
    // yet, so it's last of your models: a suggestion never pushes one you can use off the screen), then Group chat.
    await expect(menu.getByRole("menuitem")).toHaveText([/Claude Code/, /Codex/, /Qwen here/, new RegExp(LLAMA.replace(/[().]/g, "\\$&")), /Model pool/, /Group chat/]);
    await expect(menu.getByText(`${QWEN} · 2 models · on this machine`, { exact: true })).toBeVisible();
    await expect(menu.getByText(`${QWEN} · add it and start`, { exact: true })).toBeVisible();
    await page.screenshot({ ...shot("new-chat-menu-390.png") });
    await noHorizontalOverflow(page);
    // Home offers the same models, for the same one tap.
    await page.keyboard.press("Escape"); // closes the menu
    await page.locator(".chat-sidebar.drawer").getByRole("button", { name: "Close", exact: true }).click();
    const list = page.getByRole("region", { name: "Your models", exact: true });
    await expect(list.getByRole("button", { name: /Qwen here/ })).toBeVisible();
    await expect(list.getByRole("button", { name: new RegExp(LLAMA.replace(/[().]/g, "\\$&")) })).toBeVisible();
    await noHorizontalOverflow(page);
  } finally {
    await request.delete(`${HUB}/api/accounts/codex/${service.id}`, { headers });
  }
});

test("one tap on a server running here adds it and starts the chat, which says what it is", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  phone(page);
  // The hub's own POST /api/chats/service is checked in hub/test/service-chats.test.ts. Here it is played: the account
  // the hub would have made (the name the scan gives it) and a real chat on it, both made when the app asks — so until
  // Start is pressed, the server is one that isn't added yet, as it would really be.
  const asked: Record<string, unknown>[] = [];
  let accountId = "";
  let roomId = "";
  try {
    await serversAndModels(page, [found()], [{ id: QWEN }]);
    await page.route("**/api/chats/service", async (route: Route) => {
      const body = route.request().postDataJSON();
      asked.push(body);
      const account = await (
        await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: body.label, baseUrl: body.baseUrl, apiKey: "", models: [body.model], contextWindow: 16384, protocol: "chat" } })
      ).json();
      accountId = account.id;
      const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", account: account.id, model: body.model, permissionMode: body.permissionMode, name: body.name } })).json();
      roomId = room.id;
      await route.fulfill({ json: { room, account, added: true } });
    });
    // Codex's own defaults, made for its own sign-in: a model, an effort and a helper model that only OpenAI serves.
    await page.route("**/api/settings/defaults", (route: Route) =>
      route.fulfill({ json: { mode: "direct", agents: ["codex"], maxHops: 5, rounds: 1, parallel: false, agent: { codex: { account: "default", model: "gpt-5.1-codex", effort: "high", helperModel: "gpt-5.1-codex-mini", permissionMode: "ask" } } } }),
    );
    await page.goto("/");
    const menu = await openNewChat(page);
    await menu.getByRole("menuitem", { name: new RegExp(LLAMA.replace(/[().]/g, "\\$&")) }).click();

    const dialog = page.getByRole("dialog", { name: `New chat with ${LLAMA}`, exact: true });
    await expect(dialog).toBeVisible();
    // It says plainly that it will be added first, and which model it will run.
    await expect(dialog.getByText(/Starting adds it to your AI services first/)).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(QWEN);
    // The server's model takes the defaults' place, and nothing of the other account rides along: this server has no
    // effort levels (so there is no field to clear it in) and doesn't serve the helper model Codex's defaults name.
    await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveCount(0);
    await page.screenshot({ ...shot("new-chat-local-server-390.png") });
    await noHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();

    // The chat opens, and says it is that server's, not Codex's.
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    const top = page.locator("header.topbar");
    await expect(top).toContainText(LLAMA);
    await expect(top).toContainText(QWEN);
    await expect(top).not.toContainText("Codex");
    await expect(page.getByLabel(LLAMA, { exact: true }).first()).toBeVisible();
    // What the app asked the hub for: that server, its name, and the model the dialog showed.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ baseUrl: "http://127.0.0.1:8080", label: LLAMA, provider: "codex", model: QWEN, effort: null, helperModel: null });
    // The chat list puts it under the service, not under Codex.
    await page.getByRole("button", { name: /^Show chats/ }).click();
    await expect(page.getByRole("button", { name: `New chat with ${LLAMA}, on this machine`, exact: true })).toBeVisible();
    await page.screenshot({ ...shot("chat-list-service-group-390.png") });
    await noHorizontalOverflow(page);
  } finally {
    if (roomId) await request.delete(`${HUB}/api/rooms/${roomId}`, { headers });
    if (accountId) await request.delete(`${HUB}/api/accounts/codex/${accountId}`, { headers });
  }
});

test("a model that can't run tools says so before the chat starts, and starts anyway", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  phone(page);
  const account = await (
    await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: "Venice", baseUrl: "https://api.venice.ai/api", apiKey: "k", models: ["venice-talker"], contextWindow: 32768 } })
  ).json();
  let roomId = "";
  try {
    // Venice says three of its models can't run tool calls: this one is marked everywhere it's offered.
    await serversAndModels(page, [], [{ id: "venice-talker", noTools: true }]);
    await page.route("**/api/settings/defaults", (route: Route) => route.fulfill({ json: { mode: "direct", agents: ["codex"], maxHops: 5, rounds: 1, parallel: false, agent: {} } }));
    await page.goto("/");
    const menu = await openNewChat(page);
    await menu.getByRole("menuitem", { name: /Venice/ }).click();

    const dialog = page.getByRole("dialog", { name: "New chat with Venice", exact: true });
    await expect(dialog.getByRole("note")).toContainText("venice-talker can talk, but it can't read files or run commands.");
    await expect(dialog.getByRole("note")).toContainText("You can still start the chat and ask it things.");
    await page.screenshot({ ...shot("new-chat-no-tools-390.png") });
    await noHorizontalOverflow(page);
    // Said plainly, and still allowed: Start chat works.
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    roomId = new URL(page.url()).hash.split("/").pop()!;
    const state = await (await request.get(`${HUB}/api/state`, { headers })).json();
    const member = state.members.find((m: { roomId: string }) => m.roomId === roomId);
    expect(member.config.account).toBe(account.id);
    expect(member.model).toBe("venice-talker");
  } finally {
    if (roomId) await request.delete(`${HUB}/api/rooms/${roomId}`, { headers });
    await request.delete(`${HUB}/api/accounts/codex/${account.id}`, { headers });
  }
});

test("a model too small for your own Codex plugins says the chat runs without them, before it starts", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  phone(page);
  // A 16k model of your own: room to work in, but Codex's own plugins and ChatGPT app connectors are far bigger than the
  // whole window, so the chat runs without them (hub/src/agents/codex.ts). Said here, where the model is picked.
  const account = await (
    await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: "Qwen small", baseUrl: "http://127.0.0.1:8099", apiKey: "", models: [QWEN], contextWindow: 16384 } })
  ).json();
  let roomId = "";
  try {
    await serversAndModels(page, [], [{ id: QWEN }]);
    await page.route("**/api/settings/defaults", (route: Route) => route.fulfill({ json: { mode: "direct", agents: ["codex"], maxHops: 5, rounds: 1, parallel: false, agent: {} } }));
    await page.goto("/");
    const menu = await openNewChat(page);
    await menu.getByRole("menuitem", { name: /Qwen small/ }).click();

    const dialog = page.getByRole("dialog", { name: "New chat with Qwen small", exact: true });
    await expect(dialog.getByRole("note")).toContainText(`${QWEN} holds 16,384 tokens`);
    await expect(dialog.getByRole("note")).toContainText("Codex's own tools and Crosstalk's only");
    await page.screenshot({ ...shot("new-chat-lean-tools-390.png") });
    await noHorizontalOverflow(page);
    // Nothing is stopped by it: the chat starts as any other.
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    roomId = new URL(page.url()).hash.split("/").pop()!;
  } finally {
    if (roomId) await request.delete(`${HUB}/api/rooms/${roomId}`, { headers });
    await request.delete(`${HUB}/api/accounts/codex/${account.id}`, { headers });
  }
});

test("a server running here whose model can't run tools is marked in the menu and before the chat starts", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  phone(page);
  let accountId = "";
  let roomId = "";
  try {
    // The scan says this one can't run tool calls, so the menu knows before anything is tapped.
    await serversAndModels(page, [found({ label: "Talker (port 8080)", models: [{ id: "talker", contextWindow: 8192, sizeBytes: null, loaded: true, tools: false }] })], [{ id: "talker", noTools: true }]);
    await page.route("**/api/chats/service", async (route: Route) => {
      const body = route.request().postDataJSON();
      const account = await (
        await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: body.label, baseUrl: body.baseUrl, apiKey: "", models: [body.model], contextWindow: 8192, protocol: "chat" } })
      ).json();
      accountId = account.id;
      const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", account: account.id, model: body.model } })).json();
      roomId = room.id;
      await route.fulfill({ json: { room, account, added: true } });
    });
    await page.route("**/api/settings/defaults", (route: Route) => route.fulfill({ json: { mode: "direct", agents: ["codex"], maxHops: 5, rounds: 1, parallel: false, agent: {} } }));
    await page.goto("/");
    const menu = await openNewChat(page);
    const row = menu.getByRole("menuitem", { name: /Talker/ });
    await expect(row).toContainText("No tools");
    await row.click();
    const dialog = page.getByRole("dialog", { name: "New chat with Talker (port 8080)", exact: true });
    await expect(dialog.getByRole("note")).toContainText("talker can talk, but it can't read files or run commands.");
    await noHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  } finally {
    if (roomId) await request.delete(`${HUB}/api/rooms/${roomId}`, { headers });
    if (accountId) await request.delete(`${HUB}/api/accounts/codex/${accountId}`, { headers });
  }
});
