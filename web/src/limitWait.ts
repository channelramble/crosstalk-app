// A chat waiting for its agent's usage limit to reset (hub engine.ts, Turn.wait): the countdown and the line under the
// reply. The one sentence itself lives in shared (limitWaitWords), so the chat, the chat list, the agent's status and
// the notification all say the same thing; only the live countdown is worked out here.

import { limitResetTime, type LimitWait } from "@crosstalk/shared";

/** How long until it carries on, in a few plain words: "any moment", "in 7 min", "in 2 h 5 min". */
export function limitCountdown(runAt: number, now = Date.now()): string {
  const left = runAt - now;
  if (left <= 30_000) return "any moment";
  const mins = Math.round(left / 60_000);
  if (mins < 1) return "in under a minute";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

/**
 * The line under a waiting reply. With a known reset it names the time and counts down to it; with none it says only
 * when Crosstalk tries again, never a time the agent didn't give.
 */
export function limitWaitLine(wait: Pick<LimitWait, "resetsAt" | "runAt">, now = Date.now()): string {
  const countdown = limitCountdown(wait.runAt, now);
  if (wait.runAt <= now + 30_000) return "Carrying on any moment";
  if (wait.resetsAt && wait.resetsAt > now) return `Carries on at ${limitResetTime(wait.resetsAt, now)} · ${countdown}`;
  return `Trying again ${countdown}`;
}

/**
 * The few words a chat's row in the list shows while it waits: "Back at 3:20 PM", or "Back soon" when the agent never
 * said when. Short enough to sit beside a chat's name on a phone.
 */
export function limitBackWords(wait: Pick<LimitWait, "resetsAt">, now = Date.now()): string {
  return wait.resetsAt && wait.resetsAt > now + 30_000 ? `Back at ${limitResetTime(wait.resetsAt, now)}` : "Back soon";
}

/** How often to redraw the countdown: every 15 s in the last few minutes, every half minute after that. */
export function countdownTickMs(runAt: number, now = Date.now()): number {
  return runAt - now <= 3 * 60_000 ? 15_000 : 30_000;
}
