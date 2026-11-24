// Two small sheets Settings asks with, in the app's own Dialog (never the browser's prompt() or confirm(), which a
// phone shows as a system box with the site's address on it): a name to change, and a yes or no.
import { useState, type ReactNode } from "react";
import { Dialog } from "../ui";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Asks for a name. Saving that fails says why and stays open; an unsaved change is asked about before it's dropped. */
export function NameDialog({ title, label, value, help, placeholder, maxLength = 60, saveLabel = "Save", onSave, onClose }: { title: string; label: string; value: string; help?: string; placeholder?: string; maxLength?: number; saveLabel?: string; onSave: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = name.trim() !== value.trim();
  const save = async () => {
    if (busy || !name.trim() || !changed) return;
    setBusy(true);
    setError("");
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setError(`Couldn't save: ${message(e).replace(/[.\s]*$/, "")}. Try again.`);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      dirty={changed && !busy}
      onClose={() => !busy && onClose()}
      footer={(requestClose) => (
        <>
          <button className="btn" disabled={busy} onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !changed} onClick={() => void save()}>
            {busy ? "Saving…" : saveLabel}
          </button>
        </>
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input className="input" aria-label={label} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={maxLength} placeholder={placeholder} disabled={busy} enterKeyHint="done" />
          {help && <span className="help">{help}</span>}
        </label>
      </form>
      {error && (
        <p role="alert" className="small" style={{ color: "var(--red)", marginBottom: 0 }}>
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** A yes or no, with what yes does in `children`. If it fails, the sheet says why and stays open to try again. */
export function ConfirmDialog({ title, children, confirmLabel, workingLabel, danger = true, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; workingLabel?: string; danger?: boolean; onConfirm: () => Promise<unknown> | unknown; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(`${message(e).replace(/[.\s]*$/, "")}. Try again, or tap Cancel.`);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${danger ? "danger" : "primary"}`} disabled={busy} onClick={() => void go()}>
            {busy ? (workingLabel ?? confirmLabel) : confirmLabel}
          </button>
        </>
      }
    >
      <div className="small">{children}</div>
      {error && (
        <p role="alert" className="small" style={{ color: "var(--red)", marginBottom: 0 }}>
          {error}
        </p>
      )}
    </Dialog>
  );
}
