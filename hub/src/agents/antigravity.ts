import type { PermissionMode } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "./driver";
import { logger } from "../util/log";
import { endProcess } from "../util/process";
import { agyAuthHit } from "./stale-login";

const log = logger("antigravity");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Antigravity CLI has no way to route its permission prompts to Crosstalk, so each setting maps to the closest
 * non-interactive mode. "Ask first" can't ask in headless mode: the CLI then declines anything that needs approval.
 */
export function agyPermissionArgs(p: PermissionMode): string[] {
  switch (p) {
    case "ask":
      return [];
    case "edits":
    case "auto":
      return ["--mode", "accept-edits"];
    case "full":
      return ["--dangerously-skip-permissions"];
  }
}

interface Turn {
  /** The process this turn runs on: events or an exit from any other (e.g. one just stopped) are ignored. */
  proc: ReturnType<typeof Bun.spawn>;
  sink: TurnSink;
  done: (r: TurnResult) => void;
  text: string;
  /** Activity ids by the CLI's tool-call id, for events that report a call and later its result. */
  tools: Map<string, string>;
  /** Token counts so far: a follow-up after a declined action adds to them. */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  /** Names of the actions declined so far this turn ("" if none): set once the agent has been told. */
  denied: string;
}

/**
 * Drives `agy` in its documented headless streaming mode (`--input-format stream-json --output-format stream-json`):
 * one long-lived process per member, one NDJSON `{"event":"user",...}` line per turn, and a final `result` event
 * per turn carrying the reply, conversation id and token counts.
 *
 * Progress arrives as `step_update` events (text deltas and tool steps) and each turn ends with `result`; both are
 * verified against agy 1.2.16. Other shapes are handled loosely and anything unrecognised is logged.
 */
export class AntigravityDriver implements AgentDriver {
  readonly provider = "antigravity" as const;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private turn: Turn | null = null;
  private conversationId: string | null;
  private stderrTail = "";
  private seenUnknown = new Set<string>();

  constructor(
    private ctx: DriverContext,
    private bin: string,
  ) {
    this.conversationId = (ctx.session.conversationId as string) || null;
  }

  private spawn(): ReturnType<typeof Bun.spawn> {
    const { room, member, env } = this.ctx;
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", ...agyPermissionArgs(member.permissionMode)];
    if (member.model) args.push("--model", member.model);
    // No --effort: agy rejects it for every listed model (the effort is in the model's name), so a saved one is ignored.
    if (this.conversationId) args.push("--conversation", this.conversationId);
    const proc = Bun.spawn([this.bin, ...args], { cwd: room.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    this.stderrTail = "";
    void this.readStdout(proc);
    void this.readStderr(proc);
    void proc.exited.then((code) => {
      if (this.proc === proc) this.proc = null;
      const t = this.turn;
      if (!t || t.proc !== proc) return; // a stopped process exiting late must not end a newer turn
      const tail = this.stderrTail.trim().split("\n").slice(-3).join(" ");
      const signIn = /authenticat|sign in|log in/i.test(this.stderrTail);
      // Never a stale sign-in from what it printed on the way out (agyAuthHit reads only a result's error): its stderr
      // says "not authenticated" about other things too, an MCP server it skipped, say.
      t.done({ ok: false, error: signIn ? "Antigravity CLI isn't signed in. Sign in under Settings → AI services." : `Antigravity CLI exited (code ${code})${tail ? `: ${tail}` : ""}` });
    });
    return proc;
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    if (!this.proc) {
      sink.status("Starting Antigravity CLI", "thinking");
      try {
        this.spawn();
      } catch (e) {
        return { ok: false, error: `Couldn't start Antigravity CLI: ${e instanceof Error ? e.message : e}` };
      }
    }
    const proc = this.proc!;
    // There's no system-prompt flag; the room briefing goes in front of the first message of a session.
    const text = input.systemNote ? `${input.systemNote}\n\n---\n\n${input.prompt}` : input.prompt;
    return new Promise<TurnResult>((resolve) => {
      const onAbort = () => void this.interrupt(turn);
      const turn: Turn = { proc, sink, text: "", tools: new Map(), usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, denied: "", done: resolve };
      turn.done = (r) => {
        if (this.turn !== turn) return;
        this.turn = null;
        sink.signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      this.turn = turn;
      sink.signal.addEventListener("abort", onAbort, { once: true });
      this.write({ event: "user", message: { content: text } });
      sink.status("Thinking", "thinking");
    });
  }

  private write(obj: unknown) {
    const stdin = this.proc?.stdin as import("bun").FileSink | undefined;
    try {
      stdin?.write(JSON.stringify(obj) + "\n");
      stdin?.flush();
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
            continue; // the CLI may print plain progress lines
          }
          this.handle(ev, proc);
        }
      }
    } catch (e) {
      log.debug(`read loop ended: ${e}`);
    }
  }

  private async readStderr(proc: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) this.stderrTail = (this.stderrTail + dec.decode(chunk)).slice(-4000);
    } catch {
      /* closed */
    }
  }

  /** Handles one streamed event. Exported shape knowledge lives here so it's easy to extend as the CLI evolves. */
  handle(ev: Json, from?: ReturnType<typeof Bun.spawn>) {
    // Events from a process that's been replaced (stopped, then a new turn started) belong to nobody.
    const t = this.turn && (!from || this.turn.proc === from) ? this.turn : null;
    if (from && this.proc !== from && !t) return;
    const type = String(ev?.event ?? ev?.type ?? "");
    if (type === "result") {
      const r = ev.result ?? {};
      if (r.conversation_id && r.conversation_id !== this.conversationId) {
        this.conversationId = r.conversation_id;
        t?.sink.saveSession({ conversationId: r.conversation_id });
      }
      if (!t) return;
      const u = r.usage ?? {};
      t.usage.inputTokens += Number(u.input_tokens) || 0;
      t.usage.outputTokens += (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0);
      t.usage.cachedInputTokens += Number(u.cache_read_tokens) || 0;
      t.sink.usage({ ...t.usage, costUsd: null });
      if (String(r.status ?? "").toUpperCase() === "ERROR" || r.error) {
        const err = String(r.error || "Antigravity CLI reported an error");
        // "Authentication expired. Please log back in." (1.3.3+): the engine starts it again once, then checks the sign-in.
        const auth = agyAuthHit(err);
        t.done({ ok: false, error: /authenticat|sign in/i.test(err) ? "Antigravity CLI isn't signed in. Sign in under Settings → AI services." : err, ...(auth ? { auth } : {}) });
        return;
      }
      // Without Full access agy can't run commands headless: it declines them, lists them in denied_actions and
      // often ends with no reply at all. Tell it once so it still answers, then explain instead of "(no reply)".
      const denied = Array.isArray(r.denied_actions) ? r.denied_actions : [];
      // The follow-up may come back empty with no denied_actions of its own: the first denial still explains it.
      if ((denied.length || t.denied) && !t.text.trim() && !String(r.response ?? "").trim()) {
        const names = [...new Set([...(t.denied ? t.denied.split(", ") : []), ...denied.map((d: Json) => String(d?.display_name || d?.action || "an action"))])].join(", ");
        if (!t.denied) {
          t.denied = names;
          t.sink.status("Answering without the declined action", "thinking");
          this.write({ event: "user", message: { content: `(Crosstalk) ${names} was declined: your permission setting in this room doesn't allow it and nobody can approve it. Don't try it again this turn. Reply now with what you can do without it, and say briefly what you'd have used it for.` } });
          return;
        }
        t.done({ ok: false, error: `Antigravity stopped because it wanted to use ${names}, which its permission setting doesn't allow (it can't ask you in Crosstalk). Choose Full access in its agent settings, or ask it to answer without that.` });
        return;
      }
      // If nothing streamed, the full reply is in the result.
      t.done({ ok: true, text: t.text ? undefined : String(r.response ?? "") });
      return;
    }
    if (!t) return;
    if (type === "step_update") {
      this.handleStep(t, ev.step_update ?? {});
      return;
    }
    // Text as it's written: accept the common delta shapes.
    const delta = ev.delta?.text ?? ev.text_delta ?? (type.includes("text") || type === "assistant" || type === "message.delta" ? ev.text ?? ev.delta ?? ev.content : undefined);
    if (typeof delta === "string" && delta && !type.includes("thinking")) {
      t.text += delta;
      t.sink.text(delta);
      return;
    }
    if (type.includes("thinking") || type.includes("reasoning")) {
      t.sink.status("Thinking", "thinking");
      return;
    }
    if (type.includes("tool")) {
      const id = String(ev.id ?? ev.tool_call_id ?? ev.call_id ?? "");
      const name = String(ev.name ?? ev.tool ?? ev.tool_name ?? "tool");
      if (/result|end|done|complete/i.test(type)) {
        const act = t.tools.get(id);
        if (act) t.sink.updateActivity(act, { appendDetail: typeof ev.output === "string" ? ev.output : "", status: ev.is_error || ev.error ? "error" : "done" });
      } else {
        const input = ev.input ?? ev.args ?? ev.arguments;
        const act = t.sink.activity({ kind: /shell|bash|command|exec/i.test(name) ? "command" : /edit|write|patch/i.test(name) ? "file_change" : "tool", title: name, detail: input ? JSON.stringify(input, null, 2) : "" });
        if (id) t.tools.set(id, act);
        t.sink.status(`Running ${name}`, "working");
      }
      return;
    }
    if (type && !this.seenUnknown.has(type)) {
      this.seenUnknown.add(type);
      log.info(`unrecognised Antigravity event "${type}": ${JSON.stringify(ev).slice(0, 300)}`);
    }
  }

  /**
   * agy reports progress as numbered steps (verified against agy 1.2.16): `agent_response` steps stream `text_delta`,
   * `tool` steps arrive ACTIVE with `tool_info.parameters` and again DONE with `tool_info.output`.
   */
  private handleStep(t: Turn, s: Json) {
    const state = String(s.state ?? "").toUpperCase();
    const kind = String(s.step_type ?? "");
    if (typeof s.thinking_delta === "string" && s.thinking_delta) t.sink.status("Thinking", "thinking");
    if (kind === "agent_response") {
      if (typeof s.text_delta === "string" && s.text_delta) {
        t.text += s.text_delta;
        t.sink.text(s.text_delta);
      }
      return;
    }
    if (kind !== "tool") return;
    const key = String(s.step_index ?? "");
    const info = s.tool_info ?? {};
    const name = String(s.tool_name ?? info.name ?? "tool");
    let act = t.tools.get(key);
    if (!act) {
      const params = info.parameters;
      const command = typeof params?.CommandLine === "string" ? params.CommandLine : null;
      act = t.sink.activity({
        kind: /command|shell|bash|exec/i.test(name) ? "command" : /edit|write|replace|patch|create_file/i.test(name) ? "file_change" : "tool",
        title: command ?? name,
        detail: command ? "" : params ? JSON.stringify(params, null, 2) : "",
      });
      t.tools.set(key, act);
    }
    if (state === "ACTIVE") {
      t.sink.status(`Running ${name}`, "working");
      return;
    }
    const error = info.error?.message ?? s.error?.message ?? (typeof s.error === "string" ? s.error : "");
    const output = typeof info.output === "string" ? info.output.replace(/\r\n/g, "\n") : "";
    const failed = /ERROR|FAIL|CANCEL/.test(state) || !!error;
    t.sink.updateActivity(act, { appendDetail: output || String(error), status: failed ? "error" : "done" });
    t.sink.status("Thinking", "thinking");
  }

  /** Stops `turn` (default: the current one). Stopping a turn that already finished does nothing. */
  async interrupt(turn: Turn | null = this.turn) {
    if (!turn || this.turn !== turn) return;
    // No documented in-band interrupt: stop its process; the next turn resumes the conversation by id.
    if (this.proc === turn.proc) this.proc = null;
    void endProcess(turn.proc);
    turn.done({ ok: false, error: "stopped" });
  }

  async dispose() {
    const p = this.proc;
    this.proc = null;
    if (p) await endProcess(p);
  }
}
