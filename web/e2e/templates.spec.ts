import type { APIRequestContext, Locator, Page, Request, Route } from "@playwright/test";
import type { Member, PromptTemplate, Room, TemplateInput } from "@crosstalk/shared";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { otherMachine } from "./otherMachine";

// Prompt templates (hub templates.ts; web views/TemplatesSection.tsx, views/TemplatePick.tsx, templates.ts). Settings →
// Templates changes the shared test hub's own templates (the cleanHub fixture puts them back). New chat makes its chat for
// real, but the chat's first message never reaches an agent: the test answers it in the hub's place. Phone flows run in the
// 320 and 390 projects at their width, the rest once each at 390.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const project = () => test.info().project.name;
const onPhones = () => test.skip(!/-(320|390)$/.test(project()), "Phone widths: the 320 and 390 projects.");
const once = () => test.skip(!/-390$/.test(project()), "Once per browser, at 390.");
const phone = async (page: Page) => page.setViewportSize({ width: page.viewportSize()!.width, height: 844 });
/** The app's own hub socket, held by the test when a second machine is played (see pins.spec.ts). */
const holdHubSocket = (page: Page) => page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", (ws) => void ws.connectToServer());
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// New chat's Machine and Folder menus are named by their label with its help line after it ("Folder An empty folder in …").

const headers = (token: string) => ({ authorization: `Bearer ${token}` });
async function savedTemplates(request: APIRequestContext, token: string): Promise<PromptTemplate[]> {
  return (await request.get(`${HUB}/api/templates`, { headers: headers(token) })).json();
}
/** A template made as another device would make it: first in the list. */
async function addTemplate(request: APIRequestContext, token: string, input: TemplateInput): Promise<PromptTemplate> {
  const res = await request.post(`${HUB}/api/templates`, { headers: headers(token), data: input });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as PromptTemplate[])[0];
}
/** What the test hub's machine is called in the app (its hub's name). */
async function homeName(request: APIRequestContext, token: string): Promise<string> {
  const { hub } = await (await request.get(`${HUB}/api/state`, { headers: headers(token) })).json();
  return hub.name || String(hub.hostname).replace(/\.local$/, "");
}

/** The Templates section of the Settings already on screen. */
async function templatesHere(page: Page) {
  const section = page.getByRole("region", { name: "Templates", exact: true });
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  return section;
}

/** Settings, at its Templates section. */
async function templatesSection(page: Page) {
  await page.goto("/#/settings/templates");
  return templatesHere(page);
}
const rowNames = (section: Locator) => section.locator(".tpl-name").allTextContents();
const rowOf = (section: Locator, name: string) => section.locator(".tpl-item").filter({ has: section.page().locator(".tpl-name", { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
const trayOf = (row: Locator, name: string) => row.getByRole("group", { name: `Options for ${name}`, exact: true });
async function openTray(row: Locator, name: string) {
  await row.getByRole("button", { name: `Options for ${name}`, exact: true }).click();
  const tray = trayOf(row, name);
  await expect(tray).toBeVisible();
  return tray;
}

/** New chat, opened from an agent's page. */
async function newChat(page: Page, agent: "claude" | "codex") {
  await page.goto(`/#/agent/${agent}`);
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: `New chat with ${agent === "claude" ? "Claude Code" : "Codex"}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The first messages the app sends to new chats, answered here: they never reach the hub, so no agent ever starts. */
async function answerFirstMessages(page: Page, pattern = "**/api/rooms/*/messages") {
  const sent: { url: string; roomId: string; body: { text: string } }[] = [];
  await page.route(pattern, async (route: Route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    const roomId = decodeURIComponent(/\/api\/rooms\/([^/]+)\/messages/.exec(req.url())![1]);
    const body = req.postDataJSON() as { text: string };
    sent.push({ url: req.url(), roomId, body });
    const at = Date.now();
    await route.fulfill({
      headers: { "access-control-allow-origin": "http://127.0.0.1:5198" },
      json: { id: `m_${at}`, roomId, authorKind: "human", memberId: null, authorName: "Browser tests", text: body.text, mentions: [], turnId: null, status: "done", createdAt: at, updatedAt: at, via: null },
    });
  });
  return sent;
}

test("Settings → Templates: one is added with blanks, an agent and a folder, then renamed, moved, edited and deleted (asked twice)", async ({ page, request, token }) => {
  onPhones();
  await phone(page);
  const width = page.viewportSize()!.width;
  const tag = Math.random().toString(36).slice(2, 6);
  const name = `Release notes ${tag}`;
  const renamed = `Notes ${tag}`;
  const folder = join(tmpdir(), `ct-tpl-${tag}`);
  const start = (await savedTemplates(request, token)).map((t) => t.name);
  // The hub's starters (deleted ones are put back by the fixture after any test).
  expect(start).toEqual(expect.arrayContaining(["Fix a bug", "Plan it first", "Review my changes"]));

  const section = await templatesSection(page);
  await expect.poll(() => rowNames(section)).toEqual(start);
  await expect(section).toContainText("Put a few words in {curly brackets} for a blank you fill in each time.");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot(`templates-list-${width}.png`), animations: "disabled" });

  // Added: a name, a first message with two blanks, Codex on a model and effort, and a folder.
  await section.getByRole("button", { name: "Add a template", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New template", exact: true });
  await expect(editor).toBeVisible();
  const save = editor.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await editor.getByRole("textbox", { name: "First message", exact: true }).fill("Write the release notes for {version}.\nKeep them short for {who}.");
  await expect(editor).toContainText("Blanks you fill in each time: version, who.");
  await expect(save).toBeEnabled();
  // Any agent leaves the model to New chat; one agent offers its models, with yours as the default.
  await expect(editor.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await editor.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  const model = editor.getByRole("combobox", { name: "Model", exact: true });
  await expect(model.locator("option").first()).toHaveText("Your default");
  await model.selectOption("codex-model");
  await editor.getByRole("combobox", { name: "Effort", exact: true }).selectOption("high");
  await editor.getByRole("textbox", { name: "Folder path", exact: true }).fill(folder);
  await noHorizontalOverflow(page);
  expect(await editor.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ ...shot(`templates-editor-${width}.png`), animations: "disabled" });
  await save.click();
  await expect(editor).toHaveCount(0);
  // First in the list, saying what it sets; and on the hub as it was given.
  await expect.poll(() => rowNames(section)).toEqual([name, ...start]);
  await expect(rowOf(section, name)).toContainText(`Codex · codex-model · High · in ct-tpl-${tag}`);
  expect((await savedTemplates(request, token))[0]).toMatchObject({ name, agent: "codex", account: null, model: "codex-model", effort: "high", folder, text: "Write the release notes for {version}.\nKeep them short for {who}." });

  // Renamed from its options (finger-sized, as the app's buttons are on a phone), with Enter.
  let tray = await openTray(rowOf(section, name), name);
  await expect(tray).toContainText(`1 of ${start.length + 1}`);
  await expect(tray.getByRole("button", { name: "Move up", exact: true })).toHaveCount(0);
  for (const button of await tray.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot(`templates-tray-${width}.png`), animations: "disabled" });
  await tray.getByRole("button", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename template", exact: true });
  const field = rename.getByRole("textbox", { name: "Name", exact: true });
  await expect(field).toHaveValue(name);
  await field.fill(renamed);
  await field.press("Enter");
  await expect(rename).toHaveCount(0);
  await expect.poll(() => rowNames(section)).toEqual([renamed, ...start]);
  // Focus is back on the row it was renamed from (its tray went when the dialog opened).
  await expect(rowOf(section, renamed).getByRole("button", { name: `Options for ${renamed}`, exact: true })).toBeFocused();

  // Moved down and back up: the tray stays open where the row goes, on the button that's still there.
  const row = rowOf(section, renamed);
  tray = await openTray(row, renamed);
  await tray.getByRole("button", { name: "Move down", exact: true }).click();
  await expect.poll(() => rowNames(section)).toEqual([start[0], renamed, ...start.slice(1)]);
  await expect(trayOf(row, renamed)).toContainText(`2 of ${start.length + 1}`);
  await expect(trayOf(row, renamed).getByRole("button", { name: "Move down", exact: true })).toBeFocused();
  await trayOf(row, renamed).getByRole("button", { name: "Move up", exact: true }).click();
  await expect.poll(() => rowNames(section)).toEqual([renamed, ...start]);
  await expect(trayOf(row, renamed).getByRole("button", { name: "Move down", exact: true })).toBeFocused();
  expect((await savedTemplates(request, token)).map((t) => t.name)).toEqual([renamed, ...start]);
  // Escape closes it, back on its ⋯.
  await page.keyboard.press("Escape");
  await expect(trayOf(row, renamed)).toHaveCount(0);
  await expect(row.getByRole("button", { name: `Options for ${renamed}`, exact: true })).toBeFocused();

  // Edited: what it was saved with, then Any agent and a new folder. Leaving with changes asks first.
  await row.getByRole("button", { name: `Edit ${renamed}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit template", exact: true });
  await expect(edit.getByRole("combobox", { name: "Agent", exact: true })).toHaveValue("codex");
  await expect(edit.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("codex-model");
  await expect(edit.getByRole("combobox", { name: "Effort", exact: true })).toHaveValue("high");
  await expect(edit.getByRole("textbox", { name: "Folder path", exact: true })).toHaveValue(folder);
  await edit.getByRole("combobox", { name: "Agent", exact: true }).selectOption("");
  await expect(edit.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await edit.getByRole("radio", { name: "A new folder", exact: true }).click();
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(edit.getByText("Discard changes?", { exact: true })).toBeVisible();
  await edit.getByRole("button", { name: "Keep editing", exact: true }).click();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText("Any agent");
  expect((await savedTemplates(request, token))[0]).toMatchObject({ name: renamed, agent: null, model: null, effort: null, folder: null });

  // Deleted only once both questions are answered: Cancel at either one keeps it, with focus back on its row.
  const options = (of: string) => rowOf(section, of).getByRole("button", { name: `Options for ${of}`, exact: true });
  const askDelete = async () => {
    await (await openTray(row, renamed)).getByRole("button", { name: "Delete", exact: true }).click();
    const first = page.getByRole("dialog", { name: `Delete "${renamed}"?`, exact: true });
    await expect(first).toContainText("It's removed from every device. Chats you started from it stay.");
    return first;
  };
  await (await askDelete()).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(options(renamed)).toBeFocused();
  await (await askDelete()).getByRole("button", { name: "Continue", exact: true }).click();
  const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
  await expect(sure).toContainText("This can't be undone.");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot(`templates-delete-${width}.png`), animations: "disabled" });
  await sure.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(rowOf(section, renamed)).toHaveCount(1);
  await expect(options(renamed)).toBeFocused();
  expect((await savedTemplates(request, token)).map((t) => t.name)).toContain(renamed);
  await (await askDelete()).getByRole("button", { name: "Continue", exact: true }).click();
  await sure.getByRole("button", { name: "Yes, delete", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => rowNames(section)).toEqual(start);
  expect((await savedTemplates(request, token)).map((t) => t.name)).toEqual(start);
  // On the row that took its place.
  await expect(options(start[0])).toBeFocused();

  // After a reload, as the hub keeps them.
  // A reload keeps #/settings, so the section is looked for where it is: navigating again here would cut off the
  // requests the app just started, and WebKit counts those as the page crashing.
  await page.reload();
  const again = await templatesHere(page);
  await expect.poll(() => rowNames(again)).toEqual(start);
});

test("New chat from a template: its agent, model, effort and folder are filled in, its blanks asked for, and its first message sent", async ({ page, request, token }) => {
  onPhones();
  await phone(page);
  const width = page.viewportSize()!.width;
  const tag = Math.random().toString(36).slice(2, 6);
  const folder = join(tmpdir(), `ct-tpl-chat-${tag}`);
  const template = await addTemplate(request, token, { name: `Fix it ${tag}`, agent: "codex", model: "codex-model", effort: "low", folder, text: "Fix {what goes wrong} in {where}. Tell me how you checked it." });
  const sent = await answerFirstMessages(page);
  try {
    // Opened for Claude Code: the template's agent takes over.
    let dialog = await newChat(page, "claude");
    const menu = dialog.getByRole("combobox", { name: "From a template", exact: true });
    await expect(menu).toHaveValue("");
    await expect(dialog.getByRole("group", { name: "Fill in the blanks", exact: true })).toHaveCount(0);
    await menu.selectOption({ label: template.name });
    dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
    await expect(dialog).toBeVisible();
    const blanks = dialog.getByRole("group", { name: "Fill in the blanks", exact: true });
    await expect(blanks.getByRole("textbox")).toHaveCount(2);
    const start = dialog.getByRole("button", { name: "Start chat", exact: true });
    await expect(start).toBeDisabled();
    await expect(blanks).toContainText("Fill in each one to start the chat.");
    await expect(dialog.getByRole("textbox", { name: "First message", exact: true })).toHaveValue(template.text);
    // Its model, effort and folder, on your defaults.
    await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("codex-model");
    await expect(dialog.getByRole("combobox", { name: "Effort", exact: true })).toHaveValue("low");
    // Picked in the list of folders, with nothing typed.
    await expect(dialog.getByRole("radio", { name: `${folder.split("/").pop()}, ${folder}`, exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("textbox", { name: "Folder path", exact: true })).toHaveValue("");
    await blanks.getByRole("textbox", { name: "What goes wrong", exact: true }).fill("the login page");
    await expect(start).toBeDisabled();
    await blanks.getByRole("textbox", { name: "Where", exact: true }).fill("  the header ");
    await expect(start).toBeEnabled();
    await expect(blanks).not.toContainText("Fill in each one");
    await noHorizontalOverflow(page);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ ...shot(`new-chat-template-${width}.png`), animations: "disabled" });

    const created = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
    await start.click();
    const res = await created;
    const room = (await res.json()) as Room;
    expect(res.request().postDataJSON()).toMatchObject({ provider: "codex", account: "default", model: "codex-model", effort: "low", cwd: folder });
    // The chat opens, and its first message went to it, with the blanks filled in.
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ roomId: room.id, body: { text: "Fix the login page in the header. Tell me how you checked it." } });
    // As the hub keeps the chat: Codex, on the template's model and effort, in its folder.
    const state = await (await request.get(`${HUB}/api/state`, { headers: headers(token) })).json();
    expect((state.rooms as Room[]).find((r) => r.id === room.id)).toMatchObject({ cwd: folder, chat: { provider: "codex" } });
    expect((state.members as Member[]).find((m) => m.roomId === room.id)).toMatchObject({ provider: "codex", model: "codex-model", config: { effort: "low" } });
    await noHorizontalOverflow(page);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a template without blanks starts as it is; None takes a template off; a filled-in blank isn't lost to a stray tap", async ({ page, request, token }) => {
  once();
  await phone(page);
  const folder = join(tmpdir(), `ct-tpl-pick-${Math.random().toString(36).slice(2, 6)}`);
  const withFolder = await addTemplate(request, token, { name: `In a folder ${Date.now()}`, folder, text: "Tidy up this folder." });
  const dialog = await newChat(page, "codex");
  const menu = dialog.getByRole("combobox", { name: "From a template", exact: true });
  const newFolder = dialog.getByRole("radio", { name: "A new folder", exact: true });
  // A template's folder is picked with it, and goes again with a template that has none; one picked by hand stays.
  const goesAtOnce = "The first message goes at once. If it's about a project, pick that project's folder.";
  await menu.selectOption({ label: withFolder.name });
  // Picked in the list of folders, even one the machine doesn't list itself.
  await expect(dialog.getByRole("radio", { name: `${folder.split("/").pop()}, ${folder}`, exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(dialog).not.toContainText(goesAtOnce);
  await menu.selectOption({ label: "Fix a bug" });
  await expect(newFolder).toHaveAttribute("aria-checked", "true");
  // In a new folder, it says the message goes at once (a project's work would find an empty folder).
  await expect(dialog).toContainText(goesAtOnce);
  await dialog.getByRole("textbox", { name: "Folder path", exact: true }).fill("/tmp/mine");
  await menu.selectOption({ label: "Plan it first" });
  await expect(dialog.getByRole("textbox", { name: "Folder path", exact: true })).toHaveValue("/tmp/mine");
  await newFolder.click();
  // No blanks: nothing to fill in, and it can start at once.
  await menu.selectOption({ label: "Review my changes" });
  await expect(dialog.getByRole("group", { name: "Fill in the blanks", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "First message", exact: true })).toHaveValue(/^Review the changes in this folder/);
  await expect(dialog).toContainText("Sent when the chat starts. Leave it empty to write your own.");
  await expect(dialog.getByRole("button", { name: "Start chat", exact: true })).toBeEnabled();

  // One blank, filled in: closing asks first.
  await menu.selectOption({ label: "Plan it first" });
  const blanks = dialog.getByRole("group", { name: "Fill in the blanks", exact: true });
  await blanks.getByRole("textbox", { name: "What you want to build or change", exact: true }).fill("add a dark mode");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByText("Discard changes?", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(blanks.getByRole("textbox", { name: "What you want to build or change", exact: true })).toHaveValue("add a dark mode");
  // A template picked again starts from its own words.
  await menu.selectOption({ label: "Fix a bug" });
  await expect(blanks.getByRole("textbox")).toHaveCount(2);
  for (const box of await blanks.getByRole("textbox").all()) await expect(box).toHaveValue("");

  // None: its blanks and first message go, and Cancel just closes (nothing to lose).
  await menu.selectOption("");
  await expect(blanks).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "First message", exact: true })).toHaveCount(0);
  await expect(dialog).not.toContainText(goesAtOnce);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Started from one without blanks: its first message goes word for word.
  const review = (await savedTemplates(request, token)).find((t) => t.starter === "review")!;
  const sent = await answerFirstMessages(page);
  await page.getByRole("button", { name: "New chat", exact: true }).last().click();
  const again = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  await again.getByRole("combobox", { name: "From a template", exact: true }).selectOption({ label: review.name });
  const created = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
  await again.getByRole("button", { name: "Start chat", exact: true }).click();
  const room = (await (await created).json()) as Room;
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ roomId: room.id, body: { text: review.text } });
  await expect(again).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
});

test("a template added or deleted on another device shows up here at once", async ({ page, request, token }) => {
  once();
  await phone(page);
  const section = await templatesSection(page);
  const before = (await savedTemplates(request, token)).map((t) => t.name);
  await expect.poll(() => rowNames(section)).toEqual(before);
  const made = await addTemplate(request, token, { name: `From the Mac ${Math.random().toString(36).slice(2, 6)}`, text: "Hello {name}." });
  await expect.poll(() => rowNames(section)).toEqual([made.name, ...before]);
  await expect(rowOf(section, made.name)).toContainText("Any agent");
  expect((await request.delete(`${HUB}/api/templates/${made.id}`, { headers: headers(token) })).ok()).toBe(true);
  await expect.poll(() => rowNames(section)).toEqual(before);
});

test("with several machines, New chat lists each one's templates under its name, and one from the other machine starts there", async ({ page, request, token }) => {
  once();
  await phone(page);
  const home = await homeName(request, token);
  const at = Date.now();
  const deploy: PromptTemplate = { id: "tp_linux", name: "Deploy the site", agent: "codex", account: null, model: "gpt-linux", effort: null, folder: "/home/me/site", text: "Deploy {branch} to the server.", createdAt: at, updatedAt: at };
  const rooms: Room[] = [];
  const members: Member[] = [];
  const linux = await otherMachine(page, token, { port: 8471, rooms, members, templates: [deploy] });
  await holdHubSocket(page);
  const cors = { "access-control-allow-origin": "http://127.0.0.1:5198" };
  const made: Request[] = [];
  // Linux box's side of New chat (its defaults, the chat), as its hub would answer.
  await page.route(`${linux.base}/api/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/settings/defaults" && req.method() === "GET") return route.fulfill({ headers: cors, json: { mode: "direct", agents: [], maxHops: 0, rounds: 1, parallel: false, agent: {} } });
    if (path === "/api/chats" && req.method() === "POST") {
      made.push(req);
      const room = { id: "r_linux_tpl", name: "New chat", cwd: "/home/me/site", mode: "direct", leadMemberId: "mb_linux_tpl", maxHops: 0, rounds: 1, parallel: false, createdAt: Date.now(), updatedAt: Date.now(), archived: false, chat: { provider: "codex", origin: "web" } } as Room;
      const member = { id: "mb_linux_tpl", roomId: room.id, handle: "codex", provider: "codex", model: "gpt-linux", role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: Date.now(), position: 0 } as Member;
      rooms.push(room);
      members.push(member);
      linux.send({ t: "room", room });
      linux.send({ t: "member", member });
      return route.fulfill({ headers: cors, json: room });
    }
    return route.fallback();
  });
  const sent = await answerFirstMessages(page, `${linux.base}/api/rooms/*/messages`);
  // Nothing of it goes to the machine this page came from.
  const here: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).origin === "http://127.0.0.1:5198" && /^\/api\/(chats|rooms\/[^/]+\/messages)$/.test(new URL(r.url()).pathname)) here.push(r.url());
  });

  // Settings says whose templates it shows: this machine's, then Linux box's once it's picked.
  let section = await templatesSection(page);
  await expect(section).toContainText(`These are on ${home}: each machine keeps its own.`);
  await page.locator(".topbar").getByRole("combobox", { name: "Machine", exact: true }).selectOption(linux.base);
  section = page.getByRole("region", { name: "Templates", exact: true });
  await expect(section).toContainText("These are on Linux box: each machine keeps its own.");
  await expect.poll(() => rowNames(section)).toEqual(["Deploy the site"]);
  await expect(rowOf(section, "Deploy the site")).toContainText("Codex · gpt-linux · in site");
  await page.locator(".topbar").getByRole("combobox", { name: "Machine", exact: true }).selectOption("");

  // New chat lists each machine's under its name; Linux box's starts on Linux box, in its folder.
  const dialog = await newChat(page, "codex");
  const menu = dialog.getByRole("combobox", { name: "From a template", exact: true });
  await expect.poll(() => menu.locator("optgroup").evaluateAll((groups) => groups.map((g) => (g as HTMLOptGroupElement).label))).toEqual([home, "Linux box"]);
  await expect(menu.locator('optgroup[label="Linux box"] option')).toHaveText(["Deploy the site"]);
  await menu.selectOption({ label: "Deploy the site" });
  const machine = dialog.getByRole("combobox", { name: /^Machine\b/ });
  await expect(machine).toHaveValue(linux.base);
  await expect(dialog).toContainText("Codex · gpt-linux · in site · from Linux box");
  await expect(dialog.getByRole("radio", { name: "site, /home/me/site", exact: true })).toHaveAttribute("aria-checked", "true");
  // Moved to this machine, Linux box's model and folder aren't used (they're Linux box's), and it says so.
  const elsewhere = "Its model and folder are for Linux box, so yours are used here.";
  await machine.selectOption("");
  await expect(dialog).toContainText(elsewhere);
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("radio", { name: "A new folder", exact: true })).toHaveAttribute("aria-checked", "true");
  // Back on Linux box: all of it again.
  await machine.selectOption(linux.base);
  await expect(dialog).not.toContainText(elsewhere);
  await expect(dialog.getByRole("radio", { name: "site, /home/me/site", exact: true })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("group", { name: "Fill in the blanks", exact: true }).getByRole("textbox", { name: "Branch", exact: true }).fill("main");
  await noHorizontalOverflow(page);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ ...shot("new-chat-template-machines-390.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(made).toHaveLength(1);
  expect(made[0].postDataJSON()).toMatchObject({ provider: "codex", account: "default", model: "gpt-linux", cwd: "/home/me/site" });
  expect(sent[0]).toMatchObject({ roomId: "r_linux_tpl", body: { text: "Deploy main to the server." } });
  expect(here).toEqual([]);
  await expect(dialog).toHaveCount(0);
});

test("a machine from before templates: its Settings says to update it, and New chat lists only the others' templates", async ({ page, request, token }) => {
  once();
  await phone(page);
  const home = await homeName(request, token);
  const linux = await otherMachine(page, token, { port: 8472 });
  await holdHubSocket(page);
  await templatesSection(page);
  await page.locator(".topbar").getByRole("combobox", { name: "Machine", exact: true }).selectOption(linux.base);
  const section = page.getByRole("region", { name: "Templates", exact: true });
  await expect(section).toContainText("Update Crosstalk on Linux box to keep templates there.");
  await expect(section.getByRole("button", { name: "Check again", exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Add a template", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("templates-older-machine-390.png"), animations: "disabled" });
  const dialog = await newChat(page, "codex");
  const menu = dialog.getByRole("combobox", { name: "From a template", exact: true });
  await expect.poll(() => menu.locator("optgroup").evaluateAll((groups) => groups.map((g) => (g as HTMLOptGroupElement).label))).toEqual([home]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("an agent's template sets New chat's agent; None, or a template for any agent, gives back the one it was opened for", async ({ page, request, token }) => {
  once();
  await phone(page);
  const codex = await addTemplate(request, token, { name: `Codex only ${Math.random().toString(36).slice(2, 6)}`, agent: "codex", text: "Look at the tests." });
  const opened = await newChat(page, "claude");
  const asCodex = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
  const menu = page.getByRole("dialog").getByRole("combobox", { name: "From a template", exact: true });
  await menu.selectOption({ label: codex.name });
  await expect(asCodex).toBeVisible();
  // "Any agent" is the one New chat was opened for.
  await menu.selectOption({ label: "Fix a bug" });
  await expect(opened).toBeVisible();
  await menu.selectOption({ label: codex.name });
  await expect(asCodex).toBeVisible();
  await menu.selectOption("");
  await expect(opened).toBeVisible();
  // Your Claude Code defaults are back with it.
  await expect(opened.getByRole("combobox", { name: "Model", exact: true }).locator("option").first()).toHaveText(/claude model/);
  await opened.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an edit saves only what it changed, and one whose account was removed is saved on Main", async ({ page, request, token }) => {
  once();
  await phone(page);
  const auth = headers(token);
  const tag = Math.random().toString(36).slice(2, 6);
  const account = (await (await request.post(`${HUB}/api/accounts`, { headers: auth, data: { provider: "codex", label: `Work ${tag}` } })).json()) as { id: string };
  const made = await addTemplate(request, token, { name: `On work ${tag}`, agent: "codex", account: account.id, model: "codex-model", effort: "high", text: "Check {thing}." });
  expect(made).toMatchObject({ account: account.id });
  // The account is removed (Settings → AI services): the template keeps it, but it can't be used.
  expect((await request.delete(`${HUB}/api/accounts/codex/${account.id}`, { headers: auth })).ok()).toBe(true);
  const section = await templatesSection(page);
  await rowOf(section, made.name).getByRole("button", { name: `Edit ${made.name}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit template", exact: true });
  await expect(edit).toContainText("The account it had isn't on this machine anymore, so it's set to Main.");
  await expect(edit.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("codex-model");
  // Nothing changed by hand: closing doesn't ask.
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(edit).toHaveCount(0);

  // Renamed on another device while it's open here; this one changes its message.
  await rowOf(section, made.name).getByRole("button", { name: `Edit ${made.name}`, exact: true }).click();
  const renamed = `Work check ${tag}`;
  expect((await request.patch(`${HUB}/api/templates/${made.id}`, { headers: auth, data: { name: renamed } })).ok()).toBe(true);
  await expect(rowOf(section, renamed)).toHaveCount(1);
  await edit.getByRole("textbox", { name: "First message", exact: true }).fill("Check {thing} twice.");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toHaveCount(0);
  // Its message and Main are saved, and the other device's name stays.
  expect((await savedTemplates(request, token)).find((t) => t.id === made.id)).toMatchObject({ name: renamed, agent: "codex", account: null, model: "codex-model", effort: "high", text: "Check {thing} twice." });
  await expect(rowOf(section, renamed)).toHaveCount(1);
});

test("starters deleted elsewhere can be added back from Settings, with a finger-sized link on a phone", async ({ page, request, token }) => {
  onPhones();
  await phone(page);
  const list = await savedTemplates(request, token);
  const starter = (key: string) => list.find((t) => t.starter === key)!;
  const section = await templatesSection(page);
  await expect.poll(() => rowNames(section)).toEqual(list.map((t) => t.name));
  for (const key of ["bug", "review"]) expect((await request.delete(`${HUB}/api/templates/${starter(key).id}`, { headers: headers(token) })).ok()).toBe(true);
  const back = section.getByRole("button", { name: "Add the deleted starter templates back", exact: true });
  await expect(back).toBeVisible();
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);
  await back.click();
  // Back at the end, each once.
  const kept = list.filter((t) => t.starter !== "bug" && t.starter !== "review").map((t) => t.name);
  await expect.poll(() => rowNames(section)).toEqual([...kept, starter("bug").name, starter("review").name]);
  await expect(back).toHaveCount(0);
  // One deleted again and left so: the test hub gets it back after the test (fixtures.ts), in its place.
  const plan = (await savedTemplates(request, token)).find((t) => t.starter === "plan")!;
  expect((await request.delete(`${HUB}/api/templates/${plan.id}`, { headers: headers(token) })).ok()).toBe(true);
  await expect(section.getByRole("button", { name: "Add the deleted starter template back", exact: true })).toBeVisible();
});
