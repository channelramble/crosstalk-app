import type { APIRequestContext, Browser, Page, WebSocketRoute } from "@playwright/test";
import type { Approval, Member, Room } from "@crosstalk/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});

async function chat(request: APIRequestContext, token: string, provider: "claude" | "codex", name: string, cwd?: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider, name, ...(cwd ? { cwd } : {}) } })).json();
  const state = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member: Member = state.members.find((m: Member) => m.roomId === room.id);
  return { room, member, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** Another device signed in to the same hub: its own browser, with its own page. */
async function secondDevice(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:5198", serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  await context.addInitScript((token) => localStorage.setItem("crosstalk.conn.v1", JSON.stringify({ baseUrl: "", token, deviceName: "Second device" })), token);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors, close: () => context.close() };
}

/** The hub's live updates on this page, played by the test (it answers pings). */
async function liveUpdates(page: Page) {
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", (ws) => {
    socket = ws;
    pong(ws);
  });
  return { send: (e: unknown) => (socket as WebSocketRoute | null)?.send(JSON.stringify(e)) };
}

const request_ = (id: string, roomId: string, memberId: string, extra: Partial<Approval> = {}): Approval => ({ id, roomId, memberId, turnId: null, kind: "command", title: "Run npm test", detail: "npm test", status: "pending", decision: null, decidedBy: null, createdAt: Date.now(), decidedAt: null, ...extra });

test("a reply that ends in another chat marks it unread, and opening it clears the mark on a second page too", async ({ page, request, token, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const reading = await chat(request, token, "codex", "Reading this one");
  // A chat whose folder is then removed: a message there gets a reply at once, which says so (the agent never starts).
  const folder = mkdtempSync(join(tmpdir(), "ct-attention-"));
  const other = await chat(request, token, "codex", "Fix login", folder);
  rmSync(folder, { recursive: true, force: true });
  const second = await secondDevice(browser, token);
  try {
    await page.goto(`/#/room/${reading.room.id}`);
    await expect(page.getByRole("heading", { name: "Reading this one", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show chats", exact: true })).toBeVisible();
    await second.page.goto("/");
    const recent = second.page.getByRole("region", { name: "Recent chats", exact: true });
    const row = recent.locator(".list-row").filter({ hasText: "Fix login" });
    await expect(row).toBeVisible();
    await expect(row.getByLabel("New reply", { exact: true })).toHaveCount(0);

    await request.post(`${HUB}/api/rooms/${other.room.id}/messages`, { headers, data: { text: "Fix the login page" } });
    // Every device hears that the reply ended: bold, with a dot, on the second one…
    await expect(row).toHaveClass(/unread/);
    await expect(row.getByLabel("New reply", { exact: true })).toBeVisible();
    await second.page.screenshot({ ...shot("home-new-reply.png"), animations: "disabled" });
    // …and on this one, which is in another chat: Show chats has a dot, and the drawer's row is bold.
    const show = page.getByRole("button", { name: "Show chats, new replies", exact: true });
    await expect(show).toBeVisible();
    await expect(show.locator(".sidebar-new")).toBeVisible();
    await page.screenshot({ ...shot("show-chats-new-reply.png"), animations: "disabled" });
    await show.click();
    const side = page.getByRole("complementary", { name: "Chats", exact: true });
    const sideRow = side.locator(".csb-chat").filter({ hasText: "Fix login" });
    await expect(sideRow).toHaveClass(/unread/);
    await expect(side.locator(".csb-chat").filter({ hasText: "Reading this one" })).not.toHaveClass(/unread/);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("drawer-unread.png"), animations: "disabled" });

    // Opened here: read here, so read on the second device too.
    await sideRow.click();
    await expect(page.getByRole("heading", { name: "Fix login", exact: true })).toBeVisible();
    await expect(row).not.toHaveClass(/unread/);
    await expect(row.getByLabel("New reply", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show chats", exact: true })).toBeVisible();
    const saved = (await (await request.get(`${HUB}/api/state`, { headers })).json()).rooms.find((r: Room) => r.id === other.room.id) as Room;
    expect(saved.lastReplyAt).toBeGreaterThan(0);
    expect(saved.readAt).toBeGreaterThanOrEqual(saved.lastReplyAt!);
    expect(second.errors).toEqual([]);
  } finally {
    await second.close();
    await reading.cleanup();
    await other.cleanup();
  }
});

test("a request in another chat puts a count on Show chats and shows a notice whose Open goes there", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const here = await chat(request, token, "claude", "Writing docs");
  const there = await chat(request, token, "codex", "Fix login");
  const live = await liveUpdates(page);
  try {
    await page.goto(`/#/room/${here.room.id}`);
    await expect(page.getByRole("heading", { name: "Writing docs", exact: true })).toBeVisible();
    live.send({ t: "approval", approval: request_("ap-1", there.room.id, there.member.id) });
    const notice = page.locator(".toast").filter({ hasText: "Fix login · Codex needs your OK" });
    await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: "Show chats, 1 needs you", exact: true })).toBeVisible();
    // On a phone it sits under the header: its buttons stay tappable.
    const header = (await page.locator(".topbar").boundingBox())!;
    expect((await notice.boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("request-notice.png"), animations: "disabled" });
    // A question too: counted, with its own words. The same request again is still one notice.
    live.send({ t: "approval", approval: request_("ap-2", there.room.id, there.member.id, { kind: "question", title: "Which branch?", questions: [{ id: "q", question: "Which branch?", header: "", options: [], multiSelect: false, allowOther: true }] }) });
    await expect(page.locator(".toast").filter({ hasText: "Fix login · Codex has a question" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show chats, 2 need you", exact: true })).toBeVisible();
    live.send({ t: "approval", approval: request_("ap-1", there.room.id, there.member.id, { title: "Run npm test again" }) });
    await expect(page.locator(".toast")).toHaveCount(2);
    // The drawer says so too.
    await page.getByRole("button", { name: "Show chats, 2 need you", exact: true }).click();
    const side = page.getByRole("complementary", { name: "Chats", exact: true });
    await expect(side.locator(".csb-chat").filter({ hasText: "Fix login" }).getByLabel("Needs you", { exact: true })).toBeVisible();
    await side.getByRole("button", { name: "Close", exact: true }).click();

    await notice.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Fix login", exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
    // The chat on screen isn't counted: it shows its requests itself.
    await expect(page.getByRole("button", { name: "Show chats", exact: true })).toBeVisible();
    await expect(page.locator('[data-approval="ap-1"]')).toBeVisible();
  } finally {
    await here.cleanup();
    await there.cleanup();
  }
});

test("the notice closes when the request is answered elsewhere", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const here = await chat(request, token, "claude", "Writing docs");
  const there = await chat(request, token, "codex", "Fix login");
  const live = await liveUpdates(page);
  try {
    await page.goto(`/#/room/${here.room.id}`);
    await expect(page.getByRole("heading", { name: "Writing docs", exact: true })).toBeVisible();
    const ask = request_("ap-1", there.room.id, there.member.id);
    live.send({ t: "approval", approval: ask });
    const notice = page.locator(".toast").filter({ hasText: "Fix login · Codex needs your OK" });
    await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: "Show chats, 1 needs you", exact: true })).toBeVisible();
    // Answered on the Mac: the notice goes at once, and so does the count.
    live.send({ t: "approval", approval: { ...ask, status: "approved", decision: "approve", decidedBy: "Mac", decidedAt: Date.now() } });
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show chats", exact: true })).toBeVisible();
  } finally {
    await here.cleanup();
    await there.cleanup();
  }
});

test("notices that come again count up, stay longer for more words, and wait while touched", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const live = await liveUpdates(page);
  await page.goto("/");
  await expect(page.locator(".topbar h1")).toHaveText("Crosstalk");
  // 72 characters: about 5 s plus 60 ms each, 9.3 s.
  const text = "The hub couldn't save the settings file. Check the disk, then try again.";
  for (let i = 0; i < 3; i++) live.send({ t: "notice", level: "error", text });
  const notice = page.locator(".toast").filter({ hasText: text });
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("×3");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("notice-repeated.png"), animations: "disabled" });
  await page.clock.fastForward(8_500);
  await expect(notice).toBeVisible();
  await page.clock.fastForward(1_200);
  await expect(notice).toHaveCount(0);
  // Touched, it waits as long as it's held; let go, it gives the rest of its time.
  live.send({ t: "notice", level: "info", text: "Saved." });
  const saved = page.locator(".toast").filter({ hasText: "Saved." });
  await expect(saved).toBeVisible();
  const box = (await saved.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.fastForward(30_000);
  await expect(saved).toBeVisible();
  await page.mouse.up();
  await page.mouse.move(1, 1);
  await page.clock.fastForward(1_500);
  await expect(saved).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(saved).toHaveCount(0);
});

test("Home lists requests from every machine", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mac = await chat(request, token, "claude", "Mac chat");
  await liveUpdates(page);
  // The Mac's request (as its hub lists it), and one on the Linux box.
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    s.approvals = [...s.approvals, request_("ap-mac", mac.room.id, mac.member.id, { title: "Edit README.md", kind: "file_change", detail: "" })];
    await route.fulfill({ json: s });
  });
  const at = Date.now();
  const linuxRoom = { id: "r_linux", name: "Fix login", cwd: "/home/me/Crosstalk/fix-login", mode: "direct", leadMemberId: "mb_linux", maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "codex", origin: "web" } } as Room;
  const linuxMember = { id: "mb_linux", roomId: "r_linux", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "approval", statusDetail: null, config: {}, createdAt: at, position: 0 } as Member;
  const linux = await otherMachine(page, token, { port: 8457, rooms: [linuxRoom], members: [linuxMember], approvals: [request_("ap-linux", "r_linux", "mb_linux", { title: "Run make deploy", detail: "make deploy" })] });
  try {
    await page.goto("/");
    const waiting = page.getByRole("region", { name: "Waiting for you", exact: true });
    const item = (name: string) => waiting.locator(".waiting-item").filter({ has: page.getByRole("button", { name, exact: true }) });
    await expect(item("Mac chat")).toContainText("Edit README.md");
    await expect(item("Fix login")).toContainText("Run make deploy");
    // Each with its machine's tag.
    await expect(item("Fix login").locator(".machine-tag")).toHaveText("Linux");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("home-waiting-every-machine.png"), animations: "disabled" });
    // Answered from here, on its own machine.
    await item("Fix login").getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => linux.answered.map((a) => a.id)).toEqual(["ap-linux"]);
    await expect(item("Fix login")).toHaveCount(0);
    await expect(item("Mac chat")).toBeVisible();
  } finally {
    await mac.cleanup();
  }
});
