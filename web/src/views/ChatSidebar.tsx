import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bookmark, ChevronDown, HardDrive, PanelLeft, PanelLeftClose, Plus, Search, Server, Settings, ShieldAlert, SquareTerminal, Users, X } from "lucide-react";
import { PROVIDER_INFO, type AgentAccount, type ChatProvider, type Room } from "@crosstalk/shared";
import { accountKey } from "../accounts";
import { useLinked } from "../linkedMachines";
import { ChatRow, PinnedSection, usePinnedList, type PinRow } from "./ChatRow";
import { FoldableGroup, saysWhatsInside, type GroupFold } from "./GroupFold";
import { ListMotion, useFreshMarks } from "./ChatListMotion";
import { useEntrance } from "../motion";
import { usesApiKey, useMachines, useStore, type Machine } from "../store";
import { useSidebar } from "../sidebar";
import { searchTerm } from "../search";
import { GROUP_CHATS_GROUP, PINNED_GROUP, SHOWN, chatMatches, foldMark, folderName, isFolded, isUnread, keepInView, linkedNotHere, membersByRoom, needsYou, rowStates, shownRows, type RowState } from "../chatList";
import { chatGroups, chatIdentity, serviceWhereWords, type ChatGroup } from "../chatIdentity";
import { NewChatMenu, useChatStarters } from "./NewChatMenu";
import { limitBackWords } from "../limitWait";
import { poolAgentFor, poolWhereWords } from "../poolChat";
import { ApiBadge, ChatAvatar, Logo, ProviderAvatar, ServiceAvatar, formatBytes, timeAgo, useBookPosture, useInterval, useIsMobile } from "../ui";
import { MachineTag, useMachineName } from "./MachinePicker";
import { MessageHits } from "./MessageHits";
import { GroupAvatar } from "./GroupAvatar";
import { groupMatches, groupNames } from "../groupChat";

/** What a row's dot says. */
const STATE_LABEL: Record<RowState, string> = { needs: "Needs you", busy: "Working", waiting: "Waiting for its usage limit", error: "Stopped with an error" };

/**
 * Opens the sidebar: the drawer on a phone, or the docked sidebar when it's collapsed. Hidden while it's docked open.
 * It counts the requests and questions waiting in other chats, on every machine ("Show chats, 2 need you"), and has a
 * dot when another chat has a reply you haven't read.
 */
export function SidebarButton() {
  const mobile = useIsMobile();
  // Half-folded like a book, the chats are always on their half of the screen.
  const book = useBookPosture();
  const collapsed = useSidebar((s) => s.collapsed);
  const setCollapsed = useSidebar((s) => s.setCollapsed);
  const setDrawer = useSidebar((s) => s.setDrawer);
  const onScreen = useStore((s) => (s.view === "room" ? s.roomId : null));
  const machines = useMachines((m) => m.list);
  if (book || (!mobile && !collapsed)) return null;
  const count = needsYou(machines, onScreen);
  const unread = machines.some((m) => Object.values(m.rooms).some((r) => r.chat && r.id !== onScreen && isUnread(r)));
  const label = count ? `Show chats, ${count} need${count === 1 ? "s" : ""} you` : unread ? "Show chats, new replies" : "Show chats";
  return (
    <button className="icon-btn sidebar-btn" onClick={() => (mobile ? setDrawer(true) : setCollapsed(false))} aria-label={label} title={label}>
      <PanelLeft size={20} />
      {count > 0 ? <NeedsYouCount count={count} /> : unread && <NewReplyMark />}
    </button>
  );
}

/**
 * How many wait for you, on Show chats. It pops when it comes up on a screen that's already there, and again each time
 * the number it shows goes up (never as the screen is drawn, nor when one is dealt with).
 */
function NeedsYouCount({ count }: { count: number }) {
  const entrance = useEntrance();
  const shown = count > 9 ? "9+" : String(count);
  const was = useRef({ count, ups: 0 });
  if (Math.min(count, 10) > Math.min(was.current.count, 10)) was.current.ups++;
  was.current.count = count;
  const { ups } = was.current;
  return (
    // A new element each time it goes up, so it pops again.
    <span key={ups} className={`sidebar-count ${entrance || ups ? "m-pop" : ""}`} aria-hidden="true">
      {shown}
    </span>
  );
}

/** Show chats' dot for a reply you haven't read: it pops when it comes on while the screen is up. */
function NewReplyMark() {
  const entrance = useEntrance();
  return <span className={`sidebar-new ${entrance ? "m-pop" : ""}`} aria-hidden="true" />;
}

/**
 * "Try now" on a machine that isn't answering: it tries at once, and says so for a moment (the line itself only
 * changes once the machine answers).
 */
function TryNow({ onTry }: { onTry: () => void }) {
  const [trying, setTrying] = useState(false);
  useEffect(() => {
    if (!trying) return;
    const t = setTimeout(() => setTrying(false), 2000);
    return () => clearTimeout(t);
  }, [trying]);
  // Not `disabled` while it tries: a browser drops the focus of a button it disables, and the keyboard would lose its place.
  return (
    <button
      className="link-btn"
      aria-disabled={trying || undefined}
      onClick={() => {
        if (trying) return;
        setTrying(true);
        onTry();
      }}
    >
      {trying ? "Trying…" : "Try now"}
    </button>
  );
}

/** Settings, scrolled to one of its sections. */
function openSettingsAt(id: string) {
  useStore.getState().setView("settings");
  // Settings opens at the top: bring the section into view once it's there.
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
}

/** Every chat on every machine, grouped by agent, plus new chat, search, what needs you, and settings. */
export function ChatSidebar({ drawer = false }: { drawer?: boolean }) {
  const view = useStore((s) => s.view);
  const roomId = useStore((s) => s.roomId);
  const agent = useStore((s) => s.agent);
  const openRoom = useStore((s) => s.openRoom);
  const openAgent = useStore((s) => s.openAgent);
  const setView = useStore((s) => s.setView);
  const activate = useStore((s) => s.activate);
  const reconnectNow = useStore((s) => s.reconnectNow);
  const machines = useMachines((m) => m.list);
  // The open machine's pool, for its group's heading (New chat from it starts on the pool).
  const poolOffer = useStore((s) => s.poolOffer);
  const mobile = useIsMobile();
  const book = useBookPosture();
  const multi = machines.length > 1;
  const chats = useMemo(
    () => machines.flatMap((m) => Object.values(m.rooms).filter((r) => r.chat).map((room) => ({ room, machine: m }))).sort((a, b) => b.room.updatedAt - a.room.updatedAt),
    [machines],
  );
  const states = useMemo(() => new Map(machines.map((m) => [m.key, rowStates(m.members, m.approvals)])), [machines]);
  const stateOf = (r: Room, m: Machine) => states.get(m.key)?.get(r.id);
  const approvals = useMemo(() => machines.flatMap((m) => Object.values(m.approvals).filter((a) => a.status === "pending")), [machines]);
  // The machine shortest of space, when any is low.
  const storageLow = useMemo(() => machines.filter((m) => m.storage?.low).sort((a, b) => a.storage!.free - b.storage!.free)[0] ?? null, [machines]);
  const storage = storageLow?.storage ?? null;
  // Machines this device can't reach, and machines linked on another device but not added here.
  const home = machines.find((m) => m.key === "") ?? machines[0];
  const linked = useLinked(home);
  const notHere = useMemo(() => linkedNotHere(linked, machines), [linked, machines]);
  const down = machines.filter((m) => m.status !== "open" && m.downSince !== null);
  // A machine still connecting has no chats to show yet (they come in with its state).
  const loading = machines.some((m) => m.loadedAt === null && m.downSince === null);
  const setCollapsed = useSidebar((s) => s.setCollapsed);
  const setDrawer = useSidebar((s) => s.setDrawer);
  const query = useSidebar((s) => s.query);
  const setQuery = useSidebar((s) => s.setQuery);
  const all = useSidebar((s) => s.all);
  const setAll = useSidebar((s) => s.setAll);
  // Which groups this device folded away.
  const folded = useSidebar((s) => s.folded);
  const setFolded = useSidebar((s) => s.setFolded);
  const setCreating = useSidebar((s) => s.setCreating);
  const [newMenu, setNewMenu] = useState(false);
  const newBox = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLElement>(null);
  // "5m ago" moves on by itself.
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), 60_000);
  // A row's mark that just came on (a reply, a question for you, an error) pops; one drawn with the list doesn't.
  const freshMark = useFreshMarks();

  // Back where it was (the drawer isn't drawn while it's closed), with the chat on screen in view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = useSidebar.getState().scrollTop;
    const row = el.querySelector<HTMLElement>(".csb-chat.active");
    if (!row) return;
    const r = row.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) row.scrollIntoView({ block: "nearest" });
  }, []);

  // The New chat menu closes on a tap anywhere else, or Escape.
  useEffect(() => {
    if (!newMenu) return;
    const away = (e: PointerEvent) => {
      if (!newBox.current?.contains(e.target as Node)) setNewMenu(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setNewMenu(false);
      newButton.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [newMenu]);

  // On a phone, picking anything closes the drawer.
  const go = (fn: () => void) => {
    fn();
    if (drawer) setDrawer(false);
  };
  // What the New chat menu offers: the agents, the AI services added here, and the servers running here that aren't
  // added yet (only looked for while the menu is open).
  const starters = useChatStarters(newMenu);
  const canStart = starters.agents.length > 0 || starters.yours.length > 0;
  const q = query.trim().toLowerCase();
  // Each chat's agents on each machine, worked out once: a group chat's are found by their names too, and a one-agent
  // chat's first one says what the chat is (its service and model, chatIdentity.ts).
  const roomMembers = useMemo(() => new Map(machines.map((m) => [m.key, membersByRoom(m.members)])), [machines]);
  const groupOf = (r: Room, m: Machine) => roomMembers.get(m.key)?.get(r.id) ?? [];
  // Each machine's own pool: a chat on it is the pool and its model, not two services of the same name (chatIdentity.ts).
  const identityOf = (r: Room, m: Machine) => chatIdentity(r, groupOf(r, m)[0], m.accounts, m.poolOffer);
  // A chat on a service of yours is found by that service and its model too, because that's what the row says it is.
  const searchable = (r: Room, m: Machine) => {
    const id = identityOf(r, m);
    return id.service ? [id.name, id.model ?? ""].join(" ") : null;
  };
  const matches = (r: Room, m: Machine) => chatMatches(r, q, multi ? m.name : null, searchable(r, m)) || (!!r.chat?.group && groupMatches(groupOf(r, m), q));
  const waiting = useMemo(() => [...new Set(approvals.map((a) => a.roomId))], [approvals]);
  /**
   * Whether a chat needs a look: the one predicate behind both the newest-few cut (it stays in view past it) and what
   * a folded group counts, so the two can never say different things about the same chat.
   */
  const look = (c: PinRow) => keepInView(c.room, stateOf(c.room, c.machine));
  /** Which group a chat drops back into when it's unpinned: a group chat's own, or its agent's, service's or the pool's. */
  const groupKeyOf = (c: PinRow) => (c.room.chat?.group ? GROUP_CHATS_GROUP : identityOf(c.room, c.machine).groupKey);
  // Pinned chats first, every machine's, in the order you set (ChatRow.tsx); the rest by agent, newest first. An
  // unpinned chat stays in view where it lands (pins.kept), so a folded group there opens: otherwise the row — and the
  // focus that follows it — would vanish into a heading that only says a chat more. A pin opens Pinned the same way.
  const pins = usePinnedList(chats, !!q, { pinned: () => setFolded(PINNED_GROUP, false), unpinned: (c) => setFolded(groupKeyOf(c), false) });
  const pinnedShown = pins.pinned.filter(({ room, machine }) => matches(room, machine));
  // The list's groups: each agent's, then one for every AI service that has chats (chatIdentity.ts).
  const groups = useMemo(
    () =>
      chatGroups(
        chats
          .filter(({ room }) => !room.chat?.group)
          // The machine's name goes along: two machines can run a model of one name, and then the heading says which.
          .map(({ room, machine }) => ({ identity: chatIdentity(room, roomMembers.get(machine.key)?.get(room.id)?.[0], machine.accounts, machine.poolOffer), machine: machine.key, machineName: multi ? machine.name : null })),
        poolOffer,
      ),
    [chats, roomMembers, poolOffer, multi],
  );
  const groupChats = pins.rest.filter(({ room, machine }) => !!room.chat?.group && matches(room, machine));
  /**
   * What a group's fold control shows and does: it's folded when this device folded it (sidebar.ts), and it says how
   * many chats are inside and how many of them need a look, because folding hides those rows too. A group with no
   * chats folds as well, so a list of only your own models can put the agents' empty groups away. No control while a
   * search is on: every match shows wherever it is, as "Show all" already does.
   */
  const foldOf = (key: string, rows: PinRow[], where?: string | null): GroupFold => ({
    folded: isFolded(folded, key, !!q),
    foldable: !q,
    count: rows.length,
    attention: rows.filter(look).length,
    mark: foldMark(rows.map((c) => stateOf(c.room, c.machine))),
    where,
    onFold: (v) => setFolded(key, v),
  });

  // A chat with one of the agents, or a group chat (several of them, or two of one with different models).
  const startNew = () => setNewMenu(!newMenu);

  /**
   * Every line of the list, in order (ChatListMotion.ts `lineKey`), filled in as the list is drawn below: when it
   * changes, the lines glide to their new places. A chat's row adds its own (`row`).
   */
  const lines: string[] = [];

  // A chat's row, in its agent's group or under Pinned (where every agent's chats are, each with its agent's mark).
  const row = (c: PinRow, pinned = false) => {
    const { room: r, machine } = c;
    const group = r.chat?.group ? groupOf(r, machine) : null;
    // A chat on an AI service shows that service, not the agent that drives it.
    const identity = identityOf(r, machine);
    const state = stateOf(r, machine);
    // Waiting for a usage limit: the row says when the chat comes back, worked out on this device so the time is the
    // one on this clock ("Back at 3:20 PM"); the dot's label says the whole thing.
    const waits = state === "waiting" ? Object.values(machine.members).find((x) => x.roomId === r.id && x.status === "waiting") : undefined;
    const back = waits?.wait ? limitBackWords(waits.wait) : waits ? "Back soon" : "";
    const stateSaid = state ? (back ? `${STATE_LABEL[state]} · ${back}` : STATE_LABEL[state]) : "";
    const unread = isUnread(r);
    const key = `${machine.key}/${r.id}`;
    const options = pins.row(c);
    lines.push(`r:${key}`);
    // Its options open: the row is taller, so the lines under it move.
    if (options.open) lines.push(`t:${key}`);
    // What wants a look pops as it comes on (working, or waiting for a limit, is said by the dot's own look).
    const pop = freshMark(key, state === "needs" || state === "error" ? state : !state && unread ? "unread" : "") ? "m-pop" : "";
    return (
      <ChatRow key={key} id={key} name={r.name} pins={options}>
        <button
          className={`csb-chat ${pinned ? "pinned" : ""} ${group ? "group" : ""} ${view === "room" && roomId === r.id ? "active" : ""} ${unread ? "unread" : ""}`}
          style={{ ["--c" as string]: group ? "var(--text-3)" : identity.color }}
          onClick={() => go(() => openRoom(r.id))}
          title={multi ? `${r.name} · on ${machine.name}` : r.name}
        >
          {pinned && (group ? <GroupAvatar members={group} size="sm" /> : <ChatAvatar identity={identity} size="sm" />)}
          <span className="csb-chat-text">
            <span className="csb-chat-name">{r.name}</span>
            {/* On a phone, a second line: which folder (a group chat's: who's in it), and when — or, while it waits for a
                usage limit, when it comes back. */}
            {mobile && (
              <span className="csb-chat-sub">
                {group?.length ? groupNames(group) : folderName(r.cwd)} · {back || timeAgo(r.updatedAt)}
              </span>
            )}
          </span>
          {usesApiKey(r.id)(machine) && <ApiBadge />}
          {multi && <MachineTag name={machine.name} />}
          {/* On a bigger screen there's no second line: the words go beside the dot. */}
          {!mobile && back && <span className="csb-wait">{back}</span>}
          {state ? (
            <span className={`csb-dot ${state} ${pop}`} aria-label={stateSaid} title={stateSaid} />
          ) : unread ? (
            <span className={`reply-dot ${pop}`} aria-label="New reply" title="New reply" />
          ) : (
            !mobile && <span className="csb-time">{timeAgo(r.updatedAt)}</span>
          )}
        </button>
      </ChatRow>
    );
  };

  /** A group: its heading, then "No chats yet.", its rows and Show all, or, folded, what it holds. Its lines go in order. */
  const section = (key: string, fold: GroupFold, props: { title: string; label?: string; heading: ReactNode }, shown: PinRow[], empty: ReactNode, more: ReactNode) => {
    lines.push(`g:${key}`);
    if (empty) lines.push(`e:${key}`);
    const rows = shown.map((c) => row(c));
    if (more) lines.push(`a:${key}`);
    if (saysWhatsInside(fold)) lines.push(`s:${key}`);
    return (
      <FoldableGroup key={key} group={key} {...props} {...fold}>
        {empty}
        {rows}
        {more}
      </FoldableGroup>
    );
  };
  /** Show all, or Show fewer, under a group that has more than it shows. */
  const moreOf = (key: string, list: PinRow[], shown: PinRow[]) =>
    !q &&
    (all[key] ? list.length > SHOWN : list.length > shown.length) && (
      <button className="csb-more" onClick={() => setAll(key, !all[key])}>
        {all[key] ? "Show fewer" : `Show all ${list.length}`}
      </button>
    );

  // The list, line by line, top to bottom (`lines` follows it).
  const list: ReactNode[] = [];
  for (const m of down) {
    lines.push(`m:${m.key}`);
    list.push(
      <div key={`m:${m.key}`} className="csb-machine down" role="status" data-line={`m:${m.key}`}>
        <Server size={15} aria-hidden="true" />
        <span className="csb-machine-text">{m.name} isn't answering</span>
        <span aria-hidden="true">·</span>
        <TryNow onTry={() => reconnectNow(m.key)} />
      </div>,
    );
  }
  for (const info of notHere) {
    lines.push(`l:${info.id}`);
    list.push(
      <div key={`l:${info.id}`} className="csb-machine" data-line={`l:${info.id}`}>
        <Server size={15} aria-hidden="true" />
        <span className="csb-machine-text">{info.name} was linked</span>
        <span aria-hidden="true">·</span>
        <button className="link-btn" onClick={() => go(() => openSettingsAt("machines"))}>
          Add it here
        </button>
      </div>,
    );
  }
  if (waiting.length > 0 && !q) {
    lines.push("w");
    list.push(
      <button key="w" className="csb-waiting" data-line="w" onClick={() => go(() => openRoom(waiting[0]))}>
        <ShieldAlert size={16} aria-hidden="true" />
        {approvals.every((a) => a.kind === "question") ? (approvals.length === 1 ? "An agent has a question for you" : `${approvals.length} questions are waiting for you`) : approvals.length === 1 ? "1 approval is waiting for you" : `${approvals.length} approvals are waiting for you`}
      </button>,
    );
  }
  if (pinnedShown.length > 0) {
    const fold = foldOf(PINNED_GROUP, pinnedShown);
    lines.push(`g:${PINNED_GROUP}`);
    const rows = pinnedShown.map((c) => row(c, true));
    if (saysWhatsInside(fold)) lines.push(`s:${PINNED_GROUP}`);
    list.push(
      <PinnedSection key={PINNED_GROUP} {...fold}>
        {rows}
      </PinnedSection>,
    );
  }
  for (const g of groups) {
    const mine = (c: PinRow) => !c.room.chat?.group && identityOf(c.room, c.machine).groupKey === g.key;
    const rows = pins.rest.filter((c) => mine(c) && matches(c.room, c.machine));
    const machineName = multi ? machines.find((m) => m.key === g.machine)?.name ?? null : null;
    // Two machines can run a model of one name (chatGroups tells services apart by agent, which is the same for
    // both): then the fold control says where, as the heading's own name always does.
    const where = !g.provider && groups.filter((x) => x.title === g.title).length > 1 ? (g.pool ? poolWhereWords(g.pool) : serviceWhereWords(g.service as AgentAccount, machineName)) : null;
    const fold = foldOf(g.key, rows, where);
    // The newest few, plus any that needs a look (a new reply, working, waiting for you, stopped with an error), or
    // that you just unpinned. Folded, none of them: folding is a choice, and the heading says what's inside.
    const shown = fold.folded ? [] : all[g.key] || q ? rows : shownRows(rows, (c) => look(c) || pins.kept(c));
    // Its pinned chats are up under Pinned: "No chats yet" only without any.
    const none = !rows.length && !pinnedShown.some(mine);
    const heading = g.provider ? (
      <AgentHeader provider={g.provider} active={view === "agent" && agent === g.provider} onClick={() => go(() => openAgent(g.provider!))} />
    ) : (
      <ServiceHeader
        group={g}
        machine={machineName}
        onClick={() =>
          go(() =>
            // The pool's heading starts a chat on the pool itself, whatever state it's in (its own dialog says so); a
            // service's starts one on that service.
            setCreating(
              g.pool
                ? { kind: "pool", provider: (poolAgentFor(g.pool, g.agent, g.agent) ?? g.agent) as ChatProvider, offer: g.pool, machine: g.machine }
                : { kind: "service", provider: g.service!.provider as ChatProvider, account: g.service!.id, model: g.service!.endpoint?.models[0] ?? null, label: g.title, machine: g.machine },
            ),
          )
        }
      />
    );
    const empty = none && <p className="csb-empty">{q ? "No matches." : loading ? "Loading chats…" : "No chats yet."}</p>;
    list.push(section(g.key, fold, { title: g.title, heading }, shown, empty, moreOf(g.key, rows, shown)));
  }
  // Group chats, after each agent's chats: newest first, the newest few plus any that needs a look, like an agent's, and
  // they fold away like one too. Not there at all without any (New chat starts one).
  if (groupChats.length > 0) {
    const fold = foldOf(GROUP_CHATS_GROUP, groupChats);
    const shown = fold.folded ? [] : all[GROUP_CHATS_GROUP] || q ? groupChats : shownRows(groupChats, (c) => look(c) || pins.kept(c));
    const heading = (
      <div className="csb-agent static">
        <span className="avatar sm group-mark" aria-hidden="true">
          <Users size={12} />
        </span>
        <span className="csb-agent-name">Group chats</span>
      </div>
    );
    list.push(section(GROUP_CHATS_GROUP, fold, { title: "group", label: "Group chats", heading }, shown, null, moreOf(GROUP_CHATS_GROUP, groupChats, shown)));
  }
  // 2 or more characters also look inside every chat's messages, on every machine (search.ts).
  if (searchTerm(query)) list.push(<MessageHits key="hits" query={query} go={go} />);
  const order = lines.join("\n");

  return (
    <aside className={`chat-sidebar ${drawer ? "drawer" : ""}`} aria-label="Chats">
      <div className="csb-head">
        <button className="csb-brand" onClick={() => go(() => setView("rooms"))} aria-label="Home">
          <Logo className="logo" />
          <span>Crosstalk</span>
        </button>
        {/* Half-folded like a book, the chats stay on their half of the screen. */}
        {(drawer || !book) && (
          <button className="icon-btn" onClick={() => (drawer ? setDrawer(false) : setCollapsed(true))} aria-label={drawer ? "Close" : "Hide sidebar"} title={drawer ? "Close" : "Hide sidebar"}>
            {drawer ? <X size={20} /> : <PanelLeftClose size={19} />}
          </button>
        )}
      </div>

      <div className="csb-actions">
        <div ref={newBox} style={{ display: "contents" }}>
          <button ref={newButton} className="btn block csb-new" onClick={startNew} disabled={!canStart} aria-expanded={newMenu}>
            <Plus size={16} /> New chat
            <ChevronDown size={15} style={{ marginLeft: "auto" }} />
          </button>
          {newMenu && (
            <NewChatMenu
              starters={starters}
              onPick={(target) => {
                setNewMenu(false);
                setCreating(target);
              }}
            />
          )}
        </div>
        <label className="csb-search">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {query && (
            <button className="icon-btn" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      <ListMotion
        className="csb-scroll"
        scroller={scroller}
        order={order}
        // Searching (filtering as you type, and clearing it) and chats still coming in are drawn as they are.
        still={!!q || loading}
        onScroll={(e) => useSidebar.getState().setScrollTop(e.currentTarget.scrollTop)}
      >
        {list}
      </ListMotion>

      <div className="csb-foot">
        {storage?.low && (
          <button
            className={`csb-storage ${storage.free < storage.reserve ? "full" : ""}`}
            onClick={() =>
              go(() => {
                if (storageLow) activate(storageLow.key);
                openSettingsAt("storage");
              })
            }
          >
            <HardDrive size={16} aria-hidden="true" />
            {storage.free < storage.reserve
              ? `${multi ? storageLow!.name : "Hub"} storage is full: uploads paused`
              : `${multi ? storageLow!.name : "Hub"} storage is low: ${formatBytes(storage.free)} free`}
          </button>
        )}
        <button className={`csb-link ${view === "bookmarks" ? "active" : ""}`} onClick={() => go(() => setView("bookmarks"))}>
          <Bookmark size={17} /> Bookmarks
        </button>
        <button className={`csb-link ${view === "terminal" ? "active" : ""}`} onClick={() => go(() => setView("terminal"))}>
          <SquareTerminal size={17} /> Terminal
        </button>
        <button className={`csb-link ${["settings", "setup", "devices"].includes(view) ? "active" : ""}`} onClick={() => go(() => setView("settings"))}>
          <Settings size={17} /> Settings
        </button>
      </div>
    </aside>
  );
}

/**
 * A service's group heading: its name, and where it runs. Tapping it starts a new chat on that service, which is the one
 * thing a service has no page for (which agent drives it is in the chat's own settings). The model pool says where it
 * runs in its own words ("across 3 machines"), because its address is the main machine's, not where the model is.
 */
function ServiceHeader({ group, machine, onClick }: { group: ChatGroup; machine: string | null; onClick: () => void }) {
  const where = group.pool ? poolWhereWords(group.pool) : serviceWhereWords(group.service as AgentAccount, machine);
  return (
    <button className="csb-agent" onClick={onClick} title={`New chat with ${group.title}`} aria-label={`New chat with ${group.title}, ${where}`}>
      <ServiceAvatar where={group.where ?? "web"} size="sm" label={group.title} />
      <span className="csb-agent-name ellipsis">{group.title}</span>
      <Plus size={14} aria-hidden="true" />
    </button>
  );
}

/** An agent's group heading: tap for its page (new chat, sessions on the machine). Shows the tightest plan limit. */
function AgentHeader({ provider, active, onClick }: { provider: ChatProvider; active: boolean; onClick: () => void }) {
  const usage = useStore((s) => s.usage[accountKey(provider, "default")]);
  const top = (usage?.windows ?? []).filter((w) => w.usedPercent !== null).sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
  const pct = top ? Math.round(top.usedPercent ?? 0) : null;
  const machine = useMachineName();
  return (
    <button className={`csb-agent ${active ? "active" : ""}`} onClick={onClick} title={`${PROVIDER_INFO[provider].name}: chats and sessions on ${machine}`}>
      <ProviderAvatar provider={provider} size="sm" />
      <span className="csb-agent-name">{PROVIDER_INFO[provider].name}</span>
      {pct !== null && (
        <span className={`csb-usage ${pct >= 90 ? "full" : pct >= 70 ? "warn" : ""}`} title={`${top!.label}: ${pct}% used`}>
          {pct}%
        </span>
      )}
    </button>
  );
}
