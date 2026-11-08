import { withBookmark } from "./bookmarks";
import { createStore, type StoreApi } from "zustand/vanilla";
import { mergeTextDelta, type TextDelta } from "./stream";
import { applyStepDelta, mergeStep, withFullDetail, type StepDelta } from "./steps";
import { hubWasUpdated } from "./version";
import type { AccountSpend, Ask, PromptTemplate, SignInNeed, SignInSession } from "@crosstalk/shared";
import { mergeAsks } from "./asks";
import { accountKey } from "./accounts";
import type { RoomAgentActivity } from "./roomActivity";
import type {
  Activity,
  AgentAccount,
  Approval,
  BackgroundTask,
  Device,
  HubInfo,
  ImageEditorStatus,
  LoginFlow,
  MacDialog,
  MacStatus,
  Member,
  Message,
  PoolOffer,
  PoolView,
  Provider,
  ProviderStatus,
  PtyInfo,
  Room,
  ServerEvent,
  StateSnapshot,
  MachineMemory,
  StorageStatus,
  Turn,
  UsageSnapshot,
} from "@crosstalk/shared";
import { PROTOCOL_VERSION } from "@crosstalk/shared";
import { api, ApiError, Live, type Connection } from "./api";
import { putCatalog, refreshCatalogs } from "./catalogs";
import { normalizePool } from "./pool";
import { normalizeOffer } from "./poolChat";
import { signInsShown } from "./signIn";

export interface RoomData {
  messages: Message[];
  turns: Record<string, Turn>;
  activities: Record<string, Activity[]>; // by turn id
  loaded: boolean;
  loading: boolean;
  /** Why it last failed to load: kept while it's tried again (`loading`), null once it has loaded. */
  error: string | null;
  hasMore: boolean;
  totals: { inputTokens: number; outputTokens: number; costUsd: number } | null;
}

/** Everything the app knows about one machine's hub, kept in step over its WebSocket. */
export interface HubData {
  conn: Connection;
  status: "connecting" | "open" | "closed";
  /**
   * Catching up: what's shown may be out of date, so agents' status is unknown. Set at once when updates may have been
   * missed (the connection was down), otherwise only once catching up takes a while (SLOW_SYNC_MS).
   */
  syncing: boolean;
  /** Catching up has taken a while (SLOW_SYNC_MS) or failed: the screen says so. A quick one shows nothing. */
  syncSlow: boolean;
  /**
   * Catching up failed, in the hub's own words (or why it couldn't be asked), and since when it has been failing: a
   * hub that holds the socket open but can't answer looks like a slow one until the screen says why. Null once it works.
   */
  syncError: { text: string; since: number } | null;
  /**
   * Since when the hub can't be reached (null while connected, during the first try to connect, and for the first
   * BLIP_MS of a drop: a restart or a network blip that is back by then never says it can't be reached).
   */
  downSince: number | null;
  /** When the hub's state last came in (null until it first has, since this machine was started). */
  loadedAt: number | null;
  /** The hub was updated since this page loaded; it should reload to get the new app. */
  updateReady: boolean;
  hub: HubInfo | null;
  device: Device | null;
  rooms: Record<string, Room>;
  roomActivity: Record<string, RoomAgentActivity[]>;
  members: Record<string, Member>;
  approvals: Record<string, Approval>;
  usage: Record<string, UsageSnapshot>;
  accounts: Record<string, AgentAccount>;
  providers: Partial<Record<Provider, ProviderStatus>>;
  /** Each account's sign-in, by accountKey (see LoginState). */
  logins: Record<string, LoginState>;
  ptys: Record<string, PtyInfo>;
  roomData: Record<string, RoomData>;
  /** Each agent's background work (helpers it summoned, workflows), by member id. */
  tasks: Record<string, BackgroundTask[]>;
  /** The hub's disk, for the low-space warning (null until known, or from an older hub). */
  storage: StorageStatus | null;
  /** How the hub machine's memory is doing (memory.ts; null until known, or from an older hub). */
  memory: MachineMemory | null;
  /** Settings → Model pool (null until the screen first loads it; kept in step by `pool` events after that). */
  pool: PoolView | null;
  /**
   * The model pool as a model to chat with (poolChat.ts): from the state and `poolOffer` events, so the New chat menu
   * has it without loading the whole pool. Null from a hub older than the offer.
   */
  poolOffer: PoolOffer | null;
  /** Settings → Image editor (null until Settings first loads it; kept in step by `imageEditor` events after that). */
  imageEditor: ImageEditorStatus | null;
  /** On a Mac hub: privacy dialogs waiting on its screen (from the state, then `macDialogs` events). */
  macDialogs: MacDialog[];
  /** Questions to other agents about messages (Ask others), by chat. */
  asks: Record<string, Ask[]>;
  /** What each account has cost and its limit (from the `spend` events and GET /api/spend); null until known. */
  spend: AccountSpend[] | null;
  /** Ways to start a chat (Settings → Templates), from the state and `templates` events; null until known, and from older hubs. */
  templates: PromptTemplate[] | null;
  /**
   * Agent accounts found signed out after a reply failed on its sign-in (signIn.ts), from the state and `signin.needs`
   * events; null until known, and from hubs that can't sign agents in from the phone.
   */
  signIns: SignInNeed[] | null;
  /** Sign-ins started from the phone, running or ended in the last few minutes, by id (`signin.session` events). */
  signInSessions: Record<string, SignInSession>;
  /**
   * The messages kept in Bookmarks, with when each was bookmarked (from the state, then `bookmark` events); null until
   * known, and from hubs before bookmarks.
   */
  bookmarked: Record<string, number> | null;
}

export interface HubActions {
  /** Opens the WebSocket and loads everything. */
  start(): Promise<void>;
  stop(): void;
  /** Loads everything again. `missed`: updates may have been missed meanwhile (see syncing). */
  refresh(opts?: { missed?: boolean }): Promise<void>;
  /** Try now: connects again at once (no waiting between tries), or loads the state again if it's what failed. */
  reconnectNow(): void;
  refreshAccounts(): Promise<void>;
  loadHistory(roomId: string, older?: boolean): Promise<void>;
  /** A chat's asks (Ask others) from the hub, with the live events that came meanwhile kept. Loaded with its history. */
  loadAsks(roomId: string): Promise<void>;
  /** A step whole: its detail came shortened (Activity.detailLength), or lost its place while it streamed. */
  loadActivity(activityId: string): Promise<void>;
  sendPty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  /** Whether this device is looking at the app (the hub skips push notifications it would see anyway). */
  presence(visible: boolean): void;
  /** Loads the model pool (GET /api/pool). */
  loadPool(): Promise<PoolView>;
  /**
   * A model pool request that answers with the pool (PUT /api/pool, start, stop…). Its answer is kept unless a `pool`
   * event came while it ran: the hub sends one for every change, so the events are then the newer word.
   */
  poolCall(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<PoolView>;
  /**
   * The image editor: how it is (no `on`), or switched on or off (`force`: even while it's editing). Its answer is kept
   * unless an `imageEditor` event came while it ran.
   */
  imageEditorCall(on?: boolean, force?: boolean): Promise<ImageEditorStatus>;
  /** Settings → This Mac: what keeps it from running unattended (GET /api/mac). */
  loadMac(): Promise<MacStatus>;
  /** Opens a page of System Settings on the Mac's own screen. */
  openOnMac(pane: "fullDisk" | "login" | "energy" | "updates" | "privacy"): Promise<void>;
  /** A dialog taken off the list (it was answered while the hub wasn't watching, say). */
  dismissMacDialog(id: string): Promise<void>;
  /** Stops the program asking in a dialog (its own process; the question itself may stay on the Mac's screen). */
  stopMacAsker(id: string): Promise<void>;
  /** A terminal on the Mac running the fix (sudo, the person's own password typed into it). */
  fixOnMac(what: "autologin" | "power"): Promise<PtyInfo>;
  /** Puts away the notice that the Mac crashed or lost power: This Mac as it is then. */
  dismissMacCrash(): Promise<MacStatus>;
}

export type HubState = HubData & HubActions;

/** What a machine's store needs from the app around it. */
export interface HubHooks {
  toast(level: "info" | "warn" | "error", text: string): void;
  /** The chat on screen: its history reloads after a reconnect. */
  openRoomId(): string | null;
  /** A room was deleted on this hub (or, found on reconnecting, while this device wasn't listening). */
  roomGone(roomId: string): void;
  /** This device was signed out of the hub. */
  signedOut(): void;
  /** A new request is waiting (a notice, or a notification while the page is in the background). */
  approval(a: Approval, s: HubState): void;
  ptyData(ptyId: string, data: string): void;
  /** An agent account was found signed out just now (not one already known): a notice with its Sign in. */
  signInNeeded?(need: SignInNeed): void;
}

/**
 * An account's sign-in, as this device last knew it: going on (its flow), or over (`ended`, with why when it didn't sign
 * in). Starting one writes its flow here first (SetupPage's startLogin), so an earlier attempt's end is never taken for it.
 */
export type LoginState = { flow: LoginFlow; ended?: false } | { flow: null; ended: true; error: string | null };

/** The sign-ins a dialog on screen is following (by accountKey): it says how they went, so no notice is needed. */
export const watchedLogins = new Set<string>();

const emptyRoom = (): RoomData => ({ messages: [], turns: {}, activities: {}, loaded: false, loading: false, error: null, hasMore: false, totals: null });

// A history response can race live text or a completed reply. Never roll either back.
function newerMessage(snapshot: Message, live?: Message): Message {
  if (!live) return snapshot;
  if (snapshot.status !== "streaming" && live.status === "streaming") return snapshot;
  if (live.status !== "streaming" && snapshot.status === "streaming") return live;
  if (live.status === "streaming" && live.text.startsWith(snapshot.text)) return live;
  if (snapshot.status === "streaming" && snapshot.text.startsWith(live.text)) return snapshot;
  return live.updatedAt >= snapshot.updatedAt ? live : snapshot;
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

/**
 * `next`, a copy of a room just fetched or heard, read at least as far as `known` (the copy this device has). Read
 * only moves forward on the machine too, and marking a room read doesn't change its updatedAt: a history or snapshot
 * served just before a read can arrive after it, and mustn't make the chat look unread again.
 */
export function keepRead(known: Room | undefined, next: Room): Room {
  const read = known?.readAt ?? 0;
  return read > (next.readAt ?? 0) ? { ...next, readAt: read } : next;
}

/**
 * `next`, a chat's copy from its history, with the pin `known` has (the copy this device has). Pinning doesn't change
 * updatedAt either, so a history served just before a pin or an unpin could undo it here; pins come with `room` events,
 * and the state after a reconnect, which are taken as they come.
 */
export function keepPin(known: Room | undefined, next: Room): Room {
  if (!known || ((known.pinnedAt ?? null) === (next.pinnedAt ?? null) && (known.pinOrder ?? null) === (next.pinOrder ?? null))) return next;
  const { pinnedAt: _at, pinOrder: _order, ...rest } = next;
  return known.pinnedAt ? { ...rest, pinnedAt: known.pinnedAt, pinOrder: known.pinOrder ?? 0 } : rest;
}

/** Catching up after a reconnect shows (syncing) only once it has taken this long. */
export const SLOW_SYNC_MS = 1_500;
/** Back after this long with the connection still up: the app catches up anyway, quietly. */
const RESYNC_AFTER_MS = 5 * 60_000;
/** While the socket stays down, whether this device is still signed in there is asked at most this often. */
const SIGN_IN_CHECK_MS = 15_000;
/**
 * A connection that drops counts as down (downSince, the red "Can't reach" strip) only once it has stayed down this
 * long. Live's first try again is 0.5-0.8 s after a drop, so a hub restart or a network blip that's back by then is
 * never an alarm (nor a strip that shifts the whole screen down and up again); "Connecting to…" shows after 1 s.
 */
export const BLIP_MS = 2_000;
/**
 * How long a new machine's state waits for its socket to open: asked on an open socket, it's asked once (see start).
 * A socket that's slow to open, or can't, doesn't hold the first screen up longer than this.
 */
const SOCKET_WAIT_MS = 1_500;

export const emptyHubData = (conn: Connection): HubData => ({
  conn,
  status: "closed",
  syncing: false,
  syncSlow: false,
  syncError: null,
  downSince: null,
  loadedAt: null,
  updateReady: false,
  hub: null,
  device: null,
  rooms: {},
  roomActivity: {},
  members: {},
  approvals: {},
  usage: {},
  accounts: {},
  providers: {},
  logins: {},
  ptys: {},
  roomData: {},
  tasks: {},
  storage: null,
  memory: null,
  pool: null,
  poolOffer: null,
  imageEditor: null,
  macDialogs: [],
  asks: {},
  spend: null,
  templates: null,
  signIns: null,
  signInSessions: {},
  bookmarked: null,
});

/** One machine's hub: its own connection, WebSocket and data. The app keeps one of these per paired machine. */
export function createHubStore(conn: Connection, hooks: HubHooks): StoreApi<HubState> {
  let live: Live | null = null;
  let stopped = true;
  let accountsRequest = 0;
  let connectionGeneration = 0;
  let refreshRequest = 0;
  let refreshRetry: ReturnType<typeof setTimeout> | undefined;
  let slowSync: ReturnType<typeof setTimeout> | undefined;
  /** When the connection dropped (null while it's up), and the timer that says so once it's been BLIP_MS. */
  let lostAt: number | null = null;
  let blip: ReturnType<typeof setTimeout> | undefined;
  /** A start waiting for its socket to open before it asks for the state (see start): lets it go on. */
  let opening: (() => void) | null = null;
  /** `pool` events so far, so a pool request's answer never rolls back a newer event. */
  let poolEvents = 0;
  /** `imageEditor` events so far, the same way. */
  let imageEditorEvents = 0;
  const historyRequests = new Map<string, symbol>();
  /** A chat's asks list on its way, with the asks live events touched meanwhile (see mergeAsks). */
  const askLoads = new Map<string, { generation: number; touched: Set<string> }>();
  let snapshotEvents: ServerEvent[] | null = null;
  const pendingText = new Map<string, TextDelta[]>();
  const textRefresh = new Map<string, ReturnType<typeof setTimeout>>();
  /** Step changes that came while their room's history loaded (applied on top once it's in), by step id. */
  const pendingSteps = new Map<string, StepDelta[]>();
  /** Steps being fetched whole, with the changes that came meanwhile. */
  const stepFetches = new Map<string, { meanwhile: StepDelta[]; done: Promise<void> }>();
  const clearTextRecovery = () => {
    pendingText.clear();
    for (const timer of textRefresh.values()) clearTimeout(timer);
    textRefresh.clear();
    pendingSteps.clear();
    stepFetches.clear();
  };
  const call = <T>(method: string, path: string, body?: unknown) => api<T>(method, path, body, conn);
  /** The last sign-in check (signInCheck below), and whether one is on its way. */
  let signInAskedAt = 0;
  let signInAsking = false;

  return createStore<HubState>((set, get) => {
    /**
     * The socket went down: is this device still signed in there? A device signed out from another one has its socket
     * closed (server.ts `allowed`: 1008, "This device has been signed out.") and every new one refused, which to a
     * browser is just another drop, so the socket alone would retry for ever and the screen would blame the machine.
     * Only an HTTP answer tells the two apart, and nothing else asks while the socket is down: so ask, one request at
     * a time and at most every SIGN_IN_CHECK_MS while it stays down. Anything but a 401 says nothing (the hub may be
     * restarting), and the socket's own retries carry on. The hub refuses a signed-out device's token on every /api
     * route before it looks at the route (server.ts), so the check asks for the small device list, never the whole
     * state: most drops are a phone waking or changing networks with the hub up, and the socket that opens again a
     * moment later asks for the state itself.
     */
    const signInCheck = () => {
      if (stopped || signInAsking || Date.now() - signInAskedAt < SIGN_IN_CHECK_MS) return;
      const generation = connectionGeneration;
      signInAsking = true;
      signInAskedAt = Date.now();
      call("GET", "/api/devices")
        .then(
          () => {},
          (e) => {
            if (generation === connectionGeneration && !stopped && e instanceof ApiError && e.status === 401) hooks.signedOut();
          },
        )
        .finally(() => {
          signInAsking = false;
        });
    };
    const recoverText = (roomId: string) => {
      if (textRefresh.has(roomId)) return;
      const generation = connectionGeneration;
      textRefresh.set(roomId, setTimeout(() => {
        textRefresh.delete(roomId);
        if (generation !== connectionGeneration || !get().rooms[roomId]) return;
        if (get().roomData[roomId]?.loading) { recoverText(roomId); return; }
        void get().loadHistory(roomId);
      }, 600)); // Older hubs persist streaming text every 400 ms.
    };
    const withPendingText = (message: Message) => {
      const chunks = pendingText.get(message.id);
      if (!chunks) return message;
      let text = message.text;
      const remaining: TextDelta[] = [];
      if (message.status === "streaming") for (const chunk of chunks) {
        const merged = mergeTextDelta(text, chunk);
        if (merged === null) remaining.push(chunk);
        else text = merged;
      }
      if (remaining.length) { pendingText.set(message.id, remaining); recoverText(message.roomId); }
      else pendingText.delete(message.id);
      return text === message.text ? message : { ...message, text };
    };
    const apply = (e: ServerEvent, replay = false) => {
      if (!replay) snapshotEvents?.push(e);
      switch (e.t) {
        case "hello":
          set({ device: e.device, hub: e.hub });
          break;
        case "hub":
          set({ hub: e.hub });
          break;
        case "room":
          // Read only moves forward: an event sent just before a read can come after the read's own answer.
          set((s) => ({ rooms: { ...s.rooms, [e.room.id]: keepRead(s.rooms[e.room.id], e.room) } }));
          break;
        case "roomActivity":
          set((s) => ({ roomActivity: { ...s.roomActivity, [e.roomId]: e.activity } }));
          break;
        case "storage":
          set({ storage: e.status });
          break;
        case "memory":
          set({ memory: e.memory });
          break;
        case "pool":
          poolEvents++;
          set({ pool: normalizePool(e.pool) });
          break;
        case "poolOffer":
          set({ poolOffer: normalizeOffer(e.offer) });
          break;
        case "imageEditor":
          imageEditorEvents++;
          set({ imageEditor: e.status });
          break;
        case "macDialogs":
          set({ macDialogs: e.dialogs });
          break;
        case "ask":
          askLoads.get(e.ask.roomId)?.touched.add(e.ask.id);
          set((s) => {
            const list = s.asks[e.ask.roomId] ?? [];
            const at = list.findIndex((a) => a.id === e.ask.id);
            return { asks: { ...s.asks, [e.ask.roomId]: at >= 0 ? list.map((a, i) => (i === at ? e.ask : a)) : [...list, e.ask] } };
          });
          break;
        case "ask.removed":
          askLoads.get(e.roomId)?.touched.add(e.id);
          set((s) => ({ asks: { ...s.asks, [e.roomId]: (s.asks[e.roomId] ?? []).filter((a) => a.id !== e.id) } }));
          break;
        case "spend":
          set({ spend: e.accounts });
          break;
        case "templates":
          set({ templates: e.templates });
          break;
        case "bookmark":
          set((s) => ({ bookmarked: withBookmark(s.bookmarked, e.messageId, e.at) }));
          break;
        case "signin.needs": {
          // News only when it's new: the same account stopping another chat, or the list sent again, isn't. Only agents
          // that have a sign-in: Crosstalk's own never needs one, whatever a hub sends (signIn.ts signInsShown).
          const known = get().signIns;
          const needs = signInsShown(e.needs);
          set({ signIns: needs });
          if (!replay && known) for (const n of needs) if (!known.some((k) => k.provider === n.provider && k.account === n.account)) hooks.signInNeeded?.(n);
          break;
        }
        case "signin.session":
          set((s) => ({ signInSessions: { ...s.signInSessions, [e.session.id]: e.session } }));
          break;
        case "room.deleted":
          set((s) => {
            const rooms = { ...s.rooms };
            const roomActivity = { ...s.roomActivity };
            const roomData = { ...s.roomData };
            delete rooms[e.roomId];
            delete roomActivity[e.roomId];
            delete roomData[e.roomId];
            historyRequests.delete(e.roomId);
            const asks = { ...s.asks };
            delete asks[e.roomId];
            return { rooms, roomActivity, roomData, asks };
          });
          hooks.roomGone(e.roomId);
          break;
        case "member":
          set((s) => ({ members: { ...s.members, [e.member.id]: e.member } }));
          break;
        case "member.deleted":
          set((s) => {
            const members = { ...s.members };
            delete members[e.memberId];
            return { members };
          });
          break;
        case "message":
          pendingText.delete(e.message.id);
          set((s) => {
            const rd = s.roomData[e.message.roomId];
            if (!rd) return s;
            const i = rd.messages.findIndex((m) => m.id === e.message.id);
            const messages = rd.messages.slice();
            if (i >= 0) messages[i] = e.message;
            else messages.push(e.message);
            return { roomData: { ...s.roomData, [e.message.roomId]: { ...rd, messages } } };
          });
          break;
        case "messages.removed":
          set((s) => {
            const rd = s.roomData[e.roomId];
            if (!rd) return s;
            const gone = new Set(e.ids);
            return { roomData: { ...s.roomData, [e.roomId]: { ...rd, messages: rd.messages.filter((m) => !gone.has(m.id)) } } };
          });
          break;
        case "turns.removed":
          set((s) => {
            const rd = s.roomData[e.roomId];
            const gone = new Set(e.ids);
            const approvals = Object.fromEntries(Object.entries(s.approvals).filter(([, a]) => !(a.turnId && gone.has(a.turnId) && a.status !== "pending")));
            if (!rd) return { approvals };
            const turns = Object.fromEntries(Object.entries(rd.turns).filter(([id]) => !gone.has(id)));
            const activities = Object.fromEntries(Object.entries(rd.activities).filter(([id]) => !gone.has(id)));
            return { approvals, roomData: { ...s.roomData, [e.roomId]: { ...rd, turns, activities } } };
          });
          break;
        case "message.delta":
          set((s) => {
            const rd = s.roomData[e.roomId];
            if (!rd) return s;
            const i = rd.messages.findIndex((m) => m.id === e.messageId);
            const chunk = typeof e.offset === "number" ? { offset: e.offset, delta: e.delta } : null;
            if (!chunk && rd.loading) recoverText(e.roomId);
            if (chunk && (i < 0 || rd.loading)) pendingText.set(e.messageId, [...(pendingText.get(e.messageId) ?? []), chunk]);
            if (i < 0) { if (!chunk || !rd.loading) recoverText(e.roomId); return s; }
            if (rd.messages[i].status !== "streaming") return s;
            const text = chunk ? mergeTextDelta(rd.messages[i].text, chunk) : rd.messages[i].text + e.delta;
            if (text === null) {
              if (!rd.loading) pendingText.set(e.messageId, [...(pendingText.get(e.messageId) ?? []), chunk!]);
              recoverText(e.roomId);
              return s;
            }
            const messages = rd.messages.slice();
            messages[i] = { ...messages[i], text };
            return { roomData: { ...s.roomData, [e.roomId]: { ...rd, messages } } };
          });
          break;
        case "turn":
          set((s) => {
            const rd = s.roomData[e.turn.roomId];
            if (!rd) return s;
            return { roomData: { ...s.roomData, [e.turn.roomId]: { ...rd, turns: { ...rd.turns, [e.turn.id]: e.turn } } } };
          });
          break;
        case "activity":
          set((s) => {
            const rd = s.roomData[e.activity.roomId];
            if (!rd) return s;
            const list = (rd.activities[e.activity.turnId] ?? []).slice();
            const i = list.findIndex((a) => a.id === e.activity.id);
            if (i >= 0) list[i] = mergeStep(list[i], e.activity);
            else list.push(e.activity);
            return { roomData: { ...s.roomData, [e.activity.roomId]: { ...rd, activities: { ...rd.activities, [e.activity.turnId]: list } } } };
          });
          break;
        case "activity.delta": {
          stepFetches.get(e.activityId)?.meanwhile.push(e);
          const rd = get().roomData[e.roomId];
          if (!rd) break;
          if (rd.loading) pendingSteps.set(e.activityId, [...(pendingSteps.get(e.activityId) ?? []), e]);
          const list = rd.activities[e.turnId] ?? [];
          const i = list.findIndex((a) => a.id === e.activityId);
          if (i < 0) {
            // The step itself never came (it started while this app was catching up): it's fetched whole.
            if (!rd.loading && rd.loaded) void get().loadActivity(e.activityId).catch(() => {});
            break;
          }
          const next = applyStepDelta(list[i], e);
          // A running step that lost its place is fetched again, so what's shown live stays right.
          if (next.detailLength !== undefined && list[i].detailLength === undefined && next.status === "running" && !rd.loading) void get().loadActivity(e.activityId).catch(() => {});
          set((s) => {
            const cur = s.roomData[e.roomId];
            const steps = cur?.activities[e.turnId];
            if (!cur || !steps) return s;
            const copy = steps.map((a) => (a.id === e.activityId ? (a === list[i] ? next : applyStepDelta(a, e)) : a));
            return { roomData: { ...s.roomData, [e.roomId]: { ...cur, activities: { ...cur.activities, [e.turnId]: copy } } } };
          });
          break;
        }
        case "approval": {
          // Only a new request is news: the same one sent again (updated) isn't announced twice.
          const known = get().approvals[e.approval.id]?.status === "pending";
          set((s) => ({ approvals: { ...s.approvals, [e.approval.id]: e.approval } }));
          if (!replay && !known && e.approval.status === "pending") hooks.approval(e.approval, get());
          break;
        }
        case "tasks":
          set((s) => ({ tasks: { ...s.tasks, [e.memberId]: e.tasks } }));
          break;
        case "usage":
          set((s) => ({ usage: { ...s.usage, [accountKey(e.usage.provider, e.usage.accountId)]: e.usage } }));
          break;
        case "account":
          accountsRequest++;
          set((s) => ({ accounts: { ...s.accounts, [accountKey(e.account.provider, e.account.id)]: e.account } }));
          break;
        case "account.deleted":
          accountsRequest++;
          set((s) => {
            const accounts = { ...s.accounts };
            const usage = { ...s.usage };
            const logins = { ...s.logins };
            const key = accountKey(e.provider, e.id);
            delete accounts[key]; delete usage[key]; delete logins[key];
            return { accounts, usage, logins };
          });
          break;
        case "provider":
          set((s) => ({ providers: { ...s.providers, [e.status.provider]: e.status } }));
          break;
        case "models":
          putCatalog(conn, e.catalog);
          break;
        case "login": {
          const key = accountKey(e.provider, e.accountId);
          const cur = get().logins[key];
          // The end of an attempt that a newer one replaced isn't news about the newer one.
          if (e.done && e.loginId && cur?.flow && "loginId" in cur.flow && cur.flow.loginId !== e.loginId) break;
          const next: LoginState | undefined = e.done ? { flow: null, ended: true, error: e.error ?? null } : e.flow ? { flow: e.flow } : undefined;
          if (next) set((s) => ({ logins: { ...s.logins, [key]: next } }));
          // A sign-in dialog on screen says how it went itself.
          if (!watchedLogins.has(key)) {
            if (e.error) hooks.toast("error", e.error);
            else if (e.done) hooks.toast("info", `Signed in.`);
          }
          break;
        }
        case "pty":
          set((s) => ({ ptys: { ...s.ptys, [e.pty.id]: e.pty } }));
          break;
        case "pty.data":
          hooks.ptyData(e.ptyId, e.data);
          break;
        case "notice":
          hooks.toast(e.level, e.text);
          break;
      }
    };

    return {
      ...emptyHubData(conn),

      async start() {
        const generation = ++connectionGeneration;
        stopped = false;
        clearTextRecovery();
        accountsRequest++;
        clearTimeout(refreshRetry);
        historyRequests.clear();
        signInAskedAt = 0;
        clearTimeout(blip);
        lostAt = null;
        // A start still waiting for its socket goes on, and finds it was replaced.
        opening?.();
        live?.close();
        set({ ...emptyHubData(conn), status: "connecting" });
        // The state is asked for once the socket is open, and so only once: asked any sooner, it has to be asked again
        // when the socket opens (whatever happened in between came only on the socket), which made every start, reload
        // and added machine download the whole of it twice. A socket that's slow to open, or can't, holds the first
        // screen up no longer than SOCKET_WAIT_MS: the state is asked for then, and again once the socket opens.
        let wait: ReturnType<typeof setTimeout> | undefined;
        const opened = new Promise<void>((resolve) => {
          const go = () => {
            clearTimeout(wait);
            if (opening === go) opening = null;
            resolve();
          };
          opening = go;
          wait = setTimeout(go, SOCKET_WAIT_MS);
        });
        live = new Live(
          conn,
          (event) => { if (generation === connectionGeneration) apply(event); },
          (status) => {
            if (generation !== connectionGeneration) return;
            if (status === "open") {
              clearTimeout(blip);
              lostAt = null;
            } else if (status === "closed" && lostAt === null) {
              // Unreachable since the first try that failed, until it's back (tries in between don't change that); said
              // only once that has lasted BLIP_MS.
              const at = (lostAt = Date.now());
              blip = setTimeout(() => {
                if (generation === connectionGeneration && get().status !== "open") set({ downSince: at });
              }, BLIP_MS);
            }
            set(status === "open" ? { status, downSince: null } : { status });
            if (status === "closed") signInCheck();
            if (status === "open") {
              // It let this device in: the next drop asks again at once.
              signInAskedAt = 0;
              live?.send({ t: "presence", visible: document.visibilityState === "visible" });
              // A new connection: anything sent while there was none is missing. A start waiting for this asks itself.
              if (opening) opening();
              else void get().refresh({ missed: true }).catch(() => {});
              // Model lists may have changed while the connection was down.
              refreshCatalogs(conn);
              // The app itself comes from the hub this page was opened from.
              if (!conn.baseUrl) void hubWasUpdated().then((updated) => generation === connectionGeneration && updated && set({ updateReady: true }));
            }
          },
          undefined,
          // Back in the app and the connection held: nothing was missed. After a long while, catch up anyway, quietly.
          (away) => {
            if (generation === connectionGeneration && away > RESYNC_AFTER_MS) void get().refresh().catch(() => {});
          },
        );
        await opened;
        if (generation !== connectionGeneration) return;
        await get().refresh();
      },

      stop() {
        stopped = true;
        connectionGeneration++;
        clearTextRecovery();
        accountsRequest++;
        refreshRequest++;
        clearTimeout(refreshRetry);
        clearTimeout(slowSync);
        clearTimeout(blip);
        lostAt = null;
        opening?.();
        snapshotEvents = null;
        historyRequests.clear();
        live?.close();
        live = null;
        set({ ...emptyHubData(conn) });
      },

      async refreshAccounts() {
        const request = ++accountsRequest;
        const accounts = await call<AgentAccount[]>("GET", "/api/accounts");
        if (request === accountsRequest) set({ accounts: Object.fromEntries(accounts.map((a) => [accountKey(a.provider, a.id), a])) });
      },

      async refresh(opts = {}) {
        if (stopped) return;
        const generation = connectionGeneration;
        const request = ++refreshRequest;
        const current = () => generation === connectionGeneration && request === refreshRequest;
        const events: ServerEvent[] = [];
        snapshotEvents = events;
        clearTimeout(refreshRetry);
        // What's on screen stays there meanwhile, said to be out of date only if it may be, and the screen says it's
        // catching up only once that takes a while.
        if (opts.missed) set({ syncing: true });
        clearTimeout(slowSync);
        slowSync = setTimeout(() => { if (current()) set({ syncing: true, syncSlow: true }); }, SLOW_SYNC_MS);
        try {
          const snap = await call<StateSnapshot>("GET", "/api/state");
          if (!current()) return;
          accountsRequest++;
          historyRequests.clear();
          const rid = hooks.openRoomId();
          const hadOpen = !!rid && !!get().rooms[rid];
          set((s) => ({
            hub: snap.hub,
            device: snap.device,
            storage: snap.storage ?? null,
            memory: snap.memory ?? null,
            macDialogs: snap.macDialogs ?? [],
            templates: snap.templates ?? null,
            signIns: snap.signIns ? signInsShown(snap.signIns) : null,
            signInSessions: Object.fromEntries((snap.signInSessions ?? []).map((x) => [x.id, x])),
            bookmarked: snap.bookmarked ?? null,
            poolOffer: snap.pool ? normalizeOffer(snap.pool) : null,
            rooms: Object.fromEntries(snap.rooms.map((r) => [r.id, keepRead(s.rooms[r.id], r)])),
            roomActivity: snap.roomActivity ?? {},
            members: byId(snap.members),
            approvals: { ...Object.fromEntries(Object.entries(s.approvals).filter(([, a]) => a.status !== "pending")), ...byId(snap.approvals) },
            usage: Object.fromEntries(snap.usage.map((u) => [accountKey(u.provider, u.accountId), u])),
            providers: Object.fromEntries(snap.providers.map((p) => [p.provider, p])),
            accounts: Object.fromEntries((snap.accounts ?? []).map((a) => [accountKey(a.provider, a.id), a])),
            // Every cached room may have missed events: each loads again when it's next opened. The chat on screen
            // keeps what it shows while it loads again, just below (no "Loading…" in its place).
            roomData: Object.fromEntries(
              Object.entries(s.roomData)
                .filter(([id]) => snap.rooms.some((r) => r.id === id))
                .map(([id, rd]) => [id, id === rid ? { ...rd, loading: false } : { ...rd, loaded: false, loading: false, error: null }]),
            ),
            loadedAt: Date.now(),
            syncError: null,
          }));
          // Snapshot fetches must not undo newer live state or resurrect a deleted member/room.
          for (const e of events) if (["hub", "room", "room.deleted", "member", "member.deleted", "approval", "usage", "provider", "account", "account.deleted", "roomActivity", "macDialogs", "templates", "signin.needs", "signin.session", "bookmark"].includes(e.t)) apply(e, true);
          snapshotEvents = null;
          // The chat on screen was deleted while this device wasn't listening.
          if (hadOpen && !get().rooms[rid!]) hooks.roomGone(rid!);
          // Pool events may have been missed while the connection was down: a pool on screen loads again.
          if (get().pool) void get().loadPool().catch(() => {});
          if (get().imageEditor) void get().imageEditorCall().catch(() => {});
          if (rid && get().rooms[rid]) await get().loadHistory(rid);
          if (current()) {
            clearTimeout(slowSync);
            set({ syncing: false, syncSlow: false });
          }
        } catch (e) {
          if (!current()) return;
          clearTimeout(slowSync);
          snapshotEvents = null;
          if (e instanceof ApiError && e.status === 401) {
            hooks.signedOut();
          } else {
            // HTTP can lag behind an already-open socket after a restart. Retry without an unhandled rejection; what's
            // shown may be out of date meanwhile, and says so, with the hub's own words once it has gone on a while.
            const text = e instanceof Error ? e.message : String(e);
            set({ syncing: true, syncSlow: true, syncError: { text, since: get().syncError?.since ?? Date.now() } });
            refreshRetry = setTimeout(() => { void get().refresh({ missed: true }).catch(() => {}); }, 3000);
          }
          throw e;
        }
      },

      reconnectNow() {
        if (stopped) return;
        if (get().status === "open") void get().refresh().catch(() => {});
        else live?.reconnectNow();
      },

      async loadHistory(roomId, older = false) {
        const cur = get().roomData[roomId] ?? emptyRoom();
        if (cur.loading) return;
        const generation = connectionGeneration;
        const request = Symbol(roomId);
        historyRequests.set(roomId, request);
        const valid = () => generation === connectionGeneration && historyRequests.get(roomId) === request;
        // A chat that couldn't load keeps saying so while it's tried again (`error` goes once it loads): its Retry stays
        // where it is, and so does the keyboard's place on it (WorkingPanel ChatStatus).
        set((s) => ({ roomData: { ...s.roomData, [roomId]: { ...cur, loading: true } } }));
        try {
          const before = older ? (cur.messages[0] as Message & { seq?: number })?.seq : undefined;
          const res = await call<{
            room: Room;
            messages: Message[];
            turns: Turn[];
            activities: Activity[];
            approvals: Approval[];
            totals: RoomData["totals"];
            hasMore: boolean;
            tasks?: Record<string, BackgroundTask[]>;
          }>("GET", `/api/rooms/${roomId}/history?limit=80&v=${PROTOCOL_VERSION}${before ? `&before=${before}` : ""}`);
          // Reload the range already read, so returning to the app preserves older pages. Fetching
          // authoritative pages also drops messages rewound while this device was asleep.
          const firstSeq = (cur.messages[0] as Message & { seq?: number })?.seq;
          if (!older && firstSeq) {
            while (res.hasMore) {
              const earliest = (res.messages[0] as Message & { seq?: number })?.seq;
              if (!earliest || earliest <= firstSeq || !valid()) break;
              const page = await call<typeof res>("GET", `/api/rooms/${roomId}/history?limit=80&v=${PROTOCOL_VERSION}&before=${earliest}`);
              if (!page.messages.length) { res.hasMore = false; break; }
              res.messages.unshift(...page.messages);
              res.turns.unshift(...page.turns);
              res.activities.unshift(...page.activities);
              res.approvals.unshift(...page.approvals);
              res.hasMore = page.hasMore;
            }
          }
          if (!valid()) return;
          // What the hub says now of this chat's agents, all of them: one it lists nothing for has no helpers at work,
          // whatever this device last heard before it lost touch (whether a message of yours gets a bar goes by this).
          if (res.tasks && !older) set((s) => ({ tasks: { ...s.tasks, ...Object.fromEntries(Object.values(s.members).filter((m) => m.roomId === roomId).map((m) => [m.id, []])), ...res.tasks } }));
          set((s) => {
            const latest = s.roomData[roomId] ?? emptyRoom();
            const liveMessages = byId(latest.messages);
            const originalMessages = byId(cur.messages);
            const messages = new Map(res.messages.map((m) => [m.id, withPendingText(newerMessage(m, liveMessages[m.id]))]));
            for (const m of latest.messages) if (older || originalMessages[m.id] !== m) {
              if (!messages.has(m.id)) messages.set(m.id, m);
            }
            const turns = { ...(older ? latest.turns : {}), ...byId(res.turns) };
            for (const [id, turn] of Object.entries(latest.turns)) {
              if (cur.turns[id] !== turn && (!turns[id]?.endedAt || turn.endedAt)) turns[id] = turn;
            }
            const activities = byId(res.activities);
            for (const [turnId, list] of Object.entries(latest.activities)) for (const activity of list) {
              const changed = cur.activities[turnId]?.find((a) => a.id === activity.id) !== activity;
              const known = activities[activity.id];
              if ((older || changed) && (!known || activity.updatedAt >= known.updatedAt)) activities[activity.id] = activity;
              // A step this app has in full keeps it, even when history sent only its start.
              else if (known) activities[activity.id] = mergeStep(activity, known);
            }
            // Changes that came while it loaded go on top (overlaps aren't repeated).
            for (const [id, list] of pendingSteps) {
              if (list[0]?.roomId !== roomId) continue;
              pendingSteps.delete(id);
              if (activities[id]) for (const e of list) activities[id] = applyStepDelta(activities[id], e);
            }
            const acts: Record<string, Activity[]> = {};
            for (const a of Object.values(activities).sort((a, b) => a.createdAt - b.createdAt)) (acts[a.turnId] ??= []).push(a);
            const approvals = { ...s.approvals };
            for (const a of res.approvals) if (!approvals[a.id]?.decidedAt || (a.decidedAt ?? 0) >= approvals[a.id].decidedAt!) approvals[a.id] = a;
            return {
              rooms: { ...s.rooms, [roomId]: keepPin(s.rooms[roomId], keepRead(s.rooms[roomId], (s.rooms[roomId]?.updatedAt ?? 0) > res.room.updatedAt ? s.rooms[roomId] : res.room)) },
              approvals,
              roomData: { ...s.roomData, [roomId]: {
                messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt),
                turns, activities: acts, loaded: true, loading: false, error: null, hasMore: res.hasMore, totals: res.totals,
              } },
            };
          });
          if (!older) void get().loadAsks(roomId);
        } catch (e) {
          if (!valid()) return;
          const error = e instanceof Error ? e.message : String(e);
          set((s) => ({ roomData: { ...s.roomData, [roomId]: { ...(s.roomData[roomId] ?? cur), loading: false, error } } }));
        } finally {
          if (valid()) historyRequests.delete(roomId);
        }
      },

      async loadAsks(roomId) {
        // One load at a time per chat and connection; only chats have asks.
        const generation = connectionGeneration;
        if (askLoads.get(roomId)?.generation === generation || !get().rooms[roomId]?.chat) return;
        const load = { generation, touched: new Set<string>() };
        askLoads.set(roomId, load);
        try {
          const loaded = await call<Ask[]>("GET", `/api/rooms/${roomId}/asks`);
          if (generation !== connectionGeneration || !Array.isArray(loaded)) return;
          set((s) => ({ asks: { ...s.asks, [roomId]: mergeAsks(s.asks[roomId] ?? [], loaded, load.touched) } }));
        } catch {
          // A hub from before Ask others has no list: the chat just has no cards.
        } finally {
          if (askLoads.get(roomId) === load) askLoads.delete(roomId);
        }
      },

      loadActivity(activityId) {
        const busy = stepFetches.get(activityId);
        if (busy) return busy.done;
        const generation = connectionGeneration;
        const meanwhile: StepDelta[] = [];
        const entry = { meanwhile, done: Promise.resolve() };
        entry.done = (async () => {
          try {
            const full = await call<Activity>("GET", `/api/activities/${encodeURIComponent(activityId)}`);
            if (generation !== connectionGeneration) return;
            set((s) => {
              const rd = s.roomData[full.roomId];
              if (!rd) return s;
              const list = (rd.activities[full.turnId] ?? []).slice();
              const i = list.findIndex((a) => a.id === full.id);
              const next = withFullDetail(full, i >= 0 ? list[i] : undefined, meanwhile);
              const at = list.findIndex((a) => a.createdAt > next.createdAt);
              if (i >= 0) list[i] = next;
              else if (at < 0) list.push(next);
              else list.splice(at, 0, next);
              return { roomData: { ...s.roomData, [full.roomId]: { ...rd, activities: { ...rd.activities, [full.turnId]: list } } } };
            });
          } finally {
            if (stepFetches.get(activityId) === entry) stepFetches.delete(activityId);
          }
        })();
        stepFetches.set(activityId, entry);
        return entry.done;
      },

      sendPty(ptyId, data) {
        live?.send({ t: "pty.input", ptyId, data });
      },

      resizePty(ptyId, cols, rows) {
        live?.send({ t: "pty.resize", ptyId, cols, rows });
      },

      presence(visible) {
        live?.send({ t: "presence", visible });
      },

      loadPool() {
        return get().poolCall("GET", "/api/pool");
      },

      async poolCall(method, path, body, timeoutMs) {
        const generation = connectionGeneration;
        const seen = poolEvents;
        const view = normalizePool(await api<PoolView>(method, path, body, conn, timeoutMs));
        if (generation === connectionGeneration && seen === poolEvents) set({ pool: view });
        return view;
      },

      async loadMac() {
        const status = await api<MacStatus>("GET", "/api/mac", undefined, conn);
        set({ macDialogs: status.dialogs });
        return status;
      },

      async openOnMac(pane) {
        await api("POST", "/api/mac/open", { pane }, conn);
      },

      async dismissMacDialog(id) {
        try {
          const status = await api<MacStatus>("POST", `/api/mac/dialogs/${encodeURIComponent(id)}/dismiss`, undefined, conn);
          set({ macDialogs: status.dialogs });
        } catch (e) {
          // Gone meanwhile (answered on the Mac): the list as the hub has it now.
          if (e instanceof ApiError && e.status === 404) await get().loadMac().catch(() => {});
          else throw e;
        }
      },

      async stopMacAsker(id) {
        try {
          const status = await api<MacStatus>("POST", `/api/mac/dialogs/${encodeURIComponent(id)}/stop`, undefined, conn);
          set({ macDialogs: status.dialogs });
        } catch (e) {
          // Gone meanwhile, or the program that asked has ("gone": the hub has no Stop for it now): the list as it has it.
          if (e instanceof ApiError && (e.status === 404 || e.code === "gone")) await get().loadMac().catch(() => {});
          throw e;
        }
      },

      async fixOnMac(what) {
        const pty = await api<PtyInfo>("POST", "/api/mac/fix", { what, cols: 60, rows: 8 }, conn);
        set((s) => ({ ptys: { ...s.ptys, [pty.id]: pty } }));
        return pty;
      },

      async dismissMacCrash() {
        const status = await api<MacStatus>("POST", "/api/mac/crash/dismiss", undefined, conn);
        set({ macDialogs: status.dialogs });
        return status;
      },

      async imageEditorCall(on, force) {
        const generation = connectionGeneration;
        const seen = imageEditorEvents;
        const status = await (on === undefined ? api<ImageEditorStatus>("GET", "/api/image-editor", undefined, conn) : api<ImageEditorStatus>("POST", "/api/image-editor", { on, ...(force ? { force: true } : {}) }, conn));
        if (generation === connectionGeneration && seen === imageEditorEvents) set({ imageEditor: status });
        return status;
      },
    };
  });
}
