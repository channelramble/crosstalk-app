import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isCrosstalkMcpServer, leanCodexTools, parseCodexQuestionReply, PROVIDER_INFO, wantsLongContext, type AgentQuestion, type ApprovalDecision, type BackgroundTask, type CodexQuestionReply, type PermissionMode, type UsageSnapshot, type UsageWindow } from "@crosstalk/shared";
import { chatToolTitle } from "../mcp/describe";
import { autoCompactLimit, CHAT_TOOL_NAMES, COMPACT_COMMAND, ROOM_TOOL_NAMES, type AgentDriver, type ApprovalRequest, type DriverContext, type TurnInput, type TurnResult, type TurnSink } from "./driver";
import { codexLimitHit, type LimitHit } from "./limits";
import { codexAuthHit, type AuthHit } from "./stale-login";
import { RpcError, SocketRpc, StdioRpc, type JsonRpc } from "./jsonrpc";
import { logger } from "../util/log";
import { codexRoleFiles, codexRoles, HELPER_TOOL, helperNote, sameModel } from "./model-lock";
import { alongsideNote } from "./alongside";
import { RUN_DIR } from "../config";

const log = logger("codex");

/**
 * Whether threads set up from now on get helper tools that leave model and effort out (see turnError for when OpenAI
 * refuses that for a model).
 */
let spawnOverridesHidden = true;

/** Tests: helper tools leave model and effort out again. */
export function hideSpawnOverridesAgain() {
  spawnOverridesHidden = true;
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The first Codex that takes the helper settings (features.multi_agent_v2 as a table with
 * expose_spawn_agent_model_overrides, agents.default_subagent_*). Older ones refuse the whole config over them: features
 * were only on/off switches (0.110), then multi_agent_v2 took no option it didn't know and agents keys were roles (0.144).
 */
const HELPER_SETTINGS_SINCE = [0, 145, 0];

/**
 * The first Codex whose keys for leaving the person's own tools out of a thread (features.apps, features.goals,
 * agents.enabled, include_apps_instructions, plugins.<id>.enabled, mcp_servers.<name>.enabled) are all the ones Crosstalk
 * sends. An unrecognised key only warns (configWarning), but `agents.enabled` is a type error to a Codex whose `agents`
 * keys were roles (pre-0.145: "invalid type: boolean, expected struct AgentRoleToml in `agents`"), which refuses the whole
 * config, so the version decides and a refusal is still retried without them (openThread).
 */
const LEAN_TOOLS_SINCE = [0, 160, 0];

/** The Codex version each app-server said it is when it started. */
const serverVersions = new WeakMap<JsonRpc, string>();

/**
 * What the person's own Codex setup has, as that app-server resolves it (config/read): their MCP servers and installed
 * plugins by name, so a lean thread can switch each off without the hub keeping a list of them. One ask per app-server;
 * null when it couldn't say (the name-free keys still take the connectors and the helper tools out).
 */
const serverSetups = new WeakMap<JsonRpc, Promise<OwnSetup | null>>();

interface OwnSetup {
  mcpServers: string[];
  plugins: string[];
}

const tableKeys = (v: Json): string[] => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).filter((k) => !!k) : []);

function ownSetup(rpc: JsonRpc, cwd: string): Promise<OwnSetup | null> {
  let asked = serverSetups.get(rpc);
  if (!asked) {
    // Short: a chat whose Codex can't answer this waits for its first reply, and the keys that need no names still apply.
    asked = rpc.request<Json>("config/read", { cwd }, 10_000).then(
      (r) => ({ mcpServers: tableKeys(r?.config?.mcp_servers), plugins: tableKeys(r?.config?.plugins) }),
      (e) => {
        log.info(`couldn't ask Codex which plugins and MCP servers it has (config/read): ${e instanceof Error ? e.message : e}. This chat still leaves out the app connectors and the helper tools.`);
        return null;
      },
    );
    serverSetups.set(rpc, asked);
  }
  return asked;
}

/** Notes the version an app-server's user agent names: "crosstalk/0.160.0 (Mac OS 27.0.1; arm64) …". */
function noteVersion(rpc: JsonRpc, init: Json) {
  const v = typeof init?.userAgent === "string" ? /^[^/\s]+\/(\d+\.\d+\.\d+)/.exec(init.userAgent)?.[1] : undefined;
  if (v) serverVersions.set(rpc, v);
}

/** Whether the version an app-server named is at least `min`; null when it named none. */
function atLeast(version: string | null, min: number[]): boolean | null {
  if (!version) return null;
  const v = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** Whether a Codex of this version takes the helper settings; null when it didn't say its version. */
export function takesHelperSettings(version: string | null): boolean | null {
  return atLeast(version, HELPER_SETTINGS_SINCE);
}

/** Whether a Codex of this version takes the settings that leave the person's own tools out; null when it didn't say. */
export function takesLeanTools(version: string | null): boolean | null {
  return atLeast(version, LEAN_TOOLS_SINCE);
}

/**
 * Codex refused a thread's config over the helper settings, as an older one does: "invalid type: map, expected a
 * boolean in `features`", "data did not match any variant of untagged enum FeatureToml in `features.multi_agent_v2`",
 * "invalid type: string …, expected struct AgentRoleToml in `agents`".
 */
function refusedHelperSettings(e: unknown): boolean {
  return /FeatureToml|AgentRoleToml|multi_agent_v2|default_subagent_|in `(features|agents)[`.]/.test(e instanceof Error ? e.message : String(e));
}

/** A thread request's params without the helper settings; null when it has none. */
function withoutHelperSettings(params: Json): Json | null {
  const config = params?.config;
  const features = { ...config?.features };
  const agents = { ...config?.agents };
  if (!("multi_agent_v2" in features || "default_subagent_model" in agents || "default_subagent_reasoning_effort" in agents)) return null;
  delete features.multi_agent_v2;
  delete agents.default_subagent_model;
  delete agents.default_subagent_reasoning_effort;
  return { ...params, config: { ...config, ...(config.features ? { features } : {}), ...(config.agents ? { agents } : {}) } };
}

/**
 * Codex refused a thread's config over the settings that leave the person's own tools out, as a Codex older or built
 * otherwise can: an unknown key is only warned about, but a known key given a shape it doesn't expect is a hard refusal
 * ("invalid type: boolean, expected struct AgentRoleToml in `agents`", "unknown field `enabled` ... in `mcp_servers`").
 */
function refusedLeanTools(e: unknown): boolean {
  return /PluginConfig|AgentRoleToml|FeatureToml|include_apps_instructions|in `(plugins|mcp_servers|features|agents|apps)[`.]/.test(e instanceof Error ? e.message : String(e));
}

/** A thread request's params without the settings that leave the person's own tools out; null when it has none. */
function withoutLeanTools(params: Json): Json | null {
  const config = params?.config;
  if (!config) return null;
  const features = { ...config.features };
  const agents = { ...config.agents };
  const servers = Object.fromEntries(Object.entries(config.mcp_servers ?? {}).filter(([, v]) => (v as Json)?.enabled !== false));
  const fewer = Object.keys(config.mcp_servers ?? {}).length !== Object.keys(servers).length;
  if (!("plugins" in config || "include_apps_instructions" in config || "apps" in features || "goals" in features || "enabled" in agents || fewer)) return null;
  delete features.apps;
  delete features.goals;
  delete agents.enabled;
  const { plugins: _p, include_apps_instructions: _i, features: _f, agents: _a, mcp_servers: _m, ...rest } = config;
  return {
    ...params,
    config: {
      ...rest,
      ...(config.features ? { features } : {}),
      ...(Object.keys(agents).length ? { agents } : {}),
      ...(Object.keys(servers).length ? { mcp_servers: servers } : {}),
    },
  };
}

/**
 * A group of thread settings a Codex can refuse the whole config over: how Codex words that refusal, how to take those
 * settings out, the flag that keeps them out from then on, and whether the chat may give them up on a refusal it can't
 * read at all (`optional`: settings that only take tools away, never ones that hold a helper to this chat's model).
 */
interface ConfigGroup {
  what: string;
  flag: "noLeanTools" | "noHelperSettings";
  refused: (e: unknown) => boolean;
  strip: (params: Json) => Json | null;
  optional?: boolean;
}

/**
 * The groups, in the order they are given up. Newest first, so an older Codex that refuses over a key both groups touch
 * (`features`, `agents`) loses the newer settings first and the chat still runs.
 */
const CONFIG_GROUPS: ConfigGroup[] = [
  { what: "the settings that leave your own Codex plugins out", flag: "noLeanTools", refused: refusedLeanTools, strip: withoutLeanTools, optional: true },
  { what: "the helper settings", flag: "noHelperSettings", refused: refusedHelperSettings, strip: withoutHelperSettings },
];

/**
 * What a thread warning of Codex's says, for the hub log; null when the notification isn't one. `configWarning` carries the
 * fields its generated type has — a `summary` and the `details` that name the keys Codex ignored
 * (codex-protocol/v2/ConfigWarningNotification) — and a plain `warning` a `message` (WarningNotification). Both are read, so
 * neither is logged as an escaped JSON dump with the key names cut off the end: this is the one and only sign that a Codex
 * update renamed one of the settings that leave the person's catalogue out, and that a chat quietly has over 100,000 tokens
 * of it back. Anything else is dumped whole rather than lost, and the cut is long enough to hold a list of keys.
 */
export function threadWarning(method: string, p: Json): string | null {
  if (method !== "configWarning" && !/(^|\/)warning$/i.test(method)) return null;
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const said = [text(p?.summary), text(p?.details)].filter(Boolean).join(" ") || text(p?.message) || text(p?.warning?.message) || text(p?.text) || JSON.stringify(p ?? null);
  const what = method === "configWarning" ? "ignored settings Crosstalk sent" : "warned about this chat";
  return `Codex ${what}: ${said.replace(/\s+/g, " ").trim().slice(0, 2_000)}`;
}

/**
 * Whether a refusal of a thread's config is one worth giving optional settings up for, without reading its words: Codex has
 * to have answered it (`codexRefused`: a timeout or a closed connection says nothing about the config), and it must not be
 * about the thread being gone — the resume path starts that chat anew (threadGone), and asking again would only spend
 * another request and wrongly mark the settings unusable for the rest of the chat.
 */
function unreadRefusal(e: unknown): boolean {
  return codexRefused(e) && !threadGone(e instanceof Error ? e.message : String(e));
}

export const CODEX_CLIENT_INFO = { name: "crosstalk", title: "Crosstalk", version: "0.1.0" };

/**
 * Codex's question tools show the chat a card the user taps. Options written in a message are only text, so chats with
 * someone to answer are told to ask with the tools, each for what it's for: request_user_input_async (GPT-6 models)
 * doesn't wait, and the answer comes as the user's next message; request_user_input outside Plan mode comes back empty
 * once the user lets it go unanswered (CodexDriver.optionalQuestionMs after a device shows it), and Codex's Default-mode
 * guidance then has the agent go on by its own judgment, so a decision it mustn't make alone doesn't go there.
 */
export const CODEX_QUESTION_NOTE =
  "To have the user choose between options, ask with a question tool instead of listing the options in your message: they answer in Crosstalk with a tap. request_user_input_async, when you have it, suits any question, decisions you mustn't make alone included: the answer comes as the user's next message, whenever they get to it, so don't make that decision meanwhile. request_user_input comes back empty if the user doesn't answer within a couple of minutes of seeing it: use it only for choices you could make yourself. Without request_user_input_async, ask a decision you mustn't make alone as one short question in your message, and wait for the reply.";

/** The id Codex's apps give question `index` of a message that asked without waiting (TUI async_questions). */
export function codexAsyncQuestionId(itemId: string, index: number): string {
  return JSON.stringify(["request_user_input_async", itemId, index]);
}

/**
 * The questions of an agentMessage Codex sent without waiting for the answers (request_user_input_async), as a card's:
 * the recommended (first) option picked to start with, and a typed answer always possible, as in Codex's apps.
 */
export function codexAsyncQuestions(item: Json): AgentQuestion[] {
  const raw: Json[] = Array.isArray(item?.questions) ? item.questions : [];
  return raw.flatMap((q, i): AgentQuestion[] => {
    const title = typeof q?.title === "string" ? q.title.trim() : "";
    if (!title) return [];
    const options = (Array.isArray(q.options) ? q.options : []).filter((o: unknown): o is string => typeof o === "string" && !!o.trim() && o.length <= 512).slice(0, 32);
    return [{
      id: codexAsyncQuestionId(String(item.id), i),
      header: "",
      question: title,
      options: options.map((label: string) => ({ label, description: "" })),
      multiSelect: false,
      allowOther: true,
      ...(options.length ? { preselected: options[0] } : {}),
    }];
  });
}

/**
 * The answers a user message of Codex's brings to its questions asked without waiting, read as Codex's apps read one
 * (codex-rs tui async_question_reply parse_input): skills and mentions aside, it's one text, and that's the envelope.
 */
export function codexQuestionReplyOf(content: unknown): CodexQuestionReply[] | null {
  const parts = (Array.isArray(content) ? content : []).filter((c: Json) => c?.type !== "skill" && c?.type !== "mention");
  return parts.length === 1 && parts[0]?.type === "text" && typeof parts[0].text === "string" ? parseCodexQuestionReply(parts[0].text) : null;
}

/** Codex answered a request with an error (it's there and said no), rather than going away or not answering in time. */
export function codexRefused(e: unknown): boolean {
  return e instanceof RpcError && e.code !== -32000 && e.code !== -32001;
}

/**
 * Codex's model list (the first page), with the models it keeps out of its picker: a chat can be on one of those (More
 * models), and its default effort is looked up here like any other's. A Codex that refuses includeHidden gives its usual list.
 */
function modelList(rpc: JsonRpc, timeoutMs: number): Promise<Json> {
  return rpc.request<Json>("model/list", { includeHidden: true }, timeoutMs).catch((e) => (codexRefused(e) ? rpc.request<Json>("model/list", {}, timeoutMs) : Promise.reject(e)));
}

/** Start `codex app-server` and complete the initialize handshake. */
export async function startCodexServer(bin: string, opts: { cwd?: string; env: Record<string, string> }): Promise<StdioRpc> {
  const rpc = new StdioRpc([bin, "app-server"], { cwd: opts.cwd, env: opts.env, name: "codex app-server" });
  try {
    noteVersion(rpc, await rpc.request("initialize", { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: true } }, 30_000));
  } catch (e) {
    // One that never answered isn't left running: nothing else holds it to end it.
    void rpc.kill();
    throw e;
  }
  rpc.notify("initialized");
  return rpc;
}

/** The socket of the Codex app's shared app-server (a daemon the Codex app, CLI and IDE all use), if it's running. */
export function codexDaemonSocket(env: Record<string, string | undefined>): string | null {
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  const p = join(home, "app-server-control", "app-server-control.sock");
  return existsSync(p) ? p : null; // a link to a socket that's gone counts as not running
}

/**
 * Connects to Codex for a chat: through the Codex app's shared server when it's running, so the chat's thread is the
 * same live thread the Codex app shows; otherwise a private `codex app-server` (threads are still saved where the
 * Codex app finds them).
 */
export async function connectCodex(bin: string, opts: { cwd?: string; env: Record<string, string> }): Promise<JsonRpc> {
  const sock = codexDaemonSocket(opts.env);
  if (sock) {
    const rpc = new SocketRpc(sock, "the Codex app's server");
    try {
      await rpc.ready;
      // Its own version, which can differ from the CLI's: the Codex app brings its own Codex.
      noteVersion(rpc, await rpc.request("initialize", { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: true } }, 15_000));
      rpc.notify("initialized");
      return rpc;
    } catch (e) {
      log.info(`couldn't use the Codex app's server, starting a private one: ${e instanceof Error ? e.message : e}`);
      void rpc.kill();
    }
  }
  return startCodexServer(bin, opts);
}

/** The threads an app-server has loaded: a resume of one rejoins it as it is. Throws when it can't say. */
async function loadedThreads(rpc: JsonRpc): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Json = await rpc.request("thread/loaded/list", cursor ? { cursor } : {}, 10_000);
    if (!Array.isArray(page?.data) || ++pages > 100) throw new Error("no list of loaded threads");
    for (const id of page.data) if (typeof id === "string") ids.add(id);
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
  } while (cursor);
  return ids;
}

function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins === 300) return "5-hour";
  if (mins === 10080) return "Weekly";
  if (mins === 1440) return "Daily";
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-minute`;
}

const PLAN_NAMES: Record<string, string> = {
  free: "ChatGPT Free",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Pro Lite",
  team: "ChatGPT Business",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
};

export function planName(p: string | null | undefined): string | null {
  if (!p) return null;
  return PLAN_NAMES[p] ?? `ChatGPT ${p.charAt(0).toUpperCase()}${p.slice(1)}`;
}

/** Map Codex's RateLimitSnapshot to our usage snapshot. */
export function codexUsage(rl: Json, prev?: UsageSnapshot | null): Partial<UsageSnapshot> {
  if (!rl) return {};
  const windows: UsageWindow[] = [];
  const add = (w: Json, fallback: string) => {
    if (!w) return;
    windows.push({ label: windowLabel(w.windowDurationMins, fallback), usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : null, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
  };
  add(rl.primary, "Primary");
  add(rl.secondary, "Secondary");
  const credits = rl.credits ? (rl.credits.unlimited ? "Unlimited" : rl.credits.hasCredits ? `${rl.credits.balance ?? "?"} left` : null) : undefined;
  const reached = rl.rateLimitReachedType ? `Limit reached (${rl.rateLimitReachedType}).` : null;
  return {
    plan: planName(rl.planType) ?? prev?.plan ?? null,
    windows: windows.length ? windows : prev?.windows ?? [],
    credits: credits === undefined ? prev?.credits ?? null : credits,
    note: reached,
  };
}

function policy(p: PermissionMode): { approvalPolicy: string; sandbox: string } {
  switch (p) {
    case "ask":
      return { approvalPolicy: "on-request", sandbox: "read-only" };
    case "edits":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
    case "auto":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
}

/**
 * Codex's answer to an approval. "Always allow" is answered as a plain accept too: Crosstalk keeps what's always
 * allowed and answers each such request itself (CodexDriver.allowed), because Codex's own approve-for-the-session would
 * outlive a grant the user removed, or a stricter permission setting.
 */
function decision(d: ApprovalDecision): string {
  return d === "deny" ? "decline" : "accept";
}

/** How an always-allowed command is kept: that exact command, in that folder and environment. */
export function codexCommandKey(command: string, cwd: unknown, environment: unknown): string {
  return JSON.stringify([command, typeof cwd === "string" ? cwd : "", typeof environment === "string" ? environment : ""]);
}

/** An always-allowed command or file as the chat's settings list it. */
export function codexAllowedLabel(kind: "allowCommands" | "allowFiles", item: string): string {
  if (kind === "allowFiles") return `Edits to ${item}`;
  try {
    const [command, cwd] = JSON.parse(item) as [string, string];
    return `The exact command \`${command}\`${cwd ? ` (in ${cwd})` : ""}`;
  } catch {
    return `The exact command \`${item}\``;
  }
}

function fileChangeDetail(changes: Json[] | undefined): string {
  if (!changes?.length) return "";
  return changes
    .map((c) => {
      const kind = c.kind?.type === "add" ? "new file" : c.kind?.type === "delete" ? "deleted" : c.kind?.move_path ? `moved to ${c.kind.move_path}` : "edited";
      return `${c.path} (${kind})\n${c.diff ?? ""}`.trimEnd();
    })
    .join("\n\n");
}

/** The service tier Codex runs fast on (models list it as "Fast"). */
export const CODEX_FAST_TIER = "priority";

interface ActiveTurn {
  /** The app-server this turn runs on: an exit of any other (one being replaced) doesn't end it. */
  rpc: JsonRpc;
  /** The turn has ended (its result reported), even if a newer turn has taken over since. */
  settled: boolean;
  turnId: string | null;
  sink: TurnSink;
  done: (r: TurnResult) => void;
  items: Map<string, { activityId: string; item: Json }>;
  lastAgentItem: string | null;
  usageStart: Json | null;
  error: string | null;
  tail: string;
  /** "Compact now": the turn summarizes the conversation instead of answering a message. */
  compact?: boolean;
  /** A message went in mid-turn: Codex reads it with its next step, so the next item starts a new reply. */
  splitNext?: boolean;
  stopping?: boolean;
  interruptSent?: boolean;
  checks?: Promise<void>[];
  helpers?: Set<string>;
  /** Messages steer handed to the turn that Codex hasn't taken in yet, by the id they went with. */
  steered?: Map<string, { text: string; messageIds?: string[] }>;
  /** "Read it now" stopped this Codex turn: once it ends, the messages it hadn't taken in start the next (afterReadNow). */
  readNow?: { turnId: string; timer: ReturnType<typeof setTimeout> };
  /** The app-server is being replaced mid-turn ("Read it now" found it stuck): its exit doesn't end the turn. */
  moving?: boolean;
  /** Steps it's in the middle of (their activity ids). */
  open?: Set<string>;
  /** A usage or rate limit a mid-turn error reported (limits.ts): the engine waits for it when the turn then fails. */
  limit?: LimitHit | null;
  /** A sign-in that stopped working, as a mid-turn error reported it (stale-login.ts): the engine starts Codex again. */
  auth?: AuthHit | null;
}

/** How long Stop waits for a turn to end before replacing the agent's process. */
const STOP_WAIT_MS = 5000;

/** Drives Codex through its official app-server protocol (one app-server process per room member). */
export class CodexDriver implements AgentDriver {
  readonly provider = "codex" as const;
  /** How long "Read it now" waits for Codex to stop its turn before replacing a stuck app-server. */
  static readNowWaitMs = 8000;
  /**
   * How long a question Codex can go on without (isBlocking false: every one outside Plan mode) waits for an answer
   * once a device shows its card, before Codex is told there's none, as Codex's own terminal app does from when the
   * question is on its screen (60 s, then a 60 s countdown), unless the user starts answering first. Until a device
   * shows it, it waits.
   */
  static optionalQuestionMs = 120_000;
  private rpc: JsonRpc | null = null;
  private threadId: string | null;
  /** The model the thread answers with, as Codex said when it started or resumed it. */
  private threadModel: string | null = null;
  private threadEffort: string | null = null;
  /** The role files that hold this chat's helpers to their model and effort (model-lock.ts), once written. */
  private roleFiles: { general: string; awaiter: string } | null = null;
  private helperOwners = new Map<string, ActiveTurn>();
  /** Codex's requests still open here, by request id: Codex can settle one some other way (serverRequest/resolved). */
  private openRequests = new Map<string, AbortController>();
  /**
   * Requests of this chat's own thread that came, on the Codex app's server, while no reply of this chat's ran: a turn
   * the Codex app runs on the thread, or one that was still waiting when this chat's connection went (a resume sends a
   * running thread's open requests again). Left to the Codex app until a reply of this chat's joins their turn (a
   * turn/start on a thread whose turn is running adds to that turn): from then they're the reply's (takeParked).
   */
  private parked = new Map<string, { method: string; params: Json; settled: AbortController; answer: (r: Json) => void; fail: (e: unknown) => void }>();
  /**
   * Turns of this chat's thread that were stopped (for answering on another model, or by "Read it now") or have ended:
   * what they still send (a helper's late "completed" note, say) belongs to no reply, and their ids are never taken for
   * a reply's. The newest few hundred (retire).
   */
  private retired = new Set<string>();
  /** The chat's standing notes went with a message already (see runTurn). */
  private notesSent = false;
  /** A duplicated chat on "Default" effort: its first turn sets the model's default, not the original's leftover one. */
  private forkEffort: string | null = null;
  /**
   * The thread may run with helper tools that leave model and effort out: it was set up so, or resumed on the Codex
   * app's server, which keeps a thread it already has loaded as it was set up (turnError).
   */
  private mayHideOverrides = false;
  /**
   * The thread this chat moved off the Codex app's server, which held it with settings OpenAI refused (turnError). Kept
   * in the chat's session: a replaced driver (new settings, ended while idle, a hub restart) would otherwise resume it
   * there, on that server's copy, which misses what was said since. Null once the chat is back on that server (connect).
   */
  private ownServerThread: string | null;
  /** This chat's Codex refused the whole config over the helper settings (it's older than they are): they're left out. */
  private noHelperSettings = false;
  /** The same for the settings that leave the person's own Codex plugins and the helper tools out of the thread. */
  private noLeanTools = false;
  /** This chat's thread was opened lean: no plugins of the person's, no app connectors, no helper agents (wantsLean). */
  private leanThread = false;
  private active: ActiveTurn | null = null;
  private starting: Promise<void> | null = null;

  constructor(
    private ctx: DriverContext,
    private bin: string,
  ) {
    this.threadId = (ctx.session.threadId as string) || null;
    this.ownServerThread = typeof ctx.session.ownServerThread === "string" ? ctx.session.ownServerThread : null;
    this.refs = new Map(Object.entries((ctx.session.msgRefs as Record<string, string> | undefined) ?? {}));
    this.kept = { allowCommands: ctx.session.allowCommands, allowFiles: ctx.session.allowFiles };
  }

  /**
   * What the user chose to always allow in this chat, read from the saved session each time: a restarted app-server
   * (ended while idle, or after a freeze) doesn't ask again, and one the user removed (or a stricter permission
   * setting, which clears them) asks at once. Commands are kept with their folder and environment (codexCommandKey).
   */
  private kept: Record<string, unknown>;
  private allowed(kind: "allowCommands" | "allowFiles"): Set<string> {
    const list = (this.ctx.latestSession?.() ?? this.kept)[kind];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  }
  private rememberAlways(kind: "allowCommands" | "allowFiles", items: string[], sink: TurnSink) {
    const kept = [...new Set([...this.allowed(kind), ...items])].slice(-100);
    this.kept = { ...this.kept, [kind]: kept };
    sink.saveSession({ [kind]: kept });
  }

  /**
   * Commands left running when the turn that started them ended (background terminals: a dev server, a watcher), by
   * item id. Ending a private app-server would end them, so it isn't ended while one runs (canEndWhenIdle).
   */
  private terminals = new Map<string, string>();

  /**
   * Helper agents of this chat's thread (threads whose parent is the chat's: Codex's multi-agent helpers), by thread id,
   * as the background tasks the hub shows and waits for (onTasks): one can outlive the reply that started it. While one
   * works, the app-server isn't ended for idling (canEndWhenIdle) and new settings wait for it (Engine.memberChanged):
   * ending a private app-server ends the helper. `answer`: its last words.
   */
  private helperTasks = new Map<string, BackgroundTask & { answer: string | null }>();
  /**
   * Helpers' final answers that came while no reply of this chat's ran. Codex 0.160 queues each for the chat's next
   * turn and starts none (notify_parent_of_terminal_turn, trigger_turn false), in its app-server's memory only: its
   * mailbox (core/src/session/input_queue.rs `mailbox_pending_mails`) is never written to the thread. A next turn on that
   * app-server takes them in; one on any other (restarted, or a new driver's) never would, so it's told them in words
   * (runTurn, carryNote). `on`: the app-server that holds them.
   */
  private leftAnswers: { on: JsonRpc | null; list: { thread: string; name: string; text: string }[] } = { on: null, list: [] };
  /** This chat is on the Codex app's server, which keeps a thread's helpers and their answers whoever connects. */
  private onShared = false;
  /** While a helper works with no reply running, its thread is read now and then, in case its end went unheard. */
  private helperPoll: ReturnType<typeof setInterval> | null = null;
  /** How often that is. */
  static helperPollMs = 20_000;

  /** The Codex turns this chat started (kept in its session): a sync from the Codex app never brings them in again. */
  private noteOwnTurn(turnId: string, sink: TurnSink) {
    const prev = this.ctx.latestSession?.().ownTurns;
    const list = Array.isArray(prev) ? prev.filter((t): t is string => typeof t === "string" && t !== turnId) : [];
    sink.saveSession({ ownTurns: [...list, turnId].slice(-300) });
  }

  /** Which Codex turn carried each of the human's messages: what a rewind goes back to. */
  private refs = new Map<string, string>();
  private noteRefs(ids: string[] | undefined, turnId: string, sink: TurnSink) {
    if (!ids?.length) return;
    for (const id of ids) this.refs.set(id, turnId);
    const recent = [...this.refs].slice(-300);
    this.refs = new Map(recent);
    sink.saveSession({ msgRefs: Object.fromEntries(recent) });
  }

  async rewind(messageId: string): Promise<string[]> {
    const turnId = this.refs.get(messageId);
    if (!turnId || !this.threadId) throw new Error("This message can't be rewound to: it was sent before rewinding existed, or from another app.");
    if (this.active && !this.active.settled) throw new Error("Stop the agent first.");
    // Outside a turn nothing listens for progress, so start the app-server with a sink that ignores it.
    const quiet = { status() {}, saveSession() {} } as unknown as TurnSink;
    await this.ensure(quiet);
    await this.rpc!.request("thread/revert", { threadId: this.threadId, beforeTurnId: turnId }, 30_000);
    return [...this.refs].filter(([, t]) => t === turnId).map(([id]) => id);
  }

  private async ensure(sink: TurnSink) {
    if (this.rpc?.alive && this.threadId) return;
    if (!this.starting) this.starting = this.start(sink).finally(() => (this.starting = null));
    await this.starting;
  }

  private async start(sink: TurnSink) {
    const { room, member, mcp, env, chat } = this.ctx;
    if (this.rpc) this.letGo(this.rpc);
    sink.status("Starting Codex", "thinking");
    // Chats use the Codex app's own server when it's running, so the conversation is live in both places. A group chat's
    // agent keeps its own, as the rooms before group chats did: its thread is its part of the chat, not a conversation.
    const rpc = chat && !chat.group ? await this.connect() : await startCodexServer(this.bin, { cwd: room.cwd, env });
    this.rpc = rpc;
    this.onShared = rpc instanceof SocketRpc;
    // A replaced app-server's commands ended with it, and its requests (whose ids the new one reuses) with them.
    this.terminals.clear();
    this.settleOpenRequests();
    // A replaced app-server's late events and requests belong to no current turn.
    rpc.onNotification((m, p) => {
      if (this.rpc === rpc) this.onNotification(m, p);
    });
    rpc.onRequest((m, p, id) => {
      if (this.rpc !== rpc) return Promise.reject(new Error("this app-server was replaced"));
      // An answer ready once this app-server was replaced or let go isn't sent: the connection is closing, and on the
      // Codex app's server the request stays open for the clients that have it (a resume here brings it back).
      const gone = () => new Promise<never>(() => {});
      return this.onRequest(m, p, id).then((r) => (this.rpc === rpc ? r : gone()), (e) => (this.rpc === rpc ? Promise.reject(e) : gone()));
    });
    void rpc.exited.then((code) => {
      if (this.rpc === rpc) {
        this.rpc = null;
        this.terminals.clear();
        // Helpers on a private app-server ended with it (their answers already given are kept: leftAnswers).
        if (!(rpc instanceof SocketRpc)) this.helpersGone();
      }
      if (this.active?.rpc !== rpc || this.active.moving) return;
      const why = rpc instanceof SocketRpc ? "The connection to the Codex app's server closed." : `Codex stopped unexpectedly (exit ${code}). ${rpc.stderrTail.trim().split("\n").slice(-2).join(" ")}`.trim();
      this.active.done({ ok: false, error: why });
    });
    const { approvalPolicy, sandbox } = policy(member.permissionMode);
    const endpoint = this.ctx.endpoint ?? null;
    // A chat on a model server of your own that holds too little for the person's own Codex setup runs lean: Codex is asked
    // to leave their plugins, their ChatGPT app connectors (hundreds of tools and over 100,000 tokens on a well-stocked setup) and its own helper
    // tools out of this thread, so they are never built, never sent over the loopback and never counted against the
    // window. Only a Codex that takes those settings gets them; one that refuses is asked again without them (openThread).
    const lean = this.wantsLean() && takesLeanTools(serverVersions.get(rpc) ?? null) !== false;
    // Group rooms get the room tools; a chat gets only the tool for asking the other agent, and only when teamwork is on.
    // A chat's agent gets Crosstalk's tools only for teamwork and for the user's other chats; a room's always.
    const crossChat = !!this.ctx.crossChat && !chat?.ephemeral;
    // Asking the other agent can take minutes; Codex's default tool time limit is much shorter.
    const compactAt = autoCompactLimit(member.config, endpoint);
    const providerId = endpoint ? `crosstalk_${endpoint.id}` : null;
    const model = member.model || endpoint?.models[0] || (typeof this.ctx.session.model === "string" ? this.ctx.session.model : null);
    // Long context (the chat's context menu): the most Codex lets this model have (it cuts a larger window to that).
    const longWindow = !endpoint && wantsLongContext(member.config) ? await this.longWindow(model) : null;
    // Only a Codex that takes them gets the helper settings (an older one refuses the whole config). One that didn't say
    // its version gets them, and is asked again without them if it refuses (openThread).
    const helperSettings = !this.noHelperSettings && takesHelperSettings(serverVersions.get(rpc) ?? null) !== false;
    /**
     * Everything about a thread that running lean changes, built from scratch either way: the helper roles that hold a helper
     * to this chat's model and effort, the tool for picking a helper's model, the standing note about helpers, and the settings
     * that leave the person's own plugins, connectors and Codex's helper tools out.
     *
     * A function and not two subtractions, because a Codex that refuses the lean settings has to be given an **ordinary**
     * thread, not a lean one with keys deleted: deleting `agents.enabled` leaves no `agents` at all, which is Codex's own
     * default — helpers on, roles unwritten, the spawn tool's model and effort on offer — and the chat would silently lose the
     * model lock this hub exists to keep (AGENTS.md's first user rule). So openThread asks for `build(false)` instead.
     */
    const build = async (lean: boolean) => {
      // What send() puts in front of the next message: a lean chat has no helpers, so no note about them.
      this.leanThread = lean;
      // Asking for helpers on another model (use_helper_model) is offered everywhere but in a one-off question, and not in a
      // lean chat, which has no helpers to pick a model for.
      const helperTool = chat?.ephemeral || lean ? {} : { CROSSTALK_HELPER_MODEL: "1" };
      const tools = chat && !chat.group
        ? chat.helper || crossChat || !chat.ephemeral
          ? { ...mcp.env, CROSSTALK_TOOLSET: "chat", ...(chat.helper ? { CROSSTALK_ASK: chat.helper.provider } : {}), ...(crossChat ? { CROSSTALK_CHATS: "1" } : {}), ...helperTool }
          : null
        : { ...mcp.env, ...(crossChat ? { CROSSTALK_CHATS: "1" } : {}), ...helperTool };
      // Helpers on a model of their own start at the chat's effort; on Default that's the chat model's default, which the
      // config has to say before the thread opens (Codex would start them at the helper model's default).
      const helperEffort = this.helperModel() && !chat?.ephemeral && !lean && !this.memberEffort() ? await this.defaultEffort(rpc, model) : null;
      // What a lean thread switches off by name: read from Codex's own resolved config, so the hub never holds a list of the
      // person's plugins and servers. Null when it couldn't be read: the keys below that need no names still apply.
      const own = lean ? await ownSetup(rpc, room.cwd) : null;
      // Crosstalk's own servers are never switched off, however the person named them in their config: the chat tools and the
      // setup tools they were told to add themselves (`codex mcp add crosstalk-setup …`), which the adapter never leaves out of
      // a request either (shared isCrosstalkMcpServer). A lean chat keeps `hub_log` and `setup_status`, as its words promise.
      const theirs = (own?.mcpServers ?? []).filter((name) => !isCrosstalkMcpServer(name));
      const config = {
        // Asking another agent or waiting for another chat's reply takes minutes; Codex's default limit is far shorter. The
        // table merges into the person's own, so each of their servers can be switched off beside Crosstalk's own entry.
        ...(tools || theirs.length
          ? {
              mcp_servers: {
                ...Object.fromEntries(theirs.map((name) => [name, { enabled: false }])),
                ...(tools ? { crosstalk: { command: mcp.command, args: mcp.args, env: tools, tool_timeout_sec: 900 } } : {}),
              },
            }
          : {}),
        // A model server of your own (a custom-model account): Codex talks to its Responses API instead of OpenAI's.
        ...(endpoint && providerId
          ? {
              model_provider: providerId,
              model_providers: {
                [providerId]: {
                  name: endpoint.label,
                  base_url: `${endpoint.baseUrl}/v1`,
                  wire_api: "responses",
                  requires_openai_auth: false,
                  ...(endpoint.key ? { http_headers: { Authorization: `Bearer ${endpoint.key}` } } : {}),
                },
              },
              ...(endpoint.contextWindow ? { model_context_window: endpoint.contextWindow } : {}),
            }
          : {}),
        ...(longWindow ? { model_context_window: longWindow } : {}),
        // Summarize older messages once the conversation reaches this size, instead of near the model's limit.
        ...(compactAt ? { model_auto_compact_token_limit: compactAt } : {}),
        // A lean thread: none of the person's own plugins (each by its id, `<name>@<marketplace>`), and not the developer
        // block that tells the model about its apps. Their ChatGPT app connectors go with features.apps below.
        ...(lean
          ? {
              include_apps_instructions: false,
              ...(own?.plugins.length ? { plugins: Object.fromEntries(own.plugins.map((id) => [id, { enabled: false }])) } : {}),
            }
          : {}),
        features: {
          // Let Codex ask the human questions (shown as a question card in the chat), not only in Plan mode.
          default_mode_request_user_input: true,
          // Lean: no ChatGPT app connectors (Codex drops its whole codex_apps MCP server), and no goal tools.
          ...(lean ? { apps: false, goals: false } : {}),
          // Helper agents keep the chat's model and effort: Codex's newer helper system leaves the choice out of its
          // spawn tool, so a helper inherits the chat's exact model and effort, Ultra included (Codex reads this only
          // under features). The older system still offers it, so a helper started otherwise stops the reply
          // (helperMismatch).
          ...(spawnOverridesHidden && helperSettings && !lean ? { multi_agent_v2: { expose_spawn_agent_model_overrides: false } } : {}),
        },
        // Lean: no helper agents at all (their tools are a 10 KB namespace a small model can't use anyway), so no roles to
        // hold them to a model either. Otherwise Codex's helper roles are replaced by ones that set the model (the one
        // picked for helpers, else the chat's) and the chat's effort: a role that sets them can't be changed by the agent
        // when it spawns a helper.
        ...(lean ? { agents: { enabled: false } } : chat?.ephemeral ? {} : { agents: { ...this.writeRoles(this.helperModel() ?? model, helperEffort ?? this.chatEffort()), ...(helperSettings ? this.helperDefaults(helperEffort) : {}) } }),
      };
      return {
        config,
        developerInstructions: [chat?.notes, chat?.helper?.note, lean ? null : helperNote("codex", this.helperModel(), !chat?.ephemeral), alongsideNote("codex", room, { ephemeral: chat?.ephemeral, lean }), chat?.ephemeral ? null : CODEX_QUESTION_NOTE].filter(Boolean).join("\n\n"),
      };
    };
    const common = {
      cwd: room.cwd,
      approvalPolicy,
      sandbox,
      model,
      ...(await build(lean)),
    };
    // A thread whose lean settings Codex refuses is asked for again as an ordinary one (openThread), roles and all.
    const plainThread = async (params: Json): Promise<Json> => ({ ...params, ...(await build(false)) });
    // Only a thread Codex says is gone starts anew (the reply says so); any other resume error keeps it.
    let lost = false;
    if (this.threadId) {
      try {
        const resumed = await this.openThread(rpc, "thread/resume", { threadId: this.threadId, ...common }, plainThread);
        await this.rememberSettings(resumed, sink);
        return;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (!threadGone(why)) {
          // The app-server restarting, a timeout, a dropped connection: nothing says the thread isn't there. The session
          // keeps it, and this connection (which never resumed it) goes, so the next try resumes it again.
          log.warn(`couldn't resume thread ${this.threadId}, keeping it: ${why}`);
          if (this.rpc === rpc) this.rpc = null;
          void rpc.kill();
          throw new ResumeFailed();
        }
        log.warn(`thread ${this.threadId} is gone, starting a new one: ${why}`);
        lost = true;
      }
    } else if (typeof this.ctx.session.forkFrom === "string" && this.ctx.session.forkFrom) {
      await this.fork(rpc, this.ctx.session.forkFrom, common, sink, plainThread);
      return;
    }
    const res = await this.openThread(rpc, "thread/start", { ...common, serviceName: "crosstalk", ...(chat?.ephemeral ? { ephemeral: true } : {}) }, plainThread);
    this.threadId = res.thread.id;
    await this.rememberSettings(res, sink);
    sink.saveSession({ threadId: this.threadId });
    // (A rewind's sink shows nothing.)
    if (lost) {
      sink.activity?.({
        kind: "notice",
        title: "Codex has lost this chat's earlier conversation",
        detail: "Codex couldn't find it (it was deleted, or its files moved), so this reply starts a new one. The messages above are all still here, but Codex doesn't remember them: tell it anything it needs to know.",
        status: "done",
      });
    }
  }

  /**
   * A chat's app-server: the Codex app's own when it's running (connectCodex), unless this chat's thread moved off it
   * and it still has the thread loaded. While anything else has the thread open there (the Codex app showing it, which
   * no client can see), a resume rejoins that copy, which misses what was said since and keeps the settings OpenAI
   * refused. So the chat goes on in an app-server of its own until that server lets the thread go, a minute after it was
   * last open. One that can't say what it has loaded counts as having it.
   */
  private async connect(): Promise<JsonRpc> {
    const opts = { cwd: this.ctx.room.cwd, env: this.ctx.env };
    const rpc = await connectCodex(this.bin, opts);
    // A lean chat goes on in an app-server of its own. The Codex app's shared server keeps a thread it already has loaded
    // as it was set up, whatever a resume says, so joining it can leave the person's whole catalogue on this thread --
    // which is the one thing lean exists to prevent, and nothing in a resume's answer would say it had happened.
    //
    // Only once that server's own Codex is one that takes the lean settings, which is why this waits for its `initialize`
    // (its version can differ from the installed CLI's: the Codex app brings its own). An older one would keep the whole
    // catalogue on a thread of its own just the same, so leaving the shared server would cost the chat being live in the
    // Codex app and buy nothing; the adapter leaves what doesn't fit out of each request either way.
    if (rpc instanceof SocketRpc && this.wantsLean() && takesLeanTools(serverVersions.get(rpc) ?? null) !== false) {
      log.info("this chat's model holds too little for the person's own Codex plugins, so it goes on in a Codex app-server of its own (the Codex app's server would keep a thread it has loaded as it was set up)");
      void rpc.kill();
      return startCodexServer(this.bin, opts);
    }
    const moved = this.ownServerThread;
    if (!moved || moved !== this.threadId || !(rpc instanceof SocketRpc)) return rpc;
    const loaded = await loadedThreads(rpc).catch((e) => {
      log.info(`couldn't ask the Codex app's server which threads it has loaded: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (loaded && !loaded.has(moved)) {
      log.info(`the Codex app's server has let thread ${moved} go: this chat goes on there again`);
      return rpc;
    }
    log.info(`the Codex app's server may still have thread ${moved} as it was before this chat moved off it: the chat goes on in a Codex app-server of its own`);
    void rpc.kill();
    return startCodexServer(this.bin, opts);
  }

  /**
   * Starts, resumes or forks this chat's thread. A Codex that refuses the whole config over settings it doesn't know the
   * shape of (an older one, or one that didn't say its version) is asked again without that group of them, newest group
   * first (CONFIG_GROUPS), and they're left out from then on: an unknown Codex never costs the chat its reply.
   *
   * Matching Codex's wording only picks **which** group goes first. A refusal in words no build has used yet still gives up
   * the lean settings and tries once more, because they are optional by construction (they only take tools away, and the
   * adapter leaves what doesn't fit out of each request regardless) — otherwise a Codex update that reworded one message
   * would stop every chat on a small model of your own from starting, resuming or forking at all. Only a refusal Codex
   * actually answered with counts (unreadRefusal): a timed-out or closed connection says nothing about the config, and nor
   * does a thread that is gone, so neither spends a second request.
   */
  private async openThread(rpc: JsonRpc, method: "thread/start" | "thread/resume" | "thread/fork", params: Json, plain?: (params: Json) => Promise<Json>): Promise<Json> {
    let sent = params;
    // Giving a group up: the lean settings are rebuilt as an ordinary thread (roles, helper note and all) rather than
    // subtracted, when the caller can; null when the params carry none of that group to begin with.
    const without = async (group: ConfigGroup, from: Json): Promise<Json | null> => {
      const stripped = group.strip(from);
      if (!stripped) return null;
      return group.flag === "noLeanTools" && plain ? await plain(from) : stripped;
    };
    for (const group of CONFIG_GROUPS) if (this[group.flag]) sent = (await without(group, sent)) ?? sent;
    let res: Json;
    for (let tries = 0; ; tries++) {
      try {
        res = await rpc.request<Json>(method, sent);
        break;
      } catch (e) {
        const left = tries < CONFIG_GROUPS.length ? CONFIG_GROUPS.filter((g) => !this[g.flag] && g.strip(sent)) : [];
        const named = left.find((g) => g.refused(e));
        const group = named ?? (unreadRefusal(e) ? left.find((g) => g.optional) : undefined);
        if (!group) throw e;
        const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
        const said = serverVersions.get(rpc) ?? "(it didn't say which version)";
        log.info(named ? `Codex ${said} refused ${group.what}, so this chat goes on without them: ${why}` : `Codex ${said} refused this thread's config in words no version of it is known to use, so this chat gives up ${group.what} and goes on without them: ${why}`);
        this[group.flag] = true;
        sent = (await without(group, sent))!;
      }
    }
    this.mayHideOverrides = !!sent.config?.features?.multi_agent_v2 || (rpc instanceof SocketRpc && method === "thread/resume");
    return res;
  }

  /**
   * A duplicated chat (duplicate.ts): its thread starts as a copy of the original's, up to the turn it was duplicated
   * after (the whole thread if that turn is gone), on the model the chat shows: "Default" is Codex's default now, not
   * the model the original happened to use.
   */
  private async fork(rpc: JsonRpc, from: string, common: Json, sink: TurnSink, plain?: (params: Json) => Promise<Json>) {
    sink.status("Copying the conversation", "thinking");
    const list = this.ctx.endpoint ? null : await modelList(rpc, 10_000).catch(() => null);
    const entry = (id: string | null) => list?.data?.find((m: Json) => (id ? m?.model === id || m?.id === id : m?.isDefault));
    let model = common.model;
    if (!model) {
      const def = entry(null);
      model = def ? String(def.model ?? def.id) : null;
    }
    const at = typeof this.ctx.session.forkAt === "string" && this.ctx.session.forkAt ? this.ctx.session.forkAt : null;
    const params = { threadId: from, ...common, model };
    let res: Json;
    try {
      res = await this.openThread(rpc, "thread/fork", at ? { ...params, lastTurnId: at } : params, plain);
    } catch (e) {
      if (!at) throw new Error(`couldn't copy the original conversation (${e instanceof Error ? e.message : e}). Start fresh from the chat's settings to go on without it.`);
      log.info(`couldn't fork thread ${from} at turn ${at}, forking all of it: ${e instanceof Error ? e.message : e}`);
      res = await this.openThread(rpc, "thread/fork", params, plain).catch((e2) => {
        throw new Error(`couldn't copy the original conversation (${e2 instanceof Error ? e2.message : e2}). Start fresh from the chat's settings to go on without it.`);
      });
    }
    this.threadId = res.thread.id;
    sink.saveSession({ threadId: this.threadId, forkFrom: null, forkAt: null });
    await this.rememberSettings(res, sink);
    // The copy keeps the original's per-turn settings; on "Default" effort it runs at the model's default, as shown.
    const own = this.ctx.member.config?.effort;
    const def = entry(this.threadModel)?.defaultReasoningEffort;
    if (!(typeof own === "string" && own) && typeof def === "string" && def && def !== this.threadEffort) {
      this.forkEffort = def;
      this.threadEffort = def;
      sink.saveSession({ effort: def });
      if (this.roleFiles && !this.ctx.chat?.ephemeral) this.writeRoles(this.helperModel() ?? this.threadModel, def);
    }
  }

  private async rememberSettings(response: Json, sink: TurnSink) {
    this.threadModel = response?.model ?? response?.thread?.model ?? null;
    this.threadEffort = response?.reasoningEffort ?? response?.thread?.reasoningEffort ?? null;
    if (!this.threadEffort && this.threadModel && !this.ctx.endpoint) {
      // An unset setting means the model's default, not permission for helpers to choose any effort.
      try {
        const list = await modelList(this.rpc!, 5000);
        const model = list?.data?.find((m: Json) => m.model === this.threadModel || m.id === this.threadModel);
        this.threadEffort = typeof model?.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null;
      } catch { /* Older app servers may not report the effective default. Explicit helper overrides are refused below. */ }
    }
    if (this.threadModel) sink.saveSession({ model: this.threadModel, modelRequested: this.ctx.member.model ?? null, effort: this.threadEffort });
    // Now that the thread says which model and effort "Default" means, the helper roles name them too.
    if (this.roleFiles && !this.ctx.chat?.ephemeral) this.writeRoles(this.helperModel() ?? this.threadModel, this.chatEffort());
  }

  /** The window long context gives `model` (null: Codex's default model): its catalog maximum, if it has a larger one. */
  private async longWindow(model: string | null): Promise<number | null> {
    const m = await this.ctx.modelInfo?.(model).catch(() => null);
    return m?.maxContextWindow && m.contextWindow && m.maxContextWindow > m.contextWindow ? m.maxContextWindow : null;
  }

  /**
   * Whether this chat is one that runs lean: a model on a server of your own with less room than the person's own Codex
   * setup needs, or a chat whose own setting says so either way (shared leanCodexTools). Once this chat's Codex has
   * refused those settings, no (it is older than they are, and the adapter still leaves what doesn't fit out).
   */
  private wantsLean(): boolean {
    return !this.noLeanTools && leanCodexTools(!!this.ctx.endpoint, this.ctx.endpoint?.contextWindow, this.ctx.member.config);
  }

  /** The model picked for this chat's helper agents, when it isn't the chat's own. */
  private helperModel(): string | null {
    const m = this.ctx.member.config?.helperModel;
    return typeof m === "string" && m.trim() ? m.trim() : null;
  }

  /**
   * With a model picked for helpers: the model and effort every helper starts with, including the copies of the whole
   * conversation Codex's newer helpers are by default (role files don't apply to those). Otherwise nothing: a helper
   * then inherits the chat's model and its effort for that turn.
   */
  private helperDefaults(onDefault: string | null): Json {
    const model = this.helperModel();
    if (!model) return {};
    const effort = this.memberEffort() ?? onDefault ?? this.chatEffort();
    return { default_subagent_model: model, ...(effort ? { default_subagent_reasoning_effort: effort } : {}) };
  }

  /**
   * The effort a thread on `model` (null: Codex's default model) runs at on Default, before it opens: what Codex said
   * last time while the chat is still on that model (a model change clears the session's model, not its effort), else
   * the model's own default.
   */
  private async defaultEffort(rpc: JsonRpc, model: string | null): Promise<string | null> {
    const s = this.ctx.session;
    if (typeof s.effort === "string" && s.effort && typeof s.model === "string" && (!model || s.model === model)) return s.effort;
    if (this.ctx.endpoint) return null;
    const list = await modelList(rpc, 10_000).catch(() => null);
    const entry = list?.data?.find((m: Json) => (model ? m?.model === model || m?.id === model : m?.isDefault));
    return typeof entry?.defaultReasoningEffort === "string" ? entry.defaultReasoningEffort : null;
  }

  /** The effort this chat runs at: the one picked, else the one Codex said the thread uses. */
  private chatEffort(): string | null {
    const e = this.ctx.member.config?.effort;
    return typeof e === "string" && e ? e : this.threadEffort ?? (typeof this.ctx.session.effort === "string" ? this.ctx.session.effort : null);
  }

  /** Writes the helper role files (readable only by this user) and returns the Codex config that uses them. */
  private writeRoles(model: string | null, effort: string | null) {
    const dir = join(RUN_DIR, "codex-roles");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = join(dir, this.ctx.member.id.replace(/[^\w-]/g, "_"));
    const files = { general: `${base}.toml`, awaiter: `${base}-awaiter.toml` };
    const text = codexRoleFiles(model, effort);
    writeFileSync(files.general, text.general, { mode: 0o600 });
    writeFileSync(files.awaiter, text.awaiter, { mode: 0o600 });
    this.roleFiles = files;
    return codexRoles(files.general, files.awaiter);
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    if (sink.signal.aborted) return { ok: false, error: "stopped" };
    // A stopped turn still winding down (perhaps a stuck app-server) when the next one starts: retire its app-server
    // now, so this turn starts a fresh one (resuming the thread) instead of waiting on it. Unless a helper or a command of
    // its works there: a private app-server takes them with it, so it's given the time a Stop gets to wind down
    // (interruptTurn ends it after that), and "Stop and answer my message" doesn't end the helper as well.
    const prev = this.active;
    if (prev && !prev.settled && !(prev.rpc instanceof SocketRpc) && !this.canEndWithItsWork()) {
      for (const end = Date.now() + STOP_WAIT_MS + 500; !prev.settled && !sink.signal.aborted && Date.now() < end; ) await Bun.sleep(20);
      if (sink.signal.aborted) return { ok: false, error: "stopped" };
    }
    if (prev && !prev.settled) {
      this.letGo(prev.rpc);
      prev.done({ ok: false, error: "stopped" });
    }
    try {
      await this.ensure(sink);
    } catch (e) {
      return { ok: false, error: startFailed(e, "Codex didn't start") };
    }
    if (sink.signal.aborted) return { ok: false, error: "stopped" };
    const rpc = this.rpc!;
    // Back on the Codex app's server (connect): its copy of the thread is the one that goes on. Noted here, not as Codex
    // starts: a rewind starts it with a sink that keeps nothing.
    if (this.ownServerThread && rpc instanceof SocketRpc) {
      this.ownServerThread = null;
      sink.saveSession({ ownServerThread: null });
    }
    let text = input.systemNote ? `${input.systemNote}\n\n---\n\n${input.prompt}` : input.prompt;
    // A thread the Codex app already has loaded keeps its old instructions when resumed, so a chat's standing notes
    // (like the computers it can reach) also go with the first message this driver sends. Not with an answer to Codex's
    // questions (its reply envelope): Codex's apps know one for an answer only as the whole message, so the notes wait
    // for the next message.
    const notes = [this.ctx.chat?.notes, this.leanThread ? null : helperNote("codex", this.helperModel(), !this.ctx.chat?.ephemeral), alongsideNote("codex", this.ctx.room, { ephemeral: this.ctx.chat?.ephemeral, lean: this.leanThread }), this.ctx.chat?.ephemeral ? null : CODEX_QUESTION_NOTE].filter(Boolean).join("\n\n");
    const answer = !input.systemNote && !!parseCodexQuestionReply(input.prompt);
    if (notes && !this.notesSent && input.prompt.trim() !== COMPACT_COMMAND && !answer) {
      text = `(Note from Crosstalk: ${notes})\n\n${text}`;
      this.notesSent = true;
    }
    // What its helpers left for this turn on an app-server that has gone since (this one never had it): said in words.
    if (this.leftAnswers.list.length && !this.onShared && this.leftAnswers.on !== rpc && input.prompt.trim() !== COMPACT_COMMAND && !answer) {
      text = `${leftAnswersWords(this.leftAnswers.list)}\n\n${text}`;
      this.leftAnswers = { on: null, list: [] };
    }
    const effort = this.memberEffort() ?? this.forkEffort;
    if (input.prompt.trim() !== COMPACT_COMMAND) this.forkEffort = null;
    // The effort (or model) may have changed since the thread started: helpers started by role get this turn's.
    if (this.roleFiles && !this.ctx.chat?.ephemeral) this.writeRoles(this.helperModel() ?? (this.ctx.member.model || this.threadModel), effort ?? this.chatEffort());
    return new Promise<TurnResult>((resolve) => {
      const active: ActiveTurn = { rpc, settled: false, turnId: null, sink, done: resolve, items: new Map(), lastAgentItem: null, usageStart: null, error: null, tail: "" };
      this.active = active;
      const finish = (r: TurnResult) => {
        if (active.settled) return;
        active.settled = true;
        if (this.active === active) this.active = null;
        for (const [key, it] of active.items) if (key.startsWith("reasoning-")) sink.updateActivity(it.activityId, { status: "done" });
        if (!r.ok) this.dropped(active);
        resolve(r);
      };
      active.done = finish;
      sink.signal.addEventListener("abort", () => void this.interrupt(), { once: true });
      if (input.prompt.trim() === COMPACT_COMMAND) {
        active.compact = true;
        sink.status("Compacting the conversation", "working");
        rpc.request<Json>("thread/compact/start", { threadId: this.threadId }).catch((e) => finish({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      rpc
        .request<Json>("turn/start", {
          threadId: this.threadId,
          input: [{ type: "text", text, text_elements: [] }],
          clientUserMessageId: input.turnId,
          turnTrigger: "crosstalk",
          ...this.turnOptions(effort),
        })
        .then((r) => {
          if (r?.turn?.id) {
            active.turnId = r.turn.id;
            // The app-server that holds what its helpers left gives it to this turn.
            this.answersTaken(rpc);
            this.noteOwnTurn(r.turn.id, sink);
            // Codex has the message in its thread now, whatever happens to the turn.
            sink.taken?.();
            if (active.stopping) void this.interruptTurn(active);
            if (!active.settled) this.noteRefs(input.messageIds, r.turn.id, sink);
          }
          if (!active.stopping && !active.settled) sink.status("Thinking", "thinking");
          // Codex added the message to the turn already running on the thread (the Codex app's, or one this chat left
          // waiting): what that turn asked is this reply's to show now.
          if (r?.turn?.id) this.takeParked(active);
        })
        .catch((e) => finish({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    });
  }

  /**
   * A failed turn's error, as the chat shows it. OpenAI can refuse a helper tool shaped otherwise than it expects for a
   * model ("reserved for use by this model"): Crosstalk then stops leaving the helper options out of threads set up
   * from then on (until the hub restarts), starts again the Codex of any chat whose thread may still leave them out, and
   * the chat says to try again. A chat on the Codex app's server moves to an app-server of its own, on the same thread:
   * while anything else has the thread open there (the Codex app showing it), that server keeps it as it was set up,
   * whatever a resume says, and it lets the thread go only a minute after it was last open. The chat goes back once it
   * has (connect).
   */
  /** Codex's newest rate-limit snapshot (raw): where a limit's reset time comes from. */
  private rateLimits: Json = null;

  /** Whether a Codex TurnError is a usage or rate limit that will reset (limits.ts), with when it comes back. */
  private limitOf(error: Json): LimitHit | null {
    if (!error) return null;
    return codexLimitHit({ info: error.codexErrorInfo, message: error.message, details: error.additionalDetails, snapshot: this.rateLimits });
  }

  private turnError(message: string, sink: TurnSink): string {
    if (!this.mayHideOverrides || !/reserved for use by this model/i.test(message)) return message;
    if (spawnOverridesHidden) {
      spawnOverridesHidden = false;
      log.warn(`OpenAI refused the spawn tool without model and effort, so threads set up from now on offer them: ${message}`);
    } else log.info("OpenAI refused the spawn tool without model and effort for a chat whose thread still left them out: starting its Codex again");
    const rpc = this.rpc;
    if (rpc instanceof SocketRpc && this.threadId) {
      this.ownServerThread = this.threadId;
      sink.saveSession({ ownServerThread: this.threadId });
      log.info(`the Codex app's server keeps thread ${this.threadId} as it loaded it while anything else has it open, whatever new settings say: this chat goes on in a Codex app-server of its own, on the same thread, until that server lets it go`);
    }
    this.mayHideOverrides = false;
    if (rpc) this.letGo(rpc);
    return "OpenAI didn't take the helper settings Crosstalk gives Codex for this model, so Crosstalk switched them off: send it again. (Helpers that start on another model or effort still stop the reply.)";
  }

  /** The effort picked for this chat, if any. */
  private memberEffort(): string | null {
    const e = this.ctx.member.config?.effort;
    return typeof e === "string" && e ? e : null;
  }

  /** What every turn/start carries. */
  private turnOptions(effort: string | null): Json {
    const { model, config } = this.ctx.member;
    return {
      // Per-turn overrides, so a resumed thread follows the member's current settings.
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      // Fast for this turn only, so the thread's own setting (seen in the Codex app) stays as it is.
      serviceTierForTurn: config?.fast === true ? CODEX_FAST_TIER : "default",
      // Ask for readable reasoning summaries; Codex doesn't always send them by default.
      summary: "concise",
    };
  }

  private onNotification(method: string, p: Json) {
    // Settings Codex ignored, and whatever else it warns a thread about. Nothing in the chat depends on either, but a
    // config key Codex renames or drops shows up here and nowhere else: without this, the person's whole tool catalogue
    // could come back on a Codex update and the only sign would be a slow chat. So an ignored setting is a warning and
    // the rest only noted (0.160 warns twice at every thread start: an under-development feature Crosstalk asks for, and
    // a model of your own it has no metadata for). Never `--strict-config`, which makes an ignored key stop the chat.
    const warned = threadWarning(method, p);
    if (warned) {
      if (method === "configWarning") log.warn(warned);
      else log.info(warned);
    }
    // Which commands are running, in any turn and any of its threads: one still running after its turn ended is a
    // background terminal.
    if ((method === "item/started" || method === "item/completed") && p?.item?.type === "commandExecution" && typeof p.item.id === "string") {
      if (method === "item/completed" || (p.item.status && p.item.status !== "inProgress")) this.terminals.delete(p.item.id);
      else this.terminals.set(p.item.id, String(p.item.command ?? ""));
    } else if (method === "turn/completed" && Array.isArray(p?.turn?.items)) {
      for (const it of p.turn.items) if (it?.type === "commandExecution" && typeof it.id === "string" && it.status && it.status !== "inProgress") this.terminals.delete(it.id);
    }
    if (method === "serverRequest/resolved") {
      // Codex settled one of its requests some other way (answered in the Codex app, or its turn moved on): its card goes.
      this.openRequests.get(String(p?.requestId))?.abort();
      return;
    }
    // An answer to questions Codex asked without waiting, said in this chat's thread in another app (the Codex app),
    // whether or not a reply of this chat's runs: their cards here close, once Codex has it (as Codex's apps take it).
    // This chat's own answers are closed already.
    if (method === "item/completed" && p?.item?.type === "userMessage" && this.threadId && p.threadId === this.threadId) {
      const replies = codexQuestionReplyOf(p.item.content);
      if (replies) this.ctx.questionsAnswered?.(Object.fromEntries(replies.map((r) => [r.questionItemId, r.answer])));
    }
    // Which helpers of this chat's thread work, and what they left for its next turn (helperTasks, leftAnswers).
    this.trackHelpers(method, p);
    const a = this.active;
    if (method === "thread/started" && p?.thread?.parentThreadId) {
      const owner = p.thread.parentThreadId === this.threadId ? a : this.helperOwners.get(p.thread.parentThreadId);
      if (owner) this.inspectHelper(owner, p.thread.id, p.thread);
      return;
    }
    // Events go by the thread they came from. This chat's own thread is never a helper's: what it sends is the reply's.
    const owner = p?.threadId && p.threadId !== this.threadId ? this.helperOwners.get(p.threadId) : undefined;
    if (owner) {
      if (method === "thread/settings/updated") this.inspectHelper(owner, p.threadId, p.threadSettings);
      if (method === "item/started" || method === "item/completed") this.checkHelperItem(owner, p.item, method === "item/started");
      if (method === "model/rerouted") {
        void this.stopHelper(owner, p.threadId);
        this.stopForModel(owner, rerouteError(p, true, !!this.ctx.chat), owner.turnId);
      }
      return;
    }
    if (method === "account/rateLimits/updated") {
      // Kept raw as well as mapped: a limit that stops a turn takes its reset time from these windows (limits.ts).
      if (p?.rateLimits) this.rateLimits = p.rateLimits;
      if (a) a.sink.rateLimit(codexUsage(p.rateLimits));
      return;
    }
    if (!a) {
      // A turn of this chat's thread ended with no reply running (one the Codex app ran on its server): see retired.
      if (method === "turn/completed" && p?.threadId === this.threadId) this.retire(p?.turn?.id);
      return;
    }
    // Codex took in a message steer handed over: it's read now, whatever becomes of its turn.
    if ((method === "item/started" || method === "item/completed") && p?.item?.type === "userMessage" && typeof p.item.clientId === "string") a.steered?.delete(p.item.clientId);
    const turnOf = (typeof p?.turnId === "string" && p.turnId) || (typeof p?.turn?.id === "string" && p.turn.id) || null;
    if (turnOf && this.retired.has(turnOf) && !(a.stopping && a.turnId === turnOf && method === "turn/completed")) return;
    if (a.stopping && method !== "turn/started" && method !== "turn/completed") return;
    if (method === "model/rerouted") {
      if (p?.threadId && p.threadId !== this.threadId) return;
      // OpenAI moved the reply (or a helper's) to another model: stop rather than answer on a model the user didn't pick.
      this.stopForModel(a, rerouteError(p, p?.threadId && p.threadId !== this.threadId, !!this.ctx.chat), p?.threadId === this.threadId ? turnOf : null);
      return;
    }
    if (p?.threadId && p.threadId !== this.threadId) return; // a subagent thread; ignore its stream
    if (!a.turnId && turnOf) {
      a.turnId = turnOf;
      this.takeParked(a);
      // Its turn is under way on this app-server: what its helpers left here went into it.
      this.answersTaken(a.rpc);
    }
    const sink = a.sink;
    switch (method) {
      case "turn/started":
        if (!a.turnId) a.turnId = p.turn?.id ?? null;
        if (a.stopping) void this.interruptTurn(a);
        break;
      case "thread/compacted":
        if (a.compact) a.done({ ok: true, text: "Compacted the conversation." });
        break;
      case "item/agentMessage/delta":
        this.splitIfNext(a);
        if (a.lastAgentItem && a.lastAgentItem !== p.itemId) this.separate(a);
        a.lastAgentItem = p.itemId;
        this.emitText(a, p.delta ?? "");
        break;
      case "item/started":
        this.itemStarted(a, p.item, turnOf);
        break;
      case "item/completed":
        this.checkHelperItem(a, p.item);
        if (a.stopping) break;
        this.itemCompleted(a, p.item);
        break;
      case "item/commandExecution/outputDelta": {
        const it = a.items.get(p.itemId);
        if (it) sink.updateActivity(it.activityId, { appendDetail: p.delta ?? "" });
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        sink.status("Thinking", "thinking");
        // Reasoning summaries stream per item; show them as a live "Thinking" step.
        const key = `reasoning-${p.itemId}`;
        let it = a.items.get(key);
        if (!it) {
          it = { activityId: sink.activity({ kind: "thinking", title: "Thinking", detail: "" }), item: { type: "__reasoning" } };
          a.items.set(key, it);
        }
        sink.updateActivity(it.activityId, { appendDetail: p.delta ?? "" });
        break;
      }
      case "turn/plan/updated": {
        const plan = (p.plan ?? []).map((s: Json) => `${s.status === "completed" ? "✓" : s.status === "inProgress" ? "▸" : "·"} ${s.step}`).join("\n");
        const existing = [...a.items.values()].find((x) => x.item?.type === "__plan");
        if (existing) sink.updateActivity(existing.activityId, { detail: plan });
        else {
          const id = sink.activity({ kind: "plan", title: "Plan", detail: plan, status: "done" });
          a.items.set(`plan-${id}`, { activityId: id, item: { type: "__plan" } });
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const total = p.tokenUsage?.total;
        if (!total) break;
        if (!a.usageStart) a.usageStart = { inputTokens: total.inputTokens - (p.tokenUsage.last?.inputTokens ?? 0), outputTokens: total.outputTokens - (p.tokenUsage.last?.outputTokens ?? 0), cachedInputTokens: total.cachedInputTokens - (p.tokenUsage.last?.cachedInputTokens ?? 0) };
        const last = p.tokenUsage.last;
        sink.usage({
          inputTokens: total.inputTokens - a.usageStart.inputTokens,
          outputTokens: total.outputTokens - a.usageStart.outputTokens,
          cachedInputTokens: total.cachedInputTokens - a.usageStart.cachedInputTokens,
          ...(last ? { contextTokens: last.totalTokens || (last.inputTokens ?? 0) + (last.outputTokens ?? 0) } : {}),
          ...(typeof p.tokenUsage.modelContextWindow === "number" ? { contextWindow: p.tokenUsage.modelContextWindow } : {}),
        });
        break;
      }
      case "error":
        if (!p.willRetry) {
          a.error = p.error?.message ?? "Codex reported an error";
          a.limit = this.limitOf(p.error);
          a.auth = a.limit ? null : codexAuthHit(p.error);
        } else sink.status(`Retrying: ${p.error?.message ?? "error"}`, "thinking");
        break;
      case "turn/completed": {
        const t = p.turn;
        // Whichever turn it was, it's over: what it still sends goes nowhere (retired).
        this.retire(t?.id);
        if (a.readNow && t?.id === a.readNow.turnId) {
          void this.afterReadNow(a, t);
          break;
        }
        if (t?.id && a.turnId && t.id !== a.turnId) break; // an earlier (stopped) turn finishing late
        const status = t?.status;
        // What it says it took in was read, and a finished turn has read everything handed to it (dropped: the rest).
        this.readIn(a, t);
        if (status === "completed") a.steered?.clear();
        if (a.stopping) a.done({ ok: false, error: a.error ?? "stopped" });
        else if (status === "completed") {
          // Where a copy of this chat would end (duplicate.ts), when it's duplicated after this reply.
          if (t?.id) sink.saveSession({ lastTurn: t.id });
          void Promise.all(a.checks ?? []).then(() => { if (!a.settled) a.done({ ok: true }); });
        }
        else if (status === "interrupted") a.done({ ok: false, error: "stopped" });
        else {
          const limit = this.limitOf(t?.error) ?? a.limit ?? null;
          // Its sign-in stopped working: the engine starts Codex again once (it reads auth.json afresh) and carries on. A
          // model server of your own has no ChatGPT sign-in to renew.
          const auth = limit || this.ctx.endpoint ? null : codexAuthHit(t?.error) ?? a.auth ?? null;
          a.done({ ok: false, error: this.turnError(t?.error?.message ?? a.error ?? `Turn ${status ?? "failed"}`, sink), ...(limit ? { limit } : {}), ...(auth ? { auth } : {}) });
        }
        break;
      }
    }
  }

  private emitText(a: ActiveTurn, t: string) {
    if (!t) return;
    a.tail = (a.tail + t).slice(-2);
    a.sink.text(t);
  }

  /** A message went in mid-turn and this is the first thing after it: the rest of the turn goes in a reply below it. */
  private splitIfNext(a: ActiveTurn) {
    if (!a.splitNext) return;
    a.splitNext = false;
    a.tail = "";
    a.lastAgentItem = null;
    a.sink.newReply?.();
  }

  /** Paragraph break between separate agent messages in one turn (without stacking blank lines). */
  private separate(a: ActiveTurn) {
    if (!a.tail || a.tail.endsWith("\n\n")) return;
    this.emitText(a, a.tail.endsWith("\n") ? "\n" : "\n\n");
  }

  private itemStarted(a: ActiveTurn, item: Json, turnId: string | null = null) {
    if (!item?.id) return;
    const sink = a.sink;
    if (item.type !== "userMessage") this.splitIfNext(a);
    switch (item.type) {
      case "commandExecution": {
        const id = sink.activity({ kind: "command", title: item.command ?? "command", detail: "" });
        a.items.set(item.id, { activityId: id, item });
        break;
      }
      case "fileChange": {
        const n = item.changes?.length ?? 0;
        const id = sink.activity({ kind: "file_change", title: n === 1 ? `Edit ${item.changes[0].path}` : `Edit ${n} files`, detail: fileChangeDetail(item.changes) });
        a.items.set(item.id, { activityId: id, item });
        break;
      }
      case "mcpToolCall": {
        const asked = item.server === "crosstalk" && typeof item.tool === "string" && item.tool.startsWith("ask_") ? (PROVIDER_INFO as Record<string, { name: string }>)[item.tool.slice(4)]?.name : undefined;
        const chats = item.server === "crosstalk" && typeof item.tool === "string" ? chatToolTitle(item.tool, item.arguments ?? {}) : null;
        const id = asked
          ? sink.activity({ kind: "tool", title: `Asked ${asked}: ${String(item.arguments?.question ?? "").slice(0, 120)}`, detail: String(item.arguments?.question ?? "") })
          : chats
            ? sink.activity({ kind: "tool", title: chats, detail: String(item.arguments?.text ?? item.arguments?.query ?? "") })
            : sink.activity({ kind: "tool", title: `${item.server}: ${item.tool}`, detail: JSON.stringify(item.arguments ?? {}, null, 2) });
        a.items.set(item.id, { activityId: id, item });
        break;
      }
      case "webSearch": {
        const id = sink.activity({ kind: "tool", title: `Web search${item.query ? `: ${item.query}` : ""}`, detail: "" });
        a.items.set(item.id, { activityId: id, item });
        break;
      }
      case "reasoning":
        sink.status("Thinking", "thinking");
        break;
      case "subAgentActivity":
        this.checkHelperItem(a, item);
        break;
      case "collabAgentToolCall": {
        if (!/spawn/i.test(String(item.tool ?? ""))) break;
        this.checkHelperItem(a, item, true);
        if (a.stopping) return;
        const prompt = String(item.prompt ?? "");
        const id = sink.activity({ kind: "tool", title: `Helper agent${prompt ? `: ${prompt.split("\n")[0].slice(0, 100)}` : ""}`, detail: prompt });
        a.items.set(item.id, { activityId: id, item });
        break;
      }
    }
    const step = a.items.get(item.id);
    if (step && step.item === item) (a.open ??= new Set()).add(step.activityId);
  }

  /**
   * How a helper Codex is starting differs from the chat's model or effort (null when it doesn't, or Codex didn't say).
   * `asked`: the spawn as it starts, which says what the agent asked for, not what the helper got: a spawn that names no
   * effort is said to be at "medium" (Codex's default) though the helper inherits the chat's. Its effort then waits for
   * the finished call or the helper's own thread.
   */
  private helperMismatch(item: Json, asked = false): string | null {
    const model = typeof item.model === "string" && item.model ? item.model : null;
    const value = item.reasoningEffort ?? item.reasoning_effort ?? item.effort;
    const effort = !asked && typeof value === "string" && value ? value : null;
    // The model picked for helpers, else the chat's own.
    const chatModel = this.helperModel() ?? (this.ctx.member.model || this.threadModel);
    const chatEffort = typeof this.ctx.member.config?.effort === "string" && this.ctx.member.config.effort ? this.ctx.member.config.effort : this.threadEffort;
    if (model && chatModel && !sameModel(model, chatModel)) return `on ${model} instead of ${chatModel}`;
    if (effort && effort !== chatEffort) return `at ${effort} effort instead of ${chatEffort ?? "this chat's default effort"}`;
    return null;
  }

  private checkHelperItem(a: ActiveTurn, item: Json, started = false) {
    if (!item || !(item.type === "subAgentActivity" || item.type === "collabAgentToolCall" && /spawn/i.test(String(item.tool)))) return;
    // A subAgentActivity names the agent a step was done to (agentThreadId), not the one doing it (the event's thread):
    // a helper that messages the agent it works for (Codex's newer helpers, send_message to /root) names this chat's
    // own thread, which is no helper.
    const named: unknown[] = item.type === "subAgentActivity" ? [item.agentThreadId] : item.receiverThreadIds ?? [];
    const ids = named.filter((id): id is string => typeof id === "string" && !!id && id !== this.threadId);
    for (const id of ids) if (!this.helperOwners.has(id)) this.inspectHelper(a, id);
    const wrong = this.helperMismatch(item, started && item.type === "collabAgentToolCall");
    if (wrong) {
      for (const id of ids) void this.stopHelper(a, id);
      this.stopForModel(a, this.helperError(wrong), a.turnId);
    }
  }

  private helperError(wrong: string) {
    return `Codex started a helper agent ${wrong}, so Crosstalk stopped this reply. Helpers use ${this.helperModel() ? "the model picked for them" : "this chat's model"} at this chat's effort; pick another model for helpers in the model menu or the chat's settings.`;
  }

  private inspectHelper(a: ActiveTurn, id: string, settings?: Json) {
    if (id === this.threadId) return; // the chat's own thread: its events are the reply's (onNotification)
    this.helperOwners.set(id, a);
    (a.helpers ??= new Set()).add(id);
    const check = (async () => {
      try {
        const thread = settings ?? (await a.rpc.request<Json>("thread/read", { threadId: id, includeTurns: false }, 5000)).thread;
        if (!thread) return; // Older app servers can omit settings.
        const wrong = this.helperMismatch(thread);
        if (wrong) {
          await this.stopHelper(a, id);
          this.stopForModel(a, this.helperError(wrong), a.turnId);
        }
      } catch (e) { log.warn(`couldn't inspect helper ${id}: ${e}`); }
    })();
    (a.checks ??= []).push(check);
  }

  private async stopHelper(a: ActiveTurn, id: string) {
    try {
      const { thread } = await a.rpc.request<Json>("thread/read", { threadId: id, includeTurns: true }, 5000);
      for (const turn of thread?.turns ?? []) {
        if (turn.status === "inProgress") await a.rpc.request("turn/interrupt", { threadId: id, turnId: turn.id }, 5000);
      }
    } catch (e) { log.warn(`couldn't stop helper ${id}: ${e}`); }
  }

  /** Stops the reply because something answered (or would) on a model or effort the user didn't pick. */
  private stopForModel(a: ActiveTurn, error: string, turnId: string | null) {
    if (a.settled || a.stopping) return;
    log.warn(error);
    a.error = error;
    const id = turnId ?? a.turnId;
    if (id) this.retire(id);
    if (!a.turnId && id) a.turnId = id; // so the interrupt can name it
    for (const id of a.helpers ?? []) void this.stopHelper(a, id);
    void this.interruptTurn(a);
    a.done({ ok: false, error });
  }

  /** See retired. */
  private retire(id: unknown) {
    if (typeof id !== "string" || !id) return;
    this.retired.delete(id);
    this.retired.add(id);
    if (this.retired.size > 300) this.retired.delete(this.retired.values().next().value!);
  }

  /** Marks a streamed reasoning summary as finished. */
  private reasoningDone(a: ActiveTurn, itemId: string) {
    const it = a.items.get(`reasoning-${itemId}`);
    if (it) a.sink.updateActivity(it.activityId, { status: "done" });
  }

  private itemCompleted(a: ActiveTurn, item: Json) {
    if (!item?.id) return;
    const sink = a.sink;
    const it = a.items.get(item.id);
    if (it) a.open?.delete(it.activityId);
    switch (item.type) {
      case "reasoning": {
        // If no summary streamed, fall back to the summary on the completed item.
        const text = (item.summary ?? []).join("\n\n").trim();
        if (!a.items.has(`reasoning-${item.id}`) && text) {
          a.items.set(`reasoning-${item.id}`, { activityId: sink.activity({ kind: "thinking", title: "Thinking", detail: text, status: "done" }), item: { type: "__reasoning" } });
        }
        this.reasoningDone(a, item.id);
        break;
      }
      case "commandExecution":
        if (it) {
          const ok = item.exitCode === 0 || item.status === "completed";
          sink.updateActivity(it.activityId, {
            detail: item.aggregatedOutput ?? undefined,
            status: ok ? "done" : item.status === "declined" ? "error" : item.exitCode === null ? "done" : "error",
            title: item.exitCode && item.exitCode !== 0 ? `${item.command} (exit ${item.exitCode})` : item.command,
          });
        }
        break;
      case "fileChange":
        if (it) sink.updateActivity(it.activityId, { detail: fileChangeDetail(item.changes), status: item.status === "completed" ? "done" : item.status === "failed" || item.status === "declined" ? "error" : "done" });
        break;
      case "mcpToolCall": {
        if (it) {
          const text = Array.isArray(item.result?.content) ? item.result.content.filter((part: Json) => part?.type === "text" && typeof part.text === "string").map((part: Json) => part.text).join("\n").slice(0, 20000) : "";
          const error = item.error ? `Error: ${JSON.stringify(item.error)}`.slice(0, 20000) : "";
          sink.updateActivity(it.activityId, { status: item.error || item.result?.isError === true || item.status === "failed" ? "error" : "done", appendDetail: [text, error].filter(Boolean).map((part) => `\n\n${part}`).join("") });
        }
        break;
      }
      case "webSearch":
      case "collabAgentToolCall":
        if (it) sink.updateActivity(it.activityId, { status: item.status === "failed" ? "error" : "done" });
        break;
      case "contextCompaction":
        sink.activity({ kind: "notice", title: "Compacted the conversation", detail: "Older messages were summarized to free up the context window.", status: "done" });
        if (a.compact && !a.tail) this.emitText(a, "Compacted the conversation.");
        break;
      case "agentMessage": {
        // Questions the agent asked and went on without waiting for (request_user_input_async; the text lists them for
        // apps that can't show them): a card instead, answered whenever, the answer going to Codex as a message. A card
        // each, as Codex's apps take them one at a time: each answered (or left) on its own, only once you send it.
        const asked = item.delivery === "async" && sink.askLater ? codexAsyncQuestions(item) : [];
        if (asked.length) {
          for (const q of asked) sink.askLater!(q.question.slice(0, 200), [q]);
          break;
        }
        // Deltas already streamed; if none arrived (some models only send the final item), use the text.
        if (item.text && a.lastAgentItem !== item.id) {
          if (a.lastAgentItem) this.separate(a);
          a.lastAgentItem = item.id;
          this.emitText(a, item.text);
        }
        break;
      }
    }
  }

  private async onRequest(method: string, p: Json, id: number | string = ""): Promise<Json> {
    if (this.notOurs(method, p)) {
      // Left to the client it's for; let go once Codex says it's settled (what's sent then, Codex ignores). One of this
      // chat's own thread becomes a reply's of this chat's if that reply joins its turn (parked).
      const key = String(id);
      const settled = this.openRequest(id);
      return new Promise<Json>((answer, fail) => {
        if (this.rpc instanceof SocketRpc && p?.threadId === this.threadId) this.parked.set(key, { method, params: p, settled, answer, fail });
        settled.signal.addEventListener("abort", () => {
          if (this.parked.get(key)?.settled === settled) this.parked.delete(key);
          try {
            answer(refusal(method));
          } catch (e) {
            fail(e);
          }
        }, { once: true });
      });
    }
    const a = this.active;
    if (!a) {
      if (method.endsWith("requestApproval")) return method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "cancel" };
      throw new Error(`no active turn for ${method}`);
    }
    const sink = a.sink;
    switch (method) {
      // "Always allow" covers exactly what its button says: that command, those files. Anything else is asked about.
      case "item/commandExecution/requestApproval": {
        const command = typeof p.command === "string" ? p.command : null;
        // Only a plain command: not input typed into a terminal that's running, network access, or more permissions.
        const plain = !!command && (p.kind === undefined || p.kind === null || p.kind === "command") && !p.networkApprovalContext && !(Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length) && !p.additionalPermissions;
        const key = plain ? codexCommandKey(command!, p.cwd, p.environmentId) : null;
        if (key && this.allowed("allowCommands").has(key)) return { decision: "accept" };
        const d = await this.askApproval(id, sink, {
          kind: "command",
          title: p.command ?? "Run a command",
          detail: [p.reason, p.networkApprovalContext?.host ? `Network access to ${p.networkApprovalContext.host}` : null, p.cwd ? `in ${p.cwd}` : null, p.command].filter(Boolean).join("\n"),
          always: key ? "Always allow this exact command" : null,
        });
        if (!d) return refusal(method);
        if (d === "approve_always" && key) this.rememberAlways("allowCommands", [key], sink);
        return { decision: decision(d) };
      }
      case "item/fileChange/requestApproval": {
        const it = a.items.get(p.itemId);
        const changes: Json[] | undefined = Array.isArray(it?.item?.changes) ? it.item.changes : undefined;
        // Only edits to files and new files: never a delete, a move, or write access under a whole folder.
        const plain = !!changes?.length && !p.grantRoot && changes.every((c) => typeof c?.path === "string" && (c.kind?.type === "add" || (c.kind?.type === "update" && !c.kind.move_path)));
        const paths: string[] = plain ? changes!.map((c) => c.path as string) : [];
        if (paths.length && paths.every((x) => this.allowed("allowFiles").has(x))) return { decision: "accept" };
        const d = await this.askApproval(id, sink, {
          kind: "file_change",
          title: changes?.length === 1 ? `Edit ${changes[0].path}` : changes?.length ? `Edit ${changes.length} files` : "Change files",
          detail: [p.reason, p.grantRoot ? `Wants write access under ${p.grantRoot}` : null, fileChangeDetail(changes)].filter(Boolean).join("\n\n"),
          always: paths.length === 1 ? `Always allow edits to ${basename(paths[0])}` : paths.length ? "Always allow edits to these files" : null,
        });
        if (!d) return refusal(method);
        if (d === "approve_always" && paths.length) this.rememberAlways("allowFiles", paths, sink);
        return { decision: decision(d) };
      }
      case "item/permissions/requestApproval": {
        const d = await this.askApproval(id, sink, {
          kind: "permission",
          title: p.reason ?? "Grant extra permissions",
          detail: JSON.stringify(p.permissions ?? {}, null, 2),
          always: "Always allow these permissions",
        });
        if (!d || d === "deny") return { permissions: {}, scope: "turn" };
        const granted: Json = {};
        if (p.permissions?.network) granted.network = p.permissions.network;
        if (p.permissions?.fileSystem) granted.fileSystem = p.permissions.fileSystem;
        return { permissions: granted, scope: d === "approve_always" ? "session" : "turn" };
      }
      case "item/tool/requestUserInput": {
        // Codex asks the human questions: show them in the chat and send back what was answered.
        const raw: Json[] = Array.isArray(p.questions) ? p.questions : [];
        const questions: AgentQuestion[] = raw.map((q, i) => ({
          id: String(q.id ?? i),
          header: String(q.header ?? ""),
          question: String(q.question ?? ""),
          options: Array.isArray(q.options) ? q.options.map((o: Json) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })) : [],
          multiSelect: false,
          // With no options, the only way to answer is to type one.
          allowOther: q.isOther === true || !Array.isArray(q.options) || q.options.length === 0,
          secret: q.isSecret === true,
        }));
        if (!questions.length || !sink.ask) return { answers: {} };
        const title = questions.length === 1 ? questions[0].header || questions[0].question : `${questions.length} questions`;
        // Codex can go on without an answer (isBlocking false, as in Default mode) a while after a device shows the card,
        // as its own apps do once it's on their screen, unless the user starts answering; in Plan mode (and on Codex
        // servers that don't say) it waits.
        const blocking = p.isBlocking !== false;
        const settled = this.openRequest(id);
        let answers: Record<string, string[]>;
        try {
          answers = (await sink.ask(title.slice(0, 200), questions, { autoResolveMs: blocking ? null : CodexDriver.optionalQuestionMs, signal: settled.signal })) ?? {};
        } finally {
          if (this.openRequests.get(String(id)) === settled) this.openRequests.delete(String(id));
        }
        const out: Record<string, { answers: string[] }> = {};
        for (const q of questions) if (answers[q.id]?.length) out[q.id] = { answers: answers[q.id] };
        return { answers: out };
      }
      case "mcpServer/elicitation/request": {
        // Codex asks before every MCP tool call. Turning teamwork (or reaching other chats) on already allowed those
        // tools, so say yes to them (Crosstalk asks the user itself when a message needs it) and no to anything else.
        const tool = /run tool "([^"]+)"/.exec(p.message ?? "")?.[1];
        const helper = this.ctx.chat?.helper;
        const ok =
          (helper && tool === `ask_${helper.provider}`) ||
          (this.ctx.crossChat && !this.ctx.chat?.ephemeral && !!tool && CHAT_TOOL_NAMES.includes(tool)) ||
          // A group chat's own tools only read it and post to it.
          ((!this.ctx.chat || !!this.ctx.chat.group) && !!tool && ROOM_TOOL_NAMES.includes(tool)) ||
          // It asks the user itself whenever their own message didn't name the model.
          (!this.ctx.chat?.ephemeral && tool === HELPER_TOOL);
        if (p.serverName === "crosstalk" && p._meta?.codex_approval_kind === "mcp_tool_call" && ok) {
          return { action: "accept", content: {}, _meta: null };
        }
        return { action: "decline", content: null, _meta: null };
      }
      default:
        throw new Error(`Unsupported request ${method}`);
    }
  }

  /** Codex adds input to the turn in progress ("steer"); it reads it at its next step. */
  async steer(text: string, messageIds?: string[]): Promise<boolean> {
    const a = this.active;
    if (!a || a.settled || a.stopping || !a.turnId || a.readNow || !this.rpc?.alive || !this.threadId) return false;
    // The id Codex names when it takes the message in (a userMessage item's clientId). Noted first: Codex may say so
    // before it answers the call.
    const id = `crosstalk-${crypto.randomUUID()}`;
    (a.steered ??= new Map()).set(id, { text, messageIds });
    try {
      await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: a.turnId, clientUserMessageId: id, input: [{ type: "text", text, text_elements: [] }] }, 15_000);
      a.splitNext = true;
      // Codex adds it to the running turn: rewinding to it goes back to before that whole turn.
      this.noteRefs(messageIds, a.turnId, a.sink);
      return true;
    } catch (e) {
      a.steered.delete(id);
      log.info(`couldn't add the message to Codex's turn: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /**
   * "Read it now": Codex takes in what steer handed over only at its next step. This stops the turn it's in; once it
   * has ended, the messages it hadn't taken in start its next turn (a stopped turn drops input it hadn't read), and that
   * turn's reply continues this one, so each message is answered once.
   */
  async readNow(): Promise<boolean> {
    const a = this.active;
    if (a?.readNow) return true;
    if (!a || a.settled || a.stopping || !a.turnId || !a.steered?.size || !this.rpc?.alive || !this.threadId) return false;
    const turnId = a.turnId;
    a.readNow = { turnId, timer: setTimeout(() => void this.readNowStuck(a), CodexDriver.readNowWaitMs) };
    a.readNow.timer.unref?.();
    try {
      await a.rpc.request("turn/interrupt", { threadId: this.threadId, turnId }, 10_000);
      return true;
    } catch (e) {
      if (a.readNow?.turnId !== turnId) return true; // it ended meanwhile, and goes on as asked
      clearTimeout(a.readNow.timer);
      a.readNow = undefined;
      log.info(`Codex didn't take "Read it now": ${e instanceof Error ? e.message : e}`);
      if (a.settled || !a.steered?.size) return false; // it has read it by now
      throw new Error("Codex didn't stop the step it's on");
    }
  }

  /** The turn "Read it now" stopped has ended: what it hadn't taken in starts the next one, inside the same reply. */
  private async afterReadNow(a: ActiveTurn, t: Json) {
    if (!a.readNow || a.stopping || a.settled) return;
    clearTimeout(a.readNow.timer);
    a.readNow = undefined;
    if (typeof t?.id === "string") this.retire(t.id);
    this.readIn(a, t);
    // The step it was stopped in (and anything else it was in the middle of) ended there.
    for (const id of a.open ?? []) a.sink.updateActivity(id, { status: "error" });
    a.open?.clear();
    if (t?.status === "completed") {
      // It finished before the stop landed: a finished turn has read everything handed to it.
      a.steered?.clear();
      if (t.id) a.sink.saveSession({ lastTurn: t.id });
      void Promise.all(a.checks ?? []).then(() => { if (!a.settled) a.done({ ok: true }); });
      return;
    }
    const handed = new Map(a.steered);
    const waiting = [...handed.values()];
    a.steered?.clear();
    const text = waiting.length ? `(Crosstalk stopped the step you were on so you could read this right away.)\n\n${waiting.map((w) => w.text).join("\n\n")}` : "(Crosstalk stopped the step you were on so you'd answer my last message right away. Answer it now.)";
    a.turnId = null;
    a.splitNext = true;
    a.sink.status("Reading your message", "thinking");
    try {
      const r = await a.rpc.request<Json>("turn/start", { threadId: this.threadId, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: `crosstalk-${crypto.randomUUID()}`, turnTrigger: "crosstalk", ...this.turnOptions(this.memberEffort()) });
      if (a.settled) return;
      if (r?.turn?.id) {
        a.turnId ??= r.turn.id;
        this.takeParked(a);
        this.noteOwnTurn(r.turn.id, a.sink);
        // They went in with this turn now: rewinding to them goes back to before it.
        for (const w of waiting) this.noteRefs(w.messageIds, r.turn.id, a.sink);
      }
    } catch (e) {
      // That turn never started: they're still unread (dropped).
      a.steered = handed;
      a.done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** What a turn's end lists as taken in has been read. */
  private readIn(a: ActiveTurn, t: Json) {
    for (const item of Array.isArray(t?.items) ? t.items : []) if (item?.type === "userMessage" && typeof item.clientId === "string") a.steered?.delete(item.clientId);
  }

  /**
   * A stopped or failed turn drops input it hadn't read, and nothing answers that by itself: Codex starts no turn of its
   * own. So what steer handed this turn and Codex never took in is the person's again, unread, with Answer now (takeUnread).
   */
  private dropped(a: ActiveTurn) {
    for (const w of a.steered?.values() ?? []) this.neverRead.push(...(w.messageIds ?? []));
    a.steered?.clear();
  }

  /** The human's messages (ids) steer handed a turn that dropped them (see dropped). */
  private neverRead: string[] = [];

  /** See AgentDriver.takeUnread. The reply is over for the hub, even if its turn hasn't said so yet (the hub won't wait for ever). */
  takeUnread(): string[] {
    if (this.active) this.dropped(this.active);
    return this.neverRead.splice(0);
  }

  /** Codex didn't stop its turn for "Read it now": its app-server is replaced, and the reply goes on there. */
  private async readNowStuck(a: ActiveTurn) {
    const rn = a.readNow;
    if (!rn || a.settled) return;
    log.info(`Codex didn't stop turn ${rn.turnId} for "Read it now"; replacing its app-server`);
    a.moving = true;
    this.letGo(a.rpc);
    try {
      await this.ensure(a.sink);
    } catch (e) {
      a.moving = false;
      a.readNow = undefined;
      a.done({ ok: false, error: startFailed(e, "Codex didn't restart") });
      return;
    }
    a.rpc = this.rpc!;
    a.moving = false;
    await this.afterReadNow(a, { id: rn.turnId, status: "interrupted", items: [] });
  }

  /**
   * Helpers of this chat's thread, from what Codex says of them: one starts (its thread/started names the chat's thread
   * as its parent, or the spawn on the chat's thread names it), works (its turns), and finishes (its turn/completed, its
   * last agentMessage the answer it gives the chat). One that finishes while no reply of this chat's runs leaves that
   * answer for the chat's next turn (leftAnswers). The chat's own turn starting on the app-server that holds them takes
   * them in.
   */
  private trackHelpers(method: string, p: Json) {
    const thread = typeof p?.threadId === "string" && p.threadId ? p.threadId : null;
    if (!this.threadId) return;
    if (method === "thread/started") {
      const t = p?.thread;
      if (t?.parentThreadId === this.threadId && typeof t.id === "string" && t.id !== this.threadId) this.helperStarted(t.id, t.agentNickname ?? t.agentPath ?? null);
      return;
    }
    if (thread === this.threadId) {
      const item = p?.item;
      if ((method === "item/started" || method === "item/completed") && item?.type === "subAgentActivity" && item.kind === "started" && typeof item.agentThreadId === "string" && item.agentThreadId !== this.threadId) this.helperStarted(item.agentThreadId, item.agentPath ?? null);
      if (method === "item/completed" && item?.type === "collabAgentToolCall" && /spawn/i.test(String(item.tool)) && Array.isArray(item.receiverThreadIds)) {
        for (const id of item.receiverThreadIds) if (typeof id === "string" && id !== this.threadId) this.helperStarted(id, null);
      }
      if (method === "turn/started") this.answersTaken(this.rpc);
      return;
    }
    const h = thread ? this.helperTasks.get(thread) : undefined;
    if (!h || !thread) return;
    if (method === "turn/started" && h.status !== "running") {
      Object.assign(h, { status: "running", endedAt: null });
      this.tellTasks();
    } else if (method === "item/completed" && p?.item?.type === "agentMessage" && typeof p.item.text === "string" && p.item.text.trim()) {
      h.answer = p.item.text.trim();
    } else if (method === "turn/completed") this.helperEnded(thread, p?.turn?.status, null);
  }

  private helperStarted(id: string, name: string | null) {
    const h = this.helperTasks.get(id);
    if (h?.status === "running") return;
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "Helper agent";
    this.helperTasks.set(id, { id, kind: "local_agent", description: h?.description ?? label, agentType: null, workflow: null, background: true, status: "running", startedAt: h?.startedAt ?? Date.now(), endedAt: null, tokens: null, toolUses: null, lastTool: null, summary: null, error: null, model: null, effort: null, contextTokens: null, contextWindow: null, answer: h?.answer ?? null });
    this.tellTasks();
  }

  /** A helper's turn ended (`status` as Codex says it). Its answer waits for the chat's next turn if no reply takes it in. */
  private helperEnded(id: string, status: unknown, answer: string | null) {
    const h = this.helperTasks.get(id);
    if (!h || h.status !== "running") return;
    if (answer) h.answer = answer;
    h.status = status === "failed" ? "failed" : status === "interrupted" ? "stopped" : "completed";
    h.endedAt = Date.now();
    const replying = !!this.active && !this.active.settled;
    if (h.status === "completed" && h.answer && !replying) {
      // A second answer from the same helper replaces its first in what's said (Codex queues both: the newest says more).
      const list = this.leftAnswers.list.filter((x) => x.thread !== id);
      this.leftAnswers = { on: this.rpc, list: [...list, { thread: id, name: h.description, text: h.answer }] };
      log.info(`a helper of this chat's Codex thread finished with no reply running: its answer waits for the chat's next turn`);
    }
    this.tellTasks();
  }

  /** The chat's turn started on `rpc`: if that's the app-server holding what its helpers left, it has taken that in. */
  private answersTaken(rpc: JsonRpc | null) {
    if (rpc && this.leftAnswers.on === rpc) this.leftAnswers = { on: null, list: [] };
  }

  /** The app-server went: its helpers ended with it, and nothing is left to report that. The chat says what was lost. */
  private helpersGone() {
    const lost: BackgroundTask[] = [];
    for (const h of this.helperTasks.values()) {
      if (h.status !== "running") continue;
      Object.assign(h, { status: "stopped", endedAt: Date.now(), error: "Stopped when Codex's app-server ended." });
      const { answer: _answer, ...task } = h;
      lost.push(task);
    }
    if (!lost.length) return;
    this.ctx.onWorkLost?.(lost, 0);
    this.tellTasks();
  }

  /** This chat lets go of an app-server and goes on: a private one takes its helpers with it. */
  private letGo(rpc: JsonRpc) {
    if (this.rpc === rpc) {
      this.rpc = null;
      if (!(rpc instanceof SocketRpc)) this.helpersGone();
    }
    void rpc.kill();
  }

  /** Nothing would be lost with this app-server: no helper of its works, and no command it started still runs. */
  private canEndWithItsWork(): boolean {
    return this.terminals.size === 0 && ![...this.helperTasks.values()].some((t) => t.status === "running");
  }

  /**
   * The hub hears what its helpers do now; finished ones stay listed for half an hour. While one works with no reply
   * running, its thread is read every `helperPollMs`, so a helper whose end went unheard (an event lost on a reconnect)
   * never holds the chat's settings or its app-server for good.
   */
  private tellTasks() {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, t] of this.helperTasks) if (t.status !== "running" && (t.endedAt ?? 0) < cutoff) this.helperTasks.delete(id);
    this.ctx.onTasks?.([...this.helperTasks.values()].map(({ answer: _answer, ...t }) => ({ ...t })));
    const working = [...this.helperTasks.values()].some((t) => t.status === "running");
    if (working && !this.helperPoll) {
      this.helperPoll = setInterval(() => void this.pollHelpers(), CodexDriver.helperPollMs);
      (this.helperPoll as { unref?: () => void }).unref?.();
    } else if (!working && this.helperPoll) {
      clearInterval(this.helperPoll);
      this.helperPoll = null;
    }
  }

  private async pollHelpers() {
    const rpc = this.rpc;
    if (!rpc?.alive || (this.active && !this.active.settled)) return;
    for (const h of [...this.helperTasks.values()].filter((t) => t.status === "running")) {
      let turns: Json[];
      try {
        turns = ((await rpc.request<Json>("thread/read", { threadId: h.id, includeTurns: true }, 5000))?.thread?.turns ?? []) as Json[];
      } catch {
        // Not there any more (or not readable): it isn't working on anything this chat can wait for.
        this.helperEnded(h.id, "interrupted", null);
        continue;
      }
      const last = turns.at(-1);
      if (!last || last.status === "inProgress") continue;
      const said = (Array.isArray(last.items) ? last.items : []).filter((it: Json) => it?.type === "agentMessage" && typeof it.text === "string" && it.text.trim()).at(-1);
      this.helperEnded(h.id, last.status, said ? String(said.text).trim() : null);
    }
  }

  /**
   * What only this app-server holds that a process taking over must be told (AgentDriver.carryNote): its helpers' answers
   * queued for the chat's next turn, as words for that turn. Never on the Codex app's server, which keeps them for
   * whoever runs the thread's next turn there. `take`: handed over now, and forgotten here.
   */
  carryNote(take = false): string | null {
    const left = this.leftAnswers.list;
    if (!left.length || this.onShared) return null;
    if (take) this.leftAnswers = { on: null, list: [] };
    return leftAnswersWords(left);
  }

  /**
   * Ended when idle (Engine.endIdle) unless a turn is under way, a command it started still runs in the background, or a
   * helper of its thread still works (it would end with a private app-server).
   */
  canEndWhenIdle(): boolean {
    return !this.starting && (!this.active || this.active.settled) && this.canEndWithItsWork();
  }

  async interrupt() {
    const a = this.active;
    if (!a) return;
    await this.interruptTurn(a);
    // The turn's end says what it had taken in of what steer handed it: the hub asks what it never read as the reply ends
    // (takeUnread), and Codex says the turn ended just after it answers the interrupt.
    for (const end = Date.now() + STOP_WAIT_MS; !a.settled && a.steered?.size && Date.now() < end; ) await Bun.sleep(10);
  }

  private async interruptTurn(a: ActiveTurn) {
    // A Stop wins over "Read it now": nothing starts after the turn it stops.
    if (a.readNow) clearTimeout(a.readNow.timer);
    a.readNow = undefined;
    if (!a.rpc.alive) return;
    if (!a.stopping) {
      a.stopping = true;
      setTimeout(() => {
        if (a.settled) return;
        this.letGo(a.rpc);
        a.done({ ok: false, error: a.error ?? "stopped" });
      }, STOP_WAIT_MS).unref?.();
    }
    // A Stop pressed during turn/start is remembered until the server gives us the turn id.
    if (a.turnId && !a.interruptSent) {
      a.interruptSent = true;
      this.retire(a.turnId);
      await a.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: a.turnId }, 10_000).catch(() => {});
    }
  }

  /**
   * Whether a request is another client's to answer, not this chat's (the first answer from any client settles it for
   * all): a question of another thread; and on the Codex app's server, which opens each new thread to every client
   * connected to it (the Codex app's other conversations, other chats' threads), a request of a thread that's neither
   * this chat's nor one of its helpers', or of this chat's thread while no reply of this chat's runs (the Codex app's
   * own turn on it, or a turn left waiting when this chat's connection went: parked until a reply joins it). Until this
   * chat's thread is known (a new chat's thread/start isn't answered yet) none is its own: nothing can be asked on a thread
   * before then, so a request that names one is another client's.
   */
  private notOurs(method: string, p: Json): boolean {
    const thread = typeof p?.threadId === "string" && p.threadId ? p.threadId : null;
    if (!thread) return false;
    if (!this.threadId) return true;
    if (method === "item/tool/requestUserInput" && thread !== this.threadId) return true;
    if (!(this.rpc instanceof SocketRpc)) return false;
    if (thread === this.threadId) return !this.active || this.active.settled;
    return !this.helperOwners.has(thread);
  }

  /**
   * The reply runs turn `a.turnId` now (Codex added its message to the turn already running on the thread, or it took
   * the turn's id from the turn's events): what that turn asked while no reply of this chat's ran (parked) is the
   * reply's to show and answer.
   */
  private takeParked(a: ActiveTurn) {
    if (!a.turnId || a.settled || a.stopping || this.active !== a) return;
    for (const [key, x] of [...this.parked]) {
      if (x.params?.turnId !== a.turnId) continue;
      this.parked.delete(key);
      if (this.openRequests.get(key) === x.settled) this.openRequests.delete(key);
      this.onRequest(x.method, x.params, key).then(x.answer, x.fail);
    }
  }

  /**
   * An approval card for Codex's request `id`, until it's answered here or Codex settles the request some other way
   * (answered in the Codex app: serverRequest/resolved), which closes the card (null then: what's sent, Codex ignores).
   */
  private async askApproval(id: number | string, sink: TurnSink, req: ApprovalRequest): Promise<ApprovalDecision | null> {
    const settled = this.openRequest(id);
    const elsewhere = new Promise<null>((done) => settled.signal.addEventListener("abort", () => done(null), { once: true }));
    try {
      const d = await Promise.race([sink.approval(req, { signal: settled.signal }), elsewhere]);
      return settled.signal.aborted ? null : d;
    } finally {
      if (this.openRequests.get(String(id)) === settled) this.openRequests.delete(String(id));
    }
  }

  /** A request of Codex's that's open here until it's answered, or Codex settles it (serverRequest/resolved). */
  private openRequest(id: number | string): AbortController {
    const settled = new AbortController();
    this.openRequests.set(String(id), settled);
    settled.signal.addEventListener("abort", () => {
      if (this.openRequests.get(String(id)) === settled) this.openRequests.delete(String(id));
    }, { once: true });
    return settled;
  }

  /** The app-server that sent the open requests is gone: nothing waits for their answers any more. */
  private settleOpenRequests() {
    const open = [...this.openRequests.values()];
    this.openRequests.clear();
    for (const settled of open) settled.abort();
  }

  async dispose() {
    const rpc = this.rpc;
    this.rpc = null;
    this.settleOpenRequests();
    if (this.helperPoll) clearInterval(this.helperPoll);
    this.helperPoll = null;
    // Gone before the app-server is waited for: a replacement for this chat may write them again meanwhile.
    if (this.roleFiles) for (const f of Object.values(this.roleFiles)) rmSync(f, { force: true });
    this.roleFiles = null;
    await rpc?.kill();
  }
}

/**
 * What a helper (or several) left for the chat's next turn, for a Codex that never had it (CodexDriver.leftAnswers): its
 * own app-server queued it, and that app-server is gone. Each answer kept to 12,000 characters.
 */
export function leftAnswersWords(left: { name: string; text: string }[]): string {
  const one = left.length === 1;
  const said = left.map((a) => `${a.name}:\n${a.text.length > 12_000 ? `${a.text.slice(0, 12_000)}…(cut short)` : a.text}`).join("\n\n");
  return `(Note from Crosstalk: ${one ? "a helper agent of yours" : "helper agents of yours"} finished while no reply of yours was running. Codex keeps such an answer for your next turn, but Codex was started again since, so it never got to you. ${one ? "Here it is" : "Here they are"}, as ${one ? "the helper" : "they"} gave it:\n\n${said})`;
}

/** "No" in the shape each of Codex's requests is answered in. */
function refusal(method: string): Json {
  switch (method) {
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "cancel", content: null, _meta: null };
    default:
      if (method.endsWith("requestApproval")) return { decision: "cancel" };
      throw new Error(`not this chat's ${method}`);
  }
}

/**
 * Whether a thread/resume error says the thread is gone (Codex 0.160: "thread not found: <id>", "no rollout found for
 * thread id <id>"), not that Codex couldn't be reached (the app-server restarting, a timeout, a dropped connection), which
 * says nothing about the thread. Only a gone thread is started anew; the chat's history stays in the hub either way.
 */
export function threadGone(why: string): boolean {
  return /\b(?:(?:thread|conversation|session|rollout) not found|no (?:such (?:thread|conversation|session)|rollout found|thread found)|(?:can't|cannot|couldn't|could not) (?:find|locate) (?:the |this )?(?:thread|conversation|rollout))\b/i.test(why);
}

/** A thread/resume that failed without saying the thread is gone: the chat keeps its thread, and the reply offers Try again. */
class ResumeFailed extends Error {
  constructor() {
    super("Couldn't reach Codex to continue this chat. Try again.");
  }
}

/** What a failed start of Codex says (a resume that failed has plain words of its own). */
function startFailed(e: unknown, what: string): string {
  return e instanceof ResumeFailed ? e.message : `${what}: ${e instanceof Error ? e.message : e}`;
}

/** Why Codex moved a reply to another model, in words: the notification names both models and a reason code. */
export function rerouteError(p: Json, helper: unknown, chat = false): string {
  const from = typeof p?.fromModel === "string" ? p.fromModel : "the model you picked";
  const to = typeof p?.toModel === "string" ? p.toModel : "another model";
  const reason = typeof p?.reason === "string" && p.reason ? p.reason.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "";
  const who = helper ? "a helper agent's work" : "this reply";
  return `OpenAI moved ${who} from ${from} to ${to}${reason ? ` (${reason})` : ""}, so Crosstalk stopped it. The chat stays on ${from}: ${chat ? "tap Try again" : "send your message again"}, or pick another model.`;
}
