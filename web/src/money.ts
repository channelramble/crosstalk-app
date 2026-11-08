import type { CostBasis } from "@crosstalk/shared";

/** A dollar figure for a phone: cents below $100 ("$0.04", "$47.20"), whole dollars from $100 ("$200", "$1,235"), and "<$0.01" for less than a cent. */
export function usd(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  if (amount > 0 && amount < 0.005) return "<$0.01";
  const cents = Math.round(Math.max(0, amount) * 100);
  return cents >= 10_000 ? `$${Math.round(cents / 100).toLocaleString("en-US")}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * What a reply or an ask cost, with how sure Crosstalk is: "$0.04" (the agent reported it), "≈$0.04" (worked out from
 * tokens and a price list), "—" (no price known), "Free" (a model on this machine), "Plan" (a plan sign-in: not billed).
 */
export function costLabel(costUsd: number | null, basis: CostBasis): string {
  switch (basis) {
    case "free":
      return "Free";
    case "plan":
      return "Plan";
    case "unknown":
      return "—";
    case "estimated":
      return costUsd === null ? "—" : `≈${usd(costUsd)}`;
    default:
      return costUsd === null ? "—" : usd(costUsd);
  }
}
