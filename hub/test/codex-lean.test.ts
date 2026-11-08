import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_LEAN_TOOLS_BELOW, CODEX_PROMPT_FLOOR, leanCodexTools, leanToolsWords, type ApprovalDecision, type Member, type Room } from "@crosstalk/shared";
import type { ActivityInput, AgentDriver, DriverContext, TurnSink } from "../src/agents/driver";
import { CODEX_QUESTION_NOTE, CodexDriver, takesLeanTools, threadWarning } from "../src/agents/codex";
import { helperNote } from "../src/agents/model-lock";

/**
 * A chat on a model server of your own that holds too little for the person's own Codex setup: Codex is asked to leave
 * their plugins, their ChatGPT app connectors and its own helper tools out of that thread, so the catalogue is never
 * built or sent at all (the adapter's trimming stays as the backstop for everything else).
 */
const FIX = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * What the person's own Codex says it has, as a typical setup does: their own MCP server, Crosstalk's setup server (which
 * Crosstalk itself tells them to add: `codex mcp add crosstalk-setup …`, docs/SETUP-FOR-AGENTS.md) and their installed plugins.
 */
const OWN = { mcp_servers: ["node_repl", "crosstalk-setup"], plugins: ["codex-app-tools@openai-bundled", "browser@openai-bundled"] };

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const turn = (d: AgentDriver, prompt: string, s: TurnSink) => d.runTurn({ turnId: `t-${prompt}`, prompt, systemNote: null }, s);

function sink() {
  const abort = new AbortController();
  const rec = { text: "", activities: [] as ActivityInput[], session: {} as Record<string, unknown> };
  const s: TurnSink = {
    signal: abort.signal,
    text: (d) => (rec.text += d),
    setText: (t) => (rec.text = t),
    activity: (a) => (rec.activities.push(a), `a${rec.activities.length}`),
    updateActivity: () => {},
    approval: async () => "approve" as ApprovalDecision,
    usage: () => {},
    rateLimit: () => {},
    status: () => {},
    saveSession: (p) => Object.assign(rec.session, p),
  };
  return { sink: s, rec, abort };
}

/** A Codex chat on a custom-model account, with the fake app-server standing in for Codex. */
function chat(opts: { window?: number | null; endpoint?: boolean; config?: Record<string, unknown>; session?: Record<string, unknown>; env?: Record<string, string>; home?: string } = {}) {
  const dir = opts.home ?? mkdtempSync(join(tmpdir(), "ct-lean-"));
  dirs.push(dir);
  const room: Room = { id: "r1", name: "Room", cwd: dir, mode: "relay", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
  const member: Member = { id: "m1", roomId: "r1", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: opts.config ?? {}, createdAt: 0, position: 0 };
  const log = join(dir, "thread.json");
  const rpcLog = join(dir, "rpc.jsonl");
  // A Codex home of its own: a chat joins the Codex app's server when one is running, and tests must never.
  const env = { PATH: process.env.PATH ?? "", CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_LOG: log, FAKE_CODEX_RPC_LOG: rpcLog, FAKE_CODEX_OWN_SETUP: JSON.stringify(OWN), ...opts.env };
  const ctx: DriverContext = {
    room,
    member,
    session: opts.session ?? {},
    mcp: { command: "/bin/true", args: ["mcp"], env: { CROSSTALK_MEMBER_ID: "m1" } },
    env,
    bin: "",
    chat: { helper: null, notes: null },
    ...(opts.endpoint === false ? {} : { endpoint: { id: "ep1", label: "Qwen local", baseUrl: "http://127.0.0.1:8099", models: ["qwen3.8-9b"], contextWindow: opts.window === undefined ? 16_384 : opts.window, key: "" } }),
  };
  return {
    ctx,
    d: new CodexDriver(ctx, join(FIX, "fake-codex-app")),
    thread: () => JSON.parse(readFileSync(log, "utf8")),
    config: () => JSON.parse(readFileSync(log, "utf8")).config,
    asked: () => lines(rpcLog).map((x) => x.method).filter(Boolean),
    opened: () => lines(rpcLog).filter((x) => /^thread\/(start|resume|fork)$/.test(x.method ?? "")),
  };
}

describe("a small model of your own is never offered the person's own Codex catalogue", () => {
  test("where the line sits, and the chat's own setting either way", () => {
    expect(CODEX_LEAN_TOOLS_BELOW).toBeGreaterThan(CODEX_PROMPT_FLOOR);
    // A model server of your own, by what the model holds.
    expect(leanCodexTools(true, 16_384)).toBe(true);
    expect(leanCodexTools(true, CODEX_LEAN_TOOLS_BELOW - 1)).toBe(true);
    expect(leanCodexTools(true, CODEX_LEAN_TOOLS_BELOW)).toBe(false);
    expect(leanCodexTools(true, 131_072)).toBe(false);
    // A window nothing states is left alone, as the adapter's own fitting leaves it alone.
    expect(leanCodexTools(true, null)).toBe(false);
    // Not an OpenAI chat: its own model holds plenty, and the connectors are what the person set Codex up for.
    expect(leanCodexTools(false, 16_384)).toBe(false);
    // The chat's own setting decides when it's set, so nothing is taken away without a way back.
    expect(leanCodexTools(true, 16_384, { codexPlugins: true })).toBe(false);
    expect(leanCodexTools(false, 272_000, { codexPlugins: false })).toBe(true);
    expect(leanCodexTools(true, 16_384, {})).toBe(true);
  });

  test("what a model too small for them says where it's picked", () => {
    const words = leanToolsWords("codex", "qwen3.8-9b", 16_384)!;
    // What the model holds it has from the model itself; what the catalogue costs it never states, because only a
    // measurement of that very account knows (toolCostWords says that, with the day it was taken, on its own line).
    expect(words).toContain("16,384");
    expect(words).toContain("Codex's own tools and Crosstalk's only");
    expect(words).not.toMatch(/14[01],000|\d{3},\d{3}/);
    // A model with no room to answer at all is refused in other words (smallWindowWords), so this says nothing.
    expect(leanToolsWords("codex", "qwen3.8-9b", 8_192)).toBeNull();
    expect(leanToolsWords("codex", "gpt-6.1-sol", 272_000)).toBeNull();
    expect(leanToolsWords("codex", "qwen3.8-9b", null)).toBeNull();
    // Claude Code talks to a server of your own directly; it has no catalogue of the person's to leave out.
    expect(leanToolsWords("claude", "qwen3.8-9b", 16_384)).toBeNull();
    // And it never promises a lean chat where the chat's own setting keeps the person's plugins: the same predicate decides
    // the words and the thread (leanCodexTools), so the two can't say different things.
    expect(leanToolsWords("codex", "qwen3.8-9b", 16_384, { codexPlugins: true })).toBeNull();
    expect(leanToolsWords("codex", "qwen3.8-9b", 16_384, { codexPlugins: false })).toBe(words);
    expect(leanToolsWords("codex", "qwen3.8-9b", 16_384, {})).toBe(words);
  });

  test("a 16k model of your own gets Crosstalk's tools and Codex's own, and none of the person's plugins, connectors or helpers", async () => {
    const c = chat();
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const config = c.config();
      // The ChatGPT app connectors (333 tools here) and the goal tools: gone with the whole codex_apps server.
      expect(config.features).toEqual({ default_mode_request_user_input: true, apps: false, goals: false });
      expect(config.include_apps_instructions).toBe(false);
      // Each plugin of theirs off by id, as Codex's own resolved config names them (config/read).
      expect(c.asked()).toContain("config/read");
      expect(config.plugins).toEqual({ "codex-app-tools@openai-bundled": { enabled: false }, "browser@openai-bundled": { enabled: false } });
      // Their own MCP server off; Crosstalk's own untouched beside it (the table merges).
      expect(config.mcp_servers.node_repl).toEqual({ enabled: false });
      expect(config.mcp_servers.crosstalk).toMatchObject({ command: "/bin/true", args: ["mcp"], tool_timeout_sec: 900 });
      // And the setup server Crosstalk told them to add themselves is Crosstalk's too: a lean chat keeps hub_log,
      // setup_status and the rest, which is what its words promise and what the adapter never leaves out of a request.
      expect(config.mcp_servers["crosstalk-setup"]).toBeUndefined();
      expect(Object.keys(config.mcp_servers).sort()).toEqual(["crosstalk", "node_repl"]);
      expect(config.mcp_servers.crosstalk.env).toMatchObject({ CROSSTALK_TOOLSET: "chat" });
      // No helper agents, so no roles to hold them to a model, no spawn-tool setting, and no tool for picking their model.
      expect(config.agents).toEqual({ enabled: false });
      expect(config.features.multi_agent_v2).toBeUndefined();
      expect(config.mcp_servers.crosstalk.env.CROSSTALK_HELPER_MODEL).toBeUndefined();
      // Nor the standing note about helpers, which there are none of; the question note still goes.
      expect(c.thread().developerInstructions).toBe(CODEX_QUESTION_NOTE);
      expect(c.thread().developerInstructions).not.toContain("Helper agents");
      // Still the person's own server, still compacting at three quarters of what it holds.
      expect(config.model_provider).toBe("crosstalk_ep1");
      expect(config.model_auto_compact_token_limit).toBe(12_288);
    } finally {
      await c.d.dispose();
    }
  });

  test("a big-window model of your own keeps them, and Codex is never even asked what it has", async () => {
    const c = chat({ window: 131_072 });
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const config = c.config();
      expect(config.features).toEqual({ default_mode_request_user_input: true, multi_agent_v2: { expose_spawn_agent_model_overrides: false } });
      expect(config.include_apps_instructions).toBeUndefined();
      expect(config.plugins).toBeUndefined();
      expect(config.mcp_servers.node_repl).toBeUndefined();
      expect(Object.keys(config.mcp_servers)).toEqual(["crosstalk"]);
      expect(Object.keys(config.agents).sort()).toEqual(["awaiter", "default", "explorer", "worker"]);
      expect(config.mcp_servers.crosstalk.env.CROSSTALK_HELPER_MODEL).toBe("1");
      expect(c.thread().developerInstructions).toContain(helperNote("codex", null, true));
      expect(c.asked()).not.toContain("config/read");
    } finally {
      await c.d.dispose();
    }
  });

  test("the chat's own setting keeps the person's plugins on a small model, and leaves them out on a big one", async () => {
    const keep = chat({ config: { codexPlugins: true } });
    try {
      expect((await turn(keep.d, "hello", sink().sink)).ok).toBe(true);
      expect(keep.config().features.apps).toBeUndefined();
      expect(keep.config().plugins).toBeUndefined();
      expect(Object.keys(keep.config().agents).sort()).toEqual(["awaiter", "default", "explorer", "worker"]);
    } finally {
      await keep.d.dispose();
    }
    const out = chat({ window: 272_000, config: { codexPlugins: false } });
    try {
      expect((await turn(out.d, "hello", sink().sink)).ok).toBe(true);
      expect(out.config().features.apps).toBe(false);
      expect(out.config().plugins).toEqual({ "codex-app-tools@openai-bundled": { enabled: false }, "browser@openai-bundled": { enabled: false } });
    } finally {
      await out.d.dispose();
    }
  });

  test("a Codex that can't say which plugins it has still leaves out the connectors and the helper tools", async () => {
    const c = chat({ env: { FAKE_CODEX_NO_CONFIG_READ: "1" } });
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const config = c.config();
      // The keys that need no names: these alone take the 333 connectors and the 10 KB helper tool out.
      expect(config.features).toEqual({ default_mode_request_user_input: true, apps: false, goals: false });
      expect(config.agents).toEqual({ enabled: false });
      expect(config.include_apps_instructions).toBe(false);
      // Nothing is guessed: no plugin ids, and no server of theirs named.
      expect(config.plugins).toBeUndefined();
      expect(Object.keys(config.mcp_servers)).toEqual(["crosstalk"]);
    } finally {
      await c.d.dispose();
    }
  });

  test("a Codex older than these settings never gets them", async () => {
    expect([takesLeanTools("0.159.9"), takesLeanTools("0.145.0"), takesLeanTools("0.160.0"), takesLeanTools("0.160.1"), takesLeanTools("1.0.0"), takesLeanTools(null)]).toEqual([false, false, true, true, true, null]);
    const c = chat({ env: { FAKE_CODEX_VERSION: "0.159.9" } });
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const config = c.config();
      expect(config.features).toEqual({ default_mode_request_user_input: true, multi_agent_v2: { expose_spawn_agent_model_overrides: false } });
      expect(config.plugins).toBeUndefined();
      expect(config.include_apps_instructions).toBeUndefined();
      expect(Object.keys(config.mcp_servers)).toEqual(["crosstalk"]);
      expect(c.asked()).not.toContain("config/read");
      // The adapter still leaves what doesn't fit out of each request: the chat is slower, not broken.
      expect(Object.keys(config.agents).sort()).toEqual(["awaiter", "default", "explorer", "worker"]);
    } finally {
      await c.d.dispose();
    }
  });

  test("a Codex that doesn't say its version and refuses them is asked again as an ordinary chat, on the same thread, helpers still pinned", async () => {
    const c = chat({ session: { threadId: "th-kept" }, env: { FAKE_CODEX_OLD_CONFIG: "0.144" } });
    const ROLES = ["awaiter", "default", "explorer", "worker"];
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      // This Codex is old enough to refuse the helper settings too, so it gives up one group per try: lean, then those.
      const [first, again, third, ...rest] = c.opened();
      expect(rest).toEqual([]);
      // The same thread every time: a refusal never loses the conversation.
      expect(c.opened().map((x) => [x.method, x.params.threadId])).toEqual([["thread/resume", "th-kept"], ["thread/resume", "th-kept"], ["thread/resume", "th-kept"]]);
      expect(first.params.config.agents).toEqual({ enabled: false });
      expect(first.params.config.features.apps).toBe(false);
      // Given up means given up, not subtracted: the thread asked for next is an **ordinary** one. Deleting
      // `agents.enabled` would have left no `agents` at all, which is Codex's own default -- helpers on, no roles pinning
      // the model, the spawn tool's model and effort on offer -- and the chat would have lost the model lock in silence.
      expect(again.params.config.agents).toBeDefined();
      expect(Object.keys(again.params.config.agents).sort()).toEqual(ROLES);
      expect(again.params.config.features.multi_agent_v2).toEqual({ expose_spawn_agent_model_overrides: false });
      expect(again.params.developerInstructions).toContain(helperNote("codex", null, true));
      expect(again.params.config.mcp_servers.crosstalk.env.CROSSTALK_HELPER_MODEL).toBe("1");
      // And none of the lean settings are back with it.
      expect(again.params.config.features.apps).toBeUndefined();
      expect(again.params.config.plugins).toBeUndefined();
      expect(again.params.config.include_apps_instructions).toBeUndefined();
      expect(Object.keys(again.params.config.mcp_servers)).toEqual(["crosstalk"]);
      expect(again.params.config.model_provider).toBe("crosstalk_ep1");
      // The third try gives up the helper settings its Codex also refuses -- and the roles, which hold a helper to this
      // chat's model and effort whatever Codex's own defaults say, stay.
      expect(third.params.config.features).toEqual({ default_mode_request_user_input: true });
      expect(Object.keys(third.params.config.agents).sort()).toEqual(ROLES);
      expect(third.params.developerInstructions).toContain(helperNote("codex", null, true));
      // Left out from then on: a restarted app-server is asked once, as an ordinary chat without the helper settings.
      await (c.d as unknown as { rpc: { kill(): Promise<void> } }).rpc.kill();
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const [, , , fourth, ...more] = c.opened();
      expect(more).toEqual([]);
      expect(fourth.params.config.features).toEqual({ default_mode_request_user_input: true });
      expect(fourth.params.config.plugins).toBeUndefined();
      expect(Object.keys(fourth.params.config.agents).sort()).toEqual(ROLES);
    } finally {
      await c.d.dispose();
    }
  });

  test("a refusal in words no Codex is known to use still answers: the lean settings are given up anyway", async () => {
    const c = chat({ env: { FAKE_CODEX_ODD_REFUSAL: "1" } });
    try {
      // The settings only take tools away, and the adapter leaves what doesn't fit out of each request regardless, so
      // nothing about giving them up may depend on matching Codex's wording -- a reworded refusal would otherwise stop
      // every chat on a small model of your own from starting at all, on every turn.
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const [first, again, ...rest] = c.opened();
      expect(rest).toEqual([]);
      expect(first.params.config.features.apps).toBe(false);
      expect(again.params.config.features.apps).toBeUndefined();
      expect(again.params.config.plugins).toBeUndefined();
      expect(Object.keys(again.params.config.mcp_servers)).toEqual(["crosstalk"]);
      // An ordinary chat, so the helper roles are back with it.
      expect(Object.keys(again.params.config.agents).sort()).toEqual(["awaiter", "default", "explorer", "worker"]);
      expect(again.params.developerInstructions).toContain(helperNote("codex", null, true));
    } finally {
      await c.d.dispose();
    }
  });

  test("a refusal that says the thread is gone is not read as a refusal of the settings", async () => {
    // It costs a second copy of the prompt and would mark the settings unusable for the rest of the chat, while the
    // resume path already knows what to do with a thread Codex can't find: start a new one.
    const c = chat({ session: { threadId: "th-gone" }, env: { FAKE_CODEX_RESUME_ERROR: "thread not found: th-gone" } });
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const opened = c.opened();
      expect(opened.map((x) => x.method)).toEqual(["thread/resume", "thread/start"]);
      // Still lean on the new thread: nothing was given up.
      expect(opened[1].params.config.features.apps).toBe(false);
      expect(opened[1].params.config.agents).toEqual({ enabled: false });
    } finally {
      await c.d.dispose();
    }
  });

  test("a setting Codex ignored is logged by name, not as an escaped JSON dump", async () => {
    // A Codex update that renames one of these settings shows up here and nowhere else: the chat would quietly have the whole
    // catalogue back and the only other sign would be a slow chat. So the names have to reach the log, which means reading the
    // fields `configWarning` actually has (codex-protocol/v2/ConfigWarningNotification: a summary and the details).
    expect(threadWarning("configWarning", { summary: "Ignored unknown configuration keys.", details: "features.apps, include_apps_instructions", path: "/x", range: null })).toBe(
      "Codex ignored settings Crosstalk sent: Ignored unknown configuration keys. features.apps, include_apps_instructions",
    );
    // A plain thread warning has a message of its own (WarningNotification), and both are read.
    expect(threadWarning("warning", { threadId: "th-1", message: "no model metadata for this model" })).toBe("Codex warned about this chat: no model metadata for this model");
    // Anything else is dumped whole rather than lost, and a list of keys isn't cut off the end.
    expect(threadWarning("configWarning", { odd: 1 })).toBe('Codex ignored settings Crosstalk sent: {"odd":1}');
    expect(threadWarning("item/completed", { item: {} })).toBeNull();
    const many = Array.from({ length: 60 }, (_, i) => `mcp_servers.server_${i}.enabled`).join(", ");
    expect(threadWarning("configWarning", { summary: "Ignored unknown configuration keys.", details: many })).toContain("mcp_servers.server_59.enabled");

    // And through the real driver, from a real notification.
    const c = chat({ env: { FAKE_CODEX_CONFIG_WARNING: "`features.apps` was renamed to `features.connectors`" } });
    const said: string[] = [];
    const was = console.error;
    console.error = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
    } finally {
      console.error = was;
      await c.d.dispose();
    }
    expect(said.join("\n")).toContain("Codex ignored settings Crosstalk sent: Ignored unknown configuration keys. `features.apps` was renamed to `features.connectors`");
  });

  test("a duplicated lean chat is forked lean too (start, resume and fork all go the same way)", async () => {
    const c = chat({ session: { forkFrom: "th-old" } });
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      const [forked, ...rest] = c.opened();
      expect([forked.method, rest.length]).toEqual(["thread/fork", 0]);
      expect(forked.params.threadId).toBe("th-old");
      expect(forked.params.config.features).toEqual({ default_mode_request_user_input: true, apps: false, goals: false });
      expect(forked.params.config.agents).toEqual({ enabled: false });
      expect(forked.params.config.plugins).toEqual({ "codex-app-tools@openai-bundled": { enabled: false }, "browser@openai-bundled": { enabled: false } });
      expect(forked.params.config.mcp_servers.node_repl).toEqual({ enabled: false });
      expect(forked.params.config.mcp_servers.crosstalk).toMatchObject({ tool_timeout_sec: 900 });
      expect(forked.params.config.mcp_servers["crosstalk-setup"]).toBeUndefined();
    } finally {
      await c.d.dispose();
    }
  });

  /**
   * A stand-in for the Codex app's shared server (a daemon in the chat's Codex home): it keeps a thread it has loaded as
   * it was set up, whatever a resume's config says, so a lean chat must not join it.
   */
  function codexAppServer(codexHome: string, version = "0.160.0") {
    mkdirSync(join(codexHome, "app-server-control"), { recursive: true });
    const calls: string[] = [];
    const seen: { config: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let n = 0;
    const server = Bun.serve({
      unix: join(codexHome, "app-server-control", "app-server-control.sock"),
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const m = JSON.parse(String(raw));
          const send = (o: object) => void ws.send(JSON.stringify({ jsonrpc: "2.0", ...o }));
          if (m.method) calls.push(m.method);
          switch (m.method) {
            case "initialize":
              return send({ id: m.id, result: { userAgent: `crosstalk/${version} (Mac OS 27.0.1; arm64) unknown (crosstalk; 0.1.0)` } });
            case "thread/start":
              seen.push(m.params);
              return send({ id: m.id, result: { thread: { id: `th-app-${++n}` }, model: "qwen3.8-9b", reasoningEffort: null } });
            case "turn/start": {
              const threadId = m.params.threadId;
              const turnOf = { id: `tu-app-${++n}` };
              send({ id: m.id, result: { turn: turnOf } });
              send({ method: "item/agentMessage/delta", params: { threadId, turnId: turnOf.id, itemId: "i1", delta: "Done." } });
              return send({ method: "turn/completed", params: { threadId, turn: { ...turnOf, status: "completed" } } });
            }
            default:
              if (m.method && m.id !== undefined) send({ id: m.id, result: {} });
          }
        },
      },
    });
    return { calls, get started() { return seen[0]; }, stop: () => server.stop(true) };
  }

  test("a lean chat goes on in a Codex app-server of its own, because the Codex app's server keeps a loaded thread as it was", async () => {
    // Under /tmp: a Unix socket's path has to be short.
    const home = mkdtempSync("/tmp/ct-lean-sock-");
    const app = codexAppServer(join(home, "codex-home"));
    const c = chat({ home });
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      // It is asked which Codex it is, and nothing else: no thread of this chat's ever goes there.
      expect(app.calls).toEqual(["initialize", "initialized"]);
      expect(c.config().features.apps).toBe(false);
    } finally {
      await c.d.dispose();
      app.stop();
    }
    // A chat that isn't lean still goes on in the Codex app's server, so it stays live in both places.
    const home2 = mkdtempSync("/tmp/ct-lean-sock-");
    const app2 = codexAppServer(join(home2, "codex-home"));
    const big = chat({ window: 131_072, home: home2 });
    try {
      expect((await turn(big.d, "hello", sink().sink)).ok).toBe(true);
      expect(app2.calls).toContain("thread/start");
    } finally {
      await big.d.dispose();
      app2.stop();
    }
  });

  test("a small-model chat whose Codex app server is too old to take the settings stays on it", async () => {
    // Leaving the shared server costs the chat being live in the Codex app, and an older Codex would keep the person's
    // whole catalogue on a thread of its own just the same: the isolation would buy nothing. The adapter still leaves
    // what doesn't fit out of each request.
    const home = mkdtempSync("/tmp/ct-lean-sock-");
    const app = codexAppServer(join(home, "codex-home"), "0.159.9");
    const c = chat({ home });
    try {
      expect((await turn(c.d, "hello", sink().sink)).ok).toBe(true);
      expect(app.calls).toContain("thread/start");
      // And not one of the lean settings was sent to it (the config it was started with, as that server got it).
      expect(app.started?.config.features).toEqual({ default_mode_request_user_input: true, multi_agent_v2: { expose_spawn_agent_model_overrides: false } });
      expect(app.started?.config.plugins).toBeUndefined();
      expect(app.started?.config.include_apps_instructions).toBeUndefined();
      expect(Object.keys(app.started?.config.mcp_servers ?? {})).toEqual(["crosstalk"]);
    } finally {
      await c.d.dispose();
      app.stop();
    }
  });
});
