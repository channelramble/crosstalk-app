// Bookmarks (sidebar → Bookmarks): the messages kept from every chat, on every machine, newest bookmark first. Each
// opens its chat at the message, can be copied, or taken out. Each machine keeps its own chats' bookmarks, so each is
// asked on its own: one that can't answer says so under the list and never holds back the others.

import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark as BookmarkIcon, BookmarkX, MessageSquareText, Search } from "lucide-react";
import type { Bookmark } from "@crosstalk/shared";
import { PROVIDER_INFO } from "@crosstalk/shared";
import { allBookmarks, bookmarkWho, bookmarksProblem, listBookmarks, saveBookmark, withBookmark, type FoundBookmark } from "../bookmarks";
import { hitTime } from "../search";
import { hubStore, useMachines, useStore } from "../store";
import { CopyReply } from "./RoomView";
import { SidebarButton } from "./ChatSidebar";
import { MachineTag } from "./MachinePicker";
import { openHit } from "./useFindMessage";

type Slot = { bookmarks: Bookmark[] | null; problem: string | null; busy: boolean };
/** Past this many, a field to find one by its words. */
const FILTER_FROM = 6;

export function BookmarksPage() {
  const machines = useMachines((m) => m.list);
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const [filter, setFilter] = useState("");
  // What each machine's list was loaded for: a machine is asked again when its bookmarks change (any device's), or once
  // it's back.
  const asked = useRef(new Map<string, unknown>());

  const ask = (key: string) => {
    const m = useMachines.getState().list.find((x) => x.key === key);
    if (!m) return;
    asked.current.set(key, m.bookmarked);
    setSlots((s) => ({ ...s, [key]: { bookmarks: s[key]?.bookmarks ?? null, problem: null, busy: true } }));
    listBookmarks(m.conn).then(
      (bookmarks) => setSlots((s) => ({ ...s, [key]: { bookmarks, problem: null, busy: false } })),
      (e) => setSlots((s) => ({ ...s, [key]: { bookmarks: s[key]?.bookmarks ?? null, problem: bookmarksProblem(e), busy: false } })),
    );
  };
  useEffect(() => {
    for (const m of machines) {
      if (m.status !== "open") continue;
      if (asked.current.has(m.key) && asked.current.get(m.key) === m.bookmarked) continue;
      ask(m.key);
    }
  }, [machines]); // eslint-disable-line react-hooks/exhaustive-deps

  const multi = machines.length > 1;
  const all = useMemo(() => allBookmarks(machines.map((m) => ({ key: m.key, name: m.name, bookmarks: slots[m.key]?.bookmarks ?? null }))), [machines, slots]);
  const q = filter.trim().toLowerCase();
  const shown = q ? all.filter((b) => `${b.text}\n${b.roomName}\n${b.agent ?? ""}`.toLowerCase().includes(q)) : all;
  const loading = machines.some((m) => m.status === "open" && !slots[m.key]?.bookmarks && !slots[m.key]?.problem);
  const problems = machines.flatMap((m) => {
    const p = slots[m.key]?.problem ?? (m.status !== "open" && m.downSince !== null ? "It isn't answering." : null);
    return p ? [{ key: m.key, name: m.name, problem: p, busy: !!slots[m.key]?.busy }] : [];
  });

  const remove = async (b: FoundBookmark) => {
    const m = useMachines.getState().list.find((x) => x.key === b.machineKey);
    if (!m) return;
    try {
      const r = await saveBookmark(b.messageId, false, m.conn);
      setSlots((s) => ({ ...s, [b.machineKey]: { ...s[b.machineKey]!, bookmarks: (s[b.machineKey]?.bookmarks ?? []).filter((x) => x.messageId !== b.messageId) } }));
      hubStore(b.machineKey)?.setState((s) => ({ bookmarked: withBookmark(s.bookmarked, b.messageId, r.at) }));
      asked.current.set(b.machineKey, hubStore(b.machineKey)?.getState().bookmarked);
    } catch (e) {
      useStore.getState().toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <SidebarButton />
        <div className="titles">
          <h1>Bookmarks</h1>
          <div className="sub">Messages you kept, from every chat</div>
        </div>
      </header>
      <div className="page">
        <div className="page-inner bookmarks">
          {all.length >= FILTER_FROM && (
            <label className="bookmarks-filter">
              <Search size={15} aria-hidden="true" />
              <input className="input" type="search" placeholder="Find a bookmark" aria-label="Find a bookmark" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
          )}
          {loading && !all.length && (
            <p className="muted" role="status">
              Loading bookmarks…
            </p>
          )}
          {!loading && !all.length && (
            <div className="empty bookmarks-empty">
              <div>
                <BookmarkIcon size={28} aria-hidden="true" />
                <div className="big">No bookmarks yet</div>
                <p>Tap a message in any chat, then Bookmark, to keep it here.</p>
              </div>
            </div>
          )}
          {q && all.length > 0 && !shown.length && <p className="muted">No bookmark has those words.</p>}
          <ul className="bookmark-list" aria-label="Bookmarks">
            {shown.map((b) => (
              <BookmarkCard key={`${b.machineKey}/${b.messageId}`} b={b} multi={multi} onRemove={() => remove(b)} />
            ))}
          </ul>
          {problems.map((p) => (
            <p key={p.key} className="help bookmarks-problem">
              {multi ? `${p.name}: ` : ""}
              {p.problem}{" "}
              <button className="link-action" disabled={p.busy} onClick={() => (machines.find((m) => m.key === p.key)?.status === "open" ? ask(p.key) : useStore.getState().reconnectNow(p.key))}>
                {p.busy ? "Trying…" : "Try again"}
              </button>
            </p>
          ))}
        </div>
      </div>
    </>
  );
}

/** Longer than this many characters, a bookmark shows its start, and "Show more". */
const SHORT = 420;

function BookmarkCard({ b, multi, onRemove }: { b: FoundBookmark; multi: boolean; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const room = useMachines((m) => m.list.find((x) => x.key === b.machineKey)?.rooms[b.roomId]);
  const provider = room?.chat?.provider;
  // A group chat's agents go by their @handles; a one-agent chat's by its kind of agent, as the chat shows it.
  const who = bookmarkWho(b, provider && !room?.chat?.group ? PROVIDER_INFO[provider].name : null);
  const long = b.text.length > SHORT;
  const text = long && !open ? `${b.text.slice(0, SHORT).trimEnd()}…` : b.text;
  return (
    <li className="card bookmark-card">
      <div className="bookmark-head">
        <MessageSquareText size={14} aria-hidden="true" />
        <span className="bookmark-chat">{room?.name ?? b.roomName}</span>
        {multi && <MachineTag name={b.machineName} />}
        <span className="csb-time">{hitTime(b.createdAt)}</span>
      </div>
      <div className="bookmark-who">{who}</div>
      <div className="bookmark-text">{text}</div>
      {(long || b.cut) && (
        <div className="bookmark-more">
          {long && (
            <button className="link-action" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Show less" : "Show more"}
            </button>
          )}
          {b.cut && open && <span className="muted small">The rest is in the chat.</span>}
        </div>
      )}
      <div className="bookmark-actions">
        <button className="link-action" onClick={() => openHit({ machineKey: b.machineKey, roomId: b.roomId, messageId: b.messageId, query: "" })}>
          <MessageSquareText size={12} /> Open in chat
        </button>
        <CopyReply text={b.text} label="Copy message" />
        <button
          className="link-action"
          disabled={removing}
          onClick={async () => {
            setRemoving(true);
            await onRemove();
            setRemoving(false);
          }}
        >
          <BookmarkX size={12} /> {removing ? "Removing…" : "Remove"}
        </button>
      </div>
    </li>
  );
}
