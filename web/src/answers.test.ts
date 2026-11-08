import { describe, expect, test } from "bun:test";
import { codexAnswerTo, codexQuestionReply, parseCodexQuestionReply, type Approval } from "@crosstalk/shared";
import { answerText, countdown, questionOutcome, startsWhenSeen } from "./answers";

describe("answers to Codex's questions", () => {
  const id = JSON.stringify(["request_user_input_async", "audience-question", 0]);

  test("are sent in the envelope Codex's own apps send (codex-rs AnsweredQuestion)", () => {
    expect(codexQuestionReply([{ questionItemId: id, question: "Who is it for?", answer: "Customers" }])).toBe(
      '<send_user_message_question_reply>\n[{"answer":"Customers","question":"Who is it for?","questionItemId":"[\\"request_user_input_async\\",\\"audience-question\\",0]"}]\n</send_user_message_question_reply>',
    );
  });

  test("bound the question to its first 512 bytes, between characters, on one line", () => {
    const text = "é\n".repeat(1000);
    const [reply] = parseCodexQuestionReply(codexQuestionReply([{ questionItemId: id, question: text, answer: 'A "quoted" answer\nwith a second line' }]))!;
    expect(reply.question).toBe(`${"é ".repeat(170)}é`);
    expect(new TextEncoder().encode(reply.question).length).toBe(512);
    expect(reply.answer).toBe('A "quoted" answer\nwith a second line');
  });

  test("are recognized whole only, also as one answer or several, from any app", () => {
    const two = codexQuestionReply([
      { questionItemId: id, question: "Who is it for?", answer: "Customers" },
      { questionItemId: JSON.stringify(["request_user_input_async", "audience-question", 1]), question: "When?", answer: "Friday" },
    ]);
    expect(parseCodexQuestionReply(two)?.map((r) => r.answer)).toEqual(["Customers", "Friday"]);
    expect(parseCodexQuestionReply(`  ${two}\n`)).toHaveLength(2);
    // One answer on its own (not in a list), as the desktop app may send it.
    expect(parseCodexQuestionReply(`<send_user_message_question_reply>{"questionItemId":"x","question":"Q","answer":"A"}</send_user_message_question_reply>`)).toEqual([{ questionItemId: "x", question: "Q", answer: "A" }]);
    for (const text of [`I said: ${two}`, `${two} thanks`, "<send_user_message_question_reply>[]</send_user_message_question_reply>", "<send_user_message_question_reply>not json</send_user_message_question_reply>", '<send_user_message_question_reply>[{"question":"Q"}]</send_user_message_question_reply>', "Yes"]) {
      expect(parseCodexQuestionReply(text)).toBeNull();
    }
  });

  test("are recognized after the IDE context the Codex app can put first, as Codex's apps read them", () => {
    const one = codexQuestionReply([{ questionItemId: id, question: "Who is it for?", answer: "Customers" }]);
    const ide = (request: string) => `# Context from my IDE setup:\n\n## Active file: app.ts\n\n## My request for Codex:\n${request}\n`;
    expect(parseCodexQuestionReply(ide(one))?.map((r) => r.answer)).toEqual(["Customers"]);
    expect(answerText(ide(one))).toBe("> Who is it for?\n\nCustomers");
    // The request is what follows the last such heading; anything else there, or no request at all, isn't an answer.
    expect(parseCodexQuestionReply(ide(`thanks ${one}`))).toBeNull();
    expect(parseCodexQuestionReply(`# Context from my IDE setup:\n${one}`)).toBeNull();
  });

  test("answer a question by its own id, or by the message that asked it (older Codex apps)", () => {
    expect(codexAnswerTo(id, { [id]: "Customers" })).toBe("Customers");
    expect(codexAnswerTo(id, { "audience-question": "Staff" })).toBe("Staff");
    expect(codexAnswerTo(id, { other: "x" })).toBeUndefined();
    // Only answers given: nothing an object has of itself.
    expect(codexAnswerTo("toString", {})).toBeUndefined();
    expect(codexAnswerTo("ship", { ship: "Yes" })).toBe("Yes");
  });

  test("show in the chat as the question quoted and the answer, as Codex's apps show them", () => {
    expect(answerText(codexQuestionReply([{ questionItemId: id, question: "Ship it?", answer: "No" }]))).toBe("> Ship it?\n\nNo");
    expect(answerText("Ship it")).toBeNull();
  });
});

describe("question cards", () => {
  const card = (patch: Partial<Approval>): Approval => ({ id: "ap1", roomId: "r1", memberId: "m1", turnId: "t1", kind: "question", title: "Ship it?", detail: "", status: "pending", decision: null, decidedBy: null, createdAt: 0, decidedAt: null, ...patch });

  test("start the time a question the agent can go on without has once a device shows it, not before or again", () => {
    expect(startsWhenSeen(card({ autoResolveMs: 120_000 }))).toBe(true);
    expect(startsWhenSeen(card({ autoResolveMs: 120_000, autoResolveAt: 5 }))).toBe(false);
    // Held (you started answering), one that waits, or one that's closed.
    expect(startsWhenSeen(card({ autoResolveMs: null, autoResolveAt: null }))).toBe(false);
    expect(startsWhenSeen(card({}))).toBe(false);
    expect(startsWhenSeen(card({ autoResolveMs: 120_000, status: "expired" }))).toBe(false);
  });

  test("count down to when the agent goes on without an answer", () => {
    expect(countdown(120_000, 0)).toBe("2:00");
    expect(countdown(61_200, 0)).toBe("1:02");
    expect(countdown(5_000, 0)).toBe("0:05");
    expect(countdown(0, 5_000)).toBe("0:00");
  });

  test("say what they came to", () => {
    expect(questionOutcome(card({ status: "approved" }))).toBe("answered");
    expect(questionOutcome(card({ status: "denied" }))).toBe("skipped");
    // Asked without waiting, closed by another message or a fresh session.
    expect(questionOutcome(card({ status: "expired", delivery: "async", decidedAt: 10 }))).toBe("closed");
    // The agent went on without an answer when the time was up; a reply that ended first just expired it.
    expect(questionOutcome(card({ status: "expired", autoResolveAt: 120_000, decidedAt: 120_004 }))).toBe("timed out");
    expect(questionOutcome(card({ status: "expired", autoResolveAt: 120_000, decidedAt: 30_000 }))).toBe("expired");
    expect(questionOutcome(card({ status: "expired", decidedAt: 30_000 }))).toBe("expired");
  });
});
