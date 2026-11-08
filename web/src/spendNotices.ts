import { showInSettings, takeSettingsTarget } from "./navigation";
import { newNotices } from "./spend";
import { useStore } from "./store";
import { loadSpend } from "./useSpend";

/** Goes to Settings → Costs: scrolls there when Settings is open already, else opens it on that section. */
export function openCosts() {
  const { view, setView } = useStore.getState();
  const there = document.getElementById("costs");
  if (there && ["settings", "setup", "devices"].includes(view)) {
    there.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  showInSettings("costs");
  setView("settings");
  // Refused (an editor with unsaved changes asked, and was kept): don't leave the target for the next time Settings opens.
  if (useStore.getState().view !== "settings") takeSettingsTarget();
}

let watching = false;

/**
 * Tells you when an account passes 80% of its limit, or reaches it, while the app is open: a notice with Raise limit
 * (see newNotices for when). The hub also sends a push at 80%, for when the app isn't open. Started once, from main.tsx.
 */
export function watchSpend() {
  if (watching) return;
  watching = true;
  let asked: string | null = null;
  useStore.subscribe((s, prev) => {
    // A first look once a machine is connected, so the figures that come after have something to be compared with.
    if (s.status === "open" && s.spend === null && asked !== s.active) {
      asked = s.active;
      // An older hub has no costs: nothing to watch there.
      loadSpend().catch(() => {});
    }
    if (!s.spend || s.spend === prev.spend || s.active !== prev.active) return;
    for (const n of newNotices(prev.spend, s.spend)) s.toast(n.level, n.text, { action: { label: "Raise limit", run: openCosts } });
  });
}
