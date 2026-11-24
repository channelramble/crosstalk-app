import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { GroupAnswers } from "@crosstalk/shared";
import { ANSWER_OPTIONS, HOW_TOGETHER, leadHelp, moreLine } from "../groupChat";
import { parallelWorkHelp } from "../teamwork";
import { ChoiceCards, Stepper, Switch } from "../ui";

/** An agent that can lead: how the picker names it, and its @name for the line that sums "More" up. */
export interface LeadChoice {
  id: string;
  label: string;
  handle: string;
}

/**
 * The one choice a group chat has about its agents, the same in New group chat and in the chat's settings: how they
 * work together, in a person's words. What most people never change sits behind "More" (who leads, how many review
 * rounds, working at the same time), and the line beside it says what those are now, so nothing behind the fold is a
 * surprise.
 */
export function GroupHow({
  answers,
  onAnswers,
  leads,
  lead,
  onLead,
  rounds,
  onRounds,
  parallel,
  onParallel,
  note,
}: {
  answers: GroupAnswers;
  onAnswers: (a: GroupAnswers) => void;
  leads: LeadChoice[];
  lead: string;
  onLead: (id: string) => void;
  rounds: number;
  onRounds: (n: number) => void;
  parallel: boolean;
  onParallel: (v: boolean) => void;
  /** Something the choice needs that isn't there yet ("needs two agents"), said under it. */
  note?: string | null;
}) {
  const [more, setMore] = useState(false);
  const moreId = useId();
  const leading = leads.find((l) => l.id === lead) ?? leads[0];
  return (
    <>
      <div className="field">
        <span>{HOW_TOGETHER}</span>
        <ChoiceCards label={HOW_TOGETHER} value={answers} onChange={onAnswers} options={ANSWER_OPTIONS} />
        {note && (
          <span className="help group-how-note" role="status">
            {note}
          </span>
        )}
      </div>
      <div className={`group-more ${more ? "open" : ""}`}>
        <button type="button" className="group-more-head" onClick={() => setMore(!more)} aria-expanded={more} aria-controls={moreId}>
          <span className="group-more-title">More</span>
          {leading && <span className="group-more-sub">{moreLine({ lead: leading.handle, answers, rounds, parallel })}</span>}
          <ChevronDown size={16} className={`group-pick-chevron ${more ? "expanded" : ""}`} aria-hidden="true" />
        </button>
        {more && (
          <div className="group-more-body" id={moreId}>
            {leads.length > 0 && (
              <label className="field">
                <span>Lead</span>
                <select className="select" aria-label="Lead" value={leading?.id ?? ""} onChange={(e) => onLead(e.target.value)}>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <span className="help">{leadHelp(answers)}</span>
              </label>
            )}
            {answers === "review" && (
              <div className="field">
                <span>Most review rounds</span>
                <Stepper label="review rounds" value={rounds} min={1} max={25} onChange={onRounds} unit={(n) => `${n} round${n === 1 ? "" : "s"}`} />
                <span className="help">One round is the lead's work, then the review. They stop as soon as the reviewer approves.</span>
              </div>
            )}
            <div className="row group-more-switch">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>Let agents work at the same time</div>
                <div className="help">{parallelWorkHelp(parallel, answers === "review" ? "review" : "direct")}</div>
              </div>
              <Switch checked={parallel} onChange={onParallel} label="Let agents work at the same time" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
