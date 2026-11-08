import type { ApprovalDecision, PermissionMode, Provider } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "./driver";
import { RpcError, StdioRpc } from "./jsonrpc";
import { textLimitHit } from "./limits";
import { acpAuthHit } from "./stale-login";
import { logger } from "../util/log";

const log = logger("acp");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** How often a turn with a tool still running says it is alive (the engine ends one that says nothing for 15 minutes). */
const BEAT_MS = 60_000;
/** A tool that runs longer than this no longer counts as alive by itself: it's left to the engine's watchdog. */
const BEAT_MAX_MS = 2 * 3600_000;
/** How long a saved session that couldn't be opened is asked for again on the same process, and how long between tries. */
const REOPEN_MS = 120_000;
const REOPEN_PAUSE_MS = 1000;
/** How long Stop waits for the reply's own end, where what it used is counted (the engine moves on at 4 seconds regardless). */
const STOP_WAIT_MS = 3500;
/** Updates that only come once the agent has taken a prompt: others (its commands, its options) come whenever. */
const TURN_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "session_info_update"]);

/**
 * Generic Agent Client Protocol driver (https://agentclientprotocol.com) for agents that speak ACP over stdio,
 * such as Gemini CLI. We don't offer client-side fs/terminal capabilities, so the agent uses its own tools.
 */
export class AcpDriver implements AgentDriver {
  protected rpc: StdioRpc | null = null;
  protected sessionId: string | null;
  protected sink: TurnSink | null = null;
  /** The current turn and the process it runs on; `settled` once its result is in, even if a newer turn took over. */
  private current: { rpc: StdioRpc | null; settled: boolean; ended: Promise<void> } | null = null;
  /** The process with a session open on it: any other, however it came to be left, starts over. */
  private openOn: StdioRpc | null = null;
  protected tools = new Map<string, string>(); // toolCallId -> activity id
  protected running = new Set<string>(); // activity ids not yet finished
  private tail = "";
  /** Since when a tool has been running with none finishing in between all of them (0: none is). */
  private busySince = 0;
  /** What this reply has written so far, and where the current prompt's part of it starts. */
  protected replyText = "";
  protected promptStart = 0;
  /** A saved session is being loaded: its old conversation is being played back, and none of that is this reply. */
  private replaying = false;
  /** How often a running tool counts as a sign of life (tests shorten it). */
  protected beatMs = BEAT_MS;

  constructor(
    readonly provider: Provider,
    protected ctx: DriverContext,
    protected argv: string[],
    private opts: { name: string; autoApprove?: (p: PermissionMode, kind: string) => boolean } = { name: "agent" },
  ) {
    this.sessionId = (ctx.session.acpSessionId as string) || null;
  }

  /** The MCP servers a session is opened with: Crosstalk's own, for the agent's tools for this chat. */
  protected mcpServers(): unknown[] {
    const { mcp } = this.ctx;
    return [{ name: "crosstalk", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }];
  }

  /** The agent's process environment. */
  protected processEnv(): Record<string, string> {
    return this.ctx.env;
  }

  /** Before the agent's process starts (a driver writes what it reads at start here). A stopped turn starts none. */
  protected async beforeStart(_signal: AbortSignal): Promise<void> {}

  /** A session is open (`fresh`: a new one, not one picked up again): what it needs before its first prompt. */
  protected async sessionOpened(_rpc: StdioRpc, _opened: Json, _sink: TurnSink, _fresh: boolean): Promise<void> {}

  /**
   * The agent answered a prompt: another prompt to send in the same reply, or null when the reply is over. For a driver
   * that sees something the agent itself can't (it wrote a tool call as text and thinks it's finished, say).
   */
  protected nextPrompt(_answer: Json, _sink: TurnSink): string | null {
    return null;
  }

  /** The agent answered a prompt, whether or not the reply has been stopped meanwhile. */
  protected promptAnswered(_answer: Json) {}

  /** Whether an error from opening a saved session means the agent looked and can't give it back (not that it's busy, say). */
  protected sessionLost(e: unknown): boolean {
    if (e instanceof RpcError && (e.code === -32602 || e.code === -32002)) return true;
    const data = e instanceof RpcError ? JSON.stringify(e.data ?? "") : "";
    return /session not found|no previous sessions|invalid session identifier/i.test(`${e instanceof Error ? e.message : e} ${data}`);
  }

  /**
   * How a start that failed ends the reply. Refused for want of a sign-in (-32000 "Authentication required", or the auth
   * library's invalid_grant, whichever call it came from: reopen keeps it as the cause of what it throws): the engine checks
   * the sign-in and says what to do. For an agent with no sign-in of its own, the driver says it its own way.
   */
  protected async startFailed(e: unknown): Promise<TurnResult> {
    const msg = e instanceof Error ? e.message : String(e);
    const auth = acpAuthHit(e instanceof Error && e.cause ? e.cause : e);
    return { ok: false, error: auth || /auth|login|credential/i.test(msg) ? `${this.opts.name} isn't signed in on the hub. Open Settings → AI services.` : `${this.opts.name} didn't start: ${msg}`, ...(auth ? { auth } : {}) };
  }

  /** How a prompt that failed ends the reply. These agents send no typed error: only an unmistakable limit waits for a reset (limits.ts). */
  protected async promptFailed(e: unknown): Promise<TurnResult> {
    const msg = e instanceof Error ? e.message : String(e);
    const limit = textLimitHit(msg);
    const auth = limit ? null : acpAuthHit(e);
    return { ok: false, error: msg, ...(limit ? { limit } : {}), ...(auth ? { auth } : {}) };
  }

  private async ensure(sink: TurnSink, turn: { rpc: StdioRpc | null }) {
    if (this.rpc?.alive && this.openOn === this.rpc) return;
    const { room } = this.ctx;
    sink.status(`Starting ${this.opts.name}`, "thinking");
    void this.rpc?.kill();
    this.rpc = null;
    await this.beforeStart(sink.signal);
    // Stopped while getting ready: no process starts.
    if (sink.signal.aborted) return;
    const rpc = new StdioRpc(this.argv, { cwd: room.cwd, env: this.processEnv(), name: this.opts.name });
    this.rpc = rpc;
    turn.rpc = rpc;
    const asking = new Map<number | string, AbortController>();
    // A replaced process's late updates and requests belong to no current turn.
    rpc.onNotification((m, p) => {
      // A question it no longer needs answered: its card goes.
      if (m === "$/cancel_request") asking.get(p?.requestId)?.abort();
      else if (this.rpc === rpc) this.onNotification(m, p);
    });
    rpc.onRequest(async (m, p, id) => {
      if (this.rpc !== rpc) throw new Error("this process was replaced");
      const asked = new AbortController();
      asking.set(id, asked);
      try {
        return await this.onRequest(m, p, asked.signal);
      } finally {
        asking.delete(id);
      }
    });
    const init = await rpc.request<Json>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "crosstalk", title: "Crosstalk", version: "0.1.0" },
    }, 60_000);
    const mcpServers = this.mcpServers();
    const caps = init?.agentCapabilities ?? {};
    let lost = false;
    if (this.sessionId && (caps.sessionCapabilities?.resume || caps.loadSession)) {
      const opened = await this.reopen(rpc, !!caps.sessionCapabilities?.resume, mcpServers, sink);
      if (opened) {
        await this.sessionOpened(rpc, opened, sink, false);
        this.openOn = rpc;
        return;
      }
      lost = true;
    }
    const res = await rpc.request<Json>("session/new", { cwd: room.cwd, mcpServers }, 120_000);
    // A stopped turn's session is kept by nobody: the chat's own stays what it was.
    if (sink.signal.aborted) return;
    this.sessionId = res.sessionId;
    sink.saveSession({ acpSessionId: this.sessionId });
    if (lost) sink.activity({ kind: "notice", title: `${this.opts.name} has lost this chat's earlier conversation`, detail: `${this.opts.name} couldn't find it (the chat's folder changed, or its files were deleted), so this reply starts a new one. The messages above are all still here, but it doesn't remember them: tell it anything it needs to know.`, status: "done" });
    await this.sessionOpened(rpc, res, sink, true);
    this.openOn = rpc;
  }

  /**
   * Opens the chat's saved session: what the agent answered, or null when it no longer has it. Any other failure says
   * nothing about the session, so it is kept: asked for again on this process while there's time (a slow folder's start
   * finishes on the process that began it), and failing the reply after that rather than forgetting the conversation.
   */
  private async reopen(rpc: StdioRpc, resume: boolean, mcpServers: unknown[], sink: TurnSink): Promise<Json | null> {
    const until = Date.now() + REOPEN_MS;
    for (;;) {
      // session/resume picks a saved session up as it is. session/load first plays its whole conversation back as updates
      // (the protocol says it must, before it answers), and none of that may land in the reply this turn is writing.
      this.replaying = !resume;
      try {
        return (await rpc.request<Json>(resume ? "session/resume" : "session/load", { sessionId: this.sessionId, cwd: this.ctx.room.cwd, mcpServers }, REOPEN_MS)) ?? {};
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (this.sessionLost(e)) {
          log.warn(`the saved session is gone, starting a new one: ${msg}`);
          return null;
        }
        const timedOut = e instanceof RpcError && e.code === -32001;
        // Not signed in won't change by asking again, and runTurn's words for it need saying now. What the agent answered
        // goes along as the cause: it's what tells a refused sign-in from anything else (startFailed).
        if (!rpc.alive || timedOut || sink.signal.aborted || Date.now() >= until || acpAuthHit(e) || /auth|login|credential/i.test(msg)) {
          if (this.rpc === rpc) this.rpc = null;
          void rpc.kill();
          throw new Error(`it couldn't open this chat's session (${msg}). Nothing is lost: try again.`, { cause: e });
        }
        log.warn(`opening the saved session failed, asking again: ${msg}`);
      } finally {
        this.replaying = false;
      }
      await Bun.sleep(REOPEN_PAUSE_MS);
    }
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    // A stopped turn still waiting on its process (perhaps stuck) when the next one starts: retire that process now,
    // so this turn starts a fresh one instead of queueing behind it.
    const prev = this.current;
    if (prev && !prev.settled && prev.rpc && this.rpc === prev.rpc) {
      this.rpc = null;
      void prev.rpc.kill();
    }
    let ended = () => {};
    const turn = { rpc: null as StdioRpc | null, settled: false, ended: new Promise<void>((res) => (ended = res)) };
    const settle = () => {
      turn.settled = true;
      // Only if no newer turn has started: a stopped turn finishing late mustn't clear the current one.
      if (this.current === turn) {
        this.current = null;
        this.sink = null;
      }
      ended();
    };
    this.current = turn;
    this.sink = sink;
    this.tools.clear();
    this.running.clear();
    this.busySince = 0;
    this.tail = "";
    this.replyText = "";
    this.promptStart = 0;
    try {
      await this.ensure(sink, turn);
    } catch (e) {
      settle();
      return await this.startFailed(e);
    }
    if (sink.signal.aborted) {
      settle();
      return { ok: false, error: "stopped" };
    }
    turn.rpc = this.rpc;
    let text = input.systemNote ? `${input.systemNote}\n\n---\n\n${input.prompt}` : input.prompt;
    const onAbort = () => void this.interrupt();
    sink.signal.addEventListener("abort", onAbort, { once: true });
    sink.status("Thinking", "thinking");
    // A command can run quietly for a long time: as long as a tool is running, the agent isn't frozen. (Its own stalls,
    // with nothing running, are still the engine's watchdog's to catch.)
    const beat = setInterval(() => {
      if (this.running.size && this.busySince && Date.now() - this.busySince < BEAT_MAX_MS) sink.heartbeat?.();
    }, this.beatMs);
    try {
      for (;;) {
        this.promptStart = this.replyText.length;
        const res = await turn.rpc!.request<Json>("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, 0);
        // Any answer means it got there, even one with nothing else to say.
        sink.taken?.();
        this.promptAnswered(res);
        for (const id of this.running) sink.updateActivity(id, { status: "done" });
        this.running.clear();
        this.busySince = 0;
        const next = sink.signal.aborted ? null : this.nextPrompt(res, sink);
        if (next) {
          text = next;
          sink.status("Working", "working");
          continue;
        }
        const reason = res?.stopReason;
        if (reason === "cancelled") return { ok: false, error: "stopped" };
        if (reason === "refusal") return { ok: false, error: `${this.opts.name} declined to continue.` };
        if (reason === "max_tokens" || reason === "max_turn_requests") return { ok: true, text: undefined };
        return { ok: true };
      }
    } catch (e) {
      // Stopped, and it didn't stop by itself in time: its process was replaced, which is how the prompt came to fail.
      if (sink.signal.aborted) return { ok: false, error: "stopped" };
      return await this.promptFailed(e);
    } finally {
      clearInterval(beat);
      sink.signal.removeEventListener("abort", onAbort);
      this.turnEnded(sink);
      settle();
    }
  }

  /** The reply is over, however it ended. */
  protected turnEnded(_sink: TurnSink) {}

  /** Whether a turn is in progress. */
  protected get turnRunning(): boolean {
    return !!this.current && !this.current.settled;
  }

  protected emit(t: string) {
    if (!t || !this.sink) return;
    this.tail = (this.tail + t).slice(-2);
    this.replyText += t;
    this.sink.text(t);
  }

  /** Replaces what this reply has written. */
  protected rewrite(text: string) {
    if (!this.sink) return;
    this.replyText = text;
    this.tail = text.slice(-2);
    this.sink.setText(text);
  }

  private onNotification(method: string, p: Json) {
    if (method !== "session/update" || !this.sink || this.replaying || p?.sessionId !== this.sessionId) return;
    const update = p.update ?? {};
    // It has the message from here on: a reply that fails later doesn't give it back to be sent again.
    if (TURN_UPDATES.has(update.sessionUpdate)) this.sink.taken?.();
    this.handleUpdate(update, this.sink);
  }

  /** One session update of the current reply. */
  protected handleUpdate(u: Json, sink: TurnSink) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") this.emit(u.content.text);
        break;
      case "agent_thought_chunk":
        sink.status("Thinking", "thinking");
        break;
      case "tool_call": {
        const kind = u.kind === "execute" ? "command" : u.kind === "edit" || u.kind === "delete" || u.kind === "move" ? "file_change" : "tool";
        const status = u.status === "completed" ? "done" : u.status === "failed" ? "error" : "running";
        const id = sink.activity({ kind, title: u.title ?? "Tool call", detail: contentText(u.content) || (u.rawInput ? JSON.stringify(u.rawInput, null, 2) : ""), status });
        this.tools.set(u.toolCallId, id);
        if (status === "running") {
          if (!this.running.size) this.busySince = Date.now();
          this.running.add(id);
        }
        if (this.tail && !this.tail.endsWith("\n")) this.emit("\n\n");
        break;
      }
      case "tool_call_update": {
        const id = this.tools.get(u.toolCallId);
        if (!id) break;
        const out = contentText(u.content);
        if (u.status === "completed" || u.status === "failed") {
          this.running.delete(id);
          // Another tool still running has its own clock from here.
          this.busySince = this.running.size ? Date.now() : 0;
        }
        sink.updateActivity(id, {
          ...(u.title ? { title: u.title } : {}),
          ...(out ? { detail: out } : {}),
          ...(u.status ? { status: u.status === "completed" ? "done" : u.status === "failed" ? "error" : "running" } : {}),
        });
        break;
      }
      case "plan": {
        const plan = (u.entries ?? []).map((e: Json) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "·"} ${e.content}`).join("\n");
        const existing = this.tools.get("__plan");
        if (existing) sink.updateActivity(existing, { detail: plan });
        else this.tools.set("__plan", sink.activity({ kind: "plan", title: "Plan", detail: plan, status: "done" }));
        break;
      }
    }
  }

  private async onRequest(method: string, p: Json, signal: AbortSignal): Promise<Json> {
    if (method !== "session/request_permission") throw new Error(`Unsupported: ${method}`);
    return this.permissionRequested(p, signal);
  }

  /** The agent asks before it does something (`signal`: it took the question back). */
  protected async permissionRequested(p: Json, signal: AbortSignal): Promise<Json> {
    const options: Json[] = p.options ?? [];
    const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind))?.optionId;
    const sink = this.sink;
    const tc = p.toolCall ?? {};
    const kind = tc.kind === "execute" ? "command" : tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move" ? "file_change" : "tool";
    let d: ApprovalDecision = "deny";
    if (this.opts.autoApprove?.(this.ctx.member.permissionMode, kind)) d = "approve";
    else if (sink) d = await sink.approval({ kind, title: tc.title ?? "Use a tool", detail: contentText(tc.content) || (tc.rawInput ? JSON.stringify(tc.rawInput, null, 2) : "") }, { signal });
    const optionId = d === "approve_always" ? pick(["allow_always"]) ?? pick(["allow_once"]) : d === "approve" ? pick(["allow_once"]) ?? pick(["allow_always"]) : pick(["reject_once"]) ?? pick(["reject_always"]);
    if (!optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  }

  async interrupt() {
    const turn = this.current;
    if (!turn) return;
    const rpc = turn.rpc;
    if (rpc?.alive && this.sessionId) rpc.notify("session/cancel", { sessionId: this.sessionId });
    // If the turn doesn't end promptly (a stuck agent), replace the process: the next turn starts a fresh one.
    if (rpc) {
      setTimeout(() => {
        if (turn.settled) return;
        if (this.rpc === rpc) this.rpc = null;
        void rpc.kill(); // its pending prompt request fails, which ends the turn
      }, 5000).unref?.();
    }
    // A stopped reply's cost is only known at its end, normally a moment away.
    await Promise.race([turn.ended, Bun.sleep(STOP_WAIT_MS)]);
  }

  async dispose() {
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill();
  }
}

export function contentText(content: Json): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: Json) => {
      if (c.type === "content" && c.content?.type === "text") return c.content.text;
      if (c.type === "diff") return `${c.path}\n${diffLines(c.oldText ?? "", c.newText ?? "")}`;
      if (c.type === "terminal") return `[terminal ${c.terminalId}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** How much of a change an approval card holds (it scrolls): its middle is what's cut past that, and the card says so. */
const DIFF_CHARS = 20_000;

/** What changed, whatever the size of the file: the lines between the first and last that differ, by position. */
function diffLines(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const text = [...a.slice(start, aEnd).map((l) => `- ${l}`), ...b.slice(start, bEnd).map((l) => `+ ${l}`)].join("\n");
  if (text.length <= DIFF_CHARS) return text;
  const head = Math.floor(DIFF_CHARS / 3);
  return `${text.slice(0, head)}\n\n[… ${text.length - DIFF_CHARS} characters cut …]\n\n${text.slice(head - DIFF_CHARS)}`;
}
