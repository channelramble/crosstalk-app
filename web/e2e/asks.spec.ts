// Ask others on the phone (docs/SPEC-0.4.md, track T2; 0.5 track B1: naming others means only they answer). The hub's
// answers are mocked, as chatRefinement.spec.ts does: the shared test hub's state stays as it was, and no agent ever runs
// (a message to the chat is refused unless a test says what the hub answers, and `calls` records what was sent where).
import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { Page, APIRequestContext, WebSocketRoute } from "@playwright/test";
import { join } from "node:path";

const hub = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
async function snap(page: Page, name: string) {
  if (process.env.CT_SHOTS) await page.screenshot({ path: join(process.env.CT_SHOTS, name), animations: "disabled" });
}
const pastDoubleTap = (page: Page) => page.waitForTimeout(450);
/** Two frames on: what a tap schedules for the next frame (the caret going after a name it added) has happened. */
const afterFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

// ---- who can be asked (what GET /api/asks/targets says) ----
const target = (provider: string, account: string, model: string | null) => ({ provider, account, model, effort: null });
const choice = (handle: string, label: string, patch: Record<string, unknown> = {}) => ({ target: target("codex", "default", handle), label, sub: "", handle, paid: "no", local: false, available: true, why: null, typicalCostUsd: null, ...patch });
// `sub` is what the hub sends today: the kind of sign-in, or where it runs ("Plan", "API key", "On this Mac", "Online"). The
// badges say the same, so the sheet leaves it out (one test gives a row a `sub` that adds something).
const CODEX = choice("codex", "Codex · GPT-5.5", { sub: "Plan", target: target("codex", "default", "gpt-5.5") });
const GPT_KEY = choice("gpt-api", "GPT-5.5 · API key", { sub: "API key", target: target("codex", "api-key", "gpt-5.5"), paid: "yes", typicalCostUsd: 0.04 });
const LLAMA = choice("llama", "Llama 3.3 70B", { sub: "On this Mac", target: target("codex", "mac-mini", "llama-3.3-70b"), local: true });
const OPUS = choice("opus", "Claude Opus 4.5", { sub: "API key", target: target("claude", "work", "opus-4.5"), paid: "yes", available: false, why: "Over its $250 limit", typicalCostUsd: 0.12 });
// The agent the test chat is with (Claude Code): the sheet lists what the hub sends, the @ popup leaves it out.
const SELF = choice("claude", "Claude Code", { sub: "Plan", target: target("claude", "default", null) });
const CHOICES = [CODEX, GPT_KEY, LLAMA, OPUS, SELF];

async function scenario(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Ask others checks" } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: any) => m.roomId === room.id);
  const history: any = { room, messages: [], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let seq = 0;
  const message = (kind: string, text: string) => ({ id: `ref-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : "claude", memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: seq * 1000, updatedAt: seq * 1000 });
  let live: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (socket) => { live = socket; socket.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" })); }); });
  delete member.readSeq;
  const read = () => ({ ...snapshot, members: snapshot.members.map((m: any) => (m.id === member.id && m.readSeq === undefined ? { ...m, readSeq: Math.max(0, ...history.messages.map((x: any) => x.seq)) } : m)) });
  await page.route("**/api/state", (r) => r.fulfill({ json: read() }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));

  // The hub's answers about asks. `asks` is what it lists for this chat; the rest records what the page asked.
  const asks: any[] = [];
  const targets = { status: 200, body: CHOICES as unknown, gate: null as Promise<void> | null, requests: 0 };
  const asking = { status: 200, body: null as unknown, gate: null as Promise<void> | null }; // null body: the asks that were asked for, running; a gate holds the hub's answer until a test opens it
  const posted: any[] = [];
  const removed: string[] = [];
  const stopped: string[] = [];
  const calls: string[] = [];
  const idOf = (url: string, from: number) => decodeURIComponent(new URL(url).pathname.split("/")[from]);
  await page.route(`**/api/rooms/${room.id}/asks`, (r) => r.fulfill({ json: asks }));
  await page.route("**/api/asks/targets**", async (r) => {
    targets.requests++;
    await targets.gate;
    return r.fulfill({ status: targets.status, json: targets.body });
  });
  await page.route("**/api/asks", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const body = r.request().postDataJSON();
    posted.push(body);
    calls.push("asks");
    await asking.gate;
    if (asking.status !== 200) return r.fulfill({ status: asking.status, json: asking.body });
    // Who was listed (the plain list, or the list with the machines that didn't answer): a card is named as its row was.
    const listed: any[] = Array.isArray(targets.body) ? targets.body : (targets.body as any).choices;
    const made = body.targets.map((t: any, i: number) => ask(`new-${posted.length}-${i}`, body.messageId, room.id, { target: t, label: listed.find((c) => c.target.account === t.account && c.target.model === t.model && c.target.machine === t.machine)?.label ?? "Codex", status: "running", answer: null, cost: null, note: body.note ?? null, createdAt: Date.now() + i, startedAt: Date.now(), endedAt: null }));
    asks.push(...made);
    return r.fulfill({ json: made });
  });
  await page.route("**/api/asks/*", (r) => {
    if (r.request().method() !== "DELETE") return r.fallback();
    const id = idOf(r.request().url(), 3);
    removed.push(id);
    asks.splice(asks.findIndex((a) => a.id === id), 1);
    return r.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/asks/*/stop", (r) => {
    const id = idOf(r.request().url(), 3);
    stopped.push(id);
    return r.fulfill({ json: { ...asks.find((a) => a.id === id), status: "stopped", endedAt: Date.now() } });
  });
  // Nothing in these tests may reach the agent: a message is only sent where a test says what the hub answers.
  await page.route(`**/api/rooms/${room.id}/messages`, (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    calls.push("message");
    return r.fulfill({ status: 500, json: { error: "A test sent a message it didn't mean to." } });
  });
  const sentMessages: any[] = [];
  const answerMessages = () =>
    page.route(`**/api/rooms/${room.id}/messages`, (r) => {
      if (r.request().method() !== "POST") return r.fallback();
      const body = r.request().postDataJSON();
      sentMessages.push(body);
      calls.push("message");
      return r.fulfill({ json: { id: `sent-${sentMessages.length}`, roomId: room.id, authorKind: "human", authorName: "Phone", memberId: null, text: body.text, mentions: [], turnId: null, status: "done", createdAt: Date.now(), updatedAt: Date.now() } });
    });

  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
    await expect.poll(() => !!live).toBe(true);
  };
  const send = (e: unknown) => live!.send(JSON.stringify(e));
  return { room, member, history, message, asks, targets, asking, posted, removed, stopped, calls, sentMessages, answerMessages, open, send, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

/** An ask as the hub sends it: done in 12 s, with an answer and what it cost. */
function ask(id: string, messageId: string, roomId: string, patch: Record<string, unknown> = {}) {
  const now = Date.now();
  return { id, roomId, messageId, target: CODEX.target, label: "Codex · GPT-5.5", status: "done", answer: "Looks fine to me.", error: null, cost: { costUsd: 0.04, basis: "exact", inputTokens: 1200, outputTokens: 80 }, note: null, local: false, createdAt: now - 60_000, startedAt: now - 60_000, endedAt: now - 48_000, ...patch };
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

/** Opens a message's actions (a tap on it) and the Ask others sheet. */
async function openSheet(page: Page, text: string) {
  const mine = page.locator(".your-msg").filter({ hasText: text });
  if (!(await mine.evaluate((el) => el.classList.contains("open")))) await mine.locator(".bubble").first().click({ position: { x: 6, y: 6 } });
  await mine.getByRole("button", { name: "Ask others", exact: true }).click();
  return page.getByRole("dialog", { name: "Ask others about this message" });
}

/** Visible elements under `selector` smaller than a finger (44 px) on either side. */
const smallOnes = (page: Page, selector: string) => page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return { sel: el.className || el.tagName, w: Math.round(r.width), h: Math.round(r.height) }; }).filter((b) => b.w < 44 || b.h < 44), selector);
/** Visible elements under `selector` that stick out of the screen sideways. */
const offScreen = (page: Page, selector: string) => page.evaluate((sel) => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.getClientRects().length).filter((el) => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > w + 1; }).map((el) => el.className || el.tagName); }, selector);
const messageBox = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });
const chipRow = (page: Page) => page.getByRole("group", { name: "Others who will chime in" });

const ANSWER = [
  "The migration is safe if you do three things first.",
  "",
  "1. Take a backup of the orders table.",
  "2. Run it on staging and watch the lock time.",
  "3. Schedule it outside business hours.",
  "",
  "One thing is missing: the down migration drops a column that the billing job still reads.",
  "",
  "Keep that column for one more release and rollback stays safe.",
  "",
  "Also check the index: it is built without CONCURRENTLY, which blocks writes while it runs.",
].join("\n");

test("Ask others: the sheet shows who can be asked, and Ask 2 sends the picks and the question", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const asked = s.message("human", "Is this migration safe to run on production?");
  s.history.messages.push(asked, s.message("agent", "Yes, if you take a backup first."));
  let release!: () => void;
  s.targets.gate = new Promise<void>((res) => (release = res));
  try {
    await s.open();
    // Both the message of yours and the agent's reply offer it (a tap opens their actions).
    const reply = page.locator(".agent-reply").filter({ hasText: "take a backup first" });
    await reply.locator(".bubble").click({ position: { x: 6, y: 6 } });
    await expect(reply.getByRole("button", { name: "Ask others", exact: true })).toBeVisible();
    const sheet = await openSheet(page, "Is this migration safe");
    await expect(sheet.getByText("Looking for who you can ask…")).toBeVisible();
    await snap(page, "01-sheet-loading.png");
    release();
    await expect(sheet.getByText("They read this message and the chat before it. They can't change anything.")).toBeVisible();
    await expect(sheet.getByRole("checkbox")).toHaveCount(5);
    // The hub's `sub` here only says what the badges say, so no row says it twice.
    await expect(sheet.locator(".ask-row-sub")).toHaveCount(0);
    const row = (name: string) => sheet.locator("li").filter({ has: page.getByRole("checkbox", { name, exact: true }) });
    await expect(row("Codex · GPT-5.5")).toContainText("Uses your plan");
    await expect(row("Codex · GPT-5.5")).toContainText("Online");
    await expect(row("GPT-5.5 · API key")).toContainText("Costs money");
    await expect(row("Llama 3.3 70B")).toContainText("Free");
    await expect(row("Llama 3.3 70B")).toContainText("On this machine");
    // What can't be asked is greyed, last, with why.
    await expect(row("Claude Opus 4.5")).toContainText("Over its $250 limit");
    await expect(sheet.getByRole("checkbox", { name: "Claude Opus 4.5" })).toBeDisabled();
    expect(await sheet.locator("li").last().innerText()).toContain("Claude Opus 4.5");
    await expect(sheet.getByText("This sends the chat so far to each one you pick. Models on this machine stay here.")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Pick who to ask", exact: true })).toBeDisabled();
    // The "?" explains the badges.
    await sheet.getByRole("button", { name: "What do these labels mean?" }).click();
    await expect(sheet.getByRole("note")).toContainText("Uses your plan counts against your Claude or ChatGPT plan");
    await sheet.getByRole("button", { name: "What do these labels mean?" }).click();
    await snap(page, "02-sheet-choices.png");
    await noHorizontalOverflow(page);

    await sheet.getByRole("checkbox", { name: "Codex · GPT-5.5" }).check();
    await expect(sheet.getByRole("button", { name: "Ask 1", exact: true })).toBeEnabled();
    await expect(sheet.getByText("Costs money:")).toHaveCount(0);
    await sheet.getByRole("checkbox", { name: "GPT-5.5 · API key" }).check();
    await expect(sheet.getByText("Costs money: about $0.04")).toBeVisible();
    await sheet.getByLabel("Your question (optional)").fill("Anything wrong with the rollback?");
    await expect(sheet.getByPlaceholder("What do you think? Anything wrong or missing?")).toBeVisible();
    await snap(page, "03-sheet-picked.png");
    await sheet.getByRole("button", { name: "Ask 2", exact: true }).click();
    await expect(sheet).toBeHidden();
    expect(s.posted).toEqual([{ roomId: s.room.id, messageId: asked.id, targets: [CODEX.target, GPT_KEY.target], note: "Anything wrong with the rollback?" }]);

    // The cards are under the message at once (Compare: two answers to one message), then follow the hub's events.
    const cards = page.locator(".ask-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Reading…");
    await expect(cards.nth(0)).toContainText("“Anything wrong with the rollback?”");
    s.send({ t: "ask", ask: { ...s.asks[0], status: "done", answer: "Safe, with a backup.", cost: { costUsd: null, basis: "plan", inputTokens: 900, outputTokens: 40 }, endedAt: s.asks[0].startedAt + 12_000 } });
    // The hub's own sentence (what it stores in Ask.error), not one the page adds "couldn't answer" to.
    s.send({ t: "ask", ask: { ...s.asks[1], status: "error", error: "GPT-5.5 took longer than 3 minutes, so Crosstalk stopped it.", endedAt: s.asks[1].startedAt + 3_000 } });
    await expect(cards.nth(0)).toContainText("Safe, with a backup.");
    await expect(cards.nth(0)).toContainText("Plan · 12 s");
    await expect(cards.nth(1).getByRole("alert")).toHaveText("GPT-5.5 took longer than 3 minutes, so Crosstalk stopped it.");
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("the sheet says what to do when the list can't load or asking is refused", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Review the plan"), s.message("agent", "Plan reviewed."));
  try {
    await s.open();
    // A hub from before Ask others has no list.
    s.targets.status = 404;
    s.targets.body = { error: "Not found" };
    let sheet = await openSheet(page, "Review the plan");
    await expect(sheet.getByRole("alert")).toContainText("This hub can't do that yet. Update the hub on your computer, then try again.");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).toBeHidden();
    // A hub that's having trouble: the reason, and Try again (the sheet tries once more and shows the list).
    s.targets.status = 500;
    s.targets.body = { error: "The hub hit a problem." };
    sheet = await openSheet(page, "Review the plan");
    await expect(sheet.getByRole("alert")).toContainText("Couldn't load who you can ask. The hub hit a problem.");
    await snap(page, "04-sheet-list-error.png");
    s.targets.status = 200;
    // One row has a `sub` that says something the badges don't (a hub that sends the model and effort): it is shown, the rest aren't.
    s.targets.body = [{ ...CODEX, sub: "GPT Test · medium effort" }, ...CHOICES.slice(1)];
    await sheet.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(sheet.getByRole("checkbox")).toHaveCount(5);
    await expect(sheet.locator(".ask-row-sub")).toHaveText(["GPT Test · medium effort"]);
    // Asking refused over a spending limit: the hub's words, Try again, and the way to Settings.
    await sheet.getByRole("checkbox", { name: "GPT-5.5 · API key" }).check();
    s.asking.status = 409;
    s.asking.body = { error: "GPT-5.5 reached its $250 limit, so this reply didn't start.", code: "budget" };
    await sheet.getByRole("button", { name: "Ask 1", exact: true }).click();
    const problem = sheet.getByRole("alert");
    await expect(problem).toContainText("GPT-5.5 reached its $250 limit, so this reply didn't start.");
    await expect(problem.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(sheet.getByRole("checkbox", { name: "GPT-5.5 · API key" })).toBeChecked();
    await snap(page, "05-sheet-ask-error.png");
    await problem.getByRole("button", { name: "Raise limit", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/#\/settings/);
    expect(s.posted).toHaveLength(1);
  } finally { await s.cleanup(); }
});

test("cards: running, done, error and stopped, with Send to the chat, Copy, Remove, Stop and Try again", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await catchCopies(page);
  const s = await scenario(page, request, token);
  const mDone = s.message("human", "Is the migration safe?");
  const mShort = s.message("human", "Should I add an index?");
  const mWorking = s.message("human", "What about the rollback plan?");
  const mFailed = s.message("human", "Is the naming consistent?");
  const mHalted = s.message("human", "Can you check the tests?");
  s.history.messages.push(mDone, s.message("agent", "Yes."), mShort, mWorking, mFailed, mHalted);
  s.asks.push(
    ask("a-done", mDone.id, s.room.id, { answer: ANSWER }),
    ask("a-short", mShort.id, s.room.id, { answer: "Take a backup first.\nThen run it on staging.", cost: { costUsd: null, basis: "free", inputTokens: 10, outputTokens: 5 }, label: "Llama 3.3 70B", target: LLAMA.target, local: true }),
    ask("a-running", mWorking.id, s.room.id, { status: "running", answer: null, cost: null, endedAt: null, startedAt: Date.now() }),
    ask("a-error", mFailed.id, s.room.id, { status: "error", answer: null, cost: null, error: "Codex couldn't answer: Rate limited.", endedAt: Date.now() - 50_000 }),
    ask("a-stopped", mHalted.id, s.room.id, { status: "stopped", answer: "The tests pass, but I only read the first", cost: { costUsd: null, basis: "plan", inputTokens: 10, outputTokens: 5 }, endedAt: Date.now() - 55_000 }),
  );
  const under = (text: string) => page.locator(".your-msg").filter({ hasText: text }).locator(".ask-card");
  try {
    await s.open();
    await expect(page.locator(".ask-card")).toHaveCount(5);
    // Done: who answered, the answer cut at about six lines, what it cost and how long it took.
    const first = under("Is the migration safe?");
    await first.scrollIntoViewIfNeeded();
    await expect(first.getByRole("heading", { name: "Codex · GPT-5.5" })).toBeVisible();
    await expect(first).toContainText("$0.04 · 12 s");
    const more = first.getByRole("button", { name: "Show more", exact: true });
    await expect(more).toBeVisible();
    const clamped = await first.locator(".ask-answer").evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(clamped.full).toBeGreaterThan(clamped.shown);
    expect(clamped.shown).toBeLessThanOrEqual(clamped.line * 6 + 2);
    await snap(page, "06-card-done.png");
    await more.click();
    await expect(first.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
    await expect(first.locator(".ask-answer")).not.toHaveClass(/clamped/);
    await expect(first).toContainText("blocks writes while it runs.");
    await snap(page, "07-card-done-expanded.png");
    await first.getByRole("button", { name: "Show less", exact: true }).click();
    await expect(first.locator(".ask-answer")).toHaveClass(/clamped/);
    // A short answer has no Show more; a free one says so.
    const second = under("Should I add an index?");
    await expect(second.getByRole("button", { name: "Show more" })).toHaveCount(0);
    await expect(second).toContainText("Free · 12 s");

    // Copy copies the answer as the agent wrote it.
    await first.getByRole("button", { name: "Copy answer", exact: true }).click();
    await expect(first.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await copies(page)).toEqual([ANSWER]);

    // Send to the chat: the answer, quoted, in the message box, which is focused; a notice says so.
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("Thanks.");
    await second.getByRole("button", { name: "Send to the chat", exact: true }).click();
    await expect(box).toHaveValue("Thanks.\n\n> Llama 3.3 70B's answer: Take a backup first.\n> Then run it on staging.\n\n");
    await expect(box).toBeFocused();
    await expect(page.getByText("Added to your message. Add a line or send as is.")).toBeVisible();
    await snap(page, "08-send-to-chat.png");
    await box.fill("");

    // Running: Reading… with Stop; stopping it leaves a Stopped card.
    const running = under("What about the rollback plan?");
    await running.scrollIntoViewIfNeeded();
    await expect(running).toContainText("Reading…");
    await expect(running.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await snap(page, "09-card-running.png");
    await running.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(running).toContainText("Stopped");
    expect(s.stopped).toEqual(["a-running"]);

    // Stopped keeps what came in.
    const stoppedCard = under("Can you check the tests?");
    await stoppedCard.scrollIntoViewIfNeeded();
    await expect(stoppedCard).toContainText("Stopped");
    await expect(stoppedCard).toContainText("The tests pass, but I only read the first");
    await expect(stoppedCard.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await snap(page, "10-card-stopped.png");

    // Error: the hub's sentence (who couldn't answer and why, said once), with Try again, which asks the same one again and drops the failed card.
    const bad = under("Is the naming consistent?");
    await bad.scrollIntoViewIfNeeded();
    await expect(bad.getByRole("alert")).toHaveText("Codex couldn't answer: Rate limited.");
    await snap(page, "11-card-error.png");
    await bad.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => s.removed).toEqual(["a-error"]);
    expect(s.posted).toEqual([{ roomId: s.room.id, messageId: mFailed.id, targets: [CODEX.target] }]);
    await expect(under("Is the naming consistent?")).toHaveCount(1);
    await expect(under("Is the naming consistent?")).toContainText("Reading…");
    await expect(under("Is the naming consistent?")).not.toContainText("couldn't answer");

    // Remove asks twice, and Cancel keeps the card.
    await first.scrollIntoViewIfNeeded();
    await first.getByRole("button", { name: /^Remove/ }).click();
    await expect(first.getByText("Remove this answer?")).toBeVisible();
    await snap(page, "12-card-remove-confirm.png");
    await first.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(first.getByRole("button", { name: /^Remove/ })).toBeVisible();
    expect(s.removed).toEqual(["a-error"]);
    await first.getByRole("button", { name: /^Remove/ }).click();
    await pastDoubleTap(page);
    await first.getByRole("button", { name: "Yes, remove", exact: true }).click();
    await expect(page.locator(".ask-card")).toHaveCount(4);
    expect(s.removed).toEqual(["a-error", "a-done"]);
    // A removal made on another device (the hub says so) takes the card away here too.
    s.send({ t: "ask.removed", id: "a-short", roomId: s.room.id });
    await expect(page.locator(".ask-card")).toHaveCount(3);
    await noHorizontalOverflow(page);
  } finally { await s.cleanup(); }
});

test("Compare: answers to one message are a row you swipe on a phone and columns on a wide screen", async ({ page, request, token, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const asked = s.message("human", "Which database should we pick?");
  s.history.messages.push(asked, s.message("agent", "Postgres."));
  s.asks.push(
    ask("c1", asked.id, s.room.id, { answer: "Postgres. It does everything you listed, and you already run it.", createdAt: Date.now() - 3000 }),
    ask("c2", asked.id, s.room.id, { label: "GPT-5.5 · API key", target: GPT_KEY.target, answer: "SQLite until you need a second writer, then Postgres.", createdAt: Date.now() - 2000, cost: { costUsd: 0.03, basis: "estimated", inputTokens: 1, outputTokens: 1 } }),
    ask("c3", asked.id, s.room.id, { label: "Llama 3.3 70B", target: LLAMA.target, status: "running", answer: null, cost: null, endedAt: null, createdAt: Date.now() - 1000 }),
  );
  try {
    await s.open();
    const row = page.locator(".ask-cards.compare");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".ask-card")).toHaveCount(3);
    await row.scrollIntoViewIfNeeded();
    const info = await row.evaluate((el) => ({ wide: el.scrollWidth > el.clientWidth, snap: getComputedStyle(el).scrollSnapType, overflowX: getComputedStyle(el).overflowX, lefts: [...el.children].map((c) => c.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft), first: (el.children[0] as HTMLElement).offsetWidth, row: el.clientWidth, align: getComputedStyle(el.children[1]).scrollSnapAlign }));
    // A row wider than the screen, each card snapping into place, the next one peeking in at the edge.
    expect(info.wide).toBe(true);
    expect(info.snap).toContain("x");
    expect(["auto", "scroll"]).toContain(info.overflowX);
    expect(info.align).toContain("start");
    expect(info.first).toBeLessThan(info.row);
    expect(info.first).toBeGreaterThan(info.row * 0.7);
    await snap(page, "13-compare.png");
    await noHorizontalOverflow(page);
    if (browserName !== "webkit") {
      // Swiped part of the way, the row settles on a card.
      await row.evaluate((el, left) => el.scrollTo({ left: left - 40, behavior: "instant" }), info.lefts[1]);
      await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(info.lefts[1] - 3);
      expect(await row.evaluate((el) => el.scrollLeft)).toBeLessThan(info.lefts[1] + 3);
    }
    await row.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: "instant" }));
    await expect(row.locator(".ask-card").nth(2)).toContainText("Reading…");
    await expect(row.locator(".ask-card").nth(1)).toContainText("≈$0.03");
    await snap(page, "14-compare-scrolled.png");

    // On a wide screen they're columns side by side, nothing to swipe.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).display)).toBe("grid");
    const boxes = await row.locator(".ask-card").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; }));
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].w - 2);
    expect(boxes[1].y).toBeCloseTo(boxes[0].y, 0);
    expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await snap(page, "15-compare-wide.png");
  } finally { await s.cleanup(); }
});

test("@codex opinion? asks only Codex: nothing goes to the chat, and the card shows the question", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  try {
    await s.open();
    const box = messageBox(page);
    await box.fill("@codex opinion?");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    // No post to /api/rooms/:id/messages (the chat's agent never gets it); one ask, about the newest message, with the question.
    expect(s.calls).toEqual(["asks"]);
    expect(s.posted[0]).toEqual({ roomId: s.room.id, messageId: "ref-2", targets: [CODEX.target], note: "opinion?" });
    await expect(box).toHaveValue("");
    const card = page.locator(".agent-reply").filter({ hasText: "Planned." }).locator(".ask-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("“opinion?”");
    await expect(card).toContainText("Codex · GPT-5.5");
    await expect(page.locator(".your-msg, .agent-reply")).toHaveCount(2);
    // With no words left, the card shows none and the hub asks its own question.
    await box.fill("@codex");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ roomId: s.room.id, messageId: "ref-2", targets: [CODEX.target] });
    expect(s.calls).toEqual(["asks", "asks"]);
  } finally { await s.cleanup(); }
});

test("@ in a chat's message box: naming others asks only them, and the chat's own agent never gets the draft", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  try {
    await s.open();
    const box = messageBox(page);
    const popup = page.getByRole("listbox", { name: "Ask someone else" });
    await box.fill("@");
    await expect(popup).toBeVisible();
    // The ones that can be asked, then the one that can't (greyed, with why); the chat's own agent isn't offered.
    await expect(popup.getByRole("option")).toHaveCount(4);
    await expect(popup.getByRole("option", { name: /@opus/ })).toHaveAttribute("aria-disabled", "true");
    await expect(popup.getByRole("option", { name: /@opus/ })).toContainText("Over its $250 limit");
    await expect(popup).not.toContainText("@claude");
    await expect(popup.getByRole("option", { name: /@gpt-api/ })).toContainText("Costs money");
    await expect(popup.getByRole("option", { name: /@llama/ })).toContainText("Free");
    expect(s.targets.requests).toBe(1);
    await snap(page, "16-mention-popup.png");
    await box.fill("@cod");
    await expect(popup.getByRole("option")).toHaveCount(1);
    await popup.getByRole("option", { name: /@codex/ }).click();
    await expect(box).toHaveValue("@codex ");
    await afterFrames(page);
    const chips = chipRow(page);
    await expect(chips).toContainText("Codex · GPT-5.5 will chime in");
    await expect(chips).not.toContainText("Costs money");
    // The row says who answers and that the chat's own agent won't see it; the button says who it asks, not "Send".
    await expect(chips).toContainText("Only Codex will answer. Claude Code won't see this.");
    await expect(page.getByRole("button", { name: "Ask Codex", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await snap(page, "30-ask-only-chips.png");
    // A name typed in full counts too, and a paid one says so.
    await box.fill("@codex and @gpt");
    await popup.getByRole("option", { name: /@gpt-api/ }).click();
    await expect(box).toHaveValue("@codex and @gpt-api ");
    await afterFrames(page);
    await expect(chips.locator(".ask-chip")).toHaveCount(2);
    await expect(chips.locator(".ask-chip").nth(1)).toContainText("GPT-5.5 · API key will chime in");
    await expect(chips.locator(".ask-chip").nth(1)).toContainText("Costs money");
    await expect(chips).toContainText("Only Codex and GPT-5.5 will answer. Claude Code won't see this.");
    await expect(page.getByRole("button", { name: "Ask 2", exact: true })).toBeVisible();
    await box.pressSequentially("is this right?");
    await snap(page, "17-chips.png");
    // × takes the chip, and its @name, away.
    await chips.getByRole("button", { name: "Don't ask Codex · GPT-5.5" }).click();
    await expect(box).toHaveValue("and @gpt-api is this right?");
    await expect(chips.locator(".ask-chip")).toHaveCount(1);
    expect(s.calls).toEqual([]);

    // Ask: nothing goes to the chat. One ask, about the newest message, with what's left of the draft as the question.
    await page.getByRole("button", { name: "Ask GPT-5.5", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.calls).toEqual(["asks"]);
    expect(s.posted[0]).toEqual({ roomId: s.room.id, messageId: "ref-2", targets: [GPT_KEY.target], note: "and is this right?" });
    await expect(box).toHaveValue("");
    await expect(chips).toHaveCount(0);
    const reply = page.locator(".agent-reply").filter({ hasText: "Planned." });
    await expect(reply.locator(".ask-card")).toHaveCount(1);
    await expect(reply.locator(".ask-card")).toContainText("GPT-5.5 · API key");
    await expect(reply.locator(".ask-card")).toContainText("“and is this right?”");
    await expect(page.locator(".your-msg, .agent-reply")).toHaveCount(2);
    await snap(page, "31-ask-accepted.png");

    // The hub refuses: its words, with Try again; the draft stays, and nothing went to the chat.
    s.asking.status = 409;
    s.asking.body = { error: "GPT-5.5 is busy with another question.", code: "busy" };
    await box.fill("@gpt-api once more?");
    await page.getByRole("button", { name: "Ask GPT-5.5", exact: true }).click();
    const refused = page.locator(".ask-check").filter({ hasText: "GPT-5.5 is busy with another question." });
    await expect(refused).toBeVisible();
    await expect(box).toHaveValue("@gpt-api once more?");
    expect(s.calls).toEqual(["asks", "asks"]);
    await snap(page, "18-ask-refused.png");
    await noHorizontalOverflow(page);
    s.asking.status = 200;
    await refused.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(3);
    expect(s.posted[2]).toEqual({ roomId: s.room.id, messageId: "ref-2", targets: [GPT_KEY.target], note: "once more?" });
    await expect(box).toHaveValue("");
    await expect(refused).toHaveCount(0);
    await expect(reply.locator(".ask-card")).toHaveCount(2);
    expect(s.calls).toEqual(["asks", "asks", "asks"]);

    // Refused over a spending limit: the same way to Settings as the sheet has. The draft stays for when it's raised.
    s.asking.status = 409;
    s.asking.body = { error: "GPT-5.5 reached its $250 limit, so this reply didn't start.", code: "budget" };
    await box.fill("@gpt-api and now?");
    await page.getByRole("button", { name: "Ask GPT-5.5", exact: true }).click();
    const limit = page.locator(".ask-check").filter({ hasText: "reached its $250 limit" });
    await expect(limit.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await snap(page, "40-ask-refused-limit.png");
    await limit.getByRole("button", { name: "Raise limit", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings/);
    expect(s.calls).toEqual(["asks", "asks", "asks", "asks"]);
  } finally { await s.cleanup(); }
});

test("@ chips say who answers and where the chat goes every time someone will be asked: two lines in the chip row, the second as the sheet says it", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  try {
    await s.open();
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    const chips = chipRow(page);
    const only = chips.locator(".ask-chips-only");
    const line = "This sends the chat so far to each one you pick. Models on this machine stay here.";
    // In the row of chips (a group), not beside it.
    const note = chips.getByText(line);
    await expect(page.getByText(line)).toHaveCount(0);
    // Online: one line for all the chips, however many, under them in the same row.
    await box.fill("@codex and @gpt-api what do you think?");
    await expect(chips.locator(".ask-chip")).toHaveCount(2);
    await expect(note).toHaveCount(1);
    await expect(page.getByText(line)).toHaveCount(1);
    await expect(note).toBeVisible();
    await expect(only).toHaveText("Only Codex and GPT-5.5 will answer. Claude Code won't see this.");
    const row = (await chips.boundingBox())!;
    const lastChip = (await chips.locator(".ask-chip").last().boundingBox())!;
    const said = (await note.boundingBox())!;
    expect(said.y).toBeGreaterThanOrEqual(lastChip.y + lastChip.height - 1);
    expect(said.y + said.height).toBeLessThanOrEqual(row.y + row.height + 1);
    await snap(page, "20-chips-note.png");
    await noHorizontalOverflow(page);
    // A model on this machine too: the line is there every time (it says those stay here).
    await box.fill("@llama what do you think?");
    await expect(chips).toContainText("Llama 3.3 70B will chime in");
    await expect(only).toHaveText("Only Llama 3.3 70B will answer. Claude Code won't see this.");
    await expect(note).toHaveCount(1);
    await box.fill("@llama and @codex");
    await expect(chips.locator(".ask-chip")).toHaveCount(2);
    await expect(note).toHaveCount(1);
    // One that can't be asked is sent nothing: no line for it alone, the line once someone who can be asked is named too.
    await box.fill("@opus what do you think?");
    await expect(chips).toContainText("Claude Opus 4.5 can't chime in: Over its $250 limit");
    await expect(page.getByText(line)).toHaveCount(0);
    await expect(only).toHaveCount(0);
    await box.fill("@opus and @llama");
    await expect(chips.locator(".ask-chip")).toHaveCount(2);
    await expect(note).toHaveCount(1);
    await expect(only).toHaveText("Only Llama 3.3 70B will answer. Claude Code won't see this.");
    await box.fill("");
    await expect(page.getByText(line)).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("@ when who can be asked can't be looked up: the notice says so, with Try again and a way to send it as it is", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  s.targets.status = 500;
  s.targets.body = { error: "The hub hit a problem." };
  try {
    await s.open();
    const box = messageBox(page);
    const hint = page.getByRole("alert").filter({ hasText: "Couldn't check who you can ask." });
    const tryAgain = hint.getByRole("button", { name: "Try again", exact: true });
    const asIs = hint.getByRole("button", { name: "Send to the chat as it is", exact: true });
    // Nothing is said until an @ is typed.
    await box.fill("Plan it");
    await expect(hint).toHaveCount(0);
    await box.fill("@");
    await expect(hint).toContainText("Couldn't check who you can ask. The hub hit a problem.");
    await expect(page.getByRole("listbox", { name: "Ask someone else" })).toHaveCount(0);
    // A lone @ names nobody: Try again only. A name typed in full is not lost without a word either: Send sends nothing.
    await expect(asIs).toHaveCount(0);
    await box.fill("@codex is this right?");
    await expect(asIs).toBeVisible();
    await snap(page, "36-list-failed.png");
    await noHorizontalOverflow(page);
    expect((await tryAgain.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await asIs.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(hint).toBeVisible();
    await expect(box).toHaveValue("@codex is this right?");
    expect(s.calls).toEqual([]);
    // Try again with the hub still failing: the notice stays (and the hub was asked again). With the hub well: the chip, no notice.
    const before = s.targets.requests;
    await tryAgain.click();
    await expect.poll(() => s.targets.requests).toBe(before + 1);
    await expect(hint).toBeVisible();
    // A hub that has no such route (an older one) says so in plain words, with the same way out.
    s.targets.status = 404;
    s.targets.body = { error: "Not found." };
    await tryAgain.click();
    await expect(hint).toContainText("This hub can't do that yet. Update the hub on your computer, then try again.");
    await expect(tryAgain).toBeEnabled();
    s.targets.status = 200;
    s.targets.body = CHOICES;
    await tryAgain.click();
    await expect(hint).toHaveCount(0);
    await expect(chipRow(page)).toContainText("Codex · GPT-5.5 will chime in");
    await expect(page.getByRole("button", { name: "Ask Codex", exact: true })).toBeVisible();
    expect(s.calls).toEqual([]);
  } finally { await s.cleanup(); }
});

test("when who can be asked can't be looked up, Send to the chat as it is is the way out, and sends the draft as typed", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  await s.answerMessages();
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  s.targets.status = 500;
  s.targets.body = { error: "The hub hit a problem." };
  try {
    await s.open();
    const box = messageBox(page);
    await box.fill("@opus and @codex is this right?");
    const hint = page.locator(".ask-check").filter({ hasText: "Couldn't check who you can ask." });
    await hint.getByRole("button", { name: "Send to the chat as it is", exact: true }).click();
    await expect.poll(() => s.sentMessages.length).toBe(1);
    expect(s.sentMessages).toEqual([{ text: "@opus and @codex is this right?" }]);
    // Nobody was asked on the side: the person chose the chat.
    expect(s.posted).toEqual([]);
    await expect(box).toHaveValue("");
    await expect(hint).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("a name typed before the list of who can be asked came: Send waits for it, then asks only them", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  let release!: () => void;
  s.targets.gate = new Promise<void>((res) => (release = res));
  try {
    await s.open();
    const box = messageBox(page);
    await box.fill("@codex is this right?");
    await expect.poll(() => s.targets.requests).toBe(1);
    await expect(page.locator(".ask-chip")).toHaveCount(0);
    const send = page.getByRole("button", { name: "Send", exact: true });
    await send.click();
    // It says it's checking, Send is off, the draft stays and nothing has gone anywhere.
    await expect(page.getByRole("status").filter({ hasText: "Checking who you can ask…" })).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(box).toHaveValue("@codex is this right?");
    expect(s.calls).toEqual([]);
    await snap(page, "32-checking.png");
    // The list comes (the one request, shared): the one named is asked, without a tap; nothing goes to the chat.
    release();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]).toEqual({ roomId: s.room.id, messageId: "ref-2", targets: [CODEX.target], note: "is this right?" });
    expect(s.calls).toEqual(["asks"]);
    expect(s.targets.requests).toBe(1);
    await expect(box).toHaveValue("");
    await expect(page.locator(".ask-card")).toHaveCount(1);
    await expect(page.locator(".ask-card")).toContainText("Codex · GPT-5.5");
  } finally { await s.cleanup(); }
});

test("a list that doesn't come: after about 8 seconds Send says it couldn't check, sends nothing, and a late answer puts it right", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  let release!: () => void;
  s.targets.gate = new Promise<void>((res) => (release = res));
  try {
    await s.open();
    const box = messageBox(page);
    await box.fill("@codex is this right?");
    await expect.poll(() => s.targets.requests).toBe(1);
    const started = Date.now();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Checking who you can ask…" })).toBeVisible();
    const gaveUp = page.locator(".ask-check").filter({ hasText: "Couldn't check who you can ask." });
    await expect(gaveUp).toBeVisible({ timeout: 20_000 });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThan(7_000);
    expect(waited).toBeLessThan(15_000);
    await expect(gaveUp).toContainText("The hub is taking too long to answer.");
    await expect(gaveUp.getByRole("button", { name: "Send to the chat as it is", exact: true })).toBeVisible();
    await expect(box).toHaveValue("@codex is this right?");
    expect(s.calls).toEqual([]);
    await snap(page, "33-checking-gave-up.png");
    // The answer comes after all: the notice goes, the chip is there, and asking works.
    release();
    await expect(gaveUp).toHaveCount(0);
    await expect(chipRow(page)).toContainText("Codex · GPT-5.5 will chime in");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.calls).toEqual(["asks"]);
  } finally { await s.cleanup(); }
});

test("an empty chat has nothing to ask about: Send says so, with Take off @names and Send to the chat as it is", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  await s.answerMessages();
  try {
    await s.open();
    const box = messageBox(page);
    await box.fill("@codex opinion?");
    const blocked = page.locator(".ask-check");
    await expect(blocked).toContainText("There's nothing in this chat to ask about yet. Send a message first, or take off @codex.");
    await expect(blocked).toHaveAttribute("role", "alert");
    await snap(page, "34-empty-chat.png");
    // Ask Codex only says it again: nothing goes anywhere.
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect(blocked).toBeVisible();
    expect(s.calls).toEqual([]);
    // Take off @names: the question stays, now for the chat's own agent (the person sends it with Send).
    await blocked.getByRole("button", { name: "Take off @names", exact: true }).click();
    await expect(box).toHaveValue("opinion?");
    await expect(blocked).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    expect(s.calls).toEqual([]);
    // Send to the chat as it is: only this tap lets a draft that names someone reach the chat's agent, and nobody is asked on the side.
    await box.fill("@codex opinion?");
    await blocked.getByRole("button", { name: "Send to the chat as it is", exact: true }).click();
    await expect.poll(() => s.sentMessages.length).toBe(1);
    expect(s.sentMessages).toEqual([{ text: "@codex opinion?" }]);
    expect(s.calls).toEqual(["message"]);
    expect(s.posted).toEqual([]);
    await expect(box).toHaveValue("");
    await expect(chipRow(page)).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test("a draft with files that names someone is blocked: other agents can't see attachments, and the files stay", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  await page.route(`**/api/rooms/${s.room.id}/uploads**`, (r) => r.fulfill({ json: { filename: "notes.txt", name: "notes.txt", path: "/tmp/notes.txt", size: 5, mimeType: "text/plain", url: "/files/notes.txt" } }));
  try {
    await s.open();
    await page.locator('input[aria-label="Choose attachments"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.locator(".composer-file")).toContainText("notes.txt");
    const box = messageBox(page);
    await box.fill("@codex what do you think of the notes?");
    const blocked = page.locator(".ask-check");
    await expect(blocked).toContainText("Other agents can't see attachments yet. Take off the files or the @names.");
    await expect(blocked.getByRole("button", { name: "Take off @names", exact: true })).toBeVisible();
    await expect(blocked.getByRole("button", { name: "Send to the chat as it is", exact: true })).toBeVisible();
    await snap(page, "35-attachments.png");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect(blocked).toBeVisible();
    expect(s.calls).toEqual([]);
    // Take off @names: the file stays, and Send is a plain Send again.
    await blocked.getByRole("button", { name: "Take off @names", exact: true }).click();
    await expect(box).toHaveValue("what do you think of the notes?");
    await expect(blocked).toHaveCount(0);
    await expect(page.locator(".composer-file")).toContainText("notes.txt");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    expect(s.calls).toEqual([]);
    // Or the file goes instead, and then it asks.
    await box.fill("@codex what do you think of the notes?");
    await expect(blocked).toBeVisible();
    await page.getByRole("button", { name: "Remove notes.txt" }).click();
    await expect(blocked).toHaveCount(0);
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]).toMatchObject({ messageId: "ref-2", note: "what do you think of the notes?" });
    expect(s.calls).toEqual(["asks"]);
  } finally { await s.cleanup(); }
});

test("the newest reply is still being written: Send says to ask again when it's done, and then asks", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const planned = s.message("human", "Plan the release");
  const writing = { ...s.message("agent", "Working on the plan"), status: "streaming" };
  s.history.messages.push(planned, writing);
  try {
    await s.open();
    const box = messageBox(page);
    await box.fill("@codex opinion?");
    const blocked = page.locator(".ask-check");
    await expect(blocked).toContainText("That reply is still being written. Ask again when it's done.");
    await expect(blocked.getByRole("button", { name: "Take off @names", exact: true })).toBeVisible();
    await expect(blocked.getByRole("button", { name: "Send to the chat as it is", exact: true })).toBeVisible();
    await snap(page, "37-reply-being-written.png");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    expect(s.calls).toEqual([]);
    // The reply finishes: the notice goes by itself, and the ask is about that reply.
    s.send({ t: "message", message: { ...writing, status: "done", text: "Planned.", updatedAt: Date.now() } });
    await expect(blocked).toHaveCount(0);
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]).toEqual({ roomId: s.room.id, messageId: writing.id, targets: [CODEX.target], note: "opinion?" });
    expect(s.calls).toEqual(["asks"]);
    await expect(page.locator(".agent-reply").filter({ hasText: "Planned." }).locator(".ask-card")).toHaveCount(1);
  } finally { await s.cleanup(); }
});

test("only names that can't be asked, or a question too long to keep: Send says why and leaves the way out", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  try {
    await s.open();
    const box = messageBox(page);
    const blocked = page.locator(".ask-check");
    // Each chip says why that one can't be asked; the notice says what that means for this draft.
    await box.fill("@opus what do you think?");
    await expect(chipRow(page)).toContainText("Claude Opus 4.5 can't chime in: Over its $250 limit");
    await expect(blocked).toContainText("Nobody you named can be asked right now.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await snap(page, "38-nobody-can-be-asked.png");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect(s.calls).toEqual([]);
    await blocked.getByRole("button", { name: "Take off @names", exact: true }).click();
    await expect(box).toHaveValue("what do you think?");
    await expect(blocked).toHaveCount(0);
    // Too long to keep whole: the hub keeps 2,000 characters of a question, and never cuts one short without a word.
    await box.fill(`@codex ${"y".repeat(2001)}`);
    await expect(blocked).toContainText("That's too long to ask others (2,000 characters at most). Shorten it, or send it to the chat as it is.");
    await expect(blocked.getByRole("button")).toHaveText(["Send to the chat as it is"]);
    await snap(page, "41-question-too-long.png");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    expect(s.calls).toEqual([]);
    await box.fill(`@codex ${"y".repeat(2000)}`);
    await expect(blocked).toHaveCount(0);
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0].note).toHaveLength(2000);
  } finally { await s.cleanup(); }
});

test("text that only looks like a name goes to the chat as normal text, after the check when the list isn't here yet", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  await s.answerMessages();
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  let release!: () => void;
  s.targets.gate = new Promise<void>((res) => (release = res));
  try {
    await s.open();
    const box = messageBox(page);
    const send = page.getByRole("button", { name: "Send", exact: true });
    await box.fill("install @types/react and mail me@example.com");
    await expect.poll(() => s.targets.requests).toBe(1);
    await send.click();
    await expect(page.getByRole("status").filter({ hasText: "Checking who you can ask…" })).toBeVisible();
    expect(s.calls).toEqual([]);
    // The list is here and nobody has that name: it was text all along, and goes to the chat as it is.
    release();
    await expect.poll(() => s.sentMessages.length).toBe(1);
    expect(s.sentMessages).toEqual([{ text: "install @types/react and mail me@example.com" }]);
    expect(s.posted).toEqual([]);
    await expect(box).toHaveValue("");
    // With the list already here there is nothing to wait for; the chat's own agent named is text too.
    await box.fill("@claude and @types/node too");
    await expect(page.locator(".ask-chip")).toHaveCount(0);
    await expect(send).toBeVisible();
    await send.click();
    await expect.poll(() => s.sentMessages.length).toBe(2);
    expect(s.sentMessages[1]).toEqual({ text: "@claude and @types/node too" });
    expect(s.calls).toEqual(["message", "message"]);
    expect(s.posted).toEqual([]);
  } finally { await s.cleanup(); }
});

test("another model of the chat's own agent: the line and the button name the model, never Claude Code twice, and the notice names what was typed", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  // How the hub labels another model on the chat's own account: "<agent> · <model>".
  const OPUS_55 = choice("opus55", "Claude Code · Opus 5.5", { sub: "Plan", target: target("claude", "default", "opus-5.5") });
  s.targets.body = [...CHOICES, OPUS_55];
  try {
    await s.open();
    const box = messageBox(page);
    await box.fill("@opus55 is this right?");
    const chips = chipRow(page);
    await expect(chips).toContainText("Claude Code · Opus 5.5 will chime in");
    await expect(chips).toContainText("Only Opus 5.5 will answer. Claude Code won't see this.");
    await expect(chips).not.toContainText("Only Claude Code");
    await expect(page.getByRole("button", { name: "Ask Opus 5.5", exact: true })).toBeVisible();
    // An empty chat has nothing to ask about: the notice says which @name to take off, the one that was typed.
    await expect(page.locator(".ask-check")).toContainText("Send a message first, or take off @opus55.");
    await snap(page, "41-ask-own-agent-model.png");
    expect(s.calls).toEqual([]);
  } finally { await s.cleanup(); }
});

test("while the hub is still answering an ask: text typed meanwhile stays, and a draft the browser reworded meanwhile is still cleared", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  const hold = () => {
    let open!: () => void;
    s.asking.gate = new Promise<void>((res) => (open = res));
    return open;
  };
  try {
    await s.open();
    const box = messageBox(page);
    const ask = page.getByRole("button", { name: "Ask Codex", exact: true });
    // Typed after the draft while the hub hasn't answered: only the draft goes once the ask is accepted, what came after it stays.
    let open = hold();
    await box.fill("@codex opinion?");
    await ask.click();
    await expect.poll(() => s.posted.length).toBe(1);
    await expect(page.getByRole("status").filter({ hasText: "Asking…" })).toBeVisible();
    await box.pressSequentially(" and X");
    await expect(box).toHaveValue("@codex opinion? and X");
    open();
    await expect(box).toHaveValue("and X");
    expect(s.posted).toEqual([{ roomId: s.room.id, messageId: "ref-2", targets: [CODEX.target], note: "opinion?" }]);
    // The browser reworded the draft's last word meanwhile (an autocorrection committed): the draft that was asked still
    // goes, so a second tap can't ask it again.
    open = hold();
    await box.fill("@codex is this rigth");
    await ask.click();
    await expect.poll(() => s.posted.length).toBe(2);
    await box.fill("@codex is this right");
    open();
    await expect(box).toHaveValue("");
    await expect(page.getByRole("status").filter({ hasText: "Asking…" })).toHaveCount(0);
    // ...and what was typed after the reworded word stays.
    open = hold();
    await box.fill("@codex is this rigth");
    await ask.click();
    await expect.poll(() => s.posted.length).toBe(3);
    await box.fill("@codex is this right and X");
    open();
    await expect(box).toHaveValue("and X");
    expect(s.posted).toHaveLength(3);
    expect(s.calls).toEqual(["asks", "asks", "asks"]);
  } finally { await s.cleanup(); }
});

test("a long agent name can't squeeze the message box: the Ask button cuts it short, and its label and title keep the whole name", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  // An account the person named at length (31 characters): the hub's label is "<name> · <model>".
  const TEAM = choice("team", "Quarterly Reporting Team Server · Llama 3.3 70B", { sub: "Online", target: target("codex", "team", "llama-3.3-70b") });
  s.targets.body = [...CHOICES, TEAM];
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  try {
    await s.open();
    const box = messageBox(page);
    const longName = "Ask Quarterly Reporting Team Server";
    /** Whether the text in the button is cut short (it needs more room than the button has). */
    const cut = (name: string) => page.getByRole("button", { name, exact: true }).locator(".ask-label").evaluate((el) => el.scrollWidth > el.clientWidth);
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 800 });
      await box.fill("@team what do you think of the plan?");
      const button = page.getByRole("button", { name: longName, exact: true });
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("title", longName);
      // The chip row still names who answers, whole.
      await expect(chipRow(page)).toContainText("Only Quarterly Reporting Team Server will answer.");
      // The box keeps room to write in, nothing runs off the screen, and the button is still a finger's size.
      expect((await box.boundingBox())!.width).toBeGreaterThanOrEqual(80);
      await noHorizontalOverflow(page);
      expect(await offScreen(page, ".composer, .composer *")).toEqual([]);
      expect(await smallOnes(page, ".composer .send")).toEqual([]);
      expect(await cut(longName)).toBe(true);
      if (width === 320) await snap(page, "42-long-name-320.png");
      // A short name is shown whole, with the box as wide as it ever was.
      await box.fill("@codex what do you think?");
      await expect(page.getByRole("button", { name: "Ask Codex", exact: true })).toBeVisible();
      expect(await cut("Ask Codex")).toBe(false);
      expect((await box.boundingBox())!.width).toBeGreaterThanOrEqual(80);
      await box.fill("");
    }
  } finally { await s.cleanup(); }
});

test("the notices and the Ask button fit at 320, 390 and 430 px, and are a finger's size", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  try {
    await s.open();
    const box = messageBox(page);
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 800 });
      // An empty chat, so the notice is on: long text, several names, the longest button.
      await box.fill("@codex and @gpt-api what do you think of the migration plan? ".repeat(2));
      await expect(page.locator(".ask-check")).toContainText("There's nothing in this chat to ask about yet.");
      await expect(page.getByRole("button", { name: "Ask 2", exact: true })).toBeVisible();
      await noHorizontalOverflow(page);
      expect(await offScreen(page, ".ask-check, .ask-check *, .ask-chips, .ask-chips *, .composer, .composer *")).toEqual([]);
      expect(await smallOnes(page, ".ask-check button, .ask-chip-x, .composer .send")).toEqual([]);
      expect((await box.boundingBox())!.width).toBeGreaterThan(80);
      if (width === 320) await snap(page, "39-narrow-320.png");
      await box.fill("@llama what do you think?");
      await expect(page.getByRole("button", { name: "Ask Llama 3.3 70B", exact: true })).toBeVisible();
      await noHorizontalOverflow(page);
      expect(await offScreen(page, ".composer, .composer *")).toEqual([]);
      expect(await smallOnes(page, ".composer .send")).toEqual([]);
      await box.fill("");
    }
  } finally { await s.cleanup(); }
});

test("nothing runs off the screen at 320, 390 and 430 px, and every button is a finger's size", async ({ page, request, token }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  await s.answerMessages();
  const asked = s.message("human", "https://example.invalid/an/extremely/long/address/that/has/no/break/anywhere/in/it/at/all/ok?x=1 what do you think?");
  s.history.messages.push(asked, s.message("agent", "Fine."));
  const unbroken = "Supercalifragilisticexpialidocious".repeat(4);
  s.asks.push(
    ask("o1", asked.id, s.room.id, { answer: `${unbroken}\n\n${ANSWER}`, createdAt: Date.now() - 4000 }),
    ask("o2", asked.id, s.room.id, { label: "A model with a very long name · and a longer model name than any phone fits", status: "error", answer: null, cost: null, error: `A model with a very long name couldn't answer: ${unbroken} failed.`, createdAt: Date.now() - 3000 }),
    ask("o3", asked.id, s.room.id, { status: "running", answer: null, cost: null, endedAt: null, createdAt: Date.now() - 2000 }),
  );
  const small = (selector: string) => smallOnes(page, selector);
  const inside = (selector: string) => offScreen(page, selector);
  try {
    await s.open();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.locator(".ask-card")).toHaveCount(3);
      const mine = page.locator(".your-msg").filter({ hasText: "an/extremely/long" });
      if (!(await mine.evaluate((el) => el.classList.contains("open")))) await mine.locator(".bubble").first().click({ position: { x: 6, y: 6 } });
      await mine.scrollIntoViewIfNeeded();
      await noHorizontalOverflow(page);
      // The chat itself doesn't scroll sideways, and the cards (a row of them scrolls inside itself) stay on the screen.
      expect(await page.locator(".messages").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await inside(".ask-cards, .msg-actions, .msg-actions button")).toEqual([]);
      expect(await small(".ask-card button, .ask-card .link-action, .msg-actions button")).toEqual([]);
      if (width === 320) await snap(page, "19-narrow-320.png");

      // The sheet.
      const sheet = await openSheet(page, "an/extremely/long");
      await expect(sheet.getByRole("checkbox")).toHaveCount(5);
      await sheet.getByRole("checkbox", { name: "GPT-5.5 · API key" }).check();
      await noHorizontalOverflow(page);
      expect(await inside(".dialog, .dialog *")).toEqual([]);
      expect(await small(".dialog-foot button, .ask-row input")).toEqual([]);
      expect(await sheet.locator(".dialog-body").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(sheet).toBeHidden();

      // The popup and the chips.
      const box = page.getByRole("textbox", { name: "Message", exact: true });
      await box.fill("@");
      await expect(page.getByRole("listbox", { name: "Ask someone else" })).toBeVisible();
      expect(await inside(".ask-pop, .ask-pop *")).toEqual([]);
      expect(await small(".ask-pop button, .ask-pop-off")).toEqual([]);
      await box.fill("@codex and @gpt-api and @opus");
      await expect(page.locator(".ask-chip")).toHaveCount(3);
      // Where the chat goes is said in the chip row, and it fits.
      await expect(page.locator(".ask-chips .ask-chips-note")).toHaveText("This sends the chat so far to each one you pick. Models on this machine stay here.");
      await noHorizontalOverflow(page);
      expect(await inside(".ask-chips, .ask-chip, .ask-chips-note")).toEqual([]);
      expect(await small(".ask-chip-x")).toEqual([]);
      await box.fill("");
      await expect(page.locator(".ask-chip")).toHaveCount(0);
    }
  } finally { await s.cleanup(); }
});

// ---- 0.5, track T11: models on the person's other linked machines (the hub's answers are mocked, as above) ----
const PC = { id: "h_pc0000000001", name: "PC" };
const NAS = { id: "h_nas000000001", name: "NAS" };
/** A row the hub got from another machine: its target names the machine, its label says where it is. */
const elsewhere = (machine: { id: string; name: string }, c: ReturnType<typeof choice>) => ({ ...c, machine, target: { ...c.target, machine: machine.id } });
const QWEN = elsewhere(PC, choice("qwen3-on-pc", "Qwen3 · qwen3-30b · on the PC", { sub: "", target: target("claude", "ep1", "qwen3-30b"), local: true }));
const CLAUDE_PC = elsewhere(PC, choice("claude-on-pc", "Claude Code · Opus 5.5 · on the PC", { sub: "Plan", target: target("claude", "default", "opus") }));
const KEY_PC = elsewhere(PC, choice("work-key-on-pc", "Claude Code (Work key) · Opus 5.5 · on the PC", { sub: "API key", target: target("claude", "k1", "opus"), paid: "yes", available: false, why: "Over its $12 limit", typicalCostUsd: 0.12 }));
const LLAMA_NAS = elsewhere(NAS, choice("llama-on-nas", "Llama 3.3 70B · on the NAS", { sub: "", target: target("codex", "nas-llama", "llama-3.3-70b"), local: true }));
const NAS_DOWN = { id: NAS.id, name: NAS.name, why: "The NAS didn't answer." };

test("Ask others on your other machines: rows grouped by machine, one that didn't answer is a line with Try again, and the card names the machine", async ({ page, request, token }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const asked = s.message("human", "Is this migration safe to run on production?");
  s.history.messages.push(asked, s.message("agent", "Yes, if you take a backup first."));
  s.targets.body = { choices: [CODEX, GPT_KEY, QWEN, CLAUDE_PC, KEY_PC], machines: [NAS_DOWN] };
  const urls: string[] = [];
  await page.route("**/api/asks/targets**", (r) => { urls.push(r.request().url()); return r.fallback(); });
  try {
    await s.open();
    const sheet = await openSheet(page, "Is this migration safe");
    // This machine first, then each other machine under its own heading.
    await expect(sheet.getByRole("heading", { name: "On this machine" })).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "On the PC" })).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "On the NAS" })).toBeVisible();
    const group = (name: string) => sheet.locator(".ask-group").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(group("On this machine").getByRole("checkbox")).toHaveCount(2);
    await expect(group("On the PC").getByRole("checkbox")).toHaveCount(3);
    await expect(group("On the NAS").getByRole("checkbox")).toHaveCount(0);
    const pcRow = (name: string) => group("On the PC").locator("li").filter({ has: page.getByRole("checkbox", { name, exact: true }) });
    // What it costs (as its machine says) and where it runs: another of your machines, not "Online" or "On this machine".
    await expect(pcRow("Qwen3 · qwen3-30b · on the PC")).toContainText("Free");
    await expect(pcRow("Qwen3 · qwen3-30b · on the PC")).toContainText("On another of your machines");
    await expect(pcRow("Claude Code · Opus 5.5 · on the PC")).toContainText("Uses your plan");
    await expect(pcRow("Claude Code · Opus 5.5 · on the PC")).toContainText("On another of your machines");
    await expect(group("On this machine").locator("li").first()).not.toContainText("On another of your machines");
    // What can't be asked is greyed, last in its group, with why.
    await expect(pcRow("Claude Code (Work key) · Opus 5.5 · on the PC")).toContainText("Over its $12 limit");
    await expect(sheet.getByRole("checkbox", { name: "Claude Code (Work key) · Opus 5.5 · on the PC" })).toBeDisabled();
    expect(await group("On the PC").locator("li").last().innerText()).toContain("Work key");
    // The machine that didn't answer is said once, muted, with its own Try again.
    await expect(sheet.getByText("The NAS didn't answer.")).toHaveCount(1);
    await expect(group("On the NAS").getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(sheet.getByText("Ones on your other machines get it over your own link.")).toHaveCount(0);
    // The sheet asks for the machines that couldn't answer too (the dev build may ask twice on opening).
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes("machines=1") && !u.includes("refresh"))).toBe(true);
    const lookedUp = urls.length;
    await snap(page, "01-sheet-machines.png");
    await noHorizontalOverflow(page);
    // The "?" says where Free runs: on one of your machines (these rows sit under "On the PC").
    await sheet.getByRole("button", { name: "What do these labels mean?" }).click();
    await expect(sheet.getByRole("note")).toContainText("Free is a model on one of your machines.");
    await expect(sheet.getByRole("note")).not.toContainText("on this machine");
    await sheet.getByRole("button", { name: "What do these labels mean?" }).click();

    // Picking one on another machine adds the sentence about the link to the footer.
    await sheet.getByRole("checkbox", { name: "Qwen3 · qwen3-30b · on the PC" }).check();
    await expect(sheet.getByText("This sends the chat so far to each one you pick. Models on this machine stay here. Ones on your other machines get it over your own link.")).toBeVisible();
    await expect(sheet.getByText("Costs money:")).toHaveCount(0); // free, on its own machine
    await snap(page, "02-sheet-picked-on-pc.png");
    await sheet.getByRole("checkbox", { name: "Qwen3 · qwen3-30b · on the PC" }).uncheck();
    await expect(sheet.getByText("Ones on your other machines get it over your own link.")).toHaveCount(0);
    await sheet.getByRole("checkbox", { name: "Qwen3 · qwen3-30b · on the PC" }).check();

    // Try again asks the hub to look at the other machines again; the NAS is there now, and the pick stays.
    s.targets.body = { choices: [CODEX, GPT_KEY, QWEN, CLAUDE_PC, KEY_PC, LLAMA_NAS], machines: [] };
    await group("On the NAS").getByRole("button", { name: "Try again", exact: true }).click();
    await expect(group("On the NAS").getByRole("checkbox", { name: "Llama 3.3 70B · on the NAS" })).toBeVisible();
    await expect(sheet.getByText("The NAS didn't answer.")).toHaveCount(0);
    expect(urls.length).toBe(lookedUp + 1);
    expect(urls.at(-1)).toContain("refresh=1");
    await expect(sheet.getByRole("checkbox", { name: "Qwen3 · qwen3-30b · on the PC" })).toBeChecked();
    await snap(page, "03-sheet-retried.png");

    // Asking: the targets carry their machine, and the card says where it ran.
    await sheet.getByRole("checkbox", { name: "Codex · GPT-5.5" }).check();
    await sheet.getByLabel("Your question (optional)").fill("Anything wrong with the rollback?");
    await sheet.getByRole("button", { name: "Ask 2", exact: true }).click();
    await expect(sheet).toBeHidden();
    expect(s.posted).toEqual([{ roomId: s.room.id, messageId: asked.id, targets: [CODEX.target, QWEN.target], note: "Anything wrong with the rollback?" }]);
    expect(s.calls).toEqual(["asks"]);
    const cards = page.locator(".ask-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1).getByRole("heading", { name: "Qwen3 · qwen3-30b · on the PC" })).toBeVisible();
    await expect(cards.nth(1)).toContainText("Reading…");
    s.send({ t: "ask", ask: { ...s.asks[0], status: "done", answer: "Safe, with a backup.", endedAt: s.asks[0].startedAt + 12_000 } });
    s.send({ t: "ask", ask: { ...s.asks[1], status: "error", answer: null, cost: null, error: "The PC didn't answer. Check it's on, then Try again.", endedAt: s.asks[1].startedAt + 3_000 } });
    await expect(cards.nth(1).getByRole("alert")).toHaveText("The PC didn't answer. Check it's on, then Try again.");
    await snap(page, "04-card-pc-didnt-answer.png");
    await noHorizontalOverflow(page);

    // Try again on the card asks the same machine's model again (the target keeps its machine) and drops the failed card.
    const failed = s.asks[1].id;
    await cards.nth(1).getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(2);
    expect(s.posted[1]).toEqual({ roomId: s.room.id, messageId: asked.id, targets: [QWEN.target], note: "Anything wrong with the rollback?" });
    await expect.poll(() => s.removed).toEqual([failed]);
    const again = s.asks.at(-1);
    s.send({ t: "ask", ask: { ...again, status: "done", answer: "Take the backup first.", cost: { costUsd: 0, basis: "free", inputTokens: 900, outputTokens: 60 }, endedAt: again.startedAt + 12_000 } });
    await expect(cards.nth(1)).toContainText("Take the backup first.");
    await expect(cards.nth(1)).toContainText("Free · 12 s");
    await expect(cards.nth(1).getByRole("heading", { name: "Qwen3 · qwen3-30b · on the PC" })).toBeVisible();
    await snap(page, "05-card-pc-answered.png");
  } finally { await s.cleanup(); }
});

test("@ lists models on your other machines by handle, the chip says where, and the draft asks only them", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  // The message box asks for the other machines' rows too (a hub from before 0.5 would answer with a plain list: the same).
  s.targets.body = { choices: [...CHOICES, QWEN, CLAUDE_PC, KEY_PC], machines: [] };
  try {
    await s.open();
    const box = messageBox(page);
    const popup = page.getByRole("listbox", { name: "Ask someone else" });
    await box.fill("@");
    await expect(popup).toBeVisible();
    await expect(popup.getByRole("option", { name: /@qwen3-on-pc/ })).toContainText("Qwen3 · qwen3-30b · on the PC");
    await expect(popup.getByRole("option", { name: /@qwen3-on-pc/ })).toContainText("Free");
    await expect(popup.getByRole("option", { name: /@work-key-on-pc/ })).toHaveAttribute("aria-disabled", "true");
    // Claude Code on the PC is not this chat's own Claude Code: it's offered, the chat's own isn't.
    await expect(popup.getByRole("option", { name: /@claude-on-pc/ })).toBeVisible();
    await expect(popup.getByRole("option", { name: /@claude(?!-)/ })).toHaveCount(0);
    await snap(page, "06-mention-popup-machines.png");
    await box.fill("@pc");
    await expect(popup.getByRole("option")).toHaveCount(3); // the machine's name finds them too
    await box.fill("@qw");
    await popup.getByRole("option", { name: /@qwen3-on-pc/ }).click();
    await expect(box).toHaveValue("@qwen3-on-pc ");
    await afterFrames(page);
    const chips = chipRow(page);
    await expect(chips).toContainText("Qwen3 · qwen3-30b · on the PC will chime in");
    await expect(chips).toContainText("Only Qwen3 on the PC will answer. Claude Code won't see this.");
    await expect(chips.locator(".ask-chips-note")).toHaveText("This sends the chat so far to each one you pick. Models on this machine stay here. Ones on your other machines get it over your own link.");
    await expect(page.getByRole("button", { name: "Ask Qwen3 on the PC", exact: true })).toBeVisible();
    await box.pressSequentially("is this safe?");
    await snap(page, "07-chip-on-another-machine.png");
    await noHorizontalOverflow(page);
    // The button's own words are short (where it runs is in the chip row and in its accessible name): nothing is cut off, and the box keeps its room.
    const label = page.getByRole("button", { name: "Ask Qwen3 on the PC", exact: true }).locator(".ask-label");
    await expect(label).toHaveText("Ask Qwen3");
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await box.boundingBox())!.width).toBeGreaterThanOrEqual(150);
    await page.getByRole("button", { name: "Ask Qwen3 on the PC", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]).toMatchObject({ roomId: s.room.id, targets: [QWEN.target], note: "is this safe?" });
    expect(s.calls).toEqual(["asks"]); // nothing went to the chat's own agent
    await expect(box).toHaveValue("");
  } finally { await s.cleanup(); }
});

test("a draft that names a model on another machine stays blocked when that machine stops answering: it never goes to the chat's own agent", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  // The list of who can be asked is read again once it's 30 seconds old: the page's clock is moved on by hand instead of waiting.
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    const clock = window as unknown as { skew: number };
    clock.skew = 0;
    Date.now = () => real() + clock.skew;
  });
  const later = (ms: number) => page.evaluate((n) => { (window as unknown as { skew: number }).skew += n; }, ms);
  const s = await scenario(page, request, token);
  s.history.messages.push(s.message("human", "Plan the release"), s.message("agent", "Planned."));
  s.targets.body = { choices: [...CHOICES, QWEN], machines: [] };
  try {
    await s.open();
    const box = messageBox(page);
    const send = page.locator(".composer .send");
    await box.fill("@qwen3-on-pc is this safe?");
    await expect(chipRow(page)).toContainText("Qwen3 · qwen3-30b · on the PC will chime in");
    await expect(send).toHaveAttribute("aria-label", "Ask Qwen3 on the PC");
    // 30 seconds on, the PC doesn't answer: its rows aren't in the list any more, but the draft still names it.
    s.targets.body = { choices: CHOICES, machines: [{ id: PC.id, name: PC.name, why: "The PC didn't answer." }] };
    await later(31_000);
    const before = s.targets.requests;
    await box.pressSequentially(" Really?");
    await expect.poll(() => s.targets.requests).toBeGreaterThan(before);
    await expect(chipRow(page).locator(".ask-chip")).toHaveCount(1);
    await expect(chipRow(page).locator(".ask-chip")).toContainText("Qwen3 · qwen3-30b · on the PC can't chime in: The PC didn't answer.");
    // Send isn't "Ask ...", and sends nothing at all: the chat's own agent never gets a draft that names someone else.
    await expect(send).toHaveAttribute("aria-label", "Send");
    await expect(page.getByRole("alert").filter({ hasText: "Nobody you named can be asked right now." })).toBeVisible();
    await send.click();
    await expect(box).toHaveValue("@qwen3-on-pc is this safe? Really?");
    expect(s.calls).toEqual([]);
    expect(s.posted).toEqual([]);
    await snap(page, "10-chip-machine-went-quiet.png");
    await noHorizontalOverflow(page);
    // The PC is back at the next read: the chip is live again, and Ask asks it.
    s.targets.body = { choices: [...CHOICES, QWEN], machines: [] };
    await later(31_000);
    await box.pressSequentially(" ok");
    await expect(chipRow(page)).toContainText("Qwen3 · qwen3-30b · on the PC will chime in");
    await expect(send).toHaveAttribute("aria-label", "Ask Qwen3 on the PC");
  } finally { await s.cleanup(); }
});

test("the sheet with machines fits at 320, 390 and 430 px, even with a hostname for a name, and its buttons are a finger's size", async ({ page, request, token }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const asked = s.message("human", "What do you think of the plan?");
  s.history.messages.push(asked, s.message("agent", "Fine."));
  const LONG = { id: "h_long0000001", name: "studio-mac-in-the-basement-of-the-old-office.tail1234.ts.net" };
  const onLong = elsewhere(LONG, choice("claude-on-studio", `Claude Code · Opus 5.5 · on the ${LONG.name}`, { sub: "Plan", target: target("claude", "default", "opus") }));
  s.targets.body = { choices: [CODEX, QWEN, KEY_PC, onLong], machines: [NAS_DOWN, { id: "h_gone0000001", name: LONG.name.replace("studio", "attic"), why: `The ${LONG.name.replace("studio", "attic")} didn't answer.` }] };
  try {
    await s.open();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 800 });
      const sheet = await openSheet(page, "What do you think of the plan?");
      await expect(sheet.getByRole("checkbox")).toHaveCount(4);
      await expect(sheet.locator(".ask-machine-note")).toHaveCount(2);
      await sheet.getByRole("checkbox", { name: "Qwen3 · qwen3-30b · on the PC" }).check();
      await sheet.getByRole("checkbox", { name: `Claude Code · Opus 5.5 · on the ${LONG.name}` }).check();
      await noHorizontalOverflow(page);
      expect(await offScreen(page, ".dialog, .dialog *")).toEqual([]);
      expect(await sheet.locator(".dialog-body").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await smallOnes(page, ".dialog-foot button, .ask-row input, .ask-machine-note button")).toEqual([]);
      if (width === 320) await snap(page, "08-sheet-machines-320.png");
      if (width === 430) await snap(page, "09-sheet-machines-430.png");
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(sheet).toBeHidden();
    }
  } finally { await s.cleanup(); }
});
