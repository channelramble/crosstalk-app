import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, BackgroundTask, Member, Room, UsageSnapshot } from "@crosstalk/shared";
import type { ActivityInput, ApprovalRequest, DriverContext, TurnResult, TurnSink } from "../src/agents/driver";
import { ClaudeDriver, claudeRateWindow, helperDetails } from "../src/agents/claude";
import { processesEnding } from "../src/util/process";
import { AntigravityDriver, agyPermissionArgs } from "../src/agents/antigravity";
import { parseAgyModels } from "../src/providers/antigravity";
import { AcpDriver } from "../src/agents/acp";
import { CodexDriver, codexUsage } from "../src/agents/codex";
import { claudeModelOptions, parseClaudeUsage, parseResetTime } from "../src/providers/claude";
import { codexModelOptions } from "../src/providers/codex";

const FIX = join(import.meta.dir, "fixtures");

function ctx(provider: Member["provider"], session: Record<string, unknown> = {}, patch: Partial<Member> = {}): DriverContext {
  const dir = mkdtempSync(join(tmpdir(), "ct-drv-"));
  const room: Room = { id: "r1", name: "Room", cwd: dir, mode: "relay", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
  const member: Member = { id: "m1", roomId: "r1", handle: provider, provider, model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0, ...patch };
  return { room, member, session, mcp: { command: "true", args: [], env: { CROSSTALK_MEMBER_ID: "m1" } }, env: { PATH: process.env.PATH ?? "" }, bin: "" };
}

function recordingSink(decide: (r: ApprovalRequest) => ApprovalDecision = () => "approve") {
  const abort = new AbortController();
  const rec = {
    text: "",
    activities: [] as (ActivityInput & { id: string; detailOut: string })[],
    approvals: [] as ApprovalRequest[],
    usage: {} as Record<string, unknown>,
    rate: [] as Partial<UsageSnapshot>[],
    session: {} as Record<string, unknown>,
    statuses: [] as string[],
    abort,
  };
  let n = 0;
  const sink: TurnSink = {
    signal: abort.signal,
    text: (d) => (rec.text += d),
    setText: (t) => (rec.text = t),
    activity: (a) => {
      const id = `a${++n}`;
      rec.activities.push({ ...a, id, detailOut: a.detail ?? "" });
      return id;
    },
    updateActivity: (id, p) => {
      const a = rec.activities.find((x) => x.id === id)!;
      if (p.detail !== undefined) a.detailOut = p.detail;
      if (p.appendDetail) a.detailOut += p.appendDetail;
      if (p.status) a.status = p.status;
      if (p.title) a.title = p.title;
    },
    approval: async (r) => {
      rec.approvals.push(r);
      return decide(r);
    },
    usage: (u) => Object.assign(rec.usage, u),
    rateLimit: (u) => rec.rate.push(u),
    status: (d) => d && rec.statuses.push(d),
    saveSession: (p) => Object.assign(rec.session, p),
  };
  return { sink, rec };
}

describe("Claude Code driver (against a fake headless CLI)", () => {
  test("streams text, tool activity, usage, rate limits and saves the session id", async () => {
    const c = ctx("claude");
    const argsFile = join(c.room.cwd, "args.jsonl");
    c.env.FAKE_CLAUDE_ARGS_OUT = argsFile;
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    const { sink, rec } = recordingSink();
    const res = await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: "You are @claude" }, sink);
    expect(res.ok).toBe(true);
    expect(rec.text).toBe("Looking at the files.\n\nDone. @codex please review.");
    expect(rec.activities).toHaveLength(1);
    expect(rec.activities[0].kind).toBe("command");
    expect(rec.activities[0].title).toBe("ls -la");
    expect(rec.activities[0].detailOut).toContain("README.md");
    expect(rec.activities[0].status).toBe("done");
    expect(rec.usage).toMatchObject({ inputTokens: 1500, outputTokens: 80, cachedInputTokens: 300, costUsd: 0.0123 });
    expect(rec.rate[0].windows?.[0]).toMatchObject({ label: "5-hour", usedPercent: 42 });
    expect(rec.session.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]);
    expect(args).toContain("--input-format");
    expect(args).toContain("--permission-prompt-tool");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__crosstalk__approve");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    // The MCP config is a file only this user can read, so the helper's key never shows on the command line.
    const configPath = args[args.indexOf("--mcp-config") + 1];
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const mcp = JSON.parse(readFileSync(configPath, "utf8"));
    expect(mcp.mcpServers.crosstalk.env.CROSSTALK_EXPOSE_APPROVE).toBe("1");
    await d.dispose();
  });

  test("the process stays alive across turns and resumes the session after a restart", async () => {
    const c = ctx("claude", { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, { permissionMode: "edits", model: "sonnet", config: { effort: "xhigh" } });
    const argsFile = join(c.room.cwd, "args.jsonl");
    c.env.FAKE_CLAUDE_ARGS_OUT = argsFile;
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    await d.runTurn({ turnId: "t1", prompt: "one", systemNote: null }, recordingSink().sink);
    await d.runTurn({ turnId: "t2", prompt: "two", systemNote: null }, recordingSink().sink);
    const spawns = readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(spawns).toHaveLength(1);
    expect(spawns[0][spawns[0].indexOf("--resume") + 1]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(spawns[0][spawns[0].indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(spawns[0][spawns[0].indexOf("--model") + 1]).toBe("sonnet");
    expect(spawns[0][spawns[0].indexOf("--effort") + 1]).toBe("xhigh");
    await d.dispose();
  });

  test("a placeholder reply to a background task's notification doesn't end the human's turn", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const { sink, rec } = recordingSink();
    const res = await d.runTurn({ turnId: "t1", prompt: "AFTER_RESTART: carry on", systemNote: null }, sink);
    expect(res.ok).toBe(true);
    expect(rec.text).toContain("@codex please review.");
    expect(rec.text).not.toContain("No response requested");
    await d.dispose();
  });

  test("a reply stopped after Claude Code started on it still gave it the message (taken); one it never got didn't", async () => {
    const c = ctx("claude");
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    const { sink, rec } = recordingSink();
    let taken = 0;
    const running = d.runTurn({ turnId: "t1", prompt: "INTERRUPT_ME please", systemNote: "Note from Crosstalk" }, { ...sink, taken: () => void taken++ });
    for (let i = 0; i < 200 && !rec.activities.length; i++) await Bun.sleep(10);
    expect(taken).toBe(1);
    rec.abort.abort();
    expect((await running).ok).toBe(false);
    expect(taken).toBe(1);
    await d.dispose();
    // A Claude Code that exits before reading anything.
    const dir = mkdtempSync(join(tmpdir(), "ct-drv-dead-"));
    const dead = join(dir, "dead-claude");
    writeFileSync(dead, "#!/bin/sh\necho 'error: something went wrong' >&2\nexit 1\n");
    chmodSync(dead, 0o755);
    const gone = new ClaudeDriver(ctx("claude"), dead);
    const r = await gone.runTurn({ turnId: "t2", prompt: "hello", systemNote: "Note from Crosstalk" }, { ...recordingSink().sink, taken: () => void taken++ });
    expect(r.ok).toBe(false);
    expect(taken).toBe(1);
    await gone.dispose();
  });

  test("compacting reports the sizes; auto-compact size and fast mode go to Claude Code as settings", async () => {
    const c = ctx("claude", {}, { config: { autoCompact: 200000, fast: true } });
    const argsFile = join(c.room.cwd, "args.jsonl");
    c.env.FAKE_CLAUDE_ARGS_OUT = argsFile;
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    const { sink, rec } = recordingSink();
    const res = await d.runTurn({ turnId: "t1", prompt: "/compact", systemNote: null }, sink);
    expect(res).toEqual({ ok: true, text: "Compacted the conversation: 22k → 2k tokens." });
    expect(rec.activities.some((a) => a.title.startsWith("Compacted the conversation"))).toBe(true);
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]);
    expect(JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"))).toMatchObject({ autoCompactWindow: 200000, fastMode: true });
    await d.dispose();
  });

  test("background helpers are reported, and work Claude Code starts by itself becomes a reply of its own", async () => {
    const c = ctx("claude");
    const reports: BackgroundTask[][] = [];
    let own: { why: string; result: Promise<TurnResult>; rec: ReturnType<typeof recordingSink>["rec"] } | null = null;
    c.onTasks = (t) => reports.push(t);
    c.onOwnTurn = (run, why) => {
      const { sink, rec } = recordingSink();
      own = { why, result: run(sink), rec };
      return true;
    };
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    const first = await d.runTurn({ turnId: "t1", prompt: "BACKGROUND_HELPER go", systemNote: null }, recordingSink().sink);
    expect(first.ok).toBe(true);
    for (let i = 0; i < 200 && !own; i++) await Bun.sleep(10);
    expect(own).not.toBeNull();
    const o = own!;
    expect(await o.result).toMatchObject({ ok: true });
    expect(o.rec.text).toContain("all tests pass");
    expect(o.why).toContain("helpers");
    for (let i = 0; i < 100 && reports[reports.length - 1]?.[0]?.status !== "completed"; i++) await Bun.sleep(10);
    expect(reports[reports.length - 1][0]).toMatchObject({ id: "task1", description: "Check the build", agentType: "general-purpose", background: true, status: "completed", summary: "All tests pass", toolUses: 3, lastTool: "Bash" });
    await d.dispose();
  });

  test("a chat's standing notes (connected computers) reach Claude Code as extra instructions", async () => {
    const c = ctx("claude");
    c.chat = { helper: null, notes: "Other computers you can run commands on: macbook." };
    const argsFile = join(c.room.cwd, "args.jsonl");
    c.env.FAKE_CLAUDE_ARGS_OUT = argsFile;
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    await d.runTurn({ turnId: "t1", prompt: "hi", systemNote: null }, recordingSink().sink);
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]);
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(prompt.startsWith("Other computers you can run commands on: macbook.\n\n")).toBe(true);
    expect(prompt).toContain("Helper agents you start run on this chat's model and effort.");
    await d.dispose();
  });

  test("a helper's model, effort and context come from the end of its transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-helper-"));
    const path = join(dir, "agent-a1.jsonl");
    const line = (o: unknown) => JSON.stringify(o) + "\n";
    writeFileSync(
      path,
      line({ type: "user", effort: "high", message: { role: "user", content: "Find the bug" } }) +
        line({ type: "assistant", effort: "high", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 40000, cache_creation_input_tokens: 1000, output_tokens: 500 } } }) +
        line({ type: "assistant", effort: "high", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }) +
        "{not json\n",
    );
    // The window is the one Claude Code's model list gives that model; unknown, it's left out rather than guessed.
    expect(helperDetails(path, (m) => (m === "claude-sonnet-5-5" ? 1_000_000 : null))).toEqual({ model: "claude-sonnet-5-5", effort: "high", contextTokens: 41502, contextWindow: 1_000_000 });
    expect(helperDetails(path)).toEqual({ model: "claude-sonnet-5-5", effort: "high", contextTokens: 41502, contextWindow: null });
    expect(helperDetails(join(dir, "missing.jsonl"))).toBeNull();
  });

  test("interrupt ends the turn as stopped", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const { sink, rec } = recordingSink();
    const p = d.runTurn({ turnId: "t1", prompt: "INTERRUPT_ME please", systemNote: null }, sink);
    for (let i = 0; i < 100 && !rec.activities.length; i++) await Bun.sleep(10);
    rec.abort.abort();
    const res = await p;
    expect(res).toEqual({ ok: false, error: "stopped" });
    await d.dispose();
  });

  test("a signed-out CLI produces a helpful error", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const { sink, rec } = recordingSink();
    const res = await d.runTurn({ turnId: "t1", prompt: "FAIL_AUTH", systemNote: null }, sink);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("isn't signed in");
    // The CLI's own "Please run /login" reply isn't posted; the room shows the hub's error instead.
    expect(rec.text).toBe("");
    await d.dispose();
  });

  // Carrying on when a limit resets (limits.ts) hangs on telling a limit from everything else, so each agent's real
  // event shapes are checked here, through its fake CLI: a limit, a lookalike that must never wait, with and without
  // a reset time.
  test("a plan limit ends the turn as a limit to wait for, with the window's reset time", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const res = await d.runTurn({ turnId: "t1", prompt: "PLAN_LIMIT please build it", systemNote: null }, recordingSink().sink);
    expect(res.ok).toBe(false);
    expect(res.limit).toMatchObject({ kind: "usage", label: "5-hour", source: "event" });
    expect(res.limit!.resetsAt).toBeGreaterThan(Date.now());
    expect(res.error).toContain("You've hit your session limit"); // Claude Code's own words, kept
    await d.dispose();
  });

  test("a plan limit that says nothing about when is still a limit, with no time", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const res = await d.runTurn({ turnId: "t1", prompt: "PLAN_LIMIT_NO_RESET", systemNote: null }, recordingSink().sink);
    expect(res.ok).toBe(false);
    expect(res.limit).toMatchObject({ kind: "usage", label: "5-hour", resetsAt: null, source: "none" });
    await d.dispose();
  });

  test("a window full but still allowed (paid extra usage) never makes an ordinary failure a limit", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const { sink, rec } = recordingSink();
    const res = await d.runTurn({ turnId: "t1", prompt: "OVERAGE_ERROR", systemNote: null }, sink);
    expect(res.ok).toBe(false);
    // Nothing was refused: a 500 on an account running on overage is a plain error, not a wait.
    expect(res.limit ?? null).toBe(null);
    // The window is still reported for the usage page.
    expect(rec.rate.at(-1)!.windows).toMatchObject([{ usedPercent: 100 }]);
    await d.dispose();
  });

  test("a refused request the turn got past isn't the reason it later failed", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const res = await d.runTurn({ turnId: "t1", prompt: "LIMIT_THEN_OUTPUT", systemNote: null }, recordingSink().sink);
    expect(res.ok).toBe(false);
    expect(res.limit ?? null).toBe(null);
    await d.dispose();
  });

  test("a credits error reads like a limit but never waits: it has no reset", async () => {
    const d = new ClaudeDriver(ctx("claude"), join(FIX, "fake-claude"));
    const res = await d.runTurn({ turnId: "t1", prompt: "CREDITS_REQUIRED", systemNote: null }, recordingSink().sink);
    expect(res.ok).toBe(false);
    expect(res.limit ?? null).toBe(null);
    expect(res.error).toContain("Claude plan limit reached"); // the wording is unchanged; only the waiting isn't offered
    await d.dispose();
  });

  test("a missing binary reports an error instead of hanging", async () => {
    const d = new ClaudeDriver(ctx("claude"), "/nonexistent/claude");
    const res = await d.runTurn({ turnId: "t1", prompt: "hi", systemNote: null }, recordingSink().sink);
    expect(res.ok).toBe(false);
  });
});

describe("ACP driver (Gemini CLI protocol, against a fake agent)", () => {
  const run = async (decision: ApprovalDecision) => {
    const d = new AcpDriver("gemini", ctx("gemini"), [join(FIX, "fake-acp")], { name: "Gemini CLI" });
    const { sink, rec } = recordingSink(() => decision);
    const res = await d.runTurn({ turnId: "t1", prompt: "edit it", systemNote: null }, sink);
    await d.dispose();
    return { res, rec };
  };
  test("approve picks allow_once and streams the reply", async () => {
    const { res, rec } = await run("approve");
    expect(res.ok).toBe(true);
    expect(rec.text).toContain("Checking the project.");
    expect(rec.text).toContain("option yes");
    expect(rec.approvals[0]).toMatchObject({ kind: "file_change", title: "Edit config.json" });
    const edit = rec.activities.find((a) => a.kind === "file_change")!;
    expect(edit.status).toBe("done");
    expect(rec.activities.find((a) => a.kind === "plan")!.detailOut).toContain("▸ Edit config");
    expect(rec.session.acpSessionId).toBe("sess-1");
  });
  test("always-allow and deny map to the agent's options", async () => {
    expect((await run("approve_always")).rec.text).toContain("option always");
    const denied = await run("deny");
    expect(denied.rec.text).toContain("option no");
    expect(denied.rec.activities.find((a) => a.kind === "file_change")!.status).toBe("error");
  });
});

describe("model catalogs", () => {
  test("Claude Code's initialize models: the default entry marks its model instead of being one", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    const opts = claudeModelOptions([
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: levels },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks", supportsEffort: true, supportedEffortLevels: levels },
      { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges", supportsEffort: true, supportedEffortLevels: levels },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
      { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5 (full name)", supportsEffort: true, supportedEffortLevels: levels },
    ]);
    expect(opts.map((o) => o.id)).toEqual(["opus", "fable", "haiku", "claude-opus-5-5"]);
    expect(opts.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["opus"]);
    expect(opts.find((o) => o.id === "haiku")!.efforts).toEqual([]);
    expect(opts.find((o) => o.id === "fable")!.efforts).toEqual(levels);
  });
  test("Codex model/list: its usual models in its order, then the ones it keeps out of its picker, for More models", () => {
    const opts = codexModelOptions([
      { id: "secret", model: "secret", displayName: "Hidden", description: "Kept out of the picker.", hidden: true, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }] },
      { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Latest workhorse model.", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "ultra", description: "" }], serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }] },
      { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, isDefault: false, supportedReasoningEfforts: [] },
    ]);
    expect(opts).toEqual([
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "Latest workhorse model.", efforts: ["low", "ultra"], defaultEffort: "low", isDefault: true, fast: { label: "Fast", description: "2x speed, increased usage" } },
      { id: "gpt-6-luna", label: "GPT-6-Luna", description: null, efforts: [], defaultEffort: null, isDefault: false, fast: null },
      { id: "secret", label: "Hidden", description: "Kept out of the picker.", efforts: ["medium"], defaultEffort: "medium", isDefault: false, fast: null, more: true },
    ]);
  });
});

describe("usage parsing", () => {
  test("Claude /usage text", () => {
    const now = new Date("2026-10-03T12:00:00");
    const text = `
  Current session
  ████████▌            23% used
  Resets 3:59pm (America/New_York)

  Current week (all models)
  ███████████████      41% used
  Resets Oct 7, 9am (America/New_York)

  Current week (Opus)
  ██                   5% used
  Resets Oct 7, 9am
`;
    const w = parseClaudeUsage(text, now);
    expect(w.map((x) => [x.label, x.usedPercent])).toEqual([
      ["5-hour", 23],
      ["Weekly", 41],
      ["Weekly (Opus)", 5],
    ]);
    expect(new Date(w[0].resetsAt!).getHours()).toBe(15);
    expect(new Date(w[1].resetsAt!).getDate()).toBe(7);
  });
  test("Claude /usage text as Claude Code 2.1 prints it (one line per limit)", () => {
    const now = new Date("2026-10-03T23:20:00");
    const text = `You are currently using your subscription to power your Claude Code usage

Current session: 21% used · resets Oct 4 at 1:19am (America/New_York)
Current week (all models): 4% used · resets Oct 6 at 8:59am (America/New_York)
Current week (Fable): 0% used · resets Oct 6 at 9am (America/New_York)

What's contributing to your limits usage?
Last 24h · 105 requests · 3 sessions
  88% of your usage was at >150k context
  Top MCP servers: terminal 3%, Claude Browser 2%`;
    const w = parseClaudeUsage(text, now);
    expect(w.map((x) => [x.label, x.usedPercent])).toEqual([
      ["5-hour", 21],
      ["Weekly", 4],
      ["Weekly (Fable)", 0],
    ]);
    expect(new Date(w[0].resetsAt!).toString()).toBe(new Date("2026-10-04T01:19:00").toString());
    expect(new Date(w[2].resetsAt!).toString()).toBe(new Date("2026-10-06T09:00:00").toString());
  });
  test("relative reset times", () => {
    const now = new Date("2026-10-03T12:00:00");
    expect(parseResetTime("in 2h 30m", now)).toBe(now.getTime() + 9000_000);
  });
  test("Claude rate_limit_event", () => {
    expect(claudeRateWindow({ utilization: 0.9, resetsAt: 1_800_000_000, rateLimitType: "seven_day" })).toEqual({ label: "Weekly", usedPercent: 90, resetsAt: 1_800_000_000_000 });
    expect(claudeRateWindow({ status: "allowed" })).toBeNull();
  });
  test("Codex rate limits", () => {
    const u = codexUsage({ primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1791580419 }, secondary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1791050000 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "prolite" });
    expect(u.plan).toBe("ChatGPT Pro Lite");
    expect(u.windows).toEqual([
      { label: "Weekly", usedPercent: 22, resetsAt: 1791580419000 },
      { label: "5-hour", usedPercent: 3, resetsAt: 1791050000000 },
    ]);
  });
});

describe("Claude Code driver when the CLI freezes", () => {
  test("Stop ends a frozen Claude Code that ignores SIGTERM, and the next turn starts a fresh process", async () => {
    const { processGrace } = await import("../src/util/process");
    const grace = ClaudeDriver.graceMs;
    const killGrace = processGrace.ms;
    ClaudeDriver.graceMs = 100;
    processGrace.ms = 100;
    try {
      const c = ctx("claude");
      const mark = join(c.room.cwd, "frozen.pid");
      c.env.FAKE_FREEZE_MARK = mark;
      const d = new ClaudeDriver(c, join(FIX, "fake-claude-frozen-once"));
      const first = recordingSink();
      const p1 = d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, first.sink);
      while (!existsSync(mark)) await Bun.sleep(10);
      const pid = Number(readFileSync(mark, "utf8").trim());
      first.rec.abort.abort();
      expect(await p1).toEqual({ ok: false, error: "stopped" });
      await Bun.sleep(400); // SIGTERM is ignored; SIGKILL follows after the grace period
      expect(() => process.kill(pid, 0)).toThrow(); // gone
      const second = recordingSink();
      const r2 = await d.runTurn({ turnId: "t2", prompt: "hello again", systemNote: null }, second.sink);
      expect(r2.ok).toBe(true);
      await d.dispose();
    } finally {
      ClaudeDriver.graceMs = grace;
      processGrace.ms = killGrace;
    }
  });
});

describe("Claude Code driver: Stop races and fallbacks", () => {
  test("Stop then an immediate new turn: the frozen process is ended and the new turn runs on a fresh one", async () => {
    const { processGrace } = await import("../src/util/process");
    const grace = ClaudeDriver.graceMs;
    const killGrace = processGrace.ms;
    ClaudeDriver.graceMs = 100;
    processGrace.ms = 100;
    try {
      const c = ctx("claude");
      const mark = join(c.room.cwd, "frozen.pid");
      c.env.FAKE_FREEZE_MARK = mark;
      const d = new ClaudeDriver(c, join(FIX, "fake-claude-frozen-once"));
      const first = recordingSink();
      const p1 = d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, first.sink);
      while (!existsSync(mark)) await Bun.sleep(10);
      const pid = Number(readFileSync(mark, "utf8").trim());
      first.rec.abort.abort();
      // No waiting: the next message arrives straight away.
      const r2 = await d.runTurn({ turnId: "t2", prompt: "next", systemNote: null }, recordingSink().sink);
      expect(r2.ok).toBe(true);
      expect(await p1).toEqual({ ok: false, error: "stopped" });
      // A hub shutting down waits for the retired process too, not only the driver's current one.
      await d.dispose();
      await processesEnding();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      ClaudeDriver.graceMs = grace;
      processGrace.ms = killGrace;
    }
  });

  test("if the fallback without --thinking-display also fails, the turn still ends", async () => {
    const c = ctx("claude");
    const bin = join(c.room.cwd, "failing-claude");
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--thinking-display" ] && { echo "error: unknown option '--thinking-display'" >&2; exit 1; }; done\necho "broken install" >&2\nexit 3\n`);
    chmodSync(bin, 0o755);
    const d = new ClaudeDriver(c, bin);
    const r = await Promise.race([d.runTurn({ turnId: "t1", prompt: "hi", systemNote: null }, recordingSink().sink), Bun.sleep(5000).then(() => "hung")]);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("code 3");
    await d.dispose();
  });
});

describe("Codex and Gemini: Stop then an immediate new turn", () => {
  async function stuckOnce(make: (c: DriverContext, mark: string) => { runTurn: ClaudeDriver["runTurn"]; dispose(): Promise<void> }, provider: Member["provider"]) {
    const { processGrace } = await import("../src/util/process");
    const killGrace = processGrace.ms;
    processGrace.ms = 100;
    try {
      const c = ctx(provider);
      const mark = join(c.room.cwd, "frozen.pid");
      const d = make(c, mark);
      const first = recordingSink();
      const p1 = d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, first.sink);
      while (!existsSync(mark)) await Bun.sleep(10);
      const pid = Number(readFileSync(mark, "utf8").trim());
      first.rec.abort.abort();
      // No waiting: the next message arrives straight away.
      const second = recordingSink();
      const r2 = await Promise.race([d.runTurn({ turnId: "t2", prompt: "next", systemNote: null }, second.sink), Bun.sleep(8000).then(() => ({ ok: false, error: "hung" }))]);
      expect(r2.ok).toBe(true);
      expect((await p1).ok).toBe(false);
      await Bun.sleep(300);
      expect(() => process.kill(pid, 0)).toThrow(); // the stuck process is gone
      await d.dispose();
      return second.rec;
    } finally {
      processGrace.ms = killGrace;
    }
  }

  test("Codex: the stuck app-server is retired, and its turn's late events can't end the new one", async () => {
    const rec = await stuckOnce((c, mark) => {
      c.env.FAKE_CODEX_FREEZE_MARK = mark;
      return new CodexDriver(c, join(FIX, "fake-codex-app"));
    }, "codex");
    expect(rec.text).toContain("Done.");
  });

  test("Gemini (ACP): the stuck process is retired and the new turn runs on a fresh one", async () => {
    await stuckOnce((c, mark) => {
      c.env.FAKE_ACP_FREEZE_MARK = mark;
      return new AcpDriver("gemini", c, [join(FIX, "fake-acp")], { name: "Gemini CLI" });
    }, "gemini");
  });
});

describe("custom models (a model server of your own)", () => {
  const endpoint = { id: "ep1", label: "Qwen local", baseUrl: "http://127.0.0.1:8080", models: ["qwen3.8-27b", "other"], contextWindow: 65536, key: "" };

  test("Claude Code compacts well before the server's context runs out", async () => {
    const c = { ...ctx("claude"), endpoint };
    const argsFile = join(c.room.cwd, "args.jsonl");
    c.env.FAKE_CLAUDE_ARGS_OUT = argsFile;
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    const { sink } = recordingSink();
    expect((await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, sink)).ok).toBe(true);
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]) as string[];
    expect(JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"))).toMatchObject({ autoCompactWindow: 49152 });
    await d.dispose();
  });

  test("Claude Code on another of the server's models: answers and compaction fit that model's context, not the first one's", async () => {
    // The account's environment caps answers for its first model; the chat is on a smaller one (App.endpointFor gives its size).
    const c = { ...ctx("claude", {}, { model: "other" }), endpoint: { ...endpoint, contextWindow: 32_768 } };
    const argsFile = join(c.room.cwd, "args.jsonl");
    const envFile = join(c.room.cwd, "env.jsonl");
    Object.assign(c.env, { FAKE_CLAUDE_ARGS_OUT: argsFile, FAKE_CLAUDE_ENV_OUT: envFile, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16384" });
    const d = new ClaudeDriver(c, join(FIX, "fake-claude"));
    const { sink } = recordingSink();
    expect((await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, sink)).ok).toBe(true);
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]) as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("other");
    expect(JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"))).toMatchObject({ autoCompactWindow: 24576 });
    expect(JSON.parse(readFileSync(envFile, "utf8").trim().split("\n")[0]).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
    await d.dispose();
  });

  test("Codex: a usage limit ends the turn as one, with the reset from the account's own windows", async () => {
    // Its own CODEX_HOME: a Codex driver must never reach the user's running Codex (AGENTS.md).
    const c = ctx("codex");
    c.env.CODEX_HOME = join(c.room.cwd, "codex-home");
    const d = new CodexDriver(c, join(FIX, "fake-codex-app"));
    const res = await d.runTurn({ turnId: "t1", prompt: "USAGE_LIMIT please build it", systemNote: null }, recordingSink().sink);
    expect(res.ok).toBe(false);
    expect(res.limit).toMatchObject({ kind: "usage", label: "5-hour", source: "snapshot" });
    expect(res.limit!.resetsAt).toBeGreaterThan(Date.now());
    await d.dispose();
  });

  test("Codex: with no windows it still waits, and its own session budget never does", async () => {
    const c = ctx("codex");
    c.env.CODEX_HOME = join(c.room.cwd, "codex-home");
    const d = new CodexDriver(c, join(FIX, "fake-codex-app"));
    const none = await d.runTurn({ turnId: "t1", prompt: "USAGE_LIMIT_NO_RESET", systemNote: null }, recordingSink().sink);
    expect(none.limit).toMatchObject({ kind: "usage", resetsAt: null, source: "none" });
    const budget = await d.runTurn({ turnId: "t2", prompt: "SESSION_BUDGET", systemNote: null }, recordingSink().sink);
    expect(budget.ok).toBe(false);
    expect(budget.limit ?? null).toBe(null);
    await d.dispose();
  });

  test("Codex threads use the server's Responses API, its first model by default, and its context size", async () => {
    const c = { ...ctx("codex"), endpoint: { ...endpoint, key: "sk-local" } };
    const log = join(c.room.cwd, "thread.json");
    c.env.FAKE_CODEX_LOG = log;
    const d = new CodexDriver(c, join(FIX, "fake-codex-app"));
    const { sink } = recordingSink();
    expect((await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, sink)).ok).toBe(true);
    const params = JSON.parse(readFileSync(log, "utf8"));
    expect(params.model).toBe("qwen3.8-27b");
    expect(params.config).toMatchObject({
      model_provider: "crosstalk_ep1",
      model_providers: { crosstalk_ep1: { name: "Qwen local", base_url: "http://127.0.0.1:8080/v1", wire_api: "responses", requires_openai_auth: false, http_headers: { Authorization: "Bearer sk-local" } } },
      model_context_window: 65536,
      model_auto_compact_token_limit: 49152,
    });
    await d.dispose();
  });

  test("Codex long context: the chat asks for the most its model allows, and only then", async () => {
    const astra = { id: "gpt-test", label: "GPT test", description: null, efforts: [], defaultEffort: null, isDefault: true, contextWindow: 272_000, usableContext: 258_400, compactAt: 244_800, maxContextWindow: 872_000 };
    const started = async (config: Record<string, unknown>, info: typeof astra | null) => {
      const asked: (string | null)[] = [];
      const c = { ...ctx("codex", {}, { config }), modelInfo: async (m: string | null) => (asked.push(m), info) };
      const log = join(c.room.cwd, "thread.json");
      c.env.FAKE_CODEX_LOG = log;
      const d = new CodexDriver(c, join(FIX, "fake-codex-app"));
      expect((await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, recordingSink().sink)).ok).toBe(true);
      await d.dispose();
      return { config: JSON.parse(readFileSync(log, "utf8")).config, asked };
    };
    // On "Default" the model is Codex's default, so that's the one asked about.
    const long = await started({ longContext: true }, astra);
    expect(long.config.model_context_window).toBe(872_000);
    expect(long.asked).toEqual([null]);
    // Off, or a model with no larger window: Codex's own window, and the model list isn't asked.
    const off = await started({}, astra);
    expect(off.config.model_context_window).toBeUndefined();
    expect(off.asked).toEqual([]);
    expect((await started({ longContext: true }, { ...astra, maxContextWindow: null as unknown as number })).config.model_context_window).toBeUndefined();
    expect((await started({ longContext: true }, null)).config.model_context_window).toBeUndefined();
  });
});

describe("Claude Code driver with an older CLI", () => {
  test("drops --thinking-display if this Claude Code doesn't know it, and the turn still completes", async () => {
    const c = ctx("claude");
    const argsFile = join(c.room.cwd, "args.jsonl");
    c.env.FAKE_CLAUDE_ARGS_OUT = argsFile;
    // An "older" CLI: rejects the option the way Commander does, otherwise behaves like the fake.
    const old = join(c.room.cwd, "old-claude");
    writeFileSync(old, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--thinking-display" ] && { echo "error: unknown option '--thinking-display'" >&2; exit 1; }; done\nexec "${join(FIX, "fake-claude")}" "$@"\n`);
    chmodSync(old, 0o755);
    const d = new ClaudeDriver(c, old);
    const { sink, rec } = recordingSink();
    const res = await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: "You are @claude" }, sink);
    expect(res.ok).toBe(true);
    expect(rec.text).toContain("Done.");
    const runs = readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(runs.every((a) => !a.includes("--thinking-display"))).toBe(true); // only the retry reached the fake
    await d.dispose();
  });
});

describe("Antigravity CLI driver (against a fake headless CLI)", () => {
  test("streams text and tool steps, reports usage, keeps the conversation, and briefs only the first message", async () => {
    const c = ctx("antigravity", {}, { permissionMode: "full", model: "gemini-3.8-flash-medium", config: { effort: "high" } });
    const argsFile = join(c.room.cwd, "args.jsonl");
    c.env.FAKE_AGY_ARGS_OUT = argsFile;
    const d = new AntigravityDriver(c, join(FIX, "fake-agy"));
    const first = recordingSink();
    const r1 = await d.runTurn({ turnId: "t1", prompt: "build it", systemNote: "You are @antigravity" }, first.sink);
    expect(r1.ok).toBe(true);
    expect(first.rec.text).toBe("Hello from turn 1.");
    expect(first.rec.activities.map((a) => [a.kind, a.title, a.status])).toEqual([["command", "ls", "done"]]);
    expect(first.rec.activities[0].detailOut).toBe("README.md\n");
    expect(first.rec.usage).toMatchObject({ inputTokens: 100, outputTokens: 25, cachedInputTokens: 40 });
    expect(first.rec.session.conversationId).toBe("conv-1");
    const second = recordingSink();
    const r2 = await d.runTurn({ turnId: "t2", prompt: "again", systemNote: null }, second.sink);
    expect(r2.ok).toBe(true);
    expect(second.rec.text).toBe("Hello from turn 2.");
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]) as string[];
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "gemini-3.8-flash-medium"]));
    // agy rejects --effort alongside a model name that already says "medium".
    expect(args).not.toContain("--effort");
    await d.dispose();
  });

  test("a saved effort is never passed, even with no model or a model without an effort in its name", async () => {
    for (const model of [null, "claude-sonnet-4-6"]) {
      const c = ctx("antigravity", {}, { model, config: { effort: "max" } });
      c.env.FAKE_AGY_QUIET = "1";
      c.env.FAKE_AGY_ARGS_OUT = join(c.room.cwd, "args.jsonl");
      const d = new AntigravityDriver(c, join(FIX, "fake-agy"));
      await d.runTurn({ turnId: "t1", prompt: "hi", systemNote: null }, recordingSink().sink);
      expect(readFileSync(c.env.FAKE_AGY_ARGS_OUT, "utf8")).not.toContain("--effort");
      await d.dispose();
    }
  });

  test("a declined command doesn't end in a blank reply: the agent is told once, then the reason is shown", async () => {
    const c = ctx("antigravity", {}, { permissionMode: "auto" });
    c.env.FAKE_AGY_DENY = "1";
    c.env.FAKE_AGY_QUIET = "1";
    const d = new AntigravityDriver(c, join(FIX, "fake-agy"));
    const { sink, rec } = recordingSink();
    const r = await d.runTurn({ turnId: "t1", prompt: "check the build", systemNote: null }, sink);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Quiet reply 2 to:"); // the follow-up's answer
    expect(rec.activities.map((a) => [a.title, a.status])).toEqual([["ls", "error"]]);
    expect(rec.activities[0].detailOut).toContain("permission check failed");
    expect(rec.usage).toMatchObject({ inputTokens: 110, outputTokens: 17 }); // both requests counted
    await d.dispose();
    const stuck = ctx("antigravity", {}, { permissionMode: "auto" });
    stuck.env.FAKE_AGY_DENY = "always";
    const d2 = new AntigravityDriver(stuck, join(FIX, "fake-agy"));
    const r2 = await d2.runTurn({ turnId: "t1", prompt: "check the build", systemNote: null }, recordingSink().sink);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("RunCommand");
    expect(r2.error).toContain("Full access");
    await d2.dispose();
    // The follow-up comes back empty without listing the denial again: still explained, not "(no reply)".
    const silent = ctx("antigravity", {}, { permissionMode: "auto" });
    silent.env.FAKE_AGY_DENY = "then-silent";
    const d3 = new AntigravityDriver(silent, join(FIX, "fake-agy"));
    const r3 = await d3.runTurn({ turnId: "t1", prompt: "check the build", systemNote: null }, recordingSink().sink);
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain("RunCommand");
    await d3.dispose();
  });

  test("uses the final result when nothing streams, resumes a saved conversation, and explains a missing sign-in", async () => {
    const quiet = ctx("antigravity", { conversationId: "conv-9" });
    quiet.env.FAKE_AGY_QUIET = "1";
    quiet.env.FAKE_AGY_ARGS_OUT = join(quiet.room.cwd, "args.jsonl");
    const d = new AntigravityDriver(quiet, join(FIX, "fake-agy"));
    const { sink } = recordingSink();
    const r = await d.runTurn({ turnId: "t1", prompt: "hello there", systemNote: null }, sink);
    expect(r).toEqual({ ok: true, text: "Quiet reply 1 to: hello there" });
    expect(readFileSync(quiet.env.FAKE_AGY_ARGS_OUT, "utf8")).toContain('"--conversation","conv-9"');
    await d.dispose();
    const out = ctx("antigravity");
    out.env.FAKE_AGY_SIGNED_OUT = "1";
    const d2 = new AntigravityDriver(out, join(FIX, "fake-agy"));
    const r2 = await d2.runTurn({ turnId: "t1", prompt: "hi", systemNote: null }, recordingSink().sink);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("isn't signed in");
    await d2.dispose();
  });

  test("Stop then an immediate new turn: the stopped process can't end the new turn", async () => {
    const c = ctx("antigravity");
    c.env.FAKE_AGY_SLOW = "400";
    c.env.FAKE_AGY_QUIET = "1";
    const d = new AntigravityDriver(c, join(FIX, "fake-agy"));
    const first = recordingSink();
    const p1 = d.runTurn({ turnId: "t1", prompt: "slow one", systemNote: null }, first.sink);
    await Bun.sleep(60);
    first.rec.abort.abort();
    expect(await p1).toEqual({ ok: false, error: "stopped" });
    // Straight away, before the killed process has finished exiting.
    const r2 = await d.runTurn({ turnId: "t2", prompt: "next one", systemNote: null }, recordingSink().sink);
    expect(r2).toEqual({ ok: true, text: "Quiet reply 1 to: next one" });
    // Aborting the old, finished turn's signal again does nothing to later turns.
    first.rec.abort.abort();
    const r3 = await d.runTurn({ turnId: "t3", prompt: "third", systemNote: null }, recordingSink().sink);
    expect(r3).toEqual({ ok: true, text: "Quiet reply 2 to: third" });
    await d.dispose();
  });

  test("permission settings map to the CLI's closest non-interactive modes; model lists parse", () => {
    expect(agyPermissionArgs("ask")).toEqual([]);
    expect(agyPermissionArgs("edits")).toEqual(["--mode", "accept-edits"]);
    expect(agyPermissionArgs("auto")).toEqual(["--mode", "accept-edits"]);
    expect(agyPermissionArgs("full")).toEqual(["--dangerously-skip-permissions"]);
    // Real `agy models` output (1.2.16): "slug<TAB>Description".
    const models = parseAgyModels("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
    expect(models.map((m) => [m.id, m.label, m.efforts.length])).toEqual([["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", 0], ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)", 0], ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", 0]]);
    expect(models.map((m) => m.defaultEffort)).toEqual(["high", "low", null]); // shown as "included in this model"
  });
});
