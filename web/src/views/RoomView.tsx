import { teamworkLabel } from "../teamwork";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, ChevronLeft, Copy, Settings, Users } from "lucide-react";
import { PROVIDER_INFO, limitWaitWords, type Activity, type Approval, type Member, type Message, type Room, type SignInNeed, type Turn } from "@crosstalk/shared";
import { pendingApprovals, selectRoomMembers, useMachines, useStore } from "../store";
import { Dialog, MemberAvatar, Markdown, ProviderAvatar, RoomFilesContext, copyText, thisDevice, timeShort, useIsMobile } from "../ui";
import { ActivityBlock } from "./ActivityBlock";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { AgentsPanel } from "./AgentsPanel";
import { RoomSettingsDialog } from "./RoomSettingsDialog";
import { SidebarButton } from "./ChatSidebar";
import { JumpToLatest, useLatest } from "./JumpToLatest";
import { NoteText } from "./NoteText";
import { placeOf, restorePlace, sizeKey, type Place } from "../scrollPlace";
import { answerText } from "../answers";
import { EntranceScope, useEntrance, useQuietSince } from "../motion";
import { chatPromptLine, isStaleSignInNote } from "../signIn";
import { ReplyNote, SignInPrompt, chatRetryOrBox } from "./SignIn";

export function RoomView({ room }: { room: Room }) {
  const mobile = useIsMobile();
  const data = useStore((s) => s.roomData[room.id]);
  const connectionReady = useStore((s) => s.status === "open" && !s.syncing);
  const statusKnown = connectionReady && !!data?.loaded && !data.error;
  const members = useStore(useShallow(selectRoomMembers(room.id)));
  const approvals = useStore(useShallow((s) => pendingApprovals(s, room.id)));
  const allApprovals = useStore(useShallow((s) => Object.values(s.approvals).filter((a) => a.roomId === room.id)));
  const loadHistory = useStore((s) => s.loadHistory);
  const openRoom = useStore((s) => s.openRoom);
  const showAgents = useStore((s) => s.showAgents);
  const setShowAgents = useStore((s) => s.setShowAgents);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    if (connectionReady && !data?.loaded && !data?.loading && !data?.error) void loadHistory(room.id);
  }, [room.id, data?.loaded, data?.loading, data?.error, connectionReady, loadHistory]);

  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Its size when last looked at and the message at its top (scrollPlace.ts): a change of size moves it, not you.
  const lastSize = useRef("");
  const place = useRef<Place | null>(null);
  const messages = data?.messages ?? [];
  const latest = useLatest(messages);
  /** After a change of size: at the newest message if it was there, else the same message at the top. */
  const keptPlace = (el: HTMLDivElement) => {
    const size = sizeKey(el);
    if (size === lastSize.current) return false;
    lastSize.current = size;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else {
      restorePlace(el, place.current);
      // Bigger now, it may all fit: then there's nothing newer to jump to.
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }
    latest.scrolled(!stick.current);
    return true;
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (!keptPlace(el)) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    place.current = placeOf(el, inner.current);
    latest.scrolled(!stick.current);
  };
  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    latest.scrolled(false);
  };
  const lastText = messages.length ? messages[messages.length - 1].text.length : 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastText, approvals.length, room.id]);
  useEffect(() => {
    stick.current = true;
  }, [room.id]);
  // Another room starts at its newest message: no Jump to latest left over from the last one, not even for a frame.
  useLayoutEffect(() => latest.scrolled(false), [room.id, latest.scrolled]);
  // Content can grow after render (markdown, activity, fonts); keep pinned to the bottom when we were there, and the
  // place when the chat itself changes size.
  useEffect(() => {
    const el = inner.current;
    const sc = scroller.current;
    if (!el || !sc) return;
    lastSize.current = sizeKey(sc);
    const ro = new ResizeObserver(() => {
      if (keptPlace(sc)) return;
      if (stick.current) sc.scrollTop = sc.scrollHeight;
    });
    ro.observe(el);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [room.id]);

  // The same list while the handles are the same: an agent's status changing mustn't redraw (and format again) every reply.
  const handleKey = members.map((m) => m.handle).join(" ");
  const handles = useMemo(() => (handleKey ? handleKey.split(" ") : []), [handleKey]);
  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
  const approvalsByTurn = useMemo(() => {
    const out: Record<string, Approval[]> = {};
    for (const a of allApprovals) if (a.turnId) (out[a.turnId] ??= []).push(a);
    return out;
  }, [allApprovals]);
  const modeLabel = teamworkLabel(room.mode);
  const defaultAgent = members.find((m) => m.id === room.leadMemberId) ?? members[0];
  const reviewer = members.find((m) => m.id !== defaultAgent?.id);
  const teamworkSummary = !defaultAgent ? "no agents yet" : room.mode === "review"
    ? `@${defaultAgent.handle} builds${reviewer ? ` · @${reviewer.handle} reviews` : " · add a reviewer"}`
    : `Default: @${defaultAgent.handle}`;
  const busy = statusKnown && members.some((m) => ["thinking", "working", "queued", "approval"].includes(m.status));
  const working = statusKnown ? members.filter((m) => ["thinking", "working", "approval"].includes(m.status)) : [];
  const queued = statusKnown ? members.filter((m) => m.status === "queued") : [];
  const unshownFailures = Object.values(data?.turns ?? {}).filter((turn) => turn.status === "error" && !turn.replyMessageId && !messages.some((m) => m.turnId === turn.id));
  const quietSince = useQuietSince(!data?.loaded || !!data?.loading || !connectionReady);

  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        {mobile ? (
          <button className="icon-btn" onClick={() => openRoom(null)} aria-label="Back to rooms">
            <ChevronLeft size={22} />
          </button>
        ) : (
          // With the sidebar hidden on a computer, this is the only way back to the other chats.
          <SidebarButton />
        )}
        <div className="titles">
          <h1>{room.name}</h1>
          <div className="sub">
            {modeLabel} · {teamworkSummary}
          </div>
        </div>
        <div className="actions">
          {/* Team opens as a dialog on every screen size: wide screens no longer show it beside the chat. */}
          <button className={`btn small ${showAgents ? "primary" : ""}`} onClick={() => setShowAgents(!showAgents)} aria-label="Team and permissions" title="Team and permissions">
            <Users size={16} />
            Team
            {approvals.length > 0 && <span className="count">{approvals.length}</span>}
          </button>
          <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Room settings" title="Room settings">
            <Settings size={18} />
          </button>
        </div>
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll}>
        <RoomFilesContext.Provider value={room.id}>
        <EntranceScope since={quietSince}>
        <div className="inner" ref={inner}>
          {data?.hasMore && (
            <button className="btn small ghost" style={{ alignSelf: "center", margin: "4px 0 10px" }} onClick={() => loadHistory(room.id, true)}>
              {data.loading ? "Loading…" : "Load earlier messages"}
            </button>
          )}
          {data?.error && <div role="alert" className="small" style={{ padding: 12, overflowWrap: "anywhere" }}>
            <p>Couldn't load the conversation. {data.error}</p>
            <button className="btn small" disabled={data.loading || !connectionReady} onClick={() => loadHistory(room.id)}>{data.loading ? "Retrying…" : "Retry loading conversation"}</button>
          </div>}
          {!data?.loaded && !data?.error && <div className="muted small" style={{ textAlign: "center", padding: 30 }}>Loading…</div>}
          {data?.loaded && messages.length === 0 && unshownFailures.length === 0 && <EmptyRoom room={room} members={members} />}
          {messages.map((m, i) => {
            const row = (
              <MessageRow
                key={m.id}
                message={m}
                prev={messages[i - 1]}
                member={m.memberId ? memberById[m.memberId] : undefined}
                handles={handles}
                activities={m.turnId ? data?.activities[m.turnId] : undefined}
                approvals={m.turnId ? approvalsByTurn[m.turnId] : undefined}
                turn={m.turnId ? data?.turns[m.turnId] : undefined}
                statusKnown={statusKnown}
              />
            );
            return m.authorKind === "agent" ? <GroupReply key={m.id} message={m}>{row}</GroupReply> : row;
          })}
          {unshownFailures.map((turn) => <div className="msg agent error" key={turn.id}>
            <div className="body">
              <div className="head"><span className="who">@{memberById[turn.memberId]?.handle ?? "agent"}</span><span className="pill red">error</span></div>
              <TurnError error={turn.error} />
              {!!data?.activities[turn.id]?.length && <ActivityBlock activities={data.activities[turn.id]} live={false} />}
            </div>
          </div>)}
          {approvals
            .filter((a) => !a.turnId || !messages.some((m) => m.turnId === a.turnId))
            .map((a) => (
              <CardArrival key={a.id}>
                <ApprovalCard approval={a} member={memberById[a.memberId]} />
              </CardArrival>
            ))}
        </div>
        </EntranceScope>
        </RoomFilesContext.Provider>
        {latest.away && <JumpToLatest unseen={latest.unseen} grew={latest.grew} onClick={jumpToLatest} />}
      </div>

      <Composer key={room.id} room={room} members={members} busy={busy} working={working} queued={queued} onRoomSettings={() => setSettings(true)} />
      {showAgents && <Dialog title="Team & permissions" onClose={() => setShowAgents(false)}><AgentsPanel roomId={room.id} /></Dialog>}
      {settings && <RoomSettingsDialog room={room} members={members} onClose={() => setSettings(false)} />}
    </>
  );
}

/** An agent's reply in a group room, with Copy under it once it's written (hover on a computer, tap on a phone). */
function GroupReply({ message: m, children }: { message: Message; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const canCopy = !!m.text.trim() && m.status !== "streaming";
  const toggle = (e: React.MouseEvent) => {
    if (!canCopy || (e.target as HTMLElement).closest("a, button, input, textarea, select, summary, [role=button]")) return;
    setOpen((o) => !o);
  };
  return (
    <div className={`your-msg agent-reply ${open ? "open" : ""}`} onClick={toggle}>
      {children}
      {canCopy && (
        <div className="msg-actions agent-actions" onClick={(e) => e.stopPropagation()}>
          <CopyReply text={m.text} />
        </div>
      )}
    </div>
  );
}

/**
 * Copies a whole reply as the agent wrote it (Markdown), and says so for a moment. `icon`: the small one in a reply's
 * header, next to its time, so a long reply can be copied from its top. `label`: what it copies, for screen readers.
 */
export function CopyReply({ text, icon = false, label = "Copy reply" }: { text: string; icon?: boolean; label?: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(text);
    setCopied(ok ? "yes" : "no");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1800);
  };
  if (icon) {
    // Pressing it doesn't focus it: focus inside a reply opens its actions row, which moves the chat (it follows the
    // newest line) under the finger before the tap ends.
    return (
      <button className={`head-copy ${copied ?? ""}`} onMouseDown={(e) => e.preventDefault()} onClick={copy} aria-label={copied === "yes" ? "Copied" : copied === "no" ? "Couldn't copy" : "Copy the whole reply"} title="Copy the whole reply (as Markdown)">
        {copied === "yes" ? <Check size={13} /> : <Copy size={13} />}
      </button>
    );
  }
  return (
    <button className="link-action" onClick={copy} aria-label={copied ? undefined : label} title={label === "Copy reply" ? "Copy the whole reply (as Markdown)" : label}>
      {copied === "yes" ? <Check size={12} /> : <Copy size={12} />} {copied === "yes" ? "Copied" : copied === "no" ? "Couldn't copy" : "Copy"}
    </button>
  );
}

function EmptyRoom({ room, members }: { room: Room; members: Member[] }) {
  const setShowAgents = useStore((s) => s.setShowAgents);
  return (
    <div className="empty" style={{ minHeight: 280 }}>
      <div>
        <div className="big">{members.length ? "Say hello to your team" : "Add agents to this room"}</div>
        <p className="muted small" style={{ maxWidth: 440, margin: "6px auto 14px" }}>
          {members.length
            ? room.mode === "review"
              ? "Type a task below. Your default agent builds, then another agent reviews."
              : "Type a task below. Your default agent handles it; mention another agent to choose who answers."
            : "Open Team and add Claude Code, Codex, Muse or any agent you've set up."}
        </p>
        {!members.length && (
          <button className="btn primary" onClick={() => setShowAgents(true)}>
            Add an agent
          </button>
        )}
        <p className="tiny muted" style={{ marginTop: 14 }}>
          Folder: <span className="mono">{room.cwd}</span>
        </p>
      </div>
    </div>
  );
}

export const MessageRow = memo(function MessageRow({
  message: m,
  prev,
  member,
  handles,
  activities,
  approvals,
  turn,
  statusKnown,
  retried = false,
  announce = true,
  arrive = false,
  signIn,
}: {
  message: Message;
  prev?: Message;
  member?: Member;
  handles: string[];
  activities?: Activity[];
  approvals?: Approval[];
  turn?: Turn;
  statusKnown: boolean;
  /** A failed reply whose request a later reply answered (Try again): a grey note, not a red error. */
  retried?: boolean;
  /** Whether its failure is news (it happened while the chat was open): only then is it announced (see `TurnError`). */
  announce?: boolean;
  /** It arrived while you followed the chat (ChatScreen): yours settles in, a reply's avatar pops (motion-chat.css). */
  arrive?: boolean;
  /**
   * A failed reply that an agent account found signed out explains (ChatScreen: the newest one, while it's signed out):
   * "Sign in to Claude Code on Mac mini" with its button stands in place of the error, which only said to go to Settings.
   */
  signIn?: SignInNeed;
}) {
  const arriving = arrive ? " m-arrive" : "";
  if (m.authorKind === "system") {
    return (
      <div className={`msg system${arriving}`}>
        <div className="sys">{m.copy?.chatId ? <CopyLine message={m} /> : <NoteText text={m.text} />}</div>
      </div>
    );
  }
  // The same author again within 5 minutes: grouped under the first. Not after a reply that failed or was stopped: what
  // comes next (Try again's answer, say) is an answer of its own.
  const cont = prev && prev.authorKind === m.authorKind && prev.memberId === m.memberId && prev.authorName === m.authorName && m.createdAt - prev.createdAt < 5 * 60_000 && !(prev.authorKind === "agent" && (prev.status === "error" || prev.status === "stopped"));
  if (m.authorKind === "human") {
    return (
      <div className={`msg human ${cont ? "cont" : ""}${arriving}`} data-mid={m.id}>
        <div className="body">
          {!cont && (
            <div className="head">
              <span className="time">{timeShort(m.createdAt)}</span>
              <span className="vendor">{m.authorName}</span>
            </div>
          )}
          <div className="bubble">
            <Markdown text={shownText(m.text)} handles={handles} />
          </div>
        </div>
      </div>
    );
  }
  // A reply a duplicated chat copied from a chat with another agent: shown as that agent's.
  const copied = m.copy?.kind === "reply" ? m.copy : null;
  const info = copied?.provider ? PROVIDER_INFO[copied.provider] : member ? PROVIDER_INFO[member.provider] : null;
  // A terminal turn event can arrive before the final message event. "waiting": a usage limit stopped the reply and the
  // chat carries on by itself once it resets (the row below it says when) — calm, not an error.
  const waiting = turn?.status === "waiting";
  const status = turn && ["done", "error", "stopped"].includes(turn.status) ? turn.status : waiting ? "waiting" : m.status;
  // Crosstalk's own waiting line (the whole reply when the agent wrote nothing: the hub words it the same way) is said
  // again here, in this device's clock. The hub's wording is what older apps and the notification show.
  const text = waiting && turn.wait && m.text === turn.error ? limitWaitWords(turn.wait) : m.text;
  const streaming = status === "streaming" && statusKnown;
  const unknown = status === "streaming" && !statusKnown;
  const failed = status === "error";
  const quiet = failed && retried;
  // The hub started the agent again because its sign-in had gone stale (signIn.ts): said with the reply, not folded
  // away with its steps.
  const notes = activities?.filter(isStaleSignInNote) ?? [];
  const steps = notes.length ? activities!.filter((a) => !isStaleSignInNote(a)) : activities;
  // Signed out: the way to sign in, instead of the error. A reply that is nothing but the error ("⚠️ …") shows only it.
  const signInCard = failed && signIn ? <SignInPrompt variant="reply" who={signIn} machine={signIn.machine.name} line={chatPromptLine(signIn, { stopped: true, device: thisDevice() })} stopped announce={announce && !quiet} focusAfter={chatRetryOrBox} /> : null;
  const onlyError = !!signInCard && !!turn?.error && text.replace(/^⚠️\s*/, "").trim() === turn.error.trim();
  return (
    <div className={`msg agent ${cont ? "cont" : ""} ${quiet ? "retried" : status}${arriving}`} data-mid={m.id}>
      {cont ? <div style={{ width: 32, flex: "none" }} /> : copied?.provider ? <ProviderAvatar provider={copied.provider} label={copied.agent} /> : member ? <MemberAvatar member={member} /> : <div className="avatar">?</div>}
      <div className="body">
        {!cont || failed || status === "stopped" || waiting ? (
          <div className="head">
            <span className="who">@{member?.handle ?? m.authorName}</span>
            {copied ? <span className="vendor">{copied.agent}</span> : info && <span className="vendor">{info.name}</span>}
            <span className="time">{timeShort(m.createdAt)}</span>
            {!!text.trim() && status !== "streaming" && !quiet && <CopyReply text={text} icon />}
            {status === "stopped" && <span className="pill">stopped</span>}
            {waiting && <span className="pill">waiting</span>}
            {quiet ? <span className="pill">tried again</span> : failed && <span className="pill red">error</span>}
          </div>
        ) : (
          // Grouped under the reply before it: just its time, and Copy once it's written, so a long one is copied from
          // its top too. Shown from its first words, so the reply doesn't move when it ends.
          !!m.text.trim() && (
            <div className="head cont-head">
              <span className="time">{timeShort(m.createdAt)}</span>
              {status !== "streaming" && <CopyReply text={m.text} icon />}
            </div>
          )
        )}
        {notes.map((a) => (
          <ReplyNote key={a.id} activity={a} live={streaming} />
        ))}
        {/* A reply that only asked a question has nothing to say above its card. */}
        {!onlyError && (text || (!failed && (!streaming || !steps?.length) && !(status === "done" && approvals?.some((a) => a.kind === "question")))) && (
          <div className="bubble">
            {text ? (
              <div className={streaming ? "cursor" : ""}>
                <Markdown text={text} handles={handles} streaming={streaming} />
              </div>
            ) : streaming ? (
              <span className="typing" aria-label="typing">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <span className="muted small">{unknown ? "Reply status unknown until the conversation syncs." : waiting ? "Waiting for the usage limit to reset." : status === "stopped" ? "Stopped before replying." : "(no reply)"}</span>
            )}
          </div>
        )}
        {/* The reply's own text is often the error already ("⚠️ …"): don't show it twice. */}
        {signInCard ?? (failed && !(turn?.error && text.includes(turn.error.trim())) && <TurnError error={turn?.error} quiet={quiet} announce={announce} />)}
        {unknown && text && <p className="muted small" role="status">Reply status unknown until the conversation syncs.</p>}
        {steps && steps.length > 0 && <ActivityBlock activities={steps} live={streaming} statusUnknown={unknown} thinking={member?.status === "thinking"} />}
        {approvals?.map((a) => (
          <CardArrival key={a.id}>
            <ApprovalCard approval={a} member={member} />
          </CardArrival>
        ))}
      </div>
    </div>
  );
});

/**
 * A card that came in while the chat was up (a request, a question) drops a touch into place as it fades in, at its full
 * size (motion-chat.css `.m-drop`), wrapped so the card's own classes are free to change meanwhile. One drawn with the
 * chat, or with its history, is drawn as it is.
 */
export function CardArrival({ children }: { children: ReactNode }) {
  return useEntrance() ? <div className="m-drop">{children}</div> : <>{children}</>;
}

/**
 * A duplicated chat's line: where it was copied from (at the top of the copy) or where it was duplicated to (in the
 * original), with that chat's name linking to it while this device can open it.
 */
function CopyLine({ message: m }: { message: Message }) {
  const c = m.copy!;
  const known = useMachines((ms) => ms.list.some((x) => !!x.rooms[c.chatId!]));
  const where = c.machine ? ` on ${c.machine}` : "";
  const said = c.kind === "from" ? `Copied from "${c.chatName}" (${c.agent})${where}` : `Duplicated to "${c.chatName}"${where}`;
  // Anything the hub added after the usual words (say, messages that stayed behind).
  const rest = m.text.startsWith(said) ? m.text.slice(said.length) : "";
  const name = known ? (
    <>
      "
      <a className="copy-link" href={`#/room/${c.chatId}`} title="Open that chat">
        {c.chatName}
      </a>
      "
    </>
  ) : (
    <>"{c.chatName}"</>
  );
  return c.kind === "from" ? (
    <>
      Copied from {name} ({c.agent}){where}
      {rest}
    </>
  ) : (
    <>
      Duplicated to {name}
      {where}
      {rest}
    </>
  );
}

/** One of your messages as it shows (and copies): its attachments without the hub's local paths the agent reads. */
export function shownText(text: string): string {
  const answered = answerText(text);
  if (answered !== null) return answered;
  return text
    .replace(/^Attachments \(open these local files only if needed\):$/m, "Attachments:")
    .replace(/(^- \[[^\n]+\]\(\/api\/rooms\/[^/]+\/uploads\/[^)]+\)) — local path: .*$/gm, "$1")
    .replace(/^(- Folder [^\n]+? \(\d+ files?\)) — local path: .*$/gm, "$1")
    .replace(/(^- \[[^\n]+\]\(\/api\/rooms\/[^/]+\/folders\/[^)]+\) \(\d+ files?\)) — local path: .*$/gm, "$1");
}

/**
 * A reply's error. `quiet`: a later try answered its request, so it's a note now, not an alert. `announce`: the failure
 * is news — it happened while the chat was open — so a screen reader is told at once (an alert). One that was already in
 * the history is read in its place like the rest of the chat: opening a chat puts its whole history on the page at
 * once, and every old failure in it would otherwise interrupt, one after another.
 */
export function TurnError({ error, quiet = false, announce = true }: { error?: string | null; quiet?: boolean; announce?: boolean }) {
  // Hub errors name commands as `code` (say, the step a frozen agent was stuck on).
  const text = error?.trim() || "The agent couldn't complete this turn.";
  return <div className="bubble" role={quiet ? "note" : announce ? "alert" : undefined} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</div>;
}
