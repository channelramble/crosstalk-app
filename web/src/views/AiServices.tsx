// Parts of Settings → Accounts (views/AccountsList.tsx draws the list): what an account on a service has left to
// spend, which Featherless plan its key is on, and the models found running on this machine. docs/SPEC-0.4.md, track T7.
import { useEffect, useRef, useState } from "react";
import { type AgentAccount, type LocalServer, type ServiceFunds, type ServicePlan } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { FEATHERLESS_REMINDER } from "../featherless";
import { errorMessage, fundsEmpty, fundsSite, fundsWords, noDot, serverHost, serverInUse, serverLine } from "../services";
import { useStore } from "../store";
import { useReconnected } from "../useReconnected";
import { PlanNote, PricingLink } from "./FeatherlessPlan";
import { HelpTip } from "./HelpTip";


/**
 * What a NanoGPT or Refuseless account has to spend: its balance, how much of NanoGPT's subscription allowance is used,
 * what Refuseless holds for replies still running (GET /api/accounts/:p/:id/funds, free reads with its key that the hub
 * keeps for five minutes). Read when the row is shown; an older hub without the route shows nothing, and a read that
 * failed says why.
 */
export function FundsLine({ account: a, again }: { account: AgentAccount; again: number }) {
  const [funds, setFunds] = useState<ServiceFunds | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    let live = true;
    setFailed("");
    // After Test the hub has just read it again (the check reads the key's funds), so what it keeps is fresh.
    api<ServiceFunds>("GET", `/api/accounts/${a.provider}/${a.id}/funds`).then(
      (f) => live && setFunds(f),
      (e) => live && !(e instanceof ApiError && e.status === 404) && setFailed(`Couldn't read the balance: ${noDot(errorMessage(e))}.`),
    );
    return () => {
      live = false;
    };
  }, [a.provider, a.id, a.endpoint?.hasKey, again]);
  if (failed) return <p className="help svc-funds">{failed}</p>;
  if (!funds) return null;
  const words = fundsWords(funds);
  const site = fundsSite(a.endpoint?.baseUrl);
  return (
    <p className="help svc-funds" role="status">
      {words || `${site.name} didn't say what this account has left.`}
      {fundsEmpty(funds) && (
        <>
          {" "}
          <a href={site.url} target="_blank" rel="noreferrer noopener">
            Add money at {site.label}
          </a>
          .
        </>
      )}
    </p>
  );
}

/**
 * A Featherless account's row: which plan its key is on (GET /api/accounts/:p/:id/plan, one free read with its key that
 * the hub keeps ten minutes), read when the row is shown and again after Test. When the plan can't be told (an older
 * hub, or Featherless didn't say), what agents need. `onPlan`: the row hears which plan it is.
 */
export function FeatherlessPlanLine({ account: a, again, onPlan }: { account: AgentAccount; again: number; onPlan?: (plan: ServicePlan | null) => void }) {
  /** undefined: not read yet; null: not known. */
  const [plan, setPlan] = useState<ServicePlan | null | undefined>(undefined);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    let live = true;
    setFailed("");
    api<{ plan: ServicePlan | null }>("GET", `/api/accounts/${a.provider}/${a.id}/plan`).then(
      (r) => {
        if (!live) return;
        setPlan(r?.plan ?? null);
        // The row goes by it too: a plan of one flat fee has nothing a spending limit could count.
        onPlan?.(r?.plan ?? null);
      },
      (e) => {
        if (!live) return;
        // An older hub has no such read: what agents need is still worth saying.
        if (e instanceof ApiError && e.status === 404) setPlan(null);
        else setFailed(`Couldn't tell which plan this key is on: ${noDot(errorMessage(e))}.`);
      },
    );
    return () => {
      live = false;
    };
  }, [a.provider, a.id, a.endpoint?.hasKey, again]);
  if (plan) {
    // On its Developer plan the row's own "Set a spending limit" is right under this.
    return <PlanNote plan={plan} />;
  }
  if (plan === undefined && !failed) return null;
  return (
    <p className="help svc-plan-line">
      {failed && `${failed} `}
      {FEATHERLESS_REMINDER} See <PricingLink />.
    </p>
  );
}

/** Model servers answering on this machine (the hub looks at 127.0.0.1 only), each with Use it. */
export function FoundOnThisMachine({ onUse }: { onUse: (s: LocalServer) => void }) {
  // The accounts, not only the scan: one added here arrives at once, while the scan in hand was taken before it
  // existed and would go on offering "Use it" for the server it points at (services.ts serverInUse).
  const accounts = useStore((s) => s.accounts);
  const [found, setFound] = useState<{ servers: LocalServer[]; scannedAt: number } | null>(null);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState("");
  /** An older hub has no scan: nothing is shown. */
  const [missing, setMissing] = useState(false);
  const request = useRef(0);
  /** The hub keeps a scan for ten seconds: opening Settings takes it, Rescan (`fresh`) looks again whatever it kept. */
  const scan = async (fresh = false) => {
    const id = ++request.current;
    setScanning(true);
    setError("");
    try {
      const r = await api<{ servers: LocalServer[]; scannedAt: number }>("GET", `/api/local-servers${fresh ? "?fresh=1" : ""}`);
      if (id === request.current) setFound(r);
    } catch (e) {
      if (id !== request.current) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(errorMessage(e));
    } finally {
      if (id === request.current) setScanning(false);
    }
  };
  useEffect(() => {
    void scan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => {
    if (error) void scan();
  });
  if (missing) return null;
  return (
    <section className="svc-found settings-target" id="found-here" aria-label="Found on this machine">
      <div className="row">
        <h3 className="svc-sub">Found on this machine</h3>
        <HelpTip label="What does this list?">
          Models running on this machine right now, in Ollama, LM Studio or llama.cpp. Each machine lists its own.
        </HelpTip>
        <span className="spacer" />
        <button className="btn small" onClick={() => void scan(true)} disabled={scanning}>
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      {error && (
        <p className="svc-problem" role="alert">
          Couldn't look on this machine: {noDot(error)}. Press Rescan to try again.
        </p>
      )}
      {!found && scanning && <p className="help">Looking on this machine…</p>}
      {found && !found.servers.length && <p className="help">Nothing found running on this machine. Start Ollama, LM Studio or llama.cpp, then press Rescan.</p>}
      {found?.servers.map((s) => (
        <div key={s.id} className="svc-server" role="group" aria-label={`${s.label} on ${serverHost(s)}`}>
          <div className="svc-server-text">
            <div className="svc-name">{s.label}</div>
            <div className="help mono">{serverHost(s)}</div>
            <div className="help">{serverLine(s)}</div>
          </div>
          {serverInUse(s, Object.values(accounts)) ? (
            <span className="pill green">In use</span>
          ) : (
            <button className="btn small primary" onClick={() => onUse(s)}>
              Use it
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
