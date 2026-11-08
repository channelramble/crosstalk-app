import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Approval, Member, Message, Room, Turn } from "@crosstalk/shared";
import { test, expect } from "./fixtures";

/*
 * The chat screen's motion, its menus and Settings' tabs (web/src/styles/motion-chat.css), on a phone (390 px), in each
 * engine, with motion on and with Reduce Motion:
 * - a message that arrives while you follow the chat settles in by scale alone (a reply's words readable from its first
 *   frame), and nothing that comes in ever changes the chat's scroll height, so the chat never moves under you;
 * - the history, and what a chat is opened with, comes in still;
 * - what comes in takes a tap where it is from its first frame (a menu, the status line, Stop), and what closes is gone
 *   at once while an inert copy fades where it was;
 * - only transform and opacity animate (and colour, briefly), and Reduce Motion leaves fades of 150 ms or less.
 * The history and the live events are the test's own (the agent never runs).
 */

const HUB = "http://127.0.0.1:8451";
const LAYOUT = /^(width|height|(min|max)-(width|height)|top|right|bottom|left|inset(-.+)?|margin(-.+)?|padding(-.+)?|border(-(top|right|bottom|left))?-width|font-size|line-height|(row-|column-)?gap|flex(-.+)?|grid(-.+)?|display|position|zoom)$/;
const MOVES = new Set(["transform", "translate", "scale", "rotate"]);
const PAINT = /^(opacity|color|background-color|box-shadow|border(-(top|right|bottom|left))?-color|outline-color)$/;

test.beforeEach(({}, info) => test.skip(!info.project.name.endsWith("-390"), "Once per engine, on a phone (390 px)."));

/** A chat whose history and live events the test writes. */
async function liveChat(page: Page, request: APIRequestContext, token: string, name: string, opts: { steps?: boolean } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name } })).json();
  const snapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  delete member.readSeq;
  let seq = 0;
  const message = (kind: "human" | "agent", text: string, extra: Partial<Message> = {}): Message =>
    ({ id: `mc-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: 1_700_000_000_000 + seq * 1000, updatedAt: 1_700_000_000_000 + seq * 1000, ...extra }) as Message;
  const messages: Message[] = [];
  // With `steps`, each reply has a finished turn with two steps (its list of steps under it).
  const turns: Turn[] = [];
  const activities: Activity[] = [];
  for (let i = 1; i <= 12; i++) {
    messages.push(message("human", `Question ${i}`));
    const at = 1_700_000_000_000 + (seq + 1) * 1000;
    const turnId = opts.steps ? `mc-old-${room.id}-${i}` : null;
    messages.push(message("agent", `Answer ${i}\n\nWith a second paragraph, so the chat is long.`, { turnId }));
    if (!turnId) continue;
    turns.push({ id: turnId, roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: `mc-${seq}`, hop: 0, chainId: turnId, status: "done", error: null, usage: null, createdAt: at, startedAt: at, endedAt: at + 500 });
    for (const k of [1, 2]) activities.push({ id: `${turnId}-${k}`, roomId: room.id, turnId, memberId: member.id, kind: "command", title: `bun test old${i}-${k}`, detail: "12 pass", status: "done", createdAt: at + k, updatedAt: at + k });
  }
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  const readSeq = seq;
  await page.route("**/api/state", (r) => r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, readSeq } : m)) } }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: { room, messages, turns, activities, approvals: [], tasks: {}, totals: null, hasMore: false } }));
  await page.route(`**/api/rooms/${room.id}/asks`, (r) => r.fulfill({ json: [] }));
  const send = (e: unknown) => socket!.send(JSON.stringify(e));
  const turn: Turn = { id: `mc-turn-${room.id}`, roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: `mc-chain-${room.id}`, status: "running", error: null, usage: null, createdAt: Date.now(), startedAt: Date.now(), endedAt: null };
  return {
    room,
    member,
    turn,
    message,
    send,
    /** The agent's status, as the hub would say it. */
    status: (status: Member["status"]) => send({ t: "member", member: { ...member, status, readSeq } }),
    step: (k: number, status: Activity["status"]): Activity => ({ id: `mc-step-${k}`, roomId: room.id, turnId: turn.id, memberId: member.id, kind: "command", title: `bun test part${k}`, detail: status === "done" ? "12 pass" : "", status, createdAt: Date.now() + k, updatedAt: Date.now() + k }),
    cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }),
  };
}

/** Everything that animates from now on (exit copies included), as each frame goes by. */
async function watch(page: Page) {
  await page.evaluate(async () => {
    const { ghosts } = await import("/src/motion.ts");
    type Seen = { what: string; props: string[]; ms: number; repeats: boolean; origin: string };
    const out = { animations: [] as Seen[], copies: 0, errors: [] as string[] };
    (window as unknown as { __motion: typeof out }).__motion = out;
    const known = new WeakSet<Animation>();
    const name = (el: Element | null) => (el ? `${el.localName}${el.getAttribute("class")?.trim() ? `.${el.getAttribute("class")!.trim().split(/\s+/).join(".")}` : ""}` : "?");
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
      const target = effect?.target ?? null;
      out.animations.push({ what: `${name(target)}${effect?.pseudoElement ?? ""} ${label}`, props, ms: Number(timing?.duration) || 0, repeats: timing?.iterations === Infinity, origin: target ? getComputedStyle(target).transformOrigin : "" });
    };
    const frame = () => {
      try {
        for (const a of document.getAnimations()) look(a);
        for (const copy of ghosts()) for (const a of copy.getAnimations({ subtree: true })) look(a);
        out.copies = Math.max(out.copies, document.querySelectorAll("[data-ghost]").length);
      } catch (e) {
        out.errors.push(String(e));
      }
      requestAnimationFrame(frame);
    };
    frame();
  });
}
type Watched = { animations: { what: string; props: string[]; ms: number; repeats: boolean; origin: string }[]; copies: number; errors: string[] };
const watched = async (page: Page) => {
  const seen = await page.evaluate(() => (window as unknown as { __motion: Watched }).__motion);
  expect(seen.errors, "the watch over every frame ran without a hitch").toEqual([]);
  return seen;
};

/**
 * From now on, on every frame: how far the chat's scroll height ever stood past the bottom of what it holds as laid out
 * (a transform reaching past its box would add to it), and whether anything animated the scroller itself.
 */
async function watchScroll(page: Page) {
  await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>(".messages")!;
    const inner = sc.querySelector<HTMLElement>(".inner")!;
    const past = () => sc.scrollHeight - (inner.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop);
    const base = past();
    const out = { grew: 0, scroller: 0 };
    (window as unknown as { __scroll: typeof out }).__scroll = out;
    const frame = () => {
      out.grew = Math.max(out.grew, past() - base);
      if (sc.getAnimations().length) out.scroller++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
const scrollWatch = (page: Page) => page.evaluate(() => (window as unknown as { __scroll: { grew: number; scroller: number } }).__scroll);
const fromBottom = (page: Page) => page.locator(".messages").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** The copy an exit left: inert, hidden from screen readers, no box or role of its own, and closed to selectors. */
const copyOf = (page: Page, kind: string) =>
  page.locator(`[data-ghost="${kind}"]`).first().evaluate((host) => ({
    inert: (host as HTMLElement).inert,
    hidden: host.getAttribute("aria-hidden"),
    role: host.getAttribute("role"),
    taps: getComputedStyle(host).pointerEvents,
    box: getComputedStyle(host).display,
    open: host.shadowRoot === null ? "closed" : "open",
  }));
const AS_A_COPY = { inert: true, hidden: "true", role: null, taps: "none", box: "contents", open: "closed" };

/** The exit copies played to their end at once: they go by themselves. */
const endExits = (page: Page) =>
  page.evaluate(async () => {
    const { ghosts } = await import("/src/motion.ts");
    for (const copy of ghosts()) for (const a of copy.getAnimations({ subtree: true })) a.finish();
  });

/** Where `target` (inside `moving`) is while `moving` is still coming in, and whether a tap there lands on it. */
async function midEntrance(page: Page, moving: string, target: string) {
  const spot = await page.waitForFunction(
    ({ moving, target }) => {
      const box = document.querySelector(moving);
      const el = box?.matches(target) ? box : box?.querySelector(target);
      if (!box || !el || !box.getAnimations().some((a) => a.playState === "running")) return null;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (y < 4 || y > innerHeight - 4 || x < 4 || x > innerWidth - 4) return null;
      return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
    },
    { moving, target },
  );
  return (await spot.jsonValue()) as { x: number; y: number; hit: boolean };
}

/** Whether `selector`'s element is drawn at its own size right now (nothing scales it while it comes in). */
const fullSize = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    return Math.abs(r.height / zoom - (el as HTMLElement).offsetHeight) < 0.5 && Math.abs(r.width / zoom - (el as HTMLElement).offsetWidth) < 0.5;
  });

/** Slows these tokens right down, so a test can act while something is still coming in. */
const slow = (page: Page, tokens: string[]) => page.addStyleTag({ content: `:root { ${tokens.map((t) => `${t}: 60s;`).join(" ")} }` });

/** Lets the chat's first moments pass (what's drawn with it comes in still; only what arrives later moves). */
const settled = (page: Page) => page.waitForTimeout(500);

const noLayout = (seen: Watched) => seen.animations.filter((a) => a.props.some((p) => LAYOUT.test(p)));
/** The CSS animation an element plays (as its style says, whenever it's asked) and for how long. */
const playing = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => `${getComputedStyle(el).animationName} ${getComputedStyle(el).animationDuration}`);

test.describe("with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("a message arriving settles in (yours from its corner, a reply's avatar pops), the history comes in still, and the chat's scroll never moves", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: arriving");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await watch(page);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await settled(page);
      // The history came in as it is: no message moved.
      expect((await watched(page)).animations.filter((a) => /^div\.msg[. ]/.test(a.what))).toEqual([]);
      await expect(page.locator(".m-arrive")).toHaveCount(0);
      await watchScroll(page);
      // Two seconds instead of a third of one, so every frame of it is seen here.
      await page.addStyleTag({ content: ":root { --dur-enter: 2s; }" });

      // Your message from another device, then the reply starting and streaming in.
      const mine = c.message("human", "Question 13");
      c.send({ t: "message", message: mine });
      await expect(page.locator(".msg.human.m-arrive")).toHaveCount(1);
      const reply = c.message("agent", "", { status: "streaming" });
      c.send({ t: "message", message: reply });
      await expect(page.locator(".msg.agent.m-arrive")).toHaveCount(1);
      // Its words are there from its first frame (nothing moves or fades them): only its avatar pops in.
      const text = "The reply streams in, word by word, and nothing ever fades or types it in.";
      for (let at = 0; at < text.length; at += 12) {
        c.send({ t: "message.delta", messageId: reply.id, roomId: c.room.id, delta: text.slice(at, at + 12), offset: at });
        await page.waitForTimeout(30);
      }
      await expect(page.locator(".msg.agent").last()).toContainText("nothing ever fades");
      c.send({ t: "message", message: { ...reply, text, status: "done" } });
      await expect.poll(() => fromBottom(page)).toBeLessThanOrEqual(1);

      const scroll = await scrollWatch(page);
      expect(scroll.grew, "nothing that came in reached past its box (the scroll height never grew)").toBeLessThanOrEqual(1.5);
      expect(scroll.scroller, "the scroller itself never moved").toBe(0);
      const seen = await watched(page);
      expect(noLayout(seen), "nothing animates a layout property").toEqual([]);
      const messages = seen.animations.filter((a) => /^div\.msg[. ]/.test(a.what));
      expect(messages.map((a) => a.what.split(" ").pop()), "only yours moved, by scale alone (nothing in it to tap)").toEqual(["m-settle-mine"]);
      expect(messages[0].props).toEqual(["scale"]);
      expect(messages[0].ms).toBe(2000);
      // From the corner by the message box.
      expect(messages[0].origin).toMatch(/^\d+(\.\d+)?px \d+(\.\d+)?px/);
      const avatar = seen.animations.filter((a) => a.what.startsWith("div.avatar") && a.what.endsWith("m-avatar-in"));
      expect(avatar.length, "the reply's avatar popped in").toBe(1);
      // Drawn again once it has settled (here, a second after it came), it stays as it is: the mark is gone.
      await page.waitForTimeout(1100);
      c.send({ t: "message", message: { ...reply, text: `${text} Again.`, status: "done" } });
      await expect(page.locator(".msg.agent").last()).toContainText("Again.");
      await expect(page.locator(".m-arrive")).toHaveCount(0);
      expect((await watched(page)).animations.filter((a) => /^div\.msg[. ]/.test(a.what)).length).toBe(1);
    } finally {
      await c.cleanup();
    }
  });

  test("the status line comes up above the message box, its steps drop in under it, and cards come in under a reply", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: at work");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await settled(page);
      await watch(page);
      await watchScroll(page);
      await slow(page, ["--dur-enter", "--dur-fade"]);
      // The agent starts: the line comes up out of the message box, and takes a tap where it is from its first frame.
      c.send({ t: "turn", turn: c.turn });
      c.status("working");
      const line = page.locator("button.chat-status");
      await expect(line).toBeVisible();
      const tap = await midEntrance(page, "button.chat-status", "button.chat-status");
      expect(tap.hit, "a tap on the status line while it comes in lands on it").toBe(true);
      expect(await fullSize(page, "button.chat-status"), "it's its full size while it comes in").toBe(true);
      // The box above the message box scrolls: the line coming up never makes it scroll.
      expect(await page.locator(".composer-work").evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
      await page.mouse.click(tap.x, tap.y);
      await expect(line).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".chat-trace")).toBeVisible();
      // A step coming in while it's open (past its own first moments) fades in.
      await settled(page);
      c.send({ t: "activity", activity: c.step(1, "running") });
      await expect(page.locator(".chat-trace .trace-step")).toHaveCount(1);
      // The reply arrives with its steps, then a question for you.
      const reply = c.message("agent", "Working on it.", { status: "streaming", turnId: c.turn.id });
      c.send({ t: "message", message: reply });
      c.send({ t: "activity", activity: c.step(2, "running") });
      await expect(page.locator(".msg.agent .activity")).toBeVisible();
      const approval: Approval = { id: "mc-approval", roomId: c.room.id, memberId: c.member.id, turnId: c.turn.id, kind: "command", title: "rm -rf build", detail: "rm -rf build", status: "pending", decision: null, decidedBy: null, createdAt: Date.now(), decidedAt: null, always: null };
      c.send({ t: "approval", approval });
      const card = page.locator(".messages .approval");
      await expect(card).toBeVisible();
      // Its buttons take a tap where they are while it comes in.
      const approve = await midEntrance(page, ".messages .m-drop", ".a-actions .btn.primary");
      expect(approve.hit, "a tap on Approve while its card comes in lands on it").toBe(true);
      expect(await fullSize(page, ".messages .m-drop .a-actions .btn.primary"), "Approve is a finger's size while its card comes in").toBe(true);
      // Closing the steps (the line is still coming up, a minute here, and moved up as they opened): gone at once, the
      // chevron turns back.
      await line.click({ force: true });
      await expect(page.locator(".chat-trace")).toHaveCount(0);
      // Done: the line goes at once (nothing left over the chat).
      c.send({ t: "message", message: { ...reply, status: "done" } });
      c.send({ t: "approval", approval: { ...approval, status: "denied", decidedAt: Date.now() } });
      c.status("idle");
      await expect(line).toHaveCount(0);
      // Only Stop's copy (Send and Stop swap places, below): nothing of the line or its steps is left over the chat.
      await expect(page.locator("[data-ghost]")).toHaveCount(0);

      const seen = await watched(page);
      expect(noLayout(seen), "nothing animates a layout property").toEqual([]);
      expect(seen.animations.some((a) => a.what.startsWith("button.chat-status") && a.what.endsWith("m-drop-in")), "the line came in").toBe(true);
      expect(seen.animations.some((a) => a.what.startsWith("div.chat-trace") && a.what.endsWith("m-drop-in")), "its steps dropped in").toBe(true);
      expect(seen.animations.some((a) => a.what.startsWith("div.trace-step") && a.what.endsWith("m-fade-in")), "a new step faded in").toBe(true);
      expect(seen.animations.some((a) => a.what.startsWith("svg") && a.what.includes("chat-status-chevron") && a.props.includes("transform")), "the chevron turned").toBe(true);
      expect(seen.animations.some((a) => a.what.startsWith("div.m-drop") && a.what.endsWith("m-drop-in")), "the request came in").toBe(true);
      expect(seen.animations.some((a) => a.what.startsWith("details.activity") && a.what.endsWith("m-fade-in")), "the reply's steps came in").toBe(true);
      // Whatever holds something to tap comes in at its full size: it slides and fades, it never scales (a press, while
      // held, is another matter).
      for (const a of seen.animations.filter((a) => /m-drop|m-menu-in|chat-trace|send-now|helpers/.test(a.what) && !a.what.endsWith(" transition"))) expect(a.props, a.what).not.toContain("scale");
      const scroll = await scrollWatch(page);
      expect(scroll.grew, "nothing that came in reached past its box").toBeLessThanOrEqual(1.5);
      expect(scroll.scroller).toBe(0);
    } finally {
      await c.cleanup();
    }
  });

  test("a menu rises out of its row at its full size and takes taps at once; closed, it's gone and an inert copy fades", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: a menu");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await watch(page);
      await slow(page, ["--dur-menu-in", "--dur-menu-out"]);
      const opener = page.getByRole("button", { name: /^Permissions:/ });
      await opener.click();
      const menu = page.getByRole("dialog", { name: "Permissions", exact: true });
      await expect(menu).toBeVisible();
      // Rising out of its row (a minute here), its choices a finger's size all the way, and where a tap lands meanwhile.
      expect(await playing(page, ".ctl-pop")).toBe("m-menu-in 60s");
      const item = await midEntrance(page, ".ctl-pop", "button");
      expect(item.hit, "a tap on a choice while the menu comes in lands on it").toBe(true);
      expect(await fullSize(page, ".ctl-pop"), "the menu is its full size while it comes in").toBe(true);
      expect((await menu.getByRole("menuitemradio").first().boundingBox())!.height, "a choice is a finger's size while the menu comes in").toBeGreaterThanOrEqual(44);
      // Escape: gone at once, while its copy fades; the copy is out of everyone's reach.
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-ghost="menu"]')).toHaveCount(1);
      expect(await menu.count()).toBe(0);
      expect(await page.locator(".ctl-pop").count()).toBe(0);
      expect(await copyOf(page, "menu")).toEqual(AS_A_COPY);
      expect(await page.evaluate(async () => (await import("/src/motion.ts")).ghosts().map((g) => getComputedStyle(g).animationName)), "its copy fades").toEqual(["m-menu-out"]);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // The message box, under the leaving copy, takes the tap.
      const box = page.getByRole("textbox", { name: "Message", exact: true });
      await box.click();
      await expect(box).toBeFocused();
      await endExits(page);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);

      expect(noLayout(await watched(page))).toEqual([]);
    } finally {
      await c.cleanup();
    }
  });

  test("Send and Stop take each other's place: each is its full size from its first frame, and the one that goes leaves a fading copy", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: send and stop");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await settled(page);
      await watch(page);
      const send = page.getByRole("button", { name: "Send", exact: true });
      await expect(send).toBeDisabled();
      const box = page.getByRole("textbox", { name: "Message", exact: true });
      // Something to send: Send's arrow pops; the button itself stays put, a finger's size.
      await box.fill("hello");
      await expect(send).toBeEnabled();
      expect(await playing(page, ".composer .send .m-ready")).toBe("m-pop-in 0.42s");
      const size = (await send.boundingBox())!;
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(44);
      // The agent starts: Stop comes in beside it, its full size at once.
      c.status("working");
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await expect(stop).toBeVisible();
      expect(await playing(page, ".composer .send.stop"), "Stop fades in: its size never changes").toBe("m-fade-in 0.15s");
      expect(await playing(page, ".composer .send.stop > svg"), "its icon pops").toBe("m-pop-in 0.42s");
      const stopSize = (await stop.boundingBox())!;
      expect(Math.min(stopSize.width, stopSize.height)).toBeGreaterThanOrEqual(44);
      // Nothing left to send while it works: Send goes at once and its copy fades.
      await box.fill("");
      await expect(send).toHaveCount(0);
      await expect(page.locator('[data-ghost="menu"]')).toHaveCount(1);
      expect(await copyOf(page, "menu")).toEqual(AS_A_COPY);
      // Done: Stop goes the same way, and Send is back.
      c.status("idle");
      await expect(stop).toHaveCount(0);
      await expect(send).toBeVisible();
      await endExits(page);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);

      expect(await playing(page, ".composer .send"), "Send came back the same way").toBe("m-fade-in 0.15s");
      const seen = await watched(page);
      expect(noLayout(seen)).toEqual([]);
      for (const a of seen.animations.filter((a) => a.what.startsWith("button.send") && !a.what.endsWith("m-menu-out") && !a.what.endsWith("transition"))) expect(a.props, "the buttons themselves only fade: their size never changes").toEqual(["opacity"]);
    } finally {
      await c.cleanup();
    }
  });

  test("an attachment comes in, and one taken off leaves a fading copy while the others close up", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: attachments");
    let n = 0;
    await page.route(`**/api/rooms/${c.room.id}/uploads**`, (r) => r.fulfill({ json: { filename: `f${++n}.txt`, name: `f${n}.txt`, path: `/tmp/f${n}.txt`, size: 5, mimeType: "text/plain", url: `/u/f${n}.txt` } }));
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await watch(page);
      await settled(page);
      // Two seconds each, so every frame of them is seen here (the chips are tapped while they move: where they are).
      await page.addStyleTag({ content: ":root { --dur-fade: 2s; --dur-flip: 2s; --dur-menu-out: 2s; }" });
      const pick = page.locator('input[aria-label="Choose attachments"]');
      await pick.setInputFiles([{ name: "one.txt", mimeType: "text/plain", buffer: Buffer.from("one") }]);
      const chips = page.getByLabel("Attachments", { exact: true });
      await expect(chips).toContainText("one.txt");
      await pick.setInputFiles([{ name: "two.txt", mimeType: "text/plain", buffer: Buffer.from("two") }]);
      await expect(chips).toContainText("two.txt");
      // It fades in at its full size: its Remove is a finger's size from its first frame.
      const second = chips.locator(".composer-file").filter({ hasText: "two.txt" });
      expect(await second.evaluate((el) => `${getComputedStyle(el).animationName} ${getComputedStyle(el).animationDuration}`)).toBe("m-fade-in 2s");
      expect((await second.getByRole("button", { name: "Remove two.txt", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: "Remove one.txt", exact: true }).click({ force: true });
      await expect(chips).not.toContainText("one.txt");
      await expect(page.locator('[data-ghost="row"]')).toHaveCount(1);
      expect(await copyOf(page, "row")).toEqual(AS_A_COPY);
      await endExits(page);
      // The last one off: the row goes with it, no copy over the chat.
      await page.getByRole("button", { name: "Remove two.txt", exact: true }).click({ force: true });
      await expect(chips).toHaveCount(0);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);

      const seen = await watched(page);
      expect(noLayout(seen)).toEqual([]);
      expect(seen.animations.some((a) => a.what.startsWith("div.composer-file") && a.what.endsWith("script") && a.props.includes("transform") && !a.props.includes("opacity")), "the other closed up").toBe(true);
    } finally {
      await c.cleanup();
    }
  });

  test("a message's actions drop a touch as they show, and take a tap at once", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: actions");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await watch(page);
      await slow(page, ["--dur-enter"]);
      await page.getByText("Question 12", { exact: true }).click();
      const actions = page.locator(".your-msg.open .msg-actions");
      const edit = actions.getByRole("button", { name: "Edit", exact: true });
      await expect(edit).toBeVisible();
      // Still dropping (a minute here), and Edit is where a tap lands (asked in one go: the chat follows its newest line,
      // so the row moving up a moment later is the chat's own, not the motion's).
      const now = await actions.evaluate((row) => {
        const button = [...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit")!;
        const r = button.getBoundingClientRect();
        return { moving: row.getAnimations().map((a) => String((a as CSSTransition).transitionProperty)), hit: button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
      });
      expect(now.moving, "they drop a touch as they show").toContain("translate");
      expect(now.hit, "a tap on Edit while they drop lands on it").toBe(true);
      const seen = await watched(page);
      expect(noLayout(seen)).toEqual([]);
    } finally {
      await c.cleanup();
    }
  });

  test("a chat catching up never draws its replies again: what it gives the parts under it stays the same", async ({ page, request, token }) => {
    // React's own hook for developer tools, told of every commit: which components drew in it (not those React skipped,
    // as the memo on each message lets it).
    await page.addInitScript(() => {
      const drew = new Map<string, number>();
      (window as unknown as { __drew: typeof drew }).__drew = drew;
      type Fiber = { tag: number; type: { name?: string; displayName?: string } | null; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
      const COMPONENTS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
      const count = (f: Fiber) => {
        const name = COMPONENTS.has(f.tag) ? (f.type?.displayName ?? f.type?.name) : undefined;
        if (name) drew.set(name, (drew.get(name) ?? 0) + 1);
      };
      const mounted = (first: Fiber | null) => {
        for (let f = first; f; f = f.sibling) {
          count(f);
          mounted(f.child);
        }
      };
      const walk = (next: Fiber, prev: Fiber) => {
        if (next.child === prev.child) return; // nothing under it drew
        for (let f = next.child; f; f = f.sibling) {
          if (!f.alternate) {
            count(f);
            mounted(f.child);
            continue;
          }
          if (COMPONENTS.has(f.tag) && f.flags & 1) count(f); // PerformedWork: it drew, rather than bailing out
          walk(f, f.alternate);
        }
      };
      (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        isDisabled: false,
        renderers: new Map(),
        inject(this: { renderers: Map<number, unknown> }, renderer: unknown) {
          const id = this.renderers.size + 1;
          this.renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          if (root.current.alternate) walk(root.current, root.current.alternate);
          else mounted(root.current);
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {},
      };
    });
    const c = await liveChat(page, request, token, "Motion: catching up", { steps: true });
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.locator(".msg.agent .activity")).toHaveCount(12);
      await settled(page);
      const drew = () => page.evaluate(() => (window as unknown as { __drew: Map<string, number> }).__drew.get("ActivityBlock") ?? 0);
      expect(await drew(), "the hook sees the chat draw").toBeGreaterThanOrEqual(12);
      // The chat drawn twice more: its settings opened and closed.
      const twice = async () => {
        await page.getByRole("button", { name: "Chat settings", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Chat settings", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      };
      let before = await drew();
      await twice();
      expect(await drew(), "with the chat steady, no reply's steps drew again").toBe(before);
      // The same while it catches up (the hub syncing, as after a phone wakes): each part decided once whether it comes
      // in, and a redraw of the chat meanwhile is no reason to draw them again.
      await page.evaluate(async () => (await import("/src/store.ts")).useStore.setState({ syncing: true }));
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      before = await drew();
      await twice();
      expect(await drew(), "with the chat catching up, no reply's steps drew again").toBe(before);
      await page.evaluate(async () => (await import("/src/store.ts")).useStore.setState({ syncing: false }));
    } finally {
      await c.cleanup();
    }
  });

  test("turning Reduce Motion on or off plays nothing again: what came in stays as it is", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: setting changed");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await settled(page);
      // CSS animations running that end (spinners and pulses go round for ever, and simply start again).
      const entrances = () =>
        page.evaluate(() =>
          document
            .getAnimations()
            .filter((a) => "animationName" in a && a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => `${(a as CSSAnimation).animationName} on ${(a.effect as KeyframeEffect).target?.getAttribute("class") ?? "?"}`),
        );
      const flip = async () => {
        for (const setting of ["reduce", "no-preference"] as const) {
          await page.emulateMedia({ reducedMotion: setting });
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          expect(await entrances(), `turned ${setting === "reduce" ? "on" : "off"}, nothing came in again`).toEqual([]);
        }
      };
      // A message of yours arrives: it settles in, and its mark comes off by itself a second later (nothing else draws
      // the chat meanwhile), so it can't be played again.
      c.send({ t: "message", message: c.message("human", "Question 13") });
      await expect(page.locator(".msg.human.m-arrive")).toHaveCount(1);
      await expect(page.locator(".m-arrive")).toHaveCount(0, { timeout: 2500 });
      // The agent starts: the status line drops in, Stop takes Send's place and its icon pops; a sheet comes up; a
      // notice comes, and again (its count pops).
      c.send({ t: "turn", turn: c.turn });
      c.status("working");
      await expect(page.locator("button.chat-status")).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Chat settings", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Chat settings", exact: true })).toBeVisible();
      const toast = () => page.evaluate(async () => (await import("/src/store.ts")).useStore.getState().toast("info", "Motion check: the setting."));
      await toast();
      await toast();
      await expect(page.locator(".toast-count")).toHaveText("×2");
      await expect.poll(entrances, { message: "everything is in" }).toEqual([]);
      await flip();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // Settings: the tab you went to came in from its side; it stays.
      await page.goto("/#/settings");
      await expect(page.getByRole("tabpanel", { name: "Agents", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Machines", exact: true }).click();
      await expect(page.locator(".page-inner")).toHaveClass(/m-tab-next/);
      await expect.poll(entrances, { message: "the tab is in" }).toEqual([]);
      await flip();
    } finally {
      await c.cleanup();
    }
  });

  test("Settings: the tab you go to comes in from its side, Settings' first draw is still, and nothing ever sticks out sideways", async ({ page }) => {
    await page.goto("/#/settings");
    await expect(page.getByRole("tabpanel", { name: "Agents", exact: true })).toBeVisible();
    await watch(page);
    await expect(page.locator(".page-inner")).not.toHaveClass(/m-tab/);
    const sideways = () => page.evaluate(() => {
      const p = document.querySelector<HTMLElement>(".page")!;
      return { page: p.scrollWidth - p.clientWidth, left: p.scrollLeft, doc: document.documentElement.scrollWidth - innerWidth };
    });
    await page.getByRole("tab", { name: "Machines", exact: true }).click();
    // The new tab's panel has the focus at once, while its settings come in.
    await expect(page.getByRole("tabpanel", { name: "Machines", exact: true })).toBeFocused();
    await expect(page.locator(".page-inner")).toHaveClass(/m-tab-next/);
    expect(await playing(page, ".page-inner")).toBe("m-tab-next 0.18s");
    for (let i = 0; i < 6; i++) {
      expect(await sideways(), "nothing sticks out sideways while it comes in").toEqual({ page: 0, left: 0, doc: 0 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await page.getByRole("tab", { name: "Agents", exact: true }).click();
    await expect(page.locator(".page-inner")).toHaveClass(/m-tab-back/);
    expect(await playing(page, ".page-inner")).toBe("m-tab-back 0.18s");
    // A section linked from elsewhere lands in its tab, with nothing moved sideways after.
    await page.goto("/#/settings/storage");
    await expect(page.getByRole("heading", { name: "Storage", exact: true }).first()).toBeInViewport();
    expect(await sideways()).toEqual({ page: 0, left: 0, doc: 0 });

    const seen = await watched(page);
    expect(noLayout(seen)).toEqual([]);
    for (const a of seen.animations.filter((a) => a.what.includes("m-tab"))) expect(a.ms).toBeLessThanOrEqual(200);
  });
});

test.describe("with Reduce Motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing moves on the chat screen, in its menus or in Settings: fades of 150 ms or less, no copies", async ({ page, request, token }) => {
    const c = await liveChat(page, request, token, "Motion: reduced chat");
    try {
      await page.goto(`/#/room/${c.room.id}`);
      await expect(page.getByText("Answer 12", { exact: true })).toBeVisible();
      await settled(page);
      await watch(page);
      await watchScroll(page);
      // A message of yours and a reply arrive; the agent works, its steps open and a request comes in.
      c.send({ t: "message", message: c.message("human", "Question 13") });
      const reply = c.message("agent", "", { status: "streaming", turnId: c.turn.id });
      c.send({ t: "turn", turn: c.turn });
      c.status("working");
      c.send({ t: "message", message: reply });
      c.send({ t: "activity", activity: c.step(1, "running") });
      await expect(page.locator("button.chat-status")).toBeVisible();
      // It fades in under the name it drops in by with motion, so turning the setting on or off never plays it again.
      expect(await playing(page, "button.chat-status"), "the status line fades in").toBe("m-drop-in 0.15s");
      await page.locator("button.chat-status").click();
      await expect(page.locator(".chat-trace")).toBeVisible();
      c.send({ t: "activity", activity: c.step(2, "running") });
      c.send({ t: "approval", approval: { id: "mc-approval-r", roomId: c.room.id, memberId: c.member.id, turnId: c.turn.id, kind: "command", title: "ls", detail: "ls", status: "pending", decision: null, decidedBy: null, createdAt: Date.now(), decidedAt: null, always: null } });
      await expect(page.locator(".messages .approval")).toBeVisible();
      // A menu, open and closed; Stop and Send swapping.
      await page.getByRole("button", { name: /^Permissions:/ }).click();
      await expect(page.getByRole("dialog", { name: "Permissions", exact: true })).toBeVisible();
      expect(await playing(page, ".ctl-pop"), "the menu fades in").toBe("m-menu-in 0.15s");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      c.send({ t: "message", message: { ...reply, text: "Done.", status: "done" } });
      c.status("idle");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("hello");
      // A message's actions.
      await page.getByText("Question 12", { exact: true }).click();
      await expect(page.locator(".your-msg.open").getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

      const seen = await watched(page);
      expect(seen.copies, "no exit copies under Reduce Motion").toBe(0);
      expect(seen.animations.filter((a) => a.props.some((p) => MOVES.has(p) || LAYOUT.test(p))), "nothing moves").toEqual([]);
      expect(seen.animations.filter((a) => a.repeats), "nothing repeats").toEqual([]);
      expect(seen.animations.filter((a) => a.props.some((p) => !PAINT.test(p))), "only fades and colour").toEqual([]);
      expect(seen.animations.filter((a) => a.ms > 150), "and briefly").toEqual([]);
      expect(seen.animations.filter((a) => /^div\.msg[. ]/.test(a.what)), "messages simply appear: a reply's words never fade").toEqual([]);
      const scroll = await scrollWatch(page);
      expect(scroll.grew).toBeLessThanOrEqual(1.5);
      expect(scroll.scroller).toBe(0);
    } finally {
      await c.cleanup();
    }
  });

  test("Settings' next tab fades in, without moving", async ({ page }) => {
    await page.goto("/#/settings");
    await expect(page.getByRole("tabpanel", { name: "Agents", exact: true })).toBeVisible();
    await watch(page);
    await page.getByRole("tab", { name: "Usage", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Usage", exact: true })).toBeFocused();
    expect(await playing(page, ".page-inner")).toBe("m-tab-next 0.15s");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const seen = await watched(page);
    expect(seen.animations.filter((a) => a.props.some((p) => !PAINT.test(p)) || a.ms > 150)).toEqual([]);
  });
});
