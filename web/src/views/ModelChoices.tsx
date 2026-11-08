import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { ModelOption } from "@crosstalk/shared";
import { MODEL_FIND_FROM, contextLabel, findModels, isNewModel, modelGroups, modelOptionText } from "../models";

/** One choice in a menu of the chat's control row: its name, badges, a line of help, and a check on the one in use. */
export function MenuItem({ on, title, help, badges = [], tone = "", onClick }: { on: boolean; title: string; help?: string; badges?: string[]; tone?: string; onClick: () => void }) {
  return (
    <button className={`pop-item ${on ? "on" : ""} ${tone}`} onClick={onClick} role="menuitemradio" aria-checked={on}>
      <span className="pop-item-text">
        <span className="pop-item-title">
          {title}
          {badges.filter(Boolean).map((b) => (
            <span key={b} className={`pop-badge ${b === "New" ? "new" : ""}`}>{b}</span>
          ))}
        </span>
        {help && <span className="pop-item-help">{help}</span>}
      </span>
      {on && <Check size={16} aria-hidden="true" />}
    </button>
  );
}

/**
 * Where focus goes back on the usual models: "More models", or, when a newer list has none (so that button is gone),
 * the model in use, else the first one. Focus left on nothing would drop a keyboard or screen reader user out of the menu.
 */
export function usualFocus(opener: HTMLElement | null, group: ParentNode | null): HTMLElement | null {
  return opener ?? group?.querySelector<HTMLElement>('[aria-checked="true"]') ?? group?.querySelector<HTMLElement>('[role="menuitemradio"]') ?? null;
}

/**
 * A chat's model choices: the agent's usual models, then "More models" (those it keeps out of its usual list) as a
 * second step, so a long list never fills a phone screen. It's there only when the agent names more; the model in use
 * (`current`) always shows in the first step. `note` says what the more ones are.
 */
export function ModelChoices({ models, current, note, onChoose, startWithMore = false }: { models: ModelOption[]; current: string | null; note: string; onChoose: (id: string) => void; startWithMore?: boolean }) {
  const { usual, more } = modelGroups(models, current);
  const [step, setStep] = useState<"usual" | "more">(startWithMore ? "more" : "usual");
  /** What was typed to find a model, on a list too long to read down (a service's own 20, Codex's hidden ones). */
  const [find, setFind] = useState("");
  const listId = useId();
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  // Focus goes with a change of step (to Back, or back to "More models"); opening the menu leaves it where it is.
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) (step === "more" ? back.current : usualFocus(opener.current, group.current))?.focus();
  }, [step]);
  // A newer list without more models (the hub sent one while this was open) shows the usual ones. Focus was in the step
  // that went away (on Back, or one of its models), so it goes along, unless it had left the menu by then.
  useEffect(() => {
    if (step !== "more" || more.length) return;
    moved.current = !document.activeElement || document.activeElement === document.body;
    setStep("usual");
  }, [step, more.length]);
  const go = (to: "usual" | "more") => {
    moved.current = true;
    setStep(to);
  };
  /** The box that narrows a long list. It isn't focused when it appears: a tap on the menu shouldn't open a keyboard. */
  const finder = (list: ModelOption[], label: string) =>
    list.length < MODEL_FIND_FROM && !find ? null : (
      <div className="pop-find">
        <input className="input" aria-label={label} placeholder={label} value={find} onChange={(e) => setFind(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
    );
  const item = (m: ModelOption) => (
    <MenuItem
      key={m.id}
      on={current === m.id}
      title={m.label}
      badges={[m.isDefault ? "Default" : "", isNewModel(m) ? "New" : "", m.noTools ? "No tools" : ""]}
      help={[m.description, contextLabel(m)].filter(Boolean).join(" · ") || undefined}
      onClick={() => onChoose(m.id)}
    />
  );

  if (!models.length) return null;
  if (step === "more" && more.length > 0) {
    return (
      <>
        <div className="pop-more-head">
          <button ref={back} type="button" className="pop-back" onClick={() => go("usual")} aria-label="Back to the usual models">
            <ChevronLeft size={18} aria-hidden="true" />
            Back
          </button>
          <h3 className="pop-more-title">More models</h3>
        </div>
        <p className="pop-note">{note}</p>
        {finder(more, "Find a model")}
        <div id={listId} role="group" aria-label="More models">
          {findModels(more, find).map(item)}
        </div>
        {!findModels(more, find).length && <p className="pop-note">No model matches that. Clear the box to see them all.</p>}
      </>
    );
  }
  return (
    <>
      {finder(usual, "Find a model")}
      <div ref={group} id={listId} role="group" aria-label="Models">
        {findModels(usual, find).map(item)}
      </div>
      {!findModels(usual, find).length && <p className="pop-note">No model matches that. Clear the box to see them all.</p>}
      {more.length > 0 && (
        <button ref={opener} type="button" className="pop-item pop-more" onClick={() => go("more")} aria-label={`More models (${more.length})`} aria-expanded={false} aria-controls={listId}>
          <span className="pop-item-text">
            <span className="pop-item-title">
              More models
              <span className="pop-badge">{more.length}</span>
            </span>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      )}
    </>
  );
}

/**
 * A model drop-down's choices: the usual models, then the agent's more ones in a "More models" group (phones show its
 * name as a heading). `value` and `text`: what each choice saves and says.
 */
export function ModelSelectOptions({ models, value = (m) => m.id, text = modelOptionText }: { models: ModelOption[]; value?: (m: ModelOption) => string; text?: (m: ModelOption) => string }) {
  const { usual, more } = modelGroups(models);
  const option = (m: ModelOption) => (
    <option key={m.id} value={value(m)}>
      {text(m)}
    </option>
  );
  return (
    <>
      {usual.map(option)}
      {more.length > 0 && <optgroup label="More models">{more.map(option)}</optgroup>}
    </>
  );
}
