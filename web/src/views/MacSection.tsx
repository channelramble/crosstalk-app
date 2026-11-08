import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, HelpCircle, Info, SquareTerminal, TriangleAlert } from "lucide-react";
import { MAC_LOGIN_WAIT_MS, type MacCrash, type MacDialog, type MacStatus, type PtyInfo } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { namesText } from "../pool";
import { useStore } from "../store";
import { ConfirmButton, Dialog, timeAgo } from "../ui";
import { useReconnected } from "../useReconnected";
import { useMachineName } from "./MachinePicker";
import { Terminal } from "./Terminal";
import { TipHeading } from "./Tip";

type Pane = "fullDisk" | "login" | "energy" | "updates" | "privacy";
type Fix = "autologin" | "power";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One thing that keeps the Mac from running on its own: ok, a problem, a choice with a trade-off, or not known. */
interface Row {
  title: string;
  ok: boolean | null | "optional";
  text: string;
  /** Fixed from here, in a terminal on the Mac where the person types their own password. */
  fix?: Fix;
  fixLabel?: string;
  /** Only changeable at the Mac itself (no software can): its page of System Settings opens there. */
  pane?: Pane;
  /** Changed somewhere else on the web (from the phone too). */
  link?: { href: string; label: string };
}

/** What each row says, from what the hub read on the Mac (mac.ts). */
export function macRows(s: MacStatus, machine: string): Row[] {
  const rows: Row[] = [];
  rows.push(
    s.autoLogin
      ? { title: "Starts again after a restart", ok: true, text: `After an update or a power cut, ${machine} logs in as ${s.autoLogin} by itself and Crosstalk starts.` }
      : s.fileVault
        ? { title: "Starts again after a restart", ok: false, text: `FileVault is on, so after a restart ${machine} waits for its password and Crosstalk can't start until someone types it there.` }
        : {
            title: "Starts again after a restart",
            ok: s.autoLogin === null && s.fileVault === null ? null : false,
            text: `After an update or a power cut, ${machine} waits at the login screen, and Crosstalk can't start until someone logs in. Turn on automatic login from here: a terminal opens on ${machine} for your Mac password. Anyone who sits at ${machine} can then use it.`,
            fix: "autologin",
            fixLabel: "Turn on automatic login",
          },
  );
  const sleeps = s.sleepMinutes !== null && s.sleepMinutes > 0;
  const off = s.restartsAfterPowerCut === false;
  rows.push({
    title: "Stays on",
    ok: s.sleepMinutes === null ? null : !sleeps && !off,
    text: [
      sleeps ? `It sleeps after ${s.sleepMinutes} minute${s.sleepMinutes === 1 ? "" : "s"} with nobody using it, and chats stop until it wakes.` : s.sleepMinutes === 0 ? "It never sleeps." : null,
      off ? "After a power cut it stays off until someone presses its button." : s.restartsAfterPowerCut ? "It starts up again after a power cut." : null,
    ]
      .filter(Boolean)
      .join(" "),
    ...(sleeps || off ? { fix: "power" as const, fixLabel: "Keep it on" } : {}),
  });
  rows.push(
    s.fullDiskAccess
      ? { title: "Never asks about files", ok: true, text: "Full Disk Access is on: agents read any file without macOS asking, Mail and Messages included." }
      : {
          title: "Never asks about files (optional)",
          ok: s.fullDiskAccess === null ? null : "optional",
          text: `The folders and drives agents use are allowed already. The rest (Mail, Messages, other apps' data) is refused without a dialog, or asked about on ${machine}'s screen. Full Disk Access ends that, as on Linux, but then every agent, or a web page that tricks one, can read everything without anything showing. Only someone at ${machine} can turn it on.`,
          pane: "fullDisk",
        },
  );
  if (s.tailscaleExpiry !== undefined) {
    const soon = s.tailscaleExpiry !== null;
    rows.push({
      title: "Stays reachable",
      ok: !soon,
      text: soon
        ? `Tailscale signs ${machine} out on ${new Date(s.tailscaleExpiry!).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}, and then nothing reaches it, this app included. Turn off key expiry for it in Tailscale's admin console (it works from your phone): Machines, then ${machine}'s menu, then Disable key expiry.`
        : `Tailscale never signs ${machine} out (its key expiry is off).`,
      link: soon ? { href: "https://login.tailscale.com/admin/machines", label: "Open Tailscale's admin console" } : undefined,
    });
  }
  if (s.autoUpdates)
    rows.push({
      title: "Updates",
      ok: !!s.autoLogin,
      text: s.autoLogin ? "macOS installs its updates and restarts by itself; Crosstalk starts again afterwards." : "macOS installs its updates and restarts by itself, then waits at the login screen (see above).",
    });
  return rows;
}

/** How long something has waited: "under a minute", "14 min", "2 h 5 min". */
export function waited(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** A dialog waiting on the Mac, in a line: "adb wants files on external drives · waiting 14 min". */
export function dialogLine(d: MacDialog, now = Date.now()): string {
  return `${d.app} wants ${d.wants}${d.count > 1 ? ` (asked ${d.count} times)` : ""} · waiting ${waited(now - d.since)}`;
}

/** The program asking, for the Stop button ("adb", from "adb (started by an older Crosstalk)"). */
const programOf = (d: MacDialog) => d.app.replace(/ \(.*\)$/, "");

/** A time on this device's clock: "2:41 AM" today, "3:19 AM yesterday", or "3:19 AM on Oct 25". */
export function clockWords(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `${time} yesterday`;
  return `${time} on ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/**
 * What the notice after the Mac went down says (the hub finds it when it starts, mac.ts): what happened and when, what's
 * plugged into the port that faulted, what to change, and how long Crosstalk was off.
 */
export function crashText(c: MacCrash, machine: string, s: { autoLogin: string | null; fileVault: boolean | null }, now = Date.now()): { title: string; lines: string[] } {
  const usb = c.cause === "a fault on a USB port";
  const atLogin = c.waitedMs > MAC_LOGIN_WAIT_MS;
  const lines = [
    c.kind === "crash" ? `At ${clockWords(c.at, now)}: ${c.cause ?? "a kernel panic"}.` : `Around ${clockWords(c.at, now)}: it may have lost power or frozen.`,
    usb && c.devices.length ? `Plugged into that port when it restarted: ${namesText(c.devices)}.` : null,
    usb ? `Plug the drive straight into ${machine} or into a different port, and leave out cheap hubs and adapters: a fault like this restarts the whole machine.` : null,
    `Crosstalk was off for ${waited(c.backAt - c.at)}, until ${clockWords(c.backAt, now)}${atLogin ? `: ${machine} waited at the login screen for someone to log in.` : "."}`,
    !atLogin ? null : s.autoLogin ? "Automatic login is on now, so next time it starts by itself." : s.fileVault ? "With FileVault on it can't log in by itself (see below)." : "Turn on automatic login below and next time it starts by itself.",
  ];
  return { title: c.kind === "crash" ? `${machine} crashed and restarted` : `${machine} restarted without shutting down`, lines: lines.filter((l): l is string => !!l) };
}

/**
 * Settings → This Mac (on a Mac hub): what keeps it from running on its own like a server, and the dialogs waiting on
 * its screen, all handled from here. What can only change at the Mac (Full Disk Access) says so; macOS lets no
 * software answer its dialogs, so the program asking can be stopped instead.
 */
export function MacSection() {
  const hub = useStore((s) => s.hub);
  const dialogs = useStore((s) => s.macDialogs);
  const loadMac = useStore((s) => s.loadMac);
  const openOnMac = useStore((s) => s.openOnMac);
  const dismiss = useStore((s) => s.dismissMacDialog);
  const stop = useStore((s) => s.stopMacAsker);
  const fixOnMac = useStore((s) => s.fixOnMac);
  const dismissCrash = useStore((s) => s.dismissMacCrash);
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  const [status, setStatus] = useState<MacStatus | null>(null);
  const [error, setError] = useState("");
  /** Its hub is older than This Mac. */
  const [older, setOlder] = useState(false);
  const [opening, setOpening] = useState(false);
  /** The fix being run, and its terminal on the Mac once it's started. */
  const [fixing, setFixing] = useState<{ what: Fix; pty: PtyInfo | null } | null>(null);
  const startFix = async (what: Fix) => {
    setFixing({ what, pty: null });
    try {
      const pty = await fixOnMac(what);
      setFixing((f) => (f?.what === what ? { what, pty } : f));
    } catch (e) {
      toast("error", message(e));
      setFixing(null);
    }
  };
  const mac = hub?.platform === "darwin";
  const load = () =>
    loadMac().then(
      (s) => {
        setStatus(s);
        setError("");
      },
      (e) => {
        if (e instanceof ApiError && e.status === 404 && e.code !== "not_mac") setOlder(true);
        else setError(message(e));
      },
    );
  useEffect(() => {
    if (mac) void load();
  }, [mac]); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => {
    if (mac && !older) void load();
  });
  if (!mac) return null;
  if (older)
    return (
      <>
        <TipHeading id="this-mac" topic="thisMac">This Mac</TipHeading>
        <p className="help">Update Crosstalk on {machine} to see and fix here what keeps it from running on its own.</p>
      </>
    );

  const open = async (pane: Pane) => {
    setOpening(true);
    try {
      await openOnMac(pane);
      toast("info", `Opened in System Settings on ${machine}, for when you're there.`);
    } catch (e) {
      toast("error", message(e));
    } finally {
      setOpening(false);
    }
  };
  const rows = status ? macRows(status, machine) : [];
  return (
    <>
      <TipHeading id="this-mac" topic="thisMac">This Mac</TipHeading>
      {status?.lastCrash && <CrashNotice crash={status.lastCrash} status={status} machine={machine} onDismiss={() => void dismissCrash().then(setStatus, (e) => toast("error", message(e)))} />}
      {dialogs.length > 0 && (
        <div className="card mac-waiting" role="region" aria-label={`Waiting for an answer on ${machine}`}>
          <div className="pool-setting-title" role="status">
            Waiting for an answer on {machine}
          </div>
          {dialogs.map((d) => (
            <div key={d.id} className="mac-dialog">
              <span className="small">{dialogLine(d)}</span>
              <div className="mac-dialog-actions">
                {d.stoppable && (
                  <ConfirmButton
                    label={`Stop ${programOf(d)}`}
                    question={`Stop ${programOf(d)}? Whatever it was doing ends.`}
                    confirmLabel="Stop it"
                    onConfirm={() => void stop(d.id).then(() => toast("info", `${programOf(d)} stopped. Nothing waits on the question now, though it may stay on ${machine}'s screen.`), (e) => toast("error", message(e)))}
                  />
                )}
                <button className="btn small ghost" onClick={() => void dismiss(d.id).catch((e) => toast("error", message(e)))}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
          <p className="help mac-note">macOS lets no software answer these, from here or anywhere. Stop the program asking (it gets no access, and nothing waits on it), or Dismiss one that was answered while the hub wasn't watching.</p>
        </div>
      )}
      <div className="card mac-server">
        <div className="pool-setting-title">As a server</div>
        <p className="help mac-note">What keeps {machine} running on its own, like a Linux server, with nobody at it.</p>
        {error && (
          <p className="small pool-error">
            {error}{" "}
            <button className="link-btn" onClick={() => void load()}>
              Try again
            </button>
          </p>
        )}
        {!status && !error && <p className="help">Checking…</p>}
        {rows.map((r) => (
          <div key={r.title} className="mac-row">
            <span className={`mac-mark ${r.ok === true ? "ok" : r.ok === false ? "bad" : r.ok === "optional" ? "optional" : "unknown"}`} aria-label={r.ok === true ? "Fine" : r.ok === false ? "Needs a change" : r.ok === "optional" ? "Your choice" : "Not known"}>
              {r.ok === true ? <CircleCheck size={18} /> : r.ok === false ? <CircleAlert size={18} /> : r.ok === "optional" ? <Info size={18} /> : <HelpCircle size={18} />}
            </span>
            <div className="mac-row-text">
              <div className="mac-row-title">{r.title}</div>
              <div className="help">{r.text}</div>
              {r.fix && r.ok !== true && (
                <button className="btn small primary" onClick={() => void startFix(r.fix!)} disabled={fixing !== null}>
                  <SquareTerminal size={14} aria-hidden /> {r.fixLabel}
                </button>
              )}
              {r.link && (
                <a className="btn small" href={r.link.href} target="_blank" rel="noreferrer noopener">
                  {r.link.label}
                </a>
              )}
              {r.pane && r.ok !== true && (
                <button className="link-btn small" onClick={() => void open(r.pane!)} disabled={opening}>
                  {opening ? "Opening…" : "Open it in System Settings there"}
                </button>
              )}
            </div>
          </div>
        ))}
        {status && <p className="tiny muted mac-note">Checked {timeAgo(status.checkedAt)}.</p>}
      </div>
      {fixing && (
        <FixDialog
          what={fixing.what}
          pty={fixing.pty}
          machine={machine}
          onClose={() => {
            setFixing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

/** The Mac went down without shutting down (for a week, until it's dismissed): what happened and what to change. */
function CrashNotice({ crash, status, machine, onDismiss }: { crash: MacCrash; status: MacStatus; machine: string; onDismiss: () => void }) {
  const { title, lines } = crashText(crash, machine, status);
  return (
    <div className="card mac-crash" role="region" aria-label={title}>
      <div className="mac-row">
        <span className="mac-mark bad" aria-hidden>
          <TriangleAlert size={18} />
        </span>
        <div className="mac-row-text">
          <div className="mac-row-title">{title}</div>
          {lines.map((l) => (
            <div key={l} className="help">
              {l}
            </div>
          ))}
          {crash.detail && <div className="tiny muted mono mac-crash-detail">macOS said: {crash.detail}</div>}
          <button className="btn small ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A fix run in a terminal on the Mac (POST /api/mac/fix): sudo, then for automatic login the user's password again.
 * The person types their own password into the field, which sends it to the terminal only (it isn't shown or kept).
 */
function FixDialog({ what, pty, machine, onClose }: { what: Fix; pty: PtyInfo | null; machine: string; onClose: () => void }) {
  const sendPty = useStore((s) => s.sendPty);
  const [typed, setTyped] = useState("");
  const alive = useStore((s) => (pty ? (s.ptys[pty.id]?.alive ?? true) : true));
  const close = () => {
    if (pty && alive) void api("DELETE", `/api/pty/${pty.id}`).catch(() => {});
    onClose();
  };
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pty || !typed) return;
    sendPty(pty.id, `${typed}\r`);
    setTyped("");
  };
  const title = what === "autologin" ? "Turn on automatic login" : "Keep it on";
  return (
    <Dialog title={title} onClose={close} footer={<button className="btn primary" onClick={close}>{alive ? "Cancel" : "Done"}</button>}>
      <p className="help" style={{ marginTop: 0 }}>
        {what === "autologin"
          ? `Type your Mac password for ${machine} below: once for sudo, then once more for the login itself. It goes to ${machine} only; Crosstalk doesn't keep it. After a restart, anyone at its keyboard can use it until its screen locks.`
          : `Type your Mac password for ${machine} below, for sudo: it then never sleeps, starts up after a power cut and wakes for the network. It goes to ${machine} only; Crosstalk doesn't keep it.`}
      </p>
      {!pty && <p className="help">Opening a terminal on {machine}…</p>}
      {pty && (
        <>
          <div className="mac-term">
            <Terminal ptyId={pty.id} />
          </div>
          {alive ? (
            <form className="term-paste" onSubmit={send}>
              <label className="field">
                <span>Mac password</span>
                <input className="input" type="password" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="current-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send" />
              </label>
              <button className="btn primary" type="submit" disabled={!typed}>
                Send
              </button>
            </form>
          ) : (
            <p className="help">Finished. This Mac checks again when you close this.</p>
          )}
        </>
      )}
    </Dialog>
  );
}
