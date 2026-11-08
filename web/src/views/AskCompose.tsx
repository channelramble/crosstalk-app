// Ask others in the message box: the @ popup, the chips and notices above the box, and "Send to the chat" putting a quote in it.
// What Send does with a draft that names someone is decided by `sendPlan` (asks.ts) and done by Composer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AskChoice, Member } from "@crosstalk/shared";
import { memberAccount } from "../accounts";
import { api } from "../api";
import { askBadges, askChipNote, askOnlyLine, askProblem, askTargetKey, chipText, hasMention, isOwnAgent, keepSilentMachines, mentionCandidates, mentionedChoices, readTargets, type OwnAgent } from "../asks";
import { ProviderAvatar } from "../ui";

/** The list of who can be asked is read again when an @ is typed and it's older than this (after a failure, after RETRY_MS). */
const FRESH_MS = 30_000;
const PICKS_CHANGED = "crosstalk:ask-picks";

/** The sheet asked with the models picked in it: a chat's message box reads its list of who can be asked again (`useAskCompose`). */
export function askPicksChanged(roomId: string) {
  window.dispatchEvent(new CustomEvent(PICKS_CHANGED, { detail: { roomId } }));
}
const RETRY_MS = 10_000;
/** Send waits this long for the list of who can be asked before it says it couldn't check. */
const CHECK_MS = 8_000;

/** What the message box says while the draft names someone (or an @ is being typed) and who can be asked couldn't be looked up. */
export interface AskListHint {
  /** Why, in plain words. */
  why: string;
  /** Another look is under way. */
  busy: boolean;
}

/**
 * The message box's side of Ask others, for a chat: who can be asked (loaded when an @ is typed, not before), the
 * popup's rows for what's typed after the @ (`query`, null when no @ is being typed), and the chips: who the draft
 * names. The chat's own agent is never offered or taken for a mention. `state` is where the list is: here, on its way,
 * or couldn't be had (then `hint` says why, `retry` looks again, and `check` waits for it, at most CHECK_MS).
 */
export function useAskCompose(roomId: string, enabled: boolean, member: Member | undefined, text: string, query: string | null) {
  const [choices, setChoices] = useState<AskChoice[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const loadedAt = useRef(0);
  const inflight = useRef<Promise<AskChoice[] | null> | null>(null);
  // The list as it was last kept (what `choices` holds), for the next answer to start from.
  const latest = useRef<AskChoice[] | null>(null);
  // One request at a time, shared by whoever asks meanwhile: the list, or null when it can't be had (`failure` says why).
  const fetchList = useCallback((): Promise<AskChoice[] | null> => {
    if (!inflight.current) {
      setChecking(true);
      // machines=1: the rows of the person's other machines too (a hub from before 0.5 sends its own, as a plain list).
      inflight.current = api<unknown>("GET", `/api/asks/targets?room=${encodeURIComponent(roomId)}&machines=1`)
        .then((data) => {
          const found = readTargets(data);
          // A machine that doesn't answer this time keeps its rows from before, greyed: a draft that names one stays blocked,
          // and isn't sent to the chat's own agent as if the name were text.
          const list = keepSilentMachines(latest.current, found.choices, found.machines);
          latest.current = list;
          loadedAt.current = Date.now();
          setChoices(list);
          setFailure(null);
          return list;
        })
        .catch((e) => {
          // An older hub has no list: not asked again on every key, only after a while.
          loadedAt.current = Date.now() - FRESH_MS + RETRY_MS;
          setFailure(askProblem(e).text);
          return null;
        })
        .finally(() => {
          inflight.current = null;
          setChecking(false);
        });
    }
    return inflight.current;
  }, [roomId]);
  const load = useCallback(() => {
    if (enabled && Date.now() - loadedAt.current >= FRESH_MS) void fetchList();
  }, [enabled, fetchList]);
  const retry = useCallback(() => void fetchList(), [fetchList]);
  // A draft that already names someone (kept from before) needs the list too, before an @ is typed again.
  const hasAt = text.includes("@");
  useEffect(() => {
    if (hasAt) load();
  }, [hasAt, load]);
  // The sheet just asked with a model picked for someone: the hub keeps that pick, so the next @name asks with it. The list
  // here is read again then (at once while the draft names someone), not up to FRESH_MS later.
  const hasAtNow = useRef(hasAt);
  hasAtNow.current = hasAt;
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<{ roomId: string }>).detail?.roomId !== roomId) return;
      loadedAt.current = 0;
      if (hasAtNow.current) load();
    };
    window.addEventListener(PICKS_CHANGED, changed);
    return () => window.removeEventListener(PICKS_CHANGED, changed);
  }, [roomId, load]);
  const provider = member?.provider;
  const model = member ? (member.resolvedModel ?? member.model) : null;
  const account = member ? memberAccount(member) : null;
  const own = useMemo<OwnAgent | null>(() => (provider && account ? { provider, account, model } : null), [provider, account, model]);
  const usable = useMemo(() => (choices ?? []).filter((c) => !isOwnAgent(c.target, own)), [choices, own]);
  const rows = useMemo(() => (query === null ? [] : mentionCandidates(usable, query, own)), [usable, query, own]);
  const chips = useMemo(() => (usable.length ? mentionedChoices(text, usable) : []), [text, usable]);
  // Who can be asked, for a draft sent before the list was here: waits for the one on its way (or asks again), and gives
  // up after CHECK_MS with a reason (an answer that comes later still takes it away again).
  const check = useCallback(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), CHECK_MS);
    });
    const list = await Promise.race([fetchList(), slow]);
    clearTimeout(timer);
    if (!list) {
      setFailure((was) => was ?? "The hub is taking too long to answer.");
      return null;
    }
    return list.filter((c) => !isOwnAgent(c.target, own));
  }, [fetchList, own]);
  const names = enabled && hasMention(text);
  const state: "ready" | "loading" | "failed" = choices !== null ? "ready" : failure !== null ? "failed" : "loading";
  const hint: AskListHint | null = enabled && choices === null && failure !== null && (names || query !== null) ? { why: failure, busy: checking } : null;
  return { load, retry, check, rows, chips, usable, state, hint };
}

/**
 * The @ popup in a chat: who can be asked (greyed, with why, when someone can't). `index` counts the rows that can (they
 * come first). `id`: the listbox's, which the message box points into; the row that can be picked at `index` is `${id}-${index}`.
 */
export function AskMentionPop({ id, rows, index, onPick }: { id?: string; rows: AskChoice[]; index: number; onPick: (handle: string) => void }) {
  return (
    <div className="mention-pop ask-pop" role="listbox" id={id} aria-label="Ask someone else">
      {rows.map((c, i) =>
        c.available ? (
          <button key={askTargetKey(c.target)} id={id ? `${id}-${i}` : undefined} type="button" className={i === index ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c.handle)} role="option" aria-selected={i === index}>
            <ProviderAvatar provider={c.target.provider} size="sm" />
            <span className="ask-pop-name">
              <strong>@{c.handle}</strong> <span className="muted small">{c.label}</span>
            </span>
            <span className={`ask-badge ${askBadges(c).kind}`}>{askBadges(c).cost}</span>
          </button>
        ) : (
          <div key={askTargetKey(c.target)} className="ask-pop-off" role="option" aria-disabled="true" aria-selected="false">
            <ProviderAvatar provider={c.target.provider} size="sm" />
            <span className="ask-pop-name">
              <strong>@{c.handle}</strong> <span className="muted small">{c.label}</span>
              <span className="ask-why">{c.why ?? "Not available right now"}</span>
            </span>
          </div>
        ),
      )}
    </div>
  );
}

/** A notice above the box: what's wrong in plain words, and the buttons that get out of it. */
export interface AskNotice {
  text: string;
  actions: { label: string; run: () => void; busy?: boolean }[];
}

/**
 * Above the box: "Codex will chime in ×" for each one the draft names (× takes its @name out of the draft), and in the
 * same row, under them, that only they answer and the chat's own agent won't see the draft, then where the chat goes
 * (the sheet's footer says it too, every time); and a notice when Send won't do it (or who can be asked couldn't be
 * looked up), with its way out. A new `noticeKey` shows the notice again (a tap on Send that it blocked).
 */
export function AskChips({ chips, ownName, notice, noticeKey, onRemove }: { chips: AskChoice[]; ownName: string | null; notice: AskNotice | null; noticeKey: number; onRemove: (c: AskChoice) => void }) {
  const only = askOnlyLine(chips, ownName);
  const note = askChipNote(chips);
  return (
    <>
      {chips.length > 0 && (
        <div className="ask-chips" role="group" aria-label="Others who will chime in">
          {chips.map((c) => (
            <span key={askTargetKey(c.target)} className={`ask-chip${c.available ? "" : " off"}`}>
              <span className="ask-chip-text">{chipText(c)}</span>
              {c.available && c.paid !== "no" && !c.local && <span className={`ask-badge ${askBadges(c).kind}`}>{askBadges(c).cost}</span>}
              <button type="button" className="ask-chip-x" aria-label={`Don't ask ${c.label}`} onClick={() => onRemove(c)}>
                <X size={16} aria-hidden="true" />
              </button>
            </span>
          ))}
          {only && <p className="ask-chips-only">{only}</p>}
          {note && <p className="ask-chips-note">{note}</p>}
        </div>
      )}
      {notice && (
        <div className="ask-check" role="alert" key={noticeKey}>
          <span>{notice.text}</span>
          <div className="ask-check-actions">
            {notice.actions.map((a) => (
              <button key={a.label} type="button" className="btn small" disabled={a.busy} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---- "Send to the chat" ------------------------------------------------------------------------------------------

const COMPOSE = "crosstalk:compose";

/** An answer's card puts a quote in this chat's message box (the box adds it to what's written; see useQuoteInsert). */
export function composeQuote(roomId: string, quote: string) {
  window.dispatchEvent(new CustomEvent(COMPOSE, { detail: { roomId, quote } }));
}

/** The message box listens for quotes from the cards of its own chat. */
export function useQuoteInsert(roomId: string, insert: (quote: string) => void) {
  const latest = useRef(insert);
  latest.current = insert;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ roomId: string; quote: string }>).detail;
      if (d.roomId === roomId) latest.current(d.quote);
    };
    window.addEventListener(COMPOSE, on);
    return () => window.removeEventListener(COMPOSE, on);
  }, [roomId]);
}
