import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { EFFORT_LABELS, PERMISSION_MODES, PROVIDER_INFO, isServiceOnlyAgent, permissionInfo, type AgentDefaults, type HubSettings, type ModelCatalog, type Provider, type RoomDefaults } from "@crosstalk/shared";
import { api } from "../api";
import { effortSelection, modelOptionText } from "../models";
import { useCatalog } from "../useCatalog";
import { AccountPicker } from "./AccountPicker";
import { TEAMWORK_OPTIONS, parallelWorkHelp, teamworkMode } from "../teamwork";
import { useStore } from "../store";
import { useNavigationGuard } from "../navigation";
import { ChoiceCards, ProviderAvatar, Stepper, Switch, useIsMobile } from "../ui";

/** Hub preferences and defaults for new rooms and agents. */
export function SettingsPage() {
  const mobile = useIsMobile();
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.providers);
  const [saved, setSaved] = useState<RoomDefaults | null>(null);
  const [draft, setDraft] = useState<RoomDefaults | null>(null);
  const [busy, setBusy] = useState(false);
  const catalogs = useRef<Partial<Record<Provider, ModelCatalog>>>({});
  const [error, setError] = useState("");
  const request = useRef(0);
  // Crosstalk's own agent and OpenCode run only on AI services and have nothing to sign in to: they have no defaults of their own here.
  const installed = (Object.keys(PROVIDER_INFO) as Provider[]).filter((p) => p !== "mock" && !isServiceOnlyAgent(p) && providers[p]?.installed);

  const load = () => {
    const id = ++request.current;
    setError("");
    api<RoomDefaults>("GET", "/api/settings/defaults")
      .then((d) => { if (id === request.current) { const next = { ...d, mode: teamworkMode(d.mode) }; setSaved(next); setDraft(next); } })
      .catch((e) => { if (id === request.current) setError(e.message); });
  };
  useEffect(() => {
    load();
    return () => { request.current++; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useNavigationGuard(dirty);
  const set = (patch: Partial<RoomDefaults>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const agentDefaults = (p: Provider): AgentDefaults => draft?.agent[p] ?? { permissionMode: "ask", model: null, effort: null };
  const setAgent = (p: Provider, patch: Partial<AgentDefaults>) => setDraft((d) => (d ? { ...d, agent: { ...d.agent, [p]: { ...agentDefaults(p), ...patch } } } : d));

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const agent = Object.fromEntries(Object.entries(draft.agent).map(([provider, value]) => {
        const selection = effortSelection(catalogs.current[provider as Provider], provider as Provider, value.model, value.effort, value.account);
        return [provider, { ...value, effort: selection.known ? selection.value || null : value.effort }];
      }));
      const next = await api<RoomDefaults>("PUT", "/api/settings/defaults", { ...draft, agent });
      setSaved(next);
      setDraft(next);
      toast("info", "Defaults saved. They apply to rooms and agents you add from now on.");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        {mobile && (
          <button className="icon-btn" onClick={() => setView("setup")} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <div className="titles">
          <h1>Settings</h1>
          <div className="sub">Preferences &amp; defaults</div>
        </div>
        <button className="btn small ghost" onClick={() => saved && setDraft(saved)} disabled={!dirty || busy} aria-label="Undo changes">
          {mobile ? "Undo" : "Undo changes"}
        </button>
        <button className="btn small primary" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          <UsagePauseSetting />
          <h2 className="section-title">New room defaults</h2>
          {!draft ? (
            error ? <div role="alert"><p>{error}</p><button className="btn" onClick={load}>Retry</button></div> : <p className="muted" role="status">Loading…</p>
          ) : (
            <fieldset className="settings-fields" disabled={busy}>
              <p className="help" style={{ marginTop: 0 }}>
                These are starting points. Each room and agent can still be changed in its own settings, and existing rooms keep what they have.
              </p>

              <h2 className="section-title">Agent teamwork</h2>
              <div className="field">
                <ChoiceCards label="Default agent teamwork" value={draft.mode} onChange={(mode) => set({ mode })} options={TEAMWORK_OPTIONS} />
              </div>
              {draft.mode === "review" && (
                <div className="field">
                  <span>Most review rounds</span>
                  <Stepper label="review rounds" value={Math.max(1, Math.ceil(draft.maxHops / 2))} min={1} max={25} onChange={(n) => set({ maxHops: n * 2 - 1 })} unit={(n) => `${n} round${n === 1 ? "" : "s"}`} />
                  <span className="help">The loop stops early as soon as the reviewer approves. Fewer rounds use less of your plan.</span>
                </div>
              )}
              <div className="row" style={{ marginBottom: 20 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>Let agents work at the same time</div>
                  <div className="help">{parallelWorkHelp(draft.parallel, draft.mode)}</div>
                </div>
                <Switch checked={draft.parallel} onChange={(parallel) => set({ parallel })} label="Let agents work at the same time" />
              </div>

              <h2 className="section-title">Agents in new rooms</h2>
              {installed.length === 0 ? (
                <p className="help">No agents are set up yet. Add them under Agents &amp; sign-ins.</p>
              ) : (
                <>
                  <div className="row wrap" style={{ gap: 8, marginBottom: 6 }}>
                    {installed.map((p) => {
                      const on = draft.agents.length === 0 || draft.agents.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          aria-label={PROVIDER_INFO[p].name}
                          aria-pressed={on}
                          disabled={on && draft.agents.length === 1}
                          className={`btn ${on ? "primary" : ""}`}
                          onClick={() => {
                            const current = draft.agents.length ? draft.agents : installed;
                            set({ agents: on ? current.filter((x) => x !== p) : [...current, p] });
                          }}
                        >
                          <ProviderAvatar provider={p} size="sm" /> {PROVIDER_INFO[p].name}
                        </button>
                      );
                    })}
                    <button type="button" className="btn" aria-pressed={draft.agents.length === 0} onClick={() => set({ agents: [] })}>All available agents</button>
                  </div>
                  <p className="help" style={{ marginTop: 0, marginBottom: 20 }}>Choose at least one agent, or use all available agents (including ones you add later). You can still change the team when creating a room.</p>
                </>
              )}

              <h2 className="section-title">Each agent starts with</h2>
              {installed.map((p) => (
                <AgentDefaultsCard key={p} provider={p} value={agentDefaults(p)} onChange={(patch) => setAgent(p, patch)} onCatalog={(catalog) => { catalogs.current[p] = catalog; }} />
              ))}
            </fieldset>
          )}
        </div>
      </div>
    </>
  );
}

export function UsagePauseSetting() {
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    setError("");
    api<HubSettings>("GET", "/api/settings/hub")
      .then((next) => { if (id === request.current) setSettings(next); })
      .catch((e) => { if (id === request.current) setError(e.message); });
  };
  useEffect(() => {
    load();
    return () => { request.current++; };
  }, []);
  const save = async (patch: Pick<Partial<HubSettings>, "pauseNearLimit" | "carryOnAfterLimit">) => {
    if (!settings || busy) return;
    const previous = settings;
    const id = ++request.current;
    setSettings({ ...settings, ...patch });
    setBusy(true);
    setError("");
    try {
      const next = await api<HubSettings>("PUT", "/api/settings/hub", patch);
      if (id === request.current) setSettings(next);
    } catch (e) {
      if (id === request.current) {
        setSettings(previous);
        setError(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  };
  return (
    <section className="card" aria-label="Usage preferences" style={{ marginBottom: 24 }}>
      <h2 className="section-title" style={{ marginTop: 0 }}>Usage</h2>
      {settings ? (
        <fieldset className="settings-fields" disabled={busy}>
          <div className="row" style={{ gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Pause near usage limits</div>
              <p className="help">Pause automatic reviews and hand-offs when an agent reaches 90% of a reported usage limit. Off by default; the provider's own limits still apply.</p>
            </div>
            <Switch checked={settings.pauseNearLimit} onChange={(pauseNearLimit) => save({ pauseNearLimit })} label="Pause near usage limits" />
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Carry on when the limit resets</div>
              <p className="help">When an agent runs out of messages, the chat waits and picks itself back up once the limit resets, so you don't have to tap Try again hours later. Off: the reply fails and waits for you.</p>
            </div>
            <Switch checked={settings.carryOnAfterLimit !== false} onChange={(carryOnAfterLimit) => save({ carryOnAfterLimit })} label="Carry on when the limit resets" />
          </div>
          <p className="help" role="status" style={{ marginBottom: 0 }}>{busy ? "Saving…" : "Saves immediately for all rooms."}</p>
        </fieldset>
      ) : !error && <p className="muted" role="status">Loading usage preferences…</p>}
      {error && <div role="alert"><p>{error}</p>{!settings && <button className="btn" onClick={load}>Retry usage preferences</button>}</div>}
    </section>
  );
}

function AgentDefaultsCard({ provider, value, onChange, onCatalog }: { provider: Provider; value: AgentDefaults & { account?: string }; onChange: (patch: Partial<AgentDefaults> & { account?: string }) => void; onCatalog: (catalog: ModelCatalog) => void }) {
  // The agent's model list, kept live (useCatalog): tagged with the account it was asked for.
  const { catalog } = useCatalog(provider, value.account ?? "default");
  useEffect(() => {
    if (catalog) onCatalog(catalog);
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  const models = catalog?.models ?? [];
  const chosen = value.model ? models.find((m) => m.id === value.model) : models.find((m) => m.isDefault);
  const selection = effortSelection(catalog, provider, value.model, value.effort, value.account);
  const efforts = selection.levels;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <ProviderAvatar provider={provider} size="sm" />
        <h3 style={{ margin: 0 }}>{PROVIDER_INFO[provider].name}</h3>
      </div>
      <AccountPicker provider={provider} label={`${PROVIDER_INFO[provider].name} default account`} value={value.account ?? "default"} onChange={(account) => onChange({ account })} />
      <div className="field">
        <span>Permissions</span>
        <ChoiceCards
          label={`${PROVIDER_INFO[provider].name} default permissions`}
          value={value.permissionMode}
          onChange={(permissionMode) => onChange({ permissionMode })}
          options={PERMISSION_MODES.map((m) => {
            const info = permissionInfo(provider, m.id);
            return { id: m.id, label: info.label, help: info.help, badge: <span className={`pill ${info.tone}`}>{info.short}</span> };
          })}
        />
      </div>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">
          <span>Model</span>
          <select className="select" value={value.model ?? ""} onChange={(e) => onChange({ model: e.target.value || null, effort: null })}>
            <option value="">{models.find((m) => m.isDefault) ? `Default (${models.find((m) => m.isDefault)!.label})` : "Agent's default"}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelOptionText(m)}
              </option>
            ))}
            {value.model && !models.some((m) => m.id === value.model) && <option value={value.model}>{value.model}</option>}
          </select>
        </label>
        {efforts.length > 0 && (
          <label className="field">
            <span>Effort</span>
            <select className="select" value={efforts.includes(selection.value) ? selection.value : ""} onChange={(e) => onChange({ effort: e.target.value || null })}>
              <option value="">Default</option>
              {efforts.map((l) => (
                <option key={l} value={l}>
                  {EFFORT_LABELS[l] ?? l}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {provider === "antigravity" && chosen?.defaultEffort && efforts.length === 0 && <p className="help">Effort: {EFFORT_LABELS[chosen.defaultEffort] ?? chosen.defaultEffort} (included in this model).</p>}
      {selection.known && value.effort && !efforts.includes(value.effort) && <p className="help">The saved effort “{EFFORT_LABELS[value.effort] ?? value.effort}” is not supported by this model and will be cleared when you save.</p>}
    </div>
  );
}
