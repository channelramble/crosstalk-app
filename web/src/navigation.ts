import { useEffect } from "react";

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
