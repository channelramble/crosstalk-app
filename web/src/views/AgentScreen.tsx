import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Laptop, Plus, RefreshCw, Settings } from "lucide-react";
import { PROVIDER_INFO, isServiceOnlyAgent, slugHandle, type ChatProvider, type ServiceAgent, type LocalSession, type PromptTemplate, type Room, type RoomDefaults } from "@crosstalk/shared";
import { agentReady, usesApiKey, useMachines, useStore } from "../store";
import { MachinePicker, useMachineName } from "./MachinePicker";
import { accountKey } from "../accounts";
import { serviceWhere, serviceWhereWords } from "../chatIdentity";
import { showInSettings } from "../navigation";
import { agentStarters, serverModelOptions, targetChoice, type NewChatTarget } from "../newChat";
import { poolAgents, poolWhereWords } from "../poolChat";
import { StarterList, useChatStarters } from "./NewChatMenu";
import { agentCanRun, noDot, openCodeUnusable, routeMissing } from "../services";
import { api, ApiError } from "../api";
import { UsageLine } from "./HomeScreen";
import { ApiBadge, Dialog, ProviderAvatar, ServiceAvatar, timeAgo } from "../ui";
import { AgentOptions, cleanChoice, type AgentChoice } from "./AgentOptions";
import { SidebarButton } from "./ChatSidebar";
import { useSidebar } from "../sidebar";
import { TemplatePick, type Picked } from "./TemplatePick";
import { emptyBlanks, fillBlanks, parsePick, templateGroups, templateNote, withTemplate, type TemplateHere } from "../templates";
import { sendFirstMessage } from "../templateApi";
import { AgentSignInButton } from "./AgentSignInButton";
import { FolderPicker, NEW_FOLDER, OTHER_FOLDER } from "./FolderPicker";


const SOURCE: Record<LocalSession["source"], string> = { "claude-app": "Claude app", "claude-cli": "Terminal", "codex-app": "Codex app" };

const folderName = (p: string | null) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : "");

/** One agent: start a chat, pick up one of your chats, or continue a conversation from the agent's own app. */
export function AgentScreen({ provider }: { provider: ChatProvider }) {
  const info = PROVIDER_INFO[provider];
  const setView = useStore((s) => s.setView);
  const openRoom = useStore((s) => s.openRoom);
  const toast = useStore((s) => s.toast);
  const status = useStore((s) => s.providers[provider]);
  const signedIn = useStore((s) => Object.values(s.accounts).some((a) => a.provider === provider && a.signedIn)) || !!status?.signedIn;
  // Its chats with one agent (a group chat with it is listed with the group chats).
  const chats = useStore(useShallow((s) => Object.values(s.rooms).filter((r) => r.chat?.provider === provider && !r.chat.group).sort((a, b) => b.updatedAt - a.updatedAt)));
  const members = useStore((s) => s.members);
  // Where the agent's own app sessions live: the machine this screen shows.
  const machine = useMachineName();
  const [local, setLocal] = useState<LocalSession[] | null>(null);
  const [localError, setLocalError] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  // Its own AI services (its endpoint accounts), the servers running here that would be added under it, and the model
  // pool, which either agent can drive (newChat.ts agentStarters).
  const starters = useChatStarters();
  const mine = agentStarters(starters.yours, provider);
  const [opening, setOpening] = useState<string | null>(null);
  /** A New chat dialog opened for one of this agent's services, or a server to add first. */
  const [startOn, setStartOn] = useState<NewChatTarget | null>(null);

  const loadLocal = async () => {
    setLoading(true);
    setLocalError("");
    try {
      setLocal(await api<LocalSession[]>("GET", `/api/chats/local?provider=${provider}`));
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setLocal(null);
    void loadLocal();
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (s: LocalSession) => {
    if (s.busy && provider === "claude" && !confirm("This conversation is open in the Claude app right now. You can read it here; to keep going here, close it in the Claude app, or duplicate it from the chat's settings.")) return;
    setOpening(s.id);
    try {
      const room = await api<Room>("POST", "/api/chats/open", { provider, id: s.id });
      openRoom(room.id);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  const fromMac = (local ?? []).filter((s) => !s.chatId);
  const apiChats = useStore(useShallow((s) => chats.filter((r) => usesApiKey(r.id)(s)).map((r) => r.id)));
  const apiSet = new Set(apiChats);
  const busyIn = (r: Room) => Object.values(members).find((m) => m.roomId === r.id && ["thinking", "working", "approval", "queued"].includes(m.status));
  const ready = status?.installed && signedIn;
  const usage = useStore((s) => s.usage[accountKey(provider, "default")]);
  const windows = (usage?.windows ?? []).filter((w) => w.usedPercent !== null).slice(0, 2);

  return (
    <>
      <header className="topbar tinted" style={{ ["--c" as string]: info.color }} data-tauri-drag-region>
        <SidebarButton />
        <div className="titles" />
        <MachinePicker />
        <button className="icon-btn" onClick={() => setView("settings")} aria-label="Settings" title="Settings">
          <Settings size={20} />
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          <section className="agent-hero" style={{ ["--c" as string]: info.color }} aria-label={info.name}>
            <div className="row" style={{ gap: 14 }}>
              <ProviderAvatar provider={provider} size="lg" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="agent-card-name">{info.name}</div>
                <div className="muted small">
                  {info.vendor}
                  {usage?.plan ? ` · ${usage.plan}` : ""}
                </div>
              </div>
            </div>
            {windows.length > 0 && (
              <div className="agent-card-usage">
                {windows.map((w) => (
                  <UsageLine key={w.label} w={w} />
                ))}
              </div>
            )}
            {!ready && status?.checkedAt ? (
              <div role="note">
                <p className="small" style={{ margin: "0 0 10px" }}>
                  {status.installed ? `${info.name} needs your sign-in before it can chat. It takes a minute, from this device.` : `${info.name} isn't installed on the hub yet.`}
                </p>
                <AgentSignInButton provider={provider} />
              </div>
            ) : (
              <button className="btn primary large block" onClick={() => setCreating(true)} disabled={!ready}>
                <Plus size={18} /> New chat
              </button>
            )}
          </section>

          {/* The model pool's own dialog is drawn by the app around the list (it can start the pool first), as it is for
              Home and the New chat menu; everything else opens here. */}
          <StarterList rows={mine} onPick={(t) => (t.kind === "pool" ? useSidebar.getState().setCreating(t) : setStartOn(t))} title={`Models on ${info.name}`} help={`${info.name} can run these instead of its own models. A server found running here is added first.`} />

          <section style={{ marginTop: 20 }} aria-label="Your chats">
            <h3 className="section-title">Chats</h3>
            {chats.length === 0 ? (
              <p className="muted small">No chats with {info.name} yet.</p>
            ) : (
              <div className="list-group">
                {chats.map((r) => {
                  const busy = busyIn(r);
                  return (
                    <div key={r.id} className="list-row" role="button" tabIndex={0} onClick={() => openRoom(r.id)} onKeyDown={(e) => e.key === "Enter" && openRoom(r.id)}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="title ellipsis">
                          {r.name} {apiSet.has(r.id) && <ApiBadge />}
                        </div>
                        <div className="subtitle ellipsis">
                          {folderName(r.cwd)} · {timeAgo(r.updatedAt)}
                          {r.chat && r.chat.origin !== "web" ? ` · from the ${SOURCE[r.chat.origin]}` : ""}
                        </div>
                      </div>
                      {busy && <span className={`pill ${busy.status === "approval" ? "orange" : "blue"}`}>{busy.status === "approval" ? "Needs you" : busy.status === "queued" ? "Queued" : "Working"}</span>}
                      <ChevronRight size={18} className="muted" />
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section style={{ marginTop: 22 }} aria-label={`${info.name} on ${machine}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 className="section-title" style={{ margin: 0 }}>
                <Laptop size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
                On {machine}
              </h3>
              <button className="btn small ghost" onClick={loadLocal} disabled={loading} aria-label="Refresh">
                <RefreshCw size={13} className={loading ? "spin" : ""} />
              </button>
            </div>
            <p className="help" style={{ margin: "4px 0 8px" }}>
              {provider === "claude" ? `Sessions from the Claude app and the claude command on ${machine}.` : `Threads from the Codex app, CLI and IDE on ${machine}.`} Open one to continue it here.
            </p>
            {localError && (
              <div role="alert" className="small">
                <p style={{ color: "var(--red)" }}>{localError}</p>
                <button className="btn small" onClick={loadLocal}>
                  Retry
                </button>
              </div>
            )}
            {!local && !localError && <p className="muted small">Looking…</p>}
            {local && fromMac.length === 0 && <p className="muted small">Nothing new there.</p>}
            {fromMac.length > 0 && (
              <div className="list-group">
                {fromMac.map((s) => (
                  <div key={s.id} className="list-row" role="button" tabIndex={0} aria-busy={opening === s.id} onClick={() => !opening && open(s)} onKeyDown={(e) => e.key === "Enter" && !opening && open(s)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="title ellipsis">{s.title}</div>
                      <div className="subtitle ellipsis">
                        {SOURCE[s.source]} · {folderName(s.cwd)} · {timeAgo(s.updatedAt)}
                      </div>
                    </div>
                    {s.busy && <span className="pill orange">{provider === "claude" ? "Open in app" : "Working"}</span>}
                    {opening === s.id ? <RefreshCw size={16} className="spin muted" /> : <ChevronRight size={18} className="muted" />}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      {creating && <NewChatDialog target={{ kind: "agent", provider }} folders={[...chats.map((c) => c.cwd), ...(local ?? []).map((s) => s.cwd ?? "")]} onClose={() => setCreating(false)} />}
      {startOn && <NewChatDialog target={startOn} folders={[...chats.map((c) => c.cwd), ...(local ?? []).map((s) => s.cwd ?? "")]} onClose={() => setStartOn(null)} />}
    </>
  );
}


/**
 * Starts a chat on what the New chat menu was tapped for: an agent, an AI service of yours, or a model server running on
 * this machine that isn't added yet (that one is added first, with the same checks Settings → AI services runs).
 * With several machines it asks which one: picking one switches the app to it, so the folders, models and defaults
 * offered are that machine's. A service lives on one machine, so a chat on one stays there. From a template
 * (TemplatePick.tsx) it's filled in from one: its machine, agent, account, model, effort and folder, and the first
 * message, whose blanks it asks for. That message goes once the chat is made.
 */
export function NewChatDialog({ target, folders = [], onClose }: { target: NewChatTarget; folders?: string[]; onClose: () => void }) {
  const server = target.kind === "server" ? target : null;
  const pool = target.kind === "pool" ? target : null;
  const provider = target.kind === "group" ? "claude" : target.provider;
  // The one it was opened for, or a template's.
  const [agent, setAgent] = useState<ServiceAgent>(provider);
  // A service of yours, or a server to add first: either fixes the agent and the account, so the chat is that service's.
  // The model pool keeps an account per agent — the same model on the same machines — so its account follows the agent
  // picked below, and the chat is the pool's either way.
  const service: Extract<NewChatTarget, { kind: "service" }> | null =
    target.kind === "service"
      ? target
      : pool
        ? { kind: "service", provider: agent, account: pool.offer.accounts[agent] ?? "", model: pool.offer.model, label: pool.offer.label, ...(pool.machine !== undefined ? { machine: pool.machine } : {}) }
        : null;
  const info = PROVIDER_INFO[agent];
  const openRoom = useStore((s) => s.openRoom);
  const toast = useStore((s) => s.toast);
  const [active, setActive] = useState(() => service?.machine ?? useStore.getState().active);
  const machines = useMachines((m) => m.list);
  const selected = machines.find((m) => m.key === active);
  /** Which agents can drive the pool's model: the ones it has an account for, the ones installed here first. */
  const poolAgentList = pool ? poolAgents(pool.offer, { claude: selected?.providers.claude?.installed, codex: selected?.providers.codex?.installed }) : [];
  const hub = selected?.hub;
  // Crosstalk's own agent and OpenCode have nothing to sign in to: the first is part of the hub, the second has to be installed.
  const onlyOnServices = isServiceOnlyAgent(agent);
  const ready = !!selected && (onlyOnServices ? agentCanRun(agent, selected.providers[agent]) : agentReady(selected, agent));
  // On the machine and still no use (a version 1, say): the hub's words for it stand in for "isn't installed" below.
  const unusable = openCodeUnusable(agent, selected?.providers[agent]);
  const chatFolders = useMemo(() => Object.values(selected?.rooms ?? {}).filter((r) => r.chat?.provider === agent).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => r.cwd), [selected?.rooms, agent]);
  const [choice, setChoice] = useState<AgentChoice | null>(null);
  // Your saved defaults couldn't be read: nothing is guessed in their place (a chat would quietly run on another model).
  const [defaultsError, setDefaultsError] = useState("");
  const [folder, setFolder] = useState(NEW_FOLDER);
  const [path, setPath] = useState("");
  // Its name, if you give one (kept when the machine changes); without one, its first message names it.
  const [name, setName] = useState("");
  const named = name.replace(/\s+/g, " ").trim();
  // Whether a new folder is named after it, as the hub does it (chats.ts): not for "New chat", the stand-in its first
  // message replaces, nor for a name with no Latin letters or digits (slugHandle leaves just "a-"). Those are dated.
  const namesFolder = !!named && named !== "New chat" && slugHandle(named) !== "a-";
  const [busy, setBusy] = useState(false);
  /** Adding the server, or making the chat, went wrong: said here with a way out, not in a toast that slips away. */
  const [startError, setStartError] = useState("");
  // The service account this chat will run as, on the machine picked (a service added on another machine isn't here).
  const account = service ? selected?.accounts[accountKey(service.provider, service.account)] : undefined;
  // What the chat will be: the service's name and avatar, or the agent's. A service of yours is what the chat is called,
  // so New chat says the same thing the chat itself will.
  const where = server ? ("local" as const) : pool ? ("pool" as const) : account ? serviceWhere(account) : null;
  const shownName = server ? server.label : pool ? pool.offer.label : service ? account?.label ?? service.label ?? "this service" : info.name;
  // Recent project folders on this machine, newest first, without the throwaway temp ones.
  const recent = useMemo(() => [...new Set([...chatFolders, ...(active === useStore.getState().active ? folders : [])].filter((f) => f && !/^\/(private\/)?tmp\b/.test(f)))].slice(0, 8), [chatFolders, folders]);

  // From a template: every machine's, the one picked (as it was then), its first message and what its blanks are filled with.
  const groups = useMemo(() => templateGroups(machines), [machines]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [message, setMessage] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  // Read by answers that belong to an earlier render (the defaults come after a pick): the pick, and your defaults.
  const pickedNow = useRef<Picked | null>(null);
  const defaultsNow = useRef<AgentChoice | null>(null);
  /** The machine picked, as a template from `machine` goes on it (templates.ts withTemplate). */
  const here = (machine: string): TemplateHere => ({
    ownMachine: machine === active,
    hasAccount: (id) => Object.values(selected?.accounts ?? {}).some((a) => a.provider === agent && a.id === id),
    mainReady: !!selected?.providers[agent]?.installed && !!selected.providers[agent]?.signedIn,
  });
  // The folder picked is a template's: another template without one, or None, takes it back (one you pick stays).
  const templateFolder = useRef(false);
  const pickFolder = (value: string, typed?: string) => {
    templateFolder.current = false;
    setFolder(value);
    if (typed !== undefined) setPath(typed);
  };
  /** A template's folder, as the menu has it (one that isn't among the recent ones goes in Another folder). */
  const takeFolder = (t: PromptTemplate | null) => {
    if (!t?.folder) {
      if (templateFolder.current) pickFolder(NEW_FOLDER, "");
      return;
    }
    pickFolder(t.folder, "");
    templateFolder.current = true;
  };
  /** What a service or a server fixes, whatever the saved defaults say (newChat.ts targetChoice). */
  const onTarget = (base: AgentChoice): AgentChoice => targetChoice(base, pool ? { ...pool, provider: agent as ChatProvider } : target);
  /** Your defaults, with the picked template on them (and its folder, on its own machine). */
  const fromDefaults = (base: AgentChoice) => {
    defaultsNow.current = onTarget(base);
    const p = pickedNow.current;
    setChoice(p ? withTemplate(p.template, defaultsNow.current, here(p.machine)) : defaultsNow.current);
    if (p && p.machine === active) takeFolder(p.template);
  };

  const request = useRef(0);
  const loadDefaults = () => {
    const id = ++request.current;
    setDefaultsError("");
    api<RoomDefaults>("GET", "/api/settings/defaults", undefined, selected?.conn ?? null)
      .then((d) => {
        if (id !== request.current) return;
        const a = d.agent[agent];
        fromDefaults({ account: a?.account ?? "default", model: a?.model ?? "", effort: a?.effort ?? "", permissionMode: a?.permissionMode ?? "ask", helperModel: a?.helperModel ?? "" });
      })
      .catch((e) => { if (id === request.current) setDefaultsError(e instanceof Error ? e.message : String(e)); });
  };
  useEffect(() => {
    setChoice(null);
    defaultsNow.current = null;
    templateFolder.current = false;
    setFolder(NEW_FOLDER);
    loadDefaults();
    return () => { request.current++; };
  }, [agent, active, selected?.conn.token]); // eslint-disable-line react-hooks/exhaustive-deps
  // Read again by itself once the machine is back.
  const machineStatus = selected?.status;
  const wasOpen = useRef(machineStatus === "open");
  useEffect(() => {
    if (machineStatus === "open" && !wasOpen.current && defaultsError) loadDefaults();
    wasOpen.current = machineStatus === "open";
  }, [machineStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Goes ahead without your saved defaults: the agent's own model and effort, the main sign-in, asking first. */
  const ownDefaults = () => {
    request.current++;
    setDefaultsError("");
    fromDefaults({ account: "default", model: "", effort: "", permissionMode: "ask", helperModel: "" });
  };

  /**
   * Fills New chat in from a template (`value`: TemplatePick's), or takes it off ("None": back to your defaults). None, and
   * a template for any agent, give back the agent New chat was opened for (another template's may have taken its place).
   */
  const pick = (value: string) => {
    const at = parsePick(value);
    const group = at ? groups.find((g) => g.machine.key === at.machineKey) : undefined;
    const t = at ? group?.templates.find((x) => x.id === at.id) : undefined;
    setValues({});
    if (!group || !t) {
      pickedNow.current = null;
      setPicked(null);
      setMessage("");
      // Another agent's defaults come with it (the effect above); the same agent's are back at once.
      if (agent !== provider) setAgent(provider);
      else if (defaultsNow.current) setChoice(defaultsNow.current);
      takeFolder(null);
      return;
    }
    const next = { machine: group.machine.key, template: t };
    pickedNow.current = next;
    setPicked(next);
    setMessage(t.text);
    const nextAgent = t.agent ?? provider;
    if (next.machine !== active || nextAgent !== agent) {
      // That machine's defaults for that agent come first (the effect above): the template goes on them there.
      setActive(next.machine);
      setAgent(nextAgent);
    } else if (defaultsNow.current) {
      setChoice(withTemplate(t, defaultsNow.current, here(next.machine)));
      takeFolder(t);
    }
  };
  // What of the picked template isn't used on the machine picked, and why.
  const note = picked ? templateNote(picked.template, here(picked.machine), machines.find((m) => m.key === picked.machine)?.name ?? "another machine") : null;
  // What the template's first message says once its blanks are filled in (all of them, to start).
  const firstMessage = picked ? fillBlanks(message, values).trim() : "";
  const blanksLeft = picked ? emptyBlanks(message, values).length : 0;
  const edited = !!picked && (message !== picked.template.text || Object.values(values).some((v) => v.trim()));

  // A service added on another machine isn't on this one: the chat can't be started there, and the line below says so.
  const serviceMissing = !!service && !!selected && selected.status === "open" && !account;
  // The agent that drives a service has to be on the machine picked. A service is its own sign-in, so only the program
  // matters — without it the chat would be made and then answer nothing but "codex isn't installed on the hub".
  const agentMissing = (!!service || !!server) && !!selected && selected.status === "open" && !agentCanRun(agent, selected.providers[agent]);
  const canStart = !busy && !!choice && !!selected && selected.status === "open" && !serviceMissing && !agentMissing && !(folder === OTHER_FOLDER && !path.trim()) && blanksLeft === 0;
  const start = async () => {
    if (!choice || !canStart) return;
    setBusy(true);
    setStartError("");
    try {
      const c = cleanChoice(choice);
      const cwd = folder === NEW_FOLDER ? undefined : folder === OTHER_FOLDER ? path.trim() : folder;
      const chat = { model: c.model || null, effort: c.effort || null, permissionMode: c.permissionMode, helperModel: c.helperModel || null, cwd, ...(named ? { name: named } : {}) };
      // A server that isn't added yet: the hub checks it and adds it as the account Settings → AI services would have
      // made, then starts the chat on it — one request, so a chat is never left without its service or the other way round.
      const room = server
        ? (await api<{ room: Room }>("POST", "/api/chats/service", { baseUrl: server.baseUrl, label: server.label, provider: server.provider, ...chat }, selected?.conn ?? null)).room
        : await api<Room>("POST", "/api/chats", { provider: agent, account: c.account, ...chat }, selected?.conn ?? null);
      // Made: its first message goes now. One that can't waits in the chat's message box, and the notice says so.
      const unsent = firstMessage && selected ? await sendFirstMessage(selected.conn, room.id, firstMessage, shownName) : null;
      onClose();
      useStore.getState().activate(active);
      openRoom(room.id);
      if (unsent) toast("warn", unsent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The hub's own words say what went wrong and what to do; a hub too old to add a server from here says so too.
      setStartError(
        server && routeMissing(message, e instanceof ApiError ? e.status : undefined)
          ? `${selected?.name ?? "This machine"}'s hub is too old to add a server from here. Add ${server.label} in Settings → AI services, then start the chat.`
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`New chat with ${shownName}`}
      icon={where ? <ServiceAvatar where={where} label={shownName} /> : <ProviderAvatar provider={agent} />}
      onClose={onClose}
      // A first message written or filled in isn't lost to a stray tap: closing asks first.
      dirty={edited && !busy}
      footer={(requestClose) => (
        <>
          {startError && (
            <p role="alert" className="svc-foot-error">
              {startError}
            </p>
          )}
          <button className="btn" onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={!canStart}>
            {busy ? (server ? "Adding and starting…" : "Starting…") : startError ? "Try again" : "Start chat"}
          </button>
        </>
      )}
    >
      {/* A service of yours: what it is, where it runs, and which agent drives it (the model lock and the helpers follow
          that agent, and the chat's own settings say it too). */}
      {(service || server) && (
        <p className="help" style={{ marginTop: 0 }}>
          {server
            ? `Found running on ${selected?.name ?? "this machine"}. Starting adds it to your AI services first, with the same checks as Settings.`
            : pool
              ? `${pool.offer.model ?? "Its model"} ${poolWhereWords(pool.offer)} · driven by ${info.name}`
              : account
                ? `${serviceWhereWords(account, selected?.name)} · driven by ${info.name}`
                : ""}
        </p>
      )}
      {serviceMissing && (
        <p role="alert" className="svc-problem">
          {pool
            ? `${shownName} isn't set up on ${selected?.name ?? "this machine"}. Pick the machine it runs on, or set it up there in Settings → Model pool.`
            : `${shownName} isn't on ${selected?.name ?? "this machine"}. Pick the machine it's on, or add it there in Settings → AI services.`}
        </p>
      )}
      {agentMissing && (
        <div role="alert" className="defaults-failed">
          <p className="small" style={{ margin: 0, fontWeight: 600 }}>
            {info.name} {unusable ? "can't be used" : "isn't installed"} on {selected?.name ?? "this machine"}
          </p>
          <p className="help" style={{ margin: "2px 0 8px" }}>
            {unusable ? `${noDot(unusable)}. Install is under ${info.name} in Settings.` : `${info.name} is the agent that would run ${shownName}, so the chat couldn't answer yet. Install it from Settings, then start the chat.`}
          </p>
          <button
            className="btn small"
            onClick={() => {
              onClose();
              // Asked for before the machine is switched: Settings opens anew for it and scrolls to that agent's card.
              showInSettings(`agent-${agent}`);
              useStore.getState().activate(active);
              useStore.getState().setView("settings");
            }}
          >
            Open settings
          </button>
        </div>
      )}
      {startError && server && (
        <div role="alert" className="defaults-failed">
          <p className="small" style={{ margin: 0, fontWeight: 600 }}>
            Couldn't add {server.label}
          </p>
          <p className="help" style={{ margin: "2px 0 8px" }}>{startError}</p>
          <button
            className="btn small"
            onClick={() => {
              onClose();
              showInSettings("ai-services");
              useStore.getState().setView("settings");
            }}
          >
            Open AI services
          </button>
        </div>
      )}
      {/* Shown while there are templates, and while one is picked (it may have been deleted elsewhere: its message still
          goes). Not for a service or a server: a template carries its own agent and account, which would take the
          service the menu was tapped for out from under the chat. */}
      {!service && !server && (groups.length > 0 || picked) && <TemplatePick groups={groups} several={machines.length > 1} picked={picked} onPick={pick} message={message} onMessage={setMessage} values={values} onValues={setValues} note={note} />}
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          aria-label="Name"
          aria-describedby="new-chat-name-help"
          value={name}
          maxLength={80}
          placeholder="Optional"
          autoComplete="off"
          enterKeyHint="go"
          onChange={(e) => setName(e.target.value)}
          // Enter starts the chat (not while a keyboard is still putting a word together).
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void start();
          }}
        />
        <span className="help" id="new-chat-name-help">
          Without one, it's named from your first message.
        </span>
      </label>
      {/* The model pool is one model with an agent driving it: which agent stays yours to pick, because the permissions,
          the helper agents and the model lock are that agent's. Nothing else about the chat changes with it. */}
      {pool && poolAgentList.length > 1 && (
        <label className="field">
          <span>Agent</span>
          <select className="select" aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value as ChatProvider)}>
            {poolAgentList.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_INFO[p].name}
              </option>
            ))}
          </select>
          <span className="help">Drives {shownName}: its permissions, helper agents and model lock.</span>
        </label>
      )}
      {machines.length > 1 && !server && (
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
          <span className="help">{ready ? `${shownName} runs on this machine, in its folders.` : unusable ? `${noDot(unusable)}. Install is under ${info.name} in Settings, with this machine picked.` : onlyOnServices ? `${info.name} isn't installed on this machine yet: install it from Settings with this machine picked.` : `${info.name} isn't signed in on this machine yet: sign it in from Settings with this machine picked.`}</span>
        </label>
      )}
      <FolderPicker
        folder={folder}
        path={path}
        onPick={pickFolder}
        known={recent}
        conn={selected?.conn ?? null}
        newHelp={`An empty folder in ${hub?.workspaceRoot ?? "the workspaces folder"}${namesFolder ? ", named after the chat" : ""}.`}
        pickedHelp={`${shownName} works in this folder on the hub.`}
      />
      {/* A template's message goes as soon as the chat is made: one about a project would get an empty folder. */}
      {folder === NEW_FOLDER && firstMessage && <p className="help">The first message goes at once. If it's about a project, pick that project's folder.</p>}
      {choice ? (
        <AgentOptions
          key={`${active}|${agent}|${target.kind}`}
          provider={agent}
          value={choice}
          onChange={setChoice}
          connection={selected?.conn}
          accountList={selected?.accounts}
          // A service is the chat's identity: changing the account here would make it another chat. Its own settings can.
          showAccount={!service && !server}
          offer={server ? serverModelOptions(server.models) : undefined}
          starting
        />
      ) : defaultsError ? (
        <div role="alert" className="defaults-failed">
          <p className="small" style={{ margin: 0, fontWeight: 600 }}>
            Couldn't read your {info.name} defaults from {selected?.name ?? "this machine"}.
          </p>
          <p className="help" style={{ margin: "2px 0 8px" }}>
            {defaultsError} {selected?.status === "open" ? "" : `It tries again when ${selected?.name ?? "the machine"} is back.`}
          </p>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn small" onClick={loadDefaults}>
              Retry
            </button>
            <button className="btn small ghost" onClick={ownDefaults}>
              Use {info.name}'s own defaults
            </button>
          </div>
        </div>
      ) : (
        <p className="muted small">Loading your defaults…</p>
      )}
    </Dialog>
  );
}
