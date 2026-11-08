// `crosstalk-hub browseros`: what the setup checklist's fix lines run. Checking needs no hub, so this works from a
// terminal, from an agent's shell and while the hub is stopped. Everything it decides lives in browseros.ts; this file
// only turns that into words and an exit code.
//
// Nothing here is done quietly: `install` says which build it picked and why, prints the SHA-256 it checked and the
// signature it found, and refuses — with the reason — when either doesn't hold up. A copy that is running is left
// alone unless `--replace-running` says otherwise, because replacing it closes whatever the person has open in it.
// That flag is only ever typed by the person: no suggested command, in the checklist or on the phone, carries it.

import { addCommand, browserOsFacts, buildTarget, installBuild, linuxWays, namesBrowser, newerVersion, removeCommand, sameMcpUrl, type Build, type BrowserOsFacts, type McpAgent } from "./browseros";

const AGENT_NAMES: Record<McpAgent, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

/** The agent CLIs on this machine's PATH. Without a hub to ask, this is what "installed here" can honestly mean. */
export function agentsOnPath(which: (name: string) => string | null = (n) => Bun.which(n)): McpAgent[] {
  return (["claude", "codex", "gemini"] as McpAgent[]).filter((a) => !!which(a));
}

/** What the words say about the facts, one line each. Pure, so the wording is tested without touching a machine. */
export function describe(f: BrowserOsFacts): string[] {
  const out: string[] = [];
  if (!f.target.wants.length) return [f.target.blocked ?? "BrowserOS neo has no build for this machine."];
  out.push(f.installed ? `Installed: ${f.installed.version ?? "an unknown version"} at ${f.installed.path}${f.installed.running ? " (open now)" : ""}` : "Installed: no");
  if (f.releases.ok) out.push(f.newest ? `Newest build for this machine: ${f.newest.version} — ${f.newest.asset.name} from ${f.newest.tag}` : "Newest build for this machine: none of the releases has one");
  else out.push(`Couldn't ask GitHub: ${f.releases.detail}${f.releases.retryAt ? ` It comes back at ${new Date(f.releases.retryAt).toLocaleTimeString()}.` : ""}`);
  if (f.installed && f.newest && newerVersion(f.installed.version, f.newest.version)) out.push(`An update is there: ${f.newest.version}. It's yours to take — run "browseros install" when you want it.`);
  out.push(f.mcp ? `Serves agents at ${f.mcp.url} (${f.mcp.serverName ?? "unnamed"} ${f.mcp.serverVersion ?? ""})`.trim() : "Serves agents at: not found — open BrowserOS neo once, it writes its ports down then");
  if (f.mcp) {
    const url = f.mcp.url;
    for (const agent of f.agents) {
      // An agent can hold more than one entry for it. One that reaches the browser is the answer; else the one named
      // after it. Addresses are compared as addresses: `http://localhost:9010/mcp` reaches it and is connected.
      const mine = f.links.filter((l) => l.agent === agent);
      const link = mine.find((l) => sameMcpUrl(l.url, url)) ?? mine.find((l) => namesBrowser(l.name)) ?? mine[0] ?? null;
      if (link && sameMcpUrl(link.url, url)) out.push(`${AGENT_NAMES[agent]}: connected`);
      // The remove names the entry that is really there, and `;` keeps the add running even when it found nothing.
      else if (link) out.push(`${AGENT_NAMES[agent]}: points at ${link.url}, which isn't where it answers — ${removeCommand(agent, link.name)}; ${addCommand(agent, url)}`);
      else out.push(`${AGENT_NAMES[agent]}: not added — ${addCommand(agent, url)}`);
    }
    if (f.agents.length) out.push("An agent reads its MCP servers when it starts, so start it again after adding one.");
  }
  return out;
}

/** The build to install, and why there is none. */
export function chooseToInstall(f: BrowserOsFacts): { build: Build } | { problem: string } {
  if (!f.target.wants.length) return { problem: f.target.blocked ?? "BrowserOS neo has no build for this machine." };
  if (!f.releases.ok) return { problem: `Couldn't ask GitHub for the releases: ${f.releases.detail}${f.releases.retryAt ? ` It comes back at ${new Date(f.releases.retryAt).toLocaleTimeString()}.` : ""}` };
  if (!f.newest) return { problem: "None of BrowserOS neo's releases has a build for this machine." };
  if (f.installed && !newerVersion(f.installed.version, f.newest.version)) return { problem: `BrowserOS neo ${f.installed.version ?? ""} is already the newest build for this machine (${f.newest.version}). Nothing to do.`.replace(/\s+/g, " ") };
  return { build: f.newest };
}

export interface CliDeps {
  say?: (line: string) => void;
  facts?: (agents: McpAgent[]) => Promise<BrowserOsFacts>;
  install?: typeof installBuild;
  agents?: () => McpAgent[];
}

/** `crosstalk-hub browseros [check|install] [--replace-running] [--into <dir>]`. 0 when it did what was asked. */
export async function runBrowserOsCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const say = deps.say ?? ((l: string) => console.log(l));
  const agents = (deps.agents ?? agentsOnPath)();
  const read = deps.facts ?? ((a: McpAgent[]) => browserOsFacts(a));
  const install = deps.install ?? installBuild;
  const [what = "check", ...rest] = argv;
  if (what === "--help" || what === "-h" || (what !== "check" && what !== "install")) {
    say(`crosstalk-hub browseros [check|install]

  check                 what's installed, what's newest for this machine, and which agents can reach it
  install               download the newest build for this machine, check its SHA-256 (and on a Mac its
                        signature and notarisation), then install it
    --replace-running   replace a copy that is open. It closes; whatever is in it is lost. Your profile stays.
    --into <folder>     where it goes (default /Applications on a Mac)`);
    return what === "--help" || what === "-h" ? 0 : 1;
  }
  const f = await read(agents);
  if (what === "check") {
    for (const line of describe(f)) say(line);
    return 0;
  }
  const choice = chooseToInstall(f);
  if ("problem" in choice) {
    say(choice.problem);
    return 1;
  }
  const build = choice.build;
  const into = rest.includes("--into") ? rest[rest.indexOf("--into") + 1] : undefined;
  const replaceRunning = rest.includes("--replace-running");
  const size = build.asset.size ? ` (${Math.round(build.asset.size / 1_000_000)} MB)` : "";
  // The tag is said beside the version on purpose: they differ, and that is the thing people get wrong here.
  say(`Picked ${build.asset.name}${size} — version ${build.version}, from the release tagged ${build.tag}.`);
  if (build.note) say(build.note);
  say(`Checking it against the SHA-256 GitHub reports: ${build.asset.sha256 ?? "none — it won't be installed"}`);
  const done = await install(build, {}, { ...(into ? { into } : {}), replaceRunning });
  if (done.done === "installed") {
    say(`Installed ${build.version} at ${done.path}.${done.replaced ? " It replaced the copy that was there; your profile, sign-ins and tabs are untouched." : ""}`);
    say("Open it once, then add it to your agent with the command from `crosstalk-hub browseros check`.");
    return 0;
  }
  if (done.done === "ready") {
    say(done.detail);
    say(done.command);
    return 0;
  }
  say(done.detail);
  // The one case with a way forward the person has to ask for by name. Nothing ever adds this flag for them.
  if (done.why === "running") say("To replace it anyway, run the same command with --replace-running. It closes the browser and whatever is in it; your profile stays.");
  return 1;
}

/** What this machine can install, for anyone who wants it without reading a release list. */
export const thisMachine = async () => buildTarget(process.platform, process.arch, await linuxWays());
