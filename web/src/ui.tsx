import { AgentMark } from "./agentMarks";
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronUp, Copy, Globe, Network, Server, X } from "lucide-react";
import { PROVIDER_INFO, limitWaitWords, type Member, type Provider } from "@crosstalk/shared";
import { SERVICE_COLOR, type ChatIdentity, type ServiceWhere } from "./chatIdentity";
import { Attachment, FolderAttachment, ProjectFileLink, ProjectImage, isAttachmentUrl, isFolderUrl, isImageName } from "./views/Attachment";
import { projectPath, urlTransform } from "./links";
import { codeBlockView } from "./codeblock";
import { layoutZoom, onZoom } from "./zoom";
import { currentPosture, onPosture } from "./viewport";
import { EntranceScope, fadeIn, leave } from "./motion";

/** The room whose messages are being shown, so file links in them can download from its project folder. */
export const RoomFilesContext = createContext<string | null>(null);

export function Logo({ className = "logo" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="ctg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b8cff" />
          <stop offset="1" stopColor="#8e5cf7" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#ctg)" />
      <path d="M14 22a8 8 0 0 1 8-8h14a8 8 0 0 1 8 8v6a8 8 0 0 1-8 8h-9l-7 6v-6.6A8 8 0 0 1 14 28z" fill="#fff" opacity=".95" />
      <path d="M50 34a6 6 0 0 0-6-6h-1v1a10 10 0 0 1-10 10h-4v1a6 6 0 0 0 6 6h7l6 5v-5.3a6 6 0 0 0 2-4.5z" fill="#fff" opacity=".6" />
    </svg>
  );
}

export function ProviderAvatar({ provider, size, state, label }: { provider: Provider; size?: "sm" | "lg"; state?: string; label?: string }) {
  const info = PROVIDER_INFO[provider];
  return (
    <div className={`avatar ${size ?? ""}`} style={{ ["--c" as string]: info.color }} title={label ?? info.name} aria-label={label ?? info.name}>
      <AgentMark provider={provider} size={size === "lg" ? 25 : size === "sm" ? 13 : 18} />
      {state && <span className={`state ${state}`} />}
    </div>
  );
}

/**
 * An AI service's avatar: a server for a model running on the hub's machine, a globe for an online one, linked machines
 * for the model pool, each in its own colour (chatIdentity.ts), so a chat on one is never read as Claude Code's or
 * Codex's. Icons, not initials: a service is named by the person ("Qwen on this Mac"), and two letters of that would
 * say nothing.
 */
export function ServiceAvatar({ where, size, state, label }: { where: ServiceWhere; size?: "sm" | "lg"; state?: string; label: string }) {
  const px = size === "lg" ? 21 : size === "sm" ? 12 : 16;
  const Icon = where === "local" ? Server : where === "pool" ? Network : Globe;
  return (
    <div className={`avatar svc-avatar ${size ?? ""}`} style={{ ["--c" as string]: SERVICE_COLOR[where] }} title={label} aria-label={label}>
      <Icon size={px} aria-hidden="true" />
      {state && <span className={`state ${state}`} />}
    </div>
  );
}

/** A one-agent chat's avatar: its service's, or its agent's (chatIdentity.ts). */
export function ChatAvatar({ identity, size, state }: { identity: ChatIdentity; size?: "sm" | "lg"; state?: string }) {
  return identity.where ? (
    <ServiceAvatar where={identity.where} size={size} state={state} label={identity.name} />
  ) : (
    <ProviderAvatar provider={identity.provider} size={size} state={state} label={identity.name} />
  );
}

export function MemberAvatar({ member, size, showState }: { member: Member; size?: "sm" | "lg"; showState?: boolean }) {
  return <ProviderAvatar provider={member.provider} size={size} state={showState ? member.status : undefined} label={`@${member.handle}`} />;
}

export function statusLabel(m: Member): string {
  switch (m.status) {
    case "idle":
      return "Ready";
    case "queued":
      return "Waiting for its turn";
    case "thinking":
      return m.statusDetail ?? "Thinking…";
    case "working":
      return m.statusDetail ?? "Working…";
    case "approval":
      return `Needs approval: ${m.statusDetail ?? ""}`;
    case "error":
      return m.statusDetail ? `Error: ${m.statusDetail}` : "Error";
    case "waiting":
      // The whole sentence ("Claude Code is out of messages until 3:20 PM. It'll carry on then."), in this device's
      // clock where the wait itself came through.
      return m.wait ? limitWaitWords(m.wait) : m.statusDetail ?? "Waiting for its usage limit to reset";
    case "offline":
      return "Offline";
  }
}

/** Closes the dialog, asking first if there are unsaved changes. `then` runs after it closes (e.g. to navigate elsewhere). */
export type RequestClose = (then?: () => void) => void;

/**
 * A sheet. It rises into place and is live from its first frame; when it closes it's gone at once (its focus back where
 * it was, its role off the page) and a copy slides away (motion.ts). `step` changes when it moves to its next step (a
 * two-step question's "Are you sure?"): the new words fade in where the last ones were, as they do for "Discard
 * changes?".
 */
export function Dialog({ title, onClose, children, footer, wide, icon, dirty = false, step }: { title: string; onClose: () => void; children: ReactNode | ((requestClose: RequestClose) => ReactNode); footer?: ReactNode | ((requestClose: RequestClose) => ReactNode); wide?: boolean; icon?: ReactNode; dirty?: boolean; step?: string | number }) {
  const [discarding, setDiscarding] = useState(false);
  const after = useRef<(() => void) | undefined>(undefined);
  const close = () => {
    onClose();
    after.current?.();
  };
  const dialog = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const requestClose: RequestClose = (then) => {
    // Repeated backdrop taps must preserve the destination already awaiting confirmation.
    if (discarding) return;
    // Also used directly as an onClick handler, so ignore a click event passed in place of `then`.
    after.current = typeof then === "function" ? then : undefined;
    if (dirty) setDiscarding(true);
    else close();
  };
  // What had the focus as the dialog opened, read as it first renders: a part of it that takes the focus as it mounts (a
  // terminal does) runs its effects before the one below, which then finds the focus inside the dialog already.
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      // It was inside the dialog, and went with it: back to what opened it, unless something has taken the focus since.
      else if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (discarding) keepEditing.current?.focus();
    else dialog.current?.focus();
  }, [discarding]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialog.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (discarding) setDiscarding(false);
        else requestClose();
      }
      if (e.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
          e.preventDefault(); first.focus();
        }
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, dirty, discarding]);
  // Closing: this one goes in this commit; its copy slides away.
  useLayoutEffect(() => () => leave(overlay.current, "sheet", { part: ".dialog" }), []);
  // The next step's words (and title) fade in where the last ones were.
  const shown = useRef({ step, discarding });
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = { step, discarding };
    if (was.step === step && was.discarding === discarding) return;
    fadeIn(dialog.current?.querySelectorAll(was.step === step ? ".dialog-body, .dialog-foot" : ".dialog-head h3, .dialog-body, .dialog-foot") ?? []);
  }, [step, discarding]);
  // Portal to the app root: ancestors with backdrop-filter would otherwise trap `position: fixed`.
  return createPortal(
    <EntranceScope>
      <div ref={overlay} className="overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
        <div ref={dialog} tabIndex={-1} className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
          <div className="dialog-head">
            {icon}
            <h3>{title}</h3>
            <button className="icon-btn" onClick={() => discarding ? setDiscarding(false) : requestClose()} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className="dialog-body">
            {discarding && (
              <div className="discard-confirm" role="alert">
                <h3>Discard changes?</h3>
                <p>Your changes haven't been saved.</p>
                <div className="row wrap">
                  <button ref={keepEditing} className="btn primary" onClick={() => setDiscarding(false)}>Keep editing</button>
                  <button className="btn danger" onClick={close}>Discard changes</button>
                </div>
              </div>
            )}
            <div hidden={discarding}>{typeof children === "function" ? children(requestClose) : children}</div>
          </div>
          {footer && !discarding && <div className="dialog-foot">{typeof footer === "function" ? footer(requestClose) : footer}</div>}
        </div>
      </div>
    </EntranceScope>,
    document.querySelector(".app") ?? document.body,
  );
}

export function Switch({ checked, onChange, label, disabled, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; describedBy?: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label?: string; disabled?: boolean }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)} type="button" disabled={disabled}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A destructive action in two steps: the first tap asks right there, the second does it. The question goes away by
 * itself after a while, and a quick double tap doesn't count as the second step.
 */
export function ConfirmButton({ label, question, confirmLabel, onConfirm, disabled, ariaLabel, className = "btn small ghost danger" }: { label: ReactNode; question: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; ariaLabel?: string; className?: string }) {
  const [asking, setAsking] = useState(false);
  const armedAt = useRef(0);
  const yes = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Back on the button after Cancel (or when the question goes away while it has focus), not lost on the page.
  const refocus = useRef(false);
  const stopAsking = () => {
    refocus.current = !!group.current?.contains(document.activeElement);
    setAsking(false);
  };
  useEffect(() => {
    if (!asking) {
      if (refocus.current) button.current?.focus();
      refocus.current = false;
      return;
    }
    yes.current?.focus();
    const t = setTimeout(stopAsking, 10_000);
    return () => clearTimeout(t);
  }, [asking]);
  if (!asking || disabled) {
    return (
      <button ref={button} type="button" className={className} disabled={disabled} aria-label={ariaLabel} onClick={() => { armedAt.current = Date.now(); setAsking(true); }}>
        {label}
      </button>
    );
  }
  return (
    <span ref={group} className="confirm-inline" role="group" aria-label={question}>
      <span className="confirm-q">{question}</span>
      <button ref={yes} type="button" className="btn small danger" onClick={() => { if (Date.now() - armedAt.current < 400) return; setAsking(false); onConfirm(); }}>
        {confirmLabel}
      </button>
      <button type="button" className="btn small ghost" onClick={stopAsking}>
        Cancel
      </button>
    </span>
  );
}

/**
 * What can't be undone, asked twice: what it does (`children`), then whether you're sure (`sure`). Cancel at either step
 * changes nothing; if it fails, the dialog says why and stays open to try again.
 */
export function AskTwiceDialog({ title, icon, children, sure, confirmLabel, workingLabel, onConfirm, onClose }: { title: string; icon?: ReactNode; children: ReactNode; sure: ReactNode; confirmLabel: string; workingLabel: string; onConfirm: () => Promise<unknown> | unknown; onClose: () => void }) {
  const [isSure, setSure] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setWorking(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} Try again, or tap Cancel.`);
      setWorking(false);
    }
  };
  return (
    <Dialog
      title={isSure ? "Are you sure?" : title}
      step={isSure ? 2 : 1}
      icon={icon}
      onClose={() => !working && onClose()}
      footer={
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", width: "100%" }}>
          <button className="btn small" disabled={working} onClick={onClose}>
            Cancel
          </button>
          {isSure ? (
            <button className="btn small danger" disabled={working} onClick={go}>
              {working ? workingLabel : confirmLabel}
            </button>
          ) : (
            <button className="btn small primary" onClick={() => setSure(true)}>
              Continue
            </button>
          )}
        </div>
      }
    >
      {isSure ? <p className="small" style={{ margin: 0 }}>{sure}</p> : children}
      {error && (
        <p role="alert" className="small" style={{ color: "var(--red)", marginBottom: 0 }}>
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** "this iPhone", "this phone"…: the device this app runs on, as a sentence says it. */
export function thisDevice(): string {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? "this iPhone" : /iPad/.test(ua) ? "this iPad" : /Android/.test(ua) ? "this phone" : "this device";
}

export function timeShort(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function timeUntil(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** A file or disk size: "12.3 GB", "640 MB", "12 KB". */
export function formatBytes(n: number): string {
  const GB = 1024 ** 3;
  if (n >= GB) return `${(n / GB).toFixed(n >= 100 * GB ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

// Renderer identities must stay stable: chat updates must not remount an open
// folder card and discard its file list or in-flight download.
const MentionHandlesContext = createContext<string[]>([]);
const markdownComponents: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  p: MarkdownParagraph,
  li: MarkdownListItem,
  pre: MarkdownCodeBlock,
};

/**
 * A code block with its language, its length and a Copy button, which copies exactly the code (no prompt or label).
 * Short ones show whole; a long one shows its first lines until "Show all" (codeblock.ts). Copy copies all of it.
 */
function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const block = useRef<HTMLDivElement>(null);
  // What a tap chose (Show all or Collapse), if anything: it holds while a streaming reply adds lines.
  const [tapped, setTapped] = useState<boolean | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const child = Array.isArray(children) ? children[0] : children;
  const cls = (child as { props?: { className?: string } } | undefined)?.props?.className ?? "";
  const lang = /language-([\w+#.-]+)/.exec(cls)?.[1] ?? "";
  const code = String((child as { props?: { children?: unknown } } | undefined)?.props?.children ?? "").replace(/\n$/, "");
  const lines = code ? code.split("\n").length : 0;
  const view = codeBlockView(lines, tapped);
  const collapse = () => {
    setTapped(false);
    // Its top stays in view: the lines it hides were above the button.
    requestAnimationFrame(() => block.current?.scrollIntoView({ block: "nearest" }));
  };
  const copy = async () => {
    const text = (pre.current?.innerText ?? "").replace(/\n$/, "");
    const ok = await copyText(text);
    setCopied(ok ? "yes" : "no");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1800);
  };
  return (
    <div ref={block} className={`codeblock ${view.whole ? "" : "preview"}`}>
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang || "code"}</span>
        <span className="codeblock-lines">{lines === 1 ? "1 line" : `${lines} lines`}</span>
        <button type="button" className="codeblock-copy" onClick={copy} aria-label={copied === "yes" ? "Copied" : "Copy code"} title="Copy code">
          {copied === "yes" ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied === "yes" ? "Copied" : copied === "no" ? "Couldn't copy" : "Copy"}</span>
        </button>
      </div>
      <pre ref={pre}>{children}</pre>
      {view.showAll && (
        <button type="button" className="codeblock-more" onClick={() => setTapped(true)} aria-expanded={false}>
          <ChevronDown size={14} aria-hidden="true" /> Show all {lines} lines
        </button>
      )}
      {view.collapse && (
        <button type="button" className="codeblock-more" onClick={collapse} aria-expanded={true}>
          <ChevronUp size={14} aria-hidden="true" /> Collapse
        </button>
      )}
    </div>
  );
}
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const roomId = useContext(RoomFilesContext);
  if (isFolderUrl(href)) return <FolderAttachment url={href!}>{children}</FolderAttachment>;
  if (isAttachmentUrl(href)) return <Attachment url={href!}>{children}</Attachment>;
  const path = roomId ? projectPath(href) : null;
  if (roomId && path) return isImageName(path) ? <ProjectImage roomId={roomId} path={path}>{children}</ProjectImage> : <ProjectFileLink roomId={roomId} path={path}>{children}</ProjectFileLink>;
  if (href && /^file:/i.test(href)) return <span>{children}</span>;
  // A link to a screen of this app (another chat, say) opens here, not in a new tab.
  if (href && /^#\//.test(href)) return <a href={href}>{children}</a>;
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}
/**
 * ![alt](src) in a message. A plain <img> can't send the device's token, so chat uploads and project files are
 * fetched like attachments and shown large. Images from the web stay links: opening a chat never loads other sites.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const roomId = useContext(RoomFilesContext);
  let name = (src ?? "").split(/[?#]/)[0].split("/").pop() ?? "";
  try { name = decodeURIComponent(name); } catch { /* keep as written */ }
  const label = alt?.trim() || name.replace(/^[a-f0-9-]{36}_/i, "") || "image";
  if (isAttachmentUrl(src)) return <Attachment url={src!} large>{label}</Attachment>;
  const path = roomId ? projectPath(src) : null;
  if (roomId && path) return <ProjectImage roomId={roomId} path={path} large>{label}</ProjectImage>;
  if (src && /^https?:/i.test(src)) return <a href={src} target="_blank" rel="noreferrer noopener">{label}</a>;
  return <span>{label}</span>;
}
function MarkdownParagraph({ children }: { children?: ReactNode }) {
  return <p>{highlight(children, useContext(MentionHandlesContext))}</p>;
}
function MarkdownListItem({ children }: { children?: ReactNode }) {
  return <li>{highlight(children, useContext(MentionHandlesContext))}</li>;
}

const remarkPlugins = [remarkGfm];
const markdownUrl = (url: string) => urlTransform(url, defaultUrlTransform);
/** How often a streaming reply's formatting is redrawn: each redraw formats the whole reply again. */
const STREAMING_REDRAW_MS = 250;

/**
 * Markdown with @mentions highlighted. Links open in a new tab; raw HTML is not rendered. While a reply is `streaming`
 * it catches up a few times a second instead of on every word, and the finished text shows at once.
 */
export const Markdown = memo(function Markdown({ text, handles, streaming = false }: { text: string; handles: string[]; streaming?: boolean }) {
  const shown = useThrottled(text, streaming, STREAMING_REDRAW_MS);
  const lower = useMemo(() => handles.map((h) => h.toLowerCase()), [handles]);
  // The same element while the text shown is the same, so React doesn't format it again.
  return useMemo(
    () => (
      <MentionHandlesContext.Provider value={lower}>
        <div className="md">
          <ReactMarkdown remarkPlugins={remarkPlugins} urlTransform={markdownUrl} components={markdownComponents}>
            {shown}
          </ReactMarkdown>
        </div>
      </MentionHandlesContext.Provider>
    ),
    [shown, lower],
  );
});

function highlight(children: ReactNode, handles: string[]): ReactNode {
  const walk = (node: ReactNode): ReactNode => {
    if (typeof node === "string") {
      const parts = node.split(/(@[a-zA-Z][\w-]{0,31})/g);
      if (parts.length === 1) return node;
      return parts.map((p, i) =>
        p.startsWith("@") && (handles.includes(p.slice(1).toLowerCase()) || ["@all", "@everyone"].includes(p.toLowerCase())) ? (
          <span key={i} className="mention">
            {p}
          </span>
        ) : (
          p
        ),
      );
    }
    if (Array.isArray(node)) return node.map((n, i) => <span key={i}>{walk(n)}</span>);
    return node;
  };
  return walk(children);
}

/** The media queries asked about (one list each, shared by every screen asking) and how to hear of their changes. */
const mediaQueries = new Map<string, { list: MediaQueryList; subscribe: (changed: () => void) => () => void }>();

function mediaQuery(q: string) {
  let m = mediaQueries.get(q);
  if (!m) {
    const list = window.matchMedia(q);
    const subscribe = (changed: () => void) => {
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    };
    m = { list, subscribe };
    mediaQueries.set(q, m);
  }
  return m;
}

/**
 * Whether a media query matches, kept up to date as the screen changes (folds, turns, resizes). Read as the screen is
 * drawn: a new query (useIsMobile's at a new text size) is answered in that same frame, not one later.
 */
export function useMedia(q: string): boolean {
  const { list, subscribe } = mediaQuery(q);
  return useSyncExternalStore(subscribe, () => list.matches);
}

/**
 * One screen at a time (the chats in a drawer), when the app is laid out 760 px wide or less: a phone, a folded
 * foldable, a narrow window, or a wider screen at a larger text size (an unfolded phone at 150% is laid out phone-wide).
 * A media query at the zoomed breakpoint: it follows the screen, never pinch zoom. While the size is being changed in
 * Settings, the breakpoint stays (zoom.ts layoutZoom), so the chats don't come or go under the − and + buttons.
 */
export function useIsMobile(): boolean {
  const zoom = useSyncExternalStore(onZoom, layoutZoom);
  return useMedia(`(max-width: ${Math.round((760 * zoom) / 100)}px)`);
}

/** A touch screen (the main pointer is a finger), at any width: an unfolded foldable or a tablet as much as a phone. */
export const useTouchScreen = () => useMedia("(pointer: coarse)");

/**
 * A foldable half-folded like a book (or a two-screen phone): the browser reports two parts of the screen side by
 * side (viewport.ts). The chats then take the left part and the screen the right one, so nothing sits across the fold.
 */
export const useBookPosture = () => useSyncExternalStore(onPosture, () => currentPosture() === "book");

/**
 * A text box that grows with what's typed, up to its CSS max-height (the message box: a third of the visible height
 * above the keyboard), then scrolls. Without one, it stops at 220 px.
 */
export function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const el = ref.current;
    if (el) fitText(el);
  }, [ref, value]);
  // A new width (a foldable folding or unfolding, the phone turning) wraps the text again: so the box is measured again.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // In the next frame: a new height while size changes are being reported is a loop (Safari reports it as an error).
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitText(el));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref]);
}

function fitText(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const cap = parseFloat(getComputedStyle(el).maxHeight);
  el.style.height = Math.min(el.scrollHeight, Number.isFinite(cap) ? cap : 220) + "px";
}

/**
 * `value`, changing at most every `ms` while `active` (the newest value once the time is up); the moment it isn't
 * active, `value` itself.
 */
export function useThrottled<T>(value: T, active: boolean, ms: number): T {
  const [shown, setShown] = useState(value);
  const since = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    if (!active) {
      // Kept in step, so it never starts again from something older than what's on screen.
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      since.current = Date.now();
      setShown(value);
    }, Math.max(0, since.current + ms - Date.now()));
    return () => clearTimeout(timer);
  }, [value, active, shown, ms]);
  return active ? shown : value;
}

export function useInterval(fn: () => void, ms: number) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function copyText(text: string): Promise<boolean> {
  const fallback = () => {
    // Without the async clipboard (plain http, some webviews), copy through a hidden text field.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    // iOS zooms into a smaller field it selects, and selects only with a range.
    ta.style.fontSize = "var(--field-text, 16px)";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  };
  if (!navigator.clipboard?.writeText) return Promise.resolve(fallback());
  return navigator.clipboard
    .writeText(text)
    .then(() => true)
    .catch(() => fallback());
}

/** Big tappable radio cards with a description each; easier on a phone than a segmented control. */
export function ChoiceCards<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; help?: string; badge?: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="choice-cards" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={`choice-card ${value === o.id ? "on" : ""}`} onClick={() => onChange(o.id)}>
          <span className="choice-card-title">
            {o.label}
            {o.badge}
          </span>
          {o.help && <span className="choice-card-help">{o.help}</span>}
        </button>
      ))}
    </div>
  );
}

/** A number picker with − and + buttons, for exact values that a slider makes fiddly on a phone. */
export function Stepper({ value, min, max, onChange, label, unit }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; unit?: (n: number) => string }) {
  const set = (n: number) => onChange(Math.min(max, Math.max(min, n)));
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" className="btn" onClick={() => set(value - 1)} disabled={value <= min} aria-label={`Decrease ${label}`}>
        −
      </button>
      <output aria-live="polite">{unit ? unit(value) : value}</output>
      <button type="button" className="btn" onClick={() => set(value + 1)} disabled={value >= max} aria-label={`Increase ${label}`}>
        +
      </button>
    </div>
  );
}

/** Marks a chat billed through an API key instead of a plan. */
export function ApiBadge() {
  return (
    <span className="api-badge" title="Uses an API key: billed per use, not from your plan">
      API
    </span>
  );
}
