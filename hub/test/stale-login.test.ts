// A reply that fails because the agent's sign-in stopped working (agents/stale-login.ts, the engine's staleSignIn,
// signin.ts). A Claude Code chat can stop with "Failed to authenticate: OAuth session expired and could not be
// refreshed" while the setup checklist still says "signed in". Nothing here runs a real agent CLI, signs in or
// reads a real sign-in: the agents are the fakes in fixtures/ (their sign-in is a file of the test's own) or the mock.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleSignInWords, type Activity, type BackgroundTask, type Member, type Room, type ServerEvent } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver } from "../src/agents/codex";
import { MockDriver } from "../src/agents/mock";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { acpAuthHit, agyAuthHit, claudeAuthHit, claudeMarksOrigin, codexAuthHit, museAuthHit, museStartAuthHit } from "../src/agents/stale-login";
import { RpcError } from "../src/agents/jsonrpc";
import { App } from "../src/app";
import { Bus } from "../src/bus";
import { Store } from "../src/db";
import { Engine, type SignInHooks } from "../src/engine/engine";
import { registerProvider } from "../src/providers";
import { claudeProvider } from "../src/providers/claude";
import { newId } from "../src/util/ids";
import { endStarted } from "./standins";

setDefaultTimeout(30_000);
const FIX = join(import.meta.dir, "fixtures");
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

const ENV = ["CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_ARGS_OUT", "FAKE_CLAUDE_INPUT_OUT", "FAKE_CLAUDE_AUTH_FILE", "FAKE_CLAUDE_STALE_STARTS", "FAKE_CLAUDE_STALE_MIDWAY_STARTS", "FAKE_CLAUDE_LOGIN_STATE_OUT", "FAKE_CLAUDE_LOGIN_CODE"];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const cleanups: (() => Promise<void> | void)[] = [];
const sessionsInUse = ClaudeDriver.sessionsInUse;

beforeEach(() => {
  // The real modules, whatever another file left registered: the Claude Code driver and its sign-in check.
  registerProvider(claudeProvider);
  registerDriver("claude", (ctx) => new ClaudeDriver(ctx, ctx.bin));
  // Nothing of this Mac's own Claude Code sessions is looked at.
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

// ------------------------------------------------------------------------------------------------ the agents' words

describe("telling a sign-in that stopped working from other failures", () => {
  test("Claude Code: its typed error kind decides, its words sort the kind", () => {
    // The real failure, word for word (2.1.289's non-interactive text), and the interactive one.
    expect(claudeAuthHit({ error: "authentication_failed", text: "Failed to authenticate: OAuth session expired and could not be refreshed" })?.kind).toBe("stale");
    expect(claudeAuthHit({ error: "authentication_failed", text: "Login expired · Please run /login" })?.kind).toBe("stale");
    expect(claudeAuthHit({ error: "authentication_failed", text: "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator." })?.kind).toBe("stale");
    expect(claudeAuthHit({ apiErrorStatus: 401, text: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' })?.kind).toBe("stale");
    expect(claudeAuthHit({ error: "server_error", text: "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute" })?.kind).toBe("busy");
    expect(claudeAuthHit({ error: "invalid_request", apiError: "stored_login_refused", text: "Restart Claude Code to finish signing in." })?.kind).toBe("stale");
    expect(claudeAuthHit({ error: "authentication_failed", text: "Not logged in · Please run /login" })?.kind).toBe("signedOut");
    expect(claudeAuthHit({ error: "authentication_failed", text: "Authentication required · Sign in again to continue" })?.kind).toBe("signedOut");
    // Lookalikes that a fresh process or a sign-in can't fix.
    expect(claudeAuthHit({ error: "invalid_request", text: "Failed to refresh OAuth token: the disk that holds the Claude Code config directory (~/.claude by default), or your disk quota on it, is full. Delete files you no longer need on that disk and retry; signing in again won't help" })).toBeNull();
    expect(claudeAuthHit({ error: "invalid_request", apiError: "stored_login_refused", text: "Your organization's settings need an update. Ask your administrator to fix the API key helper configuration." })).toBeNull();
    expect(claudeAuthHit({ error: "authentication_failed", text: "Invalid API key · Fix external API key" })).toBeNull();
    expect(claudeAuthHit({ error: "authentication_failed", apiError: "provider_credentials", text: "Bedrock credentials expired · refresh your AWS credentials" })).toBeNull();
    expect(claudeAuthHit({ error: "authentication_failed", text: "Authentication error · The gateway refused · signing in again won't change this — check with your gateway administrator" })).toBeNull();
    expect(claudeAuthHit({ apiErrorStatus: 429, text: "You've hit your session limit · resets 11pm" })).toBeNull();
    // Words alone, without the typed kind, aren't enough (a model's reply could say anything).
    expect(claudeAuthHit({ text: "Failed to authenticate: OAuth session expired and could not be refreshed" })).toBeNull();
    // A cloud session's own words (CLAUDE_CODE_REMOTE): not a sign-in of this machine's.
    expect(claudeAuthHit({ error: "authentication_failed", text: "Authentication error · This may be a temporary network issue, please try again" })).toBeNull();
  });

  test("Claude Code: of the API's own answers, only Anthropic's 401 is a stale sign-in", () => {
    // 2.1.316 words every 401 and 403 alike, and marks the ones Anthropic's own API sent.
    const forbidden = (message: string) => ({ error: "authentication_failed", apiErrorStatus: 403, apiErrorOrigin: "first_party", marksOrigin: true, text: `Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"${message}"}}` });
    expect(claudeAuthHit(forbidden("This organization has been disabled."))).toBeNull();
    expect(claudeAuthHit(forbidden("OAuth token does not meet scope requirement user:inference"))).toBeNull();
    // A 403 without the status field (the words have it) is still a 403.
    expect(claudeAuthHit({ error: "authentication_failed", text: 'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"This organization has been disabled."}}' })).toBeNull();
    const anthropic401 = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}';
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 401, apiErrorOrigin: "first_party", marksOrigin: true, text: anthropic401 })?.kind).toBe("stale");
    // A gateway's 401 is its own token's: 2.1.316 leaves the origin out, whatever its body looks like.
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 401, marksOrigin: true, text: anthropic401 })).toBeNull();
    const gateway = 'Failed to authenticate. API Error: 401 {"error":{"message":"Authentication Error, Invalid proxy server token passed","type":"auth_error","code":"401"}}';
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 401, marksOrigin: true, text: gateway })).toBeNull();
    // An older Claude Code doesn't mark them: Anthropic's own error body tells.
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 401, marksOrigin: false, text: anthropic401 })?.kind).toBe("stale");
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 401, marksOrigin: false, text: gateway })).toBeNull();
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 401, text: "Failed to authenticate. API Error: 401 Unauthorized" })).toBeNull();
    // Claude Code's own sentence for a revoked token comes with the API's status, 401 or 403: it's still a stale sign-in.
    const revoked = "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.";
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 403, apiErrorOrigin: "first_party", marksOrigin: true, text: revoked })?.kind).toBe("stale");
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 401, marksOrigin: false, text: revoked })?.kind).toBe("stale");
    // Its sentences count only as its own, never inside an API's answer.
    expect(claudeAuthHit({ error: "authentication_failed", apiErrorStatus: 403, apiErrorOrigin: "first_party", marksOrigin: true, text: 'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Not logged in to this workspace: OAuth session expired for its SSO"}}' })).toBeNull();
    // Which versions mark them.
    expect(["2.1.289", "2.1.315", "2.1.316", "2.1.400", "2.2.0", "3.0.1", "", null].map(claudeMarksOrigin)).toEqual([false, false, true, true, true, true, false, false]);
  });

  test("Codex, Muse Code, Gemini CLI and Antigravity CLI: their own signals", () => {
    expect(codexAuthHit({ codexErrorInfo: "unauthorized", message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." })?.kind).toBe("stale");
    expect(codexAuthHit({ codexErrorInfo: null, message: "Your authentication session could not be refreshed automatically. Please log out and sign in again." })?.kind).toBe("stale");
    expect(codexAuthHit({ codexErrorInfo: "usageLimitExceeded", message: "You've hit your usage limit." })).toBeNull();
    expect(codexAuthHit({ codexErrorInfo: "contextWindowExceeded", message: "Codex ran out of room" })).toBeNull();
    expect(museAuthHit({ kind: "authRequired", message: "not logged in: run `muse login` first" })?.kind).toBe("signedOut");
    expect(museAuthHit({ kind: "authRequired", message: "still unauthorized after a token refresh; run `muse login` again" })?.kind).toBe("stale");
    expect(museAuthHit({ kind: "rateLimited", message: "slow down" })).toBeNull();
    expect(museStartAuthHit("muse serve exited: not logged in: run `muse login` first")?.kind).toBe("signedOut");
    expect(acpAuthHit(new RpcError(-32000, "Authentication required"))?.kind).toBe("signedOut");
    // The same code for a process that went away is not a sign-in.
    expect(acpAuthHit(new RpcError(-32000, "Gemini CLI exited (code 1)"))).toBeNull();
    expect(acpAuthHit(new Error('invalid_grant: Token has been expired or revoked.'))?.kind).toBe("stale");
    // As Gemini CLI passes on what Google's auth library raised: an internal error whose details are the OAuth code.
    expect(acpAuthHit(new RpcError(-32603, "Internal error", { details: "invalid_grant" }))?.kind).toBe("stale");
    expect(agyAuthHit("Authentication expired. Please log back in.")?.kind).toBe("stale");
    expect(agyAuthHit("RESOURCE_EXHAUSTED: rate limit")).toBeNull();
  });

  test("Gemini CLI and Antigravity CLI lookalikes: cloud credentials, MCP servers and what a process printed aren't a sign-in", () => {
    // A Vertex AI or application-default credential refused (no oauth_creds.json to sign in to): cloud credentials.
    const vertex = { error: { code: 401, message: "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.", status: "UNAUTHENTICATED" } };
    expect(acpAuthHit(new RpcError(-32603, "Internal error", vertex))).toBeNull();
    expect(acpAuthHit(new RpcError(-32603, "Internal error", { details: JSON.stringify(vertex) }))).toBeNull();
    expect(acpAuthHit(new Error("[VertexAI] 401 UNAUTHENTICATED: Request had invalid authentication credentials."))).toBeNull();
    // An MCP server's own word, in what an exiting Gemini CLI printed last (Crosstalk's -32000 for a process gone).
    expect(acpAuthHit(new RpcError(-32000, "Gemini CLI exited (code 1): MCP server 'github' failed: unauthenticated"))).toBeNull();
    expect(acpAuthHit(new RpcError(-32000, "Gemini CLI exited (code 1): Error: invalid_grant | refreshing the GitHub MCP token"))).toBeNull();
    expect(acpAuthHit(new RpcError(-32603, "Internal error", { details: "MCP server 'drive' said: invalid_grant" }))).toBeNull();
    // Antigravity CLI's stderr says "not authenticated" about other things: only its own sentence counts.
    expect(agyAuthHit("[mcp] browseros: not authenticated, skipping")).toBeNull();
    expect(agyAuthHit("Print mode: not authenticated, trying silent auth")).toBeNull();
    expect(agyAuthHit("unauthenticated")).toBeNull();
    expect(agyAuthHit("Not signed in to github.com. Set GH_TOKEN or run 'gh auth login'.")).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ the drivers

function driverCtx(provider: Member["provider"], env: Record<string, string> = {}): DriverContext {
  const dir = temp("ct-stale-drv-");
  const room: Room = { id: "r1", name: "Room", cwd: dir, mode: "relay", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
  const member: Member = { id: "m1", roomId: "r1", handle: provider, provider, model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 };
  return { room, member, session: {}, mcp: { command: "true", args: [], env: {} }, env: { PATH: process.env.PATH ?? "", ...env }, bin: "" };
}

function quietSink(): TurnSink {
  const abort = new AbortController();
  let n = 0;
  return {
    signal: abort.signal,
    text: () => {},
    setText: () => {},
    activity: () => `a${++n}`,
    updateActivity: () => {},
    approval: async () => "deny",
    usage: () => {},
    rateLimit: () => {},
    status: () => {},
    saveSession: () => {},
  };
}

describe("the drivers report it, against the fake CLIs", () => {
  test("Claude Code: the stale sign-in, a renewal another process held, and a full disk that isn't one", async () => {
    const c = driverCtx("claude", { CLAUDE_CONFIG_DIR: temp("ct-stale-cfg-") });
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    cleanups.push(() => d.dispose());
    const stale = await d.runTurn({ turnId: "t1", prompt: "STALE_LOGIN please", systemNote: null }, quietSink());
    expect(stale).toMatchObject({ ok: false, auth: { kind: "stale" } });
    expect(stale.auth!.said).toContain("OAuth session expired and could not be refreshed");
    // In words a person can act on, even without the engine's recovery.
    expect(stale.error).toContain("sign-in on the hub stopped working");
    const busy = await d.runTurn({ turnId: "t2", prompt: "REFRESH_BUSY please", systemNote: null }, quietSink());
    expect(busy.auth?.kind).toBe("busy");
    const restart = await d.runTurn({ turnId: "t3", prompt: "RESTART_TO_SIGN_IN please", systemNote: null }, quietSink());
    expect(restart.auth?.kind).toBe("stale");
    const disk = await d.runTurn({ turnId: "t4", prompt: "DISK_FULL please", systemNote: null }, quietSink());
    expect(disk.auth).toBeUndefined();
    expect(disk.error).toContain("disk is full");
    const fine = await d.runTurn({ turnId: "t5", prompt: "hello", systemNote: null }, quietSink());
    expect(fine.ok).toBe(true);
    // The API's own answers, as 2.1.316 reports them: Anthropic's 401 is stale; its 403 and a gateway's 401 aren't.
    const refused = await d.runTurn({ turnId: "t6", prompt: "FIRST_PARTY_401 please", systemNote: null }, quietSink());
    expect(refused.auth?.kind).toBe("stale");
    const forbidden = await d.runTurn({ turnId: "t7", prompt: "FORBIDDEN_403 please", systemNote: null }, quietSink());
    expect(forbidden).toMatchObject({ ok: false });
    expect(forbidden.auth).toBeUndefined();
    const gateway = await d.runTurn({ turnId: "t8", prompt: "GATEWAY_401 please", systemNote: null }, quietSink());
    expect(gateway).toMatchObject({ ok: false });
    expect(gateway.auth).toBeUndefined();
  });

  test("Codex: a TurnError typed unauthorized", async () => {
    // Its own CODEX_HOME: a Codex driver must never reach the user's running Codex (AGENTS.md).
    const c = driverCtx("codex");
    c.env.CODEX_HOME = join(c.room.cwd, "codex-home");
    const d = new CodexDriver(c, join(FIX, "fake-codex-app"));
    cleanups.push(() => d.dispose());
    const r = await d.runTurn({ turnId: "t1", prompt: "AUTH_STALE now", systemNote: null }, quietSink());
    expect(r).toMatchObject({ ok: false, auth: { kind: "stale" } });
    expect(r.error).toContain("refresh token was already used");
    // Partway through a reply, after a command: still its sign-in, with the step and the words already in the reply
    // (the engine then has the fresh process carry on instead of asking again).
    const steps: string[] = [];
    let words = "";
    const sink = { ...quietSink(), activity: (a: { title: string }) => (steps.push(a.title), `a${steps.length}`), text: (t: string) => void (words += t) };
    const midway = await d.runTurn({ turnId: "t2", prompt: "AUTH_STALE_MIDWAY now", systemNote: null }, sink);
    expect(midway).toMatchObject({ ok: false, auth: { kind: "stale" } });
    expect(steps.some((t) => t.includes("git push origin main"))).toBe(true);
    expect(words).toContain("Pushed the release.");
  });
});

// ------------------------------------------------------------------------------------------------ the engine, with the mock

interface EngineRig {
  engine: Engine;
  store: Store;
  room: Room;
  member: Member;
  events: ServerEvent[];
  /** Each agent process the engine started, what each was given, and whether it was ended. */
  made: { driver: AgentDriver; disposed: boolean; inputs: TurnInput[] }[];
  calls: string[];
  idle: () => Promise<void>;
}

/** An agent process scripted by a test: the rig records its inputs and whether it was ended. */
type Scripted = (n: number) => Pick<AgentDriver, "runTurn"> & Partial<Pick<AgentDriver, "steer" | "dispose">>;

function engineRig(config: Record<string, unknown>, hooks: Partial<SignInHooks> = {}, script?: Scripted): EngineRig {
  const store = new Store(":memory:");
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  const made: EngineRig["made"] = [];
  const calls: string[] = [];
  const signIn: SignInHooks = {
    covers: () => true,
    names: () => ({ agent: "Mock", machine: "Test Mac" }),
    isNeeded: () => false,
    check: async () => {
      calls.push("check");
      return true;
    },
    needed: () => {
      calls.push("needed");
      return "Mock is signed out on Test Mac, so it couldn't answer.";
    },
    stillFailing: (_r, _m, hit, signedIn) => {
      calls.push(`stillFailing:${hit.kind}:${signedIn}`);
      return "Mock's sign-in failed again.";
    },
    worked: () => calls.push("worked"),
    ...hooks,
  };
  const engine = new Engine({
    store,
    bus,
    createDriver: (ctx) => {
      const mock = new MockDriver(ctx);
      const custom = script?.(made.length + 1);
      const inner: Pick<AgentDriver, "runTurn"> & Partial<Pick<AgentDriver, "steer" | "dispose">> = custom ?? mock;
      const rec: EngineRig["made"][number] = { driver: mock as AgentDriver, disposed: false, inputs: [] };
      const d: AgentDriver = {
        provider: ctx.member.provider,
        runTurn: (input, sink) => {
          rec.inputs.push(input);
          return inner.runTurn(input, sink);
        },
        interrupt: () => mock.interrupt(),
        ...(inner.steer ? { steer: (text: string, ids?: string[]) => inner.steer!(text, ids) } : {}),
        canEndWhenIdle: () => true,
        dispose: async () => {
          rec.disposed = true;
          await (inner.dispose ? inner.dispose() : mock.dispose());
        },
      };
      rec.driver = d;
      made.push(rec);
      return d;
    },
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    signIn,
  });
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "Build fix", cwd: "/tmp", mode: "relay", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false, chat: { provider: "mock", origin: "web" } };
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "mock", origin: "web", localId: null });
  const member: Member = { id: newId("mb"), roomId: room.id, handle: "tester", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: { delayMs: 10, ...config }, createdAt: now, position: 0 };
  store.insertMember(member);
  cleanups.push(async () => {
    await engine.shutdown();
    store.close();
  });
  const idle = async () => {
    await Bun.sleep(5);
    await engine.whenIdle();
    await Bun.sleep(5);
  };
  return { engine, store, room, member, events, made, calls, idle };
}

/** The notes in a chat's replies, as they stand (a title or status that changed went out as a delta). */
const notices = (r: Pick<EngineRig, "store" | "room">): Activity[] =>
  r.store.listActivities(r.room.id, r.store.listTurns(r.room.id).map((t) => t.id)).filter((a) => a.kind === "notice");

describe("the engine starts the agent again once, then checks its sign-in", () => {
  test("a stale sign-in: a fresh process, the same reply carries on, and the chat says so", async () => {
    const r = engineRig({ auth: { times: 1 } });
    const msg = r.engine.postHumanMessage(r.room.id, "check the build", "Phone");
    await r.idle();
    const turns = r.store.listTurns(r.room.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "done", triggerMessageId: msg.id });
    // One process replaced, once: the first was ended, the second answered.
    expect(r.made).toHaveLength(2);
    expect(r.made[0].disposed).toBe(true);
    expect(r.made[1].disposed).toBe(false);
    const [note] = notices(r);
    expect(note).toMatchObject({ title: staleSignInWords("Mock", "Test Mac", "carried"), status: "done", turnId: turns[0].id });
    // It failed as the reply started (the usual case), so the fresh process got the very same message.
    expect(note.detail).toBe("It hadn't done anything yet, so it got the same message again.");
    expect(r.made[1].inputs[0].prompt).toBe(r.made[0].inputs[0].prompt);
    expect(r.made[0].inputs[0].prompt).toContain("check the build");
    const reply = r.store.getMessage(turns[0].replyMessageId!)!;
    expect(reply.status).toBe("done");
    expect(reply.text).toContain("I looked at");
    // A fresh process was all it took: the sign-in wasn't checked, and nothing says it's signed out.
    expect(r.calls).toEqual(["worked"]);
    expect(r.store.getMember(r.member.id)!.status).toBe("idle");
  });

  test("it fails partway, after a step of its own: the fresh process carries on from there instead of being asked again", async () => {
    const r = engineRig({ auth: { times: 1, midway: true } });
    r.engine.postHumanMessage(r.room.id, "Push the release and send the announcement email", "Phone");
    await r.idle();
    const [turn] = r.store.listTurns(r.room.id);
    expect(turn.status).toBe("done");
    expect(r.made).toHaveLength(2);
    // The first process ran a command and wrote before its sign-in failed: the same request again could do it twice.
    expect(r.made[0].inputs[0].prompt).toContain("Push the release and send the announcement email");
    const again = r.made[1].inputs[0];
    expect(again.prompt).not.toContain("Push the release");
    expect(again.prompt).toContain("Carry on with what was asked from where you got to");
    expect(again.prompt).toContain("don't do any of it again");
    // Its conversation already has the request and the briefing; its message isn't marked for a rewind again.
    expect(again.systemNote).toBeNull();
    expect(again.messageIds).toEqual([]);
    // The note says which of the two it was.
    const [note] = notices(r);
    expect(note).toMatchObject({ title: staleSignInWords("Mock", "Test Mac", "carried"), status: "done" });
    expect(note.detail).toBe("It had already done part of the work, so Crosstalk asked it to carry on from where it got to, without doing those steps again.");
    // What the first process wrote stays, and the fresh one's words follow it in the same reply.
    const reply = r.store.getMessage(turn.replyMessageId!)!;
    expect(reply.text).toStartWith("Listed the files.");
    expect(reply.text).toContain("I looked at");
  });

  test("Send now's message, handed to the process whose sign-in then fails, goes to the fresh one and is answered", async () => {
    // Process 1 takes the request, runs a step, writes, and fails as stale once a message was handed to it; process 2
    // answers. As Claude Code does, a message handed over mid-reply waits for its next step (here: never comes).
    const steered: { text: string; ids?: string[] }[] = [];
    let failNow!: () => void;
    const failed = new Promise<void>((res) => (failNow = res));
    const r = engineRig({}, {}, (n) =>
      n === 1
        ? {
            runTurn: async (_input, sink) => {
              sink.taken?.();
              const step = sink.activity({ kind: "command", title: "cargo test -p parser", detail: "" });
              sink.updateActivity(step, { status: "done" });
              sink.text("Refactoring the parser first. ");
              await failed;
              return { ok: false, error: "Mock sign-in stopped working", auth: { kind: "stale", said: "mock" } };
            },
            steer: async (text, ids) => {
              steered.push({ text, ids });
              return true;
            },
          }
        : {
            runTurn: async (_input, sink) => {
              sink.text("Done, and I left the lexer alone.");
              return { ok: true };
            },
          },
    );
    const a = r.engine.postHumanMessage(r.room.id, "Refactor the parser", "Phone");
    await until(() => r.made.length === 1 && r.store.listActivities(r.room.id, r.store.listTurns(r.room.id).map((t) => t.id)).length > 0, "the first step");
    const b = r.engine.postHumanMessage(r.room.id, "Also: do NOT touch the lexer", "Phone");
    expect(await r.engine.sendNowWhy(r.room.id)).toEqual({ sent: true });
    expect(steered.map((x) => x.text)).toEqual(["Also: do NOT touch the lexer"]);
    failNow();
    await r.idle();

    const turns = r.store.listTurns(r.room.id);
    const reply = turns.find((t) => t.triggerMessageId === a.id)!;
    // Its own turn was closed by Send now; the reply that had it carried on and answered it.
    expect(turns.find((t) => t.triggerMessageId === b.id)?.status).toBe("stopped");
    expect(reply.status).toBe("done");
    expect(r.made).toHaveLength(2);
    // The fresh process got it, and it can be rewound to there.
    const given = r.made[1].inputs[0];
    expect(given.prompt).toContain("Also: do NOT touch the lexer");
    expect(given.prompt).toContain("Carry on with what was asked from where you got to");
    expect(given.messageIds).toEqual([b.id]);
    // Nobody is left owing it an answer: it was read, and answered below it.
    expect(r.engine.answersLater(b.id)).toBe(false);
    expect(r.store.getLastSeen(r.member.id).seq).toBeGreaterThanOrEqual(b.seq);
    const parts = r.store.listMessages(r.room.id, { limit: 20 }).filter((m) => m.turnId === reply.id);
    expect(parts.map((m) => m.text)).toEqual(["Refactoring the parser first.", "Done, and I left the lexer alone."]);
    expect(parts[1].seq).toBeGreaterThan(b.seq);
    const [note] = notices(r);
    expect(note.detail).toBe("It had already done part of the work, so Crosstalk asked it to carry on from where it got to, without doing those steps again. The message you sent while it worked went to it too.");
  });

  test("Send now's message, when the reply is stopped before a fresh process has it: it's unread again, not lost", async () => {
    let failNow!: () => void;
    const failed = new Promise<void>((res) => (failNow = res));
    let release!: () => void;
    const disposing = new Promise<void>((res) => (release = res));
    let ending = false;
    const r = engineRig({}, {}, (n) =>
      n === 1
        ? {
            runTurn: async (_input, sink) => {
              sink.taken?.();
              sink.text("Working on it. ");
              await failed;
              return { ok: false, error: "Mock sign-in stopped working", auth: { kind: "stale", said: "mock" } };
            },
            steer: async () => true,
            // Ending the old process takes a while: Stop comes meanwhile.
            dispose: async () => {
              ending = true;
              await disposing;
            },
          }
        : { runTurn: async () => ({ ok: true }) },
    );
    r.engine.postHumanMessage(r.room.id, "Refactor the parser", "Phone");
    await until(() => r.made.length === 1 && r.made[0].inputs.length === 1, "the first process");
    await Bun.sleep(20);
    const b = r.engine.postHumanMessage(r.room.id, "Also: do NOT touch the lexer", "Phone");
    expect((await r.engine.sendNowWhy(r.room.id)).sent).toBe(true);
    expect(r.store.getLastSeen(r.member.id).seq).toBeGreaterThanOrEqual(b.seq);
    failNow();
    await until(() => ending, "the old process to be ending");
    const stopping = r.engine.stop(r.room.id);
    release();
    await stopping;
    await r.idle();
    // No fresh process had it: it's unread again, so the next message or Try again brings it along.
    expect(r.made).toHaveLength(1);
    expect(r.store.getLastSeen(r.member.id).seq).toBeLessThan(b.seq);
    expect(r.engine.answersLater(b.id)).toBe(false);
  });

  test("it fails again in the fresh process: the sign-in check says signed out, and it stops there", async () => {
    const r = engineRig({ auth: { times: 99 } }, { check: async () => (r.calls.push("check"), false) });
    r.engine.postHumanMessage(r.room.id, "check the build", "Phone");
    await r.idle();
    const [turn] = r.store.listTurns(r.room.id);
    expect(turn.status).toBe("error");
    expect(turn.error).toBe("Mock is signed out on Test Mac, so it couldn't answer.");
    expect(r.store.getMessage(turn.replyMessageId!)!.text).toContain("Mock is signed out on Test Mac");
    // Never a loop: two processes, one check, and the reply stopped.
    expect(r.made).toHaveLength(2);
    expect(r.calls).toEqual(["check", "needed"]);
    expect(notices(r)[0]).toMatchObject({ title: staleSignInWords("Mock", "Test Mac", "failed"), status: "error" });
    expect(r.store.getMember(r.member.id)).toMatchObject({ status: "error", statusDetail: "Mock is signed out on Test Mac, so it couldn't answer." });
  });

  test("it fails again though the check says signed in: plain words, and nothing marked signed out", async () => {
    const r = engineRig({ auth: { times: 99, kind: "busy" } });
    r.engine.postHumanMessage(r.room.id, "check the build", "Phone");
    await r.idle();
    const [turn] = r.store.listTurns(r.room.id);
    expect(turn).toMatchObject({ status: "error", error: "Mock's sign-in failed again." });
    expect(r.calls).toEqual(["check", "stillFailing:busy:true"]);
    expect(r.made).toHaveLength(2);
  });

  test("no sign-in at all: it's checked first, and a signed-out agent isn't started again for nothing", async () => {
    const r = engineRig({ auth: { times: 99, kind: "signedOut" } }, { check: async () => (r.calls.push("check"), false) });
    r.engine.postHumanMessage(r.room.id, "check the build", "Phone");
    await r.idle();
    expect(r.store.listTurns(r.room.id)[0].status).toBe("error");
    expect(r.calls).toEqual(["check", "needed"]);
    expect(r.made).toHaveLength(1);
    expect(notices(r)).toEqual([]);
  });

  test("an account already known to be signed out that is signed in again by now: started again, and it carries on", async () => {
    const r = engineRig({ auth: { times: 1 } }, { isNeeded: () => true });
    r.engine.postHumanMessage(r.room.id, "check the build", "Phone");
    await r.idle();
    expect(r.store.listTurns(r.room.id)[0].status).toBe("done");
    expect(r.calls).toEqual(["check", "worked"]);
    expect(r.made).toHaveLength(2);
  });

  test("what the old process ran in the background is said, and shown stopped, not dropped", async () => {
    const r = engineRig({ helpers: { ms: 60_000 }, auth: { after: 1, times: 1 } });
    r.engine.postHumanMessage(r.room.id, "start the checks", "Phone");
    await r.idle();
    expect(r.engine.tasksIn(r.room.id)[r.member.id]?.[0]).toMatchObject({ description: "Checking the work", status: "running" });
    r.engine.postHumanMessage(r.room.id, "how's it going?", "Phone");
    await r.idle();
    const turns = r.store.listTurns(r.room.id);
    expect(turns.map((t) => t.status)).toEqual(["done", "done"]);
    const note = notices(r).find((a) => a.turnId === turns[1].id)!;
    expect(note.title).toBe(staleSignInWords("Mock", "Test Mac", "carried"));
    expect(note.detail).toContain('the helper "Checking the work"');
    expect(note.detail).toContain("is lost");
    const stopped = r.events.filter((e): e is Extract<ServerEvent, { t: "tasks" }> => e.t === "tasks").flatMap((e) => e.tasks).find((t: BackgroundTask) => t.status === "stopped");
    expect(stopped).toMatchObject({ description: "Checking the work", error: expect.stringContaining("sign-in had gone stale") });
  });

  test("an agent that isn't on a sign-in (an API key, a server of your own) just fails, as before", async () => {
    const r = engineRig({ auth: { times: 99 } }, { covers: () => false });
    r.engine.postHumanMessage(r.room.id, "check the build", "Phone");
    await r.idle();
    expect(r.store.listTurns(r.room.id)[0]).toMatchObject({ status: "error", error: "Mock sign-in stopped working (config.auth)" });
    expect(r.made).toHaveLength(1);
    expect(r.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ the whole hub, with the fake Claude Code

function hub() {
  const dir = temp("ct-stale-hub-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  process.env.FAKE_CLAUDE_ARGS_OUT = join(dir, "args.jsonl");
  process.env.FAKE_CLAUDE_INPUT_OUT = join(dir, "inputs.jsonl");
  process.env.FAKE_CLAUDE_AUTH_FILE = join(dir, "auth-state");
  process.env.FAKE_CLAUDE_LOGIN_STATE_OUT = join(dir, "login-state");
  process.env.FAKE_CLAUDE_LOGIN_CODE = "page-code-4e1b77c0";
  writeFileSync(process.env.FAKE_CLAUDE_AUTH_FILE, "in");
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.providers.which = (p) => (p === "claude" ? join(FIX, "fake-claude") : null);
  app.setHubSettings({ machineName: "Mac mini" });
  const events: ServerEvent[] = [];
  app.bus.on((e) => events.push(e));
  cleanups.push(() => app.shutdown());
  const starts = () => readFileSync(process.env.FAKE_CLAUDE_ARGS_OUT!, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const inputs = () => readFileSync(process.env.FAKE_CLAUDE_INPUT_OUT!, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);
  const chat = app.chats.create({ provider: "claude", name: "Release prep", cwd: join(dir, "project") } as never);
  const member = app.store.listMembers(chat.id)[0];
  const idle = async () => {
    await Bun.sleep(20);
    await app.engine.whenIdle();
    await Bun.sleep(20);
  };
  return { dir, app, events, starts, inputs, chat, member, idle };
}

describe("a stale sign-in, end to end", () => {
  test("a Claude Code process holding a stale sign-in is started again, and the reply completes", async () => {
    process.env.FAKE_CLAUDE_STALE_STARTS = "1";
    const h = hub();
    h.app.engine.postHumanMessage(h.chat.id, "Plan the next release", "Phone");
    await h.idle();
    const [turn] = h.app.store.listTurns(h.chat.id);
    expect(turn.status).toBe("done");
    const reply = h.app.store.getMessage(turn.replyMessageId!)!;
    expect(reply).toMatchObject({ status: "done" });
    expect(reply.text).toContain("Done.");
    // Two processes: the stale one, and the one started again, resuming the same conversation.
    const starts = h.starts();
    expect(starts).toHaveLength(2);
    const resumed = starts[1][starts[1].indexOf("--resume") + 1];
    expect(resumed).toBe(h.app.store.getMemberSession(h.member.id).sessionId as string);
    // The same message went to the new process (the first never sent a request).
    expect(h.inputs()).toEqual(["Plan the next release", "Plan the next release"]);
    const note = h.app.store.listActivities(h.chat.id, [turn.id]).find((a) => a.kind === "notice")!;
    expect(note).toMatchObject({ title: staleSignInWords("Claude Code", "Mac mini", "carried"), status: "done" });
    // Nothing was found signed out, and nothing failed.
    expect(h.app.signIns.needs()).toEqual([]);
    expect(h.events.some((e) => e.t === "signin.needs")).toBe(false);
    expect(h.app.store.getMember(h.member.id)!.status).toBe("idle");
  });

  test("a sign-in that can't be renewed partway through a reply: the fresh process carries on and doesn't push again", async () => {
    process.env.FAKE_CLAUDE_STALE_MIDWAY_STARTS = "1";
    const h = hub();
    h.app.engine.postHumanMessage(h.chat.id, "Push the release and send the announcement email", "Phone");
    await h.idle();
    const [turn] = h.app.store.listTurns(h.chat.id);
    expect(turn.status).toBe("done");
    expect(h.starts()).toHaveLength(2);
    // The first process pushed, then failed: the fresh one, resuming the same conversation, was told to carry on from
    // there, never given the request again.
    const [asked, carryOn] = h.inputs();
    expect(asked).toBe("Push the release and send the announcement email");
    expect(carryOn).not.toContain("Push the release");
    expect(carryOn).toStartWith("(Your reply stopped partway: your sign-in had gone stale, so Crosstalk started you again in this same conversation.");
    const steps = h.app.store.listActivities(h.chat.id, [turn.id]);
    expect(steps.filter((a) => a.title.includes("git push origin main"))).toHaveLength(1);
    const note = steps.find((a) => a.kind === "notice")!;
    expect(note).toMatchObject({ title: staleSignInWords("Claude Code", "Mac mini", "carried"), status: "done" });
    expect(note.detail).toContain("asked it to carry on from where it got to");
    const reply = h.app.store.getMessage(turn.replyMessageId!)!;
    expect(reply.text).toStartWith("Pushing the release.");
    expect(reply.text).toContain("Done.");
  });

  test("the fresh process fails too, the sign-in is gone: the chat and every device hear it's signed out, and a sign-in clears it", async () => {
    process.env.FAKE_CLAUDE_STALE_STARTS = "1";
    const h = hub();
    // Before this reply the checklist believed it was signed in (its status is from the hub's start).
    await h.app.providers.refresh("claude");
    expect(h.app.providers.list().find((s) => s.provider === "claude")!.signedIn).toBe(true);
    // Then Claude Code itself cleared the shared sign-in (a refresh token refused): every process fails from here.
    writeFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "out");
    h.app.engine.postHumanMessage(h.chat.id, "Plan the next release", "Phone");
    await h.idle();
    const [turn] = h.app.store.listTurns(h.chat.id);
    const words = "Claude Code is signed out on Mac mini, so it couldn't answer. Sign in to it again (Settings → Agents → Claude Code → Sign in), then tap Try again.";
    expect(turn).toMatchObject({ status: "error", error: words });
    expect(h.app.store.getMessage(turn.replyMessageId!)!.text).toBe(`⚠️ ${words}`);
    // Never a loop: the stale process, one fresh one, and then it stopped.
    expect(h.starts()).toHaveLength(2);
    // The checklist's cached status is the truth now.
    expect(h.app.providers.list().find((s) => s.provider === "claude")!.signedIn).toBe(false);
    // On the bus and in the snapshot, with the agent and the machine named.
    const need = { provider: "claude", account: "default", accountLabel: null, machine: { id: h.app.hubId(), name: "Mac mini" }, rooms: [h.chat.id], words };
    expect(h.app.signIns.needs()).toEqual([expect.objectContaining(need)]);
    const told = h.events.filter((e): e is Extract<ServerEvent, { t: "signin.needs" }> => e.t === "signin.needs").at(-1)!;
    expect(told.needs).toEqual([expect.objectContaining(need)]);
    const device = (await h.app.auth.pair((await h.app.auth.createPairingCode()).code, "Phone", "Web"))!.device;
    expect(h.app.snapshot(device).signIns).toEqual([expect.objectContaining(need)]);
    expect(h.app.store.getMember(h.member.id)).toMatchObject({ status: "error", statusDetail: words });
    // Kept on the hub: a restart still knows.
    expect(JSON.parse(h.app.store.kvGet("signInNeeds")!)).toEqual([expect.objectContaining(need)]);

    // Another message on the signed-out account: checked first, not started again for nothing.
    h.app.engine.postHumanMessage(h.chat.id, "Still there?", "Phone");
    await h.idle();
    expect(h.app.store.listTurns(h.chat.id).at(-1)!).toMatchObject({ status: "error", error: words });
    expect(h.starts()).toHaveLength(2);

    // Signed in again (here by hand: the sign-in sessions have their own tests): the need is over, the chat says so, and
    // Try again answers.
    writeFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "in");
    await h.app.providers.refresh("claude");
    expect(h.app.signIns.needs()).toEqual([]);
    expect(h.events.filter((e) => e.t === "signin.needs").at(-1)).toEqual({ t: "signin.needs", needs: [] });
    expect(h.app.store.listMessages(h.chat.id, { limit: 20 }).some((m) => m.authorKind === "system" && m.text === "Claude Code is signed in again on Mac mini. Tap Try again to carry on.")).toBe(true);
    h.app.engine.retry(h.chat.id);
    await h.idle();
    expect(h.app.store.listTurns(h.chat.id).at(-1)!.status).toBe("done");
  });

  test("signed out, then signed in from the phone: the idle process starts afresh and Try again answers", async () => {
    const h = hub();
    writeFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "out");
    h.app.engine.postHumanMessage(h.chat.id, "Plan the next release", "Phone");
    await h.idle();
    expect(h.app.store.listTurns(h.chat.id)[0].status).toBe("error");
    expect(h.app.signIns.needs()).toHaveLength(1);
    expect(h.starts()).toHaveLength(2);
    // The phone signs Claude Code in: the link, then the code its page shows.
    const session = await h.app.signIns.start("claude", "default");
    await until(() => h.app.signIns.get(session.id).wantsCode, "the paste box");
    h.app.signIns.sendCode(session.id, `page-code-4e1b77c0#${readFileSync(process.env.FAKE_CLAUDE_LOGIN_STATE_OUT!, "utf8").trim()}`);
    await until(() => h.app.signIns.get(session.id).state === "done", "the sign-in");
    expect(h.app.signIns.needs()).toEqual([]);
    // The process that failed was doing nothing: it's gone, so the next reply's process reads the new sign-in at once.
    h.app.engine.retry(h.chat.id);
    await h.idle();
    const last = h.app.store.listTurns(h.chat.id).at(-1)!;
    expect(last.status).toBe("done");
    expect(h.starts()).toHaveLength(3);
    expect(h.app.store.getMember(h.member.id)!.status).toBe("idle");
  });

  test("a prompt Claude Code had scheduled in the process it replaces is said to be gone, not dropped quietly", async () => {
    const h = hub();
    h.app.engine.postHumanMessage(h.chat.id, "Remind me SCHEDULE:0_9_*_*_*", "Phone");
    await h.idle();
    expect(h.app.store.listTurns(h.chat.id)[0].status).toBe("done");
    writeFileSync(process.env.FAKE_CLAUDE_AUTH_FILE!, "out");
    h.app.engine.postHumanMessage(h.chat.id, "Did it work?", "Phone");
    await h.idle();
    const turn = h.app.store.listTurns(h.chat.id).at(-1)!;
    const note = h.app.store.listActivities(h.chat.id, [turn.id]).find((a) => a.kind === "notice")!;
    expect(note).toMatchObject({ title: staleSignInWords("Claude Code", "Mac mini", "failed"), detail: "It hadn't done anything yet, so it got the same message again. The prompt it had scheduled for later in that process is gone too.", status: "error" });
  });
});
