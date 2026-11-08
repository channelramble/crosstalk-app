import type { Page, WebSocketRoute } from "@playwright/test";
import type { Member, Message, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

const hub = "http://127.0.0.1:8451";

/**
 * The store module the app itself loaded, for the tests that watch what it holds. Once anything under src/ has been
 * saved while the dev server runs, that server serves the app "/src/store.ts?t=…", and a bare import of
 * "/src/store.ts" is a second copy of the module instead: no machine, no chats, no history — a test would then be
 * watching an empty store and not the app. So take the URL the app's own entry point imports, and say plainly when
 * what comes back isn't the app's store.
 */
async function appStore(page: Page): Promise<string> {
  const path = await page.evaluate(async () => {
    const main = await (await fetch("/src/main.tsx")).text();
    return /from\s*"(\/src\/store\.ts[^"]*)"/.exec(main)?.[1] ?? "/src/store.ts";
  });
  const live = () =>
    page.evaluate(async (p) => {
      try {
        return !!(await import(p)).useStore.getState().conn;
      } catch {
        return false;
      }
    }, path);
  await expect
    .poll(live, { message: `${path} isn't the app's own store (no machine on it): the app has another copy of the module` })
    .toBe(true);
  return path;
}
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});

/** The page goes to the background (another app, the phone locked) or comes back. */
const setVisible = (page: Page, visible: boolean) =>
  page.evaluate((visible) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !visible });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);

test("history and older pages cannot erase replies delivered while the request is pending", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "History race", mode: "direct" } })).json();
  let socket: WebSocketRoute;
  let release = () => {};
  let count = 0;
  let olderRelease = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const olderGate = new Promise<void>((resolve) => { olderRelease = resolve; });
  const msg = (id: string, text: string, time: number, status = "done") => ({ id, roomId: room.id, authorKind: "human", authorName: "Test", memberId: null, mentions: [], turnId: null, text, status, createdAt: time, updatedAt: time, seq: time });
  await page.routeWebSocket("**/api/ws?**", (ws) => { socket = ws; ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); }); });
  await page.route(`**/api/rooms/${room.id}/history**`, async (route) => {
    count++;
    const older = new URL(route.request().url()).searchParams.has("before");
    if (older) await olderGate; else await gate;
    await route.fulfill({ json: { room, messages: [older ? msg("old", "Older saved message", 1) : msg("saved", "Saved message", 2)], turns: [], activities: [], approvals: [], totals: null, hasMore: !older } });
  });
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect.poll(() => count).toBeGreaterThan(0);
    socket!.send(JSON.stringify({ t: "message", message: msg("live", "Live ", 3, "streaming") }));
    // With its offset, as the hub sends it (an offset-less delta from an older hub reloads history instead).
    socket!.send(JSON.stringify({ t: "message.delta", roomId: room.id, messageId: "live", delta: "reply", offset: 5 }));
    socket!.send(JSON.stringify({ t: "message", message: msg("live", "Live reply", 3) }));
    await expect(page.locator(".messages")).toContainText("Live reply");
    release();
    await expect(page.locator(".messages")).toContainText("Saved message");
    await expect(page.locator(".messages")).toContainText("Live reply");
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    socket!.send(JSON.stringify({ t: "message", message: msg("latest", "Reply during pagination", 4) }));
    await expect(page.locator(".messages")).toContainText("Reply during pagination");
    olderRelease();
    await expect(page.locator(".messages")).toContainText("Older saved message");
    await expect(page.locator(".messages")).toContainText("Reply during pagination");
    await expect(page.locator(".messages .md")).toHaveText(["Older saved message", "Saved message", "Live reply", "Reply during pagination"]);
  } finally { release(); olderRelease(); await request.delete(`${hub}/api/rooms/${room.id}`, { headers }); }
});

test("reconnecting invalidates cached rooms and late responses cannot restore a disconnected session", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const rooms = [];
  for (const name of ["Cached one", "Cached two"]) rooms.push(await (await request.post(`${hub}/api/rooms`, { headers, data: { name, mode: "direct" } })).json());
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws?**", (ws) => { sockets.push(ws); ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); }); });
  let release = () => {};
  try {
    await page.goto(`/#/room/${rooms[0].id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    const storePath = await appStore(page);
    await page.evaluate(async ({ path, id }) => { const { useStore } = await import(path); await useStore.getState().loadHistory(id); useStore.getState().openRoom(id); }, { path: storePath, id: rooms[1].id });
    await expect(page.getByRole("heading", { name: "Cached two", exact: true })).toBeVisible();
    await request.post(`${hub}/api/rooms/${rooms[0].id}/messages`, { headers, data: { text: "Written while room was hidden" } });
    sockets.at(-1)!.close({ code: 1001 });
    await expect.poll(() => sockets.length).toBeGreaterThan(1);
    // Back: nothing left on screen (catching up shows only when it takes a while).
    await expect(page.locator(".conn-strip")).toHaveCount(0);
    await expect(page.getByText(/^Getting the latest from /)).toHaveCount(0);
    await page.evaluate(async ({ path, id }) => { const { useStore } = await import(path); useStore.getState().openRoom(id); }, { path: storePath, id: rooms[0].id });
    await expect(page.locator(".messages")).toContainText("Written while room was hidden");

    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route(`**/api/rooms/${rooms[0].id}/history**`, async (route) => { const response = await route.fetch(); held = true; await gate; await route.fulfill({ response }); });
    await page.evaluate(async (path) => { const { useStore } = await import(path); void useStore.getState().loadHistory(useStore.getState().roomId); }, storePath);
    await expect.poll(() => held).toBe(true);
    await page.evaluate(async (path) => { const { useStore } = await import(path); useStore.getState().disconnect(); }, storePath);
    release();
    await page.waitForTimeout(100);
    expect(await page.evaluate(async (path) => { const { useStore } = await import(path); const s = useStore.getState(); return { conn: s.conn, rooms: Object.keys(s.rooms), histories: Object.keys(s.roomData) }; }, storePath)).toEqual({ conn: null, rooms: [], histories: [] });
  } finally { release(); for (const room of rooms) await request.delete(`${hub}/api/rooms/${room.id}`, { headers }); }
});

test("a failed reconnect snapshot retries instead of leaving stale state indefinitely", async ({ page }) => {
  await page.goto("/#/devices");
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  const storePath = await appStore(page);
  // Let the page's own first sync finish, so the failure below hits the refresh under test.
  await expect.poll(() => page.evaluate(async (path) => (await import(path)).useStore.getState().syncing, storePath)).toBe(false);
  const name = (await page.evaluate(async (path) => { const { machineName, useStore } = await import(path); const s = useStore.getState(); return machineName(s.conn, s.hub); }, storePath)) as string;
  const strip = page.locator(".conn-strip").filter({ hasText: `Getting the latest from ${name}…` });
  let fail = true;
  let attempts = 0;
  await page.route("**/api/state", async (route) => {
    attempts++;
    // Slow, then failing: a hub restarting.
    if (fail) { fail = false; await new Promise((r) => setTimeout(r, 2500)); await route.fulfill({ status: 503, json: { error: "Restarting" } }); }
    else await route.continue();
  });
  const started = Date.now();
  void page.evaluate(async (path) => { const { useStore } = await import(path); await useStore.getState().refresh().catch(() => {}); }, storePath);
  // Quiet while it might be quick…
  await page.waitForTimeout(900);
  await expect(strip).toHaveCount(0);
  // …said once it has taken 1.5 s, and still while it's tried again.
  await expect(strip).toBeVisible();
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  await expect.poll(() => attempts).toBeGreaterThan(1);
  await expect(strip).toHaveCount(0);
});

test("stream offsets recover missing and overlapping text while history is in flight", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Streaming recovery", mode: "direct" } })).json();
  let socket: WebSocketRoute;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  let block = false;
  const message = { id: "stream", roomId: room.id, authorKind: "agent", authorName: "worker", memberId: null, mentions: [], turnId: null, text: "A", status: "streaming", createdAt: 1, updatedAt: 1 };
  await page.routeWebSocket("**/api/ws?**", (ws) => { socket = ws; ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); }); });
  await page.route(`**/api/rooms/${room.id}/history**`, async (route) => {
    const snapshot = { ...message };
    if (block) { requested = true; await gate; }
    await route.fulfill({ json: { room, messages: [snapshot], turns: [], activities: [], approvals: [], totals: null, hasMore: false } });
  });
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.locator(".messages .md")).toHaveText("A");
    const storePath = await appStore(page);
    block = true;
    Object.assign(message, { text: "AB", updatedAt: 2 }); // B happened while disconnected.
    await page.evaluate(async (path) => { const { useStore } = await import(path); void useStore.getState().loadHistory(useStore.getState().roomId); }, storePath);
    await expect.poll(() => requested).toBe(true);
    socket!.send(JSON.stringify({ t: "message.delta", roomId: room.id, messageId: "stream", offset: 2, delta: "C" }));
    release();
    await expect(page.locator(".messages .md")).toHaveText("ABC");
    // Duplicate/overlapping delivery must not append C twice.
    socket!.send(JSON.stringify({ t: "message.delta", roomId: room.id, messageId: "stream", offset: 2, delta: "CD" }));
    await expect(page.locator(".messages .md")).toHaveText("ABCD");
  } finally { release(); await request.delete(`${hub}/api/rooms/${room.id}`, { headers }); }
});

/** A real chat whose state, history and live events the test plays, with its agent at work on a reply. */
async function workingChat(page: Page, request: import("@playwright/test").APIRequestContext, token: string, name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "codex", name } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  const at = Date.now() - 20_000;
  const ask = { id: "w-1", seq: 1, roomId: room.id, authorKind: "human", authorName: "Phone", memberId: null, mentions: [], turnId: null, text: "Write the tests", status: "done", createdAt: at, updatedAt: at } as Message;
  const reply = { id: "w-2", seq: 2, roomId: room.id, authorKind: "agent", authorName: member.handle, memberId: member.id, mentions: [], turnId: "w-turn", text: "Writing the first test", status: "streaming", createdAt: at + 1000, updatedAt: at + 1000 } as Message;
  const turn = { id: "w-turn", roomId: room.id, memberId: member.id, triggerMessageId: ask.id, replyMessageId: reply.id, hop: 0, chainId: "w-turn", origin: "human", status: "running", error: null, usage: null, createdAt: at, startedAt: at, endedAt: null };
  const counts = { state: 0, history: 0, pings: 0 };
  const sockets: WebSocketRoute[] = [];
  let refusing = false;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    sockets.push(ws);
    if (refusing) return ws.close({ code: 1011 });
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t !== "ping") return;
      counts.pings++;
      ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => {
    counts.state++;
    return r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, status: "working", readSeq: 1 } : m)) } });
  });
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => {
    counts.history++;
    return r.fulfill({ json: { room, messages: [ask, reply], turns: [turn], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } });
  });
  return {
    room,
    counts,
    sockets,
    hubName: snapshot.hub.name as string,
    refuse(on: boolean) {
      refusing = on;
      if (on) sockets.at(-1)?.close({ code: 1011 });
    },
    cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }),
  };
}

test("returning to the app with a live connection shows no banner and keeps Stop and the streaming cursor", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const c = await workingChat(page, request, token, "Back in a second");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    await expect(page.locator(".msg.agent .cursor")).toBeVisible();
    await expect(page.locator(".chat-status-now")).not.toHaveText("Catching up…");
    const before = { ...c.counts, sockets: c.sockets.length };
    // Ten seconds in Safari, then back.
    await setVisible(page, false);
    await page.waitForTimeout(400);
    await setVisible(page, true);
    // At once, a ping checks the connection (it's answered: nothing was missed)…
    await expect.poll(() => c.counts.pings).toBeGreaterThan(before.pings);
    // …and nothing changes on screen meanwhile: no card or line, Stop stays, the reply keeps its cursor.
    for (let i = 0; i < 8; i++) {
      await expect(page.locator(".conn-strip")).toHaveCount(0);
      await expect(stop).toBeVisible();
      await expect(page.locator(".msg.agent .cursor")).toBeVisible();
      await expect(page.getByText("Reply status unknown until the conversation syncs.", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Catching up…", { exact: true })).toHaveCount(0);
      await page.waitForTimeout(250);
    }
    // Nothing was loaded again either.
    expect(c.counts.state).toBe(before.state);
    expect(c.counts.history).toBe(before.history);
    expect(c.sockets).toHaveLength(before.sockets);
    await page.screenshot({ ...shot("back-in-the-app.png"), animations: "disabled" });
  } finally {
    await c.cleanup();
  }
});

test("the connection strip sits under the header, names the machine, and Try now reconnects", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const c = await workingChat(page, request, token, "Airplane mode");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    // The connection drops, and stays down.
    c.refuse(true);
    const dropped = c.sockets.length;
    const strip = page.locator(".conn-strip");
    await expect(strip).toHaveText(`Can't reach ${c.hubName}. Trying again…`);
    // In the page under the header, not over it: the header's buttons stay tappable.
    const header = (await page.locator(".topbar").boundingBox())!;
    const box = (await strip.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    const settings = page.getByRole("button", { name: "Chat settings", exact: true });
    const at = (await settings.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[aria-label="Chat settings"]'), { x: at.x + at.width / 2, y: at.y + at.height / 2 })).toBe(true);
    // One steady line while it tries again (each try says "connecting", then "closed").
    await expect.poll(() => c.sockets.length).toBeGreaterThanOrEqual(dropped + 2);
    await expect(strip).toHaveText(`Can't reach ${c.hubName}. Trying again…`);
    // The strip says it can't reach the machine: the status line doesn't say it again, just what it last knew.
    await expect(page.locator(".chat-status-now")).toHaveText("Last seen working");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("connection-strip.png"), animations: "disabled" });
    // After 20 s: since when, what to check, and Try now.
    await page.clock.fastForward(21_000);
    await expect(strip).toContainText(/Since .+\. Check that (Tailscale is on|Crosstalk is running)\./);
    const tryNow = strip.getByRole("button", { name: "Try now", exact: true });
    await expect(tryNow).toBeVisible();
    await page.screenshot({ ...shot("connection-strip-try-now.png"), animations: "disabled" });
    // Back (Airplane Mode off): Try now connects at once, without waiting out the pause between tries.
    c.refuse(false);
    const tries = c.sockets.length;
    await tryNow.click();
    await expect.poll(() => c.sockets.length, { timeout: 1_000 }).toBeGreaterThan(tries);
    await expect(strip).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  } finally {
    await c.cleanup();
  }
});
