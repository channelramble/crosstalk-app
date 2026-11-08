// Signing an agent in again from the phone (hub/src/signin.ts; the contract is above SignInNeed in shared): which chats,
// agents and checklist items say "Sign in to Claude Code on Mac mini", what the sign-in sheet shows at each step, and
// the hub's note in a reply whose agent picked itself back up. Pure, for the unit tests (signIn.test.ts); the screens
// are views/SignIn.tsx.
//
// A Claude Code chat can stop with "Failed to authenticate: OAuth session expired and could not be refreshed" while
// the setup checklist still says signed in, and the only fix used to be a terminal on that machine. The hub now
// starts a stale agent again once (the reply says so, and nothing is left to do), and when it really is signed out it
// records a SignInNeed: every chat on that agent and account, the agent's card in Settings and the checklist then offer
// one button, which signs it in from here.

import { DEFAULT_ACCOUNT, PROVIDER_INFO, agentHasSignIn, memberAccount, signInAgentWords, type Activity, type Member, type Provider, type SignInNeed, type SignInSession, type SignInState } from "@crosstalk/shared";

/**
 * The agents the hub can sign in from the phone (hub/src/signin.ts): Claude Code and Gemini CLI by a link and a pasted
 * code, Codex and Muse Code by a device code. Antigravity CLI opens a menu first, so the hub answers "terminal" for it.
 * Never Crosstalk's own agent or OpenCode: they have no sign-in (shared agentHasSignIn), only the key of the AI service they run on.
 */
export const PHONE_SIGN_IN: readonly Provider[] = ["claude", "codex", "muse", "gemini"];

/**
 * The sign-ins this app shows at all: only for agents that have one. Crosstalk's own agent and OpenCode never do, so no
 * chat, Settings card, checklist item or notice ever offers to sign them in, whatever list a hub sends; a refused key is
 * said in the reply instead, with Open AI services (views/ServiceKey.tsx).
 */
export function signInsShown(needs: readonly SignInNeed[]): SignInNeed[] {
  return needs.filter((n) => agentHasSignIn(n.provider));
}

/** Who a sign-in is for: an agent and one of its accounts ("default": its own sign-in). */
export type SignInWho = { provider: Provider; account: string; accountLabel?: string | null };

export const signInKey = (x: { provider: Provider; account: string }) => `${x.provider}:${x.account}`;

/** "Sign in to Claude Code on Mac mini" ("Sign in to Claude Code (Work) on Mac mini" for a second account). */
export function signInTitle(x: SignInWho, machine: string): string {
  return `Sign in to ${signInAgentWords(x)} on ${machine}`;
}

/**
 * The sign-ins a chat's agents are waiting on, one per agent and account, in the chat's order. Every chat on that agent
 * and account shows it, not only the chats whose replies stopped on it (`need.rooms`): they would stop the same way.
 */
export function chatNeeds(needs: readonly SignInNeed[] | null | undefined, members: readonly Pick<Member, "provider" | "config">[]): SignInNeed[] {
  if (!needs?.length) return [];
  const shown = signInsShown(needs);
  const out: SignInNeed[] = [];
  for (const m of members) {
    const n = shown.find((x) => x.provider === m.provider && x.account === memberAccount(m));
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** One agent's sign-ins that are needed (its own first, then its other accounts by when they were found). */
export function agentNeeds(needs: readonly SignInNeed[] | null | undefined, provider: Provider): SignInNeed[] {
  return signInsShown(needs ?? []).filter((n) => n.provider === provider).sort((a, b) => Number(b.account === DEFAULT_ACCOUNT) - Number(a.account === DEFAULT_ACCOUNT) || a.since - b.since);
}

/**
 * The line under the chat's "Sign in to …": `stopped` when a reply of this chat failed on it (its Try again is right
 * above), else the chat hasn't tried yet and would fail the same way. `device`: "this iPhone", "this phone"…
 */
export function chatPromptLine(need: SignInWho & { machine: { name: string } }, opts: { stopped: boolean; device: string }): string {
  const agent = signInAgentWords(need);
  return opts.stopped
    ? `${agent} is signed out on ${need.machine.name}, so it couldn't answer. Sign it in again from ${opts.device}, then tap Try again.`
    : `${agent} is signed out on ${need.machine.name}, so it can't answer here until it's signed in again.`;
}

/** The line under an agent's "Sign in to …" in Settings → Agents: what's waiting on it. */
export function settingsPromptLine(need: Pick<SignInNeed, "rooms">): string {
  const n = need.rooms.length;
  return `Its chats can't answer until it's signed in again.${n ? ` ${n === 1 ? "A chat" : `${n} chats`} stopped on it.` : ""}`;
}

/** The line under a checklist item's "Sign in to …": it's done from here, no terminal on that machine. */
export function checklistPromptLine(machine: string, device: string): string {
  return `${device === "this device" ? "From here" : `From ${device}`}: no need to be at ${machine}.`;
}

/**
 * The agent of a setup checklist item that the phone can sign in: "agent.claude" waiting on the person ("user": it's
 * installed but not signed in). Null for anything else, and for agents that sign in only on a screen of their own.
 */
export function checklistAgent(item: { id: string; state: string }): Provider | null {
  const p = /^agent\.(\w+)$/.exec(item.id)?.[1] as Provider | undefined;
  return p && item.state === "user" && PHONE_SIGN_IN.includes(p) && agentHasSignIn(p) ? p : null;
}

// ---------------------------------------------------------------------------------------------- the sheet

const ENDED: readonly SignInState[] = ["done", "failed", "expired", "cancelled"];
export const sessionEnded = (s: Pick<SignInSession, "state" | "endedAt">) => ENDED.includes(s.state) || s.endedAt !== null;

/**
 * A sign-in for this agent and account that's still going and has more than a minute left: a sheet opened again (it
 * was closed, or opened on another of your devices) carries on with it instead of starting another, which would end it.
 */
export function liveSession(sessions: Readonly<Record<string, SignInSession>> | readonly SignInSession[], who: { provider: Provider; account: string }, now = Date.now()): SignInSession | null {
  const list = Array.isArray(sessions) ? sessions : Object.values(sessions);
  return list.filter((s) => s.provider === who.provider && s.account === who.account && !sessionEnded(s) && s.expiresAt - now > 60_000).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/**
 * Which copy of a session to keep: the live updates (`signin.session`) are the hub's word in order. An answer to a
 * request is only taken when nothing newer came: for a new session (`start`), when none came yet; for a pasted code
 * (`code`), when the copy here is from before that paste; a look while the connection is down (`poll`) always.
 */
export function newerSession(cur: SignInSession | undefined, next: SignInSession, how: "start" | "code" | "poll"): boolean {
  if (!cur || how === "poll") return true;
  if (how === "code") return !sessionEnded(cur) && cur.codesSent < next.codesSent;
  return false;
}

/** Why a sign-in couldn't start or go on: the hub's answer (`ApiError`'s status, code and words), or the network's. */
export interface SheetProblem {
  status: number;
  code?: string;
  message: string;
}

/** What a button at the foot of the sheet does (labels: SHEET_ACTIONS). */
export type SheetAction = "cancel" | "close" | "done" | "again" | "retry" | "terminal" | "settings";

/** The words on each button at the foot of the sheet. */
export const SHEET_ACTIONS: Record<SheetAction, string> = {
  cancel: "Cancel",
  close: "Close",
  done: "Done",
  again: "Start again",
  retry: "Try again",
  terminal: "Use its terminal sign-in",
  settings: "Open AI services",
};

/** What the sheet shows: one of these at a time (the dialog's words fade in as it moves on). */
export interface SheetView {
  phase: "starting" | "open" | "checking" | "done" | "ended" | "problem";
  /** Changes when the sheet moves on to its next step: the new words fade in where the last ones were. */
  step: string;
  /** The words for this moment: what's happening, what to do, or what went wrong. Read out when they change. */
  words: string;
  /** "alert" when something went wrong (said at once, in red), else "status". */
  tone: "status" | "alert";
  /** Something is going on that the person waits for (a spinner beside the words). */
  busy: boolean;
  /** The sign-in page to open on this phone. */
  url: string | null;
  /** A code to enter on that page, or to check it shows (`confirm`: Muse Code shows its own and asks you to compare). */
  code: { value: string; confirm: boolean } | null;
  /**
   * The box the code from the sign-in page goes in: `ready` once the agent waits for it, `refused` when it turned the
   * last one down, `newLink` when it also made a new sign-in link (Gemini CLI does): the old page's code can't work, so
   * the link is what to tap next.
   */
  paste: { ready: boolean; refused: boolean; newLink: boolean } | null;
  /** While the sign-in page is open somewhere: what it waits for (a spinner beside it). */
  waiting: string | null;
  /** Once signed in: what happens next. */
  next: string | null;
  /** The buttons at the foot, in order: the last one is the main one. */
  actions: SheetAction[];
}

const base = { busy: false, url: null, code: null, paste: null, waiting: null, next: null } as const;

/**
 * What the sheet shows for a sign-in (`session`, as the hub last said), or for a sign-in that couldn't start (`problem`).
 * `stopped`: a chat's reply failed on it (the sheet was opened from that chat), so once it's signed in the next step is
 * that chat's Try again.
 */
export function sheetView(x: { session: SignInSession | null; problem: SheetProblem | null; agent: string; machine: string; stopped?: boolean }): SheetView {
  const { session: s, problem, agent, machine } = x;
  if (problem && (!s || problem.code === "gone")) return problemView(problem, agent, machine);
  if (!s || s.state === "starting" || (s.state === "open" && !s.url)) {
    return { ...base, phase: "starting", step: "starting", words: s?.words || `Starting ${agent}'s sign-in on ${machine}…`, tone: "status", busy: true, actions: ["cancel"] };
  }
  switch (s.state) {
    case "open": {
      if (s.method === "device") {
        const code = s.userCode ? { value: s.userCode, confirm: /check it shows this code/i.test(s.words) } : null;
        return { ...base, phase: "open", step: "open-device", words: s.words, tone: "status", url: s.url, code, waiting: "Waiting for you to approve in the browser…", actions: ["cancel"] };
      }
      return {
        ...base,
        phase: "open",
        step: "open-paste",
        words: s.words,
        tone: s.codeRefused ? "alert" : "status",
        url: s.url,
        paste: { ready: s.wantsCode, refused: s.codeRefused, newLink: s.codeRefused && /\bnew sign-in link\b/i.test(s.words) },
        waiting: s.wantsCode ? null : `Waiting for ${agent} to ask for the code…`,
        actions: ["cancel"],
      };
    }
    case "checking":
      return { ...base, phase: "checking", step: "checking", words: s.words, tone: "status", busy: true, actions: ["cancel"] };
    case "done":
      return { ...base, phase: "done", step: "done", words: s.words, tone: "status", next: x.stopped ? "Tap Try again in the chat to carry on." : `Chats on ${agent} can answer again.`, actions: ["done"] };
    case "cancelled":
      return { ...base, phase: "ended", step: "ended", words: s.words, tone: "status", actions: ["close", "again"] };
    default:
      // "failed" and "expired": in the hub's words, with the way on. Never a terminal: the sheet is the way to sign in.
      return { ...base, phase: "ended", step: "ended", words: s.words, tone: "alert", actions: ["close", "again"] };
  }
}

/** A sign-in that couldn't start (or has gone), with the way out each answer leaves. */
function problemView(p: SheetProblem, agent: string, machine: string): SheetView {
  const view = (words: string, actions: SheetAction[]): SheetView => ({ ...base, phase: "problem", step: `problem-${p.code ?? p.status}`, words, tone: "alert", actions });
  const said = sentence(p.message);
  switch (p.code) {
    // Antigravity CLI (or a Muse Code without `muse login`) signs in on a screen of its own: its terminal sign-in.
    case "terminal":
      return view(`${agent} signs in on a screen of its own, so it can't sign in from this sheet. Use its terminal sign-in instead: it runs on ${machine} and shows here.`, ["close", "terminal"]);
    case "not_installed":
    case "not_signin":
      return view(said, ["close", "settings"]);
    case "too_many":
      return view(said, ["close", "retry"]);
    case "gone":
      return view(said, ["close", "again"]);
    case "account":
    case "provider":
    case "person_only":
    case "peer_scope":
      return view(said, ["close"]);
  }
  // A hub from before sign-ins from the phone answers "not found" (no code): its terminal sign-in still works.
  if (p.status === 404) return view(`Crosstalk on ${machine} can't sign agents in from here until it's updated. Use its terminal sign-in instead.`, ["close", "terminal"]);
  if (p.status === 401 || p.status === 403) return view(said, ["close"]);
  // Couldn't reach the hub, or it failed: worth another go.
  return view(`${agent}'s sign-in didn't start: ${said}`, ["close", "retry"]);
}

/** The hub's words, ending as a sentence does. */
const sentence = (text: string) => {
  const t = text.trim() || "Something went wrong.";
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** A code that couldn't be handed to the agent: the hub's words (never the code), and what to do. */
export function codeProblemWords(p: SheetProblem): string {
  if (p.code === "not_waiting") return `${sentence(p.message)} Wait for the box to be ready, then paste it again.`;
  if (p.code === "code") return sentence(p.message);
  return `Couldn't send the code: ${sentence(p.message)} Paste it again and tap Sign in.`;
}

/** What the sheet says when the phone can't read what was copied (no clipboard here, or it wasn't allowed). */
export const PASTE_BY_HAND = "Crosstalk can't read what you copied here. Touch and hold the box, then tap Paste.";

// ---------------------------------------------------------------------------------------------- the chat's note

/**
 * The hub's note in a reply whose agent it started again because its sign-in had gone stale (shared
 * `staleSignInWords`): "Claude Code's sign-in had gone stale in this chat: Crosstalk started it again and it carried
 * on." A chat shows it in the reply, not folded away with the reply's other steps: it's what happened, and that there's
 * nothing to do. Every one of its wordings says the same fixed part (signIn.test.ts checks them all).
 */
export function isStaleSignInNote(a: Pick<Activity, "kind" | "title">): boolean {
  return a.kind === "notice" && /'s sign-in had gone stale in this chat\b/.test(a.title);
}

/** The agent of a need or session in words, falling back to the agent's name for an unknown one. */
export function agentName(p: Provider): string {
  return PROVIDER_INFO[p]?.name ?? "The agent";
}
