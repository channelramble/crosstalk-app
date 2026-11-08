// Settings → Set up with an AI agent (docs/SETUP-FOR-AGENTS.md): the hub's setup checklist in plain words, and what to
// give an AI agent on that machine. Pure, for the unit tests; the section itself is views/AgentSetupSection.tsx.
import type { BrowserOsConnect, BrowserOsConnectRow, SetupChecklist, SetupFix, SetupItem, SetupState } from "@crosstalk/shared";
import { tabForSection } from "./settingsTabs";

/** Each state as the list says it. */
export const STATE_WORDS: Record<SetupState, string> = { user: "Needs you", missing: "To do", unknown: "Not checked", done: "Done" };

/** An item's state in a word: one that's only nice to have and not done is the person's choice, not a to-do. */
export function stateWord(i: SetupItem): string {
  return i.optional && (i.state === "user" || i.state === "missing") ? "Your choice" : STATE_WORDS[i.state];
}

const RANK: Record<SetupState, number> = { user: 0, missing: 1, unknown: 2, done: 3 };

/** What needs you first, then what an agent can do, then what couldn't be checked; within each, the hub's order. */
export function byState(items: SetupItem[]): SetupItem[] {
  return items.map((item, i) => ({ item, i })).sort((a, b) => RANK[a.item.state] - RANK[b.item.state] || a.i - b.i).map((x) => x.item);
}

/** The list's three parts: what's left that's needed, what's left that's optional, and what's done. */
export function parts(c: SetupChecklist): { left: SetupItem[]; optional: SetupItem[]; done: SetupItem[] } {
  return {
    left: byState(c.items.filter((i) => !i.optional && i.state !== "done")),
    optional: byState(c.items.filter((i) => i.optional && i.state !== "done")),
    done: c.items.filter((i) => i.state === "done"),
  };
}

/** Everything needed is done (optional items aside). */
export const allDone = (c: SetupChecklist) => c.summary.total > 0 && c.summary.done === c.summary.total;

/** "9 of 12 done · 2 need you · 1 to do". */
export function summaryText(c: SetupChecklist): string {
  const s = c.summary;
  return [`${s.done} of ${s.total} done`, s.user ? `${s.user} need${s.user === 1 ? "s" : ""} you` : "", s.missing ? `${s.missing} to do` : "", s.unknown ? `${s.unknown} not checked` : ""].filter(Boolean).join(" · ");
}

/** What to tell the agent, and where it can look when its setup tools aren't added yet. */
export function agentPrompt(c: SetupChecklist): string {
  return `${c.connect.prompt} If you don't have those tools, run ${c.connect.cli} instead, and read ${c.connect.guide}.`;
}

/** An agent whose own `mcp add` adds the setup tools (the commands in a checklist's `connect`). */
export type SetupAgent = "claude" | "codex" | "gemini";

/**
 * How "Add for me" ended: the tools are new there, were there already, or it didn't work. "unread": it ended without
 * saying it worked and what it printed couldn't be read, so which of the last two it was isn't known (Claude Code
 * exits 1 for both).
 */
export type AddOutcome = "added" | "already" | "failed" | "unread";

/**
 * Each agent's words for "that server is already configured", as the CLIs printed them (`mcp add` run twice against a
 * throwaway HOME, so nothing of the person's was touched):
 *
 * - Claude Code 2.1.289 refuses, exit 1: `MCP server crosstalk-setup already exists in user config` (its other scopes
 *   say "local config" and ".mcp.json").
 * - Codex 0.160.0 doesn't refuse: exit 0 and `Added global MCP server 'crosstalk-setup'.` both times, because it
 *   overwrites. It has no "already" wording at all, so its exit code alone says the tools are there.
 * - Gemini CLI 0.62.0 doesn't refuse either: exit 0, `MCP server "crosstalk-setup" is already configured within user
 *   settings.` and then `MCP server "crosstalk-setup" updated in user settings.`
 *
 * These are a vendor's words and may change, so they only ever tell "it was already there" from a real failure: what
 * decides whether the command worked is the exit code the hub reports (PtyInfo), not any of this text. Words nobody
 * here knows, with the command failed, stay a plain failure: better to say it didn't work than to claim it did.
 */
const ALREADY_THERE: Record<SetupAgent, RegExp> = {
  claude: /\bMCP server\b[^\n]*\balready exists\b/i,
  codex: /\bMCP server\b[^\n]*\balready (?:exists|configured)\b/i,
  gemini: /\bMCP server\b[^\n]*\balready configured\b/i,
};

/**
 * What an agent's own `mcp add` did, from the exit code the hub reports and that agent's output. `exitCode` null: it
 * ended without one (it was stopped), which is no proof it worked. `output` null: what it printed couldn't be read
 * (only its exit code came, over the live connection), so a command that didn't end with 0 is "unread", not "failed".
 */
export function addOutcome(agent: SetupAgent, exitCode: number | null, output: string | null): AddOutcome {
  if (output !== null && ALREADY_THERE[agent].test(output)) return "already";
  if (exitCode === 0) return "added";
  return output === null ? "unread" : "failed";
}

/**
 * The command that takes an agent's existing crosstalk-setup entry out again, built from the one that adds it (its own
 * program name, which is the first word of that command). Only Claude Code has one: it refuses a name that is already
 * in that scope without looking at the command, so its "already exists" says a `crosstalk-setup` is there and nothing
 * about what it runs — an entry from an older install (another binary path, or no `-e CROSSTALK_HOME=…`) refuses the
 * same way (measured with claude 2.1.289: a second `mcp add` with a different command printed "MCP server
 * crosstalk-setup already exists in user config", exit 1, and left the first entry as it was). Codex and Gemini
 * overwrite instead, so for them "already there" also means "and now it's the right one".
 */
export function removeCommand(agent: SetupAgent, add: string | null): string | null {
  if (agent !== "claude") return null;
  const program = (add ?? "").trim().split(/\s+/)[0];
  return program ? `${program} mcp remove crosstalk-setup -s user` : null;
}

/**
 * The agents Settings gives a command for, with whether each is installed there (only then can it be added for you).
 *
 * The checklist's item decides, except where its state isn't about the program at all: "unknown" is also what an
 * installed agent gets when its sign-in couldn't be checked (`claude auth status` didn't answer in time, say), so for
 * that one the machine's own word on its agents (`installedThere`, its ProviderStatus) settles whether it is there.
 * The hub needs nothing more to run the add (POST /api/setup/connect only looks the program up).
 */
export function connectRows(c: SetupChecklist, installedThere: Partial<Record<"claude" | "codex", boolean>> = {}): { agent: "claude" | "codex"; name: string; command: string; installed: boolean }[] {
  const installed = (agent: "claude" | "codex") => {
    const state = c.items.find((i) => i.id === `agent.${agent}`)?.state;
    return state === "done" || state === "user" || (state === "unknown" && installedThere[agent] === true);
  };
  return [
    { agent: "claude", name: "Claude Code", command: c.connect.claude, installed: installed("claude") },
    { agent: "codex", name: "Codex", command: c.connect.codex, installed: installed("codex") },
  ];
}

/**
 * BrowserOS neo's own connect block, when the hub had one to give. An older hub sends no `browseros` at all, so this
 * is the one place the app decides that means "nothing to show" rather than showing a command nobody can run.
 */
export function browserosConnect(c: SetupChecklist): BrowserOsConnect | null {
  const b = c.connect.browseros;
  return b && typeof b.url === "string" && b.url ? b : null;
}

/**
 * The agents on that machine with the exact command that points each one at the browser, the connected ones last:
 * what is left to do belongs at the top of a phone screen. Empty when there is no address yet, or no agent there.
 */
export function browserosRows(c: SetupChecklist): BrowserOsConnectRow[] {
  const b = browserosConnect(c);
  if (!b) return [];
  return [...b.rows].sort((x, y) => Number(x.connected) - Number(y.connected));
}

/** The one thing a command alone doesn't do, said once under the list. Null when there's no command to say it about. */
export function browserosNote(c: SetupChecklist): string | null {
  const b = browserosConnect(c);
  return b && b.rows.some((r) => !r.connected) ? b.restart : null;
}

/**
 * Where "Go there" goes for a fix, when it names a section of Settings. Which tab holds it is settingsTabs.ts's to
 * know, so a new section the hub points at works here the day it's grouped.
 */
export function goThere(fix: SetupFix | null): string | null {
  return fix?.target && tabForSection(fix.target) ? fix.target : null;
}

/** "Open login.tailscale.com", for a fix's web page. */
export function linkLabel(url: string): string {
  try {
    return `Open ${new URL(url).host}`;
  } catch {
    return "Open the page";
  }
}
