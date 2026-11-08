// Installing an agent where it's needed, without leaving the screen: OpenCode's card in Settings → AI services and the
// Add sheet share this. It is the same install as Claude Code's and Codex's (POST /api/providers/:p/install runs the
// installer in a terminal on the hub), watched here until it ends and then checked: only the hub's own word that the agent
// is there counts as installed.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { PROVIDER_INFO, type Provider, type ProviderStatus, type PtyInfo } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { errorMessage, installFailure, installWords, noDot, openCodeState, type InstallPhase } from "../services";
import { useStore } from "../store";
import { ProviderAvatar } from "../ui";
import { useKeepFocus } from "./AgentSetupSection";
import { useMachineName } from "./MachinePicker";
import { Terminal } from "./Terminal";

export interface AgentInstall {
  provider: Provider;
  phase: InstallPhase;
  /** The terminal it runs in. */
  ptyId: string | null;
  exitCode: number | null;
  /** The person pressed Stop. */
  stopped: boolean;
  /** It couldn't begin, or couldn't be stopped: said in plain words with what to do. */
  problem: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Lets go of an install that has ended: what it came to is old news once the agent has been asked again. */
  forget: () => void;
}

/** What the hub says of a terminal, kept where every screen reads it (the live connection brings the same). */
const notePty = (pty: PtyInfo) => useStore.setState((s) => ({ ptys: { ...s.ptys, [pty.id]: pty } }));
/** What the hub says of an agent. */
const noteStatus = (status: ProviderStatus) => useStore.setState((s) => ({ providers: { ...s.providers, [status.provider]: status } }));

/**
 * One agent's install: starting it, following it and how it ended. An install already running on that machine is taken up
 * whoever started it (the Add sheet, the card under it, another device), so two never run over each other. Once it has
 * been followed to its end the hub is asked about the agent again, and that answer is what says it's in.
 */
export function useAgentInstall(provider: Provider): AgentInstall {
  const status = useStore((s) => s.providers[provider]);
  const running = useStore((s) => Object.values(s.ptys).find((p) => p.purpose === "install" && p.provider === provider && p.alive)?.id ?? null);
  const [watched, setWatched] = useState<string | null>(running);
  const info = useStore((s) => (watched ? s.ptys[watched] : undefined));
  const [starting, setStarting] = useState(false);
  const startingNow = useRef(false);
  /** The terminal whose end has been checked with the hub. */
  const [checked, setChecked] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (running) setWatched(running);
  }, [running]);
  // One started before this page loaded: the live connection only tells of the ones since.
  useEffect(() => {
    let on = true;
    api<PtyInfo[]>("GET", "/api/pty").then(
      (list) => {
        if (on) for (const p of list) if (p.purpose === "install" && p.provider === provider && p.alive) notePty(p);
      },
      () => {},
    );
    return () => {
      on = false;
    };
  }, [provider]);

  // The live connection says when it ends, unless it was down just then: nothing else would ever say so. A terminal the hub
  // no longer has (it restarted) has ended, and can't say how.
  const alive = !!info?.alive;
  useEffect(() => {
    if (!alive || !watched) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      try {
        const r = await api<{ info: PtyInfo }>("GET", `/api/pty/${watched}`);
        if (on) notePty(r.info);
      } catch (e) {
        const was = useStore.getState().ptys[watched];
        if (on && was && e instanceof ApiError && e.status === 404) notePty({ ...was, alive: false, exitCode: null });
      }
      if (on) timer = setTimeout(() => void look(), 1000);
    };
    timer = setTimeout(() => void look(), 1000);
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [alive, watched]);

  // Ended: is it there now? A check that can't be asked leaves the words below to say what's known, and the hub's own check
  // after an install still comes in as an event.
  const ended = !!info && !info.alive;
  useEffect(() => {
    if (!ended || !watched) return;
    let on = true;
    api<ProviderStatus>("POST", `/api/providers/${provider}/refresh`)
      .then((st) => {
        if (st?.provider === provider) noteStatus(st);
      })
      .catch(() => {})
      .finally(() => {
        if (on) setChecked(watched);
      });
    return () => {
      on = false;
    };
  }, [ended, watched, provider]);

  const start = async () => {
    if (startingNow.current || running) return;
    startingNow.current = true;
    setStarting(true);
    setProblem("");
    setStopped(false);
    try {
      const pty = await api<PtyInfo>("POST", `/api/providers/${provider}/install`);
      notePty(pty);
      setWatched(pty.id);
    } catch (e) {
      setProblem(installFailure(PROVIDER_INFO[provider].name, errorMessage(e), e instanceof ApiError ? e.status : undefined));
    } finally {
      startingNow.current = false;
      setStarting(false);
    }
  };
  const stop = async () => {
    if (!watched) return;
    setStopped(true);
    setProblem("");
    try {
      await api("DELETE", `/api/pty/${watched}`);
    } catch (e) {
      setStopped(false);
      setProblem(`Couldn't stop it: ${noDot(errorMessage(e))}.`);
    }
  };
  const forget = () => {
    if (!alive) setWatched(null);
    setProblem("");
  };
  const phase: InstallPhase = starting ? "starting" : !watched || !info ? "idle" : info.alive ? "running" : checked !== watched ? "checking" : info.exitCode === 0 && status?.installed && !status.error ? "done" : "failed";
  return { provider, phase, ptyId: watched, exitCode: info?.exitCode ?? null, stopped, problem, start, stop, forget };
}

/**
 * An install in one place, from the button that starts it to how it ended: one line that says how it's going (always on
 * screen, so a screen reader is told as it changes), the terminal while there's output worth reading, and one button that
 * is whatever can be done next. `says`: what a screen has to add at each step, after the words every install has.
 * `idleAction`: the button before it starts; none when there's nothing to install. `fallback`: another way forward, said if it fails.
 */
export function InstallBox({ install, says, idleAction, fallback, children }: { install: AgentInstall; says?: Partial<Record<InstallPhase, string>>; idleAction?: string; fallback?: string; children?: ReactNode }) {
  const { provider, phase, ptyId, exitCode, stopped, problem } = install;
  const machine = useMachineName();
  const status = useStore((s) => s.providers[provider]);
  const box = useRef<HTMLDivElement>(null);
  // The button goes when there's nothing left to press: the keyboard lands on the line that says how it went.
  useKeepFocus(box);
  const words = [installWords({ name: PROVIDER_INFO[provider].name, machine, phase, exitCode, stopped, status }), says?.[phase]].filter(Boolean).join(" ");
  const action = phase === "idle" || phase === "done" ? idleAction : phase === "starting" ? "Starting…" : phase === "running" ? "Stop" : phase === "failed" ? "Try again" : undefined;
  return (
    <div className={`svc-install ${phase}`} ref={box}>
      <p className="svc-install-line" role="status" tabIndex={-1} data-focus-here>
        {(phase === "running" || phase === "starting" || phase === "checking") && <Loader2 size={14} className="spin" aria-hidden />}
        <span>{words}</span>
      </p>
      {problem && <p role="alert" className="svc-problem">{problem}</p>}
      {/* Held on screen once it has ended badly: what it printed is the only place that says why. */}
      {ptyId && (phase === "running" || phase === "checking" || phase === "failed") && <Terminal ptyId={ptyId} takeFocus={false} />}
      {phase === "failed" && fallback && <p className="help">{fallback}</p>}
      {(action || children) && (
        <div className="row wrap svc-actions">
          {action && (
            // aria-disabled while it starts, not disabled: a browser drops the focus of a button it disables, and this
            // same button goes on to be Stop. The tap that comes meanwhile is refused by `start` itself.
            <button className={`btn small ${phase === "running" ? "" : "primary"}`} aria-disabled={phase === "starting" || undefined} onClick={() => void (phase === "running" ? install.stop() : install.start())}>
              {(phase === "idle" || phase === "done") && <Download size={14} aria-hidden />}
              {action}
            </button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * OpenCode's card in Settings → AI services: whether it's installed here, which version, and the button that puts the
 * version Crosstalk was checked against on this machine. Nothing to sign in to and no plan: the services it runs are on
 * their own rows above. A hub older than OpenCode doesn't list it, and shows no card.
 */
export function OpenCodeCard() {
  const info = PROVIDER_INFO.opencode;
  const status = useStore((s) => s.providers.opencode);
  const toast = useStore((s) => s.toast);
  const install = useAgentInstall("opencode");
  const [checking, setChecking] = useState(false);
  if (!status) return null;
  const state = openCodeState(status);
  const check = async () => {
    setChecking(true);
    try {
      noteStatus(await api<ProviderStatus>("POST", "/api/providers/opencode/refresh"));
      install.forget();
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="card tinted svc-agent-card" style={{ ["--c" as string]: info.color }} aria-label={info.name}>
      <div className="row" style={{ marginBottom: 6 }}>
        <ProviderAvatar provider="opencode" size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{info.name}</h3>
          <div className="muted small">
            {info.vendor}
            {status.version ? ` · v${status.version}` : ""}
          </div>
        </div>
        <span className={`pill ${state.tone}`}>{state.word}</span>
      </div>
      <p className="help">An open-source coding agent that Crosstalk drives, with no refusal rules of its own. It runs the AI services whose rows above say OpenCode.</p>
      {state.line && <p className="help">{state.line}</p>}
      {status.installed && status.binPath && <p className="help mono svc-bin">{status.binPath}</p>}
      <InstallBox install={install} idleAction={state.action ?? undefined}>
        <button className="btn small ghost" onClick={check} disabled={checking}>
          <RefreshCw size={13} className={checking ? "spin" : ""} aria-hidden /> Check
        </button>
      </InstallBox>
    </section>
  );
}
