// Settings → Accounts: every account once, in one list, grouped under plain headings (Claude Code, Codex, Other
// services, Your own models), each row with its state in words and its own actions, and one "Add an account" button.
// Before this an account showed twice (a row under "AI services" saying "Press Sign in under Claude Code below", and
// the agent card's own Accounts row a long scroll lower), with four different add buttons. What the rows say is
// accountsList.ts; the dialogs and the hub calls behind every action are the ones Settings always had.
import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight, Cpu, Download, KeyRound, Loader2, LogIn, Plus, RefreshCw } from "lucide-react";
import { CHAT_PROVIDERS, MULTI_ACCOUNT_PROVIDERS, PROVIDER_INFO, memberAccount, type AccountSpend, type AgentAccount, type ChatProvider, type LoginFlow, type Provider, type ProviderStatus, type ServicePlan, type ServiceTestResult } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { accountDescription, accountKey } from "../accounts";
import { accountAbout, accountGroups, accountState, agentLine, canLimit, limitButton, type AccountGroup } from "../accountsList";
import { loadCatalog } from "../catalogs";
import { isFeatherless } from "../featherless";
import { toolCostLine } from "../models";
import { agentCanRun, errorMessage, modelNames, modelsLine, noDot, openCodeUnusable, serviceOutcome, showsFunds, spendChip, staleLine, switchAgent, switchedWords, switchFailure, testBody, testFailure, type Outcome } from "../services";
import { PHONE_SIGN_IN, agentNeeds, settingsPromptLine } from "../signIn";
import { openSignIn } from "../signInSheet";
import { useStore } from "../store";
import { Dialog, ProviderAvatar } from "../ui";
import { useCatalog } from "../useCatalog";
import { loadSpend } from "../useSpend";
import { AddServiceSheet, type SheetStart } from "./AddServiceSheet";
import { InstallBox, noteStatus, useAgentInstall } from "./AgentInstall";
import { FeatherlessPlanLine, FoundOnThisMachine, FundsLine } from "./AiServices";
import { LimitDialog } from "./LimitDialog";
import { useMachineName } from "./MachinePicker";
import { ServiceLines } from "./ServiceLines";
import { ApiKeyAccountDialog, EndpointDialog, LoginDialog, startLogin } from "./SetupPage";
import { ConfirmDialog, NameDialog } from "./SmallDialogs";

/** What "Add an account" can add; each opens the dialog Settings always had for it. */
type Adding = { kind: "signin"; provider: ChatProvider } | { kind: "apikey"; provider: ChatProvider } | { kind: "service"; start: SheetStart };

export function AccountsList() {
  const accounts = useStore((s) => s.accounts);
  const providers = useStore((s) => s.providers);
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const [choosing, setChoosing] = useState(false);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      await refreshAccounts();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = accountGroups(accounts);
  const none = groups.every((g) => !g.accounts.length);
  return (
    <>
      <button className="btn primary block acct-add" onClick={() => setChoosing(true)}>
        <Plus size={16} aria-hidden /> Add an account
      </button>
      <p className="help acct-intro">An account is who answers a chat: your Claude or ChatGPT plan, an API key, another service, or a model of your own.</p>
      {error && (
        <div role="alert" className="small acct-error">
          <p>Couldn't read the accounts: {noDot(error)}.</p>
          <button className="btn small" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {loading && none && !error && <p className="help">Loading accounts…</p>}
      {groups.map((g) => (
        <Group key={g.id} group={g} status={g.agent ? providers[g.agent] : undefined} onUse={(start) => setAdding({ kind: "service", start })} />
      ))}
      {choosing && (
        <AddAccountSheet
          onClose={() => setChoosing(false)}
          onPick={(what) => {
            setChoosing(false);
            setAdding(what);
          }}
        />
      )}
      {adding?.kind === "signin" && <AddSignIn provider={adding.provider} onClose={() => setAdding(null)} />}
      {adding?.kind === "apikey" && <ApiKeyAccountDialog provider={adding.provider} account={null} onClose={() => (setAdding(null), void load())} />}
      {adding?.kind === "service" && <AddServiceSheet start={adding.start} onClose={() => setAdding(null)} />}
    </>
  );
}

/** A heading, the agent's own line under it (installed, version, Install or Update), then its accounts. */
function Group({ group: g, status, onUse }: { group: AccountGroup; status: ProviderStatus | undefined; onUse: (start: SheetStart) => void }) {
  // Section ids other screens land on: each agent's, and what's found on this machine.
  const id = g.id === "services" ? "agent-opencode" : g.id === "own" ? "own-models" : `agent-${g.id}`;
  const installed = g.agent ? !!status?.installed : true;
  // A hub older than OpenCode doesn't list it: Other services has no agent line then.
  const agent = g.agent && (g.agent !== "opencode" || status) ? g.agent : null;
  return (
    <section className="acct-group settings-target" id={id} aria-label={g.agent && g.id !== "services" ? `${g.title} accounts` : g.title}>
      <h2 className="settings-heading">{g.title}</h2>
      {agent && <AgentLineRow provider={agent} status={status} />}
      {g.accounts.length > 0 ? (
        <div className="card acct-card">
          {g.accounts.map((a) => (
            <AccountRow key={accountKey(a.provider, a.id)} account={a} agentInstalled={a.provider === g.agent ? installed : true} />
          ))}
        </div>
      ) : (
        <p className="help acct-empty">{EMPTY[g.id === "services" || g.id === "own" ? g.id : "agent"](g.title)}</p>
      )}
      {g.id === "own" && <FoundOnThisMachine onUse={(s) => onUse({ preset: "local", baseUrl: s.baseUrl, label: s.label, test: true })} />}
      {g.id === "own" && <ByAddress />}
    </section>
  );
}

/**
 * One that isn't running right now, or runs on another computer of yours: added by its address, for the agent that
 * will run it, without being checked first (the form Settings always had for it).
 */
function ByAddress() {
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const [provider, setProvider] = useState<ChatProvider | null>(null);
  return (
    <div className="acct-by-address">
      <p className="help">Not running right now, or on another computer of yours? Add it by its address:</p>
      <div className="row wrap acct-actions">
        {CHAT_PROVIDERS.map((p) => (
          <button key={p} className="btn small" onClick={() => setProvider(p)}>
            <Cpu size={13} aria-hidden /> For {PROVIDER_INFO[p].name}
          </button>
        ))}
      </div>
      {provider && <EndpointDialog provider={provider} account={null} onClose={() => (setProvider(null), void refreshAccounts())} />}
    </div>
  );
}

const EMPTY = {
  agent: (name: string) => `No ${name} account yet. Tap Add an account to sign in with your plan or add an API key.`,
  services: () => "None yet. Kimi, DeepSeek, OpenRouter, NanoGPT and others are added with their key: tap Add an account.",
  own: () => "None added yet.",
};

/**
 * The agent itself, in one line: "Claude Code 2.1.330 · installed", with Install when it's missing and Update to run
 * its official installer again. The install is followed right here (InstallBox).
 */
function AgentLineRow({ provider, status }: { provider: Provider; status: ProviderStatus | undefined }) {
  const install = useAgentInstall(provider);
  const toast = useStore((s) => s.toast);
  const [checking, setChecking] = useState(false);
  const name = PROVIDER_INFO[provider].name;
  const line = agentLine(provider, status);
  const busy = install.phase !== "idle" && install.phase !== "done";
  // Install when it's missing or can't be used; Update when there's a reason to (OpenCode on another version), and
  // always there for Claude Code and Codex, whose newest version Crosstalk doesn't know.
  const action = line.action ?? (provider !== "opencode" && status?.installed ? "Update" : null);
  /** Asks the machine about the agent again: installed by hand in a terminal, say. */
  const check = async () => {
    setChecking(true);
    try {
      noteStatus(await api<ProviderStatus>("POST", `/api/providers/${provider}/refresh`));
      install.forget();
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="acct-agent" aria-label={name}>
      <div className="acct-agent-line">
        <ProviderAvatar provider={provider} size="sm" />
        <span className={`acct-agent-text ${line.tone}`}>{line.text}</span>
        {!busy && install.phase !== "failed" && action && (
          <button className={`btn small ${action === "Install" ? "primary" : "ghost"}`} onClick={() => void install.start()} title={action === "Install" ? undefined : "Run the official installer again to update"}>
            <Download size={13} aria-hidden /> {action}
          </button>
        )}
        <button className="icon-btn acct-agent-check" aria-label="Check" title={`Check ${name} again`} onClick={() => void check()} disabled={checking || busy}>
          <RefreshCw size={15} aria-hidden className={checking ? "spin" : ""} />
        </button>
      </div>
      {line.note && <p className="help">{line.note}</p>}
      {status?.error && !line.note && <p className="small acct-agent-error">{status.error}</p>}
      {(install.phase !== "idle" || install.problem) && <InstallBox install={install} />}
    </section>
  );
}

/**
 * One account: its name, what it is, its state in words, and its own actions. Sign in opens the sign-in sheet; Test
 * asks the agent (or the service) again; the rest is Rename, the spending limit, Remove, and under More whatever else
 * that kind of account has (Sign out, its key, its address and models, Refresh models, moving it to another agent).
 */
export function AccountRow({ account: a, agentInstalled = true }: { account: AgentAccount; agentInstalled?: boolean }) {
  const key = accountKey(a.provider, a.id);
  const spend = useStore((s) => s.spend?.find((x) => x.provider === a.provider && x.account === a.id));
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const toast = useStore((s) => s.toast);
  const accounts = useStore((s) => s.accounts);
  const members = useStore((s) => s.members);
  const openCode = useStore((s) => s.providers.opencode);
  const signIns = useStore((s) => s.signIns);
  const machine = useMachineName();
  // An agent that isn't signed in can only suggest models: they aren't asked for.
  const { catalog } = useCatalog(a.signedIn === false ? null : a.provider, a.id);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<"test" | "models" | "switch" | "signin" | null>(null);
  const [problem, setProblem] = useState("");
  /** Bumped by Test, so a NanoGPT account's balance (or a Featherless key's plan) is read again with it. */
  const [tested, setTested] = useState(0);
  const [dialog, setDialog] = useState<"rename" | "remove" | "signout" | "change" | "key" | "limit" | null>(null);
  const [login, setLogin] = useState<LoginFlow | null>(null);
  const [more, setMore] = useState(false);
  // A Featherless key's plan, once its line has read it: its Chat plan is one flat fee, with nothing for a limit to count.
  const [featherPlan, setFeatherPlan] = useState<ServicePlan | null>(null);
  const flatFee = !!featherPlan && featherPlan.kind !== "credits";
  const moreId = useId();
  const agent = PROVIDER_INFO[a.provider].name;
  const endpoint = a.kind === "endpoint";
  const apikey = a.kind === "apikey";
  const plan = !endpoint && !apikey;
  // What a check found is about the address and key it used: changing them takes it away.
  const about = `${a.endpoint?.baseUrl}|${a.endpoint?.hasKey}|${a.endpoint?.protocol}`;
  useEffect(() => setOutcome(null), [about]);
  // A chat's reply stopped on this account: said on its row, with what's waiting on it.
  const need = agentNeeds(signIns, a.provider).find((n) => n.account === a.id) ?? null;
  // A hub that signs agents in from the phone does it in the sign-in sheet (views/SignIn.tsx): no terminal on any
  // device. Antigravity CLI, and older hubs, keep their terminal sign-in (LoginDialog).
  const sheet = signIns !== null && PHONE_SIGN_IN.includes(a.provider);
  const signIn = async (opener: HTMLElement | null) => {
    setProblem("");
    if (sheet) {
      // Once it's signed in its Sign in goes: the keyboard lands on the account's next button.
      const focusAfter = () => document.querySelector<HTMLElement>(`[data-account="${key}"] button`);
      return openSignIn({ provider: a.provider, account: a.id, accountLabel: a.label, machineKey: useStore.getState().active, machine, opener, focusAfter });
    }
    setBusy("signin");
    try {
      setLogin(await startLogin(a.provider, a.id));
    } catch (e) {
      setProblem(`The sign-in didn't start: ${noDot(errorMessage(e))}. Tap Sign in to try again.`);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    const body = testBody(a);
    setBusy("test");
    setProblem("");
    try {
      if (body) {
        // What it has to spend isn't said twice: the row's own line, read again now, says that.
        setOutcome(serviceOutcome({ ...(await api<ServiceTestResult>("POST", "/api/services/test", body)), funds: undefined }));
        setTested((n) => n + 1);
      } else {
        // A plan sign-in or an API key: the agent is asked about the account again, and the row shows what it said.
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
      // Whatever the machine says now (a fresh list, or the saved one with why) is what the row shows.
      const conn = useStore.getState().conn;
      if (conn) await loadCatalog(conn, a.provider, a.id, true);
      setBusy(null);
    }
  };
  // A Refuseless or NanoGPT account saved under one of the two agents that run only on services can move to the other
  // without its key being typed again. OpenCode has to be there first; a machine older than OpenCode doesn't list it.
  const offered = switchAgent(a, Object.values(accounts));
  const moveTo = offered === "opencode" && !openCode ? null : offered;
  const moveLabel = moveTo ? `Run it with ${PROVIDER_INFO[moveTo].name}` : "";
  const moveBlocked = moveTo === "opencode" && !agentCanRun(moveTo, openCode);
  const moveUnusable = moveTo ? openCodeUnusable(moveTo, openCode) : null;
  const moveWhy = useId();
  const move = async () => {
    if (!moveTo) return;
    setBusy("switch");
    setProblem("");
    try {
      const now = await api<AgentAccount>("POST", `/api/accounts/${a.provider}/${a.id}/agent`, { to: moveTo });
      await refreshAccounts().catch(() => {});
      toast("info", switchedWords(now.label, a.provider, now.provider, !!useStore.getState().accounts[key]));
    } catch (e) {
      setProblem(switchFailure(moveLabel, errorMessage(e), e instanceof ApiError ? e.status : undefined));
    } finally {
      setBusy(null);
    }
  };
  /** The chats whose agent runs on this account. */
  const chats = new Set(Object.values(members).filter((m) => m.provider === a.provider && memberAccount(m) === a.id).map((m) => m.roomId)).size;
  const chatsUsing = chats === 0 ? "No chats use this account" : chats === 1 ? "1 chat uses this account" : `${chats} chats use this account`;
  const limit = async () => {
    setProblem("");
    // What it has spent and its limit so far: read first when this page hasn't got it yet.
    if (!useStore.getState().spend?.some((x) => x.provider === a.provider && x.account === a.id)) await loadSpend().catch(() => {});
    setDialog("limit");
  };

  const state = accountState(a, outcome, catalog);
  // The state above already says one line of a check ("Key works", "Can't reach it"): the lines under it leave that one out.
  const found = outcome ? { ...outcome, lines: outcome.lines.filter((l) => l.text !== state.text && !(state.text === "Key was refused" && l.text === "Key refused")) } : null;
  const chip = spendChip(spend);
  const names = modelNames(a, catalog);
  const stale = endpoint ? staleLine(catalog) : null;
  // What a request to this service was last measured to cost (hub/src/adapter/cost.ts): said with the model it was
  // measured on and when, so a model can be judged before a chat is started on it.
  const toolCost = toolCostLine(a.endpoint?.toolCost, { name: a.endpoint?.toolCost?.model, always: true });
  const off = busy !== null;
  const signedOut = plan && !(a.signedIn && a.provider !== "antigravity");
  const canSignOut = plan && !!a.signedIn && a.provider !== "antigravity";
  const removable = a.id !== "default";
  // What's wrong is fixed where it's said: a refused key gets its key button on the row itself, not under More.
  const fixKey = (apikey && a.signedIn === false) || (endpoint && state.tone === "bad");
  const keyLabel = apikey ? (a.provider === "claude" ? "Key & workspace" : "Replace key") : "Change";
  const hasMore = canSignOut || (!fixKey && (apikey || endpoint)) || endpoint || !!moveTo;
  const spendFor = useStore.getState().spend?.find((x) => x.provider === a.provider && x.account === a.id);
  const refreshButton = (
    <button className="btn small ghost" onClick={() => void refreshModels()} disabled={off}>
      <RefreshCw size={13} aria-hidden className={busy === "models" ? "spin" : ""} /> {busy === "models" ? "Refreshing…" : "Refresh models"}
    </button>
  );
  return (
    <div className="svc-row acct-row" role="group" aria-label={`${agent} · ${a.label}`} data-account={key}>
      <div className="svc-head">
        <div className="svc-name acct-name">{a.label}</div>
        {chip && <span className={`svc-chip ${chip.tone}`}>{chip.text}</span>}
      </div>
      <div className="help acct-about">{accountAbout(a)}</div>
      <div className="svc-status">
        <span className={`svc-dot ${state.tone}`} aria-hidden="true" />
        {state.text}
      </div>
      {need && <p className="help acct-need">{settingsPromptLine(need)}</p>}
      {a.error && <p className="svc-problem">{a.error}</p>}
      {names.length > 0 && <div className="help svc-names">{modelsLine(names)}</div>}
      {endpoint && showsFunds(a.endpoint?.baseUrl) && <FundsLine account={a} again={tested} />}
      {/* Which Featherless plan the key is on: its Chat plan's terms don't allow agents. */}
      {endpoint && isFeatherless(a.endpoint?.baseUrl) && <FeatherlessPlanLine account={a} again={tested} onPlan={setFeatherPlan} />}
      {stale && (
        <p className="help svc-stale" role="status">
          {stale}
        </p>
      )}
      {toolCost && <p className="help svc-tool-cost">{toolCost}</p>}
      {/* Always here, empty until a check comes back: a live region put on screen with its text isn't read out. */}
      <ServiceLines outcome={found} />
      {problem && (
        <p className="svc-problem" role="alert">
          {problem}
        </p>
      )}
      {a.provider === "antigravity" && a.signedIn && (
        <p className="help">
          To sign out, open the sign-in terminal and type <code>/logout</code>, then <code>/exit</code>.
        </p>
      )}
      <div className="row wrap acct-actions">
        {signedOut && (
          <button className={`btn small ${a.signedIn ? "" : "primary"}`} disabled={!agentInstalled || off} onClick={(e) => void signIn(e.currentTarget)}>
            <LogIn size={13} aria-hidden /> {a.signedIn ? "Open sign-in terminal" : busy === "signin" ? "Starting…" : "Sign in"}
          </button>
        )}
        {fixKey && (
          <button className="btn small primary" disabled={!agentInstalled || off} onClick={() => setDialog(apikey ? "key" : "change")}>
            {apikey ? <KeyRound size={13} aria-hidden /> : <Cpu size={13} aria-hidden />} {keyLabel}
          </button>
        )}
        <button className="btn small" onClick={() => void test()} disabled={!agentInstalled || off}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        <button className="btn small ghost" disabled={off} onClick={() => setDialog("rename")}>
          Rename
        </button>
        {canLimit(a, spend) && !flatFee && (
          <button className="btn small ghost" disabled={off} onClick={() => void limit()}>
            {limitButton(spend)}
          </button>
        )}
        {/* A list that couldn't be fetched: the way to fetch it again is right under the line that says so. */}
        {endpoint && stale && refreshButton}
        {removable && (
          <button className="btn small ghost danger" disabled={off} onClick={() => setDialog("remove")}>
            Remove
          </button>
        )}
        {hasMore && (
          <button className="btn small ghost acct-more-btn" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((m) => !m)}>
            More <ChevronRight size={13} aria-hidden className={more ? "acct-more-open" : ""} />
          </button>
        )}
      </div>
      {hasMore && (
        // Always drawn, shown when asked for: what's under More is still there for a reader to find.
        <div className="row wrap acct-actions acct-more" id={moreId} role="group" aria-label={`More for ${a.label}`} hidden={!more}>
          {!fixKey && (apikey || endpoint) && (
            <button className="btn small" disabled={!agentInstalled || off} onClick={() => setDialog(apikey ? "key" : "change")}>
              {apikey ? <KeyRound size={13} aria-hidden /> : <Cpu size={13} aria-hidden />} {keyLabel}
            </button>
          )}
          {endpoint && !stale && refreshButton}
          {moveTo && (
            <button className="btn small ghost" onClick={() => void move()} disabled={off || moveBlocked} aria-describedby={moveBlocked ? moveWhy : undefined}>
              {busy === "switch" && <Loader2 size={13} className="spin" aria-hidden />} {busy === "switch" ? "Moving…" : moveLabel}
            </button>
          )}
          {canSignOut && (
            <button className="btn small ghost danger" disabled={!agentInstalled || off} onClick={() => setDialog("signout")}>
              Sign out
            </button>
          )}
          {moveBlocked && (
            <p className="help" id={moveWhy}>
              {moveUnusable ?? "OpenCode isn't installed on this machine yet. Tap Install on OpenCode's line under Other services, then run it with OpenCode."}
            </p>
          )}
        </div>
      )}
      {dialog === "rename" && (
        <NameDialog
          title="Rename account"
          label="Account name"
          value={a.label}
          maxLength={40}
          placeholder="e.g. Personal or Work"
          help={plan ? "Choose a name you recognize. The signed-in email and plan appear separately." : "Choose a name you recognize."}
          onSave={async (label) => {
            await api("PATCH", `/api/accounts/${a.provider}/${a.id}`, { label });
            await refreshAccounts();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "remove" && (
        <ConfirmDialog
          title={`Remove ${accountDescription(a.label, a.account)}?`}
          confirmLabel="Remove"
          workingLabel="Removing…"
          onConfirm={async () => {
            await api("DELETE", `/api/accounts/${a.provider}/${a.id}`);
            await refreshAccounts();
          }}
          onClose={() => setDialog(null)}
        >
          {plan ? "Its saved sign-in is deleted from this machine." : "Its key is deleted from this machine."} {chatsUsing}; chats keep their messages.
        </ConfirmDialog>
      )}
      {dialog === "signout" && (
        <ConfirmDialog
          title={`Sign ${agent}${a.id === "default" ? "" : ` (${a.label})`} out on ${machine}?`}
          confirmLabel="Sign out"
          workingLabel="Signing out…"
          onConfirm={async () => {
            await api("POST", `/api/accounts/${a.provider}/${a.id}/logout`);
            await refreshAccounts();
          }}
          onClose={() => setDialog(null)}
        >
          {chatsUsing}
          {a.id === "default" ? `, and ${agent} in Terminal there is signed out too` : ""}.
        </ConfirmDialog>
      )}
      {dialog === "key" && <ApiKeyAccountDialog provider={a.provider} account={a} onClose={() => (setDialog(null), void refreshAccounts())} />}
      {/* The same dialog adding one of your own models opens, so there is one place that knows how to save one. */}
      {dialog === "change" && <EndpointDialog provider={a.provider} account={a} onClose={() => (setDialog(null), void refreshAccounts())} />}
      {dialog === "limit" &&
        (spendFor ? (
          <LimitDialog account={spendFor} title={limitButton(spendFor)} onClose={() => setDialog(null)} />
        ) : (
          <LimitDialog account={unspent(a)} title="Set a spending limit" onClose={() => setDialog(null)} />
        ))}
      {login && <LoginDialog provider={a.provider} accountId={a.id} label={a.label} flow={login} onClose={() => (setLogin(null), void refreshAccounts())} />}
    </div>
  );
}

/** An account that hasn't answered yet, as the limit sheet takes it: nothing spent, no limit. */
function unspent(a: AgentAccount): AccountSpend {
  const zero = { usd: 0, replies: 0, unpriced: 0, inputTokens: 0, outputTokens: 0 } as AccountSpend["total"];
  return { provider: a.provider, account: a.id, label: a.label, kind: a.kind === "apikey" ? "apikey" : "endpoint", today: zero, month: zero, total: zero, budget: null };
}

/**
 * "Add an account": one sheet asking what to add. Each choice opens the dialog Settings always had for it: the
 * sign-in sheet, the API key form, the list of services, or the check of a model running on this machine.
 */
function AddAccountSheet({ onPick, onClose }: { onPick: (what: Adding) => void; onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const choices: { title: string; help: string; what: Adding; off?: string }[] = [
    ...CHAT_PROVIDERS.map((p) => ({
      title: `Sign in to ${PROVIDER_INFO[p].name} with your plan`,
      help: p === "claude" ? "Your Claude Pro or Max plan. You sign in on Anthropic's own page." : "Your ChatGPT plan's Codex limits. You sign in on OpenAI's own page.",
      what: { kind: "signin", provider: p } as Adding,
      off: providers[p]?.installed === false ? `Install ${PROVIDER_INFO[p].name} first: its line under ${PROVIDER_INFO[p].name} has Install.` : undefined,
    })),
    ...CHAT_PROVIDERS.map((p) => ({
      title: `An API key for ${PROVIDER_INFO[p].name}`,
      help: `Billed per use by ${PROVIDER_INFO[p].vendor.split(" ·")[0]}, not from your plan.`,
      what: { kind: "apikey", provider: p } as Adding,
      off: providers[p]?.installed === false ? `Install ${PROVIDER_INFO[p].name} first: its line under ${PROVIDER_INFO[p].name} has Install.` : undefined,
    })),
    { title: "Another service", help: "Kimi, DeepSeek, OpenRouter, NanoGPT and others, with their key. Crosstalk checks it before you add it.", what: { kind: "service", start: {} } },
    { title: "A model running on this machine", help: "Ollama, LM Studio, llama.cpp or another one running here. Free; nothing leaves this machine.", what: { kind: "service", start: { preset: "local" } } },
  ];
  return (
    <Dialog title="Add an account" onClose={onClose} icon={<Plus size={20} />} footer={<button className="btn" onClick={onClose}>Cancel</button>}>
      <p className="help" style={{ marginTop: 0 }}>
        What do you want to add?
      </p>
      <div className="choice-cards acct-choices">
        {choices.map((c) => (
          <button key={c.title} type="button" className="choice-card" aria-disabled={!!c.off || undefined} onClick={() => !c.off && onPick(c.what)}>
            <span className="choice-card-title">{c.title}</span>
            <span className="choice-card-help">{c.off ?? c.help}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/**
 * "Sign in to Claude Code with your plan". The agent's main account not signed in yet: its sign-in starts at once.
 * Signed in already: this adds another account for that agent (a name first), then signs that one in.
 */
function AddSignIn({ provider, onClose }: { provider: ChatProvider; onClose: () => void }) {
  const main = useStore((s) => s.accounts[accountKey(provider, "default")]);
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const signIns = useStore((s) => s.signIns);
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  const name = PROVIDER_INFO[provider].name;
  const sheet = signIns !== null && PHONE_SIGN_IN.includes(provider);
  const [login, setLogin] = useState<{ account: AgentAccount; flow: LoginFlow } | null>(null);
  // Decided once, as it opens: the main account signing in mid-way mustn't turn this into "add another".
  const [another] = useState(() => !!main?.signedIn);
  // The sign-in's own dialog took over from the name sheet: closing that sheet mustn't close this.
  const handed = useRef(false);
  const start = async (a: AgentAccount) => {
    if (sheet) {
      openSignIn({ provider, account: a.id, accountLabel: a.label, machineKey: useStore.getState().active, machine, focusAfter: () => document.querySelector<HTMLElement>(`[data-account="${accountKey(provider, a.id)}"] button`) });
      onClose();
      return;
    }
    handed.current = true;
    try {
      setLogin({ account: a, flow: await startLogin(provider, a.id) });
    } catch (e) {
      handed.current = false;
      throw e;
    }
  };
  useEffect(() => {
    if (another) return;
    // The main account, as the machine knows it (or as it will once asked).
    start(main ?? ({ provider, id: "default", label: "Main" } as AgentAccount)).catch((e) => {
      toast("error", `The sign-in didn't start: ${noDot(errorMessage(e))}. Tap Sign in on ${name}'s account to try again.`);
      onClose();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (login) return <LoginDialog provider={provider} accountId={login.account.id} label={login.account.label} flow={login.flow} onClose={() => (void refreshAccounts(), onClose())} />;
  if (!another) return null;
  if (!MULTI_ACCOUNT_PROVIDERS.includes(provider)) {
    return (
      <Dialog title={`${name} is signed in`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p className="small" style={{ margin: 0 }}>{name} keeps one account on a machine. To use another, sign this one out first (More on its row).</p>
      </Dialog>
    );
  }
  return (
    <NameDialog
      title={`Add another ${name} account`}
      label="Account name"
      value=""
      maxLength={40}
      placeholder="e.g. Personal or Work"
      help={`${name} is signed in already as ${main?.label ?? "Main"}. This adds another account beside it: name it, then sign it in.`}
      saveLabel="Save and sign in"
      onSave={async (label) => {
        const added = await api<AgentAccount>("POST", "/api/accounts", { provider, label });
        await refreshAccounts();
        // Straight on to signing it in: an account without a sign-in can't do anything.
        try {
          await start(added);
        } catch (e) {
          toast("error", `${added.label} is added, but its sign-in couldn't start: ${errorMessage(e)} Tap Sign in on its row to try again.`);
        }
      }}
      onClose={() => {
        if (!handed.current) onClose();
      }}
    />
  );
}
