import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { Page, Route, WebSocketRoute } from "@playwright/test";

const HUB = "http://127.0.0.1:8451";

/** A Claude Code chat on the test hub, opened, and its settings' Duplicate chat… popup. */
async function openDuplicate(page: Page, roomId: string) {
  await page.goto(`/#/room/${roomId}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Chat settings", exact: true });
  await settings.getByRole("button", { name: "Duplicate chat…", exact: true }).click();
  await expect(settings).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "Duplicate chat", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The test hub's live updates, played by the test (it answers pings; `last()` sends to the app). A socket passed
 * through to the hub can get a frame after the app's development double start has closed it, which the browser mock
 * reports as a page error, so what a test checks on the hub it reads through the API.
 */
async function liveUpdates(page: Page) {
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", (ws) => {
    socket = ws;
    pong(ws);
  });
  return { last: () => socket };
}
const pong = (ws: WebSocketRoute) => ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });

/** The popup fits a phone: nothing sticks out sideways. */
async function fits(page: Page) {
  await noHorizontalOverflow(page);
  const box = (await page.locator(".dialog").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test("Duplicate chat… asks where, how, which folder and what name, then opens the copy with its line at the top", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Fix login", model: "claude-model", effort: "high", permissionMode: "edits" } })).json();
  const dialog = await openDuplicate(page, room.id);
  // Where: this chat's own agent and account, picked, among the others.
  const claude = dialog.getByRole("radio", { name: /^Claude Code: / });
  await expect(claude).toHaveAttribute("aria-checked", "true");
  await expect(claude).toContainText("This chat's");
  await expect(dialog.getByRole("radio", { name: /^Codex: / })).toBeEnabled();
  await expect(dialog.getByText("It remembers what Claude Code remembers in this chat.", { exact: true })).toBeVisible();
  // How: the same as this chat, shown.
  await expect(dialog.getByText("Model, effort and helper agents: as in this chat.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("claude-model");
  await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveValue("high");
  // Which folder, and its name.
  await expect(dialog.getByRole("radio", { name: /^This chat's folder/ })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: /^This chat's folder/ })).toContainText(room.cwd);
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Fix login (copy)");
  await fits(page);

  // Another agent: its own defaults, never this chat's model for it.
  await dialog.getByRole("radio", { name: /^Codex: / }).click();
  await expect(dialog.getByRole("radio", { name: /^Codex: / })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByText("Model, effort and helper agents: Codex's defaults.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^Codex reads this conversation/)).toBeVisible();
  const model = dialog.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("");
  await expect(model.locator("option").first()).toHaveText("Default (codex model)");
  await dialog.getByRole("combobox", { name: "Effort", exact: true }).selectOption("low");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Login on Codex");
  await fits(page);

  const sent = page.waitForRequest((r) => r.url().endsWith(`/api/chats/${room.id}/duplicate`) && r.method() === "POST");
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  // Exactly what the popup showed.
  expect((await sent).postDataJSON()).toEqual({ provider: "codex", account: "default", model: null, effort: "low", helperModel: null, folder: "same", name: "Login on Codex" });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".topbar h1")).toHaveText("Login on Codex");
  const top = page.locator(".msg.system .sys").first();
  await expect(top).toHaveText('Copied from "Fix login" (Claude Code)');
  await noHorizontalOverflow(page);

  // The line links back to the original, whose own line links to the copy.
  await top.getByRole("link", { name: "Fix login", exact: true }).click();
  await expect(page.locator(".topbar h1")).toHaveText("Fix login");
  const line = page.locator(".msg.system .sys").last();
  await expect(line).toHaveText('Duplicated to "Login on Codex"');
  await line.getByRole("link", { name: "Login on Codex", exact: true }).click();
  await expect(page.locator(".topbar h1")).toHaveText("Login on Codex");
  const copy = (await (await request.get(`${HUB}/api/state`, { headers })).json()).rooms.find((r: { name: string }) => r.name === "Login on Codex");
  const member = (await (await request.get(`${HUB}/api/state`, { headers })).json()).members.find((m: { roomId: string }) => m.roomId === copy.id);
  expect([member.provider, member.model, member.config.effort ?? null, copy.cwd]).toEqual(["codex", null, "low", room.cwd]);
});

test("agents and accounts that can't take the copy are listed, disabled, saying why", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Fix login" } })).json();
  const at = Date.now();
  // A custom model, a sign-in that's signed out, and Codex not installed.
  await page.route("**/api/state", async (route) => {
    const state = await (await route.fetch()).json();
    state.providers = state.providers.map((p: { provider: string }) => (p.provider === "codex" ? { ...p, installed: false } : p));
    state.accounts.push(
      { provider: "claude", id: "qwen", label: "Qwen local", kind: "endpoint", endpoint: { baseUrl: "http://127.0.0.1:8080", models: ["qwen"], contextWindow: 32768, hasKey: false }, signedIn: true, account: null, plan: null, authMethod: "endpoint", error: null, checkedAt: at },
      { provider: "claude", id: "personal", label: "Personal", kind: "signin", signedIn: false, account: null, plan: null, authMethod: null, error: null, checkedAt: at },
    );
    await route.fulfill({ json: state });
  });
  const dialog = await openDuplicate(page, room.id);
  await expect(dialog.getByRole("radio", { name: "Codex: Not installed", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "Personal: Not signed in", exact: true })).toBeDisabled();
  const qwen = dialog.getByRole("radio", { name: "Qwen local: Custom model · Claude Code", exact: true });
  await expect(qwen).toBeEnabled();
  // One machine: no machine headings.
  await expect(dialog.locator(".dup-machine-name")).toHaveCount(0);
  await qwen.click();
  await expect(dialog.getByText("Model, effort and helper agents: Qwen local's defaults.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^Qwen local reads this conversation/)).toBeVisible();
  await fits(page);
});

test("while the agent is working, Duplicate waits for it to finish, or it can be stopped", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Busy chat" } })).json();
  const member = (await (await request.get(`${HUB}/api/state`, { headers })).json()).members.find((m: { roomId: string }) => m.roomId === room.id);
  const live = await liveUpdates(page);
  const dialog = await openDuplicate(page, room.id);
  await expect.poll(() => live.last()).not.toBeNull();
  live.last()!.send(JSON.stringify({ t: "member", member: { ...member, status: "working", statusDetail: "Working" } }));
  const busy = dialog.getByRole("status");
  await expect(busy).toContainText("Claude Code is working. Duplicate waits for it to finish, or stop it first.");
  await expect(busy.getByRole("button", { name: "Stop Claude Code", exact: true })).toBeVisible();
  let posted = false;
  page.on("request", (r) => { if (r.url().endsWith(`/api/chats/${room.id}/duplicate`)) posted = true; });
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(busy).toContainText("Waiting for Claude Code to finish, then duplicating.");
  await expect(dialog.getByRole("button", { name: "Waiting…", exact: true })).toBeDisabled();
  await page.waitForTimeout(300);
  expect(posted).toBe(false);
  await fits(page);
  // The reply ends: the copy is made.
  const sent = page.waitForRequest((r) => r.url().endsWith(`/api/chats/${room.id}/duplicate`) && r.method() === "POST");
  live.last()!.send(JSON.stringify({ t: "member", member: { ...member, status: "idle", statusDetail: null } }));
  await sent;
  await expect(page.locator(".topbar h1")).toHaveText("Busy chat (copy)");
});

test("waiting for your answer to a request: the popup says so, doesn't wait, and shows the request", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Asking chat" } })).json();
  const member = (await (await request.get(`${HUB}/api/state`, { headers })).json()).members.find((m: { roomId: string }) => m.roomId === room.id);
  const live = await liveUpdates(page);
  const dialog = await openDuplicate(page, room.id);
  await expect.poll(() => live.last()).not.toBeNull();
  const approval = { id: "ap_dup1", roomId: room.id, memberId: member.id, turnId: null, kind: "command", title: "npm publish", detail: "npm publish", status: "pending", decision: null, decidedBy: null, createdAt: Date.now(), decidedAt: null, always: "Always allow `npm publish` commands" };
  live.last()!.send(JSON.stringify({ t: "approval", approval }));
  live.last()!.send(JSON.stringify({ t: "member", member: { ...member, status: "approval", statusDetail: "npm publish" } }));
  const busy = dialog.getByRole("status");
  await expect(busy).toHaveText(/^Claude Code is waiting for your answer to its request in this chat\. Answer it or stop it, then duplicate\./);
  await expect(busy.getByRole("button", { name: "Stop Claude Code", exact: true })).toBeVisible();
  // Nothing to wait for: the reply can't end until the request is answered.
  await expect(dialog.getByRole("button", { name: "Duplicate", exact: true })).toBeDisabled();
  await fits(page);
  await busy.getByRole("button", { name: "Show the request", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.locator(`.messages [data-approval="${approval.id}"]`);
  await expect(card).toBeInViewport();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeFocused();
});

test("this machine on an older Crosstalk: a clear error, not a bare 'not found'", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Fix login" } })).json();
  const here = (await (await request.get(`${HUB}/api/state`, { headers })).json()).hub.name as string;
  await page.route(`**/api/chats/${room.id}/duplicate`, (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const dialog = await openDuplicate(page, room.id);
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(`${here} runs an older Crosstalk that can't duplicate chats. Update Crosstalk there, then try again.`);
  await expect(dialog.getByRole("button", { name: "Duplicate", exact: true })).toBeEnabled();
});

test("a conversation open in the Claude app: send again once it's closed, or go on in a copy (an older machine's own way)", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Open elsewhere" } })).json();
  const state = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member = state.members.find((m: { roomId: string }) => m.roomId === room.id);
  const error = "This conversation is open in the Claude app right now. Close it there, then send your message again. Or duplicate this chat to go on in a copy.";
  const blocked = { ...member, status: "error", statusDetail: error };
  const older = { value: false };
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    s.members = s.members.map((m: { id: string }) => (m.id === member.id ? blocked : m));
    if (older.value) s.hub = { ...s.hub, version: "0.2.0" };
    await route.fulfill({ json: s });
  });
  await page.goto(`/#/room/${room.id}`);
  const note = page.getByRole("note").filter({ hasText: "open in the Claude app" });
  await expect(note).toContainText("Close it there, then send your message again. Or duplicate it to go on in a copy (the original stays as it is).");
  await expect(note.getByRole("button", { name: "Duplicate…", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  // A machine on 0.2.0 can't duplicate: its own Continue in a copy is offered.
  older.value = true;
  let copied = 0;
  await page.route(`**/api/chats/${room.id}/copy`, (route) => (copied++, route.fulfill({ json: { ok: true } })));
  await page.reload();
  await expect(note.getByRole("button", { name: "Duplicate…" })).toHaveCount(0);
  await note.getByRole("button", { name: "Continue in a copy", exact: true }).click();
  await expect.poll(() => copied).toBe(1);
  await expect(note).toHaveCount(0);
});

/** Another machine, "Linux box", that this device is paired with: its hub is played by the test. */
async function linuxBox(page: Page, token: string, opts: { older?: boolean } = {}) {
  const base = "http://127.0.0.1:8459";
  await page.addInitScript(({ token, base }) => {
    localStorage.setItem("crosstalk.machines.v1", JSON.stringify({ list: [{ baseUrl: "", token, deviceName: "Browser tests" }, { baseUrl: base, token: "linux-box-token", deviceName: "Browser tests" }], active: "" }));
  }, { token, base });
  const cors = { "access-control-allow-origin": "http://127.0.0.1:5198", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" };
  const at = Date.now();
  const rooms: Record<string, unknown>[] = [];
  const members: Record<string, unknown>[] = [];
  const copies: Record<string, unknown>[] = [];
  const hub = { version: "test", hostname: "linux-box", platform: "linux", workspaceRoot: "/home/me/Crosstalk", publicUrl: null, id: "h_linux", name: "Linux box" };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${base}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/state")
      return json(route, {
        hub,
        rooms,
        members,
        approvals: [],
        usage: [],
        roomActivity: {},
        device: { id: "d1", name: "Browser tests", platform: "Web", createdAt: at, lastSeenAt: at },
        providers: [
          { provider: "codex", installed: true, version: "test", binPath: null, signedIn: true, account: "me@linux", plan: null, authMethod: null, error: null, checkedAt: at },
          { provider: "claude", installed: false, version: null, binPath: null, signedIn: null, account: null, plan: null, authMethod: null, error: null, checkedAt: at },
        ],
        accounts: [{ provider: "codex", id: "default", label: "Main", kind: "signin", signedIn: true, account: "me@linux", plan: null, authMethod: null, error: null, checkedAt: at }],
      });
    if (path === "/api/settings/defaults") return json(route, { mode: "review", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: { codex: { permissionMode: "auto", model: "gpt-linux", effort: "medium" } } });
    if (path.startsWith("/api/providers/codex/models")) return json(route, { provider: "codex", live: true, error: null, models: [{ id: "gpt-linux", label: "gpt-linux", description: null, efforts: ["low", "medium"], defaultEffort: "low", isDefault: true }] });
    if (path === "/api/chats/duplicate" && req.method() === "POST") {
      if (opts.older) return json(route, { error: "not found" }, 404);
      const body = req.postDataJSON();
      copies.push(body);
      const room = { id: "r_linuxcopy", name: body.name, cwd: "/home/me/Crosstalk/fix-login-copy", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "codex", origin: "web" } };
      rooms.push(room);
      members.push({ id: "mb_linux", roomId: room.id, handle: "codex", provider: "codex", model: body.model, role: "", permissionMode: "auto", status: "idle", statusDetail: null, config: body.effort ? { effort: body.effort } : {}, createdAt: at, position: 0 });
      return json(route, room);
    }
    if (path === "/api/rooms/r_linuxcopy/history") {
      const from = copies[0]?.from as { chat: { id: string; name: string }; machine: { name: string } };
      const line = { id: "m_top", roomId: "r_linuxcopy", authorKind: "system", memberId: null, authorName: "Crosstalk", text: `Copied from "${from.chat.name}" (Claude Code) on ${from.machine.name}`, mentions: [], turnId: null, status: "done", createdAt: at, updatedAt: at, copy: { kind: "from", agent: "Claude Code", provider: "claude", chatId: from.chat.id, chatName: from.chat.name, machine: from.machine.name } };
      return json(route, { room: rooms[0], messages: [line], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false });
    }
    return json(route, { error: "not found" }, 404);
  });
  // Both machines' live updates are played here (see liveUpdates).
  await liveUpdates(page);
  await page.routeWebSocket(`${base.replace("http", "ws")}/api/ws?**`, pong);
  return { copies };
}

test("another machine: the app reads the chat here, that machine's hub makes the copy, and the original links to it", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Fix login", model: "claude-model", effort: "high" } })).json();
  const here = (await (await request.get(`${HUB}/api/state`, { headers })).json()).hub.name as string;
  const linux = await linuxBox(page, token);
  const dialog = await openDuplicate(page, room.id);
  // Grouped by machine, this chat's first; there, Claude Code isn't installed.
  await expect(dialog.locator(".dup-machine-name")).toHaveText([`${here} · this chat's machine`, "Linux box"]);
  await expect(dialog.getByRole("radio", { name: "Claude Code on Linux box: Not installed", exact: true })).toBeDisabled();
  await dialog.getByRole("radio", { name: "Codex on Linux box: me@linux", exact: true }).click();
  await expect(dialog.getByText("Model, effort and helper agents: Codex's defaults on Linux box.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("gpt-linux");
  await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveValue("medium");
  // Another machine: always a new folder there.
  const folders = dialog.getByRole("radiogroup", { name: "Folder", exact: true }).getByRole("radio");
  await expect(folders).toHaveCount(1);
  await expect(folders).toContainText(`On Linux box. The files stay on ${here}.`);
  await fits(page);

  const exported = page.waitForResponse((r) => r.url().endsWith(`/api/chats/${room.id}/export`));
  const noted = page.waitForResponse((r) => r.url().endsWith(`/api/chats/${room.id}/duplicated`));
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  expect((await exported).status()).toBe(200);
  expect((await noted).status()).toBe(200);
  expect(linux.copies).toHaveLength(1);
  expect(linux.copies[0]).toMatchObject({ provider: "codex", account: "default", model: "gpt-linux", effort: "medium", helperModel: null, folder: "new", name: "Fix login (copy)", from: { chat: { id: room.id, name: "Fix login", provider: "claude", agent: "Claude Code" }, machine: { name: here }, messages: [] } });
  // The copy opens on that machine.
  await expect(page.locator(".topbar h1")).toHaveText("Fix login (copy)");
  await expect(page.locator(".msg.system .sys").first()).toHaveText(`Copied from "Fix login" (Claude Code) on ${here}`);
  const history = await (await request.get(`${HUB}/api/rooms/${room.id}/history`, { headers })).json();
  expect(history.messages.at(-1)).toMatchObject({ authorKind: "system", text: 'Duplicated to "Fix login (copy)" on Linux box', copy: { kind: "to", chatId: "r_linuxcopy", machine: "Linux box" } });
});

test("another machine with an older Crosstalk: a clear error, and the popup stays to try again", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Fix login" } })).json();
  await linuxBox(page, token, { older: true });
  const dialog = await openDuplicate(page, room.id);
  await dialog.getByRole("radio", { name: "Codex on Linux box: me@linux", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("gpt-linux");
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Linux box runs an older Crosstalk that can't duplicate chats. Update Crosstalk there, then try again.");
  await expect(dialog.getByRole("button", { name: "Duplicate", exact: true })).toBeEnabled();
  await fits(page);
  // Nothing was noted in the original.
  const history = await (await request.get(`${HUB}/api/rooms/${room.id}/history`, { headers })).json();
  expect(history.messages).toEqual([]);
});

test("a copy shows the copied replies as their agent's, and only its own messages can be edited or rewound to", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", name: "Fix login (copy)" } })).json();
  const member = (await (await request.get(`${HUB}/api/state`, { headers })).json()).members.find((m: { roomId: string }) => m.roomId === room.id);
  const t0 = room.createdAt as number;
  let seq = 0;
  const msg = (authorKind: string, text: string, createdAt: number, extra: Record<string, unknown> = {}) => ({ id: `dup-${++seq}`, seq, roomId: room.id, authorKind, authorName: authorKind === "human" ? "iPhone" : authorKind === "agent" ? "claude" : "Crosstalk", memberId: null, text, mentions: [], turnId: null, status: "done", createdAt, updatedAt: createdAt, ...extra });
  const copiedReply = { copy: { kind: "reply", agent: "Claude Code", provider: "claude" } };
  const messages = [
    msg("system", 'Copied from "Fix login" (Claude Code)', t0 - 1_000_000, { copy: { kind: "from", agent: "Claude Code", provider: "claude", chatId: "r_gone", chatName: "Fix login" } }),
    msg("human", "Fix the login bug", t0 - 900_000),
    msg("agent", "Fixed it.", t0 - 800_000, copiedReply),
    msg("human", "Add a test", t0 - 700_000),
    msg("agent", "Added a test.", t0 - 600_000, copiedReply),
    msg("human", "Now the signup page", t0 + 1_000),
    msg("agent", "Done.", t0 + 2_000, { memberId: member.id, authorName: member.handle }),
  ];
  await page.route(`**/api/rooms/${room.id}/history**`, (route) => route.fulfill({ json: { room, messages, turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } }));
  await page.goto(`/#/room/${room.id}`);
  await expect(page.getByText("Done.", { exact: true })).toBeVisible();
  // The original is gone: its name isn't a link.
  await expect(page.locator(".msg.system .sys").first()).toHaveText('Copied from "Fix login" (Claude Code)');
  await expect(page.locator(".msg.system .sys a")).toHaveCount(0);
  // Copied replies keep the agent that wrote them; this chat's own reply is Codex's.
  const fixed = page.locator(".msg.agent").filter({ hasText: "Fixed it." });
  await expect(fixed.locator(".vendor")).toHaveText("Claude Code");
  await expect(fixed.locator(".avatar")).toHaveAttribute("aria-label", "Claude Code");
  await expect(page.locator(".msg.agent").filter({ hasText: "Done." }).locator(".vendor")).toHaveText("Codex");
  // A copied message can't be edited or unsent (it was never sent from here); one sent here can.
  await expect(page.locator(".your-msg").filter({ hasText: "Fix the login bug" })).toHaveCount(0);
  await expect(page.locator(".your-msg").filter({ hasText: "Add a test" })).toHaveCount(0);
  const mine = page.locator(".your-msg").filter({ hasText: "Now the signup page" });
  await mine.getByText("Now the signup page", { exact: true }).click();
  await expect(mine.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  // Rewinding to a copied reply would take back a copied message; to the last one, only what was said here.
  // (Every reply can be copied, copied replies too.)
  const fixedReply = page.locator(".agent-reply").filter({ hasText: "Fixed it." });
  await fixedReply.getByText("Fixed it.", { exact: true }).click();
  await expect(fixedReply.getByRole("button", { name: "Copy reply" })).toBeVisible();
  await expect(fixedReply.getByRole("button", { name: "Rewind to here" })).toHaveCount(0);
  const last = page.locator(".agent-reply").filter({ hasText: "Added a test." });
  await last.getByText("Added a test.", { exact: true }).click();
  await expect(last.getByRole("button", { name: "Rewind to here", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});
