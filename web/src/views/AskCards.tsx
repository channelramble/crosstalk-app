import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Quote, RotateCcw, Square } from "lucide-react";
import type { Ask, Room } from "@crosstalk/shared";
import { api } from "../api";
import { keepAsk, postAsks, removeAsk } from "../askApi";
import { askActions, askCardText, askEffortWords, askProblem, asksByMessage, quotedAnswer } from "../asks";
import { useStore } from "../store";
import { useEntrance } from "../motion";
import { ConfirmButton, Markdown } from "../ui";
import { composeQuote } from "./AskCompose";
import { CopyReply } from "./RoomView";

const NO_HANDLES: string[] = [];

/**
 * The answers of other agents under the message they were asked about. One card is full width; two or more are Compare:
 * a row you swipe sideways on a phone (each card snaps), columns on a wide screen.
 */
export function AskCards({ room, messageId }: { room: Room; messageId: string }) {
  const list = useStore((s) => s.asks[room.id]);
  const mine = useMemo(() => asksByMessage(list ?? []).get(messageId) ?? [], [list, messageId]);
  // The cards there when the chat's asks came in (they load just after its history) are drawn as they are; one asked
  // for after that comes in under its message (motion-chat.css `.m-drop`).
  const known = useRef<Set<string> | null>(null);
  if (list && !known.current) known.current = new Set(mine.map((a) => a.id));
  if (!mine.length) return null;
  const compare = mine.length > 1;
  // A tap inside the cards isn't a tap on the message (which would open its actions).
  return (
    <div className={`ask-cards${compare ? " compare" : ""}`} role="group" aria-label={compare ? "Answers from others, side by side" : "Answer from another agent"} tabIndex={compare ? 0 : undefined} onClick={(e) => e.stopPropagation()}>
      {mine.map((a) => (
        <AskCard key={a.id} ask={a} asked={!known.current?.has(a.id)} />
      ))}
    </div>
  );
}

function AskCard({ ask, asked }: { ask: Ask; asked: boolean }) {
  // Asked while the chat was up (and not part of a catch-up): it comes in. Decided once, as it first shows.
  const entrance = useEntrance();
  const [arriving] = useState(() => asked && !!entrance);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const text = askCardText(ask);
  const can = askActions(ask);
  // The model is in its name ("Codex · GPT-5.5"); how hard it was asked to think goes beside it, when it was set.
  const effort = askEffortWords(ask);
  const failed = (e: unknown, again: () => void) => toast("error", askProblem(e).text, { action: { label: "Try again", run: again } });

  const stop = async () => {
    setBusy(true);
    try {
      keepAsk(await api<Ask>("POST", `/api/asks/${encodeURIComponent(ask.id)}/stop`));
    } catch (e) {
      failed(e, () => void stop());
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await removeAsk(ask);
    } catch (e) {
      failed(e, () => void remove());
    }
  };
  // Asks the same question again; the card that failed goes once the new one is in (if it can't, Remove is still on it).
  const again = async () => {
    setBusy(true);
    try {
      await postAsks({ roomId: ask.roomId, messageId: ask.messageId, targets: [ask.target], note: ask.note });
      await removeAsk(ask).catch(() => {});
    } catch (e) {
      failed(e, () => void again());
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    composeQuote(ask.roomId, quotedAnswer(ask));
    toast("info", "Added to your message. Add a line or send as is.");
  };

  return (
    <section className={`ask-card ${text.state}${arriving ? " m-drop" : ""}`} aria-label={`${ask.label}${text.status ? `: ${text.status}` : ""}`} aria-busy={can.stop}>
      <header className="ask-card-head">
        <h4 className="ask-card-title">
          {ask.label}
          {effort && <span className="ask-card-effort"> · {effort}</span>}
        </h4>
        {text.status && (
          <span className="ask-card-status" role="status">
            {can.stop && <Loader2 size={13} className="spin" aria-hidden="true" />}
            {text.status}
          </span>
        )}
      </header>
      {ask.note && <p className="ask-note">“{ask.note}”</p>}
      {text.problem && (
        <p className="ask-problem" role="alert">
          {text.problem}
        </p>
      )}
      {text.answer && <Answer text={text.answer} />}
      <div className="ask-card-foot">
        {text.cost && <span className="ask-cost">{text.cost}</span>}
        <div className="ask-actions">
          {can.stop && (
            <button type="button" className="link-action" disabled={busy} onClick={stop}>
              <Square size={12} fill="currentColor" /> {busy ? "Stopping…" : "Stop"}
            </button>
          )}
          {can.send && (
            <button type="button" className="link-action" onClick={send}>
              <Quote size={12} /> Send to the chat
            </button>
          )}
          {can.copy && <CopyReply text={text.answer!} label="Copy answer" />}
          {can.retry && (
            <button type="button" className="link-action" disabled={busy} onClick={again}>
              <RotateCcw size={12} /> {busy ? "Trying again…" : "Try again"}
            </button>
          )}
          {can.remove && <ConfirmButton className="link-action ask-remove" label="Remove" ariaLabel={`Remove ${ask.label}`} question={text.answer ? "Remove this answer?" : "Remove this card?"} confirmLabel="Yes, remove" onConfirm={() => void remove()} />}
        </div>
      </div>
    </section>
  );
}

/** The answer, cut off after about six lines with Show more when it's longer (measured, so a short one has no button). */
function Answer({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 2);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text, open]);
  return (
    <>
      <div ref={box} className={`ask-answer${open ? "" : " clamped"}${long && !open ? " cut" : ""}`}>
        <Markdown text={text} handles={NO_HANDLES} />
      </div>
      {long && (
        <button type="button" className="link-action ask-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
