// Crosstalk's own agent (and OpenCode, below) beside agent sign-in: 0.6.4's agent (agents/builtin.ts) and the stale-login
// recovery and phone sign-ins (agents/stale-login.ts, the engine's staleSignIn, signin.ts) were built side by side without seeing each other.
// Crosstalk's agent has no sign-in: it runs on an AI service's key. So a key the service refuses is said as a key —
// "NanoGPT refused the key — check it in Settings → AI services, then tap Try again." — and never taken for a sign-in: no
// fresh process for it, no sign-in check, nothing recorded as signed out, no sign-in that can be started for it. Its other
// failures are plain words with a way out too.
//
// Nothing here reaches a real AI service, BrowserOS neo or anyone's sign-in: NanoGPT is the stand-in in
// fixtures/fake-nanogpt.ts (or a scripted fetch), and the agent is never given a browser.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SIGN_IN_WORDS, SERVICE_ONLY_AGENTS, agentHasSignIn, isServiceKeyRefusal, noSignInWords, serviceKeyWords, signInNeededWords, staleSignInFailedWords, type Member, type ServerEvent } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { BuiltinDriver, serviceError, type BuiltinDeps } from "../src/agents/builtin";
import type { AgentDriver, DriverContext, TurnResult, TurnSink } from "../src/agents/driver";
import { App } from "../src/app";
import { registerProvider } from "../src/providers";
import { builtinProvider } from "../src/providers/builtin";
import { startServer } from "../src/server";
import { fakeNanoGpt, type ScriptedReply } from "./fixtures/fake-nanogpt";
import { endStarted } from "./standins";

setDefaultTimeout(30_000);
const KEY = "sk-nano-test-key-0001";
const PICK = "deepseek/deepseek-v4.1-flash-uncensored";
const REFUSED = "NanoGPT refused the key — check it in Settings → AI services, then tap Try again.";

const cleanups: (() => void | Promise<void>)[] = [];
const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
/** Each Crosstalk-agent process the hub made, so a test can tell whether it started one again. */
let made = 0;

/** The real agent, as the hub registers it, but never given BrowserOS neo: the browser the person works in isn't asked. */
const realAgent = () =>
  registerDriver("builtin", (ctx) => {
    made++;
    return new BuiltinDriver(ctx, { browserUrl: async () => null });
  });

beforeEach(() => {
  made = 0;
  registerProvider(builtinProvider);
  realAgent();
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  realAgent();
  await endStarted();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A hub with one NanoGPT chat on Crosstalk's agent, its key `key` (the stand-in takes only KEY). */
async function hub(o: { key?: string; replies?: ScriptedReply[] } = {}) {
  const dir = temp("ct-agent-signin-");
  const fake = fakeNanoGpt({ key: KEY, replies: o.replies ?? [] });
  cleanups.push(() => fake.stop());
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(() => app.shutdown());
  app.setHubSettings({ machineName: "Mac mini" });
  app.services.timeoutMs = 1500;
  app.services.nanogpt.origin = fake.url;
  await app.providers.refresh("builtin");
  const account = app.providers.setEndpointAccount("builtin", { label: "NanoGPT", baseUrl: fake.base, apiKey: o.key ?? "sk-nano-wrong", models: [PICK], contextWindow: 1_048_576, protocol: "chat" });
  const room = app.chats.create({ provider: "builtin", account: account.id, model: PICK, permissionMode: "full", cwd: join(dir, "project") } as never);
  const member = app.store.listMembers(room.id)[0];
  const events: ServerEvent[] = [];
  app.bus.on((e) => events.push(e));
  // Every time anything asks an agent's own sign-in check (the stale-login recovery does it through SignIns.check).
  const checks: string[] = [];
  const check = app.signIns.check.bind(app.signIns);
  app.signIns.check = async (m: Member) => {
    checks.push(m.provider);
    return check(m);
  };
  const idle = async () => {
    await Bun.sleep(20);
    await app.engine.whenIdle();
    await Bun.sleep(20);
  };
  const turns = () => app.store.listTurns(room.id);
  const notices = () => app.store.listActivities(room.id, turns().map((t) => t.id)).filter((a) => a.kind === "notice");
  const asked = () => fake.seen.filter((s) => s.path === "/api/v1/chat/completions");
  return { dir, app, fake, account, room, member, events, checks, idle, turns, notices, asked };
}

describe("a key the service refuses is never a sign-in", () => {
  test("the reply says to check the key in Settings → AI services: no fresh start, no sign-in check, nothing signed out", async () => {
    const h = await hub({ replies: [{ text: "Hello from NanoGPT." }] });
    expect(serviceKeyWords("NanoGPT")).toBe(REFUSED);
    h.app.engine.postHumanMessage(h.room.id, "Say hello", "Phone");
    await h.idle();
    expect(h.turns().map((t) => [t.status, t.error])).toEqual([["error", REFUSED]]);
    expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toContain(REFUSED);
    expect(h.app.store.getMember(h.member.id)).toMatchObject({ status: "error", statusDetail: REFUSED });
    // Asked once, by one process: the refusal was never taken for a sign-in that a fresh process might read afresh.
    expect(h.asked()).toHaveLength(1);
    expect(made).toBe(1);
    expect(h.checks).toEqual([]);
    expect(h.notices()).toEqual([]);
    // Nothing anywhere says it's signed out, or started a sign-in for it.
    expect(h.app.signIns.covers(h.member)).toBe(false);
    expect(h.app.signIns.needs()).toEqual([]);
    expect(h.app.signIns.sessions()).toEqual([]);
    expect(h.events.filter((e) => e.t === "signin.needs" || e.t === "signin.session")).toEqual([]);

    // The way out it names: a working key in Settings → AI services (what Change saves; the route then tells the engine,
    // as here), and Try again answers in the same chat.
    h.app.providers.setEndpointAccount("builtin", { id: h.account.id, baseUrl: h.fake.base, apiKey: KEY, models: [PICK], contextWindow: 1_048_576 });
    await h.app.engine.memberChanged(h.member.id);
    h.app.engine.retry(h.room.id);
    await h.idle();
    expect(h.turns().map((t) => t.status)).toEqual(["error", "done"]);
    expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("Hello from NanoGPT.");
    expect(h.asked().map((s) => s.key)).toEqual(["sk-nano-wrong", KEY]);
    expect(h.checks).toEqual([]);
  });

  test("a 403 and a missing key say the key too; a 403 about the model or money says that instead", () => {
    const said = (status: number, body: string, hasKey = true) => serviceError(status, body, "NanoGPT", PICK, null, { hasKey }).message;
    expect(said(401, '{"error":{"message":"Invalid API key"}}')).toBe(REFUSED);
    expect(said(403, '{"error":"Forbidden"}')).toBe(REFUSED);
    expect(said(403, "<html>Forbidden</html>")).toBe(REFUSED);
    expect(said(401, '{"error":{"message":"Missing API key"}}', false)).toBe("NanoGPT needs a key — add it in Settings → AI services, then tap Try again.");
    // A new key wouldn't change these: the service's own words say what would.
    const money = said(403, '{"error":{"message":"Insufficient balance"}}');
    expect(money).toBe(`NanoGPT says there isn't enough money in the account for ${PICK}: Insufficient balance. Add money on its website, or pick another model in this chat's settings (on NanoGPT, one its subscription covers).`);
    expect(said(403, '{"error":{"message":"This model is not available on your plan"}}')).toBe(`NanoGPT says ${PICK} isn't included in your plan. Pick another model in the chat's settings, or change your plan with NanoGPT.`);
    expect(said(403, '{"error":{"message":"This is a gated model: accept its license first"}}')).toContain("until you agree to that model's licence");
    expect([money].map(isServiceKeyRefusal)).toEqual([false]);
    // The phone knows the key's words (and only those) for Open AI services.
    expect([REFUSED, said(401, "", false)].map(isServiceKeyRefusal)).toEqual([true, true]);
    expect(isServiceKeyRefusal(signInNeededWords({ provider: "claude", account: "default" }, "Mac mini"))).toBe(false);
  });

  test("even a reply of Crosstalk's agent that claimed a sign-in failure is never treated as one", async () => {
    const h = await hub();
    // Whatever a driver ever reports: the engine asks SignIns.covers first, and Crosstalk's agent is never covered.
    for (const kind of ["stale", "busy", "signedOut"] as const) {
      registerDriver("builtin", () => {
        made++;
        return {
          provider: "builtin",
          runTurn: async (): Promise<TurnResult> => ({ ok: false, error: REFUSED, auth: { kind, said: "made up" } }),
          interrupt: async () => {},
          dispose: async () => {},
        } as AgentDriver;
      });
      await h.app.engine.memberChanged(h.member.id);
      made = 0;
      h.app.engine.postHumanMessage(h.room.id, `Try it (${kind})`, "Phone");
      await h.idle();
      expect({ kind, made, checks: h.checks, error: h.turns().at(-1)?.error }).toEqual({ kind, made: 1, checks: [], error: REFUSED });
    }
    // An account that isn't there any more (the chat names one this hub doesn't have): still no sign-in to renew, so
    // still nothing started again or checked.
    h.app.store.updateMember(h.member.id, { config: { ...h.member.config, account: "gone" } });
    await h.app.engine.memberChanged(h.member.id);
    made = 0;
    h.app.engine.postHumanMessage(h.room.id, "And now?", "Phone");
    await h.idle();
    expect({ made, checks: h.checks }).toEqual({ made: 1, checks: [] });
    expect(h.notices()).toEqual([]);
    expect(h.app.signIns.needs()).toEqual([]);
  });

  test("whatever account it's on — a service's, one removed since, none — it's never covered by the sign-in recovery", async () => {
    const h = await hub();
    expect(h.app.signIns.covers(h.member)).toBe(false);
    expect(h.app.signIns.covers({ ...h.member, config: { ...h.member.config, account: "gone" } })).toBe(false);
    expect(h.app.signIns.covers({ ...h.member, config: {} })).toBe(false);
    // The agents that do have one still are (a plan sign-in), so the recovery itself is untouched.
    expect(h.app.signIns.covers({ ...h.member, provider: "claude", config: {} })).toBe(true);
  });
});

describe("no sign-in for Crosstalk's agent, from anywhere", () => {
  test("the sheet's route and Settings' older one answer not_signin with the way to its key; none ever starts", async () => {
    const h = await hub();
    const server = startServer(h.app);
    cleanups.push(() => void server.stop(true));
    const phone = (await h.app.auth.pair((await h.app.auth.createPairingCode(60_000)).code, "Phone", "Web"))!;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    for (const account of [undefined, h.account.id, "default", "gone"]) {
      expect(await call("POST", "/api/signin", { provider: "builtin", ...(account ? { account } : {}) })).toEqual({ status: 409, body: { error: NO_SIGN_IN_WORDS, code: "not_signin" } });
    }
    const refused = { status: 409, body: { error: NO_SIGN_IN_WORDS, code: "not_signin" } };
    // Settings' older sign-in, by its account (one it has, one it never had) or the agent's own.
    for (const account of [h.account.id, "gone"]) expect(await call("POST", `/api/accounts/builtin/${account}/login`, {})).toEqual(refused);
    expect(await call("POST", "/api/providers/builtin/login", {})).toEqual(refused);
    // Nor signed out, nor given another sign-in: the same words, never "Sign-out for builtin isn't available" or "can only
    // use one account on a hub", which named the agent by its code and said something that isn't so.
    for (const account of [h.account.id, "gone"]) expect(await call("POST", `/api/accounts/builtin/${account}/logout`, {})).toEqual(refused);
    expect(await call("POST", "/api/providers/builtin/logout", {})).toEqual(refused);
    expect(await call("POST", "/api/accounts", { provider: "builtin", label: "Work" })).toEqual(refused);
    expect(NO_SIGN_IN_WORDS).toBe("Crosstalk's own agent has no sign-in: it runs on an AI service's key. Check that key in Settings → AI services.");
    // Nothing started, nothing to any device, and its service is the one account it has, untouched.
    expect(h.app.signIns.sessions()).toEqual([]);
    expect((await call("GET", "/api/signin")).body).toEqual({ needs: [], sessions: [] });
    expect(h.events.filter((e) => e.t === "signin.session" || e.t === "login" || e.t === "pty")).toEqual([]);
    expect(h.app.providers.accounts().filter((a) => a.provider === "builtin").map((a) => [a.id, a.kind, a.signedIn])).toEqual([[h.account.id, "endpoint", true]]);
    // The agents that do sign in still go on to their own checks (here: a Claude Code account that doesn't exist).
    expect((await call("POST", "/api/accounts/claude/gone/logout", {})).status).toBe(404);
  });

  test("it's never recorded or listed as signed out: not in the state, not to any device, whatever asks", async () => {
    const h = await hub();
    // Even asked outright (only the engine asks, after covers()), nothing is kept for it and no device hears of it, and
    // the words are its key's, never "signed out" or a sign-in that failed: the same the reply gives a refused key.
    expect(h.app.signIns.needed(h.room, h.member)).toBe(REFUSED);
    for (const signedIn of [true, false, null]) expect(h.app.signIns.stillFailing(h.room, h.member, { kind: "stale", said: "made up" }, signedIn)).toBe(REFUSED);
    expect(h.app.signIns.stillFailing(h.room, h.member, { kind: "busy", said: "made up" }, null)).toBe(REFUSED);
    expect(h.app.signIns.isNeeded(h.member)).toBe(false);
    expect(h.app.signIns.needs()).toEqual([]);
    const { device } = (await h.app.auth.pair((await h.app.auth.createPairingCode(60_000)).code, "Phone", "Web"))!;
    expect(h.app.snapshot(device).signIns).toEqual([]);
    expect(h.events.filter((e) => e.t === "signin.needs")).toEqual([]);
    // And a need kept from before for it (whatever wrote it) is never listed, while a real agent's still is.
    h.app.store.kvSet(
      "signInNeeds",
      JSON.stringify([
        { provider: "builtin", account: h.account.id, accountLabel: "NanoGPT", machine: { id: "h", name: "Mac mini" }, since: 1, rooms: [h.room.id], words: "x" },
        { provider: "claude", account: "default", accountLabel: null, machine: { id: "h", name: "Mac mini" }, since: 2, rooms: [], words: "y" },
      ]),
    );
    const { SignIns } = await import("../src/signin");
    expect(new SignIns(h.app).needs().map((n) => n.provider)).toEqual(["claude"]);
  });
});

describe("OpenCode has no sign-in either: it runs on a service's key, as Crosstalk's agent does", () => {
  const OPENCODE_WORDS = "OpenCode has no sign-in: it runs on an AI service's key. Check that key in Settings → AI services.";

  test("every agent that runs only on services is said to have none, in its own name, and the sign-in words asked for one are its key's", () => {
    expect(SERVICE_ONLY_AGENTS.filter((p) => agentHasSignIn(p))).toEqual([]);
    expect(noSignInWords("opencode")).toBe(OPENCODE_WORDS);
    expect(noSignInWords("builtin")).toBe(NO_SIGN_IN_WORDS);
    const who = { provider: "opencode", account: "svc1", accountLabel: "Refuseless" } as const;
    const key = "Refuseless refused the key — check it in Settings → AI services, then tap Try again.";
    expect(signInNeededWords(who, "Mac mini")).toBe(key);
    for (const signedIn of [true, false, null]) expect(staleSignInFailedWords(who, "Mac mini", { busy: false, signedIn })).toBe(key);
    // The agents that do sign in still do.
    for (const p of ["claude", "codex", "muse", "gemini", "antigravity"] as const) expect(agentHasSignIn(p)).toBe(true);
  });

  test("never covered by the recovery, whatever account it names, never recorded signed out, and the routes answer not_signin", async () => {
    const h = await hub();
    const account = h.app.providers.setEndpointAccount("opencode", { label: "Refuseless", baseUrl: h.fake.base, apiKey: "abl_wrong", models: [PICK], contextWindow: 1_048_576, protocol: "chat" });
    const member: Member = { ...h.member, provider: "opencode", config: { ...h.member.config, account: account.id } };
    for (const m of [member, { ...member, config: { ...member.config, account: "gone" } }, { ...member, config: {} }]) expect(h.app.signIns.covers(m)).toBe(false);
    const key = "Refuseless refused the key — check it in Settings → AI services, then tap Try again.";
    expect(h.app.signIns.needed(h.room, member)).toBe(key);
    expect(h.app.signIns.isNeeded(member)).toBe(false);
    expect(h.app.signIns.needs()).toEqual([]);
    expect(h.events.filter((e) => e.t === "signin.needs")).toEqual([]);

    const server = startServer(h.app);
    cleanups.push(() => void server.stop(true));
    const phone = (await h.app.auth.pair((await h.app.auth.createPairingCode(60_000)).code, "Phone", "Web"))!;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const refused = { status: 409, body: { error: OPENCODE_WORDS, code: "not_signin" } };
    for (const a of [undefined, account.id, "default", "gone"]) expect(await call("POST", "/api/signin", { provider: "opencode", ...(a ? { account: a } : {}) })).toEqual(refused);
    for (const a of [account.id, "gone"]) {
      expect(await call("POST", `/api/accounts/opencode/${a}/login`, {})).toEqual(refused);
      expect(await call("POST", `/api/accounts/opencode/${a}/logout`, {})).toEqual(refused);
    }
    expect(await call("POST", "/api/providers/opencode/login", {})).toEqual(refused);
    expect(await call("POST", "/api/providers/opencode/logout", {})).toEqual(refused);
    expect(await call("POST", "/api/accounts", { provider: "opencode", label: "Work" })).toEqual(refused);
    expect(h.app.signIns.sessions()).toEqual([]);
    expect(h.events.filter((e) => e.t === "signin.session" || e.t === "login" || e.t === "pty")).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ its other failures

/** A one-agent chat's context for the driver, on NanoGPT at `base`. */
function ctxFor(cwd: string, base = "http://127.0.0.1:9/api", key = KEY): DriverContext {
  return {
    room: { id: "r1", cwd, name: "Agent test" },
    member: { id: `mb-${Math.random().toString(36).slice(2, 8)}`, provider: "builtin", model: PICK, permissionMode: "full", config: {} },
    session: {},
    mcp: { command: "", args: [], env: {} },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
    bin: "",
    chat: null,
    endpoint: { id: "nano", label: "NanoGPT", baseUrl: base, models: [PICK], contextWindow: 1_048_576, key },
  } as unknown as DriverContext;
}

function sinkFor() {
  const ac = new AbortController();
  const out = { text: "", notes: [] as { title: string; detail: string; status: string }[] };
  const sink: TurnSink = {
    text: (d) => void (out.text += d),
    setText: (t) => void (out.text = t),
    activity: (a) => {
      out.notes.push({ title: a.title, detail: a.detail ?? "", status: a.status ?? "running" });
      return `a${out.notes.length}`;
    },
    updateActivity: (id, patch) => {
      const a = out.notes[Number(id.slice(1)) - 1];
      if (patch.status) a.status = patch.status;
      if (patch.appendDetail) a.detail += patch.appendDetail;
    },
    approval: async () => "deny",
    usage: () => {},
    rateLimit: () => {},
    status: () => {},
    saveSession: () => {},
    newReply: () => {},
    taken: () => {},
    signal: ac.signal,
  };
  return { sink, out };
}

/** A scripted service: each call gets the next answer (the last one again once they run out). */
function scripted(answers: (() => Response | Promise<Response>)[]): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const f = (async () => {
    const a = answers[Math.min(n, answers.length - 1)];
    n++;
    return a();
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => n };
}

const sse = (...events: unknown[]) => new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const answer = (text: string) => sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } });
const status = (code: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code, headers: { "content-type": "application/json", ...headers } });

function agent(cwd: string, deps: BuiltinDeps, base?: string, key?: string) {
  const d = new BuiltinDriver(ctxFor(cwd, base, key), { browserUrl: async () => null, runDir: join(cwd, ".run"), ...deps });
  cleanups.push(() => d.dispose());
  return d;
}

const turn = (prompt: string, ids: string[] = []) => ({ turnId: `t-${Math.random().toString(36).slice(2, 8)}`, prompt, systemNote: null, messageIds: ids });

describe("its own failures: plain words, each with a way out, and never a sign-in", () => {
  test("a rate limit, a server error, a request turned down, one too big: what happened and what to do", async () => {
    const cwd = temp("ct-agent-words-");
    const run = async (answers: (() => Response)[]) => agent(cwd, { fetch: scripted(answers).fetch, pause: async () => {} }).runTurn(turn("hi"), sinkFor().sink);

    const limited = await run([() => status(429, { error: { message: "Too many requests" } })]);
    expect(limited).toMatchObject({ ok: false, error: "NanoGPT has had too many requests from this account just now. Wait a moment, then tap Try again.", limit: { kind: "rate" } });
    // The service's own words go in when they add something (a time in them is what the wait is read from).
    const soon = await run([() => status(429, { error: { message: "Rate limit reached, try again in 20 seconds" } })]);
    expect(soon.error).toBe("NanoGPT has had too many requests from this account just now (Rate limit reached, try again in 20 seconds). Wait a moment, then tap Try again.");
    expect(soon.limit?.resetsAt).toBeGreaterThan(Date.now());

    const refused = await run([() => status(400, { error: { message: "tool_choice is not supported" } })]);
    expect(refused).toEqual({ ok: false, error: "NanoGPT turned the request down (error 400: tool_choice is not supported). Check the model and its settings in Settings → AI services, then tap Try again." });
    const big = await run([() => status(400, { error: { message: "This model's maximum context length is 131072 tokens" } })]);
    // Since 0.6.6 it's summarised by itself first: only what that can't help reaches the person, with how to go on.
    expect(big.error).toBe(`This conversation is too long for ${PICK}, and it couldn't be summarised to make room. To go on, edit your last message to make it shorter, start a new chat and say where the work stands, or pick a model that holds more in this chat's settings. (The service said: This model's maximum context length is 131072 tokens)`);
    // A body that isn't one message never shows as "[object Object]".
    const odd = await run([() => status(400, { error: { type: "invalid_request_error" } })]);
    expect(odd.error).toBe("NanoGPT turned the request down (error 400). Check the model and its settings in Settings → AI services, then tap Try again.");

    // A server error is tried three more times first (0.6.6), then said.
    const s = scripted([() => status(503, { error: { message: "Upstream overloaded" } })]);
    const down = await agent(cwd, { fetch: s.fetch, pause: async () => {} }).runTurn(turn("hi"), sinkFor().sink);
    expect(down).toEqual({ ok: false, error: "NanoGPT had a problem (error 503: Upstream overloaded). Wait a minute, then tap Try again." });
    expect(s.calls()).toBe(4);
    for (const r of [limited, soon, refused, big, odd, down]) expect(r.auth).toBeUndefined();
  });

  test("an answer that breaks off, one that can't be read, and a service that can't be reached", async () => {
    const cwd = temp("ct-agent-words-");
    const run = async (answers: (() => Response)[], base?: string) => agent(cwd, { fetch: scripted(answers).fetch, pause: async () => {} }, base).runTurn(turn("hi"), sinkFor().sink);
    // An error in the middle of the stream: in the service's words, never "[object Object]".
    expect(await run([() => sse({ error: { message: "Upstream overloaded" } })])).toEqual({ ok: false, error: "NanoGPT stopped partway through its answer (Upstream overloaded). Tap Try again." });
    expect(await run([() => sse({ error: { code: 500 } })])).toEqual({ ok: false, error: "NanoGPT stopped partway through its answer. Tap Try again." });
    expect(await run([() => new Response("<html>gateway</html>", { headers: { "content-type": "application/json" } })])).toEqual({
      ok: false,
      error: "NanoGPT sent an answer Crosstalk couldn't read. Tap Try again; if it keeps happening, pick another model in the chat's settings.",
    });
    // The connection dropping mid-answer: plain words, not the network library's.
    const cut = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`));
            c.error(new Error("socket hang up"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    expect(await run([cut])).toEqual({ ok: false, error: "The connection to NanoGPT dropped partway through its answer. Tap Try again." });
    // Nothing answers at all (a closed port on this machine): tried four times (0.6.6), then said.
    const gone = await agent(cwd, { pause: async () => {} }).runTurn(turn("hi"), sinkFor().sink);
    expect(gone).toEqual({ ok: false, error: "Couldn't reach NanoGPT. Check this machine's internet connection, then tap Try again." });
  });

  test("Compact now with a refused key fails in the key's words, never \"nothing to summarise\"", async () => {
    const cwd = temp("ct-agent-words-");
    // Three replies go through, then the key is refused when the summary is asked for.
    const s = scripted([() => answer("One."), () => answer("Two."), () => answer("Three."), () => status(401, { error: { message: "Invalid API key" } })]);
    const d = agent(cwd, { fetch: s.fetch });
    for (const [i, words] of ["first", "second", "third"].entries()) expect(await d.runTurn(turn(words, [`m${i}`]), sinkFor().sink)).toEqual({ ok: true });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn("/compact"), sink)).toEqual({ ok: false, error: REFUSED });
    expect(out.text).toBe("");
    expect(out.notes).toEqual([{ title: "Summarising the conversation so far", detail: `Couldn't summarise: ${REFUSED}`, status: "error" }]);
    // With nothing to summarise yet it still says so, and that isn't a failure.
    const fresh = sinkFor();
    expect(await agent(temp("ct-agent-words-"), { fetch: scripted([() => answer("x")]).fetch }).runTurn(turn("/compact"), fresh.sink)).toEqual({ ok: true });
    expect(fresh.out.text).toBe("There wasn't enough to summarise yet.");
  });
});
