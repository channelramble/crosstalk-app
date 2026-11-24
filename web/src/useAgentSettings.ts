import { chatContextSize, PROVIDER_INFO, permissionInfo, wantsLongContext, type ChatContextSize, type Member, type ModelOption, type PermissionMode, type Room } from "@crosstalk/shared";
import { api } from "./api";
import { accountKey, memberAccount } from "./accounts";
import { chipWords, isBusy } from "./chatSettings";
import { sameModelId } from "./models";
import { useStore } from "./store";
import { useCatalog } from "./useCatalog";

/** Agents whose helper agents Crosstalk holds to a model: Claude Code's subagents and workflows, Codex's spawned agents. */
const WITH_HELPERS = ["claude", "codex"];

/** The newest reading of how much of the chat its agent's model holds: from its last finished reply that reported one. */
function useContextReading(room: Room, member: Member) {
  return useStore((s) => {
    const turns = Object.values(s.roomData[room.id]?.turns ?? {});
    let best: { tokens: number; window: number | null; at: number } | null = null;
    for (const t of turns) {
      const tokens = t.usage?.contextTokens;
      if (t.memberId !== member.id || typeof tokens !== "number" || tokens <= 0) continue;
      const at = t.endedAt ?? t.startedAt ?? t.createdAt;
      if (!best || at > best.at) best = { tokens, window: t.usage?.contextWindow ?? null, at };
    }
    return best ? `${best.tokens}|${best.window ?? ""}` : "";
  });
}

function parseContext(s: string): { tokens: number; window: number | null } | null {
  if (!s) return null;
  const [t, w] = s.split("|");
  return { tokens: Number(t), window: w ? Number(w) : null };
}

/**
 * How full the model's memory of this chat is: the newest reading's tokens against what the chat's model holds, as its
 * agent's model list says (so a model just switched to, or long context just turned on, counts at once). Without a
 * list entry, the size the agent reported with the reading.
 */
export function useChatContext(room: Room, member: Member, model: ModelOption | undefined): { tokens: number | null; window: number | null; size: ChatContextSize | null } {
  const reading = parseContext(useContextReading(room, member));
  const size = chatContextSize(model, member.provider === "codex" && wantsLongContext(member.config));
  return { tokens: reading?.tokens ?? null, window: size?.usable ?? reading?.window ?? null, size };
}

/** A size to summarize at that was picked for a bigger model and that the new one doesn't reach goes back to the agent's default. */
export function fitCompaction(config: Record<string, unknown>, size: ChatContextSize | null) {
  const n = config.autoCompact;
  if (typeof n === "number" && size && n >= (size.compactAt ?? size.usable)) delete config.autoCompact;
}

/**
 * One agent of a chat as its settings show it, and the changes they make. Every change is saved at once (the hub
 * applies it at the agent's next reply); a save that fails says so and leaves the chat as it was.
 */
export function useAgentSettings(room: Room, member: Member) {
  const toast = useStore((s) => s.toast);
  const account = memberAccount(member);
  // Model lists come from each agent's CLI, through the machine, which says when one changes.
  const { catalog } = useCatalog(member.provider, account);
  const signIn = useStore((s) => s.accounts[accountKey(member.provider, account)]);
  /** A chat on a service or model of yours: its name. */
  const endpoint = signIn?.kind === "endpoint" ? signIn.label : null;
  const agentName = PROVIDER_INFO[member.provider].name;

  const actual = member.resolvedModel ?? member.model;
  const models = catalog?.models ?? [];
  const def = models.find((m) => m.isDefault);
  // What the memory meter reads sizes from: only the list's entry for exactly this model.
  const exact = actual ? models.find((m) => m.id === actual || m.resolvedModel === actual) : def;
  // "claude-opus-5-5[1m]" is Opus 5.5 run another way: the same entry for its name and effort levels (not its size).
  const current = exact ?? (actual ? models.find((m) => sameModelId(m.resolvedModel ?? m.id, actual) || sameModelId(m.id, actual)) : undefined);
  // The agent listed the chat's model before, and doesn't now.
  const gone = !!actual && !current && !!catalog?.live && !!catalog.gone?.some((g) => sameModelId(g, actual));
  const effort = typeof member.config?.effort === "string" ? member.config.effort : "";
  const levels = current?.efforts ?? [];
  const shownEffort = effort && levels.includes(effort) ? effort : current?.defaultEffort ?? "";
  const perm = permissionInfo(member.provider, member.permissionMode);
  // Claude Code's Ultracode is a separate switch (Codex's equivalent is its Ultra effort level, already a step).
  const ultracodeOffered = member.provider === "claude" && levels.length > 0;
  const ultracode = ultracodeOffered && member.config?.ultracode === true;
  // The faster (pricier) way to run this model, when it has one: Claude Code's fast mode, Codex's Fast tier.
  const fast = current?.fast ?? null;
  const fastOn = !!fast && member.config?.fast === true;
  // Helpers use the chat's model unless one is picked for them.
  const helpersOffered = WITH_HELPERS.includes(member.provider) && models.length > 0;
  const helperId = typeof member.config?.helperModel === "string" ? member.config.helperModel : "";
  const helper = helperId ? models.find((m) => m.id === helperId || m.resolvedModel === helperId) ?? { id: helperId, label: helperId } : null;
  // Codex can give a chat more than its model's usual size (the most its model list allows).
  const longOffered = member.provider === "codex" && !!exact?.contextWindow && !!exact.maxContextWindow && exact.maxContextWindow > exact.contextWindow;
  const long = longOffered && wantsLongContext(member.config);

  const patch = async (body: Partial<Member>): Promise<boolean> => {
    try {
      await api("PATCH", `/api/members/${member.id}`, body);
      return true;
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  /** One setting kept in the agent's config: on with a value, off (the agent's own default) without. */
  const setConfig = (key: string, value: unknown, also?: (config: Record<string, unknown>) => void) => {
    const config = { ...member.config };
    if (value === undefined || value === null || value === "" || value === false) delete config[key];
    else config[key] = value;
    also?.(config);
    return patch({ config });
  };

  const chooseModel = (id: string) => {
    const next = models.find((m) => m.id === id);
    // What the chat is saved as running: the concrete model behind the agent's own id, where it says one.
    const saved = next?.resolvedModel ?? id;
    const config = { ...member.config };
    // A level the new model doesn't take would fail the next reply (a typed name's levels aren't known: it's kept).
    if (next && typeof config.effort === "string" && !next.efforts.includes(config.effort)) delete config.effort;
    // Helpers on the chat's own model again need no separate pick.
    if (config.helperModel === id || config.helperModel === saved) delete config.helperModel;
    // Long context goes with a model that has it.
    if (config.longContext && !(next?.maxContextWindow && next.contextWindow && next.maxContextWindow > next.contextWindow)) delete config.longContext;
    fitCompaction(config, chatContextSize(next, member.provider === "codex" && wantsLongContext(config)));
    return patch({ model: saved, config });
  };

  return {
    account,
    agentName,
    catalog,
    endpoint,
    models,
    actual,
    exact,
    current,
    gone,
    levels,
    effort,
    shownEffort,
    perm,
    ultracodeOffered,
    ultracode,
    fast,
    fastOn,
    helpersOffered,
    helperId,
    helper,
    longOffered,
    long,
    busy: isBusy(member),
    words: chipWords(member, models, current),
    patch,
    setConfig,
    chooseModel,
    setEffort: (v: string) => setConfig("effort", v && v !== current?.defaultEffort ? v : ""),
    setFast: (on: boolean) => setConfig("fast", on),
    setUltracode: (on: boolean) => setConfig("ultracode", on),
    setLong: (on: boolean) => setConfig("longContext", on, (config) => fitCompaction(config, chatContextSize(exact, on))),
    setHelperModel: (v: string) => setConfig("helperModel", v),
    setCompactAt: (v: string) => setConfig("autoCompact", v ? Number(v) : ""),
    setPermission: (mode: PermissionMode) => patch({ permissionMode: mode }),
    /** Another of the agent's accounts: its model, effort and helper model go back to that account's own. */
    switchAccount: (id: string) => {
      const config: Record<string, unknown> = { ...member.config, account: id };
      delete config.effort;
      delete config.helperModel;
      return patch({ model: null, config });
    },
  };
}

export type AgentSettings = ReturnType<typeof useAgentSettings>;
