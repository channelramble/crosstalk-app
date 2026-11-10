import type { BackgroundTask, PermissionMode, UsageWindow } from "@crosstalk/shared";
import { autoCompactLimit, CHAT_TOOL_NAMES, endpointOutputLimit, ROOM_TOOL_NAMES, type AgentDriver, type DriverContext, type TurnInput, type TurnResult, type TurnSink } from "./driver";
import { claudeLimitHit } from "./limits";
import { claudeAuthHit, claudeMarksOrigin } from "./stale-login";
import { describeToolCall } from "../mcp/describe";
import { claudeProjectsDir, claudeSessionsInUse, claudeTranscriptPath } from "../local-sessions";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_DIR } from "../config";
import { logger } from "../util/log";
import { endProcess } from "../util/process";
import { HELPER_TOOL, baseModel, helperNote, isModelAlias, modelName, sameModel, shellCommand } from "./model-lock";
import { alongsideNote } from "./alongside";

const log = logger("claude");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Standing note appended to Claude Code's system prompt for room members. */
const ROOM_SYSTEM_PROMPT = [
  "You are running inside Crosstalk, a group chat where several AI coding agents and a human work on the same project.",
  "Each message you receive contains the chat's new messages since your last turn, labelled with who wrote them, followed by why it's your turn.",
  "Your final reply is posted to the chat. Be concise and concrete: what you did, what you found, what's next.",
  "To hand work to another agent, @mention them in your final reply with a specific request. Only mention an agent when you want them to act now.",
  "The `crosstalk` MCP tools let you read recent chat messages (room_read), see who's in the room (room_members) and post progress updates (room_post).",
].join("\n");

/** A group chat's: the same, but who answers is the human's choice (the chat's briefing says how it works). */
const GROUP_SYSTEM_PROMPT = [
  "You are running inside Crosstalk, a group chat where several AI coding agents and a human work on the same project.",
  "Each message you receive contains the chat's new messages since your last turn, labelled with who wrote them, followed by why it's your turn.",
  "Your final reply is posted to the chat. Be concise and concrete: what you did, what you found, what's next.",
  "The human decides who answers: your @mentions don't start another agent's turn. The chat's briefing says how turns work there.",
  "The `crosstalk` MCP tools let you read recent chat messages (room_read), see who's in the chat (room_members) and post progress updates (room_post).",
].join("\n");

function permissionArgs(p: PermissionMode): string[] {
  switch (p) {
    case "ask":
      return ["--permission-mode", "default"];
    case "edits":
      return ["--permission-mode", "acceptEdits"];
    case "auto":
      return ["--permission-mode", "auto"];
    case "full":
      return ["--dangerously-skip-permissions"];
  }
}

function toolResultText(content: Json): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
  return content ? JSON.stringify(content) : "";
}

const RATE_LABEL: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  overage: "Extra usage",
};

/** Map a stream-json rate_limit_event to a usage window (fields vary by Claude Code version). */
export function claudeRateWindow(info: Json): UsageWindow | null {
  if (!info) return null;
  let pct: number | null = typeof info.utilization === "number" ? info.utilization : null;
  if (pct !== null && pct <= 1.0001) pct = pct * 100;
  const resets = typeof info.resetsAt === "number" ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : null;
  if (pct === null && info.status === "rejected") pct = 100;
  if (pct === null && !resets) return null;
  const label = RATE_LABEL[info.rateLimitType as string] ?? (info.rateLimitType ? String(info.rateLimitType) : "Current limit");
  return { label, usedPercent: pct, resetsAt: resets };
}

/** Options the installed Claude Code accepts (older versions lack some), learned on first failure. Exposed for tests. */
export const claudeSupports = {
  /** --thinking-display */
  thinkingDisplay: true,
  /** --resume-session-at (a fork that ends where a chat was duplicated) */
  resumeAt: true,
};
/** What Claude Code says (and exits) when a fork's end isn't in the conversation it resumes (the original was rewound). */
const FORK_POINT_GONE = /No message found with message\.uuid/i;

/** Claude Code's tools that schedule a prompt for later in the same process (session-only unless made durable). */
const SCHEDULE_TOOLS = new Set(["CronCreate", "CronDelete", "ScheduleWakeup"]);
/** A recurring job ends by itself after this long (Claude Code's recurringMaxAgeMs). */
const RECURRING_MAX_MS = 7 * 24 * 3600_000;
/** How long after its time a scheduled prompt still counts as waiting (it runs once the reply in progress ends). */
const FIRE_SLACK_MS = 15 * 60_000;

interface Turn {
  /** The process this turn runs on: output or an exit from any other (one being stopped) is ignored. */
  proc: ReturnType<typeof Bun.spawn>;
  /** The turn has ended (its result reported), even if a newer turn has taken over since. */
  settled: boolean;
  sink: TurnSink;
  done: (r: TurnResult) => void;
  tools: Map<string, string>; // tool_use_id -> activity id
  running: Set<string>; // activity ids still waiting for a tool_result
  streamedText: boolean;
  text: string;
  thinking: string | null; // activity id of the thinking block being streamed
  /** The model has written or done something for this turn (anything but Claude Code's own placeholder reply). */
  realOutput: boolean;
  /** Claude Code answered a background task's notification with its "No response requested." placeholder. */
  placeholder: boolean;
  /** The conversation was compacted during this turn: sizes before and after, in tokens. */
  compacted: { pre: number; post: number } | null;
  /** Work Claude Code started by itself, between the hub's turns. */
  own?: boolean;
  /**
   * Work it started by itself that the hub stopped as it started (onOwnTurn's "stop": settings it may not answer on wait
   * for this process), with what it was taking up. Nothing of it is shown; its result ends it (dropOwnTurn).
   */
  dropped?: "report" | "message" | "other";
  /** A message went in mid-reply: Claude Code reads it with its next request, so the next message starts a new reply. */
  splitNext?: boolean;
  /** The model's safety filter stopped part of the reply (Claude Code may carry on once, on the same model). */
  refused?: boolean;
  /** Being stopped because it answered on a model the user didn't pick: the error the turn ends with. */
  halted?: string;
  /**
   * A rate_limit_event of this turn said a request was *rejected*: with the turn's own failure, that's a limit to wait
   * for (limits.ts). Kept per turn, so an older event never makes a plain failure look like a limit, and cleared again
   * as soon as the model answers after it (a later request got through, so the limit isn't what ended this turn).
   */
  limitWindow?: UsageWindow | null;
  /** Messages steer wrote mid-turn that Claude Code hasn't taken in yet (their uuids), oldest first. */
  queued?: string[];
  /** Everything steer wrote to this turn, by uuid: which of the human's messages each carried. */
  handed?: Map<string, string[]>;
  /** The Stop asked of this turn (interrupt): one request, however many ask, and nothing more is handed to it (steer). */
  stopAsked?: Promise<void>;
  /** A Stop that takes queued messages back waits for Claude Code's receipt, and a result that comes first waits with it. */
  receipt?: { result: Json | null };
  /**
   * "Read it now": Claude Code was asked to stop the step it's on for the queued messages. `stopped`: it ended that
   * part of the turn, and answers them next, in this same reply. `survives`: they're still queued (null: not known).
   */
  readNow?: { stopped: boolean; survives: boolean | null; timer?: ReturnType<typeof setTimeout> };
  /** What a part of this turn that ended early ("Read it now") used, added to the rest's. */
  carried?: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number | null };
  /** Whether a total from this same process came before this turn's first result (set there; see `lastTotal`). */
  ledgerBaseline?: boolean;
  /** Claude Code has the turn's message in its conversation (it's working on it, or answered). */
  taken?: boolean;
  /**
   * The SDK error kind of Claude Code's synthetic error reply in this turn ("authentication_failed", "server_error"…):
   * with the result's words, what tells a sign-in that stopped working from other failures (stale-login.ts).
   */
  syntheticError?: string;
  /** That reply's `api_error_origin` ("first_party": Anthropic's own API answered), for when the result leaves it out. */
  syntheticOrigin?: string;
}

/** What Claude Code is told when "Read it now" stopped its step after it had already taken the message in. */
const READ_NOW_NUDGE = "(Crosstalk stopped the step you were on so you'd answer my last message right away. Answer it now.)";

/**
 * Drives the real Claude Code CLI in its documented headless mode
 * (`claude -p --input-format stream-json --output-format stream-json`), one long-lived process per member.
 * Sign-in stays with Claude Code itself; this never touches credentials.
 */
export class ClaudeDriver implements AgentDriver {
  readonly provider = "claude" as const;
  /** How long Stop waits for Claude Code to wind down before ending the process (and again before SIGKILL). */
  static graceMs = 3000;
  /** Claude Code sessions open in other apps right now (local-sessions.ts; replaced in tests). */
  static sessionsInUse: () => Set<string> = claudeSessionsInUse;
  /** What the running Claude Code says it supports (system/init), e.g. interrupt_send_now_v1. */
  private capabilities = new Set<string>();
  /** The running Claude Code's version, as its system/init says it. */
  private cliVersion: string | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private sessionId: string | null;
  private turn: Turn | null = null;
  private stderrTail = "";
  /** The last turn's input, to resend if Claude Code had to be restarted without an unsupported option. */
  private lastInput: unknown = null;
  private interruptSeq = 0;
  private windows = new Map<string, UsageWindow>();
  /** A copy of the session was made (or is being made) for this chat: later processes continue the copy. */
  private forked: boolean;
  private forking = false;
  /** Where the running process's fork ends (--resume-session-at), and whether that point turned out to be gone. */
  private forkAtUsed: string | null = null;
  private forkAtGone = false;
  /**
   * The model a chat left on "Default" runs on, saved when its first process reported it, so it stays the same model
   * for the chat's life (a later default, after an update, doesn't move a running chat).
   */
  private pinnedModel: string | null;
  /** The model the current process answers with, as Claude Code reported it. */
  private runningModel: string | null = null;
  /** Let go of for good (dispose): nothing it still hears about its processes is news to anyone. */
  private disposed = false;
  /** The running total (total_cost_usd) the current process last reported, for the spend ledger; null before its first result. */
  private lastTotal: number | null = null;
  /** Said once per process that fast mode, turned on, isn't running. */
  private fastNoticed = false;
  /**
   * A turn this process owes by itself (owedTurn): a background task reported back (task_notification), or a reply ended
   * before reading a message handed to it (steer). Claude Code takes either up once it's free and answers it in a turn of
   * its own, whose first words come only once the API has read the whole conversation. Over once that turn shows
   * (beginOwnTurn), a request put together after it takes it in (see handle), Claude Code says it has nothing left to do
   * (session state "idle", sessionState), the process goes, or Claude Code has said nothing for too long (rearmOwed).
   * `turn`: the reply that was running when it came; `afterResult`: a tool result of that reply has come in since, so
   * its next request is put together after it; `ran`: Claude Code has said "running" since, with no reply of ours open;
   * `message`: a message handed to it is among what's owed.
   */
  private owed: { kind: "report" | "message"; proc: ReturnType<typeof Bun.spawn>; timer?: ReturnType<typeof setTimeout>; turn: Turn | null; afterResult: boolean; ran: boolean; message: boolean } | null = null;
  /**
   * How long Claude Code may say nothing at all while it owes a turn, and hasn't said it's working by itself, before that
   * counts as not coming (a Claude Code that never says its state, or one that hasn't started). Any output, a retry or
   * compaction, starts it again.
   */
  static owedQuietMs = 3 * 60_000;
  /**
   * The same once Claude Code works by itself (rearmOwed): its first words can take minutes on a long conversation, so
   * only a process that froze is this quiet. Longer than Claude Code's own wait for an API answer (10 minutes), after
   * which it retries and says so, or fails.
   */
  static owedWorkingMs = 15 * 60_000;

  constructor(
    private ctx: DriverContext,
    private bin: string,
  ) {
    this.sessionId = (ctx.session.sessionId as string) || null;
    this.refs = new Map(Object.entries((ctx.session.msgRefs as Record<string, string> | undefined) ?? {}));
    this.forked = ctx.session.forkDone === true;
    this.pinnedModel = typeof ctx.session.model === "string" && ctx.session.model ? ctx.session.model : null;
  }

  /** The model picked for this chat's helper agents, when it isn't the chat's own. */
  private helperModel(): string | null {
    const m = this.ctx.member.config?.helperModel;
    return typeof m === "string" && m.trim() ? m.trim() : null;
  }

  private spawn() {
    const { room, member, mcp, env, chat } = this.ctx;
    // A chat's agent gets no room tools: only Crosstalk's approval prompt, and the ask tool when teamwork is on. A group
    // chat's agents get the room tools, as the rooms before them did.
    const crossChat = !!this.ctx.crossChat && !chat?.ephemeral;
    const toolset = {
      ...(chat && !chat.group ? { CROSSTALK_TOOLSET: "chat", ...(chat.helper ? { CROSSTALK_ASK: chat.helper.provider } : {}) } : {}),
      ...(crossChat ? { CROSSTALK_CHATS: "1" } : {}),
      ...(chat?.ephemeral ? {} : { CROSSTALK_HELPER_MODEL: "1" }),
    };
    const mcpConfig = {
      mcpServers: {
        crosstalk: { type: "stdio", command: mcp.command, args: mcp.args, env: { ...mcp.env, CROSSTALK_EXPOSE_APPROVE: "1", ...toolset } },
      },
    };
    const helperModel = this.helperModel();
    const helpers = helperNote("claude", helperModel, !chat?.ephemeral);
    const alongside = alongsideNote("claude", room, { ephemeral: chat?.ephemeral });
    const systemPrompt = (chat?.group ? [GROUP_SYSTEM_PROMPT, chat.notes, helpers, alongside] : chat ? [chat.notes, chat.helper?.note, helpers, alongside] : [ROOM_SYSTEM_PROMPT, helpers, alongside]).filter(Boolean).join("\n\n");
    // A duplicated chat: its first process forks the original's session (up to where it was duplicated, when that's
    // known); later ones continue the copy.
    const fork = !!(chat?.fork && this.sessionId && !this.forked);
    const forkAt = fork && claudeSupports.resumeAt && !this.forkAtGone && typeof this.ctx.session.forkAt === "string" && /^\w[\w-]{0,63}$/.test(this.ctx.session.forkAt) ? this.ctx.session.forkAt : null;
    this.forkAtUsed = forkAt;
    // Jobs scheduled in an earlier process went with it.
    const scheduledBefore = this.waitingJobs() ? this.scheduled.size : 0;
    this.scheduled.clear();
    this.scheduling.clear();
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Stream readable thinking summaries so the room can show the agent's reasoning while it works
      // (left out for Claude Code versions that don't know the option; see the exit handler).
      ...(claudeSupports.thinkingDisplay ? ["--thinking-display", "summarized"] : []),
      // A file only this user can read: the helper's key never shows on the command line (`ps` shows argv).
      "--mcp-config",
      this.writeMcpConfig(mcpConfig),
      "--permission-prompt-tool",
      "mcp__crosstalk__approve",
      "--append-system-prompt",
      systemPrompt,
      ...permissionArgs(member.permissionMode),
    ];
    // Always the model the user picked, by its own name, on every start and resume: never one Claude Code chooses, and
    // never one an earlier process came up on (that pin once outlived the choice it stood for). "Default" and an alias
    // start on the model they meant when this chat began, kept from its first process (`pinnedModel`), so an updated
    // Claude Code doesn't move the chat.
    const selected = member.model || null;
    const pinned = (!selected || isModelAlias(selected)) && this.pinnedModel && ((this.ctx.session.modelRequested as string | null | undefined) ?? null) === selected ? this.pinnedModel : null;
    const model = pinned ?? selected ?? (this.ctx.endpoint ? null : "default");
    // What it must come up on (checked against its init): unknown only for "Default" or an alias before the first start.
    this.runningModel = model && !isModelAlias(model) ? model : null;
    if (model) args.push("--model", model);
    const effort = typeof member.config?.effort === "string" && member.config.effort ? member.config.effort : null;
    if (effort) args.push("--effort", effort);
    // Ultracode (Claude plans big tasks and runs several agents in parallel) is a per-session setting, not an effort level.
    const settings: Record<string, unknown> = { disableAllHooks: false };
    if (member.config?.ultracode === true && !chat?.ephemeral) settings.ultracode = true;
    // Summarize older messages once the conversation reaches this size, instead of near the model's limit.
    const compactAt = autoCompactLimit(member.config, this.ctx.endpoint);
    if (compactAt) settings.autoCompactWindow = compactAt;
    // Fast mode needs the host's opt-in; the setting is both the opt-in and the switch.
    if (member.config?.fast === true && !chat?.ephemeral) settings.fastMode = true;
    // What the user chose to always allow in this chat ("Always allow `git status` commands"): Claude Code keeps those
    // per process, and this one may be a restart (ended while idle, or after a freeze).
    const kept = (this.ctx.latestSession?.() ?? this.ctx.session).allowRules;
    const allow = Array.isArray(kept) ? kept.filter((r): r is string => typeof r === "string" && r.length <= 2000) : [];
    if (allow.length) settings.permissions = { allow };
    // Workflow options can override effort; refuse explicit overrides and check helper transcripts as a backstop.
    const hook = this.ctx.mcp.hook;
    if (hook?.length) settings.hooks = { PreToolUse: [{ matcher: "Workflow|Agent|Task|Skill", hooks: [{ type: "command", command: shellCommand([...hook, "workflow"]), timeout: 30 }] }] };
    // Never switch models on its own (after a safety-filter stop, when a model is busy or needs usage credits…): the
    // chat answers with the model the user picked, or stops and says why. Helper agents (subagents, workflow agents,
    // teammates) run on the chat's model, or the one picked for helpers: a model they name themselves, or their
    // definition names, is ignored, and Explore isn't capped below the chat's model. Set here as well as in the
    // environment, so a project's or the user's own Claude Code settings can't turn them off.
    const lock = {
      CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
      CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: helperModel ?? "inherit",
      CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: "1",
    };
    settings.env = lock;
    // In a file only this user can read, like the MCP config: an allowed command can carry a secret it was given.
    args.push("--settings", this.writeSettings(settings));
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (fork) {
      args.push("--fork-session");
      if (forkAt) args.push("--resume-session-at", forkAt);
      this.forking = true;
    }
    if (chat?.ephemeral) args.push("--no-session-persistence");
    // Turning teamwork (or reaching other chats) on is the consent: these tools don't need an approval card each
    // time. Crosstalk itself asks the user when a message would reach a chat that can do more than this one.
    const allowed = [
      ...(chat?.helper ? [`mcp__crosstalk__ask_${chat.helper.provider}`] : []),
      ...(crossChat ? CHAT_TOOL_NAMES.map((t) => `mcp__crosstalk__${t}`) : []),
      // A group chat's own tools only read it and post to it.
      ...(!chat || chat.group ? ROOM_TOOL_NAMES.map((t) => `mcp__crosstalk__${t}`) : []),
      // It asks the user itself whenever they didn't ask for that model in the chat.
      ...(chat?.ephemeral ? [] : [`mcp__crosstalk__${HELPER_TOOL}`]),
    ];
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    const proc = Bun.spawn([this.bin, ...args], {
      cwd: room.cwd,
      env: {
        ...env,
        // Approval prompts wait for a human, so give the MCP approval tool a long timeout.
        MCP_TOOL_TIMEOUT: "86400000",
        // Never move a running tool call to the background (a wait for another chat's reply must stay in this turn).
        CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
        // Say when it starts and stops working, including on its own when background helpers report back.
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
        ...lock,
        // For the workflow check (model-lock.ts), to name the chat's effort.
        ...(effort ? { CROSSTALK_EFFORT: effort } : {}),
        // On a model server of your own, answers fit the chat's model (the account's environment sizes them for its first one).
        ...(this.ctx.endpoint?.contextWindow ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(endpointOutputLimit(this.ctx.endpoint.contextWindow)) } : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.disposed = false;
    this.settleOwed(false); // what an earlier process owed went with it
    this.workGone(scheduledBefore); // and so did what it ran in the background, if its exit hasn't been heard yet
    this.claudeState = null; // until this one says
    this.lastTotal = null; // a new process starts again from part of the old total: its first reply has nothing to difference from
    this.stderrTail = "";
    this.capabilities = new Set();
    this.modelChecked = false; // until its init names the chat's model, nothing is handed to it mid-reply (steer)
    void this.readStdout(proc);
    void this.readStderr(proc);
    void proc.exited.then(async (code) => {
      if (this.proc === proc) this.proc = null;
      // What it owed went with it: the hub, which may have been waiting for that turn, looks again.
      if (this.owed?.proc === proc) this.settleOwed(true);
      // Its scheduled prompts ended with it (unless a newer process has taken over: they went then).
      const scheduledThen = !this.proc && this.waitingJobs() ? this.scheduled.size : 0;
      if (!this.proc) this.scheduled.clear();
      // What it ran in the background ended with it, and nothing is left to report that.
      this.workGone(scheduledThen);
      const t = this.turn && this.turn.proc === proc ? this.turn : null;
      // An older Claude Code that doesn't know --thinking-display (or --resume-session-at) exits at once: drop the
      // option and resend.
      await Bun.sleep(50); // let the stderr reader catch up
      let dropped: string | null = null;
      if (claudeSupports.thinkingDisplay && /unknown option.*thinking-display/i.test(this.stderrTail)) {
        claudeSupports.thinkingDisplay = false;
        dropped = "this Claude Code doesn't support --thinking-display; running without thinking summaries";
      } else if (claudeSupports.resumeAt && /unknown option.*resume-session-at/i.test(this.stderrTail)) {
        claudeSupports.resumeAt = false;
        dropped = "this Claude Code doesn't support --resume-session-at; a duplicated chat's copy takes the whole conversation";
      } else if (this.forkAtUsed && FORK_POINT_GONE.test(this.stderrTail)) {
        // The original was rewound (or edited) since it was duplicated: the point the copy ends at isn't in its
        // conversation any more. The copy forks all of it, as it is now, and says so.
        this.forkAtGone = true;
        dropped = `a duplicated chat's fork point (${this.forkAtUsed}) isn't in the original's conversation any more; its copy takes the whole conversation`;
        if (t) {
          t.sink.saveSession({ forkAt: null });
          t.sink.activity({
            kind: "notice",
            title: "The original chat changed since this copy was made",
            detail: "It was rewound or edited after it was duplicated, so this copy starts from its conversation as it is now. Ask about anything you need from the messages above.",
            status: "done",
          });
        }
      }
      if (dropped) {
        log.info(dropped);
        if (t && this.lastInput) {
          this.spawn();
          t.proc = this.proc!; // the turn now runs on the replacement: its exit must end the turn
          this.write(this.lastInput);
          return;
        }
      }
      if (t) {
        const tail = this.stderrTail.trim().split("\n").slice(-3).join(" ");
        t.done({ ok: false, error: `Claude Code exited (code ${code})${tail ? `: ${tail}` : ""}` });
      }
    });
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    this.steeredAt = 0;
    if (sink.signal.aborted) return { ok: false, error: "stopped" };
    if (/^\s*\/model\b/.test(input.prompt)) return { ok: false, error: "Use Crosstalk's model menu to change this chat's model. That keeps the selected model after a restart and applies it to helper agents too." };
    // A stopped turn still winding down (perhaps frozen) when the next one starts: let its process go now, so this turn
    // starts a fresh one instead of waiting on it. Unless that process holds what nothing else has (a helper or job at
    // work, a message still queued, a report it owes): then it's given the time a Stop gets to wind down (interrupt ends it
    // after that), so "Stop and answer my message" doesn't end the helper as well.
    const prev = this.turn;
    if (prev && !prev.settled && (this.holdsOwnWork() || prev.queued?.length)) {
      for (const end = Date.now() + ClaudeDriver.graceMs + 500; !prev.settled && !sink.signal.aborted && Date.now() < end; ) await Bun.sleep(20);
      if (sink.signal.aborted) return { ok: false, error: "stopped" };
    }
    if (prev && !prev.settled) {
      if (this.proc === prev.proc) this.proc = null;
      void endProcess(prev.proc);
      prev.done({ ok: false, error: "stopped" });
    }
    // A process that came up on another model than the chat's while no reply was open (cameUpOn) never answers: this
    // reply starts a fresh one on the chat's model, and says so.
    const off = this.offModelProc;
    this.offModelProc = null;
    if (off && this.proc === off.proc) {
      this.proc = null;
      void endProcess(off.proc);
      const want = modelName(this.runningModel ?? "");
      sink.activity({ kind: "notice", title: `Claude Code started on ${modelName(off.model)}, not ${want}`, detail: `This chat is set to ${want}, so Crosstalk started it again on ${want} for this reply.`, status: "done" });
    }
    if (!this.proc) {
      // Two Claude Code processes writing one session would corrupt it: a session that's open in the Claude app is
      // only continued from a copy.
      const chat = this.ctx.chat;
      if (chat && this.sessionId && !(chat.fork && !this.forked) && ClaudeDriver.sessionsInUse().has(this.sessionId)) {
        return { ok: false, error: "This conversation is open in the Claude app right now. Close it there, then tap Try again. Or duplicate this chat to go on in a copy." };
      }
      sink.status("Starting Claude Code", "thinking");
      try {
        this.spawn();
      } catch (e) {
        return { ok: false, error: `Couldn't start Claude Code: ${e instanceof Error ? e.message : e}` };
      }
    }
    const text = input.systemNote ? `${input.systemNote}\n\n---\n\n${input.prompt}` : input.prompt;
    return new Promise<TurnResult>((resolve) => {
      const turn: Turn = { proc: this.proc!, settled: false, sink, done: resolve, tools: new Map(), running: new Set(), streamedText: false, text: "", thinking: null, realOutput: false, placeholder: false, compacted: null };
      turn.done = (r) => {
        if (turn.settled) return;
        turn.settled = true;
        if (this.turn === turn) this.turn = null;
        if (turn.thinking) sink.updateActivity(turn.thinking, { status: "done" });
        this.unread(turn);
        resolve(r);
      };
      this.turn = turn;
      sink.signal.addEventListener("abort", () => void this.interrupt(), { once: true });
      const uuid = crypto.randomUUID();
      this.noteRefs(input.messageIds, uuid, sink);
      this.lastInput = {
        type: "user",
        uuid,
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        session_id: this.sessionId ?? "default",
      };
      this.write(this.lastInput);
      sink.status("Thinking", "thinking");
    });
  }

  private write(obj: unknown) {
    const p = this.proc;
    if (!p) return;
    const stdin = p.stdin as import("bun").FileSink;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      stdin.flush();
    } catch (e) {
      log.debug(`stdin write failed: ${e}`);
    }
  }

  private async readStdout(proc: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: Json;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (this.proc !== proc) continue; // a process being stopped: its output belongs to no turn
          this.turn?.sink.heartbeat?.();
          this.handle(ev);
        }
      }
    } catch (e) {
      log.debug(`stdout ended: ${e}`);
    }
  }

  private async readStderr(proc: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) this.stderrTail = (this.stderrTail + dec.decode(chunk)).slice(-4000);
    } catch {
      // ignore
    }
  }

  /** Background work this agent runs (helpers it summoned, workflows, long commands), by task id. */
  private tasks = new Map<string, BackgroundTask>();
  private tasksTimer: ReturnType<typeof setTimeout> | null = null;

  private trackTask(ev: Json) {
    // A task reported back: Claude Code takes its <task-notification> up as soon as it's free, in a turn of its own (or
    // with the next request of a reply that's running). Claude Code queues it in the same moment it says so (the task's
    // task_updated and task_notification go out together, then the notification is queued), so nothing it says after
    // this comes before the report is in its queue. Its own bookkeeping (memory, dreams: `ambient`, kept out of the
    // conversation) wakes nothing, nor does a task a restart left behind (`worker_restart`: a resumed process says so in
    // the conversation, asking nothing). A task stopped before it ended is reported too: whether that wakes it isn't
    // known here, and a turn owed that never comes only waits until Claude Code says it's idle (or `owedQuietMs`), while
    // one lost is lost.
    if (ev.subtype === "task_notification" && ev.ambient !== true && ev.skip_transcript !== true && ev.reason !== "worker_restart") this.owe("report");
    const id = typeof ev.task_id === "string" ? ev.task_id : null;
    if (!id) return;
    const cur = this.tasks.get(id);
    if (ev.subtype === "task_started") {
      this.taskProcs.set(id, this.proc);
      this.tasks.set(id, {
        id,
        kind: String(ev.task_type ?? "task"),
        description: String(ev.description ?? ev.workflow_name ?? "Background task"),
        agentType: typeof ev.subagent_type === "string" ? ev.subagent_type : null,
        workflow: typeof ev.workflow_name === "string" ? ev.workflow_name : null,
        background: ev.is_backgrounded === true,
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
        tokens: null,
        toolUses: null,
        lastTool: null,
        summary: null,
        error: null,
        model: null,
        effort: null,
        contextTokens: null,
        contextWindow: null,
      });
      this.watchHelpers();
    } else if (!cur) {
      return;
    } else if (ev.subtype === "task_progress") {
      const u = ev.usage ?? {};
      Object.assign(cur, {
        tokens: typeof u.total_tokens === "number" ? u.total_tokens : cur.tokens,
        toolUses: typeof u.tool_uses === "number" ? u.tool_uses : cur.toolUses,
        lastTool: typeof ev.last_tool_name === "string" ? ev.last_tool_name : cur.lastTool,
        // Progress names what it's doing right now ("Running sleep 20"); the helper keeps the name it started with.
        summary: typeof ev.summary === "string" && ev.summary.trim() ? ev.summary.trim() : typeof ev.description === "string" && ev.description && ev.description !== cur.description ? ev.description : cur.summary,
      });
    } else if (ev.subtype === "task_updated") {
      const p = ev.patch ?? {};
      if (typeof p.status === "string") cur.status = taskStatus(p.status);
      if (typeof p.end_time === "number") cur.endedAt = p.end_time;
      if (typeof p.error === "string") cur.error = p.error;
      if (typeof p.is_backgrounded === "boolean") cur.background = p.is_backgrounded;
    } else if (ev.subtype === "task_notification") {
      this.readHelper(cur);
      cur.status = taskStatus(String(ev.status ?? "completed"));
      cur.endedAt ??= Date.now();
      if (typeof ev.summary === "string" && ev.summary.trim()) {
        // Claude Code's note to itself about where the report went isn't meant for people.
        const said = ev.summary.trim();
        cur.summary = /delivered to you as a message|SubagentHandback|not repeated here/i.test(said) ? "Reported back to Claude Code." : said;
      }
      const u = ev.usage ?? {};
      if (typeof u.total_tokens === "number") cur.tokens = u.total_tokens;
      if (typeof u.tool_uses === "number") cur.toolUses = u.tool_uses;
    } else return;
    if (cur && cur.status !== "running") cur.endedAt ??= Date.now();
    // One that starts: the hub knows at once. A reply can start a job and end within the batching below, and a settings
    // change waiting for that reply would then replace the process under the job.
    if (ev.subtype === "task_started") this.flushTasks();
    else this.publishTasks();
  }

  /** Which process each background task runs in: it ends with that process. */
  private taskProcs = new Map<string, ReturnType<typeof Bun.spawn> | null>();

  /**
   * What the driver knew as running in a process that isn't the current one any more ended with it, and nothing is left to
   * report it: listed as stopped, so it doesn't hold new settings or messages for good, and the chat says what was lost. Not
   * when the hub let the process go itself: it says what that cost, if anything (Engine.stoppedWork).
   */
  private workGone(scheduled = 0) {
    if (this.disposed) return;
    const now = Date.now();
    const lost = [...this.tasks.values()].filter((x) => x.status === "running" && this.taskProcs.get(x.id) !== this.proc);
    for (const x of lost) Object.assign(x, { status: "stopped", endedAt: now, error: "Stopped when Claude Code's process ended." });
    if (lost.length || scheduled) this.ctx.onWorkLost?.(lost.map((x) => ({ ...x })), scheduled);
    if (lost.length) this.flushTasks();
  }

  /** Something only this process has: background work, a prompt it scheduled, or a turn it owes by itself. */
  private holdsOwnWork(): boolean {
    return [...this.tasks.values()].some((x) => x.status === "running") || this.waitingJobs() || !!this.owedTurn();
  }

  /**
   * Prompts Claude Code scheduled to run later in this process ("check the CI again in an hour"): CronCreate jobs and
   * ScheduleWakeup (/loop) wakeups, by id, until when each still waits. Session-only ones die with the process, so it
   * isn't ended while one waits (canEndWhenIdle). Learned from those tools' calls and results, helpers' included.
   */
  private scheduled = new Map<string, { recurring: boolean; until: number }>();
  private scheduling = new Map<string, { name: string; input: Json }>();

  private trackSchedule(ev: Json) {
    const content: Json[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
    if (ev.type === "assistant") {
      for (const b of content) if (b?.type === "tool_use" && SCHEDULE_TOOLS.has(b.name) && typeof b.id === "string") this.scheduling.set(b.id, { name: b.name, input: b.input ?? {} });
      return;
    }
    for (const b of content) {
      const call = b?.type === "tool_result" ? this.scheduling.get(b.tool_use_id) : undefined;
      if (!call) continue;
      this.scheduling.delete(b.tool_use_id);
      if (b.is_error) continue;
      const now = Date.now();
      if (call.name === "CronCreate") {
        const id = /Scheduled (?:recurring job|one-shot task) (\S+?)[\s.(]/.exec(toolResultText(b.content))?.[1] ?? `cron:${b.tool_use_id}`;
        const recurring = call.input.recurring !== false;
        // A recurring job ends by itself after a week; a one-shot task once it has run.
        const at = recurring ? null : nextCronTime(String(call.input.cron ?? ""), now);
        this.scheduled.set(id, { recurring, until: recurring || at === null ? now + RECURRING_MAX_MS : at + FIRE_SLACK_MS });
      } else if (call.name === "CronDelete") {
        this.scheduled.delete(String(call.input.id ?? ""));
      } else if (call.input.stop === true) {
        for (const id of [...this.scheduled.keys()]) if (id.startsWith("wakeup:")) this.scheduled.delete(id);
      } else {
        // Claude Code keeps a wakeup between a minute and an hour away.
        const delay = Math.min(3600, Math.max(60, Number(call.input.delaySeconds) || 60));
        this.scheduled.set(`wakeup:${b.tool_use_id}`, { recurring: false, until: now + delay * 1000 + FIRE_SLACK_MS });
      }
    }
  }

  /** Whether a prompt Claude Code scheduled still waits to run in this process. */
  private waitingJobs(): boolean {
    const now = Date.now();
    for (const [id, job] of this.scheduled) if (job.until <= now) this.scheduled.delete(id);
    return this.scheduled.size > 0;
  }

  /** How many prompts Claude Code scheduled for later in this process still wait to run (they end with it). */
  scheduledPrompts(): number {
    return this.proc && this.waitingJobs() ? this.scheduled.size : 0;
  }

  /** While helper agents run, refreshes their model, effort and context from their transcripts every few seconds. */
  private helperTimer: ReturnType<typeof setInterval> | null = null;
  private watchHelpers() {
    if (this.helperTimer) return;
    this.helperTimer = setInterval(() => {
      const live = [...this.tasks.values()].filter((t) => t.kind === "local_agent" && t.status === "running");
      if (!live.length) {
        clearInterval(this.helperTimer!);
        this.helperTimer = null;
        return;
      }
      let changed = false;
      for (const t of live) changed = this.readHelper(t) || changed;
      if (changed) this.publishTasks();
    }, 4000);
  }

  /** Where Claude Code keeps this session's helper transcripts (found once, then remembered). */
  private helpersDir: string | null = null;
  private readHelper(t: BackgroundTask): boolean {
    if (t.kind !== "local_agent" || !this.sessionId || !/^[A-Za-z0-9_-]{1,64}$/.test(t.id)) return false;
    if (!this.helpersDir) {
      const projects = claudeProjectsDir(this.ctx.env.CLAUDE_CONFIG_DIR || undefined);
      const main = claudeTranscriptPath(this.sessionId, projects);
      if (!main) return false;
      this.helpersDir = join(main.slice(0, -".jsonl".length), "subagents");
    }
    const d = helperDetails(join(this.helpersDir, `agent-${t.id}.jsonl`), (model) => this.ctx.knownModel?.(model)?.contextWindow);
    if (!d) return false;
    const before = `${t.model}|${t.effort}|${t.contextTokens}`;
    Object.assign(t, d);
    const effort = this.ctx.member.config?.effort;
    if (typeof effort === "string" && d.effort && d.effort !== effort) {
      const active = this.turn ?? this.beginOwnTurn();
      if (active && !active.halted) {
        active.halted = `A helper agent started at ${d.effort} effort instead of ${effort}, so Crosstalk stopped this reply. Helpers use the effort selected for this chat.`;
        void this.interrupt();
        // End the process as well: stopping the parent alone can leave its background helpers running.
        if (this.proc === active.proc) this.proc = null;
        void endProcess(active.proc);
        active.done({ ok: false, error: active.halted });
      }
    }
    return before !== `${t.model}|${t.effort}|${t.contextTokens}`;
  }

  /** Tells the hub, at most a few times a second. */
  private publishTasks() {
    if (this.tasksTimer) return;
    this.tasksTimer = setTimeout(() => this.flushTasks(), 300);
  }

  /** Tells the hub now; finished tasks stay listed for half an hour. */
  private flushTasks() {
    if (this.tasksTimer) clearTimeout(this.tasksTimer);
    this.tasksTimer = null;
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, task] of this.tasks) {
      if (task.status === "running" || (task.endedAt ?? 0) >= cutoff) continue;
      this.tasks.delete(id);
      this.taskProcs.delete(id);
    }
    this.ctx.onTasks?.([...this.tasks.values()].map((x) => ({ ...x })));
  }

  /**
   * Whether this process owes a turn of its own, and for what (AgentDriver.owedTurn; see `owed`), including one the hub
   * stopped as it started that hasn't stopped yet (dropOwnTurn): until it has, the process isn't replaced or ended.
   */
  owedTurn(): "report" | "message" | null {
    const t = this.turn;
    if (t?.dropped && !t.settled && t.proc === this.proc) return t.dropped === "message" ? "message" : "report";
    return this.owed && this.owed.proc === this.proc ? this.owed.kind : null;
  }

  /** Claude Code will take this up by itself once it's free (see `owed`). A report outranks a message in the words. */
  private owe(kind: "report" | "message") {
    const proc = this.proc;
    if (!proc) return;
    const was = this.owed?.proc === proc ? this.owed : null;
    if (this.owed) clearTimeout(this.owed.timer);
    const turn = this.turn && !this.turn.settled ? this.turn : null;
    // Already under way by itself since an earlier owe: it still is. Never from what it said before anything was owed.
    this.owed = { kind: was?.kind === "report" ? "report" : kind, proc, timer: undefined, turn, afterResult: false, ran: was?.ran ?? false, message: kind === "message" || !!was?.message };
    this.rearmOwed();
  }

  /**
   * The wait for what's owed starts again (anything Claude Code says, a reply of ours ending): `owedWorkingMs` while
   * Claude Code works by itself — its last word was "running" and no reply of ours is open, so it's on what it owes, or
   * would have said "idle" — else `owedQuietMs`.
   */
  private rearmOwed() {
    const o = this.owed;
    if (!o) return;
    clearTimeout(o.timer);
    const working = this.claudeState === "running" && !(this.turn && !this.turn.settled);
    const ms = working ? ClaudeDriver.owedWorkingMs : ClaudeDriver.owedQuietMs;
    o.timer = setTimeout(() => {
      if (this.owed !== o) return;
      log.info(working ? `Claude Code said nothing for ${Math.round(ms / 60_000)} min while working on its ${o.kind}: nothing waits for it any more` : `Claude Code showed no sign of starting on its ${o.kind} in ${Math.round(ms / 100) / 10} s: nothing waits for it any more`);
      this.settleOwed(true);
    }, ms);
    (o.timer as { unref?: () => void }).unref?.();
  }

  /**
   * What Claude Code last said of itself (system/session_state_changed, which CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS turns
   * on): "running", "idle" or "requires_action"; null until it says (and from a Claude Code that never does).
   */
  private claudeState: string | null = null;

  /**
   * Claude Code said it started or stopped working, which matters only while it owes a turn. "running" with no reply of
   * ours open: it took something up by itself, most likely what it owes, and its first words can be minutes away (the
   * API reads the whole conversation afresh): no longer "no sign of starting" (rearmOwed). "idle" is Claude Code's own
   * word that it's done with everything it had (its "authoritative turn-over signal"): a report it owed has been
   * answered, taken in by a request, or wakes nothing, so nothing waits for it. Not so a message handed to it, unless it
   * has run since: one written just as a reply ended may still have been on its way down Claude Code's input.
   */
  private sessionState(state: unknown) {
    this.claudeState = typeof state === "string" ? state : null;
    const o = this.owed;
    if (!o || o.proc !== this.proc) return;
    if (state === "running" && !(this.turn && !this.turn.settled)) o.ran = true;
    if (state === "idle" && (!o.message || o.ran)) return this.settleOwed(true);
    this.rearmOwed();
  }

  /** It's over: under way, or never coming. `tell`: the hub hears it (it may hold settings back until then). */
  private settleOwed(tell: boolean) {
    if (!this.owed) return;
    clearTimeout(this.owed.timer);
    this.owed = null;
    if (tell) this.publishTasks();
  }

  /**
   * A turn ended. With a message handed to it still unread, Claude Code answers that next, in a turn of its own. Either
   * way, whether Claude Code now works by itself decides how long what's owed is waited for (rearmOwed): after a reply
   * whose last request didn't carry a report, it goes straight on to it, saying nothing until the API's first words.
   * With its process gone, what it hadn't taken in went too, and it's the person's again (takeUnread). The hub hears what
   * the reply's last moments did to its helpers before it hears the reply ended: what it does next goes by them.
   */
  private unread(turn: Turn) {
    if (this.proc !== turn.proc) this.wentWithProcess(turn);
    if (turn.splitNext && this.proc === turn.proc) this.owe("message");
    else this.rearmOwed();
    if (this.tasksTimer) this.flushTasks();
  }

  /** The human's messages (ids) steer wrote and Claude Code will never read: its Stop took them back, or its process went. */
  private neverRead: string[] = [];

  private wentWithProcess(turn: Turn) {
    for (const uuid of turn.queued ?? []) this.neverRead.push(...(turn.handed?.get(uuid) ?? []));
    turn.queued = [];
  }

  /** See AgentDriver.takeUnread. The reply is over for the hub, even if its turn hasn't heard yet that its process went. */
  takeUnread(): string[] {
    if (this.turn && !this.turn.settled && this.proc !== this.turn.proc) this.wentWithProcess(this.turn);
    return this.neverRead.splice(0);
  }

  /** Opens a turn for work Claude Code started by itself, so it shows in the chat like any reply. */
  private beginOwnTurn(): Turn | null {
    const proc = this.proc;
    if (!proc || !this.ctx.onOwnTurn) return null;
    // What it owed is under way now: a reply the hub waits for like any other.
    const owed = this.owedTurn();
    this.settleOwed(false);
    const answering = owed === "message" || (this.steeredAt > 0 && this.steeredAt < this.lastResultAt && Date.now() - this.lastResultAt < 5000);
    this.steeredAt = 0;
    const helpersDone = owed === "report" || [...this.tasks.values()].some((x) => x.status !== "running" && Date.now() - (x.endedAt ?? 0) < 120_000);
    const taking = owed ?? (answering ? "message" : helpersDone ? "report" : null);
    let opened: Turn | null = null;
    const shown = this.ctx.onOwnTurn(
      (sink) =>
        new Promise<TurnResult>((resolve) => {
          const turn: Turn = { proc, settled: false, sink, done: resolve, tools: new Map(), running: new Set(), streamedText: false, text: "", thinking: null, realOutput: false, placeholder: false, compacted: null, own: true };
          turn.done = (r) => {
            if (turn.settled) return;
            turn.settled = true;
            if (this.turn === turn) this.turn = null;
            if (turn.thinking) sink.updateActivity(turn.thinking, { status: "done" });
            this.unread(turn);
            resolve(r);
          };
          this.turn = turn;
          opened = turn;
          sink.signal.addEventListener("abort", () => void this.interrupt(), { once: true });
        }),
      answering ? "Claude Code is answering the message you sent." : helpersDone ? "Claude Code picked up where its helpers left off." : "Claude Code carried on by itself.",
      taking,
    );
    if (shown === "stop") return this.dropOwnTurn(proc, taking ?? "other");
    return opened;
  }

  /**
   * The hub won't have this turn run on this process (onOwnTurn said "stop": an account switch, tighter permissions or
   * another change it may not answer on waits for it, or the chat has let it go). Its first event shows Claude Code's
   * request went out with what it was taking up in the conversation; it's stopped now, before the model has written or
   * done anything, and nothing of it is shown. Until it has stopped it counts as owed (owedTurn), so the process isn't
   * replaced or ended under it; then the hub hears so (publishTasks), and a process on the new settings carries on from
   * what this one took in. One that doesn't stop is ended with its process (interrupt).
   */
  private dropOwnTurn(proc: ReturnType<typeof Bun.spawn>, taking: "report" | "message" | "other"): Turn {
    const turn: Turn = { proc, settled: false, sink: quietSink(), done: () => {}, tools: new Map(), running: new Set(), streamedText: false, text: "", thinking: null, realOutput: false, placeholder: false, compacted: null, own: true, dropped: taking };
    turn.done = () => {
      if (turn.settled) return;
      turn.settled = true;
      if (this.turn === turn) this.turn = null;
      this.publishTasks();
    };
    this.turn = turn;
    log.info(`stopped a reply Claude Code started by itself (${taking}) before it did anything: the hub carries on with a process on the new settings`);
    void this.interrupt();
    return turn;
  }

  /**
   * Every reply (and every helper's) must come from the model the user picked. Returns true when one didn't: the turn
   * is stopped then. Also notes a safety-filter stop, and fast mode that's on but not running.
   */
  private checkModel(t: Turn, ev: Json): boolean {
    // A model server of your own names its model as it likes: nothing to compare there.
    const model = typeof ev.message?.model === "string" && !this.ctx.endpoint ? ev.message.model : null;
    if (!ev.parent_tool_use_id) {
      if (ev.message?.stop_reason === "refusal") t.refused = true;
      if (model && model !== "<synthetic>" && !this.runningModel) this.runningModel = model;
      if (model && this.runningModel && !sameModel(model, this.runningModel)) {
        this.modelSwitched(t, model);
        return true;
      }
      if (!this.fastNoticed && this.ctx.member.config?.fast === true && !this.ctx.chat?.ephemeral && ev.message?.usage?.speed === "standard") {
        this.fastNoticed = true;
        t.sink.activity({
          kind: "notice",
          title: "Fast mode isn't running",
          detail: "Fast mode is on for this chat, but Claude Code is answering at normal speed. On a Claude plan, fast mode is paid from extra usage, so it only runs while extra usage is turned on and has credit.",
          status: "done",
        });
      }
      return false;
    }
    // A helper agent: the model picked for helpers, or else the chat's own.
    const expected = this.helperModel() ?? this.runningModel;
    const alias = expected && /^(opus|sonnet|haiku|fable)$/i.test(expected) ? expected.toLowerCase() : null;
    const matches = model && expected && (alias ? baseModel(model).startsWith(`claude-${alias}-`) : sameModel(model, expected));
    if (model && expected && !matches) {
      this.modelSwitched(t, model, expected, true);
      return true;
    }
    return false;
  }

  /**
   * Something answered on another model than the user picked: stop the reply and say so. Nothing more of it is shown;
   * the turn ends when Claude Code reports the stop (so that report can't land in the next turn), or after a few
   * seconds without one, when the process is let go.
   */
  private modelSwitched(t: Turn, to: string | null, expected = this.runningModel, helper = false) {
    if (t.settled || t.halted) return;
    const from = expected ? modelName(expected) : "the model you picked";
    const now = to ? modelName(to) : "another model";
    log.warn(`${helper ? "a helper agent" : "Claude Code"} switched from ${expected ?? "?"} to ${to ?? "?"}; stopping the turn`);
    t.halted = helper
      ? `A helper agent started on ${now} instead of ${from}, so Crosstalk stopped this reply. Helpers keep the chat's model unless you pick one for them in the model menu.`
      : `Claude Code switched this reply from ${from} to ${now} on its own, so Crosstalk stopped it. The chat stays on ${from}: ${this.ctx.chat ? "tap Try again" : "send your message again"}, or pick another model.`;
    for (const id of t.running) t.sink.updateActivity(id, { status: "done" });
    void this.interrupt();
    setTimeout(() => {
      if (t.settled) return;
      if (this.proc === t.proc) this.proc = null;
      void endProcess(t.proc);
      t.done({ ok: false, error: t.halted });
    }, ClaudeDriver.graceMs + 2000).unref?.();
  }

  /**
   * Claude Code came up on another model than this chat's: its init named it. Every start passes the chat's model by name
   * (`--model`), so this is Claude Code running its default in its place: this account can't use that model right now (its
   * cached model access marks the model as not this account's, and the one-token check it then sends fails), or the
   * person's or an organization's settings keep it off this machine. That must never become the chat's model, and starting
   * it again would only repeat the same check (billed, or counted against the plan) and fail the same way. So the process
   * is ended before it answers, nothing it came up on is kept, and the reply stops saying why, with the way out: another
   * model. With no reply open (a rewind's process), it's only kept from answering: the next reply starts a fresh one.
   */
  private cameUpOn(model: string, t: Turn | null) {
    const proc = this.proc;
    const expected = this.runningModel ?? "";
    const want = modelName(expected);
    const got = modelName(model);
    // An init after one that named the chat's model: it moved mid-process, which a fresh start undoes.
    const moved = this.modelChecked;
    if (!t || t.settled) {
      log.warn(`Claude Code came up on ${model} instead of ${expected} with no reply open; the next reply starts it again`);
      if (proc) this.offModelProc = { proc, model };
      return;
    }
    log.warn(`Claude Code came up on ${model} instead of ${expected}; the reply stops before it answers`);
    // Nothing more of this process is shown or kept: its output is ignored from here, and it's ended.
    if (this.proc === proc) this.proc = null;
    if (proc) void endProcess(proc);
    for (const id of t.running) t.sink.updateActivity(id, { status: "done" });
    // An ask (Ask others) runs on the model picked in its sheet, not on a chat's.
    const ask = !!this.ctx.chat?.ephemeral;
    const whose = ask ? "the model you picked" : "this chat's model";
    t.done({
      ok: false,
      error: moved
        ? `Claude Code moved to ${got} instead of ${want}, ${whose}, so Crosstalk stopped it. ${ask ? "Ask again" : "Your next message"} starts it again on ${want}.`
        : `Claude Code started on ${got} instead of ${want}, ${whose}, so Crosstalk stopped it before it answered. This account can't use ${want} right now. ${ask ? "Pick another model." : "Pick another model in the model menu."}`,
    });
  }

  /** A process that came up on another model than the chat's while no reply was open (cameUpOn): it never answers. */
  private offModelProc: { proc: ReturnType<typeof Bun.spawn>; model: string } | null = null;

  /**
   * Whether the running process's init has named the chat's model (or had nothing to check). Until then nothing is handed
   * to it mid-reply: a process that came up on another model is ended (cameUpOn), and a message given to it would go with it.
   */
  private modelChecked = false;

  /** Exposed for tests. */
  handle(ev: Json) {
    let t = this.turn;
    // Whether it's working (what that means for a turn it owes: sessionState). Nothing else reads it.
    if (ev.type === "system" && ev.subtype === "session_state_changed") return this.sessionState(ev.state);
    // Anything else it says (retrying, compacting) while it owes a turn: it may still be getting there.
    if (this.owed && ev.type !== "keep_alive") this.rearmOwed();
    // Output with no turn open: Claude Code started working by itself (its background helpers reported back). So did a
    // turn it owes whose request was refused before any words (a usage limit that ran out as the job finished, an API
    // error): its rejection, synthetic error reply or failed result opens the turn, which then fails with them — and
    // waits for the limit to reset, or says what happened with Try again — instead of "idle" settling the report
    // without a word while the agent had stopped mid-plan.
    if (!t && this.proc && (startsWork(ev) || (this.owedTurn() && refusedFirst(ev)))) t = this.beginOwnTurn();
    // A request carries what was queued when it was put together. A reply that started after what's owed came in has it
    // in its first request; one that was running takes it in with the request after its next tool results. A request that
    // was already on its way when a report came in hasn't it: if that's the reply's last, the report is answered in a
    // turn of its own, still owed.
    else if (t && this.owed && !ev.parent_tool_use_id) {
      if (t === this.owed.turn && ev.type === "user" && Array.isArray(ev.message?.content) && ev.message.content.some((b: Json) => b?.type === "tool_result")) this.owed.afterResult = true;
      else if (ev.type === "stream_event" && ev.event?.type === "message_start" && (t !== this.owed.turn || this.owed.afterResult)) this.settleOwed(false);
    }
    if (ev.type === "assistant" || ev.type === "user") this.trackSchedule(ev);
    // Working on it (or answering it) means it has the turn's message in its conversation.
    if (t && !t.taken && !t.own && (ev.type === "stream_event" || ev.type === "assistant" || (ev.type === "result" && Number(ev.num_turns) > 0))) {
      t.taken = true;
      t.sink.taken?.();
    }
    if (ev.type === "system" && typeof ev.subtype === "string" && ev.subtype.startsWith("task_")) {
      this.trackTask(ev);
      return;
    }
    // A reply of its own the hub stopped as it started (dropOwnTurn): nothing of it is shown, and its result ends it.
    if (t?.dropped && ev.type !== "system" && ev.type !== "control_response" && ev.type !== "rate_limit_event") {
      if (ev.type === "result") t.done({ ok: false, error: "stopped" });
      return;
    }
    // A turn being stopped for answering on another model: nothing more of it is shown, and its result ends it.
    if (t?.halted && ev.type !== "system" && ev.type !== "control_response" && ev.type !== "rate_limit_event") {
      if (ev.type === "result") {
        if (this.proc === t.proc) this.proc = null;
        void endProcess(t.proc);
        t.done({ ok: false, error: t.halted });
      }
      return;
    }
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init" && Array.isArray(ev.capabilities)) this.capabilities = new Set(ev.capabilities.filter((c: unknown) => typeof c === "string"));
        // Which Claude Code this is: whether it marks the API's own answers (stale-login.ts claudeMarksOrigin).
        if (ev.subtype === "init" && typeof ev.claude_code_version === "string") this.cliVersion = ev.claude_code_version;
        if (ev.subtype === "init" && typeof ev.model === "string" && ev.model) {
          // Claude Code says which model it came up on: anything but the chat's is never kept, and never answers.
          if (!this.ctx.endpoint && this.runningModel && !sameModel(ev.model, this.runningModel)) {
            this.cameUpOn(ev.model, t);
            return;
          }
          this.runningModel ??= ev.model;
          this.modelChecked = true;
          // Pin aliases too: an updated CLI must not silently move an explicit "Opus" selection to a newer model.
          if (t && this.pinnedModel !== ev.model) {
            this.pinnedModel = ev.model;
            this.ctx.session.modelRequested = this.ctx.member.model || null;
            t.sink.saveSession({ model: ev.model, modelRequested: this.ctx.member.model || null });
          }
        }
        // An init that names no model has nothing to check.
        if (ev.subtype === "init" && !(typeof ev.model === "string" && ev.model)) this.modelChecked = true;
        if (ev.subtype === "init" && ev.session_id) {
          if (ev.session_id !== this.sessionId) {
            this.sessionId = ev.session_id;
            if (this.forking) {
              // The copy exists now: from here on this chat continues the copy, never the original.
              this.forking = false;
              this.forked = true;
              t?.sink.saveSession({ sessionId: ev.session_id, forkDone: true });
            } else t?.sink.saveSession({ sessionId: ev.session_id });
          }
        } else if (ev.subtype === "model_refusal_fallback" && t) {
          // Another model took over after a safety-filter stop (turned off above; this is the backstop).
          this.modelSwitched(t, typeof ev.fallback_model === "string" ? ev.fallback_model : null);
        } else if (ev.subtype === "informational" && t && typeof ev.content === "string" && ev.content.trim()) {
          // Notes like "the safety filter stopped the response above · continuing once with that noted".
          t.sink.activity({ kind: "notice", title: ev.content.trim().slice(0, 200), status: "done" });
        } else if (ev.subtype === "api_retry" && t) {
          t.sink.status(`Retrying (${ev.error ?? "error"}, attempt ${ev.attempt}/${ev.max_retries})`, "thinking");
        } else if (ev.subtype === "compact_boundary" && t) {
          const m = ev.compact_metadata ?? {};
          const pre = typeof m.pre_tokens === "number" ? m.pre_tokens : 0;
          const post = typeof m.post_tokens === "number" ? m.post_tokens : 0;
          t.compacted = { pre, post };
          const sizes = pre && post ? ` (${Math.round(pre / 1000)}k → ${Math.round(post / 1000)}k tokens)` : "";
          t.sink.activity({ kind: "notice", title: `Compacted the conversation${sizes}`, detail: m.trigger === "auto" ? "Done automatically: the conversation reached its compaction size." : "Older messages were summarized to free up the context window.", status: "done" });
          if (post) t.sink.usage({ contextTokens: post });
        }
        return;
      case "rate_limit_event": {
        const w = claudeRateWindow(ev.rate_limit_info);
        if (w) {
          this.windows.set(w.label, w);
          // Only a *rejected* request: if this turn then fails, Crosstalk waits for this window to reset. A full window
          // isn't one — Claude Code's own statuses are allowed | allowed_warning | rejected, and an account with paid
          // extra usage runs on past 100% ("allowed_warning": the overflow is covered), so counting 100% would turn the
          // turn's next ordinary failure (an API 500, a dropped stream) into a limit and re-run it by itself.
          if (t && ev.rate_limit_info?.status === "rejected") t.limitWindow = w;
          t?.sink.rateLimit({ windows: [...this.windows.values()] });
        }
        return;
      }
      case "stream_event": {
        if (!t || ev.parent_tool_use_id) return;
        const e = ev.event;
        t.realOutput = true; // only the model streams; Claude Code's placeholder replies don't
        // The model answered after a refused request: a later one got through, so a failure further on isn't the limit.
        if (t.limitWindow) t.limitWindow = null;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          t.streamedText = true;
          t.text += e.delta.text;
          t.sink.text(e.delta.text);
        } else if (e?.type === "content_block_start" && e.content_block?.type === "thinking") {
          t.sink.status("Thinking", "thinking");
          t.thinking = t.sink.activity({ kind: "thinking", title: "Thinking", detail: "" });
        } else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta" && t.thinking) {
          t.sink.updateActivity(t.thinking, { appendDetail: e.delta.thinking ?? "" });
        } else if (e?.type === "content_block_stop" && t.thinking) {
          t.sink.updateActivity(t.thinking, { status: "done" });
          t.thinking = null;
        } else if (e?.type === "message_start" && t.splitNext) {
          // It has taken in the messages written mid-turn: what it writes now answers them.
          t.splitNext = false;
          t.queued = [];
          if (t.readNow?.timer) clearTimeout(t.readNow.timer);
          t.readNow = undefined;
          t.sink.newReply?.();
        } else if (e?.type === "message_start" && t.text && !t.text.endsWith("\n\n")) {
          // a new assistant message after tool calls: keep paragraphs apart
          const sep = t.text.endsWith("\n") ? "\n" : "\n\n";
          t.text += sep;
          t.sink.text(sep);
        }
        return;
      }
      case "assistant": {
        if (!t) return;
        // Synthetic error replies ("Not logged in · Please run /login") repeat in the result, which reports them in hub
        // terms. Their error kind is kept: it's how a sign-in that stopped working is told apart (stale-login.ts).
        if (ev.error && ev.message?.model === "<synthetic>") {
          t.syntheticError = String(ev.error);
          if (typeof ev.api_error_origin === "string") t.syntheticOrigin = ev.api_error_origin;
          return;
        }
        if (ev.message?.model === "<synthetic>") {
          // A background task (say, a subagent cut off by a restart) reported in before this message was read:
          // Claude Code closes that notification with a placeholder and a result of its own, then reads ours.
          t.placeholder = true;
          return;
        }
        t.realOutput = true;
        if (this.checkModel(t, ev)) return;
        const content: Json[] = ev.message?.content ?? [];
        if (!ev.parent_tool_use_id && ev.message?.usage) t.sink.usage({ contextTokens: contextOf(ev.message.usage) });
        for (const block of content) {
          if (block.type === "tool_use") {
            if (ev.parent_tool_use_id) {
              // tool calls inside a subagent: show under the subagent's activity
              const parent = t.tools.get(ev.parent_tool_use_id);
              if (parent) t.sink.updateActivity(parent, { appendDetail: `\n▸ ${block.name}: ${summarizeInput(block.name, block.input)}` });
              continue;
            }
            if (block.name === "mcp__crosstalk__approve") continue;
            const d = describeToolCall(block.name, block.input ?? {});
            const kind = d.kind === "command" ? "command" : d.kind === "file_change" ? "file_change" : block.name === "TodoWrite" ? "plan" : "tool";
            const title = block.name === "Task" || block.name === "Agent" ? `Subagent: ${block.input?.description ?? "task"}` : block.name === "TodoWrite" ? "Plan" : d.title;
            const detail = block.name === "TodoWrite" ? todoText(block.input?.todos) : d.detail;
            const actId = t.sink.activity({ kind, title, detail });
            t.tools.set(block.id, actId);
            t.running.add(actId);
          } else if (block.type === "text" && !ev.parent_tool_use_id && !t.streamedText && block.text) {
            t.text += block.text;
            t.sink.text(block.text);
          }
        }
        t.streamedText = false;
        return;
      }
      case "user": {
        if (!t) return;
        const content: Json[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const act = t.tools.get(block.tool_use_id);
          if (!act) continue;
          const out = toolResultText(block.content);
          t.running.delete(act);
          t.sink.updateActivity(act, { appendDetail: (out ? `\n${out}` : "").slice(0, 20_000), status: block.is_error ? "error" : "done" });
        }
        return;
      }
      case "result": {
        if (!t) return;
        // A Stop's receipt says which messages it took back, and the hub asks as the reply ends: it waits for that.
        if (t.receipt) {
          t.receipt.result = ev;
          return;
        }
        // Where a duplicated chat's fork ends isn't in the conversation (it's said, and Claude Code exits): the exit
        // tries again without it, in this same turn.
        if (this.forkAtUsed && ev.is_error && FORK_POINT_GONE.test(`${ev.result ?? ""} ${Array.isArray(ev.errors) ? ev.errors.join(" ") : ""}`)) return;
        this.lastResultAt = Date.now();
        if (t.placeholder && !t.realOutput && !ev.is_error) {
          // The result for that notification, not for the human's message: keep the turn open for the real reply.
          t.placeholder = false;
          log.info("ignored Claude Code's placeholder reply to a background task notification; waiting for the real reply");
          return;
        }
        if (ev.session_id && ev.session_id !== this.sessionId) {
          this.sessionId = ev.session_id;
          t.sink.saveSession({ sessionId: ev.session_id });
        }
        const u = ev.usage ?? {};
        // The last API call of the turn is what the conversation fills now; the main model is the one that read the most.
        const lastCall = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : null;
        const main = Object.values((ev.modelUsage ?? {}) as Record<string, Json>).sort((a, b) => contextOf(b) - contextOf(a))[0];
        const c = t.carried;
        const used = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (c?.inputTokens ?? 0),
          outputTokens: (u.output_tokens ?? 0) + (c?.outputTokens ?? 0),
          cachedInputTokens: (u.cache_read_input_tokens ?? 0) + (c?.cachedInputTokens ?? 0),
          costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd + (c?.costUsd ?? 0) : c?.costUsd ?? null,
        };
        // For the spend ledger (spend.ts): this process's raw running total, not `used.costUsd` (which adds what "Read it
        // now" carried, so it would count that part twice), and whether a total of this same process came before the
        // turn's first result: only then is the difference the reply's own cost. A total below the last one means Claude
        // Code started over.
        const total = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null;
        t.ledgerBaseline ??= total !== null && this.lastTotal !== null && total >= this.lastTotal;
        if (total !== null) this.lastTotal = total;
        t.sink.usage({
          ...used,
          costTotalUsd: total,
          costFromBaseline: t.ledgerBaseline,
          ...(lastCall ? { contextTokens: contextOf(lastCall) } : {}),
          ...(typeof main?.contextWindow === "number" ? { contextWindow: main.contextWindow } : {}),
        });
        if (t.readNow && !t.readNow.stopped && !(ev.subtype === "success" && !ev.is_error) && !t.sink.signal.aborted) {
          // The step stopped for "Read it now": Claude Code answers the queued messages next, and that's this same reply.
          t.carried = used;
          for (const id of t.running) t.sink.updateActivity(id, { status: "error" });
          t.running.clear();
          t.readNow.stopped = true;
          t.sink.status("Reading your message", "thinking");
          this.awaitAnswer(t);
          return;
        }
        // Close any tool activity still marked running (e.g. interrupted).
        for (const id of t.running) t.sink.updateActivity(id, { status: "done" });
        if (ev.subtype === "success" && !ev.is_error) {
          const c = t.compacted;
          const compactedNote = c ? `Compacted the conversation${c.pre && c.post ? `: ${Math.round(c.pre / 1000)}k → ${Math.round(c.post / 1000)}k tokens` : ""}.` : "";
          t.done({ ok: true, text: t.text.trim() ? undefined : ev.result || compactedNote || undefined });
        } else {
          const interrupted = ev.subtype === "error_during_execution" && this.interruptSeq > 0;
          const reason = ev.result || (Array.isArray(ev.errors) ? ev.errors.join("; ") : "") || ev.subtype || "error";
          const refused = t.refused || ev.stop_reason === "refusal";
          // A plan or rate limit that resets (never a credit error, which doesn't): the engine waits and carries on.
          const limit =
            interrupted || refused
              ? null
              : claudeLimitHit({ apiErrorStatus: ev.api_error_status, apiError: ev.api_error, text: String(reason), rejected: t.limitWindow ?? null, windows: [...this.windows.values()] });
          // Its sign-in stopped working: the engine starts it again once and carries on. A model
          // server of your own has no sign-in of Claude Code's to renew.
          const auth =
            interrupted || refused || limit || this.ctx.endpoint
              ? null
              : claudeAuthHit({ error: t.syntheticError, apiError: ev.api_error, apiErrorStatus: ev.api_error_status, apiErrorOrigin: ev.api_error_origin ?? t.syntheticOrigin, marksOrigin: claudeMarksOrigin(this.cliVersion), text: String(reason) });
          t.done({ ok: false, error: interrupted ? "stopped" : refused ? refusalError(this.runningModel) : friendlyError(String(reason)), ...(limit ? { limit } : {}), ...(auth ? { auth } : {}) });
        }
        return;
      }
      case "control_response": {
        const id = ev.response?.request_id;
        const waiter = id ? this.controlWaiters.get(id) : undefined;
        if (waiter) {
          this.controlWaiters.delete(id);
          waiter(ev.response);
        }
        return;
      }
      case "keep_alive":
        return;
    }
  }

  /**
   * Claude Code reads a message sent mid-reply at its next step; if the reply ends first, it answers it right after, in
   * a turn of its own. When that turn starts within moments of the reply's end, it's answering the message.
   */
  private steeredAt = 0;
  private lastResultAt = 0;
  async steer(text: string, messageIds?: string[]): Promise<boolean> {
    const t = this.turn;
    // Not before its init has named the chat's model: a process that came up on another one is ended, and the message
    // would go with it (the turn's own message is all a fresh start is given). Nor once the turn is being stopped.
    if (!t || t.settled || t.stopAsked || t.halted || !this.proc || t.proc !== this.proc || !this.modelChecked) return false;
    this.steeredAt = Date.now();
    t.splitNext = true;
    const uuid = crypto.randomUUID();
    this.noteRefs(messageIds, uuid, t.sink);
    t.queued = [...(t.queued ?? []), uuid];
    (t.handed ??= new Map()).set(uuid, messageIds ?? []);
    this.write({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: this.sessionId ?? "default" });
    return true;
  }

  /**
   * "Read it now", as Claude Code's own Send now key does it (interrupt with send_now): Claude Code moves the step it's
   * on out of the way, or ends that part of the turn, and the queued message reaches the model now. It stays queued
   * either way, so it's answered once, by Claude Code, in this reply. A Claude Code without send_now takes it as a plain
   * interrupt, which keeps queued messages too; its receipt says whether this one still was.
   */
  async readNow(): Promise<boolean> {
    const t = this.turn;
    if (!t || t.settled || t.halted || !this.proc || t.proc !== this.proc || !t.queued?.length) return false;
    if (t.readNow) return true;
    const uuid = t.queued[t.queued.length - 1];
    const sendNow = this.capabilities.has("interrupt_send_now_v1");
    const rn: NonNullable<Turn["readNow"]> = { stopped: false, survives: null };
    t.readNow = rn;
    let r: Json;
    try {
      r = await this.control({ subtype: "interrupt", send_now: true, message_uuid: uuid }, 10_000);
    } catch (e) {
      log.info(`Claude Code didn't take "Read it now": ${e instanceof Error ? e.message : e}`);
      if (t.readNow === rn && !rn.stopped) t.readNow = undefined;
      // The step stopped anyway, or the reply ended (it has the message then): nothing failed.
      if (rn.stopped || t.settled || !t.queued?.length) return rn.stopped;
      throw new Error("Claude Code didn't stop the step it's on");
    }
    if (t.readNow !== rn) return true; // it has taken the message in already (or the turn ended)
    // It had taken the message in by now: it's being answered, nothing was stopped.
    if (sendNow && r?.send_now === "nothing_waiting" && !rn.stopped) {
      t.readNow = undefined;
      return false;
    }
    rn.survives = sendNow ? true : Array.isArray(r?.still_queued) ? r.still_queued.includes(uuid) : null;
    this.awaitAnswer(t);
    return true;
  }

  /**
   * The step stopped for "Read it now": Claude Code starts on the queued message at once. If it was no longer queued
   * (an older Claude Code had taken it in as it stopped), or nothing starts and it couldn't say, it's asked for the answer.
   */
  private awaitAnswer(t: Turn) {
    const rn = t.readNow;
    if (!rn?.stopped) return;
    // Called when the step stops and when the receipt comes (in either order): the newest knowledge decides.
    if (rn.timer) clearTimeout(rn.timer);
    rn.timer = undefined;
    if (rn.survives === true) return; // still queued: Claude Code answers it next
    const nudge = () => {
      if (this.turn !== t || t.settled || t.readNow !== rn || !this.proc) return;
      rn.survives = true;
      const uuid = crypto.randomUUID();
      t.queued = [uuid];
      this.write({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text: READ_NOW_NUDGE }] }, parent_tool_use_id: null, session_id: this.sessionId ?? "default" });
    };
    if (rn.survives === false) nudge();
    else rn.timer = setTimeout(nudge, 10_000);
  }

  /**
   * Ended when idle (Engine.endIdle) unless it works on its own or owes a turn of its own (owedTurn), a prompt it
   * scheduled waits to run (it would never run), or its session is open in the Claude app too.
   */
  canEndWhenIdle(): boolean {
    if ((this.turn && !this.turn.settled) || this.forking) return false;
    if ([...this.tasks.values()].some((x) => x.status === "running")) return false;
    // About to answer a report or a message by itself: ending it now would lose that (owedTurn).
    if (this.owedTurn()) return false;
    if (this.waitingJobs()) return false;
    // Ending ours would leave this chat unable to continue the conversation while the app has it open.
    return !(this.proc && this.sessionId && ClaudeDriver.sessionsInUse().has(this.sessionId));
  }

  /** Which Claude Code message (our own uuid) carried each of the human's messages: what a rewind goes back to. */
  private refs = new Map<string, string>();
  private noteRefs(ids: string[] | undefined, uuid: string, sink: TurnSink) {
    if (!ids?.length) return;
    for (const id of ids) this.refs.set(id, uuid);
    // Keep the newest few hundred: rewinds go back a little, not to the start of a long chat.
    const recent = [...this.refs].slice(-300);
    this.refs = new Map(recent);
    sink.saveSession({ msgRefs: Object.fromEntries(recent) });
  }

  private controlWaiters = new Map<string, (r: Json) => void>();
  /** Sends a control request to Claude Code and waits for its answer. */
  private control(request: Json, timeoutMs = 30_000): Promise<Json> {
    const id = `ct_${crypto.randomUUID().slice(0, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(id);
        reject(new Error("Claude Code didn't answer"));
      }, timeoutMs);
      this.controlWaiters.set(id, (r) => {
        clearTimeout(timer);
        if (r?.subtype === "error") reject(new Error(String(r.error ?? "Claude Code refused")));
        else resolve(r?.response ?? {});
      });
      this.write({ type: "control_request", request_id: id, request });
    });
  }

  async rewind(messageId: string): Promise<string[]> {
    const target = this.refs.get(messageId);
    if (!target) throw new Error("This message can't be rewound to: it was sent before rewinding existed, or from another app.");
    if (this.turn && !this.turn.settled) throw new Error("Stop the agent first.");
    if (!this.proc) {
      if (this.sessionId && ClaudeDriver.sessionsInUse().has(this.sessionId)) throw new Error("This conversation is open in the Claude app right now. Close it there first.");
      this.spawn();
    }
    const r = await this.control({ subtype: "rewind_conversation", target_message_uuid: target });
    // Most often its conversation was summarized since (it does that when one gets long): it can't go back past that.
    if (r?.rewound === false) throw new Error("Claude Code can't go back to before that message, usually because it has summarized the conversation since.");
    return [...this.refs].filter(([, uuid]) => uuid === target).map(([id]) => id);
  }

  async interrupt() {
    const t = this.turn;
    if (!this.proc || !t) return;
    // A Stop wins over "Read it now": the turn's next result ends it.
    if (t.readNow?.timer) clearTimeout(t.readNow.timer);
    t.readNow = undefined;
    // The Stop's signal and the hub both ask for it: one request. Resolves as soon as the hub can end the reply.
    await (t.stopAsked ??= this.stopTurn(t));
  }

  /**
   * Stops the turn. A plain interrupt keeps what's queued behind it, so a message steer wrote and Claude Code hasn't read
   * would be answered right after, in a turn of its own: a Stop that didn't stop. So a person's Stop on a Claude Code that
   * says it can (interrupt_cancel_queued_v1) takes those back with `cancel_queued`, and its receipt says which went: they're
   * the person's again, unread, with Answer now (takeUnread). The receipt decides, not `queued`: a message counted as taken
   * in may have reached it just after the request that came back (message_start), and be queued still.
   *
   * Not while a report it owes is queued: `cancel_queued` also drops what has no uuid to list, a task's <task-notification>,
   * and only this process holds that (AgentDriver.owedTurn). It's answered by itself then, with the message: nothing is lost,
   * and it takes another Stop. The same on an older Claude Code, which can't take them back.
   */
  private async stopTurn(t: Turn): Promise<void> {
    this.interruptSeq++;
    // If the CLI doesn't wind down promptly, end the process; the next turn starts a fresh one that resumes the session.
    // A frozen Claude Code ignores SIGINT and SIGTERM, so this ends with SIGKILL, and the process is let go first so the
    // next turn never writes to it.
    setTimeout(() => {
      if (t.settled) return; // it wound down by itself
      if (this.proc === t.proc) this.proc = null;
      void endProcess(t.proc);
      t.done({ ok: false, error: t.halted ?? "stopped" });
    }, ClaudeDriver.graceMs);
    const plain = () => this.write({ type: "control_request", request_id: `int_${this.interruptSeq}`, request: { subtype: "interrupt" } });
    const reportQueued = this.owed?.proc === this.proc && this.owed?.kind === "report";
    if (!t.handed?.size || t.halted || t.dropped || reportQueued || !this.capabilities.has("interrupt_cancel_queued_v1")) return plain();
    const receipt: NonNullable<Turn["receipt"]> = { result: null };
    t.receipt = receipt;
    try {
      const r = await this.control({ subtype: "interrupt", cancel_queued: true }, ClaudeDriver.graceMs);
      const still: string[] = Array.isArray(r?.still_queued) ? r.still_queued : [];
      const cancelled: string[] = Array.isArray(r?.cancelled) ? r.cancelled : (t.queued ?? []).filter((uuid) => !still.includes(uuid));
      for (const uuid of cancelled) this.neverRead.push(...(t.handed.get(uuid) ?? []));
      // Nothing it took back is queued now: it doesn't answer that by itself (unread), and the next report isn't taken for
      // an answer to it.
      t.queued = (t.queued ?? []).filter((uuid) => still.includes(uuid));
      t.splitNext = t.queued.length > 0;
      this.steeredAt = 0;
    } catch (e) {
      // It's stopped all the same, if it can be. If it can't, it's ended (the timer above) and what it hadn't taken in goes
      // with it (unread).
      log.info(`Claude Code didn't answer a Stop that takes queued messages back: ${e instanceof Error ? e.message : e}`);
      if (this.proc === t.proc) plain();
    }
    t.receipt = undefined;
    if (receipt.result && this.turn === t) this.handle(receipt.result);
  }

  /** Where this member's MCP config goes: the hub's run folder, readable only by this user. */
  private mcpConfigPath: string | null = null;
  private writeMcpConfig(config: unknown): string {
    const dir = join(RUN_DIR, "mcp");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${this.ctx.member.id.replace(/[^\w-]/g, "_")}.json`);
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    this.mcpConfigPath = path;
    return path;
  }

  /** Where this member's Claude Code settings go: the hub's run folder, readable only by this user. */
  private settingsPath: string | null = null;
  private writeSettings(settings: unknown): string {
    const dir = join(RUN_DIR, "claude");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${this.ctx.member.id.replace(/[^\w-]/g, "_")}.settings.json`);
    writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
    this.settingsPath = path;
    return path;
  }

  async dispose() {
    this.disposed = true;
    if (this.helperTimer) clearInterval(this.helperTimer);
    this.helperTimer = null;
    this.settleOwed(false);
    // Gone before the process is waited for: a replacement may write them again meanwhile.
    if (this.mcpConfigPath) rmSync(this.mcpConfigPath, { force: true });
    if (this.settingsPath) rmSync(this.settingsPath, { force: true });
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try {
      (p.stdin as import("bun").FileSink).end();
    } catch {
      // ignore
    }
    await endProcess(p);
  }
}

function summarizeInput(name: string, input: Json): string {
  const d = describeToolCall(name, input ?? {});
  return d.title.slice(0, 120);
}

function todoText(todos: Json): string {
  if (!Array.isArray(todos)) return "";
  return todos.map((t: Json) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "·"} ${t.content ?? t.activeForm ?? ""}`).join("\n");
}

/** A reply the model's safety filter stopped: no other model is let answer instead. */
function refusalError(model: string | null): string {
  const name = model ? modelName(model) : "Claude";
  return `${name}'s safety filter stopped this reply. Crosstalk doesn't let another model answer in its place, so nothing else ran: rephrase the request, or pick another model for this chat.`;
}

function friendlyError(s: string): string {
  if (/model substitution|NO_MODEL_FALLBACK/i.test(s)) return `${s.replace(/\s*·\s*unset it to allow the swap/i, "")}. Crosstalk keeps the model you picked instead of switching: pick another model for this chat.`;
  // Its sign-in couldn't be saved because the disk is full: signing in again won't help (Claude Code 2.1.316 says so).
  if (/disk that holds the Claude Code config/i.test(s)) return "Claude Code couldn't renew its sign-in because the hub's disk is full. Free some space (Settings → Storage shows what can go), then tap Try again. Signing in again won't help.";
  // The sign-in went stale (the engine starts Claude Code again and checks it; these words are for when it can't).
  if (/OAuth session expired|could not be refreshed|Login expired|OAuth token revoked/i.test(s)) return "Claude Code's sign-in on the hub stopped working. Sign in to it again (Settings → Agents → Claude Code → Sign in), then tap Try again.";
  if (/another Claude Code process is refreshing it/i.test(s)) return "Claude Code couldn't renew its sign-in: another Claude Code on the hub was renewing it at the same moment. Tap Try again in a minute.";
  if (/not scoped to a workspace|anthropic-workspace-id/i.test(s))
    return "This API key covers your whole organization, so Claude needs to know which workspace to bill. Open Settings → Claude Code → Replace key, and add the workspace ID (wrkspc_…) from the Claude Console → Settings → Workspaces.";
  if (/invalid api key|x-api-key|api key/i.test(s) && !/not logged in|please run \/login/i.test(s)) return `Claude Code couldn't use the API key: ${s}`;
  if (/not logged in|please run \/login|invalid api key|authentication/i.test(s)) return "Claude Code isn't signed in on the hub. Open Settings → Claude Code and sign in.";
  if (/credits_required|usage limit|rate limit/i.test(s)) return `Claude plan limit reached: ${s}`;
  return s;
}

/** Tokens a model call held in its context: everything it read (fresh, cached or newly cached) plus what it wrote. */
function contextOf(u: Json): number {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return n(u?.input_tokens ?? u?.inputTokens) + n(u?.cache_creation_input_tokens ?? u?.cacheCreationInputTokens) + n(u?.cache_read_input_tokens ?? u?.cacheReadInputTokens) + n(u?.output_tokens ?? u?.outputTokens);
}

function taskStatus(s: string): BackgroundTask["status"] {
  return s === "running" || s === "pending" ? "running" : s === "failed" || s === "error" ? "failed" : s === "killed" ? "killed" : s === "stopped" || s === "cancelled" ? "stopped" : "completed";
}

const CRON_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * When a 5-field cron expression (minute hour day-of-month month day-of-week, in local time, like "30 14 28 2 *") next
 * matches after `from`, within a year: how long a one-shot job Claude Code scheduled waits. Null when it can't be read.
 */
export function nextCronTime(cron: string, from: number): number | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parse = (field: string, lo: number, hi: number): Set<number> | null => {
    const out = new Set<number>();
    const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : CRON_NAMES[s] ?? NaN);
    for (const part of field.toLowerCase().split(",")) {
      const m = /^(?:\*|([a-z0-9]+)(?:-([a-z0-9]+))?)(?:\/(\d+))?$/.exec(part);
      if (!m) return null;
      const a = m[1] === undefined ? lo : num(m[1]);
      const b = m[1] === undefined ? hi : m[2] !== undefined ? num(m[2]) : m[3] ? hi : a;
      const step = m[3] ? Number(m[3]) : 1;
      if (!Number.isFinite(a) || !Number.isFinite(b) || step < 1 || a < lo || b > hi || a > b) return null;
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  };
  const [minutes, hours, days, months, weekdays] = [parse(fields[0], 0, 59), parse(fields[1], 0, 23), parse(fields[2], 1, 31), parse(fields[3], 1, 12), parse(fields[4], 0, 7)];
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.has(7)) weekdays.add(0);
  // As cron does it: with both a day of the month and a day of the week given, either one matches.
  const anyDay = fields[2].startsWith("*");
  const anyWeekday = fields[4].startsWith("*");
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = from + 366 * 24 * 3600_000;
  while (d.getTime() <= end) {
    const day = anyDay && anyWeekday ? true : anyDay ? weekdays.has(d.getDay()) : anyWeekday ? days.has(d.getDate()) : days.has(d.getDate()) || weekdays.has(d.getDay());
    if (months.has(d.getMonth() + 1) && day) {
      for (let h = d.getHours(); h < 24; h++) {
        if (!hours.has(h)) continue;
        for (let m = h === d.getHours() ? d.getMinutes() : 0; m < 60; m++) {
          if (!minutes.has(m)) continue;
          const at = new Date(d);
          at.setHours(h, m, 0, 0);
          return at.getTime();
        }
      }
    }
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  return null;
}

/** A sink that shows nothing and keeps nothing: a reply the hub stopped as it started (dropOwnTurn). */
function quietSink(): TurnSink {
  return {
    text() {},
    setText() {},
    activity: () => "",
    updateActivity() {},
    approval: async () => "deny",
    usage() {},
    rateLimit() {},
    status() {},
    saveSession() {},
    signal: new AbortController().signal,
  };
}

/** Output that means the model is working (Claude Code's own placeholder replies and bookkeeping don't count). */
function startsWork(ev: Json): boolean {
  if (ev.parent_tool_use_id) return false;
  if (ev.type === "stream_event") return ev.event?.type === "message_start" || ev.event?.type === "content_block_start";
  if (ev.type === "assistant") return ev.message?.model !== "<synthetic>";
  return false;
}

/**
 * Output that means a request Claude Code made was refused before the model said anything: a *rejected*
 * rate_limit_event, its synthetic error reply (`error` set: "rate_limit", "server_error"…), or a failed result. Only
 * counted while it owes a turn (handle): that's the turn's request failing.
 */
function refusedFirst(ev: Json): boolean {
  if (ev.parent_tool_use_id) return false;
  if (ev.type === "rate_limit_event") return ev.rate_limit_info?.status === "rejected";
  if (ev.type === "assistant") return ev.message?.model === "<synthetic>" && !!ev.error;
  if (ev.type === "result") return ev.is_error === true;
  return false;
}

/**
 * A helper agent's model, effort and context, from the end of its transcript: the newest reply names the model and
 * carries its token counts (what it read plus what it wrote is how full its context is); every line notes the effort.
 */
export function helperDetails(path: string, windowOf?: (model: string) => number | null | undefined): Pick<BackgroundTask, "model" | "effort" | "contextTokens" | "contextWindow"> | null {
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let model: string | null = null;
  let effort: string | null = null;
  let tokens: number | null = null;
  for (const line of text.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    let ev: Json;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!effort && typeof ev.effort === "string") effort = ev.effort;
    if (ev.type === "assistant" && ev.message?.model && ev.message.model !== "<synthetic>" && !model) {
      model = String(ev.message.model);
      if (ev.message.usage) tokens = contextOf(ev.message.usage) || null;
    }
    if (model && effort) break;
  }
  if (!model && !effort) return null;
  // The window Claude Code gives that model (from its model list): models differ (Sonnet 4.6 has 200k, Opus 5.5 1M).
  const contextWindow = (model && windowOf?.(model)) || null;
  return { model, effort, contextTokens: tokens, contextWindow };
}
