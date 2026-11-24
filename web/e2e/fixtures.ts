import { test as base, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { settingsSection } from "@crosstalk/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HUB = "http://127.0.0.1:8451";

/**
 * What a template is, for telling whether a test left it as it was (when it was saved doesn't count). A starter is known by
 * its key: one a test deleted comes back as a new template, with a new id.
 */
type SavedTemplate = { id: string; starter?: string; name: string; agent: string | null; account: string | null; model: string | null; effort: string | null; folder: string | null; text: string };
const templateKey = (t: SavedTemplate) => (t.starter ? `starter:${t.starter}` : t.id);
const templateWords = (t: SavedTemplate) => JSON.stringify([templateKey(t), t.name, t.agent, t.account, t.model, t.effort, t.folder, t.text]);

/** The parts of the shared test hub a test can add to or change. */
async function hubState(api: APIRequestContext) {
  const get = async (path: string) => {
    const res = await api.get(path);
    if (!res.ok()) throw new Error(`The browser test hub didn't answer ${path}: ${res.status()} ${await res.text()}`);
    return res.json();
  };
  const [state, settings, defaults] = await Promise.all([get("/api/state"), get("/api/settings/hub"), get("/api/settings/defaults")]);
  return {
    rooms: (state.rooms as { id: string }[]).map((r) => r.id).sort(),
    accounts: (state.accounts as { provider: string; id: string }[]).map((a) => `${a.provider}/${a.id}`).sort(),
    settings,
    defaults,
    // In their order (Settings → Templates).
    templates: ((state.templates ?? []) as SavedTemplate[]).map(templateWords),
  };
}

/**
 * Puts the hub's templates back as they were: starters a test deleted come back, the ones it added go, and the rest get
 * their words and places back.
 */
async function restoreTemplates(api: APIRequestContext, before: string[]) {
  const now = async () => ((await (await api.get("/api/templates")).json()) as SavedTemplate[]) ?? [];
  const was = before.map((w) => JSON.parse(w) as unknown[]);
  // The hub adds every missing starter at the end: one that wasn't there before goes again just below.
  const listed = await now();
  if (was.some((w) => String(w[0]).startsWith("starter:") && !listed.some((t) => templateKey(t) === w[0]))) await api.post("/api/templates/starters");
  for (const t of await now()) if (!was.some((w) => w[0] === templateKey(t))) await api.delete(`/api/templates/${t.id}`);
  for (const [i, w] of was.entries()) {
    const [key, name, agent, account, model, effort, folder, text] = w as [string, string, ...(string | null)[]];
    const t = (await now()).find((x) => templateKey(x) === key);
    if (t && templateWords(t) !== JSON.stringify(w)) await api.patch(`/api/templates/${t.id}`, { data: { name, agent, account, model, effort, folder, text } });
    if (t && (await now()).findIndex((x) => templateKey(x) === key) !== i) await api.post(`/api/templates/${t.id}/move`, { data: { to: i } });
  }
}

export const test = base.extend<{ token: string; cleanHub: void }>({
  token: async ({}, use) => {
    await use(JSON.parse(readFileSync(join(tmpdir(), "crosstalk-browser-state-8451.json"), "utf8")).token);
  },
  // Every test shares one hub (e2e/hub.ts): whatever a test leaves there, the next one starts with. A test's own
  // `finally` can't always clean up (after a timeout, Playwright has already closed its `request`), so this does it on
  // its own connection once the page has closed: the rooms, chats and accounts the test added are removed and the
  // settings it changed are put back. One failure can't fail the tests after it.
  cleanHub: [
    async ({ playwright, token }, use) => {
      const api = await playwright.request.newContext({ baseURL: HUB, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
      try {
        const before = await hubState(api);
        await use();
        const after = await hubState(api);
        // Rooms first: an account can't be removed while an agent uses it. A 404 (the test's own cleanup got there) is fine.
        for (const id of after.rooms.filter((id) => !before.rooms.includes(id))) await api.delete(`/api/rooms/${id}`);
        if (JSON.stringify(after.defaults) !== JSON.stringify(before.defaults)) await api.put("/api/settings/defaults", { data: before.defaults });
        if (JSON.stringify(after.settings) !== JSON.stringify(before.settings)) await api.put("/api/settings/hub", { data: before.settings });
        for (const key of after.accounts.filter((key) => !before.accounts.includes(key))) await api.delete(`/api/accounts/${key}`);
        if (JSON.stringify(after.templates) !== JSON.stringify(before.templates)) await restoreTemplates(api, before.templates);
        expect(await hubState(api), "The test hub must be left as the test found it").toEqual(before);
      } finally {
        await api.dispose();
      }
    },
    { auto: true },
  ],
  page: async ({ page, token }, use) => {
    await page.addInitScript((token) => {
      localStorage.setItem("crosstalk.conn.v1", JSON.stringify({ baseUrl: "", token, deviceName: "Browser tests" }));
      // New chat's More options starts open, as on a device where someone opened it once: the specs that set a model,
      // a name or permissions there read as they always did. newChatFold.spec.ts takes this off to see it closed.
      if (!sessionStorage.getItem("ct-test-more-closed")) localStorage.setItem("crosstalk.newchat.more.v1", "1");
    }, token);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(page);
    expect(errors, "The page must not crash").toEqual([]);
  },
});
export { expect };

export async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

/** The five tabs Settings once had, by the page that now holds most of each. */
const OLDER_TABS: Record<string, string> = { Agents: "Accounts", Models: "Your own models", Devices: "This device", Usage: "Usage & costs" };

/**
 * Moves Settings to one of its pages the way taps do (Back to the list, then the page's row), and returns the page's
 * region. `name`: a page's name ("Accounts", "New chats", "Agents together", "Usage & costs", "This device",
 * "Machines", "Your own models"), a section's id ("storage": the page that holds it), or one of the five older tabs'
 * names. `/#/settings/<section>` opens the right page by itself and lands on the section; this is for a test that
 * needs a second page, or one that must not land on a section (the Text size card, whose own buttons move the page).
 */
export async function settingsTab(page: Page, name: string) {
  const label = settingsSection(name)?.page.label ?? OLDER_TABS[name] ?? name;
  const panel = page.locator("#settings-panel");
  await expect(panel).toBeVisible();
  const region = page.getByRole("region", { name: label, exact: true });
  if ((await panel.getAttribute("aria-label")) !== label) {
    if ((await panel.getAttribute("aria-label")) !== "Settings") await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings pages" }).locator(".settings-page-row .title").getByText(label, { exact: true }).click();
  }
  await expect(region).toBeVisible();
  return region;
}

/** Opens More on an account's row (Sign out, its key, its address and models, Refresh models, moving it to another agent). */
export async function moreOf(row: Locator) {
  const more = row.getByRole("button", { name: "More", exact: true });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
}

/** Settings → Accounts → Add an account, then one of its choices by the start of its name ("Sign in to Codex", "An API key for Claude Code"). */
export async function addAccount(page: Page, choice: string) {
  await page.getByRole("button", { name: "Add an account", exact: true }).click();
  await page.getByRole("dialog", { name: "Add an account", exact: true }).getByRole("button", { name: new RegExp(`^${choice}`) }).click();
}

/** Settings → Accounts → Add an account → Another service: the sheet that lists the services to add. */
export async function addAnotherService(page: Page) {
  await page.getByRole("button", { name: "Add an account", exact: true }).click();
  await page.getByRole("dialog", { name: "Add an account", exact: true }).getByRole("button", { name: /^Another service/ }).click();
  const sheet = page.getByRole("dialog", { name: /^Add (another service|a model on this machine)$/ });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Back from a page of Settings to its list of pages. */
export async function settingsList(page: Page) {
  const panel = page.locator("#settings-panel");
  await expect(panel).toBeVisible();
  if ((await panel.getAttribute("aria-label")) !== "Settings") await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Settings pages" })).toBeVisible();
  return page.getByRole("region", { name: "Settings", exact: true });
}

/** Opens a group room's Team & permissions from its top bar, the same way on every screen size. */
export async function openTeam(page: Page) {
  await page.getByRole("button", { name: "Team and permissions", exact: true }).click();
  const team = page.getByRole("dialog", { name: "Team & permissions", exact: true });
  await expect(team).toBeVisible();
  return team;
}

/** The names of a chat settings sheet's sections, as their rows say them. */
export type ChatSection = "Answers with" | "May do" | "Helpers" | "Memory" | "This chat" | "Working together" | "Name and role";

/** Opens a row of the chat settings sheet (a section, or a group chat's agent "@name") unless it's open, and returns its region. */
export async function openFold(scope: Locator, name: string) {
  const region = scope.getByRole("region", { name, exact: true });
  const head = region.locator("> .cs-fold-head");
  await expect(head).toBeVisible();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(region.locator("> .cs-fold-body")).toBeVisible();
  return region;
}

/**
 * Opens a chat's settings sheet from its top bar (if it isn't open yet), on every screen size. With `section`, opens that
 * section and returns its region: in a group chat, inside `agent`'s block ("claude" for @claude). Without, returns the sheet.
 */
export async function chatSettings(page: Page, section?: ChatSection, agent?: string) {
  const sheet = page.getByRole("dialog", { name: "Chat settings", exact: true });
  if (!(await sheet.isVisible())) await page.getByRole("button", { name: "Chat settings", exact: true }).click();
  await expect(sheet).toBeVisible();
  if (!section) return sheet;
  return openFold(agent ? await openFold(sheet, `@${agent}`) : sheet, section);
}

/**
 * Opens a chat's settings sheet with every section open (and, in a group chat, every agent's block and its sections): for
 * a test that goes on to find something in it by name, whichever section holds it.
 */
export async function chatSettingsAll(page: Page) {
  const sheet = await chatSettings(page);
  const closed = sheet.locator('.cs-fold-head[aria-expanded="false"]');
  for (let i = 0; i < 40 && (await closed.count()); i++) await closed.first().click();
  return sheet;
}

/** Closes the chat settings sheet (there's nothing to save: each choice is saved as it's made). */
export async function closeChatSettings(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Chat settings", exact: true });
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

/** The model cards inside `scope` (a section of the sheet, New chat's More options, a card of Settings → New chats). */
export const modelCards = (scope: Locator) => scope.getByRole("group", { name: "Model", exact: true });

/** The model card that's in force inside `scope`. */
export const modelInForce = (scope: Locator) => modelCards(scope).locator('[role="menuitemradio"][aria-checked="true"]');

/** Picks a model by its id, or by the name on its card; one the agent keeps under "More models" is found there. */
export async function pickModel(scope: Locator, model: string | RegExp) {
  const cards = modelCards(scope);
  const byId = typeof model === "string" ? cards.locator(`[role="menuitemradio"][data-value="${model}"]`) : null;
  const byName = cards.getByRole("menuitemradio").filter({ has: scope.page().locator(".pop-item-title", { hasText: model }) });
  const card = () => (byId ? byId.or(byName) : byName).first();
  await expect(cards).toBeVisible();
  if (!(await card().isVisible())) await cards.getByRole("button", { name: /^More models/ }).click();
  await card().click();
}

/** The effort steps inside `scope`; `effortInForce` is the lit one's value ("" is the agent's own default). */
export const effortSteps = (scope: Locator) => scope.getByRole("radiogroup", { name: "Effort", exact: true });
export const effortInForce = (scope: Locator) => effortSteps(scope).locator('[role="radio"][aria-checked="true"]');

/** Picks an effort step by its level ("high"; "" for the agent's default). */
export async function pickEffort(scope: Locator, level: string) {
  await effortSteps(scope).locator(`[role="radio"][data-value="${level}"]`).click();
}

/** The cards that say what the agent may do; `pickPermission` taps one by its mode ("ask", "edits", "auto", "full"). */
export const permissionCards = (scope: Locator) => scope.getByRole("radiogroup", { name: "What it may do", exact: true });
export async function pickPermission(scope: Locator, mode: "ask" | "edits" | "auto" | "full") {
  await permissionCards(scope).locator(`[role="radio"][data-value="${mode}"]`).click();
}

/** Opens a group chat's settings from its top bar with everything in it open (how its agents work together, each agent's block, the chat's own). */
export async function openGroupSettings(page: Page) {
  return chatSettingsAll(page);
}

/** Opens one of a group chat's agents in the chat's settings: its block, with its sections open (Answers with, May do, Helpers, Memory, Name and role). */
export async function openGroupAgent(page: Page, handle: string) {
  return (await chatSettingsAll(page)).getByRole("region", { name: `@${handle}`, exact: true });
}

/**
 * Gives the machine an address other devices can open, as one published with Tailscale has (the test hub has none: it's
 * only at this computer's own address, where the app says a phone can't reach it instead of making a code for one).
 */
export async function reachable(page: Page, address = "https://mini.example.ts.net") {
  await page.evaluate(async (publicUrl) => {
    const { useStore } = await import("/src/store.ts" as string);
    const wait = Date.now() + 5000;
    while (!useStore.getState().hub && Date.now() < wait) await new Promise((r) => setTimeout(r, 50));
    // Kept that way: the hub's own word for it (none) comes again whenever the app reconnects or reloads its state.
    const keep = () => {
      const hub = useStore.getState().hub;
      if (hub && hub.publicUrl !== publicUrl) useStore.setState({ hub: { ...hub, publicUrl } });
    };
    keep();
    useStore.subscribe(keep);
  }, address);
}
