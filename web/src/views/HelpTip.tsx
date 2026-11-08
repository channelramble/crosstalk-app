import { useId, useState, type ReactNode } from "react";

/**
 * A "?" that opens one plain sentence under it, for anything technical (an API key, a server address, a spending
 * limit). Tap it again to close. The sentence is announced as a note; the tap target is 44 px (see help.css).
 */
export function HelpTip({ children, label = "What's this?" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="help-tip">
      <button type="button" className="help-tip-btn" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      {open && (
        <span id={id} className="help-tip-text" role="note">
          {children}
        </span>
      )}
    </span>
  );
}
