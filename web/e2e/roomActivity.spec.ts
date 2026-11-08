import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import { test, expect, noHorizontalOverflow } from "./fixtures";

async function chat(request: APIRequestContext, token: string, provider: string, name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/chats", { headers, data: { provider, name } })).json();
  return { room, cleanup: () => request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }) };
}
async function sidebar(page: Page) {
  const open = page.getByRole("button", { name: "Show chats", exact: true });
  if (await open.count()) await open.click();
  return page.getByRole("complementary", { name: "Chats", exact: true });
}

test("chat lists keep provider identity and search matches the requested chat", async ({ page, request, token }) => {
  const a = await chat(request, token, "claude", "Claude contribution");
  const b = await chat(request, token, "codex", "Codex contribution");
  try {
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Recent chats", exact: true })).toContainText("Claude contribution");
    const side = await sidebar(page);
    await expect(side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Claude Code" }) })).toContainText("Claude contribution");
    await expect(side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Codex" }) })).toContainText("Codex contribution");
    await side.getByRole("textbox", { name: "Search chats", exact: true }).fill("Codex contribution");
    await expect(side.locator(".csb-chat")).toHaveCount(1);
    await expect(side.locator(".csb-chat")).toContainText("Codex contribution");
    await noHorizontalOverflow(page);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("working and approval badges remain visible beside long chat names on a phone", async ({ page, request, token }) => {
  const a = await chat(request, token, "claude", "A long project name with spaces and details for ongoing verification");
  const b = await chat(request, token, "codex", "B long project name waiting for a decision from its owner");
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    snap.members = snap.members.map((m: any) => m.roomId === a.room.id ? { ...m, status: "working" } : m.roomId === b.room.id ? { ...m, status: "approval" } : m);
    await route.fulfill({ json: snap });
  });
  try {
    await page.goto("/");
    const side = await sidebar(page);
    const working = side.locator(".csb-chat").filter({ hasText: a.room.name }).getByLabel("Working", { exact: true });
    await expect(working).toBeVisible();
    // A ring, not a filled dot: it can't be taken for "New reply" beside it.
    await expect(working).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(working).toHaveCSS("border-top-width", "2px");
    await expect(side.locator(".csb-chat").filter({ hasText: b.room.name }).getByLabel("Needs you", { exact: true })).toBeVisible();
    if (process.env.CT_SHOTS && page.viewportSize()!.width === 390) await page.screenshot({ path: `${process.env.CT_SHOTS}/drawer-working.png`, animations: "disabled" });
    await noHorizontalOverflow(page);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("a chat's activity badge updates from live member events without reloading", async ({ page, request, token }) => {
  const c = await chat(request, token, "codex", "Live status chat");
  let socket: WebSocketRoute;
  let member: any;
  await page.routeWebSocket("**/api/ws?**", (ws) => { socket = ws; ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); }); });
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    member = snap.members.find((m: any) => m.roomId === c.room.id);
    await route.fulfill({ json: snap });
  });
  try {
    await page.goto("/");
    const side = await sidebar(page);
    const row = side.locator(".csb-chat").filter({ hasText: c.room.name });
    await expect(row.locator(".csb-dot")).toHaveCount(0);
    socket!.send(JSON.stringify({ t: "member", member: { ...member, status: "working" } }));
    await expect(row.getByLabel("Working", { exact: true })).toBeVisible();
    socket!.send(JSON.stringify({ t: "member", member: { ...member, status: "approval" } }));
    await expect(row.getByLabel("Needs you", { exact: true })).toBeVisible();
    socket!.send(JSON.stringify({ t: "member", member: { ...member, status: "idle" } }));
    await expect(row.locator(".csb-dot")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await c.cleanup(); }
});

test("a chat that stopped with an error shows a red dot and stays visible without Show all", async ({ page, request, token }) => {
  const failed = await chat(request, token, "codex", "Stopped on an error");
  const newer = [];
  for (let i = 0; i < 9; i++) newer.push(await chat(request, token, "codex", `Newer chat ${i}`));
  // The oldest of ten (eight show before "Show all"), a second apart: its agent stopped with an error.
  const made = new Map([failed, ...newer].map((c, i) => [c.room.id, i]));
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    snap.rooms = snap.rooms.map((r: any) => (made.has(r.id) ? { ...r, updatedAt: Date.now() - (10 - made.get(r.id)!) * 1000 } : r));
    snap.members = snap.members.map((m: any) => (m.roomId === failed.room.id ? { ...m, status: "error", statusDetail: "Codex exited" } : m));
    await route.fulfill({ json: snap });
  });
  try {
    await page.goto("/");
    const side = await sidebar(page);
    const codex = side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Codex" }) });
    const row = codex.locator(".csb-chat").filter({ hasText: "Stopped on an error" });
    await expect(row.getByLabel("Stopped with an error", { exact: true })).toBeVisible();
    await expect(row.locator(".csb-dot.error")).toHaveCSS("background-color", "rgb(255, 90, 95)");
    // Shown without Show all: the eight newest, then it.
    await expect(codex.locator(".csb-chat")).toHaveCount(9);
    await expect(codex.getByRole("button", { name: "Show all 10", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    if (process.env.CT_SHOTS && page.viewportSize()!.width === 390) await page.screenshot({ path: `${process.env.CT_SHOTS}/drawer-error.png`, animations: "disabled" });
  } finally {
    await failed.cleanup();
    for (const c of newer) await c.cleanup();
  }
});
