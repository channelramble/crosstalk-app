// Settings as one list of pages: which page holds which section, the words for where a section is ("Settings →
// Machines → Storage"), and where a name (a section's id, a page's, an older tab's) lands. Pure, and shared: the web
// app draws Settings from it, and the hub names places in Settings with the same words (settingsPath), so a message
// can't send someone to a place that has moved.

export type SettingsPageId = "accounts" | "new-chats" | "together" | "usage" | "device" | "machines" | "models";

export interface SettingsSection {
  /** The element id deep links, push notifications and the hub's checklist name. */
  id: string;
  /** Its heading, as the page shows it and a path says it. */
  title: string;
  /** The page's own first part: a path stops at the page ("Settings → Accounts"). */
  top?: boolean;
  /** Something it sits inside on its page ("Advanced"): the path says it on the way. */
  under?: string;
  /** No longer drawn (its control is a fixed default now, or it was taken out): its address lands on the page, and search leaves it out. */
  gone?: boolean;
  /** More words search finds it by. */
  keywords?: string[];
}

export interface SettingsPage {
  id: SettingsPageId;
  label: string;
  /** One line under its name in the list, when the app has nothing live to say there. */
  about: string;
  /** In the order they're drawn. */
  sections: SettingsSection[];
}

/**
 * The pages in their order. Every section of Settings is in exactly one page (web/src/settingsTabs.test.ts).
 */
export const SETTINGS_PAGES: SettingsPage[] = [
  {
    id: "accounts",
    label: "Accounts",
    about: "Plans, API keys, your own models",
    sections: [
      { id: "ai-services", title: "Accounts", top: true, keywords: ["sign in", "sign out", "plan", "api key", "key", "add an account", "subscription", "login", "rename", "remove", "test"] },
      { id: "agent-claude", title: "Claude Code", keywords: ["anthropic", "claude", "max", "pro", "install", "update"] },
      { id: "agent-codex", title: "Codex", keywords: ["openai", "chatgpt", "install", "update"] },
      { id: "agent-opencode", title: "Other services", keywords: ["opencode", "kimi", "deepseek", "openrouter", "nanogpt", "service", "install", "update"] },
      { id: "own-models", title: "Your own models", keywords: ["a model running on this machine", "local", "server", "ollama", "lm studio", "llama.cpp"] },
      { id: "found-here", title: "Found on this machine", keywords: ["ollama", "lm studio", "llama.cpp", "rescan", "use it"] },
    ],
  },
  {
    id: "new-chats",
    label: "New chats",
    about: "The model, effort and permissions a new chat starts with",
    sections: [
      { id: "defaults", title: "What a new chat starts with", top: true, keywords: ["default", "model", "effort", "permissions", "asks first", "account"] },
      { id: "templates", title: "Templates", keywords: ["folder", "saved", "starter"] },
    ],
  },
  {
    id: "together",
    label: "Agents together",
    about: "Who does helper work, quick questions, reaching your other chats",
    sections: [
      { id: "helpers-on", title: "Helpers run on", keywords: ["helper", "helpers", "subagent", "api key", "another account", "plan limits", "who does helper work"] },
      { id: "teamwork", title: "Let agents ask another agent a quick question", keywords: ["teamwork", "ask the other agent", "second opinion", "question"] },
      { id: "other-chats", title: "Let agents reach your other chats", keywords: ["across chats", "read", "message", "linked machines"] },
      { id: "keep-going", title: "Keep going while helpers work", gone: true },
    ],
  },
  {
    id: "usage",
    label: "Usage & costs",
    about: "Plan limits, what each account cost, spending limits",
    sections: [
      { id: "usage", title: "Plan limits", top: true, keywords: ["usage", "meter", "limit", "resets", "weekly", "5-hour", "carry on when the limit resets"] },
      { id: "costs", title: "Costs", keywords: ["spending limit", "budget", "money", "price", "month", "bill"] },
    ],
  },
  {
    id: "device",
    label: "This device",
    about: "Notifications, theme, text size, paired devices",
    sections: [
      { id: "notifications", title: "Notifications", keywords: ["push", "alerts", "add to home screen"] },
      { id: "appearance", title: "Theme", keywords: ["appearance", "look", "colour", "color", "dark", "light", "oled", "background", "picture", "wallpaper", "gradient", "glass", "see-through", "blur", "accent", "your own", "texture", "flat", "metal", "brushed", "skeuomorphic", "liquid glass"] },
      { id: "display", title: "Text size", keywords: ["zoom", "bigger", "smaller", "font", "page size", "display"] },
      { id: "devices", title: "Paired devices", keywords: ["pair a new device", "phone", "qr", "code", "sign out"] },
    ],
  },
  {
    id: "machines",
    label: "Machines",
    about: "The computers that run Crosstalk",
    sections: [
      { id: "machines", title: "Machines", top: true, keywords: ["name", "rename", "link", "linux", "add a machine", "address"] },
      { id: "updates", title: "Updates", keywords: ["update", "new version", "upgrade", "what's new", "check now", "release", "download"] },
      { id: "this-mac", title: "This Mac", keywords: ["automatic login", "keep it on", "sleep", "permissions", "restart", "privacy"] },
      { id: "storage", title: "Storage", keywords: ["disk", "space", "free", "clean up", "caches", "full"] },
      { id: "more", title: "GitHub", keywords: ["git", "push", "private repos", "gh"] },
      { id: "computers", title: "Remote computers", keywords: ["ssh", "computers agents can use", "server"] },
      { id: "screen", title: "Screen", keywords: ["see the screen", "control", "screen sharing", "remote desktop"] },
      { id: "advanced", title: "Advanced", keywords: ["terminal", "shell", "version", "data folder", "update"] },
      { id: "agent-setup", title: "Set up with an AI agent", under: "Advanced", keywords: ["setup", "checklist", "what's left", "do it by hand", "let claude code finish setup", "tailscale", "https"] },
    ],
  },
  {
    id: "models",
    label: "Your own models",
    about: "Models that run on your machines, and the image editor",
    sections: [
      { id: "memory", title: "Memory guard", keywords: ["ram", "memory", "full", "tight"] },
      { id: "local-models", title: "Local models", keywords: ["download", "get a model", "gguf", "ollama", "lm studio", "llama.cpp", "hugging face"] },
      { id: "image-editor", title: "Image editor", keywords: ["comfyui", "qwen", "pictures", "images"] },
      { id: "model-pool", title: "Model pool", gone: true },
    ],
  },
];

/** The ids Settings' five tabs had before it became a list of pages, each landing on the closest page. */
const OLDER_TABS: Record<string, SettingsPageId> = { agents: "accounts" };

const pageById = (id: string) => SETTINGS_PAGES.find((p) => p.id === id);

/** Which page holds a section (by its element id), or null when that's no section of Settings. */
export function pageForSection(section: string): SettingsPageId | null {
  return SETTINGS_PAGES.find((p) => p.sections.some((s) => s.id === section))?.id ?? null;
}

/** A section by its id, with its page. */
export function settingsSection(id: string): { page: SettingsPage; section: SettingsSection } | null {
  for (const page of SETTINGS_PAGES) {
    const section = page.sections.find((s) => s.id === id);
    if (section) return { page, section };
  }
  return null;
}

/**
 * Where a name takes you: a section opens its page and lands on it, a page's own name just opens that page, and so
 * does an older tab's ("agents"). A section whose control is gone lands on its page. Anything else is nowhere, and
 * Settings stays where it was. Every section id Settings has ever had still works this way, so the hub's checklist,
 * the push notifications and `#/settings/<id>` need no new words.
 */
export function settingsPlace(name: string | null | undefined): { page: SettingsPageId; section: string | null } | null {
  if (!name) return null;
  const held = settingsSection(name);
  if (held) return { page: held.page.id, section: held.section.gone ? null : held.section.id };
  const page = pageById(name)?.id ?? OLDER_TABS[name];
  return page ? { page, section: null } : null;
}

/**
 * The words for where something in Settings is, for any sentence that sends a person there: a section's id gives
 * "Settings → Machines → Storage" (or just "Settings → Accounts" for a page's own first part), a page's id gives
 * "Settings → Usage & costs". `then` names something on it, a button or a switch by its real label ("Settings →
 * This device → Paired devices → Pair a new device"). A name nobody knows is just "Settings".
 */
export function settingsPath(name: string, ...then: string[]): string {
  const held = settingsSection(name);
  const page = held?.page ?? pageById(name) ?? pageById(OLDER_TABS[name] ?? "");
  const words = ["Settings"];
  if (page) words.push(page.label);
  if (held && !held.section.top && !held.section.gone) {
    if (held.section.under) words.push(held.section.under);
    words.push(held.section.title);
  }
  return [...words, ...then].join(" → ");
}

/** One thing search found: a page, or a section of one. */
export interface SettingsHit {
  page: SettingsPageId;
  /** Null: the page itself. */
  section: string | null;
  title: string;
  /** Where it is, under the title: the page's name for a section, what's in it for a page. */
  where: string;
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * What "Search settings" finds: pages and sections whose title or keywords hold every word typed (a word matches the
 * start of any word in them, so "noti" finds Notifications and "key" finds API key). Titles that match come before
 * keyword-only matches; within each, the pages' own order.
 */
export function searchSettings(query: string): SettingsHit[] {
  const words = fold(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  const holds = (text: string) => {
    const have = fold(text).split(" ");
    return words.every((w) => have.some((h) => h.startsWith(w)));
  };
  const titled: SettingsHit[] = [];
  const keyed: SettingsHit[] = [];
  for (const page of SETTINGS_PAGES) {
    if (holds(page.label)) titled.push({ page: page.id, section: null, title: page.label, where: page.about });
    for (const s of page.sections) {
      if (s.gone) continue;
      // A page's own first part is the page: found by its keywords, shown as the page (once).
      const hit: SettingsHit = s.top ? { page: page.id, section: null, title: page.label, where: page.about } : { page: page.id, section: s.id, title: s.title, where: page.label };
      const seen = (list: SettingsHit[]) => list.some((h) => h.page === hit.page && h.section === hit.section);
      if (seen(titled) || seen(keyed)) continue;
      if (!s.top && holds(s.title)) titled.push(hit);
      else if (holds([s.title, s.under ?? "", ...(s.keywords ?? [])].join(" "))) keyed.push(hit);
    }
  }
  return [...titled, ...keyed];
}
