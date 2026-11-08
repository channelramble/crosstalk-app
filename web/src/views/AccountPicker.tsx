import { useEffect, useState } from "react";
import { MULTI_ACCOUNT_PROVIDERS, type Provider } from "@crosstalk/shared";
import { accountDescription } from "../accounts";
import { useStore } from "../store";

export function AccountPicker({ provider, value, onChange, label = "Account" }: { provider: Provider; value: string; onChange: (id: string) => void; label?: string }) {
  const accounts = useStore((s) => s.accounts);
  const refresh = useStore((s) => s.refreshAccounts);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError("");
    try { await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!MULTI_ACCOUNT_PROVIDERS.includes(provider)) return null;
  const list = Object.values(accounts).filter((a) => a.provider === provider);
  return <div className="field">
    <label>
      <span style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>{label}</span>
      <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {!list.some((a) => a.id === "default") && <option value="default">Default account</option>}
        {list.map((a) => <option key={a.id} value={a.id}>{accountDescription(a.label, a.account)}{a.signedIn === false ? " · Not signed in" : ""}</option>)}
        {value !== "default" && !list.some((a) => a.id === value) && <option value={value}>{loading ? "Loading selected account…" : "Selected account unavailable"}</option>}
      </select>
    </label>
    <span className="help">Manage sign-ins under Settings → AI services. Accounts keep separate credentials and usage.</span>
    {error && <div role="alert"><span className="help" style={{ color: "var(--red)" }}>{error}</span><button type="button" className="btn small" onClick={load}>Retry accounts</button></div>}
  </div>;
}
