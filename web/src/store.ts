import { create } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { hubWasUpdated } from "./version";
import { canNavigate, showInSettings } from "./navigation";
import { accountKey } from "./accounts";
import type { RoomAgentActivity } from "./roomActivity";
import { PROVIDER_INFO, memberAccount, signInAgentWords, type Approval, type ChatProvider, type HubInfo, type ImageEditorStatus, type MacStatus, type Member, type PtyInfo, type PoolView, type Room, type SignInNeed, type StorageStatus } from "@crosstalk/shared";
import { api, setConnection, type Connection } from "./api";
import { createHubStore, emptyHubData, type HubData, type HubHooks, type HubState } from "./hubStore";
import { loadMachines, machineKey, saveMachines } from "./machines";
import { requestWords } from "./chatList";
import { openSignIn } from "./signInSheet";

export type { RoomData } from "./hubStore";

/** "rooms" is the home screen (pick an agent); "agent" is one agent's chats; "room" is a chat. */
export type View = "rooms" | "agent" | "room" | "usage" | "setup" | "devices" | "terminal" | "approvals" | "settings" | "bookmarks";

export interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
  /** A button on it ("Open"); tapping it closes the notice too. */
  action?: { label: string; run: () => void };
  /** A request's notice (its machine and id): it closes as soon as the request is answered, on any device. */
  approval?: { machine: string; id: string };
  /** How many times the same notice came (shown as ×3). */
  count: number;
  /** How long it stays (see toastMs), from the last time it came. */
  ms: number;
}

export interface ToastOptions {
  action?: Toast["action"];
  approval?: Toast["approval"];
}

/** How long a notice stays: about 5 s plus 60 ms a character, up to 10 s (15 s for an error). */
export function toastMs(level: Toast["level"], text: string): number {
  return Math.min(level === "error" ? 15_000 : 10_000, 5_000 + 60 * text.length);
}

/**
 * The app's state: the screens it shows, plus the hub data of the active machine (the one whose chat or settings
 * are on screen), mirrored from that machine's own store. Every paired machine stays connected in the background;
 * `useMachines` has what the sidebar shows for all of them.
 */
interface State extends Omit<HubData, "conn"> {
  conn: Connection | null;
  /** Attachments in the composer that haven't been sent; reloading would lose them. */
  pendingAttachments: number;
  view: View;
  roomId: string | null;
  /** The agent whose chats are showing (view "agent"). */
  agent: ChatProvider | null;
  showAgents: boolean;
  toasts: Toast[];
  /** The machine whose screens are showing (see machineKey). */
  active: string;
  /** The chat on screen was deleted on another device: its screen says so (until you go elsewhere). */
  goneRoom: string | null;

  /** Starts with the machines this device is paired with. */
  boot(): Promise<void>;
  /** Pairs with a machine (or replaces its sign-in) and shows it. */
  connect(c: Connection): Promise<void>;
  /** This device was signed out of the active machine: forget it here. */
  disconnect(): void;
  /** Adds a machine without switching to it. */
  addMachine(c: Connection): Promise<void>;
  removeMachine(key: string): void;
  /** Shows another machine's screens (chats keep running on every machine either way). */
  activate(key: string): void;
  refresh(): Promise<void>;
  /** Try now on a machine that can't be reached (the active one unless `key` says), without waiting between tries. */
  reconnectNow(key?: string): void;
  refreshAccounts(): Promise<void>;
  /** The active machine's model pool (see HubActions.loadPool and poolCall). */
  loadPool(): Promise<PoolView>;
  poolCall(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<PoolView>;
  /** The active machine's image editor (see HubActions.imageEditorCall). */
  imageEditorCall(on?: boolean, force?: boolean): Promise<ImageEditorStatus>;
  /** The active machine as a Mac server (see HubActions.loadMac, openOnMac, dismissMacDialog). */
  loadMac(): Promise<MacStatus>;
  openOnMac(pane: "fullDisk" | "login" | "energy" | "updates" | "privacy"): Promise<void>;
  dismissMacDialog(id: string): Promise<void>;
  stopMacAsker(id: string): Promise<void>;
  fixOnMac(what: "autologin" | "power"): Promise<PtyInfo>;
  dismissMacCrash(): Promise<MacStatus>;
  openRoom(id: string | null): void;
  openAgent(p: ChatProvider): void;
  setView(v: View): void;
  setShowAgents(v: boolean): void;
  loadHistory(roomId: string, older?: boolean): Promise<void>;
  /** A step of a chat whole (see HubActions.loadActivity), from the machine the chat is on. */
  loadActivity(roomId: string, activityId: string): Promise<void>;
  /** A notice at the top of the screen. The same one again adds to it (×2) instead of stacking up. */
  toast(level: Toast["level"], text: string, opts?: ToastOptions): void;
  dismissToast(id: number): void;
  sendPty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
}

/** What the sidebar and home screen show for each paired machine. */
export interface Machine {
  key: string;
  conn: Connection;
  /** Its hub's name ("Mac mini"), or its address until the hub has answered. */
  name: string;
  status: HubData["status"];
  syncing: boolean;
  /** Since when it can't be reached (null while connected or on the first try). */
  downSince: number | null;
  /** When its chats last came in (null until they first have). */
  loadedAt: number | null;
  hub: HubInfo | null;
  rooms: Record<string, Room>;
  members: Record<string, Member>;
  approvals: Record<string, Approval>;
  roomActivity: Record<string, RoomAgentActivity[]>;
  storage: StorageStatus | null;
  accounts: HubData["accounts"];
  providers: HubData["providers"];
  /** On a Mac hub: privacy dialogs waiting on its screen. */
  macDialogs: HubData["macDialogs"];
  /** Its templates (null until known, and from a hub before templates). */
  templates: HubData["templates"];
  /** Its model pool as a model to chat with (null from a hub before the offer). */
  poolOffer: HubData["poolOffer"];
  /** Its bookmarked messages (null until known, and from a hub before bookmarks). */
  bookmarked: HubData["bookmarked"];
}

export const useMachines = create<{ list: Machine[] }>(() => ({ list: [] }));

/** The hub fields mirrored from the active machine's store. */
const HUB_FIELDS = ["status", "syncing", "syncSlow", "syncError", "downSince", "loadedAt", "updateReady", "hub", "device", "rooms", "roomActivity", "members", "approvals", "usage", "accounts", "providers", "logins", "ptys", "roomData", "tasks", "storage", "memory", "pool", "poolOffer", "imageEditor", "macDialogs", "asks", "spend", "templates", "signIns", "signInSessions", "bookmarked"] as const;
type HubField = (typeof HUB_FIELDS)[number];

function pickHub(s: HubData): Pick<State, HubField | "conn"> {
  const out = { conn: s.conn } as Pick<State, HubField | "conn">;
  for (const k of HUB_FIELDS) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

const hubs = new Map<string, StoreApi<HubState>>();
const unsubscribe = new Map<string, () => void>();
let unmirror: (() => void) | null = null;
let toastSeq = 1;

type PtyListener = (data: string) => void;
const ptyListeners = new Map<string, Set<PtyListener>>();
export function onPtyData(id: string, fn: PtyListener): () => void {
  let s = ptyListeners.get(id);
  if (!s) ptyListeners.set(id, (s = new Set()));
  s.add(fn);
  return () => s!.delete(fn);
}

/** What a machine is called: its hub's name, or its address until known. */
export function machineName(conn: Connection, hub: HubInfo | null): string {
  if (hub?.name) return hub.name;
  if (hub?.hostname) return hub.hostname.replace(/\.local$/, "");
  if (!conn.baseUrl) return "This hub";
  try {
    return new URL(conn.baseUrl).host.split(".")[0];
  } catch {
    return conn.baseUrl;
  }
}

/** The machine a chat is on, if any machine has it. */
export function machineOfRoom(roomId: string): string | null {
  for (const [key, store] of hubs) if (store.getState().rooms[roomId]) return key;
  return null;
}

/** A machine's own store (for screens that work with a machine other than the active one). */
export function hubStore(key: string): StoreApi<HubState> | undefined {
  return hubs.get(key);
}

function routeFromHash(): { view: View; roomId: string | null; agent: ChatProvider | null } {
  const h = location.hash.replace(/^#\/?/, "");
  const [view, id] = h.split("/");
  if (view === "room" && id) return { view: "room", roomId: id, agent: null };
  if (view === "agent" && (id === "claude" || id === "codex")) return { view: "agent", roomId: null, agent: id };
  // A section or a tab to open Settings at: #/settings/agent-setup (the tray app links there), #/settings/machines.
  // Settings works out which tab holds it (settingsTabs.ts), so every section id it has ever had still lands.
  if (view === "settings" && id && /^[\w-]{1,40}$/.test(id)) showInSettings(id);
  if (["usage", "setup", "devices", "terminal", "approvals", "settings", "bookmarks"].includes(view)) return { view: view as View, roomId: null, agent: null };
  return { view: "rooms", roomId: null, agent: null };
}

/**
 * The last chat (and its machine) or agent page opened on this device, or Home. The app opens it again when it starts
 * without an address: iOS starts a home-screen app it closed from its start address, which would mean Home.
 */
type LastScreen = { view: "room"; roomId: string; machine: string } | { view: "agent"; agent: ChatProvider } | { view: "rooms" };
const LAST_KEY = "crosstalk.last.v1";

function loadLast(): LastScreen | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as LastScreen | null;
    if (v?.view === "room" && typeof v.roomId === "string" && v.roomId) return { view: "room", roomId: v.roomId, machine: typeof v.machine === "string" ? v.machine : "" };
    if (v?.view === "agent" && (v.agent === "claude" || v.agent === "codex")) return v;
    if (v?.view === "rooms") return v;
  } catch {
    // unreadable: start at Home
  }
  return null;
}

function saveLast(v: LastScreen) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch {
    // storage unavailable: the app starts at Home next time
  }
}

/** No screen in the address: the app's start address (its icon), not "#/" (Home). */
const noAddress = () => !location.hash || location.hash === "#";

/** Where the app starts: the address, or with none (opened from its icon), the last screen saved on this device. */
function startRoute(): { view: View; roomId: string | null; agent: ChatProvider | null; machine: string | null } {
  if (!noAddress()) return { ...routeFromHash(), machine: null };
  const last = loadLast();
  if (last?.view === "room") return { view: "room", roomId: last.roomId, agent: null, machine: last.machine };
  if (last?.view === "agent") return { view: "agent", roomId: null, agent: last.agent, machine: null };
  return { view: "rooms", roomId: null, agent: null, machine: null };
}

/** Chats this device is deleting: their deletion isn't news (it's not "deleted on another device"). */
const deletingHere = new Set<string>();

/** Deletes a chat on the active machine, from this device. */
export async function deleteRoomHere(roomId: string): Promise<void> {
  deletingHere.add(roomId);
  try {
    await api("DELETE", `/api/rooms/${roomId}`);
  } catch (e) {
    deletingHere.delete(roomId);
    throw e;
  }
}

/** The address for a screen, so reloads and the back button land on it again. */
function hashFor(view: View, roomId: string | null, agent: ChatProvider | null): string {
  if (view === "room" && roomId) return `#/room/${roomId}`;
  if (view === "agent" && agent) return `#/agent/${agent}`;
  return view === "rooms" ? "#/" : `#/${view}`;
}

const noMachine = (): Pick<State, HubField | "conn"> => ({ ...pickHub(emptyHubData({ baseUrl: "", token: "", deviceName: "" })), conn: null });

export const useStore = create<State>((set, get) => {
  const persist = () => {
    saveMachines({ list: [...hubs.values()].map((s) => s.getState().conn), active: get().active });
  };

  /** Keeps the sidebar's view of every machine current (only when something it shows changed). */
  const summarize = () => {
    const prev = useMachines.getState().list;
    const list: Machine[] = [...hubs.entries()].map(([key, store]) => {
      const s = store.getState();
      const old = prev.find((m) => m.key === key);
      const next: Machine = { key, conn: s.conn, name: machineName(s.conn, s.hub), status: s.status, syncing: s.syncing, downSince: s.downSince, loadedAt: s.loadedAt, hub: s.hub, rooms: s.rooms, members: s.members, approvals: s.approvals, roomActivity: s.roomActivity, storage: s.storage, accounts: s.accounts, providers: s.providers, macDialogs: s.macDialogs, templates: s.templates, poolOffer: s.poolOffer, bookmarked: s.bookmarked };
      return old && (Object.keys(next) as (keyof Machine)[]).every((k) => old[k] === next[k]) ? old : next;
    });
    if (list.length !== prev.length || list.some((m, i) => m !== prev[i])) useMachines.setState({ list });
    // A chat opened by its address (a reload, a notification) may be on a machine other than the active one.
    const { view, roomId, active } = get();
    if (view === "room" && roomId && !hubs.get(active)?.getState().rooms[roomId]) {
      const key = machineOfRoom(roomId);
      if (key !== null && key !== active) get().activate(key);
    }
  };

  const hooksFor = (key: string): HubHooks => ({
    toast: (level, text) => get().toast(level, text),
    openRoomId: () => (get().view === "room" ? get().roomId : null),
    roomGone: (roomId) => {
      const here = deletingHere.delete(roomId);
      if (get().roomId !== roomId) return;
      // Deleted from Settings or another screen: nothing to say there.
      if (get().view !== "room") set({ roomId: null });
      // Deleted on this device: off to Home (its dialog then goes on to the agent's page).
      else if (here) {
        set({ roomId: null, view: "rooms" });
        history.replaceState(null, "", hashFor("rooms", null, null));
      }
      // Deleted on another device while it's open here: its screen says so.
      else set({ goneRoom: roomId });
      // The next start isn't on it.
      if (lastScreen.startsWith(`{"view":"room","roomId":${JSON.stringify(roomId)},`)) remember({ view: "rooms" });
    },
    signedOut: () => {
      const store = hubs.get(key);
      const name = store ? machineName(store.getState().conn, store.getState().hub) : "a machine";
      get().removeMachine(key);
      get().toast("error", hubs.size ? `This device was signed out of ${name}. Add it again in Settings → Machines.` : "This device is no longer paired. Connect it again to continue.");
    },
    approval: (a, s) => announceRequest(key, a, s),
    ptyData: (ptyId, data) => ptyListeners.get(ptyId)?.forEach((fn) => fn(data)),
    signInNeeded: (need) => announceSignIn(key, need),
  });

  const makeHub = (c: Connection): StoreApi<HubState> => {
    const key = machineKey(c);
    const old = hubs.get(key);
    if (old) {
      old.getState().stop();
      unsubscribe.get(key)?.();
    }
    const store = createHubStore(c, hooksFor(key));
    hubs.set(key, store);
    unsubscribe.set(key, store.subscribe(summarize));
    if (get().active === key && hubs.size) {
      // Replacing the active machine's sign-in: mirror the new store.
      unmirror?.();
      unmirror = null;
      get().activate(key);
    }
    return store;
  };

  const initial = startRoute();
  // Opened from its icon, on the last chat: the address says so too, so a reload stays on it.
  if (noAddress() && initial.view !== "rooms") history.replaceState(null, "", hashFor(initial.view, initial.roomId, initial.agent));

  return {
    ...noMachine(),
    pendingAttachments: 0,
    view: initial.view,
    roomId: initial.roomId,
    agent: initial.agent,
    showAgents: false,
    toasts: [],
    active: "",
    goneRoom: null,

    async boot() {
      const saved = loadMachines();
      if (!saved.list.length) return;
      for (const c of saved.list) makeHub(c);
      // The last chat's machine first, when the app reopens it.
      const preferred = initial.machine !== null && hubs.has(initial.machine) ? initial.machine : saved.active;
      const first = hubs.has(preferred) ? preferred : [...hubs.keys()][0];
      get().activate(first);
      summarize();
      const starts = [...hubs.entries()].map(([key, s]) => s.getState().start().catch((e) => {
        if (key === first) throw e;
      }));
      await starts[[...hubs.keys()].indexOf(first)];
      void Promise.allSettled(starts);
    },

    async connect(c) {
      const store = makeHub(c);
      get().activate(machineKey(c));
      persist();
      summarize();
      await store.getState().start();
    },

    disconnect() {
      get().removeMachine(get().active);
    },

    async addMachine(c) {
      const store = makeHub(c);
      if (hubs.size === 1) get().activate(machineKey(c));
      persist();
      summarize();
      await store.getState().start();
    },

    removeMachine(key) {
      const store = hubs.get(key);
      if (!store) return;
      store.getState().stop();
      unsubscribe.get(key)?.();
      unsubscribe.delete(key);
      hubs.delete(key);
      if (get().active === key) {
        unmirror?.();
        unmirror = null;
        const next = hubs.has("") ? "" : [...hubs.keys()][0];
        if (next !== undefined) get().activate(next);
        else {
          setConnection(null);
          set({ ...noMachine(), active: "" });
        }
      }
      persist();
      summarize();
    },

    activate(key) {
      const store = hubs.get(key);
      if (!store) return;
      if (get().active === key && unmirror) return;
      unmirror?.();
      setConnection(store.getState().conn);
      set({ active: key, ...pickHub(store.getState()) });
      unmirror = store.subscribe((s) => set(pickHub(s)));
      persist();
    },

    async refresh() {
      await hubs.get(get().active)?.getState().refresh();
    },

    reconnectNow(key) {
      hubs.get(key ?? get().active)?.getState().reconnectNow();
    },

    async refreshAccounts() {
      await hubs.get(get().active)?.getState().refreshAccounts();
    },

    loadPool() {
      const store = hubs.get(get().active);
      return store ? store.getState().loadPool() : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    poolCall(method, path, body, timeoutMs) {
      const store = hubs.get(get().active);
      return store ? store.getState().poolCall(method, path, body, timeoutMs) : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    imageEditorCall(on, force) {
      const store = hubs.get(get().active);
      return store ? store.getState().imageEditorCall(on, force) : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    loadMac() {
      const store = hubs.get(get().active);
      return store ? store.getState().loadMac() : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    openOnMac(pane) {
      const store = hubs.get(get().active);
      return store ? store.getState().openOnMac(pane) : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    dismissMacDialog(id) {
      const store = hubs.get(get().active);
      return store ? store.getState().dismissMacDialog(id) : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    stopMacAsker(id) {
      const store = hubs.get(get().active);
      return store ? store.getState().stopMacAsker(id) : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    fixOnMac(what) {
      const store = hubs.get(get().active);
      return store ? store.getState().fixOnMac(what) : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    dismissMacCrash() {
      const store = hubs.get(get().active);
      return store ? store.getState().dismissMacCrash() : Promise.reject(new Error("No machine is connected. Pair one first."));
    },

    openRoom(id) {
      if ((get().view !== (id ? "room" : "rooms") || get().roomId !== id) && !canNavigate()) return;
      if (id) {
        const key = machineOfRoom(id);
        if (key !== null && key !== get().active) get().activate(key);
      }
      set({ roomId: id, view: id ? "room" : "rooms", goneRoom: null });
      history.replaceState(null, "", hashFor(id ? "room" : "rooms", id, null));
      if (id && !get().roomData[id]?.loaded) void get().loadHistory(id);
    },

    openAgent(p) {
      if ((get().view !== "agent" || get().agent !== p) && !canNavigate()) return;
      set({ view: "agent", agent: p, roomId: null, goneRoom: null });
      history.replaceState(null, "", hashFor("agent", null, p));
    },

    setView(v) {
      if (v !== get().view && !canNavigate()) return;
      set({ view: v, goneRoom: null, ...(v !== "room" ? { roomId: v === "rooms" ? null : get().roomId } : {}) });
      history.replaceState(null, "", hashFor(v, get().roomId, get().agent));
    },

    setShowAgents(v) {
      set({ showAgents: v });
    },

    async loadHistory(roomId, older = false) {
      const key = machineOfRoom(roomId) ?? get().active;
      await hubs.get(key)?.getState().loadHistory(roomId, older);
    },

    async loadActivity(roomId, activityId) {
      const key = machineOfRoom(roomId) ?? get().active;
      await hubs.get(key)?.getState().loadActivity(activityId);
    },

    toast(level, text, opts = {}) {
      set((s) => {
        // The same notice again (a retry that failed the same way, say): one notice, counted, its time started over.
        const same = s.toasts.find((t) => t.level === level && t.text === text && t.approval?.id === opts.approval?.id && t.action?.label === opts.action?.label);
        if (same) return { toasts: s.toasts.map((t) => (t === same ? { ...t, ...opts, count: t.count + 1 } : t)) };
        return { toasts: [...s.toasts.slice(-3), { id: toastSeq++, level, text, count: 1, ms: toastMs(level, text), ...opts }] };
      });
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    sendPty(ptyId, data) {
      hubs.get(get().active)?.getState().sendPty(ptyId, data);
    },

    resizePty(ptyId, cols, rows) {
      hubs.get(get().active)?.getState().resizePty(ptyId, cols, rows);
    },
  };
});

// Screens that update hub data directly (an approval just decided, a terminal just opened) update the active
// machine's own store, which the app mirrors; anything else is the app's own state.
{
  const setApp = useStore.setState;
  const hubKeys = new Set<string>(HUB_FIELDS);
  useStore.setState = ((partial: Partial<State> | ((s: State) => Partial<State>)) => {
    const next = typeof partial === "function" ? partial(useStore.getState()) : partial;
    const hubPart: Record<string, unknown> = {};
    const appPart: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next ?? {})) (hubKeys.has(k) ? hubPart : appPart)[k] = v;
    const store = hubs.get(useStore.getState().active);
    if (store && Object.keys(hubPart).length) store.setState(hubPart as Partial<HubState>);
    if (Object.keys(appPart).length) setApp(appPart as Partial<State>);
  }) as typeof useStore.setState;
}

// Tell each hub whether this device is looking at the app, so it doesn't send push notifications we'd see anyway.
// (Coming back doesn't load everything again: each machine's connection checks itself, see Live.)
document.addEventListener("visibilitychange", () => {
  const visible = document.visibilityState === "visible";
  for (const store of hubs.values()) store.getState().presence(visible);
  // Coming back to a tab left open for a while: it may be running an app the hub has since replaced.
  const home = hubs.get("");
  if (visible && home && !home.getState().updateReady) void hubWasUpdated().then((updated) => updated && home.setState({ updateReady: true }));
});

// The screen to open next time the app starts without an address (see LastScreen): a chat once a machine has it (not
// one that turned out not to exist), an agent's page, or Home. Settings and the like aren't: the screen before them is.
let lastScreen = "";
function remember(v: LastScreen) {
  const key = JSON.stringify(v);
  if (key === lastScreen) return;
  lastScreen = key;
  saveLast(v);
}
useStore.subscribe((s) => {
  if (s.view === "room" && s.roomId) {
    const machine = machineOfRoom(s.roomId);
    if (machine !== null) remember({ view: "room", roomId: s.roomId, machine });
  } else if (s.view === "agent" && s.agent) remember({ view: "agent", agent: s.agent });
  else if (s.view === "rooms") remember({ view: "rooms" });
});

window.addEventListener("hashchange", () => {
  const r = routeFromHash();
  const s = useStore.getState();
  if (r.view === "room" && r.roomId) s.openRoom(r.roomId);
  else if (r.view === "agent" && r.agent) s.openAgent(r.agent);
  else if (r.view !== s.view) s.setView(r.view);
  // A hash change has already changed the address before the guard runs.
  // Restore it when the user keeps editing so reloads still open this screen.
  const current = useStore.getState();
  if (current.view !== r.view || (r.view === "room" && current.roomId !== r.roomId) || (r.view === "agent" && current.agent !== r.agent)) {
    history.replaceState(null, "", hashFor(current.view, current.roomId, current.agent));
  }
});

// ---- notifications (web/PWA; native shells hook the same function) ----

/**
 * A new request (an approval or a question) on machine `key`. On screen in another chat: a notice with Open, which closes
 * once it's answered on any device. With the app in the background: a notification in the same words.
 */
function announceRequest(key: string, a: Approval, s: HubData) {
  if (typeof document === "undefined") return;
  const room = s.rooms[a.roomId];
  const m = s.members[a.memberId];
  const provider = (room?.chat?.provider ?? m?.provider) as ChatProvider | undefined;
  // A chat is one agent: its name. In a group chat (or a room), which of its agents: its handle.
  const agent = room?.chat && !room.chat.group && provider ? PROVIDER_INFO[provider]?.name ?? "The agent" : m ? `@${m.handle}` : "An agent";
  const text = requestWords(a, room?.name, agent);
  if (document.visibilityState === "visible") {
    const app = useStore.getState();
    // The chat on screen shows it already.
    if (app.view === "room" && app.roomId === a.roomId) return;
    app.toast("warn", text, { action: { label: "Open", run: () => useStore.getState().openRoom(a.roomId) }, approval: { machine: key, id: a.id } });
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(text, { body: a.kind === "question" ? (a.questions?.[0]?.question ?? a.title) : a.title, tag: a.id });
    n.onclick = () => {
      window.focus();
      useStore.getState().openRoom(a.roomId);
    };
  } catch {
    // some platforms only allow notifications from a service worker
  }
}

/**
 * An agent account on machine `key` was just found signed out: a notice with Sign in, which opens the sign-in sheet.
 * Not while a chat on that account is on screen: its card says so already. In the background, the reply's own
 * notification ("… stopped with an error") has already said it.
 */
function announceSignIn(key: string, need: SignInNeed) {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  const app = useStore.getState();
  const s = hubs.get(key)?.getState();
  if (!s) return;
  const onScreen = app.active === key && app.view === "room" && !!app.roomId && Object.values(s.members).some((m) => m.roomId === app.roomId && m.provider === need.provider && memberAccount(m) === need.account);
  if (onScreen) return;
  app.toast("warn", `${signInAgentWords(need)} is signed out on ${need.machine.name}. Its chats can't answer until it's signed in again.`, {
    action: { label: "Sign in", run: () => openSignIn({ provider: need.provider, account: need.account, accountLabel: need.accountLabel, machineKey: key, machine: need.machine.name }) },
  });
}

// ---- selectors ----

export const selectRoomMembers = (roomId: string | null) => (s: State) =>
  roomId ? Object.values(s.members).filter((m) => m.roomId === roomId).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt) : [];

export const pendingApprovals = (s: State, roomId?: string | null) =>
  Object.values(s.approvals)
    .filter((a) => a.status === "pending" && (!roomId || a.roomId === roomId))
    .sort((a, b) => a.createdAt - b.createdAt);

/** True when a chat's agent (in a group chat, any of its agents) runs on an API key (billed per use) rather than a plan sign-in. */
export const usesApiKey = (roomId: string) => (s: Pick<State, "members" | "accounts">) =>
  Object.values(s.members).some((m) => {
    if (m.roomId !== roomId) return false;
    const id = typeof m.config?.account === "string" ? m.config.account : "default";
    return id !== "default" && s.accounts[accountKey(m.provider, id)]?.kind === "apikey";
  });

/** Whether an agent can start chats on a machine: installed, and signed in (or given an API key). */
export const agentReady = (s: Pick<State, "providers" | "accounts">, p: ChatProvider) =>
  !!s.providers[p]?.installed && (!!s.providers[p]?.signedIn || Object.values(s.accounts).some((a) => a.provider === p && a.signedIn));
