// Featherless's plans, in the words the app says them. From featherless.ai/pricing and /docs/plans (edited 15 September
// 2026), read on 1 and 4 November 2026 (the ids and names behind them are in hub/src/featherless.ts):
// - Chat, $25 a month, flat: unlimited tokens, 32K of a chat at once, 4 requests at a time. "For interactive,
//   human-driven use by the purchaser. Not for reselling, app/API traffic, background automation, or benchmarking. Misuse
//   may lead to cancellation without refund." Its own table says no to coding agents.
// - Developer, from $50 of credits a month: billed per token from prepaid credits, each model at its own rate; up to 256K
//   and 100 at a time; agents, API traffic and automation allowed. When the credits run out, requests stop until more are
//   added.
// Every Crosstalk chat on Featherless is an agent driving it through the API, so the Chat plan is never the right one for
// it. That is said where Featherless is added (the Add sheet, before a key is checked), under the check once the hub has
// read which plan the key is on (GET /v1/plan, hub/src/featherless.ts), on its row in Settings → AI services, and by the
// hub in a chat run on a key it read as on the Chat plan — never to someone on the Developer plan, whom the terms allow.

import { planLabel, type ServicePlan } from "@crosstalk/shared";
import type { Site } from "./presets";

/** Featherless's plans and what each allows: linked wherever the app says what they allow. */
export const FEATHERLESS_PRICING: Site = { label: "featherless.ai/pricing", url: "https://featherless.ai/pricing" };

/** Whether an account or address is on Featherless. */
export function isFeatherless(baseUrl: string | null | undefined): boolean {
  try {
    return /(^|\.)featherless\.ai$/i.test(new URL(String(baseUrl ?? "")).hostname);
  } catch {
    return false;
  }
}

/** The line under its name in the list of services. */
export const FEATHERLESS_HELP = "Any open model from Hugging Face, uncensored ones included. Agents need its Developer plan, paid per token.";

/** What everyone adding Featherless reads before a key is checked: the plan agents need, and the one they can't use. */
export const FEATHERLESS_TERMS =
  "Agents need Featherless's Developer plan. It's paid per token from monthly credits, so set a spending limit in Settings → Costs. The $25 Chat plan doesn't allow agents or API use: Featherless can cancel an account used that way without a refund.";

/** Said on an account's row when which plan its key is on isn't known (the hub couldn't ask, or is older). */
export const FEATHERLESS_REMINDER = "Agents need Featherless's Developer plan, paid per token. Its Chat plan doesn't allow them.";

/** How a plan's words are shown: "bad" is a plan the terms don't allow agents on, "ok" one they do, "warn" one not known. */
export type PlanTone = "bad" | "ok" | "warn";

/**
 * What a checked key's plan means for using it here, in plain words: the Chat plan's terms don't allow agents (said as
 * that, with the way out), the Developer plan's do (and it's paid per token, so a limit is worth setting), and a plan
 * Crosstalk doesn't know is named, with what to check.
 */
export function planWords(plan: ServicePlan): { tone: PlanTone; text: string } {
  if (plan.kind === "chat") {
    return {
      tone: "bad",
      text: `This key is on Featherless's ${planLabel(plan)} plan, which doesn't allow agents or API use: using it here could get your account cancelled without a refund. Switch to the Developer plan first (paid per token, so set a spending limit).`,
    };
  }
  // Featherless's own list calls the Developer plan "Request Pricing": it's said as its pricing page says it (planLabel).
  if (plan.kind === "credits") return { tone: "ok", text: `This key is on Featherless's ${planLabel(plan)} plan, which allows agents. Each reply is paid per token from your credits, so set a spending limit in Settings → Costs.` };
  return { tone: "warn", text: `Featherless says this key is on “${plan.name}”, a plan Crosstalk doesn't know. Check that it allows agents: the Chat plan doesn't, the Developer plan does (paid per token).` };
}
