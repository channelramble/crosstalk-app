import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, Member, ModelOption, Room } from "@crosstalk/shared";
import type { ActivityInput, AgentDriver, ApprovalRequest, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver, CODEX_QUESTION_NOTE, rerouteError, hideSpawnOverridesAgain, takesHelperSettings } from "../src/agents/codex";
import { baseModel, codeOnly, effortRefusal, helperNote, modelName, pickModel, sameModel, setsEffort, shellCommand, userNamed } from "../src/agents/model-lock";
import { alongsideNote } from "../src/agents/alongside";
import { registerDriver } from "../src/agents";
import { App } from "../src/app";

const FIX = join(import.meta.dir, "fixtures");
const MAIN = join(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function ctx(provider: Member["provider"], session: Record<string, unknown> = {}, patch: Partial<Member> = {}): DriverContext {
  const dir = mkdtempSync(join(tmpdir(), "ct-lock-"));
  dirs.push(dir);
  const room: Room = { id: "r1", name: "Room", cwd: dir, mode: "relay", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
  const member: Member = { id: "m1", roomId: "r1", handle: provider, provider, model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0, ...patch };
  // A Codex home of its own: a chat connects to the Codex app's server when one is running, and tests must never.
  const env = { PATH: process.env.PATH ?? "", CODEX_HOME: join(dir, "codex-home") };
  return { room, member, session, mcp: { command: "true", args: [], env: { CROSSTALK_MEMBER_ID: "m1" } }, env, bin: "", chat: { helper: null, notes: null } };
}

function sink() {
  const abort = new AbortController();
  const rec = { text: "", activities: [] as ActivityInput[], session: {} as Record<string, unknown> };
  const s: TurnSink = {
    signal: abort.signal,
    text: (d) => (rec.text += d),
    setText: (t) => (rec.text = t),
    activity: (a) => (rec.activities.push(a), `a${rec.activities.length}`),
    updateActivity: (id, patch) => {
      const activity = rec.activities[Number(id.slice(1)) - 1];
      if (activity) Object.assign(activity, patch, patch.appendDetail ? { detail: (activity.detail ?? "") + patch.appendDetail } : {});
    },
    approval: async () => "approve" as ApprovalDecision,
    usage: () => {},
    rateLimit: () => {},
    status: () => {},
    saveSession: (p) => Object.assign(rec.session, p),
  };
  return { sink: s, rec, abort };
}

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const turn = (d: AgentDriver, prompt: string, s: TurnSink) => d.runTurn({ turnId: `t-${prompt}`, prompt, systemNote: null }, s);

describe("model names", () => {
  test("ids compare without the context-window suffix and read the way people say them", () => {
    expect(baseModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(sameModel("claude-opus-5-5[1m]", "Claude-Opus-5-5")).toBe(true);
    expect(sameModel("claude-opus-5-5", "claude-opus-4-8")).toBe(false);
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelName("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  const catalog: Pick<ModelOption, "id" | "label">[] = [
    { id: "opus", label: "Opus 5.5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "sonnet", label: "Sonnet 5.5" },
    { id: "haiku", label: "Haiku 4.5" },
    { id: "fable", label: "Fable 5.1" },
  ];
  const by = (id: string) => catalog.find((m) => m.id === id)!;

  test("the model someone names is found by id, name or the start of its name", () => {
    expect(pickModel(catalog, "sonnet")?.id).toBe("sonnet");
    expect(pickModel(catalog, "Haiku 4.5")?.id).toBe("haiku");
    expect(pickModel(catalog, "claude-opus-4-8")?.id).toBe("claude-opus-4-8");
    expect(pickModel(catalog, "opus 4.8")?.id).toBe("claude-opus-4-8");
    expect(pickModel(catalog, "Opus")?.id).toBe("opus");
    expect(pickModel(catalog, "Claude Fable")?.id).toBe("fable");
    expect(pickModel(catalog, "gpt-6")).toBeNull();
    expect(pickModel(catalog, "  ")).toBeNull();
  });

  test("the user's own words have to name the model (and its version, within the chat's own family)", () => {
    const chat = by("opus");
    expect(userNamed("use sonnet for the helpers please", by("sonnet"), chat)).toBe(true);
    expect(userNamed("Use a cheaper model for the subagents", by("sonnet"), chat)).toBe(false);
    expect(userNamed("put the helpers on haiku", by("sonnet"), chat)).toBe(false);
    // "opus" in an Opus 5.5 chat doesn't say Opus 4.8.
    expect(userNamed("use opus for the helpers", by("claude-opus-4-8"), chat)).toBe(false);
    expect(userNamed("run helpers on Opus 4.8", by("claude-opus-4-8"), chat)).toBe(true);
    expect(userNamed("helpers on opus 4-8", by("claude-opus-4-8"), chat)).toBe(false);
    expect(userNamed("sonnets are poems", by("sonnet"), chat)).toBe(false);
    expect(userNamed("Fable, please", by("fable"), null)).toBe(false);
    // Codex models go by their whole name, not a family word.
    const sol = { id: "gpt-6.1-sol", label: "gpt-6.1-sol" };
    const luna = { id: "gpt-6-luna", label: "gpt-6-luna" };
    expect(userNamed("use gpt-6.1-sol for the helpers", sol, luna)).toBe(true);
    expect(userNamed("use gpt for the helpers", sol, luna)).toBe(false);
    for (const text of ["Do NOT put helpers on haiku", "Would haiku be good enough for helpers?", "write a haiku about the release", "> use haiku for helpers", "`use haiku for helpers`", "use haiku for helpers?"]) expect(userNamed(text, by("haiku"), chat)).toBe(false);
  });
});

describe("workflow scripts that set their agents' effort", () => {
  test("only code counts: options, shorthand and assignments, not words in prompts or comments", () => {
    expect(setsEffort(`await agent("Check it", { label: "x", effort: "low" })`)).toBe(true);
    expect(setsEffort(`agent(p, {effort:'medium'})`)).toBe(true);
    expect(setsEffort(`agent(p, {"effort": "low"})`)).toBe(true);
    expect(setsEffort(`opts["effort"] = "low"; agent(p, opts)`)).toBe(true);
    expect(setsEffort(`const effort = "low"; agent(p, { label, effort })`)).toBe(true);
    expect(setsEffort(`const o = {}; o.effort = "low"; agent(p, o)`)).toBe(true);
    expect(setsEffort(`export const meta = { name: "a", phases: [{ title: "Scan", effort: "low" }] }`)).toBe(true);
    expect(setsEffort("agent(`Review ${files.map((f) => ({ effort: 'low', f }))}`)")).toBe(true);
    expect(setsEffort(`agent("Rate the effort: low or high", { label: "x" })`)).toBe(false);
    expect(setsEffort("agent(`What effort: ${level} means`)")).toBe(false);
    expect(setsEffort(`// effort: 'low' would be cheaper\nagent("x")`)).toBe(false);
    expect(setsEffort(`/* { effort: "low" } */ agent("x", { model: "haiku" })`)).toBe(false);
    expect(setsEffort(`if (r.effort == "low") log("x")`)).toBe(false);
    expect(setsEffort(`agent(p, { schema: { properties: { effort: { type: "string" } } } })`)).toBe(false);
    expect(setsEffort(`const { effort } = args; agent(p)`)).toBe(false);
    expect(codeOnly(`a("x{y}", 'z') + \`t\${b}u\``)).toBe(`a("", '') + \`\${b}\`\`\``);
  });

  async function hook(input: unknown, env: Record<string, string> = {}) {
    const proc = Bun.spawn(["bun", MAIN, "hook", "workflow"], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    const code = await proc.exited;
    return { code, stderr: await new Response(proc.stderr).text() };
  }

  test("Claude Code's hook refuses such a script (exit 2, with what to do) and lets others run", async () => {
    const bad = await hook({ tool_name: "Workflow", tool_input: { script: `agent("x", { effort: "low" })` } }, { CROSSTALK_EFFORT: "max" });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe(effortRefusal("max"));
    expect(bad.stderr).toContain("(max)");
    const ok = await hook({ tool_name: "Workflow", tool_input: { script: `agent("Pick an effort: low or high")` } });
    expect(ok.code).toBe(0);
    // A script kept in a file, relative to the session's folder.
    const dir = mkdtempSync(join(tmpdir(), "ct-hook-"));
    dirs.push(dir);
    writeFileSync(join(dir, "wf.js"), `export const meta = { name: "a", description: "b" }\nawait agent("x", { effort: "low" })`);
    expect((await hook({ cwd: dir, tool_input: { scriptPath: "wf.js" } })).code).toBe(2);
    // Anything it can't read is left to Claude Code.
    expect((await hook({ cwd: dir, tool_input: { scriptPath: "missing.js" } })).code).toBe(0);
    expect((await hook("not json")).code).toBe(0);
  });

  test("saved workflows and agent or skill definitions cannot override helper settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-hook-defs-"));
    dirs.push(dir);
    for (const path of ["workflows", "agents", "skills/quick"]) mkdirSync(join(dir, ".claude", path), { recursive: true });
    writeFileSync(join(dir, ".claude/workflows/nightly.js"), `await agent("x", {"effort": "low"})`);
    writeFileSync(join(dir, ".claude/agents/quick.md"), "---\neffort: low\n---\nCheck tests");
    writeFileSync(join(dir, ".claude/skills/quick/SKILL.md"), "---\nmodel: haiku\n---\nSummarize");
    expect((await hook({ cwd: dir, tool_name: "Workflow", tool_input: { name: "nightly" } })).code).toBe(2);
    expect((await hook({ cwd: dir, tool_name: "Workflow", tool_input: { name: "missing-workflow" } })).code).toBe(2);
    expect((await hook({ cwd: dir, tool_name: "Agent", tool_input: { subagent_type: "quick" } })).code).toBe(2);
    expect((await hook({ cwd: dir, tool_name: "Skill", tool_input: { skill: "quick" } })).code).toBe(2);
    expect((await hook({ cwd: dir, tool_name: "Workflow", tool_input: { script: `await agent("x", args.opts)`, args: { opts: { effort: "low" } } } })).code).toBe(2);
    expect((await hook({ cwd: dir, tool_name: "Workflow", tool_input: { script: `await agent("x", {agentType: "quick"})` } })).code).toBe(2);
  });

  test("the hook's command line survives spaces in the hub's path", () => {
    expect(shellCommand(["/Applications/Cross Talk/hub", "hook", "workflow"])).toBe("'/Applications/Cross Talk/hub' hook workflow");
    expect(shellCommand(["/usr/local/bin/crosstalk-hub", "hook", "workflow"])).toBe("/usr/local/bin/crosstalk-hub hook workflow");
    expect(shellCommand(["it's"])).toBe(`'it'\\''s'`);
  });
});

describe("Claude Code keeps the chat's model", () => {
  function claude(c: DriverContext) {
    const args = join(c.room.cwd, "args.jsonl");
    const env = join(c.room.cwd, "env.jsonl");
    c.env.FAKE_CLAUDE_INTERRUPT_LOG = join(c.room.cwd, "interrupts.jsonl");
    c.env.FAKE_CLAUDE_ARGS_OUT = args;
    c.env.FAKE_CLAUDE_ENV_OUT = env;
    return { d: new ClaudeDriver(c, join(FIX, "fake-claude")), args: () => lines(args), env: () => lines(env) };
  }

  test("model swaps are off, helpers are held to the chat's model, and workflows go through the effort check", async () => {
    const c = ctx("claude", {}, { config: { effort: "max" } });
    c.mcp.hook = ["/opt/crosstalk-hub", "hook"];
    const { d, args, env } = claude(c);
    expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
    const lock = { CLAUDE_CODE_NO_MODEL_FALLBACK: "1", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "inherit", CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: "1" };
    expect(env()[0]).toMatchObject({ ...lock, CROSSTALK_EFFORT: "max" });
    const a = args()[0] as string[];
    // A file only this user can read, not the command line (`ps` shows that).
    const settings = JSON.parse(readFileSync(a[a.indexOf("--settings") + 1], "utf8"));
    // In the settings too, so a project's own Claude Code settings can't undo them.
    expect(settings.env).toEqual(lock);
    expect(settings.hooks).toEqual({ PreToolUse: [{ matcher: "Workflow|Agent|Task|Skill", hooks: [{ type: "command", command: "/opt/crosstalk-hub hook workflow", timeout: 30 }] }] });
    expect(a[a.indexOf("--effort") + 1]).toBe("max");
    expect(a[a.indexOf("--allowedTools") + 1].split(",")).toContain("mcp__crosstalk__use_helper_model");
    expect(a[a.indexOf("--append-system-prompt") + 1]).toContain("call use_helper_model");
    await d.dispose();
  });

  test("a model picked for helpers is the one they're held to", async () => {
    const c = ctx("claude", {}, { config: { helperModel: "claude-sonnet-5-5" } });
    const { d, env, args } = claude(c);
    await turn(d, "hello", sink().sink);
    expect(env()[0].CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-sonnet-5-5");
    expect(args()[0][args()[0].indexOf("--append-system-prompt") + 1]).toContain("run on Sonnet 5.5 (the user picked it for helpers)");
    // A helper on that model is fine.
    const ok = sink();
    expect((await turn(d, "HELPER:claude-sonnet-5-5", ok.sink)).ok).toBe(true);
    await d.dispose();
  });

  test('"Default" stays the model it was when the chat started; a model picked in the menu wins', async () => {
    const first = ctx("claude");
    const one = claude(first);
    const s1 = sink();
    await turn(one.d, "hello", s1.sink);
    expect(one.args()[0]).toContain("--model");
    expect(one.args()[0]).toContain("default");
    expect(s1.rec.session.model).toBe("claude-test");
    await one.d.dispose();

    // A later process for the same chat asks for that model by name, even if the default has moved on since.
    const again = ctx("claude", { sessionId: "s1", model: "claude-test" });
    const two = claude(again);
    await turn(two.d, "hello", sink().sink);
    expect(two.args()[0]).toContain("claude-test");
    await two.d.dispose();

    const picked = ctx("claude", { model: "claude-test" }, { model: "claude-fable-5-1" });
    const three = claude(picked);
    const s3 = sink();
    await turn(three.d, "hello", s3.sink);
    const a = three.args()[0] as string[];
    expect(a[a.indexOf("--model") + 1]).toBe("claude-fable-5-1");
    expect(s3.rec.session.model).toBe("claude-fable-5-1");
    await three.d.dispose();
  });

  test("a reply that comes back on another model is stopped, and says so", async () => {
    const c = ctx("claude");
    c.env.FAKE_CLAUDE_INIT_MODEL = "claude-opus-5-5[1m]";
    const { d } = claude(c);
    // The same model without its context-window suffix is the same model.
    expect((await turn(d, "MODEL:claude-opus-5-5", sink().sink)).ok).toBe(true);
    const r = await turn(d, "MODEL:claude-opus-4-8", sink().sink);
    expect(r).toEqual({ ok: false, error: "Claude Code switched this reply from Opus 5.5 to Opus 4.8 on its own, so Crosstalk stopped it. The chat stays on Opus 5.5: tap Try again, or pick another model." });
    expect(lines(join(c.room.cwd, "interrupts.jsonl"))[0].request.subtype).toBe("interrupt");
    // The next message starts a fresh process, still pinned to the selected model.
    expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
    await d.dispose();
  });

  test("a helper agent on another model stops the reply too", async () => {
    const c = ctx("claude");
    c.env.FAKE_CLAUDE_INIT_MODEL = "claude-opus-5-5";
    const { d } = claude(c);
    const r = await turn(d, "HELPER:claude-haiku-4-5-20251001", sink().sink);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("A helper agent started on Haiku 4.5 instead of Opus 5.5, so Crosstalk stopped this reply. Helpers keep the chat's model unless you pick one for them in the model menu.");
    expect((await turn(d, "HELPER:claude-opus-5-5", sink().sink)).ok).toBe(true);
    await d.dispose();
  });

  test("later init events cannot reset the selected model, and refusal fallback is interrupted", async () => {
    const c = ctx("claude");
    c.env.FAKE_CLAUDE_INIT_MODEL = "claude-opus-5-5";
    const { d, args } = claude(c);
    try {
      expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
      // Claude Code says mid-process that it's on another model: that process ends before the model answers, and the
      // reply stops in plain words (model-keep.test.ts). The next message starts a fresh one on the chat's model.
      expect((await turn(d, "INIT:claude-opus-4-8", sink().sink)).error).toBe("Claude Code moved to Opus 4.8 instead of Opus 5.5, this chat's model, so Crosstalk stopped it. Your next message starts it again on Opus 5.5.");
      expect(args().length).toBe(1);
      expect((await turn(d, "FALLBACK", sink().sink)).error).toContain("Opus 4.8");
      expect(args().length).toBe(2);
      expect((args()[1] as string[])[(args()[1] as string[]).indexOf("--model") + 1]).toBe("claude-opus-5-5");
      // Only the fallback was interrupted: the process on the other model was ended outright.
      expect(lines(join(c.room.cwd, "interrupts.jsonl"))).toHaveLength(1);
    } finally { await d.dispose(); }
  });

  test("helper aliases still reject a different model family", async () => {
    const c = ctx("claude", {}, { config: { helperModel: "sonnet" } });
    c.env.FAKE_CLAUDE_INIT_MODEL = "claude-opus-5-5";
    const { d } = claude(c);
    try {
      expect((await turn(d, "HELPER:claude-haiku-4-5-20251001", sink().sink)).ok).toBe(false);
      expect((await turn(d, "HELPER:claude-sonnet-5-5", sink().sink)).ok).toBe(true);
    } finally { await d.dispose(); }
  });

  test("an explicit alias is saved as a concrete model and survives a new driver", async () => {
    const c = ctx("claude", {}, { model: "opus" });
    c.env.FAKE_CLAUDE_INIT_MODEL = "claude-opus-5-5";
    const first = claude(c);
    const state = sink();
    await turn(first.d, "hello", state.sink);
    await first.d.dispose();
    expect(state.rec.session).toMatchObject({ model: "claude-opus-5-5", modelRequested: "opus" });
    const again = ctx("claude", state.rec.session, { model: "opus" });
    const next = claude(again);
    try {
      expect((await turn(next.d, "hello", sink().sink)).ok).toBe(true);
      expect(next.args()[0]).toContain("claude-opus-5-5");
    } finally { await next.d.dispose(); }
  });

  test("a chat on a model Claude Code doesn't list (an API key's More models) runs on it like any other: its effort, helpers held to it, no switching", async () => {
    const c = ctx("claude", {}, { model: "claude-opus-4-8", config: { effort: "xhigh" } });
    const { d, args, env } = claude(c);
    const state = sink();
    try {
      expect((await turn(d, "hello", state.sink)).ok).toBe(true);
      const a = args()[0] as string[];
      // Started on it by name (Claude Code takes --model as given), at the chat's effort.
      expect(a[a.indexOf("--model") + 1]).toBe("claude-opus-4-8");
      expect(a[a.indexOf("--effort") + 1]).toBe("xhigh");
      expect(env()[0]).toMatchObject({ CLAUDE_CODE_NO_MODEL_FALLBACK: "1", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "inherit", CROSSTALK_EFFORT: "xhigh" });
      expect(state.rec.session.model).toBe("claude-opus-4-8");
      // A helper on it is fine; one on another model, or a reply that moves to another model, is stopped.
      expect((await turn(d, "HELPER:claude-opus-4-8", sink().sink)).ok).toBe(true);
      expect((await turn(d, "HELPER:claude-opus-5-5", sink().sink)).error).toBe("A helper agent started on Opus 5.5 instead of Opus 4.8, so Crosstalk stopped this reply. Helpers keep the chat's model unless you pick one for them in the model menu.");
      expect((await turn(d, "MODEL:claude-sonnet-4-6", sink().sink)).error).toContain("switched this reply from Opus 4.8 to Sonnet 4.6");
    } finally { await d.dispose(); }
  });

  test("on a model server of your own, model names aren't compared", async () => {
    const c = { ...ctx("claude"), endpoint: { id: "ep1", label: "Qwen local", baseUrl: "http://127.0.0.1:8080", models: ["qwen"], contextWindow: 65536, key: "" } };
    const { d } = claude(c);
    expect((await turn(d, "MODEL:whatever-the-server-says", sink().sink)).ok).toBe(true);
    await d.dispose();
  });

  test("a reply the safety filter stops ends with that, not with another model's answer", async () => {
    const c = ctx("claude");
    c.env.FAKE_CLAUDE_INIT_MODEL = "claude-opus-5-5";
    const { d } = claude(c);
    const r = await turn(d, "REFUSE", sink().sink);
    expect(r).toEqual({ ok: false, error: "Opus 5.5's safety filter stopped this reply. Crosstalk doesn't let another model answer in its place, so nothing else ran: rephrase the request, or pick another model for this chat." });
    await d.dispose();
  });

  test("fast mode that's on but not running is pointed out once", async () => {
    const c = ctx("claude", {}, { config: { fast: true } });
    const { d } = claude(c);
    const s = sink();
    await turn(d, "SPEED", s.sink);
    await turn(d, "SPEED", s.sink);
    expect(s.rec.activities.filter((a) => a.title === "Fast mode isn't running")).toHaveLength(1);
    await d.dispose();
    const off = claude(ctx("claude"));
    const s2 = sink();
    await turn(off.d, "SPEED", s2.sink);
    expect(s2.rec.activities.some((a) => a.title === "Fast mode isn't running")).toBe(false);
    await off.d.dispose();
  });
});

describe("Codex keeps the chat's model", () => {
  function codex(c: DriverContext) {
    const log = join(c.room.cwd, "thread.json");
    c.env.FAKE_CODEX_RPC_LOG = join(c.room.cwd, "rpc.jsonl");
    c.env.FAKE_CODEX_LOG = log;
    return { d: new CodexDriver(c, join(FIX, "fake-codex-app")), thread: () => JSON.parse(readFileSync(log, "utf8")) };
  }

  test("MCP tool results and tool errors remain visible in the work details", async () => {
    const { d } = codex(ctx("codex"));
    const state = sink();
    try {
      expect((await turn(d, "MCP_RESULT", state.sink)).ok).toBe(true);
      const activity = state.rec.activities.find((a) => a.detail?.includes("Tool returned useful context"));
      expect(activity).toBeDefined();
      expect(activity?.status).toBe("error");
      expect(activity!.detail!.length).toBeLessThan(20200);
    } finally { await d.dispose(); }
  });

  test("helpers aren't offered other models, their roles hold them to the chat's model and effort, and the agent is told", async () => {
    const { d, thread } = codex(ctx("codex", {}, { config: { effort: "high" } }));
    expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
    // Under features, where Codex reads it (a top-level multi_agent_v2 is ignored): its spawn tool then offers no model
    // or effort, and a helper inherits the chat's.
    expect(thread().config.features.multi_agent_v2).toEqual({ expose_spawn_agent_model_overrides: false });
    expect(thread().config.features.default_mode_request_user_input).toBe(true);
    expect(thread().config.multi_agent_v2).toBeUndefined();
    // No model picked for helpers: nothing pins them, so they follow the chat's effort turn by turn.
    expect(thread().config.agents.default_subagent_model).toBeUndefined();
    expect(thread().config.agents.default_subagent_reasoning_effort).toBeUndefined();
    // With what it's told about the person working alongside its helpers (alongside.ts: this room's a relay room, so the
    // part about helpers), and the note that questions go through Codex's question tools (cards in the chat), not into its
    // message.
    expect(thread().developerInstructions).toBe(`${helperNote("codex", null, true)}\n\n${alongsideNote("codex", { mode: "relay" })}\n\n${CODEX_QUESTION_NOTE}`);
    // Codex's helper roles are replaced by ones that set model and effort (a role that sets them can't be changed).
    const roles = thread().config.agents as Record<string, { description: string; config_file: string }>;
    expect(Object.keys(roles).sort()).toEqual(["awaiter", "default", "explorer", "worker"]);
    expect(roles.default.description).toBe("Default agent.");
    expect(statSync(roles.default.config_file).mode & 0o777).toBe(0o600);
    // Once the thread says which model "Default" means, the roles name it too.
    expect(readFileSync(roles.default.config_file, "utf8")).toBe('model = "gpt-test"\nmodel_reasoning_effort = "high"\n');
    expect(readFileSync(roles.awaiter.config_file, "utf8")).toContain('model_reasoning_effort = "high"');
    expect(readFileSync(roles.awaiter.config_file, "utf8")).toContain("You are an awaiter.");
    // The helper-model tool is there even without teamwork or other chats.
    expect(thread().config.mcp_servers.crosstalk.env).toMatchObject({ CROSSTALK_TOOLSET: "chat", CROSSTALK_HELPER_MODEL: "1" });
    await d.dispose();
    expect(existsSync(roles.default.config_file)).toBe(false);
  });

  test("letting a driver go deletes its role files at once, so a replacement's (same names) are never deleted under it", async () => {
    const c = ctx("codex", {}, { config: { effort: "high" } });
    const first = codex(c);
    expect((await turn(first.d, "hello", sink().sink)).ok).toBe(true);
    const roles = first.thread().config.agents as Record<string, { config_file: string }>;
    const ending = first.d.dispose();
    expect(existsSync(roles.default.config_file)).toBe(false); // before its app-server is waited for
    const second = codex(c);
    expect((await turn(second.d, "hello", sink().sink)).ok).toBe(true);
    await ending;
    expect(readFileSync(roles.default.config_file, "utf8")).toContain('model_reasoning_effort = "high"'); // the replacement's
    await second.d.dispose();
  });

  test("a model picked for helpers is the one their roles name, and a helper on it is fine", async () => {
    const c = ctx("codex", {}, { config: { effort: "high", helperModel: "gpt-mini" } });
    const { d, thread } = codex(c);
    expect((await turn(d, "SPAWN:gpt-mini:high", sink().sink)).ok).toBe(true);
    const roles = thread().config.agents as Record<string, { config_file: string }>;
    expect(readFileSync(roles.worker.config_file, "utf8")).toBe('model = "gpt-mini"\nmodel_reasoning_effort = "high"\n');
    expect(thread().developerInstructions).toContain("run on gpt-mini (the user picked it for helpers)");
    // Not the chat's own model, then.
    const r = await turn(d, "SPAWN:gpt-test:high", sink().sink);
    expect(r.error).toContain("on gpt-test instead of gpt-mini");
    await d.dispose();
  });

  test("a one-off question gets neither the roles nor the helper-model tool", async () => {
    const c = ctx("codex");
    c.chat = { helper: null, notes: null, ephemeral: true };
    const { d, thread } = codex(c);
    expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
    expect(thread().config.agents).toBeUndefined();
    expect(thread().config.mcp_servers).toBeUndefined();
    await d.dispose();
  });

  test("a reply OpenAI moves to another model is stopped", async () => {
    const c = ctx("codex");
    const { d } = codex(c);
    const r = await turn(d, "REROUTE", sink().sink);
    expect(r).toEqual({ ok: false, error: rerouteError({ fromModel: "gpt-test", toModel: "gpt-small", reason: "highRiskCyberActivity" }, false, true) });
    await Bun.sleep(20);
    expect(lines(join(c.room.cwd, "rpc.jsonl")).some((x) => x.method === "turn/interrupt" && x.params.turnId.startsWith("tu-"))).toBe(true);
    expect(r.error).toBe("OpenAI moved this reply from gpt-test to gpt-small (high risk cyber activity), so Crosstalk stopped it. The chat stays on gpt-test: tap Try again, or pick another model.");
    await d.dispose();
  });

  test("on Ultra, a helper that inherits Ultra carries on; one Codex started at Extra high still stops the reply", async () => {
    const c = ctx("codex", {}, { config: { effort: "ultra" } });
    c.env.FAKE_CODEX_HELPER_EFFORT = "ultra";
    const { d, thread } = codex(c);
    try {
      expect((await turn(d, "SPAWN:gpt-test:ultra", sink().sink)).ok).toBe(true);
      expect(readFileSync((thread().config.agents as Record<string, { config_file: string }>).default.config_file, "utf8")).toContain('model_reasoning_effort = "ultra"');
      expect((await turn(d, "SPAWN:gpt-test:xhigh", sink().sink)).error).toContain("at xhigh effort instead of ultra");
    } finally { await d.dispose(); }
  });

  test("a spawn reported at medium as it starts (Codex's default when none is named) doesn't stop a chat on high: the helper got high", async () => {
    const c = ctx("codex", {}, { config: { effort: "high" } });
    c.env.FAKE_CODEX_SPAWN_DONE_EFFORT = "high";
    const { d } = codex(c);
    try {
      expect((await turn(d, "SPAWN::medium", sink().sink)).ok).toBe(true);
    } finally { await d.dispose(); }
  });

  test("a new effort for the chat goes to its helpers' roles from the next turn", async () => {
    const c = ctx("codex", {}, { config: { effort: "high" } });
    const { d, thread } = codex(c);
    try {
      expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
      const file = (thread().config.agents as Record<string, { config_file: string }>).default.config_file;
      expect(readFileSync(file, "utf8")).toContain('model_reasoning_effort = "high"');
      c.member.config = { ...c.member.config, effort: "max" };
      expect((await turn(d, "again", sink().sink)).ok).toBe(true);
      expect(readFileSync(file, "utf8")).toContain('model_reasoning_effort = "max"');
    } finally { await d.dispose(); }
  });

  test("with a model picked for helpers, every helper starts on it at the chat's effort, copies of the conversation too", async () => {
    const c = ctx("codex", {}, { config: { effort: "high", helperModel: "gpt-mini" } });
    const { d, thread } = codex(c);
    try {
      expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
      expect(thread().config.agents).toMatchObject({ default_subagent_model: "gpt-mini", default_subagent_reasoning_effort: "high" });
      expect(readFileSync((thread().config.agents as Record<string, { config_file: string }>).default.config_file, "utf8")).toBe('model = "gpt-mini"\nmodel_reasoning_effort = "high"\n');
    } finally { await d.dispose(); }
  });

  test("with a model picked for helpers and the chat on Default, helpers start at the chat model's default effort, also after a model change", async () => {
    // A new chat on Codex's default model: its default effort (the fake Codex lists gpt-test at medium), not gpt-mini's.
    const c = ctx("codex", {}, { config: { helperModel: "gpt-mini" } });
    const { d, thread } = codex(c);
    try {
      expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
      expect(thread().config.agents).toMatchObject({ default_subagent_model: "gpt-mini", default_subagent_reasoning_effort: "medium" });
    } finally { await d.dispose(); }
    // Moved to another model in the menu: the session keeps the old model's effort but not the model, so that effort is
    // the old model's and the new one's default counts.
    const moved = ctx("codex", { effort: "xhigh" }, { model: "gpt-test", config: { helperModel: "gpt-mini" } });
    const again = codex(moved);
    try {
      expect((await turn(again.d, "hello", sink().sink)).ok).toBe(true);
      expect(again.thread().config.agents).toMatchObject({ default_subagent_reasoning_effort: "medium" });
    } finally { await again.d.dispose(); }
    // Still on the model Codex last named: the effort it said the thread runs at.
    const same = ctx("codex", { effort: "xhigh", model: "gpt-test" }, { model: "gpt-test", config: { helperModel: "gpt-mini" } });
    const third = codex(same);
    try {
      expect((await turn(third.d, "hello", sink().sink)).ok).toBe(true);
      expect(third.thread().config.agents).toMatchObject({ default_subagent_reasoning_effort: "xhigh" });
    } finally { await third.d.dispose(); }
  });

  test("a chat on a model Codex keeps out of its picker (More models): its default effort is found like any other's, helpers included", async () => {
    // On Default, the thread names no effort, so the model's own default is looked up: Codex lists the hidden one only
    // when asked with includeHidden (its default, low, isn't gpt-test's).
    const c = ctx("codex", {}, { model: "gpt-test-reserve", config: { helperModel: "gpt-mini" } });
    c.env.FAKE_CODEX_HIDDEN_MODELS = "1";
    c.env.FAKE_CODEX_MODEL = "gpt-test-reserve";
    const { d, thread } = codex(c);
    const state = sink();
    try {
      expect((await turn(d, "hello", state.sink)).ok).toBe(true);
      expect(thread().config.agents).toMatchObject({ default_subagent_model: "gpt-mini", default_subagent_reasoning_effort: "low" });
      expect(state.rec.session).toMatchObject({ model: "gpt-test-reserve", effort: "low" });
      expect(lines(join(c.room.cwd, "rpc.jsonl")).filter((x) => x.method === "model/list").map((x) => x.params)).toEqual([{ includeHidden: true }, { includeHidden: true }]);
    } finally { await d.dispose(); }
    // A Codex that refuses includeHidden is asked for its usual list, and a chat on one of those goes on as before.
    const older = ctx("codex", {}, { config: { helperModel: "gpt-mini" } });
    older.env.FAKE_CODEX_REFUSE_HIDDEN = "1";
    const again = codex(older);
    try {
      expect((await turn(again.d, "hello", sink().sink)).ok).toBe(true);
      expect(again.thread().config.agents).toMatchObject({ default_subagent_model: "gpt-mini", default_subagent_reasoning_effort: "medium" });
    } finally { await again.d.dispose(); }
  });

  test("if OpenAI refuses helper tools without model and effort for a model, they're offered again and the chat says to try again", async () => {
    const c = ctx("codex", {}, { config: { effort: "high" } });
    const { d, thread } = codex(c);
    try {
      const refused = await turn(d, "RESERVED", sink().sink);
      expect(refused).toEqual({ ok: false, error: "OpenAI didn't take the helper settings Crosstalk gives Codex for this model, so Crosstalk switched them off: send it again. (Helpers that start on another model or effort still stop the reply.)" });
      // Codex starts again without them, and the same message goes through.
      expect((await turn(d, "RESERVED", sink().sink)).ok).toBe(true);
      expect(thread().config.features.multi_agent_v2).toBeUndefined();
      expect(thread().config.features.default_mode_request_user_input).toBe(true);
    } finally {
      hideSpawnOverridesAgain();
      await d.dispose();
    }
  });

  const REFUSED = "OpenAI didn't take the helper settings Crosstalk gives Codex for this model, so Crosstalk switched them off: send it again. (Helpers that start on another model or effort still stop the reply.)";
  const opened = (c: DriverContext) => lines(join(c.room.cwd, "rpc.jsonl")).filter((x) => /^thread\/(start|resume|fork)$/.test(x.method ?? ""));

  test("a chat whose Codex was set up before another chat's refusal is refused too, says the same, and starts again without them", async () => {
    const a = codex(ctx("codex", {}, { config: { effort: "high" } }));
    const b = codex(ctx("codex", {}, { config: { effort: "high" } }));
    try {
      // Both set up while helper tools still leave model and effort out.
      expect((await turn(a.d, "hello", sink().sink)).ok).toBe(true);
      expect((await turn(b.d, "hello", sink().sink)).ok).toBe(true);
      expect(b.thread().config.features.multi_agent_v2).toEqual({ expose_spawn_agent_model_overrides: false });
      expect((await turn(a.d, "RESERVED", sink().sink)).error).toBe(REFUSED);
      // Switched off already, but B's Codex still leaves them out: not OpenAI's own words, and Try again works.
      expect((await turn(b.d, "RESERVED", sink().sink)).error).toBe(REFUSED);
      expect((await turn(b.d, "RESERVED", sink().sink)).ok).toBe(true);
      expect(b.thread().config.features.multi_agent_v2).toBeUndefined();
      expect((await turn(a.d, "RESERVED", sink().sink)).ok).toBe(true);
    } finally {
      hideSpawnOverridesAgain();
      await a.d.dispose();
      await b.d.dispose();
    }
  });

  test("once Crosstalk's setting is off, a refusal (something else leaves them out) is shown as it is, and Codex isn't started again", async () => {
    const c = ctx("codex", {}, { config: { effort: "high" } });
    c.env.FAKE_CODEX_RESERVED_ALWAYS = "1";
    const { d } = codex(c);
    try {
      expect((await turn(d, "RESERVED", sink().sink)).error).toBe(REFUSED);
      const raw = await turn(d, "RESERVED", sink().sink);
      expect(raw.error).toContain("is reserved for use by this model");
      expect(raw.error).not.toBe(REFUSED);
      expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
      // Started once more after the first refusal, never after the second.
      expect(opened(c)).toHaveLength(2);
    } finally {
      hideSpawnOverridesAgain();
      await d.dispose();
    }
  });

  /**
   * The Codex app's shared server, in the chat's Codex home, as Codex 0.160 runs it while the Codex app shows every
   * thread it has loaded: a resume rejoins the loaded copy whatever settings it brings ("thread/resume overrides ignored
   * for loaded thread"; with nothing else showing it, Codex would load it again from disk), and the copy stays loaded
   * until a test lets it go. `calls`: what it was asked; `listFails`: it can't say which threads it has loaded.
   */
  function codexAppServer(codexHome: string) {
    mkdirSync(join(codexHome, "app-server-control"), { recursive: true });
    const loaded = new Map<string, { hidden: boolean }>();
    const calls: { method: string; threadId?: string }[] = [];
    let n = 0;
    const app = { loaded, calls, listFails: false, resumed: () => calls.filter((x) => x.method === "thread/resume").map((x) => x.threadId), stop: () => server.stop(true) };
    const server = Bun.serve({
      unix: join(codexHome, "app-server-control", "app-server-control.sock"),
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const m = JSON.parse(String(raw));
          const send = (o: object) => void ws.send(JSON.stringify({ jsonrpc: "2.0", ...o }));
          const hidden = !!m.params?.config?.features?.multi_agent_v2;
          if (m.method) calls.push({ method: m.method, ...(m.params?.threadId ? { threadId: m.params.threadId } : {}) });
          switch (m.method) {
            case "initialize":
              return send({ id: m.id, result: { userAgent: "crosstalk/0.160.0 (Mac OS 27.0.1; arm64) unknown (crosstalk; 0.1.0)" } });
            case "thread/loaded/list":
              return app.listFails ? send({ id: m.id, error: { code: -32601, message: "Method not found" } }) : send({ id: m.id, result: { data: [...loaded.keys()], nextCursor: null } });
            case "thread/start": {
              const id = `th-app-${++n}`;
              loaded.set(id, { hidden });
              return send({ id: m.id, result: { thread: { id }, model: "gpt-test", reasoningEffort: "high" } });
            }
            case "thread/resume":
              if (!loaded.has(m.params.threadId)) loaded.set(m.params.threadId, { hidden });
              return send({ id: m.id, result: { thread: { id: m.params.threadId }, model: "gpt-test", reasoningEffort: "high" } });
            case "turn/start": {
              const threadId = m.params.threadId;
              const turn = { id: `tu-app-${++n}` };
              send({ id: m.id, result: { turn } });
              if (String(m.params.input?.[0]?.text).includes("RESERVED") && loaded.get(threadId)?.hidden) {
                return send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "failed", error: { message: "Function 'collaboration.spawn_agent' is reserved for use by this model and must match the configured schema" } } } });
              }
              send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "i1", delta: "Done." } });
              return send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
            }
            default:
              if (m.method && m.id !== undefined) send({ id: m.id, result: {} });
          }
        },
      },
    });
    return app;
  }

  test("on the Codex app's server, which keeps a loaded thread as it was set up, a refused chat goes on in a Codex of its own, on the same thread", async () => {
    // Under /tmp: a Unix socket's path has to be short.
    const home = mkdtempSync("/tmp/ct-cx-");
    dirs.push(home);
    const app = codexAppServer(home);
    const c = ctx("codex", {}, { config: { effort: "high" } });
    c.env.CODEX_HOME = home;
    const { d, thread } = codex(c);
    const s = sink();
    try {
      expect(await turn(d, "RESERVED", s.sink)).toEqual({ ok: false, error: REFUSED });
      const id = s.rec.session.threadId;
      expect(app.loaded.get(id as string)).toEqual({ hidden: true });
      expect(s.rec.session.ownServerThread).toBe(id);
      // Try again: the Codex app's server would resume the thread as it has it and refuse it again, so the chat's own
      // app-server takes the same thread up, without them.
      expect((await turn(d, "RESERVED", sink().sink)).ok).toBe(true);
      expect(thread()).toMatchObject({ threadId: id });
      expect(thread().config.features.multi_agent_v2).toBeUndefined();
      expect((await turn(d, "hello", sink().sink)).ok).toBe(true);
      expect(app.resumed()).toEqual([]);

      // Another chat, on a thread the Codex app's server loaded with them left out: nothing it sends leaves them out
      // now, but its thread still does. It's refused the same way and moves too.
      app.loaded.set("th-shown-in-the-app", { hidden: true });
      const c2 = ctx("codex", { threadId: "th-shown-in-the-app" }, { config: { effort: "high" } });
      c2.env.CODEX_HOME = home;
      const other = codex(c2);
      try {
        expect((await turn(other.d, "RESERVED", sink().sink)).error).toBe(REFUSED);
        expect((await turn(other.d, "RESERVED", sink().sink)).ok).toBe(true);
        expect(other.thread()).toMatchObject({ threadId: "th-shown-in-the-app" });
        expect(app.resumed()).toEqual(["th-shown-in-the-app"]);
      } finally {
        await other.d.dispose();
      }
    } finally {
      hideSpawnOverridesAgain();
      await d.dispose();
      app.stop();
    }
  });

  test("a chat that moved off the Codex app's server stays off it, whatever replaces its driver, while that server has its old copy; once it lets go, the chat goes back", async () => {
    const home = mkdtempSync("/tmp/ct-cx-");
    dirs.push(home);
    const app = codexAppServer(home);
    const c = ctx("codex", {}, { config: { effort: "high" } });
    c.env.CODEX_HOME = home;
    // One sink for the whole chat: what it keeps is the chat's saved session, which a replacement driver starts from.
    const s = sink();
    let cx = codex(c);
    const replace = async () => {
      await cx.d.dispose();
      c.session = { ...s.rec.session };
      cx = codex(c);
    };
    const asked = () => app.calls.filter((x) => x.method === "thread/loaded/list").length;
    try {
      // The Codex app shows the thread all along, so its server keeps the copy it had when the chat moved.
      expect(await turn(cx.d, "RESERVED", s.sink)).toEqual({ ok: false, error: REFUSED });
      const id = s.rec.session.threadId as string;
      expect((await turn(cx.d, "RESERVED", s.sink)).ok).toBe(true);
      // New settings (or the idle end): the new driver doesn't resume that copy, which misses the turns since the move,
      // and isn't refused again.
      await replace();
      expect((await turn(cx.d, "RESERVED", s.sink)).ok).toBe(true);
      expect(cx.thread()).toMatchObject({ threadId: id });
      expect(cx.thread().config.features.multi_agent_v2).toBeUndefined();
      // A hub restart: Crosstalk's setting is back on, but the session still says where the thread went.
      hideSpawnOverridesAgain();
      await replace();
      expect((await turn(cx.d, "hello", s.sink)).ok).toBe(true);
      expect(cx.thread()).toMatchObject({ threadId: id });
      // The Codex app's server let the thread go but can't say so: still off it.
      app.loaded.delete(id);
      app.listFails = true;
      await replace();
      expect((await turn(cx.d, "hello", s.sink)).ok).toBe(true);
      expect(app.resumed()).toEqual([]);
      // It says so: the chat goes back, live in the Codex app again, and stays there without asking.
      app.listFails = false;
      await replace();
      expect((await turn(cx.d, "hello", s.sink)).ok).toBe(true);
      expect(app.resumed()).toEqual([id]);
      expect(s.rec.session.ownServerThread).toBeNull();
      const before = asked();
      await replace();
      expect((await turn(cx.d, "hello", s.sink)).ok).toBe(true);
      expect(app.resumed()).toEqual([id, id]);
      expect(asked()).toBe(before);
    } finally {
      hideSpawnOverridesAgain();
      await cx.d.dispose();
      app.stop();
    }
  });

  test("an older Codex gets no helper settings it would refuse the whole config over; one that doesn't say its version is asked again without them", async () => {
    expect([takesHelperSettings("0.144.9"), takesHelperSettings("0.99.0"), takesHelperSettings("0.145.0"), takesHelperSettings("0.160.0"), takesHelperSettings("1.0.0"), takesHelperSettings(null)]).toEqual([false, false, true, true, true, null]);
    const settings = { config: { effort: "high", helperModel: "gpt-mini" } };
    // Codex 0.144 says its version: they're left out from the start, and the roles still hold helpers to their model.
    const c = ctx("codex", {}, settings);
    Object.assign(c.env, { FAKE_CODEX_VERSION: "0.144.0", FAKE_CODEX_OLD_CONFIG: "0.144" });
    const old = codex(c);
    try {
      expect((await turn(old.d, "hello", sink().sink)).ok).toBe(true);
      expect(opened(c).map((x) => x.method)).toEqual(["thread/start"]);
      expect(old.thread().config.features).toEqual({ default_mode_request_user_input: true });
      expect(Object.keys(old.thread().config.agents).sort()).toEqual(["awaiter", "default", "explorer", "worker"]);
      expect((await turn(old.d, "SPAWN:gpt-test:high", sink().sink)).error).toContain("on gpt-test instead of gpt-mini");
    } finally {
      await old.d.dispose();
    }
    // One new enough gets them.
    const c2 = ctx("codex", {}, settings);
    c2.env.FAKE_CODEX_VERSION = "0.145.0";
    const recent = codex(c2);
    try {
      expect((await turn(recent.d, "hello", sink().sink)).ok).toBe(true);
      expect(recent.thread().config.features.multi_agent_v2).toEqual({ expose_spawn_agent_model_overrides: false });
      expect(recent.thread().config.agents).toMatchObject({ default_subagent_model: "gpt-mini", default_subagent_reasoning_effort: "high" });
    } finally {
      await recent.d.dispose();
    }
    // One that doesn't say, whichever older kind it is: asked again without them, on the same thread (not a new one),
    // and they stay out when its Codex starts again.
    for (const kind of ["0.144", "0.110"]) {
      const c3 = ctx("codex", { threadId: "th-kept" }, settings);
      c3.env.FAKE_CODEX_OLD_CONFIG = kind;
      const unsaid = codex(c3);
      try {
        expect((await turn(unsaid.d, "hello", sink().sink)).ok).toBe(true);
        const [first, again] = opened(c3);
        expect([first.method, first.params.threadId, again.method, again.params.threadId]).toEqual(["thread/resume", "th-kept", "thread/resume", "th-kept"]);
        expect(first.params.config.features.multi_agent_v2).toBeDefined();
        expect(again.params.config.features).toEqual({ default_mode_request_user_input: true });
        expect(again.params.config.agents.default_subagent_model).toBeUndefined();
        await (unsaid.d as unknown as { rpc: { kill(): Promise<void> } }).rpc.kill();
        expect((await turn(unsaid.d, "hello", sink().sink)).ok).toBe(true);
        expect(opened(c3)).toHaveLength(3);
      } finally {
        await unsaid.d.dispose();
      }
    }
  });

  test("default effort, effective helper settings and v2 helper events are checked", async () => {
    const c = ctx("codex");
    c.env.FAKE_CODEX_HELPER_EFFORT = "low";
    const { d } = codex(c);
    try {
      expect((await turn(d, "SPAWN:gpt-test:low", sink().sink)).error).toContain("low effort instead of medium");
      const v2 = await turn(d, "V2_HELPER", sink().sink);
      expect(v2.error).toContain("low effort instead of medium");
      await Bun.sleep(20);
      expect(lines(join(c.room.cwd, "rpc.jsonl")).some((x) => x.method === "turn/interrupt" && x.params.threadId === "helper-1" && x.params.turnId === "helper-turn")).toBe(true);
    } finally { await d.dispose(); }
  });

  /** A reply left running fails here, not at the test's time limit. */
  const ended = (r: Promise<TurnResult>) => Promise.race([r, Bun.sleep(2000).then((): TurnResult => ({ ok: false, error: "still running" }))]);

  test("a reply whose helpers message it (Codex's newer helpers) ends when Codex ends it, and so does the next one", async () => {
    const c = ctx("codex");
    const reads = join(c.room.cwd, "reads.log");
    c.env.FAKE_CODEX_READ_LOG = reads;
    const { d } = codex(c);
    try {
      const state = sink();
      expect(await ended(turn(d, "V2_MESSAGE_ROOT", state.sink))).toEqual({ ok: true });
      // What the agent did after its helpers' messages reached it is in the reply; the helpers' own text isn't.
      expect(state.rec.text).toBe("Asking two helpers.\n\nDone.");
      expect(state.rec.activities.some((a) => a.title === "Web search: after the helpers" && a.status === "done")).toBe(true);
      // Both helpers were checked; the chat's own thread (the one they messaged) was never taken for a helper.
      const read = readFileSync(reads, "utf8").trim().split("\n");
      expect(read).toContain("th-helper-a");
      expect(read).toContain("th-helper-b");
      expect(read).not.toContain("th-1");
      // The chat still hears its own thread: the next reply ends too, after the last helper's late note.
      await Bun.sleep(30);
      const next = sink();
      expect(await ended(turn(d, "hello", next.sink))).toEqual({ ok: true });
      expect(next.rec.text).toBe("Done.");
    } finally { await d.dispose(); }
  });

  test("what an ended turn still sends can't make the next reply wait for that turn", async () => {
    const { d } = codex(ctx("codex"));
    try {
      expect(await ended(turn(d, "hello", sink().sink))).toEqual({ ok: true });
      // The previous turn's late note arrives before this turn's own events and the answer to turn/start.
      const next = sink();
      expect(await ended(turn(d, "LATE_ITEM", next.sink))).toEqual({ ok: true });
      expect(next.rec.text).toBe("Done.");
    } finally { await d.dispose(); }
  });

  test("Stop during Codex startup never sends the user's turn", async () => {
    const c = ctx("codex");
    c.env.FAKE_CODEX_START_DELAY = "150";
    const { d } = codex(c);
    const state = sink();
    try {
      const result = turn(d, "hello", state.sink);
      await Bun.sleep(30);
      state.abort.abort();
      await d.interrupt();
      expect(await result).toEqual({ ok: false, error: "stopped" });
      expect(lines(join(c.room.cwd, "rpc.jsonl")).some((x) => x.method === "turn/start")).toBe(false);
      expect(state.rec.text).toBe("");
    } finally { await d.dispose(); }
  });

  test("Stop waits for a pending turn id and interrupts that exact turn", async () => {
    const c = ctx("codex");
    c.env.FAKE_CODEX_TURN_DELAY = "150";
    const { d } = codex(c);
    const state = sink();
    try {
      const result = turn(d, "hello", state.sink);
      for (let i = 0; i < 100; i++) {
        try { if (lines(join(c.room.cwd, "rpc.jsonl")).some((x) => x.method === "turn/start")) break; } catch {}
        await Bun.sleep(5);
      }
      state.abort.abort();
      expect(await result).toEqual({ ok: false, error: "stopped" });
      expect(lines(join(c.room.cwd, "rpc.jsonl")).filter((x) => x.method === "turn/interrupt")).toHaveLength(1);
      expect(state.rec.text).toBe("");
    } finally { await d.dispose(); }
  });

  test("resumed default threads keep their effective model and inject helper guidance", async () => {
    const c = ctx("codex", { threadId: "th-1" });
    c.env.FAKE_CODEX_MODEL = "gpt-resumed";
    const { d } = codex(c);
    const state = sink();
    try {
      expect((await turn(d, "SPAWN:gpt-test:", state.sink)).error).toContain("gpt-test instead of gpt-resumed");
      expect(state.rec.session.model).toBe("gpt-resumed");
      const calls = lines(join(c.room.cwd, "rpc.jsonl"));
      expect(calls.find((x) => x.method === "turn/start").params.input[0].text).toContain("Helper agents you start");
    } finally { await d.dispose(); }
  });

  test("a helper started on another model or effort stops the reply; one like the chat's is shown", async () => {
    const c = ctx("codex", {}, { config: { effort: "high" } });
    const { d } = codex(c);
    const same = sink();
    expect((await turn(d, "SPAWN:gpt-test:high", same.sink)).ok).toBe(true);
    expect(same.rec.activities.some((a) => a.title === "Helper agent: Check the tests")).toBe(true);
    expect((await turn(d, "SPAWN::", sink().sink)).ok).toBe(true); // Codex didn't say: nothing to compare
    const model = await turn(d, "SPAWN:gpt-mini:high", sink().sink);
    expect(model.error).toBe("Codex started a helper agent on gpt-mini instead of gpt-test, so Crosstalk stopped this reply. Helpers use this chat's model at this chat's effort; pick another model for helpers in the model menu or the chat's settings.");
    const effort = await turn(d, "SPAWN:gpt-test:low", sink().sink);
    expect(effort.error).toContain("at low effort instead of high");
    await d.dispose();
  });
});

/** A Claude Code stand-in for the engine: each turn runs `script`, which can call the hub as the agent's tools would. */
class ScriptedClaude implements AgentDriver {
  readonly provider = "claude" as const;
  static script: (ctx: DriverContext, input: TurnInput, sink: TurnSink) => Promise<string> = async () => "ok";
  static disposals = 0;
  static turns: { prompt: string; helperModel: unknown }[] = [];
  constructor(private ctx: DriverContext) {}
  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    ScriptedClaude.turns.push({ prompt: input.prompt, helperModel: this.ctx.member.config.helperModel });
    const text = await ScriptedClaude.script(this.ctx, input, sink);
    sink.text(text);
    return { ok: true };
  }
  async interrupt() {}
  async dispose() { ScriptedClaude.disposals++; }
}

describe("asking in the chat for helpers on another model", () => {
  const CATALOG = { provider: "claude", models: [
    { id: "opus", label: "Opus 5.5", description: null, efforts: ["low", "high", "max"], defaultEffort: null, isDefault: true },
    { id: "sonnet", label: "Sonnet 5.5", description: null, efforts: ["low", "high"], defaultEffort: null, isDefault: false },
    { id: "haiku", label: "Haiku 4.5", description: null, efforts: [], defaultEffort: null, isDefault: false },
  ], live: true, error: null };

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ct-lock-app-"));
    dirs.push(dir);
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    (app.providers as unknown as { models: () => Promise<unknown> }).models = async () => CATALOG;
    registerDriver("claude", (c) => new ScriptedClaude(c));
    ScriptedClaude.turns = [];
    ScriptedClaude.disposals = 0;
    const room = app.createRoom({ name: "Chat", mode: "direct" });
    const member = app.addMember(room.id, { provider: "claude" });
    return { app, room, member, done: async () => { await app.engine.shutdown(); app.store.close(); } };
  }
  const settle = async (app: App) => {
    for (let i = 0; i < 100 && app.engine.isBusy(); i++) await Bun.sleep(20);
    await Bun.sleep(30);
  };

  test("named in the user's message: done at once, and the agent carries on in a new reply with the new helpers", async () => {
    const { app, room, member, done } = setup();
    try {
      let answer = "";
      ScriptedClaude.script = async (c, input) => {
        if (ScriptedClaude.turns.length === 1) answer = await app.useHelperModel(c.member.id, "sonnet");
        return `reply ${ScriptedClaude.turns.length}`;
      };
      app.engine.postHumanMessage(room.id, "Run the review with sonnet subagents", "Phone");
      await settle(app);
      expect(answer).toStartWith("Done: helper agents run on Sonnet 5.5 from your next reply.");
      expect(app.store.getMember(member.id)!.config.helperModel).toBe("sonnet");
      expect(app.store.listApprovals(room.id)).toHaveLength(0);
      // The second reply started by itself, on a driver that has the new setting.
      expect(ScriptedClaude.turns).toHaveLength(2);
      expect(ScriptedClaude.turns[1].helperModel).toBe("sonnet");
      expect(ScriptedClaude.turns[1].prompt).toContain("Helper agents now run on Sonnet 5.5, as the user asked.");
    } finally {
      await done();
    }
  });

  test("not named by the user: asked first, and a no leaves helpers where they were", async () => {
    const { app, room, member, done } = setup();
    try {
      const answers: string[] = [];
      ScriptedClaude.script = async (c) => {
        if (ScriptedClaude.turns.length === 1) answers.push(await app.useHelperModel(c.member.id, "haiku"));
        return "reply";
      };
      app.engine.postHumanMessage(room.id, "Make the tests faster", "Phone");
      let card: { id: string; title: string } | undefined;
      for (let i = 0; i < 100 && !card; i++) {
        await Bun.sleep(20);
        card = app.store.listPendingApprovals().find((a) => a.roomId === room.id);
      }
      expect(card?.title).toBe("Run helper agents on Haiku 4.5?");
      app.engine.decideApproval(card!.id, "deny", "Phone");
      await settle(app);
      expect(answers).toEqual(["The user said no: helper agents stay on Opus 5.5."]);
      expect(app.store.getMember(member.id)!.config.helperModel).toBeUndefined();
      expect(ScriptedClaude.turns).toHaveLength(1);
    } finally {
      await done();
    }
  });

  test("an explicit reset puts helpers back on the chat's model; unknown models are named back", async () => {
    const { app, room, member, done } = setup();
    try {
      app.updateMember(member.id, { config: { ...member.config, helperModel: "haiku" } });
      const answers: string[] = [];
      ScriptedClaude.script = async (c) => {
        if (ScriptedClaude.turns.length === 1) {
          answers.push(await app.useHelperModel(c.member.id, "gpt-9"));
          answers.push(await app.useHelperModel(c.member.id, "same"));
        }
        return "reply";
      };
      app.engine.postHumanMessage(room.id, "put helpers back on the same model as this chat", "Phone");
      let card: { id: string } | undefined;
      for (let i = 0; i < 100 && !card; i++) { await Bun.sleep(10); card = app.store.listPendingApprovals().find((a) => a.roomId === room.id); }
      expect(card).toBeDefined();
      app.engine.decideApproval(card!.id, "approve", "Phone");
      await settle(app);
      expect(answers[0]).toBe('Claude Code here has no model called "gpt-9". It offers: Opus 5.5, Sonnet 5.5, Haiku 4.5.');
      expect(answers[1]).toStartWith("Done: helper agents run on Opus 5.5, this chat's model from your next reply.");
      expect(app.store.getMember(member.id)!.config.helperModel).toBeUndefined();
    } finally {
      await done();
    }
  });

  test("continuing a settings change preserves queued work and the sender's eventual reply", async () => {
    const { app, room, member, done } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      ScriptedClaude.script = async (c, input) => {
        if (ScriptedClaude.turns.length === 1) {
          await app.useHelperModel(c.member.id, "sonnet");
          app.store.db.query("INSERT INTO xchat_in VALUES (?,?,?,?,?,?,?)").run("request-1", "message-1", room.id, "other", "send", input.turnId, Date.now());
          await gate;
          return "Changing helper settings.";
        }
        return "Finished the original task and README.";
      };
      app.engine.postHumanMessage(room.id, "Use sonnet helpers to finish the task", "Phone");
      for (let i = 0; i < 100 && !app.store.getMember(member.id)?.config.helperModel; i++) await Bun.sleep(5);
      app.engine.postHumanMessage(room.id, "Also check the README", "Phone");
      release();
      await settle(app);
      expect(ScriptedClaude.turns).toHaveLength(2);
      expect(ScriptedClaude.turns[1].prompt).toContain("Carry on with the task");
      expect(ScriptedClaude.turns[1].prompt).toContain("Also check the README");
      const turns = app.store.listTurns(room.id);
      const delivered = app.store.db.query("SELECT turn_id FROM xchat_in WHERE request_id='request-1'").get() as { turn_id: string };
      const final = app.store.getTurn(delivered.turn_id)!;
      expect(app.store.getMessage(final.replyMessageId!)?.text).toBe("Finished the original task and README.");
      expect(turns.filter((t) => app.engine.isContinuationTurn(t))).toHaveLength(1);
    } finally { release(); await done(); }
  });

  test("an interim settings acknowledgement never starts a review round", async () => {
    const { app, room, member, done } = setup();
    try {
      app.updateRoom(room.id, { mode: "review" });
      app.addMember(room.id, { provider: "mock", handle: "reviewer", config: { reply: "APPROVED", delayMs: 1 } });
      ScriptedClaude.script = async (c) => {
        if (ScriptedClaude.turns.length === 1) { await app.useHelperModel(c.member.id, "sonnet"); return "Changing helper settings."; }
        return "Implemented and tested the change.";
      };
      app.engine.postHumanMessage(room.id, "Use sonnet helpers for this task", "Phone");
      await settle(app);
      const replies = app.store.messagesAfter(room.id, 0).filter((m) => m.authorKind === "agent");
      expect(replies.map((m) => m.authorName)).toEqual(["claude", "claude", "reviewer"]);
      expect(replies[1].text).toBe("Implemented and tested the change.");
    } finally { await done(); }
  });

  test("settings wait for background helpers, then queued work starts on the new driver", async () => {
    const { app, room, member, done } = setup();
    let report: DriverContext["onTasks"];
    try {
      ScriptedClaude.script = async (c) => {
        if (ScriptedClaude.turns.length === 1) {
          report = c.onTasks;
          report?.([{ id: "helper", kind: "local_agent", description: "Review", agentType: null, workflow: null, background: true, status: "running", startedAt: Date.now(), endedAt: null, tokens: null, toolUses: null, lastTool: null, summary: null, error: null }]);
        }
        return "done";
      };
      app.engine.postHumanMessage(room.id, "Start the review", "Phone");
      await settle(app);
      app.updateMember(member.id, { config: { helperModel: "sonnet" } });
      app.engine.postHumanMessage(room.id, "Continue", "Phone");
      await Bun.sleep(30);
      expect(ScriptedClaude.disposals).toBe(0);
      expect(ScriptedClaude.turns).toHaveLength(1);
      report?.([]);
      await settle(app);
      expect(ScriptedClaude.disposals).toBe(1);
      expect(ScriptedClaude.turns).toHaveLength(2);
      expect(ScriptedClaude.turns[1].helperModel).toBe("sonnet");
    } finally { report?.([]); await done(); }
  });

  test("reselecting Default cannot be undone by the running driver's late model pin", async () => {
    const { app, room, member, done } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let began = false;
    try {
      ScriptedClaude.script = async (c, _input, stream) => {
        if (ScriptedClaude.turns.length === 1) {
          stream.saveSession({ sessionId: "same-conversation", model: "claude-old-default", modelRequested: null });
          began = true;
          await gate;
          stream.saveSession({ sessionId: "same-conversation", model: "claude-old-default", modelRequested: null, effort: "low", msgRefs: { message: "ref" } });
        } else {
          expect(c.session.model).toBeUndefined();
          expect(c.session.sessionId).toBe("same-conversation");
          stream.saveSession({ model: "claude-new-default", modelRequested: null });
        }
        return "done";
      };
      app.engine.postHumanMessage(room.id, "Start", "Phone");
      for (let i = 0; i < 100 && !began; i++) await Bun.sleep(5);
      expect(began).toBe(true);
      app.updateMember(member.id, { model: null });
      release();
      await settle(app);
      const saved = app.store.getMemberSession<Record<string, unknown>>(member.id);
      expect(saved.model).toBeUndefined();
      expect(saved.effort).toBeUndefined();
      expect(saved.sessionId).toBe("same-conversation");
      expect(saved.msgRefs).toEqual({ message: "ref" });
      app.engine.postHumanMessage(room.id, "Continue", "Phone");
      await settle(app);
      expect(app.store.getMemberSession<Record<string, unknown>>(member.id).model).toBe("claude-new-default");
    } finally { release(); await done(); }
  });

  test("late session writes cannot restore the previous account, even after switching back", async () => {
    for (const switchBack of [false, true]) {
      const { app, room, member, done } = setup();
      const account = app.providers.addAccount("claude", "Work");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let began = false;
      try {
        ScriptedClaude.script = async (_ctx, _input, stream) => {
          if (ScriptedClaude.turns.length === 1) {
            stream.saveSession({ sessionId: "old-account-session", model: "claude-old" });
            began = true;
            await gate;
            stream.saveSession({ sessionId: "old-account-session", model: "claude-old", msgRefs: { old: "ref" } });
          } else stream.saveSession({ sessionId: "new-account-session", model: "claude-new" });
          return "done";
        };
        app.engine.postHumanMessage(room.id, "Start", "Phone");
        for (let i = 0; i < 100 && !began; i++) await Bun.sleep(5);
        expect(began).toBe(true);
        app.updateMember(member.id, { config: { account: account.id } });
        if (switchBack) app.updateMember(member.id, { config: {} });
        expect(app.store.getMemberSession<Record<string, unknown>>(member.id)).toEqual({});
        release();
        await settle(app);
        expect(app.store.getMemberSession<Record<string, unknown>>(member.id)).toEqual({});
        expect(app.store.getMember(member.id)?.resolvedModel).toBeUndefined();
        app.engine.postHumanMessage(room.id, "Start with this account", "Phone");
        await settle(app);
        expect(app.store.getMemberSession<Record<string, unknown>>(member.id)).toMatchObject({ sessionId: "new-account-session", model: "claude-new" });
      } finally { release(); await done(); }
    }
  });

  test("the menu's helper model must be a model name, and picking a model forgets the kept default", async () => {
    const { app, member, done } = setup();
    try {
      expect(() => app.updateMember(member.id, { config: { helperModel: "sonnet; rm -rf /" } })).toThrow("bad helper model");
      expect(app.updateMember(member.id, { config: { helperModel: "claude-sonnet-5-5" } }).config.helperModel).toBe("claude-sonnet-5-5");
      expect(app.updateMember(member.id, { config: { helperModel: "" } }).config.helperModel).toBeUndefined();
      app.store.setMemberSession(member.id, { sessionId: "s1", model: "claude-opus-5-5" });
      app.updateMember(member.id, { model: "sonnet" });
      expect(app.store.getMemberSession<Record<string, unknown>>(member.id)).toEqual({ sessionId: "s1" });
    } finally {
      await done();
    }
  });
});

describe("helper agents for every agent that starts them", () => {
  const CODEX = { provider: "codex", live: true, error: null, models: [
    { id: "gpt-test", label: "gpt-test", description: null, efforts: ["low", "high"], defaultEffort: "high", isDefault: true },
    { id: "gpt-mini", label: "gpt-mini", description: null, efforts: ["low", "high"], defaultEffort: "low", isDefault: false },
  ] };

  /** A Codex stand-in for the engine: each turn runs `script`, as the agent's tools would. */
  class ScriptedCodex implements AgentDriver {
    readonly provider = "codex" as const;
    static script: (ctx: DriverContext) => Promise<string> = async () => "ok";
    static helperModels: unknown[] = [];
    constructor(private ctx: DriverContext) {}
    async runTurn(_input: TurnInput, sink: TurnSink): Promise<TurnResult> {
      ScriptedCodex.helperModels.push(this.ctx.member.config.helperModel);
      sink.text(await ScriptedCodex.script(this.ctx));
      return { ok: true };
    }
    async interrupt() {}
    async dispose() {}
  }

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ct-lock-codex-"));
    dirs.push(dir);
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    (app.providers as unknown as { models: () => Promise<unknown> }).models = async () => CODEX;
    registerDriver("codex", (c) => new ScriptedCodex(c));
    ScriptedCodex.helperModels = [];
    return { app, dir, done: async () => { await app.engine.shutdown(); app.store.close(); } };
  }

  test("a Codex chat's agent can put its helpers on the model the user named, and carries on with them", async () => {
    const { app, done } = setup();
    try {
      const room = app.chats.create({ provider: "codex", name: "Codex chat" });
      const member = app.store.listMembers(room.id)[0];
      let answer = "";
      ScriptedCodex.script = async (c) => {
        if (ScriptedCodex.helperModels.length === 1) answer = await app.useHelperModel(c.member.id, "gpt-mini");
        return "reply";
      };
      app.engine.postHumanMessage(room.id, "use gpt-mini for the helper agents", "Phone");
      for (let i = 0; i < 100 && (app.engine.isBusy() || ScriptedCodex.helperModels.length < 2); i++) await Bun.sleep(20);
      expect(answer).toStartWith("Done: helper agents run on gpt-mini from your next reply. Codex picks this up");
      expect(app.store.getMember(member.id)!.config.helperModel).toBe("gpt-mini");
      expect(ScriptedCodex.helperModels).toEqual([undefined, "gpt-mini"]);
    } finally {
      await done();
    }
  });

  test("new chats take a helper model from the request or the agent's defaults; bad names are refused", async () => {
    const { app, done } = setup();
    try {
      const picked = app.chats.create({ provider: "codex", name: "Picked", helperModel: "gpt-mini" });
      expect(app.store.listMembers(picked.id)[0].config.helperModel).toBe("gpt-mini");
      expect(() => app.setAgentDefaults("codex", { permissionMode: "ask", model: null, effort: null, helperModel: "gpt mini; rm" })).toThrow("bad helper model");
      app.setAgentDefaults("codex", { permissionMode: "ask", model: null, effort: null, helperModel: "gpt-mini" });
      expect(app.defaults().agent.codex?.helperModel).toBe("gpt-mini");
      const fromDefaults = app.chats.create({ provider: "codex", name: "Defaults" });
      expect(app.store.listMembers(fromDefaults.id)[0].config.helperModel).toBe("gpt-mini");
      // An explicit "same as the agent" wins over the default.
      const same = app.chats.create({ provider: "codex", name: "Same", helperModel: "" });
      expect(app.store.listMembers(same.id)[0].config.helperModel).toBeUndefined();
      app.setAgentDefaults("codex", { permissionMode: "ask", model: null, effort: null, helperModel: "" });
      expect(app.defaults().agent.codex).not.toHaveProperty("helperModel");
      expect(() => app.chats.create({ provider: "codex", name: "Bad", helperModel: "a b" })).toThrow("bad helper model");
      // An agent added to a room gets the default too.
      app.setAgentDefaults("codex", { permissionMode: "ask", model: null, effort: null, helperModel: "gpt-mini" });
      const room = app.createRoom({ name: "Team", mode: "direct" });
      expect(app.addMember(room.id, { provider: "codex", handle: "builder" }).config.helperModel).toBe("gpt-mini");
      expect(app.addMember(room.id, { provider: "codex", handle: "reviewer", config: { account: "default" } }).config.helperModel).toBe("gpt-mini");
      // "The same model as this agent", said outright, isn't replaced by the default; and only model names are taken.
      expect(app.addMember(room.id, { provider: "codex", handle: "same", config: { helperModel: null } }).config).not.toHaveProperty("helperModel");
      expect(() => app.addMember(room.id, { provider: "codex", handle: "bad", config: { helperModel: "gpt mini; rm" } })).toThrow("bad helper model");
    } finally {
      await done();
    }
  });
});

afterAll(() => {
  registerDriver("claude", (c) => new ClaudeDriver(c, c.bin));
  registerDriver("codex", (c) => new CodexDriver(c, c.bin));
});
