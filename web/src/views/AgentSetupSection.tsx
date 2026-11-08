// Settings → Set up with an AI agent: what's left to set up on the machine on screen (the hub's checklist, GET
// /api/setup), and how to let an AI agent there do it: the command that adds its setup tools (or "Add for me"), and
// what to tell it. docs/SETUP-FOR-AGENTS.md is the agent's side.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck, Loader2 } from "lucide-react";
import type { PtyInfo, SetupChecklist, SetupItem } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { addOutcome, agentPrompt, allDone, browserosNote, browserosRows, connectRows, goThere, linkLabel, parts, removeCommand, stateWord, summaryText, type AddOutcome, type SetupAgent } from "../agentSetup";
import { useStore } from "../store";
import { plainText } from "../terminalText";
import { copyText, thisDevice, timeAgo } from "../ui";
import { checklistAgent, checklistPromptLine } from "../signIn";
import { SignInPrompt } from "./SignIn";
import { useReconnected } from "../useReconnected";
import { HelpTip } from "./HelpTip";
import { useMachineName } from "./MachinePicker";
import { TerminalDialog } from "./SetupPage";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AgentSetupSection() {
  const machine = useMachineName();
  const toast = useStore((s) => s.toast);
  // Sign-ins and installs show up here too: the agents' items change with them.
  const agents = useStore((s) => JSON.stringify([Object.values(s.providers).map((p) => [p?.provider, p?.installed, p?.signedIn]), Object.values(s.accounts).map((a) => [a.provider, a.id, a.signedIn])]));
  const [list, setList] = useState<SetupChecklist | null>(null);
  const [error, setError] = useState("");
  /** Its hub is older than this list. */
  const [older, setOlder] = useState(false);
  const [checking, setChecking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState<{ agent: SetupAgent; name: string; pty: PtyInfo } | null>(null);
  /** "Add for me" was tapped and the hub is starting the agent's own command: no second one until it answers. */
  const [starting, setStarting] = useState<SetupAgent | null>(null);
  const startingNow = useRef(false);
  /** How the agent's own command ended, once it has: null while it still runs. */
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  // Whether each agent's program is there, as that machine says (agentSetup.ts connectRows: only for an item whose
  // state is about its sign-in, not the program).
  const claudeThere = useStore((s) => s.providers.claude?.installed);
  const codexThere = useStore((s) => s.providers.codex?.installed);
  // That machine signs agents in from the phone (its state says which accounts are signed out): an agent item waiting
  // on a sign-in offers it right there.
  const signIn = useStore((s) => s.signIns !== null);
  // The add's terminal as the live connection last told it: how it ended can arrive here while reading it fails.
  const addInfo = useStore((s) => (adding ? s.ptys[adding.pty.id] : undefined));
  const liveInfo = useRef(addInfo);
  liveInfo.current = addInfo;
  const request = useRef(0);
  const card = useRef<HTMLDivElement>(null);

  /** `fresh`: not the hub's last few seconds' list. Check again also asks the agents again (it can take 20 seconds). */
  const load = async (how: "cached" | "fresh" | "recheck" = "cached") => {
    const id = ++request.current;
    if (how === "recheck") setChecking(true);
    try {
      const c = how === "recheck" ? await api<SetupChecklist>("POST", "/api/setup/recheck", undefined, undefined, 90_000) : await api<SetupChecklist>("GET", `/api/setup${how === "fresh" ? "?fresh=1" : ""}`);
      if (id !== request.current) return;
      setList(c);
      setError("");
      setOlder(false);
    } catch (e) {
      if (id !== request.current) return;
      if (e instanceof ApiError && e.status === 404) setOlder(true);
      else setError(message(e));
    } finally {
      if (id === request.current) setChecking(false);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Its hub is back after it was down: maybe updated and restarted, so an older hub's message is asked about again too
  // (Settings on a linked machine comes from this hub, so nothing reloads the page for it).
  useReconnected(() => void load());
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Settings asks the agents again when it opens: their answers come in one by one, so wait for them to settle (the
    // hub works its list out again once an agent's answer changed).
    const timer = setTimeout(() => void load(), 1500);
    return () => clearTimeout(timer);
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps

  // One add at a time: each tap would start the agent's own `mcp add` in a terminal of its own on the hub, and only the
  // last would be shown (or could be cancelled), while the first could make the second report "already there".
  const addFor = async (agent: "claude" | "codex", name: string) => {
    if (startingNow.current || adding) return;
    startingNow.current = true;
    setStarting(agent);
    try {
      setOutcome(null);
      setAdding({ agent, name, pty: await api<PtyInfo>("POST", "/api/setup/connect", { agent }) });
    } catch (e) {
      toast("error", message(e));
    } finally {
      startingNow.current = false;
      setStarting(null);
    }
  };

  // "Add for me": wait for the agent's own command to end, then say how it went. The hub's own exit code decides
  // whether it worked; the output is read only to tell "the tools were already there" from a real failure, since
  // Claude Code refuses with an error for one that was added before (agentSetup.ts addOutcome).
  useEffect(() => {
    if (!adding) return;
    let watching = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const r = await api<{ info: PtyInfo; scrollback: string }>("GET", `/api/pty/${adding.pty.id}`);
        if (!watching) return;
        if (!r.info.alive) return setOutcome(addOutcome(adding.agent, r.info.exitCode, plainText(r.scrollback)));
      } catch {
        // Couldn't be read (the hub restarting, say). The live connection may still have said how it ended — the
        // dialog's footer goes by that — so say what its exit code alone can tell, and keep reading: the output, once
        // it can be read, says the rest. Nothing is claimed while neither says it ended.
        const live = liveInfo.current;
        if (watching && live && !live.alive) setOutcome(addOutcome(adding.agent, live.exitCode, null));
      }
      if (watching) timer = setTimeout(() => void check(), 1000);
    };
    void check();
    return () => {
      watching = false;
      clearTimeout(timer);
    };
  }, [adding]);

  useKeepFocus(card);

  return (
    <>
      <h2 className="settings-heading" id="agent-setup">
        Set up with an AI agent
      </h2>
      <div className="card agent-setup" ref={card}>
        {older ? (
          <p className="help" tabIndex={-1} data-focus-here>
            Update Crosstalk on {machine} to see what's left to set up there.
          </p>
        ) : error ? (
          <p className="small as-error" role="alert" tabIndex={-1} data-focus-here>
            Couldn't check {machine}: {error}{" "}
            <button className="link-btn" onClick={() => void load("fresh")}>
              Try again
            </button>
          </p>
        ) : !list ? (
          <p className="help" tabIndex={-1} data-focus-here>
            Checking {machine}…
          </p>
        ) : allDone(list) && !expanded ? (
          <div className="as-all-done">
            <p className="as-summary" role="status" tabIndex={-1} data-focus-here>
              <CircleCheck size={18} aria-hidden className="as-ok" /> Everything needed is set up on {machine}.
            </p>
            <button className="link-btn" onClick={() => setExpanded(true)}>
              Show the list
            </button>
          </div>
        ) : (
          <Checklist list={list} machine={machine} checking={checking} onCheck={() => void load("recheck")} onAdd={addFor} starting={starting} installedThere={{ claude: claudeThere, codex: codexThere }} signIn={signIn} />
        )}
      </div>
      {adding && (
        <TerminalDialog
          title={`Adding setup tools to ${adding.name}`}
          pty={adding.pty}
          hint={outcome ? undefined : `${adding.name}'s own command runs on ${machine}. It takes a moment; what it prints shows below.`}
          notice={outcome && <AddResult outcome={outcome} agent={adding.agent} name={adding.name} machine={machine} command={list?.connect[adding.agent] ?? null} prompt={list ? agentPrompt(list) : null} />}
          onClose={() => {
            setAdding(null);
            setOutcome(null);
            void load("fresh");
          }}
        />
      )}
    </>
  );
}

/**
 * The keyboard stays in `box` when what it was on there goes away: "Check again" whose list comes back all done (the
 * list, and the button just pressed, give way to one line), "Show the list", "Try again". Left alone it falls to the
 * page, and a keyboard or screen-reader user is back at the top with no word of how it went; it goes to the line that
 * says how it went instead (`data-focus-here`). Only when the element it was on is gone and nothing has focus: a person
 * who went elsewhere since (another control, or a tap outside) is left where they went.
 */
export function useKeepFocus(box: { current: HTMLElement | null }) {
  const last = useRef<Element | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const focusIn = (e: FocusEvent) => {
      last.current = e.target instanceof Element ? e.target : null;
    };
    const focusOut = (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && !el.contains(e.relatedTarget)) last.current = null;
    };
    const pointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node && el.contains(e.target))) last.current = null;
    };
    el.addEventListener("focusin", focusIn);
    el.addEventListener("focusout", focusOut);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
      document.removeEventListener("pointerdown", pointer, true);
    };
  }, [box]);
  // Before the screen is drawn, so nothing (a reader, a test) ever finds the keyboard on the page in between.
  useLayoutEffect(() => {
    const gone = last.current;
    if (!gone || gone.isConnected) return;
    const now = document.activeElement;
    if (now && now !== document.body && now !== document.documentElement) return;
    last.current = null;
    box.current?.querySelector<HTMLElement>("[data-focus-here]")?.focus();
  });
}

/**
 * How "Add for me" ended, above the terminal in its dialog. Already there is no failure: it reads as done even though
 * Claude Code says it in red. Either way the next thing to do is right here, as the prompt to hand the agent; a
 * command that really failed gives the command to run by hand instead.
 *
 * "Already" is worded as what was actually learned — an entry of that name exists — because that is all the agent
 * said: Claude Code refuses on the name alone, so an entry from an older install (a different binary path, say)
 * refuses exactly like the right one. Nothing here can tell those apart, so the one thing that clears a stale entry
 * sits under the prompt (removeCommand, agentSetup.ts), for the person to use if the agent says it hasn't the tools.
 */
export function AddResult({ outcome, agent, name, machine, command, prompt }: { outcome: AddOutcome; agent: SetupAgent; name: string; machine: string; command: string | null; prompt: string | null }) {
  // It ended without saying it worked, and what it printed couldn't be read (the hub restarting, say): that is either
  // "already there" or a failure, and nothing here can tell which, so neither is claimed. The person can see for
  // themselves by running the command, which either adds the tools or says they're there.
  if (outcome === "unread")
    return (
      <div className="as-result" role="alert">
        <p className="small as-error">
          {name}'s command ended without saying it worked, and what it printed couldn't be read from {machine}. It may have found the setup tools already there, or not added them.
        </p>
        {command ? (
          <>
            <p className="help">To see which, run this yourself in a terminal on {machine}:</p>
            <Command text={command} label={`Copy the ${name} command`} />
          </>
        ) : (
          <p className="help">To see which, close this and copy the {name} command from the list to run on {machine} yourself.</p>
        )}
      </div>
    );
  if (outcome === "failed")
    return (
      <div className="as-result" role="alert">
        <p className="small as-error">{name} couldn't add the setup tools. What it printed is below.</p>
        {command ? (
          <>
            <p className="help">Run this yourself in a terminal on {machine}:</p>
            <Command text={command} label={`Copy the ${name} command`} />
          </>
        ) : (
          <p className="help">Close this and copy the {name} command from the list to run on {machine} yourself.</p>
        )}
      </div>
    );
  const already = outcome === "already";
  const remove = already ? removeCommand(agent, command) : null;
  return (
    <div className="as-result" role="status">
      <p className="small as-result-line">
        <CircleCheck size={16} aria-hidden className="as-ok" /> {already ? `${name} already has an entry called crosstalk-setup.` : `The setup tools are added to ${name}.`}
      </p>
      {/* An agent that had it already may say so as an error (Claude Code does, in red): that's it agreeing, not a fault. */}
      {prompt ? (
        <>
          <p className="help">
            {already ? "It printed that below, in its own words. " : "Nothing else to do here. "}Give {name} this prompt:
          </p>
          <Command text={prompt} label="Copy the prompt" prose />
        </>
      ) : (
        <p className="help">Close this and give {name} the prompt from the list.</p>
      )}
      {remove ? (
        <>
          <p className="help">If {name} answers that it hasn't got those tools, that entry is an older one: remove it, then use Add for me again.</p>
          <Command text={remove} label={`Copy the ${name} remove command`} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The list once loaded: the two steps for an agent, what's left, the optional and done items folded, Check again.
 * `starting`: the agent whose "Add for me" is on its way to the hub (no other add is taken meanwhile); `installedThere`:
 * that machine's own word on whether each agent's program is there (connectRows); `signIn`: that machine signs agents
 * in from the phone (an agent item waiting on a sign-in offers it).
 */
export function Checklist({ list, machine, checking, onCheck, onAdd, starting = null, installedThere = {}, signIn = false }: { list: SetupChecklist; machine: string; checking: boolean; onCheck: () => void; onAdd: (agent: "claude" | "codex", name: string) => void; starting?: SetupAgent | null; installedThere?: Partial<Record<"claude" | "codex", boolean>>; signIn?: boolean }) {
  const { left, optional, done } = parts(list);
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  const prompt = agentPrompt(list);
  return (
    <>
      <p className="as-summary" role="status" tabIndex={-1} data-focus-here>
        {summaryText(list)}
      </p>
      <p className="help as-intro">
        An AI agent on {machine}, like Claude Code or Codex, can do the rest with you. It asks you before anything that needs your password, and you type passwords yourself.{" "}
        <HelpTip label="What are setup tools?">
          Setup tools let an agent on {machine} see what's left to set up here and help do it, from a terminal or app there. They never give it your passwords, sign-ins or keys.
        </HelpTip>
      </p>
      <ol className="as-steps">
        <li>
          <div className="as-step-title">Add the setup tools to your agent on {machine}, once</div>
          {connectRows(list, installedThere).map((r) => (
            <div key={r.agent} className="as-connect">
              <div className="as-agent">{r.name}</div>
              <Command text={r.command} label={`Copy the ${r.name} command`}>
                {r.installed && (
                  // Off from the tap until the hub has started the command (a round trip over the tailnet): a button
                  // that looks untouched meanwhile invites the second tap that would start a second one. aria-disabled,
                  // not disabled: a browser drops the focus of a button it disables, so a keyboard or screen-reader user
                  // would lose their place, and the dialog that opens would hand the focus back to the top of the page
                  // when it closes. The tap that comes meanwhile is refused by onAdd (addFor) itself.
                  <button className="btn small" onClick={() => onAdd(r.agent, r.name)} aria-disabled={!!starting || undefined} aria-busy={starting === r.agent || undefined}>
                    {starting === r.agent && <Loader2 size={13} className="spin" aria-hidden />}
                    Add for me
                  </button>
                )}
              </Command>
            </div>
          ))}
        </li>
        <li>
          <div className="as-step-title">Then tell it</div>
          <Command text={prompt} label="Copy the prompt" prose />
        </li>
      </ol>
      {left.length > 0 && (
        <>
          <div className="as-group-title">What's left</div>
          <div className="as-list">
            {left.map((i) => (
              <ItemRow key={i.id} item={i} list={list} open={open === i.id} onToggle={() => toggle(i.id)} signIn={signIn} />
            ))}
          </div>
        </>
      )}
      <Fold title={`Optional (${optional.length})`} items={optional} list={list} open={open} onToggle={toggle} signIn={signIn} />
      <Fold title={`Done (${done.length})`} items={done} list={list} open={open} onToggle={toggle} />
      <div className="row wrap as-footer">
        <button className="btn small" onClick={onCheck} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </button>
        <span className="tiny muted">Checked {timeAgo(list.checkedAt)}</span>
      </div>
    </>
  );
}

/** A folded group (optional items, done items): closed until tapped. */
function Fold({ title, items, list, open, onToggle, signIn = false }: { title: string; items: SetupItem[]; list?: SetupChecklist; open: string | null; onToggle: (id: string) => void; signIn?: boolean }) {
  const [shown, setShown] = useState(false);
  const id = useId();
  if (!items.length) return null;
  return (
    <div className="as-fold">
      <button className="as-fold-btn" aria-expanded={shown} aria-controls={id} onClick={() => setShown((s) => !s)}>
        {shown ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />} {title}
      </button>
      {shown && (
        <div className="as-list" id={id}>
          {items.map((i) => (
            <ItemRow key={i.id} item={i} list={list} open={open === i.id} onToggle={() => onToggle(i.id)} signIn={signIn} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One item: its state and title, opening to what was found and how to fix it. An agent waiting on its sign-in (`signIn`:
 * the machine signs agents in from the phone) says "Sign in to Claude Code on Mac mini" under it, with Sign in: a new
 * machine's first sign-in works the same way as one that stopped working.
 */
export function ItemRow({ item, list, open, onToggle, signIn = false }: { item: SetupItem; list?: SetupChecklist; open: boolean; onToggle: () => void; signIn?: boolean }) {
  const id = useId();
  const fix = item.fix;
  const target = goThere(fix);
  const agent = signIn ? checklistAgent(item) : null;
  const machine = list?.hub.name || "this machine";
  return (
    <div className={`as-row${open ? " open" : ""}`}>
      <button className="as-row-btn" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className={`as-state ${item.optional && item.state !== "done" && item.state !== "unknown" ? "optional" : item.state}`}>{stateWord(item)}</span>
        <span className="as-title">{item.title}</span>
        <ChevronDown size={16} aria-hidden className="as-chev" />
      </button>
      {/* Once signed in the item is done and this goes: the keyboard lands on the line saying how the list stands. */}
      {agent && <SignInPrompt variant="row" who={{ provider: agent, account: "default" }} machine={machine} line={checklistPromptLine(machine, thisDevice())} focusAfter={() => document.querySelector<HTMLElement>(".agent-setup [data-focus-here]")} />}
      {open && (
        <div className="as-fix" id={id}>
          <p className="help">{item.detail}</p>
          {fix && <p className="small as-fix-text">{fix.text}</p>}
          {fix?.command && <Command text={fix.command} label={`Copy the command for ${item.title}`} />}
          {fix?.password && <p className="help">It asks for your password: you type it yourself, never an agent.</p>}
          {fix?.screen && <p className="help">In the app: {fix.screen}</p>}
          {item.id === "browseros" && list ? <BrowserOsCommands list={list} /> : null}
          {(target || fix?.url) && (
            <div className="row wrap as-actions">
              {target && (
                <button className="btn small" onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  Go there
                </button>
              )}
              {fix?.url && (
                <a className="btn small" href={fix.url} target="_blank" rel="noreferrer noopener">
                  {linkLabel(fix.url)}
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * BrowserOS neo's own line per agent on that machine: the exact command that points it at the address the browser
 * really answered on. Not connected first, because that's what's left to do; already connected stays visible so the
 * person can see it is, without tapping anything. Nothing is shown at all until the hub found an address.
 */
function BrowserOsCommands({ list }: { list: SetupChecklist }) {
  const rows = browserosRows(list);
  const note = browserosNote(list);
  if (!rows.length) return null;
  return (
    <>
      {rows.map((r) => (
        <div key={r.agent} className="as-connect">
          <div className="as-agent">
            {r.name}
            {r.connected ? " · connected" : ""}
          </div>
          <Command text={r.command} label={`Copy the ${r.name} command for BrowserOS neo`} />
        </div>
      ))}
      {note && <p className="help">{note}</p>}
    </>
  );
}

/** A command (or the prompt) shown whole, wrapping at any width, with Copy (and any other buttons beside it). */
function Command({ text, label, prose = false, children }: { text: string; label: string; prose?: boolean; children?: ReactNode }) {
  const toast = useStore((s) => s.toast);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (await copyText(text)) setCopied(true);
    else toast("error", "Couldn't copy here. Select the text and copy it yourself.");
  };
  return (
    <div className="as-command">
      <code className={prose ? "as-text prose" : "as-text"}>{text}</code>
      <div className="row wrap as-buttons">
        {/* The name is what a screen reader says, and it wins over the text: "Copied" has to be in it too, or only
            sighted people are told the copy worked (a failure speaks, as a toast). */}
        <button className="btn small" aria-label={copied ? `${label}: copied` : label} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
        {children}
      </div>
    </div>
  );
}
