// Settings as one list of pages. The map itself (which page holds which section, the words for where a section is,
// what search finds) lives in shared/src/settingsPages.ts, because the hub names places in Settings with it too
// (settingsPath); this is the web app's door to it, plus what only the app needs: the older addresses, and the
// address a page of Settings has. Pure (no React, no store), so it's unit-tested (settingsTabs.test.ts).
import { pageForSection, SETTINGS_PAGES, type SettingsPageId } from "@crosstalk/shared";

export { pageForSection, searchSettings, SETTINGS_PAGES, settingsPath, settingsPlace, settingsSection, type SettingsHit, type SettingsPage, type SettingsPageId, type SettingsSection } from "@crosstalk/shared";

/**
 * The older addresses for a part of Settings: #/devices, #/setup and #/usage (once a screen of its own). Each one is
 * the page holding that part, worked out from the map, so moving a section can't send #/setup to a page with no
 * checklist on it.
 */
export const PAGE_FOR_VIEW: Record<string, SettingsPageId | undefined> = {
  devices: pageForSection("devices") ?? undefined,
  setup: pageForSection("agent-setup") ?? undefined,
  usage: pageForSection("usage") ?? undefined,
};

/** The section those older addresses land on, inside their page (the others open their page at its top). */
export const SECTION_FOR_VIEW: Record<string, string | undefined> = { setup: "agent-setup" };

/** A page by its id. */
export const settingsPage = (id: SettingsPageId) => SETTINGS_PAGES.find((p) => p.id === id)!;

/** The address of the list of pages, and of one page: what a reload opens again. */
export const settingsAddress = (page: SettingsPageId | null) => (page ? `#/settings/${page}` : "#/settings");

/** The list of pages' own name, for something that asks Settings to show it (`showInSettings`). */
export const SETTINGS_INDEX = "index";

/** The page's heading, so the panel can be named by it. */
export const SETTINGS_PANEL_ID = "settings-panel";
