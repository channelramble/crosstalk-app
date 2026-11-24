import type { APIRequestContext } from "@playwright/test";
import type { Member, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Stop helpers (WorkingPanel's HelpersPanel, Engine.stopHelpers): what an agent still runs after its reply ended can be
// stopped from the chat, in two taps. The scripted agent on the test hub leaves a helper at work after its first reply.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : null);

async function mockChat(request: APIRequestContext, token: string, name: string, config: Record<string, unknown>) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode: "direct" } })).json();
  const member: Member = await (await request.post(`${HUB}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "tester", config } })).json();
  return { room, member, headers, send: (text: string) => request.post(`${HUB}/api/rooms/${room.id}/messages`, { headers, data: { text } }), remove: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

test("a helper still working after the reply ended: Stop asks once, then stops it, and the chat goes on", async ({ page, request, token }) => {
  const chat = await mockChat(request, token, "Stop helpers chat", { delayMs: 1500, helpers: { ms: 120_000 } });
  try {
    await page.goto(`/#/room/${chat.room.id}`);
    const helpers = page.getByRole("region", { name: "Helpers", exact: true });
    await chat.send("please check the work");
    // While the reply runs there's no helper yet; once it has ended, its helper works on and can be stopped.
    await expect(helpers.locator(".helpers-title")).toHaveText("1 helper working");
    const stop = helpers.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    const box = (await stop.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await noHorizontalOverflow(page);
    if (shot("stop-1.png")) await page.screenshot(shot("stop-1.png")!);

    // The first tap only asks, and lets go by itself.
    await stop.click();
    const sure = helpers.getByRole("button", { name: "Stop it?", exact: true });
    await expect(sure).toBeVisible();
    await expect(helpers.locator(".helpers-title")).toHaveText("1 helper working");
    if (shot("stop-2.png")) await page.screenshot(shot("stop-2.png")!);
    await expect(sure).toHaveCount(0, { timeout: 8000 });
    await expect(stop).toBeVisible();

    // Two taps: stopped, said as stopped by you, and nothing is left to stop.
    await stop.click();
    await sure.click();
    await expect(helpers.locator(".helpers-title")).toHaveText("1 helper stopped");
    await expect(helpers.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
    // Folded now that nothing runs: opened, it says who stopped it.
    await helpers.locator(".helpers-head").click();
    await expect(helpers).toContainText("You stopped it.");
    if (shot("stop-3.png")) await page.screenshot(shot("stop-3.png")!);
    // The hub agrees: nothing of this agent's is running any more.
    const state = await (await request.get(`${HUB}/api/state`, { headers: chat.headers })).json();
    expect((state.tasks[chat.member.id] ?? []).filter((t: { status: string }) => t.status === "running")).toEqual([]);

    // The chat goes on: the next message is answered.
    await chat.send("and again");
    await expect(page.locator(".msg.agent").last()).toContainText("and again");
  } finally {
    await chat.remove();
  }
});
