// Signing an agent in again from the phone (signIn.ts has the words and the states; hub/src/signin.ts the hub's side).
// - SignInPrompt: "Sign in to Claude Code on Mac mini" with one button, in a chat whose agent is signed out, on the
//   agent's card in Settings → Agents, and on the setup checklist's agent item.
// - SignInSheet: the sign-in itself. The hub runs the agent's own sign-in on its machine; the sheet shows its link as a
//   big button that opens in this phone's browser, a code to type there in large copyable text, or a box for the code
//   the page gives back (Claude Code, Gemini CLI). What's pasted goes to the hub once and is never kept here: not in
//   storage, not after it's sent, not after the sheet closes.
// - ReplyNote: the hub's note in a reply whose agent it started again because its sign-in had gone stale (nothing to do).
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Check, CheckCircle2, CircleAlert, ClipboardPaste, Copy, ExternalLink, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { CHAT_PROVIDERS, signInAgentWords, type Activity, type SignInSession } from "@crosstalk/shared";
import type { StoreApi } from "zustand/vanilla";
import { api, ApiError, type Connection } from "../api";
import type { HubState } from "../hubStore";
import { showInSettings } from "../navigation";
import { PASTE_BY_HAND, SHEET_ACTIONS, codeProblemWords, liveSession, newerSession, sessionEnded, sheetView, signInTitle, type SheetAction, type SheetProblem, type SheetView, type SignInWho } from "../signIn";
import { openSignIn, type SignInTarget } from "../signInSheet";
import { hubStore, useStore } from "../store";
import { Dialog, ProviderAvatar, copyText } from "../ui";

/**
 * "Sign in to Claude Code on Mac mini", a line saying why, and one button that opens the sign-in sheet. `variant`: a
 * failed reply's own (in place of its error), a card under a chat's replies, a callout on the agent's card in Settings,
 * a line under a setup checklist item. `announce`: it's news (a reply failed while the chat was open), so a screen
 * reader is told at once, as a reply's error would be.
 */
export function SignInPrompt({ who, machine, line, variant, stopped = false, announce = false, focusAfter }: { who: SignInWho; machine: string; line: string; variant: "reply" | "card" | "callout" | "row"; stopped?: boolean; announce?: boolean; focusAfter?: () => HTMLElement | null }) {
  const titleId = useId();
  const title = signInTitle(who, machine);
  const open = (e: React.MouseEvent<HTMLButtonElement>) =>
    openSignIn({ provider: who.provider, account: who.account, accountLabel: who.accountLabel ?? null, machineKey: useStore.getState().active, machine, stopped, opener: e.currentTarget, focusAfter });
  return (
    <div className={`signin-prompt ${variant}`} role="group" aria-labelledby={titleId}>
      <KeyRound size={18} aria-hidden="true" className="signin-prompt-icon" />
      <div className="signin-prompt-text" role={announce ? "alert" : undefined}>
        <div className="signin-prompt-title" id={titleId}>
          {title}
        </div>
        {line && <p className="signin-prompt-line">{line}</p>}
      </div>
      {/* Named in full (it starts with what it shows): two of these can be on one screen, each for its own agent. */}
      <button type="button" className="btn primary signin-prompt-btn" aria-label={title} onClick={open}>
        Sign in
      </button>
    </div>
  );
}

/** Where the keyboard goes once a chat's agent is signed in again (its card has gone): the newest Try again, else the message box. */
export function chatRetryOrBox(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(".messages .try-again")].at(-1) ?? document.querySelector<HTMLElement>(".composer textarea");
}

/** What the hub answered, or why it couldn't be asked, for the sheet's words (signIn.ts sheetView). */
function problemOf(e: unknown): SheetProblem {
  if (e instanceof ApiError) return { status: e.status, code: e.code, message: e.message };
  return { status: 0, message: e instanceof Error ? e.message : String(e) };
}

/** Hears every change of a machine's store (none when it has gone). */
function useSubscribe(store: StoreApi<HubState> | undefined) {
  return useCallback((changed: () => void) => store?.subscribe(changed) ?? (() => {}), [store]);
}

/** A machine's sign-in session as its live updates have it (null until known there). */
function useSession(store: StoreApi<HubState> | undefined, id: string | null): SignInSession | null {
  return useSyncExternalStore(
    useSubscribe(store),
    () => (store && id ? store.getState().signInSessions[id] ?? null : null),
    () => null,
  );
}

/** Whether a machine's live updates are coming in (they carry each change of a sign-in). */
function useConnected(store: StoreApi<HubState> | undefined): boolean {
  return useSyncExternalStore(
    useSubscribe(store),
    () => store?.getState().status === "open",
    () => false,
  );
}

/**
 * The sign-in sheet for `target` (an agent's account on a machine). It carries on with a sign-in for that account that's
 * still going, else starts one. Closing it (the X, a tap outside, Escape) only puts it away: the sign-in goes on, and
 * opening the sheet again comes back to it. Cancel stops it. `onTerminal`: hand over to the agent's own sign-in in a
 * terminal, for an agent that can't sign in from here.
 */
export function SignInSheet({ target, onClose, onTerminal }: { target: SignInTarget; onClose: () => void; onTerminal: () => void }) {
  const store = hubStore(target.machineKey);
  const conn: Connection | null = store?.getState().conn ?? null;
  const agent = signInAgentWords(target);
  const title = signInTitle(target, target.machine);
  const [id, setId] = useState<string | null>(() => (store ? liveSession(store.getState().signInSessions, target)?.id ?? null : null));
  const session = useSession(store, id);
  const connected = useConnected(store);
  const [problem, setProblem] = useState<SheetProblem | null>(null);
  const starting = useRef(false);
  /** Cancel was tapped: a sign-in still starting is stopped as soon as the hub has it. */
  const dropped = useRef(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [codeProblem, setCodeProblem] = useState<string | null>(null);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const refs = { words: useRef<HTMLParagraphElement>(null), link: useRef<HTMLAnchorElement>(null), field: useRef<HTMLInputElement>(null), main: useRef<HTMLButtonElement>(null) };

  /** An answer from the hub, kept unless its live updates already said something newer (signIn.ts newerSession). */
  const put = (s: SignInSession, how: "start" | "code" | "poll") => {
    if (!s || typeof s.id !== "string") return;
    store?.setState((st) => (newerSession(st.signInSessions[s.id], s, how) ? { signInSessions: { ...st.signInSessions, [s.id]: s } } : st));
  };

  const start = async () => {
    if (starting.current) return;
    // Its machine was taken off this device meanwhile: nothing goes anywhere else in its place.
    if (!store || !conn) return setProblem({ status: 0, code: "account", message: `${target.machine} isn't one of this device's machines any more.` });
    starting.current = true;
    setProblem(null);
    setCodeProblem(null);
    setPasteHint(null);
    setCode("");
    setId(null);
    try {
      // Codex answers once its app-server has the device code: that can take a moment.
      const s = await api<SignInSession>("POST", "/api/signin", { provider: target.provider, account: target.account }, conn, 45_000);
      put(s, "start");
      if (dropped.current) {
        void api<SignInSession>("DELETE", `/api/signin/${s.id}`, undefined, conn).then((x) => put(x, "poll"), () => {});
        return;
      }
      setId(s.id);
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      starting.current = false;
    }
  };
  // Once, as it opens (a sheet opened again carries on with the sign-in that's going).
  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    if (!id) void start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A sign-in this machine no longer has (the hub restarted, or it ended long ago): said, with Start again.
  useEffect(() => {
    if (!id || session || starting.current || !conn) return;
    let current = true;
    api<SignInSession>("GET", `/api/signin/${id}`, undefined, conn)
      .then((s) => current && put(s, "poll"))
      .catch((e) => current && setProblem(problemOf(e)));
    return () => {
      current = false;
    };
  }, [id, !!session]); // eslint-disable-line react-hooks/exhaustive-deps

  // While the machine's live updates can't come, it's asked now and then instead.
  const active = !!session && !sessionEnded(session);
  useEffect(() => {
    if (!id || !active || connected || !conn) return;
    const timer = setInterval(() => {
      api<SignInSession>("GET", `/api/signin/${id}`, undefined, conn)
        .then((s) => put(s, "poll"))
        .catch((e) => {
          if (e instanceof ApiError && e.code === "gone") setProblem(problemOf(e));
        });
    }, 4000);
    return () => clearInterval(timer);
  }, [id, active, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The code goes to the hub (and through it only to the agent's sign-in), and out of the box as it goes. */
  const send = async () => {
    const value = code.trim();
    if (!value || !session || sending || !conn) return;
    setSending(true);
    setCodeProblem(null);
    setPasteHint(null);
    setCode("");
    try {
      put(await api<SignInSession>("POST", `/api/signin/${session.id}/code`, { code: value }, conn, 30_000), "code");
    } catch (e) {
      setCodeProblem(codeProblemWords(problemOf(e)));
      refs.field.current?.focus();
    } finally {
      setSending(false);
    }
  };
  const canPaste = typeof navigator !== "undefined" && !!navigator.clipboard?.readText;
  const paste = async () => {
    setPasteHint(null);
    setCodeProblem(null);
    try {
      // As the box itself takes a paste: one line (a text box drops line breaks).
      const text = (await navigator.clipboard.readText()).replace(/[\r\n]+/g, "").trim();
      if (text) setCode(text);
      else setPasteHint("Nothing is copied yet. Copy the code on the sign-in page first.");
    } catch {
      setPasteHint(PASTE_BY_HAND);
    }
    refs.field.current?.focus();
  };
  const cancel = () => {
    dropped.current = true;
    if (session && !sessionEnded(session) && conn) {
      void api<SignInSession>("DELETE", `/api/signin/${session.id}`, undefined, conn)
        .then((s) => put(s, "poll"))
        .catch(() => {});
    }
    onClose();
  };
  const toSettings = () => {
    // The agent's card on its own machine's Settings.
    const app = useStore.getState();
    if (app.active !== target.machineKey) app.activate(target.machineKey);
    showInSettings((CHAT_PROVIDERS as readonly string[]).includes(target.provider) ? `agent-${target.provider}` : "ai-services");
    app.setView("settings");
    onClose();
  };

  const view = sheetView({ session, problem, agent, machine: target.machine, stopped: target.stopped });
  // The keyboard moves on with the sheet: to the sign-in link once it's ready, to the box when a code was turned down
  // (to the link again when the agent made a new one: the old page's code can't work), to the main button once it's
  // over. Only from inside the sheet: never away from somewhere the person went.
  const focusKey = `${view.step}|${view.paste?.refused ? `${session?.codesSent ?? 0}|${view.url}` : ""}`;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const dialog = refs.words.current?.closest<HTMLElement>('[role="dialog"]');
      const now = document.activeElement;
      if (!dialog || (now && now !== document.body && !dialog.contains(now))) return;
      if (view.phase === "starting") return;
      const to = view.phase === "open" ? (view.paste?.refused && !view.paste.newLink ? refs.field.current : refs.link.current) : view.phase === "checking" ? dialog : refs.main.current;
      to?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (a: SheetAction) => {
    if (a === "cancel") return cancel();
    if (a === "again" || a === "retry") return void start();
    if (a === "terminal") return onTerminal();
    if (a === "settings") return toSettings();
    onClose();
  };
  return (
    <Dialog
      title={title}
      icon={<ProviderAvatar provider={target.provider} />}
      step={view.step}
      onClose={onClose}
      footer={
        <div className="row signin-foot">
          {view.actions.map((a, i) => {
            const main = i === view.actions.length - 1;
            return (
              <button key={a} ref={main ? refs.main : undefined} type="button" className={`btn${main && a !== "cancel" && a !== "close" ? " primary" : ""}`} onClick={() => act(a)}>
                {SHEET_ACTIONS[a]}
              </button>
            );
          })}
        </div>
      }
    >
      <SignInSteps
        view={view}
        code={code}
        onCode={(v) => {
          setCode(v);
          setCodeProblem(null);
          setPasteHint(null);
        }}
        onSend={() => void send()}
        sending={sending}
        canPaste={canPaste}
        onPaste={() => void paste()}
        note={codeProblem ?? pasteHint}
        // Back from the sign-in page with its code: the box is where the keyboard is.
        onOpenLink={() => view.paste && setTimeout(() => refs.field.current?.focus(), 0)}
        refs={refs}
      />
    </Dialog>
  );
}

/**
 * The sheet's words and steps (pure: signInViews.test.tsx draws each). The words at the top are one live region for the
 * sheet's whole life, so each step is read out as it comes (at once, when something went wrong).
 */
export function SignInSteps({
  view,
  code,
  onCode,
  onSend,
  sending,
  canPaste,
  onPaste,
  note,
  onOpenLink,
  refs,
}: {
  view: SheetView;
  code: string;
  onCode: (code: string) => void;
  onSend: () => void;
  sending: boolean;
  canPaste: boolean;
  onPaste: () => void;
  /** Why the last code didn't go, or why Paste couldn't read what was copied. */
  note: string | null;
  onOpenLink: () => void;
  refs?: { words?: RefObject<HTMLParagraphElement | null>; link?: RefObject<HTMLAnchorElement | null>; field?: RefObject<HTMLInputElement | null> };
}) {
  const wordsId = useId();
  const noteId = useId();
  const icon: ReactNode = view.busy ? (
    <Loader2 size={16} className="spin" aria-hidden="true" />
  ) : view.phase === "done" ? (
    <CheckCircle2 size={18} aria-hidden="true" />
  ) : view.tone === "alert" ? (
    <CircleAlert size={16} aria-hidden="true" />
  ) : null;
  const ready = !!view.paste?.ready;
  return (
    <div className="signin-sheet">
      <p ref={refs?.words} id={wordsId} className={`signin-words ${view.phase} ${view.tone}`} role="status" aria-live={view.tone === "alert" ? "assertive" : "polite"} aria-atomic="true">
        {icon}
        <span>{view.words}</span>
      </p>
      {view.next && <p className="signin-next">{view.next}</p>}
      {view.url && (
        <ol className="steps signin-steps">
          <li>
            <a ref={refs?.link} className="btn primary large block signin-open" href={view.url} target="_blank" rel="noopener noreferrer" onClick={onOpenLink}>
              <ExternalLink size={17} aria-hidden="true" /> Open the sign-in page
            </a>
            <div className="signin-under">
              <CopyButton text={view.url} label="Copy link" />
              <span className="help">{view.code ? "It opens in your browser. Any device works." : "It opens in your browser. Come back here with its code."}</span>
            </div>
          </li>
          {view.code && (
            <li>
              <div className="signin-step-title">{view.code.confirm ? "Check the page shows this code:" : "Enter this code there:"}</div>
              <div className="signin-code">
                <span className="code-big">{view.code.value}</span>
                <CopyButton text={view.code.value} label="Copy code" />
              </div>
            </li>
          )}
          {view.paste && (
            <li>
              <form
                className="signin-paste"
                onSubmit={(e) => {
                  e.preventDefault();
                  onSend();
                }}
              >
                <label className="field">
                  <span>Code from the sign-in page</span>
                  {/* Never saved: no name, nothing for the browser to remember, gone once it's sent or the sheet closes. */}
                  <input
                    ref={refs?.field}
                    className="input mono signin-code-input"
                    type="text"
                    value={code}
                    onChange={(e) => onCode(e.target.value)}
                    autoComplete="one-time-code"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    inputMode="text"
                    enterKeyHint="go"
                    disabled={!ready}
                    aria-invalid={view.paste.refused || !!note || undefined}
                    aria-describedby={[view.paste.refused ? wordsId : "", note ? noteId : ""].filter(Boolean).join(" ") || undefined}
                    placeholder={ready ? "Paste it here" : ""}
                  />
                </label>
                {note && (
                  <p className="signin-note" id={noteId} role="alert">
                    {note}
                  </p>
                )}
                <div className="row signin-paste-buttons">
                  {canPaste && (
                    <button type="button" className="btn" onClick={onPaste} disabled={!ready}>
                      <ClipboardPaste size={15} aria-hidden="true" /> Paste
                    </button>
                  )}
                  <button type="submit" className="btn primary" disabled={!ready || !code.trim() || sending}>
                    {sending ? "Signing in…" : "Sign in"}
                  </button>
                </div>
              </form>
            </li>
          )}
        </ol>
      )}
      {view.waiting && (
        <p className="signin-waiting">
          <Loader2 size={14} className="spin" aria-hidden="true" /> {view.waiting}
        </p>
      )}
    </div>
  );
}

/** Copy, saying "Copied" for a moment (to a screen reader too), or that it couldn't. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className="btn small" aria-label={copied === "yes" ? `${label}: copied` : label} onClick={async () => setCopied((await copyText(text)) ? "yes" : "no")}>
      {copied === "yes" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied === "yes" ? "Copied" : copied === "no" ? "Couldn't copy: select it instead" : label}
    </button>
  );
}

/**
 * The hub's note in a reply whose agent it started again because its sign-in had gone stale (signIn.ts
 * isStaleSignInNote): "…: Crosstalk started it again and it carried on." Shown with the reply, not folded away with its
 * steps. `detail`: background work that ended with the old process.
 */
export function ReplyNote({ activity: a, live }: { activity: Activity; live: boolean }) {
  const running = a.status === "running" && live;
  return (
    <div className={`reply-note${a.status === "error" ? " failed" : ""}`} role="note">
      {running ? <Loader2 size={13} className="spin" aria-hidden="true" /> : a.status === "error" ? <CircleAlert size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
      <span className="reply-note-text">
        {a.title}
        {a.detail ? <span className="reply-note-detail"> {a.detail}</span> : null}
      </span>
    </div>
  );
}
