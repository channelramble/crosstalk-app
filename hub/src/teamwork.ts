// A quick question: a chat's agent asks another agent one focused question. Off by default, and built to spend as little
// as possible: the one asked gets only the question (never the chat), answers read-only, keeps no session, and isn't
// asked at all when its plan is nearly used up, its spending limit is reached or the per-reply limit is. It runs on the
// one-shot runner (oneshot.ts), the same one Ask others and helpers on another account (helpers.ts) use.
//
// Who can be asked: the accounts the person ticked in Settings → Agents together (TeamworkSettings.who), never the
// asking chat's own. With nothing ticked it is what it always was: the other one of Claude Code and Codex, on its main
// sign-in, through the tool named after it (ask_codex, ask_claude); with a choice made, the tool is ask_agent.

import { CHAT_PROVIDERS, DEFAULT_ACCOUNT, EFFORT_LABELS, PROVIDER_INFO, helperAccountLabel, limitResetTime, memberAccount, type ChatProvider, type Member } from "@crosstalk/shared";
import type { App } from "./app";
import { askHandle } from "./asks";
import { oneShotCost, runOneShot } from "./oneshot";
import { newId } from "./util/ids";
import { logger } from "./util/log";

const log = logger("teamwork");

/** How long the one asked may take to answer. */
const ANSWER_MS = 10 * 60_000;
const ANSWER_LIMIT = 8000;

/** Questions asked per reply (keyed by the asker's running turn). */
const asked = new Map<string, number>();

/** An account a chat's agent may ask: what the agent calls it (`handle`, the tool's `who`) and what it's called in words. */
export interface Askable {
  provider: ChatProvider;
  account: string;
  handle: string;
  name: string;
}

/**
 * Who this agent may ask, in the order the tool offers them. `chosen`: the person picked the accounts (the tool is
 * ask_agent); otherwise it's the other one of Claude Code and Codex on its main sign-in, as before that could be chosen.
 * Accounts that are gone, and the chat's own, are left out; whether one can answer right now is checked when it's asked.
 */
export function askable(app: App, asker: Member): { list: Askable[]; chosen: boolean } {
  const who = app.hubSettings().teamwork.who;
  const mine = (provider: string, account: string) => provider === asker.provider && account === memberAccount(asker);
  if (!Array.isArray(who)) {
    const other: ChatProvider = asker.provider === "claude" ? "codex" : "claude";
    return { list: [{ provider: other, account: DEFAULT_ACCOUNT, handle: PROVIDER_INFO[other].defaultHandle, name: PROVIDER_INFO[other].name }], chosen: false };
  }
  const all = app.providers.accounts();
  const taken = new Set<string>();
  const list: Askable[] = [];
  for (const w of who) {
    const a = all.find((x) => x.provider === w.provider && x.id === w.account);
    if (!a || !(CHAT_PROVIDERS as readonly string[]).includes(a.provider) || mine(a.provider, a.id)) continue;
    const name = a.id === DEFAULT_ACCOUNT ? PROVIDER_INFO[a.provider].name : helperAccountLabel(a, all);
    const handle = askHandle(a.provider as ChatProvider, a.id, name, taken);
    taken.add(handle);
    list.push({ provider: a.provider as ChatProvider, account: a.id, handle, name });
  }
  return { list, chosen: true };
}

export async function askHelper(app: App, askerId: string, question: string, who?: string | null): Promise<string> {
  const tw = app.hubSettings().teamwork;
  const asker = app.store.getMember(askerId);
  const room = asker ? app.store.getRoom(asker.roomId) : null;
  if (!asker || !room) return "Crosstalk couldn't find this chat. Continue on your own.";
  if (!tw.enabled) return "Teamwork is off in Crosstalk's settings, so no other agent was asked. Continue on your own.";
  const { list } = askable(app, asker);
  if (!list.length) return "There's nobody to ask: the person hasn't picked an account for questions that is still on this machine. Continue on your own.";
  const wanted = typeof who === "string" ? who.trim().replace(/^@/, "").toLowerCase() : "";
  const target = wanted ? list.find((a) => a.handle === wanted || a.name.toLowerCase() === wanted) : list[0];
  if (!target) return `There's nobody called "${who}" to ask. You can ask: ${list.map((a) => `${a.name} (who: "${a.handle}")`).join(", ")}.`;
  const { provider: other, account, name } = target;

  const turn = app.engine.runningTurns(room.id).find((t) => t.memberId === asker.id);
  const key = turn?.id ?? `no-turn:${asker.id}`;
  const n = asked.get(key) ?? 0;
  if (n >= tw.perReply) return `You've already asked ${list.length > 1 ? "another agent" : name} ${n === 1 ? "once" : `${n} times`} in this reply, the limit set in Crosstalk. Continue on your own.`;
  asked.set(key, n + 1);
  if (asked.size > 500) asked.delete(asked.keys().next().value!);

  // Never spend the last of a plan on a second opinion, nor past a spending limit.
  const usage = app.store.getUsage(other, account);
  const high = usage?.windows.find((w) => (w.usedPercent ?? 0) >= tw.skipAbovePercent && (!w.resetsAt || w.resetsAt > Date.now()));
  if (high) return `${name}'s plan is at ${Math.round(high.usedPercent!)}% of its ${high.label} limit, so Crosstalk didn't ask (it skips agents above ${tw.skipAbovePercent}%). Continue on your own.`;
  if (!app.providers.which(other)) return `${name} isn't installed on the hub. Continue on your own.`;
  const signedIn = account === DEFAULT_ACCOUNT ? app.providers.get(other).signedIn : app.providers.accounts().find((a) => a.provider === other && a.id === account)?.signedIn;
  if (signedIn === false) return `${name} isn't signed in on the hub. Continue on your own.`;
  const limit = app.spend.checkBudget(other, account);
  if (limit) return `${limit.replace(/, so this reply didn't start\.?$/, "")}, so Crosstalk didn't ask. Continue on your own.`;

  // A light model keeps a question to a plan cheap (the machine's own choice); any other account answers on its default.
  const pick = account === DEFAULT_ACCOUNT ? tw.helper[other] ?? { model: null, effort: null } : { model: null, effort: null };
  const abort = new AbortController();
  // Stop with the asker: a stopped reply doesn't need its answer.
  const watch = setInterval(() => {
    if (turn && !app.engine.runningTurns(room.id).some((t) => t.id === turn.id)) abort.abort();
  }, 2000);
  const prompt = `${question}\n\n(Another coding agent is asking you this while working in ${room.cwd}. You can read the files there but don't change anything. Answer in under 300 words.)`;
  try {
    const res = await runOneShot(app, { room, provider: other, account, model: pick.model, effort: pick.effort, prompt, systemNote: null, signal: abort.signal, timeoutMs: ANSWER_MS });
    const tokens = res.usage.inputTokens + res.usage.outputTokens;
    if (tokens || res.usage.costUsd) {
      // What it used is that account's, in the ledger like any other question.
      try {
        const known = app.providers.knownModel(other, account, pick.model);
        const model = known?.resolvedModel ?? known?.id ?? pick.model;
        const cost = oneShotCost(app, { provider: other, account, model }, res.usage);
        app.spend.record({ source: "ask", provider: other, account, roomId: room.id, chatName: room.name, askId: newId("ask"), model, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, cachedTokens: res.usage.cachedInputTokens, costUsd: cost.costUsd, basis: cost.basis });
      } catch (e) {
        log.warn(`couldn't keep a question's cost: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!res.ok && res.limit) {
      // Its plan ran out mid-reply: say when it comes back, so the asker carries on alone instead of waiting.
      const when = res.limit.resetsAt && res.limit.resetsAt > Date.now() ? ` until ${limitResetTime(res.limit.resetsAt)}` : "";
      return `${name} ${res.limit.kind === "rate" ? "has hit a rate limit" : "is out of messages"}${when}, so it couldn't answer. Continue on your own.`;
    }
    if (!res.ok) return `${name} couldn't answer${res.error ? `: ${res.error}` : "."} Continue on your own.`;
    const answer = res.text.trim();
    const how = [name, pick.model, pick.effort ? `${EFFORT_LABELS[pick.effort] ?? pick.effort} effort` : null, tokens ? `${Math.round(tokens / 100) / 10}k tokens` : null].filter(Boolean).join(" · ");
    log.info(`@${asker.handle} asked ${name} (${how})`);
    return `(${how})\n\n${answer.length > ANSWER_LIMIT ? `${answer.slice(0, ANSWER_LIMIT)}\n…(cut short)` : answer || "(no answer)"}`;
  } catch (e) {
    return `${name} couldn't answer: ${e instanceof Error ? e.message : e}. Continue on your own.`;
  } finally {
    clearInterval(watch);
  }
}
