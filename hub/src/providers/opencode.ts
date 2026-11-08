// OpenCode (opencode.ai, github.com/anomalyco/opencode) as a provider: an open-source coding agent program. Crosstalk drives
// it over the Agent Client Protocol (agents/opencode.ts) and it runs a chat on an AI service account, so it has nothing to
// sign in to; its accounts are the services it runs on, added in Settings → AI services.
//
// The version is pinned: OpenCode 2 ships breaking changes in point releases, Crosstalk's driver was checked against this
// one (its config, tools, permission rules and ACP updates, hub/test/opencode-real.test.ts), and it moves when that check has
// been run against a newer one. OpenCode 1 (npm opencode-ai) installs the same `opencode` command with another config and
// other tool names, so a version 1 found on this machine is said to be the wrong one, unless Crosstalk's own copy is there:
// that one is looked for first (`ownBin`), and the person's other copy stays for their terminal.
import { OPENCODE_VERSION } from "@crosstalk/shared";
import { run, type ProviderModule } from "./index";

export { OPENCODE_VERSION };

/**
 * The official npm package at that version, into the folder Crosstalk's agents install to (not the system's). A version 1
 * there owns the same command, and npm refuses to overwrite it, so it goes first (`;`, so that under the installer's
 * `set -e` an uninstall that fails stops it). npm 12 skips the package's postinstall, which fetches the program, unless told.
 */
export const OPENCODE_INSTALL_LINE = `npm uninstall -g --prefix "$HOME/.npm-global" opencode-ai; npm install -g --prefix "$HOME/.npm-global" --allow-scripts=@opencode/cli @opencode/cli@${OPENCODE_VERSION}`;

/** Why the program at `bin` can't run these chats, in the words the app shows, or null. 1.x has another config and other tools. */
export async function openCodeWrongVersion(bin: string, env: Record<string, string>): Promise<string | null> {
  const r = await run([bin, "--version"], { env, timeoutMs: 20_000 }).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  const version = `${r.stdout}${r.stderr}`.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
  return version && !/^2\./.test(version) ? `OpenCode ${version} is installed, and Crosstalk needs version 2. Press Install to get it.` : null;
}

export const opencodeProvider: ProviderModule = {
  id: "opencode",
  binNames: ["opencode"],
  extraPaths: ["~/.npm-global/bin", "~/.opencode/bin", "~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  ownBin: "~/.npm-global/bin/opencode",
  versionArgs: ["--version"],
  installCommand: [
    "bash",
    "-lc",
    `set -e; if ! command -v npm >/dev/null 2>&1; then echo "OpenCode needs Node.js (npm). Install it first."; exit 1; fi; ${OPENCODE_INSTALL_LINE}; echo; echo "Installed: $($HOME/.npm-global/bin/opencode --version)"`,
  ],

  // Nothing to sign in to. All that can be wrong is the version.
  async checkAuth(app, bin) {
    const error = await openCodeWrongVersion(bin, app.providers.agentEnv());
    return error ? { signedIn: null, error } : { signedIn: true, authMethod: "AI service" };
  },
};
