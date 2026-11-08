import { test, expect, noHorizontalOverflow, openGroupAgent, openGroupSettings } from "./fixtures";

const fixedModel = { id: "gemini-3.8-flash-high", label: "Gemini Flash (High)", description: null, efforts: [], defaultEffort: "high", isDefault: true };
async function mockAgy(page: import("@playwright/test").Page) {
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    snap.providers.push({ provider: "antigravity", installed: true, signedIn: true, checkedAt: Date.now() });
    snap.accounts.push({ provider: "antigravity", id: "default", label: "Main", signedIn: true, checkedAt: Date.now() });
    await route.fulfill({ json: snap });
  });
  await page.route("**/api/providers/antigravity/models*", (route) => route.fulfill({ json: { provider: "antigravity", accountId: "default", live: true, error: null, models: [fixedModel] } }));
}

test("editing a fixed-effort agent clears a stale Max override rather than hiding and keeping it", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers, data: { name: "Effort repair", mode: "direct" } })).json();
  const member = await (await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "antigravity", handle: "agytest", model: fixedModel.id, config: { effort: "max" } } })).json();
  await mockAgy(page);
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("heading", { name: room.name, exact: true })).toBeVisible();
    // A room is a group chat now: an agent is changed from the chat's settings.
    const dialog = await openGroupAgent(page, "agytest");
    await dialog.getByText("Advanced: name, model, effort, instructions", { exact: true }).click();
    await expect(dialog).toContainText("Effort: High (included in this model)");
    await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveCount(0);
    await expect(dialog).toContainText("will be cleared when you save");
    await noHorizontalOverflow(page);
    const saved = page.waitForRequest((req) => req.url().endsWith(`/api/members/${member.id}`) && req.method() === "PATCH");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).postDataJSON().config.effort).toBeUndefined();
    await expect(dialog).toHaveCount(0);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }); }
});

test("Defaults cannot save a hidden stale effort for a fixed-effort model", async ({ page }) => {
  let saved: any;
  const defaults = { mode: "direct", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: { codex: { permissionMode: "auto", model: "fixed-model", effort: "max" } } };
  await page.route("**/api/providers/codex/models*", (route) => route.fulfill({ json: { provider: "codex", live: true, models: [{ id: "fixed-model", label: "Fixed model", efforts: [], defaultEffort: "high", isDefault: true }] } }));
  await page.route("**/api/settings/defaults**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: defaults });
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { ...defaults, agent: { codex: saved } } });
  });
  await page.goto("/#/settings");
  const card = page.getByRole("group", { name: "New Codex chat defaults", exact: true });
  await card.locator("summary").click();
  await expect(card.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("fixed-model");
  await expect(card.getByRole("combobox", { name: "Effort", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saved?.effort).toBeNull();
  await noHorizontalOverflow(page);
});

test("a group chat's deletion needs both confirmations and either can cancel", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers, data: { name: "Two confirmations", mode: "direct" } })).json();
  let deleteRequests = 0;
  page.on("request", (req) => { if (req.method() === "DELETE" && req.url().endsWith(`/api/rooms/${room.id}`)) deleteRequests++; });
  try {
    await page.goto(`/#/room/${room.id}`);
    const settings = await openGroupSettings(page);
    const del = settings.getByRole("button", { name: "Delete chat", exact: true });
    const first = page.getByRole("dialog", { name: "Delete this chat?", exact: true });
    const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
    // The first question can cancel…
    await del.click();
    await first.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(first).toHaveCount(0);
    // …and so can the second.
    await del.click();
    await first.getByRole("button", { name: "Continue", exact: true }).click();
    await sure.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sure).toHaveCount(0);
    expect(deleteRequests).toBe(0);
    // Both answered: it goes.
    await del.click();
    await first.getByRole("button", { name: "Continue", exact: true }).click();
    await sure.getByRole("button", { name: "Yes, delete", exact: true }).click();
    await expect.poll(() => deleteRequests).toBe(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }); }
});
