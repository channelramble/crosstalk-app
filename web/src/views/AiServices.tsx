// Settings → AI services: every Claude Code and Codex account and every service Crosstalk's own agent or OpenCode runs, in
// one list (what it is, whether it works, its models, what it cost), Add an AI service, and the model servers found on this
// machine. The agents' own cards (install, sign in, accounts, defaults) follow it in AppSettings. docs/SPEC-0.4.md, track T7.
import { useEffect, useId, useRef, useState } from "react";
import { Cpu, Plus } from "lucide-react";
import { PROVIDER_INFO, isServiceOnlyAgent, type AgentAccount, type LocalServer, type ServiceFunds, type ServicePlan, type ServiceTestResult } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { accountKey } from "../accounts";
import { loadCatalog } from "../catalogs";
import { FEATHERLESS_REMINDER, isFeatherless } from "../featherless";
import { toolCostLine } from "../models";
import { agentCanRun, agentsLine, errorMessage, fundsEmpty, fundsSite, fundsWords, kindLine, modelNames, modelsLine, noDot, openCodeUnusable, serverHost, serverInUse, serverLine, serviceFixLine, serviceList, serviceOutcome, showsFunds, spendChip, staleLine, statusOf, switchAgent, switchedWords, switchFailure, testBody, testFailure, type Outcome } from "../services";
import { openCosts } from "../spendNotices";
import { useStore } from "../store";
import { useCatalog } from "../useCatalog";
import { useReconnected } from "../useReconnected";
import { AddServiceSheet, type SheetStart } from "./AddServiceSheet";
import { PlanNote, PricingLink } from "./FeatherlessPlan";
import { HelpTip } from "./HelpTip";
import { ServiceLines } from "./ServiceLines";
import { EndpointDialog } from "./SetupPage";


/**
 * What a NanoGPT or Refuseless account has to spend: its balance, how much of NanoGPT's subscription allowance is used,
 * what Refuseless holds for replies still running (GET /api/accounts/:p/:id/funds, free reads with its key that the hub
 * keeps for five minutes). Read when the row is shown; an older hub without the route shows nothing, and a read that
 * failed says why.
 */
function FundsLine({ account: a, again }: { account: AgentAccount; again: number }) {
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
 * the hub keeps ten minutes), read when the row is shown and again after Test. On the Developer plan, with no limit set
 * yet, the way to one; when the plan can't be told (an older hub, or Featherless didn't say), what agents need.
 */
function FeatherlessPlanLine({ account: a, again }: { account: AgentAccount; again: number }) {
  const limited = useStore((s) => !!s.spend?.find((x) => x.provider === a.provider && x.account === a.id)?.budget);
  /** undefined: not read yet; null: not known. */
  const [plan, setPlan] = useState<ServicePlan | null | undefined>(undefined);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    let live = true;
    setFailed("");
    api<{ plan: ServicePlan | null }>("GET", `/api/accounts/${a.provider}/${a.id}/plan`).then(
      (r) => live && setPlan(r?.plan ?? null),
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
    return (
      <PlanNote plan={plan}>
        {plan.kind === "credits" && !limited && (
          <button type="button" className="btn small" onClick={openCosts}>
            Set a spending limit
          </button>
        )}
      </PlanNote>
    );
  }
  if (plan === undefined && !failed) return null;
  return (
    <p className="help svc-plan-line">
      {failed && `${failed} `}
      {FEATHERLESS_REMINDER} See <PricingLink />.
    </p>
  );
}

/**
 * One account: its name, kind and status, models, what this month cost and what the agent's tools cost on it, with Test (and
 * Refresh models for a custom model).
 */
export function ServiceRow({ account: a }: { account: AgentAccount }) {
  const spend = useStore((s) => s.spend?.find((x) => x.provider === a.provider && x.account === a.id));
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const toast = useStore((s) => s.toast);
  const accounts = useStore((s) => s.accounts);
  const openCode = useStore((s) => s.providers.opencode);
  // An agent that isn't signed in can only suggest models: they aren't asked for.
  const { catalog } = useCatalog(a.signedIn === false ? null : a.provider, a.id);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<"test" | "models" | "switch" | null>(null);
  const [problem, setProblem] = useState("");
  /** Bumped by Test, so a NanoGPT account's balance (or a Featherless key's plan) is read again with it. */
  const [tested, setTested] = useState(0);
  /** Its address, key and models, in the same dialog the agent's Accounts card uses. */
  const [changing, setChanging] = useState(false);
  const agent = PROVIDER_INFO[a.provider].name;
  const endpoint = a.kind === "endpoint";
  // What a check found is about the address and key it used: changing them takes it away.
  const about = `${a.endpoint?.baseUrl}|${a.endpoint?.hasKey}|${a.endpoint?.protocol}`;
  useEffect(() => setOutcome(null), [about]);
  // A Refuseless or NanoGPT service saved under one of the two agents that run only on services can move to the other
  // without its key being typed again (the running 0.6.5 saved Refuseless under Crosstalk's agent). OpenCode has to be there first.
  // A hub older than OpenCode doesn't list it, and can't move a service there.
  const offered = switchAgent(a, Object.values(accounts));
  const moveTo = offered === "opencode" && !openCode ? null : offered;
  const moveLabel = moveTo ? `Run it with ${PROVIDER_INFO[moveTo].name}` : "";
  const moveBlocked = moveTo === "opencode" && !agentCanRun(moveTo, openCode);
  const moveUnusable = moveTo ? openCodeUnusable(moveTo, openCode) : null;
  const moveWhy = useId();

  const test = async () => {
    const body = testBody(a);
    setBusy("test");
    setProblem("");
    try {
      if (body) {
        // What it has to spend isn't said twice: the row's own line, read again now, says that.
        setOutcome(serviceOutcome({ ...(await api<ServiceTestResult>("POST", "/api/services/test", body)), funds: undefined }));
        setTested((n) => n + 1);
      }
      else {
        // A plan sign-in or an API key: the account's own check, the same as Check under Accounts. Its row then shows the answer.
        await api("POST", `/api/accounts/${a.provider}/${a.id}/refresh`);
        await refreshAccounts();
      }
    } catch (e) {
      setProblem(testFailure(errorMessage(e), e instanceof ApiError ? e.status : undefined));
    } finally {
      setBusy(null);
    }
  };
  const refreshModels = async () => {
    setBusy("models");
    setProblem("");
    try {
      await api("POST", `/api/accounts/${a.provider}/${a.id}/refresh-models`);
      await refreshAccounts();
      setOutcome({ lines: [{ ok: true, text: "Model list updated" }], problems: [], tone: "ok", text: "Reachable" });
    } catch (e) {
      setProblem(`Couldn't update the list: ${noDot(errorMessage(e))}. Press Refresh models to try again.`);
    } finally {
      // Whatever the hub says now (a fresh list, or the saved one with why) is what the row shows.
      const conn = useStore.getState().conn;
      if (conn) await loadCatalog(conn, a.provider, a.id, true);
      setBusy(null);
    }
  };

  const move = async () => {
    if (!moveTo) return;
    setBusy("switch");
    setProblem("");
    try {
      const now = await api<AgentAccount>("POST", `/api/accounts/${a.provider}/${a.id}/agent`, { to: moveTo });
      await refreshAccounts().catch(() => {});
      toast("info", switchedWords(now.label, a.provider, now.provider, !!useStore.getState().accounts[accountKey(a.provider, a.id)]));
    } catch (e) {
      setProblem(switchFailure(moveLabel, errorMessage(e), e instanceof ApiError ? e.status : undefined));
    } finally {
      setBusy(null);
    }
  };

  const status = statusOf(a, outcome, catalog);
  // Where this one is changed or removed: a service added here is changed on the row itself, so a refused key or a
  // server that moved port can be fixed where the check said so.
  const fix = serviceFixLine(a);
  // The status above already says it ("Reachable", "Can't reach it"): the lines start after it.
  const found = outcome && outcome.lines[0]?.text === status.text ? { ...outcome, lines: outcome.lines.slice(1) } : outcome;
  const chip = spendChip(spend);
  const names = modelNames(a, catalog);
  const stale = endpoint ? staleLine(catalog) : null;
  // What a request to this service was last measured to cost: Codex attaches every tool the person's own Codex and ChatGPT-app
  // setup offers to each one (361 of them and 134,000 tokens in one measurement), which is more than a small model can hold. Said here
  // with the model it was measured on and when, so a model can be judged before a chat is started on it. Nothing until a real
  // request has gone through (hub/src/adapter/cost.ts).
  const toolCost = toolCostLine(a.endpoint?.toolCost, { name: a.endpoint?.toolCost?.model, always: true });
  return (
    <div className="svc-row" role="group" aria-label={`${agent} · ${a.label}`}>
      <div className="svc-head">
        <div className="svc-name">{a.label}</div>
        {chip && <span className={`svc-chip ${chip.tone}`}>{chip.text}</span>}
      </div>
      <div className="help svc-kind">{kindLine(a)}</div>
      <div className="svc-status">
        <span className={`svc-dot ${status.tone}`} aria-hidden="true" />
        {status.text}
      </div>
      {fix && <p className="help">{fix}</p>}
      {names.length > 0 && <div className="help svc-names">{modelsLine(names)}</div>}
      {endpoint && showsFunds(a.endpoint?.baseUrl) && <FundsLine account={a} again={tested} />}
      {/* Which Featherless plan the key is on: its Chat plan's terms don't allow agents. */}
      {endpoint && isFeatherless(a.endpoint?.baseUrl) && <FeatherlessPlanLine account={a} again={tested} />}
      {stale && <p className="help svc-stale" role="status">{stale}</p>}
      {toolCost && <p className="help svc-tool-cost">{toolCost}</p>}
      {/* Always here, empty until a check comes back: a live region put on screen with its text isn't read out. */}
      <ServiceLines outcome={found} />
      {problem && <p className="svc-problem" role="alert">{problem}</p>}
      <div className="row wrap svc-actions">
        <button className="btn small" onClick={test} disabled={busy !== null}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        {endpoint && (
          <>
            <button className="btn small" onClick={() => setChanging(true)} disabled={busy !== null}>
              <Cpu size={13} aria-hidden /> Change
            </button>
            <button className="btn small ghost" onClick={refreshModels} disabled={busy !== null}>
              {busy === "models" ? "Refreshing…" : "Refresh models"}
            </button>
            {/* Crosstalk's own agent and OpenCode have no Accounts below, so their services are removed here. */}
            {isServiceOnlyAgent(a.provider) && (
              <button
                className="btn small ghost danger"
                disabled={busy !== null}
                onClick={async () => {
                  if (!confirm(`Remove ${a.label}? Its key is deleted from this machine. Chats on it keep their messages.`)) return;
                  setProblem("");
                  try {
                    await api("DELETE", `/api/accounts/${a.provider}/${a.id}`);
                    await refreshAccounts();
                  } catch (e) {
                    setProblem(`Couldn't remove it: ${noDot(errorMessage(e))}.`);
                  }
                }}
              >
                Remove
              </button>
            )}
            {moveTo && (
              <button className="btn small ghost" onClick={move} disabled={busy !== null || moveBlocked} aria-describedby={moveBlocked ? moveWhy : undefined}>
                {busy === "switch" ? "Moving…" : moveLabel}
              </button>
            )}
          </>
        )}
      </div>
      {moveBlocked && <p className="help" id={moveWhy}>{moveUnusable ?? "OpenCode isn't installed on this machine yet. Press Install under OpenCode below, then run it with OpenCode."}</p>}
      {/* The same dialog the agent's own Accounts card opens, so there is one place that knows how to save a service. */}
      {changing && <EndpointDialog provider={a.provider} account={a} onClose={() => { setChanging(false); void refreshAccounts(); }} />}
    </div>
  );
}

/** Model servers answering on this machine (the hub looks at 127.0.0.1 only), each with Use it. */
function FoundOnThisMachine({ onUse }: { onUse: (s: LocalServer) => void }) {
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
    <section className="svc-found" aria-label="Found on this machine">
      <div className="row">
        <h3 className="svc-sub">Found on this machine</h3>
        <HelpTip label="What does this list?">
          Model servers running on this machine right now, such as Ollama or LM Studio. Each machine lists its own: switch machines at the top of Settings to see another one's.
        </HelpTip>
        <span className="spacer" />
        <button className="btn small" onClick={() => void scan(true)} disabled={scanning}>
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      {error && (
        <p className="svc-problem" role="alert">
          Couldn't look for servers: {noDot(error)}. Press Rescan to try again.
        </p>
      )}
      {!found && scanning && <p className="help">Looking for model servers…</p>}
      {found && !found.servers.length && <p className="help">No model server found on this machine. Start Ollama, LM Studio or llama.cpp, then press Rescan.</p>}
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

/** The body of Settings → AI services, under its heading: the list, Add an AI service and what's found here. */
export function AiServicesExtras() {
  const accounts = useStore((s) => s.accounts);
  const [sheet, setSheet] = useState<SheetStart | null>(null);
  const list = serviceList(accounts);
  return (
    <>
      <p className="help svc-intro">Add any AI that works with Claude Code or Codex. Crosstalk checks it before you use it.</p>
      <div className="card svc-card">
        {list.length ? list.map((a) => <ServiceRow key={accountKey(a.provider, a.id)} account={a} />) : <p className="help">No AI services yet. Install Claude Code or Codex below, then sign in.</p>}
      </div>
      <button className="btn primary svc-add" onClick={() => setSheet({})}>
        <Plus size={16} aria-hidden /> Add an AI service
      </button>
      <FoundOnThisMachine onUse={(s) => setSheet({ preset: "local", baseUrl: s.baseUrl, label: s.label, test: true })} />
      <h3 className="svc-sub svc-agents">Agents</h3>
      {/* The services Crosstalk's own agent and OpenCode run need neither Claude Code nor Codex, nor a sign-in: they run on their keys. */}
      <p className="help svc-agents-line">{agentsLine(list)}</p>
      {sheet && <AddServiceSheet start={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}
