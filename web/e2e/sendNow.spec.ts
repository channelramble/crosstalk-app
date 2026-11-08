import type { APIRequestContext, Page } from "@playwright/test";
import type { Member, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// What a message of yours that waits on the agent is really waiting for, on a phone (390 px). A chat once
// said "Your message is waiting for this reply to finish." with Send now while no reply was running, and Send now said
// "It's being answered already, or the reply just ended." — neither was true. The agent is the scripted mock one (its
// `limit` and `helpers` knobs): nothing here sends a prompt to a real model, and no agent CLI runs.

const HUB = "http://127.0.0.1:8451";
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});

/** A chat with the mock agent (the test hub's agents are group chats of one). */
async function mockChat(request: APIRequestContext, token: string, name: string, config: Record<string, unknown>, permissionMode?: Member["permissionMode"]) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode: "direct" } })).json();
  const member: Member = await (await request.post(`${HUB}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "tester", config: { delayMs: 10, ...config }, ...(permissionMode ? { permissionMode } : {}) } })).json();
  const agent = async (): Promise<Member> => ((await (await request.get(`${HUB}/api/state`, { headers })).json()).members as Member[]).find((m) => m.id === member.id)!;
  return { room, member, headers, agent, remove: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/**
 * From here on, notes the bar and its buttons the moment either shows, however briefly: "no button appears" holds for the
 * whole of a test, not just where it looks. `seen` says what showed.
 */
async function watchForButtons(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { barsSeen: string[] }).barsSeen = seen;
    const buttons = new Set(["Send now", "Sending…", "Answer now", "Starting…", "Read it now", "Stop it and read now"]);
    const look = () => {
      for (const bar of document.querySelectorAll(".send-now")) seen.push(`bar: ${bar.textContent}`);
      for (const b of document.querySelectorAll("button")) if (buttons.has(b.textContent?.trim() ?? "")) seen.push(`button: ${b.textContent}`);
    };
    look();
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  return { seen: () => page.evaluate(() => (window as unknown as { barsSeen: string[] }).barsSeen) };
}

/** A chat with a helper at work for longer than a test runs and no reply running, open on the phone. */
async function helperAtWork(page: Page, request: APIRequestContext, token: string, name: string, config: Record<string, unknown> = {}) {
  const chat = await mockChat(request, token, name, { helpers: { ms: 120_000 }, ...config });
  await request.post(`${HUB}/api/rooms/${chat.room.id}/messages`, { headers: chat.headers, data: { text: "Install the browser" } });
  await expect.poll(async () => (await chat.agent()).status).toBe("idle");
  await page.goto(`/#/room/${chat.room.id}`);
  await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
  const send = async (text: string) => {
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
  };
  return { ...chat, send, buttons: await watchForButtons(page) };
}

test("a usage limit stops the reply your message waits behind: it says when it goes, with no Send now that can't work", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The first reply runs a few seconds, then the 5-hour limit stops it; the reply that carries on answers.
  const chat = await mockChat(request, token, "Limit behind a reply", { limit: { label: "5-hour", resetsAt: Date.now() + 33 * 60_000, times: 1, afterMs: 8000 } });
  try {
    await page.goto(`/#/room/${chat.room.id}`);
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("research what happened");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-status")).toBeVisible();
    // A second message waits behind the reply: Send now is offered, as before.
    await box.fill("and send the link");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const bar = page.locator(".send-now");
    await expect(bar).toContainText("Your message is waiting for this reply to finish.");
    // Tapped just as the limit stops the reply: the hub answers once it has (the request is held until then).
    await page.route("**/send-now", async (route) => {
      await expect.poll(async () => (await chat.agent()).status, { timeout: 15_000 }).toBe("waiting");
      await route.continue();
    });
    await bar.getByRole("button", { name: "Send now", exact: true }).click();

    // The truth, in plain words: paused until the reset, and the message goes first — never "being answered already".
    const paused = page.locator(".send-now.paused");
    await expect(paused).toHaveText(/^Paused until your usage limit resets at (\w{3} )?\d{1,2}:\d{2}\s?[AP]M\. Your message goes first when it does\.$/, { timeout: 15_000 });
    await expect(paused).toHaveAttribute("role", "status");
    await expect(page.locator(".toast").filter({ hasText: "Your message goes first when it does." })).toBeVisible();
    await expect(page.getByText("being answered already", { exact: false })).toHaveCount(0);
    // No Send now while the account has nothing to send it with; the honest way on is the waiting line's Try now.
    await expect(page.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Carries on at" })).toBeVisible();
    // The message is still yours, unanswered: nothing was handed anywhere.
    await expect(page.locator(".msg.agent.waiting")).toHaveCount(1);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-limit.png"), animations: "disabled" });

    // Try now: the reply that carries on reads it first, and the line goes.
    await page.getByRole("button", { name: "Try now", exact: true }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(page.locator(".send-now")).toHaveCount(0);
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
    expect(await chat.buttons.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("a reply and a helper at work, on an agent that takes messages mid-reply: your message goes in with no tap, and a small label says when it's read", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Its second reply runs a few seconds.
  const chat = await helperAtWork(page, request, token, "Into the reply", { steer: true, delays: [10, 8000] });
  try {
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await chat.send("Also add tests");
    const label = page.locator(".msg-quiet");
    await expect(label).toHaveText(/^@tester reads this (after the current step|at its next step)\.$/);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-into-reply.png"), animations: "disabled" });
    // Read in that reply and answered below it: no reply of its own for it, and the label goes.
    await expect(page.locator(".msg.agent").last()).toContainText("Got your message: “Also add tests”.", { timeout: 15_000 });
    await expect(label).toHaveCount(0);
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    expect(await chat.buttons.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("a reply and a helper at work, on an agent with no mid-reply form: your message queues quietly and goes when the reply ends, not when the helper does", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Queues quietly", { delays: [10, 8000, 10] });
  try {
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await chat.send("Also add tests");
    const label = page.locator(".msg-quiet");
    await expect(label).toHaveText("Goes when @tester's reply ends.");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-quiet.png"), animations: "disabled" });
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3", { timeout: 15_000 });
    await expect(label).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    expect(await chat.buttons.seen()).toEqual([]);
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
    expect(await chat.buttons.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("Stop after a message went in by itself: it asks what to do with it, and Stop everything leaves it with Answer now, even while new settings wait", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Stop after it went in", { steer: true, delays: [10, 8000, 10] });
  try {
    await request.patch(`${HUB}/api/members/${chat.member.id}`, { headers: chat.headers, data: { permissionMode: "edits" } });
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await chat.send("Also add tests");
    await expect(page.locator(".msg-quiet")).toHaveText(/^@tester reads this (after the current step|at its next step)\.$/);
    await page.getByRole("button", { name: "Stop all agents", exact: true }).click();
    const which = page.getByRole("dialog");
    await expect(which).toContainText("hasn't read your message yet.");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-stop-asks.png"), animations: "disabled" });
    await which.getByRole("button", { name: /^Stop everything/ }).click();
    await expect(which).toHaveCount(0);
    // Stopped, and it stays stopped: the message is yours again, under a hold that may last for hours.
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    const answer = page.getByRole("button", { name: "Answer now", exact: true });
    await expect(answer).toBeVisible();
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-stopped-unread.png"), animations: "disabled" });
    await answer.click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(page.locator(".msg.agent").last()).toContainText("Also add tests");
    await expect(answer).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
  } finally {
    await chat.remove();
  }
});

test("Stop and answer my message, after it went in by itself: answered next, with nothing else to tap", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Stop and answer", { steer: true, delays: [10, 8000, 10] });
  try {
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await chat.send("Also add tests");
    await expect(page.locator(".msg-quiet")).toHaveCount(1);
    await page.getByRole("button", { name: "Stop all agents", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Stop and answer my message/ }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(page.locator(".msg.agent").last()).toContainText("Also add tests");
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    expect(await chat.buttons.seen()).toEqual([]);
  } finally {
    await chat.remove();
  }
});

test("once the helper has finished, the bar with Send now is back: no helpers, nothing changes", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await mockChat(request, token, "After the helpers", { helpers: { ms: 300 }, delays: [10, 8000] });
  try {
    await request.post(`${HUB}/api/rooms/${chat.room.id}/messages`, { headers: chat.headers, data: { text: "Install the browser" } });
    await page.goto(`/#/room/${chat.room.id}`);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper finished");
    const send = async (text: string) => {
      await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    };
    await send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await send("Also add tests");
    const bar = page.locator(".send-now");
    await expect(bar).toContainText("Your message is waiting for this reply to finish.");
    await expect(bar.getByRole("button", { name: "Send now", exact: true })).toBeVisible();
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
  } finally {
    await chat.remove();
  }
});

test("tighter permissions waiting for the helpers: it says which change waits, and offers no Answer now", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await mockChat(request, token, "Held for permissions", { helpers: { ms: 120_000 } }, "full");
  try {
    await request.post(`${HUB}/api/rooms/${chat.room.id}/messages`, { headers: chat.headers, data: { text: "Install the browser" } });
    await expect.poll(async () => (await chat.agent()).status).toBe("idle");
    // Full access to Ask first while the helper works: the process on Full access must not answer what comes next.
    await request.patch(`${HUB}/api/members/${chat.member.id}`, { headers: chat.headers, data: { permissionMode: "ask" } });
    await expect.poll(async () => (await chat.agent()).statusDetail).toBe("Finishing helpers before your permission change applies");

    await page.goto(`/#/room/${chat.room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Delete the old build folder");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const bar = page.locator(".send-now");
    await expect(bar).toHaveText("Your message is waiting for its helpers to finish, so your permission change applies first.");
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Answer now", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your permission change applies");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("send-now-permissions.png"), animations: "disabled" });
  } finally {
    await chat.remove();
  }
});
