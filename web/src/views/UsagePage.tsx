import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { PROVIDER_INFO, type AgentAccount, type Provider, type ProviderStatus, type UsageSnapshot } from "@crosstalk/shared";
import { api } from "../api";
import { accountKey } from "../accounts";
import { useStore } from "../store";
import { ProviderAvatar, timeAgo, useInterval } from "../ui";
import { usageCards, usageResetLine, usageShareText } from "../usageWords";

/**
 * The plan meters, drawn right in Settings → Usage & costs (once a screen of its own behind a button): how much of
 * each plan's limits your agents have used, per account, with Refresh. `#/usage` lands on that page.
 */
export function UsageMeters() {
  const usage = useStore((s) => s.usage);
  const providers = useStore((s) => s.providers);
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  // The countdowns move on while the page is open, and a reset that goes by says so (the machine's next look is up to 15 minutes later).
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 30_000);
  const refresh = async () => {
    setBusy(true);
    try {
      const list = await api<UsageSnapshot[]>("POST", "/api/usage/refresh");
      useStore.setState((s) => ({ usage: { ...s.usage, ...Object.fromEntries(list.map((u) => [accountKey(u.provider, u.accountId), u])) } }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = usageCards(usage, accounts, providers);
  return (
    <section aria-label="Plan limits" className="usage-meters">
      {shown.length ? (
        <div className="grid-2">
          {shown.map(({ key, provider }) => (
            <UsageCard key={key} provider={provider} label={accounts[key]?.label ?? (key === provider ? "Main" : "Account")} service={accounts[key]?.kind === "endpoint"} u={usage[key]} now={now} />
          ))}
        </div>
      ) : (
        <div className="card usage-none">
          <div style={{ fontWeight: 600 }}>No usage yet</div>
          <p className="help" style={{ marginBottom: 0 }}>Plan limits show up once an agent is signed in. They update after each reply and every few minutes.</p>
        </div>
      )}
      <div className="row wrap usage-foot">
        <p className="help">Each account has its own limits. A chat uses the plan of the account picked for it.</p>
        <button className="btn small" onClick={refresh} disabled={busy}>
          <RefreshCw size={14} className={busy ? "spin" : ""} aria-hidden /> {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </section>
  );
}

export function UsageCard({ provider, label, service = false, u, now }: { provider: Provider; label: string; service?: boolean; u?: UsageSnapshot; now: number }) {
  const info = PROVIDER_INFO[provider];
  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <ProviderAvatar provider={provider} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{info.name} · {label}</h3>
          <div className="muted tiny">{[u?.plan, u?.account].filter(Boolean).join(" · ") || info.vendor}</div>
        </div>
        {info.usageUrl && (
          <a className="icon-btn" href={info.usageUrl} target="_blank" rel="noreferrer" title={`${info.vendor}'s usage page`} aria-label="Open usage page">
            <ExternalLink size={15} />
          </a>
        )}
      </div>
      {u?.windows.length ? (
        u.windows.map((w) => {
          const pct = w.usedPercent ?? 0;
          return (
            <div key={w.label} style={{ marginBottom: 12 }}>
              <div className="row small" style={{ marginBottom: 5 }}>
                <span style={{ fontWeight: 600 }}>{w.label}</span>
                <span className="spacer" />
                <span>{w.usedPercent === null ? "—" : `${Math.round(pct)}% used`}</span>
              </div>
              {/* A share nobody knows is "—" to the eye, and "Not known" to a screen reader: never "0 of 100". */}
              <div className={`meter ${pct >= 90 ? "full" : pct >= 70 ? "warn" : ""}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-valuetext={usageShareText(w.usedPercent)} aria-label={`${w.label} limit`}>
                <i style={{ ["--fill" as string]: Math.min(100, pct) / 100 }} />
              </div>
              {w.resetsAt && <div className="tiny muted" style={{ marginTop: 4 }}>{usageResetLine(w.resetsAt, now)}</div>}
            </div>
          );
        })
      ) : (
        <p className="muted small">{u?.note ?? (service ? "This account doesn't report limits to Crosstalk. What it costs is under Costs." : "Limits appear after the agent's first reply.")}</p>
      )}
      {u?.credits && <div className="small">Credits: {u.credits}</div>}
      {u?.note && u.windows.length > 0 && <div className="tiny muted" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{u.note}</div>}
      {u && <div className="tiny muted" style={{ marginTop: 8 }}>Updated {timeAgo(u.updatedAt)}</div>}
    </div>
  );
}
