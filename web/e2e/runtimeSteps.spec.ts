// Steps that stream as deltas and load whole when opened, "Read it now" under a message handed to a long step, and
// "Always allow" saying what it allows. A real chat and sign-in, with the hub's answers controlled.
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Approval, Member, Message, StateSnapshot, Turn } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

const hub = "http://127.0.0.1:8451";

async function scenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Runtime checks" } })).json();
  const snapshot: StateSnapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m) => m.roomId === room.id)!;
  const history = { room, messages: [] as Message[], turns: [] as Turn[], activities: [] as Activity[], approvals: [] as Approval[], tasks: {}, totals: null, hasMore: false };
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
  const now = Date.now();
  const message = (kind: Message["authorKind"], text: string, turnId: string | null = null, status: Message["status"] = "done"): Message => ({ id: `rt-${++n}`, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId, status, createdAt: now - 200_000 + n * 1000, updatedAt: now - 200_000 + n * 1000 });
  const turn = (id: string, patch: Partial<Turn> = {}): Turn => ({ id, roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: id, origin: "human", status: "running", error: null, usage: null, createdAt: now - 190_000, startedAt: now - 190_000, endedAt: null, ...patch });
  const step = (id: string, turnId: string, patch: Partial<Activity> = {}): Activity => ({ id, roomId: room.id, turnId, memberId: member.id, kind: "command", title: "npm test -- --runInBand", detail: "", status: "running", createdAt: now - 125_000, updatedAt: now - 125_000, ...patch });
  const send = (e: unknown) => sockets.at(-1)!.send(JSON.stringify(e));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, member, snapshot, history, message, turn, step, send, open, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

test("a message handed to a reply inside a long step says so, and Read it now asks the hub to stop that step", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  Object.assign(s.member as Member, { status: "working", statusDetail: "npm test -- --runInBand" });
  const ask = s.message("human", "Run the tests, then ship it.");
  const reply = s.message("agent", "Running the full suite first.", "long", "streaming");
  const later = s.message("human", "Also bump the version to 2.3.12.");
  s.history.messages.push(ask, reply, later);
  const running = s.turn("long", { triggerMessageId: ask.id, replyMessageId: reply.id, unread: [later.id] });
  s.history.turns.push(running);
  s.history.activities.push(s.step("cmd", "long"));
  let asked = 0;
  // The first time, the hub can't stop the step.
  await page.route(`**/api/rooms/${s.room.id}/read-now`, (r) => (++asked === 1 ? r.fulfill({ status: 409, json: { error: "Couldn't stop the step: Claude Code reads this after it." } }) : r.fulfill({ json: { reading: true } })));
  const asks: string[] = [];
  page.on("dialog", (d) => {
    asks.push(d.message());
    void d.accept();
  });
  try {
    await s.open();
    const note = page.locator(".read-now");
    await expect(note).toContainText("Claude Code reads this after the current step:");
    await expect(note.locator("code")).toHaveText("npm test -- --runInBand");
    await expect(note).toContainText(/running 2m \d+s/);
    // It sits under the message it's about.
    const box = (await note.boundingBox())!;
    const msg = (await page.getByText("Also bump the version to 2.3.12.").boundingBox())!;
    expect(box.y).toBeGreaterThan(msg.y);
    await noHorizontalOverflow(page);
    // The button says it stops the step; a command is cut off where it is, so that's asked first.
    await note.getByRole("button", { name: "Stop it and read now", exact: true }).click();
    await expect.poll(() => asked).toBe(1);
    expect(asks[0]).toBe('Stop "npm test -- --runInBand" now? It\'s cut off where it is, and Claude Code reads your message right away.');
    // It couldn't: that's what the note says (not "it has just read it"), with Try again.
    await expect(note.getByRole("alert")).toHaveText("Couldn't stop the step: Claude Code reads this after it.");
    await noHorizontalOverflow(page);
    await note.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => asked).toBe(2);
    s.send({ t: "turn", turn: { ...running, readingNow: true } });
    await expect(note).toContainText("so Claude Code reads this now");
    await expect(note.getByRole("button")).toHaveCount(0);
    // Read: the note goes.
    s.send({ t: "turn", turn: { ...running, unread: null, readingNow: false } });
    await expect(note).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test("Always allow says what it allows, and a request that can only be allowed once doesn't offer it", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  Object.assign(s.member as Member, { status: "approval", statusDetail: "git status -s" });
  const ask = s.message("human", "What changed?");
  const reply = s.message("agent", "Checking the tree.", "t1", "streaming");
  s.history.messages.push(ask, reply);
  s.history.turns.push(s.turn("t1", { triggerMessageId: ask.id, replyMessageId: reply.id }));
  const base = { roomId: s.room.id, memberId: s.member.id, turnId: "t1", status: "pending" as const, decision: null, decidedBy: null, decidedAt: null, createdAt: Date.now() - 5000 };
  const narrow: Approval = { ...base, id: "ap-narrow", kind: "command", title: "git status -s", detail: "# Check the tree\ngit status -s", always: "Always allow `git status` commands" };
  const once: Approval = { ...base, id: "ap-once", kind: "tool", title: "Read ~/notes.txt", detail: "", always: null, createdAt: Date.now() - 4000 };
  s.snapshot.approvals = [narrow, once];
  s.history.approvals = [narrow, once];
  const decided: unknown[] = [];
  await page.route("**/api/approvals/ap-narrow", async (r) => {
    decided.push(r.request().postDataJSON());
    await r.fulfill({ json: { ...narrow, status: "approved", decision: "approve_always", decidedBy: "Phone", decidedAt: Date.now() } });
  });
  try {
    await s.open();
    const cards = page.locator(".messages .approval");
    await expect(cards).toHaveCount(2);
    const always = cards.nth(0).getByRole("button", { name: "Always allow git status commands" });
    await expect(always).toBeVisible();
    await expect(always.locator("code")).toHaveText("git status");
    await expect(cards.nth(1).getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(cards.nth(1).getByRole("button", { name: /Always allow/ })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await always.click();
    await expect.poll(() => decided).toEqual([{ decision: "approve_always" }]);
  } finally {
    await s.cleanup();
  }
});

test("a long step's output comes short in history and loads whole when it's opened, with a retry if that fails", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  const ask = s.message("human", "Run the tests.");
  const reply = s.message("agent", "All 412 tests pass.", "done-turn");
  s.history.messages.push(ask, reply);
  s.history.turns.push(s.turn("done-turn", { status: "done", triggerMessageId: ask.id, replyMessageId: reply.id, endedAt: Date.now() - 60_000 }));
  const full = `${"PASS src/case.test.ts\n".repeat(250)}Tests: 412 passed, 412 total\n`;
  s.history.activities.push(s.step("big", "done-turn", { status: "done", detail: full.slice(0, 1200), detailLength: full.length }));
  let fail = true;
  await page.route("**/api/activities/big", (r) => (fail ? r.fulfill({ status: 503, json: { error: "The hub is restarting." } }) : r.fulfill({ json: { ...s.history.activities[0], detail: full, detailLength: undefined } })));
  try {
    await s.open();
    await page.locator(".activity > summary").click();
    await page.locator(".act-row > summary").click();
    const row = page.locator(".act-row");
    await expect(row.getByRole("alert")).toContainText("Couldn't load the rest. The hub is restarting.");
    await expect(row.locator("pre")).toContainText("PASS src/case.test.ts"); // the start shows meanwhile
    fail = false;
    await row.getByRole("button", { name: "Try again" }).click();
    await expect(row.locator("pre")).toContainText("Tests: 412 passed, 412 total");
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(row.getByText("Loading the rest…")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

test("a running step's output streams in as deltas", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  Object.assign(s.member as Member, { status: "working", statusDetail: "npm test" });
  const ask = s.message("human", "Run the tests.");
  const reply = s.message("agent", "Running them.", "live", "streaming");
  s.history.messages.push(ask, reply);
  s.history.turns.push(s.turn("live", { triggerMessageId: ask.id, replyMessageId: reply.id }));
  const cmd = s.step("cmd-live", "live", { title: "npm test", detail: "ok 1\n" });
  s.history.activities.push(cmd);
  try {
    await s.open();
    const row = page.locator(".act-row").filter({ hasText: "npm test" });
    await row.locator("summary").click();
    await expect(row.locator("pre")).toHaveText("ok 1");
    s.send({ t: "activity.delta", roomId: s.room.id, turnId: "live", activityId: "cmd-live", offset: 5, delta: "ok 2\n", updatedAt: Date.now() });
    s.send({ t: "activity.delta", roomId: s.room.id, turnId: "live", activityId: "cmd-live", offset: 5, delta: "ok 2\nok 3\n", status: "done", updatedAt: Date.now() + 1 });
    await expect(row.locator("pre")).toHaveText("ok 1\nok 2\nok 3");
    await expect(row.locator(".spin")).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test("chat settings list what's always allowed in the chat, and Remove takes one back", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  let list = [
    { id: "rule:Bash(git status:*)", label: "`git status` commands" },
    { id: "rule:Edit(//work/app/src/a.ts)", label: "Edits to /work/app/src/a.ts" },
  ];
  const removed: string[] = [];
  await page.route(`**/api/members/${s.member.id}/always`, (r) => {
    if (r.request().method() === "DELETE") {
      const { id } = r.request().postDataJSON() as { id: string };
      removed.push(id);
      list = list.filter((g) => g.id !== id);
    }
    return r.fulfill({ json: list });
  });
  try {
    await s.open();
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Chat settings", exact: true });
    const field = dialog.locator(".field").filter({ hasText: "Always allowed" });
    await expect(field).toContainText("Claude Code doesn't ask before these in this chat. Stricter permissions take them all back.");
    await expect(field.locator("li")).toHaveCount(2);
    await expect(field.locator("li").first().locator("code")).toHaveText("git status");
    await noHorizontalOverflow(page);
    await field.getByRole("button", { name: "Remove: git status commands", exact: true }).click();
    await expect(field.locator("li")).toHaveCount(1);
    expect(removed).toEqual(["rule:Bash(git status:*)"]);
    // Nothing left: nothing shown.
    await field.getByRole("button", { name: "Remove: Edits to /work/app/src/a.ts", exact: true }).click();
    await expect(dialog.getByText("Always allowed", { exact: true })).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});
