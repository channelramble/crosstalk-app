import { expect, test } from "bun:test";
import type { Member, Turn } from "@crosstalk/shared";
import { answersLine, groupMatches, groupNames, groupState, notAnswered, notAnsweredLine, queueLine, readersOf, retriedTurns, sendLabel, sendName, suggestHandles, whoAnswers, workQueue } from "./groupChat";

const member = (handle: string, provider: Member["provider"], position: number, readSeq = 0): Member => ({ id: `mb_${handle}`, roomId: "r", handle, provider, model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: position, position, readSeq });
const claude = member("claude", "claude", 0);
const codex = member("codex", "codex", 1);
const sonnet = member("sonnet", "claude", 2);
const team = [claude, codex, sonnet];
const lead = (id: string | null, mode: "direct" | "roundrobin" | "review" = "direct") => ({ mode, leadMemberId: id });

test("with no @mention the lead answers, or everyone in turn with the lead first, or the lead builds and the next checks", () => {
  expect(whoAnswers(lead(null), team, "Fix the login")).toEqual({ who: [claude], how: "lead" });
  expect(whoAnswers(lead(codex.id), team, "Fix the login")).toEqual({ who: [codex], how: "lead" });
  expect(whoAnswers(lead(codex.id, "roundrobin"), team, "Ideas?")).toEqual({ who: [codex, claude, sonnet], how: "turns" });
  expect(whoAnswers(lead(sonnet.id, "review"), team, "Build it")).toEqual({ who: [sonnet, claude], how: "review" });
});

test("an @mention means only who it names answers, in the order written; @all and @everyone mean everyone, lead first", () => {
  expect(whoAnswers(lead(null, "roundrobin"), team, "@sonnet and @CODEX, opinions?")).toEqual({ who: [sonnet, codex], how: "named" });
  expect(whoAnswers(lead(codex.id), team, "@all quick check")).toEqual({ who: [codex, claude, sonnet], how: "all" });
  expect(whoAnswers(lead(null), team, "@everyone done?").how).toBe("all");
  // Not a mention: code, an email address, a path, a name nobody has.
  for (const draft of ["run `@codex` later", "mail me@codex.io", "import @codex/sdk", "@gemini?"]) expect(whoAnswers(lead(null), team, draft)).toEqual({ who: [claude], how: "lead" });
});

test("the chip row says who answers and in what order; the send button names them when the draft does", () => {
  expect(answersLine(whoAnswers(lead(null), team, "hi"))).toBe("@claude answers. Type @ to pick who answers.");
  expect(answersLine(whoAnswers(lead(null, "roundrobin"), team, "hi"))).toBe("Everyone answers, in turn: @claude, then @codex, then @sonnet.");
  expect(answersLine(whoAnswers(lead(null, "review"), team, "hi"))).toBe("@claude builds it, then @codex checks the work.");
  expect(answersLine(whoAnswers(lead(null), team, "@codex @sonnet look"))).toBe("Only @codex and @sonnet will answer. The others read it on their next turn.");
  expect(answersLine(whoAnswers(lead(null), team, "@all look"))).toBe("Everyone answers, in turn: @claude, then @codex, then @sonnet.");
  expect(answersLine(whoAnswers(lead(null), [], "hi"))).toBe("No agents in this chat yet. Add one in the chat's settings.");

  expect(sendLabel(whoAnswers(lead(null), team, "hi"))).toBeNull();
  expect(sendLabel(whoAnswers(lead(null, "roundrobin"), team, "hi"))).toBeNull();
  expect(sendLabel(whoAnswers(lead(null), team, "@codex look"))).toBe("Send to @codex");
  expect(sendLabel(whoAnswers(lead(null), team, "@codex @sonnet look"))).toBe("Send to 2");
  expect(sendLabel(whoAnswers(lead(null), team, "@all look"))).toBe("Send to all");
  // The full name starts with the button's own words (next test), then says who.
  expect(sendName(whoAnswers(lead(null), team, "@codex look"))).toBe("Send to @codex");
  expect(sendName(whoAnswers(lead(null), team, "@codex @sonnet look"))).toBe("Send to 2: @codex and @sonnet");
  expect(sendName(whoAnswers(lead(codex.id), team, "@all look"))).toBe("Send to all: @codex, then @claude, then @sonnet");
  expect(sendName(whoAnswers(lead(null), team, "look"))).toBe("Send");
  expect(groupNames(team)).toBe("@claude, @codex and @sonnet");
});

// sendName's words have to start from the words on the button (WCAG 2.5.3, Label in Name): someone driving the phone by
// voice says what the button says. Until 0.6.2 "Send to 2" was not in "Send to @codex and @sonnet", nor "Send to all" in
// "Send to everyone: …", so those two taps couldn't be asked for out loud.
test("the send button's accessible name contains the words written on it", () => {
  for (const draft of ["@codex look", "@codex @sonnet look", "@all look"]) {
    const answering = whoAnswers(lead(null), team, draft);
    const written = sendLabel(answering);
    expect(written).not.toBeNull();
    expect(sendName(answering)).toContain(written!);
  }
});

test("the turn order shows who works now and who's next, in the order their turns were queued", () => {
  const turn = (m: Member, status: Turn["status"], createdAt: number, startedAt: number | null = null) => ({ memberId: m.id, status, createdAt, startedAt });
  const q = workQueue(team, [turn(sonnet, "queued", 30), turn(codex, "running", 10, 12), turn(claude, "queued", 20), turn(claude, "done", 1, 2), turn(sonnet, "queued", 40)]);
  expect(q).toEqual({ now: [codex], next: [claude, sonnet] });
  expect(queueLine(q)).toBe("Now: @codex · Next: @claude, then @sonnet");
  expect(queueLine(workQueue(team, []))).toBeNull();
});

test("who has read a message, and who still has to answer your newest one", () => {
  const read = [member("claude", "claude", 0, 12), member("codex", "codex", 1, 9), member("sonnet", "claude", 2, 12)];
  expect(readersOf(read, 10).map((m) => m.handle)).toEqual(["claude", "sonnet"]);
  expect(readersOf(read, undefined)).toEqual([]);
  // Everyone in turn: Codex never got it.
  expect(notAnswered(lead(null, "roundrobin"), read, { seq: 11, text: "go", mentions: [] }, false).map((m) => m.handle)).toEqual(["codex"]);
  // For the lead only, who read it: nothing to answer now.
  expect(notAnswered(lead(null), read, { seq: 11, text: "go", mentions: [] }, false)).toEqual([]);
  expect(notAnswered(lead(null), read, { seq: 11, text: "@codex go", mentions: [read[1].id] }, false).map((m) => m.handle)).toEqual(["codex"]);
  // While anything works, or on a hub that doesn't say what they read, nothing is offered.
  expect(notAnswered(lead(null, "roundrobin"), read, { seq: 11, text: "go", mentions: [] }, true)).toEqual([]);
  expect(notAnswered(lead(null), [{ ...read[0], readSeq: undefined }], { seq: 11, text: "go", mentions: [] }, false)).toEqual([]);
});

test("Answer now is for whoever hasn't answered: another agent's reply after your message doesn't count, theirs does", () => {
  const read = [member("claude", "claude", 0, 12), member("codex", "codex", 1, 9)];
  const go = { seq: 11, text: "go", mentions: [] };
  // Everyone in turn: Claude Code answered, then Stop everything stopped Codex's turn before it started.
  const after = [{ authorKind: "agent" as const, memberId: read[0].id }];
  expect(notAnswered(lead(null, "roundrobin"), read, go, false, after).map((m) => m.handle)).toEqual(["codex"]);
  expect(notAnsweredLine(notAnswered(lead(null, "roundrobin"), read, go, false, after))).toBe("Not answered by @codex");
  // Codex's reply failed before it read it: Try again is under that reply instead.
  expect(notAnswered(lead(null, "roundrobin"), read, go, false, [...after, { authorKind: "agent", memberId: read[1].id }])).toEqual([]);
  // A note from Crosstalk isn't an answer.
  expect(notAnswered(lead(null, "roundrobin"), read, go, false, [{ authorKind: "system", memberId: null }]).map((m) => m.handle)).toEqual(["codex"]);
  expect(notAnsweredLine([codex, sonnet])).toBe("Not answered by @codex and @sonnet");
  expect(notAnsweredLine([])).toBe("Not answered");
});

test("a failed reply counts as answered only by a later reply of the same agent in a group chat", () => {
  const t = (id: string, m: Member, status: Turn["status"], createdAt: number, triggerMessageId: string | null = "ship") => ({ id, memberId: m.id, triggerMessageId, status, createdAt });
  // Both failed on "ship it"; Codex's Try again then answered it.
  const turns = [t("a", claude, "error", 1), t("b", codex, "error", 2), t("c", codex, "done", 3)];
  expect([...retriedTurns(turns, true)]).toEqual(["b"]);
  // In a chat with one agent, any later reply to it (an older hub's chat had one agent per turn anyway).
  expect([...retriedTurns(turns, false)].sort()).toEqual(["a", "b"]);
  // Not an earlier one, not one still running, not without the message it was answering.
  expect([...retriedTurns([t("a", claude, "error", 5), t("b", claude, "done", 4), t("c", claude, "running", 6)], true)]).toEqual([]);
  expect([...retriedTurns([t("a", claude, "error", 1, null), t("b", claude, "done", 2, null)], true)]).toEqual([]);
});

test("the drawer's search finds a group chat by its agents", () => {
  expect(groupMatches(team, "@sonnet")).toBe(true);
  expect(groupMatches(team, "codex")).toBe(true);
  expect(groupMatches(team, "claude code")).toBe(true);
  expect(groupMatches(team, "gemini")).toBe(false);
  expect(groupMatches(team, " ")).toBe(false);
});

test("a group chat is as busy as its busiest agent", () => {
  const with_ = (status: Member["status"]) => ({ status });
  expect(groupState([with_("idle"), with_("approval"), with_("working")])).toBe("approval");
  expect(groupState([with_("error"), with_("queued")])).toBe("queued");
  expect(groupState([with_("idle")])).toBe("idle");
  expect(groupState([])).toBeUndefined();
});

test("a new group chat's agents get the @names the hub will give them", () => {
  expect(suggestHandles([{ provider: "claude", accountLabel: null, given: "" }, { provider: "codex", accountLabel: null, given: "" }, { provider: "claude", accountLabel: null, given: "" }])).toEqual(["claude", "codex", "claude-2"]);
  expect(suggestHandles([{ provider: "codex", accountLabel: "Team Work", given: "" }, { provider: "claude", accountLabel: null, given: "Second Opinion" }, { provider: "claude", accountLabel: null, given: "everyone" }])).toEqual(["team-work", "second-opinion", "everyone-agent"]);
});
