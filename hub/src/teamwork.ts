// Teamwork: a chat's agent asks the other agent one focused question. Off by default, and built to spend as little
// of the user's plans as possible: the helper gets only the question (never the chat), answers read-only with a
// light model, keeps no session, and isn't asked at all when its plan is nearly used up or the per-reply limit is
// reached.

import { DEFAULT_ACCOUNT, EFFORT_LABELS, PROVIDER_INFO, limitResetTime, type Member, type Provider } from "@crosstalk/shared";
import type { App } from "./app";
import { createDriver } from "./agents";
import type { TurnSink } from "./agents/driver";
import { newId } from "./util/ids";
import { logger } from "./util/log";

const log = logger("teamwork");

/** How long a helper may take to answer. */
const ANSWER_MS = 10 * 60_000;
const ANSWER_LIMIT = 8000;

/** Questions asked per reply (keyed by the asker's running turn). */
const asked = new Map<string, number>();

export async function askHelper(app: App, askerId: string, question: string): Promise<string> {
  const tw = app.hubSettings().teamwork;
  const asker = app.store.getMember(askerId);
  const room = asker ? app.store.getRoom(asker.roomId) : null;
  if (!asker || !room) return "Crosstalk couldn't find this chat. Continue on your own.";
  if (!tw.enabled) return "Teamwork is off in Crosstalk's settings, so no other agent was asked. Continue on your own.";
  const other: Provider = asker.provider === "claude" ? "codex" : "claude";
  const name = PROVIDER_INFO[other].name;

  const turn = app.engine.runningTurns(room.id).find((t) => t.memberId === asker.id);
  const key = turn?.id ?? `no-turn:${asker.id}`;
  const n = asked.get(key) ?? 0;
  if (n >= tw.perReply) return `You've already asked ${name} ${n === 1 ? "once" : `${n} times`} in this reply, the limit set in Crosstalk. Continue on your own.`;
  asked.set(key, n + 1);
  if (asked.size > 500) asked.delete(asked.keys().next().value!);

  // Never spend the last of a plan on a second opinion.
  const usage = app.store.getUsage(other, DEFAULT_ACCOUNT);
  const high = usage?.windows.find((w) => (w.usedPercent ?? 0) >= tw.skipAbovePercent && (!w.resetsAt || w.resetsAt > Date.now()));
  if (high) return `${name}'s plan is at ${Math.round(high.usedPercent!)}% of its ${high.label} limit, so Crosstalk didn't ask (it skips agents above ${tw.skipAbovePercent}%). Continue on your own.`;
  const bin = app.providers.which(other);
  if (!bin) return `${name} isn't installed on the hub. Continue on your own.`;
  if (app.providers.get(other).signedIn === false) return `${name} isn't signed in on the hub. Continue on your own.`;

  const pick = tw.helper[other] ?? { model: null, effort: null };
  const helper: Member = {
    id: newId("helper"),
    roomId: room.id,
    handle: PROVIDER_INFO[other].defaultHandle,
    provider: other,
    model: pick.model,
    role: "",
    permissionMode: "ask", // read-only: anything that needs approval is refused
    status: "idle",
    statusDetail: null,
    config: pick.effort ? { effort: pick.effort } : {},
    createdAt: Date.now(),
    position: 0,
  };
  const driver = createDriver({
    room,
    member: helper,
    session: {},
    mcp: app.mcpLaunch(helper),
    env: app.providers.agentEnv(other, DEFAULT_ACCOUNT),
    bin,
    chat: { helper: null, ephemeral: true },
  });
  const abort = new AbortController();
  let text = "";
  let tokens = 0;
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
      tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0) || tokens;
    },
    rateLimit: () => {},
    status: () => {},
    saveSession: () => {},
    heartbeat: () => {},
  };
  // Stop with the asker: a stopped reply doesn't need its answer.
  const watch = setInterval(() => {
    if (turn && !app.engine.runningTurns(room.id).some((t) => t.id === turn.id)) abort.abort();
  }, 2000);
  const timer = setTimeout(() => abort.abort(), ANSWER_MS);
  const prompt = `${question}\n\n(Another coding agent is asking you this while working in ${room.cwd}. You can read the files there but don't change anything. Answer in under 300 words.)`;
  try {
    const res = await driver.runTurn({ turnId: newId("t"), prompt, systemNote: null }, sink);
    if (!res.ok && res.limit) {
      // Its plan ran out mid-reply: say when it comes back, so the asker carries on alone instead of waiting.
      const when = res.limit.resetsAt && res.limit.resetsAt > Date.now() ? ` until ${limitResetTime(res.limit.resetsAt)}` : "";
      return `${name} ${res.limit.kind === "rate" ? "has hit a rate limit" : "is out of messages"}${when}, so it couldn't answer. Continue on your own.`;
    }
    if (!res.ok) return `${name} couldn't answer${res.error && res.error !== "stopped" ? `: ${res.error}` : "."} Continue on your own.`;
    const answer = (res.text ?? text).trim();
    const how = [name, pick.model, pick.effort ? `${EFFORT_LABELS[pick.effort] ?? pick.effort} effort` : null, tokens ? `${Math.round(tokens / 100) / 10}k tokens` : null].filter(Boolean).join(" · ");
    log.info(`@${asker.handle} asked ${name} (${how})`);
    return `(${how})\n\n${answer.length > ANSWER_LIMIT ? `${answer.slice(0, ANSWER_LIMIT)}\n…(cut short)` : answer || "(no answer)"}`;
  } catch (e) {
    return `${name} couldn't answer: ${e instanceof Error ? e.message : e}. Continue on your own.`;
  } finally {
    clearInterval(watch);
    clearTimeout(timer);
    await driver.dispose().catch(() => undefined);
  }
}
