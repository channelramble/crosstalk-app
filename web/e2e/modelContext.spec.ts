import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import { join } from "node:path";

const hub = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});

// As Codex's catalog has them: the window it gives each model, the share the conversation fills, where it compacts,
// and the most a chat can be given.
const sol = { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "Latest workhorse model.", isDefault: true, efforts: ["low", "high"], defaultEffort: "low", contextWindow: 500_000, usableContext: 475_000, compactAt: 450_000, maxContextWindow: 872_000, firstSeen: 0 };
const astra = { id: "gpt-6-astra", label: "GPT-6-Astra", description: "Frontier model.", isDefault: false, efforts: ["low", "high"], defaultEffort: "high", contextWindow: 272_000, usableContext: 258_400, compactAt: 244_800, maxContextWindow: 872_000, firstSeen: 0 };

/** A Codex chat whose hub events this test sends itself, and whose settings changes come back the way the hub sends them. */
async function codexChat(page: Page, request: APIRequestContext, token: string, name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "codex", name } })).json();
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
  return { room, member, history, patches, send, open, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

test("the model menu says what each model holds, marks new ones, and keeps up with the hub's list", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await codexChat(page, request, token, "Context sizes");
  const models = [sol, { ...astra, firstSeen: Date.now() - 3600_000 }];
  await page.route("**/api/providers/codex/models**", (r) => r.fulfill({ json: { provider: "codex", accountId: "default", live: true, error: null, models } }));
  try {
    await s.open();
    await page.locator(".chat-controls .ctl-model").click();
    const menu = page.getByRole("dialog", { name: "Model", exact: true });
    const item = (name: string) => menu.getByRole("menuitemradio").filter({ hasText: name });
    await expect(item("GPT-6.1-Sol")).toContainText("Default");
    await expect(item("GPT-6.1-Sol")).toContainText("Latest workhorse model. · 500k context, up to 872k");
    await expect(item("GPT-6-Astra")).toContainText("New");
    await expect(item("GPT-6-Astra")).toContainText("Frontier model. · 272k context, up to 872k");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("model-menu.png"), animations: "disabled" });

    // Codex starts offering a model: the hub says so, and the open menu has it.
    s.send({ t: "models", catalog: { provider: "codex", accountId: "default", live: true, error: null, models: [...models, { id: "gpt-7", label: "GPT-7", description: "Brand new.", isDefault: false, efforts: [], defaultEffort: null, contextWindow: 1_000_000, firstSeen: Date.now() }] } });
    await expect(item("GPT-7")).toContainText("Brand new. · 1M context");
    await expect(item("GPT-7")).toContainText("New");

    // A model typed in by name (never in Codex's list) is just shown as set.
    s.send({ t: "member", member: { ...s.member, model: "my-own-model" } });
    await expect(item("my-own-model")).toContainText("Set in chat settings.");
    await expect(item("my-own-model")).not.toHaveClass(/warn/);
    // The chat's model was in Codex's list and isn't any more: the menu says so, with the models to pick from right there.
    s.send({ t: "models", catalog: { provider: "codex", accountId: "default", live: true, error: null, models, gone: ["gpt-5.5-old"] } });
    s.send({ t: "member", member: { ...s.member, model: "gpt-5.5-old" } });
    await expect(item("gpt-5.5-old")).toContainText("Codex doesn't list this model now, so replies may fail. Pick one above.");
    await expect(item("gpt-5.5-old")).toHaveClass(/warn/);
  } finally {
    await s.cleanup();
  }
});

test("the context panel: what the chat's model holds before a reply, Codex's long context, and where it compacts", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await codexChat(page, request, token, "Long context");
  s.member.model = "gpt-6-astra";
  await page.route("**/api/providers/codex/models**", (r) => r.fulfill({ json: { provider: "codex", accountId: "default", live: true, error: null, models: [sol, astra] } }));
  try {
    await s.open();
    await page.locator(".chat-controls").getByRole("button", { name: /context and plan limits/ }).click();
    const pop = page.getByRole("dialog", { name: "Context and plan limits", exact: true });
    // Before the first reply: what the model holds, from Codex's list.
    await expect(pop).toContainText("Holds 258k. Shows how full it is after Codex's next reply.");
    await expect(pop).toContainText("GPT-6-Astra has 272k; Codex keeps 5% of it for its instructions and the reply.");
    const compact = pop.locator("select");
    await expect(compact.locator("option")).toHaveText(["Codex's default (245k)", "100k tokens", "200k tokens"]);

    // Long context: the most Codex allows this model, and compaction moves with it.
    const long = pop.locator(".ultracode-row").filter({ hasText: "Long context" });
    await expect(long).toContainText("Up to 872k instead of 272k, so it compacts less often. Long chats use your plan faster.");
    await long.locator("label.switch").click();
    await expect.poll(() => (s.patches.at(-1)?.config as Record<string, unknown> | undefined)?.longContext).toBe(true);
    await expect(pop).toContainText("Holds 828k.");
    await expect(pop).toContainText("GPT-6-Astra has 872k with long context; Codex keeps 5% of it");
    await expect(compact.locator("option")).toHaveText(["Codex's default (785k)", "100k tokens", "200k tokens", "400k tokens", "600k tokens"]);

    // A reply's reading: how full it is, against the long window.
    s.send({ t: "turn", turn: { id: "ctx-turn", roomId: s.room.id, memberId: s.member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: "ctx-turn", origin: "human", status: "done", error: null, usage: { inputTokens: 414_200, outputTokens: 900, cachedInputTokens: 0, costUsd: null, contextTokens: 414_200, contextWindow: 828_400 }, createdAt: Date.now() - 5000, startedAt: Date.now() - 5000, endedAt: Date.now() } });
    await expect(pop.locator(".usage-line").first()).toContainText("414k of 828k");
    await expect(pop.locator(".usage-line").first()).toContainText("50%");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("context-panel.png"), animations: "disabled" });

    // A compaction size only long context reaches…
    await compact.selectOption("600000");
    await expect.poll(() => (s.patches.at(-1)?.config as Record<string, unknown> | undefined)?.autoCompact).toBe(600_000);
    // …and another model that can be given more keeps both.
    const before = s.patches.length;
    await page.locator(".chat-controls .ctl-model").click();
    await page.getByRole("dialog", { name: "Model", exact: true }).getByRole("menuitemradio").filter({ hasText: "GPT-6.1-Sol" }).click();
    await expect.poll(() => s.patches.length).toBe(before + 1);
    expect(s.patches.at(-1)).toMatchObject({ model: "gpt-6.1-sol", config: { longContext: true, autoCompact: 600_000 } });
    // Off again: Codex's own window, and the 600k it no longer reaches goes back to Codex's own compaction point.
    await page.locator(".chat-controls").getByRole("button", { name: /context and plan limits/ }).click();
    await page.getByRole("dialog", { name: "Context and plan limits", exact: true }).locator(".ultracode-row label.switch").click();
    await expect.poll(() => s.patches.length).toBe(before + 2);
    const off = s.patches.at(-1)!.config as Record<string, unknown>;
    expect(off.longContext).toBeUndefined();
    expect(off.autoCompact).toBeUndefined();
  } finally {
    await s.cleanup();
  }
});

test("a Claude chat: each model's own window, and the context ring follows a model switch at once", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Claude sizes" } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: { roomId: string }) => m.roomId === room.id);
  const turn = { id: "c-turn", roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: "c-turn", origin: "human", status: "done", error: null, usage: { inputTokens: 150_000, outputTokens: 100, cachedInputTokens: 0, costUsd: null, contextTokens: 150_000, contextWindow: 1_000_000 }, createdAt: 1, startedAt: 1, endedAt: 2 };
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: { room, messages: [], turns: [turn], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } }));
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: { provider: "claude", accountId: "default", live: true, error: null, models: [
    { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", description: "For complex work", isDefault: true, efforts: ["low", "high"], defaultEffort: null, contextWindow: 1_000_000, compactAt: 967_000 },
    { id: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", label: "Sonnet 4.6", description: "Efficient for routine tasks", isDefault: false, efforts: ["low", "high"], defaultEffort: null, contextWindow: 200_000, compactAt: 167_000 },
  ] } }));
  try {
    await page.goto(`/#/room/${room.id}`);
    const ring = page.locator(".chat-controls .ring-btn");
    await expect(ring).toHaveAttribute("aria-label", /^Context 15% full/);
    await page.locator(".chat-controls .ctl-model").click();
    const menu = page.getByRole("dialog", { name: "Model", exact: true });
    await expect(menu.getByRole("menuitemradio").filter({ hasText: "Sonnet 4.6" })).toContainText("Efficient for routine tasks · 200k context");
    await menu.getByRole("menuitemradio").filter({ hasText: "Sonnet 4.6" }).click();
    // 150k of Sonnet 4.6's 200k: the ring says so without waiting for a reply on it.
    await expect(ring).toHaveAttribute("aria-label", /^Context 75% full/);
    await ring.click();
    const pop = page.getByRole("dialog", { name: "Context and plan limits", exact: true });
    await expect(pop.locator(".usage-line").first()).toContainText("150k of 200k");
    await expect(pop.locator("select option").first()).toHaveText("Claude Code's default (167k)");
    // Claude Code has no long context to turn on.
    await expect(pop.getByText("Long context", { exact: true })).toHaveCount(0);
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
  }
});
