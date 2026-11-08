// Settings in tabs: which tab holds which section, where an address lands, and the tab this device was last on. Pure
// (no React, no store), so the grouping is unit-tested and the hub's checklist can go on naming sections.

/** A tab's own name is an address too: #/settings/machines. */
export type SettingsTabId = "agents" | "models" | "machines" | "devices" | "usage";

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  /** The sections in it, in the order they're drawn: the element ids deep links and the hub's checklist name. */
  sections: string[];
}

/**
 * The tabs in their order. Agents is first: the sign-ins, what new chats start with and who helps whom are what
 * Settings is opened for most. Then the models on your own machines, the machines themselves, the devices you use
 * Crosstalk from, and what it all costs. Every section of Settings is in exactly one tab (settingsTabs.test.ts).
 */
export const SETTINGS_TABS: SettingsTab[] = [
  { id: "agents", label: "Agents", sections: ["agent-setup", "ai-services", "agent-claude", "agent-codex", "agent-opencode", "templates", "teamwork", "keep-going"] },
  { id: "models", label: "Models", sections: ["memory", "local-models", "image-editor", "model-pool"] },
  { id: "machines", label: "Machines", sections: ["machines", "computers", "this-mac", "storage", "more"] },
  { id: "devices", label: "Devices", sections: ["display", "devices"] },
  { id: "usage", label: "Usage", sections: ["usage", "costs"] },
];

export const FIRST_SETTINGS_TAB = SETTINGS_TABS[0].id;

/** Which tab holds a section (by its element id), or null when that's no section of Settings. */
export function tabForSection(section: string): SettingsTabId | null {
  return SETTINGS_TABS.find((t) => t.sections.includes(section))?.id ?? null;
}

/**
 * Where a name takes you: a section opens its tab and lands on it, a tab's own name just opens that tab. Anything else
 * is nowhere, and Settings stays where it was. Every section id Settings has ever had still works this way, so the hub's
 * checklist, the push notifications and `#/settings/<id>` need no new words.
 */
export function settingsPlace(name: string | null | undefined): { tab: SettingsTabId; section: string | null } | null {
  if (!name) return null;
  const holds = tabForSection(name);
  if (holds) return { tab: holds, section: name };
  const tab = SETTINGS_TABS.find((t) => t.id === name);
  return tab ? { tab: tab.id, section: null } : null;
}

/**
 * The older addresses for a part of Settings: #/devices and #/setup. Each one is the tab holding that part, worked out
 * from the grouping, so re-ordering the tabs can't send #/setup to a tab with no checklist on it.
 */
export const TAB_FOR_VIEW: Record<string, SettingsTabId | undefined> = {
  devices: tabForSection("devices") ?? FIRST_SETTINGS_TAB,
  setup: tabForSection("agent-setup") ?? FIRST_SETTINGS_TAB,
};

/** The tab button's id, so the panel can be named by the tab a reader is on. */
export const settingsTabId = (tab: SettingsTabId) => `settings-tab-${tab}`;
export const SETTINGS_PANEL_ID = "settings-panel";

const TAB_KEY = "crosstalk.settings.tab.v1";

/** The tab this device was last on, for when Settings opens with no section asked for. */
export function lastSettingsTab(): SettingsTabId {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return SETTINGS_TABS.some((t) => t.id === saved) ? (saved as SettingsTabId) : FIRST_SETTINGS_TAB;
  } catch {
    // Storage unavailable: the first tab, as on a device that has never been here.
    return FIRST_SETTINGS_TAB;
  }
}

export function keepSettingsTab(tab: SettingsTabId) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage unavailable: Settings opens at the first tab next time.
  }
}
