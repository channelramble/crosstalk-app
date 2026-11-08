// Settings → Local models, below the running servers: starting a server (hub/src/localRunners.ts: Ollama, or llama.cpp
// with a downloaded model, on 127.0.0.1 at a port of the person's choosing) and the models on this machine
// (hub/src/localLibrary.ts: the downloads folder, downloads under way or stopped, and the files that are here).
import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Play } from "lucide-react";
import type { LocalDownload, LocalFolder, LocalLibrary, LocalModelFile, LocalServerStart, LocalStarted } from "@crosstalk/shared";
import { contextsFor, DEFAULT_CONTEXT, downloadWayOut, fileTitle, fitOf, folderLine, needOf, startChoice, startedLine, startedTitle } from "../localLibrary";
import { bytesText, contextLabel, portProblem } from "../pool";
import { ConfirmButton, Dialog, Seg } from "../ui";
import { HelpTip } from "./HelpTip";
import { DownloadBar, TokenField } from "./LocalModelsGet";

/** What a section action came back with: a refusal in plain words, with the hub's reason code. */
export interface Problem {
  text: string;
  code: string | null;
}

/** The section's actions on the hub; each resolves once the hub has answered (true when it took it). */
export interface LibraryActions {
  send(key: string, path: string, body: unknown): Promise<boolean>;
  busy: string | null;
  problems: Readonly<Record<string, Problem>>;
  /** Puts a problem away (Dismiss, or the person tried again some other way). */
  clear(key: string): void;
}

const NAMES = { ollama: "Ollama", llamacpp: "llama.cpp" } as const;

/** The servers this machine can run, the ones Crosstalk is starting (or that stopped), and how to start one. */
export function StartServers({ library, shownPorts, ollamaPorts = [], actions, onStart }: { library: LocalLibrary; shownPorts: number[]; /** Ollamas the scan found running here. */ ollamaPorts?: number[]; actions: LibraryActions; onStart: (kind: LocalServerStart["kind"], model?: string) => void }) {
  const program = (kind: LocalServerStart["kind"]) => library.programs.find((p) => p.kind === kind) ?? null;
  // Running ones the scan found are cards above; the rest are here (starting, stopping, stopped by themselves).
  const here = library.started.filter((s) => s.state !== "running" || !shownPorts.includes(s.port));
  // Another Ollama would share the running one's models (and folder): pulling into that one is what's wanted.
  const ollamaHelp = !program("ollama")
    ? "Not installed here. Get it at ollama.com/download, then press Rescan."
    : ollamaPorts.length
      ? `Ollama runs on port ${ollamaPorts[0]}: pull models into that one with Get a model.`
      : `From ${program("ollama")!.from}. Pulls models from its library.`;
  const rows: { kind: LocalServerStart["kind"]; help: string }[] = [
    { kind: "ollama", help: ollamaHelp },
    {
      kind: "llamacpp",
      help: program("llamacpp")
        ? library.files.length
          ? `From ${program("llamacpp")!.from}. Serves one downloaded model.`
          : `From ${program("llamacpp")!.from}. Get a model below first: it serves one downloaded model.`
        : "Not installed here. Install it with Homebrew (brew install llama.cpp), or start the model pool once to get its build, then press Rescan.",
    },
  ];
  return (
    <section className="card local-start" aria-label="Start a server">
      <div className="local-card-title">
        <span className="pool-setting-title">Start a server</span>
        <HelpTip label="Where do started servers run?">On 127.0.0.1, so only this machine reaches them. They keep running when the hub restarts, and Crosstalk only ever stops the ones it started.</HelpTip>
      </div>
      <ul className="local-rows">
        {rows.map((r) => (
          <li key={r.kind} className="local-row">
            <div className="local-row-text">
              <div className="local-model-name">{NAMES[r.kind]}</div>
              <div className="help">{r.help}</div>
            </div>
            {program(r.kind) && (r.kind === "ollama" || library.files.length > 0) && (
              <button type="button" className="btn small" aria-label={`Start ${NAMES[r.kind]}`} onClick={() => onStart(r.kind)}>
                <Play size={13} aria-hidden="true" /> Start
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="help local-why">LM Studio is managed in LM Studio: start it there, then press Rescan.</p>
      {here.map((s) => (
        <StartedRow key={s.id} s={s} actions={actions} onAgain={() => void actions.send(`start:${s.id}`, "/api/local-models/start", { kind: s.kind, port: s.port, ...(s.model ? { model: s.model, context: s.context ?? DEFAULT_CONTEXT } : {}) })} />
      ))}
    </section>
  );
}

function StartedRow({ s, actions, onAgain }: { s: LocalStarted; actions: LibraryActions; onAgain: () => void }) {
  const stopKey = `stop:${s.id}`;
  const problem = actions.problems[stopKey] ?? actions.problems[`start:${s.id}`];
  return (
    <div className={`local-started ${s.state}`} role="group" aria-label={startedTitle(s)}>
      <div className="local-model-name">{startedTitle(s)}</div>
      {s.model && <div className="help mono local-started-model">{s.model.split("/").pop()}</div>}
      <p className="small local-started-line" aria-live="polite">
        {startedLine(s)}
      </p>
      {s.state === "failed" && <p className="help mono local-log">Its log: {s.log}</p>}
      {problem && (
        <p className="small local-warn" role="alert">
          {problem.text}
        </p>
      )}
      <div className="local-actions">
        {s.state === "failed" ? (
          <>
            <button type="button" className="btn small primary" onClick={onAgain} disabled={actions.busy === `start:${s.id}`}>
              {actions.busy === `start:${s.id}` ? "Starting…" : "Try again"}
            </button>
            <button type="button" className="btn small ghost" onClick={() => void actions.send(stopKey, "/api/local-models/stop", { id: s.id })} disabled={actions.busy === stopKey}>
              Dismiss
            </button>
          </>
        ) : (
          <button type="button" className="btn small" onClick={() => void actions.send(stopKey, "/api/local-models/stop", { id: s.id })} disabled={s.state === "stopping" || actions.busy === stopKey}>
            {s.state === "stopping" || actions.busy === stopKey ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
    </div>
  );
}

/** The downloads folder, downloads under way or stopped, and the models in the folder. */
/**
 * `taken` on this screen and in the Start dialog is what the heavy things on the hub's machine hold right now -- the
 * memory guard's own number, from the `memory` state. These pills are about starting a server *now*, so they have to
 * be about the machine as it is: a green "Fits on Mac mini" for a 10 GB model while ComfyUI holds 12.5 GB, and then a
 * 409 "nothing is free" on tapping Start, is the phone and the hub giving two answers. (The download screens pass
 * nothing, because a download is for later.)
 */
export function ModelsHere({ library, machine, taken = 0, actions, onGet, onFolder, onStart }: { library: LocalLibrary; machine: string; taken?: number; actions: LibraryActions; onGet: () => void; onFolder: () => void; onStart: (kind: "llamacpp", model: string) => void }) {
  const canStart = library.programs.some((p) => p.kind === "llamacpp");
  // A download that was running and went from the list finished (one that fails or stops stays): said once.
  const [finished, setFinished] = useState("");
  const was = useRef(library.downloads);
  useEffect(() => {
    const done = was.current.filter((d) => d.state === "downloading" && !library.downloads.some((x) => x.id === d.id));
    if (done.length) setFinished(`${done.map((d) => d.name).join(" and ")} downloaded.`);
    was.current = library.downloads;
  }, [library.downloads]);
  return (
    <section className="card local-library" aria-label={`Models on ${machine}`}>
      <span className="local-sr" aria-live="polite">
        {finished}
      </span>
      <div className="local-head">
        <div className="local-head-text">
          <div className="pool-setting-title">Models on {machine}</div>
        </div>
        <button type="button" className="btn small primary" onClick={onGet}>
          Get a model
        </button>
      </div>
      <div className="local-folder">
        <div className="local-folder-text">
          <span className="help">Downloads go to</span>
          <span className="mono local-folder-path">{folderLine(library.folder)}</span>
        </div>
        <button type="button" className="btn small" onClick={onFolder}>
          <FolderOpen size={13} aria-hidden="true" /> Change
        </button>
      </div>
      {library.folder.problem && (
        <p className="small local-warn" role="alert">
          {library.folder.problem}
        </p>
      )}
      {library.downloads.length > 0 && (
        <ul className="local-rows" aria-label="Downloads">
          {library.downloads.map((d) => (
            <DownloadRow key={d.id} d={d} library={library} actions={actions} onFolder={onFolder} />
          ))}
        </ul>
      )}
      {library.files.length > 0 ? (
        <ul className="local-rows" aria-label="Downloaded">
          {library.files.map((f) => (
            <FileRow key={f.id} f={f} library={library} machine={machine} taken={taken} actions={actions} canStart={canStart} onStart={() => onStart("llamacpp", f.id)} />
          ))}
        </ul>
      ) : (
        !library.downloads.length && <p className="help local-empty">No models downloaded here yet. Get one from Hugging Face, then start it in llama.cpp.</p>
      )}
    </section>
  );
}

function DownloadRow({ d, library, actions, onFolder }: { d: LocalDownload; library: LocalLibrary; actions: LibraryActions; onFolder: () => void }) {
  const key = `dl:${d.id}`;
  const problem = actions.problems[key];
  const resume = d.model ? { source: "huggingface", model: d.model } : d.ollama ? { source: "ollama", serverId: d.ollama.serverId, model: d.ollama.model } : null;
  const wayOut = d.state === "failed" ? downloadWayOut(d) : problem?.code === "low_disk" || problem?.code === "folder" ? "folder" : problem?.code === "hf_terms" ? "token" : null;
  return (
    <li className="local-row local-row-download" aria-label={d.name}>
      <div className="local-row-text">
        <div className="local-model-name">{d.name}</div>
        <DownloadBar d={d} />
        {problem && (
          <p className="small local-warn" role="alert">
            {problem.text}
          </p>
        )}
        {wayOut === "token" && <TokenField has={library.hasHfToken} repo={d.model?.repo ?? null} onSaved={() => actions.clear(key)} />}
        <div className="local-actions">
          {d.state === "downloading" ? (
            <button type="button" className="btn small" aria-label={`Stop the download of ${d.name}`} onClick={() => void actions.send(key, "/api/local-models/downloads/stop", { id: d.id })} disabled={actions.busy === key}>
              Stop
            </button>
          ) : (
            <>
              {resume && (
                <button type="button" className="btn small primary" aria-label={`${d.state === "failed" ? "Try again" : "Resume"}: ${d.name}`} onClick={() => void actions.send(key, "/api/local-models/downloads", resume)} disabled={actions.busy === key}>
                  {actions.busy === key ? "Starting…" : d.state === "failed" ? "Try again" : "Resume"}
                </button>
              )}
              {wayOut === "folder" && (
                <button type="button" className="btn small" onClick={onFolder}>
                  Change folder
                </button>
              )}
              {problem?.code === "no_trash" ? (
                <DeleteForGood name={d.name} busy={actions.busy === key} onDelete={() => void actions.send(key, "/api/local-models/downloads/remove", { id: d.id, forGood: true })} />
              ) : (
                <ConfirmButton
                  label={d.source === "ollama" ? "Dismiss" : "Remove"}
                  ariaLabel={`${d.source === "ollama" ? "Dismiss" : "Remove"} the download of ${d.name}`}
                  question={d.source === "ollama" ? "Forget this download? Ollama clears what it had." : "Move what's downloaded to the Trash?"}
                  confirmLabel={d.source === "ollama" ? "Forget it" : "Move to Trash"}
                  onConfirm={() => void actions.send(key, "/api/local-models/downloads/remove", { id: d.id })}
                  disabled={actions.busy === key}
                />
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function FileRow({ f, library, machine, taken, actions, canStart, onStart }: { f: LocalModelFile; library: LocalLibrary; machine: string; taken: number; actions: LibraryActions; canStart: boolean; onStart: () => void }) {
  const key = `file:${f.id}`;
  const need = needOf(f.bytes, f.kvBytesPerToken, DEFAULT_CONTEXT, f.contextLength);
  const fit = fitOf(need.bytes, library.machine, machine, taken);
  const serving = library.started.some((s) => s.model === f.id && s.state !== "failed");
  return (
    <li className="local-row" aria-label={fileTitle(f)}>
      <div className="local-row-text">
        <div className="local-file-head">
          <span className="local-model-name">{fileTitle(f)}</span>
          <span className={`pill ${fit.tone}`}>{fit.label}</span>
          {serving && <span className="pill blue">Running</span>}
        </div>
        <div className="help">
          {bytesText(f.bytes)}
          {f.files.length > 1 ? ` in ${f.files.length} parts` : ""} · at {contextLabel(need.context)} context
        </div>
        <p className="small local-fit-line">{fit.line}</p>
        {actions.problems[key] && (
          <p className="small local-warn" role="alert">
            {actions.problems[key].text}
          </p>
        )}
        <div className="local-actions">
          {canStart && !serving && (
            <button type="button" className="btn small" aria-label={`Start ${fileTitle(f)} in llama.cpp`} onClick={onStart}>
              <Play size={13} aria-hidden="true" /> Start in llama.cpp
            </button>
          )}
          {actions.problems[key]?.code === "no_trash" ? (
            <DeleteForGood name={fileTitle(f)} busy={serving || actions.busy === key} onDelete={() => void actions.send(key, "/api/local-models/files/remove", { id: f.id, forGood: true })} />
          ) : (
            <ConfirmButton label="Remove" ariaLabel={`Remove ${fileTitle(f)}`} question="Move this model to the Trash?" confirmLabel="Move to Trash" disabled={serving || actions.busy === key} onConfirm={() => void actions.send(key, "/api/local-models/files/remove", { id: f.id })} />
          )}
        </div>
      </div>
    </li>
  );
}

/** The drive's Trash can't be used (the hub said `no_trash`): deleting is the way out, and it's asked about again first. */
function DeleteForGood({ name, busy, onDelete }: { name: string; busy: boolean; onDelete: () => void }) {
  return <ConfirmButton label="Delete for good" ariaLabel={`Delete ${name} for good`} question="Delete it for good? It can't be got back." confirmLabel="Delete it" disabled={busy} onConfirm={onDelete} />;
}

/** Where downloads go: a folder of the person's choosing (made if it's missing), or Crosstalk's own. */
export function FolderDialog({ folder, onClose, onSave }: { folder: LocalFolder; onClose: () => void; onSave: (path: string | null) => Promise<string | null> }) {
  const [path, setPath] = useState(folder.isDefault ? "" : folder.shown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  const save = async (to: string | null) => {
    setBusy(true);
    setError("");
    const problem = await onSave(to);
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };
  const typed = path.trim();
  return (
    <Dialog
      title="Downloads folder"
      icon={<FolderOpen size={20} aria-hidden="true" />}
      dirty={typed !== (folder.isDefault ? "" : folder.shown) && !busy}
      onClose={() => !busy && onClose()}
      footer={(requestClose) => (
        <>
          {!folder.isDefault && (
            <button type="button" className="btn ghost" onClick={() => void save(null)} disabled={busy}>
              Use Crosstalk's folder
            </button>
          )}
          <button type="button" className="btn" onClick={() => requestClose()} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save(typed)} disabled={busy || !typed}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      )}
    >
      <p className="help" style={{ marginTop: 0 }}>
        Hugging Face downloads go here. Now: <span className="mono">{folderLine(folder)}</span>
      </p>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed && !busy) void save(typed);
        }}
      >
        <label htmlFor={id}>Folder</label>
        <input id={id} className="input mono" value={path} onChange={(e) => (setPath(e.target.value), setError(""))} placeholder={folder.isDefault ? folder.shown : "~/Models"} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </form>
      <p className="help">Like ~/Models, or a folder on a drive such as /Volumes/Untitled/models. A drive works while it's plugged in. Models already downloaded stay where they are.</p>
      {error && (
        <p className="small local-warn" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** Start Ollama or llama.cpp: the port (a free one is filled in), and for llama.cpp the model and its context. */
export function StartDialog({ library, machine, taken = 0, kind: first, model: chosen, onClose, onStart }: { library: LocalLibrary; machine: string; taken?: number; kind: LocalServerStart["kind"]; model?: string; onClose: () => void; onStart: (body: LocalServerStart) => Promise<Problem | null> }) {
  const kinds = library.programs.map((p) => p.kind).filter((k, i, all) => all.indexOf(k) === i);
  const [kind, setKind] = useState<LocalServerStart["kind"]>(first);
  const [model, setModel] = useState(chosen ?? startChoice(library.files, library.machine) ?? "");
  const file = library.files.find((f) => f.id === model) ?? null;
  const offered = contextsFor(file?.contextLength ?? null);
  const [context, setContext] = useState(DEFAULT_CONTEXT);
  const [port, setPort] = useState(String(library.ports[first]));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const portId = useId();
  const modelId = useId();
  const portBad = portProblem(port.trim());
  const ctx = offered.includes(context) ? context : offered[offered.length - 1];
  const fit = file ? fitOf(needOf(file.bytes, file.kvBytesPerToken, ctx, file.contextLength).bytes, library.machine, machine, taken) : null;
  const needsModel = kind === "llamacpp" && !file;
  /** `anyway`: the memory guard said it won't fit and the person chose to start it regardless (their machine). */
  const start = async (anyway = false) => {
    setBusy(true);
    setProblem(null);
    const body: LocalServerStart = kind === "llamacpp" ? { kind, port: Number(port), model, context: ctx } : { kind, port: Number(port) };
    const p = await onStart(anyway ? { ...body, force: true } : body);
    setBusy(false);
    if (p) setProblem(p);
    else onClose();
  };
  return (
    <Dialog
      title={`Start ${NAMES[kind]}`}
      icon={<Play size={20} aria-hidden="true" />}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void start()} disabled={busy || !!portBad || needsModel}>
            {busy ? "Starting…" : "Start"}
          </button>
        </>
      }
    >
      {kinds.length > 1 && (
        <Seg
          label="Server"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setPort(String(library.ports[k]));
            setProblem(null);
          }}
          options={kinds.map((k) => ({ id: k, label: NAMES[k] }))}
        />
      )}
      {kind === "llamacpp" && (
        <>
          <div className="field local-start-field">
            <label htmlFor={modelId}>Model</label>
            <select id={modelId} className="select" value={model} onChange={(e) => (setModel(e.target.value), setProblem(null))}>
              {library.files.map((f) => (
                <option key={f.id} value={f.id}>
                  {fileTitle(f)} · {bytesText(f.bytes)}
                </option>
              ))}
            </select>
          </div>
          <div className="field local-start-field">
            <div className="svc-label">
              <span>Context</span>
              <HelpTip label="What's context?">How much of a chat the model holds at once. Claude Code needs about 20k just to start; more context takes more memory.</HelpTip>
            </div>
            <Seg label="Context" value={String(ctx)} onChange={(v) => setContext(Number(v))} options={offered.map((c) => ({ id: String(c), label: contextLabel(c) }))} />
          </div>
          {fit && (
            <p className="small local-fit-line">
              <span className={`pill ${fit.tone}`}>{fit.label}</span> {fit.line}
            </p>
          )}
          {file?.contextLength && file.contextLength < DEFAULT_CONTEXT ? <p className="help">It holds at most {contextLabel(file.contextLength)}, which is little for Claude Code: it needs about 20k just to start.</p> : null}
        </>
      )}
      <div className="field local-start-field">
        <div className="svc-label">
          <label htmlFor={portId}>Port</label>
          <HelpTip label="What's a port?">The number its address ends in, like 127.0.0.1:{library.ports[kind]}. A free one is filled in; any from 1024 to 65535 works if nothing else uses it.</HelpTip>
        </div>
        <input id={portId} className="input mono" inputMode="numeric" value={port} onChange={(e) => (setPort(e.target.value), setProblem(null))} aria-invalid={!!portBad} />
        {portBad && <p className="small local-warn">{portBad}</p>}
      </div>
      <p className="help">
        {kind === "ollama"
          ? "Ollama starts on 127.0.0.1, so only this machine reaches it. Pull models into it with Get a model."
          : "llama.cpp starts on 127.0.0.1 with this model, so only this machine reaches it. A big model takes a minute or two to load."}
      </p>
      {problem && (
        <p className="small local-warn" role="alert">
          {problem.text}
        </p>
      )}
      {problem?.code === "memory" && (
        <button type="button" className="btn small ghost local-start-anyway" onClick={() => void start(true)} disabled={busy}>
          Start anyway
        </button>
      )}
    </Dialog>
  );
}
