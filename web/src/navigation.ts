import { useEffect } from "react";
import { PAGE_FOR_VIEW, SETTINGS_INDEX, settingsAddress, settingsPlace, type SettingsPageId } from "./settingsTabs";

const guards = new Set<() => boolean>();

/** Screen-level editors must get the same protection as dialog editors. */
export function canNavigate(): boolean {
  return [...guards].every((guard) => guard());
}

export function useNavigationGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const guard = () => window.confirm("Discard your unsaved defaults? Choose Cancel to keep editing.");
    const unloading = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    guards.add(guard);
    window.addEventListener("beforeunload", unloading);
    return () => {
      guards.delete(guard);
      window.removeEventListener("beforeunload", unloading);
    };
  }, [dirty]);
}

/**
 * Where Settings scrolls when it next opens, once: an element's id (an agent's card, say). Switching machines opens
 * Settings anew, so a button that switches and then shows something there sets this first.
 */
let settingsTarget: string | null = null;
const watchers = new Set<(id: string) => void>();
export function showInSettings(id: string) {
  settingsTarget = id;
  // Settings already on screen takes it now: nothing opens it again, so nothing else would.
  for (const watch of [...watchers]) watch(id);
}
export function takeSettingsTarget(): string | null {
  const id = settingsTarget;
  settingsTarget = null;
  return id;
}
/** Which section Settings opens at, without taking it: the tab it starts on is that section's. */
export function peekSettingsTarget(): string | null {
  return settingsTarget;
}
/** Settings, while it's on screen, hears a section asked for and moves to its tab. Returns how to stop listening. */
export function watchSettingsTarget(watch: (id: string) => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/**
 * The page Settings is on (null: its list of pages), kept while Settings is replaced for another machine (App keys it
 * by machine, so opening another machine on the Machines page comes back to Machines) and let go once Settings is left.
 */
let keptSettingsPage: SettingsPageId | null = null;
export function keepSettingsPage(page: SettingsPageId | null) {
  keptSettingsPage = page;
}

/** Where Settings opens: the page of the section asked for, else the address's, else where it was a moment ago, else its list of pages. */
export function settingsStartPage(view: string): SettingsPageId | null {
  if (settingsTarget === SETTINGS_INDEX) return null;
  return settingsPlace(settingsTarget)?.page ?? PAGE_FOR_VIEW[view] ?? keptSettingsPage;
}

/** Settings' place in the history (back.ts): the page it's on, or is about to open on. Each page is a place, over the list. */
export const settingsPlaceNow = () => settingsAddress(settingsStartPage("settings"));

/** The place an address inside Settings names: `id` is a page, a section (its page), or nothing (the list). */
export const settingsPlaceFor = (id: string | undefined) => settingsAddress((id && settingsPlace(id)?.page) || null);
