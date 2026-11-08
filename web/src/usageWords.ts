// Settings → Usage (views/UsagePage.tsx): one window of a plan's limits in plain words — how much of it is used (said to a
// screen reader too, also when nobody knows) and when it resets. The hub looks at usage again every 15 minutes
// (hub/src/main.ts), so a reset can go by before the figures do: the line then says when it reset and how to see the
// share now, never "Resets in now".

import { limitResetTime, type AgentAccount, type Provider, type ProviderStatus, type UsageSnapshot } from "@crosstalk/shared";
import { accountKey } from "./accounts";

/** The agents in the order their cards come. */
const USAGE_ORDER: readonly Provider[] = ["claude", "codex", "muse", "antigravity", "gemini", "mock"];

/** Agents that aren't listed go last. They aren't added to the list: the hub says Crosstalk's agent and OpenCode are signed in, and each would get a card of its own. */
const usageRank = (p: Provider) => {
  const i = USAGE_ORDER.indexOf(p);
  return i < 0 ? USAGE_ORDER.length : i;
};

/**
 * The cards Settings → Usage shows: every account the hub has figures for, and every agent and account that's signed in,
 * plans first, in the agents' order, then services. A service Crosstalk's own agent or OpenCode runs has a card of its own
 * that says it reports no limits (UsageCard): those agents have no plan and no sign-in, so neither gets a card for itself.
 * Nor the test agent's own sign-in.
 */
export function usageCards(
  usage: Readonly<Record<string, Pick<UsageSnapshot, "provider">>>,
  accounts: Readonly<Record<string, Pick<AgentAccount, "provider" | "id" | "signedIn">>>,
  providers: Readonly<Partial<Record<Provider, Pick<ProviderStatus, "signedIn"> | undefined>>>,
): { key: string; provider: Provider }[] {
  const keys = new Set(Object.keys(usage));
  for (const a of Object.values(accounts)) if (a.signedIn) keys.add(accountKey(a.provider, a.id));
  for (const p of USAGE_ORDER) if (p !== "mock" && providers[p]?.signedIn) keys.add(p);
  return [...keys]
    .map((key) => ({ key, provider: usage[key]?.provider ?? accounts[key]?.provider ?? (key.split(":")[0] as Provider) }))
    .sort((a, b) => usageRank(a.provider) - usageRank(b.provider));
}

/** "Resets in 2 h 5 min", "Resets in 3 d 4 h"; once that time has gone by, "Reset at 3:20 PM. Tap Refresh to see what's used now." */
export function usageResetLine(resetsAt: number, now = Date.now()): string {
  const s = Math.round((resetsAt - now) / 1000);
  if (s <= 0) return `Reset at ${limitResetTime(resetsAt, now)}. Tap Refresh to see what's used now.`;
  if (s < 3600) return `Resets in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return `Resets in ${m ? `${h} h ${m} min` : `${h} h`}`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return `Resets in ${h ? `${d} d ${h} h` : `${d} d`}`;
}

/** What a window's meter says to a screen reader: what the eye reads beside it, and "Not known" (never 0%) when its share isn't. */
export function usageShareText(usedPercent: number | null): string {
  return usedPercent === null || !Number.isFinite(usedPercent) ? "Not known" : `${Math.round(usedPercent)}% used`;
}
