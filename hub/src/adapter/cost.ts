// What a Codex request costs on a model server of your own, as measured when one actually went through the translator, kept so a
// person can see it before they start the next chat (Settings → AI services, and the model picker).
//
// Measured, never guessed: Codex attaches every tool the person's own Codex and ChatGPT-app setup offers to each request (it can
// be hundreds of them and over 100,000 tokens, mostly ChatGPT connectors), which no small model can hold — and the only
// place that is known is here, where the request passes through. So there is one entry per account and model, written the first
// time a request for that pair goes through and refreshed as later ones do, and **nothing at all** for a model no request has
// been sent to. A figure invented for a model nobody has used would be a guess about someone else's catalogue.
//
// The numbers are the request as Codex sent it (before fitToWindow leaves anything out), so they say what the agent costs, not
// what Crosstalk managed to squeeze through.

import type { ToolCost } from "@crosstalk/shared";
import type { RequestSize, Trimmed } from "./translate";

/** kv key: the measurements, by "provider:account" (keyed like `modelContext`, so forgetting an account clears them too). */
export const KV_COST = "adapterToolCost";

/** Every measurement kept: `{ "codex:<accountId>": { "<model>": ToolCost } }`. */
export type ToolCosts = Record<string, Record<string, ToolCost>>;

/** The least any kv write is apart for one account and model: a chat's every turn measures, and only the newest is kept. */
const WRITE_GAP_MS = 5 * 60_000;

/** The most models kept per account, oldest measurement first out: a catalogue service can be asked about many. */
const MAX_MODELS = 24;

/** What this file needs of the hub's store (kv only). */
interface Kv {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
}

export const costKey = (provider: string, accountId: string): string => `${provider}:${accountId}`;

export function readToolCosts(store: Kv): ToolCosts {
  try {
    const raw = store.kvGet(KV_COST);
    const all: unknown = raw ? JSON.parse(raw) : {};
    return all && typeof all === "object" && !Array.isArray(all) ? (all as ToolCosts) : {};
  } catch {
    return {}; // nothing usable saved
  }
}

/** What was measured for one account's models, newest first; empty when none of them has been used. */
export function toolCostsFor(store: Kv, provider: string, accountId: string): Record<string, ToolCost> {
  return readToolCosts(store)[costKey(provider, accountId)] ?? {};
}

/** The newest measurement of an account, whatever model it was on: what a service's own line says (its catalogue is the same for all of them). */
export function newestToolCost(store: Kv, provider: string, accountId: string): ToolCost | null {
  const mine = Object.values(toolCostsFor(store, provider, accountId));
  return mine.sort((a, b) => b.at - a.at)[0] ?? null;
}

/** One request's measurement, as the wire carries it. `at` is the request's own time, so the words can say when it was taken. */
export function measure(model: string, size: RequestSize, window: number | null, fit: Trimmed | null, at = Date.now()): ToolCost {
  return {
    at,
    model,
    tools: size.tools,
    toolCount: size.toolCount,
    prompt: size.total,
    window,
    ...(fit?.dropped ? { dropped: fit.dropped } : {}),
  };
}

/**
 * Keeps a measurement, if it is worth a write: the first for this account and model, one whose figures changed, or one at least
 * `WRITE_GAP_MS` newer than what is kept (so a chat's every turn doesn't write to the database, while the time shown stays
 * roughly true). Answers whether it wrote.
 *
 * "Changed" means the figures a decision rests on: what the tools cost, how many there are, what the model holds. Not the two
 * that follow the conversation's own size — `prompt` (the whole request) and `dropped` (fewer tools fit as a chat grows) — which
 * are different almost every turn: comparing those made every single request a database write and a pair of bus events to every
 * phone, each re-rendering the model picker and the Settings row, which is exactly what this gap exists to prevent. They are
 * still refreshed with the rest once the gap has passed, and what the kept set is was never a promise about the next request
 * (ToolCost's own doc).
 */
export function noteToolCost(store: Kv, provider: string, accountId: string, cost: ToolCost, gapMs = WRITE_GAP_MS): boolean {
  const all = readToolCosts(store);
  const key = costKey(provider, accountId);
  const mine = { ...(all[key] ?? {}) };
  const had = mine[cost.model];
  const same = had && had.tools === cost.tools && had.toolCount === cost.toolCount && had.window === cost.window;
  if (had && same && cost.at - had.at < gapMs) return false;
  mine[cost.model] = cost;
  const kept = Object.entries(mine)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_MODELS);
  store.kvSet(KV_COST, JSON.stringify({ ...all, [key]: Object.fromEntries(kept) }));
  return true;
}
