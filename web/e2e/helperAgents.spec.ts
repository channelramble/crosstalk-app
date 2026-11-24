import { test, expect, noHorizontalOverflow, openGroupAgent } from "./fixtures";

test("an agent's helper model saves, and changing only that still asks before discarding", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers, data: { name: "Helper agents", mode: "direct" } })).json();
  const member = await (await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "codex", handle: "builder" } })).json();
  await page.route("**/api/providers/codex/models*", (route) => route.fulfill({ json: { provider: "codex", live: true, models: [
    { id: "codex-model", label: "Codex model", isDefault: true, efforts: ["low"] },
    { id: "codex-small", label: "Small model", efforts: ["low"] },
  ] } }));
  try {
    await page.goto(`/#/room/${room.id}`);
    // A room is a group chat now: an agent is changed from the chat's settings.
    const dialog = await openGroupAgent(page, "builder");
    const helpers = dialog.getByRole("combobox", { name: "Helper agents use", exact: true });
    // The agent's own model isn't offered again: "the same model" already means it.
    await expect(helpers.locator("option")).toHaveText(["The same model as this agent", "Small model"]);
    // Saved as it's picked: there's nothing to discard or to save.
    const saved = page.waitForRequest((req) => req.url().endsWith(`/api/members/${member.id}`) && req.method() === "PATCH");
    await helpers.selectOption("codex-small");
    expect((await saved).postDataJSON().config.helperModel).toBe("codex-small");
    await expect(helpers).toHaveValue("codex-small");
    await noHorizontalOverflow(page);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }); }
});
