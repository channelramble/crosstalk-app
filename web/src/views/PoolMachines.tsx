import { useEffect, useRef, useState } from "react";
import { Check, Copy, Monitor, Plus, RefreshCw, Server, Share2 } from "lucide-react";
import type { PoolBackend, PoolMachine, PoolView } from "@crosstalk/shared";
import { api } from "../api";
import { useStore } from "../store";
import { ChoiceCards, ConfirmButton, Dialog, Seg, Switch, copyText, timeAgo } from "../ui";
import { MACHINE_STATE, gpuLine, gpus, isTailscaleIPv4, linkText, newComputerId, peerOs, portProblem, roleLabel, withMachine } from "../pool";
import type { PoolSave } from "./ModelPool";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Peer = { name: string; address: string; os: string; online: boolean; direct: boolean | null };
type Os = NonNullable<PoolMachine["os"]>;

const OS_NAME: Record<Os, string> = { windows: "Windows", linux: "Linux", macos: "Mac" };

/**
 * The machines in the pool, one row each, and the ways to add more. Each new `commandAsk` (a problem's fix) opens that
 * PC's dialog, which leads with its helper command.
 */
export function PoolMachines({
  view,
  save,
  checking,
  checkError,
  onCheck,
  onSetUpLinux,
  appliesLater,
  commandAsk = null,
}: {
  view: PoolView;
  save: PoolSave;
  checking: boolean;
  checkError: string;
  onCheck: () => void;
  onSetUpLinux: () => void;
  appliesLater?: string;
  commandAsk?: { id: string; n: number } | null;
}) {
  const [editing, setEditing] = useState<PoolMachine | "new" | null>(null);
  const [linux, setLinux] = useState(false);
  useEffect(() => {
    const pc = commandAsk && view.config.machines.find((m) => m.id === commandAsk.id && m.kind === "computer");
    if (pc) setEditing(pc);
  }, [commandAsk?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // A switch shows where it was flipped to until the hub has it.
  const [want, setWant] = useState<Record<string, boolean>>({});
  const settle = (id: string) =>
    setWant((w) => {
      const next = { ...w };
      delete next[id];
      return next;
    });
  const toggle = (m: PoolMachine, enabled: boolean) => {
    setWant((w) => ({ ...w, [m.id]: enabled }));
    void save((c) => ({ machines: withMachine(c, m.id, { enabled }) }), appliesLater).finally(() => settle(m.id));
  };
  const { config } = view;
  return (
    <>
      <h3 className="section-title pool-title">Machines in the pool</h3>
      <div className="list-group">
        {config.machines.map((m) => (
          <MachineRow
            key={m.id}
            m={m}
            view={view}
            enabled={want[m.id] ?? m.enabled}
            onToggle={(v) => toggle(m, v)}
            onMain={() => void save(() => ({ mainId: m.id }), appliesLater ?? `${m.name} is the main machine now.`)}
            onRemove={() => void save((c) => ({ machines: c.machines.filter((x) => x.id !== m.id) }), `${m.name} was removed from the pool.`)}
            onCommand={() => setEditing(m)}
          />
        ))}
        {!config.machines.length && <p className="help" style={{ padding: "12px 14px", margin: 0 }}>No machines yet. Add one below.</p>}
      </div>
      <div className="row wrap pool-buttons">
        <button className="btn small" onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden="true" /> Add a Windows or other PC
        </button>
        <button className="btn small" onClick={() => setLinux(true)}>
          <Plus size={14} aria-hidden="true" /> Add a Linux machine
        </button>
        <button className="btn small ghost" onClick={onCheck} disabled={checking}>
          <RefreshCw size={13} className={checking ? "spin" : ""} aria-hidden="true" /> {checking ? "Checking…" : "Check the machines"}
        </button>
      </div>
      {checkError && (
        <p className="small pool-error" role="alert">
          Couldn't check the machines: {checkError}
        </p>
      )}
      <p className="help">The machines reach each other over Tailscale. Keep your tailnet to your own devices: a helper has no password of its own.</p>
      {editing && <PcDialog view={view} machine={editing === "new" ? null : editing} save={save} onClose={() => setEditing(null)} />}
      {linux && <LinuxDialog onClose={() => setLinux(false)} onSetUp={onSetUpLinux} />}
    </>
  );
}

function MachineRow({ m, view, enabled, onToggle, onMain, onRemove, onCommand }: { m: PoolMachine; view: PoolView; enabled: boolean; onToggle: (v: boolean) => void; onMain: () => void; onRemove: () => void; onCommand: () => void }) {
  const st = view.machines.find((s) => s.id === m.id);
  const isMain = m.id === view.config.mainId;
  const role = roleLabel({ id: m.id, enabled }, view.config.mainId);
  const devices = gpus(st?.devices);
  const state = MACHINE_STATE[st?.state ?? "unknown"];
  const network = m.kind !== "self" ? linkText(st?.link) : null;
  // Checked once, but what it does now isn't known (the hub restarted since): the time it was checked says enough.
  const stateText = st?.detail || (st?.state === "unknown" && st.checkedAt ? null : state.label);
  const hubMachine = m.kind === "self" || m.kind === "hub";
  const actions = (hubMachine && !isMain) || m.kind === "computer";
  return (
    <div className="list-row pool-machine">
      {m.kind === "computer" ? <Monitor size={20} aria-hidden="true" /> : <Server size={20} aria-hidden="true" />}
      <div className="row-text">
        <div className="title">
          <span className="pool-machine-name">{m.name}</span>
          <span className={`pill ${role === "Main machine" ? "blue" : role === "Helper" ? "green" : ""}`}>{role}</span>
        </div>
        {isMain && <div className="subtitle">Holds the model and answers chats{enabled ? "" : ". Its GPU is left out"}.</div>}
        {st?.checkedAt ? (
          <>
            {/* A PC's GPU can't be seen from here (only that its helper answers), and when a hub has none the hub's own
                words below say why (no llama.cpp there yet, or none found). */}
            {devices.length ? <div className="subtitle">{devices.map(gpuLine).join(" + ")}</div> : m.kind !== "computer" && !st.detail ? <div className="subtitle">No GPU found</div> : null}
            {network && <div className={`subtitle ${network.startsWith("No answer") ? "pool-warn" : ""}`}>{network}</div>}
          </>
        ) : null}
        <div className={`subtitle ${state.dot === "bad" ? "pool-warn" : ""}`}>
          <span className={`pool-dot ${state.dot}`} aria-hidden="true" />
          {stateText}
          {st?.checkedAt ? `${stateText ? " · checked" : "Checked"} ${timeAgo(st.checkedAt)}` : ""}
        </div>
        {m.kind === "computer" && <div className="subtitle pool-why">{[m.address, m.os ? OS_NAME[m.os] : null, m.backend === "cuda" ? "NVIDIA (CUDA)" : m.backend === "vulkan" ? "Vulkan" : m.backend === "metal" ? "Metal" : null].filter(Boolean).join(" · ")}</div>}
      </div>
      <Switch checked={enabled} onChange={onToggle} label={`Use the GPU on ${m.name}`} />
      {actions && (
        <div className="pool-machine-actions">
          {hubMachine && !isMain && (
            <button className="btn small ghost" onClick={onMain} aria-label={`Make this the main machine (${m.name})`}>
              Make this the main machine
            </button>
          )}
          {m.kind === "computer" && (
            <button className="btn small ghost" onClick={onCommand} aria-label={`Helper command for ${m.name}`}>
              Helper command
            </button>
          )}
          {m.kind === "computer" && <ConfirmButton label="Remove" ariaLabel={`Remove ${m.name}`} question={`Remove ${m.name} from the pool?`} confirmLabel="Remove" onConfirm={onRemove} />}
        </div>
      )}
    </div>
  );
}

/**
 * Adds a PC by its Tailscale address (or changes one), then shows the one command that runs its helper. The command
 * comes from the hub once the PC is saved, so it names the right address, port and build.
 */
function PcDialog({ view, machine, save, onClose }: { view: PoolView; machine: PoolMachine | null; save: PoolSave; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const id = useRef(machine?.id ?? newComputerId());
  const [saved, setSaved] = useState<PoolMachine | null>(machine);
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [peersError, setPeersError] = useState("");
  const [address, setAddress] = useState(machine?.address ?? "");
  const [name, setName] = useState(machine?.name ?? "");
  const [os, setOs] = useState<Os>(machine?.os ?? "windows");
  const [backend, setBackend] = useState<PoolBackend>(machine?.backend && machine.backend !== "metal" ? machine.backend : "vulkan");
  const [port, setPort] = useState(String(machine?.rpcPort ?? 50052));
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<{ command: string; notes: string[]; short?: string } | null>(null);
  const [commandError, setCommandError] = useState("");
  const [copied, setCopied] = useState<"short" | "long" | null>(null);
  const commandRequest = useRef(0);
  const runBox = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadPeers = () => {
    setPeersError("");
    api<{ peers: Peer[] }>("GET", "/api/pool/tailscale")
      .then((r) => setPeers(r.peers))
      .catch((e) => setPeersError(message(e)));
  };
  const loadCommand = (m: PoolMachine) => {
    const req = ++commandRequest.current;
    setCommand(null);
    setCommandError("");
    api<{ command: string; notes: string[]; short?: string }>("GET", `/api/pool/helper-command?machine=${encodeURIComponent(m.id)}&os=${m.os ?? "windows"}&backend=${m.backend ?? "vulkan"}`)
      .then((r) => req === commandRequest.current && setCommand(r))
      .catch((e) => req === commandRequest.current && setCommandError(message(e)));
  };
  useEffect(() => {
    loadPeers();
    if (machine) loadCommand(machine);
    return () => {
      commandRequest.current++;
      clearTimeout(copyTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addr = address.trim();
  const portError = portProblem(port);
  const draft: PoolMachine = { id: id.current, kind: "computer", name: name.trim(), address: addr, os, backend: os === "macos" ? "metal" : backend, enabled: saved?.enabled ?? true, rpcPort: portError ? (saved?.rpcPort ?? 50052) : Number(port) };
  const dirty = !saved || draft.name !== saved.name || draft.address !== saved.address || draft.os !== saved.os || draft.backend !== saved.backend || port !== String(saved.rpcPort);
  // The same machine twice would lend the same GPU twice: a linked hub at that address is it; a PC there, on that port.
  const taken = view.config.machines.find((m) => m.id !== id.current && m.address && m.address === addr && (m.kind !== "computer" || m.rpcPort === draft.rpcPort));
  const addressError = !addr ? null : !isTailscaleIPv4(addr) ? "Type its Tailscale IPv4 address, like 100.101.102.103: the Tailscale app on the PC shows it." : taken ? `That's ${taken.name}, already in the pool.` : null;
  const canSave = !busy && dirty && !!draft.name && isTailscaleIPv4(addr) && !taken && !portError;
  const shownPeers = (peers ?? []).filter((p) => peerOs(p.os) && !view.config.machines.some((m) => m.id !== id.current && m.address === p.address));

  const pick = (p: Peer) => {
    const peerName = peers?.find((x) => x.address === addr)?.name;
    setAddress(p.address);
    if (!name.trim() || name.trim() === peerName) setName(p.name.slice(0, 40));
    const o = peerOs(p.os);
    if (o) setOs(o);
  };
  const submit = async () => {
    if (!canSave) return;
    const next = draft;
    setBusy(true);
    // Only what this dialog sets changes: the switch stays as it is now, even if it was changed meanwhile.
    const fields = { name: next.name, address: next.address, os: next.os, backend: next.backend, rpcPort: next.rpcPort };
    const ok = await save(
      (c) => ({ machines: c.machines.some((m) => m.id === next.id) ? withMachine(c, next.id, fields) : [...c.machines, next] }),
      saved ? "Saved." : undefined,
    );
    setBusy(false);
    if (!ok) return;
    setSaved(next);
    loadCommand(next);
    // The command now leads the dialog: show it, wherever the dialog was scrolled to.
    requestAnimationFrame(() => runBox.current?.scrollIntoView({ block: "start" }));
  };
  const copy = async (which: "short" | "long") => {
    const text = which === "short" ? command?.short : command?.command;
    if (!text) return;
    const ok = await copyText(text).catch(() => false);
    if (!ok) {
      toast("error", "Couldn't copy. Select the command and copy it instead.");
      return;
    }
    setCopied(which);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 2000);
  };
  // On a phone the clipboard is the phone's: send the command to yourself instead (to open it on the PC).
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const share = async () => {
    const text = command?.short ?? command?.command;
    if (!text) return;
    try {
      await navigator.share({ title: `Helper command for ${saved?.name ?? "the PC"}`, text });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast("error", "Couldn't share it. Copy it instead.");
    }
  };

  const form = (
    <>
      <div className="pool-label">Which PC</div>
      {peersError ? (
        <div role="alert" className="small">
          <p className="pool-error" style={{ margin: "4px 0" }}>Couldn't list your Tailscale devices: {peersError}</p>
          <button className="btn small" onClick={loadPeers}>
            Try again
          </button>
        </div>
      ) : !peers ? (
        <p className="muted small" role="status">
          Looking for your Tailscale devices…
        </p>
      ) : shownPeers.length ? (
        <ChoiceCards
          label="Which PC"
          value={addr}
          onChange={(a) => {
            const p = shownPeers.find((x) => x.address === a);
            if (p) pick(p);
          }}
          options={shownPeers.map((p) => ({
            id: p.address,
            label: p.name,
            help: [p.address, OS_NAME[peerOs(p.os)!], p.online ? (p.direct === false ? "online, through a relay" : "online") : "offline"].join(" · "),
          }))}
        />
      ) : (
        <p className="help">No other Windows, Linux or Mac computers on your tailnet yet. Type the address instead.</p>
      )}
      <label className="field" style={{ marginTop: 12 }}>
        <span>Or type its Tailscale address</span>
        {/* Not "decimal": in regions that write a decimal comma, that keypad has no dot. */}
        <input className="input mono" aria-label="Or type its Tailscale address" aria-invalid={!!addressError} inputMode="url" value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="100.x.y.z" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        {addressError && <span className="small pool-error">{addressError}</span>}
      </label>
      <label className="field">
        <span>Name</span>
        <input className="input" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Gaming PC" />
      </label>
      <div className="field">
        <span>Its system</span>
        <Seg label="Its system" value={os} onChange={setOs} options={[{ id: "windows", label: "Windows" }, { id: "linux", label: "Linux" }, { id: "macos", label: "Mac" }]} />
      </div>
      <div className="field">
        <span>Its GPU</span>
        {os === "macos" ? (
          <span className="help">Uses its Apple GPU (Metal).</span>
        ) : (
          <ChoiceCards
            label="Its GPU"
            value={backend}
            onChange={setBackend}
            options={[
              { id: "cuda", label: "NVIDIA (CUDA, faster)", help: "GeForce, RTX and other NVIDIA cards. Needs a recent NVIDIA driver." },
              { id: "vulkan", label: "AMD, Intel or other (Vulkan)", help: "Radeon, Arc and the rest. Works on NVIDIA too, a bit slower." },
            ]}
          />
        )}
      </div>
      <label className="field">
        <span>Helper port</span>
        <input className="input mono" aria-label="Helper port" aria-invalid={!!portError} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} />
        <span className="help">50052 unless another program on the PC uses it. A new port needs the new command there.</span>
        {portError && <span className="small pool-error">{portError}</span>}
      </label>
    </>
  );
  const shareButton = canShare && (
    <button className="btn small pool-share" onClick={() => void share()}>
      <Share2 size={14} aria-hidden="true" /> Send it to yourself
    </button>
  );
  const run = (
    <div className="pool-run" ref={runBox}>
      <div className="pool-label">Run this on {saved?.name || "the PC"}</div>
      {!saved ? (
        <p className="help">Add it, and the command to run there shows here.</p>
      ) : dirty ? (
        <p className="help">Save your changes to get the command for them.</p>
      ) : commandError ? (
        <div role="alert" className="small">
          <p className="pool-error" style={{ margin: "4px 0" }}>Couldn't get the command: {commandError}</p>
          <button className="btn small" onClick={() => loadCommand(saved)}>
            Try again
          </button>
        </div>
      ) : !command ? (
        <p className="muted small" role="status">
          Making the command…
        </p>
      ) : (
        <>
          {command.short ? (
            <>
              {/* Short enough to type on the PC: it fetches the full command from this hub over Tailscale. */}
              <p className="help" style={{ margin: "4px 0 0" }}>
                {saved.os === "windows" ? "On the PC, open PowerShell, type this and press Enter." : "On it, open a terminal, type this and press Enter."} Keep the window open while you use the pool, and run it again after the {saved.os === "windows" ? "PC" : "computer"} restarts.
              </p>
              <div className="command-box">
                <code tabIndex={0}>{command.short}</code>
                <button className="btn small ghost" onClick={() => void copy("short")} aria-label={copied === "short" ? "Copied" : "Copy short command"}>
                  {copied === "short" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied === "short" ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          ) : (
            <p className="help" style={{ margin: "4px 0 0" }}>
              {saved.os === "windows" ? "Open PowerShell on the PC, paste this and press Enter." : "Open a terminal on it, paste this and press Enter."} Keep the window open while you use the pool.
            </p>
          )}
          <p className="help" style={{ margin: "4px 0 0" }}>On your phone? {canShare ? "Send it to yourself" : "Email or message it to yourself"} and open it on the PC, or open Crosstalk there to copy it.</p>
          {shareButton}
          {command.short && <div className="pool-label" style={{ marginTop: 8 }}>Or paste the full command</div>}
          <div className="command-box">
            {/* Scrolls when it's long (Windows' is): reachable by keyboard too. */}
            <code tabIndex={0}>{command.command}</code>
            <button className="btn small ghost" onClick={() => void copy("long")} aria-label={copied === "long" ? "Copied" : "Copy command"}>
              {copied === "long" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied === "long" ? "Copied" : "Copy"}
            </button>
          </div>
          {command.notes.length > 0 && (
            <ul className="help pool-notes">
              {command.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );

  return (
    <Dialog
      title={saved ? saved.name : "Add a Windows or other PC"}
      icon={<Monitor size={20} aria-hidden="true" />}
      dirty={dirty && !!(name.trim() || address.trim()) && !busy}
      onClose={() => !busy && onClose()}
      footer={(requestClose) =>
        dirty ? (
          <>
            <button className="btn" onClick={() => requestClose()} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void submit()} disabled={!canSave}>
              {busy ? "Saving…" : saved ? "Save" : "Add it"}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={() => requestClose()}>
            Done
          </button>
        )
      }
    >
      {saved ? (
        // Saved: what to run there comes first; its details can still be changed below.
        <>
          {run}
          <div className="divider" />
          {form}
        </>
      ) : (
        <>
          <p className="help" style={{ marginTop: 0 }}>
            The PC lends its GPU by running a small helper. It needs Tailscale, signed in to the same tailnet as this hub.
          </p>
          {form}
          {run}
        </>
      )}
    </Dialog>
  );
}

/** A Linux machine joins as a Crosstalk hub: Crosstalk runs everything there itself. */
function LinuxDialog({ onClose, onSetUp }: { onClose: () => void; onSetUp: () => void }) {
  return (
    <Dialog
      title="Add a Linux machine"
      icon={<Server size={20} aria-hidden="true" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onClose();
              onSetUp();
            }}
          >
            Set up a Linux machine
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>Set Crosstalk up on the Linux machine once, and it does everything there itself: it installs llama.cpp, finds the GPU and starts the helper whenever the pool starts.</p>
      <p className="help">Settings → Machines → Set up a Linux machine gives you one command to run there. Once it's linked, it shows up here, switched on (it becomes the main machine unless you picked another). Already linked? It's in the list above.</p>
    </Dialog>
  );
}
