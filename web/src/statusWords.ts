import { limitWaitWords, type Activity, type Member } from "@crosstalk/shared";

/** A chat's status line: what the agent is doing in a few plain words, and a second line when there's more to say. */
export interface StatusWords {
  text: string;
  note: string | null;
  /** Something to notice (a question, servers that keep failing, a step that may be stuck): the attention style. */
  attention: boolean;
}

/** A step that has shown nothing for this long says so. */
export const QUIET_STEP_MS = 3 * 60_000;

/** What a step is, in words: a command's own description when the agent gave one, else what kind of step it is. */
export function stepLabel(a: Activity): string {
  switch (a.kind) {
    case "command": {
      const said = /^# (.+)$/m.exec(a.detail)?.[1]?.trim();
      return said || "Running a command";
    }
    case "thinking":
      return "Thinking";
    case "plan":
      return "Updating its plan";
    default:
      return a.title;
  }
}

/** "(6 of 10)" from a retry's "attempt 6/10" or "2/5", or nothing. */
function attempt(s: string): string {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(s);
  return m ? ` (${m[1]} of ${m[2]})` : "";
}

/** A retry the agent reported (Claude Code: "Retrying (overloaded_error, attempt 6/10)"; Codex: "Retrying: …"). */
function retryWords(detail: string, provider: Member["provider"]): string | null {
  const m = /^Retrying\b[\s:(]*(.*?)\)?$/s.exec(detail.trim());
  if (!m) return null;
  const why = m[1] ?? "";
  const who = provider === "codex" ? "OpenAI's" : "Claude's";
  const what = /overload|529|capacity|busy/i.test(why)
    ? `${who} servers are busy`
    : /rate.?limit|429|too many/i.test(why)
      ? "Hit a rate limit"
      : /\b5\d\d\b|server|api_error|internal|unavailable/i.test(why)
        ? `${who} servers had a problem`
        : /timeout|timed out|disconnect|network|connect|socket|stream|ECONN/i.test(why)
          ? "Connection trouble"
          : null;
  return what ? `${what}: trying again${attempt(why)}` : `Trying again${attempt(why)}`;
}

/** Details the agents send that mean more than their state, in plain words (older hubs' wording too). */
const PLAIN: [RegExp, string][] = [
  [/^Starting (Claude Code|Codex)$/, "Starting $1"],
  [/^Compacting( the conversation)?$/i, "Compacting the conversation"],
  [/^Finishing helpers before (applying settings|your new settings apply)$/, "Finishing helpers before your new settings apply"],
  // What waits, when it can't be answered around (an account switch, tighter permissions: shared heldWords).
  [/^Finishing helpers before (your (?:account switch|permission change) applies|your changes apply)$/, "Finishing helpers before $1"],
  [/^Reading your message$/, "Reading your message"],
  [/^Copying the conversation$/, "Copying the conversation"],
];

/** How long, roughly, in minutes: "6 min". */
function minutes(ms: number): string {
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

/**
 * The words on a chat's status line while its agent works. The agent's own status detail leads when it says more than
 * its state (retrying, starting up, compacting); then the step it's on; then its state. A finished step's title (the
 * detail an agent keeps after the step ends) is never repeated, and a step with no output for 3 minutes says so.
 */
export function statusWords(member: Pick<Member, "status" | "statusDetail" | "provider" | "wait">, steps: Activity[], now = Date.now()): StatusWords {
  const detail = member.statusDetail?.trim() ?? "";
  if (member.status === "approval") return { text: detail.startsWith("Asks:") ? "Has a question for you" : "Waiting for your approval", note: null, attention: true };
  // Out of messages until its limit resets: said from the wait itself, so the time is this device's own clock and not
  // the hub's (the hub's sentence stands in for an older hub). Nothing to do, so it isn't the attention style.
  if (member.status === "waiting") return { text: member.wait ? limitWaitWords(member.wait, now) : detail || "Waiting for its usage limit to reset", note: null, attention: false };
  if (member.status === "queued") return { text: "Starting…", note: null, attention: false };
  const retry = detail ? retryWords(detail, member.provider) : null;
  if (retry) return { text: retry, note: null, attention: true };
  for (const [re, words] of PLAIN) if (re.test(detail)) return { text: detail.replace(re, words), note: null, attention: false };
  const running = steps.findLast((a) => a.status === "running" && a.kind !== "thinking") ?? steps.findLast((a) => a.status === "running");
  if (running && (running.kind !== "thinking" || member.status === "thinking")) {
    const quiet = now - Math.max(running.updatedAt, running.createdAt);
    if (running.kind === "thinking" || quiet < QUIET_STEP_MS) return { text: stepLabel(running), note: null, attention: false };
    const command = running.kind === "command";
    // A command can't be typed into from here: Stop is the way on if it's stuck.
    return { text: stepLabel(running), note: `No output for ${minutes(quiet)}${command ? ": it may be waiting for input. Tap Stop if it's stuck." : ""}`, attention: command };
  }
  if (member.status === "thinking") return { text: "Thinking", note: null, attention: false };
  // A detail that names no step at all says more than "Working"; one that names a finished step is old news (the hub
  // keeps a step's title, up to 120 characters, as the detail until something else happens).
  if (detail && !steps.some((a) => a.title.slice(0, 120).trim() === detail)) return { text: detail, note: null, attention: false };
  return { text: "Working", note: null, attention: false };
}
