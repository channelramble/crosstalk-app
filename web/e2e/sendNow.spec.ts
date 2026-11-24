import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Approval, Member, Message, Room, StateSnapshot, Turn } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// The one rule for a message sent while the agent works, on a phone (390 and 320 px): it goes into the running reply by
// itself, at the agent's next step. One line under it says when it's read, with one button, Interrupt, to be read sooner.
// Stop stops at once. Anything left unanswered says "Not answered" with Try again. Nothing waits for a tap: there is no
// "Send now" bar, and Stop doesn't ask which. (A chat once said "Your message is waiting for this reply to finish." with
// Send now while no reply was running, and Send now said "It's being answered already, or the reply just ended.":
// neither was true.) An account switch or tighter permissions still hold a message, and say so, with no button.
//
// Two kinds of test. Against the test hub, with the scripted mock agent (its `steer`, `delays`, `helpers` and `limit`
// knobs): what really becomes of a message, that it's answered once and never lost. And with the hub's answers played
// (`played`): what the app draws for a state, and what a tap asks the hub for; an older hub (no HubInfo.flowsIn) is
// played that way too. Nothing here sends a prompt to a real model, and no agent CLI runs.

const HUB = "http://127.0.0.1:8451";
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const WIDTHS = [390, 320];

const HELD_FOR_PERMISSIONS = "Your message is waiting for its helpers to finish, so your permission change applies first.";

/** The line under a message that the running reply has been handed and hasn't read yet. */
const READS = (who: string) => new RegExp(`^${who} reads this (after its current step|at its next step)\\.$`);

/** A chat with the mock agent (the test hub's agents are group chats of one). */
async function mockChat(request: APIRequestContext, token: string, name: string, config: Record<string, unknown>, permissionMode?: Member["permissionMode"]) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode: "direct" } })).json();
  const member: Member = await (await request.post(`${HUB}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "tester", config: { delayMs: 10, ...config }, ...(permissionMode ? { permissionMode } : {}) } })).json();
  const agent = async (): Promise<Member> => ((await (await request.get(`${HUB}/api/state`, { headers })).json()).members as Member[]).find((m) => m.id === member.id)!;
  return { room, member, headers, agent, remove: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

const sender = (page: Page) => async (text: string) => {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
};

/**
 * From here on, notes the old bar and the old buttons the moment either shows, however briefly: "nothing to tap but
 * Interrupt" holds for the whole of a test, not just where it looks. `seen` says what showed; `asked`, whether Stop asked which.
 */
async function watchForOldWays(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { oldWaysSeen: string[] }).oldWaysSeen = seen;
    const buttons = new Set(["Send now", "Sending…", "Answer now", "Read it now", "Stop it and read now"]);
    const look = () => {
      // (A paused line, with nothing to tap, is how a usage limit or a change that must apply first is said: not the bar.)
      for (const bar of document.querySelectorAll(".send-now:not(.paused)")) seen.push(`bar: ${bar.textContent}`);
      for (const b of document.querySelectorAll("button")) if (buttons.has(b.textContent?.trim() ?? "")) seen.push(`button: ${b.textContent}`);
      for (const d of document.querySelectorAll("[role=dialog]")) if (/Stop everything|Stop and answer my message/.test(d.textContent ?? "")) seen.push("dialog: Stop asked which");
    };
    look();
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  return { seen: () => page.evaluate(() => (window as unknown as { oldWaysSeen: string[] }).oldWaysSeen) };
}

/** A chat with the mock agent open on the phone, nothing running yet. */
async function openChat(page: Page, request: APIRequestContext, token: string, name: string, config: Record<string, unknown> = {}) {
  const chat = await mockChat(request, token, name, config);
  await page.goto(`/#/room/${chat.room.id}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  return { ...chat, send: sender(page), oldWays: await watchForOldWays(page) };
}

/** A chat with a helper at work for longer than a test runs and no reply running, open on the phone. */
async function helperAtWork(page: Page, request: APIRequestContext, token: string, name: string, config: Record<string, unknown> = {}, permissionMode?: Member["permissionMode"]) {
  const chat = await mockChat(request, token, name, { helpers: { ms: 120_000 }, ...config }, permissionMode);
  await request.post(`${HUB}/api/rooms/${chat.room.id}/messages`, { headers: chat.headers, data: { text: "Install the browser" } });
  await expect.poll(async () => (await chat.agent()).status).toBe("idle");
  await page.goto(`/#/room/${chat.room.id}`);
  await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
  return { ...chat, send: sender(page), oldWays: await watchForOldWays(page) };
}

/** The line fits its message's column, wraps instead of being cut off, and its button is a finger's tap. */
async function lineFits(page: Page, line = page.locator(".msg-quiet")) {
  await noHorizontalOverflow(page);
  const fit = await line.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const b = el.querySelector("button")?.getBoundingClientRect();
    return { left: r.left, right: r.right, cut: el.scrollWidth > el.clientWidth + 1, button: b ? { left: b.left, right: b.right, height: b.height, width: b.width } : null };
  });
  const width = page.viewportSize()!.width;
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(width);
  expect(fit.cut).toBe(false);
  if (fit.button) {
    expect(fit.button.left).toBeGreaterThanOrEqual(fit.left - 1);
    expect(fit.button.right).toBeLessThanOrEqual(fit.right + 1);
    // Easy to tap, without shouting: at least 32 px of button (and 44 px to land a finger on, tried where it's tapped).
    expect(fit.button.height).toBeGreaterThanOrEqual(32);
    expect(fit.button.width).toBeGreaterThanOrEqual(44);
  }
}

// ---- Against the test hub: what really becomes of a message ----

for (const width of WIDTHS) {
  test(`at ${width} px a message sent while the agent works goes into its reply by itself: one line says when it's read, with Interrupt, and it's answered once`, async ({ page, request, token }) => {
    await page.setViewportSize({ width, height: 844 });
    // An agent that takes a message mid-reply (as Claude Code and Codex do); its first reply runs a few seconds.
    const chat = await openChat(page, request, token, `Into the reply ${width}`, { steer: true, delays: [10_000, 10] });
    try {
      await chat.send("Build the setup step");
      await expect(page.locator(".chat-status")).toBeVisible();
      await chat.send("Also add tests");
      const line = page.locator(".msg-quiet");
      await expect(line.locator(".msg-quiet-text")).toHaveText(READS("@tester"));
      await expect(line.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
      // Under the message it's about, and nowhere else.
      await expect(page.locator(".your-msg").filter({ hasText: "Also add tests" }).locator(".msg-quiet")).toHaveCount(1);
      await expect(page.locator(".msg-quiet")).toHaveCount(1);
      await lineFits(page);
      await page.screenshot({ ...shot(`rule-handed-live-${width}.png`), animations: "disabled" });
      // Read in that reply and answered below it, once: no reply of its own for it, and the line goes.
      await expect(page.locator(".msg.agent").last()).toContainText("Got your message: “Also add tests”.", { timeout: 15_000 });
      await expect(line).toHaveCount(0);
      await expect.poll(async () => (await chat.agent()).status).toBe("idle");
      await expect(page.getByText("Turn 2", { exact: false })).toHaveCount(0);
      await expect(page.locator(".not-answered")).toHaveCount(0);
      expect(await chat.oldWays.seen()).toEqual([]);
    } finally {
      await chat.remove();
    }
  });
}

test("a reply that can't take a message mid-way: it says the message goes when the reply ends, and Interrupt stops the reply and answers it, once", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // No mid-reply form; its first reply would run far longer than the test.
  const chat = await openChat(page, request, token, "Goes when it ends", { delays: [60_000, 10] });
  try {
    await chat.send("Build the setup step");
    await expect(page.locator(".chat-status")).toBeVisible();
    await chat.send("Also add tests");
    const line = page.locator(".msg-quiet");
    await expect(line.locator(".msg-quiet-text")).toHaveText("Goes when @tester's reply ends.");
    await lineFits(page);
    await page.screenshot({ ...shot("rule-goes-when-ends-live-390.png"), animations: "disabled" });
    // Interrupt: the hub is asked to stop the reply and keep what waits.
    const asked = page.waitForRequest((r) => r.url().endsWith(`/api/rooms/${chat.room.id}/stop`) && r.method() === "POST");
    await line.getByRole("button", { name: "Interrupt", exact: true }).click();
    expect((await asked).postDataJSON()).toMatchObject({ keepWaiting: true });
    // The reply stops, and the message is answered next, in a reply of its own.
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2", { timeout: 15_000 });
    await expect(page.locator(".msg.agent").last()).toContainText("Also add tests");
    await expect(line).toHaveCount(0);
    await expect.poll(async () => (await chat.agent()).status).toBe("idle");
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    await expect(page.locator(".not-answered")).toHaveCount(0);
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("left alone, a message behind a reply that can't take it goes when that reply ends, with nothing tapped", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Its first reply runs long enough for the line to show (it waits a moment, so it never flashes), and no longer.
  const chat = await openChat(page, request, token, "Goes by itself", { delays: [10_000, 10] });
  try {
    await chat.send("Build the setup step");
    await expect(page.locator(".chat-status")).toBeVisible();
    await chat.send("Also add tests");
    const line = page.locator(".msg-quiet");
    await expect(line.locator(".msg-quiet-text")).toHaveText("Goes when @tester's reply ends.");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2", { timeout: 15_000 });
    await expect(page.locator(".msg.agent").last()).toContainText("Also add tests");
    await expect(line).toHaveCount(0);
    // The first reply wasn't cut short for it.
    await expect(page.locator(".msg.agent").filter({ hasText: "Turn 1" })).toContainText("Here's my take.");
    await expect.poll(async () => (await chat.agent()).status).toBe("idle");
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("Stop with a message the reply hasn't read: it stops at once, without asking which, the message says Not answered, and Try again answers it, once", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await openChat(page, request, token, "Stop stops", { steer: true, delays: [60_000, 10] });
  try {
    await chat.send("Build the setup step");
    await expect(page.locator(".chat-status")).toBeVisible();
    await chat.send("Also add tests");
    await expect(page.locator(".msg-quiet .msg-quiet-text")).toHaveText(READS("@tester"));
    const asked = page.waitForRequest((r) => r.url().endsWith(`/api/rooms/${chat.room.id}/stop`) && r.method() === "POST");
    await page.getByRole("button", { name: "Stop all agents", exact: true }).click();
    expect((await asked).postDataJSON()).toEqual({});
    // Stopped, and it stays stopped: nothing answers the message by itself.
    await expect.poll(async () => (await chat.agent()).status).toBe("idle");
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
    const left = page.locator(".your-msg").filter({ hasText: "Also add tests" }).locator(".not-answered");
    await expect(left).toContainText("Not answered");
    await expect(page.getByText("Turn 2", { exact: false })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("rule-stopped-not-answered-live-390.png"), animations: "disabled" });
    await left.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(page.locator(".msg.agent").last()).toContainText("Also add tests");
    await expect(page.locator(".not-answered")).toHaveCount(0);
    await expect.poll(async () => (await chat.agent()).status).toBe("idle");
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("Stop while new settings wait for the helpers: it stops at once, and Try again under the message answers it without waiting for them", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Stop under a hold", { steer: true, delays: [10, 60_000, 10] });
  try {
    await request.patch(`${HUB}/api/members/${chat.member.id}`, { headers: chat.headers, data: { permissionMode: "edits" } });
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await chat.send("Also add tests");
    await expect(page.locator(".msg-quiet .msg-quiet-text")).toHaveText(READS("@tester"));
    await page.getByRole("button", { name: "Stop all agents", exact: true }).click();
    // Stopped, and it stays stopped: the message is yours again, under a hold that may last for hours.
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    const again = page.locator(".not-answered").getByRole("button", { name: "Try again", exact: true });
    await expect(again).toBeVisible();
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await again.click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(page.locator(".msg.agent").last()).toContainText("Also add tests");
    await expect(page.locator(".not-answered")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    await expect(page.getByText("Turn 4", { exact: false })).toHaveCount(0);
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("a usage limit stops the reply your message waits behind: it says when it goes, with nothing to tap that can't work", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The first reply runs a few seconds, then the 5-hour limit stops it; the reply that carries on answers.
  const chat = await openChat(page, request, token, "Limit behind a reply", { limit: { label: "5-hour", resetsAt: Date.now() + 33 * 60_000, times: 1, afterMs: 8000 } });
  try {
    await chat.send("research what happened");
    await expect(page.locator(".chat-status")).toBeVisible();
    // A second message waits behind the reply, and says so.
    await chat.send("and send the link");
    await expect(page.locator(".msg-quiet .msg-quiet-text")).toHaveText("Goes when @tester's reply ends.");

    // The limit stops the reply. The truth, in plain words: paused until the reset, and the message goes first.
    const paused = page.locator(".send-now.paused");
    await expect(paused).toHaveText(/^Paused until your usage limit resets at (\w{3} )?\d{1,2}:\d{2}\s?[AP]M\. Your message goes first when it does\.$/, { timeout: 15_000 });
    await expect(paused).toHaveAttribute("role", "status");
    await expect(page.getByText("being answered already", { exact: false })).toHaveCount(0);
    // Nothing offered while the account has nothing to answer with: no Interrupt, no Try again under the message. The
    // honest way on is the waiting line's Try now.
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
    await expect(page.locator(".not-answered")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Carries on at" })).toBeVisible();
    // The message is still yours, unanswered: nothing was handed anywhere.
    await expect(page.locator(".msg.agent.waiting")).toHaveCount(1);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-limit.png"), animations: "disabled" });

    // Try now: the reply that carries on reads it first, and the line goes.
    await page.getByRole("button", { name: "Try now", exact: true }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(page.locator(".send-now")).toHaveCount(0);
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("new settings wait for the agent's helpers: your messages start at once, with no bar, no button and one quiet note", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Going past helpers");
  try {
    // A setting changes while the helper works: it applies once the helper is done, and nothing else waits for that.
    await request.patch(`${HUB}/api/members/${chat.member.id}`, { headers: chat.headers, data: { permissionMode: "edits" } });
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");

    await chat.send("Did it switch my model?");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    // The reply answers the question. (The note below is for the person: it used to be the newest thing the agent read.)
    await expect(page.locator(".msg.agent").last()).toContainText("Did it switch my model?");
    const note = page.getByText("Your new settings apply when @tester's helpers finish. Until then it answers with the settings it started with.", { exact: true });
    await expect(note).toHaveCount(1);
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-flowing.png"), animations: "disabled" });

    // Another message: another reply, and no second note.
    await chat.send("And the docs?");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(note).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    // Each answered once.
    await page.waitForTimeout(150);
    await expect(page.getByText("Turn 4", { exact: false })).toHaveCount(0);
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("a reply that fails while new settings wait for the helpers: Try again is there at once, not when the helpers finish", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Fails under a hold", { failTurns: [2] });
  try {
    await request.patch(`${HUB}/api/members/${chat.member.id}`, { headers: chat.headers, data: { permissionMode: "edits" } });
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Mock failure");
    // It still says what waits, and that's no reason to wait to try again: helpers can run for hours.
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    const again = page.getByRole("button", { name: "Try again", exact: true });
    await expect(again).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-failed-hold.png"), animations: "disabled" });
    await again.click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

for (const width of WIDTHS) {
  test(`at ${width} px tighter permissions waiting for the helpers hold a message: it says which change waits, with no button, and nothing answers it around the change`, async ({ page, request, token }) => {
    await page.setViewportSize({ width, height: 844 });
    const chat = await helperAtWork(page, request, token, `Held for permissions ${width}`, {}, "full");
    try {
      // Full access to Ask first while the helper works: the process on Full access must not answer what comes next.
      await request.patch(`${HUB}/api/members/${chat.member.id}`, { headers: chat.headers, data: { permissionMode: "ask" } });
      await expect.poll(async () => (await chat.agent()).statusDetail).toBe("Finishing helpers before your permission change applies");

      await chat.send("Delete the old build folder");
      const bar = page.locator(".send-now");
      await expect(bar).toHaveText(HELD_FOR_PERMISSIONS);
      await expect(bar).toHaveClass(/\bpaused\b/);
      await expect(bar.getByRole("button")).toHaveCount(0);
      // Not "going into the reply", and not "not answered": neither would be true.
      await expect(page.locator(".msg-quiet")).toHaveCount(0);
      await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your permission change applies");
      await noHorizontalOverflow(page);
      await page.screenshot({ ...shot(`send-now-permissions-${width}.png`), animations: "disabled" });
      // It holds: past the moment Not answered would show, nothing has answered it and nothing offers to.
      await page.waitForTimeout(3000);
      await expect(bar).toHaveText(HELD_FOR_PERMISSIONS);
      await expect(page.getByText("Turn 2", { exact: false })).toHaveCount(0);
      await expect(page.locator(".not-answered")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
      expect(await chat.oldWays.seen()).toEqual([]);
    } finally {
      await chat.remove();
    }
  });
}

/** Tighter permissions waiting for the helpers, a message held for them, then Stop: the message is yours again, with Try again under it. */
async function heldThenStopped(page: Page, request: APIRequestContext, token: string, name: string) {
  const chat = await helperAtWork(page, request, token, name, {}, "full");
  await request.patch(`${HUB}/api/members/${chat.member.id}`, { headers: chat.headers, data: { permissionMode: "ask" } });
  await expect.poll(async () => (await chat.agent()).statusDetail).toBe("Finishing helpers before your permission change applies");
  await chat.send("Delete the old build folder");
  const bar = page.locator(".send-now");
  await expect(bar).toHaveText(HELD_FOR_PERMISSIONS);
  // Stop: no reply is running to stop, and the message is left as it was, unanswered.
  await page.getByRole("button", { name: "Stop all agents", exact: true }).click();
  await expect(bar).toHaveCount(0);
  const left = page.locator(".your-msg").filter({ hasText: "Delete the old build folder" }).locator(".not-answered");
  await expect(left).toContainText("Not answered");
  await noHorizontalOverflow(page);
  return { ...chat, bar, again: left.getByRole("button", { name: "Try again", exact: true }) };
}

test("Stop, then Try again, under tighter permissions that wait for the helpers: nothing answers the message around the change", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await heldThenStopped(page, request, token, "Held through Stop");
  try {
    // Try again asks for an answer, and the process on Full access still must not give one: held again, for the helpers.
    await chat.again.click();
    // Waiting for the helpers, and saying so ("working" with what it waits for, not just next in line).
    await expect.poll(async () => (await chat.agent()).statusDetail ?? "").toContain("Finishing helpers before");
    await expect(page.locator(".not-answered")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect((await chat.agent()).held).toEqual({ change: "permissions", helpers: true });
    await expect(page.getByText("Turn 2", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    await noHorizontalOverflow(page);
    expect(await chat.oldWays.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

// The hub says what a held turn waits for however it got there (engine.ts, where a turn is queued), so the message does too.
test("Stop, then Try again, under tighter permissions that wait for the helpers: the message says what it waits for again", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await heldThenStopped(page, request, token, "Held through Stop, said");
  try {
    await chat.again.click();
    await expect(chat.bar).toHaveText(HELD_FOR_PERMISSIONS);
    await expect(chat.bar.getByRole("button")).toHaveCount(0);
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your permission change applies");
  } finally {
    await chat.remove();
  }
});

// ---- With the hub's answers played: what the app draws, and what a tap asks for ----

/**
 * A real chat and sign-in, with the hub's answers played: its state, the chat's history and its live updates are what a
 * test writes, and what a tap asks the hub for is caught (`answer`), never sent to the test hub (its agent would really
 * run). `older`: a hub from before the one rule (no HubInfo.flowsIn). `group`: a group chat of @claude and @checker.
 */
async function played(page: Page, request: APIRequestContext, token: string, opts: { older?: boolean; group?: boolean } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = opts.group
    ? await (await request.post(`${HUB}/api/chats/group`, { headers, data: { name: "Release plan", members: [{ provider: "claude" }, { provider: "codex", handle: "checker" }], answers: "lead" } })).json()
    : await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Played chat" } })).json();
  const snapshot: StateSnapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  if (opts.older) delete snapshot.hub.flowsIn;
  else expect(snapshot.hub.flowsIn, "the test hub has the one rule").toBe(true);
  const members = snapshot.members.filter((m) => m.roomId === room.id);
  const history = { room, messages: [] as Message[], turns: [] as Turn[], activities: [] as Activity[], approvals: [] as Approval[], tasks: {} as Record<string, unknown[]>, totals: null, hasMore: false };
  let live: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    live = socket;
    socket.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  let seq = 0;
  // Sent minutes ago: a line that waits a moment before it shows (so it never flashes) is there as the chat opens.
  const at = () => Date.now() - 300_000 + seq * 1000;
  const message = (kind: "human" | "agent", text: string, patch: Partial<Message> = {}): Message => ({ id: `pl-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : members[0].handle, memberId: kind === "agent" ? members[0].id : null, text, mentions: [], turnId: null, status: "done", createdAt: at(), updatedAt: at(), ...patch });
  const turn = (id: string, patch: Partial<Turn> = {}): Turn => ({ id, roomId: room.id, memberId: members[0].id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: id, origin: "human", status: "running", error: null, usage: null, createdAt: at(), startedAt: at(), endedAt: null, ...patch });
  /** The hub's answers to what a test taps, with what was sent. */
  const answer = async (method: string, path: string, json: unknown = { ok: true }, status = 200) => {
    const bodies: unknown[] = [];
    await page.route(`**${path}`, (r) => {
      if (r.request().method() !== method) return r.fallback();
      bodies.push(r.request().postDataJSON() ?? null);
      return r.fulfill({ status, json });
    });
    return bodies;
  };
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, members, member: members[0], snapshot, history, message, turn, answer, open, send: (e: unknown) => live!.send(JSON.stringify(e)), cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

type Played = Awaited<ReturnType<typeof played>>;

/** A reply of `who` is running on your first message, and you've sent a second one. `handed`: that reply was handed it and hasn't read it; otherwise it waits behind the reply. */
function working(s: Played, who: Member, second: string, handed: boolean) {
  Object.assign(who, { status: "working", statusDetail: null });
  const ask = s.message("human", "Migrate the database");
  const reply = s.message("agent", "Migrating", { turnId: "run", status: "streaming", memberId: who.id, authorName: who.handle });
  const also = s.message("human", second);
  s.history.messages.push(ask, reply, also);
  const run = s.turn("run", { memberId: who.id, triggerMessageId: ask.id, replyMessageId: reply.id, ...(handed ? { unread: [also.id] } : {}) });
  s.history.turns.push(run);
  if (!handed) s.history.turns.push(s.turn("next", { memberId: who.id, status: "queued", triggerMessageId: also.id, startedAt: null }));
  // Handed over: the agent's place is past it (the reply has it). Waiting: it hasn't got there.
  who.readSeq = handed ? also.seq : reply.seq;
  return { ask, reply, also, run };
}

for (const width of WIDTHS) {
  test(`at ${width} px, under a message the reply was handed: the line names the agent, and Interrupt asks the hub to read it now`, async ({ page, request, token }) => {
    await page.setViewportSize({ width, height: 844 });
    const s = await played(page, request, token);
    const { run } = working(s, s.member, "Also use the staging database", true);
    const asked = await s.answer("POST", `/api/rooms/${s.room.id}/read-now`, { reading: true });
    const stops = await s.answer("POST", `/api/rooms/${s.room.id}/stop`);
    try {
      await s.open();
      const line = page.locator(".your-msg").filter({ hasText: "staging database" }).locator(".msg-quiet");
      await expect(line.locator(".msg-quiet-text")).toHaveText("Claude Code reads this at its next step.");
      const interrupt = line.getByRole("button", { name: "Interrupt", exact: true });
      await expect(interrupt).toBeVisible();
      await expect(page.locator(".send-now")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^(Send now|Read it now|Stop it and read now|Answer now)$/ })).toHaveCount(0);
      await lineFits(page, line);
      await page.screenshot({ ...shot(`rule-handed-${width}.png`), animations: "disabled" });
      const before = (await line.boundingBox())!;
      // A finger that lands just off the button still presses it: a 44 px target around it.
      const button = (await interrupt.boundingBox())!;
      await page.mouse.click(button.x + button.width / 2, button.y - 5);
      await expect.poll(() => asked.length).toBe(1);
      expect(asked[0]).toEqual({ memberId: s.member.id });
      // The step it's on is being stopped: said in the same line, in the same place (nothing jumps), with nothing to tap twice.
      s.send({ t: "turn", turn: { ...run, readingNow: true } });
      await expect(line.locator(".msg-quiet-text")).toHaveText("Stopping the current step so Claude Code reads this now…");
      await expect(line.getByRole("button")).toHaveCount(0);
      const after = (await line.boundingBox())!;
      expect(after.height).toBe(before.height);
      expect(after.y).toBe(before.y);
      await noHorizontalOverflow(page);
      // (Off the message: a mouse over it shows its actions, which a finger doesn't.)
      await page.mouse.move(2, 2);
      await page.screenshot({ ...shot(`rule-handed-stopping-${width}.png`), animations: "disabled" });
      // Read: the line goes. Interrupt never stopped the reply itself.
      s.send({ t: "turn", turn: { ...run, unread: null, readingNow: false } });
      await expect(page.locator(".msg-quiet")).toHaveCount(0);
      expect(stops).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test(`at ${width} px, behind a reply that can't take it: "Goes when this reply ends.", and Interrupt asks the hub to stop the reply and keep what waits`, async ({ page, request, token }) => {
    await page.setViewportSize({ width, height: 844 });
    const s = await played(page, request, token);
    working(s, s.member, "Also use the staging database", false);
    let release = () => {};
    const held = new Promise<void>((res) => (release = res));
    const stops: unknown[] = [];
    await page.route(`**/api/rooms/${s.room.id}/stop`, async (r) => {
      stops.push(r.request().postDataJSON());
      await held;
      await r.fulfill({ json: { ok: true } });
    });
    const asked = await s.answer("POST", `/api/rooms/${s.room.id}/read-now`, { reading: true });
    try {
      await s.open();
      const line = page.locator(".your-msg").filter({ hasText: "staging database" }).locator(".msg-quiet");
      await expect(line.locator(".msg-quiet-text")).toHaveText("Goes when this reply ends.");
      await expect(page.locator(".send-now")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^(Send now|Read it now|Stop it and read now|Answer now)$/ })).toHaveCount(0);
      await lineFits(page, line);
      await page.screenshot({ ...shot(`rule-goes-when-ends-${width}.png`), animations: "disabled" });
      const before = (await line.boundingBox())!;
      await line.getByRole("button", { name: "Interrupt", exact: true }).click();
      await expect.poll(() => stops.length).toBe(1);
      expect(stops[0]).toEqual({ keepWaiting: true });
      // While the hub stops it: said in the same line, in the same place, and Stop in the message box says Stopping… too.
      await expect(line.locator(".msg-quiet-text")).toHaveText("Stopping the reply to answer this…");
      await expect(line.getByRole("button")).toHaveCount(0);
      const after = (await line.boundingBox())!;
      expect(after.height).toBe(before.height);
      expect(after.y).toBe(before.y);
      await noHorizontalOverflow(page);
      release();
      await expect(line.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
      expect(asked).toEqual([]);
    } finally {
      release();
      await s.cleanup();
    }
  });

  test(`at ${width} px in a group chat the lines name whose reply it is, a long name wraps, and Interrupt is for that agent alone`, async ({ page, request, token }) => {
    await page.setViewportSize({ width, height: 844 });
    const s = await played(page, request, token, { group: true });
    const checker = s.members.find((m) => m.handle === "checker")!;
    const { run } = working(s, checker, "@checker also check the staging database", true);
    for (const m of s.members) if (m !== checker) m.readSeq = 3;
    const asked = await s.answer("POST", `/api/rooms/${s.room.id}/read-now`, { reading: true });
    const stops = await s.answer("POST", `/api/rooms/${s.room.id}/stop`);
    try {
      await s.open();
      const line = page.locator(".your-msg").filter({ hasText: "staging database" }).locator(".msg-quiet");
      await expect(line.locator(".msg-quiet-text")).toHaveText("@checker reads this at its next step.");
      await lineFits(page, line);
      await page.screenshot({ ...shot(`rule-group-handed-${width}.png`), animations: "disabled" });
      await line.getByRole("button", { name: "Interrupt", exact: true }).click();
      await expect.poll(() => asked.length).toBe(1);
      expect(asked[0]).toEqual({ memberId: checker.id });

      // Behind a reply of @checker's that can't take it.
      s.history.turns.splice(0, s.history.turns.length, { ...run, unread: null }, s.turn("next", { memberId: checker.id, status: "queued", triggerMessageId: s.history.messages[2].id, startedAt: null }));
      checker.readSeq = 2;
      await page.reload();
      await expect(line.locator(".msg-quiet-text")).toHaveText("Goes when @checker's reply ends.");
      await lineFits(page, line);
      await page.screenshot({ ...shot(`rule-group-goes-when-ends-${width}.png`), animations: "disabled" });
      await line.getByRole("button", { name: "Interrupt", exact: true }).click();
      await expect.poll(() => stops.length).toBe(1);
      // Only @checker's reply is stopped: another agent at work in the chat goes on.
      expect(stops[0]).toEqual({ memberId: checker.id, keepWaiting: true });

      // A long name: the words wrap, and the button stays whole, on the screen.
      checker.handle = "documentation-reviewer";
      for (const m of s.history.messages) if (m.authorKind === "human") m.text = m.text.replace("@checker", "@documentation-reviewer");
      await page.reload();
      await expect(line.locator(".msg-quiet-text")).toHaveText("Goes when @documentation-reviewer's reply ends.");
      await lineFits(page, line);
      await page.screenshot({ ...shot(`rule-long-name-goes-when-ends-${width}.png`), animations: "disabled" });
      s.history.turns.splice(0, s.history.turns.length, { ...run, unread: [s.history.messages[2].id] });
      checker.readSeq = 3;
      await page.reload();
      await expect(line.locator(".msg-quiet-text")).toHaveText("@documentation-reviewer reads this at its next step.");
      await lineFits(page, line);
      await page.screenshot({ ...shot(`rule-long-name-handed-${width}.png`), animations: "disabled" });
    } finally {
      await s.cleanup();
    }
  });
}

test("an account switch waiting for the helpers holds a message and says so, at 390 and 320 px, with nothing to tap", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await played(page, request, token);
  Object.assign(s.member, { status: "working", statusDetail: "Finishing helpers before your account switch applies", held: { change: "account", helpers: true } });
  const ask = s.message("human", "Migrate the database");
  const done = s.message("agent", "Migrated.", { turnId: "done" });
  const also = s.message("human", "Now delete the old one");
  s.history.messages.push(ask, done, also);
  s.history.turns.push(s.turn("done", { status: "done", triggerMessageId: ask.id, replyMessageId: done.id, endedAt: Date.now() - 200_000 }), s.turn("next", { status: "queued", triggerMessageId: also.id, startedAt: null }));
  s.history.tasks[s.member.id] = [{ id: "helper1", kind: "local_agent", description: "Review the plan", status: "running", background: true, startedAt: Date.now(), tokens: 1000, toolUses: 2 }];
  s.member.readSeq = done.seq;
  try {
    await s.open();
    const bar = page.locator(".send-now");
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await expect(bar).toHaveText("Your message is waiting for its helpers to finish, so your account switch applies first.");
      await expect(bar).toHaveClass(/\bpaused\b/);
      await expect(bar.getByRole("button")).toHaveCount(0);
      await expect(page.locator(".msg-quiet")).toHaveCount(0);
      await expect(page.locator(".not-answered")).toHaveCount(0);
      await noHorizontalOverflow(page);
      await page.screenshot({ ...shot(`rule-account-switch-${width}.png`), animations: "disabled" });
    }
    // With a reply running too, the reply as it is never takes a message meant for the new account: no Interrupt either.
    const reply = s.message("agent", "Checking", { turnId: "run", status: "streaming" });
    s.history.messages.splice(2, 0, reply);
    s.history.turns.unshift(s.turn("run", { triggerMessageId: ask.id, replyMessageId: reply.id }));
    Object.assign(s.member, { statusDetail: null });
    await page.reload();
    await expect(bar).toHaveText("Your message is waiting for this reply and its helpers to finish, so your account switch applies first.");
    await expect(bar.getByRole("button")).toHaveCount(0);
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});

test("a hub from before the one rule keeps its own ways: the bar with Send now, Read it now, Stop asking which, and Answer now", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await played(page, request, token, { older: true });
  const { also, run } = working(s, s.member, "Also use the staging database", false);
  const sent = await s.answer("POST", `/api/rooms/${s.room.id}/send-now`, { sent: true });
  const read = await s.answer("POST", `/api/rooms/${s.room.id}/read-now`, { reading: true });
  const stops = await s.answer("POST", `/api/rooms/${s.room.id}/stop`);
  const retries = await s.answer("POST", `/api/rooms/${s.room.id}/retry`, { turn: s.turn("answer", { status: "queued" }) });
  try {
    await s.open();
    // Nothing goes in by itself there: the bar says what the message waits for, and Send now puts it in.
    const bar = page.locator(".send-now");
    await expect(bar).toContainText("Your message is waiting for this reply to finish.");
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("rule-older-hub-send-now-390.png"), animations: "disabled" });
    // Stop asks what to do with the message that waits.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const which = page.getByRole("dialog", { name: "Stop Claude Code?", exact: true });
    await expect(which).toContainText("Your message is waiting for this reply to finish.");
    await which.getByRole("button", { name: /^Stop and answer my message/ }).click();
    await expect.poll(() => stops.length).toBe(1);
    expect(stops[0]).toEqual({ keepWaiting: true });
    await expect(which).toHaveCount(0);
    await bar.getByRole("button", { name: "Send now", exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ memberId: s.member.id });
    // Handed over: the note with its own button, as that hub's app always had it.
    s.send({ t: "turn", turn: s.turn("next", { status: "stopped", triggerMessageId: also.id, startedAt: null, endedAt: Date.now() }) });
    s.send({ t: "turn", turn: { ...run, unread: [also.id] } });
    s.send({ t: "member", member: { ...s.member, readSeq: also.seq } });
    await expect(bar).toHaveCount(0);
    const note = page.locator(".read-now");
    await expect(note).toContainText("Claude Code reads this at its next step.");
    await note.getByRole("button", { name: "Read it now", exact: true }).click();
    await expect.poll(() => read.length).toBe(1);
    await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(0);
    // Stop everything left the message unread: Answer now, under it.
    s.send({ t: "turn", turn: { ...run, status: "stopped", unread: null, endedAt: Date.now() } });
    s.send({ t: "message", message: { ...s.history.messages[1], status: "stopped" } });
    s.send({ t: "member", member: { ...s.member, status: "idle", readSeq: s.history.messages[1].seq } });
    const left = page.locator(".not-answered");
    await expect(left).toContainText("Not answered");
    await left.getByRole("button", { name: "Answer now", exact: true }).click();
    await expect.poll(() => retries.length).toBe(1);
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});
