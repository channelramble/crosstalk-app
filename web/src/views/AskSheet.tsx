import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Loader2, Users } from "lucide-react";
import type { AskChoice, AskMachineNote, Room } from "@crosstalk/shared";
import { api } from "../api";
import { postAsks } from "../askApi";
import { ASK_NOTE_MAX, askBadges, askCostHint, askGroups, askMemo, askPrivacyLine, askProblem, askRowKey, askRowSub, initialPick, nextPick, readTargets, sortChoices, withPick, type AskModelPick } from "../asks";
import { useStore } from "../store";
import { Dialog } from "../ui";
import { askPicksChanged } from "./AskCompose";
import { AskModelPicker } from "./AskModelPicker";
import { HelpTip } from "./HelpTip";

/** "Ask others" in a message's actions: opens the sheet for that message. */
export function AskOthersButton({ room, messageId }: { room: Room; messageId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link-action" onClick={() => setOpen(true)}>
        <Users size={12} /> Ask others
      </button>
      {open && <AskSheet room={room} messageId={messageId} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Who to ask about one message: a row each (name, what it is, what it costs, why not when it can't be asked), and under a
 * picked row which of its models answers (and how hard it thinks), an optional question, and the button. The list comes from
 * the hub when the sheet opens, each row on the model the person picked for it last time.
 */
function AskSheet({ room, messageId, onClose }: { room: Room; messageId: string; onClose: () => void }) {
  const setView = useStore((s) => s.setView);
  const base = useId();
  const [choices, setChoices] = useState<AskChoice[] | null>(null);
  /** Other machines that couldn't say who they can run (a line each, with Try again). */
  const [machines, setMachines] = useState<AskMachineNote[]>([]);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  /** The rows picked (`askRowKey`: a row stays picked while its model changes). */
  const [picked, setPicked] = useState<string[]>([]);
  /** The model and effort picked for each row ("" for its default): what it opened on, then what the person changed. */
  const [picks, setPicks] = useState<Record<string, AskModelPick>>({});
  /** The rows whose pick the person changed here: with those that opened on a kept pick, the only ones the hub keeps (askMemo). */
  const [changed, setChanged] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof askProblem> | null>(null);

  useEffect(() => {
    let current = true;
    setChoices(null);
    setLoadProblem(null);
    // After a Try again the hub asks the other machines again instead of using what they said a moment ago. models=1: what
    // each row can be asked on, for its picker (a hub of 0.6.1 or older sends none, and its rows are asked as listed).
    api<unknown>("GET", `/api/asks/targets?room=${encodeURIComponent(room.id)}&machines=1&models=1${tries ? "&refresh=1" : ""}`)
      .then((data) => {
        if (!current) return;
        const found = readTargets(data);
        setChoices(sortChoices(found.choices));
        setMachines(found.machines);
        // A row opens on the pick the hub kept for it; one the person already changed here (before a Try again) keeps theirs.
        setPicks((cur) => Object.fromEntries(found.choices.map((c) => [askRowKey(c.target), cur[askRowKey(c.target)] ?? initialPick(c)] as const)));
      })
      .catch((e) => current && setLoadProblem(askProblem(e).text));
    return () => {
      current = false;
    };
  }, [room.id, tries]);

  const asked = useMemo(() => (choices ?? []).filter((c) => c.available && picked.includes(askRowKey(c.target))), [choices, picked]);
  // Each picked row as it will be asked: on its picked model and effort, named and priced for that model.
  const chosen = useMemo(() => asked.map((c) => withPick(c, picks[askRowKey(c.target)])), [asked, picks]);
  const hint = askCostHint(chosen);
  const setPick = (c: AskChoice, pick: AskModelPick) => {
    const key = askRowKey(c.target);
    setPicks((cur) => ({ ...cur, [key]: nextPick(c, pick) }));
    setChanged((cur) => (cur.includes(key) ? cur : [...cur, key]));
  };
  // The hub keeps only the first ASK_NOTE_MAX characters of a question (hub/src/asks.ts), so a longer one is refused
  // here, before a request is spent on half a question — the same way the message box refuses "@codex …" (asks.ts
  // sendPlan). Said as you type, with how much to take off, and the box is never cut short behind your back.
  const over = note.trim().length - ASK_NOTE_MAX;
  const tooLong = over > 0 ? `That's too long to ask others (${ASK_NOTE_MAX.toLocaleString("en-US")} characters at most). Take off ${over.toLocaleString("en-US")} ${over === 1 ? "character" : "characters"}.` : null;
  const box = useRef<HTMLTextAreaElement>(null);
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const openSettings = () => {
    setView("settings");
    onClose();
  };
  const submit = async () => {
    // Nothing is sent while it's too long: the line above says so, and this puts the cursor where it's shortened.
    if (tooLong) {
      box.current?.focus();
      return;
    }
    setSending(true);
    setProblem(null);
    // The picks go with the question, and the hub keeps them for next time once it took the question (nothing is sent before).
    const remember = asked.flatMap((c) => askMemo(c, picks[askRowKey(c.target)], changed.includes(askRowKey(c.target))) ?? []);
    try {
      await postAsks({ roomId: room.id, messageId, targets: chosen.map((c) => c.target), note: note.trim(), ...(remember.length ? { remember } : {}) });
      // The message box's list is read again, so an @name there asks with these picks from now on.
      if (remember.length) askPicksChanged(room.id);
      onClose();
    } catch (e) {
      setProblem(askProblem(e));
    } finally {
      setSending(false);
    }
  };

  const footer = (
    <div className="ask-foot">
      {problem && (
        <div className="ask-error" role="alert">
          <p>{problem.text}</p>
          <div className="row wrap">
            <button type="button" className="btn small" disabled={sending} onClick={submit}>
              Try again
            </button>
            {problem.fix && (
              <button type="button" className="btn small" onClick={openSettings}>
                {problem.fix === "limit" ? "Raise limit" : "Open settings"}
              </button>
            )}
          </div>
        </div>
      )}
      {hint && (
        <p className="ask-hint" role="status">
          {hint}
        </p>
      )}
      <p className="help">{askPrivacyLine(chosen)}</p>
      <div className="ask-foot-buttons">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!chosen.length || sending} onClick={submit}>
          {sending ? "Asking…" : chosen.length ? `Ask ${chosen.length}` : "Pick who to ask"}
        </button>
      </div>
    </div>
  );

  return (
    <Dialog title="Ask others about this message" icon={<Users size={18} />} onClose={onClose} footer={footer}>
      <p className="help ask-intro">They read this message and the chat before it. They can't change anything.</p>
      <div className="ask-list-head">
        <span>Who to ask</span>
        <HelpTip label="What do these labels mean?">Costs money is billed to an API key or an online service. Uses your plan counts against your Claude or ChatGPT plan, with no extra bill. Free is a model on one of your machines.</HelpTip>
      </div>
      {choices === null && !loadProblem && (
        <p className="ask-loading" role="status">
          <Loader2 size={16} className="spin" aria-hidden="true" /> Looking for who you can ask…
        </p>
      )}
      {loadProblem && (
        <div className="ask-error" role="alert">
          <p>Couldn't load who you can ask. {loadProblem}</p>
          <button type="button" className="btn small" onClick={() => setTries((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {choices && choices.length === 0 && machines.length === 0 && (
        <div className="ask-error" role="status">
          <p>There's nobody to ask yet. Sign in to another agent in Settings, then try again.</p>
          <div className="row wrap">
            <button type="button" className="btn small" onClick={openSettings}>
              Open settings
            </button>
            <button type="button" className="btn small" onClick={() => setTries((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      )}
      {choices && (choices.length > 0 || machines.length > 0) && (
        <>
          {askGroups(choices, machines).map((g) => (
            <section key={g.key} className="ask-group">
              {g.heading && <h3 className="ask-group-head">{g.heading}</h3>}
              {g.rows.length > 0 && (
                <ul className="ask-rows" aria-label={g.heading ?? "Who to ask"}>
                  {g.rows.map((c) => {
                    const key = askRowKey(c.target);
                    return <AskRow key={key} choice={c} pick={picks[key] ?? initialPick(c)} on={c.available && picked.includes(key)} detailId={`${base}-${choices.indexOf(c)}`} onToggle={() => toggle(key)} onPick={(pick) => setPick(c, pick)} />;
                  })}
                </ul>
              )}
              {g.note && (
                <div className="ask-machine-note" role="status">
                  <p>{g.note.why}</p>
                  <button type="button" className="btn small" onClick={() => setTries((n) => n + 1)}>
                    Try again
                  </button>
                </div>
              )}
            </section>
          ))}
          <label className="ask-question">
            <span>Your question (optional)</span>
            <textarea ref={box} className="input textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What do you think? Anything wrong or missing?" aria-describedby={tooLong ? `${base}-long` : undefined} />
            {tooLong && (
              <span className="ask-why" role="alert" id={`${base}-long`}>
                {tooLong}
              </span>
            )}
          </label>
        </>
      )}
    </Dialog>
  );
}

/**
 * One row of the sheet: the whole row is its checkbox, with its name (on the model picked for it), what an ask on that model
 * costs, where it runs, and why not when it can't be asked. Once it's picked, which of its models answers goes under it,
 * outside the row (a tap on the picker mustn't untick it).
 */
export function AskRow({ choice: c, pick, on, detailId, onToggle, onPick }: { choice: AskChoice; pick: AskModelPick; on: boolean; detailId: string; onToggle: () => void; onPick: (pick: AskModelPick) => void }) {
  // The row on its picked model: its name says the model, its badge what an ask on that model costs.
  const shown = withPick(c, pick);
  const badges = askBadges(shown);
  // The hub's `sub` is left out when it only says what the badges say (the kind of sign-in, where it runs).
  const sub = askRowSub(c);
  return (
    <li>
      <label className={`ask-row${c.available ? "" : " off"}${on ? " on" : ""}`}>
        <input type="checkbox" checked={on} disabled={!c.available} onChange={onToggle} aria-label={shown.label} aria-describedby={detailId} />
        <span className="ask-box" aria-hidden="true">
          <Check size={16} strokeWidth={3} />
        </span>
        <span className="ask-row-main">
          <span className="ask-row-name">{shown.label}</span>
          <span className="ask-row-detail" id={detailId}>
            {sub && <span className="ask-row-sub">{sub}</span>}
            <span className="ask-row-badges">
              <span className={`ask-badge ${badges.kind}`}>{badges.cost}</span>
              <span className="ask-badge">{badges.where}</span>
            </span>
            {!c.available && <span className="ask-why">{c.why ?? "Not available right now"}</span>}
          </span>
        </span>
      </label>
      {on && <AskModelPicker choice={c} pick={pick} onChange={onPick} />}
    </li>
  );
}
