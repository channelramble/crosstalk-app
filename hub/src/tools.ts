import { homedir } from "node:os";
import type { App } from "./app";
import { installHint, run } from "./providers";

/** Supporting tools that aren't agents but make rooms work better (GitHub for cloning private repos). */
export interface GitHubStatus {
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  account: string | null;
  error: string | null;
}

export async function githubStatus(app: App): Promise<GitHubStatus> {
  const env = app.providers.agentEnv();
  const gh = Bun.which("gh", { PATH: env.PATH });
  if (!gh) return { installed: false, version: null, signedIn: false, account: null, error: null };
  const v = await run([gh, "--version"], { env, timeoutMs: 10_000 });
  const s = await run([gh, "auth", "status", "--hostname", "github.com"], { env, timeoutMs: 15_000 });
  const out = s.stdout + s.stderr;
  const account = /account\s+([\w-]+)/i.exec(out)?.[1] ?? /as\s+([\w-]+)/i.exec(out)?.[1] ?? null;
  return {
    installed: true,
    version: v.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null,
    signedIn: s.code === 0,
    account: s.code === 0 ? account : null,
    error: null,
  };
}

/** GitHub's official device flow in a hub terminal; afterwards git uses gh as its credential helper. */
export function githubLogin(app: App) {
  const env = app.providers.agentEnv();
  const gh = Bun.which("gh", { PATH: env.PATH });
  if (!gh) throw new Error(`GitHub CLI (gh) isn't installed on the hub. Install it with your package manager, e.g. ${installHint("gh", "gh")}.`);
  const pty = app.pty.spawn(["bash", "-lc", `"${gh}" auth login --hostname github.com --git-protocol https --web && "${gh}" auth setup-git && echo && echo "GitHub is connected. You can close this window."`], {
    title: "GitHub sign-in",
    purpose: "login",
    env: { ...env, BROWSER: "/bin/false", GH_PROMPT_DISABLED: "" },
    cwd: homedir(),
    cols: 100,
    rows: 24,
  });
  return {
    kind: "terminal" as const,
    ptyId: pty.id,
    command: "gh auth login --web",
    hint: "Copy the one-time code, press Enter here, then open the github.com/login/device link below and enter the code.",
  };
}

export async function githubLogout(app: App) {
  const env = app.providers.agentEnv();
  const gh = Bun.which("gh", { PATH: env.PATH });
  if (gh) await run([gh, "auth", "logout", "--hostname", "github.com"], { env, timeoutMs: 15_000, stdin: "Y\n" });
}
