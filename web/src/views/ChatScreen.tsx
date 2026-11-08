import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeftRight, Clock, Copy, FastForward, History, Pencil, RotateCcw, SlidersHorizontal, Square, Trash2, Undo2, X } from "lucide-react";
import { EFFORT_LABELS, PROVIDER_INFO, helperAtWork, isNoReadNowAgent, isNoRewindAgent, isServiceKeyRefusal, isServiceOnlyAgent, turnOrder, type AlwaysAllowed, type Approval, type ChatProvider, type Member, type Message, type Room, type SignInNeed, type Turn } from "@crosstalk/shared";
import { olderThan } from "../version";
import { api } from "../api";
import { memberAccount } from "../accounts";
import { chatIdentity, identityWhere } from "../chatIdentity";
import { nameEdit } from "../chatName";
import { deleteRoomHere, machineName, pendingApprovals, selectRoomMembers, useMachines, usesApiKey, useStore } from "../store";
import { machineTag } from "../chatList";
import { countdownTickMs, limitWaitLine } from "../limitWait";
import { STOP_FAILED, stopChat, useStopping } from "../stop";
import { ApiBadge, ChatAvatar, Dialog, Markdown, ProviderAvatar, RoomFilesContext, Switch, thisDevice, timeShort, useInterval } from "../ui";
import { elapsed } from "./WorkingPanel";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { CardArrival, CopyReply, MessageRow, TurnError, shownText } from "./RoomView";
import { RaiseLimit } from "./ChatCost";
import { OpenAiServices } from "./ServiceKey";
import { answerText } from "../answers";
import { JumpToLatest, useLatest } from "./JumpToLatest";
import { placeOf, restorePlace, sizeKey, type Place } from "../scrollPlace";
import { AgentOptions, cleanChoice, type AgentChoice } from "./AgentOptions";
import { isPinned, pinChat, pinFailed } from "../pins";
import { SidebarButton } from "./ChatSidebar";
import { DuplicateDialog } from "./DuplicateDialog";
import { AskCards } from "./AskCards";
import { AskOthersButton } from "./AskSheet";
import { ExportMarkdownButton } from "./ExportMarkdownButton";
import { BookmarkButton } from "./BookmarkButton";
import { useFindMessage } from "./useFindMessage";
import { TwoStepDialog } from "./TwoStepDialog";
import { GroupAvatar, groupState } from "./GroupAvatar";
import { GroupSettingsDialog } from "./GroupSettings";
import { groupNames, notAnswered, notAnsweredLine, retriedTurns, whoAnswers, answersLine } from "../groupChat";
import { onlyFinishingHelpers, quietWait, quietWaitWords } from "../sendNow";
import { EntranceScope, SETTLE_MS, useEntrance, useQuietSince } from "../motion";
import { chatNeeds, chatPromptLine } from "../signIn";
import { SignInPrompt, chatRetryOrBox } from "./SignIn";

const ORIGIN: Record<string, string> = { "claude-app": "the Claude app", "claude-cli": "the claude command", "codex-app": "the Codex app" };

const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** A chat whose history didn't load tries again by itself this long after each failure, then every 30 s while visible. */
const RELOAD_AFTER_MS = [2_000, 5_000, 15_000];
const RELOAD_EVERY_MS = 30_000;
/** Scrolled to within this of the bottom, the chat follows what's new again. */
const PIN_WITHIN_PX = 24;
/** A message that arrived while you followed keeps its entrance this long: drawn again later (say after editing it), it's still. */
const ARRIVED_MS = 1000;
/** At most this many new messages at once are arrivals; more is a batch (a catch-up), drawn as it is. */
const ARRIVALS_AT_ONCE = 3;
/**
 * Nothing in a message of yours to tap (no link, file, picture or code block with its Copy): only then does it settle in
 * by scale. Anything you can tap is never smaller while it comes in (motion-chat.css).
 */
const nothingToTap = (text: string) => !/\]\(|```|https?:\/\/|www\./.test(text);
const BUSY = ["thinking", "working", "queued", "approval"];

/**
 * The machine this chat is on, when this device has more than one ("Linux box"); null with just one. The chat on
 * screen is always on the active machine.
 */
function useChatMachine(): string | null {
  const several = useMachines((m) => m.list.length > 1);
  const name = useStore((s) => (s.conn ? machineName(s.conn, s.hub) : null));
  return several ? name : null;
}

/** A machine's short tag, as the chat list shows it ("Linux" for "Linux box"). */
function useMachineTag(name: string | null): string | null {
  const names = useMachines(useShallow((m) => m.list.map((x) => x.name)));
  return name ? machineTag(name, names) : null;
}

/** A chat: with one agent, or a group chat with several (who answers is its choice, or who a message @mentions). */
export function ChatScreen({ room }: { room: Room }) {
  const data = useStore((s) => s.roomData[room.id]);
  const connected = useStore((s) => s.status === "open");
  const connectionReady = useStore((s) => s.status === "open" && !s.syncing);
  const statusKnown = connectionReady && !!data?.loaded && !data.error;
  const members = useStore(useShallow(selectRoomMembers(room.id)));
  const group = !!room.chat?.group;
  // A group chat's lead stands for it where one agent is meant (its copy, what's always allowed).
  const member = (group ? turnOrder(room, members)[0] : members[0]) as Member | undefined;
  const approvals = useStore(useShallow((s) => pendingApprovals(s, room.id)));
  const allApprovals = useStore(useShallow((s) => Object.values(s.approvals).filter((a) => a.roomId === room.id)));
  // Its agents' accounts found signed out on this machine (signIn.ts): each says so here, with Sign in.
  const signIns = useStore(useShallow((s) => chatNeeds(s.signIns, members)));
  const loadHistory = useStore((s) => s.loadHistory);
  const [settings, setSettings] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const api = useStore(usesApiKey(room.id));
  const provider = (room.chat?.provider ?? member?.provider ?? "claude") as ChatProvider;
  const info = PROVIDER_INFO[provider];
  // What this chat is: an AI service of yours and its model, or the agent itself (chatIdentity.ts). A group chat is its
  // agents, who are named one by one.
  const accounts = useStore((s) => s.accounts);
  const poolOffer = useStore((s) => s.poolOffer);
  const identity = chatIdentity(room, group ? undefined : member, accounts, poolOffer);
  const machine = useChatMachine();
  const machineShort = useMachineTag(machine);

  useEffect(() => {
    if (connectionReady && !data?.loaded && !data?.loading && !data?.error) void loadHistory(room.id);
  }, [room.id, data?.loaded, data?.loading, data?.error, connectionReady, loadHistory]);
  // History that didn't load is tried again by itself while the chat is open: after 2 s, 5 s and 15 s, then every 30 s
  // while the app is on screen (the status line says so meanwhile, with Retry).
  const reloads = useRef(0);
  useEffect(() => {
    reloads.current = 0;
  }, [room.id]);
  useEffect(() => {
    if (data?.loaded && !data.error) reloads.current = 0;
  }, [data?.loaded, data?.error]);
  useEffect(() => {
    if (!data?.error || data.loading || !connectionReady) return;
    let timer: ReturnType<typeof setTimeout>;
    const n = reloads.current;
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        // After the first few, only while it's being looked at.
        if (n >= RELOAD_AFTER_MS.length && document.visibilityState !== "visible") return arm(RELOAD_EVERY_MS);
        reloads.current = n + 1;
        void loadHistory(room.id);
      }, ms);
    };
    arm(RELOAD_AFTER_MS[n] ?? RELOAD_EVERY_MS);
    return () => clearTimeout(timer);
  }, [room.id, data?.error, data?.loading, connectionReady, loadHistory]);

  const scroller = useRef<HTMLDivElement>(null);
  // Following the newest message: until you scroll up by hand, and again once you're back near the bottom.
  const stick = useRef(true);
  const lastTop = useRef(0);
  // The chat's size when last looked at, and the message at its top then (scrollPlace.ts): when the size changes (a
  // foldable unfolding, the phone turning, the keyboard), the browser moves the chat, not you.
  const lastSize = useRef("");
  const place = useRef<Place | null>(null);
  const inner = useRef<HTMLDivElement>(null);
  const messages = data?.messages ?? [];
  const latest = useLatest(messages);
  const resized = (el: HTMLDivElement) => {
    const size = sizeKey(el);
    if (size === lastSize.current) return false;
    const first = !lastSize.current;
    lastSize.current = size;
    return !first;
  };
  /** After a change of size: still at the newest message if it was there, else the same message at the top. */
  const keepPlace = (el: HTMLDivElement) => {
    if (stick.current) toBottom(el);
    else {
      restorePlace(el, place.current);
      lastTop.current = el.scrollTop;
      // Bigger now, it may all fit: then there's nothing newer to jump to.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < PIN_WITHIN_PX) stick.current = true;
    }
    latest.scrolled(!stick.current);
  };
  const onScroll = () => {
    const el = scroller.current;
    if (el) {
      if (resized(el)) keepPlace(el);
      else {
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // Up by hand (not the page getting shorter, which leaves it at the bottom): it stays where you put it.
        if (el.scrollTop < lastTop.current - 1 && fromBottom > 1) stick.current = false;
        else if (fromBottom < PIN_WITHIN_PX) stick.current = true;
        lastTop.current = el.scrollTop;
      }
      place.current = placeOf(el, inner.current);
    }
    latest.scrolled(!stick.current);
  };
  const toBottom = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };
  // Whether to keep following, from where the chat actually is: a scroll up by hand can be on screen before its scroll
  // event arrives (Safari sends it with the next frame), and a reply's next words mustn't pull the chat back down.
  const following = (el: HTMLDivElement) => {
    if (resized(el)) {
      keepPlace(el);
      return stick.current;
    }
    if (stick.current && el.scrollTop < lastTop.current - 1 && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
      stick.current = false;
      latest.scrolled(true);
    }
    return stick.current;
  };
  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    toBottom(el);
    latest.scrolled(false);
  };
  // Opened by a search hit: back to that message (the chat stops following the newest one), flashed once.
  useFindMessage(room.id, scroller, () => {
    stick.current = false;
  });
  const lastText = messages.length ? messages[messages.length - 1].text.length : 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following(el)) toBottom(el);
  }, [messages.length, lastText, approvals.length, room.id]);
  useEffect(() => {
    stick.current = true;
  }, [room.id]);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && olderAnchor.current && !data?.loading) {
      el.scrollTop = olderAnchor.current.top + el.scrollHeight - olderAnchor.current.height;
      olderAnchor.current = null;
    }
  }, [data?.loading, messages.length]);
  const loadOlder = () => {
    const el = scroller.current;
    if (el) { stick.current = false; olderAnchor.current = { height: el.scrollHeight, top: el.scrollTop }; }
    void loadHistory(room.id, true);
  };
  useEffect(() => {
    const el = inner.current;
    const sc = scroller.current;
    if (!el || !sc) return;
    lastSize.current = sizeKey(sc);
    const ro = new ResizeObserver(() => {
      if (following(sc)) toBottom(sc);
      else place.current = placeOf(sc, el);
    });
    ro.observe(el);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [room.id]);
  // Your message went in: down to it (and the reply starting under it), wherever you were.
  const onSent = () => jumpToLatest();

  // Motion (motion-chat.css). A batch drawn at once (the history, a catch-up after a reconnect, an older page) comes in
  // still; what arrives after it, while you follow the chat, settles in: a message by scale alone (its words readable
  // from its first frame, the scroll height and position untouched), a card or a line with a fade. Worked out while
  // drawing, like the marks below: `stick` is whether the chat followed until this message came.
  const quietSince = useQuietSince(!data?.loaded || !!data?.loading || !connectionReady);
  const arrivals = useRef<{ seen: Set<string> | null; at: Map<string, number> }>({ seen: null, at: new Map() });
  const drawnAt = performance.now();
  if (data?.loaded) {
    const a = arrivals.current;
    if (!a.seen) a.seen = new Set(messages.map((m) => m.id));
    else {
      const added = messages.filter((m) => !a.seen!.has(m.id));
      for (const m of added) a.seen.add(m.id);
      if (added.length && added.length <= ARRIVALS_AT_ONCE && stick.current && drawnAt - quietSince > SETTLE_MS) for (const m of added) a.at.set(m.id, drawnAt);
    }
    for (const [id, t] of a.at) if (drawnAt - t > ARRIVED_MS) a.at.delete(id);
  }
  const arrived = (id: string) => arrivals.current.at.has(id);
  // And off again once it has played, even if nothing else draws the chat meanwhile: a mark left on would play its
  // entrance again when Reduce Motion is turned off (an animation starts afresh when its name comes back).
  const [, expire] = useState(0);
  const lastArrival = Math.max(0, ...arrivals.current.at.values());
  useEffect(() => {
    if (!lastArrival) return;
    const t = setTimeout(() => expire((n) => n + 1), Math.max(0, lastArrival + ARRIVED_MS + 20 - performance.now()));
    return () => clearTimeout(t);
  }, [lastArrival]);

  // The same list while the agent's handle is the same: its status changing (every few seconds while it works) mustn't
  // redraw, and format again, every reply in the chat.
  const handleKey = members.map((m) => m.handle).join(" ");
  const handles = useMemo(() => (handleKey ? handleKey.split(" ") : []), [handleKey]);
  // A reply split around a message sent mid-turn ("Send now") is several messages of one turn: each shows the steps
  // from its own stretch of time, and an empty first part (nothing written before the message went in) isn't shown.
  const parts = useMemo(() => {
    const byTurn = new Map<string, typeof messages>();
    for (const m of messages) if (m.authorKind === "agent" && m.turnId) byTurn.set(m.turnId, [...(byTurn.get(m.turnId) ?? []), m]);
    return byTurn;
  }, [messages]);
  const hiddenParts = useMemo(() => {
    const out = new Set<string>();
    for (const list of parts.values()) for (const m of list.slice(0, -1)) if (!m.text.trim() && m.status === "done" && !(data?.activities[m.turnId!] ?? []).some((a) => a.createdAt < (list[list.indexOf(m) + 1]?.createdAt ?? Infinity))) out.add(m.id);
    return out;
  }, [parts, data?.activities]);
  const partActivities = (m: (typeof messages)[number]) => {
    const all = data?.activities[m.turnId!];
    const list = parts.get(m.turnId!);
    if (!all || !list || list.length < 2) return all;
    const i = list.findIndex((x) => x.id === m.id);
    const from = i === 0 ? -Infinity : m.createdAt;
    const to = list[i + 1]?.createdAt ?? Infinity;
    return all.filter((a) => a.createdAt >= from && a.createdAt < to);
  };
  // The same list each time while nothing changed, so a streaming reply doesn't redraw every other reply.
  const partApprovals = (m: (typeof messages)[number]) => {
    const all = approvalsByTurn[m.turnId!];
    const list = parts.get(m.turnId!);
    if (!all || !list || list.length < 2) return all;
    const i = list.findIndex((x) => x.id === m.id);
    const from = i === 0 ? -Infinity : m.createdAt;
    const to = list[i + 1]?.createdAt ?? Infinity;
    return all.filter((a) => a.createdAt >= from && a.createdAt < to);
  };
  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
  const approvalsByTurn = useMemo(() => {
    const out: Record<string, Approval[]> = {};
    for (const a of allApprovals) if (a.turnId) (out[a.turnId] ??= []).push(a);
    return out;
  }, [allApprovals]);
  const busy = statusKnown && members.some((m) => BUSY.includes(m.status));
  // Stop shows whenever the agent itself says it's working, even while the history reloads or couldn't load.
  const stoppable = connected && members.some((m) => BUSY.includes(m.status));
  const working = statusKnown ? members.filter((m) => ["thinking", "working", "approval"].includes(m.status)) : [];
  const queued = statusKnown ? members.filter((m) => m.status === "queued") : [];
  const turnList = Object.values(data?.turns ?? {});
  // Nothing running or waiting: what failed can be tried again, and a message nothing answered can be answered now. An
  // agent that's only waiting for its helpers so a change can apply isn't in the way: that can take hours.
  // Only hubs that say what the agent has read (Member.readSeq) can do either. In a group chat, what the agents have read
  // is the furthest any of them has: past it, nobody has read a message.
  const readSeq = group ? (members.length && members.every((m) => m.readSeq !== undefined) ? Math.max(...members.map((m) => m.readSeq!)) : undefined) : member?.readSeq;
  const canRetry = statusKnown && !!member && readSeq !== undefined && !members.some((m) => BUSY.includes(m.status) && !onlyFinishingHelpers(m)) && !turnList.some((t) => t.status === "queued" || t.status === "running");
  // Failed replies whose request a later reply answered (Try again, an edit): a grey note now, not a red error. In a group
  // chat, a later reply of the same agent.
  const retried = useMemo(() => retriedTurns(Object.values(data?.turns ?? {}), group), [data?.turns, group]);
  // Your messages with replies that failed on them, how many (unsending one the agent never got removes those too).
  const failedOn = new Map<string, number>();
  const shownIds = new Set(messages.map((m) => m.id));
  for (const t of turnList) if (t.status === "error" && t.triggerMessageId && t.replyMessageId && shownIds.has(t.replyMessageId)) failedOn.set(t.triggerMessageId, (failedOn.get(t.triggerMessageId) ?? 0) + 1);
  const newestReply = messages.findLast((m) => m.authorKind === "agent" && !hiddenParts.has(m.id))?.id;
  // A group chat: each agent's newest reply (a failed one offers Try again until that agent answers again).
  const newestOf = useMemo(() => {
    const out = new Map<string, string>();
    if (group) for (const m of messages) if (m.authorKind === "agent" && m.memberId && !hiddenParts.has(m.id)) out.set(m.memberId, m.id);
    return out;
  }, [group, messages, hiddenParts]);
  // Your newest message, when the agent hasn't read it and nothing is going to answer it (Stop everything left it, say).
  // In a group chat: when agents it's for haven't (another agent's reply after it doesn't make it answered).
  const newestYours = messages.findLastIndex((m) => m.authorKind === "human" && !m.via);
  const yours = newestYours >= 0 ? messages[newestYours] : undefined;
  const after = newestYours >= 0 ? messages.slice(newestYours + 1) : [];
  const unansweredBy = group && canRetry ? notAnswered(room, members, yours, false, after) : [];
  const unanswered =
    canRetry && yours && typeof yours.seq === "number" && (group ? unansweredBy.length > 0 : !after.some(isReply) && yours.seq > member!.readSeq!)
      ? yours.id
      : null;
  // A failure is news when it happens while the chat is open: a reply seen working here that then failed, or one newer
  // than everything the chat held when its history came (the hub's clock on both sides, so the device's doesn't matter).
  // Only those are announced to a screen reader; the ones already in the history, and older ones "Load earlier
  // messages" brings, are read in their place like the rest of the chat.
  const openedAt = useRef<number | null>(null);
  if (openedAt.current === null && data?.loaded) openedAt.current = Math.max(0, ...messages.map((m) => m.createdAt), ...turnList.map((t) => t.createdAt));
  const seenWorking = useRef(new Set<string>());
  for (const t of turnList) if (t.status === "queued" || t.status === "running" || t.status === "waiting") seenWorking.current.add(t.id);
  for (const m of messages) if (m.status === "streaming" && !(m.turnId && data?.turns[m.turnId]?.status === "error")) seenWorking.current.add(m.id);
  const isNews = (createdAt: number, ...ids: (string | null | undefined)[]) => ids.some((id) => !!id && seenWorking.current.has(id)) || (openedAt.current !== null && createdAt > openedAt.current);
  // A reply that failed before it had a message of its own (a reply that was rewound or unsent never shows again).
  const [dismissed, dismiss] = useDismissed(room.id);
  const unshownFailures = turnList.filter((turn) => turn.status === "error" && !turn.replyMessageId && !dismissed.has(turn.id) && !messages.some((m) => m.turnId === turn.id));
  const newestTurn = turnList.filter((t) => t.status !== "queued").sort((a, b) => a.createdAt - b.createdAt).at(-1)?.id;
  // The newest reply each signed-out account stopped (its words are the reply's error): the way to sign in stands in
  // place of that error. One no reply here stopped on (this chat hasn't tried yet) gets a card under the replies.
  const signInOf = new Map<string, SignInNeed>();
  for (const need of signIns) {
    const stoppedOn = messages.findLast((m) => m.authorKind === "agent" && !!m.turnId && data?.turns[m.turnId]?.status === "error" && data.turns[m.turnId]?.error === need.words);
    if (stoppedOn) signInOf.set(stoppedOn.id, need);
  }
  const signInsBelow = signIns.filter((n) => ![...signInOf.values()].includes(n));
  // Replies waiting for a usage limit to reset: each says when it carries on, with Try now and Don't wait.
  const limitWaits = turnList.filter((t) => t.status === "waiting" && !!t.wait).sort((a, b) => a.createdAt - b.createdAt);
  // Claude Code refused because the session is open in the Claude app: close it there, or duplicate this chat.
  const lastReply = [...messages].reverse().find((m) => m.authorKind === "agent");
  const lastError = lastReply?.text ?? "";
  const openInApp = !group && provider === "claude" && member?.status === "error" && /open in the Claude app/.test(member.statusDetail ?? lastError) && !dismissed.has(`app:${lastReply?.turnId ?? lastReply?.id ?? ""}`);
  // The failed reply just above shows Try again (the card then points to it).
  const replyOffersRetry = canRetry && !!lastReply && lastReply.id === newestReply && ((lastReply.turnId ? data?.turns[lastReply.turnId]?.status : undefined) ?? lastReply.status) === "error" && !(lastReply.turnId && retried.has(lastReply.turnId));
  // A duplicated chat's copied messages (written before it existed) were never sent from here: they can't be edited,
  // unsent or rewound to. In a long chat its first line may not be loaded yet: messages older than the chat tell then.
  const copied = messages.some((m) => m.copy?.kind === "from") || (!!data?.hasMore && (messages[0]?.createdAt ?? Infinity) < room.createdAt);
  const copiedBefore = copied ? room.createdAt : 0;
  // An agent that can't go back (OpenCode): only what it hasn't read can be changed or taken back. A group chat has its own
  // answer for that, with the way out.
  const canGoBack = group || !isNoRewindAgent(member?.provider);
  // Messages "Send now" handed to the reply in progress that wait for the step it's on: the last one says so.
  const handed = Object.values(data?.turns ?? {}).find((t) => t.status === "running" && t.unread?.length);
  const lastUnread = handed ? messages.findLast((m) => handed.unread!.includes(m.id))?.id : undefined;
  // While an agent's helpers work, a message of yours its reply can't take goes by itself when that ends: a small label.
  const quiet = useStore((s) => {
    const here = s.roomData[room.id];
    if (!s.hub?.messagesFlow || !here) return "";
    for (const m of members) {
      if (!(s.tasks[m.id] ?? []).some(helperAtWork)) continue;
      const forThis = group ? (x: { text: string }) => whoAnswers(room, members, x.text).who.some((w) => w.id === m.id) : undefined;
      const id = quietWait(m, Object.values(here.turns), here.messages, forThis, { helpers: true });
      if (id) return `${id} ${group ? `@${m.handle}` : ""}`;
    }
    return "";
  });
  const [quietId, quietWho] = quiet.split(" ");
  const effort = typeof member?.config?.effort === "string" ? member.config.effort : "";
  // Which agent it is, the avatar and the message box say: the line has room for the model and the folder. A group
  // chat's line names its agents.
  const sub = group
    ? [groupNames(members) || "No agents yet", folderName(room.cwd)].join(" · ")
    : // A chat on a service names the service first: its model alone wouldn't say what it runs on.
      [identity.service ? identity.name : null, member?.resolvedModel ?? member?.model, effort ? `${EFFORT_LABELS[effort] ?? effort} effort` : null, folderName(room.cwd)].filter(Boolean).join(" · ");
  // What the messages' notes call the chat's agent; in a group chat, the agent that wrote a reply.
  const agentName = group ? "the agents" : identity.name;
  const nameOf = (memberId: string | null | undefined) => (group ? (memberId && memberById[memberId] ? `@${memberById[memberId].handle}` : "the agent") : identity.name);

  return (
    <>
      <header className={`topbar ${group ? "" : "tinted"}`} style={{ ["--c" as string]: group ? info.color : identity.color }} data-tauri-drag-region>
        <SidebarButton />
        {group ? <GroupAvatar members={members} state={groupState(members)} /> : <ChatAvatar identity={identity} state={member?.status} />}
        <div className="titles">
          <h1 className="ellipsis">
            {room.name} {api && <ApiBadge />}
          </h1>
          {/* With more than one machine on this device, the line ends with the one it's on (its short tag, as in the
              chat list), never cut off. */}
          <div className="sub chat-sub" title={machine ? `${sub} · on ${machine}` : sub}>
            <span className="ellipsis">{sub}</span>
            {machineShort && <span className="chat-sub-machine"> · {machineShort}</span>}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Chat settings" title="Chat settings">
          <SlidersHorizontal size={19} />
        </button>
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll}>
        <RoomFilesContext.Provider value={room.id}>
          <EntranceScope since={quietSince}>
          <div className="inner" ref={inner}>
            {data?.hasMore && (
              <button className="btn small ghost" style={{ alignSelf: "center", margin: "4px 0 10px" }} disabled={data.loading} onClick={loadOlder}>
                {data.loading ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {/* The status line above the message box says it couldn't load, and why, with Retry (and it tries again by
                itself): not said here as well. */}
            {!data?.loaded && !data?.error && <div className="muted small" style={{ textAlign: "center", padding: 30 }}>Loading…</div>}
            {data?.loaded && messages.length === 0 && unshownFailures.length === 0 && (
              <div className="empty" style={{ minHeight: 260 }}>
                {group ? (
                  <div>
                    <GroupAvatar members={members} size="lg" />
                    <div className="big">{members.length ? `Group chat with ${groupNames(members)}` : "Group chat"}</div>
                    <p className="muted small" style={{ maxWidth: 420, margin: "6px auto 0", overflowWrap: "anywhere" }}>
                      {answersLine(whoAnswers(room, members, ""))} They work in <span className="mono">{room.cwd}</span> on {machine ?? "this machine"}.
                    </p>
                  </div>
                ) : (
                  <div>
                    <ChatAvatar identity={identity} size="lg" />
                    <div className="big">Chat with {identity.name}</div>
                    <p className="muted small" style={{ maxWidth: 420, margin: "6px auto 0", overflowWrap: "anywhere" }}>
                      {identity.service ? `${identity.model ?? "Its model"}, ${identityWhere(identity, poolOffer, machine)}, driven by ${info.name}. ` : ""}
                      It works in <span className="mono">{room.cwd}</span> on {machine ?? "this machine"}.
                    </p>
                  </div>
                )}
              </div>
            )}
            {room.chat && room.chat.origin !== "web" && messages.length > 0 && (
              <div className="msg system">
                <div className="sys">Continues a conversation from {ORIGIN[room.chat.origin] ?? "another app"}. New messages there show up here when you open this chat.</div>
              </div>
            )}
            {messages.map((m, i) => (
              hiddenParts.has(m.id) ? null : m.authorKind === "human" && m.via ? (
                <RelayMessage key={m.id} message={m} handles={handles} arrive={arrived(m.id)} />
              ) : m.authorKind === "human" ? (
                m.createdAt < copiedBefore ? (
                  <MessageRow key={m.id} message={m} prev={messages[i - 1]} handles={handles} statusKnown arrive={arrived(m.id) && nothingToTap(m.text)} />
                ) : (
                  <YourMessage
                    key={m.id}
                    message={m}
                    prev={messages[i - 1]}
                    handles={handles}
                    room={room}
                    agentName={agentName}
                    group={group}
                    canGoBack={canGoBack}
                    busy={busy}
                    later={messages.length - 1 - i}
                    unread={readSeq !== undefined && typeof m.seq === "number" && m.seq > readSeq}
                    failed={failedOn.get(m.id) ?? 0}
                    arrive={arrived(m.id) && nothingToTap(m.text)}
                    note={handed && m.id === lastUnread ? <ReadNowNote room={room} turn={handed} agentName={nameOf(handed.memberId)} /> : m.id === unanswered ? <NotAnswered room={room} sentAt={m.createdAt} label={group ? notAnsweredLine(unansweredBy) : undefined} /> : m.id === quietId ? <QuietWait sentAt={m.createdAt} who={quietWho || undefined} /> : null}
                  />
                )
              ) : (
                <AgentReply
                  key={m.id}
                  room={room}
                  messages={messages}
                  index={i}
                  turn={m.turnId ? data?.turns[m.turnId] : undefined}
                  agentName={agentName}
                  author={group ? nameOf(m.memberId) : undefined}
                  busy={busy}
                  copiedBefore={copiedBefore}
                  canGoBack={canGoBack}
                  newest={group ? !!m.memberId && newestOf.get(m.memberId) === m.id : m.id === newestReply}
                  canRetry={canRetry}
                  retried={!!m.turnId && retried.has(m.turnId)}
                  readSeq={readSeq}
                >
                  <MessageRow
                    message={m}
                    prev={messages[i - 1]}
                    member={m.memberId ? memberById[m.memberId] : undefined}
                    handles={handles}
                    activities={m.turnId ? partActivities(m) : undefined}
                    approvals={m.turnId ? partApprovals(m) : undefined}
                    turn={m.turnId ? data?.turns[m.turnId] : undefined}
                    statusKnown={statusKnown}
                    retried={!!m.turnId && retried.has(m.turnId)}
                    announce={isNews(m.createdAt, m.turnId, m.id)}
                    arrive={arrived(m.id)}
                    signIn={signInOf.get(m.id)}
                  />
                </AgentReply>
              )
            ))}
            {unshownFailures.map((turn) => (
              <CardArrival key={turn.id}>
                <div className="msg agent error">
                  <div className="body">
                    <TurnError error={turn.error} announce={isNews(turn.createdAt, turn.id)} />
                    <div className="row wrap" style={{ gap: 4 }}>
                      {canRetry && turn.id === newestTurn && <TryAgain room={room} memberId={group ? turn.memberId : undefined} />}
                      {canRetry && turn.id === newestTurn && <RaiseLimit room={room} error={turn.error} memberId={group ? turn.memberId : undefined} />}
                      {turn.id === newestTurn && <OpenAiServices error={turn.error} />}
                      <button className="link-action" onClick={() => dismiss(turn.id)}>
                        <X size={12} /> Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              </CardArrival>
            ))}
            {limitWaits.map((turn) => (
              <LimitWaitRow key={turn.id} room={room} turn={turn} memberId={group ? turn.memberId : undefined} />
            ))}
            {signInsBelow.map((need) => {
              // A reply of this chat failed on it: its Try again is right above, and is where the keyboard goes once signed in.
              const stopped = members.some((m) => m.provider === need.provider && memberAccount(m) === need.account && m.status === "error");
              return (
                <CardArrival key={`signin:${need.provider}:${need.account}`}>
                  <SignInPrompt variant="card" who={need} machine={need.machine.name} line={chatPromptLine(need, { stopped, device: thisDevice() })} stopped={stopped} focusAfter={chatRetryOrBox} />
                </CardArrival>
              );
            })}
            {openInApp && <OpenInApp room={room} retry={replyOffersRetry} onDuplicate={() => setDuplicating(true)} onDismiss={() => dismiss(`app:${lastReply?.turnId ?? lastReply?.id ?? ""}`)} />}
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

      <EntranceScope since={quietSince}>
        <Composer key={room.id} room={room} members={members} busy={busy} stoppable={stoppable} working={working} queued={queued} onRoomSettings={() => setSettings(true)} onSent={onSent} />
      </EntranceScope>
      {settings && group && <GroupSettingsDialog room={room} members={members} machine={machine} onClose={() => setSettings(false)} onDuplicate={() => setDuplicating(true)} />}
      {settings && !group && member && <ChatSettingsDialog room={room} member={member} machine={machine} onClose={() => setSettings(false)} onDuplicate={() => setDuplicating(true)} />}
      {duplicating && member && <DuplicateDialog room={room} member={member} members={group ? members : undefined} onClose={() => setDuplicating(false)} />}
    </>
  );
}

/** Whether a hub's version is older than `than` ("0.2.0" is older than "0.2.1"); an unknown one isn't. */
/**
 * This conversation is open in the Claude app: two apps writing it would mix it up. Claude Code never got the message,
 * so its failed reply offers Try again (`retry`; older machines can't, and say to send it again). The reply above says
 * to close it there and tap Try again, so the card doesn't say it again. A machine on an older Crosstalk (before
 * Duplicate chat) offers its own way out, Continue in a copy.
 */
function OpenInApp({ room, retry, onDuplicate, onDismiss }: { room: Room; retry: boolean; onDuplicate: () => void; onDismiss: () => void }) {
  const entering = useEntrance();
  const toast = useStore((s) => s.toast);
  const legacy = useStore((s) => olderThan(s.hub?.version, "0.2.1"));
  const [busy, setBusy] = useState(false);
  const continueInCopy = async () => {
    setBusy(true);
    try {
      await api("POST", `/api/chats/${room.id}/copy`);
      onDismiss();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`card${entering ? " m-drop" : ""}`} role="note" style={{ margin: "6px 0" }}>
      <p className="small" style={{ marginTop: 0 }}>
        {legacy
          ? "This conversation is open in the Claude app. Close it there, then send your message again. Or go on in a copy (the original stays as it is in the Claude app)."
          : retry
            ? "Claude Code never got your message, so nothing is lost. A duplicate goes on in a copy; the original stays as it is in the Claude app."
            : "This conversation is open in the Claude app. Close it there, then send your message again. Or duplicate it to go on in a copy (the original stays as it is)."}
      </p>
      <div className="row wrap" style={{ gap: 8 }}>
        {legacy ? (
          <button className="btn small primary" disabled={busy} onClick={continueInCopy}>
            <Copy size={13} /> Continue in a copy
          </button>
        ) : (
          <button className="btn small primary" onClick={onDuplicate}>
            <Copy size={13} /> Duplicate…
          </button>
        )}
        <button className="btn small ghost" onClick={onDismiss}>
          <X size={13} /> Dismiss
        </button>
      </div>
    </div>
  );
}

/** A label with `code` in it, the code shown as code. */
function withCode(label: string): ReactNode {
  return label.split(/`([^`]*)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/**
 * What's always allowed in this chat ("Always allow" on a request), each with Remove: the agent asks about it again.
 * Nothing shows when there's none (or the machine's Crosstalk can't list them).
 */
function AlwaysAllowedList({ member, agentName }: { member: Member; agentName: string }) {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<AlwaysAllowed[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<AlwaysAllowed[]>("GET", `/api/members/${member.id}/always`)
      .then((l) => live && setList(Array.isArray(l) ? l : []))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [member.id]);
  if (!list?.length) return null;
  const remove = async (g: AlwaysAllowed) => {
    setRemoving(g.id);
    try {
      setList(await api<AlwaysAllowed[]>("DELETE", `/api/members/${member.id}/always`, { id: g.id }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  };
  return (
    <div className="field">
      <span>Always allowed</span>
      <span className="help">{agentName} doesn't ask before these in this chat. Stricter permissions take them all back.</span>
      <ul className="always-list">
        {list.map((g) => (
          <li key={g.id}>
            <span className="always-label">{withCode(g.label)}</span>
            <button className="btn small" disabled={removing !== null} onClick={() => void remove(g)} aria-label={`Remove: ${g.label.replace(/`/g, "")}`}>
              {removing === g.id ? "Removing…" : "Remove"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatSettingsDialog({ room, member, machine, onClose, onDuplicate }: { room: Room; member: Member; machine: string | null; onClose: () => void; onDuplicate: () => void }) {
  const toast = useStore((s) => s.toast);
  const openAgent = useStore((s) => s.openAgent);
  const setView = useStore((s) => s.setView);
  const provider = member.provider as ChatProvider;
  const info = PROVIDER_INFO[provider];
  // A chat on a service of yours: the settings are where which agent drives it is spelled out, because that's what the
  // model lock, the helper agents and the permissions follow.
  const pool = useStore((s) => s.poolOffer);
  const identity = chatIdentity(room, member, useStore((s) => s.accounts), pool);
  const [asking, setAsking] = useState<"fresh" | "delete" | null>(null);
  const working = BUSY.includes(member.status);
  // A message of yours the agent hasn't read yet (on machines that say what it has read): starting fresh leaves it to be
  // asked for, with Answer now under it, or Try again on the reply that failed on it.
  const waitingMessage = useStore((s): "Answer now" | "Try again" | null => {
    if (member.readSeq === undefined) return null;
    const list = s.roomData[room.id]?.messages ?? [];
    const i = list.findLastIndex((m) => m.authorKind === "human" && !m.via);
    const seq = i >= 0 ? list[i].seq : undefined;
    if (typeof seq !== "number" || seq <= member.readSeq) return null;
    return list.slice(i + 1).some(isReply) ? "Try again" : "Answer now";
  });
  const initial: AgentChoice = { account: memberAccount(member), model: member.model ?? "", effort: typeof member.config?.effort === "string" ? member.config.effort : "", permissionMode: member.permissionMode, helperModel: typeof member.config?.helperModel === "string" ? member.config.helperModel : "" };
  // Everything here is measured from how it was when this opened, never from how the chat is right now: another device
  // can rename the chat, flip these switches or pick another model while this dialog is open, and what it did stays.
  // Only what was changed here is saved (the Pinned switch has always worked this way; so do the rest now).
  const [choiceAtOpen] = useState<AgentChoice>(initial);
  const [choice, setChoice] = useState<AgentChoice>(initial);
  const [nameAtOpen] = useState(() => room.name);
  const [name, setName] = useState(nameAtOpen);
  const [reachableAtOpen] = useState(() => !room.privateFromAgents);
  const [reachable, setReachable] = useState(reachableAtOpen);
  // Pinned to the top of the chat list on every device. Kept by the chat's machine, the one showing (`machine` above is
  // only its name, and null with just one).
  const [pinnedAtOpen] = useState(() => isPinned(room));
  const [pinned, setPinned] = useState(pinnedAtOpen);
  const machines = useMachines((m) => m.list);
  const active = useStore((s) => s.active);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const said = nameEdit(name, nameAtOpen, room.name);
  const changed = { name: said.changed, choice: JSON.stringify(choice) !== JSON.stringify(choiceAtOpen), reachable: reachable !== reachableAtOpen, pinned: pinned !== pinnedAtOpen };
  const dirty = changed.name || changed.choice || changed.reachable || changed.pinned;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      const c = cleanChoice(choice);
      const sendChoice = changed.choice && JSON.stringify(choice) !== JSON.stringify(initial);
      // Asked before the first write: a Cancel here used to leave the rename saved, the pin not, and nothing said.
      if (sendChoice && c.account !== initial.account && !confirm(`Switching accounts starts a fresh ${info.name} session (the chat history stays). Continue?`)) return;
      if (said.send) await api("PATCH", `/api/rooms/${room.id}`, { name: said.send });
      if (changed.reachable && reachable !== !room.privateFromAgents) await api("PATCH", `/api/rooms/${room.id}`, { privateFromAgents: !reachable });
      if (sendChoice) {
        const config: Record<string, unknown> = { ...member.config, account: c.account };
        if (c.effort) config.effort = c.effort;
        else delete config.effort;
        if (c.helperModel && c.helperModel !== c.model) config.helperModel = c.helperModel;
        else delete config.helperModel;
        await api("PATCH", `/api/members/${member.id}`, { model: c.model || null, permissionMode: c.permissionMode, config });
      }
      // Last: a machine with an older Crosstalk can't pin. It says so, with the rest saved and the dialog left open.
      // Nothing to send when another device made it so meanwhile (pinning again would move it to the top).
      if (changed.pinned && pinned !== isPinned(room)) {
        const here = machines.find((m) => m.key === active);
        if (!here) throw new Error("This chat's machine isn't connected yet. Try again in a moment.");
        try {
          await pinChat(here, room.id, pinned, machines);
        } catch (e) {
          pinFailed(e);
          return;
        }
      }
      onClose();
    });

  return (
    <Dialog
      title="Chat settings"
      icon={<ChatAvatar identity={identity} />}
      onClose={onClose}
      dirty={dirty}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !dirty || !!said.problem} onClick={save}>
            Save
          </button>
        </>
      }
    >
      {(requestClose) => (
        <>
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={!!said.problem} aria-describedby={said.problem ? nameId : undefined} />
      </label>
      {said.problem && (
        <p className="help" id={nameId} style={{ margin: "-6px 0 12px", color: "var(--orange)" }}>
          {said.problem}
        </p>
      )}
      {identity.service && (
        <p className="help" style={{ margin: "-6px 0 12px" }}>
          Runs on {identity.name}, {identityWhere(identity, pool, machine)} · driven by {info.name}{isServiceOnlyAgent(provider) ? "." : ", which its model lock and helper agents follow."}
        </p>
      )}
      <AgentOptions provider={provider} value={choice} onChange={setChoice} />
      <AlwaysAllowedList member={member} agentName={info.name} />
      <div className="row" style={{ gap: 12, margin: "4px 0 12px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>Other chats' agents can reach this chat</div>
          <div className="help">They can find, read and message it, when "Let agents reach your other chats" is on (Settings → Teamwork). Off keeps it private, and its own agent doesn't reach other chats either.</div>
        </div>
        <Switch checked={reachable} onChange={setReachable} label="Other chats' agents can reach this chat" />
      </div>
      <div className="row" style={{ gap: 12, margin: "4px 0 12px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>Pinned</div>
          <div className="help">Stays at the top of your chat list, on every device.</div>
        </div>
        <Switch checked={pinned} onChange={setPinned} label="Pinned" />
      </div>
      <div className="field">
        <span>Folder</span>
        <span className="mono small" style={{ overflowWrap: "anywhere" }}>
          {room.cwd}
          {machine && <span className="folder-machine"> on {machine}</span>}
        </span>
        {room.chat && room.chat.origin !== "web" && <span className="help">Continues a conversation from {ORIGIN[room.chat.origin] ?? "another app"}.</span>}
      </div>
      <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
        {/* Unsaved changes here are asked about first. */}
        <button className="btn small" disabled={busy} onClick={() => requestClose(onDuplicate)}>
          <Copy size={13} /> Duplicate chat…
        </button>
        <button className="btn small" disabled={busy} onClick={() => setAsking("fresh")}>
          Start fresh
        </button>
        <ExportMarkdownButton room={room} disabled={busy} />
        <button className="btn small danger" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setAsking("delete")}>
          Delete chat
        </button>
      </div>
      {asking === "fresh" && (
        // Its messages stay: asked once, here in the app.
        <Dialog
          title="Start a fresh session?"
          icon={<RotateCcw size={18} />}
          onClose={() => !busy && setAsking(null)}
          footer={
            <div className="row" style={{ gap: 8, justifyContent: "flex-end", width: "100%" }}>
              <button className="btn small" disabled={busy} onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button
                className="btn small primary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api("POST", `/api/members/${member.id}/reset`);
                    setAsking(null);
                    onClose();
                  })
                }
              >
                {busy ? "Starting…" : "Start fresh"}
              </button>
            </div>
          }
        >
          <p className="small" style={{ margin: 0 }}>
            {info.name} forgets this conversation and starts over. The messages here stay.
            {working && ` Starting fresh stops ${info.name} now.`}
            {waitingMessage === "Answer now" && " A message it hasn't read yet isn't answered until you tap Answer now under it."}
            {waitingMessage === "Try again" && " A message it hasn't read yet isn't answered until you tap Try again."}
          </p>
        </Dialog>
      )}
      {asking === "delete" && (
        // Its messages go: asked twice.
        <TwoStepDialog
          title="Delete this chat?"
          icon={<Trash2 size={18} />}
          detail={[
            "Its messages are removed from Crosstalk.",
            room.chat && room.chat.origin !== "web" ? `The conversation stays in ${ORIGIN[room.chat.origin] ?? "its app"}.` : null,
            "Files in its folder stay.",
            working ? `Deleting stops ${info.name}.` : null,
          ].filter(Boolean).join(" ")}
          sure="This can't be undone."
          confirmLabel="Yes, delete"
          workingLabel="Deleting…"
          agentName={info.name}
          onConfirm={async () => {
            await deleteRoomHere(room.id);
            onClose();
            // Crosstalk's own agent and OpenCode have no screen of their own to go back to.
            if (isServiceOnlyAgent(provider)) setView("rooms");
            else openAgent(provider);
          }}
          onClose={() => setAsking(null)}
        />
      )}
        </>
      )}
    </Dialog>
  );
}

/**
 * A message another chat's agent sent here (through Crosstalk): on the agents' side, saying where it came from, with
 * a link to that chat. It can be taken back only before this chat's agent reads it.
 */
function RelayMessage({ message: m, handles, arrive = false }: { message: Message; handles: string[]; arrive?: boolean }) {
  const toast = useStore((s) => s.toast);
  const v = m.via!;
  const unsend = async () => {
    if (!confirm("Take back this message from another chat? Its sender hears that you removed it.")) return;
    try {
      await api("DELETE", `/api/messages/${m.id}`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className={`msg agent relay${arrive ? " m-arrive" : ""}`} data-mid={m.id}>
      <div className="avatar relay-avatar" aria-hidden="true">
        <ArrowLeftRight size={15} />
      </div>
      <div className="body">
        <div className="head">
          <a className="who relay-from" href={`#/room/${v.chatId}`} title="Open that chat">
            From {v.agent} · "{v.chatName}" · {v.machine} ›
          </a>
          <span className="time">{timeShort(m.createdAt)}</span>
          {v.kind === "start" && <span className="pill">Started this chat</span>}
          {v.hop > 1 && <span className="pill">{v.hop} of 3 between agents</span>}
        </div>
        <div className="bubble">
          <Markdown text={m.text} handles={handles} />
        </div>
        <button className="link-action relay-unsend" onClick={unsend}>
          <Undo2 size={12} /> Unsend
        </button>
      </div>
    </div>
  );
}

/**
 * Under a message "Send now" handed to the reply in progress: the agent reads it once the step it's on ends (a long
 * command can take minutes). "Stop it and read now" stops that step (a command is cut off where it is, so that's asked
 * first), and the agent answers right away. When the step can't be stopped, it says so, with Try again.
 */
/** An agent's reply to what came before: one stopped before it said anything, while the agent was starting, isn't. */
const isReply = (m: Message) => m.authorKind === "agent" && !(m.status === "stopped" && !m.text.trim());

export function ReadNowNote({ room, turn, agentName }: { room: Room; turn: Turn; agentName: string }) {
  const entering = useEntrance();
  // Crosstalk's agent reads it when the step it's on ends: the note says so, with nothing offered that can't happen.
  const canStop = !isNoReadNowAgent(useStore((s) => s.members[turn.memberId]?.provider));
  // While its helpers work it went in by itself, and there's nothing to tap: only a small label says when it's read.
  const flowing = useStore((s) => !!s.hub?.messagesFlow && (s.tasks[turn.memberId] ?? []).some(helperAtWork));
  const steps = useStore((s) => s.roomData[room.id]?.activities[turn.id]);
  // A question it asked without waiting doesn't hold it up.
  const approving = useStore((s) => Object.values(s.approvals).some((a) => a.turnId === turn.id && a.status === "pending" && a.delivery !== "async"));
  const toast = useStore((s) => s.toast);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<{ step: string | null; text: string } | null>(null);
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), 1000);
  const running = (steps ?? []).filter((a) => a.status === "running");
  const step = running.filter((a) => a.kind !== "thinking").pop() ?? running.pop();
  const stopping = !!turn.readingNow || asking;
  const name = step ? step.kind === "command" ? <code>{step.title}</code> : `“${step.kind === "thinking" ? "Thinking" : step.title}”` : null;
  // A failure is about the step it couldn't stop: once that step ends, the note says what's next again.
  const failure = failed && failed.step === (step?.id ?? null) ? failed.text : null;
  const readNow = async () => {
    if (step?.kind === "command" && !confirm(`Stop "${step.title}" now? It's cut off where it is, and ${agentName} reads your message right away.`)) return;
    setAsking(true);
    setFailed(null);
    try {
      // Whose reply it is (in a group chat, two can work at once).
      const r = await api<{ reading: boolean }>("POST", `/api/rooms/${room.id}/read-now`, { memberId: turn.memberId });
      if (!r.reading) toast("info", `${agentName} has just read it.`);
    } catch (e) {
      setFailed({ step: step?.id ?? null, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setAsking(false);
    }
  };
  if (flowing && !stopping && !failure) return <QuietNote>{approving ? `${agentName} reads this once you answer its request above.` : step ? `${agentName} reads this after the current step.` : `${agentName} reads this at its next step.`}</QuietNote>;
  return (
    <div className={`read-now${entering ? " m-drop" : ""}`} role="status" onClick={(e) => e.stopPropagation()}>
      <span className="read-now-text">
        {stopping ? (
          <span>Stopping {name ?? "the current step"} so {agentName} reads this now…</span>
        ) : approving ? (
          <span>{agentName} reads this once you answer its request above.</span>
        ) : failure ? (
          <span role="alert">{failure}</span>
        ) : step ? (
          <>
            <span>{agentName} reads this after the current step:</span>
            <span>
              {name} · running {elapsed(Date.now() - step.createdAt)}
            </span>
          </>
        ) : (
          <span>{agentName} reads this at its next step.</span>
        )}
      </span>
      {!stopping && !approving && canStop && (
        <button className="btn small primary" onClick={readNow}>
          {failure ? "Try again" : step ? "Stop it and read now" : "Read it now"}
        </button>
      )}
    </div>
  );
}

/** A small label under a message of yours while helpers work: what becomes of it, with nothing to tap. */
function QuietNote({ children }: { children: ReactNode }) {
  const entering = useEntrance();
  return (
    <div className={`msg-quiet${entering ? " m-drop" : ""}`} role="status" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/**
 * Under a message that goes when the reply ends (quietWait). After a moment: the hub hands a message to a reply that can
 * take it as it arrives, and a label that came and went at once would say something that was never so.
 */
function QuietWait({ sentAt, who }: { sentAt: number; who?: string }) {
  const [shown, setShown] = useState(() => Date.now() - sentAt > 2_000);
  useEffect(() => {
    if (shown) return;
    const t = setTimeout(() => setShown(true), 2_000);
    return () => clearTimeout(t);
  }, [shown]);
  return shown ? <QuietNote>{quietWaitWords(who)}</QuietNote> : null;
}

/** What a tap on a message ignores: it's for opening a link, a photo or a button inside it, not the message's actions. */
const OWN_TAP = "a, button, input, textarea, select, summary, img, video, [role=button]";

/**
 * One of your messages, with Edit, Unsend and Copy (tap it on a phone, hover on a computer). `unread`: the agent hasn't
 * read it (it's waiting, or its reply failed before the agent got it), so editing or unsending it just changes it.
 * `failed`: replies that failed on it, which unsending it removes too. `canGoBack`: false for an agent that can't go back to
 * an earlier message, so one it has read stays as it is.
 */
export function YourMessage({ message: m, prev, handles, room, agentName, group = false, canGoBack = true, busy, later = 0, unread = false, failed = 0, arrive = false, note }: { message: Message; prev?: Message; handles: string[]; room: Room; agentName: string; group?: boolean; canGoBack?: boolean; busy?: boolean; later?: number; unread?: boolean; failed?: number; arrive?: boolean; note?: ReactNode }) {
  const toast = useStore((s) => s.toast);
  const [rewinding, setRewinding] = useState(false);
  const [unsending, setUnsending] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // It read this while it was being edited, and has no way back to before it: nothing here can be saved.
  const tooLate = !canGoBack && !unread;
  const rewindNote = tooLate
    ? `${agentName} has just read this message, so it can't be changed now. Copy what you wrote and send it as a new message.`
    : group
    ? unread
      ? "No agent here has read it yet, so it's just changed and sent again."
      : "The agents that already read it go back to just before this message and forget it and everything after; replies after it leave the chat. Files they changed stay changed."
    : unread
      ? `${agentName} hasn't read it yet, so it's just changed and sent again.`
      : `If ${agentName} already read it, it goes back to just before this message and forgets it and everything after; replies after it leave the chat. Files it changed stay changed.`;
  const act = async (fn: () => Promise<unknown>) => {
    setSaving(true);
    try {
      await fn();
      setEditing(false);
      setOpen(false);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  if (editing) {
    return (
      <div className="msg human">
        <div className="body editing">
          <textarea className="input edit-box" value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, Math.max(2, draft.split("\n").length))} autoFocus aria-label="Edit message" />
          <p className="help edit-note">{rewindNote}</p>
          {confirmEdit && <RewindDialog title="Edit and rewind?" detail={rewindNote} agentName={agentName} group={group} busy={busy} roomId={room.id} onConfirm={() => act(() => api("PATCH", `/api/messages/${m.id}`, { text: draft }))} onClose={() => setConfirmEdit(false)} />}
          {/* Not read yet (asked once): if the agent reads it meanwhile, the hub refuses, and it's asked about again. */}
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <button className="btn small" disabled={saving} onClick={() => (setEditing(false), setDraft(m.text))}>
              Cancel
            </button>
            <button className="btn small primary" disabled={saving || tooLate || !draft.trim() || draft.trim() === m.text.trim()} onClick={() => (later > 0 && !unread ? setConfirmEdit(true) : act(() => api("PATCH", `/api/messages/${m.id}`, { text: draft, ...(later > 0 ? { ifUnread: true } : {}) })))}>
              {saving ? "Saving…" : "Save and send"}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`your-msg ${open ? "open" : ""}`} onClick={(e) => !(e.target as HTMLElement).closest(OWN_TAP) && setOpen((o) => !o)}>
      <MessageRow message={m} prev={prev} handles={handles} statusKnown arrive={arrive} />
      {note}
      {room.chat && <AskCards room={room} messageId={m.id} />}
      <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
        {/* An answer to the agent's questions is sent from its card, not typed: it can be unsent, not edited. */}
        {(canGoBack || unread) && answerText(m.text) === null && (
          <button className="link-action" disabled={saving} onClick={() => (setDraft(m.text), setEditing(true))}>
            <Pencil size={12} /> Edit
          </button>
        )}
        {(canGoBack || unread) && (
          <button
            className="link-action"
            disabled={saving}
            onClick={() => {
              // Read by the agent, with more after it or while it works (on this, say): a rewind, asked twice, with Stop
              // offered first. Not read, but with a reply that failed on it: that reply goes too, so asked twice as well.
              if (!unread && (later > 0 || busy)) return setRewinding(true);
              if (unread && failed > 0) return setUnsending(true);
              // A lone last message the agent isn't answering (or hasn't read yet) is asked once.
              if (!confirm(`Unsend this message?\n\n${unread ? (group ? "No agent here has read it yet." : `${agentName} hasn't read it yet.`) : rewindNote}`)) return;
              // Not read when asked: if the agent reads it meanwhile, the hub refuses, and it's asked about again.
              void act(() => api("DELETE", `/api/messages/${m.id}`, unread ? { ifUnread: true } : undefined));
            }}
          >
            <Undo2 size={12} /> Unsend
          </button>
        )}
        <CopyReply text={shownText(m.text)} label="Copy message" />
        <BookmarkButton messageId={m.id} />
        {room.chat && <AskOthersButton room={room} messageId={m.id} />}
      </div>
      {rewinding && (
        <RewindDialog
          title="Unsend this message?"
          detail={
            group
              ? later > 0
                ? `This message and everything after it leave the chat (${later + 1} messages in all). The agents that read it go back to just before it and forget them. Files they changed stay changed.`
                : "This message leaves the chat. The agents that read it go back to just before it and forget it. Files they changed stay changed."
              : later > 0
                ? `This message and everything after it leave the chat (${later + 1} messages in all). ${agentName} goes back to just before it and forgets them. Files it changed stay changed.`
                : `This message leaves the chat. ${agentName} goes back to just before it and forgets it. Files it changed stay changed.`
          }
          agentName={agentName}
          group={group}
          busy={busy}
          roomId={room.id}
          onConfirm={() => api("DELETE", `/api/messages/${m.id}`)}
          onClose={() => setRewinding(false)}
        />
      )}
      {unsending && (
        <TwoStepDialog
          title="Unsend this message?"
          icon={<Undo2 size={18} />}
          detail={`Your message leaves the chat, with the ${failed === 1 ? "reply that" : `${failed} replies that`} failed on it. ${group ? "No agent here got it." : `${agentName} never got it.`}`}
          sure="This can't be undone: your message is deleted."
          confirmLabel="Yes, unsend"
          workingLabel="Unsending…"
          agentName={agentName}
          group={group}
          onConfirm={() => api("DELETE", `/api/messages/${m.id}`, { ifUnread: true })}
          onClose={() => setUnsending(false)}
        />
      )}
    </div>
  );
}

/**
 * Under your newest message when nothing is going to answer it (Stop everything left it, say): one tap gets it
 * answered. On a message just sent, it waits a moment first: the answer to sending can come just before the hub says
 * it's being answered.
 */
function NotAnswered({ room, sentAt, label = "Not answered" }: { room: Room; sentAt: number; label?: string }) {
  const entering = useEntrance();
  const toast = useStore((s) => s.toast);
  const [shown, setShown] = useState(() => Date.now() - sentAt > 10_000);
  useEffect(() => {
    if (shown) return;
    const t = setTimeout(() => setShown(true), 2_500);
    return () => clearTimeout(t);
  }, [shown]);
  const [asking, setAsking] = useState(false);
  const answer = async () => {
    setAsking(true);
    try {
      // `currentSettings`: it says Answer now, so it does, with "Keep going while helpers work" off too (Engine.retry).
      await api("POST", `/api/rooms/${room.id}/retry`, { currentSettings: true });
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };
  if (!shown) return null;
  return (
    <div className={`not-answered${entering ? " m-drop" : ""}`} role="status" onClick={(e) => e.stopPropagation()}>
      <span>{label}</span>
      <span aria-hidden="true">·</span>
      <button className="btn small primary" disabled={asking} onClick={answer}>
        {asking ? "Asking…" : "Answer now"}
      </button>
    </div>
  );
}

/** Try again on a failed reply: the agent answers what it was asked again (see Engine.retry). In a group chat, `memberId`: the agent whose reply it was. */
function TryAgain({ room, memberId }: { room: Room; memberId?: string }) {
  const toast = useStore((s) => s.toast);
  const [asking, setAsking] = useState(false);
  const go = async () => {
    setAsking(true);
    try {
      await api("POST", `/api/rooms/${room.id}/retry`, memberId ? { memberId } : undefined);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };
  return (
    <button className="link-action try-again" disabled={asking} onClick={go}>
      <RotateCcw size={12} /> {asking ? "Trying again…" : "Try again"}
    </button>
  );
}

/**
 * While a reply waits for its agent's usage limit to reset (Turn.wait): when the chat carries on, counting down, and
 * the two ways out — Try now runs it at once, Don't wait leaves it as a failed reply with Try again. Not an error row:
 * the chat picks itself back up without you.
 */
function LimitWaitRow({ room, turn, memberId }: { room: Room; turn: Turn; memberId?: string }) {
  const entering = useEntrance();
  const toast = useStore((s) => s.toast);
  const wait = turn.wait!;
  const [asking, setAsking] = useState<"now" | "cancel" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), countdownTickMs(wait.runAt, now));
  const go = async (what: "now" | "cancel") => {
    setAsking(what);
    try {
      await api("POST", `/api/rooms/${room.id}/limit-wait/${what === "now" ? "now" : "cancel"}`, memberId ? { memberId } : undefined);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(null);
    }
  };
  return (
    <div className={`limit-wait${entering ? " m-drop" : ""}`} role="status">
      <span className="limit-when">
        <Clock size={13} aria-hidden="true" /> {limitWaitLine(wait, now)}
      </span>
      <span className="row" style={{ gap: 0 }}>
        <button className="link-action" disabled={!!asking} onClick={() => go("now")}>
          <FastForward size={12} /> {asking === "now" ? "Starting…" : "Try now"}
        </button>
        <button className="link-action" disabled={!!asking} onClick={() => go("cancel")}>
          <X size={12} /> {asking === "cancel" ? "Stopping…" : "Don't wait"}
        </button>
      </span>
    </div>
  );
}

/** Turn ids of failure notes you dismissed in this chat, kept on this device. */
function useDismissed(roomId: string): [Set<string>, (turnId: string) => void] {
  const key = `crosstalk.dismissed.${roomId}`;
  const [ids, setIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const dismiss = (turnId: string) =>
    setIds((cur) => {
      const next = new Set([...cur, turnId]);
      try {
        localStorage.setItem(key, JSON.stringify([...next].slice(-200)));
      } catch {
        // kept for this visit only
      }
      return next;
    });
  return [ids, dismiss];
}

/**
 * One of the agent's replies, with its actions under it (hover on a computer, tap on a phone): Copy copies the whole
 * reply as written (Markdown), and "Rewind to here" takes the chat back to just after it. A failed reply offers to take
 * back the message it answered, so the agent stops reading that request; the newest one also offers Try again, with
 * both always showing (older failures show theirs on a tap). Rewind and Take back work while the agent is working too:
 * their dialog offers to stop it. `canGoBack`: false for an agent that can't go back, which offers them only for what it hasn't read.
 */
export function AgentReply({ room, messages, index, turn, agentName, author, busy, copiedBefore = 0, canGoBack = true, newest = false, canRetry = false, retried = false, readSeq, children }: { room: Room; messages: Message[]; index: number; turn?: Turn; agentName: string; author?: string; busy: boolean; copiedBefore?: number; canGoBack?: boolean; newest?: boolean; canRetry?: boolean; retried?: boolean; readSeq?: number; children: ReactNode }) {
  // A group chat's reply names its agent (`author`); going back is about all the agents that read what goes.
  const group = author !== undefined;
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"rewind" | "takeBack" | null>(null);
  const m = messages[index];
  const failed = (turn?.status ?? m.status) === "error";
  // Rewinding to here takes back the next message you sent, and everything after it.
  const next = messages.findIndex((x, j) => j > index && x.authorKind === "human");
  // A failed reply: the message of yours it answered (else the one just before it).
  let asked = -1;
  if (failed) {
    asked = messages.findIndex((x) => x.id === turn?.triggerMessageId && x.authorKind === "human" && !x.via);
    if (!turn && asked < 0) for (let j = index - 1; j >= 0 && asked < 0; j--) if (messages[j].authorKind === "human" && !messages[j].via) asked = j;
  }
  const isUnread = (i: number) => readSeq !== undefined && typeof messages[i].seq === "number" && messages[i].seq! > readSeq;
  // A duplicated chat's copied messages can't be taken back (they were never sent from here).
  const canRewind = !failed && next > index && m.status !== "streaming" && messages[next].createdAt >= copiedBefore && (canGoBack || isUnread(next));
  // The agent never got the message (it failed before reading it): taking it back just removes it, with this reply.
  const askedUnread = asked >= 0 && isUnread(asked);
  const canTakeBack = asked >= 0 && messages[asked].createdAt >= copiedBefore && (canGoBack || askedUnread);
  const tryAgain = failed && newest && canRetry && !retried;
  // An agent that runs on a service's key was refused it: the way out is the key, in Settings → AI services (never a
  // sign-in: it has none). Shown with the newest failure even while Try again can't be (the chat is busy elsewhere).
  const keyFix = failed && newest && !retried && isServiceKeyRefusal(turn?.error ?? m.text);
  // Once it's written (while it streams, the text is still changing). A failed reply has Copy in its header, beside the
  // time (MessageRow), and its row is for getting the request answered: Copy isn't said twice.
  const canCopy = !!m.text.trim() && m.status !== "streaming" && !(failed && !retried);
  // Ask others: a chat's finished reply (not one that failed or is still being written).
  const canAsk = !!room.chat && !failed && !!m.text.trim() && m.status !== "streaming";
  // Bookmark: a reply that's written, failed ones too (what went wrong can be worth keeping).
  const bookmarks = useStore((s) => s.bookmarked !== null);
  const canBookmark = bookmarks && !!m.text.trim() && m.status !== "streaming";
  const actions = canCopy || canRewind || canTakeBack || tryAgain || canAsk || keyFix || canBookmark;
  // The newest failure keeps its way out showing; older ones (and one a later try answered) show it on a tap.
  const pinned = failed && newest && !retried && (tryAgain || canTakeBack || keyFix);
  const toggle = (e: React.MouseEvent) => {
    if (!actions || (e.target as HTMLElement).closest(OWN_TAP)) return;
    setOpen((o) => !o);
  };
  const removed = (from: number) => messages.length - from;
  const quote = (t: string) => `“${t.replace(/\s+/g, " ").trim().slice(0, 80)}${t.length > 80 ? "…" : ""}”`;
  return (
    // Always the same wrapper, so a reply that finishes streaming isn't drawn again from scratch when Copy appears.
    <div className={`your-msg agent-reply ${open || pinned ? "open" : ""}`} onClick={toggle}>
      {children}
      {room.chat && <AskCards room={room} messageId={m.id} />}
      {actions && (
        <div className="msg-actions agent-actions" onClick={(e) => e.stopPropagation()}>
          {tryAgain && <TryAgain room={room} memberId={group ? turn?.memberId ?? m.memberId ?? undefined : undefined} />}
          {tryAgain && <RaiseLimit room={room} error={turn?.error ?? m.text} memberId={group ? turn?.memberId ?? m.memberId ?? undefined : undefined} />}
          {keyFix && <OpenAiServices error={turn?.error ?? m.text} />}
          {canTakeBack && (
            <button className="link-action" onClick={() => setDialog("takeBack")}>
              <Undo2 size={12} /> Take back your message
            </button>
          )}
          {canCopy && <CopyReply text={m.text} />}
          {canBookmark && <BookmarkButton messageId={m.id} />}
          {canRewind && (
            <button className="link-action" onClick={() => setDialog("rewind")}>
              <History size={12} /> Rewind to here
            </button>
          )}
          {canAsk && <AskOthersButton room={room} messageId={m.id} />}
        </div>
      )}
      {dialog === "rewind" && (
        <RewindDialog
          title="Rewind the chat to here?"
          detail={`The chat goes back to just after this reply. Your next message and everything after it leave the chat (${removed(next)} ${removed(next) === 1 ? "message" : "messages"} in all), and ${group ? "the agents that read them forget them. Files they changed" : `${agentName} forgets them. Files it changed`} stay changed.`}
          agentName={agentName}
          group={group}
          busy={busy}
          roomId={room.id}
          onConfirm={() => api("POST", `/api/messages/${m.id}/rewind`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "takeBack" && (
        <RewindDialog
          title="Take back your message?"
          detail={
            askedUnread
              ? `Your message ${quote(messages[asked].text)} leaves the chat, with this reply that failed on it. ${group ? "No agent here got it." : `${agentName} never got it.`}`
              : `Your message ${quote(messages[asked].text)} and everything after it leave the chat (${removed(asked)} ${removed(asked) === 1 ? "message" : "messages"} in all), so ${group ? `${author} doesn't read that request again. Files the agents changed` : `${agentName} doesn't read that request again. Files it changed`} stay changed.`
          }
          sure={askedUnread ? "This can't be undone: your message is deleted." : undefined}
          confirmLabel={askedUnread ? "Yes, take it back" : undefined}
          workingLabel={askedUnread ? "Taking it back…" : undefined}
          agentName={agentName}
          group={group}
          busy={busy}
          roomId={room.id}
          onConfirm={() => api("DELETE", `/api/messages/${messages[asked].id}`, askedUnread ? { ifUnread: true } : undefined)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** A rewind is asked twice: what leaves the chat, then whether you're sure (it can't be undone). */
function RewindDialog({ sure, confirmLabel, workingLabel, ...rest }: { title: string; detail: string; sure?: string; confirmLabel?: string; workingLabel?: string; agentName: string; group?: boolean; busy?: boolean; roomId: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  return (
    <TwoStepDialog
      icon={<History size={18} />}
      sure={sure ?? `This can't be undone: the messages are deleted, and ${rest.group ? "the agents" : rest.agentName} won't remember them.`}
      confirmLabel={confirmLabel ?? "Yes, rewind"}
      workingLabel={workingLabel ?? "Rewinding…"}
      {...rest}
    />
  );
}
