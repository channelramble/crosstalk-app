import type { APIRequestContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import type { AgentAccount, Approval, BackgroundTask, Member, ReplyStart, Room, Turn } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

/*
 * The chat list by state (web/src/views/ChatSidebar.tsx, web/src/chatList.ts): Pinned, Needs you, Working, Recent.
 * - chats in each state are in the right section, with the state in words on the row's second line and one label that
 *   reads the whole row;
 * - a chat moves as its state changes, with a real (scripted) agent on the test hub, and with the hub's own events;
 * - a finger on the list holds its rows where they are until it lifts;
 * - a search is one flat list in the same rows; sections fold, all but Needs you;
 * - on a touch screen a row has no ⋯, and "Hold a chat to pin it" shows until it's seen to;
 * - the row of Screen, Bookmarks, Terminal and Settings under the list, and 320×568 with four chats and that row in view.
 * The pure rules behind it are in web/src/chatList.test.ts.
 */

const HUB = "http://127.0.0.1:8451";
const APP = "http://127.0.0.1:5198";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const MIN = 60_000;

/** What the made-up list holds: every state, a group chat, a chat on a model of your own, and long names. */
function mix(now: number) {
  const rooms: Room[] = [];
  const members: Member[] = [];
  const chat = (id: string, name: string, ago: number, extra: Partial<Room> = {}, agent: Partial<Member> = {}): Member => {
    const provider = (agent.provider ?? "claude") as Member["provider"];
    rooms.push({ id, name, cwd: `/work/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)}`, mode: "direct", leadMemberId: `m-${id}`, maxHops: 5, rounds: 1, parallel: false, createdAt: now - 86_400_000, updatedAt: now - ago, archived: false, chat: { provider, origin: "web" }, ...extra });
    const m: Member = { id: `m-${id}`, roomId: id, handle: provider, provider, model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now - 86_400_000, position: 0, ...agent };
    members.push(m);
    return m;
  };
  const read = (ago: number) => ({ lastReplyAt: now - ago, readAt: now });
  const unread = (ago: number) => ({ lastReplyAt: now - ago, readAt: now - ago - MIN });

  // Pinned: one working (it says so, and stays), one quiet whose folder is its name (so just when).
  const notes = chat("pin-notes", "Release notes", 14 * MIN, { pinnedAt: now - 9000, pinOrder: 1, cwd: "/work/crosstalk" }, { status: "working" });
  chat("pin-login", "Fix the login page", 3 * 60 * MIN, { pinnedAt: now - 8000, pinOrder: 2, ...read(3 * 60 * MIN) }, { provider: "codex" });
  // Needs you: an approval (a long name), and a reply that failed.
  const tests = chat("needs-ok", "Run the tests before the release goes out tonight", 2 * MIN, {}, { status: "approval" });
  chat("failed", "Migrate the database", 25 * MIN, { cwd: "/work/api-server" }, { provider: "codex", status: "error", statusDetail: "stream disconnected before completion" });
  // Working: a reply 47 minutes in, one whose reply ended with three helpers still at work, and one waiting for a limit.
  const importer = chat("working", "Refactor the importer", 47 * MIN, { cwd: "/work/importer" }, { status: "working" });
  const research = chat("helpers", "Research helpers", 9 * MIN, { ...read(9 * MIN) });
  chat("limit", "Translate the docs", 70 * MIN, {}, { provider: "codex", status: "waiting", wait: { provider: "codex", account: "default", kind: "usage", label: "5-hour", resetsAt: now + 3 * 60 * MIN, runAt: now + 3 * 60 * MIN + 30_000, attempts: 1 } as Member["wait"] });
  // Recent: eight, three with a reply no one has read; a group chat, a chat on a model of your own, long names.
  chat("r1", "Holiday photos", 4 * MIN, { cwd: "/Users/me/Pictures/2026", ...unread(4 * MIN) });
  chat("r2", "A chat with a very long name that goes on and on past the edge", 11 * MIN, { ...unread(11 * MIN) }, { provider: "codex" });
  chat("r3", "Design review", 35 * MIN, { chat: { provider: "claude", origin: "web", group: true }, ...read(35 * MIN) }, { handle: "claude" });
  members.push({ ...members.at(-1)!, id: "m-r3-b", handle: "codex", provider: "codex", position: 1 });
  chat("r4", "Summarise the meeting", 2 * 60 * MIN, { cwd: "/work/notes", ...unread(2 * 60 * MIN) }, { provider: "codex", config: { account: "qwen" } });
  chat("r5", "Weekly report", 5 * 60 * MIN, { ...read(5 * 60 * MIN) });
  chat("r6", "Pricing page copy", 26 * 60 * MIN, { cwd: "/work/site", ...read(26 * 60 * MIN) }, { provider: "codex" });
  chat("r7", "Tidy the backlog", 2 * 24 * 60 * MIN, { ...read(2 * 24 * 60 * MIN) });
  chat("r8", "New chat", 6 * 24 * 60 * MIN, { cwd: "/work/chat-2026-11-16" }, { provider: "codex" });

  const approvals: Approval[] = [{ id: "ap-1", roomId: "needs-ok", memberId: tests.id, turnId: null, kind: "command", title: "npm test", detail: "Run `npm test`", status: "pending", decision: null, decidedBy: null, createdAt: now - 2 * MIN, decidedAt: null }];
  const task = (id: string): BackgroundTask => ({ id, kind: "local_agent", description: "Reading the docs", agentType: "Explore", workflow: null, background: true, status: "running", startedAt: now - 5 * MIN, endedAt: null, tokens: null, toolUses: null, lastTool: null, summary: null, error: null });
  const tasks: Record<string, BackgroundTask[]> = { [research.id]: [task("h1"), task("h2"), task("h3"), { ...task("h0"), status: "completed", endedAt: now - MIN }] };
  const replyStarts: Record<string, ReplyStart> = { [notes.id]: { turnId: "t-notes", at: now - 12 * MIN - 20_000 }, [importer.id]: { turnId: "t-importer", at: now - 47 * MIN - 5000 } };
  const account: AgentAccount = { provider: "codex", id: "qwen", label: "Qwen on this Mac", kind: "endpoint", endpoint: { baseUrl: "http://127.0.0.1:8080", models: ["qwen3-8b"], contextWindow: null } as AgentAccount["endpoint"], signedIn: true, account: null, plan: null, authMethod: null, error: null, checkedAt: now };
  return { rooms, members, approvals, tasks, replyStarts, account };
}

/** The page is given this list and nothing else of the shared test hub's (whatever chats other specs left there). */
async function givenMix(page: Page, change: (m: ReturnType<typeof mix>) => void = () => {}) {
  const given = mix(Date.now());
  change(given);
  await page.route((url) => url.origin === APP && url.pathname === "/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    await route.fulfill({ json: { ...s, rooms: given.rooms, members: given.members, approvals: given.approvals, tasks: given.tasks, replyStarts: given.replyStarts, accounts: [...s.accounts, given.account], roomActivity: {} } });
  });
  return given;
}

/** The page's live connection to the hub, with a way to say more on the hub's behalf. */
async function liveSocket(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", (ws) => {
    sockets.push(ws);
    ws.connectToServer();
  });
  return (e: unknown) => {
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify(e));
      } catch {
        // closed
      }
    }
  };
}

/** The chat list: the drawer on a phone (opened), the docked sidebar on a wide screen. */
async function chatList(page: Page) {
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  if (page.viewportSize()!.width <= 760) {
    await page.getByRole("button", { name: /^Show chats/ }).click();
    await expect(side).toBeVisible();
    await side.evaluate((el) => el.getAnimations().forEach((a) => a.finish()));
  }
  await expect(side).toBeVisible();
  return side;
}

const section = (side: Locator, name: string) => side.getByRole("region", { name, exact: true });
/** A section's chats, top to bottom. */
const names = (box: Locator) => box.locator(".csb-chat-name").allTextContents();
const row = (side: Locator, name: string) => side.locator(".csb-chat").filter({ has: side.page().locator(".csb-chat-name", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
const words = (side: Locator, name: string) => row(side, name).locator(".csb-chat-words");

test("chats are listed by state, each row saying its state in words", async ({ page }, info) => {
  await givenMix(page);
  await page.goto("/");
  const side = await chatList(page);

  // The sections, in order, each with how many chats it holds. No section for agents or for group chats.
  await expect(side.locator(".csb-group .csb-heading")).toHaveText(["Pinned 2", "Needs you 2", "Working 3", "Recent 8"]);
  expect(await names(section(side, "Pinned"))).toEqual(["Release notes", "Fix the login page"]);
  expect(await names(section(side, "Needs you"))).toEqual(["Run the tests before the release goes out tonight", "Migrate the database"]);
  expect(await names(section(side, "Working"))).toEqual(["Research helpers", "Refactor the importer", "Translate the docs"]);
  expect(await names(section(side, "Recent"))).toEqual(["Holiday photos", "A chat with a very long name that goes on and on past the edge", "Design review", "Summarise the meeting", "Weekly report", "Pricing page copy", "Tidy the backlog", "New chat"]);
  await expect(side.getByRole("region", { name: /Claude Code|Codex|Group chats/ })).toHaveCount(0);
  // The banner is gone: Needs you says it, at the top.
  await expect(side.getByText(/waiting for you/)).toHaveCount(0);

  // The second line is the state, in words.
  await expect(words(side, "Run the tests before the release goes out tonight")).toHaveText("Needs your OK");
  await expect(words(side, "Migrate the database")).toHaveText("Failed");
  await expect(words(side, "Refactor the importer")).toHaveText("Working · 47m");
  await expect(words(side, "Research helpers")).toHaveText("3 helpers working");
  await expect(words(side, "Translate the docs")).toHaveText(/^Back at (\w{3} )?\d{1,2}:\d\d/); // with the day, when that's past midnight
  // A pinned chat says its state like any other, and stays under Pinned.
  await expect(words(side, "Release notes")).toHaveText("Working · 12m");
  // No state: where it lives and when — without the folder when it only repeats the name.
  await expect(words(side, "Fix the login page")).toHaveText("3h ago");
  await expect(words(side, "Holiday photos")).toHaveText("2026 · 4m ago");
  await expect(words(side, "Pricing page copy")).toHaveText("site · 1d ago");
  await expect(words(side, "New chat")).toHaveText("chat-2026-11-16 · 6d ago");
  // A group chat is a row among the others, with who's in it and the group's avatars.
  await expect(words(side, "Design review")).toHaveText("@claude and @codex · 35m ago");
  await expect(row(side, "Design review").locator(".group-avatar .avatar")).toHaveCount(2);
  // Whose chat it is: every row has its avatar (the agent headings are gone), a model of your own its own.
  await expect(side.locator(".csb-chat")).toHaveCount(15);
  await expect(side.locator(".csb-chat > .avatar, .csb-chat > .group-avatar")).toHaveCount(15);
  await expect(row(side, "Summarise the meeting").locator(".svc-avatar")).toHaveCount(1);
  await expect(row(side, "Holiday photos").locator(".avatar")).toHaveAttribute("aria-label", "Claude Code");

  // The colour is an accent beside the words, never alone; unread is bold with its dot at the row's end.
  await expect(row(side, "Run the tests before the release goes out tonight").locator(".csb-chat-sub .csb-dot.needs")).toHaveCount(1);
  await expect(row(side, "Migrate the database").locator(".csb-chat-sub .csb-dot.error")).toHaveCount(1);
  await expect(row(side, "Refactor the importer").locator(".csb-chat-sub .csb-dot.busy")).toHaveCount(1);
  await expect(row(side, "Research helpers").locator(".csb-chat-sub .csb-dot.busy")).toHaveCount(1);
  await expect(row(side, "Translate the docs").locator(".csb-chat-sub .csb-dot.waiting")).toHaveCount(1);
  await expect(side.locator(".csb-chat.unread .csb-chat-name")).toHaveText(["Holiday photos", "A chat with a very long name that goes on and on past the edge", "Summarise the meeting"]);
  await expect(side.locator(".csb-chat.unread .reply-dot")).toHaveCount(3);
  await expect(side.locator(".csb-chat:not(.unread) .reply-dot")).toHaveCount(0);
  await expect(row(side, "Holiday photos").locator(".csb-chat-name")).toHaveCSS("font-weight", "700");

  // One label reads the whole row: its name, its state, when.
  await expect(row(side, "Run the tests before the release goes out tonight")).toHaveAccessibleName("Run the tests before the release goes out tonight, Needs your OK, 2 minutes ago");
  await expect(row(side, "Migrate the database")).toHaveAccessibleName("Migrate the database, Failed, 25 minutes ago");
  await expect(row(side, "Refactor the importer")).toHaveAccessibleName("Refactor the importer, Working for 47 minutes, 47 minutes ago");
  await expect(row(side, "Research helpers")).toHaveAccessibleName("Research helpers, 3 helpers working, 9 minutes ago");
  await expect(row(side, "Translate the docs")).toHaveAccessibleName(/^Translate the docs, Back at (\w{3} )?\d{1,2}:\d\d.*, 1 hour ago$/);
  await expect(row(side, "Holiday photos")).toHaveAccessibleName("Holiday photos, new reply, 2026, 4 minutes ago");
  await expect(row(side, "Fix the login page")).toHaveAccessibleName("Fix the login page, 3 hours ago");

  // Every row is a comfortable target, long names give way with an ellipsis, and nothing is wider than the list.
  const phone = page.viewportSize()!.width <= 760;
  for (const el of await side.locator(".csb-chat").all()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(phone ? 56 : 44);
  const box = (await side.boundingBox())!;
  for (const el of await side.locator(".csb-chat, .csb-group-head, .csb-tab").all()) {
    const b = (await el.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(box.x);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
  const long = row(side, "A chat with a very long name that goes on and on past the edge").locator(".csb-chat-name");
  expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis")).toBe(true);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot(`list-${info.project.name}.png`), animations: "disabled" });
  // The rest of the list, scrolled to its end.
  await side.locator(".csb-scroll").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.screenshot({ ...shot(`list-${info.project.name}-end.png`), animations: "disabled" });
});

test("Recent shows its newest twelve and whatever has a reply no one has read; sections fold, all but Needs you", async ({ page }) => {
  await givenMix(page, (m) => {
    // Ten more read chats, older than the rest, and one unread one older still.
    const base = m.rooms.find((r) => r.id === "r7")!;
    const agent = m.members.find((x) => x.roomId === "r7")!;
    for (let i = 0; i < 11; i++) {
      const id = `old${i}`;
      const at = base.updatedAt - (i + 10) * 24 * 60 * MIN;
      m.rooms.push({ ...base, id, name: i === 10 ? "Old but unread" : `Older chat ${i}`, cwd: `/work/old-${i}`, updatedAt: at, ...(i === 10 ? { lastReplyAt: at, readAt: at - MIN } : { lastReplyAt: at, readAt: at + MIN }) });
      m.members.push({ ...agent, id: `m-${id}`, roomId: id });
    }
  });
  await page.goto("/");
  const side = await chatList(page);
  const recent = section(side, "Recent");
  await expect(recent.locator(".csb-heading")).toHaveText("Recent 19");
  // The newest twelve, then the unread one from far down: a chat needing a look is never cut off.
  const shown = await names(recent);
  expect(shown).toHaveLength(13);
  expect(shown.slice(8)).toEqual(["Older chat 0", "Older chat 1", "Older chat 2", "Older chat 3", "Old but unread"]);
  await recent.getByRole("button", { name: "Show all 19", exact: true }).click();
  expect(await names(recent)).toHaveLength(19);
  await recent.getByRole("button", { name: "Show fewer", exact: true }).click();
  expect(await names(recent)).toHaveLength(13);
  // The other sections show every chat they hold.
  await expect(section(side, "Needs you").locator(".csb-more")).toHaveCount(0);

  // Folding: Recent says how many need a look (its heading has the count); it's remembered when the list is drawn again.
  await side.getByRole("button", { name: "Hide recent chats", exact: true }).click();
  await expect(recent.locator(".csb-chat")).toHaveCount(0);
  await expect(recent.locator(".csb-fold-said")).toHaveText("4 need a look");
  await expect(recent.locator(".csb-heading")).toHaveText("Recent 19");
  await expect(side.getByRole("button", { name: "Show recent chats, 19 chats, 4 need a look", exact: true })).toHaveAttribute("aria-expanded", "false");
  // Working folded is its heading alone: none of its chats waits for you.
  await side.getByRole("button", { name: "Hide working chats", exact: true }).click();
  await expect(side.getByRole("button", { name: "Show working chats, 3 chats", exact: true })).toBeVisible();
  await expect(section(side, "Working").locator(".csb-heading")).toHaveText("Working 3");
  await expect(section(side, "Working").locator(".csb-fold-said, .csb-fold-mark")).toHaveCount(0);
  // Pinned folds too, as before. Needs you can't: it has no control at all, even when this device's store says so.
  await expect(side.getByRole("button", { name: "Hide pinned chats", exact: true })).toBeVisible();
  await expect(section(side, "Needs you").locator(".csb-fold")).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("crosstalk.sidebar.folded", JSON.stringify({ needs: true, recent: true, working: true, codex: true, group: true })));
  await page.reload();
  const again = await chatList(page);
  await expect(section(again, "Needs you").locator(".csb-chat")).toHaveCount(2);
  await expect(section(again, "Recent").locator(".csb-chat")).toHaveCount(0);
  await expect(section(again, "Working").locator(".csb-chat")).toHaveCount(0);
  await expect(section(again, "Pinned").locator(".csb-chat")).toHaveCount(2);
  // A search shows what it finds wherever it is, folded or not.
  await again.getByRole("textbox", { name: "Search chats", exact: true }).fill("older chat 7");
  await expect(again.locator(".csb-chat-name")).toHaveText(["Older chat 7"]);
  await again.getByRole("button", { name: "Clear search", exact: true }).click();
  await again.getByRole("button", { name: /^Show recent chats/ }).click();
  await expect(section(again, "Recent").locator(".csb-chat")).toHaveCount(13);
  await noHorizontalOverflow(page);
});

test("a search is one flat list of the same rows, without the headings", async ({ page }, info) => {
  await givenMix(page);
  await page.goto("/");
  const side = await chatList(page);
  const search = side.getByRole("textbox", { name: "Search chats", exact: true });
  // A letter (not yet a search inside messages): the matches in the list's own order, as rows with their states.
  await search.fill("re");
  await expect(side.locator(".csb-group, .csb-heading")).toHaveCount(0);
  const found = side.getByRole("group", { name: "Chats found", exact: true });
  expect(await names(found)).toEqual(["Release notes", "Run the tests before the release goes out tonight", "Research helpers", "Refactor the importer", "Holiday photos", "Design review", "Weekly report"]);
  await expect(words(side, "Release notes")).toHaveText("Working · 12m");
  await expect(words(side, "Research helpers")).toHaveText("3 helpers working");
  await expect(found.locator(".csb-chat > .avatar, .csb-chat > .group-avatar")).toHaveCount(7);
  await page.screenshot({ ...shot(`search-${info.project.name}.png`), animations: "disabled" });
  // By folder, by agent, by a model of your own, by who's in a group chat.
  await search.fill("api-server");
  expect(await names(found)).toEqual(["Migrate the database"]);
  await search.fill("qwen");
  expect(await names(found)).toEqual(["Summarise the meeting"]);
  await search.fill("@codex");
  expect(await names(found)).toEqual(["Design review"]);
  // Nothing: said once, for the chats (messages say their own).
  await search.fill("zzzz");
  await expect(side.locator(".csb-chat")).toHaveCount(0);
  await expect(side.getByText("No chats match.", { exact: true })).toBeVisible();
  // Cleared: the sections are back.
  await side.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(side.locator(".csb-group .csb-heading")).toHaveText(["Pinned 2", "Needs you 2", "Working 3", "Recent 8"]);
  await noHorizontalOverflow(page);
});

test("the row under the list: Screen, Bookmarks, Terminal, Settings, each a finger's size, the open one tinted", async ({ page }, info) => {
  await givenMix(page);
  await page.goto("/#/bookmarks");
  const side = await chatList(page);
  const tabs = side.getByRole("navigation", { name: "More", exact: true }).getByRole("button");
  await expect(tabs).toHaveText(["Screen", "Bookmarks", "Terminal", "Settings"]);
  // One row: every button at the same height on the page, side by side, at least 44 px each way.
  const boxes = await Promise.all((await tabs.all()).map(async (t) => (await t.boundingBox())!));
  for (const b of boxes) {
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(Math.abs(b.y - boxes[0].y)).toBeLessThan(1);
  }
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 0.5);
  // It takes one row's height, not three.
  const foot = (await side.locator(".csb-foot").boundingBox())!;
  expect(foot.height).toBeLessThanOrEqual(64);
  // The screen that's open is tinted, and said to be the current one.
  const bookmarks = tabs.filter({ hasText: "Bookmarks" });
  await expect(bookmarks).toHaveAttribute("aria-current", "page");
  await expect(bookmarks).toHaveClass(/active/);
  expect(await bookmarks.evaluate((el) => getComputedStyle(el).color)).not.toBe(await tabs.filter({ hasText: "Terminal" }).evaluate((el) => getComputedStyle(el).color));
  await expect(tabs.filter({ hasText: "Terminal" })).not.toHaveAttribute("aria-current", "page");
  await page.screenshot({ ...shot(`footer-${info.project.name}.png`), animations: "disabled" });
  // Each opens its screen.
  await tabs.filter({ hasText: "Settings" }).click();
  await expect(page).toHaveURL(/#\/settings/);
  await noHorizontalOverflow(page);
});

test("on a small phone (320×568) at least four chats show, with the row under the list in place", async ({ page }, info) => {
  test.skip(info.project.name !== "chromium-320", "Once, at 320 px.");
  await page.setViewportSize({ width: 320, height: 568 });
  await givenMix(page);
  await page.goto("/");
  const side = await chatList(page);
  const list = (await side.locator(".csb-scroll").boundingBox())!;
  const foot = (await side.locator(".csb-foot").boundingBox())!;
  // The row of screens is on screen, whole, under the list.
  expect(foot.y + foot.height).toBeLessThanOrEqual(568);
  expect(foot.y).toBeGreaterThanOrEqual(list.y + list.height - 0.5);
  await expect(side.getByRole("navigation", { name: "More", exact: true }).getByRole("button")).toHaveCount(4);
  // Chats wholly in view.
  let whole = 0;
  for (const el of await side.locator(".csb-chat").all()) {
    const b = (await el.boundingBox())!;
    if (b.y >= list.y - 0.5 && b.y + b.height <= list.y + list.height + 0.5) whole++;
  }
  expect(whole).toBeGreaterThanOrEqual(4);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("list-320x568.png"), animations: "disabled" });
});

test("a chat moves as the hub says its state changed, and what it says follows", async ({ page }) => {
  const given = await givenMix(page);
  const say = await liveSocket(page);
  await page.goto("/");
  const side = await chatList(page);
  const member = (roomId: string) => given.members.find((m) => m.roomId === roomId)!;
  const room = (id: string) => given.rooms.find((r) => r.id === id)!;
  const now = Date.now();
  // The list is in (and so is the connection the hub's news comes over).
  await expect(side.locator(".csb-chat")).toHaveCount(15);

  // A quiet chat starts working: it goes to Working, the newest there, and says for how long once a minute is up.
  say({ t: "room", room: { ...room("r5"), updatedAt: now } });
  say({ t: "member", member: { ...member("r5"), status: "working" } });
  say({ t: "turn", turn: { id: "t-r5", roomId: "r5", memberId: member("r5").id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: "t-r5", origin: "human", status: "running", error: null, usage: null, createdAt: now - 3 * MIN, startedAt: now - 3 * MIN, endedAt: null } satisfies Partial<Turn> });
  await expect.poll(() => names(section(side, "Working"))).toEqual(["Weekly report", "Research helpers", "Refactor the importer", "Translate the docs"]);
  await expect(words(side, "Weekly report")).toHaveText("Working · 3m");
  await expect(section(side, "Recent").locator(".csb-heading")).toHaveText("Recent 7");

  // It asks a question: Needs you, at its top (what asked last, first).
  say({ t: "member", member: { ...member("r5"), status: "approval", statusDetail: "Asks: which folder?" } });
  say({ t: "approval", approval: { id: "ap-q", roomId: "r5", memberId: member("r5").id, turnId: "t-r5", kind: "question", title: "Which folder?", detail: "", status: "pending", decision: null, decidedBy: null, createdAt: now, decidedAt: null } satisfies Approval });
  await expect.poll(() => names(section(side, "Needs you"))).toEqual(["Weekly report", "Run the tests before the release goes out tonight", "Migrate the database"]);
  await expect(words(side, "Weekly report")).toHaveText("Asked you a question");
  // A second request in the chat that already had one: counted on its row, and now the newest.
  say({ t: "approval", approval: { ...given.approvals[0], id: "ap-2", title: "npm run build", createdAt: now + 1000 } });
  await expect(words(side, "Run the tests before the release goes out tonight")).toHaveText("Needs your OK · 2");
  await expect.poll(() => names(section(side, "Needs you"))).toEqual(["Run the tests before the release goes out tonight", "Weekly report", "Migrate the database"]);

  // Answered, it works on; then its reply ends with no one reading: Recent's top, bold, with the unread dot.
  say({ t: "approval", approval: { id: "ap-q", roomId: "r5", memberId: member("r5").id, turnId: "t-r5", kind: "question", title: "Which folder?", detail: "", status: "approved", decision: "approve", decidedBy: "Phone", createdAt: now, decidedAt: now + 2000 } });
  say({ t: "member", member: { ...member("r5"), status: "working" } });
  await expect(words(side, "Weekly report")).toHaveText("Working · 3m");
  say({ t: "turn", turn: { id: "t-r5", roomId: "r5", memberId: member("r5").id, status: "done", createdAt: now - 3 * MIN, startedAt: now - 3 * MIN, endedAt: now + 3000 } });
  say({ t: "member", member: { ...member("r5"), status: "idle" } });
  say({ t: "room", room: { ...room("r5"), updatedAt: now + 3000, lastReplyAt: now + 3000 } });
  await expect.poll(async () => (await names(section(side, "Recent")))[0]).toBe("Weekly report");
  await expect(row(side, "Weekly report")).toHaveClass(/unread/);
  await expect(row(side, "Weekly report").locator(".reply-dot")).toHaveCount(1);
  await expect(words(side, "Weekly report")).toHaveText("just now");

  // The helpers finish one by one, then all: the count follows, then the chat is back in Recent.
  const research = member("helpers");
  say({ t: "tasks", roomId: "helpers", memberId: research.id, tasks: given.tasks[research.id].map((t, i) => (i < 2 ? { ...t, status: "completed", endedAt: now } : t)) });
  await expect(words(side, "Research helpers")).toHaveText("1 helper working");
  say({ t: "tasks", roomId: "helpers", memberId: research.id, tasks: given.tasks[research.id].map((t) => ({ ...t, status: "completed", endedAt: now })) });
  await expect.poll(() => names(section(side, "Working"))).toEqual(["Refactor the importer", "Translate the docs"]);
  await expect(words(side, "Research helpers")).toHaveText("9m ago");

  // The failed one is tried again and works: out of Needs you. The one waiting for its limit carries on: it says Working.
  say({ t: "member", member: { ...member("failed"), status: "thinking", statusDetail: null } });
  await expect.poll(() => names(section(side, "Needs you"))).toEqual(["Run the tests before the release goes out tonight"]);
  await expect(words(side, "Migrate the database")).toHaveText("Working");
  say({ t: "member", member: { ...member("limit"), status: "working", wait: null } });
  await expect(words(side, "Translate the docs")).toHaveText("Working");
  // A working one fails: Needs you says so in words.
  say({ t: "member", member: { ...member("working"), status: "error", statusDetail: "exit code 1" } });
  await expect(words(side, "Refactor the importer")).toHaveText("Failed");
  await expect.poll(() => names(section(side, "Needs you"))).toContain("Refactor the importer");
  // The pinned one never left Pinned through any of it.
  expect(await names(section(side, "Pinned"))).toEqual(["Release notes", "Fix the login page"]);
  await noHorizontalOverflow(page);
});

/** A chat on the test hub whose agent is the scripted one. */
async function mockChat(request: APIRequestContext, token: string, name: string, config: Record<string, unknown>) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode: "direct" } })).json();
  const member: Member = await (await request.post(`${HUB}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "tester", config } })).json();
  return { room, member, headers, send: (text: string) => request.post(`${HUB}/api/rooms/${room.id}/messages`, { headers, data: { text } }), remove: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

test("with a real agent on the hub: asking, working, its helper working on, then a new reply in Recent", async ({ page, request, token }) => {
  // The scripted agent asks for an OK, works for a couple of seconds, and leaves a helper at work after its reply.
  const quiet = await mockChat(request, token, "State quiet chat", { delayMs: 10 });
  const chat = await mockChat(request, token, "State moving chat", { delayMs: 2500, approval: true, helpers: { ms: 2500 } });
  try {
    await page.goto("/");
    const side = await chatList(page);
    await expect(section(side, "Recent").locator(".csb-chat-name", { hasText: "State moving chat" })).toHaveCount(1);
    await chat.send("please run the tests");

    // It asks for an OK: under Needs you, in words.
    await expect(section(side, "Needs you").locator(".csb-chat-name", { hasText: "State moving chat" })).toHaveCount(1);
    await expect(words(side, "State moving chat")).toHaveText("Needs your OK");
    await expect(section(side, "Recent").locator(".csb-chat-name", { hasText: "State moving chat" })).toHaveCount(0);
    // Approved from another device: it works on, under Working.
    const state = await (await request.get(`${HUB}/api/state`, { headers: chat.headers })).json();
    const asked = (state.approvals as Approval[]).find((a) => a.roomId === chat.room.id)!;
    expect((await request.post(`${HUB}/api/approvals/${asked.id}`, { headers: chat.headers, data: { decision: "approve" } })).ok()).toBe(true);
    await expect(section(side, "Working").locator(".csb-chat-name", { hasText: "State moving chat" })).toHaveCount(1);
    await expect(words(side, "State moving chat")).toHaveText("Working");
    // Its reply ends and its helper works on: still Working, and it says who is.
    await expect(words(side, "State moving chat")).toHaveText("1 helper working");
    await expect(section(side, "Working").locator(".csb-chat-name", { hasText: "State moving chat" })).toHaveCount(1);
    // A device that opens the app now knows it too, from the hub's state alone (no event has told it).
    const fresh = await (await request.get(`${HUB}/api/state`, { headers: chat.headers })).json();
    expect(Object.keys(fresh.tasks)).toContain(chat.member.id);
    // The helper done: the chat is at Recent's top with a reply no one has read.
    await expect(section(side, "Recent").locator(".csb-chat-name").first()).toHaveText("State moving chat");
    await expect(row(side, "State moving chat")).toHaveClass(/unread/);
    await expect(section(side, "Working").locator(".csb-chat-name", { hasText: "State moving chat" })).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally {
    await chat.remove();
    await quiet.remove();
  }
});

test("a reply that fails puts its chat under Needs you, saying Failed", async ({ page, request, token }) => {
  const chat = await mockChat(request, token, "State failing chat", { delayMs: 10, fail: true });
  try {
    await page.goto("/");
    const side = await chatList(page);
    await chat.send("try it");
    await expect(section(side, "Needs you").locator(".csb-chat-name", { hasText: "State failing chat" })).toHaveCount(1);
    await expect(words(side, "State failing chat")).toHaveText("Failed");
    await expect(row(side, "State failing chat")).toHaveAccessibleName(/^State failing chat, (new reply, )?Failed, just now$/);
  } finally {
    await chat.remove();
  }
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });
  test.beforeEach(({}, info) => test.skip(!/-(390|320)$/.test(info.project.name), "A phone."));

  test("a row has no ⋯, and Hold a chat to pin it shows until a long press or its ✕", async ({ page }, info) => {
    await givenMix(page);
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    let side = await chatList(page);
    // The hint, once, at the top of the list.
    const hint = side.getByText("Hold a chat to pin it", { exact: true });
    await expect(hint).toBeVisible();
    await page.screenshot({ ...shot(`hint-${info.project.name}.png`), animations: "disabled" });
    // No ⋯ to see or to hit: the row's end is the unread dot's alone. It's still there for a screen reader.
    const more = side.getByRole("button", { name: "Options for Holiday photos", exact: true });
    await expect(more).toHaveCount(1);
    const size = (await more.boundingBox())!;
    expect(size.width).toBeLessThanOrEqual(1);
    expect(size.height).toBeLessThanOrEqual(1);
    // Its ✕ puts it away, and it stays away when the list is drawn again.
    await side.getByRole("button", { name: "Hide this tip", exact: true }).click();
    await expect(hint).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("crosstalk.sidebar.holdHint"))).toBe("1");
    await page.reload();
    side = await chatList(page);
    await expect(side.locator(".csb-chat")).toHaveCount(15);
    await expect(side.getByText("Hold a chat to pin it", { exact: true })).toHaveCount(0);

    // Shown again (as on a device that never saw it): a long press opens the row's options and that's the end of it.
    await page.evaluate(() => localStorage.removeItem("crosstalk.sidebar.holdHint"));
    await page.reload();
    side = await chatList(page);
    await expect(side.getByText("Hold a chat to pin it", { exact: true })).toBeVisible();
    const target = row(side, "Holiday photos");
    const b = (await target.boundingBox())!;
    const at = { clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 };
    await target.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, bubbles: true, ...at });
    await expect(side.getByRole("group", { name: "Options for Holiday photos", exact: true }).getByRole("button", { name: "Pin to top", exact: true })).toBeVisible();
    await target.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, bubbles: true, ...at });
    await expect(side.getByText("Hold a chat to pin it", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("crosstalk.sidebar.holdHint"))).toBe("1");
    await noHorizontalOverflow(page);
  });

  test("a finger on the list holds its rows where they are until it lifts", async ({ page }) => {
    const given = await givenMix(page);
    const say = await liveSocket(page);
    await page.goto("/");
    const side = await chatList(page);
    await expect(side.locator(".csb-chat")).toHaveCount(15);
    const before = await names(side);
    // A finger comes down on a row.
    const target = row(side, "Holiday photos");
    const b = (await target.boundingBox())!;
    const touch = [{ identifier: 1, clientX: b.x + 40, clientY: b.y + b.height / 2 }];
    await target.dispatchEvent("touchstart", { touches: touch, targetTouches: touch, changedTouches: touch });
    // Meanwhile a chat above it starts asking and another finishes: nothing moves, but each row says what's true now.
    const member = given.members.find((m) => m.roomId === "r6")!;
    say({ t: "member", member: { ...member, status: "approval" } });
    say({ t: "approval", approval: { ...given.approvals[0], id: "ap-held", roomId: "r6", memberId: member.id, createdAt: Date.now() } });
    await expect(words(side, "Pricing page copy")).toHaveText("Needs your OK");
    expect(await names(side)).toEqual(before);
    expect(Math.round((await target.boundingBox())!.y)).toBe(Math.round(b.y));
    // The finger lifts: the list is as it is.
    await target.dispatchEvent("touchend", { touches: [], targetTouches: [], changedTouches: touch });
    await expect.poll(() => names(section(side, "Needs you"))).toEqual(["Pricing page copy", "Run the tests before the release goes out tonight", "Migrate the database"]);
    await expect(section(side, "Recent").locator(".csb-heading")).toHaveText("Recent 7");
  });
});
