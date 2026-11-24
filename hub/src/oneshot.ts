// One question to one agent, once (docs/SPEC-0.4.md, T1): the pattern of teamwork.ts askHelper, generalised for a person's
// "Ask others" (asks.ts). Any account and model of Claude Code or Codex (a model server of your own included), a note of
// what to look at, a way to stop it, a time cap, and what it used. Read-only: the agent runs in the chat's folder in "ask"
// mode and every approval is refused. It keeps no session, so the chat's own conversation never sees it.

import { DEFAULT_ACCOUNT, PROVIDER_INFO, type CostBasis, type Member, type PermissionMode, type Provider, type Room } from "@crosstalk/shared";
import type { App } from "./app";
import { createDriver } from "./agents";
import type { ActivityInput, AgentDriver, AgentEndpoint, TurnResult, TurnSink } from "./agents/driver";
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
  provider: Provider;
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
  /**
   * A helper (helpers.ts), not a question: what it may do without asking (left out: "ask", and with no `approval`
   * everything that needs one is refused, which is an ask's read-only run), where its requests for more go, and what it
   * is doing as it works. Its member is still never saved; `onMember` hears who it is, for Claude Code's permission
   * prompt, which comes back through the hub's own tools by member id.
   */
  permissionMode?: PermissionMode;
  approval?: TurnSink["approval"];
  onMember?: (member: Member) => void;
  onStep?: (step: ActivityInput) => void;
  onUsage?: (usage: OneShotUsage) => void;
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
  /** Set when the account's sign-in or key, not the request, ended it (stale-login.ts). */
  auth?: boolean;
}

/** The model server an account runs on, as the engine gives it to an agent: the same wiring (App.endpointFor). */
export function endpointFor(app: App, provider: Provider, account: string, model?: string | null): AgentEndpoint | null {
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
    id: newId(input.approval ? "hlp" : "ask"),
    roomId: room.id,
    handle: PROVIDER_INFO[provider].defaultHandle,
    provider,
    model: input.model,
    role: "",
    permissionMode: input.permissionMode ?? "ask", // an ask is read-only: anything that needs approval is refused
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
    activity: (a) => {
      input.onStep?.(a);
      return newId("a");
    },
    updateActivity: () => {},
    approval: input.approval ?? (async () => "deny"),
    usage: (u) => {
      if (typeof u.inputTokens === "number") usage.inputTokens = u.inputTokens;
      if (typeof u.outputTokens === "number") usage.outputTokens = u.outputTokens;
      if (typeof u.cachedInputTokens === "number") usage.cachedInputTokens = u.cachedInputTokens;
      if (typeof u.costUsd === "number") usage.costUsd = u.costUsd;
      input.onUsage?.(usage);
    },
    rateLimit: () => {},
    status: () => {},
    saveSession: () => {},
    heartbeat: () => {},
  };
  input.onMember?.(member);
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
    return result({ text: answer, timedOut, stopped: stopped(), error: res.error && res.error !== "stopped" ? res.error : null, limit: res.limit ?? null, ...(res.auth ? { auth: true } : {}) });
  } catch (e) {
    return result({ text: text.trim(), timedOut, stopped: stopped(), error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    input.signal.removeEventListener("abort", stop);
    await driver?.dispose().catch(() => undefined);
  }
}

/** A model server on this very machine: what's asked of it never leaves, and costs nothing. */
export function onThisMachine(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** What a one-shot run cost, and how sure that is (an ask's card, a helper's row, and the spend ledger keep the same figure). */
export function oneShotCost(app: App, t: { provider: Provider; account: string; model: string | null }, u: OneShotUsage, local?: boolean): { inputTokens: number; outputTokens: number; costUsd: number | null; basis: CostBasis } {
  const { provider, account, model } = t;
  const saved = app.providers.accounts().find((a) => a.provider === provider && a.id === account);
  const kind = saved?.kind ?? "signin";
  const tokens = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
  if (local ?? (kind === "endpoint" && onThisMachine(saved?.endpoint?.baseUrl ?? ""))) return { ...tokens, costUsd: 0, basis: "free" };
  // A key on one flat fee for the month, so this run added nothing to it: the ledger keeps the same figure (spend.ts).
  if (kind === "endpoint" && app.services.flatRate(provider, account, saved?.endpoint?.baseUrl)) return { ...tokens, costUsd: 0, basis: "plan" };
  const none = !u.inputTokens && !u.outputTokens && u.costUsd === null;
  // A fresh Claude Code process's own figure is exact, except on a model server (it would price the name it sees as Anthropic's).
  const priced = none
    ? { costUsd: null, basis: "unknown" as CostBasis }
    : provider === "claude" && kind !== "endpoint" && u.costUsd !== null
      ? { costUsd: u.costUsd, basis: "exact" as CostBasis }
      : app.spend.priceReply({ provider, account, model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedInputTokens });
  // A plan sign-in isn't billed: its figure is what the use would cost.
  return { ...tokens, costUsd: priced.costUsd, basis: kind === "signin" ? "plan" : priced.basis };
}
