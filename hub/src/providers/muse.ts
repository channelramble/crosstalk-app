import { homedir } from "node:os";
import type { LoginFlow, ModelOption, ProviderStatus, UsageSnapshot } from "@crosstalk/shared";
import { readSecrets } from "../config";
import { museUsage, startMuse } from "../agents/muse";
import { run, type ProviderModule } from "./index";
import { logger } from "../util/log";

const log = logger("muse-provider");

let helpCache: { bin: string; text: string } | null = null;
/** `muse --help`, kept per binary: which commands this build has (older ones sign in only from the TUI). */
export async function museHelp(bin: string, env: Record<string, string>): Promise<string> {
  if (helpCache?.bin === bin) return helpCache.text;
  const r = await run([bin, "--help"], { env, timeoutMs: 15_000, cwd: homedir() }).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  helpCache = { bin, text: r.stdout + r.stderr };
  return helpCache.text;
}

export const museProvider: ProviderModule = {
  id: "muse",
  binNames: ["muse"],
  extraPaths: ["~/.muse/bin", "~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"],
  versionArgs: ["--version"],
  // Meta's official installer (a bash script: it uses [[ ]] and pipefail, so don't pipe it to sh).
  installCommand: ["bash", "-lc", "set -e; curl -fsSL https://dev.meta.ai/install.sh | bash; echo; echo \"Installed: $(command -v muse >/dev/null && muse --version || $HOME/.local/bin/muse --version)\""],

  async checkAuth(app, bin) {
    const env = app.providers.agentEnv();
    if (readSecrets().META_API_KEY) return { signedIn: true, account: "API key", authMethod: "API key", plan: "Meta API (usage-billed)" };
    // Muse has no sign-in status command (`muse auth` only stores API keys, `muse usage` needs a subscription), so it's
    // asked over MSP: `account/read` first (see museAuth). Both questions are free and send no prompt.
    try {
      const { client, connection } = await startMuse(bin, { cwd: homedir(), env });
      try {
        return await museAuth((method) => connection.request(method, {}));
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (e) {
      log.debug(`auth probe: ${e}`);
      return { signedIn: null };
    }
  },

  async startLogin(app, bin): Promise<LoginFlow> {
    const env = { ...app.providers.agentEnv(), BROWSER: "/bin/false" };
    const help = await museHelp(bin, env);
    // `muse login` signs in with a Meta account by approving a code in the browser; older builds only had /login in the TUI.
    const argv = /^\s+login\b/m.test(help) ? [bin, "login"] : [bin];
    const pty = app.pty.spawn(argv, { title: "Muse Code sign-in", purpose: "login", provider: "muse", env, cwd: homedir(), cols: 100, rows: 28 });
    void app.pty.waitExit(pty.id).then(() => app.providers.refresh("muse"));
    return {
      kind: "terminal",
      provider: "muse",
      ptyId: pty.id,
      command: argv.slice(1).join(" ") || "muse",
      hint:
        argv.length === 1
          ? "Muse Code is open on the hub. If it asks to trust this folder, say yes; then type /login, choose the device code option, and open the link below on any device. Type /exit when you're signed in."
          : "Open the link below on any device, sign in to your Meta account and approve the code. This terminal finishes by itself.",
    };
  },

  async logout(app, bin) {
    const env = app.providers.agentEnv();
    const help = await museHelp(bin, env);
    if (/^\s+logout\b/m.test(help)) await run([bin, "logout"], { env, timeoutMs: 15_000, cwd: homedir() });
    else throw new Error("Sign out from Muse Code itself: open the Terminal, run muse, then /logout.");
  },

  async listModels(app, bin) {
    // Muse's model list (`model/list`) names each model's context limit. A build can ship with no models listed; then
    // Muse picks, and any model name can still be typed.
    const { client, connection } = await startMuse(bin, { cwd: homedir(), env: app.providers.agentEnv() });
    try {
      return museModelOptions(await connection.request("model/list", {}));
    } finally {
      await client.close().catch(() => undefined);
    }
  },

  async refreshUsage(app, bin) {
    const { client, connection } = await startMuse(bin, { cwd: homedir(), env: app.providers.agentEnv() });
    try {
      const r = await connection.request("usage/read", {});
      const u = museUsage((r as { usage?: unknown }).usage);
      if (!u) return;
      const prev = app.store.getUsage("muse");
      const snap: UsageSnapshot = {
        provider: "muse",
        account: app.providers.get("muse").account ?? prev?.account ?? null,
        plan: u.plan ?? prev?.plan ?? null,
        windows: u.windows ?? [],
        credits: null,
        note: null,
        updatedAt: Date.now(),
      };
      app.store.setUsage(snap);
      app.bus.emit({ t: "usage", usage: snap });
    } finally {
      await client.close().catch(() => undefined);
    }
  },
};

/**
 * What to report about Muse's sign-in, from Muse's own answers. `ask` puts one read-only MSP question (tests stand in).
 *
 * `account/read` (AccountState) is the only thing that says plainly which credential is in effect, and it says
 * "loggedOut" when there is none — which is why Muse Code 1.4.14 read as "couldn't be checked" before: it's on MSP's
 * experimental surface (startMuse negotiates `experimentalApi`), and only `usage/read` was asked, which answers `{}`
 * until the host has seen a plan reply, signed in or not. So an empty usage proves nothing either way, while a usage
 * payload still proves a sign-in on a build with no account method.
 */
export async function museAuth(ask: (method: string) => Promise<Record<string, unknown>>): Promise<Partial<ProviderStatus>> {
  const account = await ask("account/read").catch((e) => {
    log.debug(`account/read: ${e}`);
    return null;
  });
  const usage = museUsage(((await ask("usage/read").catch(() => ({}))) as { usage?: unknown }).usage);
  const said = museSignIn(account, usage);
  if (said) return { error: null, ...said };
  if (usage) return { signedIn: true, authMethod: "Meta sign-in", plan: usage.plan ?? null, error: null };
  return { signedIn: null, error: "this Muse build doesn't say whether it's signed in" };
}

/**
 * Muse's `account/read` answer (MSP's AccountState): which credential lane is in effect, with the plan from `usage/read`
 * when Muse has seen one. Null when the lane isn't one this knows — the vocabulary is open, so a newer lane falls back
 * to the usage answer rather than being read as signed out.
 */
export function museSignIn(account: unknown, usage: Partial<UsageSnapshot> | null): Partial<ProviderStatus> | null {
  const a = account && typeof account === "object" && !Array.isArray(account) ? (account as { state?: unknown; label?: unknown; credentialRequired?: unknown }) : null;
  const label = typeof a?.label === "string" && a.label ? a.label.slice(0, 120) : null;
  const plan = usage?.plan ?? null;
  switch (typeof a?.state === "string" ? a.state : null) {
    case "accountLogin":
      return { signedIn: true, authMethod: "Meta sign-in", account: label, plan };
    case "apiKey":
      return { signedIn: true, authMethod: "API key", account: label, plan };
    case "envKey":
      return { signedIn: true, authMethod: "API key", account: label, plan: plan ?? "Meta API (usage-billed)" };
    case "loggedOut":
      // A keyless or gateway deployment needs no credential at all, and mustn't be asked to sign in.
      return a?.credentialRequired === false ? { signedIn: true, authMethod: "No sign-in needed", account: label, plan } : { signedIn: false, account: null, plan: null, authMethod: null };
    default:
      return null;
  }
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Muse's `model/list` rows as picker options. Crosstalk doesn't set Muse's effort, so none are offered. */
export function museModelOptions(r: Json): ModelOption[] {
  return (Array.isArray(r?.models) ? r.models : [])
    .filter((m: Json) => m && typeof m.modelId === "string" && m.modelId)
    .map((m: Json) => ({
      id: m.modelId,
      label: String(m.displayLabel || m.modelId),
      description: typeof m.description === "string" && m.description ? m.description : null,
      efforts: [],
      defaultEffort: null,
      isDefault: m.isDefault === true,
      contextWindow: typeof m.contextLimit === "number" && m.contextLimit > 0 ? m.contextLimit : null,
    }));
}
