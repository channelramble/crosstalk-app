// "Send now" in a chat's status (views/WorkingPanel.tsx): what a message of yours that waits on the agent is really
// waiting for, and the words for it. The hub says why a Send now didn't go (SendNowResult, engine.ts sendNowWhy); the
// limit sentence lives in shared (limitQueuedWords) beside the other limit-wait words, so they all say the same thing.

import { heldWords, limitQueuedWords, type HeldSettings, type Member, type Message, type SendNowResult, type Turn } from "@crosstalk/shared";

/**
 * What your waiting message waits for. "reply": the agent's reply that's running (Send now puts it in), and with `held`,
 * settings you changed that wait for it (and its helpers). "helpers": no reply runs; settings you changed wait for the
 * agent's helpers to finish, and your message with them (`held`: what waits; absent from a hub of 0.6.1 or older;
 * `flowing`: other helpers still work, so what comes after this runs on the settings it started with).
 * "limit": the reply was stopped by a usage limit; nothing can send it sooner, and the reply that carries on reads it
 * first. Send now and Answer now go only while what waits is "settings" (a new model, effort or fast mode, or looser
 * permissions), which the agent as it is may answer around: never around an account switch or tighter permissions.
 */
export type SendNowState = { kind: "reply"; held?: HeldSettings } | { kind: "helpers"; held?: HeldSettings; flowing?: boolean } | { kind: "limit"; wait: NonNullable<Turn["wait"]> };

/**
 * A hub that delivers your messages by itself while an agent's helpers work (HubInfo.messagesFlow), and whether this
 * agent's are at work now (shared helperAtWork). Absent for a hub with "Keep going while helpers work" off, or an older one:
 * it holds them, and only the buttons send them.
 */
export interface MessageFlow {
  helpers: boolean;
}

/** The hub's status detail while new settings wait for an agent's helpers (engine.ts memberChanged; older wording too). */
const HELPERS_DETAIL = /^Finishing helpers before/;

/**
 * All this agent is doing is waiting for its helpers so a change can apply: it says "working", but no reply runs. It doesn't
 * stand in the way of Try again or Answer now under what failed or wasn't answered: its helpers can run for hours, and those
 * are the way on. (The hub then starts that on the process as it is, or holds it where a change mustn't be answered around.
 * With "Keep going while helpers work" off, Try again waits like any message, and the bar then offers Answer now.)
 */
export function onlyFinishingHelpers(member: Pick<Member, "status" | "statusDetail">): boolean {
  return member.status === "working" && HELPERS_DETAIL.test(member.statusDetail ?? "");
}

type MemberLike = Pick<Member, "id" | "status" | "statusDetail" | "readSeq" | "held">;
type TurnLike = Pick<Turn, "memberId" | "status" | "replyMessageId" | "createdAt" | "startedAt" | "wait">;
type MessageLike = Pick<Message, "id" | "authorKind" | "text" | "createdAt" | "seq" | "via">;

/** Messages of yours (not another chat's agent's) for this agent that it hasn't read. Hubs before readSeq: all of them. */
function unreadYours(messages: readonly MessageLike[], readSeq: number | undefined, forThis: (m: MessageLike) => boolean): MessageLike[] {
  return messages.filter((m) => m.authorKind === "human" && !m.via && m.text.trim() && (readSeq === undefined || (m.seq ?? Number.POSITIVE_INFINITY) > readSeq) && forThis(m));
}

/** What waits for the agent's process, if anything, is something it may answer around (a new model and the like). */
const mayGoAround = (member: MemberLike): boolean => !member.held || member.held.change === "settings";

/**
 * What a message of yours waiting on `member` waits for, or null when none is (or nothing true can be said).
 * `forThis`: in a group chat, whether a message is this agent's to answer (one for another agent waits for that one).
 * `flow`: while its helpers work there's no bar for anything the hub delivers by itself, so it isn't "waiting" here: only
 * a change it may not answer around, a usage limit, and a reply the agent owes by itself still say so.
 */
export function sendNowState(member: MemberLike, turns: readonly TurnLike[], messages: readonly MessageLike[], forThis: (m: MessageLike) => boolean = () => true, flow?: MessageFlow): SendNowState | null {
  const mine = turns.filter((t) => t.memberId === member.id);
  if (member.status === "waiting") {
    // Stopped by a usage limit: the hub dropped the turn your message had queued behind that reply, and left the message
    // unread for the reply that carries on. Only one sent while that reply ran counts: the one it was answering is the
    // reply's own, and the waiting line under it already says when it carries on.
    const paused = mine.find((t) => t.status === "waiting" && t.wait);
    if (!paused?.wait) return null;
    const reply = paused.replyMessageId ? messages.find((m) => m.id === paused.replyMessageId) : undefined;
    const since = paused.startedAt ?? paused.createdAt;
    const later = (m: MessageLike) => (reply?.seq !== undefined && m.seq !== undefined ? m.seq > reply.seq : m.createdAt > since);
    return unreadYours(messages, member.readSeq, forThis).some(later) ? { kind: "limit", wait: paused.wait } : null;
  }
  if (!["thinking", "working", "approval"].includes(member.status)) return null;
  if (!mine.some((t) => t.status === "queued")) return null;
  // The queued turn isn't for a message of yours (the agent carrying on with its own work): nothing of yours waits.
  if (member.readSeq !== undefined && !unreadYours(messages, member.readSeq, forThis).length) return null;
  const held = member.held ?? undefined;
  // A reply runs: your message waits for it, and with settings that wait behind it, for them too (Claude Code's own
  // reply as its helpers report back is one: after it, the message still waits for the helpers). While its helpers work
  // the hub has put it into that reply, or sends it as that ends.
  if (mine.some((t) => t.status === "running")) {
    if (flow?.helpers && mayGoAround(member)) return null;
    return held ? { kind: "reply", held } : { kind: "reply" };
  }
  // A hub that delivers it by itself holds nothing for a new model or the like: it starts as soon as it's this agent's turn.
  if (flow && mayGoAround(member) && !held?.owed) return null;
  // Working with no reply running: the hub is holding the next turn until the agent's helpers finish. Anything else
  // (this device hasn't heard the turn start yet) says nothing rather than something untrue.
  if (!held?.helpers && !HELPERS_DETAIL.test(member.statusDetail ?? "")) return null;
  return held ? { kind: "helpers", held, ...(flow?.helpers ? { flowing: true } : {}) } : { kind: "helpers" };
}

/**
 * The message of yours that goes by itself when this agent's reply ends, while its helpers work (a reply that can't take
 * it: no mid-reply form, a summary being made), and the small label on it: all that's said then, with no bar and no
 * button. Null when no message waits that way.
 */
export function quietWait(member: MemberLike, turns: readonly TurnLike[], messages: readonly MessageLike[], forThis: (m: MessageLike) => boolean = () => true, flow?: MessageFlow): string | null {
  if (!flow?.helpers || !mayGoAround(member) || !["thinking", "working", "approval"].includes(member.status)) return null;
  const mine = turns.filter((t) => t.memberId === member.id);
  if (!mine.some((t) => t.status === "queued") || !mine.some((t) => t.status === "running")) return null;
  return unreadYours(messages, member.readSeq, forThis).at(-1)?.id ?? null;
}

/** That label. `who`: in a group chat, whose reply ("@codex"). */
export function quietWaitWords(who?: string): string {
  return who ? `Goes when ${who}'s reply ends.` : "Goes when this reply ends.";
}

/** The line under the chat's status: what your message waits for, what (if anything) can send it now, and how. */
export interface SendNowLine {
  text: string;
  note?: string;
  /** The button, when one can work: "Send now" (into the reply) or "Answer now" (with the settings it started with). */
  action?: "Send now" | "Answer now";
}

export const HELPERS_WORDS = "Your message is waiting for its helpers to finish, so your new settings apply first.";

/** "Your message is waiting for this reply and its helpers to finish, so your account switch applies first." */
function heldLine(what: string, held: HeldSettings | undefined): string {
  return `Your message is waiting for ${what} to finish, so ${heldWords(held?.change ?? "settings")} first.`;
}

/**
 * The agent is about to answer by itself what it owes (HeldSettings.owed), with the settings it started with, while a new
 * model or the like waits: that reply comes first, and yours after it (or into it, with Send now once it runs).
 * `who`: "Claude Code", or "It" where the line sits under the agent's own status. `flowing`: other helpers still work,
 * so the new settings wait for them, and yours doesn't.
 */
function owedLine(who: string, owed: NonNullable<HeldSettings["owed"]>, flowing = false): string {
  const on = flowing ? "" : ", on your new settings";
  return owed === "report" ? `${who} is about to answer its helpers' report by itself. Your message goes after that${on}.` : `${who} is about to answer the message you sent before by itself. This one goes after that${on}.`;
}

export function sendNowLine(state: SendNowState, now = Date.now()): SendNowLine {
  switch (state.kind) {
    case "reply": {
      const held = state.held;
      if (!held) return { text: "Your message is waiting for this reply to finish.", action: "Send now" };
      const text = heldLine(held.helpers ? "this reply and its helpers" : "this reply", held);
      // An account switch or tighter permissions: the reply as it runs never answers a message meant for the new ones.
      return held.change === "settings" ? { text, note: "Send now uses the settings it started with.", action: "Send now" } : { text };
    }
    case "helpers": {
      const held = state.held;
      // Its helpers are done: it's about to answer their report (or a message handed over) by itself, a reply that comes
      // first whatever is tapped, so nothing is offered until it runs (then Send now puts your message into it).
      if (held?.owed && held.change === "settings") return { text: owedLine("It", held.owed, state.flowing) };
      // Under anything else that reply is stopped as it starts, and the agent starts again with the change.
      if (held?.owed === "message") return { text: `Your message is waiting while it starts again, so ${heldWords(held.change)} first.` };
      // Answer now only on a hub that holds such a message and takes it, with "Keep going while helpers work" off (a hub that
      // delivers it by itself never gets here: sendNowState; one of 0.6.1 or older doesn't say what waits).
      if (held?.change === "settings") return { text: HELPERS_WORDS, note: "Answer now uses the settings it started with.", action: "Answer now" };
      return { text: held ? heldLine("its helpers", held) : HELPERS_WORDS };
    }
    case "limit":
      return { text: limitQueuedWords(state.wait, now) };
  }
}

/** The same line for an agent that can't take a message in the middle of a reply: what it waits for, with no button that can't work. */
export function noSendNow(line: SendNowLine): SendNowLine {
  return line.action === "Send now" ? { text: line.text } : line;
}

/**
 * Why a Send now didn't go, as the hub said it (`who`: "Claude Code", or "@codex" in a group chat). An older hub says
 * only that it didn't: then the words claim nothing they can't know.
 */
export function sendNowWords(r: SendNowResult, who: string, now = Date.now()): string {
  switch (r.why) {
    case "limit":
      return limitQueuedWords(r.wait ?? { kind: "usage", resetsAt: null }, now);
    case "helpers":
      return r.held ? heldLine("its helpers", r.held) : HELPERS_WORDS;
    case "settings":
      return heldLine(r.held?.helpers ? "this reply and its helpers" : "this reply", r.held ?? { change: "other", helpers: false });
    case "notYet":
      return `${who} can't take it yet. Try Send now again in a moment.`;
    case "ownTurn":
      return owedLine(who, r.held?.owed ?? "report");
    case "answering":
      return `${who} is already answering your message.`;
    case "nothing":
      return `Nothing of yours is waiting for ${who}.`;
    case "ended":
      return "That reply just ended. Your message starts the next one.";
    case "unsupported":
      return `${who} can't take a message in the middle of a reply. Yours goes as soon as this one ends.`;
    default:
      return "Couldn't send it now. Your message still waits its turn.";
  }
}
