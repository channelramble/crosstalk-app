// Responses API <-> Chat Completions, for the chat adapter (docs/SPEC-0.4.md, T6). The mapping tables are
// design/research-api-compat.md section 2, checked against Codex 0.160. Plain functions and one small state machine: nothing here
// touches the network, and nothing is remembered between requests.
//
// Limits, on purpose: a model that writes a tool call as plain text instead of using the tool-call field gets no tool run (its text
// reaches Codex as the model's message, untouched). Codex's own web search and tool search have no Chat equivalent and are left out.

import { isCrosstalkMcpServer } from "@crosstalk/shared";

type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

/** A request the adapter can't serve: answered with HTTP 400 and this message. */
export class BadRequest extends Error {
  constructor(
    message: string,
    readonly param: string | null = null,
  ) {
    super(message);
  }
}

/** The upstream reported a failure in the middle of a stream (an `error` chunk, as OpenRouter and others send). */
export class UpstreamError extends Error {}

/**
 * The error codes Codex 0.160 takes as final. Anything else it reads as "stream disconnected before completion" and answers by
 * POSTing the **whole request again** — the conversation, the agent's own prompt and every tool schema, which can be
 * 666 KB a time — to a service that may bill for each one. Measured with a real `codex exec` against a stand-in that answered
 * one shape per run (Codex 0.160.0, one "hi", requests counted at the stand-in):
 *
 *   `response.completed`                            1     (what a good answer costs)
 *   `response.failed` + `invalid_prompt`            1     before or after text has streamed
 *   HTTP 400 + body code `invalid_prompt`           1
 *   HTTP 429 + Retry-After                          1
 *   `response.failed` + `server_error`              6     HTTP 404: 6, 401: 7, 405: 8, 409: 10
 *   a stream that closes with no terminal event      7
 *   `response.failed` + `rate_limit_exceeded`       11     same for a failure whose error has no `code` at all
 *   HTTP 500                                        57     in 25 seconds: `stream_max_retries` (5) with a request-level retry around it
 *
 * So once Codex has handed over a prompt, every way this adapter can end a reply ends in one of these codes, and never in a
 * bare 5xx or a stream that simply stops. The one deliberate exception is a 429, which keeps `rate_limit_exceeded` because that
 * is the code Codex reports back as `rateLimitExceeded`, which is what makes the hub wait for the reset instead of failing the
 * reply (agents/limits.ts `codexLimitHit`, engine.ts LimitWaits); a 429 is a refusal the service doesn't bill for, so those
 * re-sends cost nothing but time.
 */
export const NO_RETRY: readonly string[] = ["invalid_prompt"];

// ---- Request: Responses -> Chat Completions ----

/** How a tool call coming back from the model is put back the way Codex declared the tool. */
export interface ToolRoute {
  name: string;
  namespace?: string;
  custom?: boolean;
}
export type ToolRoutes = Map<string, ToolRoute>;

/** The one string argument that carries a freeform (custom) tool's whole input, e.g. apply_patch's patch text. */
const CUSTOM_INPUT = "input";

/** A name the Chat API accepts (letters, digits, _ and -, at most 64) for a tool, with its namespace folded in. */
export function flatName(namespace: string | undefined, name: string): string {
  let flat = !namespace ? name : namespace.endsWith("_") ? namespace + name : `${namespace}__${name}`;
  flat = flat.replace(/[^A-Za-z0-9_-]/g, "_");
  return flat.length <= 64 ? flat : `${flat.slice(0, 55)}_${Bun.hash(flat).toString(36).slice(0, 8)}`;
}

function mapTools(tools: unknown, routes: ToolRoutes): Json[] {
  const out: Json[] = [];
  const add = (t: Json, namespace?: string) => {
    const name = str(t.name);
    if (!name) return;
    const flat = flatName(namespace, name);
    if (t.type === "custom") {
      // A freeform tool takes plain text, which a Chat function can only take as an argument: one string.
      routes.set(flat, { name, ...(namespace ? { namespace } : {}), custom: true });
      const description = `${str(t.description)} Give the whole input as the "${CUSTOM_INPUT}" argument.`.trim();
      out.push({ type: "function", function: { name: flat, description, parameters: { type: "object", properties: { [CUSTOM_INPUT]: { type: "string" } }, required: [CUSTOM_INPUT] } } });
    } else {
      routes.set(flat, { name, ...(namespace ? { namespace } : {}) });
      out.push({ type: "function", function: { name: flat, description: str(t.description), parameters: isObj(t.parameters) ? t.parameters : { type: "object", properties: {} } } });
    }
  };
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!isObj(t)) continue;
    if (t.type === "function" || t.type === "custom") add(t);
    else if (t.type === "namespace") {
      for (const inner of Array.isArray(t.tools) ? t.tools : []) if (isObj(inner) && (inner.type === "function" || inner.type === "custom")) add(inner, str(t.name) || undefined);
    }
    // web_search, tool_search, image_generation, local_shell: nothing in Chat Completions to map them to.
  }
  return out;
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface ChatMessage {
  role: string;
  content: string | Part[] | null;
  tool_calls?: Json[];
  tool_call_id?: string;
  reasoning_content?: string;
}

/** A message's content the way Chat wants it: a string, or (for a user's pictures) a list of parts. */
function contentOf(content: unknown, role: string): string | Part[] {
  if (typeof content === "string") return content;
  const parts: Part[] = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (!isObj(p)) continue;
    if (p.type === "input_image") {
      const url = typeof p.image_url === "string" ? p.image_url : isObj(p.image_url) ? str(p.image_url.url) : "";
      if (url) parts.push({ type: "image_url", image_url: { url } });
    } else if (typeof p.text === "string") parts.push({ type: "text", text: p.text });
  }
  if (role !== "user" || parts.every((p) => p.type === "text")) return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  return parts;
}

const asParts = (c: ChatMessage["content"]): Part[] => (c === null ? [] : typeof c === "string" ? (c ? [{ type: "text", text: c }] : []) : c);

function joinContent(a: ChatMessage["content"], b: ChatMessage["content"]): ChatMessage["content"] {
  if (a === null || a === "") return b ?? a;
  if (b === null || b === "") return a;
  return typeof a === "string" && typeof b === "string" ? `${a}\n\n${b}` : [...asParts(a), ...asParts(b)];
}

/** Chat templates are stricter than the Responses API (some refuse two system or user messages in a row, or an assistant message split
 * from its tool calls), so neighbours with the same role become one message. Tool results stay one message per call. */
function append(out: ChatMessage[], m: ChatMessage): void {
  const last = out[out.length - 1];
  if (!last || last.role !== m.role || m.role === "tool") {
    out.push(m);
    return;
  }
  last.content = joinContent(last.content, m.content);
  if (m.tool_calls) last.tool_calls = [...(last.tool_calls ?? []), ...m.tool_calls];
  if (m.reasoning_content) last.reasoning_content = last.reasoning_content ? `${last.reasoning_content}\n${m.reasoning_content}` : m.reasoning_content;
}

const textOf = (list: unknown): string => (Array.isArray(list) ? list.map((p) => (isObj(p) ? str(p.text) : "")).filter(Boolean).join("\n") : "");
const NO_IMAGE = "[An image was returned here, but this model can't see images in tool results.]";

/** A tool result as the text a Chat `tool` message holds. */
function toolText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((p) => (isObj(p) ? str(p.text) || (p.type === "input_image" ? NO_IMAGE : "") : "")).filter(Boolean).join("\n");
  if (isObj(output) && typeof output.content === "string") return output.content;
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

function mapInput(body: Json): ChatMessage[] {
  const out: ChatMessage[] = [];
  let thinking = ""; // reasoning items wait here for the assistant message they belong to
  const assistant = (m: Omit<ChatMessage, "role">) => {
    append(out, { role: "assistant", ...m, ...(thinking ? { reasoning_content: thinking } : {}) });
    thinking = "";
  };
  const instructions = str(body.instructions);
  if (instructions) append(out, { role: "system", content: instructions });
  const items = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  for (const it of items) {
    if (!isObj(it)) continue;
    const type = str(it.type) || (it.role ? "message" : "");
    if (type === "message") {
      const role = str(it.role);
      const content = contentOf(it.content, role);
      if (content === "" || (Array.isArray(content) && !content.length)) continue;
      if (role === "assistant") assistant({ content });
      else {
        thinking = "";
        append(out, { role: role === "developer" || role === "system" ? "system" : "user", content });
      }
    } else if (type === "reasoning") {
      thinking = [thinking, textOf(it.content) || textOf(it.summary)].filter(Boolean).join("\n");
    } else if (type === "function_call" || type === "custom_tool_call") {
      const custom = type === "custom_tool_call";
      const name = flatName(str(it.namespace) || undefined, str(it.name));
      const args = custom ? JSON.stringify({ [CUSTOM_INPUT]: str(it.input) }) : str(it.arguments) || "{}";
      assistant({ content: null, tool_calls: [{ id: str(it.call_id), type: "function", function: { name, arguments: args } }] });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      thinking = "";
      append(out, { role: "tool", tool_call_id: str(it.call_id), content: toolText(it.output) });
    }
    // web_search_call, tool_search_*, local_shell_call, compaction, ...: nothing a Chat server could use.
  }
  return out;
}

/** Newer Codex model families hand over their tools as an input item (`additional_tools`) instead of the `tools` field. */
const additionalTools = (input: unknown): unknown[] => (Array.isArray(input) ? input.flatMap((it) => (isObj(it) && it.type === "additional_tools" && Array.isArray(it.tools) ? it.tools : [])) : []);

function mapChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice;
  if (isObj(choice) && choice.type === "function" && str(choice.name)) return { type: "function", function: { name: flatName(str(choice.namespace) || undefined, str(choice.name)) } };
  return undefined;
}

/**
 * The body fields the adapter works out from the agent's own request. A service's extra fields (EndpointInfo.extra) are added
 * beside them but can never be one of these: a service's settings must not be able to change the model, the conversation, the
 * tools or the streaming, however they were saved.
 */
export const ADAPTER_FIELDS: readonly string[] = ["model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "max_tokens"];

/** A service's own body fields, with any of the adapter's own left out (see ADAPTER_FIELDS). */
function serviceFields(extra: unknown): Json {
  if (!isObj(extra)) return {};
  return Object.fromEntries(Object.entries(extra).filter(([k]) => !ADAPTER_FIELDS.includes(k)));
}

/**
 * A Codex request (POST /v1/responses) as a streaming Chat Completions request, plus how to put the model's tool calls back. Dropped:
 * store, include, prompt_cache_key, text, service_tier, client_metadata. Refused: previous_response_id (Codex sends the whole history).
 * `extra` is what the service itself needs in every request (Venice's `venice_parameters`), merged under the fields above.
 */
export function toChatRequest(body: unknown, extra?: unknown): { chat: Json; routes: ToolRoutes } {
  if (!isObj(body)) throw new BadRequest("The request must be a JSON object.");
  if (body.previous_response_id) throw new BadRequest("previous_response_id isn't supported here: send the whole conversation in input each time.", "previous_response_id");
  const routes: ToolRoutes = new Map();
  const tools = mapTools([...(Array.isArray(body.tools) ? body.tools : []), ...additionalTools(body.input)], routes);
  const chat: Json = { ...serviceFields(extra), model: body.model, messages: mapInput(body), stream: true, stream_options: { include_usage: true } };
  if (tools.length) {
    chat.tools = tools;
    const choice = mapChoice(body.tool_choice);
    if (choice !== undefined) chat.tool_choice = choice;
    if (typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  const effort = isObj(body.reasoning) ? str(body.reasoning.effort) : "";
  if (effort) chat.reasoning_effort = effort;
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  return { chat, routes };
}

// ---- How big a request is, and making it fit the model ----

/**
 * Characters of JSON per token for the parts Crosstalk itself puts together: the tool schemas, the wrapper around each message, the
 * fields beside them. Measured against a real Codex request with a local llama.cpp (Qwen 3, /apply-template then /tokenize,
 * nothing generated): the 361 tool schemas are 532,259 characters and 117,877 tokens (4.5 a token), Codex's own instructions 24,759
 * and 5,624 (4.4), so a round 4 reads 10-13% high on them — the safe side when deciding what to leave out.
 */
const BYTES_PER_TOKEN = 4;

/**
 * What text costs the model, which is not the same thing. Four characters a token holds for dense English and for JSON schemas, and
 * is far too low for most of what a coding agent carries: measured against the same tokenizer, the real count came to 1.4x that
 * estimate for a unified diff, 1.5x for JSON a tool returned, 1.9x for a Markdown table, 2.3x for log lines, 2.3x for base64, 2.1x
 * for Chinese, 2.6x for Korean, 3.3x for a hex dump and 5.2x for emoji (and 0.85x for plain English prose, which is what four was
 * calibrated on). So text is counted by what its characters are:
 *   a letter or a space      1/4 token    English words run about four characters a token
 *   a digit                  1 token      numbers, timestamps and hex are split up, often a digit at a time
 *   any other ASCII          1/2 token    punctuation, newlines and indentation are a token each, or close to it
 *   anything else            3/5 token    Chinese, Japanese, Korean, Hindi
 *   half an emoji           1.3 tokens    an emoji is two of these (JavaScript counts it as two characters) and costs about 2.6
 * On the same samples the estimate then lands between 1.4x high and 0.7x low, instead of up to 5x low: 1.2x English prose, 1.2x
 * Codex's own instructions, 1.1x source code, 1.0x a diff, 1.1x JSON a tool returned, 0.9x log lines, 1.1x Chinese, 1.4x Japanese,
 * 0.8x Korean, 1.2x Hindi, 0.95x emoji, 0.9x a Markdown table, 0.7x a hex dump, 0.5x base64 (a page of base64 is nearly always a
 * picture, which is counted as a picture). It is still an estimate, and still wrong in both directions: what it decides is whether
 * a request is plainly more than the model can hold, and a request that might just fit is sent so the server has the last word
 * (see `fitToWindow`).
 */
export function textTokens(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) n += 1.3; // half of an emoji or another character outside the Basic Multilingual Plane
    else if (c > 127) n += 0.6;
    else if (c >= 48 && c <= 57) n += 1;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32) n += 0.25;
    else n += 0.5;
  }
  return Math.ceil(n);
}

/** Roughly what a piece of JSON costs the model, in tokens: tool schemas and the fields beside them (see BYTES_PER_TOKEN). */
export const tokensOf = (part: unknown): number => (part === undefined || part === null ? 0 : Math.ceil(JSON.stringify(part).length / BYTES_PER_TOKEN));

/** What a mapped request costs the model: the conversation, the tool descriptions, how many tools there are, and the whole body. */
export interface RequestSize {
  messages: number;
  /**
   * The share of `messages` that is the agent's own system message, not anything the person said: Codex's instructions and its
   * `<permissions instructions>` are 6,400 tokens of a first "hi!". Told apart because a request too big for the model needs
   * different words when it's the agent's own prompt (only a bigger model helps) than when it's a long conversation (a new chat does).
   */
  instructions: number;
  tools: number;
  toolCount: number;
  total: number;
}

/**
 * What a picture in a message costs, whatever its bytes: a photo arrives as a data URL of a megabyte or more and costs the model a
 * few hundred to a couple of thousand tokens, so counting its characters would have Crosstalk hold back a picture that fits. Low on
 * purpose (a model that wants more will refuse the request itself, and say so plainly now).
 */
const IMAGE_TOKENS = 1_000;

/**
 * One message's tokens: the text in it counted as text, a picture counted as a picture, and the JSON frame around them (the role, the
 * field names, a call's id) at four characters a token. A tool call's arguments and a tool's result go through `textTokens` as well:
 * they are the likeliest place in a request for a diff, a log or a hex dump, which is exactly what four characters a token is worst at.
 */
function messageTokens(m: unknown): number {
  if (typeof m === "string") return textTokens(m);
  if (Array.isArray(m)) return m.reduce<number>((n, p) => n + messageTokens(p), 0);
  if (!isObj(m)) return 1; // a number, true, null: a token
  if (m.type === "image_url") return IMAGE_TOKENS;
  return Object.entries(m).reduce<number>((n, [k, v]) => n + textTokens(k) + messageTokens(v), 0);
}

export function requestSize(chat: Json): RequestSize {
  const tools = Array.isArray(chat.tools) ? chat.tools : [];
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const { messages: _m, tools: _t, ...fields } = chat;
  const said = messages.reduce<number>((n, m) => n + messageTokens(m), 0);
  return {
    messages: said,
    instructions: messages.reduce<number>((n, m) => n + (isObj(m) && m.role === "system" ? messageTokens(m) : 0), 0),
    tools: tools.length ? tokensOf(tools) : 0,
    toolCount: tools.length,
    total: said + (tools.length ? tokensOf(tools) : 0) + tokensOf(fields),
  };
}

/**
 * Which group of tools a tool belongs to when a request is more than the model can hold, and how readily that group goes (the rank,
 * highest first).
 *
 * Codex offers every tool the person's own Codex and ChatGPT-app setup has, inline in each request: in one measured setup that is 361 tools and
 * 133,500 tokens of schemas for a first "hi!", of which 333 `mcp__codex_apps__*` (ChatGPT-app connectors such as Gmail, GitHub and Drive) are
 * 126,000 — 95% of the request. No 16k model can hold that, whatever the message says. Crosstalk can't ask Codex to offer fewer, so
 * when the request doesn't fit it sends fewer, in this order, and never more than it must:
 *   2  Codex's helper-agent tools (`multi_agent_v1__*`, 2,700 tokens) — teamwork one small local model can't do anyway, so they go
 *      before anything the person set up themselves.
 *   1  one group per MCP server the person has, and per app inside Codex's connector server (`mcp__codex_apps__gmail`,
 *      `mcp__node_repl__`, ...). The chat loses Gmail or GitHub; a chat that can't answer at all loses more.
 *   0  never: Codex's own tools (running commands, writing files, images, asking the person a question) and Crosstalk's own (920
 *      tokens: the person's other chats, the setup checks). Without these the agent can't work, and a chat that looks broken is
 *      worse than one that is plainly smaller.
 *
 * A whole server goes at once, never some of its tools: a model offered `pets___delete_pet` but not `gmail___read_email` because the
 * one schema was shorter is harder to understand than one offered no connectors at all. Codex's connector server is one server with
 * every ChatGPT app in it (14 of them in that setup, 111 to 38,000 tokens each), and its tools are named `mcp__codex_apps__<app>___<tool>`, so
 * an app counts as a server of its own: that way a model with room for most of them keeps most of them, each app whole.
 */
function toolGroup(name: string): { rank: number; group: string } {
  // Crosstalk's own servers, in a chat (mcp__crosstalk__*) and while setting up (mcp__crosstalk_setup__*): the same rule a lean
  // thread uses to decide which servers it may switch off (shared isCrosstalkMcpServer), so the two can't disagree.
  if (isCrosstalkMcpServer(name)) return { rank: 0, group: "" };
  if (name.startsWith("mcp__")) {
    // One group per server ("mcp__codex_apps__" out of "mcp__codex_apps__gmail___read"), and per app where a server holds apps.
    const server = /^(mcp__.+?__)/.exec(name)?.[1] ?? name;
    const [app, tool] = name.slice(server.length).split("___");
    return { rank: 1, group: app && tool !== undefined ? server + app : server };
  }
  if (name.startsWith("multi_agent")) return { rank: 2, group: "helper agents" };
  return { rank: 0, group: "" };
}

/** A group's name the way a person would say it: the server or app without the MCP plumbing (`mcp__codex_apps__gmail` -> "gmail"). */
export const groupLabel = (group: string): string => group.replace(/^mcp__/, "").replace(/^codex_apps__/, "").replace(/__$/, "");

/** What `fitToWindow` did: what the request costs now, what it cost as Codex sent it, and what had to go. */
export interface Trimmed {
  size: RequestSize;
  before: RequestSize;
  /** Tools left out, what they cost, and which groups they came from (see toolGroup). */
  dropped: number;
  droppedTokens: number;
  droppedGroups: string[];
  /** The model's window, what is left of it for the answer, and the size the request was fitted to. */
  window: number;
  room: number;
  aim: number;
  /** Even what can never be left out is more than the model holds: there is nothing worth sending, so the caller refuses instead. */
  over: boolean;
}

/** Room kept for the answer: an eighth of the window, 512 to 4,096 tokens. A prompt that fills the window exactly leaves the model
 * nothing to write with, and llama.cpp refuses one that is longer than the window outright. Not Codex's own `max_output_tokens`
 * (it rarely sends one, and when it does it is what it would like, not what the answer needs): reserving that much would leave
 * tools out of requests that fit. */
const replyRoom = (window: number): number => Math.min(4096, Math.max(512, Math.floor(window / 8)));

/**
 * Leaves tools out of a mapped request, a whole group at a time in the order above, until it fits; says what went. The request is
 * changed in place. A tool the request pins with `tool_choice` always stays, whatever its group, because the model is being told to
 * call that one.
 *
 * What it fits the request to (`aim`) is the window less the room kept for the answer, and never more than `compactAt` — the size the
 * hub asked the agent to summarise the conversation at (`agents/driver.ts autoCompactLimit`, three quarters of a server's window).
 * A request bigger than that one is compacted on arrival, every single turn: on a 16k model the agent's own prompt and the tools it
 * can't work without are 10,000 of the 12,288, so summarising the conversation to nothing wouldn't get under it, and each pass is
 * another full prompt read (two minutes here) that never helps.
 *
 * Within a rank the smallest group that frees enough goes, and only when none alone is enough does the biggest go first: to make room
 * for a few hundred tokens a 457-token server is left out, not the 125,000-token one.
 *
 * `over` means the request is past the window even with every group that may go gone: nothing worth sending is left, so the caller
 * refuses in its own words instead. The gap between `aim` and the window is the margin for the estimate being wrong (see
 * `textTokens`): a request that eats into the answer's room is still sent and the server has the last word, one the estimate puts
 * past the window itself never is.
 */
export function fitToWindow(chat: Json, window: number, compactAt?: number | null): Trimmed {
  const before = requestSize(chat);
  const room = replyRoom(window);
  const aim = Math.min(window - room, compactAt && compactAt > 0 ? compactAt : window);
  const out: Trimmed = { size: before, before, dropped: 0, droppedTokens: 0, droppedGroups: [], window, room, aim, over: before.total > window };
  if (before.total <= aim) return out;
  const tools = Array.isArray(chat.tools) ? [...chat.tools] : [];
  const pinned = isObj(chat.tool_choice) && isObj(chat.tool_choice.function) ? str(chat.tool_choice.function.name) : "";
  const groups = new Map<string, { rank: number; group: string; tokens: number; at: number[] }>();
  tools.forEach((t, at) => {
    const name = isObj(t) && isObj(t.function) ? str(t.function.name) : "";
    if (name && name === pinned) return;
    const { rank, group } = name ? toolGroup(name) : { rank: 2, group: "unnamed" }; // an entry the mapping didn't make goes with the first to go
    if (!rank) return;
    const have = groups.get(group) ?? { rank, group, tokens: 0, at: [] };
    have.tokens += tokensOf(t);
    have.at.push(at);
    groups.set(group, have);
  });
  const gone = new Set<number>();
  let total = before.total;
  for (const rank of [...new Set([...groups.values()].map((g) => g.rank))].sort((a, b) => b - a)) {
    const left = [...groups.values()].filter((g) => g.rank === rank).sort((a, b) => a.tokens - b.tokens);
    while (total > aim && left.length) {
      const need = total - aim;
      const enough = left.findIndex((g) => g.tokens >= need);
      const [g] = left.splice(enough >= 0 ? enough : left.length - 1, 1);
      for (const at of g.at) gone.add(at);
      total -= g.tokens;
      out.droppedTokens += g.tokens;
      out.droppedGroups.push(g.group);
    }
    if (total <= aim) break;
  }
  if (gone.size) {
    const kept = tools.filter((_, at) => !gone.has(at));
    if (kept.length) chat.tools = kept;
    else {
      // Nothing left to offer: the fields that only make sense beside tools go too (a server given tool_choice with no tools refuses).
      delete chat.tools;
      delete chat.tool_choice;
      delete chat.parallel_tool_calls;
    }
    out.dropped = gone.size;
  }
  out.size = requestSize(chat);
  out.over = out.size.total > window;
  return out;
}

// ---- Response: Chat Completions stream -> Responses events ----

export type SseEvent = { type: string; [key: string]: unknown };

/** One event as the bytes of a Server-Sent Events stream. */
export const frame = (e: SseEvent): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * A failure as the last event of a response. `model` is there because every other event of this stream carries it (it used to be
 * built by hand without it); the `code` is load-bearing — a failure whose error object has none is re-sent 11 times (NO_RETRY).
 */
export function failedEvent(id: string, code: string, message: string, model = ""): SseEvent {
  return { type: "response.failed", response: { id, object: "response", ...(model ? { model } : {}), status: "failed", error: { code, message } } };
}

function mapUsage(u: Json): Json {
  const input = num(u.prompt_tokens ?? u.input_tokens);
  const output = num(u.completion_tokens ?? u.output_tokens);
  const inDetail = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const outDetail = isObj(u.completion_tokens_details) ? u.completion_tokens_details : {};
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: num(u.total_tokens) || input + output,
    input_tokens_details: { cached_tokens: num(inDetail.cached_tokens) },
    output_tokens_details: { reasoning_tokens: num(outDetail.reasoning_tokens) },
  };
}

const isWhole = (args: string): boolean => {
  try {
    return isObj(JSON.parse(args));
  } catch {
    return false;
  }
};

/** A freeform tool's input out of the wrapper argument. A model that wrote the text itself (no JSON) is taken at its word. */
function customInput(args: string): string {
  try {
    const v: unknown = JSON.parse(args);
    if (isObj(v) && typeof v[CUSTOM_INPUT] === "string") return v[CUSTOM_INPUT];
  } catch {
    /* not JSON */
  }
  return args;
}

/**
 * Turns one Chat Completions stream into Responses events: feed it each parsed chunk, then call `end()`. Text and reasoning stream
 * as they come, one item at a time; tool calls are gathered by index (their arguments arrive in fragments) and come out whole when
 * the stream ends, so a stream that breaks never leaves Codex a half-written call to run.
 */
export class StreamMapper {
  readonly id = rid("resp");
  private open: { kind: "reasoning" | "message"; id: string; index: number; text: string } | null = null;
  private calls = new Map<number, { id: string; name: string; args: string }>();
  private items: Json[] = [];
  private usage: Json | null = null;
  private finish: string | null = null;
  private over = false;

  constructor(
    private readonly routes: ToolRoutes,
    private readonly model: string,
    private readonly service: string,
  ) {}

  private response(extra: Json = {}): Json {
    return { id: this.id, object: "response", model: this.model, ...extra };
  }

  created(): SseEvent {
    return { type: "response.created", response: this.response({ status: "in_progress", output: [] }) };
  }

  /** A do-nothing event Codex ignores but counts as the stream being alive. */
  progress(): SseEvent {
    return { type: "response.in_progress", response: this.response({ status: "in_progress" }) };
  }

  /** Whether this response has already ended (completed or failed): nothing may follow a terminal event, and nothing may replace one. */
  get ended(): boolean {
    return this.over;
  }

  fail(code: string, message: string): SseEvent[] {
    if (this.over) return [];
    this.over = true;
    return [failedEvent(this.id, code, message, this.model)];
  }

  private close(): SseEvent[] {
    const o = this.open;
    if (!o) return [];
    this.open = null;
    const item: Json =
      o.kind === "reasoning"
        ? { type: "reasoning", id: o.id, summary: [], content: [{ type: "reasoning_text", text: o.text }] }
        : { type: "message", id: o.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: o.text, annotations: [] }] };
    this.items.push(item);
    return [{ type: "response.output_item.done", output_index: o.index, item }];
  }

  private write(kind: "reasoning" | "message", delta: string): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.open?.kind !== kind) {
      events.push(...this.close());
      const o = { kind, id: rid(kind === "reasoning" ? "rs" : "msg"), index: this.items.length, text: "" };
      this.open = o;
      const item = kind === "reasoning" ? { type: "reasoning", id: o.id, summary: [], content: [] } : { type: "message", id: o.id, role: "assistant", status: "in_progress", content: [] };
      events.push({ type: "response.output_item.added", output_index: o.index, item });
    }
    const o = this.open!;
    o.text += delta;
    const type = kind === "reasoning" ? "response.reasoning_text.delta" : "response.output_text.delta";
    events.push({ type, item_id: o.id, output_index: o.index, content_index: 0, delta });
    return events;
  }

  /** The events for one parsed chunk. Throws UpstreamError when the chunk is an error report. */
  chunk(c: Json): SseEvent[] {
    if (this.over) return [];
    if (c.error !== undefined && c.error !== null) throw new UpstreamError(typeof c.error === "string" ? c.error : isObj(c.error) ? str(c.error.message) || "unknown error" : "unknown error");
    if (isObj(c.usage)) this.usage = mapUsage(c.usage);
    const choice = Array.isArray(c.choices) && isObj(c.choices[0]) ? c.choices[0] : null;
    if (!choice) return [];
    const events: SseEvent[] = [];
    const d = isObj(choice.delta) ? choice.delta : {};
    const thought = str(d.reasoning_content) || str(d.reasoning);
    if (thought) events.push(...this.write("reasoning", thought));
    if (str(d.content)) events.push(...this.write("message", str(d.content)));
    for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      if (!isObj(t)) continue;
      events.push(...this.close());
      const fn = isObj(t.function) ? t.function : {};
      let index = typeof t.index === "number" ? t.index : t.id ? this.calls.size : Math.max(this.calls.size - 1, 0);
      const known = this.calls.get(index);
      // Some servers (Gemini's) number every call 0: a fragment with another id, or one that names a tool after a call that is
      // already whole, starts the next call.
      if (known && ((str(t.id) && known.id && str(t.id) !== known.id) || (str(fn.name) && known.name && isWhole(known.args)))) index = Math.max(...this.calls.keys()) + 1;
      const call = this.calls.get(index) ?? { id: "", name: "", args: "" };
      this.calls.set(index, call);
      if (str(t.id)) call.id = str(t.id);
      if (str(fn.name)) call.name = str(fn.name);
      call.args += isObj(fn.arguments) ? JSON.stringify(fn.arguments) : str(fn.arguments); // (a few servers send the arguments as an object)
    }
    if (typeof choice.finish_reason === "string") this.finish = choice.finish_reason;
    return events;
  }

  private callItem(call: { id: string; name: string; args: string }): SseEvent[] {
    const route = this.routes.get(call.name);
    const index = this.items.length;
    const base = { id: rid("fc"), call_id: call.id || rid("call") };
    const item: Json = route?.custom
      ? { type: "custom_tool_call", ...base, name: route.name, ...(route.namespace ? { namespace: route.namespace } : {}), input: customInput(call.args), status: "completed" }
      : { type: "function_call", ...base, name: route?.name ?? call.name, ...(route?.namespace ? { namespace: route.namespace } : {}), arguments: call.args || "{}", status: "completed" };
    this.items.push(item);
    const started = { ...item, status: "in_progress", ...(route?.custom ? { input: "" } : { arguments: "" }) };
    return [
      { type: "response.output_item.added", output_index: index, item: started },
      { type: "response.output_item.done", output_index: index, item },
    ];
  }

  /**
   * The stream is over: whatever is still open, then how the response ended. `sawDone`: the upstream said [DONE]. A stream that just
   * stopped, with no finish reason, was cut off.
   */
  end(sawDone: boolean): SseEvent[] {
    if (this.over) return [];
    // `invalid_prompt`, not `server_error`: the words say what happened, and the code is the only one Codex 0.160 doesn't answer
    // by re-sending the whole prompt (NO_RETRY: `server_error` costs six copies of it, one of which may be billed).
    if (!sawDone && this.finish === null) return this.fail("invalid_prompt", `${this.service} dropped the connection before it finished. Try again.`);
    const events = this.close();
    // The token limit and the content filter would be `response.incomplete`, but Codex 0.160 retries that five times, each time sending
    // the whole prompt again (to a service that may bill for it), and then only says "max_output_tokens". So they end as a plain failure
    // that stops Codex at once ("invalid_prompt" is the code it doesn't retry), and what was written so far stays in the chat.
    if (this.finish === "length") return [...events, ...this.fail("invalid_prompt", `${this.service} ran out of room for its answer and stopped part way. Ask for something shorter, or start a new chat, then try again.`)];
    if (this.finish === "content_filter") return [...events, ...this.fail("invalid_prompt", `${this.service}'s safety filter stopped this answer. Rephrase your message and try again.`)];
    this.over = true;
    // Whole calls only: a stream that broke or was cut never leaves Codex half a call to run.
    for (const [, call] of [...this.calls].sort((a, b) => a[0] - b[0])) if (call.name) events.push(...this.callItem(call));
    events.push({ type: "response.completed", response: this.response({ status: "completed", output: this.items, ...(this.usage ? { usage: this.usage } : {}) }) });
    return events;
  }
}

/** The `data:` payload of each event in a Server-Sent Events body. `onBytes` hears every read (it resets the stall timer). */
export async function* sseData(body: ReadableStream<Uint8Array>, onBytes: () => void = () => {}): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      onBytes();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) buf += "\n\n";
      for (let at = buf.search(/\r?\n\r?\n/); at >= 0; at = buf.search(/\r?\n\r?\n/)) {
        const block = buf.slice(0, at);
        buf = buf.slice(at).replace(/^\r?\n\r?\n/, "");
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
