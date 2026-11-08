import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, Users, X } from "lucide-react";
import { CHAT_PROVIDERS, EFFORT_LABELS, GROUP_MAX, GROUP_MIN, PROVIDER_INFO, type AgentDefaults, type ChatProvider, type NewGroupChat, type Room, type RoomDefaults } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { accountDescription, accountKey } from "../accounts";
import { agentReady, hubStore, useMachines, useStore } from "../store";
import { ChoiceCards, Dialog, ProviderAvatar } from "../ui";
import { ANSWER_OPTIONS, suggestHandles } from "../groupChat";
import { AgentOptions, cleanChoice, type AgentChoice } from "./AgentOptions";
import { FolderPicker, NEW_FOLDER, OTHER_FOLDER } from "./FolderPicker";


const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** One agent of the group being made: which agent, how it runs (null until its defaults are in), its @name if typed. */
interface Pick {
  key: number;
  provider: ChatProvider;
  choice: AgentChoice | null;
  name: string;
}

/** A new agent's settings from Settings → Defaults for that agent (the main sign-in's own when there are none). */
const fromDefaults = (a: AgentDefaults | undefined): AgentChoice => ({ account: a?.account ?? "default", model: a?.model ?? "", effort: a?.effort ?? "", permissionMode: a?.permissionMode ?? "ask", helperModel: a?.helperModel ?? "" });

/**
 * New group chat: two or more agents, each with its own account, model and effort (each starts from Settings → Defaults
 * for its agent), who answers a message that names nobody (the lead, or everyone in turn), its name and folder, and with
 * several machines which one it's on.
 */
export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const openRoom = useStore((s) => s.openRoom);
  const [active, setActive] = useState(() => useStore.getState().active);
  const machines = useMachines((m) => m.list);
  const selected = machines.find((m) => m.key === active);
  const ready = useMemo(() => CHAT_PROVIDERS.filter((p) => !!selected && agentReady(selected, p)), [selected]);
  const nextKey = useRef(0);
  const pick = (provider: ChatProvider, defaults: RoomDefaults | null): Pick => ({ key: nextKey.current++, provider, choice: defaults ? fromDefaults(defaults.agent[provider]) : null, name: "" });
  // Claude Code and Codex to start with (two of one agent when only it is ready).
  const firstTwo = (): ChatProvider[] => (ready.length > 1 ? [ready[0], ready[1]] : ready.length ? [ready[0], ready[0]] : ["claude", "codex"]);
  const [defaults, setDefaults] = useState<RoomDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState("");
  const [agents, setAgents] = useState<Pick[]>(() => firstTwo().map((p) => pick(p, null)));
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [answers, setAnswers] = useState<NewGroupChat["answers"]>("lead");
  const [lead, setLead] = useState(0);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState(NEW_FOLDER);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Each agent starts from your defaults on the machine picked: read again when the machine changes.
  const request = useRef(0);
  const loadDefaults = () => {
    const id = ++request.current;
    setDefaultsError("");
    api<RoomDefaults>("GET", "/api/settings/defaults", undefined, selected?.conn ?? null)
      .then((d) => {
        if (id !== request.current) return;
        setDefaults(d);
        setAgents((list) => list.map((a) => ({ ...a, choice: fromDefaults(d.agent[a.provider]) })));
      })
      .catch((e) => id === request.current && setDefaultsError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    setDefaults(null);
    setAgents(firstTwo().map((p) => pick(p, null)));
    setLead(0);
    setFolder(NEW_FOLDER);
    loadDefaults();
    return () => {
      request.current++;
    };
  }, [active, selected?.conn.token]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Without your saved defaults: each agent's own model and effort, the main sign-in, asking first. */
  const ownDefaults = () => {
    request.current++;
    setDefaultsError("");
    const none: RoomDefaults = { mode: "direct", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: {} };
    setDefaults(none);
    setAgents((list) => list.map((a) => ({ ...a, choice: fromDefaults(undefined) })));
  };

  const recent = useMemo(
    () => [...new Set(Object.values(selected?.rooms ?? {}).filter((r) => r.chat).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => r.cwd).filter((f) => f && !/^\/(private\/)?tmp\b/.test(f)))].slice(0, 8),
    [selected?.rooms],
  );
  // Another account than the agent's main sign-in is named in its line (a custom model, an API key, another sign-in).
  const accountOf = (p: Pick) => {
    const a = selected?.accounts[accountKey(p.provider, p.choice?.account)];
    return !a || a.id === "default" ? null : a;
  };
  const accountLabel = (p: Pick) => {
    const a = accountOf(p);
    return !a ? null : a.kind === "endpoint" ? a.label : accountDescription(a.label, a.account);
  };
  // The @names the hub will give them (what you @mention them by in the chat).
  const handles = suggestHandles(agents.map((a) => ({ provider: a.provider, accountLabel: accountOf(a)?.label ?? null, given: a.name })));
  const summary = (p: Pick, i: number) =>
    p.choice
      ? [`@${handles[i]}`, accountLabel(p), p.choice.model || "Default model", p.choice.effort ? `${EFFORT_LABELS[p.choice.effort] ?? p.choice.effort} effort` : null].filter(Boolean).join(" · ")
      : defaultsError
        ? "Couldn't read your defaults"
        : "Loading your defaults…";
  const label = (p: Pick, i: number) => `${PROVIDER_INFO[p.provider].name}${agents.filter((x) => x.provider === p.provider).length > 1 ? ` ${agents.filter((x, j) => x.provider === p.provider && j <= i).length}` : ""}`;

  const add = (provider: ChatProvider) => {
    setAdding(false);
    const p = pick(provider, defaults);
    setAgents((list) => [...list, p]);
    setOpen(p.key);
  };
  const remove = (i: number) => {
    setAgents((list) => list.filter((_, j) => j !== i));
    setLead((l) => (l === i ? 0 : l > i ? l - 1 : l));
  };
  const change = (i: number, patch: Partial<Pick>) => setAgents((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const canStart = !busy && !!selected && selected.status === "open" && agents.length >= GROUP_MIN && agents.every((a) => a.choice) && !(folder === OTHER_FOLDER && !path.trim());
  const start = async () => {
    if (!canStart || !selected) return;
    setBusy(true);
    setError("");
    try {
      const body: NewGroupChat = {
        members: agents.map((a) => {
          const c = cleanChoice(a.choice!);
          return { provider: a.provider, account: c.account, model: c.model || null, effort: c.effort || null, permissionMode: c.permissionMode, helperModel: c.helperModel || null, ...(a.name.trim() ? { handle: a.name.trim() } : {}) };
        }),
        answers,
        lead,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(folder === NEW_FOLDER ? {} : { cwd: folder === OTHER_FOLDER ? path.trim() : folder }),
      };
      const room = await api<Room>("POST", "/api/chats/group", body, selected.conn).catch((e) => {
        // A hub from before group chats has no such route.
        if (e instanceof ApiError && e.status === 404 && /^not found$/i.test(e.message)) throw new Error(`${selected.name} runs an older Crosstalk that can't start group chats. Update Crosstalk there, then try again.`);
        throw e;
      });
      // Shown at once, even before the machine's live update for it arrives.
      hubStore(selected.key)?.setState((s) => ({ rooms: { ...s.rooms, [room.id]: s.rooms[room.id] ?? room } }));
      onClose();
      useStore.getState().activate(active);
      openRoom(room.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New group chat"
      icon={<Users size={18} />}
      onClose={onClose}
      dirty={!!name.trim() || agents.length !== 2}
      footer={(requestClose) => (
        <>
          <button className="btn" onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={!canStart}>
            {busy ? "Starting…" : "Start group chat"}
          </button>
        </>
      )}
    >
      <p className="help group-intro">Several agents in one chat. Each reads everything; @name one to hear from just them.</p>
      <label className="field">
        <span>Name</span>
        <input className="input" aria-label="Name" value={name} maxLength={80} placeholder="Optional" autoComplete="off" onChange={(e) => setName(e.target.value)} />
        <span className="help">Without one, it's named from your first message.</span>
      </label>
      {machines.length > 1 && (
        <label className="field">
          <span>Machine</span>
          <select className="select" value={active} onChange={(e) => setActive(e.target.value)}>
            {machines.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
                {m.status === "open" ? "" : " (offline)"}
              </option>
            ))}
          </select>
          <span className="help">{ready.length ? "The agents run on this machine, in its folders." : "No agent is signed in on this machine yet: sign one in from Settings with this machine picked."}</span>
        </label>
      )}

      <div className="field">
        <span>Agents</span>
        <ul className="group-picks" aria-label="Agents in the chat">
          {agents.map((a, i) => (
            <li key={a.key} className={`group-pick ${open === a.key ? "open" : ""}`}>
              <div className="group-pick-head">
                <ProviderAvatar provider={a.provider} size="sm" />
                <button type="button" className="group-pick-main" onClick={() => setOpen(open === a.key ? null : a.key)} aria-expanded={open === a.key} aria-label={`${label(a, i)}: ${summary(a, i)}. ${open === a.key ? "Hide" : "Change"} its settings`}>
                  <span className="group-pick-name">
                    {label(a, i)}
                    {i === lead && <span className="pill">Lead</span>}
                  </span>
                  <span className="group-pick-sub">{summary(a, i)}</span>
                </button>
                <ChevronDown size={16} className={`group-pick-chevron ${open === a.key ? "expanded" : ""}`} aria-hidden="true" />
                <button type="button" className="icon-btn" disabled={agents.length <= GROUP_MIN} onClick={() => remove(i)} aria-label={`Remove ${label(a, i)}`} title={agents.length <= GROUP_MIN ? `A group chat has at least ${GROUP_MIN} agents` : "Remove"}>
                  <X size={16} />
                </button>
              </div>
              {open === a.key && a.choice && (
                <div className="group-pick-options">
                  {ready.length > 1 && (
                    <label className="field">
                      <span>Agent</span>
                      <select className="select" aria-label="Agent" value={a.provider} onChange={(e) => change(i, { provider: e.target.value as ChatProvider, choice: fromDefaults(defaults?.agent[e.target.value as ChatProvider]) })}>
                        {ready.map((p) => (
                          <option key={p} value={p}>
                            {PROVIDER_INFO[p].name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <AgentOptions key={`${active}:${a.provider}`} provider={a.provider} value={a.choice} onChange={(choice) => change(i, { choice })} connection={selected?.conn} accountList={selected?.accounts} />
                  <label className="field">
                    <span>Name in the chat</span>
                    <input className="input" aria-label="Name in the chat" value={a.name} maxLength={28} placeholder={`@${handles[i]}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => change(i, { name: e.target.value.replace(/^@/, "") })} />
                    <span className="help">You @mention it by this to hear from it alone.</span>
                  </label>
                </div>
              )}
            </li>
          ))}
        </ul>
        {defaultsError && (
          <div role="alert" className="defaults-failed">
            <p className="small" style={{ margin: 0, fontWeight: 600 }}>
              Couldn't read your defaults from {selected?.name ?? "this machine"}.
            </p>
            <p className="help" style={{ margin: "2px 0 8px" }}>
              {defaultsError}
            </p>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn small" onClick={loadDefaults}>
                Retry
              </button>
              <button className="btn small ghost" onClick={ownDefaults}>
                Use each agent's own defaults
              </button>
            </div>
          </div>
        )}
        {agents.length < GROUP_MAX && (
          <div className="group-add">
            {adding ? (
              <div className="row wrap" role="group" aria-label="Add which agent?" style={{ gap: 8 }}>
                {(ready.length ? ready : CHAT_PROVIDERS).map((p) => (
                  <button key={p} type="button" className="btn small" onClick={() => add(p)}>
                    <ProviderAvatar provider={p} size="sm" /> {PROVIDER_INFO[p].name}
                  </button>
                ))}
                <button type="button" className="btn small ghost" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="btn small" onClick={() => (ready.length > 1 ? setAdding(true) : add(ready[0] ?? "claude"))}>
                <Plus size={14} /> Add an agent
              </button>
            )}
          </div>
        )}
      </div>

      <div className="field">
        <span>When you @name nobody</span>
        <ChoiceCards label="When you @name nobody" value={answers} onChange={setAnswers} options={ANSWER_OPTIONS.filter((o) => o.id !== "review") as { id: NewGroupChat["answers"]; label: string; help: string }[]} />
      </div>
      <label className="field">
        <span>Lead</span>
        <select className="select" aria-label="Lead" value={lead} onChange={(e) => setLead(Number(e.target.value))}>
          {agents.map((a, i) => (
            <option key={a.key} value={i}>
              {label(a, i)}
            </option>
          ))}
        </select>
        <span className="help">{answers === "turns" ? "Answers first; the others follow in the order above." : "Answers what you send when you @name nobody."}</span>
      </label>
      <FolderPicker
        folder={folder}
        path={path}
        onPick={(f, typed) => {
          setFolder(f);
          if (typed !== undefined) setPath(typed);
        }}
        known={recent}
        conn={selected?.conn ?? null}
        newHelp={`An empty folder in ${selected?.hub?.workspaceRoot ?? "the workspaces folder"}.`}
        pickedHelp="They all work in this folder on the hub."
      />
      {error && (
        <p className="small dup-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
