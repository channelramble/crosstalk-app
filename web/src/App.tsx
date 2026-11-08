import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import type { Room } from "@crosstalk/shared";
import { api, type Connection } from "./api";
import { hubStore, machineName, machineOfRoom, useMachines, useStore, type Toast } from "./store";
import { isUnread } from "./chatList";
import { Pairing } from "./views/Pairing";
import { RoomView } from "./views/RoomView";
import { TerminalPage } from "./views/TerminalPage";
import { BookmarksPage } from "./views/BookmarksPage";
import { HomeScreen } from "./views/HomeScreen";
import { AgentScreen } from "./views/AgentScreen";
import { ChatScreen } from "./views/ChatScreen";
import { UsagePage } from "./views/UsagePage";
import { AppSettings } from "./views/AppSettings";
import { ChatSidebar, SidebarButton } from "./views/ChatSidebar";
import { NewChatDialog } from "./views/AgentScreen";
import { NewGroupDialog } from "./views/NewGroupDialog";
import { PoolChatDialog } from "./views/PoolChatDialog";
import { SignInHost } from "./views/SignInHost";
import { useSidebar } from "./sidebar";
import { showInSettings } from "./navigation";
import { thisDevice, timeShort, useBookPosture, useIsMobile } from "./ui";
import { EntranceScope, FlipGroup, leave } from "./motion";

export function App() {
  const conn = useStore((s) => s.conn);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    useStore
      .getState()
      .boot()
      .catch((e) => {
        // A revoked sign-in is handled by its machine (it's forgotten, with a note); anything else is worth saying.
        if (e?.status !== 401) useStore.getState().toast("error", e?.message ?? String(e));
      })
      .finally(() => setBooting(false));
  }, []);

  if (booting && !conn) return null;
  return (
    <>
      {conn ? <Shell /> : <Pairing />}
      <Toasts />
    </>
  );
}

function Shell() {
  const view = useStore((s) => s.view);
  const active = useStore((s) => s.active);
  const roomId = useStore((s) => s.roomId);
  const agent = useStore((s) => s.agent);
  const room = useStore((s) => (roomId ? s.rooms[roomId] : undefined));
  useMarkRead(view === "room" ? room : undefined);

  const main = (() => {
    switch (view) {
      case "room":
        // Chats (group chats too) get the chat screen; a room on an older machine's hub (no chat: it hasn't group chats)
        // still opens as it did there. A chat not known (yet) gets the chat screen's frame, saying what's going on.
        return room ? room.chat ? <ChatScreen key={`${useStore.getState().active}:${room.id}`} room={room} /> : <RoomView room={room} /> : roomId ? <ChatPending roomId={roomId} /> : <HomeScreen />;
      case "agent":
        return agent ? <AgentScreen provider={agent} /> : <HomeScreen />;
      case "settings":
      case "setup":
      case "devices":
        return <AppSettings key={active} />;
      case "usage":
        return <UsagePage />;
      case "terminal":
        return <TerminalPage />;
      case "bookmarks":
        return <BookmarksPage />;
      default:
        return <HomeScreen />;
    }
  })();

  const mobile = useIsMobile();
  // Half-folded like a book, the chats always take the left part of the screen (styles.css lines them up with it).
  const book = useBookPosture();
  const collapsed = useSidebar((s) => s.collapsed);
  const setCollapsed = useSidebar((s) => s.setCollapsed);
  const drawer = useSidebar((s) => s.drawer);
  const setDrawer = useSidebar((s) => s.setDrawer);
  const creating = useSidebar((s) => s.creating);
  const setCreating = useSidebar((s) => s.setCreating);
  const docked = book || (!mobile && !collapsed);
  // Each screen starts its own clock: what's drawn with it comes in still, what appears on it later can move in.
  const screenKey = `${view}|${roomId ?? ""}|${agent ?? ""}|${active}`;
  const since = useMemo(() => performance.now(), [screenKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!drawer || (mobile && !book)) return;
    // Unfolded (or half-folded like a book) with the chats drawer open: the list stays, docked beside the chat.
    setDrawer(false);
    if (!book) setCollapsed(false);
  }, [mobile, book, drawer, setDrawer, setCollapsed]);

  return (
    <div className={`app mobile single ${docked ? "docked" : ""}`}>
      <div className="shell">
        {docked && <ChatSidebar />}
        <div className="main">
          <EntranceScope since={since}>
            {main}
            {/* Drawn just under the screen's header (CSS order), never over it. After the screen in the page, so a keyboard
                and a reader get the screen's header first, and a strip that comes and goes never puts itself ahead of
                them (they're status lines: what they say is read out when it changes). */}
            <ConnStrip />
            <MacDialogStrip />
          </EntranceScope>
        </div>
      </div>
      {!docked && drawer && <Drawer onClose={() => setDrawer(false)} />}
      {creating?.kind === "group" ? (
        <NewGroupDialog
          onClose={() => {
            setCreating(null);
            setDrawer(false);
          }}
        />
      ) : creating?.kind === "pool" ? (
        /* The model pool: its own dialog until it's running (it can start the pool first), then New chat on it. */
        <PoolChatDialog
          target={creating}
          onClose={() => {
            setCreating(null);
            setDrawer(false);
          }}
        />
      ) : (
        creating && (
          <NewChatDialog
            target={creating}
            onClose={() => {
              setCreating(null);
              setDrawer(false);
            }}
          />
        )
      )}
      {/* Signing an agent in again (a chat's card, Settings, the setup checklist, a notice): over whatever is on screen. */}
      <SignInHost />
    </div>
  );
}

/**
 * The chats as a drawer over the screen (a phone). It slides in; when it closes it's gone at once, the screen under it
 * live, and a copy slides away. Not when the layout docked it (a foldable unfolding): the list is right there.
 */
function Drawer({ onClose }: { onClose: () => void }) {
  const scrim = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dim = scrim.current;
    return () => {
      const docked = () => !!document.querySelector(".chat-sidebar:not(.drawer)");
      const list = dim?.nextElementSibling;
      leave(dim, "scrim", { unless: docked });
      // Only the rows that show are copied: a list of hundreds leaves as cheaply as a screenful.
      if (list?.matches(".chat-sidebar.drawer")) leave(list, "drawer", { unless: docked, only: ".csb-scroll" });
    };
  }, []);
  return (
    <>
      <div ref={scrim} className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <ChatSidebar drawer />
    </>
  );
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

/**
 * The chat on screen is read, up to its last reply, while it's loaded and the app is visible. Its machine keeps that, and
 * tells every device, so reading on the Mac clears the mark on the iPhone too.
 */
function useMarkRead(room: Room | undefined) {
  const id = room?.id;
  const loaded = useStore((s) => !!id && !!s.roomData[id]?.loaded);
  const visible = useVisible();
  const reply = room?.lastReplyAt ?? null;
  const unread = !!room && isUnread(room);
  // Chats being marked read right now: one request at a time each. Once it's answered, a chat that shows as unread
  // again (a copy of it from before the read arrived late, say) is marked again.
  const asking = useRef(new Set<string>());
  useEffect(() => {
    if (!id || !loaded || !visible || !unread || reply === null || asking.current.has(id)) return;
    const key = machineOfRoom(id);
    const store = key !== null ? hubStore(key) : undefined;
    if (!store) return;
    asking.current.add(id);
    api<Room>("POST", `/api/rooms/${id}/read`, { at: reply }, store.getState().conn)
      .then((r) =>
        store.setState((s) => {
          const cur = s.rooms[id];
          return cur && (r?.readAt ?? 0) > (cur.readAt ?? 0) ? { rooms: { ...s.rooms, [id]: { ...cur, readAt: r.readAt } } } : s;
        }),
      )
      // Asked again the next time it's looked at.
      .catch(() => {})
      .finally(() => asking.current.delete(id));
  }, [id, loaded, visible, unread, reply]);
}

/** Settings → Machines. */
function openMachines() {
  useStore.getState().setView("settings");
  setTimeout(() => document.getElementById("machines")?.scrollIntoView({ block: "start" }), 150);
}

/**
 * A chat in the address that isn't on screen: "Opening chat…" while the machines load (never Home), and otherwise what
 * happened to it, with a way on: deleted on another device, on a machine that can't be reached, or on no machine this
 * device has.
 */
function ChatPending({ roomId }: { roomId: string }) {
  const machines = useMachines((m) => m.list);
  const gone = useStore((s) => s.goneRoom === roomId);
  const openRoom = useStore((s) => s.openRoom);
  const reconnectNow = useStore((s) => s.reconnectNow);
  const setDrawer = useSidebar((s) => s.setDrawer);
  const mobile = useIsMobile();
  const toChats = () => {
    openRoom(null);
    if (mobile) setDrawer(true);
  };
  // Machines that may still bring the chat: connecting (a first try, or back in a moment after a drop), connected with
  // their chats not in yet, or catching up after a reconnect (a chat made meanwhile comes in with that).
  const loading = machines.length === 0 || machines.some((m) => (m.status === "open" ? m.loadedAt === null || m.syncing : m.downSince === null));
  // Machines that aren't answering, whether or not they did earlier: the chat may be on one of them, made while it was
  // away (its notification can come through another machine), so it isn't "not found".
  const unreachable = machines.filter((m) => m.status !== "open" && m.downSince !== null);
  const goToChats = (
    <button className="btn" onClick={toChats}>
      Go to chats
    </button>
  );
  let title = "Opening chat…";
  let body: ReactNode = null;
  if (gone) {
    title = "Chat deleted";
    body = (
      <>
        <p>This chat was deleted on another device.</p>
        <div className="row wrap pending-actions">{goToChats}</div>
      </>
    );
  } else if (!loading && unreachable.length) {
    body = (
      <>
        <p>
          Can't reach {unreachable.map((m) => m.name).join(" or ")} yet. The chat may be there: it opens once {unreachable.length === 1 ? "it answers" : "they answer"}.
        </p>
        <div className="row wrap pending-actions">
          <button className="btn primary" onClick={() => unreachable.forEach((m) => reconnectNow(m.key))}>
            Try now
          </button>
          {goToChats}
        </div>
      </>
    );
  } else if (!loading) {
    title = "Chat not found";
    body = (
      <>
        <p>Couldn't find this chat. It may have been deleted, or it's on a machine {thisDevice()} hasn't added.</p>
        <div className="row wrap pending-actions">
          {goToChats}
          <button className="btn" onClick={openMachines}>
            Machines
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <SidebarButton />
        <div className="titles">
          <h1>{title}</h1>
        </div>
      </header>
      <div className="messages chat-pending">
        <div className="empty" role="status">
          <div>{body ?? <Loader2 size={22} className="spin muted" aria-label="Opening chat…" />}</div>
        </div>
      </div>
    </>
  );
}

/** An address on this computer: Tailscale has nothing to do with reaching it. */
function isLocal(c: Connection | null): boolean {
  try {
    return /^(localhost|127\.|\[::1\])/.test(new URL(c?.baseUrl || location.origin).hostname);
  } catch {
    return false;
  }
}

/** Shows `children` once they've been asked for this long, so a quick first connection doesn't flash a line. */
function Later({ ms, children }: { ms: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return shown ? children : null;
}

/** Can't reach the machine for this long: when it started, what to check, and Try now. */
const LONG_DOWN_MS = 20_000;
/** Catching up has failed for this long (the socket up, the state not coming): why, in the hub's words, and Try now. */
const STUCK_SYNC_MS = 10_000;

/** The hub's words, ending as a sentence does. */
const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * Under each screen's header: the machine on screen can't be reached (one steady line, naming it, with Try now once
 * it's been a while), it's catching up (only when that takes a while; why it can't, and Try now, once that has gone on
 * a while), or the app was updated. A drop that's back within BLIP_MS (hubStore.ts) says nothing.
 */
function ConnStrip() {
  const status = useStore((s) => s.status);
  const syncing = useStore((s) => s.syncSlow);
  const syncError = useStore((s) => s.syncError);
  const downSince = useStore((s) => s.downSince);
  const updateReady = useStore((s) => s.updateReady);
  const name = useStore((s) => (s.conn ? machineName(s.conn, s.hub) : "the hub"));
  const local = useStore((s) => isLocal(s.conn));
  const reconnectNow = useStore((s) => s.reconnectNow);
  const [now, setNow] = useState(() => Date.now());
  const [trying, setTrying] = useState(false);
  const down = status !== "open" && downSince !== null;
  const failing = status === "open" && syncing && syncError !== null;
  useEffect(() => {
    if (!down && !failing) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [down, failing]);
  useEffect(() => {
    if (!trying) return;
    const t = setTimeout(() => setTrying(false), 2000);
    return () => clearTimeout(t);
  }, [trying]);
  // Not `disabled` while it tries: a browser drops the focus of a button it disables, and the keyboard would lose its place.
  const tryNow = (
    <button
      className="btn small"
      aria-disabled={trying || undefined}
      onClick={() => {
        if (trying) return;
        setTrying(true);
        reconnectNow();
      }}
    >
      {trying ? "Trying…" : "Try now"}
    </button>
  );
  if (down) {
    const long = now - downSince >= LONG_DOWN_MS;
    return (
      <div className="conn-strip down" role="status">
        <span className="status-dot closed" aria-hidden="true" />
        <span className="conn-strip-text">
          <span>Can't reach {name}. Trying again…</span>
          {long && <span className="conn-strip-note">Since {timeShort(downSince)}. {local ? "Check that Crosstalk is running." : "Check that Tailscale is on."}</span>}
        </span>
        {long && tryNow}
      </div>
    );
  }
  if (status !== "open") {
    return (
      <Later ms={1000}>
        <div className="conn-strip" role="status">
          <span className="status-dot connecting" aria-hidden="true" />
          <span className="conn-strip-text">Connecting to {name}…</span>
        </div>
      </Later>
    );
  }
  if (syncing) {
    // The socket is up but the state isn't coming (a hub swapping, a locked database): after a while, why, and the same
    // way on as a machine that can't be reached.
    const stuck = failing && now - syncError.since >= STUCK_SYNC_MS;
    return (
      <div className="conn-strip" role="status">
        <span className="status-dot connecting" aria-hidden="true" />
        <span className="conn-strip-text">
          <span>Getting the latest from {name}…</span>
          {stuck && <span className="conn-strip-note">Since {timeShort(syncError.since)}. {sentence(syncError.text)}</span>}
        </span>
        {stuck && tryNow}
      </div>
    );
  }
  return updateReady ? <UpdateBanner /> : null;
}

/**
 * A privacy dialog waiting on a Mac hub's screen (macOS asks there, and nothing goes on for that program until someone
 * answers it on the Mac), on any paired machine: said on every screen, with the way to it in Settings → This Mac.
 */
function MacDialogStrip() {
  const machines = useMachines((m) => m.list);
  const active = useStore((s) => s.active);
  const setView = useStore((s) => s.setView);
  const activate = useStore((s) => s.activate);
  const waiting = machines.find((m) => m.macDialogs.length > 0);
  if (!waiting) return null;
  const first = waiting.macDialogs[0];
  const more = machines.reduce((n, m) => n + m.macDialogs.length, 0) - 1;
  const details = () => {
    if (waiting.key !== active) activate(waiting.key);
    // Settings lands on This Mac itself, on screen already or not (AppSettings hears this): saying it twice would ask
    // twice about unsaved changes.
    showInSettings("this-mac");
    setView("settings");
  };
  return (
    <div className="conn-strip mac-strip">
      <span className="conn-strip-text" role="status">
        <span>{waiting.name} is waiting for an answer on its screen.</span>
        <span className="conn-strip-note">
          {first.app} wants {first.wants}
          {more > 0 ? `, and ${more} more` : ""}.
        </span>
      </span>
      <button className="btn small" onClick={details}>
        Details
      </button>
    </div>
  );
}

/** Shown when the hub has a newer app than this page is running; drafts are saved, so reloading is safe. */
function UpdateBanner() {
  const pending = useStore((s) => s.pendingAttachments);
  const reload = () => {
    // Drafts are saved, but attachments only live in this page until they're sent.
    if (pending && !confirm(`Reloading removes ${pending} attachment${pending === 1 ? "" : "s"} you haven't sent yet. Reload anyway?`)) return;
    location.reload();
  };
  return (
    <div className="conn-strip update-banner" role="status">
      <span className="conn-strip-text">Crosstalk was updated.{pending > 0 && " Send your attachments first, then reload."}</span>
      <button className="btn small primary" onClick={reload}>Reload</button>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const machines = useMachines((m) => m.list);
  // A request's notice goes as soon as the request is answered, on any device.
  const answered = (t: Toast) => !!t.approval && machines.find((m) => m.key === t.approval!.machine)?.approvals[t.approval.id]?.status !== "pending";
  const done = toasts.filter(answered);
  useEffect(() => {
    for (const t of done) dismiss(t.id);
  });
  const shown = toasts.filter((t) => !done.includes(t));
  // Always there, empty or not: words added to a live region already on the page are read out more reliably than a new
  // one's. A notice drops in; when one goes, the others glide to their new places.
  return (
    <FlipGroup className="toasts" role="status" aria-live="polite" order={shown.map((t) => t.id).join("\n")}>
      {shown.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </FlipGroup>
  );
}

/**
 * A notice. It stays longer the more it says (toastMs), waits while it's touched (held down: a pointer just resting on
 * it doesn't keep it up), and the same notice coming again counts up (×2, with a pop) and starts its time over. When it
 * goes, it's gone at once and a copy rises away.
 */
function ToastItem({ toast: t }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  const [held, setHeld] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => () => leave(box.current, "toast"), []);
  const left = useRef(t.ms);
  useEffect(() => {
    left.current = t.ms;
  }, [t.count, t.ms]);
  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(t.id), left.current);
    // Let go: a moment more to read it, at least.
    return () => {
      clearTimeout(timer);
      left.current = Math.max(2000, left.current - (Date.now() - started));
    };
  }, [held, t.id, t.count, dismiss]);
  return (
    <div ref={box} data-flip={t.id} className={`toast ${t.level}`} onPointerDown={() => setHeld(true)} onPointerUp={() => setHeld(false)} onPointerCancel={() => setHeld(false)} onPointerLeave={() => setHeld(false)}>
      <div className="toast-text">
        {t.text}
        {t.count > 1 && (
          <>
            {" "}
            {/* A new element for each count, so each repeat pops it again. */}
            <span key={t.count} className="toast-count">
              ×{t.count}
            </span>
          </>
        )}
      </div>
      {t.action && (
        <button
          className="btn small primary toast-action"
          onClick={() => {
            dismiss(t.id);
            t.action!.run();
          }}
        >
          {t.action.label}
        </button>
      )}
      <button className="icon-btn toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
