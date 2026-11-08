import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Copy, ShieldAlert, Square } from "lucide-react";
import { CHAT_PROVIDERS, DEFAULT_ACCOUNT, PROVIDER_INFO, type AgentAccount, type ChatExport, type ChatProvider, type Member, type Room, type RoomDefaults } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { accountKey, memberAccount } from "../accounts";
import { hubStore, machineOfRoom, pendingApprovals, useMachines, useStore, type Machine } from "../store";
import { ChoiceCards, Dialog, ProviderAvatar } from "../ui";
import { AgentOptions, cleanChoice, type AgentChoice } from "./AgentOptions";
import { GroupAvatar } from "./GroupAvatar";

/** The group chat copy's own choice: its agents, on its machine. */
const GROUP = "__group__";

/** One place a copy can go: one of an agent's accounts on one of the machines. */
export interface Destination {
  key: string;
  machine: Machine;
  provider: ChatProvider;
  account: string;
  /** "Claude Code", "Codex", or the account's name (a custom model's, an API key's, another sign-in's). */
  label: string;
  /** What it is: who it's signed in as, a custom model, an API key. */
  detail: string;
  /** Why it can't be picked, when it can't. */
  why: string | null;
}

const KIND_ORDER: Record<string, number> = { endpoint: 0, apikey: 1, signin: 2 };

/**
 * Every agent and account a copy can go to, machine by machine: each agent's own sign-in, then custom models, then
 * its other accounts. Ones that aren't installed or signed in are listed, with why they can't be picked.
 */
export function destinations(machines: Machine[]): Destination[] {
  const out: Destination[] = [];
  for (const m of machines) {
    const away = m.status !== "open" || !m.hub ? "Not connected" : null;
    const missing = (p: ChatProvider) => away ?? (m.providers[p]?.installed ? null : "Not installed");
    for (const p of CHAT_PROVIDERS) {
      const own = m.accounts[accountKey(p, DEFAULT_ACCOUNT)];
      const signedIn = own ? own.signedIn : m.providers[p]?.signedIn;
      out.push({ key: `${m.key}|${p}|${DEFAULT_ACCOUNT}`, machine: m, provider: p, account: DEFAULT_ACCOUNT, label: PROVIDER_INFO[p].name, detail: own?.account ?? PROVIDER_INFO[p].vendor, why: missing(p) ?? (signedIn === false ? "Not signed in" : null) });
    }
    const others = Object.values(m.accounts)
      .filter((a): a is AgentAccount & { provider: ChatProvider } => CHAT_PROVIDERS.includes(a.provider as ChatProvider) && a.id !== DEFAULT_ACCOUNT)
      .sort((a, b) => (KIND_ORDER[a.kind ?? "signin"] ?? 2) - (KIND_ORDER[b.kind ?? "signin"] ?? 2) || a.label.localeCompare(b.label));
    for (const a of others) {
      const name = PROVIDER_INFO[a.provider].name;
      const detail = a.kind === "endpoint" ? `Custom model · ${name}` : a.kind === "apikey" ? `API key, billed per use · ${name}` : `${name}${a.account ? ` · ${a.account}` : ""}`;
      out.push({ key: `${m.key}|${a.provider}|${a.id}`, machine: m, provider: a.provider, account: a.id, label: a.label, detail, why: missing(a.provider) ?? (a.signedIn === false ? "Not signed in" : null) });
    }
  }
  return out;
}

/** Writing a reply (or about to): Duplicate waits for it. Waiting for your answer to a request ("approval") isn't. */
const WORKING = ["thinking", "working", "queued"];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A hub from before Duplicate chat answers its routes with "not found". */
const older = (machine: string) => (e: unknown): never => {
  if (e instanceof ApiError && e.status === 404 && /^not found$/i.test(e.message)) throw new Error(`${machine} runs an older Crosstalk that can't duplicate chats. Update Crosstalk there, then try again.`);
  throw e;
};

/**
 * Duplicate chat: where the copy goes (any agent or account, on any machine), how its agent runs (the same as this
 * chat for the same agent and account, otherwise that agent's defaults, always shown), its folder and its name.
 * The same agent and account on this machine remember what this chat's agent remembers; any other reads it first.
 * Waits for the agent to finish a reply it's writing; one waiting for your answer to a request needs that answer first.
 * A group chat (`members`) is copied with all its agents on this machine (each remembers what it remembers), or to one
 * agent anywhere, which reads it first.
 */
export function DuplicateDialog({ room, member, members, onClose }: { room: Room; member: Member; members?: Member[]; onClose: () => void }) {
  const machines = useMachines((m) => m.list);
  const toast = useStore((s) => s.toast);
  const sourceKey = useMemo(() => machineOfRoom(room.id) ?? useStore.getState().active, [room.id]);
  const source = machines.find((m) => m.key === sourceKey);
  const multi = machines.length > 1;
  const own = { provider: member.provider as ChatProvider, account: memberAccount(member) };
  const ownKey = `${sourceKey}|${own.provider}|${own.account}`;
  // This chat's machine first.
  const list = useMemo(() => destinations([...machines].sort((a, b) => Number(b.key === sourceKey) - Number(a.key === sourceKey))), [machines, sourceKey]);
  const group = !!members;
  // A group chat's copy: these agents, on this machine (GROUP), unless one agent is picked.
  const [pick, setPick] = useState(() => (group ? GROUP : (list.find((d) => d.key === ownKey && !d.why) ?? list.find((d) => !d.why))?.key ?? ownKey));
  const asGroup = group && pick === GROUP;
  const target = asGroup ? undefined : list.find((d) => d.key === pick);
  const sameMachine = asGroup || (!!target && target.machine.key === sourceKey);
  const sameAgent = !group && sameMachine && !!target && target.provider === own.provider && target.account === own.account;
  const agentName = target ? (target.account === DEFAULT_ACCOUNT ? PROVIDER_INFO[target.provider].name : target.label) : "";
  const ownName = group ? "An agent here" : PROVIDER_INFO[own.provider].name;

  // How its agent runs: this chat's settings for the same agent and account, else that agent's defaults there.
  const [choice, setChoice] = useState<{ key: string; value: AgentChoice; note?: string } | null>(null);
  const [catalog, setCatalog] = useState<string | null>(null);
  useEffect(() => {
    setCatalog(null);
    if (!target) return setChoice(null);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    if (sameAgent) {
      setChoice({ key: target.key, value: { account: own.account, model: member.model ?? "", effort: str(member.config?.effort), helperModel: str(member.config?.helperModel), permissionMode: member.permissionMode } });
      return;
    }
    let live = true;
    setChoice(null);
    api<RoomDefaults>("GET", "/api/settings/defaults", undefined, target.machine.conn)
      .then((d) => {
        if (!live) return;
        const a = d.agent[target.provider];
        // Defaults made for another account may name models this one doesn't have: its own defaults then.
        const fits = (a?.account ?? DEFAULT_ACCOUNT) === target.account;
        setChoice({ key: target.key, value: { account: target.account, model: fits ? a?.model ?? "" : "", effort: fits ? a?.effort ?? "" : "", helperModel: fits ? a?.helperModel ?? "" : "", permissionMode: a?.permissionMode ?? "ask" } });
      })
      .catch((e) => live && setChoice({ key: target.key, value: { account: target.account, model: "", effort: "", helperModel: "", permissionMode: "ask" }, note: `Couldn't read the defaults (${errorText(e)}): these are ${agentName}'s own.` }));
    return () => {
      live = false;
    };
  }, [pick, target?.machine.conn.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const [folder, setFolder] = useState<"same" | "new">("same");
  const defaultName = `${room.name.slice(0, 73)} (copy)`;
  const [name, setName] = useState(defaultName);
  // A request of its agent waits for your answer (its card is in the chat, under this popup): the reply can't finish
  // until it's answered, so Duplicate doesn't wait for it.
  const requests = useStore(useShallow((s) => pendingApprovals(s, room.id)));
  const all = members ?? [member];
  const asking = all.some((m) => m.status === "approval") || requests.length > 0;
  const working = !asking && all.some((m) => WORKING.includes(m.status));
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (asking) setWaiting(false);
  }, [asking]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // An error shows next to the button that retries it, in view.
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  const ready = asGroup || (!!target && !target.why && !!choice && choice.key === target.key && catalog === target.key);

  const go = async () => {
    if (asGroup) return goGroup();
    if (!target || !choice) return;
    setSending(true);
    setError("");
    try {
      const c = cleanChoice(choice.value);
      const body = { provider: target.provider, account: target.account, model: c.model || null, effort: c.effort || null, helperModel: c.helperModel && c.helperModel !== c.model ? c.helperModel : null, folder: sameMachine ? folder : "new", name: name.trim() || defaultName };
      let copy: Room;
      if (sameMachine) copy = await api<Room>("POST", `/api/chats/${room.id}/duplicate`, body, source?.conn).catch(older(source?.name ?? "This machine"));
      else {
        // Another machine: read this chat here, have that machine's hub make the copy, then link to it from here.
        const from = await api<ChatExport>("GET", `/api/chats/${room.id}/export`, undefined, source?.conn).catch(older(source?.name ?? "This machine"));
        copy = await api<Room>("POST", "/api/chats/duplicate", { ...body, from }, target.machine.conn).catch(older(target.machine.name));
        await api("POST", `/api/chats/${room.id}/duplicated`, { chatId: copy.id, chatName: copy.name, machine: target.machine.name, agent: agentName, provider: target.provider }, source?.conn).catch((e) =>
          toast("warn", `The copy is ready, but this chat couldn't link to it: ${errorText(e)}`),
        );
      }
      // Shown at once, even before its machine's live update for it arrives.
      hubStore(target.machine.key)?.setState((s) => ({ rooms: { ...s.rooms, [copy.id]: s.rooms[copy.id] ?? copy } }));
      onClose();
      useStore.getState().activate(target.machine.key);
      useStore.getState().openRoom(copy.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  /** The same agents, on this machine: each forks its own conversation (or reads it first). */
  const goGroup = async () => {
    setSending(true);
    setError("");
    try {
      const copy = await api<Room>("POST", `/api/chats/${room.id}/duplicate`, { group: true, folder, name: name.trim() || defaultName }, source?.conn).catch(older(source?.name ?? "This machine"));
      hubStore(sourceKey)?.setState((s) => ({ rooms: { ...s.rooms, [copy.id]: s.rooms[copy.id] ?? copy } }));
      onClose();
      useStore.getState().openRoom(copy.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  // "Duplicate" pressed while the agent was working: it goes once the reply is done (and the settings shown are in).
  const goLater = useRef(go);
  goLater.current = go;
  useEffect(() => {
    if (!waiting || working || !ready) return;
    setWaiting(false);
    void goLater.current();
  }, [waiting, working, ready]);

  const stop = async () => {
    try {
      await api("POST", `/api/rooms/${room.id}/stop`, {}, source?.conn);
    } catch (e) {
      setError(errorText(e));
    }
  };
  // The popup goes, and the chat shows the request's card, ready to answer.
  const showRequest = () => {
    const id = requests[0]?.id;
    onClose();
    requestAnimationFrame(() => {
      const card = (id && document.querySelector<HTMLElement>(`.messages [data-approval="${CSS.escape(id)}"]`)) || document.querySelector<HTMLElement>(".messages .approval:not(.done)");
      card?.scrollIntoView({ block: "center" });
      card?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    });
  };

  const groups = (multi ? machines.filter((m) => list.some((d) => d.machine.key === m.key)) : machines.slice(0, 1)).sort((a, b) => Number(b.key === sourceKey) - Number(a.key === sourceKey));
  return (
    <Dialog
      title="Duplicate chat"
      icon={<Copy size={18} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready || sending || waiting || asking} onClick={() => (working ? setWaiting(true) : void go())}>
            {sending ? "Duplicating…" : waiting ? "Waiting…" : "Duplicate"}
          </button>
        </>
      }
    >
      {asking && (
        <div className="card dup-busy" role="status">
          <p className="small">{ownName} is waiting for your answer to its request in this chat. Answer it or stop it, then duplicate.</p>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn small primary" onClick={showRequest}>
              <ShieldAlert size={13} /> Show the request
            </button>
            <button className="btn small" onClick={stop}>
              <Square size={12} /> {group ? "Stop the agents" : `Stop ${ownName}`}
            </button>
          </div>
        </div>
      )}
      {working && (
        <div className="card dup-busy" role="status">
          <p className="small">{waiting ? `Waiting for ${group ? "the agents" : ownName} to finish, then duplicating.` : `${ownName} is working. Duplicate waits for it to finish, or stop it first.`}</p>
          <button className="btn small" onClick={stop}>
            <Square size={12} /> {group ? "Stop the agents" : `Stop ${ownName}`}
          </button>
        </div>
      )}
      <div className="field">
        <span>Where the copy goes</span>
        <div className="choice-cards dup-dests" role="radiogroup" aria-label="Where the copy goes">
          {group && (
            <button
              type="button"
              role="radio"
              aria-checked={asGroup}
              aria-label={`These agents, on ${source?.name ?? "this machine"}: ${members!.map((m) => `@${m.handle}`).join(", ")}`}
              className={`choice-card dup-dest ${asGroup ? "on" : ""}`}
              onClick={() => {
                setPick(GROUP);
                setError("");
              }}
            >
              <GroupAvatar members={members!} size="sm" />
              <span className="dup-dest-text">
                <span className="choice-card-title">
                  These agents
                  <span className="pill">This chat's</span>
                </span>
                <span className="choice-card-help">{members!.map((m) => `@${m.handle}`).join(", ")}{multi ? ` · on ${source?.name ?? "this machine"}` : ""}</span>
              </span>
            </button>
          )}
          {groups.map((m) => (
            <div key={m.key} className="dup-machine" role="presentation">
              {multi && (
                <div className="dup-machine-name">
                  {m.name}
                  {m.key === sourceKey ? <span className="muted"> · this chat's machine</span> : null}
                </div>
              )}
              {list
                .filter((d) => d.machine.key === m.key)
                .map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    role="radio"
                    aria-checked={pick === d.key}
                    aria-label={`${d.label}${multi ? ` on ${m.name}` : ""}: ${d.why ?? d.detail}`}
                    disabled={!!d.why}
                    className={`choice-card dup-dest ${pick === d.key ? "on" : ""}`}
                    onClick={() => {
                      setPick(d.key);
                      setError("");
                    }}
                  >
                    <ProviderAvatar provider={d.provider} size="sm" />
                    <span className="dup-dest-text">
                      <span className="choice-card-title">
                        {d.label}
                        {!group && d.key === ownKey && <span className="pill">This chat's</span>}
                      </span>
                      <span className="choice-card-help">{d.why ?? d.detail}</span>
                    </span>
                  </button>
                ))}
            </div>
          ))}
        </div>
        {asGroup && <span className="help">Each agent remembers what it remembers in this chat, and answers the same way there.</span>}
        {target && <span className="help">{sameAgent ? `It remembers what ${ownName} remembers in this chat.` : `${agentName} reads this conversation (your messages and the replies, without the steps) with your first message there.`}</span>}
      </div>

      {asGroup ? null : target && choice?.key === target.key ? (
        <>
          <p className="help dup-settings-note">{choice.note ?? (sameAgent ? "Model, effort and helper agents: as in this chat." : `Model, effort and helper agents: ${agentName}'s defaults${multi ? ` on ${target.machine.name}` : ""}.`)}</p>
          <AgentOptions
            key={target.key}
            provider={target.provider}
            value={choice.value}
            onChange={(value) => setChoice((cur) => (cur ? { ...cur, value } : cur))}
            showAccount={false}
            showPermissions={false}
            connection={target.machine.conn}
            accountList={target.machine.accounts}
            onCatalog={() => setCatalog(target.key)}
          />
        </>
      ) : (
        target && <p className="muted small">Loading {agentName}'s settings…</p>
      )}

      <div className="field">
        <span>Folder</span>
        {sameMachine ? (
          <ChoiceCards
            label="Folder"
            value={folder}
            onChange={setFolder}
            options={[
              { id: "same", label: "This chat's folder", help: room.cwd },
              { id: "new", label: "A new empty folder", help: `In ${target?.machine.hub?.workspaceRoot ?? "the workspaces folder"}. The files here don't come along.` },
            ]}
          />
        ) : (
          <ChoiceCards label="Folder" value="new" onChange={() => {}} options={[{ id: "new", label: "A new empty folder", help: `On ${target?.machine.name ?? "that machine"}. The files stay on ${source?.name ?? "this machine"}.` }]} />
        )}
      </div>

      <label className="field">
        <span>Name</span>
        <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>

      {error && (
        <p ref={errorRef} className="small dup-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
