// Ask others: picking the model (newer than 0.6.1), on a phone. The hub's answers are mocked the way asks.spec.ts does it: the shared test
// hub stays as it was and no agent ever runs. Every request the page makes is recorded, so a test can say that picking a model
// sent nothing at all: the pick goes with Ask, and the hub keeps it then.
import { test, expect, noHorizontalOverflow } from "./fixtures";
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import { join } from "node:path";

const hub = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
async function snap(page: Page, name: string) {
  if (process.env.CT_SHOTS) await page.screenshot({ path: join(process.env.CT_SHOTS, name), animations: "disabled" });
}

// ---- who can be asked, with their models (what GET /api/asks/targets?models=1 says) ----
const model = (id: string, label: string, patch: Record<string, unknown> = {}) => ({ id, label, description: null, efforts: [] as string[], defaultEffort: null, isDefault: false, paid: "no", typicalCostUsd: null, ...patch });
const PC = { id: "h_pc", name: "PC" };
const LAPTOP = { id: "h_laptop", name: "Laptop" };
const CODEX_MODELS = [
  model("gpt-5.5", "GPT-5.5", { isDefault: true, description: "Latest workhorse.", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 }),
  model("gpt-5.5-mini", "GPT-5.5 Mini", { description: "Quick and light.", efforts: ["low", "medium"], defaultEffort: "low", contextWindow: 200_000 }),
  model("gpt-chat", "GPT Chat", { noTools: true, contextWindow: 32_768, more: true }),
];
const CODEX = { target: { provider: "codex", account: "default", model: "gpt-5.5", effort: "medium" }, label: "Codex · GPT-5.5", sub: "Plan", handle: "codex", paid: "no", local: false, available: true, why: null, typicalCostUsd: null, models: CODEX_MODELS };
// An API key the person last asked on Sonnet: the hub has the row on it already, and says so.
const WORK = {
  target: { provider: "claude", account: "work", model: "sonnet", effort: null },
  label: "Claude Code (Work) · Sonnet 4.6",
  sub: "API key",
  handle: "work",
  paid: "yes",
  local: false,
  available: true,
  why: null,
  typicalCostUsd: 0.03,
  remembered: { model: "sonnet", effort: null },
  models: [model("opus", "Opus 5.5", { isDefault: true, paid: "yes", typicalCostUsd: 0.12, contextWindow: 1_000_000 }), model("sonnet", "Sonnet 4.6", { paid: "yes", typicalCostUsd: 0.03, contextWindow: 200_000 })],
};
const POOL = { target: { provider: "claude", account: "pool1", model: "qwen-pool", effort: null }, label: "Model pool · qwen-pool", sub: "On this Mac", handle: "model-pool", paid: "no", local: true, available: true, why: null, typicalCostUsd: null, fixedModel: "pool" };
const ON_PC = {
  target: { provider: "claude", account: "default", model: "opus", effort: null, machine: PC.id },
  label: "Claude Code · Opus 5.5 · on the PC",
  sub: "Plan",
  handle: "claude-on-pc",
  paid: "no",
  local: false,
  available: true,
  why: null,
  typicalCostUsd: null,
  machine: PC,
  models: [model("opus", "Opus 5.5", { isDefault: true, efforts: ["low", "high"] }), model("sonnet", "Sonnet 4.6", { efforts: ["low", "high"] })],
};
// A machine whose Crosstalk is older: no models came with its row, so the hub says it can't take a pick.
const ON_LAPTOP = { target: { provider: "claude", account: "q1", model: "qwen3-30b", effort: null, machine: LAPTOP.id }, label: "Qwen3 · qwen3-30b · on the Laptop", sub: "", handle: "qwen3-on-laptop", paid: "no", local: true, available: true, why: null, typicalCostUsd: null, machine: LAPTOP, fixedModel: "update" };
const CHOICES = [CODEX, WORK, POOL, ON_PC, ON_LAPTOP];

/** A card's title as the hub makes it: the name the row's machine gives the account, the model's own name, and where it runs. */
function labelOf(t: { provider: string; account: string; model: string | null; machine?: string }, rows: any[]): string {
  const row = rows.find((c) => c.target.provider === t.provider && c.target.account === t.account && c.target.machine === t.machine);
  const m = row?.models?.find((x: { id: string }) => x.id === t.model);
  return m ? `${row.label.split(" · ")[0]} · ${m.label}${row.machine ? ` · on the ${row.machine.name}` : ""}` : (row?.label ?? "Someone");
}

async function scenario(page: Page, request: APIRequestContext, token: string, choices: any[] = CHOICES) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Model picks" } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: any) => m.roomId === room.id);
  const history: any = { room, messages: [], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  let seq = 0;
  const message = (kind: string, text: string) => ({ id: `pick-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : "claude", memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: seq * 1000, updatedAt: seq * 1000 });
  let live: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (socket) => {
    live = socket;
    socket.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") socket.send(JSON.stringify({ t: "pong" }));
    });
  });
  delete member.readSeq;
  const read = () => ({ ...snapshot, members: snapshot.members.map((m: any) => (m.id === member.id && m.readSeq === undefined ? { ...m, readSeq: Math.max(0, ...history.messages.map((x: any) => x.seq)) } : m)) });
  await page.route("**/api/state", (r) => r.fulfill({ json: read() }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));

  const asks: any[] = [];
  const targets = { body: choices, urls: [] as string[] };
  const posted: any[] = [];
  await page.route(`**/api/rooms/${room.id}/asks`, (r) => r.fulfill({ json: asks }));
  await page.route("**/api/asks/targets**", (r) => {
    targets.urls.push(r.request().url());
    return r.fulfill({ json: { choices: targets.body, machines: [] } });
  });
  await page.route("**/api/asks", (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const body = r.request().postDataJSON();
    posted.push(body);
    const now = Date.now();
    const made = body.targets.map((t: any, i: number) => ({ id: `ask-${posted.length}-${i}`, roomId: room.id, messageId: body.messageId, target: t, label: labelOf(t, targets.body), status: "running", answer: null, error: null, cost: null, note: body.note ?? null, local: false, createdAt: now + i, startedAt: now, endedAt: null }));
    asks.push(...made);
    return r.fulfill({ json: made });
  });
  // Nothing in these tests may reach the chat's own agent.
  await page.route(`**/api/rooms/${room.id}/messages`, (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, json: { error: "A test sent a message it didn't mean to." } }) : r.fallback()));
  // Every request the page makes from here on: what a pick may never cause is a change sent anywhere, a model list asked for, or an ask.
  const requests: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/")) requests.push(`${r.method()} ${url.pathname}`);
  });
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
    await expect.poll(() => !!live).toBe(true);
  };
  const send = (e: unknown) => live!.send(JSON.stringify(e));
  return { room, history, message, asks, targets, posted, requests, open, send, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

/** Opens a message's actions (a tap on it) and the Ask others sheet. */
async function openSheet(page: Page, text: string) {
  const mine = page.locator(".your-msg").filter({ hasText: text });
  if (!(await mine.evaluate((el) => el.classList.contains("open")))) await mine.locator(".bubble").first().click({ position: { x: 6, y: 6 } });
  await mine.getByRole("button", { name: "Ask others", exact: true }).click();
  return page.getByRole("dialog", { name: "Ask others about this message" });
}

/**
 * Requests a model pick must never cause: anything that changes something, a model list, an ask. (The app marking the open
 * chat read is the app's own, not the pick's.)
 */
const sentByAPick = (requests: string[]) => requests.filter((r) => (!r.startsWith("GET ") && !r.endsWith("/read")) || r.includes("/api/providers/") || r.includes("/api/asks"));

test("Ask others: each one picked has the model picker under it, with sizes, No tools and costs; a pick sends nothing until Ask", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await scenario(page, request, token);
  const asked = s.message("human", "Is the retry logic right?");
  s.history.messages.push(asked, s.message("agent", "Yes: three tries with backoff."));
  try {
    await s.open();
    const sheet = await openSheet(page, "Is the retry logic right?");
    await expect(sheet.getByRole("checkbox")).toHaveCount(5);
    // The sheet asks for the models with the list (the @ popup doesn't need them).
    expect(s.targets.urls.at(-1)).toContain("models=1");
    // A row is on the model its name says: the API key opens on Sonnet, the one picked for it last time.
    await expect(sheet.getByRole("checkbox", { name: "Claude Code (Work) · Sonnet 4.6", exact: true })).toBeVisible();
    // Nothing is picked, so no picker yet: the list stays short on a phone.
    await expect(sheet.getByRole("combobox")).toHaveCount(0);
    const before = s.requests.length;

    // Codex: its own list (sizes, the More models group, No tools) and its effort levels.
    await sheet.getByRole("checkbox", { name: "Codex · GPT-5.5", exact: true }).check();
    const codex = sheet.getByRole("group", { name: "Model for Codex" });
    const codexModel = codex.getByRole("combobox", { name: "Model" });
    await expect(codexModel).toHaveValue("");
    await expect(codexModel.locator("option")).toHaveText(["Default (GPT-5.5)", "GPT-5.5 · 272k", "GPT-5.5 Mini · 200k", "GPT Chat · 32k · No tools"]);
    await expect(codex).toContainText("Latest workhorse. · 272k context");
    await expect(codex).not.toContainText("Other…");
    await expect(codex.getByRole("combobox", { name: "Effort" }).locator("option")).toHaveText(["Default (Medium)", "Low", "Medium", "High"]);
    // A model that can't run tools says so where it's picked; it has no effort levels.
    await codexModel.selectOption("gpt-chat");
    await expect(codex.getByRole("note")).toContainText("GPT Chat");
    await expect(codex.getByRole("combobox", { name: "Effort" })).toHaveCount(0);
    await expect(sheet.getByRole("checkbox", { name: "Codex · GPT Chat", exact: true })).toBeChecked();
    // Mini, at Medium: the row's name says the model.
    await codexModel.selectOption("gpt-5.5-mini");
    await codex.getByRole("combobox", { name: "Effort" }).selectOption("medium");
    await expect(sheet.getByRole("checkbox", { name: "Codex · GPT-5.5 Mini", exact: true })).toBeChecked();
    await expect(codex).toContainText("Quick and light. · 200k context");

    // The API key: what asks on each model have cost, and the sum under the list follows the model.
    await sheet.getByRole("checkbox", { name: "Claude Code (Work) · Sonnet 4.6", exact: true }).check();
    const work = sheet.getByRole("group", { name: "Model for Claude Code (Work)" });
    await expect(work.getByRole("combobox", { name: "Model" })).toHaveValue("sonnet");
    await expect(work).toContainText("Asks on Sonnet 4.6 have cost about $0.03 each.");
    await expect(sheet.getByText("Costs money: about $0.03", { exact: true })).toBeVisible();
    await work.getByRole("combobox", { name: "Model" }).selectOption("opus");
    await expect(work).toContainText("Asks on Opus 5.5 have cost about $0.12 each.");
    await expect(sheet.getByText("Costs money: about $0.12", { exact: true })).toBeVisible();
    await expect(sheet.locator("li").filter({ has: page.getByRole("checkbox", { name: "Claude Code (Work) · Opus 5.5", exact: true }) })).toContainText("Costs money");

    // The model pool and a machine with an older Crosstalk can't take a pick here: each says why, and where to change it.
    await sheet.getByRole("checkbox", { name: "Model pool · qwen-pool", exact: true }).check();
    await expect(sheet.getByText("The model pool runs one model at a time. To ask another, change it in Settings → Model pool.", { exact: true })).toBeVisible();
    await sheet.getByRole("checkbox", { name: "Qwen3 · qwen3-30b · on the Laptop", exact: true }).check();
    await expect(sheet.getByText("To pick its model from here, update Crosstalk on the Laptop. Until then it answers with the model the Laptop uses.", { exact: true })).toBeVisible();
    // Another machine's agent: that machine's models.
    await sheet.getByRole("checkbox", { name: "Claude Code · Opus 5.5 · on the PC", exact: true }).check();
    const pc = sheet.getByRole("group", { name: "Model for Claude Code on the PC" });
    await pc.getByRole("combobox", { name: "Model" }).selectOption("sonnet");
    await pc.getByRole("combobox", { name: "Effort" }).selectOption("high");
    await expect(sheet.getByRole("checkbox", { name: "Claude Code · Sonnet 4.6 · on the PC", exact: true })).toBeChecked();

    // All that picking sent nothing: no change, no model list, no ask.
    expect(sentByAPick(s.requests.slice(before))).toEqual([]);
    expect(s.posted).toEqual([]);
    // On a phone: nothing sticks out sideways, and every picker is a finger's height.
    await noHorizontalOverflow(page);
    const small = await sheet.locator(".ask-model select").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)).filter((h) => h < 44));
    expect(small).toEqual([]);
    const sticksOut = await sheet.locator(".ask-model, .ask-model-note").evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length);
    expect(sticksOut).toBe(0);
    await codex.scrollIntoViewIfNeeded();
    await snap(page, "ask-models-01-pickers.png");
    await pc.scrollIntoViewIfNeeded();
    await snap(page, "ask-models-02-machines.png");

    await sheet.getByRole("button", { name: "Ask 5", exact: true }).click();
    await expect(sheet).toBeHidden();
    // Each one is asked on the model and effort picked; the picks ride along for the hub to keep (not the pool's or the Laptop's).
    expect(s.posted).toEqual([
      {
        roomId: s.room.id,
        messageId: asked.id,
        targets: [
          { provider: "codex", account: "default", model: "gpt-5.5-mini", effort: "medium" },
          { provider: "claude", account: "work", model: "opus", effort: null },
          POOL.target,
          { provider: "claude", account: "default", model: "sonnet", effort: "high", machine: PC.id },
          ON_LAPTOP.target,
        ],
        remember: [
          { provider: "codex", account: "default", model: "gpt-5.5-mini", effort: "medium" },
          // Opus picked from the list, not "Default (Opus 5.5)": kept as Opus, whatever the default becomes later.
          { provider: "claude", account: "work", model: "opus", effort: null },
          { provider: "claude", account: "default", machine: PC.id, model: "sonnet", effort: "high" },
        ],
      },
    ]);
    expect(s.requests.filter((r) => r.includes("/messages") && r.startsWith("POST"))).toEqual([]);

    // The cards say the model each was asked on, and how hard it thinks when that was set.
    const cards = page.locator(".ask-card");
    await expect(cards).toHaveCount(5);
    await expect(cards.nth(0).getByRole("heading")).toHaveText("Codex · GPT-5.5 Mini · Medium effort");
    await expect(cards.nth(1).getByRole("heading")).toHaveText("Claude Code (Work) · Opus 5.5");
    await expect(cards.nth(3).getByRole("heading")).toHaveText("Claude Code · Sonnet 4.6 · on the PC · High effort");
    s.send({ t: "ask", ask: { ...s.asks[0], status: "done", answer: "Retry is fine; add jitter.", cost: { costUsd: null, basis: "plan", inputTokens: 900, outputTokens: 40 }, endedAt: s.asks[0].startedAt + 9_000 } });
    s.send({ t: "ask", ask: { ...s.asks[1], status: "done", answer: "Looks right.", cost: { costUsd: 0.11, basis: "exact", inputTokens: 1200, outputTokens: 80 }, endedAt: s.asks[1].startedAt + 14_000 } });
    await expect(cards.nth(0)).toContainText("Plan · 9 s");
    await expect(cards.nth(1)).toContainText("$0.11 · 14 s");
    await noHorizontalOverflow(page);
    await snap(page, "ask-models-04-cards.png");
  } finally {
    await s.cleanup();
  }
});

test("the sheet and an @name use the pick the hub kept; Default forgets it, and the message box hears of it at once", async ({ page, request, token }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  // The hub kept Codex on Mini at Medium: its row (in the sheet and in the @ popup) is on that pick already.
  const kept = { ...CODEX, target: { provider: "codex", account: "default", model: "gpt-5.5-mini", effort: "medium" }, label: "Codex · GPT-5.5 Mini", remembered: { model: "gpt-5.5-mini", effort: "medium" } };
  const s = await scenario(page, request, token, [kept, WORK]);
  const asked = s.message("human", "Should we cache this?");
  s.history.messages.push(asked, s.message("agent", "Yes, for an hour."));
  // How often the message box looked up who can be asked (the sheet asks with models=1, the box without).
  const boxLooks = () => s.targets.urls.filter((u) => !u.includes("models=1")).length;
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  const chips = page.getByRole("group", { name: "Others who will chime in" });
  const cards = page.locator(".agent-reply").filter({ hasText: "Yes, for an hour." }).locator(".ask-card");
  try {
    await s.open();
    // The sheet opens on the kept pick.
    let sheet = await openSheet(page, "Should we cache this?");
    await sheet.getByRole("checkbox", { name: "Codex · GPT-5.5 Mini", exact: true }).check();
    const codex = sheet.getByRole("group", { name: "Model for Codex" });
    await expect(codex.getByRole("combobox", { name: "Model" })).toHaveValue("gpt-5.5-mini");
    await expect(codex.getByRole("combobox", { name: "Effort" })).toHaveValue("medium");
    await snap(page, "ask-models-03-kept.png");
    // Unticking a row and ticking it again keeps what was picked for it; Cancel sends nothing at all.
    await codex.getByRole("combobox", { name: "Model" }).selectOption("gpt-chat");
    await sheet.getByRole("checkbox", { name: "Codex · GPT Chat", exact: true }).uncheck();
    await expect(sheet.getByRole("group", { name: "Model for Codex" })).toHaveCount(0);
    await sheet.getByRole("checkbox", { name: "Codex · GPT Chat", exact: true }).check();
    await expect(codex.getByRole("combobox", { name: "Model" })).toHaveValue("gpt-chat");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).toBeHidden();
    expect(s.posted).toEqual([]);

    // @codex asks the row the hub lists, which is on the kept pick (and nothing reaches the chat's own agent).
    await box.fill("@codex is an hour too long?");
    await expect(chips).toContainText("Codex · GPT-5.5 Mini will chime in");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(1);
    expect(s.posted[0]).toEqual({ roomId: s.room.id, messageId: "pick-2", targets: [kept.target], note: "is an hour too long?" });
    await expect(cards.first().getByRole("heading")).toHaveText("Codex · GPT-5.5 Mini · Medium effort");
    const looked = boxLooks();
    expect(looked).toBeGreaterThan(0);

    // Back to the defaults in the sheet: asked on the default model, and the hub is told to forget the pick.
    sheet = await openSheet(page, "Should we cache this?");
    await sheet.getByRole("checkbox", { name: "Codex · GPT-5.5 Mini", exact: true }).check();
    const before = s.requests.length;
    await codex.getByRole("combobox", { name: "Model" }).selectOption("");
    // Medium is one of the default model's levels too, so it stays until it's changed.
    await expect(codex.getByRole("combobox", { name: "Effort" })).toHaveValue("medium");
    await codex.getByRole("combobox", { name: "Effort" }).selectOption("");
    await expect(sheet.getByRole("checkbox", { name: "Codex · GPT-5.5", exact: true })).toBeChecked();
    expect(sentByAPick(s.requests.slice(before))).toEqual([]);
    await sheet.getByRole("button", { name: "Ask 1", exact: true }).click();
    await expect(sheet).toBeHidden();
    expect(s.posted[1]).toEqual({ roomId: s.room.id, messageId: asked.id, targets: [{ provider: "codex", account: "default", model: "gpt-5.5", effort: "medium" }], remember: [{ provider: "codex", account: "default", model: null, effort: null }] });
    // The hub forgot it: its list has Codex on its default again.
    s.targets.body = [CODEX, WORK];

    // The message box read its list again (it had it from a moment ago), so @codex now asks the default.
    await box.fill("@codex and now?");
    await expect.poll(boxLooks).toBeGreaterThan(looked);
    await expect(chips).toContainText("Codex · GPT-5.5 will chime in");
    await page.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await expect.poll(() => s.posted.length).toBe(3);
    expect(s.posted[2]).toEqual({ roomId: s.room.id, messageId: "pick-2", targets: [CODEX.target], note: "and now?" });
    await noHorizontalOverflow(page);
  } finally {
    await s.cleanup();
  }
});
