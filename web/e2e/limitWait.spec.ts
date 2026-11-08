import type { Member, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Carrying on when a usage limit resets, on a phone (390 px): the waiting reply, when it carries on, and the two ways
// out. The agent is the scripted mock one (its `limit` knob reports a limit the way Claude Code and Codex do): nothing
// here sends a prompt to a real model.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});

/** A chat whose agent runs out of messages on its first reply, and answers normally after that. */
async function limitedChat(request: import("@playwright/test").APIRequestContext, token: string, name: string, resetsIn: number | null) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode: "direct" } })).json();
  const member: Member = await (
    await request.post(`${HUB}/api/rooms/${room.id}/members`, {
      headers,
      data: { provider: "mock", handle: "tester", config: { delayMs: 10, limit: { label: "5-hour", resetsAt: resetsIn === null ? null : Date.now() + resetsIn, times: 1 } } },
    })
  ).json();
  return { room, member, headers, remove: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

test("a chat that ran out of messages says when it carries on, and Try now starts it at once", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await limitedChat(request, token, "Out of messages", 90 * 60_000);
  try {
    await page.goto(`/#/room/${chat.room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("please build it");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // The reply says why in plain words, with the time it comes back — and isn't an error.
    const reply = page.locator(".msg.agent").last();
    await expect(reply).toContainText("Test agent is out of messages until");
    await expect(reply).toContainText("It'll carry on then.");
    await expect(reply).not.toContainText("⚠️");
    await expect(page.locator(".msg.agent .pill.red")).toHaveCount(0);
    await expect(page.locator(".msg.agent.waiting")).toHaveCount(1);

    // Under it: when it carries on, counting down, and both ways out as buttons with names.
    const waiting = page.getByRole("status").filter({ hasText: "Carries on at" });
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText(/in 1 h \d+ min/);
    const tryNow = page.getByRole("button", { name: "Try now", exact: true });
    const dontWait = page.getByRole("button", { name: "Don't wait", exact: true });
    await expect(tryNow).toBeEnabled();
    await expect(dontWait).toBeEnabled();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("limit-waiting.png"), animations: "disabled" });

    // The chat list says it too, in words on the row (a phone has no hover), with the time it comes back.
    await page.getByRole("button", { name: /^Show chats/ }).click();
    const side = page.getByRole("complementary", { name: "Chats", exact: true });
    const sideRow = side.locator(".csb-chat").filter({ hasText: "Out of messages" });
    await expect(sideRow).toContainText(/Back at (\w{3} )?\d/);
    await expect(sideRow.locator(".csb-dot.waiting")).toHaveAttribute("aria-label", /Waiting for its usage limit · Back at (\w{3} )?\d/);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("limit-waiting-list.png"), animations: "disabled" });
    await sideRow.click();

    // Try now: it carries on there and then, and the waiting row goes.
    await tryNow.click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(page.getByRole("button", { name: "Try now", exact: true })).toHaveCount(0);
    await expect(page.locator(".msg.agent.waiting")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally {
    await chat.remove();
  }
});

test("Don't wait leaves a failed reply with Try again", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await limitedChat(request, token, "Not waiting", 90 * 60_000);
  try {
    await page.goto(`/#/room/${chat.room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("please build it");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Don't wait", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Don't wait", exact: true }).click();

    // Now it's an ordinary failed reply: the error style, no countdown, and Try again.
    await expect(page.locator(".msg.agent.error")).toHaveCount(1);
    await expect(page.locator(".msg.agent").last()).toContainText("Tap Try again when you want it to carry on.");
    await expect(page.getByRole("button", { name: "Try now", exact: true })).toHaveCount(0);
    const tryAgain = page.getByRole("button", { name: "Try again", exact: true });
    await expect(tryAgain).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("limit-dont-wait.png"), animations: "disabled" });
    await tryAgain.click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
  } finally {
    await chat.remove();
  }
});

test("with no reset time it says soon, and a new message answers instead of waiting", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await limitedChat(request, token, "No reset time", null);
  try {
    await page.goto(`/#/room/${chat.room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("please build it");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const reply = page.locator(".msg.agent").last();
    await expect(reply).toContainText("is out of messages until its limit resets. It'll carry on soon.");
    // No wrong time anywhere: only when Crosstalk tries again.
    await expect(page.getByRole("status").filter({ hasText: "Trying again in" })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("limit-waiting-no-time.png"), animations: "disabled" });

    // Sending a new message cancels the wait and gets an answer now.
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("never mind, do this instead");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(page.getByRole("button", { name: "Try now", exact: true })).toHaveCount(0);
  } finally {
    await chat.remove();
  }
});

test("Settings: carrying on when the limit resets is on by default, and saves off and on", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const url = `${HUB}/api/settings/hub`;
  const headers = { authorization: `Bearer ${token}` };
  try {
    await page.goto("/#/settings/usage");
    const card = page.getByRole("region", { name: "Usage preferences", exact: true });
    const toggle = card.getByRole("checkbox", { name: "Carry on when the limit resets", exact: true });
    await expect(toggle).toBeChecked();
    await expect(card).toContainText("the chat waits and picks itself back up once the limit resets");
    await card.scrollIntoViewIfNeeded();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("limit-setting.png"), animations: "disabled" });
    await toggle.uncheck();
    await expect(toggle).toBeEnabled();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).carryOnAfterLimit).toBe(false);
    await page.reload();
    await expect(card.getByRole("checkbox", { name: "Carry on when the limit resets", exact: true })).not.toBeChecked();
    // The other usage setting is untouched by it.
    await expect(card.getByRole("checkbox", { name: "Pause near usage limits", exact: true })).not.toBeChecked();
    await card.getByRole("checkbox", { name: "Carry on when the limit resets", exact: true }).check();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).carryOnAfterLimit).toBe(true);
  } finally {
    await request.put(url, { headers, data: { carryOnAfterLimit: true } });
  }
});
