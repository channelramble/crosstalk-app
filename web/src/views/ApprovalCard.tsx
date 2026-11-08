import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, MessageCircleQuestion, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { PROVIDER_INFO, type AgentQuestion, type Approval, type ApprovalDecision, type Member } from "@crosstalk/shared";
import { api } from "../api";
import { hubStore, useStore } from "../store";
import { MemberAvatar, useInterval } from "../ui";
import { Diff } from "./ActivityBlock";
import { countdown, questionOutcome, startsWhenSeen } from "../answers";

const KIND_LABEL: Record<Approval["kind"], string> = {
  command: "wants to run a command",
  file_change: "wants to change files",
  tool: "wants to use a tool",
  permission: "is asking for more access",
  question: "has a question for you",
};

type CardProps = { approval: Approval; member?: Member; showRoom?: boolean; machine?: string };

/** A request or question waiting for you. `machine`: the machine it's on (see machineKey), when it isn't the one showing. */
export function ApprovalCard(props: CardProps) {
  return props.approval.kind === "question" ? <QuestionCard {...props} /> : <PermissionCard {...props} />;
}

/** Answers a request on its own machine, and keeps the answer there. `then`: "/seen" or "/hold" (see QuestionCard). */
async function answer(a: Approval, machine: string | undefined, body: unknown, then = "") {
  const store = machine === undefined ? undefined : hubStore(machine);
  const updated = await api<Approval>("POST", `/api/approvals/${a.id}${then}`, body, store?.getState().conn);
  if (store) store.setState((s) => ({ approvals: { ...s.approvals, [updated.id]: updated } }));
  else useStore.setState((s) => ({ approvals: { ...s.approvals, [updated.id]: updated } }));
}

function PermissionCard({ approval: a, member, showRoom, machine }: CardProps) {
  const toast = useStore((s) => s.toast);
  const room = useStore((s) => s.rooms[a.roomId]);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await answer(a, machine, { decision });
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = a.status === "pending";
  return (
    <div className={`approval ${pending ? "" : "done"}`} data-approval={a.id}>
      <div className="a-head">
        {pending ? <ShieldAlert size={16} color="var(--orange)" /> : a.status === "approved" ? <ShieldCheck size={16} color="var(--green)" /> : <ShieldX size={16} color="var(--red)" />}
        {member && <MemberAvatar member={member} size="sm" />}
        <span style={{ flex: 1 }}>
          @{member?.handle ?? "agent"} {KIND_LABEL[a.kind]}
          {showRoom && room ? <span className="muted"> · {room.name}</span> : null}
        </span>
        {!pending && (
          <span className={`pill ${a.status === "approved" ? "green" : a.status === "denied" ? "red" : ""}`}>
            {a.status === "approved" ? (a.decision === "approve_always" ? "always allowed" : "approved") : a.status}
            {a.decidedBy ? ` · ${a.decidedBy}` : ""}
          </span>
        )}
      </div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 6, wordBreak: "break-word" }}>
        {a.title}
      </div>
      {a.detail && a.detail !== a.title && <pre>{a.kind === "file_change" ? <Diff text={a.detail} /> : a.detail}</pre>}
      {pending && (
        <div className="a-actions">
          <button className="btn small primary" disabled={busy} onClick={() => decide("approve")}>
            Approve
          </button>
          {/* Says what it allows ("Always allow `git status` commands"); some requests can only be allowed once. */}
          {a.always !== null && (
            <button className="btn small always" disabled={busy} onClick={() => decide("approve_always")} title={a.always ? `${a.always.replace(/`/g, "")}: the agent won't ask for that again in this chat` : "Approve this and similar requests for the rest of the session"}>
              {a.always ? <Words text={a.always} /> : "Always allow"}
            </button>
          )}
          <button className="btn small danger" disabled={busy} onClick={() => decide("deny")}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/** Words with `code` in them, as the hub writes what "Always allow" allows. */
function Words({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

const OTHER = "__other__";

/**
 * Calls `fn` once, the first time the element is on screen in a page that's showing (a card scrolled out of view, or
 * the app in the background, isn't seen), while `active`.
 */
function useFirstSeen(ref: RefObject<HTMLElement | null>, active: boolean, fn: () => void) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    let inView = typeof IntersectionObserver === "undefined";
    let done = false;
    const check = () => {
      if (done || !inView || document.visibilityState !== "visible") return;
      done = true;
      saved.current();
    };
    const io = inView
      ? null
      : new IntersectionObserver(
          (entries) => {
            // Enough of it to read: half of it, or a good part of the screen when it's tall.
            inView = entries.some((e) => e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= 120));
            check();
          },
          { threshold: [0, 0.25, 0.5] },
        );
    io?.observe(el);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", check);
    };
  }, [active, ref]);
}

/**
 * Questions an agent asks you: pick an option (or several), or type your own answer, then send. One it asked without
 * waiting (delivery "async": it keeps working) starts with the option it recommends picked, and sends what you answered;
 * one it can go on without (autoResolveMs) counts down to that once it's on a screen (autoResolveAt), and waits once you
 * start answering.
 */
function QuestionCard({ approval: a, member, showRoom, machine }: CardProps) {
  const toast = useStore((s) => s.toast);
  const room = useStore((s) => s.rooms[a.roomId]);
  const questions = a.questions ?? [];
  const later = a.delivery === "async";
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(questions.filter((q) => q.preselected && q.options.some((o) => o.label === q.preselected)).map((q) => [q.id, [q.preselected!]])),
  );
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending = a.status === "pending";
  const agent = member ? PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}` : "The agent";
  const optional = pending && !!a.autoResolveMs;
  const counting = pending && typeof a.autoResolveAt === "number";
  const [, tick] = useState(0);
  useInterval(() => counting && tick((n) => n + 1), 1000);
  // Its time starts once it's on a screen, as Codex's own apps count it: until then, the agent waits.
  const root = useRef<HTMLDivElement>(null);
  useFirstSeen(root, startsWhenSeen(a), () => void answer(a, machine, undefined, "/seen").catch(() => {}));
  // The first tap or keystroke makes the agent wait for your answer.
  const holding = useRef(false);
  const hold = () => {
    if (!optional || holding.current) return;
    holding.current = true;
    answer(a, machine, undefined, "/hold").catch(() => (holding.current = false));
  };
  const answerOf = (q: AgentQuestion): string[] => {
    const chosen = (picked[q.id] ?? []).filter((x) => x !== OTHER);
    const typed = (other[q.id] ?? "").trim();
    return (picked[q.id] ?? []).includes(OTHER) || (!q.options.length && typed) ? [...chosen, ...(typed ? [typed] : [])] : chosen;
  };
  const ready = later ? questions.some((q) => answerOf(q).length > 0) : questions.every((q) => answerOf(q).length > 0);
  const toggle = (q: AgentQuestion, label: string) => {
    hold();
    setPicked((cur) => {
      const had = cur[q.id] ?? [];
      const next = q.multiSelect ? (had.includes(label) ? had.filter((x) => x !== label) : [...had, label]) : had.includes(label) ? [] : [label];
      return { ...cur, [q.id]: next };
    });
  };
  const send = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      const answers = Object.fromEntries(questions.map((q) => [q.id, answerOf(q)]));
      await answer(a, machine, decision === "deny" ? { decision } : { decision, answers });
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={root} className={`approval question ${pending ? "" : "done"}`} data-approval={a.id}>
      <div className="a-head">
        <MessageCircleQuestion size={16} color={pending ? "var(--accent)" : "var(--text-3)"} />
        {member && <MemberAvatar member={member} size="sm" />}
        <span style={{ flex: 1 }}>
          @{member?.handle ?? "agent"} {KIND_LABEL.question}
          {showRoom && room ? <span className="muted"> · {room.name}</span> : null}
        </span>
        {!pending && (
          <span className={`pill ${a.status === "approved" ? "green" : ""}`}>
            {questionOutcome(a)}
            {a.decidedBy ? ` · ${a.decidedBy}` : ""}
          </span>
        )}
      </div>
      {pending && later && <p className="q-note">{agent} keeps working. Your answer goes to it as a message.</p>}
      {counting && (
        <p className="q-note" role="timer">
          {agent} goes on without an answer in {countdown(a.autoResolveAt!)} unless you start answering.
        </p>
      )}
      {questions.map((q) => (
        <fieldset key={q.id} className="q-block" disabled={!pending || busy}>
          <legend className="q-legend">
            {q.header && <span className="q-header">{q.header}</span>}
            <span className="q-text">{q.question}</span>
          </legend>
          {pending ? (
            <>
              {q.options.length > 0 && (
                <div className="q-options" role={q.multiSelect ? "group" : "radiogroup"}>
                  {q.options.map((o) => {
                    const on = (picked[q.id] ?? []).includes(o.label);
                    return (
                      <button key={o.label} type="button" className={`q-option ${on ? "on" : ""}`} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} onClick={() => toggle(q, o.label)}>
                        <span className={`q-mark ${q.multiSelect ? "box" : "dot"}`}>{on && <Check size={12} strokeWidth={3} />}</span>
                        <span className="q-option-text">
                          <span className="q-option-label">{o.label}</span>
                          {o.description && <span className="q-option-help">{o.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                  {q.allowOther && (
                    <button type="button" className={`q-option ${(picked[q.id] ?? []).includes(OTHER) ? "on" : ""}`} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={(picked[q.id] ?? []).includes(OTHER)} onClick={() => toggle(q, OTHER)}>
                      <span className={`q-mark ${q.multiSelect ? "box" : "dot"}`}>{(picked[q.id] ?? []).includes(OTHER) && <Check size={12} strokeWidth={3} />}</span>
                      <span className="q-option-text">
                        <span className="q-option-label">Other</span>
                        <span className="q-option-help">Type your own answer</span>
                      </span>
                    </button>
                  )}
                </div>
              )}
              {q.allowOther && (!q.options.length || (picked[q.id] ?? []).includes(OTHER)) && (
                <input
                  className="input q-other"
                  type={q.secret ? "password" : "text"}
                  value={other[q.id] ?? ""}
                  onFocus={hold}
                  onChange={(e) => (hold(), setOther({ ...other, [q.id]: e.target.value }))}
                  placeholder="Your answer"
                  autoFocus={q.options.length > 0}
                  autoComplete="off"
                />
              )}
            </>
          ) : (
            <p className="q-answer">{a.answers?.[q.id]?.length ? (q.secret ? "••••••" : a.answers[q.id].join(", ")) : "No answer"}</p>
          )}
        </fieldset>
      ))}
      {pending && (
        <div className="a-actions">
          <button className="btn small primary" disabled={busy || !ready} onClick={() => send("approve")}>
            {questions.length > 1 ? "Send answers" : "Send answer"}
          </button>
          <button className="btn small" disabled={busy} onClick={() => send("deny")} title={later ? "Close this question: nothing is sent" : "Let the agent decide by itself"}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}
