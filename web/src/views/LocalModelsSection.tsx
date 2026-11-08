// Settings → Local models (docs/SPEC-0.5.md, track T10): what model servers run on this machine, the memory they use, and a
// switch per model that frees its memory or loads it again (hub/src/localModels.ts). The image editor and the model pool keep
// their own sections: a line for each here jumps to it and says whether it's on. Below the servers: starting one (Ollama, or
// llama.cpp with a downloaded model) and the models on this machine, with Get a model (LocalModelsLibrary.tsx, LocalModelsGet.tsx).
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { LocalLibrary, LocalModel, LocalModelServer, LocalModelsView, LocalModelSwitch, LocalServerStart } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { imageEditorLine } from "../imageEditor";
import { endMove, failMove, moveKey, poolLine, rowView, serverMemory, sortModels, startMove, whyNotes, type Moves } from "../localModels";
import { errorMessage, noDot } from "../services";
import { useStore } from "../store";
import { ConfirmButton, Switch } from "../ui";
import { useReconnected } from "../useReconnected";
import { AddServiceSheet, type SheetStart } from "./AddServiceSheet";
import { HelpTip } from "./HelpTip";
import { GetModelDialog } from "./LocalModelsGet";
import { FolderDialog, ModelsHere, StartDialog, StartServers, type LibraryActions, type Problem } from "./LocalModelsLibrary";
import { useMachineName } from "./MachinePicker";

const host = (s: { baseUrl: string }) => s.baseUrl.replace(/^https?:\/\//, "");
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

interface Actions {
  turn(s: LocalModelServer, m: LocalModel, on: boolean): void;
  keep(key: string): void;
  add(s: LocalModelServer): void;
}

/** Stopping a server Crosstalk started (from its card): what the hub said last about it, and whether it's on its way. */
interface Stopping {
  onStop: () => void;
  busy: boolean;
  /** The hub's word on it ("It didn't stop: …"), or what a Stop that failed said. */
  note: string | null;
}

/** One server: its address, the memory it holds and Add to AI services, then its models, each with a switch (held still while a Rescan is under way: its answer would be older than a switch's). */
function ServerCard({ server: s, moves, actions, machine, busy, stop }: { server: LocalModelServer; moves: Moves; actions: Actions; machine: string; busy: boolean; stop: Stopping | null }) {
  const now = Date.now();
  const notes = whyNotes(s.models);
  return (
    <section className="card local-server" aria-label={`${s.label} on ${host(s)}`}>
      <div className="local-head">
        <div className="local-head-text">
          <div className="pool-setting-title">{s.label}</div>
          <div className="help mono">{host(s)}</div>
        </div>
        {s.accountIds.length ? (
          <span className="pill green">In AI services</span>
        ) : (
          <button type="button" className="btn small primary" onClick={() => actions.add(s)}>
            Add to AI services
          </button>
        )}
      </div>
      <div className="local-memory">
        <span>Memory in use</span>
        <HelpTip label="What does memory mean?">What the server is holding in {machine}'s memory right now.</HelpTip>
        <span className="local-memory-value">{serverMemory(s)}</span>
      </div>
      {!s.models.length && <p className="help">This server lists no models yet. Load or pull one in it, then press Rescan.</p>}
      <ul className="local-models">
        {sortModels(s.models).map((m) => {
          const key = moveKey(s.id, m.id);
          const move = moves[key];
          const v = rowView(m, move, now);
          return (
            <li key={m.id} className="local-model">
              <div className="local-model-row">
                <div className="local-model-text">
                  <div className="local-model-name">{m.id}</div>
                  <div className="help local-model-state" aria-live="polite">
                    {v.working && <Loader2 size={13} className="spin" aria-hidden />}
                    {v.line}
                  </div>
                </div>
                {!v.noSwitch && <Switch checked={v.on} onChange={(on) => actions.turn(s, m, on)} label={m.id} disabled={v.disabled || busy} />}
              </div>
              {v.problem && (
                <div className="local-problem" role="alert">
                  <p className="small">{v.problem}</p>
                  <div className="local-actions">
                    <button type="button" className="btn small primary" onClick={() => actions.turn(s, m, move!.to)}>
                      Try again
                    </button>
                    <button type="button" className="btn small ghost" onClick={() => actions.keep(key)}>
                      Keep it as it was
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {notes.map((w) => (
        <p key={w} className="help local-why">
          {w}
        </p>
      ))}
      {stop ? (
        <div className="local-stop">
          <span className="help">Crosstalk started it.</span>
          <ConfirmButton
            label={stop.busy ? "Stopping…" : "Stop"}
            ariaLabel={`Stop ${s.label}`}
            question="Stop it? Chats using it stop answering."
            confirmLabel="Stop it"
            className="btn small"
            disabled={stop.busy}
            onConfirm={stop.onStop}
          />
          {stop.note && (
            <p className="small local-warn" role="alert">
              {stop.note}
            </p>
          )}
        </div>
      ) : (
        s.stopWhy && <p className="help local-why">{s.stopWhy}</p>
      )}
    </section>
  );
}

/** The image editor and the model pool have their own sections: one line each that jumps there, with its on/off state when the hub has said. */
function AlsoHere({ machine }: { machine: string }) {
  const editor = useStore((s) => s.imageEditor);
  const pool = useStore((s) => s.pool);
  const rows = [
    ...(editor?.installed ? [{ id: "image-editor", name: "Image editor", state: imageEditorLine(editor, machine) }] : []),
    { id: "model-pool", name: "Model pool", state: poolLine(pool?.status.state) },
  ];
  return (
    <section aria-label="Also on this machine">
      <h3 className="svc-sub local-also">Also on this machine</h3>
      <div className="card local-links">
        {rows.map((r) => (
          <button key={r.id} type="button" className="local-link" aria-label={`Go to ${r.name}${r.state ? `: ${r.state}` : ""}`} onClick={() => jump(r.id)}>
            <span className="local-link-text">
              <span className="pool-setting-title">{r.name}</span>
              {r.state && <span className="help local-link-state">{r.state}</span>}
            </span>
            <ChevronRight size={18} aria-hidden />
          </button>
        ))}
      </div>
    </section>
  );
}

export function LocalModelsSection() {
  const machine = useMachineName();
  /**
   * What the heavy things on this machine hold right now, from the memory guard (hub/src/memory.ts). The pills below
   * are about starting a server now, so they are drawn against the machine as it is: a green "Fits" for a 10 GB model
   * while ComfyUI holds 12.5 GB, followed by the hub's own 409 "nothing is free" on tapping Start, would be the phone
   * and the hub giving two answers.
   */
  const taken = useStore((s) => s.memory?.takenBytes ?? 0);
  const [view, setView] = useState<LocalModelsView | null>(null);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState("");
  /** An older hub has no Local models: nothing is shown. */
  const [missing, setMissing] = useState(false);
  const [moves, setMoves] = useState<Moves>({});
  const [sheet, setSheet] = useState<SheetStart | null>(null);
  /** The newest look: an older answer arriving late is dropped. */
  const request = useRef(0);
  const moving = Object.values(moves).some((m) => !m.failed);
  /** Getting models and starting servers (GET /api/local-models/library); an older hub has none of it. */
  const [library, setLibrary] = useState<LocalLibrary | null>(null);
  const [libraryMissing, setLibraryMissing] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  /** Quiet looks that failed: each one sets the next look going (the hub restarting mid-download, say). */
  const [missed, setMissed] = useState(0);
  const libraryRequest = useRef(0);
  const [getting, setGetting] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [starting, setStarting] = useState<{ kind: LocalServerStart["kind"]; model?: string } | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, Problem>>({});

  /** Looks at the machine again (`fresh`: not the hub's scan of the last ten seconds); `quiet` shows nothing while it does. */
  const scan = async (fresh = false, quiet = false) => {
    const id = ++request.current;
    if (!quiet) {
      setScanning(true);
      setError("");
    }
    try {
      const r = await api<LocalModelsView>("GET", `/api/local-models${fresh ? "?fresh=1" : ""}`);
      if (id === request.current) {
        setView(r);
        setError("");
      }
    } catch (e) {
      if (id !== request.current) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else if (!quiet) setError(errorMessage(e));
    } finally {
      if (id === request.current) setScanning(false);
    }
  };
  /** The library as the hub has it now; `quiet` (a look while something runs) shows nothing if it fails. */
  const loadLibrary = async (quiet = false) => {
    const id = ++libraryRequest.current;
    try {
      const l = await api<LocalLibrary>("GET", "/api/local-models/library", undefined, undefined, 30_000);
      if (id === libraryRequest.current) {
        setLibrary(l);
        setLibraryError("");
      }
    } catch (e) {
      if (id !== libraryRequest.current) return;
      if (e instanceof ApiError && e.status === 404) setLibraryMissing(true);
      else if (!quiet) setLibraryError(errorMessage(e));
      else setMissed((n) => n + 1);
    }
  };
  /** An answer with the library in it: newer than any look still on its way. */
  const tookLibrary = (l: LocalLibrary) => {
    libraryRequest.current++;
    setLibrary(l);
    setLibraryError("");
  };
  useEffect(() => {
    void scan();
    void loadLibrary();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => {
    if (error) void scan();
    // Whatever changed meanwhile (a download the restarted hub carried on) is shown; quietly when the page has the library.
    void loadLibrary(!libraryError && !!library);
  });
  // While a download runs, a server starts or stops, or the folder hasn't answered the hub yet (a drive waking up), the library
  // is looked at every second; once a server has started or stopped, or a download finished, the servers are looked for again
  // (a started one appears, Ollama lists what it pulled).
  const working = !!library && (!!library.folder.pending || library.downloads.some((d) => d.state === "downloading") || library.started.some((x) => x.state === "starting" || x.state === "stopping"));
  useEffect(() => {
    if (!working) return;
    // A look that failed doesn't change the library, so `missed` sets the next one going: the bar never stops for good.
    const timer = setTimeout(() => void loadLibrary(true), 1000);
    return () => clearTimeout(timer);
  }, [working, library, missed]); // eslint-disable-line react-hooks/exhaustive-deps
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!library) return;
    const key = JSON.stringify([library.started.map((x) => [x.id, x.state]), library.downloads.filter((d) => d.state === "downloading").map((d) => d.id)]);
    if (settled.current !== null && settled.current !== key) void scan(true, true);
    settled.current = key;
  }, [library]); // eslint-disable-line react-hooks/exhaustive-deps

  const libraryActions: LibraryActions = {
    busy: acting,
    problems,
    clear: (key) => setProblems(({ [key]: _gone, ...rest }) => rest),
    send: async (key, path, body) => {
      setActing(key);
      setProblems(({ [key]: _gone, ...rest }) => rest);
      try {
        tookLibrary(await api<LocalLibrary>("POST", path, body, undefined, 30_000));
        return true;
      } catch (e) {
        setProblems((x) => ({ ...x, [key]: { text: errorMessage(e), code: e instanceof ApiError ? (e.code ?? null) : null } }));
        return false;
      } finally {
        setActing(null);
      }
    },
  };
  const saveFolder = async (path: string | null): Promise<string | null> => {
    try {
      const folder = await api<LocalLibrary["folder"]>("PUT", "/api/local-models/folder", { path });
      setLibrary((l) => (l ? { ...l, folder } : l));
      void loadLibrary(true);
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  };
  const startServer = async (body: LocalServerStart): Promise<Problem | null> => {
    try {
      tookLibrary(await api<LocalLibrary>("POST", "/api/local-models/start", body, undefined, 30_000));
      return null;
    } catch (e) {
      return { text: errorMessage(e), code: e instanceof ApiError ? (e.code ?? null) : null };
    }
  };
  // A model that's loading (llama.cpp's router) is looked at again until it has loaded.
  const loading = !!view?.servers.some((s) => s.models.some((m) => m.loading));
  useEffect(() => {
    if (!loading || moving) return;
    const timer = setTimeout(() => void scan(false, true), 3000);
    return () => clearTimeout(timer);
  }, [loading, view, moving]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Moves a model's switch: the hub loads or frees it and answers its server as it is then. */
  const turn = async (s: LocalModelServer, m: LocalModel, on: boolean) => {
    const key = moveKey(s.id, m.id);
    setMoves((x) => startMove(x, key, on));
    try {
      const body: LocalModelSwitch = { serverId: s.id, model: m.id, on };
      const fresh = await api<LocalModelServer>("POST", "/api/local-models/switch", body, undefined, 30_000);
      // This answer is newer than any look still on its way.
      request.current++;
      setScanning(false);
      setView((v) => (v ? { ...v, servers: v.servers.map((x) => (x.id === fresh.id ? fresh : x)) } : v));
      setMoves((x) => endMove(x, key));
    } catch (e) {
      setMoves((x) => failMove(x, key, errorMessage(e)));
    }
  };
  const actions: Actions = {
    turn: (s, m, on) => void turn(s, m, on),
    // Keep it as it was: the failure goes, and the page shows how the model really stands now.
    keep: (key) => {
      setMoves((x) => endMove(x, key));
      void scan(true, true);
    },
    add: (s) => setSheet({ preset: "local", baseUrl: s.baseUrl, label: s.label, test: true }),
  };

  if (missing) return null;
  const servers = view?.servers ?? [];
  const stopping = (s: LocalModelServer): Stopping | null => {
    if (!s.startedId || !library) return null;
    const id = s.startedId;
    const key = `stop:${id}`;
    const run = library.started.find((x) => x.id === id);
    return {
      busy: acting === key || run?.state === "stopping",
      note: problems[key]?.text ?? (run?.state === "running" ? run.detail : null),
      onStop: () => void libraryActions.send(key, "/api/local-models/stop", { id }),
    };
  };
  const ollamaServers = servers.filter((s) => s.kind === "ollama").map((s) => ({ id: s.id, label: s.label }));
  return (
    <>
      <h2 className="settings-heading" id="local-models">Local models</h2>
      <div className="local-bar">
        <p className="help">What's running on {machine} and the memory it uses. Switch a model off to free its memory.</p>
        <button type="button" className="btn small" onClick={() => void scan(true)} disabled={scanning || moving}>
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      {error && (
        <p className="svc-problem" role="alert">
          Couldn't look for local models: {noDot(error)}. Press Rescan to try again.
        </p>
      )}
      {!view && scanning && <p className="help">Looking for model servers…</p>}
      {view && !servers.length && (
        <div className="card">
          <p className="help local-empty">Nothing is running here. Start Ollama, LM Studio or llama.cpp, then press Rescan.</p>
        </div>
      )}
      {servers.map((s) => (
        <ServerCard key={s.id} server={s} moves={moves} actions={actions} machine={machine} busy={scanning} stop={stopping(s)} />
      ))}
      {libraryError && !library && (
        <p className="svc-problem" role="alert">
          Couldn't look at the models on {machine}: {noDot(libraryError)}.{" "}
          <button type="button" className="btn small" onClick={() => void loadLibrary()}>
            Try again
          </button>
        </p>
      )}
      {library && !libraryMissing && (
        <>
          <StartServers library={library} shownPorts={servers.map((s) => Number(new URL(s.baseUrl).port))} ollamaPorts={servers.filter((s) => s.kind === "ollama").map((s) => Number(new URL(s.baseUrl).port))} actions={libraryActions} onStart={(kind, model) => setStarting({ kind, model })} />
          <ModelsHere library={library} machine={machine} taken={taken} actions={libraryActions} onGet={() => setGetting(true)} onFolder={() => setChoosingFolder(true)} onStart={(kind, model) => setStarting({ kind, model })} />
        </>
      )}
      <AlsoHere machine={machine} />
      {getting && library && <GetModelDialog library={library} ollamaServers={ollamaServers} machine={machine} onClose={() => setGetting(false)} onLibrary={tookLibrary} onFolder={() => setChoosingFolder(true)} />}
      {choosingFolder && library && <FolderDialog folder={library.folder} onClose={() => setChoosingFolder(false)} onSave={saveFolder} />}
      {starting && library && <StartDialog library={library} machine={machine} taken={taken} kind={starting.kind} model={starting.model} onClose={() => setStarting(null)} onStart={startServer} />}
      {sheet && (
        <AddServiceSheet
          start={sheet}
          onClose={() => {
            setSheet(null);
            void scan(false, true);
          }}
        />
      )}
    </>
  );
}
