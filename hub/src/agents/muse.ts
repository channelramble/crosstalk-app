import { MuseClient, readSessionDurability, spawnMspConnection, type Session } from "@muse-code/sdk";
import type { ApprovalDecision, PermissionMode, UsageSnapshot } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "./driver";
import { textLimitHit } from "./limits";
import { museAuthHit, museStartAuthHit } from "./stale-login";
import { logger } from "../util/log";

const log = logger("muse");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const CLIENT_INFO = { name: "crosstalk", version: "0.1.0" };

function approvalMode(p: PermissionMode): string {
  switch (p) {
    case "ask":
      return "promptUnmatched";
    case "edits":
    case "auto":
      return "onRequest";
    case "full":
      return "allowAll";
  }
}

/** Spawn `muse serve` through the official SDK, keeping the raw connection for verbs the facade doesn't wrap. */
export async function startMuse(bin: string, opts: { cwd?: string; env: Record<string, string>; onStderr?: (s: string) => void }) {
  const handshake = spawnMspConnection({ command: bin, args: ["serve"], cwd: opts.cwd, env: opts.env, onStderr: opts.onStderr });
  let spawned;
  try {
    spawned = await handshake.initialize({ clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } } as Json);
  } catch (e) {
    await handshake.close().catch(() => undefined);
    throw e;
  }
  const client = new MuseClient(spawned.connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned });
  return { client, connection: spawned.connection, spawned };
}

export function museUsage(u: Json): Partial<UsageSnapshot> | null {
  if (!u) return null;
  const windows = [];
  if (u.window) {
    const mins = u.window.windowDurationMins;
    windows.push({ label: mins === 300 ? "5-hour" : mins ? `${Math.round(mins / 60)}-hour` : "Current window", usedPercent: u.window.usedPercent ?? null, resetsAt: u.window.resetsAtMs ?? null });
  }
  if (u.weekly) windows.push({ label: "Weekly", usedPercent: u.weekly.usedPercent ?? null, resetsAt: u.weekly.resetsAtMs ?? null });
  return { plan: u.tier ? `Muse ${String(u.tier).replace(/^\w/, (c: string) => c.toUpperCase())}` : null, windows };
}

function decisionChoice(req: Json, d: ApprovalDecision): string | null {
  const choices: Json[] = req.availableChoices ?? [];
  const pick = (pred: (c: Json) => boolean) => choices.find(pred)?.choiceId ?? null;
  if (d === "deny") return pick((c) => String(c.decision).startsWith("denied")) ?? pick((c) => c.decision === "abort");
  if (d === "approve_always") return pick((c) => c.decision === "approvedForSession") ?? pick((c) => c.decision === "approved");
  return pick((c) => c.decision === "approved" && c.scope === "once") ?? pick((c) => c.decision === "approved");
}

function describeApproval(req: Json): { kind: "command" | "file_change" | "tool" | "permission"; title: string; detail: string } {
  const s = req.subject ?? {};
  if (s.command) return { kind: "command", title: s.command, detail: [s.workspaceRoot ? `in ${s.workspaceRoot}` : null, s.command].filter(Boolean).join("\n") };
  if (s.path) return { kind: "file_change", title: `${req.protectedWrite ? "Write protected file" : "Change"} ${s.path}`, detail: req.rawArgs?.slice(0, 6000) ?? "" };
  if (s.host) return { kind: "permission", title: `Connect to ${s.host}${s.port ? `:${s.port}` : ""}`, detail: s.protocol ?? "" };
  return { kind: "tool", title: `Use ${req.toolName ?? s.toolName ?? "a tool"}`, detail: req.rawArgs?.slice(0, 6000) ?? "" };
}

/** Drives Muse Code through Meta's official SDK (`muse serve` + the Muse Session Protocol). */
export class MuseDriver implements AgentDriver {
  readonly provider = "muse" as const;
  private client: MuseClient | null = null;
  private connection: Json = null;
  private session: Session | null = null;
  private sessionId: string | null;
  private currentTurnId: string | null = null;
  private sink: TurnSink | null = null;
  private stderr = "";

  constructor(
    private ctx: DriverContext,
    private bin: string,
  ) {
    this.sessionId = (ctx.session.sessionId as string) || null;
  }

  private async ensure(sink: TurnSink) {
    if (this.session && this.client) return;
    sink.status("Starting Muse Code", "thinking");
    const { room, member, env } = this.ctx;
    const started = await startMuse(this.bin, { cwd: room.cwd, env, onStderr: (s) => (this.stderr = (this.stderr + s).slice(-3000)) });
    this.client = started.client;
    this.connection = started.connection;
    void started.client.exit.then((exit: Json) => {
      if (this.client === started.client) {
        this.client = null;
        this.session = null;
      }
      if (this.sink && exit?.kind !== "cleanShutdown") log.warn(`muse serve exited: ${JSON.stringify(exit).slice(0, 300)}`);
    });
    let session: Session | null = null;
    if (this.sessionId) {
      try {
        session = await started.client.resumeSession({ sessionId: this.sessionId, excludeItems: true } as Json);
      } catch (e) {
        log.warn(`resume failed, starting fresh: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!session) {
      session = await started.client.startSession({
        workspaceRoot: room.cwd,
        approvalMode: approvalMode(member.permissionMode),
        ...(member.model ? { modelId: member.model } : {}),
      } as Json);
      this.sessionId = session.sessionId;
      sink.saveSession({ sessionId: session.sessionId });
    }
    session.onApproval(async (req: Json) => {
      const s = this.sink;
      if (!s) return { choiceId: decisionChoice(req, "deny") ?? req.availableChoices?.[0]?.choiceId };
      const d = await s.approval(describeApproval(req));
      const choiceId = decisionChoice(req, d) ?? req.availableChoices?.[0]?.choiceId;
      return { choiceId };
    });
    session.onApprovalError((f: Json) => log.warn(`approval failed: ${f.kind}`));
    this.session = session;
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    this.sink = sink;
    try {
      await this.ensure(sink);
    } catch (e) {
      this.sink = null;
      const msg = e instanceof Error ? e.message : String(e);
      const auth = museStartAuthHit(`${msg}\n${this.stderr}`);
      return { ok: false, error: auth || /auth|login|sign/i.test(msg + this.stderr) ? "Muse Code isn't signed in on the hub. Open Settings → AI services → Muse Code." : `Muse Code didn't start: ${msg}`, ...(auth ? { auth } : {}) };
    }
    const session = this.session!;
    const text = input.systemNote ? `${input.systemNote}\n\n---\n\n${input.prompt}` : input.prompt;
    const onAbort = () => void this.interrupt();
    sink.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const turn = await session.sendUserTurn({ input: [{ type: "text", text }], ifBusy: "queue" } as Json);
      this.currentTurnId = turn.turnId;
      sink.status("Thinking", "thinking");
      const kinds = new Map<string, string>();
      const acts = new Map<string, string>();
      let lastTextItem: string | null = null;
      let tail = "";
      const emit = (t: string) => {
        tail = (tail + t).slice(-2);
        sink.text(t);
      };

      const itemsLoop = (async () => {
        for await (const item of turn.items() as AsyncIterable<Json>) {
          kinds.set(item.itemId, item.kind);
          if (item.kind === "toolCall" || item.kind === "userShell" || item.kind === "subagent") {
            const title =
              item.kind === "subagent"
                ? `Subagent: ${item.objective ?? item.role ?? "task"}`
                : item.commandText ?? (item.patchSummary ? `Edit ${item.patchSummary.files} file${item.patchSummary.files === 1 ? "" : "s"} (+${item.patchSummary.added} −${item.patchSummary.removed})` : `${item.tool ?? "tool"}${item.args ? ` ${String(item.args).slice(0, 80)}` : ""}`);
            const kind = item.commandText ? "command" : item.patchSummary ? "file_change" : "tool";
            const done = item.status !== "inProgress";
            const status = !done ? "running" : item.status === "completed" ? "done" : "error";
            const detail = item.visibleOutput ?? item.fallbackText ?? item.failureReason ?? "";
            const existing = acts.get(item.itemId);
            if (existing) sink.updateActivity(existing, { title, detail, status });
            else acts.set(item.itemId, sink.activity({ kind, title, detail, status }));
          } else if (item.kind === "agentMessage" && item.status !== "inProgress" && item.text && lastTextItem !== item.itemId) {
            // Final text for a message whose deltas we never saw (e.g. replayed on resume).
            if (!kinds.has(`streamed:${item.itemId}`)) {
              if (lastTextItem && !tail.endsWith("\n\n")) emit(tail.endsWith("\n") ? "\n" : "\n\n");
              lastTextItem = item.itemId;
              emit(item.text);
            }
          } else if (item.kind === "reasoning") {
            sink.status("Thinking", "thinking");
          }
        }
      })();

      const deltasLoop = (async () => {
        for await (const d of turn.deltas() as AsyncIterable<Json>) {
          const kind = kinds.get(d.itemId);
          if (kind && kind !== "agentMessage") {
            const act = acts.get(d.itemId);
            if (act) sink.updateActivity(act, { appendDetail: d.delta });
            continue;
          }
          if (d.field && d.field !== "text") continue;
          kinds.set(`streamed:${d.itemId}`, "1");
          if (lastTextItem && lastTextItem !== d.itemId && !tail.endsWith("\n\n")) emit(tail.endsWith("\n") ? "\n" : "\n\n");
          lastTextItem = d.itemId;
          emit(d.delta);
        }
      })();

      const outcome: Json = await turn.completed;
      await Promise.race([Promise.allSettled([itemsLoop, deltasLoop]), Bun.sleep(1500)]);
      const usage = outcome?.params?.usage;
      if (usage) sink.usage({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cachedInputTokens: usage.cachedTokens ?? 0 });
      void this.readUsage(sink);
      if (outcome.kind === "completed") {
        const p = outcome.params;
        if (p.terminal === "completed") return { ok: true };
        if (p.terminal === "cancelled") return { ok: false, error: "stopped" };
        const msg = p.error?.message ?? p.reason ?? "Muse Code turn failed";
        if (p.error?.kind === "authRequired") return { ok: false, error: "Muse Code isn't signed in on the hub. Open Settings → AI services → Muse Code.", auth: museAuthHit(p.error) };
        // Muse reports failures as sentences, so a limit is only taken from a clear one (limits.ts), never a guess.
        const limit = textLimitHit(msg);
        return { ok: false, error: msg, ...(limit ? { limit } : {}) };
      }
      if (outcome.kind === "unqueued") return { ok: false, error: "stopped" };
      return { ok: false, error: "Muse Code ended without a result (the host may have restarted)." };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      sink.signal.removeEventListener("abort", onAbort);
      this.currentTurnId = null;
      this.sink = null;
    }
  }

  private async readUsage(sink: TurnSink) {
    try {
      const r = await this.connection?.request("usage/read", {});
      const u = museUsage(r?.usage);
      if (u) sink.rateLimit(u);
    } catch {
      // not available on this plan / version
    }
  }

  async interrupt() {
    if (!this.connection || !this.sessionId) return;
    try {
      await this.connection.command("turn/interrupt", { sessionId: this.sessionId, ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}) });
    } catch (e) {
      log.debug(`interrupt: ${e}`);
    }
  }

  async dispose() {
    const c = this.client;
    this.client = null;
    this.session = null;
    await c?.close().catch(() => undefined);
  }
}
