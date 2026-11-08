import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { baseModelId, type LoginFlow, type ModelOption, type UsageSnapshot, type UsageWindow } from "@crosstalk/shared";
import type { App } from "../app";
import { run, type ModelContextInfo, type ProviderModule } from "./index";
import { logger } from "../util/log";
import { endProcess } from "../util/process";
import { RUN_DIR } from "../config";

/**
 * Where Claude Code runs for the hub's own checks (models, context sizes, usage): an empty folder. Started in the home
 * folder it looks through it (Desktop, Documents, other apps' data…), which on a Mac is a row of privacy checks, and
 * dialogs for any the hub hasn't been allowed.
 */
function checkFolder(): string {
  const dir = join(RUN_DIR, "claude-checks");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return homedir();
  }
}

const log = logger("claude-provider");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Asks a prompt-less headless Claude Code things it answers by itself (`initialize`, `get_context_usage` with
 * `detail: "summary"`), one at a time: nothing goes to a model, so it costs nothing. Never `set_model` to a full model
 * name: Claude Code checks one with a real request (see modelContext). `model`: the model it's started on (`--model`;
 * see modelContext for when that costs a request too). `settings`: JSON for `--settings`. It's ended afterwards, or
 * after `timeoutMs`.
 */
export async function withClaudeControl<T>(bin: string, env: Record<string, string>, timeoutMs: number, fn: (ask: (request: Json) => Promise<Json>) => Promise<T>, opts: { model?: string; settings?: string } = {}): Promise<T> {
  // --no-session-persistence: a check isn't a conversation, so it mustn't leave a session in the user's list.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...(opts.model ? ["--model", opts.model] : []), ...(opts.settings ? ["--settings", opts.settings] : [])];
  const proc = Bun.spawn([bin, ...args], { cwd: checkFolder(), env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const waiting = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  let ended = false;
  let seq = 0;
  // Whatever is still waiting fails at once; nothing waits on the process itself (a frozen one can ignore SIGTERM).
  const stop = (why: string) => {
    ended = true;
    for (const w of waiting.values()) w.reject(new Error(why));
    waiting.clear();
  };
  const timer = setTimeout(() => {
    stop("Claude Code took too long to answer");
    void endProcess(proc);
  }, timeoutMs);
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev: Json;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const w = ev.type === "control_response" ? waiting.get(ev.response?.request_id) : undefined;
        if (!w) continue;
        waiting.delete(ev.response.request_id);
        if (ev.response.subtype === "error") w.reject(new Error(String(ev.response.error ?? "Claude Code refused")));
        else w.resolve(ev.response.response ?? {});
      }
    }
  })()
    .catch(() => {})
    .finally(() => stop("Claude Code exited before answering"));
  const ask = (request: Json) =>
    new Promise<Json>((resolve, reject) => {
      if (ended) return reject(new Error("Claude Code exited before answering"));
      const id = `crosstalk_${++seq}`;
      waiting.set(id, { resolve, reject });
      try {
        proc.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
        proc.stdin.flush();
      } catch (e) {
        waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  try {
    return await fn(ask);
  } finally {
    clearTimeout(timer);
    stop("Claude Code was closed");
    // SIGTERM, then SIGKILL if it's still there: the hub must never be left waiting on a stuck CLI.
    void endProcess(proc);
  }
}

/**
 * A stand-in for Anthropic's API on this machine, for the background size checks' Claude Code to be pointed at
 * (ANTHROPIC_BASE_URL): every request gets an error, so nothing a check sends can reach Anthropic or cost anything.
 * `tried` counts the model requests it got. Claude Code started with `--model` on a model that its cached model access
 * (`modelAccessCache` in ~/.claude.json, which an API-key account shares with the plan sign-in) marks as not entitled
 * first checks that model with a real one-token request ("Hi"). When the check fails, it runs another model.
 */
export async function withApiStandIn<T>(fn: (url: string, tried: () => number) => Promise<T>): Promise<T> {
  let tried = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname.startsWith("/v1/messages")) tried++;
      return Response.json({ type: "error", error: { type: "api_error", message: "Crosstalk's model checks don't reach Anthropic" } }, { status: 503 });
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}`, () => tried);
  } finally {
    server.stop(true);
  }
}

/** A model's size from Claude Code's `get_context_usage` answer (what /context shows). */
export function claudeContext(r: Json): ModelContextInfo | null {
  const window = typeof r?.maxTokens === "number" && r.maxTokens > 0 ? r.maxTokens : null;
  if (!window) return null;
  const compact = r.isAutoCompactEnabled !== false && typeof r.autoCompactThreshold === "number" && r.autoCompactThreshold > 0 ? r.autoCompactThreshold : null;
  return { contextWindow: window, compactAt: compact };
}

const SUBSCRIPTIONS: Record<string, string> = {
  pro: "Claude Pro",
  max: "Claude Max",
  max5: "Claude Max 5×",
  max20: "Claude Max 20×",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
  free: "Claude Free",
};

/**
 * Parse the text Claude Code prints for `/usage`. The wording isn't a stable API, so this is lenient:
 * it looks for "<label> … NN% used … Resets <when>" groups and falls back to showing the raw text.
 */
export function parseClaudeUsage(text: string, now = new Date()): UsageWindow[] {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").replace(/[█▌▏▎▍▋▊▉░▒▓]+/g, " ");
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: UsageWindow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i.exec(lines[i]);
    if (!m) continue;
    // Label: this line before the percentage, or the nearest previous line without a percentage.
    let label = lines[i].slice(0, m.index).replace(/[:·•|-]+\s*$/, "").trim();
    for (let k = i - 1; !label && k >= 0 && k >= i - 3; k--) if (!/%/.test(lines[k])) label = lines[k];
    label = prettyLabel(label || "Limit");
    let resetsAt: number | null = null;
    for (let k = i; k <= i + 2 && k < lines.length; k++) {
      const r = /resets?\s+(.+)$/i.exec(lines[k]);
      if (r) {
        resetsAt = parseResetTime(r[1], now);
        break;
      }
    }
    out.push({ label, usedPercent: Number(m[1]), resetsAt });
  }
  return out;
}

function prettyLabel(s: string): string {
  const l = s.toLowerCase();
  if (/session|5.?h/.test(l)) return "5-hour";
  if (/week/.test(l)) {
    // "Current week (all models)" is the overall limit; "Current week (Fable)" etc. are per-model ones.
    const scope = /\(([^)]+)\)/.exec(s)?.[1]?.trim();
    return scope && !/^all\b/i.test(scope) ? `Weekly (${scope})` : "Weekly";
  }
  if (/extra|overage/.test(l)) return "Extra usage";
  return s.replace(/^current\s+/i, "").slice(0, 40);
}

/** "3:59pm (America/New_York)", "Oct 7, 9am", "in 2h 13m" → epoch ms (best effort). */
export function parseResetTime(s: string, now = new Date()): number | null {
  const t = s.replace(/\(.*?\)/g, "").trim();
  const rel = /in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(t);
  if (rel && (rel[1] || rel[2] || rel[3])) return now.getTime() + ((+rel[1] || 0) * 86400 + (+rel[2] || 0) * 3600 + (+rel[3] || 0) * 60) * 1000;
  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(t);
  const date = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i.exec(t);
  if (!time && !date) return null;
  const d = new Date(now);
  if (date) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    d.setMonth(months.indexOf(date[1].toLowerCase().slice(0, 3)), Number(date[2]));
    if (d.getTime() < now.getTime() - 86400_000) d.setFullYear(d.getFullYear() + 1);
  }
  if (time) {
    let h = Number(time[1]) % 12;
    if (time[3].toLowerCase() === "pm") h += 12;
    d.setHours(h, Number(time[2] ?? 0), 0, 0);
    if (!date && d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
  } else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Map the model list from Claude Code's `initialize` control response to picker options. Its "default" entry
 * isn't a model of its own: it marks the account's recommended model, so flag the first entry that resolves
 * to the same one.
 */
const CLAUDE_FAST = { label: "Fast mode", description: "Faster output from the same model, at a higher price (from your plan's extra usage, or the API key)." };

export function claudeModelOptions(models: Json): ModelOption[] {
  const list: Json[] = Array.isArray(models) ? models.filter((m) => m?.value) : [];
  const def = list.find((m) => m.value === "default");
  let marked = false;
  const out: ModelOption[] = list
    .filter((m) => m !== def)
    .map((m) => {
      const isDefault = !marked && !!def?.resolvedModel && m.resolvedModel === def.resolvedModel;
      if (isDefault) marked = true;
      return {
        id: String(m.value),
        ...(m.resolvedModel ? { resolvedModel: String(m.resolvedModel) } : {}),
        label: String(m.displayName ?? m.value),
        description: m.description ? String(m.description) : null,
        efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [],
        defaultEffort: null,
        fast: m.supportsFastMode ? CLAUDE_FAST : null,
        isDefault,
      };
    });
  if (def && !marked) {
    out.unshift({
      id: "default",
      ...(def.resolvedModel ? { resolvedModel: String(def.resolvedModel) } : {}),
      label: String(def.description ?? "Default").split(" · ")[0],
      description: def.description ? String(def.description) : null,
      efforts: def.supportsEffort && Array.isArray(def.supportedEffortLevels) ? def.supportedEffortLevels.map(String) : [],
      defaultEffort: null,
      fast: def.supportsFastMode ? CLAUDE_FAST : null,
      isDefault: true,
    });
  }
  return out;
}

/** A model name Claude Code can be started on (`--model <name>`): never one that reads as another option. */
const MODEL_ARG = /^[A-Za-z0-9][\w.:@/[\]-]{0,199}$/;

/** A model an API key can use, as Anthropic's Models API lists it. */
export interface AnthropicModel {
  id: string;
  label: string;
  efforts: string[];
}

/** Where Anthropic's API is: CROSSTALK_ANTHROPIC_API_URL replaces it (tests point it at a stand-in, or at a closed port). */
const anthropicApi = () => (process.env.CROSSTALK_ANTHROPIC_API_URL || "https://api.anthropic.com").replace(/\/+$/, "");

/**
 * The effort levels a model takes, from its Models API capabilities (`effort: {supported, low: {supported}, …}`), in the
 * order the API gives them; none when it takes no effort setting.
 */
export function anthropicEfforts(capabilities: Json): string[] {
  const e = capabilities?.effort;
  if (!e || typeof e !== "object" || e.supported !== true) return [];
  return Object.entries(e)
    .filter(([level, v]) => level !== "supported" && /^[a-z][a-z0-9_-]{0,23}$/.test(level) && (v as Json)?.supported === true)
    .map(([level]) => level);
}

/**
 * The models an API key can use, from Anthropic's Models API: `GET /v1/models` runs no model and costs nothing. The key
 * goes only there, in its header (never along a redirect), and is never logged or shown. None for a key Anthropic
 * refuses (401, 403). Null when the list can't be had this time (no connection, a timeout, a busy or failing API).
 */
export async function anthropicModels(key: string, workspaceId: string | null, timeoutMs = 10_000): Promise<AnthropicModel[] | null> {
  const headers: Record<string, string> = { "x-api-key": key, "anthropic-version": "2023-06-01", accept: "application/json", ...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}) };
  const signal = AbortSignal.timeout(timeoutMs);
  const out: AnthropicModel[] = [];
  let after: string | null = null;
  try {
    // One page holds them all (up to 1000); a few more are followed if the API ever says there are more.
    for (let page = 0; page < 5; page++) {
      const res = await fetch(`${anthropicApi()}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, { headers, signal, redirect: "error" });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        log.debug(`Anthropic's model list: ${res.status}`);
        return res.status === 401 || res.status === 403 ? [] : null;
      }
      const j: Json = await res.json();
      if (!Array.isArray(j?.data)) return null;
      for (const m of j.data) {
        const id = typeof m?.id === "string" ? m.id.trim() : "";
        if (!MODEL_ARG.test(id) || out.some((x) => x.id === id)) continue;
        const name = typeof m.display_name === "string" ? m.display_name.trim().slice(0, 80) : "";
        out.push({ id, label: name || id, efforts: anthropicEfforts(m.capabilities) });
      }
      if (j.has_more !== true || typeof j.last_id !== "string" || !j.last_id) break;
      after = j.last_id;
    }
  } catch (e) {
    // Only what went wrong: the request (and its key) stays out of the log.
    log.debug(`Anthropic's model list: ${e instanceof Error ? e.name : "failed"}`);
    return null;
  }
  return out;
}

/**
 * Under More models: what an API key can use that Claude Code's own list doesn't name. A model counts as named by any of
 * its names ("haiku" names claude-haiku-4-5-20251001, "sonnet[1m]" its model), and one Claude Code lists as not for this
 * account (`unavailable_models`) is left out: it wouldn't run there. In the order Anthropic lists them (newest first).
 */
export function claudeMoreModels(api: AnthropicModel[], usual: ModelOption[], unavailable?: Json): ModelOption[] {
  const named = new Set<string>();
  for (const m of usual) for (const id of [m.id, m.resolvedModel]) if (id) named.add(baseModelId(id));
  for (const m of Array.isArray(unavailable) ? unavailable : []) for (const id of [m?.value, m?.resolvedModel]) if (typeof id === "string" && id) named.add(baseModelId(id));
  const out: ModelOption[] = [];
  for (const m of api) {
    const base = baseModelId(m.id);
    if (named.has(base)) continue;
    named.add(base);
    out.push({ id: m.id, label: m.label, description: null, efforts: m.efforts, defaultEffort: null, isDefault: false, fast: null, more: true });
  }
  return out;
}

export const claudeProvider: ProviderModule = {
  id: "claude",
  binNames: ["claude"],
  extraPaths: ["~/.local/bin", "~/.claude/local", "~/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  versionArgs: ["--version"],
  // Anthropic's official native installer.
  installCommand: ["bash", "-lc", "set -e; curl -fsSL https://claude.ai/install.sh | bash; echo; echo \"Installed: $($HOME/.local/bin/claude --version 2>/dev/null || claude --version)\""],

  async checkAuth(app, bin) {
    const r = await run([bin, "auth", "status"], { env: app.providers.agentEnv(), timeoutMs: 20_000, cwd: homedir() });
    let s: Json = null;
    try {
      s = JSON.parse(r.stdout.trim());
    } catch {
      // older versions print text
    }
    if (!s) {
      const signedIn = /logged in|signed in/i.test(r.stdout) && !/not logged in/i.test(r.stdout);
      return { signedIn, authMethod: null };
    }
    if (!s.loggedIn) return { signedIn: false, authMethod: null };
    const sub = String(s.subscriptionType ?? s.subscription ?? "").toLowerCase();
    const method = s.authMethod === "claude.ai" || s.authMethod === "oauth" || s.authMethod === "claudeai" ? "Claude subscription" : s.authMethod === "api_key" || s.authMethod === "apiKey" ? "API key" : s.authMethod ?? null;
    return {
      signedIn: true,
      account: s.email ?? s.account?.email ?? s.orgName ?? null,
      plan: SUBSCRIPTIONS[sub] ?? (sub ? `Claude ${sub}` : method === "API key" ? "API usage billing" : null),
      authMethod: method,
    };
  },

  async startLogin(app, bin): Promise<LoginFlow> {
    // Anthropic's own sign-in flow, in a real terminal: the user opens the URL, signs in on claude.ai,
    // and pastes the code back into Claude Code. The hub only relays keystrokes. The terminal doesn't echo them: Claude
    // Code reads the code without a terminal of its own, so an echo would put the pasted code on the screen every device
    // gets, and in the terminal's scrollback. (The phone's sheet, signin.ts, signs it in without any device's terminal.)
    const pty = app.pty.spawn(["/bin/sh", "-c", 'stty -echo 2>/dev/null; exec "$0" "$@"', bin, "auth", "login", "--claudeai"], {
      title: "Claude Code sign-in",
      command: `${bin} auth login --claudeai`,
      purpose: "login",
      provider: "claude",
      env: { ...app.providers.agentEnv(), BROWSER: "/bin/false" },
      cwd: homedir(),
      cols: 100,
      rows: 26,
    });
    void app.pty.waitExit(pty.id).then(() => app.providers.refresh("claude"));
    return {
      kind: "terminal",
      provider: "claude",
      ptyId: pty.id,
      command: "claude auth login --claudeai",
      hint: "Open the sign-in link below, sign in with the Claude account that has your plan, then paste the code it shows into this terminal and press Enter.",
    };
  },

  async logout(app, bin) {
    await run([bin, "auth", "logout"], { env: app.providers.agentEnv(), timeoutMs: 20_000, cwd: homedir() });
  },

  async listModels(app, bin) {
    // The list Claude Code's own /model picker shows, from the headless `initialize` control request (no prompt is sent,
    // so it costs nothing). Its picker has nothing more: other and older models it takes only by full name ("For
    // other/previous model names, specify with --model"), and its `unavailable_models` can't be picked. So a plan
    // sign-in gets that list alone, and Crosstalk never guesses names. An API-key account also gets, under More models,
    // the models Anthropic's Models API says its key can use that the list doesn't name.
    const init = await withClaudeControl(bin, app.providers.agentEnv(), 30_000, (ask) => ask({ subtype: "initialize" }));
    const usual = claudeModelOptions(init?.models);
    const account = app.providers.currentAccount("claude");
    const access = app.providers.apiKeyFor("claude", account);
    if (!access) return usual;
    // When the key's list can't be had this time (no connection yet after a restart, say), the one it gave last stands
    // (kept without the key), so its models don't go missing meanwhile.
    const api = app.providers.lastLookup<AnthropicModel[]>("claude", account, await anthropicModels(access.key, access.workspaceId)) ?? [];
    return [...usual, ...claudeMoreModels(api, usual, init?.unavailable_models)];
  },

  async modelContext(app, bin, models) {
    // Each model's context window and where Claude Code compacts, as its /context counts them: a prompt-less Claude Code
    // started on the model (`--model`) is asked for a summary, worked out locally. Never `set_model`: switched to a full
    // model name (claude-sonnet-4-6, claude-fable-5-1[1m]), Claude Code first checks it with a real request
    // (max_tokens 1, "Hi"), billed to an API key or counted against the plan; only aliases and "default" it switches to
    // without one. Started with --model it sends that check too, for a model its cached model access marks as not
    // entitled (an API key's More model the plan can't use, say). So each check talks to a stand-in for Anthropic's API
    // (withApiStandIn), and nothing can reach Anthropic. Its address goes in --settings too: the user's own settings'
    // `env` (a proxy) would win over the environment.
    return withApiStandIn(async (url, tried) => {
      const env = { ...app.providers.agentEnv(), ANTHROPIC_BASE_URL: url };
      const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } });
      const out: Record<string, ModelContextInfo> = {};
      const byModel = new Map<string, ModelContextInfo>();
      const until = Date.now() + 180_000;
      for (const m of models) {
        if (Date.now() > until) break;
        if (!MODEL_ARG.test(m.id)) continue;
        const same = m.resolvedModel ? byModel.get(m.resolvedModel) : undefined;
        if (same) {
          out[m.id] = same;
          continue;
        }
        const triedBefore = tried();
        try {
          const r = await withClaudeControl(
            bin,
            env,
            30_000,
            async (ask) => {
              await ask({ subtype: "initialize" });
              // "summary": the window and compaction point from local estimates. The default "full" breakdown counts
              // every part of the prompt with Anthropic's token-counting API, which a size doesn't need.
              return ask({ subtype: "get_context_usage", detail: "summary" });
            },
            { model: m.id, settings },
          );
          const ran = typeof r?.model === "string" ? r.model : null;
          const expected = m.resolvedModel ?? (m.more ? m.id : null);
          if (ran && expected && baseModelId(ran) !== baseModelId(expected)) {
            // It ran another model: not this one's size. A More model it put another in place of without checking
            // first is one the user's or an organization's settings keep off this machine (availableModels,
            // deniedModels), so it's left out of the list (runsAs). One it tried to check with Anthropic may still
            // run in a chat (whose own start sends that check): unsized, and still listed.
            if (m.more) out[m.id] = tried() > triedBefore ? { contextWindow: null } : { contextWindow: null, runsAs: ran };
            continue;
          }
          const info = claudeContext(r);
          if (!info) continue;
          out[m.id] = info;
          // Helpers name the model itself (claude-sonnet-4-6), not the alias they were picked by.
          for (const full of [m.resolvedModel, ran]) {
            if (!full) continue;
            byModel.set(full, info);
            out[full] ??= info;
          }
        } catch (e) {
          log.debug(`context of ${m.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
      return out;
    });
  },

  async refreshUsage(app, bin) {
    // `/usage` is a local command: it reads plan usage without a model call. --no-session-persistence: a check
    // isn't a conversation, so it mustn't leave a session behind in the user's session list.
    const r = await run([bin, "-p", "/usage", "--output-format", "json", "--no-session-persistence"], { env: app.providers.agentEnv(), timeoutMs: 45_000, cwd: checkFolder() });
    let text = r.stdout;
    try {
      const j = JSON.parse(r.stdout);
      text = String(j.result ?? "");
      if (j.is_error) throw new Error(text);
    } catch (e) {
      if (e instanceof Error && !/JSON/.test(e.message)) throw e;
    }
    if (!text.trim()) return;
    const windows = parseClaudeUsage(text);
    const accountId = app.providers.currentAccount("claude");
    const prev = app.store.getUsage("claude", accountId);
    const st = app.providers.get("claude");
    const snap: UsageSnapshot = {
      provider: "claude",
      accountId,
      account: st.account ?? prev?.account ?? null,
      plan: st.plan ?? prev?.plan ?? null,
      windows: windows.length ? windows : prev?.windows ?? [],
      credits: prev?.credits ?? null,
      note: windows.length ? null : text.trim().slice(0, 600),
      updatedAt: Date.now(),
    };
    app.store.setUsage(snap);
    app.bus.emit({ t: "usage", usage: snap });
    log.debug(`usage: ${windows.map((w) => `${w.label} ${w.usedPercent}%`).join(", ")}`);
  },
};
