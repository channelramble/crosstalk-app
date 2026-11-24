// Helpers on another account: a chat's agent hands a piece of work to a helper that Crosstalk runs for it on the account
// the person chose ("Helpers run on" in the chat's settings; `member.config.helpersOn`), instead of its own helpers, which
// always spend the chat's own account. A helper is the one-shot runner (oneshot.ts) that Ask others and an agent's quick
// question use, with three differences: it may do what the chat itself may do without asking (never more), what it wants
// beyond that becomes a card in the chat, and it gets an hour instead of three minutes. Its member is never saved, so the
// hub's tools refuse it (a helper can't start helpers), and it keeps no session.
//
// The report reaches the agent that started it exactly once: as the result of the call that waits for it (start_helper,
// helper_result); or, when the reply ended without reading it, as a reply of the agent's own that the engine starts
// (Engine.wake); or with the agent's next turn when the person stopped things (Engine.carry). What a restart would lose is
// kept in kv `helpers.kept`: the next hub tells each agent what didn't finish and hands over reports nobody had read.

import {
  CROSSTALK_HELPER,
  PROVIDER_INFO,
  agentSettingsPath,
  helperAccountLabel,
  helpersOf,
  limitResetTime,
  settingsPath,
  type AgentAccount,
  type ApprovalDecision,
  type BackgroundTask,
  type CostBasis,
  type HelpersOn,
  type Member,
  type Room,
} from "@crosstalk/shared";
import type { AgentDriver, ApprovalRequest } from "./agents/driver";
import type { App } from "./app";
import type { AgentProcess } from "./memory";
import { ONE_SHOT_GRACE_MS, oneShotCost, runOneShot, type OneShotResult } from "./oneshot";
import { newId } from "./util/ids";
import { logger } from "./util/log";

const log = logger("helpers");

const KEPT = "helpers.kept";
const REPORT_MAX = 30_000;
const TASK_MAX = 20_000;

/** How many may work at once (in one chat, on the machine), how long one may take, how long a call waits, how long a finished one stays listed. */
export interface HelperLimits {
  perChat: number;
  running: number;
  timeoutMs: number;
  graceMs: number;
  waitMs: number;
  listedMs: number;
}

interface Run {
  id: string;
  roomId: string;
  /** The agent that started it. */
  memberId: string;
  /** The reply that started it: where a card of its goes once that reply has ended. */
  turnId: string | null;
  name: string;
  on: HelpersOn;
  /** Its account as the person knows it ("Claude API key"). */
  label: string;
  /** The model it runs on, as the price lists know it (null: unknown). */
  model: string | null;
  abort: AbortController;
  status: BackgroundTask["status"];
  /** Who stopped it, when someone did. */
  stoppedBy: "person" | "restart" | null;
  /** What the agent that started it is told when it's over. */
  report: string | null;
  /** That agent has been told. */
  delivered: boolean;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  steps: number;
  lastStep: string | null;
  tokens: number | null;
  costUsd: number | null;
  costBasis: CostBasis | null;
  /** Its unsaved member, while it runs (Claude Code's permission prompt names it). */
  helperId: string | null;
  driver: AgentDriver | null;
  over: Promise<void>;
  emitTimer: ReturnType<typeof setTimeout> | null;
}

interface Kept {
  roomId: string;
  memberId: string;
  name: string;
  label: string;
  state: "running" | "done";
  report?: string;
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…(cut short)` : text);
const quoted = (name: string) => `“${name}”`;

function elapsedWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** A short name for a piece of work, from the words that describe it. */
function nameOf(given: unknown, task: string): string {
  const said = typeof given === "string" ? given.replace(/\s+/g, " ").trim() : "";
  if (said) return said.slice(0, 80);
  const first = task.replace(/\s+/g, " ").trim();
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

export class Helpers {
  readonly limits: HelperLimits = { perChat: 4, running: 8, timeoutMs: 60 * 60_000, graceMs: ONE_SHOT_GRACE_MS, waitMs: 10 * 60_000, listedMs: 30 * 60_000 };
  private runs = new Map<string, Run>();
  private closing = false;

  constructor(private readonly app: App) {}

  // ---------------------------------------------------------------------------------------------- who helps

  /** Who does helper work for this agent when it isn't its own helpers (the chat's "Helpers run on"); null: its own. */
  on(member: Member): HelpersOn | null {
    return helpersOf(member.config);
  }

  private account(on: Pick<HelpersOn, "provider" | "account">): AgentAccount | null {
    return this.app.providers.accounts().find((a) => a.provider === on.provider && a.id === on.account) ?? null;
  }

  /** The account as the person knows it: "Claude API key", "Codex", "DeepSeek". */
  label(on: Pick<HelpersOn, "provider" | "account">): string {
    const all = this.app.providers.accounts();
    const a = all.find((x) => x.provider === on.provider && x.id === on.account);
    return a ? helperAccountLabel(a, all) : "an account that was removed";
  }

  /** What the agent may do when that account can't run a helper, in the words it's told. */
  private otherwise(on: HelpersOn): string {
    return on.fallback !== false
      ? "The person lets you use your own helpers when this happens: do this piece of work with them, or yourself."
      : "The person chose that your own helpers aren't used instead: do this piece yourself if it's small, and tell them what happened and what to do about it.";
  }

  /** Why this account can't run a helper now, in plain words that name it and say what to do; null when it can. */
  problem(on: HelpersOn): string | null {
    const { app } = this;
    const a = this.account(on);
    if (!a) return `The account picked for helpers isn't on this machine any more. The person can pick another under "Helpers run on" in this chat's settings.`;
    const label = this.label(on);
    const agent = PROVIDER_INFO[on.provider]?.name ?? on.provider;
    const where = a.kind === "endpoint" ? settingsPath("ai-services") : agentSettingsPath(on.provider);
    if (on.provider !== "builtin" && !app.providers.which(on.provider)) return `${agent}, which runs ${label}, isn't installed on this machine. The person can install it under ${agentSettingsPath(on.provider)}, or pick another account for helpers.`;
    if (a.signedIn === false) return `${label} is signed out. The person can sign in under ${where}, or pick another account for helpers.`;
    const limit = app.spend.checkBudget(on.provider, on.account);
    if (limit) return `${limit.replace(/, so this reply didn't start\.?$/, "")}, so a helper can't start on it. The person can raise the limit under ${settingsPath("costs")}, or pick another account for helpers.`;
    const full = app.store.getUsage(on.provider, on.account)?.windows.find((w) => (w.usedPercent ?? 0) >= 100 && (!w.resetsAt || w.resetsAt > Date.now()));
    if (full) return `${label}'s plan is at 100% of its ${full.label} limit${full.resetsAt ? ` until ${limitResetTime(full.resetsAt)}` : ""}, so a helper can't start on it.`;
    return null;
  }

  /** What the chat's agent is told about its helpers, in its standing instructions; null when they're its own. */
  note(member: Member): { label: string; note: string; only: boolean } | null {
    const on = this.on(member);
    if (!on) return null;
    const label = this.label(on);
    const only = on.fallback === false;
    const note = [
      `Helper work in this chat is done by helpers on ${label}: the person chose that, so it isn't yours to change. When you would hand a piece of work to a helper (a subagent, a spawned agent, a workflow agent), call start_helper instead: say the task in full (the helper can't see this conversation), give it a short name, and name the files that matter.`,
      `It works in this chat's folder with what this chat may do without asking, and its final report comes back as the tool's result. To run several at once, start each with wait: false, then call helper_result to collect their reports; if your reply ends first, each report is given to you when its helper finishes. At most ${this.limits.perChat} at a time.`,
      only
        ? `Don't use your own helpers in this chat. If start_helper says ${label} can't run one, do the work yourself or tell the person what it said.`
        : `Use your own helpers only when start_helper says ${label} can't run one.`,
    ].join(" ");
    return { label, note, only };
  }

  // ---------------------------------------------------------------------------------------------- starting one

  private active(roomId?: string): Run[] {
    return [...this.runs.values()].filter((r) => r.status === "running" && (!roomId || r.roomId === roomId));
  }

  /** The start_helper tool. Always resolves with words for the agent that called it; never throws for what it can say. */
  async start(caller: Member, args: { task?: unknown; name?: unknown; files?: unknown; wait?: unknown }, signal?: AbortSignal): Promise<{ text: string; error?: boolean }> {
    const { app } = this;
    const member = app.store.getMember(caller.id);
    const room = member ? app.store.getRoom(member.roomId) : null;
    if (!member || !room) return { text: "Crosstalk couldn't find this chat.", error: true };
    const on = this.on(member);
    if (!on) return { text: "This chat's helpers are your own now (the person changed \"Helpers run on\"): use them as usual.", error: true };
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) return { text: "Say the task: what the helper should do, in full, since it can't see this conversation.", error: true };
    if (this.closing) return { text: "Crosstalk is restarting, so no helper was started. Do this piece yourself, or try again in a minute.", error: true };
    const why = this.problem(on);
    if (why) {
      log.info(`@${member.handle} in ${room.name}: no helper on ${this.label(on)} (${why})`);
      return { text: `No helper was started: ${why} ${this.otherwise(on)}`, error: true };
    }
    if (this.active(room.id).length >= this.limits.perChat) return { text: `${this.limits.perChat} helpers are already working in this chat, the most at once. Call helper_result to wait for one, then start this one.`, error: true };
    if (this.active().length >= this.limits.running) return { text: `${this.limits.running} helpers are already working on this machine, the most at once. Call helper_result to wait for yours, or do this piece yourself.`, error: true };

    const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string" && !!f.trim()).slice(0, 40) : [];
    const label = this.label(on);
    const known = app.providers.knownModel(on.provider, on.account, on.model ?? null);
    const run: Run = {
      id: newId("hp"),
      roomId: room.id,
      memberId: member.id,
      turnId: app.engine.runningTurnOf(member.id)?.id ?? null,
      name: nameOf(args.name, task),
      on,
      label,
      model: known?.resolvedModel ?? known?.id ?? on.model ?? this.account(on)?.endpoint?.models?.[0] ?? null,
      abort: new AbortController(),
      status: "running",
      stoppedBy: null,
      report: null,
      delivered: false,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
      steps: 0,
      lastStep: null,
      tokens: null,
      costUsd: null,
      costBasis: null,
      helperId: null,
      driver: null,
      over: Promise.resolve(),
      emitTimer: null,
    };
    this.runs.set(run.id, run);
    this.keep(run);
    this.emit(run.memberId);
    log.info(`@${member.handle} in ${room.name} started a helper on ${label} (${run.id}): ${run.name}`);
    const prompt = [
      cut(task, TASK_MAX),
      files.length ? `Files that matter:\n${files.map((f) => `- ${f}`).join("\n")}` : null,
      `(You are a helper for another coding agent, working in ${room.cwd} on the person's machine. Do this piece of work, then end with a short report: what you did, what you found, and anything left undone. The report is all the other agent sees of your work, and you can't ask it or the person questions.)`,
    ]
      .filter(Boolean)
      .join("\n\n");
    run.over = this.execute(run, room, member, prompt).catch((e) => log.warn(`a helper ended badly: ${e instanceof Error ? e.message : e}`));
    if (args.wait === false) return { text: `Started helper ${quoted(run.name)} on ${label} (id ${run.id}). Carry on with other work; call helper_result to wait for its report. If your reply ends first, the report is given to you when the helper finishes.` };
    return this.collect(member.id, [run], this.limits.waitMs, signal);
  }

  /** The helper_result tool: waits for one helper (or all of this agent's still working) and hands over what isn't read yet. */
  async result(caller: Member, args: { id?: unknown; wait_minutes?: unknown }, signal?: AbortSignal): Promise<{ text: string; error?: boolean }> {
    const mine = [...this.runs.values()].filter((r) => r.memberId === caller.id);
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const which = id ? mine.filter((r) => r.id === id) : mine.filter((r) => r.status === "running" || !r.delivered);
    if (id && !which.length) return { text: `There's no helper ${id} in this chat. Leave id out to wait for every helper still working.`, error: true };
    if (!which.length) return { text: "No helper of yours is working, and every report has been given to you." };
    const minutes = typeof args.wait_minutes === "number" && Number.isFinite(args.wait_minutes) ? Math.max(0, Math.min(10, args.wait_minutes)) : null;
    return this.collect(caller.id, which, minutes === null ? this.limits.waitMs : Math.min(this.limits.waitMs, minutes * 60_000), signal);
  }

  /** Waits for these to end (at most `waitMs`, or until the call is given up), then hands over each finished one's report, once. */
  private async collect(memberId: string, runs: Run[], waitMs: number, signal?: AbortSignal): Promise<{ text: string; error?: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = new Promise<void>((res) => {
      timer = setTimeout(res, waitMs);
      if (signal?.aborted) res();
      else signal?.addEventListener("abort", () => res(), { once: true });
    });
    // The reply that waits here is alive, however quiet its agent is meanwhile (the engine's stall watchdog).
    const alive = setInterval(() => this.app.engine.keepAlive(memberId), 30_000);
    await Promise.race([Promise.all(runs.map((r) => r.over)), gone]);
    clearTimeout(timer);
    clearInterval(alive);
    // The agent gave up the call (its reply was stopped): nothing is handed over into the void.
    if (signal?.aborted || this.closing) return { text: "Stopped waiting.", error: true };
    const parts: string[] = [];
    let failed = false;
    for (const r of runs) {
      if (r.status === "running") {
        parts.push(`Helper ${quoted(r.name)} on ${r.label} (id ${r.id}) is still working after ${elapsedWords(Date.now() - r.startedAt)}${r.lastStep ? `; its last step: ${r.lastStep}` : ""}. Call helper_result to keep waiting, or carry on: its report is given to you when it finishes.`);
        continue;
      }
      if (r.delivered) {
        parts.push(`Helper ${quoted(r.name)} (id ${r.id}): you already have its report.`);
        continue;
      }
      if (r.status !== "completed") failed = true;
      parts.push(r.report ?? "");
      this.handedOver(r);
    }
    return { text: parts.join("\n\n---\n\n"), ...(failed && runs.length === 1 ? { error: true } : {}) };
  }

  private handedOver(run: Run) {
    run.delivered = true;
    this.forget(run.id);
  }

  // ---------------------------------------------------------------------------------------------- running one

  private async execute(run: Run, room: Room, caller: Member, prompt: string) {
    const { app } = this;
    const { on } = run;
    let result: OneShotResult;
    try {
      result = await runOneShot(app, {
        room,
        provider: on.provider,
        account: on.account,
        model: on.model ?? null,
        effort: on.effort ?? null,
        prompt,
        systemNote: null,
        signal: run.abort.signal,
        timeoutMs: this.limits.timeoutMs,
        graceMs: this.limits.graceMs,
        // What the chat may do without asking, never more; anything beyond it is a card in the chat.
        permissionMode: caller.permissionMode,
        approval: (req, opts) => this.approval(run, req, opts?.signal),
        onMember: (m) => (run.helperId = m.id),
        onDriver: (d) => (run.driver = d),
        onStep: (step) => {
          run.steps++;
          run.lastStep = step.title.replace(/\s+/g, " ").trim().slice(0, 160);
          this.emitSoon(run);
        },
        onUsage: (u) => {
          run.tokens = u.inputTokens + u.outputTokens || run.tokens;
        },
      });
    } catch (e) {
      result = { ok: false, text: "", error: e instanceof Error ? e.message : String(e), stopped: false, timedOut: false, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null } };
    }
    run.driver = null;
    run.helperId = null;
    run.endedAt = Date.now();
    if (run.emitTimer) clearTimeout(run.emitTimer);
    run.emitTimer = null;
    this.book(run, room, result);
    const text = cut(result.text.trim(), REPORT_MAX);
    const head = `Helper ${quoted(run.name)} on ${run.label}`;
    const took = elapsedWords(run.endedAt - run.startedAt);
    const partial = text ? `\n\nWhat it had written:\n${text}` : "";
    if (result.ok && text) {
      run.status = "completed";
      run.report = `${head} finished in ${took}. Its report:\n\n${text}`;
    } else if (run.stoppedBy === "person" || (result.stopped && !run.stoppedBy)) {
      run.status = "stopped";
      run.stoppedBy ??= "person";
      run.error = "You stopped it.";
      run.report = `${head} was stopped by the person before it finished. Don't start it again unless they ask.${partial}`;
    } else if (run.stoppedBy === "restart") {
      run.status = "stopped";
      run.error = "Crosstalk restarted before it finished.";
      run.report = `${head} was stopped when Crosstalk restarted, before it finished. Start it again if the work is still needed.${partial}`;
    } else {
      run.status = "failed";
      const minutes = Math.max(1, Math.round(this.limits.timeoutMs / 60_000));
      const why = result.ok
        ? "it finished without writing a report"
        : result.timedOut
          ? `it took longer than ${minutes} ${minutes === 1 ? "minute" : "minutes"}, so Crosstalk stopped it`
          : result.limit
            ? `${run.label} ${result.limit.kind === "rate" ? "hit a rate limit" : "is out of messages"}${result.limit.resetsAt && result.limit.resetsAt > Date.now() ? ` until ${limitResetTime(result.limit.resetsAt)}` : ""}`
            : result.auth
              ? `${run.label} ${this.account(on)?.kind === "signin" ? "is signed out" : "refused its key"} (the person can check it under ${this.account(on)?.kind === "endpoint" ? settingsPath("ai-services") : agentSettingsPath(on.provider)})`
              : (result.error ?? "it stopped without saying why").replace(/[.\s]+$/, "");
      run.error = `${why[0].toUpperCase()}${why.slice(1)}.`;
      run.report = `${head} couldn't finish: ${why}. ${this.otherwise(on)}${partial}`;
    }
    log.info(`helper ${run.id} (${run.name}) on ${run.label}: ${run.status}${run.error ? ` (${run.error})` : ""}`);
    if (this.closing) return; // the next hub says what was lost (restore)
    this.keep(run);
    this.emit(run.memberId);
    setTimeout(() => {
      this.emit(run.memberId);
      if (this.runs.get(run.id) === run && run.delivered) this.runs.delete(run.id);
    }, this.limits.listedMs).unref?.();
    // After any call that was waiting for it has taken it: what nobody took goes to the agent another way.
    setTimeout(() => this.deliver(run), 0);
  }

  /** A card in the chat for what the helper may not do without asking. */
  private approval(run: Run, req: ApprovalRequest, gone?: AbortSignal): Promise<ApprovalDecision> {
    const signal = gone ? AbortSignal.any([run.abort.signal, gone]) : run.abort.signal;
    return this.app.engine.helperApproval(run.memberId, run.turnId, { kind: req.kind, title: `Helper on ${run.label}: ${req.title}`.slice(0, 300), detail: req.detail }, signal);
  }

  /** The unsaved member of a helper that is running now (Claude Code's permission prompt comes back through the hub's tools by its id). */
  helperMember(memberId: string): { run: string } | null {
    for (const r of this.runs.values()) if (r.helperId === memberId && r.status === "running") return { run: r.id };
    return null;
  }

  /** That prompt: a card in the chat of the agent that started the helper. */
  approvalFor(helperMemberId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const run = [...this.runs.values()].find((r) => r.helperId === helperMemberId && r.status === "running");
    return run ? this.approval(run, req) : Promise.resolve("deny");
  }

  /** What it used goes in the ledger on its own account, under the chat it worked for. */
  private book(run: Run, room: Room, r: OneShotResult) {
    const used = r.usage.inputTokens > 0 || r.usage.outputTokens > 0 || (r.usage.costUsd ?? 0) > 0;
    if (!used && !(r.ok && r.text)) return;
    const { provider, account } = run.on;
    try {
      const cost = oneShotCost(this.app, { provider, account, model: run.model }, r.usage);
      run.costUsd = cost.costUsd;
      run.costBasis = cost.basis;
      run.tokens = cost.inputTokens + cost.outputTokens || run.tokens;
      this.app.spend.record({ source: "helper", provider, account, roomId: room.id, chatName: this.app.store.getRoom(room.id)?.name ?? room.name, askId: run.id, model: run.model, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, cachedTokens: r.usage.cachedInputTokens, costUsd: cost.costUsd, basis: cost.basis });
    } catch (e) {
      log.warn(`couldn't keep a helper's cost: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---------------------------------------------------------------------------------------------- the report's way back

  /** A finished helper whose report no call took: to the agent now, unless its reply still runs (then as that ends: replyOver). */
  private deliver(run: Run) {
    if (run.delivered || this.closing || this.runs.get(run.id) !== run) return;
    const { engine } = this.app;
    if (engine.runningTurns(run.roomId).some((t) => t.memberId === run.memberId)) return;
    this.hand([run], run.stoppedBy === "person" ? "carry" : "wake");
  }

  /** The agent's reply ended: reports it didn't read go to it now, in a reply of its own, or with its next turn after a Stop or a failure. */
  replyOver(room: Room, member: Member, status: string) {
    const unread = [...this.runs.values()].filter((r) => r.memberId === member.id && r.status !== "running" && !r.delivered);
    if (!unread.length || this.closing) return;
    // Not from inside the engine's own end-of-reply work.
    setTimeout(() => {
      const still = unread.filter((r) => !r.delivered && this.runs.get(r.id) === r);
      if (still.length) this.hand(still, status === "done" && !still.every((r) => r.stoppedBy === "person") ? "wake" : "carry");
    }, 0);
  }

  private hand(runs: Run[], how: "wake" | "carry") {
    const { app } = this;
    const member = app.store.getMember(runs[0].memberId);
    const room = member ? app.store.getRoom(member.roomId) : null;
    for (const r of runs) this.handedOver(r);
    if (!member || !room) return;
    const reports = runs.map((r) => r.report ?? "").join("\n\n---\n\n");
    if (how === "carry") {
      app.engine.carry(member.id, `(While you weren't working: ${runs.length === 1 ? "a helper you started is over" : "helpers you started are over"}.)\n\n${reports}`);
      return;
    }
    const agent = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
    const one = runs.length === 1 ? runs[0] : null;
    const say = one
      ? `A helper on ${one.label} ${one.status === "completed" ? "finished" : "couldn't finish"} ${quoted(one.name)}. ${agent} is reading its report.`
      : `${runs.length} helpers reported back. ${agent} is reading their reports.`;
    const note = `${one ? "A helper you started reported back" : "Helpers you started reported back"} after your reply ended.\n\n${reports}\n\nCarry on from here with what the person asked for. If nothing is left to do, tell them briefly what the ${one ? "helper" : "helpers"} found.`;
    app.engine.wake(member.id, note, say, runs.map((r) => ({ title: `Helper on ${r.label}: ${r.name}`, detail: r.report ?? "" })));
  }

  // ---------------------------------------------------------------------------------------------- stopping

  /** Ends the helpers an agent (or every agent of a chat) started that are still working. Returns how many. */
  stop(roomId: string, memberId?: string): number {
    let n = 0;
    for (const r of this.active(roomId)) {
      if (memberId && r.memberId !== memberId) continue;
      r.stoppedBy = "person";
      r.abort.abort();
      n++;
    }
    if (n) log.info(`${n} helper${n === 1 ? "" : "s"} stopped by the person`);
    return n;
  }

  /** A chat (or one of its agents) is gone: its helpers go with it, and nothing of them is handed over. */
  removed(roomId: string, memberId?: string) {
    for (const r of [...this.runs.values()]) {
      if (r.roomId !== roomId || (memberId && r.memberId !== memberId)) continue;
      r.delivered = true;
      r.stoppedBy ??= "person";
      r.abort.abort();
      this.runs.delete(r.id);
      this.forget(r.id);
      this.app.engine.setHelperTasks(roomId, r.memberId, []);
    }
  }

  /** The hub is stopping: every helper is ended with its process. What didn't finish is in kv for the next hub (restore). */
  async shutdown(): Promise<void> {
    this.closing = true;
    const live = this.active();
    for (const r of live) {
      r.stoppedBy = "restart";
      r.abort.abort();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(live.map((r) => r.over)), new Promise((res) => (timer = setTimeout(res, Math.min(this.limits.graceMs, 3_000))))]);
    clearTimeout(timer);
    await Promise.allSettled(live.map((r) => r.driver?.dispose()));
    for (const r of this.runs.values()) if (r.emitTimer) clearTimeout(r.emitTimer);
  }

  /**
   * What the last hub left: helpers that were working when it stopped (they didn't finish) and reports nobody had read.
   * Each agent is told in a reply of its own, with a line in the chat saying why. Called once everything is up.
   */
  restore() {
    const kept = this.kept();
    const ids = Object.keys(kept);
    if (!ids.length) return;
    this.app.store.kvDelete(KEPT);
    const by = new Map<string, Kept[]>();
    for (const k of Object.values(kept)) by.set(k.memberId, [...(by.get(k.memberId) ?? []), k]);
    for (const [memberId, list] of by) {
      const member = this.app.store.getMember(memberId);
      const room = member ? this.app.store.getRoom(member.roomId) : null;
      if (!member || !room) continue;
      const lost = list.filter((k) => k.state === "running");
      const reports = list.map((k) => (k.state === "running" ? `Helper ${quoted(k.name)} on ${k.label} was stopped when Crosstalk restarted, before it finished. Start it again if the work is still needed.` : k.report ?? ""));
      const agent = room.chat?.group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? `@${member.handle}`;
      const say = lost.length
        ? `Crosstalk restarted while ${lost.length === 1 ? `a helper on ${lost[0].label} was working (${quoted(lost[0].name)})` : `${lost.length} helpers were working`}. ${lost.length === 1 ? "It" : "They"} didn't finish; ${agent} has been told.`
        : `A helper reported back while Crosstalk restarted. ${agent} is reading its report.`;
      const note = `Crosstalk restarted. About the helpers you started:\n\n${reports.join("\n\n---\n\n")}\n\nCarry on from here with what the person asked for.`;
      this.app.engine.wake(member.id, note, say);
    }
  }

  // ---------------------------------------------------------------------------------------------- what's shown and kept

  private task(r: Run): BackgroundTask {
    return {
      id: r.id,
      kind: CROSSTALK_HELPER,
      description: r.name,
      agentType: null,
      workflow: null,
      background: true,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      tokens: r.tokens,
      toolUses: r.steps || null,
      lastTool: null,
      summary: r.status === "running" ? r.lastStep : r.status === "completed" ? cut((r.report ?? "").replace(/^.*? Its report:\n\n/s, ""), 4000) : null,
      error: r.error,
      model: r.on.model ?? r.model,
      effort: r.on.effort ?? null,
      account: r.label,
      costUsd: r.costUsd,
      costBasis: r.costBasis,
    };
  }

  private emit(memberId: string) {
    const now = Date.now();
    const mine = [...this.runs.values()].filter((r) => r.memberId === memberId && (r.status === "running" || now - (r.endedAt ?? 0) < this.limits.listedMs));
    const roomId = mine[0]?.roomId ?? this.app.store.getMember(memberId)?.roomId;
    if (roomId) this.app.engine.setHelperTasks(roomId, memberId, mine.map((r) => this.task(r)));
  }

  private emitSoon(run: Run) {
    run.emitTimer ??= setTimeout(() => {
      run.emitTimer = null;
      if (run.status === "running" && !this.closing) this.emit(run.memberId);
    }, 500);
  }

  /** The agent processes helpers run in, for the memory guard: counted under the chat of the agent that started them. */
  processes(): AgentProcess[] {
    const out: AgentProcess[] = [];
    for (const r of this.active()) {
      let pids: number[] = [];
      try {
        pids = r.driver?.pids?.() ?? [];
      } catch {
        // Between processes: nothing to count this time.
      }
      if (!pids.length) continue;
      const room = this.app.store.getRoom(r.roomId);
      out.push({ memberId: r.memberId, roomId: r.roomId, agent: `a helper on ${r.label}`, chat: room?.name ?? "a chat", pids, replying: true, browsing: false });
    }
    return out;
  }

  private kept(): Record<string, Kept> {
    try {
      const v = JSON.parse(this.app.store.kvGet(KEPT) ?? "{}");
      return v && typeof v === "object" ? (v as Record<string, Kept>) : {};
    } catch {
      return {};
    }
  }

  private keep(run: Run) {
    try {
      if (run.delivered) return this.forget(run.id);
      const all = this.kept();
      all[run.id] = { roomId: run.roomId, memberId: run.memberId, name: run.name, label: run.label, state: run.status === "running" ? "running" : "done", ...(run.report ? { report: run.report } : {}) };
      this.app.store.kvSet(KEPT, JSON.stringify(all));
    } catch (e) {
      log.warn(`couldn't keep a helper for a restart: ${e instanceof Error ? e.message : e}`);
    }
  }

  private forget(id: string) {
    try {
      const all = this.kept();
      if (!(id in all)) return;
      delete all[id];
      if (Object.keys(all).length) this.app.store.kvSet(KEPT, JSON.stringify(all));
      else this.app.store.kvDelete(KEPT);
    } catch (e) {
      log.warn(`couldn't forget a helper: ${e instanceof Error ? e.message : e}`);
    }
  }
}
