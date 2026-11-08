// What a Featherless key's plan means for using it here, said where it's added (AddServiceSheet) and on its row in
// Settings → AI services (AiServices). The words are in web/src/featherless.ts; the plan is the hub's GET /v1/plan read.
import type { ReactNode } from "react";
import type { ServicePlan } from "@crosstalk/shared";
import { FEATHERLESS_PRICING, planWords } from "../featherless";

/** Featherless's plans, opening in the phone's own browser. */
export function PricingLink() {
  return (
    <a href={FEATHERLESS_PRICING.url} target="_blank" rel="noreferrer noopener">
      {FEATHERLESS_PRICING.label}
    </a>
  );
}

/**
 * A key's plan in plain words, with Featherless's plans linked. `announce`: it's news (a check just came back), so the
 * Chat plan's warning is read out at once.
 */
export function PlanNote({ plan, announce = false, children }: { plan: ServicePlan; announce?: boolean; children?: ReactNode }) {
  const { tone, text } = planWords(plan);
  return (
    <div className={`svc-plan ${tone}`} role={announce && tone === "bad" ? "alert" : "status"}>
      <p>
        {text} See <PricingLink />.
      </p>
      {children}
    </div>
  );
}
