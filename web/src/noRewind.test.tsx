import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Member, Message, Room, Turn } from "@crosstalk/shared";

// A chat whose agent can't go back to an earlier message or take one mid-reply (NO_REWIND_AGENTS, OpenCode). The app offered
// Rewind, Edit, Unsend and Send now there anyway: after two confirmations, and sometimes after stopping the agent, the hub
// said no. What it hasn't read can still be changed or taken back, so those stay.

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { AgentReply, ReadNowNote, YourMessage } = await import("./views/ChatScreen");
const { WorkingPanel } = await import("./views/WorkingPanel");
const { useStore } = await import("./store");

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const room = { id: "r1", name: "Job", cwd: "/tmp/job", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1000, updatedAt: 1000, archived: false, chat: { provider: "opencode", origin: "web" } } as unknown as Room;
const msg = (id: string, authorKind: Message["authorKind"], seq: number, text: string, over: Partial<Message> = {}): Message => ({ id, roomId: "r1", authorKind, memberId: authorKind === "agent" ? "mb1" : null, authorName: authorKind === "agent" ? "opencode" : "Phone", text, mentions: [], turnId: null, status: "done", createdAt: 2000 + seq, updatedAt: 2000 + seq, seq, ...over });
const turn = (id: string, status: Turn["status"], trigger: string, reply: string | null, over: Partial<Turn> = {}): Turn => ({ id, roomId: "r1", memberId: "mb1", triggerMessageId: trigger, replyMessageId: reply, hop: 0, chainId: "c", status, error: null, usage: null, createdAt: 2000, startedAt: 2000, endedAt: null, ...over });

const yours = (over: { canGoBack?: boolean; unread?: boolean; group?: boolean }) => words(renderToStaticMarkup(createElement(YourMessage, { message: msg("h1", "human", 1, "Hello"), handles: [], room, agentName: "Refuseless", ...over })));
const reply = (messages: Message[], index: number, over: { canGoBack?: boolean; readSeq?: number; turn?: Turn; newest?: boolean; canRetry?: boolean }) => words(renderToStaticMarkup(createElement(AgentReply, { room, messages, index, agentName: "Refuseless", busy: false, ...over, children: null })));

test("your message: Edit and Unsend only while the agent hasn't read it", () => {
  const read = yours({ canGoBack: false, unread: false });
  expect(read).not.toContain("Edit");
  expect(read).not.toContain("Unsend");
  // Copy and Ask others have nothing to do with going back.
  expect(read).toContain("Copy");
  for (const shown of [yours({ canGoBack: false, unread: true }), yours({ canGoBack: true, unread: false }), yours({ canGoBack: true, unread: true })]) {
    expect(shown).toContain("Edit");
    expect(shown).toContain("Unsend");
  }
});

test("a reply: Rewind to here only when what it would take back hasn't been read", () => {
  const talk = [msg("h1", "human", 0, "One"), msg("a1", "agent", 1, "First answer."), msg("h2", "human", 2, "Two"), msg("a2", "agent", 3, "Second answer.")];
  expect(reply(talk, 1, { canGoBack: false, readSeq: 3 })).not.toContain("Rewind to here");
  expect(reply(talk, 1, { canGoBack: false, readSeq: 1 })).toContain("Rewind to here");
  expect(reply(talk, 1, { canGoBack: true, readSeq: 3 })).toContain("Rewind to here");
  // A message without a number can't be said to be unread.
  expect(reply([...talk.slice(0, 2), { ...talk[2], seq: undefined }, talk[3]], 1, { canGoBack: false, readSeq: 1 })).not.toContain("Rewind to here");
});

test("a failed reply: Take back only when the agent never got the message, and Try again either way", () => {
  const talk = [msg("h1", "human", 0, "One"), msg("a1", "agent", 1, "Out of money", { status: "error", turnId: "t1" })];
  const failed = turn("t1", "error", "h1", "a1", { error: "Out of money" });
  const read = reply(talk, 1, { canGoBack: false, readSeq: 1, turn: failed, newest: true, canRetry: true });
  expect(read).not.toContain("Take back your message");
  expect(read).toContain("Try again");
  // Read and with nothing else to offer, it isn't held open as if there were a way out to show.
  expect(renderToStaticMarkup(createElement(AgentReply, { room, messages: talk, index: 1, agentName: "Refuseless", busy: false, canGoBack: false, readSeq: 1, turn: failed, newest: true, canRetry: false, children: null }))).not.toContain("agent-reply open");
  expect(reply(talk, 1, { canGoBack: false, readSeq: -1, turn: failed, newest: true, canRetry: true })).toContain("Take back your message");
  expect(reply(talk, 1, { canGoBack: true, readSeq: 1, turn: failed, newest: true, canRetry: true })).toContain("Take back your message");
});

const first = useStore.getInitialState();
const before = { status: first.status, syncing: first.syncing, roomData: first.roomData };
afterEach(() => Object.assign(first, before));

test("a message handed to a reply: Read it now only from an agent that can stop its step for it", () => {
  const note = (provider: Member["provider"]) => {
    Object.assign(first, { roomData: { r1: { messages: [], turns: {}, activities: {}, loaded: true, loading: false, error: null, hasMore: false, totals: null } }, members: { mb1: { id: "mb1", provider } }, approvals: {} });
    return words(renderToStaticMarkup(createElement(ReadNowNote, { room, turn: turn("t1", "running", "h1", "a1"), agentName: "Agent" })));
  };
  expect(note("claude")).toContain("Read it now");
  const builtin = note("builtin");
  expect(builtin).toContain("Agent reads this at its next step.");
  expect(builtin).not.toContain("Read it now");
});

test("a message waiting behind the reply says so, and only an agent that can take it mid-reply offers Send now", () => {
  const member = (provider: Member["provider"]) => ({ id: "mb1", roomId: "r1", handle: provider, provider, model: "m", role: "", permissionMode: "full", status: "working", statusDetail: null, config: {}, createdAt: 1000, position: 0, readSeq: 1 }) as Member;
  const messages = [msg("h1", "human", 1, "One"), msg("a1", "agent", 2, "Working on it", { status: "streaming", turnId: "t1" }), msg("h2", "human", 3, "Two")];
  const turns = [turn("t1", "running", "h1", "a1"), turn("t2", "queued", "h2", null)];
  Object.assign(first, { status: "open", syncing: false, roomData: { r1: { messages, turns: Object.fromEntries(turns.map((t) => [t.id, t])), activities: {}, loaded: true, loading: false, error: null, hasMore: false, totals: null } } });
  const panel = (m: Member) => renderToStaticMarkup(createElement(WorkingPanel, { room, members: [m] }));
  const openCode = panel(member("opencode"));
  expect(words(openCode)).toContain("Your message is waiting for this reply to finish.");
  expect(words(openCode)).not.toContain("Send now");
  const codex = panel(member("codex"));
  expect(words(codex)).toContain("Your message is waiting for this reply to finish.");
  expect(codex).toContain(">Send now</button>");
});
