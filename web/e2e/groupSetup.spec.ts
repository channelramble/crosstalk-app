import type { Locator, Page } from "@playwright/test";
import type { AgentAccount, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow, openGroupSettings } from "./fixtures";

// Setting a group chat up as a newcomer would: "Add an agent" lists every account that can answer, one tap each; one
// choice says how they work together, in a person's words; who leads, the review rounds and working at the same time
// are behind "More", whose line says what they are. No agent is ever sent a message here (the test hub's Claude Code and
// Codex would be the real CLIs): the chat is made, opened and looked at.

const HUB = "http://127.0.0.1:8451";
const QWEN = "qwen3.8-9b";

/** CT_SHOTS: a folder to save the screens in (the 390 and 1440 px Chromium projects only), to look at them. */
const shot = async (target: Page | Locator, name: string) => {
  const project = test.info().project.name;
  const width = project === "chromium-390" ? "390" : project === "chromium-1440" ? "1440" : null;
  if (process.env.CT_SHOTS && width) await target.screenshot({ path: `${process.env.CT_SHOTS}/group-${name}-${width}.png`, animations: "disabled" });
};

/** At least a thumb's height (44 px). */
async function tall(target: Locator) {
  const box = await target.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

test("a new group chat: any account joins in one tap, one choice of how they work together, the rest behind More", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const endpoint = async (provider: string, label: string, baseUrl: string): Promise<AgentAccount> =>
    (await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider, label, baseUrl, apiKey: "", models: [QWEN], contextWindow: 16384 } })).json();
  // A model of your own that Codex runs, and one that only Crosstalk's own agent runs (nothing answers at either address).
  const mine = await endpoint("codex", "Qwen here", "http://127.0.0.1:8099");
  const solo = await endpoint("builtin", "Solo service", "http://127.0.0.1:8098");
  let room: Room | null = null;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Start a group chat", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New group chat", exact: true });
    await expect(dialog).toBeVisible();
    const agents = dialog.getByRole("list", { name: "Agents in the chat", exact: true });
    await expect(agents.getByRole("button", { name: /^Codex: @codex · / })).toBeVisible();
    await expect(agents.getByRole("listitem")).toHaveCount(2);

    // One choice, three ways, in plain words; nothing else about it until "More" is opened.
    const how = dialog.getByRole("radiogroup", { name: "How they work together", exact: true });
    await expect(how.getByRole("radio")).toHaveText([/^One leads, the others help when asked/, /^Everyone answers in turn/, /^One builds, another reviews/]);
    await expect(how.getByRole("radio", { name: /^One leads/ })).toHaveAttribute("aria-checked", "true");
    const more = dialog.getByRole("button", { name: /^More/ });
    await expect(more).toHaveText("More@claude leads");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(dialog.getByRole("combobox", { name: "Lead", exact: true })).toHaveCount(0);
    await tall(more);
    await shot(dialog, "new");

    // Add an agent: every account that can answer, the agents' own first, then your own models.
    const add = dialog.getByRole("button", { name: "Add an agent", exact: true });
    await add.click();
    const rows = dialog.getByRole("list", { name: "Add which agent?", exact: true });
    await expect(rows.getByRole("button")).toHaveText([/^Claude CodeYour plan · /, /^CodexYour plan · /, new RegExp(`^Qwen here${QWEN} · on this machine · with Codex$`)]);
    for (const row of await rows.getByRole("button").all()) await tall(row);
    // The service only Crosstalk's own agent runs can't join, and one quiet line says so.
    await expect(dialog.locator(".group-left-out")).toHaveText("Solo service can't join a group chat: its agent works in a chat of its own. To use it here, add it for Claude Code or Codex in Settings → Accounts.");
    await noHorizontalOverflow(page);
    await shot(dialog, "new-add");
    // The button again puts the list away; a pick does too.
    await add.click();
    await expect(rows).toHaveCount(0);
    await add.click();
    await rows.getByRole("button", { name: /^Add Qwen here/ }).click();
    await expect(rows).toHaveCount(0);
    await expect(agents.getByRole("listitem")).toHaveCount(3);
    const third = agents.getByRole("button", { name: new RegExp(`^Qwen here: @qwen-here · ${QWEN} · with Codex\\.`) });
    await expect(third).toBeVisible();
    // Its settings still fold open: the model, permissions and its name in the chat.
    await third.click();
    await expect(agents.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
    await agents.getByRole("textbox", { name: "Name in the chat", exact: true }).fill("builder");
    // Its line follows the name it was given.
    await agents.getByRole("button", { name: /^Qwen here: @builder · / }).click();
    await expect(agents.getByRole("textbox", { name: "Name in the chat", exact: true })).toHaveCount(0);

    // One builds, another reviews can be picked from the start; "More" says the rounds it will take.
    await how.getByRole("radio", { name: /^One builds, another reviews/ }).click();
    await expect(more).toHaveText("More@claude leads · up to 3 review rounds");
    await more.click();
    await dialog.getByRole("combobox", { name: "Lead", exact: true }).selectOption("2");
    await expect(agents.getByRole("listitem").nth(2)).toContainText("Lead");
    await dialog.getByRole("button", { name: "Increase review rounds", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Let agents work at the same time", exact: true }).check();
    await expect(more).toHaveText("More@builder leads · up to 4 review rounds · may work at the same time");
    await noHorizontalOverflow(page);
    await shot(dialog, "new-more");

    const started = page.waitForResponse((res) => res.url().endsWith("/api/chats/group") && res.request().method() === "POST");
    await dialog.getByRole("button", { name: "Start group chat", exact: true }).click();
    const response = await started;
    const body = response.request().postDataJSON();
    expect(body).toMatchObject({ answers: "review", lead: 2, rounds: 4, parallel: true });
    expect(body.members).toHaveLength(3);
    expect(body.members[2]).toMatchObject({ provider: "codex", account: mine.id, model: QWEN, handle: "builder" });
    room = (await response.json()) as Room;
    expect(room).toMatchObject({ mode: "review", maxHops: 7, parallel: true });

    // The chat says who builds and who reviews, above the message box.
    await expect(page.locator(".group-answers")).toHaveText("@builder builds it, then @claude reviews it.");
    // Its settings have the same choice and the same "More".
    const settings = await openGroupSettings(page);
    await expect(settings.getByRole("radio", { name: /^One builds, another reviews/ })).toHaveAttribute("aria-checked", "true");
    const settingsMore = settings.getByRole("region", { name: "Working together", exact: true }).getByRole("button", { name: /^More/ });
    await expect(settingsMore).toHaveText("More@builder leads · up to 4 review rounds · may work at the same time");
    await shot(settings, "settings");
    await settingsMore.click();
    await expect(settings.getByRole("combobox", { name: "Lead", exact: true })).toHaveValue(room.leadMemberId!);
    await expect(settings.getByRole("group", { name: "review rounds", exact: true })).toContainText("4 rounds");
    await expect(settings.getByRole("checkbox", { name: "Let agents work at the same time", exact: true })).toBeChecked();
    // Everything else a group chat's settings had is still there.
    for (const name of ["Add an agent", "Duplicate chat…", "Delete chat"]) await expect(settings.getByRole("button", { name, exact: true })).toBeVisible();
    for (const name of ["Other chats' agents can read this chat", "Pinned"]) await expect(settings.getByRole("checkbox", { name, exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(settings, "settings-more");
    // Nothing to save: each choice is saved as it's made.
    await expect(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  } finally {
    if (room) await request.delete(`${HUB}/api/rooms/${room.id}`, { headers });
    await request.delete(`${HUB}/api/accounts/codex/${mine.id}`, { headers });
    await request.delete(`${HUB}/api/accounts/builtin/${solo.id}`, { headers });
  }
});

test("without changing anything behind More, a new group chat starts with what Settings says", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  let room: Room | null = null;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Start a group chat", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New group chat", exact: true });
    await expect(dialog.getByRole("list", { name: "Agents in the chat", exact: true }).getByRole("button", { name: /^Codex: @codex · / })).toBeVisible();
    await dialog.getByRole("radio", { name: /^Everyone answers in turn/ }).click();
    const started = page.waitForResponse((res) => res.url().endsWith("/api/chats/group") && res.request().method() === "POST");
    await dialog.getByRole("button", { name: "Start group chat", exact: true }).click();
    const response = await started;
    const body = response.request().postDataJSON();
    // Neither the rounds nor working at the same time is sent: the machine's own defaults apply.
    expect(body).toMatchObject({ answers: "turns", lead: 0 });
    expect(body).not.toHaveProperty("rounds");
    expect(body).not.toHaveProperty("parallel");
    room = (await response.json()) as Room;
    await expect(page.locator(".group-answers")).toHaveText("Everyone answers, in turn: @claude, then @codex.");
  } finally {
    if (room) await request.delete(`${HUB}/api/rooms/${room.id}`, { headers });
  }
});
