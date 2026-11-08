import type { LimitHit } from "./limits";
import { serviceDefaultCompact } from "@crosstalk/shared";
import type { AuthHit } from "./stale-login";
import type {
  ActivityKind,
  ApprovalDecision,
  AgentQuestion,
  ApprovalKind,
  BackgroundTask,
  Member,
  ModelOption,
  PermissionMode,
  Provider,
  Room,
  TurnUsage,
  UsageSnapshot,
} from "@crosstalk/shared";

/** What the engine hands a driver for one turn. */
export interface TurnInput {
  turnId: string;
  /** Fully formatted prompt: room digest since this agent's last turn plus the trigger. */
  prompt: string;
  /** Set on the first turn of a session (or after the roster changed). */
  systemNote: string | null;
  /** The human's messages this turn delivers (a chat's), so they can be rewound to later. */
  messageIds?: string[];
}

export interface ActivityInput {
  kind: ActivityKind;
  title: string;
  detail?: string;
  status?: "running" | "done" | "error";
}

export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  detail: string;
  /** What "Always allow" allows, in words (Approval.always); null when it can only be allowed once. */
  always?: string | null;
}

/**
 * What a driver may report about a reply's cost besides `TurnUsage`, for the spend ledger (spend.ts). Claude Code reports a
 * running total per process, so its driver gives the raw total and whether the reply had a total before it to difference from.
 */
export interface LedgerFigures {
  costTotalUsd?: number | null;
  costFromBaseline?: boolean;
}

/** Callbacks a driver uses to stream a turn back into the room. */
export interface TurnSink {
  /** Append streamed reply text. */
  text(delta: string): void;
  /** Replace the whole reply text (when an agent only reports final text). */
  setText(text: string): void;
  activity(a: ActivityInput): string;
  updateActivity(id: string, patch: Partial<ActivityInput> & { appendDetail?: string }): void;
  /**
   * Ask the human. Resolves when someone decides (or the turn is stopped -> "deny"). `signal`: the agent settled the
   * request some other way (answered in another app, say): the card closes ("deny").
   */
  approval(req: ApprovalRequest, opts?: { signal?: AbortSignal }): Promise<ApprovalDecision>;
  /**
   * The agent has just read a message the human sent mid-reply ("Send now"): what it writes from here goes in a new
   * reply below that message, so it never looks like it answered before being asked.
   */
  newReply?(): void;
  /**
   * Ask the human questions; resolves with answers by question id, or null when they're skipped or the turn ends.
   * `autoResolveMs`: the agent goes on without an answer this long after a device shows the card (null: it waits),
   * unless the human starts answering first; `signal`: the question was settled elsewhere (answered in another app,
   * say), and its card closes.
   */
  ask?(title: string, questions: AgentQuestion[], opts?: { autoResolveMs?: number | null; signal?: AbortSignal }): Promise<Record<string, string[]> | null>;
  /**
   * The agent asked questions and went on without waiting (Codex's request_user_input_async): a card that stays until
   * it's answered, whose answer goes to the agent as a message (the engine sends Codex's reply envelope,
   * codexQuestionReply, with each question's id as its questionItemId). Codex's driver asks each question on a card of
   * its own (DriverContext.questionsAnswered closes them when they're answered in another app).
   */
  askLater?(title: string, questions: AgentQuestion[]): void;
  usage(u: Partial<TurnUsage> & LedgerFigures): void;
  /** Report plan/rate-limit info observed during the turn. */
  rateLimit(u: Partial<UsageSnapshot>): void;
  status(detail: string | null, state?: "thinking" | "working"): void;
  /** Persist provider session identifiers (Claude session id, Codex thread id, ...). */
  saveSession(patch: Record<string, unknown>): void;
  /** The agent is alive but has nothing to show (e.g. a keep-alive): resets the engine's stall watchdog. */
  heartbeat?(): void;
  /**
   * The agent has the turn's message in its conversation now (it's working on it): a turn that's stopped or fails after
   * this still gave it the message, so what went with it once (a duplicated chat's note) isn't sent again.
   */
  taken?(): void;
  readonly signal: AbortSignal;
}

export interface TurnResult {
  ok: boolean;
  error?: string;
  /** Final reply text; if omitted, the streamed text is used. */
  text?: string;
  /**
   * Set only when a usage or rate limit that will reset ended the turn (limits.ts): the engine then waits for the reset
   * and carries on, instead of leaving a failed reply. Never guessed from the error text by the engine: a driver that
   * can't tell leaves it unset, and the turn fails as before.
   */
  limit?: LimitHit | null;
  /**
   * Set only when the agent's sign-in, not the request, ended the turn (stale-login.ts, per driver from the agent's own
   * typed signals). The engine starts the agent's process again once, so it reads the sign-in as it is now, and carries
   * on in the same reply; a second time it asks the agent's own sign-in check and says what to do. Never guessed by the
   * engine from an error sentence.
   */
  auth?: AuthHit | null;
}

export interface DriverContext {
  room: Room;
  member: Member;
  session: Record<string, unknown>;
  /** The member's saved session as it is now (`session` is as it was when the driver started). */
  latestSession?: () => Record<string, unknown>;
  /** Command line the agent can use to reach the room's MCP server (room_post, approvals). */
  mcp: McpLaunch;
  env: Record<string, string>;
  /** Absolute path of the agent's CLI on the hub ("" when not installed). */
  bin: string;
  /**
   * Set for a one-agent chat: the agent gets the human's messages as they are, with no group-chat briefing and no
   * room tools.
   */
  /** The agent's background work (helpers it summoned, workflows) changed; called whether or not a turn is running. */
  onTasks?: (tasks: BackgroundTask[]) => void;
  /**
   * The agent's process went while the chat goes on (it crashed, or didn't stop in time), and with it what it ran in the
   * background, now reported as stopped, and how many prompts it had scheduled for later: the chat says what was lost.
   */
  onWorkLost?: (tasks: BackgroundTask[], scheduled: number) => void;
  /**
   * The agent started working by itself, between turns (its background helpers reported back, say). `run` gets a sink
   * and resolves when that work ends; the engine shows it as a reply. `owed`: what it's taking up, when it owed a turn
   * (owedTurn). Returns false when it can't be shown now, and "stop" when it mustn't run on this process at all (settings
   * it may not answer on wait for it, or the chat has let the process go): the driver stops it before it can write or do
   * anything, shows nothing of it, and still counts it as owed until it has stopped.
   */
  onOwnTurn?: (run: (sink: TurnSink) => Promise<TurnResult>, why: string, owed?: "report" | "message" | null) => boolean | "stop";
  /**
   * Questions the agent asked without waiting (TurnSink.askLater) were answered in another app (the Codex app), whether
   * or not a turn is running: their cards close. Answers by question id (or by the id of the message that asked them,
   * as older Codex apps name it).
   */
  questionsAnswered?: (answers: Record<string, string>) => void;
  chat?: {
    /** Standing instructions for the chat's agent (e.g. other computers it can reach), or null. */
    notes?: string | null;
    /** Teamwork is on: the agent may ask this other agent one focused question through the `ask` tool. */
    helper: { provider: Provider; note: string } | null;
    /** Continue from a copy of the session instead of the session itself (it's open in another app). */
    fork?: boolean;
    /** A one-off question (teamwork helper): keep no session afterwards. */
    ephemeral?: boolean;
    /**
     * A group chat's agent: it reads everyone's messages (labelled) and has the room tools, like the rooms before group
     * chats, and keeps a chat's ways back (rewind, Try again, forks for Duplicate).
     */
    group?: boolean;
  } | null;
  /** The model server of your own the agent runs on (a custom-model account), if any. */
  endpoint?: AgentEndpoint | null;
  /** The agent gets the tools for the user's other chats (xchat.ts): the setting is on and its chat isn't private. */
  crossChat?: boolean;
  /** A model's entry in the agent's model list (what it can hold, say), asking the agent if need be; null: its default. */
  modelInfo?: (model: string | null) => Promise<ModelOption | null>;
  /** The same from what the hub already knows, without asking (for a helper agent's model while it runs). */
  knownModel?: (model: string) => ModelOption | null;
}

/** The tools for the user's other chats, as Claude Code names them. */
export const CHAT_TOOL_NAMES = ["list_chats", "read_chat", "send_to_chat", "wait_for_reply", "start_chat"];

/** A group chat's own tools (reading it, who's in it, a progress note): they only reach the chat the agent is in. */
export const ROOM_TOOL_NAMES = ["room_members", "room_read", "room_post"];

/** A custom model server, as a driver needs it. */
export interface AgentEndpoint {
  id: string;
  label: string;
  /** Without /v1. */
  baseUrl: string;
  models: string[];
  contextWindow: number | null;
  /** Its API key, or "" when it needs none. */
  key: string;
}

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The hub's own command line for agents' tool-call checks (`… hook <kind>`, see model-lock.ts). */
  hook?: string[];
}

export interface AgentDriver {
  readonly provider: Provider;
  /** Run one turn. Must resolve (not throw) when sink.signal aborts. */
  runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult>;
  /** Stop the in-flight turn as gracefully as the agent allows. */
  interrupt(): Promise<void>;
  /**
   * Hand the human's new message to the turn in progress ("Send now") instead of waiting for it to end: the agent reads
   * it at its next step. Resolves false when there's no turn to add it to.
   */
  steer?(text: string, messageIds?: string[]): Promise<boolean>;
  /**
   * What steer handed the reply that just ended and it will never read, by message id, handed back and forgotten by the
   * driver: Crosstalk's own agent's when the reply failed, was stopped or ran out of steps first; Codex's when its turn was
   * stopped or failed (such a turn drops input it hadn't read); Claude Code's when a Stop took them back out of its queue or
   * they went with its process. The engine makes them unread again, so Try again, Answer now or the next message brings
   * them along. One Claude Code still holds isn't here: it answers that next by itself (owedTurn).
   */
  takeUnread?(): string[];
  /**
   * "Read it now": what steer handed over waits for the step the agent is on (a long command, say). Stops that step so
   * the agent reads it now, in the same turn: it answers it once, below it (sink.newReply). Resolves false when nothing
   * handed over is waiting any more (the agent has read it); throws when the step couldn't be stopped (it reads it
   * after that step, as before).
   */
  readNow?(): Promise<boolean>;
  /**
   * The agent's process has had nothing to do for a while: may it be ended to free its memory? The next turn starts a
   * fresh one that resumes the session. Not while it works on its own (background helpers, commands left running, a
   * prompt it scheduled for later), or while its session is open in another app. Drivers without it are left running.
   */
  canEndWhenIdle?(): boolean;
  /**
   * A turn the agent owes by itself: input only this process holds, that it starts on once it's free and hasn't yet.
   * "report": a background helper or job reported back (Claude Code answers its <task-notification>, which carries the
   * helper's whole report, in a turn of its own); "message": a message handed to a reply that ended before reading it
   * (Claude Code answers it next, in a turn of its own). Null when there's none. A process that owes one is never
   * replaced or ended (Engine.memberChanged, endIdle, renewIdle) before that turn is under way: only it holds that, and
   * only once. Otherwise a settings change can replace a process that had just written its background job's report into
   * the session: the new one closes it with "No response requested." and the agent goes idle mid-plan. A turn the engine
   * had stopped as it started (onOwnTurn's "stop") still counts until it has stopped. Drivers without it owe nothing:
   * Codex starts no turn by itself (a helper's final answer waits for the chat's next turn: carryNote says it to a process
   * that never had it) and takes a steered message into the turn it was steered into; Crosstalk's own agent reads one in
   * the same reply.
   */
  owedTurn?(): "report" | "message" | null;
  /**
   * What only this process holds that a process taking over (or this one, once restarted) must be told, as words for that
   * process's first turn: Codex's helpers' final answers, queued in its app-server's memory for the chat's next turn (a
   * helper that finished after the reply did; Codex starts no turn for it and never writes it to the thread). The engine
   * takes it (`take`) as it replaces or ends the process and puts it in the next turn (Engine.carryNotes); without
   * `take` it's only looked at (busy.json). Null when there's nothing.
   */
  carryNote?(take?: boolean): string | null;
  /**
   * How many prompts the agent scheduled for later inside this process (Claude Code's CronCreate and ScheduleWakeup),
   * which end with it: what a restart would lose, so the chat can say so.
   */
  scheduledPrompts?(): number;
  /**
   * Rewind the agent's conversation to just before one of the human's messages (to edit or unsend it): it forgets that
   * message and everything after. Files it changed stay changed. Resolves with every message id it forgot that went in
   * at the same point (a turn can carry several); throws when it can't (say, the message came from another app).
   */
  rewind?(messageId: string): Promise<string[]>;
  /** Called when the member is removed, its settings change, or the hub shuts down. */
  dispose(): Promise<void>;
}

export type DriverFactory = (ctx: DriverContext) => AgentDriver;

export function describePermission(p: PermissionMode): string {
  switch (p) {
    case "ask":
      return "Ask before running commands or editing files";
    case "edits":
      return "Edit files freely, ask before running commands";
    case "auto":
      return "Use automatic safety checks";
    case "full":
      return "No approvals";
  }
}

/** The message that asks an agent to compact its conversation now (Claude Code's own command; Codex gets the same). */
export const COMPACT_COMMAND = "/compact";

/**
 * The threshold (tokens) a chat compacts at: what its settings set, or, on a model server of your own, three
 * quarters of the context the server gives each request (local models often have far less than the agent assumes).
 */
export function autoCompactLimit(config: Record<string, unknown> | undefined, endpoint?: Pick<AgentEndpoint, "contextWindow"> | null): number | null {
  const n = config?.autoCompact;
  if (typeof n === "number" && Number.isFinite(n) && n >= 10_000) return Math.round(n);
  return endpoint?.contextWindow ? Math.floor(endpoint.contextWindow * 0.75) : null;
}

/** The same for an agent that pays for every request and re-sends the whole conversation with each (serviceDefaultCompact). */
export function serviceCompactLimit(config: Record<string, unknown> | undefined, endpoint?: Pick<AgentEndpoint, "contextWindow"> | null): number | null {
  const n = config?.autoCompact;
  if (typeof n === "number" && Number.isFinite(n) && n >= 10_000) return Math.round(n);
  return endpoint?.contextWindow ? serviceDefaultCompact(endpoint.contextWindow) : null;
}

/** The most Claude Code may write in one answer on a model server of your own: a quarter of the context, 1k to 16k tokens. */
export function endpointOutputLimit(contextWindow: number): number {
  return Math.max(1024, Math.min(16_384, Math.floor(contextWindow / 4)));
}
