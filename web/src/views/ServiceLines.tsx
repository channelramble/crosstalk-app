import type { Outcome } from "../services";
import { HelpTip } from "./HelpTip";

/**
 * What a check found: its ✓ and ✗ rows, then each problem (every one says its fix). Read out when it changes — which
 * means this stays on the screen with nothing in it (`outcome` null) until a check comes back: a live region put there
 * together with its first words isn't announced at all, so a screen reader would hear nothing of the answer.
 */
export function ServiceLines({ outcome }: { outcome: Outcome | null }) {
  return (
    <div className="svc-result" aria-live="polite">
      {!!outcome && outcome.lines.length > 0 && (
        <ul className="svc-lines">
          {outcome.lines.map((l, i) => (
            <li key={i} className={l.ok ? "ok" : "bad"}>
              <span className="svc-mark" aria-hidden="true">{l.ok ? "✓" : "✗"}</span>
              <span>{l.text}</span>
              {l.adapter && (
                <>
                  <span className="help">through the chat adapter</span>
                  <HelpTip label="What's the chat adapter?">Some services only speak an older style. Crosstalk translates for them on this machine.</HelpTip>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {(outcome?.problems ?? []).map((p, i) => (
        <p key={i} className="svc-problem">{p}</p>
      ))}
    </div>
  );
}
