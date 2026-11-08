// Settings -> Costs (docs/SPEC-0.4.md, track T4): what each account has cost, and the limits that stop new replies.
import { useEffect, useRef, useState } from "react";
import type { AccountSpend, HubSettings } from "@crosstalk/shared";
import { api } from "../api";
import {
  accountName,
  accountSub,
  anyApproximate,
  APPROX_NOTE,
  BEFORE_COSTS,
  billedAccounts,
  FLAT_RATE_NOTE,
  limitApproximate,
  limitMeter,
  LIMIT_HELP,
  periodWords,
  PERIODS,
  sharedLimitNote,
  stoppedText,
  sumTotals,
  totalsLabel,
  unpricedLine,
  usedOfLimit,
  visibleAccounts,
  warnText,
  type CostTotals,
} from "../spend";
import { useStore } from "../store";
import { ConfirmButton, ProviderAvatar, Switch, timeAgo } from "../ui";
import { setBudget, useSpendSummary } from "../useSpend";
import { HelpTip } from "./HelpTip";
import { LimitDialog } from "./LimitDialog";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The hub's "Look up prices online" setting (an optional field of its settings: absent means on). It isn't in the contract yet. */
// With the switch off the hub makes no request, but it still prices from the list it already kept.
const PRICE_HELP = "Crosstalk checks a public price list on the internet about once a day, to work out what a reply cost when the agent doesn't say. It sends nothing about you or your chats. Turned off, Crosstalk makes no request and uses the last list it kept. Replies with a model that isn't on it show a dash and aren't counted.";

/** The Costs block of Settings, after Usage. */
export function CostsSection() {
  const { accounts, prices, error, reload } = useSpendSummary();
  const [dialog, setDialog] = useState<{ account: AccountSpend; title: string } | null>(null);
  const shown = accounts ? visibleAccounts(accounts) : [];
  // Only what is billed is added up: a plan sign-in's figure is what the use would cost, and has a card of its own.
  const billed = billedAccounts(shown);
  return (
    <>
      <h2 className="settings-heading" id="costs">
        Costs
      </h2>
      <p className="help" style={{ marginTop: 0 }}>
        What your AI accounts cost at API prices. Plan sign-ins show what the use would cost; only API keys and online services are billed.
      </p>
      {accounts === null ? (
        error ? (
          <div className="card" role="alert">
            <p style={{ marginTop: 0 }}>{error.older ? "This machine's hub is older and can't show costs yet. Update Crosstalk on it, then try again." : `Couldn't load costs: ${error.message}`}</p>
            <button className="btn small" onClick={reload}>
              Try again
            </button>
          </div>
        ) : (
          <p className="muted" role="status">
            Loading costs…
          </p>
        )
      ) : (
        <>
          {shown.length === 0 ? (
            <div className="card cost-empty" role="status">
              <div className="cost-empty-title">No replies yet</div>
              <p className="help" style={{ marginBottom: 0 }}>
                What your accounts cost shows up here after their first replies.
              </p>
            </div>
          ) : (
            <>
              {billed.length > 1 && (
                <section className="card cost-card" aria-label="Costs for billed accounts">
                  <div className="cost-name">Billed accounts</div>
                  <Totals today={sumTotals(billed.map((a) => a.today))} month={sumTotals(billed.map((a) => a.month))} total={sumTotals(billed.map((a) => a.total))} />
                </section>
              )}
              {shown.map((a) => (
                <AccountCard key={`${a.provider}:${a.account}`} a={a} onLimit={(title) => setDialog({ account: a, title })} />
              ))}
            </>
          )}
          <PriceLookup />
          <p className="tiny muted cost-foot">Crosstalk adds up what each reply reports. The exact bill is on your provider's site.</p>
          {anyApproximate(shown) && <p className="tiny muted cost-foot">{APPROX_NOTE}</p>}
          <p className="tiny muted cost-foot">{BEFORE_COSTS}</p>
          {prices && (
            <p className="tiny muted cost-foot">
              Prices from {prices.source}
              {prices.fetchedAt ? `, checked ${timeAgo(prices.fetchedAt)}` : ""}.
            </p>
          )}
        </>
      )}
      {dialog && <LimitDialog account={dialog.account} title={dialog.title} onClose={() => setDialog(null)} />}
    </>
  );
}

/** Today, this month and in total, as three figures (≈ when some were estimated); replies without a price are said under them. */
function Totals({ today, month, total }: { today: CostTotals; month: CostTotals; total: CostTotals }) {
  const by = { today, month, total };
  const unpriced = unpricedLine(total.unpriced);
  return (
    <>
      <dl className="cost-grid">
        {PERIODS.map((p) => (
          <div className="cost-cell" key={p.id}>
            <dt>{p.label}</dt>
            <dd>{totalsLabel(by[p.id])}</dd>
          </div>
        ))}
      </dl>
      {unpriced && <p className="cost-note">{unpriced} · not in the figures above</p>}
    </>
  );
}

function AccountCard({ a, onLimit }: { a: AccountSpend; onLimit: (title: string) => void }) {
  const toast = useStore((s) => s.toast);
  const b = a.budget;
  const meter = b ? limitMeter(b) : null;
  // The same name everywhere on the card, with the agent in it: two sign-ins can both be called "Main".
  const name = accountName(a);
  const remove = async () => {
    try {
      await setBudget(a, { limitUsd: null });
      toast("info", "Limit removed.");
    } catch (e) {
      toast("error", `Couldn't remove the limit: ${message(e)}`, { action: { label: "Try again", run: remove } });
    }
  };
  // At the limit, the button says what you came to do.
  const change = meter?.state === "stopped" ? "Raise limit" : "Change limit";
  return (
    <section className="card cost-card" aria-label={`Costs for ${name}`}>
      <div className="cost-head">
        <ProviderAvatar provider={a.provider} size="sm" />
        <div className="cost-head-text">
          <div className="cost-name">{name}</div>
          <div className="cost-sub">{accountSub(a)}</div>
        </div>
      </div>
      {a.total.replies > 0 ? <Totals today={a.today} month={a.month} total={a.total} /> : <p className="cost-note">No replies yet</p>}
      {a.flat ? (
        <p className="cost-note">{FLAT_RATE_NOTE}</p>
      ) : a.kind === "signin" ? (
        <p className="cost-note">A plan sign-in isn't billed per reply, so it has no limit. The figures are what the use would cost at API prices.</p>
      ) : (
        <div className="cost-limit">
          <div className="cost-limit-title">
            Limit <HelpTip label="What's a limit?">{LIMIT_HELP}</HelpTip>
          </div>
          {b && meter ? (
            <>
              <div className={`meter cost-${meter.state}`} role="meter" aria-label={`${name} limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.width} aria-valuetext={`${usedOfLimit(b, limitApproximate(a))} ${periodWords(b)}`}>
                <i style={{ ["--fill" as string]: meter.width / 100 }} />
              </div>
              <p className="small cost-used">
                {usedOfLimit(b, limitApproximate(a))} {periodWords(b)} · {meter.percent}%
              </p>
              {sharedLimitNote(b) && <p className="cost-note">{sharedLimitNote(b)}</p>}
              {meter.state !== "ok" && (
                <p className={`small cost-state ${meter.state}`} role="status">
                  {meter.state === "warn" ? warnText(a, b) : stoppedText(a, b)}
                </p>
              )}
              <div className="row wrap" style={{ gap: 8 }}>
                <button className={`btn small ${meter.state === "stopped" ? "primary" : ""}`} onClick={() => onLimit(change)}>
                  {change}
                </button>
                <ConfirmButton label="Remove limit" question="Remove this limit?" confirmLabel="Yes, remove" onConfirm={remove} />
              </div>
            </>
          ) : (
            <>
              <p className="cost-note">No limit. Replies keep starting however much this account has spent.</p>
              <div>
                <button className="btn small" onClick={() => onLimit("Set a limit")}>
                  Set a limit
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** The switch for looking up prices online: a setting of the hub, loaded and saved here (like Usage's pause switch). */
function PriceLookup() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; retry: () => void } | null>(null);
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    setProblem(null);
    api<HubSettings>("GET", "/api/settings/hub")
      .then((s) => id === request.current && setOn(s.priceLookup !== false))
      .catch((e) => id === request.current && setProblem({ text: `Couldn't load this setting: ${message(e)}`, retry: load }));
  };
  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, []);
  const save = async (next: boolean) => {
    const id = ++request.current;
    const before = on;
    setOn(next);
    setBusy(true);
    setProblem(null);
    try {
      const s = await api<HubSettings>("PUT", "/api/settings/hub", { priceLookup: next });
      if (id === request.current) setOn(s.priceLookup !== false);
    } catch (e) {
      if (id === request.current) {
        setOn(before);
        setProblem({ text: `Couldn't save: ${message(e)}`, retry: () => void save(next) });
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  };
  return (
    <section className="card cost-prices" aria-label="Price lookup">
      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cost-limit-title">
            Look up prices online <HelpTip label="What's price lookup?">{PRICE_HELP}</HelpTip>
          </div>
          <p className="help" style={{ margin: "2px 0 0" }}>
            Works out the cost of replies the agent doesn't price itself.
          </p>
        </div>
        {on !== null && <Switch checked={on} onChange={(v) => void save(v)} label="Look up prices online" disabled={busy} />}
      </div>
      {on === null && !problem && (
        <p className="muted small" role="status" style={{ marginBottom: 0 }}>
          Loading…
        </p>
      )}
      {problem && (
        <div role="alert" style={{ marginTop: 8 }}>
          <p className="small cost-error" style={{ marginTop: 0 }}>
            {problem.text}
          </p>
          <button className="btn small" onClick={problem.retry}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
