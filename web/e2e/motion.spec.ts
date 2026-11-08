import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Member, Message, Room } from "@crosstalk/shared";
import { test, expect } from "./fixtures";

/*
 * Motion (web/src/styles/motion.css, web/src/motion.ts), on a phone (390 px), in each engine:
 * - nothing waits for an animation: what's still coming in takes a tap where it is, and what closes is gone from the
 *   page (its role, its focus) the moment it closes, while an inert copy plays its way out;
 * - that copy is hidden from screen readers, out of every selector's reach, and taps go through it to the page;
 * - only transform and opacity (and colour) ever animate, never a layout property;
 * - Reduce Motion leaves a fade of 150 ms or less, or nothing: no movement, no copies.
 * The rest of the suite runs with Reduce Motion (playwright.config.ts); CROSSTALK_E2E_MOTION=1 runs it with motion on.
 */

const HUB = "http://127.0.0.1:8451";
/** Properties that lay the page out again: never animated. */
const LAYOUT = /^(width|height|(min|max)-(width|height)|top|right|bottom|left|inset(-.+)?|margin(-.+)?|padding(-.+)?|border(-(top|right|bottom|left))?-width|font-size|line-height|(row-|column-)?gap|flex(-.+)?|grid(-.+)?|display|position|zoom)$/;
const MOVES = new Set(["transform", "translate", "scale", "rotate"]);
/** Fades and colour: allowed under either setting (colour on small controls, briefly). */
const PAINT = /^(opacity|color|background-color|box-shadow|border(-(top|right|bottom|left))?-color|outline-color)$/;

test.beforeEach(({}, info) => test.skip(!info.project.name.endsWith("-390"), "Once per engine, on a phone (390 px)."));

async function chat(request: APIRequestContext, token: string, name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name } })).json();
  return { room, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** A chat whose history and live messages the test writes (its agent never runs), long enough to scroll. */
async function longChat(page: Page, request: APIRequestContext, token: string, name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name } })).json();
  const snapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  delete member.readSeq;
  let seq = 0;
  const message = (kind: "human" | "agent", text: string): Message =>
    ({ id: `mo-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: 1_700_000_000_000 + seq * 1000, updatedAt: 1_700_000_000_000 + seq * 1000 }) as Message;
  const messages: Message[] = [];
  for (let i = 1; i <= 24; i++) messages.push(message("human", `Question ${i}`), message("agent", `Answer ${i}\n\nWith a second paragraph, so the chat is long.`));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, readSeq: seq } : m)) } }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: { room, messages, turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } }));
  return { room, send: (m: Message) => socket!.send(JSON.stringify({ t: "message", message: m })), message, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** Everything that animates from now on (exit copies included), as each frame goes by. */
async function watch(page: Page) {
  await page.evaluate(async () => {
    const { ghosts } = await import("/src/motion.ts");
    type Seen = { what: string; props: string[]; ms: number; repeats: boolean };
    const out = { animations: [] as Seen[], copies: 0 };
    (window as unknown as { __motion: typeof out }).__motion = out;
    const known = new WeakSet<Animation>();
    const name = (el: Element | null) => (el ? `${el.localName}${typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}` : "?");
    const look = (a: Animation) => {
      if (known.has(a)) return;
      known.add(a);
      const effect = a.effect as KeyframeEffect | null;
      const props =
        "transitionProperty" in a
          ? [String((a as CSSTransition).transitionProperty)]
          : [...new Set((effect?.getKeyframes() ?? []).flatMap((k) => Object.keys(k)).filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p)))].map((p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      const timing = effect?.getComputedTiming();
      const label = "animationName" in a ? (a as CSSAnimation).animationName : "transitionProperty" in a ? "transition" : "script";
      out.animations.push({ what: `${name(effect?.target ?? null)}${effect?.pseudoElement ?? ""} ${label}`, props, ms: Number(timing?.duration) || 0, repeats: timing?.iterations === Infinity });
    };
    const frame = () => {
      for (const a of document.getAnimations()) look(a);
      for (const copy of ghosts()) for (const a of copy.getAnimations({ subtree: true })) look(a);
      out.copies = Math.max(out.copies, document.querySelectorAll("[data-ghost]").length);
      requestAnimationFrame(frame);
    };
    frame();
  });
}
const watched = (page: Page) => page.evaluate(() => (window as unknown as { __motion: { animations: { what: string; props: string[]; ms: number; repeats: boolean }[]; copies: number } }).__motion);

/**
 * Slows the comings and goings right down (their tokens), so a test can act while they're still moving: what slides in
 * from off the screen gets on it in a second or two, and then hardly moves while a tap goes in.
 */
const slowDown = (page: Page) =>
  page.addStyleTag({
    content: ":root { --dur-sheet-in: 60s; --dur-sheet-out: 60s; --dur-drawer-in: 60s; --dur-drawer-out: 60s; --dur-scrim: 60s; --dur-toast-in: 6s; --dur-toast-out: 60s; --dur-badge: 60s; --dur-menu-out: 60s; }",
  });

/** Whether `selector`'s element is drawn at its own size right now (nothing scales it while it comes in). */
const fullSize = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    return Math.abs(r.height / zoom - (el as HTMLElement).offsetHeight) < 0.5 && Math.abs(r.width / zoom - (el as HTMLElement).offsetWidth) < 0.5;
  });

/** The exit copies played to their end at once: they go by themselves. */
const endExits = (page: Page) =>
  page.evaluate(async () => {
    const { ghosts } = await import("/src/motion.ts");
    for (const copy of ghosts()) for (const a of copy.getAnimations({ subtree: true })) a.finish();
  });

/**
 * Where `button` is while `moving` (the thing it's on) is still coming in, and whether a tap there lands on it. Waits
 * until it's on the screen, not until it stops.
 */
async function midEntrance(page: Page, moving: string, button: string) {
  const spot = await page.waitForFunction(
    ({ moving, button }) => {
      const box = document.querySelector(moving);
      const target = box?.querySelector(button);
      if (!box || !target || !box.getAnimations().some((a) => a.playState === "running")) return null;
      const r = target.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (y < 4 || y > innerHeight - 4 || x < 4 || x > innerWidth - 4) return null;
      return { x, y, hit: document.elementFromPoint(x, y)?.closest(button) === target };
    },
    { moving, button },
  );
  return (await spot.jsonValue()) as { x: number; y: number; hit: boolean };
}

/** The copy an exit left: inert, hidden from screen readers, no box or role of its own, and closed to selectors. */
const copyOf = (page: Page, kind: string) =>
  page.locator(`[data-ghost="${kind}"]`).evaluate((host) => ({
    inert: (host as HTMLElement).inert,
    hidden: host.getAttribute("aria-hidden"),
    role: host.getAttribute("role"),
    taps: getComputedStyle(host).pointerEvents,
    box: getComputedStyle(host).display,
    open: host.shadowRoot === null ? "closed" : "open",
  }));
const AS_A_COPY = { inert: true, hidden: "true", role: null, taps: "none", box: "contents", open: "closed" };
/** What has the focus: its role (or tag) and its label. */
const focused = (page: Page) => page.evaluate(() => `${document.activeElement?.getAttribute("role") ?? document.activeElement?.localName}: ${document.activeElement?.getAttribute("aria-label")}`);

test.describe("with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("a sheet takes taps while it's still coming up; closed, it's gone at once and an inert copy no one can find slides away", async ({ page, request, token }) => {
    const c = await chat(request, token, "Motion: a sheet");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      const opener = page.getByRole("button", { name: "Chat settings", exact: true });
      await expect(opener).toBeVisible();
      await slowDown(page);
      await watch(page);
      await opener.focus();
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog", { name: "Chat settings", exact: true });
      await expect(sheet).toBeVisible();
      // The focus moved into it at once, while it slides.
      await expect.poll(() => focused(page), { timeout: 1000 }).toBe("dialog: Chat settings");
      // Still coming up (its entrance takes a minute here), and its Close button is where a tap lands.
      const close = await midEntrance(page, '[role="dialog"]', '[aria-label="Close"]');
      expect(close.hit, "a tap on the Close button while the sheet comes up lands on it").toBe(true);
      await page.mouse.click(close.x, close.y);

      // Closed: gone from the page at once, while its copy is still on its way out.
      await expect(page.locator('[data-ghost="sheet"]')).toHaveCount(1);
      expect(await page.getByRole("dialog").count()).toBe(0);
      await expect.poll(() => focused(page), { timeout: 1000 }).toBe("button: Chat settings");
      // The copy is inert and hidden from screen readers; its words can't be found by text, label or role.
      expect(await copyOf(page, "sheet")).toEqual(AS_A_COPY);
      await expect(page.getByText("Other chats' agents can reach this chat")).toHaveCount(0);
      await expect(page.getByLabel("Other chats' agents can reach this chat")).toHaveCount(0);
      expect(await page.locator("body").ariaSnapshot()).not.toContain("Other chats");
      // A tap under the leaving copy reaches the page: the message box, under where the sheet was.
      const box = page.getByRole("textbox", { name: "Message", exact: true });
      const b = (await box.boundingBox())!;
      const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), at)).toBe("Message");
      await page.mouse.click(at.x, at.y);
      await expect(box).toBeFocused();
      // It opens again while the last one's copy is still leaving: the new one is the only dialog.
      await opener.click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // The copies go by themselves when their exits end, and nothing's left behind.
      await endExits(page);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);

      const seen = await watched(page);
      expect(seen.copies).toBeGreaterThan(0);
      expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p))), "nothing animates a layout property").toEqual([]);
      expect(seen.animations.some((a) => a.what.startsWith("div.dialog") && a.what.endsWith("m-sheet-in")), "the sheet came up").toBe(true);
      expect(seen.animations.some((a) => a.what.includes("dialog") && a.what.endsWith("m-sheet-out")), "its copy slid away").toBe(true);
      // The page behind never moves: every target on it keeps its size and place while a sheet comes and goes.
      expect(seen.animations.filter((a) => a.what.startsWith("div.shell") || a.what.startsWith("div.main")), "the page behind stays put").toEqual([]);
    } finally {
      await c.cleanup();
    }
  });

  test("a press shrinks a button a touch and springs back, a switch's thumb slides, and a sheet's next step fades in", async ({ page, request, token }) => {
    const c = await chat(request, token, "Motion: press");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await watch(page);
      await page.getByRole("button", { name: "Chat settings", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Chat settings", exact: true });
      const cancel = sheet.getByRole("button", { name: "Cancel", exact: true });
      // Pressed: a touch smaller, its colour the same as before the press (no flash). Let go off it: no click.
      await expect.poll(() => sheet.evaluate((d) => d.getAnimations().length)).toBe(0);
      const r = (await cancel.boundingBox())!;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await expect.poll(() => cancel.evaluate((b) => b.getAnimations().length)).toBe(0);
      const before = await cancel.evaluate((b) => getComputedStyle(b).backgroundColor);
      await page.mouse.down();
      await expect.poll(() => cancel.evaluate((b) => getComputedStyle(b).scale)).toBe("0.97");
      expect(await cancel.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe(before);
      await page.mouse.move(4, 4);
      await page.mouse.up();
      await expect.poll(() => cancel.evaluate((b) => getComputedStyle(b).scale)).toMatch(/^(none|1)$/);
      await expect(sheet).toBeVisible();

      // A switch: the thumb slides across, the green fades in over the track.
      const pinned = sheet.locator('label.switch[aria-label="Pinned"]');
      await pinned.click();
      await expect(pinned.locator("input")).toBeChecked();
      // Unsaved: closing asks first, and the question fades in where the settings were.
      await page.keyboard.press("Escape");
      await expect(sheet.getByRole("alert")).toContainText("Discard changes?");
      await sheet.getByRole("button", { name: "Keep editing", exact: true }).click();
      await pinned.click();
      await expect(pinned.locator("input")).not.toBeChecked();

      // A two-step question: its second step fades in where the first was.
      await sheet.getByRole("button", { name: "Delete chat", exact: true }).click();
      const ask = page.getByRole("dialog", { name: "Delete this chat?", exact: true });
      await ask.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Are you sure?", exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "Are you sure?", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      const seen = await watched(page);
      expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p))), "nothing animates a layout property").toEqual([]);
      expect(seen.animations.some((a) => a.what.startsWith("button.btn") && a.props.includes("scale")), "the press").toBe(true);
      expect(seen.animations.some((a) => a.what.endsWith("::after transition") && a.props.includes("transform")), "the switch's thumb").toBe(true);
      expect(seen.animations.some((a) => a.what.endsWith("::before transition") && a.props.includes("opacity")), "the switch's colour").toBe(true);
      const steps = seen.animations.filter((a) => a.what.startsWith("div.dialog-body") && a.what.endsWith("script"));
      expect(steps.length, "the discard question and the second step fade in").toBeGreaterThanOrEqual(3);
      for (const s of steps) {
        expect(s.props).toEqual(["opacity"]);
        expect(s.ms).toBeLessThanOrEqual(150);
      }
    } finally {
      await c.cleanup();
    }
  });

  test("a notice takes taps as it drops in, its count pops when it comes again, and dismissed it's gone at once", async ({ page }) => {
    await page.goto("/#/");
    await expect(page.locator(".app")).toBeVisible();
    await slowDown(page);
    await watch(page);
    const toast = (text: string) => page.evaluate(async (text) => (await import("/src/store.ts")).useStore.getState().toast("info", text), text);
    await toast("Motion check: first.");
    await toast("Motion check: saved.");
    const notice = page.locator(".toast").filter({ hasText: "Motion check: saved." });
    await expect(notice).toBeVisible();
    // The same notice again counts up, and the count pops.
    await toast("Motion check: saved.");
    await expect(notice.locator(".toast-count")).toHaveText("×2");
    expect(await notice.locator(".toast-count").evaluate((el) => el.getAnimations().map((a) => (a as CSSAnimation).animationName))).toContain("m-pop-in");
    // Still coming in (six seconds here), and Dismiss is where a tap lands.
    await page.locator(".toast").first().evaluate((el) => el.setAttribute("data-test-first", ""));
    const dismiss = await midEntrance(page, "[data-test-first]", '[aria-label="Dismiss"]');
    expect(dismiss.hit, "a tap on Dismiss while the notice comes in lands on it").toBe(true);
    // At its full size all the way: its Dismiss is the size it will be from its first frame (it was 37 px of its 40 when
    // notices grew in from 0.92).
    expect(await fullSize(page, "[data-test-first]"), "the notice is its full size while it comes in").toBe(true);
    expect(await fullSize(page, '[data-test-first] [aria-label="Dismiss"]'), "so is its Dismiss").toBe(true);
    // It rises a touch into place, so it never reaches up over the header's buttons on its way in.
    const first = page.locator("[data-test-first]");
    const topNow = (await first.boundingBox())!.y;
    const topAtRest = await first.evaluate((el) => {
      const playing = el.getAnimations();
      playing.forEach((a) => a.pause());
      const at = playing.map((a) => a.currentTime);
      playing.forEach((a) => a.finish());
      const y = el.getBoundingClientRect().y;
      playing.forEach((a, i) => { a.currentTime = at[i]; a.play(); });
      return y;
    });
    expect(topNow, "its top edge is never above where it rests").toBeGreaterThanOrEqual(topAtRest - 0.5);
    await page.mouse.click(dismiss.x, dismiss.y);
    // Gone at once; its copy rises away, out of every selector's reach; the other notice glides up into its place.
    await expect(page.locator('[data-ghost="toast"]')).toHaveCount(1);
    expect(await page.locator(".toast").filter({ hasText: "Motion check: first." }).count()).toBe(0);
    expect(await copyOf(page, "toast")).toEqual(AS_A_COPY);
    await expect(page.getByText("Motion check: first.")).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveCount(1);
    await endExits(page);
    await expect(page.locator("[data-ghost]")).toHaveCount(0);

    const seen = await watched(page);
    expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p))), "nothing animates a layout property").toEqual([]);
    expect(seen.animations.some((a) => a.what.startsWith("div.toast") && a.what.endsWith("script") && a.props.includes("transform")), "the other notice glided up").toBe(true);
    expect(seen.animations.some((a) => a.what.endsWith("m-toast-out")), "the copy rose away").toBe(true);
  });

  test("the chats drawer takes taps as it slides in; closed, it's gone at once and the screen under its copy takes taps", async ({ page, request, token }) => {
    const c = await chat(request, token, "Motion: the drawer");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      const show = page.getByRole("button", { name: /^Show chats/ });
      await expect(show).toBeVisible();
      await slowDown(page);
      await watch(page);
      await show.click();
      const drawer = page.locator("aside.chat-sidebar.drawer");
      await expect(drawer).toBeVisible();
      const close = await midEntrance(page, "aside.chat-sidebar.drawer", '[aria-label="Close"]');
      expect(close.hit, "a tap on Close while the drawer slides in lands on it").toBe(true);
      await page.mouse.click(close.x, close.y);
      await expect(page.locator('[data-ghost="drawer"]')).toHaveCount(1);
      await expect(page.locator('[data-ghost="scrim"]')).toHaveCount(1);
      expect(await drawer.count()).toBe(0);
      expect(await copyOf(page, "drawer")).toEqual(AS_A_COPY);
      expect(await copyOf(page, "scrim")).toEqual(AS_A_COPY);
      await expect(page.getByRole("complementary", { name: "Chats" })).toHaveCount(0);
      // Show chats, under the leaving drawer, takes the tap: the drawer opens again.
      const s = (await show.boundingBox())!;
      const at = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null, at)).toMatch(/^Show chats/);
      await page.mouse.click(at.x, at.y);
      await expect(drawer).toBeVisible();
      await endExits(page);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);

      const seen = await watched(page);
      expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p))), "nothing animates a layout property").toEqual([]);
      expect(seen.animations.some((a) => a.what.startsWith("aside.chat-sidebar.drawer") && a.what.endsWith("m-drawer-out")), "the copy slid away").toBe(true);
    } finally {
      await c.cleanup();
    }
  });

  test("what 0.6.2 already moved in is in place no later than it was there: a sheet by 220 ms, the drawer by 200, a notice by 180, a menu by 120", async ({ page, request, token }) => {
    const c = await chat(request, token, "Motion: in time");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      const opener = page.getByRole("button", { name: "Chat settings", exact: true });
      await expect(opener).toBeVisible();
      // When each entrance has played out, from its style (it says so whenever it's asked, played or not), so a slow
      // frame can't hide a short one: every animation it plays ends by then, its delay included.
      const inPlaceBy = (selector: string) =>
        page.locator(selector).first().evaluate((el) => {
          const style = getComputedStyle(el);
          const list = (v: string) => v.split(",").map((x) => x.trim());
          const time = (v: string) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000);
          const delays = list(style.animationDelay);
          return {
            names: list(style.animationName).join(" "),
            ms: Math.max(...list(style.animationDuration).map((d, i) => time(d) + time(delays[i % delays.length]))),
          };
        });
      const seen: Record<string, { names: string; ms: number }> = {};
      await opener.click();
      await expect(page.getByRole("dialog", { name: "Chat settings", exact: true })).toBeVisible();
      seen.sheet = await inPlaceBy(".app > .overlay .dialog");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: /^Show chats/ }).click();
      const drawer = page.locator("aside.chat-sidebar.drawer");
      await expect(drawer).toBeVisible();
      seen.drawer = await inPlaceBy("aside.chat-sidebar.drawer");
      await drawer.getByRole("button", { name: "New chat", exact: true }).click();
      await expect(drawer.getByRole("menu", { name: "New chat", exact: true })).toBeVisible();
      seen.newChat = await inPlaceBy("aside.chat-sidebar.drawer .csb-new-menu");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await drawer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(drawer).toHaveCount(0);
      await page.evaluate(async () => (await import("/src/store.ts")).useStore.getState().toast("info", "Motion check: in time."));
      await expect(page.locator(".toast")).toBeVisible();
      seen.notice = await inPlaceBy(".toast");
      await page.getByRole("button", { name: /^Permissions:/ }).click();
      await expect(page.getByRole("dialog", { name: "Permissions", exact: true })).toBeVisible();
      seen.menu = await inPlaceBy(".ctl-pop");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // None moves for longer than 0.6.2's own did (a test run with motion on waits that long at most before it can
      // click in one: Playwright clicks what has stopped moving). The New chat menu came at once in 0.6.2: it takes what
      // the chat's menus took.
      expect(seen).toEqual({
        sheet: { names: "m-sheet-in", ms: expect.any(Number) },
        drawer: { names: "m-drawer-in", ms: expect.any(Number) },
        newChat: { names: "csb-menu-in", ms: expect.any(Number) },
        notice: { names: "m-toast-in", ms: expect.any(Number) },
        menu: { names: "m-menu-in", ms: expect.any(Number) },
      });
      expect(seen.sheet.ms, "a sheet").toBeLessThanOrEqual(220);
      expect(seen.drawer.ms, "the drawer").toBeLessThanOrEqual(200);
      expect(seen.notice.ms, "a notice").toBeLessThanOrEqual(180);
      expect(seen.menu.ms, "a chat's menu").toBeLessThanOrEqual(120);
      expect(seen.newChat.ms, "the New chat menu").toBeLessThanOrEqual(120);
    } finally {
      await c.cleanup();
    }
  });

  test("a sheet closed while it still comes in leaves from as faint as it was, its dim too, without brightening first", async ({ page, request, token }) => {
    const c = await chat(request, token, "Motion: faint");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      const opener = page.getByRole("button", { name: "Chat settings", exact: true });
      await expect(opener).toBeVisible();
      // A minute to come in, and to go: it's caught a moment in, still faint.
      await page.addStyleTag({ content: ":root { --dur-sheet-in: 60s; --dur-fade: 60s; --dur-sheet-out: 60s; }" });
      await opener.click();
      await expect(page.getByRole("dialog", { name: "Chat settings", exact: true })).toBeVisible();
      await page.waitForTimeout(1000);
      const live = await page.locator(".app > .overlay").evaluate((o) => ({ sheet: Number(getComputedStyle(o.querySelector(".dialog")!).opacity), dim: Number(getComputedStyle(o, "::before").opacity) }));
      expect(live.sheet, "the sheet is still fading in").toBeLessThan(0.8);
      expect(live.dim, "and so is its dim").toBeLessThan(0.8);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const copy = await page.evaluate(async () => {
        const { ghosts } = await import("/src/motion.ts");
        const o = ghosts().find((g) => g.matches(".overlay"));
        return o ? { sheet: Number(getComputedStyle(o.querySelector(".dialog")!).opacity), dim: Number(getComputedStyle(o, "::before").opacity) } : null;
      });
      expect(copy, "a copy leaves").not.toBeNull();
      expect(Math.abs(copy!.sheet - live.sheet), `the copy starts as faint as the sheet was: ${JSON.stringify({ live, copy })}`).toBeLessThan(0.1);
      expect(Math.abs(copy!.dim - live.dim), `and its dim as faint as it was: ${JSON.stringify({ live, copy })}`).toBeLessThan(0.1);
      await endExits(page);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);
    } finally {
      await c.cleanup();
    }
  });

  test("Jump to latest fades in; tapped, it's gone at once and its copy shrinks away", async ({ page, request, token }) => {
    const c = await longChat(page, request, token, "Motion: jump");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 24", { exact: true })).toBeVisible();
      await watch(page);
      await page.locator(".messages").evaluate((el) => (el.scrollTop = 0));
      const jump = page.getByRole("button", { name: /^Jump to latest/ });
      await expect(jump).toBeVisible();
      await slowDown(page);
      await jump.click({ force: true });
      await expect(page.locator('[data-ghost="jump"]')).toHaveCount(1);
      expect(await jump.count()).toBe(0);
      expect(await copyOf(page, "jump")).toEqual(AS_A_COPY);
      expect(await page.locator(".messages").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
      await endExits(page);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);
      const seen = await watched(page);
      expect(seen.animations.some((a) => a.what.startsWith("button.jump-latest-btn") && a.what.endsWith("m-fade-in")), "it faded in, as it always did").toBe(true);
      expect(seen.animations.some((a) => a.what.startsWith("button.jump-latest-btn") && a.what.endsWith("m-pop-out")), "its copy shrank away").toBe(true);
      expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p)))).toEqual([]);
    } finally {
      await c.cleanup();
    }
  });
});

test.describe("with Reduce Motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing moves: what comes in fades in 150 ms or less, what goes is simply gone, and no copy is ever made", async ({ page, request, token }) => {
    const c = await chat(request, token, "Motion: reduced");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      const opener = page.getByRole("button", { name: "Chat settings", exact: true });
      await expect(opener).toBeVisible();
      await watch(page);

      // A sheet, its switch, its "Discard changes?", a two-step question.
      await opener.click();
      const sheet = page.getByRole("dialog", { name: "Chat settings", exact: true });
      const cancel = sheet.getByRole("button", { name: "Cancel", exact: true });
      const r = (await cancel.boundingBox())!;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      // Held: dimmed, not shrunk.
      await expect.poll(() => cancel.evaluate((b) => getComputedStyle(b).opacity)).toBe("0.7");
      expect(await cancel.evaluate((b) => getComputedStyle(b).scale)).toMatch(/^(none|1)$/);
      await page.mouse.move(4, 4);
      await page.mouse.up();
      const pinned = sheet.locator('label.switch[aria-label="Pinned"]');
      await pinned.click();
      await page.keyboard.press("Escape");
      await sheet.getByRole("button", { name: "Discard changes", exact: true }).click();
      expect(await page.getByRole("dialog").count()).toBe(0);
      await opener.click();
      await page.getByRole("button", { name: "Delete chat", exact: true }).click();
      await page.getByRole("dialog", { name: "Delete this chat?", exact: true }).getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("dialog", { name: "Are you sure?", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // A notice that comes twice, dismissed.
      const toast = (text: string) => page.evaluate(async (text) => (await import("/src/store.ts")).useStore.getState().toast("info", text), text);
      await toast("Motion check: reduced.");
      await toast("Motion check: reduced.");
      const notice = page.locator(".toast");
      await expect(notice.locator(".toast-count")).toHaveText("×2");
      await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
      expect(await notice.count()).toBe(0);

      // The drawer, in and out.
      await page.getByRole("button", { name: /^Show chats/ }).click();
      const drawer = page.locator("aside.chat-sidebar.drawer");
      await drawer.getByRole("button", { name: "Close", exact: true }).click();
      expect(await drawer.count()).toBe(0);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

      const seen = await watched(page);
      expect(seen.copies, "no exit copies under Reduce Motion").toBe(0);
      expect(seen.animations.filter((a) => a.props.some((p) => MOVES.has(p) || LAYOUT.test(p))), "nothing moves").toEqual([]);
      expect(seen.animations.filter((a) => a.repeats), "nothing repeats").toEqual([]);
      expect(seen.animations.filter((a) => a.props.some((p) => !PAINT.test(p))), "only fades and colour").toEqual([]);
      expect(seen.animations.filter((a) => a.ms > 150), "and briefly").toEqual([]);
      // Each fades in under the name it moves by with motion, so turning the setting on or off never plays it again.
      const faded = (what: string, name: string) => seen.animations.some((a) => a.what.startsWith(what) && a.what.endsWith(` ${name}`) && a.props.join() === "opacity");
      expect(faded("div.dialog", "m-sheet-in"), "the sheet faded in").toBe(true);
      expect(faded("div.toast", "m-toast-in"), "the notice faded in").toBe(true);
      expect(faded("aside.chat-sidebar.drawer", "m-drawer-in"), "the drawer faded in").toBe(true);
    } finally {
      await c.cleanup();
    }
  });

  test("Jump to latest fades in and simply goes", async ({ page, request, token }) => {
    const c = await longChat(page, request, token, "Motion: reduced jump");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 24", { exact: true })).toBeVisible();
      await watch(page);
      await page.locator(".messages").evaluate((el) => (el.scrollTop = 0));
      const jump = page.getByRole("button", { name: /^Jump to latest/ });
      await jump.click();
      expect(await jump.count()).toBe(0);
      const seen = await watched(page);
      expect(seen.copies).toBe(0);
      expect(seen.animations.filter((a) => a.props.some((p) => !PAINT.test(p)) || a.ms > 150)).toEqual([]);
    } finally {
      await c.cleanup();
    }
  });
});
