import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Bookmark, ChevronDown, MonitorSmartphone, HardDrive, PanelLeft, PanelLeftClose, Pin, Plus, Search, Server, Settings, SquareTerminal, X } from "lucide-react";
import { helperAtWork, type Member, type Room } from "@crosstalk/shared";
import { useLinked } from "../linkedMachines";
import { ChatRow, usePinnedList, type PinRow } from "./ChatRow";
import { FoldableGroup, saysWhatsInside, type GroupFold } from "./GroupFold";
import { ListMotion, useFreshMarks } from "./ChatListMotion";
import { useEntrance } from "../motion";
import { usesApiKey, useMachines, useStore, type Machine } from "../store";
import { SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_WIDTH, useSidebar } from "../sidebar";
import { SHORTCUT, SHORTCUT_KEYS } from "../shortcuts";
import { zoomFactor } from "../zoom";
import { searchTerm } from "../search";
import { HOLD_HINT_KEY, SECTION_TITLE, SHOWN, canFold, chatMatches, heldSections, isFolded, isUnread, keepInView, linkedNotHere, listSections, membersByRoom, needsYou, placesOf, requestsByRoom, rowLabel, rowStateWords, rowStates, sectionFold, sectionOf, shownRows, type HeldPlaces, type ListRow, type ListSection, type RowFacts } from "../chatList";
import { chatIdentity } from "../chatIdentity";
import { NewChatMenu, useChatStarters } from "./NewChatMenu";
import { ApiBadge, ChatAvatar, Logo, formatBytes, useBookPosture, useInterval, useIsMobile, useTouchScreen } from "../ui";
import { MachineTag } from "./MachinePicker";
import { MessageHits } from "./MessageHits";
import { GroupAvatar } from "./GroupAvatar";
import { groupMatches, groupNames } from "../groupChat";

/** One chat as the list draws it: its machine, its state, and its key in the list (machine/chat). */
type Row = PinRow & ListRow & { key: string };

/** A finger resting on the list holds its rows in place for this long at most (a lift the page never heard of). */
const HOLD_MS = 8000;

/** Whether this device has seen to "Hold a chat to pin it" (a browser that refuses storage is shown it each time). */
function holdHintSeen(): boolean {
  try {
    return localStorage.getItem(HOLD_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

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

/**
 * Every chat on every machine, by state — Pinned, Needs you, Working, Recent — each row saying its state in words, plus
 * new chat, search, and the row of Screen, Bookmarks, Terminal and Settings under it.
 */
export function ChatSidebar({ drawer = false }: { drawer?: boolean }) {
  const view = useStore((s) => s.view);
  const roomId = useStore((s) => s.roomId);
  const openRoom = useStore((s) => s.openRoom);
  const setView = useStore((s) => s.setView);
  const hubScreen = useStore((s) => s.hub?.screen);
  const activate = useStore((s) => s.activate);
  const reconnectNow = useStore((s) => s.reconnectNow);
  const machines = useMachines((m) => m.list);
  const book = useBookPosture();
  const touch = useTouchScreen();
  const multi = machines.length > 1;
  // Each chat's agents on each machine, worked out once: a group chat's are found by their names too, and a one-agent
  // chat's first one says what the chat is (its service and model, chatIdentity.ts).
  const roomMembers = useMemo(() => new Map(machines.map((m) => [m.key, membersByRoom(m.members)])), [machines]);
  const groupOf = (r: Room, m: Machine): Member[] => roomMembers.get(m.key)?.get(r.id) ?? [];
  // Each chat's waiting requests, for its words ("Needs your OK · 2") and its place under Needs you.
  const requests = useMemo(() => new Map(machines.map((m) => [m.key, requestsByRoom(m.members, m.approvals)])), [machines]);
  // Every chat with what the list sorts it by: its state (what its agents say, the requests waiting, and the helpers
  // still at work once a reply has ended) and when it last asked for something.
  const rows = useMemo(
    () =>
      machines.flatMap((machine) => {
        const states = rowStates(machine.members, machine.approvals, machine.tasks);
        const asked = requests.get(machine.key);
        return Object.values(machine.rooms)
          .filter((room) => room.chat)
          .map((room): Row => ({ room, machine, key: `${machine.key}/${room.id}`, state: states.get(room.id), askedAt: asked?.get(room.id)?.newest ?? null }));
      }),
    [machines, requests],
  );
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
  // Which sections this device folded away.
  const folded = useSidebar((s) => s.folded);
  const setFolded = useSidebar((s) => s.setFolded);
  const setCreating = useSidebar((s) => s.setCreating);
  const [newMenu, setNewMenu] = useState(false);
  const newBox = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // How wide the docked list is (dragged at its edge, SidebarResizer); a drawer has its own width.
  const width = useSidebar((s) => s.width);
  // Asked for from the keyboard (shortcuts.ts), maybe just before this list was drawn (its drawer opening): the search
  // to type in, or the New chat menu with its first choice focused.
  const asked = useSidebar((s) => s.asked);
  useEffect(() => {
    if (asked.search <= answered.search) return;
    answered.search = asked.search;
    search.current?.focus();
    search.current?.select();
  }, [asked.search]);
  const [menuByKey, setMenuByKey] = useState(0);
  useEffect(() => {
    if (asked.create <= answered.create) return;
    answered.create = asked.create;
    if (newButton.current?.disabled) return;
    setNewMenu(true);
    setMenuByKey((n) => n + 1);
  }, [asked.create]);
  useEffect(() => {
    if (menuByKey) newBox.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuByKey]);
  // "5m ago" and "Working · 12m" move on by themselves.
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), 60_000);
  // A row's mark that just came on (a reply, a question for you, an error) pops; one drawn with the list doesn't.
  const freshMark = useFreshMarks();
  // "Hold a chat to pin it", once, on a touch screen (where a row has no ⋯): until a long press or a tap on its ✕.
  const [hintSeen, setHintSeen] = useState(holdHintSeen);
  const seeHint = () => {
    if (hintSeen) return;
    setHintSeen(true);
    try {
      localStorage.setItem(HOLD_HINT_KEY, "1");
    } catch {
      // storage unavailable: it's shown again next time
    }
  };

  // A finger on the list: its rows stay where they are until it lifts (chatList.ts heldSections), so a chat that
  // changes state just then doesn't slide out from under the tap. Touch events, not pointer ones: those end as soon
  // as the browser takes the gesture for scrolling, and a finger scrolling is still a finger on the list.
  const [touching, setTouching] = useState(false);
  const places = useRef<HeldPlaces | null>(null);
  const letGo = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hold = () => {
    clearTimeout(letGo.current);
    // A lift the page never hears of (the row under the finger went) must not hold the list for good.
    letGo.current = setTimeout(() => setTouching(false), HOLD_MS);
    setTouching(true);
  };
  useEffect(() => {
    if (!touching) return;
    const lifted = (e: TouchEvent) => {
      if (e.touches.length) return;
      clearTimeout(letGo.current);
      setTouching(false);
    };
    window.addEventListener("touchend", lifted, true);
    window.addEventListener("touchcancel", lifted, true);
    return () => {
      window.removeEventListener("touchend", lifted, true);
      window.removeEventListener("touchcancel", lifted, true);
    };
  }, [touching]);
  useEffect(() => () => clearTimeout(letGo.current), []);

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
  // With a keyboard: ↓ from the search goes into the chats, ↓ and ↑ move through them (↑ from the first goes back to
  // the search), Home and End reach the first and the last. Enter in the search opens the first chat it found, and
  // the search has done its job; Esc empties it, then leaves it for the message box.
  const chatRows = () => Array.from(scroller.current?.querySelectorAll<HTMLElement>("button.csb-chat") ?? []);
  const toMessageBox = () => document.querySelector<HTMLElement>('.main textarea[aria-label="Message"]')?.focus();
  const searchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      const first = chatRows()[0];
      if (!first) return;
      e.preventDefault();
      first.focus();
    } else if (e.key === "Enter" && query.trim()) {
      const first = chatRows()[0];
      if (!first) return;
      e.preventDefault();
      first.click();
      setQuery("");
      requestAnimationFrame(toMessageBox);
    } else if (e.key === "Escape") {
      if (query) {
        // The search is emptied; a second Esc leaves it (or closes the drawer, as ever).
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
      } else if (!drawer) {
        e.currentTarget.blur();
        toMessageBox();
      }
    }
  };
  const listKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.altKey || e.metaKey || e.ctrlKey) return;
    const at = (e.target as HTMLElement).closest<HTMLElement>("button.csb-chat");
    if (!at) return;
    const all = chatRows();
    const i = all.indexOf(at);
    const to = e.key === "Home" ? all[0] : e.key === "End" ? all[all.length - 1] : e.key === "ArrowDown" ? all[i + 1] : i === 0 ? search.current : all[i - 1];
    if (!to) return;
    e.preventDefault();
    to.focus();
  };
  // What the New chat menu offers: the agents, the AI services added here, and the servers running here that aren't
  // added yet (only looked for while the menu is open).
  const starters = useChatStarters(newMenu);
  const canStart = starters.agents.length > 0 || starters.yours.length > 0;
  const q = query.trim().toLowerCase();
  const identityOf = (r: Room, m: Machine) => chatIdentity(r, groupOf(r, m)[0], m.accounts);
  // A chat on a service of yours is found by that service and its model too, because that's what its avatar says it is.
  const searchable = (r: Room, m: Machine) => {
    const id = identityOf(r, m);
    return id.service ? [id.name, id.model ?? ""].join(" ") : null;
  };
  const matches = (r: Room, m: Machine) => chatMatches(r, q, multi ? m.name : null, searchable(r, m)) || (!!r.chat?.group && groupMatches(groupOf(r, m), q));
  /**
   * Whether a chat needs a look: the one predicate behind both Recent's newest-few cut (it stays in view past it) and
   * what a folded section counts, so the two can never say different things about the same chat.
   */
  const look = (c: Row) => keepInView(c.room, c.state);
  // Pinned chats first, every machine's, in the order you set (ChatRow.tsx); the rest by state. An unpinned chat stays
  // in view where it lands (pins.kept), so a folded section there opens: otherwise the row — and the focus that follows
  // it — would vanish into a heading that only says a chat more. A pin opens Pinned the same way.
  const pins = usePinnedList(rows, !!q, { pinned: () => setFolded("pinned", false), unpinned: (c) => setFolded(sectionOf({ room: { pinnedAt: null }, state: (c as Row).state }), false) });
  // The list as it is, and as it's drawn: with a finger on it, every row stays where it was when the finger came down.
  const live = listSections(rows.filter((c) => matches(c.room, c.machine)));
  if (!touching || !places.current) places.current = placesOf(live, (c) => c.key);
  const sections = touching ? heldSections(places.current, live, (c) => c.key) : live;

  // A chat with one of the agents, or a group chat (several of them, or two of one with different models).
  const startNew = () => setNewMenu(!newMenu);

  /**
   * Every line of the list, in order (ChatListMotion.ts `lineKey`), filled in as the list is drawn below: when it
   * changes, the lines glide to their new places. A chat's row adds its own (`row`).
   */
  const lines: string[] = [];

  // A chat's row: whose it is (its avatar), its name, and its state in words, or where it lives and when.
  const row = (c: Row) => {
    const { room: r, machine, state, key } = c;
    const members = groupOf(r, machine);
    const group = r.chat?.group ? members : null;
    // A chat on an AI service shows that service, not the agent that drives it.
    const identity = identityOf(r, machine);
    const unread = isUnread(r);
    const facts: RowFacts = {
      name: r.name,
      cwd: r.cwd,
      updatedAt: r.updatedAt,
      state,
      requests: requests.get(machine.key)?.get(r.id),
      // How long its reply has run: since the first of its agents' running replies started.
      workingSince: members.reduce<number | null>((first, m) => {
        const at = machine.replyStarts[m.id]?.at;
        return at && (first === null || at < first) ? at : first;
      }, null),
      helpers: members.reduce((n, m) => n + (machine.tasks[m.id] ?? []).filter(helperAtWork).length, 0),
      // Waiting for a usage limit: when the chat comes back, worked out on this device so the time is this clock's.
      wait: members.find((m) => m.status === "waiting")?.wait,
      who: group?.length ? groupNames(group) : null,
    };
    const options = pins.row(c);
    lines.push(`r:${key}`);
    // Its options open: the row is taller, so the lines under it move.
    if (options.open) lines.push(`t:${key}`);
    // What wants a look pops as it comes on (working, or waiting for a limit, is said by the dot's own look).
    const pop = freshMark(key, state === "needs" || state === "error" ? state : !state && unread ? "unread" : "") ? "m-pop" : "";
    return (
      <ChatRow key={key} id={key} name={r.name} pins={options} onHold={seeHint}>
        <button
          className={`csb-chat ${group ? "group" : ""} ${view === "room" && roomId === r.id ? "active" : ""} ${unread ? "unread" : ""}`}
          style={{ ["--c" as string]: group ? "var(--text-3)" : identity.color }}
          onClick={() => go(() => openRoom(r.id))}
          // One label that reads the whole row: its name, its state, when, and its machine when there are several.
          aria-label={rowLabel(facts, { unread, machine: multi ? machine.name : null })}
          title={multi ? `${r.name} · on ${machine.name}` : r.name}
        >
          {group ? <GroupAvatar members={group} size="sm" /> : <ChatAvatar identity={identity} size="sm" />}
          <span className="csb-chat-text">
            <span className="csb-chat-name">{r.name}</span>
            <span className={`csb-chat-sub ${state ? `is-${state}` : ""}`}>
              {/* The state's colour beside its words: an accent, never the only thing that says it. Helpers at work
                  turn like an agent at work. */}
              {state && <span className={`csb-dot ${state === "helpers" ? "busy" : state} ${state === "needs" || state === "error" ? pop : ""}`} aria-hidden="true" />}
              <span className="csb-chat-words">{rowStateWords(facts)}</span>
            </span>
          </span>
          {usesApiKey(r.id)(machine) && <ApiBadge />}
          {multi && <MachineTag name={machine.name} />}
          {unread && <span className={`reply-dot ${state ? "" : pop}`} aria-hidden="true" />}
        </button>
      </ChatRow>
    );
  };

  /** What a section's fold control shows and does (GroupFold.tsx): folded on this device, it says what's inside. */
  const foldOf = (section: ListSection, inside: Row[]): GroupFold => ({
    folded: isFolded(folded, section, !!q),
    foldable: canFold(section),
    ...sectionFold(section, inside),
    onFold: (v) => setFolded(section, v),
  });

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
  if (touch && !hintSeen && !q && rows.length > 0) {
    lines.push("h");
    list.push(
      <p key="h" className="csb-hint" data-line="h">
        <Pin size={13} aria-hidden="true" />
        <span className="csb-hint-text">Hold a chat to pin it</span>
        <button className="icon-btn csb-hint-close" onClick={seeHint} aria-label="Hide this tip">
          <X size={15} />
        </button>
      </p>,
    );
  }
  if (q) {
    // A search: every chat it finds, in one list in the same order, without the headings.
    const found = sections.flatMap((s) => s.rows);
    list.push(
      found.length ? (
        <div key="found" className="csb-found" role="group" aria-label="Chats found">
          {found.map(row)}
        </div>
      ) : (
        <p key="e" className="csb-empty" data-line="e">
          No chats match.
        </p>
      ),
    );
  } else if (!sections.length) {
    lines.push("e");
    list.push(
      <p key="e" className="csb-empty" data-line="e">
        {loading ? "Loading chats…" : "No chats yet."}
      </p>,
    );
  }
  for (const { section, rows: inside } of q ? [] : sections) {
    const fold = foldOf(section, inside);
    // Recent: the newest few, plus any with a reply you haven't read, or that you just unpinned. The other sections
    // show every chat they hold. Folded, none of them: folding is a choice, and the heading says what's inside.
    const cut = section === "recent" && !all[section];
    const shown = fold.folded ? [] : cut ? shownRows(inside, (c) => look(c) || pins.kept(c)) : inside;
    const more = section === "recent" && !fold.folded && (all[section] ? inside.length > SHOWN : inside.length > shown.length);
    lines.push(`g:${section}`);
    const drawn = shown.map(row);
    if (more) lines.push(`a:${section}`);
    if (saysWhatsInside(fold)) lines.push(`s:${section}`);
    list.push(
      <FoldableGroup
        key={section}
        className={`csb-${section}`}
        group={section}
        label={SECTION_TITLE[section]}
        title={section}
        heading={
          <h2 className="csb-heading">
            {section === "pinned" && <Pin size={13} aria-hidden="true" />}
            {SECTION_TITLE[section]}{" "}
            <span className="csb-count">{inside.length}</span>
          </h2>
        }
        {...fold}
      >
        {drawn}
        {more && (
          <button className="csb-more" onClick={() => setAll(section, !all[section])}>
            {all[section] ? "Show fewer" : `Show all ${inside.length}`}
          </button>
        )}
      </FoldableGroup>,
    );
  }
  // 2 or more characters also look inside every chat's messages, on every machine (search.ts).
  if (searchTerm(query)) list.push(<MessageHits key="hits" query={query} go={go} />);
  const order = lines.join("\n");
  const settings = ["settings", "setup", "devices"].includes(view);

  return (
    <aside className={`chat-sidebar ${drawer ? "drawer" : ""}`} aria-label="Chats" style={drawer || width === SIDEBAR_WIDTH ? undefined : { ["--csb-w" as string]: `${width}px` }}>
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
          <button ref={newButton} className="btn block csb-new" onClick={startNew} disabled={!canStart} aria-expanded={newMenu} aria-keyshortcuts={SHORTCUT_KEYS.create} title={touch ? undefined : `New chat (${SHORTCUT.create})`}>
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
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={searchKey} placeholder="Search chats" aria-label="Search chats" aria-keyshortcuts={SHORTCUT_KEYS.search} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {query ? (
            <button className="icon-btn" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={14} />
            </button>
          ) : (
            // With a keyboard at hand: how to get here from anywhere.
            !touch && (
              <kbd className="csb-key" aria-hidden="true">
                {SHORTCUT.search}
              </kbd>
            )
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
        onTouchStart={hold}
        onKeyDown={listKey}
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
              ? `${multi ? storageLow!.name : "This machine's"} storage is full: uploads paused`
              : `${multi ? storageLow!.name : "This machine's"} storage is low: ${formatBytes(storage.free)} free`}
          </button>
        )}
        {/* One row, like a phone's tab bar, so the chats keep the height: where the app's other screens are. */}
        <nav className="csb-tabs" aria-label="More">
          {/* A machine that can show its screen (or could, once set up): hubs from before that don't offer it. */}
          {hubScreen !== undefined && (
            <FootTab label="Screen" active={view === "screen"} live={hubScreen.ready} onClick={() => go(() => setView("screen"))}>
              <MonitorSmartphone size={20} aria-hidden="true" />
            </FootTab>
          )}
          <FootTab label="Bookmarks" active={view === "bookmarks"} onClick={() => go(() => setView("bookmarks"))}>
            <Bookmark size={20} aria-hidden="true" />
          </FootTab>
          <FootTab label="Terminal" active={view === "terminal"} onClick={() => go(() => setView("terminal"))}>
            <SquareTerminal size={20} aria-hidden="true" />
          </FootTab>
          <FootTab label="Settings" active={settings} onClick={() => go(() => setView("settings"))}>
            <Settings size={20} aria-hidden="true" />
          </FootTab>
        </nav>
      </div>
    </aside>
  );
}

/** The keyboard's requests the list has answered (sidebar.ts `asked`): kept here, so a list drawn just after one still answers it. */
const answered = { search: 0, create: 0 };

/**
 * The docked chats' right edge: drag it to make the list wider or narrower (← and → with a keyboard, Home and End for
 * the narrowest and the widest), and double-click it to put it back. The width is kept on this device (sidebar.ts).
 */
export function SidebarResizer() {
  const width = useSidebar((s) => s.width);
  const setWidth = useSidebar((s) => s.setWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove("resizing");
    // Kept once the drag is over.
    setWidth(useSidebar.getState().width);
  };
  useEffect(() => () => document.documentElement.classList.remove("resizing"), []);
  return (
    <div
      className="csb-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Chat list width"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize the chat list. Double-click to put it back."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        // From how wide the list is drawn: a small window holds it narrower than it was left. Distances on screen are
        // drawn bigger by the text size (zoom.ts), and the width is in the page's own pixels.
        const drawn = e.currentTarget.previousElementSibling?.getBoundingClientRect().width;
        drag.current = { x: e.clientX, width: drawn ? drawn / zoomFactor() : width };
        document.documentElement.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setWidth(d.width + (e.clientX - d.x) / zoomFactor(), false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH)}
      onKeyDown={(e) => {
        const to = e.key === "ArrowLeft" ? width - 16 : e.key === "ArrowRight" ? width + 16 : e.key === "Home" ? SIDEBAR_MIN : e.key === "End" ? SIDEBAR_MAX : null;
        if (to === null) return;
        e.preventDefault();
        setWidth(to);
      }}
    />
  );
}

/** One of the row of screens under the list: its icon with a small label under it, tinted while that screen is open. */
function FootTab({ label, active, live, onClick, children }: { label: string; active: boolean; live?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`csb-tab ${active ? "active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
      <span className="csb-tab-icon">{children}</span>
      <span className="csb-tab-label">{label}</span>
      {/* The machine's screen is being shown now. */}
      {live && <span className="csb-live" aria-label="live" />}
    </button>
  );
}
