import { expect, test } from "bun:test";
import type { Ask, AskChoice, Message } from "@crosstalk/shared";
import { ASK_NOTE_MAX, ASK_OTHER_MACHINES_LINE, ASK_PRIVACY_LINE, afterAsked, askActions, askAgentName, askBadges, askButtonLabel, askButtonName, askCardText, askChipNote, askCostHint, askDuration, askGroups, askNames, askOnlyLine, askPrivacyLine, askProblem, askRowSub, askTargetKey, asksByMessage, chipText, copiedUntil, hasMention, insertQuote, isOwnAgent, keepSilentMachines, mentionCandidates, mentionedChoices, mentionsIn, mergeAsks, quotedAnswer, readTargets, sendPlan, sortChoices, theMachine, upsertAsks, withoutMention, withoutMentions, type SendInput } from "./asks";

const T = 1_800_000_000_000;
const ask = (id: string, patch: Partial<Ask> = {}): Ask => ({
  id, roomId: "r1", messageId: "m1", target: { provider: "codex", account: "default", model: "gpt-5.5", effort: null }, label: "Codex · GPT-5.5",
  status: "done", answer: "Looks fine.", error: null, cost: { costUsd: 0.04, basis: "exact", inputTokens: 100, outputTokens: 20 }, note: null, local: false,
  createdAt: T, startedAt: T + 1000, endedAt: T + 13_000, ...patch,
});
const choice = (handle: string, patch: Partial<AskChoice> = {}): AskChoice => ({
  target: { provider: "codex", account: "default", model: handle, effort: null }, label: `Name ${handle}`, sub: "a model", handle,
  paid: "no", local: false, available: true, why: null, typicalCostUsd: null, ...patch,
});

test("asks are grouped by the message they're about, oldest first", () => {
  const grouped = asksByMessage([ask("c", { messageId: "m2", createdAt: T + 5 }), ask("b", { createdAt: T + 2 }), ask("a", { createdAt: T + 1 }), ask("d", { createdAt: T + 2 })]);
  expect([...grouped.keys()].sort()).toEqual(["m1", "m2"]);
  expect(grouped.get("m1")!.map((a) => a.id)).toEqual(["a", "b", "d"]);
  expect(asksByMessage([]).size).toBe(0);
});

test("a finished card shows what it cost and how long it took", () => {
  expect(askCardText(ask("a")).cost).toBe("$0.04 · 12 s");
  expect(askCardText(ask("a", { cost: { costUsd: null, basis: "plan", inputTokens: 1, outputTokens: 1 } })).cost).toBe("Plan · 12 s");
  expect(askCardText(ask("a", { cost: { costUsd: null, basis: "free", inputTokens: 1, outputTokens: 1 }, local: true })).cost).toBe("Free · 12 s");
  expect(askCardText(ask("a", { cost: { costUsd: 0.5, basis: "estimated", inputTokens: 1, outputTokens: 1 }, endedAt: T + 66_000 })).cost).toBe("≈$0.50 · 1 min 5 s");
  expect(askCardText(ask("a", { cost: { costUsd: null, basis: "unknown", inputTokens: 1, outputTokens: 1 } })).cost).toBe("— · 12 s");
  // No cost reported: just the time. No times either: nothing to say.
  expect(askCardText(ask("a", { cost: null })).cost).toBe("12 s");
  expect(askCardText(ask("a", { cost: null, startedAt: null, endedAt: null })).cost).toBeNull();
});

test("a card that is still working says so, with no cost yet", () => {
  const running = askCardText(ask("a", { status: "running", answer: null, cost: null, endedAt: null }));
  expect(running).toEqual({ state: "reading", status: "Reading…", problem: null, cost: null, answer: null });
  expect(askCardText(ask("a", { status: "queued", answer: null, cost: null, startedAt: null, endedAt: null })).status).toBe("Waiting…");
  const stopped = askCardText(ask("a", { status: "stopped", answer: "Half an answ", endedAt: T + 4000 }));
  expect(stopped.status).toBe("Stopped");
  expect(stopped.answer).toBe("Half an answ");
  expect(stopped.cost).toBe("$0.04 · 3 s");
});

test("an error card shows the hub's sentence as it is, and a plain line that says who when the hub gave none", () => {
  const text = (error: string | null) => askCardText(ask("a", { status: "error", answer: null, error })).problem;
  // What the hub stores in Ask.error is already the whole sentence (hub/src/asks.ts), so the card must not wrap it again.
  for (const stored of [
    "Codex couldn't answer: Rate limited.",
    "Codex took longer than 3 minutes, so Crosstalk stopped it.",
    "Crosstalk restarted before this answered.",
    "API key reached its $250 limit, so this reply didn't start.",
  ]) {
    expect(text(stored)).toBe(stored);
  }
  expect(text("Codex couldn't answer: Rate limited.")?.match(/couldn't answer/g)).toHaveLength(1);
  expect(text("  Codex couldn't answer: Rate limited.\n")).toBe("Codex couldn't answer: Rate limited.");
  // Nothing stored: a plain line that says who.
  expect(text(null)).toBe("Codex couldn't answer: something went wrong.");
  expect(text("  ")).toBe("Codex couldn't answer: something went wrong.");
  expect(askCardText(ask("a")).problem).toBeNull();
  expect(askCardText(ask("a", { status: "stopped", error: "Codex couldn't answer: x." })).problem).toBeNull();
  expect(askAgentName({ label: "Codex · GPT-5.5" })).toBe("Codex");
  expect(askAgentName({ label: "Llama" })).toBe("Llama");
});

test("how long it took reads short", () => {
  expect(askDuration(300)).toBe("1 s");
  expect(askDuration(12_000)).toBe("12 s");
  expect(askDuration(60_000)).toBe("1 min");
  expect(askDuration(125_000)).toBe("2 min 5 s");
  expect(askDuration(3_600_000)).toBe("1 h");
  expect(askDuration(3_900_000)).toBe("1 h 5 min");
});

test("each state of a card offers its own buttons", () => {
  const offer = (patch: Partial<Ask>) => Object.entries(askActions(ask("a", patch))).filter(([, on]) => on).map(([name]) => name);
  expect(offer({ status: "running", answer: null })).toEqual(["stop"]);
  expect(offer({ status: "queued", answer: null })).toEqual(["stop"]);
  expect(offer({})).toEqual(["send", "copy", "remove"]);
  expect(offer({ status: "error", answer: null, error: "x" })).toEqual(["retry", "remove"]);
  expect(offer({ status: "stopped", answer: null })).toEqual(["remove"]);
  // What came in before Stop can still be sent or copied.
  expect(offer({ status: "stopped", answer: "so far" })).toEqual(["send", "copy", "remove"]);
});

test("Send to the chat quotes the answer under the agent's name and leaves a blank line to write on", () => {
  expect(quotedAnswer(ask("a", { answer: "Looks fine." }))).toBe("> Codex's answer: Looks fine.\n\n");
  expect(quotedAnswer(ask("a", { answer: "  First line\n\n- second   \nthird\n" }))).toBe("> Codex's answer: First line\n>\n> - second\n> third\n\n");
  // After what's already in the box, with a blank line between.
  expect(insertQuote("", "> q\n\n")).toBe("> q\n\n");
  expect(insertQuote("  \n", "> q\n\n")).toBe("> q\n\n");
  expect(insertQuote("Check this\n", "> q\n\n")).toBe("Check this\n\n> q\n\n");
});

test("@names in a draft are read as the hub's handles, anywhere but in code or a quote", () => {
  const choices = [choice("codex"), choice("gpt-5.5"), choice("llama")];
  const names = (draft: string) => mentionedChoices(draft, choices).map((c) => c.handle);
  expect(names("@codex what do you think?")).toEqual(["codex"]);
  expect(names("ask @Codex and @llama, please")).toEqual(["codex", "llama"]);
  // Once each, in the order written.
  expect(names("@llama @codex @llama")).toEqual(["llama", "codex"]);
  // A dot or dash ending a sentence isn't part of the name; a dot inside one is.
  expect(names("Is that right, @codex?")).toEqual(["codex"]);
  expect(names("Is that right @codex.")).toEqual(["codex"]);
  expect(names("and @gpt-5.5.")).toEqual(["gpt-5.5"]);
  // Not a handle, a longer word, an email address, code or a quote.
  expect(names("@someone @codexx a@codex.com")).toEqual([]);
  expect(names("run `@codex` or\n```\n@llama\n```")).toEqual([]);
  expect(names("> Codex's answer: tell @llama\n\nand me")).toEqual([]);
  expect(names("")).toEqual([]);
  // Where each one is, for taking it out again.
  const found = mentionsIn("hi @codex.", choices);
  expect(found.map((m) => [m.start, m.end])).toEqual([[3, 9]]);
});

test("taking a chip away takes its @name out of the draft", () => {
  const choices = [choice("codex"), choice("llama")];
  const [codex] = choices;
  expect(withoutMention("@codex what do you think?", codex, choices)).toBe("what do you think?");
  expect(withoutMention("so, @codex, what now?", codex, choices)).toBe("so,, what now?");
  expect(withoutMention("what do you think @codex", codex, choices)).toBe("what do you think");
  expect(withoutMention("@codex and @llama and @codex", codex, choices)).toBe("and @llama and");
  expect(withoutMention("`@codex` stays", codex, choices)).toBe("`@codex` stays");
});

test("the @ popup lists matches by handle or name, without the chat's own agent, and what can't be asked last", () => {
  const own = { provider: "claude", account: "default", model: null };
  const claude = choice("claude", { target: { provider: "claude", account: "default", model: null, effort: null }, label: "Claude Code" });
  const claudeWork = choice("claude-work", { target: { provider: "claude", account: "work", model: null, effort: null }, label: "Claude Code (work)" });
  const codex = choice("codex", { label: "Codex · GPT-5.5" });
  const gpt = choice("gpt", { label: "GPT-5.5 online", available: false, why: "Over its $250 limit" });
  const choices = [claude, gpt, claudeWork, codex];
  expect(mentionCandidates(choices, "", own).map((c) => c.handle)).toEqual(["claude-work", "codex", "gpt"]);
  expect(mentionCandidates(choices, "codex", own).map((c) => c.handle)).toEqual(["codex"]);
  expect(mentionCandidates(choices, "co", own).map((c) => c.handle)).toEqual(["claude-work", "codex"]);
  // Part of the name counts too, from anywhere in it.
  expect(mentionCandidates(choices, "gpt-5", own).map((c) => c.handle)).toEqual(["codex", "gpt"]);
  expect(mentionCandidates(choices, "CLAUDE", own).map((c) => c.handle)).toEqual(["claude-work"]);
  expect(mentionCandidates(choices, "zzz", own)).toEqual([]);
  expect(mentionCandidates(Array.from({ length: 12 }, (_, i) => choice(`m${i}`)), "", null)).toHaveLength(8);
  // Same agent and account and the same model (or none named): its own. Another model, account or agent is somebody else.
  const target = (provider: string, account: string, model: string | null) => ({ provider, account, model, effort: null }) as AskChoice["target"];
  expect(isOwnAgent(target("claude", "default", null), own)).toBe(true);
  expect(isOwnAgent(target("claude", "default", "opus"), { ...own, model: "opus" })).toBe(true);
  expect(isOwnAgent(target("claude", "default", null), { ...own, model: "opus" })).toBe(true);
  expect(isOwnAgent(target("claude", "default", "sonnet"), { ...own, model: "opus" })).toBe(false);
  expect(isOwnAgent(target("claude", "default", "opus"), own)).toBe(false);
  expect(isOwnAgent(target("claude", "work", null), own)).toBe(false);
  expect(isOwnAgent(target("codex", "default", null), own)).toBe(false);
  expect(isOwnAgent(target("claude", "default", null), null)).toBe(false);
  expect(sortChoices([gpt, codex]).map((c) => c.handle)).toEqual(["codex", "gpt"]);
});

test("a row says what it costs and where it runs", () => {
  expect(askBadges({ paid: "yes", local: false })).toEqual({ cost: "Costs money", kind: "paid", where: "Online" });
  expect(askBadges({ paid: "no", local: false })).toEqual({ cost: "Uses your plan", kind: "plan", where: "Online" });
  expect(askBadges({ paid: "no", local: true })).toEqual({ cost: "Free", kind: "free", where: "On this machine" });
  expect(askBadges({ paid: "unknown", local: false }).cost).toBe("Cost unknown");
  expect(chipText(choice("codex", { label: "Codex" }))).toBe("Codex will chime in");
  expect(chipText(choice("gpt", { label: "GPT", available: false, why: "Not signed in" }))).toBe("GPT can't chime in: Not signed in");
  expect(chipText(choice("gpt", { label: "GPT", available: false }))).toBe("GPT can't chime in: not available right now");
});

test("a row's sub line is left out when it only repeats what the badges say", () => {
  // What the hub sends today: the kind of sign-in, or where it runs.
  for (const sub of ["API key", "Plan", "On this Mac", "On this machine", "Online", "online.", " Plan ", ""]) expect(askRowSub({ sub })).toBeNull();
  // Whatever words the badges use are never said twice.
  for (const paid of ["yes", "no", "unknown"] as const) {
    for (const local of [false, true]) {
      const badges = askBadges({ paid, local });
      expect(askRowSub({ sub: badges.cost })).toBeNull();
      expect(askRowSub({ sub: badges.where })).toBeNull();
    }
  }
  // Something the badges don't say stays: the model and how hard it thinks, say.
  expect(askRowSub({ sub: "GPT Test · medium effort" })).toBe("GPT Test · medium effort");
  expect(askRowSub({ sub: "  Claude Code, work account " })).toBe("Claude Code, work account");
});

test("the chip row says where the chat goes every time someone will be asked, in the sheet's words", () => {
  const line = "This sends the chat so far to each one you pick. Models on this machine stay here.";
  expect(ASK_PRIVACY_LINE).toBe(line);
  expect(askChipNote([])).toBeNull();
  // Online, a model on this machine, or both: said every time (the line itself says the ones on this machine stay).
  expect(askChipNote([choice("codex")])).toBe(line);
  expect(askChipNote([choice("llama", { local: true })])).toBe(line);
  expect(askChipNote([choice("llama", { local: true }), choice("codex")])).toBe(line);
  expect(askChipNote([choice("codex", { paid: "yes" }), choice("gpt", { paid: "unknown" })])).toBe(line);
  // One that can't chime in is sent nothing: no line for a row of only those, the line once someone who can be asked is in it.
  expect(askChipNote([choice("gpt", { available: false, why: "Not signed in" })])).toBeNull();
  expect(askChipNote([choice("gpt", { available: false, why: "Not signed in" }), choice("codex")])).toBe(line);
});

test("a draft that names someone is told from one that doesn't before the handles are known", () => {
  expect(hasMention("@codex is this right?")).toBe(true);
  expect(hasMention("what do you think, @gpt-5.5?")).toBe(true);
  expect(hasMention("line one\n@llama")).toBe(true);
  expect(hasMention("")).toBe(false);
  expect(hasMention("@")).toBe(false);
  expect(hasMention("mail a@b.com or user@host")).toBe(false);
  expect(hasMention("run `@codex` or\n```\n@llama\n```")).toBe(false);
  expect(hasMention("> Codex's answer: tell @llama\n\nand me")).toBe(false);
});

test("the sheet adds up what the paid ones usually cost", () => {
  const plan = choice("plan", { paid: "no" });
  const local = choice("local", { paid: "no", local: true });
  const paid = (usual: number | null) => choice(`paid${usual}`, { paid: "yes", typicalCostUsd: usual });
  expect(askCostHint([])).toBeNull();
  expect(askCostHint([plan, local])).toBeNull();
  expect(askCostHint([paid(0.04), paid(0.06), plan])).toBe("Costs money: about $0.10");
  expect(askCostHint([paid(0.04), paid(null)])).toBe("Costs money: about $0.04 or more");
  expect(askCostHint([paid(null)])).toBe("Costs money. We can't guess how much yet.");
  expect(askCostHint([choice("odd", { paid: "unknown" })])).toBe("This might cost money. We can't tell yet.");
  expect(askCostHint([choice("odd", { paid: "unknown", local: true })])).toBeNull();
});

test("a reply to a request never undoes a newer live event, and an ask removed elsewhere is gone after a reload", () => {
  const running = ask("a", { status: "running", answer: null, cost: null, endedAt: null });
  const done = ask("a");
  // The POST's answer says running; the event that came before it says done.
  expect(upsertAsks([done], [running])).toEqual([done]);
  expect(upsertAsks([running], [done])).toEqual([done]);
  expect(upsertAsks([done], [ask("b", { createdAt: T - 5 })]).map((a) => a.id)).toEqual(["b", "a"]);
  const b = ask("b", { createdAt: T + 1 });
  const c = ask("c", { createdAt: T + 2 });
  // The hub's list is the word, except for what live events touched while it was on its way.
  expect(mergeAsks([done, b], [done, b, c], new Set()).map((a) => a.id)).toEqual(["a", "b", "c"]);
  expect(mergeAsks([done], [done, b], new Set()).map((a) => a.id)).toEqual(["a", "b"]);
  expect(mergeAsks([done, b], [done], new Set()).map((a) => a.id)).toEqual(["a"]);
  // `b` was removed by an event while the list loaded (the list still had it); `c` arrived by an event (the list didn't).
  expect(mergeAsks([done, c], [done, b], new Set(["b", "c"])).map((a) => a.id)).toEqual(["a", "c"]);
  // `a` finished by an event meanwhile: the event's copy stays.
  expect(mergeAsks([done], [running], new Set(["a"]))).toEqual([done]);
});

test("a failed request is said in plain words, with the Settings button that helps", () => {
  const err = (status: number, message: string, code?: string) => ({ status, message, code });
  expect(askProblem(err(409, "Codex reached its $250 limit.", "budget"))).toEqual({ text: "Codex reached its $250 limit.", fix: "limit" });
  expect(askProblem(err(409, "Request failed (409)", "budget")).fix).toBe("limit");
  expect(askProblem(err(409, "Request failed (409)", "budget")).text).toContain("spending limit");
  expect(askProblem(err(409, "Codex isn't signed in.", "not_signed_in"))).toEqual({ text: "Codex isn't signed in.", fix: "signin" });
  expect(askProblem(err(409, "Request failed (409)", "busy")).text).toContain("busy");
  expect(askProblem(err(409, "Request failed (409)", "model_choice")).text).toContain("Choose a model");
  expect(askProblem(err(404, "Not found")).text).toContain("Update the hub");
  // A 404 with its own words (the message is gone) keeps them.
  expect(askProblem(err(404, "That message isn't in this chat any more.")).text).toBe("That message isn't in this chat any more.");
  expect(askProblem(err(0, "Can't reach the hub. Check that it's running."))).toEqual({ text: "Can't reach the hub. Check that it's running.", fix: null });
  expect(askProblem(new Error("boom")).text).toBe("boom");
  expect(askProblem(err(500, "")).text).toContain("try again");
});

// ---- what Send does with a draft ----------------------------------------------------------------------------------

const CODEX = choice("codex", { label: "Codex · GPT-5.5" });
const GPT = choice("gpt-api", { label: "GPT-5.5 · API key", paid: "yes" });
const OPUS = choice("opus", { label: "Claude Opus 4.5", available: false, why: "Over its $250 limit" });
// Who can be asked, as the message box has it: the chat's own agent is never in it.
const CAN_ASK = [CODEX, GPT, OPUS];
let clock = 0;
const msg = (id: string, authorKind: Message["authorKind"], patch: Partial<Message> = {}): Message => ({
  id, roomId: "r1", authorKind, memberId: authorKind === "agent" ? "member" : null, authorName: authorKind === "human" ? "Phone" : "claude", text: `What ${id} says`,
  mentions: [], turnId: null, status: "done", createdAt: T + ++clock * 1000, updatedAt: T + clock * 1000, ...patch,
});
const CHAT = [msg("m1", "human"), msg("m2", "agent")];
/** The plan for a draft the way the message box asks for it: the chips are what the draft names among who can be asked. */
const plan = (text: string, patch: Partial<SendInput> = {}) => sendPlan({ text, chips: mentionedChoices(text, CAN_ASK), typed: hasMention(text), choices: "ready", messages: CHAT, attachments: 0, ...patch });

test("a draft that names nobody else goes to the chat as it is", () => {
  expect(plan("fix the build")).toEqual({ kind: "chat" });
  // Not someone to ask: the chat's own agent (never in the list), a name nobody has, an email address, a package, code.
  expect(plan("@claude what do you think?")).toEqual({ kind: "chat" });
  expect(plan("@nobody what do you think?")).toEqual({ kind: "chat" });
  expect(plan("mail me@example.com or install @types/react")).toEqual({ kind: "chat" });
  expect(plan("run `@codex` or\n```\n@gpt-api\n```")).toEqual({ kind: "chat" });
  expect(plan("> Codex's answer: tell @gpt-api\n\nand me")).toEqual({ kind: "chat" });
  // The list not being here only matters once a name is typed.
  expect(plan("fix the build", { choices: "loading" })).toEqual({ kind: "chat" });
  expect(plan("fix the build", { choices: "failed" })).toEqual({ kind: "chat" });
  // Nothing to ask about doesn't matter either when nobody is named.
  expect(plan("fix the build", { messages: [] })).toEqual({ kind: "chat" });
  expect(plan("fix the build", { messages: null, attachments: 2 })).toEqual({ kind: "chat" });
});

test("naming others asks only them, about the newest message, with the rest of the draft as the question", () => {
  expect(plan("@codex opinion?")).toEqual({ kind: "ask", messageId: "m2", targets: [CODEX.target], note: "opinion?" });
  // Several, in the order written, wherever the names are in the draft.
  expect(plan("is this right, @gpt-api and @codex?")).toEqual({ kind: "ask", messageId: "m2", targets: [GPT.target, CODEX.target], note: "is this right, and?" });
  expect(plan("what do you think @codex")).toMatchObject({ kind: "ask", note: "what do you think" });
  // Only a name (or a name and a full stop): no question, the hub asks its own.
  expect(plan("@codex")).toEqual({ kind: "ask", messageId: "m2", targets: [CODEX.target], note: null });
  expect(plan("  @codex.  ")).toMatchObject({ kind: "ask", note: null });
  expect(plan("@codex, @gpt-api: is this right?")).toMatchObject({ kind: "ask", note: "is this right?" });
  // A name in code, or one nobody has, stays in the question.
  expect(plan("@codex what does `@gpt-api` do with @types/react?")).toMatchObject({ kind: "ask", targets: [CODEX.target], note: "what does `@gpt-api` do with @types/react?" });
  // Lines stay lines.
  expect(plan("@codex check:\n- the rollback\n- the index")).toMatchObject({ kind: "ask", note: "check:\n- the rollback\n- the index" });
  // One that can't be asked isn't, and its name goes from the question too; the rest are asked.
  expect(plan("@opus and @codex is this right?")).toEqual({ kind: "ask", messageId: "m2", targets: [CODEX.target], note: "and is this right?" });
});

test("the question is asked about the newest message that can be asked about", () => {
  const asked = (messages: Message[], patch: Partial<SendInput> = {}) => {
    const p = plan("@codex opinion?", { messages, ...patch });
    return p.kind === "ask" ? p.messageId : p;
  };
  const note = msg("note", "system", { text: "Duplicated to another chat" });
  // A person's message or an agent's reply, whichever is newest; system notes are skipped.
  expect(asked([msg("a", "agent"), msg("b", "human")])).toBe("b");
  expect(asked([msg("a", "human"), msg("b", "agent"), note])).toBe("b");
  // Not one with no text, nor a reply that failed; a stopped reply counts.
  expect(asked([msg("a", "human"), msg("b", "agent", { text: "  " })])).toBe("a");
  expect(asked([msg("a", "human"), msg("b", "agent", { status: "error", text: "Rate limited" })])).toBe("a");
  expect(asked([msg("a", "human"), msg("b", "agent", { status: "stopped", text: "Half an answer" })])).toBe("b");
  // Another chat's relayed message shows no cards, nor does one copied in before this chat began.
  expect(asked([msg("a", "agent"), msg("b", "human", { via: { chatId: "c", chatName: "Other", agent: "Codex" } as Message["via"] })])).toBe("a");
  const before = clock * 1000 + T;
  expect(asked([msg("a", "human", { createdAt: before - 5000 }), msg("b", "agent", { createdAt: before - 4000, copy: { kind: "reply", agent: "Codex" } })], { copiedBefore: before })).toBe("b");
  expect(asked([msg("b", "agent", { createdAt: before - 4000, status: "error" }), msg("a", "human", { createdAt: before - 5000 })], { copiedBefore: before })).toMatchObject({ kind: "blocked" });
  expect(asked([msg("a", "human", { createdAt: before - 5000 })], { copiedBefore: 0 })).toBe("a");
});

test("a name typed before the list of who can be asked is here waits for it, and says so when it couldn't be had", () => {
  const typed = (choices: "loading" | "failed") => sendPlan({ text: "@codex opinion?", chips: [], typed: true, choices, messages: CHAT, attachments: 0 });
  expect(typed("loading")).toEqual({ kind: "wait" });
  expect(typed("failed")).toEqual({ kind: "blocked", reason: "Couldn't check who you can ask.", actions: ["retry", "as-is"] });
  // Once it's here: names that match become an ask, text that only looks like a name goes to the chat.
  expect(plan("@codex opinion?", { choices: "ready" })).toMatchObject({ kind: "ask" });
  expect(sendPlan({ text: "install @types/react", chips: [], typed: true, choices: "ready", messages: CHAT, attachments: 0 })).toEqual({ kind: "chat" });
});

test("when asking can't be done, Send says why in plain words, sends nothing and leaves a way out", () => {
  const way = ["take-off", "as-is"];
  // An empty chat, or one with only notes in it.
  expect(plan("@codex opinion?", { messages: [] })).toEqual({ kind: "blocked", reason: "There's nothing in this chat to ask about yet. Send a message first, or take off @codex.", actions: way });
  expect(plan("@codex and @gpt-api opinion?", { messages: [msg("n", "system")] })).toMatchObject({ kind: "blocked", reason: "There's nothing in this chat to ask about yet. Send a message first, or take off @codex and @gpt-api." });
  // Files: other agents can't see them. This comes before the rest (the person fixes the draft first).
  expect(plan("@codex opinion?", { attachments: 1 })).toEqual({ kind: "blocked", reason: "Other agents can't see attachments yet. Take off the files or the @names.", actions: way });
  expect(plan("@codex opinion?", { attachments: 1, messages: [] })).toMatchObject({ reason: "Other agents can't see attachments yet. Take off the files or the @names." });
  // The newest message is a reply being written (an older one doesn't help), until it's done.
  const writing = [msg("a", "human"), msg("b", "agent", { status: "streaming", text: "" })];
  expect(plan("@codex opinion?", { messages: writing })).toEqual({ kind: "blocked", reason: "That reply is still being written. Ask again when it's done.", actions: way });
  expect(plan("@codex opinion?", { messages: [...writing, msg("n", "system")] })).toMatchObject({ kind: "blocked" });
  expect(plan("@codex opinion?", { messages: [msg("a", "agent", { status: "streaming" }), msg("b", "human")] })).toMatchObject({ kind: "ask", messageId: "b" });
  expect(plan("@codex opinion?", { messages: [msg("a", "human"), msg("b", "agent", { status: "done" })] })).toMatchObject({ kind: "ask", messageId: "b" });
  // The chat's messages haven't come yet: that's not an empty chat.
  expect(plan("@codex opinion?", { messages: null })).toEqual({ kind: "blocked", reason: "This chat is still loading. Ask again in a moment.", actions: way });
  // Only names that can't be asked (each chip says why): this comes first.
  expect(plan("@opus opinion?")).toEqual({ kind: "blocked", reason: "Nobody you named can be asked right now.", actions: way });
  expect(plan("@opus opinion?", { messages: [], attachments: 1 })).toMatchObject({ reason: "Nobody you named can be asked right now." });
  // A question the hub would cut short is never sent cut short.
  const long = "x".repeat(ASK_NOTE_MAX);
  expect(plan(`@codex ${long}`)).toMatchObject({ kind: "ask", note: long });
  expect(plan(`@codex ${long}y`)).toEqual({ kind: "blocked", reason: "That's too long to ask others (2,000 characters at most). Shorten it, or send it to the chat as it is.", actions: ["as-is"] });
});

test("a chat that is a copy tells where its own messages begin", () => {
  const from = msg("f", "system", { copy: { kind: "from", agent: "Codex" }, createdAt: T });
  expect(copiedUntil([from, msg("a", "human")], T + 100, false)).toBe(T + 100);
  expect(copiedUntil([msg("a", "human")], T + 100, false)).toBe(0);
  // Its first line isn't loaded yet: messages older than the chat tell.
  expect(copiedUntil([msg("a", "human", { createdAt: T })], T + 100, true)).toBe(T + 100);
  expect(copiedUntil([msg("a", "human", { createdAt: T + 200 })], T + 100, true)).toBe(0);
  expect(copiedUntil([], T + 100, true)).toBe(0);
});

test("the chip row says only they answer, and the send button says who it asks", () => {
  expect(askOnlyLine([CODEX], "Claude Code")).toBe("Only Codex will answer. Claude Code won't see this.");
  expect(askOnlyLine([CODEX, GPT], "Claude Code")).toBe("Only Codex and GPT-5.5 will answer. Claude Code won't see this.");
  expect(askOnlyLine([CODEX, GPT, choice("llama", { label: "Llama 3.3 70B" })], "Claude Code")).toBe("Only Codex, GPT-5.5 and Llama 3.3 70B will answer. Claude Code won't see this.");
  // Only those that can be asked are named; none: no line.
  expect(askOnlyLine([OPUS, CODEX], "Claude Code")).toBe("Only Codex will answer. Claude Code won't see this.");
  expect(askOnlyLine([OPUS], "Claude Code")).toBeNull();
  expect(askOnlyLine([], "Claude Code")).toBeNull();
  expect(askOnlyLine([CODEX], null)).toBe("Only Codex will answer. This chat's agent won't see this.");
  // Two of one agent: the whole labels, so they can be told apart.
  const two = [choice("a", { label: "Codex · GPT-5.5" }), choice("b", { label: "Codex · GPT-5.4" }), GPT];
  expect(askNames(two)).toEqual(["Codex · GPT-5.5", "Codex · GPT-5.4", "GPT-5.5"]);
  expect(askButtonLabel([CODEX])).toBe("Ask Codex");
  expect(askButtonLabel([CODEX, GPT])).toBe("Ask 2");
  expect(askButtonLabel([OPUS, GPT])).toBe("Ask GPT-5.5");
  expect(askButtonLabel([OPUS])).toBeNull();
  expect(askButtonLabel([])).toBeNull();
});

test("another model of the chat's own agent is named by its model, so no line says the same name twice", () => {
  // The hub's labels are "<agent> · <model>": in a Claude Code chat, another Claude Code model is "Claude Code · Opus 5.5".
  const opus = choice("opus55", { label: "Claude Code · Opus 5.5" });
  const sonnet = choice("sonnet", { label: "Claude Code · Sonnet 5" });
  const gpt54 = choice("gpt54", { label: "Codex · GPT-5.4" });
  expect(askNames([opus], "Claude Code")).toEqual(["Opus 5.5"]);
  expect(askOnlyLine([opus], "Claude Code")).toBe("Only Opus 5.5 will answer. Claude Code won't see this.");
  expect(askButtonLabel([opus], "Claude Code")).toBe("Ask Opus 5.5");
  // The same in a Codex chat, whatever the letters' case.
  expect(askOnlyLine([gpt54], "Codex")).toBe("Only GPT-5.4 will answer. Codex won't see this.");
  expect(askButtonLabel([gpt54], "codex")).toBe("Ask GPT-5.4");
  // Several: the own agent's models by their models, any other agent by its name.
  expect(askOnlyLine([opus, CODEX], "Claude Code")).toBe("Only Opus 5.5 and Codex will answer. Claude Code won't see this.");
  expect(askOnlyLine([opus, sonnet], "Claude Code")).toBe("Only Opus 5.5 and Sonnet 5 will answer. Claude Code won't see this.");
  expect(askButtonLabel([opus, sonnet], "Claude Code")).toBe("Ask 2");
  // In another agent's chat, or with no chat agent known, nothing changes.
  expect(askOnlyLine([opus], "Codex")).toBe("Only Claude Code will answer. Codex won't see this.");
  expect(askOnlyLine([opus], null)).toBe("Only Claude Code will answer. This chat's agent won't see this.");
  expect(askButtonLabel([opus])).toBe("Ask Claude Code");
  // An account with a name of its own is another name already. Names that would still read alike keep the whole label.
  expect(askOnlyLine([choice("w", { label: "Claude Code (Work) · Opus 5.5" })], "Claude Code")).toBe("Only Claude Code (Work) will answer. Claude Code won't see this.");
  expect(askNames([opus, choice("x", { label: "Opus 5.5" })], "Claude Code")).toEqual(["Claude Code · Opus 5.5", "Opus 5.5"]);
  // An empty chat: the notice says which @names to take off, the ones that were typed (not a name the person never wrote).
  const empty = (text: string, chips: AskChoice[]) => sendPlan({ text, chips, typed: true, choices: "ready", messages: [], attachments: 0 });
  expect(empty("@opus55 is this right?", [opus])).toEqual({ kind: "blocked", reason: "There's nothing in this chat to ask about yet. Send a message first, or take off @opus55.", actions: ["take-off", "as-is"] });
  expect(empty("@opus55 and @sonnet and @gpt54?", [opus, sonnet, gpt54])).toMatchObject({ reason: "There's nothing in this chat to ask about yet. Send a message first, or take off @opus55, @sonnet and @gpt54." });
});

test("once someone is asked, the draft leaves the message box and what was typed meanwhile stays", () => {
  const draft = "@codex is this rigth";
  expect(afterAsked(draft, draft)).toBe("");
  // Typed or dictated after the draft: it stays, without the space or lines between.
  expect(afterAsked(`${draft} and X`, draft)).toBe("and X");
  expect(afterAsked(`${draft}\n\nmore`, draft)).toBe("more");
  expect(afterAsked(`${draft}?`, draft)).toBe("?");
  // A box emptied meanwhile stays empty.
  expect(afterAsked("", draft)).toBe("");
  // The browser committed an autocorrection to the last word meanwhile: still the draft that was asked, not left behind to be asked twice.
  expect(afterAsked("@codex is this right", draft)).toBe("");
  expect(afterAsked("@codex is this right and X", draft)).toBe("and X");
  expect(afterAsked("@codex is this right\nand X", `${draft} `)).toBe("and X");
  // Edited in any other way (a word in front, a word in the middle, one word only): the person's text is never cut.
  expect(afterAsked(`Hey, ${draft}`, draft)).toBe(`Hey, ${draft}`);
  expect(afterAsked("@codex is that rigth", draft)).toBe("@codex is that rigth");
  expect(afterAsked("@Codex", "@codex")).toBe("@Codex");
  expect(afterAsked("something new", draft)).toBe("something new");
});

test("taking the names off takes every named one out of the draft", () => {
  const chips = mentionedChoices("@codex and @gpt-api, is this `@opus` right? @opus", CAN_ASK);
  expect(chips.map((c) => c.handle)).toEqual(["codex", "gpt-api", "opus"]);
  expect(withoutMentions("@codex and @gpt-api, is this `@opus` right? @opus", chips)).toBe("and, is this `@opus` right?");
  expect(withoutMentions("no names here", chips)).toBe("no names here");
  expect(withoutMentions("@codex", [CODEX])).toBe("");
});

// ---- 0.5 (T11): models on the person's other linked machines ----------------------------------------------------------

const PC = { id: "h_pc", name: "PC" };
const NAS = { id: "h_nas", name: "Anna's NAS" };
/** A row the hub got from another machine: its target names the machine, its label says where it is. */
const there = (handle: string, machine: { id: string; name: string }, patch: Partial<AskChoice> = {}): AskChoice =>
  choice(handle, { machine, label: `Name ${handle} · on ${theMachine(machine.name)}`, target: { provider: "codex", account: "default", model: handle, effort: null, machine: machine.id }, ...patch });

test("the same account and model on two machines are two rows, but a plain row's key is what it always was", () => {
  const here = choice("qwen");
  const onPc = there("qwen", PC);
  expect(askTargetKey(here.target)).toBe("codex|default|qwen|");
  expect(askTargetKey(onPc.target)).toBe("codex|default|qwen||h_pc");
  expect(askTargetKey(there("qwen", NAS).target)).not.toBe(askTargetKey(onPc.target));
});

test("a row on another machine says so, costs what its machine says, and is never taken for the chat's own agent", () => {
  expect(askBadges({ paid: "no", local: true, machine: PC })).toEqual({ cost: "Free", kind: "free", where: "On another of your machines" });
  expect(askBadges({ paid: "yes", local: false, machine: PC })).toEqual({ cost: "Costs money", kind: "paid", where: "On another of your machines" });
  expect(askBadges({ paid: "no", local: false, machine: PC })).toEqual({ cost: "Uses your plan", kind: "plan", where: "On another of your machines" });
  // Claude Code on the PC is not this chat's Claude Code, even with the same account and model.
  const own = { provider: "codex", account: "default", model: "qwen" };
  expect(isOwnAgent(choice("qwen").target, own)).toBe(true);
  expect(isOwnAgent(there("qwen", PC).target, own)).toBe(false);
  expect(mentionCandidates([choice("qwen"), there("qwen-on-pc", PC, { target: { ...choice("qwen").target, machine: "h_pc" } })], "qwen", own).map((c) => c.handle)).toEqual(["qwen-on-pc"]);
});

test("the sheet groups rows by machine: this one first, then each other under its own heading, a machine that couldn't say as a line", () => {
  const a = choice("a");
  const off = choice("off", { available: false, why: "Not signed in" });
  const b = there("b", PC);
  const c = there("c", NAS);
  const cOff = there("c-off", NAS, { available: false, why: "Over its $12 limit" });
  // Nothing elsewhere: one group, no heading, who can be asked first (as before).
  expect(askGroups([off, a])).toEqual([{ key: "here", heading: null, rows: [a, off], note: null }]);
  expect(askGroups([])).toEqual([{ key: "here", heading: null, rows: [], note: null }]);
  // The machines come in the order the hub gave their rows.
  const groups = askGroups([off, b, a, c, cOff]);
  expect(groups.map((g) => [g.key, g.heading, g.rows.map((r) => r.handle), g.note])).toEqual([
    ["here", "On this machine", ["a", "off"], null],
    ["h_pc", "On the PC", ["b"], null],
    ["h_nas", "On Anna's NAS", ["c", "c-off"], null],
  ]);
  // A machine that couldn't say shows once, under its heading, without rows.
  const note = { id: "h_pc", name: "PC", why: "The PC didn't answer." };
  expect(askGroups([a], [note])).toEqual([
    { key: "here", heading: "On this machine", rows: [a], note: null },
    { key: "h_pc", heading: "On the PC", rows: [], note },
  ]);
  // Only elsewhere: no empty "On this machine".
  expect(askGroups([b], []).map((g) => g.heading)).toEqual(["On the PC"]);
  expect(askGroups([], [note]).map((g) => g.heading)).toEqual(["On the PC"]);
});

test("the list is read from the plain array an older hub sends or from the list with the machines that couldn't say", () => {
  const rows = [choice("a"), there("b", PC)];
  expect(readTargets(rows)).toEqual({ choices: rows, machines: [] });
  const note = { id: "h_pc", name: "PC", why: "The PC didn't answer." };
  expect(readTargets({ choices: rows, machines: [note] })).toEqual({ choices: rows, machines: [note] });
  expect(readTargets({ choices: rows })).toEqual({ choices: rows, machines: [] });
  expect(readTargets(null)).toEqual({ choices: [], machines: [] });
  expect(readTargets("nonsense")).toEqual({ choices: [], machines: [] });
});

test("the footer and the chip row add the other machines' sentence only once one of them is picked", () => {
  expect(ASK_OTHER_MACHINES_LINE).toBe("Ones on your other machines get it over your own link.");
  expect(askPrivacyLine([])).toBe(ASK_PRIVACY_LINE);
  expect(askPrivacyLine([choice("a")])).toBe(ASK_PRIVACY_LINE);
  expect(askPrivacyLine([choice("a"), there("b", PC)])).toBe(`${ASK_PRIVACY_LINE} ${ASK_OTHER_MACHINES_LINE}`);
  expect(askChipNote([there("b", PC)])).toBe(`${ASK_PRIVACY_LINE} ${ASK_OTHER_MACHINES_LINE}`);
  expect(askChipNote([choice("a")])).toBe(ASK_PRIVACY_LINE);
  // One that can't chime in is sent nothing, so it adds nothing to the line.
  expect(askChipNote([choice("a"), there("b", PC, { available: false, why: "The PC didn't answer." })])).toBe(ASK_PRIVACY_LINE);
  expect(askChipNote([there("b", PC, { available: false, why: "Not signed in" })])).toBeNull();
});

test("a chip, the line and the button name the machine: Qwen3 on the PC", () => {
  const qwen = there("qwen", PC, { label: "Qwen3 · qwen3-30b · on the PC" });
  const claudePc = there("claude-pc", PC, { label: "Claude Code · Opus 5.5 · on the PC" });
  expect(chipText(qwen)).toBe("Qwen3 · qwen3-30b · on the PC will chime in");
  expect(askNames([qwen])).toEqual(["Qwen3 on the PC"]);
  expect(askOnlyLine([qwen], "Claude Code")).toBe("Only Qwen3 on the PC will answer. Claude Code won't see this.");
  // The button is short (a phone's has little room, and a cut-off machine name reads as nothing); the machine is in the chip row
  // and in the button's accessible name.
  expect(askButtonLabel([qwen], "Claude Code")).toBe("Ask Qwen3");
  expect(askButtonName([qwen], "Claude Code")).toBe("Ask Qwen3 on the PC");
  // The chat's own agent kind on another machine is not the chat's own: it's "Claude Code on the PC", not its model.
  expect(askNames([claudePc], "Claude Code")).toEqual(["Claude Code on the PC"]);
  // On the button that would read as the chat's own agent, so it's the model (as for another model of the chat's own agent here).
  expect(askButtonLabel([claudePc], "Claude Code")).toBe("Ask Opus 5.5");
  expect(askButtonName([claudePc], "Claude Code")).toBe("Ask Claude Code on the PC");
  expect(askButtonLabel([claudePc], "Codex")).toBe("Ask Claude Code");
  expect(askButtonLabel([qwen, claudePc])).toBe("Ask 2");
  expect(askButtonName([qwen, claudePc])).toBe("Ask 2");
  expect(askButtonName([CODEX])).toBe("Ask Codex");
  expect(askButtonName([there("off", PC, { available: false, why: "Not signed in" })])).toBeNull();
  // Two of one agent on a machine keep their whole labels so they can be told apart; a name with an apostrophe isn't given "the".
  expect(askNames([claudePc, there("claude-pc2", PC, { label: "Claude Code · Sonnet 5 · on the PC" })])).toEqual(["Claude Code · Opus 5.5 · on the PC", "Claude Code · Sonnet 5 · on the PC"]);
  expect(askNames([there("q", NAS, { label: "Qwen3 · on Anna's NAS" })])).toEqual(["Qwen3 on Anna's NAS"]);
  expect(theMachine("The Studio")).toBe("The Studio");
  expect(theMachine("Mac mini")).toBe("the Mac mini");
});

test("naming one on another machine asks it like any other: the target carries the machine, and the rest of the draft is the question", () => {
  const qwen = there("qwen-on-pc", PC, { label: "Qwen3 · on the PC" });
  const text = "@qwen-on-pc is this safe?";
  expect(sendPlan({ text, chips: mentionedChoices(text, [CODEX, qwen]), typed: true, choices: "ready", messages: CHAT, attachments: 0 })).toEqual({ kind: "ask", messageId: "m2", targets: [qwen.target], note: "is this safe?" });
  expect(qwen.target.machine).toBe("h_pc");
  // One that can't be asked says why in its chip, and the draft isn't sent to the chat's agent.
  const down = there("qwen-on-pc", PC, { available: false, why: "Agents across chats is off on the PC: turn it on in its Settings." });
  expect(chipText(down)).toBe("Name qwen-on-pc · on the PC can't chime in: Agents across chats is off on the PC: turn it on in its Settings.");
  expect(sendPlan({ text, chips: [down], typed: true, choices: "ready", messages: CHAT, attachments: 0 })).toMatchObject({ kind: "blocked", reason: "Nobody you named can be asked right now." });
});

test("a machine that stops answering keeps its rows, greyed: a draft that names one is blocked, never sent on to the chat's own agent", () => {
  const qwen = there("qwen3-on-pc", PC, { label: "Qwen3 · qwen3-30b · on the PC" });
  const llama = there("llama-on-nas", NAS, { label: "Llama · on Anna's NAS" });
  const text = "@qwen3-on-pc is this safe?";
  const send = (list: AskChoice[]) => sendPlan({ text, chips: mentionedChoices(text, list), typed: true, choices: "ready", messages: CHAT, attachments: 0 });
  const before = [CODEX, qwen, llama];
  expect(send(before)).toMatchObject({ kind: "ask", targets: [qwen.target] });
  // The list read again: the PC didn't answer this time, so its rows aren't in it, and a line says why.
  const silent = { id: PC.id, name: "PC", why: "The PC didn't answer." };
  const fresh = [CODEX, llama];
  // As read, the draft names nobody the list knows: it would go to the chat's agent as text, and cost money twice.
  expect(send(fresh)).toEqual({ kind: "chat" });
  const kept = keepSilentMachines(before, fresh, [silent]);
  expect(kept.map((c) => c.handle)).toEqual(["codex", "llama-on-nas", "qwen3-on-pc"]);
  expect(kept.find((c) => c.handle === "qwen3-on-pc")).toEqual({ ...qwen, available: false, why: "The PC didn't answer." });
  expect(send(kept)).toMatchObject({ kind: "blocked", reason: "Nobody you named can be asked right now.", actions: ["take-off", "as-is"] });
  expect(chipText(kept[2])).toBe("Qwen3 · qwen3-30b · on the PC can't chime in: The PC didn't answer.");
  // Still silent the next time: the same greyed rows, with what the machine says now (it may be switched off by then).
  const off = { id: PC.id, name: "PC", why: "Agents across chats is off on the PC: turn it on in its Settings." };
  const again = keepSilentMachines(kept, fresh, [off]);
  expect(again.filter((c) => c.machine?.id === PC.id)).toEqual([{ ...qwen, available: false, why: off.why }]);
  // Back again: its own rows, as it says them (nothing is kept next to them).
  expect(keepSilentMachines(again, [CODEX, llama, qwen], [])).toEqual([CODEX, llama, qwen]);
  // Rows of a machine that answered, one nothing was kept of, or one that's gone (no line, no rows) are what the answer says.
  expect(keepSilentMachines(before, fresh, [])).toEqual(fresh);
  expect(keepSilentMachines(before, [CODEX, qwen], [{ id: NAS.id, name: NAS.name, why: "Anna's NAS didn't answer." }]).map((c) => [c.handle, c.available])).toEqual([["codex", true], ["qwen3-on-pc", true], ["llama-on-nas", false]]);
  expect(keepSilentMachines([CODEX], [CODEX], [silent])).toEqual([CODEX]);
  expect(keepSilentMachines(null, fresh, [silent])).toEqual(fresh);
});
