import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { helperAtWork, limitResetTime, type BackgroundTask, type LimitWait, type Member, type Message, type Room, type Turn } from "@crosstalk/shared";
import { HELPERS_WORDS, noSendNow, onlyFinishingHelpers, quietWait, quietWaitWords, sendNowLine, sendNowState, sendNowWords } from "./sendNow";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { SendNowBar, WorkingPanel } = await import("./views/WorkingPanel");
const { ReadNowNote } = await import("./views/ChatScreen");
const { useStore } = await import("./store");

// What the chat's status says while a message of yours waits on its agent, and what a Send now that didn't go says.
// The bar once said "Your message is waiting for this reply to finish." with no reply running (new settings
// were waiting for the agent's helpers), and Send now answered "It's being answered already, or the reply just ended."

const NOW = Date.UTC(2026, 9, 30, 23, 37, 21);
const MIN = 60_000;
const wait = (patch: Partial<LimitWait> = {}): LimitWait => ({ provider: "claude", account: "default", accountLabel: null, kind: "usage", label: "5-hour", resetsAt: NOW + 33 * MIN, runAt: NOW + 34 * MIN, tries: 1, since: NOW, source: "event", ...patch });
const member = (patch: Partial<Member> = {}) => ({ id: "mb1", status: "working", statusDetail: null, readSeq: 10, ...patch }) as Pick<Member, "id" | "status" | "statusDetail" | "readSeq" | "held">;
const turn = (patch: Partial<Turn>): Turn => ({ id: "t", roomId: "r", memberId: "mb1", triggerMessageId: null, replyMessageId: null, hop: 0, chainId: "c", status: "running", error: null, usage: null, createdAt: NOW - 5 * MIN, startedAt: NOW - 5 * MIN, endedAt: null, ...patch });
const msg = (seq: number, patch: Partial<Message> = {}): Message => ({ id: `m${seq}`, roomId: "r", authorKind: "human", memberId: null, authorName: "Phone", text: `message ${seq}`, mentions: [], turnId: null, status: "done", createdAt: NOW - MIN + seq, updatedAt: NOW, seq, ...patch });
const draw = (line: ReturnType<typeof sendNowLine>) => renderToStaticMarkup(createElement(SendNowBar, { line, onAct: () => {} }));

test("behind a running reply: Send now, as before", () => {
  const state = sendNowState(member(), [turn({ status: "running" }), turn({ id: "q", status: "queued" })], [msg(9), msg(11)]);
  expect(state).toEqual({ kind: "reply" });
  const line = sendNowLine(state!);
  expect(line).toEqual({ text: "Your message is waiting for this reply to finish.", action: "Send now" });
  const html = draw(line);
  expect(html).toContain("Your message is waiting for this reply to finish.");
  expect(html).toContain(">Send now</button>");
});

test("held while new settings wait for the agent's helpers: it says so, and offers Answer now with what that means", () => {
  const held = member({ status: "working", statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true } });
  const state = sendNowState(held, [turn({ id: "q", status: "queued" })], [msg(11)]);
  expect(state).toEqual({ kind: "helpers", held: { change: "settings", helpers: true } });
  const line = sendNowLine(state!);
  expect(line).toEqual({ text: "Your message is waiting for its helpers to finish, so your new settings apply first.", note: "Answer now uses the settings it started with.", action: "Answer now" });
  const html = draw(line);
  expect(html).toContain("waiting for its helpers to finish");
  expect(html).toContain("Answer now uses the settings it started with.");
  expect(html).toContain(">Answer now</button>");
  // Never the old words: there is no reply to finish.
  expect(html).not.toContain("this reply to finish");
  // A hub of 0.6.1 or older holds the same way (its words are known, the newer and the older), but can't answer around
  // the hold: no button that can't work.
  for (const statusDetail of ["Finishing helpers before your new settings apply", "Finishing helpers before applying settings"]) {
    const old = sendNowState(member({ statusDetail }), [turn({ id: "q", status: "queued" })], [msg(11)]);
    expect(old).toEqual({ kind: "helpers" });
    expect(sendNowLine(old!)).toEqual({ text: HELPERS_WORDS });
  }
});

test("an account switch or tighter permissions waiting for the helpers: it says which, and offers no Answer now", () => {
  for (const [change, words] of [
    ["account", "Your message is waiting for its helpers to finish, so your account switch applies first."],
    ["permissions", "Your message is waiting for its helpers to finish, so your permission change applies first."],
    ["other", "Your message is waiting for its helpers to finish, so your changes apply first."],
  ] as const) {
    const held = member({ statusDetail: `Finishing helpers before ${change === "account" ? "your account switch applies" : change === "permissions" ? "your permission change applies" : "your changes apply"}`, held: { change, helpers: true } });
    const state = sendNowState(held, [turn({ id: "q", status: "queued" })], [msg(11)]);
    expect(state).toEqual({ kind: "helpers", held: { change, helpers: true } });
    const line = sendNowLine(state!);
    expect(line).toEqual({ text: words });
    const html = draw(line);
    expect(html).not.toContain("<button");
    expect(html).toContain("send-now paused");
  }
});

test("its helpers done and their report about to be answered by itself: the bar says that reply comes first, and offers no Answer now", () => {
  // The hub's Member.held while Claude Code owes its helpers' report (engine.ts owedTurn): the helpers are done, and a
  // reply of its own is about to start. (The bar used to say it waited for its helpers, with Answer now, and Answer now
  // answered "can't take it yet".)
  const held = member({ statusDetail: "Finishing helpers before your new settings apply", held: { change: "settings", helpers: true, owed: "report" } });
  const state = sendNowState(held, [turn({ id: "q", status: "queued" })], [msg(11)]);
  expect(state).toEqual({ kind: "helpers", held: { change: "settings", helpers: true, owed: "report" } });
  const line = sendNowLine(state!);
  expect(line).toEqual({ text: "It is about to answer its helpers' report by itself. Your message goes after that, on your new settings." });
  expect(draw(line)).not.toContain("<button");
  // A message handed to its last reply, the same way.
  expect(sendNowLine({ kind: "helpers", held: { change: "settings", helpers: false, owed: "message" } }).text).toBe("It is about to answer the message you sent before by itself. This one goes after that, on your new settings.");
  // Under a change it may not answer on, that reply is stopped as it starts and the agent starts again with the change.
  expect(sendNowLine({ kind: "helpers", held: { change: "permissions", helpers: true, owed: "report" } })).toEqual({ text: "Your message is waiting for its helpers to finish, so your permission change applies first." });
  expect(sendNowLine({ kind: "helpers", held: { change: "permissions", helpers: false, owed: "message" } })).toEqual({ text: "Your message is waiting while it starts again, so your permission change applies first." });
  // Once that reply runs, the bar is the running reply's: Send now puts the message into it.
  expect(sendNowLine({ kind: "reply", held: { change: "settings", helpers: false } }).action).toBe("Send now");
});

test("Claude Code's own reply while new settings wait for its helpers: the message waits for that reply and the helpers, and the bar says so", () => {
  const turns = [turn({ status: "running" }), turn({ id: "q", status: "queued" })];
  // A new model: Send now still goes into the reply, and the bar says on which settings that reply runs.
  const model = sendNowState(member({ held: { change: "settings", helpers: true } }), turns, [msg(11)]);
  expect(model).toEqual({ kind: "reply", held: { change: "settings", helpers: true } });
  expect(sendNowLine(model!)).toEqual({ text: "Your message is waiting for this reply and its helpers to finish, so your new settings apply first.", note: "Send now uses the settings it started with.", action: "Send now" });
  // Changed while the reply runs, with no helpers: only the reply.
  expect(sendNowLine({ kind: "reply", held: { change: "settings", helpers: false } }).text).toBe("Your message is waiting for this reply to finish, so your new settings apply first.");
  // An account switch: the reply as it runs never takes it.
  const account = sendNowState(member({ held: { change: "account", helpers: true } }), turns, [msg(11)]);
  const line = sendNowLine(account!);
  expect(line).toEqual({ text: "Your message is waiting for this reply and its helpers to finish, so your account switch applies first." });
  expect(draw(line)).not.toContain("<button");
});

test("paused on a usage limit with a message of yours behind the reply: when it goes, and no button", () => {
  const paused = turn({ status: "waiting", replyMessageId: "m10", wait: wait() });
  const reply = msg(10, { id: "m10", authorKind: "agent", memberId: "mb1", text: "Claude Code is out of messages until 8:10 PM." });
  // The agent goes back to before the reply's own message (readSeq 8): both are unread, only the later one is "behind" it.
  const state = sendNowState(member({ status: "waiting", readSeq: 8 }), [paused], [msg(9), reply, msg(11)]);
  expect(state).toEqual({ kind: "limit", wait: wait() });
  const line = sendNowLine(state!, NOW);
  expect(line.text).toBe(`Paused until your usage limit resets at ${limitResetTime(NOW + 33 * MIN, NOW)}. Your message goes first when it does.`);
  expect(line.action).toBeUndefined();
  const html = draw(line);
  expect(html).toContain("Paused until your usage limit resets at");
  expect(html).not.toContain("<button");
  expect(html).toContain("send-now paused");
  // Only the message the reply was answering: the waiting line under the reply says it all already.
  expect(sendNowState(member({ status: "waiting", readSeq: 8 }), [paused], [msg(9), reply])).toBeNull();
});

test("in a group chat only a message that is this agent's to answer counts", () => {
  const forClaude = (m: Pick<Message, "text">) => !m.text.startsWith("@codex");
  const turns = [turn({ status: "running" }), turn({ id: "q", status: "queued" })];
  // A message for another agent waits for that one: nothing of yours waits on this reply.
  expect(sendNowState(member(), turns, [msg(11, { text: "@codex look at the tests" })], forClaude)).toBeNull();
  expect(sendNowState(member(), turns, [msg(11, { text: "@codex look at the tests" }), msg(12, { text: "and the docs" })], forClaude)).toEqual({ kind: "reply" });
  const paused = turn({ status: "waiting", replyMessageId: "m10", wait: wait() });
  const reply = msg(10, { id: "m10", authorKind: "agent", memberId: "mb1" });
  expect(sendNowState(member({ status: "waiting", readSeq: 8 }), [paused], [msg(9), reply, msg(11, { text: "@codex you take this one" })], forClaude)).toBeNull();
});

test("the limit words follow the wait: a rate limit, no reset time, a reset that is due", () => {
  expect(sendNowLine({ kind: "limit", wait: wait({ kind: "rate" }) }, NOW).text).toStartWith("Paused until the rate limit resets at ");
  expect(sendNowLine({ kind: "limit", wait: wait({ resetsAt: null, source: "none" }) }, NOW).text).toBe("Paused until your usage limit resets. Your message goes first when it does.");
  expect(sendNowLine({ kind: "limit", wait: wait({ resetsAt: NOW + 10_000 }) }, NOW).text).toBe("Paused until your usage limit resets, any moment now. Your message goes first when it does.");
});

test("nothing is said when nothing of yours waits, or when it can't be said truly", () => {
  // No queued turn.
  expect(sendNowState(member(), [turn({ status: "running" })], [msg(11)])).toBeNull();
  // The queued turn is the agent's own (every message of yours is read), or another chat's agent's message.
  expect(sendNowState(member({ readSeq: 12 }), [turn({ status: "running" }), turn({ id: "q", status: "queued" })], [msg(11)])).toBeNull();
  expect(sendNowState(member(), [turn({ status: "running" }), turn({ id: "q", status: "queued" })], [msg(11, { via: { hubId: "h", machine: "Mac mini", chatId: "c2", chatName: "Other", agent: "Codex", hop: 1, kind: "message" } })])).toBeNull();
  // Starting already, or idle.
  expect(sendNowState(member({ status: "queued" }), [turn({ id: "q", status: "queued" })], [msg(11)])).toBeNull();
  expect(sendNowState(member({ status: "idle" }), [], [msg(11)])).toBeNull();
  // Working with no reply and no hold this device knows of (it hasn't heard the turn start): not "this reply".
  expect(sendNowState(member(), [turn({ id: "q", status: "queued" })], [msg(11)])).toBeNull();
  // An older hub (no readSeq): the queued turn is all there is to go on.
  expect(sendNowState(member({ readSeq: undefined }), [turn({ status: "running" }), turn({ id: "q", status: "queued" })], [msg(11)])).toEqual({ kind: "reply" });
});

test("a Send now that didn't go says why, in plain words, never a guess", () => {
  const at = limitResetTime(NOW + 33 * MIN, NOW);
  expect(sendNowWords({ sent: false, why: "limit", wait: wait() }, "Claude Code", NOW)).toBe(`Paused until your usage limit resets at ${at}. Your message goes first when it does.`);
  expect(sendNowWords({ sent: false, why: "helpers" }, "Claude Code", NOW)).toBe(HELPERS_WORDS);
  expect(sendNowWords({ sent: false, why: "helpers", held: { change: "account", helpers: true } }, "Claude Code", NOW)).toBe("Your message is waiting for its helpers to finish, so your account switch applies first.");
  expect(sendNowWords({ sent: false, why: "settings", held: { change: "permissions", helpers: false } }, "Claude Code", NOW)).toBe("Your message is waiting for this reply to finish, so your permission change applies first.");
  expect(sendNowWords({ sent: false, why: "settings", held: { change: "account", helpers: true } }, "Claude Code", NOW)).toBe("Your message is waiting for this reply and its helpers to finish, so your account switch applies first.");
  expect(sendNowWords({ sent: false, why: "notYet" }, "Claude Code", NOW)).toBe("Claude Code can't take it yet. Try Send now again in a moment.");
  expect(sendNowWords({ sent: false, why: "ownTurn", held: { change: "settings", helpers: true, owed: "report" } }, "Claude Code", NOW)).toBe("Claude Code is about to answer its helpers' report by itself. Your message goes after that, on your new settings.");
  expect(sendNowWords({ sent: false, why: "ownTurn", held: { change: "settings", helpers: false, owed: "message" } }, "Claude Code", NOW)).toBe("Claude Code is about to answer the message you sent before by itself. This one goes after that, on your new settings.");
  expect(sendNowWords({ sent: false, why: "answering" }, "Claude Code", NOW)).toBe("Claude Code is already answering your message.");
  expect(sendNowWords({ sent: false, why: "nothing" }, "@codex", NOW)).toBe("Nothing of yours is waiting for @codex.");
  expect(sendNowWords({ sent: false, why: "ended" }, "Claude Code", NOW)).toBe("That reply just ended. Your message starts the next one.");
  expect(sendNowWords({ sent: false, why: "unsupported" }, "Muse Code", NOW)).toBe("Muse Code can't take a message in the middle of a reply. Yours goes as soon as this one ends.");
  // An older hub says only that it didn't.
  expect(sendNowWords({ sent: false }, "Claude Code", NOW)).toBe("Couldn't send it now. Your message still waits its turn.");
  for (const why of ["limit", "helpers", "settings", "answering", "nothing", "ended", "notYet", "ownTurn", "unsupported", undefined] as const) {
    expect(sendNowWords({ sent: false, why, ...(why === "limit" ? { wait: wait() } : {}) }, "Claude Code", NOW)).not.toContain("being answered already, or the reply just ended");
  }
});

// By default, nobody is asked to tap Send now while helpers work in the background: a hub that says messagesFlow delivers
// a message by itself while the agent's helpers work, and the app shows nothing to tap.
const AT_WORK = { helpers: true };
const DONE = { helpers: false };
const behindReply = [turn({ status: "running" }), turn({ id: "q", status: "queued" })];
const heldOnly = [turn({ id: "q", status: "queued" })];
const HELD = { change: "settings", helpers: true } as const;

test("helpers at work and a reply running: no bar, with or without new settings waiting, and for an agent with no mid-reply form", () => {
  expect(sendNowState(member(), behindReply, [msg(11)], undefined, AT_WORK)).toBeNull();
  expect(sendNowState(member({ held: HELD }), behindReply, [msg(11)], undefined, AT_WORK)).toBeNull();
  // The agent's own reply as its helpers report back is one.
  expect(sendNowState(member({ held: { ...HELD, owed: "report" } }), behindReply, [msg(11)], undefined, AT_WORK)).toBeNull();
});

test("helpers at work and no reply running, with only what it may answer around waiting: no bar, whatever else it may be waiting its turn for", () => {
  const finishing = member({ statusDetail: "Finishing helpers before your new settings apply", held: HELD });
  expect(sendNowState(finishing, heldOnly, [msg(11)], undefined, AT_WORK)).toBeNull();
  // In a group chat, its turn waits for another agent's reply: "waiting for its helpers" would be untrue.
  expect(sendNowState(finishing, [turn({ id: "other", memberId: "mb2", status: "running" }), ...heldOnly], [msg(11)], undefined, AT_WORK)).toBeNull();
  // Those helpers finish before this device hears the turn start: still nothing to tap.
  expect(sendNowState(finishing, heldOnly, [msg(11)], undefined, DONE)).toBeNull();
});

test("an account switch, tighter permissions or a new folder still hold it, in the same plain words, with no button", () => {
  for (const [change, words] of [
    ["account", "your account switch applies first."],
    ["permissions", "your permission change applies first."],
    ["other", "your changes apply first."],
  ] as const) {
    const held = { change, helpers: true };
    const noReply = sendNowState(member({ statusDetail: `Finishing helpers before ${words}`, held }), heldOnly, [msg(11)], undefined, AT_WORK);
    expect(noReply).toEqual({ kind: "helpers", held, flowing: true });
    expect(sendNowLine(noReply!)).toEqual({ text: `Your message is waiting for its helpers to finish, so ${words}` });
    expect(draw(sendNowLine(noReply!))).not.toContain("<button");
    const reply = sendNowState(member({ held }), behindReply, [msg(11)], undefined, AT_WORK);
    expect(reply).toEqual({ kind: "reply", held });
    expect(sendNowLine(reply!)).toEqual({ text: `Your message is waiting for this reply and its helpers to finish, so ${words}` });
    expect(draw(sendNowLine(reply!))).not.toContain("<button");
    // Nor is such a message "going when the reply ends": it isn't.
    expect(quietWait(member({ held }), behindReply, [msg(11)], undefined, AT_WORK)).toBeNull();
  }
});

test("a usage limit and the agent's own wake-up say what they always said, with no button", () => {
  const paused = turn({ status: "waiting", replyMessageId: "m10", wait: wait() });
  const reply = msg(10, { id: "m10", authorKind: "agent", memberId: "mb1" });
  expect(sendNowState(member({ status: "waiting", readSeq: 8 }), [paused], [msg(9), reply, msg(11)], undefined, AT_WORK)).toEqual({ kind: "limit", wait: wait() });
  // Its helpers are done: the reply it owes, then yours on the new settings.
  const owed = sendNowState(member({ statusDetail: "Finishing helpers before your new settings apply", held: { ...HELD, owed: "report" } }), heldOnly, [msg(11)], undefined, DONE);
  expect(sendNowLine(owed!)).toEqual({ text: "It is about to answer its helpers' report by itself. Your message goes after that, on your new settings." });
  // Others still work: yours goes after that reply on the settings it started with, so it doesn't say otherwise.
  const others = sendNowState(member({ statusDetail: "Finishing helpers before your new settings apply", held: { ...HELD, owed: "report" } }), heldOnly, [msg(11)], undefined, AT_WORK);
  expect(sendNowLine(others!)).toEqual({ text: "It is about to answer its helpers' report by itself. Your message goes after that." });
  expect(sendNowLine({ kind: "helpers", held: { ...HELD, owed: "message" }, flowing: true }).text).toBe("It is about to answer the message you sent before by itself. This one goes after that.");
  expect(draw(sendNowLine(others!))).not.toContain("<button");
});

test("no helpers at work: the bar and Send now, as ever, new settings waiting or not", () => {
  const plain = sendNowState(member(), behindReply, [msg(11)], undefined, DONE);
  expect(plain).toEqual({ kind: "reply" });
  expect(sendNowLine(plain!)).toEqual({ text: "Your message is waiting for this reply to finish.", action: "Send now" });
  const held = { change: "settings", helpers: false } as const;
  const waiting = sendNowState(member({ held }), behindReply, [msg(11)], undefined, DONE);
  expect(waiting).toEqual({ kind: "reply", held });
  expect(sendNowLine(waiting!)).toEqual({ text: "Your message is waiting for this reply to finish, so your new settings apply first.", note: "Send now uses the settings it started with.", action: "Send now" });
  expect(quietWait(member(), behindReply, [msg(11)], undefined, DONE)).toBeNull();
});

test("a hub that doesn't say messagesFlow holds the message itself: its buttons are the only way to send it, so they stay", () => {
  const held = member({ statusDetail: "Finishing helpers before your new settings apply", held: HELD });
  expect(sendNowLine(sendNowState(held, heldOnly, [msg(11)])!).action).toBe("Answer now");
  expect(sendNowLine(sendNowState(member(), behindReply, [msg(11)])!).action).toBe("Send now");
  expect(quietWait(member(), behindReply, [msg(11)])).toBeNull();
});

test("the small label: on your newest message that goes when the reply ends, and only while that's so", () => {
  expect(quietWait(member(), behindReply, [msg(9), msg(11), msg(12)], undefined, AT_WORK)).toBe("m12");
  expect(quietWait(member({ held: HELD }), behindReply, [msg(11)], undefined, AT_WORK)).toBe("m11");
  expect(quietWaitWords()).toBe("Goes when this reply ends.");
  expect(quietWaitWords("@codex")).toBe("Goes when @codex's reply ends.");
  // Nothing behind the reply, nothing running, or read already (the hub handed it over): no label.
  expect(quietWait(member(), [turn({ status: "running" })], [msg(11)], undefined, AT_WORK)).toBeNull();
  expect(quietWait(member(), heldOnly, [msg(11)], undefined, AT_WORK)).toBeNull();
  expect(quietWait(member({ readSeq: 12 }), behindReply, [msg(11)], undefined, AT_WORK)).toBeNull();
  // Only what's this agent's to answer.
  expect(quietWait(member(), behindReply, [msg(11, { text: "@codex you take this" })], (m) => !m.text.startsWith("@codex"), AT_WORK)).toBeNull();
});

test("an agent only waiting for its helpers so a change can apply isn't in the way of Try again or Answer now, for as long as they run", () => {
  for (const statusDetail of ["Finishing helpers before your new settings apply", "Finishing helpers before your account switch applies", "Finishing helpers before your permission change applies", "Finishing helpers before your changes apply"]) expect(onlyFinishingHelpers(member({ statusDetail }))).toBe(true);
  // Anything else it says, or any other state, is it working.
  expect(onlyFinishingHelpers(member({ statusDetail: null }))).toBe(false);
  expect(onlyFinishingHelpers(member({ statusDetail: "bun test" }))).toBe(false);
  expect(onlyFinishingHelpers(member({ status: "thinking", statusDetail: "Finishing helpers before your new settings apply" }))).toBe(false);
  expect(onlyFinishingHelpers(member({ status: "queued", statusDetail: null }))).toBe(false);
});

test("what counts as a helper at work: what the Helpers panel lists as working, never the reply's own foreground command", () => {
  const task = (patch: Partial<BackgroundTask>) => ({ status: "running", kind: "local_agent", background: false, ...patch }) as BackgroundTask;
  expect(helperAtWork(task({}))).toBe(true);
  expect(helperAtWork(task({ kind: "local_workflow", background: true }))).toBe(true);
  expect(helperAtWork(task({ kind: "local_bash", background: true }))).toBe(true);
  expect(helperAtWork(task({ kind: "local_bash", background: false }))).toBe(false);
  for (const status of ["completed", "failed", "killed", "stopped"] as const) expect(helperAtWork(task({ status }))).toBe(false);
});

// The status panel and the note on a handed message, as the chat draws them.
describe("as the chat draws it", () => {
  const first = useStore.getInitialState();
  const before = { status: first.status, syncing: first.syncing, roomData: first.roomData, hub: first.hub, tasks: first.tasks, members: first.members, approvals: first.approvals };
  afterEach(() => Object.assign(first, before));
  const room = { id: "r", name: "Job", cwd: "/tmp/job", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1000, updatedAt: 1000, archived: false, chat: { provider: "claude", origin: "web" } } as unknown as Room;
  const running = (status: BackgroundTask["status"]): BackgroundTask => ({ id: "h1", kind: "local_agent", description: "Checking the work", agentType: null, workflow: null, background: true, status, startedAt: NOW - MIN, endedAt: status === "running" ? null : NOW, tokens: null, toolUses: null, lastTool: null, summary: null, error: null });
  const person = (patch: Partial<Member> = {}) => ({ roomId: "r", handle: "claude", provider: "claude", model: "m", role: "", permissionMode: "full", config: {}, createdAt: 1000, position: 0, ...member(patch) }) as unknown as Member;
  const draws = (m: Member, opts: { flows?: boolean; task?: BackgroundTask["status"] }) => {
    const turns = behindReply;
    Object.assign(first, { status: "open", syncing: false, hub: { version: "0.6.7", hostname: "h", platform: "darwin", workspaceRoot: "/", publicUrl: null, ...(opts.flows === undefined ? {} : { messagesFlow: opts.flows }) }, tasks: opts.task ? { mb1: [running(opts.task)] } : {}, members: { mb1: m }, approvals: {}, roomData: { r: { messages: [msg(11)], turns: Object.fromEntries(turns.map((t) => [t.id, t])), activities: {}, loaded: true, loading: false, error: null, hasMore: false, totals: null } } });
    return renderToStaticMarkup(createElement(WorkingPanel, { room, members: [m] }));
  };

  test("the bar goes only for a hub that delivers it by itself, and only while helpers work", () => {
    expect(draws(person(), { flows: true, task: "running" })).not.toContain("send-now");
    expect(draws(person({ held: HELD }), { flows: true, task: "running" })).not.toContain("send-now");
    expect(draws(person(), { flows: true, task: "running" })).not.toContain("<button class=\"btn small primary\"");
    // No helpers at work, one finished, the switch off, or an older hub that won't send it by itself: the bar, with Send now.
    for (const opts of [{ flows: true }, { flows: true, task: "completed" as const }, { flows: false, task: "running" as const }, { task: "running" as const }]) expect(draws(person(), opts)).toContain(">Send now</button>");
    // What must still hold says so, with nothing to tap.
    const account = draws(person({ held: { change: "account", helpers: true } }), { flows: true, task: "running" });
    expect(account).toContain("so your account switch applies first.");
    expect(account).not.toContain("Send now</button>");
  });

  test("the switch off, with new settings waiting and no reply running: the bar and Answer now; an account switch or the like still has no button", () => {
    const finishing = (held: Member["held"]) => {
      const m = person({ statusDetail: "Finishing helpers before your new settings apply", held });
      Object.assign(first, { status: "open", syncing: false, hub: { version: "0.6.7", hostname: "h", platform: "darwin", workspaceRoot: "/", publicUrl: null, messagesFlow: false }, tasks: { mb1: [running("running")] }, members: { mb1: m }, approvals: {}, roomData: { r: { messages: [msg(11)], turns: Object.fromEntries(heldOnly.map((t) => [t.id, t])), activities: {}, loaded: true, loading: false, error: null, hasMore: false, totals: null } } });
      return renderToStaticMarkup(createElement(WorkingPanel, { room, members: [m] }));
    };
    const bar = finishing(HELD);
    expect(bar).toContain("Your message is waiting for its helpers to finish, so your new settings apply first.");
    expect(bar).toContain("Answer now uses the settings it started with.");
    expect(bar).toContain(">Answer now</button>");
    for (const [change, words] of [["account", "your account switch applies first."], ["permissions", "your permission change applies first."], ["other", "your changes apply first."]] as const) {
      const held = finishing({ change, helpers: true });
      expect(held).toContain(`Your message is waiting for its helpers to finish, so ${words}`);
      expect(held).not.toContain("Answer now</button>");
      expect(held).not.toContain("Send now</button>");
    }
  });

  test("a message handed over by itself: a small label and no Read it now, until the helpers are done", () => {
    const note = (opts: { flows?: boolean; task?: BackgroundTask["status"] }) => {
      draws(person(), opts);
      return renderToStaticMarkup(createElement(ReadNowNote, { room, turn: turn({ status: "running", unread: ["m11"] }), agentName: "Claude Code" }));
    };
    const quiet = note({ flows: true, task: "running" });
    expect(quiet).toContain("msg-quiet");
    expect(quiet).toContain("Claude Code reads this at its next step.");
    expect(quiet).not.toContain("<button");
    for (const opts of [{ flows: true, task: "completed" as const }, { flows: false, task: "running" as const }, { task: "running" as const }]) {
      const full = note(opts);
      expect(full).toContain("read-now");
      expect(full).toContain(">Read it now</button>");
    }
  });
});

test("an agent that can't take a message mid-reply keeps its line with no button once its helpers are done", () => {
  expect(noSendNow(sendNowLine(sendNowState(member(), behindReply, [msg(11)], undefined, DONE)!))).toEqual({ text: "Your message is waiting for this reply to finish." });
});
