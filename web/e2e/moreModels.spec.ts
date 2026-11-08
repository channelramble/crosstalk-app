import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import { join } from "node:path";

const hub = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});

// Codex's list with its hidden models (model/list includeHidden), as the hub sends it: the usual ones, then those marked
// for More models, each with what Codex says of it.
const sol = { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "Latest workhorse model.", isDefault: true, efforts: ["low", "high"], defaultEffort: "low", contextWindow: 500_000, usableContext: 475_000, compactAt: 450_000, maxContextWindow: 872_000, firstSeen: 0 };
const astra = { id: "gpt-6-astra", label: "GPT-6-Astra", description: "Frontier model.", isDefault: false, efforts: ["low", "high"], defaultEffort: "high", contextWindow: 272_000, usableContext: 258_400, compactAt: 244_800, maxContextWindow: 872_000, firstSeen: 0 };
const reserve = { id: "gpt-reserve", label: "GPT-Reserve", description: "Fast and affordable agentic coding model.", isDefault: false, efforts: ["low", "medium"], defaultEffort: "medium", contextWindow: 272_000, usableContext: 258_400, compactAt: 244_800, maxContextWindow: 872_000, firstSeen: Date.now() - 60_000, more: true };
const review = { id: "codex-auto-review", label: "Codex Auto Review", description: "Automatic approval review model for Codex.", isDefault: false, efforts: ["low", "medium"], defaultEffort: "medium", contextWindow: 272_000, firstSeen: Date.now() - 60_000, more: true };
const codexCatalog = { provider: "codex", accountId: "default", live: true, error: null, models: [sol, astra, reserve, review] };

/** A chat whose hub events this test sends itself, and whose settings changes come back the way the hub sends them. */
async function chat(page: Page, request: APIRequestContext, token: string, provider: "codex" | "claude", name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider, name } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: { roomId: string }) => m.roomId === room.id);
  const history = { room, messages: [], turns: [] as unknown[], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: snapshot }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  const patches: Record<string, unknown>[] = [];
  await page.route(`**/api/members/${member.id}`, async (r) => {
    if (r.request().method() !== "PATCH") return r.continue();
    const body = r.request().postDataJSON();
    patches.push(body);
    Object.assign(member, body);
    socket?.send(JSON.stringify({ t: "member", member }));
    return r.fulfill({ json: member });
  });
  const send = (e: unknown) => socket!.send(JSON.stringify(e));
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, member, patches, send, open, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

test("More models on a phone: the menu opens on the usual models, More models opens the rest, and one picked works like any other", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chat(page, request, token, "codex", "More models");
  // On an effort the more model doesn't take: switching drops it (it would fail the next reply).
  s.member.config = { ...s.member.config, effort: "high" };
  await page.route("**/api/providers/codex/models**", (r) => r.fulfill({ json: codexCatalog }));
  try {
    await s.open();
    await page.locator(".chat-controls .ctl-model").click();
    const menu = page.getByRole("dialog", { name: "Model", exact: true });
    const item = (name: string) => menu.getByRole("menuitemradio").filter({ hasText: name });
    const moreButton = menu.getByRole("button", { name: "More models (2)", exact: true });
    const back = menu.getByRole("button", { name: "Back to the usual models", exact: true });

    // Step one: Codex's usual list, then More models; the more ones aren't in the way.
    await expect(item("GPT-6.1-Sol")).toContainText("Latest workhorse model. · 500k context, up to 872k");
    await expect(item("GPT-6-Astra")).toBeVisible();
    await expect(item("GPT-Reserve")).toHaveCount(0);
    await expect(moreButton).toHaveAttribute("aria-expanded", "false");
    // A finger-sized target.
    expect((await moreButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("more-models-menu.png"), animations: "disabled" });

    // Step two: a way back (where focus goes), what these are, and each with what Codex says of it. Never "New".
    await moreButton.click();
    await expect(back).toBeFocused();
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(menu.getByRole("heading", { name: "More models", exact: true })).toBeVisible();
    await expect(menu).toContainText("Codex keeps these out of its usual list.");
    await expect(item("GPT-Reserve")).toContainText("Fast and affordable agentic coding model. · 272k context, up to 872k");
    await expect(item("Codex Auto Review")).toContainText("Automatic approval review model for Codex.");
    await expect(item("GPT-Reserve")).not.toContainText("New");
    await expect(item("GPT-6-Astra")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("more-models-list.png"), animations: "disabled" });

    // Back: the usual ones again, focus on More models.
    await back.click();
    await expect(item("GPT-6-Astra")).toBeVisible();
    await expect(moreButton).toBeFocused();
    // Escape closes the menu from either step; it opens on the usual models again.
    await moreButton.click();
    await expect(back).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page.locator(".chat-controls .ctl-model").click();
    await expect(moreButton).toBeVisible();
    await expect(back).toHaveCount(0);

    // Picked like any other model: saved by name, and an effort it doesn't take dropped.
    const before = s.patches.length;
    await moreButton.click();
    await item("GPT-Reserve").click();
    await expect.poll(() => s.patches.length).toBe(before + 1);
    expect(s.patches.at(-1)).toMatchObject({ model: "gpt-reserve" });
    expect((s.patches.at(-1)!.config as Record<string, unknown>).effort).toBeUndefined();
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".chat-controls .ctl-model .ellipsis")).toHaveText("GPT-Reserve");
    // Its own effort levels (the button says its default: none is set)…
    await expect(page.locator(".chat-controls").getByTitle("Effort", { exact: true })).toHaveText("Medium");
    await page.locator(".chat-controls").getByTitle("Effort", { exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Effort", exact: true }).locator(".effort-ticks button")).toHaveText(["Low", "Medium"]);
    await page.keyboard.press("Escape");
    // …and what it holds.
    await page.locator(".chat-controls").getByRole("button", { name: /context and plan limits/ }).click();
    await expect(page.getByRole("dialog", { name: "Context and plan limits", exact: true })).toContainText("Holds 258k.");
    await page.keyboard.press("Escape");
    // Opened again, the menu has it in view at once, checked.
    await page.locator(".chat-controls .ctl-model").click();
    await expect(item("GPT-Reserve")).toHaveAttribute("aria-checked", "true");
    await expect(item("GPT-6.1-Sol")).toHaveAttribute("aria-checked", "false");
    await expect(moreButton).toBeVisible();
    await noHorizontalOverflow(page);

    // Codex stops naming more models (an older Codex, say) while they're open: the usual ones show again with nothing
    // extra, the chat's model stays in view, and focus (on Back, which goes) moves to it rather than out of the menu.
    await moreButton.click();
    await expect(back).toBeFocused();
    s.send({ t: "models", catalog: { ...codexCatalog, models: [sol, astra, { ...reserve, more: false }] } });
    await expect(back).toHaveCount(0);
    await expect(menu.getByRole("button", { name: /^More models/ })).toHaveCount(0);
    await expect(item("GPT-6-Astra")).toBeVisible();
    await expect(item("GPT-Reserve")).toHaveAttribute("aria-checked", "true");
    await expect(item("GPT-Reserve")).toBeFocused();
  } finally {
    await s.cleanup();
  }
});

test("an agent that names nothing more (Claude Code) shows no More models", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await chat(page, request, token, "claude", "No more models");
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: { provider: "claude", accountId: "default", live: true, error: null, models: [
    { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", description: "For complex work", isDefault: true, efforts: ["low", "high"], defaultEffort: null, contextWindow: 1_000_000 },
    { id: "haiku", resolvedModel: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", isDefault: false, efforts: [], defaultEffort: null, contextWindow: 200_000 },
  ] } }));
  try {
    await s.open();
    await page.locator(".chat-controls .ctl-model").click();
    const menu = page.getByRole("dialog", { name: "Model", exact: true });
    await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
    await expect(menu.getByRole("button", { name: /^More models/ })).toHaveCount(0);
    await expect(menu.getByRole("combobox", { name: "Helper agents use", exact: true }).locator("optgroup")).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test("New chat: the Model list has a More models group, and a chat starts on one of them", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/providers/codex/models**", (r) => r.fulfill({ json: codexCatalog }));
  await page.route("**/api/settings/defaults", (r) => r.fulfill({ json: { mode: "review", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: { codex: { permissionMode: "ask", model: null, effort: null } } } }));
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  const model = dialog.getByRole("combobox", { name: "Model", exact: true });
  // The usual ones, then the group (a phone's picker shows its name as a heading), then a name of your own.
  await expect(model.locator(":scope > option")).toHaveText(["Default (GPT-6.1-Sol)", "GPT-6.1-Sol · 500k", "GPT-6-Astra · 272k", "Other…"]);
  await expect(model.locator("optgroup")).toHaveAttribute("label", "More models");
  await expect(model.locator("optgroup > option")).toHaveText(["GPT-Reserve · 272k", "Codex Auto Review · 272k"]);
  await model.selectOption("gpt-reserve");
  // What Codex says of it, under the list (a drop-down's choices can't show it), and its own effort levels. The `has` locator is
  // looked for inside each field, so it starts at the page: one that starts at the dialog finds no dialog in a field, and no field.
  await expect(dialog.locator(".field").filter({ has: page.getByRole("combobox", { name: "Model", exact: true }) }).locator(".help")).toHaveText("Fast and affordable agentic coding model. · 272k context, up to 872k");
  await expect(dialog.getByRole("combobox", { name: "Effort", exact: true }).locator("option")).toHaveText(["Default (Medium)", "Low", "Medium"]);
  // Helper agents can use the other one; the chat's own model isn't offered again.
  await expect(dialog.getByRole("combobox", { name: "Helper agents use", exact: true }).locator("optgroup > option")).toHaveText(["Codex Auto Review"]);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("new-chat-more-models.png"), animations: "disabled" });

  const sent = page.waitForRequest((r) => r.url().endsWith("/api/chats") && r.method() === "POST");
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
  const body = (await sent).postDataJSON();
  const room = await (await answered).json();
  try {
    expect(body).toMatchObject({ provider: "codex", model: "gpt-reserve", effort: null });
    // The chat opens on it.
    await expect(page.locator(".chat-controls .ctl-model .ellipsis")).toHaveText("GPT-Reserve");
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers: { authorization: `Bearer ${token}` } });
  }
});
