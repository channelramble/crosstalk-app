import { test, expect, noHorizontalOverflow } from "./fixtures";

test("in a group chat @everyone means everyone in turn, @name means only them, and the settings open without losing a draft", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers, data: { name: "Clear hand-offs", mode: "direct" } })).json();
  for (const handle of ["first", "second"]) await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle } });
  try {
    await page.goto(`/#/room/${room.id}`);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    const answers = page.locator(".group-answers");
    // Nobody named: the lead (the first agent that joined).
    await expect(answers).toHaveText("@first answers. Type @ to pick who answers.");
    await message.fill("@EVERYONE check the change");
    await expect(answers).toHaveText("Everyone answers, in turn: @first, then @second.");
    await expect(page.getByRole("button", { name: "Send to all: @first, then @second", exact: true })).toHaveText("Send to all");
    await noHorizontalOverflow(page);
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Group chat settings", exact: true });
    await expect(dialog.getByRole("radio", { name: /^The lead answers/ })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(message).toHaveValue("@EVERYONE check the change");
    await message.fill("@SECOND take this one");
    await expect(answers).toHaveText("Only @second will answer. The others read it on their next turn.");
    await page.getByRole("button", { name: "Send to @second", exact: true }).click();
    await expect.poll(async () => {
      const history = await (await request.get(`http://127.0.0.1:8451/api/rooms/${room.id}/history`, { headers })).json();
      return history.messages.filter((m: { authorKind: string; status: string }) => m.authorKind === "agent" && m.status === "done").map((m: { authorName: string }) => m.authorName);
    }).toEqual(["second"]);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }); }
});
