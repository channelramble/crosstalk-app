// Duplicating a chat: a new chat with the original's finished messages (and a line at the top saying where they came
// from), with any agent or account, on this machine or a linked one. With the same agent and account on this machine
// the copy is a real fork of the agent's own conversation, so it remembers everything; with any other it's a handoff:
// its first turn starts with a note of the conversation so far (engine.ts). The original gets a line linking to it.
// Another machine's chats come in through the app: it reads the original (exportChat), asks this hub to make the copy
// (receiveDuplicate), then tells the original's hub (markDuplicated).

import { rmSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import {
  CHAT_PROVIDERS,
  DEFAULT_ACCOUNT,
  PROVIDER_INFO,
  memberAccount,
  turnOrder,
  type ChatExport,
  type ChatProvider,
  type CopiedMessage,
  type DuplicateRequest,
  type Member,
  type Message,
  type MessageCopy,
  type MessageVia,
  type Provider,
  type Room,
} from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";
import { claudeForkPoint, claudeProjectsDir, claudeTranscriptPath, copyClaudeTranscript, legacyCopyUnchanged, unchangedCopy, type TranscriptCopy } from "./local-sessions";
import { moveUploadLinks, type UploadCopies } from "./uploads";
import { newId } from "./util/ids";
import { logger } from "./util/log";

const log = logger("duplicate");

/** The note a copy's agent gets is at most this long (about 25k tokens): the newest of the conversation is kept. */
export const HANDOFF_CHARS = 100_000;
/** On a model server of your own, at most this share of its context, so the agent's instructions and its reply fit. */
const HANDOFF_SHARE = 0.25;
const CHARS_PER_TOKEN = 4;
/** The most of a chat a copy brings along: all of it on this machine; to another machine, at most this much. */
const ALL = 50_000;
const IMPORT_MESSAGES = 5_000;
const IMPORT_CHARS = 5_000_000;
export const TEXT_MAX = 100_000;
/** Settings a copy with the same agent and account keeps (its model, effort and helper model are what the popup showed). */
const KEPT_SETTINGS = ["fast", "ultracode", "autoCompact"];

const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const isChatProvider = (p: unknown): p is ChatProvider => CHAT_PROVIDERS.includes(p as ChatProvider);

/** What a chat's agent is called in a copy: "Claude Code", "Codex", or a custom model's name. */
export function agentLabel(app: App, provider: Provider, account: string): string {
  return (account !== DEFAULT_ACCOUNT && app.providers.endpointOf(provider, account)?.label) || PROVIDER_INFO[provider]?.name || provider;
}

/**
 * A duplicated Claude Code chat whose first reply hasn't forked the original's session yet: its session id is still the
 * original's, so it isn't that conversation's chat, and there's nothing of its own to bring in. A fresh session (Start
 * fresh, or another account) has nothing left to fork.
 */
export function forkPending(member: Pick<Member, "config">, session: Record<string, unknown>): boolean {
  return member.config?.forkNext === true && session.forkDone === false;
}

/** Where what a copy brings along ends: the chat's last finished reply (-1: there's none). */
function lastFinished(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].authorKind === "agent" && messages[i].status === "done" && messages[i].text.trim()) return i;
  return -1;
}

/**
 * What a copy brings along: the user's messages and the finished replies, up to the chat's last finished reply (not a
 * reply still being written, nor messages its agent hasn't answered), without the agent's steps or Crosstalk's notes.
 * Replies the chat itself copied from another agent keep that agent's name. `end` is the index it stops at (included):
 * the last finished reply unless a caller (Ask others) wants it to end at another message.
 */
export function copiedMessages(messages: Message[], agentOf: (m: Message) => { agent: string; provider: Provider | null }, end = lastFinished(messages)): CopiedMessage[] {
  const out: CopiedMessage[] = [];
  for (const m of messages.slice(0, end + 1)) {
    if (!m.text.trim()) continue;
    if (m.authorKind === "human") out.push({ role: "user", authorName: m.authorName, text: m.text, createdAt: m.createdAt, ...(m.via ? { via: m.via } : {}) });
    else if (m.authorKind === "agent" && (m.status === "done" || m.status === "stopped")) {
      const who = m.copy?.kind === "reply" ? { agent: m.copy.agent, provider: m.copy.provider ?? null } : agentOf(m);
      out.push({ role: "agent", authorName: m.authorName, text: m.text, createdAt: m.createdAt, ...who, ...(m.status === "stopped" ? { stopped: true } : {}) });
    }
  }
  return out;
}

/** The chat a copy came from, as its agent's note describes it. */
export interface HandoffFrom {
  name: string;
  agent: string;
  /** Its machine, when it's another one. */
  machine: string | null;
  cwd: string;
}

/** Who said a message, as a note names them. */
const speaker = (m: CopiedMessage) =>
  m.role === "agent" ? m.agent || "The agent" : m.via ? `${clean(m.via.agent, 60)} in the chat "${clean(m.via.chatName, 60)}", another chat's agent (not the user)` : "The user";

/** A long text keeps its start and end (about `per` characters), saying how much was left out. */
const middleCut = (t: string, per: number) => (t.length <= per ? t : `${t.slice(0, Math.floor(per * 0.7))}\n[… ${(t.length - per).toLocaleString("en-US")} characters left out …]\n${t.slice(-Math.floor(per * 0.3))}`);

/**
 * The note a copy's agent gets with its first message when the copy isn't a fork: the conversation so far (the user's
 * messages and the replies, no tool steps), the newest kept within `budget` characters, saying how many earlier
 * messages were left out (`left` more were never brought over).
 */
export function handoffNote(from: HandoffFrom, cwd: string, messages: CopiedMessage[], budget = HANDOFF_CHARS, left = 0): string {
  // One very long message doesn't crowd out the rest: its start and end are kept.
  const per = Math.max(2_000, Math.floor(budget / 4));
  const blocks: string[] = [];
  let used = 0;
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const block = `[${speaker(messages[i])}]\n${middleCut(messages[i].text.trim(), per)}`;
    if (blocks.length && used + block.length + 2 > budget) break;
    blocks.unshift(block);
    used += block.length + 2;
  }
  const omitted = i + 1 + left;
  const where = from.machine
    ? `It was on ${from.machine}, in ${from.cwd}: its files aren't on this machine, and this chat works in ${cwd}, a new empty folder.`
    : from.cwd === cwd
      ? `It worked in this same folder, ${cwd}.`
      : `It worked in ${from.cwd}; this chat works in ${cwd}, a new empty folder.`;
  const head = [
    `Note from Crosstalk: the user duplicated the chat "${from.name}" (${from.agent}${from.machine ? ` on ${from.machine}` : ""}) to go on with it here, with you.`,
    `Below is that conversation so far: the user's messages and the replies, without the tool steps.${omitted ? ` ${omitted.toLocaleString("en-US")} earlier ${omitted === 1 ? "message was" : "messages were"} left out to fit.` : ""}`,
    where,
    "Take it as what was said before: the user's new message comes after it.",
  ].join(" ");
  return `(${head})\n\n${blocks.join("\n\n")}`;
}

/** Ask others: how much of the chat its note keeps (the newest of it, about 6k tokens). */
export const ASK_CHARS = 24_000;
/** What an ask says when its user typed no question of their own. */
export const ASK_QUESTION = "What do you think? Anything wrong or missing?";

/** A message others can be asked about: the user's, or an agent's finished (or stopped) reply, with some text. */
export const askable = (m: Pick<Message, "authorKind" | "status" | "text">) =>
  !!m.text.trim() && (m.authorKind === "human" || (m.authorKind === "agent" && (m.status === "done" || m.status === "stopped")));

/**
 * The note an ask's agent gets (Ask others), like a copy's handoff but ending at the message asked about, which is the
 * last of `messages`: it's marked ▶ and kept in full (up to `budget`). Before it, the newest messages that fit in
 * `budget` characters are kept, and the note says how many were left out. It opens with what's wanted and what isn't
 * allowed: the agent reads the chat's files and changes nothing.
 */
export function askBriefing(messages: CopiedMessage[], cwd: string, budget = ASK_CHARS): string {
  const last = messages.length - 1;
  const per = Math.max(2_000, Math.floor(budget / 4));
  const blocks = [`▶ [${speaker(messages[last])}]\n${middleCut(messages[last].text.trim(), budget)}`];
  let used = blocks[0].length;
  let i = last - 1;
  for (; i >= 0; i--) {
    const block = `[${speaker(messages[i])}]\n${middleCut(messages[i].text.trim(), per)}`;
    if (used + block.length + 2 > budget) break;
    blocks.unshift(block);
    used += block.length + 2;
  }
  const omitted = i + 1;
  const head = [
    "A user is working with a coding agent in a chat. They want your view on the message marked ▶. You can read files but must not change anything. Answer in under 200 words, plain Markdown, no preamble.",
    `The chat works in ${cwd}.`,
    omitted ? `${omitted.toLocaleString("en-US")} earlier ${omitted === 1 ? "message was" : "messages were"} left out to fit.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `(${head})\n\n${blocks.join("\n\n")}`;
}

/** How long a copy's note may be on the agent and account it goes to. */
export function handoffBudget(app: App, provider: Provider, account: string): number {
  const ctx = account !== DEFAULT_ACCOUNT ? app.providers.endpointOf(provider, account)?.contextWindow : null;
  return ctx ? Math.min(HANDOFF_CHARS, Math.floor(ctx * HANDOFF_SHARE * CHARS_PER_TOKEN)) : HANDOFF_CHARS;
}

/** Where a copy goes and how its agent runs. Model, effort and helper model must be said: they're never picked here. */
function request(body: unknown, folder?: "new"): DuplicateRequest {
  const b = (body ?? {}) as Partial<Record<keyof DuplicateRequest, unknown>>;
  if (!isChatProvider(b.provider)) throw new HttpError(400, "Chats are with Claude Code or Codex");
  const setting = (v: unknown, what: string, ok: RegExp) => {
    if (v === undefined) throw new HttpError(400, `Say which ${what} the copy uses (empty for the agent's default)`);
    if (v !== null && typeof v !== "string") throw new HttpError(400, `bad ${what}`);
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !ok.test(s)) throw new HttpError(400, `bad ${what}`);
    return s || null;
  };
  return {
    provider: b.provider,
    account: typeof b.account === "string" && b.account.trim() ? b.account.trim() : DEFAULT_ACCOUNT,
    model: setting(b.model, "model", /^\S{1,200}$/),
    effort: setting(b.effort, "effort", /^[a-z]{2,12}$/),
    helperModel: setting(b.helperModel, "helper model", /^[\w.:@/[\]-]{1,100}$/),
    folder: folder ?? (b.folder === "same" ? "same" : "new"),
    name: clean(b.name, 80),
  };
}

/** The agent and account a copy goes to must be there to use. */
function checkReady(app: App, provider: ChatProvider, account: string) {
  const name = PROVIDER_INFO[provider].name;
  const st = app.providers.list().find((s) => s.provider === provider);
  if (st?.checkedAt && !st.installed) throw new HttpError(409, `${name} isn't installed on ${app.machineName()}.`, "not_ready");
  if (!app.providers.hasAccount(provider, account)) throw new HttpError(400, "That account doesn't exist for this agent");
  const acct = app.providers.accounts().find((a) => a.provider === provider && a.id === account);
  if (acct?.signedIn === false) throw new HttpError(409, `${account === DEFAULT_ACCOUNT ? name : `${name} (${acct.label})`} isn't signed in on ${app.machineName()}.`, "not_ready");
}

/**
 * The chat being duplicated, once its agents have finished: a copy never takes a reply that's still being written.
 * `member` is its agent (a group chat's lead), `members` all of them.
 */
function original(app: App, roomId: string, busyOk = false): { room: Room; member: Member; members: Member[] } {
  const room = app.store.getRoom(roomId);
  const members = room?.chat ? app.store.listMembers(roomId) : [];
  const member = room?.chat ? turnOrder(room, members)[0] : null;
  if (!room?.chat || !member) throw new HttpError(404, "No such chat");
  if (!busyOk && app.engine.isBusy(roomId)) {
    const who = room.chat.group ? "An agent here" : PROVIDER_INFO[member.provider]?.name ?? "The agent";
    throw new HttpError(409, `${who} is working. Wait for it to finish, or stop it, then duplicate this chat.`, "busy");
  }
  return { room, member, members };
}

/**
 * Who wrote each reply of a chat, as a copy or an export names them: its agent, and in a group chat (several agents,
 * maybe two of a kind) which of them, "Codex (@reviewer)".
 */
function authors(app: App, src: { room: Room; member: Member; members: Member[] }): (m: Message) => { agent: string; provider: Provider | null } {
  return (m) => {
    const who = src.members.find((x) => x.id === m.memberId);
    if (!who && src.room.chat?.group) return { agent: `@${m.authorName}`, provider: null };
    const agent = agentLabel(app, (who ?? src.member).provider, memberAccount(who ?? src.member));
    return { agent: src.room.chat?.group ? `${agent} (@${who!.handle})` : agent, provider: (who ?? src.member).provider };
  };
}

/** What a chat's agents are called together: "Claude Code", or "Claude Code and Codex" for a group chat. */
export function agentsLabel(app: App, members: Member[]): string {
  const names = [...new Set(members.map((m) => agentLabel(app, m.provider, memberAccount(m))))];
  return names.length < 2 ? (names[0] ?? "Agents") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function insert(app: App, roomId: string, m: Pick<Message, "authorKind" | "memberId" | "authorName" | "text" | "status" | "createdAt"> & Partial<Pick<Message, "via" | "copy">>): Message {
  const msg: Message = { id: newId("m"), roomId, mentions: [], turnId: null, updatedAt: m.createdAt, ...m };
  app.store.insertMessage(msg);
  return msg;
}

/**
 * Fills a new chat with what it copies: the line at the top, then the messages (replies by the same kind of agent as
 * its own show as its agent's; others keep their agent's name). Its agent has read them all: a fork remembers them, a
 * handoff's note carries them.
 */
function fill(app: App, room: Room, member: Member, top: { text: string; copy: MessageCopy }, messages: CopiedMessage[], ownAgent: string) {
  const now = Date.now();
  app.store.db.transaction(() => {
    // The app shows messages in time order: the line goes just before the first one.
    insert(app, room.id, { authorKind: "system", memberId: null, authorName: "Crosstalk", text: top.text, status: "done", createdAt: Math.min(now, (messages[0]?.createdAt ?? now) - 1), copy: top.copy });
    for (const c of messages) {
      const status = c.stopped ? "stopped" : "done";
      if (c.role === "user") insert(app, room.id, { authorKind: "human", memberId: null, authorName: c.authorName, text: c.text, status: "done", createdAt: c.createdAt, ...(c.via ? { via: c.via } : {}) });
      else if (c.provider === member.provider && c.agent === ownAgent) insert(app, room.id, { authorKind: "agent", memberId: member.id, authorName: member.handle, text: c.text, status, createdAt: c.createdAt });
      else insert(app, room.id, { authorKind: "agent", memberId: null, authorName: c.authorName, text: c.text, status, createdAt: c.createdAt, copy: { kind: "reply", agent: c.agent || "Another agent", provider: c.provider ?? null } });
    }
    app.store.setLastSeen(member.id, app.store.maxSeq(room.id), 0);
  })();
  app.store.touchRoom(room.id);
}

/** The line in the original that links to its copy. */
function noteDuplicated(app: App, roomId: string, to: Omit<MessageCopy, "kind">) {
  const msg = insert(app, roomId, { authorKind: "system", memberId: null, authorName: "Crosstalk", text: `Duplicated to "${to.chatName}"${to.machine ? ` on ${to.machine}` : ""}`, status: "done", createdAt: Date.now(), copy: { kind: "to", ...to } });
  app.bus.emit({ t: "message", message: msg });
}

/**
 * A fork of the original agent's own conversation for the copy, when there's one to fork (null: it has none, or its
 * transcript is gone). It ends where the copy's messages do, at the original's last finished reply: a request after it
 * that was stopped, failed or not answered yet isn't in the copy, so its agent doesn't remember it either. Claude Code:
 * the copy's first process forks the session (--fork-session) at that reply; it keeps sessions per project folder, so
 * a copy in another folder gets the transcript there first. Codex: the copy's thread is made with thread/fork, through
 * that reply's turn (or a later one the chat brought in from the Codex app).
 */
function forkOf(app: App, src: { room: Room; member: Member }, s: Record<string, unknown>, cwd: string, messages: Message[]): Record<string, unknown> | null {
  // The original is itself a copy that hasn't forked yet: the copy forks what it would.
  const pending = forkPending(src.member, s);
  const refs = (s.msgRefs && typeof s.msgRefs === "object" ? s.msgRefs : {}) as Record<string, unknown>;
  if (src.member.provider === "claude") {
    const id = typeof s.sessionId === "string" ? s.sessionId : null;
    if (!id) return null;
    const projects = claudeProjectsDir(app.providers.agentEnv("claude", memberAccount(src.member)).CLAUDE_CONFIG_DIR || undefined);
    const path = claudeTranscriptPath(id, projects);
    if (!path) return null;
    // The first message after the copy's end that Claude Code was given (by the id it went in with): the fork ends
    // before it.
    const after = messages.slice(lastFinished(messages) + 1).find((m) => m.authorKind === "human" && typeof refs[m.id] === "string");
    const forkAt = pending ? (typeof s.forkAt === "string" ? s.forkAt : null) : claudeForkPoint(path, after ? (refs[after.id] as string) : null);
    const copies = copyClaudeTranscript(path, cwd, projects);
    return { sessionId: id, forkDone: false, ...(forkAt ? { forkAt } : {}), ...(copies.length ? { forkCopies: copies } : {}) };
  }
  const thread = typeof s.threadId === "string" && s.threadId ? s.threadId : null;
  if (!thread) return typeof s.forkFrom === "string" && s.forkFrom ? { forkFrom: s.forkFrom, ...(typeof s.forkAt === "string" ? { forkAt: s.forkAt } : {}) } : null;
  // The newest turn the chat knows that finished: its own last finished reply, or a later one it brought in from the
  // Codex app, but never past a reply of its own that didn't finish (its own turns after its last finished one).
  const sync = (app.store.getChat(src.room.id)?.sync ?? {}) as { codexThread?: string; codexTurns?: unknown };
  const turns = sync.codexThread === thread && Array.isArray(sync.codexTurns) ? sync.codexTurns.map(String) : [];
  const last = typeof s.lastTurn === "string" ? s.lastTurn : null;
  let forkAt = last && !turns.includes(last) ? last : (turns.at(-1) ?? last);
  if (last && turns.includes(last)) {
    const own = new Set(Object.values(refs).filter((t): t is string => typeof t === "string"));
    forkAt = last;
    for (const t of turns.slice(turns.indexOf(last) + 1)) {
      if (own.has(t)) break;
      forkAt = t;
    }
  }
  return { forkFrom: thread, ...(forkAt ? { forkAt } : {}) };
}

/**
 * Duplicates a chat on this machine (POST /api/chats/:id/duplicate). The same agent and account fork the original's
 * conversation; anything else gets a handoff note. Returns the new chat.
 */
export async function duplicateChat(app: App, roomId: string, body: unknown): Promise<Room> {
  if ((body as { group?: unknown } | null)?.group === true) return duplicateGroup(app, roomId, body);
  const req = request(body);
  // What was said in the agent's own app since the chat last looked comes along too.
  await app.chats.sync(roomId).catch((e) => log.debug(`sync before duplicating: ${e}`));
  const src = original(app, roomId);
  checkReady(app, req.provider, req.account);
  const srcAccount = memberAccount(src.member);
  const group = !!src.room.chat?.group;
  const fromAgent = group ? agentsLabel(app, src.members) : agentLabel(app, src.member.provider, srcAccount);
  const toAgent = agentLabel(app, req.provider, req.account);
  // A group chat copied to one agent is a handoff: no one agent's conversation is the chat.
  const sameAgent = !group && req.provider === src.member.provider && req.account === srcAccount;
  const all = app.store.messagesAfter(roomId, 0, ALL);
  const room = app.chats.create({
    provider: req.provider,
    account: req.account,
    model: req.model,
    effort: req.effort,
    helperModel: req.helperModel,
    // The same kind of agent keeps what it may do; another starts from its defaults, like any new chat with it.
    ...(req.provider === src.member.provider ? { permissionMode: src.member.permissionMode } : {}),
    ...(req.folder === "same" ? { cwd: src.room.cwd } : {}),
    name: req.name || `${src.room.name} (copy)`,
    // A chat kept from other chats' agents (with all it says) stays kept from them in its copy.
    ...(src.room.privateFromAgents ? { privateFromAgents: true } : {}),
  });
  // Files and images in the messages open from the copy itself (copied to its folder when that's another one).
  const uploads: UploadCopies = { entries: new Map(), bytes: 0 };
  const copied = copiedMessages(all, authors(app, src)).map((c) => ({ ...c, text: moveUploadLinks(src.room, room, c.text, uploads) }));
  const member = app.chats.member(room.id)!;
  const s = app.store.getMemberSession(src.member.id);
  const fork = sameAgent ? forkOf(app, src, s, room.cwd, all) : null;
  // Same agent, nothing to fork: the copy knows what the original's agent knows (nothing, after Start fresh), unless the
  // original was about to get the conversation itself.
  const pendingNote = typeof s.handoff === "string" && !Array.isArray(s.handoffWith);
  const hadSession = !!(s.sessionId || s.threadId || s.forkFrom);
  const handoff = !fork && copied.length > 0 && (!sameAgent || hadSession || pendingNote);
  fill(app, room, member, { text: `Copied from "${src.room.name}" (${fromAgent})`, copy: { kind: "from", agent: fromAgent, provider: src.member.provider, chatId: src.room.id, chatName: src.room.name } }, copied, toAgent);
  const config: Record<string, unknown> = { ...member.config };
  if (sameAgent) for (const k of KEPT_SETTINGS) if (src.member.config?.[k] !== undefined) config[k] = src.member.config[k];
  if (fork && member.provider === "claude") config.forkNext = true;
  app.store.updateMember(member.id, { config });
  if (fork) app.store.setMemberSession(member.id, fork);
  else if (handoff) app.store.setMemberSession(member.id, { handoff: handoffNote({ name: src.room.name, agent: fromAgent, machine: null, cwd: src.room.cwd }, room.cwd, copied, handoffBudget(app, req.provider, req.account)) });
  app.bus.emit({ t: "member", member: app.store.getMember(member.id)! });
  const copy = app.store.getRoom(room.id)!;
  noteDuplicated(app, roomId, { agent: toAgent, provider: req.provider, chatId: copy.id, chatName: copy.name });
  log.info(`duplicated "${src.room.name}" to "${copy.name}" (${toAgent}, ${fork ? "a fork" : handoff ? `a handoff of ${copied.length} messages` : "nothing to bring"})`);
  return copy;
}

/**
 * Duplicates a group chat on this machine with the same agents (POST /api/chats/:id/duplicate with `group: true`): each
 * agent forks its own conversation where it has one (as a chat with one agent does), else reads a handoff note of the
 * conversation with its first message. The copy answers the same way (who leads, everyone in turn or Build & review).
 */
async function duplicateGroup(app: App, roomId: string, body: unknown): Promise<Room> {
  const b = (body ?? {}) as { folder?: unknown; name?: unknown };
  const src = original(app, roomId);
  if (!src.room.chat?.group) throw new HttpError(400, "Only a group chat is copied with all its agents");
  for (const m of src.members) if ((CHAT_PROVIDERS as readonly string[]).includes(m.provider)) checkReady(app, m.provider as ChatProvider, memberAccount(m));
  const all = app.store.messagesAfter(roomId, 0, ALL);
  const end = lastFinished(all);
  const fromAgent = agentsLabel(app, src.members);
  const name = clean(b.name, 80) || `${src.room.name} (copy)`;
  const now = Date.now();
  // The same agents, each with what it runs on and may do, its @name and its role.
  const ids = new Map(src.members.map((m) => [m.id, newId("mb")]));
  const room: Room = {
    id: newId("r"),
    name,
    cwd: app.chats.place(name, b.folder === "new" ? undefined : src.room.cwd).cwd,
    mode: src.room.mode,
    leadMemberId: src.room.leadMemberId ? ids.get(src.room.leadMemberId) ?? null : null,
    maxHops: src.room.maxHops,
    rounds: src.room.rounds,
    parallel: src.room.parallel,
    createdAt: now,
    updatedAt: now,
    archived: false,
    chat: { provider: src.member.provider, origin: "web", group: true },
    ...(src.room.privateFromAgents ? { privateFromAgents: true } : {}),
  };
  const members: Member[] = src.members.map((m, i) => ({ ...m, id: ids.get(m.id)!, roomId: room.id, status: "idle", statusDetail: null, createdAt: now + i, config: Object.fromEntries(Object.entries(m.config ?? {}).filter(([k]) => k !== "forkNext")) }));
  const uploads: UploadCopies = { entries: new Map(), bytes: 0 };
  const copied = copiedMessages(all, authors(app, src)).map((c) => ({ ...c, text: moveUploadLinks(src.room, room, c.text, uploads) }));
  // Each message copied: its seq in the original, then in the copy (in order), for where each agent has read up to.
  const seqs: [number, number][] = [];
  app.store.db.transaction(() => {
    app.store.insertRoom(room);
    for (const m of members) app.store.insertMember(m);
    const first = all.slice(0, end + 1).find((m) => m.text.trim() && m.authorKind !== "system");
    insert(app, room.id, { authorKind: "system", memberId: null, authorName: "Crosstalk", text: `Copied from "${src.room.name}" (${fromAgent})`, status: "done", createdAt: Math.min(now, (first?.createdAt ?? now) - 1), copy: { kind: "from", agent: fromAgent, provider: src.member.provider, chatId: src.room.id, chatName: src.room.name } });
    // The messages as they were, each reply still its own agent's (one that has left the chat keeps its name).
    for (const m of all.slice(0, end + 1)) {
      if (!m.text.trim() || m.authorKind === "system") continue;
      const text = moveUploadLinks(src.room, room, m.text, uploads);
      let put: Message | null = null;
      if (m.authorKind === "human") put = insert(app, room.id, { authorKind: "human", memberId: null, authorName: m.authorName, text, status: "done", createdAt: m.createdAt, ...(m.via ? { via: m.via } : {}) });
      else if (m.status === "done" || m.status === "stopped") {
        const to = m.memberId ? ids.get(m.memberId) : undefined;
        const status = m.status;
        if (to && !m.copy) put = insert(app, room.id, { authorKind: "agent", memberId: to, authorName: m.authorName, text, status, createdAt: m.createdAt });
        else put = insert(app, room.id, { authorKind: "agent", memberId: null, authorName: m.authorName, text, status, createdAt: m.createdAt, copy: m.copy?.kind === "reply" ? m.copy : { kind: "reply", agent: authors(app, src)(m).agent, provider: authors(app, src)(m).provider } });
      }
      if (put) seqs.push([m.seq, app.store.messageSeq(put.id)]);
    }
  })();
  app.store.touchRoom(room.id);
  // In the copy, an agent has read what it had read of the messages copied (0: none of them).
  const upTo = (seq: number) => seqs.findLast(([from]) => from <= seq)?.[1] ?? 0;
  const copyOf = new Map(seqs);
  // Each agent remembers what it remembers in the original (a fork of its own conversation), or reads it first.
  const forks: string[] = [];
  for (const m of src.members) {
    const s = app.store.getMemberSession(m.id);
    const id = ids.get(m.id)!;
    const seen = app.store.getLastSeen(m.id);
    const fork = forkOf(app, { room: src.room, member: m }, s, room.cwd, all);
    // On its next turn it reads in the copy what it would in the original: an agent behind (the lead answered
    // meanwhile) or one that hasn't spoken yet reads the rest then. A Codex fork ends at its last finished reply: what
    // a reply that failed or was stopped after that brought, it reads again.
    const lastDone = all.findLast((x) => x.memberId === m.id && x.authorKind === "agent" && x.status === "done")?.seq ?? 0;
    let read = upTo(fork && m.provider === "codex" ? Math.min(seen.seq, lastDone) : seen.seq);
    let pending = seen.pending.map((p) => copyOf.get(p)).filter((p): p is number => p !== undefined);
    if (fork) {
      app.store.setMemberSession(id, fork);
      if (m.provider === "claude") app.store.updateMember(id, { config: { ...members.find((x) => x.id === id)!.config, forkNext: true } });
      forks.push(m.handle);
    } else if (copied.length && (s.sessionId || s.threadId || s.forkFrom || typeof s.handoff === "string")) {
      app.store.setMemberSession(id, { handoff: handoffNote({ name: src.room.name, agent: fromAgent, machine: null, cwd: src.room.cwd }, room.cwd, copied, handoffBudget(app, m.provider, memberAccount(m))) });
      // The note brings it the whole conversation so far.
      read = app.store.maxSeq(room.id);
      pending = [];
    }
    app.store.setLastSeen(id, read, 0, pending);
  }
  const copy = app.store.getRoom(room.id)!;
  app.bus.emit({ t: "room", room: copy });
  for (const m of app.store.listMembers(room.id)) app.bus.emit({ t: "member", member: m });
  noteDuplicated(app, roomId, { agent: fromAgent, provider: src.member.provider, chatId: copy.id, chatName: copy.name });
  log.info(`duplicated the group chat "${src.room.name}" to "${copy.name}" (${forks.length ? `forks for @${forks.join(", @")}` : "handoffs"})`);
  return copy;
}

/**
 * What a chat brings along to a copy on another machine (GET /api/chats/:id/export): its newest, within a size. `whole`
 * (the Markdown export, search.ts): a chat at work is fine, and its last messages come too, even yours with no reply yet.
 */
export async function exportChat(app: App, roomId: string, whole = false): Promise<ChatExport> {
  await app.chats.sync(roomId).catch((e) => log.debug(`sync before exporting: ${e}`));
  const src = original(app, roomId, whole);
  const agent = src.room.chat?.group ? agentsLabel(app, src.members) : agentLabel(app, src.member.provider, memberAccount(src.member));
  const said = app.store.messagesAfter(roomId, 0, ALL);
  const messages = copiedMessages(said, authors(app, src), whole ? said.length - 1 : undefined).map((m) => ({ ...m, text: m.text.slice(0, TEXT_MAX) }));
  let start = messages.length;
  let total = 0;
  while (start > 0 && messages.length - start < IMPORT_MESSAGES && total + messages[start - 1].text.length <= IMPORT_CHARS) total += messages[--start].text.length;
  return {
    chat: { id: src.room.id, name: src.room.name, provider: src.member.provider as ChatProvider, agent, cwd: src.room.cwd, ...(src.room.privateFromAgents ? { privateFromAgents: true } : {}) },
    machine: { id: app.hubId(), name: app.machineName() },
    messages: messages.slice(start),
    ...(start ? { left: start } : {}),
  };
}

/** A message from another chat's agent, as another machine sent it: only its known fields, or null. */
function viaOf(v: unknown): MessageVia | null {
  const x = v as Partial<Record<keyof MessageVia, unknown>> | null;
  if (!x || typeof x !== "object" || typeof x.chatId !== "string" || typeof x.agent !== "string") return null;
  return { hubId: clean(x.hubId, 40), machine: clean(x.machine, 40), chatId: clean(x.chatId, 40), chatName: clean(x.chatName, 80), agent: clean(x.agent, 60), hop: Math.max(1, Math.min(3, Math.floor(Number(x.hop) || 1))), kind: x.kind === "start" ? "start" : "message" };
}

/** A chat another machine sent to copy, checked: only what a copy uses, within the limits. */
function exported(v: unknown): ChatExport {
  const x = (v ?? {}) as { chat?: Record<string, unknown>; machine?: Record<string, unknown>; messages?: unknown; left?: unknown };
  const provider = x.chat?.provider;
  if (!x.chat || !isChatProvider(provider) || !Array.isArray(x.messages)) throw new HttpError(400, "Send the chat to copy");
  if (x.messages.length > IMPORT_MESSAGES) throw new HttpError(413, `A copy brings at most ${IMPORT_MESSAGES.toLocaleString("en-US")} messages`);
  const messages: CopiedMessage[] = [];
  let total = 0;
  for (const raw of x.messages as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object" || (raw.role !== "user" && raw.role !== "agent") || typeof raw.text !== "string" || !raw.text.trim()) continue;
    const text = raw.text.slice(0, TEXT_MAX);
    total += text.length;
    if (total > IMPORT_CHARS) throw new HttpError(413, "That chat is too long to copy to another machine");
    // A message from another chat's agent must never pass for the user's: it comes with where it came from, or not at all.
    const via = raw.via ? viaOf(raw.via) : null;
    if (raw.via && !via) continue;
    const at = Number(raw.createdAt);
    messages.push({
      role: raw.role,
      authorName: clean(raw.authorName, 60) || (raw.role === "user" ? "You" : "agent"),
      text,
      createdAt: Number.isFinite(at) && at > 0 ? at : Date.now(),
      ...(raw.role === "agent" ? { agent: clean(raw.agent, 60) || "Another agent", provider: isChatProvider(raw.provider) ? raw.provider : null, ...(raw.stopped === true ? { stopped: true } : {}) } : {}),
      ...(via ? { via } : {}),
    });
  }
  return {
    chat: { id: /^[\w-]{1,40}$/.test(String(x.chat.id ?? "")) ? String(x.chat.id) : "", name: clean(x.chat.name, 80) || "A chat", provider, agent: clean(x.chat.agent, 60) || PROVIDER_INFO[provider].name, cwd: clean(x.chat.cwd, 1000), ...(x.chat.privateFromAgents === true ? { privateFromAgents: true } : {}) },
    machine: { id: clean(x.machine?.id, 40), name: clean(x.machine?.name, 40) || "another machine" },
    messages,
    left: Math.max(0, Math.floor(Number(x.left) || 0)),
  };
}

/**
 * A copy of another machine's chat (POST /api/chats/duplicate), sent by the app: always a handoff, in a new empty
 * folder (the files stay on the other machine). Returns the new chat.
 */
export function receiveDuplicate(app: App, body: unknown): Room {
  const req = request(body, "new");
  const from = exported((body as { from?: unknown } | null)?.from);
  checkReady(app, req.provider, req.account);
  const room = app.chats.create({ provider: req.provider, account: req.account, model: req.model, effort: req.effort, helperModel: req.helperModel, name: req.name || `${from.chat.name} (copy)`, ...(from.chat.privateFromAgents ? { privateFromAgents: true } : {}) });
  const member = app.chats.member(room.id)!;
  const left = from.left ?? 0;
  const top = `Copied from "${from.chat.name}" (${from.chat.agent}) on ${from.machine.name}${left ? `, without its ${left.toLocaleString("en-US")} earliest messages` : ""}`;
  fill(app, room, member, { text: top, copy: { kind: "from", agent: from.chat.agent, provider: from.chat.provider, chatId: from.chat.id || null, chatName: from.chat.name, machine: from.machine.name } }, from.messages, agentLabel(app, req.provider, req.account));
  if (from.messages.length) {
    const note = handoffNote({ name: from.chat.name, agent: from.chat.agent, machine: from.machine.name, cwd: from.chat.cwd || "its folder" }, room.cwd, from.messages, handoffBudget(app, req.provider, req.account), left);
    app.store.setMemberSession(member.id, { handoff: note });
  }
  log.info(`copied "${from.chat.name}" from ${from.machine.name} to "${room.name}" (${from.messages.length} messages)`);
  return app.store.getRoom(room.id)!;
}

/** The original's line linking to its copy on another machine (POST /api/chats/:id/duplicated). */
export function markDuplicated(app: App, roomId: string, body: unknown): { ok: true } {
  const room = app.store.getRoom(roomId);
  if (!room?.chat) throw new HttpError(404, "No such chat");
  const b = (body ?? {}) as Record<string, unknown>;
  const chatId = clean(b.chatId, 40);
  const chatName = clean(b.chatName, 80);
  if (!/^[\w-]{1,40}$/.test(chatId) || !chatName) throw new HttpError(400, "Say which chat it was duplicated to");
  noteDuplicated(app, roomId, { agent: clean(b.agent, 60) || "an agent", provider: isChatProvider(b.provider) ? b.provider : null, chatId, chatName, machine: clean(b.machine, 40) || null });
  return { ok: true };
}

/** A transcript copy as a chat's session notes it (older hubs noted only its path). */
const copyPath = (c: unknown): string | null => (typeof c === "string" ? c : c && typeof c === "object" && typeof (c as TranscriptCopy).path === "string" ? (c as TranscriptCopy).path : null);

/**
 * Deletes the transcript copies a duplicated Claude Code chat made for its fork (copyClaudeTranscript), once it has
 * forked (or is deleted, or starts fresh): only files it made, only while they're still as it made them (someone may
 * have gone on with that conversation in a terminal there), and never one another copy still waits to fork from.
 */
export function dropForkCopies(app: App, memberId: string) {
  const s = app.store.getMemberSession(memberId);
  if (!Array.isArray(s.forkCopies)) return;
  const waiting = app.store
    .listMembers()
    .filter((m) => m.id !== memberId && m.config?.forkNext === true)
    .map((m) => app.store.getMemberSession(m.id))
    .filter((x) => x.forkDone !== true && Array.isArray(x.forkCopies))
    .flatMap((x) => (x.forkCopies as unknown[]).map(copyPath));
  for (const c of s.forkCopies as unknown[]) {
    const p = copyPath(c);
    if (!p || !p.endsWith(".jsonl") || !p.includes(`${sep}projects${sep}`)) continue;
    if (waiting.includes(p)) continue;
    if (!(typeof c === "string" ? legacyCopyUnchanged(p) : unchangedCopy(c as TranscriptCopy))) {
      log.info(`kept ${basename(dirname(p))}/${basename(p)}: it changed since it was copied for a duplicated chat`);
      continue;
    }
    try {
      rmSync(p, { force: true });
    } catch (e) {
      log.debug(`couldn't remove ${basename(dirname(p))}/${basename(p)}: ${e}`);
    }
  }
  const { forkCopies: _gone, ...rest } = s;
  app.store.setMemberSession(memberId, rest);
}
