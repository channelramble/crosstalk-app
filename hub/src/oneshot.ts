// One question to one agent, once (docs/SPEC-0.4.md, T1): the pattern of teamwork.ts askHelper, generalised for a person's
// "Ask others" (asks.ts). Any account and model of Claude Code or Codex (a model server of your own included), a note of
// what to look at, a way to stop it, a time cap, and what it used. Read-only: the agent runs in the chat's folder in "ask"
// mode and every approval is refused. It keeps no session, so the chat's own conversation never sees it.

import { DEFAULT_ACCOUNT, PROVIDER_INFO, type ChatProvider, type Member, type Room } from "@crosstalk/shared";
import type { App } from "./app";
import { createDriver } from "./agents";
import type { AgentDriver, AgentEndpoint, TurnResult, TurnSink } from "./agents/driver";
import type { LimitHit } from "./agents/limits";
import { newId } from "./util/ids";

/** How long one question may take, and how long an agent that ignores a stop is given before it's let go of. */
export const ONE_SHOT_MS = 3 * 60_000;
export const ONE_SHOT_GRACE_MS = 10_000;

export interface OneShotUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** What the agent itself reported (Claude Code's own figure), when it did. */
  costUsd: number | null;
}

export interface OneShotInput {
  /** The chat it's asked about: the agent works in its folder. */
  room: Room;
  provider: ChatProvider;
  account: string;
  model: string | null;
  effort: string | null;
  prompt: string;
  /** What the agent is told to look at before the prompt. */
  systemNote: string | null;
  /** Stop. */
  signal: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
  /** Given the agent's driver as soon as it exists, so a hub shutting down can end it even if its turn hangs. */
  onDriver?: (driver: AgentDriver) => void;
}

export interface OneShotResult {
  ok: boolean;
  /** The answer (when `ok`), or whatever was written before it stopped. */
  text: string;
  /** Why it failed, in the agent's own words (null: stopped, or timed out). */
  error: string | null;
  stopped: boolean;
  timedOut: boolean;
  usage: OneShotUsage;
  /** Set when a usage or rate limit ended it (limits.ts): the asker is told when that account comes back. */
  limit?: LimitHit | null;
}

/** The model server an account runs on, as the engine gives it to an agent: the same wiring (App.endpointFor). */
export function endpointFor(app: App, provider: ChatProvider, account: string, model?: string | null): AgentEndpoint | null {
  return app.endpointFor(provider, account, model);
}

export async function runOneShot(app: App, input: OneShotInput): Promise<OneShotResult> {
  const { room, provider, account } = input;
  const usage: OneShotUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null };
  const result = (r: Partial<OneShotResult>): OneShotResult => ({ ok: false, text: "", error: null, stopped: false, timedOut: false, usage, ...r });
  const bin = app.providers.which(provider);
  if (!bin) return result({ error: `${PROVIDER_INFO[provider].name} isn't installed on the hub` });

  // Never saved: the hub's tools refuse a member they don't know, so the agent can't reach the hub or other chats through it.
  const member: Member = {
    id: newId("ask"),
    roomId: room.id,
    handle: PROVIDER_INFO[provider].defaultHandle,
    provider,
    model: input.model,
    role: "",
    permissionMode: "ask", // read-only: anything that needs approval is refused
    status: "idle",
    statusDetail: null,
    config: { ...(input.effort ? { effort: input.effort } : {}), ...(account !== DEFAULT_ACCOUNT ? { account } : {}) },
    createdAt: Date.now(),
    position: 0,
  };
  const abort = new AbortController();
  let timedOut = false;
  // An agent that ignores the stop is let go of after a grace period (its process is ended below), not waited for.
  let grace: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<TurnResult>((res) =>
    abort.signal.addEventListener("abort", () => (grace = setTimeout(() => res({ ok: false, error: "stopped" }), input.graceMs ?? ONE_SHOT_GRACE_MS)), { once: true }),
  );
  const stop = () => abort.abort();
  if (input.signal.aborted) stop();
  else input.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs ?? ONE_SHOT_MS);
  const stopped = () => abort.signal.aborted && !timedOut;

  let driver: AgentDriver | null = null;
  let text = "";
  const sink: TurnSink = {
    signal: abort.signal,
    text: (d) => {
      text += d;
    },
    setText: (t) => {
      text = t;
    },
    activity: () => newId("a"),
    updateActivity: () => {},
    approval: async () => "deny",
    usage: (u) => {
      if (typeof u.inputTokens === "number") usage.inputTokens = u.inputTokens;
      if (typeof u.outputTokens === "number") usage.outputTokens = u.outputTokens;
      if (typeof u.cachedInputTokens === "number") usage.cachedInputTokens = u.cachedInputTokens;
      if (typeof u.costUsd === "number") usage.costUsd = u.costUsd;
    },
    rateLimit: () => {},
    status: () => {},
    saveSession: () => {},
    heartbeat: () => {},
  };
  try {
    driver = createDriver({
      room,
      member,
      session: {},
      mcp: app.mcpLaunch(member),
      env: app.providers.agentEnv(provider, account),
      bin,
      chat: { helper: null, ephemeral: true },
      endpoint: endpointFor(app, provider, account, input.model),
    });
    input.onDriver?.(driver);
    const res = await Promise.race([driver.runTurn({ turnId: newId("t"), prompt: input.prompt, systemNote: input.systemNote }, sink), gaveUp]);
    const answer = (res.text ?? text).trim();
    if (res.ok) return result({ ok: true, text: answer });
    return result({ text: answer, timedOut, stopped: stopped(), error: res.error && res.error !== "stopped" ? res.error : null, limit: res.limit ?? null });
  } catch (e) {
    return result({ text: text.trim(), timedOut, stopped: stopped(), error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    input.signal.removeEventListener("abort", stop);
    await driver?.dispose().catch(() => undefined);
  }
}
