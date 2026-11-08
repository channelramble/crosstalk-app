import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert, FilePen, Lightbulb, ListChecks, Loader2, Terminal, Wrench, Info } from "lucide-react";
import type { Activity, ActivityKind } from "@crosstalk/shared";
import { useStore } from "../store";
import { EntranceScope, useEntrance } from "../motion";

const ICON: Record<ActivityKind, React.ComponentType<{ size?: number }>> = {
  command: Terminal,
  file_change: FilePen,
  tool: Wrench,
  thinking: Lightbulb,
  plan: ListChecks,
  notice: Info,
};

function summary(acts: Activity[]): string {
  const n = (k: ActivityKind) => acts.filter((a) => a.kind === k).length;
  const parts: string[] = [];
  const cmd = n("command");
  const files = n("file_change");
  const tools = n("tool");
  if (cmd) parts.push(`${cmd} command${cmd > 1 ? "s" : ""}`);
  if (files) parts.push(`${files} file change${files > 1 ? "s" : ""}`);
  if (tools) parts.push(`${tools} tool call${tools > 1 ? "s" : ""}`);
  if (!parts.length) parts.push(`${acts.length} step${acts.length > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

export function ActivityBlock({ activities, live, statusUnknown = false, thinking = false }: { activities: Activity[]; live: boolean; statusUnknown?: boolean; thinking?: boolean }) {
  const running = activities.filter((a) => a.status === "running" && (a.kind !== "thinking" || thinking));
  const unconfirmed = activities.some((a) => a.status === "running");
  const errors = activities.filter((a) => a.status === "error").length;
  const current = running[running.length - 1];
  // A reply that is working opens a short list of its steps by itself, decided once, when the list first shows live: it
  // stays open as more steps arrive (a fourth step is the same reply working, not a reason to fold it away under someone
  // reading it), and folds into its summary when the reply ends. A list already long by then starts folded. Opening or
  // closing it by hand is never undone: the attribute only changes when this does.
  const opened = useRef<boolean | null>(null);
  if (live && opened.current === null) opened.current = activities.length <= 3;
  // Motion (motion-chat.css): a list that shows up on a chat that's up fades in, and so does a step that comes in while
  // it's on screen; opened by hand, its steps fade in as it opens; its chevron turns. Its words never move.
  const fresh = useEntrance() ? " m-fresh" : "";
  const [tapped, setTapped] = useState(false);
  return (
    <details className={`activity${fresh}${tapped ? " m-tapped" : ""}`} open={live && opened.current ? true : undefined}>
      <summary onClick={() => setTapped(true)}>
        {live && running.length ? <Loader2 size={13} className="spin" /> : errors ? <CircleAlert size={13} color="var(--red)" /> : unconfirmed ? <Info size={13} /> : <CheckCircle2 size={13} color="var(--green)" />}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {live && current ? current.title : summary(activities)}
          {!live && unconfirmed ? statusUnknown ? " · status unknown" : " · outcome not reported" : ""}
          {errors ? ` · ${errors} failed` : ""}
        </span>
        <ChevronRight size={13} className="activity-chevron" />
      </summary>
      <EntranceScope>
        {activities.map((a) => (
          <ActivityRow key={a.id} a={a} live={live && (a.kind !== "thinking" || thinking)} statusUnknown={statusUnknown} />
        ))}
      </EntranceScope>
    </details>
  );
}

function ActivityRow({ a, live, statusUnknown }: { a: Activity; live: boolean; statusUnknown: boolean }) {
  const Icon = ICON[a.kind] ?? Info;
  const [open, setOpen] = useState(false);
  const fresh = useEntrance() ? " m-fresh" : "";
  return (
    <details className={`act-row${fresh}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {a.status === "running" && live ? <Loader2 size={13} className="spin" /> : a.status === "error" ? <CircleAlert size={13} color="var(--red)" /> : <Icon size={13} />}
        <span className="t">{a.title}</span>
        {a.status === "running" && !live && <span className="muted tiny" style={{ maxWidth: "45%" }}>{statusUnknown ? "Last reported running" : "Outcome not reported"}</span>}
      </summary>
      {open && <StepDetail a={a} />}
    </details>
  );
}

/** An opened step's detail. A long one arrives as its start: the rest loads now, and the start shows meanwhile. */
export function StepDetail({ a }: { a: Activity }) {
  const loadActivity = useStore((s) => s.loadActivity);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const partial = a.detailLength !== undefined;
  useEffect(() => {
    if (!partial) return;
    let current = true;
    setFailed(null);
    loadActivity(a.roomId, a.id).catch((e) => current && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [partial, a.roomId, a.id, attempt, loadActivity]);
  return (
    <>
      {a.detail ? <pre>{a.kind === "file_change" ? <Diff text={a.detail} /> : a.detail}{partial && "…"}</pre> : <pre className="muted">{partial ? "Loading…" : "No output."}</pre>}
      {partial && (failed ? (
        <p className="step-more" role="alert">
          Couldn't load the rest. {failed}{" "}
          <button className="link-action" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </p>
      ) : (
        <p className="step-more muted" role="status">Loading the rest…</p>
      ))}
    </>
  );
}

export function Diff({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((l, i) => (
        <div key={i} className={/^\+(?!\+\+)/.test(l) ? "diff-add" : /^-(?!--)/.test(l) ? "diff-del" : undefined}>
          {l || " "}
        </div>
      ))}
    </>
  );
}
