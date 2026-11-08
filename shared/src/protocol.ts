// Types shared by the hub and every client. The hub is the source of truth;
// clients mirror its state from REST snapshots plus WebSocket events.

export type Provider = "claude" | "codex" | "muse" | "gemini" | "antigravity" | "builtin" | "opencode" | "mock";

export const PROVIDERS: Provider[] = ["claude", "codex", "muse", "antigravity", "gemini", "builtin", "opencode", "mock"];

export interface ProviderInfo {
  id: Provider;
  name: string; // product name shown in the UI
  vendor: string;
  color: string; // badge color
  initials: string;
  defaultHandle: string; // suggested @handle
  docsUrl: string;
  usageUrl?: string;
}

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    color: "#D97757",
    initials: "Cl",
    defaultHandle: "claude",
    docsUrl: "https://code.claude.com/docs",
    usageUrl: "https://claude.ai/settings/usage",
  },
  codex: {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    color: "#10A37F",
    initials: "Cx",
    defaultHandle: "codex",
    docsUrl: "https://learn.chatgpt.com/docs/codex",
    usageUrl: "https://chatgpt.com/codex/settings/usage",
  },
  muse: {
    id: "muse",
    name: "Muse Code",
    vendor: "Meta",
    color: "#0866FF",
    initials: "Mu",
    defaultHandle: "muse",
    docsUrl: "https://dev.meta.ai/docs/muse-code",
    usageUrl: "https://dev.meta.ai/usage",
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity CLI",
    vendor: "Google",
    color: "#4285F4",
    initials: "Ag",
    defaultHandle: "antigravity",
    docsUrl: "https://antigravity.google/docs/cli/",
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    // Since June 18, 2026 Gemini CLI only serves paid Gemini API / Enterprise keys; others use Antigravity CLI.
    vendor: "Google · paid API keys",
    color: "#8E75F0",
    initials: "Ge",
    defaultHandle: "gemini",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
  },
  // Crosstalk's own agent (hub/src/agents/builtin.ts): no program to install or sign in to. It runs a chat on an AI service
  // directly (NanoGPT first), with tools of its own for commands, files and BrowserOS neo. Never listed among the agents
  // you start a chat with: it is picked as the way an AI service runs ("Use it with").
  builtin: {
    id: "builtin",
    name: "Crosstalk agent",
    vendor: "Built into Crosstalk",
    color: "#7C5CFF",
    initials: "Ct",
    defaultHandle: "agent",
    docsUrl: "https://github.com/channelramble/crosstalk-app#readme",
  },
  // OpenCode (hub/src/agents/opencode.ts): an open-source coding agent program, driven over ACP. Like Crosstalk's own agent
  // it runs a chat on an AI service (Refuseless first), adds no refusal rules of its own, and is picked as the way a service
  // runs ("Use it with"), never as an agent to start a chat with on its own. Unlike it, it has to be installed.
  opencode: {
    id: "opencode",
    name: "OpenCode",
    vendor: "Open source, from Anomaly",
    color: "#5B8DEF",
    initials: "Oc",
    defaultHandle: "opencode",
    docsUrl: "https://opencode.ai/docs",
  },
  mock: {
    id: "mock",
    name: "Test agent",
    vendor: "Crosstalk",
    color: "#8E8E93",
    initials: "T",
    defaultHandle: "tester",
    docsUrl: "",
  },
};

export type RoomMode = "direct" | "relay" | "roundrobin" | "lead" | "review";

/** The two ways a room can work. "direct" is shown as "Off" (its wire ID is kept for compatibility). */
export const ROOM_MODES: { id: RoomMode; label: string; help: string }[] = [
  { id: "review", label: "Build & review", help: "One agent builds, the other checks its work. They go back and forth on their own until the reviewer approves, then you get the result." },
  { id: "direct", label: "Off", help: "Your message goes to the default agent, or to whoever you @mention. Agents don't hand work to each other." },
];

/** Older rooms used lead, relay or round-robin; they all work like Off now. */
export function normalizeMode(mode: unknown): "review" | "direct" {
  return mode === "review" ? "review" : "direct";
}

export interface Upload {
  filename: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
  url: string;
}

export interface Room {
  id: string;
  name: string;
  cwd: string; // working directory on the hub machine
  mode: RoomMode;
  leadMemberId: string | null;
  maxHops: number; // agent-to-agent hand-offs allowed per human message
  rounds: number; // for round-robin
  parallel: boolean; // allow several agents to run at once (default: one at a time)
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** Set for a one-agent chat (the app's conversations); absent for older multi-agent rooms. */
  chat?: ChatInfo | null;
  /** Kept out of reach of other chats' agents (they can't find, read or message it). */
  privateFromAgents?: boolean;
  /** When an agent's reply last ended here (absent: none yet, or an older hub). */
  lastReplyAt?: number | null;
  /** Up to when the user has read it, on any device (POST /api/rooms/:id/read). Absent from older hubs. */
  readAt?: number | null;
  /** When it was pinned to the top of the chat list, on every device (POST /api/rooms/:id/pin). Absent: not pinned. */
  pinnedAt?: number | null;
  /**
   * Its place among the pinned chats, lowest first. The app picks the numbers, on one scale for all of a person's
   * machines, so a chat here can sit between two of another machine's. Set while pinned.
   */
  pinOrder?: number | null;
}

/** The agents the app offers chats with. */
export const CHAT_PROVIDERS = ["claude", "codex"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

/**
 * The agents an AI service can run on: Claude Code and Codex; Crosstalk's own agent, which talks to the service itself
 * (no agent program in between); and OpenCode, a program of its own that does too. Those last two are offered only where
 * the hub says they work (a service's check lists them, today for Refuseless and NanoGPT), and are never agents a chat
 * starts with on their own (CHAT_PROVIDERS).
 */
export const SERVICE_AGENTS = ["claude", "codex", "builtin", "opencode"] as const;
export type ServiceAgent = (typeof SERVICE_AGENTS)[number];
export const isServiceAgent = (p: unknown): p is ServiceAgent => (SERVICE_AGENTS as readonly unknown[]).includes(p);

/**
 * The agents that run only on an AI service: they have no sign-in or plan of their own, their accounts are the services
 * they run on, and every list of agents to start something with leaves them out.
 */
export const SERVICE_ONLY_AGENTS = ["builtin", "opencode"] as const;
export type ServiceOnlyAgent = (typeof SERVICE_ONLY_AGENTS)[number];
/**
 * The OpenCode this Crosstalk was checked against (hub/test/opencode-real.test.ts): what its Install puts on a machine, and
 * what the app compares a machine's own against. It moves when that check has been run against a newer one.
 */
export const OPENCODE_VERSION = "2.2.5";
export const isServiceOnlyAgent = (p: unknown): p is ServiceOnlyAgent => (SERVICE_ONLY_AGENTS as readonly unknown[]).includes(p);

/**
 * The agents that can't go back to an earlier message or take one in the middle of a reply: OpenCode has no form for
 * either over ACP (hub/src/agents/opencode.ts). So their chats offer neither, only changing what they haven't read yet.
 */
export const NO_REWIND_AGENTS = ["opencode"] as const;
export const isNoRewindAgent = (p: unknown): boolean => (NO_REWIND_AGENTS as readonly unknown[]).includes(p);
/** One-agent chats' agents that read a message sent with "Send now" at their next step, and can't be made to sooner. */
export const NO_READ_NOW_AGENTS = ["builtin"] as const;
export const isNoReadNowAgent = (p: unknown): boolean => (NO_READ_NOW_AGENTS as readonly unknown[]).includes(p);

/**
 * Where an agent that pays for every request and re-sends the whole conversation with each (Crosstalk's own agent, OpenCode
 * on an AI service) compacts a chat by itself: three quarters of a model's window is 786,000 tokens on a 1M model, which is
 * slow, costly per step and where these models' tool calls go wrong most, so a big window compacts no later than this.
 */
export const SERVICE_COMPACT_AT = 250_000;
export const serviceDefaultCompact = (window: number): number => Math.min(Math.floor(window * 0.75), SERVICE_COMPACT_AT);
/**
 * Where a chat on one of those agents really compacts by itself, to say so in the app (null: can't be told). OpenCode also
 * keeps at least 16,000 tokens free (`compaction.buffer`, hub/src/agents/opencode.ts), which comes first on a small window.
 */
export function serviceCompactPoint(provider: unknown, window: number | null | undefined): number | null {
  if (!window || !isServiceOnlyAgent(provider)) return null;
  const at = serviceDefaultCompact(window);
  if (provider !== "opencode") return at;
  // A window that small leaves no room for the buffer, and OpenCode goes by its own default.
  return window > 16_000 ? Math.min(at, window - 16_000) : null;
}

/** Where a chat started: in this app, or in one of the agents' own apps on the hub machine. */
export type ChatOrigin = "web" | "claude-app" | "claude-cli" | "codex-app";

export interface ChatInfo {
  /** A group chat's: its lead's kind of agent (what older apps show it as). */
  provider: Provider;
  origin: ChatOrigin;
  /**
   * A group chat: several agents (Room members), each with its own account, model and effort, who all read the whole
   * chat. Absent: a chat with one agent. Older hubs send no chat at all for these (they're rooms there).
   */
  group?: boolean;
}

/**
 * A conversation that lives in an agent's own app on the hub machine: a Claude Code session (desktop app or
 * terminal) or a Codex thread (Codex app, CLI or IDE). The app can continue it.
 */
export interface LocalSession {
  provider: ChatProvider;
  /** Claude Code session id, or Codex thread id. */
  id: string;
  title: string;
  cwd: string | null;
  updatedAt: number;
  source: Exclude<ChatOrigin, "web">;
  /** Open in another app right now (Claude Code), or running a turn (Codex): continuing would collide. */
  busy: boolean;
  /** The chat in this app that continues it, if there is one. */
  chatId: string | null;
}

export type PermissionMode = "ask" | "edits" | "auto" | "full";

export const PERMISSION_MODES: { id: PermissionMode; label: string; help: string }[] = [
  { id: "ask", label: "Ask first", help: "Commands and edits need your approval." },
  { id: "edits", label: "Auto-edit", help: "File edits run on their own; commands need approval." },
  { id: "auto", label: "Auto", help: "The agent's own safety checks decide; risky actions still ask." },
  { id: "full", label: "Full access", help: "Nothing asks. Only for throwaway folders." },
];

export type PermissionInfo = { label: string; short: string; help: string; tone: "" | "green" | "red" };

/** What a permission setting lets this agent do, in plain words. Mirrors how each driver launches its CLI. */
export function permissionInfo(provider: Provider, mode: PermissionMode): PermissionInfo {
  const label = PERMISSION_MODES.find((p) => p.id === mode)?.label ?? mode;
  if (provider === "codex") {
    switch (mode) {
      case "ask":
        return { label, short: "Read-only", tone: "", help: "Can read the project but can't change any files. Asks you before doing anything more." };
      case "edits":
        return { label, short: "Can edit", tone: "green", help: "Can edit files in the project folder. Asks you before running most commands." };
      case "auto":
        return { label, short: "Can edit & run", tone: "green", help: "Can edit files and run commands inside the project folder. Asks you before going outside it." };
      case "full":
        return { label, short: "Full access", tone: "red", help: "No sandbox and no questions: can change anything on the hub machine. Only for throwaway setups." };
    }
  }
  if (provider === "antigravity") {
    // Antigravity CLI can't send its permission prompts to Crosstalk, so these describe what it actually does.
    switch (mode) {
      case "ask":
        return { label, short: "Read-only", tone: "", help: "Can read files in the room's folder, but not edit, run commands or read elsewhere: Antigravity can't ask you for permission in Crosstalk. Good for reviewing." };
      case "edits":
      case "auto":
        return { label, short: "Can edit", tone: "green", help: "Edits files in the room's folder on its own, but can't run commands (not even ls) or read elsewhere: Antigravity can't ask you for permission in Crosstalk." };
      case "full":
        return { label, short: "Full access", tone: "red", help: "Nothing asks and nothing is checked: can edit files and run any command on the hub machine. Only for throwaway setups." };
    }
  }
  if (provider === "builtin") {
    // What the hub's own agent asks about (hub/src/agents/builtin.ts asks). Reads have no folder limit.
    switch (mode) {
      case "ask":
        return { label, short: "Asks first", tone: "", help: "Can read any file on the hub machine. Asks you before file edits, commands and the browser, except ones you've already allowed." };
      case "edits":
      case "auto":
        return { label, short: mode === "auto" ? "Auto" : "Can edit", tone: "green", help: "Edits files on its own, and can read any file on the hub machine. Asks you before commands and the browser, except ones you've already allowed." };
      case "full":
        return { label, short: "Full access", tone: "red", help: "Nothing asks and nothing is checked: can run any command on the hub machine. Only for throwaway setups." };
    }
  }
  if (provider === "opencode") {
    // The rules the hub writes for its chats (hub/src/agents/opencode.ts permissionRules).
    switch (mode) {
      case "ask":
        return { label, short: "Asks first", tone: "", help: "Can read the project. Asks you before reading elsewhere, and before file edits, commands, web fetches and the browser, except ones you've already allowed." };
      case "edits":
        return { label, short: "Can edit", tone: "green", help: "Edits files in the project on its own. Asks you before anything outside it, and before commands, web fetches and the browser." };
      case "auto":
        return { label, short: "Auto", tone: "green", help: "Edits files in the project and runs simple read commands (ls, cat, grep, git status, git diff, git log) on its own. Asks you before anything outside it, and before other commands, web fetches and the browser." };
      case "full":
        return { label, short: "Full access", tone: "red", help: "Nothing asks and nothing is checked: can run any command on the hub machine. Only for throwaway setups." };
    }
  }
  if (provider === "claude") {
    switch (mode) {
      case "ask":
        return { label, short: "Asks first", tone: "", help: "Can read the project. Asks you before file edits and commands, except ones you've already allowed." };
      case "edits":
        return { label, short: "Can edit", tone: "green", help: "Edits files on its own. Asks you before running commands." };
      case "auto":
        return { label, short: "Auto", tone: "green", help: "Works on its own. A built-in safety check reviews each action and stops ones that look risky, but it can miss things." };
      case "full":
        return { label, short: "Full access", tone: "red", help: "Nothing asks and nothing is checked: can run any command on the hub machine. Only for throwaway setups." };
    }
  }
  const generic = PERMISSION_MODES.find((p) => p.id === mode)?.help ?? "";
  const short = mode === "ask" ? "Asks first" : mode === "edits" ? "Can edit" : mode === "auto" ? "Auto" : "Full access";
  return { label, short, tone: mode === "full" ? "red" : mode === "ask" ? "" : "green", help: generic };
}

/** "waiting": its reply was stopped by a usage limit and carries on when that resets (LimitWait). */
export type MemberStatus = "idle" | "queued" | "thinking" | "working" | "approval" | "error" | "waiting" | "offline";

export interface Member {
  /** Concrete model pinned by the running session; read-only. */
  resolvedModel?: string;
  id: string;
  roomId: string;
  handle: string; // unique within the room, used for @mentions
  provider: Provider;
  model: string | null;
  role: string; // extra instructions for this agent
  permissionMode: PermissionMode;
  status: MemberStatus;
  statusDetail: string | null;
  config: Record<string, unknown>; // provider-specific extras (mock scripts, effort, ...)
  createdAt: number;
  position: number;
  /**
   * What the agent has read: the room's messages up to this Message.seq. A message of the user's past it is still
   * waiting for the agent (say, its reply failed before the agent got it). Absent from older hubs.
   */
  readSeq?: number;
  /**
   * The usage limit this agent waits for (status "waiting"), the same wait as its reply's (Turn.wait). The chat list
   * and its status line say when it comes back from this, in the reader's own clock: `statusDetail` holds the hub's own
   * wording of the same thing, for older apps and for the notification.
   */
  wait?: LimitWait | null;
  /**
   * Settings changed while the agent was busy, still waiting for its process to be replaced (HeldSettings): what waits,
   * and whether its helpers hold it. Absent when nothing waits, and from hubs of 0.6.1 or older.
   */
  held?: HeldSettings | null;
}

/**
 * Settings changed while an agent was busy wait for its process to be replaced (engine.ts memberChanged): once its reply
 * ends and, while its background helpers run (`helpers`), once they finish. `change` says what waits. "settings" is a new
 * model, effort or fast mode (or looser permissions): the process as it is may answer around it, and while its helpers
 * work your messages go on by themselves (HubInfo.messagesFlow; with that off, or on an older hub, they wait for the
 * helpers, and Send now and Answer now send one sooner). "account" (a switch, or a fresh session for one), "permissions"
 * (tighter ones) and "other" (its folder, its tools, a copy to continue in…) never: a message waits for them, helpers and
 * all, with HubInfo.messagesFlow on or off.
 * `owed`: the agent's process is about to answer something by itself first (engine.ts owedTurn): its helpers' "report",
 * or a "message" Send now handed its last reply as that ended. Under "settings" it answers that in a reply of its own,
 * with the settings it started with; under the others that reply is stopped before it does anything, and the agent
 * starts again with the new settings and carries on from it (an account switch's fresh session can't: the chat says
 * so). Absent when nothing is owed, and from hubs of 0.6.6 or older.
 */
export interface HeldSettings {
  change: HeldChange;
  helpers: boolean;
  owed?: "report" | "message";
}

export type HeldChange = "settings" | "account" | "permissions" | "other";

/** What waits, as the chat says it: "your account switch applies" ("…once its helpers finish"). */
export function heldWords(change: HeldChange): string {
  switch (change) {
    case "account":
      return "your account switch applies";
    case "permissions":
      return "your permission change applies";
    case "other":
      return "your changes apply";
    default:
      return "your new settings apply";
  }
}

export type AuthorKind = "human" | "agent" | "system";

export interface Message {
  id: string;
  roomId: string;
  authorKind: AuthorKind;
  memberId: string | null; // for agents
  authorName: string; // device name for humans, handle for agents
  text: string;
  mentions: string[]; // member ids
  turnId: string | null;
  status: "streaming" | "done" | "error" | "stopped";
  createdAt: number;
  updatedAt: number;
  /** Set when another chat's agent sent it (to this chat, through Crosstalk), not the user. */
  via?: MessageVia | null;
  /** Set on the lines a duplicated chat adds (at the top of the copy, and in the original), and on replies it copied. */
  copy?: MessageCopy | null;
  /** Its place in the room's order (compare with Member.readSeq). From newer hubs, in history and in live events. */
  seq?: number;
}

/** The most one message holds, in characters, attachments' lines included: the hub refuses a longer one. */
export const MESSAGE_MAX = 100_000;

/** Why a message that long didn't go, and what to do instead: the same words from the hub and in the app. */
export function messageTooLongWords(length: number): string {
  return `This message is ${length.toLocaleString("en-US")} characters long, and one message holds up to ${MESSAGE_MAX.toLocaleString("en-US")}. Attach it as a file instead, or make it shorter.`;
}

/**
 * A duplicated chat's lines and copied replies. "from": the copy's first line (copied from that chat). "to": the line
 * in the original (duplicated to that chat). "reply": a reply copied from a chat with another agent, which keeps the
 * name of the agent that wrote it.
 */
export interface MessageCopy {
  kind: "from" | "to" | "reply";
  /** The agent that wrote the reply, or the other chat's agent: "Claude Code", "Codex", or a custom model's name. */
  agent: string;
  /** Its kind of agent, for the avatar. */
  provider?: Provider | null;
  /** The other chat ("from" and "to"), opened with #/room/<chatId>. */
  chatId?: string | null;
  chatName?: string | null;
  /** The other chat's machine, when it's on another one. */
  machine?: string | null;
}

/** One message a duplicated chat brings along: the user's messages and the finished replies (no steps or tool output). */
export interface CopiedMessage {
  role: "user" | "agent";
  /** The user's messages: the device or app it was sent from. Replies: the agent's @handle. */
  authorName: string;
  text: string;
  createdAt: number;
  /** A reply: the agent that wrote it ("Claude Code", "Codex", or a custom model's name), and its kind. */
  agent?: string | null;
  provider?: Provider | null;
  /** A reply that was stopped before it finished. */
  stopped?: boolean;
  /** A message another chat's agent sent. */
  via?: MessageVia | null;
}

/** What a chat brings along when it's duplicated to another machine (GET /api/chats/:id/export). */
export interface ChatExport {
  /** `privateFromAgents`: the chat is kept from other chats' agents, so its copy is too (absent from older hubs). */
  chat: { id: string; name: string; provider: ChatProvider; agent: string; cwd: string; privateFromAgents?: boolean };
  machine: { id: string; name: string };
  messages: CopiedMessage[];
  /** Earlier messages left out to keep it a size another machine takes. */
  left?: number;
}

/** Where a duplicated chat goes and how its agent runs (POST /api/chats/:id/duplicate, POST /api/chats/duplicate). */
export interface DuplicateRequest {
  provider: ChatProvider;
  account: string;
  /** Empty or null: the agent's default. Always sent, so the copy runs exactly as the popup showed. */
  model: string | null;
  effort: string | null;
  helperModel: string | null;
  /** "same": the original's project folder (same machine only); "new": a new empty one. */
  folder: "same" | "new";
  name: string;
}

/** Where a message from another chat's agent came from. */
export interface MessageVia {
  hubId: string;
  /** The machine it came from, as this hub knows it. */
  machine: string;
  chatId: string;
  chatName: string;
  /** "Claude Code" or "Codex". */
  agent: string;
  /** How many messages have passed between agents since the user last wrote (1-3). */
  hop: number;
  /** "start": it started this chat. */
  kind: "message" | "start";
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null; // client-side estimate when the agent reports one
  /** How much of the model's context window the conversation fills after this turn, when the agent says. */
  contextTokens?: number | null;
  contextWindow?: number | null;
}

/**
 * Why a turn was queued: the human's message, a step of the build-and-review loop, or another agent's @mention.
 * In a Build & review room the builder's work is always reviewed, but a reviewer turn only continues the loop
 * (approve, or send issues back) when its origin is "loop".
 */
export type TurnOrigin = "human" | "loop" | "mention";

export interface Turn {
  id: string;
  roomId: string;
  memberId: string;
  triggerMessageId: string | null;
  replyMessageId: string | null;
  hop: number;
  chainId: string; // groups the turns that follow from one human message
  origin?: TurnOrigin | null; // null for turns recorded by older hubs
  status: "queued" | "running" | "done" | "error" | "stopped" | "waiting";
  error: string | null;
  usage: TurnUsage | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /**
   * A chat's running reply: the messages "Send now" handed to it that the agent hasn't read yet (it reads them once the
   * step it's on ends), and whether "Read it now" is stopping that step. Set by the hub while the reply runs.
   */
  unread?: string[] | null;
  readingNow?: boolean;
  /** Set while the reply waits for a usage limit to reset (status "waiting"); null once it has carried on or given up. */
  wait?: LimitWait | null;
}

export type ActivityKind = "command" | "file_change" | "tool" | "thinking" | "plan" | "notice";

export interface Activity {
  id: string;
  roomId: string;
  turnId: string;
  memberId: string;
  kind: ActivityKind;
  title: string;
  detail: string; // command output, diff, tool input, ...
  /**
   * Set when `detail` is only its start: the whole detail's length (JS string positions). Long details of finished
   * steps reach newer clients this way (see PROTOCOL_VERSION); GET /api/activities/:id has all of it.
   */
  detailLength?: number;
  status: "running" | "done" | "error";
  createdAt: number;
  updatedAt: number;
}

/**
 * What a client understands, sent as ?v= on /api/ws and /api/rooms/:id/history. 2: a step's changes stream as
 * "activity.delta" events, and finished steps' long details come shortened (Activity.detailLength). A client that
 * doesn't say is treated as 1 and gets whole steps, as before.
 */
export const PROTOCOL_VERSION = 2;

export type ApprovalKind = "command" | "file_change" | "tool" | "permission" | "question";

/** A question an agent asks you (Claude Code's AskUserQuestion, Codex's request for input), answered in the chat. */
export interface AgentQuestion {
  id: string;
  /** A short label, e.g. "Go public". */
  header: string;
  question: string;
  options: { label: string; description: string }[];
  /** More than one option may be picked. */
  multiSelect: boolean;
  /** You may type your own answer instead of picking. */
  allowOther: boolean;
  /** The answer is a secret (typed, not shown). */
  secret?: boolean;
  /** The option picked to start with (the one the agent recommends): sent only when you send the answer. */
  preselected?: string;
}
export type ApprovalDecision = "approve" | "approve_always" | "deny";

/** One answer to a question Codex asked without waiting (request_user_input_async), as Codex's apps send it back. */
export interface CodexQuestionReply {
  /** The question's id: `["request_user_input_async","<item id>",<index>]` as JSON (AgentQuestion.id). */
  questionItemId: string;
  question: string;
  answer: string;
}

const CODEX_REPLY_OPEN = "<send_user_message_question_reply>";
const CODEX_REPLY_CLOSE = "</send_user_message_question_reply>";

/** The first `max` bytes of `s` in UTF-8, cut between characters (Codex bounds a question's words this way). */
function utf8Head(s: string, max: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/**
 * The message that answers Codex's questions asked without waiting: the envelope its own apps send (the TUI's
 * AnsweredQuestion, codex-rs context-fragments), so Codex and the Codex app both know it for answers. A question is
 * sent as its first 512 bytes on one line.
 */
export function codexQuestionReply(replies: CodexQuestionReply[]): string {
  const list = replies.map((r) => ({ answer: r.answer, question: utf8Head(r.question, 512).replace(/[\n\r]/g, " "), questionItemId: r.questionItemId }));
  return `${CODEX_REPLY_OPEN}\n${JSON.stringify(list)}\n${CODEX_REPLY_CLOSE}`;
}

const CODEX_IDE_CONTEXT = "# Context from my IDE setup:\n";
const CODEX_IDE_REQUEST = "\n## My request for Codex:\n";

/**
 * The answers in a message that is Codex's answer envelope (codexQuestionReply, or one the Codex app sent), else null.
 * Read as Codex's apps read it (codex-rs tui async_question_reply): the whole message, or all of it after the IDE
 * context the Codex app can put first.
 */
export function parseCodexQuestionReply(text: string): CodexQuestionReply[] | null {
  let t = text.trim();
  if (t.startsWith(CODEX_IDE_CONTEXT)) {
    const at = t.lastIndexOf(CODEX_IDE_REQUEST);
    if (at < 0) return null;
    t = t.slice(at + CODEX_IDE_REQUEST.length).trim();
  }
  if (!t.startsWith(CODEX_REPLY_OPEN) || !t.endsWith(CODEX_REPLY_CLOSE)) return null;
  try {
    const raw: unknown = JSON.parse(t.slice(CODEX_REPLY_OPEN.length, -CODEX_REPLY_CLOSE.length));
    const list = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
    const ok = list.every((r) => r && typeof r === "object" && typeof r.questionItemId === "string" && typeof r.question === "string" && typeof r.answer === "string");
    return ok && list.length ? list.map((r) => ({ questionItemId: r.questionItemId as string, question: r.question as string, answer: r.answer as string })) : null;
  } catch {
    return null;
  }
}

/**
 * The answer `answers` (by questionItemId) give question `questionId` of Codex's (AgentQuestion.id), if any: by its own
 * id, or by the id of the message that asked it, as older Codex apps name the question they answer.
 */
export function codexAnswerTo(questionId: string, answers: Record<string, string>): string | undefined {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(answers, k);
  if (has(questionId)) return answers[questionId];
  try {
    const id: unknown = JSON.parse(questionId);
    if (Array.isArray(id) && id[0] === "request_user_input_async" && typeof id[1] === "string" && has(id[1])) return answers[id[1]];
  } catch {
    // not one of Codex's question ids
  }
  return undefined;
}

export interface Approval {
  id: string;
  roomId: string;
  memberId: string;
  turnId: string | null;
  kind: ApprovalKind;
  title: string;
  detail: string;
  status: "pending" | "approved" | "denied" | "expired";
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** kind "question": what's asked, and once answered, the answers by question id. */
  questions?: AgentQuestion[] | null;
  answers?: Record<string, string[]> | null;
  /**
   * "async": the agent asked and went on without waiting (Codex's request_user_input_async). The card outlives its
   * reply (and a restart) until it's answered or skipped, another message of yours goes to the agent, or the agent's
   * session is reset or rewound past it; your answer goes to the agent as a message.
   */
  delivery?: "async" | null;
  /**
   * A question the agent can go on without (Codex's non-blocking questions): how long it waits for an answer once a
   * device shows the card (POST /api/approvals/:id/seen starts that). Null once you've started answering (POST
   * /api/approvals/:id/hold), and for questions that wait.
   */
  autoResolveMs?: number | null;
  /**
   * When an agent that asked without needing the answer goes on without one, unless you answer first: set once a device
   * has shown the card (autoResolveMs after that); null until then, once you've started answering, and for questions
   * that wait.
   */
  autoResolveAt?: number | null;
  /**
   * What "Always allow" allows, in words, e.g. "Always allow `git status` commands": the agent doesn't ask for that again
   * in this chat. Null: this request can only be allowed once. Absent from older hubs (and agents that don't say).
   */
  always?: string | null;
}

/**
 * Something the user chose to always allow in a chat (GET /api/members/:id/always): the agent doesn't ask for it again
 * until it's removed (DELETE with its id), or the chat's permissions get stricter.
 */
export interface AlwaysAllowed {
  id: string;
  /** In words: "`git status` commands", "Edits to app.ts", "The exact command `make` (in /work/app)". */
  label: string;
}

export interface UsageWindow {
  label: string; // "5-hour", "Weekly", ...
  usedPercent: number | null;
  resetsAt: number | null; // epoch ms
}

export interface UsageSnapshot {
  provider: Provider;
  /** Which of this agent's accounts the numbers are for ("default" when missing). */
  accountId?: string;
  account: string | null;
  plan: string | null;
  windows: UsageWindow[];
  credits: string | null;
  note: string | null;
  updatedAt: number;
}

// ===================================================================== 0.5: carry on when a usage limit resets

/**
 * Where a waiting reply's reset time came from: the agent's own rate-limit event, its usage figures, a time in the
 * error text, an HTTP retry-after, or nothing said (then Crosstalk backs off instead of guessing a time).
 */
export type LimitSource = "event" | "snapshot" | "text" | "retry-after" | "none";

/**
 * A reply a plan or rate limit stopped, waiting for that limit to reset (Turn.wait, Turn.status "waiting"). Limits are
 * per account, so `provider` and `account` say whose: one account's limit never holds up another account's chats.
 */
export interface LimitWait {
  provider: Provider;
  /** Which account (memberAccount): "default" is the agent's own sign-in. */
  account: string;
  /** What to call that account when it isn't the default one ("Work"). */
  accountLabel?: string | null;
  /** A plan's usage limit (out of messages until it resets), or a rate limit (too many requests just now). */
  kind: "usage" | "rate";
  /** Which limit, in the agent's own words ("5-hour", "Weekly"), or null when it didn't say. */
  label: string | null;
  /** When the limit comes back (epoch ms), or null when nothing said it. */
  resetsAt: number | null;
  /** When Crosstalk carries on (epoch ms): the reset plus a small margin, or a backing-off wait when nothing said. */
  runAt: number;
  /** How many times this reply has been stopped by the limit (1 the first time). */
  tries: number;
  /** When the first try was stopped: the whole wait is capped from here. */
  since: number;
  source: LimitSource;
  /** Messages the agent already had in its conversation when it was stopped (the hub delivers them again). */
  had?: number;
}

/** A reset time in the reader's own clock: "3:20 PM", or "Tue 3:20 PM" when it isn't today. */
export function limitResetTime(resetsAt: number, now = Date.now()): string {
  const at = new Date(resetsAt);
  const today = new Date(now).toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** The agent a wait is about, in words: "Claude Code", or "Claude Code (Work)" for a second account. */
export function limitAgentWords(wait: Pick<LimitWait, "provider" | "account" | "accountLabel">): string {
  const name = PROVIDER_INFO[wait.provider]?.name ?? "The agent";
  const label = wait.account !== DEFAULT_ACCOUNT ? wait.accountLabel || null : null;
  return label ? `${name} (${label})` : name;
}

/** A reset this close counts as now: the words say "any moment" rather than a time that has just gone. */
const RESET_NOW_MS = 30_000;

/**
 * The one sentence a waiting reply gets, the same in the chat, the chat list, the agent's status line and the
 * notification: "Claude Code is out of messages until 3:20 PM. It'll carry on then." With no known reset time it says
 * "soon" rather than a wrong time.
 */
export function limitWaitWords(wait: Omit<LimitWait, "runAt" | "tries" | "since" | "source">, now = Date.now()): string {
  const out = `${limitAgentWords(wait)} ${wait.kind === "rate" ? "has hit a rate limit" : "is out of messages"}`;
  if (wait.resetsAt && wait.resetsAt > now + RESET_NOW_MS) return `${out} until ${limitResetTime(wait.resetsAt, now)}. It'll carry on then.`;
  if (wait.resetsAt) return `${out}. It'll carry on any moment.`;
  return `${out} until its limit resets. It'll carry on soon.`;
}

/** What the waiting reply says once the chat has picked itself back up. */
export function limitCarriedOnWords(wait: Pick<LimitWait, "label">): string {
  return `Waited for the ${wait.label ? `${wait.label} ` : ""}limit to reset, then carried on.`;
}

/** "Don't wait": the reply becomes a plain failed one, saying what happened and the way on. */
export function limitDontWaitWords(wait: Omit<LimitWait, "runAt" | "tries" | "since" | "source">, now = Date.now()): string {
  const when = wait.resetsAt && wait.resetsAt > now + RESET_NOW_MS ? ` It comes back at ${limitResetTime(wait.resetsAt, now)}.` : "";
  return `${limitAgentWords(wait)} ${wait.kind === "rate" ? "has hit a rate limit" : "is out of messages"}.${when} Crosstalk isn't waiting for it. Tap Try again when you want it to carry on.`;
}

/**
 * Crosstalk has waited as long as it will: the reply fails, in plain words, with Try again as the way out. `waited`:
 * how many times it did wait (0 when the reset was more than a day out, so it never started).
 */
export function limitGaveUpWords(wait: Omit<LimitWait, "runAt" | "tries" | "since" | "source">, waited: number, now = Date.now()): string {
  const when = wait.resetsAt && wait.resetsAt > now + RESET_NOW_MS ? ` It comes back at ${limitResetTime(wait.resetsAt, now)}.` : "";
  const tried = waited > 0 ? `Crosstalk waited ${waited === 1 ? "once" : `${waited} times`} and stopped trying.` : "Crosstalk doesn't wait more than a day, so it didn't wait.";
  return `${limitAgentWords(wait)} ${wait.kind === "rate" ? "keeps hitting a rate limit" : "is out of messages"}.${when} ${tried} Tap Try again when you want it to carry on.`;
}

/**
 * A message of yours that waited behind a reply the limit then stopped: when it goes. "Paused until your usage limit
 * resets at 8:10 PM. Your message goes first when it does." The reply that carries on reads it (it was never marked
 * read), so nothing can send it sooner: there is no quota to send it with. Same times as limitWaitWords.
 */
export function limitQueuedWords(wait: Pick<LimitWait, "kind" | "resetsAt">, now = Date.now()): string {
  const which = wait.kind === "rate" ? "the rate limit" : "your usage limit";
  const when = wait.resetsAt && wait.resetsAt > now + RESET_NOW_MS ? ` at ${limitResetTime(wait.resetsAt, now)}` : wait.resetsAt ? ", any moment now" : "";
  return `Paused until ${which} resets${when}. Your message goes first when it does.`;
}

/**
 * Why "Send now" (POST /api/rooms/:id/send-now) didn't send your waiting message into the agent's reply:
 * - "limit": no reply runs: it waits for a usage limit to reset (`wait`), and the reply that carries on reads it first.
 * - "helpers": no reply runs: what you changed (`held`: an account switch, tighter permissions…) waits for the agent's
 *   helpers to finish, and your message with it. A hub with HubInfo.messagesFlow off, or without it, says this under
 *   "settings" too, where sending again with `currentSettings` answers it now, with the settings the agent started with;
 *   with it on the hub has answered it already, and ignores `currentSettings`.
 * - "settings": a reply runs, but what waits behind it (`held`: an account switch, tighter permissions…) mustn't be
 *   answered around: your message goes once that reply (and its helpers) are done, on the new settings.
 * - "answering": the reply that's running has your message already.
 * - "nothing": no message of yours is waiting for this agent.
 * - "ended": the reply ended as it was handed over: your message starts the next one.
 * - "notYet": the reply is running but can't take a message this moment (it's still starting): try again shortly.
 * - "ownTurn": no reply runs, but the agent is about to answer by itself what it owes (`held.owed`: its helpers' report,
 *   or a message Send now handed its last reply), with the settings it started with, while a new model or the like waits
 *   (`held`): your message can go into that reply once it starts, else it waits for it and goes on the new settings.
 *   Only around "settings": under an account switch or tighter permissions it's "helpers". Newer than 0.6.6.
 * - "unsupported": this agent can't take a message in the middle of this reply (or any); it reads it once the reply ends.
 */
export type SendNowWhy = "limit" | "helpers" | "settings" | "answering" | "nothing" | "ended" | "notYet" | "ownTurn" | "unsupported";

export interface SendNowResult {
  sent: boolean;
  /** Set when it wasn't sent. Absent from older hubs. */
  why?: SendNowWhy;
  /** "limit": the wait, so each device says the reset in its own clock. */
  wait?: LimitWait;
  /** "helpers", "settings" and "ownTurn": what waits (newer than 0.6.1). */
  held?: HeldSettings;
}

export interface ProviderStatus {
  provider: Provider;
  installed: boolean;
  version: string | null;
  binPath: string | null;
  signedIn: boolean | null; // null = unknown
  account: string | null;
  plan: string | null;
  authMethod: string | null;
  error: string | null;
  checkedAt: number;
}

/** A model an agent offers, as its own CLI reports it (Claude Code's /model list, Codex's model/list). */
export interface ModelOption {
  /** Concrete model behind a CLI alias, when supplied by its catalog. */
  resolvedModel?: string;
  id: string; // what the CLI takes, e.g. "opus" or "gpt-6.1-sol"
  label: string;
  description: string | null;
  efforts: string[]; // reasoning effort levels the model accepts; empty when it has none
  defaultEffort: string | null;
  isDefault: boolean; // what the agent uses when no model is set
  /** The model's faster (and costlier) way of running, when it has one. */
  fast?: { label: string; description: string | null } | null;
  /**
   * Tokens of context a chat on this model gets, as the agent itself says (Claude Code's /context, Codex's model
   * catalog, Muse's model list). Missing when the agent doesn't say.
   */
  contextWindow?: number | null;
  /** How much of `contextWindow` the conversation can fill, when the agent keeps the rest back (Codex keeps 5%). */
  usableContext?: number | null;
  /** Where the agent compacts a chat on this model by itself (tokens). */
  compactAt?: number | null;
  /** The most a chat on this model can be given (Codex's long context), when that's more than `contextWindow`. */
  maxContextWindow?: number | null;
  /** When Crosstalk first saw the agent offer this model (ms); 0 or missing: it was there before Crosstalk kept track. */
  firstSeen?: number;
  /**
   * The agent takes it but keeps it out of its usual list (Codex's hidden models; a custom model server's models not
   * saved with the account; the other Claude models an API key can use, from Anthropic's Models API): pickers show it
   * under More models. Missing: one of the usual ones.
   */
  more?: boolean;
  /**
   * The service says this model can't run tool calls (Venice's `supportsFunctionCalling: false`), so an agent on it
   * can't read files or run commands: pickers mark it "No tools". Missing: it can, or the service didn't say.
   */
  noTools?: boolean;
  /**
   * What a Codex request on this model was last measured to cost (the tools it attaches against what the model holds).
   * Missing until a request for this very model has gone through the chat adapter: see ToolCost.
   */
  toolCost?: ToolCost;
}

/**
 * What a Codex request on a model server of your own costs, as measured when one went through the chat adapter
 * (hub/src/adapter/cost.ts). Codex attaches every tool the person's own Codex and ChatGPT-app setup offers to each request
 * (361 of them and 134,000 tokens on one real setup, 95% of it ChatGPT connectors), so on a small model the tools alone can be
 * many times the window — which is why this is said where a model is picked, before a chat is started on one that can't work.
 *
 * It is a measurement of one request, not a promise about the next: what Codex attaches changes with the person's setup, and
 * the kept tool set changes as a chat grows. So it always carries when it was taken, and a model no request has gone to has
 * none at all rather than a figure borrowed from another model.
 */
export interface ToolCost {
  /** When it was measured (ms): the request's own time. */
  at: number;
  /** The model it was measured on. */
  model: string;
  /** Tokens of tool schemas the agent attached, as it sent them (an estimate: hub/src/adapter/translate.ts). */
  tools: number;
  /** How many tools those were. */
  toolCount: number;
  /**
   * The whole request as the agent sent it: the tools, its own instructions and the conversation. Grows with every message of
   * a chat, so nothing on a screen reads it and `noteToolCost` never compares it (that would be a database write and an event
   * to every device per request); it is here for the hub log and for working out what the tools were of a measured request.
   */
  prompt: number;
  /** What the model held at the time; null when nothing says what it holds. */
  window: number | null;
  /** How many tools Crosstalk left out so the request would fit. Missing: all of them went. */
  dropped?: number;
}

export interface ModelCatalog {
  provider: Provider;
  /** The account the list was asked for ("default" when missing). */
  accountId?: string;
  models: ModelOption[];
  live: boolean; // false when the agent couldn't be asked (not installed or signed in); models are then suggestions
  error: string | null;
  /** When the agent was last asked (ms). */
  checkedAt?: number;
  /** Models the agent listed before but doesn't now (by id and full name): a chat still set to one may fail. */
  gone?: string[];
}

/** What a chat on a model can hold, worked out from the agent's model list. */
export interface ChatContextSize {
  /** The model's window for this chat (raised when the chat uses long context). */
  window: number;
  /** How much of it the conversation can fill before it's full. */
  usable: number;
  /** Where the agent compacts by itself, when it says. */
  compactAt: number | null;
  /** The chat uses more than the model's usual window. */
  long: boolean;
}

/**
 * A model id without what only says how it's run or which build it is, for telling whether two ids name the same
 * model: "claude-opus-5-5[1m]", "us.anthropic.claude-opus-5-5-v1:0" and "claude-opus-5-5" are one.
 */
export function baseModelId(id: string): string {
  return id.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/^(?:[a-z0-9-]+\.)?anthropic\./, "").replace(/-v\d+:\d+$/, "").replace(/@\d{8}$/, "").replace(/-\d{8}$/, "");
}

/** Whether a chat asked for long context (Codex: the most its model allows, see ModelOption.maxContextWindow). */
export function wantsLongContext(config: Record<string, unknown> | undefined): boolean {
  return config?.longContext === true;
}

/**
 * What a chat on `m` can hold. With long context the window is the model's maximum, and the share the agent keeps
 * back and its compaction point grow with it (Codex keeps a fixed share, and compacts at a fixed share).
 */
export function chatContextSize(m: Pick<ModelOption, "contextWindow" | "usableContext" | "compactAt" | "maxContextWindow"> | null | undefined, long = false): ChatContextSize | null {
  const base = m?.contextWindow;
  if (!base || base <= 0) return null;
  const max = m.maxContextWindow && m.maxContextWindow > base ? m.maxContextWindow : null;
  const raise = long && max ? max / base : 1;
  const scale = (n: number) => Math.floor(n * raise);
  return { window: scale(base), usable: scale(m.usableContext && m.usableContext <= base ? m.usableContext : base), compactAt: m.compactAt ? scale(m.compactAt) : null, long: raise > 1 };
}

/**
 * Tokens a chat on a model server of your own costs before anything the person types: Codex's own instructions, its
 * `<environment_context>`, Crosstalk's note, and the tools the agent can't work without (hub/src/adapter/translate.ts
 * `fitToWindow` keeps exactly those when the model is too small for the rest, and leaves the person's app connectors out).
 * Measured with a local llama.cpp on a real first message: 9,938 tokens for all of that plus "hi!", so about 12,000
 * with room to answer in.
 *
 * Codex only: Claude Code talks to a server of your own directly, without the translator, and nothing here has measured its
 * floor. It is a floor, not a model's context size, which is never hard-coded (ModelOption.contextWindow).
 */
export const CODEX_PROMPT_FLOOR = 12_000;

/**
 * What a model with less room than the agent needs to say anything means, in plain words; null when it has room. Said where the
 * model is picked and before the chat starts, the way a model that can't run tool calls is (ModelOption.noTools): otherwise the
 * first message fails, in words that come from the model's own server and blame the length of a chat one word long.
 */
export function smallWindowWords(provider: Provider, model: string, window: number | null | undefined): string | null {
  if (provider !== "codex" || !window || window >= CODEX_PROMPT_FLOOR) return null;
  const count = (n: number) => n.toLocaleString("en-US");
  return `${model} holds ${count(window)} tokens, and Codex's own instructions and tools need about ${count(CODEX_PROMPT_FLOOR)} of them before you type anything. There's no room left to answer in: pick a model with a bigger context.`;
}

/**
 * Below this window (tokens), a Codex chat on a model server of your own runs **lean**: Codex is asked to leave the person's own
 * plugins, their ChatGPT app connectors and its own helper tools out of that thread (hub/src/agents/codex.ts `leanConfig`), so
 * they are never built, never sent over the loopback and never counted against the model's window.
 *
 * Why a threshold and not every server of your own: the connectors still work from any model (Codex runs the app call itself,
 * against the person's ChatGPT account), so a big-window custom model keeps real function. Why this number: on one real setup the
 * catalogue measured 141,085 tokens for a first "hi!", 95% of it the 333 `mcp__codex_apps__*` connectors, and a chat compacts at
 * three quarters of its window (`autoCompactLimit`), so even the trimmed ~35,000 tokens of everything-but-connectors would leave a
 * 64k model about 13,000 tokens for the conversation. A window nothing states keeps everything, as the adapter's own fitting does.
 */
export const CODEX_LEAN_TOOLS_BELOW = 64_000;

/**
 * Whether a Codex chat runs lean (see CODEX_LEAN_TOOLS_BELOW): a small model on a server of your own does, and the chat's own
 * `codexPlugins` setting decides instead when it is set (true: keep the person's plugins whatever the window; false: leave them
 * out even on a big model), so nothing is taken away without a way back.
 */
export function leanCodexTools(onEndpoint: boolean, window: number | null | undefined, config?: Record<string, unknown>): boolean {
  if (typeof config?.codexPlugins === "boolean") return !config.codexPlugins;
  return onEndpoint && !!window && window < CODEX_LEAN_TOOLS_BELOW;
}

/**
 * Whether an MCP server is one of Crosstalk's own: the chat tools (`crosstalk`) and the setup tools the person adds themselves
 * on this machine (`crosstalk-setup`, docs/SETUP-FOR-AGENTS.md). Both come from the hub, and both are kept whatever else goes —
 * the adapter never leaves their tools out of a request (hub/src/adapter/translate.ts `toolGroup`, rank 0) and a lean thread
 * never switches them off (hub/src/agents/codex.ts). One rule for both, so the two can't drift apart and leave a chat without
 * `setup_status` or `hub_log` while the words say it kept Crosstalk's.
 *
 * Takes either a server's own name as the person's config has it (`crosstalk-setup`) or a tool's flattened name as the agent
 * sends it (`mcp__crosstalk_setup__hub_log`: Codex writes a dash as an underscore there). A server of the person's whose name
 * merely starts with the letters (`crosstalkextra`) is theirs, not ours.
 */
export function isCrosstalkMcpServer(name: string): boolean {
  return /^(?:mcp__)?crosstalk(?:[-_]|$)/i.test(name);
}

/**
 * What a model too small for the person's own Codex plugins means, in plain words; null when they fit, when the chat's own
 * setting keeps them anyway (`codexPlugins`), or when the model has no room to answer at all (which smallWindowWords says
 * instead). Said where the model is picked, so the chat's tools are known before it starts rather than guessed from a reply
 * that mentions none.
 *
 * No figure for what the catalogue costs: 141,085 tokens measured on one setup is one setup on one day, and the only honest number is the
 * one measured for that very account, which `toolCostWords` says on its own line right beside this one (and says when it was
 * taken). A chat on a model this small runs with Codex's own tools and Crosstalk's only whatever its Codex makes of the lean
 * settings, because the adapter leaves everything else out of each request anyway when it doesn't fit (`fitToWindow`).
 */
export function leanToolsWords(provider: Provider, model: string, window: number | null | undefined, config?: Record<string, unknown>): string | null {
  if (provider !== "codex" || !window || window < CODEX_PROMPT_FLOOR || window >= CODEX_LEAN_TOOLS_BELOW) return null;
  if (!leanCodexTools(true, window, config)) return null; // the chat says to keep them: it is not this chat that runs lean
  const count = (n: number) => n.toLocaleString("en-US");
  return `${model} holds ${count(window)} tokens, and the tools your Codex plugins and ChatGPT apps add are far bigger than that. This chat runs with Codex's own tools and Crosstalk's only, so there's room to talk in; chats on a bigger model keep the rest.`;
}

/**
 * What the tools cost on a model, in plain words, for where a model is picked and for the service's own row in Settings; null
 * when there is nothing measured to say. A measurement, so it says when it was taken (`when`, formatted by the device: its own
 * clock, not the hub's) and rounds its own estimate ("about 134,000") while stating a size the model itself gives exactly
 * ("16,384"), the way the adapter's refusals do.
 *
 * `model` names the model when the line covers several (a service's row); left out it reads "this model", for a line that sits
 * under the model already chosen.
 */
export function toolCostWords(cost: ToolCost | null | undefined, opts: { model?: string | null; when?: string | null } = {}): string | null {
  if (!cost || !(cost.tools > 0)) return null;
  const about = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 1000).toLocaleString("en-US")},000`);
  const exact = (n: number) => n.toLocaleString("en-US");
  const holds = cost.window ? `; ${opts.model || "this model"} holds ${exact(cost.window)}` : "";
  // Why a chat on a model the figures say is hopeless still works: Crosstalk sends fewer tools (translate.ts fitToWindow).
  const left = cost.dropped ? ` Crosstalk leaves ${exact(cost.dropped)} of them out so a chat can start.` : "";
  return `Codex's tools take about ${about(cost.tools)} tokens${holds}.${left}${opts.when ? ` Measured ${opts.when}.` : ""}`;
}

export const EFFORT_LABELS: Record<string, string> = {
  // Refuseless's lowest level (its reasoning_effort takes off, low, high or max).
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export interface Device {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number | null;
  current?: boolean;
  /**
   * "full": a person's device (everything). "peer": another machine's hub, signed in only for what its agents need
   * (finding, reading and messaging chats); it can't open a terminal, approve, change settings or pair devices.
   */
  scope?: "full" | "peer";
  /** For another machine's hub: which hub this sign-in belongs to. */
  hubId?: string | null;
}

export interface HubInfo {
  version: string;
  hostname: string;
  platform: string;
  workspaceRoot: string;
  publicUrl: string | null;
  /** Tells hubs apart when the app uses several machines (absent from older hubs). */
  id?: string;
  /** What this machine is called in the app, e.g. "Mac mini" (absent from older hubs). */
  name?: string;
  /**
   * While an agent's helpers work, this hub delivers your messages by itself, whatever settings wait around them
   * (engine.ts flowIn, heldForSettings), so the app shows no Send now or Answer now then. Follows HubSettings.messagesFlow
   * ("hub" events say when it changes). False, or absent from older hubs: they hold those messages until the helpers
   * finish, and only those buttons can send them sooner.
   */
  messagesFlow?: boolean;
}

/**
 * Another machine's hub linked with this one. The app talks to each machine's hub directly; this hub keeps a
 * sign-in on the other so any device paired here can add it with one tap, and its notifications come through here.
 */
export interface MachineInfo {
  id: string;
  name: string;
  /** The other hub's address, e.g. https://linux-box.tailnet.ts.net */
  url: string;
  addedAt: number;
  /** "full": linked from here by a person (devices can add it); "peer": linked for agents only. */
  scope?: "full" | "peer";
  /** Whether agents here and there can reach each other's chats. */
  agents?: MachineAgentLink;
  error?: string | null;
  /** The machine that introduced this one (for links made machine to machine). */
  introducedBy?: string | null;
}

export type MachineAgentLink = "one-way" | "connecting" | "two-way" | "failed" | "needs-update" | "signed-out" | "removing";

/** A one-line command that installs the hub on a Linux machine and links it with this one. */
export interface MachineInvite {
  token: string;
  command: string;
  expiresAt: number;
}

export interface MachineInviteStatus {
  status: "waiting" | "done" | "failed" | "expired";
  machine?: MachineInfo;
  error?: string;
}

// ---- Bookmarks (hub/src/bookmarks.ts) ----
//
// A message the person keeps, to find again from the Bookmarks screen. Each lives on the hub of the chat it's in, so the
// screen asks every machine. One goes with its message: unsent, rewound away, or with its chat.
//   GET /api/bookmarks                 -> BookmarkList (newest bookmark first)
//   PUT /api/messages/:id/bookmark     { bookmarked: boolean } -> { messageId, roomId, at: number | null }
// Every device hears of a change through a `bookmark` event; the state has the chats' bookmarked messages (`bookmarked`).

/** What a bookmark shows of its message, at most: the Bookmarks screen opens the chat at it for the rest. */
export const BOOKMARK_TEXT_MAX = 1500;

export interface Bookmark {
  messageId: string;
  roomId: string;
  roomName: string;
  /** Its place in the chat's order: the app pages back until it has it. */
  seq: number;
  /** Who said it: you, or an agent (one in another chat that sent it here counts as an agent). */
  who: "you" | "agent";
  /** The agent that wrote it (its @handle, or the other chat's agent's name); absent for yours. */
  agent?: string;
  /** The message as the chat shows it, cut at BOOKMARK_TEXT_MAX characters (`cut` says so). */
  text: string;
  cut: boolean;
  createdAt: number;
  bookmarkedAt: number;
}

export interface BookmarkList {
  bookmarks: Bookmark[];
}

export interface StateSnapshot {
  hub: HubInfo;
  rooms: Room[];
  members: Member[];
  approvals: Approval[]; // pending ones
  usage: UsageSnapshot[];
  providers: ProviderStatus[];
  /** Every agent account (each agent's own sign-in plus any extra accounts). */
  accounts: AgentAccount[];
  /** How much each kind of agent has worked in each room (for room icons), by room id. */
  roomActivity: Record<string, RoomActivity[]>;
  device: Device;
  /** The hub's disk (absent from older hubs). */
  storage?: StorageStatus;
  /** On a Mac hub: privacy dialogs waiting on its screen (absent from older hubs). */
  macDialogs?: MacDialog[];
  /** Ways to start a chat (Settings → Templates), in the person's order (absent from older hubs). */
  templates?: PromptTemplate[];
  /** The model pool as a model to chat with (absent from hubs older than that). */
  pool?: PoolOffer;
  /** How the machine's memory is doing (absent from older hubs). */
  memory?: MachineMemory;
  /** Agent accounts found signed out after a reply failed on its sign-in (absent from older hubs). */
  signIns?: SignInNeed[];
  /** Sign-ins started from the phone that are running or ended in the last few minutes (absent from older hubs). */
  signInSessions?: SignInSession[];
  /** The messages kept in Bookmarks, with when (absent from older hubs). */
  bookmarked?: Record<string, number>;
}

// ---- Login flows (guided setup) ----

export type LoginFlow =
  | { kind: "device_code"; provider: Provider; loginId: string; url: string; code: string; expiresAt: number | null }
  | { kind: "terminal"; provider: Provider; ptyId: string; command: string; hint: string }
  | { kind: "browser"; provider: Provider; loginId: string; url: string };

// ---- A sign-in that stopped working, and signing in again from the phone (hub/src/signin.ts) ----
//
// The contract. Routes are for the person's own devices only: another machine's hub gets 403 (`code` "peer_scope" for
// a peer sign-in, "person_only" for a full one), a setup key or no sign-in 401. Errors are { error, code }, `error` in
// plain words to show as they are.
//   GET    /api/signin                 -> { needs: SignInNeed[]; sessions: SignInSession[] }
//   POST   /api/signin                 { provider, account? } -> SignInSession, usually "starting" (Codex: "open").
//                                       Starts the agent's own sign-in on this machine; one open for the same agent
//                                       and account ends "cancelled", and so does one Settings started the older way
//                                       (POST /api/accounts/:p/:id/login), which in turn ends this kind. 400
//                                       "provider" (no such agent); 404 "account";
//                                       409 "not_signin" (an API-key account, a model server of your own, or an agent
//                                       that runs only on AI services on any account, Crosstalk's own or OpenCode, which
//                                       runs on a service's key: nothing to sign in to), "terminal" (Antigravity CLI: it signs in on a screen of its own,
//                                       use its terminal sign-in, LoginFlow), "not_installed"; 429 "too_many" (4 open).
//   GET    /api/signin/:id             -> SignInSession; 404 "gone" once it has gone (ended ones stay 10 minutes).
//   POST   /api/signin/:id/code        { code } -> SignInSession, "checking". Only while `wantsCode`: 409 "not_waiting"
//                                       otherwise (a "device" one never wants one); 400 "code" for an empty or
//                                       multi-line code, one too short to be a code (under 16 characters before any
//                                       #), or a body that isn't JSON: the agent never gets those, and the box stays
//                                       open. Spaces around it are trimmed. The code goes to the agent's sign-in and
//                                       nowhere else: never logged, stored, put in an event or an answer, or echoed back.
//   DELETE /api/signin/:id             -> SignInSession, "cancelled" (an ended one as it ended).
// Events: { t: "signin.session", session } on every change of a session (people's own devices' sockets only);
// { t: "signin.needs", needs } (the whole list) whenever an agent account is found signed out or signed in again. The
// state snapshot carries both (`signIns`; `signInSessions` for people's own devices).
// A session moves "starting" -> "open" (url, and userCode or wantsCode) -> "checking" (a code went in, or the agent
// said it's done) -> "done" | "failed" | "expired" | "cancelled"; a code the agent turns down goes back to "open" with
// `codeRefused` (and, when the agent made a new link meanwhile, Gemini CLI's way, a new `url` and words saying "new
// sign-in link"). A finished sign-in ends that account's SignInNeed (a `signin.needs` event).

/**
 * An agent account found signed out after a reply failed on its sign-in (hub/src/engine/engine.ts: the stale-login
 * recovery restarted the agent once, and the agent's own sign-in check then said it was signed out). Every chat on that
 * agent and account can't answer until it's signed in again: chats show it by matching `provider` and `account`
 * (memberAccount) of their agents, not just the chats in `rooms`.
 */
export interface SignInNeed {
  provider: Provider;
  /** Which account (memberAccount): "default" is the agent's own sign-in. */
  account: string;
  /** What to call that account when it isn't the default one ("Work"). */
  accountLabel: string | null;
  /** The machine whose agent is signed out (this hub), as the app names it. */
  machine: { id: string; name: string };
  /** When the hub found it signed out. */
  since: number;
  /** The chats whose replies stopped on it, oldest first. */
  rooms: string[];
  /** One plain sentence for the chat, the chat list and the agent's screen: who is signed out, where, and what to do. */
  words: string;
}

/**
 * What a sign-in started from the phone is doing.
 * "starting": the agent's sign-in is starting on the hub's machine. "open": the link (and any code) is ready: the person
 * opens it. "checking": a pasted code went in, or the agent finished, and Crosstalk is checking the result. "done":
 * signed in. "failed", "expired" (nobody finished it in time), "cancelled" (stopped, or replaced by a newer one) end it.
 */
export type SignInState = "starting" | "open" | "checking" | "done" | "failed" | "expired" | "cancelled";

/** A sign-in started from the phone, running on the hub's machine (POST /api/signin). */
export interface SignInSession {
  id: string;
  provider: Provider;
  account: string;
  accountLabel: string | null;
  machine: { id: string; name: string };
  /**
   * "device": open `url` on any device and enter (or confirm) `userCode` there; nothing comes back to the phone.
   * "paste": open `url`, sign in, and paste the code the page shows into this session (POST /api/signin/:id/code).
   */
  method: "device" | "paste";
  state: SignInState;
  /** The sign-in page to open, once the agent has said it. */
  url: string | null;
  /** The code to enter or confirm on that page ("device" only). Never the code the person pastes. */
  userCode: string | null;
  /** The agent is waiting for the code from the sign-in page ("paste" only): the phone shows a box to paste it into. */
  wantsCode: boolean;
  /** How many codes were pasted so far, and whether the agent turned the last one down (paste the whole code again). */
  codesSent: number;
  codeRefused: boolean;
  /** Plain words: what to do now, or what happened. */
  words: string;
  startedAt: number;
  /** When Crosstalk stops waiting for it ("expired"). */
  expiresAt: number;
  endedAt: number | null;
}

/** The agent of a sign-in need or session in words: "Claude Code", or "Claude Code (Work)" for a second account. */
export function signInAgentWords(x: { provider: Provider; account: string; accountLabel?: string | null }): string {
  const name = PROVIDER_INFO[x.provider]?.name ?? "The agent";
  const label = x.account !== DEFAULT_ACCOUNT ? x.accountLabel || null : null;
  return label ? `${name} (${label})` : name;
}

/**
 * Whether an agent has a sign-in of its own (a Claude plan, a ChatGPT, Google or Meta account) that Crosstalk can start
 * again, check or sign in from the phone. Not the agents that run only on an AI service (Crosstalk's own, OpenCode): they
 * run on the service's key, which is changed in Settings → AI services and never signed in to, so they are never found
 * signed out (the hub's `SignIns.covers`), never started again for a stale sign-in, and no screen offers to sign them in.
 * Nor the test agent.
 */
export function agentHasSignIn(p: Provider): boolean {
  return !isServiceOnlyAgent(p) && p !== "mock";
}

/**
 * Why an agent that runs only on a service is never signed in: POST /api/signin, Settings' older sign-in (POST
 * /api/accounts/:p/:id/login, /api/providers/:p/login), signing it out and adding another sign-in for it (POST
 * /api/accounts) all answer 409 "not_signin" with it, and the sign-in sheet then offers Open AI services.
 */
export function noSignInWords(p: Provider): string {
  return `${p === "builtin" ? "Crosstalk's own agent" : PROVIDER_INFO[p]?.name ?? "This agent"} has no sign-in: it runs on an AI service's key. Check that key in Settings → AI services.`;
}
export const NO_SIGN_IN_WORDS = noSignInWords("builtin");

/**
 * A reply Crosstalk's own agent or OpenCode couldn't get because the AI service refused its key (a 401, or a 403 that isn't
 * Cloudflare's check, the model or money): "NanoGPT refused the key — check it in Settings → AI services, then tap Try
 * again." The way out is the key, never a sign-in (agentHasSignIn): the phone puts "Open AI services" beside Try again
 * (isServiceKeyRefusal). `missing`: the account has no key saved at all.
 */
export function serviceKeyWords(service: string, missing = false): string {
  return missing
    ? `${service} needs a key — add it in Settings → AI services, then tap Try again.`
    : `${service} refused the key — check it in Settings → AI services, then tap Try again.`;
}

/**
 * Whether a reply's error is serviceKeyWords': its way out is the service's key in Settings → AI services. A hub before
 * 0.6.7 words it "NanoGPT refused the key. Check it in Settings → AI services, then try again.", and a phone reading one
 * of those chats knows that too.
 */
export function isServiceKeyRefusal(error: string | null | undefined): boolean {
  return / (?:refused the key(?: —|\.) [Cc]heck|needs a key — add) it in Settings → AI services\b/.test(error ?? "");
}

/**
 * The sign-in words, asked for an agent with no sign-in (one that runs only on a service): its way on is its AI service's key, never a
 * sign-in, so they are the refused key's own words (serviceKeyWords, `accountLabel` being the service's name), which the
 * phone gives Open AI services. Nothing asks today (the hub's SignIns.covers never lets it get this far): this keeps any
 * future caller from ever telling the person it's "signed out".
 */
function keyInsteadOfSignIn(x: { accountLabel?: string | null }): string {
  return serviceKeyWords(x.accountLabel || "Its AI service");
}

/**
 * How a person signs an agent in again, in words for a reply, a notification or the agent's status: the Sign in on the
 * agent's card in Settings → Agents (Claude Code and Codex have one; it opens the sign-in sheet), else the Sign in every
 * chat on that agent shows. Never a terminal. Only for an agent that has a sign-in (keyInsteadOfSignIn otherwise).
 */
function signInAgain(provider: Provider): string {
  return (CHAT_PROVIDERS as readonly Provider[]).includes(provider) ? `sign in to it again (Settings → Agents → ${PROVIDER_INFO[provider]?.name ?? "the agent"} → Sign in)` : "sign in to it again with Sign in in the chat";
}

/** A reply stopped because its agent is signed out (SignInNeed.words). */
export function signInNeededWords(x: { provider: Provider; account: string; accountLabel?: string | null }, machine: string): string {
  if (!agentHasSignIn(x.provider)) return keyInsteadOfSignIn(x);
  const again = signInAgain(x.provider);
  return `${signInAgentWords(x)} is signed out on ${machine}, so it couldn't answer. ${again[0].toUpperCase()}${again.slice(1)}, then tap Try again.`;
}

/**
 * The note in a reply whose agent Crosstalk started again because its sign-in had gone stale: while it starts again,
 * once it carried on, when its sign-in failed again, or when the reply ended some other way.
 */
export function staleSignInWords(agent: string, machine: string, outcome: "starting" | "carried" | "failed" | "ended"): string {
  switch (outcome) {
    case "starting":
      return `${agent}'s sign-in had gone stale in this chat. Starting it again on ${machine}…`;
    case "carried":
      return `${agent}'s sign-in had gone stale in this chat: Crosstalk started it again and it carried on.`;
    case "failed":
      return `${agent}'s sign-in had gone stale in this chat. Crosstalk started it again, but its sign-in failed again.`;
    default:
      return `${agent}'s sign-in had gone stale in this chat: Crosstalk started it again.`;
  }
}

/**
 * A reply whose sign-in failed again after Crosstalk started the agent again, when the agent's own check didn't say it
 * was signed out: `busy`, another process of the same agent was renewing the sign-in at that moment; `signedIn`, what
 * the check said (null: it couldn't be asked).
 */
export function staleSignInFailedWords(x: { provider: Provider; account: string; accountLabel?: string | null }, machine: string, opts: { busy: boolean; signedIn: boolean | null }): string {
  if (!agentHasSignIn(x.provider)) return keyInsteadOfSignIn(x);
  const agent = signInAgentWords(x);
  const name = PROVIDER_INFO[x.provider]?.name ?? "the agent";
  if (opts.busy) return `${agent} couldn't renew its sign-in on ${machine}: another ${name} there was renewing it at the same moment. Tap Try again in a minute.`;
  const again = signInAgain(x.provider);
  if (opts.signedIn === null) return `${agent}'s sign-in failed again after Crosstalk started it again, and Crosstalk couldn't check its sign-in on ${machine}. ${again[0].toUpperCase()}${again.slice(1)}, then tap Try again.`;
  return `${agent}'s sign-in failed again after Crosstalk started it again, though ${name} on ${machine} says it's signed in. Tap Try again in a minute; if it keeps failing, ${again}.`;
}

export interface PtyInfo {
  id: string;
  title: string;
  command: string;
  purpose: "login" | "install" | "shell";
  provider: Provider | null;
  alive: boolean;
  exitCode: number | null;
  createdAt: number;
}

// ---- WebSocket events (hub -> client) ----

/** Work an agent runs in the background: a helper agent it summoned, a workflow, or a long command. */
export interface BackgroundTask {
  id: string;
  /** What kind: "local_agent" (a helper agent), "local_workflow", "local_bash", … as the agent reports it. */
  kind: string;
  description: string;
  /** The helper's role, e.g. "general-purpose" or "Explore". */
  agentType: string | null;
  workflow: string | null;
  /** Running in the background (the agent's reply can end while it works) rather than inside the reply. */
  background: boolean;
  status: "running" | "completed" | "failed" | "killed" | "stopped";
  startedAt: number;
  endedAt: number | null;
  tokens: number | null;
  toolUses: number | null;
  lastTool: string | null;
  /** What it's doing (while running) or what it found (when done), in the agent's words. */
  summary: string | null;
  error: string | null;
  /** A helper agent's model (e.g. "claude-opus-5-5"), effort, and how full its context is, read from its transcript. */
  model?: string | null;
  effort?: string | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
}

/**
 * Whether this is a helper at work as the person sees it (the app's Helpers panel): a helper or a workflow, or a command
 * left running in the background. A command in the foreground is a step of the reply, whatever it reports.
 */
export function helperAtWork(t: Pick<BackgroundTask, "status" | "kind" | "background">): boolean {
  return t.status === "running" && (t.kind !== "local_bash" || t.background);
}

export type ServerEvent =
  | { t: "hello"; device: Device; hub: HubInfo }
  /** What this hub says of itself changed while devices are connected (HubInfo.messagesFlow): they go by this from now on. */
  | { t: "hub"; hub: HubInfo }
  | { t: "room"; room: Room }
  | { t: "room.deleted"; roomId: string }
  | { t: "member"; member: Member }
  | { t: "member.deleted"; memberId: string; roomId: string }
  | { t: "message"; message: Message }
  /** `offset`: where `delta` starts in the reply's text (JS string positions), so a client that reloaded history while
   * the reply streamed can merge without duplicating or dropping text. Absent from older hubs. */
  | { t: "message.delta"; messageId: string; roomId: string; delta: string; offset?: number }
  | { t: "turn"; turn: Turn }
  | { t: "tasks"; roomId: string; memberId: string; tasks: BackgroundTask[] }
  /** Messages taken back (unsent, or rewound past when a message was edited). */
  | { t: "messages.removed"; roomId: string; ids: string[] }
  /** Replies taken out of the chat with the messages they answered (a rewind): their turns, steps and errors go too. */
  | { t: "turns.removed"; roomId: string; ids: string[] }
  | { t: "activity"; activity: Activity }
  /**
   * A step changed (clients on PROTOCOL_VERSION 2; older ones get the whole step as an "activity" event): `delta` is
   * added to its detail at `offset` (JS string positions), with its new title, kind or status when those changed.
   */
  | { t: "activity.delta"; roomId: string; turnId: string; activityId: string; offset: number; delta: string; title?: string; kind?: ActivityKind; status?: Activity["status"]; updatedAt: number }
  | { t: "approval"; approval: Approval }
  | { t: "usage"; usage: UsageSnapshot }
  | { t: "provider"; status: ProviderStatus }
  /** An agent's model list changed: a model came or went, or what a model can hold did. */
  | { t: "models"; catalog: ModelCatalog }
  /** The model pool changed: its settings, a machine's state, a download's progress, the server's state. */
  | { t: "pool"; pool: PoolView }
  /** What the pool is as a model to chat with changed (its state, its model, the machines): every screen that starts a chat follows this. */
  | { t: "poolOffer"; offer: PoolOffer }
  /** The AI image editor was switched on or off, or its state changed. */
  | { t: "imageEditor"; status: ImageEditorStatus }
  /** On a Mac hub: a privacy dialog went up on the Mac's screen, or was answered, or dismissed. */
  | { t: "macDialogs"; dialogs: MacDialog[] }
  /** An ask (a question to another agent about a message) started, progressed or ended. */
  | { t: "ask"; ask: Ask }
  /** An ask card was removed. */
  | { t: "ask.removed"; id: string; roomId: string }
  /** What the accounts have cost changed (at most every few seconds). */
  | { t: "spend"; accounts: AccountSpend[] }
  /** A template was added, changed, moved or deleted: the whole list, in order. */
  | { t: "templates"; templates: PromptTemplate[] }
  /** A message was bookmarked (`at`: when) or its bookmark taken off (`at` null). */
  | { t: "bookmark"; roomId: string; messageId: string; at: number | null }
  /** A sign-in's news: `done` when it ended (with `error` when it didn't sign in), for the attempt `loginId` started. */
  | { t: "login"; flow: LoginFlow | null; provider: Provider; accountId?: string; done?: boolean; error?: string; loginId?: string }
  | { t: "account"; account: AgentAccount }
  /** A sign-in started from the phone changed (its link or code is ready, it wants the code, it ended). People's devices only. */
  | { t: "signin.session"; session: SignInSession }
  /** The agent accounts found signed out, the whole list: one was found signed out, or is signed in again. */
  | { t: "signin.needs"; needs: SignInNeed[] }
  | { t: "roomActivity"; roomId: string; activity: RoomActivity[] }
  | { t: "storage"; status: StorageStatus }
  /** The machine's memory changed band, or what is holding it did (hub/src/memory.ts). */
  | { t: "memory"; memory: MachineMemory }
  | { t: "account.deleted"; provider: Provider; id: string }
  | { t: "pty"; pty: PtyInfo }
  | { t: "pty.data"; ptyId: string; data: string }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string };

// ---- WebSocket messages (client -> hub) ----

export type ClientEvent =
  | { t: "pty.input"; ptyId: string; data: string }
  | { t: "pty.resize"; ptyId: string; cols: number; rows: number }
  | { t: "presence"; visible: boolean }
  | { t: "ping" };

// ---- Mentions ----

const MENTION_RE = /(^|[^\w@./-])@([a-zA-Z][\w-]{0,31})\b(?!\/)/g; // "@name/…" is a path, not a mention

/** Returns lowercase handles mentioned in text, in order of first appearance. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  // Ignore mentions inside fenced or inline code.
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const m of stripped.matchAll(MENTION_RE)) {
    const h = m[2].toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export function slugHandle(s: string): string {
  const h = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return /^[a-z]/.test(h) ? h : `a-${h}`.slice(0, 32);
}

// ---- Model pool: one local model split across machines with llama.cpp's RPC backend (docs/MODEL-POOL.md) ----

/** Which llama.cpp build a machine runs. */
export type PoolBackend = "metal" | "vulkan" | "cuda" | "cpu";

/** A GPU (or other accelerator) llama.cpp found on a machine, as `llama-server --list-devices` reports it. */
export interface PoolDevice {
  /** llama.cpp's name for it on that machine: MTL0, Vulkan0, CUDA0… */
  name: string;
  /** e.g. "Apple M4" or "AMD Radeon RX 7900 XTX (RADV NAVI31)". */
  description: string;
  totalMiB: number;
  freeMiB: number;
}

/** A machine in the pool, as set up. */
export interface PoolMachine {
  /** "self" (this hub), a linked hub's id (h_…), or "pc_<id>" for another computer added by its address. */
  id: string;
  kind: "self" | "hub" | "computer";
  name: string;
  /** The Tailscale IPv4 the other machines reach it at (hubs report their own; for a computer, what was picked or typed). */
  address: string | null;
  os: "macos" | "linux" | "windows" | null;
  backend: PoolBackend | null;
  /** Its GPU takes part (a machine can stay in the list and be left out). */
  enabled: boolean;
  /** Port of its helper (ggml-rpc-server). */
  rpcPort: number;
}

/** What Crosstalk last learned about a machine in the pool. */
export interface PoolMachineState {
  id: string;
  devices: PoolDevice[];
  /** Round trip over Tailscale from this hub, and whether it goes direct or through a relay. */
  link: { ms: number | null; direct: boolean | null } | null;
  state: "unknown" | "offline" | "ready" | "installing" | "running" | "error";
  /** In plain words: what it's doing, or what's wrong and what to do. */
  detail: string | null;
  checkedAt: number;
}

/** A model on Hugging Face: one GGUF file, or a split model's parts. */
export interface PoolModel {
  repo: string;
  /** The GGUF file, or a split model's parts in order (…-00001-of-00002.gguf, …). */
  files: string[];
  /** e.g. "Q4_K_M", read from the file name. */
  quant: string | null;
  sizeBytes: number;
  /** Downloading it needs the user's Hugging Face token (after accepting its terms on the website). */
  gated: boolean;
}

/** A Hugging Face repo's GGUF choices (GET /api/pool/models?repo=…). */
export interface PoolModelChoices {
  repo: string;
  gated: boolean;
  models: PoolModel[];
}

export interface PoolConfig {
  /** The llama.cpp build every machine runs, e.g. "b11669": they must all match exactly. */
  build: string;
  machines: PoolMachine[];
  /** The machine that holds the model and answers chats: "self" or a linked hub's id. */
  mainId: string;
  model: PoolModel | null;
  /** Tokens of context the server is started with (never more than the model holds: the status says what it gave). */
  contextSize: number;
  /** The model's name in chats. */
  alias: string;
  /** The server's port on the main machine. */
  port: number;
  /** Started again when the hub starts, if it was running when the hub stopped. */
  autostart: boolean;
}

export type PoolState = "off" | "preparing" | "downloading" | "starting" | "running" | "stopping" | "error";

export interface PoolStatus {
  state: PoolState;
  /** What it's doing, or what went wrong and what to do, in plain words. */
  detail: string | null;
  /** The model's download to the main machine, while it runs. */
  download: { file: string; doneBytes: number; totalBytes: number; bytesPerSec: number | null } | null;
  /** Where chats reach it, once it runs. */
  endpoint: { baseUrl: string; model: string; contextWindow: number | null } | null;
  /** The custom-model accounts it's offered as, by agent (account ids). */
  accounts: Partial<Record<Provider, string>>;
  startedAt: number | null;
  /** Measured speed in tokens per second, once there's been a reply. */
  speed: { prompt: number | null; generation: number | null } | null;
  /** The newest lines of the main machine's server output. */
  log: string[];
}

/** The room the model needs against what the machines taking part have. */
export interface PoolFit {
  needMiB: number;
  haveMiB: number;
  fits: boolean;
  /** e.g. "Fits the RX 7900 XTX alone: leave the others out to run it at full speed." */
  note: string | null;
}

/** A model file on a machine ("owner/repo/file"), downloaded or still downloading (`partial`). */
export interface PoolModelFile {
  file: string;
  bytes: number;
  partial: boolean;
}

/** Everything the Model pool screen shows (GET /api/pool, and the "pool" event). */
export interface PoolView {
  config: PoolConfig;
  machines: PoolMachineState[];
  status: PoolStatus;
  fit: PoolFit | null;
  /** A Hugging Face token is saved (the token itself never leaves the hub). */
  hasHfToken: boolean;
  /**
   * The model files on the main machine as it last said, finished or not, so ones no longer used can be removed.
   * Missing from hubs older than this list; null until the main machine was asked.
   */
  mainFiles?: PoolModelFile[] | null;
}

/**
 * The model pool as one model you can chat with: what every screen that starts a chat needs, whatever state the pool
 * is in (hub/src/pool/pool.ts chatOffer; the words and what a tap does are in web/src/poolChat.ts). It comes with the
 * state snapshot and again as a "poolOffer" event, so the New chat menu never has to ask for the whole PoolView.
 */
export interface PoolOffer {
  /** What it's called in chats and in the menu (the custom-model accounts' name, "Model pool"). */
  label: string;
  /** The pool's state now, as Settings → Model pool shows it. */
  state: PoolState;
  /** What it's doing, or what's wrong and what to do, in plain words (PoolStatus.detail). */
  detail: string | null;
  /** A model is chosen and a machine can run it: the pool can be started. */
  setUp: boolean;
  /** Chats can reach it now: it runs and its server answered. */
  ready: boolean;
  /** The model chats run on (the alias llama-server serves), null before a model is chosen. */
  model: string | null;
  /** The model's own name, from its repo ("Qwen3.8-27B"), for the line under the entry. */
  modelName: string | null;
  /** The machines lending a GPU, the main machine first: "across 3 machines" is counted from these. */
  machines: string[];
  /** Machines it needs that didn't answer when they were last checked. */
  missing: string[];
  /** Its custom-model accounts by agent: a chat on one of them is a chat on the pool, running or not. */
  accounts: Partial<Record<Provider, string>>;
}

/**
 * Who a pool machine's helper or server runs for: the hub whose pool started it (its id and name) and which start.
 * Another hub's pool can't take it over while that hub still asks about it.
 */
export interface PoolOwner {
  hub: string;
  name: string;
  run: string;
}

/** What a hub reports about itself as a pool machine (GET /api/pool/node), for the hub that runs the pool. */
export interface PoolNodeInfo {
  hubId: string;
  name: string;
  os: "macos" | "linux" | "windows";
  arch: string;
  /** Its Tailscale IPv4, if Tailscale is up. */
  address: string | null;
  /** Builds installed, e.g. ["b11669-vulkan"]. */
  installed: string[];
  /** An install or model download in progress. */
  busy: { what: "install" | "download"; file?: string; doneBytes?: number; totalBytes?: number } | null;
  devices: PoolDevice[];
  /** `owner`: whose pool it runs for (missing from hubs older than that). */
  helper: { running: boolean; port: number | null; detail: string | null; owner?: PoolOwner | null };
  server: { running: boolean; port: number | null; healthy: boolean; detail: string | null; log: string[]; owner?: PoolOwner | null };
  /** Model files already on it (repo/file), so a download can be skipped. */
  models: string[];
  /** Every model file on it with its size, unfinished downloads too (missing from hubs older than this list). */
  files?: PoolModelFile[];
  freeDiskBytes: number | null;
  /**
   * The last install, download or GPU check that failed in the background, in plain words with what to do next
   * (cleared when it's tried again). Missing from hubs older than the model pool.
   */
  lastError?: { what: "install" | "download" | "devices"; detail: string; at: number } | null;
}

/** A privacy dialog waiting on a Mac hub's screen (macOS asks there, and only someone there can answer it). */
export interface MacDialog {
  id: string;
  /** Who asks: the program, and the app macOS asks about ("adb (started by an older Crosstalk)"). */
  app: string;
  /** What for, in plain words ("files on external drives"). */
  wants: string;
  since: number;
  /** How many requests it stands for (a program can ask several times for the same thing). */
  count: number;
  /** The program asking can be stopped from the phone (it's this user's, not part of macOS). */
  stoppable?: boolean;
}

/**
 * Settings → This Mac: what keeps a Mac hub from running unattended, read without changing or asking anything (null:
 * couldn't tell), and the dialogs waiting on its screen.
 */
export interface MacStatus {
  /** The hub can read every file without macOS asking (Full Disk Access). */
  fullDiskAccess: boolean | null;
  /** The user the Mac logs in by itself after a restart (so the hub starts again), if any. */
  autoLogin: string | null;
  /** FileVault is on: automatic login isn't possible then. */
  fileVault: boolean | null;
  /** Minutes until the Mac sleeps on its own (0: never). */
  sleepMinutes: number | null;
  restartsAfterPowerCut: boolean | null;
  wakesForNetwork: boolean | null;
  /** macOS installs its updates, and restarts, by itself. */
  autoUpdates: boolean | null;
  /**
   * When Tailscale signs this Mac out (its key expires: then nothing reaches it), null when it never does; absent when
   * Tailscale isn't on it or couldn't be asked.
   */
  tailscaleExpiry?: number | null;
  dialogs: MacDialog[];
  /**
   * The last time the Mac went down without shutting down, for 7 days or until it's dismissed (null: none to show;
   * absent from older hubs).
   */
  lastCrash?: MacCrash | null;
  checkedAt: number;
}

/** A Mac hub that started this long after the Mac did waited at the login screen for someone to log in. */
export const MAC_LOGIN_WAIT_MS = 3 * 60_000;

/** A Mac hub's machine went down without shutting down: a kernel panic ("crash"), or lost power or froze ("power"). */
export interface MacCrash {
  /** When: the panic's own time, or for "power" when the hub was last seen running. */
  at: number;
  kind: "crash" | "power";
  /** What caused a crash, in plain words ("a fault on a USB port"); null for "power". */
  cause: string | null;
  /** The first line of macOS's panic message, to look up or show a repair shop; null for "power". */
  detail: string | null;
  /** After a USB port's fault: what is plugged into that port now (removable devices, hubs left out). */
  devices: string[];
  /** When Crosstalk ran again. */
  backAt: number;
  /** How long after the Mac started up Crosstalk did (over MAC_LOGIN_WAIT_MS: it waited at the login screen). */
  waitedMs: number;
}

/** The local AI image editor (ComfyUI with its phone page) on a hub: Settings switches it on and off. */
export interface ImageEditorStatus {
  /** It's set up on this machine (its folder and start script are there). */
  installed: boolean;
  /** "starting": the server is coming up; "loading": its model is loading into memory; "ready": edits run at once. */
  state: "off" | "starting" | "loading" | "ready" | "stopping" | "error";
  /** What it's doing, or what went wrong and what to do, in plain words. */
  detail: string | null;
  /**
   * With "error", what didn't work: starting it (nothing runs now), or turning it off (it still runs: Try again turns
   * it off, Keep it on leaves it).
   */
  failed: "start" | "stop" | null;
  /** The editor page: on this machine's Tailscale address (its home network address without Tailscale). */
  url: string | null;
  /** The memory the server uses (MB, as Activity Monitor counts it), while it runs. */
  memoryMB: number | null;
  /** It has edits to do (one running, or waiting). Turning it off then asks first (POST with force). */
  busy: boolean;
}

/** What a new agent starts with, per kind of agent. Empty values mean the agent's own default. */
export interface AgentDefaults {
  permissionMode: PermissionMode;
  model: string | null;
  effort: string | null;
  /** Which of the agent's accounts new agents use (missing: the main account). */
  account?: string;
  /** The model new agents' helper agents (subagents, spawned agents) use; missing: the agent's own model. */
  helperModel?: string | null;
}

/** Settings → Defaults: what new rooms and newly added agents start with. Existing rooms keep their settings. */
export interface RoomDefaults {
  mode: RoomMode;
  /** Which agents join a new room (preselected in New room). Empty means every agent that's signed in. */
  agents: Provider[];
  maxHops: number;
  rounds: number;
  parallel: boolean;
  agent: Partial<Record<Provider, AgentDefaults>>;
}

/**
 * Agents helping each other: a chat's agent may ask the other agent one focused question. Off by default, because
 * every question spends the other agent's plan; the helper gets a short brief (never the chat history), works
 * read-only, and is skipped when its plan is nearly used up.
 */
export interface TeamworkSettings {
  enabled: boolean;
  /** Questions a chat's agent may ask per reply it writes (1-3). */
  perReply: number;
  /** Don't ask an agent whose plan is at or above this share of a limit (50-100). */
  skipAbovePercent: number;
  /** Model and effort the helper answers with: light ones keep questions cheap. Empty means the agent's default. */
  helper: Partial<Record<Provider, { model: string | null; effort: string | null }>>;
}

/** Keeping the hub's disk from filling up (Settings → Storage). */
export interface StorageSettings {
  /**
   * Clear things that are downloaded or rebuilt again when needed, on a schedule: old tool caches, more of them when
   * space runs low, and installed dependencies (node_modules and the like) in chats unused for two weeks.
   */
  autoClean: boolean;
  /** Warn (sidebar and notification) when free space drops below this many GB. */
  lowSpaceGb: number;
}

/** Hub-wide settings (Settings page). */
/**
 * Folders a new chat, group chat or template can work in (GET /api/folders): every folder a chat on this hub works in that
 * still exists, newest use first, then every folder in its workspaces folder (`usedAt` null), by name.
 */
export interface HubFolders {
  root: string;
  folders: { path: string; usedAt: number | null }[];
}

export interface HubSettings {
  /** What this machine is called in the app; empty: its computer name. */
  machineName: string;
  /**
   * Agents in this machine's chats can find, read and message the user's other chats, here and on linked machines
   * (where it's on too), and agents there can reach chats here. Off until the user turns it on.
   */
  agentsAcrossChats: boolean;
  /** Stop agents handing work to an agent whose plan is at 90% of a usage limit, until the human replies. */
  pauseNearLimit: boolean;
  /** Look up model prices online (models.dev, OpenRouter) to work out what a reply cost when the agent doesn't say. Absent: on. */
  priceLookup?: boolean;
  /**
   * When an agent's plan runs out of messages, the chat waits and picks itself back up once the limit resets, instead
   * of leaving a failed reply (LimitWait). Absent: on.
   */
  carryOnAfterLimit?: boolean;
  /**
   * "Keep going while helpers work": while an agent's helpers work, your messages go straight to it, around new settings
   * that wait for those helpers, and they apply when the helpers finish (engine.ts flowIn, heldForSettings). Off: such a
   * message waits for the helpers so the new settings apply first, and Send now or Answer now send one sooner. An account
   * switch, tighter permissions or a new folder hold it either way. This machine's own: it doesn't reach linked machines,
   * each has its own. HubInfo.messagesFlow follows it. Absent: on.
   */
  messagesFlow?: boolean;
  teamwork: TeamworkSettings;
  storage: StorageSettings;
}

/** The hub's disk at a glance: shown as a warning when space is low. */
export interface StorageStatus {
  total: number;
  free: number;
  /** Uploads are refused below this much free space. */
  reserve: number;
  /** Below the warning level the human chose. */
  low: boolean;
}

/**
 * Something in a chat folder that can be deleted to free space. `build`: build output or installed dependencies,
 * made again by the next build. `upload`: something the human sent in the chat. `large`: any other big folder or file.
 */
export interface StorageItem {
  id: string;
  kind: "build" | "upload" | "large";
  /** Its path inside the chat folder (an upload's original name). */
  name: string;
  path: string;
  bytes: number;
  modifiedAt: number;
  /** The chats that use the folder it's in. */
  chats: string[];
  /** When one of those chats was last used. */
  chatActiveAt: number | null;
  /** What deleting it means. */
  note: string;
}

export interface StorageChatFolder {
  path: string;
  chats: string[];
  bytes: number;
  activeAt: number | null;
}

/** Something the hub cleared, for the "Recently cleared" list. */
export interface StorageCleared {
  at: number;
  what: string;
  bytes: number;
  /** Cleared on its own (not from the review list). */
  auto: boolean;
}

export interface StorageReport {
  status: StorageStatus;
  /** When the folders were last measured; null before the first scan. */
  scannedAt: number | null;
  /** What the hub is doing right now (the page checks back until it's done). */
  busy: "scanning" | "cleaning" | "deleting" | null;
  /** How the last delete from the review list went. */
  lastDelete: { at: number; removed: number; bytes: number; failed: { name: string; error: string }[] } | null;
  chats: StorageChatFolder[];
  items: StorageItem[];
  /** The Trash's size, when it can be read: deleting into it frees nothing until it's emptied. */
  trash: number | null;
  /** Tool caches the hub clears, with their current size. */
  caches: { what: string; bytes: number }[];
  cleared: StorageCleared[];
}

export const FACTORY_TEAMWORK: TeamworkSettings = {
  enabled: false,
  perReply: 1,
  skipAbovePercent: 80,
  helper: { claude: { model: "sonnet", effort: "low" }, codex: { model: null, effort: "low" } },
};

export const FACTORY_STORAGE: StorageSettings = { autoClean: true, lowSpaceGb: 15 };

export const FACTORY_HUB_SETTINGS: HubSettings = { machineName: "", agentsAcrossChats: false, pauseNearLimit: false, carryOnAfterLimit: true, messagesFlow: true, teamwork: FACTORY_TEAMWORK, storage: FACTORY_STORAGE };

export const FACTORY_DEFAULTS: RoomDefaults = { mode: "review", agents: [], maxHops: 5, rounds: 1, parallel: false, agent: {} };

/** The id of an agent's own sign-in (the one its CLI uses by default). */
export const DEFAULT_ACCOUNT = "default";

/** Agents whose CLI can keep separate sign-ins in separate folders, so several accounts can be used side by side. */
export const MULTI_ACCOUNT_PROVIDERS: Provider[] = ["claude", "codex", "antigravity", "gemini"];

/** One signed-in identity for an agent. Several accounts of the same agent can be in use at once. */
export interface AgentAccount {
  provider: Provider;
  /** "default" for the agent's own sign-in; a short random id for extra accounts. */
  id: string;
  /** Your name for it, e.g. "Work" or "Personal". */
  label: string;
  /**
   * "apikey": usage-billed through an API key stored on the hub, instead of a plan sign-in. "endpoint": a model
   * server of your own (say, a local model in llama.cpp), which the agent uses instead of its vendor's models.
   */
  kind?: "signin" | "apikey" | "endpoint";
  /** Claude API keys that cover a whole organization bill the workspace named here (sent as anthropic-workspace-id). */
  workspaceId?: string | null;
  /** A custom model server (kind "endpoint"). */
  endpoint?: EndpointInfo | null;
  signedIn: boolean | null;
  /** Email or username the agent reports for this sign-in: how to tell accounts apart. */
  account: string | null;
  plan: string | null;
  authMethod: string | null;
  error: string | null;
  checkedAt: number;
}

/** A custom model server: where it is, the models it serves (the first is the default), and their context size. */
export interface EndpointInfo {
  /** e.g. http://127.0.0.1:8080 (without /v1). */
  baseUrl: string;
  models: string[];
  /** Tokens of context the server gives each request; chats compact before reaching it. */
  contextWindow: number | null;
  hasKey: boolean;
  /** What the server speaks (absent: what the agent speaks natively). "chat" = Chat Completions only: Codex reaches it through the hub's local translator. */
  protocol?: Protocol;
  /** The upstream's chat path when it isn't /v1/chat/completions. */
  chatPath?: string;
  /**
   * What a Codex request to this service was last measured to cost, on whichever of its models was used last: the service's
   * catalogue is the same for all of them. Missing until a request has gone through the chat adapter (see ToolCost).
   */
  toolCost?: ToolCost;
  /** Context window per model (contextWindow is the fallback). */
  contexts?: Record<string, number>;
  /**
   * Fields this service wants in every chat request besides the ones the agent's own request makes (Venice's
   * `venice_parameters`, which switches off the system prompt Venice would add). Used by the chat adapter, which merges
   * them under what it builds itself: none of them can replace the model, the messages, the tools or the stream.
   */
  extra?: Record<string, unknown>;
}

/** What a model server reported when checked (Settings → Add a custom model). */
export interface EndpointProbe {
  baseUrl: string;
  models: string[];
  contextWindow: number | null;
  /** What kind of server answered, when it could tell (e.g. "llama.cpp", "LM Studio", "Ollama"). */
  server: string | null;
}

/** Which account a room member uses ("default" when not set). */
export function memberAccount(m: { config?: Record<string, unknown> }): string {
  return typeof m.config?.account === "string" && m.config.account ? m.config.account : DEFAULT_ACCOUNT;
}

/** One kind of agent's work in a room: finished turns and output tokens. Sorted most work first. */
export interface RoomActivity {
  provider: Provider;
  turns: number;
  outputTokens: number;
}

// ===================================================================== 0.4: Ask others (docs/SPEC-0.4.md, T1/T2)

export type AskStatus = "queued" | "running" | "done" | "error" | "stopped";

/** Which agent, on which account, with which model, answers an ask. The hub resolves a null model to the catalog's default. */
export interface AskTarget {
  provider: ChatProvider;
  account: string;
  model: string | null;
  effort: string | null;
  /** 0.5: the hub id of another of the person's linked machines that runs it (absent: this machine). `account` is that machine's own. */
  machine?: string;
}

/** How sure the cost figure is: "exact" (the agent reported it), "estimated" (tokens x a price list), "unknown", "plan" (a plan sign-in: a notional figure), "free" (a model on this machine). */
export type CostBasis = "exact" | "estimated" | "unknown" | "plan" | "free";

export interface AskCost {
  costUsd: number | null;
  basis: CostBasis;
  inputTokens: number;
  outputTokens: number;
}

/** One agent's answer to "what do you think of this message?", shown as a card under it. */
export interface Ask {
  id: string;
  roomId: string;
  /** The message asked about. */
  messageId: string;
  target: AskTarget;
  /** The card's title in plain words: "Codex · GPT-5.5". */
  label: string;
  status: AskStatus;
  answer: string | null;
  /** Plain words: what went wrong and what to do. */
  error: string | null;
  cost: AskCost | null;
  /** The user's own question, when they typed one. */
  note: string | null;
  /** Ran on a model that stays on this machine. */
  local: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** One row of the "Ask others" sheet and of the @ popup. */
export interface AskChoice {
  target: AskTarget;
  label: string;
  /** "API key", "Plan", "On this Mac". */
  sub: string;
  /** What to type after @. */
  handle: string;
  paid: "yes" | "no" | "unknown";
  local: boolean;
  available: boolean;
  /** When not available: "Over its $250 limit", "Not signed in", ... */
  why: string | null;
  /** The average cost of this target's finished asks, when it has some. */
  typicalCostUsd: number | null;
  /** 0.5: the other machine it runs on, with the name the person gave it (absent: this machine). */
  machine?: { id: string; name: string };
  /**
   * Newer than 0.6.1: the models the sheet offers for it (GET /api/asks/targets?models=1; another machine's hub sends its own), each with
   * what an ask on it costs. Only on rows that can be asked. Absent: no choice here (an older hub, or `fixedModel` says why).
   */
  models?: AskModel[];
  /** Newer than 0.6.1: why its model can't be chosen in the sheet (the sheet says it in words). Absent: it can, or the hub is older. */
  fixedModel?: AskFixedModel;
  /**
   * Newer than 0.6.1: the model and effort the person last picked for it in the sheet (null: its default, whatever that is then), which
   * `target` and `label` already follow, and so does an @name. Absent: nothing picked yet (or the pick isn't listed now).
   */
  remembered?: AskPick;
}

/**
 * Newer than 0.6.1: a model an ask can run on, as the sheet offers it: the agent's own entry from its live model list (the same list,
 * "No tools" mark, context size and effort levels every model picker shows) and what an ask on it costs.
 */
export interface AskModel extends ModelOption {
  /** Whether an ask on this model costs money (AskChoice.paid, for this model). */
  paid: "yes" | "no" | "unknown";
  /** What this target's finished asks on this model cost, on average, when it has some. */
  typicalCostUsd: number | null;
}

/** Newer than 0.6.1: why a target's model can't be picked: the model pool runs one model at a time; another machine needs a Crosstalk update first. */
export type AskFixedModel = "pool" | "update";

/** Newer than 0.6.1: a model and effort picked for a target (null: its default). */
export interface AskPick {
  model: string | null;
  effort: string | null;
}

/**
 * Newer than 0.6.1: POST /api/asks may say what to keep for next time (`remember`): one of these per target asked, the pick as the sheet
 * showed it. Kept only for targets in that request, and only once it was accepted.
 */
export interface AskMemo extends AskPick {
  provider: ChatProvider;
  account: string;
  /** Another linked machine's hub id (absent: this machine). */
  machine?: string;
}

/** 0.5: a linked machine whose models couldn't be listed: said once under the list, in plain words, with Try again. */
export interface AskMachineNote {
  id: string;
  name: string;
  /** "The PC didn't answer." */
  why: string;
}

/** GET /api/asks/targets?machines=1 (without it, only the rows): who can be asked, and the machines that couldn't say. */
export interface AskTargets {
  choices: AskChoice[];
  machines: AskMachineNote[];
}

// ===================================================================== 0.4: Spend and limits (T3/T4)

export interface SpendTotals {
  usd: number;
  replies: number;
  /** Replies without a price (not counted in usd). */
  unpriced: number;
  /** Replies whose figure is worked out from tokens and a price list rather than reported by the agent: show "≈" when above 0 (absent from older hubs). A plan sign-in's notional figures aren't counted: its kind says so. */
  estimated?: number;
  inputTokens: number;
  outputTokens: number;
}

/** A spending limit on one account: per calendar month, or in total since `since`. */
export interface Budget {
  limitUsd: number;
  period: "month" | "total";
  /** Start of the count for "total" (ms). */
  since: number;
  /** "provider:account" of the rows of this one service, each on its own agent (it was moved): what they spent counts here too. */
  also?: string[];
}

export interface BudgetState extends Budget {
  usedUsd: number;
  percent: number;
  state: "ok" | "warn" | "stopped";
}

export interface AccountSpend {
  provider: Provider;
  account: string;
  label: string;
  kind: "signin" | "apikey" | "endpoint";
  today: SpendTotals;
  month: SpendTotals;
  total: SpendTotals;
  budget: BudgetState | null;
  /**
   * The account's key is on a plan of one flat fee for the month however much you use it (a Featherless key the hub last
   * read as on its Chat plan, whose terms don't allow agents), so its replies carry no price of their own and nothing can
   * count against a limit. Absent (and false) for every other account, a Featherless key on its Developer plan included;
   * not in the contract yet, so an older hub doesn't send it.
   */
  flat?: boolean;
}

export interface SpendSummary {
  accounts: AccountSpend[];
  updatedAt: number;
  /** Where prices came from and when (null when none were looked up). */
  prices: { source: string; fetchedAt: number | null } | null;
}

export interface ChatSpend {
  roomId: string;
  usd: number;
  replies: number;
  unpriced: number;
  /** Replies whose figure is worked out from tokens, or a plan's notional one: show "≈" when above 0 (absent from older hubs). */
  estimated?: number;
  /**
   * The same, for each account that answered in the chat: a group chat's agents can be billed differently (a plan sign-in
   * beside an API key), so each agent's part is said in its own words. Absent from hubs before 0.6.2.
   */
  byAccount?: (Omit<ChatSpend, "roomId" | "byAccount"> & { provider: Provider; account: string })[];
}

// ===================================================================== 0.4: AI services (T5/T6/T7)

/** What a model server speaks: the Responses API (Codex), the Messages API (Claude Code), or only Chat Completions. */
export type Protocol = "responses" | "messages" | "chat";
export type Support = "yes" | "no" | "unknown";

export interface ServiceTestRequest {
  baseUrl: string;
  /** A key typed in the form... */
  apiKey?: string;
  /** ...or the saved key of an existing account. */
  accountId?: string;
  provider?: ChatProvider;
  /** The upstream's chat path when it isn't /v1/chat/completions. */
  chatPath?: string;
}

/** What checking a service found, with free probes only (no model request). */
export interface ServiceTestResult {
  reachable: boolean;
  authOk: boolean | null;
  server: string | null;
  protocols: Record<Protocol, Support>;
  /**
   * `tools`: whether the model can run tool calls, where the service says so (absent, or null: it didn't say). A service
   * Crosstalk knows more about (Refuseless) adds the model's own name, its price per million tokens and whether it is
   * uncensored, for the sheet to say beside it; absent for every other service, and from hubs before 0.6.5.
   */
  models: { id: string; contextWindow: number | null; tools?: boolean | null; name?: string; price?: TokenPrice; uncensored?: boolean }[];
  /**
   * How Crosstalk can run it: which agent, and over which protocol ("adapter" = through the local translator). Crosstalk's
   * own agent ("builtin") and OpenCode speak Chat Completions to the service themselves.
   */
  works: { provider: ServiceAgent; via: Protocol | "adapter" }[];
  /** Plain words, each with its fix. */
  problems: string[];
  /**
   * The service's model list is too long to show (Featherless serves every model on Hugging Face): how many models it
   * has, and which catalogue the hub can search for one (GET /api/services/catalog). `models` is empty for those: you
   * find a model by name instead of picking from a list.
   */
  catalog?: { name: CatalogName; total: number };
  /**
   * What the key's account has to spend, where the service says (NanoGPT's balance and subscription, Refuseless's credit):
   * read with the key by free requests only, once the key was accepted. Absent for every other service, and from hubs
   * before 0.6.4.
   */
  funds?: ServiceFunds;
  /**
   * Which plan the key is on, where the service says (Featherless's GET /v1/plan): read with the key by one free request,
   * unless the key was refused. Absent for every other service, when the read failed, and from hubs before 0.6.7.
   */
  plan?: ServicePlan;
}

/**
 * The plan a key is on, as the service itself says (Featherless's GET /v1/plan, read with the key: free, nothing runs).
 * It decides what Crosstalk says about using the key with an agent. Featherless's $25 Chat plan is a flat fee for a person
 * typing, and its terms forbid coding agents, API traffic and background automation; agents need its Developer plan, paid
 * per token from prepaid credits (featherless.ai/pricing, read on 4 November 2026).
 */
export interface ServicePlan {
  /** The service's own id and name for it ("feather_pro_plus", "Feather Premium"; "feather_request_pricing", "Request Pricing"). */
  id: string;
  name: string;
  /**
   * What it means for an agent: "chat", one flat fee a month for a person typing, whose terms don't allow agents or API
   * use (Featherless's Chat plan, and its older Basic and free Lite plans); "credits", paid per token from prepaid
   * credits, agents allowed (its Developer and Pay-As-You-Go plans); "other", a plan Crosstalk can't vouch for, so nothing
   * is said about what it allows.
   */
  kind: "chat" | "credits" | "other";
  /** The most a request may hold on this plan, in tokens; null: the plan has no cap of its own (each model's own applies). */
  maxContext: number | null;
  /** The plan's concurrent units (a big model's request reserves more than one); null when it didn't say. */
  concurrency: number | null;
  /** When it was read (ms). */
  checkedAt: number;
}

/**
 * A plan's name as Crosstalk's words say it ("its Chat plan", "the Developer plan"). Featherless's own plan list calls its
 * two plans on sale "Feather Chat (formerly Premium)" and "Request Pricing" (its docs' example answer, "Feather Premium"),
 * while its pricing page, where a person picks one, says Chat and Developer: those are the names used. Any other plan
 * keeps the service's own name, without "Feather" or "Featherless" in front or "(formerly …)" after it ("Basic", "Max").
 */
export function planLabel(plan: Pick<ServicePlan, "id" | "name" | "kind">): string {
  const id = plan.id.toLowerCase();
  if (id === "feather_pro_plus") return "Chat";
  if (id === "feather_request_pricing" || /request.?pricing/i.test(plan.name)) return "Developer";
  const name = plan.name.replace(/\s*\(formerly[^)]*\)/i, "").replace(/^feather(?:less)?\s+/i, "").replace(/\s+plan$/i, "").trim();
  // An id standing in for a name (the service gave none): what kind of plan it is says more than the id would.
  if (!name || name.includes("_")) return plan.kind === "credits" ? "Developer" : plan.kind === "chat" ? "Chat" : plan.id;
  return name;
}

/**
 * The big model catalogues the hub can search: Featherless (api.featherless.ai, every model on Hugging Face) and NanoGPT
 * (nano-gpt.com, several hundred models from many makers, each with a price of its own).
 */
export type CatalogName = "featherless" | "nanogpt";

/**
 * Which part of a catalogue a search looks in (NanoGPT): the models it files as uncensored, the ones its subscription
 * covers, or all of them. Featherless has no filter of its own: a search there is its uncensored shortlist or a name.
 */
export type CatalogFilter = "uncensored" | "plan" | "all";

/** USD per million tokens, as the service's own list prices a model: input, output, and cached input (null: no separate price). */
export interface TokenPrice {
  input: number;
  output: number;
  cached: number | null;
}

/** One of a subscription's allowances (input tokens a week, or a day): a null field is one the service didn't say. */
export interface Allowance {
  used: number | null;
  limit: number | null;
  /** When it starts again (ms). */
  resetAt: number | null;
}

/**
 * What an account on a pay-as-you-go service has to spend: NanoGPT's balance and subscription (POST /api/check-balance,
 * GET /api/subscription/v1/usage), or Refuseless's credit (GET /v1/credits), read with the account's key by free
 * requests — never a model request.
 */
export interface ServiceFunds {
  /** What is left to spend, in US dollars; null when it couldn't be read. Refuseless: what a new request can still reserve. */
  balanceUsd: number | null;
  /**
   * Credit held right now by replies still running (Refuseless reserves each request's worst case before it starts, and
   * gives back what it didn't use when it ends); absent where the service doesn't say.
   */
  heldUsd?: number | null;
  /** The subscription (NanoGPT's $12 a month); null when the account has none, or it couldn't be read. */
  plan: {
    active: boolean;
    /**
     * Where a reply on a model the subscription covers is billed now, as the service advises for this key: "subscription"
     * (its allowance), "paygo" (the balance: the allowance is used up, or the key spends money only), "unavailable"
     * (neither), or null when it didn't say.
     */
    billing: "subscription" | "paygo" | "unavailable" | null;
    weekly: Allowance | null;
    daily: Allowance | null;
    /** When the subscription's month ends (ms), when the service says. */
    renewsAt: number | null;
  } | null;
  /** When this was read (ms). */
  checkedAt: number;
}

/** One model of a searched catalogue (GET /api/services/catalog), with only what a phone shows beside its name. */
export interface CatalogModel {
  /** The name a request uses, which for Featherless is the Hugging Face repo ("Qwen/Qwen3.5-27B"). */
  id: string;
  /** How the service groups the model ("qwen3.5-27b"): its family and size. */
  modelClass: string | null;
  /** Billions of parameters, read off the class, for the size beside the name (27 = "27B"). Null when the class doesn't say. */
  params: number | null;
  /** The model's own context, as the list gives it. */
  contextWindow: number | null;
  /** What one request of this model reserves of a plan's concurrent units (Featherless: 1, 2 or 4). */
  concurrency: number | null;
  /** The model needs its licence agreed on the service's own page first, or it answers 403. */
  gated: boolean;
  /**
   * Whether tool calls work, which an agent needs. It comes from what the maker documents per model family, not from
   * anything the server told us about this model: `toolsSaid` says where it came from so the words can be honest.
   */
  tools: boolean;
  /**
   * Where that stands: "docs" when the maker's own docs settle it, "list" when they don't name this family but the
   * service's model list claims tool calls for it anyway. Crosstalk goes by the docs either way, so "list" means the
   * words say the docs don't promise it rather than that the model can't do it. "service": the service states it per
   * model in its own list, and stands behind that list (NanoGPT's `capabilities.tool_calling`).
   */
  toolsSaid: "docs" | "list" | "service";
  /** The service's own name for it ("DeepSeek V4.1 Flash"), where its list gives one (NanoGPT). */
  name?: string;
  /**
   * What it costs per million tokens on this service, from the service's own list (NanoGPT; Featherless, whose Developer
   * plan bills each model at its own rate); absent where the list gives no price.
   */
  price?: TokenPrice;
  /** The service's subscription covers it (NanoGPT's $12 a month: its list's `subscription.included`). */
  inPlan?: boolean;
  /** The service files it as uncensored, or its name says so (abliterated, heretic, derestricted, uncensored). */
  uncensored?: boolean;
  /** It can think before answering (NanoGPT's `capabilities.reasoning`). */
  reasoning?: boolean;
}

/** What searching a catalogue found (GET /api/services/catalog?q=…). */
export interface CatalogSearch {
  name: CatalogName;
  /** What was searched for ("" = the service's own suggestions). */
  q: string;
  /** The part of the catalogue it looked in, where the service has more than one (NanoGPT); absent for Featherless. */
  filter?: CatalogFilter;
  /** The models to show, best first, at most CATALOG_SHOWN. */
  models: CatalogModel[];
  /** How many models matched in all (more than `models.length` means "type more to narrow it down"). */
  matched: number;
  /** How many the catalogue has altogether. */
  total: number;
}

/** The most models one catalogue search answers with: a phone list you can read, not a page of 100. */
export const CATALOG_SHOWN = 25;

/** A model server found running on this machine. */
export interface LocalServer {
  id: string;
  kind: "ollama" | "lmstudio" | "llamacpp" | "vllm" | "mlx" | "other";
  label: string;
  baseUrl: string;
  /**
   * `tools`: whether the model can run tool calls, where the list says so (absent, or null: it didn't say). `uncensored`:
   * the list says the model's refusals were taken out of its weights (Refuseless's `abliterated`); absent where it says nothing.
   * `efforts`, `defaultEffort`: the thinking levels the model takes and the one it uses unless asked, where the list says.
   */
  models: { id: string; contextWindow: number | null; sizeBytes: number | null; loaded: boolean; tools?: boolean | null; uncensored?: boolean; efforts?: string[]; defaultEffort?: string | null }[];
  memoryBytes: number | null;
  protocols: Record<Protocol, Support>;
  /** Endpoint accounts already using it. */
  accountIds: { provider: ChatProvider; id: string }[];
}

/**
 * How Crosstalk can run a server, from what each of its addresses answered: Codex on the Responses API, Claude Code on
 * Messages, else Codex through the hub's own translator. The hub checks services with it; the app reads it off a server
 * found on this machine, so the New chat menu names the agent that a one-tap add will really use.
 */
export function serviceWorks(p: Record<Protocol, Support>): { provider: ChatProvider; via: Protocol | "adapter" }[] {
  const out: { provider: ChatProvider; via: Protocol | "adapter" }[] = [];
  if (p.responses === "yes") out.push({ provider: "codex", via: "responses" });
  if (p.messages === "yes") out.push({ provider: "claude", via: "messages" });
  if (p.responses !== "yes" && p.chat === "yes") out.push({ provider: "codex", via: "adapter" });
  return out;
}

/** The most models one service keeps: the hub saves the first 20, and that's what a model menu offers. */
export const SERVICE_MAX_MODELS = 20;

/**
 * The models of a service's list that an account can keep: no blank or over-long names, none with a space in it (an
 * agent passes a model name as one word), and each one once. Settings → AI services and a one-tap add from the New chat
 * menu both clean the list this way before picking, so a one-tap add saves the models the sheet would have ticked.
 */
export function serviceModelsKept<T extends { id: string }>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (!m.id || m.id.length > 200 || /\s/.test(m.id) || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/**
 * The models a service is added with when nobody picks them: every model it listed (only its uncensored ones, when it
 * marks some), minus the ones it says can't run tool calls (an agent on one of those couldn't read a file or run a
 * command). A list longer than SERVICE_MAX_MODELS is
 * one to pick from, so this gives none. Settings → AI services and a one-tap add from the New chat menu both use it, so
 * the account is the same whichever way it was added. Give it a list `serviceModelsKept` has been through.
 */
export function serviceModelPick(models: { id: string; tools?: boolean | null; uncensored?: boolean }[]): string[] {
  if (models.length > SERVICE_MAX_MODELS) return [];
  // A service that marks its uncensored models (Refuseless's abliterated ones) is added for those: its stock models stay
  // in the list to tick by hand.
  const pool = models.some((m) => m.uncensored) ? models.filter((m) => m.uncensored) : models;
  return pool.filter((m) => m.tools !== false).map((m) => m.id);
}

/**
 * The agent a checked service is added for: the one picked, else the preferred one if it can run it, else the first that
 * can. An agent that isn't installed comes last (`installed` says false for those; unknown counts as installed).
 */
export function serviceAgentFor(
  works: { provider: ServiceAgent }[],
  preferred: ServiceAgent,
  picked?: ServiceAgent | null,
  installed: Partial<Record<ServiceAgent, boolean>> = {},
): ServiceAgent | null {
  const can = [...new Set(works.map((w) => w.provider))];
  if (picked && can.includes(picked)) return picked;
  const ready = can.filter((p) => installed[p] !== false);
  const pool = ready.length ? ready : can;
  return pool.includes(preferred) ? preferred : (pool[0] ?? null);
}

/**
 * A server on the hub's own machine (the hub only ever looks at loopback addresses for those). The whole hostname has to
 * be a loopback one: a name that merely starts with the digits ("127.0.0.1.nip.io") is somebody else's machine.
 */
export function isLocalAddress(url: string | null | undefined): boolean {
  try {
    const host = new URL(url ?? "").hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

// ===================================================================== 0.5 Search (docs/SPEC-0.4.md section 14, T8)

/** A search needs at least this many characters. */
export const SEARCH_MIN_CHARS = 2;
/** The most hits one answer holds, and the most of them from one chat. */
export const SEARCH_MAX_HITS = 30;
export const SEARCH_PER_CHAT = 3;

/** A message that matches a search (GET /api/search?q=…). */
export interface SearchHit {
  roomId: string;
  roomName: string;
  messageId: string;
  /** Its place in the chat's order: the app pages back until it has it. */
  seq: number;
  /** Who said it: you, or an agent (a message another chat's agent sent counts as an agent's, never as yours). */
  who: "you" | "agent";
  /**
   * Which agent, when it isn't the chat's own: the one in another chat that sent it here, or whose reply was copied here
   * ("Codex"). Absent for your messages, the chat's own agent's, and from hubs before this.
   */
  agent?: string;
  /** About 140 characters around the first match, on one line, the match itself as written. */
  snippet: string;
  createdAt: number;
}

/** A chat whose name matches a search. */
export interface SearchChat {
  roomId: string;
  roomName: string;
  updatedAt: number;
}

export interface SearchResponse {
  /** Newest first: at most SEARCH_MAX_HITS, and SEARCH_PER_CHAT from one chat. */
  results: SearchHit[];
  /** Chats whose names match (newest first). Absent from hubs that only search messages. */
  chats?: SearchChat[];
  /** There are more matches than `results` holds. */
  truncated: boolean;
}

/** The file name a chat's Markdown export is saved under (GET /api/chats/:id/export.md): its name, safe for any system. */
export function markdownFileName(chatName: string): string {
  const base = chatName
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base || "Chat"}.md`;
}

// ===================================================================== 0.5 Local models (docs/SPEC-0.5.md, T10)

/** One model of a model server on this machine: whether it's in memory, what it holds, and whether Crosstalk can switch it. */
export interface LocalModel {
  id: string;
  /** In memory now. Null when the server doesn't say (mlx-lm and servers Crosstalk doesn't know). */
  loaded: boolean | null;
  /** Loading right now: llama.cpp's router says so; for Ollama this hub does, while a load it asked for goes on (a big model can take longer than the answer to the phone waits). */
  loading: boolean;
  contextWindow: number | null;
  /** Its size on disk, where the server says. */
  sizeBytes: number | null;
  /** What the server says it holds in memory for this model now (Ollama's `size`); null when it isn't loaded or doesn't say. */
  memoryBytes: number | null;
  /** The part of that in graphics memory (Ollama's `size_vram`). */
  vramBytes: number | null;
  /** When the server frees it by itself (ms since 1970, Ollama's `expires_at`); null when it isn't known or it stays loaded. */
  expiresAt: number | null;
  /** Crosstalk can load it and free it (Ollama; llama.cpp's router mode). When not, `why` says what to do instead. */
  canSwitch: boolean;
  why: string | null;
}

/** A model server on this machine with its memory (Settings → Local models). */
export interface LocalModelServer extends Omit<LocalServer, "models"> {
  models: LocalModel[];
  /** What the server's own processes use (the one that listens on its port and those it started, as `ps` counts them); null when that can't be told. */
  processBytes: number | null;
  /** Inherited: what the server holds in memory now, the larger of `processBytes` and what its loaded models say they hold; null when neither is known. */
  memoryBytes: number | null;
  /** Crosstalk started it (`LocalStarted.id`): Stop ends it. Older hubs leave it out. */
  startedId?: string | null;
  /** Why Crosstalk won't stop it (it didn't start it), in plain words with what to do instead. */
  stopWhy?: string | null;
}

/** GET /api/local-models */
export interface LocalModelsView {
  servers: LocalModelServer[];
  scannedAt: number;
}

/** POST /api/local-models/switch: answers the server as it is read right afterwards. */
export interface LocalModelSwitch {
  serverId: string;
  model: string;
  on: boolean;
}

// ===================================================================== 0.5 Local models: downloads, "fits this machine?", starting and stopping servers

/** What this machine has for running models, for the "fits this machine?" verdict. */
export interface LocalMachine {
  ramBytes: number;
  /** Apple silicon: the GPU shares the memory, up to Metal's working set (`gpuBytes`). */
  unified: boolean;
  /** Graphics memory a model can use: Metal's working set on Apple silicon, else what the GPUs have free; null without a GPU (or when it isn't known). */
  gpuBytes: number | null;
  /** How `gpuBytes` is known: llama.cpp measured it, or (Apple silicon, llama.cpp not there yet) a share of the memory. */
  gpuFrom: "llama.cpp" | "estimate" | null;
  /** The GPUs llama.cpp lists. */
  gpus: { name: string; totalBytes: number; freeBytes: number }[];
}

// ---- "Fits this machine?" (one opinion, used by the phone and by the hub's memory guard) ----
//
// These were the Settings screens' own (web/src/localLibrary.ts) until the hub needed the same verdict before it
// starts anything heavy. There is one copy, here, so a download, a server start and the guard can never disagree.

const FIT_GiB = 1024 ** 3;

/** A file or download size, as the whole app writes them: "15.6 GB", "640 MB", "8 KB". */
export function bytesText(n: number): string {
  if (n >= FIT_GiB) return `${(n / FIT_GiB).toFixed(n >= 100 * FIT_GiB ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** A token's KV cache when the file's header couldn't be read: about a 7B to 14B model's (128 KiB). */
export const FALLBACK_KV = 128 * 1024;
/** llama.cpp's headroom on each device (its --fit-target) and working buffers: about 1 GB. */
export const OVERHEAD = FIT_GiB;
/** Of what a machine can give, a model that needs more than this share is tight. */
export const TIGHT = 0.85;

/** What a model needs in memory at a context: its weights (the file), its KV cache, and llama.cpp's headroom. */
export interface Need {
  bytes: number;
  /** The context counted: the one asked for, or less when the model was trained for less. */
  context: number;
  /** The KV cache is from the file's header; else it's about a mid-size model's. */
  sure: boolean;
}

export function needOf(fileBytes: number, kvBytesPerToken: number | null, context: number, contextLength: number | null): Need {
  const ctx = contextLength && contextLength > 0 ? Math.min(context, contextLength) : context;
  return { bytes: fileBytes + (kvBytesPerToken ?? FALLBACK_KV) * ctx + OVERHEAD, context: ctx, sure: kvBytesPerToken !== null };
}

/** Memory models can use on the processor: all of it but what the system and other apps keep (a quarter, at least 4 GB). */
export const ramRoom = (ramBytes: number) => Math.max(0, ramBytes - Math.max(4 * FIT_GiB, ramBytes / 4));

/**
 * What models can use on this machine: Metal's working set on a Mac with Apple silicon, the GPUs' free memory on a PC,
 * else the memory. On Apple silicon the GPU's memory *is* the machine's, so the system's share is held back there too
 * (it wasn't, and that is how a 10 GB model read as "Fits" on a 16 GB Mac already holding a 12.5 GB image model).
 */
export function capacity(m: LocalMachine): { bytes: number; on: "gpu" | "memory" } {
  if (m.unified) return { bytes: Math.min(m.gpuBytes ?? 0, ramRoom(m.ramBytes)), on: "gpu" };
  if ((m.gpuBytes ?? 0) > 0) return { bytes: m.gpuBytes ?? 0, on: "gpu" };
  return { bytes: ramRoom(m.ramBytes), on: "memory" };
}

/**
 * Which memory a heavy thing draws on. "gpu" is llama.cpp and the model pool's server, which live inside Metal's
 * working set (or a card's VRAM). "ram" is the image editor: ComfyUI is not llama.cpp, it is not held to Metal's
 * working set, and holding it to one is how a machine that runs it fine refused to start it (measured on a
 * 16 GB Mac: 12.48 GiB resident, against a working-set ceiling of 10.67 GiB).
 */
export type MemoryPool = "gpu" | "ram";

/**
 * What a start of this kind can use here, and what it is up against, with `taken` (what the other heavy things hold,
 * as host memory) counted only where it is the same memory:
 *  - unified memory (Apple silicon): one pool, so what others hold comes off the top;
 *  - a discrete GPU: two pools. `gpuBytes` is already the cards' *free* VRAM, so subtracting host memory from it
 *    would both double-count (a big unrelated process would read as an empty GPU being full) and miss (another
 *    program holding 15 GB of VRAM with a small RSS would be invisible). Host pressure is the band's business.
 *  - "ram": the machine's memory less what is held, which is the honest ceiling for anything that isn't llama.cpp.
 */
export function roomFor(m: LocalMachine, taken: number, on: MemoryPool = "gpu"): { freeBytes: number; totalBytes: number; on: "gpu" | "memory" } {
  const held = Math.max(0, taken);
  if (on === "ram") return { freeBytes: Math.max(0, m.ramBytes - held), totalBytes: m.ramBytes, on: "memory" };
  const cap = capacity(m);
  if (cap.on === "gpu" && !m.unified) return { freeBytes: cap.bytes, totalBytes: cap.bytes, on: "gpu" };
  return { freeBytes: Math.max(0, cap.bytes - held), totalBytes: cap.bytes, on: cap.on };
}

export type FitKind = "fits" | "tight" | "slow" | "big";
export interface Fit {
  kind: FitKind;
  /** The pill: Fits, Tight, Slow, Too big. */
  label: string;
  tone: "green" | "orange" | "red";
  /** The verdict in a sentence, with what to do when it doesn't fit well. */
  line: string;
}

/**
 * Whether a model that needs `need` bytes fits `machine` ("Mac mini"), with headroom: up to 85% of what it can give
 * fits, up to all of it is tight, more is too big. A PC whose GPU is too small still runs it, slowly, when the rest
 * fits in its memory (llama.cpp puts some layers on the processor). Without a GPU it runs on the processor, slowly.
 *
 * `taken` is memory other heavy things hold right now (the hub's memory guard passes it; the download screens pass
 * nothing, because a download is for later). It is taken off what the machine can give, so the verdict is about the
 * machine as it is, not an empty one.
 */
export function fitOf(need: number, m: LocalMachine, machine: string, taken = 0): Fit {
  const cap = capacity(m);
  // `roomFor`, so the pill and the hub's memory guard are one opinion (a discrete GPU's free VRAM is its own pool).
  const free = roomFor(m, taken).freeBytes;
  const n = bytesText(need);
  const left = free > 0 ? `${bytesText(free)} of the ${bytesText(cap.bytes)} models can use is free` : `none of the ${bytesText(cap.bytes)} models can use is free`;
  const of = taken > 0 ? `${n}, and ${left}` : `${n} of the ${bytesText(cap.bytes)} models can use`;
  const slowly = cap.on === "memory" ? " With no GPU it runs on the processor, so replies come slowly." : "";
  if (free > 0 && need <= free * TIGHT) return { kind: "fits", label: "Fits", tone: "green", line: `Fits on ${machine}: needs about ${of}.${slowly}` };
  if (free > 0 && need <= free) return { kind: "tight", label: "Tight", tone: "orange", line: `Tight: needs about ${of}. Close other apps, or pick a smaller file or context.` };
  if (cap.on === "gpu" && !m.unified && need <= free + ramRoom(m.ramBytes)) {
    return { kind: "slow", label: "Slow", tone: "orange", line: `Runs, but slowly: it needs about ${n} and the GPU has ${bytesText(free)}, so part of it runs on the processor.` };
  }
  return { kind: "big", label: "Too big", tone: "red", line: `Too big for ${machine}: needs about ${of}. Pick a smaller file or context.` };
}

// ---- The memory guard (hub/src/memory.ts) ----
//
// One place knows what heavy things run on the hub's machine, whether the next one fits, and when the machine is
// about to thrash. Written here so the hub, the phone and the push notification all use the same words and numbers.

/**
 * How the machine's memory is doing. The number behind it is `MachineMemory.level`: on a Mac the kernel's own
 * `kern.memorystatus_level` (the share of memory that is neither wired nor held by the compressor -- the number
 * jetsam compares against), on Linux `MemAvailable` as a share of `MemTotal`. "unknown" is a hub that can't read it.
 */
export type MemoryBand = "fine" | "busy" | "tight" | "full" | "unknown";

/** Where in Settings a heavy thing is switched off; null when it is the person's own to quit. */
export type MemorySection = "image-editor" | "local-models" | "model-pool";

/** A heavy thing running on the hub's machine. */
export interface MemoryHolder {
  /** Short and plain: "the image editor", "llama.cpp on port 8080". */
  what: string;
  /** Crosstalk started it, so Settings can turn it off. False for the person's own, which Crosstalk never ends. */
  ours: boolean;
  /** What it holds (as Activity Monitor counts it); null when this machine can't say. */
  bytes: number | null;
  /** Where it is switched off, when Crosstalk can; null when the person quits it themselves. */
  section: MemorySection | null;
}

/** Something that would free memory, for the phone to offer: at most two are ever shown. */
export interface MemoryWay {
  text: string;
  section: MemorySection | null;
}

/** What the hub knows about its machine's memory right now (GET /api/memory, and the `memory` event). */
export interface MachineMemory {
  band: MemoryBand;
  /** 0 to 100 (see `MemoryBand`); null where it can't be read. */
  level: number | null;
  /** Why the band is "unknown", in plain words; null when it is known. */
  blind: string | null;
  ramBytes: number;
  /** What the heavy things below hold together; null when none of them could be measured. */
  takenBytes: number | null;
  /** Swap pages moved per second, averaged over the last two looks; null where swap can't be read. */
  swapPagesPerSec: number | null;
  swapUsedBytes: number | null;
  /** The heavy things running now, biggest first (small ones are left out). */
  holders: MemoryHolder[];
  /** When it was last read. */
  at: number;
}

/**
 * The bands, as the share of memory that is neither wired nor compressed.
 *
 * Measured on a 16 GB Apple silicon Mac under heavy load, while ComfyUI held 17.0 GB and llama-server 3.8 GB: the
 * level sat at 18 to 34 for hours, swap used 9.1 to 9.7 GB of 10.2 GB, and an image step that normally takes 107 s
 * took 1,725 s. The kernel killed idle daemons at about 18 (`memorystatus_available_pages` ~190,000 of 1,048,576),
 * one band before the one where it starts killing real work (about 5 to 10). So: below 35 nothing heavy may start,
 * below 25 the phone is told. Practitioners land in the same place -- macos-oom-guard warns at 25 and calls 10
 * critical; Firefox acts on the same sysctl and re-reads it every 10 s rather than on every sample.
 */
export const MEMORY_BANDS = { busy: 45, tight: 35, full: 25 } as const;

/**
 * Swap pages a second that mean the machine is thrashing, whatever the level says. The kernel's own line is
 * `vm.compressor_thrashing_min_per_10msecs` = 20, i.e. 2,000 pages a second (about 31 MB/s at Apple silicon's 16 KiB
 * pages). Under the load the bands were measured at, it was running at 16,740 to 20,511 a second while supposedly idle.
 */
export const THRASH_PAGES_PER_SEC = 2000;

/** The page size the line above was measured at: Apple silicon's 16 KiB. */
export const THRASH_PAGE_BYTES = 16 * 1024;

/**
 * The same line as a rate of bytes, which is what it always was: about 31 MB/s. A page is not one size everywhere --
 * Linux counts `pswpin`/`pswpout` in 4 KiB pages, so 2,000 of those a second is 8 MB/s, a rate a Linux hub with any
 * steady swap or zswap traffic reaches while perfectly responsive. Taking the Mac's page count there would refuse
 * every model, editor and pool start on it.
 */
export const THRASH_BYTES_PER_SEC = THRASH_PAGES_PER_SEC * THRASH_PAGE_BYTES;

/** The thrashing line in this machine's own pages a second. */
export const thrashPagesPerSec = (pageBytes: number | null | undefined): number =>
  pageBytes && pageBytes > 0 ? Math.max(1, Math.round(THRASH_BYTES_PER_SEC / pageBytes)) : THRASH_PAGES_PER_SEC;

/**
 * How much memory really has to be left before a machine counts as tight or full, whatever its share says.
 *
 * The bands below are shares, and a share is the wrong unit on a big machine: on a 64 GB Linux hub `MemAvailable` of
 * 20 GB is 31%, which reads "tight" -- and refusing a 4 GB model there, in the words "nearly out of memory", would be
 * nonsense. So this is the amount the bands were really measured at: they come from a 16 GB Mac, where the tight line
 * (35%) is 5.6 GB. On that machine the two agree exactly and nothing changes; everywhere else the band now scales
 * with the machine instead of with its percentage.
 */
export const MEMORY_FLOOR = Math.round((MEMORY_BANDS.tight / 100) * 16 * FIT_GiB);

/** Below this a holder isn't worth a row on a phone (the hub's own 42 MB never is). */
export const MEMORY_SMALL = 256 * 1024 ** 2;

/**
 * `pageBytes`: the size of the pages `swapPagesPerSec` counts, so the thrashing line is the same rate of bytes on
 * every machine. `freeBytes`: about how much memory could really be had now, which is what keeps a low share on a big
 * machine from reading as "nearly out of memory" (`MEMORY_FLOOR`); left out, only the share is used.
 */
export function memoryBandOf(level: number, swapPagesPerSec: number | null, o: { pageBytes?: number | null; freeBytes?: number | null } = {}): MemoryBand {
  const thrashing = swapPagesPerSec !== null && swapPagesPerSec >= thrashPagesPerSec(o.pageBytes === undefined ? THRASH_PAGE_BYTES : o.pageBytes);
  const roomy = typeof o.freeBytes === "number" && o.freeBytes >= MEMORY_FLOOR;
  if (level < MEMORY_BANDS.full && !roomy) return "full";
  if (level < MEMORY_BANDS.tight && !roomy) return "tight";
  // A machine moving this much swap is already too slow to answer, however much it says is free.
  if (level < MEMORY_BANDS.busy || thrashing) return "busy";
  return "fine";
}

/** The biggest thing running that isn't Crosstalk itself. */
export const biggestHolder = (m: MachineMemory): MemoryHolder | null => m.holders.find((h) => h.bytes !== null) ?? m.holders[0] ?? null;

/** "the image editor (17.0 GB)" */
export const holderText = (h: MemoryHolder) => `${h.what}${h.bytes === null ? "" : ` (${bytesText(h.bytes)})`}`;

/** What to do about a holder, in plain words: Crosstalk's own can be turned off from the phone; the person's own can't. */
export const holderWay = (h: MemoryHolder): MemoryWay =>
  h.ours && h.section
    ? { text: `Turn ${h.what} off`, section: h.section }
    : { text: `Quit ${h.what} on this machine`, section: null };

/** The one or two things that would help most, biggest first. */
export const memoryWays = (m: MachineMemory): MemoryWay[] => m.holders.slice(0, 2).map(holderWay);

/** The line on the phone: what the machine is doing, and what is holding it. */
export function memoryLine(m: MachineMemory, machine: string): string {
  if (m.band === "unknown") return m.blind ?? `Crosstalk can't read how ${machine}'s memory is doing.`;
  const big = biggestHolder(m);
  const holding = big ? ` The biggest thing running is ${holderText(big)}.` : "";
  switch (m.band) {
    case "fine":
      return `Memory is fine on ${machine}.${holding}`;
    case "busy":
      return `${machine} is getting full.${holding}`;
    case "tight":
      return `${machine} is nearly out of memory, so everything on it is slow.${holding}`;
    case "full":
      return `${machine} is out of memory. Replies and edits can take minutes until something stops.${holding}`;
  }
}

/**
 * Why something heavy can't start now, with the choice a person can make. Never a silent failure and never a bare
 * "out of memory": it says what is wanted, what is free, what is holding the rest, and what would free it.
 *
 * `why` is "space" when it simply doesn't fit beside what runs, and "pressure" when the machine is already so far
 * gone that starting anything would make everything on it crawl. `needBytes` is null when what it needs can't be
 * worked out beforehand (Ollama loads a model only when a chat asks for one).
 */
export function memoryRefusal(o: { what: string; needBytes: number | null; freeBytes: number; machine: string; holders: MemoryHolder[]; why: "space" | "pressure"; canForce?: boolean }): string {
  const big = o.holders.find((h) => h.bytes !== null) ?? o.holders[0] ?? null;
  const free = o.freeBytes > 0 ? `${bytesText(o.freeBytes)} is free` : "nothing is free";
  const room =
    o.why === "space" && o.needBytes !== null
      ? `${o.what} needs about ${bytesText(o.needBytes)} and ${free} on ${o.machine}.`
      : `${o.machine} is nearly out of memory (${free}), so starting ${o.what} now would make everything on it slow.`;
  // Only promise "start it anyway" where a screen really offers that tap. The model pool has no such control, and an
  // error that names a way out a person can't take is worse than one that tells them what to do instead.
  if (!big) return `${room} Close what you don't need on ${o.machine}, ${o.canForce === false ? `then start ${o.what} again` : "or start it anyway"}.`;
  const way = big.ours && big.section ? "turn it off in Settings" : `quit it on ${o.machine}`;
  const anyway = o.canForce === false ? `then start ${o.what} again` : `or start ${o.what} anyway`;
  return `${room} ${holderText(big)} is holding the rest: ${way}, ${anyway}.`;
}

/** The push notification when the machine runs out while things are running. */
export function memoryNotice(m: MachineMemory, machine: string): { title: string; body: string } {
  const ways = memoryWays(m);
  const what = ways.length ? ` ${ways.map((w) => w.text).join(", or ")}.` : "";
  return {
    title: m.band === "full" ? `${machine} is out of memory` : `${machine} is nearly out of memory`,
    body: `${memoryLine(m, machine)}${what} Crosstalk stops nothing by itself.`,
  };
}

/** Where downloads go: a folder the person can see and change (an external drive too, when it's plugged in and writable). */
export interface LocalFolder {
  path: string;
  /** As people write it: ~/.crosstalk/models. */
  shown: string;
  /** Crosstalk's own models folder, which the model pool uses too. */
  isDefault: boolean;
  /** The drive's name when it's on another drive than this machine's own ("Untitled"). */
  drive: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
  /** Why downloads can't go there now (the drive isn't plugged in, it can't be written to), with what to do; null when they can. */
  problem: string | null;
  /** The folder hasn't answered the hub's look yet (a drive waking up): this is the last it knew, and the page asks again. */
  pending?: boolean;
}

/** A GGUF model in the downloads folder (a split model's parts as one). */
export interface LocalModelFile {
  /** "<owner>/<repo>/<file>" of its first file, in the folder: what a llama.cpp start names. */
  id: string;
  repo: string;
  /** Its files' paths in the repo, in order. */
  files: string[];
  quant: string | null;
  bytes: number;
  /** Bytes of memory each token of context takes (its KV cache), from the file's header; null when it couldn't be read. */
  kvBytesPerToken: number | null;
  /** The context it was trained for, from its header. */
  contextLength: number | null;
}

/** A download, running or stopped part way (one per model). Finished ones become `LocalModelFile`s (or Ollama models). */
export interface LocalDownload {
  id: string;
  source: "huggingface" | "ollama";
  /** What people read: the repo's model name and quant, or Ollama's model name. */
  name: string;
  /** Hugging Face: the model as its repo lists it. */
  model: PoolModel | null;
  /** Ollama: the model's name and the server it's pulled into. */
  ollama: { model: string; serverId: string } | null;
  state: "downloading" | "stopped" | "failed";
  doneBytes: number;
  /** 0 until known. */
  totalBytes: number;
  bytesPerSec: number | null;
  /** What went wrong, in plain words with what to do. */
  error: string | null;
  /** The hub's reason code for `error` ("low_disk", "hf_terms", "folder"): the page offers the way out. */
  code: string | null;
  /** Ollama's own words for what it's doing ("pulling manifest", "verifying sha256 digest"). */
  step: string | null;
  /** Something to know while it runs, in plain words: an Ollama whose disk Crosstalk can't watch. Older hubs leave it out. */
  note?: string | null;
  updatedAt: number;
}

/** POST /api/local-models/downloads: a Hugging Face model (its GGUF files), or a model Ollama pulls into a server on this machine. */
export type LocalDownloadStart = { source: "huggingface"; model: PoolModel } | { source: "ollama"; serverId: string; model: string };

/** A program on this machine that runs a model server. */
export interface LocalProgram {
  kind: "ollama" | "llamacpp";
  path: string;
  /** Where it came from, in plain words: "Homebrew", "the Ollama app", "the model pool's llama.cpp b11669". */
  from: string;
}

/** A model server Crosstalk started on 127.0.0.1. It keeps running when the hub restarts; these are the only servers Crosstalk stops. */
export interface LocalStarted {
  /** "<kind>-<port>" */
  id: string;
  kind: "ollama" | "llamacpp";
  port: number;
  baseUrl: string;
  /** llama.cpp: the model it serves (`LocalModelFile.id`) and the context it was given. */
  model: string | null;
  context: number | null;
  state: "starting" | "running" | "stopping" | "failed";
  /** What it's doing, or what went wrong with what to do. */
  detail: string | null;
  /** Its output, as people write the path (~/.crosstalk/run/local-servers/llamacpp-8080/server.log). */
  log: string;
  startedAt: number;
}

/** POST /api/local-models/start. `port`: the program's own default when left out; `context`: llama.cpp's tokens of context (32k when left out). */
export interface LocalServerStart {
  kind: "ollama" | "llamacpp";
  port?: number;
  /** llama.cpp: the model to serve (`LocalModelFile.id`). */
  model?: string;
  context?: number;
  /** Start it even though the memory guard says it won't fit (the person was told what's holding the memory and chose to). */
  force?: boolean;
}

/** GET /api/local-models/library: what Settings → Local models needs to get models and start servers. */
export interface LocalLibrary {
  machine: LocalMachine;
  folder: LocalFolder;
  files: LocalModelFile[];
  downloads: LocalDownload[];
  programs: LocalProgram[];
  started: LocalStarted[];
  /** A Hugging Face token is saved on the hub (the model pool's: PUT /api/pool/hf-token). It never leaves the hub. */
  hasHfToken: boolean;
  /** What every download leaves free on its disk (the hub's reserve). */
  reserveBytes: number;
  /** Free ports to start each kind of server on: its own default when that's free. */
  ports: { ollama: number; llamacpp: number };
}

/** GET /api/local-models/search?q=: GGUF models on Hugging Face, most downloaded first. */
export interface LocalSearchHit {
  repo: string;
  downloads: number;
  gated: boolean;
  /** Parameters (from the GGUF metadata Hugging Face reads). */
  params: number | null;
  contextLength: number | null;
}

/** GET /api/local-models/files?repo=: a repo's GGUF models with what the verdict needs from their header. */
export interface LocalRepoFiles extends PoolModelChoices {
  kvBytesPerToken: number | null;
  contextLength: number | null;
}

/** GET /api/local-models/ollama?model=: a model in Ollama's library before it's pulled. */
export interface LocalOllamaInfo {
  model: string;
  sizeBytes: number;
  quant: string | null;
  /** "8.2B" */
  params: string | null;
}

// ===================================================================== Agent-assisted setup (docs/SETUP-FOR-AGENTS.md)

/**
 * Where a setup item stands. "missing": not done, and an agent on the machine can do it once the person says yes.
 * "user": only the person can (a password, a sign-in, a system setting, or a step on their phone). "unknown": it
 * couldn't be checked, or waits on an item before it.
 */
export type SetupState = "done" | "missing" | "user" | "unknown";

/** How to fix a setup item: what to do in plain words, with the exact command or the app screen. */
export interface SetupFix {
  text: string;
  /** The exact command, run on the hub's machine. */
  command?: string;
  /** It asks for the person's password or sign-in: they type it themselves, never an agent. */
  password?: boolean;
  /** Where in the app, e.g. "Settings → This Mac". */
  screen?: string;
  /** That screen's section in Settings (an element id: "this-mac", "devices", "agent-claude"). */
  target?: string;
  /** A web page that fixes it (Tailscale's admin console, a download page). */
  url?: string;
}

export type SetupGroup = "hub" | "network" | "devices" | "agents" | "services" | "mac" | "machines" | "pool";

export interface SetupItem {
  /** Stable ("service", "https", "agent.claude", "mac.autologin"…): read items by id. */
  id: string;
  group: SetupGroup;
  title: string;
  state: SetupState;
  /** Nice to have: left out of the summary. */
  optional: boolean;
  /** What was found, in plain words. */
  detail: string;
  /** How to fix it; null when it's done or nothing can be done yet. */
  fix: SetupFix | null;
}

/** One agent's way to reach BrowserOS neo, for the app to show with Copy beside it. */
export interface BrowserOsConnectRow {
  agent: "claude" | "codex" | "gemini";
  name: string;
  /** The exact command, run on the hub's machine. */
  command: string;
  /** It already points at this very address. */
  connected: boolean;
}

export interface BrowserOsConnect {
  /** "http://127.0.0.1:9010/mcp" — what the browser answered on, not a port anyone assumed. */
  url: string;
  /** The agents installed on this machine, each with its own command. Empty: none is installed yet. */
  rows: BrowserOsConnectRow[];
  /** Why a command alone isn't enough: an agent reads its MCP servers when it starts. */
  restart: string;
}

/**
 * What's left to set up on a hub (GET /api/setup, `crosstalk-hub setup --json`, the setup_status tool). Ids stay and
 * fields are only added; `schema` changes only if something is taken away or changes meaning.
 */
export interface SetupChecklist {
  schema: 1;
  checkedAt: number;
  hub: {
    /** False when the hub couldn't be reached (from the CLI): most items are "unknown" then. */
    running: boolean;
    version: string;
    name: string;
    platform: string;
    arch: string;
    /** Its https address (publicUrl), null when it has none. */
    url: string | null;
    /** Its address on this machine, e.g. http://127.0.0.1:7420. */
    localUrl: string;
    /** The hub's program, as the commands below use it. */
    binary: string;
    /** What keeps it running: a LaunchAgent, a systemd user service, or nothing (started by hand); null: not known. */
    service: "launchd" | "systemd" | "none" | null;
    /** A newer build: staged here and waiting for a restart, or running on a linked machine. */
    update: { version: string; source: "staged" | "machine"; machine?: string } | null;
  };
  /** Required items only. */
  summary: { total: number; done: number; missing: number; user: number; unknown: number };
  items: SetupItem[];
  /** Commands that add the setup tools to an agent on this machine, and what to tell it. */
  connect: {
    claude: string;
    codex: string;
    gemini: string;
    cli: string;
    guide: string;
    prompt: string;
    /**
     * BrowserOS neo (the person's browser for agents) as the agents here would reach it: the address it is really
     * serving MCP on, found by asking the browser rather than assumed, and the exact `mcp add` for each agent
     * installed on this machine. Null while there is no address yet (it isn't installed, or it has never run here).
     * Added after schema 1: a build that doesn't know about it leaves it out, and the app treats that as null.
     */
    browseros?: BrowserOsConnect | null;
  };
}

// ===================================================================== 0.5 Templates (prompt templates)

/** The most templates one machine keeps, and the longest name and first message a template may have. */
export const TEMPLATES_MAX = 100;
export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_TEXT_MAX = 20_000;
/** The starters a hub adds once (PromptTemplate.starter): Settings offers to add back the ones that were deleted. */
export const TEMPLATE_STARTERS = ["bug", "plan", "review"] as const;

/**
 * A way to start a chat (Settings → Templates; New chat → From a template): its first message, and optionally the agent,
 * account, model, effort and folder. Each machine's hub keeps its own, in the person's order, and every device hears each
 * change as a `templates` event with the whole list. A "{name}" in the text is a blank the app asks for when a chat starts
 * from it (web/src/templates.ts).
 */
export interface PromptTemplate {
  id: string;
  name: string;
  /** The agent it starts; null: the one New chat is open for. */
  agent: ChatProvider | null;
  /** That agent's account on this machine; null: the one New chat would use (the main sign-in when a model is set). */
  account: string | null;
  /** Null: what New chat would use. Only with an agent. */
  model: string | null;
  effort: string | null;
  /** A folder on this machine (a full path); null: whichever New chat picks, a new folder unless it's changed. */
  folder: string | null;
  /** The first message, sent when the chat starts. */
  text: string;
  /** Which of the starters Crosstalk adds once this is (absent from the person's own). */
  starter?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * What POST /api/templates takes (name and text are needed), and PATCH /api/templates/:id (any of it). Changing the agent
 * clears the account, model and effort the change doesn't give. Every change (POST, PATCH, DELETE, POST …/:id/move {to},
 * POST /api/templates/starters) answers the whole list, in order.
 */
export type TemplateInput = Partial<Pick<PromptTemplate, "name" | "agent" | "account" | "model" | "effort" | "folder" | "text">>;
// ---- 0.5 Group chats ----

/** A chat with several agents in it (ChatInfo.group): older rooms are group chats too, on hubs from 0.5 on. */
export function isGroupChat(room: Pick<Room, "chat"> | null | undefined): boolean {
  return !!room?.chat?.group;
}

/**
 * Who answers a group chat's message that @mentions nobody: "lead" the lead (Room.leadMemberId, else the first agent),
 * "turns" everyone, one after the other, the lead first; "review" the lead builds and the next agent checks its work
 * (Build & review). An @mention always means only who it names answers.
 */
export type GroupAnswers = "lead" | "turns" | "review";

/** Room.mode as a group chat's "who answers". Older modes (lead, relay) work like the lead answering. */
export function groupAnswers(mode: RoomMode): GroupAnswers {
  return mode === "roundrobin" ? "turns" : mode === "review" ? "review" : "lead";
}

/** The Room.mode for a "who answers". */
export function groupMode(answers: GroupAnswers): RoomMode {
  return answers === "turns" ? "roundrobin" : answers === "review" ? "review" : "direct";
}

/** The agents a group chat can have when it starts (POST /api/chats/group). */
export const GROUP_MIN = 2;
export const GROUP_MAX = 6;

/**
 * A group chat's agents in the order they answer a message for everyone: the lead first, then the others as they were
 * added. Also who answers a message with no @mention in a "lead" chat: the first of these.
 */
export function turnOrder<M extends Pick<Member, "id">>(room: Pick<Room, "leadMemberId">, members: readonly M[]): M[] {
  const lead = members.find((m) => m.id === room.leadMemberId) ?? members[0];
  return lead ? [lead, ...members.filter((m) => m !== lead)] : [];
}

/** One agent of a new group chat. Missing settings come from Settings → Defaults, as for a new chat. */
export interface NewGroupMember {
  provider: ChatProvider;
  account?: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: PermissionMode;
  helperModel?: string | null;
  /** Its @name in the chat (made unique by the hub); missing: the agent's own (claude, codex) or its account's name. */
  handle?: string;
}

/** A new group chat (POST /api/chats/group). */
export interface NewGroupChat {
  members: NewGroupMember[];
  /** Who answers a message that @mentions nobody: the lead, or everyone in turn. */
  answers: "lead" | "turns";
  /** Which of `members` leads (its index; missing: the first). */
  lead?: number;
  name?: string;
  cwd?: string;
}
