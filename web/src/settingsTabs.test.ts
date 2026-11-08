// Settings in tabs: the grouping holds every section once, each address lands in the right tab, and the tab this
// device was last on comes back.
import { afterEach, expect, test } from "bun:test";
import { FIRST_SETTINGS_TAB, keepSettingsTab, lastSettingsTab, SETTINGS_TABS, settingsPlace, settingsTabId, TAB_FOR_VIEW, tabForSection } from "./settingsTabs";

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
afterEach(() => {
  for (const [key, desc] of originals) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

/** A stand-in for this device's storage; `broken` is a browser that refuses it (private browsing). */
function storage(broken = false) {
  const kept = new Map<string, string>();
  replace("localStorage", {
    getItem: (k: string) => {
      if (broken) throw new Error("no storage");
      return kept.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("no storage");
      kept.set(k, v);
    },
  });
  return kept;
}

test("the tabs are a few plain names, the agents first, and hold every section exactly once", () => {
  expect(SETTINGS_TABS.map((t) => t.label)).toEqual(["Agents", "Models", "Machines", "Devices", "Usage"]);
  expect(FIRST_SETTINGS_TAB).toBe("agents");
  const sections = SETTINGS_TABS.flatMap((t) => t.sections);
  expect(new Set(sections).size).toBe(sections.length);
  // Nothing from the one long page was dropped: every section it had is in a tab.
  for (const was of [
    "agent-setup",
    "display",
    "templates",
    "image-editor",
    "devices",
    "machines",
    "computers",
    "this-mac",
    "model-pool",
    "ai-services",
    "agent-claude",
    "agent-codex",
    "agent-opencode",
    "local-models",
    "teamwork",
    "storage",
    "usage",
    "costs",
    "more",
  ])
    expect(tabForSection(was)).not.toBeNull();
  // A tab's name never doubles as another tab's section.
  for (const t of SETTINGS_TABS) expect(tabForSection(t.id) ?? t.id).toBe(t.id);
});

test("things that belong together share a tab", () => {
  // The sign-ins, what new chats start with, and who helps whom.
  for (const s of ["ai-services", "agent-claude", "agent-codex", "agent-opencode", "templates", "teamwork", "keep-going"]) expect(tabForSection(s)).toBe("agents");
  // Local models' own "Also on this machine" lines jump to the image editor and the model pool, and the memory card
  // offers to turn off whichever of them is holding the machine, so all four are one tap apart.
  for (const s of ["memory", "local-models", "image-editor", "model-pool"]) expect(tabForSection(s)).toBe("models");
  // The computers Crosstalk runs on, and what's on their disks.
  for (const s of ["machines", "computers", "this-mac", "storage"]) expect(tabForSection(s)).toBe("machines");
  // This device's own size, and the devices paired with the hub.
  for (const s of ["display", "devices"]) expect(tabForSection(s)).toBe("devices");
  for (const s of ["usage", "costs"]) expect(tabForSection(s)).toBe("usage");
});

test("an address names a section or a tab, and anything else goes nowhere", () => {
  // The sections the hub's checklist points at (hub/src/setup/checklist.ts screen/target) all land.
  expect(settingsPlace("devices")).toEqual({ tab: "devices", section: "devices" });
  expect(settingsPlace("this-mac")).toEqual({ tab: "machines", section: "this-mac" });
  expect(settingsPlace("machines")).toEqual({ tab: "machines", section: "machines" });
  expect(settingsPlace("model-pool")).toEqual({ tab: "models", section: "model-pool" });
  expect(settingsPlace("ai-services")).toEqual({ tab: "agents", section: "ai-services" });
  expect(settingsPlace("agent-claude")).toEqual({ tab: "agents", section: "agent-claude" });
  expect(settingsPlace("agent-codex")).toEqual({ tab: "agents", section: "agent-codex" });
  // Where New chat sends you when OpenCode isn't installed.
  expect(settingsPlace("agent-opencode")).toEqual({ tab: "agents", section: "agent-opencode" });
  // "Keep going while helpers work", beside Teamwork.
  expect(settingsPlace("keep-going")).toEqual({ tab: "agents", section: "keep-going" });
  expect(settingsPlace("storage")).toEqual({ tab: "machines", section: "storage" });
  // The ones the app itself asks for.
  expect(settingsPlace("costs")).toEqual({ tab: "usage", section: "costs" });
  expect(settingsPlace("agent-setup")).toEqual({ tab: "agents", section: "agent-setup" });
  expect(settingsPlace("image-editor")).toEqual({ tab: "models", section: "image-editor" });
  // A tab's own name opens it, with nothing to land on.
  expect(settingsPlace("agents")).toEqual({ tab: "agents", section: null });
  expect(settingsPlace("models")).toEqual({ tab: "models", section: null });
  expect(settingsPlace("made-up")).toBeNull();
  expect(settingsPlace(null)).toBeNull();
  expect(settingsPlace("")).toBeNull();
});

test("the older addresses #/devices and #/setup open the tab holding what they name", () => {
  // Worked out from the grouping, not written down: re-ordering the tabs can't send #/setup to a tab with no checklist.
  expect(TAB_FOR_VIEW.devices).toBe(tabForSection("devices"));
  expect(TAB_FOR_VIEW.setup).toBe(tabForSection("agent-setup"));
  // #/settings itself names no tab: it opens the one this device was last on.
  expect(TAB_FOR_VIEW.settings).toBeUndefined();
  expect(TAB_FOR_VIEW.rooms).toBeUndefined();
});

test("the tab this device was last on comes back, and a device with no storage opens at the first", () => {
  const kept = storage();
  expect(lastSettingsTab()).toBe("agents");
  keepSettingsTab("machines");
  expect([...kept.keys()]).toEqual(["crosstalk.settings.tab.v1"]);
  expect(lastSettingsTab()).toBe("machines");
  // A tab that no longer exists (an older app's) is no reason to show nothing.
  kept.set("crosstalk.settings.tab.v1", "whatever");
  expect(lastSettingsTab()).toBe("agents");
  storage(true);
  expect(lastSettingsTab()).toBe("agents");
  expect(() => keepSettingsTab("usage")).not.toThrow();
});

test("each tab names the panel, so a screen reader says which settings it is", () => {
  expect(SETTINGS_TABS.map((t) => settingsTabId(t.id))).toEqual(["settings-tab-agents", "settings-tab-models", "settings-tab-machines", "settings-tab-devices", "settings-tab-usage"]);
});
