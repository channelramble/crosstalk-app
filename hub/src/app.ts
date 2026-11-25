import { bookmarkedIds } from "./bookmarks";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, hostname, platform as osPlatform, tmpdir } from "node:os";
import {
  settingsPath,
  FACTORY_DEFAULTS,
  FACTORY_HUB_SETTINGS,
  IDLE_SIGN_OUT_DAYS, idleSignOutDays,
  FACTORY_STORAGE,
  FACTORY_TEAMWORK,
  PERMISSION_MODES,
  PROVIDER_INFO,
  DEFAULT_ACCOUNT,
  helperAtWork,
  limitAgentWords,
  limitWaitWords,
  memberAccount,
  normalizeMode,
  slugHandle,
  type AgentDefaults,
  type AlwaysAllowed,
  type Device,
  type HubInfo,
  type Member,
  type Message,
  type PermissionMode,
  type Provider,
  type Room,
  type HubFolders,
  HubSettings,
  type LimitWait,
  type RoomDefaults,
  type RoomMode,
  type StateSnapshot,
  isServiceOnlyAgent,
  memoryBriefing,
  memoryNoResumeLine,
  CHAT_PROVIDERS,
  type HelpersOn,
} from "@crosstalk/shared";
import { Store } from "./db";
import { Bus } from "./bus";
import { Auth } from "./auth";
import { Engine, HttpError } from "./engine/engine";
import { createDriver } from "./agents";
import type { AgentEndpoint, McpLaunch } from "./agents/driver";
import { HOME, HUB_VERSION, RUN_DIR, readSecrets, writeSecret, type HubConfig } from "./config";
import { newId, secretToken } from "./util/ids";
import { logger } from "./util/log";
import { cutText } from "./util/text";
import { Providers } from "./providers";
import { PtyManager } from "./pty";
import { Push } from "./push";
import { Computers } from "./computers";
import { cleanupUploads, shareImages } from "./uploads";
import { Chats } from "./chats";
import { dropForkCopies } from "./duplicate";
import { Storage } from "./storage";
import { Machines } from "./machines";
import { CrossChat } from "./xchat";
import { askTailscale, tailscaleIPv4 } from "./tailscale";
import { ImageEditor } from "./imageEditor";
import { listenersOn, runCommand, shutdownLocalModels, startLocalModels } from "./localModels";
import { MemoryGuard, blindReader, type HolderProbe } from "./memory";
import { existingLocalRunners, localRunnersOf } from "./localRunners";
import { localLibraryOf } from "./localLibrary";
import { MacServer, clock } from "./mac";
import { FACTORY_SCREEN, ScreenManager } from "./screen";
import { Updater } from "./update";
import { SelfUpdate, releaseSource } from "./selfUpdate";
import { hubService, stagedBuild, takeNextBuild } from "./setup/system";
import { isModelAlias, modelName, pickModel, userNamed } from "./agents/model-lock";
import { forgetConversation } from "./agents/builtin";
import { codexAllowedLabel } from "./agents/codex";
import { ruleLabel, ruleText } from "./mcp/always";
import { Asks } from "./asks";
import { Helpers } from "./helpers";
import { Spend } from "./spend";
import { Services } from "./services";
import { ChatAdapter } from "./adapter";
import { Setup } from "./setup";
import { Templates } from "./templates";
import { systemProbes } from "./setup/system";
import { SignIns, isPersonDevice } from "./signin";
import { BusyFile } from "./busyFile";

const log = logger("app");

export interface AppOptions {
  config: HubConfig;
  dbPath: string;
}

/** Handles that address more than one agent (or the human), so no agent can be called them. */
const RESERVED_HANDLES = ["all", "everyone", "human"];

/** The most agents a group chat takes, added later included (the old rooms had no limit; few had more than four). */
const GROUP_LIMIT = 8;

/** Permission settings from the strictest ("ask") up. */
const PERMISSION_RANK: Record<PermissionMode, number> = { ask: 0, edits: 1, auto: 2, full: 3 };

/** What OpenCode and Crosstalk's agent keep of "Always allow", in the chat's saved session (agents/opencode.ts, builtin.ts). */
interface ServiceAllowed {
  files?: boolean;
  commands?: string[];
  hosts?: string[];
  tools?: string[];
}

export class App {
  readonly store: Store;
  readonly bus = new Bus();
  readonly auth: Auth;
  readonly engine: Engine;
  readonly providers: Providers;
  readonly pty: PtyManager;
  readonly push: Push;
  readonly computers: Computers;
  readonly chats: Chats;
  readonly storage: Storage;
  readonly machines: Machines;
  readonly xchat: CrossChat;
  /** Settings → Image editor: the local AI image editor in the workspace's ai-models folder, switched on and off. */
  readonly imageEditor: ImageEditor;
  /** The memory guard (memory.ts): what's heavy on this machine, whether the next thing fits, and when it's thrashing. */
  readonly memory: MemoryGuard;
  /** Settings → This Mac (on a Mac hub): what keeps it from running unattended, and the dialogs waiting on its screen. */
  readonly mac: MacServer;
  readonly screen: ScreenManager;
  readonly updater: Updater;
  readonly selfUpdate: SelfUpdate;
  /** Ask others (asks.ts): one-shot questions to other agents about a message, answered into cards. */
  readonly asks: Asks;
  /** Helpers that run for a chat's agent on another account (helpers.ts). */
  readonly helpers: Helpers;
  /** What each account has cost, and its spending limit (spend.ts). */
  readonly spend: Spend;
  /** AI services (services.ts): checking a service before use, finding model servers on this machine. */
  readonly services: Services;
  /** The local translator that lets Codex use servers that only speak Chat Completions (adapter/). */
  readonly adapter: ChatAdapter;
  /** What's left to set up on this machine, for the person and for agents already on it (setup/). */
  readonly setup: Setup;
  /** Ways to start a chat (templates.ts): Settings → Templates, New chat → From a template. */
  readonly templates: Templates;
  /** Agent accounts found signed out, and sign-ins started from the phone (signin.ts). */
  readonly signIns: SignIns;
  /** RUN_DIR/busy.json, kept from start() on (busyFile.ts). */
  private busy: BusyFile | null = null;
  private busySince = new Map<string, number>();
  /** Rooms where, since they got busy, a turn answered the user (not only other chats' agents). */
  private answeredUser = new Set<string>();
  /** Approvals a notification went out for (the newest ones): one that changes while it waits isn't news again. */
  private notified = new Set<string>();
  /** Shared secret for the MCP helper processes the hub launches for agents. */
  readonly internalSecret: string;
  /** Where the agents' MCP helpers reach the hub: a Unix socket only this user can open (never the network port). */
  readonly internalSocket: string;

  constructor(readonly opts: AppOptions) {
    // Kept across restarts, so MCP helpers of agents that outlive a restart still get in.
    const inMemory = opts.dbPath === ":memory:";
    this.internalSecret = inMemory ? secretToken() : persistedSecret(join(RUN_DIR, "internal-secret"));
    this.internalSocket = inMemory ? join("/tmp", `ct-${secretToken().replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}.sock`) : join(RUN_DIR, "hub.sock");
    this.store = new Store(opts.dbPath);
    this.auth = new Auth(this.store);
    this.pty = new PtyManager(this.bus);
    this.providers = new Providers(this);
    this.spend = new Spend(this);
    this.adapter = new ChatAdapter(this);
    this.services = new Services(this);
    this.templates = new Templates(this);
    this.push = new Push(this.store, () => this.config.publicUrl);
    this.auth.onRevoked((id) => this.push.removeDevice(id));
    // Rooms from before the two-mode setup (lead, relay, round-robin) now work like Off.
    this.store.normalizeRoomModes();
    this.computers = new Computers(this.store, opts.dbPath === ":memory:" ? scratchDir("crosstalk-ssh-") : join(dirname(opts.dbPath), "ssh"));
    this.chats = new Chats(this);
    // Before the engine, which asks it about replies whose agent's sign-in stopped working.
    this.signIns = new SignIns(this);
    this.engine = new Engine({
      store: this.store,
      bus: this.bus,
      createDriver,
      mcpLaunch: (m) => this.mcpLaunch(m),
      agentEnv: (m) => this.providers.agentEnv(m.provider, memberAccount(m)),
      resolveBin: (p) => this.providers.which(p),
      // Helpers on another account (helpers.ts) stop with the agent that started them, and report as its reply ends.
      stopHelpers: (roomId, memberId) => this.helpers.stop(roomId, memberId),
      replyOver: (room, member, status) => this.helpers.replyOver(room, member, status),
      briefing: (room, member) =>
        [
          this.computers.briefing(),
          // A Mac hub runs unattended: a macOS dialog waits until someone clicks it on the Mac's screen.
          osPlatform() === "darwin" && !inMemory && this.screen.agentsAllowed()
            ? "- This Mac runs unattended: when macOS asks permission, the dialog waits on its screen and what asked stops meanwhile. You can see and answer such a dialog with the screen_ tools; allow only what the task needs. Still prefer ways that raise none: don't search the whole home folder (find ~, rg ~, du ~) or open Photos, Contacts, Calendar, Mail or Messages data unless the task needs it, and reach other computers by their Tailscale addresses."
            : osPlatform() === "darwin" && !inMemory
            ? "- This Mac runs unattended: when macOS asks permission, the dialog waits on its screen until someone clicks it there, and what asked stops meanwhile. Unless the task needs it, don't search the whole home folder (find ~, rg ~, du ~), drive other apps (osascript, System Events), capture the screen, or open Photos, Contacts, Calendar, Mail or Messages data; download with curl, brew or git rather than a browser; and reach other computers by their Tailscale addresses."
            : null,
          // The screen tools (screen/index.ts): what they're for, and what stays the person's.
          this.screen.agentsAllowed()
            ? "- You can see and use this machine's screen with the screen_ tools (screenshot, click, type, key, scroll, drag, windows): for apps with no command line, and for dialogs waiting on the screen, including the system's own permission prompts. Prefer a command or a file edit where one does the job; take a screenshot before you act and check the result after. The person can watch live in Crosstalk's Screen view. Never type their passwords, sign-in codes or keys: ask them to type those themselves there. Don't change system or security settings unless they asked for exactly that."
            : null,
          // A machine with little memory (16 GB or less): a browser left with many pages open is how it runs out.
          inMemory ? null : memoryBriefing(this.memory.reader.ramBytes()),
          this.xchat.offered(room, member)
            ? `- You're on ${this.machineName()}. The user's Crosstalk chats, on this machine and on their other machines, can be reached with list_chats, read_chat and send_to_chat; start_chat starts a new chat. Use them only when the human asks or when another chat has something you need. Other chats can't see this room or this machine's files, so make messages self-contained. Reach other machines' chats only with these tools, never with ssh or curl.`
            : null,
        ]
          .filter(Boolean)
          .join("\n") || null,
      pauseNearLimitPercent: () => (this.hubSettings().pauseNearLimit ? 90 : null),
      // "Carry on when the limit resets": on unless it was turned off (absent means on, as for priceLookup).
      carryOnAfterLimit: () => this.hubSettings().carryOnAfterLimit !== false,
      // New replies wait while the machine is nearly out of memory and agents are what fills it (memory.ts).
      memoryHold: () => this.memory?.holding() ?? false,
      accountLabel: (m) => this.accountLabelOf(m),
      onLimitWait: (e) => this.limitNote(e.kind, e.room, e.wait),
      chatContext: (room, member) => this.chats.context(room, member),
      afterTurn: (room, member) => this.chats.afterTurn(room, member),
      finishReply: (room, text) => shareImages(room, text),
      turnNotice: () => this.storage.agentNotice(),
      crossChat: (room, member) => this.xchat.offered(room, member),
      resetMember: (id) => this.xchat.resetMember(id),
      sessionOver: (id) => forgetConversation(id),
      endpointFor: (m) => this.endpointFor(m.provider, memberAccount(m), m.model),
      checkFolder: (room) => this.checkFolder(room),
      checkBudget: (_room, m) => this.spend.checkBudget(m.provider, memberAccount(m)),
      recordUsage: (room, m, turn, usage) => this.spend.recordTurn(room, m, turn, usage),
      turnStarting: (room, member) => this.chats.turnStarting(room, member),
      modelInfo: (m, model) => this.providers.modelInfo(m.provider, memberAccount(m), model),
      knownModel: (m, model) => this.providers.knownModel(m.provider, memberAccount(m), model),
      // A reply whose agent's sign-in stopped working: the agent starts again once, then its sign-in is checked (signin.ts).
      signIn: this.signIns,
    });
    this.machines = new Machines({
      kvGet: (key) => this.store.kvGet(key),
      kvSet: (key, value) => this.store.kvSet(key, value),
      self: () => ({ id: this.hubId(), name: this.machineName(), url: this.config.publicUrl?.replace(/\/+$/, "") ?? null }),
      notify: async (note) => {
        await this.push.send(note, { skipVisible: true, relayed: true });
      },
      agentsOn: () => this.hubSettings().agentsAcrossChats,
      pairingCode: (ttlMs, opts) => this.auth.createPairingCode(ttlMs, opts),
      getDevice: (id) => this.store.getDevice(id),
      revokeDevice: (id) => this.auth.revoke(id),
      setDeviceHub: (id, hubId) => this.store.setDeviceHub(id, hubId),
      devicesOfHub: (hubId) => this.store.devicesOfHub(hubId),
    });
    this.xchat = new CrossChat(this);
    this.asks = new Asks(this);
    this.helpers = new Helpers(this);
    // The memory guard (memory.ts). In-memory hubs (tests) get a blind one: it reads nothing of this Mac and stands
    // in the way of nothing, the same way they never look for this machine's model servers or Tailscale.
    this.memory = new MemoryGuard({
      machineName: () => this.machineName(),
      holders: () => this.heavyThings(),
      listeners: (port) => listenersOn([port], runCommand).then((m) => m.get(port) ?? []),
      // The same ceiling the "fits this machine?" verdict shows, so the guard and the download screens never disagree.
      machine: () => localLibraryOf(this).machine(),
      emit: (memory) => this.bus.emit({ t: "memory", memory }),
      // About a chat's reply: a tap opens that chat. What Crosstalk stopped is a notification of its own, not a
      // replacement for the warning before it.
      notify: (note) => void this.push.send({ title: note.title, body: note.body, url: note.roomId ? `./#/room/${note.roomId}` : "./#/settings/memory", tag: note.acted ? "memory-acted" : "memory-low" }),
      // "Free memory by itself" (Settings → Memory): on unless it was turned off.
      acts: () => this.hubSettings().memoryAct !== false,
      agents: () => [...this.engine.agentProcesses(), ...this.helpers.processes()],
      act: {
        endIdle: (idleMs) => this.engine.endIdleNow(idleMs),
        hold: () => this.engine.memoryHoldChanged(),
        steer: (memberId, text) => this.engine.noteToReply(memberId, text),
        stop: (roomId, memberId, error) => this.engine.stopForMemory(roomId, memberId, error),
        say: (roomId, text) => void this.engine.systemMessage(roomId, text),
        // Only ever one of the agents' browser's page processes (memory.ts closePages): asked to quit, never killed.
        endPage: (pid) => void process.kill(pid, "SIGTERM"),
      },
      // In-memory hubs (tests) keep nothing, and never read the last run's.
      readState: inMemory ? undefined : () => readText(join(RUN_DIR, "memory.json")),
      writeState: inMemory ? undefined : (text) => keepFile(join(RUN_DIR, "memory.json"), text),
      ...(inMemory ? { reader: blindReader("Crosstalk keeps nothing on disk here, so it doesn't watch the machine's memory.") } : {}),
    });
    this.imageEditor = new ImageEditor({
      dir: join(opts.config.workspaceRoot, "ai-models", "image-editor"),
      logFile: inMemory ? join(scratchDir("crosstalk-image-editor-"), "server.log") : imageEditorLog(),
      // In-memory hubs (tests) never pick up a server an earlier run noted.
      pidFile: inMemory ? undefined : join(RUN_DIR, "image-editor.json"),
      emit: (status) => this.bus.emit({ t: "imageEditor", status }),
      tailscaleIp: () => tailscaleIPv4(),
      // The editor is ComfyUI, not llama.cpp: it is measured against the machine's memory ("ram"), never against
      // Metal's working set, which is two thirds of this Mac and less than one edit needs on a machine that runs it
      // every day. docs: shared's `roomFor`.
      beforeStart: (need, force) => this.memory.check({ what: "the image editor", needBytes: need, on: "ram", force }).then(() => {}),
      // `syncPage` is deliberately not set: the hub never writes this build's phone page into the user's editor
      // install on its own. Their installed page may be one they edited by hand, and replacing it changes what
      // their phone is served at the next reload, so that is a moment a person picks. docs/IMAGE-EDITOR.md.
    });
    // In a test hub nothing is kept on disk, so neither is the screen's password.
    let testScreenPassword = "";
    this.screen = new ScreenManager({
      settings: () => ({ ...FACTORY_SCREEN, ...(this.hubSettings().screen ?? {}) }),
      save: (next) => {
        const all = this.hubSettings();
        this.store.kvSet("hubSettings", JSON.stringify({ ...all, screen: next }));
      },
      password: () => (inMemory ? testScreenPassword : readSecrets().SCREEN_PASSWORD ?? ""),
      setPassword: (p) => (inMemory ? void (testScreenPassword = p ?? "") : writeSecret("SCREEN_PASSWORD", p)),
      changed: () => {
        this.bus.emit({ t: "hub", hub: this.hubInfo() });
        // Agents get (or lose) the screen tools when they start: restart idle ones now, busy ones after their turn.
        for (const r of this.store.listRooms()) for (const m of this.store.listMembers(r.id)) void this.engine.memberChanged(m.id);
      },
      hubPid: process.pid,
    });
    this.updater = new Updater({
      staged: inMemory ? async () => null : stagedBuild(runQuietly),
      working: () => this.workingChats(),
      // The same way out as a signal from the service: main.ts shuts everything down and exits, and the service starts
      // the hub again, on the new build.
      restart: () => {
        // A build that waited beside this one goes in its place now, at the last moment (see nextBuildPath).
        if (takeNextBuild(HUB_VERSION)) log.info("the new build is in place");
        process.kill(process.pid, "SIGTERM");
      },
      changed: () => this.bus.emit({ t: "hub", hub: this.hubInfo() }),
    });
    // Updates from the app: a newer release is offered, and one button downloads it to where the Updater finds it.
    // Only Crosstalk's own program does any of it: a hub run from its source (every test's) asks GitHub nothing.
    this.selfUpdate = new SelfUpdate({
      version: HUB_VERSION,
      path: process.execPath,
      compiled: !inMemory && (Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\")),
      platform: osPlatform(),
      arch: process.arch,
      ...releaseSource(),
      run: runQuietly,
      restarts: async () => {
        const service = await hubService(runQuietly);
        return service ? service.runningUnder !== "none" : null;
      },
      ready: () => this.updater.status(),
      staged: () => this.updater.look(),
      changed: () => this.bus.emit({ t: "hub", hub: this.hubInfo() }),
      auto: !process.env.CROSSTALK_NO_UPDATE_CHECK,
    });
    this.mac = new MacServer({
      run: (args, timeoutMs) => runQuietly(args, timeoutMs),
      readable: (path) => canRead(path),
      stream: (onLine, onExit) => streamPrivacyLog(onLine, onExit),
      history: (start) => privacyLogSince(start),
      emit: (dialogs) => this.bus.emit({ t: "macDialogs", dialogs }),
      // Reached a phone, or there was none to reach (false: try again later).
      notify: (note, opts) => this.push.send({ ...note, url: "./#/settings/this-mac" }, { skipVisible: !opts?.always }).then((r) => r.sent > 0 || r.failed === 0),
      dropNote: (tag, text) => this.push.drop(tag, text),
      self: process.execPath,
      name: () => this.machineName(),
      tailscaleStatus: () => askTailscale().then((a) => a.status),
      // In-memory hubs (tests) keep nothing, and never read the last run's.
      readState: inMemory ? undefined : () => readText(join(RUN_DIR, "mac.json")),
      writeState: inMemory ? undefined : (text) => keepFile(join(RUN_DIR, "mac.json"), text),
      files: (dir) => filesIn(dir),
      readText: (path) => readText(path),
    });
    // Linked machines' hubs get this one's notifications too (see machines.ts).
    this.push.onSend = (note) => this.machines.forward(note);
    this.storage = new Storage({
      rooms: () => this.store.listRooms(),
      isBusy: (roomId) => this.engine.isBusy(roomId),
      settings: () => this.hubSettings().storage,
      kvGet: (key) => this.store.kvGet(key),
      kvSet: (key, value) => this.store.kvSet(key, value),
      workspaceRoot: opts.config.workspaceRoot,
      execPath: process.execPath,
      onStatus: (status) => this.bus.emit({ t: "storage", status }),
      onLow: (s) =>
        void this.push.send({
          title: `${this.machineName()} is low on storage`,
          body: `${(s.free / 1024 ** 3).toFixed(1)} GB free on ${hostname()}${s.free < s.reserve ? ": uploads are paused until there's more room" : ""}. ${settingsPath("storage")} shows what can go.`,
          url: "./#/settings/storage",
          tag: "storage-low",
        }),
    });
    // In-memory hubs (tests) never look at this machine's service, Tailscale or log: tests hand them fakes.
    this.setup = new Setup(this, selfCommand(), inMemory ? {} : systemProbes(runQuietly, osPlatform() === "darwin" ? () => this.mac.status() : null));
  }

  get config() {
    return this.opts.config;
  }

  async start() {
    await this.push.init();
    this.bus.on((e) => this.notify(e));
    // What it's busy with that its database doesn't show (background work, wake-ups agents owe), for the restart scripts.
    this.busy = new BusyFile(this.opts.dbPath === ":memory:" ? null : join(RUN_DIR, "busy.json"), () => this.engine.busyWork(), (fn) => this.bus.on(fn));
    this.removeRetiredAgents();
    // Pick up the work a restart interrupted, now that everything an agent needs is ready.
    // Except the reply that was filling the machine when it last went down out of memory: that one waits for the person.
    const down = this.memory.wentDown();
    this.engine.resumeAfterRestart((m) => (down && down.memberId === m.id ? memoryNoResumeLine(this.machineName(), clock(down.at)) : null));
    // Helpers on another account that the last hub left working, and reports nobody had read: their agents are told.
    this.helpers.restore();
    // Tidy uploads that were never sent, now and every 6 hours.
    this.cleanupUploads();
    setInterval(() => this.cleanupUploads(), 6 * 60 * 60_000).unref?.();
    // A person's device that has sent no message for a month (Settings → This device → Paired devices) is signed out:
    // looked at a minute after the start, then every hour.
    const quiet = () => {
      try {
        this.signOutIdleDevices();
      } catch (e) {
        log.warn(`signing out quiet devices: ${e instanceof Error ? e.message : e}`);
      }
    };
    this.quietTimers = [setTimeout(quiet, 60_000), setInterval(quiet, 60 * 60_000)];
    for (const t of this.quietTimers) t.unref?.();
    // Watch free space and clear caches on a schedule (never in tests, which run against this Mac's real caches).
    if (this.opts.dbPath !== ":memory:") {
      this.storage.start();
      // Watch this machine's memory, so nothing heavy starts into a machine that is already thrashing.
      this.memory.start();
      // Finish what a restart interrupted (an unlink, connecting agents), then retry failed links every minute.
      this.machines.start();
      void this.machines.retryTick().then(() => this.machines.complete());
      // Model downloads (Settings → Local models) that were running when the hub stopped carry on.
      void startLocalModels(this).catch((e) => log.warn(`local models: ${e instanceof Error ? e.message : e}`));
    }
    // An image editor left running (or still starting) when the hub restarted shows as on.
    void this.imageEditor.start().catch((e) => log.warn(`image editor: ${e instanceof Error ? e.message : e}`));
    // A Mac's privacy dialogs are told to the phone while they wait on its screen (never in tests: that's this Mac's).
    if (osPlatform() === "darwin" && this.opts.dbPath !== ":memory:") void this.mac.start();
    // The machine's screen: is it shared, and does the password Crosstalk has still work (screen/index.ts).
    if (this.opts.dbPath !== ":memory:" || process.env.CROSSTALK_SCREEN_PORT) this.screen.start();
    // A new build put in place starts by itself once the chats are quiet (update.ts).
    if (this.opts.dbPath !== ":memory:") this.updater.start();
    // And a newer release on GitHub is looked for now and then (selfUpdate.ts).
    if (this.opts.dbPath !== ":memory:") this.selfUpdate.start();
  }

  /**
   * Agents of a kind this hub no longer supports (Claude Code (cloud) was removed) are taken out of their rooms, with
   * a note, and anything stored for them (a routine token) is deleted.
   */
  private removeRetiredAgents() {
    // Routine tokens were only ever stored for cloud agents: delete them all, including ones whose agent went with a
    // deleted room.
    this.store.kvDeletePrefix("memberSecret:");
    // Saved defaults may still name the retired kind (agents for new rooms, per-agent defaults): drop it, so saving
    // Settings doesn't fail on an option that no longer exists.
    let saved: Partial<RoomDefaults> | null = null;
    try {
      saved = JSON.parse(this.store.kvGet("defaults") ?? "null");
    } catch {
      saved = null;
    }
    if (saved && typeof saved === "object") {
      const known = (p: string) => p in PROVIDER_INFO;
      const agents = Array.isArray(saved.agents) ? saved.agents.filter((p) => known(p)) : saved.agents;
      const agent = saved.agent && typeof saved.agent === "object" ? Object.fromEntries(Object.entries(saved.agent).filter(([p]) => known(p))) : saved.agent;
      if (JSON.stringify(agents) !== JSON.stringify(saved.agents) || JSON.stringify(agent) !== JSON.stringify(saved.agent)) {
        this.store.kvSet("defaults", JSON.stringify({ ...saved, agents, agent }));
      }
    }
    for (const m of this.store.membersOfUnknownKind(Object.keys(PROVIDER_INFO))) {
      this.store.deleteMember(m.id);
      const room = this.store.getRoom(m.roomId);
      if (room?.leadMemberId === m.id) this.store.updateRoom(room.id, { leadMemberId: null });
      if (room) this.engine.systemMessage(room.id, `@${m.handle} was removed: Crosstalk no longer supports ${m.provider === "claude-cloud" ? "Claude Code (cloud)" : `"${m.provider}"`} agents.`);
      log.info(`removed @${m.handle} (${m.provider}): no longer supported`);
    }
  }

  cleanupUploads(olderThanMs?: number): number {
    // Rooms can share a project folder (and so its uploads): gather every room's references per folder first,
    // so a file sent in one room is never swept as unused by another. A message can also link to another room's
    // uploads (a duplicated chat's copy that couldn't copy a file): that counts for the folder of the room it links to.
    const rooms = this.store.listRooms();
    const byFolder = new Map<string, { cwd: string; texts: string[]; names: string[] }>();
    const folderOf = new Map<string, string>();
    for (const room of rooms) {
      let key: string;
      try { key = realpathSync(room.cwd); } catch { continue; } // folder gone: nothing to clean
      const entry = byFolder.get(key) ?? { cwd: room.cwd, texts: [], names: [] };
      entry.names.push(room.name);
      byFolder.set(key, entry);
      folderOf.set(room.id, key);
    }
    for (const room of rooms) {
      for (const text of this.store.uploadMentions(room.id)) {
        const linked = new Set([room.id, ...[...text.matchAll(/\/api\/rooms\/([\w-]+)\/(?:uploads|folders)\//g)].map((m) => m[1])]);
        for (const id of linked) {
          const key = folderOf.get(id);
          if (key) byFolder.get(key)!.texts.push(text);
        }
      }
    }
    let removed = 0;
    for (const { cwd, texts, names } of byFolder.values()) {
      try {
        removed += cleanupUploads({ cwd }, texts, olderThanMs);
      } catch (e) {
        log.warn(`upload cleanup failed for ${names.join(", ")}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (removed) log.info(`removed ${removed} unsent upload(s)`);
    return removed;
  }

  /**
   * Push notifications for things worth interrupting you for. The title is the chat (a lock screen cuts off the end of
   * a line, so the chat comes first); the text says who and what: "Codex needs your OK: npm test".
   */
  private notify(e: import("@crosstalk/shared").ServerEvent) {
    // Answered (or expired): a phone that hasn't shown its notification yet doesn't, nor shows it again.
    if (e.t === "approval" && e.approval.status !== "pending") this.push.drop(e.approval.id, e.approval.status === "expired" ? "No longer waiting for you" : "Already answered");
    if (e.t === "approval" && e.approval.status === "pending") {
      const a = e.approval;
      // Once per card: one whose countdown starts or stops (seen, held) is the same request.
      if (this.notified.has(a.id)) return;
      this.notified.add(a.id);
      if (this.notified.size > 1000) this.notified.delete(this.notified.values().next().value!);
      // Questions the agent asked together (a card each) come with one notification, the first one's.
      if (a.delivery === "async" && this.store.listPendingApprovals().some((x) => x.id !== a.id && x.delivery === "async" && x.turnId === a.turnId && x.memberId === a.memberId && this.notified.has(x.id) && a.createdAt - x.createdAt < 5000)) return;
      const room = this.store.getRoom(a.roomId);
      const who = agentWords(room, this.store.getMember(a.memberId));
      const body = a.kind === "question" ? said(`${who} has a question`, a.questions?.[0]?.question ?? a.title) : said(`${who} needs your OK`, a.title);
      void this.push.send({ title: room?.name ?? "Crosstalk", body, url: `./#/room/${a.roomId}`, tag: a.id }, { skipVisible: true });
    } else if (e.t === "turn") {
      const t = e.turn;
      if (t.status === "running" && !this.busySince.has(t.roomId)) this.busySince.set(t.roomId, Date.now());
      if (t.status === "error") {
        const room = this.store.getRoom(t.roomId);
        const who = agentWords(room, this.store.getMember(t.memberId));
        void this.push.send({ title: room?.name ?? "Crosstalk", body: said(`${who} stopped with an error`, (t.error ?? "").slice(0, 140)), url: `./#/room/${t.roomId}`, tag: `err-${t.id}` }, { skipVisible: true });
      }
      // Room icons show who has worked in a room: tell clients when that changes.
      if (t.status === "done") this.bus.emit({ t: "roomActivity", roomId: t.roomId, activity: this.store.roomActivity(t.roomId)[t.roomId] ?? [] });
      if (t.status === "done" || t.status === "error" || t.status === "stopped") {
        if (t.status === "done" && !this.engine.isRelayTurn(t) && !this.engine.isContinuationTurn(t)) this.answeredUser.add(t.roomId);
        // Relays are queued right after this event; check once things settle.
        setTimeout(() => {
          if (this.engine.isBusy(t.roomId)) return;
          const since = this.busySince.get(t.roomId);
          this.busySince.delete(t.roomId);
          const answeredUser = this.answeredUser.delete(t.roomId);
          if (!since || Date.now() - since < 30_000 || t.status === "stopped") return;
          // Only other chats' messages were answered: their agents get the replies, so no "finished" notification.
          if (t.status === "done" && !answeredUser) return;
          const room = this.store.getRoom(t.roomId);
          const last = this.store.listMessages(t.roomId, { limit: 1 })[0];
          // A chat is one agent: say which. In a group chat, the agent that wrote last.
          const who = room?.chat && !room.chat.group ? PROVIDER_INFO[room.chat.provider].name : last?.memberId ? `@${last.authorName}` : "The agents";
          const text = (last?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
          void this.push.send({ title: room?.name ?? "Crosstalk", body: said(`${who} finished`, text), url: `./#/room/${t.roomId}`, tag: `done-${t.roomId}` }, { skipVisible: true });
        }, 800);
      }
    }
  }

  /** What to call a member's account in a limit's words ("Work"); null for the agent's own sign-in. */
  private accountLabelOf(m: Member): string | null {
    const id = memberAccount(m);
    if (id === DEFAULT_ACCOUNT) return null;
    return this.providers.accounts().find((a) => a.provider === m.provider && a.id === id)?.label ?? null;
  }

  /**
   * A chat started waiting for a usage limit, or has carried on. Limits are per account, so several chats waiting on
   * one account make one notification, not a storm: the notes of an account settle for a moment, then go as one, under
   * a tag per account so a push service keeps only the newest.
   */
  private limitNotes = new Map<string, { rooms: Set<string>; wait: LimitWait; timer: ReturnType<typeof setTimeout> }>();

  private limitNote(kind: "waiting" | "carried" | "gave-up", room: Room, wait: LimitWait) {
    const waitTag = `limit-wait-${wait.provider}-${wait.account}`;
    const backTag = `limit-back-${wait.provider}-${wait.account}`;
    // A note of this account's that hasn't gone yet: it doesn't go at all (it would say the wrong thing).
    const drop = (tag: string) => {
      const pending = this.limitNotes.get(tag);
      if (pending) clearTimeout(pending.timer);
      this.limitNotes.delete(tag);
    };
    if (kind === "waiting") {
      // Stopped again moments after carrying on: the news that it carried on doesn't go out.
      drop(backTag);
    } else {
      drop(waitTag);
      // The standing note only goes when this account has no chat left waiting; with others still waiting it says so
      // again, with how many — one chat carrying on mustn't take away the only word the phone has about the rest.
      const left = this.engine.limitWaitsOn(wait.provider, wait.account);
      if (left.length) this.queueLimitNote("waiting", waitTag, left.map((w) => w.roomId), left[0].wait);
      else this.push.drop(waitTag, kind === "carried" ? "Carrying on now" : "No longer waiting");
      // Giving up is a failed reply: that path's own notification says so.
      if (kind === "gave-up") return;
    }
    this.queueLimitNote(kind === "waiting" ? "waiting" : "carried", kind === "waiting" ? waitTag : backTag, [room.id], wait);
  }

  /** One note per account, after a moment's settling: "…is out of messages until 3:20 PM. +2 other chats." */
  private queueLimitNote(kind: "waiting" | "carried", tag: string, roomIds: string[], wait: LimitWait) {
    const cur = this.limitNotes.get(tag);
    if (cur) {
      for (const id of roomIds) cur.rooms.add(id);
      cur.wait = wait;
      return;
    }
    const entry = {
      rooms: new Set(roomIds),
      wait,
      timer: setTimeout(() => {
        this.limitNotes.delete(tag);
        const ids = [...entry.rooms];
        const others = ids.length - 1;
        const also = others > 0 ? ` +${others} other chat${others === 1 ? "" : "s"}.` : "";
        const body = kind === "waiting" ? `${limitWaitWords(entry.wait)}${also}` : `${limitAgentWords(entry.wait)} carried on where it left off.${also}`;
        const first = this.store.getRoom(ids[0]);
        void this.push.send(
          { title: ids.length === 1 ? first?.name ?? "Crosstalk" : `${ids.length} chats`, body, url: ids.length === 1 ? `./#/room/${ids[0]}` : "./#/", tag },
          { skipVisible: true },
        );
      }, 800),
    };
    (entry.timer as { unref?: () => void }).unref?.();
    this.limitNotes.set(tag, entry);
  }

  hubInfo(): HubInfo {
    return {
      version: HUB_VERSION,
      hostname: hostname(),
      platform: osPlatform(),
      workspaceRoot: this.config.workspaceRoot,
      publicUrl: this.config.publicUrl,
      id: this.hubId(),
      name: this.machineName(),
      // Always, since 0.8 (the switch is gone): a message goes into a working agent's reply by itself, helpers or not.
      messagesFlow: true,
      flowsIn: true,
      screen: { ready: this.screen.ready(), agents: this.screen.agentsAllowed() },
      update: this.updater.status(),
      release: this.selfUpdate.brief(),
    };
  }

  /**
   * The chats where something is working, by name: a reply running or waiting its turn, an agent's background work or a
   * reply it owes by itself, a question to another agent. What an update waits for (update.ts).
   */
  workingChats(): string[] {
    const ids = new Set<string>();
    for (const r of this.store.listRooms()) if (this.engine.isBusy(r.id)) ids.add(r.id);
    for (const b of this.engine.busyWork()) ids.add(b.roomId);
    const names = [...ids].map((id) => this.store.getRoom(id)?.name ?? "a chat");
    try {
      const asking = this.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE status IN ('running', 'queued')").get() as { n: number } | null;
      if (asking?.n) names.push("a question to another agent");
    } catch {
      // no asks yet
    }
    return names;
  }

  /** This hub's id, made once: tells it apart from other machines' hubs in the app. */
  /**
   * A chat's folder that was moved or deleted outside Crosstalk. One inside Crosstalk's own workspace folder is made
   * again, empty, with a note in the chat (the conversation lives with the agent, not in the folder); any other folder
   * is the person's to put back or change, and the reply says so.
   */
  private checkFolder(room: Room): string | null {
    if (!room.cwd || existsSync(room.cwd)) return null;
    const dir = resolve(room.cwd);
    // A chat gives the message back (the agent never got it) and its reply offers Try again; an older room doesn't.
    const again = room.chat ? "tap Try again" : "send your message again";
    const root = resolve(this.config.workspaceRoot);
    if (dir.startsWith(root + sep)) {
      try {
        mkdirSync(dir, { recursive: true });
        this.engine.systemMessage(room.id, `This chat's folder was gone (moved or deleted outside Crosstalk), so Crosstalk made it again, empty: ${dir}. The messages are all still here; files that were in the folder aren't.`);
        return null;
      } catch (e) {
        return `This chat's folder ${dir} is gone and couldn't be made again (${e instanceof Error ? e.message : e}). Pick another folder in the chat's settings, then ${again}.`;
      }
    }
    return `This chat's folder isn't there any more: ${dir}. Put it back, or pick another folder in the chat's settings, then ${again}.`;
  }

  hubId(): string {
    let id = this.store.kvGet("hubId");
    if (!id) {
      id = newId("h");
      this.store.kvSet("hubId", id);
    }
    return id;
  }

  /** What this machine is called in the app: the name set in Settings, or the computer's name. */
  machineName(): string {
    return this.hubSettings().machineName || computerName();
  }

  snapshot(device: Device): StateSnapshot {
    return {
      hub: this.hubInfo(),
      rooms: this.store.listRooms(),
      members: this.store.listMembers(),
      approvals: this.store.listPendingApprovals(),
      usage: this.store.listUsage(),
      accounts: this.providers.accounts(),
      roomActivity: this.store.roomActivity(),
      providers: this.providers.list(),
      device,
      storage: this.storageStatus(),
      macDialogs: this.mac.dialogs(),
      templates: this.templates.list(),
      memory: this.memory.status(),
      // Agent accounts found signed out, and the sign-ins started from the phone (signin.ts): those, with their links
      // and codes, for people's own devices only, never another machine's hub.
      signIns: this.signIns.needs(),
      signInSessions: isPersonDevice(device) ? this.signIns.sessions() : [],
      // What the person keeps (bookmarks.ts): their own devices', never another machine's hub.
      bookmarked: isPersonDevice(device) ? bookmarkedIds(this) : {},
      // For the chat list, about chats a device hasn't opened (their history has the rest): since when each running
      // reply has run, and the helpers still at work after a reply ended.
      replyStarts: Object.fromEntries(this.store.unfinishedTurns().filter((t) => t.status === "running").map((t) => [t.memberId, { turnId: t.id, at: t.startedAt ?? t.createdAt }])),
      tasks: Object.fromEntries(
        this.engine
          .busyWork()
          .filter((w) => w.why === "background")
          .map((w) => [w.memberId, this.engine.tasksIn(w.roomId)[w.memberId] ?? []] as const)
          .filter(([, tasks]) => tasks.some(helperAtWork)),
      ),
    };
  }

  /**
   * The heavy things running on this machine, for the memory guard. Nothing here starts a scan or a process: the
   * image editor and the servers Crosstalk started are already known, and the person's own model servers are the
   * ones their custom-model accounts point at on this machine (that is how the hub knows the llama-server it never
   * started). Each is looked up only when the guard counts them -- before a start, or once a minute in trouble.
   */
  private async heavyThings(): Promise<HolderProbe[]> {
    const out: HolderProbe[] = [];
    if (this.imageEditor.lastStatus().installed) {
      // One Crosstalk found running counts too: the switch in Settings turns that one off as well. While it starts and
      // loads its weights nothing has measured it yet (three minutes plus six), and a ComfyUI the person started
      // themselves is unknown to the hub until somebody opens Settings -- so `heavy()` answers with what it holds or
      // what one edit needs, whichever is bigger, and with its port while the hub thinks nothing of its is running.
      const e = this.imageEditor.heavy();
      out.push({ what: "the image editor", ours: true, section: "image-editor", bytes: e.bytes, port: e.port, ...(e.pid ? { claims: [e.pid] } : {}) });
    }
    for (const r of existingLocalRunners(this)?.heavy() ?? []) out.push({ what: r.what, ours: true, section: "local-models", pid: r.pid });
    // The ports of what Crosstalk started: each is already counted above by its process.
    const ours = new Set(Object.keys(existingLocalRunners(this)?.ports() ?? {}).map(Number));
    const seen = new Set<number>();
    for (const a of this.providers.accounts()) {
      const url = a.endpoint?.baseUrl;
      if (!url) continue;
      let port: number;
      try {
        const u = new URL(url);
        if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") continue;
        port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
      } catch {
        continue;
      }
      if (ours.has(port) || seen.has(port)) continue;
      seen.add(port);
      // The person started it, so Crosstalk never ends it and never offers to: it only says what it is holding.
      out.push({ what: `the model running on port ${port}`, ours: false, section: null, port });
    }
    return out;
  }

  /** The disk at a glance, for clients; absent if it can't be read. */
  storageStatus() {
    try {
      return this.storage.status();
    } catch {
      return undefined;
    }
  }

  /** How an agent process launches the room MCP helper (this same program, `mcp` subcommand). */
  mcpLaunch(member: Member): McpLaunch {
    const self = selfCommand();
    return {
      command: self[0],
      args: [...self.slice(1), "mcp"],
      hook: [...self, "hook"],
      env: {
        CROSSTALK_HUB_SOCKET: this.internalSocket,
        CROSSTALK_MEMBER_ID: member.id,
        CROSSTALK_MEMBER_TOKEN: this.internalToken(member.id),
        // The screen tools, while the person lets agents use the screen and it can be reached (screen/index.ts).
        ...(this.screen.agentsAllowed() ? { CROSSTALK_SCREEN: "1" } : {}),
      },
    };
  }

  /** A member's own key for the internal API: one agent's helper can't act as another member. */
  internalToken(memberId: string): string {
    return createHmac("sha256", this.internalSecret).update(memberId).digest("hex");
  }

  /** Whether `token` is `memberId`'s internal key (compared in constant time). */
  checkInternalToken(memberId: string, token: string): boolean {
    const want = Buffer.from(this.internalToken(memberId));
    const got = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  // ---------------------------------------------------------------- rooms

  /** Hub-wide settings, merged over the built-in ones. */
  /**
   * Every folder a new chat could work in (GET /api/folders): the folders this hub's chats work in that still exist, newest
   * use first, then the rest of its workspaces folder by name. Throwaway temp folders are left out.
   */
  folders(): HubFolders {
    const root = this.config.workspaceRoot;
    const temp = /^(\/private)?\/tmp\b|^\/var\/folders\//;
    const isDir = (p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    };
    const used = new Map<string, number>();
    for (const r of this.store.listRooms()) if (r.cwd && !temp.test(r.cwd)) used.set(r.cwd, Math.max(used.get(r.cwd) ?? 0, r.updatedAt));
    const out: HubFolders["folders"] = [...used].filter(([p]) => isDir(p)).sort((a, b) => b[1] - a[1]).map(([path, usedAt]) => ({ path, usedAt }));
    const known = new Set(out.map((f) => f.path));
    let inRoot: string[] = [];
    try {
      inRoot = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(root, e.name));
    } catch {
      // No workspaces folder yet: the chats' folders are all there is.
    }
    for (const path of inRoot.sort((a, b) => a.localeCompare(b))) if (!known.has(path)) out.push({ path, usedAt: null });
    return { root, folders: out };
  }

  hubSettings(): HubSettings {
    let saved: Partial<HubSettings> = {};
    try { saved = JSON.parse(this.store.kvGet("hubSettings") ?? "{}"); } catch { /* corrupt: use the built-ins */ }
    const teamwork = { ...FACTORY_TEAMWORK, ...(saved.teamwork ?? {}), helper: { ...FACTORY_TEAMWORK.helper, ...(saved.teamwork?.helper ?? {}) } };
    const storage = { ...FACTORY_STORAGE, ...(saved.storage ?? {}) };
    return { ...FACTORY_HUB_SETTINGS, ...saved, machineName: typeof saved.machineName === "string" ? saved.machineName : "", teamwork, storage, screen: { ...FACTORY_SCREEN, ...(saved.screen ?? {}) } };
  }

  /** The timers that look for quiet devices (start), ended at shutdown. */
  private quietTimers: ReturnType<typeof setTimeout>[] = [];

  /** Signs out the people's devices that have said nothing for as long as the settings allow; returns how many. */
  signOutIdleDevices(now = Date.now()): number {
    const gone = this.auth.signOutIdle(idleSignOutDays(this.hubSettings()), now);
    for (const d of gone) log.info(`signed out "${d.name}": no message from it for ${idleSignOutDays(this.hubSettings())} days`);
    return gone.length;
  }

  setHubSettings(input: Partial<HubSettings>): HubSettings {
    const next = this.hubSettings();
    if (input.machineName !== undefined) next.machineName = String(input.machineName ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const crossBefore = next.agentsAcrossChats;
    if (input.agentsAcrossChats !== undefined) next.agentsAcrossChats = !!input.agentsAcrossChats;
    // Off is what an unsaved setting means, so off is saved as nothing.
    if (input.agentsFromMachinesAct !== undefined) {
      if (input.agentsFromMachinesAct) next.agentsFromMachinesAct = true;
      else delete next.agentsFromMachinesAct;
    }
    if (input.pauseNearLimit !== undefined) next.pauseNearLimit = !!input.pauseNearLimit;
    if (input.priceLookup !== undefined) next.priceLookup = !!input.priceLookup;
    if (input.carryOnAfterLimit !== undefined) next.carryOnAfterLimit = !!input.carryOnAfterLimit;
    // Days without a message before a person's device is signed out: 0 turns it off, and it's at most a year.
    // The usual 30 is what an unsaved setting means, so it's saved as nothing.
    if (input.idleSignOutDays !== undefined) {
      const days = idleSignOutDays({ idleSignOutDays: Number(input.idleSignOutDays) });
      if (days === IDLE_SIGN_OUT_DAYS) delete next.idleSignOutDays;
      else next.idleSignOutDays = days;
    }
    const actBefore = next.memoryAct !== false;
    if (input.memoryAct !== undefined) next.memoryAct = input.memoryAct !== false;
    // "Keep going while helpers work" went in 0.8 (a message always goes to a working agent by itself): what an older app
    // saves for it is kept as it sent it, and nothing goes by it.
    if (input.messagesFlow !== undefined) next.messagesFlow = input.messagesFlow !== false;
    const before = JSON.stringify(next.teamwork);
    if (input.teamwork !== undefined) {
      const t = input.teamwork ?? {};
      if (t.enabled !== undefined) next.teamwork.enabled = !!t.enabled;
      if (t.perReply !== undefined) next.teamwork.perReply = clamp(Number(t.perReply), 1, 3);
      if (t.skipAbovePercent !== undefined) next.teamwork.skipAbovePercent = clamp(Number(t.skipAbovePercent), 50, 100);
      // Who agents may ask: the accounts ticked (only this machine's, each once); null goes back to "the other agent".
      if (t.who !== undefined) {
        if (!Array.isArray(t.who)) delete next.teamwork.who;
        else {
          const all = this.providers.accounts();
          const seen = new Set<string>();
          next.teamwork.who = t.who
            .filter((w) => !!w && typeof w.provider === "string" && typeof w.account === "string" && (CHAT_PROVIDERS as readonly string[]).includes(w.provider) && all.some((a) => a.provider === w.provider && a.id === w.account))
            .filter((w) => !seen.has(`${w.provider}:${w.account}`) && !!seen.add(`${w.provider}:${w.account}`))
            .map((w) => ({ provider: w.provider, account: w.account }));
        }
      }
      if (t.helper !== undefined && typeof t.helper === "object") {
        for (const [p, h] of Object.entries(t.helper ?? {})) {
          if (!PROVIDER_INFO[p as Provider] || !h || typeof h !== "object") continue;
          next.teamwork.helper[p as Provider] = {
            model: typeof h.model === "string" && h.model.trim() ? h.model.trim().slice(0, 200) : null,
            effort: typeof h.effort === "string" && h.effort.trim() ? h.effort.trim().slice(0, 40) : null,
          };
        }
      }
    }
    // Who does helper work in new chats; null: each agent's own helpers. Chats that exist keep what they have.
    if (input.helpers !== undefined) {
      const h = this.cleanHelpers(input.helpers);
      if (h) next.helpers = h;
      else delete next.helpers;
    }
    if (input.storage !== undefined && input.storage && typeof input.storage === "object") {
      const st = input.storage;
      if (st.autoClean !== undefined) next.storage.autoClean = !!st.autoClean;
      if (st.lowSpaceGb !== undefined) next.storage.lowSpaceGb = clamp(Math.round(Number(st.lowSpaceGb)), 5, 100);
    }
    this.store.kvSet("hubSettings", JSON.stringify(next));
    // A new warning level may change whether space counts as low.
    void this.storage.check();
    // "Free memory by itself" was switched: every device's Memory card follows, and nothing waits for memory once it's off.
    if ((next.memoryAct !== false) !== actBefore) this.memory.settingChanged();
    if (next.agentsAcrossChats !== crossBefore) {
      // Agents get (or lose) the tools for other chats when they start: restart idle ones now, busy ones after.
      for (const r of this.store.listRooms()) for (const m of this.store.listMembers(r.id)) void this.engine.memberChanged(m.id);
      // Turned on: linked machines connect for it.
      if (next.agentsAcrossChats) void this.machines.complete();
    }
    // Chat agents learn about teamwork when they start: restart idle ones now (busy ones after their turn).
    if (JSON.stringify(next.teamwork) !== before) {
      for (const r of this.store.listRooms()) if (r.chat) for (const m of this.store.listMembers(r.id)) void this.engine.memberChanged(m.id);
    }
    return next;
  }

  /**
   * A "Helpers run on" choice as it's kept (HelpersOn), checked: the account must be one of this machine's, of an agent
   * that can run a helper. Null for "the agent's own helpers" (null, "" or nothing picked).
   */
  cleanHelpers(raw: unknown): HelpersOn | null {
    if (raw === null || raw === undefined || raw === "") return null;
    const h = raw as Partial<Record<keyof HelpersOn, unknown>>;
    if (typeof h !== "object") throw new HttpError(400, "Pick who helpers run on.");
    if (!(CHAT_PROVIDERS as readonly unknown[]).includes(h.provider) || typeof h.account !== "string" || !this.providers.accounts().some((a) => a.provider === h.provider && a.id === h.account)) throw new HttpError(400, "That account isn't on this machine any more. Pick another for helpers.");
    const name = (v: unknown, what: string): string | null => {
      if (v === undefined || v === null || v === "") return null;
      if (typeof v !== "string" || !/^[\w.:@/[\]-]{1,100}$/.test(v)) throw new HttpError(400, `bad helper ${what}`);
      return v;
    };
    const model = name(h.model, "model");
    const effort = name(h.effort, "effort");
    return { provider: h.provider as Provider, account: h.account, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(h.fallback === false ? { fallback: false } : {}) };
  }

  /** The same for a new chat on `provider` and `account`: the machine's default, unless that is the chat's own account. */
  defaultHelpers(provider: Provider, account: string): HelpersOn | null {
    const h = this.hubSettings().helpers;
    if (!h || (h.provider === provider && h.account === account)) return null;
    return this.providers.accounts().some((a) => a.provider === h.provider && a.id === h.account) ? h : null;
  }

  /** Settings → Defaults, merged over the built-in ones. */
  defaults(): RoomDefaults {
    let saved: Partial<RoomDefaults> = {};
    try { saved = JSON.parse(this.store.kvGet("defaults") ?? "{}"); } catch { /* corrupt: use the built-ins */ }
    const merged = { ...FACTORY_DEFAULTS, maxHops: this.config.maxHopsDefault, ...saved, agent: { ...(saved.agent ?? {}) } };
    // Only kinds of agent this hub supports (an older hub may have saved one that's since been removed).
    const agents = (Array.isArray(merged.agents) ? merged.agents : []).filter((p) => p in PROVIDER_INFO);
    const agent = Object.fromEntries(Object.entries(merged.agent).filter(([p]) => p in PROVIDER_INFO)) as RoomDefaults["agent"];
    return { ...merged, agents, agent, mode: normalizeMode(merged.mode) };
  }

  /** Validates and saves new defaults; anything not given keeps its current value. */
  setDefaults(input: Partial<RoomDefaults>): RoomDefaults {
    const cur = this.defaults();
    const next: RoomDefaults = { ...cur };
    if (input.mode !== undefined) {
      if (!["review", "direct", "lead", "relay", "roundrobin"].includes(input.mode)) throw new HttpError(400, "Unknown turn-taking mode");
      next.mode = normalizeMode(input.mode);
    }
    if (input.agents !== undefined) {
      if (!Array.isArray(input.agents) || input.agents.some((p) => !PROVIDER_INFO[p as Provider])) throw new HttpError(400, "Unknown agent");
      next.agents = [...new Set(input.agents)] as Provider[];
    }
    if (input.maxHops !== undefined) next.maxHops = clamp(Number(input.maxHops), 0, 50);
    if (input.rounds !== undefined) next.rounds = clamp(Number(input.rounds), 1, 5);
    if (input.parallel !== undefined) next.parallel = !!input.parallel;
    if (input.agent !== undefined) {
      const agent: RoomDefaults["agent"] = {};
      for (const [p, d] of Object.entries(input.agent ?? {})) {
        if (!PROVIDER_INFO[p as Provider] || !d) continue;
        if (!PERMISSION_MODES.some((m) => m.id === d.permissionMode)) throw new HttpError(400, `Unknown permission for ${p}`);
        const account = typeof d.account === "string" && d.account && d.account !== DEFAULT_ACCOUNT ? d.account : null;
        if (account && !this.providers.hasAccount(p as Provider, account)) throw new HttpError(400, `That ${PROVIDER_INFO[p as Provider].name} account doesn't exist`);
        agent[p as Provider] = {
          permissionMode: d.permissionMode,
          model: typeof d.model === "string" && d.model.trim() ? d.model.trim().slice(0, 200) : null,
          effort: typeof d.effort === "string" && d.effort.trim() ? d.effort.trim().slice(0, 40) : null,
          ...(account ? { account } : {}),
          ...(typeof d.helperModel === "string" && /^[\w.:@/[\]-]{1,100}$/.test(d.helperModel) ? { helperModel: d.helperModel } : {}),
        };
      }
      next.agent = agent;
    }
    this.store.kvSet("defaults", JSON.stringify(next));
    return next;
  }

  /** One agent's settings editor must not overwrite a different agent's simultaneous save. */
  setAgentDefaults(provider: string, input: AgentDefaults): RoomDefaults {
    if (!Object.hasOwn(PROVIDER_INFO, provider)) throw new HttpError(400, "Unknown agent");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Agent defaults are required");
    const helper = input.helperModel;
    if (helper !== undefined && helper !== null && helper !== "" && (typeof helper !== "string" || !/^[\w.:@/\[\]-]{1,100}$/.test(helper))) throw new HttpError(400, "bad helper model");
    const clean = { ...input, ...(helper ? { helperModel: helper } : {}) };
    if (!helper) delete clean.helperModel;
    return this.setDefaults({ agent: { ...this.defaults().agent, [provider]: clean } });
  }

  createRoom(input: { name?: string; cwd?: string; mode?: RoomMode; cloneUrl?: string }): Room {
    const name = cutText((input.name ?? "").trim(), 80) || "New room";
    let cwd: string;
    if (input.cwd?.trim()) {
      cwd = expandHome(input.cwd.trim());
      if (!isAbsolute(cwd)) throw new HttpError(400, "Folder must be an absolute path");
    } else {
      const base = slugHandle(name) || "room";
      cwd = join(this.config.workspaceRoot, base);
      for (let i = 2; existsSync(cwd) && !input.cloneUrl; i++) cwd = join(this.config.workspaceRoot, `${base}-${i}`);
    }
    cwd = resolve(cwd);
    if (input.cloneUrl) {
      if (existsSync(cwd)) throw new HttpError(409, `${cwd} already exists`);
    } else if (!existsSync(cwd)) {
      mkdirSync(cwd, { recursive: true });
    }
    const now = Date.now();
    const defaults = this.defaults();
    const room: Room = {
      id: newId("r"),
      name,
      cwd,
      // Round-robin is a group chat's "everyone in turn"; lead and relay work like Off.
      mode: input.mode === "roundrobin" ? "roundrobin" : normalizeMode(input.mode ?? defaults.mode),
      leadMemberId: null,
      maxHops: defaults.maxHops,
      rounds: defaults.rounds,
      parallel: defaults.parallel,
      createdAt: now,
      updatedAt: now,
      archived: false,
      // Every room is a chat now: one made here (by an older app, or the API) is a group chat its agents join.
      chat: { provider: "claude", origin: "web", group: true },
    };
    this.store.insertRoom(room);
    const created = this.store.getRoom(room.id)!;
    this.bus.emit({ t: "room", room: created });
    if (input.cloneUrl) void this.cloneInto(created, input.cloneUrl);
    return created;
  }

  private async cloneInto(room: Room, url: string) {
    this.engine.systemMessage(room.id, `Cloning ${url} into ${room.cwd}…`);
    const p = Bun.spawn(["git", "clone", "--", url, room.cwd], { stdout: "pipe", stderr: "pipe", env: process.env });
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    if (code === 0) this.engine.systemMessage(room.id, `Cloned ${url}.`);
    else {
      mkdirSync(room.cwd, { recursive: true });
      this.engine.systemMessage(room.id, `Clone failed (exit ${code}). ${err.trim().slice(-500)}\nThe chat is using an empty folder instead.`);
    }
  }

  updateRoom(id: string, patch: Partial<Room>): Room {
    const allowed: Partial<Room> = {};
    if (patch.name !== undefined) allowed.name = cutText(String(patch.name).trim(), 80) || "Room";
    if (patch.mode !== undefined) {
      if (!["direct", "relay", "roundrobin", "lead", "review"].includes(patch.mode)) throw new HttpError(400, "bad mode");
      // Older clients may still send lead or relay (they work like Off); round-robin is a group chat's "everyone in turn".
      allowed.mode = patch.mode === "roundrobin" ? "roundrobin" : normalizeMode(patch.mode);
    }
    if (patch.leadMemberId !== undefined) {
      if (patch.leadMemberId !== null && !this.store.listMembers(id).some((m) => m.id === patch.leadMemberId)) throw new HttpError(400, "The lead must be one of this chat's agents");
      allowed.leadMemberId = patch.leadMemberId;
    }
    if (patch.maxHops !== undefined) allowed.maxHops = clamp(Number(patch.maxHops), 0, 50);
    if (patch.rounds !== undefined) allowed.rounds = clamp(Number(patch.rounds), 1, 5);
    if (patch.parallel !== undefined) allowed.parallel = !!patch.parallel;
    if (patch.cwd !== undefined) {
      const cwd = expandHome(String(patch.cwd));
      if (!isAbsolute(cwd)) throw new HttpError(400, "Folder must be an absolute path");
      if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
      allowed.cwd = cwd;
    }
    if (patch.archived !== undefined) allowed.archived = !!patch.archived;
    if (patch.privateFromAgents !== undefined) allowed.privateFromAgents = !!patch.privateFromAgents;
    const room = this.store.updateRoom(id, allowed);
    if (!room) throw new HttpError(404, "That chat isn't here any more.");
    this.bus.emit({ t: "room", room });
    // A new folder, or being kept from other agents (its own agent loses or gets the tools): agents restart for it.
    if (allowed.cwd || patch.privateFromAgents !== undefined) for (const m of this.store.listMembers(id)) void this.engine.memberChanged(m.id);
    return room;
  }

  /**
   * The model server a custom-model account runs on, as an agent's driver needs it: its address and key, and the context
   * window of the model asked for (per model where the server said, else the account's). A server that only speaks Chat
   * Completions is reached through the local translator (adapter/), which gives the agent its own address and key: if the
   * translator can't give one this throws, because handing the agent the real key and address would leak the key and
   * could never work. Used for chats and for one-shot asks, so both go through the same wiring.
   */
  endpointFor(provider: Provider, account: string, model?: string | null): AgentEndpoint | null {
    const ep = this.providers.endpointOf(provider, account);
    if (!ep) return null;
    // The translator decides whether it serves this account (it answers null for any other).
    const via = this.adapter.urlFor(provider, ep.id);
    // Crosstalk's own agent and OpenCode speak Chat Completions themselves (agents/builtin.ts, agents/opencode.ts): they get
    // the service's own address and key, as Codex's translator does.
    if (ep.protocol === "chat" && !via && !isServiceOnlyAgent(provider)) throw new Error(`${ep.label} only speaks an older style that Crosstalk translates for Codex, and the translator isn't available right now. Try again in a moment, or add it again in ${settingsPath("ai-services")}.`);
    const baseUrl = via?.baseUrl ?? ep.baseUrl;
    const key = via?.key ?? ep.key;
    // A model saved with the account has its size there; one of the server's others (under More models), the size the
    // server listed for it. Only one it never said anything of gets the account's.
    const name = model || ep.models[0] || "";
    const contextWindow = ep.contexts?.[name] ?? this.providers.knownModel(provider, account, name)?.contextWindow ?? ep.contextWindow;
    return { id: ep.id, label: ep.label, baseUrl, models: ep.models, contextWindow, key };
  }

  async deleteRoom(id: string) {
    const room = this.store.getRoom(id);
    if (!room) throw new HttpError(404, "That chat isn't here any more.");
    const members = this.store.listMembers(id);
    await this.engine.roomRemoved(id, members.map((m) => m.id));
    // A duplicated chat deleted before it forked: the transcript copied for its fork goes too.
    for (const m of members) dropForkCopies(this, m.id);
    this.asks.roomRemoved(id);
    this.helpers.removed(id);
    this.store.deleteRoom(id);
    this.bus.emit({ t: "room.deleted", roomId: id });
  }

  // -------------------------------------------------------------- members

  addMember(
    roomId: string,
    input: { provider: Provider; handle?: string; model?: string | null; role?: string; permissionMode?: PermissionMode; config?: Record<string, unknown> },
  ): Member {
    const room = this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, "That chat isn't here any more.");
    if (!PROVIDER_INFO[input.provider]) throw new HttpError(400, "unknown agent type");
    const existing = this.store.listMembers(roomId);
    // A chat with one agent stays one (its agent shares its conversation with the agent's own apps): a group chat is the
    // way to have several.
    if (room.chat && !room.chat.group && existing.length) throw new HttpError(409, "This chat has its agent. Start a group chat to have several.", "chat");
    if (room.chat?.group && existing.length >= GROUP_LIMIT) throw new HttpError(409, `A group chat has at most ${GROUP_LIMIT} agents.`, "full");
    // Anything the caller didn't choose comes from Settings → Defaults for this kind of agent.
    const d = this.defaults().agent[input.provider];
    const config = { ...(input.config ?? {}) };
    // The default account for this kind of agent, if it still exists (it may have been removed since).
    if (config.account === undefined && d?.account && this.providers.hasAccount(input.provider, d.account)) config.account = d.account;
    this.checkAccount(input.provider, config);
    if (config.effort === undefined && d?.effort) config.effort = d.effort;
    // The default helper model belongs to the default account's models: only for an agent on that account.
    if (config.helperModel === undefined && d?.helperModel && (config.account ?? DEFAULT_ACCOUNT) === (d.account ?? DEFAULT_ACCOUNT)) config.helperModel = d.helperModel;
    // null or "" means helpers use the agent's own model (and keeps the default from applying).
    if (config.helperModel === null || config.helperModel === "") delete config.helperModel;
    else if (config.helperModel !== undefined && (typeof config.helperModel !== "string" || !/^[\w.:@/[\]-]{1,100}$/.test(config.helperModel))) throw new HttpError(400, "bad helper model");
    // Who does its helper work: what was picked, else the machine's default for new chats.
    const helpers = !(CHAT_PROVIDERS as readonly string[]).includes(input.provider) ? null : config.helpersOn === undefined ? this.defaultHelpers(input.provider, memberAccount({ config })) : this.cleanHelpers(config.helpersOn);
    if (helpers) config.helpersOn = helpers;
    else delete config.helpersOn;
    let handle = slugHandle(input.handle?.trim() || PROVIDER_INFO[input.provider].defaultHandle);
    if (RESERVED_HANDLES.includes(handle)) handle = `${handle}-agent`;
    const base = handle;
    for (let i = 2; existing.some((m) => m.handle === handle); i++) handle = `${base}-${i}`;
    // In a group chat, an agent on another account is named after it unless named here, as when the chat starts.
    if (room.chat?.group) handle = this.chats.groupHandle(input.provider, memberAccount({ config }), input.handle?.trim() || null, new Set(existing.map((m) => m.handle)));
    const m: Member = {
      id: newId("mb"),
      roomId,
      handle,
      provider: input.provider,
      model: input.model === undefined ? (d?.model ?? null) : input.model?.trim() || null,
      role: (input.role ?? "").slice(0, 4000),
      permissionMode: input.permissionMode ?? d?.permissionMode ?? "ask",
      status: "idle",
      statusDetail: null,
      config,
      createdAt: Date.now(),
      position: existing.length,
    };
    this.store.insertMember(m);
    // New members only see messages from now on.
    this.store.setLastSeen(m.id, 0, 0);
    this.bus.emit({ t: "member", member: m });
    if (!room.leadMemberId && (room.mode === "lead" || room.chat?.group)) this.updateRoom(roomId, { leadMemberId: m.id });
    this.engine.systemMessage(roomId, `@${m.handle} (${PROVIDER_INFO[m.provider].name}) joined the ${room.chat?.group ? "chat" : "room"}.`);
    return m;
  }

  /**
   * Edits or unsends one of your messages in a chat (Engine.reviseMessage): when the agent had read it, the chat goes
   * back to just before it. The replies that leave the chat take their steps and errors with them.
   */
  async reviseMessage(messageId: string, text: string | null, by: string): Promise<{ removed: string[]; sent: Message | null }> {
    const roomId = this.store.getMessage(messageId)?.roomId;
    const r = await this.engine.reviseMessage(messageId, text, by);
    if (roomId) {
      // Questions the agent asked without waiting in the replies that left go with them.
      this.engine.closeRewoundQuestions(roomId);
      const turns = this.store.deleteTurnsWithoutReplies(roomId);
      if (turns.length) this.bus.emit({ t: "turns.removed", roomId, ids: turns });
    }
    return r;
  }

  /**
   * Takes a chat back to just after one of the agent's replies: the next message you (or another chat) sent, and
   * everything after it, leave the chat, and the agent forgets them. Files it changed stay changed.
   */
  async rewindTo(messageId: string, by: string): Promise<{ removed: string[] }> {
    const m = this.store.getMessage(messageId);
    if (!m) throw new HttpError(404, "No such message");
    const room = this.store.getRoom(m.roomId);
    if (!room?.chat) throw new HttpError(400, "This chat is from an older Crosstalk and can't be rewound");
    if (m.authorKind === "human") throw new HttpError(400, "To go back to before one of your messages, unsend it");
    const seq = this.store.messageSeq(m.id);
    const next = this.store.messagesAfter(room.id, seq).find((x) => x.authorKind === "human");
    if (!next) throw new HttpError(400, "Nothing after this reply to take back");
    let { removed } = await this.reviseMessage(next.id, null, by);
    // A message the agent never got is taken back on its own (with its failed replies): the ones after it, which it
    // never got either, go too, so everything after this reply leaves the chat as the two confirmations said.
    for (let later = this.store.messagesAfter(room.id, seq).find((x) => x.authorKind === "human"); later; later = this.store.messagesAfter(room.id, seq).find((x) => x.authorKind === "human")) {
      const more = (await this.reviseMessage(later.id, null, by)).removed;
      if (!more.length) break;
      removed = [...removed, ...more];
    }
    return { removed };
  }

  /**
   * An agent asks for its helper agents on another model because the user asked in the chat (use_helper_model): done
   * at once when the user's own messages name that model, otherwise only after the user says yes. It applies from the
   * agent's next reply, which starts by itself once the current one ends.
   */
  async useHelperModel(memberId: string, said: string): Promise<string> {
    const member = this.store.getMember(memberId);
    if (!member) throw new HttpError(404, "agent not found");
    if (member.provider !== "claude" && member.provider !== "codex") return `${PROVIDER_INFO[member.provider]?.name ?? "This agent"} doesn't start helper agents Crosstalk can set a model for.`;
    const agentName = PROVIDER_INFO[member.provider].name;
    const helperKinds = member.provider === "claude" ? "subagents and workflow agents" : "agents it spawns";
    const want = said.trim();
    if (!want) return "Say which model, for example 'Sonnet' or 'Haiku', or 'same' for this chat's model.";
    const initialTurn = this.engine.runningTurns(member.roomId).find((t) => t.memberId === member.id)?.id;
    const initialConfig = JSON.stringify(member.config);
    const initialModel = member.model;
    const stillCurrent = () => {
      const latest = this.store.getMember(memberId);
      return latest && latest.model === initialModel && JSON.stringify(latest.config) === initialConfig && initialTurn && this.engine.runningTurns(member.roomId).some((t) => t.id === initialTurn) ? latest : null;
    };
    const catalog = await this.providers.models(member.provider, memberAccount(member)).catch(() => null);
    if (!stillCurrent()) return "The chat settings changed or this reply ended. Ask again with the current settings.";
    const models = catalog?.models ?? [];
    const pinned = member.resolvedModel ?? member.model;
    const chat = pinned ? models.find((m) => m.id === pinned || m.resolvedModel === pinned) : models.find((m) => m.isDefault);
    const chatName = chat?.label ?? (member.model ? modelName(member.model) : "this chat's model");
    const reset = /^(same|reset|default|inherit|chat|the chat'?s( model)?|this chat'?s( model)?)$/i.test(want);
    const pick = reset ? null : pickModel(models, want);
    if (!reset && !pick) return `${agentName} here has no model called "${want}". It offers: ${models.map((m) => m.label).join(", ") || "(its list couldn't be read)"}.`;
    // The chat's own model isn't a separate pick for helpers.
    const target = pick && chat && pick.id === chat.id ? null : pick;
    const current = typeof member.config.helperModel === "string" ? member.config.helperModel : null;
    if ((target?.resolvedModel ?? target?.id ?? null) === current || (target?.id !== undefined && target.id === current)) return target ? `Helper agents already run on ${target.label}.` : `Helper agents already run on ${chatName}, this chat's model.`;
    const words = this.engine.humanWordsFor(member.id);
    const authorized = target ? userNamed(words, target, chat) : false;
    if (!authorized) {
      const d = await this.engine.approvalFromAgent(member.id, {
        kind: "permission",
        title: `Run helper agents on ${target?.label ?? chatName}?`,
        detail: `${agentName} wants the helper agents it starts in this chat (${helperKinds}) to use ${target?.label ?? chatName}. They'd work at this chat's effort.`,
      });
      if (d === "deny") return `The user said no: helper agents stay on ${current ? models.find((m) => m.id === current || m.resolvedModel === current)?.label ?? modelName(current) : chatName}.`;
    }
    const latest = stillCurrent();
    if (!latest) return "The chat settings changed or this reply ended while waiting. No model was changed.";
    const tasks = this.engine.tasksIn(member.roomId)[member.id] ?? [];
    if (tasks.some((task) => task.status === "running")) return "Helpers are still running. Wait for them to finish, then ask for this model change again.";
    const config = { ...latest.config };
    if (target) config.helperModel = target.resolvedModel ?? target.id;
    else delete config.helperModel;
    this.updateMember(member.id, { config });
    const now = target ? target.label : `${chatName}, this chat's model`;
    const continues = this.engine.continueAfterTurn(member.id, `Helper agents now run on ${now}, as the user asked. Carry on with the task from where your last reply left off.`);
    return continues
      ? `Done: helper agents run on ${now} from your next reply. ${agentName} picks this up when this reply ends, so end it now with one line saying so, without starting helpers. Crosstalk then starts your next reply by itself.`
      : `Done: helper agents run on ${now} from the next reply.`;
  }

  /** `by`: the device it was changed on (named in the chat when the model changes). */
  updateMember(id: string, patch: Partial<Member>, by?: string | null): Member {
    const cur = this.store.getMember(id);
    if (!cur) throw new HttpError(404, "agent not found");
    const allowed: Partial<Member> = {};
    if (patch.handle !== undefined) {
      const h = slugHandle(String(patch.handle));
      // @all / @everyone address the whole room: an agent named that would be "mentioned" by every broadcast.
      if (RESERVED_HANDLES.includes(h)) throw new HttpError(400, `@${h} is reserved: choose another name`);
      if (this.store.listMembers(cur.roomId).some((m) => m.handle === h && m.id !== id)) throw new HttpError(409, `@${h} is taken`);
      allowed.handle = h;
    }
    if (patch.model !== undefined) allowed.model = patch.model ? String(patch.model).trim() : null;
    if (patch.role !== undefined) allowed.role = String(patch.role).slice(0, 4000);
    if (patch.permissionMode !== undefined) {
      if (!["ask", "edits", "auto", "full"].includes(patch.permissionMode)) throw new HttpError(400, "bad permission mode");
      allowed.permissionMode = patch.permissionMode;
    }
    if (patch.config !== undefined && typeof patch.config === "object") {
      allowed.config = { ...(patch.config as Record<string, unknown>) };
      this.checkAccount(cur.provider, allowed.config);
      // The model for helper agents goes into Claude Code's environment: a model name, nothing else.
      const helper = allowed.config.helperModel;
      if (helper !== undefined && helper !== null && helper !== "" && (typeof helper !== "string" || !/^[\w.:@/\[\]-]{1,100}$/.test(helper))) throw new HttpError(400, "bad helper model");
      if (!helper) delete allowed.config.helperModel;
      // Who does its helper work ("Helpers run on"): another account of this machine's, or nothing for its own helpers.
      // What the chat already has is kept as it is (its account may have been removed since: the helper tool says so).
      const same = JSON.stringify(allowed.config.helpersOn ?? null) === JSON.stringify(cur.config?.helpersOn ?? null);
      const on = same ? (cur.config?.helpersOn as HelpersOn | undefined) ?? null : this.cleanHelpers(allowed.config.helpersOn);
      if (on) allowed.config.helpersOn = on;
      else delete allowed.config.helpersOn;
      // Long context is on or off, and only Codex gives a chat more than its model's usual window.
      if (allowed.config.longContext !== true || cur.provider !== "codex") delete allowed.config.longContext;
    }
    if (patch.position !== undefined) allowed.position = Number(patch.position) || 0;
    // A conversation lives in the account it was started under; a different account starts a fresh one.
    const switchedAccount = allowed.config !== undefined && memberAccount({ config: allowed.config }) !== memberAccount(cur);
    const endpoint = switchedAccount ? this.providers.endpointOf(cur.provider, memberAccount({ config: allowed.config! })) : null;
    const resetHelper = !!(endpoint && allowed.config?.helperModel && !endpoint.models.includes(String(allowed.config.helperModel)));
    if (resetHelper) delete allowed.config!.helperModel;
    // A duplicated chat that hadn't forked the original's session yet starts fresh instead: nothing is left to fork.
    if (switchedAccount) delete allowed.config!.forkNext;
    const m = this.store.updateMember(id, allowed);
    // Stricter permissions take back what was always allowed under the looser ones ("Always allow"). A process that's
    // running keeps what it was allowed until it's replaced: that waits as a permission change, whatever comes after.
    const tightened = !!m && allowed.permissionMode !== undefined && PERMISSION_RANK[allowed.permissionMode] < PERMISSION_RANK[cur.permissionMode] && !switchedAccount;
    if (tightened) this.clearAlwaysAllowed(id);
    /** What the chat says once a model change that had to wait applies (Engine.memberChanged). */
    let applied: string | undefined;
    // A model picked in the menu (or "Default" picked again) replaces the one "Default" was kept to.
    if (m && allowed.model !== undefined) {
      this.engine.invalidateModel(id);
      const { model: pinned, ...session } = this.store.getMemberSession(id);
      if (pinned !== undefined) this.store.setMemberSession(id, session);
      // Never silently: a chat with a conversation says its model changed, from what to what and where. (A change made
      // while helpers run can take effect much later, and otherwise nothing would say so.)
      if (!switchedAccount && (allowed.model ?? null) !== (cur.model || null) && this.store.maxSeq(m.roomId) > 0) {
        const room = this.store.getRoom(m.roomId);
        const one = !!room?.chat && !room.chat.group;
        const who = one ? "Model" : `@${m.handle}'s model`;
        const where = by?.trim() ? ` on ${by.trim().slice(0, 60)}` : "";
        const to = this.modelWords(cur, allowed.model ?? null);
        const said = `${who} changed from ${this.modelWords(cur, cur.model)} to ${to}${where}.`;
        // When it really applies: a reply that's running, and the agent's helpers, keep the process it started with until
        // they're done, and replies meanwhile (its own, as helpers report back) answer on its old model. A second line
        // says when it applies (a long workflow can hold the old model for hours).
        const later = this.engine.whenApplies(id);
        if (!later) this.engine.systemMessage(m.roomId, `${said} ${one ? "The" : "Its"} next reply uses it.`);
        else {
          const agent = one ? (PROVIDER_INFO[m.provider]?.name ?? `@${m.handle}`) : `@${m.handle}`;
          const reply = one ? "this reply" : "its reply";
          const until = later.reply && later.helpers ? `${reply} and its helpers finish` : later.helpers ? "its helpers finish" : `${reply} finishes`;
          // The model its process runs: the one it was started with by name, or what "Default" or an alias came up as.
          const was = later.model && !isModelAlias(later.model) ? later.model : (typeof pinned === "string" && pinned) || later.model;
          this.engine.systemMessage(m.roomId, `${said} ${was ? `${agent} answers on ${this.modelWords(cur, was)} until ${until}.` : `${agent} keeps the model it started on until ${until}.`}`);
          applied = one ? `Now on ${to}: the next reply uses it.` : `@${m.handle} is on ${to} now: its next reply uses it.`;
          // That said when it applies: a message that goes on meanwhile has nothing to add (Engine.noteAround).
          if (later.helpers) this.engine.heldSaid(id);
        }
      }
    }
    if (m && switchedAccount) {
      this.engine.invalidateSession(id);
      this.xchat.resetMember(id);
      // Same as "Start a fresh session": no old conversation, briefed again, sees the chat from now on.
      dropForkCopies(this, id);
      this.store.setMemberSession(id, {});
      forgetConversation(id);
      this.store.setLastSeen(id, this.store.maxSeq(m.roomId), 0);
      const acct = this.providers.accounts().find((a) => a.provider === m.provider && a.id === memberAccount(m));
      this.engine.systemMessage(m.roomId, `@${m.handle} now uses the ${acct?.label ?? "selected"} account${acct?.account ? ` (${acct.account})` : ""} and will start a fresh session.${resetHelper ? " Helper agents now use this chat’s model because the previous helper model is unavailable on this server." : ""}`);
    }
    if (!m) throw new HttpError(404, "agent not found");
    const updated = this.store.getMember(id)!;
    this.bus.emit({ t: "member", member: updated });
    // What changed is the member's own settings: the engine compares them with what its process was started with (and
    // what it was always allowed is gone).
    void this.engine.memberChanged(id, tightened ? "permissions" : null, applied);
    return updated;
  }

  /** A chat's model as people say it: "Opus 5.5", the agent's own name for it, or "Default". */
  private modelWords(member: Member, model: string | null): string {
    if (!model) return "Default";
    const said = modelName(model);
    if (said !== model) return said;
    return this.providers.knownModel(member.provider, memberAccount(member), model)?.label ?? model;
  }

  /**
   * What the user chose to always allow in a chat ("Always allow" on an approval card), in words, for its settings:
   * Claude Code's permission rules, Codex's exact commands and files, what OpenCode and Crosstalk's agent keep.
   */
  alwaysAllowed(memberId: string): AlwaysAllowed[] {
    if (!this.store.getMember(memberId)) throw new HttpError(404, "agent not found");
    const s = this.store.getMemberSession(memberId);
    const list = (k: string) => (Array.isArray(s[k]) ? (s[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
    const service = (key: "opencodeAllowed" | "builtinAllowed") => {
      const a = (s[key] && typeof s[key] === "object" ? s[key] : {}) as ServiceAllowed;
      return [
        // OpenCode's covers only the chat's own folder; Crosstalk's agent's covers any file.
        ...(a.files ? [{ id: `${key}:files:`, label: key === "opencodeAllowed" ? "File changes in this chat's folder" : "File changes" }] : []),
        ...(a.commands ?? []).map((c) => ({ id: `${key}:commands:${c}`, label: ruleLabel(ruleText({ toolName: "Bash", ruleContent: c })) })),
        ...(a.hosts ?? []).map((h) => ({ id: `${key}:hosts:${h}`, label: `Fetching from ${h}` })),
        ...(a.tools ?? []).map((t) => ({ id: `${key}:tools:${t}`, label: t === "browseros_*" ? "BrowserOS neo" : t })),
      ];
    };
    return [
      ...service("opencodeAllowed"),
      ...service("builtinAllowed"),
      ...list("allowRules").map((r) => ({ id: `rule:${r}`, label: ruleLabel(r) })),
      // Commands kept before they were kept with their folder aren't allowed any more (they're asked about again).
      ...list("allowCommands").filter((c) => c.startsWith("[")).map((c) => ({ id: `command:${c}`, label: codexAllowedLabel("allowCommands", c) })),
      ...list("allowFiles").map((f) => ({ id: `file:${f}`, label: codexAllowedLabel("allowFiles", f) })),
    ];
  }

  /**
   * Takes back one thing that was always allowed: the agent asks about it again. Codex, OpenCode and Crosstalk's agent
   * answer from the saved list at once; Claude Code keeps its rules for the process, so it starts again once its current
   * reply ends.
   */
  async removeAlwaysAllowed(memberId: string, id: unknown): Promise<AlwaysAllowed[]> {
    if (!this.store.getMember(memberId)) throw new HttpError(404, "agent not found");
    const key = typeof id === "string" ? id : "";
    const service = /^(opencodeAllowed|builtinAllowed):(files|commands|hosts|tools):(.*)$/s.exec(key);
    if (service) {
      const [, field, part, item] = service;
      const s = this.store.getMemberSession(memberId);
      const a = { ...((s[field] && typeof s[field] === "object" ? s[field] : {}) as ServiceAllowed) };
      if (part === "files") delete a.files;
      else if (part === "commands" || part === "hosts" || part === "tools") a[part] = (a[part] ?? []).filter((x) => x !== item);
      this.store.setMemberSession(memberId, { ...s, [field]: a });
      return this.alwaysAllowed(memberId);
    }
    const kind = key.startsWith("rule:") ? "allowRules" : key.startsWith("command:") ? "allowCommands" : key.startsWith("file:") ? "allowFiles" : null;
    if (!kind) throw new HttpError(400, "Say what to take back");
    const item = key.slice(key.indexOf(":") + 1);
    const s = this.store.getMemberSession(memberId);
    const list = Array.isArray(s[kind]) ? (s[kind] as unknown[]) : [];
    if (list.includes(item)) {
      this.store.setMemberSession(memberId, { ...s, [kind]: list.filter((x) => x !== item) });
      if (kind === "allowRules") await this.engine.memberChanged(memberId, "permissions");
    }
    return this.alwaysAllowed(memberId);
  }

  /** Forgets everything a chat's agent was always allowed (its next process gets none of it). */
  private clearAlwaysAllowed(memberId: string) {
    const { allowRules: _r, allowCommands: _c, allowFiles: _f, opencodeAllowed: _o, builtinAllowed: _b, ...rest } = this.store.getMemberSession(memberId);
    this.store.setMemberSession(memberId, rest);
  }

  /** A member's account must exist for its kind of agent; "default" (or none) is the agent's own sign-in. */
  private checkAccount(provider: Provider, config: Record<string, unknown>) {
    const account = config.account;
    if (account === undefined || account === null || account === "" || account === DEFAULT_ACCOUNT) {
      delete config.account;
      return;
    }
    if (typeof account !== "string" || !this.providers.hasAccount(provider, account)) throw new HttpError(400, "That account doesn't exist for this agent");
  }

  async removeMember(id: string) {
    const m = this.store.getMember(id);
    if (!m) throw new HttpError(404, "agent not found");
    await this.engine.memberRemoved(m);
    this.helpers.removed(m.roomId, m.id);
    this.store.deleteMember(id);
    const room = this.store.getRoom(m.roomId);
    // A group chat's lead that leaves: the first of the others leads (and shows the chat to older apps).
    if (room?.leadMemberId === id) this.updateRoom(room.id, { leadMemberId: room.chat?.group ? this.store.listMembers(room.id)[0]?.id ?? null : null });
    this.bus.emit({ t: "member.deleted", memberId: id, roomId: m.roomId });
    this.engine.systemMessage(m.roomId, `@${m.handle} left the ${room?.chat?.group ? "chat" : "room"}.`);
  }

  async shutdown() {
    // Nothing looks at the devices after this: the database is about to close.
    for (const t of this.quietTimers.splice(0)) clearTimeout(t);
    log.info("shutting down");
    // First, so a shutdown that macOS cuts short (it's restarting) still counts as stopping on purpose (see mac.ts).
    this.mac.stop();
    this.screen.shutdown();
    this.updater.stop();
    this.selfUpdate.stop();
    this.push.stopRetries();
    this.busy?.stop();
    this.storage.stop();
    this.memory.stop();
    this.machines.stop();
    // One-shot asks and the translator first: their agent processes and sockets never outlive the hub.
    await this.asks.shutdown();
    await this.helpers.shutdown();
    await this.adapter.shutdown();
    // Sign-ins started from the phone: their processes never outlive the hub.
    await this.signIns.shutdown();
    await this.engine.shutdown();
    // A usage-limit note still settling would go out after the database has closed.
    for (const note of this.limitNotes.values()) clearTimeout(note.timer);
    this.limitNotes.clear();
    // The image editor and the model servers Local models started keep running: they aren't the hub's to end.
    this.imageEditor.shutdown();
    await shutdownLocalModels(this);
    this.pty.killAll();
    // The last `spend` event goes out while the ledger can still be read: its timer never outlives the database.
    this.spend.stop();
    this.store.close();
    if (scratch.delete(this.computers.dir)) rmSync(this.computers.dir, { recursive: true, force: true });
  }
}

/** A command's exit code and output (null when it couldn't run), ended if it takes longer than `timeoutMs`. */
async function runQuietly(args: string[], timeoutMs = 5000): Promise<{ code: number; out: string } | null> {
  try {
    const p = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out };
  } catch {
    return null;
  }
}

/** Whether a file opens for reading: never a dialog (a file only Full Disk Access reads is just refused). */
function canRead(path: string): boolean {
  try {
    closeSync(openSync(path, "r"));
    return true;
  } catch {
    return false;
  }
}

/** tccd's requests and answers in macOS's log (see mac.ts). */
// Only macOS's own tccd (from the sealed system volume): any program can log lines under tccd's subsystem name.
const PRIVACY_PREDICATE = 'process == "tccd" AND processImagePath BEGINSWITH "/System/" AND subsystem == "com.apple.TCC" AND (eventMessage BEGINSWITH "AUTHREQ_PROMPTING" OR eventMessage BEGINSWITH "AUTHREQ_RESULT")';

/** macOS's privacy daemon's requests and answers (see mac.ts), as they're logged. */
function streamPrivacyLog(onLine: (line: string) => void, onExit: () => void): { stop(): void } | null {
  try {
    const p = Bun.spawn(["/usr/bin/log", "stream", "--style", "ndjson", "--predicate", PRIVACY_PREDICATE], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    })().catch(() => {});
    void p.exited.then(onExit, onExit);
    return { stop: () => p.kill() };
  } catch {
    return null;
  }
}

/** The same lines logged since `start` (local time, "2026-05-14 02:40:10"): what the hub missed while it was off. */
async function privacyLogSince(start: string): Promise<string[] | null> {
  // A day of it reads in about a second.
  const r = await runQuietly(["/usr/bin/log", "show", "--start", start, "--style", "ndjson", "--predicate", PRIVACY_PREDICATE], 60_000);
  return r?.code === 0 ? r.out.split("\n") : null;
}

/** A file's text, or null when it can't be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A folder's files with when each last changed (none when it can't be read). */
function filesIn(dir: string): { name: string; mtime: number }[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      try {
        return [{ name, mtime: statSync(join(dir, name)).mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** Writes a small file whole and on disk before it replaces the old one: it has to outlive a crash or a power cut. */
function keepFile(path: string, text: string) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Where the image editor's server writes, beside the hub's own log on a Mac. */
function imageEditorLog(): string {
  const macLogs = join(homedir(), "Library", "Logs", "Crosstalk");
  const dir = osPlatform() === "darwin" ? macLogs : join(HOME, "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "image-editor.log");
}

/**
 * Folders an in-memory hub (tests, previews) uses for itself, in the temp folder under one per process: removed when it
 * shuts down, and those of processes that have ended at the next start (a test runner exits without exit hooks), so
 * test runs don't leave thousands behind.
 */
const scratch = new Set<string>();
let scratchRoot: string | null = null;
function scratchDir(prefix: string): string {
  if (!scratchRoot) {
    // One per user: on Linux the temp folder is shared.
    const root = join(tmpdir(), `crosstalk-scratch-${process.getuid?.() ?? "user"}`);
    mkdirSync(root, { recursive: true });
    for (const name of readdirSync(root)) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue;
      try {
        rmSync(join(root, name), { recursive: true, force: true });
      } catch {
        // left for the next run
      }
    }
    scratchRoot = join(root, String(process.pid));
    process.once("exit", () => {
      try {
        rmSync(scratchRoot!, { recursive: true, force: true });
      } catch {
        // nothing more to do as the process ends
      }
    });
  }
  // Not made yet: whatever uses it makes it when it first writes there.
  const dir = join(scratchRoot, `${prefix}${crypto.randomUUID().slice(0, 12)}`);
  scratch.add(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** argv prefix that re-runs this program (compiled binary or `bun src/main.ts`). */
export function selfCommand(): string[] {
  const main = Bun.main;
  if (main.startsWith("/$bunfs/") || main.startsWith("B:\\~BUN\\")) return [process.execPath];
  return [process.execPath, main];
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);
}

/** A secret kept in a file only this user can read, made on first use. */
function persistedSecret(path: string): string {
  try {
    const s = readFileSync(path, "utf8").trim();
    if (s.length >= 32) return s;
  } catch {
    /* first start */
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const s = secretToken() + secretToken();
  writeFileSync(path, s, { mode: 0o600 });
  return s;
}

let cachedComputerName: string | null = null;
/** The computer's own name ("Mac mini", "linux-box"): macOS's Computer Name, or the host name elsewhere. */
function computerName(): string {
  if (cachedComputerName) return cachedComputerName;
  let name = "";
  if (osPlatform() === "darwin") {
    try {
      const r = Bun.spawnSync(["scutil", "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore" });
      name = r.stdout.toString().trim();
    } catch {
      /* fall back to the host name */
    }
  }
  cachedComputerName = (name || hostname().replace(/\.local$/, "").split(".")[0] || "This machine").slice(0, 40);
  return cachedComputerName;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : lo;
}

/** Who a notification is about: a chat's agent by name ("Codex"), an agent in a room by its handle ("@codex"). */
function agentWords(room: Room | null, member: Member | null): string {
  // A chat is one agent: its name. In a group chat, which of them: its handle.
  if (room?.chat && !room.chat.group) return PROVIDER_INFO[room.chat.provider].name;
  return member ? `@${member.handle}` : "An agent";
}

/** "Codex needs your OK: npm test", or "Codex finished." when there's nothing more to say. */
function said(lead: string, text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? `${lead}: ${t}` : `${lead}.`;
}

export { RUN_DIR };
