// Signing an agent in from the phone (signin.ts): the agent's own sign-in, run on the hub's machine in a terminal no
// device sees, its link and code handed to the phone, the code the person pastes handed to the agent and to nothing else.
// Nothing here runs a real agent CLI or signs in to anything: Claude Code and Codex are the fakes in fixtures/, whose
// sign-in is a file of the test's own.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, SignInSession } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { ClaudeDriver } from "../src/agents/claude";
import { App } from "../src/app";
import { registerProvider } from "../src/providers";
import { claudeProvider } from "../src/providers/claude";
import { codexProvider } from "../src/providers/codex";
import { readClaudeScreen, readGeminiScreen, readMuseScreen, signInLink } from "../src/signin";
import { startServer } from "../src/server";
import { setupKeyFor } from "../src/setup";
import { endStarted } from "./standins";

setDefaultTimeout(30_000);
const FIX = join(import.meta.dir, "fixtures");
/** The code the fake's sign-in page "shows". */
const PAGE_CODE = "ac_Zx81kq3Lmw9TbP2vYh7";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

async function until(cond: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "FAKE_CLAUDE_AUTH_FILE", "FAKE_CLAUDE_LOGIN_STATE_OUT", "FAKE_CLAUDE_LOGIN_ENV_OUT", "FAKE_CLAUDE_LOGIN_ECHO", "FAKE_CLAUDE_LOGIN_CODE", "FAKE_CLAUDE_LOGIN_SAY_CODE", "FAKE_CODEX_AUTH_FILE", "FAKE_COMPLETE_MS", "FAKE_LOGIN_FAIL", "FAKE_MUSE_APPROVE_MS", "FAKE_MUSE_KEYS_OUT", "FAKE_MUSE_DENY", "FAKE_GEMINI_CODE"];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const cleanups: (() => Promise<void> | void)[] = [];
const sessionsInUse = ClaudeDriver.sessionsInUse;

beforeEach(() => {
  registerProvider(claudeProvider);
  registerProvider(codexProvider);
  registerDriver("claude", (ctx) => new ClaudeDriver(ctx, ctx.bin));
  ClaudeDriver.sessionsInUse = () => new Set();
});

afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  ClaudeDriver.sessionsInUse = sessionsInUse;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await endStarted();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Everything the hub prints while `fn` runs: its log. */
function captureLog(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const keep = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.log = console.error = console.warn = console.info = console.debug = keep;
  return { lines, stop: () => Object.assign(console, saved) };
}

/** Every row of every table of the hub's database, as text. */
function databaseText(app: App): string {
  const tables = app.store.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.map((t) => `${t.name}: ${JSON.stringify(app.store.db.query(`SELECT * FROM "${t.name}"`).all())}`).join("\n");
}

function hub() {
  const dir = temp("ct-signin-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  process.env.CODEX_HOME = join(dir, "codex-home");
  process.env.FAKE_CLAUDE_AUTH_FILE = join(dir, "claude-auth");
  process.env.FAKE_CLAUDE_LOGIN_STATE_OUT = join(dir, "login-state");
  process.env.FAKE_CLAUDE_LOGIN_ENV_OUT = join(dir, "login-env");
  process.env.FAKE_CLAUDE_LOGIN_CODE = PAGE_CODE;
  // What's typed comes back on its screen, as a terminal that echoes shows it: Crosstalk must never pass it on.
  process.env.FAKE_CLAUDE_LOGIN_ECHO = "1";
  process.env.FAKE_CODEX_AUTH_FILE = join(dir, "codex-auth");
  writeFileSync(process.env.FAKE_CLAUDE_AUTH_FILE, "out");
  writeFileSync(process.env.FAKE_CODEX_AUTH_FILE, "out");
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.providers.which = (p) => (p === "claude" ? join(FIX, "fake-claude") : p === "codex" ? join(FIX, "fake-codex-login") : null);
  app.setHubSettings({ machineName: "Mac mini" });
  const server = startServer(app);
  const events: ServerEvent[] = [];
  app.bus.on((e) => events.push(e));
  const responses: unknown[] = [];
  cleanups.push(async () => {
    server.stop(true);
    await app.shutdown();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const pair = async (opts?: { scope?: "full" | "peer"; hubId?: string | null }, platform = "Web") => (await app.auth.pair((await app.auth.createPairingCode(60_000, opts)).code, "Phone", platform))!;
  const call = async (token: string | null, method: string, path: string, body?: unknown, raw?: string) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await r.text();
    responses.push(text);
    let parsed: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed };
  };
  const session = (id: string): SignInSession | null => events.filter((e): e is Extract<ServerEvent, { t: "signin.session" }> => e.t === "signin.session" && e.session.id === id).at(-1)?.session ?? null;
  return { dir, app, server, base, events, responses, pair, call, session };
}

describe("reading the agents' sign-in screens", () => {
  test("Claude Code: the OSC 8 link or the plain one, the paste prompt, a refused code, the ending", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc123";
    const screen = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${url}\x07\x1b[34m${url}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `;
    expect(readClaudeScreen(screen, null)).toEqual({ url, wantsCode: true });
    expect(signInLink(`If the browser didn't open, visit: ${url}\n`, /visit:/)).toBe(url);
    // A terminal it couldn't listen for the browser from words it differently.
    expect(readClaudeScreen(`The browser can't return the sign-in to Claude Code automatically.\nSign in at: ${url}\nPaste code here > `, null)).toEqual({ url, wantsCode: true });
    expect(readClaudeScreen(screen, "[code]\r\nInvalid code. Please make sure the full code was copied.\n")).toEqual({ url, wantsCode: true, refused: true });
    expect(readClaudeScreen(screen, "[code]\r\n")).toEqual({ url, wantsCode: false });
    // Its refusal seen as it came, before what was pasted was taken out of it (which can garble the words).
    expect(readClaudeScreen(screen, "[code] make sure the full code was copied.\n", true)).toEqual({ url, wantsCode: true, refused: true });
    expect(readClaudeScreen(`${screen}[code]\r\nLogin successful.\n`, "[code]\r\nLogin successful.\n")).toEqual({ url, succeeded: true });
    expect(readClaudeScreen(`${screen}Login failed: Request failed with status code 400\n`, "")).toEqual({ url, failed: "Request failed with status code 400" });
    // Only https links are handed to a phone.
    expect(signInLink("visit: http://evil.example/x", /visit:/)).toBeNull();
  });

  test("Gemini CLI and Muse Code", () => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&state=s1";
    const g = `\x1b[2J\x1b[HPlease visit the following URL to authorize the application:\n\n${url}\n\nEnter the authorization code: `;
    expect(readGeminiScreen(g, null)).toEqual({ url, wantsCode: true });
    // A code it can't use: once, it makes a new link (a new verifier and state) and asks again. Its screen holds both
    // links by then; the new one is the one to open.
    const retry = "[code]\nFailed to authenticate with authorization code:invalid_grant\n\nFailed to authenticate with user code. Retrying...\nPlease visit the following URL to authorize the application:\n\nhttps://accounts.google.com/x?state=s2\n\nEnter the authorization code: ";
    expect(readGeminiScreen(g + retry, retry)).toEqual({ url: "https://accounts.google.com/x?state=s2", wantsCode: true, refused: true });
    // The second time it gives up.
    const again = "[code]\nFailed to authenticate with authorization code:invalid_grant\n\nFailed to authenticate with user code.Failed to authenticate with user code.\n";
    expect(readGeminiScreen(g + retry + again, again)).toMatchObject({ failed: "Google didn't accept the code" });
    expect(readGeminiScreen(`${g}x\nAuthorization timed out after 5 minutes.`, "x\nAuthorization timed out after 5 minutes.")).toMatchObject({ expired: true });
    const m = "Open this page to sign in:\n  https://auth.meta.com/device?u=1\nand enter this code: WXYZ-1234\nPress Enter to open it in your browser: Waiting for approval…";
    expect(readMuseScreen(m)).toEqual({ url: "https://auth.meta.com/device?u=1", userCode: "WXYZ-1234" });
    expect(readMuseScreen(m.replace("and enter this code", "confirm this code matches"))).toEqual({ url: "https://auth.meta.com/device?u=1", userCode: "WXYZ-1234", confirmCode: true });
    expect(readMuseScreen(`${m}\nThe login request was denied.`)).toMatchObject({ failed: expect.stringContaining("turned down") });
    expect(readMuseScreen(`${m}\nThe login request expired before it was approved.`)).toMatchObject({ expired: true });
  });
});

describe("signing Claude Code in from the phone", () => {
  test("the link and the paste box, a code cut short asked for again, the whole code signs it in, and nothing of it is kept anywhere", async () => {
    const h = hub();
    const log = captureLog();
    cleanups.push(() => log.stop());
    const phone = await h.pair();
    // A chat stopped on it earlier: the account is known to be signed out.
    const chat = h.app.chats.create({ provider: "claude", name: "Release prep", cwd: join(h.dir, "project") } as never);
    const member = h.app.store.listMembers(chat.id)[0];
    h.app.signIns.needed(chat, member);
    h.app.store.updateMember(member.id, { status: "error" });
    expect((await h.call(phone.token, "GET", "/api/signin")).body.needs).toEqual([expect.objectContaining({ provider: "claude", account: "default", rooms: [chat.id] })]);

    const started = await h.call(phone.token, "POST", "/api/signin", { provider: "claude" });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ provider: "claude", account: "default", method: "paste", machine: { id: h.app.hubId(), name: "Mac mini" }, codesSent: 0 });
    const id = started.body.id as string;
    await until(() => !!h.session(id)?.wantsCode, "the paste box");
    const open = (await h.call(phone.token, "GET", `/api/signin/${id}`)).body as SignInSession;
    const state = readFileSync(process.env.FAKE_CLAUDE_LOGIN_STATE_OUT!, "utf8").trim();
    expect(open).toMatchObject({ state: "open", wantsCode: true, userCode: null, codeRefused: false });
    expect(open.url).toStartWith("https://claude.com/cai/oauth/authorize?");
    expect(new URL(open.url!).searchParams.get("state")).toBe(state);
    expect(open.words).toBe("Open the sign-in link and sign in with the Claude account that has your plan. The page then shows a code: copy all of it and paste it here.");
    // It ran in a terminal of its own, and could open no browser on the Mac (that's what the person couldn't reach).
    expect(JSON.parse(readFileSync(process.env.FAKE_CLAUDE_LOGIN_ENV_OUT!, "utf8"))).toEqual({ BROWSER: "/bin/false", stdinTTY: true });
    // It's in the snapshot for a phone that connects now.
    expect(h.app.snapshot(phone.device).signInSessions?.map((s) => s.id)).toEqual([id]);

    // Half the code: Claude Code asks for it again, and the phone says so.
    const half = await h.call(phone.token, "POST", `/api/signin/${id}/code`, { code: PAGE_CODE });
    expect(half.body).toMatchObject({ state: "checking", codesSent: 1, wantsCode: false });
    await until(() => !!h.session(id)?.codeRefused, "the code refused");
    expect(h.session(id)).toMatchObject({ state: "open", wantsCode: true, codeRefused: true, words: "Claude Code didn't take that code. Copy the whole code from the sign-in page and paste it again." });

    // The whole code, as the page shows it: signed in, checked with Claude Code's own status.
    const whole = `${PAGE_CODE}#${state}`;
    // One line, nothing else: a code broken over two lines is refused before it reaches Claude Code.
    expect((await h.call(phone.token, "POST", `/api/signin/${id}/code`, { code: `${whole.slice(0, 9)}\n${whole.slice(9)}` })).status).toBe(400);
    // Spaces and a line break around it (as a copy often brings) are fine.
    expect((await h.call(phone.token, "POST", `/api/signin/${id}/code`, { code: `  ${whole}\n` })).body).toMatchObject({ state: "checking", codesSent: 2, codeRefused: false });
    await until(() => h.session(id)?.state === "done", "the sign-in to finish");
    const done = h.session(id)!;
    expect(done.words).toStartWith("Claude Code is signed in on Mac mini (");
    expect(done.words).toContain("person@example.com");
    expect(done.endedAt).toBeNumber();
    expect(readFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "utf8")).toBe("in");
    expect(h.app.providers.list().find((s) => s.provider === "claude")!.signedIn).toBe(true);
    // The account isn't signed out any more: every device hears it, and the chat that stopped on it says so.
    expect(h.app.signIns.needs()).toEqual([]);
    expect(h.events.filter((e) => e.t === "signin.needs").at(-1)).toEqual({ t: "signin.needs", needs: [] });
    expect(h.app.store.listMessages(chat.id, { limit: 10 }).some((m) => m.text === "Claude Code is signed in again on Mac mini. Tap Try again to carry on.")).toBe(true);
    // A code for a sign-in that has ended goes nowhere.
    expect((await h.call(phone.token, "POST", `/api/signin/${id}/code`, { code: whole })).status).toBe(409);

    // Nothing pasted is anywhere: not the log, not the database, not any device's events, not any answer. The fake's
    // terminal echoed both lines back; that never left the hub. Nor is the sign-in link in the log.
    log.stop();
    const everywhere = { log: log.lines.join("\n"), database: databaseText(h.app), events: JSON.stringify(h.events), answers: JSON.stringify(h.responses) };
    for (const [where, text] of Object.entries(everywhere)) {
      for (const secret of [whole, PAGE_CODE]) expect({ where, has: text.includes(secret) }).toEqual({ where, has: false });
    }
    expect(everywhere.log).not.toContain(state);
    expect(everywhere.log).toContain("a sign-in for Claude Code on Mac mini ended: done");
  });

  test("a sign-in that fails repeating what was pasted: the failure is said, the code isn't", async () => {
    process.env.FAKE_CLAUDE_LOGIN_SAY_CODE = "1";
    const h = hub();
    const log = captureLog();
    cleanups.push(() => log.stop());
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "claude" });
    await until(() => !!h.session(body.id)?.wantsCode, "the paste box");
    const wrong = `${PAGE_CODE}x#${readFileSync(process.env.FAKE_CLAUDE_LOGIN_STATE_OUT!, "utf8").trim()}`;
    await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code: wrong });
    await until(() => h.session(body.id)?.state === "failed", "the sign-in to fail");
    expect(h.session(body.id)!.words).toBe("Claude Code couldn't finish signing in: couldn't exchange [code]. Start again when you're ready.");
    log.stop();
    for (const text of [log.lines.join("\n"), databaseText(h.app), JSON.stringify(h.events), JSON.stringify(h.responses)]) expect(text.includes(`${PAGE_CODE}x`)).toBe(false);
    expect(readFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "utf8")).toBe("out");
  });

  test("a paste too short to be the code never reaches Claude Code, and one that hides in its words is still seen refused", async () => {
    const h = hub();
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "claude" });
    await until(() => !!h.session(body.id)?.wantsCode, "the paste box");
    // A stray letter, a slip of the keyboard: refused here, and the box stays open for the real code.
    for (const code of ["a", "e", "zz", "ac_Zx81kq3L#abc"]) {
      const r = await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code });
      expect({ code, status: r.status, why: r.body.code, words: r.body.error }).toEqual({ code, status: 400, why: "code", words: "That's too short to be the code from the sign-in page. Copy all of it there, then paste it here." });
    }
    expect((await h.call(phone.token, "GET", `/api/signin/${body.id}`)).body).toMatchObject({ state: "open", wantsCode: true, codesSent: 0, codeRefused: false });
    // A paste that is itself part of Claude Code's refusal: taking it out of the screen garbles "Invalid code…", but the
    // refusal was seen as it came. The box opens again instead of waiting until the sign-in expires.
    const odd = await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code: "Invalid code. Please make sure" });
    expect(odd.body).toMatchObject({ state: "checking", codesSent: 1 });
    await until(() => !!h.session(body.id)?.codeRefused, "the refusal");
    expect(h.session(body.id)).toMatchObject({ state: "open", wantsCode: true, codeRefused: true });
    // And the whole code still signs it in.
    const state = readFileSync(process.env.FAKE_CLAUDE_LOGIN_STATE_OUT!, "utf8").trim();
    await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code: `${PAGE_CODE}#${state}` });
    await until(() => h.session(body.id)?.state === "done", "the sign-in");
  });

  test("a sign-in nobody finishes ends by itself, and its terminal with it", async () => {
    const h = hub();
    h.app.signIns.ttlMs.claude = 700;
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "claude" });
    await until(() => h.session(body.id)?.state === "expired", "the sign-in to run out", 8_000);
    expect(h.session(body.id)).toMatchObject({ state: "expired", wantsCode: false, words: "Nobody finished the sign-in within 1 minute, so Crosstalk stopped it. Start again when you're ready." });
    expect((await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code: `${PAGE_CODE}#x` })).status).toBe(409);
    expect(readFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "utf8")).toBe("out");
    // Its process is gone (the standins guard fails this test if anything it started is still running).
    await Bun.sleep(300);
  });

  test("starting again replaces the open one; stopping one ends it", async () => {
    const h = hub();
    const phone = await h.pair();
    const first = (await h.call(phone.token, "POST", "/api/signin", { provider: "claude" })).body;
    await until(() => !!h.session(first.id)?.url, "the first link");
    const second = (await h.call(phone.token, "POST", "/api/signin", { provider: "claude" })).body;
    expect(h.session(first.id)).toMatchObject({ state: "cancelled", words: "A newer sign-in replaced this one." });
    await until(() => !!h.session(second.id)?.url, "the second link");
    const stopped = await h.call(phone.token, "DELETE", `/api/signin/${second.id}`);
    expect(stopped.body).toMatchObject({ state: "cancelled", words: "Sign-in stopped." });
    expect((await h.call(phone.token, "GET", "/api/signin/si_nothing")).status).toBe(404);
  });
});

describe("signing Gemini CLI in from the phone", () => {
  test("a code it turns down: it made a new link, so the words send you to that one, and its new code signs it in", async () => {
    const h = hub();
    process.env.FAKE_GEMINI_CODE = "4/0AVG7fiQ-fake-google-code-1234567890";
    h.app.providers.which = (p) => (p === "gemini" ? join(FIX, "fake-gemini-login") : null);
    // An account of its own, so its sign-in lives in the test's folders (Gemini CLI's own is the person's home).
    const work = h.app.providers.addAccount("gemini", "Work");
    const refresh = h.app.providers.refreshAccount.bind(h.app.providers);
    h.app.providers.refreshAccount = async (p, id) => (p === "gemini" ? { provider: "gemini", id, label: "Work", kind: "signin", workspaceId: null, endpoint: null, signedIn: true, account: "person@example.com", plan: null, authMethod: "Google sign-in", error: null, checkedAt: Date.now() } : refresh(p, id));
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "gemini", account: work.id });
    await until(() => !!h.session(body.id)?.wantsCode, "the paste box");
    const first = h.session(body.id)!.url!;
    expect(new URL(first).searchParams.get("state")).toBe("state1");
    expect(h.session(body.id)!.words).toBe("Open the sign-in link and sign in with your Google account. The page then shows a code: copy all of it and paste it here.");
    await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code: "4/0AVG7fiQ-an-old-or-wrong-code-000" });
    await until(() => !!h.session(body.id)?.codeRefused, "the refusal");
    const relinked = h.session(body.id)!;
    expect(relinked).toMatchObject({ state: "open", wantsCode: true, codeRefused: true });
    // Its new link, with words that say the old page's code can't work any more.
    expect(new URL(relinked.url!).searchParams.get("state")).toBe("state2");
    expect(relinked.words).toBe("That code didn't work, and Gemini CLI (Work) made a new sign-in link. Open the sign-in page again, sign in, and paste the new code it shows.");
    await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code: process.env.FAKE_GEMINI_CODE });
    await until(() => h.session(body.id)?.state === "done", "the sign-in");
    expect(h.session(body.id)!.words).toBe("Gemini CLI (Work) is signed in on Mac mini (person@example.com).");
  });
});

describe("signing Codex in from the phone", () => {
  test("its device code: the link and the code to enter, and done once Codex says so", async () => {
    process.env.FAKE_COMPLETE_MS = "500";
    const h = hub();
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "codex" });
    expect(body).toMatchObject({ provider: "codex", method: "device", state: "open", url: "https://example.com/device", userCode: "ABCD-EFGH", wantsCode: false });
    expect(body.words).toBe("Open the sign-in link on any device, sign in, and enter this code: ABCD-EFGH.");
    // Nothing is pasted back for a device code.
    expect((await h.call(phone.token, "POST", `/api/signin/${body.id}/code`, { code: "ABCD-EFGH" })).status).toBe(409);
    await until(() => h.session(body.id)?.state === "done", "Codex to finish");
    expect(h.session(body.id)!.words).toStartWith("Codex is signed in on Mac mini");
    expect(h.app.providers.accounts().find((a) => a.provider === "codex" && a.id === "default")!.signedIn).toBe(true);
  });

  test("a device code turned down ends as failed, in Codex's words", async () => {
    process.env.FAKE_COMPLETE_MS = "300";
    process.env.FAKE_LOGIN_FAIL = "1";
    const h = hub();
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "codex" });
    await until(() => h.session(body.id)?.state === "failed", "Codex to fail");
    expect(h.session(body.id)!.words).toBe("Codex couldn't finish signing in: The device code was declined. Start again when you're ready.");
  });
});

describe("signing Muse Code in from the phone", () => {
  /** Muse's own sign-in check speaks its session protocol (muse-auth.test.ts tests that): here it answers as the stand-in left things. */
  function museChecked(h: ReturnType<typeof hub>, signedIn: () => boolean) {
    h.app.providers.which = (p) => (p === "muse" ? join(FIX, "fake-muse-login") : null);
    const refresh = h.app.providers.refreshAccount.bind(h.app.providers);
    h.app.providers.refreshAccount = async (p, id) => (p === "muse" ? { provider: "muse", id: "default", label: "Main", kind: "signin", workspaceId: null, endpoint: null, signedIn: signedIn(), account: "person@example.com", plan: "Muse Pro", authMethod: "Meta sign-in", error: null, checkedAt: Date.now() } : refresh(p, id));
  }

  test("`muse login`'s device code: the link and the code, Enter never pressed, done once it's approved", async () => {
    const h = hub();
    process.env.FAKE_MUSE_APPROVE_MS = "800";
    process.env.FAKE_MUSE_KEYS_OUT = join(h.dir, "muse-keys");
    let approved = false;
    museChecked(h, () => approved);
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "muse" });
    expect(body).toMatchObject({ provider: "muse", method: "device" });
    await until(() => !!h.session(body.id)?.userCode, "the code");
    expect(h.session(body.id)).toMatchObject({ state: "open", url: "https://auth.meta.com/device?user_code=WXYZ-1234", userCode: "WXYZ-1234", wantsCode: false, words: "Open the sign-in link on any device, sign in, and enter this code: WXYZ-1234." });
    approved = true;
    await until(() => h.session(body.id)?.state === "done", "the approval");
    expect(h.session(body.id)!.words).toBe("Muse Code is signed in on Mac mini (Muse Pro, person@example.com).");
    // Nothing was typed into it: Enter would have opened the Mac's browser.
    expect(existsSync(process.env.FAKE_MUSE_KEYS_OUT)).toBe(false);
  });

  test("a code turned down on the page ends it as failed", async () => {
    const h = hub();
    process.env.FAKE_MUSE_APPROVE_MS = "300";
    process.env.FAKE_MUSE_DENY = "1";
    museChecked(h, () => false);
    const phone = await h.pair();
    const { body } = await h.call(phone.token, "POST", "/api/signin", { provider: "muse" });
    await until(() => h.session(body.id)?.state === "failed", "the refusal");
    expect(h.session(body.id)!.words).toBe("Muse Code couldn't finish signing in: the sign-in was turned down on the page. Start again when you're ready.");
  });
});

describe("the older terminal sign-in in Settings", () => {
  test("Claude Code's terminal doesn't echo what's pasted: no device and no scrollback ever has it", async () => {
    const h = hub();
    // Only the terminal's own echo could put it on the screen: the fake doesn't repeat it itself here.
    delete process.env.FAKE_CLAUDE_LOGIN_ECHO;
    const phone = await h.pair();
    const flow = (await h.call(phone.token, "POST", "/api/accounts/claude/default/login", {})).body;
    expect(flow).toMatchObject({ kind: "terminal", provider: "claude" });
    await until(() => h.app.pty.scrollback(flow.ptyId).includes("Paste code here"), "the paste prompt");
    expect(h.app.pty.get(flow.ptyId)!.command).toEndWith("auth login --claudeai");
    const state = readFileSync(process.env.FAKE_CLAUDE_LOGIN_STATE_OUT!, "utf8").trim();
    const whole = `${PAGE_CODE}#${state}`;
    // As the dialog's paste field sends it.
    h.app.pty.write(flow.ptyId, `${whole}\r`);
    await until(() => readFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "utf8") === "in", "the sign-in");
    await Bun.sleep(100);
    const shown = h.events.filter((e): e is Extract<ServerEvent, { t: "pty.data" }> => e.t === "pty.data").map((e) => e.data).join("");
    expect(shown).toContain("Login successful.");
    for (const text of [shown, h.app.pty.scrollback(flow.ptyId)]) expect(text.includes(PAGE_CODE)).toBe(false);
  });

  test("one sign-in per agent and account, whichever way it started: the newer one ends the other", async () => {
    const h = hub();
    const phone = await h.pair();
    // The sheet's sign-in, then the terminal one in Settings for the same account: the sheet's ends, and says why.
    const sheet = (await h.call(phone.token, "POST", "/api/signin", { provider: "claude" })).body;
    await until(() => !!h.session(sheet.id)?.wantsCode, "the paste box");
    const flow = (await h.call(phone.token, "POST", "/api/accounts/claude/default/login", {})).body;
    expect(h.session(sheet.id)).toMatchObject({ state: "cancelled", words: "Another sign-in for this account started, so this one stopped." });
    await until(() => h.app.pty.scrollback(flow.ptyId).includes("Paste code here"), "the terminal's prompt");
    // And the other way: the sheet's sign-in ends the terminal one, so two never write the same sign-in.
    const again = (await h.call(phone.token, "POST", "/api/signin", { provider: "claude" })).body;
    expect(h.app.pty.get(flow.ptyId)).toBeNull();
    await until(() => !!h.session(again.id)?.wantsCode, "the new paste box");
    // A second terminal one replaces the first, too.
    await h.call(phone.token, "DELETE", `/api/signin/${again.id}`);
    const one = (await h.call(phone.token, "POST", "/api/accounts/claude/default/login", {})).body;
    const two = (await h.call(phone.token, "POST", "/api/accounts/claude/default/login", {})).body;
    expect(h.app.pty.get(one.ptyId)).toBeNull();
    expect(h.app.pty.get(two.ptyId)?.alive).toBe(true);
    // Another account's sign-in is its own.
    const work = h.app.providers.addAccount("claude", "Work");
    const theirs = (await h.call(phone.token, "POST", "/api/signin", { provider: "claude", account: work.id })).body;
    expect(h.app.pty.get(two.ptyId)?.alive).toBe(true);
    await h.call(phone.token, "DELETE", `/api/signin/${theirs.id}`);
    h.app.pty.kill(two.ptyId);
    await Bun.sleep(300);
  });

  test("Codex's device code from Settings ends when the sheet's sign-in for that account starts, and its dialog hears it", async () => {
    const h = hub();
    const phone = await h.pair();
    const older = (await h.call(phone.token, "POST", "/api/accounts/codex/default/login", {})).body;
    expect(older).toMatchObject({ kind: "device_code", provider: "codex" });
    const sheet = (await h.call(phone.token, "POST", "/api/signin", { provider: "codex" })).body;
    expect(sheet).toMatchObject({ provider: "codex", state: "open" });
    const ended = h.events.filter((e): e is Extract<ServerEvent, { t: "login" }> => e.t === "login" && e.provider === "codex");
    expect(ended).toEqual([{ t: "login", provider: "codex", accountId: "default", loginId: older.loginId, flow: null, done: true, error: "Another sign-in for this account started, so this one stopped." }]);
    await h.call(phone.token, "DELETE", `/api/signin/${sheet.id}`);
  });
});

describe("who may sign agents in", () => {
  test("only the person's own devices: never another machine's hub, a peer sign-in or the setup key", async () => {
    const h = hub();
    const phone = await h.pair();
    const peer = await h.pair({ scope: "peer", hubId: "h_stranger0001" }, "Crosstalk hub");
    const hubSignIn = await h.pair({ scope: "full", hubId: "h_otherhub0001" }, "Crosstalk hub");
    const started = (await h.call(phone.token, "POST", "/api/signin", { provider: "claude" })).body;
    await until(() => !!h.session(started.id)?.wantsCode, "the paste box");
    // The setup key the hub's setup tools really use (setup/index.ts): it opens the setup API, and nothing here.
    expect(h.app.internalSecret.length).toBeGreaterThan(16);
    const setupKey = setupKeyFor(h.app.internalSecret);
    expect(setupKey).not.toBe(h.app.internalSecret);
    expect(h.app.setup.checkKey(setupKey)).toBe(true);
    const routes = [["GET", "/api/signin", undefined], ["POST", "/api/signin", { provider: "claude" }], ["GET", `/api/signin/${started.id}`, undefined], ["POST", `/api/signin/${started.id}/code`, { code: `${PAGE_CODE}#nothing` }], ["DELETE", `/api/signin/${started.id}`, undefined]] as const;
    for (const [who, token, status] of [["a peer sign-in", peer.token, 403], ["another hub's full sign-in", hubSignIn.token, 403], ["the setup key", setupKey, 401], ["the hub's internal secret", h.app.internalSecret, 401], ["nobody", null, 401]] as const) {
      for (const [method, path, body] of routes) {
        const r = await h.call(token, method, path, body);
        expect({ who, method, path, status: r.status }).toEqual({ who, method, path, status });
      }
    }
    // The setup key the way the setup tools send it, in its own header.
    for (const [method, path, body] of routes) {
      const r = await fetch(h.base + path, { method, headers: { "x-crosstalk-setup": setupKey, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 401 });
    }
    // None of that touched the person's sign-in.
    expect(h.session(started.id)).toMatchObject({ state: "open", codesSent: 0 });
    // The state snapshot carries it for the person's devices only (another hub's full sign-in may read the snapshot).
    expect((await h.call(phone.token, "GET", "/api/state")).body.signInSessions.map((x: SignInSession) => x.id)).toEqual([started.id]);
    expect((await h.call(hubSignIn.token, "GET", "/api/state")).body.signInSessions).toEqual([]);

    // The session's link reaches the person's own devices' sockets, not another hub's.
    const sockets = await Promise.all([phone.token, hubSignIn.token].map(async (token) => {
      const got: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/api/ws?token=${token}`);
      ws.onmessage = (e) => got.push(JSON.parse(String(e.data)).t);
      await until(() => got.includes("hello"), "the socket");
      cleanups.push(() => ws.close());
      return got;
    }));
    await h.call(phone.token, "DELETE", `/api/signin/${started.id}`);
    await until(() => sockets[0].includes("signin.session"), "the phone to hear");
    await Bun.sleep(100);
    expect(sockets[1]).not.toContain("signin.session");
  });

  test("what can't be signed in to here says so: a key account, Antigravity's own screen, no such agent, a body that isn't JSON", async () => {
    const h = hub();
    const phone = await h.pair();
    const key = await h.app.providers.setApiKeyAccount("claude", "sk-ant-api03-not-a-real-key-0000000000", { label: "Key" });
    expect(await h.call(phone.token, "POST", "/api/signin", { provider: "claude", account: key.id })).toMatchObject({ status: 409, body: { code: "not_signin" } });
    expect(await h.call(phone.token, "POST", "/api/signin", { provider: "antigravity" })).toMatchObject({ status: 409, body: { code: "terminal" } });
    expect(await h.call(phone.token, "POST", "/api/signin", { provider: "nobody" })).toMatchObject({ status: 400 });
    expect(await h.call(phone.token, "POST", "/api/signin", { provider: "claude", account: "gone" })).toMatchObject({ status: 404 });
    const started = (await h.call(phone.token, "POST", "/api/signin", { provider: "claude" })).body;
    await until(() => !!h.session(started.id)?.wantsCode, "the paste box");
    // A body that isn't JSON is refused without being repeated back (it might hold the code).
    const bad = await h.call(phone.token, "POST", `/api/signin/${started.id}/code`, undefined, `{"code": ${PAGE_CODE}`);
    expect(bad).toMatchObject({ status: 400, body: { error: 'Send the code as JSON: { "code": "…" }.' } });
    expect(JSON.stringify(bad.body)).not.toContain(PAGE_CODE);
  });
});
