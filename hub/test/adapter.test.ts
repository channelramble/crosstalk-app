// The chat adapter (docs/SPEC-0.4.md, T6): Codex's Responses requests become Chat Completions requests, and the Chat stream comes
// back as Responses events. Pure mapping first (table by table, event by event), then the real server against a fake Chat-only
// server on a loopback port. Nothing here reaches the network beyond 127.0.0.1, and no model is ever asked anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PROMPT_FLOOR, smallWindowWords } from "@crosstalk/shared";
import { App } from "../src/app";
import { autoCompactLimit } from "../src/agents/driver";
import { ChatAdapter } from "../src/adapter";
import { BadRequest, NO_RETRY, StreamMapper, UpstreamError, fitToWindow, flatName, groupLabel, requestSize, sseData, textTokens, toChatRequest, tokensOf, type ToolRoutes } from "../src/adapter/translate";
import { KV_COST, measure, noteToolCost, readToolCosts } from "../src/adapter/cost";
import { fakeChatServer } from "./fixtures/fake-chat-server";

type Ev = Record<string, any>;
const KEY = "sk-real-upstream-key-1234";
const GEMINI_PATH = "/v1beta/openai/chat/completions";

// ---- A request shaped like the ones Codex 0.160 sends (field shapes from design/research-api-compat.md section 2) ----

const INSTRUCTIONS = "You are Codex, a coding agent running in the Codex CLI on the user's computer.";
const PERMISSIONS = "<permissions instructions>\nSandbox: workspace-write\n</permissions instructions>";
const AGENTS = "# AGENTS.md instructions for /work\n\nBe brief.";
const ENV = "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>";
const PATCH = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
const SHELL_PARAMS = { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"], additionalProperties: false };
const LOOKUP_PARAMS = { type: "object", properties: { q: { type: "string" } } };
const patchTool = {
  type: "custom",
  name: "apply_patch",
  description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  format: { type: "grammar", syntax: "lark", definition: "start: begin_patch hunk+ end_patch" },
};

function codexRequest(over: Ev = {}): Ev {
  return {
    model: "qwen3.8-27b",
    instructions: INSTRUCTIONS,
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: PERMISSIONS }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: AGENTS }, { type: "input_text", text: ENV }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "List the files and fix the typo." }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "I should look first." }], encrypted_content: null },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me look." }] },
      { type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: "call_1" },
      { type: "function_call", name: "lookup", namespace: "mcp__docs__", arguments: '{"q":"typo"}', call_id: "call_2" },
      { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" },
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "found it" }] },
      { type: "custom_tool_call", call_id: "call_3", name: "apply_patch", input: PATCH },
      { type: "custom_tool_call_output", call_id: "call_3", output: "Done!" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks. Now run the tests." }] },
    ],
    tools: [
      { type: "function", name: "shell", description: "Runs a shell command", strict: false, parameters: SHELL_PARAMS },
      patchTool,
      { type: "namespace", name: "mcp__docs__", description: "The docs server", tools: [{ type: "function", name: "lookup", description: "Search the docs", strict: false, parameters: LOOKUP_PARAMS }] },
      { type: "web_search", external_web_access: true },
      { type: "tool_search", execution: "client", description: "Search for more tools", parameters: { type: "object", properties: {} } },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    service_tier: "priority",
    prompt_cache_key: "thread-1",
    text: { verbosity: "low" },
    client_metadata: { "x-codex-installation-id": "abc" },
    max_output_tokens: 4096,
    ...over,
  };
}

// ---- A first message the size of a real one, with the tool catalogue Codex attaches to it ----
//
// The sizes are measured, not invented: on this Mac a first "hi!" to a custom-model account carries a 24,759-character system
// message (Codex's own instructions and its <permissions instructions>), a 2,664-character user message (its
// <environment_context>, Crosstalk's note and the message), and 361 tools whose schemas are 532,259 characters. The model's own
// tokenizer (llama.cpp /apply-template then /tokenize) put the whole request at 139,930 tokens — 8.5x a 16,384-token window — and
// each group below is the size the real one is, group by group (CATALOGUE; "the fixture is the real catalogue's shape" checks it),
// so a test about which servers go is a test about the real request. The real body itself is not checked in: it carries the
// person's own system prompt, their <environment_context> and the name of every app they have connected.

const pad = (seed: string, to: number): string => seed.repeat(Math.ceil(to / seed.length)).slice(0, to);
const SYSTEM_FIRST = pad(`${INSTRUCTIONS} ${PERMISSIONS} `, 24_759);
const USER_FIRST = pad(`${ENV} <crosstalk>You are in a Crosstalk chat.</crosstalk> hi! `, 2_664);
const schema = (bytes: number) => ({ type: "object", properties: { id: { type: "string", description: pad("Which one to act on, by id, as the app lists them. ", Math.max(1, bytes)) } }, required: ["id"] });

/**
 * The real catalogue, group by group: how many tools, and how many tokens of schemas each group is (the mapped JSON at four
 * characters a token, which is what the tokenizer agreed with to within 13%). The names are the real ones.
 */
const CATALOGUE = {
  /** Codex's own tools, which can never be left out. */
  core: { names: ["exec_command", "write_stdin", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "request_user_input", "list_available_plugins_to_install", "request_plugin_install", "view_image", "get_goal", "create_goal", "update_goal"], tokens: 2_750 },
  /** Its helper-agent tools: the first group to go. */
  multiAgent: { names: ["close_agent", "resume_agent", "send_input", "spawn_agent", "wait_agent"], tokens: 2_700 },
  /** Crosstalk's own server, which can never be left out either. */
  crosstalk: { names: ["hub_log", "pair_code", "recheck_agents", "setup_guide", "setup_status", "test_ai_service"], tokens: 652 },
  /** The person's own plugin servers. */
  plugins: [
    { server: "mcp__node_repl__", names: ["js", "js_add_node_module_dir", "js_reset"], tokens: 455 },
    { server: "mcp__cua_repl__", names: ["js", "js_reset"], tokens: 1_015 },
  ],
  /** Their ChatGPT-app connectors, one app at a time, biggest first: 333 tools and 125,582 tokens, 95% of the request. */
  apps: [
    ["media", 70, 38_236],
    ["shared_spaces", 38, 20_950],
    ["github", 89, 19_213],
    ["google_drive", 45, 17_123],
    ["sites", 25, 9_960],
    ["gmail", 21, 8_084],
    ["google_calendar", 15, 4_472],
    ["plugin_management", 6, 2_563],
    ["news", 11, 1_856],
    ["codex_document_control", 3, 943],
    ["safety_settings", 5, 841],
    ["search_service", 1, 838],
    ["google_contacts", 3, 387],
    ["support", 1, 111],
  ] as [string, number, number][],
};

/** `count` tools called `name(i)`, whose schemas come to about `tokens` tokens between them (220 characters of JSON apiece). */
const toolsWorth = (name: (i: number) => string, count: number, tokens: number): Ev[] =>
  Array.from({ length: count }, (_, i) => ({ type: "function", name: name(i), description: "One of this server's tools", parameters: schema(Math.max(20, Math.round((tokens * 4) / count) - 220)) }));

const named = (names: string[], tokens: number): Ev[] => toolsWorth((i) => names[i]!, names.length, tokens);

/** Codex's own tools and its helper-agent ones, with Crosstalk's server, the way Codex hands them over (a namespace per server). */
const ownTools = (): Ev[] => [
  ...named(CATALOGUE.core.names, CATALOGUE.core.tokens),
  { type: "namespace", name: "multi_agent_v1", tools: named(CATALOGUE.multiAgent.names, CATALOGUE.multiAgent.tokens) },
  { type: "namespace", name: "mcp__crosstalk_setup__", tools: named(CATALOGUE.crosstalk.names, CATALOGUE.crosstalk.tokens) },
];

/** The person's own: their two plugin servers always, and the first `apps` of their ChatGPT-app connectors (14 is all of them). */
const appTools = (apps: number): Ev[] => [
  ...(apps ? [{ type: "namespace", name: "mcp__codex_apps__", tools: CATALOGUE.apps.slice(0, apps).flatMap(([app, count, tokens]) => toolsWorth((i) => `${app}___tool_${i}`, count, tokens)) }] : []),
  ...CATALOGUE.plugins.map((p) => ({ type: "namespace", name: p.server, tools: named(p.names, p.tokens) })),
];

/** A first message in a chat on a model server of your own, with `apps` of the person's connector apps attached to it. */
const firstMessage = (apps: number, over: Ev = {}): Ev => ({
  model: "qwen3.8-9b",
  instructions: SYSTEM_FIRST,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: USER_FIRST }] }],
  tools: [...ownTools(), ...appTools(apps)],
  tool_choice: "auto",
  stream: true,
  ...over,
});

/** Every connector app there is, as the real request has them. */
const ALL_APPS = CATALOGUE.apps.length;

const toolNames = (chat: Record<string, unknown>): string[] => (Array.isArray(chat.tools) ? chat.tools.map((t) => (t as Ev).function.name as string) : []);

describe("request mapping (Responses -> Chat Completions)", () => {
  test("messages: instructions, developer, user, assistant, reasoning, calls and results", () => {
    const { chat } = toChatRequest(codexRequest());
    expect(chat.messages).toEqual([
      // instructions and the developer message are both system; neighbours with the same role are one message
      { role: "system", content: `${INSTRUCTIONS}\n\n${PERMISSIONS}` },
      {
        role: "user",
        content: [
          { type: "text", text: `${AGENTS}\n${ENV}` },
          { type: "text", text: "List the files and fix the typo." },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      // the reasoning item rides on the assistant message after it; the two calls join that message
      {
        role: "assistant",
        content: "Let me look.",
        reasoning_content: "I should look first.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":["ls"]}' } },
          { id: "call_2", type: "function", function: { name: "mcp__docs__lookup", arguments: '{"q":"typo"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" },
      { role: "tool", tool_call_id: "call_2", content: "found it" },
      // a freeform call and its result: the input travels as one string argument
      { role: "assistant", content: null, tool_calls: [{ id: "call_3", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) } }] },
      { role: "tool", tool_call_id: "call_3", content: "Done!" },
      { role: "user", content: "Thanks. Now run the tests." },
    ]);
  });

  test("tools: functions kept, namespaces flattened, freeform tools wrapped, web search and tool search dropped", () => {
    const { chat, routes } = toChatRequest(codexRequest());
    expect(chat.tools).toEqual([
      { type: "function", function: { name: "shell", description: "Runs a shell command", parameters: SHELL_PARAMS } },
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: `${patchTool.description} Give the whole input as the "input" argument.`,
          parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
        },
      },
      { type: "function", function: { name: "mcp__docs__lookup", description: "Search the docs", parameters: LOOKUP_PARAMS } },
    ]);
    // how a call coming back is put the way Codex declared the tool
    expect([...routes]).toEqual([
      ["shell", { name: "shell" }],
      ["apply_patch", { name: "apply_patch", custom: true }],
      ["mcp__docs__lookup", { name: "lookup", namespace: "mcp__docs__" }],
    ]);
  });

  test("fields: renamed, passed on, added and dropped", () => {
    const { chat } = toChatRequest(codexRequest());
    expect(chat).toMatchObject({ model: "qwen3.8-27b", reasoning_effort: "high", max_tokens: 4096, parallel_tool_calls: true, tool_choice: "auto", stream: true, stream_options: { include_usage: true } });
    // nothing else gets through: not store, include, prompt_cache_key, text, service_tier, client_metadata, instructions, input, reasoning
    expect(Object.keys(chat).sort()).toEqual(["max_tokens", "messages", "model", "parallel_tool_calls", "reasoning_effort", "stream", "stream_options", "tool_choice", "tools"]);
  });

  test("newer Codex sends no instructions, only a developer message; a plain string input works too", () => {
    const newer = toChatRequest({ model: "m", input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Rules." }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }] });
    expect(newer.chat.messages).toEqual([{ role: "system", content: "Rules." }, { role: "user", content: "Hi" }]);
    // no tools: no tool_choice or parallel_tool_calls either (servers refuse them alone)
    const plain = toChatRequest({ model: "m", input: "Hello", tool_choice: "auto", parallel_tool_calls: true, tools: [{ type: "web_search" }] });
    expect(plain.chat.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(Object.keys(plain.chat).sort()).toEqual(["messages", "model", "stream", "stream_options"]);
    const forced = toChatRequest({ model: "m", input: "x", tools: [{ type: "function", name: "shell" }], tool_choice: { type: "function", name: "shell" } });
    expect(forced.chat.tool_choice).toEqual({ type: "function", function: { name: "shell" } });
    expect((forced.chat.tools as Ev[])[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  test("the newest Codex model families: no instructions, tools in an additional_tools input item (shape seen from Codex 0.160)", () => {
    const { chat, routes } = toChatRequest({
      model: "m",
      input: [
        { type: "additional_tools", id: "at_1", role: "developer", tools: [
          { type: "namespace", name: "functions", description: "", tools: [
            { type: "custom", name: "exec", description: "Run JavaScript code", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
            { type: "function", name: "wait", description: "Waits on a cell", strict: false, parameters: { type: "object", properties: { cell_id: { type: "string" } }, required: ["cell_id"] } },
          ] },
        ] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Create hello.txt." }] },
        { type: "custom_tool_call", call_id: "c1", name: "exec", namespace: "functions", input: "text('hi')" },
        { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "low", context: "all_turns" },
      text: { verbosity: "low" },
    });
    expect((chat.tools as Ev[]).map((t) => t.function.name)).toEqual(["functions__exec", "functions__wait"]);
    expect([...routes]).toEqual([["functions__exec", { name: "exec", namespace: "functions", custom: true }], ["functions__wait", { name: "wait", namespace: "functions" }]]);
    expect(chat).toMatchObject({ reasoning_effort: "low", parallel_tool_calls: false, tool_choice: "auto" });
    expect(chat.messages).toEqual([
      { role: "system", content: "You are Codex.\n\n<skills_instructions>" },
      { role: "user", content: "Create hello.txt." },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "functions__exec", arguments: JSON.stringify({ input: "text('hi')" }) } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
  });

  test("odd shapes: summary-only reasoning, tool images, a later developer message, loose items", () => {
    const { chat } = toChatRequest({
      model: "m",
      input: [
        { role: "user", content: "one" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking it over." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Mode changed." }] },
        { type: "web_search_call", status: "completed" },
        { type: "compaction", encrypted_content: "x" },
        { type: "function_call", name: "view", arguments: "", call_id: "c9" },
        { type: "function_call_output", call_id: "c9", output: [{ type: "input_image", image_url: "data:image/png;base64,BB" }] },
        { type: "reasoning", content: [{ type: "reasoning_text", text: "dropped: nothing follows from the assistant" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "three" }] },
      ],
    });
    const messages = chat.messages as Ev[];
    // two user messages in a row are one; a developer message after the answer is a system message in place (the call after it
    // is a message of its own); the stray reasoning at the end is dropped, and so are items a Chat server has no use for
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "assistant", "tool", "user"]);
    expect(messages[0].content).toBe("one\n\ntwo");
    expect(messages[1]).toEqual({ role: "assistant", content: "ok", reasoning_content: "Thinking it over." });
    expect(messages[3].tool_calls[0].function.arguments).toBe("{}");
    expect(messages[4].content).toContain("can't see images");
    expect(messages[5]).toEqual({ role: "user", content: "three" });
  });

  test("previous_response_id is refused, and so is a body that isn't an object", () => {
    expect(() => toChatRequest(codexRequest({ previous_response_id: "resp_1" }))).toThrow(BadRequest);
    try {
      toChatRequest(codexRequest({ previous_response_id: "resp_1" }));
    } catch (e) {
      expect((e as BadRequest).param).toBe("previous_response_id");
    }
    expect(() => toChatRequest(codexRequest({ previous_response_id: null }))).not.toThrow();
    expect(() => toChatRequest("nope")).toThrow(BadRequest);
  });

  test("tool names the Chat API accepts: namespaces folded in, odd characters and long names made safe", () => {
    expect(flatName(undefined, "shell")).toBe("shell");
    expect(flatName("docs", "search")).toBe("docs__search");
    expect(flatName("mcp__github__", "create_issue")).toBe("mcp__github__create_issue");
    expect(flatName(undefined, "my.tool name")).toBe("my_tool_name");
    const long = flatName("mcp__a_very_long_server_name__", "x".repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(flatName("mcp__a_very_long_server_name__", "x".repeat(80))).toBe(long);
    expect(flatName("mcp__a_very_long_server_name__", `${"x".repeat(79)}y`)).not.toBe(long);
  });
});

// ---- How big the request is, and what goes when the model can't hold it ----

describe("fitting a request to what the model holds", () => {
  const WINDOW = 16_384; // this Mac's own llama.cpp runs Qwen 3 with -c 16384
  /** The size the hub itself asks Codex to summarise the conversation at on an account like this (driver.ts): 12,288 here. */
  const COMPACT = autoCompactLimit(undefined, { contextWindow: WINDOW })!;
  const CORE = [...CATALOGUE.core.names, ...CATALOGUE.crosstalk.names.map((n) => `mcp__crosstalk_setup__${n}`)];
  const appsOf = (chat: Record<string, unknown>): string[] => [...new Set(toolNames(chat).filter((n) => n.startsWith("mcp__codex_apps__")).map((n) => n.slice("mcp__codex_apps__".length).split("___")[0]!))];
  const fit = (apps: number, window = WINDOW, over: Ev = {}) => {
    const { chat } = toChatRequest(firstMessage(apps, over));
    return { chat, t: fitToWindow(chat, window, autoCompactLimit(undefined, { contextWindow: window })) };
  };

  test("the fixture is the real catalogue's shape, group by group", () => {
    const { chat } = toChatRequest(firstMessage(ALL_APPS));
    const size = requestSize(chat);
    expect([size.toolCount, Math.round(size.tools / 1000)]).toEqual([361, 134]); // the real request: 361 tools, 133,065 tokens of schemas
    const tokens = (prefix: string) => (chat.tools as Ev[]).filter((t) => t.function.name.startsWith(prefix)).reduce((n, t) => n + tokensOf(t), 0);
    // Every group within a twentieth of what the model's own tokenizer counted for the real one, so what goes here is what goes there.
    for (const [app, count, want] of CATALOGUE.apps) {
      expect(toolNames(chat).filter((n) => n.startsWith(`mcp__codex_apps__${app}___`))).toHaveLength(count);
      expect(tokens(`mcp__codex_apps__${app}___`) / want).toBeCloseTo(1, 1);
    }
    expect(tokens("multi_agent_v1__") / CATALOGUE.multiAgent.tokens).toBeCloseTo(1, 1);
    expect(tokens("mcp__crosstalk_setup__") / CATALOGUE.crosstalk.tokens).toBeCloseTo(1, 1);
  });

  test("a first message fits a 16k model, with room to answer and under the size the hub asks Codex to compact at", () => {
    const { chat, t } = fit(0);
    expect(t.before.toolCount).toBe(28);
    expect(t.before.total).toBeGreaterThan(t.before.messages + t.before.tools); // plus the handful of tokens the other fields are
    expect(t.over).toBe(false);
    expect(t.size.total).toBeLessThanOrEqual(WINDOW - t.room);
    // The fault the compaction limit caused: a request over it is summarised the moment it arrives, every turn, and what
    // compaction can shrink (the conversation) is a twentieth of it. So what is sent stays under that figure too.
    expect(t.aim).toBe(COMPACT);
    expect(t.size.total).toBeLessThanOrEqual(COMPACT);
    expect(toolNames(chat)).toEqual(expect.arrayContaining(CORE));
  });

  test("what is always sent is inside the floor the model picker promises", () => {
    // With every group that may go gone, what is left is Codex's own instructions and the tools it can't work without. The note
    // where a model is picked promises this much room (shared CODEX_PROMPT_FLOOR), so it must stay true: a tool or a note added
    // to either of those has to fit inside it.
    const { chat, t } = fit(ALL_APPS, 4_096);
    expect(t.size.toolCount).toBe(CATALOGUE.core.names.length + CATALOGUE.crosstalk.names.length);
    expect(t.size.total).toBeLessThan(CODEX_PROMPT_FLOOR);
    expect(toolNames(chat).sort()).toEqual([...CORE].sort());
    // And a model at the floor can be sent that much: it is refused only below it.
    expect(fit(ALL_APPS, CODEX_PROMPT_FLOOR).t.over).toBe(false);
    expect(t.over).toBe(true);
  });

  test("the helper-agent tools go before anything the person set up, and the person's servers go smallest-first", () => {
    const { chat, t } = fit(0);
    // 15,006 tokens into 12,288: the 2,696 of helper tools (which one small local model can't use anyway) nearly do it, and the
    // 453-token server makes up the rest — not the 1,010-token one, and not the person's servers before Codex's helper tools.
    expect(t.droppedGroups).toEqual(["helper agents", "mcp__node_repl__"]);
    expect(toolNames(chat).some((n) => n.startsWith("multi_agent"))).toBe(false);
    expect(toolNames(chat)).toContain("mcp__cua_repl__js");
  });

  test("the person's connectors are 95% of a real request: whole apps go, and the agent keeps what it works with", () => {
    const { chat, t } = fit(ALL_APPS);
    expect(t.before.total).toBeGreaterThan(8 * WINDOW); // the fault: a first "hi!" 8.5x over the window on this Mac
    expect(t.over).toBe(false);
    expect(t.size.total).toBeLessThanOrEqual(COMPACT);
    expect(t.droppedGroups[0]).toBe("helper agents"); // before any of the person's own
    expect(t.dropped).toBe(338);
    // Whole apps, never half of one: each app left is all of its tools, and what went is named by app, not by tool.
    for (const app of appsOf(chat)) expect(toolNames(chat).filter((n) => n.startsWith(`mcp__codex_apps__${app}___`))).toHaveLength(CATALOGUE.apps.find(([a]) => a === app)![1]);
    expect(t.droppedGroups.map(groupLabel)).toEqual(["helper agents", "media", "shared_spaces", "github", "google_drive", "sites", "gmail", "google_calendar", "plugin_management", "news", "cua_repl", "codex_document_control", "safety_settings", "google_contacts"]);
    expect(appsOf(chat)).toEqual(["search_service", "support"]); // the two that still fit, whole
    expect(toolNames(chat)).toEqual(expect.arrayContaining(CORE));
    expect(toolNames(chat)).toContain("mcp__node_repl__js");
  });

  test("a model with room for most of the connectors keeps most of them, each app whole", () => {
    // One indivisible 125,000-token group would cost a big model every connector it has room for: apps go one at a time instead.
    const { chat, t } = fit(ALL_APPS, 131_072);
    expect(t.over).toBe(false);
    expect(t.size.toolCount).toBeGreaterThan(270);
    expect(t.droppedGroups.map(groupLabel)).toEqual(["helper agents", "media", "news"]);
    expect(appsOf(chat)).toContain("github");
    expect(appsOf(chat)).toContain("gmail");
    expect(appsOf(chat)).not.toContain("media"); // the biggest app: the one that had to go
  });

  test("a tool the request pins with tool_choice stays, whatever its server", () => {
    const { chat, t } = fit(ALL_APPS, WINDOW, { tool_choice: { type: "function", name: "github___tool_7", namespace: "mcp__codex_apps__" } });
    expect(t.over).toBe(false);
    expect(toolNames(chat)).toContain("mcp__codex_apps__github___tool_7");
    expect(toolNames(chat).filter((n) => n.startsWith("mcp__codex_apps__github___"))).toHaveLength(1);
    expect(chat.tool_choice).toEqual({ type: "function", function: { name: "mcp__codex_apps__github___tool_7" } });
  });

  test("a model too small for the agent's own tools keeps them and says it is over: there is nothing left to leave out", () => {
    const { chat, t } = fit(ALL_APPS, 4_096);
    expect(t.over).toBe(true);
    expect(t.size.tools).toBeGreaterThan(0); // the agent's own tools are still there: the caller refuses, it doesn't send a crippled request
    expect(toolNames(chat).some((n) => n.startsWith("multi_agent") || n.startsWith("mcp__codex_apps__"))).toBe(false);
    // Most of what is left is Codex's own system message, not anything the person said, which is what picks the words for it
    // (adapter/index.ts tooBigWords: a bigger model, not "start a new chat").
    expect(t.size.instructions).toBeGreaterThan(t.size.messages - t.size.instructions);
    expect(t.size.instructions).toBeGreaterThan(t.size.tools);
  });

  test("a request the estimate puts past the window is never sent, however much of it is the conversation", () => {
    // A chat that grew: every group that may go has gone, and the rest is still more than the model holds. Before, `over` only
    // tripped at 1.1x the window, so 17,000 tokens went to a 16,384 model to be refused there in the model's own words.
    const talk = (chars: number) => [{ type: "message", role: "user", content: [{ type: "input_text", text: pad("And then we looked at the other file together. ", chars) }] }];
    const grown = fit(ALL_APPS, WINDOW, { input: talk(40_000) });
    expect(grown.t.size.total).toBeGreaterThan(WINDOW);
    expect(grown.t.over).toBe(true);
    // A request that only eats into the room kept for the answer is still sent: the estimate is wrong in both directions, so the
    // server has the last word on a request that might just fit.
    const close = fit(ALL_APPS, WINDOW, { input: talk(24_000) });
    expect(close.t.size.total).toBeGreaterThan(WINDOW - close.t.room);
    expect(close.t.size.total).toBeLessThan(WINDOW);
    expect(close.t.over).toBe(false);
  });

  test("text is counted by what its characters are, not as if it were all English prose", () => {
    // The real counts beside each sample are this Mac's own llama.cpp (Qwen 3, /tokenize, nothing generated). Four characters a
    // token — what the tool schemas are measured at — is far too low for most of this, which is why text has its own count.
    const samples: [string, string, number][] = [
      ["prose", "The quick brown fox jumped over the lazy dog and then went home again. ".repeat(60), 901],
      ["a diff", '@@ -1,7 +1,9 @@\n-  const fit = fitToWindow(chat, window);\n+  const fit = fitToWindow(chat, Math.min(window, limit));\n   if (fit.over) return refuse(400, "invalid_prompt", words);\n'.repeat(25), 1_525],
      ["json a tool returned", '{"ok":true,"items":[{"id":"a1","name":"thing","count":12}],"next":null}\n'.repeat(55), 1_485],
      ["log lines", "2026-10-30T01:12:44.918Z [adapter] INFO Qwen here: left 335 of 361 tools out (mcp__codex_apps__: 126543 of ~140061 tokens)\n".repeat(32), 2_240],
      ["Chinese", "这是一个很长的中文句子，用来测试分词器的表现和估算的准确度。".repeat(60), 960],
      ["emoji", "🎉🚀✨🔥💡🙂👍🧩📦🛠️".repeat(120), 3_120],
    ];
    for (const [what, text, real] of samples) {
      const est = textTokens(text);
      const four = Math.ceil(text.length / 4); // what four characters a token made of it
      // Named in the failure, because which sample drifted is the whole point.
      expect({ what, low: est > real * 0.8, high: est < real * 1.45 }).toEqual({ what, low: true, high: true });
      if (real > four * 1.3) expect(est).toBeGreaterThan(four); // every sample four-a-token was low on reads higher now
    }
    // A hex dump and base64 are still counted low (0.7x and 0.5x: a page of base64 is nearly always a picture, which is counted as
    // a picture). That is why a refusal from the server carries the server's own count in its words (index.ts serverCounted) and
    // why the margin before Crosstalk refuses by itself is the whole room kept for the answer.
    expect(textTokens("00000000  7f 45 4c 46 02 01 01 00  |.ELF....|\n".repeat(80))).toBeGreaterThan(3_280 * 0.7);
    // Tool schemas keep the four-characters-a-token figure they were measured at: the whole catalogue within 1% of the real one.
    expect(tokensOf(toChatRequest(firstMessage(ALL_APPS)).chat.tools) / 133_065).toBeCloseTo(1, 1);
    expect(tokensOf(undefined)).toBe(0);
  });

  test("before the chat starts: a model with less room than the agent itself needs says so where it's picked", () => {
    // The note (shared smallWindowWords, shown by views/AgentOptions) and what the adapter can send at its smallest have to agree:
    // the floor measured above is under CODEX_PROMPT_FLOOR, so every window at or above the floor can hold a first message.
    const small = smallWindowWords("codex", "qwen3.8-9b", 8_192)!;
    expect(small).toContain("8,192");
    expect(small).toContain("12,000");
    expect(small).toContain("bigger context");
    expect(smallWindowWords("codex", "qwen3.8-9b", 16_384)).toBeNull();
    expect(smallWindowWords("codex", "qwen3.8-9b", null)).toBeNull(); // nothing is said about a window nobody told us
    expect(smallWindowWords("claude", "qwen3.8-9b", 8_192)).toBeNull(); // Claude Code talks to a server of your own directly
  });

  test("a picture counts as a picture, not as the megabyte of base64 it arrives as", () => {
    const photo = { type: "message", role: "user", content: [{ type: "input_text", text: "What is this?" }, { type: "input_image", image_url: `data:image/png;base64,${pad("iVBORw0KGgo", 1_400_000)}` }] };
    const { chat } = toChatRequest(firstMessage(0, { input: [photo] }));
    const size = requestSize(chat);
    expect(size.messages).toBeLessThan(8_000); // Codex's instructions plus about a thousand for the picture, not 350,000
    expect(fitToWindow(chat, WINDOW, COMPACT).over).toBe(false);
  });

  test("tools that aren't there cost nothing, and a model big enough gets every one of them", () => {
    const { chat } = toChatRequest(firstMessage(0, { tools: [] }));
    expect(requestSize(chat)).toMatchObject({ tools: 0, toolCount: 0 });
    expect(chat.tools).toBeUndefined();
    const big = toChatRequest(firstMessage(ALL_APPS)).chat;
    const names = toolNames(big);
    expect(fitToWindow(big, 1_000_000, 900_000).dropped).toBe(0); // a model that can hold it gets all of it
    expect(toolNames(big)).toEqual(names);
  });
});

// ---- The stream, event by event ----

const delta = (d: Ev, finish: string | null = null): Ev => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usageChunk: Ev = { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } } };
const fn = (index: number, f: Ev, id?: string): Ev => delta({ tool_calls: [{ index, ...(id ? { id, type: "function" } : {}), function: f }] });
const toolRoutes: ToolRoutes = new Map([
  ["shell", { name: "shell" }],
  ["mcp__docs__lookup", { name: "lookup", namespace: "mcp__docs__" }],
  ["apply_patch", { name: "apply_patch", custom: true }],
]);

function run(chunks: Ev[], routes: ToolRoutes = new Map(), sawDone = true) {
  const map = new StreamMapper(routes, "m", "Gemini");
  const events: Ev[] = [map.created(), ...chunks.flatMap((c) => map.chunk(c)), ...map.end(sawDone)];
  return { map, events, types: events.map((e) => e.type) };
}

describe("stream mapping (Chat Completions -> Responses events)", () => {
  test("text: created, the message opens, deltas, the message is done, completed with usage", () => {
    const { map, events, types } = run([delta({ role: "assistant", content: "" }), delta({ content: "Hel" }), delta({ content: "lo" }), delta({}, "stop"), usageChunk]);
    expect(types).toEqual(["response.created", "response.output_item.added", "response.output_text.delta", "response.output_text.delta", "response.output_item.done", "response.completed"]);
    const [created, added, d1, d2, done, completed] = events;
    expect(created.response).toMatchObject({ id: map.id, status: "in_progress" });
    expect(added).toMatchObject({ output_index: 0, item: { type: "message", role: "assistant", content: [] } });
    expect([d1.delta, d2.delta]).toEqual(["Hel", "lo"]);
    expect(d1).toMatchObject({ item_id: added.item.id, output_index: 0, content_index: 0 });
    expect(done).toMatchObject({ output_index: 0, item: { type: "message", id: added.item.id, role: "assistant", content: [{ type: "output_text", text: "Hello" }] } });
    expect(completed.response).toMatchObject({
      id: map.id,
      status: "completed",
      // the id and all three totals are what Codex needs; cached and reasoning tokens ride along for the cost tracking
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } },
    });
    expect(completed.response.output).toEqual([done.item]);
  });

  test("reasoning_content streams as reasoning text, then the answer opens its own item", () => {
    const { events, types } = run([delta({ reasoning_content: "Let me " }), delta({ reasoning_content: "think." }), delta({ content: "Done." }), delta({}, "stop")]);
    expect(types).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_text.delta",
      "response.reasoning_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[1]).toMatchObject({ output_index: 0, item: { type: "reasoning", summary: [] } });
    expect(events[2]).toMatchObject({ delta: "Let me ", content_index: 0, output_index: 0, item_id: events[1].item.id });
    expect(events[4]).toMatchObject({ output_index: 0, item: { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "Let me think." }] } });
    expect(events[5]).toMatchObject({ output_index: 1, item: { type: "message" } });
    expect(events.at(-1)?.response).not.toHaveProperty("usage"); // a server that sends none: Codex gets none
  });

  test("tool calls: arguments gathered by index from fragments, parallel calls kept, names put back as Codex declared them", () => {
    const { events, types } = run(
      [
        delta({ reasoning_content: "Two things." }),
        delta({ content: "Looking." }),
        fn(0, { name: "shell", arguments: "" }, "call_a"),
        fn(0, { arguments: '{"comm' }),
        fn(1, { name: "mcp__docs__lookup", arguments: '{"q":' }, "call_b"),
        fn(0, { arguments: 'and":["ls"]}' }),
        fn(1, { arguments: '"typo"}' }),
        fn(2, { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' }, "call_c"),
        delta({}, "tool_calls"),
        usageChunk,
      ],
      toolRoutes,
    );
    expect(types).toEqual([
      "response.created",
      ...["response.output_item.added", "response.reasoning_text.delta", "response.output_item.done"],
      ...["response.output_item.added", "response.output_text.delta", "response.output_item.done"],
      ...Array(3).fill(["response.output_item.added", "response.output_item.done"]).flat(),
      "response.completed",
    ]);
    const done = events.filter((e) => e.type === "response.output_item.done");
    expect(done.map((e) => e.output_index)).toEqual([0, 1, 2, 3, 4]);
    expect(done[2].item).toMatchObject({ type: "function_call", call_id: "call_a", name: "shell", arguments: '{"command":["ls"]}', status: "completed" });
    expect(done[2].item).not.toHaveProperty("namespace");
    expect(done[3].item).toMatchObject({ type: "function_call", call_id: "call_b", name: "lookup", namespace: "mcp__docs__", arguments: '{"q":"typo"}' });
    expect(done[4].item).toMatchObject({ type: "custom_tool_call", call_id: "call_c", name: "apply_patch", input: "*** Begin Patch" });
    const added = events.filter((e) => e.type === "response.output_item.added");
    expect(added[2].item).toMatchObject({ type: "function_call", call_id: "call_a", arguments: "" }); // opens empty, done carries it all
    expect(events.at(-1)?.response.output).toEqual(done.map((e) => e.item));
  });

  test("a freeform tool the model fills in as plain text (no JSON wrapper) is taken as written", () => {
    const { events } = run([fn(0, { name: "apply_patch", arguments: PATCH }, "call_c"), delta({}, "tool_calls")], toolRoutes);
    expect(events.find((e) => e.type === "response.output_item.done")?.item).toMatchObject({ type: "custom_tool_call", input: PATCH });
  });

  test("other servers' habits: a whole call in one chunk, no index, 'reasoning', an id-less call, a nameless call", () => {
    const whole = run([delta({ reasoning: "hmm" }), delta({ tool_calls: [{ id: "call_x", type: "function", function: { name: "shell", arguments: '{"command":["pwd"]}' } }] }, "stop")], toolRoutes);
    expect(whole.types).toContain("response.reasoning_text.delta");
    expect(whole.events.filter((e) => e.type === "response.output_item.done").at(-1)?.item).toMatchObject({ type: "function_call", call_id: "call_x", name: "shell", arguments: '{"command":["pwd"]}' });
    // no index, arguments in a second chunk without an id: the same call
    const loose = run([delta({ tool_calls: [{ id: "c1", function: { name: "shell", arguments: '{"command"' } }] }), delta({ tool_calls: [{ function: { arguments: ':["ls"]}' } }] }), delta({}, "tool_calls")], toolRoutes);
    expect(loose.events.filter((e) => e.type === "response.output_item.done")).toHaveLength(1);
    expect(loose.events.filter((e) => e.type === "response.output_item.done")[0].item.arguments).toBe('{"command":["ls"]}');
    // arguments sent as an object instead of a string
    const objectArgs = run([delta({ tool_calls: [{ index: 0, id: "c2", function: { name: "shell", arguments: { command: ["ls"] } } }] }, "tool_calls")], toolRoutes);
    expect(objectArgs.events.filter((e) => e.type === "response.output_item.done")[0].item.arguments).toBe('{"command":["ls"]}');
    // no id at all: Codex still gets one to answer to; a call with no name can't run and is left out
    const anon = run([fn(0, { name: "shell", arguments: "" }), fn(1, { arguments: "{}" }), delta({}, "tool_calls")], toolRoutes);
    const calls = anon.events.filter((e) => e.type === "response.output_item.done");
    expect(calls).toHaveLength(1);
    expect(calls[0].item.call_id).toMatch(/^call_/);
    expect(calls[0].item.arguments).toBe("{}");
  });

  test("the token limit and the content filter end as a plain failure Codex doesn't retry; what was written stays, a cut call is not run", () => {
    // (`response.incomplete` would make Codex 0.160 retry five times, resending the whole prompt each time: see StreamMapper.end)
    const cut = run([delta({ content: "Cut " }), delta({ content: "off" }), fn(0, { name: "shell", arguments: '{"comm' }, "call_a"), delta({}, "length"), usageChunk], toolRoutes);
    expect(cut.types).toEqual(["response.created", "response.output_item.added", "response.output_text.delta", "response.output_text.delta", "response.output_item.done", "response.failed"]);
    expect(cut.events.at(-1)?.response).toMatchObject({ status: "failed", error: { code: "invalid_prompt" } });
    expect(cut.events.at(-1)?.response.error.message).toBe("Gemini ran out of room for its answer and stopped part way. Ask for something shorter, or start a new chat, then try again.");
    const filtered = run([delta({ content: "I can't" }), delta({}, "content_filter")]);
    expect(filtered.types.at(-1)).toBe("response.failed");
    expect(filtered.events.at(-1)?.response).toMatchObject({ error: { code: "invalid_prompt", message: "Gemini's safety filter stopped this answer. Rephrase your message and try again." } });
    for (const r of [cut, filtered]) expect(r.types).not.toContain("response.completed");
  });

  test("Gemini numbers every call 0: whole calls in one chunk, with or without ids, are still separate calls", () => {
    const whole = (id: string, name: string, args: string) => ({ index: 0, ...(id ? { id, type: "function" } : {}), function: { name, arguments: args } });
    const withIds = run([delta({ tool_calls: [whole("call_1", "shell", '{"command":["ls"]}'), whole("call_2", "mcp__docs__lookup", '{"q":"a"}')] }, "stop")], toolRoutes);
    const noIds = run([delta({ tool_calls: [whole("", "shell", '{"command":["ls"]}')] }), delta({ tool_calls: [whole("", "mcp__docs__lookup", '{"q":"a"}')] }, "stop")], toolRoutes);
    for (const r of [withIds, noIds]) {
      const calls = r.events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
      expect(calls).toMatchObject([{ type: "function_call", name: "shell", arguments: '{"command":["ls"]}' }, { type: "function_call", name: "lookup", namespace: "mcp__docs__", arguments: '{"q":"a"}' }]);
    }
    // a name repeated on every fragment of one call is still one call
    const repeated = run([fn(0, { name: "shell", arguments: '{"comm' }, "call_1"), fn(0, { name: "shell", arguments: 'and":["ls"]}' }, "call_1"), delta({}, "tool_calls")], toolRoutes);
    expect(repeated.events.filter((e) => e.type === "response.output_item.done")).toHaveLength(1);
  });

  test("errors: an error chunk throws, a cut stream fails, a [DONE] with no finish reason still completes", () => {
    const map = new StreamMapper(new Map(), "m", "Gemini");
    expect(() => map.chunk({ error: { message: "The model is overloaded.", code: 503 } })).toThrow(UpstreamError);
    expect(() => map.chunk({ error: "plain words" })).toThrow("plain words");
    expect(() => map.chunk({ error: null, choices: [] })).not.toThrow();
    const cut = run([delta({ content: "Half" })], new Map(), false);
    expect(cut.types).toEqual(["response.created", "response.output_item.added", "response.output_text.delta", "response.failed"]);
    // `invalid_prompt`, not `server_error`: Codex 0.160 answers that by POSTing the identical request six more times (NO_RETRY).
    expect(cut.events.at(-1)?.response).toMatchObject({ id: cut.map.id, model: "m", status: "failed", error: { code: "invalid_prompt" } });
    expect(NO_RETRY).toContain(cut.events.at(-1)?.response.error.code);
    expect(cut.map.ended).toBe(true);
    expect(cut.events.at(-1)?.response.error.message).toBe("Gemini dropped the connection before it finished. Try again.");
    expect(run([delta({ content: "x" })], new Map(), true).types.at(-1)).toBe("response.completed");
    // nothing more comes out after an ending
    expect(cut.map.chunk(delta({ content: "late" }))).toEqual([]);
    expect(cut.map.end(true)).toEqual([]);
  });

  test("the event stream reader: lines split anywhere, CRLF, comments and multi-line data", async () => {
    const pieces = [": keep-alive\n\ndata: {\"a\"", ":1}\n\ndata: first\r\ndata: second\r\n\r", "\nevent: x\ndata: [DONE]\n\n", "data: last, unterminated"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of pieces) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    let reads = 0;
    const got: string[] = [];
    for await (const d of sseData(body, () => reads++)) got.push(d);
    expect(got).toEqual(['{"a":1}', "first\nsecond", "[DONE]", "last, unterminated"]);
    expect(reads).toBeGreaterThanOrEqual(pieces.length);
  });
});

// ---- The server, against a fake Chat-only server ----

async function readSse(res: Response) {
  const raw = await res.text();
  const events: Ev[] = [];
  for (const block of raw.split("\n\n")) {
    const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
    if (data) events.push(JSON.parse(data));
  }
  return { raw, events };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
};

type Via = { baseUrl: string; key: string };
const post = (via: Via, body: unknown, init: RequestInit = {}) =>
  fetch(`${via.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${via.key}`, "content-type": "application/json" }, body: JSON.stringify(body), ...init });

describe("the adapter server", () => {
  let dir: string;
  let app: App;
  let fake: ReturnType<typeof fakeChatServer>;
  let open: ReturnType<typeof fakeChatServer>;
  let fast: ChatAdapter;
  const id: Record<string, string> = {};
  const via = (name: string, adapter: ChatAdapter = app.adapter): Via => adapter.urlFor("codex", id[name])!;

  /** A Codex custom-model account the way T5's settings will save it: protocol "chat", and where the upstream's chat path differs. */
  function addAccount(name: string, label: string, baseUrl: string, apiKey: string | null, extra: Record<string, unknown> | null = { protocol: "chat" }, contextWindow: number | null = 65536) {
    const account = app.providers.setEndpointAccount("codex", { label, baseUrl, apiKey, models: "text", contextWindow });
    if (extra) {
      const saved = JSON.parse(app.store.kvGet("accounts") ?? "[]") as Record<string, unknown>[];
      app.store.kvSet("accounts", JSON.stringify(saved.map((a) => (a.id === account.id ? { ...a, ...extra } : a))));
    }
    id[name] = account.id;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ct-adapter-"));
    app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    fake = fakeChatServer({ key: KEY });
    open = fakeChatServer();
    fast = new ChatAdapter(app, { idleMs: 400, keepAliveMs: 50 });
    addAccount("gem", "Gemini", fake.url, KEY, { protocol: "chat", chatPath: GEMINI_PATH });
    addAccount("loc", "mlx local", open.url, null);
    addAccount("bad", "Gemini (old key)", fake.url, "wrong-key-0000", { protocol: "chat", chatPath: GEMINI_PATH });
    addAccount("down", "Down", "http://127.0.0.1:1", null);
    addAccount("plain", "Plain", fake.url, KEY, null);
    // Model servers on this machine: what this Mac's own llama.cpp holds (-c 16384), and a window too small for Codex at all.
    addAccount("small", "Qwen here", fake.url, KEY, { protocol: "chat" }, 16_384);
    addAccount("tiny", "Tiny local", fake.url, KEY, { protocol: "chat" }, 4_096);
    addAccount("nosize", "Nameless server", fake.url, KEY, { protocol: "chat" }, null);
  });

  afterAll(async () => {
    await fast.shutdown();
    await app.shutdown();
    await fake.stop();
    await open.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("urlFor: Codex gets the adapter's address and its own token, never the upstream's key; the engine seam passes it on", () => {
    const gem = via("gem");
    expect(gem.baseUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/a/${id.gem}$`));
    expect(gem.key).toMatch(/^ct-/);
    expect(gem.key).not.toContain(KEY);
    expect(via("gem")).toEqual(gem); // the same every time
    expect(via("loc").key).not.toBe(gem.key); // one token per account
    expect(app.adapter.urlFor("claude", id.gem)).toBeNull(); // only Codex uses it
    expect(app.adapter.urlFor("codex", id.plain)).toBeNull(); // a server that speaks Responses is reached directly
    expect(app.adapter.urlFor("codex", "nope")).toBeNull();
    // Providers.endpointOf still answers with the upstream's real address and key: that is what the adapter itself calls
    expect(app.providers.endpointOf("codex", id.gem)).toMatchObject({ baseUrl: fake.url, key: KEY, protocol: "chat", chatPath: GEMINI_PATH });
    // what the engine hands the Codex driver (App's endpointFor)
    const deps = (app.engine as unknown as { deps: { endpointFor(m: unknown): Ev | null } }).deps;
    const forDriver = deps.endpointFor({ provider: "codex", config: { account: id.gem } });
    expect(forDriver).toMatchObject({ id: id.gem, label: "Gemini", baseUrl: gem.baseUrl, key: gem.key, models: ["text"], contextWindow: 65536 });
    expect(JSON.stringify(forDriver)).not.toContain(KEY);
    expect(deps.endpointFor({ provider: "codex", config: { account: id.plain } })).toMatchObject({ baseUrl: fake.url, key: KEY });
  });

  test("loopback only, on a port of its own, started on first use and ended by shutdown (streams in flight too)", async () => {
    const a = new ChatAdapter(app);
    const server = () => (a as unknown as { server: { hostname: string; port: number } | null }).server;
    expect(server()).toBeNull();
    expect(a.urlFor("codex", id.plain)).toBeNull();
    expect(server()).toBeNull(); // an account that doesn't need it doesn't start it
    const v = a.urlFor("codex", id.gem)!;
    expect(server()?.hostname).toBe("127.0.0.1");
    expect(server()?.port).toBeGreaterThan(0);
    expect(v.baseUrl).toContain(`:${server()?.port}/`);
    const res = await post(v, codexRequest({ model: "hung" }));
    const reader = res.body!.getReader();
    await reader.read(); // response.created: the stream is open
    const before = fake.aborted();
    await a.shutdown();
    expect(server()).toBeNull();
    await until(() => fake.aborted() > before); // the upstream request ended with it
    await expect(fetch(`${v.baseUrl}/v1/responses`, { method: "POST", body: "{}" })).rejects.toThrow();
    expect(a.urlFor("codex", id.gem)).toBeNull();
    await reader.cancel().catch(() => {});
  });

  test("the token: wrong, missing, another account's, wrong method and wrong path are all turned away before the upstream hears of it", async () => {
    const gem = via("gem");
    const seen = fake.seen.length + open.seen.length;
    const send = (token: string | null, url = `${gem.baseUrl}/v1/responses`, method = "POST") =>
      fetch(url, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` }, body: method === "POST" ? JSON.stringify(codexRequest()) : undefined });
    for (const token of ["wrong", null, "", via("loc").key, KEY]) {
      const res = await send(token);
      expect(res.status).toBe(401);
      expect(((await res.json()) as Ev).error).toMatchObject({ code: "invalid_api_key" });
    }
    expect((await send(gem.key, undefined, "GET")).status).toBe(405);
    expect((await send(gem.key, `${gem.baseUrl}/v1/models`, "GET")).status).toBe(404);
    expect((await send("anything", `${gem.baseUrl.replace(id.gem, "nope")}/v1/responses`)).status).toBe(401);
    expect(fake.seen.length + open.seen.length).toBe(seen);
  });

  test("a text reply, through Gemini's chat path with the real key; Codex never sees the key", async () => {
    const gem = via("gem");
    const before = fake.seen.length;
    const res = await post(gem, codexRequest({ model: "text" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { raw, events } = await readSse(res);
    expect(events.map((e) => e.type)).toEqual(["response.created", "response.output_item.added", "response.output_text.delta", "response.output_text.delta", "response.output_item.done", "response.completed"]);
    expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta)).toEqual(["Hello", " world"]);
    expect(events.at(-1)?.response).toMatchObject({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello world" }] }],
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } },
    });
    // the upstream got the translated request on the account's chat path, signed with the real key
    expect(fake.seen).toHaveLength(before + 1);
    const sent = fake.seen[before];
    expect(sent.path).toBe(GEMINI_PATH);
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    expect(sent.body).toEqual(toChatRequest(codexRequest({ model: "text" })).chat);
    // and nothing of it reaches Codex: not in the stream, not in the headers
    expect(raw).not.toContain(KEY);
    expect([...res.headers].join("\n")).not.toContain(KEY);
  });

  test("an account with no key sends none, and the default path is /v1/chat/completions", async () => {
    const before = open.seen.length;
    const { events } = await readSse(await post(via("loc"), codexRequest({ model: "text" })));
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(open.seen[before]).toMatchObject({ path: "/v1/chat/completions", auth: null });
  });

  test("reasoning, a message and three tool calls (fragmented, two interleaved) come out as items Codex can run", async () => {
    const { events, raw } = await readSse(await post(via("gem"), codexRequest({ model: "tools" })));
    const done = events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    expect(done).toMatchObject([
      { type: "reasoning", content: [{ type: "reasoning_text", text: "Two things to do." }] },
      { type: "message", content: [{ type: "output_text", text: "Looking." }] },
      { type: "function_call", call_id: "call_a", name: "shell", arguments: '{"command":["ls"]}' },
      { type: "function_call", call_id: "call_b", name: "lookup", namespace: "mcp__docs__", arguments: '{"q":"typo"}' },
      { type: "custom_tool_call", call_id: "call_c", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "response.completed", response: { output: done, usage: { total_tokens: 14 } } });
    expect(raw).not.toContain(KEY);
  });

  test("the token limit and the content filter end the response as a final failure, after what was written", async () => {
    const length = (await readSse(await post(via("gem"), codexRequest({ model: "length" })))).events;
    expect(length.map((e) => e.type)).toEqual(["response.created", "response.output_item.added", "response.output_text.delta", "response.output_text.delta", "response.output_item.done", "response.failed"]);
    expect(length.at(-1)?.response).toMatchObject({ error: { code: "invalid_prompt" } });
    expect(length.at(-1)?.response.error.message).toContain("Gemini ran out of room for its answer");
    expect(length.find((e) => e.type === "response.output_item.done")?.item.content[0].text).toBe("Cut off");
    const filter = (await readSse(await post(via("gem"), codexRequest({ model: "filter" })))).events;
    expect(filter.at(-1)).toMatchObject({ type: "response.failed", response: { error: { code: "invalid_prompt" } } });
    expect(filter.at(-1)?.response.error.message).toContain("safety filter");
    expect([...length, ...filter].some((e) => e.type === "response.completed" || e.type === "response.incomplete")).toBe(false);
  });

  test("upstream errors reach Codex as a Responses failure in plain words with the way out; none of them ends a connection Codex is waiting on", async () => {
    const cases: [account: string, model: string, code: string, words: string[]][] = [
      ["gem", "unauthorized", "invalid_prompt", ["Gemini refused this key.", "Settings → AI services"]],
      ["bad", "text", "invalid_prompt", ["Gemini (old key) refused this key."]], // the real thing: the server turns the wrong key away
      ["gem", "missing", "invalid_prompt", ['no model called "missing"', "Settings → AI services"]],
      ["gem", "ratelimit", "rate_limit_exceeded", ["Gemini is busy right now. Wait a moment and try again."]],
      ["gem", "quota", "invalid_prompt", ["out of quota or credit"]],
      // not `context_length_exceeded`: Codex 0.160 throws those words away for its own "clear earlier history" (see upstreamProblem)
      ["gem", "toolong", "invalid_prompt", ["more than toolong can hold", "Crosstalk sent about", "descriptions of 3 tools", "bigger context"]],
      ["gem", "errorchunk", "invalid_prompt", ["Gemini stopped with an error: The model is overloaded. Try again."]],
      ["gem", "cut", "invalid_prompt", ["Gemini dropped the connection before it finished. Try again."]],
      ["down", "text", "invalid_prompt", ["Couldn't reach Down at 127.0.0.1:1.", "Settings → AI services"]],
      ["gem", "fail500", "invalid_prompt", ["Gemini had a problem (error 500). Try again in a moment."]],
      // The two shapes that started this: a stand-in that ignores `stream: true` and answers in one piece.
      ["gem", "plain", "invalid_prompt", ["Gemini didn't answer as a stream", "Settings → AI services"]],
      ["gem", "json", "invalid_prompt", ["Gemini didn't answer as a stream"]],
    ];
    for (const [account, model, code, words] of cases) {
      const res = await post(via(account), codexRequest({ model }));
      expect(res.status).toBe(200); // the stream is open before anything can go wrong, so the failure is an event
      const { raw, events } = await readSse(res);
      const last = events.at(-1)!;
      expect(last.type).toBe("response.failed");
      expect(last.response).toMatchObject({ status: "failed", error: { code } });
      for (const w of words) expect(last.response.error.message).toContain(w);
      expect(events.some((e) => e.type === "response.completed" || e.type === "response.incomplete")).toBe(false);
      expect(raw).not.toContain(KEY);
      expect(raw).not.toContain("wrong-key-0000");
    }
    // a half-written message is never closed as a finished item
    const partial = (await readSse(await post(via("gem"), codexRequest({ model: "errorchunk" })))).events;
    expect(partial.map((e) => e.type)).toEqual(["response.created", "response.output_item.added", "response.output_text.delta", "response.failed"]);
  });

  test("an upstream that repeats our key back in its error never gets it to Codex", async () => {
    const { raw, events } = await readSse(await post(via("gem"), codexRequest({ model: "echo" })));
    expect(fake.seen.at(-1)?.auth).toBe(`Bearer ${KEY}`); // it really was in what the upstream got
    expect(raw).not.toContain(KEY);
    expect(events.at(-1)?.response.error.message).toContain("Gemini refused the request: Bad request. The header was Bearer [key]");
  });

  test("a stalled upstream ends the reply with a failure, Codex is kept waiting meanwhile, and the upstream request is dropped", async () => {
    const before = fake.aborted();
    const t0 = Date.now();
    const { events } = await readSse(await post(via("gem", fast), codexRequest({ model: "hung" })));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { error: { code: "invalid_prompt" } } });
    expect(events.at(-1)?.response.error.message).toContain("Gemini stopped answering for");
    expect(events.filter((e) => e.type === "response.output_text.delta")).toHaveLength(1); // what it said before going quiet
    expect(events.filter((e) => e.type === "response.in_progress").length).toBeGreaterThan(1); // the do-nothing events that keep Codex waiting
    await until(() => fake.aborted() > before);
  });

  test("when Codex hangs up, the upstream request is dropped too", async () => {
    const before = fake.aborted();
    const inflight = (app.adapter as unknown as { inflight: Set<unknown> }).inflight;
    const ac = new AbortController();
    const res = await post(via("gem"), codexRequest({ model: "hung" }), { signal: ac.signal });
    const reader = res.body!.getReader();
    let got = "";
    while (!got.includes("Start")) got += new TextDecoder().decode((await reader.read()).value);
    expect(inflight.size).toBeGreaterThan(0);
    ac.abort();
    await until(() => fake.aborted() > before && inflight.size === 0);
  });

  test("a first message goes to a 16k model with the tools it needs, inside the window and under the compaction limit", async () => {
    const { events } = await readSse(await post(via("small"), firstMessage(0, { model: "text" })));
    expect(events.at(-1)?.type).toBe("response.completed");
    const body = fake.seen.at(-1)!.body;
    const sent = requestSize(body);
    expect(toolNames(body)).toContain("mcp__crosstalk_setup__setup_status");
    expect(toolNames(body)).toContain("exec_command"); // the agent keeps the tools it works with
    // The point of the whole fix: what Crosstalk sends for a first message fits, with room left for the answer — and under the
    // size the hub itself asked Codex to summarise the conversation at (driver.ts autoCompactLimit), so the chat doesn't compact
    // on every single turn for a conversation that is a twentieth of the prompt.
    expect(sent.total).toBeLessThan(16_384 - 2_048);
    expect(sent.total).toBeLessThanOrEqual(autoCompactLimit(undefined, { contextWindow: 16_384 })!);
    expect(sent.total).toBeLessThan(CODEX_PROMPT_FLOOR);
  });

  test("the tools Codex attaches of the person's own are held to what the model can hold: they never leave the machine, and the reply still comes", async () => {
    const { events } = await readSse(await post(via("small"), firstMessage(ALL_APPS, { model: "text" })));
    expect(events.at(-1)?.type).toBe("response.completed"); // it answers, where before the server refused 8x its window
    const body = fake.seen.at(-1)!.body;
    const sent = requestSize(body);
    expect(sent.total).toBeLessThanOrEqual(autoCompactLimit(undefined, { contextWindow: 16_384 })!);
    expect(sent.toolCount).toBeLessThan(30); // 361 went in
    expect(toolNames(body).some((n) => n.startsWith("multi_agent"))).toBe(false); // the helper tools go first
    expect(toolNames(body)).toContain("exec_command");
    expect(toolNames(body)).toContain("mcp__node_repl__js"); // a 455-token server of the person's own, which still fits
    expect(body.tool_choice).toBe("auto");
  });

  test("a server that never said what it holds is left alone: nothing is measured, nothing is left out", async () => {
    const { events } = await readSse(await post(via("nosize"), firstMessage(ALL_APPS, { model: "text" })));
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(requestSize(fake.seen.at(-1)!.body).toolCount).toBe(361); // a size Crosstalk doesn't know is not a size to hold a request against
  });

  test("a model too small for Codex itself is told so here, in Crosstalk's own words, and nothing is sent", async () => {
    const before = fake.seen.length;
    const res = await post(via("tiny"), firstMessage(ALL_APPS, { model: "text" }));
    expect(res.status).toBe(400);
    const err = ((await res.json()) as Ev).error;
    // `invalid_prompt`, never `context_length_exceeded`: Codex 0.160 replaces that one's words with "Codex ran out of room in the
    // model's context window. Start a new thread or clear earlier history before retrying." (checked by sending it both codes).
    expect(err.code).toBe("invalid_prompt");
    expect(err.message).toContain("text is too small for Codex");
    expect(err.message).toContain("4,096");
    expect(err.message).toContain("pick a model with a bigger context");
    expect(err.message).not.toContain("Start a new chat"); // a new chat would be exactly this big
    // Every refusal says what Crosstalk left out, and names the servers: this is the only place the person hears about it.
    expect(err.message).toContain("Crosstalk already left 343 tools out (helper agents, media and 15 more).");
    expect(fake.seen.length).toBe(before);
  });

  test("a conversation that outgrew the model says that instead, with the agent's own prompt counted apart from it", async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ type: "message", role: i % 2 ? "assistant" : "user", content: [{ type: i % 2 ? "output_text" : "input_text", text: pad(`Turn ${i}: and then we looked at the other file. `, 2_000) }] }));
    const before = fake.seen.length;
    const res = await post(via("small"), firstMessage(ALL_APPS, { model: "text", input: long }));
    expect(res.status).toBe(400);
    const err = ((await res.json()) as Ev).error;
    expect(err.message).toContain("This chat is longer than text can hold");
    expect(err.message).toContain("tokens of what's been said");
    // Codex's own instructions are 6,700 tokens of any request: counted as "the conversation" they would have the person
    // blamed for a chat one word long, so they are named separately and never folded into the figure above.
    expect(err.message).toMatch(/beside about [\d,]+ for Codex's own instructions and tools/);
    expect(err.message).toContain("Crosstalk already left");
    expect(err.message).toContain("Start a new chat");
    expect(fake.seen.length).toBe(before);
  });

  test("when the tools are what doesn't fit, the words say so and don't blame the chat's length", async () => {
    // The branch the real catalogue can't reach (Codex's own instructions are bigger than the tools it can't work without): a
    // request whose own tools are the bulk — a pinned connector tool, and a developer message instead of Codex's instructions.
    const before = fake.seen.length;
    const fat = { type: "namespace", name: "mcp__crosstalk__", tools: Array.from({ length: 4 }, (_, i) => ({ type: "function", name: `huge_${i}`, description: "A tool that can never be left out", parameters: schema(6_000) })) };
    const res = await post(via("tiny"), firstMessage(ALL_APPS, { model: "text", instructions: "", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi!" }] }], tools: [...ownTools(), ...appTools(ALL_APPS), fat] }));
    expect(res.status).toBe(400);
    const err = ((await res.json()) as Ev).error;
    expect(err.code).toBe("invalid_prompt");
    expect(err.message).toContain("text can't hold the tools Codex sends");
    expect(err.message).toMatch(/descriptions for \d+ tools/);
    expect(err.message).toContain("This isn't the chat's length");
    expect(err.message).toContain("Crosstalk already left");
    expect(err.message).not.toContain("Start a new chat");
    expect(fake.seen.length).toBe(before);
  });

  test("a server that counted the prompt itself has its own figure in the words, not Crosstalk's estimate", async () => {
    // llama.cpp refuses with the count and the window in the body ({"error":{…,"n_prompt_tokens":139930,"n_ctx":16384}}).
    // Crosstalk's own number is an estimate that reads 0.7x on a hex dump, so where the server counted, it says the server's.
    const { events } = await readSse(await post(via("gem"), codexRequest({ model: "overctx" })));
    const failed = events.at(-1)!;
    expect(failed.response.error.code).toBe("invalid_prompt");
    expect(failed.response.error.message).toContain("Gemini counted 20,024 tokens in what Crosstalk sent");
    expect(failed.response.error.message).not.toContain("Crosstalk sent about");
    expect(failed.response.error.message).toContain("bigger context");
  });

  test("requests that can't be served say why, as Responses errors, without bothering the upstream", async () => {
    const before = fake.seen.length;
    // Every refusal of a request that carries a prompt is an HTTP 400 with a code Codex takes as final (NO_RETRY): the words
    // say which refusal it is, because the code can't — any other code or status and the identical request comes back.
    const prev = await post(via("gem"), codexRequest({ previous_response_id: "resp_1" }));
    expect(prev.status).toBe(400);
    expect(((await prev.json()) as Ev).error).toMatchObject({ code: "invalid_prompt", param: "previous_response_id", message: expect.stringContaining("previous_response_id isn't supported here") });
    const junk = await fetch(`${via("gem").baseUrl}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${via("gem").key}` }, body: "{nope" });
    expect(junk.status).toBe(400);
    expect(((await junk.json()) as Ev).error).toMatchObject({ code: "invalid_prompt", message: "The request wasn't valid JSON." });
    // an account switched away from the chat adapter after Codex was given its address
    addAccount("flip", "Flip", fake.url, KEY);
    const flip = via("flip");
    const saved = JSON.parse(app.store.kvGet("accounts") ?? "[]") as Record<string, unknown>[];
    app.store.kvSet("accounts", JSON.stringify(saved.map((a) => (a.id === id.flip ? { ...a, protocol: undefined } : a))));
    const gone = await post(flip, codexRequest());
    expect(gone.status).toBe(400); // a 409 cost ten copies of the whole prompt
    expect(((await gone.json()) as Ev).error).toMatchObject({ code: "invalid_prompt", message: expect.stringContaining("isn't set up for the chat adapter any more") });
    expect(fake.seen.length).toBe(before);
  });

  // ---- The 92 resends: what Codex does with each shape of answer, and the one rule that follows from it ----

  test("every way a reply can end: a terminal event, and a code Codex takes as final — never one it answers by re-sending the prompt", async () => {
    // Measured against a real `codex exec` answering a stand-in (Codex 0.160.0, one "hi"): `response.completed` and
    // `response.failed` + `invalid_prompt` cost one request each, while `server_error` costs 6 copies of the whole prompt, a
    // stream that just closes 7, `rate_limit_exceeded` 11 and an HTTP 500 **57** — 666 KB of tools and conversation a time,
    // to a service that may bill for each (translate.ts NO_RETRY). So this table is the contract, not a detail.
    const lanes: [account: string, model: string][] = [
      ["gem", "text"],
      ["gem", "think"],
      ["gem", "tools"],
      ["gem", "length"],
      ["gem", "filter"],
      ["gem", "errorchunk"],
      ["gem", "cut"],
      ["gem", "plain"],
      ["gem", "json"],
      ["gem", "fail500"],
      ["gem", "unauthorized"],
      ["gem", "missing"],
      ["gem", "quota"],
      ["gem", "toolong"],
      ["gem", "overctx"],
      ["gem", "echo"],
      ["bad", "text"],
      ["down", "text"],
    ];
    const ended: Record<string, string> = {};
    for (const [account, model] of lanes) {
      const res = await post(via(account), codexRequest({ model }));
      expect(res.status).toBe(200); // the stream is open before anything can go wrong, so nothing is a bare status
      const { events } = await readSse(res);
      const last = events.at(-1)!;
      ended[`${account}/${model}`] = last.type === "response.failed" ? `failed:${last.response.error.code}` : last.type;
      // Every one of them says what happened, and nothing follows the ending.
      expect(events.filter((e) => e.type === "response.completed" || e.type === "response.failed")).toHaveLength(1);
    }
    expect(ended).toEqual({
      "gem/text": "response.completed",
      "gem/think": "response.completed",
      "gem/tools": "response.completed",
      "gem/length": "failed:invalid_prompt",
      "gem/filter": "failed:invalid_prompt",
      "gem/errorchunk": "failed:invalid_prompt",
      "gem/cut": "failed:invalid_prompt",
      "gem/plain": "failed:invalid_prompt",
      "gem/json": "failed:invalid_prompt",
      "gem/fail500": "failed:invalid_prompt",
      "gem/unauthorized": "failed:invalid_prompt",
      "gem/missing": "failed:invalid_prompt",
      "gem/quota": "failed:invalid_prompt",
      "gem/toolong": "failed:invalid_prompt",
      "gem/overctx": "failed:invalid_prompt",
      "gem/echo": "failed:invalid_prompt",
      "bad/text": "failed:invalid_prompt",
      "down/text": "failed:invalid_prompt",
    });
    for (const end of Object.values(ended)) if (end.startsWith("failed:")) expect(NO_RETRY).toContain(end.slice(7));

    // The one deliberate exception, and why: `rate_limit_exceeded` is what Codex reports back as `rateLimitExceeded`, which is
    // what makes the hub wait for the reset instead of failing the reply (agents/limits.ts codexLimitHit). A 429 is a refusal
    // the service doesn't bill for, so the copies it costs cost money nowhere.
    const busy = (await readSse(await post(via("gem"), codexRequest({ model: "ratelimit" })))).events.at(-1)!;
    expect(busy.response.error.code).toBe("rate_limit_exceeded");
    expect(busy.response.error.message).toContain("Wait a moment and try again");
  });

  test("a prompt that can't be served is refused with a final code, while the checks that carry no prompt keep their statuses", async () => {
    const gem = via("gem");
    // A GET, an unknown path and a token that isn't ours carry nothing to re-send, and these statuses are what tells a Codex
    // thread its key is still good (see the restarted hub below): they stay as they are.
    expect((await fetch(`${gem.baseUrl}/v1/responses`, { method: "GET", headers: { authorization: `Bearer ${gem.key}` } })).status).toBe(405);
    expect((await fetch(`${gem.baseUrl}/v1/models`, { method: "GET", headers: { authorization: `Bearer ${gem.key}` } })).status).toBe(404);
    const stale = await post({ ...gem, key: "ct-stale-token" }, codexRequest({ model: "text" }));
    expect(stale.status).toBe(401); // never a 200 stream: a key we don't know gets no answer from the service either
    expect(((await stale.json()) as Ev).error).toMatchObject({ code: "invalid_api_key" });
  });

  test("a server that blips is tried once here, instead of Codex sending the whole prompt again", async () => {
    // The resilience Codex's own retries used to provide, without a second copy of the request leaving it: the body is
    // already in the adapter's hands.
    const before = fake.calls("flaky");
    const { events } = await readSse(await post(via("gem"), codexRequest({ model: "flaky" })));
    expect(events.at(-1)?.type).toBe("response.completed"); // the reply still arrives
    expect(fake.calls("flaky")).toBe(before + 2); // one 500, then the answer — one request from Codex
    expect(events.filter((e) => e.type === "response.created")).toHaveLength(1);
    expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta)).toEqual(["Hello", " world"]);
    // A server that is simply broken is tried twice and then refused for good, not six times by Codex.
    const dead = fake.calls("fail500");
    const failed = (await readSse(await post(via("gem"), codexRequest({ model: "fail500" })))).events.at(-1)!;
    expect(fake.calls("fail500")).toBe(dead + 2);
    expect(failed.response.error.code).toBe("invalid_prompt");
    // A refusal the service meant is never sent twice: it would be the same refusal.
    const meant = fake.calls("missing");
    await readSse(await post(via("gem"), codexRequest({ model: "missing" })));
    expect(fake.calls("missing")).toBe(meant + 1);
  });

  test("a hub restarting under a reply tells Codex why, rather than leaving a stream that just stops", async () => {
    // A stream that closes with no terminal event is one Codex answers by POSTing the whole prompt seven times.
    const a = new ChatAdapter(app);
    const v = a.urlFor("codex", id.gem)!;
    const res = await post(v, codexRequest({ model: "hung" }));
    const reading = readSse(res);
    const inflight = (a as unknown as { inflight: Set<unknown> }).inflight;
    await until(() => inflight.size > 0);
    await a.shutdown();
    const { events } = await reading;
    expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed", error: { code: "invalid_prompt" } } });
    expect(events.at(-1)?.response.error.message).toBe("Crosstalk restarted while Gemini was answering, so this reply stopped part way. Try again.");
  });

  // ---- What the tools cost, measured where it is known and kept for the screens that say it ----

  test("what a request cost is kept for the model it was for, with the time it was taken, and nothing is kept for a model nobody has used", async () => {
    // Its own account, because a measurement is written once and then left alone for a while (cost.ts WRITE_GAP_MS): on one
    // this file has already sent a request to, the time kept would be that earlier request's, not this one's.
    addAccount("priced", "Qwen priced", fake.url, KEY, { protocol: "chat" }, 16_384);
    const t0 = Date.now();
    await readSse(await post(via("priced"), firstMessage(ALL_APPS, { model: "text" })));
    const kept = readToolCosts(app.store)[`codex:${id.priced}`];
    expect(Object.keys(kept)).toEqual(["text"]); // one entry per model actually used
    const cost = kept.text;
    expect(cost.at).toBeGreaterThanOrEqual(t0);
    expect(cost.at).toBeLessThanOrEqual(Date.now());
    // The request as Codex sent it, not what Crosstalk squeezed through: that is what the person is deciding about.
    expect(cost.toolCount).toBe(361);
    expect(cost.tools).toBeGreaterThan(120_000);
    expect(cost.prompt).toBeGreaterThan(cost.tools);
    expect(cost.window).toBe(16_384);
    const sent = requestSize(fake.seen.at(-1)!.body);
    expect(cost.toolCount - (cost.dropped ?? 0)).toBe(sent.toolCount);

    // A model no request has gone to has no figure at all, and neither does another account's model of the same name.
    addAccount("unused", "Never used", fake.url, KEY, { protocol: "chat" }, 16_384);
    expect(readToolCosts(app.store)[`codex:${id.unused}`]).toBeUndefined();
    expect((await app.providers.models("codex", id.unused, { fresh: true })).models.some((m) => m.toolCost)).toBe(false);
    expect(app.providers.accounts().find((x) => x.id === id.unused)?.endpoint?.toolCost).toBeUndefined();

    // The model it was measured on carries it, in the picker's list and on the service's own row in Settings.
    const measured = await app.providers.models("codex", id.priced, { fresh: true });
    expect(measured.models.find((m) => m.id === "text")?.toolCost).toMatchObject({ model: "text", toolCount: 361, window: 16_384 });
    expect(app.providers.accounts().find((x) => x.id === id.priced)?.endpoint?.toolCost).toMatchObject({ model: "text", toolCount: 361 });

    // A server that never said what it holds is still measured — the tools cost what they cost — with no window to hold it against.
    await readSse(await post(via("nosize"), firstMessage(ALL_APPS, { model: "text" })));
    expect(readToolCosts(app.store)[`codex:${id.nosize}`].text).toMatchObject({ toolCount: 361, window: null });
  });

  test("a chat's turns don't each write to the database and wake every phone", async () => {
    addAccount("chatty", "Qwen chatty", fake.url, KEY, { protocol: "chat" }, 16_384);
    const events: string[] = [];
    // Events that carry a measurement of this account's: those are the ones that re-render the model picker and the row in
    // Settings → AI services. (Adding an account fetches its model list too, which says nothing about what was measured.)
    const mine = (e: { t: string } & Record<string, any>) =>
      e.t === "models" ? e.catalog.accountId === id.chatty && e.catalog.models.some((m: any) => m.toolCost) : e.t === "account" ? e.account.id === id.chatty && !!e.account.endpoint?.toolCost : false;
    const off = app.bus.on((e) => void (mine(e) ? events.push(e.t) : null));
    try {
      // Ten turns of one chat, the catalogue unchanged, the conversation growing as a conversation does. Each one is
      // measured, because here is where it is known — but only the first is worth a write: the rest change nothing any
      // screen shows, and a write means re-serialising every measurement and pushing two events to every device.
      for (let i = 0; i < 10; i++) {
        const said = Array.from({ length: i + 1 }, (_, k) => ({ type: "message", role: "user", content: [{ type: "input_text", text: `turn ${k}: ${"x".repeat(400)}` }] }));
        await readSse(await post(via("chatty"), firstMessage(ALL_APPS, { model: "text", input: said })));
      }
      expect(events).toEqual(["models", "account"]);
      const kept = readToolCosts(app.store)[`codex:${id.chatty}`].text;
      expect(kept).toMatchObject({ model: "text", toolCount: 361, window: 16_384 });
      expect(kept.prompt).toBeGreaterThan(kept.tools); // what was kept is the first turn's, which is still true of the tools
    } finally {
      off();
    }
  });
});

describe("keeping what the tools cost (adapter/cost.ts)", () => {
  const kv = () => {
    const held = new Map<string, string>();
    return { kvGet: (k: string) => held.get(k) ?? null, kvSet: (k: string, v: string) => void held.set(k, v) };
  };
  const size = (tools: number, toolCount = 361) => ({ messages: 7_000, instructions: 6_300, tools, toolCount, total: tools + 7_000 });

  test("the newest measurement per model, written again when it changes or when what is kept has gone stale", () => {
    const store = kv();
    const now = Date.now();
    expect(noteToolCost(store, "codex", "acc", measure("qwen", size(134_000), 16_384, null, now))).toBe(true);
    expect(readToolCosts(store)["codex:acc"].qwen).toMatchObject({ model: "qwen", tools: 134_000, toolCount: 361, window: 16_384, at: now });
    expect(readToolCosts(store)["codex:acc"].qwen.dropped).toBeUndefined(); // nothing was left out
    // A chat's every turn measures; the same figures a minute later aren't a database write.
    expect(noteToolCost(store, "codex", "acc", measure("qwen", size(134_000), 16_384, null, now + 60_000))).toBe(false);
    expect(readToolCosts(store)["codex:acc"].qwen.at).toBe(now);
    // A figure that changed is the one worth showing, whenever it comes.
    expect(noteToolCost(store, "codex", "acc", measure("qwen", size(96_000, 240), 16_384, null, now + 61_000))).toBe(true);
    expect(readToolCosts(store)["codex:acc"].qwen).toMatchObject({ tools: 96_000, toolCount: 240, at: now + 61_000 });
    // And an unchanged one is refreshed once it's old, so the time shown doesn't age for ever.
    expect(noteToolCost(store, "codex", "acc", measure("qwen", size(96_000, 240), 16_384, null, now + 61_000 + 6 * 60_000))).toBe(true);
    // Each model and each account on its own.
    noteToolCost(store, "codex", "acc", measure("llama", size(1_200, 20), 8_192, null, now));
    noteToolCost(store, "codex", "other", measure("qwen", size(900, 12), 32_768, null, now));
    expect(Object.keys(readToolCosts(store)["codex:acc"]).sort()).toEqual(["llama", "qwen"]);
    expect(readToolCosts(store)["codex:other"].qwen.tools).toBe(900);
    expect(JSON.parse(store.kvGet(KV_COST)!)).toHaveProperty(["codex:acc", "qwen", "window"], 16_384);
  });

  test("a growing conversation with the same catalogue is one write, not one a turn", () => {
    const store = kv();
    const now = Date.now();
    // `prompt` is the whole request, so it grows with every message and every tool call of a turn. Comparing it made the
    // sameness test never true in a live chat: every single request was a database write plus an `account` event and a
    // `models` event to every connected phone, each re-rendering the model picker and the Settings row.
    const growing = (n: number) => ({ messages: 7_000 + n * 900, instructions: 6_300, tools: 134_000, toolCount: 361, total: 147_300 + n * 900 });
    expect(noteToolCost(store, "codex", "acc", measure("qwen", growing(0), 16_384, null, now))).toBe(true);
    expect(Array.from({ length: 10 }, (_, i) => noteToolCost(store, "codex", "acc", measure("qwen", growing(i + 1), 16_384, null, now + (i + 1) * 3_000)))).toEqual(Array(10).fill(false));
    // Nothing on a screen reads `prompt` (toolCostWords says the tools, the window and what went), so what is kept is still true.
    expect(readToolCosts(store)["codex:acc"].qwen).toMatchObject({ tools: 134_000, toolCount: 361, at: now });
    // Nor is how many tools were left out, which follows the conversation's size the same way (fewer fit as a chat grows).
    expect(noteToolCost(store, "codex", "acc", measure("qwen", growing(12), 16_384, { dropped: 349 } as never, now + 36_000))).toBe(false);
    // What a decision rests on is written whenever it changes, however big the conversation is by then.
    expect(noteToolCost(store, "codex", "acc", measure("qwen", { ...growing(13), tools: 12_400, toolCount: 19 }, 16_384, null, now + 39_000))).toBe(true);
    expect(readToolCosts(store)["codex:acc"].qwen).toMatchObject({ tools: 12_400, toolCount: 19, at: now + 39_000 });
  });

  test("what was left out is kept with it, so the words can say why a chat on such a model still works", () => {
    const store = kv();
    const trimmed = fitToWindow(toChatRequest(firstMessage(ALL_APPS)).chat, 16_384, autoCompactLimit(undefined, { contextWindow: 16_384 }));
    const cost = measure("text", trimmed.before, 16_384, trimmed);
    expect(cost.toolCount).toBe(361);
    expect(cost.dropped).toBeGreaterThan(300);
    expect(noteToolCost(store, "codex", "acc", cost)).toBe(true);
    expect(readToolCosts(store)["codex:acc"].text.dropped).toBe(cost.dropped);
  });
});

describe("a restarted hub", () => {
  const hub = (dir: string, dbPath: string) => new App({ dbPath, config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const close = async (a: App) => {
    await a.adapter.shutdown();
    await a.engine.shutdown();
    a.store.close();
  };
  function chatAccount(a: App, baseUrl: string) {
    const account = a.providers.setEndpointAccount("codex", { label: "Gemini", baseUrl, apiKey: KEY, models: "text" });
    const saved = JSON.parse(a.store.kvGet("accounts") ?? "[]") as Record<string, unknown>[];
    a.store.kvSet("accounts", JSON.stringify(saved.map((x) => (x.id === account.id ? { ...x, protocol: "chat" } : x))));
    return account.id;
  }

  test("listens again on the same port with the same tokens before anything asks, for a Codex thread the Codex app's server still has loaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-adapter-restart-"));
    const upstream = fakeChatServer();
    const first = hub(dir, join(dir, "hub.db"));
    let second: App | null = null;
    try {
      const id = chatAccount(first, upstream.url);
      const before = first.adapter.urlFor("codex", id)!;
      await close(first);
      await expect(fetch(`${before.baseUrl}/v1/responses`, { method: "POST", body: "{}" })).rejects.toThrow(); // the first hub is gone
      second = hub(dir, join(dir, "hub.db"));
      await Bun.sleep(30); // the new hub's adapter starts by itself: no chat has asked it for anything yet
      const res = await post(before, codexRequest({ model: "text" })); // the address and key the loaded thread remembers
      expect(res.status).toBe(200);
      expect((await readSse(res)).events.at(-1)?.type).toBe("response.completed");
      expect(second.adapter.urlFor("codex", id)).toEqual(before);
    } finally {
      if (second) await close(second);
      upstream.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("when something else has the saved port, a new port is used with the same tokens, and tokens of removed accounts are not kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-adapter-port-"));
    const app = hub(dir, ":memory:");
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    try {
      const id = chatAccount(app, "http://127.0.0.1:1");
      app.store.kvSet("adapter", JSON.stringify({ port: blocker.port, tokens: { [id]: "ct-saved", removed: "ct-old" } }));
      const a = new ChatAdapter(app);
      const v = a.urlFor("codex", id)!;
      expect(v.key).toBe("ct-saved");
      expect(v.baseUrl).not.toContain(`:${blocker.port}/`);
      expect((await fetch(`${v.baseUrl}/v1/responses`, { headers: { authorization: "Bearer ct-saved" } })).status).toBe(405); // it answers: the token is good
      const kept = JSON.parse(app.store.kvGet("adapter") ?? "{}");
      expect(kept.port).not.toBe(blocker.port); // the new port is what's remembered
      expect(kept.tokens).toEqual({ [id]: "ct-saved" });
      await a.shutdown();
    } finally {
      blocker.stop(true);
      await app.engine.shutdown();
      app.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
