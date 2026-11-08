import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { MacDialog, Member, Message, Room, StateSnapshot, Turn } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

/*
 * Reliability and accessibility polish: what a phone sees while the hub is away, says no, or says nothing, and what a
 * keyboard and a screen reader get out of it.
 *
 * EVERY TEST IN THIS FILE IS EXPECTED TO FAIL on today's code (0.6.1). Each one says why in its own comment, with the
 * line that produces the behaviour. Run them with the widths that matter:
 *   --project chromium-320 --project chromium-390 --project webkit-390 --project chromium-1440
 * The two about layout order and touch size matter at every width (320 to 1440); the rest are the same everywhere, so
 * one phone width is enough to see them.
 */

const hub = "http://127.0.0.1:8451";

/**
 * A real chat whose agent is at work on a streaming reply, with the hub's state, history and socket played by the test:
 * `control` makes the hub refuse the socket, fail or hold the history, fail /api/state, or stop knowing this device's
 * token. `input` is every keystroke the hub was sent for a terminal.
 */
async function liveChat(page: Page, request: APIRequestContext, token: string, name: string, extra: Partial<StateSnapshot> = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "codex", name } })).json();
  const snapshot: StateSnapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: Member) => m.roomId === room.id)!;
  const at = Date.now() - 20_000;
  const ask = { id: "p-1", seq: 1, roomId: room.id, authorKind: "human", authorName: "Phone", memberId: null, mentions: [], turnId: null, text: "Write the tests", status: "done", createdAt: at, updatedAt: at } as Message;
  const reply = { id: "p-2", seq: 2, roomId: room.id, authorKind: "agent", authorName: member.handle, memberId: member.id, mentions: [], turnId: "p-turn", text: "Writing the first test", status: "streaming", createdAt: at + 1000, updatedAt: at + 1000 } as Message;
  const turn = { id: "p-turn", roomId: room.id, memberId: member.id, triggerMessageId: ask.id, replyMessageId: reply.id, hop: 0, chainId: "p-turn", origin: "human", status: "running", error: null, usage: null, createdAt: at, startedAt: at, endedAt: null } as Turn;
  const counts = { state: 0, history: 0, pings: 0 };
  const control = { refusing: false, unauthorized: false, stateStatus: 0, historyError: "", historyGate: undefined as Promise<void> | undefined };
  const sockets: WebSocketRoute[] = [];
  const input: string[] = [];
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    sockets.push(ws);
    if (control.refusing) return ws.close({ code: 1011 });
    ws.onMessage((data) => {
      const e = JSON.parse(String(data)) as { t: string; data?: string };
      if (e.t === "ping") {
        counts.pings++;
        ws.send(JSON.stringify({ t: "pong" }));
      }
      if (e.t === "pty.input") input.push(String(e.data ?? ""));
    });
  });
  await page.route("**/api/state", (route) => {
    counts.state++;
    if (control.stateStatus) return route.fulfill({ status: control.stateStatus, json: { error: "The hub is busy." } });
    return route.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, status: "working", readSeq: 1 } : m)), ...extra } });
  });
  await page.route(`**/api/rooms/${room.id}/history**`, async (route) => {
    counts.history++;
    if (control.historyGate) await control.historyGate;
    if (control.historyError) return route.fulfill({ status: 503, json: { error: control.historyError } });
    return route.fulfill({ json: { room, messages: [ask, reply], turns: [turn], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } });
  });
  // Added last, so it is asked first: a token the hub no longer knows (this device was signed out elsewhere).
  await page.route("**/api/**", (route) => (control.unauthorized ? route.fulfill({ status: 401, json: { error: "unauthorized" } }) : route.fallback()));
  return {
    room,
    member,
    counts,
    sockets,
    control,
    input,
    hubName: snapshot.hub.name as string,
    /** The connection drops, as a hub restart or a sleeping phone does; the next try succeeds unless `refuse`. */
    drop: () => sockets.at(-1)?.close({ code: 1001 }),
    refuse(on: boolean) {
      control.refusing = on;
      if (on) sockets.at(-1)?.close({ code: 1011 });
    },
    cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }),
  };
}

test("a device signed out on another device is told so, not left saying it can't reach the hub", async ({ page, request, token }) => {
  // EXPECTED TO FAIL. The hub closes a revoked device's socket (hub/src/server.ts `allowed`: close 1008 "This device
  // has been signed out.") and then refuses its /api/ws upgrade. web/src/api.ts Live.onclose ignores the close code and
  // just retries, and hubStore.ts only learns of a 401 inside refresh(), which runs only when the socket reports
  // "open". So nothing ever asks the hub again over HTTP: hooks.signedOut() (hubStore.ts:656, its only call site) is
  // never reached and the phone shows "Can't reach <machine>. Trying again…" — and, after 20 s, "Check that Tailscale
  // is on." — for as long as the app is open. A reload is the only way to find out.
  await page.setViewportSize({ width: 390, height: 844 });
  // Named so that nothing on the chat screen itself can match the words the test looks for.
  const c = await liveChat(page, request, token, "Revoked token");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    // Signed out from the Mac: the hub drops this device's socket and stops knowing its token.
    c.control.unauthorized = true;
    c.refuse(true);
    await expect(page.getByText(/signed out|no longer paired/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".conn-strip.down")).toHaveCount(0);
  } finally {
    await c.cleanup();
  }
});

test("a chat on a machine that stopped answering says so, instead of Chat not found", async ({ page, token }) => {
  // EXPECTED TO FAIL. App.tsx:206-207 works out "still loading" and "can't be reached" from `loadedAt === null`, so a
  // machine that answered earlier in this session and has since gone down counts as neither: `unreachable` is empty,
  // `loading` is false, and ChatPending falls through to "Chat not found … or it's on a machine this phone hasn't
  // added" (App.tsx:237-249) with no Try now. Opening a chat made on the Linux box while it was away — from its
  // notification, relayed by the Mac — then blames the phone's pairing for a chat that is simply out of reach.
  await page.setViewportSize({ width: 390, height: 844 });
  // Both machines' live connections are played here: a real one through the dev server's ws proxy drops at teardown,
  // and Playwright's own WebSocket stand-in then throws in the page (as polish-machines.spec.ts and screens.spec.ts do).
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const linux = await otherMachine(page, token, { port: 8491, rooms: [] });
  await page.goto("/#/");
  // Both machines have answered once: the Linux box's chats are in.
  await expect.poll(() => linux.sockets(), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  // Then it stops answering: its next try is refused too, so the app knows it is down.
  const tries = linux.sockets();
  linux.refuse(true);
  await expect.poll(() => linux.sockets(), { timeout: 10_000 }).toBeGreaterThan(tries);
  // A chat made on it while it was away, opened from its notification (no reload: that would be a fresh app, which
  // has never heard from the Linux box and so says the right thing already).
  await page.evaluate(() => { location.hash = "#/room/r_made_while_away"; });
  const screen = page.locator(".chat-pending");
  await expect(screen).toContainText(/Can't reach Linux box/);
  await expect(screen.getByRole("button", { name: "Try now", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat not found", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test("the connection and Mac strips come after the screen's header for a keyboard and a reader", async ({ page, request, token }) => {
  // EXPECTED TO FAIL. The strips are drawn under the header with CSS order (styles.css:2131-2136 `.main > .topbar
  // { order: -2 }`, `.main > .conn-strip { order: -1 }`) but App.tsx:99-101 puts them before the screen in the DOM.
  // Tab order and reading order follow the DOM, so "Try now" and the Mac strip's "Details" come before the back
  // button, the chat's title and its settings — a keyboard lands on them first, and a reader hears them before the
  // title of the screen it is on (WCAG 1.3.2, 2.4.3). It matters at every width: --project chromium-320 … -1440.
  const dialog: MacDialog = { id: "d1", app: "adb", wants: "files on external drives", since: Date.now() - 60_000, count: 1, stoppable: true };
  const c = await liveChat(page, request, token, "Order on screen", { macDialogs: [dialog] });
  try {
    await page.goto(`/#/room/${c.room.id}`);
    const strip = page.locator(".mac-strip");
    await expect(strip).toBeVisible();
    // Drawn below the header…
    const header = (await page.locator(".topbar").boundingBox())!;
    expect((await strip.boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    // …so it must come after it in the DOM too, or the keyboard goes there first.
    const headerFirst = await page.evaluate(() => {
      const top = document.querySelector(".topbar");
      const strip = document.querySelector(".main > .conn-strip");
      if (!top || !strip) return null;
      return !!(top.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(headerFirst, "the header must come before the strips in the DOM, as it is on screen").toBe(true);
    // So the first control a keyboard reaches on this screen is in its header, not in a strip below it.
    const firstIsInHeader = await page.evaluate(() => {
      const focusable = [...document.querySelectorAll<HTMLElement>(".main button, .main a[href], .main input, .main textarea, .main select")];
      const first = focusable.find((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && !!el.offsetParent);
      return first ? !!first.closest(".topbar") : null;
    });
    expect(firstIsInHeader, "the first control in the screen must be the header's, not the strip's").toBe(true);
  } finally {
    await c.cleanup();
  }
});

test("with reduced motion asked for, nothing in a working chat keeps spinning or blinking", async ({ page, request, token }) => {
  // EXPECTED TO FAIL. styles.css honours prefers-reduced-motion for some live things (.csb-dot.busy:3016,
  // .working-thought.live > svg:2290, .upload-bar:2432) but not for the ones a working chat is full of: `.spin`
  // (styles.css:938, every loader, including the status line's), the streaming caret `.cursor::after` (795, `blink`
  // forever) and the agent's avatar dot `.avatar .state.working` (620, `pulse` forever). A phone set to reduce motion
  // still gets three things moving without end on the chat screen.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const c = await liveChat(page, request, token, "Reduced motion");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    await expect(page.locator(".msg.agent .cursor")).toBeVisible();
    await expect(page.locator(".chat-status")).toBeVisible();
    const moving = await page.evaluate(() => {
      const out: string[] = [];
      const look = (el: Element | null, where: string, pseudo?: string) => {
        if (!el) return;
        const name = getComputedStyle(el, pseudo).animationName;
        if (name && name !== "none") out.push(`${where}: ${name}`);
      };
      look(document.querySelector(".chat-status .spin"), ".chat-status .spin");
      look(document.querySelector(".msg.agent .cursor"), ".cursor::after", "::after");
      look(document.querySelector(".avatar .state.working, .avatar .state.thinking"), ".avatar .state");
      return out;
    });
    expect(moving, "with reduced motion asked for, nothing may animate forever").toEqual([]);
  } finally {
    await c.cleanup();
  }
});

test("a connection that comes back in under a second never raises the red alarm", async ({ page, request, token }) => {
  // EXPECTED TO FAIL. hubStore.ts sets `downSince` on the first "closed" status, and App.tsx's ConnStrip shows the red
  // "Can't reach <machine>. Trying again…" the moment `downSince` is set (App.tsx:304, 316) — unlike "Connecting…"
  // (held back 1 s by `Later`) and "Getting the latest…" (held back SLOW_SYNC_MS). Every hub restart, including the
  // idle-restart watcher's, and every brief Tailscale blip therefore flashes a red alarm on the phone and shifts the
  // whole screen down and back up (the strip is in the flex flow), for a connection that was back in 500 ms.
  await page.setViewportSize({ width: 390, height: 844 });
  const c = await liveChat(page, request, token, "Short blip");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    const before = c.sockets.length;
    c.drop();
    // The first try waits 500-800 ms: nothing may be said while it is this quick. Counted, not awaited: a strip that
    // comes and goes must still fail this.
    for (let i = 0; i < 12; i++) {
      expect(await page.locator(".conn-strip.down").count(), `a red alarm ${i * 50} ms into a blip`).toBe(0);
      await page.waitForTimeout(50);
    }
    await expect.poll(() => c.sockets.length, { timeout: 5_000 }).toBeGreaterThan(before);
    await expect(page.locator(".conn-strip")).toHaveCount(0);
  } finally {
    await c.cleanup();
  }
});

test("a hub that holds the socket open but cannot answer gives a reason and a way on", async ({ page, request, token }) => {
  // EXPECTED TO FAIL. When /api/state keeps failing while the socket is up, hubStore.refresh()'s catch sets
  // { syncing: true, syncSlow: true } and tries again every 3 s for ever (hubStore.ts:660-661), and the only thing on
  // screen is "Getting the latest from <machine>…" (App.tsx:350-357): the hub's own words ("The hub is busy.") are
  // thrown away, nothing escalates after a while, and Try now is nowhere — reconnectNow is only offered where
  // `downSince` is set, which an open socket never sets. A wedged hub (this Mac swapping) looks like a slow one for ever.
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const c = await liveChat(page, request, token, "Hub wedged");
  try {
    await page.goto(`/#/room/${c.room.id}`);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    c.control.stateStatus = 503;
    c.drop();
    const strip = page.locator(".conn-strip").filter({ hasText: `Getting the latest from ${c.hubName}` });
    await expect(strip).toBeVisible({ timeout: 15_000 });
    // It has been failing for 10 s now: say why, and offer the same way on as a machine that can't be reached.
    await page.waitForTimeout(10_000);
    await expect(strip).toContainText("The hub is busy.");
    await expect(strip.getByRole("button", { name: "Try now", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
  } finally {
    await c.cleanup();
  }
});

test("Retry keeps the keyboard's place while it works", async ({ page, request, token }) => {
  // EXPECTED TO FAIL. The chat's Retry disables itself while the history loads (WorkingPanel.tsx:91-93
  // `disabled={data.loading || !connected}`), and a browser blurs an element it disables: focus drops to <body>, so a
  // keyboard or switch-control user loses their place mid-action and is never told how the retry went. The same shape
  // is in App.tsx's ConnStrip "Try now" (325-336) and ChatSidebar's TryNow (97-108), which disable themselves for 2 s.
  await page.setViewportSize({ width: 390, height: 844 });
  // The clock is held so the chat's own retry (after 2 s, ChatScreen RELOAD_AFTER_MS) can't be the load under test.
  await page.clock.install();
  const c = await liveChat(page, request, token, "Retry focus");
  let release = () => {};
  try {
    c.control.historyError = "The hub is restarting.";
    await page.goto(`/#/room/${c.room.id}`);
    const line = page.locator(".chat-status");
    await expect(line).toContainText("Couldn't load this chat");
    const retry = line.getByRole("button");
    await expect(retry).toBeEnabled();
    const asked = c.counts.history;
    c.control.historyGate = new Promise<void>((resolve) => { release = resolve; });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => c.counts.history).toBeGreaterThan(asked);
    await expect(line.locator("button")).toBeDisabled();
    expect(await page.evaluate(() => document.activeElement?.tagName), "focus must not fall back to the page").toBe("BUTTON");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".chat-status"))).toBe(true);
    release();
  } finally {
    release();
    await c.cleanup();
  }
});

test("keystrokes typed into a terminal while the hub is away are not swallowed", async ({ page, request, token }) => {
  // EXPECTED TO FAIL. Live.send() drops anything sent while the socket isn't open (api.ts:348-352, no queue, no error)
  // and Terminal.tsx:133 wires every keystroke straight into it, so a terminal stays focused and looks live while the
  // connection is down and everything typed vanishes. On reconnect Terminal.tsx re-reads the scrollback and clears the
  // screen, so there is no trace of it. That is the terminal the Mac fix runs sudo in, where the typing is a password.
  await page.setViewportSize({ width: 390, height: 844 });
  const c = await liveChat(page, request, token, "Terminal while away");
  const info = { id: "pty_polish", title: "Shell", command: "/bin/zsh", purpose: "shell", cols: 80, rows: 24, alive: true, createdAt: Date.now(), exitCode: null };
  await page.route("**/api/pty**", (route) => {
    const method = route.request().method();
    return route.fulfill(method === "POST" ? { json: info } : method === "DELETE" ? { json: { ok: true } } : { json: { info, scrollback: "hub% " } });
  });
  try {
    await page.goto("/#/terminal");
    await page.getByRole("button", { name: "Open a shell", exact: true }).click();
    await expect(page.locator(".term-box")).toBeVisible();
    await page.locator(".term-box .xterm-helper-textarea").focus();
    await page.keyboard.type("echo hi");
    await expect.poll(() => c.input.join(""), { message: "typing in the terminal must reach the hub while it is connected" }).toContain("echo hi");
    // The hub goes away, and more is typed into the terminal that is still on screen and still focused.
    c.refuse(true);
    await expect(page.locator(".conn-strip.down")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.type("rm -rf nothing");
    // Either it is kept and sent when the hub comes back, or the terminal says it isn't going anywhere. Not silence.
    // Only inside the page (the connection strip above it is not the terminal saying anything about the typing).
    const warned = await page.locator(".page").getByText(/not connected|goes nowhere|isn't going|while the hub/i).count();
    const refused = c.sockets.length;
    c.refuse(false);
    await expect.poll(() => c.sockets.length, { timeout: 10_000 }).toBeGreaterThan(refused);
    await page.waitForTimeout(500);
    const delivered = c.input.join("").includes("rm -rf nothing");
    expect(delivered || warned > 0, "typing while the hub is away must be kept or refused, never silently dropped").toBe(true);
  } finally {
    await c.cleanup();
  }
});

test("the small words and the tab you are on have enough contrast to read", async ({ page }) => {
  // EXPECTED TO FAIL, twice. Two of the colours (styles.css:10 and :13-15) are under the 4.5:1 WCAG AA asks for text
  // this size:
  //   --text-3 #6e6e73 on --bg #000000 = 4.14:1 — 35 rules paint text with it, among them a message's time (11px,
  //     styles.css:703), the composer's placeholder (15px, :1021) and the chats list's "No chats yet" (12.5px, :3028);
  //   --accent-text #ffffff on --accent #3d95ff = 3.03:1 — every primary action and the Settings tab you are on
  //     (.btn.primary:309-313, .settings-tabs-row button[aria-selected="true"]:2586-2589, 13px 600).
  // Both are read on a phone held outdoors, which is where this app is used.
  await page.goto("/#/settings/machines");
  const tab = page.getByRole("tab", { name: "Machines", exact: true });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const ratios = await tab.evaluate((el) => {
    const rgb = (css: string) => {
      const s = css.trim();
      if (s.startsWith("#")) return [0, 2, 4].map((i) => parseInt(s.slice(1).slice(i, i + 2), 16));
      return s.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    };
    const lum = (css: string) =>
      rgb(css)
        .map((n) => {
          const v = n / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, v, i) => sum + [0.2126, 0.7152, 0.0722][i] * v, 0);
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const root = getComputedStyle(document.documentElement);
    const on = getComputedStyle(el);
    return {
      smallWords: ratio(root.getPropertyValue("--text-3"), root.getPropertyValue("--bg")),
      tabYouAreOn: ratio(on.color, on.backgroundColor),
    };
  });
  expect(ratios.smallWords, "--text-3 text on the page's own black").toBeGreaterThanOrEqual(4.5);
  expect(ratios.tabYouAreOn, "the Settings tab you are on").toBeGreaterThanOrEqual(4.5);
});
