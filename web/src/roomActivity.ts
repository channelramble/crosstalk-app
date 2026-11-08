import { PROVIDER_INFO, type Provider, type RoomActivity } from "@crosstalk/shared";

export type RoomAgentActivity = RoomActivity;

/** Only agents that have actually contributed belong in a room's icon. */
export function roomContributors(activity: RoomAgentActivity[]): RoomAgentActivity[] {
  const totals = new Map<Provider, RoomAgentActivity>();
  for (const a of activity) {
    if (!PROVIDER_INFO[a.provider] || !Number.isFinite(a.turns) || a.turns <= 0) continue;
    const old = totals.get(a.provider);
    totals.set(a.provider, { provider: a.provider, turns: (old?.turns ?? 0) + a.turns, outputTokens: (old?.outputTokens ?? 0) + (Number.isFinite(a.outputTokens) ? Math.max(0, a.outputTokens) : 0) });
  }
  return [...totals.values()].sort((a, b) => b.turns - a.turns || a.provider.localeCompare(b.provider));
}

/** A square-root scale keeps occasional contributors visible, with equal work receiving equal sizes. */
export function contributionSize(turns: number, mostTurns: number, compact: boolean): number {
  const min = compact ? 11 : 15;
  const max = compact ? 22 : 30;
  return Math.round(min + (max - min) * Math.sqrt(Math.min(1, Math.max(0, turns / Math.max(1, mostTurns)))));
}
