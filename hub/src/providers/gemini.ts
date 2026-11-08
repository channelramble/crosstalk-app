import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoginFlow, ModelOption } from "@crosstalk/shared";
import { HOME, readSecrets } from "../config";
import { StdioRpc } from "../agents/jsonrpc";
import { installHint, run, type ProviderModule } from "./index";

let acpFlag: { bin: string; flag: string } | null = null;

/** Gemini CLI renamed its ACP flag over time; detect which one this install understands. */
export async function geminiAcpFlag(bin: string, env: Record<string, string>): Promise<string> {
  if (acpFlag?.bin === bin) return acpFlag.flag;
  const r = await run([bin, "--help"], { env, timeoutMs: 20_000, cwd: homedir() }).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  const help = r.stdout + r.stderr;
  const flag = /--acp\b/.test(help) ? "--acp" : "--experimental-acp";
  acpFlag = { bin, flag };
  return flag;
}

export const geminiProvider: ProviderModule = {
  id: "gemini",
  binNames: ["gemini"],
  extraPaths: ["~/.npm-global/bin", "~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  versionArgs: ["--version"],
  // When Gemini CLI can't be asked (not signed in, say): suggestions, and any name can be typed instead.
  modelHints: ["gemini-3-pro", "gemini-3-flash"].map((id) => ({ id, label: id, description: null, efforts: [], defaultEffort: null, isDefault: false })),
  installCommand: [
    "bash",
    "-lc",
    `set -e; if ! command -v npm >/dev/null 2>&1; then echo "Gemini CLI needs Node.js (npm). Install it first, e.g. ${installHint("node", "nodejs npm")}"; exit 1; fi; npm install -g --prefix "$HOME/.npm-global" @google/gemini-cli@latest; echo; echo "Installed: $($HOME/.npm-global/bin/gemini --version)"`,
  ],

  async checkAuth(app) {
    // The saved API key belongs to the main account; extra accounts each sign in with their own Google account.
    if (app.providers.currentAccount("gemini") === "default" && (readSecrets().GEMINI_API_KEY || process.env.GEMINI_API_KEY)) return { signedIn: true, account: "API key", authMethod: "API key", plan: "Gemini API" };
    // GEMINI_CLI_HOME stands in for the home folder, so an extra account's sign-in is in <its folder>/.gemini.
    const acctId = app.providers.currentAccount("gemini");
    const dir = join(acctId === "default" ? homedir() : app.providers.accountDir("gemini", acctId), ".gemini");
    const creds = join(dir, "oauth_creds.json");
    if (!existsSync(creds)) return { signedIn: false };
    let account: string | null = null;
    try {
      const accts = JSON.parse(readFileSync(join(dir, "google_accounts.json"), "utf8"));
      account = accts.active ?? null;
    } catch {
      // optional file
    }
    return { signedIn: true, account, authMethod: "Google sign-in" };
  },

  async listModels(app, bin) {
    // Gemini CLI says which models it offers when an ACP session opens; no prompt is sent. The session opens in a
    // folder of the hub's own, so no project's settings or history are touched.
    const env = app.providers.agentEnv();
    const dir = join(HOME, "run", "gemini-models");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rpc = new StdioRpc([bin, await geminiAcpFlag(bin, env)], { cwd: dir, env, name: "Gemini CLI" });
    try {
      await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "crosstalk", title: "Crosstalk", version: "0.1.0" } }, 30_000);
      const models = geminiModelOptions((await rpc.request("session/new", { cwd: dir, mcpServers: [] }, 30_000))?.models);
      if (!models.length) throw new Error("Gemini CLI listed no models");
      return models;
    } finally {
      await rpc.kill();
    }
  },

  async startLogin(app, bin): Promise<LoginFlow> {
    // NO_BROWSER makes Gemini CLI print the Google sign-in link and ask for the code instead of opening a browser.
    const pty = app.pty.spawn([bin], {
      title: "Gemini CLI sign-in",
      purpose: "login",
      provider: "gemini",
      env: { ...app.providers.agentEnv(), NO_BROWSER: "true" },
      cwd: homedir(),
      cols: 100,
      rows: 28,
    });
    void app.pty.waitExit(pty.id).then(() => app.providers.refresh("gemini"));
    return {
      kind: "terminal",
      provider: "gemini",
      ptyId: pty.id,
      command: "gemini",
      hint: "Choose “Login with Google”, open the link below, sign in, and paste the code back here. When Gemini says you're signed in, type /quit.",
    };
  },
};

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The models an ACP session reports (`models.availableModels`), as picker options; the current one is the default. */
export function geminiModelOptions(state: Json): ModelOption[] {
  const list: Json[] = Array.isArray(state?.availableModels) ? state.availableModels : [];
  return list
    .filter((m) => m && typeof m.modelId === "string" && m.modelId)
    .map((m) => ({
      id: m.modelId,
      label: String(m.name || m.modelId),
      description: typeof m.description === "string" && m.description ? m.description : null,
      efforts: [],
      defaultEffort: null,
      isDefault: m.modelId === state.currentModelId,
    }));
}
