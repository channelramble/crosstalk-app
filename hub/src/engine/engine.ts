import {
  CHAT_PROVIDERS,
  PERMISSION_MODES,
  codexAnswerTo,
  codexQuestionReply,
  parseCodexQuestionReply,
  parseMentions,
  PROVIDER_INFO,
  turnOrder,
  type Activity,
  type ActivityKind,
  type Approval,
  type ApprovalDecision,
  type AgentQuestion,
  type BackgroundTask,
  type HeldChange,
  type HeldSettings,
  type Member,
  type Message,
  type MessageVia,
  type ModelOption,
  type Room,
  type LimitWait,
  type SendNowResult,
  type Turn,
  type TurnOrigin,
  type TurnUsage,
  type UsageSnapshot,
  type UsageWindow,
  limitCarriedOnWords,
  limitDontWaitWords,
  limitGaveUpWords,
  limitWaitWords,
  heldWords,
  helperAtWork,
  memberAccount,
  staleSignInWords,
} from "@crosstalk/shared";
import type { Store } from "../db";
import type { Bus } from "../bus";
import { COMPACT_COMMAND, type ActivityInput, type AgentDriver, type DriverContext, type McpLaunch, type TurnInput, type TurnResult, type TurnSink } from "../agents/driver";
import type { LimitHit } from "../agents/limits";
import type { AuthHit } from "../agents/stale-login";
import { isModelAlias } from "../agents/model-lock";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../util/ids";
import { processesEnding } from "../util/process";
import { logger } from "../util/log";
import { buildChatPrompt, buildGroupSteer, buildSystemNote, buildTurnPrompt, reviewPair, rosterHash } from "./prompt";

/** A turn note with this prefix is the whole "why it's your turn" line, not a parenthetical. */
const REASON = "reason:";

const log = logger("engine");

/**
 * What a finished reply reports for the spend ledger: its usage, plus the driver's raw cost figure and whether it had a
 * baseline to difference from (Claude Code reports a running total per process; the first reply of a process has none).
 */
export interface LedgerUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  costTotalUsd?: number | null;
  costFromBaseline?: boolean;
}

export interface EngineDeps {
  store: Store;
  bus: Bus;
  createDriver: (ctx: DriverContext) => AgentDriver;
  mcpLaunch: (member: Member) => McpLaunch;
  /** Environment for a member's agent process (points it at the member's account). */
  agentEnv?: (member: Member) => Record<string, string>;
  resolveBin?: (provider: Member["provider"]) => string | null;
  /** Pause hand-offs to an agent whose plan is above this share of a limit (0-100); null or absent: never pause. */
  pauseNearLimitPercent?: () => number | null;
  /** Extra lines for every agent's room briefing (e.g. connected computers). */
  briefing?: (room: Room, member: Member) => string | null;
  /** A turn with no sign of life for this long (and no approval pending) is treated as frozen. Default 15 minutes. */
  stallMs?: number;
  /** An agent's process with nothing to do for this long is ended to free its memory (see endIdle). Default 20 minutes. */
  idleEndMs?: number;
  /** What a one-agent chat's driver needs to know (teamwork helper, continuing from a copy). */
  chatContext?: (room: Room, member: Member) => DriverContext["chat"];
  /** Called after each turn in a room has finished (successfully or not). */
  afterTurn?: (room: Room, member: Member) => void;
  /** A finished reply's final text, before it's saved (the app makes images the agent linked show in the chat). */
  finishReply?: (room: Room, text: string) => string;
  /** A line for every agent's next prompt while it applies (e.g. the disk is nearly full). */
  turnNotice?: () => string | null;
  /** The model server of your own a member's account runs on, if it's a custom-model account. */
  endpointFor?: (member: Member) => DriverContext["endpoint"];
  /** Whether a member's agent gets the tools for the user's other chats. */
  crossChat?: (room: Room, member: Member) => boolean;
  /**
   * Whether a chat's folder is there before its agent starts (a missing working folder makes every agent CLI fail with
   * a misleading "no such file" about the CLI itself). Returns what to tell the person when it isn't and can't be
   * made again; null when it's fine.
   */
  checkFolder?: (room: Room) => string | null;
  /**
   * A plain sentence when a new reply on this agent's account shouldn't start (its spending limit is used up), else
   * null. Refuses the same way a missing folder does: an error reply, the message handed back, Try again.
   */
  checkBudget?: (room: Room, member: Member) => string | null;
  /**
   * A plain sentence when the model server this chat runs on can't answer now (the model pool is stopped or still
   * starting), else null. Refuses the way a missing folder does: an error reply, the message handed back, Try again.
   */
  checkEndpoint?: (room: Room, member: Member) => string | null;
  /**
   * Plain words for a reply that failed because its model server went away mid-reply (the model pool stopped), in place
   * of the agent's own "connection refused". Null leaves the agent's words alone.
   */
  replyFailed?: (member: Member) => string | null;
  /** A finished reply's usage, for the spend ledger (spend.ts). Called after the turn is saved; a throw never reaches the turn. */
  recordUsage?: (room: Room, member: Member, turn: Turn, usage: LedgerUsage) => void;
  /** A turn is about to run (chats note where a shared session's transcript ends, see Chats.turnStarting). */
  turnStarting?: (room: Room, member: Member) => void;
  /** A model's entry in the list of the member's agent and account (see DriverContext.modelInfo / knownModel). */
  modelInfo?: (member: Member, model: string | null) => Promise<ModelOption | null>;
  knownModel?: (member: Member, model: string) => ModelOption | null;
  /** Clear session-scoped permissions when a member is removed or reset. */
  resetMember?: (memberId: string) => void;
  /** A member's session is over (a fresh one starts, or it left), once its process has gone: what its agent keeps outside the session goes too. */
  sessionOver?: (memberId: string) => void;
  /**
   * Whether a reply a usage limit stopped waits for that limit to reset and then carries on ("Carry on when the limit
   * resets"; absent: on).
   */
  carryOnAfterLimit?: () => boolean;
  /**
   * "Keep going while helpers work" (absent: on): while an agent's helpers work, your messages go straight to it, around new
   * settings that wait for those helpers (flowIn, heldForSettings). Off: such a message waits for the helpers, and only a
   * tap sends it sooner (the older behaviour).
   */
  messagesFlow?: () => boolean;
  /** What to call a member's account in those words ("Work"); null for the agent's own sign-in. */
  accountLabel?: (member: Member) => string | null;
  /**
   * A chat started waiting for a usage limit, has carried on, or gave up: one notification per account, grouped
   * (app.ts). The wait itself reaches devices as the turn's own event.
   */
  onLimitWait?: (e: { kind: "waiting" | "carried" | "gave-up"; room: Room; member: Member; wait: LimitWait }) => void;
  /** The clock. Injectable so tests of waits and backoff don't wait for real time. */
  now?: () => number;
  /** A reply whose agent's sign-in stopped working (see staleSignIn); absent: such a reply just fails, as before. */
  signIn?: SignInHooks;
}

/**
 * What the engine needs when a reply fails because the agent's sign-in stopped working (stale-login.ts): the app's sign-in
 * state (signin.ts) and the agent's own sign-in check (the one the setup checklist shows).
 */
export interface SignInHooks {
  /** Whether it applies to this member: a plan sign-in, not an API key or a model server of your own. */
  covers(member: Member): boolean;
  /** The agent in words ("Claude Code", "Claude Code (Work)") and this machine's name, for the chat. */
  names(member: Member): { agent: string; machine: string };
  /** The member's account is known to be signed out (a SignInNeed stands for it). */
  isNeeded(member: Member): boolean;
  /** The agent's own sign-in check, asked again now: true signed in, false signed out, null couldn't tell. */
  check(member: Member): Promise<boolean | null>;
  /** It's signed out: every chat and device hears so (the bus, the snapshot). Returns the words for the reply. */
  needed(room: Room, member: Member): string;
  /** The words for a reply whose sign-in failed again in a fresh process while the check didn't say signed out. */
  stillFailing(room: Room, member: Member, hit: AuthHit, signedIn: boolean | null): string;
  /** A reply on the member's account went through: a sign-out recorded for that account is over. */
  worked(room: Room, member: Member): void;
}

const STALL_MS = 15 * 60_000;
/** How often waiting replies are looked at: a reset that has come round starts them, a few per account each time. */
const WAIT_TICK_MS = 20_000;
/** A moment's grace after a known reset: the vendors' windows don't open to the second. */
const RESET_MARGIN_MS = 60_000;
/** With no reset time anywhere, how long each try waits (5 min, then 15, 30, 60, 120). */
const BACKOFF_MS = [5, 15, 30, 60, 120].map((m) => m * 60_000);
/** How many times one reply is picked back up before Crosstalk stops and leaves Try again. */
const MAX_LIMIT_TRIES = 5;
/** The whole wait, from the first try: about a day, the horizon Claude Code's own "continue at usage limit" uses. */
const MAX_WAIT_MS = 24 * 3600_000;
/** How many of one account's waiting chats start per round, so one reset never starts a dozen replies at once. */
const WAKE_AT_ONCE = 2;
/** How long a message "Send now" handed to a reply as it ended waits for the agent's next turn to read it. */
const HANDED_OVER_MS = 60_000;
/** How soon a reply that can't take a message yet (it's still starting) is asked again, while its helpers work (flowIn). */
const FLOW_RETRY_MS = 500;
/**
 * New settings can wait a long time for an agent's helpers (a dev server left running, a new helper with every reply): the
 * chat says so again on a reply after this long (noteAround), or sooner once a newer helper has put the moment off again.
 */
const AROUND_AGAIN_MS = 60 * 60_000;
const AROUND_AGAIN_NEWER_MS = 10 * 60_000;
const IDLE_END_MS = 20 * 60_000;
/** What a step adds to its output goes out in batches this far apart: one event and one write instead of one per piece. */
const STEP_FLUSH_MS = 200;
/** A streaming reply's text goes to clients in batches this far apart (one event, not one per piece the agent sends). */
const TEXT_FLUSH_MS = 100;
/** A step's detail is kept to this size: past it, the oldest output goes, down to STEP_DETAIL_KEEP. */
const STEP_DETAIL_MAX = 64_000;
const STEP_DETAIL_KEEP = 48_000;
/** Finished steps' details longer than this reach newer clients as their start only (see previewActivity). */
const DETAIL_PREVIEW_OVER = 2_000;
const DETAIL_PREVIEW = 1_200;

/** When two reasons for one agent's turn are merged, the more important one leads. */
const ORIGIN_RANK: Record<TurnOrigin, number> = { mention: 0, human: 1, loop: 2 };
/**
 * A queued turn, plus (in memory) its reason line and the other requests merged into it (see enqueue). `had`: it
 * delivers again messages the agent took in already, up to this seq (Try again, the stall watchdog's retry, a restart):
 * they're in the agent's conversation from that earlier turn, so a rewind to one of them still goes back to before it
 * (the drivers keep each message's first rewind point), and the agent forgets the failed try as well.
 */
type QueuedTurn = Turn & { note?: string | null; merged?: { origin: TurnOrigin; triggerId: string | null }[]; had?: number };

interface Running {
  turn: Turn;
  /** It's only "/compact". */
  compact?: boolean;
  origin: TurnOrigin;
  /** Last sign of life from the agent (any output, activity, status or keep-alive), for the stall watchdog. */
  lastSignalAt: number;
  /** What the agent had read before this turn, so a retry can deliver the same messages again. */
  seenBefore: { seq: number; roster: number; pending: number[] };
  /** The watchdog already gave this turn's messages back for its retry (see handleStall). */
  redelivered?: boolean;
  /** The messages up to this seq were in the agent's conversation before this turn (QueuedTurn.had). */
  had?: number;
  abort: AbortController;
  driver: AgentDriver;
  replyId: string;
  text: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** How much of `text` clients have been sent, and the batch waiting to go (see flushText). */
  textSent: number;
  textTimer: ReturnType<typeof setTimeout> | null;
  usage: TurnUsage;
  /** What the driver said about the cost beyond `usage`: for the spend ledger only, never stored with the turn. */
  ledger?: Pick<LedgerUsage, "costTotalUsd" | "costFromBaseline">;
  stopping: boolean;
  /** The reply was split around a message the human sent mid-turn (see sink.newReply). */
  split?: boolean;
  /** Messages "Send now" handed to this reply that it hasn't read yet: it reads them where it splits (sink.newReply). */
  steered?: Message[];
  /** "Read it now" is stopping the step the agent is on, so it reads the messages in `steered` now. */
  readingNow?: boolean;
  /** "Stop and answer my message": what this reply was handed and will never read is answered next (finishRunning). */
  answerHanded?: boolean;
  /** A duplicated chat's note of the conversation it was copied from went with this turn, with these messages. */
  handoff?: string[];
  /** The agent has the turn's message in its conversation (sink.taken), even if the turn is stopped or fails later. */
  taken?: boolean;
  /** The agent asked something in this reply (an approval or a question card): part of what it got done (staleRetry). */
  asked?: boolean;
  /** The turn's steps (activities), as they are now. */
  steps: Map<string, Step>;
}

/** A step of a running turn as the engine streams it (see updateStep). */
interface Step {
  act: Activity;
  /** How much of its detail clients have been sent, and the database holds. */
  sent: number;
  timer: ReturnType<typeof setTimeout> | null;
}

type StepChange = { title?: string; kind?: ActivityKind; status?: Activity["status"] };

interface PendingApproval {
  approval: Approval;
  resolve: (d: ApprovalDecision) => void;
  turnId: string | null;
  /** A question's answers, handed over just before it resolves as approved. */
  onAnswers?: (answers: Record<string, string[]>) => void;
  /**
   * A question the agent can go on without (Approval.autoResolveMs): how long it waits once a device shows it, until
   * you start answering. Then `timer` tells it there's no answer (Approval.autoResolveAt), by `expire`.
   */
  autoResolveMs?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Ends it unanswered (the agent goes on without an answer). */
  expire?: () => void;
}

export class Engine {
  private readonly store: Store;
  private readonly bus: Bus;
  private drivers = new Map<string, AgentDriver>(); // memberId -> driver
  private sessionGenerations = new Map<string, number>();
  private driverSessionGenerations = new WeakMap<AgentDriver, number>();
  private modelGenerations = new Map<string, number>();
  private driverModelGenerations = new WeakMap<AgentDriver, number>();
  /** The settings each agent process was started with (getDriver): what a change since is measured against (changesSince). */
  private driverMembers = new WeakMap<AgentDriver, Member>();

  /** A model-menu selection replaces a pin without discarding the current conversation's identifiers. */
  invalidateModel(memberId: string) {
    this.modelGenerations.set(memberId, (this.modelGenerations.get(memberId) ?? 0) + 1);
  }

  /** A new account or fresh session must never accept late session identifiers from the old driver. */
  invalidateSession(memberId: string) {
    this.sessionGenerations.set(memberId, (this.sessionGenerations.get(memberId) ?? 0) + 1);
    // What the old process held for its next turn belongs to the old conversation.
    this.setCarried(memberId, null);
  }

  /**
   * What an agent's last process held for its next turn and nobody else had (AgentDriver.carryNote: Codex's helpers'
   * answers queued in its app-server's memory), taken as that process was replaced or ended (a hub restart included):
   * said at the start of the member's next turn, by member. Kept in kv `carryNotes` too, so a restart doesn't lose it.
   */
  private carryNotes = new Map<string, string>();

  private setCarried(memberId: string, note: string | null) {
    if (note) this.carryNotes.set(memberId, note);
    else if (!this.carryNotes.delete(memberId)) return;
    try {
      if (this.carryNotes.size) this.store.kvSet("carryNotes", JSON.stringify(Object.fromEntries(this.carryNotes)));
      else this.store.kvDelete("carryNotes");
    } catch (e) {
      log.warn(`couldn't keep what an agent's process held for its next turn: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The process is about to go: what only it holds for the next turn is kept for that turn. */
  private keepCarried(memberId: string, d: AgentDriver) {
    try {
      const note = d.carryNote?.(true);
      if (note) this.setCarried(memberId, note);
    } catch (e) {
      log.warn(`couldn't keep what @${memberId}'s process held for its next turn: ${e instanceof Error ? e.message : e}`);
    }
  }
  private running = new Map<string, Running>(); // turnId -> state
  private queue = new Map<string, Turn[]>(); // roomId -> queued turns
  /** Agents whose session is being started afresh: their queued turns wait for it. */
  private resetting = new Set<string>();
  private pending = new Map<string, PendingApproval>(); // approvalId -> waiter
  private noticedChains = new Set<string>();
  private chainReplies = new Map<string, Set<string>>(); // chainId -> normalized replies (loop guard)
  private pausedLoops = new Set<string>(); // review rooms waiting for the human's answer to a QUESTION
  private staleLoopTurns = new Set<string>(); // loop steps already running when their loop paused: they don't continue it
  private stallRetried = new Set<string>(); // chain:member pairs already restarted once after a frozen turn
  private watchdog: ReturnType<typeof setInterval>;
  private idleCheck: ReturnType<typeof setInterval>;
  /** Replies waiting for a usage limit to reset, by turn id (the turns table holds them too: see checkWaits). */
  private waits = new Map<string, LimitWait>();
  /**
   * Turns carrying on after a limit, by turn id, until each ends: `why` "now" when the user asked (so the wait's budget
   * is untouched, limitWaitFor), `told` once the phone has heard it carried on (carriedThrough).
   */
  private carriedOn = new Map<string, { wait: LimitWait; why: "reset" | "now"; told?: boolean }>();
  private waitCheck: ReturnType<typeof setInterval>;
  /** When each member's agent process last did anything (a turn, background work), for ending idle ones. */
  private lastUsed = new Map<string, number>();
  /** Interrupted turns resumeAfterRestart held back until their model server runs (resumeHeld picks them up). */
  private held: { roomId: string; memberId: string; trigger: string | null; chainId: string; hop: number; note: string | null; origin: TurnOrigin; had: number }[] = [];

  /** Picks up the held turns of the members `which` names (their model server runs now); the others wait on. */
  resumeHeld(which: (member: Member) => boolean) {
    const rooms = new Set<string>();
    this.held = this.held.filter((h) => {
      const room = this.store.getRoom(h.roomId);
      const member = this.store.getMember(h.memberId);
      if (!room || room.archived || !member) return false;
      if (!which(member)) return true;
      // Answered meanwhile (Answer now or Try again ran it once the server was up): nothing left to pick up.
      const from = h.trigger ? this.store.messageSeq(h.trigger) : 0;
      if (from > 0 && this.store.getLastSeen(member.id).seq >= from) return false;
      this.redelivers(this.enqueue(room, member, h.trigger, h.chainId, h.hop, h.note, h.origin), h.had);
      rooms.add(room.id);
      return false;
    });
    for (const id of rooms) this.schedule(id);
  }

  /** Turns the last hub process left queued or running, picked up again by resumeAfterRestart. */
  private interrupted: Turn[] = [];
  private shuttingDown = false;
  /** Members whose settings changed while they were busy: their driver is replaced before their next turn. */
  private replaceAfterTurn = new Set<string>();
  /**
   * What changed for a member's process outside its own settings (its folder, its account's key, teamwork…), which the
   * engine can't compare for itself (memberChanged's `outside`). Gone with the process.
   */
  private outsideChanges = new Map<string, Set<HeldChange>>();
  /** A line for the chat once a change that waited for a member's reply or helpers applies (memberChanged's `applied`). */
  private appliedNotes = new Map<string, string>();
  /** Members whose chat has said, in this hold, that their new settings apply when their helpers finish, and when (noteAround). */
  private aroundSaid = new Map<string, number>();
  /** Notes in chats about what waits for an agent's helpers, by message id (noteForPerson). */
  private forPerson = new Set<string>();
  /**
   * How far the chat had got when messages were given back to the person, by member (giveBack): reading them again, the agent
   * reads them, not the notes said about what waits up to then (forPerson).
   */
  private notesPassed = new Map<string, number>();
  /**
   * With "Keep going while helpers work" off: members whose next turn starts although their new settings still wait for
   * their helpers, because the person tapped Answer now (answerNow). Used up when that turn starts.
   */
  private answerAnyway = new Set<string>();
  /** What's being handed to each member's running reply right now (sendNowWhy): one hand-over at a time per agent. */
  private steering = new Map<string, Promise<SendNowResult>>();
  /** Members whose running reply is asked again in a moment to take a waiting message (flowIn). */
  private flowTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Members to start again once their current reply ends (their new settings apply from there), with the note to give. */
  private continueAfter = new Map<string, string>();
  private continuationTurns = new Set<string>();
  isContinuationTurn(turn: Turn): boolean { return this.continuationTurns.has(turn.id); }
  /** Turns that answered only other chats' messages (see isRelayTurn). */
  private relayOnly = new Set<string>();
  /**
   * Messages "Send now" handed to a reply that ended before reading them, by member: the agent answers them next (Claude
   * Code starts a turn of its own for it), so its next turn, if it starts within a minute, is the one that read them.
   */
  private handedOver = new Map<string, { messages: Message[]; at: number }>();
  private idleWaiters: (() => void)[] = [];
  /** What clients were last told about each member's status and reading (see setMemberStatus). */
  private told = new Map<string, string>();

  constructor(private deps: EngineDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    // Anything left mid-flight by a previous hub process ends here; resumeAfterRestart picks the work up again.
    this.interrupted = this.store.unfinishedTurns();
    // What the last hub's agent processes held for their next turns (keepCarried): those turns still get it.
    try {
      const kept = JSON.parse(this.store.kvGet("carryNotes") ?? "{}") as Record<string, unknown>;
      for (const [memberId, note] of Object.entries(kept ?? {})) if (typeof note === "string" && note && this.store.getMember(memberId)) this.carryNotes.set(memberId, note);
    } catch {
      // Unreadable: nothing to carry.
    }
    this.store.failUnfinishedTurns();
    this.store.markStreamingStopped();
    this.store.expirePendingApprovals();
    this.store.resetAllMemberStatus();
    const stallMs = deps.stallMs ?? STALL_MS;
    this.watchdog = setInterval(() => this.checkStalls(stallMs), Math.max(25, Math.min(30_000, stallMs / 4)));
    (this.watchdog as { unref?: () => void }).unref?.();
    const idleMs = deps.idleEndMs ?? IDLE_END_MS;
    this.idleCheck = setInterval(() => this.endIdle(idleMs), Math.max(25, Math.min(60_000, idleMs / 4)));
    (this.idleCheck as { unref?: () => void }).unref?.();
    // Replies the last hub process left waiting for a limit carry on from here: the wait is in the database, not memory.
    for (const t of this.store.waitingTurns()) {
      if (!t.wait) continue;
      this.waits.set(t.id, t.wait);
      // Say so again: every status was just cleared, and a waiting chat must still look like one after a restart.
      this.setMemberStatus(t.memberId, "waiting", t.error ?? limitWaitWords(t.wait, this.now()), t.wait);
    }
    this.waitCheck = setInterval(() => this.checkWaits(), WAIT_TICK_MS);
    (this.waitCheck as { unref?: () => void }).unref?.();
  }

  /** The clock (EngineDeps.now in tests), so a wait can be checked without waiting for real time. */
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // =====================================================================
  // Public API
  // =====================================================================

  postHumanMessage(roomId: string, text: string, authorName: string, routingText = text): Message & { seq: number } {
    const room = this.mustRoom(roomId);
    const members = this.store.listMembers(roomId);
    const mentionIds = this.resolveMentions(routingText, members, null, true, room.leadMemberId);
    const msg = this.insertMessage({
      roomId,
      authorKind: "human",
      memberId: null,
      authorName,
      text,
      mentions: mentionIds,
      turnId: null,
      status: "done",
    });
    // Every device's list moves the chat to the top, with the new time.
    this.emitRoom(roomId);
    if (!members.length) {
      this.systemMessage(roomId, room.chat?.group ? "There are no agents in this chat yet. Add one in the chat's settings." : "There are no agents in this room yet. Add one from the Agents panel.");
      return msg;
    }
    this.pausedLoops.delete(roomId); // the human's reply is the answer the loop was waiting for
    const chainId = newId("ch");
    const targets = this.humanTargets(room, members, mentionIds);
    // Waiting for a usage limit: your message cancels the wait for whoever it's for, and that agent answers now.
    this.cancelWaits(roomId, targets.map((m) => m.id), "message");
    // What the agents it goes to asked without waiting is answered (or overtaken) by it, as in Codex's own apps.
    this.closeQuestions((a) => a.roomId === roomId && targets.some((m) => m.id === a.memberId));
    if (room.mode === "roundrobin" && !mentionIds.length) {
      const rounds = Math.max(1, Math.min(room.rounds, 5));
      // A group chat where everyone answers in turn says so, and in what order (one round, so no round count).
      const inTurn = room.chat?.group && rounds === 1 ? `${REASON}Everyone in this chat answers the human's latest message, in turn: ${targets.map((m) => `@${m.handle}`).join(", then ")}. Answer it yourself, building on what the agents before you said above instead of repeating it.` : null;
      for (let r = 1; r <= rounds; r++) {
        for (const m of targets) this.enqueue(room, m, msg.id, chainId, 0, inTurn ?? `round ${r} of ${rounds}`);
      }
    } else {
      for (const m of targets) this.enqueue(room, m, msg.id, chainId, 0, null);
    }
    this.schedule(roomId);
    for (const m of targets) this.flowIn(roomId, m.id);
    return msg;
  }

  /**
   * A message from another chat's agent into a one-agent chat (xchat.ts): delivered like the user's messages, but
   * marked with where it came from, so the agent, the app and the limits all tell it apart from the user. `onSaved`
   * runs before the chat's agent can start on it (an idle chat starts at once), so the turn that reads it finds it
   * recorded.
   */
  postRelayMessage(roomId: string, text: string, via: MessageVia, authorName: string, onSaved?: (msg: Message) => void): Message & { seq: number } {
    const room = this.mustRoom(roomId);
    if (!room.chat || room.chat.group) throw new HttpError(409, "Only chats with one agent take messages from other chats", "room");
    const member = this.store.listMembers(roomId)[0];
    if (!member) throw new HttpError(409, "This chat has no agent", "not_ready");
    const msg = this.insertMessage({ roomId, authorKind: "human", memberId: null, authorName, text, mentions: [], turnId: null, status: "done", via });
    onSaved?.(msg);
    this.emitRoom(roomId);
    this.enqueue(room, member, msg.id, newId("ch"), 0, null);
    this.schedule(roomId);
    return msg;
  }

  /** Messages from other chats that a turn now reads: their senders can tell when the reply is done. */
  private markRelaysRead(messages: Message[], turnId: string) {
    const ids = messages.filter((m) => m.via).map((m) => m.id);
    if (ids.length) this.store.markRelaysDelivered(ids, turnId);
  }

  /** A sign of life for a member's running turn (it's waiting on another chat's reply, not frozen). */
  keepAlive(memberId: string) {
    const r = [...this.running.values()].find((x) => x.turn.memberId === memberId);
    if (r) r.lastSignalAt = Date.now();
  }

  /** The approval a turn is waiting on, if any. */
  pendingApprovalFor(turnId: string): { title: string; createdAt: number } | null {
    const p = [...this.pending.values()].find((x) => x.turnId === turnId);
    return p ? { title: p.approval.title, createdAt: p.approval.createdAt } : null;
  }

  /** A running turn's step as it is right now (its newest output may not be saved yet), or null. */
  liveActivity(id: string): Activity | null {
    for (const r of this.running.values()) {
      const step = r.steps.get(id);
      if (step) return step.act;
    }
    return null;
  }

  /** A turn as clients see it: a running chat reply says which messages "Send now" handed to it it hasn't read yet. */
  liveTurn(turn: Turn): Turn {
    const r = this.running.get(turn.id);
    if (!r?.steered?.length) return turn;
    return { ...turn, unread: r.steered.map((m) => m.id), readingNow: !!r.readingNow };
  }

  private emitLiveTurn(r: Running) {
    const turn = this.store.getTurn(r.turn.id);
    if (turn) this.bus.emit({ t: "turn", turn: this.liveTurn(turn) });
  }

  /** Whether a member has a turn running or waiting. */
  memberBusy(memberId: string): boolean {
    return [...this.running.values()].some((r) => r.turn.memberId === memberId) || [...this.queue.values()].some((q) => q.some((t) => t.memberId === memberId));
  }

  /** Why a member's plan is too close to its limit to take more work (when the user asked to pause there), or null. */
  overLimit(memberId: string): string | null {
    return this.overBudget([memberId]);
  }

  /**
   * A turn that answered only other chats' messages (no "finished" notification for it: their senders get the reply).
   * One that also answered the user (their message went in with a relay, or by "Send now") isn't.
   */
  isRelayTurn(turn: Turn): boolean {
    return this.relayOnly.has(turn.id);
  }

  /** Notes whether every message a turn answers came from another chat (see isRelayTurn). */
  private noteAnswered(turnId: string, messages: Message[], triggerId: string | null) {
    const said = messages.filter((m) => m.authorKind === "human" && m.text.trim());
    // Nothing new to read (it carries on with earlier work): it answers what started it.
    const relays = said.length ? said.every((m) => m.via) : !!(triggerId && this.store.getMessage(triggerId)?.via);
    if (!relays) return void this.relayOnly.delete(turnId);
    this.relayOnly.add(turnId);
    // Only turns that just ended are asked about.
    if (this.relayOnly.size > 500) this.relayOnly.delete(this.relayOnly.values().next().value!);
  }

  /** Whether "Send now" handed this message to a reply as it ended, so the agent's next turn is still to answer it. */
  answersLater(messageId: string): boolean {
    return [...this.handedOver.values()].some((h) => Date.now() - h.at < HANDED_OVER_MS && h.messages.some((m) => m.id === messageId));
  }

  /** What "Send now" handed to this member's last reply as it ended: the turn starting now reads it. */
  private takeHandedOver(memberId: string): Message[] {
    const h = this.handedOver.get(memberId);
    this.handedOver.delete(memberId);
    return h && Date.now() - h.at < HANDED_OVER_MS ? h.messages : [];
  }

  /**
   * An approval card for something an agent wants to do, that gives up after `timeoutMs` (or when `signal` aborts):
   * the card then expires, and the result is "timeout".
   */
  async approvalFromAgentTimed(memberId: string, req: { kind: Approval["kind"]; title: string; detail: string }, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ApprovalDecision | "timeout"> {
    const r = [...this.running.values()].find((x) => x.turn.memberId === memberId);
    const room = r ? this.store.getRoom(r.turn.roomId) : null;
    const member = this.store.getMember(memberId);
    if (!r || !room || !member) return "deny";
    let id: string | null = null;
    const decision = this.requestApproval(room, member, r, req, undefined, (approvalId) => (id = approvalId));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((res) => {
      // "timeout" before the card expires: an expired card's own decision reads "deny", but nobody denied it.
      const expire = () => {
        res("timeout");
        if (id) this.expireApproval(id);
      };
      timer = setTimeout(expire, opts.timeoutMs);
      if (opts.signal?.aborted) expire();
      else opts.signal?.addEventListener("abort", expire, { once: true });
    });
    try {
      // The timeout first, so it wins when both have settled already (the call had given up before the card went up).
      return await Promise.race([timeout, decision]);
    } finally {
      clearTimeout(timer);
    }
  }

  private expireApproval(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    const a = this.store.updateApproval(id, { status: "expired", decidedAt: Date.now() });
    if (a) this.bus.emit({ t: "approval", approval: a });
    p.resolve("deny");
  }

  /**
   * Picks up work a restart (or crash) interrupted, so restarting Crosstalk doesn't silently drop what agents were
   * doing: each agent that was working or waiting gets its turn again, resuming its session. Recent turns only (6 h),
   * and a turn resumed in the last 10 minutes isn't resumed again, so a crash it causes can't loop.
   */
  resumeAfterRestart(hold?: (member: Member) => boolean) {
    const now = Date.now();
    const rooms = new Set<string>();
    const waiting = new Set<string>();
    for (const t of this.interrupted) {
      if (t.createdAt < now - 6 * 3600_000) continue;
      const room = this.store.getRoom(t.roomId);
      const member = this.store.getMember(t.memberId);
      if (!room || room.archived || !member) continue;
      const key = `resumed:${t.chainId}:${t.memberId}`;
      if (now - Number(this.store.kvGet(key) ?? 0) < 10 * 60_000) continue;
      this.store.kvSet(key, String(now));
      let had = 0;
      if (t.status === "running") {
        // Deliver the messages that started it again (and a fresh briefing): the agent may come back without its session.
        const from = t.triggerMessageId ? this.store.messageSeq(t.triggerMessageId) : 0;
        const seen = this.store.getLastSeen(member.id);
        if (from > 0 && from <= seen.seq) this.store.setLastSeen(member.id, from - 1, 0, seen.pending);
        // It had written something or taken a step: it had the messages, and its session keeps them.
        const reply = t.replyMessageId ? this.store.getMessage(t.replyMessageId) : null;
        if (reply?.text.trim() || this.store.listActivities(t.roomId, [t.id]).length) had = seen.seq;
      }
      const note =
        t.status === "running"
          ? `${REASON}Crosstalk restarted while you were working on this. The messages you were answering are above again: finish what was asked, continuing from wherever you'd got to.`
          : t.origin === "loop"
            ? this.loopNote(room, member)
            : null;
      if (hold?.(member)) {
        // Its agent's model server isn't up yet (the model pool starts after the hub): it picks up once that runs.
        this.held.push({ roomId: room.id, memberId: member.id, trigger: t.triggerMessageId, chainId: t.chainId, hop: t.hop, note, origin: t.origin ?? "human", had });
        waiting.add(room.id);
        continue;
      }
      this.redelivers(this.enqueue(room, member, t.triggerMessageId, t.chainId, t.hop, note, t.origin ?? "human"), had);
      rooms.add(room.id);
    }
    this.interrupted = [];
    // A limit that reset while the hub was down: those chats carry on now, not at the next round.
    this.checkWaits();
    for (const id of waiting) if (!rooms.has(id)) this.systemMessage(id, "Crosstalk restarted. This chat picks up where it left off once the model pool runs again.");
    for (const id of rooms) {
      this.systemMessage(id, "Crosstalk restarted. Agents that were working are picking up where they left off.");
      this.schedule(id);
    }
  }

  /**
   * Stop queued and running turns in a room (optionally for one member). With `keepWaiting` ("Stop and answer my
   * message"), turns the user's own messages queued stay: once the reply that's running has stopped, if one is, those
   * messages are answered, and so are any handed to that reply that it never read. Without it ("Stop everything"), they're
   * left unread (Member.readSeq), for "Answer now".
   */
  async stop(roomId: string, memberId?: string, opts: { keepWaiting?: boolean } = {}): Promise<void> {
    if (!memberId) this.pausedLoops.delete(roomId);
    this.cancelWaits(roomId, memberId ? [memberId] : null, "stop");
    const q = this.queue.get(roomId) ?? [];
    const keep: Turn[] = [];
    const dropped: Turn[] = [];
    const yours = (t: Turn) => (t.origin ?? "human") === "human" && !!t.triggerMessageId && this.store.getMessage(t.triggerMessageId)?.authorKind === "human";
    for (const t of q) {
      if ((!memberId || t.memberId === memberId) && !(opts.keepWaiting && yours(t))) dropped.push(t);
      else {
        keep.push(t);
        // "Stop and answer my message" says it answers next, and it's a tap like Answer now (answerNow).
        if (opts.keepWaiting && (!memberId || t.memberId === memberId)) this.answerNow(t.memberId);
      }
    }
    this.queue.set(roomId, keep);
    for (const t of dropped) this.finishTurnRecord(t, "stopped", null);
    // Nothing left for them to do. A reply that's still stopping says so itself once it has (finishRunning).
    for (const id of new Set(dropped.map((t) => t.memberId))) {
      // An Answer now that hadn't started goes with its turn: the next message waits again until it's tapped.
      if (!keep.some((t) => t.memberId === id)) this.answerAnyway.delete(id);
      if (!keep.some((t) => t.memberId === id) && ![...this.running.values()].some((r) => r.turn.memberId === id)) this.setMemberStatus(id, "idle", null);
    }
    const stops: Promise<void>[] = [];
    for (const r of this.running.values()) {
      if (r.turn.roomId !== roomId) continue;
      if (memberId && r.turn.memberId !== memberId) continue;
      if (opts.keepWaiting) r.answerHanded = true;
      stops.push(this.stopRunning(r));
    }
    await Promise.all(stops);
    // What it kept goes next. With no reply to stop (a message held for the agent's helpers) nothing else looks again.
    if (opts.keepWaiting) this.schedule(roomId);
  }

  decideApproval(approvalId: string, decision: ApprovalDecision, by: string, answers?: Record<string, string[]>): Approval | null {
    const p = this.pending.get(approvalId);
    const cur = this.store.getApproval(approvalId);
    if (!cur || cur.status !== "pending") return cur;
    if (cur.delivery === "async") return this.answerLater(cur, decision, by, answers);
    // A request that can only be allowed once (an older app still offers "Always allow" for it): allowed once.
    if (decision === "approve_always" && cur.always === null) decision = "approve";
    const answered = cur.kind === "question" && decision !== "deny" ? cleanAnswers(cur, answers) : null;
    const updated = this.store.updateApproval(approvalId, {
      status: decision === "deny" ? "denied" : "approved",
      decision,
      decidedBy: by,
      decidedAt: Date.now(),
      ...(answered ? { answers: answered } : {}),
    });
    if (updated) this.bus.emit({ t: "approval", approval: updated });
    if (p) {
      this.pending.delete(approvalId);
      if (p.timer) clearTimeout(p.timer);
      if (answered) p.onAnswers?.(answered);
      p.resolve(decision);
      const r = p.turnId ? this.running.get(p.turnId) : null;
      if (r) {
        r.lastSignalAt = Date.now(); // however long the human took, the agent isn't frozen
        this.setMemberStatus(r.turn.memberId, "working", null);
      }
    }
    return updated;
  }

  /**
   * Your answer to questions the agent asked without waiting (Approval.delivery "async"): it goes to the agent as a
   * message of yours, Codex's reply envelope (codexQuestionReply), straight into its reply when one is running (as
   * Codex's own apps do), else starting one. Skipped, or with nothing answered, nothing is sent: the agent went on.
   */
  private answerLater(cur: Approval, decision: ApprovalDecision, by: string, raw?: Record<string, string[]>): Approval | null {
    const answers = decision === "deny" ? {} : cleanAnswers(cur, raw);
    const replies = (cur.questions ?? []).filter((q) => answers[q.id]?.length).map((q) => ({ questionItemId: q.id, question: q.question, answer: answers[q.id].join(", ") }));
    const updated = this.store.updateApproval(cur.id, {
      status: replies.length ? "approved" : "denied",
      decision: replies.length ? "approve" : "deny",
      decidedBy: by,
      decidedAt: Date.now(),
      ...(replies.length ? { answers } : {}),
    });
    if (updated) this.bus.emit({ t: "approval", approval: updated });
    const room = this.store.getRoom(cur.roomId);
    const member = this.store.getMember(cur.memberId);
    if (!replies.length || !room || !member) return updated;
    const msg = this.insertMessage({ roomId: room.id, authorKind: "human", memberId: null, authorName: by, text: codexQuestionReply(replies), mentions: [], turnId: null, status: "done" });
    this.emitRoom(room.id);
    this.enqueue(room, member, msg.id, newId("ch"), 0, null);
    this.schedule(room.id);
    // Its reply is still running: the answer goes into it now ("Send now"), as Codex expects; failing that, the reply
    // that's queued for it brings it once this one ends.
    if (room.chat && [...this.running.values()].some((r) => r.turn.roomId === room.id && r.turn.memberId === member.id)) {
      void this.sendNow(room.id).catch((e) => log.warn(`couldn't hand an answer to the running reply: ${e instanceof Error ? e.message : e}`));
    }
    return updated;
  }

  /**
   * A device shows a question the agent can go on without (Approval.autoResolveMs): its time starts now, as Codex's own
   * apps count it from when the question is on their screen, so one nobody has seen yet waits. Again (another device,
   * or once you've started answering), nothing changes. Returns the question as it is now, or null when there's no
   * such card.
   */
  seenApproval(approvalId: string): Approval | null {
    const cur = this.store.getApproval(approvalId);
    const p = this.pending.get(approvalId);
    if (!cur || cur.status !== "pending" || !p?.autoResolveMs || !p.expire || p.timer) return cur;
    p.timer = setTimeout(p.expire, p.autoResolveMs);
    (p.timer as { unref?: () => void }).unref?.();
    const updated = this.store.updateApproval(approvalId, { autoResolveAt: Date.now() + p.autoResolveMs });
    if (updated) {
      p.approval = updated;
      this.bus.emit({ t: "approval", approval: updated });
    }
    return updated;
  }

  /**
   * You started answering a question the agent can go on without (Approval.autoResolveMs): it now waits for you.
   * Returns the question as it is now, or null when there's no such card.
   */
  holdApproval(approvalId: string): Approval | null {
    const cur = this.store.getApproval(approvalId);
    const p = this.pending.get(approvalId);
    if (!cur || cur.status !== "pending" || !p?.autoResolveMs) return cur;
    if (p.timer) clearTimeout(p.timer);
    p.timer = undefined;
    p.autoResolveMs = undefined;
    const updated = this.store.updateApproval(approvalId, { autoResolveMs: null, autoResolveAt: null });
    if (updated) {
      p.approval = updated;
      this.bus.emit({ t: "approval", approval: updated });
    }
    return updated;
  }

  /** Questions agents asked without waiting (Approval.delivery "async") that `which` picks close unanswered. */
  private closeQuestions(which: (a: Approval) => boolean) {
    for (const a of this.store.listPendingApprovals()) {
      if (a.delivery !== "async" || !which(a)) continue;
      const closed = this.store.updateApproval(a.id, { status: "expired", decidedAt: Date.now() });
      if (closed) this.bus.emit({ t: "approval", approval: closed });
    }
  }

  /** A rewind took back the replies of these questions: they close, and go with those replies (deleteTurnsWithoutReplies). */
  closeRewoundQuestions(roomId: string) {
    this.closeQuestions((a) => {
      if (a.roomId !== roomId || !a.turnId) return false;
      const reply = this.store.getTurn(a.turnId)?.replyMessageId;
      return !!reply && !this.store.getMessage(reply);
    });
  }

  /**
   * "Send now": the human's messages waiting behind a chat's running reply go into that reply instead of waiting for it
   * to end. The waiting turn is dropped (the agent has the messages now), unless more came in while they were being
   * handed over. False when nothing waits or it can't be done (sendNowWhy says why). `memberId`: a group chat's agent
   * whose reply it is (two can work at once).
   */
  async sendNow(roomId: string, memberId: string | null = null): Promise<boolean> {
    return (await this.sendNowWhy(roomId, memberId)).sent;
  }

  /**
   * Send now, saying why when it didn't (SendNowResult): the app tells the person what is really holding their message
   * instead of guessing. Only while what waits is a new model, effort, fast mode or looser permissions (mayAnswerAround),
   * and the chat says it was answered with the settings the agent started with: an account switch or tighter permissions
   * are never answered around. While the agent's helpers work it happens by itself (flowIn), unless "Keep going while
   * helpers work" is off. `currentSettings`: with it off, no reply runs because settings the person changed wait for the
   * agent's helpers (heldForSettings), and they tapped Answer now: answered now, by the agent as it is (answerNow).
   */
  async sendNowWhy(roomId: string, memberId: string | null = null, opts: { currentSettings?: boolean } = {}): Promise<SendNowResult> {
    const room = this.store.getRoom(roomId);
    if (!room?.chat) throw new HttpError(400, "Send now works in chats");
    const q = this.queue.get(roomId) ?? [];
    // The running reply a message of yours is waiting for (in a group chat, only that agent's own waiting turn counts:
    // a message for another agent waits for its turn).
    const replies = [...this.running.values()].filter((x) => x.turn.roomId === roomId && (!memberId || x.turn.memberId === memberId));
    const r = replies.find((x) => q.some((t) => t.memberId === x.turn.memberId)) ?? replies[0];
    if (!r) return this.sendWithoutReply(room, q, memberId, !!opts.currentSettings);
    // One at a time per agent. A hand-over can be a call to the agent's server (Codex's steer), and what the next one
    // sees as unread only changes once it's done: two together, from two quick messages, would hand the first one twice.
    const going = this.steering.get(r.turn.memberId);
    if (going) {
      await going.catch(() => {});
      return this.sendNowWhy(roomId, memberId, opts);
    }
    const work = this.handToReply(room, r, q);
    this.steering.set(r.turn.memberId, work);
    try {
      return await work;
    } finally {
      this.steering.delete(r.turn.memberId);
    }
  }

  /** Send now into this running reply (sendNowWhy). */
  private async handToReply(room: Room, r: Running, q: Turn[]): Promise<SendNowResult> {
    const roomId = room.id;
    const waiting = q.filter((t) => t.memberId === r.turn.memberId);
    const member = this.store.getMember(r.turn.memberId);
    if (!member) return { sent: false, why: "nothing" };
    const seen = this.store.getLastSeen(member.id);
    const fresh = this.store.messagesAfter(roomId, seen.seq).filter((m) => m.authorKind === "human" && m.text.trim());
    // Nothing waits for it: the reply has the messages already (it started on them, or they were handed to it), or the
    // ones still unread are another agent's to answer.
    if (!waiting.length) return { sent: false, why: fresh.every((m) => r.steered?.some((s) => s.id === m.id)) ? "answering" : "nothing" };
    if (!r.driver.steer) return { sent: false, why: "unsupported" };
    if (!fresh.length) return { sent: false, why: "nothing" };
    // Settings changed while it works wait for this reply (and its helpers). This process answering anyway is fine for a
    // new model, effort, fast mode or looser permissions, said in the chat; never for an account switch or tighter
    // permissions: the message waits, and goes once the process is replaced.
    const around = this.replaceAfterTurn.has(member.id);
    if (around && !this.mayAnswerAround(member.id)) return { sent: false, why: "settings", held: this.heldOf(member.id) ?? { change: "other", helpers: this.helpersRunning(member.id) } };
    const upTo = this.store.maxSeq(roomId);
    // An answer to the agent's questions (Codex's reply envelope) goes as a message of its own: Codex's apps know one
    // for an answer only as the whole message. The others go together, all in order.
    const parts: (Message & { seq: number })[][] = [];
    for (const m of fresh) {
      const last = parts[parts.length - 1];
      if (!last || parseCodexQuestionReply(m.text) || parseCodexQuestionReply(last[0].text)) parts.push([m]);
      else last.push(m);
    }
    // In a group chat they're labelled as in its turns, and the ones for other agents say so: those answer them.
    const members = room.chat?.group ? this.store.listMembers(roomId) : [];
    const said = (part: (Message & { seq: number })[]) => (room.chat?.group && !parseCodexQuestionReply(part[0].text) ? buildGroupSteer(part, members, member, (m) => this.targetsOf(room, members, m)) : buildChatPrompt(part, null));
    const handed: (Message & { seq: number })[] = [];
    for (const part of parts) {
      if (!(await r.driver.steer(said(part), part.map((m) => m.id)))) break;
      handed.push(...part);
    }
    // A summary being made takes no messages, and isn't over: yours waits for the reply after it, however far it has got.
    if (!handed.length && r.compact && this.running.has(r.turn.id)) return { sent: false, why: "unsupported" };
    // The reply was ending and took none of them, or ended meanwhile (Codex's steer is a call to its server): the
    // waiting turn delivers the messages instead. One that has done nothing yet is still starting (Claude Code takes
    // nothing before its init has named the chat's model): a moment later it can.
    if (!handed.length && this.running.has(r.turn.id) && !r.taken && !r.text && !r.steps.size) return { sent: false, why: "notYet" };
    if (!handed.length || !this.running.has(r.turn.id)) return { sent: false, why: "ended" };
    // Only some went (the reply stopped taking them): the rest wait for the turn that's queued for them.
    const all = handed.length === fresh.length;
    // Counting all so far as read must not skip another agent's reply that's still being written: read later (as startTurn).
    const pending = [...new Set([...seen.pending, ...this.store.streamingSeqs(roomId, member.id)])];
    this.store.setLastSeen(member.id, all ? upTo : handed[handed.length - 1].seq, seen.rosterVersion, pending);
    this.memberRead(member.id);
    this.markRelaysRead(handed, r.turn.id);
    if (handed.some((m) => !m.via)) this.relayOnly.delete(r.turn.id);
    r.steered = [...(r.steered ?? []), ...handed];
    r.lastSignalAt = Date.now();
    // The app shows under these messages that they're read after the current step, with "Read it now".
    this.emitLiveTurn(r);
    // Answered by a process whose new settings wait: never silently. While its helpers work that's said once per hold,
    // since messages go in by themselves then (flowIn); anything else is someone's tap, said each time.
    if (around) {
      if (this.helpersAtWork(member.id) && this.flows()) this.noteAround(room, member);
      else this.answeringAround(room, member);
    }
    // Messages that came in meanwhile weren't handed over: the waiting turn stays, to deliver them.
    if (!all || this.store.messagesAfter(roomId, upTo).some((m) => m.authorKind === "human" && m.text.trim())) return { sent: true };
    this.queue.set(roomId, (this.queue.get(roomId) ?? []).filter((t) => !waiting.some((w) => w.id === t.id)));
    for (const t of waiting) this.finishTurnRecord(t, "stopped", null);
    return { sent: true };
  }

  /**
   * Send now when no reply of that agent's is running, so there's none to put the message into. Waiting for a usage
   * limit: nothing can send it sooner (the account has no quota), and the reply that carries on reads it first. Held
   * until the agent's helpers finish: says what holds it (heldForSettings). Under a new model or the like nothing does by
   * then, unless a reply the agent owes by itself comes first, or "Keep going while helpers work" is off: then
   * `currentSettings` (the person chose Answer now) answers it now, by the agent as it is, and the settings apply once the
   * helpers are done.
   */
  private sendWithoutReply(room: Room, q: Turn[], memberId: string | null, currentSettings: boolean): SendNowResult {
    const waiting = this.limitWaiting(room.id, memberId);
    if (waiting) return { sent: false, why: "limit", wait: waiting.wait };
    const held = q.find((t) => (!memberId || t.memberId === memberId) && this.heldForSettings(t.memberId));
    if (held) {
      const hold = this.heldOf(held.memberId) ?? { change: "other", helpers: true };
      if (currentSettings && this.answerNow(held.memberId)) {
        this.schedule(room.id);
        return { sent: true };
      }
      // Under an account switch or tighter permissions, "helpers": the old process never answers a message meant for the
      // new ones (it would run under the old account or permissions, and its session's records would be dropped). Said
      // first, so nobody is told to try again only to be told no. Otherwise "ownTurn": it's about to answer by itself what
      // it owes (its helpers' report, a message handed to its last reply), in a reply that starts in a moment, on the
      // settings it started with, and the message can go into that once it runs.
      return { sent: false, why: this.mayAnswerAround(held.memberId) && this.owedTurn(held.memberId) ? "ownTurn" : "helpers", held: hold };
    }
    // Its turn is next (the reply before it just ended), or nothing of yours is waiting for it.
    return { sent: false, why: q.some((t) => !memberId || t.memberId === memberId) ? "ended" : "nothing" };
  }

  /**
   * Whether the agent's next turn waits for what's waiting for its process (memberChanged). A turn its process owes by
   * itself (owedTurn) comes first: that reply is about to start. Otherwise only an account switch, tighter permissions or
   * a new folder hold it, and only while helpers keep the process: a new model, effort, fast mode or looser permissions
   * don't. The person works on while helpers run, for hours at a time, and the process as it is may answer around those
   * (mayAnswerAround), so their message starts at once, the chat says so once (noteAround), and the process is replaced
   * the first moment no helper and no reply runs (setTasks, finishRunning: memberChanged) however many messages keep coming.
   *
   * With "Keep going while helpers work" off those hold it too, so the new settings apply first, unless the person tapped
   * Answer now (answerNow). An account switch or tighter permissions since take that tap back.
   */
  private heldForSettings(memberId: string): boolean {
    if (!this.replaceAfterTurn.has(memberId)) return false;
    // What it owes by itself comes first; so does what a new process carries on from (ownTurn stopped a reply for it).
    if (this.owedTurn(memberId) || this.handOvers.has(memberId)) return true;
    if (!this.helpersRunning(memberId)) return false;
    return !this.mayAnswerAround(memberId) || (!this.flows() && !this.answerAnyway.has(memberId));
  }

  /**
   * The person tapped Answer now: a message held only because "Keep going while helpers work" is off goes now, by the agent
   * as it is, and the new settings still apply once the helpers are done (startTurn says so in the chat). False for anything
   * else that holds it: an account switch, tighter permissions, a new folder, what the process owes by itself (nobody is
   * told it went only to be told no), or nothing at all.
   */
  private answerNow(memberId: string): boolean {
    if (!this.heldForSettings(memberId) || !this.mayAnswerAround(memberId) || this.owedTurn(memberId) || this.handOvers.has(memberId)) return false;
    this.answerAnyway.add(memberId);
    log.info(`@${this.store.getMember(memberId)?.handle ?? memberId} answers now, before its new settings apply (asked to)`);
    return true;
  }

  /** "Keep going while helpers work" (EngineDeps.messagesFlow): anything but off is on. */
  private flows(): boolean {
    return this.deps.messagesFlow?.() !== false;
  }

  /**
   * "Keep going while helpers work" was just changed (App.setHubSettings). Turned on: what it was holding for settings the
   * process may answer around goes now, each once, the way any message does: it starts a turn, or goes into the reply that's
   * running, and the chat says so once per hold (noteAround). What must still wait goes on waiting. Turned off: nothing is
   * taken back from anyone; it applies from the next look on, so a message still waiting falls under it, and one that was
   * only waiting its turn says what holds it from now on (sayHeld).
   */
  flowChanged() {
    if (!this.flows()) {
      for (const q of this.queue.values()) for (const memberId of new Set(q.map((t) => t.memberId))) if (this.store.getMember(memberId)?.status === "queued") this.sayHeld(memberId);
      return;
    }
    this.answerAnyway.clear();
    for (const [roomId, q] of this.queue) for (const memberId of new Set(q.map((t) => t.memberId))) this.lookAgain(roomId, memberId);
  }

  /**
   * A turn of this member's is about to start while something waits for its process (and nothing holds it back,
   * heldForSettings): the process is replaced first if nothing it runs or owes keeps it any more (memberChanged), so the
   * turn never runs on what the person changed — even in the moment between its helpers' last word (or Claude Code saying
   * it's idle) and the hub hearing so. Where helpers still keep it, the turn runs on it as it is, and the chat says so
   * (startTurn). Not when the person asked for an answer with the settings it started with (answerNow).
   */
  private applyHeld(memberId: string) {
    if (this.replaceAfterTurn.has(memberId) && !this.answerAnyway.has(memberId)) void this.memberChanged(memberId, null);
  }

  /** Its helpers are at work: running, or reported back with the report not taken up yet (their work isn't done till it is). */
  private helpersRunning(memberId: string): boolean {
    return this.tasksRunning(memberId) || this.owedTurn(memberId) === "report";
  }

  /** Background work of its process (helpers, jobs, workflows) is still running. */
  private tasksRunning(memberId: string): boolean {
    return !!this.tasks.get(memberId)?.tasks.some((task) => task.status === "running");
  }

  /** Its helpers are at work as the person sees them (helperAtWork): the reply's own foreground command isn't one. */
  private helpersAtWork(memberId: string): boolean {
    return !!this.tasks.get(memberId)?.tasks.some(helperAtWork);
  }

  /**
   * A message of yours waits behind this agent's reply while its helpers work: it goes into that reply as Send now would,
   * with no tap, no bar and no button (helpers often work in the background while the person keeps iterating). A reply
   * still starting can't take it yet ("notYet"), so it's asked again in a moment.
   *
   * Where it can't go in, it goes by itself as the reply ends, never later: an agent with no mid-reply form, a summary
   * being made, a reply being stopped, a command (it goes as typed, on its own). So does anything that Send now's hand-over
   * would lose, which a tap can weigh up and this can't: it drops the waiting turn and counts everything so far as read, so
   * a turn that also carries another agent's request, a review step or a note, or another agent's reply it hasn't read yet,
   * goes as a turn. So does a message to a reply that isn't yours: a review step's reply is judged as a review and a reply to
   * another agent goes to that agent, here or in another chat (xchat.ts sends back all that turn wrote after its message), so
   * what's said to you there would go with it. On an account past its spending limit it goes as a turn too, which refuses it
   * in the usual plain words: going in would only spend more. What may not be answered around (an account switch…) holds it,
   * in plain words (handToReply's "settings"). Only your own message sets this off: another chat's agent's waits for the
   * reply's end, or goes in with yours. With "Keep going while helpers work" off nothing goes in without a tap (Send now).
   */
  private flowIn(roomId: string, memberId: string) {
    if (this.shuttingDown || !this.helpersAtWork(memberId) || !this.flows()) return;
    const waiting = (this.queue.get(roomId) ?? []).filter((t) => t.memberId === memberId) as QueuedTurn[];
    const r = [...this.running.values()].find((x) => x.turn.memberId === memberId);
    const room = this.store.getRoom(roomId);
    if (!waiting.length || !r || !r.driver.steer || r.stopping || r.compact || !room?.chat) return;
    if (r.origin !== "human" || this.relayOnly.has(r.turn.id)) return;
    if (this.replaceAfterTurn.has(memberId) && !this.mayAnswerAround(memberId)) return;
    if (waiting.some((t) => (t.origin ?? "human") !== "human" || t.note || t.had || t.merged?.some((x) => x.origin !== "human"))) return;
    const unread = this.store.messagesAfter(roomId, this.store.getLastSeen(memberId).seq);
    if (unread.some((m) => m.authorKind === "agent" && m.memberId !== memberId)) return;
    const said = unread.filter((m) => m.authorKind === "human" && m.text.trim());
    if (said.some((m) => m.text.trim().startsWith("/"))) return;
    const members = this.store.listMembers(roomId);
    if (!said.some((m) => !m.via && this.targetsOf(room, members, m).some((x) => x.id === memberId))) return;
    const member = members.find((m) => m.id === memberId);
    if (member && this.deps.checkBudget?.(room, member)) return;
    void this.sendNowWhy(roomId, memberId)
      .then((sent) => {
        if (sent.sent) log.info(`a message went into the running reply in ${room.name} by itself: its agent's helpers are at work`);
        if (sent.why === "notYet") this.flowLater(roomId, memberId);
      })
      .catch((e) => log.warn(`couldn't hand a message to @${memberId}'s running reply: ${e instanceof Error ? e.message : e}`));
  }

  private flowLater(roomId: string, memberId: string) {
    if (this.flowTimers.has(memberId)) return;
    const timer = setTimeout(() => {
      this.flowTimers.delete(memberId);
      this.flowIn(roomId, memberId);
    }, FLOW_RETRY_MS);
    (timer as { unref?: () => void }).unref?.();
    this.flowTimers.set(memberId, timer);
  }

  /**
   * What held this member's messages may be gone (a change taken back): they go now, not when the helpers finish. After
   * whatever called this (memberChanged may be on its way from schedule itself).
   */
  private lookAgain(roomId: string, memberId: string) {
    queueMicrotask(() => {
      this.schedule(roomId);
      this.flowIn(roomId, memberId);
    });
  }

  /**
   * A message goes to the agent's process as it is while new settings wait for its helpers: the chat says when they apply,
   * once per hold (dropHold ends it) and never once per message, so the person isn't told it again each time they write.
   * Except that the moment may never come: a dev server left running, a new helper with every reply. Helpers are never ended
   * for it, so the chat says it again on a reply after a long hold, or sooner once a newer helper has put it off again.
   * Otherwise a chat could run for days on the old model with nothing saying so.
   */
  private noteAround(room: Room, member: Member) {
    const said = this.aroundSaid.get(member.id);
    const now = this.now();
    if (said !== undefined) {
      const newer = this.tasks.get(member.id)?.tasks.some((t) => helperAtWork(t) && t.startedAt > said);
      if (now - said < (newer ? AROUND_AGAIN_NEWER_MS : AROUND_AGAIN_MS)) return;
    }
    this.aroundSaid.set(member.id, now);
    const name = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
    this.noteForPerson(room.id, said === undefined ? `Your new settings apply when ${name}'s helpers finish. Until then it answers with the settings it started with.` : `${name} still answers with the settings it started with. Your new settings apply when its helpers finish.`);
  }

  /**
   * A note about what the person's settings wait for. A group chat's agents read it as news, like any note, except past a
   * message handed over and given back (Stop): there it would be the newest thing the agent reads, instead of that message
   * (notesPassed, startTurn). (Kept in memory: after a restart it could be read once, which does no harm.)
   */
  private noteForPerson(roomId: string, text: string) {
    this.forPerson.add(this.systemMessage(roomId, text).id);
    if (this.forPerson.size > 500) this.forPerson.delete(this.forPerson.values().next().value!);
  }

  /** The chat has just said when this change applies, helpers included (App.updateMember): noteAround has nothing to add. */
  heldSaid(memberId: string) {
    this.aroundSaid.set(memberId, this.now());
  }

  /**
   * A turn the agent's process owes by itself and hasn't started on (AgentDriver.owedTurn): its helpers' report, or a
   * message handed to its last reply as that ended. Only that process can answer it, once: it's never replaced or ended
   * before it has (memberChanged, endIdle, renewIdle), and the reply it starts is shown as its own (ownTurn).
   */
  private owedTurn(memberId: string): "report" | "message" | null {
    return this.drivers.get(memberId)?.owedTurn?.() ?? null;
  }

  /**
   * What the agent's process was started with that has changed since, as a hold names it (HeldChange): a switch to
   * another account (its session is new), what the member's own settings say now against what the process started with,
   * and what changed outside them. Empty when nothing it runs with is different.
   */
  private changesSince(memberId: string, d: AgentDriver): Set<HeldChange> {
    const out = new Set<HeldChange>(this.outsideChanges.get(memberId));
    if ((this.driverSessionGenerations.get(d) ?? 0) !== (this.sessionGenerations.get(memberId) ?? 0)) out.add("account");
    const now = this.store.getMember(memberId);
    const was = this.driverMembers.get(d);
    if (now && was) for (const c of settingsChanges(was, now)) out.add(c);
    // "Default" or an alias picked again in the model menu means what it means now, not what this process came up on.
    if (now && (this.driverModelGenerations.get(d) ?? 0) !== (this.modelGenerations.get(memberId) ?? 0) && (!now.model || isModelAlias(now.model))) out.add("settings");
    return out;
  }

  /**
   * What waits for the agent's process to be replaced (Member.held), or null when nothing does. `owed`: what its process
   * owes by itself comes first (owedTurn), so the phone says that instead of "waiting for its helpers".
   */
  private heldOf(memberId: string): HeldSettings | null {
    if (!this.replaceAfterTurn.has(memberId)) return null;
    const d = this.drivers.get(memberId);
    const changes = d ? this.changesSince(memberId, d) : new Set<HeldChange>();
    const change = (["account", "permissions", "other"] as const).find((c) => changes.has(c)) ?? "settings";
    const owed = this.owedTurn(memberId);
    return { change, helpers: this.helpersRunning(memberId), ...(owed ? { owed } : {}) };
  }

  /**
   * Whether the agent's process as it is may answer while its new settings wait: only around a new model, effort or fast
   * mode, or looser permissions (it only asks more than it now has to).
   */
  private mayAnswerAround(memberId: string): boolean {
    return (this.heldOf(memberId)?.change ?? "settings") === "settings";
  }

  /** The chat says a message is being answered by the agent as it is, while its new settings wait (Send now, Answer now). */
  private answeringAround(room: Room, member: Member) {
    const name = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
    const replying = [...this.running.values()].some((r) => r.turn.memberId === member.id);
    const reply = room.chat?.group ? "its reply" : "this reply";
    const when = !this.helpersRunning(member.id) ? "from its next reply" : replying ? `once ${reply} and its helpers finish` : "once its helpers finish";
    this.noteForPerson(room.id, `Answering now with the settings ${name} started with. Your changes apply ${when}.`);
  }

  /**
   * When a change made just now to a member's settings reaches its agent (App.updateMember says so in the chat): null when
   * its next reply starts on it, else what it waits for — the reply that's running, its helpers — and the model the agent
   * answers on until then (the one its process was started with).
   */
  whenApplies(memberId: string): { reply: boolean; helpers: boolean; model: string | null } | null {
    const d = this.drivers.get(memberId);
    if (!d) return null;
    // A reply it's about to start by itself (a message handed to its last reply) counts as one.
    const reply = [...this.running.values()].some((r) => r.turn.memberId === memberId) || this.owedTurn(memberId) === "message";
    const helpers = this.helpersRunning(memberId);
    if ((!reply && !helpers) || !this.changesSince(memberId, d).size) return null;
    return { reply, helpers, model: this.driverMembers.get(d)?.model ?? null };
  }

  /**
   * "Read it now": the messages "Send now" handed to a chat's running reply wait for the step the agent is on (a long
   * command, say). This stops that step, so the agent reads them now and answers them in the same reply, once. False
   * when nothing handed over is waiting (it has read them), or the agent can't do it. `memberId`: as for sendNow.
   */
  async readNow(roomId: string, memberId: string | null = null): Promise<boolean> {
    const room = this.store.getRoom(roomId);
    if (!room?.chat) throw new HttpError(400, "Read it now works in chats");
    // In a group chat, the reply that has your messages waiting.
    const replies = [...this.running.values()].filter((x) => x.turn.roomId === roomId && (!memberId || x.turn.memberId === memberId));
    const r = replies.find((x) => x.steered?.length) ?? replies[0];
    if (!r?.steered?.length || !r.driver.readNow || r.stopping) return false;
    if (r.readingNow) return true;
    // Waiting on the user's approval: answering it moves the agent on (stopping the step would strand the card).
    if ([...this.pending.values()].some((p) => p.turnId === r.turn.id)) throw new HttpError(409, "It's waiting for your approval: answer that first, and it reads your message next.");
    r.readingNow = true;
    this.emitLiveTurn(r);
    let ok = false;
    let failed = false;
    try {
      ok = await r.driver.readNow();
    } catch (e) {
      failed = true;
      log.warn(`"Read it now" failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!this.running.has(r.turn.id)) return ok;
    r.lastSignalAt = Date.now();
    if (!ok && r.readingNow) {
      r.readingNow = false;
      this.emitLiveTurn(r);
    }
    if (failed) {
      const member = this.store.getMember(r.turn.memberId);
      const name = member ? PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}` : "The agent";
      throw new HttpError(409, `Couldn't stop the step: ${name} reads this after it.`, "read_now_failed");
    }
    return ok;
  }

  /**
   * Edit (`text`) or unsend (`text` null) one of the human's messages in a chat. One the agent hasn't read yet is just
   * changed or removed. One it has read rewinds the agent to just before it (it forgets that message and everything
   * after; files it changed stay changed): those messages leave the chat, and an edit is then sent as a new message.
   */
  async reviseMessage(messageId: string, text: string | null, by: string): Promise<{ removed: string[]; sent: Message | null }> {
    const m = this.store.getMessage(messageId);
    if (!m || m.authorKind !== "human") throw new HttpError(404, "No such message of yours");
    const room = this.store.getRoom(m.roomId);
    if (!room?.chat) throw new HttpError(400, "Messages can be edited and unsent in chats");
    const seq = this.store.messageSeq(messageId);
    const member = room.chat.group ? null : this.store.listMembers(room.id)[0];
    // A rewind this agent can't do is refused before anything changes, so it doesn't end a limit wait.
    if (member && seq <= this.store.getLastSeen(member.id).seq && !this.getDriver(room, member).rewind) throw new HttpError(400, "This agent can't go back to an earlier message");
    // Only the waits this takes back end here: one whose reply was answering this message (or a later one), or whose
    // agent goes back past it. In a group chat, another agent's wait carries on — a typo fixed in a message to @bob
    // mustn't drop @alice's.
    this.cancelWaits(room.id, this.waitsRewoundBy(room.id, seq), "rewind");
    if (room.chat.group) return this.reviseGroupMessage(room, m, text, by);
    if (!member) throw new HttpError(400, "This chat has no agent");
    const clean = text === null ? null : text.trim();
    if (clean === "") throw new HttpError(400, "Write something, or unsend the message instead");
    const seen = this.store.getLastSeen(member.id);
    const running = [...this.running.values()].find((x) => x.turn.roomId === room.id);

    if (seq > seen.seq) {
      // Not read yet: it's still waiting for the agent's next turn, or its reply failed before the agent got it.
      if (clean !== null) {
        this.store.updateMessage(messageId, { text: clean });
        this.emitMessage(messageId);
        // Nothing is going to answer it (its reply failed before the agent read it, or Stop left it): the edit is sent.
        if (!this.memberBusy(member.id)) {
          this.enqueue(room, member, messageId, newId("ch"), 0, null);
          this.schedule(room.id);
        }
        return { removed: [], sent: this.store.getMessage(messageId) };
      }
      // Replies that failed before the agent read it go with it: nothing is left for them to answer.
      const failed = this.store.turnsFor(messageId).filter((t) => t.status === "error" && t.replyMessageId).map((t) => t.replyMessageId!);
      const gone = [messageId, ...failed];
      for (const id of gone) this.store.deleteMessage(id);
      this.bus.emit({ t: "messages.removed", roomId: room.id, ids: gone });
      // Nothing else of the human's waiting: the turn that would have answered it isn't needed.
      const stillWaiting = this.store.messagesAfter(room.id, seen.seq).some((x) => x.authorKind === "human");
      if (!stillWaiting) {
        const q = this.queue.get(room.id) ?? [];
        const drop = q.filter((t) => t.memberId === member.id);
        this.queue.set(room.id, q.filter((t) => t.memberId !== member.id));
        for (const t of drop) this.finishTurnRecord(t, "stopped", null);
        if (!running && drop.length) this.setMemberStatus(member.id, "idle", null);
      }
      // A failed reply's error isn't left on the agent once the message it failed on is gone.
      if (!running && failed.length && this.store.getMember(member.id)?.status === "error") this.setMemberStatus(member.id, "idle", null);
      return { removed: gone, sent: null };
    }

    if (running) throw new HttpError(409, "The agent is working. Stop it first, then edit or unsend this message.");
    let forgotten: string[];
    try {
      forgotten = await this.getDriver(room, member).rewind!(messageId);
    } catch (e) {
      throw new HttpError(409, e instanceof Error ? e.message : String(e));
    }
    // The turn that brought a duplicated chat's agent the copied conversation was taken back: the next one brings it.
    const s = this.store.getMemberSession(member.id);
    if (Array.isArray(s.handoffWith) && [messageId, ...forgotten].some((id) => (s.handoffWith as string[]).includes(id))) {
      const { handoffWith: _sent, ...rest } = s;
      this.store.setMemberSession(member.id, rest);
    }
    // The agent went back to before the first message that went in with this one: the chat goes back there too.
    const from = Math.min(seq, ...forgotten.map((id) => this.store.messageSeq(id)).filter((n) => n > 0));
    const removed = this.store.deleteMessagesFrom(room.id, from);
    this.bus.emit({ t: "messages.removed", roomId: room.id, ids: removed });
    this.store.setLastSeen(member.id, this.store.maxSeq(room.id), seen.rosterVersion, []);
    this.store.touchRoom(room.id);
    this.setMemberStatus(member.id, "idle", null);
    const sent = clean !== null ? this.postHumanMessage(room.id, clean, by) : null;
    return { removed, sent };
  }

  /**
   * Edit or unsend one of your messages in a group chat. Nobody has read it: it's just changed (and sent again when
   * nothing is going to answer it) or removed. Agents that have read it each go back to just before the turn that
   * brought it, in their own conversations, and the chat goes back to just before the message: unlike a chat with one
   * agent, never further (the turn that brought it to one agent often brought messages for the others too). What an
   * agent forgot from before the message it reads again on its next turn.
   */
  private async reviseGroupMessage(room: Room, m: Message, text: string | null, by: string): Promise<{ removed: string[]; sent: Message | null }> {
    const members = this.store.listMembers(room.id);
    if (!members.length) throw new HttpError(400, "This chat has no agents");
    const clean = text === null ? null : text.trim();
    if (clean === "") throw new HttpError(400, "Write something, or unsend the message instead");
    const seq = this.store.messageSeq(m.id);
    const readers = members.filter((x) => this.store.getLastSeen(x.id).seq >= seq);

    if (!readers.length) {
      // Nobody has read it: it's still waiting for its agents, or their replies failed before they got it.
      if (clean !== null) {
        const mentions = this.resolveMentions(clean, members, null, true, room.leadMemberId);
        this.store.updateMessage(m.id, { text: clean, mentions });
        this.emitMessage(m.id);
        // Its agents that aren't going to answer it (their replies failed before they got it) get the edit; the others
        // read it as it is now when their turn comes. It goes to who it's for now: one it's no longer for doesn't answer it.
        const now = this.targetsOf(room, members, { mentions });
        for (const x of members) if (!now.includes(x)) this.dropAnswerTo(room, members, x, m.id, false);
        // One with a turn waiting reads it with that turn; any other gets one (after the reply it's on, if it's working).
        const queued = this.queue.get(room.id) ?? [];
        const unasked = now.filter((x) => !queued.some((t) => t.memberId === x.id));
        if (unasked.length) {
          const chainId = newId("ch");
          for (const x of unasked) this.enqueue(room, x, m.id, chainId, 0, null);
          this.schedule(room.id);
        }
        return { removed: [], sent: this.store.getMessage(m.id) };
      }
      const failed = this.store.turnsFor(m.id).filter((t) => t.status === "error" && t.replyMessageId).map((t) => t.replyMessageId!);
      const gone = [m.id, ...failed];
      for (const id of gone) this.store.deleteMessage(id);
      this.bus.emit({ t: "messages.removed", roomId: room.id, ids: gone });
      for (const x of members) this.dropAnswerTo(room, members, x, m.id, failed.length > 0);
      return { removed: gone, sent: null };
    }

    const working = members.find((x) => [...this.running.values()].some((r) => r.turn.memberId === x.id));
    if (working) throw new HttpError(409, `@${working.handle} is working. Stop it first, then edit or unsend this message.`);
    // Each agent that read it goes back to just before the turn that brought it, by the rewind point its driver noted
    // then (TurnInput.messageIds). One with no conversation (a fresh session) has nothing to forget.
    const refsOf = (x: Member) => {
      const refs = this.store.getMemberSession(x.id).msgRefs;
      return refs && typeof refs === "object" ? (refs as Record<string, unknown>) : null;
    };
    const going = readers.filter((x) => Object.keys(this.store.getMemberSession(x.id)).length > 0);
    for (const x of going) {
      // Starting it fresh gives it nothing to forget, so the others can go back.
      if (!this.getDriver(room, x).rewind) throw new HttpError(409, `@${x.handle} can't go back to an earlier message. Start a fresh session for @${x.handle} in the chat's settings, then try again.`);
      if (typeof refsOf(x)?.[m.id] !== "string") throw new HttpError(409, `@${x.handle} can't go back to before this message: it read it before this chat could go back. Start a fresh session for @${x.handle} in the chat's settings, then try again.`);
    }
    const rewound = new Set<string>();
    for (const x of going) {
      let forgotten: string[];
      try {
        forgotten = await this.getDriver(room, x).rewind!(m.id);
      } catch (e) {
        // Agents that went back already did: the chat goes back with them, and says which one couldn't.
        if (!rewound.size) throw new HttpError(409, `@${x.handle} couldn't go back: ${e instanceof Error ? e.message : String(e)}`);
        this.systemMessage(room.id, `@${x.handle} couldn't go back to before your message, so it still remembers it.`);
        continue;
      }
      rewound.add(x.id);
      // The turn that brought a duplicated chat's agent the copied conversation was taken back: the next one brings it.
      const s = this.store.getMemberSession(x.id);
      if (Array.isArray(s.handoffWith) && [m.id, ...forgotten].some((id) => (s.handoffWith as string[]).includes(id))) {
        const { handoffWith: _sent, ...rest } = s;
        this.store.setMemberSession(x.id, rest);
      }
    }
    // The chat goes back to just before the message. What an agent forgot from before it (the rest of what its turn
    // brought: other agents' replies, messages for them) stays: it reads that again on its next turn.
    const removed = this.store.deleteMessagesFrom(room.id, seq);
    this.bus.emit({ t: "messages.removed", roomId: room.id, ids: removed });
    const upTo = this.store.maxSeq(room.id);
    for (const x of members) {
      const seen = this.store.getLastSeen(x.id);
      // Replies from before the message it was still owed (written while it worked) stay owed.
      const owed = seen.pending.filter((p) => p < seq);
      // One that went back reads again from its own reply before the message, however long ago that was.
      if (rewound.has(x.id)) this.store.setLastSeen(x.id, Math.min(upTo, this.store.lastReplySeq(room.id, x.id, seq)), seen.rosterVersion, owed);
      else if (readers.includes(x) || seen.seq > upTo) this.store.setLastSeen(x.id, Math.min(seen.seq, upTo), seen.rosterVersion, owed);
      if (readers.includes(x)) this.setMemberStatus(x.id, "idle", null);
    }
    this.store.touchRoom(room.id);
    const sent = clean !== null ? this.postHumanMessage(room.id, clean, by) : null;
    return { removed, sent };
  }

  /**
   * A group chat agent's waiting turn that would have answered a message of yours that's gone or no longer for it, when
   * nothing else of yours waiting is for it either: it goes (a review step that waits isn't one). `failed`: replies that
   * failed on that message went too, so an error it was left with goes as well.
   */
  private dropAnswerTo(room: Room, members: Member[], x: Member, messageId: string, failed: boolean) {
    const left = this.store.messagesAfter(room.id, this.store.getLastSeen(x.id).seq).some((y) => y.id !== messageId && y.authorKind === "human" && this.targetsOf(room, members, y).some((t) => t.id === x.id));
    if (left) return;
    const q = this.queue.get(room.id) ?? [];
    const answering = (t: Turn) => t.memberId === x.id && (t.origin ?? "human") === "human" && !!t.triggerMessageId && (t.triggerMessageId === messageId || !this.store.getMessage(t.triggerMessageId));
    const drop = q.filter(answering);
    if (!drop.length && !failed) return;
    this.queue.set(room.id, q.filter((t) => !answering(t)));
    for (const t of drop) this.finishTurnRecord(t, "stopped", null);
    const running = [...this.running.values()].some((r) => r.turn.memberId === x.id);
    if (!running && (drop.length || this.store.getMember(x.id)?.status === "error")) this.setMemberStatus(x.id, "idle", null);
  }

  /**
   * "Try again" on a chat's failed reply, and "Answer now" on a message nothing answered. Messages of the user's the
   * agent hasn't read get a turn. Otherwise its newest reply, when that failed, is tried again: the agent gets the
   * messages it was answering once more, with a note to carry on from where it got to. Refused (409) while the agent
   * works, and when its newest reply didn't fail (a later one answered). `currentSettings`: it's Answer now, so with "Keep
   * going while helpers work" off it goes now on the agent as it is (answerNow); Try again waits like any message then, and
   * the bar offers Answer now.
   */
  retry(roomId: string, memberId: string | null = null, opts: { currentSettings?: boolean } = {}): Turn {
    const room = this.store.getRoom(roomId);
    if (!room?.chat) throw new HttpError(400, "Try again works in chats");
    if (room.chat.group) return this.retryGroup(room, memberId, !!opts.currentSettings);
    const member = this.store.listMembers(roomId)[0];
    if (!member) throw new HttpError(400, "This chat has no agent");
    return this.retryMember(room, member, !!opts.currentSettings);
  }

  /**
   * Try again and Answer now in a group chat. For one agent (Try again under its failed reply): as in a chat with one
   * agent. Otherwise (Answer now under your message): your newest message goes to whoever it's for that hasn't read it,
   * and failing that, the agent whose reply failed last tries again.
   */
  private retryGroup(room: Room, memberId: string | null, currentSettings: boolean): Turn {
    const members = this.store.listMembers(room.id);
    if (!members.length) throw new HttpError(400, "This chat has no agents");
    if (memberId) {
      const member = members.find((x) => x.id === memberId);
      if (!member) throw new HttpError(404, "That agent isn't in this chat any more.");
      return this.retryMember(room, member, currentSettings);
    }
    const yours = this.store.listMessages(room.id, { limit: 200 }).findLast((m) => m.authorKind === "human" && !m.via && m.text.trim());
    const who = yours ? this.targetsOf(room, members, yours).filter((x) => this.store.getLastSeen(x.id).seq < yours.seq) : [];
    if (yours && who.length) {
      const busy = who.find((x) => this.memberBusy(x.id));
      if (busy) throw new HttpError(409, `@${busy.handle} is working on it already.`, "busy");
      const chainId = newId("ch");
      // One waiting for its usage limit carries on now instead, with the messages its wait holds: a turn of its own
      // would run straight into the same limit, and the wait would then answer the same message again later.
      const turns = who.map((x) => {
        const waiting = this.limitWaiting(room.id, x.id);
        const turn = (waiting && this.carryOn(waiting, waiting.wait, "now")) || this.enqueue(room, x, yours.id, chainId, 0, null);
        if (currentSettings) this.answerNow(x.id);
        return turn;
      });
      this.schedule(room.id);
      return turns[0];
    }
    const failed = members
      .map((x) => ({ x, t: this.store.lastEndedTurn(x.id) }))
      .filter((e) => e.t?.status === "error")
      .sort((a, b) => (b.t!.startedAt ?? 0) - (a.t!.startedAt ?? 0))[0];
    if (!failed) throw new HttpError(409, "There's nothing to try again. Send a message to carry on.", "nothing");
    return this.retryMember(room, failed.x, currentSettings);
  }

  /** One agent's Try again (or Answer now): what of yours it hasn't read, else its newest reply if that failed. */
  private retryMember(room: Room, member: Member, currentSettings: boolean): Turn {
    const roomId = room.id;
    const name = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
    if (this.memberBusy(member.id)) throw new HttpError(409, `${name} is working on it already.`, "busy");
    // Waiting for a usage limit to reset: Try again means carry on now, with the same messages and note as the reset would.
    const waiting = this.limitWaiting(roomId, member.id);
    if (waiting) {
      const now = this.carryOn(waiting, waiting.wait, "now");
      if (now) {
        // It's Answer now under a message that waited with that reply: the same tap as below, where a hold kept it (carryOn).
        if (currentSettings && this.answerNow(member.id)) this.schedule(roomId);
        return now;
      }
    }
    const seen = this.store.getLastSeen(member.id);
    const unread = this.store.messagesAfter(roomId, seen.seq).filter((m) => m.authorKind === "human" && m.text.trim());
    // In a group chat, only those for it: the others it reads as the chat around it. Messages for other agents alone
    // aren't its to answer: its failed reply is what's tried again then.
    const members = room.chat?.group ? this.store.listMembers(roomId) : [];
    const mine = room.chat?.group ? unread.filter((m) => this.targetsOf(room, members, m).some((x) => x.id === member.id)) : unread;
    let turn: Turn;
    if (mine.length) {
      turn = this.enqueue(room, member, mine[mine.length - 1].id, newId("ch"), 0, null);
    } else {
      const last = this.store.lastEndedTurn(member.id);
      if (last?.status !== "error") throw new HttpError(409, last?.status === "done" ? "A later reply already answered this." : "There's nothing to try again. Send a message to carry on.", "nothing");
      // The agent had the messages: it reads them again from the one that started the reply that failed. They stay in
      // its conversation from that try, so taking one back later rewinds to before it, and the failed try goes too.
      turn = this.runAgain(room, member, last, `${REASON}Your last reply ended with an error, and the user asked you to try again. The messages it was answering are above again: finish what was asked, continuing from wherever you'd got to.`, newId("ch"));
    }
    if (currentSettings) this.answerNow(member.id);
    this.schedule(roomId);
    // Still held: what it had read may have just gone back (runAgain), and the app's bar goes by that (Member.readSeq).
    this.memberRead(member.id);
    return turn;
  }

  /**
   * Runs an ended reply again: the agent reads the messages it was answering once more, with `note` as the reason.
   * `had`: messages that were already in its conversation from that try (QueuedTurn.had), so taking one back later
   * still rewinds to before it. Shared by Try again and by carrying on after a limit.
   */
  private runAgain(room: Room, member: Member, turn: Turn, note: string, chainId: string, had = 0): Turn {
    const seen = this.store.getLastSeen(member.id);
    const from = turn.triggerMessageId ? this.store.messageSeq(turn.triggerMessageId) : 0;
    if (from > 0 && from <= seen.seq) this.store.setLastSeen(member.id, from - 1, seen.rosterVersion, seen.pending);
    const again = this.enqueue(room, member, turn.triggerMessageId, chainId, turn.hop, note);
    this.redelivers(again, Math.max(seen.seq, had));
    return again;
  }

  /** Approval requested out-of-band by an agent's MCP helper (Claude's permission prompt tool). */
  /**
   * An agent asks you questions (Claude Code's AskUserQuestion, through its permission prompt): resolves with your
   * answers by question id, or null when you skip them or the turn ends.
   */
  askFromAgent(memberId: string, title: string, questions: AgentQuestion[]): Promise<Record<string, string[]> | null> {
    const r = [...this.running.values()].find((x) => x.turn.memberId === memberId);
    const room = r ? this.store.getRoom(r.turn.roomId) : null;
    const member = this.store.getMember(memberId);
    if (!r || !room || !member) return Promise.resolve(null);
    return this.askQuestions(room, member, r, title, questions);
  }

  private askQuestions(room: Room, member: Member, state: Running, title: string, questions: AgentQuestion[], opts: { autoResolveMs?: number | null; signal?: AbortSignal } = {}): Promise<Record<string, string[]> | null> {
    let answers: Record<string, string[]> | null = null;
    return this.requestApproval(room, member, state, { kind: "question", title, detail: "", questions }, (a) => (answers = a), undefined, opts).then((d) => (d === "deny" ? null : answers ?? {}));
  }

  /**
   * Questions the agent asked and went on without waiting for (TurnSink.askLater): a card that outlives the reply, and
   * isn't something the agent waits on (its status stays as it is).
   */
  private lastAskedAt = 0;
  private askLater(room: Room, member: Member, state: Running, title: string, questions: AgentQuestion[]) {
    if (state.abort.signal.aborted || !questions.length) return;
    state.lastSignalAt = Date.now();
    state.asked = true;
    // The same question again (its ids say which item asked it) isn't a second card.
    if (this.store.listApprovals(room.id, 50).some((a) => a.delivery === "async" && a.questions?.[0]?.id === questions[0].id)) return;
    // Questions asked together (a card each) keep the order they were asked in.
    const createdAt = Math.max(Date.now(), this.lastAskedAt + 1);
    this.lastAskedAt = createdAt;
    const approval: Approval = {
      id: newId("ap"),
      roomId: room.id,
      memberId: member.id,
      turnId: state.turn.id,
      kind: "question",
      title,
      detail: "",
      status: "pending",
      decision: null,
      decidedBy: null,
      createdAt,
      decidedAt: null,
      questions,
      answers: null,
      delivery: "async",
    };
    this.store.insertApproval(approval);
    this.bus.emit({ t: "approval", approval });
  }

  /**
   * Questions the agent asked without waiting were answered in another app (DriverContext.questionsAnswered, or a sync
   * bringing in what was said in the Codex app): their cards in this chat close, answered there. `answers` by question
   * id, or by the id of the message that asked (codexAnswerTo).
   */
  questionsAnswered(roomId: string, answers: Record<string, string>) {
    for (const a of this.store.listPendingApprovals()) {
      if (a.delivery !== "async" || a.roomId !== roomId) continue;
      const got = Object.fromEntries((a.questions ?? []).flatMap((q) => {
        const answer = codexAnswerTo(q.id, answers);
        return answer === undefined ? [] : [[q.id, [answer]]];
      }));
      if (!Object.keys(got).length) continue;
      const done = this.store.updateApproval(a.id, { status: "approved", decision: "approve", decidedBy: "another app", decidedAt: Date.now(), answers: got });
      if (done) this.bus.emit({ t: "approval", approval: done });
    }
  }

  approvalFromAgent(memberId: string, req: { kind: Approval["kind"]; title: string; detail: string; always?: string | null }): Promise<ApprovalDecision> {
    const r = [...this.running.values()].find((x) => x.turn.memberId === memberId);
    if (!r) return Promise.resolve("deny");
    const room = this.store.getRoom(r.turn.roomId);
    const member = this.store.getMember(memberId);
    if (!room || !member) return Promise.resolve("deny");
    return this.requestApproval(room, member, r, req);
  }

  /**
   * A progress update posted mid-turn through the room MCP tool. Mentions here don't start turns: agents use these
   * for status ("Claude owns hub/"), and other agents read them on their next turn.
   */
  agentPost(memberId: string, text: string): Message | null {
    const member = this.store.getMember(memberId);
    if (!member) return null;
    const r = [...this.running.values()].find((x) => x.turn.memberId === memberId);
    return this.insertMessage({
      roomId: member.roomId,
      authorKind: "agent",
      memberId,
      authorName: member.handle,
      text: text.slice(0, 20_000),
      mentions: [],
      turnId: r?.turn.id ?? null,
      status: "done",
    });
  }

  /**
   * What the human has said to this agent since its previous reply: their messages, the newest few. For checking that
   * the human asked for something an agent wants to do on their behalf.
   */
  humanWordsFor(memberId: string): string {
    const r = [...this.running.values()].find((x) => x.turn.memberId === memberId);
    if (!r) return "";
    // In a group chat, only what was for this agent: words to another agent ask nothing of this one.
    const room = this.store.getRoom(r.turn.roomId);
    const members = room?.chat?.group ? this.store.listMembers(room.id) : null;
    const forIt = (m: Message) => !room || !members || this.targetsOf(room, members, m).some((x) => x.id === memberId);
    const msgs = this.store.listMessages(r.turn.roomId, { limit: 80 });
    let from = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.authorKind === "agent" && m.memberId === memberId && m.turnId !== r.turn.id) {
        from = i + 1;
        break;
      }
    }
    return msgs
      .slice(from)
      .filter((m) => m.authorKind === "human" && !m.via && forIt(m))
      .slice(-6)
      .map((m) => m.text)
      .join("\n");
  }

  /** Once this agent's current reply ends, start it again with this note: settings it changed apply from there. */
  continueAfterTurn(memberId: string, note: string): boolean {
    if (!this.memberBusy(memberId)) return false;
    this.continueAfter.set(memberId, note);
    return true;
  }

  /** Settings changed: drop the driver so the next turn starts it with the new settings (session is kept). */
  /** Background work per agent (helpers it summoned, workflows), as its driver last reported it. */
  private tasks = new Map<string, { roomId: string; tasks: BackgroundTask[] }>();

  private setTasks(roomId: string, memberId: string, tasks: BackgroundTask[]) {
    if (tasks.length || this.tasks.has(memberId)) {
      this.lastUsed.set(memberId, Date.now());
      if (tasks.length) this.tasks.set(memberId, { roomId, tasks });
      else this.tasks.delete(memberId);
      this.bus.emit({ t: "tasks", roomId, memberId, tasks });
    }
    // A helper started with a message of yours waiting behind the reply: it goes on by itself from here.
    this.flowIn(roomId, memberId);
    if (!this.replaceAfterTurn.has(memberId)) return;
    // Its helpers finished, reported back or started, or a reply of its own was stopped (ownTurn): memberChanged looks
    // again. What waited for them applies once nothing it runs (or owes by itself, unless the account changed) is left;
    // until then they hold it too, and Member.held says so.
    void this.memberChanged(memberId, null).then(() => this.schedule(roomId));
  }

  /** The agent's process is gone, and its background work with it. */
  private clearTasks(memberId: string) {
    const cur = this.tasks.get(memberId);
    if (cur) this.setTasks(cur.roomId, memberId, []);
  }

  /**
   * What the hub is busy with that its database doesn't show, for the restart scripts (busyFile.ts writes it to
   * RUN_DIR/busy.json): agents' background work still running (a test suite Claude Code started in the background,
   * helpers), and turns an agent's process owes by itself (its helpers' report or a message handed to its last reply,
   * about to be answered, or a reply of its own being stopped for new settings). Both live only in memory and in the
   * agent's process: a restart under them ends the work and loses the wake-up that carries the plan on. Replies running
   * or queued, asks and usage-limit waits are in the database, and so is what a process held for its next turn (a Codex
   * helper's answer, carryNotes: taken from every process as the hub stops).
   */
  busyWork(): { roomId: string; memberId: string; why: "background" | "owed" }[] {
    const out: { roomId: string; memberId: string; why: "background" | "owed" }[] = [];
    for (const [memberId, v] of this.tasks) if (v.tasks.some((t) => t.status === "running")) out.push({ roomId: v.roomId, memberId, why: "background" });
    for (const memberId of this.drivers.keys()) {
      // Owed: a wake-up its process will answer, or a reply of its own being stopped for new settings.
      if (!this.owedTurn(memberId) && !this.handOvers.has(memberId)) continue;
      const m = this.store.getMember(memberId);
      if (m) out.push({ roomId: m.roomId, memberId, why: "owed" });
    }
    return out;
  }

  /** Each agent's background work in a room, for a client loading it. */
  tasksIn(roomId: string): Record<string, BackgroundTask[]> {
    const out: Record<string, BackgroundTask[]> = {};
    for (const [memberId, v] of this.tasks) if (v.roomId === roomId) out[memberId] = v.tasks;
    return out;
  }

  /**
   * An agent started working by itself between turns (its background helpers reported back): shown as a reply of its
   * own, after a short note saying why. Not while another turn of this agent runs (that one shows the work). `owed`: what
   * it is taking up (AgentDriver.owedTurn), when it owed one.
   *
   * Never on settings it may not run on: when an account switch, tighter permissions or another change (a new folder…)
   * waits for this process, "stop" — the driver stops the reply before it can write or do anything, and nothing of it is
   * shown. Its first word proves Claude Code's request went out with what it owed in the conversation; once nothing else
   * runs in the process, a new one with the new settings carries on from there (memberChanged, carryOver). Before, the
   * whole reply ran here: a chat switched from Full to Ask had its background job's continuation (a push, a deploy) run
   * with no approval asked, and an account switch had it billed to the account the person had moved away from.
   */
  private ownTurn(roomId: string, memberId: string, run: (sink: TurnSink) => Promise<TurnResult>, why: string, owed: "report" | "message" | null = null): boolean | "stop" {
    const room = this.store.getRoom(roomId);
    const member = this.store.getMember(memberId);
    const driver = this.drivers.get(memberId);
    if (!room || !member || !driver || this.shuttingDown) return false;
    if ([...this.running.values()].some((r) => r.turn.memberId === memberId)) return false;
    // Settings changed meanwhile wait for this process (memberChanged): this reply is still its own, and says so — only
    // when it may answer around them (a new model, effort…).
    const hold = this.replaceAfterTurn.has(memberId) ? this.heldOf(memberId) : null;
    const blocked = hold && hold.change !== "settings" ? hold.change : this.changesSince(memberId, driver).has("account") ? "account" : null;
    if (blocked) {
      const was = this.handOvers.get(memberId);
      this.handOvers.set(memberId, new Set([...(was ?? []), owed ?? "other"]));
      this.replaceAfterTurn.add(memberId);
      log.info(`@${member.handle} in ${room.name} started a reply of its own while a change (${blocked}) waits for its process: stopped before it did anything, for a process on the new settings to carry on from`);
      this.refreshMember(memberId);
      return "stop";
    }
    const until = `${room.chat?.group ? "its" : "this"} reply${hold?.helpers ? " and its helpers finish" : " finishes"}`;
    this.systemMessage(room.id, hold ? `${why.replace(/\.$/, "")}, with the settings it started with: ${heldWords(hold.change)} once ${until}.` : why);
    if (hold?.helpers) this.heldSaid(memberId);
    const now = Date.now();
    const turn: Turn = { id: newId("t"), roomId: room.id, memberId: member.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: newId("ch"), origin: "human", status: "running", error: null, usage: null, createdAt: now, startedAt: now, endedAt: null };
    this.store.insertTurn(turn);
    // What "Send now" handed to its last reply as that ended is answered here: this turn read it.
    const handed = this.takeHandedOver(member.id);
    if (handed.length) {
      this.markRelaysRead(handed, turn.id);
      this.noteAnswered(turn.id, handed, null);
    }
    const reply = this.insertMessage({ roomId: room.id, authorKind: "agent", memberId: member.id, authorName: member.handle, text: "", mentions: [], turnId: turn.id, status: "streaming" });
    const started = this.store.updateTurn(turn.id, { replyMessageId: reply.id }) ?? turn;
    this.bus.emit({ t: "turn", turn: started });
    this.setMemberStatus(member.id, "working", null);
    const seen = this.store.getLastSeen(member.id);
    const state: Running = {
      turn: started,
      origin: "human",
      lastSignalAt: now,
      seenBefore: { seq: seen.seq, roster: seen.rosterVersion, pending: seen.pending },
      abort: new AbortController(),
      driver,
      replyId: reply.id,
      text: "",
      flushTimer: null,
      textSent: 0,
      textTimer: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null },
      stopping: false,
      steps: new Map(),
    };
    this.running.set(started.id, state);
    this.lastUsed.set(member.id, now);
    const sink = this.makeSink(room, member, state);
    void run(sink)
      .catch((e): TurnResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      // Its sign-in stopped working: there's nothing to send again, so the check says what to do (staleOwnTurn).
      .then((result) => (!result.ok && result.auth ? this.staleOwnTurn(room, member, state, sink, result) : result))
      .then((result) => this.finishRunning(room.id, member, state, result));
    // A message of yours that waited for this reply goes into it, if other helpers still work (once the driver has it).
    setTimeout(() => this.flowIn(room.id, member.id), 0);
    return true;
  }

  /**
   * Something the agent's process was started with changed: the process is replaced now, or, while it's busy, once its
   * reply ends — and while its background helpers run, once they finish too, its next turn waiting with them
   * (heldForSettings; Member.held says what waits). Not while it owes a turn of its own (owedTurn: its helpers' report,
   * a message handed to its last reply), which only this process holds: on a new model, effort or the like that reply
   * runs here first, once, and the change applies as it ends; on settings it may not run on, it's stopped as it starts
   * (ownTurn) and the new process carries on from it (carryOver). An account switch doesn't wait for it: the new account
   * starts a fresh session that can't carry it, and the account the person moved away from mustn't answer it.
   * Nothing is replaced when nothing it runs with is different (its name, its place in the list). `outside`: what changed
   * outside the member's own settings, which the engine can't compare itself (its folder, its account's key, teamwork…;
   * "other" unless said); null when only the member's settings changed (App.updateMember) or for another look once a
   * reply or helpers end. `applied`: a line for the chat when a change that had to wait applies (the model,
   * App.updateMember).
   */
  async memberChanged(memberId: string, outside: HeldChange | null = "other", applied?: string) {
    const d = this.drivers.get(memberId);
    // No process: the next one starts with the new settings, whatever they are.
    if (!d) return this.dropHold(memberId);
    if (outside) this.outsideChanges.set(memberId, new Set([...(this.outsideChanges.get(memberId) ?? []), outside]));
    if (applied) this.appliedNotes.set(memberId, applied);
    const changes = this.changesSince(memberId, d);
    const owed = this.owedTurn(memberId);
    if (!changes.size) {
      // Changed back before the process was replaced: a reply of its own it was stopped from (ownTurn) goes on here, on
      // the same process, once it has stopped (until then the hold stays, and its stopping brings this back: setTasks).
      const stopped = this.handOvers.get(memberId);
      if (stopped && owed) return;
      const m = this.store.getMember(memberId);
      this.dropHold(memberId);
      if (stopped && m) this.carryOver(m, "settings", stopped, undefined, false);
      else if (m) {
        // "Finishing helpers…" was about what just went. With nothing else to do it would stay until the next message.
        const queued = (this.queue.get(m.roomId) ?? []).some((t) => t.memberId === memberId);
        const replying = [...this.running.values()].some((r) => r.turn.memberId === memberId);
        if (!queued && !replying && m.status === "working" && m.statusDetail?.startsWith("Finishing helpers")) this.setMemberStatus(memberId, "idle", null);
        this.lookAgain(m.roomId, memberId);
      }
      return;
    }
    const busy = [...this.running.values()].some((r) => r.turn.memberId === memberId);
    // A turn it owes by itself (its helpers' report, a message handed to its last reply) is in this process alone:
    // replaced before it's under way, the report would go with it (owedTurn). Except for an account switch.
    const waitForOwed = !!owed && !changes.has("account");
    if (busy || this.tasksRunning(memberId) || waitForOwed) {
      // Picked up after the current turn, whatever changed (settings, or a stored token the driver holds).
      this.replaceAfterTurn.add(memberId);
      const held = this.heldOf(memberId);
      const cur = this.store.getMember(memberId);
      // A usage limit's wait keeps its own words (it says when the agent comes back): the hold rides along on `held`.
      if (!busy && this.helpersRunning(memberId) && held && cur && cur.status !== "waiting") this.setMemberStatus(memberId, "working", `Finishing helpers before ${heldWords(held.change)}`, cur.wait ?? null);
      else this.refreshMember(memberId);
      if (cur) this.lookAgain(cur.roomId, memberId);
      return;
    }
    const waited = this.replaceAfterTurn.has(memberId);
    const note = this.appliedNotes.get(memberId);
    const change = (["account", "permissions", "other"] as const).find((c) => changes.has(c)) ?? "settings";
    // What goes on with the new process: what it owed, and replies of its own stopped before they did anything.
    const carried = new Set<"report" | "message" | "other">([...(this.handOvers.get(memberId) ?? []), ...(owed ? [owed] : [])]);
    const handed = this.handedOver.get(memberId);
    this.dropHold(memberId);
    // What only that process holds for the next turn (Codex's helpers' answers) goes to the next turn instead.
    if (!changes.has("account")) this.keepCarried(memberId, d);
    this.drivers.delete(memberId);
    this.clearTasks(memberId);
    this.handedOver.delete(memberId); // the process that was to answer it goes
    const m = this.store.getMember(memberId);
    if (m) {
      // The process it waited for is gone: the chat says the change applies now, and the hold's status goes with it.
      if (waited && note) this.systemMessage(m.roomId, note);
      if (m.status === "working") this.setMemberStatus(memberId, (this.queue.get(m.roomId) ?? []).some((t) => t.memberId === memberId) ? "queued" : "idle", null);
      // Then what goes on with the new process (its reply may start at once).
      if (carried.size) this.carryOver(this.store.getMember(memberId) ?? m, change, carried, handed, true);
    }
    await d.dispose().catch(() => {});
  }

  /**
   * Replies of its own a process was stopped from, or what it owed, when it went for settings it may not answer on
   * (ownTurn, memberChanged), by member: "report" (its helpers reported back), "message" (one Send now handed its last
   * reply), "other" (it started on something by itself).
   */
  private handOvers = new Map<string, Set<"report" | "message" | "other">>();

  /**
   * What the agent's last process owed (its helpers' report, a message Send now handed its last reply), or had started
   * on by itself, goes on after that process went for settings it may not answer on. It took that into the session as
   * its reply started (ownTurn stopped the reply before it did anything), so the new process resumes the session and is
   * told to carry on from there, and the chat says so. `replaced`: a new process with the new settings, as against the
   * same one when the change was undone meanwhile. An account switch starts a fresh session without the conversation:
   * nothing carries over, and the chat says what wasn't answered; a message handed over is the person's again (unread,
   * with Answer now under it), for the new account.
   */
  private carryOver(member: Member, change: HeldChange, carried: Set<"report" | "message" | "other">, handed: { messages: Message[]; at: number } | undefined, replaced: boolean) {
    const room = this.store.getRoom(member.roomId);
    if (!room || room.archived) return;
    const name = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
    const report = carried.has("report");
    const message = carried.has("message");
    if (change === "account") {
      if (handed?.messages.length) this.giveBack(member, handed.messages);
      const what = report ? `${name}'s helpers reported back` : message ? `${name} was about to answer the message you sent` : `${name} had started on something by itself`;
      const lost = report ? "their report wasn't answered: ask again if you still need it" : message ? "that message wasn't answered: tap Answer now under it to send it to the new account" : "it didn't carry on: ask again if you still need it";
      this.systemMessage(room.id, `${what} after you switched accounts. The new account starts a fresh session without that conversation, so ${lost}.`);
      log.info(`@${member.handle} in ${room.name}: what its old account's process owed doesn't carry over to the fresh session (${[...carried].join(", ")})`);
      return;
    }
    const why = replaced ? "the user changed this chat's settings meanwhile, so Crosstalk started you again in this same conversation with the new settings" : "Crosstalk stopped you for a change of settings that was then undone, so you go on in this same conversation as you were";
    const redo = "without doing again anything you already did";
    const note =
      report && message
        ? `Your background work reported back and the user's last message came in (both above), and ${why}. Answer that message, and carry on from the report with what was asked, ${redo}.`
        : report
          ? `Your background work reported back (above), and ${why}. Carry on from that report with what was asked, ${redo}.`
          : message
            ? `The user's message above came in as your last reply ended, and ${why}. Answer it now.`
            : `You had started on something by yourself (above), and ${why}. Carry on with it, ${redo}.`;
    // What Send now handed the old process is read by the reply below (it's in the conversation already: it isn't sent again).
    if (handed?.messages.length) this.handedOver.set(member.id, { messages: handed.messages, at: Date.now() });
    this.enqueue(room, member, null, newId("ch"), 0, `${REASON}${note}`, "human", true);
    const goesOn = report && message ? "answers the message you sent and carries on from their report" : report ? "carries on from their report" : message ? "answers the message you sent" : "carries on with it";
    let said: string;
    if (!replaced) said = report ? `${name}'s helpers reported back: ${name} ${goesOn}.` : message ? `${name} ${goesOn}.` : `${name} carries on with what it had started by itself.`;
    else {
      const how = `${heldWords(change).replace(/^your/, "Your")} first: ${name} starts again ${change === "permissions" ? "under your new permissions" : change === "other" ? "with your changes" : "with your new settings"}`;
      said = report ? `${name}'s helpers reported back. ${how} and ${goesOn}.` : message ? `${how} and ${goesOn}.` : `${name} had started on something by itself. ${how} and ${goesOn}.`;
    }
    this.systemMessage(room.id, said);
    log.info(`@${member.handle} in ${room.name}: ${replaced ? "a process on the new settings" : "its process"} carries on from what the last one owed (${[...carried].join(", ")})`);
    this.schedule(room.id);
  }

  /** Nothing waits for the member's process to be replaced any more (it was, it's gone, or nothing it runs with changed). */
  private dropHold(memberId: string) {
    const was = this.replaceAfterTurn.delete(memberId);
    this.aroundSaid.delete(memberId);
    this.answerAnyway.delete(memberId);
    this.outsideChanges.delete(memberId);
    this.appliedNotes.delete(memberId);
    this.handOvers.delete(memberId);
    if (was) this.refreshMember(memberId);
  }

  /** Every device hears the member as it is now (what waits for its process, Member.held, included). */
  private refreshMember(memberId: string) {
    const m = this.store.getMember(memberId);
    if (m) this.setMemberStatus(memberId, m.status, m.statusDetail, m.wait ?? null);
  }

  async memberRemoved(member: Member) {
    this.invalidateSession(member.id);
    this.dropHold(member.id);
    this.notesPassed.delete(member.id);
    this.deps.resetMember?.(member.id);
    // The session that asked is gone (a fresh one starts, or the agent leaves): its questions can't be answered.
    this.closeQuestions((a) => a.memberId === member.id);
    await this.stop(member.roomId, member.id);
    const d = this.drivers.get(member.id);
    this.drivers.delete(member.id);
    this.clearTasks(member.id);
    if (d) await d.dispose().catch(() => {});
    this.deps.sessionOver?.(member.id);
  }

  async roomRemoved(roomId: string, memberIds: string[]) {
    await this.stop(roomId);
    for (const id of memberIds) {
      this.invalidateSession(id);
      this.dropHold(id);
      this.notesPassed.delete(id);
      this.deps.resetMember?.(id);
      const d = this.drivers.get(id);
      this.drivers.delete(id);
      this.clearTasks(id);
      if (d) await d.dispose().catch(() => {});
      this.deps.sessionOver?.(id);
    }
    this.queue.delete(roomId);
  }

  /**
   * Forget a member's provider session so its next turn starts fresh. It stops what the agent was doing. In a chat, a
   * message of the user's it hadn't read yet stays unread: nothing answers it until they ask (Answer now), and then the
   * fresh session gets it.
   */
  async resetSession(member: Member) {
    // A message sent while a slow-dying command is waited for belongs to the fresh session, not to the old one's last reply.
    this.resetting.add(member.id);
    try {
      await this.memberRemoved(member);
      this.store.setMemberSession(member.id, {});
      const seen = this.store.getLastSeen(member.id);
      const waiting = this.store.getRoom(member.roomId)?.chat ? this.store.messagesAfter(member.roomId, seen.seq).find((m) => m.authorKind === "human" && m.text.trim()) : undefined;
      this.store.setLastSeen(member.id, waiting ? waiting.seq - 1 : this.store.maxSeq(member.roomId), 0);
      this.memberRead(member.id);
      // A duplicated chat that hadn't forked the original's session yet has nothing to fork now.
      const cur = this.store.getMember(member.id);
      if (cur?.config?.forkNext !== undefined) {
        const { forkNext: _gone, ...config } = cur.config;
        this.store.updateMember(member.id, { config });
        const updated = this.store.getMember(member.id);
        if (updated) this.bus.emit({ t: "member", member: updated });
      }
      this.systemMessage(member.roomId, `@${member.handle} will start a fresh session on its next turn.`);
    } finally {
      this.resetting.delete(member.id);
      this.schedule(member.roomId);
    }
  }

  isBusy(roomId?: string): boolean {
    for (const r of this.running.values()) if (!roomId || r.turn.roomId === roomId) return true;
    for (const [rid, q] of this.queue) if ((!roomId || rid === roomId) && q.length) return true;
    return false;
  }

  /** Resolves once nothing is queued or running (used by tests). */
  whenIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  queuedTurns(roomId: string): Turn[] {
    return [...(this.queue.get(roomId) ?? [])];
  }

  runningTurns(roomId?: string): Turn[] {
    return [...this.running.values()].filter((r) => !roomId || r.turn.roomId === roomId).map((r) => r.turn);
  }

  /**
   * The hub is stopping (usually a restart). That's not a Stop: running and queued turns stay unfinished in the
   * database, so the next start picks them up again (resumeAfterRestart). What each reply streamed so far is saved,
   * and every agent's process is ended, waiting until it has really exited (SIGKILL if it ignores SIGTERM), so no
   * agent is left running orphaned after the hub exits.
   */
  async shutdown() {
    clearInterval(this.watchdog);
    clearInterval(this.idleCheck);
    clearInterval(this.waitCheck);
    this.shuttingDown = true;
    // Questions the agent could go on without don't time out after the hub has gone (the restart expires them).
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    for (const r of this.running.values()) {
      if (r.flushTimer) clearTimeout(r.flushTimer);
      if (r.textTimer) clearTimeout(r.textTimer);
      r.flushTimer = r.textTimer = null;
      this.store.updateMessage(r.replyId, { text: r.text });
      for (const step of r.steps.values()) this.flushStep(step);
    }
    // What only a process holds for its next turn (a Codex helper's answer) outlives it: the next hub says it.
    for (const [memberId, d] of this.drivers) this.keepCarried(memberId, d);
    await Promise.all([...this.drivers.values()].map((d) => d.dispose().catch(() => {})));
    // Including processes let go of earlier (Stop then a new turn, or the watchdog), still being ended in the background.
    await processesEnding();
    this.drivers.clear();
    this.running.clear();
    this.queue.clear();
  }

  /** The reply's text as it's saved: never lost to a problem in the app's rewrite. */
  private finishReply(room: Room, text: string): string {
    if (!this.deps.finishReply || !text) return text;
    try {
      return this.deps.finishReply(room, text);
    } catch (e) {
      log.warn(`couldn't prepare the reply's images: ${e}`);
      return text;
    }
  }

  systemMessage(roomId: string, text: string): Message {
    return this.insertMessage({
      roomId,
      authorKind: "system",
      memberId: null,
      authorName: "Crosstalk",
      text,
      mentions: [],
      turnId: null,
      status: "done",
    });
  }

  // =====================================================================
  // Routing
  // =====================================================================

  private resolveMentions(text: string, members: Member[], selfId: string | null, allowAll: boolean, leadId: string | null = null): string[] {
    // Agents often name each other in passing ("@codex's fix"): a possessive isn't a request.
    const handles = parseMentions(selfId ? text.replace(/@([a-zA-Z][\w-]{0,31})['’]s\b/g, "$1's") : text);
    if (allowAll && handles.some((h) => h === "all" || h === "everyone")) {
      // Everyone answers in the chat's turn order: the lead first.
      return turnOrder({ leadMemberId: leadId }, members.filter((m) => m.id !== selfId)).map((m) => m.id);
    }
    const ids: string[] = [];
    for (const h of handles) {
      const m = members.find((x) => x.handle.toLowerCase() === h);
      if (m && m.id !== selfId && !ids.includes(m.id)) ids.push(m.id);
    }
    return ids;
  }

  private humanTargets(room: Room, members: Member[], mentionIds: string[]): Member[] {
    if (mentionIds.length) return mentionIds.map((id) => members.find((m) => m.id === id)!).filter(Boolean);
    // Everyone in turn: the lead first, then the others as they joined.
    if (room.mode === "roundrobin") return turnOrder(room, members);
    if (room.mode === "review") return [reviewPair(room, members).builder!].filter(Boolean);
    return turnOrder(room, members).slice(0, 1);
  }

  /** Who a message of the human's is for: who it @mentions, else whoever answers a message that names nobody. */
  private targetsOf(room: Room, members: Member[], m: Pick<Message, "mentions">): Member[] {
    const named = m.mentions.map((id) => members.find((x) => x.id === id)).filter((x): x is Member => !!x);
    return named.length ? named : this.humanTargets(room, members, []);
  }

  /** `turn` delivers again messages up to `seq` that the agent took in already (QueuedTurn.had). */
  private redelivers(turn: Turn, seq: number) {
    const q = turn as QueuedTurn;
    if (seq > 0) q.had = Math.max(q.had ?? 0, seq);
  }

  private enqueue(room: Room, member: Member, triggerId: string | null, chainId: string, hop: number, note: string | null, origin: TurnOrigin = "human", preserveNote = false) {
    const q = this.queue.get(room.id) ?? [];
    // One waiting turn per agent (except round-robin): it sees every message since the agent's last turn, so a second
    // would only repeat it (several quick human messages used to start a build and a review each). The more important
    // reason leads (a review-loop step, then a human message, then a mention); the other is kept as a reminder line.
    // The reviewer is the exception: its review and a direct request to it stay separate turns, because its reply to
    // one is judged as a review and to the other is an answer.
    const reviewer = room.mode === "review" ? reviewPair(room, this.store.listMembers(room.id)).reviewer : undefined;
    const compatible = (t: Turn) => member.id !== reviewer?.id || ((t.origin ?? "human") === "loop") === (origin === "loop");
    const waiting = room.mode === "roundrobin" ? undefined : (q.find((t) => t.memberId === member.id && compatible(t)) as QueuedTurn | undefined);
    if (waiting) {
      const was = waiting.origin ?? "human";
      // Keep the freshest hand-off budget: a new human message mustn't inherit an older chain's nearly used-up limit.
      const budget = hop < waiting.hop ? { chainId, hop } : { chainId: waiting.chainId, hop: waiting.hop };
      const author = (id: string | null) => (id ? this.store.getMessage(id)?.memberId ?? null : null);
      const remember = (o: TurnOrigin, id: string | null) => {
        // Loop steps need no reminder; a second message of the same kind from the same author is already covered.
        const known = [{ origin: waiting.origin ?? "human", triggerId: waiting.triggerMessageId }, ...(waiting.merged ?? [])];
        if (o === "loop" || known.some((k) => k.origin === o && author(k.triggerId) === author(id))) return;
        waiting.merged = [...(waiting.merged ?? []), { origin: o, triggerId: id }];
      };
      if (ORIGIN_RANK[origin] > ORIGIN_RANK[was]) {
        const old = { origin: was, triggerId: waiting.triggerMessageId };
        Object.assign(waiting, { triggerMessageId: triggerId, note, origin, ...budget });
        remember(old.origin, old.triggerId);
      } else {
        remember(origin, triggerId);
        Object.assign(waiting, budget);
      }
      if (preserveNote && note) {
        const strip = (value: string) => value.startsWith(REASON) ? value.slice(REASON.length) : value;
        waiting.note = `${REASON}${[waiting.note, note].filter((value): value is string => !!value).map(strip).filter((value, i, all) => all.indexOf(value) === i).join("\n\n")}`;
      }
      const updated = this.store.updateTurn(waiting.id, { triggerMessageId: waiting.triggerMessageId, chainId: waiting.chainId, hop: waiting.hop, origin: waiting.origin });
      if (updated) this.bus.emit({ t: "turn", turn: updated });
      return waiting;
    }
    const turn: Turn = {
      id: newId("t"),
      roomId: room.id,
      memberId: member.id,
      triggerMessageId: triggerId,
      replyMessageId: null,
      hop,
      chainId,
      origin,
      status: "queued",
      error: null,
      usage: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    };
    (turn as QueuedTurn).note = note;
    this.store.insertTurn(turn);
    q.push(turn);
    this.queue.set(room.id, q);
    this.bus.emit({ t: "turn", turn });
    if ((member.status === "idle" || member.status === "error" || member.status === "waiting") && !this.sayHeld(member.id)) this.setMemberStatus(member.id, "queued", null);
    return turn;
  }

  /**
   * With "Keep going while helpers work" off, a turn held for the agent's helpers says so in its status however it got there
   * (Stop everything, an unsend, a usage limit's wait, a refusal), as it does when a reply ends under the hold (memberChanged):
   * the app's bar and its Answer now go by that (sendNow.ts), and "queued" leaves nothing but "Next: @tester". False when
   * nothing holds it that way.
   */
  private sayHeld(memberId: string): boolean {
    const held = !this.flows() && this.heldForSettings(memberId) && this.helpersRunning(memberId) ? this.heldOf(memberId) : null;
    if (held) this.setMemberStatus(memberId, "working", `Finishing helpers before ${heldWords(held.change)}`);
    return !!held;
  }

  private schedule(roomId: string) {
    if (this.shuttingDown) return;
    const room = this.store.getRoom(roomId);
    const q = this.queue.get(roomId) ?? [];
    if (!room) {
      this.queue.delete(roomId);
      return;
    }
    const runningHere = [...this.running.values()].filter((r) => r.turn.roomId === roomId);
    if (!room.parallel) {
      if (runningHere.length || !q.length) return this.checkIdle();
      // What holds one agent's turn (a change it may not answer around, what it owes by itself, a fresh session) holds
      // only that agent's: the next agent's goes, in a group chat, as with parallel work.
      const at = q.findIndex((t) => !this.heldForSettings(t.memberId) && !this.resetting.has(t.memberId));
      if (at < 0) return;
      const [next] = q.splice(at, 1);
      this.queue.set(roomId, q);
      this.applyHeld(next.memberId);
      void this.startTurn(room, next);
      return;
    }
    // Parallel rooms: start every queued turn whose agent isn't already busy. Each leaves the queue before it starts, and
    // the queue is read again after: one refused as it starts (a spending limit, a missing folder) looks at the queue
    // itself, and found still there it started again, writing a refusal each time until the stack ran out.
    for (;;) {
      const waiting = this.queue.get(roomId) ?? [];
      const busy = new Set([...this.running.values()].filter((r) => r.turn.roomId === roomId).map((r) => r.turn.memberId));
      const at = waiting.findIndex((t) => !busy.has(t.memberId) && !this.heldForSettings(t.memberId) && !this.resetting.has(t.memberId));
      if (at < 0) break;
      const [next] = waiting.splice(at, 1);
      this.queue.set(roomId, waiting);
      this.applyHeld(next.memberId);
      void this.startTurn(room, next);
    }
    this.checkIdle();
  }

  private checkIdle() {
    if (this.isBusy()) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }

  // =====================================================================
  // Running a turn
  // =====================================================================

  private getDriver(room: Room, member: Member): AgentDriver {
    let d = this.drivers.get(member.id);
    if (!d) {
      const generation = this.sessionGenerations.get(member.id) ?? 0;
      d = this.deps.createDriver({
        room,
        member,
        session: this.store.getMemberSession(member.id),
        latestSession: () => this.store.getMemberSession(member.id),
        mcp: this.deps.mcpLaunch(member),
        env: this.deps.agentEnv?.(member) ?? {},
        bin: this.deps.resolveBin?.(member.provider) ?? "",
        chat: room.chat ? this.deps.chatContext?.(room, member) ?? { helper: null } : null,
        endpoint: this.deps.endpointFor?.(member) ?? null,
        crossChat: this.deps.crossChat?.(room, member) ?? false,
        modelInfo: this.deps.modelInfo ? (model) => this.deps.modelInfo!(member, model) : undefined,
        knownModel: this.deps.knownModel ? (model) => this.deps.knownModel!(member, model) : undefined,
        onTasks: (tasks) => { if (this.drivers.get(member.id) === d) this.setTasks(room.id, member.id, tasks); },
        onWorkLost: (tasks, scheduled) => { if (this.drivers.get(member.id) === d) this.workLost(room, member, tasks, scheduled); },
        // A process the chat has let go of (replaced, or being ended) never works on by itself: its reply is stopped. One
        // whose account was switched meanwhile is stopped too (ownTurn: the account the person moved away from).
        onOwnTurn: (run, why, owed) => (this.drivers.get(member.id) === d ? this.ownTurn(room.id, member.id, run, why, owed ?? null) : "stop"),
        questionsAnswered: (answers) => { if (this.drivers.get(member.id) === d) this.questionsAnswered(room.id, answers); },
      });
      this.drivers.set(member.id, d);
      this.lastUsed.set(member.id, Date.now());
      this.driverSessionGenerations.set(d, generation);
      this.driverModelGenerations.set(d, this.modelGenerations.get(member.id) ?? 0);
      this.driverMembers.set(d, member);
    }
    return d;
  }

  /**
   * Why a turn is refused before it starts, in plain words with a way out: a chat's folder that's gone (made again when
   * Crosstalk can, with a note), a spending limit that's used up, or a model server of the user's own that isn't running
   * (the model pool), instead of letting the agent fail on a refused connection. Null when it may start.
   */
  private startProblem(room: Room, member: Member): string | null {
    return this.deps.checkFolder?.(room) ?? this.deps.checkBudget?.(room, member) ?? this.deps.checkEndpoint?.(room, member) ?? null;
  }

  private async startTurn(room: Room, queued: Turn) {
    const member = this.store.getMember(queued.memberId);
    if (!member) {
      this.finishTurnRecord(queued, "stopped", "agent removed");
      return this.schedule(room.id);
    }
    const members = this.store.listMembers(room.id);
    const note = (queued as QueuedTurn).note ?? null;
    const had = (queued as QueuedTurn).had ?? 0;

    // Context: everything since this agent's last turn (the newest messages plus every instruction, however busy the
    // room was), and replies that were still being written back then.
    const seen = this.store.getLastSeen(member.id);
    const bySeq = new Map<number, Message & { seq: number }>();
    for (const m of [
      ...this.store.messagesBySeq(room.id, seen.pending),
      ...this.store.instructionsAfter(room.id, seen.seq, member.id),
      ...this.store.messagesAfter(room.id, seen.seq),
    ]) bySeq.set(m.seq, m);
    const fetched = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    const unfetched = this.store.countMessagesAfter(room.id, seen.seq) - fetched.filter((m) => m.seq > seen.seq).length;
    const notesPassed = this.notesPassed.get(member.id) ?? 0;
    const newMessages = fetched.filter((m) => m.seq > notesPassed || !this.forPerson.has(m.id));
    // Answered by a process whose new settings wait for its helpers: the chat says so, under the message and above the
    // reply. Only now, after what this turn reads: it's for the person, and in a group chat's digest it would be the newest
    // thing this agent reads, after the message it's to answer. Once per hold when it went by itself; a tap (answerNow) is
    // said each time, unless the turn is refused (below): then nothing is answering.
    let startProblem: string | null = null;
    if (this.replaceAfterTurn.has(member.id)) {
      if (this.answerAnyway.has(member.id)) {
        startProblem = this.startProblem(room, member);
        if (!startProblem) this.answeringAround(room, member);
      } else this.noteAround(room, member);
    }
    this.answerAnyway.delete(member.id);
    const extra = this.deps.briefing?.(room, member) ?? null;
    const roster = rosterHash(room, members, extra);
    const session = this.store.getMemberSession(member.id);
    const firstTurn = Object.keys(session).length === 0 || seen.seq === 0;
    let prompt: string;
    let systemNote: string | null = null;
    let deferred: (Message & { seq: number })[] = [];
    const notice = this.deps.turnNotice?.() ?? null;
    let handoff = false;
    if (room.chat && !room.chat.group) {
      // A one-agent chat works like the agent's own app: it gets what the human wrote, as written.
      prompt = buildChatPrompt(newMessages, note?.startsWith(REASON) ? note.slice(REASON.length) : note, notice);
      // A duplicated chat's new agent first reads the conversation it was copied from (duplicate.ts), once.
      if (typeof session.handoff === "string" && session.handoff && !Array.isArray(session.handoffWith) && prompt !== COMPACT_COMMAND) {
        systemNote = session.handoff;
        handoff = true;
      }
    } else {
      // A group chat (and a room before them): who's here and how it works, then everyone's new messages, labelled.
      systemNote = firstTurn || seen.rosterVersion !== roster ? buildSystemNote(room, members, member, extra) : null;
      // A duplicated group chat's agent also reads the conversation it was copied from (duplicate.ts), once, after its
      // briefing (which starts its session, so the agents' own apps still know it for a group chat's).
      if (room.chat?.group && typeof session.handoff === "string" && session.handoff && !Array.isArray(session.handoffWith)) {
        systemNote = `${systemNote ?? buildSystemNote(room, members, member, extra)}\n\n${session.handoff}`;
        handoff = true;
      }
      const reason = this.turnReason(room, members, member, queued, note) + (notice ? `\n(${notice})` : "");
      ({ text: prompt, deferred } = buildTurnPrompt({
        room,
        members,
        me: member,
        newMessages,
        reason,
        triggerId: queued.triggerMessageId,
        unfetched,
        fullTextPath: (m) => this.fullTextFile(room, m),
      }));
    }
    // What the agent's last process held for this turn and nobody else had (carryNotes: its helpers' answers, which a
    // Codex app-server keeps only in memory): said first, to the process that never had it. Never into a "/compact".
    const carried = this.carryNotes.get(member.id);
    if (carried && prompt.trim() !== COMPACT_COMMAND) {
      prompt = `${carried}\n\n${prompt}`;
      this.setCarried(member.id, null);
    }
    // Not read yet: another agent's reply that's still being written (an empty placeholder now), and requests that
    // didn't fit in this turn's prompt. Both are delivered next turn; a follow-up turn makes sure there is one.
    const unread = [...new Set([...this.store.streamingSeqs(room.id, member.id), ...deferred.map((m) => m.seq)])];
    this.store.setLastSeen(member.id, this.store.maxSeq(room.id), roster, unread);
    if (deferred.length) {
      this.enqueue(room, member, deferred[0].id, newId("ch"), 0, `${REASON}Continuing: some earlier messages didn't fit in your last turn. They're above; handle any request in them you haven't handled yet.`, "human");
    }

    // Checked (and made again when Crosstalk can) before the reply starts, so a note about it comes first.
    startProblem ??= this.startProblem(room, member);
    const reply = this.insertMessage({
      roomId: room.id,
      authorKind: "agent",
      memberId: member.id,
      authorName: member.handle,
      text: "",
      mentions: [],
      turnId: queued.id,
      status: "streaming",
    });
    const turn = this.store.updateTurn(queued.id, { status: "running", startedAt: Date.now(), replyMessageId: reply.id })!;
    // What this turn reads, noted before anything can fail: other chats' agents follow their messages by it.
    const reads = [...this.takeHandedOver(member.id), ...newMessages];
    this.markRelaysRead(reads, turn.id);
    this.noteAnswered(turn.id, reads, queued.triggerMessageId);
    this.bus.emit({ t: "turn", turn });
    this.setMemberStatus(member.id, "thinking", null);

    let driver: AgentDriver;
    try {
      if (startProblem) throw new Error(startProblem);
      driver = this.getDriver(room, member);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.store.updateMessage(reply.id, { text: startProblem ?? `Couldn't start ${member.handle}: ${err}`, status: "error" });
      this.emitMessage(reply.id);
      this.finishTurnRecord(turn, "error", err);
      // The agent never got the messages: they're the user's again, unread (see finishRunning). Ones it took in from an
      // earlier turn stay read.
      if (room.chat) this.store.setLastSeen(member.id, Math.max(seen.seq, had), seen.rosterVersion, seen.pending);
      this.setMemberStatus(member.id, "error", err);
      this.replyEnded(room.id);
      return this.schedule(room.id);
    }

    const state: Running = {
      turn,
      ...(prompt === COMPACT_COMMAND ? { compact: true } : {}),
      origin: queued.origin ?? "human",
      lastSignalAt: Date.now(),
      seenBefore: { seq: seen.seq, roster: seen.rosterVersion, pending: seen.pending },
      ...(had ? { had } : {}),
      abort: new AbortController(),
      driver,
      replyId: reply.id,
      text: "",
      flushTimer: null,
      textSent: 0,
      textTimer: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null },
      stopping: false,
      steps: new Map(),
    };
    this.running.set(turn.id, state);
    this.lastUsed.set(member.id, Date.now());

    const sink = this.makeSink(room, member, state);
    let result: TurnResult;
    try {
      // What a rewind to each message goes back to before: this turn, except for those the agent took in before (and, in a
      // group chat, requests that didn't fit: they come with a later turn).
      const messageIds = room.chat ? newMessages.filter((m) => m.authorKind === "human" && m.seq > had && !deferred.includes(m)).map((m) => m.id) : undefined;
      if (handoff) state.handoff = messageIds ?? [];
      this.deps.turnStarting?.(room, member);
      const input: TurnInput = { turnId: turn.id, prompt, systemNote, messageIds };
      result = await driver.runTurn(input, sink);
      // Its sign-in stopped working: the agent starts again once, and the reply carries on (staleSignIn).
      if (!result.ok && result.auth) result = await this.staleSignIn(room, member, state, sink, input, result);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.finishRunning(room.id, member, state, result);
  }

  private turnReason(room: Room, members: Member[], me: Member, t: Turn, note: string | null): string {
    const also = [...new Set(((t as QueuedTurn).merged ?? []).map((x) => this.alsoLine(x.origin, x.triggerId)).filter((x): x is string => !!x))];
    const main = this.mainReason(room, members, me, t, note);
    return also.length ? `${main} ${also.join(" ")}` : main;
  }

  /**
   * Saves a message too long for the turn prompt into the room's folder (.crosstalk/messages), so the agent can read
   * all of it. Like uploads, every level must be a real directory inside the project, and the file is created
   * exclusively: a link planted there is never followed.
   */
  private fullTextFile(room: Room, m: Message): string | null {
    try {
      let dir = realpathSync(room.cwd);
      for (const part of [".crosstalk", "messages"]) {
        dir = join(dir, part);
        mkdirSync(dir, { recursive: true });
        const info = lstatSync(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
      }
      const path = join(dir, `${m.id}.md`);
      try {
        writeFileSync(path, m.text, { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(path).isFile()) return null; // saved before, or not ours
      }
      return path;
    } catch (e) {
      log.debug(`couldn't save message ${m.id} for reading: ${e}`);
      return null;
    }
  }

  /** A reminder for a reason merged into another turn of the same agent (see enqueue). */
  private alsoLine(origin: TurnOrigin, triggerId: string | null): string | null {
    if (origin === "human") return "The human also wrote to you above: answer that too.";
    if (origin === "mention") {
      const by = triggerId ? this.store.getMessage(triggerId) : null;
      const who = by?.memberId ? this.store.getMember(by.memberId)?.handle : null;
      return `${who ? `@${who}` : "Another agent"} also asked you something above: answer that too.`;
    }
    return null;
  }

  private mainReason(room: Room, members: Member[], me: Member, t: Turn, note: string | null): string {
    const trig = t.triggerMessageId ? this.store.getMessage(t.triggerMessageId) : null;
    if (note?.startsWith(REASON)) return note.slice(REASON.length);
    if (note) return `It's your turn (${note}). Respond to the conversation above.`;
    if (!trig) return "It's your turn. Respond to the conversation above.";
    if (trig.authorKind === "human") {
      if (room.mode === "lead" && room.leadMemberId === me.id && !trig.mentions.length)
        return "The human's latest message is addressed to you as the lead. Plan the work, delegate with @mentions if useful, and report back.";
      return trig.mentions.includes(me.id)
        ? "The human mentioned you in the latest message. Respond to it."
        : "The human's latest message is for you. Respond to it.";
    }
    const from = members.find((m) => m.id === trig.memberId);
    return from
      ? `@${from.handle} mentioned you and is waiting on you. Do what they asked, then reply (if you already did, say so in one line).`
      : "You were mentioned in the latest message. Respond to it.";
  }

  /** Every call into a turn's sink counts as a sign of life for the stall watchdog. */
  private makeSink(room: Room, member: Member, state: Running): TurnSink {
    const sink = this.buildSink(room, member, state);
    const alive = () => {
      state.lastSignalAt = Date.now();
    };
    for (const key of ["text", "setText", "activity", "updateActivity", "approval", "usage", "rateLimit", "status", "saveSession"] as const) {
      const call = sink[key] as (...args: unknown[]) => unknown;
      (sink as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
        alive();
        // Words from the model: a reply carrying on after a limit got through, and the phone can be told so. A limit
        // that refuses it again writes nothing, so nothing says it carried on when it didn't.
        if (key === "text" || key === "setText") this.carriedThrough(state.turn.id);
        return call(...args);
      };
    }
    sink.heartbeat = alive;
    return sink;
  }

  private buildSink(room: Room, member: Member, state: Running): TurnSink {
    const flush = () => {
      state.flushTimer = null;
      this.store.updateMessage(state.replyId, { text: state.text });
    };
    const scheduleFlush = () => {
      if (!state.flushTimer) state.flushTimer = setTimeout(flush, 400);
    };
    return {
      signal: state.abort.signal,
      text: (delta) => {
        if (!delta || state.stopping) return;
        state.text += delta;
        // Pieces go out together, TEXT_FLUSH_MS apart: a client redraws a few times a second, not on every word.
        if (!state.textTimer) {
          state.textTimer = setTimeout(() => this.flushText(state), TEXT_FLUSH_MS);
          // Writing its reply (when it was thinking or running a step, say). Nothing goes out when it already is.
          this.setMemberStatus(member.id, "working", null);
        }
        scheduleFlush();
      },
      setText: (text) => {
        this.flushText(state);
        state.text = text;
        state.textSent = text.length; // the message event below carries all of it
        flush();
        this.emitMessage(state.replyId);
      },
      newReply: () => {
        if (state.stopping) return;
        this.flushText(state);
        if (state.flushTimer) clearTimeout(state.flushTimer);
        state.flushTimer = null;
        // What was written so far stays above the human's message; the rest of the turn goes in a reply below it.
        this.store.updateMessage(state.replyId, { text: this.finishReply(room, state.text.trim()), status: "done" });
        this.emitMessage(state.replyId);
        const reply = this.insertMessage({ roomId: room.id, authorKind: "agent", memberId: member.id, authorName: member.handle, text: "", mentions: [], turnId: state.turn.id, status: "streaming" });
        state.replyId = reply.id;
        state.text = "";
        state.textSent = 0;
        state.split = true;
        state.steered = undefined; // read now: answered below them
        state.readingNow = false;
        const turn = this.store.updateTurn(state.turn.id, { replyMessageId: reply.id });
        if (turn) this.bus.emit({ t: "turn", turn });
      },
      activity: (a) => {
        const now = Date.now();
        const act: Activity = {
          id: newId("a"),
          roomId: room.id,
          turnId: state.turn.id,
          memberId: member.id,
          kind: a.kind,
          title: a.title,
          detail: capDetail(a.detail ?? ""),
          status: a.status ?? "running",
          createdAt: now,
          updatedAt: now,
        };
        state.steps.set(act.id, { act, sent: act.detail.length, timer: null });
        this.store.upsertActivity(act);
        this.bus.emit({ t: "activity", activity: act });
        this.setMemberStatus(member.id, "working", a.title.slice(0, 120));
        return act.id;
      },
      updateActivity: (id, patch) => {
        const step = state.steps.get(id);
        if (step) this.updateStep(step, patch);
      },
      approval: (req, opts) => this.requestApproval(room, member, state, req, undefined, undefined, opts),
      ask: (title, questions, opts) => this.askQuestions(room, member, state, title, questions, opts),
      askLater: (title, questions) => this.askLater(room, member, state, title, questions),
      usage: (u) => {
        state.usage = {
          inputTokens: u.inputTokens ?? state.usage.inputTokens,
          outputTokens: u.outputTokens ?? state.usage.outputTokens,
          cachedInputTokens: u.cachedInputTokens ?? state.usage.cachedInputTokens,
          costUsd: u.costUsd ?? state.usage.costUsd,
          contextTokens: u.contextTokens ?? state.usage.contextTokens ?? null,
          contextWindow: u.contextWindow ?? state.usage.contextWindow ?? null,
        };
        if (u.costTotalUsd !== undefined) state.ledger = { costTotalUsd: u.costTotalUsd, costFromBaseline: u.costFromBaseline };
      },
      rateLimit: (u) => this.mergeUsage(member, u),
      taken: () => {
        state.taken = true;
      },
      status: (detail, s) => this.setMemberStatus(member.id, s ?? "working", detail),
      saveSession: (patch) => {
        if (this.drivers.get(member.id) !== state.driver || this.driverSessionGenerations.get(state.driver) !== (this.sessionGenerations.get(member.id) ?? 0)) return;
        if (this.driverModelGenerations.get(state.driver) !== (this.modelGenerations.get(member.id) ?? 0)) {
          const { model: ignoredModel, modelRequested: ignoredSelection, effort: ignoredEffort, ...sessionPatch } = patch;
          patch = sessionPatch;
        }
        const cur = this.store.getMemberSession(member.id);
        this.store.setMemberSession(member.id, { ...cur, ...patch });
        if (patch.model !== undefined && patch.model !== cur.model) {
          const updated = this.store.getMember(member.id);
          if (updated) this.bus.emit({ t: "member", member: updated });
        }
      },
    };
  }

  /**
   * A step changed. What it adds to its output goes to clients as a delta ("activity.delta"), in batches STEP_FLUSH_MS
   * apart, and is saved with them; a new title, kind or status goes at once, with what was waiting. A detail that's
   * replaced (or cut back at the size limit) goes out whole, as an "activity" event.
   */
  private updateStep(step: Step, patch: Partial<ActivityInput> & { appendDetail?: string }) {
    const cur = step.act;
    const change: StepChange = {};
    if (patch.title !== undefined && patch.title !== cur.title) change.title = patch.title;
    if (patch.kind !== undefined && patch.kind !== cur.kind) change.kind = patch.kind;
    if (patch.status !== undefined && patch.status !== cur.status) change.status = patch.status;
    let detail = cur.detail;
    let whole = false;
    if (patch.detail !== undefined) {
      detail = patch.detail;
      // A new detail that only adds to what clients have goes as what it adds.
      whole = !(detail.length >= step.sent && detail.startsWith(cur.detail.slice(0, step.sent)));
    } else if (patch.appendDetail) detail = cur.detail + patch.appendDetail;
    if (detail.length > STEP_DETAIL_MAX) {
      detail = capDetail(detail);
      whole = true;
    }
    const changed = Object.keys(change).length > 0;
    if (detail === cur.detail && !changed) return;
    step.act = { ...cur, ...change, detail, updatedAt: Date.now() };
    if (whole) {
      if (step.timer) clearTimeout(step.timer);
      step.timer = null;
      step.sent = detail.length;
      this.store.upsertActivity(step.act);
      this.bus.emit({ t: "activity", activity: step.act });
    } else if (changed) this.flushStep(step, change);
    else if (!step.timer) step.timer = setTimeout(() => this.flushStep(step), STEP_FLUSH_MS);
  }

  /** Sends clients what a reply's text added since it was last sent, as one piece that says where it starts. */
  private flushText(r: Running) {
    if (r.textTimer) clearTimeout(r.textTimer);
    r.textTimer = null;
    if (r.text.length <= r.textSent) return;
    this.bus.emit({ t: "message.delta", messageId: r.replyId, roomId: r.turn.roomId, delta: r.text.slice(r.textSent), offset: r.textSent });
    r.textSent = r.text.length;
  }

  /** Sends (and saves) what a step added since it was last sent, with any change of title, kind or status. */
  private flushStep(step: Step, change: StepChange = {}) {
    if (step.timer) clearTimeout(step.timer);
    step.timer = null;
    const a = step.act;
    if (a.detail.length === step.sent && !Object.keys(change).length) return;
    this.store.upsertActivity(a);
    this.bus.emit({ t: "activity.delta", roomId: a.roomId, turnId: a.turnId, activityId: a.id, offset: step.sent, delta: a.detail.slice(step.sent), ...change, updatedAt: a.updatedAt });
    step.sent = a.detail.length;
  }

  private requestApproval(
    room: Room,
    member: Member,
    state: Running,
    req: { kind: Approval["kind"]; title: string; detail: string; questions?: AgentQuestion[]; always?: string | null },
    onAnswers?: (answers: Record<string, string[]>) => void,
    onCreated?: (approvalId: string) => void,
    opts: { autoResolveMs?: number | null; signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision> {
    if (state.abort.signal.aborted || opts.signal?.aborted) return Promise.resolve("deny");
    state.lastSignalAt = Date.now();
    state.asked = true;
    const approval: Approval = {
      id: newId("ap"),
      roomId: room.id,
      memberId: member.id,
      turnId: state.turn.id,
      kind: req.kind,
      title: req.title,
      detail: req.detail,
      status: "pending",
      decision: null,
      decidedBy: null,
      createdAt: Date.now(),
      decidedAt: null,
      questions: req.questions ?? null,
      answers: null,
      ...(req.always !== undefined ? { always: req.always } : {}),
      // Its time starts once a device shows it (seenApproval).
      ...(opts.autoResolveMs ? { autoResolveMs: opts.autoResolveMs } : {}),
    };
    this.store.insertApproval(approval);
    onCreated?.(approval.id);
    this.bus.emit({ t: "approval", approval });
    this.setMemberStatus(member.id, "approval", (req.kind === "question" ? `Asks: ${req.title}` : req.title).slice(0, 120));
    return new Promise<ApprovalDecision>((resolve) => {
      const pending: PendingApproval = { approval, resolve, turnId: state.turn.id, onAnswers, ...(opts.autoResolveMs ? { autoResolveMs: opts.autoResolveMs } : {}) };
      this.pending.set(approval.id, pending);
      // Ends unanswered: the turn was stopped, the agent settled it some other way (opts.signal), or nobody started
      // answering in the time it had once a device showed it (seenApproval: the agent goes on without an answer).
      const expire = () => {
        if (this.pending.get(approval.id) !== pending) return;
        this.pending.delete(approval.id);
        if (pending.timer) clearTimeout(pending.timer);
        const a = this.store.updateApproval(approval.id, { status: "expired", decidedAt: Date.now() });
        if (a) this.bus.emit({ t: "approval", approval: a });
        this.workingAgain(state);
        resolve("deny");
      };
      pending.expire = expire;
      state.abort.signal.addEventListener("abort", expire, { once: true });
      opts.signal?.addEventListener("abort", expire, { once: true });
    });
  }

  /** A card the turn waited on closed without your answer: the agent works on (its status says so again). */
  private workingAgain(state: Running) {
    if (!this.running.has(state.turn.id) || state.abort.signal.aborted) return;
    if ([...this.pending.values()].some((p) => p.turnId === state.turn.id)) return;
    state.lastSignalAt = Date.now();
    this.setMemberStatus(state.turn.memberId, "working", null);
  }

  private finishRunning(roomId: string, member: Member, state: Running, result: TurnResult) {
    if (this.shuttingDown) return; // a restart: the turn stays unfinished, to be resumed
    if (!this.running.has(state.turn.id)) return; // already finalized (e.g. forced stop)
    this.running.delete(state.turn.id);
    this.lastUsed.set(member.id, Date.now());
    // What Send now (or a message going in by itself) handed this reply and its agent will never read: Crosstalk's own
    // agent's reply failed, was stopped or ran out of steps, Codex's stopped or failed turn dropped it, a Stop took it back out
    // of Claude Code's queue or it went with its process (AgentDriver.takeUnread). Taken out of the driver now, whatever
    // happens next, so no later reply of the same process reads it as well as the one that delivers it again. Given back
    // below (a limit's wait gives everything back).
    const unread = new Set(state.driver.takeUnread?.() ?? []);
    if (state.flushTimer) clearTimeout(state.flushTimer);
    // Text and step output from the last moments go out (and are saved) before the reply's end.
    this.flushText(state);
    for (const step of state.steps.values()) this.flushStep(step);
    // Expire approvals the driver left hanging.
    for (const [id, p] of this.pending) {
      if (p.turnId === state.turn.id) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.resolve("deny");
        const a = this.store.updateApproval(id, { status: "expired", decidedAt: Date.now() });
        if (a) this.bus.emit({ t: "approval", approval: a });
      }
    }

    const stopped = state.stopping || state.abort.signal.aborted;
    // A usage or rate limit stopped it: the reply waits for the reset and carries on by itself instead of failing. Once
    // Crosstalk has waited as long as it will, it fails here, in plain words, with Try again.
    const askedNow = this.carriedOn.get(state.turn.id)?.why === "now";
    const limited = stopped ? null : this.limitWaitFor(roomId, member, state, result, askedNow);
    const where = this.store.getRoom(roomId);
    if (limited && limited.gaveUp === undefined && where) return this.startWait(where, member, state, limited.wait, limited.folded);
    // It got through after all (a reply with no text or steps of its own ends here): the news goes out now. Stopped, or
    // stopped by the limit again, nothing claims it carried on — those paths say what happened themselves.
    if (!limited && !stopped) this.carriedThrough(state.turn.id);
    this.carriedOn.delete(state.turn.id);
    if (limited) {
      result = { ...result, error: limitGaveUpWords(limited.wait, limited.gaveUp ?? 0, this.now()) };
      log.info(`@${member.handle} stopped waiting for ${limited.wait.provider}'s ${limited.wait.label ?? "usage"} limit after ${limited.gaveUp} tries`);
      if (where) this.deps.onLimitWait?.({ kind: "gave-up", room: where, member, wait: limited.wait });
    }
    // After a split, the driver's own final text covers the whole turn, not just this last part.
    let text = (state.split ? state.text : result.text ?? state.text).trim();
    let status: Message["status"] = "done";
    if (stopped) status = "stopped";
    else if (!result.ok) {
      status = "error";
      // Its model server went away under it (the model pool stopped): the chat says that, with a way out, instead of
      // the agent's own connection error. Anything the agent had already written stays, with the note after it. A reply
      // that gave up on a usage limit keeps the limit's own words: that's what happened to it.
      const gone = limited ? null : this.deps.replyFailed?.(member) ?? null;
      if (gone) result = { ...result, error: gone };
      if (gone && text) text = `${text}\n\n⚠️ ${gone}`;
      else if (!text) text = result.error ? `⚠️ ${result.error}` : "⚠️ The agent stopped with an error.";
    }
    if (where) text = this.finishReply(where, text);
    const members = this.store.listMembers(roomId);
    const mentionIds = status === "done" ? this.resolveMentions(text, members, member.id, false) : [];
    this.store.updateMessage(state.replyId, { text, status, mentions: mentionIds });
    this.emitMessage(state.replyId);
    if (state.handoff && (status === "done" || state.taken)) {
      // The agent has the copied conversation now, even from a reply that was stopped or failed after it took it in:
      // it isn't sent again (unless a rewind takes this turn back).
      const s = this.store.getMemberSession(member.id);
      if (typeof s.handoff === "string" && !Array.isArray(s.handoffWith)) this.store.setMemberSession(member.id, { ...s, handoffWith: state.handoff });
    }

    const turn = this.store.updateTurn(state.turn.id, {
      status: stopped ? "stopped" : result.ok ? "done" : "error",
      error: result.ok ? null : result.error ?? null,
      endedAt: Date.now(),
      usage: this.usageOf(state),
      wait: null,
    })!;
    this.recordSpend(where ?? null, member, turn, state);
    // Nothing is still waiting on this chain: the try count starts fresh next time.
    if (result.ok) this.store.kvDelete(`limitWait:${turn.chainId}:${member.id}`);
    // A reply went through on this account: whatever said it was signed out is over (signin.ts).
    if (result.ok && !stopped && where) {
      try {
        this.deps.signIn?.worked(where, member);
      } catch (e) {
        log.warn(`sign-in state for @${member.handle}: ${e instanceof Error ? e.message : e}`);
      }
    }
    const cont = this.continueAfter.get(member.id);
    if (cont !== undefined && status === "done") {
      this.continuationTurns.add(turn.id);
      if (this.continuationTurns.size > 500) this.continuationTurns.delete(this.continuationTurns.values().next().value!);
    }
    this.bus.emit({ t: "turn", turn });
    // Handed to it and never read, by an agent that won't read them by itself (unread, above): the person's again, unread,
    // so Try again, Answer now or their next message brings them along. Such a message, sent while Crosstalk's own agent's
    // request was in flight, used to stay only in its driver when the service refused the model: counted read, and gone
    // with the driver once the person picked another model, as the words told them to. Asked to stop and answer it, it's
    // answered next. (By id: a driver can find one out late, that the reply has split below already.)
    if (unread.size) {
      const back = [...unread].map((id) => this.store.getMessage(id)).filter((m): m is Message => !!m);
      state.steered = state.steered?.filter((m) => !unread.has(m.id));
      if (back.length) {
        this.giveBack(member, back);
        const yours = where?.chat?.group ? back.filter((m) => this.targetsOf(where, members, m).some((x) => x.id === member.id)) : back;
        if (where && state.answerHanded && yours.length) {
          this.enqueue(where, member, yours[yours.length - 1].id, newId("ch"), 0, null);
          this.answerNow(member.id);
        }
      }
    }
    // "Send now" handed it messages as it ended, too late to read them: the agent answers them in its next turn.
    if (status === "done" && state.steered?.length) this.handedOver.set(member.id, { messages: state.steered, at: Date.now() });
    // It failed before the agent got the messages (a Claude Code session open in the Claude app, a CLI that couldn't
    // start): they're the user's again, unread. Take back and Edit just change them, the next message brings them
    // along, and Try again answers them. Chats only: their agents say when they have a message (sink.taken); other
    // agents can't, and one that had it would do the work twice. What it took in from an earlier turn (a Try again
    // that couldn't start, say) stays read: it's in the agent's conversation. In a group chat, only Claude Code and
    // Codex say so: one of the others (a room's Gemini, say) may have had it.
    // Stopped before OpenCode got them is the same: no prompt goes out once it's stopped, and it says when it has one.
    if ((status === "error" || (stopped && member.provider === "opencode")) && !state.taken && !state.redelivered && where?.chat && (!where.chat.group || (CHAT_PROVIDERS as readonly string[]).includes(member.provider))) {
      this.store.setLastSeen(member.id, Math.max(state.seenBefore.seq, state.had ?? 0), state.seenBefore.roster, state.seenBefore.pending);
    }

    const fresh = this.store.getMember(member.id);
    if (fresh) {
      const stillQueued = (this.queue.get(roomId) ?? []).some((t) => t.memberId === member.id);
      if (!result.ok && !stopped) this.setMemberStatus(member.id, "error", result.error ?? null);
      else this.setMemberStatus(member.id, stillQueued ? "queued" : "idle", null);
    }
    this.replyEnded(roomId, stopped);

    // Driver settings may have changed mid-turn.
    const changed =
      fresh &&
      (fresh.model !== member.model || fresh.permissionMode !== member.permissionMode || fresh.role !== member.role || JSON.stringify(fresh.config) !== JSON.stringify(member.config));
    if (changed || this.replaceAfterTurn.has(member.id)) {
      void this.memberChanged(member.id, null);
    }

    if (status === "done" && cont === undefined) {
      const room = this.store.getRoom(roomId);
      if (room?.mode === "review") this.afterReviewRoomTurn(room, member, turn, state.origin, text, mentionIds, this.staleLoopTurns.has(turn.id));
      else if (room) this.relay(room, member, turn, text, mentionIds);
    }
    this.staleLoopTurns.delete(turn.id);
    if (cont !== undefined) {
      this.continueAfter.delete(member.id);
      const room = this.store.getRoom(roomId);
      if (status === "done" && fresh && room && !room.archived) {
        const continuation = this.enqueue(room, fresh, state.turn.triggerMessageId, state.turn.chainId, state.turn.hop, `${REASON}${cont}`, state.origin, true);
        // Another chat waits for the completed work, not the one-line settings-change acknowledgement.
        this.store.db.query("UPDATE xchat_in SET turn_id = ? WHERE turn_id = ?").run(continuation.id, turn.id);
      }
    }
    const after = this.store.getRoom(roomId);
    if (after && fresh) {
      try {
        this.deps.afterTurn?.(after, fresh);
      } catch (e) {
        log.warn(`after-turn work for @${fresh.handle} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.schedule(roomId);
  }

  /** Relay and lead rooms (older modes): an agent's @mentions start the mentioned agents' turns. Off rooms don't hand off. */
  private relay(room: Room, from: Member, turn: Turn, text: string, mentionIds: string[]) {
    if (!mentionIds.length || (room.mode !== "relay" && room.mode !== "lead")) return;
    this.handOff(room, from, turn, mentionIds, this.repeatGuard(room.id, turn, from, text));
  }

  /**
   * Build & review rooms. The builder's work is always reviewed. A reviewer turn only continues the loop when the loop
   * asked for it: when the human asks the reviewer something directly, its reply goes to the human. Explicit @mentions
   * from outside the loop (the reviewer answering the human, or an agent outside the pair) always reach who they name,
   * queued behind that agent's current work if it's busy: a review that's running, or work that won't be reviewed, can't
   * be relied on to pass them on. Loop steps hand off through the loop instead, and a loop step that was already running
   * when the loop paused (`stale`) doesn't continue it or hand off at all.
   */
  private afterReviewRoomTurn(room: Room, from: Member, turn: Turn, origin: TurnOrigin, text: string, mentionIds: string[], stale: boolean) {
    const { builder, reviewer } = reviewPair(room, this.store.listMembers(room.id));
    const loopStep = !stale && !!builder && !!reviewer && (from.id === builder.id || (from.id === reviewer.id && origin === "loop"));
    const fresh = this.repeatGuard(room.id, turn, from, text);
    if (loopStep) this.reviewLoop(room, from, turn, text, fresh);
    const pair = new Set([builder?.id, reviewer?.id]);
    // A stale step hands off to no one, not even outside the pair: an expert it asks could restart the old work.
    const targets = stale ? [] : mentionIds.filter((id) => !pair.has(id) || !loopStep);
    if (targets.length) this.handOff(room, from, turn, targets, fresh);
  }

  /**
   * Loop guard: an agent repeating itself word for word in the same chain is stopped. Checked once per finished turn,
   * however many hand-offs that turn makes (a review and an @mention of a third agent).
   */
  private repeatGuard(roomId: string, turn: Turn, from: Member, text: string): () => boolean {
    let ok: boolean | undefined;
    return () => {
      if (ok !== undefined) return ok;
      const norm = `${from.id}:${text.toLowerCase().replace(/\s+/g, " ").trim()}`;
      const seen = this.chainReplies.get(turn.chainId) ?? new Set<string>();
      ok = !seen.has(norm);
      if (ok) this.chainReplies.set(turn.chainId, seen.add(norm));
      else this.systemMessage(roomId, `Stopped a loop: @${from.handle} repeated the same reply. Reply to continue.`);
      return ok;
    };
  }

  /** Whether the builder is working or waiting, or a review is waiting or running. */
  private loopUnderWay(roomId: string, builderId: string, reviewerId: string | undefined): boolean {
    const busy = (t: Turn) => t.memberId === builderId || (t.memberId === reviewerId && t.origin === "loop");
    return [...this.running.values()].some((r) => r.turn.roomId === roomId && busy(r.turn)) || (this.queue.get(roomId) ?? []).some(busy);
  }

  private handOff(room: Room, from: Member, turn: Turn, mentionIds: string[], fresh: () => boolean) {
    const nextHop = turn.hop + 1;
    const chainId = turn.chainId;
    // In a review room, a builder turn is only worth starting if its work can still be reviewed within the limit.
    const builderId = room.mode === "review" ? reviewPair(room, this.store.listMembers(room.id)).builder?.id : undefined;
    const fits = (id: string) => nextHop + (id === builderId ? 1 : 0) <= room.maxHops;
    if (!mentionIds.every(fits)) {
      if (!this.noticedChains.has(chainId)) {
        this.noticedChains.add(chainId);
        this.systemMessage(room.id, `Hand-off limit reached (${room.maxHops}). Reply to keep the agents going, or raise the limit in room settings.`);
      }
      mentionIds = mentionIds.filter(fits);
      if (!mentionIds.length) return;
    }
    if (!fresh()) return;
    const over = this.overBudget(mentionIds);
    if (over) {
      this.systemMessage(room.id, `Paused hand-offs: ${over}. Reply to continue anyway.`);
      return;
    }
    for (const id of mentionIds) {
      const m = this.store.getMember(id);
      if (m) this.enqueue(room, m, turn.replyMessageId, chainId, nextHop, null, "mention");
    }
  }

  /** Build-and-review rooms: pass the work between builder and reviewer until the reviewer approves. */
  private reviewLoop(room: Room, from: Member, turn: Turn, text: string, fresh: () => boolean) {
    const { builder, reviewer } = reviewPair(room, this.store.listMembers(room.id));
    if (!builder || !reviewer || (from.id !== builder.id && from.id !== reviewer.id)) return;
    // Approval and questions are unquoted lines of their own ("APPROVED: …", optionally bold), outside code examples.
    // Agents sometimes add a sentence before them, and re-running the builder for that would waste a whole round.
    const prose = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
    if (/^[ \t]*(?:\*\*)?QUESTION(?:\*\*)?:/im.test(prose)) {
      // A pending human decision takes priority over approval.
      this.pauseLoop(room, builder, reviewer, from);
      return;
    }
    // Waiting for the human's answer: don't announce an approval or start more loop work from older steps.
    if (this.pausedLoops.has(room.id)) return;
    if (from.id === reviewer.id && /^(?:\*\*)?APPROVED(?:\*\*)?(?:\s*:[^\n]*)?$/im.test(prose.trim())) {
      // Newer loop work is pending (say, the fix for another agent's request, being built or waiting for its review):
      // that review decides, so this approval of older work isn't announced as the end of the loop.
      if (this.loopUnderWay(room.id, builder.id, reviewer.id)) return;
      const rounds = Math.max(1, this.store.countLoopTurns(turn.chainId, reviewer.id));
      this.systemMessage(room.id, `✅ @${reviewer.handle} approved @${builder.handle}'s work after ${rounds} review round${rounds === 1 ? "" : "s"}.`);
      return;
    }
    const nextHop = turn.hop + 1;
    const toReviewer = from.id === builder.id;
    // End on a review: never start a builder turn whose work couldn't be checked within the limit. (Counting this
    // way also works when the chain started with the reviewer, e.g. the human asked it first.)
    if (nextHop + (toReviewer ? 0 : 1) > room.maxHops) {
      if (!this.noticedChains.has(turn.chainId)) {
        this.noticedChains.add(turn.chainId);
        this.systemMessage(room.id, `Review loop paused after ${turn.hop} hand-offs without approval. Reply to keep going, or raise the limit in room settings.`);
      }
      return;
    }
    if (!fresh()) return;
    const next = toReviewer ? reviewer : builder;
    const over = this.overBudget([next.id]);
    if (over) {
      this.systemMessage(room.id, `Paused the review loop: ${over}. Reply to continue anyway.`);
      return;
    }
    this.enqueue(room, next, turn.replyMessageId, turn.chainId, nextHop, this.loopNote(room, next), "loop");
  }

  /** The reason line for the next step of a review loop: a review for the reviewer, fixes for the builder. */
  private loopNote(room: Room, next: Member): string | null {
    const { builder, reviewer } = reviewPair(room, this.store.listMembers(room.id));
    if (!builder || !reviewer) return null;
    return next.id === reviewer.id
      ? `${REASON}@${builder.handle} finished a round of work. Review the actual changes. Reply "APPROVED: <one line>" if nothing must change; otherwise list only the must-fix issues.`
      : `${REASON}@${reviewer.handle} reviewed your work and found issues. Fix them, then reply with a short summary of what changed.`;
  }

  /**
   * A QUESTION for the human pauses the room's loop until the human replies. Loop steps already waiting would carry on
   * without the answer, so they're cancelled; a waiting turn that also holds the human's own request (or an agent's
   * @mention) keeps that request and drops only the loop step.
   */
  private pauseLoop(room: Room, builder: Member, reviewer: Member, from: Member) {
    this.pausedLoops.add(room.id);
    const q = (this.queue.get(room.id) ?? []) as QueuedTurn[];
    const keep: QueuedTurn[] = [];
    for (const t of q) {
      if (t.origin !== "loop" || (t.memberId !== builder.id && t.memberId !== reviewer.id)) {
        keep.push(t);
        continue;
      }
      const rest = [...(t.merged ?? [])].sort((a, b) => ORIGIN_RANK[b.origin] - ORIGIN_RANK[a.origin]);
      const main = rest.shift();
      if (main) {
        Object.assign(t, { origin: main.origin, triggerMessageId: main.triggerId, note: null, merged: rest });
        const updated = this.store.updateTurn(t.id, { origin: t.origin, triggerMessageId: t.triggerMessageId });
        if (updated) this.bus.emit({ t: "turn", turn: updated });
        keep.push(t);
      } else {
        this.finishTurnRecord(t, "stopped", "Paused for the human's answer");
      }
    }
    this.queue.set(room.id, keep);
    // Loop steps already running would finish with findings about the state before the question.
    for (const r of this.running.values()) {
      if (r.turn.roomId === room.id && (r.turn.memberId === builder.id || (r.turn.memberId === reviewer.id && r.origin === "loop"))) this.staleLoopTurns.add(r.turn.id);
    }
    for (const id of [builder.id, reviewer.id]) {
      const busy = keep.some((t) => t.memberId === id) || [...this.running.values()].some((r) => r.turn.memberId === id);
      if (!busy && this.store.getMember(id)?.status === "queued") this.setMemberStatus(id, "idle", null);
    }
    this.systemMessage(room.id, `⏸ The review loop is waiting for your answer to @${from.handle}'s question.`);
  }

  private overBudget(memberIds: string[]): string | null {
    const limit = this.deps.pauseNearLimitPercent?.() ?? null;
    if (limit == null) return null; // off unless turned on in Settings
    const usage = this.store.listUsage();
    for (const id of memberIds) {
      const m = this.store.getMember(id);
      if (!m) continue;
      // Limits are per account: two accounts of the same agent each have their own.
      const account = memberAccount(m);
      const u = usage.find((x) => x.provider === m.provider && (x.accountId ?? "default") === account);
      const w = u?.windows.find((w) => (w.usedPercent ?? 0) >= limit && (!w.resetsAt || w.resetsAt > Date.now()));
      if (w) return `${m.provider}${account !== "default" ? ` (${u?.account ?? account})` : ""} is at ${Math.round(w.usedPercent!)}% of its ${w.label} limit`;
    }
    return null;
  }

  // =====================================================================
  // Waiting for a usage limit to reset ("Carry on when the limit resets")
  // =====================================================================

  /** The reply waiting for a usage limit in this chat (in a group chat, one agent's), or null. */
  limitWaiting(roomId: string, memberId?: string | null): (Turn & { wait: LimitWait }) | null {
    for (const [id, wait] of this.waits) {
      const turn = this.store.getTurn(id);
      if (!turn || turn.status !== "waiting" || turn.roomId !== roomId) continue;
      if (memberId && turn.memberId !== memberId) continue;
      return { ...turn, wait };
    }
    return null;
  }

  /** The reply this agent is waiting with, in whatever chat, or null: a second one would answer the same twice. */
  private waitOf(memberId: string): (Turn & { wait: LimitWait }) | null {
    for (const [id, wait] of this.waits) {
      const turn = this.store.getTurn(id);
      if (turn?.status === "waiting" && turn.memberId === memberId) return { ...turn, wait };
    }
    return null;
  }

  /** The chats waiting on one account's limit, oldest wait first (app.ts groups their notification). */
  limitWaitsOn(provider: string, account: string): { roomId: string; wait: LimitWait }[] {
    const out: { roomId: string; wait: LimitWait }[] = [];
    for (const [id, wait] of this.waits) {
      const turn = this.store.getTurn(id);
      if (turn?.status === "waiting" && wait.provider === provider && wait.account === account) out.push({ roomId: turn.roomId, wait });
    }
    return out.sort((a, b) => a.wait.since - b.wait.since);
  }

  /** "Try now" while a chat waits for a limit: it carries on at once, without waiting for the reset. */
  tryNow(roomId: string, memberId: string | null = null): Turn {
    const waiting = this.limitWaiting(roomId, memberId);
    if (!waiting) throw new HttpError(409, "This chat isn't waiting for a limit any more.", "nothing");
    const member = this.store.getMember(waiting.memberId);
    if (!member) throw new HttpError(404, "That agent isn't in this chat any more.");
    const room = this.mustRoom(roomId);
    const name = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
    if (this.memberBusy(member.id)) throw new HttpError(409, `${name} is working on it already.`, "busy");
    const turn = this.carryOn(waiting, waiting.wait, "now");
    if (!turn) throw new HttpError(409, `${name} can't carry on right now. Send a message to carry on.`, "busy");
    return turn;
  }

  /** "Don't wait": the waiting reply becomes a plain failed reply, with Try again as the way on. */
  dontWait(roomId: string, memberId: string | null = null): Turn {
    const waiting = this.limitWaiting(roomId, memberId);
    if (!waiting) throw new HttpError(409, "This chat isn't waiting for a limit any more.", "nothing");
    return this.stopWaiting(waiting);
  }

  /** A wait the user doesn't want: the reply fails, in plain words, with Try again as the way on. */
  private stopWaiting(waiting: Turn & { wait: LimitWait }): Turn {
    const member = this.store.getMember(waiting.memberId);
    const words = limitDontWaitWords(waiting.wait, this.now());
    const turn = this.endWait(waiting, "error", words, `⚠️ ${words}`) ?? waiting;
    if (member) {
      this.store.kvDelete(`limitWait:${waiting.chainId}:${member.id}`);
      if (!this.memberBusy(member.id)) this.setMemberStatus(member.id, "error", words);
    }
    return turn;
  }

  /**
   * Picks up every reply whose limit has reset. A reset that went by while the hub was down runs at once. Per account,
   * oldest wait first, a couple each round: one account's reset never starts a dozen replies together, and an account's
   * limit never holds up another account's chats.
   */
  checkWaits(): void {
    if (this.shuttingDown) return;
    const now = this.now();
    // Turned off in Settings while chats were waiting: none of them carries on by itself. Each becomes a failed reply
    // with Try again (as Don't wait does), rather than running hours later against the setting, or waiting for ever.
    if (this.deps.carryOnAfterLimit?.() === false) {
      for (const id of [...this.waits.keys()]) {
        const turn = this.store.getTurn(id);
        const wait = this.waits.get(id)!;
        if (!turn || turn.status !== "waiting") this.waits.delete(id);
        else this.stopWaiting({ ...turn, wait });
      }
      return;
    }
    const due: { turn: Turn; wait: LimitWait }[] = [];
    for (const [id, wait] of [...this.waits]) {
      const turn = this.store.getTurn(id);
      // Gone or no longer waiting: a rewind took it back, or the user sent a message, stopped it or said don't wait.
      if (!turn || turn.status !== "waiting") {
        this.waits.delete(id);
        continue;
      }
      if (wait.runAt <= now) due.push({ turn, wait });
    }
    due.sort((a, b) => a.wait.since - b.wait.since || a.turn.createdAt - b.turn.createdAt);
    const started = new Map<string, number>();
    for (const { turn, wait } of due) {
      const key = `${wait.provider}:${wait.account}`;
      const n = started.get(key) ?? 0;
      if (n >= WAKE_AT_ONCE) continue; // this account's other chats follow on the next rounds
      if (this.carryOn(turn, wait, "reset")) started.set(key, n + 1);
    }
  }

  /**
   * Whether a failed reply waits for a limit to reset instead of failing: only when the driver itself says a usage or
   * rate limit ended the turn (limits.ts), never guessed from an error sentence. `gaveUp`: it is a limit, but Crosstalk
   * has waited as long as it will (the try cap, or a reset over a day out), so the reply fails with Try again.
   * `folded`: this agent is already waiting with another reply, which carries this one's messages on too.
   * `askedNow`: the user asked for this try (Try now, Try again), so it doesn't spend the automatic budget.
   */
  private limitWaitFor(roomId: string, member: Member, state: Running, result: TurnResult, askedNow: boolean): { wait: LimitWait; gaveUp?: number; folded?: true } | null {
    const hit = result.limit;
    if (!hit || result.ok) return null;
    if (this.deps.carryOnAfterLimit?.() === false) return null;
    const room = this.store.getRoom(roomId);
    // Chats only: a room's automatic hand-offs have "Pause near usage limits" for this, and no one waits on them.
    if (!room?.chat || room.archived) return null;
    // Already waiting with another reply (a turn that was queued behind it, a message from another chat, Answer now):
    // that wait carries these messages on as well, and a second one would answer them twice over.
    const already = this.waitOf(member.id);
    if (already && already.id !== state.turn.id) return { wait: already.wait, folded: true };
    const now = this.now();
    const key = `limitWait:${state.turn.chainId}:${member.id}`;
    // Kept on the hub, not in memory: a restart in the middle of a wait can't start the count again and loop.
    let past: { tries?: number; since?: number } | null = null;
    try {
      past = JSON.parse(this.store.kvGet(key) ?? "null");
    } catch {
      past = null;
    }
    // Only tries Crosstalk started itself count towards the cap: tapping Try now five times mustn't use up the waiting,
    // and "Crosstalk waited N times" must stay true.
    const tries = Math.max(1, (past?.tries ?? 0) + (askedNow ? 0 : 1));
    const since = past?.since ?? now;
    const wait: LimitWait = {
      provider: member.provider,
      account: memberAccount(member),
      accountLabel: this.deps.accountLabel?.(member) ?? null,
      kind: hit.kind,
      label: hit.label,
      resetsAt: hit.resetsAt,
      runAt: this.waitUntil(hit, tries, now),
      tries,
      since,
      source: hit.source,
    };
    if (tries > MAX_LIMIT_TRIES || wait.runAt - since > MAX_WAIT_MS) {
      this.store.kvDelete(key);
      return { wait, gaveUp: tries - 1 };
    }
    this.store.kvSet(key, JSON.stringify({ tries, since }));
    return { wait };
  }

  /** When to pick a stopped reply back up: just after a known reset, else a backing-off wait. */
  private waitUntil(hit: LimitHit, tries: number, now: number): number {
    if (hit.resetsAt && hit.resetsAt > now) return hit.resetsAt + RESET_MARGIN_MS;
    return now + BACKOFF_MS[Math.min(tries, BACKOFF_MS.length) - 1];
  }

  /**
   * The reply waits instead of failing: its turn becomes "waiting" (kept in the database, so a restart, a deploy or a
   * reboot doesn't lose it), the message it was answering goes back to unread, and the chat, the chat list and the
   * agent's status say in plain words when it carries on. Nothing goes in the queue, so a group chat's other agents
   * carry on as usual.
   */
  private startWait(room: Room, member: Member, state: Running, wait: LimitWait, folded = false) {
    const words = limitWaitWords(wait, this.now());
    // It carried on and was stopped again: that news never goes out (it would say so just before saying it's waiting).
    this.carriedOn.delete(state.turn.id);
    // What the agent had taken in is noted before the messages go back: the carry-on delivers them again, and a rewind
    // to one still goes back to before this try.
    const had = state.taken ? this.store.getLastSeen(member.id).seq : state.had ?? 0;
    // The message stays unanswered (and unread), whether or not the agent had taken it: nothing of the user's is lost.
    this.store.setLastSeen(member.id, state.seenBefore.seq, state.seenBefore.roster, state.seenBefore.pending);
    // Turns already queued for this agent would start straight into the same closed limit: they go, and the wait reads
    // their messages again when it carries on (nothing of the user's is marked read).
    const q = this.queue.get(room.id) ?? [];
    const doomed = q.filter((t) => t.memberId === member.id);
    if (doomed.length) {
      this.queue.set(room.id, q.filter((t) => t.memberId !== member.id));
      for (const t of doomed) this.finishTurnRecord(t, "stopped", null);
    }
    const full: LimitWait = { ...wait, ...(had ? { had } : {}) };
    // Whatever the agent wrote before the limit is kept; with nothing written the words are the reply, so even an older
    // app says why. Not an error reply: no ⚠️, no error notification.
    const text = this.finishReply(room, state.text.trim()) || words;
    this.store.updateMessage(state.replyId, { text, status: "stopped" });
    this.emitMessage(state.replyId);
    if (folded) {
      // The wait that already exists carries these messages on too: this turn just ends, with no second wait, no
      // second notification and no try counted. The wait keeps the later of what either try had delivered.
      const keeper = this.waitOf(member.id);
      if (keeper && had > (keeper.wait.had ?? 0)) {
        const kept: LimitWait = { ...keeper.wait, had };
        this.waits.set(keeper.id, kept);
        const updated = this.store.updateTurn(keeper.id, { wait: kept });
        if (updated) this.bus.emit({ t: "turn", turn: updated });
      }
      const ended = this.store.updateTurn(state.turn.id, { status: "stopped", error: words, endedAt: this.now(), usage: this.usageOf(state) })!;
      this.recordSpend(room, member, ended, state);
      this.bus.emit({ t: "turn", turn: ended });
      // Back to waiting with the words of the wait that stands (this turn made the agent look busy on its way in).
      if (keeper) this.setMemberStatus(member.id, "waiting", keeper.error ?? limitWaitWords(keeper.wait, this.now()), this.waits.get(keeper.id) ?? keeper.wait);
      this.replyEnded(room.id, true);
      log.info(`@${member.handle} in ${room.name} hit its ${wait.label ?? "usage"} limit again; the reply already waiting carries this one on`);
    } else {
      this.waits.set(state.turn.id, full);
      const turn = this.store.updateTurn(state.turn.id, { status: "waiting", error: words, wait: full, usage: this.usageOf(state) })!;
      this.recordSpend(room, member, turn, state);
      this.bus.emit({ t: "turn", turn });
      this.setMemberStatus(member.id, "waiting", words, full);
      this.replyEnded(room.id, true);
      this.deps.onLimitWait?.({ kind: "waiting", room, member, wait: full });
      log.info(`@${member.handle} in ${room.name} hit its ${wait.label ?? "usage"} limit: carrying on ${wait.resetsAt ? `at ${new Date(wait.runAt).toISOString()}` : `in ${duration(wait.runAt - this.now())}`} (try ${wait.tries})`);
    }
    // The agent's process did run: its transcript marker moves on as after any reply, and settings changed meanwhile
    // apply to the turn that carries on (hours later, so never with the old process).
    const fresh = this.store.getMember(member.id);
    const changed = fresh && (fresh.model !== member.model || fresh.permissionMode !== member.permissionMode || fresh.role !== member.role || JSON.stringify(fresh.config) !== JSON.stringify(member.config));
    if (changed || this.replaceAfterTurn.has(member.id)) void this.memberChanged(member.id, null);
    try {
      if (fresh) this.deps.afterTurn?.(room, fresh);
    } catch (e) {
      log.warn(`after-turn work for @${member.handle} failed: ${e instanceof Error ? e.message : e}`);
    }
    this.schedule(room.id);
  }

  /**
   * Runs again exactly what the limit interrupted, the way Try again does: same chat, same agent, same trigger message,
   * with a note that it's carrying on after the limit. Null when it can't just now (the agent is busy: the next round
   * picks it up) or the chat has gone.
   */
  private carryOn(turn: Turn, wait: LimitWait, why: "reset" | "now"): Turn | null {
    const room = this.store.getRoom(turn.roomId);
    const member = this.store.getMember(turn.memberId);
    if (!room || room.archived || !member) {
      this.endWait(turn, "stopped", null);
      return null;
    }
    if (this.memberBusy(member.id) || [...this.running.values()].some((r) => r.turn.memberId === member.id)) return null;
    this.endWait(turn, "stopped", null, limitCarriedOnWords(wait));
    const which = wait.label ? `${wait.label} ` : "";
    // A reply the agent started by itself (its helpers reporting back) answered no message: what it was taking up is in
    // its conversation, above.
    const what = turn.triggerMessageId ? "The messages you were answering are above again: finish what was asked" : "What you were taking up when the limit stopped you (your background work reporting back, say) is above: carry on with it";
    const note = `${REASON}Crosstalk waited for your ${which}usage limit to reset${why === "now" ? ", and the user asked you to carry on now" : ""}. ${what}, continuing from wherever you'd got to.`;
    const again = this.runAgain(room, member, turn, note, turn.chainId, wait.had ?? 0);
    // The news that it carried on waits for the reply's first sign of life (carriedThrough): a window that opens a
    // minute later than the vendor said refuses this try in seconds, and the phone must never be told it carried on
    // when it didn't. A try the user asked for doesn't spend the automatic budget either (limitWaitFor).
    this.carriedOn.set(again.id, { wait, why });
    if (this.carriedOn.size > 100) this.carriedOn.delete(this.carriedOn.keys().next().value!);
    log.info(`@${member.handle} in ${room.name} is carrying on after its ${wait.label ?? "usage"} limit (${why === "now" ? "asked to" : "reset"})`);
    this.schedule(room.id);
    return again;
  }

  /**
   * A reply carrying on after a limit got through (it wrote something, ran a step, or finished): now the phone is told,
   * once. One stopped again by the same limit never gets here — startWait drops it.
   */
  private carriedThrough(turnId: string) {
    const carried = this.carriedOn.get(turnId);
    if (!carried || carried.told) return;
    carried.told = true;
    const turn = this.store.getTurn(turnId);
    const room = turn ? this.store.getRoom(turn.roomId) : null;
    const member = turn ? this.store.getMember(turn.memberId) : null;
    if (room && member) this.deps.onLimitWait?.({ kind: "carried", room, member, wait: carried.wait });
  }

  /**
   * A wait is over. The turn stops waiting and its reply line changes to the past tense (anything the agent itself
   * wrote stays as it is). Returns the turn as it now stands.
   */
  private endWait(turn: Turn, status: Turn["status"], error: string | null, text?: string): Turn | null {
    this.waits.delete(turn.id);
    const reply = turn.replyMessageId ? this.store.getMessage(turn.replyMessageId) : null;
    // Only Crosstalk's own waiting line is rewritten: a partial reply is the agent's words, and stays.
    if (reply && text && reply.text === turn.error) {
      this.store.updateMessage(reply.id, { text, status: status === "error" ? "error" : "stopped" });
      this.emitMessage(reply.id);
    } else if (reply && status === "error" && reply.status !== "error") {
      this.store.updateMessage(reply.id, { status: "error" });
      this.emitMessage(reply.id);
    }
    const updated = this.store.updateTurn(turn.id, { status, error, wait: null, endedAt: this.now() });
    if (updated) this.bus.emit({ t: "turn", turn: updated });
    return updated;
  }

  /**
   * Whose waits a rewind to the message at `seq` takes back: a reply waiting on that message or a later one, one that
   * had it in the agent's conversation, or an agent that read it (so it goes back past it). Everyone else keeps theirs.
   */
  private waitsRewoundBy(roomId: string, seq: number): string[] {
    const out: string[] = [];
    for (const [id, wait] of this.waits) {
      const turn = this.store.getTurn(id);
      if (!turn || turn.status !== "waiting" || turn.roomId !== roomId) continue;
      const from = turn.triggerMessageId ? this.store.messageSeq(turn.triggerMessageId) : 0;
      const read = this.store.getLastSeen(turn.memberId).seq >= seq;
      if (read || (wait.had ?? 0) >= seq || (from > 0 && from >= seq)) out.push(turn.memberId);
    }
    return out;
  }

  /** Waits that end without carrying on: the user sent a message, stopped the chat, or took it back. */
  private cancelWaits(roomId: string, memberIds: string[] | null, why: "message" | "stop" | "rewind") {
    const said = { message: "Was waiting for the limit; your new message is being answered instead.", stop: "Was waiting for the limit, until you stopped it.", rewind: "Was waiting for the limit, until the chat went back." };
    for (const [id, wait] of [...this.waits]) {
      const turn = this.store.getTurn(id);
      if (!turn || turn.roomId !== roomId) continue;
      if (memberIds && !memberIds.includes(turn.memberId)) continue;
      this.endWait(turn, "stopped", null, said[why]);
      this.store.kvDelete(`limitWait:${turn.chainId}:${turn.memberId}`);
      const member = this.store.getMember(turn.memberId);
      if (member?.status === "waiting" && !this.memberBusy(turn.memberId)) this.setMemberStatus(turn.memberId, "idle", null);
      log.info(`a wait for ${wait.provider}'s ${wait.label ?? "usage"} limit ended: ${why === "message" ? "a new message" : "stopped"}`);
    }
  }

  // =====================================================================
  // A sign-in that stopped working (agents/stale-login.ts, signin.ts)
  // =====================================================================

  /**
   * A reply failed because the agent's sign-in stopped working in its process (TurnResult.auth). Claude Code chats can
   * fail this way ("Failed to authenticate: OAuth session expired and could not be refreshed") while the setup checklist
   * still says "signed in": the person would have to notice, and could only fix it at the machine. So, once per reply, the agent's process is replaced, so it reads the sign-in as it is now (another process may
   * have renewed it), and the reply carries on there with a note saying so; what the old process ran in the background
   * is said, not dropped (stoppedWork). What the fresh process is given depends on what the old one got done
   * (staleRetry): the same input when it had done nothing yet, else a note to carry on from where it got to, because
   * the conversation it resumes holds that work and the same request again could do it twice (a push, a message sent).
   * Messages "Send now" handed the old process go with it too, never with the old process. Never twice: when the fresh
   * process fails the same way, the agent's own sign-in check is asked; signed out, every chat and device hears so
   * (SignInHooks.needed) and the reply says how to sign in from the phone. An agent with no sign-in at all, or an
   * account already known to be signed out, is checked first: a fresh process only helps once it's signed in again.
   * Returns the reply's result.
   */
  private async staleSignIn(room: Room, member: Member, state: Running, sink: TurnSink, input: TurnInput, first: TurnResult): Promise<TurnResult> {
    const hooks = this.deps.signIn;
    const hit = first.auth!;
    if (!hooks?.covers(member)) return first;
    const gone = () => state.stopping || state.abort.signal.aborted || this.shuttingDown || this.running.get(state.turn.id) !== state;
    if (gone()) return first;
    const { agent, machine } = hooks.names(member);
    log.info(`@${member.handle} in ${room.name}: ${agent}'s sign-in stopped working (${hit.kind}): ${hit.said}`);
    if (hit.kind === "signedOut" || hooks.isNeeded(member)) {
      const signedIn = await this.askSignIn(member, sink, agent);
      if (gone()) return { ok: false, error: "stopped" };
      if (signedIn === false) return { ok: false, error: hooks.needed(room, member), auth: hit };
    }
    // The old process goes, and with it what it ran in the background (said in the note). What Send now handed it goes
    // to the fresh one instead; until that has it, it's the person's again (giveBack).
    const old = state.driver;
    const lost = this.stoppedWork(member, old);
    const retry = this.staleRetry(state, input);
    const handed = state.steered ?? [];
    state.steered = undefined;
    state.readingNow = false;
    if (handed.length) this.emitLiveTurn(state);
    let delivered = false;
    const giveBack = () => {
      if (!delivered) this.giveBack(member, handed);
    };
    const detail = (handedWords: string | null) => [retry.said, handedWords, lost].filter(Boolean).join(" ");
    const note = sink.activity({ kind: "notice", title: staleSignInWords(agent, machine, "starting"), detail: detail(null), status: "running" });
    // Said once it's known: it carried on, or the reply ended some other way. A sign-in that fails again says so even
    // after the fresh process got going (it can fail mid-reply).
    let settled: "carried" | "failed" | "ended" | null = null;
    const settle = (outcome: "carried" | "failed" | "ended") => {
      if (settled === outcome || (settled && outcome !== "failed")) return;
      settled = outcome;
      sink.updateActivity(note, { title: staleSignInWords(agent, machine, outcome), status: outcome === "failed" ? "error" : "done" });
    };
    if (this.drivers.get(member.id) === old) {
      // What only it holds for the next turn (Codex's helpers' answers) goes to the next turn instead.
      this.keepCarried(member.id, old);
      this.drivers.delete(member.id);
    }
    this.handedOver.delete(member.id); // the process that was to answer it goes
    await old.dispose().catch(() => {});
    if (gone()) {
      settle("ended");
      giveBack();
      return { ok: false, error: "stopped" };
    }
    let fresh: AgentDriver;
    try {
      fresh = this.getDriver(room, member);
    } catch (e) {
      settle("ended");
      giveBack();
      return { ok: false, error: `Couldn't start ${agent} again: ${e instanceof Error ? e.message : e}` };
    }
    log.info(`@${member.handle} in ${room.name}: started ${agent} again so it reads its sign-in afresh${retry.worked ? ", to carry on from where it got to" : ""}${handed.length ? `, with ${handed.length} message(s) Send now had handed it` : ""}`);
    state.driver = fresh;
    state.lastSignalAt = Date.now();
    // The note says it carried on as soon as the fresh process writes or does anything.
    const watched: TurnSink = {
      ...sink,
      text: (delta) => {
        settle("carried");
        sink.text(delta);
      },
      setText: (text) => {
        settle("carried");
        sink.setText(text);
      },
      activity: (a) => {
        settle("carried");
        return sink.activity(a);
      },
    };
    // Send now's messages are read with this input: what the agent writes from here answers them, below them in the chat,
    // as when it reads one mid-reply.
    const next = handed.length ? this.withHanded(room, member, retry.input, handed) : retry.input;
    if (handed.length) {
      sink.updateActivity(note, { detail: detail(handed.length === 1 ? "The message you sent while it worked went to it too." : `The ${handed.length} messages you sent while it worked went to it too.`) });
      sink.newReply?.();
    }
    delivered = true;
    let again: TurnResult;
    try {
      again = await fresh.runTurn(next, watched);
    } catch (e) {
      again = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (again.ok) {
      settle("carried");
      return again;
    }
    if (!again.auth || gone()) {
      settle("ended");
      return again;
    }
    settle("failed");
    log.info(`@${member.handle} in ${room.name}: ${agent}'s sign-in failed again in a fresh process (${again.auth.kind}): checking it`);
    const signedIn = await this.askSignIn(member, sink, agent);
    if (gone()) return { ok: false, error: "stopped" };
    if (signedIn === false) return { ok: false, error: hooks.needed(room, member), auth: again.auth };
    return { ok: false, error: hooks.stillFailing(room, member, again.auth, signedIn), auth: again.auth };
  }

  /**
   * What the agent's fresh process is given after its sign-in went stale, and the note's words for it. The old process
   * may have failed as the reply started (no request left), and then the same input goes again. Or it
   * failed partway, on the API call that needed a renewed sign-in between two steps of a long reply: what it did is in
   * the conversation the fresh process resumes, and the same request again could repeat it (a push, a deploy, a message
   * sent). Then it's told to carry on from where it got to instead, as the stall watchdog does (handleStall).
   */
  private staleRetry(state: Running, input: TurnInput): { input: TurnInput; worked: boolean; said: string } {
    // Anything it wrote, a step of its own (the hub's and the driver's notes aside), or a card it put to you.
    const worked = !!state.split || !!state.text.trim() || !!state.asked || [...state.steps.values()].some((s) => s.act.kind !== "notice");
    if (!worked) {
      // What the first try delivered is in the agent's conversation already (Claude Code keeps the message even though no
      // request left): its messages aren't marked again, so a rewind to one still goes back to before both tries.
      return { input: { ...input, messageIds: state.taken && input.messageIds ? [] : input.messageIds }, worked, said: "It hadn't done anything yet, so it got the same message again." };
    }
    // The conversation it resumes has the request and what it did: no briefing, and no message again.
    const prompt = "(Your reply stopped partway: your sign-in had gone stale, so Crosstalk started you again in this same conversation. Carry on with what was asked from where you got to. What you already did is above: don't do any of it again, such as a command you ran, a change you made or a message you sent.)";
    return {
      input: { turnId: input.turnId, prompt, systemNote: null, messageIds: input.messageIds ? [] : undefined },
      worked,
      said: "It had already done part of the work, so Crosstalk asked it to carry on from where it got to, without doing those steps again.",
    };
  }

  /** `input` with the messages Send now had handed the old process, as Send now words them (sendNowWhy). */
  private withHanded(room: Room, member: Member, input: TurnInput, handed: Message[]): TurnInput {
    const members = room.chat?.group ? this.store.listMembers(room.id) : [];
    const labelled = handed.map((m) => ({ ...m, seq: m.seq ?? this.store.messageSeq(m.id) }));
    const words = room.chat?.group ? buildGroupSteer(labelled, members, member, (m) => this.targetsOf(room, members, m)) : buildChatPrompt(labelled, null);
    return { ...input, prompt: `${input.prompt}\n\n${words}`, ...(input.messageIds ? { messageIds: [...input.messageIds, ...handed.map((m) => m.id)] } : {}) };
  }

  /**
   * Messages Send now handed a process that ended before it read them, and that no other process got: they're the
   * person's again, unread, so the next message or Try again brings them along.
   */
  private giveBack(member: Member, handed: Message[]) {
    const first = Math.min(...handed.map((m) => this.store.messageSeq(m.id) || Number.POSITIVE_INFINITY));
    if (!Number.isFinite(first)) return;
    const seen = this.store.getLastSeen(member.id);
    if (first > seen.seq) return;
    this.store.setLastSeen(member.id, first - 1, seen.rosterVersion, seen.pending);
    this.notesPassed.set(member.id, this.store.maxSeq(member.roomId));
    this.memberRead(member.id);
    log.info(`@${member.handle}: ${handed.length} message(s) Send now had handed a process that ended are unread again`);
  }

  /**
   * Work the agent started by itself (its helpers reported back) failed on its sign-in: there's no message to send again,
   * so nothing is restarted here; the agent's own check decides the words, and the next message starts it again.
   */
  private async staleOwnTurn(room: Room, member: Member, state: Running, sink: TurnSink, result: TurnResult): Promise<TurnResult> {
    const hooks = this.deps.signIn;
    if (!hooks?.covers(member) || state.stopping || state.abort.signal.aborted || this.shuttingDown) return result;
    const { agent } = hooks.names(member);
    const signedIn = await this.askSignIn(member, sink, agent);
    if (signedIn === false) return { ...result, error: hooks.needed(room, member) };
    return { ...result, error: `${agent} couldn't carry on by itself: its sign-in stopped working in this chat. Send a message and Crosstalk starts it again.` };
  }

  /** The agent's own sign-in check (the setup checklist's), with the reply's status saying so meanwhile. */
  private async askSignIn(member: Member, sink: TurnSink, agent: string): Promise<boolean | null> {
    sink.status(`Checking ${agent}'s sign-in`, "thinking");
    try {
      return await this.deps.signIn!.check(member);
    } catch (e) {
      log.warn(`checking @${member.handle}'s sign-in: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * What the agent's process was running in the background as it's replaced: its helpers, workflows and commands end with
   * it (they stay listed, as stopped, for half an hour), and prompts it scheduled for later in it are gone. In words for
   * the chat; null when there was nothing.
   */
  private stoppedWork(member: Member, driver: AgentDriver): string | null {
    const cur = this.tasks.get(member.id);
    const running = cur?.tasks.filter((t) => t.status === "running") ?? [];
    let scheduled = 0;
    try {
      scheduled = driver.scheduledPrompts?.() ?? 0;
    } catch {
      scheduled = 0;
    }
    if (cur && running.length) {
      const now = Date.now();
      const ended = cur.tasks.map((t): BackgroundTask => (t.status === "running" ? { ...t, status: "stopped", endedAt: now, error: "Stopped when Crosstalk started the agent again: its sign-in had gone stale." } : t));
      this.setTasks(cur.roomId, member.id, ended);
      const roomId = cur.roomId;
      setTimeout(() => {
        if (this.tasks.get(member.id)?.tasks === ended) this.setTasks(roomId, member.id, []);
      }, 30 * 60_000).unref?.();
    }
    const said = lostWords(running, scheduled);
    if (said) log.info(`@${member.handle}: replacing its process stopped ${running.length} background task(s) and ${scheduled} scheduled prompt(s)`);
    return said;
  }

  /**
   * The agent's process went by itself while the chat goes on (it crashed, or didn't stop in time), with what it ran in the
   * background (DriverContext.onWorkLost): the helpers are listed as stopped by now, and the chat says what was lost.
   */
  private workLost(room: Room, member: Member, tasks: BackgroundTask[], scheduled: number) {
    const said = lostWords(tasks, scheduled);
    if (!said) return;
    log.info(`@${member.handle} in ${room.name}: its process ended, with ${tasks.length} background task(s) and ${scheduled} scheduled prompt(s)`);
    const name = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
    this.systemMessage(room.id, `${name}'s process ended. ${said}`);
  }

  /**
   * The sign-in of these members' accounts was renewed (signin.ts): each of their agent processes that's doing nothing
   * right now is ended, so the next message starts one that reads the new sign-in at once. One that's working, waits on
   * an approval, runs helpers, owes a turn of its own (a helper's report, a message handed to its last reply), holds a
   * scheduled prompt or is open in another app is left alone: running processes pick a new sign-in up by themselves
   * within a minute or so. Returns how many were ended.
   */
  renewIdle(which: (member: Member) => boolean): number {
    if (this.shuttingDown) return 0;
    let ended = 0;
    for (const [memberId, d] of [...this.drivers]) {
      const m = this.store.getMember(memberId);
      if (!m || !which(m) || !d.canEndWhenIdle) continue;
      if (this.memberBusy(memberId) || this.replaceAfterTurn.has(memberId) || this.continueAfter.has(memberId)) continue;
      if ([...this.running.values()].some((r) => r.turn.memberId === memberId)) continue;
      if (this.tasks.get(memberId)?.tasks.some((t) => t.status === "running")) continue;
      if ([...this.pending.values()].some((p) => p.approval.memberId === memberId)) continue;
      // About to answer something by itself (owedTurn), or a message handed to its last reply: only it can.
      const handed = this.handedOver.get(memberId);
      if (this.owedTurn(memberId) || (handed && Date.now() - handed.at < HANDED_OVER_MS)) continue;
      if (!d.canEndWhenIdle()) continue;
      this.keepCarried(memberId, d);
      this.drivers.delete(memberId);
      this.handedOver.delete(memberId);
      this.clearTasks(memberId);
      void d.dispose().catch(() => {});
      ended++;
    }
    if (ended) log.info(`ended ${ended} idle agent process(es) so their next message reads the renewed sign-in`);
    return ended;
  }

  /**
   * An agent CLI can freeze mid-turn (seen with Claude Code: no CPU, no network, ignoring Stop's signals). A turn that
   * shows no sign of life for `stallMs`, with no approval waiting on the human, is ended, the agent's process is
   * replaced, and the agent is asked once to continue where it left off (its session is kept).
   */
  private checkStalls(stallMs: number) {
    const now = Date.now();
    // The turns running now: a retry started below isn't checked in the same pass.
    for (const r of [...this.running.values()]) {
      if (r.stopping || now - r.lastSignalAt < stallMs) continue;
      if ([...this.pending.values()].some((p) => p.turnId === r.turn.id)) continue; // waiting for the human, not frozen
      this.handleStall(r, stallMs);
    }
  }

  private handleStall(r: Running, stallMs: number) {
    const room = this.store.getRoom(r.turn.roomId);
    const member = this.store.getMember(r.turn.memberId);
    if (!room || !member) return;
    const silent = duration(stallMs);
    const key = `${r.turn.chainId}:${member.id}`;
    const retry = !this.stallRetried.has(key);
    // The step it froze on: the newest one still running (usually a command that never ended), and how long it ran.
    const stuck = [...r.steps.values()].map((s) => s.act).filter((a) => a.status === "running" && a.kind !== "thinking").pop() ?? [...r.steps.values()].map((s) => s.act).filter((a) => a.status === "running").pop() ?? null;
    const step = stuck ? stepName(stuck) : null;
    const ran = stuck ? duration(Date.now() - stuck.createdAt) : silent;
    const command = stuck?.kind === "command";
    log.info(`@${member.handle} in ${room.name} showed no sign of life for ${silent}${step ? ` (on ${step}, running ${ran})` : ""}: replacing its process${retry ? " and retrying" : ""}`);
    // Queue the retry first, so the room never looks idle in between. It gets the same messages again (and a fresh
    // briefing): the new process may not have the old session, if it froze before saving one.
    if (retry) {
      this.stallRetried.add(key);
      // What it took in is in its session (kept): a rewind to those messages still goes back to before this turn.
      const had = r.taken ? this.store.getLastSeen(member.id).seq : (r.had ?? 0);
      this.store.setLastSeen(member.id, r.seenBefore.seq, 0, r.seenBefore.pending);
      r.redelivered = true;
      const how = command ? " Don't run that command the same way again: if it waits for input or never ends by itself, run it in the background or with a time limit, or ask the user to run it." : "";
      const again = this.enqueue(room, member, r.turn.triggerMessageId, r.turn.chainId, r.turn.hop, `${REASON}Your last turn stopped responding${step ? ` while on ${step} (running ${ran})` : ""}, so Crosstalk restarted you. The messages it was answering are above again: finish what was asked, continuing from wherever you'd got to.${how}`, r.origin);
      this.redelivers(again, had);
    }
    // The process may be frozen: drop the driver so the next turn starts a fresh one, resuming the session. It's let go
    // before that turn starts (finishRunning starts it): letting go deletes files the new one writes again under the
    // same name (Claude Code's MCP config).
    if (this.drivers.get(member.id) === r.driver) {
      // What only it holds for the next turn (Codex's helpers' answers) goes to the next turn instead.
      this.keepCarried(member.id, r.driver);
      this.drivers.delete(member.id);
      this.clearTasks(member.id);
    }
    void r.driver.dispose().catch(() => {});
    // Nothing reports the steps it was on any more: they end here.
    for (const s of r.steps.values()) if (s.act.status === "running") this.updateStep(s, { status: "error" });
    const who = `@${member.handle}`;
    let error: string;
    if (retry) error = step ? `${who} got stuck on ${step} for ${ran}, so Crosstalk restarted it and asked it to continue.` : `${who} stopped responding for ${silent}, so Crosstalk restarted it and asked it to continue.`;
    else if (command) error = `${who} froze again after Crosstalk restarted it, stuck on ${step} for ${ran}, so Crosstalk stopped it. That command may be waiting for input or never finish by itself: ask for it to run in the background or with a time limit, or run it yourself in Terminal, then send a message to carry on.`;
    else error = `${who} froze again after Crosstalk restarted it${step ? `, stuck on ${step} for ${ran}` : ` (no sign of life for ${silent})`}, so Crosstalk stopped it. Send a message to try again. If it keeps freezing, start a fresh session in the chat's settings.`;
    this.finishRunning(room.id, member, r, { ok: false, error });
    r.abort.abort();
  }

  /**
   * Every agent process stays alive between turns, so its next reply starts at once, but each holds a few hundred MB:
   * one with nothing to do for `idleMs` is ended, and its next message starts a fresh one that resumes the session.
   * Never while it works by itself (background helpers or commands), owes a turn of its own (owedTurn), waits on an
   * approval, or holds a message handed to its last reply; the driver can also refuse (a Claude Code session that's open
   * in the Claude app too).
   */
  private endIdle(idleMs: number) {
    if (this.shuttingDown) return;
    const now = Date.now();
    for (const [memberId, d] of [...this.drivers]) {
      const idleFor = now - (this.lastUsed.get(memberId) ?? 0);
      if (idleFor < idleMs || !d.canEndWhenIdle) continue;
      if (this.memberBusy(memberId) || this.replaceAfterTurn.has(memberId) || this.continueAfter.has(memberId)) continue;
      if (this.tasks.get(memberId)?.tasks.some((t) => t.status === "running")) continue;
      if ([...this.pending.values()].some((p) => p.approval.memberId === memberId)) continue;
      const handed = this.handedOver.get(memberId);
      if (handed && now - handed.at < HANDED_OVER_MS) continue;
      if (this.owedTurn(memberId)) continue;
      if (!d.canEndWhenIdle()) continue;
      // What only it holds for the next turn (Codex's helpers' answers) is said to the process that takes over.
      this.keepCarried(memberId, d);
      this.drivers.delete(memberId);
      this.lastUsed.delete(memberId);
      this.handedOver.delete(memberId);
      this.clearTasks(memberId);
      const m = this.store.getMember(memberId);
      log.info(`ended ${m ? `@${m.handle}'s` : "an"} agent process after ${duration(idleFor)} with nothing to do: its next message resumes the session`);
      void d.dispose().catch(() => {});
    }
  }

  private async stopRunning(r: Running) {
    if (r.stopping) return;
    r.stopping = true;
    r.abort.abort();
    const graceful = r.driver.interrupt().catch(() => {});
    // Give the agent a moment to wind down, then finalize regardless.
    await Promise.race([graceful, Bun.sleep(4000)]);
    const member = this.store.getMember(r.turn.memberId);
    if (this.running.has(r.turn.id) && member) {
      this.finishRunning(r.turn.roomId, member, r, { ok: false, error: "stopped" });
    }
  }

  /** A reply's usage, when it used anything: saved with the turn and handed to the spend ledger. */
  private usageOf(state: Running): TurnUsage | null {
    return state.usage.inputTokens || state.usage.outputTokens || state.usage.costUsd ? state.usage : null;
  }

  /** What a reply cost goes in the ledger (spend.ts), even when the reply failed or is waiting for a limit. */
  private recordSpend(room: Room | null, member: Member, turn: Turn, state: Running) {
    if (!room || !this.usageOf(state)) return;
    try {
      // Booked on the model and account its process ran with: a reply while new settings wait for the process to be
      // replaced (Claude Code's own replies as its helpers report back, messages sent while they work) still runs on the old ones.
      const ran = this.driverMembers.get(state.driver);
      this.deps.recordUsage?.(room, ran ? { ...member, model: ran.model, config: ran.config } : member, turn, { ...state.usage, ...state.ledger });
    } catch (e) {
      log.warn(`spend ledger: ${e instanceof Error ? e.message : e}`);
    }
  }

  private finishTurnRecord(t: Turn, status: Turn["status"], error: string | null) {
    const turn = this.store.updateTurn(t.id, { status, error, endedAt: Date.now() });
    if (turn) this.bus.emit({ t: "turn", turn });
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  private mergeUsage(member: Member, u: Partial<UsageSnapshot>) {
    const accountId = memberAccount(member);
    const cur = this.store.getUsage(member.provider, accountId);
    const next: UsageSnapshot = {
      provider: member.provider,
      accountId,
      account: u.account ?? cur?.account ?? null,
      plan: u.plan ?? cur?.plan ?? null,
      windows: u.windows ? mergeWindows(cur?.windows ?? [], u.windows) : cur?.windows ?? [],
      credits: u.credits ?? cur?.credits ?? null,
      note: u.note ?? cur?.note ?? null,
      updatedAt: Date.now(),
    };
    this.store.setUsage(next);
    this.bus.emit({ t: "usage", usage: next });
  }

  /**
   * A member's status, for every device. Nothing is written or sent when it's what clients already have (a streaming
   * reply asks for "working" with every batch of text); a change in what the agent has read (Member.readSeq) is sent.
   */
  /** `wait`: the usage limit it waits for ("waiting"), so its chats can say when it comes back in their own clock. */
  private setMemberStatus(memberId: string, status: Member["status"], detail: string | null, wait: LimitWait | null = null) {
    const cur = this.store.getMember(memberId);
    if (!cur) return;
    // What waits for its process to be replaced goes with every status (Member.held).
    const held = this.heldOf(memberId);
    const same = cur.status === status && cur.statusDetail === detail && JSON.stringify(cur.wait ?? null) === JSON.stringify(wait) && JSON.stringify(cur.held ?? null) === JSON.stringify(held);
    const told = `${status}\u0000${detail ?? ""}\u0000${cur.readSeq ?? 0}`;
    if (same && this.told.get(memberId) === told) return;
    const m = same ? cur : this.store.updateMember(memberId, { status, statusDetail: detail, wait, held });
    if (!m) return;
    this.told.set(memberId, told);
    this.bus.emit({ t: "member", member: m });
  }

  /** What a member has read changed (and nothing else): every device hears it, for the "Not answered" mark. */
  private memberRead(memberId: string) {
    const m = this.store.getMember(memberId);
    if (m) this.setMemberStatus(memberId, m.status, m.statusDetail, m.wait ?? null);
  }

  private emitRoom(roomId: string) {
    const room = this.store.getRoom(roomId);
    if (room) this.bus.emit({ t: "room", room });
  }

  /**
   * A reply ended: every device's list moves the chat up, and (unless it was stopped) knows there's a new reply. One
   * time for both, so the room never says its last reply came after its last change.
   */
  private replyEnded(roomId: string, stopped = false) {
    const at = Date.now();
    this.store.touchRoom(roomId, at);
    if (!stopped) this.store.noteReply(roomId, at);
    this.emitRoom(roomId);
  }

  private insertMessage(m: Omit<Message, "id" | "createdAt" | "updatedAt">): Message & { seq: number } {
    const now = Date.now();
    const msg: Message = { ...m, id: newId("m"), createdAt: now, updatedAt: now };
    const saved = { ...msg, seq: this.store.insertMessage(msg) };
    this.store.touchRoom(m.roomId);
    this.bus.emit({ t: "message", message: saved });
    return saved;
  }

  private emitMessage(id: string) {
    const m = this.store.getMessage(id);
    if (m) this.bus.emit({ t: "message", message: m });
  }

  private mustRoom(id: string): Room {
    const r = this.store.getRoom(id);
    if (!r) throw new HttpError(404, "room not found");
    return r;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** A machine-readable reason, for callers that act on it (other machines' hubs). */
    public code?: string,
  ) {
    super(message);
  }
}

const TRIMMED = "…(earlier output trimmed)\n";

/** A step's detail kept to STEP_DETAIL_MAX: cut well under it, so what comes next is added to it for a while. */
function capDetail(s: string): string {
  if (s.length <= STEP_DETAIL_MAX) return s;
  const body = s.startsWith(TRIMMED) ? s.slice(TRIMMED.length) : s;
  return TRIMMED + body.slice(body.length - STEP_DETAIL_KEEP);
}

/**
 * A step as newer clients get it in history and in "activity" events: a finished step's long detail is cut to its
 * start, with its whole length in detailLength (the app fetches the rest when the step is opened). Steps still running
 * stay whole, since their output keeps coming as deltas.
 */
export function previewActivity(a: Activity, running = a.status === "running"): Activity {
  if (running || a.detail.length <= DETAIL_PREVIEW_OVER) return a;
  // Never half an emoji (a surrogate pair) at the cut.
  const cut = /[\ud800-\udbff]/.test(a.detail[DETAIL_PREVIEW - 1]) ? DETAIL_PREVIEW - 1 : DETAIL_PREVIEW;
  return { ...a, detail: a.detail.slice(0, cut), detailLength: a.detail.length };
}

/** How long something took, in words: "1 minute", "16 minutes", "2 hours". */
function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 120) return `${min} minute${min === 1 ? "" : "s"}`;
  return `${Math.round(min / 60)} hours`;
}

/** A background task in words for the chat: 'the helper "Check the build"', 'the command "npm test"'. */
function taskWords(t: BackgroundTask): string {
  const name = `"${t.description.replace(/\s+/g, " ").trim().slice(0, 60) || "background task"}"`;
  if (t.kind === "local_agent") return `the helper ${name}`;
  if (t.kind === "local_workflow") return `the workflow ${name}`;
  if (t.kind === "local_bash") return `the command ${name}`;
  return name;
}

/** "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What went with an agent's process, in words for the chat; null when there was nothing. */
function lostWords(running: BackgroundTask[], scheduled: number): string | null {
  const parts: string[] = [];
  if (running.length) {
    const one = running.length === 1;
    const names = running.slice(0, 3).map(taskWords);
    const more = running.length > 3 ? ` and ${running.length - 3} more` : "";
    parts.push(`It was running ${listWords(names)}${more} in the background. ${one ? "That" : "Those"} ended with the old process, so what ${one ? "it was" : "they were"} doing is lost: ask again if you still need ${one ? "it" : "them"}.`);
  }
  if (scheduled > 0) parts.push(`${scheduled === 1 ? "The prompt" : `The ${scheduled} prompts`} it had scheduled for later in that process ${scheduled === 1 ? "is" : "are"} gone too.`);
  return parts.length ? parts.join(" ") : null;
}

/** A step named for a message: a command as code (`npm test`), anything else by its title in quotes. */
function stepName(a: Activity): string {
  const t = a.title.replace(/\s+/g, " ").trim();
  const short = t.length > 80 ? `${t.slice(0, 79)}…` : t;
  return a.kind === "command" ? `\`${short.replace(/`/g, "'")}\`` : `"${short}"`;
}

export function memberLog(m: Member) {
  return `${m.handle}/${m.provider}`;
}

/** How much a permission setting lets through: Ask first is the least, Full access the most. */
const permissionRank = (mode: Member["permissionMode"]) => PERMISSION_MODES.findIndex((p) => p.id === mode);

/**
 * What changed in a member's own settings since its process started with `was` (Engine.changesSince), as a hold names it.
 * Its name, role and place in the list aren't the process's (a group chat's briefing carries them). A new model, effort,
 * fast mode or looser permissions the process may answer around ("settings"); another account, tighter permissions or
 * anything else in its config (a helper model, a copy to continue in…) it may not.
 */
export function settingsChanges(was: Member, now: Member): HeldChange[] {
  const out = new Set<HeldChange>();
  if (memberAccount(now) !== memberAccount(was)) out.add("account");
  if (now.permissionMode !== was.permissionMode) out.add(permissionRank(now.permissionMode) < permissionRank(was.permissionMode) ? "permissions" : "settings");
  if ((now.model || null) !== (was.model || null)) out.add("settings");
  const a = was.config ?? {};
  const b = now.config ?? {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "account" || JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    out.add(key === "effort" || key === "fast" ? "settings" : "other");
  }
  return [...out];
}

void log;

/**
 * Live limit updates from a turn often carry only a reset time (Claude's rate_limit_event has no percentage), so they
 * update windows by name instead of replacing the list: a measured percentage stays until its window has reset.
 */
export function mergeWindows(cur: UsageWindow[], incoming: UsageWindow[], now = Date.now()): UsageWindow[] {
  const out = cur.map((w) => ({ ...w }));
  for (const w of incoming) {
    const old = out.find((o) => o.label === w.label);
    if (!old) {
      out.push({ ...w });
      continue;
    }
    const stale = old.resetsAt !== null && old.resetsAt <= now;
    old.usedPercent = w.usedPercent ?? (stale ? null : old.usedPercent);
    old.resetsAt = w.resetsAt ?? old.resetsAt;
  }
  return out;
}

/** Keeps answers to the questions that were asked: picked options or your own text, a few kilobytes at most. */
function cleanAnswers(a: Approval, raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const q of a.questions ?? []) {
    const v = (raw as Record<string, unknown>)[q.id];
    const list = (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 4000)).filter(Boolean);
    if (list.length) out[q.id] = q.multiSelect ? list.slice(0, q.options.length + 1) : list.slice(0, 1);
  }
  return out;
}
