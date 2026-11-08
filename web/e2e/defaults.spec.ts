import { test, expect, noHorizontalOverflow, openGroupSettings } from "./fixtures";

const defaults = { mode: "review", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: {} };
// The row says what new chats start with (its summary changes with the saved picks), so it's found by its name.
const card = (page: import("@playwright/test").Page, name = "Codex") => page.getByRole("group", { name: `New ${name} chat defaults`, exact: true });
async function openDefaults(page: import("@playwright/test").Page, name = "Codex") {
  await page.goto("/#/settings");
  const row = card(page, name);
  // Settled: it says the saved picks, or (when they couldn't be read) it's open already, to show why.
  await expect.poll(async () => (await row.getAttribute("open")) !== null || !(await row.locator("summary").innerText()).trim().endsWith("…")).toBe(true);
  if ((await row.getAttribute("open")) === null) await row.locator("summary").click();
  return row;
}

test("Defaults retries failed loads and protects edits during a save", async ({ page }) => {
  let fail = true;
  let finishSave: (() => Promise<void>) | undefined;
  await page.route("**/api/settings/defaults**", (route) => {
    if (route.request().method() === "GET") return route.fulfill(fail ? { status: 503, json: { error: "Defaults are temporarily unavailable" } } : { json: defaults });
    return new Promise<void>((resolve) => {
      finishSave = async () => { await route.fulfill({ json: { ...defaults, agent: { codex: route.request().postDataJSON() } } }); resolve(); };
    });
  });
  const section = await openDefaults(page);
  await expect(section.getByRole("alert")).toContainText("Defaults are temporarily unavailable");
  fail = false;
  await section.getByRole("button", { name: "Retry defaults", exact: true }).click();
  await section.getByRole("radio", { name: "Full access", exact: true }).click();
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await expect(section.getByRole("combobox", { name: "Model", exact: true })).toBeDisabled();
  await expect.poll(() => !!finishSave).toBe(true);
  await finishSave!();
  await expect(section.getByRole("combobox", { name: "Model", exact: true })).toBeEnabled();
  await expect(section.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("Defaults navigation can keep edits or explicitly discard them", async ({ page }) => {
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: defaults }));
  const section = await openDefaults(page);
  await section.getByRole("radio", { name: "Full access", exact: true }).click();
  let discard = false;
  let confirmations = 0;
  page.on("dialog", async (dialog) => { confirmations++; if (discard) await dialog.accept(); else await dialog.dismiss(); });
  await page.evaluate(() => { location.hash = "#/usage"; });
  await expect.poll(() => confirmations).toBe(1);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(section.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  discard = true;
  await page.evaluate(() => { location.hash = "#/usage"; });
  await expect(page.locator(".topbar h1")).toHaveText("Usage");
});

test("new chat waits for defaults, applies them and respects explicit choices", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  let release: (() => Promise<void>) | undefined;
  await page.route("**/api/settings/defaults", (route) => new Promise<void>((resolve) => {
    release = async () => { await route.fulfill({ json: { ...defaults, agent: { codex: { permissionMode: "auto", model: null, effort: null } } } }); resolve(); };
  }));
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await expect(dialog).toContainText("Loading your defaults");
  await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toBeDisabled();
  await expect.poll(() => !!release).toBe(true);
  await release!();
  await dialog.getByRole("radio", { name: "Full access", exact: true }).click();
  const created = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
  const room = await (await created).json();
  try {
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    const state = await (await request.get("http://127.0.0.1:8451/api/state", { headers: auth })).json();
    expect(state.members.filter((m: { roomId: string }) => m.roomId === room.id)).toMatchObject([{ provider: "codex", permissionMode: "full" }]);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("adding an agent preserves custom defaults, switches catalogs and explicitly clears effort", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Agent defaults browser test", mode: "direct" } })).json();
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: { ...defaults, agent: {
    claude: { permissionMode: "auto", model: "custom-claude-model", effort: "high" },
    codex: { permissionMode: "full", model: "codex-model", effort: "high" },
  } } }));
  await page.route("**/api/providers/*/models", (route) => {
    const provider = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ json: { provider, live: true, models: [
      { id: `${provider}-model`, label: `${provider} model`, isDefault: true, efforts: provider === "codex" ? ["low"] : ["low", "high"] },
      { id: `${provider}-other`, label: "Another model", efforts: ["high", "ultra"] },
    ] } });
  });
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.locator(".topbar h1")).toHaveText(room.name);
    // A room is a group chat now: its agents are added from its settings.
    const settings = await openGroupSettings(page);
    await settings.getByRole("button", { name: "Add an agent", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add an agent", exact: true });
    await dialog.getByText("Advanced: name, model, effort, instructions", { exact: true }).click();
    await expect(dialog.getByPlaceholder("Model name, as the agent's CLI takes it")).toHaveValue("custom-claude-model");
    await dialog.getByRole("button", { name: /^Codex / }).click();
    await expect(dialog.getByPlaceholder("Model name, as the agent's CLI takes it")).toHaveCount(0);
    const effort = dialog.getByText("Effort", { exact: true }).locator("..").locator("select");
    await expect(effort.locator("option")).toHaveText(["Default", "Low"]);
    await effort.selectOption("");
    const created = page.waitForResponse((response) => response.url().endsWith(`/api/rooms/${room.id}/members`) && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Add to chat", exact: true }).click();
    const member = await (await created).json();
    expect(member.model).toBe("codex-model");
    expect(member.config.effort).toBeNull();
    expect(member.permissionMode).toBe("full");
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("each supported agent keeps separate new-chat defaults", async ({ page }) => {
  let state = { ...defaults, agent: { claude: { permissionMode: "ask", model: null, effort: null }, codex: { permissionMode: "auto", model: null, effort: null } } };
  await page.route("**/api/settings/defaults**", (route) => {
    if (route.request().method() === "PATCH") state = { ...state, agent: { ...state.agent, claude: route.request().postDataJSON() } };
    return route.fulfill({ json: state });
  });
  const section = await openDefaults(page, "Claude Code");
  await section.getByRole("radio", { name: "Full access", exact: true }).click();
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await expect(section.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(state.agent.claude.permissionMode).toBe("full");
  expect(state.agent.codex.permissionMode).toBe("auto");
});

test("creating a chat saves its selected model and effort without starting an agent turn", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  await page.route("**/api/providers/codex/models*", (route) => route.fulfill({ json: { provider: "codex", live: true, models: [{ id: "chosen-model", label: "Chosen model", efforts: ["high"], isDefault: true }] } }));
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await dialog.getByRole("combobox", { name: "Model", exact: true }).selectOption("chosen-model");
  await dialog.getByRole("combobox", { name: "Effort", exact: true }).selectOption("high");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
  const room = await (await created).json();
  try {
    const history = await (await request.get(`http://127.0.0.1:8451/api/rooms/${room.id}/history`, { headers: auth })).json();
    const state = await (await request.get("http://127.0.0.1:8451/api/state", { headers: auth })).json();
    expect(state.members.find((m: { roomId: string }) => m.roomId === room.id)).toMatchObject({ provider: "codex", model: "chosen-model", config: { effort: "high" } });
    expect(history.turns).toHaveLength(0);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("legacy room teamwork defaults do not add obsolete controls to new chats", async ({ page }) => {
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: { ...defaults, mode: "roundrobin" } }));
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
  await expect(dialog.getByText("Hand-off limit", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Rounds", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radiogroup", { name: "Agent teamwork", exact: true })).toHaveCount(0);
});

test("switching machines reloads defaults and asks before discarding edits", async ({ page, token }) => {
  // A different origin models another machine while its live socket stays on the isolated fixture.
  const remote = "http://127.0.0.1:8451";
  await page.route(`${remote}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") {
      const snap = await (await page.request.get("http://127.0.0.1:8451/api/state", { headers: { authorization: `Bearer ${token}` } })).json();
      snap.hub = { ...snap.hub, id: "h_otherfixture", name: "Other hub" };
      return route.fulfill({ json: snap });
    }
    if (path === "/api/settings/defaults") return route.fulfill({ json: { ...defaults, agent: { codex: { permissionMode: "ask", model: "other-model", effort: null } } } });
    if (path.startsWith("/api/providers/") && path.endsWith("/models")) return route.fulfill({ json: { provider: "codex", live: true, models: [{ id: "other-model", label: "Other machine model", efforts: [], isDefault: true }] } });
    return route.continue();
  });
  const section = await openDefaults(page);
  await page.evaluate(async ({ remote, token }) => {
    const path = "/src/store.ts";
    const { useStore } = await import(path);
    await useStore.getState().addMachine({ baseUrl: remote, token, deviceName: "Other fixture" });
  }, { remote, token });
  await section.getByRole("radio", { name: "Full access", exact: true }).click();
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption(remote);
  await expect(page.getByRole("combobox", { name: "Machine", exact: true })).toHaveValue("");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption(remote);
  await card(page).locator("summary").click();
  await expect(card(page).getByRole("combobox", { name: "Model", exact: true })).toHaveValue("other-model");
  await expect(card(page).getByRole("radio", { name: "Read-only", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.unrouteAll({ behavior: "wait" });
});

// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const codexModels = { provider: "codex", live: true, models: [{ id: "codex-model", label: "GPT Main", isDefault: true, efforts: ["low", "high"] }, { id: "gpt-saved", label: "GPT Saved", efforts: ["low", "high"] }] };

test("a failed defaults read says so, keeps Start chat disabled, and Retry brings back the saved model and effort", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  let socket: import("@playwright/test").WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });
  });
  await page.route("**/api/providers/codex/models*", (route) => route.fulfill({ json: codexModels }));
  await page.route("**/api/settings/defaults", (route) => route.fulfill(fail ? { status: 503, json: { error: "The hub is restarting." } } : { json: { ...defaults, agent: { codex: { permissionMode: "auto", model: "gpt-saved", effort: "high" } } } }));
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  const failed = dialog.getByRole("alert");
  await expect(failed).toContainText(/Couldn't read your Codex defaults from .+\./);
  await expect(failed).toContainText("The hub is restarting.");
  // Nothing is filled in in their place, so a chat can't start on another model by accident.
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toBeDisabled();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("new-chat-defaults-failed.png"), animations: "disabled" });
  fail = false;
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("gpt-saved");
  await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveValue("high");
  await expect(dialog.getByRole("radio", { name: "Can edit & run", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toBeEnabled();

  // The machine drops out and comes back: the dialog reads them again by itself.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  fail = true;
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  await expect(dialog.getByRole("alert")).toContainText("The hub is restarting.");
  fail = false;
  await expect.poll(() => !!socket).toBe(true);
  await socket!.close({ code: 1012, reason: "Browser test restart" });
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("gpt-saved");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("Use Codex's own defaults sends no model", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/providers/codex/models*", (route) => route.fulfill({ json: codexModels }));
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ status: 503, json: { error: "The hub is restarting." } }));
  await page.goto("/#/agent/codex");
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await dialog.getByRole("button", { name: "Use Codex's own defaults", exact: true }).click();
  // Said as what it is: Codex's default model, the main sign-in, asking first.
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("radio", { name: "Read-only", exact: true })).toHaveAttribute("aria-checked", "true");
  const created = page.waitForRequest((r) => r.url().endsWith("/api/chats") && r.method() === "POST");
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
  const body = (await created).postDataJSON();
  const room = await (await answered).json();
  try {
    expect(body).toMatchObject({ provider: "codex", account: "default", model: null, effort: null, helperModel: null, permissionMode: "ask" });
  } finally {
    await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: { authorization: `Bearer ${token}` } });
  }
});

test("the defaults row shows the saved model and effort while closed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/providers/codex/models*", (route) => route.fulfill({ json: codexModels }));
  await page.route("**/api/providers/claude/models*", (route) => route.fulfill({ json: { provider: "claude", live: true, models: [{ id: "claude-opus", label: "Opus 5.5", isDefault: true, efforts: ["low", "high"] }] } }));
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: { ...defaults, agent: { codex: { permissionMode: "ask", model: "gpt-saved", effort: "high" }, claude: { permissionMode: "auto", model: null, effort: null } } } }));
  await page.goto("/#/settings");
  const codex = card(page);
  await expect(codex.locator(".defaults-picks")).toHaveText("GPT Saved · High · Read-only");
  await expect(codex).not.toHaveAttribute("open", "");
  await expect(codex.getByRole("combobox", { name: "Model", exact: true })).toBeHidden();
  // Nothing saved for the model: it says whose default that is, and what it is today.
  await expect(card(page, "Claude Code").locator(".defaults-picks")).toHaveText("Claude Code's default model (Opus 5.5) · Auto");
  await codex.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("defaults-row-closed.png"), animations: "disabled" });
});
