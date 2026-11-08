import type { AgentAccount, AskChoice } from "@crosstalk/shared";
import { askModelCostLine, askPickerFor, fixedModelLine, pickableModels, pickedModel, type AskModelPick } from "../asks";
import { AgentOptions } from "./AgentOptions";

/** Another machine's accounts aren't this one's: none of this machine's notes about its own accounts apply to them. */
const NO_ACCOUNTS: Record<string, AgentAccount> = {};

/**
 * Under a picked row of the Ask others sheet: which model answers, and how hard it thinks where that model has levels. It is
 * the model picker the other screens use (AgentOptions: the same list, sizes, "No tools" marks, and the lines that say what a
 * model costs to run), on the models the hub listed for this row, so a change asks nothing of anyone: the pick goes with Ask,
 * and the hub keeps it for next time then. Under it, what asks on that model have cost. A row whose model can't be picked
 * here says why instead (the model pool runs one model; another machine needs a Crosstalk update first).
 */
export function AskModelPicker({ choice, pick, onChange }: { choice: AskChoice; pick: AskModelPick; onChange: (pick: AskModelPick) => void }) {
  const fixed = fixedModelLine(choice);
  if (fixed) return <p className="help ask-model-note">{fixed}</p>;
  const models = pickableModels(choice);
  if (!models) return null;
  const cost = askModelCostLine(pickedModel(choice, pick), choice.local);
  return (
    <div className="ask-model" role="group" aria-label={`Model for ${askPickerFor(choice)}`}>
      <AgentOptions
        provider={choice.target.provider}
        value={{ account: choice.target.account, model: pick.model, effort: pick.effort, permissionMode: "ask" }}
        onChange={(v) => onChange({ model: v.model, effort: v.effort })}
        offer={models}
        accountList={choice.machine ? NO_ACCOUNTS : undefined}
        showAccount={false}
        showPermissions={false}
        showHelpers={false}
        other={false}
      />
      {cost && <p className="help ask-model-cost">{cost}</p>}
    </div>
  );
}
