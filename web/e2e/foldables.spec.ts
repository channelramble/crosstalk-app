import type { APIRequestContext, CDPSession, Page, WebSocketRoute } from "@playwright/test";
import type { Member, Message, Room } from "@crosstalk/shared";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Foldables, and the screen changing size under the app (scrollPlace.ts, styles.css "foldables"): a Galaxy Z Fold-sized
// screen folded (344 × 882) and unfolded (882 × 1104), turned, and half-folded. Half-folded postures are Chrome's own
// emulation of a fold (the device mode's display feature), so those run in Chromium; the rest in Chromium and WebKit,
// whose Safari keeps no place by itself (no CSS scroll anchoring).

const hub = "http://127.0.0.1:8451";
const FOLDED = { width: 344, height: 882 };
const UNFOLDED = { width: 882, height: 1104 };

test.beforeEach(() => {
  test.skip(!["chromium-390", "webkit-390"].includes(test.info().project.name), "Sizes are set by the test itself.");
});

/**
 * A real chat whose history the test writes (its agent never runs). `long`: message 14 is a reply of 80 paragraphs, or
 * (`"code"`) one with a 120-line code block between two paragraphs.
 */
async function chat(page: Page, request: APIRequestContext, token: string, name: string, count = 30, long: boolean | "code" = false) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  delete member.readSeq;
  const messages: Message[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const kind = seq % 2 ? "human" : "agent";
    const text = long === "code" && seq === 14
      ? `Before the code: ${"a paragraph that wraps onto several lines on a folded screen ".repeat(4)}\n\n\`\`\`\n${Array.from({ length: 120 }, (_, i) => `line ${i + 1}: const value${i + 1} = compute(${i + 1});`).join("\n")}\n\`\`\`\n\nAfter the code.`
      : long && seq === 14
      ? Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}: ${"a reply long enough to read through on a folded screen ".repeat(2)}`).join("\n\n")
      : `Message ${seq}: ${"words to fill the line ".repeat(1 + (seq % 5))}`;
    messages.push({ id: `fold-${seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: 1_700_000_000_000 + seq * 1000, updatedAt: 1_700_000_000_000 + seq * 1000 } as Message);
  }
  const history = { room, messages, turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  await page.routeWebSocket("**/api/ws?**", (ws: WebSocketRoute) => {
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  const read = () => ({ ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, readSeq: count } : m)) });
  await page.route("**/api/state", (r) => r.fulfill({ json: read() }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect(page.locator(".messages").getByText(`Message ${count}:`)).toBeVisible();
  };
  return { room, open, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

/** The screen changes size, and the app has had its frames to follow. */
async function resize(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));
}

const fromBottom = (page: Page) => page.locator(".messages").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));

/** Where a message is, from the top of the chat's scrolling part. */
const topOf = (page: Page, text: string) =>
  page.locator(".messages").evaluate((sc, text) => {
    const el = ([...sc.querySelectorAll(".inner p")].find((e) => e.textContent?.startsWith(text)) ?? [...sc.querySelectorAll(".inner > *")].find((e) => e.textContent?.includes(text)))!;
    return Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top);
  }, text);

/** Scrolls the chat so what starts with `text` is `below` px under its top edge (as if by hand). */
const scrollTo = (page: Page, text: string, below: number) =>
  page.locator(".messages").evaluate((sc, [text, below]) => {
    const el = ([...sc.querySelectorAll(".inner p")].find((e) => e.textContent?.startsWith(text as string)) ?? [...sc.querySelectorAll(".inner > *")].find((e) => e.textContent?.includes(text as string)))!;
    // Distances on screen are drawn bigger by the page's zoom; scroll positions are the scroller's own pixels.
    const view = sc.getBoundingClientRect();
    const scale = view.height / (sc as HTMLElement).offsetHeight;
    sc.scrollTop += (el.getBoundingClientRect().top - view.top - (below as number)) / scale;
  }, [text, below] as const);

const setZoom = (page: Page, percent: number) => page.evaluate(async (p) => (await import("/src/zoom.ts")).setZoom(p), percent);

/** CT_SHOTS: a folder for the screens (Chromium only). Under Chrome's fold emulation, Chrome takes it itself. */
async function shot(page: Page, name: string, cdp?: CDPSession) {
  const dir = process.env.CT_SHOTS;
  if (!dir || test.info().project.name !== "chromium-390") return;
  if (cdp) writeFileSync(join(dir, name), Buffer.from(((await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string }).data, "base64"));
  else await page.screenshot({ path: join(dir, name), animations: "disabled" });
}

/** Half-folded: Chrome's device mode with a fold (vertical: like a book; horizontal: like a laptop) at `offset`. */
async function halfFold(page: Page, size: { width: number; height: number }, orientation: "vertical" | "horizontal", offset: number, maskLength = 0) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false, displayFeature: { orientation, offset, maskLength } });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));
  return cdp;
}

const box = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
});

test("unfolding and folding keep the chat at its newest message, with the message being typed and its cursor", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Unfold me");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("A half-typed message");
    await input.focus();
    await expect.poll(() => fromBottom(page)).toBeLessThan(2);
    await shot(page, "fold-1-folded.png");

    await resize(page, UNFOLDED);
    // The chats come in beside it, and nothing of the folded screen is left over.
    await expect(page.locator(".chat-sidebar:not(.drawer)")).toBeVisible();
    await expect(page.locator(".drawer-scrim")).toHaveCount(0);
    await expect.poll(() => fromBottom(page)).toBeLessThan(2);
    await expect(input).toHaveValue("A half-typed message");
    await expect(input).toBeFocused();
    expect(await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([20, 20]);
    await noHorizontalOverflow(page);
    await shot(page, "fold-2-unfolded.png");

    await resize(page, FOLDED);
    await expect(page.locator(".chat-sidebar")).toHaveCount(0);
    await expect.poll(() => fromBottom(page)).toBeLessThan(2);
    await expect(input).toHaveValue("A half-typed message");
    await noHorizontalOverflow(page);

    // Turned on its side unfolded, and back: still at the newest message.
    await resize(page, { width: 1104, height: 882 });
    await expect.poll(() => fromBottom(page)).toBeLessThan(2);
    await resize(page, FOLDED);
    await expect.poll(() => fromBottom(page)).toBeLessThan(2);
  } finally {
    await c.cleanup();
  }
});

test("reading further up, the same message stays at the top when it unfolds, folds and turns", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Keep my place");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    // Scrolled up by hand to message 11, a little below the top.
    await scrollTo(page, "Message 11:", 40);
    await page.waitForTimeout(150);
    const at = await topOf(page, "Message 11:");
    expect(Math.abs(at - 40)).toBeLessThan(6);
    for (const size of [UNFOLDED, FOLDED, { width: 1104, height: 882 }, FOLDED]) {
      await resize(page, size);
      await expect.poll(() => topOf(page, "Message 11:"), { message: `at ${size.width} × ${size.height}` }).toBeGreaterThan(at - 6);
      expect(await topOf(page, "Message 11:")).toBeLessThan(at + 6);
    }
    // Still reading, not pulled down to the newest message.
    expect(await fromBottom(page)).toBeGreaterThan(200);
  } finally {
    await c.cleanup();
  }
});

test("the chats drawer open when it unfolds becomes the sidebar, and folding again leaves the chat on screen", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Drawer then unfold");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    await page.getByRole("button", { name: "Show chats" }).click();
    await expect(page.locator(".chat-sidebar.drawer")).toBeVisible();
    await resize(page, UNFOLDED);
    await expect(page.locator(".drawer-scrim")).toHaveCount(0);
    await expect(page.locator(".chat-sidebar")).toHaveCount(1);
    await expect(page.locator(".chat-sidebar.drawer")).toHaveCount(0);
    await resize(page, FOLDED);
    await expect(page.locator(".chat-sidebar")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Drawer then unfold" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  } finally {
    await c.cleanup();
  }
});

test("half-folded like a book: the chats on the left half, the chat and its dialogs on the right, past the hinge", async ({ page, request, token, browserName }) => {
  test.skip(browserName !== "chromium", "Chrome's fold emulation");
  const c = await chat(page, request, token, "Book posture");
  try {
    await page.setViewportSize(UNFOLDED);
    await c.open();
    // Hidden by hand earlier: half-folded, the chats come back on their half (and can't be hidden there).
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".chat-sidebar")).toHaveCount(0);
    const cdp = await halfFold(page, UNFOLDED, "vertical", 441);
    await expect(page.locator(".chat-sidebar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide sidebar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Show chats/ })).toHaveCount(0);
    expect(await box(page, ".chat-sidebar")).toMatchObject({ left: 0, width: 441 });
    expect(await box(page, ".main")).toMatchObject({ left: 441, right: 882 });
    await expect.poll(() => fromBottom(page)).toBeLessThan(2);
    await shot(page, "fold-3-book.png", cdp);
    // A dialog opens on the chat's half, not across the fold.
    await page.getByRole("button", { name: "Chat settings" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
    const d = await box(page, '[role="dialog"]');
    expect(d.left).toBeGreaterThanOrEqual(441);
    expect(d.right).toBeLessThanOrEqual(882);
    await shot(page, "fold-4-book-dialog.png", cdp);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // A two-screen phone: the chat starts past the 34 px hinge.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1114, height: 720, deviceScaleFactor: 1, mobile: false, displayFeature: { orientation: "vertical", offset: 540, maskLength: 34 } });
    await expect.poll(() => box(page, ".main").then((b) => b.left)).toBe(574);
    expect(await box(page, ".chat-sidebar")).toMatchObject({ left: 0, width: 540 });

    // Opened flat again (the same size, no fold): the sidebar is hidden again, as it was left.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: UNFOLDED.width, height: UNFOLDED.height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([UNFOLDED.width, UNFOLDED.height]);
    await expect(page.locator(".chat-sidebar")).toHaveCount(0);
    await page.getByRole("button", { name: /^Show chats/ }).click();
    await expect(page.locator(".chat-sidebar")).toBeVisible();
  } finally {
    await c.cleanup();
  }
});

test("half-folded like a laptop: the messages above the fold, the message box just below it, until the keyboard is up", async ({ page, request, token, browserName }) => {
  test.skip(browserName !== "chromium", "Chrome's fold emulation");
  const c = await chat(page, request, token, "Tabletop posture");
  try {
    // A flip phone in flex mode: the fold across the middle of a tall, narrow screen.
    await page.setViewportSize({ width: 412, height: 1004 });
    await c.open();
    let cdp = await halfFold(page, { width: 412, height: 1004 }, "horizontal", 502);
    await expect.poll(() => box(page, ".composer-wrap").then((b) => b.top)).toBe(502);
    expect((await box(page, ".messages")).bottom).toBe(502);
    await expect.poll(() => fromBottom(page)).toBeLessThan(2);
    await noHorizontalOverflow(page);
    await shot(page, "fold-5-tabletop-flip.png", cdp);
    // The pickers open down into the lower half, and sheets stay in it.
    await page.getByRole("button", { name: /^Permissions:/ }).click();
    const picker = page.locator(".ctl-pop").first();
    await expect(picker).toBeVisible();
    expect((await box(page, ".ctl-pop")).top).toBeGreaterThanOrEqual(502);
    expect((await box(page, ".ctl-pop")).bottom).toBeLessThanOrEqual(1004);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Chat settings" }).click();
    await expect(page.getByRole("dialog", { name: /Chat settings/ })).toBeVisible();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
    expect((await box(page, '[role="dialog"]')).top).toBeGreaterThanOrEqual(502);
    await shot(page, "fold-5b-tabletop-sheet.png", cdp);
    await page.keyboard.press("Escape");
    // The keyboard up shrinks the page (as Android browsers do) and covers the lower half: the message box goes back
    // above it, as on any phone.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 640, deviceScaleFactor: 1, mobile: false, displayFeature: { orientation: "horizontal", offset: 502, maskLength: 0 } });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("fold-tabletop"))).toBe(false);
    await expect.poll(() => box(page, ".composer-wrap").then((b) => b.bottom)).toBe(640);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 1004, deviceScaleFactor: 1, mobile: false, displayFeature: { orientation: "horizontal", offset: 502, maskLength: 0 } });
    await expect.poll(() => box(page, ".composer-wrap").then((b) => b.top)).toBe(502);

    // The big screen turned sideways and half-folded.
    cdp = await halfFold(page, { width: 1104, height: 882 }, "horizontal", 441);
    await expect.poll(() => box(page, ".composer-wrap").then((b) => b.top)).toBe(441);
    await shot(page, "fold-6-tabletop-fold.png", cdp);
  } finally {
    await c.cleanup();
  }
});

test("every main screen fits a folded, unfolded and turned foldable", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Sizes");
  try {
    for (const size of [FOLDED, UNFOLDED, { width: 1104, height: 882 }, { width: 412, height: 1004 }]) {
      await page.setViewportSize(size);
      await c.open();
      await noHorizontalOverflow(page);
      await page.goto("/#/settings");
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await noHorizontalOverflow(page);
      await page.goto("/#/rooms");
      await noHorizontalOverflow(page);
    }
  } finally {
    await c.cleanup();
  }
});

test("reading inside a long reply, the same paragraph stays at the top when it unfolds and folds", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Long reply", 30, true);
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    await scrollTo(page, "Paragraph 40:", 30);
    await page.waitForTimeout(150);
    const at = await topOf(page, "Paragraph 40:");
    for (const size of [UNFOLDED, FOLDED]) {
      await resize(page, size);
      await expect.poll(() => topOf(page, "Paragraph 40:"), { message: `at ${size.width} × ${size.height}` }).toBeGreaterThan(at - 6);
      expect(await topOf(page, "Paragraph 40:")).toBeLessThan(at + 6);
    }
  } finally {
    await c.cleanup();
  }
});

test("reading inside a code block taller than the screen, the same line stays at the top when it unfolds and folds", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Long code", 30, "code");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    // The code block shows whole when asked (Show all), then line 60 is put a little below the top.
    await page.getByRole("button", { name: /^Show all \d+ lines/ }).first().click();
    await expect(page.locator('.codeblock-more[aria-expanded="true"]')).toHaveCount(1);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const lineTop = () => page.locator(".messages").evaluate((sc) => {
      const pre = sc.querySelector(".inner pre")!;
      const lines = (pre.textContent ?? "").split("\n");
      const i = lines.findIndex((l) => l.startsWith("line 60:"));
      const r = pre.getBoundingClientRect();
      return Math.round(r.top - sc.getBoundingClientRect().top + (i / lines.length) * r.height);
    });
    await page.locator(".messages").evaluate((sc) => {
      const pre = sc.querySelector(".inner pre")!;
      const lines = (pre.textContent ?? "").split("\n");
      const i = lines.findIndex((l) => l.startsWith("line 60:"));
      const r = pre.getBoundingClientRect();
      const view = sc.getBoundingClientRect();
      const scale = view.height / (sc as HTMLElement).offsetHeight;
      sc.scrollTop += (r.top - view.top + (i / lines.length) * r.height - 30) / scale;
    });
    await page.waitForTimeout(150);
    const at = await lineTop();
    for (const size of [UNFOLDED, FOLDED]) {
      await resize(page, size);
      await expect.poll(lineTop, { message: `at ${size.width} × ${size.height}` }).toBeGreaterThan(at - 12);
      expect(await lineTop()).toBeLessThan(at + 12);
    }
  } finally {
    await c.cleanup();
  }
});

test("at a larger text size the place is kept, and an unfolded screen laid out phone-wide shows one screen at a time", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Bigger text");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    await setZoom(page, 150);
    // 344 px fits 125% at most; unfolded, 150% lays the 882 px screen out 588 px wide: a phone's width.
    await resize(page, UNFOLDED);
    await expect(page.locator(".chat-sidebar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Show chats/ })).toBeVisible();
    await scrollTo(page, "Message 11:", 40);
    await page.waitForTimeout(150);
    const at = await topOf(page, "Message 11:");
    for (const size of [FOLDED, UNFOLDED]) {
      await resize(page, size);
      await expect.poll(() => topOf(page, "Message 11:"), { message: `at ${size.width} × ${size.height}` }).toBeGreaterThan(at - 6);
      expect(await topOf(page, "Message 11:")).toBeLessThan(at + 6);
    }
    // At 100% the unfolded screen has room for the chats beside the chat again.
    await setZoom(page, 100);
    await expect(page.locator(".chat-sidebar")).toBeVisible();
  } finally {
    await setZoom(page, 100);
    await c.cleanup();
  }
});

test("Jump to latest goes away when, unfolded, the whole chat fits", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Short chat", 10);
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    await page.locator(".messages").evaluate((sc) => (sc.scrollTop = 0));
    await expect(page.getByRole("button", { name: /^Jump to latest/ })).toBeVisible();
    await resize(page, UNFOLDED);
    await expect(page.getByRole("button", { name: /^Jump to latest/ })).toHaveCount(0);
  } finally {
    await c.cleanup();
  }
});

test("a New chat dialog opened from the chats drawer stays open, as filled in, when it unfolds and folds", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "New chat across folds");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    await page.getByRole("button", { name: /^Show chats/ }).click();
    await page.locator(".chat-sidebar.drawer .csb-new").click();
    await page.getByRole("menuitem", { name: /Claude Code/ }).click();
    const dialog = page.getByRole("dialog", { name: "New chat with Claude Code" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Folder path", exact: true }).fill("/Users/me/Projects/Fold");
    await resize(page, UNFOLDED);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Folder path", exact: true })).toHaveValue("/Users/me/Projects/Fold");
    // The chats it was opened from stay too, docked beside the chat.
    await expect(page.locator(".chat-sidebar")).toBeVisible();
    await resize(page, FOLDED);
    await expect(dialog.getByRole("textbox", { name: "Folder path", exact: true })).toHaveValue("/Users/me/Projects/Fold");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await c.cleanup();
  }
});

test("hidden earlier, the chats drawer open when it unfolds stays as the docked list", async ({ page, request, token }) => {
  await page.addInitScript(() => localStorage.setItem("crosstalk.sidebar.collapsed", "1"));
  const c = await chat(page, request, token, "Hidden list");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    await page.getByRole("button", { name: /^Show chats/ }).click();
    await resize(page, UNFOLDED);
    await expect(page.locator(".chat-sidebar:not(.drawer)")).toBeVisible();
    await expect(page.locator(".drawer-scrim")).toHaveCount(0);
  } finally {
    await c.cleanup();
  }
});

test("the message box fits its text again when the screen gets wider or narrower", async ({ page, request, token }) => {
  const c = await chat(page, request, token, "Box height");
  try {
    await page.setViewportSize(FOLDED);
    await c.open();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("A longer draft that wraps onto several lines on the folded screen, and onto fewer once it unfolds into a wide one.");
    const folded = (await input.boundingBox())!.height;
    await resize(page, UNFOLDED);
    await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThan(folded - 10);
    await resize(page, FOLDED);
    await expect.poll(async () => Math.round((await input.boundingBox())!.height)).toBe(Math.round(folded));
  } finally {
    await c.cleanup();
  }
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("unfolded, buttons stay finger-sized and Enter starts a new line instead of sending", async ({ page, request, token }) => {
    const c = await chat(page, request, token, "Touch unfolded");
    try {
      await page.setViewportSize(UNFOLDED);
      await c.open();
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const settings = await page.getByRole("button", { name: "Chat settings" }).boundingBox();
      expect(settings!.height).toBeGreaterThanOrEqual(44);
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await expect(input).toHaveAttribute("enterkeyhint", "enter");
      let sent = 0;
      await page.route(`**/api/rooms/${c.room.id}/messages`, (r) => { sent++; return r.fulfill({ json: {} }); });
      await input.click();
      await page.keyboard.type("first line");
      await page.keyboard.press("Enter");
      await page.keyboard.type("second line");
      await expect(input).toHaveValue("first line\nsecond line");
      expect(sent).toBe(0);
    } finally {
      await c.cleanup();
    }
  });
});
