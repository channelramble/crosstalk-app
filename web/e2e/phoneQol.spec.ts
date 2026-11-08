import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Member, Message, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";
import { join } from "node:path";

const hub = "http://127.0.0.1:8451";

/** A real chat whose history and live events the test writes (its agent never runs). */
async function chat(page: Page, request: APIRequestContext, token: string, name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  const history = { room, messages: [] as Message[], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let seq = 0;
  const message = (kind: "human" | "agent", text: string, extra: Partial<Message> = {}): Message =>
    ({ id: `pq-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: 1_700_000_000_000 + seq * 1000, updatedAt: 1_700_000_000_000 + seq * 1000, ...extra }) as Message;
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });
  });
  // The agent has read the history a test writes (Member.readSeq), so nothing shows as waiting for it.
  delete member.readSeq;
  const read = () => ({ ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, readSeq: Math.max(0, ...history.messages.map((x) => x.seq ?? 0)) } : m)) });
  await page.route("**/api/state", (r) => r.fulfill({ json: read() }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  const send = (event: unknown) => socket!.send(JSON.stringify(event));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, member, history, message, send, open, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

/** What the page copies goes to `window.copied` instead of the clipboard (which tests can't read in every engine). */
async function catchCopies(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { w.copied.push(text); } } });
  });
}
const copies = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied);

const zoomNow = (page: Page) => page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom));
const setZoom = (page: Page, percent: number) => page.evaluate(async (p) => (await import("/src/zoom.ts")).setZoom(p), percent);

/**
 * The screen fits a phone: the app fills the window, nothing is wider than it, and every button, field, menu and
 * dialog showing is fully on the screen (not cut off by the screen's edge or by the page around it).
 */
async function fitsScreen(page: Page) {
  // Where sheets and menus end up, not where their opening animation has them.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  await noHorizontalOverflow(page);
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const height = window.visualViewport?.height ?? innerHeight;
    const app = document.querySelector(".app")!.getBoundingClientRect();
    if (Math.abs(app.height - height) > 1.5 || Math.abs(app.top) > 1.5) out.push(`the app is ${app.height}px tall at ${app.top}px in a ${height}px window`);
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}"`;
    for (const el of document.querySelectorAll("button, input, textarea, select, [role=dialog], .ctl-pop")) {
      const r = el.getBoundingClientRect();
      // Hidden actions under messages, and the things that scroll sideways on purpose: code and the files on a message.
      if (!r.width || !r.height || el.closest(".msg-actions, pre, .composer-files")) continue;
      // Settings' row of tabs scrolls sideways itself, so a tab past the edge is fine — but only while the row really
      // does scroll. A row that stopped scrolling and overflowed the screen is the fault this would otherwise hide.
      const row = el.closest(".settings-tabs-row");
      if (row) {
        if (row.scrollWidth > row.clientWidth + 1) continue;
        out.push(`${name(el)} is past the edge and its tab row doesn't scroll (${row.scrollWidth} in ${row.clientWidth})`);
        continue;
      }
      if (r.left < -1 || r.right > innerWidth + 1) out.push(`${name(el)} spans ${Math.round(r.left)} to ${Math.round(r.right)} on a ${innerWidth}px screen`);
      if (el.matches("[role=dialog], .ctl-pop") && (r.top < -1 || r.bottom > height + 1)) out.push(`${name(el)} spans ${Math.round(r.top)} to ${Math.round(r.bottom)} in a ${height}px window`);
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "hidden") continue;
        const c = p.getBoundingClientRect();
        if (r.right > c.right + 1.5 || r.left < c.left - 1.5) out.push(`${name(el)} is cut off by .${p.className}`);
        break;
      }
    }
    return out;
  });
  expect(problems).toEqual([]);
}

test("text and page size zooms the whole app at once, is kept on this device and fits phone screens", async ({ page, request, token, browserName }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chat(page, request, token, "Zoom checks");
  s.history.messages.push(s.message("human", "Check the release"), s.message("agent", "## Done\n\nThe build passed:\n\n- 412 tests\n- `dist/` is ready"));
  try {
    await page.goto("/#/settings");
    await settingsTab(page, "Devices");
    const card = page.locator(".card").filter({ hasText: "Text and page size" });
    const size = card.getByRole("group", { name: "Text and page size" });
    await expect(size.locator("output")).toHaveText("100%");
    await expect(card.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(await zoomNow(page)).toBe(1);
    // Each press shows the new size at once, on the whole page, and keeps it on this device. The + button stays under
    // the finger: three taps on the same spot of the screen reach the biggest size.
    const bigger = card.getByRole("button", { name: "Increase Text and page size" });
    // Display is the first card of its tab, so the + is on screen: brought there anyway, for a bigger text size.
    await bigger.scrollIntoViewIfNeeded();
    const plus = (await bigger.boundingBox())!;
    const spot = { x: plus.x + plus.width / 2, y: plus.y + plus.height / 2 };
    for (const [label, zoom] of [["110%", 1.1], ["125%", 1.25], ["150%", 1.5]] as const) {
      await page.mouse.click(spot.x, spot.y);
      await expect(size.locator("output")).toHaveText(label);
      expect(await zoomNow(page)).toBeCloseTo(zoom);
      const now = (await bigger.boundingBox())!;
      expect(spot.x).toBeGreaterThan(now.x + 4);
      expect(spot.x).toBeLessThan(now.x + now.width - 4);
      expect(spot.y).toBeGreaterThan(now.y + 4);
      expect(spot.y).toBeLessThan(now.y + now.height - 4);
    }
    await expect(bigger).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem("crosstalk.zoom"))).toBe("150");
    await fitsScreen(page);

    // Read before the first render: the app's first frame is already at the saved size and fills the window.
    await page.addInitScript(() => {
      const w = window as unknown as { firstFrame?: { zoom: string; height: number } };
      new MutationObserver((_, observer) => {
        const app = document.querySelector(".app");
        if (!app) return;
        w.firstFrame = { zoom: getComputedStyle(document.documentElement).zoom, height: Math.round(app.getBoundingClientRect().height) };
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    await s.open();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown }).firstFrame)).toEqual({ zoom: "1.5", height: 844 });
    await fitsScreen(page);
    // The message box stays at the bottom of the screen, and above the keyboard when it opens.
    const composerBottom = async () => { const b = (await page.locator(".composer-wrap").boundingBox())!; return Math.round(b.y + b.height); };
    expect(await composerBottom()).toBe(844);
    await page.setViewportSize({ width: 390, height: 500 });
    await expect.poll(composerBottom).toBe(500);
    await fitsScreen(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(composerBottom).toBe(844);
    // Menus and sheets fit too.
    await page.getByTitle("Model").click();
    await expect(page.getByRole("dialog", { name: "Model" })).toBeVisible();
    await fitsScreen(page);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Chat settings" }).click();
    await expect(page.getByRole("dialog", { name: "Chat settings" })).toBeVisible();
    await fitsScreen(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Chat settings" })).toHaveCount(0);

    if (browserName === "chromium") {
      // The notch and home-indicator insets stay the screen's own size (zoom would otherwise draw them bigger).
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 47, bottom: 34, left: 0, right: 0 } } as never);
      await expect.poll(() => page.locator(".topbar").evaluate((el) => Math.round((parseFloat(getComputedStyle(el).paddingTop) - 10) * 1.5))).toBe(47);
      expect(await page.locator(".composer-wrap").evaluate((el) => Math.round((parseFloat(getComputedStyle(el).paddingBottom) - 8) * 1.5))).toBe(34);
      await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 0, bottom: 0, left: 0, right: 0 } } as never);
    }

    // Phone widths from 320 to 430, smallest and largest: a size too big for the screen shows the largest that fits.
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      for (const percent of [80, 150]) {
        await setZoom(page, percent);
        expect(await zoomNow(page)).toBeCloseTo(width === 320 && percent === 150 ? 1.25 : percent / 100);
        await fitsScreen(page);
        // A smaller page doesn't make the message box smaller than 16px on screen (iOS would zoom into it).
        expect(await page.getByRole("textbox", { name: "Message", exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize) * Number(getComputedStyle(document.documentElement).zoom))).toBeGreaterThanOrEqual(16);
        await page.getByTitle("Model").click();
        await fitsScreen(page);
        await page.keyboard.press("Escape");
      }
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/#/settings");
    await settingsTab(page, "Devices");
    await expect(card).toContainText("This screen is too narrow for 150%, so it shows 125%.");
    await fitsScreen(page);
    await card.getByRole("button", { name: "Reset" }).click();
    await expect(size.locator("output")).toHaveText("100%");
    expect(await zoomNow(page)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("crosstalk.zoom"))).toBeNull();
    await expect(card).not.toContainText("too narrow");
  } finally { await s.cleanup(); }
});

test("at the biggest text size the composer's model name isn't cut off: permissions become an icon", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chat(page, request, token, "Big text");
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: { provider: "claude", live: true, error: null, models: [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: null, isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }] } }));
  try {
    await s.open();
    const controls = page.locator(".chat-controls");
    const perm = controls.getByRole("button", { name: /^Permissions: / });
    const label = controls.locator(".ctl-model .ellipsis");
    await expect(label).toHaveText("Sonnet 5.5");
    const whole = () => label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    // At 100% permissions are said in words.
    await expect(controls).not.toHaveClass(/narrow/);
    await expect(perm).not.toHaveText("");
    for (const [width, percent] of [[390, 150], [320, 125]] as const) {
      await page.setViewportSize({ width, height: 844 });
      await setZoom(page, percent);
      await expect(controls).toHaveClass(/narrow/);
      await expect(perm).toHaveText("");
      expect(await whole()).toBe(true);
      await fitsScreen(page);
    }
    await setZoom(page, 100);
  } finally { await s.cleanup(); }
});

test.describe("on a touch screen", () => {
  // Where the keyboard makes the page shorter, as on Android (viewport.ts): how a browser test can bring it up.
  test.use({ hasTouch: true });

  test("with the keyboard up at a big text size, the steps panel leaves room for the chat", async ({ page, request, token }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const s = await chat(page, request, token, "Keyboard room");
    Object.assign(s.member, { status: "working", statusDetail: "npm test" });
    const turnId = "kb-turn";
    for (let i = 0; i < 6; i++) s.history.messages.push(s.message(i % 2 ? "agent" : "human", `Message ${i}: ${"words ".repeat(12)}`));
    s.history.messages.push(s.message("agent", "Working on it.", { turnId, status: "streaming" }));
    (s.history.turns as unknown[]).push({ id: turnId, roomId: s.room.id, memberId: s.member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: turnId, origin: "human", status: "running", error: null, usage: null, createdAt: Date.now() - 60_000, startedAt: Date.now() - 60_000, endedAt: null });
    for (let i = 0; i < 8; i++) (s.history.activities as unknown[]).push({ id: `kb-a${i}`, roomId: s.room.id, turnId, memberId: s.member.id, kind: "command", title: `npm run step-${i}`, detail: "", status: i === 7 ? "running" : "done", createdAt: Date.now() - 50_000 + i, updatedAt: Date.now() - 50_000 + i });
    try {
      await s.open();
      await setZoom(page, 150);
      await page.locator(".chat-status").click();
      await expect(page.locator(".chat-status")).toHaveAttribute("aria-expanded", "true");
      // The keyboard takes the bottom of the screen: 508px are left (the app takes its height from what's visible).
      await page.setViewportSize({ width: 390, height: 508 });
      await page.getByRole("textbox", { name: "Message", exact: true }).focus();
      // Taken for the keyboard, with not much left above it: a slimmer header, and the controls row stays.
      await expect(page.locator("html")).toContainClass("keyboard-open short");
      await expect(page.locator(".chat-controls")).toBeVisible();
      // The chat keeps a few lines of the reply you're answering (it had about one).
      await expect.poll(async () => (await page.locator(".messages").boundingBox())!.height).toBeGreaterThanOrEqual(120);
      // The panel still shows the steps, and scrolls.
      await expect(page.locator(".composer-work")).toBeVisible();
      // (The new height reaches the panel on the next frame after the viewport event: wait for it.)
      await expect.poll(() => page.locator(".composer-work").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await fitsScreen(page);
      await setZoom(page, 100);
    } finally { await s.cleanup(); }
  });
});

test("Copy copies a whole reply as Markdown", async ({ page, request, token }) => {
  await catchCopies(page);
  const reply = "## Release\n\n- **Helper agents** use the chat's model\n- A *Copy* action\n\n```sh\nbun run test\n```";
  const s = await chat(page, request, token, "Copy checks");
  s.history.messages.push(s.message("human", "Summarize it"), s.message("agent", reply), s.message("human", "And now?"), s.message("agent", "Still writing", { status: "streaming" }));
  try {
    await s.open();
    const done = page.locator(".agent-reply").filter({ hasText: "Helper agents" });
    await done.getByText("Helper agents").click();
    const copy = done.getByRole("button", { name: "Copy reply" });
    await expect(copy).toBeVisible();
    // Next to the reply's other actions.
    await expect(done.getByRole("button", { name: "Rewind to here" })).toBeVisible();
    await copy.click();
    await expect(done.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await copies(page)).toEqual([reply]);
    // A reply that's still being written has nothing to copy yet.
    const streaming = page.locator(".agent-reply").filter({ hasText: "Still writing" });
    await streaming.getByText("Still writing").click();
    await expect(streaming.getByRole("button", { name: "Copy reply" })).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("a group room's replies have Copy too", async ({ page, request, token }) => {
  await catchCopies(page);
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Copy group", mode: "direct" } })).json();
  const member: Member = await (await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "helper" } })).json();
  const at = 1_700_000_000_000;
  const messages = [
    { id: "g1", roomId: room.id, authorKind: "human", authorName: "Phone", memberId: null, text: "@helper what changed?", mentions: [], turnId: null, status: "done", createdAt: at, updatedAt: at },
    { id: "g2", roomId: room.id, authorKind: "agent", authorName: "helper", memberId: member.id, text: "Two things:\n\n1. **Copy**\n2. Zoom", mentions: [], turnId: null, status: "done", createdAt: at + 1000, updatedAt: at + 1000 },
  ];
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: { room, messages, turns: [], activities: [], approvals: [], totals: null, hasMore: false } }));
  try {
    await page.goto(`/#/room/${room.id}`);
    const reply = page.locator(".agent-reply").filter({ hasText: "Two things" });
    await reply.getByText("Two things").click();
    await reply.getByRole("button", { name: "Copy reply" }).click();
    await expect(reply.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await copies(page)).toEqual([messages[1].text]);
    await noHorizontalOverflow(page);
  } finally { await request.delete(`${hub}/api/rooms/${room.id}`, { headers }); }
});

test("Jump to latest shows when scrolled up, counts what came in since, and hides at the bottom", async ({ page, request, token }) => {
  const s = await chat(page, request, token, "Jump checks");
  for (let i = 1; i <= 30; i++) s.history.messages.push(s.message("human", `Question ${i}`), s.message("agent", `Answer ${i}\n\nWith a second paragraph, so the chat is long.`));
  try {
    await s.open();
    const scroller = page.locator(".messages");
    const jump = page.getByRole("button", { name: /^Jump to latest/ });
    await expect(page.getByText("Answer 30", { exact: true })).toBeVisible();
    await expect(jump).toHaveCount(0);
    // Scrolled up: the button, with nothing new yet.
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect(jump).toHaveAccessibleName("Jump to latest");
    // New replies while scrolled up are counted; your own messages aren't.
    s.send({ t: "message", message: s.message("agent", "A new reply") });
    s.send({ t: "message", message: s.message("human", "Sent from my other device") });
    s.send({ t: "message", message: s.message("agent", "Another new reply") });
    await expect(jump).toHaveAccessibleName("Jump to latest (2 new)");
    await expect(jump.locator(".count")).toHaveText("2");
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await noHorizontalOverflow(page);
    // Back to the bottom: the newest message shows, and the button goes.
    await jump.click();
    await expect(page.getByText("Another new reply", { exact: true })).toBeInViewport();
    await expect(jump).toHaveCount(0);
    expect(await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    // A reply that keeps streaming while you read earlier messages shows a dot instead of a count.
    const live = s.message("agent", "Writing", { status: "streaming" });
    s.send({ t: "message", message: live });
    await expect(page.getByText("Writing", { exact: true })).toBeVisible();
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect(jump).toHaveAccessibleName("Jump to latest");
    s.send({ t: "message.delta", roomId: s.room.id, messageId: live.id, delta: " more", offset: live.text.length });
    await expect(jump).toHaveAccessibleName("Jump to latest (more below)");
    await expect(jump.locator(".jump-dot")).toBeVisible();
    // Scrolling down by hand hides it too.
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(jump).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("a long streaming reply redraws a few times a second, leaves other replies alone and shows its final text at once", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  // How long the page spends on each streamed word (reading it and drawing it), and when the finished reply arrives.
  // The app reads each frame with JSON.parse; React draws the change in a microtask queued after that.
  // The agent's status changes too while it writes (a step starts, it goes back to writing): the same for those.
  await page.addInitScript(() => {
    const w = window as unknown as { busy: number; deltas: number; memberBusy: number; members: number; doneAt?: number };
    w.busy = 0;
    w.deltas = 0;
    w.memberBusy = 0;
    w.members = 0;
    const parse = JSON.parse;
    JSON.parse = function (text: string, ...rest: unknown[]) {
      if (typeof text === "string" && text.includes('"long"')) {
        const start = performance.now();
        if (text.includes('"status":"done"')) w.doneAt = start;
        if (text.includes('"message.delta"')) queueMicrotask(() => queueMicrotask(() => { w.busy += performance.now() - start; w.deltas++; }));
      } else if (typeof text === "string" && text.startsWith('{"t":"member"')) {
        const start = performance.now();
        queueMicrotask(() => queueMicrotask(() => { w.memberBusy += performance.now() - start; w.members++; }));
      }
      return parse.call(JSON, text, ...(rest as [])) as unknown;
    } as typeof JSON.parse;
  });
  const s = await chat(page, request, token, "Streaming checks");
  // Thirty long earlier replies: drawing them again on every word would take far longer than the word itself.
  const earlier = (i: number) => [`## Step ${i}`, "", ...Array.from({ length: 12 }, (_, k) => `- **Item ${k}** with \`code()\` and a [link](https://example.com/${i}/${k}) that runs on for a while`), "", "```ts", ...Array.from({ length: 12 }, (_, k) => `const v${k} = await run(${k});`), "```"].join("\n");
  for (let i = 1; i <= 30; i++) s.history.messages.push(s.message("human", `Question ${i}`), s.message("agent", earlier(i), { turnId: `t${i}` }));
  s.history.messages.push(s.message("human", "Now the long one"));
  try {
    await s.open();
    s.send({ t: "message", message: s.message("agent", "", { id: "long", status: "streaming" }) });
    const live = page.locator(".msg.agent.streaming");
    await expect(live).toHaveCount(1);
    await page.evaluate(() => {
      const w = window as unknown as { commits: number; shownAt?: number; earlierChanges: number; earlier: Element };
      w.commits = 0;
      const el = document.querySelector(".msg.agent.streaming")!;
      new MutationObserver(() => {
        w.commits++;
        if (!w.shownAt && el.textContent?.includes("The end.")) w.shownAt = performance.now();
      }).observe(el, { subtree: true, childList: true, characterData: true });
      // An earlier reply is left alone: its formatted text is never replaced or touched while the new one streams.
      w.earlierChanges = 0;
      w.earlier = [...document.querySelectorAll(".msg.agent .md")].find((md) => md.textContent?.includes("Step 15"))!;
      new MutationObserver((changes) => (w.earlierChanges += changes.length)).observe(w.earlier.closest(".msg")!, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    // About a second and a half of a long reply, a word at a time.
    let text = "";
    const started = Date.now();
    for (let i = 0; i < 160; i++) {
      const delta = i % 20 === 0 ? `\n\n## Part ${i / 20 + 1}\n\n` : `word${i} `;
      s.send({ t: "message.delta", roomId: s.room.id, messageId: "long", delta, offset: text.length });
      text += delta;
      if (i % 8 === 4) s.send({ t: "member", member: { ...s.member, status: "working", statusDetail: i % 16 === 4 ? `npm run step-${i}` : null } });
      await page.waitForTimeout(8);
    }
    const seconds = (Date.now() - started) / 1000;
    // It kept up while streaming, but redrew a few times a second instead of on every word.
    await expect(live).toContainText("word159");
    const { commits, busy, deltas } = await page.evaluate(() => {
      const w = window as unknown as { commits: number; busy: number; deltas: number };
      return { commits: w.commits, busy: w.busy, deltas: w.deltas };
    });
    expect(deltas).toBe(160);
    expect(commits).toBeGreaterThanOrEqual(2);
    expect(commits).toBeLessThanOrEqual(Math.ceil(seconds * 4) + 3);
    // A few milliseconds a word: the earlier replies aren't formatted again (that took about 75 ms a word here).
    expect(busy / deltas, `${Math.round(busy)} ms for ${deltas} words`).toBeLessThan(15);
    // Nor when the agent's status changes: that used to format every reply in the chat again, each time.
    const { memberBusy, members, earlierChanges, same } = await page.evaluate(() => {
      const w = window as unknown as { memberBusy: number; members: number; earlierChanges: number; earlier: Element };
      const now = [...document.querySelectorAll(".msg.agent .md")].find((md) => md.textContent?.includes("Step 15"));
      return { memberBusy: w.memberBusy, members: w.members, earlierChanges: w.earlierChanges, same: now === w.earlier };
    });
    expect(members).toBe(20);
    expect(memberBusy / members, `${Math.round(memberBusy)} ms for ${members} status changes`).toBeLessThan(15);
    expect(earlierChanges).toBe(0);
    expect(same).toBe(true);
    // The finished reply shows at once, not on the next redraw.
    s.send({ t: "message", message: s.message("agent", `${text}\n\nThe end.`, { id: "long", status: "done" }) });
    await expect(page.locator(".messages")).toContainText("The end.");
    const { doneAt, shownAt } = await page.evaluate(() => {
      const w = window as unknown as { doneAt: number; shownAt: number };
      return { doneAt: w.doneAt, shownAt: w.shownAt };
    });
    expect(shownAt - doneAt).toBeLessThan(100);
  } finally { await s.cleanup(); }
});

// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});

/** Sending is answered by this stand-in (never the test hub, whose agent would really run): the message as saved. */
async function fakeSend(page: Page, s: Awaited<ReturnType<typeof chat>>, opts: { liveFirst?: boolean } = {}) {
  const sent: Message[] = [];
  await page.route(`**/api/rooms/${s.room.id}/messages`, async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    const text = String(r.request().postDataJSON().text);
    const saved = s.message("human", text, { authorName: "Browser tests", createdAt: Date.now(), updatedAt: Date.now() });
    sent.push(saved);
    // A connection that works delivers the message's own event, usually before the answer.
    if (opts.liveFirst) s.send({ t: "message", message: saved });
    await r.fulfill({ json: saved });
  });
  return sent;
}

const atBottom = (page: Page) => page.locator(".messages").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test("sending while scrolled up brings you down to your message", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chat(page, request, token, "Send and follow");
  for (let i = 1; i <= 30; i++) s.history.messages.push(s.message("human", `Question ${i}`), s.message("agent", `Answer ${i}\n\nWith a second paragraph, so the chat is long.`));
  const sent = await fakeSend(page, s, { liveFirst: true });
  try {
    await s.open();
    const scroller = page.locator(".messages");
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect(page.getByRole("button", { name: /^Jump to latest/ })).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Ship the release");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // Down to it, once, with the chat following again.
    const mine = page.locator(".msg.human").filter({ hasText: "Ship the release" });
    await expect(mine).toHaveCount(1);
    await expect(mine).toBeInViewport();
    await expect.poll(() => atBottom(page)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: /^Jump to latest/ })).toHaveCount(0);
    expect(sent.map((m) => m.text)).toEqual(["Ship the release"]);
    // The reply starting under it is followed too.
    s.send({ t: "message", message: s.message("agent", "On it.", { id: "follow", status: "streaming" }) });
    s.send({ t: "message.delta", roomId: s.room.id, messageId: "follow", delta: "\n\nStep one: the changelog.\n\nStep two: the tag.", offset: 6 });
    await expect(page.getByText("Step two: the tag.")).toBeInViewport();
    await page.screenshot({ ...shot("sent-message-followed.png"), animations: "disabled" });
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("scrolling up a few lines while a reply streams stays put", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chat(page, request, token, "Reread while it writes");
  for (let i = 1; i <= 20; i++) s.history.messages.push(s.message("human", `Question ${i}`), s.message("agent", `Answer ${i}\n\nWith a second paragraph, so the chat is long.`));
  s.history.messages.push(s.message("agent", "Writing the long answer", { id: "live", status: "streaming" }));
  try {
    await s.open();
    await expect.poll(() => atBottom(page)).toBeLessThan(2);
    // Three lines up, by hand, to reread something.
    const box = (await page.locator(".messages").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -60);
    await expect.poll(() => atBottom(page)).toBeGreaterThan(40);
    const before = await page.locator(".messages").evaluate((el) => el.scrollTop);
    // The reply keeps coming in under it.
    let offset = "Writing the long answer".length;
    for (let i = 0; i < 12; i++) {
      const delta = `\n\nParagraph ${i} of the answer, long enough to push the bottom of the chat down a line or two.`;
      s.send({ t: "message.delta", roomId: s.room.id, messageId: "live", delta, offset });
      offset += delta.length;
      await page.waitForTimeout(30);
    }
    await expect(page.locator(".messages")).toContainText("Paragraph 11 of the answer");
    await page.waitForTimeout(300); // a redraw or two later
    expect(Math.abs((await page.locator(".messages").evaluate((el) => el.scrollTop)) - before)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: /^Jump to latest/ })).toBeVisible();
    // Back at the bottom by hand: it follows again.
    await page.mouse.wheel(0, 100_000);
    await expect.poll(() => atBottom(page)).toBeLessThan(2);
    s.send({ t: "message.delta", roomId: s.room.id, messageId: "live", delta: "\n\nThe last paragraph.", offset });
    await expect(page.getByText("The last paragraph.")).toBeInViewport();
  } finally { await s.cleanup(); }
});

test("a sent message shows even when the live connection swallows its event", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chat(page, request, token, "Swallowed event");
  s.history.messages.push(s.message("human", "Earlier question"), s.message("agent", "Earlier answer"));
  // The phone was locked: the connection still looks open, but nothing comes through it any more.
  const sent = await fakeSend(page, s);
  try {
    await s.open();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Are you still there?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".msg.human").filter({ hasText: "Are you still there?" })).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
    expect(sent.map((m) => m.text)).toEqual(["Are you still there?"]);
    // Nothing has said it's being answered yet, but it was only just sent: no "Not answered" flashing up under it.
    await expect(page.locator(".not-answered")).toHaveCount(0);
    // Its event turning up late (on a connection that came back) doesn't show it twice.
    s.send({ t: "message", message: sent[0] });
    await page.waitForTimeout(200);
    await expect(page.locator(".msg.human").filter({ hasText: "Are you still there?" })).toHaveCount(1);
    await page.screenshot({ ...shot("sent-without-live-event.png"), animations: "disabled" });
  } finally { await s.cleanup(); }
});

test("screens name the machine they run on instead of assuming a Mac", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const { hub: info } = await (await request.get(`${hub}/api/state`, { headers })).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/settings/more");
  await expect(page.getByText(`A shell on ${info.name}`, { exact: true })).toBeVisible();
  await expect(page.locator(".app")).not.toContainText("the Mac");
  // Every tab of Settings, not only the one the Terminal row is in: each holds its own copy now.
  for (const name of ["Agents", "Models", "Devices", "Usage"]) {
    await settingsTab(page, name);
    await expect(page.locator(".app")).not.toContainText("the Mac");
  }
  await page.getByRole("button", { name: "Show chats" }).click();
  for (const heading of await page.locator(".csb-agent").all()) await expect(heading).toHaveAttribute("title", new RegExp(`chats and sessions on ${info.name}$`));
});
