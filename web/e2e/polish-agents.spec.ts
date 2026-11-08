// Agents: what a chat's agent runs on and how a reply is produced — the model picked under the message box, the model
// its helper agents use, the account an agent is moved to, the @name it is given, and asking another agent about a
// message. The hub's answers are routed in the page (as moreModels.spec.ts does), so no agent ever runs and the shared
// test hub is left as it was.
//
// Every test below is EXPECTED TO FAIL on today's code; each says which line is wrong in a comment above it.
//
// None of them forces a viewport, so they run at every width the suite has (320 to 1440, Chromium and WebKit):
// `bunx playwright test e2e/polish-agents.spec.ts --project chromium-390` for a phone, `--project webkit-320` for the
// smallest screen, `--project chromium-1440` for a desktop. The two that matter most on a phone are the helper
// drop-down with nothing picked in it and the model shown as a name typed into "Other…".
import { test, expect, openGroupAgent } from "./fixtures";
import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";

const hub = "http://127.0.0.1:8451";

/**
 * Claude Code's list as its own CLI gives it (hub/test/fixtures/fake-claude): the id is the alias the CLI takes
 * ("haiku"), `resolvedModel` the concrete model behind it. Nearly every Claude model has both, which is what the
 * tests below turn on.
 */
const OPUS = { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", description: "For complex work", isDefault: true, efforts: ["low", "high"], defaultEffort: null, contextWindow: 1_000_000 };
const HAIKU = { id: "haiku", resolvedModel: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", isDefault: false, efforts: [], defaultEffort: null, contextWindow: 200_000 };
const CLAUDE_MODELS = { provider: "claude", accountId: "default", live: true, error: null, models: [OPUS, HAIKU] };

/** A one-agent chat whose hub answers the page gives itself: settings changes come back the way the hub sends them. */
async function chat(page: Page, request: APIRequestContext, token: string, provider: "claude" | "codex", name: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider, name } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: { roomId: string }) => m.roomId === room.id);
  const history = { room, messages: [] as Record<string, unknown>[], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
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
  const open = async () => {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  };
  return { room, member, history, patches, open, cleanup: () => request.delete(`${hub}/api/rooms/${room.id}`, { headers }) };
}

const chatSettings = async (page: Page) => {
  await page.getByRole("button", { name: "Chat settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Chat settings", exact: true });
  await expect(settings).toBeVisible();
  return settings;
};

// EXPECTED TO FAIL. ChatControls.chooseModel saves the concrete model (`model: next?.resolvedModel ?? id`), while
// AgentOptions judges a saved model against the list by `m.id` only (AgentOptions.tsx line 52, web/src/models.ts
// isCustomModel line 10). So a model picked under the message box comes back in the chat's settings as a name you
// typed in yourself: "Other…" with "claude-haiku-4-5-20251001" in the box, no description of the model, and an Effort
// menu built from every level the agent's *other* models take (Haiku takes none) — which can then be saved.
test("a model picked under the message box is the same model in the chat's settings", async ({ page, request, token }) => {
  const s = await chat(page, request, token, "claude", "Model round trip");
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: CLAUDE_MODELS }));
  try {
    await s.open();
    await page.locator(".chat-controls .ctl-model").click();
    const menu = page.getByRole("dialog", { name: "Model", exact: true });
    await menu.getByRole("menuitemradio").filter({ hasText: "Haiku 4.5" }).click();
    await expect.poll(() => s.patches.length).toBe(1);
    // What the hub is told today: the concrete model behind the alias.
    expect(s.patches.at(-1)).toMatchObject({ model: "claude-haiku-4-5-20251001" });
    await expect(page.locator(".chat-controls .ctl-model .ellipsis")).toHaveText("Haiku 4.5");

    const settings = await chatSettings(page);
    const model = settings.getByRole("combobox", { name: "Model", exact: true });
    // The same model the row shows, picked in the list — not a name typed into "Other…".
    await expect(settings.getByPlaceholder("Model name, as the agent's CLI takes it")).toHaveCount(0);
    await expect(model).not.toHaveValue("__custom__");
    await expect(settings.locator(".field").filter({ has: page.getByRole("combobox", { name: "Model", exact: true }) }).locator(".help")).toHaveText("Fastest for quick answers · 200k context");
    // Haiku takes no effort levels, so there is no Effort menu to set one from.
    await expect(settings.getByRole("combobox", { name: "Effort", exact: true })).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

// EXPECTED TO FAIL. ChatControls.chooseModel means to drop a helper pick that has become the chat's own model
// ("Helpers on the chat's own model again need no separate pick"), but compares the saved helper id — kept as the
// concrete model (HelperSelect's `id()` = `resolvedModel ?? id`) — against the menu entry's alias id:
// `if (config.helperModel === id) delete config.helperModel`. For every aliased Claude model the two never match, so
// the pick stays on the chat's own model: the row keeps the "Helper agents use Haiku 4.5" marker, and the drop-down
// that would take it off has nothing selected at all (its own model is filtered out of the options).
test("picking the model the helpers were on takes the helper pick off", async ({ page, request, token }) => {
  const s = await chat(page, request, token, "claude", "Helpers on the chat's model");
  s.member.config = { ...s.member.config, helperModel: "claude-haiku-4-5-20251001" };
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: CLAUDE_MODELS }));
  try {
    await s.open();
    await page.locator(".chat-controls .ctl-model").click();
    const menu = page.getByRole("dialog", { name: "Model", exact: true });
    const helpers = menu.getByRole("combobox", { name: "Helper agents use", exact: true });
    await expect(helpers.locator("option:checked")).toHaveText("Haiku 4.5");
    // The chat moves onto the model its helpers were already on.
    await menu.getByRole("menuitemradio").filter({ hasText: "Haiku 4.5" }).click();
    await expect.poll(() => s.patches.length).toBe(1);
    expect(s.patches.at(-1)!.config).not.toHaveProperty("helperModel");

    await page.locator(".chat-controls .ctl-model").click();
    // Something is picked in the drop-down: with the pick gone it reads "The same model as this agent".
    await expect(menu.getByRole("combobox", { name: "Helper agents use", exact: true }).locator("option:checked")).toHaveText("The same model as this agent");
    // And the row no longer marks a separate model for helpers.
    await expect(page.locator('.chat-controls [aria-label="Helper agents use Haiku 4.5"]')).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

// EXPECTED TO FAIL. A chat's own settings reset the model, effort and helper model when the account changes
// (AgentOptions.tsx line 87: "setCustom(false); set({ account, model: "", effort: "", helperModel: "" })"), because a
// model belongs to the account that lists it. The agent dialog (group chats and rooms) only does `onChange={setAccount}`
// (AgentDialog.tsx line 236) and then saves `model: model.trim() || null` (line 125), so the other account's model is
// written to the new one — and the hub keeps it (app.ts updateMember resets only `helperModel`, line 1007). The field
// that would show it is inside the collapsed "Advanced" section, so nothing on screen says it happened.
test("moving an agent to another account doesn't carry the other account's model over", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Account move", mode: "direct" } })).json();
  const member = await (await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "claude", handle: "builder", model: "opus" } })).json();
  const accounts = [
    { provider: "claude", id: "default", label: "Main", kind: "signin", signedIn: true, account: "you@example.com", plan: "Max", authMethod: null, error: null, checkedAt: Date.now() },
    { provider: "claude", id: "local", label: "Qwen here", kind: "endpoint", signedIn: true, account: null, plan: "Custom model", authMethod: null, error: null, checkedAt: Date.now(), endpoint: { baseUrl: "http://127.0.0.1:8080", models: ["qwen3-8b"], contextWindow: 16_384, hasKey: false, protocol: "chat" } },
  ];
  await page.route("**/api/accounts", (r) => (r.request().method() === "GET" ? r.fulfill({ json: accounts }) : r.continue()));
  await page.route("**/api/providers/claude/models**", (r) =>
    r.fulfill({ json: new URL(r.request().url()).searchParams.get("account") === "local"
      ? { provider: "claude", accountId: "local", live: true, error: null, models: [{ id: "qwen3-8b", label: "qwen3-8b", description: "On Qwen here", isDefault: true, efforts: [], defaultEffort: null, contextWindow: 16_384 }] }
      : CLAUDE_MODELS }));
  const patches: Record<string, unknown>[] = [];
  await page.route(`**/api/members/${member.id}`, (r) => {
    if (r.request().method() !== "PATCH") return r.continue();
    patches.push(r.request().postDataJSON());
    return r.fulfill({ json: { ...member, ...r.request().postDataJSON() } });
  });
  try {
    await page.goto(`/#/room/${room.id}`);
    const dialog = await openGroupAgent(page, "builder");
    await dialog.getByRole("combobox", { name: "Account", exact: true }).selectOption("local");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    // The new account has no Opus: the chat is started on that account's own model instead of one it can't run.
    expect(patches.at(-1)!.model).not.toBe("opus");
    expect(patches.at(-1)!.model).not.toBe("claude-opus-5-5");
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
  }
});

// EXPECTED TO FAIL. The handle box takes whatever is typed and the line under it promises it as the @name
// ("Others mention it as @{handle}", AgentDialog.tsx line 290), but the hub slugs it (slugHandle: lower case, anything
// but a-z0-9- becomes "-", and a name with no Latin letters at all becomes "a-"). "Build Bot" is saved as @build-bot,
// "Клод" as @a-, and the toast on save repeats the typed name too, so nothing on screen ever says the real @name —
// and typing the promised name in a message mentions nobody. New group chats already get this right (groupChat.ts
// suggestHandle slugs the name as it is typed).
test("the @name the agent dialog promises is the @name the agent gets", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Handles", mode: "direct" } })).json();
  await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "claude", handle: "builder" } });
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: CLAUDE_MODELS }));
  try {
    await page.goto(`/#/room/${room.id}`);
    for (const typed of ["Build Bot", "Клод"]) {
      const dialog = await openGroupAgent(page, typed === "Build Bot" ? "builder" : "build-bot");
      await dialog.getByText("Advanced: name, model, effort, instructions", { exact: true }).click();
      const handle = dialog.getByRole("textbox", { name: "Handle" });
      await handle.fill(typed);
      const promised = ((await dialog.getByText(/^Others mention it as @/).textContent()) ?? "").replace(/^Others mention it as @/, "").replace(/\.$/, "").trim();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      // The chat's list of agents says what the agent is really called: the dialog must have promised that name.
      const settings = page.getByRole("dialog", { name: "Group chat settings", exact: true });
      await expect(settings.getByRole("button", { name: `Change @${promised}`, exact: true })).toBeVisible();
      await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
  }
});

// EXPECTED TO FAIL. The message box refuses a draft longer than 2,000 characters with words and a way out
// ("That's too long to ask others (2,000 characters at most)…", web/src/asks.ts sendPlan), because the hub keeps only
// that much. The sheet that the "Ask others" button opens has no such check and no maxLength on its box
// (AskSheet.tsx line 196), and the hub cuts it without a word (`input.note.trim().slice(0, NOTE_MAX)`,
// hub/src/asks.ts line 496): the other agent answers half a question and nothing ever says so.
test("a question too long to ask says so before it is sent, instead of being cut on the hub", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/chats`, { headers, data: { provider: "claude", name: "Long question" } })).json();
  const snapshot = await (await request.get(`${hub}/api/state`, { headers })).json();
  const member = snapshot.members.find((m: { roomId: string }) => m.roomId === room.id);
  const asked = { id: "msg-1", seq: 1, roomId: room.id, authorKind: "human", authorName: "Phone", memberId: null, text: "Is this migration safe to run on production?", mentions: [], turnId: null, status: "done", createdAt: 1000, updatedAt: 1000 };
  await page.routeWebSocket("**/api/ws?**", (ws) => ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); }));
  await page.route("**/api/state", (r) => r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: { id: string }) => (m.id === member.id ? { ...m, readSeq: 1 } : m)) } }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: { room, messages: [asked], turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } }));
  await page.route(`**/api/rooms/${room.id}/asks`, (r) => r.fulfill({ json: [] }));
  await page.route("**/api/asks/targets**", (r) => r.fulfill({ json: { choices: [{ target: { provider: "codex", account: "default", model: "gpt-5.5", effort: null }, label: "Codex · GPT-5.5", sub: "Plan", handle: "codex", paid: "no", local: false, available: true, why: null, typicalCostUsd: null }], machines: [] } }));
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/asks", (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    posted.push(r.request().postDataJSON());
    return r.fulfill({ json: [] });
  });
  try {
    await page.goto(`/#/room/${room.id}`);
    const mine = page.locator(".your-msg").filter({ hasText: "Is this migration safe" });
    await expect(mine).toBeVisible();
    if (!(await mine.evaluate((el) => el.classList.contains("open")))) await mine.locator(".bubble").first().click({ position: { x: 6, y: 6 } });
    await mine.getByRole("button", { name: "Ask others", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Ask others about this message" });
    await sheet.getByRole("checkbox", { name: "Codex · GPT-5.5" }).check();
    const question = `${"Please review this migration very carefully. ".repeat(50)}Last of all: is the down migration safe?`;
    expect(question.length).toBeGreaterThan(2000);
    await sheet.getByRole("textbox").fill(question);
    // Said here, as the message box says it, before anything is sent.
    await expect(sheet).toContainText("2,000 characters at most");
    await sheet.getByRole("button", { name: /^Ask 1$/ }).click();
    expect(posted).toHaveLength(0);
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
  }
});

// EXPECTED TO FAIL. In the agent dialog the Model and Effort drop-downs have no aria-label, unlike every other model
// picker in the app (AgentOptions gives them one). Their accessible name is then the whole <label> they sit in — the
// word, the chosen option and the help sentence — so a screen reader reads "Model Opus 5.5 For complex work · 1M
// context" and no test can address them by name. web/e2e/effort.spec.ts line 26 already asserts
// `combobox { name: "Effort", exact: true }` has count 0 and passes for that reason alone: it would pass even if the
// Effort menu were on screen.
test("the agent dialog's Model and Effort are named for a screen reader", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Named controls", mode: "direct" } })).json();
  await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "codex", handle: "builder" } });
  await page.route("**/api/providers/codex/models*", (r) => r.fulfill({ json: { provider: "codex", accountId: "default", live: true, error: null, models: [{ id: "codex-model", label: "Codex model", description: null, isDefault: true, efforts: ["low", "high"], defaultEffort: "low" }] } }));
  try {
    await page.goto(`/#/room/${room.id}`);
    const dialog = await openGroupAgent(page, "builder");
    await dialog.getByText("Advanced: name, model, effort, instructions", { exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(1);
    await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveCount(1);
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
  }
});

// EXPECTED TO FAIL. The agent dialog is opened with the Member object as it was when "Change" was tapped
// (GroupSettings.tsx `const [editing, setEditing] = useState<Member | "new" | null>(null)`), and saves
// `config: { ...member.config, account }` from that snapshot (AgentDialog.tsx line 113). The hub replaces a member's
// config wholesale (app.ts updateMember: `allowed.config = { ...patch.config }`), so anything that changed while the
// dialog was open — the agent asking in the chat for helpers on another model (App.useHelperModel), or another device
// — is silently written back to what it was. Here only the permission is touched, and the helper model set meanwhile
// disappears with the save.
test("saving one setting in the agent dialog doesn't undo what changed meanwhile", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Two writers", mode: "direct" } })).json();
  const member = await (await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "claude", handle: "builder" } })).json();
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: CLAUDE_MODELS }));
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });
  });
  const patches: Record<string, unknown>[] = [];
  await page.route(`**/api/members/${member.id}`, (r) => {
    if (r.request().method() !== "PATCH") return r.continue();
    patches.push(r.request().postDataJSON());
    return r.fulfill({ json: { ...member, ...r.request().postDataJSON() } });
  });
  try {
    await page.goto(`/#/room/${room.id}`);
    const dialog = await openGroupAgent(page, "builder");
    // While the dialog is open, the agent is given another model for its helpers (the user said yes in the chat).
    await expect.poll(() => !!socket).toBe(true);
    socket!.send(JSON.stringify({ t: "member", member: { ...member, config: { ...member.config, helperModel: "claude-haiku-4-5-20251001" } } }));
    await dialog.getByRole("radio", { name: /Can edit/ }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect((patches.at(-1)!.config as Record<string, unknown>).helperModel).toBe("claude-haiku-4-5-20251001");
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
  }
});

// EXPECTED TO FAIL. "Always allow" on an approval card keeps a rule per agent, in any kind of chat (hub/src/mcp/
// internal.ts writes `allowRules` on the member's session; Codex keeps allowCommands/allowFiles). A one-agent chat
// lists them in its settings with Remove (ChatScreen.tsx AlwaysAllowedList, GET/DELETE /api/members/:id/always), but
// a group chat's or room's agent dialog never asks for them: once you tap "Always allow `rm` commands" there, nothing
// on any screen says it happened and the only way back is to lower that agent's permissions, which takes back every
// rule at once (app.ts clearAlwaysAllowed) — and not even that when the account changed in the same save (line 1013).
test("a group chat's agent shows what it is always allowed, and can be taken back", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${hub}/api/rooms`, { headers, data: { name: "Always allowed", mode: "direct" } })).json();
  const member = await (await request.post(`${hub}/api/rooms/${room.id}/members`, { headers, data: { provider: "claude", handle: "builder" } })).json();
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: CLAUDE_MODELS }));
  await page.route(`**/api/members/${member.id}/always`, (r) =>
    r.fulfill({ json: r.request().method() === "DELETE" ? [] : [{ id: "rule:Bash(rm:*)", label: "`rm` commands" }] }));
  try {
    await page.goto(`/#/room/${room.id}`);
    const dialog = await openGroupAgent(page, "builder");
    await expect(dialog.getByText("Always allowed", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Remove: rm commands", exact: true }).click();
    await expect(dialog.getByText("rm", { exact: true })).toHaveCount(0);
  } finally {
    await request.delete(`${hub}/api/rooms/${room.id}`, { headers });
  }
});
