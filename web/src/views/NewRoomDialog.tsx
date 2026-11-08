import { useEffect, useState } from "react";
import { PROVIDER_INFO, isServiceOnlyAgent, type Member, type Provider, type Room, type RoomDefaults } from "@crosstalk/shared";
import { api } from "../api";
import { AccountPicker } from "./AccountPicker";
import { TEAMWORK_OPTIONS, teamworkMode, type TeamworkMode } from "../teamwork";
import { useStore } from "../store";
import { ChoiceCards, Dialog, ProviderAvatar, Seg } from "../ui";
import { useMachineName } from "./MachinePicker";

type Source = "new" | "existing" | "clone";

export function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const hub = useStore((s) => s.hub);
  const machine = useMachineName();
  const providers = useStore((s) => s.providers);
  const accounts = useStore((s) => s.accounts);
  const [selectedAccounts, setSelectedAccounts] = useState<Partial<Record<Provider, string>>>({});
  const [initialAccounts, setInitialAccounts] = useState("{}");
  const openRoom = useStore((s) => s.openRoom);
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("new");
  const [cwd, setCwd] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [mode, setMode] = useState<TeamworkMode>("review");
  const ready = (Object.keys(PROVIDER_INFO) as Provider[]).filter((p) => p !== "mock" && !isServiceOnlyAgent(p) && providers[p]?.installed && (providers[p]?.signedIn !== false || Object.values(accounts).some((a) => a.provider === p && a.signedIn)));
  const [agents, setAgents] = useState<Provider[]>(ready.slice(0, 3));
  const [initialAgents, setInitialAgents] = useState(() => JSON.stringify(agents));
  const [defaultAgent, setDefaultAgent] = useState<Provider | "">(ready[0] ?? "");
  const [initialDefaultAgent, setInitialDefaultAgent] = useState<Provider | "">(ready[0] ?? "");
  const [initialMode, setInitialMode] = useState<TeamworkMode>("review");
  // Start from Settings → Defaults. The form appears once they're in, so they can't overwrite a choice you've made.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api<RoomDefaults>("GET", "/api/settings/defaults")
      .then((d) => {
        const picked = d.agents.length ? ready.filter((p) => d.agents.includes(p)) : ready;
        const configured = Object.fromEntries(Object.entries(d.agent).map(([p, a]) => [p, (a as { account?: string }).account ?? "default"]));
        setSelectedAccounts(configured);
        setInitialAccounts(JSON.stringify(configured));
        setMode(teamworkMode(d.mode));
        setInitialMode(teamworkMode(d.mode));
        setDefaultAgent(picked[0] ?? "");
        setInitialDefaultAgent(picked[0] ?? "");
        setAgents(picked);
        setInitialAgents(JSON.stringify(picked));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(selectedAccounts) !== initialAccounts || !!name || source !== "new" || !!cwd || !!cloneUrl || mode !== initialMode || JSON.stringify(agents) !== initialAgents || defaultAgent !== initialDefaultAgent;
  const folder = cwd.trim();
  const folderError = source === "existing" && (!folder || !(folder.startsWith("/") || folder.startsWith("~/")))
    ? `Enter a full folder path on ${machine}, starting with / or ~/.`
    : "";

  const create = async () => {
    if (busy || folderError || (source === "clone" && !cloneUrl.trim())) return;
    setBusy(true);
    try {
      const room = await api<Room>("POST", "/api/rooms", {
        name: name.trim() || "New room",
        mode,
        cwd: source === "existing" ? folder : undefined,
        cloneUrl: source === "clone" ? cloneUrl.trim() : undefined,
      });
      for (const p of agents) {
        const member = await api<Member>("POST", `/api/rooms/${room.id}/members`, { provider: p, config: { account: selectedAccounts[p] ?? "default" } });
        if (p === defaultAgent) await api("PATCH", `/api/rooms/${room.id}`, { leadMemberId: member.id });
      }
      onClose();
      openRoom(room.id);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (p: Provider) => {
    const next = agents.includes(p) ? agents.filter((x) => x !== p) : [...agents, p];
    setAgents(next);
    if (!next.includes(defaultAgent as Provider)) setDefaultAgent(next[0] ?? "");
  };
  const choices = (Object.keys(PROVIDER_INFO) as Provider[]).filter((p) => p !== "mock" && !isServiceOnlyAgent(p) && providers[p]?.installed);

  return (
    <Dialog
      title="New room"
      onClose={onClose}
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <button className="btn" onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy || !loaded || !!folderError || (source === "clone" && !cloneUrl.trim())}>
            {busy ? "Creating…" : "Create room"}
          </button>
        </>
      )}
    >
      {!loaded ? <p className="muted">Loading your defaults…</p> : (
      <>
      <label className="field">
        <span>Name</span>
        <input className="input" placeholder="e.g. Payments API" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {/* Not <label>s: tapping text inside a label clicks its first button and resets the choice. */}
      <div className="field">
        <span>Project folder on the hub</span>
        <Seg
          value={source}
          onChange={setSource}
          options={[
            { id: "new", label: "New folder" },
            { id: "existing", label: "Existing folder" },
            { id: "clone", label: "Clone a repo" },
          ]}
        />
        {source === "new" && <span className="help">A new folder inside {hub?.workspaceRoot ?? "your workspaces folder"}.</span>}
        {source === "existing" && (
          <>
            <input className="input mono" aria-label="Existing project folder" aria-invalid={!!folderError} aria-describedby={folderError ? "new-room-folder-error" : undefined} placeholder="/Users/you/code/my-project" value={cwd} onChange={(e) => setCwd(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {folderError && <span id="new-room-folder-error" className="help" style={{ color: "var(--red)" }}>{folderError}</span>}
          </>
        )}
        {source === "clone" && (
          <>
            <input className="input mono" aria-label="Repository URL" placeholder="https://github.com/you/repo.git" value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <span className="help">Private repos need GitHub signed in on the hub (Settings → More → GitHub).</span>
          </>
        )}
      </div>
      <div className="field">
        <span>Agent teamwork</span>
        <ChoiceCards label="Agent teamwork" value={mode} onChange={setMode} options={TEAMWORK_OPTIONS} />
        <span className="help">You can change this and the finer details later in Room settings.</span>
      </div>
      <div className="field">
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>Agents</span>
        {choices.length ? (
          <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
            {choices.map((p) => (
              <button key={p} type="button" aria-label={PROVIDER_INFO[p].name} aria-pressed={agents.includes(p)} className={`btn ${agents.includes(p) ? "primary" : ""}`} onClick={() => toggle(p)}>
                <ProviderAvatar provider={p} size="sm" /> {PROVIDER_INFO[p].name}
              </button>
            ))}
          </div>
        ) : (
          <p className="help">No agents are installed on the hub yet. Create the room now and add agents after setting them up.</p>
        )}
      </div>
      {agents.map((p) => <AccountPicker key={p} provider={p} label={`${PROVIDER_INFO[p].name} account`} value={selectedAccounts[p] ?? "default"} onChange={(id) => setSelectedAccounts((current) => ({ ...current, [p]: id }))} />)}
      {agents.length > 0 && (
        <label className="field">
          <span>Default agent</span>
          <select className="select" aria-label="Default agent" aria-describedby="new-default-agent-help" value={defaultAgent} onChange={(e) => setDefaultAgent(e.target.value as Provider)}>
            {agents.map((p) => <option key={p} value={p}>{PROVIDER_INFO[p].name}</option>)}
          </select>
          <span id="new-default-agent-help" className="help">{mode === "review" ? "Does the work. Another selected agent reviews it." : "Handles your requests unless you mention another agent."}</span>
        </label>
      )}
      {mode === "review" && agents.length === 1 && <p className="help" style={{ color: "var(--orange)" }}>Select a second agent for reviews, or choose Off to work with one agent.</p>}
      </>
      )}
    </Dialog>
  );
}
