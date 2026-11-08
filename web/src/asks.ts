// Ask others, the phone side (docs/SPEC-0.4.md, track T2): the logic behind the sheet, the cards and the @ popup.
// Pure on purpose (no React, no network, no store): web unit tests have no DOM (asks.test.ts).

import { EFFORT_LABELS, type Ask, type AskChoice, type AskMachineNote, type AskMemo, type AskModel, type AskStatus, type AskTarget, type Message } from "@crosstalk/shared";
import { costLabel, usd } from "./money";

const byCreated = (a: Ask, b: Ask) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** Asks grouped by the message they're about, each group oldest first (a new card goes after the others). */
export function asksByMessage(asks: readonly Ask[]): Map<string, Ask[]> {
  const out = new Map<string, Ask[]>();
  for (const a of [...asks].sort(byCreated)) {
    const list = out.get(a.messageId);
    if (list) list.push(a);
    else out.set(a.messageId, [a]);
  }
  return out;
}

// ---- keeping the list in step ------------------------------------------------------------------------------------

/** How far along an ask is: a copy that's further along is never replaced by an older one. */
const PROGRESS: Record<AskStatus, number> = { queued: 0, running: 1, done: 2, error: 2, stopped: 2 };

/**
 * `list` with `incoming` in it: a new ask goes in, a known one is replaced unless the copy held is further along (the
 * answer to a request can arrive after the live event that already says it's done).
 */
export function upsertAsks(list: readonly Ask[], incoming: readonly Ask[]): Ask[] {
  const out = [...list];
  for (const a of incoming) {
    const at = out.findIndex((x) => x.id === a.id);
    if (at < 0) out.push(a);
    else if (PROGRESS[a.status] >= PROGRESS[out[at].status]) out[at] = a;
  }
  return out.sort(byCreated);
}

/**
 * A chat's asks as the hub lists them, with what live events said while the list was on its way: an ask an event
 * touched (new, changed or removed) keeps what the event made of it, the rest is the hub's word (so an ask removed on
 * another device while this one was asleep is gone).
 */
export function mergeAsks(current: readonly Ask[], loaded: readonly Ask[], touched: ReadonlySet<string>): Ask[] {
  return [...loaded.filter((a) => !touched.has(a.id)), ...current.filter((a) => touched.has(a.id))].sort(byCreated);
}

// ---- the cards ---------------------------------------------------------------------------------------------------

/** How long an ask took: "12 s", "1 min 5 s", "2 min". */
export function askDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

/** Who answered, without the model: "Codex" from "Codex · GPT-5.5". */
export function askAgentName(ask: Pick<Ask, "label">): string {
  return ask.label.split(" · ")[0].trim() || ask.label;
}

export interface AskCardText {
  state: "waiting" | "reading" | "done" | "error" | "stopped";
  /** "Waiting…", "Reading…" or "Stopped": where a card is, in words (nothing once it has answered or failed). */
  status: string | null;
  /** Why it failed, in the hub's own sentence ("Codex couldn't answer: Rate limited."), shown as it is. */
  problem: string | null;
  /** "$0.04 · 12 s", "Plan · 12 s", "Free · 12 s": what it cost and how long it took, once it's over. */
  cost: string | null;
  /** The answer as the other agent wrote it (what has come in, when it was stopped), or null. */
  answer: string | null;
}

export function askCardText(ask: Ask): AskCardText {
  const over = ask.status === "done" || ask.status === "error" || ask.status === "stopped";
  const money = ask.cost ? costLabel(ask.cost.costUsd, ask.cost.basis) : null;
  const took = over && ask.startedAt !== null && ask.endedAt !== null ? askDuration(ask.endedAt - ask.startedAt) : null;
  // The hub stores the whole sentence ("Codex couldn't answer: Rate limited.", "Codex took longer than 3 minutes, so
  // Crosstalk stopped it."): it is shown as given, never wrapped in "couldn't answer" again.
  const problem = ask.error?.trim() || `${askAgentName(ask)} couldn't answer: something went wrong.`;
  return {
    state: ask.status === "queued" ? "waiting" : ask.status === "running" ? "reading" : ask.status,
    status: ask.status === "queued" ? "Waiting…" : ask.status === "running" ? "Reading…" : ask.status === "stopped" ? "Stopped" : null,
    problem: ask.status === "error" ? problem : null,
    cost: over ? [money, took].filter(Boolean).join(" · ") || null : null,
    answer: ask.answer?.trim() ? ask.answer : null,
  };
}

/** What a card offers: Stop while it works, Try again on an error, Send and Copy when there's an answer, Remove when it's over. */
export function askActions(ask: Ask): { stop: boolean; retry: boolean; send: boolean; copy: boolean; remove: boolean } {
  const working = ask.status === "queued" || ask.status === "running";
  const answered = !working && !!ask.answer?.trim();
  return { stop: working, retry: ask.status === "error", send: answered, copy: answered, remove: !working };
}

/** What "Send to the chat" puts in the message box: the answer as a quote, then a blank line to write under it. */
export function quotedAnswer(ask: Pick<Ask, "label" | "answer">): string {
  const lines = (ask.answer ?? "").trim().split("\n").map((l) => l.trimEnd());
  return lines.map((l, i) => (i === 0 ? `> ${askAgentName(ask)}'s answer: ${l}` : l ? `> ${l}` : ">")).join("\n") + "\n\n";
}

/** The message box's text with a quote added after what's already written (a blank line between). */
export function insertQuote(draft: string, quote: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${quote}` : quote;
}

// ---- the sheet and the @ popup -----------------------------------------------------------------------------------

/** One row's identity: the same account and model on two machines are two rows (an account's name is the machine's own). */
export const askTargetKey = (t: AskTarget) => [t.provider, t.account, t.model ?? "", t.effort ?? "", ...(t.machine ? [t.machine] : [])].join("|");

/** Who can be asked first, who can't (greyed, with why) after; the hub's order within each. */
export function sortChoices(choices: readonly AskChoice[]): AskChoice[] {
  return [...choices.filter((c) => c.available), ...choices.filter((c) => !c.available)];
}

/** A machine's name inside a sentence: "the PC", "the Mac mini", but "Anna's laptop" as it is (as the hub says it). */
export const theMachine = (name: string) => (/^the\s/i.test(name) || /['’]s\b/.test(name) ? name : `the ${name}`);

/** What GET /api/asks/targets says: a plain list (a hub from before 0.5, or asked without ?machines=1) or the list and the machines that couldn't say. */
export function readTargets(data: unknown): { choices: AskChoice[]; machines: AskMachineNote[] } {
  if (Array.isArray(data)) return { choices: data as AskChoice[], machines: [] };
  const d = (data ?? {}) as { choices?: unknown; machines?: unknown };
  return { choices: Array.isArray(d.choices) ? (d.choices as AskChoice[]) : [], machines: Array.isArray(d.machines) ? (d.machines as AskMachineNote[]) : [] };
}

/**
 * The list just read, with the rows a machine that didn't answer this time had in the list before kept, greyed and with the line
 * it gave. A draft that already names one of them (@qwen3-on-pc) must stay blocked: with the rows missing from the list the name
 * would be text for the chat's own agent, and the question would be asked of the wrong one. A machine that answered, or that
 * `machines` doesn't name (it's gone), is as the answer says.
 */
export function keepSilentMachines(before: readonly AskChoice[] | null, now: readonly AskChoice[], machines: readonly AskMachineNote[]): AskChoice[] {
  if (!before || !machines.length) return [...now];
  const why = new Map(machines.map((m) => [m.id, m.why] as const));
  const answered = new Set(now.flatMap((c) => (c.machine ? [c.machine.id] : [])));
  const kept = before.filter((c) => c.machine && why.has(c.machine.id) && !answered.has(c.machine.id)).map((c) => ({ ...c, available: false, why: why.get(c.machine!.id)! }));
  return [...now, ...kept];
}

/** The sheet's rows under one heading: where they run, and (for a machine that couldn't say) the line that says so. */
export interface AskGroup {
  key: string;
  /** "On this machine", "On the PC"; null while everything is on this machine (no headings then). */
  heading: string | null;
  rows: AskChoice[];
  note: AskMachineNote | null;
}

/**
 * The sheet's rows grouped by where they run: this machine first, then each other machine in the order the hub gave them,
 * each under its own heading with who can be asked first and who can't (greyed) after. A machine that couldn't say shows once
 * as a line under its heading. No headings at all while nothing runs anywhere else.
 */
export function askGroups(choices: readonly AskChoice[], machines: readonly AskMachineNote[] = []): AskGroup[] {
  const others: { id: string; name: string }[] = [];
  for (const c of choices) if (c.machine && !others.some((m) => m.id === c.machine!.id)) others.push(c.machine);
  for (const n of machines) if (!others.some((m) => m.id === n.id)) others.push({ id: n.id, name: n.name });
  const here = sortChoices(choices.filter((c) => !c.machine));
  if (!others.length) return [{ key: "here", heading: null, rows: here, note: null }];
  const groups: AskGroup[] = here.length ? [{ key: "here", heading: "On this machine", rows: here, note: null }] : [];
  for (const m of others) groups.push({ key: m.id, heading: `On ${theMachine(m.name)}`, rows: sortChoices(choices.filter((c) => c.machine?.id === m.id)), note: machines.find((n) => n.id === m.id) ?? null });
  return groups;
}

/** The two badges on a row: what it costs (Costs money, Uses your plan, Free) and where it runs (Online, On this machine, On another of your machines). */
export function askBadges(c: Pick<AskChoice, "paid" | "local" | "machine">): { cost: string; kind: "paid" | "plan" | "free" | "unknown"; where: string } {
  const where = c.machine ? "On another of your machines" : c.local ? "On this machine" : "Online";
  if (c.paid === "yes") return { cost: "Costs money", kind: "paid", where };
  if (c.local) return { cost: "Free", kind: "free", where };
  if (c.paid === "no") return { cost: "Uses your plan", kind: "plan", where };
  return { cost: "Cost unknown", kind: "unknown", where };
}

/** What the hub's `sub` says when all it knows is the kind of sign-in or where a model runs: the badges say that already. */
const BADGE_WORDS = new Set(["api key", "plan", "online", "on this mac", "on this machine", "free", "local", "costs money", "uses your plan", "cost unknown"]);

/** The line under a row's name: the hub's `sub`, unless it only repeats what the badges say (then null). */
export function askRowSub(c: Pick<AskChoice, "sub">): string | null {
  const sub = (c.sub ?? "").trim();
  return sub && !BADGE_WORDS.has(sub.toLowerCase().replace(/[.\s]+$/, "")) ? sub : null;
}

/** The line under the list when someone picked costs money: "Costs money: about $0.10" (from what their asks usually cost). */
export function askCostHint(chosen: readonly AskChoice[]): string | null {
  const priced = chosen.filter((c) => c.paid !== "no" && !(c.local && c.paid !== "yes"));
  if (!priced.length) return null;
  const known = priced.filter((c) => c.typicalCostUsd !== null);
  const sum = known.reduce((n, c) => n + (c.typicalCostUsd ?? 0), 0);
  if (known.length === priced.length) return `Costs money: about ${usd(sum)}`;
  if (known.length) return `Costs money: about ${usd(sum)} or more`;
  return priced.some((c) => c.paid === "yes") ? "Costs money. We can't guess how much yet." : "This might cost money. We can't tell yet.";
}

/** The chat's own agent, as the hub knows its target. */
export interface OwnAgent {
  provider: string;
  account: string;
  model: string | null;
}

/** Whether a choice is the agent the chat is already with (same agent and account, and the same model or none named; one on another machine never is). */
export function isOwnAgent(target: AskTarget, own: OwnAgent | null | undefined): boolean {
  return !!own && !target.machine && target.provider === own.provider && target.account === own.account && (target.model === null || target.model === own.model);
}

/** What the @ popup lists for what's typed after the @: matches of the handle (from its start) or the name, the chat's own agent left out. */
export function mentionCandidates(choices: readonly AskChoice[], query: string, own: OwnAgent | null | undefined, limit = 8): AskChoice[] {
  const q = query.toLowerCase();
  const rows = choices.filter((c) => !isOwnAgent(c.target, own) && (c.handle.toLowerCase().startsWith(q) || c.label.toLowerCase().includes(q)));
  return sortChoices(rows).slice(0, limit);
}

/** The draft with code and quoted lines blanked out (same length, so places still line up): an @name there isn't a mention. */
function plainText(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank).replace(/^[ \t]*>.*$/gm, blank);
}

/** Whether a draft has an `@name` in it (not in code or a quote): all that can be told before the list of who can be asked is here. */
export function hasMention(draft: string): boolean {
  return /(^|\s)@\w/.test(plainText(draft));
}

export interface Mention {
  choice: AskChoice;
  /** Where the "@" is, and where the name ends. */
  start: number;
  end: number;
}

/** Every `@handle` in a draft that names one of `choices` (not in code or a quote; "@codex." at a sentence's end counts). */
export function mentionsIn(draft: string, choices: readonly AskChoice[]): Mention[] {
  const byHandle = new Map(choices.map((c) => [c.handle.toLowerCase(), c] as const));
  const out: Mention[] = [];
  for (const m of plainText(draft).matchAll(/(^|\s)@([\w.-]+)/g)) {
    const start = (m.index ?? 0) + m[1].length;
    let name = m[2];
    while (name && !byHandle.has(name.toLowerCase()) && /[.-]$/.test(name)) name = name.slice(0, -1);
    const choice = byHandle.get(name.toLowerCase());
    if (choice) out.push({ choice, start, end: start + 1 + name.length });
  }
  return out;
}

/** The choices a draft names, each once, in the order written: who will chime in once it's sent. */
export function mentionedChoices(draft: string, choices: readonly AskChoice[]): AskChoice[] {
  return [...new Set(mentionsIn(draft, choices).map((m) => m.choice))];
}

/** The draft without that choice's `@handle` (and one space beside each): what the chip's × does. */
export function withoutMention(draft: string, choice: AskChoice, choices: readonly AskChoice[]): string {
  let out = draft;
  for (const m of mentionsIn(draft, choices).filter((x) => x.choice === choice).reverse()) {
    let { start, end } = m;
    if (out[end] === " ") end++;
    else if (out[start - 1] === " ") start--;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** A chip above the message box: who will chime in, or why someone can't. */
export function chipText(c: Pick<AskChoice, "label" | "available" | "why">): string {
  return c.available ? `${c.label} will chime in` : `${c.label} can't chime in: ${c.why ?? "not available right now"}`;
}

/** Where the chat goes when someone is asked, in the same words wherever it is said: the sheet's footer and the @ chip row. */
export const ASK_PRIVACY_LINE = "This sends the chat so far to each one you pick. Models on this machine stay here.";
/** Said as well once someone on another of your machines is picked: the chat goes there over the link you made between them. */
export const ASK_OTHER_MACHINES_LINE = "Ones on your other machines get it over your own link.";
/** The privacy line for who's picked (the sheet's footer, the @ chip row): the other machines' sentence only when one of them is. */
export const askPrivacyLine = (picked: readonly Pick<AskChoice, "machine">[]) => (picked.some((c) => c.machine) ? `${ASK_PRIVACY_LINE} ${ASK_OTHER_MACHINES_LINE}` : ASK_PRIVACY_LINE);

/**
 * The line in the chip row (the sheet's footer, for the @ path): there every time the message will ask someone, whether
 * they are online or a model on this machine (the line says those stay). A chip that can't chime in is sent nothing, so
 * a row of only those has no line.
 */
export function askChipNote(chips: readonly Pick<AskChoice, "available" | "machine">[]): string | null {
  const who = chips.filter((c) => c.available);
  return who.length ? askPrivacyLine(who) : null;
}

// ---- what Send does with a draft ---------------------------------------------------------------------------------

/** The longest question the hub keeps (NOTE_MAX in hub/src/asks.ts): a longer draft is never cut short without a word. */
export const ASK_NOTE_MAX = 2_000;

/** A way out under a notice: take the @names off the draft, send it to the chat anyway, look up who can be asked again. */
export type SendAction = "take-off" | "as-is" | "retry";

/**
 * What Send does with a draft. A draft that names other agents never reaches the chat's own agent: it asks them
 * (`ask`), waits for the list of who can be asked (`wait`), or says why it can't and sends nothing (`blocked`, with
 * `actions` for the way out). `chat` is every draft that names nobody else.
 */
export type SendPlan =
  | { kind: "chat" }
  | { kind: "ask"; messageId: string; targets: AskTarget[]; note: string | null }
  | { kind: "wait" }
  | { kind: "blocked"; reason: string; actions: SendAction[] };

type PlanMessage = Pick<Message, "id" | "authorKind" | "status" | "text" | "via" | "createdAt">;

export interface SendInput {
  text: string;
  /** Who the draft names that the list of who can be asked knows (`mentionedChoices`), the ones that can't be asked too. */
  chips: readonly AskChoice[];
  /** The draft has an @name in it (`hasMention`): all that can be told before the list is here. */
  typed: boolean;
  /** The list of who can be asked: here, on its way, or couldn't be had. */
  choices: "ready" | "loading" | "failed";
  /** The chat's messages, oldest first; null while they haven't loaded. */
  messages: readonly PlanMessage[] | null;
  /** Files and folders attached to the draft. */
  attachments: number;
  /** Your messages older than this were copied into a duplicated chat (`copiedUntil`): they show no answer cards. */
  copiedBefore?: number;
}

/** When a duplicated chat's copied messages end (0 for a chat that isn't a copy). ChatScreen tells copies the same way. */
export function copiedUntil(messages: readonly Pick<Message, "copy" | "createdAt">[], chatCreatedAt: number, hasMore: boolean): number {
  const copied = messages.some((m) => m.copy?.kind === "from") || (hasMore && (messages[0]?.createdAt ?? Infinity) < chatCreatedAt);
  return copied ? chatCreatedAt : 0;
}

/**
 * The newest message others can be asked about: the hub's rule (`askable`: yours, or an agent's finished reply, with some
 * text) and one that shows its answer cards (not another chat's relayed message, not one copied in); system notes are
 * skipped. "writing" when the newest message is a reply still being written; null when there is nothing.
 */
function askedAbout(messages: readonly PlanMessage[], copiedBefore: number): { id: string } | "writing" | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.authorKind === "system") continue;
    if (m.status === "streaming") return "writing";
    const askable = m.authorKind === "human" ? !m.via && m.createdAt >= copiedBefore : m.status === "done" || m.status === "stopped";
    if (askable && m.text.trim()) return { id: m.id };
  }
  return null;
}

/** The draft without any of these choices' @handles. */
export function withoutMentions(draft: string, choices: readonly AskChoice[]): string {
  return choices.reduce((text, c) => withoutMention(text, c, choices), draft);
}

/** "Opus 5.5" from "Claude Code · Opus 5.5": the model without the agent in front of it (the whole label when it has no model). */
function askModelName(label: string): string {
  const at = label.indexOf(" · ");
  return (at < 0 ? "" : label.slice(at + 3).trim()) || label;
}

/**
 * Each one's short name: "Codex" from "Codex · GPT-5.5", the whole label for the ones that would read alike. Another model
 * of the chat's own agent ("Claude Code · Opus 5.5" in a Claude Code chat) is its model, "Opus 5.5": the short name would be
 * the chat's own, and a line would say "Only Claude Code will answer. Claude Code won't see this."
 */
export function askNames(chosen: readonly Pick<AskChoice, "label" | "machine">[], ownName: string | null = null): string[] {
  const own = ownName?.trim().toLowerCase();
  const short = chosen.map((c) => {
    const agent = askAgentName(c);
    // One on another machine says where ("Qwen3 on the PC"); it is never the chat's own agent, whatever it's called.
    if (c.machine) return `${agent} on ${theMachine(c.machine.name)}`;
    return own && agent.toLowerCase() === own ? askModelName(c.label) : agent;
  });
  return chosen.map((c, i) => (short.indexOf(short[i]) === short.lastIndexOf(short[i]) ? short[i] : c.label));
}

const listed = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

const block = (reason: string, ...actions: SendAction[]): SendPlan => ({ kind: "blocked", reason, actions });

export function sendPlan(i: SendInput): SendPlan {
  const { chips } = i;
  if (!chips.length) {
    // Nobody else is named: a normal message. An @name that only looks like one (an email address, `@types/react`)
    // is text. But while the list that tells them apart isn't here, nothing goes to the chat's agent.
    if (!i.typed || i.choices === "ready") return { kind: "chat" };
    return i.choices === "loading" ? { kind: "wait" } : block("Couldn't check who you can ask.", "retry", "as-is");
  }
  const who = chips.filter((c) => c.available);
  // Each chip already says why that one can't be asked.
  if (!who.length) return block("Nobody you named can be asked right now.", "take-off", "as-is");
  if (i.attachments > 0) return block("Other agents can't see attachments yet. Take off the files or the @names.", "take-off", "as-is");
  if (!i.messages) return block("This chat is still loading. Ask again in a moment.", "take-off", "as-is");
  const about = askedAbout(i.messages, i.copiedBefore ?? 0);
  if (about === "writing") return block("That reply is still being written. Ask again when it's done.", "take-off", "as-is");
  // The @names as they were typed (the handles), not the names the chips and the button use: "Take off @names" takes these off.
  if (!about) return block(`There's nothing in this chat to ask about yet. Send a message first, or take off ${listed(chips.map((c) => `@${c.handle}`))}.`, "take-off", "as-is");
  // What's left of the draft is the question (the hub asks its own when there is none: a name and a full stop is none).
  const note = withoutMentions(i.text, chips).replace(/^[\s,;:]+/, "").trim();
  if (note.length > ASK_NOTE_MAX) return block(`That's too long to ask others (${ASK_NOTE_MAX.toLocaleString("en-US")} characters at most). Shorten it, or send it to the chat as it is.`, "as-is");
  return { kind: "ask", messageId: about.id, targets: who.map((c) => c.target), note: /[\p{L}\p{N}]/u.test(note) ? note : null };
}

/** What the chip row says about where a draft that names someone goes ("Only Codex will answer. Claude Code won't see this."); null when nobody can be asked. */
export function askOnlyLine(chips: readonly AskChoice[], ownName: string | null): string | null {
  const who = chips.filter((c) => c.available);
  return who.length ? `Only ${listed(askNames(who, ownName))} will answer. ${ownName ?? "This chat's agent"} won't see this.` : null;
}

/** A label without the machine's name at its end: "Claude Code · Opus 5.5" from "Claude Code · Opus 5.5 · on the PC". */
function withoutMachine(c: Pick<AskChoice, "label" | "machine">): string {
  const tail = c.machine ? ` · on ${theMachine(c.machine.name)}` : "";
  return tail && c.label.endsWith(tail) ? c.label.slice(0, -tail.length) : c.label;
}

/**
 * The send button's words while the draft names someone: "Ask Codex", or "Ask 2". Null when nobody can be asked (it stays "Send").
 * Short on purpose: a phone's button has little room, and a machine's name cut off in the middle reads as nothing. One on another
 * machine is named as one here ("Ask Qwen3"); where it runs is in the chip row and in the button's accessible name (`askButtonName`).
 */
export function askButtonLabel(chips: readonly AskChoice[], ownName: string | null = null): string | null {
  const who = chips.filter((c) => c.available);
  if (who.length !== 1) return who.length ? `Ask ${who.length}` : null;
  const [one] = who;
  if (!one.machine) return `Ask ${askNames(who, ownName)[0]}`;
  // The chat's own kind of agent on another machine would read as the chat's own agent on a button: its model names it (as it does for another model of the chat's own agent here).
  const agent = askAgentName(one);
  return `Ask ${agent.toLowerCase() === ownName?.trim().toLowerCase() ? askModelName(withoutMachine(one)) : agent}`;
}

/** The same in full, for the button's accessible name and tooltip: "Ask Qwen3 on the PC". */
export function askButtonName(chips: readonly AskChoice[], ownName: string | null = null): string | null {
  const who = chips.filter((c) => c.available);
  return !who.length ? null : who.length === 1 ? `Ask ${askNames(who, ownName)[0]}` : `Ask ${who.length}`;
}

/**
 * What the message box holds once its draft was asked: what was typed or dictated after the draft meanwhile stays, the
 * draft goes. A browser that committed an autocorrection to the draft's last word meanwhile still counts as that draft
 * (it must not stay behind to be asked twice); a box edited in any other way is the person's and is never cut.
 */
export function afterAsked(now: string, draft: string): string {
  if (now.startsWith(draft)) return now.slice(draft.length).trimStart();
  const stable = draft.trimEnd().replace(/\S+$/, "");
  if (stable.trim() && now.startsWith(stable)) return now.slice(stable.length).replace(/^\S*/, "").trimStart();
  return now;
}

// ---- when asking fails -------------------------------------------------------------------------------------------

/** A failed request in plain words, and which Settings button helps (the hub's own words win when it has some). */
export function askProblem(e: unknown): { text: string; fix: "limit" | "signin" | null } {
  const err = (e ?? {}) as { status?: number; code?: string; message?: string };
  const message = typeof err.message === "string" ? err.message.trim() : String(e);
  const generic = !message || /^request failed \(\d+\)$/i.test(message);
  if (err.status === 404 && (generic || /^not found\.?$/i.test(message))) return { text: "This hub can't do that yet. Update the hub on your computer, then try again.", fix: null };
  switch (err.code) {
    case "budget":
      return { text: generic ? "That one reached its spending limit, so it can't answer. Raise the limit, or pick someone else." : message, fix: "limit" };
    case "not_signed_in":
      return { text: generic ? "That one isn't signed in. Sign in from Settings, then try again." : message, fix: "signin" };
    case "busy":
      return { text: generic ? "That one is busy right now. Try again in a moment, or pick someone else." : message, fix: null };
    case "model_choice":
      return { text: generic ? "Choose a model for that one first, then try again." : message, fix: null };
  }
  return { text: generic ? "Couldn't ask. Check your connection, then try again." : message, fix: null };
}

// ---- picking the model (newer than 0.6.1) -----------------------------------------------------------------------------------

/**
 * A row of the sheet, whichever model is picked for it: the agent, the account and the machine. (The hub lists one row per
 * account, so this stays the same while the model changes; `askTargetKey` doesn't.)
 */
export const askRowKey = (t: Pick<AskTarget, "provider" | "account" | "machine">) => [t.provider, t.account, ...(t.machine ? [t.machine] : [])].join("|");

/** What a row's picker holds: a model and an effort, each "" for its default (the empty choice the model picker starts with). */
export interface AskModelPick {
  model: string;
  effort: string;
}

/** The pick a row opens on: the one the person last made for it (the hub keeps it, and has the row on it already), else the defaults. */
export function initialPick(c: Pick<AskChoice, "remembered">): AskModelPick {
  return { model: c.remembered?.model ?? "", effort: c.remembered?.effort ?? "" };
}

/** The models a row's picker offers; null when there's nothing to pick (it can't be asked, its model is fixed, or it has one model and no effort levels). */
export function pickableModels(c: Pick<AskChoice, "models" | "available" | "fixedModel">): AskModel[] | null {
  const models = c.available && !c.fixedModel ? (c.models ?? []) : [];
  return models.length > 1 || models.some((m) => m.efforts.length > 0) ? models : null;
}

/** The model a pick stands for: the one picked, else the row's default (the one its list marks, as the hub picks it). */
export function pickedModel(c: Pick<AskChoice, "models" | "target">, pick: AskModelPick | undefined): AskModel | undefined {
  const models = c.models ?? [];
  const named = (id: string) => models.find((m) => m.id === id || m.resolvedModel === id);
  if (pick?.model) return named(pick.model);
  return models.find((m) => m.isDefault) ?? (c.target.model ? named(c.target.model) : undefined);
}

/** A pick the picker just made: an effort the newly picked model doesn't take goes back to that model's default. */
export function nextPick(c: Pick<AskChoice, "models" | "target">, pick: AskModelPick): AskModelPick {
  const m = pickedModel(c, pick);
  return pick.effort && !m?.efforts.includes(pick.effort) ? { ...pick, effort: "" } : pick;
}

/** "Codex · GPT-5.4" from "Codex · GPT-5.5" and another of its models (the machine stays at the end: "… · on the PC"). */
function labelWithModel(c: Pick<AskChoice, "label" | "machine">, model: string): string {
  const tail = c.machine ? ` · on ${theMachine(c.machine.name)}` : "";
  return `${askAgentName({ label: withoutMachine(c) })} · ${model}${tail}`;
}

/**
 * The row as it will be asked with this pick: its target names the model and effort (so the hub, the card and the costs say
 * which), its name says the model, and what it costs is that model's. A row the picker doesn't cover (an older hub's, a fixed
 * model) is asked exactly as the hub listed it.
 */
export function withPick(c: AskChoice, pick: AskModelPick | undefined): AskChoice {
  if (!pick || c.fixedModel || !c.models?.length) return c;
  const m = pickedModel(c, pick);
  if (!m) return c;
  const effort = pick.effort && m.efforts.includes(pick.effort) ? pick.effort : (m.defaultEffort ?? null);
  return { ...c, target: { ...c.target, model: m.id, effort }, label: labelWithModel(c, m.label), paid: m.paid, typicalCostUsd: m.typicalCostUsd };
}

/**
 * What the sheet asks the hub to keep for next time for a row it asks (null model or effort: the default); null for a row with no
 * picker. Only a pick the person made in this sheet (`changed`) or the kept one the row opened on (`remembered`) is sent: a row that
 * opened on its default because its kept model is missing from its list for now (an update dropped it, Claude Code checks it
 * again) is asked on the default without forgetting that pick.
 */
export function askMemo(c: AskChoice, pick: AskModelPick | undefined, changed: boolean): AskMemo | null {
  if (!pick || c.fixedModel || !c.models?.length || (!changed && !c.remembered)) return null;
  return { provider: c.target.provider, account: c.target.account, ...(c.target.machine ? { machine: c.target.machine } : {}), model: pick.model || null, effort: pick.effort || null };
}

/** Who a row's picker is for, said short: "Codex", "Kimi", "Claude Code on the PC". */
export function askPickerFor(c: Pick<AskChoice, "label" | "machine">): string {
  const agent = askAgentName({ label: withoutMachine(c) });
  return c.machine ? `${agent} on ${theMachine(c.machine.name)}` : agent;
}

/** Why a row's model can't be picked here, in plain words with where to change it; null when it can (or nothing says). */
export function fixedModelLine(c: Pick<AskChoice, "fixedModel" | "machine">): string | null {
  const there = c.machine ? ` on ${theMachine(c.machine.name)}` : "";
  if (c.fixedModel === "pool") return `The model pool runs one model at a time. To ask another, change it in Settings → Model pool${there}.`;
  if (c.fixedModel === "update") {
    const machine = theMachine(c.machine?.name ?? "that machine");
    return `To pick its model from here, update Crosstalk on ${machine}. Until then it answers with the model ${machine} uses.`;
  }
  return null;
}

/** What an ask on the picked model usually costs, under its picker: only a figure that is money (a plan's or a model here isn't), from earlier asks. */
export function askModelCostLine(m: Pick<AskModel, "paid" | "typicalCostUsd" | "label"> | undefined, local = false): string | null {
  if (!m || m.paid === "no" || (local && m.paid !== "yes") || m.typicalCostUsd === null) return null;
  return `Asks on ${m.label} have cost about ${usd(m.typicalCostUsd)} each.`;
}

/** The effort an ask ran at, for its card ("High effort"); null when none was set (the agent's own default). */
export function askEffortWords(ask: Pick<Ask, "target">): string | null {
  const e = ask.target.effort;
  return e ? `${EFFORT_LABELS[e] ?? e} effort` : null;
}
