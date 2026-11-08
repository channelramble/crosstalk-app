import { useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { CheckCircle2, CircleAlert, CircleDashed, Copy, CornerDownLeft, Cpu, ExternalLink, KeyRound, LogIn, LogOut, RefreshCw, Download, MonitorSmartphone, SlidersHorizontal, SquareTerminal } from "lucide-react";
import { PROVIDER_INFO, MULTI_ACCOUNT_PROVIDERS, memberAccount, type AgentAccount, type EndpointProbe, type LoginFlow, type Provider, type ProviderStatus, type PtyInfo } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { accountDescription, accountKey } from "../accounts";
import { useStore } from "../store";
import { watchedLogins } from "../hubStore";
import { ChoiceCards, ConfirmButton, Dialog, ProviderAvatar, copyText, useIsMobile } from "../ui";
import { ENDPOINT_PRESETS, presetFields, type EndpointPreset } from "../presets";
import { useReconnected } from "../useReconnected";
import { useMachineName } from "./MachinePicker";
import { Terminal } from "./Terminal";
import { PHONE_SIGN_IN, agentNeeds, settingsPromptLine } from "../signIn";
import { openSignIn } from "../signInSheet";
import { SignInPrompt } from "./SignIn";

const AGENTS: Provider[] = ["claude", "codex", "muse", "antigravity", "gemini"];

const GUIDE: Record<string, { install: string; signIn: string[]; plan: string }> = {
  claude: {
    install: "Installs Claude Code with Anthropic's official installer.",
    signIn: [
      "Tap Sign in. A terminal opens on the hub running Anthropic's own sign-in (claude auth login).",
      "Open the link it shows and sign in with the Claude account that has your Pro or Max plan.",
      "Copy the code the page gives you, paste it in the field under the terminal, and tap Send.",
    ],
    plan: "Uses your Claude Pro or Max plan. Your password stays on Anthropic's site, and Crosstalk never reads or stores your Claude credentials.",
  },
  codex: {
    install: "Installs the Codex CLI from OpenAI's official npm package.",
    signIn: [
      "Tap Sign in to get a one-time code.",
      "Open the link on any device, sign in to ChatGPT, and enter the code.",
      "If ChatGPT says device codes are turned off, enable them in ChatGPT → Settings → Security, then try again.",
    ],
    plan: "Uses your ChatGPT plan's Codex limits.",
  },
  muse: {
    install: "Installs Muse Code with Meta's official installer.",
    signIn: [
      "Tap Sign in. A terminal opens on the hub running Muse Code's own sign-in (muse login).",
      "Open the link it shows on any device, sign in to your Meta account, and approve the code.",
      "Or paste an API key from dev.meta.ai instead (required for Meta Managed Accounts).",
    ],
    plan: "Uses your Muse Code plan or Meta API balance.",
  },
  antigravity: {
    install: "Installs Antigravity CLI with Google's official installer.",
    signIn: ["Tap Sign in. A terminal opens running agy on the hub.", "Open the Google sign-in link, then paste the code it gives you in the field under the terminal and tap Send.", "Once signed in, type /exit. Crosstalk checks the account again."],
    plan: "Uses your Google account's Antigravity access. This is the CLI for personal Google accounts, including Google One subscribers.",
  },
  gemini: {
    install: "Installs the Gemini CLI from Google's official npm package.",
    signIn: ["Tap Sign in. A terminal opens running gemini; choose Login with Google and follow the link.", "Or paste a Gemini API key instead."],
    plan: "For Gemini Code Assist enterprise access or paid Gemini API access. Personal Google and Google One accounts now use Antigravity CLI above.",
  },
};

export function SetupPage() {
  const toast = useStore((s) => s.toast);
  const mobile = useIsMobile();
  const providers = useStore((s) => s.providers);
  const accounts = useStore((s) => s.accounts);
  const hub = useStore((s) => s.hub);
  const setView = useStore((s) => s.setView);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await api("POST", "/api/providers/refresh");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    void refreshAll();
  }, []);
  const ready = AGENTS.filter((p) => providers[p]?.installed && (providers[p]?.signedIn || Object.values(accounts).some((a) => a.provider === p && a.signedIn))).length;
  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <div className="titles">
          <h1>Agents &amp; sign-ins</h1>
          <div className="sub">
            {ready} of {AGENTS.length} agents ready on {hub?.hostname ?? "the hub"}
          </div>
        </div>
        <button className="btn small" onClick={refreshAll} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? "spin" : ""} /> Check again
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          <p className="lede">
            Each agent runs on your hub and signs in with your own subscription, through the agent's official sign-in. Set up the ones you use; you can come back any time.
          </p>
          {AGENTS.map((p) => (
            <ProviderCard key={p} provider={p} status={providers[p]} />
          ))}
          <GitHubCard />
          <div className="card" style={{ marginTop: 12 }}>
            <h3>ChatGPT dots</h3>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Dots only run inside ChatGPT, Slack and Teams, and OpenAI hasn't released an API for them, so they can't join a room. In any room, Room settings → <b>Copy brief</b> makes a hand-off note you can paste to your dot.
            </p>
          </div>
          {mobile && (
            <div className="list-group" style={{ marginTop: 16 }}>
              <div className="list-row" onClick={() => setView("settings")}>
                <SlidersHorizontal size={20} />
                <div style={{ flex: 1 }}>
                  <div className="title">Preferences &amp; defaults</div>
                  <div className="subtitle">Usage limits and new room settings</div>
                </div>
              </div>
              <div className="list-row" onClick={() => setView("devices")}>
                <MonitorSmartphone size={20} />
                <div style={{ flex: 1 }}>
                  <div className="title">Devices</div>
                  <div className="subtitle">Pair a phone or computer, sign devices out</div>
                </div>
              </div>
              <div className="list-row" onClick={() => setView("terminal")}>
                <SquareTerminal size={20} />
                <div style={{ flex: 1 }}>
                  <div className="title">Terminal</div>
                  <div className="subtitle">A shell on the hub</div>
                </div>
              </div>
            </div>
          )}
          <p className="tiny muted" style={{ marginTop: 18 }}>
            Hub {hub?.version} · {hub?.hostname} · {hub?.platform} · workspaces in <span className="mono">{hub?.workspaceRoot}</span>
          </p>
        </div>
      </div>
    </>
  );
}

export function ProviderCard({ provider, status }: { provider: Provider; status?: ProviderStatus }) {
  const info = PROVIDER_INFO[provider];
  const guide = GUIDE[provider];
  const toast = useStore((s) => s.toast);
  const [installPty, setInstallPty] = useState<PtyInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Its accounts found signed out after a chat's reply failed on them (signIn.ts): each says so first, with Sign in.
  const needs = useStore(useShallow((s) => agentNeeds(s.signIns, provider)));

  const signedIn = useStore((s) => Object.values(s.accounts).some((a) => a.provider === provider && a.signedIn)) || !!status?.signedIn;
  const state = !status || !status.checkedAt ? "checking" : !status.installed ? "missing" : signedIn ? "ready" : status.signedIn === false ? "signedout" : "unknown";
  const pill = {
    checking: <span className="pill">Checking…</span>,
    missing: <span className="pill">Not installed</span>,
    signedout: <span className="pill orange">Not signed in</span>,
    unknown: <span className="pill orange">Sign-in unknown</span>,
    ready: <span className="pill green">Ready</span>,
  }[state];

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const install = () => act("install", async () => setInstallPty(await api<PtyInfo>("POST", `/api/providers/${provider}/install`)));
  const refresh = () => act("refresh", async () => void (await api("POST", `/api/providers/${provider}/refresh`)));

  const Step = ({ done, active, children }: { done: boolean; active: boolean; children: React.ReactNode }) => (
    <div className="row" style={{ alignItems: "flex-start", padding: "6px 0", opacity: done || active ? 1 : 0.55 }}>
      {done ? <CheckCircle2 size={18} className="check" /> : active ? <CircleAlert size={18} color="var(--orange)" /> : <CircleDashed size={18} color="var(--text-3)" />}
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );

  return (
    <div className="card tinted" style={{ ["--c" as string]: info.color }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <ProviderAvatar provider={provider} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{info.name}</h3>
          <div className="muted small">
            {info.vendor}
            {status?.version ? ` · v${status.version}` : ""}
          </div>
        </div>
        {pill}
      </div>

      {needs.map((n) => (
        // Once signed in this goes: the keyboard lands on the card's next button rather than the top of the page.
        <SignInPrompt key={n.account} variant="callout" who={n} machine={n.machine.name} line={settingsPromptLine(n)} focusAfter={() => document.getElementById(`agent-${provider}`)?.querySelector<HTMLElement>("button") ?? null} />
      ))}

      {provider === "gemini" && <p className="help" role="note">Using a personal Google account? Set up <b>Antigravity CLI</b> above. <a href="https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/" target="_blank" rel="noreferrer">Google's migration details</a></p>}
      {provider === "antigravity" && <p className="help">Antigravity receives room messages at the start of each turn. Reading and posting chat updates while it works is not supported yet.</p>}

      <Step done={!!status?.installed} active={state === "missing"}>
        <div style={{ fontWeight: 600 }}>Install on the hub</div>
        {status?.installed ? (
          <div className="help mono" style={{ wordBreak: "break-all" }}>
            {status.binPath}
          </div>
        ) : (
          <>
            <div className="help">{guide.install}</div>
            <button className="btn small primary" style={{ marginTop: 6 }} onClick={install} disabled={busy !== null}>
              <Download size={14} /> Install
            </button>
          </>
        )}
      </Step>

      <ProviderAccounts provider={provider} installed={!!status?.installed} />

      <Step done={!!status?.signedIn} active={false}>
        <div style={{ fontWeight: 600 }}>Plan &amp; usage</div>
        <div className="help">{guide.plan}</div>
      </Step>

      {status?.error && (
        <p className="small" style={{ color: "var(--red)", margin: "6px 0 0" }}>
          {status.error}
        </p>
      )}

      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        <button className="btn small ghost" onClick={refresh} disabled={busy !== null}>
          <RefreshCw size={13} className={busy === "refresh" ? "spin" : ""} /> Check
        </button>
        {status?.installed && (
          <button className="btn small ghost" onClick={install} disabled={busy !== null} title="Run the official installer again to update">
            <Download size={13} /> Update
          </button>
        )}
        <span className="spacer" />

      </div>

      {installPty && (
        <TerminalDialog
          title={`Installing ${info.name}`}
          pty={installPty}
          hint="The official installer is running on the hub. Answer any prompts here."
          onClose={() => {
            setInstallPty(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Starts an account's sign-in on the hub, and notes it as that account's sign-in now: news of an earlier attempt that
 * ended (its code expired, say) is never taken for this one (hubStore's LoginState).
 */
export async function startLogin(provider: Provider, accountId: string): Promise<LoginFlow> {
  const flow = await api<LoginFlow>("POST", `/api/accounts/${provider}/${accountId}/login`, {});
  useStore.setState((s) => ({ logins: { ...s.logins, [accountKey(provider, accountId)]: { flow } } }));
  return flow;
}

/** How many chats an account's agents run in, as a sentence starts: "12 chats use this account". */
function chatsUsing(count: number): string {
  return count === 0 ? "No chats use this account" : count === 1 ? "1 chat uses this account" : `${count} chats use this account`;
}

export function ProviderAccounts({ provider, installed }: { provider: Provider; installed: boolean }) {
  const accounts = useStore((s) => s.accounts);
  const members = useStore((s) => s.members);
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AgentAccount | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [login, setLogin] = useState<{ account: AgentAccount; flow: LoginFlow } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  // An account billed through an API key: "new" adds one, an account replaces its key.
  const [apiKeyFor, setApiKeyFor] = useState<AgentAccount | "new" | null>(null);
  // A custom model (a model server of your own): "new" adds one, an account changes it.
  const [endpointFor, setEndpointFor] = useState<AgentAccount | "new" | null>(null);
  const load = async () => {
    setLoading(true);
    setError("");
    try { await refreshAccounts(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = Object.values(accounts).filter((a) => a.provider === provider);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast("error", e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const edit = (a: AgentAccount | "new") => { setLabel(a === "new" ? "" : a.label); setEditing(a); };
  // A hub that signs agents in from the phone does it in the sign-in sheet (views/SignIn.tsx): no terminal on any
  // device, and one sign-in per account whichever button started it. Antigravity CLI, and older hubs, keep their
  // terminal sign-in (LoginDialog).
  const sheet = useStore((s) => s.signIns !== null) && PHONE_SIGN_IN.includes(provider);
  const signIn = async (a: AgentAccount, opener: HTMLElement | null = null) => {
    if (!sheet) return setLogin({ account: a, flow: await startLogin(provider, a.id) });
    // Once it's signed in its Sign in goes: the keyboard lands on the account's next button.
    const focusAfter = () => document.querySelector<HTMLElement>(`[data-account="${accountKey(provider, a.id)}"] button`);
    openSignIn({ provider, account: a.id, accountLabel: a.label, machineKey: useStore.getState().active, machine, opener, focusAfter });
  };
  const save = () => act(async () => {
    if (!editing || !label.trim()) return;
    if (editing === "new") {
      const added = await api<AgentAccount>("POST", "/api/accounts", { provider, label: label.trim() });
      await refreshAccounts();
      setEditing(null);
      // Straight on to signing it in: an account without a sign-in can't do anything.
      try {
        await signIn(added);
      } catch (e) {
        toast("error", `${added.label} is added, but its sign-in couldn't start: ${e instanceof Error ? e.message : String(e)} Tap Sign in under it to try again.`);
      }
      return;
    }
    await api("PATCH", `/api/accounts/${provider}/${editing.id}`, { label: label.trim() });
    await refreshAccounts();
    setEditing(null);
  });
  /** The chats (and older rooms) whose agent runs on this account. */
  const chatCount = (a: AgentAccount) => new Set(Object.values(members).filter((m) => m.provider === provider && memberAccount(m) === a.id).map((m) => m.roomId)).size;
  const signOut = (a: AgentAccount) => act(async () => {
    await api("POST", `/api/accounts/${provider}/${a.id}/logout`);
    await refreshAccounts();
  });
  return (
    <section aria-label={`${PROVIDER_INFO[provider].name} accounts`} style={{ marginTop: 12 }}>
      <h4 style={{ margin: "8px 0" }}>Accounts</h4>
      {error && <div role="alert"><p className="help" style={{ color: "var(--red)" }}>{error}</p><button className="btn small" onClick={load}>Retry accounts</button></div>}
      {loading && !list.length && <p className="help">Loading accounts…</p>}
      {list.map((a) => (
        <div key={a.id} data-account={accountKey(provider, a.id)} style={{ borderTop: "1px solid var(--sep)", padding: "10px 0" }}>
          <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{a.label}</div>
          <div className="help" style={{ overflowWrap: "anywhere" }}>{a.kind === "apikey" ? `API key · billed per use${a.signedIn === false ? " · not accepted" : ""}` : a.kind === "endpoint" && a.endpoint ? endpointDescription(a.endpoint) : [a.account, a.plan, a.signedIn ? "Signed in" : a.signedIn === false ? "Not signed in" : "Sign-in not confirmed"].filter(Boolean).join(" · ")}</div>
          {a.error && <p className="help" style={{ color: "var(--red)" }}>{a.error}</p>}
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            {a.kind === "endpoint" ? <button className="btn small" disabled={!installed || busy} onClick={() => setEndpointFor(a)}><Cpu size={13} />Change</button> : a.kind === "apikey" ? <button className="btn small" disabled={!installed || busy} onClick={() => setApiKeyFor(a)}><KeyRound size={13} />{provider === "claude" ? "Key & workspace" : "Replace key"}</button> : !(a.signedIn && provider !== "antigravity") && <button className="btn small" disabled={!installed || busy} onClick={(e) => { const opener = e.currentTarget; void act(() => signIn(a, opener)); }}><LogIn size={13} />{a.signedIn ? "Open sign-in terminal" : "Sign in"}</button>}
            <button className="btn small ghost" disabled={busy} onClick={() => edit(a)}>Rename</button>
            <button className="btn small ghost" disabled={!installed || busy} onClick={() => act(async () => { await api("POST", `/api/accounts/${provider}/${a.id}/refresh`); await refreshAccounts(); })}>Check</button>
            {a.kind !== "endpoint" && a.kind !== "apikey" && a.signedIn && provider !== "antigravity" && (
              // The main account is the agent's own sign-in on that machine, the one its Terminal uses too.
              <ConfirmButton
                label={<><LogOut size={13} />Sign out</>}
                ariaLabel={`Sign out ${PROVIDER_INFO[provider].name} · ${a.label}`}
                question={`Sign ${PROVIDER_INFO[provider].name}${a.id === "default" ? "" : ` (${a.label})`} out on ${machine}? ${chatsUsing(chatCount(a))}${a.id === "default" ? `, and ${PROVIDER_INFO[provider].name} in Terminal there is signed out too` : ""}.`}
                confirmLabel="Sign out"
                disabled={!installed || busy}
                onConfirm={() => void signOut(a)}
              />
            )}
            {a.id !== "default" && <button className="btn small ghost danger" disabled={busy} onClick={() => act(async () => {
              if (!confirm(`Remove ${accountDescription(a.label, a.account)}? Its saved sign-in will be deleted.`)) return;
              await api("DELETE", `/api/accounts/${provider}/${a.id}`);
              await refreshAccounts();
            })}>Remove</button>}
            {a.id === "default" && (provider === "gemini" || provider === "muse") && <button className="btn small" disabled={!installed || busy} onClick={() => setKeyOpen(true)}><KeyRound size={13} />Use an API key</button>}
          </div>
          {provider === "antigravity" && a.signedIn && <p className="help">To sign out, open the sign-in terminal and type <code>/logout</code>, then <code>/exit</code>.</p>}
        </div>
      ))}
      {MULTI_ACCOUNT_PROVIDERS.includes(provider)
        ? <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn small" disabled={!installed || busy || loading || !!error} onClick={() => edit("new")}>Add another sign-in</button>
            {(provider === "claude" || provider === "codex") && <button className="btn small" disabled={!installed || busy || loading || !!error} onClick={() => setApiKeyFor("new")}><KeyRound size={13} />Add an API key</button>}
            {(provider === "claude" || provider === "codex") && <button className="btn small" disabled={!installed || busy || loading || !!error} onClick={() => setEndpointFor("new")}><Cpu size={13} />Add a custom model</button>}
          </div>
        : <p className="help">{PROVIDER_INFO[provider].name} supports one sign-in here. Its CLI doesn't provide isolated account storage.</p>}
      {apiKeyFor && <ApiKeyAccountDialog provider={provider} account={apiKeyFor === "new" ? null : apiKeyFor} onClose={() => { setApiKeyFor(null); void load(); }} />}
      {endpointFor && <EndpointDialog provider={provider} account={endpointFor === "new" ? null : endpointFor} onClose={() => { setEndpointFor(null); void load(); }} />}
      {editing && <Dialog title={editing === "new" ? `Add ${PROVIDER_INFO[provider].name} account` : "Rename account"} dirty={label !== (editing === "new" ? "" : editing.label)} onClose={() => !busy && setEditing(null)} footer={(requestClose) => <><button className="btn" disabled={busy} onClick={() => requestClose()}>Cancel</button><button className="btn primary" disabled={busy || !label.trim()} onClick={save}>{busy ? "Saving…" : editing === "new" ? "Save and sign in" : "Save"}</button></>}>
        <label className="field"><span>Account name</span><input className="input" aria-label="Account name" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Personal or Work" disabled={busy} /><span className="help">{editing === "new" ? "Choose a name you recognize. Signing it in comes next; the signed-in email and plan appear separately." : "Choose a name you recognize. The signed-in email and plan appear separately."}</span></label>
      </Dialog>}
      {login && <LoginDialog provider={provider} accountId={login.account.id} label={login.account.label} flow={login.flow} onClose={() => { setLogin(null); void load(); }} />}
      {keyOpen && <ApiKeyDialog provider={provider} onClose={() => { setKeyOpen(false); void load(); }} />}
    </section>
  );
}

export function LoginDialog({ provider, accountId = "default", label = "Default account", flow, onClose }: { provider: Provider; accountId?: string; label?: string; flow: LoginFlow; onClose: () => void }) {
  const info = PROVIDER_INFO[provider];
  const key = accountKey(provider, accountId);
  const status = useStore((s) => s.accounts[key]);
  const live = useStore((s) => s.logins[key]);
  const toast = useStore((s) => s.toast);
  const [again, setAgain] = useState<"asking" | string | null>(null);
  const [, setTick] = useState(0);
  // This dialog says how the sign-in goes: no separate notice.
  useEffect(() => {
    watchedLogins.add(key);
    return () => void watchedLogins.delete(key);
  }, [key]);
  // Close automatically once the hub reports a successful sign-in.
  const [startedSignedIn] = useState(!!status?.signedIn);
  useEffect(() => {
    if (status?.signedIn && !startedSignedIn) {
      toast("info", `${info.name} · ${label} is signed in.`);
      onClose();
    }
  }, [status?.signedIn, startedSignedIn, info.name, onClose, toast]);
  const f = live ? live.flow : flow;
  const expiresAt = f?.kind === "device_code" ? f.expiresAt : null;
  // A code past its time is dead even if the hub's word of it was missed (the phone was asleep).
  useEffect(() => {
    if (!expiresAt || expiresAt <= Date.now()) return;
    const t = setTimeout(() => setTick((n) => n + 1), expiresAt - Date.now() + 500);
    return () => clearTimeout(t);
  }, [expiresAt]);
  // Ended without an error: signed in, and the hub is checking the account (this closes once it has).
  const succeeded = !!live?.ended && !live.error;
  const why = succeeded ? null : !f ? (live?.ended ? live.error ?? "This sign-in ended before you were signed in." : null) : expiresAt && expiresAt <= Date.now() ? "This code expired." : null;
  // The button below is the "try again".
  const ended = why === null ? null : why.replace(/\s*Try again\.?$/i, "").replace(/([^.!?])$/, "$1.");
  const newCode = async () => {
    setAgain("asking");
    try {
      await startLogin(provider, accountId);
      setAgain(null);
    } catch (e) {
      setAgain(`Couldn't get a new code: ${e instanceof Error ? e.message : String(e)} Try again.`);
    }
  };

  if (succeeded) {
    return (
      <Dialog title={`Sign in to ${info.name} · ${label}`} onClose={onClose} icon={<ProviderAvatar provider={provider} />} footer={<button className="btn" onClick={onClose}>Close</button>}>
        <p className="small" role="status" style={{ margin: 0 }}>
          You're signed in. Checking the account…
        </p>
      </Dialog>
    );
  }
  if (ended !== null || !f) {
    return (
      <Dialog
        title={`Sign in to ${info.name} · ${label}`}
        onClose={onClose}
        icon={<ProviderAvatar provider={provider} />}
        footer={
          <>
            <button className="btn" onClick={onClose}>
              Close
            </button>
            <button className="btn primary" onClick={newCode} disabled={again === "asking"}>
              {again === "asking" ? "Getting a code…" : "Get a new code"}
            </button>
          </>
        }
      >
        <p role="alert" className="small" style={{ marginTop: 0, fontWeight: 600 }}>
          {ended ?? "This sign-in ended before you were signed in."} You're not signed in yet.
        </p>
        {again && again !== "asking" && <p className="small" style={{ color: "var(--red)" }}>{again}</p>}
        {GUIDE[provider] && (
          <>
            <p className="help" style={{ marginBottom: 4 }}>How it works:</p>
            <ol className="steps small" style={{ marginTop: 0 }}>
              {/* This dialog's button is Get a new code, not Sign in. */}
              {GUIDE[provider].signIn.map((step, i) => (
                <li key={step}>{i === 0 ? step.replace(/^Tap Sign in( to get a one-time code)?/, "Tap Get a new code") : step}</li>
              ))}
            </ol>
          </>
        )}
      </Dialog>
    );
  }
  if (f.kind === "device_code") {
    return (
      <Dialog title={`Sign in to ${info.name} · ${label}`} onClose={onClose} icon={<ProviderAvatar provider={provider} />}>
        <ol className="steps">
          <li>
            Open{" "}
            <a href={f.url} target="_blank" rel="noreferrer">
              {f.url.replace(/^https?:\/\//, "")}
            </a>{" "}
            on this or any device.
          </li>
          <li>Sign in, then enter this code:</li>
        </ol>
        <div style={{ textAlign: "center", margin: "10px 0 16px" }}>
          <div className="code-big">{f.code}</div>
          <div className="row" style={{ justifyContent: "center", marginTop: 10, gap: 8 }}>
            <button className="btn small" onClick={() => copyText(f.code).then((ok) => ok && toast("info", "Code copied"))}>
              <Copy size={13} /> Copy code
            </button>
            <a className="btn small primary" href={f.url} target="_blank" rel="noreferrer">
              <ExternalLink size={13} /> Open sign-in page
            </a>
          </div>
        </div>
        <p className="help" style={{ textAlign: "center" }}>
          This closes by itself when the hub sees you're signed in{f.expiresAt ? ` (code expires ${new Date(f.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})` : ""}.
        </p>
      </Dialog>
    );
  }
  if (f.kind === "browser") {
    return (
      <Dialog title={`Sign in to ${info.name} · ${label}`} onClose={onClose}>
        <p>Open this link and finish signing in:</p>
        <a className="btn primary" href={f.url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Open sign-in page
        </a>
      </Dialog>
    );
  }
  return <TerminalDialog title={`Sign in to ${info.name} · ${label}`} pty={{ id: f.ptyId } as PtyInfo} hint={f.hint} onClose={onClose} showLinks />;
}

/**
 * A terminal on the hub in a dialog: an installer, or a sign-in. A sign-in's links show as buttons above it, a one-time
 * code it prints to type elsewhere (GitHub's) shows large with Copy and Press Enter, and a code to bring back goes in
 * the field under it: long-press paste into the terminal itself often fails on an iPhone. `notice` is what the caller
 * makes of the output itself (AgentSetupSection's AddResult: how an "Add for me" ended, and what to do next), shown
 * above the terminal so it's read before the raw output.
 */
export function TerminalDialog({ title, pty, hint, notice, onClose, showLinks, paste = !!showLinks }: { title: string; pty: PtyInfo; hint?: string; notice?: ReactNode; onClose: () => void; showLinks?: boolean; paste?: boolean }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const pasteBox = useRef<HTMLInputElement>(null);
  const info = useStore((s) => s.ptys[pty.id]);
  const toast = useStore((s) => s.toast);
  const sendPty = useStore((s) => s.sendPty);
  const running = !info || info.alive;
  // Closing a running terminal stops what's in it, so confirm first, and stay open if stopping fails.
  const close = async () => {
    if (running) {
      if (!confirm("Stop this and close? Whatever is running in the terminal will be cancelled.")) return;
      try {
        await api("DELETE", `/api/pty/${pty.id}`);
      } catch (e) {
        toast("error", `Couldn't stop it: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    onClose();
  };
  /** Types what was pasted into the terminal, then Enter. */
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    sendPty(pty.id, `${text}\r`);
    setTyped("");
  };
  return (
    <Dialog
      title={title}
      onClose={close}
      wide
      footer={
        running ? (
          <button className="btn danger" onClick={close}>
            Cancel
          </button>
        ) : (
          <button className="btn primary" onClick={close}>
            Done
          </button>
        )
      }
    >
      {hint && <p className="small muted" style={{ marginTop: 0 }}>{hint}</p>}
      {notice}
      {showLinks && code && (
        <div className="term-code" role="group" aria-label="One-time code">
          <div className="code-big">{code}</div>
          <div className="row wrap" style={{ justifyContent: "center", gap: 8 }}>
            <button className="btn small" onClick={() => copyText(code).then((ok) => toast(ok ? "info" : "error", ok ? "Code copied" : "Couldn't copy. Select the code and copy it instead."))}>
              <Copy size={13} /> Copy code
            </button>
            {running && (
              <button className="btn small" onClick={() => sendPty(pty.id, "\r")}>
                <CornerDownLeft size={13} /> Press Enter
              </button>
            )}
          </div>
        </div>
      )}
      {showLinks && urls.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
          {urls.slice(-2).map((u) => (
            <span key={u} className="row" style={{ gap: 6 }}>
              {/* Back from the sign-in page, the code goes straight into the field below. */}
              <a className="btn small primary" href={u} target="_blank" rel="noreferrer" onClick={() => setTimeout(() => pasteBox.current?.focus(), 0)}>
                <ExternalLink size={13} /> Open sign-in link
              </a>
              <button className="btn small" onClick={() => copyText(u).then((ok) => ok && toast("info", "Link copied"))}>
                <Copy size={13} /> Copy link
              </button>
            </span>
          ))}
        </div>
      )}
      <Terminal ptyId={pty.id} onUrl={showLinks ? setUrls : undefined} onCode={showLinks ? setCode : undefined} />
      {paste && running && (
        <form className="term-paste" onSubmit={send}>
          <label className="field">
            <span>Paste the code here</span>
            <input ref={pasteBox} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="send" />
          </label>
          <button className="btn primary" type="submit" disabled={!typed.trim()}>
            Send
          </button>
        </form>
      )}
      <p className="tiny muted" style={{ marginBottom: 0 }}>
        {paste && running ? "Send types it into the terminal and presses Enter. " : ""}
        {info && !info.alive ? `Finished${info.exitCode !== null ? ` (exit ${info.exitCode})` : ""}.` : "Running on the hub."}
      </p>
    </Dialog>
  );
}

export function GitHubCard() {
  const toast = useStore((s) => s.toast);
  const hub = useStore((s) => s.hub);
  const machine = useMachineName();
  const [st, setSt] = useState<{ installed: boolean; version: string | null; signedIn: boolean; account: string | null } | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [term, setTerm] = useState<{ ptyId: string; hint: string } | null>(null);
  const request = useRef(0);
  const load = async () => {
    const id = ++request.current;
    setError("");
    setChecking(true);
    try {
      const next = await api<NonNullable<typeof st>>("GET", "/api/tools/github");
      if (id === request.current) setSt(next);
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === request.current) setChecking(false);
    }
  };
  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => void load());
  const login = async () => {
    try {
      setTerm(await api<{ ptyId: string; hint: string }>("POST", "/api/tools/github/login"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  const signOut = async () => {
    setSigningOut(true);
    try {
      await api("POST", "/api/tools/github/logout");
      await load();
    } catch (e) {
      toast("error", `Couldn't sign GitHub out: ${e instanceof Error ? e.message : String(e)} Try again.`);
    } finally {
      setSigningOut(false);
    }
  };
  return (
    <section className="card" style={{ marginTop: 12 }} aria-label="GitHub">
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="avatar lg" style={{ ["--c" as string]: "#24292f" }}>GH</div>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0 }}>GitHub</h3>
          <div className="muted small">Optional · lets agents clone your private repos and push branches</div>
        </div>
        {!st ? error ? <span className="pill orange">Unknown</span> : <span className="pill">Checking…</span> : !st.installed ? <span className="pill">Not installed</span> : st.signedIn ? <span className="pill green">Connected</span> : <span className="pill orange">Not signed in</span>}
      </div>
      {error && (
        <div role="alert">
          <p className="small" style={{ margin: "4px 0" }}>Couldn't check GitHub on {machine}: {error}</p>
        </div>
      )}
      {st && !st.installed && (
        <p className="help">
          Install the GitHub CLI on the hub (for example <span className="kbd">{hub?.platform === "darwin" ? "brew install gh" : "sudo apt install gh"}</span> from the Terminal page), then check again.
        </p>
      )}
      {st?.installed && st.signedIn && <p className="help">Signed in{st.account ? ` as ${st.account}` : ""}. Git on the hub uses this sign-in.</p>}
      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
        {st?.installed && !st.signedIn && (
          <button className="btn small primary" onClick={login}>
            Sign in with GitHub
          </button>
        )}
        <button className="btn small ghost" onClick={() => void load()} disabled={checking}>
          <RefreshCw size={13} className={checking ? "spin" : ""} /> {error ? "Retry" : "Check"}
        </button>
        {st?.signedIn && (
          <ConfirmButton
            label={<><LogOut size={13} /> {signingOut ? "Signing out…" : "Sign out"}</>}
            ariaLabel="Sign GitHub out"
            question={`Sign GitHub out on ${machine}? Agents can't push, and gh in Terminal there is signed out too.`}
            confirmLabel="Sign out"
            disabled={signingOut}
            onConfirm={() => void signOut()}
          />
        )}
      </div>
      {term && <TerminalDialog title="Sign in to GitHub" pty={{ id: term.ptyId } as PtyInfo} hint={term.hint} showLinks paste={false} onClose={() => (setTerm(null), void load())} />}
    </section>
  );
}

/** Adds an account billed through an API key, or replaces an API-key account's key. */
function ApiKeyAccountDialog({ provider, account, onClose }: { provider: Provider; account: AgentAccount | null; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState(account?.label ?? "API key");
  const [workspace, setWorkspace] = useState(account?.workspaceId ?? "");
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const where = provider === "claude" ? "console.anthropic.com" : "platform.openai.com";
  const workspaceChanged = workspace.trim() !== (account?.workspaceId ?? "");
  const save = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/accounts/apikey", {
        provider,
        apiKey: key.trim(),
        ...(account ? { id: account.id } : { label: label.trim() }),
        ...(provider === "claude" ? { workspaceId: workspace.trim() || null } : {}),
      });
      toast("info", "API key saved on the hub.");
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={account ? `${account.label}: key and workspace` : `${PROVIDER_INFO[provider].name} API key`}
      onClose={onClose}
      dirty={!!key || workspaceChanged}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (account ? !key.trim() && !workspaceChanged : !key.trim() || !label.trim())} onClick={save}>{busy ? "Saving…" : "Save"}</button></>}
    >
      {!account && (
        <label className="field">
          <span>Name</span>
          <input className="input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
          <span className="help">Chats pick it like an account: your plan sign-in, or this key.</span>
        </label>
      )}
      <label className="field">
        <span>API key</span>
        <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder={account ? "Leave empty to keep the current key" : `From ${where}`} autoFocus={!account} />
        <span className="help">Stored only on the hub, in a file only your user can read. Billed per use by {PROVIDER_INFO[provider].vendor}, not from your plan.</span>
      </label>
      {provider === "claude" && (
        <label className="field">
          <span>Workspace ID (if asked for)</span>
          <input className="input mono" value={workspace} onChange={(e) => setWorkspace(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="wrkspc_…" />
          <span className="help">Only needed for a key that covers your whole organization. Find it in the Claude Console → Settings → Workspaces.</span>
        </label>
      )}
    </Dialog>
  );
}

function endpointDescription(ep: NonNullable<AgentAccount["endpoint"]>): string {
  let host = ep.baseUrl;
  try {
    host = new URL(ep.baseUrl).host;
  } catch {
    /* as entered */
  }
  return ["Custom model", ep.models[0], host, ep.contextWindow ? `${Math.round(ep.contextWindow / 1024)}k context` : null].filter(Boolean).join(" · ");
}

/** A new custom model's fields before anything is filled in: a server of your own on this machine. */
const OWN_SERVER = { baseUrl: "http://127.0.0.1:8080", models: "", context: "", label: "" };

/**
 * Adds (or changes) a custom model: a model server of your own, such as llama.cpp running a local model, or a hosted
 * one from a preset (Kimi K3.1 Pro through Moonshot's API). The hub checks the server itself, since a local server is
 * only reachable from the machine it runs on. Saving doesn't need a check: some hosted APIs don't answer one.
 */
export function EndpointDialog({ provider, account, onClose, preset: startWith = null }: { provider: Provider; account: AgentAccount | null; onClose: () => void; preset?: EndpointPreset | null }) {
  const toast = useStore((s) => s.toast);
  const ep = account?.endpoint ?? null;
  // Presets are for new custom models, and only those this agent can reach.
  const presets = account ? [] : ENDPOINT_PRESETS.filter((p) => presetFields(p, provider));
  const [preset, setPreset] = useState<EndpointPreset | null>(() => (startWith && presets.some((p) => p.id === startWith.id) ? startWith : null));
  const filled = (preset && presetFields(preset, provider)) || OWN_SERVER;
  const [label, setLabel] = useState(account?.label ?? filled.label);
  const [baseUrl, setBaseUrl] = useState(ep?.baseUrl ?? filled.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [dropKey, setDropKey] = useState(false);
  const [models, setModels] = useState(ep?.models.join(", ") ?? filled.models);
  const [context, setContext] = useState(ep?.contextWindow ? String(ep.contextWindow) : filled.context);
  const [probe, setProbe] = useState<EndpointProbe | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = PROVIDER_INFO[provider].name;
  /** Switches between your own server and a preset: fields still as the last choice filled them follow; typing stays. */
  const choose = (id: string) => {
    const next = presets.find((p) => p.id === id) ?? null;
    if (next?.id === preset?.id) return;
    const from = (preset && presetFields(preset, provider)) || OWN_SERVER;
    const to = (next && presetFields(next, provider)) || OWN_SERVER;
    if (baseUrl === from.baseUrl) setBaseUrl(to.baseUrl);
    if (models === from.models) setModels(to.models);
    if (context === from.context) setContext(to.context);
    if (label === from.label) setLabel(to.label);
    setPreset(next);
    setProbe(null);
    setError("");
  };
  // A hosted API can't be used without its key.
  const needsKey = !!preset && !apiKey.trim() && !ep?.hasKey;
  const check = async () => {
    setChecking(true);
    setError("");
    setProbe(null);
    try {
      const p = await api<EndpointProbe>("POST", "/api/accounts/endpoint/probe", { baseUrl, apiKey });
      setProbe(p);
      setBaseUrl(p.baseUrl);
      if (p.models.length) setModels(p.models.join(", "));
      if (p.contextWindow) setContext(String(p.contextWindow));
      if (!label.trim() && p.models[0]) setLabel(p.models[0].replace(/\.gguf$/i, "").split("/").pop()!.slice(0, 40));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/accounts/endpoint", {
        provider,
        id: account?.id,
        label: label.trim() || undefined,
        baseUrl,
        // A new key replaces the saved one; none keeps it (or, for a new model, means the server needs none).
        ...(apiKey.trim() || !account || dropKey ? { apiKey: dropKey ? "" : apiKey.trim() } : {}),
        models: models.split(",").map((m) => m.trim()).filter(Boolean),
        contextWindow: context.trim() ? Number(context.trim()) : null,
        // What Add an AI service saved besides: this dialog has no fields for it, so changing the account keeps it.
        ...(ep?.protocol ? { protocol: ep.protocol } : {}),
        ...(ep?.chatPath ? { chatPath: ep.chatPath } : {}),
        ...(ep?.contexts ? { contexts: ep.contexts } : {}),
      });
      toast("info", account ? "Custom model saved. Chats using it pick up the change." : `Added. Pick it as the account in a new ${name} chat.`);
      onClose();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // A name that's taken (say, a second Kimi K3.1 Pro): say how to get past it.
      toast("error", e instanceof ApiError && e.status === 409 && !account ? `${text}. Give it another name below.` : text);
    } finally {
      setBusy(false);
    }
  };
  // What the dialog opened with: anything else (a pasted key above all) is asked about before it's thrown away.
  const opened = useRef({ label, baseUrl, models, context, preset: preset?.id ?? null });
  const dirty =
    !!apiKey.trim() ||
    dropKey ||
    label !== opened.current.label ||
    baseUrl !== opened.current.baseUrl ||
    models !== opened.current.models ||
    context !== opened.current.context ||
    (preset?.id ?? null) !== opened.current.preset;
  const addressField = (
    <label className="field">
      <span>Server address</span>
      <div className="row" style={{ gap: 8 }}>
        <input className="input mono" style={{ flex: 1 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8080" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button className="btn" onClick={check} disabled={checking || !baseUrl.trim()}>
          {checking ? "Checking…" : "Check"}
        </button>
      </div>
      <span className="help">{preset ? `${preset.label}'s address for ${name}.` : "As this machine's hub reaches it: http://127.0.0.1:8080 when the server runs on the same machine."}</span>
    </label>
  );
  const checked = (
    <>
      {error && <p className="small" style={{ color: "var(--red)", marginTop: 0 }}>{error}{preset ? " You can still save without checking." : ""}</p>}
      {probe && (
        <p className="small" style={{ color: "var(--green)", marginTop: 0 }}>
          Found {probe.server ?? "a model server"}: {probe.models.length === 1 ? probe.models[0] : `${probe.models.length} models`}
          {probe.contextWindow ? `, ${probe.contextWindow.toLocaleString()} tokens of context` : ""}.
        </p>
      )}
    </>
  );
  const modelsField = (
    <label className="field">
      <span>Models</span>
      <input className="input mono" value={models} onChange={(e) => setModels(e.target.value)} placeholder="Check fills this in" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <span className="help">The model names the server answers to, separated by commas. The first is the default.</span>
    </label>
  );
  const contextField = (
    <label className="field">
      <span>Context size (tokens)</span>
      <input className="input mono" inputMode="numeric" value={context} onChange={(e) => setContext(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 65536" />
      <span className="help">
        {preset ? "How much of a chat the model takes in at once." : "What the server gives each request (llama-server's -c)."} Chats summarize older messages at three quarters of it.{" "}
        {!preset && provider === "claude" ? "Claude Code needs about 20,000 just to start, so 64k or more works best." : ""}
      </span>
    </label>
  );
  const keyField = (
    <label className="field">
      <span>{preset ? "API key" : "API key (optional)"}</span>
      <input className="input mono" type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setDropKey(false); }} autoComplete="off" placeholder={ep?.hasKey ? "Saved: leave empty to keep it" : preset ? "Paste your key" : "Only if the server asks for one"} />
      {needsKey && <span className="help">Paste your key to save.</span>}
      {ep?.hasKey && (
        <label className="row small" style={{ gap: 6, marginTop: 4 }}>
          <input type="checkbox" checked={dropKey} onChange={(e) => setDropKey(e.target.checked)} /> Remove the saved key
        </label>
      )}
    </label>
  );
  const nameField = !account && (
    <label className="field">
      <span>Name</span>
      <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Qwen on the Linux box" />
    </label>
  );
  return (
    <Dialog
      title={account ? `${account.label}` : `Add a custom model for ${name}`}
      icon={<Cpu size={20} />}
      dirty={dirty && !busy}
      onClose={() => !busy && onClose()}
      footer={(requestClose) => (
        <>
          <button className="btn" onClick={() => requestClose()} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !baseUrl.trim() || !models.trim() || needsKey}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      )}
    >
      {presets.length > 0 && (
        <div className="field">
          <span>Start from</span>
          <ChoiceCards
            label="Start from"
            value={preset?.id ?? "own"}
            onChange={choose}
            options={[
              { id: "own", label: "Your own server", help: "llama.cpp, LM Studio, Ollama or another model server you run." },
              ...presets.map((p) => ({ id: p.id, label: p.title, help: p.help })),
            ]}
          />
        </div>
      )}
      {preset ? (
        <>
          <p className="help" style={{ marginTop: 0 }}>
            Runs {name} on {preset.label} through {preset.vendor}'s API, billed per use by {preset.vendor}, not from your plan. Get a key at{" "}
            <a href={preset.keyFrom.url} target="_blank" rel="noreferrer noopener">
              {preset.keyFrom.label}
            </a>
            , then paste it here.
          </p>
          {/* What a preset needs from you comes first; what it filled in stays out of the way. */}
          {keyField}
          {nameField}
          <details className="field-details">
            <summary>Details</summary>
            <p className="help" style={{ marginTop: 0 }}>Filled in for {preset.label}: change them only if {preset.vendor} says so. Check may not work with it, and saving doesn't need it.</p>
            {addressField}
            {checked}
            {modelsField}
            {contextField}
          </details>
        </>
      ) : (
        <>
          <p className="help" style={{ marginTop: 0 }}>
            {provider === "claude"
              ? "Runs Claude Code on a model server of your own. The server has to speak Anthropic's Messages API: llama.cpp's llama-server, LM Studio and Ollama do."
              : "Runs Codex on a model server of your own. The server has to speak OpenAI's Responses API: Ollama and LM Studio do; llama.cpp's llama-server does too, but some of Codex's tools may not work with it."}
          </p>
          {addressField}
          {checked}
          {modelsField}
          {contextField}
          {keyField}
          {nameField}
        </>
      )}
    </Dialog>
  );
}

function ApiKeyDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const [key, setKey] = useState("");
  const toast = useStore((s) => s.toast);
  const save = async (value: string | null) => {
    try {
      await api("POST", `/api/providers/${provider}/apikey`, { apiKey: value });
      toast("info", value ? "API key saved on the hub." : "API key removed.");
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog
      title={`${PROVIDER_INFO[provider].name} API key`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => save(null)}>
            Remove key
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!key.trim()} onClick={() => save(key)}>
            Save
          </button>
        </>
      }
    >
      <label className="field">
        <span>API key</span>
        <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder="Paste your key" />
        <span className="help">Stored only on your hub, in a file only your user can read. An API key takes priority over a browser sign-in and is billed per use.</span>
      </label>
    </Dialog>
  );
}
