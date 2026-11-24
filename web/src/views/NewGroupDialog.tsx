import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, Users, X } from "lucide-react";
import { CHAT_PROVIDERS, EFFORT_LABELS, GROUP_MAX, GROUP_MIN, PROVIDER_INFO, type AgentAccount, type AgentDefaults, type ChatProvider, type GroupAnswers, type NewGroupChat, type Room, type RoomDefaults } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { accountKey } from "../accounts";
import { agentReady, hubStore, useMachines, useStore } from "../store";
import { Dialog, ProviderAvatar, ServiceAvatar } from "../ui";
import { groupAgentOptions, hopsOf, leftOutLine, roundsOf, suggestHandles, type GroupAgentOption } from "../groupChat";
import { answeringChoice } from "../newChat";
import { AgentOptions, cleanChoice, type AgentChoice } from "./AgentOptions";
import { cleanHelpersOn } from "./HelpersOn";
import { FolderPicker, NEW_FOLDER, OTHER_FOLDER } from "./FolderPicker";
import { GroupHow } from "./GroupHow";

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
 * for its agent), the one choice of how they work together (with who leads and the rest behind "More"), its name and
 * folder, and with several machines which one it's on. "Add an agent" lists every account that can answer in a group
 * chat, one tap each: an agent here is an account, not "Claude Code or Codex, then go and find its account".
 */
export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const openRoom = useStore((s) => s.openRoom);
  const [active, setActive] = useState(() => useStore.getState().active);
  const machines = useMachines((m) => m.list);
  const selected = machines.find((m) => m.key === active);
  const ready = useMemo(() => CHAT_PROVIDERS.filter((p) => !!selected && agentReady(selected, p)), [selected]);
  const accountList = useMemo<AgentAccount[]>(() => Object.values(selected?.accounts ?? {}), [selected?.accounts]);
  // Every account that can be an agent here, and the services that can't (their agents have no place in a group chat).
  const { options, left } = useMemo(() => groupAgentOptions({ accounts: accountList, providers: selected?.providers ?? {}, machine: machines.length > 1 ? selected?.name ?? null : null }), [accountList, selected?.providers, selected?.name, machines.length]);
  const nextKey = useRef(0);
  /**
   * An agent as it starts: your defaults for it, on an account that can answer (a signed-out main sign-in gives way to
   * another of its accounts, as New chat does), or on the account its row named, whose own models it then starts on.
   */
  const chosen = (provider: ChatProvider, d: RoomDefaults, option?: GroupAgentOption): AgentChoice => {
    const base = fromDefaults(d.agent[provider]);
    if (!option) return answeringChoice(base, provider, accountList, selected?.providers[provider]?.signedIn);
    return option.account === base.account ? base : { ...base, account: option.account, model: option.model ?? "", effort: "", helperModel: "" };
  };
  const pick = (provider: ChatProvider, defaults: RoomDefaults | null, option?: GroupAgentOption): Pick => ({ key: nextKey.current++, provider, choice: defaults ? chosen(provider, defaults, option) : null, name: "" });
  // Claude Code and Codex to start with (two of one agent when only it is ready).
  const firstTwo = (): ChatProvider[] => (ready.length > 1 ? [ready[0], ready[1]] : ready.length ? [ready[0], ready[0]] : ["claude", "codex"]);
  const [defaults, setDefaults] = useState<RoomDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState("");
  const [agents, setAgents] = useState<Pick[]>(() => firstTwo().map((p) => pick(p, null)));
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [answers, setAnswers] = useState<GroupAnswers>("lead");
  const [lead, setLead] = useState(0);
  // Review rounds and working at the same time start as Settings has them; null until you change one here.
  const [roundsPick, setRounds] = useState<number | null>(null);
  const [parallelPick, setParallel] = useState<boolean | null>(null);
  const rounds = roundsPick ?? roundsOf(defaults?.maxHops ?? 5);
  const parallel = parallelPick ?? defaults?.parallel ?? false;
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
        setAgents((list) => list.map((a) => ({ ...a, choice: chosen(a.provider, d) })));
      })
      .catch((e) => id === request.current && setDefaultsError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    setDefaults(null);
    setAgents(firstTwo().map((p) => pick(p, null)));
    setLead(0);
    setAdding(false);
    setRounds(null);
    setParallel(null);
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
    setAgents((list) => list.map((a) => ({ ...a, choice: chosen(a.provider, none) })));
  };

  const recent = useMemo(
    () => [...new Set(Object.values(selected?.rooms ?? {}).filter((r) => r.chat).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => r.cwd).filter((f) => f && !/^\/(private\/)?tmp\b/.test(f)))].slice(0, 8),
    [selected?.rooms],
  );
  // The account an agent runs on, as "Add an agent" lists it: a service of yours goes by its own name and avatar.
  const optionOf = (p: Pick) => options.find((o) => o.provider === p.provider && o.account === (p.choice?.account ?? "default"));
  const accountOf = (p: Pick) => {
    const a = selected?.accounts[accountKey(p.provider, p.choice?.account)];
    return !a || a.id === "default" ? null : a;
  };
  // The @names the hub will give them (what you @mention them by in the chat).
  const handles = suggestHandles(agents.map((a) => ({ provider: a.provider, accountLabel: accountOf(a)?.label ?? null, given: a.name })));
  const titleOf = (p: Pick) => optionOf(p)?.title ?? PROVIDER_INFO[p.provider].name;
  // Two of the same get a number, so each row (and its Remove) has a name of its own.
  const label = (p: Pick, i: number) => {
    const title = titleOf(p);
    return `${title}${agents.filter((x) => titleOf(x) === title).length > 1 ? ` ${agents.filter((x, j) => titleOf(x) === title && j <= i).length}` : ""}`;
  };
  const summary = (p: Pick, i: number) =>
    p.choice
      ? [`@${handles[i]}`, p.choice.model || "Default model", p.choice.effort ? `${EFFORT_LABELS[p.choice.effort] ?? p.choice.effort} effort` : null, optionOf(p)?.where ? `with ${PROVIDER_INFO[p.provider].name}` : null, optionOf(p)?.why ?? null].filter(Boolean).join(" · ")
      : defaultsError
        ? "Couldn't read your defaults"
        : "Loading your defaults…";

  const add = (o: GroupAgentOption) => {
    setAdding(false);
    setAgents((list) => [...list, pick(o.provider, defaults, o)]);
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
          return { provider: a.provider, account: c.account, model: c.model || null, effort: c.effort || null, permissionMode: c.permissionMode, helperModel: c.helperModel || null, ...(c.helpers !== undefined ? { helpers: cleanHelpersOn(c.helpers) } : {}), ...(a.name.trim() ? { handle: a.name.trim() } : {}) };
        }),
        answers,
        lead,
        // Only what was changed here goes: the rest is what Settings says a new chat starts with, on that machine.
        ...(answers === "review" && roundsPick !== null ? { rounds } : {}),
        ...(parallelPick !== null ? { parallel } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(folder === NEW_FOLDER ? {} : { cwd: folder === OTHER_FOLDER ? path.trim() : folder }),
      };
      const room = await api<Room>("POST", "/api/chats/group", body, selected.conn).catch((e) => {
        // A hub from before group chats has no such route.
        if (e instanceof ApiError && e.status === 404 && /^not found$/i.test(e.message)) throw new Error(`${selected.name} runs an older Crosstalk that can't start group chats. Update Crosstalk there, then try again.`);
        // One from before a group chat could start with a review knows only the other two.
        if (e instanceof ApiError && e.status === 400 && answers === "review" && /^Say who answers/i.test(e.message)) throw new Error(`${selected.name} runs an older Crosstalk that can't start a group chat with a review. Pick another way to work together and switch to this one in the chat's settings, or update Crosstalk there.`);
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
      dirty={!!name.trim() || agents.length !== 2 || answers !== "lead"}
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
          {agents.map((a, i) => {
            const o = optionOf(a);
            return (
              <li key={a.key} className={`group-pick ${open === a.key ? "open" : ""}`}>
                <div className="group-pick-head">
                  {o?.where ? <ServiceAvatar where={o.where} size="sm" label={o.title} /> : <ProviderAvatar provider={a.provider} size="sm" />}
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
                    <AgentOptions key={`${active}:${a.provider}`} provider={a.provider} value={a.choice} onChange={(choice) => change(i, { choice })} connection={selected?.conn} accountList={selected?.accounts} helpersOn />
                    <label className="field">
                      <span>Name in the chat</span>
                      <input className="input" aria-label="Name in the chat" value={a.name} maxLength={28} placeholder={`@${handles[i]}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => change(i, { name: e.target.value.replace(/^@/, "") })} />
                      <span className="help">You @mention it by this to hear from it alone.</span>
                    </label>
                  </div>
                )}
              </li>
            );
          })}
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
        {agents.length < GROUP_MAX ? (
          <div className="group-add">
            <button type="button" className="btn small" onClick={() => setAdding(!adding)} aria-expanded={adding} disabled={!defaults}>
              <Plus size={14} /> Add an agent
            </button>
            {adding && (
              // In the page, not over it: every account that can answer here, one tap each. It closes on a pick, or on the button again.
              <ul className="group-add-list" aria-label="Add which agent?">
                {options.map((o) => (
                  <li key={o.id}>
                    <button type="button" className="group-add-row" disabled={!!o.why} onClick={() => add(o)} aria-label={`Add ${o.title}: ${o.why ?? o.help}`}>
                      {o.where ? <ServiceAvatar where={o.where} size="sm" label={o.title} /> : <ProviderAvatar provider={o.provider} size="sm" />}
                      <span className="group-add-text">
                        <span className="group-add-title">{o.title}</span>
                        <span className="group-add-help">{o.why ?? o.help}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {adding && leftOutLine(left) && <p className="help group-left-out">{leftOutLine(left)}</p>}
          </div>
        ) : (
          <p className="help group-add">A group chat has at most {GROUP_MAX} agents.</p>
        )}
      </div>

      <GroupHow
        answers={answers}
        onAnswers={setAnswers}
        leads={agents.map((a, i) => ({ id: String(i), label: label(a, i), handle: handles[i] }))}
        lead={String(lead)}
        onLead={(id) => setLead(Number(id))}
        rounds={rounds}
        onRounds={setRounds}
        parallel={parallel}
        onParallel={setParallel}
      />
      <FolderPicker
        folder={folder}
        path={path}
        onPick={(f, typed) => {
          setFolder(f);
          if (typed !== undefined) setPath(typed);
        }}
        known={recent}
        conn={selected?.conn ?? null}
        newHelp={`An empty folder in ${selected?.hub?.workspaceRoot ?? "Crosstalk's chats folder"}.`}
        pickedHelp={`They all work in this folder on ${selected?.name ?? "this machine"}.`}
      />
      {error && (
        <p className="small dup-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
