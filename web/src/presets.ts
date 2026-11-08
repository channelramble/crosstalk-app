import type { Protocol, Provider, ServiceAgent } from "@crosstalk/shared";
import { FEATHERLESS_HELP, FEATHERLESS_PRICING, FEATHERLESS_TERMS } from "./featherless";

/** Ready-made custom models (Settings → Add a custom model): a hosted model's address, model names and context. */
export interface EndpointPreset {
  id: "kimi";
  /** What the choice is called in the dialog. */
  title: string;
  /** The account's name. */
  label: string;
  /** Who runs it and bills for it. */
  vendor: string;
  /** Where each agent reaches it: Claude Code speaks Anthropic's Messages API, Codex OpenAI's Responses API. */
  baseUrl: Partial<Record<Provider, string>>;
  models: string[];
  contextWindow: number;
  /** One line under the choice: what it costs and where the key comes from. */
  help: string;
  keyFrom: { label: string; url: string };
}

/** Kimi K3.1 Pro through Moonshot's API: too big to run at home (docs/MODEL-POOL.md, "Not possible here"). */
export const KIMI_PRESET: EndpointPreset = {
  id: "kimi",
  title: "Kimi K3.1 Pro (Moonshot API)",
  label: "Kimi K3.1 Pro",
  vendor: "Moonshot",
  baseUrl: { claude: "https://api.moonshot.ai/anthropic", codex: "https://api.moonshot.ai" },
  models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"],
  contextWindow: 1_048_576,
  help: "Paid per use: about $2 per million tokens in and $10 out (Oct 2026).",
  keyFrom: { label: "platform.kimi.ai", url: "https://platform.kimi.ai" },
};

export const ENDPOINT_PRESETS: EndpointPreset[] = [KIMI_PRESET];

/** The dialog's fields as a preset fills them in for one agent. */
export function presetFields(preset: EndpointPreset, provider: Provider): { baseUrl: string; models: string; context: string; label: string } | null {
  const baseUrl = preset.baseUrl[provider];
  if (!baseUrl) return null;
  return { baseUrl, models: preset.models.join(", "), context: String(preset.contextWindow), label: preset.label };
}

/** A place on the web: a short name to show and the address to open. */
export interface Site {
  label: string;
  url: string;
}

/**
 * A service the "Add an AI service" sheet knows (Settings → AI services). A preset holds only what can't be found out:
 * the address, where its docs and keys are, the agent that suits it best and its chat path when that isn't the usual
 * one. What the service speaks, its models and their sizes come from checking it (POST /api/services/test).
 */
export interface ServicePreset {
  id: string;
  /** What the list calls it. */
  title: string;
  /** One line under the title in the list. */
  help: string;
  /** What the account is called unless you choose a name ("" = named after its first model). */
  label: string;
  /** As the hub reaches it, without /v1 ("" = you type it). */
  baseUrl: string;
  /** hosted: an online service with a key. local: a server on the hub's machine. other: any server, with or without a key. */
  kind: "hosted" | "local" | "other";
  /** The agent to offer first when more than one can run it (Crosstalk's own agent or OpenCode, for a service the hub runs them on). */
  agent: ServiceAgent;
  /** The agent `note` is about, if it's about one: it isn't shown for any other. */
  noteAgent?: ServiceAgent;
  /** Its docs. */
  docs?: Site;
  /** Where its keys are made: the sheet's "Open <site>" link. */
  keyPage?: Site;
  /** The chat path, when it isn't /v1/chat/completions. */
  chatPath?: string;
  /**
   * The style to use even when the check finds another the agent could use (Venice has both, and only the chat one goes
   * through Crosstalk's adapter, where `extra` and the tool translation live). Honoured only when the check found that
   * address and the agent speaks it, so a service that drops one never leaves the sheet with nothing.
   */
  protocol?: Protocol;
  /**
   * Fields this service needs in every chat request, saved with the account and merged by the hub's chat adapter under
   * the fields it works out itself (so none of them can change the model, the messages, the tools or the stream).
   */
  extra?: Record<string, unknown>;
  /** One more line under the title: something Crosstalk does for this service that a person should know. */
  note?: string;
  /** What you are paying for, in plain words: which plan an agent needs and how it's billed. */
  plan?: string;
  /**
   * Where the service's plans and what each allows are set out (Featherless's pricing page). With it, `plan` is the
   * service's terms for agents, shown as a warning with this linked after it.
   */
  pricing?: Site;
  /**
   * The most of a chat the service's smallest plan reads at once, whatever a model's own context says (Featherless's $25
   * Chat plan is 32K): until the check has read the key's own plan, a model's size is saved no bigger than this, so no
   * chat is told it has room a plan won't serve.
   */
  contextCap?: number;
  /**
   * How many requests that plan runs at the same time (Featherless's Chat plan: 4), until the check has read the key's
   * own. A big model's request can count as more than one of them, which is what the facts beside a model say.
   */
  atOnce?: number;
}

/** In the order the sheet lists them. Kimi's facts are the ones the custom model dialog uses (KIMI_PRESET). */
export const SERVICE_PRESETS: ServicePreset[] = [
  { id: "kimi", title: "Kimi", help: "Moonshot's Kimi K3.1 Pro. Paid per use.", label: KIMI_PRESET.label, baseUrl: KIMI_PRESET.baseUrl.codex ?? "", kind: "hosted", agent: "codex", keyPage: KIMI_PRESET.keyFrom },
  {
    id: "deepseek", title: "DeepSeek", help: "DeepSeek's own models. Paid per use.", label: "DeepSeek", baseUrl: "https://api.deepseek.com", kind: "hosted", agent: "codex",
    keyPage: { label: "platform.deepseek.com", url: "https://platform.deepseek.com/api_keys" }, docs: { label: "api-docs.deepseek.com", url: "https://api-docs.deepseek.com" },
  },
  {
    id: "mistral", title: "Mistral", help: "Mistral's models, including its coding ones. Paid per use.", label: "Mistral", baseUrl: "https://api.mistral.ai", kind: "hosted", agent: "codex",
    keyPage: { label: "console.mistral.ai", url: "https://console.mistral.ai/api-keys" }, docs: { label: "docs.mistral.ai", url: "https://docs.mistral.ai" },
  },
  {
    id: "openrouter", title: "OpenRouter", help: "One key for models from many makers. Paid per use.", label: "OpenRouter", baseUrl: "https://openrouter.ai/api", kind: "hosted", agent: "claude",
    keyPage: { label: "openrouter.ai", url: "https://openrouter.ai/keys" }, docs: { label: "openrouter.ai/docs", url: "https://openrouter.ai/docs" },
  },
  {
    id: "groq", title: "Groq", help: "Open models, very fast. Paid per use.", label: "Groq", baseUrl: "https://api.groq.com/openai", kind: "hosted", agent: "codex",
    keyPage: { label: "console.groq.com", url: "https://console.groq.com/keys" }, docs: { label: "console.groq.com/docs", url: "https://console.groq.com/docs" },
  },
  {
    id: "xai", title: "xAI", help: "Grok models. Paid per use.", label: "xAI", baseUrl: "https://api.x.ai", kind: "hosted", agent: "codex",
    keyPage: { label: "console.x.ai", url: "https://console.x.ai" }, docs: { label: "docs.x.ai", url: "https://docs.x.ai" },
  },
  {
    // NanoGPT sells several hundred models from many makers behind one key, each at its own price per token — or out of
    // its $12-a-month subscription for the models that covers. Its list (666 models on 1 November 2026, with a price and
    // a "can call tools" for each) is too long to tick through, so the hub reads it and the sheet searches it, uncensored
    // models first (hub/src/nanogpt.ts, GET /api/services/catalog?name=nanogpt). Crosstalk's own agent is offered first
    // (hub/src/agents/builtin.ts): it talks to NanoGPT itself, with tools for commands, files and BrowserOS neo, and no
    // Claude Code or Codex in between — none of their refusal rules, and none of Codex's 134,000 tokens of tools a request.
    id: "nanogpt", title: "NanoGPT", help: "Hundreds of models with one key, uncensored ones included. Paid per use, or $12 a month for the ones its subscription covers.", label: "NanoGPT",
    baseUrl: "https://nano-gpt.com/api", kind: "hosted", agent: "builtin",
    // NanoGPT answers at /v1/responses too, but for every model that isn't OpenAI's that is its own translation into Chat
    // Completions — which Crosstalk's adapter does itself, with the failure handling Codex needs: Codex 0.160 sends the
    // identical request again up to 57 times on a 500, every copy carrying its whole prompt and tool list (AGENTS.md,
    // "Chat adapter"), while the adapter ends every failure in words Codex doesn't retry, sizes each request against the
    // model, and measures what Codex's tools cost on it — which can be 134,000 tokens a request, billed per token
    // here. Claude Code speaks only Messages and has no adapter, so it keeps NanoGPT's own Messages address (protocolFor).
    protocol: "chat",
    plan: "Each reply is paid from your NanoGPT balance at that model's own price, unless its $12-a-month subscription covers the model: those come out of its weekly allowance instead.",
    note: "Crosstalk's own agent runs it directly, with commands, files and BrowserOS neo: no other agent involved. Crosstalk searches its models, shows each one's price and your balance.",
    noteAgent: "builtin",
    keyPage: { label: "nano-gpt.com/api", url: "https://nano-gpt.com/api" },
    docs: { label: "docs.nano-gpt.com", url: "https://docs.nano-gpt.com" },
  },
  {
    // Refuseless serves "abliterated" open-weight models — the direction that makes a model refuse taken out of its
    // weights, so nothing is added to the prompt and a new session doesn't bring refusals back — behind an
    // OpenAI-compatible API, paid per token from a prepaid balance (docs.refuseless.com, hub/src/refuseless.ts). Its
    // DeepSeek V4.1 Flash has the lineup's top coding scores at its lowest price. OpenCode is offered first: an open-source
    // coding agent Crosstalk drives (hub/src/agents/opencode.ts), with no refusal rules of its own, that keeps a Plan card,
    // reads the project's AGENTS.md (or CLAUDE.md), asks for approvals by the chat's setting and can use BrowserOS neo. It
    // has to be installed, which the sheet does on the spot. Crosstalk's own agent needs nothing installed and can run it
    // too, as can Codex (through Crosstalk's adapter, pinned below for the same reasons as NanoGPT's) and Claude Code (its
    // Messages address).
    id: "refuseless", title: "Refuseless", help: "Abliterated open models — refusals taken out of the weights — for coding and security work. Paid per use.", label: "Refuseless",
    baseUrl: "https://api.refuseless.com", kind: "hosted", agent: "opencode",
    protocol: "chat",
    plan: "Each reply is paid from your Refuseless balance at that model's price per token. Crosstalk shows the balance, and estimates what each reply cost from Refuseless's prices of 4 November 2026.",
    note: "OpenCode runs it: an open-source coding agent Crosstalk drives, with no refusal rules of its own. It keeps a Plan card, reads your project's AGENTS.md (or CLAUDE.md), asks for approvals the way your chat is set, and can use BrowserOS neo.",
    noteAgent: "opencode",
    keyPage: { label: "refuseless.com/console", url: "https://refuseless.com/console" },
    docs: { label: "docs.refuseless.com", url: "https://docs.refuseless.com" },
  },
  {
    // Featherless serves open-weight models straight from Hugging Face, so its model list is that whole catalogue
    // (22,406 models on 29 October 2026, about 7 MB): the sheet searches it by name instead of listing it, and the hub
    // does the searching (hub/src/featherless.ts, GET /api/services/catalog).
    id: "featherless", title: "Featherless", help: FEATHERLESS_HELP, label: "Featherless",
    baseUrl: "https://api.featherless.ai", kind: "hosted", agent: "codex",
    // Chat Completions is the only lane it has: its docs give /v1/chat/completions and /v1/completions, and neither a
    // Responses nor a Messages address, so Codex reaches it through Crosstalk's own translator.
    protocol: "chat",
    // Its $25 Chat plan reads 32K of a chat at once whatever a model could hold, and runs 4 requests at the same time —
    // where a bigger model's request reserves 2 or 4 of those (featherless.ai/docs/plans, /docs/concurrency-limits).
    // Those hold until the check reads the key's own plan (the Developer plan reads up to 256K, 100 at a time).
    contextCap: 32_768,
    atOnce: 4,
    // Its Chat plan's terms don't allow agents or API use, and every chat here is an agent driving it through the API:
    // said where it's added, before any key is checked (web/src/featherless.ts).
    plan: FEATHERLESS_TERMS,
    pricing: FEATHERLESS_PRICING,
    note: "Crosstalk searches its 22,000 models instead of listing them.",
    keyPage: { label: "featherless.ai/account/api-keys", url: "https://featherless.ai/account/api-keys" },
    docs: { label: "featherless.ai/docs", url: "https://featherless.ai/docs" },
  },
  {
    // api.venice.ai/api, because every address it has starts /api/v1 and the chat path is added to this one.
    id: "venice", title: "Venice", help: "Privacy-first, uncensored models. Paid per use.", label: "Venice", baseUrl: "https://api.venice.ai/api", kind: "hosted", agent: "codex",
    // Venice has a Responses address too, but it's beta and serves every model that isn't OpenAI's through its own
    // Chat Completions translation ("some Responses features are not supported"), which is what Venice is added for. The
    // chat lane is also the only one Crosstalk can put `extra` in, so the line below stays true: it is pinned here.
    protocol: "chat",
    // Venice adds a system prompt of its own unless a request says otherwise, which would sit on top of the agent's
    // instructions, and leaves a thinking model's <think> blocks in its answer, where they would fill up the chat.
    extra: { venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true } },
    note: "Crosstalk turns Venice's own prompt off, so the agent follows its own instructions.",
    keyPage: { label: "venice.ai/settings/api", url: "https://venice.ai/settings/api" }, docs: { label: "docs.venice.ai", url: "https://docs.venice.ai" },
  },
  {
    id: "gemini", title: "Google Gemini", help: "Gemini with a key from Google AI Studio. Paid per use.", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", kind: "hosted", agent: "codex",
    chatPath: "/v1beta/openai/chat/completions", keyPage: { label: "aistudio.google.com", url: "https://aistudio.google.com/apikey" }, docs: { label: "ai.google.dev", url: "https://ai.google.dev/gemini-api/docs/openai" },
  },
  {
    id: "local", title: "A server on this machine", help: "Ollama, LM Studio, llama.cpp or another one running here. Free; nothing leaves this machine.", label: "", baseUrl: "http://127.0.0.1:8080", kind: "local", agent: "codex",
    // Through Crosstalk's own translator, even where the server's Responses address answers: these servers' Responses
    // support is newer than their Chat Completions one, and a model's chat template can refuse what an agent sends
    // there (llama.cpp with a Qwen template answers "System message must be at the beginning"), while the translator
    // lays the messages out itself. Honoured only when the check found that address (protocolFor).
    protocol: "chat",
    note: "Crosstalk talks to it in the Chat Completions style, which these servers handle best.",
  },
  { id: "other", title: "Another server", help: "Any server that speaks the Responses, Messages or Chat Completions style.", label: "", baseUrl: "", kind: "other", agent: "codex" },
];

export const servicePreset = (id: string | null | undefined): ServicePreset | null => SERVICE_PRESETS.find((p) => p.id === id) ?? null;

/** The sheet's three numbered steps for a preset. */
/**
 * Whether a preset's note is true for the agent picked. Before a check has picked one: for the agent it's about, if this hub
 * has it (a hub older than OpenCode doesn't list it; Crosstalk's own agent is part of the hub).
 */
export function presetNoteHolds(preset: Pick<ServicePreset, "noteAgent">, agent: ServiceAgent | null, hubAgents: Partial<Record<Provider, unknown>>): boolean {
  const about = preset.noteAgent;
  if (!about) return true;
  return agent ? agent === about : about === "builtin" || !!hubAgents[about];
}

export function presetSteps(p: ServicePreset): [string, string, string] {
  if (p.kind === "hosted") return [`Get a key at ${p.keyPage?.label ?? "the service's website"}.`, "Paste it here.", "Press Test."];
  if (p.kind === "local") return ["Start your model server on this machine.", "Check its address.", "Press Test."];
  return ["Find the server's address, and its key if it has one, in its docs.", "Paste them here.", "Press Test."];
}
