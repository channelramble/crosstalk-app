import { useEffect, useRef, useState } from "react";
import { EFFORT_LABELS, PERMISSION_MODES, PROVIDER_INFO, isServiceOnlyAgent, permissionInfo, slugHandle, type Member, type ModelCatalog, type PermissionMode, type Provider, type Room, type RoomDefaults } from "@crosstalk/shared";
import { api } from "../api";
import { selectRoomMembers, useStore } from "../store";
import { Dialog, ProviderAvatar } from "../ui";
import { HELPER_PROVIDERS, HelperSelect, helperHelp } from "./AgentOptions";
import { ModelSelectOptions } from "./ModelChoices";
import { effortSelection, isCustomModel, listedModel, modelHelp } from "../models";
import { useCatalog } from "../useCatalog";
import { accountKey, memberAccount } from "../accounts";
import { AccountPicker } from "./AccountPicker";
import { AlwaysAllowedList } from "./AlwaysAllowed";

const CUSTOM_MODEL = "__custom__";

const ROLE_PRESETS: { label: string; text: string }[] = [
  { label: "Builder", text: "You implement features and fixes. Keep changes small and focused, run the tests, and hand your diff to a reviewer when you're done." },
  { label: "Reviewer", text: "You review other agents' changes. Read the diff carefully, run the tests, and point out bugs, risks and missing tests. Approve clearly when it's good." },
  { label: "Tester", text: "You write and run tests. Find edge cases, reproduce bugs, and report exact failing commands and output." },
  { label: "Architect", text: "You plan before anyone codes: propose a design, split the work into steps, and assign them to the other agents with @mentions." },
  { label: "Researcher", text: "You investigate: read the codebase and docs, answer questions with file paths and line numbers, and don't edit files unless asked." },
];

/** One agent of a group chat (or of a room on an older machine): add it, or change how it runs, its name and its role. */
export function AgentDialog({ room, member, onClose }: { room: Room; member: Member | null; onClose: () => void }) {
  // A group chat says "chat" and "lead" where a room said "room" and "default agent".
  const group = !!room.chat?.group;
  const where = group ? "chat" : "room";
  const providers = useStore((s) => s.providers);
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const setView = useStore((s) => s.setView);
  // Crosstalk's own agent and OpenCode run only as an AI service's agent (Settings → AI services), never on their own in a room.
  const options = (Object.keys(PROVIDER_INFO) as Provider[]).filter((p) => !isServiceOnlyAgent(p) && (p !== "mock" || providers.mock));
  const firstReady = options.find((p) => p !== "mock" && providers[p]?.installed) ?? options[0];
  const [provider, setProvider] = useState<Provider>(member?.provider ?? firstReady);
  const [account, setAccount] = useState(member ? memberAccount(member) : "default");
  const [handle, setHandle] = useState(member?.handle ?? "");
  const [model, setModel] = useState(member?.model ?? "");
  const [effort, setEffort] = useState(typeof member?.config?.effort === "string" ? member.config.effort : "");
  const [helperModel, setHelperModel] = useState(typeof member?.config?.helperModel === "string" ? member.config.helperModel : "");
  const [customModel, setCustomModel] = useState(false);
  const [role, setRole] = useState(member?.role ?? "");
  const [perm, setPerm] = useState<PermissionMode>(member?.permissionMode ?? "ask");
  const defaultId = room.leadMemberId ?? selectRoomMembers(room.id)(useStore.getState())[0]?.id;
  const alreadyDefault = !!member && defaultId === member.id;
  const [lead, setLead] = useState(alreadyDefault);
  const [busy, setBusy] = useState(false);
  // The agent as the hub has it now, not as it was when "Change" was tapped: the chat itself can change its settings
  // while this is open (the agent asking for helpers on another model), and so can another device. The hub replaces a
  // member's config whole, so a save sends this one, with only the settings below written over it.
  const live = useStore((s) => (member ? s.members[member.id] : undefined)) ?? member;
  // What the settings below opened with, so a save only writes those the person actually changed.
  const opened = useRef({ effort: typeof member?.config?.effort === "string" ? member.config.effort : "", helperModel: typeof member?.config?.helperModel === "string" ? member.config.helperModel : "" });
  const formValues = JSON.stringify({ provider, handle, model, effort, helperModel, role, perm, lead, account });
  const [initialValues, setInitialValues] = useState(formValues);
  const dirty = formValues !== initialValues;
  const st = providers[provider];
  const accountStatus = accounts[accountKey(provider, account)];
  const notReady = provider !== "mock" && (!st?.installed || (accountStatus ? accountStatus.signedIn === false : account === "default" ? st.signedIn === false : true));

  // A new agent starts from Settings → Defaults for its kind (changing the agent type re-applies them).
  const [defaults, setDefaults] = useState<RoomDefaults | null>(null);
  const baselined = useRef(false);
  // A new agent's form stays hidden until its defaults are in, so they can never overwrite a choice you've made.
  const [ready, setReady] = useState(!!member);
  const catalogRef = useRef<ModelCatalog | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    if (!member) api<RoomDefaults>("GET", "/api/settings/defaults").then(setDefaults).catch(() => setReady(true));
  }, [member]);
  useEffect(() => {
    if (member || !defaults) return;
    const d = defaults.agent[provider];
    const next = { account: (d as { account?: string } | undefined)?.account ?? "default", perm: d?.permissionMode ?? ("ask" as PermissionMode), model: d?.model ?? "", effort: d?.effort ?? "", helperModel: d?.helperModel ?? "" };
    setAccount(next.account);
    setPerm(next.perm);
    setModel(next.model);
    setEffort(next.effort);
    setHelperModel(next.helperModel);
    // A saved model the agent doesn't list gets the "Other…" field, so it doesn't show up blank. Only judge it
    // against this agent's own model list; if that isn't loaded yet, the catalog effect decides when it arrives.
    // The model list's own check (below) runs right after this, with the model as it is now.
    modelRef.current = next.model;
    setCustomModel(isCustomModel(next.model, catalogRef.current, provider, next.account) ?? false);
    setReady(true);
    // Filling in defaults isn't an edit: don't ask "Discard changes?" for a dialog the user hasn't touched.
    if (!baselined.current) {
      baselined.current = true;
      setInitialValues(JSON.stringify({ provider, handle, model: next.model, effort: next.effort, helperModel, role, perm: next.perm, lead, account: next.account }));
    }
  }, [defaults, provider, member]); // eslint-disable-line react-hooks/exhaustive-deps

  // The models and effort levels come from the agent's own CLI on the hub (kept live: see useCatalog).
  const listed = useCatalog(provider === "mock" ? null : provider, account);
  const catalog: ModelCatalog | null = listed.catalog;
  catalogRef.current = catalog; // tagged with the agent and account it belongs to
  const judged = useRef<string | null>(null);
  useEffect(() => {
    const key = `${provider}|${account}`;
    if (judged.current === key || (!catalog && !listed.failed)) return;
    judged.current = key;
    // When the list first comes in, use the model as it is now (defaults may have filled it in meanwhile), both ways:
    // a listed model leaves "Other…", an unlisted one gets it. Later updates to the list only change the choices.
    if (catalog) setCustomModel(isCustomModel(modelRef.current, catalog, provider, account) ?? false);
    else setCustomModel(!!modelRef.current);
  }, [catalog, listed.failed, provider, account]);

  const models = catalog?.models ?? [];
  const defaultModel = models.find((m) => m.isDefault);
  const chosen = customModel ? undefined : model ? listedModel(models, model) : defaultModel;
  // The option that stands for the saved model: its own id, even when the model was saved as the concrete name behind
  // that id (what the model row under the message box saves), so the list shows the model instead of nothing picked.
  const modelValue = customModel ? CUSTOM_MODEL : chosen && model ? chosen.id : model;
  const effortChoice = effortSelection(catalog, provider, model, effort, account);
  const levels = effortChoice.levels;
  const effortValue = levels.includes(effortChoice.value) ? effortChoice.value : "";
  // A saved effort this model doesn't take: said under the field, and cleared by the save (it would fail the turn).
  const dropEffort = effortChoice.known && !!effort && !levels.includes(effort);
  // The model helpers use, against the agent's own model by either name: the same model needs no separate pick.
  const ownModel = chosen?.resolvedModel ?? chosen?.id ?? model.trim();
  const helperIsOwn = !!helperModel && (helperModel === ownModel || helperModel === model.trim());
  // The @name the agent really gets: the hub slugs what's typed (slugHandle), so the line under the box must too.
  const handleNow = handle.trim() ? slugHandle(handle.trim()) : member?.handle || PROVIDER_INFO[provider].defaultHandle;

  const save = async () => {
    setBusy(true);
    try {
      let id = member?.id;
      const config: Record<string, unknown> = { ...(live?.config ?? {}), account };
      const helperPick = helperModel && HELPER_PROVIDERS.includes(provider) && !helperIsOwn ? helperModel : "";
      if (!member) {
        // New agent: send the effort explicitly, null meaning "the agent's default", so a saved default effort
        // doesn't come back after you chose Default. (Before the model list loads, keep what was filled in.)
        config.effort = (effortChoice.known ? effortValue : effort) || null;
        // A new agent says "the same model" outright (null), so a saved default doesn't come back.
        config.helperModel = helperPick || null;
      } else {
        // An existing agent: only the effort and helper model this dialog shows are written, and only when the person
        // changed them or this model can't take what was saved. Anything set meanwhile stays (it's in `live`).
        if (effort !== opened.current.effort || dropEffort) {
          if (effortValue) config.effort = effortValue;
          else delete config.effort;
        }
        if (helperModel !== opened.current.helperModel || helperIsOwn || !HELPER_PROVIDERS.includes(provider)) {
          if (helperPick) config.helperModel = helperPick;
          else delete config.helperModel;
        }
      }
      const settings = { model: model.trim() || null, role, permissionMode: perm, config };
      let saved: Member | null = null;
      if (member) {
        saved = await api<Member>("PATCH", `/api/members/${member.id}`, { handle: handle || member.handle, ...settings });
      } else {
        const m = await api<Member>("POST", `/api/rooms/${room.id}/members`, { provider, handle: handle || undefined, ...settings });
        id = m.id;
      }
      const isLead = room.leadMemberId === id;
      if (lead !== isLead) await api("PATCH", `/api/rooms/${room.id}`, { leadMemberId: lead ? id : null });
      // The hub's own @name, not the words typed in: it slugs them ("Build Bot" becomes @build-bot).
      if (member) toast("info", `Saved. @${saved?.handle || handleNow} is now "${permissionInfo(provider, perm).short}" from its next turn.`);
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!member || !confirm(`Remove @${member.handle} from this ${where}? Its chat history stays.`)) return;
    try {
      await api("DELETE", `/api/members/${member.id}`);
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const reset = async () => {
    if (!member || !confirm(`Start a fresh session for @${member.handle}? It forgets its own context but keeps the ${where} history.`)) return;
    try {
      await api("POST", `/api/members/${member.id}/reset`);
      toast("info", `@${member.handle} will start fresh on its next turn.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      title={member ? `@${member.handle}` : "Add an agent"}
      icon={member ? <ProviderAvatar provider={member.provider} /> : undefined}
      onClose={onClose}
      dirty={dirty}
      footer={(requestClose) => (
        <>
          {member && (
            <button className="btn danger" onClick={remove} style={{ marginRight: "auto" }}>
              Remove
            </button>
          )}
          <button className="btn" onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !ready}>
            {member ? "Save" : group ? "Add to chat" : "Add to room"}
          </button>
        </>
      )}
    >
      {(requestClose) => !ready ? <p className="muted">Loading this agent's defaults…</p> : (
        <>
      {!member && (
        <div className="field">
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>Agent</span>
          <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, marginTop: 6 }}>
            {options.map((p) => {
              const s = providers[p];
              const ready = p === "mock" || (s?.installed && s.signedIn !== false);
              return (
                <button
                  key={p}
                  type="button"
                  className={`btn ${provider === p ? "primary" : ""}`}
                  style={{ justifyContent: "flex-start", padding: "8px 10px", minHeight: 48 }}
                  onClick={() => {
                    // Models and effort levels belong to one agent; start over when switching.
                    setProvider(p);
                    setAccount("default");
                    setModel("");
                    setEffort("");
                    setHelperModel("");
                    setCustomModel(false);
                  }}
                >
                  <ProviderAvatar provider={p} size="sm" />
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.2 }}>
                    <span>{PROVIDER_INFO[p].name}</span>
                    <span style={{ fontSize: 11, opacity: 0.75, fontWeight: 500 }}>{ready ? PROVIDER_INFO[p].vendor : s?.installed ? "Not signed in" : "Not installed"}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {notReady && (
            <p className="help" style={{ marginTop: 8 }}>
              {PROVIDER_INFO[provider].name} isn't {st?.installed ? "signed in" : "installed"} on the hub yet.{" "}
              <a
                href="#/setup"
                onClick={(e) => {
                  e.preventDefault();
                  requestClose(() => setView("setup"));
                }}
              >
                Set it up
              </a>
              , then add it here.
            </p>
          )}
        </div>
      )}
      {/* A model, an effort level and a helper model belong to the account that lists them, so switching accounts
          starts from that account's own (as a chat's own settings do): the other account's model would be asked of a
          server that never heard of it. */}
      <AccountPicker
        provider={provider}
        value={account}
        onChange={(id) => {
          if (id === account) return;
          setAccount(id);
          setModel("");
          setEffort("");
          setHelperModel("");
          setCustomModel(false);
        }}
      />
      {member && account !== memberAccount(member) && <p className="help">Changing accounts starts a fresh agent session. {group ? "Chat" : "Room"} history stays. Its model and effort go back to this account's own.</p>}
      <div className="field" role="radiogroup" aria-label="What this agent can do">
        <span>What can this agent do?</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
          {PERMISSION_MODES.map((p) => {
            const info = permissionInfo(provider, p.id);
            const on = perm === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                className="btn"
                onClick={() => setPerm(p.id)}
                style={{
                  justifyContent: "flex-start",
                  textAlign: "left",
                  minHeight: 56,
                  padding: "10px 12px",
                  borderColor: on ? "var(--accent)" : undefined,
                  background: on ? "var(--accent-2)" : undefined,
                }}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, whiteSpace: "normal" }}>
                  <span className="row" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{info.label}</span>
                    <span className={`pill ${info.tone}`}>{info.short}</span>
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--text-2)" }}>{info.help}</span>
                </span>
              </button>
            );
          })}
        </div>
        <span className="help">
          Applies from the agent's next turn. This is access inside Crosstalk, separate from macOS privacy settings.
        </span>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{group ? "Lead" : "Default agent"}</div>
          <div className="help">{group ? "Answers first when you don't @mention anyone." : "Gets your messages when you don't @mention anyone."}</div>
        </div>
        <button className={`btn small ${lead ? "primary" : ""}`} type="button" aria-pressed={lead} disabled={alreadyDefault} onClick={() => setLead(!lead)}>
          {alreadyDefault ? (group ? "Already the lead" : "Already the default agent") : lead ? (group ? "Selected as lead" : "Selected as default") : group ? "Make lead" : "Make default"}
        </button>
      </div>
      <details style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, padding: "10px 0", minHeight: 44 }}>Advanced: name, model, effort, instructions</summary>
      <label className="field">
        <span>Handle</span>
        <input className="input" placeholder={PROVIDER_INFO[provider].defaultHandle} value={handle} onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))} />
        {/* The hub lower-cases what's typed and turns anything but a-z, 0-9 and - into - (slugHandle), so this says
            the @name the agent really gets: a promise of "@Build Bot" would mention nobody. */}
        <span className="help">Others mention it as @{handleNow}.</span>
      </label>
      {provider !== "mock" && (
        <label className="field">
          <span>Model</span>
          <select
            className="select"
            aria-label="Model"
            value={modelValue}
            onChange={(e) => {
              const v = e.target.value;
              setCustomModel(v === CUSTOM_MODEL);
              if (v !== CUSTOM_MODEL) setModel(v);
            }}
          >
            <option value="">{defaultModel ? `Default (${defaultModel.label})` : "Agent's default"}</option>
            <ModelSelectOptions models={models} />
            <option value={CUSTOM_MODEL}>Other…</option>
          </select>
          {customModel && (
            <input className="input" placeholder="Model name, as the agent's CLI takes it" value={model} onChange={(e) => setModel(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          )}
          <span className="help">
            {modelHelp(chosen) ?? (catalog && !catalog.live ? `${PROVIDER_INFO[provider].name} couldn't be asked for its models${catalog.error ? ` (${catalog.error})` : ""}; pick a suggestion or type one.` : catalog ? "" : "Asking the agent for its models…")}
          </span>
        </label>
      )}
      {provider !== "mock" && levels.length > 0 && (
        <label className="field">
          <span>Effort</span>
          <select className="select" aria-label="Effort" value={effortValue} onChange={(e) => setEffort(e.target.value)}>
            <option value="">{chosen?.defaultEffort ? `Default (${EFFORT_LABELS[chosen.defaultEffort] ?? chosen.defaultEffort})` : "Default"}</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {EFFORT_LABELS[l] ?? l}
              </option>
            ))}
          </select>
          <span className="help">How hard the agent thinks before answering. Higher is slower and uses more of your plan.</span>
        </label>
      )}
      {provider === "antigravity" && chosen?.defaultEffort && levels.length === 0 && <p className="help">Effort: {EFFORT_LABELS[chosen.defaultEffort] ?? chosen.defaultEffort} (included in this model).</p>}
      {HELPER_PROVIDERS.includes(provider) && models.length > 0 && (
        <label className="field">
          <span>Helper agents</span>
          <HelperSelect models={models} own={chosen?.resolvedModel ?? chosen?.id ?? model.trim()} value={helperModel} onChange={setHelperModel} />
          <span className="help">{helperHelp(provider)}</span>
        </label>
      )}
      {dropEffort && <p className="help">The saved effort “{EFFORT_LABELS[effort] ?? effort}” is not supported by this model and will be cleared when you save.</p>}
      {/* Not a <label>: tapping "Role" would click the first preset and overwrite the instructions. */}
      <div className="field">
        <span>Role</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {ROLE_PRESETS.map((r) => (
            <button key={r.label} type="button" className="btn small" onClick={() => setRole(r.text)}>
              {r.label}
            </button>
          ))}
        </div>
        <textarea className="textarea" placeholder="What should this agent focus on? (optional)" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role instructions" />
      </div>
      </details>
      {/* What "Always allow" granted this agent, and a Remove for each: kept per agent, so a group chat's (or a room's)
          agent must show them here, as a one-agent chat shows them in its own settings. */}
      {member && <AlwaysAllowedList member={member} agentName={PROVIDER_INFO[provider].name} />}
      {member && (
        <button className="btn small ghost" onClick={reset}>
          Start a fresh session
        </button>
      )}
        </>
      )}
    </Dialog>
  );
}
