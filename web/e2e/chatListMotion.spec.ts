import type { APIRequestContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import type { AgentAccount, Member, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect } from "./fixtures";

/*
 * The chat list's motion (web/src/views/ChatListMotion.ts, web/src/styles/motion-lists.css), on a phone (390 px), in
 * each engine:
 * - its lines glide to their new places (a chat with news going to the top, a pin, a fold), from exactly where they
 *   were drawn, only on screen, and take a tap wherever they're drawn on the way;
 * - nothing waits for it: the focus is back on a pinned row while it still glides, and what goes is gone from the page
 *   at once while an inert copy fades;
 * - search results as you type, and the drawer's scroll position when it opens again, never move;
 * - only transform and opacity animate, never a layout property (a row going over the others is a plain z-index for as
 *   long as it glides, never an animation of it);
 * - Reduce Motion: no glides, pops, copies or slides; what comes in fades, 150 ms or less.
 * web/e2e/motion.spec.ts covers what every screen shares (sheets, the drawer itself, notices).
 */

const HUB = "http://127.0.0.1:8451";
const APP = "http://127.0.0.1:5198";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
/** Properties that lay the page out again: never animated. */
const LAYOUT = /^(width|height|(min|max)-(width|height)|top|right|bottom|left|inset(-.+)?|margin(-.+)?|padding(-.+)?|border(-(top|right|bottom|left))?-width|font-size|line-height|(row-|column-)?gap|flex(-.+)?|grid(-.+)?|display|position|zoom)$/;
const MOVES = new Set(["transform", "translate", "scale", "rotate"]);
/** Fades and colour: allowed under either setting. */
const PAINT = /^(opacity|color|background-color|box-shadow|border(-(top|right|bottom|left))?-color|outline-color)$/;

test.beforeEach(({}, info) => test.skip(!info.project.name.endsWith("-390"), "Once per engine, on a phone (390 px)."));

/** Chats with Codex (or Claude Code), made a moment apart. */
async function made(request: APIRequestContext, token: string, names: string[], provider: "claude" | "codex" = "codex") {
  const headers = { authorization: `Bearer ${token}` };
  const rooms: Room[] = [];
  for (const name of names) rooms.push(await (await request.post(`${HUB}/api/chats`, { headers, data: { provider, name } })).json());
  return { rooms, cleanup: async () => void (await Promise.all(rooms.map((r) => request.delete(`${HUB}/api/rooms/${r.id}`, { headers })))) };
}

/**
 * The list holds these chats and no others (whatever else the shared test hub has), newest last in `ids`, a second
 * apart; `unread` has a reply no one has read; `extra` are made-up chats added to it (they're only ever listed). Returns
 * each chat as the page was given it, for live events about it.
 */
async function onlyThese(page: Page, ids: string[], also: { unread?: string; extra?: Room[] } = {}) {
  const given = new Map<string, Room>();
  const place = new Map(ids.map((id, i) => [id, i]));
  await page.route((url) => url.origin === APP && url.pathname === "/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    s.rooms = [
      ...(s.rooms as Room[])
        .filter((r) => place.has(r.id))
        .map((r) => ({ ...r, updatedAt: Date.now() - (place.size - place.get(r.id)!) * 1000, ...(r.id === also.unread ? { lastReplyAt: Date.now(), readAt: Date.now() - 60_000 } : {}) })),
      ...(also.extra ?? []),
    ];
    s.members = (s.members as Member[]).filter((m) => place.has(m.roomId));
    for (const r of s.rooms as Room[]) given.set(r.id, r);
    await route.fulfill({ json: s });
  });
  return given;
}

/** The page's live connection to the hub, with a way to say more on the hub's behalf. */
async function liveSocket(page: Page) {
  // Every connection the app makes (the dev app starts twice, in React's strict mode, and the first one's closes).
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", (ws) => {
    sockets.push(ws);
    ws.connectToServer();
  });
  return {
    send: (e: unknown) => {
      for (const ws of sockets) {
        try {
          ws.send(JSON.stringify(e));
        } catch {
          // closed
        }
      }
    },
  };
}

/** The chats drawer, opened (and slid all the way in, so where its rows are drawn is where they rest). */
async function drawer(page: Page) {
  await page.getByRole("button", { name: /^Show chats/ }).click();
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(side).toBeVisible();
  await side.evaluate((el) => el.getAnimations().forEach((a) => a.finish()));
  return side;
}

const rowOf = (where: Locator, name: string) => where.locator(".csb-item").filter({ has: where.page().locator(".csb-chat-name", { hasText: new RegExp(`^${name}$`) }) });
const moreOf = (where: Locator, name: string) => rowOf(where, name).getByRole("button", { name: `Options for ${name}`, exact: true });
const groupOf = (side: Locator, name: string) => side.locator(".csb-group").filter({ has: side.page().locator(".csb-agent-name", { hasText: name }) });
const names = (where: Locator) => where.locator(".csb-chat-name").allTextContents();

type Seen = { what: string; line: string | null; props: string[]; ms: number; repeats: boolean; onScreen: boolean };

/** Everything that animates from now on (exit copies included), as each frame goes by, and the most of the chat list's
 *  own copies at once (a notice timing out meanwhile is none of its business). */
async function watch(page: Page) {
  await page.evaluate(async () => {
    const { ghosts } = await import("/src/motion.ts");
    const { lineKey } = await import("/src/views/ChatListMotion.ts");
    const out = { animations: [] as Seen[], copies: 0 };
    (window as unknown as { __lists: typeof out }).__lists = out;
    const known = new WeakSet<Animation>();
    const name = (el: Element | null) => (el ? `${el.localName}${typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}` : "?");
    const look = (a: Animation) => {
      if (known.has(a)) return;
      known.add(a);
      const effect = a.effect as KeyframeEffect | null;
      const target = (effect?.target ?? null) as HTMLElement | null;
      const props =
        "transitionProperty" in a
          ? [String((a as CSSTransition).transitionProperty)]
          : [...new Set((effect?.getKeyframes() ?? []).flatMap((k) => Object.keys(k)).filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p)))].map((p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      const timing = effect?.getComputedTiming();
      const label = "animationName" in a ? (a as CSSAnimation).animationName : "transitionProperty" in a ? "transition" : "script";
      const list = document.querySelector(".csb-scroll")?.getBoundingClientRect();
      const r = target?.getBoundingClientRect();
      out.animations.push({
        what: `${name(target)}${effect?.pseudoElement ?? ""} ${label}`,
        line: target?.isConnected && target.closest(".csb-scroll") ? lineKey(target) : null,
        props,
        ms: Number(timing?.duration) || 0,
        repeats: timing?.iterations === Infinity,
        onScreen: !!(r && list && r.bottom > list.top && r.top < list.bottom),
      });
    };
    const frame = () => {
      for (const a of document.getAnimations()) look(a);
      for (const copy of ghosts()) for (const a of copy.getAnimations({ subtree: true })) look(a);
      out.copies = Math.max(out.copies, document.querySelectorAll(".chat-sidebar [data-ghost]").length);
      requestAnimationFrame(frame);
    };
    frame();
  });
}
const watched = (page: Page) => page.evaluate(() => (window as unknown as { __lists: { animations: Seen[]; copies: number } }).__lists);
/** What was seen since the last look, and starts afresh. */
const since = async (page: Page) => {
  const seen = await watched(page);
  await page.evaluate(() => {
    const out = (window as unknown as { __lists: { animations: Seen[]; copies: number } }).__lists;
    out.animations = [];
    out.copies = 0;
  });
  return seen;
};
const twoFrames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** Everything moving in the chat list lands at once, and its copies go: a click then finds nothing on its way. */
const settle = (page: Page) =>
  page.evaluate(async () => {
    const { ghosts } = await import("/src/motion.ts");
    const moving = [...(document.querySelector(".chat-sidebar")?.getAnimations({ subtree: true }) ?? []), ...ghosts().flatMap((g) => g.getAnimations({ subtree: true }))];
    for (const a of moving) if (Number.isFinite(Number(a.effect?.getComputedTiming().endTime))) a.finish();
  });

/** Glides last a minute here, so a test can look at one on its way (and tap what's moving). */
const slowGlides = (page: Page) => page.addStyleTag({ content: ":root { --dur-flip: 60s; --dur-menu-out: 60s; }" });

/**
 * A row's glide: where it was drawn as it started, where it's laid out (the glide played to its end), and whether it
 * goes over the others. Null when it isn't gliding.
 */
const glideOf = (row: Locator) =>
  row.evaluate((el) => {
    const all = el.getAnimations();
    const glide = all.find((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => "transform" in k && String(k.transform).startsWith("translate")));
    if (!glide) return null;
    const lift = (el as HTMLElement).style.zIndex === "1";
    const at = glide.currentTime;
    glide.pause();
    glide.currentTime = 0;
    const from = el.getBoundingClientRect().toJSON() as DOMRect;
    glide.finish();
    const to = el.getBoundingClientRect().toJSON() as DOMRect;
    const after = getComputedStyle(el).transform;
    glide.currentTime = at;
    glide.play();
    return { from, to, lift, after, running: true };
  });

test.describe("with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("a chat with news glides up to the top over the others, from where it was, and takes a tap on its way", async ({ page, request, token }) => {
    const tag = Math.random().toString(36).slice(2, 6);
    const chats = await made(request, token, [`Alpha ${tag}`, `Bravo ${tag}`, `Charlie ${tag}`, `Delta ${tag}`]);
    const [alpha, bravo, charlie, delta] = chats.rooms.map((r) => r.name);
    try {
      const given = await onlyThese(page, chats.rooms.map((r) => r.id));
      const live = await liveSocket(page);
      await page.goto("/");
      const side = await drawer(page);
      const codex = groupOf(side, "Codex");
      await expect.poll(() => names(codex)).toEqual([delta, charlie, bravo, alpha]);
      await slowGlides(page);
      await watch(page);
      const was = (await rowOf(codex, alpha).boundingBox())!;

      // News in Alpha: it goes to the top, the rest make room.
      const room = given.get(chats.rooms[0].id)!;
      live.send({ t: "room", room: { ...room, updatedAt: Date.now() + 5_000 } });
      await expect.poll(() => names(codex)).toEqual([alpha, delta, charlie, bravo]);
      const glide = (await glideOf(rowOf(codex, alpha)))!;
      expect(glide, "Alpha glides").not.toBeNull();
      // From exactly where it was drawn, to the top of the group, over the rows it passes.
      expect(Math.abs(glide.from.y - was.y), JSON.stringify({ was, glide })).toBeLessThan(1);
      expect(Math.abs(glide.from.x - was.x), JSON.stringify({ was, glide })).toBeLessThan(1);
      expect(glide.to.y).toBeLessThan(was.y - 2 * was.height);
      expect(glide.lift).toBe(true);
      expect(glide.after).toBe("none");
      for (const other of [delta, charlie, bravo]) {
        const g = await glideOf(rowOf(codex, other));
        expect(g, `${other} makes room`).not.toBeNull();
        expect(g!.lift, `${other} only moves a row`).toBe(false);
      }
      await page.screenshot({ ...shot("chat-list-news-glide.png") });

      // On its way (it takes a minute here), a tap where it's drawn lands on it, and opens the chat.
      const drawn = (await rowOf(codex, alpha).locator(".csb-chat").boundingBox())!;
      const at = { x: drawn.x + drawn.width / 3, y: drawn.y + drawn.height / 2 };
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".csb-chat")?.querySelector(".csb-chat-name")?.textContent, at)).toBe(alpha);
      await page.mouse.click(at.x, at.y);
      await expect(page.getByRole("heading", { name: alpha, exact: true })).toBeVisible();

      const seen = await watched(page);
      expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p))), "nothing animates a layout property").toEqual([]);
      expect(seen.animations.filter((a) => a.props.some((p) => !MOVES.has(p) && !PAINT.test(p))), "only transform, opacity and colour animate (the lift is no animation)").toEqual([]);
      const glides = seen.animations.filter((a) => a.line?.startsWith("r:") && a.props.includes("transform"));
      expect(glides.length).toBe(4);
      expect(glides.every((a) => a.onScreen), "only rows on screen move").toBe(true);
    } finally {
      await chats.cleanup();
    }
  });

  test("a pin glides the row up to Pinned with the focus already on it, and the last unpin leaves Pinned as a fading copy", async ({ page, request, token }) => {
    const tag = Math.random().toString(36).slice(2, 6);
    // Newest last: Fix login is at the top of Codex's chats, with two under it.
    const chats = await made(request, token, [`Old one ${tag}`, `Write docs ${tag}`, `Fix login ${tag}`]);
    const [, docs, fix] = chats.rooms.map((r) => r.name);
    try {
      await onlyThese(page, chats.rooms.map((r) => r.id));
      await page.goto("/");
      const side = await drawer(page);
      const codex = groupOf(side, "Codex");
      await expect(rowOf(codex, fix)).toBeVisible();
      await watch(page);
      const was = (await rowOf(codex, fix).boundingBox())!;

      await moreOf(codex, fix).click();
      // Its options drop in under it; the rows below glide down to make room.
      await expect(rowOf(codex, fix).locator(".csb-row-tray")).toBeVisible();
      await twoFrames(page);
      const opened = await since(page);
      expect(opened.animations.some((a) => a.what.startsWith("div.csb-row-tray") && a.what.endsWith("m-drop-in")), "the options drop in").toBe(true);
      expect(opened.animations.some((a) => a.line === `r:/${chats.rooms[1].id}` && a.props.includes("transform")), "the row below makes room").toBe(true);
      await slowGlides(page);

      await rowOf(codex, fix).getByRole("button", { name: "Pin to top", exact: true }).click();
      // The focus is back on its ⋯, under Pinned, while it's still on its way there.
      const pinned = side.getByRole("region", { name: "Pinned", exact: true });
      await page.waitForFunction((name) => document.activeElement?.getAttribute("aria-label") === `Options for ${name}` && !!document.activeElement.closest('[data-group="pinned"]'), fix);
      const glide = (await glideOf(rowOf(pinned, fix)))!;
      expect(glide, "the pinned row glides").not.toBeNull();
      expect(Math.abs(glide.from.y - was.y), `from where it was: ${JSON.stringify({ was, glide })}`).toBeLessThan(1);
      expect(glide.to.y, "up to Pinned").toBeLessThan(was.y);
      await expect(moreOf(pinned, fix)).toBeFocused();
      await page.screenshot({ ...shot("chat-list-pin-glide.png") });

      await settle(page);

      // The last one unpinned: Pinned is gone from the page at once; a copy of it fades, without the row, which glides
      // back down instead (with the focus on it).
      await moreOf(pinned, fix).click();
      await rowOf(pinned, fix).getByRole("button", { name: "Unpin", exact: true }).click();
      await expect(pinned).toHaveCount(0);
      await expect(moreOf(codex, fix)).toBeFocused();
      const copy = await page.evaluate(async () => {
        const { ghosts } = await import("/src/motion.ts");
        const section = ghosts().find((g) => g.matches("section.csb-group"));
        const row = section?.querySelector<HTMLElement>(".csb-item");
        return section ? { kind: section.dataset.ghost, rowShown: row ? getComputedStyle(row).visibility : null } : null;
      });
      expect(copy).toEqual({ kind: "row", rowShown: "hidden" });
      await expect(side.getByText("Pinned", { exact: true })).toHaveCount(0);
      expect(await page.locator("body").ariaSnapshot()).not.toContain("Pinned");
      await page.evaluate(async () => {
        const { ghosts } = await import("/src/motion.ts");
        for (const copy of ghosts()) for (const a of copy.getAnimations({ subtree: true })) a.finish();
      });
      await expect(page.locator("[data-ghost]")).toHaveCount(0);
      expect(await names(codex)).toContain(docs);

      const seen = await watched(page);
      expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p))), "nothing animates a layout property").toEqual([]);
    } finally {
      await chats.cleanup();
    }
  });

  test("folding fades the rows away as copies while the groups below slide up and the chevron turns; a search never moves", async ({ page, request, token }) => {
    const tag = Math.random().toString(36).slice(2, 6);
    const claude = await made(request, token, [`Plan the trip ${tag}`], "claude");
    const codexChats = await made(request, token, [`Fix login ${tag}`, `Write docs ${tag}`]);
    try {
      await onlyThese(page, [...claude.rooms, ...codexChats.rooms].map((r) => r.id));
      await page.goto("/");
      const side = await drawer(page);
      const claudeGroup = groupOf(side, "Claude Code");
      const codex = groupOf(side, "Codex");
      await expect(rowOf(claudeGroup, claude.rooms[0].name)).toBeVisible();
      await watch(page);

      await claudeGroup.getByRole("button", { name: "Hide Claude Code chats", exact: true }).click();
      // Gone from the page at once (its copy fades, out of every selector's reach), and folded it says what's inside.
      await expect(claudeGroup.locator(".csb-chat")).toHaveCount(0);
      await expect(claudeGroup.locator(".csb-fold-said")).toHaveText("1 chat");
      await expect(side.getByText(claude.rooms[0].name)).toHaveCount(0);
      await twoFrames(page);
      const folded = await since(page);
      expect(folded.copies, "the row leaves a copy").toBeGreaterThan(0);
      expect(folded.animations.some((a) => a.what.includes("csb-item") && a.what.endsWith("m-fade-out")), "which fades").toBe(true);
      expect(folded.animations.some((a) => a.line === "g:codex" && a.props.includes("transform")), "Codex's heading slides up").toBe(true);
      expect(folded.animations.some((a) => a.line === `r:/${codexChats.rooms[0].id}` && a.props.includes("transform")), "its rows slide up").toBe(true);
      expect(folded.animations.some((a) => a.line === "s:claude" && a.props.includes("opacity")), "what's inside fades in").toBe(true);
      expect(folded.animations.some((a) => a.what.startsWith("svg") && a.props.includes("transform")), "the chevron turns").toBe(true);
      expect(folded.animations.filter((a) => a.props.some((p) => LAYOUT.test(p)))).toEqual([]);

      // Unfolded: the row fades back in, the groups below slide down.
      await claudeGroup.getByRole("button", { name: /^Show Claude Code chats/ }).click();
      await expect(rowOf(claudeGroup, claude.rooms[0].name)).toBeVisible();
      await twoFrames(page);
      const unfolded = await since(page);
      expect(unfolded.animations.some((a) => a.line === `r:/${claude.rooms[0].id}` && a.props.includes("opacity")), "the row fades in").toBe(true);
      expect(unfolded.animations.some((a) => a.line === "g:codex" && a.props.includes("transform")), "Codex's heading slides down").toBe(true);

      // A search filters at once, as you type, and clearing it puts the list back at once: nothing in it moves.
      await settle(page);
      await expect(page.locator(".chat-sidebar [data-ghost]")).toHaveCount(0);
      await since(page);
      const search = side.getByRole("textbox", { name: "Search chats", exact: true });
      await search.pressSequentially("login", { delay: 30 });
      await expect(codex.locator(".csb-chat-name")).toHaveText([codexChats.rooms[0].name]);
      await search.fill("");
      await expect(codex.locator(".csb-chat")).toHaveCount(2);
      await twoFrames(page);
      const searched = await since(page);
      expect(searched.animations.filter((a) => a.line !== null), "no line moves or fades while searching").toEqual([]);
      expect(searched.copies, "and nothing leaves a copy").toBe(0);
    } finally {
      await claude.cleanup();
      await codexChats.cleanup();
    }
  });

  test("with hundreds of chats, only what's on screen moves, and the drawer opens again exactly where it was", async ({ page, request, token }) => {
    const base = Date.now();
    // Made-up chats, only listed: 300 of them with Codex, a second apart.
    const extra = Array.from({ length: 300 }, (_, i) => ({ id: `r_many_${i}`, name: `Many ${String(i).padStart(3, "0")}`, cwd: `/tmp/many-${i}`, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: base - 1e6, updatedAt: base - 1e6 - i * 1000, archived: false, chat: { provider: "codex", origin: "web" } }) as unknown as Room);
    const given = await onlyThese(page, [], { extra });
    const live = await liveSocket(page);
    await page.goto("/");
    const side = await drawer(page);
    const codex = groupOf(side, "Codex");
    await side.getByRole("button", { name: "Show all 300", exact: true }).click();
    await expect(codex.locator(".csb-item")).toHaveCount(300);
    // Halfway down the list.
    const list = side.locator(".csb-scroll");
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    await expect.poll(() => page.evaluate(async () => (await import("/src/sidebar.ts")).useSidebar.getState().scrollTop)).toBeGreaterThan(1000);
    // Show all's rows that came into view faded in; the look starts once they're in.
    await settle(page);
    await watch(page);

    // Several chats get news at once, one after another: on screen, rows make room; far off it, nothing is drawn.
    const visible = await list.evaluate((nav) => {
      const box = nav.getBoundingClientRect();
      return [...nav.querySelectorAll<HTMLElement>(".csb-item")].filter((r) => {
        const b = r.getBoundingClientRect();
        return b.top > box.top && b.bottom < box.bottom;
      }).map((r) => r.dataset.pinRow!.slice(1));
    });
    // Each frame's gap, for a second and a half from now.
    await page.evaluate(() => {
      const gaps: number[] = [];
      let last = performance.now();
      const until = last + 1500;
      const tick = (t: number) => {
        gaps.push(t - last);
        last = t;
        if (t < until) requestAnimationFrame(tick);
        else (window as unknown as { __gaps: number[] }).__gaps = gaps;
      };
      requestAnimationFrame(tick);
    });
    for (const [i, id] of [visible[3], visible[6], "r_many_299"].entries()) live.send({ t: "room", room: { ...given.get(id)!, updatedAt: base + 1000 * (i + 1) } });
    await expect.poll(() => codex.locator(".csb-chat-name").first().textContent()).toBe("Many 299");
    await page.waitForFunction(() => !!(window as unknown as { __gaps?: number[] }).__gaps, null, { timeout: 5000 });
    // The rows that went up over the others (at their own pace here) are back among them once they've landed.
    expect(await list.evaluate((nav) => [...nav.querySelectorAll<HTMLElement>(".csb-item")].filter((r) => r.style.zIndex).length), "no row is left lifted").toBe(0);
    const seen = await watched(page);
    const moved = seen.animations.filter((a) => a.line !== null);
    expect(moved.filter((a) => a.props.includes("transform")).length, "rows on screen made room").toBeGreaterThan(0);
    // Three changes, each moving at most what a screen shows (a glide, and a lift over the others for one going far).
    expect(moved.filter((a) => a.props.includes("transform")).length, "at most a screenful each time").toBeLessThanOrEqual(3 * 24);
    expect(moved.filter((a) => !a.onScreen), "nothing off screen moves or fades").toEqual([]);
    expect(seen.copies).toBe(0);
    const gaps = await page.evaluate(() => (window as unknown as { __gaps: number[] }).__gaps);
    test.info().annotations.push({ type: "frames", description: `${gaps.length} frames, longest ${Math.round(Math.max(...gaps))} ms, ${moved.length} line animations` });

    // Closed: gone at once, and a copy slides away, of what showed: the rows on screen, each where it was, and an empty
    // box the size of the rest (with 300 rows shown, a whole copy was over 3,000 elements, and too many to copy at all).
    await settle(page);
    const top = await list.evaluate((el) => el.scrollTop);
    const shown = await list.evaluate((nav) => {
      const box = nav.getBoundingClientRect();
      return [...nav.querySelectorAll<HTMLElement>(".csb-item")]
        .map((r) => ({ name: r.querySelector(".csb-chat-name")?.textContent ?? "", y: r.getBoundingClientRect().y }))
        .filter((r) => r.y > box.top && r.y < box.bottom - 40);
    });
    expect(shown.length).toBeGreaterThan(5);
    await side.getByRole("button", { name: "Close", exact: true }).click();
    await expect(side).toHaveCount(0);
    const copy = await page.evaluate(async () => {
      const { ghosts } = await import("/src/motion.ts");
      const drawer = ghosts().find((g) => g.matches("aside.chat-sidebar"));
      if (!drawer) return null;
      // Where its rows are drawn as it starts to go.
      drawer.getAnimations().forEach((a) => {
        a.pause();
        a.currentTime = 0;
      });
      const rows = [...drawer.querySelectorAll<HTMLElement>(".csb-item")].filter((r) => r.querySelector(".csb-chat-name"));
      return { elements: drawer.getElementsByTagName("*").length, rows: rows.map((r) => ({ name: r.querySelector(".csb-chat-name")!.textContent ?? "", y: r.getBoundingClientRect().y })) };
    });
    expect(copy, "the drawer leaves a copy, however long its list").not.toBeNull();
    expect(copy!.elements, "of what showed, not of every row").toBeLessThan(1000);
    for (const row of shown) {
      const there = copy!.rows.find((r) => r.name === row.name);
      expect(there, `${row.name} is in the copy`).toBeDefined();
      expect(Math.abs(there!.y - row.y), `${row.name} starts where it was`).toBeLessThan(1);
    }
    await page.evaluate(async () => {
      const { ghosts } = await import("/src/motion.ts");
      for (const g of ghosts()) for (const a of g.getAnimations({ subtree: true })) a.finish();
    });
    await expect(page.locator("[data-ghost]")).toHaveCount(0);
    // Opened again: exactly where it was, at once, with nothing in it moving.
    await since(page);
    const again = await drawer(page);
    expect(await again.locator(".csb-scroll").evaluate((el) => el.scrollTop)).toBe(top);
    await twoFrames(page);
    expect((await since(page)).animations.filter((a) => a.line !== null), "the list opens still").toEqual([]);
  });

  test("a reply arriving pops its dot (one drawn with the list doesn't), and the New chat menu grows, steps sideways and closes as a copy", async ({ page, request, token }) => {
    const headers = { authorization: `Bearer ${token}` };
    const tag = Math.random().toString(36).slice(2, 6);
    const chats = await made(request, token, [`Read later ${tag}`, `Fresh news ${tag}`]);
    // Five models of yours (and the model pool): the menu has room for three, the rest are a step away.
    const accounts: AgentAccount[] = [];
    for (let i = 1; i <= 5; i++) accounts.push(await (await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: `Model ${i} ${tag}`, baseUrl: "http://127.0.0.1:8099", apiKey: "", models: ["qwen3-8b"], contextWindow: 16384 } })).json());
    try {
      const given = await onlyThese(page, chats.rooms.map((r) => r.id), { unread: chats.rooms[0].id });
      const live = await liveSocket(page);
      await page.goto("/");
      const side = await drawer(page);
      const codex = groupOf(side, "Codex");
      await watch(page);
      // Drawn with the list: no pop.
      const first = rowOf(codex, chats.rooms[0].name).locator(".reply-dot");
      await expect(first).toBeVisible();
      await expect(first).not.toHaveClass(/m-pop/);

      // A reply ends in the other one while the list is up: its dot pops.
      const room = given.get(chats.rooms[1].id)!;
      live.send({ t: "room", room: { ...room, lastReplyAt: Date.now(), readAt: Date.now() - 60_000, updatedAt: Date.now() } });
      const dot = rowOf(codex, chats.rooms[1].name).locator(".reply-dot");
      await expect(dot).toBeVisible();
      await expect(dot).toHaveClass(/m-pop/);
      await twoFrames(page);
      const played = (await since(page)).animations.map((a) => a.what);
      expect(played.filter((w) => w.startsWith("span.reply-dot")), "only the new reply's dot pops").toEqual(["span.reply-dot.m-pop m-pop-in"]);

      // The New chat menu comes down out of its button at its full size (its rows are a finger's size from the first
      // frame: it was 0.92 of it, its 44 px rows about 40), takes a tap at once, and its second step slides in.
      await page.addStyleTag({ content: ":root { --dur-menu-in: 60s; }" });
      await side.getByRole("button", { name: "New chat", exact: true }).click();
      const menu = side.getByRole("menu", { name: "New chat", exact: true });
      await expect(menu).toBeVisible();
      const coming = await menu.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
        const item = el.querySelector<HTMLElement>('[role="menuitem"]')!;
        return {
          moving: el.getAnimations().filter((a) => a.playState === "running").map((a) => (a as CSSAnimation).animationName),
          full: Math.abs(r.height / zoom - (el as HTMLElement).offsetHeight) < 0.5 && Math.abs(r.width / zoom - (el as HTMLElement).offsetWidth) < 0.5,
          item: item.getBoundingClientRect().height,
        };
      });
      expect(coming.moving, "it's still coming in (a minute here)").toEqual(["csb-menu-in"]);
      expect(coming.full, "at its full size").toBe(true);
      expect(coming.item, "its rows a finger's size").toBeGreaterThanOrEqual(44);
      await page.addStyleTag({ content: ":root { --dur-menu-in: 120ms; }" });
      await menu.getByRole("menuitem", { name: /^All your models \(\d+\)$/ }).click();
      const all = side.getByRole("menu", { name: "All your models", exact: true });
      await expect(all.getByRole("menuitem", { name: /Back to Claude Code and Codex/ })).toBeFocused();
      await page.screenshot({ ...shot("chat-list-menu-step.png") });
      await all.getByRole("menuitem", { name: /Back to Claude Code and Codex/ }).click();
      await expect(menu.getByRole("menuitem", { name: /^All your models \(\d+\)$/ })).toBeFocused();
      await twoFrames(page);
      const stepped = (await since(page)).animations.map((a) => a.what);
      expect(stepped, "the menu came in").toEqual(expect.arrayContaining(["div.csb-new-menu csb-menu-in"]));
      expect(stepped, "the step slid in from the right, and back from the left").toEqual(expect.arrayContaining(["div.nc-step.fwd csb-step-fwd", "div.nc-step.back csb-step-back"]));
      expect(stepped.filter((w) => w.startsWith("div.csb-new-menu")), "the menu itself never came in again").toEqual(["div.csb-new-menu csb-menu-in"]);

      // Closed: gone from the page at once, its copy shrinking back into the button; the button under it takes a tap.
      await slowGlides(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.locator('[data-ghost="menu"]')).toHaveCount(1);
      await expect(side.getByRole("button", { name: "New chat", exact: true })).toBeFocused();
      await side.getByRole("button", { name: "New chat", exact: true }).click();
      await expect(side.getByRole("menu", { name: "New chat", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      await twoFrames(page);
      const seen = await watched(page);
      expect(seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p))), "nothing animates a layout property").toEqual([]);
      expect(seen.animations.some((a) => a.what.includes("csb-new-menu") && a.what.endsWith("m-menu-out")), "the copy shrank away").toBe(true);
    } finally {
      await chats.cleanup();
      for (const a of accounts) await request.delete(`${HUB}/api/accounts/codex/${a.id}`, { headers });
    }
  });

  test("at the biggest text size, a pinned row glides from exactly where it was drawn", async ({ page, request, token }) => {
    await page.addInitScript(() => localStorage.setItem("crosstalk.zoom", "150"));
    const tag = Math.random().toString(36).slice(2, 6);
    const chats = await made(request, token, [`Zoomed ${tag}`, `Other ${tag}`]);
    try {
      await onlyThese(page, chats.rooms.map((r) => r.id));
      await page.goto("/");
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--zoom").trim())).toBe("1.5");
      const side = await drawer(page);
      const codex = groupOf(side, "Codex");
      const name = chats.rooms[0].name;
      await moreOf(codex, name).click();
      await slowGlides(page);
      const was = (await rowOf(codex, name).boundingBox())!;
      await rowOf(codex, name).getByRole("button", { name: "Pin to top", exact: true }).click();
      const pinned = side.getByRole("region", { name: "Pinned", exact: true });
      await expect(rowOf(pinned, name)).toBeVisible();
      const glide = (await glideOf(rowOf(pinned, name)))!;
      expect(glide).not.toBeNull();
      expect(Math.abs(glide.from.y - was.y)).toBeLessThan(1);
      expect(Math.abs(glide.from.x - was.x)).toBeLessThan(1);
      expect(glide.after).toBe("none");
    } finally {
      await chats.cleanup();
    }
  });
});

test.describe("with Reduce Motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing glides, pops or leaves a copy: a row's options and the New chat menu fade in, 150 ms or less", async ({ page, request, token }) => {
    const tag = Math.random().toString(36).slice(2, 6);
    const chats = await made(request, token, [`Alpha ${tag}`, `Bravo ${tag}`, `Charlie ${tag}`]);
    const [alpha, bravo] = chats.rooms.map((r) => r.name);
    try {
      const given = await onlyThese(page, chats.rooms.map((r) => r.id));
      const live = await liveSocket(page);
      await page.goto("/");
      const side = await drawer(page);
      const codex = groupOf(side, "Codex");
      await expect(rowOf(codex, alpha)).toBeVisible();
      await watch(page);

      // News, a reply, a pin, an unpin, a fold, a row's options, the New chat menu.
      live.send({ t: "room", room: { ...given.get(chats.rooms[0].id)!, updatedAt: Date.now() + 5_000, lastReplyAt: Date.now(), readAt: Date.now() - 60_000 } });
      await expect.poll(() => names(codex)).toEqual([alpha, chats.rooms[2].name, bravo]);
      await expect(rowOf(codex, alpha).locator(".reply-dot")).toBeVisible();
      await moreOf(codex, bravo).click();
      await rowOf(codex, bravo).getByRole("button", { name: "Pin to top", exact: true }).click();
      const pinned = side.getByRole("region", { name: "Pinned", exact: true });
      await expect(moreOf(pinned, bravo)).toBeFocused();
      await moreOf(pinned, bravo).click();
      await rowOf(pinned, bravo).getByRole("button", { name: "Unpin", exact: true }).click();
      await expect(pinned).toHaveCount(0);
      await expect(moreOf(codex, bravo)).toBeFocused();
      await codex.getByRole("button", { name: "Hide Codex chats", exact: true }).click();
      await codex.getByRole("button", { name: /^Show Codex chats/ }).click();
      await moreOf(codex, alpha).click();
      await twoFrames(page);
      await page.keyboard.press("Escape");
      await side.getByRole("button", { name: "New chat", exact: true }).click();
      await expect(side.getByRole("menu")).toBeVisible();
      await twoFrames(page);
      await page.keyboard.press("Escape");
      await expect(side.getByRole("menu")).toHaveCount(0);
      await twoFrames(page);

      const seen = await watched(page);
      expect(seen.copies, "no exit copies").toBe(0);
      expect(seen.animations.filter((a) => a.props.some((p) => MOVES.has(p) || LAYOUT.test(p))), "nothing moves").toEqual([]);
      expect(seen.animations.filter((a) => a.repeats), "nothing repeats").toEqual([]);
      expect(seen.animations.filter((a) => a.props.some((p) => !PAINT.test(p))), "only fades").toEqual([]);
      expect(seen.animations.filter((a) => a.ms > 150), "and briefly").toEqual([]);
      expect(seen.animations.filter((a) => a.line !== null), "no line of the list fades either").toEqual([]);
      const what = seen.animations.map((a) => a.what).join(" | ");
      // Each fades in under the name it moves by with motion, so turning the setting on or off never plays it again.
      expect(seen.animations.some((a) => a.what.startsWith("div.csb-row-tray") && a.what.endsWith(" m-drop-in") && a.props.join() === "opacity"), `the options faded in: ${what}`).toBe(true);
      expect(seen.animations.some((a) => a.what.startsWith("div.csb-new-menu") && a.what.endsWith(" csb-menu-in") && a.props.join() === "opacity"), `the menu faded in: ${what}`).toBe(true);
      expect(await rowOf(codex, alpha).locator(".reply-dot").evaluate((el) => el.getAnimations().length)).toBe(0);
    } finally {
      await chats.cleanup();
    }
  });
});
