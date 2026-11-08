import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Bot, CheckCircle2, ChevronDown, CircleX, CircleAlert, Clock, Info, Lightbulb, ListChecks, Loader2, Square } from "lucide-react";
import { PROVIDER_INFO, helperAtWork, isNoRewindAgent, type Activity, type BackgroundTask, type Member, type Room, type SendNowResult } from "@crosstalk/shared";
import { api } from "../api";
import { useStore } from "../store";
import { Dialog, MemberAvatar, statusLabel, useInterval } from "../ui";
import { ActivityBlock } from "./ActivityBlock";
import { currentTurn, workOrder } from "../workOrder";
import { stepLabel, statusWords } from "../statusWords";
import { STOP_FAILED, useStopping } from "../stop";
import { queueLine, whoAnswers, workQueue } from "../groupChat";
import { noSendNow, sendNowLine, sendNowState, sendNowWords, type SendNowLine } from "../sendNow";
import { EntranceScope, useEntrance } from "../motion";

/** Shows the current turn's reported progress and actions, never previous turns' work. */
export function WorkingPanel({ room, members }: { room: Room; members: Member[] }) {
  // A group chat: a chat's status line for each agent at work, and who's next.
  if (room.chat?.group) return <GroupStatus room={room} members={members} />;
  // A chat has one agent: one quiet status line instead of the group room's work order and progress panel.
  if (room.chat)
    return members[0] ? (
      <>
        <HelpersPanel member={members[0]} />
        <ChatStatus room={room} member={members[0]} />
      </>
    ) : null;
  return <GroupWorkingPanel room={room} members={members} />;
}

/**
 * `children(entering)`: `entering` when this part appeared on a chat that was already up (motion.ts `useEntrance`), so its
 * entrance plays (motion-chat.css); false when it was drawn with the chat. Decided as it first shows, fixed after that.
 */
export function Arrive({ children }: { children: (entering: boolean) => ReactNode }) {
  return <>{children(!!useEntrance())}</>;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * A group chat at work: each agent's helpers and its status line (as a chat's, named), then the turn order: who works
 * now and who's next, in the order their turns were queued. A history that couldn't load is said once.
 */
function GroupStatus({ room, members }: { room: Room; members: Member[] }) {
  const turns = useStore((s) => s.roomData[room.id]?.turns);
  const failed = useStore((s) => !!s.roomData[room.id]?.error);
  const order = workQueue(members, Object.values(turns ?? {}));
  const line = order.next.length ? queueLine(order) : null;
  // A queued agent is said in the turn order below. One that works with only a turn queued is held there while its new
  // settings wait for its helpers, and one waiting for a usage limit gets a line too: each says what your message waits
  // for (the latter only when one does).
  const shown = failed ? members.slice(0, 1) : members.filter((m) => ["thinking", "working", "approval", "waiting"].includes(m.status) || (m.status === "queued" && !order.next.includes(m)));
  return (
    <>
      {members.map((m) => (
        <HelpersPanel key={`helpers-${m.id}`} member={m} />
      ))}
      {shown.map((m) => (
        <ChatStatus key={m.id} room={room} member={m} members={members} name={`@${m.handle}`} stop />
      ))}
      {line && (
        <Arrive>
          {(entering) => (
            <p className={`group-queue${entering ? " m-drop" : ""}`} role="status" aria-label="Turn order">
              {line}
            </p>
          )}
        </Arrive>
      )}
    </>
  );
}

/**
 * One line while the chat's agent works: what it's doing now in plain words (statusWords), how long it's been at it,
 * and its steps on tap. When the chat's history couldn't load, it says so with Retry, whether the agent works or not.
 * `name`: in a group chat, which agent the line is about; `stop`: the line has its own Stop (the others go on).
 */
function ChatStatus({ room, member, members, name, stop = false }: { room: Room; member: Member; members?: Member[]; name?: string; stop?: boolean }) {
  const data = useStore((s) => s.roomData[room.id]);
  const connected = useStore((s) => s.status === "open");
  const syncing = useStore((s) => s.syncing);
  const loadHistory = useStore((s) => s.loadHistory);
  const stopping = useStopping((s) => !!s.rooms[room.id]);
  const statusKnown = connected && !syncing && !!data?.loaded && !data.error;
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const busy = ["thinking", "working", "approval", "queued"].includes(member.status);
  const toast = useStore((s) => s.toast);
  const [sending, setSending] = useState(false);
  // A message of yours waits on this agent: behind its reply (Send now puts it in), behind its helpers while a change it
  // may not answer around waits for them, or behind a usage limit (nothing can send it sooner). Said as it is. While its
  // helpers work anything else goes by itself: no bar, no button (with "Keep going while helpers work" off, or on an older
  // hub, Send now and Answer now as ever: HubInfo.messagesFlow, which a change on any device updates at once).
  // In a group chat, only a message that's this agent's to answer waits on it (as the hub routes it).
  const forThis = room.chat?.group && members ? (m: { text: string }) => whoAnswers(room, members, m.text).who.some((x) => x.id === member.id) : undefined;
  const flows = useStore((s) => !!s.hub?.messagesFlow);
  const helpers = useStore((s) => (s.tasks[member.id] ?? []).some(helperAtWork));
  const waiting = data ? sendNowState(member, Object.values(data.turns), data.messages, forThis, flows ? { helpers } : undefined) : null;
  const who = name ?? PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
  const sendNow = async () => {
    setSending(true);
    try {
      // Whose reply it goes into (in a group chat, two can work at once). `currentSettings`: Answer now.
      const r = await api<SendNowResult>("POST", `/api/rooms/${room.id}/send-now`, { memberId: member.id, ...(waiting?.kind === "helpers" ? { currentSettings: true } : {}) });
      if (!r.sent) toast("info", sendNowWords(r, who));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  useInterval(() => busy && tick((n) => n + 1), 1000);
  if (data?.error) {
    // Said once, here: what went wrong, and Retry (it also tries again by itself). The line stays while it tries again
    // (hubStore keeps `error` until it loads), and its button isn't `disabled` meanwhile: a browser drops the focus of a
    // button it disables, and a keyboard or switch would lose its place, never hearing how the retry went.
    const off = data.loading || !connected;
    return (
      <Arrive>
        {(entering) => (
          <div className={`chat-status attention static${entering ? " m-drop" : ""}`} role="alert">
            <CircleAlert size={15} aria-hidden="true" />
            <span className="chat-status-text">
              <span className="chat-status-now">Couldn't load this chat</span>
              <span className="chat-status-note">{data.error}</span>
            </span>
            <button
              className="btn small"
              aria-disabled={off || undefined}
              onClick={() => {
                if (!off) void loadHistory(room.id);
              }}
            >
              {data.loading ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
      </Arrive>
    );
  }
  // Paused on a usage limit with a message of yours behind it: when it goes, and no button that can't help.
  if (!busy) return waiting?.kind === "limit" && statusKnown ? <SendNowBar line={sendNowLine(waiting)} /> : null;
  const turns = Object.values(data?.turns ?? {});
  const turn = currentTurn(member, turns);
  const all = turn ? (data?.activities[turn.id] ?? []) : [];
  const activities = all.filter((a) => a.kind !== "thinking" || a.detail.trim());
  const steps = activities.filter((a) => a.kind !== "thinking" && a.kind !== "plan");
  const thought = member.status === "thinking" ? all.findLast((a) => a.kind === "thinking" && a.detail.trim()) : undefined;
  const words = statusWords(member, activities);
  const live = statusKnown && !stopping;
  // Not connected, the strip under the header says so (and that it's trying again): this line says only what's known.
  const lastSeen = member.status === "queued" ? "Last seen waiting to start" : member.status === "approval" ? "Last seen waiting for you" : "Last seen working";
  const said = !connected ? lastSeen : stopping ? "Stopping…" : !statusKnown ? "Catching up…" : words.text;
  const now = name ? `${name}: ${said}` : said;
  const attention = live && words.attention;
  const note = live ? words.note : null;
  const since = turn?.startedAt ?? turn?.createdAt;
  const meta = [steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : null, since ? elapsed(Date.now() - since) : null].filter(Boolean).join(" · ");
  // It drops into place above the message box when the agent starts on a chat that's up (motion-chat.css `.m-drop`).
  const line = (entering: boolean) => (
    <button className={`chat-status ${attention ? "attention" : ""} ${open ? "open" : ""}${entering ? " m-drop" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${now}${note ? `. ${note}` : ""}. ${open ? "Hide" : "Show"} what it's doing`}>
      {attention ? <CircleAlert size={15} aria-hidden="true" /> : <Loader2 size={15} className={statusKnown || stopping ? "spin" : undefined} aria-hidden="true" />}
      <span className="chat-status-text">
        <span className="chat-status-now">{now}</span>
        {note ? <span className="chat-status-note">{note}</span> : live && thought && <span className="chat-status-thought">{lastWords(thought.detail, 140)}</span>}
      </span>
      {meta && <span className="chat-status-meta">{meta}</span>}
      <ChevronDown size={15} className={`chat-status-chevron ${open ? "expanded" : ""}`} aria-hidden="true" />
    </button>
  );
  const trace = open && <ChatTrace activities={activities} live={statusKnown} />;
  return (
    <>
      <Arrive>
        {(entering) =>
          stop ? (
            // The steps open under the line itself; its Stop stays beside it (and comes in with it).
            <div className={`group-status-row${entering ? " m-drop" : ""}`}>
              <div className="group-status-main">
                {line(false)}
                {trace}
              </div>
              <StopAgent room={room} member={member} disabled={!connected || stopping} />
            </div>
          ) : (
            <>
              {line(entering)}
              {trace}
            </>
          )
        }
      </Arrive>
      {waiting && <SendNowBar line={isNoRewindAgent(member.provider) ? noSendNow(sendNowLine(waiting)) : sendNowLine(waiting)} acting={sending} onAct={() => void sendNow()} />}
    </>
  );
}

/**
 * The line under a chat's status while a message of yours waits on the agent: what it waits for, in plain words, and
 * the one button that can really send it then (none during a usage limit: the account has nothing to send it with).
 */
export function SendNowBar({ line, acting = false, onAct }: { line: SendNowLine; acting?: boolean; onAct?: () => void }) {
  const entering = useEntrance();
  return (
    <div className={`send-now${line.action ? "" : " paused"}${entering ? " m-drop" : ""}`} role="status">
      {!line.action && <Clock size={14} aria-hidden="true" />}
      <span className="send-now-text">
        <span>{line.text}</span>
        {line.note && <span className="send-now-note">{line.note}</span>}
      </span>
      {line.action && onAct && (
        <button className="btn small primary" disabled={acting} onClick={onAct}>
          {acting ? (line.action === "Send now" ? "Sending…" : "Starting…") : line.action}
        </button>
      )}
    </div>
  );
}

/** A group chat agent's own Stop, beside its status line: its reply stops (and its waiting turns go); the others go on. */
function StopAgent({ room, member, disabled }: { room: Room; member: Member; disabled: boolean }) {
  const toast = useStore((s) => s.toast);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      await api("POST", `/api/rooms/${room.id}/stop`, { memberId: member.id });
    } catch {
      toast("error", STOP_FAILED);
    } finally {
      setStopping(false);
    }
  };
  return (
    <button className="icon-btn group-stop" disabled={disabled || stopping} onClick={stop} aria-label={stopping ? `Stopping @${member.handle}…` : `Stop @${member.handle}`} title={`Stop @${member.handle}`}>
      {stopping ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Square size={12} fill="currentColor" aria-hidden="true" />}
    </button>
  );
}

function GroupWorkingPanel({ room, members }: { room: Room; members: Member[] }) {
  const roomId = room.id;
  const data = useStore((s) => s.roomData[roomId]);
  const connected = useStore((s) => s.status === "open");
  const syncing = useStore((s) => s.syncing);
  const statusKnown = connected && !syncing && !!data?.loaded && !data.error;
  const [expanded, setExpanded] = useState(true);
  const [viewing, setViewing] = useState<string | null>(null);
  const contentId = useId();
  const active = members.filter((m) => ["thinking", "working", "approval", "queued"].includes(m.status));
  const turns = Object.values(data?.turns ?? {});
  const order = workOrder(room, members, turns);
  const work = active.map((member) => {
    const turn = currentTurn(member, turns);
    const streaming = data?.messages.findLast((m) => m.memberId === member.id && m.status === "streaming" && (!m.turnId || !data.turns[m.turnId] || ["running", "queued"].includes(data.turns[m.turnId].status)));
    const turnId = turn?.id ?? streaming?.turnId;
    const all = member.status === "queued" || !turnId ? [] : (data?.activities[turnId] ?? []);
    // Thinking is shown as its own live "thought" line; empty thinking steps (no summary streamed) are just a status.
    const thought = member.status === "thinking" ? all.findLast((a) => a.kind === "thinking" && a.status === "running" && a.detail.trim()) : undefined;
    const activities = all.filter((a) => a.kind !== "thinking" || a.detail.trim());
    const steps = activities.filter((a) => a.kind !== "thinking" && a.kind !== "plan");
    const running = activities.filter((a) => a.status === "running" && (a.kind !== "thinking" || member.status === "thinking"));
    const plan = activities.findLast((a) => a.kind === "plan");
    return { member, activities, steps, current: running[running.length - 1], plan, thought };
  });
  const selected = work.find((w) => w.member.id === viewing);

  if (!active.length && (statusKnown || !members.length)) return null;
  return (
    <section className="working-panel" aria-label={statusKnown ? "Live agent work" : "Agent status unknown"}>
      {!statusKnown && <p className="working-help" role="status" style={{ marginTop: 10 }}>{!connected ? "Reconnecting — agent status unknown." : data?.error ? "Conversation status unavailable. Retry loading the conversation." : "Syncing — agent status unknown."} {active.length ? "Showing the last reported progress." : "Waiting for current status from the hub."}</p>}
      {statusKnown && <div className="work-order" aria-label="Agent work order">
        <div className="work-order-title">{room.mode === "review" ? "Build & review" : "Work order"}{order.round ? ` · Round ${order.round}` : ""}{order.together ? " · Working together" : ""}</div>
        <ol className="work-order-steps">
          {order.steps.map(({ member, when, action }) => <li key={`${member.id}-${when}`}>
            <MemberAvatar member={member} size="sm" />
            <div><span className="work-order-when">{when}</span><strong>@{member.handle}</strong><span>{action}</span></div>
          </li>)}
        </ol>
        {order.note && <p className="work-order-note">{order.note}</p>}
      </div>}
      {active.length > 0 && <>
      <button className="working-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(!expanded)}>
        {statusKnown ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
        <span>Progress details <span className="muted">· {active.length} agent{active.length === 1 ? "" : "s"}</span></span>
        <ChevronDown size={16} className={expanded ? "expanded" : ""} aria-hidden="true" />
      </button>
      <div id={contentId} hidden={!expanded}>
        <p className="working-help">{statusKnown ? "Live status, plans and actions reported by your agents." : "Last reported plans and actions."}</p>
        <div className="working-members">
          {work.map(({ member, activities, steps, current, plan, thought }) => (
            <div className="working-member" key={member.id}>
              <div className="working-member-head">
                <MemberAvatar member={member} size="sm" showState={statusKnown} />
                <strong>@{member.handle}</strong>
                <span className="working-status" role="status">{statusKnown ? statusLabel(member) : `Status unknown · last reported: ${statusLabel(member)}`}</span>
              </div>
              {thought && <ThinkingSummary activity={thought} live={statusKnown} />}
              {plan?.detail && (
                <div className="working-plan">
                  <ListChecks size={15} aria-hidden="true" />
                  <pre>{plan.detail}</pre>
                </div>
              )}
              {steps.slice(-3).map((a) => <WorkStep key={a.id} activity={a} live={statusKnown} />)}
              {!activities.length && <p className="working-help">{!statusKnown ? "No progress was received before the connection was interrupted." : member.status === "queued" ? "Will start when an agent is free." : member.status === "approval" ? "Use Review approval to continue." : "Waiting for the agent's first progress update…"}</p>}
              {activities.length > 0 && (
                <button className="btn small ghost" onClick={() => setViewing(member.id)}>View steps ({activities.length}){current && statusKnown ? " · running" : ""}</button>
              )}
            </div>
          ))}
        </div>
      </div>
      </>}
      {viewing && (
        <Dialog title={selected ? `${statusKnown ? "Live" : "Last reported"} steps · @${selected.member.handle}` : "Agent steps"} onClose={() => setViewing(null)} footer={<button className="btn" onClick={() => setViewing(null)}>Done</button>}>
          {selected?.activities.length ? <ActivityBlock activities={selected.activities} live={statusKnown} statusUnknown={!statusKnown} thinking={selected.member.status === "thinking"} /> : <p role="status">{statusKnown ? "This agent is no longer reporting live work. Its steps remain in the conversation." : "Agent status is unknown until the hub reconnects and syncs."}</p>}
        </Dialog>
      )}
    </section>
  );
}

function ThinkingSummary({ activity, live }: { activity: Activity; live: boolean }) {
  const preview = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = preview.current;
    if (!el) return;
    const resize = new ResizeObserver(() => { el.scrollTop = el.scrollHeight; });
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = preview.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity.detail]);
  return (
    <div className={`working-thought ${live && activity.status === "running" ? "live" : ""}`} role="note" aria-label={live ? "Thinking summary" : "Last reported thinking summary"}>
      <Lightbulb size={15} aria-hidden="true" />
      <p ref={preview}>{lastWords(activity.detail)}</p>
    </div>
  );
}

/** The tail of a long thought, cut at a word boundary, so the newest reasoning stays visible. */
function lastWords(text: string, max = 280): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  return "…" + cut.slice(cut.indexOf(" ") + 1);
}

function WorkStep({ activity, live }: { activity: Activity; live: boolean }) {
  const Icon = activity.status === "running" ? live ? Loader2 : Info : activity.status === "error" ? CircleAlert : CheckCircle2;
  return (
    <div className={`working-step ${activity.status}`}>
      <Icon size={14} className={activity.status === "running" && live ? "spin" : undefined} aria-hidden="true" />
      <span>{activity.title}</span>
      <span className="working-step-status">{activity.status === "running" ? live ? "Running" : "Status unknown" : activity.status === "error" ? "Failed" : "Done"}</span>
    </div>
  );
}

/** The turn so far, oldest first: its thinking as text, and each command or tool call with what it ran. */
function ChatTrace({ activities, live }: { activities: Activity[]; live: boolean }) {
  // It drops in under the line you tapped; the steps that come in while it's open fade in (motion-chat.css).
  const entering = useEntrance();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = activities[activities.length - 1];
  // Steps whose long detail came shortened load whole while the trace is open.
  const loadActivity = useStore((s) => s.loadActivity);
  const partial = activities.filter((a) => a.detailLength !== undefined).map((a) => `${a.roomId}/${a.id}`).join(" ");
  useEffect(() => {
    for (const key of partial ? partial.split(" ") : []) {
      const [roomId, id] = key.split("/");
      void loadActivity(roomId, id).catch(() => {});
    }
  }, [partial, loadActivity]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [activities.length, last?.detail.length, last?.status]);
  // Its box getting smaller or larger (a fold, the keyboard) keeps it at the newest step if it was there.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activities.length > 0]);
  // One scope from the moment it opens, empty or not: what's there as it opens comes with it, and what comes later fades in.
  return (
    <div className={`chat-trace${entering ? " m-drop" : ""}`} ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      <EntranceScope>
        {activities.length ? activities.map((a) => <TraceItem key={a.id} a={a} live={live} />) : <p className="chat-trace-empty">Nothing yet. Steps show up here as it works.</p>}
      </EntranceScope>
    </div>
  );
}

/** One part of the trace: a thought, a plan, or a step with what it ran. One that came in while it was open fades in. */
function TraceItem({ a, live }: { a: Activity; live: boolean }) {
  const fresh = useEntrance() ? " m-fresh" : "";
  if (a.kind === "thinking") return <p className={`trace-thought${fresh}`}>{a.detail.trim()}{a.detailLength !== undefined && "…"}</p>;
  if (a.kind === "plan") return <pre className={`trace-plan${fresh}`}>{a.detail}</pre>;
  const Icon = a.status === "running" ? (live ? Loader2 : Info) : a.status === "error" ? CircleAlert : CheckCircle2;
  const label = stepLabel(a);
  const shown = a.kind === "command" ? a.title : label === a.title ? "" : a.title;
  const output = a.kind === "command" ? a.detail.replace(/^# .+\n?/, "").replace(a.title, "").trim() : a.kind === "tool" ? a.detail.trim() : "";
  return (
    <div className={`trace-step ${a.status}${fresh}`}>
      <div className="trace-step-head">
        <Icon size={14} className={a.status === "running" && live ? "spin" : undefined} aria-hidden="true" />
        <span>{label}</span>
      </div>
      {shown && <code className="trace-cmd">{shown}</code>}
      {output && <pre className="trace-out">{output.length > 1200 ? output.slice(0, 1200) + "\n…" : output}</pre>}
    </div>
  );
}

const KIND: Record<string, string> = { local_agent: "Helper agent", remote_agent: "Cloud agent", local_workflow: "Workflow", workflow: "Workflow", local_bash: "Command", dream: "Memory" };
const RECENT_MS = 15 * 60_000;

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** "claude-opus-5-5" -> "Opus 5.5"; other names as they are. */
function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/i.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

const EFFORT_WORD: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max", ultra: "Ultra" };

/** The helpers an agent summoned and the workflows it runs (model, effort, context, what each is doing), then its background commands. */
function HelpersPanel({ member }: { member: Member }) {
  const all = useStore((s) => s.tasks[member.id]);
  // Open while a helper works, folded once they're all done, until you tap it: then it stays as you left it.
  const [chosen, setOpen] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [, tick] = useState(0);
  const recent = (all ?? []).filter((t) => t.status === "running" || Date.now() - (t.endedAt ?? 0) < RECENT_MS);
  // Commands only count when they run in the background: a foreground one is the reply's own step.
  const helpers = recent.filter((t) => t.kind !== "local_bash");
  const commands = recent.filter((t) => t.kind === "local_bash" && t.background);
  const running = helpers.filter((t) => t.status === "running");
  const runningCommands = commands.filter((t) => t.status === "running");
  const open = chosen ?? running.length > 0;
  const live = recent.some(helperAtWork);
  // Every second while something runs; otherwise now and then, so finished helpers still go after 15 minutes.
  useInterval(() => (helpers.length > 0 || commands.length > 0) && tick((n) => n + 1), live ? 1000 : 30_000);
  if (!helpers.length && !runningCommands.length) return null;
  const done = helpers.length - running.length;
  const parts = [
    running.length ? `${running.length} helper${running.length === 1 ? "" : "s"} working` : helpers.length ? `${done} helper${done === 1 ? "" : "s"} finished` : null,
    running.length && done ? `${done} done` : null,
    runningCommands.length ? `${runningCommands.length} background command${runningCommands.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const order = (list: BackgroundTask[]) => [...list.filter((t) => t.status === "running"), ...list.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))];
  // It drops in when the first helper starts on a chat that's up; its list drops in as it opens, and a helper that starts
  // while it's open fades in (motion-chat.css).
  return (
    <Arrive>
      {(entering) => (
        <section className={`helpers${entering ? " m-drop" : ""}`} aria-label="Helpers">
          <button className="helpers-head" onClick={() => setOpen(!open)} aria-expanded={open}>
            <Bot size={15} aria-hidden="true" />
            <span className="helpers-title">{parts.join(" · ")}</span>
            <ChevronDown size={15} className={`chat-status-chevron ${open ? "expanded" : ""}`} aria-hidden="true" />
          </button>
          {open && (
            <Arrive>
              {(opening) => (
                <ul className={`helpers-list${opening ? " m-drop" : ""}`}>
                  <EntranceScope>
                    {order(helpers).map((t) => (
                      <HelperRow key={t.id} task={t} expanded={expanded === t.id} onToggle={() => setExpanded(expanded === t.id ? null : t.id)} />
                    ))}
                    {commands.length > 0 && <li className="helpers-sub">Background commands</li>}
                    {order(commands).map((t) => (
                      <CommandRow key={t.id} task={t} />
                    ))}
                  </EntranceScope>
                </ul>
              )}
            </Arrive>
          )}
        </section>
      )}
    </Arrive>
  );
}

function HelperRow({ task: t, expanded, onToggle }: { task: BackgroundTask; expanded: boolean; onToggle: () => void }) {
  const fresh = useEntrance() ? " m-fresh" : "";
  const live = t.status === "running";
  const Icon = live ? Loader2 : t.status === "completed" ? CheckCircle2 : CircleX;
  const role = t.workflow ?? (t.agentType && t.agentType !== "general-purpose" ? t.agentType : KIND[t.kind] ?? t.kind.replace(/_/g, " "));
  const meta = [
    elapsed((t.endedAt ?? Date.now()) - t.startedAt),
    t.toolUses ? `${t.toolUses} step${t.toolUses === 1 ? "" : "s"}` : null,
    live ? null : t.status === "completed" ? "done" : t.status,
  ].filter(Boolean).join(" · ");
  const pct = t.contextTokens && t.contextWindow ? Math.min(100, (t.contextTokens / t.contextWindow) * 100) : null;
  const now = live ? [t.lastTool ? `Using ${t.lastTool}` : null, t.summary].filter(Boolean).join(": ") : t.error ?? t.summary;
  return (
    <li className={`helper ${t.status}${fresh}`}>
      <button className="helper-main" onClick={onToggle} aria-expanded={expanded}>
        <Icon size={15} className={live ? "spin" : undefined} aria-hidden="true" />
        <span className="helper-text">
          <span className="helper-name">{t.description}</span>
          <span className="helper-chips">
            <span className="hchip">{role}</span>
            {t.model && <span className="hchip model">{modelLabel(t.model)}</span>}
            {t.effort && <span className="hchip effort">{EFFORT_WORD[t.effort] ?? t.effort}</span>}
            <span className="helper-meta">{meta}</span>
          </span>
          {t.contextTokens ? (
            <span className="helper-ctx" title={t.contextWindow ? `${t.contextTokens.toLocaleString()} of ${t.contextWindow.toLocaleString()} tokens` : undefined}>
              <span className="helper-ctx-label">Context {compact(t.contextTokens)}{t.contextWindow ? ` of ${compact(t.contextWindow)}` : ""}</span>
              {pct !== null && (
                <span className={`helper-ctx-bar ${pct >= 90 ? "full" : pct >= 70 ? "warn" : ""}`} aria-hidden="true">
                  <i style={{ width: `${Math.max(2, pct)}%` }} />
                </span>
              )}
            </span>
          ) : t.tokens ? (
            <span className="helper-ctx-label">{compact(t.tokens)} tokens used</span>
          ) : null}
          {now && <span className={`helper-now ${expanded ? "full" : ""}`}>{now}</span>}
        </span>
      </button>
    </li>
  );
}

function CommandRow({ task: t }: { task: BackgroundTask }) {
  const fresh = useEntrance() ? " m-fresh" : "";
  const live = t.status === "running";
  const Icon = live ? Loader2 : t.status === "completed" ? CheckCircle2 : CircleX;
  return (
    <li className={`helper command ${t.status}${fresh}`}>
      <div className="helper-main">
        <Icon size={13} className={live ? "spin" : undefined} aria-hidden="true" />
        <span className="helper-text">
          <span className="helper-name">{t.description}</span>
        </span>
        <span className="helper-meta">{elapsed((t.endedAt ?? Date.now()) - t.startedAt)}{live ? "" : " · done"}</span>
      </div>
    </li>
  );
}
