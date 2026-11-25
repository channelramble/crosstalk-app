// Settings as a list of pages: the map holds every section once, each address (a section's id, a page's, an older
// tab's) lands in the right page, the words for where a section is come from the same map, and search finds pages and
// sections by their titles and a few keywords.
import { expect, test } from "bun:test";
import { PAGE_FOR_VIEW, pageForSection, searchSettings, SECTION_FOR_VIEW, SETTINGS_PAGES, settingsAddress, settingsPath, settingsPlace } from "./settingsTabs";

/** Every section id Settings had when it was five tabs: each must still land. */
const WERE = ["agent-setup", "ai-services", "agent-claude", "agent-codex", "agent-opencode", "templates", "teamwork", "keep-going", "memory", "local-models", "image-editor", "model-pool", "machines", "computers", "this-mac", "storage", "more", "display", "devices", "usage", "costs"];

test("the pages are seven plain names in order, and every section is in exactly one page", () => {
  expect(SETTINGS_PAGES.map((p) => p.label)).toEqual(["Accounts", "New chats", "Agents together", "Usage & costs", "This device", "Machines", "Your own models"]);
  const sections = SETTINGS_PAGES.flatMap((p) => p.sections.map((s) => s.id));
  expect(new Set(sections).size).toBe(sections.length);
  // Nothing from the tabs was dropped: every section they had is in a page.
  for (const was of WERE) expect(pageForSection(was)).not.toBeNull();
  // Each page says what's in it, and has one first part at most.
  for (const p of SETTINGS_PAGES) {
    expect(p.about.length).toBeGreaterThan(10);
    expect(p.sections.filter((s) => s.top).length).toBeLessThanOrEqual(1);
  }
});

test("things that belong together share a page", () => {
  // Who answers: the accounts, and each agent's own line.
  for (const s of ["ai-services", "agent-claude", "agent-codex", "agent-opencode", "own-models", "found-here"]) expect(pageForSection(s)).toBe("accounts");
  // What a new chat starts with.
  for (const s of ["defaults", "templates"]) expect(pageForSection(s)).toBe("new-chats");
  for (const s of ["helpers-on", "teamwork", "other-chats", "keep-going"]) expect(pageForSection(s)).toBe("together");
  for (const s of ["usage", "costs"]) expect(pageForSection(s)).toBe("usage");
  for (const s of ["notifications", "appearance", "display", "devices"]) expect(pageForSection(s)).toBe("device");
  // A machine's own things, the setup checklist among them (under Advanced).
  for (const s of ["machines", "this-mac", "storage", "more", "computers", "screen", "advanced", "agent-setup"]) expect(pageForSection(s)).toBe("machines");
  // Local models' own "Also on this machine" line jumps to the image editor, and the memory card offers to turn off
  // whichever of them is holding the machine, so all three are one tap apart. The model pool was here until 0.8.1:
  // its address still lands on this page.
  for (const s of ["memory", "local-models", "image-editor", "model-pool"]) expect(pageForSection(s)).toBe("models");
  expect(settingsPlace("model-pool")).toEqual({ page: "models", section: null });
});

test("an address names a section, a page or an older tab, and anything else goes nowhere", () => {
  expect(settingsPlace("storage")).toEqual({ page: "machines", section: "storage" });
  expect(settingsPlace("agent-setup")).toEqual({ page: "machines", section: "agent-setup" });
  expect(settingsPlace("agent-codex")).toEqual({ page: "accounts", section: "agent-codex" });
  expect(settingsPlace("costs")).toEqual({ page: "usage", section: "costs" });
  // A page's own name opens it at its top.
  expect(settingsPlace("accounts")).toEqual({ page: "accounts", section: null });
  expect(settingsPlace("new-chats")).toEqual({ page: "new-chats", section: null });
  // The five tabs' names: each lands on the closest page. Three of them are sections too, and land on those.
  expect(settingsPlace("agents")).toEqual({ page: "accounts", section: null });
  expect(settingsPlace("models")).toEqual({ page: "models", section: null });
  expect(settingsPlace("machines")).toEqual({ page: "machines", section: "machines" });
  expect(settingsPlace("devices")).toEqual({ page: "device", section: "devices" });
  expect(settingsPlace("usage")).toEqual({ page: "usage", section: "usage" });
  // A switch that's a fixed default now: its address lands on the page it was on.
  expect(settingsPlace("keep-going")).toEqual({ page: "together", section: null });
  for (const nowhere of ["", null, undefined, "nope", "index"]) expect(settingsPlace(nowhere)).toBeNull();
});

test("the older addresses open the page that holds their part", () => {
  expect(PAGE_FOR_VIEW.devices).toBe("device");
  expect(PAGE_FOR_VIEW.setup).toBe("machines");
  expect(PAGE_FOR_VIEW.usage).toBe("usage");
  expect(SECTION_FOR_VIEW.setup).toBe("agent-setup");
  expect(PAGE_FOR_VIEW.settings).toBeUndefined();
  expect(settingsAddress(null)).toBe("#/settings");
  expect(settingsAddress("accounts")).toBe("#/settings/accounts");
});

test("settingsPath says where a section is, from the same map", () => {
  // A page's own first part is the page.
  expect(settingsPath("ai-services")).toBe("Settings → Accounts");
  expect(settingsPath("defaults")).toBe("Settings → New chats");
  expect(settingsPath("usage")).toBe("Settings → Usage & costs");
  expect(settingsPath("machines")).toBe("Settings → Machines");
  // Any other section is named after its page.
  expect(settingsPath("storage")).toBe("Settings → Machines → Storage");
  expect(settingsPath("this-mac")).toBe("Settings → Machines → This Mac");
  expect(settingsPath("computers")).toBe("Settings → Machines → Remote computers");
  expect(settingsPath("agent-claude")).toBe("Settings → Accounts → Claude Code");
  expect(settingsPath("templates")).toBe("Settings → New chats → Templates");
  expect(settingsPath("teamwork")).toBe("Settings → Agents together → Let agents ask another agent a quick question");
  expect(settingsPath("helpers-on")).toBe("Settings → Agents together → Helpers run on");
  expect(settingsPath("costs")).toBe("Settings → Usage & costs → Costs");
  expect(settingsPath("devices")).toBe("Settings → This device → Paired devices");
  expect(settingsPath("local-models")).toBe("Settings → Your own models → Local models");
  // Something it sits inside is said on the way.
  expect(settingsPath("agent-setup")).toBe("Settings → Machines → Advanced → Set up with an AI agent");
  // A button or a switch on it, by its real label.
  expect(settingsPath("devices", "Pair a new device")).toBe("Settings → This device → Paired devices → Pair a new device");
  expect(settingsPath("ai-services", "Add an account")).toBe("Settings → Accounts → Add an account");
  // A page's id, an older tab's, a gone switch's, and a name nobody knows.
  expect(settingsPath("accounts")).toBe("Settings → Accounts");
  expect(settingsPath("agents")).toBe("Settings → Accounts");
  expect(settingsPath("keep-going")).toBe("Settings → Agents together");
  expect(settingsPath("nope")).toBe("Settings");
  // Every section has words, and no two sections share them (a gone one shares its page's).
  const all = SETTINGS_PAGES.flatMap((p) => p.sections.filter((s) => !s.gone && !s.top).map((s) => settingsPath(s.id)));
  expect(new Set(all).size).toBe(all.length);
});

test("search finds pages and sections by title and keyword, titles first", () => {
  const found = (q: string) => searchSettings(q).map((h) => h.section ?? h.page);
  expect(found("")).toEqual([]);
  expect(found("   ")).toEqual([]);
  // A page by its name, and by a word of what's in its first part.
  expect(found("accounts")[0]).toBe("accounts");
  expect(found("api key")).toContain("accounts");
  expect(found("sign in")[0]).toBe("accounts");
  // A section by the start of a word of its title.
  expect(found("stor")).toEqual(["storage"]);
  expect(found("noti")[0]).toBe("notifications");
  expect(found("text")[0]).toBe("display");
  expect(found("templ")).toEqual(["templates"]);
  // By a keyword: the terminal and the setup commands are under Advanced on the Machines page.
  expect(found("terminal")).toEqual(["advanced"]);
  expect(found("zoom")).toEqual(["display"]);
  // The theme, by its name and by what people call it.
  expect(found("theme")).toEqual(["appearance"]);
  for (const word of ["dark", "light", "background", "picture", "glass", "colour", "color", "appearance", "texture", "metal", "skeuomorphic", "liquid glass"]) expect(found(word)).toContain("appearance");
  expect(found("spending limit")).toEqual(["costs"]);
  expect(found("ssh")).toEqual(["computers"]);
  expect(found("github")).toEqual(["more"]);
  // Each hit says where it is, and nothing is listed twice.
  const hits = searchSettings("model");
  expect(hits.find((h) => h.section === "local-models")?.where).toBe("Your own models");
  expect(new Set(hits.map((h) => `${h.page}/${h.section}`)).size).toBe(hits.length);
  // A switch that's gone isn't offered, nor a section that was taken out.
  expect(found("keep going")).toEqual([]);
  expect(found("model pool")).toEqual([]);
  expect(found("qqqq")).toEqual([]);
});
