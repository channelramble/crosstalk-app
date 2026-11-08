import type { Provider, Room } from "@crosstalk/shared";

// What an agent is told about the person working alongside it: they don't stop while its helpers and background jobs run,
// they send more, often new work on the same project, and the agent should work around and with that.
//
// This goes with every request, so every word is paid for again and again. One place, and each agent only what's true of
// it: telling OpenCode or Crosstalk's own agent to start work in the background would be wrong, not only costly (they
// can't, see below). hub/test/alongside.test.ts holds each agent to its text and each text to its size.
//
// It's the same with Settings → "Keep going while helpers work" off, on purpose: nothing here says how fast a message gets
// to the agent. The person can still write while helpers run, and what reaches the agent is still answered now. Off only
// means a message waits longer, or for a tap, before it does.

/** The part about not holding the chat up. Only for an agent whose helpers and jobs can outlive its reply. */
const KEEP_ANSWERING =
  "The user can keep messaging you while your helpers and background jobs run, often with new work on this project. Answer now; wait for a helper only if a request truly needs its result, then say so and carry on with what else you can.";

/** Only for an agent that's woken when its background work ends: one that isn't would start the work and stop there. */
const IN_THE_BACKGROUND = "Start long work in the background so the chat stays free, and don't ask the user to wait.";

/** The part about the helpers themselves. */
const HELPERS =
  "Give each helper its own files or a separate worktree, so it can't collide with you or the user. When a helper reports back, check what changed since it started before acting on it: the user's newer instructions win. Integrate the result and report it briefly.";

/**
 * Each kind of agent's text, in its ordinary chats (alongsideNote says when Claude Code and Codex get less). A record of
 * every provider, so a new agent has to say what applies to it.
 */
export const ALONGSIDE = {
  // Its helpers and jobs outlive a reply, and it answers their reports in a turn of its own (AgentDriver.owedTurn).
  claude: `${KEEP_ANSWERING} ${IN_THE_BACKGROUND} ${HELPERS}`,
  // The same, except that Codex starts no turn by itself: a helper's answer waits in its app-server for the chat's next
  // turn (codex.ts leftAnswers). Told to background long work it could end its reply there and do nothing more until the
  // person's next message ("run the suite, fix what fails, then commit" would stop at "started"; another chat's agent would
  // get that as its answer). A message reaches a running Codex turn anyway (steer, by itself or with a tap), so it stays in
  // its reply. And "I'll report back when it's done" would be untrue, so the person has to know when it does leave something
  // running.
  codex: `${KEEP_ANSWERING} ${HELPERS} Nothing wakes you when a helper or job ends: you get its result at the user's next message. So keep a multi-step request moving in your reply unless they asked to go on later, and say so when you end a reply with one running.`,
  // Nothing of OpenCode's goes to the background (the plugin takes that off every call: opencode.ts chatPlugin) and it has
  // no Send now, so messages wait for its reply. What's left: subagents can run at once, inside the reply.
  opencode: "Subagents run inside your reply. Give each its own files, so they can't collide with each other, you or the user, who may be working here too.",
  // No helpers, no jobs it hears back from, and no turn of its own. What's left: Send now reaches it between steps (builtin.ts).
  builtin: "A message from the user can reach you between steps, and may be new work: answer it now, then carry on with what's left. Their newest instruction wins.",
  // The hub gives these no standing instructions at all (a group chat's briefing aside), and starts them on no background
  // work it knows of; only an older room can still hold one (Chats.provider).
  muse: null,
  gemini: null,
  antigravity: null,
  mock: null,
} satisfies Record<Provider, string | null>;

/**
 * What a Claude Code or Codex process is told, with its other standing instructions. `null`:
 * - A one-off question (Ask others, a teamwork helper): one read-only process that nobody sends anything to.
 * - A lean Codex thread (shared leanCodexTools): a small window, no helpers at all, so these words would only take room.
 *
 * Wherever the end of a reply hands the work on, only the part about helpers: Build & review (Engine.reviewLoop), everyone
 * answering in turn (the next agent starts from what this one said), and relay and lead rooms (an @mention starts the next
 * agent as the reply ends). An agent that started its work in the background and answered at once would hand half-done work
 * to a reviewer, or to the next agent in the same folder. Their briefings say to let helpers finish first, which also
 * reaches a process started before the room's mode changed. Only "direct" answers the person alone.
 *
 * A Claude Code chat on a small model of your own isn't lean: it keeps its helpers, so these words still apply to it.
 */
export function alongsideNote(provider: "claude" | "codex", room: Pick<Room, "mode">, o: { ephemeral?: boolean; lean?: boolean } = {}): string | null {
  if (o.ephemeral || o.lean) return null;
  return room.mode === "direct" ? ALONGSIDE[provider] : HELPERS;
}
