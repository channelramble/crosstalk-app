import { parseCodexQuestionReply, type Approval } from "@crosstalk/shared";

/**
 * A message that answers questions an agent asked without waiting (Codex's reply envelope, codexQuestionReply), as the
 * chat shows it: each question quoted with its answer below, as Codex's own apps show it. Null for any other message.
 */
export function answerText(text: string): string | null {
  const replies = parseCodexQuestionReply(text);
  return replies ? replies.map((r) => `> ${r.question.trim()}\n\n${r.answer}`).join("\n\n") : null;
}

/** "1:05": how long until `at` (a hub time), never below zero. */
export function countdown(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/**
 * A question the agent can go on without whose time hasn't started: the first device to show it starts it (POST
 * /api/approvals/:id/seen), as Codex's own apps count from when the question is on their screen.
 */
export function startsWhenSeen(a: Approval): boolean {
  return a.status === "pending" && !!a.autoResolveMs && typeof a.autoResolveAt !== "number";
}

/** What a closed question card says it came to. */
export function questionOutcome(a: Approval): string {
  if (a.status === "approved") return "answered";
  if (a.status === "denied") return "skipped";
  // Asked without waiting: another message of yours, or a fresh session, closed it.
  if (a.delivery === "async") return "closed";
  // A question the agent could go on without, and did.
  return typeof a.autoResolveAt === "number" && a.decidedAt !== null && a.decidedAt >= a.autoResolveAt - 1000 ? "timed out" : "expired";
}
