// What's left to set up on this machine, worked out from what the hub already checks (setup/index.ts gathers it; the
// CLI gathers a little itself when it can't reach the hub). Pure: the same facts give the same checklist, so each
// item's state is tested from fakes. Only listed fields ever reach the output, never whole objects: the facts hold
// account emails and server addresses that the checklist must not repeat.

import { CHAT_PROVIDERS, PROVIDER_INFO, isServiceOnlyAgent, type AgentAccount, type BrowserOsConnect, type MacStatus, type MachineInfo, type PoolState, type Provider, type ProviderStatus, type SetupChecklist, type SetupFix, type SetupGroup, type SetupItem, type SetupState } from "@crosstalk/shared";
import { OPENCODE_INSTALL_LINE } from "../providers/opencode";
import { MAC_PANES, macFixCommand } from "../mac";
import { MCP_SERVER_NAME, RESTART_NOTE, addCommand, namesBrowser, newerVersion, removeCommand as mcpRemoveCommand, sameMcpUrl, type BrowserOsFacts, type McpAgent } from "../browseros";

/** What to tell an agent once its setup tools are added. */
export const SETUP_PROMPT = "Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password.";

/** Every item id the checklist can have, in its order (docs/SETUP-FOR-AGENTS.md has a section for each). */
export const SETUP_ITEM_IDS = ["service", "version", "tailscale", "https", "public-url", "devices", "push", "agent.claude", "agent.codex", "agent.gemini", "agent.antigravity", "agent.muse", "agent.opencode", "browseros", "services", "mac.autologin", "mac.power", "mac.full-disk", "mac.updates", "mac.dialogs", "machines", "pool"];

/** The agents the checklist knows, in its order. Gemini, Antigravity, Muse and OpenCode show only once installed. */
export const SETUP_AGENTS: Provider[] = ["claude", "codex", "gemini", "antigravity", "muse", "opencode"];

/** Each agent's official install, as one line a person or agent can run (each is part of its provider's installCommand). */
export const INSTALL_LINES: Record<string, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: 'npm install -g --prefix "$HOME/.npm-global" @openai/codex@latest',
  gemini: 'npm install -g --prefix "$HOME/.npm-global" @google/gemini-cli@latest',
  antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  muse: "curl -fsSL https://dev.meta.ai/install.sh | bash",
  opencode: OPENCODE_INSTALL_LINE,
};

/** How this hub's process runs and its service's files: from its own environment, or from launchctl/systemctl. */
export interface ServiceFacts {
  /** What started the running hub (known only to the hub itself: its children inherit launchd's variables). */
  runningUnder: "launchd" | "systemd" | "none" | null;
  /** The LaunchAgent's label, or the systemd unit. */
  label: string;
  /** Its plist or unit file, and whether that's there. */
  file: string;
  fileExists: boolean;
  /** launchd has it loaded / systemd has it enabled (null: not asked). */
  loaded?: boolean | null;
  /** It's running now (null: not asked). */
  active?: boolean | null;
  /** Linux: linger is on, so it runs with nobody logged in. */
  linger?: boolean | null;
}

/** This machine on Tailscale, read without changing anything (`tailscale status` and the serve configuration). */
export interface TailscaleFacts {
  /** The command to run it as ("tailscale", or the app's own path on a Mac); null: only the app's own API answers here. */
  cli: string | null;
  /** Which ways were tried, in order: the command, the macOS app's local API (hub/src/tailscale.ts). */
  tried: ("cli" | "app")[];
  /** Which one answered (null: none did). */
  from: "cli" | "app" | null;
  /** BackendState: "Running", "NeedsLogin", "Stopped"…; null when it didn't answer. */
  state: string | null;
  /** Its name on the tailnet, without the final dot: "mac-mini.tail1234.ts.net". */
  dnsName: string | null;
  /** HTTPS certificates are on for the tailnet (null: not known). */
  certs: boolean | null;
  /** When Tailscale signs it out (ms); null when it never does. */
  keyExpiry: number | null;
  /** Where https on port 443 goes ("http://127.0.0.1:7420"; null: nowhere), and whether Funnel puts it online. Null: not asked. */
  serve: { target: string | null; funnel: boolean } | null;
}

/**
 * Whether the hub's own https address answers, asked of that address itself. It needs no Tailscale: it is what the hub
 * can still say about its network when Tailscale can't be asked. Only ever an address this machine's own interfaces
 * have (setup/system.ts checks that first), so these answers are about this machine and no other.
 */
export interface HttpsAnswer {
  /** Something answered at the address. */
  answers: boolean;
  /** What answered is a Crosstalk hub. */
  crosstalk: boolean;
  /** Its version, when a Crosstalk answered (the same one, at this machine's own address, means this very hub). */
  version: string | null;
}

/** Why the checklist isn't the running hub's own (the CLI couldn't get it). */
export interface Offline {
  /** "stopped": nothing answers. "blocked": the hub is there but no way in worked (a sandbox between the two). "older":
   * the hub runs an older build without the setup API. "key": it refused this program's setup key. "error": anything else. */
  code: "stopped" | "blocked" | "older" | "key" | "error";
  /** The running hub's version, when it answered /api/health. */
  version?: string | null;
  /**
   * The hub answered for itself at one of the ways in (its /api/health on this machine), so it runs whatever the
   * service manager says — and whatever went wrong after that (an old build with no setup API on its port, say).
   */
  answered?: boolean;
  /** "stopped": "missing" (no socket) or "refused" (a socket nothing answers on); "error": what went wrong. */
  detail?: string;
  /**
   * Every way in that was tried, in order, and why each didn't work ("blocked" and "stopped"): the hub's Unix socket,
   * then its own address on this machine — or "key" alone, when the setup key itself couldn't be read, since without it
   * neither way can be tried. So the words can say what happened instead of guessing at a cause. `address`: the
   * socket's path or the local address, "" when there was none to try.
   */
  tried?: { via: "socket" | "local" | "key"; address: string; why: string }[];
}

export interface SetupFacts {
  now: number;
  hub: {
    /** The hub answers (its socket or its port). */
    running: boolean;
    version: string;
    name: string;
    platform: string;
    arch: string;
    port: number;
    publicUrl: string | null;
    /** Where publicUrl comes from: the service's environment (CROSSTALK_PUBLIC_URL) or config.json. */
    publicUrlFrom: "env" | "config" | null;
    /** The hub's program, ready for a shell ("/Users/me/.local/bin/crosstalk-hub"). */
    binary: string;
    /** Its data folder, and whether that's the usual ~/.crosstalk (commands then name it). */
    home: string;
    defaultHome: boolean;
    /** The machine's user, for the Mac's automatic login command. */
    user: string;
  };
  offline: Offline | null;
  /**
   * Who made this checklist without the hub: the `setup` command or the setup MCP server. Only the words for a hub that
   * can't be reached differ, and neither may be told to use the other's tools. Unset: the hub's own checklist.
   */
  asker?: "cli" | "mcp";
  service: ServiceFacts | null;
  /** A newer build of the hub at its path, waiting for a restart: its version. */
  staged: string | null;
  /** restart-when-idle.sh, where it's installed. */
  idleRestart: string | null;
  /** undefined: not checked; null: Tailscale isn't installed. */
  tailscale: TailscaleFacts | null | undefined;
  /** The hub's own https address, asked of itself. undefined: not checked; null: there's no https address to ask. */
  https: HttpsAnswer | null | undefined;
  /** People's devices (other machines' sign-ins left out). */
  devices: { name: string; platform: string }[] | null;
  /** People's devices that get notifications; those on Apple's push service; the last one delivered. */
  push: { devices: number; apple: number; lastOkAt: number | null } | null;
  providers: ProviderStatus[] | null;
  accounts: AgentAccount[] | null;
  /** Model servers found on this machine, and whether an account uses each. */
  localServers: { label: string; used: boolean }[] | null;
  /** undefined: not a Mac, or not checked here; null: couldn't check. */
  mac: MacStatus | null | undefined;
  machines: MachineInfo[] | null;
  /** Linked machines' versions, from their /api/health (null: no answer). */
  machineVersions: Record<string, string | null>;
  /** The model pool, when one is set up. */
  pool: { configured: boolean; state: PoolState; detail: string | null; alias: string; machines: number } | null;
  /**
   * BrowserOS neo, the person's browser for agents (hub/src/browseros.ts). undefined: not checked here (an in-memory
   * hub, or a build with no probe for it); null: it was checked and nothing could be read.
   */
  browseros?: BrowserOsFacts | null;
}

/** The checklist for these facts. */
export function setupChecklist(f: SetupFacts): SetupChecklist {
  const items: SetupItem[] = [];
  const add = (i: SetupItem | null) => void (i && items.push(i));
  add(serviceItem(f));
  add(versionItem(f));
  if (!f.hub.running || f.offline) {
    // Only what this program can tell by itself: the rest waits for a hub that answers.
    for (const [id, group, title] of OFFLINE_ITEMS) add(item(id, group, title, "unknown", offlineWords(f), null));
  } else {
    add(tailscaleItem(f));
    add(httpsItem(f));
    add(publicUrlItem(f));
    add(devicesItem(f));
    add(pushItem(f));
    for (const i of agentItems(f)) add(i);
    add(browserOsItem(f));
    add(servicesItem(f));
    for (const i of macItems(f)) add(i);
    add(machinesItem(f));
    add(poolItem(f));
  }
  const required = items.filter((i) => !i.optional);
  const count = (s: SetupState) => required.filter((i) => i.state === s).length;
  const staged = f.staged ?? (f.offline?.code === "older" ? f.hub.version : null);
  const newer = newerMachine(f);
  return {
    schema: 1,
    checkedAt: f.now,
    hub: {
      running: f.hub.running,
      version: f.offline?.code === "older" && f.offline.version ? f.offline.version : f.hub.version,
      name: clean(f.hub.name, 60),
      platform: f.hub.platform,
      arch: f.hub.arch,
      url: f.hub.publicUrl,
      localUrl: localUrl(f),
      binary: f.hub.binary,
      service: f.service?.runningUnder ?? null,
      update: staged ? { version: staged, source: "staged" } : newer ? { version: newer.version, source: "machine", machine: newer.name } : null,
    },
    summary: { total: required.length, done: count("done"), missing: count("missing"), user: count("user"), unknown: count("unknown") },
    items,
    connect: { ...connectCommands(f), browseros: browserOsConnect(f) },
  };
}

/** The commands that add the setup tools to each agent (user-wide, so they work from any folder), and what to tell it. */
export function connectCommands(f: Pick<SetupFacts, "hub">): SetupChecklist["connect"] {
  const env = homeEnv(f);
  const bin = f.hub.binary;
  return {
    claude: `claude mcp add --scope user crosstalk-setup${env ? ` -e ${env}` : ""} -- ${bin} setup-mcp`,
    codex: `codex mcp add crosstalk-setup${env ? ` --env ${env}` : ""} -- ${bin} setup-mcp`,
    // Gemini CLI's -e takes every word after it: it goes last.
    gemini: `gemini mcp add --scope user crosstalk-setup ${bin} setup-mcp${env ? ` -e ${env}` : ""}`,
    cli: hubCommand(f, "setup --json"),
    guide: `http://127.0.0.1:${f.hub.port}/setup.md`,
    prompt: SETUP_PROMPT,
  };
}

/**
 * How each agent on this machine would reach BrowserOS neo: its address as the browser itself reported it, and the
 * exact `mcp add` per agent. Null while there's no address to give — then the item says what to do first, and the app
 * shows no command it can't stand behind.
 */
export function browserOsConnect(f: Pick<SetupFacts, "browseros">): BrowserOsConnect | null {
  const b = f.browseros;
  if (!b?.mcp) return null;
  const url = b.mcp.url;
  return {
    url,
    rows: b.agents
      .filter((a) => MCP_AGENT_NAMES[a])
      // Compared as addresses, not as text: an entry written `http://localhost:9010/mcp` reaches it and is connected.
      .map((agent) => ({ agent, name: MCP_AGENT_NAMES[agent], command: addCommand(agent, url), connected: b.links.some((l) => l.agent === agent && sameMcpUrl(l.url, url)) })),
    restart: RESTART_NOTE,
  };
}

/** CROSSTALK_HOME=<its data folder> when that isn't ~/.crosstalk, else "". */
const homeEnv = (f: Pick<SetupFacts, "hub">) => (f.hub.defaultHome ? "" : `CROSSTALK_HOME=${sh(f.hub.home)}`);

/**
 * The hub's program with `args`, as one line for a shell. It names a data folder other than ~/.crosstalk: without it the
 * program would look in ~/.crosstalk, find no hub there, and `pair` would make a stray data folder with a code nobody knows.
 */
function hubCommand(f: Pick<SetupFacts, "hub">, args: string): string {
  const env = homeEnv(f);
  return `${env ? `${env} ` : ""}${f.hub.binary} ${args}`;
}

/** `crosstalk-hub setup` as a person types it in a terminal here (`home`: the hub's data folder, when it isn't ~/.crosstalk). */
export function setupCliCommand(binary: string, home: string | null): string {
  return `${home ? `CROSSTALK_HOME=${sh(home)} ` : ""}${binary} setup`;
}

/**
 * Where a person's phone opens this hub to pair: this machine's https name once tailscale serve sends it to Crosstalk,
 * else the hub's own https address while Tailscale isn't up or can't be checked. Never http://127.0.0.1: that only
 * works in a browser on this machine. Null: there's none yet (Tailscale and the HTTPS address come first).
 */
export function pairingUrl(f: { hub: Pick<SetupFacts["hub"], "publicUrl" | "port">; tailscale: SetupFacts["tailscale"] }): string | null {
  const url = f.hub.publicUrl?.replace(/\/+$/, "") || null;
  const t = f.tailscale;
  if (t?.state === "Running" && t.dnsName) {
    const name = `https://${t.dnsName}`;
    if (t.certs === false) return null;
    // serve couldn't be asked: the hub's own address, when that's this machine's name.
    if (!t.serve) return url === name ? url : null;
    return sameTarget(t.serve.target, f.hub.port) ? name : null;
  }
  return url && /^https:\/\//.test(url) ? url : null;
}

// ---- items ----

const OFFLINE_ITEMS: [string, SetupGroup, string][] = [
  ["tailscale", "network", "Tailscale"],
  ["https", "network", "HTTPS address"],
  ["public-url", "network", "Its own address"],
  ["devices", "devices", "Paired devices"],
  ["push", "devices", "Notifications"],
  ["agent.claude", "agents", "Claude Code"],
  ["agent.codex", "agents", "Codex"],
];

function item(id: string, group: SetupGroup, title: string, state: SetupState, detail: string, fix: SetupFix | null, optional = false): SetupItem {
  return { id, group, title, state, optional, detail, fix };
}

/**
 * The ways in that were tried and why each didn't work: "its socket (it refused the connection) and
 * http://127.0.0.1:7420 (nothing answered)". The socket is named, not its path: that's in `tried` for whoever wants it.
 */
export function triedWords(o: Offline | null | undefined): string {
  const parts = (o?.tried ?? []).map((t) => `${t.via === "socket" ? "its socket" : t.via === "key" ? "its setup key" : t.address || "its address on this machine"} (${t.why})`);
  return parts.length ? parts.join(" and ") : "neither its socket nor its address on this machine answered";
}

/**
 * The one thing a person can do when nothing here reaches the hub, for whoever is asking. Never "use the setup tools":
 * these are the words those very tools print when they're the ones shut out, and sending the caller back to itself is
 * no fix. The command can be run again outside a sandbox; the MCP server can only hand it to the person.
 */
function unreachableWay(f: SetupFacts): string {
  return f.asker === "mcp" ? `Ask the person to run ${setupCliCommand(f.hub.binary, f.hub.defaultHome ? null : f.hub.home)} in a terminal on this machine.` : "Run this again in a terminal on this machine, outside the agent's sandbox.";
}

/** That way out as a fix, for the one item (the service) that carries it. */
function unreachableFix(f: SetupFacts): SetupFix {
  const command = setupCliCommand(f.hub.binary, f.hub.defaultHome ? null : f.hub.home);
  return f.asker === "mcp" ? { text: "Nothing here can get through, so only the person can see why. Ask them to run this in a terminal on this machine and say what it prints:", command } : { text: "Run it again in a terminal on this machine, outside the agent's sandbox:", command };
}

function offlineWords(f: SetupFacts): string {
  const o = f.offline;
  if (o?.code === "older") return `Crosstalk ${o.version ? `${o.version} ` : ""}runs, and can't show this until it's restarted with the newer build.`;
  if (o?.code === "blocked") return `Crosstalk can't be reached from here: ${triedWords(o)}. ${unreachableWay(f)}`;
  if (o?.code === "key") return "Crosstalk didn't accept this program's setup key: check that CROSSTALK_HOME is the hub's.";
  if (o?.code === "error") return `Crosstalk couldn't make the checklist${o.detail ? ` (${clean(o.detail, 160)})` : ""}. Check again in a minute.`;
  return "Start Crosstalk first, then check again.";
}

const isMac = (f: SetupFacts) => f.hub.platform === "darwin";
const isLinux = (f: SetupFacts) => f.hub.platform === "linux";
const localUrl = (f: SetupFacts) => `http://127.0.0.1:${f.hub.port}`;
const labelOf = (f: SetupFacts) => f.service?.label || (isMac(f) ? "com.crosstalk.hub" : "crosstalk-hub");

function installFix(f: SetupFacts): SetupFix {
  const script = isMac(f) ? "install-macos.sh" : "install.sh";
  // It unloads the LaunchAgent that runs Crosstalk now, which ends what Crosstalk started: in its terminal, the
  // installer itself, before it loads the new one.
  const where = isMac(f) && f.service?.runningUnder === "launchd" ? " Run it in Terminal on the Mac, not in a Crosstalk chat or Crosstalk's terminal: it restarts Crosstalk, which would end the installer halfway." : "";
  return {
    text: `Install the service with ${script} from the Crosstalk release folder: it starts Crosstalk at ${isMac(f) ? "login" : "boot"} and again if it stops. It asks for the password once${isMac(f) ? ", to keep the Mac awake" : ""}.${where}`,
    command: `./${script}`,
    password: true,
  };
}

/** Restarting stops replies that are running: through the idle watcher when it's there, else only with the person's OK. */
export function restartFix(f: SetupFacts): SetupFix {
  if (isMac(f) && f.idleRestart)
    return {
      text: "Unless it runs already (pgrep -f restart-when-idle), start the idle watcher: it restarts Crosstalk once no chat has worked for five minutes.",
      command: `nohup ${sh(f.idleRestart)} >> ~/Library/Logs/Crosstalk/restart-when-idle.log 2>&1 &`,
    };
  return {
    text: "Restart it when no chat is working: a restart stops replies that are running, so ask the person first.",
    command: isMac(f) ? `launchctl kickstart -k gui/$(id -u)/${labelOf(f)}` : "systemctl --user restart crosstalk-hub",
  };
}

function serviceItem(f: SetupFacts): SetupItem {
  const s = f.service;
  const title = "Runs as a service";
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("service", "hub", title, state, detail, fix);
  if (!s) return mk("unknown", "Couldn't tell how Crosstalk runs here.");
  const kind = isMac(f) ? `a LaunchAgent (${s.label})` : "a systemd user service (crosstalk-hub)";
  const startFix: SetupFix = isMac(f)
    ? { text: "Start the service:", command: `launchctl kickstart gui/$(id -u)/${s.label}` }
    : { text: "Start the service:", command: "systemctl --user start crosstalk-hub" };
  if (f.hub.running && !f.offline) {
    if (s.runningUnder === "launchd")
      return s.fileExists ? mk("done", `Runs as ${kind}: it starts at login and again if it stops.`) : mk("missing", `Runs under launchd, but ${s.file} is gone, so it won't start at the next login.`, installFix(f));
    if (s.runningUnder === "systemd") {
      if (s.linger === false)
        return mk("user", `Runs as ${kind}, but stops when you log out (linger is off).`, { text: "Keep it running with nobody logged in (it asks for the password):", command: `sudo loginctl enable-linger ${sh(f.hub.user)}`, password: true });
      return mk("done", `Runs as ${kind}: it starts at boot and again if it stops.`);
    }
    if (s.runningUnder === "none")
      return mk("missing", "Crosstalk was started by hand: it stops when that terminal closes, and doesn't start again after a restart.", s.fileExists ? { ...startFix, text: "The service is installed: stop this copy (Ctrl-C where it runs), then start the service:" } : installFix(f));
    return mk("unknown", "Couldn't tell how Crosstalk runs here.");
  }
  // The CLI, without a hub that answers its socket.
  if (!isMac(f) && !isLinux(f)) return mk("unknown", "Only Mac and Linux services are checked.");
  if (!s.fileExists) return mk("missing", "Crosstalk isn't installed as a service here.", installFix(f));
  if (s.loaded === false)
    return isMac(f)
      ? mk("missing", "The LaunchAgent is installed but not loaded, so Crosstalk doesn't run.", { text: "Load it:", command: `launchctl bootstrap gui/$(id -u) ${sh(s.file)}` })
      : mk("missing", "The service is installed but not enabled, so Crosstalk doesn't run.", { text: "Enable and start it:", command: "systemctl --user enable --now crosstalk-hub" });
  if (s.active === false) {
    const log = isMac(f) ? "tail -n 50 ~/Library/Logs/Crosstalk/hub.log" : "journalctl --user -u crosstalk-hub -n 50 --no-pager";
    return mk("missing", "The service is installed but Crosstalk isn't running: it may be failing to start.", { ...startFix, text: `See why at the end of its log (${log}), then start it:` });
  }
  if (s.active === null || s.loaded === null) return mk("unknown", "Couldn't ask the service manager about Crosstalk.");
  const o = f.offline;
  if (o?.code === "blocked") return mk("unknown", `Crosstalk runs as a service, but nothing here could ask it: ${triedWords(o)}.`, unreachableFix(f));
  if (o?.code === "key") return mk("unknown", "Crosstalk runs as a service, but didn't accept this program's setup key.", { text: "Run this with the same CROSSTALK_HOME as the hub." });
  if (o?.code === "stopped") return mk("unknown", `Crosstalk runs as a service, but its socket isn't in ${f.hub.home}/run.`, { text: "Run this with the hub's CROSSTALK_HOME." });
  return mk("done", `Runs as ${kind}.`);
}

function versionItem(f: SetupFacts): SetupItem {
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("version", "hub", "Version", state, detail, fix);
  const o = f.offline;
  if (o?.code === "older") return mk("missing", `Crosstalk ${o.version ?? "(an older build)"} runs. ${f.hub.version} is installed and starts at its next restart.`, restartFix(f));
  if (!f.hub.running || o) return mk("unknown", `Crosstalk ${f.hub.version} is installed.`);
  if (f.staged) return mk("missing", f.staged === f.hub.version ? `A new build of ${f.hub.version} is installed and waits for a restart.` : `Crosstalk ${f.staged} is installed and waits for a restart (${f.hub.version} runs now).`, restartFix(f));
  const newer = newerMachine(f);
  if (newer) return mk("user", `${newer.name} runs Crosstalk ${newer.version}, newer than this one (${f.hub.version}).`, { text: "Update Crosstalk here the way it was installed, then restart it when no chat is working." });
  return mk("done", `Crosstalk ${f.hub.version}. No newer build is waiting${f.machines?.length ? " here or on your other machines" : ""}.`);
}

/** A linked machine that runs a newer Crosstalk than this one, if any. */
function newerMachine(f: SetupFacts): { name: string; version: string } | null {
  for (const m of f.machines ?? []) {
    const v = f.machineVersions[m.id];
    if (v && newerThan(v, f.hub.version)) return { name: clean(m.name, 40), version: clean(v, 20) };
  }
  return null;
}

/** "0.4.10" is newer than "0.4.9". */
export function newerThan(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

function tailscaleItem(f: SetupFacts): SetupItem {
  const t = f.tailscale;
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("tailscale", "network", "Tailscale", state, detail, fix);
  if (t === undefined) return mk("unknown", "Not checked here.");
  if (t === null)
    return mk("user", "Tailscale isn't installed. It's how your phone reaches this machine, from anywhere.", {
      text: isMac(f) ? "Install Tailscale on the Mac (from tailscale.com or the App Store), open it and sign in." : "Install Tailscale and sign in (it asks for the password):",
      ...(isMac(f) ? {} : { command: "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up" }),
      password: true,
      url: "https://tailscale.com/download",
    });
  if (t.state === null) {
    // Both ways in were tried (hub/src/tailscale.ts); say which, so a report of this names them.
    const ways = t.tried.includes("app") ? "the tailscale command and the Tailscale app's own API" : "the tailscale command";
    const still = ownHttps(f) ? " Its https address still reaches Crosstalk, so Tailscale itself is running." : "";
    return mk("unknown", `Tailscale is installed but didn't answer (tried ${ways}).${still}`, still ? null : { text: isMac(f) ? "Open Tailscale on the Mac and check it's signed in." : "Check Tailscale here:", ...(isMac(f) ? {} : { command: `${tsCli(t)} status` }) });
  }
  if (t.state !== "Running")
    return mk("user", `Tailscale is ${t.state === "NeedsLogin" ? "signed out" : t.state === "Stopped" ? "turned off" : `not up (${clean(t.state, 30)})`}, so your phone can't reach this machine.`, {
      text: isMac(f) ? "Open Tailscale on the Mac and sign in, or turn it on." : "Sign in (it asks for the password):",
      ...(isMac(f) ? {} : { command: "sudo tailscale up" }),
      password: true,
    });
  if (t.keyExpiry !== null)
    return mk("user", `Tailscale signs this machine out on ${day(t.keyExpiry)}, and then nothing reaches it.`, {
      text: "Turn off key expiry for it in Tailscale's admin console: Machines, this machine's menu, then Disable key expiry. It works from your phone.",
      url: "https://login.tailscale.com/admin/machines",
    });
  return mk("done", t.dnsName ? `On your tailnet as ${clean(t.dnsName, 120)}.` : "On your tailnet.");
}

const tailscaleUp = (f: SetupFacts) => !!f.tailscale && f.tailscale.state === "Running";

/**
 * Tailscale couldn't be asked at all: it isn't installed, or neither way in answered. Only then does the hub's own
 * https address stand in for it — a Tailscale that answered "Stopped" or "NeedsLogin" has said what's wrong, and the
 * Tailscale item is the thing to do.
 */
const tailscaleSilent = (f: SetupFacts) => !f.tailscale || f.tailscale.state === null;

/**
 * The hub's own https address answered, and what answered was this very Crosstalk. Asked of the address itself, and
 * only when that address is one of this machine's own (setup/system.ts), so it holds even when Tailscale can't be
 * asked: another Crosstalk, or another version at that address, doesn't count.
 */
const ownHttps = (f: SetupFacts) => !!f.https?.crosstalk && f.https.version === f.hub.version;

/** The command the fixes run Tailscale with; the name it goes by on PATH when only the app's own API answered here. */
const tsCli = (t: TailscaleFacts) => sh(t.cli || "tailscale");

function httpsItem(f: SetupFacts): SetupItem {
  const t = f.tailscale;
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("https", "network", "HTTPS address", state, detail, fix);
  // Tailscale isn't there or didn't answer: the hub can still ask its own address, which is this item's own question.
  if (tailscaleSilent(f)) return httpsFromSelf(f, mk, "tailscale") ?? mk("unknown", "Needs Tailscale first (above).");
  // It did answer, and it isn't up: that's the Tailscale item's own fix, and no serve command can help until it is.
  if (!t || !tailscaleUp(f)) return mk("unknown", "Needs Tailscale first (above).");
  if (t.certs === false)
    return mk("user", "HTTPS certificates are off for your tailnet, so this machine has no https address.", {
      text: "Turn on HTTPS Certificates in Tailscale's admin console (the DNS page). It works from your phone.",
      url: "https://login.tailscale.com/admin/dns",
    });
  if (!t.serve) return httpsFromSelf(f, mk, "serve") ?? mk("unknown", "Couldn't ask where tailscale serve sends https.");
  const want = localUrl(f);
  const serve = `${tsCli(t)} serve --bg --https=443 ${want}`;
  if (t.serve.funnel) return mk("missing", "Tailscale Funnel puts Crosstalk on the public internet. It's meant for your tailnet only.", { text: "Turn Funnel off and keep it on your tailnet:", command: `${tsCli(t)} funnel --https=443 off && ${serve}` });
  if (!sameTarget(t.serve.target, f.hub.port))
    return mk("missing", t.serve.target ? `https on this machine goes to ${clean(t.serve.target, 80)}, not to Crosstalk (port ${f.hub.port}).` : "tailscale serve is off, so nothing answers at this machine's https address.", {
      text: isLinux(f) ? "Publish Crosstalk on your tailnet (if it says access denied, run sudo tailscale set --operator=$USER once first: it asks for the password):" : "Publish Crosstalk on your tailnet:",
      command: serve,
    });
  return mk("done", `${t.dnsName ? `https://${clean(t.dnsName, 120)}` : "Its https address"} goes to Crosstalk, on your tailnet only.`);
}

/**
 * What the hub's own https address says, for what Tailscale left unanswered: whether anything answers there is the
 * item's own question. Funnel is in the serve configuration, so it can't be told apart this way (an address open to the
 * internet answers the same), and the words name the gap they stand in for — `gap` is which one: Tailscale itself
 * didn't answer, or it did and only the serve configuration couldn't be read. Null: there's no address to ask, or it
 * wasn't asked.
 */
function httpsFromSelf(f: SetupFacts, mk: (state: SetupState, detail: string, fix?: SetupFix | null) => SetupItem, gap: "tailscale" | "serve"): SetupItem | null {
  const h = f.https;
  const url = f.hub.publicUrl?.replace(/\/+$/, "") || null;
  if (!h || !url) return null;
  const silent = gap === "tailscale";
  const unknownFunnel = silent
    ? "Tailscale itself couldn't be asked, so whether Funnel also puts it on the public internet isn't known."
    : "Where tailscale serve sends https couldn't be read, so whether Funnel is also on isn't known.";
  if (ownHttps(f)) return mk("done", `${clean(url, 120)} answers and reaches this Crosstalk. ${unknownFunnel}`);
  // Nothing answers, and Tailscale isn't even installed: the item waits for it rather than naming a command that
  // isn't there (the Tailscale item above is the thing to do).
  if (!f.tailscale) return null;
  const serve = `${tsCli(f.tailscale)} serve --bg --https=443 ${localUrl(f)}`;
  // With Tailscale up and only serve unread, publishing the address is the whole of it; with Tailscale silent, it is
  // worth looking at Tailscale first (the Linux line names what makes serve status refuse: no operator).
  const publish = isLinux(f) ? "Publish Crosstalk on your tailnet (if it says access denied, run sudo tailscale set --operator=$USER once first: it asks for the password):" : "Publish Crosstalk on your tailnet:";
  const checkFirst = isMac(f) ? "Open Tailscale on the Mac and check it's signed in, then send this machine's https address to Crosstalk:" : "Check Tailscale is up (tailscale status), then send this machine's https address to Crosstalk:";
  if (h.answers) return mk("missing", `Something other than this Crosstalk answers at ${clean(url, 120)}.`, { text: silent ? "Send this machine's https address to Crosstalk:" : publish, command: serve });
  return mk("missing", `Nothing answers at ${clean(url, 120)}, and ${silent ? "Tailscale couldn't be asked why" : "where tailscale serve sends https couldn't be read"}.`, { text: silent ? checkFirst : publish, command: serve });
}

/** Whether serve's target is this hub's port on this machine. */
function sameTarget(target: string | null, port: number): boolean {
  if (!target) return false;
  try {
    const u = new URL(target);
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && Number(u.port || 80) === port;
  } catch {
    return false;
  }
}

function publicUrlItem(f: SetupFacts): SetupItem {
  const t = f.tailscale;
  const url = f.hub.publicUrl?.replace(/\/+$/, "") || null;
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("public-url", "network", "Its own address", state, detail, fix);
  if (!t || !tailscaleUp(f) || !t.dnsName) {
    // Tailscale can't name this machine, but the address can say it is this machine's: the hub only ever asks an
    // address its own interfaces have (setup/system.ts), so this hub answering there checks the name another way. A
    // Tailscale that answered it is off or signed out has said what's wrong, and this item waits for the one above.
    const silent = tailscaleSilent(f);
    if (url && ownHttps(f) && (silent || tailscaleUp(f))) return mk("done", `Crosstalk knows its address: ${clean(url, 120)}, and this hub answers there.${silent ? " Tailscale couldn't be asked to confirm the name." : ""}`);
    if (!url) return mk("unknown", "Needs Tailscale first (above).");
    const why = silent && t ? "Tailscale couldn't be asked to check it" : "Tailscale isn't up to check it";
    return mk("unknown", `Set to ${clean(url, 120)}; ${why}${f.https && !f.https.answers ? ", and nothing answers there" : ""}.`);
  }
  const want = `https://${t.dnsName}`;
  if (url === want) return mk("done", `Crosstalk knows its address: ${clean(url, 120)}.`);
  const { state, fix } = publicUrlFix(f, want);
  return url
    ? mk(state, `Crosstalk takes its address to be ${clean(url, 120)}, but Tailscale names this machine ${clean(t.dnsName, 120)}.`, fix)
    : mk(state, "Crosstalk doesn't know its https address, so its links and iPhone notifications don't work.", fix);
}

/** The environment wins over config.json, so the fix goes where the address is set now. */
function publicUrlFix(f: SetupFacts, want: string): { state: SetupState; fix: SetupFix } {
  const file = f.service?.file;
  if (f.hub.publicUrlFrom === "env" && file && isMac(f))
    // The person's, at the Mac: unloading the LaunchAgent ends Crosstalk and everything it started (its chats' agents,
    // its terminals), so run from there the command would stop before loading it again, and Crosstalk would stay off.
    // The other restarts are one request that launchd or systemd finishes whoever asked.
    return {
      state: "user",
      fix: {
        text: `The LaunchAgent sets it: change CROSSTALK_PUBLIC_URL in ${file}, then load it again when no chat is working (that restarts Crosstalk). Run it in Terminal on the Mac, not in a Crosstalk chat or Crosstalk's terminal: those end with Crosstalk, before it's loaded again, and Crosstalk would stay off.`,
        command: `/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:CROSSTALK_PUBLIC_URL ${want}" ${sh(file)} && launchctl bootout gui/$(id -u)/${labelOf(f)} && launchctl bootstrap gui/$(id -u) ${sh(file)}`,
      },
    };
  if (f.hub.publicUrlFrom === "env" && file && isLinux(f))
    return {
      state: "missing",
      fix: {
        text: `The service sets it: change CROSSTALK_PUBLIC_URL in ${file}, then restart it when no chat is working.`,
        command: `sed -i 's#^Environment=CROSSTALK_PUBLIC_URL=.*#Environment=CROSSTALK_PUBLIC_URL=${want}#' ${sh(file)} && systemctl --user daemon-reload && systemctl --user restart crosstalk-hub`,
      },
    };
  return { state: "missing", fix: { text: `Set "publicUrl": "${want}" in ${f.hub.home}/config.json, then restart Crosstalk when no chat is working (see Version).` } };
}

function devicesItem(f: SetupFacts): SetupItem {
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("devices", "devices", "Paired devices", state, detail, fix);
  if (!f.devices) return mk("unknown", "Couldn't read the devices.");
  if (!f.devices.length) {
    const url = pairingUrl(f);
    return mk("user", "No phone or computer is paired yet.", {
      text: url
        ? `Make a one-time code (the pair_code tool, or the command below), then open ${clean(url, 120)} on the phone and type it there.`
        : `A phone can't open ${localUrl(f)} (that only works on this machine), so first set up Tailscale and the HTTPS address (above). Then make a one-time code (the pair_code tool, or the command below), open this machine's https address on the phone and type it there.`,
      command: hubCommand(f, "pair 15"),
      screen: "Settings → Devices → Pair a new device",
      target: "devices",
    });
  }
  return mk("done", `${f.devices.length} paired: ${names(f.devices.map((d) => clean(d.name, 40)))}.`);
}

function pushItem(f: SetupFacts): SetupItem {
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("push", "devices", "Notifications", state, detail, fix);
  const p = f.push;
  if (!p || !f.devices) return mk("unknown", "Couldn't read the notification settings.");
  if (!f.devices.length) return mk("unknown", "Pair a device first (above).");
  const https = /^https:\/\//.test(f.hub.publicUrl ?? "");
  const screen = { screen: "Settings → Devices", target: "devices" };
  if (!p.devices)
    return mk("user", `No device gets notifications yet, so approvals and finished replies don't reach you.${https ? "" : " They need the https address first (above)."}`, {
      text: "On the phone, open Crosstalk (on an iPhone from its Home Screen icon: Share, then Add to Home Screen first), then Settings → Devices → Turn on notifications.",
      ...screen,
    });
  if (p.apple && !https) return mk("missing", "iPhones get no notifications until Crosstalk knows its https address.", { text: "Fix Its own address (above), then restart Crosstalk." });
  return mk("done", `On for ${p.devices} device${p.devices === 1 ? "" : "s"}${p.lastOkAt ? `; the last one was delivered ${ago(f.now - p.lastOkAt)}` : ""}.`);
}

function agentItems(f: SetupFacts): SetupItem[] {
  const statuses = f.providers;
  if (!statuses) return CHAT_PROVIDERS.map((p) => item(`agent.${p}`, "agents", PROVIDER_INFO[p].name, "unknown", "Couldn't read the agents.", null));
  const status = (p: Provider) => statuses.find((s) => s.provider === p);
  // Installed agents are needed; until Claude Code or Codex is, both are: single-agent chats run only those two, so
  // Gemini, Antigravity or Muse alone doesn't make them optional.
  const any = CHAT_PROVIDERS.some((p) => status(p)?.installed);
  const out: SetupItem[] = [];
  for (const p of SETUP_AGENTS) {
    const st = status(p);
    const chat = (CHAT_PROVIDERS as readonly string[]).includes(p);
    if (!chat && !st?.installed) continue;
    const name = PROVIDER_INFO[p].name;
    const mk = (state: SetupState, detail: string, fix: SetupFix | null = null, optional = false) => item(`agent.${p}`, "agents", name, state, detail, fix, optional);
    const recheck: SetupFix = { text: "Check again: the recheck_agents tool, or Settings → AI services → Check." };
    if (!st || !st.checkedAt) {
      out.push(mk("unknown", "Not checked yet.", recheck, !!any && !st?.installed));
      continue;
    }
    const screen = chat ? { screen: `Settings → AI services → ${name}`, target: `agent-${p}` } : {};
    if (!st.installed) {
      out.push(mk("missing", `${name} isn't installed${any ? ". Optional: another agent is." : "."}`, { text: `Install it with ${PROVIDER_INFO[p].vendor.split(" ·")[0]}'s official installer${p === "codex" ? " (it needs Node.js: brew install node)" : ""}:`, command: INSTALL_LINES[p], ...screen }, any));
      continue;
    }
    const version = st.version ? ` ${clean(st.version, 30)}` : "";
    // Nothing to sign in to: it runs on the AI services added for it, with their keys.
    if (isServiceOnlyAgent(p)) {
      if (st.error) out.push(mk("missing", `${name}${version} can't be used: ${clean(st.error, 200)}`, { text: `Install the version Crosstalk needs: Settings → AI services → ${name}.`, command: INSTALL_LINES[p], screen: `Settings → AI services → ${name}`, target: `agent-${p}` }, true));
      else out.push(mk("done", `${name}${version} is installed. It runs on AI services, so there's nothing to sign in to.`));
      continue;
    }
    const signedIn = !!st.signedIn || (f.accounts ?? []).some((a) => a.provider === p && a.signedIn);
    if (signedIn) out.push(mk("done", `${name}${version} is signed in${st.plan ? ` (${clean(st.plan, 40)})` : ""}.`));
    else if (st.signedIn === false) out.push(mk("user", `${name}${version} is installed but not signed in.`, signInFix(p, st.binPath)));
    else out.push(mk("unknown", `${name}${version} is installed; its sign-in couldn't be checked${st.error ? ` (${clean(st.error, 160)})` : ""}.`, recheck));
  }
  return out;
}

function signInFix(p: Provider, bin: string | null): SetupFix {
  const cli = bin ? sh(bin) : (p === "antigravity" ? "agy" : p);
  switch (p) {
    case "claude":
      return { text: "Sign in with the Claude account that has your plan: from the phone, or at the machine with the command.", command: `${cli} auth login`, password: true, screen: "Settings → AI services → Claude Code → Sign in", target: "agent-claude" };
    case "codex":
      return { text: "Sign in with your ChatGPT account: from the phone, or at the machine with the command.", command: `${cli} login`, password: true, screen: "Settings → AI services → Codex → Sign in", target: "agent-codex" };
    case "gemini":
      return { text: "At the machine, run Gemini CLI and choose Login with Google (or use a paid Gemini API key).", command: cli, password: true };
    case "antigravity":
      return { text: "At the machine, run Antigravity CLI, sign in with Google, then type /exit.", command: cli, password: true };
    default:
      return { text: "At the machine, sign in to your Meta account:", command: `${cli} login`, password: true };
  }
}

/** How an agent is named in the words here. */
const MCP_AGENT_NAMES: Record<McpAgent, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

/** A size a person reads: "165 MB". */
const mb = (bytes: number | null) => (bytes && bytes > 0 ? `${Math.round(bytes / 1_000_000)} MB` : null);

/** "until 14:05", in the hub's own clock — only ever used for a GitHub allowance that comes back at a known time. */
const until = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * BrowserOS neo: the browser the person keeps for agents, and whether the agents on this machine can reach it.
 *
 * It is optional — Crosstalk works without it — so it never counts against the summary, and an update is offered,
 * never done. The order of the checks is what a person would do: is it there, has it run once (that is where its MCP
 * address comes from), does their agent point at *that* address, and only then, is there a newer build. A browser
 * that is connected but a version behind still works; one that is new but unconnected does nothing for them.
 */
function browserOsItem(f: SetupFacts): SetupItem | null {
  if (f.browseros === undefined) return null;
  const title = "BrowserOS neo";
  const screen = { screen: "Settings → Set up with an AI agent", target: "agent-setup" };
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("browseros", "agents", title, state, detail, fix, true);
  const b = f.browseros;
  if (!b) return mk("unknown", "Couldn't check BrowserOS neo on this machine.", { text: "Check again: the setup_status tool, or Check again below.", ...screen });

  // No build exists for this machine at all. Nothing to install and nothing to fix: say so once and leave it.
  if (!b.target.wants.length) return mk("unknown", b.target.blocked ?? `BrowserOS neo has no build for ${clean(b.target.platform, 20)} ${clean(b.target.arch, 20)}.`, null);

  const askFailed = b.releases.ok ? null : b.releases;
  const whyNoList = askFailed
    ? askFailed.why === "offline"
      ? "GitHub couldn't be reached, so a newer build can't be looked for."
      : askFailed.why === "rate"
        ? `GitHub's limit for unsigned checks is used up${askFailed.retryAt ? `, back at ${until(askFailed.retryAt)}` : ""}, so a newer build can't be looked for.`
        : `GitHub couldn't be asked (${clean(askFailed.detail, 120)}).`
    : null;
  const installCommand = `${f.hub.binary} browseros install`;

  // ---- not installed ----
  if (!b.installed) {
    if (askFailed) return mk("unknown", `Not installed, and ${whyNoList}`, { text: askFailed.why === "rate" ? "Nothing to run: GitHub lets one machine check 60 times an hour. Check again after the reset." : "Check the machine's network, then check again.", ...screen });
    if (!b.newest) return mk("unknown", "Not installed, and none of BrowserOS neo's releases has a build for this machine.", null);
    const size = mb(b.newest.asset.size);
    return mk("missing", `Not installed. The newest build for this machine is ${clean(b.newest.version, 20)}${size ? ` (${size})` : ""}.${b.newest.note ? ` ${b.newest.note}` : ""}`, {
      text: "Install it. Crosstalk checks the download against the SHA-256 GitHub reports, and on a Mac its signature and notarisation, before anything goes in /Applications:",
      command: installCommand,
      ...screen,
    });
  }

  const version = b.installed.version ? ` ${clean(b.installed.version, 20)}` : "";

  // ---- installed, but it has never run here, so it has no address yet ----
  if (!b.mcp) {
    return mk("user", `BrowserOS neo${version} is installed, but Crosstalk can't find the address it serves agents on. It writes that down the first time it runs.`, {
      text: "Open BrowserOS neo once on the machine, then check again. Its port moves between builds, so Crosstalk reads it from the browser rather than guessing.",
      ...screen,
    });
  }

  // ---- installed and answering: does each agent here point at that very address? ----
  const url = b.mcp.url;
  const agents = b.agents.filter((a) => MCP_AGENT_NAMES[a]);
  // An agent can hold more than one entry for it (its own "connect your agent" page, plus one added by hand). One that
  // already reaches the browser is the answer: nothing to fix. Otherwise the one named after the browser is the entry
  // to put right, and only then whatever else was found.
  const linkFor = (a: McpAgent) => {
    const mine = b.links.filter((l) => l.agent === a);
    return mine.find((l) => sameMcpUrl(l.url, url)) ?? mine.find((l) => namesBrowser(l.name)) ?? mine[0] ?? null;
  };
  // `localhost`, `::1` and a trailing slash are the same address, so none of them is reported as an old entry.
  const connected = agents.filter((a) => {
    const l = linkFor(a);
    return !!l && sameMcpUrl(l.url, url);
  });
  const stale = agents.filter((a) => {
    const l = linkFor(a);
    return !!l && !sameMcpUrl(l.url, url);
  });
  const missing = agents.filter((a) => !linkFor(a));
  const name = (a: McpAgent) => MCP_AGENT_NAMES[a];

  if (stale.length) {
    const a = stale[0];
    const l = linkFor(a)!;
    return mk("missing", `BrowserOS neo${version} answers at ${url}, but ${name(a)} points at ${clean(l.url, 60)}. Its port moves between builds, so an old entry stops working.`, {
      text: `Point ${name(a)} at the address it serves now. ${RESTART_NOTE}`,
      // The entry's own name, and `;` not `&&`: removing a name that isn't there exits 1, which used to stop the add
      // from ever running — the whole fix was a no-op for anyone whose entry wasn't called "browseros-neo".
      command: `${mcpRemoveCommand(a, l.name)}; ${addCommand(a, url)}`,
      ...screen,
    });
  }
  if (missing.length) {
    const a = missing[0];
    return mk("missing", `BrowserOS neo${version} answers at ${url}. ${name(a)}${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ""} hasn't got it yet.`, {
      text: `Add it to ${name(a)} as "${MCP_SERVER_NAME}". ${RESTART_NOTE}`,
      command: addCommand(a, url),
      ...screen,
    });
  }
  if (!agents.length) {
    return mk("user", `BrowserOS neo${version} answers at ${url}, but no agent is installed here to use it.`, { text: "Install Claude Code or Codex first (above), then check again.", ...screen });
  }

  // ---- connected: all that's left is whether there's a newer build ----
  const who = `${names(connected.map(name))} ${connected.length === 1 ? "is" : "are"} connected at ${url}`;
  if (askFailed) return mk("done", `BrowserOS neo${version}: ${who}. ${whyNoList}`);
  const newer = b.newest && newerVersion(b.installed.version, b.newest.version) ? b.newest : null;
  if (newer) {
    const size = mb(newer.asset.size);
    const running = b.installed.running;
    const open = running ? " It's open now, so quit it first: Crosstalk won't replace a copy that's open." : "";
    return mk("missing", `BrowserOS neo${version}: ${who}. ${clean(newer.version, 20)} is out${size ? ` (${size})` : ""}.${open} Your sign-ins and tabs stay: the update replaces the app, never your profile.`, {
      text: running
        ? "Quit BrowserOS neo on the machine, then run this. A copy that's open would be closed and lose what's in it, so the update stops instead. Crosstalk checks the SHA-256, the signature and the notarisation first, and installs nothing if any of them fails:"
        : "Update it when you want to. Crosstalk checks the SHA-256, the signature and the notarisation first, and installs nothing if any of them fails:",
      // Never `--replace-running`. That flag exists so a copy with the person's work in it is not thrown away, and a
      // suggested command is run by whoever is handed it — an agent polling this list, or a Copy on the phone.
      command: installCommand,
      ...screen,
    });
  }
  return mk("done", `BrowserOS neo${version} is the newest build, and ${who}.`);
}

function servicesItem(f: SetupFacts): SetupItem {
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("services", "services", "AI services", state, detail, fix, true);
  const screen = { screen: "Settings → AI services", target: "ai-services" };
  if (!f.accounts) return mk("unknown", "Couldn't read the AI services.");
  const added = f.accounts.filter((a) => a.kind === "endpoint" || a.kind === "apikey");
  const label = (a: AgentAccount) => `${clean(a.label, 40)} (${PROVIDER_INFO[a.provider]?.name ?? a.provider})`;
  const broken = added.filter((a) => a.signedIn === false);
  if (broken.length) return mk("user", `${names(broken.map(label))}: ${broken.length === 1 ? "its key was refused" : "their keys were refused"}.`, { text: "Replace the key in Settings → AI services (Test says what's wrong).", ...screen });
  const unused = (f.localServers ?? []).filter((s) => !s.used);
  if (unused.length) return mk("user", `${names(unused.map((s) => clean(s.label, 40)))} ${unused.length === 1 ? "runs" : "run"} on this machine and ${unused.length === 1 ? "isn't" : "aren't"} used yet.`, { text: "Tap New chat and pick it: one tap adds it and starts a chat. Settings → AI services → Use it does it too.", ...screen });
  if (added.length) return mk("done", `${added.length} added: ${names(added.map(label))}.`);
  return mk("user", "None added. You can add a model that runs on this machine, or an API key.", { text: "Settings → AI services → Add an AI service.", ...screen });
}

function macItems(f: SetupFacts): SetupItem[] {
  if (!isMac(f) || f.mac === undefined) return [];
  const m = f.mac;
  const screen = { screen: "Settings → This Mac", target: "this-mac" };
  const fixLine = (what: "autologin" | "power") => {
    // As Settings → This Mac runs it, without the script(1) wrapper that gives sudo a terminal there.
    const argv = macFixCommand(what, f.hub.user)?.argv.slice(3) ?? [];
    return argv.map(sh).join(" ");
  };
  if (!m)
    return (
      [
        ["mac.autologin", "Starts again after a restart"],
        ["mac.power", "Stays on"],
        ["mac.full-disk", "Never asks about files"],
        ["mac.updates", "Updates"],
      ] as const
    ).map(([id, title]) => item(id, "mac", title, "unknown", "Couldn't check this Mac.", null, id === "mac.full-disk" || id === "mac.updates"));
  const out: SetupItem[] = [];
  // Automatic login: after an update or a power cut, the hub (a LaunchAgent) starts only once someone logs in.
  if (m.autoLogin) out.push(item("mac.autologin", "mac", "Starts again after a restart", "done", `Logs in as ${clean(m.autoLogin, 40)} by itself after a restart, and Crosstalk starts.`, null));
  else if (m.fileVault)
    out.push(item("mac.autologin", "mac", "Starts again after a restart", "user", "FileVault is on, so after a restart the Mac waits for its password, and Crosstalk can't start until someone types it there.", { text: "Only someone at the Mac can change this: turn FileVault off in System Settings → Privacy & Security (then automatic login can go on), or type the password after each restart.", ...screen }));
  else if (m.autoLogin === null && m.fileVault === null) out.push(item("mac.autologin", "mac", "Starts again after a restart", "unknown", "Couldn't tell whether the Mac logs in by itself.", null));
  else
    out.push(item("mac.autologin", "mac", "Starts again after a restart", "user", "After an update or a power cut the Mac waits at the login screen, and Crosstalk can't start until someone logs in.", { text: "Turn on automatic login with the Mac's password, from the phone or at the Mac. Anyone at the Mac can then use it.", command: fixLine("autologin"), password: true, ...screen, screen: "Settings → This Mac → Turn on automatic login" }));
  const sleeps = m.sleepMinutes !== null && m.sleepMinutes > 0;
  const off = m.restartsAfterPowerCut === false;
  if (m.sleepMinutes === null) out.push(item("mac.power", "mac", "Stays on", "unknown", "Couldn't read the Mac's power settings.", null));
  else if (sleeps || off)
    out.push(
      item("mac.power", "mac", "Stays on", "user", [sleeps ? `It sleeps after ${m.sleepMinutes} minute${m.sleepMinutes === 1 ? "" : "s"} with nobody using it, and chats stop until it wakes.` : null, off ? "After a power cut it stays off until someone presses its button." : null].filter(Boolean).join(" "), {
        text: "Keep it on with the Mac's password, from the phone or at the Mac.",
        command: fixLine("power"),
        password: true,
        ...screen,
        screen: "Settings → This Mac → Keep it on",
      }),
    );
  else out.push(item("mac.power", "mac", "Stays on", "done", `It never sleeps${m.restartsAfterPowerCut ? " and starts up again after a power cut" : ""}.`, null));
  if (m.fullDiskAccess === null) out.push(item("mac.full-disk", "mac", "Never asks about files", "unknown", "Couldn't tell whether Crosstalk has Full Disk Access.", null, true));
  else if (m.fullDiskAccess) out.push(item("mac.full-disk", "mac", "Never asks about files", "done", "Full Disk Access is on: agents read any file without macOS asking.", null, true));
  else
    out.push(
      item("mac.full-disk", "mac", "Never asks about files", "user", "Off: macOS asks on the Mac's screen (or refuses) when an agent reads Mail, Messages or other apps' data. With it on, every agent can read everything without anything showing.", {
        text: "Your choice, and only someone at the Mac can turn it on: System Settings → Privacy & Security → Full Disk Access, then add crosstalk-hub. The command opens that page there.",
        command: `open ${sh(MAC_PANES.fullDisk)}`,
        ...screen,
      }, true),
    );
  if (m.autoUpdates === null) out.push(item("mac.updates", "mac", "Updates", "unknown", "Couldn't read the update settings.", null, true));
  else if (!m.autoUpdates) out.push(item("mac.updates", "mac", "Updates", "done", "macOS doesn't install updates by itself: install them when you're at the Mac.", null, true));
  else if (m.autoLogin) out.push(item("mac.updates", "mac", "Updates", "done", "macOS installs updates and restarts by itself; Crosstalk starts again afterwards.", null, true));
  else out.push(item("mac.updates", "mac", "Updates", "user", "macOS installs updates and restarts by itself, then waits at the login screen.", { text: "Turn on automatic login (above).", ...screen }, true));
  if (m.dialogs.length) {
    const d = m.dialogs[0];
    out.push(item("mac.dialogs", "mac", "Questions on the Mac's screen", "user", `${m.dialogs.length === 1 ? "A question from macOS waits" : `${m.dialogs.length} questions from macOS wait`} on the Mac's screen: ${clean(d.app, 80)} wants ${clean(d.wants, 80)}.`, { text: "Only someone at the Mac can answer. From the phone, the program asking can be stopped instead.", ...screen }));
  }
  return out;
}

function machinesItem(f: SetupFacts): SetupItem {
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null) => item("machines", "machines", "Linked machines", state, detail, fix, true);
  const screen = { screen: "Settings → Machines", target: "machines" };
  if (!f.machines) return mk("unknown", "Couldn't read the linked machines.");
  const links = f.machines.filter((m) => m.agents !== "removing");
  if (!links.length) return mk("user", "None linked. Link a Linux box or another Mac, and one app reaches both.", { text: "Settings → Machines → Link a machine, or Set up a Linux machine.", ...screen });
  for (const m of links) {
    const name = clean(m.name, 40);
    const v = f.machineVersions[m.id];
    if (m.agents === "needs-update" || (v && newerThan(f.hub.version, v)))
      return mk("user", `${name} runs an older Crosstalk${v ? ` (${clean(v, 20)})` : ""}.`, { text: `Update Crosstalk on ${name}. For a Linux machine, Settings → Machines → Set up a Linux machine gives the command that installs this version there.`, ...screen });
    if (m.agents === "signed-out") return mk("user", `${name} no longer accepts this machine's sign-in.`, { text: "Link it again in Settings → Machines.", ...screen });
    if (m.agents === "failed" || m.error) return mk("user", `Couldn't reach ${name}${m.error ? `: ${clean(m.error, 160)}` : ""}.`, { text: `Check that ${name} is on and on your tailnet, then Connect it in Settings → Machines.`, ...screen });
  }
  return mk("done", `Linked: ${names(links.map((m) => clean(m.name, 40)))}.`);
}

function poolItem(f: SetupFacts): SetupItem | null {
  const p = f.pool;
  if (!p?.configured) return null;
  const screen = { screen: "Settings → Model pool", target: "model-pool" };
  const name = clean(p.alias, 60) || "The pool's model";
  const mk = (state: SetupState, detail: string, fix: SetupFix | null = null, optional = false) => item("pool", "pool", "Model pool", state, detail, fix, optional);
  if (p.state === "running") return mk("done", `${name} runs on ${p.machines} machine${p.machines === 1 ? "" : "s"}.`);
  if (p.state === "error") return mk("missing", p.detail ? clean(p.detail, 300) : "It stopped with an error.", { text: "Fix what it says, then press Start in Settings → Model pool.", ...screen });
  if (p.state === "off") return mk("missing", "Set up, but not running.", { text: "Start it in Settings → Model pool.", ...screen }, true);
  return mk("unknown", `${p.state[0].toUpperCase()}${p.state.slice(1)}${p.detail ? `: ${clean(p.detail, 200)}` : ""}. Check again in a minute.`);
}

// ---- words ----

/** Text from elsewhere (names, errors, log-derived words) as one plain line: no control or direction characters, capped. */
export function clean(s: unknown, max = 200): string {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** "iPhone, iPad and 2 more". */
function names(list: string[]): string {
  const shown = list.slice(0, 3);
  const more = list.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 2) return "just now";
  if (min < 90) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "2027-04-01". */
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A word for a shell, quoted when it needs to be. */
export function sh(s: string): string {
  return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
