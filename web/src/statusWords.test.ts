import { expect, test } from "bun:test";
import { limitResetTime, limitWaitWords, type Activity, type LimitWait, type Member } from "@crosstalk/shared";
import { QUIET_STEP_MS, statusWords } from "./statusWords";

const NOW = 1_800_000_000_000;
const member = (status: Member["status"], statusDetail: string | null = null, provider: Member["provider"] = "claude") => ({ status, statusDetail, provider });
const step = (title: string, extra: Partial<Activity> = {}): Activity => ({ id: title, roomId: "r", turnId: "t", memberId: "m", kind: "command", title, detail: "", status: "running", createdAt: NOW - 1000, updatedAt: NOW - 1000, ...extra });

test("retrying: what's wrong and how far it got, in the attention style", () => {
  expect(statusWords(member("thinking", "Retrying (overloaded_error, attempt 6/10)"), [], NOW)).toEqual({ text: "Claude's servers are busy: trying again (6 of 10)", note: null, attention: true });
  expect(statusWords(member("thinking", "Retrying (rate_limit_error, attempt 2/10)"), [], NOW).text).toBe("Hit a rate limit: trying again (2 of 10)");
  expect(statusWords(member("thinking", "Retrying (api_error, attempt 3/10)"), [], NOW).text).toBe("Claude's servers had a problem: trying again (3 of 10)");
  expect(statusWords(member("thinking", "Retrying (error, attempt 1/10)"), [], NOW).text).toBe("Trying again (1 of 10)");
  // Codex says what went wrong in its own words.
  expect(statusWords(member("thinking", "Retrying: stream disconnected before completion", "codex"), [], NOW)).toEqual({ text: "Connection trouble: trying again", note: null, attention: true });
  expect(statusWords(member("thinking", "Retrying: Reconnecting... 2/5 (server overloaded)", "codex"), [], NOW).text).toBe("OpenAI's servers are busy: trying again (2 of 5)");
});

test("starting, compacting, reading and finishing helpers say so instead of Thinking or Working", () => {
  expect(statusWords(member("thinking", "Starting Claude Code"), [], NOW).text).toBe("Starting Claude Code");
  expect(statusWords(member("thinking", "Starting Codex", "codex"), [], NOW).text).toBe("Starting Codex");
  expect(statusWords(member("working", "Compacting the conversation", "codex"), [], NOW).text).toBe("Compacting the conversation");
  expect(statusWords(member("thinking", "Reading your message"), [], NOW).text).toBe("Reading your message");
  expect(statusWords(member("working", "Finishing helpers before your new settings apply"), [], NOW).text).toBe("Finishing helpers before your new settings apply");
  // An older hub's wording.
  expect(statusWords(member("working", "Finishing helpers before applying settings"), [], NOW).text).toBe("Finishing helpers before your new settings apply");
  // What waits, when it isn't only new settings (shared heldWords).
  for (const what of ["your account switch applies", "your permission change applies", "your changes apply"]) expect(statusWords(member("working", `Finishing helpers before ${what}`), [], NOW).text).toBe(`Finishing helpers before ${what}`);
  // Plain states.
  expect(statusWords(member("thinking", "Thinking"), [], NOW).text).toBe("Thinking");
  expect(statusWords(member("queued"), [], NOW).text).toBe("Starting…");
  expect(statusWords(member("approval", "npm test"), [], NOW)).toEqual({ text: "Waiting for your approval", note: null, attention: true });
  expect(statusWords(member("approval", "Asks: Which database?"), [], NOW).text).toBe("Has a question for you");
});

test("the step it's on; a finished step's title isn't repeated", () => {
  const running = step("npm test", { detail: "# Run the tests\nnpm test" });
  expect(statusWords(member("working", "npm test"), [running], NOW).text).toBe("Run the tests");
  expect(statusWords(member("working", "Read src/app.ts"), [step("Read src/app.ts", { kind: "tool" })], NOW).text).toBe("Read src/app.ts");
  // The step ended and nothing else happened yet: the hub still names it, the line doesn't.
  const done = step("npm test", { status: "done" });
  expect(statusWords(member("working", "npm test"), [done], NOW).text).toBe("Working");
  const long = step(`Edit ${"x".repeat(150)}`, { kind: "file_change", status: "done" });
  expect(statusWords(member("working", long.title.slice(0, 120)), [long], NOW).text).toBe("Working");
  // A thought that's still open while it writes its reply isn't the step it's on.
  expect(statusWords(member("working"), [step("Thinking", { kind: "thinking", detail: "Hmm" })], NOW).text).toBe("Working");
  expect(statusWords(member("thinking"), [step("Thinking", { kind: "thinking", detail: "Hmm" })], NOW).text).toBe("Thinking");
});

test("waiting for a usage limit says when it comes back, in this device's clock, and isn't the attention style", () => {
  const wait: LimitWait = { provider: "claude", account: "default", accountLabel: null, kind: "usage", label: "5-hour", resetsAt: NOW + 3600_000, runAt: NOW + 3660_000, tries: 1, since: NOW, source: "event" };
  const said = limitWaitWords(wait, NOW);
  expect(said).toContain(limitResetTime(NOW + 3600_000, NOW));
  // The hub's own wording came with the status; the wait itself is what the words are made from, so a phone in another
  // timezone shows its own time, not the hub's.
  const hubWords = "Claude Code is out of messages until 4:20 AM. It'll carry on then.";
  expect(statusWords({ ...member("waiting", hubWords), wait }, [], NOW)).toEqual({ text: said, note: null, attention: false });
  // A step left open by the reply the limit stopped doesn't become the line.
  expect(statusWords({ ...member("waiting", hubWords), wait }, [step("npm test")], NOW).text).toBe(said);
  // From a hub that doesn't send the wait, its sentence stands in; from an older one that says nothing, plain words.
  expect(statusWords(member("waiting", hubWords), [], NOW).text).toBe(hubWords);
  expect(statusWords(member("waiting"), [], NOW).text).toBe("Waiting for its usage limit to reset");
});

test("a step with no output for 3 minutes or more says so (a command may be waiting for input)", () => {
  const quiet = step("npm run dev", { createdAt: NOW - 6 * 60_000, updatedAt: NOW - 6 * 60_000 });
  expect(statusWords(member("working", "npm run dev"), [quiet], NOW)).toEqual({ text: "Running a command", note: "No output for 6 min: it may be waiting for input. Tap Stop if it's stuck.", attention: true });
  const tool = step("Search the web", { kind: "tool", createdAt: NOW - 4 * 60_000, updatedAt: NOW - 4 * 60_000 });
  expect(statusWords(member("working"), [tool], NOW)).toEqual({ text: "Search the web", note: "No output for 4 min", attention: false });
  // Output a moment ago: nothing to say.
  const busy = step("npm test", { createdAt: NOW - 10 * 60_000, updatedAt: NOW - 30_000 });
  expect(statusWords(member("working"), [busy], NOW).note).toBeNull();
  expect(statusWords(member("working"), [step("npm test", { updatedAt: NOW - QUIET_STEP_MS + 1000, createdAt: NOW - QUIET_STEP_MS + 1000 })], NOW).note).toBeNull();
});
