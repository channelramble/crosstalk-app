import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoginFlow, ModelOption } from "@crosstalk/shared";
import { run, type ProviderModule } from "./index";

/**
 * Antigravity CLI (`agy`), which replaced Gemini CLI for unpaid and Google One users on June 18, 2026.
 * It keeps its sign-in under $HOME/.gemini/antigravity-cli, so an extra account is a separate HOME folder.
 */

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** The home folder the current account's sign-in lives under. */
function accountHome(app: Parameters<NonNullable<ProviderModule["checkAuth"]>>[0]): string {
  const id = app.providers.currentAccount("antigravity");
  return id === "default" ? homedir() : app.providers.accountDir("antigravity", id);
}

/** The signed-in email, if the CLI saved it in one of its small settings files. */
function findEmail(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > 64 * 1024 || !/\.(json|ya?ml|toml)$/i.test(name)) continue;
      const m = readFileSync(path, "utf8").match(EMAIL);
      if (m) return m[0];
    } catch {
      /* unreadable: skip */
    }
  }
  return null;
}

/**
 * Antigravity model names carry their effort ("gemini-3.8-flash-high"). Checked against agy 1.2.16: `--effort` conflicts
 * with those, is "not supported" for the others (e.g. claude-sonnet-4-6), and only applies to the unnamed default model.
 */
export function agyModelHasEffort(model: string): boolean {
  return /-(minimal|low|medium|high|xhigh|max)$/i.test(model);
}

/**
 * `agy models` prints "slug<TAB>Description" per line (e.g. "gemini-3.8-flash-high\tGemini 3.8 Flash (High)").
 * Lines that aren't a model (like "Fetching available models...") are skipped.
 */
export function parseAgyModels(out: string): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    const slug = line.split(/\s+/)[0] ?? "";
    if (!/^[a-z][a-z0-9.-]*\d[a-z0-9.-]*$/i.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const description = line.slice(slug.length).replace(/^[\s:—-]+/, "") || null;
    models.push({
      id: slug,
      label: description ?? slug,
      description: description ? slug : null,
      // No listed model accepts --effort (see above): the effort is part of choosing the model.
      efforts: [],
      defaultEffort: agyModelHasEffort(slug) ? slug.slice(slug.lastIndexOf("-") + 1).toLowerCase() : null,
      isDefault: /\bdefault\b|\*/i.test(line),
    });
  }
  return models;
}

export const antigravityProvider: ProviderModule = {
  id: "antigravity",
  binNames: ["agy", "antigravity"],
  extraPaths: ["~/.local/bin"],
  versionArgs: ["changelog"], // there's no --version; the changelog starts with "1.2.16:"
  modelHints: parseAgyModels("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)"),
  installCommand: ["bash", "-lc", "set -e; curl -fsSL https://antigravity.google/cli/install.sh | bash; echo; echo \"Installed: $($HOME/.local/bin/agy changelog 2>/dev/null | head -n 1)\""],

  async checkAuth(app, bin) {
    // `agy models` needs a signed-in account and says so otherwise; it never opens a sign-in prompt.
    const r = await run([bin, "models"], { env: app.providers.agentEnv(), timeoutMs: 30_000, cwd: homedir() });
    const out = r.stdout + r.stderr;
    if (/sign in|authenticat/i.test(out) && !parseAgyModels(r.stdout).length) return { signedIn: false };
    if (r.code !== 0) return { signedIn: null, error: out.trim().split("\n").pop()?.slice(0, 200) ?? "Couldn't check Antigravity CLI" };
    const dir = join(accountHome(app), ".gemini", "antigravity-cli");
    const apiKey = /"modelProvider"\s*:\s*"gemini"/.test(existsSync(join(dir, "settings.json")) ? readFileSync(join(dir, "settings.json"), "utf8") : "");
    return { signedIn: true, account: apiKey ? "Gemini API key" : findEmail(dir), authMethod: apiKey ? "API key" : "Google sign-in" };
  },

  async startLogin(app, bin): Promise<LoginFlow> {
    // On a server the CLI prints the Google sign-in link and asks for the code; BROWSER=false stops it trying a browser.
    const pty = app.pty.spawn([bin], {
      title: "Antigravity CLI sign-in",
      purpose: "login",
      provider: "antigravity",
      env: { ...app.providers.agentEnv(), BROWSER: "/bin/false" },
      cwd: homedir(),
      cols: 100,
      rows: 28,
    });
    void app.pty.waitExit(pty.id).then(() => app.providers.refresh("antigravity"));
    return {
      kind: "terminal",
      provider: "antigravity",
      ptyId: pty.id,
      command: "agy",
      hint: "Open the sign-in link, choose your Google account, then paste the code back here. Once it says you're signed in, type /exit (or close this) and Crosstalk checks again.",
    };
  },

  async listModels(app, bin) {
    const r = await run([bin, "models"], { env: app.providers.agentEnv(), timeoutMs: 30_000, cwd: homedir() });
    const models = parseAgyModels(r.stdout);
    if (!models.length) throw new Error((r.stdout + r.stderr).trim().split("\n").pop() || "No models listed");
    return models;
  },
};
