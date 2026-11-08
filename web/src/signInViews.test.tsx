import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { staleSignInWords, type Activity, type Member, type Message, type SignInSession } from "@crosstalk/shared";
import { sheetView } from "./signIn";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { ReplyNote, SignInPrompt, SignInSteps } = await import("./views/SignIn");
const { MessageRow } = await import("./views/RoomView");
const { ItemRow } = await import("./views/AgentSetupSection");

// What the sign-in sheet and its prompts put on screen, step by step: what a screen reader is told, what the link and the
// code box are, and that the code box is never one a browser would save.

/** The words on screen: tags stripped, entities read. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const NOW = Date.UTC(2026, 10, 1, 9, 40, 0);
const URL_CLAUDE = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&state=abc123";
const session = (over: Partial<SignInSession> = {}): SignInSession => ({
  id: "si_1",
  provider: "claude",
  account: "default",
  accountLabel: null,
  machine: { id: "h_mini", name: "Mac mini" },
  method: "paste",
  state: "open",
  url: URL_CLAUDE,
  userCode: null,
  wantsCode: true,
  codesSent: 0,
  codeRefused: false,
  words: "Open the sign-in link and sign in with the Claude account that has your plan. The page then shows a code: copy all of it and paste it here.",
  startedAt: NOW,
  expiresAt: NOW + 600_000,
  endedAt: null,
  ...over,
});
const steps = (s: SignInSession | null, over: { code?: string; canPaste?: boolean; note?: string | null; sending?: boolean; problem?: Parameters<typeof sheetView>[0]["problem"]; agent?: string; stopped?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(SignInSteps, {
      view: sheetView({ session: s, problem: over.problem ?? null, agent: over.agent ?? "Claude Code", machine: "Mac mini", stopped: over.stopped }),
      code: over.code ?? "",
      onCode: () => {},
      onSend: () => {},
      sending: over.sending ?? false,
      canPaste: over.canPaste ?? true,
      onPaste: () => {},
      note: over.note ?? null,
      onOpenLink: () => {},
    }),
  );
const tag = (html: string, re: RegExp) => html.match(re)?.[0] ?? "";

test("Claude Code's sign-in: the page opens in this phone's browser, and the box for its code is never saved", () => {
  const html = steps(session());
  // One live region with the step's words, polite while nothing is wrong.
  expect(tag(html, /<p[^>]*class="signin-words[^"]*"[^>]*>/)).toContain('role="status"');
  expect(tag(html, /<p[^>]*class="signin-words[^"]*"[^>]*>/)).toContain('aria-live="polite"');
  expect(words(html)).toContain("Open the sign-in link and sign in with the Claude account that has your plan.");
  // The link: a big button, opened outside the app, giving the page nothing back.
  const link = tag(html, /<a [^>]*>/);
  expect(link).toContain(`href="${URL_CLAUDE.replace(/&/g, "&amp;")}"`);
  expect(link).toContain('target="_blank"');
  expect(link).toContain('rel="noopener noreferrer"');
  expect(link).toContain("btn primary large block");
  expect(words(html)).toContain("Open the sign-in page");
  expect(words(html)).toContain("Copy link");
  // The box: a one-time code (no name, no autofill to keep it, no corrections), labelled for a reader.
  const input = tag(html, /<input[^>]*>/);
  // (HTML attribute names are read whatever their case.)
  expect(input).toMatch(/ autocomplete="one-time-code"/i);
  expect(input).not.toMatch(/ name=/i);
  expect(input).toMatch(/ autocapitalize="off"/i);
  expect(input).toMatch(/ autocorrect="off"/i);
  expect(input).toMatch(/ spellcheck="false"/i);
  expect(input).not.toContain("disabled");
  expect(words(html)).toContain("Code from the sign-in page");
  // Paste and Sign in, Sign in off until there's a code.
  expect(words(html)).toContain("Paste");
  expect(tag(html, /<button type="submit"[^>]*>/)).toContain("disabled");
  expect(tag(steps(session(), { code: "ac_x#y" }), /<button type="submit"[^>]*>/)).not.toContain("disabled");
  // No clipboard to read here (plain http, some webviews): no Paste button, the box takes a long-press paste.
  expect(steps(session(), { canPaste: false })).not.toContain(">Paste");
  // Nothing to wait for: the person acts.
  expect(html).not.toContain("signin-waiting");
});

test("the box waits until Claude Code asks for the code, and says why", () => {
  const html = steps(session({ wantsCode: false }));
  expect(tag(html, /<input[^>]*>/)).toContain("disabled");
  expect(words(html)).toContain("Waiting for Claude Code to ask for the code…");
});

test("a code it turned down is said at once, and the box says it's that", () => {
  const html = steps(session({ codeRefused: true, codesSent: 1, words: "Claude Code didn't take that code. Copy the whole code from the sign-in page and paste it again." }));
  const live = tag(html, /<p[^>]*class="signin-words[^"]*"[^>]*>/);
  expect(live).toContain('aria-live="assertive"');
  expect(live).toContain("alert");
  const input = tag(html, /<input[^>]*>/);
  expect(input).toContain('aria-invalid="true"');
  // The box is described by the words saying what was wrong.
  const id = /id="([^"]+)"/.exec(live)?.[1];
  expect(id).toBeTruthy();
  expect(input).toContain(`aria-describedby="${id}"`);
});

test("a code that couldn't go, or a clipboard that couldn't be read: said under the box", () => {
  const html = steps(session(), { note: "Crosstalk can't read what you copied here. Touch and hold the box, then tap Paste." });
  expect(tag(html, /<p class="signin-note"[^>]*>/)).toContain('role="alert"');
  expect(words(html)).toContain("Touch and hold the box, then tap Paste.");
});

test("a device code: the link, the code in large type with Copy, and what it waits for; nothing to paste", () => {
  const html = steps(session({ provider: "codex", method: "device", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", wantsCode: false, words: "Open the sign-in link on any device, sign in, and enter this code: ABCD-EFGH." }), { agent: "Codex" });
  expect(tag(html, /<span class="code-big">[^<]*<\/span>/)).toBe('<span class="code-big">ABCD-EFGH</span>');
  expect(words(html)).toContain("Enter this code there:");
  expect(words(html)).toContain("Copy code");
  expect(words(html)).toContain("Waiting for you to approve in the browser…");
  expect(words(html)).toContain("Any device works.");
  expect(html).not.toContain("<input");
  // Muse Code's page shows the code itself.
  const muse = steps(session({ provider: "muse", method: "device", url: "https://auth.meta.com/device", userCode: "WXYZ-1234", wantsCode: false, words: "Open the sign-in link on any device, sign in, and check it shows this code: WXYZ-1234." }), { agent: "Muse Code" });
  expect(words(muse)).toContain("Check the page shows this code:");
});

test("checking, signed in, failed: what's happening, and nothing left to tap that would do nothing", () => {
  const checking = steps(session({ state: "checking", wantsCode: false, codesSent: 1, words: "Checking the code with Claude Code…" }));
  expect(words(checking)).toBe("Checking the code with Claude Code…");
  expect(checking).toContain("spin");
  const done = steps(session({ state: "done", wantsCode: false, endedAt: NOW, words: "Claude Code is signed in on Mac mini (Claude Max, person@example.com)." }), { stopped: true });
  expect(words(done)).toBe("Claude Code is signed in on Mac mini (Claude Max, person@example.com). Tap Try again in the chat to carry on.");
  expect(done).not.toContain("<a ");
  const failed = steps(session({ state: "failed", wantsCode: false, endedAt: NOW, words: "Claude Code couldn't finish signing in: Request failed with status code 400. Start again when you're ready." }));
  expect(tag(failed, /<p[^>]*class="signin-words[^"]*"[^>]*>/)).toContain('aria-live="assertive"');
  expect(failed).not.toContain("<input");
  // A failure says what to do from here: never a terminal.
  const noLink = steps(session({ state: "failed", url: null, endedAt: NOW, words: "Gemini CLI didn't show a sign-in link. Tap Start again. If it still shows none, it's waiting for something to be answered at Mac mini first." }), { agent: "Gemini CLI" });
  expect(words(noLink)).toBe("Gemini CLI didn't show a sign-in link. Tap Start again. If it still shows none, it's waiting for something to be answered at Mac mini first.");
  expect(noLink).not.toContain("terminal");
});

test("the prompt: what to do in its title, why under it, and one button named for it", () => {
  const html = renderToStaticMarkup(createElement(SignInPrompt, { who: { provider: "claude", account: "default" }, machine: "Mac mini", line: "Claude Code is signed out on Mac mini, so it couldn't answer. Sign it in again from this iPhone, then tap Try again.", variant: "card", stopped: true }));
  const group = tag(html, /<div class="signin-prompt card"[^>]*>/);
  expect(group).toContain('role="group"');
  const labelled = /aria-labelledby="([^"]+)"/.exec(group)?.[1];
  expect(html).toContain(`id="${labelled}">Sign in to Claude Code on Mac mini</div>`);
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(tag(html, /<button[^>]*>/)).toContain('aria-label="Sign in to Claude Code on Mac mini"');
  expect(words(html)).toBe("Sign in to Claude Code on Mac mini Claude Code is signed out on Mac mini, so it couldn't answer. Sign it in again from this iPhone, then tap Try again. Sign in");
});

const note = (over: Partial<Activity> = {}): Activity => ({ id: "a1", roomId: "r1", turnId: "t1", memberId: "mb1", kind: "notice", title: staleSignInWords("Claude Code", "Mac mini", "carried"), detail: "", status: "done", createdAt: NOW, updatedAt: NOW, ...over });

test("the hub's note in a reply whose agent picked itself back up: a note, with what ended with the old process", () => {
  const html = renderToStaticMarkup(createElement(ReplyNote, { activity: note({ detail: 'It was running the helper "Check the build" in the background.' }), live: false }));
  expect(tag(html, /<div class="reply-note"[^>]*>/)).toContain('role="note"');
  expect(words(html)).toBe(`Claude Code's sign-in had gone stale in this chat: Crosstalk started it again and it carried on. It was running the helper "Check the build" in the background.`);
  expect(renderToStaticMarkup(createElement(ReplyNote, { activity: note({ status: "error", title: staleSignInWords("Claude Code", "Mac mini", "failed") }), live: false }))).toContain("reply-note failed");
});

test("in the chat, that note stands with the reply instead of folding away with its steps", () => {
  const member = { id: "mb1", roomId: "r1", handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 } as Member;
  const reply: Message = { id: "m2", roomId: "r1", authorKind: "agent", memberId: "mb1", authorName: "claude", text: "Done.", mentions: [], turnId: "t1", status: "done", createdAt: NOW, updatedAt: NOW };
  const command: Activity = { ...note({ id: "a2", kind: "command", title: "npm test", status: "done" }) };
  const draw = (activities: Activity[]) => renderToStaticMarkup(createElement(MessageRow, { message: reply, member, handles: ["claude"], activities, statusKnown: true }));
  // Alone: the note, and no list of steps at all.
  const alone = draw([note()]);
  expect(words(alone)).toContain("Claude Code's sign-in had gone stale in this chat: Crosstalk started it again and it carried on.");
  expect(alone).not.toContain("<details");
  // With other steps: those fold as before, without it.
  const both = draw([note(), command]);
  const details = both.slice(both.indexOf("<details"));
  expect(details).toContain("npm test");
  expect(details).not.toContain("gone stale");
  expect(both.indexOf("gone stale")).toBeLessThan(both.indexOf("<details"));
});

test("a failed reply that a signed-out account explains: the way to sign in stands in place of the error", () => {
  const WORDS = "Claude Code is signed out on Mac mini, so it couldn't answer. Sign in to it again (Settings → Agents → Claude Code → Sign in), then tap Try again.";
  const member = { id: "mb1", roomId: "r1", handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "error", statusDetail: WORDS, config: {}, createdAt: 0, position: 0 } as Member;
  const need = { provider: "claude" as const, account: "default", accountLabel: null, machine: { id: "h_mini", name: "Mac mini" }, since: NOW, rooms: ["r1"], words: WORDS };
  const turn = { id: "t1", roomId: "r1", memberId: "mb1", triggerMessageId: "m1", replyMessageId: "m2", hop: 0, chainId: "c1", status: "error" as const, error: WORDS, usage: null, createdAt: NOW, startedAt: NOW, endedAt: NOW };
  const reply: Message = { id: "m2", roomId: "r1", authorKind: "agent", memberId: "mb1", authorName: "claude", text: `⚠️ ${WORDS}`, mentions: [], turnId: "t1", status: "error", createdAt: NOW, updatedAt: NOW };
  const draw = (over: Record<string, unknown>) => renderToStaticMarkup(createElement(MessageRow, { message: reply, member, handles: ["claude"], turn, statusKnown: true, ...over }));
  // Signed out: the card, with its button, and not the words that only point to Settings.
  const html = draw({ signIn: need, announce: true });
  expect(words(html)).not.toContain("Settings → Agents → Claude Code → Sign in");
  expect(words(html)).toContain("Sign in to Claude Code on Mac mini Claude Code is signed out on Mac mini, so it couldn't answer. Sign it in again from this device, then tap Try again. Sign in");
  expect(html.match(/<button[^>]*aria-label="Sign in to Claude Code on Mac mini"/g)).toHaveLength(1);
  // A failure that happened while the chat was open is still said at once.
  expect(tag(html, /<div class="signin-prompt-text"[^>]*>/)).toContain('role="alert"');
  expect(tag(draw({ signIn: need, announce: false }), /<div class="signin-prompt-text"[^>]*>/)).not.toContain("role=");
  // Signed in again since: the reply's error, as it was.
  expect(words(draw({}))).toContain("Sign in to it again (Settings → Agents → Claude Code → Sign in), then tap Try again.");
  // What the agent wrote before it failed stays, with the card after it.
  const partial = renderToStaticMarkup(createElement(MessageRow, { message: { ...reply, text: "Looking at the files." }, member, handles: ["claude"], turn, statusKnown: true, signIn: need }));
  expect(words(partial)).toContain("Looking at the files.");
  expect(partial.indexOf("Looking at the files.")).toBeLessThan(partial.indexOf("Sign in to Claude Code on Mac mini"));
  expect(words(partial)).not.toContain("Settings → Agents → Claude Code → Sign in");
});

test("the setup checklist: an agent waiting on its sign-in offers it right there, on a hub that can do it from here", () => {
  const item = { id: "agent.claude", group: "agents" as const, title: "Claude Code", state: "user" as const, optional: false, detail: "Claude Code 2.1.316 is installed but not signed in.", fix: { text: "Sign in with the Claude account that has your plan: from the phone, or at the machine with the command.", command: "claude auth login", password: true } };
  const list = { hub: { name: "Mac mini" } } as never;
  const shut = renderToStaticMarkup(createElement(ItemRow, { item, list, open: false, onToggle: () => {}, signIn: true }));
  expect(words(shut)).toBe("Needs you Claude Code Sign in to Claude Code on Mac mini From here: no need to be at Mac mini. Sign in");
  expect(shut.match(/<button/g)).toHaveLength(2); // the row itself, and Sign in
  // An older hub (no sign-ins from the phone), a done item, Antigravity CLI (its own screen): just the row.
  expect(renderToStaticMarkup(createElement(ItemRow, { item, list, open: false, onToggle: () => {}, signIn: false }))).not.toContain("signin-prompt");
  expect(renderToStaticMarkup(createElement(ItemRow, { item: { ...item, state: "done" as const, fix: null }, list, open: false, onToggle: () => {}, signIn: true }))).not.toContain("signin-prompt");
  expect(renderToStaticMarkup(createElement(ItemRow, { item: { ...item, id: "agent.antigravity", title: "Antigravity CLI" }, list, open: false, onToggle: () => {}, signIn: true }))).not.toContain("signin-prompt");
  // Opened, the way at the machine is still there under it.
  const open = renderToStaticMarkup(createElement(ItemRow, { item, list, open: true, onToggle: () => {}, signIn: true }));
  expect(words(open)).toContain("claude auth login");
  expect(open.indexOf("signin-prompt")).toBeLessThan(open.indexOf("claude auth login"));
});
