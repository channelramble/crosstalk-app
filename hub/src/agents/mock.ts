import type { BackgroundTask } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "./driver";

/**
 * Scripted agent for tests and demos. Behaviour comes from member.config:
 *   reply      text to answer with ({last} = last line of the prompt digest, {handle} = own handle)
 *   handoff    handle to @mention at the end of each reply (relay testing)
 *   pingpong   keep handing off even when the trigger came from the handoff target
 *   approval   ask for approval before "running a command"
 *   usedPercent  plan usage to report (default: 5% more each turn)
 *   fail       end the turn with an error
 *   failTurns  the same, only for these replies (1 for its first)
 *   limit      end the turn as a usage limit that resets: { kind?, label?, resetsAt?, times?, afterMs? }
 *              (times: how many of the first turns hit it, default every one; resetsAt: epoch ms, null = nothing said;
 *              afterMs: how long the reply runs before the limit stops it, default 50)
 *   auth       end the turn as a sign-in that stopped working (stale-login.ts): { kind?, times?, after?, midway? }
 *              (after: how many turns go through first, default none; times: how many turns then hit it, default every
 *              one; both counted across the member's processes, in its session; midway: it fails after a step of its
 *              own and some words, as when the sign-in can't be renewed between two steps of a long reply, instead of
 *              as the turn starts)
 *   helpers    after its first reply, a background helper keeps working for { ms } (as Claude Code's do), reported
 *              through onTasks, so settings changed meanwhile wait for it
 *   steer      it takes a message in the middle of a reply (AgentDriver.steer), reads it when it's written what it was
 *              writing, and answers below it, as Claude Code and Codex do; without this it has no mid-reply form at all
 *   costUsd    what each reply reports it cost (default 0)
 *   delayMs    total streaming time (default 900)
 *   delays     the same per reply (the last repeats), in place of delayMs
 */
export class MockDriver implements AgentDriver {
  readonly provider = "mock" as const;
  private turns = 0;
  private abortCurrent: (() => void) | null = null;
  private helperTimer: ReturnType<typeof setTimeout> | null = null;
  /** A reply is under way, and what was handed to it meanwhile (config.steer). */
  private replying = false;
  private handed: { text: string; ids: string[] }[] = [];
  steer?: AgentDriver["steer"];

  constructor(private ctx: DriverContext) {
    if ((ctx.member.config as { steer?: boolean }).steer) {
      this.steer = async (text, ids) => {
        if (!this.replying) return false;
        this.handed.push({ text, ids: ids ?? [] });
        return true;
      };
    }
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    this.replying = true;
    try {
      return await this.reply(input, sink);
    } finally {
      this.replying = false;
    }
  }

  private async reply(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    const cfg = this.ctx.member.config as {
      reply?: string;
      replies?: string[];
      handoff?: string;
      pingpong?: boolean;
      approval?: boolean;
      fail?: boolean;
      failTurns?: number[];
      limit?: { kind?: "usage" | "rate"; label?: string | null; resetsAt?: number | null; times?: number; afterMs?: number };
      auth?: { kind?: "stale" | "busy" | "signedOut"; times?: number; after?: number; midway?: boolean };
      helpers?: { ms?: number };
      usedPercent?: number;
      costUsd?: number;
      delayMs?: number;
      delays?: number[];
    };
    this.turns++;
    if (!this.ctx.session.mockSession) sink.saveSession({ mockSession: `mock-${this.ctx.member.id}` });
    const delay = cfg.delays?.length ? cfg.delays[Math.min(this.turns, cfg.delays.length) - 1] : cfg.delayMs ?? 900;
    const abort = new Promise<void>((res) => {
      this.abortCurrent = res;
      sink.signal.addEventListener("abort", () => res(), { once: true });
    });
    const sleep = (ms: number) => Promise.race([Bun.sleep(ms), abort]);

    // A sign-in that stopped working, as the real drivers report one (stale-login.ts). Counted in the member's session,
    // so a fresh process (the engine starts one) knows how many went before it. It fails as the turn starts (Claude Code
    // refuses before any request), or with `midway` after a step and some words.
    const authFails = () => {
      if (!cfg.auth) return false;
      const saved = this.ctx.latestSession?.() ?? this.ctx.session;
      const seen = Number(saved.mockAuthTurns ?? 0) + 1;
      const failed = Number(saved.mockAuthFailures ?? 0);
      const fail = seen > (cfg.auth.after ?? 0) && failed < (cfg.auth.times ?? Number.POSITIVE_INFINITY);
      sink.saveSession({ mockAuthTurns: seen, ...(fail ? { mockAuthFailures: failed + 1 } : {}) });
      if (fail) sink.taken?.();
      return fail;
    };
    const authFailure = (): TurnResult => ({ ok: false, error: "Mock sign-in stopped working (config.auth)", auth: { kind: cfg.auth?.kind ?? "stale", said: "mock" } });
    if (cfg.auth && !cfg.auth.midway && authFails()) return authFailure();

    sink.status("Reading the conversation", "thinking");
    await sleep(Math.min(200, delay / 4));
    if (sink.signal.aborted) return { ok: false, error: "stopped" };

    const cmd = sink.activity({ kind: "command", title: "ls -la", detail: "" });
    await sleep(Math.min(150, delay / 6));
    sink.updateActivity(cmd, { appendDetail: "total 8\ndrwxr-xr-x  3 dev  staff   96 .\n-rw-r--r--  1 dev  staff  120 README.md\n", status: "done" });
    if (cfg.auth?.midway && authFails()) {
      sink.text("Listed the files. ");
      return authFailure();
    }

    if (cfg.approval) {
      const decision = await sink.approval({
        kind: "command",
        title: "npm test",
        detail: `Run \`npm test\` in ${this.ctx.room.cwd}`,
      });
      if (sink.signal.aborted) return { ok: false, error: "stopped" };
      const act = sink.activity({ kind: "command", title: "npm test", detail: decision === "deny" ? "Denied by the human." : "" });
      if (decision !== "deny") sink.updateActivity(act, { appendDetail: "✓ 12 tests passed\n", status: "done" });
      else sink.updateActivity(act, { status: "error" });
    }

    if (cfg.fail || cfg.failTurns?.includes(this.turns)) {
      await sleep(50);
      return { ok: false, error: "Mock failure (config.fail)" };
    }

    // A plan limit, as the real drivers report one (limits.ts): the engine waits for the reset and carries on.
    if (cfg.limit && this.turns <= (cfg.limit.times ?? Number.POSITIVE_INFINITY)) {
      await sleep(cfg.limit.afterMs ?? 50);
      if (sink.signal.aborted) return { ok: false, error: "stopped" };
      const { kind = "usage", label = "5-hour", resetsAt = null } = cfg.limit;
      return { ok: false, error: `Mock plan limit reached (${label ?? "no label"})`, limit: { kind, label, resetsAt, source: resetsAt ? "event" : "none" } };
    }

    const last = lastLine(input.prompt);
    const handle = this.ctx.member.handle;
    // `replies` scripts one reply per turn (last one repeats); `reply` is a single template.
    const scripted = Array.isArray(cfg.replies) && cfg.replies.length ? String(cfg.replies[Math.min(this.turns, cfg.replies.length) - 1]) : null;
    let reply = (scripted ?? cfg.reply ?? "Turn {n}: I looked at “{last}”. Here's my take.")
      .replaceAll("{last}", last.replaceAll("@", "")) // quoting a mention would hand off
      .replaceAll("{handle}", handle)
      .replaceAll("{n}", String(this.turns));
    const triggeredByTarget = !!cfg.handoff && input.prompt.includes(`@${cfg.handoff} mentioned you`);
    if (cfg.handoff && (cfg.pingpong || !triggeredByTarget)) reply += ` @${cfg.handoff} can you take a look?`;

    const words = reply.split(/(\s+)/);
    const step = Math.max(10, (delay * 0.6) / Math.max(1, words.length));
    for (const w of words) {
      if (sink.signal.aborted) return { ok: false, error: "stopped" };
      sink.text(w);
      await sleep(step);
    }
    // What was handed to it meanwhile: read now, and answered below it.
    if (this.handed.length) {
      const read = lastLine(this.handed.map((h) => h.text).join("\n"));
      this.handed = [];
      sink.newReply?.();
      sink.text(`Got your message: “${read.replaceAll("@", "")}”.`);
    }
    sink.usage({ inputTokens: input.prompt.length, outputTokens: reply.length, costUsd: cfg.costUsd ?? 0 });
    sink.rateLimit({
      plan: "Test plan",
      windows: [{ label: "5-hour", usedPercent: cfg.usedPercent ?? Math.min(100, 5 * this.turns), resetsAt: Date.now() + 3 * 3600_000 }],
    });
    if (cfg.helpers && this.turns === 1) this.startHelper(cfg.helpers.ms ?? 60_000);
    return { ok: true };
  }

  /** A helper that works on in the background after the reply ends, then reports it's done. */
  private startHelper(ms: number) {
    const startedAt = Date.now();
    const task = (status: "running" | "completed"): BackgroundTask => ({ id: "mock-helper", kind: "local_agent", description: "Checking the work", agentType: null, workflow: null, background: true, status, startedAt, endedAt: status === "running" ? null : Date.now(), tokens: null, toolUses: null, lastTool: null, summary: null, error: null });
    this.ctx.onTasks?.([task("running")]);
    this.helperTimer = setTimeout(() => {
      this.helperTimer = null;
      this.ctx.onTasks?.([task("completed")]);
    }, ms);
  }

  /** A reply that ended early never read what was handed to it (AgentDriver.takeUnread). */
  takeUnread(): string[] {
    return this.handed.splice(0).flatMap((h) => h.ids);
  }

  async interrupt() {
    this.abortCurrent?.();
  }

  async dispose() {
    if (this.helperTimer) clearTimeout(this.helperTimer);
    this.helperTimer = null;
  }
}

function lastLine(prompt: string): string {
  const body = prompt.split("\n---\n")[0] ?? prompt;
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[") && !l.startsWith("New messages") && !l.startsWith("("));
  const l = lines[lines.length - 1] ?? "the conversation";
  return l.length > 80 ? l.slice(0, 77) + "…" : l;
}
