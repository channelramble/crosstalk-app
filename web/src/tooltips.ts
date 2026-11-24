// On a computer, a button that is only an icon says what it is when the mouse rests on it. Most have a tooltip of
// their own; one that doesn't gets its name (its aria-label) as its tooltip the first time the mouse comes over it,
// kept up to date if the name changes. Buttons with words on them, and touch screens, are left alone.

const NAMED = "button[aria-label], a[aria-label], [role=button][aria-label]";

/** Gives `el` its name as its tooltip, if it's an icon with no tooltip of its own (or one this gave it earlier). */
export function nameAsTooltip(el: Element) {
  const name = el.getAttribute("aria-label");
  if (!name) return;
  const ours = el.getAttribute("data-tip") === "name";
  if (el.hasAttribute("title") && !ours) return;
  // Words on the button already say it.
  if ((el.textContent ?? "").trim()) {
    if (ours) {
      el.removeAttribute("title");
      el.removeAttribute("data-tip");
    }
    return;
  }
  if (el.getAttribute("title") !== name) el.setAttribute("title", name);
  if (!ours) el.setAttribute("data-tip", "name");
}

/** Starts it, where there's a mouse to hover with. */
export function initTooltips() {
  if (typeof window === "undefined" || !window.matchMedia?.("(hover: hover)").matches) return;
  document.addEventListener(
    "mouseover",
    (e) => {
      const el = (e.target as Element | null)?.closest?.(NAMED);
      if (el) nameAsTooltip(el);
    },
    { passive: true },
  );
}
