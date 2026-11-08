import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Member, Message, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });

test("every screen renders without crashes or horizontal overflow", async ({ page }) => {
  for (const [route, title] of [["settings", "Settings"], ["setup", "Settings"], ["usage", "Usage"], ["devices", "Settings"], ["", "Crosstalk"], ["terminal", "Terminal"]]) {
    await page.goto(`/#/${route}`);
    await expect(page.locator(".topbar h1")).toHaveText(title);
    // 0.5.1: Settings is in tabs. Each one draws without crashing or overflowing sideways, and everything that was on
    // the one long page is still there: AI services with its Add button, Teamwork, Local models, Costs.
    if (route === "settings") {
      for (const [tab, heading] of [
        ["Agents", "Teamwork"],
        ["Models", "Local models"],
        ["Machines", "Machines"],
        ["Devices", "Display"],
        ["Usage", "Costs"],
      ]) {
        await settingsTab(page, tab);
        await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
        await noHorizontalOverflow(page);
      }
      await settingsTab(page, "Agents");
      await expect(page.getByRole("heading", { name: "AI services", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add an AI service", exact: true })).toBeVisible();
    }
    await noHorizontalOverflow(page);
  }
});

test("uploads are ready before send and sent files download intact", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const created = await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Browser project", mode: "direct" } });
  const room = await created.json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock", handle: "tester", config: { script: [{ type: "text", text: "Browser test complete." }] } } });
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect(page.locator(".group-answers")).toHaveText("@tester answers. Type @ to pick who answers.");
    await page.locator('input[aria-label="Choose attachments"]').setInputFiles({ name: "Résumé & notes #1 [draft](a).txt", mimeType: "text/plain", buffer: Buffer.from("complete upload") });
    await expect(page.getByLabel("Attachments", { exact: true }).getByText("Ready", { exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Résumé & notes #1 [draft](a).txt", exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Résumé & notes #1 [draft](a).txt", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().normalize("NFC")).toBe("Résumé & notes #1 [draft](a).txt");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync((await download.path())!, "utf8")).toBe("complete upload");
  } finally {
    await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth });
  }
});

test("computer pairing is recoverable when invite creation fails", async ({ page }) => {
  let fail = true;
  await page.route("**/api/computers/invite", (route) => route.fulfill(fail ? { status: 503, json: { error: "Temporary outage" } } : { json: { invite: "browserinvite", command: "curl test | sh" } }));
  await page.goto("/#/settings/computers");
  await page.getByRole("button", { name: "Connect a computer", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Temporary outage");
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("curl test | sh");
});

/** A real chat on the test hub. */
async function newChat(request: APIRequestContext, token: string, provider: "claude" | "codex", name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider, name } })).json();
  return { room, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** A real chat whose history, state and live events the test writes (its agent never runs). */
async function playedChat(page: Page, request: APIRequestContext, token: string, name: string, status: Member["status"] = "idle") {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name } })).json();
  const snapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  const history = { room, messages: [] as Message[], turns: [] as unknown[], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let seq = 0;
  const message = (kind: "human" | "agent", text: string, extra: Partial<Message> = {}): Message =>
    ({ id: `sc-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: Date.now() - 60_000 + seq * 1000, updatedAt: Date.now() - 60_000 + seq * 1000, ...extra }) as Message;
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    pong(ws);
  });
  // The agent has read what's here (Member.readSeq).
  await page.route("**/api/state", (r) => r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, status, readSeq: seq } : m)) } }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, member, history, message, open, send: (e: unknown) => socket?.send(JSON.stringify(e)), cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

async function drawer(page: Page) {
  await page.getByRole("button", { name: /^Show chats/ }).click();
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(side).toBeVisible();
  return side;
}

test("a start without an address reopens the last chat", async ({ page, request, token }) => {
  await phone(page);
  const c = await newChat(request, token, "codex", "Pick up here");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    await expect(page.getByRole("heading", { name: "Pick up here", exact: true })).toBeVisible();
    // iOS opens a home-screen app it closed at its start address, which has no screen in it.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Pick up here", exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/room/${c.room.id}$`));
    // Going Home is a choice too: the next start is there.
    const side = await drawer(page);
    await side.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
    // An agent's page, as well.
    await page.locator(".agent-card").filter({ hasText: "Codex" }).click();
    await expect(page).toHaveURL(/#\/agent\/codex$/);
    await page.goto("/");
    await expect(page).toHaveURL(/#\/agent\/codex$/);
  } finally {
    await c.cleanup();
  }
});

test("a link to a chat shows Opening chat… while its machine loads", async ({ page, request, token }) => {
  await phone(page);
  const c = await newChat(request, token, "codex", "Linked chat");
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/state", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto(`/#/room/${c.room.id}`);
    // The chat screen's frame, not Home, and the way to the other chats.
    await expect(page.getByRole("heading", { name: "Opening chat…", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show chats", exact: true })).toBeVisible();
    await expect(page.getByText("What agent do you want to use?", { exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("opening-chat.png"), animations: "disabled" });
    release();
    await expect(page.getByRole("heading", { name: "Linked chat", exact: true })).toBeVisible();
  } finally {
    release();
    await c.cleanup();
  }
});

test("a link to a missing chat explains instead of going Home", async ({ page }) => {
  await phone(page);
  await page.goto("/#/room/r_gone_for_good");
  await expect(page.getByRole("heading", { name: "Chat not found", exact: true })).toBeVisible();
  await expect(page.getByText(/^Couldn't find this chat\. It may have been deleted, or it's on a machine this (device|iPhone|iPad|phone) hasn't added\.$/)).toBeVisible();
  await expect(page.getByText("What agent do you want to use?", { exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("chat-not-found.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Machines", exact: true }).click();
  await expect(page.locator(".topbar h1")).toHaveText("Settings");
  await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeVisible();
  await page.goto("/#/room/r_gone_for_good");
  await page.getByRole("button", { name: "Go to chats", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
  // On a phone the chats are in the drawer: it opens.
  await expect(page.getByRole("complementary", { name: "Chats", exact: true })).toBeVisible();
});

test("a chat deleted elsewhere says so", async ({ page, request, token }) => {
  await phone(page);
  const c = await newChat(request, token, "codex", "Soon gone");
  const mine = await newChat(request, token, "codex", "Deleted here");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    await expect(page.getByRole("heading", { name: "Soon gone", exact: true })).toBeVisible();
    // Another device deletes it.
    await c.cleanup();
    await expect(page.getByText("This chat was deleted on another device.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Chat deleted", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("chat-deleted-elsewhere.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Go to chats", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
    // Deleted from this device: no such note, it goes on to the agent's page.
    await page.getByRole("complementary", { name: "Chats", exact: true }).locator(".csb-chat").filter({ hasText: "Deleted here" }).click();
    await expect(page.getByRole("heading", { name: "Deleted here", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByRole("button", { name: "Delete chat", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Yes, delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/agent\/codex$/);
    await expect(page.getByText("This chat was deleted on another device.", { exact: true })).toHaveCount(0);
  } finally {
    await c.cleanup();
    await mine.cleanup();
  }
});

test("rows show their folder, and Show all and the search survive closing the drawer", async ({ page, request, token }) => {
  await phone(page);
  const tag = Math.random().toString(36).slice(2, 6);
  const chats = [];
  for (let i = 0; i < 14; i++) chats.push(await newChat(request, token, "codex", `Task ${tag} ${i}`));
  // A second apart, in the order they were made (chats made in the same millisecond would tie). The oldest has a reply
  // you haven't read: it shows even though eight newer ones come first.
  const made = new Map(chats.map((c, i) => [c.room.id, i]));
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    s.rooms = s.rooms.map((r: Room) => {
      const i = made.get(r.id);
      if (i === undefined) return r;
      return { ...r, updatedAt: Date.now() - (14 - i) * 1000, ...(i === 0 ? { lastReplyAt: Date.now(), readAt: Date.now() - 60_000 } : {}) };
    });
    await route.fulfill({ json: s });
  });
  try {
    await page.goto("/");
    let side = await drawer(page);
    const rows = side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Codex" }) }).locator(".csb-chat");
    await expect(rows).toHaveCount(9);
    // Newest first, each with its folder and when.
    await expect(rows.first().locator(".csb-chat-name")).toHaveText(`Task ${tag} 13`);
    await expect(rows.first().locator(".csb-chat-sub")).toHaveText(new RegExp(`^task-${tag}-13(-\\d+)? · just now$`));
    const unread = rows.filter({ hasText: `Task ${tag} 0` });
    await expect(unread).toHaveClass(/unread/);
    await expect(unread.getByLabel("New reply", { exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("drawer-rows.png"), animations: "disabled" });
    // Show all is a finger's height.
    const more = side.getByRole("button", { name: "Show all 14", exact: true });
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await more.click();
    await expect(rows).toHaveCount(14);
    // A shorter screen, so the list scrolls.
    await page.setViewportSize({ width: 390, height: 640 });
    const list = side.locator(".csb-scroll");
    await list.evaluate((el) => (el.scrollTop = 180));
    const top = await list.evaluate((el) => el.scrollTop);
    expect(top).toBeGreaterThan(100);
    await expect.poll(() => page.evaluate(async () => (await import("/src/sidebar.ts")).useSidebar.getState().scrollTop)).toBe(top);
    await side.getByRole("button", { name: "Close", exact: true }).click();
    await expect(side).toHaveCount(0);
    side = await drawer(page);
    await expect(rows).toHaveCount(14);
    await expect(side.getByRole("button", { name: "Show fewer", exact: true })).toBeVisible();
    expect(await side.locator(".csb-scroll").evaluate((el) => el.scrollTop)).toBe(top);
    // The search is kept too, and finds chats by their folder's name.
    await side.getByRole("textbox", { name: "Search chats", exact: true }).fill(`task-${tag}-7`);
    await expect(rows).toHaveCount(1);
    await side.getByRole("button", { name: "Close", exact: true }).click();
    side = await drawer(page);
    await expect(side.getByRole("textbox", { name: "Search chats", exact: true })).toHaveValue(`task-${tag}-7`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`Task ${tag} 7`);
  } finally {
    for (const c of chats) await c.cleanup();
  }
});

test("an unreachable machine gets a line with Try now, and the list says Loading chats… while it connects", async ({ page, token }) => {
  await phone(page);
  const at = Date.now();
  const linuxRoom = { id: "r_linux", name: "Fix login", cwd: "/home/me/Crosstalk/fix-login", mode: "direct", leadMemberId: "mb_linux", maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "codex", origin: "web" } } as Room;
  const linuxMember = { id: "mb_linux", roomId: "r_linux", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: at, position: 0 } as Member;
  const linux = await otherMachine(page, token, { port: 8456, held: true, rooms: [linuxRoom], members: [linuxMember] });
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  await page.goto("/");
  const side = await drawer(page);
  const codex = side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Codex" }) });
  // Its chats aren't in yet: they're loading, not "No chats yet".
  await expect(codex.locator(".csb-empty")).toHaveText("Loading chats…");
  await page.screenshot({ ...shot("drawer-loading-chats.png"), animations: "disabled" });
  linux.release();
  await expect(codex.locator(".csb-chat").filter({ hasText: "Fix login" })).toBeVisible();
  // The Linux box stops answering: a line of its own says so.
  linux.refuse(true);
  const line = side.locator(".csb-machine").filter({ hasText: "Linux box isn't answering" });
  await expect(line).toBeVisible();
  await expect(line.getByRole("button", { name: "Try now", exact: true })).toBeVisible();
  // Its chats stay listed meanwhile.
  await expect(codex.locator(".csb-chat").filter({ hasText: "Fix login" })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("drawer-machine-down.png"), animations: "disabled" });
  // A finger-sized button, and a tap while it's still down says it's trying (the line stays until it answers).
  expect((await line.getByRole("button", { name: "Try now", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await line.getByRole("button", { name: "Try now", exact: true }).click();
  await expect(line.getByRole("button", { name: "Trying…", exact: true })).toBeDisabled();
  await expect(line.getByRole("button", { name: "Try now", exact: true })).toBeEnabled({ timeout: 4_000 });
  await expect(line).toBeVisible();
  // Tried a few times by now: the next try is seconds away. Try now doesn't wait for it.
  const before = linux.sockets();
  await expect.poll(() => linux.sockets(), { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 2);
  linux.refuse(false);
  const tries = linux.sockets();
  await line.getByRole("button", { name: "Try now", exact: true }).click();
  await expect.poll(() => linux.sockets(), { timeout: 1_000 }).toBeGreaterThan(tries);
  await expect(line).toHaveCount(0, { timeout: 1_500 });
});

test("the New chat menu closes on a tap outside", async ({ page }) => {
  await phone(page);
  await page.goto("/");
  const side = await drawer(page);
  const button = side.getByRole("button", { name: "New chat", exact: true });
  await button.click();
  const menu = side.getByRole("menu");
  await expect(menu).toBeVisible();
  // A tap on the list below it (not on a chat).
  await side.locator(".csb-head").click({ position: { x: 150, y: 20 } });
  await expect(menu).toHaveCount(0);
  await expect(side).toBeVisible();
  // Escape too, back on the button.
  await button.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  // Picking from it still works.
  await button.click();
  await menu.getByRole("menuitem", { name: "Codex" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a 3-line block shows open, and a 40-line block shows 8 lines and Show all 40 lines", async ({ page, request, token }) => {
  await phone(page);
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { w.copied.push(text); } } });
  });
  const s = await playedChat(page, request, token, "Code blocks");
  const script = Array.from({ length: 40 }, (_, i) => `echo "line ${i + 1}"`).join("\n");
  s.history.messages.push(s.message("human", "Three commands, then the script"), s.message("agent", "Run these:\n\n```sh\nnpm ci\nnpm test\nnpm run build\n```\n\nAnd the script:\n\n```sh\n" + script + "\n```"));
  try {
    await s.open();
    const blocks = page.locator(".codeblock");
    await expect(blocks).toHaveCount(2);
    const short = blocks.nth(0);
    const long = blocks.nth(1);
    // Short: whole, no tap needed.
    await expect(short.locator("pre")).toBeVisible();
    await expect(short.locator("pre")).toContainText("npm run build");
    expect(await short.locator("pre").evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await expect(short.getByRole("button", { name: /^Show all/ })).toHaveCount(0);
    // Long: its first 8 lines, then Show all.
    const more = long.getByRole("button", { name: "Show all 40 lines", exact: true });
    await expect(more).toBeVisible();
    const lineHeight = await long.locator("pre").evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const preview = (await long.locator("pre").boundingBox())!.height;
    expect(preview).toBeGreaterThan(7 * lineHeight);
    expect(preview).toBeLessThan(10 * lineHeight);
    await noHorizontalOverflow(page);
    await long.scrollIntoViewIfNeeded();
    await page.screenshot({ ...shot("code-blocks.png"), animations: "disabled" });
    // Copy copies all 40 lines either way.
    await long.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1)?.split("\n").length)).toBe(40);
    await more.click();
    await expect(long.getByRole("button", { name: "Collapse", exact: true })).toBeVisible();
    expect((await long.locator("pre").boundingBox())!.height).toBeGreaterThan(38 * lineHeight);
    await long.getByRole("button", { name: "Collapse", exact: true }).click();
    await expect(long.getByRole("button", { name: "Show all 40 lines", exact: true })).toBeVisible();
  } finally {
    await s.cleanup();
  }
});

test("message actions are at least 44 px tall at 390 px", async ({ page, request, token }) => {
  await phone(page);
  const s = await playedChat(page, request, token, "Big targets");
  s.history.messages.push(s.message("human", "Make it bigger"), s.message("agent", "Done:\n\n```sh\nnpm run build\n```"));
  try {
    await s.open();
    await page.locator(".msg.human .bubble").click();
    const mine = page.locator(".your-msg.open").first();
    for (const name of ["Edit", "Unsend", "Copy message"]) {
      const box = (await mine.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("message-actions.png"), animations: "disabled" });
    await page.locator(".msg.agent .bubble p").first().click();
    const reply = page.locator(".agent-reply.open");
    expect((await reply.getByRole("button", { name: "Copy reply", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole("button", { name: "Copy code", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // A button that can't be used now looks it.
    const disabled = await page.evaluate(() => {
      const b = document.createElement("button");
      b.className = "link-action";
      b.disabled = true;
      document.querySelector(".messages")!.append(b);
      const o = getComputedStyle(b).opacity;
      b.remove();
      return Number(o);
    });
    expect(disabled).toBeLessThan(0.6);
  } finally {
    await s.cleanup();
  }
});

test("Stop and Send look different", async ({ page, request, token }) => {
  await phone(page);
  const s = await playedChat(page, request, token, "Stop or send", "working");
  const ask = s.message("human", "Keep going");
  s.history.messages.push(ask, s.message("agent", "Working on it", { status: "streaming", turnId: "t1" }));
  s.history.turns.push({ id: "t1", roomId: s.room.id, memberId: s.member.id, triggerMessageId: ask.id, replyMessageId: "sc-2", hop: 0, chainId: "t1", origin: "human", status: "running", error: null, usage: null, createdAt: Date.now() - 5000, startedAt: Date.now() - 5000, endedAt: null });
  try {
    await s.open();
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("One more thing");
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(stop).toBeVisible();
    await expect(send).toBeVisible();
    const look = (el: Element) => {
      const c = getComputedStyle(el);
      return { background: c.backgroundColor, border: c.borderTopWidth, color: c.color };
    };
    const [stopLook, sendLook] = [await stop.evaluate(look), await send.evaluate(look)];
    expect(stopLook.background).not.toBe(sendLook.background);
    expect(parseFloat(stopLook.border)).toBeGreaterThan(0);
    // A red square.
    expect(stopLook.color).toBe("rgb(255, 90, 95)");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("stop-and-send.png"), animations: "disabled" });
    // The message box grows to a third of the screen, then scrolls.
    await box.fill(Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n"));
    const height = (await box.boundingBox())!.height;
    expect(height).toBeGreaterThan(844 / 3 - 30);
    expect(height).toBeLessThanOrEqual(844 / 3 + 1);
    await page.screenshot({ ...shot("message-box-third.png"), animations: "disabled" });
  } finally {
    await s.cleanup();
  }
});
