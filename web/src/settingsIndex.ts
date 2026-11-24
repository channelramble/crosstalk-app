// The one line under each page's name in Settings' list: its state when the app knows it ("2 signed in · 1 not signed
// in", "Weekly limit 43% used"), else what's in the page. Pure, for the unit tests; views/SettingsIndex.tsx draws it.
import { CHAT_PROVIDERS, isServiceOnlyAgent, type AccountSpend, type AgentAccount, type HubSettings, type ImageEditorStatus, type StorageStatus, type UsageSnapshot } from "@crosstalk/shared";
import { costLabel } from "./money";
import { SETTINGS_PAGES, type SettingsPageId } from "./settingsTabs";

export interface IndexFacts {
  accounts: Record<string, AgentAccount>;
  usage: Record<string, UsageSnapshot>;
  spend: readonly AccountSpend[] | null;
  /** The machine's settings; null until read. */
  settings: Pick<HubSettings, "teamwork" | "agentsAcrossChats"> | null;
  templates: number | null;
  /** The machines this device shows, by name. */
  machines: string[];
  storage: StorageStatus | null;
  imageEditor: Pick<ImageEditorStatus, "installed" | "state"> | null;
  /** Notifications on this device: null when not known (or this browser has none). */
  notifications: boolean | null;
  /** The text size chosen on this device, in percent. */
  zoom: number;
}

const GB = 1024 ** 3;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The accounts Settings → Accounts lists: Claude Code's and Codex's, and the services the other agents run on. */
const listed = (accounts: Record<string, AgentAccount>) => Object.values(accounts).filter((a) => (CHAT_PROVIDERS as readonly string[]).includes(a.provider) || (isServiceOnlyAgent(a.provider) && a.kind === "endpoint"));

export function pageLine(page: SettingsPageId, f: IndexFacts): string {
  const about = SETTINGS_PAGES.find((p) => p.id === page)!.about;
  switch (page) {
    case "accounts": {
      const all = listed(f.accounts);
      // An account of your own models or a service has a key, not a sign-in: it counts as working unless its key was refused.
      const out = all.filter((a) => a.signedIn === false).length;
      const working = all.filter((a) => a.signedIn === true || (a.kind === "endpoint" && a.signedIn !== false)).length;
      if (!working && !out) return about;
      return [working ? `${working} working` : "", out ? `${out} not signed in` : ""].filter(Boolean).join(" · ");
    }
    case "new-chats":
      return f.templates ? `${about} · ${count(f.templates, "template", "templates")}` : about;
    case "together":
      return f.settings ? `Quick questions ${f.settings.teamwork.enabled ? "on" : "off"} · Reaching other chats ${f.settings.agentsAcrossChats ? "on" : "off"}` : about;
    case "usage": {
      // The fullest plan limit, and what this month cost so far.
      let top: { label: string; pct: number } | null = null;
      for (const u of Object.values(f.usage)) for (const w of u.windows) if (w.usedPercent !== null && (!top || w.usedPercent > top.pct)) top = { label: w.label, pct: w.usedPercent };
      const month = (f.spend ?? []).filter((s) => s.kind !== "signin").reduce((n, s) => n + s.month.usd, 0);
      const words = [top ? `${top.label} ${Math.round(top.pct)}% used` : "", month > 0 ? `${costLabel(month, "exact")} this month` : ""].filter(Boolean);
      return words.length ? words.join(" · ") : about;
    }
    case "device": {
      const words = [f.notifications === null ? "" : `Notifications ${f.notifications ? "on" : "off"}`, `Text size ${f.zoom}%`].filter(Boolean);
      return words.join(" · ");
    }
    case "machines": {
      const names = f.machines.length > 2 ? `${f.machines.length} machines` : f.machines.join(" and ");
      const free = f.storage ? `${Math.round(f.storage.free / GB)} GB free` : "";
      return [names, free].filter(Boolean).join(" · ") || about;
    }
    case "models": {
      const editor = f.imageEditor?.installed ? `Image editor ${f.imageEditor.state === "off" ? "off" : f.imageEditor.state === "ready" ? "on" : f.imageEditor.state === "error" ? "has a problem" : "starting"}` : "";
      return editor || about;
    }
  }
}
