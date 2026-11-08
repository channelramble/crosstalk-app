import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Play, RefreshCw, Square } from "lucide-react";
import type { PoolConfig, PoolFit, PoolModel, PoolStatus, PoolView, Provider } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { useStore } from "../store";
import { ConfirmButton, Seg, Switch } from "../ui";
import { KIMI_PRESET } from "../presets";
import {
  CLAUDE_CONTEXT_MIN,
  CONTEXT_COMFORT,
  CONTEXT_SIZES,
  POOL_STATE,
  aliasProblem,
  bytesText,
  computerNamed,
  contextLabel,
  downloadText,
  downloadsOf,
  fileName,
  fitTone,
  hfModelUrl,
  isBusy,
  isChosenDownload,
  mibText,
  modelName,
  modelSummary,
  namesText,
  normalizePool,
  poolWriter,
  portProblem,
  recoveriesFor,
  speedText,
  uncountedMachines,
  type Recovery,
} from "../pool";
import { PoolMachines } from "./PoolMachines";
import { ChooseModelDialog } from "./PoolModelDialog";
import { EndpointDialog } from "./SetupPage";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Saves a change to the pool's settings, built from the newest ones; says `done` when it worked, the error if not. */
export type PoolSave = (build: (config: PoolConfig) => Partial<PoolConfig>, done?: string) => Promise<boolean>;

/** What a saved change is followed by while the pool runs. */
const appliesLater = (view: PoolView) => (view.status.state === "off" || view.status.state === "error" ? undefined : "Saved. It applies the next time the pool starts.");

/**
 * Settings → Model pool: one local model split across several machines' GPUs with llama.cpp (docs/MODEL-POOL.md),
 * which chats use as the "Model pool" custom model. Shows the pool of the machine picked at the top of Settings, or
 * the `view` given (rendering it without a hub, as the tests do).
 */
export function ModelPool({ onSetUpLinux, view }: { onSetUpLinux: () => void; view?: PoolView }) {
  const stored = useStore((s) => s.pool);
  const given = useMemo(() => (view ? normalizePool(view) : null), [view]);
  const pool = given ?? stored;
  const loadPool = useStore((s) => s.loadPool);
  const poolCall = useStore((s) => s.poolCall);
  const toast = useStore((s) => s.toast);
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const [error, setError] = useState<{ text: string; old: boolean } | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [kimiFor, setKimiFor] = useState<Provider | null>(null);
  // Asking for the Hugging Face token (a problem's fix, a gated model just chosen): each ask opens and focuses its field.
  const [tokenAsk, setTokenAsk] = useState(0);
  // Same for the port (a problem's fix): opens Advanced at the port field.
  const [portAsk, setPortAsk] = useState(0);
  // A PC's helper command (a problem's fix): opens that PC's dialog with the command to run there.
  const [commandAsk, setCommandAsk] = useState<{ id: string; n: number } | null>(null);
  const autoChecked = useRef(false);

  const load = () => {
    setError(null);
    loadPool().catch((e) => setError({ text: message(e), old: e instanceof ApiError && e.status === 404 }));
  };
  useEffect(() => {
    if (!view) load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const write = useMemo(() => poolWriter((change) => poolCall("PUT", "/api/pool", { config: change }), () => useStore.getState().pool?.config ?? null), [poolCall]);
  const save: PoolSave = (build, done) =>
    write(build).then(
      () => {
        if (done) toast("info", done);
        return true;
      },
      (e) => {
        toast("error", message(e));
        return false;
      },
    );

  const act = async (what: "start" | "stop") => {
    setBusy(what);
    try {
      // A start answers at once; a stop once everything is ended, which on an unreachable machine takes the hub up to
      // a minute of waiting for it.
      await poolCall("POST", `/api/pool/${what}`, undefined, what === "stop" ? 75_000 : 30_000);
    } catch (e) {
      toast("error", message(e));
    } finally {
      setBusy(null);
    }
  };
  const check = async (quiet = false) => {
    if (checking) return;
    setChecking(true);
    setCheckError("");
    try {
      // It asks every machine (devices, round trip, helper), which can take a while.
      await poolCall("POST", "/api/pool/check", undefined, 90_000);
    } catch (e) {
      setCheckError(message(e));
      if (!quiet) toast("error", message(e));
    } finally {
      setChecking(false);
    }
  };

  // The first time the screen opens on a pool whose machines were never checked, it checks them.
  useEffect(() => {
    if (!pool || view || autoChecked.current) return;
    autoChecked.current = true;
    const never = pool.config.machines.length > 0 && pool.config.machines.every((m) => !pool.machines.find((s) => s.id === m.id)?.checkedAt);
    if (never && pool.status.state === "off") void check(true);
  }, [pool]); // eslint-disable-line react-hooks/exhaustive-deps

  const wantToken = () => setTokenAsk((n) => n + 1);
  const recover = (r: Recovery) => {
    if (r.kind === "token") wantToken();
    else if (r.kind === "model") setChoosing(true);
    else if (r.kind === "machines") void check();
    else if (r.kind === "storage") document.getElementById("storage")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (r.kind === "port") setPortAsk((n) => n + 1);
    else if (r.kind === "command") {
      const pc = pool && computerNamed(pool.status.detail, pool.config.machines);
      if (pc) setCommandAsk((a) => ({ id: pc.id, n: (a?.n ?? 0) + 1 }));
    }
  };
  const choose = async (model: PoolModel) => {
    const needsToken = model.gated && !useStore.getState().pool?.hasHfToken;
    const ok = await save(() => ({ model }), needsToken ? "Chosen. It needs your Hugging Face token: add it under Model." : appliesLater(pool!) ?? `${modelName(model.repo)} chosen.`);
    if (!ok) return false;
    setChoosing(false);
    if (needsToken) wantToken();
    return true;
  };

  if (!pool) {
    return error ? (
      <div className="card" role="alert">
        <p className="small" style={{ marginTop: 0 }}>
          {error.old ? "This machine's Crosstalk doesn't have the model pool yet. Update Crosstalk on it, then try again." : error.text}
        </p>
        <button className="btn small" onClick={load}>
          Try again
        </button>
      </div>
    ) : (
      <p className="muted small" role="status">
        Loading the model pool…
      </p>
    );
  }

  const showToken = !!pool.config.model?.gated || tokenAsk > 0;
  return (
    <section aria-label="Model pool" className="pool">
      <p className="help pool-intro">
        Runs one local model on several machines' GPUs together, for models too big for one. Chats use it like any custom model. It gives room, not speed: a model that fits one GPU runs fastest there alone.
      </p>
      {error && (
        <p role="alert" className="small pool-error">
          Couldn't load the newest state: {error.text}{" "}
          <button className="link-btn" onClick={load}>
            Try again
          </button>
        </p>
      )}
      <StatusCard view={pool} busy={busy} checking={checking} onAct={(what) => void act(what)} onRecover={recover} />
      <PoolMachines view={pool} save={save} checking={checking} checkError={checkError} onCheck={() => void check()} onSetUpLinux={onSetUpLinux} appliesLater={appliesLater(pool)} commandAsk={commandAsk} />
      <ModelCard view={pool} onChoose={() => setChoosing(true)} showToken={showToken} tokenAsk={tokenAsk} />
      <ContextCard view={pool} save={save} />
      <AdvancedCard view={pool} save={save} showToken={!showToken} portAsk={portAsk} />
      {choosing && (
        <ChooseModelDialog
          view={pool}
          onClose={() => setChoosing(false)}
          onChoose={choose}
          onKimi={(p) => {
            setChoosing(false);
            setKimiFor(p);
          }}
          onToken={() => {
            setChoosing(false);
            wantToken();
          }}
        />
      )}
      {kimiFor && (
        <EndpointDialog
          provider={kimiFor}
          account={null}
          preset={KIMI_PRESET}
          onClose={() => {
            setKimiFor(null);
            void refreshAccounts().catch(() => {});
          }}
        />
      )}
    </section>
  );
}

/** The pool's state at the top: what it's doing, the one thing to do next, and the download while it runs. */
function StatusCard({ view, busy, checking, onAct, onRecover }: { view: PoolView; busy: string | null; checking: boolean; onAct: (what: "start" | "stop") => void; onRecover: (r: Recovery) => void }) {
  const { status, config } = view;
  const st = POOL_STATE[status.state];
  // The fixes the problem names (Settings → Storage shows this machine's disk: no use when the main machine is another;
  // a helper command is a PC's, so the problem must name one).
  const recoveries =
    status.state === "error"
      ? recoveriesFor(status.detail, config.port).filter((r) => (r.kind !== "terms" || config.model) && (r.kind !== "storage" || config.mainId === "self") && (r.kind !== "command" || computerNamed(status.detail, config.machines)))
      : [];
  const noModel = !config.model;
  const idleDetail =
    status.state !== "off" || status.detail
      ? null
      : noModel
        ? "Choose a model below, then start it."
        : !config.machines.some((m) => m.enabled)
          ? "Switch on a machine below to lend its GPU, then start it."
          : `Ready to start ${modelName(config.model!.repo)}.`;
  return (
    <div className="card pool-status">
      <div className="pool-head">
        {/* Only the state is read out as it changes: a download's details change twice a second. */}
        <span role="status" className={`pill ${st.pill}`}>
          {st.label}
        </span>
        {(status.detail || idleDetail) && <span className="pool-detail">{status.detail ?? idleDetail}</span>}
      </div>
      {status.download && <DownloadBar d={status.download} />}
      <div className="pool-actions">
        {status.state === "off" && (
          <button className="btn primary" disabled={!!busy || noModel} onClick={() => onAct("start")}>
            <Play size={15} aria-hidden="true" /> {busy === "start" ? "Starting…" : "Start"}
          </button>
        )}
        {(isBusy(status.state) || status.state === "running") && (
          <button className="btn" disabled={!!busy} onClick={() => onAct("stop")}>
            <Square size={13} aria-hidden="true" /> {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
        )}
        {status.state === "stopping" && (
          <button className="btn" disabled>
            <Square size={13} aria-hidden="true" /> Stopping…
          </button>
        )}
        {status.state === "error" && (
          <>
            {recoveries.map((r, i) => (
              <RecoveryButton key={r.kind} recovery={r} primary={i === 0} repo={config.model?.repo ?? null} disabled={!!busy || (r.kind === "machines" && checking)} onRecover={onRecover} />
            ))}
            <button className={`btn ${recoveries.length ? "" : "primary"}`} disabled={!!busy || noModel} onClick={() => onAct("start")}>
              <RefreshCw size={14} aria-hidden="true" /> {busy === "start" ? "Starting…" : "Try again"}
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={() => onAct("stop")}>
              Stop
            </button>
          </>
        )}
      </div>
      {status.state === "running" && <RunningInfo status={status} config={config} />}
      {status.log.length > 0 && (
        <details className="pool-log">
          <summary>Server output</summary>
          <pre>{status.log.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function RecoveryButton({ recovery, primary, repo, disabled, onRecover }: { recovery: Recovery; primary: boolean; repo: string | null; disabled: boolean; onRecover: (r: Recovery) => void }) {
  if (recovery.kind === "terms") {
    return (
      <a className={`btn ${primary ? "primary" : ""}`} href={hfModelUrl(repo ?? "")} target="_blank" rel="noreferrer noopener">
        <ExternalLink size={14} aria-hidden="true" /> {recovery.label}
      </a>
    );
  }
  return (
    <button className={`btn ${primary ? "primary" : ""}`} disabled={disabled} onClick={() => onRecover(recovery)}>
      {recovery.label}
    </button>
  );
}

function DownloadBar({ d }: { d: NonNullable<PoolStatus["download"]> }) {
  const pct = d.totalBytes > 0 ? Math.min(100, (d.doneBytes / d.totalBytes) * 100) : 0;
  return (
    <div className="pool-download">
      <div className="pool-bar" role="progressbar" aria-label="Model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(pct)} aria-valuetext={downloadText(d)}>
        <span style={{ ["--fill" as string]: pct / 100 }} />
      </div>
      <div>{downloadText(d)}</div>
      <div className="mono pool-file-name">{fileName(d.file)}</div>
    </div>
  );
}

function RunningInfo({ status, config }: { status: PoolStatus; config: PoolConfig }) {
  const ep = status.endpoint;
  const gave = ep?.contextWindow ?? null;
  const speed = speedText(status.speed);
  return (
    <div className="pool-running">
      {ep && (
        <div>
          Chats reach it at <span className="mono">{ep.baseUrl}</span> as <span className="mono">{ep.model}</span>
        </div>
      )}
      {gave !== null && (
        <div>
          It gave {contextLabel(gave)} tokens of context{gave < config.contextSize ? ` (you asked for ${contextLabel(config.contextSize)}: the model holds at most ${contextLabel(gave)})` : ""}.
        </div>
      )}
      {gave !== null && gave < CLAUDE_CONTEXT_MIN && (
        <div className="pool-warn">Too little for Claude Code, which needs about 20k just to start: use it from Codex, or pick a bigger context below.</div>
      )}
      {speed && <div>Speed: {speed}</div>}
      <p className="help" style={{ margin: "4px 0 0" }}>
        Use it in a chat: start a Claude Code or Codex chat and pick the Model pool account.
      </p>
    </div>
  );
}

/** What's chosen, how it fits, and the Hugging Face token when the model is gated. */
function ModelCard({ view, onChoose, showToken, tokenAsk }: { view: PoolView; onChoose: () => void; showToken: boolean; tokenAsk: number }) {
  const m = view.config.model;
  return (
    <div className="card pool-card">
      <div className="pool-model">
        <div className="pool-model-text">
          <div className="pool-label">Model</div>
          {m ? (
            <>
              <div className="pool-model-name">
                {modelName(m.repo)} {m.gated && <span className="pill orange">Gated</span>}
              </div>
              <div className="help">{modelSummary(m)}</div>
              <a className="help mono pool-repo" href={hfModelUrl(m.repo)} target="_blank" rel="noreferrer noopener">
                {m.repo}
              </a>
            </>
          ) : (
            <div className="help">None chosen yet. Pick one that fits your machines.</div>
          )}
        </div>
        <button className={`btn small ${m ? "" : "primary"}`} onClick={onChoose}>
          {m ? "Change model" : "Choose a model"}
        </button>
      </div>
      {view.fit && m && <FitBar fit={view.fit} uncounted={uncountedMachines(view).map((x) => x.name)} running={view.status.state === "running"} />}
      {showToken && <HfToken view={view} repo={m?.repo ?? null} ask={tokenAsk} />}
    </div>
  );
}

/**
 * The room the chosen model needs against what the machines taking part have free. A PC's GPU memory can't be seen
 * from here (nor a hub's before it's checked): then a model that needs more than the rest "may" fit, and the bar says
 * how much those machines must add.
 */
function FitBar({ fit, uncounted, running }: { fit: PoolFit; uncounted: string[]; running: boolean }) {
  // Running, it fits: what's known beats the guess (a PC's memory can't be counted from here).
  if (running) {
    return (
      <div className="pool-fit">
        <div className="pool-fit-head">
          <span>It fits: it's running now.</span>
          <span className="pill green">Running</span>
        </div>
        {fit.note && /^Fits /.test(fit.note) && <p className="help" style={{ margin: 0 }}>{fit.note}</p>}
      </div>
    );
  }
  const tone = fitTone(fit, uncounted.length);
  const none = fit.haveMiB <= 0;
  const need = mibText(fit.needMiB);
  const text =
    tone === "maybe"
      ? none
        ? `Needs about ${need}`
        : `Needs about ${need} of ${mibText(fit.haveMiB)} counted`
      : none
        ? `Needs about ${need}: switch on a machine above to give it room.`
        : `Needs about ${need} of ${mibText(fit.haveMiB)}`;
  const pct = none ? 100 : Math.min(100, (fit.needMiB / fit.haveMiB) * 100);
  const one = uncounted.length === 1;
  const pill = { good: ["green", "Fits"], tight: ["orange", "Tight"], maybe: ["orange", "Maybe"], over: ["red", "Too big"] }[tone];
  return (
    <div className="pool-fit">
      <div className="pool-fit-head">
        <span>{text}</span>
        <span className={`pill ${pill[0]}`}>{pill[1]}</span>
      </div>
      <div className={`pool-bar ${tone}`} role="meter" aria-label="Room the model needs" aria-valuemin={0} aria-valuemax={Math.max(fit.haveMiB, 1)} aria-valuenow={Math.min(fit.needMiB, Math.max(fit.haveMiB, 1))} aria-valuetext={text}>
        <span style={{ ["--fill" as string]: pct / 100 }} />
      </div>
      {fit.note && <p className="help" style={{ margin: 0 }}>{fit.note}</p>}
      {tone === "maybe" && (
        <p className="help" style={{ margin: 0 }}>
          It fits if {namesText(uncounted)} {one ? "has" : "have"} about {mibText(fit.needMiB - fit.haveMiB)} free on {one ? "its GPU" : "their GPUs"}.
        </p>
      )}
    </div>
  );
}

/**
 * The Hugging Face token for gated models: saved on the hub, never shown again. Each `ask` opens the field (to replace
 * a saved token) and puts the cursor in it.
 */
function HfToken({ view, repo, ask = 0 }: { view: PoolView; repo: string | null; ask?: number }) {
  const toast = useStore((s) => s.toast);
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focusNext = useRef(false);
  useEffect(() => {
    if (!ask) return;
    focusNext.current = true;
    setReplacing(true);
  }, [ask]);
  // Once the field is on screen (it may take a render).
  useEffect(() => {
    if (!focusNext.current || !input.current) return;
    focusNext.current = false;
    input.current.scrollIntoView({ behavior: "smooth", block: "center" });
    input.current.focus({ preventScroll: true });
  });
  const put = async (value: string | null) => {
    const conn = useStore.getState().conn;
    setBusy(true);
    try {
      const r = await api<{ hasHfToken: boolean }>("PUT", "/api/pool/hf-token", { token: value }, conn);
      // Only into the pool of the machine it was saved on (the screen may show another one by now).
      if (useStore.getState().conn === conn) useStore.setState((s) => (s.pool ? { pool: { ...s.pool, hasHfToken: r.hasHfToken } } : {}));
      setToken("");
      setReplacing(false);
      toast("info", value ? "Hugging Face token saved on the hub." : "Hugging Face token removed.");
    } catch (e) {
      toast("error", message(e));
    } finally {
      setBusy(false);
    }
  };
  const editing = !view.hasHfToken || replacing;
  return (
    <div className="pool-token">
      <div className="pool-token-head">
        <span className="pool-label">Hugging Face token</span>
        {view.hasHfToken && <span className="pill green">Saved</span>}
      </div>
      {editing ? (
        <form
          className="pool-token-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void put(token.trim());
          }}
        >
          <input
            ref={input}
            className="input mono"
            type="password"
            aria-label="Hugging Face token"
            placeholder={view.hasHfToken ? "Paste a new token to replace it" : "hf_…"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
          <button className="btn" type="submit" disabled={busy || !token.trim()}>
            {busy ? "Saving…" : "Save token"}
          </button>
          {replacing && (
            <button className="btn ghost" type="button" onClick={() => (setReplacing(false), setToken(""))}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="row wrap" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => setReplacing(true)} disabled={busy}>
            Replace token
          </button>
          <ConfirmButton label="Remove token" question="Remove the saved token?" confirmLabel="Remove" disabled={busy} onConfirm={() => void put(null)} />
        </div>
      )}
      <p className="help" style={{ margin: 0 }}>
        Make a token with Read access at{" "}
        <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer noopener">
          huggingface.co/settings/tokens
        </a>
        . First accept the model's terms on{" "}
        {repo ? (
          <a href={hfModelUrl(repo)} target="_blank" rel="noreferrer noopener">
            its page
          </a>
        ) : (
          "its page"
        )}
        , signed in with the same account. The token stays on the hub.
      </p>
    </div>
  );
}

function ContextCard({ view, save }: { view: PoolView; save: PoolSave }) {
  const cur = view.config.contextSize;
  const [want, setWant] = useState<number | null>(null);
  const options = [...new Set([...CONTEXT_SIZES, cur])].sort((a, b) => a - b).map((n) => ({ id: String(n), label: contextLabel(n) }));
  const pick = (v: string) => {
    const n = Number(v);
    if (n === cur) return;
    setWant(n);
    void save(() => ({ contextSize: n }), appliesLater(view)).finally(() => setWant(null));
  };
  return (
    <div className="card pool-card">
      <div className="pool-label">Context size</div>
      <div style={{ marginTop: 6 }}>
        <Seg label="Context size" value={String(want ?? cur)} options={options} onChange={pick} disabled={want !== null} />
      </div>
      <p className="help" style={{ margin: "8px 0 0" }}>
        How much of a chat the model keeps in mind, in tokens. More takes more GPU memory: if it doesn't fit, the start stops and says so. Claude Code needs about 20k just to start, so 64k or more works best.
      </p>
      {cur < CONTEXT_COMFORT && (
        <p className="help pool-warn" style={{ margin: "6px 0 0" }}>
          At {contextLabel(cur)}, Claude Code chats get summarized after a few messages: pick 64k if the bar above says it fits.
        </p>
      )}
    </div>
  );
}

function AdvancedCard({ view, save, showToken, portAsk = 0 }: { view: PoolView; save: PoolSave; showToken: boolean; portAsk?: number }) {
  const { config, status } = view;
  const poolCall = useStore((s) => s.poolCall);
  const toast = useStore((s) => s.toast);
  const [alias, setAlias] = useState(config.alias);
  const [port, setPort] = useState(String(config.port));
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  // Asked to change the port (a problem's fix): open, and put the cursor there.
  useEffect(() => {
    if (!portAsk || !details.current) return;
    details.current.open = true;
    portInput.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    portInput.current?.focus({ preventScroll: true });
  }, [portAsk]);
  // Saved elsewhere (another device): the fields follow unless they're being edited.
  const shown = useRef({ alias: config.alias, port: String(config.port) });
  useEffect(() => {
    if (alias === shown.current.alias) setAlias(config.alias);
    if (port === shown.current.port) setPort(String(config.port));
    shown.current = { alias: config.alias, port: String(config.port) };
  }, [config.alias, config.port]); // eslint-disable-line react-hooks/exhaustive-deps
  const aliasChanged = alias.trim() !== config.alias;
  const portChanged = port !== String(config.port);
  const aliasError = aliasChanged ? aliasProblem(alias) : null;
  const portError = portChanged ? portProblem(port) : null;
  const saveFields = async () => {
    setSaving(true);
    await save(() => ({ ...(aliasChanged ? { alias: alias.trim() } : {}), ...(portChanged ? { port: Number(port) } : {}) }), appliesLater(view) ?? "Saved.");
    setSaving(false);
  };
  const main = config.machines.find((m) => m.id === config.mainId)?.name ?? "the main machine";
  const stopped = status.state === "off" || status.state === "error";
  // Every model on the main machine, unfinished downloads too (a hub older than this list only has the chosen one).
  const downloads = view.mainFiles ? downloadsOf(view.mainFiles) : null;
  const removeFiles = async (files: string[]) => {
    setRemoving(true);
    try {
      // The main machine has a minute to move the files: a little more, so its answer (or its error) gets here.
      await poolCall("POST", "/api/pool/model/remove", { files }, 75_000);
      toast("info", `Moved to the Trash on ${main}. Empty the Trash there to free the space.`);
    } catch (e) {
      toast("error", message(e));
    } finally {
      setRemoving(false);
    }
  };
  const removeModel = () => (config.model ? removeFiles(config.model.files) : Promise.resolve());
  return (
    <details ref={details} className="card pool-card pool-advanced">
      <summary>Advanced</summary>
      <label className="field">
        <span>Name in chats</span>
        <input className="input mono" aria-label="Name in chats" aria-invalid={!!aliasError} value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={64} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <span className="help">The model's name in chats and model menus.</span>
        {aliasError && <span className="small pool-error">{aliasError}</span>}
      </label>
      <label className="field">
        <span>Port</span>
        <input ref={portInput} className="input mono" aria-label="Port" aria-invalid={!!portError} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} />
        <span className="help">The server's port on {main}.</span>
        {portError && <span className="small pool-error">{portError}</span>}
      </label>
      <button className="btn small primary" disabled={saving || (!aliasChanged && !portChanged) || !!aliasError || !!portError} onClick={() => void saveFields()}>
        {saving ? "Saving…" : "Save name and port"}
      </button>
      <div className="pool-setting">
        <div>
          <div className="pool-setting-title">Start when the hub starts</div>
          <div className="help">If it was running when the hub stopped.</div>
        </div>
        <Switch
          checked={autostart ?? config.autostart}
          onChange={(v) => {
            setAutostart(v);
            void save(() => ({ autostart: v })).finally(() => setAutostart(null));
          }}
          label="Start when the hub starts"
        />
      </div>
      <div className="pool-setting">
        <div>
          <div className="pool-setting-title">llama.cpp build</div>
          <div className="help">Every machine runs exactly this build: the server and its helpers must match.</div>
        </div>
        <span className="mono">{config.build}</span>
      </div>
      {showToken && <HfToken view={view} repo={config.model?.repo ?? null} />}
      {downloads ? (
        <div className="pool-downloads">
          <div className="pool-setting-title">Models on {main}</div>
          {!downloads.length && <div className="help">None downloaded yet.</div>}
          {downloads.map((d) => {
            const chosen = isChosenDownload(d, config.model);
            return (
              <div key={d.files.join("|")} className="pool-setting pool-remove">
                <div className="pool-download-text">
                  <div className="mono pool-file-name">{d.name}</div>
                  <div className="help">{[modelName(d.repo), bytesText(d.bytes), d.partial ? "unfinished" : null, chosen ? "the chosen model" : null].filter(Boolean).join(" · ")}</div>
                </div>
                <ConfirmButton
                  label={removing ? "Removing…" : "Remove"}
                  ariaLabel={`Remove ${d.name}`}
                  question={`Move ${d.name} to the Trash on ${main}?`}
                  confirmLabel="Move to Trash"
                  disabled={(chosen && !stopped) || removing}
                  onConfirm={() => void removeFiles(d.files)}
                />
              </div>
            );
          })}
          <p className="help" style={{ margin: 0 }}>
            Removing moves the files to the Trash there.{config.model ? " The chosen model is downloaded again when the pool starts" : ""}
            {config.model && !stopped ? ", and can only be removed while the pool is stopped." : config.model ? "." : ""}
          </p>
        </div>
      ) : (
        config.model && (
          <div className="pool-setting pool-remove">
            <div>
              <div className="pool-setting-title">Downloaded model</div>
              <div className="help">
                Moves {modelName(config.model.repo)} on {main} to the Trash. Starting the pool again downloads it again.{!stopped && " Stop the pool first."}
              </div>
            </div>
            <ConfirmButton label={removing ? "Removing…" : "Remove download"} question={`Move it to the Trash on ${main}?`} confirmLabel="Move to Trash" disabled={!stopped || removing} onConfirm={() => void removeModel()} />
          </div>
        )
      )}
    </details>
  );
}
