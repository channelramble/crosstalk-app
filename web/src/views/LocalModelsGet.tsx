// Settings → Local models → Get a model (hub/src/localLibrary.ts): a model from Hugging Face (GGUF files for llama.cpp,
// found by name or pasted link) or from Ollama's library (pulled into an Ollama on this machine). Each file shows its
// size, quant and whether it fits this machine at the chosen context, with the one to pick marked; a download shows
// its progress here and in the section, and can be stopped and picked up again.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Download, Loader2 } from "lucide-react";
import type { LocalDownload, LocalLibrary, LocalOllamaInfo, LocalRepoFiles, LocalSearchHit, PoolModel } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { contextsFor, contextText, downloadLine, downloadPct, downloadsText, fitOf, lookFor, lowQuality, machineText, needOf, ollamaNameProblem, paramsText, roomProblem, suggestedFile, type Fit } from "../localLibrary";
import { bytesText, contextLabel, fileName, hfModelUrl, modelName } from "../pool";
import { errorMessage } from "../services";
import { useStore } from "../store";
import { ConfirmButton, Dialog, Seg } from "../ui";
import { HelpTip } from "./HelpTip";

type Source = "huggingface" | "ollama";
const hfId = (m: Pick<PoolModel, "repo" | "files">) => `hf:${m.repo}/${m.files[0]}`;

/** A refusal from the hub with its reason code, so the way out can be offered. */
interface Problem {
  text: string;
  code: string | null;
}
const problemOf = (e: unknown): Problem => ({ text: errorMessage(e), code: e instanceof ApiError ? (e.code ?? null) : null });

export function GetModelDialog({
  library,
  ollamaServers,
  machine,
  onClose,
  onLibrary,
  onFolder,
}: {
  library: LocalLibrary;
  /** The Ollama servers running here, which a pull goes into. */
  ollamaServers: { id: string; label: string }[];
  machine: string;
  onClose: () => void;
  /** An answer with the library in it (a download started or stopped): the section shows it too. */
  onLibrary: (l: LocalLibrary) => void;
  /** Change the downloads folder (its dialog opens over this one). */
  onFolder: () => void;
}) {
  const [source, setSource] = useState<Source>("huggingface");
  const [context, setContext] = useState(32768);
  return (
    <Dialog title="Get a model" icon={<Download size={20} aria-hidden="true" />} wide onClose={onClose}>
      <p className="help local-get-machine">
        {machineText(library.machine, machine)}{" "}
        {library.machine.unified && (
          <HelpTip label="Why only part of the memory?">
            {library.machine.gpuFrom === "estimate"
              ? "On a Mac the GPU can use about two thirds of the memory (three quarters above 36 GB); the rest stays for macOS and apps. Crosstalk reads the exact share once llama.cpp is on this Mac."
              : "On a Mac the GPU can use only part of the memory (llama.cpp measured it); the rest stays for macOS and apps."}
          </HelpTip>
        )}
      </p>
      <Seg
        label="Where from"
        value={source}
        onChange={setSource}
        options={[
          { id: "huggingface", label: "Hugging Face" },
          { id: "ollama", label: "Ollama" },
        ]}
      />
      <div className="local-get-context">
        <div className="svc-label">
          <span>Context</span>
          <HelpTip label="What's context?">How much of a chat the model holds at once. Claude Code needs about 20k just to start; more context takes more memory.</HelpTip>
        </div>
        <Seg label="Context" value={String(context)} onChange={(v) => setContext(Number(v))} options={contextsFor(null).map((c) => ({ id: String(c), label: contextLabel(c) }))} />
      </div>
      {source === "huggingface" ? (
        <HuggingFace library={library} machine={machine} context={context} onLibrary={onLibrary} onFolder={onFolder} />
      ) : (
        <Ollama library={library} servers={ollamaServers} machine={machine} context={context} onLibrary={onLibrary} />
      )}
    </Dialog>
  );
}

/** A search or a pasted link, then a repo's GGUF files, each with its verdict and a Download button. */
function HuggingFace({ library, machine, context, onLibrary, onFolder }: { library: LocalLibrary; machine: string; context: number; onLibrary: (l: LocalLibrary) => void; onFolder: () => void }) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<LocalSearchHit[] | null>(null);
  const [repo, setRepo] = useState<LocalRepoFiles | null>(null);
  const [looking, setLooking] = useState<"search" | "repo" | null>(null);
  const [error, setError] = useState<{ text: string; again?: () => void } | null>(null);
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [tokenAsk, setTokenAsk] = useState(0);
  /** The newest look: an older answer arriving late is dropped. */
  const request = useRef(0);
  useEffect(() => () => void request.current++, []);

  const search = async (q: string) => {
    const id = ++request.current;
    setLooking("search");
    setError(null);
    setRepo(null);
    try {
      const found = await api<LocalSearchHit[]>("GET", `/api/local-models/search?q=${encodeURIComponent(q)}`, undefined, undefined, 30_000);
      if (id === request.current) setHits(found);
    } catch (e) {
      if (id === request.current) setError({ text: errorMessage(e), again: () => void search(q) });
    } finally {
      if (id === request.current) setLooking(null);
    }
  };
  const open = async (name: string) => {
    const id = ++request.current;
    setLooking("repo");
    setError(null);
    setProblems({});
    try {
      const files = await api<LocalRepoFiles>("GET", `/api/local-models/files?repo=${encodeURIComponent(name)}`, undefined, undefined, 45_000);
      if (id === request.current) setRepo(files);
    } catch (e) {
      if (id === request.current) setError({ text: errorMessage(e), again: () => void open(name) });
    } finally {
      if (id === request.current) setLooking(null);
    }
  };
  const back = () => {
    request.current++;
    setRepo(null);
    setError(null);
    setLooking(null);
  };
  const submit = () => {
    // A link or owner/name opens that repo; words are searched for.
    const what = lookFor(text);
    if (!what) setError({ text: "Type at least two letters of a model's name, like qwen3 or gemma." });
    else if ("repo" in what) void open(what.repo);
    else void search(what.q);
  };
  const act = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    setProblems(({ [key]: _gone, ...rest }) => rest);
    try {
      onLibrary(await api<LocalLibrary>("POST", path, body));
    } catch (e) {
      const p = problemOf(e);
      setProblems((x) => ({ ...x, [key]: p }));
      if (p.code === "hf_terms") setTokenAsk((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };

  const fits = (m: PoolModel): Fit => fitOf(needOf(m.sizeBytes, repo?.kvBytesPerToken ?? null, context, repo?.contextLength ?? null).bytes, library.machine, machine);
  const suggestion = repo ? suggestedFile(repo.models, (m) => fits(m).kind) : null;
  const showToken = !!repo && (repo.gated || tokenAsk > 0);

  return (
    <div className="local-get">
      {!repo ? (
        <>
          <form
            className="pool-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="pool-label" htmlFor="local-get-search">
              Search Hugging Face, or paste a link
            </label>
            <div className="pool-link-row">
              <input id="local-get-search" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="qwen3 8b, or owner/model-GGUF" inputMode="search" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <button className="btn" type="submit" disabled={!text.trim() || looking !== null}>
                {looking === "search" ? "Searching…" : "Search"}
              </button>
            </div>
            <p className="help" style={{ margin: "6px 0 0" }}>
              llama.cpp runs GGUF files: these are models with GGUF files, most downloaded first.
            </p>
          </form>
          {looking === "repo" && <Looking text="Looking at its files on Hugging Face…" />}
          {error && <Problem text={error.text} again={error.again} />}
          {/* A private repo, or a token Hugging Face didn't take: the token is the way out. */}
          {error && /hugging face token|saved token/i.test(error.text) && <TokenField has={library.hasHfToken} repo={null} ask={1} onSaved={(has) => onLibrary({ ...library, hasHfToken: has })} />}
          {hits && !hits.length && <p className="help">Nothing with GGUF files matches that. Try fewer words, or paste the model's link.</p>}
          {hits && hits.length > 0 && (
            <div className="choice-cards local-hits" role="list" aria-label="Models found">
              {/* Each a list item holding a button, so it's announced as something to press. */}
              {hits.map((h) => (
                <div key={h.repo} role="listitem" className="local-hit">
                  <button type="button" className="choice-card" onClick={() => void open(h.repo)} disabled={looking !== null}>
                    <span className="choice-card-title pool-wrap">
                      {modelName(h.repo)}
                      {h.gated && <span className="pill orange">Gated</span>}
                    </span>
                    <span className="choice-card-help">{[`by ${h.repo.split("/")[0]}`, paramsText(h.params), downloadsText(h.downloads)].filter(Boolean).join(" · ")}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <section aria-label={`${modelName(repo.repo)} files`}>
          <button type="button" className="btn small ghost pool-back" onClick={back}>
            <ChevronLeft size={14} aria-hidden="true" /> {hits ? "Results" : "Search"}
          </button>
          <div className="pool-model-name">
            {modelName(repo.repo)} {repo.gated && <span className="pill orange">Gated</span>}
          </div>
          <a className="help mono pool-repo" href={hfModelUrl(repo.repo)} target="_blank" rel="noreferrer noopener">
            {repo.repo}
          </a>
          <p className="help">
            {repo.kvBytesPerToken !== null
              ? `At ${contextText(Math.min(context, repo.contextLength ?? context))} it needs the file plus about ${bytesText(repo.kvBytesPerToken * Math.min(context, repo.contextLength ?? context))} for the chat.`
              : `Its files didn't say how much memory a chat takes, so the fit is a guess.`}
            {repo.contextLength && repo.contextLength < context ? ` It holds at most ${contextLabel(repo.contextLength)}.` : ""}
          </p>
          {showToken && <TokenField has={library.hasHfToken} repo={repo.repo} ask={tokenAsk} onSaved={(has) => onLibrary({ ...library, hasHfToken: has })} />}
          {!repo.models.length && <p className="help">No GGUF files here: look for a version of this model whose name ends in GGUF.</p>}
          <ul className="local-files" aria-label="Files">
            {repo.models.map((m) => {
              const id = hfId(m);
              const fit = fits(m);
              const dl = library.downloads.find((d) => d.id === id);
              const done = library.files.some((f) => f.repo === m.repo && f.files[0] === m.files[0]);
              // A download already begun carries on in its own folder, which the hub checks on Resume: the folder chosen now isn't its.
              const room = done || dl ? null : roomProblem(m.sizeBytes, library.folder, library.reserveBytes);
              const problem = problems[id];
              return (
                <li key={m.files.join("|")} className="local-file">
                  <div className="local-file-head">
                    <span className="local-file-title">{m.quant ?? fileName(m.files[0])}</span>
                    <span className={`pill ${fit.tone}`}>{fit.label}</span>
                    {suggestion === m.files[0] && <span className="pill blue">Suggested</span>}
                    {done && <span className="pill green">Downloaded</span>}
                  </div>
                  <div className="help">
                    {bytesText(m.sizeBytes)}
                    {m.files.length > 1 ? ` in ${m.files.length} parts` : ""}
                    {lowQuality(m.quant) ? " · smaller, and noticeably less accurate" : ""}
                  </div>
                  <p className="small local-fit-line">{fit.line}</p>
                  {dl && <DownloadBar d={dl} />}
                  {room && !problem && <p className="small local-warn">{room}</p>}
                  {problem && (
                    <div className="local-problem" role="alert">
                      <p className="small">{problem.text}</p>
                      {(problem.code === "low_disk" || problem.code === "folder") && (
                        <button type="button" className="btn small" onClick={onFolder}>
                          Change folder
                        </button>
                      )}
                    </div>
                  )}
                  {!done && (
                    <div className="local-actions">
                      {dl?.state === "downloading" ? (
                        <button type="button" className="btn small" onClick={() => void act(id, "/api/local-models/downloads/stop", { id })} disabled={busy === id}>
                          Stop
                        </button>
                      ) : (
                        <button type="button" className="btn small primary" aria-label={`${busy === id ? "Starting the download of" : dl ? "Resume" : "Download"} ${m.quant ?? fileName(m.files[0])}`} onClick={() => void act(id, "/api/local-models/downloads", { source: "huggingface", model: m })} disabled={busy === id || !!room}>
                          {busy === id ? "Starting…" : dl ? "Resume" : "Download"}
                        </button>
                      )}
                      {room && (room.startsWith("Not enough room") || !!library.folder.problem) && (
                        <button type="button" className="btn small ghost" onClick={onFolder}>
                          Change folder
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {repo.models.length > 0 && <p className="help">Smallest first. Smaller files lose a little quality; Q4_K_M is a good middle.</p>}
        </section>
      )}
    </div>
  );
}

/** A model from Ollama's library: its name, then its size and verdict (when the library says), and Download. */
function Ollama({ library, servers, machine, context, onLibrary }: { library: LocalLibrary; servers: { id: string; label: string }[]; machine: string; context: number; onLibrary: (l: LocalLibrary) => void }) {
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [info, setInfo] = useState<{ model: string; found: LocalOllamaInfo | null; why: string | null } | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => () => void request.current++, []);
  useEffect(() => {
    if (!servers.some((s) => s.id === serverId)) setServerId(servers[0]?.id ?? "");
  }, [servers, serverId]);
  if (!servers.length) {
    return (
      <p className="help local-get-empty" role="status">
        Ollama isn't running on {machine}. Start it under Start a server (or open the Ollama app), then press Rescan.
      </p>
    );
  }
  const lookUp = async () => {
    const model = name.trim();
    const bad = ollamaNameProblem(model);
    if (bad) {
      setProblem(bad);
      return;
    }
    const id = ++request.current;
    setLooking(true);
    setProblem(null);
    try {
      const found = await api<LocalOllamaInfo>("GET", `/api/local-models/ollama?model=${encodeURIComponent(model)}`, undefined, undefined, 30_000);
      if (id === request.current) setInfo({ model, found, why: null });
    } catch (e) {
      // Not known to Ollama's library from here (or it can't be reached): it can still be pulled; Ollama says if it can't.
      if (id === request.current) setInfo({ model, found: null, why: errorMessage(e) });
    } finally {
      if (id === request.current) setLooking(false);
    }
  };
  const send = async (path: string, body: unknown) => {
    setBusy(true);
    setProblem(null);
    try {
      onLibrary(await api<LocalLibrary>("POST", path, body));
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const fit = info?.found ? fitOf(needOf(info.found.sizeBytes, null, context, null).bytes, library.machine, machine) : null;
  const dl = info ? library.downloads.find((d) => d.id === `ollama:${serverId}:${info.model}`) : undefined;
  return (
    <div className="local-get">
      <form
        className="pool-link-form"
        onSubmit={(e) => {
          e.preventDefault();
          void lookUp();
        }}
      >
        <label className="pool-label" htmlFor="local-get-ollama">
          Model name
        </label>
        <div className="pool-link-row">
          <input id="local-get-ollama" className="input mono" value={name} onChange={(e) => (setName(e.target.value), setInfo(null), setProblem(null))} placeholder="qwen3:8b" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <button className="btn" type="submit" disabled={!name.trim() || looking}>
            {looking ? "Looking…" : "Look up"}
          </button>
        </div>
        <p className="help" style={{ margin: "6px 0 0" }}>
          Names as{" "}
          <a href="https://ollama.com/library" target="_blank" rel="noreferrer noopener">
            ollama.com/library
          </a>{" "}
          writes them. Ollama keeps them in its own folder.
        </p>
      </form>
      {servers.length > 1 && (
        <div className="field">
          <label className="pool-label" htmlFor="local-get-ollama-server">
            Into
          </label>
          <select id="local-get-ollama-server" className="select" value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {problem && <Problem text={problem} />}
      {info && (
        <div className="local-file" aria-label={info.model} role="group">
          <div className="local-file-head">
            <span className="local-file-title mono">{info.model}</span>
            {fit && <span className={`pill ${fit.tone}`}>{fit.label}</span>}
          </div>
          {info.found && <div className="help">{[bytesText(info.found.sizeBytes), info.found.quant, info.found.params ? `${info.found.params} parameters` : null].filter(Boolean).join(" · ")}</div>}
          {fit && <p className="small local-fit-line">{fit.line}</p>}
          {info.why && <p className="small local-warn">{info.why}</p>}
          {dl && <DownloadBar d={dl} />}
          <div className="local-actions">
            {dl?.state === "downloading" ? (
              <button type="button" className="btn small" onClick={() => void send("/api/local-models/downloads/stop", { id: dl.id })} disabled={busy}>
                Stop
              </button>
            ) : (
              <button type="button" className="btn small primary" onClick={() => void send("/api/local-models/downloads", { source: "ollama", serverId, model: info.model })} disabled={busy}>
                {busy ? "Starting…" : dl ? "Resume" : info.found ? "Download" : "Download anyway"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A download's bar and line. The line changes every second, so it isn't read out as it moves (the bar says how far it
 * is when asked); only a change of state is: where it stopped, or what went wrong.
 */
export function DownloadBar({ d }: { d: LocalDownload }) {
  const line = downloadLine(d);
  return (
    <div className="pool-download local-download-bar">
      {d.state !== "failed" && (
        <div className="pool-bar" role="progressbar" aria-label={`Download of ${d.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(downloadPct(d))} aria-valuetext={line}>
          <span style={{ ["--fill" as string]: downloadPct(d) / 100 }} />
        </div>
      )}
      <div className="local-download-line">
        {d.state === "downloading" && d.totalBytes <= 0 && <Loader2 size={12} className="spin" aria-hidden />}
        {line}
      </div>
      {d.state === "downloading" && d.note && <p className="help local-download-note">{d.note}</p>}
      <span className="local-sr" aria-live="polite">
        {d.state === "downloading" ? "" : `${d.name}: ${line}`}
      </span>
    </div>
  );
}

function Looking({ text }: { text: string }) {
  return (
    <p className="muted small" role="status">
      <Loader2 size={13} className="spin" aria-hidden /> {text}
    </p>
  );
}

function Problem({ text, again }: { text: string; again?: () => void }) {
  return (
    <div className="local-problem" role="alert">
      <p className="small">{text}</p>
      {again && (
        <div className="local-actions">
          <button type="button" className="btn small" onClick={again}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The Hugging Face token gated models need: the model pool's (one per hub, kept in its secrets, never shown again).
 * Each `ask` opens the field and puts the cursor in it.
 */
export function TokenField({ has, repo, ask = 0, onSaved }: { has: boolean; repo: string | null; ask?: number; onSaved: (has: boolean) => void }) {
  const toast = useStore((s) => s.toast);
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!ask) return;
    setReplacing(true);
    requestAnimationFrame(() => input.current?.focus());
  }, [ask]);
  const put = async (value: string | null) => {
    const conn = useStore.getState().conn;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ hasHfToken: boolean }>("PUT", "/api/pool/hf-token", { token: value }, conn);
      // The model pool shows the same token.
      if (useStore.getState().conn === conn) useStore.setState((s) => (s.pool ? { pool: { ...s.pool, hasHfToken: r.hasHfToken } } : {}));
      setToken("");
      setReplacing(false);
      onSaved(r.hasHfToken);
      toast("info", value ? "Hugging Face token saved on the hub." : "Hugging Face token removed.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const editing = !has || replacing;
  return (
    <div className="pool-token local-token">
      <div className="pool-token-head">
        <span className="pool-label">Hugging Face token</span>
        {has && <span className="pill green">Saved</span>}
      </div>
      {editing ? (
        <form
          className="pool-token-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void put(token.trim());
          }}
        >
          <input ref={input} className="input mono" type="password" aria-label="Hugging Face token" placeholder={has ? "Paste a new token to replace it" : "hf_…"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} />
          <button className="btn" type="submit" disabled={busy || !token.trim()}>
            {busy ? "Saving…" : "Save token"}
          </button>
          {replacing && has && (
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
      {error && (
        <p className="small local-warn" role="alert">
          {error}
        </p>
      )}
      <p className="help" style={{ margin: 0 }}>
        Gated models need it. First accept the model's terms on{" "}
        {repo ? (
          <a href={hfModelUrl(repo)} target="_blank" rel="noreferrer noopener">
            its page
          </a>
        ) : (
          "its page"
        )}
        , then make a token with Read access at{" "}
        <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer noopener">
          huggingface.co/settings/tokens
        </a>
        . The Model pool uses the same one.
      </p>
    </div>
  );
}
