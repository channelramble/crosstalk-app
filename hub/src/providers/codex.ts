import { homedir } from "node:os";
import type { LoginFlow, ModelOption } from "@crosstalk/shared";
import type { App } from "../app";
import { CODEX_FAST_TIER, codexRefused, codexUsage, planName, startCodexServer } from "../agents/codex";
import type { StdioRpc } from "../agents/jsonrpc";
import { installHint, run, type ModelContextInfo, type ProviderModule } from "./index";
import { logger } from "../util/log";

const log = logger("codex-provider");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One pending sign-in per account: signing in to Work must not cancel Personal's sign-in. */
const loginServers = new Map<string, { rpc: StdioRpc; timeout?: ReturnType<typeof setTimeout>; loginId?: string }>();

/**
 * Ends the device-code sign-in Settings started for this account, if one is waiting: a sign-in started for the same
 * account from the phone's sheet (signin.ts) takes over. Its dialog hears that it stopped.
 */
function endCodexLogin(app: App, accountId: string) {
  const attempt = loginServers.get(accountId);
  if (!attempt) return;
  loginServers.delete(accountId);
  clearTimeout(attempt.timeout);
  attempt.rpc.kill();
  if (attempt.loginId) app.bus.emit({ t: "login", provider: "codex", accountId, loginId: attempt.loginId, flow: null, done: true, error: "Another sign-in for this account started, so this one stopped." });
}

async function withServer<T>(app: App, bin: string, fn: (rpc: StdioRpc) => Promise<T>): Promise<T> {
  const rpc = await startCodexServer(bin, { env: app.providers.agentEnv() });
  try {
    return await fn(rpc);
  } finally {
    rpc.kill();
  }
}

function saveUsage(app: App, rl: Json, account?: string | null) {
  const accountId = app.providers.currentAccount("codex");
  const prev = app.store.getUsage("codex", accountId);
  const u = codexUsage(rl, prev);
  const snap = {
    provider: "codex" as const,
    accountId,
    account: account ?? prev?.account ?? null,
    plan: u.plan ?? prev?.plan ?? null,
    windows: u.windows ?? [],
    credits: u.credits ?? null,
    note: u.note ?? null,
    updatedAt: Date.now(),
  };
  app.store.setUsage(snap);
  app.bus.emit({ t: "usage", usage: snap });
}

/** What each Codex model can hold, from its model catalog (`codex debug models`, the catalog Codex itself works from). */
export async function codexModelContext(bin: string, env: Record<string, string>): Promise<Record<string, ModelContextInfo>> {
  const r = await run([bin, "debug", "models"], { env, timeoutMs: 30_000, cwd: homedir() });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `codex debug models exited ${r.code}`);
  return codexContextFrom(JSON.parse(r.stdout));
}

/**
 * Context sizes from Codex's model catalog. Codex gives a chat `context_window` tokens and lets the conversation
 * fill `effective_context_window_percent` of them (the rest is headroom for its instructions and the reply); it
 * compacts at 90% of the window unless the catalog says sooner, and a chat may be given up to `max_context_window`
 * (a larger `model_context_window` is cut to that).
 */
export function codexContextFrom(catalog: Json): Record<string, ModelContextInfo> {
  const out: Record<string, ModelContextInfo> = {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  for (const m of Array.isArray(catalog?.models) ? catalog.models : []) {
    const slug = typeof m?.slug === "string" ? m.slug : null;
    const window = num(m?.context_window) ?? num(m?.max_context_window);
    if (!slug || !window) continue;
    const pct = num(m.effective_context_window_percent) ?? 95;
    const max = num(m.max_context_window);
    const limit = num(m.auto_compact_token_limit);
    out[slug] = {
      contextWindow: window,
      usableContext: Math.floor((window * Math.min(100, pct)) / 100),
      compactAt: Math.min(limit ?? Infinity, Math.floor((window * 9) / 10)),
      maxContextWindow: max && max > window ? max : null,
    };
  }
  return out;
}

/**
 * Map Codex's `model/list` entries to picker options: its usual list in its own order, then the models it keeps out of
 * its picker (`hidden`, still taken by name), marked to go under More models.
 */
export function codexModelOptions(data: Json): ModelOption[] {
  const rows: Json[] = (Array.isArray(data) ? data : []).filter((m) => m);
  const option = (m: Json): ModelOption => ({
    id: String(m.model ?? m.id),
    label: String(m.displayName ?? m.model ?? m.id),
    description: m.description ? String(m.description) : null,
    efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((o: Json) => String(o.reasoningEffort)) : [],
    fast: fastTier(m),
    defaultEffort: m.defaultReasoningEffort ? String(m.defaultReasoningEffort) : null,
    isDefault: !!m.isDefault,
  });
  return [...rows.filter((m) => !m.hidden).map(option), ...rows.filter((m) => m.hidden).map((m) => ({ ...option(m), more: true }))];
}

export const codexProvider: ProviderModule = {
  id: "codex",
  binNames: ["codex"],
  extraPaths: ["~/.npm-global/bin", "~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  versionArgs: ["--version"],
  // Official npm package, installed under the user's home so no sudo is needed.
  installCommand: [
    "bash",
    "-lc",
    `set -e; if command -v npm >/dev/null 2>&1; then echo "Installing @openai/codex with npm…"; npm install -g --prefix "$HOME/.npm-global" @openai/codex@latest; echo; echo "Installed: $($HOME/.npm-global/bin/codex --version)"; elif command -v brew >/dev/null 2>&1; then brew install --cask codex; else echo "Codex needs Node.js (npm). Install it first, e.g. ${installHint("node", "nodejs npm")}, then try again."; exit 1; fi`,
  ],

  async checkAuth(app, bin) {
    return withServer(app, bin, async (rpc) => {
      const res = await rpc.request<Json>("account/read", { refreshToken: false }, 20_000);
      const acct = res?.account;
      if (!acct) return { signedIn: false, authMethod: null };
      let plan = acct.type === "chatgpt" ? planName(acct.planType) : "API key";
      try {
        const rl = await rpc.request<Json>("account/rateLimits/read", {}, 20_000);
        saveUsage(app, rl.rateLimits, acct.email ?? null);
        plan = planName(rl.rateLimits?.planType) ?? plan;
      } catch (e) {
        log.debug(`rate limits: ${e}`);
      }
      return {
        signedIn: true,
        account: acct.email ?? (acct.type === "apiKey" ? "API key" : null),
        plan,
        authMethod: acct.type === "chatgpt" ? "ChatGPT sign-in" : acct.type === "apiKey" ? "API key" : acct.type,
      };
    });
  },

  async startLogin(app, bin): Promise<LoginFlow> {
    // Fixed now, not read later from async context: the completion arrives from Codex's output stream.
    const accountId = app.providers.currentAccount("codex");
    // A retry replaces the earlier attempt completely: its process, and its expiry timer.
    const previous = loginServers.get(accountId);
    if (previous) {
      clearTimeout(previous.timeout);
      previous.rpc.kill();
    }
    const rpc = await startCodexServer(bin, { env: app.providers.agentEnv("codex", accountId) });
    const attempt: { rpc: StdioRpc; timeout?: ReturnType<typeof setTimeout>; loginId?: string } = { rpc };
    loginServers.set(accountId, attempt);
    const current = () => loginServers.get(accountId) === attempt;
    const finished = () => {
      clearTimeout(attempt.timeout);
      rpc.kill();
      if (current()) loginServers.delete(accountId);
    };
    const res = await rpc.request<Json>("account/login/start", { type: "chatgptDeviceCode" }, 30_000);
    if (res.type !== "chatgptDeviceCode") {
      rpc.kill();
      throw new Error("Codex didn't offer a device code");
    }
    const flow: LoginFlow = {
      kind: "device_code",
      provider: "codex",
      loginId: res.loginId,
      url: res.verificationUrl,
      code: res.userCode,
      expiresAt: Date.now() + 15 * 60_000,
    };
    attempt.loginId = flow.loginId;
    attempt.timeout = setTimeout(() => {
      if (current()) app.bus.emit({ t: "login", provider: "codex", accountId, loginId: flow.loginId, flow: null, done: true, error: "The Codex sign-in code expired. Try again." });
      finished();
    }, Number(process.env.CROSSTALK_CODEX_LOGIN_TTL_MS) || 15 * 60_000); // overridable for tests
    rpc.onNotification((method, p) => {
      if (method !== "account/login/completed") return;
      // A replaced attempt's late news must not override the current one.
      if (!current()) return finished();
      if (p.success) app.bus.emit({ t: "login", provider: "codex", accountId, loginId: flow.loginId, flow: null, done: true });
      else app.bus.emit({ t: "login", provider: "codex", accountId, loginId: flow.loginId, flow: null, done: true, error: p.error ?? "Codex sign-in failed" });
      finished();
      void app.providers.refreshAccount("codex", accountId);
    });
    return flow;
  },

  endLogin: endCodexLogin,

  async logout(app, bin) {
    await withServer(app, bin, (rpc) => rpc.request("account/logout", {}, 20_000));
  },

  async listModels(app, bin) {
    const options = await withServer(app, bin, async (rpc) => {
      const list = async (includeHidden: boolean) => {
        const all: Json[] = [];
        let cursor: string | null = null;
        do {
          const page: Json = await rpc.request("model/list", { ...(includeHidden ? { includeHidden: true } : {}), ...(cursor ? { cursor } : {}) }, 30_000);
          all.push(...(page?.data ?? []));
          cursor = page?.nextCursor ?? null;
        } while (cursor && all.length < 500);
        return all;
      };
      // The models Codex keeps out of its picker too (its own picker has them under "All models"). A Codex that
      // refuses the option still gives its usual list: nothing more, rather than no list.
      const all = await list(true).catch((e) => {
        if (!codexRefused(e)) throw e;
        log.debug(`model/list with hidden models: ${e instanceof Error ? e.message : e}`);
        return list(false);
      });
      return codexModelOptions(all);
    });
    // model/list doesn't say what a model can hold; Codex's model catalog does (after model/list refreshed it).
    const sizes = await codexModelContext(bin, app.providers.agentEnv()).catch((e) => {
      log.debug(`model catalog: ${e instanceof Error ? e.message : e}`);
      return {} as Record<string, ModelContextInfo>;
    });
    return options.map((o) => ({ ...o, ...(sizes[o.id] ?? {}) }));
  },

  async refreshUsage(app, bin) {
    await withServer(app, bin, async (rpc) => {
      const acct = await rpc.request<Json>("account/read", { refreshToken: false }, 20_000).catch(() => null);
      if (!acct?.account) return;
      const rl = await rpc.request<Json>("account/rateLimits/read", {}, 20_000);
      saveUsage(app, rl.rateLimits, acct.account.email ?? null);
    });
  },
};

/** Codex's fast service tier for a model ("priority", shown as "Fast"), if it offers one. */
function fastTier(m: Json): ModelOption["fast"] {
  const tier = Array.isArray(m.serviceTiers) ? m.serviceTiers.find((t: Json) => t?.id === CODEX_FAST_TIER) : null;
  return tier ? { label: String(tier.name ?? "Fast"), description: tier.description ? String(tier.description) : null } : null;
}
