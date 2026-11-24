// Group chats, the phone side: several agents in one chat, each with its own account, model and effort. Who answers a
// draft (as the hub will route it: Engine.postHumanMessage), the turn order, and the words the chat screen says them in.
// Pure on purpose (no React, no store): groupChat.test.ts.

import { CHAT_PROVIDERS, groupAnswers, isGroupChat, isServiceOnlyAgent, parseMentions, PROVIDER_INFO, settingsPath, slugHandle, turnOrder, type AgentAccount, type ChatProvider, type GroupAnswers, type Member, type Message, type Provider, type Room, type Turn } from "@crosstalk/shared";
import { accountDescription } from "./accounts";
import { serviceWhere, serviceWhereWords, type ServiceWhere } from "./chatIdentity";

export { isGroupChat };

/** Who answers a draft in a group chat, and why. */
export interface Answering {
  /** Who answers, in the order they will. */
  who: Member[];
  /**
   * "named": the draft @mentions them, so only they answer; "all": it says @all or @everyone. Otherwise the chat's own
   * choice for a message that names nobody: the lead answers, everyone in turn, or the lead builds and the next checks it.
   */
  how: "named" | "all" | GroupAnswers;
}

type RoomRoute = Pick<Room, "mode" | "leadMemberId">;

/** Who answers this draft: the agents it @mentions (outside code), else whoever the chat says answers a message to nobody. */
export function whoAnswers(room: RoomRoute, members: readonly Member[], draft: string): Answering {
  const handles = parseMentions(draft);
  if (handles.some((h) => h === "all" || h === "everyone")) return { who: turnOrder(room, members), how: "all" };
  const named: Member[] = [];
  for (const h of handles) {
    const m = members.find((x) => x.handle.toLowerCase() === h);
    if (m && !named.includes(m)) named.push(m);
  }
  if (named.length) return { who: named, how: "named" };
  const how = groupAnswers(room.mode);
  const order = turnOrder(room, members);
  // Build & review: the lead builds, the next agent checks its work.
  return { who: how === "turns" ? order : how === "review" ? order.slice(0, 2) : order.slice(0, 1), how };
}

const at = (m: Pick<Member, "handle">) => `@${m.handle}`;
const listed = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const inTurn = (names: readonly string[]) => names.join(", then ");

/** A group chat's agents by name: "@claude and @codex". */
export function groupNames(members: readonly Pick<Member, "handle">[]): string {
  return listed(members.map(at));
}

/**
 * The line above the message box: who answers what you're writing, and in what order. Said every time, so the chat's
 * own choice (the lead, everyone in turn) is never a surprise, and an @mention says it changes that.
 */
export function answersLine(a: Answering): string {
  if (!a.who.length) return "No agents in this chat yet. Add one in the chat's settings.";
  const names = a.who.map(at);
  switch (a.how) {
    case "named":
      return `Only ${listed(names)} will answer. The others read it when they next reply.`;
    case "all":
    case "turns":
      return a.who.length > 1 ? `Everyone answers, in turn: ${inTurn(names)}.` : `${names[0]} answers.`;
    case "review":
      return a.who.length > 1 ? `${names[0]} builds it, then ${names[1]} reviews it.` : `${names[0]} builds it. Add another agent to review its work.`;
    case "lead":
      return `${names[0]} answers. Type @ to pick who answers.`;
  }
}

/**
 * The send button's words when the draft says who answers: "Send to @codex", "Send to 2", "Send to all". Null when the
 * chat's own choice answers (the plain Send arrow). Short on purpose: the chip row above says it in full.
 */
export function sendLabel(a: Answering): string | null {
  if (a.how === "all") return "Send to all";
  if (a.how !== "named") return null;
  return a.who.length === 1 ? `Send to ${at(a.who[0])}` : `Send to ${a.who.length}`;
}

/**
 * The same in full, for the button's accessible name and tooltip. It starts with the words on the button, so asking for
 * the button by what it says ("Send to 2") finds it (WCAG 2.5.3, Label in Name), then says who: "Send to 2: @codex and
 * @claude", "Send to all: @codex, then @claude".
 */
export function sendName(a: Answering): string {
  const label = sendLabel(a);
  if (!label) return "Send";
  const who = a.how === "all" ? inTurn(a.who.map(at)) : listed(a.who.map(at));
  return label.endsWith(who) ? label : `${label}: ${who}`;
}

/** The one choice a group chat has about its agents, as New group chat and the chat's settings name it. */
export const HOW_TOGETHER = "How they work together";

/**
 * What that choice offers, in a person's words: what happens to a message that @names nobody. The same three in New
 * group chat and in the chat's settings; who leads, the review rounds and working at the same time are behind "More".
 */
export const ANSWER_OPTIONS: { id: GroupAnswers; label: string; help: string }[] = [
  { id: "lead", label: "One leads, the others help when asked", help: "The lead answers what you send. @name another agent to hear from it instead." },
  { id: "turns", label: "Everyone answers in turn", help: "Each agent answers, one after the other, the lead first. Each reads what the others said." },
  { id: "review", label: "One builds, another reviews", help: "The lead does the work, the next agent reviews it, and they go back and forth until it's approved." },
];

/** The lead's part in each way of working together, as the line under the Lead picker says it. */
export function leadHelp(answers: GroupAnswers): string {
  return answers === "turns" ? "Answers first; the others follow in the order above." : answers === "review" ? "Does the work; the next agent in the list reviews it." : "Answers what you send when you @name nobody.";
}

/**
 * "More" at a glance, so who leads is never a surprise behind a fold: "@claude leads", and with a review how many rounds,
 * and that agents may work at the same time when they may.
 */
export function moreLine(o: { lead: string; answers: GroupAnswers; rounds: number; parallel: boolean }): string {
  return [`@${o.lead} leads`, o.answers === "review" ? `up to ${o.rounds} review round${o.rounds === 1 ? "" : "s"}` : null, o.parallel ? "may work at the same time" : null].filter(Boolean).join(" · ");
}

/** Review rounds as a chat keeps them (Room.maxHops: the lead's work and its review are two hand-overs). */
export const roundsOf = (maxHops: number) => Math.max(1, Math.ceil(maxHops / 2));
export const hopsOf = (rounds: number) => rounds * 2 - 1;

/** One account that can be an agent of a group chat: a row of "Add an agent". */
export interface GroupAgentOption {
  /** Stable key: the agent and the account. */
  id: string;
  /** The agent that runs it: Claude Code or Codex. */
  provider: ChatProvider;
  account: string;
  /** What the row is called: the agent, the agent and the account's name, or a service's own name. */
  title: string;
  /** The line under it: whose plan, an API key, or a service's model and where it runs. */
  help: string;
  /** Null for the agent's own accounts (its avatar); where a service of yours runs (its own avatar). */
  where: ServiceWhere | null;
  /** The model a service starts on (its first); null for the agent's own accounts (their default). */
  model: string | null;
  /** Why it can't be added right now, in two or three words; null when it can. */
  why: string | null;
}

/**
 * Every account on a machine that can answer in a group chat, one row each: Claude Code and Codex on their own sign-ins
 * and API keys, then the AI services and models of your own that one of them runs (this machine's first, then the
 * online ones). An agent that isn't installed has no rows but its own, which says so; an account that's signed out
 * stays listed, saying that, so it isn't simply missing. `left`: the services only Crosstalk's own agent or OpenCode
 * run, which can't be in a group chat (hub Chats.createGroup), by name.
 */
export function groupAgentOptions(input: { accounts: readonly AgentAccount[]; providers: Partial<Record<Provider, { installed?: boolean; signedIn?: boolean | null } | undefined>>; machine?: string | null }): { options: GroupAgentOption[]; left: string[] } {
  const own: GroupAgentOption[] = [];
  const services: { a: AgentAccount; row: GroupAgentOption }[] = [];
  for (const provider of CHAT_PROVIDERS) {
    const agent = PROVIDER_INFO[provider].name;
    const st = input.providers[provider];
    const mine = input.accounts.filter((a) => a.provider === provider);
    const main = mine.find((a) => a.id === "default");
    const mainIn = main ? main.signedIn : st?.signedIn ?? null;
    own.push({
      id: `${provider}:default`,
      provider,
      account: "default",
      title: agent,
      help: main?.account ? `Your plan · ${main.account}` : "Your plan",
      where: null,
      model: null,
      why: !st?.installed ? "Not installed" : mainIn === false ? "Not signed in" : null,
    });
    // Its other accounts only where the agent itself is there to run them.
    if (!st?.installed) continue;
    for (const a of mine) {
      if (a.id === "default") continue;
      const why = a.signedIn === false ? (a.kind === "signin" || !a.kind ? "Not signed in" : a.kind === "apikey" ? "Key not working" : "Not answering") : null;
      if (a.kind === "endpoint") {
        if (!a.endpoint) continue;
        const model = a.endpoint.models[0] ?? null;
        services.push({ a, row: { id: `${provider}:${a.id}`, provider, account: a.id, title: a.label, help: [model ?? "No model yet", serviceWhereWords(a, input.machine), `with ${agent}`].join(" · "), where: serviceWhere(a), model, why: model ? why : "No model yet" } });
      } else {
        own.push({ id: `${provider}:${a.id}`, provider, account: a.id, title: `${agent} · ${a.label}`, help: a.kind === "apikey" ? "API key, billed per use" : accountDescription("Another plan", a.account), where: null, model: null, why });
      }
    }
  }
  services.sort((x, y) => Number(x.row.where === "web") - Number(y.row.where === "web") || x.a.label.localeCompare(y.a.label) || CHAT_PROVIDERS.indexOf(x.row.provider) - CHAT_PROVIDERS.indexOf(y.row.provider));
  const left = [...new Set(input.accounts.filter((a) => a.kind === "endpoint" && isServiceOnlyAgent(a.provider)).map((a) => a.label))].sort((a, b) => a.localeCompare(b));
  return { options: [...own, ...services.map((s) => s.row)], left };
}

/** The quiet line under "Add an agent" about services that can't join: only said where there are some. */
export function leftOutLine(left: readonly string[]): string | null {
  if (!left.length) return null;
  const one = left.length === 1;
  const names = left.length > 3 ? `${left.slice(0, 2).join(", ")} and ${left.length - 2} more` : listed(left);
  return `${names} can't join a group chat: ${one ? "its agent works" : "their agents work"} in a chat of ${one ? "its" : "their"} own. To use ${one ? "it" : "one"} here, add it for Claude Code or Codex in ${settingsPath("ai-services")}.`;
}

/**
 * Who's working and who's next in a group chat, from its turns: the agents whose replies run now (oldest first), then
 * those waiting, in the order their turns were queued (the hub runs them in that order).
 */
export function workQueue(members: readonly Member[], turns: readonly Pick<Turn, "memberId" | "status" | "createdAt" | "startedAt">[]): { now: Member[]; next: Member[] } {
  const of = (id: string) => members.find((m) => m.id === id);
  const now: Member[] = [];
  const next: Member[] = [];
  for (const t of [...turns].filter((x) => x.status === "running").sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))) {
    const m = of(t.memberId);
    if (m && !now.includes(m)) now.push(m);
  }
  for (const t of [...turns].filter((x) => x.status === "queued").sort((a, b) => a.createdAt - b.createdAt)) {
    const m = of(t.memberId);
    if (m && !now.includes(m) && !next.includes(m)) next.push(m);
  }
  return { now, next };
}

/** The line under a working group chat: "Now: @claude · Next: @codex". Null when nobody is working or waiting. */
export function queueLine(q: { now: Member[]; next: Member[] }): string | null {
  const parts = [q.now.length ? `Now: ${listed(q.now.map(at))}` : null, q.next.length ? `Next: ${inTurn(q.next.map(at))}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The agents that have read a message (Member.readSeq): going back to before it is a rewind for each of them. */
export function readersOf(members: readonly Member[], seq: number | undefined): Member[] {
  return typeof seq === "number" ? members.filter((m) => typeof m.readSeq === "number" && m.readSeq >= seq) : [];
}

/**
 * Your newest message's agents that haven't read it, when nothing in the chat is going to answer it (Stop everything
 * left it, say): "Answer now" sends it to them. Empty while anything works or waits, or when every one of them has read it.
 * `after`: the messages since it. Another agent's reply there doesn't count (everyone in turn: the first answered, the
 * next was stopped), but one of theirs does: a reply that failed before it read the message has Try again under it.
 */
export function notAnswered(room: RoomRoute, members: readonly Member[], message: { seq?: number; text: string; mentions: string[] } | undefined, busy: boolean, after: readonly Pick<Message, "authorKind" | "memberId">[] = []): Member[] {
  if (!message || busy || typeof message.seq !== "number" || members.some((m) => m.readSeq === undefined)) return [];
  const named = message.mentions.map((id) => members.find((m) => m.id === id)).filter((m): m is Member => !!m);
  // Build & review: the builder answers you (the reviewer gets its work after).
  const chat = whoAnswers(room, members, "");
  const targets = named.length ? named : chat.how === "review" ? chat.who.slice(0, 1) : chat.who;
  return targets.filter((m) => (m.readSeq ?? 0) < message.seq! && !after.some((x) => x.authorKind === "agent" && x.memberId === m.id));
}

/** What "Answer now" is under: who didn't answer your message ("Not answered by @codex"). */
export function notAnsweredLine(who: readonly Pick<Member, "handle">[]): string {
  return who.length ? `Not answered by ${listed(who.map(at))}` : "Not answered";
}

/**
 * Failed replies whose request a later reply answered (Try again, an edit): a grey note now, not a red error. In a group
 * chat only a later reply of the same agent counts: another agent answering that message isn't this one's answer.
 */
export function retriedTurns(turns: readonly Pick<Turn, "id" | "memberId" | "triggerMessageId" | "status" | "createdAt">[], group: boolean): Set<string> {
  const out = new Set<string>();
  for (const t of turns) if (t.status === "error" && t.triggerMessageId && turns.some((o) => o.id !== t.id && o.triggerMessageId === t.triggerMessageId && o.status === "done" && o.createdAt > t.createdAt && (!group || o.memberId === t.memberId))) out.add(t.id);
  return out;
}

/** A group chat matches the drawer's search by its agents too (their @names and kinds). */
export function groupMatches(members: readonly Pick<Member, "handle" | "provider">[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return !!q && members.some((m) => `@${m.handle}`.includes(q) || (PROVIDER_INFO[m.provider]?.name ?? "").toLowerCase().includes(q));
}

/**
 * How a group chat is doing, from its busiest agent: waiting for you, then working, then waiting its turn, then waiting
 * for a usage limit to reset, then an error.
 */
export function groupState(members: readonly Pick<Member, "status">[]): Member["status"] | undefined {
  for (const s of ["approval", "thinking", "working", "queued", "waiting", "error"] as const) if (members.some((m) => m.status === s)) return s;
  return members.length ? "idle" : undefined;
}

/**
 * The @name an agent gets in a group chat, as the hub picks it (Chats.groupHandle): the one typed, else its account's
 * name (a custom model's, an API key's), else its agent's own (claude, codex); -2, -3… when it's taken.
 */
export function suggestHandle(provider: Provider, accountLabel: string | null, given: string, taken: readonly string[]): string {
  let base = slugHandle(given.trim() || accountLabel || PROVIDER_INFO[provider].defaultHandle).slice(0, 28).replace(/-+$/, "");
  if (["all", "everyone", "human"].includes(base)) base = `${base}-agent`;
  let handle = base;
  for (let n = 2; taken.includes(handle); n++) handle = `${base}-${n}`;
  return handle;
}

/** Each agent's @name in a new group chat, in order (each one's taken by the time the next is named). */
export function suggestHandles(agents: readonly { provider: Provider; accountLabel: string | null; given: string }[]): string[] {
  const out: string[] = [];
  for (const a of agents) out.push(suggestHandle(a.provider, a.accountLabel, a.given, out));
  return out;
}
