import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// New chat asks for the folder; the rest (a name, a template, the account, model, effort and permissions) is under
// More options, whose closed row says what the chat starts with (web/src/views/AgentScreen.tsx NewChatDialog).

const HUB = "http://127.0.0.1:8451";
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : null);
const defaults = { mode: "direct", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: { codex: { permissionMode: "auto", model: null, effort: null } } };

/** A device where More options has never been opened (the fixture opens it for every other spec). */
async function fresh(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("ct-test-more-closed", "1");
    if (!sessionStorage.getItem("ct-test-more-cleared")) {
      localStorage.removeItem("crosstalk.newchat.more.v1");
      sessionStorage.setItem("ct-test-more-cleared", "1");
    }
  });
}

test("New chat shows the folder and Start; More options is closed and says what the chat starts with", async ({ page, request, token }) => {
  await fresh(page);
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: defaults }));
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  const more = dialog.locator("details.more-options");
  await expect(more).not.toHaveAttribute("open", "");
  // The folder is there to pick; the name and the permissions aren't in the way.
  await expect(dialog.getByRole("combobox", { name: /folder/i }).or(dialog.getByText("Folder", { exact: true })).first()).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeHidden();
  await expect(dialog.getByRole("radio", { name: "Full access", exact: true })).toBeHidden();
  // Its closed row says the defaults the chat starts with.
  await expect(more.locator("summary .more-picks")).toContainText("Can edit");
  await expect(more.locator("summary .more-picks")).toContainText("default model");
  const row = (await more.locator("summary").boundingBox())!;
  expect(row.height).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);
  if (shot("new-chat-closed.png")) await page.screenshot(shot("new-chat-closed.png")!);

  // Open: everything is there, and what's changed shows on the row once it's closed again.
  await more.locator("summary").click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Fold test");
  await dialog.getByRole("radio", { name: "Full access", exact: true }).click();
  if (shot("new-chat-open.png")) await page.screenshot(shot("new-chat-open.png")!);
  await more.locator("summary").click();
  await expect(more.locator("summary .more-picks")).toContainText("Fold test");
  await expect(more.locator("summary .more-picks")).toContainText("Full access");

  // Closed, it still starts with what was picked in it.
  const created = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
  const room = await (await created).json();
  try {
    expect(room.name).toBe("Fold test");
    const state = await (await request.get(`${HUB}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(state.members.filter((m: { roomId: string }) => m.roomId === room.id)).toMatchObject([{ provider: "codex", permissionMode: "full" }]);
  } finally {
    await request.delete(`${HUB}/api/rooms/${room.id}`, { headers: { authorization: `Bearer ${token}` } });
  }
});

test("More options stays as you left it on this device", async ({ page }) => {
  await fresh(page);
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: defaults }));
  await page.goto("/#/agent/codex");
  const open = async () => {
    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    return page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  };
  let dialog = await open();
  await dialog.locator("details.more-options > summary").click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("crosstalk.newchat.more.v1"))).toBe("1");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("crosstalk.newchat.more.v1"))).toBe("1");
  // Opened again, and after a reload: still open.
  dialog = await open();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  dialog = await open();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  // Closed by hand: closed next time.
  await dialog.locator("details.more-options > summary").click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("crosstalk.newchat.more.v1"))).toBeNull();
  await page.keyboard.press("Escape");
  dialog = await open();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeHidden();
});
