import type { APIRequestContext, CDPSession, Page, WebSocketRoute } from "@playwright/test";
import type { Member, Message, Room } from "@crosstalk/shared";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// A foldable unfolding and folding under the app, on every screen and in every state it can be in when that happens:
// the app fills the new screen at once (nothing left at the old width or height, no blank half, nothing scrolled out
// of reach), the chats are in a drawer or docked as the new width says, nothing of a half-folded layout is left once
// the phone is flat, and none of it needs a reload. Sizes are the cover and inner screens of the phones people have
// (Galaxy Z Fold 344 × 882 → 768 × 906 or 690 × 829, a 360 × 780 cover → 884 × 1104, Pixel Fold 390 × 844 → 841 × 701).
// foldables.spec.ts has the reading place, the drawer turning into the docked list, and the half-folded layouts.

const hub = "http://127.0.0.1:8451";
type Size = { width: number; height: number };
const PAIRS: { cover: Size; inner: Size }[] = [
  { cover: { width: 344, height: 882 }, inner: { width: 768, height: 906 } },
  // Unfolded and still one screen at a time (760 px or less).
  { cover: { width: 344, height: 882 }, inner: { width: 690, height: 829 } },
  { cover: { width: 360, height: 780 }, inner: { width: 884, height: 1104 } },
  { cover: { width: 390, height: 844 }, inner: { width: 841, height: 701 } },
];
/** The two widths of the commonest foldable (docking the chats, and not), for the slower checks. */
const BOTH_WIDTHS = [PAIRS[0], PAIRS[1]];
/** A taller inner screen and a shorter, wider one. */
const BOTH_SHAPES = [PAIRS[0], PAIRS[3]];
/** The screens most in use: what a phone's browser and a real fold are checked on (a window is checked on them all). */
const MAIN_STATES = ["Home", "a chat with the message box in use", "the chats drawer", "Chat settings", "Settings"];

test.beforeEach(async ({ page }) => {
  test.skip(!["chromium-390", "webkit-390"].includes(test.info().project.name), "Sizes are set by the test itself.");
  // The two-part layouts for a half-folded phone are a device's own choice, off until made: this is a device that
  // made it (one test below takes it back to see the default).
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ct-test-fold-default")) localStorage.setItem("crosstalk.fold.parts.v1", "1");
  });
});

/** A real chat whose history the test writes (its agent never runs): `count` messages, the 14th a long reply. */
async function chat(page: Page, request: APIRequestContext, token: string, name: string, count = 30) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  delete member.readSeq;
  const messages: Message[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const kind = seq % 2 ? "human" : "agent";
    const text =
      seq === 14
        ? `A long reply.\n\n${Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: ${"words that wrap on a cover screen and not on the inner one ".repeat(2)}`).join("\n\n")}\n\n\`\`\`ts\nconst aVeryLongLineOfCode = someFunction(withManyArguments, thatGoOn, andOn, pastTheEdge, ofAnyCoverScreen, andMostInnerOnes);\n\`\`\`\n\n| Screen | Width | Height |\n| --- | --- | --- |\n| Cover | 344 | 882 |\n| Inner | 768 | 906 |`
        : `Message ${seq}: ${"words to fill the line ".repeat(1 + (seq % 5))}`;
    messages.push({ id: `unfold-${seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: 1_700_000_000_000 + seq * 1000, updatedAt: 1_700_000_000_000 + seq * 1000 } as Message);
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

/** The app has had its frames to follow a new size. */
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80)))));

/** The screen changes size, and the app has had its frames to follow. */
async function resize(page: Page, size: Size) {
  await page.setViewportSize(size);
  await frames(page);
}

/** A page of its own for the next phone: whatever the last one left open is gone. Once the page is quiet (a reload under requests still on their way reads, in WebKit, as so many failed ones). */
async function fresh(page: Page) {
  await page.goto("/#/");
  await page.waitForLoadState("networkidle");
  await page.reload();
}

const setZoom = (page: Page, percent: number) => page.evaluate(async (p) => (await import("/src/zoom.ts")).setZoom(p), percent);

/** CT_SHOTS: a folder for the screens (Chromium only). */
async function shot(page: Page, name: string) {
  const dir = process.env.CT_SHOTS;
  if (!dir || test.info().project.name !== "chromium-390") return;
  await page.screenshot({ path: join(dir, name), animations: "disabled" });
}

interface Want {
  /** The chats beside the screen (true), in a drawer or hidden (false). Not checked when left out. */
  docked?: boolean;
  /** Half-folded: which posture's layout is expected. None unless said. */
  posture?: "book" | "tabletop";
  /** The message box is on screen. */
  composer?: boolean;
}

/**
 * Everything wrong with how the app fits the screen right now, in words (none: it fits). `size` is what the screen was
 * just set to: the page must agree with it, by itself.
 */
async function wrong(page: Page, size: Size, want: Want = {}): Promise<string[]> {
  // Where sheets and menus end up, not where their opening animation has them.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  return page.evaluate(
    ([size, want]) => {
      const out: string[] = [];
      const root = document.documentElement;
      const vv = window.visualViewport;
      const W = size.width;
      const H = size.height;
      const near = (a: number, b: number, by = 1.5) => Math.abs(a - b) <= by;
      const box = (el: Element) => el.getBoundingClientRect();
      const name = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}"`;
      // The page knows the new size.
      if (innerWidth !== W || innerHeight !== H) out.push(`the window says ${innerWidth} × ${innerHeight}, the screen is ${W} × ${H}`);
      if (vv && (!near(vv.width * vv.scale, W) || !near(vv.height * vv.scale, H))) out.push(`the visible part says ${vv.width} × ${vv.height} at scale ${vv.scale}`);
      if (vv && !near(vv.scale, 1, 0.01)) out.push(`the page is scaled ${vv.scale}`);
      // Nothing wider than the screen, nothing scrolled out of reach.
      if (root.scrollWidth > W) out.push(`the page is ${root.scrollWidth}px wide on a ${W}px screen`);
      if (scrollX || scrollY) out.push(`the window is scrolled to ${scrollX}, ${scrollY}`);
      for (const el of [root, document.body, ...document.querySelectorAll("#root, .app, .shell, .main, .chat-sidebar, .overlay, .dialog, .topbar, .composer-wrap, .composer")]) {
        if (el.scrollLeft) out.push(`${name(el)} is scrolled sideways by ${el.scrollLeft}px`);
        if (el.scrollTop && !/auto|scroll/.test(getComputedStyle(el).overflowY)) out.push(`${name(el)} is scrolled down by ${el.scrollTop}px and can't be scrolled back`);
      }
      // The app fills the screen: its frame, and the chats with the screen across the whole width.
      const app = document.querySelector(".app");
      if (!app) return [...out, "no app on the page"];
      const a = box(app);
      if (!near(a.left, 0) || !near(a.top, 0) || !near(a.width, W) || !near(a.height, H)) out.push(`the app is at ${a.left}, ${a.top}, ${a.width} × ${a.height} on a ${W} × ${H} screen`);
      const zoom = Number(getComputedStyle(root).zoom) || 1;
      const sized = parseFloat(root.style.getPropertyValue("--app-height"));
      if (sized && !near(sized * zoom, H)) out.push(`--app-height is ${sized}px at zoom ${zoom} for a ${H}px screen`);
      const shell = document.querySelector(".shell");
      const main = document.querySelector(".shell > .main");
      const docked = document.querySelector(".chat-sidebar:not(.drawer):not([data-leaving])");
      if (shell && main) {
        const s = box(shell);
        const m = box(main);
        if (!near(s.left, 0) || !near(s.width, W) || !near(s.height, H)) out.push(`the frame is at ${s.left}, ${s.top}, ${s.width} × ${s.height}`);
        const d = docked ? box(docked) : null;
        // Docked: the chats then the screen, edge to edge. Alone: the screen, edge to edge too.
        if (d && want.posture !== "book" && (!near(d.left, 0) || !near(m.left, d.right) || !near(m.right, W))) out.push(`docked, the chats span ${d.left}–${d.right} and the screen ${m.left}–${m.right} of ${W}`);
        if (!d && (!near(m.left, 0, 3) || !near(m.right, W, 3))) out.push(`the screen spans ${m.left}–${m.right} of ${W}`);
        if (!near(m.top, 0) || !near(m.bottom, H)) out.push(`the screen spans ${m.top}–${m.bottom} down a ${H}px screen`);
      }
      // The chats: docked or not, as asked, and never a drawer's leftovers beside a docked list.
      if (want.docked !== undefined && !!docked !== want.docked) out.push(want.docked ? "the chats aren't docked beside the screen" : "the chats are docked beside the screen");
      if (docked && document.querySelector(".chat-sidebar.drawer, .drawer-scrim")) out.push("the chats are docked and the drawer is still there");
      if (app.classList.contains("docked") !== !!docked) out.push(`the app says ${app.classList.contains("docked") ? "docked" : "not docked"} and the chats ${docked ? "are" : "aren't"} beside the screen`);
      const drawer = document.querySelector(".chat-sidebar.drawer:not([data-leaving])");
      if (drawer) {
        const r = box(drawer);
        if (!near(r.left, 0) || !near(r.top, 0) || !near(r.height, H) || r.right > W) out.push(`the chats drawer is at ${r.left}, ${r.top}, ${r.width} × ${r.height}`);
        if (!document.querySelector(".drawer-scrim")) out.push("the chats drawer has no dim behind it");
      }
      // Nothing of a half-folded layout unless the phone is half-folded.
      const posture = root.classList.contains("fold-book") ? "book" : root.classList.contains("fold-tabletop") ? "tabletop" : undefined;
      if (posture !== want.posture) out.push(`laid out for ${posture ?? "a flat screen"}, expected ${want.posture ?? "a flat screen"}`);
      if (!want.posture) for (const v of ["--seg-l-w", "--seg-r-x", "--seg-r-w", "--seg-t-h", "--seg-b-y", "--seg-b-h"]) if (root.style.getPropertyValue(v)) out.push(`${v} is still ${root.style.getPropertyValue(v)}`);
      // No keyboard is up in these checks unless the test put one up (it says so by the size it gives).
      // The header and the message box are on screen.
      const top = document.querySelector(".shell > .main .topbar");
      if (top) {
        const t = box(top);
        if (t.top < -1 || t.bottom > H || t.left < -1 || t.right > W + 1) out.push(`the header spans ${t.left}–${t.right} across, ${t.top}–${t.bottom} down`);
      }
      const input = document.querySelector('.shell > .main textarea[aria-label="Message"]');
      if (want.composer && !input) out.push("no message box");
      if (input) {
        const r = box(input);
        if (r.top < 0 || r.bottom > H + 1 || r.left < 0 || r.right > W + 1 || r.width < 120) out.push(`the message box spans ${r.left}–${r.right} across, ${r.top}–${r.bottom} down a ${W} × ${H} screen`);
      }
      // Sheets and dialogs cover the screen and stay inside it.
      for (const el of document.querySelectorAll(".overlay")) {
        const r = box(el);
        if (!near(r.left, 0) || !near(r.top, 0) || !near(r.width, W) || !near(r.height, H)) out.push(`a sheet's backdrop is at ${r.left}, ${r.top}, ${r.width} × ${r.height}`);
      }
      // Every control showing is fully on the screen, not cut off by its edge or by the page around it.
      for (const el of document.querySelectorAll("button, input, textarea, select, [role=dialog], .ctl-pop, .toast")) {
        const r = box(el);
        if (!r.width || !r.height || el.closest(".msg-actions, pre, .composer-files, [data-leaving], .md-table, table")) continue;
        if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) continue;
        const row = el.closest(".settings-tabs-row");
        if (row && row.scrollWidth > row.clientWidth + 1) continue;
        if (r.left < -1 || r.right > W + 1) out.push(`${name(el)} spans ${Math.round(r.left)} to ${Math.round(r.right)} on a ${W}px screen`);
        if (el.matches("[role=dialog], .ctl-pop") && (r.top < -1 || r.bottom > H + 1)) out.push(`${name(el)} spans ${Math.round(r.top)} to ${Math.round(r.bottom)} down a ${H}px screen`);
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== "hidden") continue;
          const c = box(p);
          if (r.right > c.right + 1.5 || r.left < c.left - 1.5) out.push(`${name(el)} is cut off by .${p.className}`);
          break;
        }
      }
      return out;
    },
    [size, want] as const,
  );
}

/** Collects what's wrong at each step of a test, so one run says everything that broke and where. */
function checker(page: Page) {
  const found: string[] = [];
  return {
    async at(step: string, size: Size, want: Want = {}) {
      for (const w of await wrong(page, size, want)) found.push(`${step} (${size.width} × ${size.height}): ${w}`);
    },
    /** Something else that's wrong (nothing, when `problem` is null). */
    note(problem: string | null) {
      if (problem) found.push(problem);
    },
    done() {
      expect(found).toEqual([]);
    },
  };
}

/** Whether the chats dock beside the screen at this width and text size (760 px of layout or less: one screen at a time). */
const docks = (size: Size, zoom = 100) => size.width > Math.round((760 * zoom) / 100);

/** The text size in use on a screen when `percent` is chosen: the largest that still lays the page out 250 px wide. */
const fits = (percent: number, size: Size) => Math.min(percent, Math.max(100, ...[80, 90, 100, 110, 125, 150].filter((s) => (size.width * 100) / s >= 250)));

/** Each kind of screen there is to unfold on, with how to get to it. */
type State = { name: string; go: (page: Page, c: Awaited<ReturnType<typeof chat>>) => Promise<void>; composer?: boolean; drawer?: boolean };
const STATES: State[] = [
  { name: "Home", go: async (page) => { await page.goto("/#/"); await expect(page.locator(".topbar").first()).toBeVisible(); } },
  { name: "a chat", composer: true, go: async (_page, c) => c.open() },
  {
    name: "a chat, reading further up",
    composer: true,
    go: async (page, c) => {
      await c.open();
      await page.locator(".messages").evaluate((sc) => (sc.scrollTop = sc.scrollHeight / 3));
    },
  },
  {
    name: "a chat with the message box in use",
    composer: true,
    go: async (page, c) => {
      await c.open();
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("A draft that is long enough to wrap onto a few lines on the cover screen, and onto one on the inner screen.");
      await input.focus();
    },
  },
  {
    name: "the chats drawer",
    composer: true,
    drawer: true,
    go: async (page, c) => {
      await c.open();
      await page.getByRole("button", { name: /^Show chats/ }).click();
      await expect(page.locator(".chat-sidebar.drawer")).toBeVisible();
    },
  },
  {
    name: "Chat settings",
    composer: true,
    go: async (page, c) => {
      await c.open();
      await page.getByRole("button", { name: "Chat settings" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  { name: "Settings", go: async (page) => { await page.goto("/#/settings"); await expect(page.locator("#settings-panel")).toBeVisible(); } },
  { name: "Settings → This device", go: async (page) => { await page.goto("/#/settings/display"); await expect(page.locator("#settings-panel")).toBeVisible(); } },
  { name: "Settings → Accounts", go: async (page) => { await page.goto("/#/settings/accounts"); await expect(page.locator("#settings-panel")).toBeVisible(); } },
  { name: "Bookmarks", go: async (page) => { await page.goto("/#/bookmarks"); await expect(page.locator(".topbar").first()).toBeVisible(); } },
  { name: "Screen", go: async (page) => { await page.goto("/#/screen"); await expect(page.locator(".topbar").first()).toBeVisible(); } },
  { name: "Terminal", go: async (page) => { await page.goto("/#/terminal"); await expect(page.locator(".topbar").first()).toBeVisible(); } },
];

for (const touch of [false, true]) {
  test.describe(touch ? "a phone's browser (touch, the page's own viewport)" : "a window", () => {
    // A phone's browser lays the page out by its viewport tag and can scale it; a desktop window does neither.
    if (touch) test.use({ hasTouch: true, isMobile: true });

    for (const state of touch ? STATES.filter((s) => MAIN_STATES.includes(s.name)) : STATES) {
      test(`${state.name}: unfolding and folding fills the screen each time`, async ({ page, request, token, browserName }) => {
        test.skip(touch && browserName !== "chromium", "The phone viewport is Chromium's");
        test.setTimeout(90_000);
        const c = await chat(page, request, token, `Unfold ${state.name}`.slice(0, 40));
        const check = checker(page);
        try {
          for (const { cover, inner } of PAIRS) {
            const tag = `${state.name}, ${cover.width} → ${inner.width}`;
            // Each phone starts on a page of its own (whatever the last one left open is gone).
            await page.setViewportSize(cover);
            await fresh(page);
            await state.go(page, c);
            await frames(page);
            await check.at(`${tag}: folded`, cover, { docked: false, composer: state.composer });
            await resize(page, inner);
            await check.at(`${tag}: unfolded`, inner, { docked: docks(inner), composer: state.composer });
            if (cover.width === 344) await shot(page, `unfold-${state.name.replace(/[^a-z]+/gi, "-").toLowerCase()}-${touch ? "phone" : "window"}.png`);
            await resize(page, cover);
            await check.at(`${tag}: folded again`, cover, { docked: false, composer: state.composer });
            // Unfolded once more, the width and the height arriving one after the other, with no frame between.
            await page.setViewportSize({ width: inner.width, height: cover.height });
            await page.setViewportSize(inner);
            await frames(page);
            await check.at(`${tag}: unfolded in two steps`, inner, { docked: docks(inner), composer: state.composer });
            // Turned on its side, unfolded, and back.
            const turned = { width: inner.height, height: inner.width };
            await resize(page, turned);
            await check.at(`${tag}: turned`, turned, { docked: docks(turned), composer: state.composer });
            await resize(page, inner);
            await check.at(`${tag}: turned back`, inner, { docked: docks(inner), composer: state.composer });
          }
          check.done();
        } finally {
          await c.cleanup();
        }
      });
    }

    test("with the keyboard up: unfolding keeps the message box above it, and nothing is left sized for the keyboard once it's down", async ({ page, request, token, browserName }) => {
      test.skip(touch && browserName !== "chromium", "The phone viewport is Chromium's");
      test.setTimeout(90_000);
      const c = await chat(page, request, token, "Unfold with keyboard");
      const check = checker(page);
      const keyboardOpen = () => page.evaluate(() => document.documentElement.classList.contains("keyboard-open"));
      try {
        for (const { cover, inner } of BOTH_SHAPES) {
          const tag = `keyboard, ${cover.width} → ${inner.width}`;
          await page.setViewportSize(cover);
          await c.open();
          const input = page.getByRole("textbox", { name: "Message", exact: true });
          await input.focus();
          // The keyboard comes up as on Android: the page itself gets shorter.
          const typing = { width: cover.width, height: cover.height - 330 };
          await resize(page, typing);
          await check.at(`${tag}: typing folded`, typing, { docked: false, composer: true });
          if (touch) expect(await keyboardOpen(), "the keyboard is told on a touch screen").toBe(true);
          // Unfolded with the keyboard still up.
          const typingInner = { width: inner.width, height: inner.height - 330 };
          await resize(page, typingInner);
          await check.at(`${tag}: typing unfolded`, typingInner, { docked: docks(inner), composer: true });
          await expect(input).toBeFocused();
          // The keyboard goes down.
          await resize(page, inner);
          await check.at(`${tag}: keyboard down, unfolded`, inner, { docked: docks(inner), composer: true });
          expect(await keyboardOpen(), "no keyboard is up").toBe(false);
          // Folded with the field still focused: the keyboard comes back on the cover screen, then goes.
          await resize(page, typing);
          await check.at(`${tag}: typing folded again`, typing, { docked: false, composer: true });
          await resize(page, cover);
          await check.at(`${tag}: keyboard down, folded`, cover, { docked: false, composer: true });
          // Typing folded, and unfolding closes the keyboard in the same move.
          await resize(page, typing);
          await resize(page, inner);
          await check.at(`${tag}: unfolded, the keyboard closing with it`, inner, { docked: docks(inner), composer: true });
          expect(await keyboardOpen(), "no keyboard is up after unfolding").toBe(false);
        }
        check.done();
      } finally {
        await c.cleanup();
      }
    });

    test("at a larger and a smaller text size: unfolding and folding fills the screen, and the size follows what fits", async ({ page, request, token, browserName }) => {
      test.skip(touch && browserName !== "chromium", "The phone viewport is Chromium's");
      test.setTimeout(120_000);
      const c = await chat(page, request, token, "Unfold with text size");
      const check = checker(page);
      try {
        for (const percent of [150, 125, 80]) {
          for (const { cover, inner } of BOTH_SHAPES) {
            const tag = `${percent}%, ${cover.width} → ${inner.width}`;
            await page.setViewportSize(cover);
            await c.open();
            await setZoom(page, percent);
            await frames(page);
            // What fits each screen: a narrow cover screen takes 125% at most.
            const fitting = (size: Size) => fits(percent, size);
            await check.at(`${tag}: folded`, cover, { docked: docks(cover, fitting(cover)), composer: true });
            await resize(page, inner);
            await check.at(`${tag}: unfolded`, inner, { docked: docks(inner, fitting(inner)), composer: true });
            expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom)), `${tag}: the size in use unfolded`).toBe(fitting(inner) / 100);
            await page.getByRole("button", { name: "Chat settings" }).click();
            await expect(page.getByRole("dialog")).toBeVisible();
            await check.at(`${tag}: unfolded, Chat settings`, inner, { docked: docks(inner, fitting(inner)), composer: true });
            await resize(page, cover);
            await check.at(`${tag}: folded, Chat settings`, cover, { docked: docks(cover, fitting(cover)), composer: true });
            expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom)), `${tag}: the size in use folded`).toBe(fitting(cover) / 100);
            await page.keyboard.press("Escape");
            await resize(page, inner);
            await check.at(`${tag}: unfolded again`, inner, { docked: docks(inner, fitting(inner)), composer: true });
          }
        }
        check.done();
      } finally {
        await setZoom(page, 100);
        await c.cleanup();
      }
    });
  });
}

/** Chrome's emulation of a fold (the device mode's display feature and posture), at `size`. */
async function fold(cdp: CDPSession, page: Page, size: Size, mobile: boolean, feature?: { orientation: "vertical" | "horizontal"; offset: number; maskLength?: number }, settle = true) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile, ...(feature ? { displayFeature: { maskLength: 0, ...feature } } : {}) });
  await cdp.send("Emulation.setDevicePostureOverride", { posture: { type: feature ? "folded" : "continuous" } }).catch(() => {});
  if (settle) await frames(page);
}
const book = (size: Size) => ({ orientation: "vertical" as const, offset: Math.round(size.width / 2) });
const laptop = (size: Size) => ({ orientation: "horizontal" as const, offset: Math.round(size.height / 2) });

/** The half-folded layout the page is in now, if any. */
const laidOutFor = (page: Page) => page.evaluate(() => (document.documentElement.classList.contains("fold-book") ? "book" : document.documentElement.classList.contains("fold-tabletop") ? "tabletop" : "flat"));

/** Under Chrome's fold emulation, Chrome takes the picture itself. */
async function foldShot(cdp: CDPSession, name: string) {
  const dir = process.env.CT_SHOTS;
  if (!dir || test.info().project.name !== "chromium-390") return;
  writeFileSync(join(dir, name), Buffer.from(((await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string }).data, "base64"));
}

for (const touch of [false, true]) {
  test.describe(touch ? "a real fold, on a phone's browser" : "a real fold", () => {
    if (touch) test.use({ hasTouch: true, isMobile: true });
    test.beforeEach(({ browserName }) => {
      test.skip(browserName !== "chromium", "Chrome's fold emulation");
    });

    // What a foldable does every time it's opened: the browser reports the fold as half-open for the swing (Chrome on
    // Android: two viewport segments while the hinge is between closed and flat), then flat. Laid out in halves for
    // that moment, the app shows the chat on half the screen (or the messages on the top half over an empty lower
    // half) just as it unfolds.
    test("opening and closing pass through half-open: the screen is never laid out in halves on the way", async ({ page, request, token }) => {
      test.setTimeout(150_000);
      const c = await chat(page, request, token, "Swung open");
      const check = checker(page);
      const cdp = await page.context().newCDPSession(page);
      try {
        for (const { cover, inner } of BOTH_WIDTHS) {
          for (const state of STATES.filter((s) => MAIN_STATES.includes(s.name))) {
            const tag = `${state.name}, ${cover.width} → ${inner.width}`;
            await fold(cdp, page, cover, touch);
            await fresh(page);
            await state.go(page, c);
            await frames(page);
            await check.at(`${tag}: folded`, cover, { docked: false, composer: state.composer });
            // Opening: the inner screen comes on with the fold still half-open.
            await fold(cdp, page, inner, touch, book(inner));
            await check.at(`${tag}: half-open on the way`, inner, { docked: docks(inner), composer: state.composer });
            if (state.name === "a chat with the message box in use") await foldShot(cdp, `swing-book-${inner.width}-${touch ? "phone" : "window"}.png`);
            await fold(cdp, page, inner, touch);
            await check.at(`${tag}: flat`, inner, { docked: docks(inner), composer: state.composer });
            // Closing: half-open again on the way to the cover screen.
            await fold(cdp, page, inner, touch, book(inner));
            await check.at(`${tag}: half-open on the way back`, inner, { docked: docks(inner), composer: state.composer });
            await fold(cdp, page, cover, touch);
            await check.at(`${tag}: folded again`, cover, { docked: false, composer: state.composer });
            // Swung open in one go: half-open and flat with no frame between them.
            await fold(cdp, page, inner, touch, book(inner), false);
            await fold(cdp, page, inner, touch);
            await check.at(`${tag}: swung open in one go`, inner, { docked: docks(inner), composer: state.composer });
          }
        }
        // A flip phone opening: its tall screen, the fold across the middle on the way.
        const flip = { width: 412, height: 1004 };
        await fold(cdp, page, flip, touch);
        await fresh(page);
        await c.open();
        await fold(cdp, page, flip, touch, laptop(flip));
        await check.at("a flip phone, half-open on the way", flip, { docked: false, composer: true });
        // The message box stays at the foot of the screen, the messages down to it: no empty lower half.
        const input = (await page.getByRole("textbox", { name: "Message", exact: true }).boundingBox())!;
        check.note(input.y > flip.height * 0.75 ? null : `a flip phone, half-open on the way: the message box is at ${Math.round(input.y)} down a ${flip.height}px screen, with nothing under it`);
        await foldShot(cdp, `swing-flip-${touch ? "phone" : "window"}.png`);
        await fold(cdp, page, flip, touch);
        await check.at("a flip phone, flat", flip, { docked: false, composer: true });
        check.done();
      } finally {
        await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
        await c.cleanup();
      }
    });

    test("held half-folded, the app is laid out in its parts after a moment; flat again, nothing of that is left, at once", async ({ page, request, token }) => {
      test.setTimeout(150_000);
      const c = await chat(page, request, token, "A real fold");
      const check = checker(page);
      const cdp = await page.context().newCDPSession(page);
      try {
        for (const { cover, inner } of BOTH_WIDTHS) {
          for (const state of STATES.filter((s) => ["a chat with the message box in use", "the chats drawer", "Chat settings"].includes(s.name))) {
            const tag = `${state.name}, ${cover.width} → ${inner.width}`;
            await fold(cdp, page, cover, touch);
            await fresh(page);
            await state.go(page, c);
            await frames(page);
            // Opened half-way and left like that, like a book: the chats on the left part, the screen on the right.
            await fold(cdp, page, inner, touch, book(inner));
            await expect.poll(() => laidOutFor(page), { message: `${tag}: like a book` }).toBe("book");
            await check.at(`${tag}: half-folded like a book`, inner, { docked: true, posture: "book", composer: state.composer });
            await fold(cdp, page, inner, touch);
            await check.at(`${tag}: flat`, inner, { docked: docks(inner), composer: state.composer });
            // Bent the other way (the screen turned): one part above the other, then flat again.
            await fold(cdp, page, inner, touch, laptop(inner));
            await expect.poll(() => laidOutFor(page), { message: `${tag}: like a laptop` }).toBe("tabletop");
            await check.at(`${tag}: half-folded like a laptop`, inner, { docked: docks(inner), posture: "tabletop", composer: state.composer });
            await fold(cdp, page, inner, touch);
            await check.at(`${tag}: flat again`, inner, { docked: docks(inner), composer: state.composer });
            // Half-folded, then closed: the cover screen has nothing of the inner one's parts.
            await fold(cdp, page, inner, touch, book(inner));
            await expect.poll(() => laidOutFor(page), { message: `${tag}: like a book again` }).toBe("book");
            await fold(cdp, page, cover, touch);
            await check.at(`${tag}: folded again`, cover, { docked: false, composer: state.composer });
          }
        }
        check.done();
      } finally {
        await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
        await c.cleanup();
      }
    });
  });
}

// A size the page is told of in one way only. Browsers on foldables don't all say everything: the app must follow the
// window's own resize when the visible part stays silent, and the other way round.
for (const silent of ["the visible part", "the window"] as const) {
  test(`unfolding when ${silent} says nothing of its new size: the app fills the screen all the same`, async ({ page, request, token }) => {
    await page.addInitScript((silent) => {
      const target: EventTarget = silent === "the window" ? window : window.visualViewport!;
      const add = target.addEventListener.bind(target);
      target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (type !== "resize") add(type, fn, options);
      };
    }, silent);
    const c = await chat(page, request, token, "Half-told sizes");
    const check = checker(page);
    try {
      for (const { cover, inner } of BOTH_SHAPES) {
        await page.setViewportSize(cover);
        await fresh(page);
        await c.open();
        await setZoom(page, 150);
        await frames(page);
        await resize(page, inner);
        // A size told late is followed within the second.
        await page.waitForTimeout(700);
        await check.at(`${silent} silent, ${cover.width} → ${inner.width}: unfolded`, inner, { composer: true });
        expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom)), "the text size the inner screen fits").toBe(fits(150, inner) / 100);
        await resize(page, cover);
        await page.waitForTimeout(700);
        await check.at(`${silent} silent, ${cover.width} → ${inner.width}: folded`, cover, { composer: true });
        expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom)), "the text size the cover screen fits").toBe(fits(150, cover) / 100);
      }
      check.done();
    } finally {
      await setZoom(page, 100);
      await c.cleanup();
    }
  });
}

test("a phone held half-open keeps the whole screen as one, unless that device chose the two-part layout in Settings", async ({ page, request, token }) => {
  test.skip(test.info().project.name !== "chromium-390", "Chrome's fold emulation");
  // A device that never made the choice (the file's set-up makes it for the other tests).
  await page.addInitScript(() => {
    sessionStorage.setItem("ct-test-fold-default", "1");
    if (!sessionStorage.getItem("ct-test-fold-cleared")) {
      localStorage.removeItem("crosstalk.fold.parts.v1");
      sessionStorage.setItem("ct-test-fold-cleared", "1");
    }
  });
  const c = await chat(page, request, token, "Held half-open");
  const cdp = await page.context().newCDPSession(page);
  const inner = { width: 768, height: 906 };
  await fold(cdp, page, inner, false, book(inner));
  await c.open();
  // Held there well past the moment an unfolding phone passes through it.
  await page.waitForTimeout(1800);
  expect(await laidOutFor(page)).not.toBe("book");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The chat is where it would be unfolded flat, not on the right half of the screen.
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const held = (await input.boundingBox())!;
  await fold(cdp, page, inner, false);
  await page.waitForTimeout(300);
  const flat = (await input.boundingBox())!;
  expect([Math.round(held.x), Math.round(held.width)]).toEqual([Math.round(flat.x), Math.round(flat.width)]);
  await fold(cdp, page, inner, false, book(inner));

  // The device has a fold, so Settings offers the choice; taking it lays the screen out in two parts at once.
  await page.goto("/#/settings/display");
  const choice = page.getByRole("checkbox", { name: "Use both halves when half-folded", exact: true });
  await expect(choice).not.toBeChecked();
  await choice.click();
  await expect(choice).toBeChecked();
  await expect.poll(() => laidOutFor(page)).toBe("book");
  await choice.click();
  await expect.poll(() => laidOutFor(page)).not.toBe("book");
});
