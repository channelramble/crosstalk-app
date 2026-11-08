// A sign-in that stopped working, and signing an agent in again from the phone.
//
// Chats can stop with "Failed to authenticate: OAuth session expired and could not be refreshed" while the setup
// checklist still says the agent is signed in: the shared sign-in has been cleared, and without this the only fix is a
// terminal on the hub's machine. This module is the hub's side of the fix:
// - Sign-in needs (SignInNeed): the engine (engine.ts, staleSignIn) starts an agent whose sign-in went stale again once;
//   when that doesn't help and the agent's own check says it's signed out, the account is recorded here, kept in kv
//   `signInNeeds` (a restart remembers it), sent to every device (`signin.needs`) and put in the state snapshot. It's
//   over when a reply on that account goes through, a check says it's signed in, or a sign-in here finishes.
// - Sign-in sessions (SignInSession): the agent's own sign-in, started on this machine from the phone. Claude Code's
//   `auth login` (link, then paste the code the page shows), Muse Code's `muse login` (device code) and Gemini CLI's
//   own screen (link, paste) run in a terminal of their own here that no device ever sees; Codex's device code comes
//   from its app-server. Antigravity CLI opens a menu first, so it keeps its terminal sign-in (409 "terminal").
//   What the person pastes goes to the agent's terminal and nowhere else: it isn't logged, stored, sent to any device or
//   echoed back (the terminal's echo is switched off, and anything the agent prints is scrubbed of it before it's even
//   read). Only the person's own devices may use these routes: never another machine's hub, a peer sign-in or a setup
//   key. The contract is at SignInSession in shared/src/protocol.ts.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACCOUNT,
  PROVIDER_INFO,
  agentHasSignIn,
  memberAccount,
  noSignInWords,
  signInAgentWords,
  signInNeededWords,
  staleSignInFailedWords,
  type Device,
  type Member,
  type Provider,
  type Room,
  type SignInNeed,
  type SignInSession,
  type SignInState,
} from "@crosstalk/shared";
import type { App } from "./app";
import type { AuthHit } from "./agents/stale-login";
import type { SignInHooks } from "./engine/engine";
import { HttpError } from "./engine/engine";
import { route, type Route } from "./routes";
import { redactLog } from "./setup/system";
import { newId } from "./util/ids";
import { logger } from "./util/log";
import { endProcess } from "./util/process";

const log = logger("signin");

/** An ended session stays this long, so a phone coming back sees how it ended. */
const KEEP_ENDED_MS = 10 * 60_000;
/** Sign-ins running at once on this machine. */
const MAX_OPEN = 4;
/** The longest code the agents' pages show (Claude Code's code#state is about 130 characters). */
const CODE_MAX = 4096;
/**
 * The shortest paste that can be a code from a sign-in page: Claude Code's code part (before the #) and Google's
 * authorization code are far longer. Anything shorter (a stray letter, a slip of a phone keyboard) is refused before it
 * reaches the agent.
 */
const CODE_MIN = 16;
/** What was pasted is taken out of the agent's screen only from this length on: a shorter one could be part of its words. */
const SCRUB_MIN = 8;
/** How much of a sign-in's screen is kept to read the link and code from (it never leaves the hub). */
const SCREEN_MAX = 64 * 1024;
/** An agent that shows no sign-in link this long after starting won't (it opened a menu or a screen of its own). */
const FIRST_LINK_MS = 45_000;
/** How long each agent's sign-in is waited for (Codex's device code lasts 15 minutes, Gemini CLI gives up after 5). */
const TTL_MS: Partial<Record<Provider, number>> = { claude: 10 * 60_000, codex: 15 * 60_000, muse: 15 * 60_000, gemini: 5 * 60_000 };

/** The person's own devices: not another machine's hub (its full or peer sign-in). Setup keys never reach /api at all. */
export function isPersonDevice(d: Pick<Device, "scope" | "hubId" | "platform">): boolean {
  return d.scope !== "peer" && !d.hubId && d.platform !== "Crosstalk hub";
}

function personOnly(device: Device) {
  if (!isPersonDevice(device)) throw new HttpError(403, "Only your own devices can sign agents in. This sign-in belongs to another machine's hub.", "person_only");
}

// ---------------------------------------------------------------------------------------------- reading a sign-in screen

/** What an agent's sign-in screen says now. */
interface ScreenRead {
  url?: string | null;
  userCode?: string | null;
  /** The page shows the code itself: the person only checks it matches (Muse Code's "confirm this code matches"). */
  confirmCode?: boolean;
  /** It's waiting for the code from the sign-in page. */
  wantsCode?: boolean;
  /** It turned the last pasted code down (it waits for another). */
  refused?: boolean;
  /** It says it's signed in. */
  succeeded?: boolean;
  /** It gave up, in its own words (scrubbed). */
  failed?: string | null;
  /** The code or link ran out before anyone finished. */
  expired?: boolean;
}

interface PtyRecipe {
  kind: "pty";
  method: "device" | "paste";
  argv: (bin: string) => string[];
  env: Record<string, string>;
  /**
   * `screen`: everything shown so far; `after`: what's shown since the last paste (null before any); `refused`: it turned
   * the last paste down, as `refusal` found it in what it printed before anything was taken out of that.
   */
  read: (screen: string, after: string | null, refused?: boolean) => ScreenRead;
  /** The agent's words turning a pasted code down (looked for in each piece of its output as it comes, unscrubbed). */
  refusal?: RegExp;
  /** For an agent that goes on into its own screen once signed in (Gemini CLI): whether it has saved a sign-in since `t`. */
  savedSince?: (t: number) => boolean;
}

interface CodexRecipe {
  kind: "codex";
  method: "device";
}

type Recipe = PtyRecipe | CodexRecipe;

/** Escape sequences and control characters out, so what's left is the text a person would see. */
export function screenText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** An address a phone may open: https only, of a sensible length. */
function safeUrl(s: string | undefined | null): string | null {
  if (!s || s.length > 4000) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The newest sign-in link on the screen: an OSC 8 link's target, else an https address after `marker`. */
export function signInLink(raw: string, marker: RegExp): string | null {
  const linked = [...raw.matchAll(/\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b\s]+)(?:\x07|\x1b\\)/g)].map((m) => safeUrl(m[1])).filter(Boolean);
  if (linked.length) return linked[linked.length - 1]!;
  const text = screenText(raw);
  const found = [...text.matchAll(new RegExp(`${marker.source}\\s*(https:\\/\\/[^\\s"'<>]+)`, "gi"))].map((m) => safeUrl(m[1])).filter(Boolean);
  return found.length ? found[found.length - 1]! : null;
}

/** Claude Code turning a pasted code down (it waits for another). */
export const CLAUDE_REFUSAL = /Invalid code|That code is not from this sign-in/i;

/**
 * Claude Code's `claude auth login --claudeai` (2.1.289 and 2.1.316): "Opening browser to sign in…", then "If the browser
 * didn't open, visit: <link>" (an OSC 8 link on a terminal), then "Paste code here if prompted > " (or, when it couldn't
 * listen for the browser itself, "Sign in at: <link>" and "Paste code here > "). The page shows `code#state`; a line
 * without both parts gets "Invalid code. Please make sure the full code was copied." and it waits for another. It ends
 * with "Login successful." (exit 0) or "Login failed: …" (exit 1). `refused`: CLAUDE_REFUSAL was seen in its output
 * before what was pasted was taken out of it.
 */
export function readClaudeScreen(raw: string, afterRaw: string | null, refused = false): ScreenRead {
  const url = signInLink(raw, /(?:visit:|Sign in at:)/);
  const text = screenText(raw);
  if (/Login successful/i.test(text)) return { url, succeeded: true };
  const failed = /Login failed:\s*([^\n]*)/.exec(text);
  if (failed) return { url, failed: failed[1].trim() || "it didn't say why" };
  if (afterRaw !== null) {
    if (refused || CLAUDE_REFUSAL.test(screenText(afterRaw))) return { url, wantsCode: true, refused: true };
    return { url, wantsCode: false };
  }
  return { url, wantsCode: /Paste code here/i.test(text) };
}

/** Gemini CLI turning a pasted code down. */
export const GEMINI_REFUSAL = /Failed to authenticate with (?:authorization|user) code|Authorization code is required/i;

/**
 * Gemini CLI 0.62 with NO_BROWSER=true, when its Google sign-in is the one chosen: "Please visit the following URL to
 * authorize the application:" and the link, then "Enter the authorization code: " (its readline shows what's typed,
 * whatever the terminal's echo). A code it can't use gets "Failed to authenticate with authorization code:…" and, once,
 * "Failed to authenticate with user code. Retrying..." with a new link (a new verifier and state: the old page's code
 * can't work any more) and the prompt; the second time it gives up. Signed in, it goes on into its own screen
 * (savedSince tells), and after five minutes it gives up ("Authorization timed out after 5 minutes."). `refused`: as
 * readClaudeScreen's.
 */
export function readGeminiScreen(raw: string, afterRaw: string | null, refused = false): ScreenRead {
  const url = signInLink(raw, /authorize the application:/);
  const text = screenText(raw);
  if (/Authorization timed out/i.test(text)) return { url, expired: true };
  if (afterRaw !== null) {
    const after = screenText(afterRaw);
    const prompt = /Enter the authorization code:/i.test(after);
    if (/Failed to authenticate with user code\.(?! Retrying)/i.test(after) && !prompt) return { url, failed: "Google didn't accept the code" };
    if (prompt) return { url, wantsCode: true, refused: refused || GEMINI_REFUSAL.test(after) };
    return { url, wantsCode: false };
  }
  return { url, wantsCode: /Enter the authorization code:/i.test(text) };
}

/**
 * Muse Code 1.4.14's `muse login`: "Open this page to sign in:" and the link, then "confirm this code matches:" or "and
 * enter this code:" and the code, "Press Enter to open it in your browser:" (never pressed: that opens the Mac's
 * browser) and "Waiting for approval…". It ends signed in (exit 0), or with "The login request expired before it was
 * approved.", "The login request was denied." or "device login isn't available yet".
 */
export function readMuseScreen(raw: string): ScreenRead {
  const url = signInLink(raw, /Open this page to sign in:/);
  const text = screenText(raw);
  const said = /(confirm this code matches|and enter this code):\s*([A-Z0-9]{3,10}(?:-[A-Z0-9]{3,10}){0,3})\b/i.exec(text);
  const code = said?.[2] ?? null;
  const confirmCode = /^confirm/i.test(said?.[1] ?? "");
  if (/expired before it was approved/i.test(text)) return { url, userCode: code, expired: true };
  if (/request was denied/i.test(text)) return { url, userCode: code, failed: "the sign-in was turned down on the page" };
  if (/device login isn't available/i.test(text)) return { url, userCode: code, failed: "Muse Code's device sign-in isn't available yet" };
  return { url, userCode: code, ...(confirmCode ? { confirmCode } : {}) };
}

/** What the person pasted, out of `text` (the whole code, and the code part of Claude Code's `code#state`). */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= SCRUB_MIN) out = out.split(s).join("[code]");
  return out;
}

// ---------------------------------------------------------------------------------------------- sessions

interface Live {
  session: SignInSession;
  recipe: Recipe;
  /** What was pasted, held only while the session runs: scrubbed from everything the agent prints. */
  secrets: string[];
  /** The agent's screen so far, scrubbed (never leaves the hub), and what it showed since the last paste. */
  raw: string;
  after: string | null;
  pastedAt: number;
  /** The link when the last code was pasted: an agent that turns a code down may make a new one (Gemini CLI does). */
  urlAtPaste: string | null;
  /** It turned the last paste down (its refusal, seen before anything was taken out of what it printed). */
  refusedRaw: boolean;
  ended: boolean;
  /** The page shows the code: the person checks it matches rather than typing it (ScreenRead.confirmCode). */
  confirmCode: boolean;
  confirming: boolean;
  /** The agent said it's signed in: Crosstalk waits for it to finish saving and exit before checking. */
  finishing: boolean;
  timers: ReturnType<typeof setTimeout>[];
  write?: (data: string) => void;
  stop?: () => Promise<void>;
  loginId?: string;
}

/** The app's sign-in state: needs (the engine's hooks) and sessions (the routes). */
export class SignIns implements SignInHooks {
  private needMap = new Map<string, SignInNeed>();
  private live = new Map<string, Live>();
  /** How long each agent's sign-in is waited for (tests shorten it). */
  ttlMs: Partial<Record<Provider, number>> = { ...TTL_MS };
  /** How long an agent may take to show its sign-in link (tests shorten it). */
  firstLinkMs = FIRST_LINK_MS;

  constructor(private app: App) {
    try {
      const saved = JSON.parse(app.store.kvGet("signInNeeds") ?? "[]") as SignInNeed[];
      for (const n of Array.isArray(saved) ? saved : []) if (n && typeof n.provider === "string" && typeof n.account === "string") this.needMap.set(key(n.provider, n.account), n);
    } catch {
      // nothing kept
    }
  }

  // ------------------------------------------------------------------ needs (the engine's SignInHooks)

  /**
   * The accounts found signed out, oldest first: an account removed since is gone from it, and so are deleted chats. An
   * agent with no sign-in (Crosstalk's own) is never in it, whatever was kept.
   */
  needs(): SignInNeed[] {
    return [...this.needMap.values()]
      .filter((n) => agentHasSignIn(n.provider) && this.app.providers.hasAccount(n.provider, n.account))
      .map((n) => ({ ...n, rooms: n.rooms.filter((r) => !!this.app.store.getRoom(r)) }))
      .sort((a, b) => a.since - b.since);
  }

  /**
   * Whether a failed reply of this member's may be its sign-in: only an agent that has one (never one that runs only on
   * services, Crosstalk's own or OpenCode: it runs on a service's key whatever account it's on, or has none any more), on a
   * plan sign-in rather than an API key or a model server of your own. Nothing else is ever started again, checked or
   * recorded as signed out.
   */
  covers(member: Member): boolean {
    const p = member.provider;
    if (!(p in PROVIDER_INFO) || !agentHasSignIn(p)) return false;
    const id = memberAccount(member);
    if (this.app.providers.isApiKeyAccount(p, id) || this.app.providers.endpointOf(p, id)) return false;
    // An agent run on an API key the hub keeps (Muse's META_API_KEY, Gemini's GEMINI_API_KEY) has no sign-in to renew.
    const method = (id === DEFAULT_ACCOUNT ? this.app.providers.list().find((s) => s.provider === p) : this.accountOf(p, id))?.authMethod ?? "";
    return !/api key/i.test(method);
  }

  names(member: Member): { agent: string; machine: string } {
    return { agent: this.agentWords(member.provider, memberAccount(member)), machine: this.app.machineName() };
  }

  isNeeded(member: Member): boolean {
    return this.needMap.has(key(member.provider, memberAccount(member)));
  }

  /** The agent's own sign-in check (Claude Code's `auth status`, Codex's account/read…), the one the setup checklist shows. */
  async check(member: Member): Promise<boolean | null> {
    const a = await this.app.providers.refreshAccount(member.provider, memberAccount(member));
    return a.signedIn;
  }

  needed(room: Room, member: Member): string {
    const account = memberAccount(member);
    const k = key(member.provider, account);
    const cur = this.needMap.get(k);
    const machine = { id: this.app.hubId(), name: this.app.machineName() };
    const accountLabel = this.labelOf(member.provider, account);
    const words = signInNeededWords({ provider: member.provider, account, accountLabel }, machine.name);
    // An agent with no sign-in (one that runs only on services) is never recorded as signed out: nothing could ever end that need, and
    // every screen would offer a sign-in it doesn't have. The engine never asks for one (covers), and this keeps it so.
    if (!agentHasSignIn(member.provider)) return words;
    const need: SignInNeed = {
      provider: member.provider,
      account,
      accountLabel,
      machine,
      since: cur?.since ?? Date.now(),
      rooms: [...(cur?.rooms ?? []).filter((r) => r !== room.id), room.id].slice(-50),
      words,
    };
    this.needMap.set(k, need);
    this.saveNeeds();
    log.info(`${signInAgentWords(need)} is signed out on ${machine.name}: ${need.rooms.length} chat(s) stopped on it`);
    return words;
  }

  stillFailing(_room: Room, member: Member, hit: AuthHit, signedIn: boolean | null): string {
    const account = memberAccount(member);
    return staleSignInFailedWords({ provider: member.provider, account, accountLabel: this.labelOf(member.provider, account) }, this.app.machineName(), { busy: hit.kind === "busy", signedIn });
  }

  worked(room: Room, member: Member) {
    this.over(member.provider, memberAccount(member), room.id);
  }

  /** An account's sign-in was checked (Settings, the setup tools, a sign-in that finished): signed in ends its need. */
  statusChecked(p: Provider, account: string, signedIn: boolean | null) {
    if (signedIn === true) this.over(p, account, null);
  }

  /**
   * An account is signed in again: its need is over, every device hears so, and each chat that had stopped on it (and
   * whose agent still shows that failure) says it can carry on. `except`: the chat whose reply just went through.
   */
  private over(p: Provider, account: string, except: string | null) {
    const k = key(p, account);
    const need = this.needMap.get(k);
    if (!need) return;
    this.needMap.delete(k);
    this.saveNeeds();
    log.info(`${signInAgentWords(need)} is signed in again on ${this.app.machineName()}`);
    for (const roomId of need.rooms) {
      if (roomId === except || !this.app.store.getRoom(roomId)) continue;
      const stuck = this.app.store.listMembers(roomId).some((m) => m.provider === p && memberAccount(m) === account && m.status === "error");
      if (stuck) this.app.engine.systemMessage(roomId, `${signInAgentWords(need)} is signed in again on ${this.app.machineName()}. Tap Try again to carry on.`);
    }
  }

  private saveNeeds() {
    this.app.store.kvSet("signInNeeds", JSON.stringify(this.needs()));
    this.app.bus.emit({ t: "signin.needs", needs: this.needs() });
  }

  private accountOf(p: Provider, id: string) {
    return this.app.providers.accounts().find((a) => a.provider === p && a.id === id) ?? null;
  }

  private labelOf(p: Provider, id: string): string | null {
    return id === DEFAULT_ACCOUNT ? null : this.accountOf(p, id)?.label ?? null;
  }

  private agentWords(p: Provider, account: string): string {
    return signInAgentWords({ provider: p, account, accountLabel: this.labelOf(p, account) });
  }

  // ------------------------------------------------------------------ sessions

  sessions(): SignInSession[] {
    return [...this.live.values()].map((l) => ({ ...l.session })).sort((a, b) => a.startedAt - b.startedAt);
  }

  get(id: string): SignInSession {
    const l = this.live.get(id);
    if (!l) throw new HttpError(404, "That sign-in has ended and gone. Start a new one.", "gone");
    return { ...l.session };
  }

  /** Starts the agent's own sign-in on this machine (replacing one that's open for the same agent and account). */
  async start(providerIn: unknown, accountIn: unknown): Promise<SignInSession> {
    const p = String(providerIn ?? "") as Provider;
    if (!(p in PROVIDER_INFO) || p === "mock") throw new HttpError(400, "Sign in to which agent? Claude Code, Codex, Muse Code or Gemini CLI.", "provider");
    // Before anything about its accounts or its program: it has neither a sign-in nor a program to be missing.
    if (!agentHasSignIn(p)) throw new HttpError(409, noSignInWords(p), "not_signin");
    const account = typeof accountIn === "string" && accountIn ? accountIn : DEFAULT_ACCOUNT;
    const name = PROVIDER_INFO[p].name;
    if (!this.app.providers.hasAccount(p, account)) throw new HttpError(404, `There's no ${name} account like that on ${this.app.machineName()} any more.`, "account");
    if (this.app.providers.isApiKeyAccount(p, account) || this.app.providers.endpointOf(p, account)) throw new HttpError(409, "This account runs on an API key or a model server of your own: there's nothing to sign in to. Change its key in Settings → AI services.", "not_signin");
    if (p === "antigravity") throw new HttpError(409, "Antigravity CLI asks how to sign in on a screen of its own first, so it signs in from its terminal: Settings → AI services → Antigravity CLI → Sign in.", "terminal");
    const bin = this.app.providers.which(p);
    if (!bin) throw new HttpError(409, `${name} isn't installed on ${this.app.machineName()}. Install it under Settings → AI services first.`, "not_installed");
    const env = this.app.providers.agentEnv(p, account);
    // A Muse Code without `muse login` signs in from its own screen (and `muse login` would be a prompt to it).
    if (p === "muse") {
      const { museHelp } = await import("./providers/muse");
      if (!/^\s+login\b/m.test(await museHelp(bin, env))) throw new HttpError(409, "This Muse Code signs in from its own screen: Settings → AI services → Muse Code → Sign in.", "terminal");
    }
    const recipe = this.recipe(p, account, env);
    if (!recipe) throw new HttpError(409, `${name} signs in from its terminal: Settings → AI services → ${name} → Sign in.`, "terminal");
    // One sign-in per agent and account: a new one replaces the one that's open, and one Settings started the older
    // way (its terminal, or Codex's device code there) ends too, so two never write the same sign-in at once.
    for (const l of this.live.values()) if (!l.ended && l.session.provider === p && l.session.account === account) this.end(l, "cancelled", "A newer sign-in replaced this one.");
    this.app.providers.endLogin(p, account);
    if ([...this.live.values()].filter((l) => !l.ended).length >= MAX_OPEN) throw new HttpError(429, "Several sign-ins are already running here. Finish or stop one of them first.", "too_many");
    const now = Date.now();
    const ttl = this.ttlMs[p] ?? TTL_MS[p] ?? 10 * 60_000;
    const live: Live = {
      session: {
        id: newId("si"),
        provider: p,
        account,
        accountLabel: this.labelOf(p, account),
        machine: { id: this.app.hubId(), name: this.app.machineName() },
        method: recipe.method,
        state: "starting",
        url: null,
        userCode: null,
        wantsCode: false,
        codesSent: 0,
        codeRefused: false,
        words: `Starting ${this.agentWords(p, account)}'s sign-in on ${this.app.machineName()}…`,
        startedAt: now,
        expiresAt: now + ttl,
        endedAt: null,
      },
      recipe,
      secrets: [],
      raw: "",
      after: null,
      pastedAt: 0,
      urlAtPaste: null,
      refusedRaw: false,
      ended: false,
      confirmCode: false,
      confirming: false,
      finishing: false,
      timers: [],
    };
    this.live.set(live.session.id, live);
    live.timers.push(setTimeout(() => this.end(live, "expired", `Nobody finished the sign-in within ${Math.round(ttl / 60_000) || 1} minute${ttl >= 120_000 ? "s" : ""}, so Crosstalk stopped it. Start again when you're ready.`), ttl));
    if (this.firstLinkMs < ttl) {
      live.timers.push(setTimeout(() => {
        if (!live.ended && !live.session.url) this.end(live, "failed", `${this.agentWords(p, account)} didn't show a sign-in link. Tap Start again. If it still shows none, it's waiting for something to be answered at ${this.app.machineName()} first.`);
      }, this.firstLinkMs));
    }
    this.emit(live);
    log.info(`a sign-in for ${this.agentWords(p, account)} started on ${this.app.machineName()} (${recipe.method})`);
    try {
      if (recipe.kind === "codex") await this.startCodex(live, bin, env);
      else this.startPty(live, recipe, bin);
    } catch (e) {
      this.end(live, "failed", `${name}'s sign-in didn't start: ${this.said(live, e instanceof Error ? e.message : String(e))}`);
    }
    return { ...live.session };
  }

  /** The code the sign-in page showed, into the agent's sign-in. Never logged, kept or sent anywhere else. */
  sendCode(id: string, codeIn: unknown): SignInSession {
    const live = this.live.get(id);
    if (!live) throw new HttpError(404, "That sign-in has ended and gone. Start a new one.", "gone");
    if (live.ended || live.recipe.method !== "paste" || !live.session.wantsCode || !live.write) throw new HttpError(409, "This sign-in isn't waiting for a code right now.", "not_waiting");
    const code = typeof codeIn === "string" ? codeIn.trim() : "";
    if (!code) throw new HttpError(400, "Paste the code the sign-in page showed.", "code");
    if (code.length > CODE_MAX || /[\x00-\x1f\x7f]/.test(code)) throw new HttpError(400, "Paste just the code from the sign-in page: one line, nothing else.", "code");
    // Too short to be one (Claude Code's code part is what's before the #): it never reaches the agent, and the box stays open.
    if (code.split("#")[0].length < CODE_MIN) throw new HttpError(400, "That's too short to be the code from the sign-in page. Copy all of it there, then paste it here.", "code");
    live.secrets.push(code);
    const part = code.split("#")[0];
    if (part !== code) live.secrets.push(part);
    live.raw = scrub(live.raw, live.secrets);
    live.after = "";
    live.pastedAt = Date.now();
    live.urlAtPaste = live.session.url;
    live.refusedRaw = false;
    this.update(live, { state: "checking", wantsCode: false, codeRefused: false, codesSent: live.session.codesSent + 1, words: `Checking the code with ${this.agentWords(live.session.provider, live.session.account)}…` });
    live.write(`${code}\r`);
    return { ...live.session };
  }

  /** Ends the sign-in running for this agent and account, if one is (another way of signing it in started). */
  endFor(p: Provider, account: string, words: string) {
    for (const l of this.live.values()) if (!l.ended && l.session.provider === p && l.session.account === account) this.end(l, "cancelled", words);
  }

  cancel(id: string): SignInSession {
    const live = this.live.get(id);
    if (!live) throw new HttpError(404, "That sign-in has ended and gone.", "gone");
    if (!live.ended) this.end(live, "cancelled", "Sign-in stopped.");
    return { ...live.session };
  }

  /** The hub is stopping: every sign-in's process ends with it. */
  async shutdown() {
    const stops: Promise<void>[] = [];
    for (const l of this.live.values()) {
      if (!l.ended) {
        l.ended = true;
        for (const t of l.timers) clearTimeout(t);
        l.secrets = [];
        if (l.stop) stops.push(l.stop().catch(() => {}));
      }
    }
    await Promise.all(stops);
  }

  // ------------------------------------------------------------------ how each agent signs in

  private recipe(p: Provider, account: string, env: Record<string, string>): Recipe | null {
    if (p === "codex") return { kind: "codex", method: "device" };
    if (p === "claude") {
      return {
        kind: "pty",
        method: "paste",
        // The terminal doesn't echo what's typed: the pasted code never shows on its screen.
        argv: (bin) => ["/bin/sh", "-c", 'stty -echo 2>/dev/null; exec "$0" "$@"', bin, "auth", "login", "--claudeai"],
        env: { ...env, BROWSER: "/bin/false" },
        read: readClaudeScreen,
        refusal: CLAUDE_REFUSAL,
      };
    }
    if (p === "muse") {
      return { kind: "pty", method: "device", argv: (bin) => [bin, "login"], env: { ...env, BROWSER: "/bin/false" }, read: (raw) => readMuseScreen(raw) };
    }
    if (p === "gemini") {
      const creds = join(account === DEFAULT_ACCOUNT ? homedir() : this.app.providers.accountDir("gemini", account), ".gemini", "oauth_creds.json");
      return {
        kind: "pty",
        method: "paste",
        argv: (bin) => ["/bin/sh", "-c", 'stty -echo 2>/dev/null; exec "$0" "$@"', bin],
        env: { ...env, NO_BROWSER: "true" },
        read: readGeminiScreen,
        refusal: GEMINI_REFUSAL,
        // Only its time is looked at, never what's in it.
        savedSince: (t) => {
          try {
            return existsSync(creds) && statSync(creds).mtimeMs > t;
          } catch {
            return false;
          }
        },
      };
    }
    return null;
  }

  /** The agent's sign-in in a terminal of its own: no device sees it, and it never opens a browser on this machine. */
  private startPty(live: Live, recipe: PtyRecipe, bin: string) {
    const decoder = new TextDecoder();
    const term = new Bun.Terminal({
      // Wide, so nothing the agent prints is wrapped through a link.
      cols: 400,
      rows: 60,
      name: "xterm-256color",
      data: (_t, bytes) => this.onScreen(live, decoder.decode(bytes, { stream: true })),
    });
    const full: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...recipe.env, TERM: "xterm-256color" })) if (v !== undefined) full[k] = v;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(recipe.argv(bin), { terminal: term, cwd: homedir(), env: full });
    } catch (e) {
      term.close();
      throw e;
    }
    live.write = (data) => {
      if (!term.closed) term.write(data);
    };
    live.stop = async () => {
      await endProcess(proc);
      setTimeout(() => {
        if (!term.closed) term.close();
      }, 250).unref?.();
    };
    if (recipe.savedSince) {
      // It goes on into its own screen once signed in: a sign-in saved since the code went in is the sign that it's done.
      live.timers.push(setInterval(() => {
        if (!live.ended && !live.confirming && !live.finishing && live.pastedAt && recipe.savedSince!(live.pastedAt - 1000)) this.finish(live, 1500);
      }, 500));
    }
    void proc.exited.then((code) => {
      setTimeout(() => {
        if (!term.closed) term.close();
      }, 250).unref?.();
      // Its last words are read before its exit is.
      setTimeout(() => void this.onExit(live, code), 50);
    });
  }

  private onScreen(live: Live, chunk: string) {
    if (live.ended || live.recipe.kind !== "pty") return;
    // Whether it turned the last code down is looked for in what it printed as it printed it, so nothing pasted can hide
    // its words; only that it did is kept, never the words.
    if (live.after !== null && live.recipe.refusal?.test(screenText(chunk))) live.refusedRaw = true;
    // What was pasted is taken out before anything is read: a terminal that echoed it back shows "[code]".
    live.raw = scrub((live.raw + chunk).slice(-SCREEN_MAX), live.secrets);
    if (live.after !== null) live.after = scrub((live.after + chunk).slice(-SCREEN_MAX), live.secrets);
    this.read(live);
  }

  private read(live: Live) {
    if (live.ended || live.confirming || live.recipe.kind !== "pty") return;
    const r = live.recipe.read(live.raw, live.after, live.refusedRaw);
    const s = live.session;
    const agent = this.agentWords(s.provider, s.account);
    if (r.failed) return this.end(live, "failed", `${agent} couldn't finish signing in: ${this.said(live, r.failed)}. Start again when you're ready.`);
    if (r.expired) return this.end(live, "expired", `The sign-in ran out of time before it was finished. Start again when you're ready.`);
    if (r.succeeded) return this.finish(live);
    if (live.finishing) return;
    const url = r.url ?? s.url;
    const userCode = r.userCode ?? s.userCode;
    if (r.confirmCode) live.confirmCode = true;
    if (!url) return;
    const wantsCode = s.method === "paste" && !!r.wantsCode;
    const state: SignInState = s.state === "checking" && !r.refused && !wantsCode ? "checking" : "open";
    const refused = r.refused ? true : state === "checking" ? false : s.codeRefused;
    // It turned the code down and made a new link (Gemini CLI does): the code from the old page can't work any more.
    const newLink = refused && !!live.urlAtPaste && url !== live.urlAtPaste;
    const words = this.openWords(live, url, userCode, refused, newLink);
    if (url !== s.url || userCode !== s.userCode || wantsCode !== s.wantsCode || state !== s.state || refused !== s.codeRefused || (state === "open" && words !== s.words)) {
      this.update(live, { url, userCode, wantsCode, state, codeRefused: refused, ...(state === "open" ? { words } : {}) });
    }
  }

  /** What to do while a sign-in is open, in plain words. */
  private openWords(live: Live, url: string | null, userCode: string | null, refused: boolean, newLink = false): string {
    const s = live.session;
    const agent = this.agentWords(s.provider, s.account);
    if (refused && newLink) return `That code didn't work, and ${agent} made a new sign-in link. Open the sign-in page again, sign in, and paste the new code it shows.`;
    if (refused) return `${agent} didn't take that code. Copy the whole code from the sign-in page and paste it again.`;
    if (s.method === "device") {
      if (!userCode) return `Open the sign-in link on any device and sign in.`;
      return live.confirmCode ? `Open the sign-in link on any device, sign in, and check it shows this code: ${userCode}.` : `Open the sign-in link on any device, sign in, and enter this code: ${userCode}.`;
    }
    const who = s.provider === "claude" ? "the Claude account that has your plan" : s.provider === "gemini" ? "your Google account" : "your account";
    return url ? `Open the sign-in link and sign in with ${who}. The page then shows a code: copy all of it and paste it here.` : `Starting ${agent}'s sign-in…`;
  }

  private async onExit(live: Live, code: number | null) {
    if (live.ended || live.confirming) return;
    const r = live.recipe.kind === "pty" ? live.recipe.read(live.raw, live.after, live.refusedRaw) : {};
    const agent = this.agentWords(live.session.provider, live.session.account);
    if (r.failed) return this.end(live, "failed", `${agent} couldn't finish signing in: ${this.said(live, r.failed)}. Start again when you're ready.`);
    if (r.expired) return this.end(live, "expired", "The sign-in ran out of time before it was finished. Start again when you're ready.");
    if (code === 0 || r.succeeded) return this.confirm(live);
    const last = screenText(live.raw).trim().split("\n").filter(Boolean).pop() ?? "";
    this.end(live, "failed", `${agent}'s sign-in stopped (exit ${code ?? "?"})${last ? `: ${this.said(live, last)}` : ""}. Start again when you're ready.`);
  }

  /**
   * The agent says it's signed in: it's let finish saving the sign-in and exit by itself (Claude Code still writes after
   * "Login successful."), then its own check decides. One that doesn't exit within a few seconds is checked anyway.
   */
  private finish(live: Live, graceMs = 15_000) {
    if (live.ended || live.confirming || live.finishing) return;
    live.finishing = true;
    this.update(live, { state: "checking", wantsCode: false, words: `Checking ${this.agentWords(live.session.provider, live.session.account)}'s sign-in…` });
    live.timers.push(setTimeout(() => void this.confirm(live), graceMs));
  }

  /** The agent finished: its own sign-in check decides, and a sign-in ends the account's need. */
  private async confirm(live: Live) {
    if (live.ended || live.confirming) return;
    live.confirming = true;
    const s = live.session;
    const agent = this.agentWords(s.provider, s.account);
    this.update(live, { state: "checking", wantsCode: false, words: `Checking ${agent}'s sign-in…` });
    // Its process has done its part (Gemini CLI goes on into its own screen: it's ended here).
    await live.stop?.().catch(() => {});
    let signedIn: boolean | null = null;
    let detail = "";
    try {
      const a = await this.app.providers.refreshAccount(s.provider, s.account);
      signedIn = a.signedIn;
      detail = [a.plan, a.account].filter(Boolean).join(", ");
    } catch (e) {
      log.warn(`checking ${agent}'s sign-in: ${e instanceof Error ? e.message : e}`);
    }
    if (live.ended) return;
    if (signedIn) {
      this.end(live, "done", `${agent} is signed in on ${this.app.machineName()}${detail ? ` (${detail})` : ""}.`);
      this.over(s.provider, s.account, null);
      // Agents on this account that are doing nothing start afresh with their next message, reading the new sign-in.
      this.app.engine.renewIdle((m) => m.provider === s.provider && memberAccount(m) === s.account);
    } else {
      this.end(live, "failed", `${agent}'s sign-in finished, but ${PROVIDER_INFO[s.provider].name} still says it isn't signed in${signedIn === null ? " (Crosstalk couldn't ask it)" : ""}. Tap Start again to sign in once more.`);
    }
  }

  private async startCodex(live: Live, bin: string, env: Record<string, string>) {
    const { startCodexServer } = await import("./agents/codex");
    const rpc = await startCodexServer(bin, { env });
    live.stop = async () => {
      await rpc.kill();
    };
    if (live.ended) return void rpc.kill();
    // Its app-server went away before the sign-in finished: said now, not at the expiry.
    void rpc.exited.then(() => {
      if (!live.ended && !live.confirming) this.end(live, "failed", "Codex's sign-in stopped before it finished. Start again when you're ready.");
    });
    rpc.onNotification((method, p) => {
      if (method !== "account/login/completed" || live.ended) return;
      if (live.loginId && p?.loginId && p.loginId !== live.loginId) return;
      if (p?.success) void this.confirm(live);
      else this.end(live, "failed", `Codex couldn't finish signing in: ${this.said(live, String(p?.error ?? "it didn't say why"))}. Start again when you're ready.`);
    });
    const res = (await rpc.request("account/login/start", { type: "chatgptDeviceCode" }, 30_000)) as { type?: string; loginId?: string; verificationUrl?: string; userCode?: string } | null;
    if (live.ended) return;
    const url = safeUrl(res?.verificationUrl);
    if (res?.type !== "chatgptDeviceCode" || !url || !res.userCode) throw new Error("Codex didn't offer a sign-in code");
    live.loginId = res.loginId;
    this.update(live, { state: "open", url, userCode: String(res.userCode).slice(0, 40), words: this.openWords(live, url, String(res.userCode), false) });
  }

  /** An agent's own words for the person: what was pasted taken out, tokens and addresses hidden, kept short. */
  private said(live: Live, text: string): string {
    const line = redactLog([scrub(screenText(text), live.secrets)])[0] ?? "";
    return line.replace(/\s+/g, " ").trim().replace(/[.:]+$/, "").slice(0, 200) || "it didn't say why";
  }

  private end(live: Live, state: SignInState, words: string) {
    if (live.ended) return;
    live.ended = true;
    for (const t of live.timers) clearTimeout(t);
    live.timers = [];
    // Nothing pasted outlives the session, and nothing it printed.
    live.secrets = [];
    live.raw = "";
    live.after = null;
    void live.stop?.().catch(() => {});
    this.update(live, { state, wantsCode: false, words, endedAt: Date.now() });
    log.info(`a sign-in for ${this.agentWords(live.session.provider, live.session.account)} on ${this.app.machineName()} ended: ${state}`);
    setTimeout(() => {
      if (this.live.get(live.session.id) === live) this.live.delete(live.session.id);
    }, KEEP_ENDED_MS).unref?.();
  }

  private update(live: Live, patch: Partial<SignInSession>) {
    live.session = { ...live.session, ...patch };
    this.emit(live);
  }

  private emit(live: Live) {
    this.app.bus.emit({ t: "signin.session", session: { ...live.session } });
  }
}

const key = (p: Provider, account: string) => `${p}:${account}`;

// ---------------------------------------------------------------------------------------------- routes

/** The sign-in routes (the contract is at SignInSession in shared/src/protocol.ts): people's own devices only. */
export function signInRoutes(app: App): Route[] {
  return [
    route("GET", "/api/signin", ({ device }) => {
      personOnly(device);
      return { needs: app.signIns.needs(), sessions: app.signIns.sessions() };
    }),
    route("POST", "/api/signin", async ({ device, body }) => {
      personOnly(device);
      const b = ((await body().catch(() => null)) ?? {}) as { provider?: unknown; account?: unknown };
      return app.signIns.start(b.provider, b.account);
    }),
    route("GET", "/api/signin/:id", ({ device, params }) => {
      personOnly(device);
      return app.signIns.get(params.id);
    }),
    route("POST", "/api/signin/:id/code", async ({ device, params, req }) => {
      personOnly(device);
      // Read here, not with body(): a body that isn't JSON must never end up in an error message (or the log) with the
      // code in it.
      let code: unknown = null;
      try {
        code = (JSON.parse(await req.text()) as { code?: unknown } | null)?.code ?? null;
      } catch {
        throw new HttpError(400, 'Send the code as JSON: { "code": "…" }.', "code");
      }
      return app.signIns.sendCode(params.id, code);
    }),
    route("DELETE", "/api/signin/:id", ({ device, params }) => {
      personOnly(device);
      return app.signIns.cancel(params.id);
    }),
  ];
}
