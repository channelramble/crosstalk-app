import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { PROVIDER_INFO, isServiceOnlyAgent, type CatalogFilter, type CatalogModel, type CatalogSearch, type ServiceAgent, type ServiceTestResult } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { SERVICE_PRESETS, presetNoteHolds, presetSteps, servicePreset, type ServicePreset } from "../presets";
import { DEBOUNCE_MS } from "../search";
import {
  CATALOG_GATED_WORDS, CATALOG_LIST_TOOLS_WORDS, CATALOG_TOOLS_WORDS, MAX_MODELS, NANOGPT_PLAN_WORDS, NANOGPT_TOOLS_WORDS, agentCanRun, agentChoiceHelp, agentsFor, capWords, catalogChips, catalogFacts, catalogIntro, catalogPath, catalogPlaceholder, catalogSummary, chooseAgent, contextOf, errorMessage, formatContext, initialSelection, makeDefault,
  choiceFacts, modelChoices, noDot, noTools, planAtOnce, planCap, UNCENSORED_PICK_WORDS, rememberRows, saveBody, serviceOutcome, testFailure, toggleModel, typedModelNames, type ModelChoice,
} from "../services";
import { useStore } from "../store";
import { Dialog, Seg } from "../ui";
import { InstallBox, useAgentInstall } from "./AgentInstall";
import { PlanNote } from "./FeatherlessPlan";
import { HelpTip } from "./HelpTip";
import { ServiceLines } from "./ServiceLines";


/** What the sheet opens with: nothing (pick a service), or a service with its address and name filled in. */
export interface SheetStart {
  preset?: string;
  baseUrl?: string;
  label?: string;
  /** Check it as soon as it opens: a server found on this machine needs no key first. */
  test?: boolean;
}

function PresetList({ onChoose }: { onChoose: (p: ServicePreset) => void }) {
  return (
    <>
      <p className="help" style={{ marginTop: 0 }}>Pick one. Crosstalk checks it before you add it.</p>
      <div className="choice-cards svc-presets">
        {SERVICE_PRESETS.map((p) => (
          <button key={p.id} type="button" className="choice-card" onClick={() => onChoose(p)}>
            <span className="choice-card-title">{p.title}</span>
            <span className="choice-card-help">{p.help}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The models a check found, as a list to pick from: the first picked is the default. */
function ModelPicker({ choices, selected, onChange }: { choices: ModelChoice[]; selected: string[]; onChange: (s: string[]) => void }) {
  const [filter, setFilter] = useState("");
  const matching = choices.filter((m) => m.id.toLowerCase().includes(filter.trim().toLowerCase()));
  const full = selected.length >= MAX_MODELS;
  return (
    <fieldset className="svc-models">
      <legend>Models</legend>
      <p className="help">
        Pick the ones you want in the model menu, up to {MAX_MODELS}. The first one is the default.
        {choices.some((m) => m.contextWindow) ? " The number beside a model is how much of a chat it can read at once." : ""}
      </p>
      {choices.some(noTools) && <p className="help">A model marked “No tools” can't run commands or edit files, so an agent can't work with it. Those aren't picked for you.</p>}
      {choices.some((m) => m.uncensored) && choices.some((m) => m.uncensored === false) && <p className="help">{UNCENSORED_PICK_WORDS}</p>}
      {choices.length > 8 && <input className="input" aria-label="Filter models" placeholder="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />}
      <ul className="svc-model-list">
        {matching.slice(0, 100).map((m) => {
          const on = selected.includes(m.id);
          // A service that names and prices its models (Refuseless) gets them said the way a catalogue's are.
          const known = !!(m.name || m.price);
          return (
            <li key={m.id} className={known ? "svc-found-row" : undefined}>
              <label className="svc-model">
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onChange(toggleModel(selected, m.id))} />
                {known ? (
                  <span className="svc-model-lines">
                    {m.name && <span className="svc-model-name">{m.name}</span>}
                    <span className="mono svc-model-id">{m.id}</span>
                    <span className="help">{choiceFacts(m)}</span>
                  </span>
                ) : (
                  <>
                    <span className="mono svc-model-id">{m.id}</span>
                    {m.contextWindow ? <span className="help">{formatContext(m.contextWindow)}</span> : null}
                  </>
                )}
              </label>
              {noTools(m) && <span className="pill">No tools</span>}
              {m.uncensored && <span className="pill">Uncensored</span>}
              {on && selected[0] === m.id && <span className="pill blue">Default</span>}
              {on && selected[0] !== m.id && (
                <button type="button" className="btn small ghost" onClick={() => onChange(makeDefault(selected, m.id))}>
                  Make default
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {matching.length > 100 && <p className="help">Showing the first 100. Type in the filter to find the rest.</p>}
      {!matching.length && <p className="help">No model matches that. Clear the filter to see them all.</p>}
      {full && <p className="help">That's {MAX_MODELS}, the most one service keeps. Untick one to pick another.</p>}
    </fieldset>
  );
}

/**
 * Finding a model in a service whose list is a whole catalogue (Featherless serves every model on Hugging Face, 22,000
 * of them; NanoGPT several hundred, each with its own price): the hub searches it and sends back a few rows (GET
 * /api/services/catalog), so no list of thousands and no 7 MB ever reaches the phone. One request after the typing
 * stops, never one per key, and the hub keeps each answer for a few minutes, so backspacing costs nothing. NanoGPT's
 * search looks in one part of its list at a time — its uncensored models to begin with — and its chips switch part.
 */
function CatalogPicker({ catalog, selected, rows, onChange, onFound, cap, atOnce }: { catalog: NonNullable<ServiceTestResult["catalog"]>; selected: string[]; rows: CatalogModel[]; onChange: (s: string[]) => void; onFound: (found: CatalogModel[]) => void; cap?: number; atOnce?: number }) {
  const nano = catalog.name === "nanogpt";
  const [query, setQuery] = useState("");
  /** The part of NanoGPT's list a search looks in (Featherless has none). */
  const [filter, setFilter] = useState<CatalogFilter | undefined>(nano ? "uncensored" : undefined);
  const [answer, setAnswer] = useState<CatalogSearch | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  /** Bumped by Try again and by the one-tap searches, so asking for the same words again really does ask again. */
  const [again, setAgain] = useState(0);
  /** Counts the searches, so a slow answer never replaces a newer one. */
  const asked = useRef(0);
  /** Only the search this opens with goes out at once; after it, typing waits for the typing to stop — whether or not an answer has come back yet. */
  const started = useRef(false);
  const searchId = useId();
  useEffect(() => {
    const id = ++asked.current;
    const first = !started.current;
    started.current = true;
    const timer = setTimeout(async () => {
      setBusy(true);
      setFailed("");
      try {
        const r = await api<CatalogSearch>("GET", catalogPath(catalog.name, query, filter));
        if (id !== asked.current) return;
        setAnswer(r);
        onFound(r.models);
      } catch (e) {
        if (id === asked.current) setFailed(`The search didn't run: ${noDot(errorMessage(e))}.`);
      } finally {
        if (id === asked.current) setBusy(false);
      }
    }, first ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, filter, again]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = (q: string, part?: CatalogFilter) => {
    setQuery(q);
    if (part) setFilter(part);
    setAgain((n) => n + 1);
  };
  const chips = catalogChips(catalog.name);

  const found = answer?.models ?? [];
  // A model you picked stays in view even once the search has moved on, so it can be unticked and made the default.
  const picked = selected.map((id) => rows.find((m) => m.id === id)).filter((m): m is CatalogModel => !!m && !found.some((f) => f.id === m.id));
  const shown = [...picked, ...found];
  const full = selected.length >= MAX_MODELS;
  return (
    <fieldset className="svc-models" aria-busy={busy}>
      <legend>Models</legend>
      <p className="help">
        {catalogIntro(catalog.total)} Pick up to {MAX_MODELS}; the first is the default.
      </p>
      <div className="field">
        <label className="svc-label" htmlFor={searchId}>Search models</label>
        <input id={searchId} className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={catalogPlaceholder(catalog.name)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
      <div className="svc-chips" role="group" aria-label="Quick searches">
        {chips.map((c) => {
          // NanoGPT's chips each say which part of the list is on show; Featherless's are one-tap searches only.
          const on = nano && c.filter === filter && c.q === query.trim();
          return (
            <button key={c.label} type="button" className={`btn small ${on ? "" : "ghost"}`} aria-pressed={nano ? on : undefined} onClick={() => search(c.q, c.filter)}>
              {c.label}
            </button>
          );
        })}
      </div>
      {failed && (
        <p role="alert" className="svc-problem">
          {failed}{" "}
          <button type="button" className="btn small" onClick={() => setAgain((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {/* Every search says it is running, not only the first: the hub's own fetch can take 8 seconds, and the last
          answer's summary and rows would otherwise read as this search's. The rows below dim while it runs, and a
          search that didn't run leaves the words to its own alert rather than the last answer's count. */}
      <p className="help" role="status">{busy ? "Searching…" : failed || !answer ? "" : catalogSummary(answer)}</p>
      {shown.some((m) => !m.tools) && <p className="help">{nano ? NANOGPT_TOOLS_WORDS : CATALOG_TOOLS_WORDS}</p>}
      {shown.some((m) => m.inPlan) && <p className="help">{NANOGPT_PLAN_WORDS}</p>}
      {shown.some((m) => m.toolsSaid === "list") && <p className="help">{CATALOG_LIST_TOOLS_WORDS}</p>}
      {shown.some((m) => m.gated) && <p className="help">{CATALOG_GATED_WORDS}</p>}
      <ul className="svc-model-list">
        {shown.map((m) => {
          const on = selected.includes(m.id);
          return (
            <li key={m.id} className="svc-found-row">
              <label className="svc-model">
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onChange(toggleModel(selected, m.id))} />
                <span className="svc-model-lines">
                  {m.name && <span className="svc-model-name">{m.name}</span>}
                  <span className="mono svc-model-id">{m.id}</span>
                  <span className="help">{catalogFacts(m, atOnce)}</span>
                </span>
              </label>
              {!m.tools && <span className="pill">No tools</span>}
              {m.gated && <span className="pill">Gated</span>}
              {m.uncensored && <span className="pill">Uncensored</span>}
              {m.inPlan && <span className="pill green">In subscription</span>}
              {on && selected[0] === m.id && <span className="pill blue">Default</span>}
              {on && selected[0] !== m.id && (
                <button type="button" className="btn small ghost" onClick={() => onChange(makeDefault(selected, m.id))}>
                  Make default
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {capWords(shown, cap) && <p className="help">{capWords(shown, cap)}</p>}
      {full && <p className="help">That's {MAX_MODELS}, the most one service keeps. Untick one to pick another.</p>}
    </fieldset>
  );
}

/**
 * Settings → AI services → Add an AI service: pick a service, follow its three steps, Test it, and add it as an account
 * of the agent that can run it. Saves through the same route as Add a custom model.
 */
export function AddServiceSheet({ start, onClose }: { start: SheetStart; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const refreshAccounts = useStore((s) => s.refreshAccounts);
  const providers = useStore((s) => s.providers);
  const [preset, setPreset] = useState<ServicePreset | null>(servicePreset(start.preset));
  const [baseUrl, setBaseUrl] = useState(start.baseUrl ?? preset?.baseUrl ?? "");
  const [label, setLabel] = useState(start.label ?? preset?.label ?? "");
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<ServiceTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [failure, setFailure] = useState("");
  const [picked, setPicked] = useState<ServiceAgent | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  /** Every catalogue row a search has shown, so a picked model keeps its facts once the search moves on. */
  const [found, setFound] = useState<CatalogModel[]>([]);
  const [typed, setTyped] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  /** A hosted service's address is tucked away until it's needed: when nothing answers there, it opens. */
  const [addressOpen, setAddressOpen] = useState(false);
  /** Counts the checks, so an answer that comes after the address or key changed is dropped. */
  const asked = useRef(0);
  const opened = useRef({ baseUrl, label });
  /** The models the check ticked for you: a tick or an untick of your own is a change worth asking about on the way out. */
  const offered = useRef<string[]>([]);
  const [keyId, addressId, namesId, contextId, nameId, namesProblemId] = [useId(), useId(), useId(), useId(), useId(), useId()];
  /** OpenCode, installed from right here: the key, the check and the ticks stay as they are meanwhile. */
  const openCodeInstall = useAgentInstall("opencode");

  const choose = (p: ServicePreset | null) => {
    asked.current++;
    setPreset(p);
    setBaseUrl(p?.baseUrl ?? "");
    setLabel(p?.label ?? "");
    opened.current = { baseUrl: p?.baseUrl ?? "", label: p?.label ?? "" };
    setApiKey("");
    setResult(null);
    setTesting(false);
    setFailure("");
    setPicked(null);
    setSelected([]);
    offered.current = [];
    setFound([]);
    setTyped("");
    setContext("");
    setSaveError("");
    setAddressOpen(false);
  };
  /** A change to the address or key: what the last check found no longer applies. */
  const forget = () => {
    asked.current++;
    setResult(null);
    setTesting(false);
    setFailure("");
  };
  const test = async () => {
    if (!preset) return;
    const id = ++asked.current;
    setTesting(true);
    setFailure("");
    setResult(null);
    setSaveError("");
    try {
      // No agent is named: the check says which can run it, and the sheet picks from that (the preset's is only the
      // first choice). Naming one would make the hub add "X can't use this server, add it under Y" under a green result.
      const r = await api<ServiceTestResult>("POST", "/api/services/test", {
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(preset.chatPath ? { chatPath: preset.chatPath } : {}),
      });
      if (id !== asked.current) return;
      setResult(r);
      // A catalogue service lists thousands: nothing is picked for you, because you pick by searching.
      const pick = r.catalog ? [] : initialSelection(modelChoices(r));
      setSelected(pick);
      offered.current = pick;
      setFound([]);
      setPicked(null);
      if (!r.reachable) setAddressOpen(true);
    } catch (e) {
      if (id === asked.current) setFailure(testFailure(errorMessage(e), e instanceof ApiError ? e.status : undefined));
    } finally {
      if (id === asked.current) setTesting(false);
    }
  };
  // Once, even where effects run twice (React's strict mode): it's one check, not two.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (start.test && preset && !autoChecked.current) {
      autoChecked.current = true;
      void test();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const choices = result ? modelChoices(result) : [];
  const agents = result ? agentsFor(result) : [];
  // A preset that prefers OpenCode keeps it picked even before it's installed, because it can be installed from here (below);
  // any other agent that isn't there gives way to one that is (chooseAgent).
  const agent = result && preset ? chooseAgent(result, preset.agent, picked ?? (preset.agent === "opencode" ? "opencode" : null), { claude: providers.claude?.installed, codex: providers.codex?.installed, opencode: providers.opencode?.installed }) : null;
  const installed = !agent || providers[agent]?.installed !== false;
  const said = typedModelNames(typed);
  const names = choices.length || result?.catalog ? selected : said.names;
  // A model found by searching a catalogue carries its own size, so there's nothing to ask for.
  const sizeKnown = !!result && (contextOf(result, names[0]) !== null || !!found.find((m) => m.id === names[0])?.contextWindow);
  // Not there, or there and still no use (a version 1, say): what's below says why, with the way out.
  const canAdd = !!result && !!agent && agentCanRun(agent, providers[agent]) && names.length > 0 && !busy;
  // The models ticked and the agent picked count too: a server on this machine needs no key and fills its own address
  // and name in, so a tap beside the sheet used to throw the whole check and every tick away without asking.
  const dirty = !!preset && !busy && (!!apiKey.trim() || baseUrl !== opened.current.baseUrl || label !== opened.current.label || !!typed || !!context || !!picked || selected.join("\n") !== offered.current.join("\n"));

  const add = async () => {
    if (!result || !agent) return;
    setBusy(true);
    setSaveError("");
    try {
      await api("POST", "/api/accounts/endpoint", saveBody({ agent, result, preset, baseUrl, apiKey, label, models: names, context, found }));
      await refreshAccounts().catch(() => {});
      // A service on Crosstalk's own agent or OpenCode is a row of its own in New chat; one on Claude Code or Codex is that agent's account.
      toast("info", isServiceOnlyAgent(agent) ? `Added. Start a chat on ${label.trim() || "it"} from New chat.` : `Added. Pick it as the account in a new ${PROVIDER_INFO[agent].name} chat.`);
      onClose();
    } catch (e) {
      // A name that's taken (say, a second Kimi): say how to get past it.
      setSaveError(e instanceof ApiError && e.status === 409 ? `${noDot(errorMessage(e))}. Give it another name above, then press Add it.` : `${noDot(errorMessage(e))}. Press Add it to try again.`);
    } finally {
      setBusy(false);
    }
  };

  const hosted = preset?.kind === "hosted";
  const steps = preset ? presetSteps(preset) : null;
  const canTest = !testing && !!baseUrl.trim() && !(hosted && !apiKey.trim());
  /** Enter in the address or key field is Test (a keyboard's Go). */
  const enterTests = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && canTest) {
      e.preventDefault();
      void test();
    }
  };
  const addressField = (
    <div className="field">
      <div className="svc-label">
        <label htmlFor={addressId}>Server address</label>
        <HelpTip label="What's a server address?">
          {hosted ? "Where the service lives. The preset fills it in; change it only if the service tells you to." : "Where the server listens, as this machine reaches it, like http://127.0.0.1:11434."}
        </HelpTip>
      </div>
      <input id={addressId} className="input mono" inputMode="url" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); forget(); }} onKeyDown={enterTests} placeholder="http://127.0.0.1:8080" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
    </div>
  );
  const keyField = (
    <div className="field">
      <div className="svc-label">
        <label htmlFor={keyId}>{hosted ? "API key" : "API key (optional)"}</label>
        <HelpTip label="What's an API key?">A long password from the service's website. Crosstalk keeps it on this machine and sends it only to that service.</HelpTip>
      </div>
      <input id={keyId} className="input mono" type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); forget(); }} onKeyDown={enterTests} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={hosted ? "Paste your key" : "Only if the server asks for one"} />
    </div>
  );

  return (
    <Dialog
      title="Add an AI service"
      dirty={dirty}
      onClose={() => !busy && onClose()}
      footer={(requestClose) => (
        <>
          {saveError && <p role="alert" className="svc-foot-error">{saveError}</p>}
          <button className="btn" onClick={() => requestClose()} disabled={busy}>
            Cancel
          </button>
          {preset && (
            <button className="btn primary" onClick={add} disabled={!canAdd}>
              {busy ? "Adding…" : "Add it"}
            </button>
          )}
        </>
      )}
    >
      {!preset || !steps ? (
        <PresetList onChoose={choose} />
      ) : (
        <>
          <button type="button" className="btn small ghost svc-back" onClick={() => choose(null)}>
            <ChevronLeft size={16} aria-hidden /> All services
          </button>
          <h4 className="svc-sheet-title">{preset.title}</h4>
          {preset.docs && (
            <p className="help" style={{ marginTop: 0 }}>
              Not sure? Read{" "}
              <a href={preset.docs.url} target="_blank" rel="noreferrer noopener">{preset.docs.label}</a>.
            </p>
          )}
          {/* A service with terms of its own for agents (Featherless's Chat plan doesn't allow them) says so as a warning,
              with its plans linked, before any key is checked: the plan is picked on its site before the key is made. */}
          {preset.plan &&
            (preset.pricing ? (
              <p className="svc-terms" role="note">
                {preset.plan} See{" "}
                <a href={preset.pricing.url} target="_blank" rel="noreferrer noopener">{preset.pricing.label}</a>.
              </p>
            ) : (
              <p className="help" style={{ marginTop: 0 }}>{preset.plan}</p>
            ))}
          {preset.note && presetNoteHolds(preset, agent, providers) && <p className="help" style={{ marginTop: 0 }}>{preset.note}</p>}
          <div>
            <ol className="svc-steps">
              <li>
                <span>{steps[0]}</span>
                {preset.keyPage && (
                  <a className="btn small svc-open" href={preset.keyPage.url} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={14} aria-hidden /> Open {preset.keyPage.label}
                  </a>
                )}
              </li>
              <li>
                <span>{steps[1]}</span>
                {!hosted && addressField}
                {keyField}
              </li>
              <li>
                <span>{steps[2]}</span>
                <button type="button" className="btn small primary svc-test" onClick={() => void test()} disabled={!canTest}>
                  {testing ? "Testing…" : "Test"}
                </button>
              </li>
            </ol>
            {hosted && (
              <details className="field-details" open={addressOpen} onToggle={(e) => setAddressOpen(e.currentTarget.open)}>
                <summary>Server address</summary>
                {addressField}
              </details>
            )}
          </div>
          {failure && <p role="alert" className="svc-problem">{failure}</p>}
          {/* Always here, empty until the check comes back: a live region put on the screen with its own first words
              isn't read out, so what the check found would be said to nobody. */}
          <ServiceLines outcome={result && serviceOutcome(result, preset)} />
          {/* Which plan the key is on, where the service says (Featherless): the Chat plan's terms don't allow agents. */}
          {result?.plan && <PlanNote plan={result.plan} announce />}
          {result && (
            <>
              {agents.length > 1 && agent && (
                <div className="field svc-agent">
                  <span>Use it with</span>
                  <Seg label="Use it with" value={agent} options={agents.map((p) => ({ id: p, label: PROVIDER_INFO[p].name }))} onChange={setPicked} />
                  <span className="help">{agentChoiceHelp(agents, agent)}</span>
                </div>
              )}
              {/* OpenCode's install is right here, so nothing typed or ticked above is thrown away for it. */}
              {agent === "opencode" && (!installed || !!providers.opencode?.error || openCodeInstall.phase !== "idle") && (
                <InstallBox
                  install={openCodeInstall}
                  says={{
                    idle: providers.opencode?.error || `${PROVIDER_INFO.opencode.name} isn't installed on this machine yet. Crosstalk can install it now, and what you've filled in here stays.`,
                    running: "What you've filled in here stays.",
                    done: "You can add the service now.",
                  }}
                  idleAction={!installed || providers.opencode?.error ? `Install ${PROVIDER_INFO.opencode.name}` : undefined}
                  fallback={agents.includes("builtin") ? "Or pick Crosstalk agent above: it needs nothing installed." : undefined}
                />
              )}
              {agent && agent !== "opencode" && !installed && (
                <p role="alert" className="svc-problem">
                  {PROVIDER_INFO[agent].name} isn't installed on this machine yet. Close this, press Install under {PROVIDER_INFO[agent].name} below, then add the service.
                </p>
              )}
              {agent &&
                (result.catalog ? (
                  <CatalogPicker
                    catalog={result.catalog}
                    selected={selected}
                    rows={found}
                    onChange={setSelected}
                    onFound={(rows) => setFound((seen) => rememberRows(seen, rows, selected))}
                    cap={planCap(result, preset)}
                    atOnce={planAtOnce(result, preset)}
                  />
                ) : choices.length ? (
                  <ModelPicker choices={choices} selected={selected} onChange={setSelected} />
                ) : (
                  <div className="field">
                    <label className="svc-label" htmlFor={namesId}>Model names</label>
                    <input id={namesId} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. deepseek-chat, deepseek-reasoner" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={!!said.problem} aria-describedby={said.problem ? namesProblemId : undefined} />
                    <span className="help">It didn't list its models. Type the ones you want, separated by commas. The first is the default.</span>
                    {said.problem && (
                      <span className="help" id={namesProblemId} style={{ color: "var(--orange)" }}>
                        {said.problem}
                      </span>
                    )}
                  </div>
                ))}
              {agent && names.length > 0 && !sizeKnown && (
                <div className="field">
                  <div className="svc-label">
                    <label htmlFor={contextId}>Context size (tokens, optional)</label>
                    <HelpTip label="What's a context size?">How much of a chat the model can read at once, counted in tokens (a token is about three quarters of a word). Chats summarize older messages at three quarters of it.</HelpTip>
                  </div>
                  <input id={contextId} className="input mono" inputMode="numeric" value={context} onChange={(e) => setContext(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 65536" />
                  <span className="help">It didn't say. If you know it, enter it here.</span>
                </div>
              )}
              {agent && (
                <div className="field">
                  <label className="svc-label" htmlFor={nameId}>Name</label>
                  <input id={nameId} className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Qwen on this Mac" />
                </div>
              )}
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
