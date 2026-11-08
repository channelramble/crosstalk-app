// New chat → From a template: every machine's templates (each under its machine's name when there are several), the blanks
// of the one picked, and the first message it starts with. What it sets on the rest of New chat (agent, account, model,
// effort, folder) is AgentScreen.tsx's NewChatDialog's to apply (templates.ts withTemplate).
import { useRef } from "react";
import { PROVIDER_INFO, type PromptTemplate } from "@crosstalk/shared";
import { agentReady, type Machine } from "../store";
import { blankLabel, blankValue, blanksIn, emptyBlanks, pickValue, templateLine, type TemplateGroup } from "../templates";
import { useAutosize } from "../ui";

/** The template New chat was filled in from, and its machine's key. */
export interface Picked {
  machine: string;
  template: PromptTemplate;
}

/**
 * `several`: this device has several machines, so each template is listed under its machine's name. `note`: what of the
 * picked one New chat doesn't use, and why (templates.ts templateNote).
 */
export function TemplatePick({ groups, several, picked, onPick, message, onMessage, values, onValues, note = null }: { groups: TemplateGroup<Machine>[]; several: boolean; picked: Picked | null; onPick: (value: string) => void; message: string; onMessage: (text: string) => void; values: Record<string, string>; onValues: (values: Record<string, string>) => void; note?: string | null }) {
  const blanks = picked ? blanksIn(message) : [];
  const left = picked ? emptyBlanks(message, values) : [];
  const from = picked ? groups.find((g) => g.machine.key === picked.machine)?.machine : undefined;
  const option = (machine: Machine) => (t: PromptTemplate) => {
    // A template for an agent that can't start chats there yet can't be picked: it says why.
    const blocked = !!t.agent && !agentReady(machine, t.agent);
    return (
      <option key={t.id} value={pickValue(machine.key, t.id)} disabled={blocked}>
        {t.name}
        {blocked ? ` (${PROVIDER_INFO[t.agent!].name} isn't signed in there)` : ""}
      </option>
    );
  };
  // What it sets besides the message, and with several machines, whose it is.
  const about = picked && [picked.template.agent || picked.template.folder ? templateLine(picked.template) : null, several && from ? `from ${from.name}` : null].filter(Boolean).join(" · ");
  return (
    <>
      <label className="field">
        <span>From a template</span>
        <select className="select" aria-label="From a template" value={picked ? pickValue(picked.machine, picked.template.id) : ""} onChange={(e) => onPick(e.target.value)}>
          <option value="">None</option>
          {several
            ? groups.map((g) => (
                <optgroup key={g.machine.key} label={g.machine.name}>
                  {g.templates.map(option(g.machine))}
                </optgroup>
              ))
            : groups.flatMap((g) => g.templates.map(option(g.machine)))}
          {/* Deleted on another device while it was picked here: it stays picked (and shown). */}
          {picked && !from?.templates?.some((t) => t.id === picked.template.id) && <option value={pickValue(picked.machine, picked.template.id)}>{picked.template.name}</option>}
        </select>
        {about && <span className="help">{about}</span>}
        {picked && note && <span className="help">{note}</span>}
      </label>
      {blanks.length > 0 && (
        <fieldset className="tpl-blanks">
          <legend>Fill in the blanks</legend>
          {blanks.map((b) => (
            <label key={b} className="field">
              <span>{blankLabel(b)}</span>
              <input className="input" value={blankValue(values, b)} autoComplete="off" onChange={(e) => onValues({ ...values, [b]: e.target.value })} />
            </label>
          ))}
          {left.length > 0 && <p className="help tpl-blanks-left">Fill in each one to start the chat.</p>}
        </fieldset>
      )}
      {picked && <FirstMessage value={message} onChange={onMessage} blanks={blanks.length > 0} />}
    </>
  );
}

/** The message the chat starts with, as written in the template (its blanks are filled in when it's sent). */
function FirstMessage({ value, onChange, blanks }: { value: string; onChange: (text: string) => void; blanks: boolean }) {
  const text = useRef<HTMLTextAreaElement>(null);
  useAutosize(text, value);
  return (
    <label className="field">
      <span>First message</span>
      <textarea ref={text} className="textarea tpl-message" aria-label="First message" value={value} rows={3} onChange={(e) => onChange(e.target.value)} />
      <span className="help">{blanks ? "Sent when the chat starts, with the blanks filled in." : "Sent when the chat starts. Leave it empty to write your own."}</span>
    </label>
  );
}
