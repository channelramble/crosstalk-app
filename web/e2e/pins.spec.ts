import type { APIRequestContext, Browser, Locator, Page, Request } from "@playwright/test";
import type { Room } from "@crosstalk/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { otherMachine } from "./otherMachine";

// Pinned chats (ChatRow.tsx, pins.ts) and naming a chat in New chat. Phone flows run in the 320 and 390 projects at
// their width, the rest once each.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const project = () => test.info().project.name;
/**
 * The app's own hub socket, held by the test: with a second machine mocked Playwright stands in for every socket, and one it
 * only passes through is connected after the page has already closed it (the dev app starts twice, in React's strict mode, and
 * the first start's sockets close at once), so the hub's hello reaches a socket the mock knows is closed and it throws. Held,
 * the close is sent on to the hub with it.
 */
const holdHubSocket = (page: Page) => page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", (ws) => void ws.connectToServer());
const later = () => new Promise<void>((done) => setTimeout(done, 15));
const onPhones = () => test.skip(!/-(320|390)$/.test(project()), "Phone widths: the 320 and 390 projects.");
const once = () => test.skip(!/-390$/.test(project()), "Once per browser, at 390.");

async function chat(request: APIRequestContext, token: string, name: string, provider: "claude" | "codex" = "codex") {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider, name } })).json();
  return { room, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** The test hub's chats as it keeps them, by id. */
async function saved(request: APIRequestContext, token: string): Promise<Map<string, Room>> {
  const state = await (await request.get(`${HUB}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
  return new Map((state.rooms as Room[]).map((r) => [r.id, r]));
}

/** The chat list: the drawer on a phone (opened), the docked list on a wide screen. */
async function chatList(page: Page) {
  const show = page.getByRole("button", { name: "Show chats", exact: true });
  if (await show.count()) await show.click();
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(side).toBeVisible();
  return side;
}

/** A chat's row in the list: its button, its ⋯ and its tray of options. */
const rowOf = (side: Locator, name: string) => side.locator(".csb-item").filter({ has: side.page().locator(".csb-chat-name", { hasText: new RegExp(`^${name}$`) }) });
const more = (row: Locator, name: string) => row.getByRole("button", { name: `Options for ${name}`, exact: true });
const tray = (row: Locator, name: string) => row.getByRole("group", { name: `Options for ${name}`, exact: true });
const pinnedNames = (side: Locator) => side.getByRole("region", { name: "Pinned", exact: true }).locator(".csb-chat-name").allTextContents();

/** Another device signed in to the same hub: its own browser, with its own page. */
async function secondDevice(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:5198", serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  await context.addInitScript((token) => localStorage.setItem("crosstalk.conn.v1", JSON.stringify({ baseUrl: "", token, deviceName: "Second device" })), token);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors, close: () => context.close() };
}

/** The pin requests a page sends, to the hub it came from (`home`) and to other machines. */
function pinRequests(page: Page) {
  const sent: { home: boolean; id: string; body: unknown }[] = [];
  page.on("request", (r: Request) => {
    const url = new URL(r.url());
    const m = /^\/api\/rooms\/([^/]+)\/pin$/.exec(url.pathname);
    if (m && r.method() === "POST") sent.push({ home: url.origin === "http://127.0.0.1:5198", id: decodeURIComponent(m[1]), body: r.postDataJSON() });
  });
  return sent;
}

test("on a phone, chats are pinned from the list, moved up and down, kept after a reload, and unpinned", async ({ page, request, token }) => {
  onPhones();
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 844 });
  const tag = Math.random().toString(36).slice(2, 6);
  // Made a moment apart: the list puts the newer first, and two made in the same millisecond (the hub takes about two) would tie.
  const a = await chat(request, token, `Alpha ${tag}`);
  await later();
  const b = await chat(request, token, `Bravo ${tag}`);
  await later();
  const c = await chat(request, token, `Charlie ${tag}`);
  const made = await saved(request, token);
  try {
    await page.goto("/");
    let side = await chatList(page);
    await expect(side.getByRole("region", { name: "Pinned", exact: true })).toHaveCount(0);

    // Alpha's ⋯ (finger-sized) opens its options just under it.
    const alpha = rowOf(side, a.room.name);
    expect((await more(alpha, a.room.name).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await more(alpha, a.room.name).click();
    await expect(more(alpha, a.room.name)).toHaveAttribute("aria-expanded", "true");
    const pinIt = tray(alpha, a.room.name).getByRole("button", { name: "Pin to top", exact: true });
    await expect(pinIt).toBeVisible();
    expect((await pinIt.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`pins-tray-${width}.png`), animations: "disabled" });
    await pinIt.click();
    // Under Pinned now; the tray closed, and focus is on its ⋯ there.
    await expect.poll(() => pinnedNames(side)).toEqual([a.room.name]);
    await expect(tray(alpha, a.room.name)).toHaveCount(0);
    await expect(side.getByRole("region", { name: "Pinned", exact: true }).getByRole("button", { name: `Options for ${a.room.name}`, exact: true })).toBeFocused();

    // A second pin goes above the first.
    const bravo = rowOf(side, b.room.name);
    await more(bravo, b.room.name).click();
    await tray(bravo, b.room.name).getByRole("button", { name: "Pin to top", exact: true }).click();
    await expect.poll(() => pinnedNames(side)).toEqual([b.room.name, a.room.name]);

    // Move down, then up: the tray stays open where the row goes, on the button that's left.
    await more(bravo, b.room.name).click();
    const options = tray(bravo, b.room.name);
    await expect(options).toContainText("1 of 2");
    await expect(options.getByRole("button", { name: "Move up", exact: true })).toHaveCount(0);
    await options.getByRole("button", { name: "Move down", exact: true }).click();
    await expect.poll(() => pinnedNames(side)).toEqual([a.room.name, b.room.name]);
    await expect(options).toContainText("2 of 2");
    await expect(options.getByRole("button", { name: "Move up", exact: true })).toBeFocused();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`pins-moved-${width}.png`), animations: "disabled" });
    await options.getByRole("button", { name: "Move up", exact: true }).click();
    await expect.poll(() => pinnedNames(side)).toEqual([b.room.name, a.room.name]);
    await expect(options.getByRole("button", { name: "Move down", exact: true })).toBeFocused();
    // Escape closes it, back on its ⋯.
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await expect(more(bravo, b.room.name)).toBeFocused();

    // Kept by the hub, without moving anything in the recency list.
    let now = await saved(request, token);
    expect(now.get(b.room.id)!.pinOrder!).toBeLessThan(now.get(a.room.id)!.pinOrder!);
    for (const x of [a, b, c]) expect(now.get(x.room.id)!.updatedAt).toBe(made.get(x.room.id)!.updatedAt);

    // The same after a reload.
    await page.reload();
    side = await chatList(page);
    await expect.poll(() => pinnedNames(side)).toEqual([b.room.name, a.room.name]);

    // Unpinned: back with its agent's chats, by when it was last used (Charlie is newer), and still in view.
    await more(bravo, b.room.name).click();
    await tray(bravo, b.room.name).getByRole("button", { name: "Unpin", exact: true }).click();
    await expect.poll(() => pinnedNames(side)).toEqual([a.room.name]);
    const codex = side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Codex" }) });
    await expect.poll(() => codex.locator(".csb-chat-name").allTextContents()).toEqual([c.room.name, b.room.name]);
    await expect(more(bravo, b.room.name)).toBeFocused();
    now = await saved(request, token);
    expect(now.get(b.room.id)?.pinnedAt).toBeUndefined();
    expect(now.get(b.room.id)?.pinOrder).toBeUndefined();
    expect(now.get(b.room.id)!.updatedAt).toBe(made.get(b.room.id)!.updatedAt);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`pins-list-${width}.png`), animations: "disabled" });

    // The last one unpinned: no Pinned heading left.
    await more(alpha, a.room.name).click();
    await tray(alpha, a.room.name).getByRole("button", { name: "Unpin", exact: true }).click();
    await expect(side.getByRole("region", { name: "Pinned", exact: true })).toHaveCount(0);
  } finally {
    await a.cleanup();
    await b.cleanup();
    await c.cleanup();
  }
});

test("a pin made on one device shows on another at once, and so does an unpin", async ({ page, request, token, browser }) => {
  once();
  await page.setViewportSize({ width: 390, height: 844 });
  const x = await chat(request, token, `Shared pin ${Math.random().toString(36).slice(2, 6)}`);
  const second = await secondDevice(browser, token);
  try {
    await page.goto("/");
    await second.page.goto("/");
    const side = await chatList(page);
    const other = await chatList(second.page);
    await expect(rowOf(other, x.room.name)).toBeVisible();
    const row = rowOf(side, x.room.name);
    await more(row, x.room.name).click();
    await tray(row, x.room.name).getByRole("button", { name: "Pin to top", exact: true }).click();
    await expect.poll(() => pinnedNames(other)).toEqual([x.room.name]);
    // Unpinned from a third (the hub's own API): gone from Pinned on both.
    await request.post(`${HUB}/api/rooms/${x.room.id}/pin`, { headers: { authorization: `Bearer ${token}` }, data: { pinned: false } });
    await expect(other.getByRole("region", { name: "Pinned", exact: true })).toHaveCount(0);
    await expect(side.getByRole("region", { name: "Pinned", exact: true })).toHaveCount(0);
    expect(second.errors).toEqual([]);
  } finally {
    await second.close();
    await x.cleanup();
  }
});

test("a machine with an older Crosstalk says to update it, and its chat stays where it was", async ({ page, token }) => {
  once();
  await page.setViewportSize({ width: 390, height: 844 });
  const at = Date.now();
  const linuxRoom = { id: "r_linux_older", name: "Fix login", cwd: "/home/me/Crosstalk/fix-login", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "codex", origin: "web" } } as Room;
  // A hub from before pins: its chats come without pins, and it doesn't have the route.
  const linux = await otherMachine(page, token, { port: 8458, rooms: [linuxRoom] });
  await holdHubSocket(page);
  await page.goto("/");
  const side = await chatList(page);
  const row = rowOf(side, "Fix login");
  await more(row, "Fix login").click();
  await tray(row, "Fix login").getByRole("button", { name: "Pin to top", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "Update Crosstalk on Linux box to pin its chats." })).toBeVisible();
  await expect.poll(() => linux.pinned.map((p) => p.id)).toEqual(["r_linux_older"]);
  await expect(side.getByRole("region", { name: "Pinned", exact: true })).toHaveCount(0);
  // Still with its agent's chats, and Pin to top is still there to try once it's updated.
  const codex = side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Codex" }) });
  await expect(rowOf(codex, "Fix login")).toBeVisible();
  await expect(tray(row, "Fix login").getByRole("button", { name: "Pin to top", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("pins-older-machine.png"), animations: "disabled" });
});

test("two machines' pinned chats are one list in the order set, and a move writes only to the moved chat's machine", async ({ page, request, token }) => {
  once();
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const tag = Math.random().toString(36).slice(2, 6);
  const first = await chat(request, token, `Mac first ${tag}`);
  const third = await chat(request, token, `Mac third ${tag}`);
  const fresh = await chat(request, token, `Mac new ${tag}`, "claude");
  await request.post(`${HUB}/api/rooms/${first.room.id}/pin`, { headers, data: { pinned: true, order: 0 } });
  await request.post(`${HUB}/api/rooms/${third.room.id}/pin`, { headers, data: { pinned: true, order: 2 } });
  const at = Date.now();
  const linuxRoom = (id: string, name: string, order: number) => ({ id, name, cwd: `/home/me/Crosstalk/${id}`, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "claude", origin: "web" }, pinnedAt: at, pinOrder: order }) as Room;
  const second = `Linux second ${tag}`;
  const fourth = `Linux fourth ${tag}`;
  const linux = await otherMachine(page, token, { port: 8459, pins: true, rooms: [linuxRoom("r_linux_second", second, 1), linuxRoom("r_linux_fourth", fourth, 3)] });
  const sent = pinRequests(page);
  await holdHubSocket(page);
  try {
    await page.goto("/");
    const side = await chatList(page);
    await expect.poll(() => pinnedNames(side)).toEqual([first.room.name, second, third.room.name, fourth]);
    // Each says which machine it's on.
    await expect(rowOf(side, fourth).locator(".machine-tag")).toHaveText("Linux");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("pins-two-machines.png"), animations: "disabled" });

    // The Linux box's last one moves up, between its other one and the Mac's second: one request, to the Linux box.
    const row = rowOf(side, fourth);
    await more(row, fourth).click();
    await expect(tray(row, fourth)).toContainText("4 of 4");
    await tray(row, fourth).getByRole("button", { name: "Move up", exact: true }).click();
    await expect.poll(() => pinnedNames(side)).toEqual([first.room.name, second, fourth, third.room.name]);
    expect(sent).toEqual([{ home: false, id: "r_linux_fourth", body: { pinned: true, order: 1.5 } }]);
    expect(linux.pinned).toEqual([{ id: "r_linux_fourth", body: { pinned: true, order: 1.5 } }]);
    await page.keyboard.press("Escape");

    // A new pin goes above every machine's, and above those pinned earlier on a machine this device hasn't loaded: its
    // place is at most minus the seconds since 1970 (chatList.ts newPinOrder).
    const newRow = rowOf(side, fresh.room.name);
    await more(newRow, fresh.room.name).click();
    const pinnedFrom = Date.now();
    await tray(newRow, fresh.room.name).getByRole("button", { name: "Pin to top", exact: true }).click();
    await expect.poll(() => pinnedNames(side)).toEqual([fresh.room.name, first.room.name, second, fourth, third.room.name]);
    expect(sent).toHaveLength(2);
    const last = sent.at(-1)!;
    expect(last).toMatchObject({ home: true, id: fresh.room.id, body: { pinned: true } });
    const order = (last.body as { order: number }).order;
    expect(order).toBeLessThanOrEqual(-pinnedFrom / 1000);
    expect(order).toBeGreaterThanOrEqual(-Date.now() / 1000);
  } finally {
    await first.cleanup();
    await third.cleanup();
    await fresh.cleanup();
  }
});

test("Chat settings pins and unpins its chat", async ({ page, request, token }) => {
  once();
  await page.setViewportSize({ width: 390, height: 844 });
  const x = await chat(request, token, `Settings pin ${Math.random().toString(36).slice(2, 6)}`);
  const settings = async () => {
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Chat settings", exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  try {
    await page.goto(`/#/room/${x.room.id}`);
    await expect(page.getByRole("heading", { name: x.room.name, exact: true })).toBeVisible();
    let dialog = await settings();
    const pinned = dialog.getByRole("checkbox", { name: "Pinned", exact: true });
    await expect(pinned).not.toBeChecked();
    await expect(dialog).toContainText("Stays at the top of your chat list, on every device.");
    await pinned.click({ force: true });
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("pins-chat-settings.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await saved(request, token)).get(x.room.id)?.pinnedAt ?? 0).toBeGreaterThan(0);
    const side = await chatList(page);
    await expect.poll(() => pinnedNames(side)).toEqual([x.room.name]);
    await side.getByRole("button", { name: "Close", exact: true }).click();

    dialog = await settings();
    await expect(dialog.getByRole("checkbox", { name: "Pinned", exact: true })).toBeChecked();
    await dialog.getByRole("checkbox", { name: "Pinned", exact: true }).click({ force: true });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await saved(request, token)).get(x.room.id)?.pinnedAt ?? null).toBeNull();
  } finally {
    await x.cleanup();
  }
});

test("Chat settings never undoes a pin or an unpin made on another device while it's open", async ({ page, request, token }) => {
  once();
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const x = await chat(request, token, `Settings stays ${Math.random().toString(36).slice(2, 6)}`);
  // What the page hears from the hub over its live connection.
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  /** Pinned or unpinned on another device (the hub's own API), once this page has heard it and drawn it. */
  const elsewhere = async (pinned: boolean) => {
    const from = frames.length;
    expect((await request.post(`${HUB}/api/rooms/${x.room.id}/pin`, { headers, data: { pinned } })).ok()).toBe(true);
    await expect.poll(() => frames.slice(from).some((f) => f.includes('"t":"room"') && f.includes(`"id":"${x.room.id}"`) && f.includes('"pinnedAt"') === pinned)).toBe(true);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const settings = async () => {
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Chat settings", exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  try {
    await page.goto(`/#/room/${x.room.id}`);
    await expect(page.getByRole("heading", { name: x.room.name, exact: true })).toBeVisible();

    // Opened unpinned, then pinned on another device: nothing changed here, so nothing to save.
    let dialog = await settings();
    await expect(dialog.getByRole("checkbox", { name: "Pinned", exact: true })).not.toBeChecked();
    await elsewhere(true);
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    // Something else changed and saved: the pin stays.
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(`${x.room.name} 2`);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await saved(request, token)).get(x.room.id)?.name).toBe(`${x.room.name} 2`);
    expect((await saved(request, token)).get(x.room.id)?.pinnedAt ?? 0).toBeGreaterThan(0);

    // Opened pinned, then unpinned on another device: Escape closes it without asking about changes, and it stays
    // unpinned.
    dialog = await settings();
    await expect(dialog.getByRole("checkbox", { name: "Pinned", exact: true })).toBeChecked();
    await elsewhere(false);
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await saved(request, token)).get(x.room.id)?.pinnedAt).toBeUndefined();
  } finally {
    await x.cleanup();
  }
});

test("a chat named in New chat keeps its name after its first message; one without is named from it", async ({ page, request, token }) => {
  onPhones();
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const tag = Math.random().toString(36).slice(2, 6);
  const made: string[] = [];
  const folders: string[] = [];
  /**
   * A new chat with Codex from its page. Its folder is outside the workspace and is removed before its first message,
   * so its agent never starts: the reply says the folder is gone.
   */
  const start = async (name: string | null) => {
    await page.goto("/#/agent/codex");
    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
    await expect(dialog).toBeVisible();
    const field = dialog.getByRole("textbox", { name: "Name", exact: true });
    await expect(field).toHaveAttribute("placeholder", "Optional");
    if (name) await field.fill(name);
    const folder = mkdtempSync(join(tmpdir(), "ct-pins-name-"));
    folders.push(folder);
    await dialog.getByRole("textbox", { name: "Folder path", exact: true }).fill(folder);
    await noHorizontalOverflow(page);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (name) await page.screenshot({ ...shot(`new-chat-name-${width}.png`), animations: "disabled" });
    const created = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    const res = await created;
    const room = (await res.json()) as Room;
    made.push(room.id);
    // A name goes only when one was typed.
    expect(res.request().postDataJSON().name).toBe(name ?? undefined);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    rmSync(folder, { recursive: true, force: true });
    return room;
  };
  const say = async (room: Room, text: string) => {
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
    const sent = page.waitForResponse((r) => r.url().endsWith(`/api/rooms/${room.id}/messages`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect((await sent).ok()).toBe(true);
  };
  try {
    const named = await start(`Release notes ${tag}`);
    expect(named.name).toBe(`Release notes ${tag}`);
    await expect(page.getByRole("heading", { name: `Release notes ${tag}`, exact: true })).toBeVisible();
    await say(named, "Draft the notes for 0.5");
    await expect(page.locator(".messages")).toContainText("This chat's folder isn't there any more");
    // Its first message didn't rename it: here, in the list, and on the hub.
    await expect(page.getByRole("heading", { name: `Release notes ${tag}`, exact: true })).toBeVisible();
    expect((await saved(request, token)).get(named.id)?.name).toBe(`Release notes ${tag}`);
    const side = await chatList(page);
    await expect(rowOf(side, `Release notes ${tag}`)).toBeVisible();
    await side.getByRole("button", { name: "Close", exact: true }).click();

    // Without a name: "New chat" until its first message names it.
    const unnamed = await start(null);
    expect(unnamed.name).toBe("New chat");
    await say(unnamed, `Fix the login page ${tag}`);
    await expect(page.getByRole("heading", { name: `Fix the login page ${tag}`, exact: true })).toBeVisible();
    expect((await saved(request, token)).get(unnamed.id)?.name).toBe(`Fix the login page ${tag}`);
    await noHorizontalOverflow(page);
  } finally {
    for (const id of made) await request.delete(`${HUB}/api/rooms/${id}`, { headers });
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }
});

test("New chat says a new folder is named after the chat only when the hub names it so", async ({ page }) => {
  once();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox", { name: "Name", exact: true });
  // "A new folder" is what's picked: its help says where it goes.
  const help = dialog.locator(".help", { hasText: /^An empty folder in / });
  await expect(help).toBeVisible();
  await expect(help).not.toContainText("named after the chat");
  await field.fill("Release notes");
  await expect(help).toContainText(", named after the chat.");
  // No Latin letters or digits, or the stand-in its first message replaces: the hub dates the folder (chats.ts).
  for (const name of ["Привет, мир", "¿¡!?", "New chat", "   "]) {
    await field.fill(name);
    await expect(help).not.toContainText("named after the chat");
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("on a desktop, the line where a dragged chat would land shows whole, over the row under it", async ({ page, request, token }) => {
  test.skip(!project().endsWith("-1440"), "The line a drag draws on a wide screen, once per browser.");
  const headers = { authorization: `Bearer ${token}` };
  const tag = Math.random().toString(36).slice(2, 6);
  const list = [await chat(request, token, `Alpha ${tag}`), await chat(request, token, `Bravo ${tag}`), await chat(request, token, `Charlie ${tag}`)];
  const [a, b, c] = list.map((x) => x.room.name);
  for (const [i, x] of list.entries()) await request.post(`${HUB}/api/rooms/${x.room.id}/pin`, { headers, data: { pinned: true, order: i } });
  try {
    await page.goto("/");
    const side = await chatList(page);
    await expect.poll(() => pinnedNames(side)).toEqual([a, b, c]);
    // Charlie held over Alpha's lower half: the line goes under Alpha, on its border with Bravo (each row has the list's
    // colour under it, and Bravo, drawn after Alpha, used to cover the half of the line that reaches into it). The rows'
    // own drag handlers are what's driven here (a mouse drag is the test below's, in Chromium): this is about the line.
    const carried = await page.evaluateHandle(() => new DataTransfer());
    await rowOf(side, c).dispatchEvent("dragstart", { dataTransfer: carried });
    const over = (await rowOf(side, a).boundingBox())!;
    await rowOf(side, a).dispatchEvent("dragover", { dataTransfer: carried, clientX: over.x + 60, clientY: over.y + over.height - 4 });
    await expect(rowOf(side, a)).toHaveClass(/drop-below/);
    const line = await rowOf(side, a).evaluate((row) => {
      const r = row.getBoundingClientRect();
      const rows = [...row.parentElement!.querySelectorAll(".csb-item")];
      const next = rows[rows.indexOf(row) + 1].getBoundingClientRect();
      // What a look finds on top just over the border and just under it (in Bravo's row): the 2 px line, both times.
      const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
      const on = [r.bottom - 0.5 * zoom, r.bottom + 0.25 * zoom].map((y) => {
        const found = document.elementFromPoint(r.left + 40 * zoom, y)?.closest(".csb-item");
        return found === row ? "line" : (found?.querySelector(".csb-chat-name")?.textContent ?? "?");
      });
      return { height: getComputedStyle(row, "::after").height, alphaBottom: r.bottom, bravoTop: next.top, on };
    });
    expect(line.height, "the line is drawn").toBe("2px");
    expect(Math.abs(line.bravoTop - line.alphaBottom), `Bravo's row starts where Alpha's ends: ${JSON.stringify(line)}`).toBeLessThan(1);
    expect(line.on, `the whole line shows, over Bravo's row too: ${JSON.stringify(line)}`).toEqual(["line", "line"]);
    await rowOf(side, c).dispatchEvent("dragend", { dataTransfer: carried });
    await expect(rowOf(side, a)).not.toHaveClass(/drop-below/);
    expect(await pinnedNames(side), "nothing moved").toEqual([a, b, c]);
  } finally {
    for (const x of list) await x.cleanup();
  }
});

test("on a desktop, pinned chats are dragged into place, and moved with the keyboard", async ({ page, request, token }) => {
  test.skip(project() !== "chromium-1440", "Dragging with a mouse, on a wide screen.");
  const headers = { authorization: `Bearer ${token}` };
  const tag = Math.random().toString(36).slice(2, 6);
  const list = [await chat(request, token, `Alpha ${tag}`), await chat(request, token, `Bravo ${tag}`), await chat(request, token, `Charlie ${tag}`)];
  const [a, b, c] = list.map((x) => x.room.name);
  for (const [i, x] of list.entries()) await request.post(`${HUB}/api/rooms/${x.room.id}/pin`, { headers, data: { pinned: true, order: i } });
  try {
    await page.goto("/");
    const side = await chatList(page);
    await expect.poll(() => pinnedNames(side)).toEqual([a, b, c]);
    // Charlie dropped on Alpha's upper half: first.
    await rowOf(side, c).dragTo(rowOf(side, a), { targetPosition: { x: 60, y: 4 } });
    await expect.poll(() => pinnedNames(side)).toEqual([c, a, b]);
    // The keyboard: Alpha's ⋯, then Move down.
    const alpha = rowOf(side, a);
    await more(alpha, a).focus();
    await expect(more(alpha, a)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(tray(alpha, a)).toContainText("2 of 3");
    await page.keyboard.press("Tab");
    await expect(tray(alpha, a).getByRole("button", { name: "Move up", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tray(alpha, a).getByRole("button", { name: "Move down", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => pinnedNames(side)).toEqual([c, b, a]);
    await expect(tray(alpha, a).getByRole("button", { name: "Move up", exact: true })).toBeFocused();
    await page.screenshot({ ...shot("pins-desktop.png"), animations: "disabled" });
    const now = await saved(request, token);
    const places = list.map((x) => now.get(x.room.id)!.pinOrder!);
    expect(places[2]).toBeLessThan(places[1]);
    expect(places[1]).toBeLessThan(places[0]);
  } finally {
    for (const x of list) await x.cleanup();
  }
});
