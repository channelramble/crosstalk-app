// Crosstalk's own agent (agents/builtin.ts): a chat that runs on a model service directly — here the stand-in NanoGPT
// (fixtures/fake-nanogpt.ts), which streams scripted answers — with its own tools for commands, files and BrowserOS neo
// (a stand-in MCP server below). No agent program, no key of the user's, no model request anywhere real.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, Room, Turn } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { BuiltinDriver, CHECK_NUDGE, asks, clip, inProject, pageText, plainSchema, projectNotes, serviceError, type BuiltinDeps } from "../src/agents/builtin";
import type { ActivityInput, ApprovalRequest, DriverContext, TurnSink } from "../src/agents/driver";
import { editText } from "../src/agents/editMatch";
import { EMPTY_ANSWER_NUDGE, TEXT_TOOL_CALL_NUDGE } from "../src/agents/toolText";
import { App } from "../src/app";
import { Bus } from "../src/bus";
import { Store } from "../src/db";
import { Engine } from "../src/engine/engine";
import { builtinProvider } from "../src/providers/builtin";
import { registerProvider } from "../src/providers/index";
import { challengeWords } from "../src/refuseless";
import { newId } from "../src/util/ids";
import { fakeNanoGpt, type ScriptedReply } from "./fixtures/fake-nanogpt";
import { fakeRefuseless, type RefuselessReply } from "./fixtures/fake-refuseless";
import { strictFetch } from "./fixtures/strict-service";

const KEY = "sk-nano-test-key-0001";
const PICK = "deepseek/deepseek-v4.1-flash-uncensored";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RL_KEY = "abl_test_key_0001";
const RL_PICK = "deepseek-v4.1-flash-abliterated";

/** The stand-in Refuseless, with its own scripted answers. */
function rl(replies: RefuselessReply[], o: { challenge?: boolean } = {}) {
  const fake = fakeRefuseless({ key: RL_KEY, replies, ...o });
  cleanups.push(() => fake.stop());
  return fake;
}

/** A chat's context on the stand-in Refuseless. */
const rlCtx = (fake: { base: string }, cwd: string, memberId = "mb-rl", o: CtxOptions = {}) => ctxFor(fake, cwd, { key: RL_KEY, label: "Refuseless", model: RL_PICK, memberId, ...o });

function nano(replies: ScriptedReply[]) {
  const fake = fakeNanoGpt({ key: KEY, replies });
  cleanups.push(() => fake.stop());
  return fake;
}

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "ct-agent-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** What a reply sent to the phone: its text, its cards, the approvals it asked for, the usage it reported. */
function sinkFor(decisions: ApprovalDecision[] = []) {
  const ac = new AbortController();
  const out = {
    text: "",
    activities: [] as (ActivityInput & { detail: string })[],
    approvals: [] as ApprovalRequest[],
    usage: [] as object[],
    /** How many times it said it's alive. */
    beats: 0,
    /** What it saved in the member's session. */
    session: {} as Record<string, unknown>,
    stop: () => ac.abort(),
  };
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
      Object.assign(a, rest);
      if (appendDetail) a.detail += appendDetail;
    },
    approval: async (req) => {
      out.approvals.push(req);
      return decisions.shift() ?? "deny";
    },
    usage: (u) => void out.usage.push(u),
    rateLimit: () => {},
    status: () => {},
    saveSession: (patch) => void Object.assign(out.session, patch),
    newReply: () => {},
    heartbeat: () => void out.beats++,
    taken: () => {},
    signal: ac.signal,
  };
  return { sink, out };
}

type CtxOptions = { mode?: string; key?: string; contextWindow?: number; memberId?: string; label?: string; model?: string; config?: Record<string, unknown> };

/** A one-agent chat's context for the driver, on the stand-in NanoGPT. */
function ctxFor(fake: { base: string }, cwd: string, o: CtxOptions = {}): DriverContext {
  const model = o.model ?? PICK;
  return {
    room: { id: "r1", cwd, name: "Agent test" },
    member: { id: o.memberId ?? "mb-agent", provider: "builtin", model, permissionMode: o.mode ?? "full", config: o.config ?? {} },
    session: {},
    mcp: { command: "", args: [], env: {} },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
    bin: "",
    chat: null,
    endpoint: { id: "nano", label: o.label ?? "NanoGPT", baseUrl: `${fake.base}`, models: [model], contextWindow: o.contextWindow ?? 1_048_576, key: o.key ?? KEY },
  } as unknown as DriverContext;
}

function driver(ctx: DriverContext, deps: BuiltinDeps = {}) {
  const runDir = join(ctx.room.cwd, ".run");
  const d = new BuiltinDriver(ctx, { browserUrl: async () => null, runDir, ...deps });
  cleanups.push(() => d.dispose());
  return d;
}

const turn = (prompt: string, ids: string[] = []) => ({ turnId: `t-${prompt.slice(0, 8)}`, prompt, systemNote: null, messageIds: ids });

test("a reply runs a command, reads what it printed, and answers — with no agent program in between", async () => {
  const fake = nano([{ reasoning: "Run it first.", calls: [{ name: "run_command", args: { command: "echo hello-from-agent" } }], usage: { prompt: 1200, completion: 40, cached: 0 } }, { text: "It printed hello-from-agent.", usage: { prompt: 1300, completion: 20, cached: 1100 } }]);
  const cwd = folder();
  const { sink, out } = sinkFor();
  const r = await driver(ctxFor(fake, cwd)).runTurn(turn("Run echo for me"), sink);
  expect(r).toEqual({ ok: true });
  expect(out.text).toBe("It printed hello-from-agent.");
  expect(out.activities).toEqual([{ kind: "command", title: "echo hello-from-agent", detail: "hello-from-agent\n", status: "done" }]);
  // The model got the command's output and exit code, and the conversation in order.
  const [first, second] = fake.state.chats;
  expect(first.model).toBe(PICK);
  expect(first.stream).toBe(true);
  expect(first.messages[0].role).toBe("system");
  expect(first.messages[0].content).toContain(`Working folder: ${cwd}`);
  expect(first.messages[1]).toEqual({ role: "user", content: "Run echo for me" });
  expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["run_command", "read_file", "write_file", "edit_file", "list_files", "search_files", "fetch_url", "update_plan"]);
  expect(second.messages.at(-2)).toMatchObject({ role: "assistant", content: null, reasoning_content: "Run it first.", tool_calls: [{ type: "function", function: { name: "run_command", arguments: '{"command":"echo hello-from-agent"}' } }] });
  expect(second.messages.at(-1)).toMatchObject({ role: "tool", content: "hello-from-agent\n[exit code 0]" });
  // Both calls' tokens, for Costs.
  expect(out.usage.at(-1)).toEqual({ inputTokens: 2500, outputTokens: 60, cachedInputTokens: 1100, costUsd: null, contextTokens: 1320, contextWindow: 1_048_576 });
  // Only the key's own service ever saw it.
  expect(fake.seen.filter((s) => s.path === "/api/v1/chat/completions").every((s) => s.key === KEY)).toBe(true);
});

test("in Ask mode a command waits for approval; a declined one never runs, and the model is told", async () => {
  const fake = nano([{ calls: [{ name: "run_command", args: { command: "touch made-by-agent" } }] }, { text: "Okay, I left it." }]);
  const cwd = folder();
  const { sink, out } = sinkFor(["deny"]);
  expect(await driver(ctxFor(fake, cwd, { mode: "ask" })).runTurn(turn("Make a file"), sink)).toEqual({ ok: true });
  expect(out.approvals).toEqual([{ kind: "command", title: "touch made-by-agent", detail: "", always: "Always allow `touch made-by-agent` commands in this chat" }]);
  expect(existsSync(join(cwd, "made-by-agent"))).toBe(false);
  expect(fake.state.chats[1].messages.at(-1)).toMatchObject({ role: "tool", content: "The user declined this action." });
  expect(out.activities).toEqual([]);
});

test("Always allow is kept for the chat: the next command it covers runs without asking", async () => {
  const fake = nano([{ calls: [{ name: "run_command", args: { command: "echo one" } }] }, { calls: [{ name: "run_command", args: { command: "echo one more" } }] }, { text: "Both ran." }]);
  const cwd = folder();
  const { sink, out } = sinkFor(["approve_always"]);
  await driver(ctxFor(fake, cwd, { mode: "ask" })).runTurn(turn("Echo twice"), sink);
  expect(out.approvals).toHaveLength(1);
  expect(out.activities.map((a) => [a.title, a.status])).toEqual([
    ["echo one", "done"],
    ["echo one more", "done"],
  ]);
  // The rule is what's kept, not a word.
  expect(out.session.builtinAllowed).toEqual({ commands: ["echo one:*"] });
  // The permission rules themselves, for the record.
  expect(asks("edits", "file", {})).toBe(false);
  expect(asks("ask", "file", {})).toBe(true);
  expect(asks("ask", "file", { files: true })).toBe(false);
  expect(asks("edits", "command", { commands: ["git status:*"] }, "git status --short")).toBe(false);
  expect(asks("auto", "browser", {})).toBe(true);
  expect(asks("full", "browser", {})).toBe(false);
  expect(asks("ask", "read", {})).toBe(false);
});

test("Always allow is no wider than its words: another subcommand, or anything after a cd, still asks", async () => {
  // A chat that allowed `git` by its first word before this: that word covers nothing now, so it asks.
  expect(asks("edits", "command", { commands: ["git"] }, "git status")).toBe(true);
  expect(asks("edits", "command", { commands: ["git status:*"] }, "git push --force")).toBe(true);
  expect(asks("edits", "command", { commands: ["cd sub:*"] }, "cd sub && rm -rf everything")).toBe(true);
  expect(asks("edits", "command", { commands: ["cd sub:*", "ls:*"] }, "cd sub && ls -a")).toBe(false);
  expect(asks("edits", "command", { commands: ["ls:*"] }, "ls $(rm -rf everything)")).toBe(true);
  expect(asks("full", "command", {}, "git push --force")).toBe(false);

  const cwd = folder();
  mkdirSync(join(cwd, "sub"));
  const fake = nano([
    { calls: [{ name: "run_command", args: { command: "git status" } }] },
    { calls: [{ name: "run_command", args: { command: "git push --force" } }] },
    { calls: [{ name: "run_command", args: { command: "cd sub && ls" } }] },
    { calls: [{ name: "run_command", args: { command: "ls -a" } }] },
    { calls: [{ name: "run_command", args: { command: "cd sub && touch made-by-agent" } }] },
    { text: "That's all." },
  ]);
  const { sink, out } = sinkFor(["approve_always", "deny", "approve_always", "deny"]);
  await driver(ctxFor(fake, cwd, { mode: "ask" })).runTurn(turn("Go"), sink);
  expect(out.approvals.map((a) => [a.title, a.always])).toEqual([
    ["git status", "Always allow `git status` commands in this chat"],
    ["git push --force", "Always allow `git push` commands in this chat"],
    ["cd sub && ls", "Always allow `cd sub` and `ls` commands in this chat"],
    // `ls -a` was covered by what the last one allowed; this one's second part isn't.
    ["cd sub && touch made-by-agent", "Always allow `cd sub` and `touch made-by-agent` commands in this chat"],
  ]);
  expect(existsSync(join(cwd, "sub", "made-by-agent"))).toBe(false);
  expect(out.session.builtinAllowed).toEqual({ commands: ["git status:*", "cd sub:*", "ls:*"] });
});

test("Always allow: a command that can only be allowed once offers nothing to keep, and one kept exactly covers only itself", async () => {
  const cwd = folder();
  writeFileSync(join(cwd, "a.tmp"), "");
  const fake = nano([
    { calls: [{ name: "run_command", args: { command: "rm *.tmp" } }] },
    { calls: [{ name: "run_command", args: { command: "rm *.tmp" } }] },
    { calls: [{ name: "run_command", args: { command: "rm nothing.tmp" } }] },
    { calls: [{ name: "run_command", args: { command: "rm nothing.tmp" } }] },
    { calls: [{ name: "run_command", args: { command: "rm other.tmp" } }] },
    { text: "Stopped there." },
  ]);
  // A device that still sends "Always allow" for the first changes nothing: it's allowed once.
  const { sink, out } = sinkFor(["approve_always", "deny", "approve_always", "deny"]);
  await driver(ctxFor(fake, cwd, { mode: "ask" })).runTurn(turn("Tidy up"), sink);
  expect(out.approvals.map((a) => [a.title, a.always])).toEqual([
    ["rm *.tmp", null],
    ["rm *.tmp", null],
    ["rm nothing.tmp", "Always allow this exact command in this chat"],
    ["rm other.tmp", "Always allow this exact command in this chat"],
  ]);
  expect(out.session.builtinAllowed).toEqual({ commands: ["rm nothing.tmp"] });
});

test("files: edits go ahead in Edits mode, exact edits only, and reads come back numbered", async () => {
  const fake = nano([
    { calls: [{ name: "write_file", args: { path: "notes/todo.md", content: "one\ntwo\n" } }] },
    { calls: [{ name: "edit_file", args: { path: "notes/todo.md", old_string: "two", new_string: "three" } }] },
    { calls: [{ name: "edit_file", args: { path: "notes/todo.md", old_string: "missing", new_string: "x" } }] },
    { calls: [{ name: "read_file", args: { path: "notes/todo.md" } }] },
    { calls: [{ name: "search_files", args: { pattern: "thr+ee" } }] },
    { text: "Done." },
  ]);
  const cwd = folder();
  const { sink, out } = sinkFor();
  await driver(ctxFor(fake, cwd, { mode: "edits" })).runTurn(turn("Write notes"), sink);
  expect(out.approvals).toEqual([]);
  expect(readFileSync(join(cwd, "notes/todo.md"), "utf8")).toBe("one\nthree\n");
  const tools = fake.state.chats.slice(1).map((c) => c.messages.at(-1).content);
  expect(tools[0]).toBe(`Created ${join(cwd, "notes/todo.md")} (3 lines).`);
  expect(tools[1]).toBe(`Edited ${join(cwd, "notes/todo.md")} (1 place).`);
  expect(tools[2]).toContain("old_string isn't in");
  expect(tools[3]).toBe("1\tone\n2\tthree\n3\t");
  expect(tools[4]).toContain("notes/todo.md:2:three");
  expect(out.activities.map((a) => a.title)).toEqual(["Write notes/todo.md", "Edit notes/todo.md", "Edit notes/todo.md", "Read notes/todo.md", "Search for thr+ee"]);
});

/** A stand-in BrowserOS neo MCP server: one tool, answers in an event stream, and a session it remembers. */
function fakeBrowser() {
  const calls: { name: string; args: Record<string, unknown>; session: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const j = (await req.json()) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const sse = (result: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: j.id, result })}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" } });
      if (j.method === "initialize") return sse({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "browseros-neo", version: "0.51" } });
      if (j.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (req.headers.get("mcp-session-id") !== "s-1") return new Response("no session", { status: 404 });
      if (j.method === "tools/list") return sse({ tools: [{ name: "navigate", description: "Navigate a page to a URL.", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { url: { type: "string" }, page: { type: "number" } }, required: ["url"] } }] });
      if (j.method === "tools/call") {
        calls.push({ name: String(j.params?.name), args: j.params?.arguments ?? {}, session: req.headers.get("mcp-session-id") });
        return sse({ content: [{ type: "text", text: `navigated to ${String(j.params?.arguments?.url)}` }] });
      }
      return new Response("?", { status: 400 });
    },
  });
  cleanups.push(() => void server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/mcp`, calls };
}

test("BrowserOS neo: its tools are offered by name and called over MCP, and Ask mode asks before the browser acts", async () => {
  const browser = fakeBrowser();
  const fake = nano([{ calls: [{ name: "browseros__navigate", args: { url: "https://example.com", page: 1 } }] }, { text: "Opened it." }]);
  const cwd = folder();
  const { sink, out } = sinkFor(["approve"]);
  expect(await driver(ctxFor(fake, cwd, { mode: "ask" }), { browserUrl: async () => browser.url }).runTurn(turn("Open example.com"), sink)).toEqual({ ok: true });
  const offered = fake.state.chats[0].tools.find((t: { function: { name: string } }) => t.function.name === "browseros__navigate");
  // Its own schema, without the $schema line some services refuse.
  expect(offered.function).toEqual({ name: "browseros__navigate", description: "Navigate a page to a URL.", parameters: { type: "object", properties: { url: { type: "string" }, page: { type: "number" } }, required: ["url"] } });
  expect(fake.state.chats[0].messages[0].content).toContain("Prefer browseros__run");
  expect(out.approvals).toEqual([{ kind: "tool", title: "BrowserOS neo: navigate https://example.com", detail: '{\n  "url": "https://example.com",\n  "page": 1\n}', always: "Always allow BrowserOS neo in this chat" }]);
  expect(browser.calls).toEqual([{ name: "navigate", args: { url: "https://example.com", page: 1 }, session: "s-1" }]);
  expect(fake.state.chats[1].messages.at(-1)).toMatchObject({ role: "tool", content: "navigated to https://example.com" });
  expect(out.activities[0]).toMatchObject({ kind: "tool", title: "BrowserOS neo: navigate https://example.com", status: "done" });
});

test("the conversation is kept between replies and restarts, and a rewind cuts it back to before a message", async () => {
  const fake = nano([{ text: "First answer." }, { text: "Second answer." }, { text: "Third answer." }]);
  const cwd = folder();
  const ctx = ctxFor(fake, cwd);
  await driver(ctx).runTurn(turn("first", ["m1"]), sinkFor().sink);
  // A new driver for the same chat (the hub restarted) carries on with what was said.
  const again = driver(ctx);
  await again.runTurn(turn("second", ["m2"]), sinkFor().sink);
  expect(fake.state.chats[1].messages.slice(1).map((m: { content: string }) => m.content)).toEqual(["first", "First answer.", "second"]);
  expect(await again.rewind("m2")).toEqual(["m2"]);
  await again.runTurn(turn("instead", ["m3"]), sinkFor().sink);
  expect(fake.state.chats[2].messages.slice(1).map((m: { content: string }) => m.content)).toEqual(["first", "First answer.", "instead"]);
  await expect(again.rewind("nope")).rejects.toThrow("isn't in this conversation");
});

test("/compact summarises what came before and the chat goes on from the summary", async () => {
  const steps: ScriptedReply[] = Array.from({ length: 5 }, (_, i) => ({ calls: [{ name: "run_command", args: { command: `echo step-${i}` } }] }));
  const fake = nano([...steps, { text: "All five ran." }, { text: "SUMMARY: ran five echo commands." }, { text: "Carrying on." }]);
  const cwd = folder();
  const ctx = ctxFor(fake, cwd);
  const d = driver(ctx);
  await d.runTurn(turn("Run five echoes", ["m1"]), sinkFor().sink);
  const { sink, out } = sinkFor();
  expect(await d.runTurn(turn("/compact"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("Done: the conversation so far is summarised, and the chat goes on from the summary.");
  const summaryRequest = fake.state.chats.at(-1)!;
  expect(summaryRequest.stream).toBe(false);
  expect(summaryRequest.tool_choice).toBe("none");
  expect(out.activities).toEqual([{ kind: "notice", title: "Summarising the conversation so far", detail: "3 messages summarised.", status: "done" }]);
  await d.runTurn(turn("And now?", ["m2"]), sinkFor().sink);
  const next = fake.state.chats.at(-1)!.messages;
  expect(next[1].content).toBe("[A summary of the conversation before this point]\n\nSUMMARY: ran five echo commands.");
  // The task that started the reply stays as it was, after the summary.
  expect(next[3]).toEqual({ role: "user", content: "Run five echoes" });
  expect(next.at(-1)).toEqual({ role: "user", content: "And now?" });
});

test("the service's refusals in plain words: the key, money, and a rate limit that waits for its reset", async () => {
  const cwd = folder();
  const refused = await driver(ctxFor(nano([]), cwd, { key: "sk-nano-wrong" })).runTurn(turn("hi"), sinkFor().sink);
  // The key, never a sign-in (this agent has none: hub/test/builtin-signin.test.ts).
  expect(refused).toEqual({ ok: false, error: "NanoGPT refused the key — check it in Settings → AI services, then tap Try again." });
  const broke = await driver(ctxFor(nano([{ status: 402, error: "Insufficient balance" }]), cwd, { memberId: "mb-2" })).runTurn(turn("hi"), sinkFor().sink);
  expect(broke.ok).toBe(false);
  expect(broke.error).toContain("isn't enough money in the account");
  const limited = await driver(ctxFor(nano([{ status: 429, error: "Too many requests" }]), cwd, { memberId: "mb-3" })).runTurn(turn("hi"), sinkFor().sink);
  expect(limited.ok).toBe(false);
  expect(limited.limit).toMatchObject({ kind: "rate" });
});

test("helpers: a long output keeps its start and end, a page's tags are stripped, and a schema is made plain", () => {
  expect(plainSchema({ $schema: "x", type: "object", properties: { page: { type: ["integer", "null"], minimum: 0 }, any: { type: ["string", "number"] }, list: { type: "array", items: { type: ["boolean", "null"] } } } })).toEqual({
    type: "object",
    properties: { page: { type: "integer", minimum: 0 }, any: { type: ["string", "number"] }, list: { type: "array", items: { type: "boolean" } } },
  });
  const long = "a".repeat(50) + "b".repeat(50);
  expect(clip(long, 30)).toBe(`${"a".repeat(10)}\n\n[… 70 characters cut …]\n\n${"b".repeat(20)}`);
  expect(pageText("<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>")).toBe("Title\n One & two");
});

test("through the hub: NanoGPT's check offers Crosstalk's agent first, and a chat on it answers with no agent program", async () => {
  registerProvider(builtinProvider);
  registerDriver("builtin", (ctx) => new BuiltinDriver(ctx, { browserUrl: async () => null }));
  const fake = nano([{ calls: [{ name: "run_command", args: { command: "echo via-the-hub" } }] }, { text: "It said via-the-hub." }]);
  const dir = folder();
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(() => app.shutdown());
  app.services.timeoutMs = 1500;
  app.services.nanogpt.origin = fake.url;
  await app.providers.refresh("builtin");
  expect(app.providers.get("builtin")).toMatchObject({ installed: true, signedIn: true });

  const checked = await app.services.test({ baseUrl: fake.base, apiKey: KEY });
  expect(checked.works[0]).toEqual({ provider: "builtin", via: "chat" });
  expect(() => app.providers.setEndpointAccount("builtin", { label: "NanoGPT", baseUrl: fake.base, apiKey: KEY, models: [PICK], protocol: "responses" })).toThrow("Chat Completions style only");
  const account = app.providers.setEndpointAccount("builtin", { label: "NanoGPT", baseUrl: fake.base, apiKey: KEY, models: [PICK], contextWindow: 1_048_576, protocol: "chat" });
  // Its accounts are the services it runs on: no sign-in account of its own is listed.
  expect(app.providers.accounts().filter((a) => a.provider === "builtin").map((a) => a.id)).toEqual([account.id]);
  expect(() => app.chats.create({ provider: "builtin", cwd: dir } as never)).toThrow("runs on an AI service");

  const room = app.chats.create({ provider: "builtin", account: account.id, model: PICK, permissionMode: "full", cwd: dir } as never);
  app.engine.postHumanMessage(room.id, "Echo via the hub", "Phone");
  await app.engine.whenIdle();
  const said = app.store.listMessages(room.id).map((m) => [m.authorKind, m.text]);
  expect(said.at(-1)?.[1]).toBe("It said via-the-hub.");
  expect(fake.state.chats[1].messages.at(-1)).toMatchObject({ role: "tool", content: "via-the-hub\n[exit code 0]" });
  // Costs has the reply, on the account it ran on (a stand-in on this machine is free, as any local server is).
  expect(app.store.db.query("SELECT provider, account, input_tokens AS input FROM spend_ledger").all()).toEqual([{ provider: "builtin", account: account.id, input: 2000 }]);
});

test("a command that runs past its time limit is stopped, and Stop ends a reply mid-command", async () => {
  const fake = nano([{ calls: [{ name: "run_command", args: { command: "sleep 30", timeout_seconds: 1 } }] }, { text: "It timed out." }]);
  const cwd = folder();
  const { sink, out } = sinkFor();
  const started = Date.now();
  await driver(ctxFor(fake, cwd)).runTurn(turn("Sleep"), sink);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(out.activities[0]).toMatchObject({ title: "sleep 30", status: "error" });
  expect(fake.state.chats[1].messages.at(-1).content).toContain("[Stopped after 1 seconds.]");

  const fake2 = nano([{ calls: [{ name: "run_command", args: { command: "sleep 30" } }] }]);
  const second = sinkFor();
  const d = driver(ctxFor(fake2, cwd, { memberId: "mb-stop" }));
  const run = d.runTurn(turn("Sleep long"), second.sink);
  await Bun.sleep(500);
  second.out.stop();
  const result = await run;
  expect(result).toEqual({ ok: false, error: "stopped" });
});

test("a file written by the agent isn't read back as a binary one, and a binary file is said as such", async () => {
  const fake = nano([{ calls: [{ name: "read_file", args: { path: "blob.bin" } }] }, { text: "It's binary." }]);
  const cwd = folder();
  writeFileSync(join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  await driver(ctxFor(fake, cwd)).runTurn(turn("Read the blob"), sinkFor().sink);
  expect(fake.state.chats[1].messages.at(-1).content).toBe(`${join(cwd, "blob.bin")} is a binary file (4 bytes).`);
});

export type { Turn };

test("a coding agent: the project's AGENTS.md and CLAUDE.md are in its instructions, root first, and its plan is one card kept up to date", async () => {
  const root = folder();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), "Run bun test before you finish.");
  const web = join(root, "web");
  mkdirSync(web);
  writeFileSync(join(web, "CLAUDE.md"), "This folder is the phone app.");
  const fake = rl([
    { calls: [{ name: "update_plan", args: { steps: [{ step: "Read the code", status: "in_progress" }, { step: "Fix it", status: "pending" }] } }] },
    { calls: [{ name: "update_plan", args: { steps: [{ step: "Read the code", status: "done" }, { step: "Fix it", status: "in_progress" }] } }] },
    { text: "Fixed." },
  ]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, web)).runTurn(turn("Fix the bug"), sink)).toEqual({ ok: true });
  const system = String(fake.state.chats[0].messages[0].content);
  expect(system).toContain("# Project instructions");
  expect(system.indexOf(`## ${join(root, "AGENTS.md")}\nRun bun test before you finish.`)).toBeGreaterThan(0);
  expect(system.indexOf(`## ${join(root, "AGENTS.md")}`)).toBeLessThan(system.indexOf(`## ${join(web, "CLAUDE.md")}\nThis folder is the phone app.`));
  // The same instructions at every step of the reply, so the service can cache them.
  expect(fake.state.chats.map((c) => c.messages[0].content)).toEqual([system, system, system]);
  expect(fake.state.chats[0].tools.map((t: { function: { name: string } }) => t.function.name)).toContain("update_plan");
  // One plan card, kept up to date in place, and the model told where it stands.
  expect(out.activities).toEqual([{ kind: "plan", title: "Plan", detail: "✓ Read the code\n▸ Fix it", status: "done" }]);
  expect(fake.state.chats[1].messages.at(-1)).toMatchObject({ role: "tool", content: "Plan updated: 0 of 2 done." });
  expect(fake.state.chats[2].messages.at(-1)).toMatchObject({ role: "tool", content: "Plan updated: 1 of 2 done." });
  expect(out.text).toBe("Fixed.");
});

test("project instructions: only the working folder's outside a git project, and a long file is cut with where to read the rest", () => {
  const outer = folder();
  writeFileSync(join(outer, "AGENTS.md"), "Outer rules.");
  const inner = join(outer, "inner");
  mkdirSync(inner);
  writeFileSync(join(inner, "AGENTS.md"), "x".repeat(5000));
  writeFileSync(join(inner, "CLAUDE.md"), "Not read: AGENTS.md comes first.");
  expect(projectNotes(inner, 1000)).toEqual([{ path: join(inner, "AGENTS.md"), text: `${"x".repeat(1000)}\n[… cut here: read the rest with read_file ${join(inner, "AGENTS.md")}]` }]);
  expect(projectNotes(folder())).toEqual([]);
  // A file that doesn't fit at all is still named, so the agent knows to read it.
  const root = folder();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), "Root rules.");
  const sub = join(root, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "AGENTS.md"), "y".repeat(5000));
  expect(projectNotes(sub, 1000)).toEqual([
    { path: join(root, "AGENTS.md"), text: `[Not included here, for length: read it with read_file ${join(root, "AGENTS.md")}]` },
    { path: join(sub, "AGENTS.md"), text: `${"y".repeat(1000)}\n[… cut here: read the rest with read_file ${join(sub, "AGENTS.md")}]` },
  ]);
});

test("Refuseless: a model that is starting up or busy is waited out, saying so, and a server error is tried again", async () => {
  const cwd = folder();
  const fake = rl([
    { status: 429, code: "model_warming", error: "Cold pod starting.", retryAfter: "30" },
    { status: 429, code: "model_busy", error: "Model is busy. Retry shortly.", retryAfter: "15" },
    { status: 502, code: "upstream_error", error: "Inference backend error." },
    { text: "Up and answering." },
  ]);
  const waits: number[] = [];
  const said: string[] = [];
  const { sink, out } = sinkFor();
  sink.status = (detail) => void said.push(detail ?? "");
  expect(await driver(rlCtx(fake, cwd), { pause: async (ms) => void waits.push(ms) }).runTurn(turn("hi"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("Up and answering.");
  expect(waits).toEqual([30_000, 15_000, 2000]);
  expect(said).toContain(`Refuseless is starting ${RL_PICK} up (it was asleep): trying again in 30s`);
  expect(said).toContain(`Refuseless says ${RL_PICK} is busy: trying again in 15s`);
  expect(fake.state.chats).toHaveLength(4);
});

test("Refuseless: credit that runs out mid-answer is said as money, and its Cloudflare check as that, not the key", async () => {
  const cwd = folder();
  const broke = rl([{ text: "Half an ans", streamError: { code: "insufficient_credits", message: "Credits ran out. Generation stopped." } }]);
  const r = await driver(rlCtx(broke, cwd, "mb-1"), { pause: async () => {} }).runTurn(turn("hi"), sinkFor().sink);
  expect(r).toEqual({ ok: false, error: `Refuseless says there isn't enough money in the account for ${RL_PICK}: Credits ran out. Generation stopped. Add money on its website, or pick another model in this chat's settings (on NanoGPT, one its subscription covers).` });
  // Money isn't a hiccup: it wasn't asked again.
  expect(broke.state.chats).toHaveLength(1);

  const walled = rl([], { challenge: true });
  const w = await driver(rlCtx(walled, cwd, "mb-2"), { pause: async () => {} }).runTurn(turn("hi"), sinkFor().sink);
  expect(w).toEqual({ ok: false, error: challengeWords("Refuseless") });
  // Tried again three times, as a server error is, then said.
  expect(walled.seen.filter((s) => s.path === "/v1/chat/completions")).toHaveLength(4);

  // A model still busy after six waits ends the reply as a rate limit, which the hub carries on from later.
  const busy = rl(Array.from({ length: 7 }, () => ({ status: 429, code: "model_busy", error: "Model is busy.", retryAfter: "15" })));
  const b = await driver(rlCtx(busy, cwd, "mb-3"), { pause: async () => {} }).runTurn(turn("hi"), sinkFor().sink);
  expect(b).toMatchObject({ ok: false, error: `429 rate limit: Refuseless says ${RL_PICK} is busy (Model is busy.)`, limit: { kind: "rate" } });
  expect(busy.state.chats).toHaveLength(7);
});

test("money, the key and the model are never waited out, even with a short retry-after; a retry-after of 0 still waits", async () => {
  const cwd = folder();
  const broke = rl([{ status: 429, error: "Insufficient balance for this request.", retryAfter: "20" }]);
  const waits: number[] = [];
  const r = await driver(rlCtx(broke, cwd, "mb-1"), { pause: async (ms) => void waits.push(ms) }).runTurn(turn("hi"), sinkFor().sink);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("isn't enough money in the account");
  expect(r.limit).toBeUndefined();
  expect(waits).toEqual([]);
  expect(broke.state.chats).toHaveLength(1);
  // A cold model that says "again in 0 seconds" is still given its warm-up, not asked again at once.
  const cold = rl([{ status: 429, code: "model_warming", error: "Cold pod starting.", retryAfter: "0" }, { text: "Warm now." }]);
  expect(await driver(rlCtx(cold, cwd, "mb-2"), { pause: async (ms) => void waits.push(ms) }).runTurn(turn("hi"), sinkFor().sink)).toEqual({ ok: true });
  expect(waits).toEqual([30_000]);
});

test("the same tool call over and over gets a nudge to try another way", async () => {
  const cwd = folder();
  writeFileSync(join(cwd, "a.txt"), "hello\n");
  const same = { calls: [{ name: "read_file", args: { path: "a.txt" } }] };
  const fake = rl([same, same, same, { text: "Stopping: the file says hello." }]);
  expect(await driver(rlCtx(fake, cwd)).runTurn(turn("Read a.txt"), sinkFor().sink)).toEqual({ ok: true });
  expect(fake.state.chats[2].messages.at(-1).content).not.toContain("times in a row");
  expect(fake.state.chats[3].messages.at(-1).content).toContain("You have made exactly this call 3 times in a row.");
});

test("a running command says it's alive about once a minute, whatever it prints, and stops when it ends", async () => {
  // A long test run: more than a card shows at the start, then quiet.
  const fake = rl([{ calls: [{ name: "run_command", args: { command: "head -c 25000 /dev/zero | tr '\\0' x; sleep 0.6" } }] }, { text: "Built." }]);
  const cwd = folder();
  const { sink, out } = sinkFor();
  let atLastOutput = -1;
  const update = sink.updateActivity;
  sink.updateActivity = (id, patch) => {
    if (patch.appendDetail) atLastOutput = out.beats;
    update(id, patch);
  };
  expect(await driver(rlCtx(fake, cwd), { heartbeatMs: 40 }).runTurn(turn("Build it"), sink)).toEqual({ ok: true });
  expect(out.activities[0].detail).toContain("[… more output: the agent reads all of it …]");
  // It went on saying so after its card was full and its output had stopped.
  expect(atLastOutput).toBeGreaterThanOrEqual(0);
  expect(out.beats - atLastOutput).toBeGreaterThan(3);
  const ended = out.beats;
  await Bun.sleep(150);
  expect(out.beats).toBe(ended);
  // A minute apart, unless a test says otherwise; and an agent with no heartbeat to call still runs its commands.
  const fake2 = rl([{ calls: [{ name: "run_command", args: { command: "echo hi" } }] }, { text: "Said hi." }]);
  const realInterval = globalThis.setInterval;
  const delays: unknown[] = [];
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    delays.push(ms);
    return realInterval(fn, ms);
  }) as typeof setInterval;
  const second = sinkFor();
  delete second.sink.heartbeat;
  try {
    expect(await driver(rlCtx(fake2, cwd, "mb-2")).runTurn(turn("Say hi"), second.sink)).toEqual({ ok: true });
  } finally {
    globalThis.setInterval = realInterval;
  }
  expect(delays).toContain(60_000);
});

/** The stand-in Refuseless's chat under a real engine, whose stall watchdog fires after half a second of silence. */
function watched(fake: { base: string }, cwd: string, deps: BuiltinDeps) {
  const store = new Store(":memory:");
  const engine = new Engine({ store, bus: new Bus(), stallMs: 500, createDriver: () => driver(rlCtx(fake, cwd), deps), mcpLaunch: () => ({ command: "true", args: [], env: {} }) });
  cleanups.push(() => engine.shutdown());
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "R", cwd, mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertMember({ id: newId("mb"), roomId: room.id, handle: "agent", provider: "builtin", model: RL_PICK, role: "", permissionMode: "full", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
  return { engine, room, turns: () => store.listTurns(room.id, 20).sort((a, b) => a.createdAt - b.createdAt) };
}

test("under the engine's watchdog: a quiet command that says it's alive isn't taken for frozen; without that, it is", async () => {
  const quiet = { calls: [{ name: "run_command", args: { command: "sleep 1.2" } }] };
  const alive = watched(rl([quiet, { text: "Built." }]), folder(), { heartbeatMs: 50 });
  alive.engine.postHumanMessage(alive.room.id, "Build it", "Phone");
  await alive.engine.whenIdle();
  expect(alive.turns().map((t) => [t.status, t.error])).toEqual([["done", null]]);
  // The same command with nothing said for longer than the watchdog waits: killed, and retried.
  const silent = watched(rl([quiet, { text: "Built." }]), folder(), { heartbeatMs: 60_000 });
  silent.engine.postHumanMessage(silent.room.id, "Build it", "Phone");
  await silent.engine.whenIdle();
  const [first, second] = silent.turns();
  expect(first.error).toContain("got stuck on `sleep 1.2`");
  expect(second.status).toBe("done");
});

test("what a command leaves running doesn't hold the reply: it's alive only while its shell is, and the rest of the output isn't waited for", async () => {
  const command = "echo started; sleep 20 & echo $! > sleeper.pid";
  const fake = rl([{ calls: [{ name: "run_command", args: { command } }] }, { text: "It's running." }]);
  const cwd = folder();
  const { sink, out } = sinkFor();
  const started = Date.now();
  try {
    expect(await driver(rlCtx(fake, cwd), { heartbeatMs: 100 }).runTurn(turn("Start it"), sink)).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(15_000);
    const said = String(fake.state.chats[1].messages.at(-1).content);
    expect(said).toStartWith("started\n[exit code 0]\n[Something it left running in the background still holds its output open");
    expect(out.activities[0]).toMatchObject({ title: command, status: "done" });
    // Two seconds of waiting for the output would be 20 of these.
    expect(out.beats).toBeLessThan(15);
  } finally {
    process.kill(Number(readFileSync(join(cwd, "sleeper.pid"), "utf8")));
  }
});

test("Always allow BrowserOS neo and file changes are kept in the session, in the shape the settings list", async () => {
  const browser = fakeBrowser();
  const open = { calls: [{ name: "browseros__navigate", args: { url: "https://example.com" } }] };
  const fake = nano([open, open, { calls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }] }, { calls: [{ name: "write_file", args: { path: "b.txt", content: "y" } }] }, { text: "Done." }]);
  const { sink, out } = sinkFor(["approve_always", "approve_always"]);
  await driver(ctxFor(fake, folder(), { mode: "ask" }), { browserUrl: async () => browser.url }).runTurn(turn("Go"), sink);
  expect(out.approvals.map((a) => a.always)).toEqual(["Always allow BrowserOS neo in this chat", "Always allow file changes in this chat"]);
  expect(browser.calls).toHaveLength(2);
  expect(out.session.builtinAllowed).toEqual({ tools: ["browseros_*"], files: true });
});

const DSML = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="run_command">\n<｜DSML｜parameter name="command" string="true">rm -rf secret-folder</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';

test("a model writing a long tool call says it's alive too: that can take longer than the engine waits", async () => {
  const fake = rl([{ calls: [{ name: "update_plan", args: { steps: [{ step: "Write it", status: "in_progress" }] } }] }, { text: "Done." }]);
  const { sink, out } = sinkFor();
  await driver(rlCtx(fake, folder())).runTurn(turn("Write it"), sink);
  // The arguments of the one call came in two pieces.
  expect(out.beats).toBe(2);
});

test("a tool call written as text: it leaves what's kept and what's shown, and the model is asked to make it properly", async () => {
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...words: unknown[]) => void logged.push(words.join(" "));
  try {
    const fake = rl([
      { text: "First I look around.", calls: [{ name: "list_files", args: {} }] },
      { reasoning: "Run it.", text: `Now the tests.\n${DSML}` },
      { calls: [{ name: "run_command", args: { command: "echo real" } }] },
      { text: "All passed." },
    ]);
    const cwd = folder();
    const { sink, out } = sinkFor();
    expect(await driver(rlCtx(fake, cwd), { heartbeatMs: 40 }).runTurn(turn("Run the tests"), sink)).toEqual({ ok: true });
    expect(out.text).toBe("First I look around.\n\nNow the tests.\n\nAll passed.");
    const next = fake.state.chats[2].messages;
    expect(next.at(-2)).toEqual({ role: "assistant", content: "Now the tests.", reasoning_content: "Run it." });
    expect(next.at(-1)).toEqual({ role: "user", content: TEXT_TOOL_CALL_NUDGE });
    expect(JSON.stringify(fake.state.chats.at(-1)!.messages)).not.toContain("DSML");
    // Nothing of what it wrote goes in the log.
    expect(logged.join("\n")).toContain("a tool call written as text (1 since the last call that ran)");
    expect(logged.join("\n")).not.toContain("secret-folder");
  } finally {
    console.log = realLog;
  }
});

test("a tool call written as text after Send now: only the reply being written is put back, not the one above the message", async () => {
  const fake = rl([{ text: "Before.", calls: [{ name: "run_command", args: { command: "sleep 0.4" } }] }, { text: `Now this.\n${DSML}` }, { text: "Done." }]);
  const { sink, out } = sinkFor();
  sink.newReply = () => void (out.text = "");
  const d = driver(rlCtx(fake, folder()));
  const running = d.runTurn(turn("Go"), sink);
  await Bun.sleep(150);
  expect(await d.steer("And this too", ["m2"])).toBe(true);
  expect(await running).toEqual({ ok: true });
  expect(out.text).toBe("Now this.\n\nDone.");
});

test("a tool call written as text with nothing else in the answer: no empty message is kept, and the reply so far stays", async () => {
  const fake = rl([{ text: "Reading.", calls: [{ name: "list_files", args: {} }] }, { text: DSML }, { text: "Done." }]);
  const cwd = folder();
  const { sink, out } = sinkFor();
  await driver(rlCtx(fake, cwd)).runTurn(turn("Go"), sink);
  const roles = fake.state.chats[2].messages.slice(1).map((m: { role: string }) => m.role);
  expect(roles).toEqual(["user", "assistant", "tool", "user"]);
  expect(out.text).toBe("Reading.\n\nDone.");
});

test("a tool call written as text: three nudges at most with nothing run between them, then it says it stopped instead of looking finished", async () => {
  const leak = { text: `Calling it.\n${DSML}` };
  const fake = rl([leak, leak, leak, leak, { text: "Never asked for." }]);
  const cwd = folder();
  const { sink, out } = sinkFor();
  const r = await driver(rlCtx(fake, cwd)).runTurn(turn("Go"), sink);
  expect(r).toEqual({ ok: false, error: "The model kept writing its commands out as text instead of running them, so nothing more ran and the work isn't finished. Send a message to let it carry on, or pick another model in this chat's settings." });
  expect(fake.state.chats).toHaveLength(4);
  expect(fake.state.chats[3].messages.filter((m: { content: string }) => m.content === TEXT_TOOL_CALL_NUDGE)).toHaveLength(3);
  expect(out.text).not.toContain("DSML");
  // The count is per reply: the next one starts afresh.
  const again = rl([leak, { text: "Fine now." }]);
  const d = driver(rlCtx(again, cwd, "mb-2"));
  expect(await d.runTurn(turn("Again"), sinkFor().sink)).toEqual({ ok: true });
});

test("markup in a code block, or talked about in a sentence, is an answer like any other", async () => {
  const fake = rl([{ text: "The leak looks like this:\n```\n<｜DSML｜tool_calls>\n```\nand a <tool_call> tag in a sentence is fine." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, folder())).runTurn(turn("What does a leak look like?"), sink)).toEqual({ ok: true });
  expect(fake.state.chats).toHaveLength(1);
  expect(out.text).toContain("<｜DSML｜tool_calls>");
});

test("an empty answer is asked about once until a tool call has run, and never kept as a message", async () => {
  const fake = rl([{ reasoning: "Hm." }, { text: "Here is what I did." }]);
  const { sink, out } = sinkFor();
  const d = driver(rlCtx(fake, folder()));
  expect(await d.runTurn(turn("Go"), sink)).toEqual({ ok: true });
  expect(fake.state.chats[1].messages.slice(1)).toEqual([
    { role: "user", content: "Go" },
    { role: "user", content: EMPTY_ANSWER_NUDGE },
  ]);
  expect(out.text).toBe("Here is what I did.");

  // Twice in a row: it ends there, saying so where there's nothing else on the screen, and nothing empty is kept.
  const twice = rl([{ text: "  \n" }, {}, { text: "A new message's answer." }]);
  const second = sinkFor();
  const d2 = driver(rlCtx(twice, folder(), "mb-2"));
  expect(await d2.runTurn(turn("Go"), second.sink)).toEqual({ ok: true });
  expect(twice.state.chats).toHaveLength(2);
  expect(second.out.text.trim()).toBe("The model ended without saying anything. Send a message if there's more to do.");
  await d2.runTurn(turn("And now?"), sinkFor().sink);
  expect(twice.state.chats[2].messages.slice(1).map((m: { role: string }) => m.role)).toEqual(["user", "user", "user"]);

  // An answer that has work in it isn't empty, and neither is one cut off with text in it.
  const working = rl([{ calls: [{ name: "list_files", args: {} }] }, { text: "Half", finish: "length" }, { text: " of it." }]);
  const third = sinkFor();
  expect(await driver(rlCtx(working, folder(), "mb-3")).runTurn(turn("Go"), third.sink)).toEqual({ ok: true });
  expect(third.out.text).toBe("Half of it.");
  expect(JSON.stringify(working.state.chats.at(-1)!.messages)).not.toContain(EMPTY_ANSWER_NUDGE);

  // One cut off in its thinking is empty too, so it can't go round asking to go on for ever.
  const thinking = { reasoning: "Thinking and thinking.", finish: "length" as const };
  const looping = rl([thinking, thinking, thinking, thinking]);
  expect(await driver(rlCtx(looping, folder(), "mb-4")).runTurn(turn("Go"), sinkFor().sink)).toEqual({ ok: true });
  expect(looping.state.chats).toHaveLength(2);
  expect(looping.state.chats[1].messages.at(-1)).toEqual({ role: "user", content: EMPTY_ANSWER_NUDGE });
});

const realStep = { calls: [{ name: "run_command", args: { command: "echo step" } }] };

test("only a tool call that really ran is progress: an empty answer or a leak far from the last one is asked about again", async () => {
  // Empties far apart: each asked about, and the reply ends where the model says, not on an old progress line.
  const empties = rl([{ text: "Starting on step one.", ...realStep }, {}, realStep, realStep, {}, { text: "All done." }, { text: "Never asked for." }]);
  const first = sinkFor();
  expect(await driver(rlCtx(empties, folder())).runTurn(turn("Go"), first.sink)).toEqual({ ok: true });
  expect(first.out.text).toEndWith("All done.");
  expect(empties.state.chats).toHaveLength(6);
  expect(empties.state.chats[5].messages.filter((m: { content: string }) => m.content === EMPTY_ANSWER_NUDGE)).toHaveLength(2);
  // A fourth leak, with real calls between them, isn't "still" writing them as text.
  const leak = { text: `Calling it.\n${DSML}` };
  const leaks = rl([realStep, leak, realStep, leak, realStep, leak, realStep, leak, { text: "Done." }]);
  expect(await driver(rlCtx(leaks, folder(), "mb-2")).runTurn(turn("Go"), sinkFor().sink)).toEqual({ ok: true });
  expect(leaks.state.chats).toHaveLength(9);
  // Text on its own isn't progress: leaks that all come with text still reach the limit.
  const wordy = rl([leak, leak, leak, leak, { text: "Never asked for." }]);
  expect((await driver(rlCtx(wordy, folder(), "mb-3")).runTurn(turn("Go"), sinkFor().sink)).ok).toBe(false);
  expect(wordy.state.chats).toHaveLength(4);
});

test("an empty answer that ends a reply with progress on the screen says it may not be finished", async () => {
  const fake = rl([{ text: "Starting on step one.", ...realStep }, {}, {}, { text: "Never asked for." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, folder())).runTurn(turn("Go"), sink)).toEqual({ ok: true });
  expect(fake.state.chats).toHaveLength(3);
  expect(out.text).toBe("Starting on step one.\n\nThe model's last answer was empty, so this may not be finished. Send a message if there's more to do.");
});

const CUT_OFF_ERROR = "The model's answers kept running into the output limit, so it was stopped and the work may not be finished. Send a message to let it carry on, or pick another model in this chat's settings.";

test("answers cut off by the output limit are asked to go on only so often, and a tool call that runs starts that over", async () => {
  const cut = { text: "More and more", finish: "length" as const };
  const looping = rl([cut, cut, cut, cut, { text: "Never asked for." }]);
  expect(await driver(rlCtx(looping, folder())).runTurn(turn("Go"), sinkFor().sink)).toEqual({ ok: false, error: CUT_OFF_ERROR });
  expect(looping.state.chats).toHaveLength(3);
  // Tool calls cut off in their arguments, each answered, go the same way, and each still has its answer kept.
  const cwd = folder();
  const service = rawFirst(Array.from({ length: 4 }, () => () => callWith("write_file", '{"path":"made.txt","cont')));
  const r = await driver(rlCtx(rl([{ text: "Never asked for." }]), cwd, "mb-2"), { fetch: service.get, pause: async () => {} }).runTurn(turn("Go"), sinkFor().sink);
  expect(r).toEqual({ ok: false, error: CUT_OFF_ERROR });
  expect(JSON.parse(readFileSync(join(cwd, ".run/builtin/mb-2.json"), "utf8")).messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "tool"]);
  // Real work between them: not a loop.
  const working = rl([cut, cut, realStep, cut, cut, { text: "Finished." }]);
  const third = sinkFor();
  expect(await driver(rlCtx(working, folder(), "mb-3")).runTurn(turn("Go"), third.sink)).toEqual({ ok: true });
  expect(third.out.text).toEndWith("Finished.");
  // Taking turns with empty answers doesn't get around it.
  const turns = rl([cut, {}, cut, {}, cut, {}, cut, { text: "Never asked for." }]);
  await driver(rlCtx(turns, folder(), "mb-4")).runTurn(turn("Go"), sinkFor().sink);
  expect(turns.state.chats.length).toBeLessThanOrEqual(4);
});

test("an answer that breaks off is asked for again, and what it had written goes", async () => {
  const fake = rl([{ text: "Half an ans", streamError: { code: "upstream_error", message: "Dropped." } }, { text: "A whole answer." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, folder()), { pause: async () => {} }).runTurn(turn("Go"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("A whole answer.");
  // A connection that drops mid-answer is the same, and said in plain words when it does it twice.
  let dropped = 0;
  const drops: typeof fetch = (async () => {
    dropped++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Half" } }] })}\n\n`));
        },
        pull(c) {
          c.error(new Error("socket closed"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  const r = await driver(rlCtx(fake, folder(), "mb-2"), { pause: async () => {}, fetch: drops }).runTurn(turn("Go"), sinkFor().sink);
  expect(dropped).toBe(2);
  expect(r).toEqual({ ok: false, error: "The connection to Refuseless dropped partway through its answer. Tap Try again." });
});

const edited = (file: string, old: string, now: string, all = false) => {
  const r = editText(file, old, now, all);
  if (r.result !== "edited") throw new Error(`Not edited: ${JSON.stringify(r)}`);
  return r.text;
};

test("edits: a looser match that lengthens a run of dashes or quotes writes the run as given, and keeps the rest of the line's own", () => {
  expect(edited("Run: tool \u2013verbose file.txt\n", "Run: tool -verbose file.txt", "Run: tool --verbose file.txt")).toBe("Run: tool --verbose file.txt\n");
  expect(edited("a \u2014 b\n", "a - b", "a -- b")).toBe("a -- b\n");
  expect(edited("say \u201chello\u201d later\n", 'say "hello" later', 'say "hello" sooner')).toBe("say \u201chello\u201d sooner\n");
});

test("edits: an LF view of the file matches, and CRLF and mixed line endings stay, region by region", () => {
  expect(edited("one\r\ntwo\r\nthree\r\n", "one\ntwo", "ONE\nTWO")).toBe("ONE\r\nTWO\r\nthree\r\n");
  // A line added or taken away in a CRLF region takes CRLF too.
  expect(edited("a\r\nb\r\n", "a\n", "x\ny\n")).toBe("x\r\ny\r\nb\r\n");
  expect(edited("a\r\nb\r\nc\r\n", "a\nb\nc", "a\nc")).toBe("a\r\nc\r\n");
  // Old text written with CRLF is the same text, and so is new.
  expect(edited("a\nb\n", "a\r\nb", "x\r\ny")).toBe("x\ny\n");
  // Mixed: nothing outside the match changes, and inside it each line keeps the ending it had.
  expect(edited("a\r\nb\nc\r\nd\n", "b", "B")).toBe("a\r\nB\nc\r\nd\n");
  expect(edited("a\r\nb\nc\r\nd\n", "b\nc", "B\nC")).toBe("a\r\nB\nC\r\nd\n");
  expect(edited("a\r\nb\nc\r\nd", "a\nb\nc", "a\nB\nc")).toBe("a\r\nB\nc\r\nd");
  // A new line takes the main ending of the region it lands in, which isn't always the file's.
  expect(edited("p\r\nq\r\nr\ns\nt\r\n", "r\ns", "r\nnew\ns")).toBe("p\r\nq\r\nr\nnew\ns\nt\r\n");
  expect(edited("x\r\ny\nz\r\n", "x\ny\nz", "x\nnew\ny\nz")).toBe("x\r\nnew\r\ny\nz\r\n");
  // No line break in the region: the file's main ending.
  expect(edited("a\r\nb\r\nc\n", "b", "b1\nb2")).toBe("a\r\nb1\r\nb2\r\nc\n");
  // Asked for by its bytes: old and new differ only in \r.
  expect(edited("a\r\nb\r\n", "a\r\nb\r\n", "a\nb\n")).toBe("a\nb\n");
  expect(edited("a\nb\n", "a\nb", "a\r\nb")).toBe("a\r\nb\n");
  // A byte order mark stays, and is no part of the match.
  expect(edited("\uFEFFone\r\ntwo\r\n", "one\n", "uno\n")).toBe("\uFEFFuno\r\ntwo\r\n");
  expect(edited("\uFEFFone  \ntwo\n", "one\ntwo", "x\ny")).toBe("\uFEFFx\ny\n");
  expect(edited("\uFEFFone\n", "\uFEFFone", "uno")).toBe("\uFEFFuno\n");
  // New text goes in as written, whatever it looks like.
  expect(edited("a b", "a", "$& $1 $'")).toBe("$& $1 $' b");
  // A very big edit takes the region's main ending throughout, rather than a table of gigabytes.
  const big = `first\n${Array.from({ length: 3000 }, (_, i) => `line ${i}\r\n`).join("")}`;
  const lf = big.replaceAll("\r\n", "\n");
  expect(edited(big, lf, lf.replaceAll("line", "row"))).toBe(`first\r\n${big.slice("first\n".length).replaceAll("line", "row")}`);
});

test("edits: curly quotes, dashes and special spaces match their plain forms, the exact text coming first", () => {
  expect(edited("say \u201Chello\u201D \u2014 it\u2019s\u00A0fine\nnext\n", `say "hello" - it's fine`, "said")).toBe("said\nnext\n");
  expect(edited(`const a = "x";\n`, "const a = \u201Cx\u201D;", `const a = "y";`)).toBe(`const a = "y";\n`);
  expect(edited("x\r\n\u2018q\u2019\r\ny", "'q'", '"q"')).toBe('x\r\n"q"\r\ny');
  // Places still line up after a CRLF, in a multi-line match.
  expect(edited("x\r\n\u2018p\u2019\r\n\u2018q\u2019\r\ny", "'p'\n'q'", "r\ns")).toBe("x\r\nr\r\ns\r\ny");
  // Found exactly once and in a curly form too: the exact one is meant, so it isn't called ambiguous.
  expect(edited("'a' \u2018a\u2019", "'a'", "b")).toBe("b \u2018a\u2019");
});

test("edits: a line-by-line match ignores trailing whitespace on either side, and keeps the rest of the file", () => {
  expect(edited("foo   \nbar\t\nbaz\n", "foo\nbar", "FOO\nBAR")).toBe("FOO\nBAR\nbaz\n");
  expect(edited("foo\nbar\n", "foo  \nbar", "x\ny")).toBe("x\ny\n");
  expect(edited("foo  \r\nbar\r\nbaz", "foo\nbar", "x\ny")).toBe("x\r\ny\r\nbaz");
  // With a line break at its end, the match has to have one.
  expect(edited("foo \nbar", "foo\n", "x\n")).toBe("x\nbar");
  expect(editText("foo \nbar ", "bar\n", "x\n", false).result).toBe("missing");
  // Also over curly quotes.
  expect(edited("say \u201Cit\u201D  \nnext\n", 'say "it"\nnext', "done")).toBe("done\n");
  // Matches that would overlap count once.
  expect(edited("a \na \na \nb", "a\na", "x", true)).toBe("x\na \nb");
});

test("edits: more than one match fails unless every one is asked for; a miss says what's close; nothing fuzzier matches", () => {
  expect(editText("a\na\n", "a", "b", false)).toEqual({ result: "several", places: 2 });
  expect(editText("\u2018a\u2019 \u2018a\u2019", "'a'", "b", false)).toEqual({ result: "several", places: 2 });
  expect(editText("a \nb\na\t\nb\n", "a\nb", "x", false)).toEqual({ result: "several", places: 2 });
  expect(editText("a\na\n", "a", "b", true)).toEqual({ result: "edited", text: "b\nb\n", places: 2 });
  expect(edited("x\r\ny\nx\r\ny\n", "x\ny", "x2\ny2", true)).toBe("x2\r\ny2\nx2\r\ny2\n");
  // What the new text would change nothing of.
  expect(editText("foo\nbar", "foo  ", "foo", false)).toEqual({ result: "unchanged" });

  const file = "function one() {\n  if (a) {\n    b();\n  }\n}\n\nfunction two() {\n  return 2;\n}\n";
  // Loose indentation, different words, similar blocks: OpenCode 1 would have edited something. Not here.
  const loose = editText(file, "if (a) {\n  b();\n}", "c();", false);
  expect(loose).toEqual({ result: "missing", hint: "The closest lines in the file:\n2\t  if (a) {\n3\t    b();\n4\t  }" });
  expect(editText(file, "IF (A) {", "c();", false).result).toBe("missing");
  expect(editText(file, "function  two()", "c();", false).result).toBe("missing");
  // Lines shown are the ones that matched, numbered as read_file numbers them, and no others.
  expect(editText(file, "function two() {\n  return 3;\n}", "x", false)).toEqual({ result: "missing", hint: "The closest lines in the file:\n7\tfunction two() {\n8\t  return 2;\n9\t}" });
  // Nothing like it: no hint at all.
  expect(editText(file, "nothing like this", "x", false)).toEqual({ result: "missing", hint: null });
  // Already done: said, so it doesn't go looking.
  const applied = "function three() {\n  return 3;\n}";
  expect(editText(`${file}${applied}\n`, "function old() {}", applied, false)).toEqual({ result: "missing", hint: "new_string is already in the file, so this edit may already have been made." });
});

test("edits by a looser match keep the file's own characters, wherever the model didn't change its copy of them", () => {
  // A line the model repeats, in its plain copy, stays as the file has it.
  expect(edited("say \u201Chi\u201D \u2014 ok\nnext\n", 'say "hi" - ok\nnext', 'say "hi" - ok\nlast')).toBe("say \u201Chi\u201D \u2014 ok\nlast\n");
  expect(edited("10\u00A0km\nnext\n", "10 km\nnext", "10 km\nlast")).toBe("10\u00A0km\nlast\n");
  // A one-line edit, the usual shape: only what changed changes.
  expect(edited('msg("Don\u2019t stop \u2014 now", 1);\n', `msg("Don't stop - now", 1);`, `msg("Don't stop - now", 2);`)).toBe('msg("Don\u2019t stop \u2014 now", 2);\n');
  expect(edited("The build \u2014 it\u2019s slow.\n", "The build - it's slow.", "The build - it's fast.")).toBe("The build \u2014 it\u2019s fast.\n");
  // Whitespace at a line's end, found line by line, is the file's too: a markdown hard break stays.
  expect(edited("line one  \nline two\n", "line one\nline two", "line one\nline 2")).toBe("line one  \nline 2\n");
  // Each place by its own text, under replace_all.
  expect(edited("a \u2014 b, a \u2013 b\n", "a - b", "a - c", true)).toBe("a \u2014 c, a \u2013 c\n");
  // What can't be lined up goes in as written.
  expect(edited("say \u201Chi\u201D  \nnext\n", 'say "hi"\nnext', 'say "bye"\nnext')).toBe('say "bye"\nnext\n');
  // Changing them on purpose works, from the exact text.
  expect(edited("say \u201Chi\u201D\n", "say \u201Chi\u201D", 'say "hi"')).toBe('say "hi"\n');
  expect(edited("a \u2014 b\n", "\u2014", "--")).toBe("a -- b\n");
});

test("edits: a search with nothing to recognise doesn't match by its plain form, or any blank line", () => {
  // A bare em dash that isn't in the file would match every hyphen; spaces, every blank line.
  expect(editText("npm run build --watch\nfoo-bar - baz\n", "\u2014", "--", true).result).toBe("missing");
  expect(editText("x-y z-w\n", "\u2014", ", ", false).result).toBe("missing");
  expect(editText("<p>one two</p>\n", "\u00A0", "&nbsp;", true).result).toBe("missing");
  expect(editText("it's bob's\n", "\u2019", "", true).result).toBe("missing");
  expect(editText("\tindented\n\nnext\n", "    ", "    inserted", false).result).toBe("missing");
  expect(editText("\tindented\n\nnext\n", "    \n", "    inserted\n", false).result).toBe("missing");
  // One with words in it still does, and spaces that are really there are found exactly.
  expect(edited("it\u2019s here\n", "it's", "it is")).toBe("it is here\n");
  expect(edited("    b\n", "    ", "\t")).toBe("\tb\n");
});

test("edits: many matches in a big file take no time to speak of: this runs on the hub's only thread", () => {
  const within = (ms: number, edit: () => string) => {
    const started = performance.now();
    const text = edit();
    expect(performance.now() - started).toBeLessThan(ms);
    return text;
  };
  // 180,000 matches in 1.4 MB took six seconds, rebuilding the whole text for each.
  const csv = "aa,bb,cc,dd,ee\n".repeat(45_000);
  expect(within(2000, () => edited(csv, ",", ";", true))).toBe(csv.replaceAll(",", ";"));
  // Found line by line, each match was checked against all those before it.
  const lines = "a  \nb  \n".repeat(100_000);
  expect(within(2000, () => edited(lines, "a\nb", "c\nd", true))).toBe("c\nd\n".repeat(100_000));
});

test("edits through the tool: keeps a CRLF file's endings, words a miss and a repeat for the model, and takes the arguments it always took", async () => {
  const cwd = folder();
  writeFileSync(join(cwd, "a.txt"), "one\r\ntwo\r\none\r\n");
  mkdirSync(join(cwd, "dir"));
  const fake = rl([
    { calls: [{ name: "read_file", args: { path: "a.txt" } }] },
    { calls: [{ name: "edit_file", args: { path: "a.txt", old_string: "one", new_string: "1" } }] },
    { calls: [{ name: "edit_file", args: { path: "a.txt", old_string: "one", new_string: "1", replace_all: true } }] },
    { calls: [{ name: "edit_file", args: { path: "a.txt", old_string: "two\n1", new_string: "2\n1" } }] },
    { calls: [{ name: "edit_file", args: { path: "a.txt", old_string: "2\nthree", new_string: "x" } }] },
    { calls: [{ name: "edit_file", args: { path: "a.txt", old_string: "same", new_string: "same" } }] },
    { calls: [{ name: "edit_file", args: { path: "dir", old_string: "x", new_string: "y" } }] },
    { text: "Done." },
  ]);
  const { sink, out } = sinkFor();
  await driver(rlCtx(fake, cwd)).runTurn(turn("Edit it"), sink);
  const path = join(cwd, "a.txt");
  const [read, ...tools] = fake.state.chats.slice(1).map((c) => c.messages.at(-1).content);
  // A model reads the view it's matched against: no \r to copy, or to leave out.
  expect(read).toBe("1\tone\n2\ttwo\n3\tone\n4\t");
  expect(tools[0]).toBe(`old_string appears 2 times in ${path}. Include more of the surrounding text to make it unique, or set replace_all.`);
  expect(tools[1]).toBe(`Edited ${path} (2 places).`);
  expect(tools[2]).toBe(`Edited ${path} (1 place).`);
  expect(tools[3]).toBe(`old_string isn't in ${path}. Read the file again and copy the exact text, spaces included.\n\nThe closest lines in the file:\n2\t2`);
  expect(tools[4]).toBe("old_string and new_string are the same, so there is nothing to change.");
  expect(tools[5]).toBe(`${join(cwd, "dir")} is a folder, not a file.`);
  expect(readFileSync(path, "utf8")).toBe("1\r\n2\r\n1\r\n");
  expect(out.activities.map((a) => a.status)).toEqual(["done", "error", "done", "done", "error", "error", "error"]);
  const description = fake.state.chats[0].tools.find((t: { function: { name: string } }) => t.function.name === "edit_file").function;
  expect(Object.keys(description.parameters.properties)).toEqual(["path", "old_string", "new_string", "replace_all"]);
  expect(description.description).toContain("line endings are kept");
});

test("edits through the tool: a byte order mark stays, and a file that isn't UTF-8 isn't damaged", async () => {
  const cwd = folder();
  writeFileSync(join(cwd, "marked.txt"), "\uFEFFone\r\ntwo\r\n");
  const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  writeFileSync(join(cwd, "latin.txt"), latin);
  const fake = rl([{ calls: [{ name: "edit_file", args: { path: "marked.txt", old_string: "one\n", new_string: "uno\n" } }] }, { calls: [{ name: "edit_file", args: { path: "latin.txt", old_string: "caf", new_string: "tea" } }] }, { text: "Done." }]);
  await driver(rlCtx(fake, cwd)).runTurn(turn("Edit them"), sinkFor().sink);
  expect(readFileSync(join(cwd, "marked.txt")).equals(Buffer.from("\uFEFFuno\r\ntwo\r\n"))).toBe(true);
  expect(readFileSync(join(cwd, "latin.txt")).equals(latin)).toBe(true);
  expect(fake.state.chats[2].messages.at(-1).content).toBe(`${join(cwd, "latin.txt")} isn't UTF-8 text, so edit_file would damage it. Change it with run_command instead.`);
});

/** `n` steps that each run a command: enough of a conversation behind it to summarise. */
const echoes = (n: number, usage?: { prompt: number; completion: number }): RefuselessReply[] => Array.from({ length: n }, (_, i) => ({ calls: [{ name: "run_command", args: { command: `echo step-${i}` } }], ...(usage ? { usage } : {}) }));
/** A step that runs a command, reported at this many tokens. */
const callAt = (usage: { prompt: number; completion: number }, command = "echo big"): RefuselessReply => ({ calls: [{ name: "run_command", args: { command } }], usage });
const TOO_LONG: RefuselessReply = { status: 400, code: "context_length_exceeded", error: "This model's maximum context length is 1048576 tokens. However, your messages resulted in 1050000 tokens." };
/** Which of a stand-in's requests were for a summary. */
const summaries = (fake: { state: { chats: Record<string, unknown>[] } }) => fake.state.chats.flatMap((c, i) => (c.stream === false ? [i] : []));

test("context: a big model compacts at 250,000 tokens rather than three quarters of its window, and a chat's own setting wins", async () => {
  const run = async (usage: { prompt: number; completion: number }, o: CtxOptions = {}) => {
    const fake = rl([...echoes(5), callAt(usage), { text: "SUMMARY" }, { text: "Carried on." }]);
    await driver(rlCtx(fake, folder(), "mb-rl", o)).runTurn(turn("Work"), sinkFor().sink);
    return summaries(fake);
  };
  // On a 1M model: not below it, at it, and long before three quarters (786,432).
  expect(await run({ prompt: 240_000, completion: 5000 })).toEqual([]);
  expect(await run({ prompt: 249_000, completion: 1000 })).toEqual([6]);
  // A small window is still three quarters of itself.
  expect(await run({ prompt: 70_000, completion: 0 }, { contextWindow: 100_000 })).toEqual([]);
  expect(await run({ prompt: 75_000, completion: 0 }, { contextWindow: 100_000 })).toEqual([6]);
  // "Compact automatically at" says otherwise, either way.
  expect(await run({ prompt: 300_000, completion: 0 }, { config: { autoCompact: 400_000 } })).toEqual([]);
  expect(await run({ prompt: 400_000, completion: 0 }, { config: { autoCompact: 400_000 } })).toEqual([6]);
  expect(await run({ prompt: 60_000, completion: 0 }, { config: { autoCompact: 50_000 } })).toEqual([6]);
});

test("context: the check counts what was added since the last answer's token count, so a big tool output compacts before it goes out", async () => {
  const usage = { prompt: 245_000, completion: 0 };
  const big = "head -c 30000 /dev/zero | tr '\\0' x";
  const small = rl([...echoes(5), callAt(usage), { text: "Done." }]);
  await driver(rlCtx(small, folder())).runTurn(turn("Work"), sinkFor().sink);
  expect(summaries(small)).toEqual([]);
  // The same answer's token count, but with 30,000 characters of output after it: about 7,400 tokens more.
  const fake = rl([...echoes(5), callAt(usage, big), { text: "SUMMARY" }, { text: "Done." }]);
  await driver(rlCtx(fake, folder())).runTurn(turn("Work"), sinkFor().sink);
  expect(summaries(fake)).toEqual([6]);
  // Measured again by the next answer: the summary is what it goes on from, and it isn't summarised again.
  expect(fake.state.chats).toHaveLength(8);
  expect(String(fake.state.chats[7].messages[1].content)).toBe("[A summary of the conversation before this point]\n\nSUMMARY");
});

test("context: a reply starts by counting the conversation it was given, so one that outgrew the limit between replies compacts first", async () => {
  const fake = rl([...Array.from({ length: 6 }, () => callAt({ prompt: 1000, completion: 50 }, "head -c 10000 /dev/zero | tr '\\0' x")), { text: "First answer." }, { text: "SUMMARY" }, { text: "Second answer." }]);
  const d = driver(rlCtx(fake, folder(), "mb-rl", { config: { autoCompact: 10_000 } }));
  await d.runTurn(turn("Work", ["m1"]), sinkFor().sink);
  expect(summaries(fake)).toEqual([]);
  const { sink, out } = sinkFor();
  expect(await d.runTurn(turn("And now?", ["m2"]), sink)).toEqual({ ok: true });
  expect(summaries(fake)).toEqual([7]);
  expect(out.text).toBe("Second answer.");
  expect(fake.state.chats[8].messages.at(-1)).toEqual({ role: "user", content: "And now?" });
  // The message that started this reply can still be rewound to.
  expect(await d.rewind("m2")).toEqual(["m2"]);
});

test("context: a service that says it's too long gets a summary and the call again, in the same reply", async () => {
  const fake = rl([...echoes(5), TOO_LONG, { text: "SUMMARY of five echoes" }, { text: "Carried on." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, folder())).runTurn(turn("Work"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("Carried on.");
  expect(summaries(fake)).toEqual([6]);
  const retried = fake.state.chats[7].messages;
  expect(fake.state.chats[7].stream).toBe(true);
  expect(retried[1].content).toBe("[A summary of the conversation before this point]\n\nSUMMARY of five echoes");
  expect(retried[3]).toEqual({ role: "user", content: "Work" });
  // Less is kept than usual, and a tool's answer still comes with its call.
  expect(retried.slice(4).map((m: { role: string }) => m.role)).toEqual(["assistant", "tool"]);
  expect(out.activities.at(-1)).toMatchObject({ kind: "notice", status: "done" });

  // On the very first call of a reply, and for a 413 too.
  const first = rl([...echoes(5), { text: "First." }, { status: 413, error: "Prompt is too long: 300000 tokens > 200000 maximum" }, { text: "SUMMARY" }, { text: "Second." }]);
  const d = driver(rlCtx(first, folder(), "mb-2"));
  await d.runTurn(turn("Work"), sinkFor().sink);
  const second = sinkFor();
  expect(await d.runTurn(turn("More"), second.sink)).toEqual({ ok: true });
  expect(second.out.text).toBe("Second.");
  expect(first.state.chats.at(-1)!.messages.at(-1)).toEqual({ role: "user", content: "More" });
});

test("what counts as too long: a 400 or 413 in those words, and nothing else", () => {
  const says = (status: number, message: string, code = "") => serviceError(status, JSON.stringify({ error: { message, code } }), "Refuseless", "m").tooLong;
  expect(says(400, "This model's maximum context length is 131072 tokens.")).toBe(true);
  expect(says(400, "Too many tokens in the prompt.")).toBe(true);
  expect(says(400, "Input is too long for requested model.")).toBe(true);
  expect(says(400, "Exceeds the maximum length of the conversation.")).toBe(true);
  expect(says(400, "That won't fit.", "context_length_exceeded")).toBe(true);
  // A message that's too long is the conversation's length; a limit on one field isn't, and a summary changes nothing about it.
  expect(says(400, "Invalid 'messages[1].content': string too long. Expected a string with maximum length 10485760.")).toBe(true);
  expect(says(400, "Invalid 'tools[8].function.description': string too long. Expected a string with maximum length 1024.")).toBe(false);
  expect(says(400, "Invalid 'messages[3].tool_calls[0].id': string too long. Expected a string with maximum length 40.")).toBe(false);
  expect(says(400, "The context parameter isn't one this model takes.")).toBe(false);
  expect(says(413, "Prompt is too long.")).toBe(true);
  expect(serviceError(413, "<html><title>413 Request Entity Too Large</title></html>", "Refuseless", "m").tooLong).toBe(true);
  expect(says(400, "reasoning_effort must be one of off, low, high, max.")).toBe(false);
  expect(says(400, "max_tokens is too large.")).toBe(false);
  expect(says(422, "Too many tokens.")).toBe(false);
  expect(says(429, "Too many tokens per minute.")).toBe(false);
  expect(says(500, "context canceled")).toBe(false);
  expect(says(404, "The model has too long a name and was not found.")).toBe(false);
  // Money and the model are said as such, whichever words come with them.
  expect(says(402, "Your context is too long for your balance.")).toBe(false);
});

test("context: other refusals aren't mistaken for that, and what can't be summarised ends in plain words with how to go on", async () => {
  // Nothing to summarise yet: one message that doesn't fit.
  const fits = rl([TOO_LONG]);
  const r = await driver(rlCtx(fits, folder())).runTurn(turn("A very long paste"), sinkFor().sink);
  expect(r).toEqual({ ok: false, error: `This conversation is too long for ${RL_PICK}, and it couldn't be summarised to make room. To go on, edit your last message to make it shorter, start a new chat and say where the work stands, or pick a model that holds more in this chat's settings. (The service said: ${TOO_LONG.error})` });
  expect(fits.state.chats).toHaveLength(1);

  // Summarised, and still too long.
  const still = rl([...echoes(5), TOO_LONG, { text: "SUMMARY" }, TOO_LONG, { text: "Never asked for." }]);
  const r2 = await driver(rlCtx(still, folder(), "mb-2")).runTurn(turn("Work"), sinkFor().sink);
  expect(r2).toEqual({ ok: false, error: `This conversation is too long for ${RL_PICK}, even summarised. To go on, edit your last message to make it shorter, start a new chat and say where the work stands, or pick a model that holds more in this chat's settings. (The service said: ${TOO_LONG.error})` });
  expect(still.state.chats).toHaveLength(8);

  // Any other 400 is said as it was, with no summary and no second try.
  const other = rl([{ status: 400, code: "bad_request", error: "reasoning_effort must be one of off, low, high, max." }]);
  const r3 = await driver(rlCtx(other, folder(), "mb-3")).runTurn(turn("Go"), sinkFor().sink);
  expect(r3).toEqual({ ok: false, error: "Refuseless turned the request down (error 400: reasoning_effort must be one of off, low, high, max.). Check the model and its settings in Settings → AI services, then tap Try again." });
  expect(other.state.chats).toHaveLength(1);
});

test("context: a summary's own request that's too long goes again with less, down to giving up in plain words", async () => {
  const big = "head -c 12000 /dev/zero | tr '\\0' x";
  const work = Array.from({ length: 9 }, () => callAt({ prompt: 1000, completion: 50 }, big));
  // Refused with all of it, accepted with the long messages cut short.
  const fake = rl([...work, TOO_LONG, TOO_LONG, { text: "SUMMARY" }, { text: "Carried on." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, folder())).runTurn(turn("Work"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("Carried on.");
  const [whole, less] = summaries(fake).map((i) => fake.state.chats[i]);
  expect(JSON.stringify(less.messages).length).toBeLessThan(JSON.stringify(whole.messages).length / 2);
  expect(Math.max(...less.messages.filter((m: { role: string }) => m.role === "tool").map((m: { content: string }) => m.content.length))).toBeLessThan(4100);
  // Each call still has its answers.
  expect(less.messages.filter((m: { role: string }) => m.role === "tool").length).toBe(whole.messages.filter((m: { role: string }) => m.role === "tool").length);
  expect(out.activities.at(-1)).toMatchObject({ status: "done", detail: expect.stringContaining("the longest ones cut short to fit") });

  // Refused however little goes: the card says so, and so does the reply. Each try is smaller than the one before.
  const never = rl([...work, ...Array.from({ length: 9 }, () => TOO_LONG)]);
  const second = sinkFor();
  const r = await driver(rlCtx(never, folder(), "mb-2")).runTurn(turn("Work"), second.sink);
  expect(r).toEqual({ ok: false, error: `This conversation is too long for ${RL_PICK}, and it couldn't be summarised to make room. To go on, edit your last message to make it shorter, start a new chat and say where the work stands, or pick a model that holds more in this chat's settings. (The service said: ${TOO_LONG.error})` });
  const sizes = summaries(never).map((i) => JSON.stringify(never.state.chats[i].messages).length);
  expect(sizes).toHaveLength(4);
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  expect(never.state.chats[summaries(never).at(-1)!].messages.filter((m: { role: string }) => m.role === "tool").length).toBeLessThan(4);
  // Never a tool's answer without the call it answers.
  for (const i of summaries(never)) expect(never.state.chats[i].messages[1].role).not.toBe("tool");
  expect(second.out.activities.at(-1)).toMatchObject({ status: "error", detail: "Couldn't summarise: the conversation is too long for the model, even cut down." });
});

test("context: a summary that fails any other way never fails the reply on its own, and isn't asked for at every step", async () => {
  const high = { prompt: 260_000, completion: 0 };
  const down = Array.from({ length: 4 }, () => ({ status: 502, code: "upstream_error", error: "Backend error." }));
  const fake = rl([...echoes(5), callAt(high), ...down, callAt(high), callAt(high), callAt({ prompt: 290_000, completion: 0 }), { text: "SUMMARY" }, { text: "Done." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, folder()), { pause: async () => {} }).runTurn(turn("Work"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("Done.");
  // Tried as any request is (four times over), then not again until the conversation had grown by a tenth.
  expect(summaries(fake)).toEqual([6, 7, 8, 9, 13]);
  const cards = out.activities.filter((a) => a.kind === "notice");
  expect(cards.map((a) => a.status)).toEqual(["error", "done"]);
  expect(cards[0].detail).toBe("Couldn't summarise: Refuseless had a problem (error 502: Backend error.). Wait a minute, then tap Try again.");

  // A connection that won't connect, with the model call itself fine.
  const net = rl([...echoes(5), callAt(high), { text: "Done anyway." }]);
  const real = fetch;
  const noSummary: typeof fetch = (async (url: string, init?: RequestInit) => {
    if (String(init?.body).includes('"stream":false')) throw new TypeError("connection refused");
    return real(url, init);
  }) as unknown as typeof fetch;
  const second = sinkFor();
  expect(await driver(rlCtx(net, folder(), "mb-2"), { pause: async () => {}, fetch: noSummary }).runTurn(turn("Work"), second.sink)).toEqual({ ok: true });
  expect(second.out.text).toBe("Done anyway.");
  expect(second.out.activities.find((a) => a.kind === "notice")).toMatchObject({ status: "error", detail: "Couldn't summarise: Couldn't reach Refuseless. Check this machine's internet connection, then tap Try again." });

  // No summary came back, or only a tool call written as text: nothing is replaced.
  const blank = rl([...echoes(5), callAt(high), { text: DSML }, { text: "Done anyway." }]);
  const third = sinkFor();
  expect(await driver(rlCtx(blank, folder(), "mb-3")).runTurn(turn("Work"), third.sink)).toEqual({ ok: true });
  expect(third.out.activities.find((a) => a.kind === "notice")).toMatchObject({ status: "error", detail: "Couldn't summarise: the model sent back no summary." });
  expect(blank.state.chats.at(-1)!.messages[1]).toEqual({ role: "user", content: "Work" });
});

test("context: a too-long reply whose summary is refused for money, the key or a limit says that instead, and Stop stops it", async () => {
  const cwd = folder();
  const broke = rl([...echoes(5), TOO_LONG, { status: 402, code: "insufficient_credits", error: "Insufficient balance." }]);
  const r = await driver(rlCtx(broke, cwd, "mb-1")).runTurn(turn("Work"), sinkFor().sink);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("isn't enough money in the account");
  // A limit is waited out, as for any request, then carried on from.
  const limited = rl([...echoes(5), TOO_LONG, ...Array.from({ length: 7 }, () => ({ status: 429, code: "model_busy", error: "Model is busy.", retryAfter: "15" }))]);
  const r2 = await driver(rlCtx(limited, cwd, "mb-2"), { pause: async () => {} }).runTurn(turn("Work"), sinkFor().sink);
  expect(r2).toMatchObject({ ok: false, error: `429 rate limit: Refuseless says ${RL_PICK} is busy (Model is busy.)`, limit: { kind: "rate" } });

  // Stopped while summarising.
  const fake = rl([...echoes(5), TOO_LONG, { text: "Never used." }]);
  const { sink, out } = sinkFor();
  const real = fetch;
  const stopping: typeof fetch = (async (url: string, init?: RequestInit) => {
    if (String(init?.body).includes('"stream":false')) {
      out.stop();
      throw new DOMException("Aborted", "AbortError");
    }
    return real(url, init);
  }) as unknown as typeof fetch;
  expect(await driver(rlCtx(fake, cwd, "mb-3"), { fetch: stopping }).runTurn(turn("Work"), sink)).toEqual({ ok: false, error: "stopped" });
  expect(out.activities.at(-1)).toMatchObject({ kind: "notice", status: "error", detail: "Stopped." });
});

test("context: a limit on one field isn't the conversation's length: no summary, the service's words, and all of it kept", async () => {
  const field = "Invalid 'tools[8].function.description': string too long. Expected a string with maximum length 1024.";
  const cwd = folder();
  const fake = rl([...echoes(5), { status: 400, code: "invalid_request_error", error: field }, { text: "Never asked for." }]);
  const r = await driver(rlCtx(fake, cwd)).runTurn(turn("Work"), sinkFor().sink);
  expect(r).toEqual({ ok: false, error: `Refuseless turned the request down (error 400: ${field}). Check the model and its settings in Settings → AI services, then tap Try again.` });
  expect(summaries(fake)).toEqual([]);
  expect(JSON.parse(readFileSync(join(cwd, ".run/builtin/mb-rl.json"), "utf8")).messages[0]).toEqual({ role: "user", content: "Work" });
});

test("context: a summary made of only the later part of the conversation says so", async () => {
  const big = "head -c 12000 /dev/zero | tr '\\0' x";
  const work = Array.from({ length: 9 }, () => callAt({ prompt: 1000, completion: 50 }, big));
  // Refused whole, refused with long messages cut, accepted with the later half.
  const fake = rl([...work, TOO_LONG, TOO_LONG, TOO_LONG, { text: "SUMMARY" }, { text: "Carried on." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, folder())).runTurn(turn("Work"), sink)).toEqual({ ok: true });
  const sent = fake.state.chats[summaries(fake).at(-1)!].messages.length - 2;
  const all = fake.state.chats[summaries(fake)[0]].messages.length - 2;
  expect(sent).toBeLessThan(all);
  expect(out.activities.at(-1)).toMatchObject({ status: "done", detail: `The last ${sent} of ${all} messages summarised, cut short to fit: the ${all - sent} before them didn't fit and are gone.` });
});

/** A stream the stand-ins can't script: a tool call with these very arguments, ended as this says. */
const callWith = (name: string, args: string, finish = "length") =>
  new Response(
    `${[{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_raw", type: "function", function: { name, arguments: args } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

/** The first model calls answered with these raw streams, the rest by the strict stand-in. */
function rawFirst(streams: (() => Response)[]) {
  const strict = strictFetch();
  const raw = [...streams];
  const get = (async (url: string, init?: RequestInit) => (typeof init?.body === "string" && raw.length ? raw.shift()!() : strict.get(url, init))) as unknown as typeof fetch;
  return { get, refused: strict.refused };
}

test("what a service can't take isn't sent: half an emoji from a cut, in a tool's output or the instructions", async () => {
  const cwd = folder();
  // The cut of a long line falls between an emoji's two halves. The whole one on the next line stays whole.
  writeFileSync(join(cwd, "long.txt"), `${"x".repeat(1999)}\u{1F600} and on\nwhole \u{1F600}\n`);
  // And so does the cut of a project's long instructions.
  writeFileSync(join(cwd, "AGENTS.md"), `${"y".repeat(31_999)}\u{1F600} and on\n`);
  const fake = rl([{ calls: [{ name: "read_file", args: { path: "long.txt" } }] }, { text: "Read it." }, { text: "And the next." }]);
  const strict = strictFetch();
  const d = driver(rlCtx(fake, cwd), { fetch: strict.get });
  expect(await d.runTurn(turn("Read it"), sinkFor().sink)).toEqual({ ok: true });
  expect(strict.refused).toEqual([]);
  const said = String(fake.state.chats[1].messages.at(-1).content);
  expect(said).toContain("\uFFFD…");
  expect(said).toContain("whole \u{1F600}");
  expect(String(fake.state.chats[0].messages[0].content)).toContain(`${"y".repeat(31_999)}\uFFFD`);
  // What's kept isn't changed, and a later message goes the same way.
  expect(await d.runTurn(turn("And now?"), sinkFor().sink)).toEqual({ ok: true });
  expect(strict.refused).toEqual([]);
});

test("what a service can't take isn't sent: a tool call's arguments cut short, or not an object, though the model is told and the tool doesn't run", async () => {
  const cwd = folder();
  const service = rawFirst([() => callWith("write_file", '{"path":"made.txt","content":"half of i'), () => callWith("run_command", "null", "tool_calls")]);
  const fake = rl([{ text: "Done." }, { text: "And the next." }]);
  const d = driver(rlCtx(fake, cwd), { fetch: service.get, pause: async () => {} });
  expect(await d.runTurn(turn("Write it"), sinkFor().sink)).toEqual({ ok: true });
  expect(service.refused).toEqual([]);
  expect(existsSync(join(cwd, "made.txt"))).toBe(false);
  const sent = fake.state.chats[0].messages.slice(1);
  expect(sent[1].tool_calls[0].function.arguments).toBe("{}");
  expect(sent[2].content).toContain("aren't valid JSON");
  expect(sent[3].tool_calls[0].function.arguments).toBe("{}");
  expect(sent[4].content).toBe("The command is empty.");
  // Kept as they came, for what the model is told; only what's sent is mended.
  const kept = JSON.parse(readFileSync(join(cwd, ".run/builtin/mb-rl.json"), "utf8")).messages;
  expect(kept[1].tool_calls[0].function.arguments).toBe('{"path":"made.txt","content":"half of i');
  expect(await d.runTurn(turn("And now?"), sinkFor().sink)).toEqual({ ok: true });
  expect(service.refused).toEqual([]);
});

test("a chat already saved with half an emoji and broken arguments carries on, and can be summarised, with nothing for the person to do", async () => {
  const cwd = folder();
  const filler = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `filler ${i}` }));
  const broken = [
    { role: "user", content: "Read it" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"a' } }] },
    { role: "tool", tool_call_id: "c1", content: "half \ud83d" },
  ];
  mkdirSync(join(cwd, ".run/builtin"), { recursive: true });
  writeFileSync(join(cwd, ".run/builtin/mb-rl.json"), JSON.stringify({ v: 1, messages: [...broken, ...filler], turns: [{ at: 0, ids: [] }] }));
  const fake = rl([{ text: "Fine." }, { text: "SUMMARY" }]);
  const strict = strictFetch();
  const d = driver(rlCtx(fake, cwd), { fetch: strict.get });
  expect(await d.runTurn(turn("Go on"), sinkFor().sink)).toEqual({ ok: true });
  expect(strict.refused).toEqual([]);
  expect(fake.state.chats[0].messages[3].content).toBe("half \uFFFD");
  const { sink, out } = sinkFor();
  expect(await d.runTurn(turn("/compact"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("Done: the conversation so far is summarised, and the chat goes on from the summary.");
  expect(strict.refused).toEqual([]);
});

test("/compact fails when a summary couldn't be made, in the service's words with Try again under them, and says when there wasn't enough for one", async () => {
  const cwd = folder();
  const d = driver(rlCtx(rl([...echoes(5), { text: "Done." }, { status: 400, code: "bad_request", error: "No." }, { text: DSML }]), cwd), { pause: async () => {} });
  const nothing = sinkFor();
  expect(await d.runTurn(turn("/compact"), nothing.sink)).toEqual({ ok: true });
  expect(nothing.out.text).toBe("There wasn't enough to summarise yet.");
  await d.runTurn(turn("Work"), sinkFor().sink);
  // A failed reply, as OpenCode's /compact is: it's what gets Try again, and for a refused key Open AI services.
  const refused = sinkFor();
  expect(await d.runTurn(turn("/compact"), refused.sink)).toEqual({ ok: false, error: "Refuseless turned the request down (error 400: No.). Check the model and its settings in Settings → AI services, then tap Try again." });
  expect(refused.out.text).toBe("");
  // A rate limit on the summary waits for its reset, as on any request.
  const limited = driver(rlCtx(rl([...echoes(5), { text: "Done." }, { status: 429, error: "Too many requests" }]), folder(), "mb-limit"), { pause: async () => {} });
  await limited.runTurn(turn("Work"), sinkFor().sink);
  expect((await limited.runTurn(turn("/compact"), sinkFor().sink)).limit).toMatchObject({ kind: "rate" });
  // No summary came back: its card says why, and the reply how to go on.
  const blank = sinkFor();
  expect(await d.runTurn(turn("/compact"), blank.sink)).toEqual({ ok: false, error: "The conversation couldn't be summarised, so the chat goes on as it is. Tap Try again, or start a new chat." });
  expect(blank.out.activities.at(-1)).toMatchObject({ status: "error", detail: "Couldn't summarise: the model sent back no summary." });
});

test("effort and output: what the chat picked and what the hub knows go on model calls, and nothing is invented", async () => {
  // Refuseless, on a model whose limit the hub knows, in a chat that picked an effort.
  const fake = rl([...echoes(5), callAt({ prompt: 260_000, completion: 0 }), { text: "SUMMARY" }, { text: "Done." }]);
  await driver(rlCtx(fake, folder(), "mb-1", { config: { effort: "high" } })).runTurn(turn("Work"), sinkFor().sink);
  expect(fake.state.chats[0]).toMatchObject({ reasoning_effort: "high", max_tokens: 131_072 });
  expect(fake.state.chats.at(-1)).toMatchObject({ reasoning_effort: "high", max_tokens: 131_072 });
  // A summary doesn't think on the chat's effort, and is free to be as long as the model can write.
  const summary = fake.state.chats[summaries(fake)[0]];
  expect("reasoning_effort" in summary).toBe(false);
  expect(summary.max_tokens).toBe(131_072);

  // Nothing picked: nothing sent.
  const plain = rl([{ text: "Hi." }]);
  await driver(rlCtx(plain, folder(), "mb-2")).runTurn(turn("Hi"), sinkFor().sink);
  expect("reasoning_effort" in plain.state.chats[0]).toBe(false);
  // A model on the page with no limit given.
  const unlisted = rl([{ text: "Hi." }]);
  await driver(rlCtx(unlisted, folder(), "mb-3", { model: "deepseek-v4.1-flash-abliterated-free" })).runTurn(turn("Hi"), sinkFor().sink);
  expect("max_tokens" in unlisted.state.chats[0]).toBe(false);
  // A model the hub has never heard of.
  const unknown = rl([{ text: "Hi." }]);
  await driver(rlCtx(unknown, folder(), "mb-4", { model: "some-new-model" })).runTurn(turn("Hi"), sinkFor().sink);
  expect("max_tokens" in unknown.state.chats[0]).toBe(false);
  // Another service: nothing about output, even for a model of the same name.
  const nanoSame = nano([{ text: "Hi." }]);
  await driver(ctxFor(nanoSame, folder(), { model: RL_PICK, config: { effort: "low" } })).runTurn(turn("Hi"), sinkFor().sink);
  expect("max_tokens" in nanoSame.state.chats[0]).toBe(false);
  expect(nanoSame.state.chats[0].reasoning_effort).toBe("low");
  // A renamed account on Refuseless's own address is still Refuseless.
  const seen: string[] = [];
  const renamed: typeof fetch = (async (_url: string, init?: RequestInit) => {
    seen.push(String(init?.body));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const ctx = rlCtx({ base: "https://api.refuseless.com" }, folder(), "mb-5", { label: "My models" });
  await driver(ctx, { fetch: renamed }).runTurn(turn("Hi"), sinkFor().sink);
  expect(JSON.parse(seen[0]).max_tokens).toBe(131_072);
});

test("one check before finishing: a reply that changed files and ran nothing after is asked once, in a project", async () => {
  const cwd = folder();
  mkdirSync(join(cwd, ".git"));
  const write = { calls: [{ name: "write_file", args: { path: "src/a.ts", content: "x\n" } }] };
  const fake = rl([write, { text: "Wrote it." }, { calls: [{ name: "run_command", args: { command: "echo tests pass" } }] }, { text: "Checked: the tests pass." }]);
  const { sink, out } = sinkFor();
  expect(await driver(rlCtx(fake, cwd)).runTurn(turn("Change it"), sink)).toEqual({ ok: true });
  expect(fake.state.chats).toHaveLength(4);
  expect(fake.state.chats[2].messages.slice(-2)).toEqual([
    { role: "assistant", content: "Wrote it." },
    { role: "user", content: CHECK_NUDGE },
  ]);
  expect(out.text).toBe("Wrote it.\n\nChecked: the tests pass.");
  expect(CHECK_NUDGE).toBe("You changed files and ran nothing after the last change. Run the project's own checks for what you changed, read git status and git diff, fix what fails, and then finish.");

  // At most once in a reply: fixing something after it needn't be checked again by this.
  const again = rl([write, { text: "Wrote it." }, { calls: [{ name: "edit_file", args: { path: "src/a.ts", old_string: "x", new_string: "y" } }] }, { text: "Fixed." }, { text: "Never asked for." }]);
  expect(await driver(rlCtx(again, cwd, "mb-2")).runTurn(turn("Change it"), sinkFor().sink)).toEqual({ ok: true });
  expect(again.state.chats).toHaveLength(4);
  expect(again.state.chats[3].messages.filter((m: { content: string }) => m.content === CHECK_NUDGE)).toHaveLength(1);

  // Each reply gets its own: not one that changes nothing, even after one that did, and again for the next that does.
  const later = rl([write, { text: "Wrote it." }, { text: "Done." }, { text: "Next." }, { calls: [{ name: "edit_file", args: { path: "src/a.ts", old_string: "x", new_string: "z" } }] }, { text: "Changed." }, { text: "Done." }]);
  const d3 = driver(rlCtx(later, cwd, "mb-3"));
  await d3.runTurn(turn("One"), sinkFor().sink);
  await d3.runTurn(turn("Two"), sinkFor().sink);
  expect(later.state.chats.at(-1)!.messages.filter((m: { content: string }) => m.content === CHECK_NUDGE)).toHaveLength(1);
  await d3.runTurn(turn("Three"), sinkFor().sink);
  expect(later.state.chats.at(-1)!.messages.filter((m: { content: string }) => m.content === CHECK_NUDGE)).toHaveLength(2);
});

test("one check before finishing: not when something ran after the last change, or nothing changed", async () => {
  const cwd = folder();
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, "a.txt"), "one\n");
  const write = { calls: [{ name: "write_file", args: { path: "b.txt", content: "x\n" } }] };
  const run = { calls: [{ name: "run_command", args: { command: "echo checked" } }] };
  const replies = async (script: RefuselessReply[], memberId: string, mode = "full", decisions: ApprovalDecision[] = []) => {
    const fake = rl(script);
    await driver(rlCtx(fake, cwd, memberId, { mode }), { pause: async () => {} }).runTurn(turn("Go"), sinkFor(decisions).sink);
    return fake.state.chats.at(-1)!.messages.filter((m: { content: string }) => m.content === CHECK_NUDGE).length;
  };
  // A command after the last change, even one that failed.
  expect(await replies([write, run, { text: "Done." }], "mb-1")).toBe(0);
  expect(await replies([write, { calls: [{ name: "run_command", args: { command: "exit 3" } }] }, { text: "It failed." }], "mb-2")).toBe(0);
  // A command only before the last change doesn't count.
  expect(await replies([run, write, { text: "Done." }], "mb-3")).toBe(1);
  // Reads, and edits that failed, change nothing.
  expect(await replies([{ calls: [{ name: "read_file", args: { path: "a.txt" } }] }, { text: "Read it." }], "mb-4")).toBe(0);
  expect(await replies([{ calls: [{ name: "edit_file", args: { path: "a.txt", old_string: "missing", new_string: "x" } }] }, { text: "Couldn't." }], "mb-5")).toBe(0);
  // The person turned a command down: asking it to run them would only ask them again.
  expect(await replies([write, run, { text: "Left it unchecked." }], "mb-6", "edits", ["deny"])).toBe(0);
  // Empty and leaked answers come first; it's still asked after them.
  expect(await replies([write, { text: DSML }, {}, { text: "Done." }, { text: "Checked." }], "mb-7")).toBe(1);
});

test("one check before finishing: only where there's a project to run it on", async () => {
  const write = (path: string) => ({ calls: [{ name: "write_file", args: { path, content: "x\n" } }] });
  const asked = async (cwd: string, path: string) => {
    const fake = rl([write(path), { text: "Done." }, { text: "Checked." }]);
    const { sink, out } = sinkFor();
    await driver(rlCtx(fake, cwd)).runTurn(turn("Go"), sink);
    return { times: fake.state.chats.length - 1, out };
  };
  // A folder of notes: nothing to run.
  const notes = await asked(folder(), "notes.md");
  expect(notes.times).toBe(1);
  expect(notes.out.text).toBe("Done.");
  // A package or build file in it, or a file of the kind that has none of one name.
  const pkg = folder();
  writeFileSync(join(pkg, "package.json"), "{}");
  expect((await asked(pkg, "a.ts")).times).toBe(2);
  const make = folder();
  writeFileSync(join(make, "Makefile"), "all:\n");
  expect((await asked(make, "src/deep/er/a.c")).times).toBe(2);
  const dotnet = folder();
  writeFileSync(join(dotnet, "App.csproj"), "<Project/>");
  expect((await asked(dotnet, "a.cs")).times).toBe(2);
  // A project the reply works on inside a folder that isn't one, or next to it: where the change is decides.
  const outer = folder();
  mkdirSync(join(outer, "repo", ".git"), { recursive: true });
  expect((await asked(outer, "repo/a.ts")).times).toBe(2);
  const inRepo = folder();
  mkdirSync(join(inRepo, ".git"));
  const elsewhere = folder();
  expect((await asked(inRepo, join(elsewhere, "note.md"))).times).toBe(1);
  // A git worktree's .git is a file.
  const worktree = folder();
  writeFileSync(join(worktree, ".git"), "gitdir: /somewhere\n");
  expect(inProject(worktree)).toBe(true);
  expect(inProject(join(worktree, "gone", "folder"))).toBe(true);
  // A stray package file in the home folder doesn't make everything under it a project.
  const home = folder();
  writeFileSync(join(home, "package.json"), "{}");
  mkdirSync(join(home, "notes"));
  expect(inProject(join(home, "notes"), home)).toBe(false);
  expect(inProject(join(home, "notes"), "/elsewhere")).toBe(true);
  mkdirSync(join(home, ".git"));
  expect(inProject(join(home, "notes"), home)).toBe(true);
});

test("the instructions say what the agent now relies on, and stay the same at every step", async () => {
  const fake = rl([{ text: `Oops.\n${DSML}` }, {}, { text: "Done." }]);
  await driver(rlCtx(fake, folder())).runTurn(turn("Go"), sinkFor().sink);
  const system = String(fake.state.chats[0].messages[0].content);
  expect(system).toContain("a call written out as text in your answer doesn't run");
  expect(system).toContain("run the project's own checks");
  expect(fake.state.chats.map((c) => c.messages[0].content)).toEqual([system, system, system]);
});
