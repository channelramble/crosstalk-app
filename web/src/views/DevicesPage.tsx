import { useEffect, useState } from "react";
import { ComputersCard } from "./ComputersCard";
import QRCode from "qrcode";
import { ChevronLeft, Laptop, Monitor, Plus, Smartphone, Tablet } from "lucide-react";
import type { Device, MachineInfo } from "@crosstalk/shared";
import { api, currentConnection, isNative } from "../api";
import { pushSupported, rememberPushOff, subscribe } from "../push";
import { useMachines, useStore } from "../store";
import { Dialog, copyText, thisDevice, timeAgo, useIsMobile } from "../ui";

export function DeviceIcon({ platform }: { platform: string }) {
  if (/iPhone|Android phone|Android/.test(platform)) return <Smartphone size={20} />;
  if (/iPad|tablet/.test(platform)) return <Tablet size={20} />;
  if (/Macintosh|Mac/.test(platform)) return <Laptop size={20} />;
  return <Monitor size={20} />;
}

export function DevicesPage() {
  const mobile = useIsMobile();
  const setView = useStore((s) => s.setView);
  const disconnect = useStore((s) => s.disconnect);
  const toast = useStore((s) => s.toast);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    return api<Device[]>("GET", "/api/devices").then(setDevices).catch((e) => setError(e.message));
  };
  useEffect(() => {
    void load();
  }, []);

  const revoke = async (d: Device) => {
    if (!confirm(d.current ? "Sign this device out? You'll need a new pairing code to come back." : `Sign "${d.name}" out?`)) return;
    try {
      await api("DELETE", `/api/devices/${d.id}`);
      if (d.current) disconnect();
      else void load();
    } catch (e) { toast("error", e instanceof Error ? e.message : String(e)); }
  };
  const rename = async (d: Device) => {
    const name = prompt("Device name", d.name);
    if (!name) return;
    try {
      await api("PATCH", `/api/devices/${d.id}`, { name });
      void load();
    } catch (e) { toast("error", e instanceof Error ? e.message : String(e)); }
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
          <h1>Devices</h1>
          <div className="sub">Phones and computers that can use this hub</div>
        </div>
        <button className="btn small primary" onClick={() => setPairing(true)}>
          <Plus size={14} /> Pair a device
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          {error && <div role="alert"><p>{error}</p><button className="btn" onClick={load}>Retry</button></div>}
          <div className="list-group">
            {devices.map((d) => (
              <div key={d.id} className="list-row" style={{ cursor: "default" }}>
                <DeviceIcon platform={d.platform} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="title">
                    {d.name} {d.current && <span className="pill blue">This device</span>}
                  </div>
                  <div className="subtitle">
                    {d.platform || "Unknown"} · paired {timeAgo(d.createdAt)}
                    {d.lastSeenAt ? ` · active ${timeAgo(d.lastSeenAt)}` : ""}
                  </div>
                </div>
                <button className="btn small ghost" onClick={() => rename(d)}>
                  Rename
                </button>
                <button className="btn small ghost danger" onClick={() => revoke(d)}>
                  Sign out
                </button>
              </div>
            ))}
          </div>
          <p className="help" style={{ marginTop: 14 }}>
            Devices reach the hub over your Tailscale network. Signing a device out revokes its key immediately.
          </p>
          <ComputersCard />
          <NotificationsCard />
        </div>
      </div>
      {pairing && <PairDialog onClose={() => (setPairing(false), void load())} />}
    </>
  );
}

/**
 * Notifications on this device. They always come through the machine this app opens from (its service worker asks that
 * hub for their text), whichever machine is picked at the top: with another one picked, the card says so.
 */
export function NotificationsCard() {
  const toast = useStore((s) => s.toast);
  const active = useStore((s) => s.active);
  const machines = useMachines((m) => m.list);
  const home = machines.find((m) => m.key === "");
  const shown = machines.find((m) => m.key === active);
  const conn = home?.conn;
  const supported = pushSupported();
  // On the hub: whether it sends here, and its key. In this browser: whether it can still show them.
  const [state, setState] = useState<{ subscribed: boolean; here: boolean; publicKey: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Whether the machine picked at the top is linked with the home one (so its notifications come through it).
  const [linked, setLinked] = useState<boolean | null>(null);
  const iosNotInstalled = /iPhone|iPad/.test(navigator.userAgent) && !(navigator as Navigator & { standalone?: boolean }).standalone;

  const load = () => {
    if (!supported || !conn) return;
    setError("");
    void (async () => {
      const k = await api<{ publicKey: string; subscribed: boolean }>("GET", "/api/push/key", undefined, conn);
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState({ publicKey: k.publicKey, subscribed: k.subscribed, here: !!sub });
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [supported, conn?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back after the hub restarted, say.
  const homeStatus = home?.status;
  useEffect(() => {
    if (homeStatus === "open" && error) load();
  }, [homeStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const other = !!home && !!shown && shown.key !== home.key;
  useEffect(() => {
    setLinked(null);
    if (!other || !conn) return;
    const id = shown?.hub?.id;
    api<MachineInfo[]>("GET", "/api/machines", undefined, conn)
      .then((list) => setLinked(list.some((l) => l.scope !== "peer" && (l.id === id || l.url.replace(/\/+$/, "") === shown?.conn.baseUrl.replace(/\/+$/, "")))))
      .catch(() => setLinked(null));
  }, [other, conn?.token, shown?.key, shown?.hub?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const enable = async () => {
    if (!conn || !state) return;
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site in your browser settings.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await subscribe(reg, state.publicKey);
      await api("POST", "/api/push/subscribe", { endpoint: sub.endpoint }, conn);
      rememberPushOff(false);
      setState((s) => (s ? { ...s, subscribed: true, here: true } : s));
      toast("info", "Notifications are on for this device.");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    if (!conn) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }, conn);
        await sub.unsubscribe();
      }
      rememberPushOff(true);
      setState((s) => (s ? { ...s, subscribed: false, here: false } : s));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const on = !!state?.subscribed && state.here;
  return (
    <section className="card" style={{ marginTop: 16 }} aria-label="Notifications on this device">
      <h3>Notifications on this device</h3>
      <p className="muted small" style={{ margin: "4px 0 10px" }}>
        Get a notification when an agent needs approval, hits an error, or finishes a long task, even with the app closed.
      </p>
      {other && home && shown && (
        <p className="help" role="note">
          {linked === false
            ? `Notifications from ${shown.name} don't reach ${thisDevice()}: ${shown.name} isn't linked with ${home.name}. Link it in Settings → Machines → Add a machine that runs Crosstalk.`
            : `Notifications from ${shown.name} come through ${home.name}: turning them on here covers both.`}
        </p>
      )}
      {isNative ? (
        <p className="small">The app shows notifications while it's running. Background notifications for the native app are coming in a later version.</p>
      ) : !supported ? (
        <p className="small">This browser can't receive push notifications{location.protocol !== "https:" ? " over plain http — open the hub through its https (Tailscale) address" : ""}.</p>
      ) : iosNotInstalled ? (
        <p className="small">On iPhone and iPad, add Crosstalk to your Home Screen first (Share → Add to Home Screen), then turn notifications on from the installed app.</p>
      ) : !conn ? (
        <p className="small">Notifications come through the machine this app opens from ({location.host}). Add it to {thisDevice()} again in Settings → Machines to turn them on.</p>
      ) : error && !state ? (
        <div role="alert">
          <p className="small" style={{ margin: "0 0 6px" }}>Couldn't check notifications on {home?.name ?? "this machine"}: {error}</p>
          <button className="btn small" onClick={load}>
            Retry
          </button>
        </div>
      ) : on ? (
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="pill green">On</span>
          <button className="btn small" disabled={busy} onClick={() => api("POST", "/api/push/test", undefined, conn).then(() => toast("info", "Sent a test notification.")).catch((e) => toast("error", e.message))}>
            Send a test
          </button>
          <button className="btn small ghost danger" disabled={busy} onClick={disable}>
            Turn off
          </button>
        </div>
      ) : (
        <>
          {state?.subscribed && !state.here && (
            <p className="small" role="alert" style={{ color: "var(--orange)", marginTop: 0 }}>
              Notifications stopped on {thisDevice()}. Turn them on again.
            </p>
          )}
          <button className="btn primary" disabled={busy || !state?.publicKey} onClick={enable}>
            {busy ? "Turning on…" : "Turn on notifications"}
          </button>
          {!state && !error && <p className="help" role="status">Checking…</p>}
        </>
      )}
    </section>
  );
}

export function PairDialog({ onClose }: { onClose: () => void }) {
  const hub = useStore((s) => s.hub);
  const toast = useStore((s) => s.toast);
  const [code, setCode] = useState<{ code: string; expiresAt: number; url: string | null } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState("");
  const base = hub?.publicUrl || currentConnection()?.baseUrl || location.origin;
  const link = code ? `${base}/#pair=${code.code}` : "";
  const load = () => {
    setError("");
    api<{ code: string; expiresAt: number; url: string | null }>("POST", "/api/pairing-codes")
      .then(setCode)
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
  }, [toast]);
  useEffect(() => {
    if (link) void QRCode.toDataURL(link, { margin: 1, width: 220 }).then(setQr).catch(() => toast("error", "Couldn't make a QR code. Enter the pairing code instead."));
  }, [link]);
  // The code works for a while only (30 minutes; hub/src/auth.ts PAIRING_TTL_MS). This screen is the one left open
  // while the person walks to the other device, so once it has run out it stops offering it and says so, with a way
  // to make another, instead of a code the hub refuses with "That code is wrong or expired" over there.
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!code) return;
    const check = () => {
      if (Date.now() >= code.expiresAt) setExpired(true);
    };
    const timer = setTimeout(check, Math.max(0, code.expiresAt - Date.now()));
    // A phone asleep or in another app may hold the timer back: look again on the way back.
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [code]);
  const again = () => {
    setCode(null);
    setQr(null);
    load();
  };
  const until = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <Dialog title="Pair a device" onClose={onClose}>
      {!code ? (
        error ? <div role="alert"><p>{error}</p><button className="btn" onClick={load}>Retry</button></div> : <p className="muted">Making a code…</p>
      ) : expired ? (
        <div role="alert" style={{ textAlign: "center" }}>
          <p style={{ marginTop: 0 }}>This code ran out at {until(code.expiresAt)}, so the other device can't use it. Make a new one to pair a device.</p>
          <button className="btn primary" onClick={again}>
            Make a new code
          </button>
        </div>
      ) : (
        <div style={{ textAlign: "center" }}>
          <p className="small muted" style={{ marginTop: 0 }}>
            On the new device, scan this with the camera, or open the Crosstalk app and enter the hub address and code.
          </p>
          {qr && <img src={qr} alt="Pairing QR code" width={220} height={220} style={{ borderRadius: 12, background: "white", padding: 6 }} />}
          <div style={{ margin: "12px 0 6px" }}>
            <div className="code-big">{code.code}</div>
          </div>
          <div className="small mono" style={{ wordBreak: "break-all" }}>
            {base}
          </div>
          <div className="row" style={{ justifyContent: "center", gap: 8, marginTop: 10 }}>
            <button className="btn small" onClick={() => copyText(link).then((ok) => ok && toast("info", "Pairing link copied"))}>
              Copy link
            </button>
          </div>
          <p className="tiny muted">Works once · expires at {until(code.expiresAt)}</p>
        </div>
      )}
    </Dialog>
  );
}
