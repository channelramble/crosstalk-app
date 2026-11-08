// What each agent is told about the person working alongside it (agents/alongside.ts), read where the agent reads it: the
// command line and config the fakes were started with, the requests a stand-in service got. No real agent, no sign-in, no
// paid request, and each Codex in a Codex home of its own (a chat never reaches the Codex app's server).
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_LEAN_TOOLS_BELOW, PROVIDERS, type Member, type Provider, type Room } from "@crosstalk/shared";
import { textTokens } from "../src/adapter/translate";
import { registerDriver } from "../src/agents";
import { AcpDriver } from "../src/agents/acp";
import { ALONGSIDE, alongsideNote } from "../src/agents/alongside";
import { AntigravityDriver } from "../src/agents/antigravity";
import { BuiltinDriver } from "../src/agents/builtin";
import { ClaudeDriver } from "../src/agents/claude";
import { CODEX_QUESTION_NOTE, CodexDriver } from "../src/agents/codex";
import type { AgentDriver, DriverContext, TurnSink } from "../src/agents/driver";
import { helperNote } from "../src/agents/model-lock";
import { MuseDriver } from "../src/agents/muse";
import { OpenCodeDriver } from "../src/agents/opencode";
import { App } from "../src/app";
import { buildSystemNote, rosterHash } from "../src/engine/prompt";
import { fakeNanoGpt } from "./fixtures/fake-nanogpt";
import { endStarted } from "./standins";

setDefaultTimeout(30_000);
const FIX = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  await endStarted();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  // Back to what providers/all.ts registers.
  registerDriver("claude", (ctx) => {
    if (!ctx.bin) throw new Error("Claude Code isn't installed on the hub. Install it under Agents & sign-ins.");
    return new ClaudeDriver(ctx, ctx.bin);
  });
  registerDriver("codex", (ctx) => {
    if (!ctx.bin) throw new Error("Codex isn't installed on the hub. Install it under Agents & sign-ins.");
    return new CodexDriver(ctx, ctx.bin);
  });
});

const folder = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ct-alongside-")));
  dirs.push(d);
  return d;
};

/** Words only the full text has: any of them in an agent's instructions means it was told to work around the person. */
const FULL_TEXT = /keep messaging you|in the background so|don't ask the user to wait/;
/** Words only the part about helpers has. */
const HELPER_PART = /Give each helper|helper reports back|newer instructions win/;
/** Codex's own sentence. */
const NO_WAKE = /Nothing wakes you/;

const sink = (): TurnSink => ({
  text: () => {},
  setText: () => {},
  activity: () => "a",
  updateActivity: () => {},
  approval: async () => "deny",
  usage: () => {},
  rateLimit: () => {},
  status: () => {},
  saveSession: () => {},
  newReply: () => {},
  heartbeat: () => {},
  taken: () => {},
  signal: new AbortController().signal,
});

const turn = (d: AgentDriver, prompt = "hi") => d.runTurn({ turnId: `t-${Math.random()}`, prompt, systemNote: null }, sink());

function ctxOf(provider: Provider, cwd: string, o: { mode?: Room["mode"]; chat?: DriverContext["chat"]; env?: Record<string, string>; endpoint?: DriverContext["endpoint"]; config?: Record<string, unknown>; session?: Record<string, unknown>; model?: string | null } = {}): DriverContext {
  const room: Room = { id: "r1", name: "Room", cwd, mode: o.mode ?? "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
  const member: Member = { id: `m-${provider}`, roomId: "r1", handle: provider, provider, model: o.model ?? null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: o.config ?? {}, createdAt: 0, position: 0 };
  return { room, member, session: o.session ?? {}, mcp: { command: "true", args: [], env: { CROSSTALK_MEMBER_ID: member.id } }, env: { PATH: process.env.PATH ?? "", ...o.env }, bin: "", chat: o.chat === undefined ? { helper: null, notes: null } : o.chat, endpoint: o.endpoint ?? null };
}

const endpointOf = (contextWindow: number | null) => ({ id: "ep1", label: "Qwen local", baseUrl: "http://127.0.0.1:8099", models: ["qwen3.8-9b"], contextWindow, key: "" });

/** Claude Code's standing instructions, as the fake was started with them. */
async function claudeWords(o: Parameters<typeof ctxOf>[2] = {}): Promise<string> {
  const cwd = folder();
  const argsFile = join(cwd, "args.jsonl");
  const d = new ClaudeDriver(ctxOf("claude", cwd, { ...o, env: { FAKE_CLAUDE_ARGS_OUT: argsFile, ...o.env } }), join(FIX, "fake-claude"));
  cleanups.push(() => d.dispose());
  expect((await turn(d)).ok).toBe(true);
  const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]) as string[];
  return args[args.indexOf("--append-system-prompt") + 1];
}

/** A Codex chat's standing instructions and first message, as the fake app-server got them. */
async function codexWords(o: Parameters<typeof ctxOf>[2] = {}, prompt = "hello") {
  const cwd = folder();
  const log = join(cwd, "thread.json");
  const rpcLog = join(cwd, "rpc.jsonl");
  const d = new CodexDriver(ctxOf("codex", cwd, { ...o, env: { CODEX_HOME: join(cwd, "codex-home"), FAKE_CODEX_LOG: log, FAKE_CODEX_RPC_LOG: rpcLog, ...o.env } }), join(FIX, "fake-codex-app"));
  cleanups.push(() => d.dispose());
  expect((await turn(d, prompt)).ok).toBe(true);
  const sent = readFileSync(rpcLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return {
    developer: (JSON.parse(readFileSync(log, "utf8")).developerInstructions ?? "") as string,
    first: sent.find((x) => x.method === "turn/start").params.input[0].text as string,
    opened: sent.filter((x) => /^thread\/(start|resume|fork)$/.test(x.method ?? "")) as { method: string; params: { developerInstructions: string } }[],
  };
}

describe("the words", () => {
  test("every agent has said what applies to it, in one place", () => {
    expect(Object.keys(ALONGSIDE).sort()).toEqual([...PROVIDERS].sort());
    // What runs helpers or background jobs that outlive a reply gets the whole of it, and nothing else does.
    const whole = PROVIDERS.filter((p) => FULL_TEXT.test(ALONGSIDE[p] ?? ""));
    expect(whole.sort()).toEqual(["claude", "codex"]);
    expect(PROVIDERS.filter((p) => ALONGSIDE[p] === null).sort()).toEqual(["antigravity", "gemini", "mock", "muse"]);
  });

  test("the whole of it says what was asked", () => {
    for (const words of [ALONGSIDE.claude, ALONGSIDE.codex]) {
      // They can keep sending messages, and those may be new work on the same project.
      expect(words).toContain("can keep messaging you while your helpers and background jobs run, often with new work on this project");
      // Answer now, unless a request truly needs a helper's result; then say so and carry on.
      expect(words).toContain("Answer now");
      expect(words).toContain("wait for a helper only if a request truly needs its result, then say so and carry on with what else you can");
      // Who owns what.
      expect(words).toContain("its own files or a separate worktree, so it can't collide with you or the user");
      // When a helper reports back.
      expect(words).toContain("check what changed since it started before acting on it");
      expect(words).toContain("the user's newer instructions win");
      expect(words).toContain("Integrate the result and report it briefly");
    }
    // Long work in the background, and no asking to wait: where something wakes the agent when that work ends.
    expect(ALONGSIDE.claude).toContain("Start long work in the background so the chat stays free");
    expect(ALONGSIDE.claude).toContain("don't ask the user to wait");
    // Codex alone is never woken by what it left running (AgentDriver.owedTurn): "I'll report back" would be untrue there.
    expect(ALONGSIDE.codex).toMatch(NO_WAKE);
    expect(ALONGSIDE.claude).not.toMatch(NO_WAKE);
  });

  test("Codex isn't told to background long work: nothing would wake it to go on, so it keeps a multi-step request moving in its reply", () => {
    // Told to, it could start a helper on "run the full suite, fix what fails, then commit", end its reply, and do nothing
    // more until the person's next message; another chat's agent would get "started" as the answer. A message can reach a
    // running Codex turn anyway (steer), so staying in the reply holds nobody up.
    expect(ALONGSIDE.codex).not.toContain("in the background so");
    expect(ALONGSIDE.codex).not.toContain("Start long work");
    expect(ALONGSIDE.codex).not.toContain("don't ask the user to wait");
    expect(ALONGSIDE.codex).toContain("keep a multi-step request moving in your reply unless they asked to go on later");
    expect(ALONGSIDE.codex).toContain("say so when you end a reply with one running");
    // The rest it shares with Claude Code, word for word.
    const shared = ALONGSIDE.claude.split(" Start long work")[0];
    expect(ALONGSIDE.codex.startsWith(shared)).toBe(true);
  });

  test("it goes with every request, so its size is held down", () => {
    // Characters as they go, and tokens by the adapter's own estimate (translate.ts textTokens).
    const sizes = Object.fromEntries((["claude", "codex", "opencode", "builtin"] as const).map((p) => [p, { chars: ALONGSIDE[p].length, tokens: textTokens(ALONGSIDE[p]) }]));
    expect(sizes.claude.chars).toBeLessThanOrEqual(600);
    expect(sizes.claude.tokens).toBeLessThanOrEqual(155);
    expect(sizes.codex.chars).toBeLessThanOrEqual(745);
    expect(sizes.codex.tokens).toBeLessThanOrEqual(195);
    expect(sizes.opencode.chars).toBeLessThanOrEqual(150);
    expect(sizes.opencode.tokens).toBeLessThanOrEqual(40);
    expect(sizes.builtin.chars).toBeLessThanOrEqual(155);
    expect(sizes.builtin.tokens).toBeLessThanOrEqual(42);
    // Where it applies only in part, that part is all that's paid for.
    expect(alongsideNote("claude", { mode: "review" })!.length).toBeLessThanOrEqual(270);
  });

  test("when Claude Code and Codex get less", () => {
    const direct = { mode: "direct" as const };
    expect(alongsideNote("claude", direct)).toBe(ALONGSIDE.claude);
    expect(alongsideNote("codex", direct)).toBe(ALONGSIDE.codex);
    for (const p of ["claude", "codex"] as const) {
      expect(alongsideNote(p, direct, { ephemeral: true })).toBeNull();
      expect(alongsideNote(p, direct, { lean: true })).toBeNull();
      const review = alongsideNote(p, { mode: "review" })!;
      expect(review).toMatch(HELPER_PART);
      expect(review).not.toMatch(FULL_TEXT);
      expect(review).not.toMatch(NO_WAKE);
      expect(ALONGSIDE[p]).toContain(review);
    }
  });

  // Wherever the end of a reply hands the work on: half-done work would go to the next agent, in the same folder.
  for (const mode of ["review", "roundrobin", "relay", "lead"] as const) {
    test(`${mode}: only the part about helpers, because the end of a reply hands the work on`, () => {
      for (const p of ["claude", "codex"] as const) {
        const words = alongsideNote(p, { mode })!;
        expect(words).toMatch(HELPER_PART);
        expect(words).not.toMatch(FULL_TEXT);
        expect(words).not.toMatch(NO_WAKE);
      }
    });
  }
});

describe("Claude Code", () => {
  test("a one-agent chat: the whole text, after what it's told about its helpers", async () => {
    const words = await claudeWords({ chat: { helper: null, notes: "Other computers: a MacBook." } });
    expect(words).toBe(`Other computers: a MacBook.\n\n${helperNote("claude", null, true)}\n\n${ALONGSIDE.claude}`);
  });

  test("a group chat and an older room where only the person hears the reply: the whole text too", async () => {
    const group = await claudeWords({ chat: { helper: null, notes: null, group: true } });
    expect(group).toContain("The human decides who answers");
    expect(group).toContain(ALONGSIDE.claude);
    const room = await claudeWords({ chat: null, mode: "direct" });
    expect(room).toContain("To hand work to another agent");
    expect(room).toContain(ALONGSIDE.claude);
  });

  for (const [what, mode] of [["Build & review", "review"], ["everyone in turn", "roundrobin"]] as const) {
    test(`${what}: only the part about helpers, because the end of a reply hands the work on`, async () => {
      const words = await claudeWords({ mode, chat: { helper: null, notes: null, group: true } });
      expect(words).toMatch(HELPER_PART);
      expect(words).not.toMatch(FULL_TEXT);
      expect(words).toContain("Helper agents you start");
    });
  }

  for (const mode of ["relay", "lead"] as const) {
    test(`an older ${mode} room, where an @mention starts the next agent as a reply ends: the same`, async () => {
      const words = await claudeWords({ chat: null, mode });
      expect(words).toContain("To hand work to another agent");
      expect(words).toMatch(HELPER_PART);
      expect(words).not.toMatch(FULL_TEXT);
    });
  }

  test("a one-off question gets none of it: nobody sends it anything, and it starts nothing", async () => {
    const words = await claudeWords({ chat: { helper: null, ephemeral: true } });
    expect(words).toBe(helperNote("claude", null, false));
    expect(words).not.toMatch(FULL_TEXT);
    expect(words).not.toMatch(HELPER_PART);
  });

  test("on a small model of your own: it keeps its helpers, so the text still applies", async () => {
    const words = await claudeWords({ endpoint: endpointOf(16_384), env: { FAKE_CLAUDE_INIT_MODEL: "qwen3.8-9b" }, model: "qwen3.8-9b" });
    expect(words).toContain(ALONGSIDE.claude);
  });
});

describe("Codex", () => {
  test("a chat: the whole text with what it alone needs, in its instructions and its first message", async () => {
    const { developer, first } = await codexWords({ chat: { helper: null, notes: "Other computers: a MacBook." } });
    expect(developer).toBe(`Other computers: a MacBook.\n\n${helperNote("codex", null, true)}\n\n${ALONGSIDE.codex}\n\n${CODEX_QUESTION_NOTE}`);
    // A thread the Codex app already has loaded keeps its old instructions when resumed: the first message says it too.
    expect(first).toBe(`(Note from Crosstalk: ${developer})\n\nhello`);
    expect(first).toMatch(NO_WAKE);
  });

  test("a resumed thread hears it too, and a group chat's agent", async () => {
    const resumed = await codexWords({ session: { threadId: "th-kept" } });
    expect(resumed.opened.map((x) => x.method)).toEqual(["thread/resume"]);
    expect(resumed.opened[0].params.developerInstructions).toContain(ALONGSIDE.codex);
    expect(resumed.first).toContain(ALONGSIDE.codex);
    const group = await codexWords({ chat: { helper: null, notes: null, group: true } });
    expect(group.developer).toContain(ALONGSIDE.codex);
  });

  for (const [what, mode] of [["Build & review", "review"], ["everyone in turn", "roundrobin"]] as const) {
    test(`${what}: only the part about helpers`, async () => {
      const { developer, first } = await codexWords({ mode, chat: { helper: null, notes: null, group: true } });
      for (const words of [developer, first]) {
        expect(words).toMatch(HELPER_PART);
        expect(words).not.toMatch(FULL_TEXT);
        expect(words).not.toMatch(NO_WAKE);
      }
    });
  }

  for (const mode of ["relay", "lead"] as const) {
    test(`an older ${mode} room: the same`, async () => {
      const { developer, first } = await codexWords({ mode, chat: null });
      for (const words of [developer, first]) {
        expect(words).toMatch(HELPER_PART);
        expect(words).not.toMatch(FULL_TEXT);
        expect(words).not.toMatch(NO_WAKE);
      }
    });
  }

  test("a one-off question gets none of it", async () => {
    const { developer, first } = await codexWords({ chat: { helper: null, ephemeral: true } });
    expect(developer).toBe(helperNote("codex", null, false));
    expect(first).toBe(`(Note from Crosstalk: ${developer})\n\nhello`);
    expect(developer).not.toMatch(FULL_TEXT);
    expect(developer).not.toMatch(HELPER_PART);
  });

  describe("a lean chat doesn't grow by a word", () => {
    // Exactly what a lean thread was told before this text existed: the question note, nothing about helpers it hasn't got.
    const BEFORE = { developer: CODEX_QUESTION_NOTE, first: `(Note from Crosstalk: ${CODEX_QUESTION_NOTE})\n\nhello` };

    test("a 16k model of your own, and anything under the line", async () => {
      for (const window of [16_384, CODEX_LEAN_TOOLS_BELOW - 1]) {
        const { developer, first } = await codexWords({ endpoint: endpointOf(window) });
        expect(developer).toBe(BEFORE.developer);
        expect(first).toBe(BEFORE.first);
        expect(developer.length).toBe(CODEX_QUESTION_NOTE.length);
      }
    });

    test("resumed, or lean by the chat's own setting on a big model", async () => {
      const resumed = await codexWords({ endpoint: endpointOf(16_384), session: { threadId: "th-kept" } });
      expect(resumed.developer).toBe(BEFORE.developer);
      expect(resumed.first).toBe(BEFORE.first);
      const setting = await codexWords({ endpoint: endpointOf(272_000), config: { codexPlugins: false } });
      expect(setting.developer).toBe(BEFORE.developer);
      expect(setting.first).toBe(BEFORE.first);
    });

    test("a chat that isn't lean does get it: a big model of your own, or the chat's own setting on a small one", async () => {
      const big = await codexWords({ endpoint: endpointOf(CODEX_LEAN_TOOLS_BELOW) });
      expect(big.developer).toContain(ALONGSIDE.codex);
      const kept = await codexWords({ endpoint: endpointOf(16_384), config: { codexPlugins: true } });
      expect(kept.developer).toContain(ALONGSIDE.codex);
      expect(kept.first).toContain(ALONGSIDE.codex);
    });

    test("a Codex that refuses the lean settings is an ordinary thread, helpers and all, so it's told about them", async () => {
      const { opened, first } = await codexWords({ endpoint: endpointOf(16_384), env: { FAKE_CODEX_ODD_REFUSAL: "1" } });
      expect(opened).toHaveLength(2);
      expect(opened[0].params.developerInstructions).toBe(CODEX_QUESTION_NOTE);
      expect(opened[1].params.developerInstructions).toContain(ALONGSIDE.codex);
      // What the thread turned out to be decides the first message too.
      expect(first).toContain(ALONGSIDE.codex);
    });
  });
});

describe("the agents with no background work", () => {
  test("OpenCode gets only its line about subagents: nothing of it can go to the background", async () => {
    const cwd = folder();
    const out = join(cwd, "instructions.md");
    const script = join(cwd, "script.json");
    await Bun.write(script, JSON.stringify({ prompts: [[{ u: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } }]] }));
    const ctx = ctxOf("opencode", cwd, { env: { FAKE_OC_SCRIPT: script, FAKE_OC_INSTRUCTIONS_OUT: out }, endpoint: { id: "rl", label: "Refuseless", baseUrl: "https://api.refuseless.com", models: ["m"], contextWindow: 1_048_576, key: "abl_test" }, model: "m" });
    const d = new OpenCodeDriver(ctx, join(FIX, "fake-opencode-acp"), { browserUrl: async () => null, runDir: join(cwd, "run"), settleMs: 0 });
    cleanups.push(() => d.dispose());
    expect((await turn(d)).ok).toBe(true);
    const words = readFileSync(out, "utf8");
    expect(words).toContain(`- ${ALONGSIDE.opencode}\n`);
    expect(words).not.toMatch(FULL_TEXT);
    expect(words).not.toMatch(HELPER_PART);
    expect(words).not.toMatch(NO_WAKE);
    // What it's told about the foreground stands: the two would say opposite things.
    expect(words).toContain("Commands run in the foreground and your reply waits for them.");
  });

  test("Crosstalk's own agent gets only its line about messages between steps, on every request", async () => {
    const fake = fakeNanoGpt({ key: "sk-test", replies: [{ calls: [{ name: "run_command", args: { command: "echo hi" } }] }, { text: "Done." }] });
    cleanups.push(() => fake.stop());
    const cwd = folder();
    const ctx = ctxOf("builtin", cwd, { endpoint: { id: "nano", label: "NanoGPT", baseUrl: fake.base, models: ["m"], contextWindow: 1_048_576, key: "sk-test" }, model: "m", env: { HOME: cwd } });
    const d = new BuiltinDriver({ ...ctx, member: { ...ctx.member, permissionMode: "full" } }, { browserUrl: async () => null, runDir: join(cwd, ".run") });
    cleanups.push(() => d.dispose());
    expect((await turn(d)).ok).toBe(true);
    expect(fake.state.chats).toHaveLength(2);
    for (const chat of fake.state.chats) {
      const system = chat.messages[0].content as string;
      expect(system).toContain(`- ${ALONGSIDE.builtin}\n`);
      expect(system).not.toMatch(FULL_TEXT);
      expect(system).not.toMatch(HELPER_PART);
      expect(system).not.toMatch(/\bhelpers?\b/);
    }
  });

  test("Gemini CLI, Antigravity CLI and Muse Code are told nothing: what's sent is what was asked", async () => {
    // Gemini CLI over ACP: the scripted ACP agent, which logs what it's sent.
    const cwd = folder();
    const log = join(cwd, "log.jsonl");
    const script = join(cwd, "script.json");
    await Bun.write(log, "");
    await Bun.write(script, JSON.stringify({ prompts: [[{ u: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } }]] }));
    const gemini = new AcpDriver("gemini", ctxOf("gemini", cwd, { env: { FAKE_OC_SCRIPT: script, FAKE_OC_LOG: log } }), [join(FIX, "fake-opencode-acp")], { name: "Gemini CLI" });
    cleanups.push(() => gemini.dispose());
    expect((await turn(gemini)).ok).toBe(true);
    const prompts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.method === "session/prompt");
    expect(prompts.map((m) => m.params.prompt)).toEqual([[{ type: "text", text: "hi" }]]);

    // Antigravity CLI: the fake says back the end of the message it got; with any note in front, it would show.
    const agy = new AntigravityDriver(ctxOf("antigravity", folder(), { env: { FAKE_AGY_QUIET: "1" } }), join(FIX, "fake-agy"));
    cleanups.push(() => agy.dispose());
    expect(await turn(agy)).toEqual({ ok: true, text: "Quiet reply 1 to: hi" });

    // Muse Code: no stand-in for `muse serve` here, so a stand-in for the SDK's session, which is what gets the message.
    const sent: unknown[] = [];
    const muse = new MuseDriver(ctxOf("muse", folder()), "/nonexistent");
    Object.assign(muse, {
      client: { close: async () => {} },
      session: {
        sendUserTurn: async (o: { input: unknown }) => {
          sent.push(o.input);
          return { turnId: "t1", items: async function* () {}, deltas: async function* () {}, completed: Promise.resolve({ kind: "completed", params: { terminal: "completed" } }) };
        },
      },
    });
    expect(await turn(muse)).toEqual({ ok: true });
    expect(sent).toEqual([[{ type: "text", text: "hi" }]]);
  });
});

describe("through the hub", () => {
  /** A hub whose Claude Code and Codex are the fakes, noting what they were started with. */
  function hub() {
    const dir = folder();
    const argsFile = join(dir, "claude-args.jsonl");
    const threads = join(dir, "codex-threads");
    registerDriver("claude", (ctx) => new ClaudeDriver({ ...ctx, env: { ...ctx.env, FAKE_CLAUDE_ARGS_OUT: argsFile } }, join(FIX, "fake-claude")));
    registerDriver("codex", (ctx) => new CodexDriver({ ...ctx, env: { ...ctx.env, CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_LOG: `${threads}-${ctx.member.id}.json` } }, join(FIX, "fake-codex-app")));
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    cleanups.push(() => app.shutdown());
    const idle = async () => {
      await Bun.sleep(20);
      await app.engine.whenIdle();
      await Bun.sleep(20);
    };
    return {
      app,
      dir,
      idle,
      claude: () => {
        const runs = readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
        return runs.map((a) => a[a.indexOf("--append-system-prompt") + 1]);
      },
      codex: (memberId: string) => {
        const file = `${threads}-${memberId}.json`;
        return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).developerInstructions as string) : null;
      },
    };
  }

  test("a real chat's Claude Code and Codex get the text with the hub's own notes", async () => {
    const h = hub();
    const claude = h.app.chats.create({ provider: "claude", name: "A", cwd: join(h.dir, "a") } as never);
    h.app.engine.postHumanMessage(claude.id, "hello", "iPhone");
    await h.idle();
    const [words] = h.claude();
    expect(words).toContain("The user reads your replies in Crosstalk");
    expect(words).toContain(ALONGSIDE.claude);
    const codex = h.app.chats.create({ provider: "codex", name: "B", cwd: join(h.dir, "b") } as never);
    h.app.engine.postHumanMessage(codex.id, "hello", "iPhone");
    await h.idle();
    const developer = h.codex(h.app.store.listMembers(codex.id)[0].id)!;
    expect(developer).toContain("The user reads your replies in Crosstalk");
    expect(developer).toContain(ALONGSIDE.codex);
  });

  test("with Keep going while helpers work off, the words are the same: nothing in them says how soon a message arrives", async () => {
    const h = hub();
    h.app.setHubSettings({ messagesFlow: false });
    const claude = h.app.chats.create({ provider: "claude", name: "A", cwd: join(h.dir, "a") } as never);
    h.app.engine.postHumanMessage(claude.id, "hello", "iPhone");
    await h.idle();
    expect(h.claude()[0]).toContain(ALONGSIDE.claude);
    const codex = h.app.chats.create({ provider: "codex", name: "B", cwd: join(h.dir, "b") } as never);
    h.app.engine.postHumanMessage(codex.id, "hello", "iPhone");
    await h.idle();
    expect(h.codex(h.app.store.listMembers(codex.id)[0].id)).toContain(ALONGSIDE.codex);
  });

  test("a group chat gets it as it answers, and Build & review only what a loop can take", async () => {
    const h = hub();
    const group = h.app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: join(h.dir, "group") });
    h.app.engine.postHumanMessage(group.id, "@claude hello", "iPhone");
    await h.idle();
    expect(h.claude()[0]).toContain(ALONGSIDE.claude);

    const loop = h.app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: join(h.dir, "loop") });
    h.app.updateRoom(loop.id, { mode: "review" });
    h.app.engine.postHumanMessage(loop.id, "Build it", "iPhone");
    await h.idle();
    const builder = h.claude().at(-1)!;
    expect(builder).toMatch(HELPER_PART);
    expect(builder).not.toMatch(FULL_TEXT);
    // The reviewer's turn came from the loop, when the builder's reply ended.
    const reviewer = h.app.store.listMembers(loop.id).find((m) => m.provider === "codex")!;
    const review = h.codex(reviewer.id)!;
    expect(review).toMatch(HELPER_PART);
    expect(review).not.toMatch(FULL_TEXT);
    expect(review).not.toMatch(NO_WAKE);

    // Everyone in turn: the next agent starts from what this one said.
    const turns = h.app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: join(h.dir, "turns"), answers: "turns" });
    h.app.engine.postHumanMessage(turns.id, "Look at this", "iPhone");
    await h.idle();
    const first = h.claude().at(-1)!;
    expect(first).toMatch(HELPER_PART);
    expect(first).not.toMatch(FULL_TEXT);
    const next = h.codex(h.app.store.listMembers(turns.id).find((m) => m.provider === "codex")!.id)!;
    expect(next).toMatch(HELPER_PART);
    expect(next).not.toMatch(FULL_TEXT);
  });

  test("each briefing where a reply hands the work on says to let helpers finish first, and only those", () => {
    const h = hub();
    const room = h.app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: join(h.dir, "briefed") });
    const members = h.app.store.listMembers(room.id);
    const [first, second] = members;
    const LET_THEM_FINISH = "let your helpers and background jobs finish first";
    // Off: the reply goes to the person alone.
    expect(buildSystemNote(room, members, first)).not.toContain(LET_THEM_FINISH);
    const inTurn = { ...room, mode: "roundrobin" as const };
    for (const me of [first, second]) expect(buildSystemNote(inTurn, members, me)).toContain(`Your reply is what starts the next agent, so ${LET_THEM_FINISH}.`);
    // A room from before group chats that takes turns.
    const older = { ...inTurn, chat: undefined };
    expect(buildSystemNote(older, members, first)).toContain(`Your reply is what starts the next agent, so ${LET_THEM_FINISH}.`);
    for (const mode of ["relay", "lead"] as const) expect(buildSystemNote({ ...room, mode, chat: undefined }, members, first)).toContain(`An @mention hands your work on as your reply ends, so ${LET_THEM_FINISH}.`);
    // Each mode's own hash: a process started before the change hears it in its next briefing.
    expect(rosterHash(inTurn, members)).not.toBe(rosterHash(room, members));
  });

  test("Build & review's builder is told to let its helpers finish, and hears it when a chat becomes a loop", () => {
    const h = hub();
    const room = h.app.chats.createGroup({ members: [{ provider: "claude" }, { provider: "codex" }], cwd: join(h.dir, "turned") });
    const members = h.app.store.listMembers(room.id);
    const [builder, reviewer] = members;
    const LINE = "Your reply is what sends the work to review, so let your helpers and background jobs finish first.";
    expect(buildSystemNote(room, members, builder)).not.toContain(LINE);
    const was = rosterHash(room, members);
    const loop = h.app.updateRoom(room.id, { mode: "review" });
    // A process started before the change still holds the whole text, and it's the next briefing that reaches it.
    expect(rosterHash(loop, members)).not.toBe(was);
    expect(buildSystemNote(loop, members, builder)).toContain(LINE);
    expect(buildSystemNote(loop, members, reviewer)).not.toContain(LINE);
  });
});
