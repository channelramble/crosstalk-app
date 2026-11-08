import { useState } from "react";
import { CircleDollarSign } from "lucide-react";
import type { AccountSpend } from "@crosstalk/shared";
import { usd } from "../money";
import { accountName, addToLimit, LIMIT_HELP, limitProblem, limitText, parseLimit, totalHelp, totalsLabel } from "../spend";
import { useStore } from "../store";
import { Dialog, Seg } from "../ui";
import { setBudget } from "../useSpend";
import { HelpTip } from "./HelpTip";

/** Sets, changes or raises one account's spending limit. `title` is the button that opened it: Set a limit, Change limit or Raise limit. */
export function LimitDialog({ account, title, onClose }: { account: AccountSpend; title: string; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const start = account.budget;
  const [amount, setAmount] = useState(start ? limitText(start.limitUsd) : "");
  const [period, setPeriod] = useState<"month" | "total">(start?.period ?? "month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = !busy && (amount !== (start ? limitText(start.limitUsd) : "") || period !== (start?.period ?? "month"));
  const save = async () => {
    const problem = limitProblem(amount);
    if (problem) return setError(problem);
    const limitUsd = parseLimit(amount)!;
    setBusy(true);
    setError("");
    try {
      await setBudget(account, { limitUsd, period });
      toast("info", `Limit is now ${usd(limitUsd)} ${period === "month" ? "a month" : "in total"}.`);
      onClose();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(`${/[.!?]$/.test(why) ? why : `${why}.`} Try again, or tap Cancel.`);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      icon={<CircleDollarSign size={20} />}
      dirty={dirty}
      onClose={() => !busy && onClose()}
      footer={(requestClose) => (
        <>
          <button className="btn" onClick={() => requestClose()} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save limit"}
          </button>
        </>
      )}
    >
      <p className="help" style={{ marginTop: 0 }}>
        <strong>{accountName(account)}</strong>. Spent so far: {totalsLabel(account.month)} this month, {totalsLabel(account.total)} in total.
      </p>
      <div className="field">
        <span className="cost-label">
          Limit in dollars <HelpTip label="What's a limit?">{LIMIT_HELP}</HelpTip>
        </span>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input mono"
            style={{ flex: 1, minWidth: 0 }}
            aria-label="Limit in dollars"
            inputMode="decimal"
            autoComplete="off"
            placeholder="e.g. 50"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError("");
            }}
          />
          <button type="button" className="btn small" aria-label="Add $50" onClick={() => setAmount(addToLimit(amount, 50))}>
            +$50
          </button>
          <button type="button" className="btn small" aria-label="Add $100" onClick={() => setAmount(addToLimit(amount, 100))}>
            +$100
          </button>
        </div>
      </div>
      <div className="field">
        <span>Counts</span>
        <Seg
          label="What the limit counts"
          value={period}
          options={[
            { id: "month", label: "Each month" },
            { id: "total", label: "In total" },
          ]}
          onChange={setPeriod}
          disabled={busy}
        />
        {/* A total limit that exists already keeps its start when it's raised: the hub starts over only for a new limit or another period. */}
        <span className="help">{period === "month" ? "Starts again on the 1st of each month." : totalHelp(start)}</span>
      </div>
      {error && (
        <p className="small cost-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
