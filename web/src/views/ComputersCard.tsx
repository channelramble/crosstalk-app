import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Laptop, Loader2, Plus } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { Dialog, copyText, Seg } from "../ui";
import { Tip } from "./Tip";

type Computer = { name: string; label: string; host: string; user: string; online: boolean; detail: string };

/** Computers the agents can run commands on, e.g. a MacBook with an iPhone plugged in. */
export function ComputersCard() {
  const toast = useStore((s) => s.toast);
  const status = useStore((s) => s.status);
  const connection = useStore((s) => s.conn);
  const [computers, setComputers] = useState<Computer[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [operations, setOperations] = useState(new Map<string, "test" | "remove">());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef(new Map<string, "test" | "remove">());
  const lifetime = useRef(0);
  const request = useRef(0);
  const revision = useRef(0);
  const changes = useRef(new Map<string, { revision: number; computer: Computer | null }>());
  const previousStatus = useRef(status);

  const load = useCallback(async () => {
    const id = ++request.current;
    const startedAt = revision.current;
    setError("");
    setLoading(true);
    try {
      const list = await api<Computer[]>("GET", "/api/computers");
      if (id !== request.current) return;
      // A refresh may have started before a test, disconnect or connection completed.
      const merged = new Map(list.map((computer) => [computer.name, computer]));
      for (const [name, change] of changes.current) {
        if (change.revision <= startedAt) continue;
        if (change.computer) merged.set(name, change.computer);
        else merged.delete(name);
      }
      setComputers([...merged.values()]);
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    lifetime.current++;
    changes.current.clear();
    pending.current.clear();
    setOperations(new Map());
    setComputers(null);
    setConnecting(false);
    void load();
    return () => { lifetime.current++; request.current++; };
  }, [connection, load]);
  useEffect(() => {
    if (status === "open" && previousStatus.current !== "open") void load();
    previousStatus.current = status;
  }, [status, load]);

  const updateComputer = (name: string, computer: Computer | null) => {
    changes.current.set(name, { revision: ++revision.current, computer });
    setComputers((list) => {
      if (!computer) return list?.filter((c) => c.name !== name) ?? null;
      if (!list?.some((c) => c.name === name)) return [...(list ?? []), computer];
      return list.map((c) => c.name === name ? computer : c);
    });
  };
  const finish = (name: string) => {
    pending.current.delete(name);
    setOperations(new Map(pending.current));
  };
  const test = async (c: Computer) => {
    if (pending.current.has(c.name)) return;
    const id = lifetime.current;
    const startedAt = changes.current.get(c.name)?.revision;
    const current = () => id === lifetime.current && changes.current.get(c.name)?.revision === startedAt;
    pending.current.set(c.name, "test");
    setOperations(new Map(pending.current));
    try {
      const r = await api<Computer>("POST", `/api/computers/${encodeURIComponent(c.name)}/test`);
      // The invite dialog may have reconnected this name with a different user while this test ran.
      if (!current()) return;
      updateComputer(c.name, r);
      toast(r.online ? "info" : "error", r.online ? `${c.label} is connected.` : r.detail);
    } catch (e) {
      if (current()) toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      if (id === lifetime.current) finish(c.name);
    }
  };
  const remove = async (c: Computer) => {
    if (pending.current.has(c.name)) return;
    if (!confirm(`Disconnect ${c.label}? Crosstalk removes its access key from that computer, so agents can no longer sign in to it.`)) return;
    const id = lifetime.current;
    pending.current.set(c.name, "remove");
    setOperations(new Map(pending.current));
    try {
      const r = await api<{ revoked: boolean }>("DELETE", `/api/computers/${encodeURIComponent(c.name)}`);
      if (id !== lifetime.current) return;
      updateComputer(c.name, null);
      if (r.revoked) toast("info", `${c.label} is disconnected and its access was removed.`);
      else toast("error", `${c.label} was removed from the list, but it couldn't be reached to remove access. Turn off Remote Login on it, or delete the "crosstalk-agents" line from ~/.ssh/authorized_keys there.`);
    } catch (e) {
      if (id === lifetime.current) toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      if (id === lifetime.current) {
        finish(c.name);
        void load();
      }
    }
  };

  return (
    <section aria-label="Computers agents can use" aria-busy={loading} style={{ marginTop: 28 }}>
      <div className="row wrap tip-line" style={{ marginBottom: 8 }}>
        <h2 className="section-title" style={{ margin: 0 }}>Computers agents can use</h2>
        <Tip topic="computers" />
        <button className="btn small primary tip-after" onClick={() => setConnecting(true)}>
          <Plus size={14} /> Connect a computer
        </button>
      </div>
      <p className="help" style={{ marginTop: 0 }}>
        Let agents run commands on another computer, for example your MacBook with an iPhone plugged in.
      </p>
      {error && <div role="alert"><p>{error}</p><button className="btn small" onClick={load} disabled={loading}>Retry</button></div>}
      {!computers && !error && <p className="help" role="status">Checking computers…</p>}
      {computers && computers.length > 0 && (
        <div className="list-group">
          {computers.map((c) => (
            <div key={c.name} className="list-row can-wrap names-wrap machine-row" style={{ cursor: "default" }}>
              <Laptop size={20} aria-hidden="true" />
              <div className="row-text">
                <div className="title">
                  {c.label} <span className={`pill ${c.online ? "green" : "orange"}`}>{c.online ? "Connected" : "Offline"}</span>
                </div>
                <div className="subtitle">
                  {c.user}@{c.host} · agents call it “{c.name}”{!c.online && ` · ${c.detail}`}
                </div>
              </div>
              <div className="row-actions">
                <button className="btn small ghost" onClick={() => test(c)} disabled={!!operations.get(c.name)}>
                  {operations.get(c.name) === "test" ? "Testing…" : "Test"}
                </button>
                <button className="btn small ghost danger" onClick={() => remove(c)} disabled={!!operations.get(c.name)}>
                  {operations.get(c.name) === "remove" ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {connecting && <ConnectDialog onConnected={(computer) => updateComputer(computer.name, computer)} onClose={() => (setConnecting(false), void load())} />}
    </section>
  );
}

/** Two steps on the other computer: turn on Remote Login, paste one command. The dialog notices when it connects. */
function ConnectDialog({ onClose, onConnected }: { onClose: () => void; onConnected: (computer: Computer) => void }) {
  const toast = useStore((s) => s.toast);
  const [commands, setCommands] = useState<{ mac: string; windows: string }>({ mac: "", windows: "" });
  const [os, setOs] = useState<"mac" | "windows">(() => (/windows/i.test(navigator.userAgent) ? "windows" : "mac"));
  const command = commands[os];
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState<Computer | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const invite = useRef<string | null>(null);
  const generation = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportConnected = useRef(onConnected);
  reportConnected.current = onConnected;

  const createInvite = () => {
    const id = ++generation.current;
    invite.current = null;
    setCommands({ mac: "", windows: "" });
    setError("");
    setPollError("");
    setExpired(false);
    setCopied(false);
    setConnected(null);
    clearTimeout(copyTimer.current);
    api<{ invite: string; command: string; windowsCommand?: string }>("POST", "/api/computers/invite")
      .then((r) => {
        if (id !== generation.current) return;
        invite.current = r.invite;
        setCommands({ mac: r.command, windows: r.windowsCommand ?? "" });
      })
      .catch((e) => { if (id === generation.current) setError(e instanceof Error ? e.message : String(e)); });
  };
  useEffect(() => {
    createInvite();
    return () => { generation.current++; clearTimeout(copyTimer.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow this dialog's own invite until its command has run (works even if the computer was connected before).
  useEffect(() => {
    if (connected || expired || !command || !invite.current) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const id = generation.current;
    const token = invite.current;
    const check = async () => {
      try {
        const r = await api<{ connected: Computer | null; waiting: boolean }>("GET", `/api/computers/invites/${encodeURIComponent(token)}`);
        if (live && id === generation.current) {
          setPollError("");
          if (r.connected) {
            invite.current = null;
            setConnected(r.connected);
            reportConnected.current(r.connected);
          } else if (!r.waiting) {
            invite.current = null;
            setExpired(true);
            setCopied(false);
          }
        }
      } catch (e) {
        if (live && id === generation.current) setPollError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live && id === generation.current && invite.current === token) timer = setTimeout(check, 2500);
      }
    };
    timer = setTimeout(check, 2500);
    return () => { live = false; clearTimeout(timer); };
  }, [connected, expired, command]);

  const copy = async () => {
    const id = generation.current;
    if (!command || expired || !invite.current) return;
    let ok = false;
    // Clipboard access can be absent entirely when a remote hub is opened over HTTP.
    try { ok = await copyText(command); } catch { /* offer manual copying below */ }
    if (id !== generation.current || !invite.current) return;
    if (ok) {
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } else toast("error", "Couldn't copy. Select the command and copy it instead.");
  };

  return (
    <Dialog title="Connect a computer" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>{connected ? "Done" : "Close"}</button>}>
      {error ? (
        <div role="alert"><p>{error}</p><button className="btn" onClick={createInvite}>Retry</button></div>
      ) : connected ? (
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          {connected.online ? <Check size={22} color="var(--green)" /> : <span style={{ color: "var(--orange)", fontWeight: 700 }}>!</span>}
          <div>
            <div style={{ fontWeight: 600 }}>{connected.online ? `${connected.label} is connected.` : `${connected.label} was added, but Crosstalk couldn't sign in to it yet.`}</div>
            <p className="help" style={{ margin: "4px 0 0" }}>
              {connected.online
                ? `Agents can now run commands on it. They call it “${connected.name}”. Ask them, for example, to check the iPhone that's plugged in.`
                : os === "windows"
                  ? `${connected.detail}. Check that the OpenSSH Server service is running on that PC (Services → OpenSSH SSH Server), then press Test.`
                  : `${connected.detail}. Check that Remote Login allows your user (System Settings → General → Sharing → Remote Login → Allow access), then press Test.`}
            </p>
          </div>
        </div>
      ) : (
        <>
        <Seg value={os} onChange={setOs} options={[{ id: "mac", label: "Mac or Linux" }, { id: "windows", label: "Windows" }]} />
        <ol className="steps" style={{ paddingLeft: 20, margin: "14px 0 0" }}>
          {os === "mac" ? (
            <li style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600 }}>On the computer you want to connect, turn on Remote Login</div>
              <div className="help">
                System Settings → General → Sharing → Remote Login.{" "}
                <a href="x-apple.systempreferences:com.apple.Sharing-Settings.extension">Open Sharing settings</a> (if you're on that Mac now).
              </div>
            </li>
          ) : (
            <li style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600 }}>On the PC, open PowerShell as administrator</div>
              <div className="help">Start menu → type PowerShell → right-click → Run as administrator. The PC needs Tailscale, signed in to the same tailnet as the hub.</div>
            </li>
          )}
          <li style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600 }}>{os === "mac" ? "Open Terminal there and paste this" : "Paste this into that PowerShell window"}</div>
            <div className="row" style={{ gap: 8, marginTop: 6, alignItems: "stretch" }}>
              <code className="mono" style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, background: "var(--code-bg)", overflowWrap: "anywhere", fontSize: 12 }}>
                {command || "Making a command…"}
              </code>
              <button className="btn small" onClick={copy} disabled={!command || expired} aria-label="Copy command">
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="help">
              Works for 15 minutes. It lets Crosstalk's agents sign in to that computer as you.
              {os === "windows" && " It also turns on Windows' built-in OpenSSH Server and allows it through the firewall."}
            </div>
          </li>
          <li>
            {expired ? (
              <div role="alert"><p className="help">This command expired.</p><button className="btn" onClick={createInvite}>Make a new command</button></div>
            ) : (
              <div className="row" style={{ gap: 8 }}>
                <Loader2 size={15} className="spin" aria-hidden="true" />
                <span>Waiting for the computer to connect…</span>
              </div>
            )}
            {pollError && <p role="status" className="help">Couldn't check the connection: {pollError}. Trying again…</p>}
          </li>
        </ol>
        </>
      )}
    </Dialog>
  );
}
