import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Member, Message, Room, StateSnapshot, Turn } from "@crosstalk/shared";
import { test, expect } from "./fixtures";

// The chat screen as a person uses it: the live step list while a reply streams, the message box's attachments and its
// @ popup, and what a screen reader is told. Every test here describes something today's code gets wrong, so
// **each one is expected to fail** until it is fixed; the line that is wrong is named above each test.
// The happy paths already have homes (chatRefinement.spec.ts, runtimeSteps.spec.ts, flows.spec.ts, phoneQol.spec.ts,
// groupChats.spec.ts): nothing here repeats them.

const HUB = "http://127.0.0.1:8451";
const project = () => test.info().project.name;
/** Once per browser, at a phone's width: the screen all of this has to work on. */
const onPhone = () => test.skip(!/-390$/.test(project()), "Once per browser, at 390.");
/** The narrowest phone, where a long @name has nowhere to go. */
const onNarrowest = () => test.skip(!/-320$/.test(project()), "The narrowest phone: the 320 project.");
/** A phone and a wide window: the same thing has to hold at both. */
const onPhoneAndWide = () => test.skip(!/-(390|1440)$/.test(project()), "A phone and a wide window.");

/**
 * One chat with its agent, with the hub's answers controlled: the state, the history and the live connection are this
 * test's, so nothing runs a real agent and every event lands exactly when the test says.
 */
async function scenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Chat screen polish" } })).json();
  const snapshot: StateSnapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member = snapshot.members.find((m) => m.roomId === room.id)!;
  const history = { room, messages: [] as Message[], turns: [] as Turn[], activities: [] as Activity[], approvals: [], tasks: {}, totals: null, hasMore: false };
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    sockets.push(socket);
    socket.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  let n = 0;
  const base = Date.now() - 300_000;
  const message = (kind: Message["authorKind"], text: string, turnId: string | null = null, status: Message["status"] = "done"): Message => ({
    id: `cs-${++n}`, seq: n, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle,
    memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId, status, createdAt: base + n * 1000, updatedAt: base + n * 1000,
  });
  const turn = (id: string, patch: Partial<Turn> = {}): Turn => ({
    id, roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: id,
    origin: "human", status: "running", error: null, usage: null, createdAt: base, startedAt: base, endedAt: null, ...patch,
  });
  const step = (id: string, turnId: string, patch: Partial<Activity> = {}): Activity => ({
    id, roomId: room.id, turnId, memberId: member.id, kind: "command", title: `step ${id}`, detail: "",
    status: "running", createdAt: base + 1000, updatedAt: base + 1000, ...patch,
  });
  const send = (e: unknown) => sockets.at(-1)!.send(JSON.stringify(e));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, member, snapshot, history, message, turn, step, send, open, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** A group chat of test agents (POST /api/rooms makes one), each with the @name the test gives it. */
async function group(request: APIRequestContext, token: string, name: string, handles: string[]) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode: "direct" } })).json();
  const members: Member[] = [];
  for (const handle of handles) {
    members.push(await (await request.post(`${HUB}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle, config: { delayMs: 30 } } })).json());
  }
  return { room, members, headers, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** The chats drawer (or the docked list), opened. */
async function drawer(page: Page) {
  const show = page.getByRole("button", { name: /^Show chats/ });
  if (await show.count()) await show.click();
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(side).toBeVisible();
  return side;
}

// ---------------------------------------------------------------------------------------------------------------
// The live step list
// ---------------------------------------------------------------------------------------------------------------

/**
 * EXPECTED TO FAIL — web/src/views/ActivityBlock.tsx:34.
 * `<details className="activity" open={live && activities.length <= 3 ? true : undefined}>`: when the fourth step
 * arrives the prop goes from `true` to `undefined`, and React 19 answers that by removing the attribute
 * (updateProperties' generic branch → setProp's `case "open"` → removeAttribute), so the list the chat opened by
 * itself slams shut under the person reading it. Nothing about a fourth step means "fold this away".
 */
test("the live step list a reply opened by itself stays open when the next step arrives", async ({ page, request, token }) => {
  onPhoneAndWide();
  const s = await scenario(page, request, token);
  Object.assign(s.member as Member, { status: "working", statusDetail: "npm test" });
  const ask = s.message("human", "Run the checks.");
  const reply = s.message("agent", "Running them.", "live", "streaming");
  s.history.messages.push(ask, reply);
  s.history.turns.push(s.turn("live", { triggerMessageId: ask.id, replyMessageId: reply.id }));
  s.history.activities.push(s.step("one", "live", { title: "npm run lint", status: "done" }), s.step("two", "live", { title: "npm test", detail: "ok 1\n" }));
  try {
    await s.open();
    const block = page.locator(".messages .activity");
    // Two steps while it works: the chat shows them without being asked.
    await expect(block).toHaveJSProperty("open", true);
    await expect(page.locator(".act-row")).toHaveCount(2);
    s.send({ t: "activity", activity: s.step("three", "live", { title: "npm run build", createdAt: Date.now(), updatedAt: Date.now() }) });
    await expect(page.locator(".act-row")).toHaveCount(3);
    await expect(block).toHaveJSProperty("open", true);
    // The fourth step is still the same reply working: the list must not close on its own.
    s.send({ t: "activity", activity: s.step("four", "live", { title: "git status", createdAt: Date.now() + 1, updatedAt: Date.now() + 1 }) });
    await expect(page.locator(".act-row")).toHaveCount(4);
    await expect(block).toHaveJSProperty("open", true);
    // A closed details still has a box in Chromium and WebKit (see scrollPlace.ts isDrawn): ask the browser instead.
    expect(await page.locator(".act-row").filter({ hasText: "npm test" }).evaluate((el) => el.checkVisibility())).toBe(true);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Failed replies and what a screen reader hears
// ---------------------------------------------------------------------------------------------------------------

/**
 * EXPECTED TO FAIL — web/src/views/RoomView.tsx:444 (`TurnError`).
 * Every failed reply's error is `role="alert"`, which is an assertive live region. Opening a chat puts the whole
 * loaded history into the page at once, so a screen reader is interrupted by every old failure in it — three here,
 * and one per failure further back as "Load earlier messages" brings more in. An error that arrives while the chat is
 * open is news and should be announced; one that was already there is not.
 */
test("old failed replies in the history are not announced as alerts; a new failure is", async ({ page, request, token }) => {
  onPhone();
  const s = await scenario(page, request, token);
  for (let i = 1; i <= 3; i++) {
    const ask = s.message("human", `Attempt ${i}`);
    const reply = s.message("agent", "", `failed-${i}`, "error");
    s.history.messages.push(ask, reply);
    s.history.turns.push(s.turn(`failed-${i}`, { status: "error", error: `Claude Code stopped before replying (${i}).`, triggerMessageId: ask.id, replyMessageId: reply.id, endedAt: Date.now() }));
  }
  try {
    await s.open();
    await expect(page.locator(".messages .msg.agent.error")).toHaveCount(3);
    // Three old failures, read in the usual way: nothing shouts.
    await expect.soft(page.locator(".messages [role=alert]")).toHaveCount(0);
    // One that happens while you watch does.
    const ask = s.message("human", "Attempt 4");
    const reply = s.message("agent", "", "failed-4", "error");
    s.send({ t: "message", message: ask });
    s.send({ t: "message", message: reply });
    s.send({ t: "turn", turn: s.turn("failed-4", { status: "error", error: "The connection to Claude Code dropped.", triggerMessageId: ask.id, replyMessageId: reply.id, endedAt: Date.now() }) });
    await expect(page.locator(".messages [role=alert]")).toHaveCount(1);
    await expect(page.locator(".messages [role=alert]")).toContainText("The connection to Claude Code dropped.");
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The message box: attachments
// ---------------------------------------------------------------------------------------------------------------

/**
 * EXPECTED TO FAIL — web/src/views/Composer.tsx:82-86 with ChatScreen.tsx:469's `<Composer key={room.id}>`.
 * Looking at another chat unmounts the message box, and its unmount calls `UploadJobs.dispose()`: every attachment is
 * dropped and every upload in flight is cancelled, without a word. The typed draft survives the same trip
 * (localStorage), and reloading for an update *does* ask first (App.tsx's UpdateBanner counts `pendingAttachments`) —
 * so leaving a chat is the one way to lose a finished upload silently. Nothing registers a navigation guard either
 * (`useNavigationGuard` has one caller, SettingsPage), though useFindMessage.ts:20 already says navigation can be
 * refused "a message with files waiting to be sent".
 */
test("an attachment waiting to be sent survives a look at another chat, as the typed draft does", async ({ page, request, token }) => {
  onPhone();
  const here = await group(request, token, "Attachment keeps", ["helper"]);
  const there = await group(request, token, "Somewhere else", ["helper"]);
  try {
    await page.goto(`/#/room/${here.room.id}`);
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("Have a look at this");
    await page.locator('input[aria-label="Choose attachments"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("keep me") });
    const waiting = page.getByLabel("Attachments", { exact: true });
    await expect(waiting.getByText("Ready", { exact: true })).toBeVisible();
    // Off to another chat and back, the way anyone checks something mid-message.
    await (await drawer(page)).getByRole("button", { name: /^Somewhere else/ }).click();
    await expect(page.locator(".topbar h1")).toHaveText("Somewhere else");
    await (await drawer(page)).getByRole("button", { name: /^Attachment keeps/ }).click();
    await expect(page.locator(".topbar h1")).toHaveText("Attachment keeps");
    // The words came back (they are saved per chat); the file has to come back too, or the trip has to be refused.
    await expect(box).toHaveValue("Have a look at this");
    await expect(page.getByLabel("Attachments", { exact: true })).toContainText("notes.txt");
  } finally {
    await here.cleanup();
    await there.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The message box: the @ popup
// ---------------------------------------------------------------------------------------------------------------

/**
 * EXPECTED TO FAIL — web/src/views/Composer.tsx:417 (`insertMention(popHandles[pop.index])`) and
 * web/src/caret.ts:16 (`pos: start + handle.length + 2`).
 * The arrow keys wrap the highlight with `% popHandles.length`, but nothing clamps the index again when the list
 * itself gets shorter: an agent leaving the chat (from another device, or from this chat's settings in another tab)
 * drops a row while the popup is open. Enter then reads past the end of the list, `handle` is undefined, and
 * `handle.length` throws — the pick does nothing at all and the page reports an error. Picking the last row that is
 * still there, or doing nothing, is what should happen.
 */
test("picking a name after an agent leaves the chat does not read past the end of the popup", async ({ page, request, token }) => {
  onPhone();
  const g = await group(request, token, "Popup shrinks", ["alpha", "bravo", "charlie", "delta"]);
  try {
    await page.goto(`/#/room/${g.room.id}`);
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("@");
    const pop = page.locator(".mention-pop");
    await expect(pop).toBeVisible();
    // Four agents and "all": the last row is "all".
    await expect(pop.getByRole("option")).toHaveCount(5);
    for (let i = 0; i < 4; i++) await box.press("ArrowDown");
    await expect(pop.getByRole("option", { selected: true })).toHaveCount(1);
    // @delta leaves the chat while the popup is open.
    await request.delete(`${HUB}/api/members/${g.members[3].id}`, { headers: g.headers });
    await expect(pop.getByRole("option")).toHaveCount(4);
    // Exactly one row is still highlighted, so Enter has something to pick.
    await expect.soft(pop.getByRole("option", { selected: true })).toHaveCount(1);
    await box.press("Enter");
    await expect(box).toHaveValue(/^@(alpha|bravo|charlie|all) $/);
  } finally {
    await g.cleanup();
  }
});

/**
 * EXPECTED TO FAIL — web/src/views/Composer.tsx:583 (`<textarea … aria-label="Message">`) and the `.mention-pop` (:564)
 * listbox next to it (AskCompose.tsx's AskMentionPop too).
 * The popup is a listbox with options and a highlighted row, but nothing on the message box says it opened, which one
 * is highlighted, or that the arrow keys move it: a screen reader hears the typed "@" and then silence, and the arrow
 * keys move a highlight it can't report. The box needs combobox semantics — aria-expanded while the popup is up, and
 * aria-activedescendant naming the highlighted option.
 */
test("the message box tells a screen reader the @ popup is open and which name is highlighted", async ({ page, request, token }) => {
  onPhone();
  const g = await group(request, token, "Popup is announced", ["alpha", "bravo"]);
  try {
    await page.goto(`/#/room/${g.room.id}`);
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.click();
    await expect(box).not.toHaveAttribute("aria-expanded", "true");
    await box.fill("@");
    const pop = page.locator(".mention-pop");
    await expect(pop).toBeVisible();
    await expect(box).toHaveAttribute("aria-expanded", "true");
    // The highlighted row is the one the box points at.
    const chosen = pop.getByRole("option", { selected: true });
    await expect(chosen).toHaveCount(1);
    expect(await box.getAttribute("aria-activedescendant")).toBe(await chosen.getAttribute("id"));
    await box.press("ArrowDown");
    const next = pop.getByRole("option", { selected: true });
    expect(await box.getAttribute("aria-activedescendant")).toBe(await next.getAttribute("id"));
    await box.press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(box).not.toHaveAttribute("aria-expanded", "true");
  } finally {
    await g.cleanup();
  }
});

/**
 * EXPECTED TO FAIL — web/src/styles.css:1656 (`.mention-pop`) and :1667 (`.mention-pop button`).
 * The popup is `min-width: 240px` with rows whose parts never shrink or wrap, so a long @name (the new-group dialog
 * lets one be 28 characters) pushes the agent's kind off the row. `body { overflow: hidden }` clips it, so the name
 * is simply cut with nothing to say so — on the narrowest phone part of the name goes too. The Ask others popup
 * beside it already solves this (styles/asks.css: `min-width: 0`, wrapping, `overflow-wrap: anywhere`).
 */
test("a long @name keeps the popup's row inside the screen at 320", async ({ page, request, token }) => {
  onNarrowest();
  const g = await group(request, token, "Long names", ["qwen3-coder-next-on-mac-mini", "bravo"]);
  try {
    await page.goto(`/#/room/${g.room.id}`);
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("@");
    const row = page.locator(".mention-pop [role=option]").first();
    await expect(row).toContainText("qwen3-coder-next-on-mac-mini");
    // Its contents fit the row it is in…
    expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    // …and the row ends inside the screen.
    const edge = (await row.boundingBox())!;
    expect(edge.x + edge.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    // The agent's kind is readable, not pushed off the end.
    await expect(row).toContainText("Test agent");
  } finally {
    await g.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The send button
// ---------------------------------------------------------------------------------------------------------------

/**
 * EXPECTED TO FAIL — web/src/views/Composer.tsx:598 (`aria-label={askName ?? "Send"}` over the visible
 * `askLabel`) with groupChat.ts's `sendLabel` ("Send to 2") and `sendName` ("Send to @alpha and @bravo").
 * The button says one thing and is named another, so anyone driving the phone by voice who says what the button says
 * ("Send to 2") doesn't hit it (WCAG 2.5.3, Label in Name). The full form belongs in the title or in a line beside
 * the button; the accessible name has to start from the words on it.
 */
test("the send button's accessible name contains the words written on it", async ({ page, request, token }) => {
  onPhone();
  const g = await group(request, token, "Button name", ["alpha", "bravo"]);
  try {
    await page.goto(`/#/room/${g.room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("@alpha @bravo please look");
    const send = page.locator(".composer .send.ask");
    await expect(send).toBeVisible();
    const written = (await send.innerText()).trim();
    expect(written).not.toBe("");
    expect((await send.getAttribute("aria-label")) ?? "").toContain(written);
  } finally {
    await g.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// When the hub says no
// ---------------------------------------------------------------------------------------------------------------

/**
 * EXPECTED TO FAIL — hub/src/server.ts:101 (`throw new HttpError(413, "message too long")`) reaching the screen
 * unchanged through api.ts:147 and Composer.tsx's `toast("error", e.message)`.
 * A pasted log goes over the hub's 100,000-character limit and the notice reads "message too long": three machine
 * words, no limit, no way out, and nothing in the box warned beforehand. Every error on this screen is supposed to
 * say what to do next. The draft does come back, which is the one part that works.
 */
test("a message over the hub's limit says how long a message can be and what to do instead", async ({ page, request, token }) => {
  onPhone();
  const g = await group(request, token, "Too long", ["helper"]);
  try {
    await page.goto(`/#/room/${g.room.id}`);
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("Here is the log:\n" + "x".repeat(100_001));
    await page.locator(".composer .send:not(.stop)").click();
    const notice = page.locator(".toasts");
    await expect(notice).toBeVisible();
    // Plain words with a way out, not the hub's three.
    await expect(notice).not.toContainText("message too long");
    await expect(notice).toContainText(/100,000|attach|shorter|shorten/i);
    // What was typed is still there to work with.
    expect((await box.inputValue()).length).toBeGreaterThan(100_000);
  } finally {
    await g.cleanup();
  }
});
