import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
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
    await page.addInitScript((token) => localStorage.setItem("crosstalk.conn.v1", JSON.stringify({ baseUrl: "", token, deviceName: "Browser tests" })), token);
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

/**
 * Moves Settings to one of its tabs (Agents, Models, Machines, Devices, Usage) the way a tap does, and returns its
 * panel. `/#/settings/<section>` opens the right tab by itself; this is for a test that needs a second tab, or one that
 * must not land on a section (the Display card, whose own buttons move the page).
 */
export async function settingsTab(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("tabpanel", { name, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

/** Opens a group room's Team & permissions from its top bar, the same way on every screen size. */
export async function openTeam(page: Page) {
  await page.getByRole("button", { name: "Team and permissions", exact: true }).click();
  const team = page.getByRole("dialog", { name: "Team & permissions", exact: true });
  await expect(team).toBeVisible();
  return team;
}

/** Opens a group chat's settings from its top bar (its agents are listed there, each with Change), on every screen size. */
export async function openGroupSettings(page: Page) {
  await page.getByRole("button", { name: "Chat settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Group chat settings", exact: true });
  await expect(settings).toBeVisible();
  return settings;
}

/** Opens one of a group chat's agents in its own dialog (account, permissions, name, model, effort, role). */
export async function openGroupAgent(page: Page, handle: string) {
  const settings = await openGroupSettings(page);
  await settings.getByRole("button", { name: `Change @${handle}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `@${handle}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
