import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT, MULTI_ACCOUNT_PROVIDERS, PROVIDER_INFO, isServiceOnlyAgent, noSignInWords, type AgentAccount, type EndpointInfo, type EndpointProbe, type LoginFlow, type ModelCatalog, type ModelOption, type Provider, type Protocol, type ProviderStatus } from "@crosstalk/shared";
import type { App } from "../app";
import { endpointOutputLimit } from "../agents/driver";
import { HOME, HUB_VERSION, readSecrets, writeSecret } from "../config";
import { HttpError } from "../engine/engine";
import { KV_COST, newestToolCost, toolCostsFor } from "../adapter/cost";
import { SERVER_NAMES, cleanKey, endpointFields, endpointModelOptions, mergeEndpointFields, readServer } from "../serviceProbes";
import { logger } from "../util/log";

const log = logger("providers");

/** Env vars that leak in when the hub itself is started from inside an agent session (e.g. during development). */
const LEAKY_ENV = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW|ANTHROPIC_BASE_URL|CODEX_SANDBOX|CODEX_THREAD|MCP_)/;

export interface ProviderModule {
  id: Provider;
  binNames: string[];
  /** Extra places installers drop binaries that may not be on the service's PATH. */
  extraPaths: string[];
  versionArgs: string[];
  /** Official install command (shown to the user before it runs). */
  installCommand: string[] | null;
  /** Where that command puts a pinned program: looked at first, so another copy of it earlier on PATH can't stand in for it. */
  ownBin?: string;
  /** Check sign-in state; returns partial status. */
  checkAuth?(app: App, bin: string): Promise<Partial<ProviderStatus>>;
  startLogin?(app: App, bin: string, opts: { method?: string }): Promise<LoginFlow>;
  /** Ends a sign-in startLogin started for this account that isn't a terminal (Codex's device code), if one waits. */
  endLogin?(app: App, account: string): void;
  logout?(app: App, bin: string): Promise<void>;
  refreshUsage?(app: App, bin: string): Promise<void>;
  /** Ask the CLI which models (and effort levels) it offers. */
  listModels?(app: App, bin: string): Promise<ModelOption[]>;
  /**
   * What each listed model can hold, when the CLI says so separately and slowly (Claude Code answers per model). Asked
   * in the background and kept, so the hub knows the sizes as soon as it starts. Keyed by model id. Also given every
   * More model that was left out of the list for running another model (runsAs), to check it again.
   */
  modelContext?(app: App, bin: string, models: ModelOption[]): Promise<Record<string, ModelContextInfo>>;
  /** Suggestions shown when the CLI can't be asked. */
  modelHints?: ModelOption[];
}

/** What a model can hold, as its agent says. */
export type ModelContextInfo = Pick<ModelOption, "contextWindow" | "usableContext" | "compactAt" | "maxContextWindow"> & {
  /**
   * A More model that the agent, started on it, ran another model in place of (this names that one), without asking its
   * provider first: the user's or an organization's settings keep it off this machine. Kept with the sizes; the model
   * stays out of the list until it's checked again (MODEL_CONTEXT_TTL, an update or a sign-in change).
   */
  runsAs?: string;
};

/**
 * How long a model list is reused before the agent is asked again. An older one (up to a day) is still answered at once
 * while the agent is asked in the background: a change goes out as a "models" event.
 */
const MODEL_LIST_TTL = 10 * 60_000;
const MODEL_LIST_STALE_OK = 24 * 3600_000;
/** After the agent couldn't be asked, how long before asking again (each try starts its CLI). */
const MODEL_LIST_RETRY = 2 * 60_000;
/** How often the lists in use are asked for again. */
const MODEL_WATCH_EVERY = 30 * 60_000;
/** Context sizes change rarely: asked again after this long, or when the agent lists a model it hasn't sized. */
const MODEL_CONTEXT_TTL = 6 * 3600_000;

/** What a catalog says that a client shows (the list, and whether it is live and why not): an event goes out when this changes. */
function catalogSignature(c: ModelCatalog): string {
  return JSON.stringify([c.live, c.error, c.models.map((m) => [m.id, m.label, m.description, m.isDefault, m.efforts, m.defaultEffort, m.resolvedModel ?? null, m.fast?.label ?? null, m.contextWindow ?? null, m.usableContext ?? null, m.compactAt ?? null, m.maxContextWindow ?? null, m.firstSeen ?? 0, m.more ?? false, m.toolCost?.at ?? 0, m.toolCost?.tools ?? 0]), c.gone ?? []]);
}

/** Just the size fields of a model entry, those that are set (never `runsAs`). */
function sizeFields(m: ModelContextInfo | null | undefined): Partial<ModelContextInfo> {
  if (!m) return {};
  const { contextWindow, usableContext, compactAt, maxContextWindow } = m;
  return defined({ contextWindow, usableContext, compactAt, maxContextWindow });
}

/** `o` without its undefined fields, so spreading it never blanks out a value known from elsewhere. */
function defined<T extends object>(o: T | null | undefined): Partial<T> {
  return o ? (Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>) : {};
}

/** How to get a missing tool with the hub's package manager, for hints (Homebrew on macOS, apt elsewhere). */
export function installHint(brew: string, apt: string): string {
  return process.platform === "darwin" ? `brew install ${brew}` : `sudo apt install -y ${apt}`;
}

const modules = new Map<Provider, ProviderModule>();

/**
 * Each agent CLI keeps its sign-in in a config folder it can be pointed at. An extra account is just another folder,
 * so several accounts of the same agent can run side by side.
 */
const ACCOUNT_DIR_ENV: Partial<Record<Provider, string>> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", gemini: "GEMINI_CLI_HOME", antigravity: "HOME" };

/**
 * The account an operation is for. Provider modules (sign-in, status, usage) call agentEnv() and get(); running them
 * inside this scope points them at the right account without each module knowing about accounts.
 */
const accountScope = new AsyncLocalStorage<{ provider: Provider; account: string }>();

/** Credentials that would override an extra account's own sign-in if inherited from the hub's environment. */
const INHERITED_AUTH: Partial<Record<Provider, string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT"],
  antigravity: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

interface SavedAccount {
  provider: Provider;
  id: string;
  label: string;
  /** "apikey": usage-billed through an API key kept in the hub's secrets file. "endpoint": a model server of your own. */
  kind?: "apikey" | "endpoint";
  /** Claude: the workspace an organization-wide API key bills (sent as the anthropic-workspace-id header). */
  workspaceId?: string;
  /** A custom model server: its address (without /v1), the models it serves (first: the default), context size. */
  baseUrl?: string;
  models?: string[];
  contextWindow?: number;
  /** What the server speaks: absent = what the agent speaks natively (Codex "responses", Claude Code "messages"); "chat" = Chat Completions only, reached through the local translator (adapter/). */
  protocol?: Protocol;
  /** The upstream's chat path when it isn't /v1/chat/completions (Gemini: /v1beta/openai/chat/completions). */
  chatPath?: string;
  /** Context window per model; contextWindow is the fallback. */
  contexts?: Record<string, number>;
  /** Body fields this service wants in every chat request (Venice's venice_parameters); the adapter merges them under its own. */
  extra?: Record<string, unknown>;
}

/** "localhost:8080/v1/" → "http://localhost:8080": the server's root, which each agent adds its own path to. */
export function endpointAddress(input: string): string {
  let raw = String(input ?? "").trim();
  if (!raw) throw new HttpError(400, "Enter the model server's address");
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "That isn't a web address");
  }
  if (u.username || u.password) throw new HttpError(400, "Put the key in the API key field, not in the address");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

/**
 * Claude Code on a model server of your own: it talks to the server's Anthropic-compatible API, and every model it
 * would pick (main, background, helpers) is the server's. Output is capped to fit a small context (its first model's
 * here; a chat's driver sizes it for the chat's own model).
 */
function claudeEndpointEnv(a: SavedAccount, key: string): Record<string, string> {
  const model = a.models?.[0] ?? "";
  const ctx = a.contexts?.[model] ?? a.contextWindow ?? null;
  return {
    ANTHROPIC_BASE_URL: a.baseUrl ?? "",
    ANTHROPIC_AUTH_TOKEN: key || "crosstalk-local",
    ...(model
      ? {
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          ANTHROPIC_DEFAULT_FABLE_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
        }
      : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(ctx ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(endpointOutputLimit(ctx)) } : {}),
  };
}

/** Where an API-key account's key is kept (the hub's secrets file, readable only by the hub's user). */
const apiKeySecret = (p: Provider, id: string) => `apikey:${p}:${id}`;

/** Agents that can use an API key instead of a plan sign-in. */
export const API_KEY_PROVIDERS: Provider[] = ["claude", "codex"];

export function registerProvider(m: ProviderModule) {
  modules.set(m.id, m);
}

export function providerModule(p: Provider): ProviderModule | undefined {
  return modules.get(p);
}

export class Providers {
  private statuses = new Map<Provider, ProviderStatus>();
  /** Sign-in state of extra accounts, keyed "provider:id". */
  private accountStatus = new Map<string, ProviderStatus>();
  private pathCache = new Map<Provider, string | null>();
  private modelCache = new Map<string, { at: number; catalog: ModelCatalog }>();
  /** Model lists asked for since the hub started ("provider:account"): these are kept fresh in the background. */
  private modelsAsked = new Set<string>();
  /** One request to an agent for its models at a time, per account. */
  private modelsListing = new Map<string, Promise<ModelCatalog>>();
  /** The last try, when the agent couldn't be asked and had no list before. */
  private modelsFailed = new Map<string, { at: number; catalog: ModelCatalog }>();
  private contextChecking = new Set<string>();

  constructor(private app: App) {}

  /** The folder an extra account's sign-in lives in. */
  accountDir(p: Provider, account: string): string {
    return join(HOME, "accounts", p, account);
  }

  /** Runs `fn` for one account: the provider module's env, status and usage calls all apply to that account. */
  forAccount<T>(p: Provider, account: string, fn: () => T): T {
    return accountScope.run({ provider: p, account }, fn);
  }

  /** The account the current operation is for, if it's for `p`. */
  currentAccount(p?: Provider): string {
    const s = accountScope.getStore();
    return s && (!p || s.provider === p) ? s.account : DEFAULT_ACCOUNT;
  }

  /**
   * Environment for agent processes: the hub's env minus leaked agent variables, with a PATH that finds installed
   * CLIs. For an extra account it also points the agent at that account's config folder.
   */
  agentEnv(p?: Provider, account?: string): Record<string, string> {
    const env = this.baseEnv();
    const scope = accountScope.getStore();
    const provider = p ?? scope?.provider;
    const id = account ?? (scope && (!p || scope.provider === p) ? scope.account : DEFAULT_ACCOUNT);
    const key = provider && ACCOUNT_DIR_ENV[provider];
    if (key && id && id !== DEFAULT_ACCOUNT) {
      // Keys and tokens in the hub's environment belong to the main account; an extra account must use its own
      // sign-in, never quietly run as Main.
      for (const k of INHERITED_AUTH[provider!] ?? []) delete env[k];
      const endpoint = this.saved().find((a) => a.provider === provider && a.id === id && a.kind === "endpoint");
      if (endpoint) {
        // A model server of your own: Claude Code is pointed at it here; Codex gets it in each thread's settings
        // (codex.ts). Both keep their usual folders, so their sessions stay where their apps find them.
        if (provider === "claude") Object.assign(env, claudeEndpointEnv(endpoint, readSecrets()[apiKeySecret(provider, id)] ?? ""));
        return env;
      }
      const apiKey = this.apiKeyOf(provider!, id);
      if (provider === "claude" && apiKey !== null) {
        // Claude Code with an API key keeps the usual folder, so its sessions stay where the Claude app finds them;
        // the key in the environment takes precedence over the plan sign-in.
        env.ANTHROPIC_API_KEY = apiKey;
        const ws = this.saved().find((a) => a.provider === provider && a.id === id)?.workspaceId;
        if (ws) env.ANTHROPIC_CUSTOM_HEADERS = `anthropic-workspace-id: ${ws}`;
      } else {
        const dir = this.accountDir(provider!, id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        env[key] = dir;
      }
    }
    return env;
  }

  /** An API-key account's key ("" if it's missing); null when the account isn't an API-key account. */
  private apiKeyOf(p: Provider, id: string): string | null {
    const saved = this.saved().find((a) => a.provider === p && a.id === id);
    if (saved?.kind !== "apikey") return null;
    return readSecrets()[apiKeySecret(p, id)] ?? "";
  }

  isApiKeyAccount(p: Provider, id: string): boolean {
    return this.apiKeyOf(p, id) !== null;
  }

  /**
   * The key (and Claude workspace) an API-key account runs its agent with, for the provider's own free lookups (Anthropic's
   * model list). Null for any other account, or one whose key is missing. Never to be logged or sent to a client.
   */
  apiKeyFor(p: Provider, id: string): { key: string; workspaceId: string | null } | null {
    const key = this.apiKeyOf(p, id);
    if (!key) return null;
    return { key, workspaceId: this.saved().find((a) => a.provider === p && a.id === id)?.workspaceId ?? null };
  }

  /**
   * What a provider looks up for an account's model list besides asking its CLI (Anthropic's Models API, for a Claude
   * API key), kept in kv `modelLookups`: `fresh` is kept and given back; null (it couldn't be asked this time) gives the
   * last one kept, after a restart too. Never given keys to keep.
   */
  lastLookup<T>(p: Provider, id: string, fresh: T | null): T | null {
    const key = `${p}:${id}`;
    const all = this.kvJson<Record<string, unknown>>("modelLookups", {});
    if (fresh === null) return (all[key] as T | undefined) ?? null;
    if (JSON.stringify(all[key]) !== JSON.stringify(fresh)) this.app.store.kvSet("modelLookups", JSON.stringify({ ...all, [key]: fresh }));
    return fresh;
  }

  /** The model server an account uses, if it's a custom-model account (with its key, for the agent's settings). */
  endpointOf(p: Provider, id: string): (EndpointInfo & { id: string; label: string; key: string }) | null {
    const a = this.saved().find((x) => x.provider === p && x.id === id && x.kind === "endpoint");
    if (!a?.baseUrl) return null;
    const key = readSecrets()[apiKeySecret(p, id)] ?? "";
    return {
      id,
      label: a.label,
      baseUrl: a.baseUrl,
      models: a.models ?? [],
      contextWindow: a.contextWindow ?? null,
      hasKey: !!key,
      key,
      ...(a.protocol ? { protocol: a.protocol } : {}),
      ...(a.chatPath ? { chatPath: a.chatPath } : {}),
      ...(a.contexts ? { contexts: a.contexts } : {}),
      ...(a.extra ? { extra: a.extra } : {}),
    };
  }

  /**
   * Checks a model server: the models it serves and, when it says, the context each request gets (llama.cpp's
   * /props, LM Studio's model list). Runs on the hub, which is where a local server is reachable from.
   */
  async probeEndpoint(address: string, apiKey = ""): Promise<EndpointProbe> {
    const baseUrl = endpointAddress(address);
    // A catalogue service's model list is every model on Hugging Face (Featherless: 22,406 of them, about 7 MB). It is
    // never read here, and its first 50 names would be no use as this account's models anyway: the model is found by
    // name in the Add sheet, which is where this says to go (hub/src/featherless.ts, GET /api/services/catalog).
    if (this.app.services.catalog.serves(baseUrl)) throw new HttpError(400, "Featherless serves tens of thousands of models, too many to list here. Add it in Settings → AI services, where you can search them by name.");
    const found = await readServer(baseUrl, cleanKey(apiKey), { timeoutMs: this.app.services.timeoutMs });
    if (found.status === 401 || found.status === 403) throw new HttpError(400, "The server wants an API key (or a different one)");
    if (!found.listed) throw new HttpError(502, `No model server answered at ${baseUrl} (${found.failed === "timeout" ? "no answer in time" : found.failed ? "couldn't connect" : `/v1/models: ${found.status}`}). Is it running?`);
    const sized = found.models.find((m) => m.loaded && m.contextWindow) ?? found.models.find((m) => m.contextWindow);
    return { baseUrl, models: found.models.map((m) => m.id).slice(0, 50), contextWindow: sized?.contextWindow ?? null, server: found.kind ? SERVER_NAMES[found.kind] : null };
  }

  /** Adds (or, given `id`, changes) an account that runs the agent on a model server of your own. */
  setEndpointAccount(p: Provider, input: { id?: string; label?: string; baseUrl: string; apiKey?: string | null; models: unknown; contextWindow?: unknown; protocol?: unknown; chatPath?: unknown; contexts?: unknown; extra?: unknown }): AgentAccount {
    // Crosstalk's own agent and OpenCode run only on AI services: they are their only accounts.
    if (!API_KEY_PROVIDERS.includes(p) && !isServiceOnlyAgent(p)) throw new HttpError(400, `${PROVIDER_INFO[p]?.name ?? p} can't use a custom model here`);
    const baseUrl = endpointAddress(input.baseUrl);
    // protocol, chatPath, contexts and extra: not given keeps what the account has (an older app doesn't know them), null takes them away.
    const changed = endpointFields(p, input);
    const apiKey = input.apiKey === undefined ? undefined : cleanKey(input.apiKey) || null;
    const models = (Array.isArray(input.models) ? input.models : String(input.models ?? "").split(","))
      .map((m) => String(m).trim())
      .filter((m) => m && m.length <= 200 && !/\s/.test(m))
      .slice(0, 20);
    if (!models.length) throw new HttpError(400, "Name at least one model the server runs (Check fills this in)");
    const ctxRaw = input.contextWindow === null || input.contextWindow === undefined || input.contextWindow === "" ? null : Number(input.contextWindow);
    if (ctxRaw !== null && (!Number.isInteger(ctxRaw) || ctxRaw < 2048 || ctxRaw > 10_000_000)) throw new HttpError(400, "The context size is a number of tokens, like 32768");
    const saved = this.saved();
    let id = input.id;
    const fields = { baseUrl, models, ...(ctxRaw ? { contextWindow: ctxRaw } : {}) };
    if (id) {
      const cur = saved.find((a) => a.provider === p && a.id === id && a.kind === "endpoint");
      if (!cur) throw new HttpError(404, "No such custom model");
      const next: SavedAccount = { provider: p, id, label: cur.label, kind: "endpoint", ...fields, ...mergeEndpointFields(cur, changed) };
      this.saveAccounts(saved.map((a) => (a === cur ? next : a)));
    } else {
      const name = (input.label ?? "").trim().slice(0, 40) || models[0].split("/").pop()!.slice(0, 40);
      if (saved.some((a) => a.provider === p && a.label.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `There's already a ${PROVIDER_INFO[p].name} account called "${name}"`);
      id = crypto.randomUUID().slice(0, 8);
      this.saveAccounts([...saved, { provider: p, id, label: name, kind: "endpoint", ...fields, ...mergeEndpointFields(undefined, changed) }]);
    }
    // No key field: keep the one saved. An empty one: the server doesn't need any.
    if (apiKey !== undefined) writeSecret(apiKeySecret(p, id), apiKey);
    this.modelCache.delete(`${p}:${id}`);
    this.modelsFailed.delete(`${p}:${id}`);
    this.accountStatus.set(`${p}:${id}`, this.endpointStatus(p, id));
    this.emitAccount(p, id);
    // Pickers and context meters showing this server's models get the new list and context size.
    void this.models(p, id).then((catalog) => this.app.bus.emit({ t: "models", catalog }));
    return this.account(p, id);
  }

  /** A custom model counts as ready to use: there's no sign-in to check (a server that's down shows in the chat). */
  private endpointStatus(p: Provider, id: string): ProviderStatus {
    const a = this.saved().find((x) => x.provider === p && x.id === id);
    const bin = this.which(p);
    return { ...this.blank(p), installed: !!bin, binPath: bin, version: this.statuses.get(p)?.version ?? null, signedIn: true, account: a?.baseUrl ?? null, plan: "Custom model", authMethod: "endpoint", checkedAt: Date.now() };
  }

  private baseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || LEAKY_ENV.test(k)) continue;
      env[k] = v;
    }
    const home = homedir();
    const extra = [join(home, ".local/bin"), join(home, ".claude/local"), join(home, ".bun/bin"), join(home, ".npm-global/bin"), join(home, ".muse/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    const parts = (env.PATH ?? "").split(":").filter(Boolean);
    for (const p of extra) if (!parts.includes(p)) parts.push(p);
    env.PATH = parts.join(":");
    const secrets = readSecrets();
    if (secrets.META_API_KEY) env.META_API_KEY = secrets.META_API_KEY;
    if (secrets.GEMINI_API_KEY) env.GEMINI_API_KEY = secrets.GEMINI_API_KEY;
    return env;
  }

  list(): ProviderStatus[] {
    return [...modules.keys()].map((p) => this.statuses.get(p) ?? this.blank(p));
  }

  get(p: Provider): ProviderStatus {
    const account = this.currentAccount(p);
    if (account !== DEFAULT_ACCOUNT) return this.accountStatus.get(`${p}:${account}`) ?? this.blank(p);
    return this.statuses.get(p) ?? this.blank(p);
  }

  // ---------- accounts ----------

  private saved(): SavedAccount[] {
    try {
      return JSON.parse(this.app.store.kvGet("accounts") ?? "[]") as SavedAccount[];
    } catch {
      return [];
    }
  }

  private saveAccounts(list: SavedAccount[]) {
    this.app.store.kvSet("accounts", JSON.stringify(list));
  }

  private toAccount(p: Provider, id: string, label: string, kind?: SavedAccount["kind"], workspaceId?: string): AgentAccount {
    const st = id === DEFAULT_ACCOUNT ? this.statuses.get(p) : kind === "endpoint" ? (this.accountStatus.get(`${p}:${id}`) ?? this.endpointStatus(p, id)) : this.accountStatus.get(`${p}:${id}`);
    const ep = kind === "endpoint" ? this.endpointOf(p, id) : null;
    // What a Codex request to this service last cost (adapter/cost.ts); none until one has gone through the chat adapter.
    const cost = ep ? newestToolCost(this.app.store, p, id) : null;
    return {
      provider: p,
      id,
      label,
      kind: kind ?? "signin",
      workspaceId: workspaceId ?? null,
      endpoint: ep
        ? {
            baseUrl: ep.baseUrl,
            models: ep.models,
            contextWindow: ep.contextWindow,
            hasKey: ep.hasKey,
            ...(cost ? { toolCost: cost } : {}),
            ...(ep.protocol ? { protocol: ep.protocol } : {}),
            ...(ep.chatPath ? { chatPath: ep.chatPath } : {}),
            ...(ep.contexts ? { contexts: ep.contexts } : {}),
            ...(ep.extra ? { extra: ep.extra } : {}),
          }
        : null,
      signedIn: st?.signedIn ?? null,
      account: st?.account ?? null,
      plan: st?.plan ?? null,
      authMethod: st?.authMethod ?? null,
      error: st?.error ?? null,
      checkedAt: st?.checkedAt ?? 0,
    };
  }

  /** Every account: each installed agent's own sign-in, plus any extra accounts added for it. */
  accounts(): AgentAccount[] {
    const saved = this.saved();
    const out: AgentAccount[] = [];
    for (const p of Object.keys(PROVIDER_INFO) as Provider[]) {
      if (p === "mock") continue;
      // Crosstalk's own agent and OpenCode have no sign-in of their own: their accounts are the AI services they run on.
      if (isServiceOnlyAgent(p)) {
        for (const a of saved) if (a.provider === p && a.id !== DEFAULT_ACCOUNT) out.push(this.toAccount(p, a.id, a.label, a.kind, a.workspaceId));
        continue;
      }
      const own = saved.find((a) => a.provider === p && a.id === DEFAULT_ACCOUNT);
      if (this.statuses.get(p)?.installed || saved.some((a) => a.provider === p)) out.push(this.toAccount(p, DEFAULT_ACCOUNT, own?.label ?? "Main"));
      for (const a of saved) if (a.provider === p && a.id !== DEFAULT_ACCOUNT) out.push(this.toAccount(p, a.id, a.label, a.kind, a.workspaceId));
    }
    return out;
  }

  account(p: Provider, id: string): AgentAccount {
    const a = this.accounts().find((x) => x.provider === p && x.id === id);
    if (!a) throw new HttpError(404, "No such account");
    return a;
  }

  hasAccount(p: Provider, id: string): boolean {
    return id === DEFAULT_ACCOUNT || this.saved().some((a) => a.provider === p && a.id === id);
  }

  private emitAccount(p: Provider, id: string) {
    try {
      this.app.bus.emit({ t: "account", account: this.account(p, id) });
    } catch {
      /* removed meanwhile */
    }
  }

  addAccount(p: Provider, label: string): AgentAccount {
    noSignIn(p);
    if (!MULTI_ACCOUNT_PROVIDERS.includes(p)) throw new HttpError(400, `${PROVIDER_INFO[p]?.name ?? p} can only use one account on a hub`);
    const name = label.trim().slice(0, 40) || "Another account";
    const saved = this.saved();
    if (saved.some((a) => a.provider === p && a.label.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `There's already a ${PROVIDER_INFO[p].name} account called "${name}"`);
    const id = crypto.randomUUID().slice(0, 8);
    this.saveAccounts([...saved, { provider: p, id, label: name }]);
    mkdirSync(this.accountDir(p, id), { recursive: true, mode: 0o700 });
    this.emitAccount(p, id);
    return this.account(p, id);
  }

  /**
   * Adds (or, given `id`, re-keys) an account that uses an API key, billed per use, instead of a plan sign-in. The
   * key is kept in the hub's secrets file; Codex also stores it in that account's own Codex folder, so the Codex
   * app's sign-in is never touched.
   */
  async setApiKeyAccount(p: Provider, apiKey: string, opts: { id?: string; label?: string; workspaceId?: string | null } = {}): Promise<AgentAccount> {
    if (!API_KEY_PROVIDERS.includes(p)) throw new HttpError(400, `${PROVIDER_INFO[p]?.name ?? p} can't use an API key here`);
    const key = apiKey.trim();
    // An existing account can keep its key and change only the workspace.
    const keepKey = !key && !!opts.id;
    if (!keepKey && (key.length < 20 || /\s/.test(key))) throw new HttpError(400, "That doesn't look like an API key");
    let workspaceId: string | undefined;
    if (opts.workspaceId !== undefined && opts.workspaceId !== null && String(opts.workspaceId).trim()) {
      workspaceId = String(opts.workspaceId).trim();
      if (p !== "claude") throw new HttpError(400, "Only Claude API keys take a workspace ID");
      if (!/^wrkspc_[A-Za-z0-9]+$/.test(workspaceId)) throw new HttpError(400, "A workspace ID looks like wrkspc_01AbC… (Claude Console → Settings → Workspaces)");
    }
    const saved = this.saved();
    let id = opts.id;
    if (id) {
      const cur = saved.find((a) => a.provider === p && a.id === id && a.kind === "apikey");
      if (!cur) throw new HttpError(404, "No such API key account");
      if (opts.workspaceId !== undefined) {
        const next = { ...cur, workspaceId };
        if (!workspaceId) delete next.workspaceId;
        this.saveAccounts(saved.map((a) => (a === cur ? next : a)));
      }
    } else {
      const name = (opts.label ?? "").trim().slice(0, 40) || "API key";
      if (saved.some((a) => a.provider === p && a.label.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `There's already a ${PROVIDER_INFO[p].name} account called "${name}"`);
      id = crypto.randomUUID().slice(0, 8);
      this.saveAccounts([...saved, { provider: p, id, label: name, kind: "apikey", ...(workspaceId ? { workspaceId } : {}) }]);
    }
    if (!keepKey) writeSecret(apiKeySecret(p, id), key);
    if (p === "codex" && !keepKey) {
      const bin = this.which("codex");
      if (bin) {
        const { startCodexServer } = await import("../agents/codex");
        const rpc = await startCodexServer(bin, { env: this.agentEnv("codex", id) });
        try {
          await rpc.request("account/login/start", { type: "apiKey", apiKey: key }, 30_000);
        } finally {
          void rpc.kill();
        }
      }
    }
    this.modelCache.delete(`${p}:${id}`);
    // What the old key (or workspace) could use isn't what this one can.
    this.dropKv("modelLookups", `${p}:${id}`);
    await this.refreshAccount(p, id).catch((e) => log.warn(`${p} API key: ${e}`));
    // Another key can mean other models: lists on screen get the new one.
    if (this.modelsAsked.has(`${p}:${id}`)) void this.models(p, id, { fresh: true }).catch(() => {});
    return this.account(p, id);
  }

  renameAccount(p: Provider, id: string, label: string): AgentAccount {
    const name = label.trim().slice(0, 40);
    if (!name) throw new HttpError(400, "Give the account a name");
    if (!this.hasAccount(p, id)) throw new HttpError(404, "No such account");
    const saved = this.saved();
    if (saved.some((a) => a.provider === p && a.id !== id && a.label.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `There's already a ${PROVIDER_INFO[p].name} account called "${name}"`);
    const rest = saved.filter((a) => !(a.provider === p && a.id === id));
    const cur = saved.find((a) => a.provider === p && a.id === id);
    this.saveAccounts([...rest, { ...cur, provider: p, id, label: name }].sort((a, b) => saved.findIndex((x) => x.id === a.id) - saved.findIndex((x) => x.id === b.id)));
    this.emitAccount(p, id);
    return this.account(p, id);
  }

  /** Removes an extra account and its sign-in folder. Refused for the agent's own sign-in or while an agent uses it. */
  removeAccount(p: Provider, id: string) {
    if (id === DEFAULT_ACCOUNT) throw new HttpError(409, "This is the agent's own sign-in. Sign out instead of removing it.");
    if (!this.hasAccount(p, id)) throw new HttpError(404, "No such account");
    const users = this.app.store.listRooms().flatMap((r) => this.app.store.listMembers(r.id).filter((m) => m.provider === p && m.config?.account === id).map((m) => `@${m.handle} in ${r.name}`));
    if (users.length) throw new HttpError(409, `Switch these agents to another account first: ${users.join(", ")}`);
    this.saveAccounts(this.saved().filter((a) => !(a.provider === p && a.id === id)));
    // If new agents of this kind defaulted to it, they go back to the main account.
    const defaults = this.app.defaults();
    const d = defaults.agent[p];
    if (d?.account === id) {
      // The helper model was one of that account's models.
      const { helperModel: _gone, ...rest } = d;
      this.app.setDefaults({ agent: { ...defaults.agent, [p]: { ...rest, account: undefined } } });
    }
    this.accountStatus.delete(`${p}:${id}`);
    this.forgetModels(`${p}:${id}`);
    this.app.store.deleteUsage(p, id);
    writeSecret(apiKeySecret(p, id), null);
    rmSync(this.accountDir(p, id), { recursive: true, force: true });
    this.app.bus.emit({ t: "account.deleted", provider: p, id });
  }

  /**
   * Runs a service on the other of the agents that run only on services (Crosstalk's own, OpenCode) without its key being
   * typed again: it's added for that agent as it stands, and the old account goes unless chats still use it (they keep
   * running on it). A service already added for that agent at the same address is just answered with.
   */
  switchServiceAgent(from: Provider, id: string, to: unknown): AgentAccount {
    const ep = this.endpointOf(from, id);
    if (!ep) throw new HttpError(404, "No such AI service");
    if (!isServiceOnlyAgent(from) || !isServiceOnlyAgent(to) || from === to) throw new HttpError(400, "A service can only be moved between Crosstalk's agent and OpenCode.");
    if (to === "opencode" && !this.which(to)) throw new HttpError(400, "OpenCode isn't installed on this machine yet. Install it under Settings → AI services first.");
    const there = this.saved().find((a) => a.provider === to && a.kind === "endpoint" && a.baseUrl === ep.baseUrl);
    const account = there
      ? this.account(to, there.id)
      : this.setEndpointAccount(to, { label: ep.label, baseUrl: ep.baseUrl, apiKey: ep.key, models: ep.models, contextWindow: ep.contextWindow, protocol: "chat", ...(ep.contexts ? { contexts: ep.contexts } : {}), ...(ep.chatPath ? { chatPath: ep.chatPath } : {}), ...(ep.extra ? { extra: ep.extra } : {}) });
    const used = this.app.store.listRooms().some((r) => this.app.store.listMembers(r.id).some((m) => m.provider === from && m.config?.account === id));
    if (!used) this.removeAccount(from, id);
    this.app.spend.budgetMoved(from, id, to, account.id, !used);
    return account;
  }

  /** Sign-in state for one account (runs the agent's own status check against that account's folder). */
  async refreshAccount(p: Provider, id: string): Promise<AgentAccount> {
    if (id === DEFAULT_ACCOUNT) {
      await this.refresh(p);
      return this.account(p, id);
    }
    if (!this.hasAccount(p, id)) throw new HttpError(404, "No such account");
    if (this.endpointOf(p, id)) {
      this.accountStatus.set(`${p}:${id}`, this.endpointStatus(p, id));
      this.emitAccount(p, id);
      return this.account(p, id);
    }
    const mod = modules.get(p);
    const bin = this.which(p);
    const st = { ...this.blank(p), checkedAt: Date.now(), installed: !!bin, binPath: bin, version: this.statuses.get(p)?.version ?? null };
    if (bin && mod?.checkAuth) {
      try {
        Object.assign(st, await this.forAccount(p, id, () => mod.checkAuth!(this.app, bin)));
      } catch (e) {
        st.error = e instanceof Error ? e.message : String(e);
      }
    }
    const prev = this.accountStatus.get(`${p}:${id}`);
    this.accountStatus.set(`${p}:${id}`, st);
    if (prev && (prev.version !== st.version || prev.signedIn !== st.signedIn)) this.agentChanged(p, id);
    this.emitAccount(p, id);
    // Signed in: a sign-out recorded for it (signin.ts) is over.
    this.app.signIns?.statusChecked(p, id, st.signedIn);
    return this.account(p, id);
  }

  async loginAccount(p: Provider, id: string, method?: string): Promise<LoginFlow> {
    noSignIn(p);
    if (!this.hasAccount(p, id)) throw new HttpError(404, "No such account");
    // Everything the sign-in starts (terminals, polling, the refresh when it finishes) stays in this account's scope.
    return this.forAccount(p, id, () => this.login(p, method));
  }

  async logoutAccount(p: Provider, id: string) {
    noSignIn(p);
    if (!this.hasAccount(p, id)) throw new HttpError(404, "No such account");
    await this.forAccount(p, id, () => this.logout(p));
  }

  private blank(p: Provider): ProviderStatus {
    return {
      provider: p,
      installed: false,
      version: null,
      binPath: null,
      signedIn: null,
      account: null,
      plan: null,
      authMethod: null,
      error: null,
      checkedAt: 0,
    };
  }

  /** Locate a provider's binary on PATH or in its installer's usual folders. */
  which(p: Provider): string | null {
    const mod = modules.get(p);
    if (!mod) return null;
    // The compiled-binary check: never find (or sign in to) the real agent CLIs on this computer.
    if (process.env.CROSSTALK_NO_AGENT_CLIS === "1" && p !== "mock") return null;
    if (mod.ownBin) {
      const own = mod.ownBin.replace(/^~/, homedir());
      if (existsSync(own)) return own;
    }
    const env = this.agentEnv();
    for (const name of mod.binNames) {
      const found = Bun.which(name, { PATH: env.PATH });
      if (found) return found;
      for (const dir of mod.extraPaths) {
        const full = join(dir.replace(/^~/, homedir()), name);
        if (existsSync(full)) return full;
      }
    }
    return null;
  }

  bin(p: Provider): string {
    const b = this.which(p);
    if (!b) throw new Error(`${p} isn't installed on the hub`);
    return b;
  }

  async refresh(p: Provider): Promise<ProviderStatus> {
    // Called from inside an account's scope (e.g. when its sign-in finishes): refresh that account.
    const scoped = this.currentAccount(p);
    if (scoped !== DEFAULT_ACCOUNT) {
      await this.refreshAccount(p, scoped);
      return this.accountStatus.get(`${p}:${scoped}`) ?? this.blank(p);
    }
    const mod = modules.get(p);
    const st = this.blank(p);
    st.checkedAt = Date.now();
    if (!mod) return st;
    // Crosstalk's own agent is part of the hub: always there, at the hub's own version, with nothing to sign in to.
    if (p === "builtin") {
      Object.assign(st, { installed: true, version: HUB_VERSION, signedIn: true });
      this.statuses.set(p, st);
      this.app.bus.emit({ t: "provider", status: st });
      return st;
    }
    const bin = this.which(p);
    this.pathCache.set(p, bin);
    if (bin) {
      st.installed = true;
      st.binPath = bin;
      try {
        const proc = Bun.spawn([bin, ...mod.versionArgs], { stdout: "pipe", stderr: "pipe", env: this.agentEnv() });
        const timer = setTimeout(() => proc.kill(), 10_000);
        const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
        clearTimeout(timer);
        st.version = (out.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? out.trim().split("\n")[0]?.slice(0, 40)) || null;
      } catch (e) {
        st.error = `version check failed: ${e instanceof Error ? e.message : e}`;
      }
      if (mod.checkAuth) {
        try {
          Object.assign(st, await mod.checkAuth(this.app, bin));
        } catch (e) {
          st.error = e instanceof Error ? e.message : String(e);
        }
      }
    }
    const prev = this.statuses.get(p);
    this.statuses.set(p, st);
    if (prev && (prev.version !== st.version || prev.signedIn !== st.signedIn)) this.agentChanged(p, DEFAULT_ACCOUNT);
    this.app.bus.emit({ t: "provider", status: st });
    this.emitAccount(p, DEFAULT_ACCOUNT);
    // Signed in: a sign-out recorded for it (signin.ts) is over.
    this.app.signIns?.statusChecked(p, DEFAULT_ACCOUNT, st.signedIn);
    return st;
  }

  async refreshAll() {
    await Promise.all([...modules.keys()].map((p) => this.refresh(p).catch((e) => log.warn(`${p}: ${e}`))));
    await Promise.all(this.saved().filter((a) => a.id !== DEFAULT_ACCOUNT).map((a) => this.refreshAccount(a.provider, a.id).catch((e) => log.warn(`${a.provider}/${a.label}: ${e}`))));
  }

  async refreshUsage(p?: Provider) {
    for (const [id, mod] of modules) {
      if (p && id !== p) continue;
      const bin = this.which(id);
      if (!bin || !mod.refreshUsage) continue;
      const st = this.statuses.get(id);
      if (!(st && st.signedIn === false)) {
        try {
          await mod.refreshUsage(this.app, bin);
        } catch (e) {
          log.debug(`usage ${id}: ${e}`);
        }
      }
      // Each extra account has its own plan and limits (API keys have neither: they're billed per use).
      for (const a of this.saved()) {
        if (a.provider !== id || a.id === DEFAULT_ACCOUNT || a.kind === "apikey" || a.kind === "endpoint" || this.accountStatus.get(`${id}:${a.id}`)?.signedIn === false) continue;
        try {
          await this.forAccount(id, a.id, () => mod.refreshUsage!(this.app, bin));
        } catch (e) {
          log.debug(`usage ${id}/${a.label}: ${e}`);
        }
      }
    }
  }

  /**
   * The models an agent offers, from its own CLI (cached for a few minutes; plans and CLIs change slowly). Asked per
   * account: two accounts on different plans can offer different models. Lists in use are asked again in the
   * background (watchModels), and a "models" event goes out when one changes.
   */
  async models(p: Provider, account: string = DEFAULT_ACCOUNT, opts: { fresh?: boolean } = {}): Promise<ModelCatalog> {
    const id = this.hasAccount(p, account) ? account : DEFAULT_ACCOUNT;
    const key = `${p}:${id}`;
    this.modelsAsked.add(key);
    const hit = this.modelCache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (!opts.fresh && hit && age < MODEL_LIST_TTL) return hit.catalog;
    const failed = this.modelsFailed.get(key);
    if (!opts.fresh && !hit && failed && Date.now() - failed.at < MODEL_LIST_RETRY) return failed.catalog;
    let job = this.modelsListing.get(key);
    if (!job) {
      job = this.askForModels(p, id, hit?.catalog ?? null).finally(() => this.modelsListing.delete(key));
      this.modelsListing.set(key, job);
    }
    // An older list is answered at once while the agent is asked again (clients hear of a change as an event).
    if (!opts.fresh && hit && age < MODEL_LIST_STALE_OK) {
      job.catch(() => {});
      return hit.catalog;
    }
    return job;
  }

  private async askForModels(p: Provider, id: string, before: ModelCatalog | null): Promise<ModelCatalog> {
    const key = `${p}:${id}`;
    const mod = modules.get(p);
    const bin = this.which(p);
    // A custom model server offers what it lists now, with the context each model gets (the names saved with the account when it can't be asked).
    const ep = this.endpointOf(p, id);
    // An endpoint's saved names were never fetched from anywhere: its list has a time only once its server has answered.
    const catalog: ModelCatalog = { provider: p, accountId: id, models: ep ? this.withToolCost(p, id, endpointModelOptions(ep, null)) : (mod?.modelHints ?? []), live: false, error: null, ...(ep ? {} : { checkedAt: Date.now() }) };
    if (!ep && (!mod?.listModels || !bin)) return catalog;
    // Everything the agent listed, with any More model left out for running another model: sizing checks those again.
    let listed: ModelOption[] = [];
    try {
      if (ep) {
        const live = await this.app.services.endpointModels(ep);
        this.rememberContexts(p, id, live);
        catalog.models = this.withToolCost(p, id, endpointModelOptions(this.endpointOf(p, id) ?? ep, live));
      } else {
        listed = await this.forAccount(p, id, () => mod!.listModels!(this.app, bin!));
        catalog.models = this.withKnown(p, id, this.runnable(key, listed), before);
        catalog.gone = this.goneModels(key, catalog.models);
      }
      catalog.live = true;
      if (ep) catalog.checkedAt = Date.now();
    } catch (e) {
      catalog.error = e instanceof Error ? e.message : String(e);
      log.debug(`models ${p}: ${catalog.error}`);
      if (ep && before?.checkedAt) {
        // A server that listed before and can't be asked now: its list stands, marked as not live with the time it is
        // from (what the apps say: "couldn't reach it, showing the list from ..."). Asked again after a short wait.
        const stale: ModelCatalog = { ...before, live: false, error: catalog.error };
        this.modelCache.set(key, { at: Date.now() - MODEL_LIST_TTL + MODEL_LIST_RETRY, catalog: stale });
        if (catalogSignature(stale) !== catalogSignature(before)) this.app.bus.emit({ t: "models", catalog: stale });
        return stale;
      }
      if (before?.live) {
        // The agent couldn't be asked this time: the list it gave before still stands (models rarely go away). It's
        // asked again after a short wait, not on every request meanwhile.
        this.modelCache.set(key, { at: Date.now() - MODEL_LIST_TTL + MODEL_LIST_RETRY, catalog: before });
        return { ...before, error: catalog.error };
      }
      this.modelsFailed.set(key, { at: Date.now(), catalog });
      return catalog;
    }
    this.modelsFailed.delete(key);
    this.modelCache.set(key, { at: Date.now(), catalog });
    // Clients that had something else (an older list, or suggestions while the agent couldn't be asked) get this one.
    if (!before || catalogSignature(before) !== catalogSignature(catalog)) this.app.bus.emit({ t: "models", catalog });
    if (!ep && bin) void this.checkContext(p, id, bin, listed);
    return catalog;
  }

  /**
   * The list without the More models its agent was found to run another model in place of (ModelContextInfo.runsAs):
   * they wouldn't run on this machine. They're checked again with the sizes.
   */
  private runnable(key: string, models: ModelOption[]): ModelOption[] {
    const sizes = this.savedContext()[key]?.models ?? {};
    return models.filter((m) => !(m.more && sizes[m.id]?.runsAs));
  }

  /**
   * Keeps the context sizes an endpoint's server gave. The account's own models' go on the account (EndpointInfo.contexts),
   * for when the server can't be asked; its other models' (under More models) are kept like the sizes an agent's list
   * gives, so a chat on one runs with its own size (App.endpointFor), after a restart too.
   */
  private rememberContexts(p: Provider, id: string, live: { id: string; contextWindow: number | null }[] | null) {
    const saved = this.saved();
    const cur = saved.find((a) => a.provider === p && a.id === id && a.kind === "endpoint");
    if (!cur || !live) return;
    this.rememberSizes(`${p}:${id}`, live.filter((m) => !cur.models?.includes(m.id)));
    const contexts = { ...cur.contexts };
    for (const m of live) if (m.contextWindow && cur.models?.includes(m.id)) contexts[m.id] = m.contextWindow;
    if (JSON.stringify(contexts) === JSON.stringify(cur.contexts ?? {})) return;
    this.saveAccounts(saved.map((a) => (a === cur ? { ...cur, contexts } : a)));
    this.emitAccount(p, id);
  }

  /**
   * The agent's list, with what Crosstalk learned about each model before: what it can hold (a size the agent didn't
   * give this time, because its catalog couldn't be read say, is the one it gave last), and when it first came.
   */
  private withKnown(p: Provider, id: string, listed: ModelOption[], before: ModelCatalog | null): ModelOption[] {
    const key = `${p}:${id}`;
    this.rememberSizes(key, listed);
    const sizes = this.savedContext()[key]?.models ?? {};
    const seen = this.noteFirstSeen(key, listed);
    return listed.map((m) => ({ ...m, ...sizeFields(before?.models.find((x) => x.id === m.id)), ...sizeFields(sizes[m.id]), ...defined(m), firstSeen: seen[m.id] ?? 0 }));
  }

  /**
   * The list with what a Codex request on each model was last measured to cost (adapter/cost.ts). Only a model a request has
   * actually gone to has one: a figure for a model nobody has used would be a guess, and the point of it is to be measured.
   */
  private withToolCost(p: Provider, id: string, models: ModelOption[]): ModelOption[] {
    const costs = toolCostsFor(this.app.store, p, id);
    if (!Object.keys(costs).length) return models;
    return models.map((m) => (costs[m.id] ? { ...m, toolCost: costs[m.id] } : m));
  }

  /**
   * A fresh measurement of what the agent's tools cost on one of an account's models (the chat adapter calls this when it keeps
   * one): the model list and the account's own row both say it, so both go out again.
   */
  toolCostChanged(p: Provider, id: string) {
    const cur = this.modelCache.get(`${p}:${id}`);
    if (cur) {
      const next: ModelCatalog = { ...cur.catalog, models: this.withToolCost(p, id, cur.catalog.models) };
      if (catalogSignature(next) !== catalogSignature(cur.catalog)) {
        this.modelCache.set(`${p}:${id}`, { at: cur.at, catalog: next });
        this.app.bus.emit({ t: "models", catalog: next });
      }
    }
    this.emitAccount(p, id);
  }

  /** Sizes an agent's list gives itself (Codex, Muse, a model server's) are kept too, so they're known at once after a restart. */
  private rememberSizes(key: string, listed: (ModelContextInfo & { id: string })[]) {
    const given = listed.filter((m) => typeof m.contextWindow === "number" && m.contextWindow > 0);
    if (!given.length) return;
    const all = this.savedContext();
    const cur = all[key] ?? { at: 0, models: {} };
    const models = { ...cur.models };
    for (const m of given) models[m.id] = { ...models[m.id], ...sizeFields(m) };
    if (JSON.stringify(models) === JSON.stringify(cur.models)) return;
    this.app.store.kvSet("modelContext", JSON.stringify({ ...all, [key]: { at: cur.at, models } }));
  }

  /**
   * When each of an account's models first showed up in its agent's list (so new ones can be marked). The first list
   * Crosstalk sees for an account is where it starts counting: those models count as old. So does one under More models:
   * the first list asked with them would date them all, and an app that doesn't know More models would call them new.
   * Keyed "provider:account"; a model's full name (what an alias resolves to) is kept as well.
   */
  private noteFirstSeen(key: string, listed: ModelOption[]): Record<string, number> {
    const all = this.kvJson<Record<string, Record<string, number>>>("modelFirstSeen", {});
    const had = all[key];
    const mine = { ...(had ?? {}) };
    let changed = !had;
    for (const m of listed) {
      for (const id of [m.id, m.resolvedModel ?? m.id]) {
        if (mine[id] !== undefined) continue;
        mine[id] = had && !m.more ? Date.now() : 0;
        changed = true;
      }
    }
    if (changed) this.app.store.kvSet("modelFirstSeen", JSON.stringify({ ...all, [key]: mine }));
    return mine;
  }

  /** Models the account's agent listed before but doesn't now: a chat still set to one may fail. */
  private goneModels(key: string, models: ModelOption[]): string[] {
    const now = new Set(models.flatMap((m) => [m.id, m.resolvedModel ?? m.id]));
    return Object.keys(this.kvJson<Record<string, Record<string, number>>>("modelFirstSeen", {})[key] ?? {}).filter((id) => !now.has(id));
  }

  /** Context sizes learned from the agents, by "provider:account": when they were asked, and each model's. */
  private savedContext(): Record<string, { at: number; models: Record<string, ModelContextInfo> }> {
    return this.kvJson("modelContext", {});
  }

  private kvJson<T>(key: string, fallback: T): T {
    try {
      const raw = this.app.store.kvGet(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Context sizes the agent reports separately (Claude Code takes a second or so per model): asked in the background
   * when they're unknown or old, kept, and sent to clients as a "models" event.
   */
  private async checkContext(p: Provider, id: string, bin: string, models: ModelOption[]) {
    const mod = modules.get(p);
    const key = `${p}:${id}`;
    if (!mod?.modelContext || this.contextChecking.has(key) || !models.length) return;
    const saved = this.savedContext()[key];
    const unsized = !saved || models.some((m) => !(m.id in saved.models));
    if (!unsized && Date.now() - saved.at < MODEL_CONTEXT_TTL) return;
    this.contextChecking.add(key);
    try {
      const found = await this.forAccount(p, id, () => mod.modelContext!(this.app, bin, models));
      // A model the agent didn't size this time keeps what it had (a model not on this plan counts as asked, not as
      // unknown forever); full names learned before stay too, for helper agents.
      const sizes: Record<string, ModelContextInfo> = {};
      for (const m of models) sizes[m.id] = found[m.id] ?? saved?.models[m.id] ?? { contextWindow: null, ...sizeFields(m) };
      for (const [k, v] of Object.entries(found)) sizes[k] ??= v;
      for (const [k, v] of Object.entries(saved?.models ?? {})) sizes[k] ??= v;
      this.app.store.kvSet("modelContext", JSON.stringify({ ...this.savedContext(), [key]: { at: Date.now(), models: sizes } }));
      const cur = this.modelCache.get(key);
      if (!cur) return;
      // A More model found not to run here leaves the list at once, and a chat still on it is told (like a gone model's).
      // One found to run again comes back with the next list.
      const kept = this.runnable(key, cur.catalog.models);
      const next = { ...cur.catalog, models: kept.map((m) => ({ ...m, ...sizeFields(found[m.id]) })), ...(kept.length < cur.catalog.models.length ? { gone: this.goneModels(key, kept) } : {}) };
      if (catalogSignature(next) === catalogSignature(cur.catalog)) return;
      this.modelCache.set(key, { at: cur.at, catalog: next });
      this.app.bus.emit({ t: "models", catalog: next });
    } catch (e) {
      log.debug(`model context ${p}: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.contextChecking.delete(key);
    }
  }

  /**
   * A model's entry as Crosstalk knows it for an account, without asking the agent: from the list it has, else from the
   * sizes it learned before (just after a restart). `model` may be an alias or what it resolves to; null is the
   * agent's default.
   */
  knownModel(p: Provider, account: string, model: string | null): ModelOption | null {
    const id = this.hasAccount(p, account) ? account : DEFAULT_ACCOUNT;
    const list = this.endpointOf(p, id) ? null : this.modelCache.get(`${p}:${id}`)?.catalog.models;
    const listed = list?.find((m) => (model ? m.id === model || m.resolvedModel === model : m.isDefault));
    if (listed) return listed;
    const sized = model ? this.savedContext()[`${p}:${id}`]?.models[model] : undefined;
    return sized ? { id: model!, label: model!, description: null, efforts: [], defaultEffort: null, isDefault: false, ...sizeFields(sized) } : null;
  }

  /**
   * A model's entry for an account (null: the agent's default): what Crosstalk knows, else asking the agent for its list
   * (just after a restart, say).
   */
  async modelInfo(p: Provider, account: string, model: string | null): Promise<ModelOption | null> {
    const known = this.knownModel(p, account, model);
    if (known?.contextWindow) return known;
    const catalog = await this.models(p, account).catch(() => null);
    return catalog?.models.find((m) => (model ? m.id === model || m.resolvedModel === model : m.isDefault)) ?? known;
  }

  /**
   * Keeps the model lists in use fresh: a model an agent starts (or stops) offering shows up without reopening
   * anything, and so does a change in what a model can hold. Returns a function that stops it.
   */
  watchModels(everyMs = MODEL_WATCH_EVERY): () => void {
    const timer = setInterval(() => void this.refreshModels(), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async refreshModels() {
    for (const key of [...this.modelsAsked]) {
      const [p, id] = key.split(":") as [Provider, string];
      if (!this.hasAccount(p, id)) {
        this.modelsAsked.delete(key);
        continue;
      }
      const st = id === DEFAULT_ACCOUNT ? this.statuses.get(p) : this.accountStatus.get(key);
      if (!this.endpointOf(p, id) && (!st?.installed || st.signedIn === false)) continue;
      await this.models(p, id, { fresh: true }).catch(() => {});
    }
  }

  /** What was learned about an account's models, for an account that's gone. */
  private forgetModels(key: string) {
    this.modelCache.delete(key);
    this.modelsAsked.delete(key);
    this.modelsFailed.delete(key);
    for (const kv of ["modelContext", "modelFirstSeen", "modelLookups", KV_COST]) this.dropKv(kv, key);
  }

  /** One account's ("provider:account") entry out of a kv record kept per account. */
  private dropKv(kv: string, key: string) {
    const all = this.kvJson<Record<string, unknown>>(kv, {});
    if (!(key in all)) return;
    delete all[key];
    this.app.store.kvSet(kv, JSON.stringify(all));
  }

  /** The agent was updated, or signed in or out: what it offers may have changed. */
  private agentChanged(p: Provider, id: string) {
    const key = `${p}:${id}`;
    const saved = this.savedContext();
    // A new version may size models differently: ask again rather than wait hours.
    if (saved[key]) this.app.store.kvSet("modelContext", JSON.stringify({ ...saved, [key]: { ...saved[key], at: 0 } }));
    if (this.modelsAsked.has(key)) void this.models(p, id, { fresh: true }).catch(() => {});
    else this.modelCache.delete(key);
  }

  /** Runs the official installer in a visible terminal so the user can watch (and answer prompts). */
  install(p: Provider) {
    const mod = modules.get(p);
    if (!mod?.installCommand) throw new Error(`No installer for ${p}`);
    const pty = this.app.pty.spawn(mod.installCommand, {
      title: `Install ${p}`,
      purpose: "install",
      provider: p,
      env: this.agentEnv(),
      cwd: homedir(),
    });
    void this.app.pty.waitExit(pty.id).then(() => this.refresh(p));
    return pty;
  }

  /** Sign-in terminals started from Settings (LoginFlow "terminal"), by agent and account, while they may be running. */
  private loginTerminals = new Map<string, string>();

  /**
   * The agent's own sign-in, the older way: a terminal every device of yours sees (or Codex's device code). One sign-in
   * per agent and account, whichever way it started: one from the phone's sheet (signin.ts) for the same account ends,
   * and so does an earlier one of these, so two never write the same sign-in at once.
   */
  async login(p: Provider, method?: string): Promise<LoginFlow> {
    noSignIn(p);
    const mod = modules.get(p);
    if (!mod?.startLogin) throw new Error(`Sign-in for ${p} isn't available`);
    const bin = this.bin(p);
    const account = this.currentAccount(p);
    this.app.signIns?.endFor(p, account, "Another sign-in for this account started, so this one stopped.");
    // Its own earlier terminal goes; an earlier device code is replaced by the module itself (Codex's startLogin).
    this.endLoginTerminal(p, account);
    const flow = await mod.startLogin(this.app, bin, { method });
    if (flow.kind === "terminal") this.loginTerminals.set(`${p}:${account}`, flow.ptyId);
    return flow;
  }

  /** Ends a sign-in started the older way for this agent and account (login), if one is still running: the sheet's took over. */
  endLogin(p: Provider, account: string) {
    this.endLoginTerminal(p, account);
    modules.get(p)?.endLogin?.(this.app, account);
  }

  private endLoginTerminal(p: Provider, account: string) {
    const key = `${p}:${account}`;
    const pty = this.loginTerminals.get(key);
    this.loginTerminals.delete(key);
    if (pty && this.app.pty.get(pty)?.alive) {
      log.info(`ended the ${p} sign-in terminal for ${account === DEFAULT_ACCOUNT ? "its own sign-in" : `account ${account}`}: another sign-in for it started`);
      this.app.pty.kill(pty);
    }
  }

  async logout(p: Provider) {
    noSignIn(p);
    const mod = modules.get(p);
    if (!mod?.logout) throw new Error(`Sign-out for ${p} isn't available`);
    await mod.logout(this.app, this.bin(p));
    await this.refresh(p);
  }
}

/**
 * The agents that run only on AI services (Crosstalk's own, OpenCode) run on a service's key: there's nothing to sign them
 * in to or out of, nor another sign-in to add for them. Each of those answers as the sign-in sheet does (signin.ts),
 * whichever of their accounts was named, with the way to its key instead.
 */
function noSignIn(p: Provider) {
  if (isServiceOnlyAgent(p)) throw new HttpError(409, noSignInWords(p), "not_signin");
}

/** Run a command to completion and capture output (for status checks). */
export async function run(
  argv: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; cwd?: string; stdin?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
    env: opts.env,
    cwd: opts.cwd,
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}
