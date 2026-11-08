import { describe, expect, test } from "bun:test";
import { staleSignInWords, type Member, type SignInNeed, type SignInSession } from "@crosstalk/shared";
import {
  PHONE_SIGN_IN,
  SHEET_ACTIONS,
  agentNeeds,
  chatNeeds,
  chatPromptLine,
  checklistAgent,
  checklistPromptLine,
  codeProblemWords,
  isStaleSignInNote,
  liveSession,
  newerSession,
  sessionEnded,
  settingsPromptLine,
  sheetView,
  signInTitle,
} from "./signIn";

// Signing an agent in again from the phone: who is asked, in which words, and what the sign-in sheet shows at each step.
// A Claude Code chat can stop with "Failed to authenticate: OAuth session expired and could not be refreshed", and
// the only fix used to be a terminal on that machine. The hub's side (hub/test/signin.test.ts) hands the phone a
// SignInNeed and a SignInSession; these are what the phone makes of them.

const NOW = Date.UTC(2026, 10, 1, 9, 40, 0);
const MACHINE = { id: "h_mini", name: "Mac mini" };

const need = (over: Partial<SignInNeed> = {}): SignInNeed => ({
  provider: "claude",
  account: "default",
  accountLabel: null,
  machine: MACHINE,
  since: NOW - 60_000,
  rooms: ["r_enmyh53k9w2s"],
  words: "Claude Code is signed out on Mac mini, so it couldn't answer. Sign in to it again (Settings → Agents → Claude Code → Sign in), then tap Try again.",
  ...over,
});

const URL_CLAUDE = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc123";
const session = (over: Partial<SignInSession> = {}): SignInSession => ({
  id: "si_1",
  provider: "claude",
  account: "default",
  accountLabel: null,
  machine: MACHINE,
  method: "paste",
  state: "open",
  url: URL_CLAUDE,
  userCode: null,
  wantsCode: true,
  codesSent: 0,
  codeRefused: false,
  words: "Open the sign-in link and sign in with the Claude account that has your plan. The page then shows a code: copy all of it and paste it here.",
  startedAt: NOW - 30_000,
  expiresAt: NOW + 9 * 60_000,
  endedAt: null,
  ...over,
});

const member = (provider: Member["provider"], account?: string, status: Member["status"] = "idle") => ({ provider, config: account ? { account } : {}, status });

describe("who is asked to sign in, and in which words", () => {
  test("the title names the agent, its account when it isn't the agent's own, and the machine", () => {
    expect(signInTitle({ provider: "claude", account: "default" }, "Mac mini")).toBe("Sign in to Claude Code on Mac mini");
    expect(signInTitle({ provider: "claude", account: "a_work", accountLabel: "Work" }, "Mac mini")).toBe("Sign in to Claude Code (Work) on Mac mini");
    // The agent's own sign-in never shows a label, whatever it's called.
    expect(signInTitle({ provider: "codex", account: "default", accountLabel: "Main" }, "Linux box")).toBe("Sign in to Codex on Linux box");
  });

  test("a chat shows the needs of its own agents' accounts, every chat on them, once each", () => {
    const own = need();
    const work = need({ account: "a_work", accountLabel: "Work", rooms: [] });
    const codex = need({ provider: "codex", rooms: [] });
    const needs = [own, work, codex];
    // A chat on the default account: its need, even though another chat's reply was the one that stopped.
    expect(chatNeeds(needs, [member("claude")])).toEqual([own]);
    // On the Work account: Work's, never the default's.
    expect(chatNeeds(needs, [member("claude", "a_work")])).toEqual([work]);
    // A group chat: each agent's, in the chat's order, and one need however many agents share the account.
    expect(chatNeeds(needs, [member("codex"), member("claude"), member("claude")])).toEqual([codex, own]);
    // Nothing signed out, or a hub that doesn't say: nothing.
    expect(chatNeeds([], [member("claude")])).toEqual([]);
    expect(chatNeeds(null, [member("claude")])).toEqual([]);
    expect(chatNeeds(needs, [member("muse")])).toEqual([]);
  });

  test("Settings lists an agent's own sign-in first, then its other accounts as they were found", () => {
    const later = need({ account: "a_b", accountLabel: "B", since: NOW });
    const earlier = need({ account: "a_a", accountLabel: "A", since: NOW - 5000 });
    const own = need({ since: NOW + 1000 });
    expect(agentNeeds([later, need({ provider: "codex" }), own, earlier], "claude")).toEqual([own, earlier, later]);
    expect(agentNeeds(null, "claude")).toEqual([]);
  });

  test("the chat's line: a chat whose reply stopped is told to tap Try again after; one that hasn't tried isn't", () => {
    expect(chatPromptLine(need(), { stopped: true, device: "this iPhone" })).toBe("Claude Code is signed out on Mac mini, so it couldn't answer. Sign it in again from this iPhone, then tap Try again.");
    expect(chatPromptLine(need({ account: "a_work", accountLabel: "Work" }), { stopped: false, device: "this iPhone" })).toBe("Claude Code (Work) is signed out on Mac mini, so it can't answer here until it's signed in again.");
  });

  test("Settings says what waits on it; the checklist that it's done from here", () => {
    expect(settingsPromptLine({ rooms: [] })).toBe("Its chats can't answer until it's signed in again.");
    expect(settingsPromptLine({ rooms: ["r1"] })).toBe("Its chats can't answer until it's signed in again. A chat stopped on it.");
    expect(settingsPromptLine({ rooms: ["r1", "r2"] })).toBe("Its chats can't answer until it's signed in again. 2 chats stopped on it.");
    expect(checklistPromptLine("Mac mini", "this iPhone")).toBe("From this iPhone: no need to be at Mac mini.");
    expect(checklistPromptLine("Mac mini", "this device")).toBe("From here: no need to be at Mac mini.");
  });

  test("the checklist offers it for an agent it can sign in that waits on you, and nothing else", () => {
    expect(checklistAgent({ id: "agent.claude", state: "user" })).toBe("claude");
    expect(checklistAgent({ id: "agent.codex", state: "user" })).toBe("codex");
    expect(checklistAgent({ id: "agent.muse", state: "user" })).toBe("muse");
    expect(checklistAgent({ id: "agent.gemini", state: "user" })).toBe("gemini");
    // Antigravity CLI opens a menu first: the hub signs it in only from its terminal.
    expect(checklistAgent({ id: "agent.antigravity", state: "user" })).toBeNull();
    // Signed in, not installed (an agent can install it), or not known yet: nothing to sign in to.
    for (const state of ["done", "missing", "unknown"]) expect(checklistAgent({ id: "agent.claude", state })).toBeNull();
    expect(checklistAgent({ id: "service", state: "user" })).toBeNull();
    expect(checklistAgent({ id: "agent.claude.extra", state: "user" })).toBeNull();
    expect(PHONE_SIGN_IN).not.toContain("antigravity");
  });
});

describe("which copy of a sign-in the sheet goes by", () => {
  test("a sheet opened again carries on with the sign-in that's going for that account, while it has time left", () => {
    const going = session({ id: "si_old", startedAt: NOW - 120_000 });
    const newer = session({ id: "si_new", startedAt: NOW - 10_000 });
    const all = { [going.id]: going, [newer.id]: newer };
    expect(liveSession(all, { provider: "claude", account: "default" }, NOW)?.id).toBe("si_new");
    // Another account's, another agent's, one that ended, one about to run out: none of those.
    expect(liveSession(all, { provider: "claude", account: "a_work" }, NOW)).toBeNull();
    expect(liveSession([session({ state: "done", endedAt: NOW })], { provider: "claude", account: "default" }, NOW)).toBeNull();
    expect(liveSession([session({ expiresAt: NOW + 30_000 })], { provider: "claude", account: "default" }, NOW)).toBeNull();
    expect(liveSession([session({ provider: "codex", method: "device" })], { provider: "claude", account: "default" }, NOW)).toBeNull();
  });

  test("the live updates win; an answer is kept only when nothing newer came", () => {
    // Starting: the answer only when no update has come yet (an update may already say the link is there).
    expect(newerSession(undefined, session({ state: "starting" }), "start")).toBe(true);
    expect(newerSession(session(), session({ state: "starting", url: null }), "start")).toBe(false);
    // A pasted code: the answer ("checking") when the copy here is from before that paste, not after the agent turned it down.
    expect(newerSession(session({ codesSent: 0 }), session({ state: "checking", codesSent: 1 }), "code")).toBe(true);
    expect(newerSession(session({ codesSent: 1, codeRefused: true }), session({ state: "checking", codesSent: 1 }), "code")).toBe(false);
    expect(newerSession(session({ state: "done", endedAt: NOW }), session({ state: "checking", codesSent: 1 }), "code")).toBe(false);
    // Asked while the live updates can't come: the hub's answer is all there is.
    expect(newerSession(session(), session({ state: "expired", endedAt: NOW }), "poll")).toBe(true);
    expect(sessionEnded(session({ state: "cancelled", endedAt: NOW }))).toBe(true);
    expect(sessionEnded(session({ state: "checking" }))).toBe(false);
  });
});

describe("the sign-in sheet, step by step", () => {
  const view = (s: SignInSession | null, over: { stopped?: boolean; problem?: Parameters<typeof sheetView>[0]["problem"] } = {}) => sheetView({ session: s, problem: over.problem ?? null, agent: "Claude Code", machine: "Mac mini", stopped: over.stopped });

  test("starting: the hub's words (or Crosstalk's own before it answers), a spinner, and Cancel", () => {
    expect(view(null)).toMatchObject({ phase: "starting", words: "Starting Claude Code's sign-in on Mac mini…", busy: true, url: null, actions: ["cancel"] });
    expect(view(session({ state: "starting", url: null, words: "Starting Claude Code's sign-in on Mac mini…" }))).toMatchObject({ phase: "starting", busy: true });
  });

  test("Claude Code's link and paste box: the link to open, the box once it asks for the code", () => {
    const open = view(session());
    expect(open).toMatchObject({ phase: "open", step: "open-paste", tone: "status", url: URL_CLAUDE, code: null, paste: { ready: true, refused: false, newLink: false }, waiting: null, busy: false, actions: ["cancel"] });
    expect(open.words).toBe("Open the sign-in link and sign in with the Claude account that has your plan. The page then shows a code: copy all of it and paste it here.");
    // The link is there but Claude Code hasn't asked for the code yet: the box waits, and says so.
    expect(view(session({ wantsCode: false }))).toMatchObject({ paste: { ready: false, refused: false, newLink: false }, waiting: "Waiting for Claude Code to ask for the code…" });
  });

  test("a code Claude Code turned down: said at once, and the box is ready for the whole code", () => {
    const refused = view(session({ codeRefused: true, codesSent: 1, words: "Claude Code didn't take that code. Copy the whole code from the sign-in page and paste it again." }));
    expect(refused).toMatchObject({ phase: "open", tone: "alert", paste: { ready: true, refused: true, newLink: false } });
    expect(refused.words).toBe("Claude Code didn't take that code. Copy the whole code from the sign-in page and paste it again.");
  });

  test("a code Gemini CLI turned down: it made a new link, so that's what to open next, not the old page", () => {
    const words = "That code didn't work, and Gemini CLI made a new sign-in link. Open the sign-in page again, sign in, and paste the new code it shows.";
    const relinked = sheetView({ session: session({ provider: "gemini", url: "https://accounts.google.com/o/oauth2/v2/auth?state=s2", codeRefused: true, codesSent: 1, words }), problem: null, agent: "Gemini CLI", machine: "Mac mini" });
    expect(relinked).toMatchObject({ phase: "open", tone: "alert", url: "https://accounts.google.com/o/oauth2/v2/auth?state=s2", paste: { ready: true, refused: true, newLink: true }, words });
  });

  test("a device code (Codex, Muse Code): the code in large type, and what it waits for", () => {
    const codex = sheetView({ session: session({ provider: "codex", method: "device", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", wantsCode: false, words: "Open the sign-in link on any device, sign in, and enter this code: ABCD-EFGH." }), problem: null, agent: "Codex", machine: "Mac mini" });
    expect(codex).toMatchObject({ phase: "open", step: "open-device", code: { value: "ABCD-EFGH", confirm: false }, paste: null, waiting: "Waiting for you to approve in the browser…", actions: ["cancel"] });
    // Muse Code shows the code itself on the page: you check it matches.
    const muse = sheetView({ session: session({ provider: "muse", method: "device", url: "https://auth.meta.com/device?user_code=WXYZ-1234", userCode: "WXYZ-1234", wantsCode: false, words: "Open the sign-in link on any device, sign in, and check it shows this code: WXYZ-1234." }), problem: null, agent: "Muse Code", machine: "Mac mini" });
    expect(muse.code).toEqual({ value: "WXYZ-1234", confirm: true });
  });

  test("checking, then signed in: what happens next depends on where it was opened from", () => {
    expect(view(session({ state: "checking", wantsCode: false, codesSent: 1, words: "Checking the code with Claude Code…" }))).toMatchObject({ phase: "checking", busy: true, url: null, paste: null, words: "Checking the code with Claude Code…", actions: ["cancel"] });
    const done = session({ state: "done", wantsCode: false, endedAt: NOW, words: "Claude Code is signed in on Mac mini (Claude Max, person@example.com)." });
    expect(view(done, { stopped: true })).toMatchObject({ phase: "done", tone: "status", busy: false, url: null, next: "Tap Try again in the chat to carry on.", actions: ["done"] });
    expect(view(done)).toMatchObject({ next: "Chats on Claude Code can answer again." });
  });

  test("failed and expired: the hub's words, said at once, with Start again, and never a terminal", () => {
    const failed = view(session({ state: "failed", wantsCode: false, endedAt: NOW, words: "Claude Code couldn't finish signing in: Request failed with status code 400. Start again when you're ready." }));
    expect(failed).toMatchObject({ phase: "ended", tone: "alert", url: null, paste: null, actions: ["close", "again"] });
    const noLink = view(session({ state: "failed", url: null, endedAt: NOW, words: "Gemini CLI didn't show a sign-in link. Tap Start again. If it still shows none, it's waiting for something to be answered at Mac mini first." }));
    expect(noLink).toMatchObject({ phase: "ended", actions: ["close", "again"] });
    expect(noLink.actions).not.toContain("terminal");
    expect(view(session({ state: "expired", endedAt: NOW, words: "Nobody finished the sign-in within 10 minutes, so Crosstalk stopped it. Start again when you're ready." }))).toMatchObject({ phase: "ended", tone: "alert", actions: ["close", "again"] });
    // Stopped by you, or replaced by a newer one on another device: no alarm.
    expect(view(session({ state: "cancelled", endedAt: NOW, words: "A newer sign-in replaced this one." }))).toMatchObject({ phase: "ended", tone: "status", actions: ["close", "again"] });
  });

  test("a sign-in that couldn't start says why, with the way out that answer leaves", () => {
    const problem = (status: number, code: string | undefined, message: string) => view(null, { problem: { status, code, message } });
    expect(problem(409, "terminal", "Antigravity CLI asks how to sign in on a screen of its own first, so it signs in from its terminal: Settings → AI services → Antigravity CLI → Sign in.")).toMatchObject({
      phase: "problem",
      tone: "alert",
      words: "Claude Code signs in on a screen of its own, so it can't sign in from this sheet. Use its terminal sign-in instead: it runs on Mac mini and shows here.",
      actions: ["close", "terminal"],
    });
    expect(problem(409, "not_installed", "Claude Code isn't installed on Mac mini. Install it under Settings → AI services first.")).toMatchObject({ words: "Claude Code isn't installed on Mac mini. Install it under Settings → AI services first.", actions: ["close", "settings"] });
    expect(problem(409, "not_signin", "This account runs on an API key or a model server of your own: there's nothing to sign in to. Change its key in Settings → AI services.")).toMatchObject({ actions: ["close", "settings"] });
    expect(problem(429, "too_many", "Several sign-ins are already running here. Finish or stop one of them first.")).toMatchObject({ actions: ["close", "retry"] });
    expect(problem(404, "account", "There's no Claude Code account like that on Mac mini any more")).toMatchObject({ words: "There's no Claude Code account like that on Mac mini any more.", actions: ["close"] });
    // A hub from before sign-ins from the phone: "not found", no code. Its terminal sign-in still works.
    expect(problem(404, undefined, "not found")).toMatchObject({ words: "Crosstalk on Mac mini can't sign agents in from here until it's updated. Use its terminal sign-in instead.", actions: ["close", "terminal"] });
    // The hub couldn't be reached: try again.
    expect(problem(0, undefined, "Can't reach the hub. Check that it's running and that this device is on your Tailscale network.")).toMatchObject({
      words: "Claude Code's sign-in didn't start: Can't reach the hub. Check that it's running and that this device is on your Tailscale network.",
      actions: ["close", "retry"],
    });
    expect(problem(403, "person_only", "Only your own devices can sign agents in. This sign-in belongs to another machine's hub.")).toMatchObject({ actions: ["close"] });
    // A sign-in that has gone, even with an old copy of it here.
    expect(view(session(), { problem: { status: 404, code: "gone", message: "That sign-in has ended and gone. Start a new one." } })).toMatchObject({ phase: "problem", words: "That sign-in has ended and gone. Start a new one.", actions: ["close", "again"] });
    // Every action has its words.
    for (const a of ["cancel", "close", "done", "again", "retry", "terminal", "settings"] as const) expect(SHEET_ACTIONS[a].length).toBeGreaterThan(0);
  });

  test("a code that couldn't go: the hub's words and what to do, never the code", () => {
    expect(codeProblemWords({ status: 409, code: "not_waiting", message: "This sign-in isn't waiting for a code right now." })).toBe("This sign-in isn't waiting for a code right now. Wait for the box to be ready, then paste it again.");
    expect(codeProblemWords({ status: 400, code: "code", message: "Paste just the code from the sign-in page: one line, nothing else." })).toBe("Paste just the code from the sign-in page: one line, nothing else.");
    expect(codeProblemWords({ status: 0, message: "Can't reach the hub. Check that it's running and that this device is on your Tailscale network." })).toBe(
      "Couldn't send the code: Can't reach the hub. Check that it's running and that this device is on your Tailscale network. Paste it again and tap Sign in.",
    );
  });
});

describe("the hub's note in a reply whose agent picked itself back up", () => {
  test("every wording of it is recognised, for any agent, account and machine", () => {
    for (const agent of ["Claude Code", "Claude Code (Work)", "Codex", "Muse Code"]) {
      for (const outcome of ["starting", "carried", "failed", "ended"] as const) {
        expect(isStaleSignInNote({ kind: "notice", title: staleSignInWords(agent, "Mac mini", outcome) })).toBe(true);
      }
    }
  });

  test("other notes and steps aren't", () => {
    expect(isStaleSignInNote({ kind: "notice", title: "Compacted the conversation (142k → 31k tokens)" })).toBe(false);
    expect(isStaleSignInNote({ kind: "notice", title: "Claude Code started on Opus 5, not Opus 5.5" })).toBe(false);
    // The same words as a command's title (an agent can run anything) aren't Crosstalk's note.
    expect(isStaleSignInNote({ kind: "command", title: staleSignInWords("Claude Code", "Mac mini", "carried") })).toBe(false);
  });
});
