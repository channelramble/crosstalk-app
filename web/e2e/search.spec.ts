// Search across chats and Markdown export on the phone (docs/SPEC-0.4.md section 14, track T8). The hubs' answers are
// mocked (the shared test hub's state stays as it was, and no agent ever runs); the hub's own answers are checked in
// hub/test/search.test.ts, and once here over the wire.
import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import type { Member, Room, SearchHit, SearchResponse } from "@crosstalk/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { otherMachine, pong } from "./otherMachine";

const HUB = "http://127.0.0.1:8451";
const APP = "http://127.0.0.1:5198";
// CT_SHOTS: a folder to save the screens in, to look at them. A flash is only caught with animations allowed.
async function snap(page: Page, name: string, animations: "disabled" | "allow" = "disabled") {
  if (process.env.CT_SHOTS) await page.screenshot({ path: join(process.env.CT_SHOTS, name), animations });
}
const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" };
/** A request to the app's own hub (through the dev server), not to another machine's. */
const mine = (path: string | RegExp) => (url: URL) => url.origin === APP && (typeof path === "string" ? url.pathname === path : path.test(url.pathname));

/** The chat list is a drawer (opened from Show chats, closed by going to a chat) up to 760 px, and docked open beside the chat above. */
const onPhone = (page: Page) => page.viewportSize()!.width <= 760;

async function drawer(page: Page) {
  if (onPhone(page)) await page.getByRole("button", { name: /^Show chats/ }).click();
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(side).toBeVisible();
  return side;
}
const searchBox = (side: ReturnType<Page["locator"]>) => side.getByRole("textbox", { name: "Search chats", exact: true });
const hitsOf = (side: ReturnType<Page["locator"]>) => side.getByRole("region", { name: "In messages", exact: true });

const PARAGRAPH = "A paragraph about nothing in particular, long enough that this reply is taller than a phone screen once there are eight of them.";
/** A reply taller than the screen, with the words searched for in its sixth paragraph. */
const LONG = Array.from({ length: 8 }, (_, i) => (i === 5 ? "The needle is in this paragraph, far below where the reply starts." : `${PARAGRAPH} (${i + 1})`)).join("\n\n");

const hit = (roomId: string, roomName: string, messageId: string, seq: number, over: Partial<SearchHit> = {}): SearchHit => ({ roomId, roomName, messageId, seq, who: "agent", snippet: "…the needle…", createdAt: Date.now() - seq * 1000, ...over });

/**
 * A Claude Code chat on the test hub whose messages the page is told about: 200 of them (odd: yours, even: the agent's), paged
 * 80 at a time as the hub does, and a search that looks through them. `answer` can be replaced; `gates` holds an answer back.
 */
async function scenario(page: Page, request: APIRequestContext, token: string, opts: { name?: string; texts?: Record<number, string> } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: opts.name ?? "Search checks" } })).json();
  const snapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  const total = 200;
  const at = Date.now();
  const messages = Array.from({ length: total }, (_, i) => {
    const seq = i + 1;
    const human = seq % 2 === 1;
    const time = at - (total - seq) * 60_000;
    return { id: `m-${seq}`, seq, roomId: room.id, authorKind: human ? "human" : "agent", authorName: human ? "Phone" : "claude", memberId: human ? null : member.id, text: opts.texts?.[seq] ?? (human ? `Question number ${seq}` : `Answer number ${seq}`), mentions: [], turnId: null, status: "done", createdAt: time, updatedAt: time };
  });
  const s = {
    room,
    member,
    messages,
    searches: [] as string[],
    historyCalls: [] as number[],
    gates: new Map<string, Promise<void>>(),
    answer: (q: string): SearchResponse => {
      const found = messages.filter((m) => m.text.toLowerCase().includes(q.toLowerCase())).slice(-3).reverse();
      return {
        results: found.map((m) => {
          const i = m.text.toLowerCase().indexOf(q.toLowerCase());
          return hit(room.id, room.name, m.id, m.seq, { who: m.authorKind === "human" ? "you" : "agent", snippet: `${i > 40 ? "…" : ""}${m.text.slice(Math.max(0, i - 40), i + q.length + 50).replace(/\s+/g, " ")}`, createdAt: m.createdAt });
        }),
        chats: [],
        truncated: false,
      };
    },
    cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }),
  };
  await page.routeWebSocket(`ws://127.0.0.1:5198/api/ws?**`, pong);
  await page.route(mine("/api/state"), (r) => r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, readSeq: total } : m)) } }));
  await page.route(mine(`/api/rooms/${room.id}/history`), (r) => {
    const url = new URL(r.request().url());
    const before = Number(url.searchParams.get("before") || 0) || Infinity;
    const limit = Number(url.searchParams.get("limit") || 80);
    s.historyCalls.push(before === Infinity ? 0 : before);
    const page_ = messages.filter((m) => m.seq < before).slice(-limit);
    return r.fulfill({ json: { room, messages: page_, turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: page_.length > 0 && page_[0].seq > 1 && page_.length >= Math.min(limit, 500) } });
  });
  await page.route(mine("/api/search"), async (r) => {
    const q = new URL(r.request().url()).searchParams.get("q") ?? "";
    s.searches.push(q);
    await s.gates.get(q);
    return r.fulfill({ json: s.answer(q) });
  });
  return s;
}

test("2 or more characters add an In messages group: asked once after the pause, the match in bold; a hit opens its chat at that message, which flashes once", async ({ page, request, token }) => {
  const s = await scenario(page, request, token, { texts: { 30: LONG, 151: "Is the needle in the haystack?" } });
  try {
    await page.goto(`/#/room/${s.room.id}`);
    await expect(page.locator('[data-mid="m-200"]')).toBeVisible();
    let side = await drawer(page);
    const box = searchBox(side);
    // One character only filters chat names: nothing is asked of any machine.
    await box.fill("n");
    await page.waitForTimeout(500);
    await expect(hitsOf(side)).toHaveCount(0);
    expect(s.searches).toEqual([]);
    // Typed quickly, the words are asked once, after the pause.
    await box.fill("");
    await box.pressSequentially("needle");
    const found = hitsOf(side);
    await expect(found.locator(".csb-hit")).toHaveCount(2);
    await page.waitForTimeout(500);
    expect(s.searches).toEqual(["needle"]);
    // Newest first, under the chat's name; who said it; the match in bold.
    await expect(found.locator(".search-chat-name")).toHaveText("Search checks");
    await expect(found.locator(".csb-hit").nth(0)).toContainText("You: Is the needle in the haystack?");
    await expect(found.locator(".csb-hit").nth(1)).toContainText("Claude Code: ");
    await expect(found.locator("mark")).toHaveCount(2);
    await expect(found.locator("mark").first()).toHaveText("needle");
    await expect(found.locator("mark").first()).toHaveCSS("font-weight", "700");
    await expect(found.getByText("Searching…")).toHaveCount(0);
    await noHorizontalOverflow(page);
    expect(await side.locator(".csb-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await snap(page, "01-search-hits.png");

    // The older one is in a page the chat hasn't loaded: it pages back, scrolls to the words in that long reply, flashes it.
    await found.locator(".csb-hit", { hasText: "needle is in this paragraph" }).click();
    if (onPhone(page)) await expect(side).toHaveCount(0);
    const reply = page.locator('[data-mid="m-30"]');
    await expect(reply).toHaveAttribute("data-found", "");
    await snap(page, "02-found-message-flash.png", "allow");
    await expect(reply.locator("p", { hasText: "needle" })).toBeInViewport();
    expect(s.historyCalls).toContain(41);
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    // Once: the mark is gone after a couple of seconds.
    await expect(reply).not.toHaveAttribute("data-found", "", { timeout: 4_000 });

    // The chat is open already, and has this one loaded: it goes straight there.
    side = await drawer(page);
    await expect(hitsOf(side).locator(".csb-hit")).toHaveCount(2);
    await hitsOf(side).locator(".csb-hit", { hasText: "haystack" }).click();
    const yours = page.locator('[data-mid="m-151"]');
    await expect(yours).toHaveAttribute("data-found", "");
    await expect(yours).toBeInViewport();
  } finally {
    await s.cleanup();
  }
});

test("a machine that can't be searched says which, with Try again, and never holds back the others; a hit on another machine opens its chat there", async ({ page, request, token }) => {
  const s = await scenario(page, request, token, { texts: { 30: LONG } });
  const at = Date.now();
  const linuxRoom = { id: "r_linux", name: "Deploy notes", cwd: "/home/me/deploy", mode: "direct", leadMemberId: "mb_linux", maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "codex", origin: "web" } } as Room;
  const linuxMember = { id: "mb_linux", roomId: "r_linux", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: at, position: 0, readSeq: 3 } as Member;
  const linux = await otherMachine(page, token, { port: 8458, rooms: [linuxRoom], members: [linuxMember] });
  const said = (id: string, seq: number, human: boolean, text: string) => ({ id, seq, roomId: "r_linux", authorKind: human ? "human" : "agent", authorName: human ? "Phone" : "codex", memberId: human ? null : "mb_linux", text, mentions: [], turnId: null, status: "done", createdAt: at - (4 - seq) * 60_000, updatedAt: at - (4 - seq) * 60_000 });
  const linuxMessages = [said("m-lx-1", 1, true, "Deploy it"), said("m-lx-2", 2, false, "Deployed. The needle moved to the new build."), said("m-lx-3", 3, true, "Thanks")];
  const asked: string[] = [];
  let failing = true;
  // The Linux box's own hub: its answers to search and to its chat's history (cross-origin, so with the headers a hub sends).
  await page.route((url) => url.origin === linux.base && url.pathname === "/api/search", (r) => {
    if (r.request().method() !== "GET") return r.fallback();
    asked.push(new URL(r.request().url()).searchParams.get("q") ?? "");
    if (failing) return r.fulfill({ status: 500, headers: cors, json: { error: "disk I/O error" } });
    const results = [
      // Sent into this Codex chat by another chat's agent: it says that agent, not this chat's.
      hit("r_linux", "Deploy notes", "m-lx-4", 4, { agent: "Claude Code", snippet: "The needle is in the old build too.", createdAt: at - 60_000 }),
      hit("r_linux", "Deploy notes", "m-lx-2", 2, { snippet: "Deployed. The needle moved to the new build.", createdAt: at - 2 * 60_000 }),
    ];
    return r.fulfill({ headers: cors, json: { results, chats: [], truncated: false } satisfies SearchResponse });
  });
  await page.route((url) => url.origin === linux.base && url.pathname === "/api/rooms/r_linux/history", (r) => {
    if (r.request().method() !== "GET") return r.fallback();
    return r.fulfill({ headers: cors, json: { room: linuxRoom, messages: linuxMessages, turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } });
  });
  try {
    await page.goto(`/#/room/${s.room.id}`);
    await expect(page.locator('[data-mid="m-200"]')).toBeVisible();
    const side = await drawer(page);
    // Both machines are up (the Linux box's chat is listed) before typing: a machine coming up would ask again.
    await expect(side.getByRole("button", { name: /^Deploy notes/ })).toBeVisible();
    await searchBox(side).fill("needle");
    const found = hitsOf(side);
    // This machine's hit is there, and the Linux box's failure is a line of its own: which machine, why, and Try again.
    await expect(found.locator(".csb-hit")).toHaveCount(1);
    await expect(found.locator(".search-chat .machine-tag")).toHaveCount(1);
    const problem = found.locator(".search-problem");
    await expect(problem).toContainText("Couldn't search Linux box. It answered with an error (disk I/O error). Try again in a moment.");
    await expect(problem.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
    expect(s.searches).toEqual(["needle"]);
    expect(asked).toEqual(["needle"]);
    await noHorizontalOverflow(page);
    await snap(page, "03-machine-failed.png");

    // Try again asks only that machine.
    failing = false;
    await problem.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(found.locator(".search-problem")).toHaveCount(0);
    await expect(found.locator(".search-chat", { hasText: "Deploy notes" })).toBeVisible();
    await expect(found.locator(".search-chat", { hasText: "Deploy notes" }).locator(".machine-tag")).toHaveText("Linux");
    // Who said each: the Codex chat's own reply is Codex's, and the message another chat's agent sent in names that agent.
    const deploy = found.locator(".search-chat", { hasText: "Deploy notes" });
    await expect(deploy.locator(".csb-hit")).toHaveCount(2);
    await expect(deploy.locator(".csb-hit", { hasText: "Deployed." })).toContainText("Codex: Deployed. The needle moved to the new build.");
    await expect(deploy.locator(".csb-hit", { hasText: "old build" })).toContainText("Claude Code: The needle is in the old build too.");
    expect(asked).toEqual(["needle", "needle"]);
    expect(s.searches).toEqual(["needle"]);
    await noHorizontalOverflow(page);
    await snap(page, "04-two-machines.png");

    // Its hit switches to that machine and opens its chat at the message.
    await found.locator(".csb-hit", { hasText: "Deployed." }).click();
    await expect(page.locator(".topbar h1")).toHaveText("Deploy notes");
    const message = page.locator('[data-mid="m-lx-2"]');
    await expect(message).toHaveAttribute("data-found", "");
    await expect(message).toBeInViewport();
  } finally {
    await s.cleanup();
  }
});

test("Searching… shows until the answer, an answer to older words is dropped, nothing found says so, and a long list is cut with Show all", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  try {
    await page.goto(`/#/room/${s.room.id}`);
    await expect(page.locator('[data-mid="m-200"]')).toBeVisible();
    const side = await drawer(page);
    const box = searchBox(side);
    const found = hitsOf(side);
    const mark = (text: string): SearchHit => hit(s.room.id, s.room.name, "m-100", 100, { snippet: text });
    s.answer = (q) => ({ results: q === "ne" ? [mark("only for ne")] : q === "needle" ? [mark("the needle test")] : [], chats: [], truncated: false });
    // "ne" is asked and held back; the person goes on typing.
    let release!: () => void;
    s.gates.set("ne", new Promise<void>((done) => (release = done)));
    await box.fill("ne");
    await expect(found.getByRole("status")).toHaveText("Searching…");
    await expect.poll(() => s.searches).toEqual(["ne"]);
    await expect(found.locator(".csb-hit")).toHaveCount(0);
    await snap(page, "05-searching.png");
    await box.fill("needle");
    await expect(found.locator(".csb-hit")).toHaveCount(1);
    await expect(found.locator(".csb-hit")).toContainText("the needle test");
    // The held answer comes at last: it's for words that aren't there any more, so it isn't shown.
    release();
    await page.waitForTimeout(400);
    await expect(found.getByText("only for ne")).toHaveCount(0);
    await expect(found.getByText("Searching…")).toHaveCount(0);
    expect(s.searches).toEqual(["ne", "needle"]);

    // Nothing found.
    await box.fill("zebra");
    await expect(found.getByText("No messages match.", { exact: true })).toBeVisible();
    await expect(found.locator(".csb-hit")).toHaveCount(0);
    await snap(page, "06-no-matches.png");

    // Eight hits in four chats: six are listed, the rest behind Show all.
    s.answer = () => ({
      results: Array.from({ length: 8 }, (_, i) => hit(`r_${i % 4}`, `Chat ${["one", "two", "three", "four"][i % 4]}`, `m-x${i}`, i + 1, { snippet: `…haystack number ${i + 1}…`, createdAt: Date.now() - i * 60_000, who: i % 2 ? "you" : "agent" })),
      chats: [],
      truncated: true,
    });
    await box.fill("haystack");
    await expect(found.locator(".csb-hit")).toHaveCount(6);
    await expect(found.getByRole("button", { name: "Show all 8 matches", exact: true })).toBeVisible();
    await found.getByRole("button", { name: "Show all 8 matches", exact: true }).scrollIntoViewIfNeeded();
    await snap(page, "10-show-all.png");
    await found.getByRole("button", { name: "Show all 8 matches", exact: true }).click();
    await expect(found.locator(".csb-hit")).toHaveCount(8);
    await expect(found.getByText("There are more matches than these. Type more of the words to narrow them down.", { exact: true })).toBeVisible();
    await found.getByRole("button", { name: "Show fewer matches", exact: true }).click();
    await expect(found.locator(".csb-hit")).toHaveCount(6);
  } finally {
    await s.cleanup();
  }
});

test("at 320 px a long chat name and an unbroken link in a snippet stay inside the list", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const link = `https://example.com/${"a".repeat(150)}`;
  const s = await scenario(page, request, token, { name: `A very long chat name that keeps going ${"and-going-".repeat(8)}`, texts: { 30: `needle ${link}`, 151: `${link} needle` } });
  try {
    await page.goto(`/#/room/${s.room.id}`);
    await expect(page.locator('[data-mid="m-200"]')).toBeVisible();
    const side = await drawer(page);
    await searchBox(side).fill("needle");
    const found = hitsOf(side);
    await expect(found.locator(".csb-hit")).toHaveCount(2);
    await noHorizontalOverflow(page);
    expect(await side.locator(".csb-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const row of await found.locator(".csb-hit").all()) expect((await row.boundingBox())!.x + (await row.boundingBox())!.width).toBeLessThanOrEqual(320);
    await found.locator(".csb-hit").first().click();
    await expect(page.locator('[data-mid="m-151"]')).toHaveAttribute("data-found", "");
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

const MD = "# Search checks\n\nClaude Code (claude-model) · Exported 2026-10-28 from Mac mini\n\n---\n\n**You:**\n\nhello\n\n---\n\n**Claude Code:**\n\nHi! Here is `code`.\n";

/** A chat on the test hub, opened with its settings showing, and the export route's answers played by the test. */
async function exportScenario(page: Page, request: APIRequestContext, token: string, init: () => void) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Search checks" } })).json();
  await page.addInitScript(init);
  const asked: (string | undefined)[] = [];
  const answers: { status: number; body: unknown }[] = [];
  await page.route(mine(`/api/chats/${room.id}/export.md`), (r) => {
    asked.push(r.request().headers().authorization);
    const next = answers.shift();
    if (next) return r.fulfill({ status: next.status, json: next.body });
    return r.fulfill({ status: 200, headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="Search checks.md"` }, body: MD });
  });
  await page.goto(`/#/room/${room.id}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Chat settings", exact: true });
  await expect(dialog).toBeVisible();
  return { room, dialog, asked, answers, button: dialog.getByRole("button", { name: "Export as Markdown", exact: true }), cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

test("Export as Markdown downloads the file when the browser can't share files, and a failure says why with Try again", async ({ page, request, token }) => {
  const e = await exportScenario(page, request, token, () => {
    Object.defineProperty(navigator, "canShare", { value: () => false, configurable: true });
  });
  try {
    await expect(e.button).toBeVisible();
    await e.button.scrollIntoViewIfNeeded();
    await noHorizontalOverflow(page);
    await snap(page, "07-chat-settings-export.png");
    // An older machine doesn't know the route: its answer is said plainly, and Try again asks again.
    e.answers.push({ status: 404, body: { error: "not found" } });
    await e.button.click();
    const failure = page.locator(".toast", { hasText: "Couldn't export this chat." });
    await expect(failure).toContainText("This machine runs an older Crosstalk that can't export yet. Update it, then try again.");
    await expect(e.button).toBeEnabled();
    await snap(page, "08-export-failed.png");
    const download = page.waitForEvent("download");
    await failure.getByRole("button", { name: "Try again", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("Search checks.md");
    expect(readFileSync((await file.path())!, "utf8")).toBe(MD);
    // Fetched with this device's own sign-in, both times.
    expect(e.asked).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    await expect(page.locator(".toast", { hasText: "Saved Search checks.md to this device's downloads." })).toBeVisible();
    await snap(page, "09-export-saved.png");
  } finally {
    await e.cleanup();
  }
});

test("Export as Markdown hands the file to the share sheet when the browser can share files (as plain text where Markdown isn't taken), and closing the sheet saves nothing", async ({ page, request, token }) => {
  const e = await exportScenario(page, request, token, () => {
    const w = window as unknown as { __shared: unknown[]; __close: boolean; __plainOnly: boolean };
    w.__shared = [];
    w.__close = false;
    w.__plainOnly = false;
    // A phone's share sheet may take plain text but not Markdown: then the same text is shared as plain text.
    Object.defineProperty(navigator, "canShare", { value: (d?: { files?: File[] }) => !!d?.files?.length && (!w.__plainOnly || d.files.every((f) => f.type === "text/plain")), configurable: true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (d: { title?: string; files: File[] }) => {
        if (w.__close) throw new DOMException("closed", "AbortError");
        w.__shared.push({ title: d.title, name: d.files[0].name, type: d.files[0].type, text: await d.files[0].text() });
      },
    });
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  try {
    await e.button.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).toEqual([{ title: "Search checks", name: "Search checks.md", type: "text/markdown", text: MD }]);
    await expect(e.button).toHaveText("Export as Markdown");
    // A share sheet that takes only plain text gets the same file as plain text.
    await page.evaluate(() => ((window as unknown as { __plainOnly: boolean }).__plainOnly = true));
    await e.button.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: { type: string; name: string }[] }).__shared.map((f) => `${f.name} ${f.type}`))).toEqual(["Search checks.md text/markdown", "Search checks.md text/plain"]);
    // The sheet closed without choosing: not a failure, and nothing is saved instead.
    await page.evaluate(() => ((window as unknown as { __close: boolean }).__close = true));
    await e.button.click();
    await expect.poll(() => e.asked.length).toBe(3);
    await expect(e.button).toBeEnabled();
    await page.waitForTimeout(300);
    expect(downloads).toBe(0);
    await expect(page.locator(".toast")).toHaveCount(0);
  } finally {
    await e.cleanup();
  }
});

test("the hub itself answers search and export over the wire: a chat's name is found, the export is a Markdown file", async ({ request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Wire check chat" } })).json();
  try {
    const search = (await (await request.get(`${HUB}/api/search?q=${encodeURIComponent("wire check")}`, { headers })).json()) as SearchResponse;
    expect(search.results).toEqual([]);
    expect(search.chats?.map((c) => c.roomName)).toEqual(["Wire check chat"]);
    expect(search.truncated).toBe(false);
    expect(await (await request.get(`${HUB}/api/search?q=w`, { headers })).json()).toEqual({ results: [], chats: [], truncated: false });
    expect((await request.get(`${HUB}/api/search?q=wire`)).status()).toBe(401);
    const md = await request.get(`${HUB}/api/chats/${room.id}/export.md`, { headers });
    expect(md.status()).toBe(200);
    expect(md.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(md.headers()["content-disposition"]).toContain(`filename="Wire check chat.md"`);
    expect(await md.text()).toMatch(/^# Wire check chat\n\nClaude Code .*Exported \d{4}-\d{2}-\d{2}/);
    expect((await request.get(`${HUB}/api/chats/r_nope/export.md`, { headers })).status()).toBe(404);
  } finally {
    await request.delete(`${HUB}/api/rooms/${room.id}`, { headers });
  }
});
