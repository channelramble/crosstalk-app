import { useEffect, useRef, useState } from "react";
import { Check, Copy, Server, X } from "lucide-react";
import { CHAT_PROVIDERS, PROVIDER_INFO, type ChatProvider, type HubSettings, type MachineInfo, type MachineInvite, type MachineInviteStatus } from "@crosstalk/shared";
import { api, normalizeBaseUrl, pairDevice } from "../api";
import { noteLinked } from "../linkedMachines";
import { machineKey } from "../machines";
import { canNavigate, showInSettings } from "../navigation";
import { agentReady, hubStore, useMachines, useStore, type Machine } from "../store";
import { AskTwiceDialog, copyText, thisDevice } from "../ui";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** While a link's agents are connecting, the list is asked for again this often. */
const CONNECTING_POLL_MS = 2_000;
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Settings → Machines: the machines whose chats this device shows. The hub this app was opened from keeps links to
 * the others, so a machine added on one device can be added on the others with one tap.
 */
export function MachinesSection({ linuxSetup = 0 }: { linuxSetup?: number }) {
  const machines = useMachines((m) => m.list);
  const active = useStore((s) => s.active);
  const activate = useStore((s) => s.activate);
  const addMachine = useStore((s) => s.addMachine);
  const removeMachine = useStore((s) => s.removeMachine);
  const toast = useStore((s) => s.toast);
  // The hub this app came from links the others.
  const home = machines.find((m) => m.key === "") ?? machines[0];
  const [linked, setLinked] = useState<MachineInfo[] | null>(null);
  const [linkedError, setLinkedError] = useState("");
  const [mode, setMode] = useState<"linux" | "link" | null>(null);
  // "Link again" for a machine this device can't get a code from: the form, with its address filled in.
  const [relinkUrl, setRelinkUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // A machine just added: what's next there.
  const [added, setAdded] = useState<{ key: string; name: string } | null>(null);
  const [removingHome, setRemovingHome] = useState<Machine | null>(null);
  const setup = useRef<HTMLDivElement>(null);
  // Opened from elsewhere (the model pool's "Add a Linux machine"): show the Linux setup and bring it into view.
  useEffect(() => {
    if (!linuxSetup) return;
    setMode("linux");
    requestAnimationFrame(() => setup.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [linuxSetup]);

  const loadLinked = () => {
    if (!home) return;
    api<MachineInfo[]>("GET", "/api/machines", undefined, home.conn)
      .then((list) => {
        setLinked(list);
        setLinkedError("");
        // The chat list offers these machines too: it hears what this screen learns (an unlink, say) at once.
        if (Array.isArray(list)) noteLinked(home.key, list);
      })
      .catch((e) => setLinkedError(message(e)));
  };
  useEffect(loadLinked, [home?.key, home?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // A link whose agents are connecting is asked about again until it says how that went. The hub's own try can take
  // a minute (a look, then a pairing call of up to 60 s), and a failure is retried after 1, 5, 15 and 60 minutes, so
  // a fixed re-read or two leaves the row on "connecting…" with no reason and no Try again long after the hub knows.
  // Only while that hub answers: when it's back, the list is read again anyway (above).
  const connecting = home?.status === "open" && !!linked?.some((l) => l.agents === "connecting");
  useEffect(() => {
    if (!connecting) return;
    const timer = setInterval(loadLinked, CONNECTING_POLL_MS);
    return () => clearInterval(timer);
  }, [connecting, home?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!home) return null;

  const here = (info: MachineInfo) => machines.find((m) => (m.hub?.id && m.hub.id === info.id) || normalizeBaseUrl(m.conn.baseUrl) === normalizeBaseUrl(info.url));
  // Machines another machine introduced can't be added from here (no sign-in for people's devices).
  const notHere = (linked ?? []).filter((l) => !here(l) && l.scope !== "peer");
  const infoOf = (m: Machine) => (linked ?? []).find((l) => l.id === m.hub?.id || normalizeBaseUrl(l.url) === normalizeBaseUrl(m.conn.baseUrl)) ?? null;
  const nameOf = (id: string | null | undefined) => (id ? machines.find((m) => m.hub?.id === id)?.name ?? (linked ?? []).find((l) => l.id === id)?.name ?? "another machine" : null);
  /**
   * An action on a link failed: say why, and look again, because the commonest reason is that the list on screen is
   * out of date (another device or tab unlinked that machine, and the hub answers 404): its row goes, rather than
   * staying with buttons that can only fail again.
   */
  const failed = (e: unknown, words = message(e)) => {
    toast("error", words);
    loadLinked();
  };
  /** Make a link two-way for agents (or try again). */
  const connect = async (info: MachineInfo) => {
    setBusy(info.id);
    try {
      const next = await api<MachineInfo | null>("POST", `/api/machines/${encodeURIComponent(info.id)}/connect`, {}, home.conn);
      // What the hub answers is the link as it now stands ("connecting"): shown at once, so the tap is seen to have
      // done something. It connects in the background, and the row is asked about until it says how that went.
      if (next?.id === info.id) setLinked((list) => list?.map((l) => (l.id === next.id ? next : l)) ?? list);
      else loadLinked();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  };
  /** How agents here and there reach each other's chats, in words, with what can be done about it. */
  const agentLine = (info: MachineInfo | null) => {
    if (!info) return null;
    const via = info.introducedBy ? ` · linked through ${nameOf(info.introducedBy)}` : "";
    switch (info.agents) {
      case "two-way":
        return <span className="tiny muted">Agents: connected both ways{via}</span>;
      case "connecting":
        return <span className="tiny muted">Agents: connecting…{via}</span>;
      case "needs-update":
        return <span className="tiny" style={{ color: "var(--orange)" }}>Agents: needs a Crosstalk update there</span>;
      case "signed-out":
        return (
          <span className="tiny" style={{ color: "var(--orange)" }}>
            It no longer accepts {home.name}'s sign-in ·{" "}
            <button className="link-btn" onClick={() => void relink(info)} disabled={!!busy}>
              {busy === info.id ? "Linking…" : "Link again"}
            </button>
          </span>
        );
      case "failed":
        return (
          <span className="tiny" style={{ color: "var(--orange)" }}>
            Agents: couldn't connect{info.error ? `: ${info.error}` : ""} ·{" "}
            <button className="link-btn" onClick={() => void connect(info)} disabled={!!busy}>
              Try again
            </button>
          </span>
        );
      default:
        return info.scope === "peer" ? null : (
          <span className="tiny muted">
            Agents: one way ·{" "}
            <button className="link-btn" onClick={() => void connect(info)} disabled={!!busy}>
              Connect
            </button>{" "}
            (needs "Let agents reach your other chats" on)
          </span>
        );
    }
  };

  /** Pairs this device with a linked machine: its hub hands this one a code. What's next there shows below the list. */
  const addHere = async (info: MachineInfo) => {
    setBusy(info.id);
    try {
      const pc = await api<{ url: string; code: string }>("POST", `/api/machines/${encodeURIComponent(info.id)}/pair-code`, {}, home.conn);
      const conn = await pairDevice(pc.url, pc.code, home.conn.deviceName);
      // Added even when it can't be reached yet: it keeps trying, and its row says so.
      await addMachine(conn).catch(() => {});
      setAdded({ key: machineKey(conn), name: info.name });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  };
  /**
   * Links a machine again after it stopped accepting this hub's sign-in: with a code from it when this device has it,
   * otherwise in the form, its address filled in, for a code from it.
   */
  const relink = async (info: MachineInfo) => {
    const m = here(info);
    if (!m || m.status !== "open") {
      setRelinkUrl(info.url);
      setMode("link");
      requestAnimationFrame(() => setup.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }
    setBusy(info.id);
    try {
      const pc = await api<{ code: string }>("POST", "/api/pairing-codes", {}, m.conn);
      await api<MachineInfo>("POST", "/api/machines/link", { url: info.url, code: pc.code }, home.conn);
      toast("info", `${info.name} is linked again.`);
      loadLinked();
    } catch (e) {
      failed(e, `Couldn't link ${info.name} again: ${message(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const unlink = async (info: MachineInfo) => {
    if (!confirm(`Unlink ${info.name}? It keeps running and keeps its chats, but stops showing up here and on your other devices until you link it again. Agents there stop reaching chats here, and the other way round.`)) return;
    setBusy(info.id);
    try {
      await api("DELETE", `/api/machines/${encodeURIComponent(info.id)}`, undefined, home.conn);
      const m = here(info);
      if (m) removeMachine(m.key);
      loadLinked();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = (m: Machine) => {
    // The machine this app opens from is asked twice: getting it back takes a new pairing code.
    if (m.key === "") return setRemovingHome(m);
    if (!confirm(`Remove ${m.name} from this device? Its chats stay on it; you can add it again here any time.`)) return;
    removeMachine(m.key);
  };
  const rename = async (m: Machine) => {
    const name = prompt("What should this machine be called?", m.name);
    if (name === null) return;
    try {
      await api<HubSettings>("PUT", "/api/settings/hub", { machineName: name.trim() }, m.conn);
      await hubStore(m.key)?.getState().refresh();
      loadLinked();
    } catch (e) {
      toast("error", message(e));
    }
  };

  return (
    <>
      <div className="list-group">
        {machines.map((m) => (
          <div key={m.key} className="list-row can-wrap names-wrap machine-row" style={{ cursor: "default" }}>
            <Server size={20} />
            <div className="row-text">
              <div className="title">
                {m.name} {m.key === active && machines.length > 1 && <span className="pill blue">Showing</span>}
              </div>
              <div className="subtitle">
                <span className={`machine-dot ${m.status === "open" ? "on" : m.status === "connecting" ? "wait" : ""}`} />
                {m.status === "open" ? "Connected" : m.status === "connecting" ? "Connecting…" : "Can't reach it"} · {m.conn.baseUrl ? host(m.conn.baseUrl) : host(location.origin)}
              </div>
              {m.key !== home.key && agentLine(infoOf(m))}
            </div>
            <div className="row-actions">
              {m.key !== active && (
                <button className="btn small ghost" onClick={() => activate(m.key)}>
                  Show
                </button>
              )}
              <button className="btn small ghost" onClick={() => void rename(m)} disabled={m.status !== "open"}>
                Rename
              </button>
              {machines.length > 1 && (
                <button className="btn small ghost danger" onClick={() => remove(m)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        {notHere.map((info) => (
          <div key={info.id} className="list-row can-wrap names-wrap machine-row" style={{ cursor: "default" }}>
            <Server size={20} className="muted" />
            <div className="row-text">
              <div className="title">{info.name}</div>
              <div className="subtitle">Not on this device yet · {host(info.url)}</div>
              {info.agents === "signed-out" && agentLine(info)}
            </div>
            <div className="row-actions">
              <button className="btn small primary" onClick={() => void addHere(info)} disabled={!!busy}>
                {busy === info.id ? "Adding…" : "Add"}
              </button>
              <button className="btn small ghost danger" onClick={() => void unlink(info)} disabled={!!busy}>
                Unlink
              </button>
            </div>
          </div>
        ))}
      </div>
      {linkedError && (
        <div role="alert" className="small" style={{ marginTop: 8 }}>
          <p style={{ margin: "0 0 6px" }}>Couldn't check which machines {home.name} links: {linkedError}</p>
          <button className="btn small" onClick={loadLinked}>
            Retry
          </button>
        </div>
      )}
      {added && <NextSteps machine={added.key} name={added.name} onClose={() => setAdded(null)} />}
      <p className="help" style={{ margin: "6px 0 10px" }}>
        Each machine runs its own agents in its own folders. Chats from all of them show in the sidebar; screens like this one show the machine picked at the top.
      </p>
      <div ref={setup} className="row wrap" style={{ gap: 8, scrollMarginTop: 12 }}>
        <button className={`btn small ${mode === "linux" ? "primary" : ""}`} onClick={() => setMode(mode === "linux" ? null : "linux")}>
          Set up a Linux machine
        </button>
        <button className={`btn small ${mode === "link" ? "primary" : ""}`} onClick={() => { setRelinkUrl(""); setMode(mode === "link" ? null : "link"); }}>
          Add a machine that runs Crosstalk
        </button>
      </div>
      {mode === "linux" && <LinuxSetup home={home} onDone={(info) => { setMode(null); loadLinked(); void addHere(info); }} />}
      {mode === "link" && (
        <LinkForm
          key={relinkUrl}
          home={home}
          url={relinkUrl}
          onDone={(info) => {
            setMode(null);
            setRelinkUrl("");
            loadLinked();
            // Linked again, for a machine this device has already: nothing more to add.
            if (!here(info)) void addHere(info);
          }}
        />
      )}
      {removingHome && (
        <AskTwiceDialog
          title={`Remove ${removingHome.name} from ${thisDevice()}?`}
          sure={`To get ${removingHome.name} back, you'll need a pairing code from it: on a device that still has it, Settings → Pair a new device. Then here, Settings → Machines → Add a machine that runs Crosstalk, with its address: ${host(location.origin)}.`}
          confirmLabel="Yes, remove"
          workingLabel="Removing…"
          onConfirm={() => removeMachine(removingHome.key)}
          onClose={() => setRemovingHome(null)}
        >
          <p className="small" style={{ margin: 0 }}>
            This app opens from {removingHome.name}. Its chats stay on it, but {thisDevice()} stops showing them, and stops getting notifications: they come through {removingHome.name}.
          </p>
        </AskTwiceDialog>
      )}
    </>
  );
}

/**
 * After a machine is added: what's next there. Its agents need signing in on that machine, so each one that isn't
 * ready gets a button that switches to it and opens its card in Settings.
 */
function NextSteps({ machine: key, name, onClose }: { machine: string; name: string; onClose: () => void }) {
  const m = useMachines((s) => s.list.find((x) => x.key === key));
  const activate = useStore((s) => s.activate);
  if (!m) return null;
  const open = (p: ChatProvider) => {
    if (!canNavigate()) return;
    // Settings opens anew for that machine: it scrolls to the agent's card then.
    showInSettings(`agent-${p}`);
    activate(key);
  };
  const waiting = CHAT_PROVIDERS.filter((p) => !agentReady(m, p));
  return (
    <section className="card next-steps" aria-label={`Next on ${name}`}>
      <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Next on {name}</div>
          <p className="help" style={{ margin: "2px 0 10px" }}>
            {name} is added: its chats show in the sidebar. {waiting.length ? `Sign ${waiting.length === CHAT_PROVIDERS.length ? "its agents" : PROVIDER_INFO[waiting[0]].name} in there to chat with ${waiting.length === 1 ? "it" : "them"}.` : "Its agents are signed in."}
          </p>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        {CHAT_PROVIDERS.map((p) =>
          waiting.includes(p) ? (
            <button key={p} className="btn small primary" disabled={m.status !== "open"} onClick={() => open(p)}>
              Sign in {PROVIDER_INFO[p].name}
            </button>
          ) : (
            <span key={p} className="pill green">
              {PROVIDER_INFO[p].name} is ready
            </span>
          ),
        )}
      </div>
      {m.status !== "open" && <p className="help" style={{ marginBottom: 0 }}>Connecting to {name}…</p>}
    </section>
  );
}

/**
 * One command to run on the Linux machine: it installs the hub there and links it with this one. While it waits, a try
 * that failed says why; once the command is used up (three failed tries) or expired, a new one is a tap away.
 */
function LinuxSetup({ home, onDone }: { home: Machine; onDone: (m: MachineInfo) => void }) {
  const [invite, setInvite] = useState<MachineInvite | null>(null);
  const [state, setState] = useState<MachineInviteStatus | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // The newest command is the one shown (an older one still being made doesn't replace it).
  const making = useRef(0);
  const make = () => {
    const id = ++making.current;
    setError("");
    setState(null);
    setInvite(null);
    api<MachineInvite>("POST", "/api/machines/invite", {}, home.conn)
      .then((i) => { if (id === making.current) setInvite(i); })
      .catch((e) => { if (id === making.current) setError(message(e)); });
  };
  useEffect(() => {
    make();
    return () => { making.current++; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Waits for the machine to report back.
  useEffect(() => {
    if (!invite || (state && state.status !== "waiting")) return;
    const t = setTimeout(() => {
      api<MachineInviteStatus>("GET", `/api/machines/invites/${invite.token}`, undefined, home.conn)
        .then((s) => {
          setState(s);
          if (s.status === "done" && s.machine) onDone(s.machine);
        })
        // Couldn't ask (this hub restarted, say): keep waiting, and keep saying why the last try failed.
        .catch(() => setState((s) => ({ status: "waiting", error: s?.error })));
    }, 2000);
    return () => clearTimeout(t);
  }, [invite, state]); // eslint-disable-line react-hooks/exhaustive-deps
  const over = state?.status === "failed" || state?.status === "expired";

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <ol className="setup-steps">
        <li>On the Linux machine, install Tailscale and sign in with the same account as your other devices.</li>
        <li>
          {over ? "Tap Make a new command, then run it in a terminal there:" : "Open a terminal there and run:"}
          {invite && !over ? (
            <div className="command-box">
              <code>{invite.command}</code>
              <button
                className="btn small ghost"
                onClick={async () => {
                  setCopied(await copyText(invite.command));
                  setTimeout(() => setCopied(false), 1800);
                }}
                aria-label="Copy command"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : over ? (
            // Where the command was: why it doesn't work any more, and a new one.
            <div role="alert" className="small" style={{ marginTop: 6 }}>
              <p style={{ margin: "0 0 6px", color: state?.status === "failed" ? "var(--red)" : undefined }}>
                {state?.status === "failed"
                  ? `Linking failed 3 times${state.error ? `: ${state.error.replace(/([^.!?])$/, "$1.")}` : "."} Fix that first: this command doesn't work any more.`
                  : "This command expired."}
              </p>
              <button className="btn small primary" onClick={make}>
                Make a new command
              </button>
            </div>
          ) : (
            !error && <p className="muted small">Making a command…</p>
          )}
        </li>
        <li>It installs Crosstalk as a background service, asks for your password once, and adds the machine here on its own.</li>
      </ol>
      {error && (
        <div role="alert" className="small">
          <p style={{ color: "var(--red)", margin: "0 0 6px" }}>Couldn't make a command: {error}</p>
          <button className="btn small" onClick={make}>
            Try again
          </button>
        </div>
      )}
      {invite && (!state || state.status === "waiting") && (
        <>
          <p className="muted small" role="status">
            Waiting for the machine… (the command works for an hour)
          </p>
          {state?.error && (
            <p className="small" role="alert" style={{ color: "var(--orange)" }}>
              Last try failed: {state.error.replace(/([^.!?])$/, "$1.")} Fix that and run the same command again.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Links a machine that already runs Crosstalk (installed by hand), with a pairing code from it. */
function LinkForm({ home, url: start = "", onDone }: { home: Machine; url?: string; onDone: (m: MachineInfo) => void }) {
  const [url, setUrl] = useState(start);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const link = async () => {
    setBusy(true);
    setError("");
    try {
      onDone(await api<MachineInfo>("POST", "/api/machines/link", { url: url.trim(), code: code.trim() }, home.conn));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <label className="field">
        <span>Its address</span>
        <input className="input mono" placeholder="linux-box.your-tailnet.ts.net" value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <label className="field">
        <span>Pairing code</span>
        <input className="input mono" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <span className="help">
          From that machine: Settings → Pair a new device, or run <span className="mono">crosstalk-hub pair</span> in its terminal.
        </span>
      </label>
      {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
      <button className="btn small primary" onClick={link} disabled={busy || !url.trim() || !code.trim()}>
        {busy ? "Linking…" : "Link"}
      </button>
    </div>
  );
}
