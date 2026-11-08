import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { Page, APIRequestContext, WebSocketRoute } from "@playwright/test";
import { join } from "node:path";
const hub = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
async function scenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Refinement checks" } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: any) => m.roomId === room.id);
  const history: any = { room, messages: [], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let seq = 0;
  const message = (kind: string, text: string, turnId: string | null = null, status = "done") => ({ id: `ref-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : "claude", memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId, status, createdAt: seq * 1000, updatedAt: seq * 1000 });
  let live: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (socket) => { live = socket; socket.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" })); }); });
  // The agent has read the history a test writes, unless the test says otherwise (member.readSeq).
  delete member.readSeq;
  const read = () => ({ ...snapshot, members: snapshot.members.map((m: any) => (m.id === member.id && m.readSeq === undefined ? { ...m, readSeq: Math.max(0, ...history.messages.map((x: any) => x.seq)) } : m)) });
  await page.route("**/api/state", (r) => r.fulfill({ json: read() }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => {
    const before = Number(new URL(r.request().url()).searchParams.get("before")) || Infinity;
    const candidates = history.messages.filter((m: any) => m.seq < before);
    return r.fulfill({ json: { ...history, messages: candidates.slice(-80), hasMore: candidates.length > 80 } });
  });
  const open = async () => { await page.goto(`/#/room/${room.id}`); await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible(); };
  const send = (e: unknown) => live!.send(JSON.stringify(e));
  const turn = (id: string, patch: Record<string, unknown> = {}) => ({ id, roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: id, origin: "human", status: "done", error: null, usage: null, createdAt: seq * 1000, startedAt: seq * 1000, endedAt: null, ...patch });
  /** The hub's answers to what a test taps (never the test hub itself: its agent would really run), with what was sent. */
  const answer = async (method: string, path: string, json: unknown = { ok: true }, status = 200) => {
    const bodies: unknown[] = [];
    await page.route(`**${path}`, (r) => {
      if (r.request().method() !== method) return r.fallback();
      bodies.push(r.request().postDataJSON() ?? null);
      return r.fulfill({ status, json });
    });
    return bodies;
  };
  return { room, member, snapshot, history, message, turn, send, answer, open, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
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
/** System alerts (confirm, alert) shown: none should be, the app asks in its own sheets. */
function systemAlerts(page: Page) {
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(d.message()); void d.dismiss(); });
  return seen;
}

test("older pages survive returning to the app", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  for (let i = 1; i <= 110; i++) s.history.messages.push(s.message("human", `Question ${i}`), s.message("agent", `Answer ${i}`));
  try {
    await s.open();
    await page.getByRole("button", { name: "Load earlier messages" }).click();
    await expect(page.locator(".msg.human")).toHaveCount(80);
    await page.getByText("Question 40", { exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator(".msg.human")).toHaveCount(80);
    await expect(page.getByText("Question 40", { exact: true })).toBeVisible();
  } finally { await s.cleanup(); }
});

test("busy helpers leave Stop and typing visible with a phone keyboard", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", config: { effort: "high", ultracode: true } });
  s.history.messages.push(s.message("human", "Check the project"), s.message("agent", "Checking it now", "working", "streaming"));
  s.history.turns.push({ id: "working", roomId: s.room.id, memberId: s.member.id, status: "running", triggerMessageId: s.history.messages[0].id, replyMessageId: s.history.messages[1].id, createdAt: 1000 });
  s.history.tasks[s.member.id] = Array.from({ length: 7 }, (_, i) => ({ id: `helper${i}`, kind: "local_agent", description: `Review part ${i}`, status: "running", startedAt: Date.now(), tokens: 1000, toolUses: 2 }));
  try {
    await s.open();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Please pause while I check");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await page.evaluate(() => document.documentElement.style.setProperty("--app-height", "470px"));
    await expect.poll(async () => { const b = (await page.locator(".chat-controls").boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(470);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("split approvals render once and autonomous errors do not take back unrelated messages", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Start"), s.message("agent", "First part", "split"), s.message("human", "Keep a backup"), s.message("agent", "Second part", "split"), s.message("agent", "Failed background follow-up", "own", "error"));
  s.history.turns.push({ id: "split", status: "done", triggerMessageId: s.history.messages[0].id }, { id: "own", status: "error", triggerMessageId: null, error: "Background task failed" });
  s.history.approvals.push({ id: "ref-approval", roomId: s.room.id, memberId: s.member.id, turnId: "split", kind: "command", title: "Build project", detail: "build", status: "approved", decision: "approve", createdAt: 2500, decidedAt: 2600 });
  try {
    await s.open();
    await expect(page.locator(".approval")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Take back your message" })).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("editing earlier messages asks twice and preserves failed edits", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Original request"), s.message("agent", "Original response"));
  let patches = 0;
  await page.route(`**/api/messages/${s.history.messages[0].id}`, (r) => { patches++; return r.fulfill({ status: 409, json: { error: "Stop the agent first" } }); });
  try {
    await s.open();
    await page.getByText("Original request", { exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit message" }).fill("Revised request");
    expect(await page.locator(".edit-box").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await page.getByRole("button", { name: "Save and send" }).click();
    await expect(page.getByRole("dialog")).toContainText("Edit and rewind?");
    expect(patches).toBe(0);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Are you sure?");
    expect(patches).toBe(0);
    await page.getByRole("button", { name: "Yes, rewind" }).click();
    await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveValue("Revised request");
    await expect(page.getByText("Stop the agent first", { exact: true })).toBeVisible();
  } finally { await s.cleanup(); }
});

test("large file changes render their contents only after opening the step", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Make the change"), s.message("agent", "Change complete", "diff-turn"));
  s.history.turns.push({ id: "diff-turn", status: "done", triggerMessageId: s.history.messages[0].id });
  s.history.activities.push({ id: "large-diff", roomId: s.room.id, memberId: s.member.id, turnId: "diff-turn", kind: "file_change", title: "Update large file", detail: Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n"), status: "done", createdAt: 1500, updatedAt: 2000 });
  try {
    await s.open();
    await expect(page.locator(".diff-add")).toHaveCount(0);
    await page.locator(".activity > summary").click();
    await page.locator(".act-row > summary").click();
    await expect(page.locator(".diff-add")).toHaveCount(2000);
    await page.locator(".act-row > summary").click();
    await expect(page.locator(".diff-add")).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("Delete chat asks twice, and Cancel at the second step keeps the chat", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the launch"), s.message("agent", "Here's the plan."));
  const deletes = await s.answer("DELETE", `/api/rooms/${s.room.id}`);
  const alerts = systemAlerts(page);
  try {
    await s.open();
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Chat settings", exact: true });
    await settings.getByRole("button", { name: "Delete chat", exact: true }).click();
    const first = page.getByRole("dialog", { name: "Delete this chat?", exact: true });
    await expect(first).toContainText("Its messages are removed from Crosstalk. Files in its folder stay.");
    await page.screenshot({ ...shot("delete-chat-step-1.png"), animations: "disabled" });
    await first.getByRole("button", { name: "Continue", exact: true }).click();
    const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
    await expect(sure).toContainText("This can't be undone.");
    await expect(sure.getByRole("button", { name: "Yes, delete", exact: true })).toBeVisible();
    await page.screenshot({ ...shot("delete-chat-step-2.png"), animations: "disabled" });
    // Cancel at the second step: nothing is deleted, and the chat is still there.
    await sure.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sure).toHaveCount(0);
    expect(deletes).toEqual([]);
    await expect(settings).toBeVisible();
    // Both steps: deleted.
    await settings.getByRole("button", { name: "Delete chat", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete this chat?", exact: true }).getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("dialog", { name: "Are you sure?", exact: true }).getByRole("button", { name: "Yes, delete", exact: true }).click();
    await expect.poll(() => deletes.length).toBe(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(alerts).toEqual([]);
  } finally { await s.cleanup(); }
});

test("Delete chat says it stops the agent while it works", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working" });
  s.history.messages.push(s.message("human", "Build it"), s.message("agent", "Building", "run", "streaming"));
  s.history.turns.push(s.turn("run", { status: "running" }));
  try {
    await s.open();
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Chat settings", exact: true }).getByRole("button", { name: "Delete chat", exact: true }).click();
    const first = page.getByRole("dialog", { name: "Delete this chat?", exact: true });
    await expect(first).toContainText("Deleting stops Claude Code.");
    // It doesn't have to be stopped first: deleting stops it.
    await expect(first.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  } finally { await s.cleanup(); }
});

test("Start fresh asks in the app, not in a system alert", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Hello"), s.message("agent", "Hi"));
  const resets = await s.answer("POST", `/api/members/${s.member.id}/reset`);
  const alerts = systemAlerts(page);
  try {
    await s.open();
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Chat settings", exact: true }).getByRole("button", { name: "Start fresh", exact: true }).click();
    const ask = page.getByRole("dialog", { name: "Start a fresh session?", exact: true });
    await expect(ask).toContainText("Claude Code forgets this conversation and starts over. The messages here stay.");
    await page.screenshot({ ...shot("start-fresh.png"), animations: "disabled" });
    // Cancel keeps the session.
    await ask.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(ask).toHaveCount(0);
    expect(resets).toEqual([]);
    await page.getByRole("dialog", { name: "Chat settings", exact: true }).getByRole("button", { name: "Start fresh", exact: true }).click();
    await page.getByRole("dialog", { name: "Start a fresh session?", exact: true }).getByRole("button", { name: "Start fresh", exact: true }).click();
    await expect.poll(() => resets.length).toBe(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(alerts).toEqual([]);
  } finally { await s.cleanup(); }
});

test("your messages have Copy, and tapping a link inside one doesn't open Edit and Unsend", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await catchCopies(page);
  const s = await scenario(page, request, token);
  const text = "Read [the release notes](https://example.invalid/notes) and fix the build";
  s.history.messages.push(s.message("human", text), s.message("agent", "Fixed."));
  await page.context().route("https://example.invalid/**", (r) => r.fulfill({ body: "notes" }));
  try {
    await s.open();
    const mine = page.locator(".your-msg").filter({ hasText: "fix the build" });
    // The link opens (in a new tab), and the message's actions stay shut.
    const opened = page.waitForEvent("popup");
    await mine.getByRole("link", { name: "the release notes" }).click();
    await (await opened).close();
    await expect(mine).not.toHaveClass(/\bopen\b/);
    // A tap on the message itself opens them, with Copy beside Edit and Unsend.
    await mine.locator(".bubble").click({ position: { x: 6, y: 6 } });
    await expect(mine).toHaveClass(/\bopen\b/);
    await expect(mine.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await mine.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect(mine.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await copies(page)).toEqual([text]);
    await page.screenshot({ ...shot("your-message-copy.png"), animations: "disabled" });
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("the Copy icon in a reply's header copies the whole reply", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await catchCopies(page);
  const s = await scenario(page, request, token);
  const report = ["## Audit report", "", ...Array.from({ length: 30 }, (_, i) => `- Finding ${i + 1}: **checked**, see \`src/file${i}.ts\``)].join("\n");
  s.history.messages.push(s.message("human", "Audit the repo"), s.message("agent", report), s.message("agent", "Also: the cache is stale."));
  try {
    await s.open();
    const reply = page.locator(".agent-reply").filter({ hasText: "Audit report" });
    // At the top of the reply, next to its time: no scrolling to the end of a long report, no tap first.
    await reply.locator(".head").scrollIntoViewIfNeeded();
    const icon = reply.locator(".head").getByRole("button", { name: "Copy the whole reply", exact: true });
    await expect(icon).toBeVisible();
    await page.screenshot({ ...shot("reply-header-copy.png"), animations: "disabled" });
    // A finger-sized target on a phone, around the small icon: a tap just above it copies too.
    const box = (await icon.boundingBox())!;
    expect(box.height).toBeLessThan(44);
    await page.mouse.click(box.x + box.width / 2, box.y - 6);
    await expect(reply.locator(".head").getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await copies(page)).toEqual([report]);
    // A reply grouped under the one before it has its own short line, with its time and Copy.
    const more = page.locator(".agent-reply").filter({ hasText: "the cache is stale" });
    await expect(more.locator(".msg")).toHaveClass(/\bcont\b/);
    const moreIcon = more.locator(".head").getByRole("button", { name: "Copy the whole reply", exact: true });
    // (A mouse shows the reply's actions as it comes over it; a click comes after that.)
    await more.hover();
    await expect(more.getByRole("button", { name: "Copy reply", exact: true })).toBeVisible();
    await moreIcon.click();
    await expect.poll(() => copies(page)).toEqual([report, "Also: the cache is stale."]);
    // A reply still being written has nothing to copy yet.
    s.send({ t: "message", message: s.message("agent", "Still writing", null, "streaming") });
    const live = page.locator(".agent-reply").filter({ hasText: "Still writing" });
    await expect(live.getByRole("button", { name: "Copy the whole reply" })).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("with a second machine saved on this device, the chat header names the machine", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const name = s.snapshot.hub.name as string;
  const sub = page.locator(".topbar .sub");
  try {
    // One machine: nothing extra. The agent's name isn't repeated (the avatar and the message box say it): the line
    // has room for the folder.
    await s.open();
    await expect(sub).not.toContainText("Claude Code");
    await expect(sub).toContainText("refinement-checks");
    await expect(sub).not.toContainText(`· ${name}`);
    await expect(page.locator(".empty")).toContainText("on this machine.");
    // A second machine on this device (one that can't be reached right now).
    await page.routeWebSocket(/127\.0\.0\.1:9\//, (ws) => ws.close());
    await page.route("http://127.0.0.1:9/**", (r) => r.abort());
    await page.addInitScript((token) => localStorage.setItem("crosstalk.machines.v1", JSON.stringify({ list: [{ baseUrl: "", token, deviceName: "Browser tests" }, { baseUrl: "http://127.0.0.1:9", token: "unreachable", deviceName: "Browser tests" }], active: "" })), token);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    // The machine's short tag, as the chat list shows it (part of its name), with the whole name in the line's title.
    const machine = sub.locator(".chat-sub-machine");
    await expect(machine).toBeVisible();
    const tag = ((await machine.textContent()) ?? "").replace(/^ · /, "");
    expect(tag.length).toBeGreaterThan(0);
    expect(name.toLowerCase()).toContain(tag.toLowerCase());
    await expect(sub).toHaveAttribute("title", new RegExp(` · on ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    // Shown whole even when the line is too long for the phone (the folder's name is what's cut short), and the folder
    // keeps some room.
    expect(await sub.locator(".ellipsis").evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(60);
    const [m, line] = await Promise.all([machine.boundingBox(), sub.boundingBox()]);
    expect(m!.x + m!.width).toBeLessThanOrEqual(line!.x + line!.width + 1);
    await expect(page.locator(".empty")).toContainText(`on ${name}.`);
    await page.screenshot({ ...shot("chat-header-machine.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    const folder = page.getByRole("dialog", { name: "Chat settings", exact: true }).locator(".folder-machine");
    await expect(folder).toHaveText(` on ${name}`);
    await folder.scrollIntoViewIfNeeded();
    await page.screenshot({ ...shot("chat-settings-machine.png"), animations: "disabled" });
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("the newest failed reply offers Try again, and older failures keep Take back behind a tap", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "error", statusDetail: "API Error: overloaded" });
  const first = s.message("human", "Fix the login page");
  const firstFailed = s.message("agent", "⚠️ API Error: overloaded", "fail-1", "error");
  const firstAnswered = s.message("agent", "Fixed the login page.", "ok-1");
  const second = s.message("human", "Now the signup page");
  const secondFailed = s.message("agent", "⚠️ API Error: overloaded", "fail-2", "error");
  s.history.messages.push(first, firstFailed, firstAnswered, second, secondFailed);
  s.history.turns.push(
    s.turn("fail-1", { status: "error", error: "API Error: overloaded", triggerMessageId: first.id, replyMessageId: firstFailed.id, createdAt: 2000 }),
    // Try again answered the first request: its failure is a grey note now.
    s.turn("ok-1", { status: "done", triggerMessageId: first.id, replyMessageId: firstAnswered.id, createdAt: 3000 }),
    s.turn("fail-2", { status: "error", error: "API Error: overloaded", triggerMessageId: second.id, replyMessageId: secondFailed.id, createdAt: 5000 }),
  );
  s.member.readSeq = 5;
  const retries = await s.answer("POST", `/api/rooms/${s.room.id}/retry`, { turn: s.turn("again", { status: "queued" }) });
  try {
    await s.open();
    const replies = page.locator(".agent-reply");
    const older = replies.nth(0);
    const newest = replies.nth(2);
    // The newest failure: Try again and Take back, there without a tap.
    await expect(newest).toHaveClass(/\bopen\b/);
    await expect(newest.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(newest.getByRole("button", { name: "Take back your message", exact: true })).toBeVisible();
    // The older one was answered on a later try: a grey note, not a red error, with its Take back behind a tap.
    await expect(older.locator(".msg")).toHaveClass(/\bretried\b/);
    await expect(older.locator(".pill")).toHaveText("tried again");
    await expect(older.getByRole("alert")).toHaveCount(0);
    await expect(older).not.toHaveClass(/\bopen\b/);
    await expect(older.getByRole("button", { name: "Try again" })).toHaveCount(0);
    // Try again's answer is an answer of its own: its own header, with Copy.
    await expect(replies.nth(1).locator(".msg")).not.toHaveClass(/\bcont\b/);
    await expect(replies.nth(1).locator(".head").getByRole("button", { name: "Copy the whole reply", exact: true })).toBeVisible();
    // The failed reply's Copy is in its header, by its time: the row under it is for getting it answered.
    await expect(newest.locator(".head").getByRole("button", { name: "Copy the whole reply", exact: true })).toBeVisible();
    await expect(newest.getByRole("button", { name: "Copy reply", exact: true })).toHaveCount(0);
    await page.screenshot({ ...shot("try-again.png"), animations: "disabled" });
    await older.locator(".bubble").first().click({ position: { x: 6, y: 6 } });
    await expect(older).toHaveClass(/\bopen\b/);
    await expect(older.getByRole("button", { name: "Take back your message", exact: true })).toBeVisible();
    await newest.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => retries.length).toBe(1);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("a message the agent never read shows Not answered with Answer now", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  // Stop everything ended the reply, and the message you'd sent during it was left as it was.
  const build = s.message("human", "Build the release");
  const stopped = s.message("agent", "Building the release…", "run", "stopped");
  const waiting = s.message("human", "Wait, use the staging database");
  s.history.messages.push(build, stopped, waiting);
  s.history.turns.push(s.turn("run", { status: "stopped", triggerMessageId: build.id, replyMessageId: stopped.id }));
  Object.assign(s.member, { status: "idle", readSeq: stopped.seq });
  const retries = await s.answer("POST", `/api/rooms/${s.room.id}/retry`, { turn: s.turn("answer", { status: "queued" }) });
  try {
    await s.open();
    const mine = page.locator(".your-msg").filter({ hasText: "staging database" });
    const note = mine.locator(".not-answered");
    await expect(note).toContainText("Not answered");
    // Only on the message nothing answered.
    await expect(page.locator(".not-answered")).toHaveCount(1);
    await page.screenshot({ ...shot("not-answered.png"), animations: "disabled" });
    await note.getByRole("button", { name: "Answer now", exact: true }).click();
    await expect.poll(() => retries.length).toBe(1);
    // Once the agent has read it, the note goes.
    s.send({ t: "member", member: { ...s.member, status: "thinking", readSeq: waiting.seq } });
    await expect(page.locator(".not-answered")).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("Stop shows Stopping… until the reply ends", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: null });
  const ask = s.message("human", "Write the release notes");
  const reply = s.message("agent", "Writing them now", "run", "streaming");
  s.history.messages.push(ask, reply);
  s.history.turns.push(s.turn("run", { status: "running", triggerMessageId: ask.id, replyMessageId: reply.id, createdAt: Date.now() - 5000, startedAt: Date.now() - 5000 }));
  let fail = true;
  let release = () => {};
  const held = new Promise<void>((res) => (release = res));
  const stops: unknown[] = [];
  await page.route(`**/api/rooms/${s.room.id}/stop`, async (r) => {
    stops.push(r.request().postDataJSON());
    if (fail) return r.fulfill({ status: 503, json: { error: "The hub is restarting." } });
    await held;
    await r.fulfill({ json: { ok: true } });
  });
  try {
    await s.open();
    // A Stop that doesn't reach the hub says so, and Stop is there again.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const failed = page.locator(".toast").filter({ hasText: "Couldn't stop. Try again." });
    await expect(failed).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await failed.getByRole("button", { name: "Dismiss", exact: true }).click();
    fail = false;
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const stopping = page.getByRole("button", { name: "Stopping…", exact: true });
    await expect(stopping).toBeDisabled();
    await expect(page.locator(".chat-status-now")).toHaveText("Stopping…");
    await page.screenshot({ ...shot("stopping.png"), animations: "disabled" });
    // The hub has stopped it: the reply ends, and Stop goes.
    s.send({ t: "turn", turn: s.turn("run", { status: "stopped", triggerMessageId: ask.id, replyMessageId: reply.id, endedAt: Date.now() }) });
    s.send({ t: "message", message: { ...reply, status: "stopped" } });
    s.send({ t: "member", member: { ...s.member, status: "idle" } });
    release();
    await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
    await expect(page.locator(".chat-status")).toHaveCount(0);
    expect(stops).toEqual([{}, {}]);
  } finally { release(); await s.cleanup(); }
});

test("with a message waiting, Stop asks which", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: null });
  const ask = s.message("human", "Migrate the database");
  const reply = s.message("agent", "Migrating", "run", "streaming");
  const wait = s.message("human", "Wait, use the staging database");
  s.history.messages.push(ask, reply, wait);
  s.history.turns.push(s.turn("run", { status: "running", triggerMessageId: ask.id, replyMessageId: reply.id }), s.turn("next", { status: "queued", triggerMessageId: wait.id }));
  s.member.readSeq = reply.seq;
  const stops = await s.answer("POST", `/api/rooms/${s.room.id}/stop`);
  try {
    await s.open();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const which = page.getByRole("dialog", { name: "Stop Claude Code?", exact: true });
    await expect(which).toContainText("Your message is waiting for this reply to finish.");
    await page.screenshot({ ...shot("stop-asks-which.png"), animations: "disabled" });
    await which.getByRole("button", { name: /^Stop and answer my message/ }).click();
    await expect.poll(() => stops.length).toBe(1);
    expect(stops[0]).toEqual({ keepWaiting: true });
    await expect(which).toHaveCount(0);
    // Or everything (it's still working here: nothing told the page otherwise).
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop Claude Code?", exact: true }).getByRole("button", { name: /^Stop everything/ }).click();
    await expect.poll(() => stops.length).toBe(2);
    expect(stops[1]).toEqual({});
  } finally { await s.cleanup(); }
});

test("Stop asks about a message the reply has been handed and hasn't read too: it may have gone in by itself", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: null });
  const ask = s.message("human", "Migrate the database");
  const reply = s.message("agent", "Migrating", "run", "streaming");
  const also = s.message("human", "Also use the staging database");
  s.history.messages.push(ask, reply, also);
  s.history.turns.push(s.turn("run", { status: "running", triggerMessageId: ask.id, replyMessageId: reply.id, unread: [also.id] }));
  s.member.readSeq = also.seq;
  const stops = await s.answer("POST", `/api/rooms/${s.room.id}/stop`);
  try {
    await s.open();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const which = page.getByRole("dialog", { name: "Stop Claude Code?", exact: true });
    await expect(which).toContainText("Claude Code hasn't read your message yet.");
    await which.getByRole("button", { name: /^Stop and answer my message/ }).click();
    await expect.poll(() => stops.length).toBe(1);
    expect(stops[0]).toEqual({ keepWaiting: true });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop Claude Code?", exact: true }).getByRole("button", { name: /^Stop everything/ }).click();
    await expect.poll(() => stops.length).toBe(2);
    expect(stops[1]).toEqual({});
  } finally { await s.cleanup(); }
});

test("while helpers work, a one-agent chat's labels name its agent or its reply, with nothing to tap", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: null });
  const ask = s.message("human", "Migrate the database");
  const reply = s.message("agent", "Migrating", "run", "streaming");
  const also = s.message("human", "Also use the staging database");
  s.history.messages.push(ask, reply, also);
  s.history.tasks[s.member.id] = [{ id: "helper1", kind: "local_agent", description: "Review the plan", status: "running", background: true, startedAt: Date.now(), tokens: 1000, toolUses: 2 }];
  // Handed to the reply: it reads it at its next step.
  s.history.turns.push(s.turn("run", { status: "running", triggerMessageId: ask.id, replyMessageId: reply.id, unread: [also.id] }));
  s.member.readSeq = also.seq;
  try {
    await s.open();
    await expect(page.locator(".msg-quiet")).toHaveText(/^Claude Code reads this (after the current step|at its next step)\.$/);
    await expect(page.getByRole("button", { name: "Read it now", exact: true })).toHaveCount(0);
    // Waiting behind a reply that can't take it: it goes when that ends.
    s.history.turns.splice(0, 1, s.turn("run", { status: "running", triggerMessageId: ask.id, replyMessageId: reply.id }), s.turn("next", { status: "queued", triggerMessageId: also.id }));
    s.member.readSeq = reply.seq;
    await page.reload();
    await expect(page.locator(".msg-quiet")).toHaveText("Goes when this reply ends.");
    await expect(page.locator(".send-now")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("while only its helpers keep the agent working so a change can apply, a failed reply keeps Try again and a message nothing answered keeps Answer now", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
  const ask = s.message("human", "Migrate the database");
  const failed = s.message("agent", "⚠️ The API said no.", "run", "error");
  s.history.messages.push(ask, failed);
  s.history.turns.push(s.turn("run", { status: "error", error: "The API said no.", triggerMessageId: ask.id, replyMessageId: failed.id, endedAt: failed.createdAt }));
  s.history.tasks[s.member.id] = [{ id: "helper1", kind: "local_agent", description: "Review the plan", status: "running", background: true, startedAt: Date.now(), tokens: 1000, toolUses: 2 }];
  const retries = await s.answer("POST", `/api/rooms/${s.room.id}/retry`);
  try {
    await s.open();
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => retries.length).toBe(1);
    // The same with a message nothing answered (Stop everything left it).
    const also = s.message("human", "Also use the staging database");
    s.history.messages.push(also);
    s.history.turns.splice(0);
    s.member.readSeq = failed.seq;
    await page.reload();
    await page.getByRole("button", { name: "Answer now", exact: true }).click();
    await expect.poll(() => retries.length).toBe(2);
  } finally { await s.cleanup(); }
});

test("Rewind while the agent works offers Stop in the dialog", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: null });
  const one = s.message("human", "Draft the email");
  const oneReply = s.message("agent", "Here's the draft.", "done-1");
  const two = s.message("human", "Make it shorter");
  const twoReply = s.message("agent", "Shortening", "run", "streaming");
  s.history.messages.push(one, oneReply, two, twoReply);
  s.history.turns.push(s.turn("done-1", { triggerMessageId: one.id, replyMessageId: oneReply.id }), s.turn("run", { status: "running", triggerMessageId: two.id, replyMessageId: twoReply.id }));
  const stops = await s.answer("POST", `/api/rooms/${s.room.id}/stop`);
  try {
    await s.open();
    const draft = page.locator(".agent-reply").filter({ hasText: "Here's the draft." });
    await draft.locator(".bubble").click({ position: { x: 6, y: 6 } });
    // Tappable while it works (a phone can't show why a button is greyed out).
    const rewind = draft.getByRole("button", { name: "Rewind to here", exact: true });
    await expect(rewind).toBeEnabled();
    await rewind.click();
    const dialog = page.getByRole("dialog", { name: "Rewind the chat to here?", exact: true });
    await expect(dialog).toContainText("Claude Code is working: stop it first.");
    await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await page.screenshot({ ...shot("rewind-offers-stop.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "Stop Claude Code", exact: true }).click();
    await expect.poll(() => stops.length).toBe(1);
    // It has stopped: Continue works.
    s.send({ t: "turn", turn: s.turn("run", { status: "stopped", triggerMessageId: two.id, replyMessageId: twoReply.id, endedAt: Date.now() }) });
    s.send({ t: "member", member: { ...s.member, status: "idle" } });
    await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await expect(dialog).not.toContainText("stop it first");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Are you sure?", exact: true })).toContainText("This can't be undone");
  } finally { await s.cleanup(); }
});

test("a reply refused because the chat is open in the Claude app offers Try again, and Take back just removes the message", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const refused = "This conversation is open in the Claude app right now. Close it there, then tap Try again. Or duplicate this chat to go on in a copy.";
  const ask = s.message("human", "Fix the login page");
  const failed = s.message("agent", `⚠️ ${refused}`, "refused", "error");
  s.history.messages.push(ask, failed);
  s.history.turns.push(s.turn("refused", { status: "error", error: refused, triggerMessageId: ask.id, replyMessageId: failed.id }));
  // Claude Code never got the message: the hub gave it back (it's past what the agent has read).
  Object.assign(s.member, { status: "error", statusDetail: refused, readSeq: 0 });
  const retries = await s.answer("POST", `/api/rooms/${s.room.id}/retry`, { turn: s.turn("again", { status: "queued" }) });
  const takenBack = await s.answer("DELETE", `/api/messages/${ask.id}`, { removed: [ask.id, failed.id], sent: null });
  try {
    await s.open();
    const reply = page.locator(".agent-reply").filter({ hasText: "open in the Claude app" });
    await expect(reply.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(reply.getByRole("button", { name: "Take back your message", exact: true })).toBeVisible();
    // The reply says to close it there and tap Try again; the card under it doesn't say it again.
    await expect(reply).toContainText("Close it there, then tap Try again.");
    const card = page.getByRole("note").filter({ hasText: "never got your message" });
    await expect(card).toHaveText(/^Claude Code never got your message, so nothing is lost\. A duplicate goes on in a copy; the original stays as it is in the Claude app\./);
    await expect(card).not.toContainText("Close it there");
    await page.screenshot({ ...shot("open-in-claude-app.png"), animations: "disabled" });
    await reply.getByRole("button", { name: "Take back your message", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Take back your message?", exact: true });
    await expect(dialog).toContainText("Your message “Fix the login page” leaves the chat, with this reply that failed on it. Claude Code never got it.");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
    await expect(sure).toContainText("This can't be undone: your message is deleted.");
    await sure.getByRole("button", { name: "Yes, take it back", exact: true }).click();
    await expect.poll(() => takenBack.length).toBe(1);
    expect(retries).toEqual([]);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("Unsend asks twice when a failed reply goes with it, and offers Stop while the agent works on the message", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  // A reply that failed before Claude Code got the message: the hub gave it back (past what the agent has read).
  const ask = s.message("human", "Fix the login page");
  const failed = s.message("agent", "⚠️ Couldn't start claude: spawn ENOENT", "refused", "error");
  // Then, in a later reply that's running, a message Send now handed to it: read, with nothing after it yet.
  const build = s.message("human", "Build it");
  const building = s.message("agent", "Building", "run", "streaming");
  const more = s.message("human", "and run the tests");
  s.history.messages.push(ask, failed, build, building, more);
  s.history.turns.push(
    s.turn("refused", { status: "error", error: "Couldn't start claude: spawn ENOENT", triggerMessageId: ask.id, replyMessageId: failed.id }),
    s.turn("run", { status: "running", triggerMessageId: build.id, replyMessageId: building.id }),
  );
  Object.assign(s.member, { status: "working", statusDetail: null, readSeq: 0 });
  const unsent = await s.answer("DELETE", `/api/messages/${ask.id}`, { removed: [ask.id, failed.id], sent: null });
  const stops = await s.answer("POST", `/api/rooms/${s.room.id}/stop`);
  const alerts = systemAlerts(page);
  try {
    await s.open();
    // The reply that failed on it goes too: said, and asked twice.
    const mine = page.locator(".your-msg").filter({ hasText: "Fix the login page" });
    await mine.locator(".bubble").click({ position: { x: 6, y: 6 } });
    await mine.getByRole("button", { name: "Unsend", exact: true }).click();
    const first = page.getByRole("dialog", { name: "Unsend this message?", exact: true });
    await expect(first).toContainText("Your message leaves the chat, with the reply that failed on it. Claude Code never got it.");
    // Not a rewind: nothing to stop first.
    await expect(first).not.toContainText("stop it first");
    await page.screenshot({ ...shot("unsend-failed-reply.png"), animations: "disabled" });
    await first.getByRole("button", { name: "Continue", exact: true }).click();
    const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
    await expect(sure).toContainText("This can't be undone: your message is deleted.");
    await sure.getByRole("button", { name: "Yes, unsend", exact: true }).click();
    await expect.poll(() => unsent).toEqual([{ ifUnread: true }]);
    await expect(sure).toHaveCount(0);

    // The message Send now handed over is read, and Claude Code is working on it: unsending it is a rewind, and the
    // dialog offers Stop first (no alert, then a refusal).
    s.send({ t: "member", member: { ...s.member, readSeq: more.seq } });
    const handed = page.locator(".your-msg").filter({ hasText: "and run the tests" });
    await handed.locator(".bubble").click({ position: { x: 6, y: 6 } });
    await handed.getByRole("button", { name: "Unsend", exact: true }).click();
    const rewind = page.getByRole("dialog", { name: "Unsend this message?", exact: true });
    await expect(rewind).toContainText("This message leaves the chat. Claude Code goes back to just before it and forgets it.");
    await expect(rewind).toContainText("Claude Code is working: stop it first.");
    await expect(rewind.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await page.screenshot({ ...shot("unsend-offers-stop.png"), animations: "disabled" });
    await rewind.getByRole("button", { name: "Stop Claude Code", exact: true }).click();
    await expect.poll(() => stops.length).toBe(1);
    await rewind.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(alerts).toEqual([]);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("Start fresh says it stops the agent, and that a message it hasn't read waits for Answer now", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: null });
  const ask = s.message("human", "Build it");
  const reply = s.message("agent", "Building", "run", "streaming");
  const wait = s.message("human", "Wait, use staging");
  s.history.messages.push(ask, reply, wait);
  s.history.turns.push(s.turn("run", { status: "running", triggerMessageId: ask.id, replyMessageId: reply.id }), s.turn("next", { status: "queued", triggerMessageId: wait.id }));
  s.member.readSeq = reply.seq;
  const resets = await s.answer("POST", `/api/members/${s.member.id}/reset`);
  try {
    await s.open();
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Chat settings", exact: true }).getByRole("button", { name: "Start fresh", exact: true }).click();
    const ask2 = page.getByRole("dialog", { name: "Start a fresh session?", exact: true });
    await expect(ask2).toContainText("Claude Code forgets this conversation and starts over. The messages here stay. Starting fresh stops Claude Code now. A message it hasn't read yet isn't answered until you tap Answer now under it.");
    await page.screenshot({ ...shot("start-fresh-working.png"), animations: "disabled" });
    await ask2.getByRole("button", { name: "Start fresh", exact: true }).click();
    await expect.poll(() => resets.length).toBe(1);
  } finally { await s.cleanup(); }
});
