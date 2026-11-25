import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { PERMISSION_MODES, permissionInfo, type AgentAccount, type ModelOption, type PermissionMode, type Provider } from "@crosstalk/shared";
import { effortHint, effortName, effortWord } from "../chatSettings";
import { ModelChoices } from "./ModelChoices";

/*
 * The building blocks a chat's agent is set up with: which account, which model, how hard it thinks, what it may do.
 * The chat settings sheet, New chat's More options and Settings → New chats all draw these, so a choice looks and
 * reads the same wherever it's made. Each takes the choice and gives it back; what's done with it (saved at once in a
 * chat, kept for Save or Start chat in a form) is the caller's.
 */

/** Up and Down (Left and Right, Home and End) move between the choices of a list; Enter or Space picks, as a tap does. */
export function arrowFocus(e: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
  if (!keys.includes(e.key) || (e.target as HTMLElement).tagName === "INPUT") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'));
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
  items[to]?.focus();
}

/** A small heading over one group of choices ("Model", "Effort"). */
export const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="cs-part">
    <div className="cs-part-title">{title}</div>
    {children}
  </div>
);

export interface CardOption<T extends string> {
  id: T;
  title: string;
  /** One sentence about what it's for. */
  help?: string;
  badges?: string[];
  danger?: boolean;
  disabled?: boolean;
}

/** Big choices, one per line: a name, a sentence about it, and a check on the one in force. */
export function RadioCards<T extends string>({ label, value, options, onChange, disabled = false }: { label: string; value: T | null; options: CardOption<T>[]; onChange: (v: T) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="cs-cards" role="radiogroup" aria-label={label} onKeyDown={arrowFocus}>
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on} aria-label={o.title} aria-describedby={o.help ? `${id}-${i}` : undefined} data-value={o.id} disabled={disabled || o.disabled} className={`cs-card${on ? " on" : ""}${o.danger ? " danger" : ""}`} onClick={() => !on && onChange(o.id)}>
            <span className="cs-card-text">
              <span className="cs-card-title">
                {o.title}
                {(o.badges ?? []).map((b) => (
                  <span key={b} className="pop-badge">{b}</span>
                ))}
              </span>
              {o.help && (
                <span className="cs-card-help" id={`${id}-${i}`}>
                  {o.help}
                </span>
              )}
            </span>
            {/* The tick pops in (motion-controls.css) in a box of its own: Chrome never says an animation on an <svg> ended. */}
            {on && (
              <span className="cs-tick" aria-hidden="true">
                <Check size={17} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** What an agent may do without asking, each level with the sentence that says what it allows for this agent. */
export function PermissionCards({ provider, value, onChange, disabled }: { provider: Provider; value: PermissionMode; onChange: (v: PermissionMode) => void; disabled?: boolean }) {
  return (
    <RadioCards
      label="What it may do"
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={PERMISSION_MODES.map((m) => {
        const info = permissionInfo(provider, m.id);
        return { id: m.id, title: info.short, help: info.help, danger: info.tone === "red" };
      })}
    />
  );
}

/** What an account is, in the line under its name. */
export function accountHelp(a: AgentAccount): string {
  const kind = a.kind === "apikey" ? "API key, billed per use" : a.kind === "endpoint" ? "Your own model or service" : a.account || "Signed in";
  return a.signedIn === false ? `${kind} · not signed in` : kind;
}

/** Which of the agent's accounts answers (shown when it has more than one). */
export function AccountCards({ accounts, value, onChange, disabled }: { accounts: AgentAccount[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return <RadioCards label="Account" value={value} onChange={onChange} disabled={disabled} options={accounts.map((a) => ({ id: a.id, title: a.label, help: accountHelp(a) }))} />;
}

/**
 * How hard the agent thinks, as labelled steps in its own names. `value` "" is the default: the model's own level when
 * it says one (that step is the one lit, and picking it gives "" back), else a "Default" step of its own.
 */
export function EffortSteps({ levels, value, defaultLevel, agentName, onChange, disabled }: { levels: string[]; value: string; defaultLevel: string | null | undefined; agentName: string; onChange: (v: string) => void; disabled?: boolean }) {
  const known = defaultLevel && levels.includes(defaultLevel) ? defaultLevel : "";
  const shown = value && levels.includes(value) ? value : known;
  const steps = known ? levels : ["", ...levels];
  // Up to four in a line; more make two even lines (six as three and three) rather than four and a stray pair.
  const columns = steps.length <= 4 ? steps.length : Math.ceil(steps.length / 2);
  return (
    <>
      <div className="cs-steps" role="radiogroup" aria-label="Effort" onKeyDown={arrowFocus} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {steps.map((l) => (
          <button key={l || "default"} type="button" role="radio" aria-checked={l === shown} aria-label={l ? `${effortName(l)}${l === known ? " (default)" : ""}` : "Default"} data-value={l} disabled={disabled} className={`cs-step${l === shown ? " on" : ""}`} onClick={() => l !== shown && onChange(l === known ? "" : l)}>
            {l ? effortWord(l) : "Default"}
            {l && l === known && <span className="cs-step-default">default</span>}
          </button>
        ))}
      </div>
      <p className="cs-note">{effortHint(levels, shown, agentName)}</p>
    </>
  );
}

/**
 * The model: the agent's usual ones as cards with a line each about what it's for, the rest under "More models", and
 * (where `onType` is given) one typed by name. `current` is the list's id of the one in force; `typed` a name in force
 * that the list doesn't have. `live`: a typed name is given back as it's typed (a form), else when Use is tapped.
 */
export function ModelPicker({ models, current, typed, note, onChoose, onType, live = false, typedHelp = "Typed in by name.", children }: { models: ModelOption[]; current: string | null; typed?: string | null; note: string; onChoose: (id: string) => void; onType?: (name: string) => void; live?: boolean; typedHelp?: string; children?: ReactNode }) {
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState(typed ?? "");
  const field = live ? typed ?? "" : name;
  // A pick made under "More models" is shown where the model in force always is, in the usual list: once it's in force
  // the list starts over there (and keeps the keyboard's place on it), rather than leaving a list the pick just left.
  const root = useRef<HTMLDivElement>(null);
  const picked = useRef(false);
  const shown = typed ? null : current;
  useEffect(() => {
    if (!picked.current) return;
    picked.current = false;
    if (!document.activeElement || document.activeElement === document.body) root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
  }, [shown]);
  return (
    <div ref={root} className="cs-models" role="group" aria-label="Model" onKeyDown={arrowFocus}>
      <ModelChoices key={shown ?? ""} models={models} current={shown} note={note} onChoose={(id) => { setTyping(false); picked.current = true; onChoose(id); }} />
      {typed && !typing && !live && (
        <button type="button" className="pop-item on" role="menuitemradio" aria-checked="true" onClick={() => setTyping(true)}>
          <span className="pop-item-text">
            <span className="pop-item-title">{typed}</span>
            <span className="pop-item-help">{typedHelp}</span>
          </span>
          <Check size={16} aria-hidden="true" />
        </button>
      )}
      {children}
      {onType &&
        (typing || (live && typed !== null && typed !== undefined) ? (
          <div className="cs-typed">
            <input className="input" aria-label="Model name" placeholder="Model name, as the agent takes it" value={field} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => (live ? onType(e.target.value) : setName(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter" && !live && name.trim()) { e.preventDefault(); onType(name.trim()); setTyping(false); } }} />
            {!live && (
              <button type="button" className="btn" disabled={!name.trim() || name.trim() === typed} onClick={() => { onType(name.trim()); setTyping(false); }}>
                Use
              </button>
            )}
          </div>
        ) : (
          <button type="button" className="link-btn cs-other" onClick={() => { setTyping(true); if (live) onType(""); }}>
            Another model, by name…
          </button>
        ))}
    </div>
  );
}
