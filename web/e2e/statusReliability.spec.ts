import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Approval, Member, Message, Room, StateSnapshot, Turn } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { join } from "node:path";

const hub = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});

/** Real room/auth with controlled hub responses, including socket loss and delayed resync. */
async function scenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Status reliability", mode: "direct" } })).json();
  const created: Member = await (await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "worker" } })).json();
  const snapshot: StateSnapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m) => m.id === created.id)!;
  // As a machine from before group chats has it (a room, not a chat): these checks are about the room screen it opens in.
  const listed = snapshot.rooms.find((r) => r.id === room.id)!;
  listed.chat = null;
  const history = { room: listed, messages: [] as Message[], turns: [] as Turn[], activities: [] as Activity[], approvals: [] as Approval[], totals: null, hasMore: false };
  const control: { stateGate?: Promise<void>; historyGate?: Promise<void>; historyError?: string; historyRequests: number } = { historyRequests: 0 };
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    sockets.push(socket);
    socket.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", async (route) => {
    if (control.stateGate) await control.stateGate;
    await route.fulfill({ json: snapshot });
  });
  await page.route(`**/api/rooms/${room.id}/history**`, async (route) => {
    control.historyRequests++;
    if (control.historyGate) await control.historyGate;
    await route.fulfill(control.historyError ? { status: 503, json: { error: control.historyError } } : { json: history });
  });
  return { room, member, history, control, sockets, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

function reply(member: Member, id: string, turnId: string, text: string, status: Message["status"] = "streaming"): Message {
  return { id, roomId: member.roomId, authorKind: "agent", memberId: member.id, authorName: member.handle, text, mentions: [], turnId, status, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
}

function turn(member: Member, id: string, messageId: string | null, status: Turn["status"] = "running", error: string | null = null): Turn {
  return { id, roomId: member.roomId, memberId: member.id, triggerMessageId: null, replyMessageId: messageId, hop: 0, chainId: id, origin: "human", status, error, usage: null, createdAt: 1_700_000_000_000, startedAt: 1_700_000_000_000, endedAt: status === "running" ? null : 1_700_000_001_000 };
}

function activity(member: Member, id: string, turnId: string, kind: Activity["kind"], detail: string): Activity {
  return { id, roomId: member.roomId, memberId: member.id, turnId, kind, title: kind === "thinking" ? "Considering next steps" : "Run verification", detail, status: "running", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
}

test("failed turns expose their errors even with a partial grouped reply or no reply message", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  s.history.messages.push(reply(s.member, "first", "first-turn", "Earlier reply.", "done"), reply(s.member, "partial", "failed-turn", "I started checking the project."));
  s.history.turns.push(turn(s.member, "first-turn", "first", "done"), turn(s.member, "failed-turn", "partial", "error", "Provider disconnected during verification."), turn(s.member, "orphan-turn", null, "error", "Agent failed before creating a reply."));
  s.history.activities.push(activity(s.member, "unfinished", "failed-turn", "command", "Partial output"));
  try {
    await page.goto(`/#/room/${s.room.id}`);
    const grouped = page.locator(".msg.agent.cont");
    await expect(grouped).toContainText("I started checking the project.");
    await expect(grouped.getByText("error", { exact: true })).toBeVisible();
    await expect(grouped.getByRole("alert")).toHaveText("Provider disconnected during verification.");
    await expect(page.locator(".messages").getByRole("alert").filter({ hasText: "Agent failed before creating a reply." })).toBeVisible();
    await expect(grouped.locator(".cursor, .typing, .spin")).toHaveCount(0);
    await expect(grouped.locator(".activity > summary")).toContainText("outcome not reported");
    await grouped.locator(".activity > summary").click();
    await expect(grouped.locator(".act-row > summary")).toContainText("Outcome not reported");
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("current thinking stops when work advances and disconnected progress stays unknown until resync finishes", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  s.member.status = "thinking";
  s.member.statusDetail = "Considering next steps";
  s.history.messages.push(reply(s.member, "streaming", "current", "Partial response."));
  s.history.turns.push(turn(s.member, "current", "streaming"));
  s.history.activities.push(activity(s.member, "thought", "current", "thinking", "Checking the assumptions before acting."));
  let releaseState = () => {};
  let releaseHistory = () => {};
  try {
    await page.goto(`/#/room/${s.room.id}`);
    await expect(page.locator(".working-thought.live")).toBeVisible();
    await expect(page.locator(".messages .cursor")).toHaveCount(1);
    Object.assign(s.member, { status: "working", statusDetail: "Run verification" });
    const command = activity(s.member, "command", "current", "command", "Verification started");
    s.history.activities.push(command);
    s.sockets.at(-1)!.send(JSON.stringify({ t: "member", member: s.member }));
    s.sockets.at(-1)!.send(JSON.stringify({ t: "activity", activity: command }));
    await expect(page.locator(".working-thought")).toHaveCount(0);
    await expect(page.locator(".working-step .spin")).toHaveCount(1);
    await expect(page.locator(".messages .act-row").filter({ hasText: "Considering next steps" }).locator(".spin")).toHaveCount(0);

    // A reopened socket alone must not make cached progress live again.
    s.control.stateGate = new Promise<void>((resolve) => { releaseState = resolve; });
    s.control.historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    s.sockets.at(-1)!.close({ code: 1001, reason: "Fixture connection lost" });
    const unknown = page.getByRole("region", { name: "Agent status unknown", exact: true });
    await expect(unknown).toBeVisible();
    await expect(page.locator(".messages .cursor, .messages .typing, .messages .spin, .working-panel .spin, .working-thought.live")).toHaveCount(0);
    await expect(page.getByLabel("Agent work order", { exact: true })).toHaveCount(0);
    await expect(page.locator(".composer-hint").filter({ hasText: "@worker is working" })).toHaveCount(0);
    await expect(unknown).toContainText("Syncing — agent status unknown.");

    Object.assign(s.member, { status: "error", statusDetail: "Connection lost at provider" });
    Object.assign(s.history.turns[0], { status: "error", error: "Connection lost at provider", endedAt: 1_700_000_001_000 });
    Object.assign(s.history.messages[0], { status: "error" });
    const requestsBeforeSync = s.control.historyRequests;
    releaseState();
    await expect.poll(() => s.control.historyRequests).toBeGreaterThan(requestsBeforeSync);
    await expect(unknown).toBeVisible();
    await expect(page.locator(".messages .cursor, .messages .spin")).toHaveCount(0);
    releaseHistory();
    await expect(page.locator(".messages").getByRole("alert")).toHaveText("Connection lost at provider");
    await expect(unknown).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Live agent work", exact: true })).toHaveCount(0);
    await expect(page.locator(".messages .spin, .messages .cursor")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { releaseState(); releaseHistory(); await s.cleanup(); }
});

test("failed history loading stays visible without request loops and can be retried", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  s.control.historyError = "History is temporarily unavailable.";
  s.history.messages.push(reply(s.member, "saved", "saved-turn", "Saved conversation recovered.", "done"));
  s.history.turns.push(turn(s.member, "saved-turn", "saved", "done"));
  try {
    await page.goto(`/#/room/${s.room.id}`);
    const historyError = page.locator(".messages").getByRole("alert");
    await expect(historyError).toContainText("History is temporarily unavailable.");
    const retry = historyError.getByRole("button", { name: "Retry loading conversation", exact: true });
    await expect(retry).toBeEnabled();
    const failedRequests = s.control.historyRequests;
    // A stable error must not re-trigger the room's load effect on every render.
    await page.waitForTimeout(350);
    expect(s.control.historyRequests).toBe(failedRequests);
    s.control.historyError = undefined;
    await retry.click();
    await expect(page.locator(".messages")).toContainText("Saved conversation recovered.");
    await expect(historyError).toHaveCount(0);
    expect(s.control.historyRequests).toBe(failedRequests + 1);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("a failed history resync keeps cached replies without reviving live indicators", async ({ page, request, token }) => {
  const s = await scenario(page, request, token);
  s.member.status = "thinking";
  s.history.messages.push(reply(s.member, "cached", "interrupted", "Last received reply text."));
  s.history.turns.push(turn(s.member, "interrupted", "cached"));
  s.history.activities.push(activity(s.member, "cached-thought", "interrupted", "thinking", "Checking the unfinished task."));
  try {
    await page.goto(`/#/room/${s.room.id}`);
    await expect(page.locator(".working-thought.live")).toBeVisible();
    s.control.historyError = "History resync failed.";
    s.sockets.at(-1)!.close({ code: 1001, reason: "Fixture interruption" });
    const retry = page.locator(".messages").getByRole("button", { name: "Retry loading conversation", exact: true });
    await expect(retry).toBeEnabled();
    await expect(page.locator(".messages")).toContainText("Last received reply text.");
    await expect(page.getByRole("region", { name: "Agent status unknown", exact: true })).toContainText("Conversation status unavailable");
    await expect(page.locator(".messages .cursor, .messages .spin, .working-panel .spin, .working-thought.live")).toHaveCount(0);
    s.control.historyError = undefined;
    Object.assign(s.history.messages[0], { status: "stopped" });
    Object.assign(s.history.turns[0], { status: "stopped", endedAt: 1_700_000_001_000 });
    Object.assign(s.member, { status: "idle", statusDetail: null });
    s.sockets.at(-1)!.send(JSON.stringify({ t: "member", member: s.member }));
    await retry.click();
    await expect(page.locator(".messages .pill")).toHaveText("stopped");
    await expect(page.locator(".messages").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Agent status unknown", exact: true })).toHaveCount(0);
    await expect(page.locator(".messages .spin, .messages .cursor")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

/** A real chat (its agent never runs) whose history the test answers: it can fail, and each request is counted. */
async function chatScenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Chat status" } })).json();
  const snapshot: StateSnapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m) => m.roomId === room.id)!;
  const history = { room, messages: [] as Message[], turns: [] as Turn[], activities: [] as Activity[], approvals: [] as Approval[], tasks: {} as Record<string, unknown[]>, totals: null, hasMore: false };
  const control: { fail: (n: number) => boolean; requests: number[] } = { fail: () => false, requests: [] };
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    sockets.push(socket);
    socket.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" })); });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => {
    control.requests.push(Date.now());
    return r.fulfill(control.fail(control.requests.length) ? { status: 503, json: { error: "The hub is restarting." } } : { json: history });
  });
  const send = (e: unknown) => sockets.at(-1)!.send(JSON.stringify(e));
  return { room, member, history, control, send, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

test("a chat whose history fails says Couldn't load this chat with Retry, and loads by itself on the next try", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chatScenario(page, request, token);
  s.history.messages.push(reply(s.member, "saved", "saved-turn", "Saved conversation recovered.", "done"));
  s.history.turns.push(turn(s.member, "saved-turn", "saved", "done"));
  // The hub can't answer for the first few seconds (Airplane Mode just turned off, a restart).
  let until = Infinity;
  s.control.fail = () => Date.now() < until;
  try {
    const started = Date.now();
    await page.goto(`/#/room/${s.room.id}`);
    const strip = page.locator(".chat-status");
    await expect(strip).toContainText("Couldn't load this chat");
    await expect(strip.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    // Why, said once: on the status line, not again in the conversation above it.
    await expect(strip.locator(".chat-status-note")).toHaveText("The hub is restarting.");
    await expect(page.locator(".messages")).not.toContainText("Couldn't load");
    // Not "Catching up…": the agent isn't working, and the line says what's wrong.
    await expect(page.getByText("Catching up…")).toHaveCount(0);
    await page.screenshot({ ...shot("history-failed.png"), animations: "disabled" });
    until = started + 4_000;
    // It loads by itself on a later try, with no tap.
    await expect(page.locator(".messages")).toContainText("Saved conversation recovered.", { timeout: 15_000 });
    await expect(strip).toHaveCount(0);
    // A backoff, not a loop: at most 3 requests in the first 25 s, and none once it loaded.
    await page.waitForTimeout(Math.max(0, started + 25_000 - Date.now()));
    expect(s.control.requests.length, `requests at ${s.control.requests.map((t) => t - started).join(", ")} ms`).toBeLessThanOrEqual(3);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("finished helpers start collapsed", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chatScenario(page, request, token);
  const task = (id: string, description: string, endedAgo: number) => ({ id, kind: "local_agent", description, agentType: "Explore", workflow: null, background: true, status: "completed", startedAt: Date.now() - endedAgo - 90_000, endedAt: Date.now() - endedAgo, tokens: 12_000, toolUses: 9, lastTool: null, summary: "Checked it.", error: null });
  s.history.tasks[s.member.id] = [task("h1", "Review the parser", 60_000), task("h2", "Check the tests", 120_000)];
  s.history.messages.push(reply(s.member, "done", "done-turn", "All set.", "done"));
  s.history.turns.push(turn(s.member, "done-turn", "done", "done"));
  try {
    await page.goto(`/#/room/${s.room.id}`);
    const head = page.locator(".helpers-head");
    await expect(head).toContainText("2 helpers finished");
    // Folded: what they did is one tap away, not taking up the screen.
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".helpers-list")).toHaveCount(0);
    await page.screenshot({ ...shot("helpers-collapsed.png"), animations: "disabled" });
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".helpers-list .helper")).toHaveCount(2);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("the status line says what's really happening: a retry in plain words, and a step that has gone quiet", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chatScenario(page, request, token);
  // Claude's servers are overloaded and Claude Code keeps retrying: not just "Thinking".
  Object.assign(s.member, { status: "thinking", statusDetail: "Retrying (overloaded_error, attempt 6/10)" });
  const began = Date.now() - 7 * 60_000;
  s.history.messages.push({ ...reply(s.member, "live", "live-turn", ""), createdAt: began, updatedAt: began });
  s.history.turns.push({ ...turn(s.member, "live-turn", "live"), createdAt: began, startedAt: began });
  try {
    await page.goto(`/#/room/${s.room.id}`);
    const line = page.locator(".chat-status");
    await expect(line.locator(".chat-status-now")).toHaveText("Claude's servers are busy: trying again (6 of 10)");
    await expect(line).toHaveClass(/\battention\b/);
    await page.screenshot({ ...shot("status-retrying.png"), animations: "disabled" });
    // Then a command that has shown nothing for six minutes: it says so, and that it may be waiting for input.
    const quiet = { ...activity(s.member, "dev", "live-turn", "command", ""), title: "npm run dev", createdAt: Date.now() - 6 * 60_000 - 5000, updatedAt: Date.now() - 6 * 60_000 - 5000 };
    s.send({ t: "activity", activity: quiet });
    s.send({ t: "member", member: { ...s.member, status: "working", statusDetail: "npm run dev" } });
    await expect(line.locator(".chat-status-now")).toHaveText("Running a command");
    await expect(line.locator(".chat-status-note")).toHaveText("No output for 6 min: it may be waiting for input. Tap Stop if it's stuck.");
    await expect(line).toHaveClass(/\battention\b/);
    await page.screenshot({ ...shot("status-quiet-step.png"), animations: "disabled" });
    // The command ends: its title isn't repeated as if it were still running.
    s.send({ t: "activity", activity: { ...quiet, status: "done", updatedAt: Date.now() } });
    await expect(line.locator(".chat-status-now")).toHaveText("Working");
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

/**
 * A real group chat of Claude Code and Codex (its agents never run) whose state, history and live events the test plays:
 * the checks above, on the chat screen current hubs open a room in. `control` holds the state and history answers back
 * (stateGate, historyGate) or fails the history (historyError).
 */
async function groupScenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${hub}/api/chats/group`, { headers, data: { name: "Group status", members: [{ provider: "claude" }, { provider: "codex" }], answers: "lead" } })).json();
  const snapshot: StateSnapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const [lead, other] = ["claude", "codex"].map((handle) => snapshot.members.find((m) => m.roomId === room.id && m.handle === handle)!);
  const history = { room, messages: [] as Message[], turns: [] as Turn[], activities: [] as Activity[], approvals: [] as Approval[], tasks: {} as Record<string, unknown[]>, totals: null, hasMore: false };
  const control: { stateGate?: Promise<void>; historyGate?: Promise<void>; historyError?: string; historyRequests: number } = { historyRequests: 0 };
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    sockets.push(socket);
    socket.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" })); });
  });
  await page.route("**/api/state", async (r) => {
    if (control.stateGate) await control.stateGate;
    await r.fulfill({ json: snapshot });
  });
  await page.route(`**/api/rooms/${room.id}/history**`, async (r) => {
    control.historyRequests++;
    if (control.historyGate) await control.historyGate;
    await r.fulfill(control.historyError ? { status: 503, json: { error: control.historyError } } : { json: history });
  });
  return { room, lead, other, history, control, sockets, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

test("a group chat's failed replies show their errors, one that failed before it had a reply too", async ({ page, request, token }) => {
  const s = await groupScenario(page, request, token);
  s.history.messages.push(reply(s.lead, "first", "first-turn", "Earlier reply.", "done"), reply(s.other, "partial", "failed-turn", "I started checking the project."));
  s.history.turns.push(turn(s.lead, "first-turn", "first", "done"), turn(s.other, "failed-turn", "partial", "error", "Provider disconnected during verification."), turn(s.lead, "orphan-turn", null, "error", "Agent failed before creating a reply."));
  s.history.activities.push(activity(s.other, "unfinished", "failed-turn", "command", "Partial output"));
  try {
    await page.goto(`/#/room/${s.room.id}`);
    // Codex's reply ended with an error (its turn says so, though the message was left streaming): under its own name.
    const failed = page.locator(".msg.agent").filter({ hasText: "I started checking the project." });
    await expect(failed.locator(".who")).toHaveText("@codex");
    await expect(failed.getByText("error", { exact: true })).toBeVisible();
    await expect(failed.getByText("Provider disconnected during verification.", { exact: true })).toBeVisible();
    await expect(failed.locator(".cursor, .typing, .spin")).toHaveCount(0);
    await expect(failed.locator(".activity > summary")).toContainText("outcome not reported");
    // Claude Code's turn that failed before it had a reply of its own.
    await expect(page.locator(".messages").getByText("Agent failed before creating a reply.", { exact: true })).toBeVisible();
    // Both were in the history when the chat opened: shown in their place, not announced as news (an alert is for a
    // failure that happens while the chat is open: polish-chat-screen.spec.ts).
    await expect(page.locator(".messages [role=alert]")).toHaveCount(0);
    // Nobody is working: no status lines.
    await expect(page.locator(".chat-status")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("in a group chat each agent at work has its own line and Stop, and a lost connection leaves none of them live", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await groupScenario(page, request, token);
  Object.assign(s.lead, { status: "thinking", statusDetail: "Considering next steps" });
  Object.assign(s.other, { status: "working", statusDetail: "Run verification" });
  s.history.messages.push(reply(s.lead, "lead-live", "lead-turn", "Partial response."), reply(s.other, "other-live", "other-turn", "Checking."));
  s.history.turns.push(turn(s.lead, "lead-turn", "lead-live"), turn(s.other, "other-turn", "other-live"));
  s.history.activities.push(activity(s.lead, "thought", "lead-turn", "thinking", "Checking the assumptions before acting."));
  let releaseState = () => {};
  let releaseHistory = () => {};
  try {
    await page.goto(`/#/room/${s.room.id}`);
    const lines = page.locator(".group-status-row");
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0).locator(".chat-status-now")).toHaveText("@claude: Thinking");
    await expect(lines.nth(0).locator(".chat-status-thought")).toHaveText("Checking the assumptions before acting.");
    await expect(lines.nth(1).locator(".chat-status-now")).toHaveText("@codex: Run verification");
    await expect(lines.locator(".chat-status .spin")).toHaveCount(2);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("group-status-lines.png"), animations: "disabled" });
    // Each line stops its own agent: the other goes on.
    const stopped = page.waitForRequest((req) => req.url().endsWith(`/api/rooms/${s.room.id}/stop`) && req.method() === "POST");
    await page.getByRole("button", { name: "Stop @codex", exact: true }).click();
    expect((await stopped).postDataJSON()).toEqual({ memberId: s.other.id });

    // The connection drops: neither line says its agent is at work now, until the chat has caught up again.
    s.control.stateGate = new Promise<void>((resolve) => { releaseState = resolve; });
    s.control.historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    s.sockets.at(-1)!.close({ code: 1001, reason: "Fixture connection lost" });
    await expect(lines.nth(0).locator(".chat-status-now")).toHaveText(/^@claude: (Last seen working|Catching up…)$/);
    await expect(lines.nth(1).locator(".chat-status-now")).toHaveText(/^@codex: (Last seen working|Catching up…)$/);
    await expect(lines.locator(".spin, .chat-status-thought")).toHaveCount(0);
    await expect(page.locator(".messages .cursor, .messages .typing")).toHaveCount(0);

    // Meanwhile Claude Code finished and Codex failed: once caught up, that's what shows.
    Object.assign(s.lead, { status: "idle", statusDetail: null });
    Object.assign(s.other, { status: "error", statusDetail: "Connection lost at provider" });
    Object.assign(s.history.turns[0], { status: "done", endedAt: 1_700_000_001_000 });
    Object.assign(s.history.messages[0], { status: "done" });
    Object.assign(s.history.turns[1], { status: "error", error: "Connection lost at provider", endedAt: 1_700_000_001_000 });
    Object.assign(s.history.messages[1], { status: "error" });
    releaseState();
    releaseHistory();
    await expect(page.locator(".messages").getByRole("alert")).toHaveText("Connection lost at provider");
    await expect(lines).toHaveCount(0);
    await expect(page.locator(".messages .spin, .messages .cursor")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { releaseState(); releaseHistory(); await s.cleanup(); }
});

test("a group chat whose history fails says so once for all its agents, with Retry", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await groupScenario(page, request, token);
  s.control.historyError = "History is temporarily unavailable.";
  s.history.messages.push(reply(s.lead, "saved", "saved-turn", "Saved conversation recovered.", "done"));
  s.history.turns.push(turn(s.lead, "saved-turn", "saved", "done"));
  try {
    await page.goto(`/#/room/${s.room.id}`);
    const strip = page.locator(".chat-status");
    await expect(strip).toHaveCount(1);
    await expect(strip).toContainText("Couldn't load this chat");
    await expect(strip.locator(".chat-status-note")).toHaveText("History is temporarily unavailable.");
    await expect(page.locator(".messages")).not.toContainText("Couldn't load");
    await noHorizontalOverflow(page);
    // Retry asks again at once: still failing, it's still said once.
    const failedRequests = s.control.historyRequests;
    await strip.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => s.control.historyRequests).toBeGreaterThan(failedRequests);
    await expect(strip).toHaveCount(1);
    await expect(strip.locator(".chat-status-note")).toHaveText("History is temporarily unavailable.");
    // Then it loads, on the next try by itself.
    s.control.historyError = undefined;
    await expect(page.locator(".messages")).toContainText("Saved conversation recovered.", { timeout: 20_000 });
    await expect(strip).toHaveCount(0);
  } finally { await s.cleanup(); }
});
