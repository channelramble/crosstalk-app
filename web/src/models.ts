import { baseModelId, toolCostWords, type ModelCatalog, type ModelOption, type Provider, type ToolCost } from "@crosstalk/shared";

/**
 * The list's entry for a saved model name. A model is saved either as the agent's own id ("haiku") or as the concrete
 * model that id stands for ("claude-haiku-4-5-20251001", which is what the model row under the message box saves), so
 * both name the same entry. Undefined for a model of your own that the agent doesn't list.
 */
export function listedModel<M extends Pick<ModelOption, "id" | "resolvedModel">>(models: readonly M[], model: string | null | undefined): M | undefined {
  if (!model) return undefined;
  return models.find((m) => m.id === model || m.resolvedModel === model);
}

/**
 * Whether `model` needs the "Other…" field for `provider`: true if it isn't in that provider's list, false if it
 * is (or is empty), and null if `catalog` belongs to another provider or hasn't loaded, so it can't be judged yet.
 */
export function isCustomModel(model: string, catalog: (ModelCatalog & { accountId?: string | null }) | null, provider: Provider, accountId?: string | null): boolean | null {
  if (!model) return false;
  if (!catalog || catalog.provider !== provider || (catalog.accountId ?? "default") !== (accountId ?? "default")) return null;
  return !listedModel(catalog.models, model);
}

/** An empty effort list on a known model means unsupported, not "still loading". */
export function effortSelection(catalog: ModelCatalog | null | undefined, provider: Provider, model: string | null, effort: string | null, accountId?: string | null) {
  if (!catalog || catalog.provider !== provider || (catalog.accountId ?? "default") !== (accountId ?? "default")) {
    return { known: false, levels: [] as string[], value: effort ?? "", chosen: undefined };
  }
  const chosen = model ? listedModel(catalog.models, model) : catalog.models.find((m) => m.isDefault);
  // Antigravity model slugs can encode effort; don't invent overrides for an unlisted model.
  const levels = chosen?.efforts ?? (model && provider !== "antigravity" ? [...new Set(catalog.models.flatMap((m) => m.efforts))] : []);
  const known = !!chosen || provider === "antigravity" || levels.length > 0;
  return { known, levels, value: known ? levels.includes(effort ?? "") ? effort! : "" : effort ?? "", chosen };
}

/**
 * A context size, short: "32k", "272k", "1M", "1.05M". A size a model server gives in binary steps is read the way the
 * model names it (32,768 is "32k", 1,048,576 is "1M"), as services.ts formatContext does for Settings → AI services:
 * one model must never read "32k" while it's added and "33k" in the menu where it's picked.
 */
export function contextSize(n: number): string {
  const binary = n % 1024 === 0;
  const k = n / (binary ? 1024 : 1000);
  // Millions: the sizes the agents give need the second decimal (1,050,000 is "1.05M"); a binary size never does.
  if (k >= 1000) return `${Number((k / (binary ? 1024 : 1000)).toFixed(binary ? 1 : 2))}M`;
  return `${Math.max(1, Math.round(k))}k`;
}

/** What a model can hold, for its line in a list: "1M context", or "272k context, up to 872k" (long context). */
export function contextLabel(m: Pick<ModelOption, "contextWindow" | "maxContextWindow"> | null | undefined): string | null {
  if (!m?.contextWindow) return null;
  const more = m.maxContextWindow && m.maxContextWindow > m.contextWindow ? `, up to ${contextSize(m.maxContextWindow)}` : "";
  return `${contextSize(m.contextWindow)} context${more}`;
}

/** How long a model the agent started offering counts as new. */
export const NEW_MODEL_MS = 14 * 24 * 3600_000;

export function isNewModel(m: Pick<ModelOption, "firstSeen" | "more">, now = Date.now()): boolean {
  // One under More models isn't news: the agent keeps it out of its usual list (and the first list that had them dates them all).
  return !m.more && !!m.firstSeen && now - m.firstSeen >= 0 && now - m.firstSeen < NEW_MODEL_MS;
}

/**
 * A model list as pickers show it: the usual models, and those the agent keeps out of its usual list (More models),
 * each in the agent's order. The model in use (`chosen`) stays with the usual ones too, so it's always in view.
 */
export function modelGroups<M extends Pick<ModelOption, "id" | "more">>(models: M[], chosen?: string | null): { usual: M[]; more: M[] } {
  return { usual: models.filter((m) => !m.more || (!!chosen && m.id === chosen)), more: models.filter((m) => m.more) };
}

/** A list long enough that a menu offers a way to find one in it (a service's own models, 20 of them). */
export const MODEL_FIND_FROM = 10;

/**
 * The models of a list that match what was typed, by name or by id, in the list's own order. An empty query keeps them
 * all, so a menu only ever narrows what it already shows.
 */
export function findModels<M extends Pick<ModelOption, "id" | "label">>(models: M[], query: string): M[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
}

/** A model's line in a drop-down: its name, what it holds, and whether it's new ("Sonnet 4.6 · 200k · New"). */
export function modelOptionText(m: ModelOption): string {
  // "No tools": its service says it can't run tool calls, so an agent on it couldn't read a file or run a command.
  return [m.label, m.contextWindow ? contextSize(m.contextWindow) : null, isNewModel(m) ? "New" : null, m.noTools ? "No tools" : null].filter(Boolean).join(" · ");
}

/** The help under a chosen model: the agent's description of it, and what it holds. */
export function modelHelp(m: ModelOption | null | undefined): string | null {
  if (!m) return null;
  return [m.description, contextLabel(m)].filter(Boolean).join(" · ") || null;
}

/**
 * When a measurement was taken, the way a person would say it on their own phone (its clock, not the hub's): "today",
 * "yesterday", else the date. Null for nothing measured, or for a time ahead of this device's clock — the two phones
 * disagreeing is no reason to say something untrue.
 */
export function measuredWhen(at: number | null | undefined, now = Date.now()): string | null {
  if (!at || at > now + 60_000) return null;
  const day = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `on ${new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
}

/**
 * What the tools cost on a model, for the help where a model is picked and for a service's row in Settings: the measured
 * figure against what the model holds, and when it was taken (shared `toolCostWords`). Null when nothing has been measured.
 *
 * A model where it doesn't matter says nothing, so the line only ever appears where it changes a decision: the tools fill
 * half the window or more, something had to be left out, or nothing says what the model holds. `always` is for a service's
 * own row, which is a place a person goes to look the figure up.
 */
export function toolCostLine(cost: ToolCost | null | undefined, opts: { name?: string | null; always?: boolean; now?: number } = {}): string | null {
  if (!cost) return null;
  const matters = !!cost.dropped || !cost.window || cost.tools * 2 >= cost.window;
  if (!matters && !opts.always) return null;
  return toolCostWords(cost, { model: opts.name, when: measuredWhen(cost.at, opts.now) });
}

/** Whether two model ids name the same model ("claude-opus-5-5[1m]" and "claude-opus-5-5" do). */
export function sameModelId(a: string, b: string): boolean {
  return baseModelId(a) === baseModelId(b);
}
