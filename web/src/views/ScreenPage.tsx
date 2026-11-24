// Screen (sidebar → Screen): the machine's screen, live, with buttons that take the view to the window an agent is
// using; and, once you take control, your taps and typing go to it as if you sat there. Before any of that works the
// machine's own screen sharing has to be on and Crosstalk given its password: this page says how, and takes it.
//
// The picture is drawn by noVNC (loaded only when this page opens) over a WebSocket the machine has already signed in
// for, so this device never holds the screen's password (hub/src/screen/proxy.ts).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Keyboard, Maximize2, Minimize2, Minus, MonitorSmartphone, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { ScreenStatus, ScreenWindow } from "@crosstalk/shared";
import { api, currentConnection } from "../api";
import { KEY, MAX_ZOOM, fitZoom, keysFor, screenHeading, screenSocketUrl, windowButtons, windowLabel, windowPlace } from "../screen";
import { machineName, useStore } from "../store";
import { Switch } from "../ui";
import { SidebarButton } from "./ChatSidebar";
import { MachinePicker } from "./MachinePicker";

/** The keys a phone's keyboard hasn't got: what the button says, the key, and its name for a screen reader. */
const KEY_BUTTONS: [string, number, string?][] = [
  ["Return", KEY.return],
  ["Esc", KEY.escape, "Escape"],
  ["Tab", KEY.tab],
  ["Delete", KEY.backspace],
  ["Space", KEY.space],
  ["←", KEY.left, "Left"],
  ["↑", KEY.up, "Up"],
  ["↓", KEY.down, "Down"],
  ["→", KEY.right, "Right"],
];

/** The parts of noVNC's viewer this page uses. */
interface Viewer extends EventTarget {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  background: string;
  focusOnClick: boolean;
  disconnect(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  focus(options?: FocusOptions): void;
}

export function ScreenPage() {
  const conn = useStore((s) => s.conn);
  const hub = useStore((s) => s.hub);
  const active = useStore((s) => s.active);
  const toast = useStore((s) => s.toast);
  const machine = conn ? machineName(conn, hub) : "this machine";
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (check = false) => {
    try {
      setLoadError("");
      setStatus(await api<ScreenStatus>(check ? "POST" : "GET", check ? "/api/screen/check" : "/api/screen"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(/404|not found/i.test(msg) ? `${machine} runs an older Crosstalk that can't show its screen yet. Update it, then come back.` : msg);
    }
  }, [machine]);
  // Looked for afresh when the page opens, and for each machine picked.
  useEffect(() => {
    setStatus(null);
    void load(true);
  }, [active, load]);
  // The hub says when the screen becomes reachable (or stops being): no reload needed.
  const hubReady = hub?.screen?.ready;
  useEffect(() => {
    if (status && hubReady !== undefined && hubReady !== status.ready) void load();
  }, [hubReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (body: { password?: string | null; username?: string; agents?: boolean }) => {
    setBusy(true);
    try {
      setStatus(await api<ScreenStatus>("PUT", "/api/screen", body));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <SidebarButton />
        <div className="titles">
          <h1>Screen</h1>
          <div className="sub">{status?.ready ? `${machine}, live` : `What's on ${machine}'s screen`}</div>
        </div>
        <MachinePicker />
      </header>
      {loadError ? (
        <div className="page">
          <div className="page-inner">
            <p className="help" role="alert">
              {loadError}
            </p>
            <button className="btn small" onClick={() => void load(true)}>
              Try again
            </button>
          </div>
        </div>
      ) : !status ? (
        <div className="page">
          <p className="muted" role="status">
            Looking for the screen…
          </p>
        </div>
      ) : status.ready ? (
        // A new sign-in is a new picture (another account's desktop, or the desktop instead of a login screen): connected afresh.
        <LiveScreen key={`${active}|${status.username}|${status.separate ? "aside" : "desktop"}`} status={status} machine={machine} busy={busy} onAgents={(agents) => save({ agents })} onForget={() => save({ password: null })} onLost={() => void load(true)} onSave={save} />
      ) : (
        <div className="page">
          <div className="page-inner">
            <ScreenSetup status={status} machine={machine} busy={busy} onSave={save} onCheck={() => load(true)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Whether this device opens the screen in Control ("1") or Watch ("0"), once the person has chosen; else by what it is. */
const CONTROL_KEY = "crosstalk.screen.control.v1";
/** A device with a mouse starts in Control, as a remote desktop does; one with a finger starts in Watch, where the finger moves the view. */
function startsInControl(): boolean {
  try {
    const kept = localStorage.getItem(CONTROL_KEY);
    if (kept) return kept === "1";
  } catch {
    // storage unavailable: by what the device is
  }
  return typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
}

/**
 * The Mac account's password, and which account: Crosstalk fills in the one it runs as, whose desktop is on the Mac's
 * screen (macOS shows any other sign-in a login screen of its own). `compact`: on the live view, under what's wrong.
 */
function AccountSignIn({ status, machine, busy, onSave, compact }: { status: ScreenStatus; machine: string; busy: boolean; onSave: (b: { password?: string; username?: string }) => Promise<void>; compact?: boolean }) {
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(status.account || status.username || "");
  const [other, setOther] = useState(!status.account);
  return (
    <form
      className={`screen-account${compact ? " compact" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (password && username.trim()) void onSave({ password, username: username.trim() });
      }}
    >
      {other && (
        <label className="field">
          <span>Mac account name</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="The name you log in to the Mac with" />
        </label>
      )}
      <label className="field">
        <span>{other || !username ? "That account's password" : `Password for ${username} on ${machine}`}</span>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        <span className="help">
          The one you log in to {machine} with. Kept on {machine} only, and never sent to a device. You type it; no agent sees it.
          {!other && (
            <>
              {" "}
              <button type="button" className="link-btn" onClick={() => setOther(true)}>
                Use another account
              </button>
            </>
          )}
        </span>
      </label>
      <button className="btn primary" type="submit" disabled={busy || !password || !username.trim()}>
        {busy ? "Connecting…" : "Connect"}
      </button>
    </form>
  );
}

/** What has to happen once, at the machine, and the field for the password that comes out of it. */
function ScreenSetup({ status, machine, busy, onSave, onCheck }: { status: ScreenStatus; machine: string; busy: boolean; onSave: (b: { password?: string; username?: string }) => Promise<void>; onCheck: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const mac = status.platform === "darwin";
  // The Mac's own Screen Sharing (the hub says which account it runs as there): signed in to as that account. A
  // screen sharing password otherwise, and where an account was already what's set up.
  const [account, setAccount] = useState(mac && (!!status.account || !!status.username));
  const [checking, setChecking] = useState(false);
  return (
    <section className="card screen-setup" aria-labelledby="screen-setup-title">
      <h2 id="screen-setup-title" className="screen-setup-title">
        <MonitorSmartphone size={18} aria-hidden="true" /> {screenHeading(status, machine)}
      </h2>
      <p className="small">
        Crosstalk shows {machine}'s screen here, and lets you and your agents click and type on it, through {mac ? "the Mac's own Screen Sharing" : "a VNC server on that machine"}. That needs turning on once, at{" "}
        {machine} itself (or through a remote desktop app): {mac ? "macOS only lets a person do it." : "Crosstalk doesn't install one."}
      </p>
      {mac && account ? (
        <ol className="screen-steps">
          <li>
            On {machine}, open <b>System Settings → General → Sharing</b> and turn on <b>Screen Sharing</b>.
          </li>
          <li>Type the password you log in to {machine} with, below. Crosstalk signs in as that account, so you get the desktop that's on its screen.</li>
        </ol>
      ) : mac ? (
        <ol className="screen-steps">
          <li>
            On {machine}, open <b>System Settings → General → Sharing</b> and turn on <b>Screen Sharing</b>.
          </li>
          <li>
            Tap the <b>ⓘ</b> beside it, turn on <b>VNC viewers may control screen with password</b>, and choose a password (up to 8 characters; it's only for this).
          </li>
          <li>Type that password below. macOS shows this kind of sign-in a login screen of its own, not the desktop someone is using: it suits a Mac nobody is logged in to.</li>
        </ol>
      ) : (
        <ol className="screen-steps">
          <li>
            On {machine}, run a VNC server for its desktop on port 5900, reachable from the machine itself (<span className="mono">x11vnc</span>, <span className="mono">wayvnc</span> or your desktop's own screen sharing), with a password.
          </li>
          <li>Type that password below.</li>
        </ol>
      )}
      {/* With no password given yet the heading already says so. */}
      {status.problem && status.state !== "off" && !(status.state === "auth" && !status.hasPassword) && (
        <p className="help" role="alert">
          {status.problem}
        </p>
      )}
      {status.state === "off" && (
        <p className="help" role="status">
          Nothing is sharing the screen yet. Once it's on, this page notices within a couple of minutes, or tap Check now.
        </p>
      )}
      {account ? (
        <AccountSignIn status={status} machine={machine} busy={busy} onSave={onSave} />
      ) : (
        <>
          <label className="field">
            <span>Screen sharing password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder={status.hasPassword ? "Type it again to change it" : ""} />
            <span className="help">Kept on {machine} only, and never sent to a device. You type it; no agent sees it.</span>
          </label>
          <button className="btn primary" disabled={busy || !password} onClick={() => onSave({ password, username: "" })}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </>
      )}
      <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
        <button
          className="btn"
          disabled={busy || checking}
          onClick={async () => {
            setChecking(true);
            await onCheck();
            setChecking(false);
          }}
        >
          <RefreshCw size={14} className={checking ? "spin" : ""} /> Check now
        </button>
        {mac && (
          <button className="btn ghost small" onClick={() => setAccount((a) => !a)}>
            {account ? "Use a screen sharing password" : "Use the Mac's account"}
          </button>
        )}
      </div>
    </section>
  );
}

function LiveScreen({ status, machine, busy, onAgents, onForget, onLost, onSave }: { status: ScreenStatus; machine: string; busy: boolean; onAgents: (on: boolean) => void; onForget: () => void; onLost: () => void; onSave: (b: { password?: string; username?: string }) => Promise<void> }) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<"connecting" | "live" | "closed">("connecting");
  const [why, setWhy] = useState("");
  // Control or Watch: as this device was left, else Control with a mouse and Watch with a finger.
  const [control, setControlNow] = useState(startsInControl);
  const setControl = (on: boolean) => {
    setControlNow(on);
    setNudge(false);
    try {
      localStorage.setItem(CONTROL_KEY, on ? "1" : "0");
    } catch {
      // storage unavailable: it starts by what the device is next time
    }
  };
  // Watching, and a click or a key meant for the screen went nowhere: said, with the way to take control.
  const [nudge, setNudge] = useState(false);
  const [full, setFull] = useState(false);
  const [startedWithMouse] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches);
  const [keys, setKeys] = useState(false);
  const [text, setText] = useState("");
  const [windows, setWindows] = useState<ScreenWindow[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [options, setOptions] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const size = { width: status.width || 1920, height: status.height || 1080 };

  // The viewer: connected while this page is open, view-only until control is taken.
  useEffect(() => {
    const conn = currentConnection();
    if (!conn || !target.current) return;
    let gone = false;
    let rfb: Viewer | null = null;
    setState("connecting");
    setWhy("");
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (gone || !target.current) return;
      rfb = new RFB(target.current, screenSocketUrl(conn, location.origin)) as Viewer;
      rfb.viewOnly = true;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;
      rfb.focusOnClick = true;
      rfb.background = "#000";
      rfb.addEventListener("connect", () => !gone && setState("live"));
      rfb.addEventListener("securityfailure", (e) => !gone && setWhy(String((e as CustomEvent<{ reason?: string }>).detail?.reason ?? "")));
      rfb.addEventListener("disconnect", () => {
        if (gone) return;
        viewer.current = null;
        setState("closed");
      });
      viewer.current = rfb;
    });
    return () => {
      gone = true;
      viewer.current = null;
      try {
        rfb?.disconnect();
      } catch {
        // already closed
      }
    };
  }, [attempt]);
  useEffect(() => {
    if (viewer.current) viewer.current.viewOnly = !control;
    // (Without scrolling: the view is where the person put it.)
    if (control) viewer.current?.focus({ preventScroll: true });
    else setKeys(false);
  }, [control, state]);
  /** The keyboard goes back to the screen after a button of this page was used (zoom, a window): typing carries on. */
  const refocus = () => {
    if (control && !keys) viewer.current?.focus({ preventScroll: true });
  };
  // Watching: a key typed at the page (not into one of its own fields) is one meant for the screen.
  useEffect(() => {
    if (control || state !== "live") return;
    const typed = (e: KeyboardEvent) => {
      const at = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || at?.closest("input, textarea, select, [contenteditable]")) return;
      setNudge(true);
    };
    window.addEventListener("keydown", typed);
    return () => window.removeEventListener("keydown", typed);
  }, [control, state]);
  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(false), 8000);
    return () => clearTimeout(t);
  }, [nudge]);

  // Full screen: the picture and its bar alone, and (where the browser can) the keys a browser keeps for itself too.
  const canFull = typeof document !== "undefined" && !!document.fullscreenEnabled;
  type KeyLock = { lock?: () => Promise<void>; unlock?: () => void };
  useEffect(() => {
    const changed = () => {
      const on = !!root.current && document.fullscreenElement === root.current;
      setFull(on);
      if (!on) (navigator as Navigator & { keyboard?: KeyLock }).keyboard?.unlock?.();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) return void (await document.exitFullscreen());
      await root.current?.requestFullscreen();
      await (navigator as Navigator & { keyboard?: KeyLock }).keyboard?.lock?.().catch(() => {});
      refocus();
    } catch (e) {
      toast("error", `Couldn't go full screen: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // The windows on screen, kept fresh while watching.
  useEffect(() => {
    let live = true;
    const get = () =>
      api<{ windows: ScreenWindow[] }>("GET", "/api/screen/windows").then(
        (r) => live && setWindows(windowButtons(r.windows ?? [])),
        () => {},
      );
    void get();
    const t = setInterval(get, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // The view starts with the whole screen in it (all of it: as wide and as tall as fits), and keeps it so as the view
  // changes size (the window, full screen, a phone turned); a window's button zooms to that window.
  const viewWidth = () => scroller.current?.clientWidth ?? 390;
  const wholeZoom = () => {
    const el = scroller.current;
    const byWidth = fitZoom(viewWidth(), size.width);
    return el && el.clientHeight > 0 && size.height > 0 ? Math.min(byWidth, el.clientHeight / size.height) : byWidth;
  };
  const whole = useRef(true);
  const shown = zoom ?? wholeZoom();
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fit = () => {
      if (whole.current) setZoom(wholeZoom());
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const seen = new ResizeObserver(fit);
    seen.observe(el);
    return () => seen.disconnect();
  }, [size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const goTo = (w: ScreenWindow | null) => {
    setPicked(w?.id ?? null);
    whole.current = !w;
    const place = w ? windowPlace(w, viewWidth(), size.width) : { zoom: wholeZoom(), left: 0, top: 0 };
    setZoom(place.zoom);
    requestAnimationFrame(() => scroller.current?.scrollTo({ left: place.left, top: place.top }));
  };
  const zoomBy = (factor: number) => {
    const el = scroller.current;
    const least = wholeZoom();
    const next = Math.max(least, Math.min(MAX_ZOOM, shown * factor));
    whole.current = next <= least;
    // Keeps what's in the middle of the view in the middle.
    const cx = el ? (el.scrollLeft + el.clientWidth / 2) / shown : 0;
    const cy = el ? (el.scrollTop + el.clientHeight / 2) / shown : 0;
    setPicked(null);
    setZoom(next);
    requestAnimationFrame(() => el?.scrollTo({ left: cx * next - el.clientWidth / 2, top: cy * next - el.clientHeight / 2 }));
  };

  const press = (sym: number) => {
    viewer.current?.sendKey(sym, null, true);
    viewer.current?.sendKey(sym, null, false);
  };
  const type = () => {
    const v = viewer.current;
    if (!v || !text) return;
    for (const k of keysFor(text)) {
      if (k.shift) v.sendKey(KEY.shift, null, true);
      v.sendKey(k.sym, null, true);
      v.sendKey(k.sym, null, false);
      if (k.shift) v.sendKey(KEY.shift, null, false);
    }
    setText("");
  };

  return (
    <div className={`screen-live${full ? " full" : ""}`} ref={root}>
      {status.separate && (
        <section className="screen-aside" role="alert" aria-label="This isn't the desktop">
          <p>
            <b>This is a login screen macOS made for Crosstalk, not {machine}'s desktop.</b>{" "}
            {status.username
              ? `macOS shows ${status.username} a screen of its own because ${status.account || "another account"} is the one using ${machine}'s screen.`
              : "macOS does that when the sign-in is the screen sharing password alone."}{" "}
            Sign in as {status.account || "the account that's logged in there"} to see and control the desktop itself, the one a remote desktop app shows.
          </p>
          <AccountSignIn status={status} machine={machine} busy={busy} onSave={onSave} compact />
        </section>
      )}
      <div className="screen-bar" onClick={refocus}>
        <div className="seg" role="group" aria-label="What your taps do">
          <button className={!control ? "on" : ""} aria-pressed={!control} onClick={() => setControl(false)}>
            Watch
          </button>
          <button className={control ? "on" : ""} aria-pressed={control} onClick={() => setControl(true)} disabled={state !== "live"}>
            Control
          </button>
        </div>
        <div className="screen-zoom" role="group" aria-label="Zoom">
          <button className="icon-btn" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
            <Minus size={16} />
          </button>
          <button className="icon-btn" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>
            <Plus size={16} />
          </button>
        </div>
        {/* Always there (it only works in Control), so taking control doesn't move the picture under your finger. */}
        <button className={`icon-btn ${keys ? "on" : ""}`} aria-label="Keyboard" aria-pressed={keys} disabled={!control} onClick={() => setKeys((k) => !k)}>
          <Keyboard size={17} />
        </button>
        {canFull && (
          <button className={`icon-btn screen-full-btn ${full ? "on" : ""}`} aria-label={full ? "Leave full screen" : "Full screen"} aria-pressed={full} title={full ? "Leave full screen" : "Full screen"} onClick={() => void toggleFull()}>
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
        <button className={`icon-btn screen-options-btn ${options ? "on" : ""}`} aria-label="Options" aria-expanded={options} onClick={() => setOptions((o) => !o)}>
          <SlidersHorizontal size={17} />
        </button>
      </div>

      {options && (
        <div className="screen-options card">
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="title">Let agents use this screen</div>
              <p className="help" id="screen-agents-help" style={{ margin: "2px 0 0" }}>
                Agents on {machine} can then look at the screen, click and type: for apps without a command line, and to answer dialogs waiting on the screen. You can watch them here. Off: only you can.
              </p>
            </div>
            <Switch checked={status.agents} onChange={onAgents} disabled={busy} label="Let agents use this screen" describedBy="screen-agents-help" />
          </div>
          <button
            className="btn small"
            disabled={busy}
            onClick={() => {
              if (confirm(`Forget ${machine}'s screen sharing password? The screen can't be seen here, or used by agents, until you type it again.`)) onForget();
            }}
          >
            Forget the password
          </button>
        </div>
      )}

      <div className="screen-windows" role="group" aria-label="Go to a window" onClick={refocus}>
        <button className={`chip ${picked === null ? "on" : ""}`} aria-pressed={picked === null} onClick={() => goTo(null)}>
          Whole screen
        </button>
        {windows.map((w) => (
          <button key={w.id} className={`chip ${picked === w.id ? "on" : ""} ${w.agent ? "agent" : ""}`} aria-pressed={picked === w.id} onClick={() => goTo(w)} title={w.agent ? "An agent's window" : undefined}>
            {w.agent && <span className="chip-dot" aria-hidden="true" />}
            {windowLabel(w)}
          </button>
        ))}
      </div>

      <div
        className={`screen-view ${control ? "control" : ""}`}
        ref={scroller}
        aria-label={`${machine}'s screen`}
        // Watching with a mouse: a click on the picture was meant for the screen.
        onPointerDown={(e) => {
          if (!control && state === "live" && e.pointerType === "mouse") setNudge(true);
        }}
      >
        <div className="screen-target" ref={target} style={{ width: size.width * shown, height: size.height * shown }} />
        {state !== "live" && (
          <div className="screen-note" role="status">
            {state === "connecting" ? (
              "Connecting to the screen…"
            ) : (
              <>
                <p>{why || "The live view stopped."}</p>
                <button
                  className="btn small primary"
                  onClick={() => {
                    // A password that stopped working, or sharing turned off: the setup card says which.
                    if (why) onLost();
                    else setAttempt((a) => a + 1);
                  }}
                >
                  {why ? "See what's wrong" : "Connect again"}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {control && keys && (
        <div className="screen-keys">
          <form
            className="screen-type"
            onSubmit={(e) => {
              e.preventDefault();
              type();
            }}
          >
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Type on ${machine}`} aria-label={`Type on ${machine}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send" />
            <button className="btn small primary" type="submit" disabled={!text}>
              Type
            </button>
          </form>
          <div className="screen-keyrow" role="group" aria-label="Keys">
            {KEY_BUTTONS.map(([label, sym, name]) => (
              <button key={label} className="btn small" onClick={() => press(sym)} aria-label={name}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!control && nudge && (
        <p className="screen-hint screen-nudge small" role="status">
          You're only watching.{" "}
          <button className="link-btn" onClick={() => setControl(true)}>
            Take control
          </button>{" "}
          to click and type on {machine}.
        </p>
      )}
      {control && (
        <p className="screen-hint small muted">
          {keys
            ? "What you type goes to the window in front."
            : startedWithMouse
              ? "Your mouse and keyboard are this screen's. Full screen sends it the keys your browser keeps for itself."
              : "Tap to click, hold for a right click, two fingers to scroll. Watch lets you move the view with a finger again."}
        </p>
      )}
    </div>
  );
}
