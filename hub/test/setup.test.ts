// The setup checklist (hub/src/setup/checklist.ts): each item's state from fake facts, what the fixes say, the guide's
// sections, the log's redaction, and the check that /setup.md is only for requests made on this machine.
import { describe, expect, test } from "bun:test";
import type { AgentAccount, MacStatus, MachineInfo, Provider, ProviderStatus, SetupChecklist } from "@crosstalk/shared";
import { INSTALL_LINES, SETUP_ITEM_IDS, SETUP_PROMPT, clean, newerThan, pairingUrl, setupChecklist, sh, type SetupFacts } from "../src/setup/checklist";
import { SETUP_GUIDE, directLocal, guideSection } from "../src/setup";
import { parseServeStatus, parseTailscaleStatus, redactLog } from "../src/setup/system";
import { claudeProvider } from "../src/providers/claude";
import { codexProvider } from "../src/providers/codex";
import { geminiProvider } from "../src/providers/gemini";
import { antigravityProvider } from "../src/providers/antigravity";
import { museProvider } from "../src/providers/muse";
import { opencodeProvider } from "../src/providers/opencode";
import { buildTarget, type BrowserOsFacts } from "../src/browseros";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const HOUR = 3600_000;

const status = (provider: Provider, over: Partial<ProviderStatus> = {}): ProviderStatus => ({ provider, installed: true, version: "2.1.0", binPath: `/opt/homebrew/bin/${provider}`, signedIn: true, account: "person@example.com", plan: "Max", authMethod: null, error: null, checkedAt: NOW, ...over });
const MAC: MacStatus = { fullDiskAccess: true, autoLogin: "me", fileVault: false, sleepMinutes: 0, restartsAfterPowerCut: true, wakesForNetwork: true, autoUpdates: true, dialogs: [], checkedAt: NOW };

/** A Mac hub with everything set up; each test changes one thing. */
function facts(over: Partial<SetupFacts> = {}, hub: Partial<SetupFacts["hub"]> = {}): SetupFacts {
  return {
    now: NOW,
    hub: { running: true, version: "0.4.1", name: "Mac mini", platform: "darwin", arch: "arm64", port: 7420, publicUrl: "https://mini.tail1.ts.net", publicUrlFrom: "env", binary: "/Users/me/.local/bin/crosstalk-hub", home: "/Users/me/.crosstalk", defaultHome: true, user: "me", ...hub },
    offline: null,
    service: { runningUnder: "launchd", label: "com.crosstalk.hub", file: "/Users/me/Library/LaunchAgents/com.crosstalk.hub.plist", fileExists: true },
    staged: null,
    idleRestart: "/Users/me/.crosstalk/bin/restart-when-idle.sh",
    tailscale: { cli: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", tried: ["cli"], from: "cli", state: "Running", dnsName: "mini.tail1.ts.net", certs: true, keyExpiry: null, serve: { target: "http://127.0.0.1:7420", funnel: false } },
    https: { answers: true, crosstalk: true, version: "0.4.1" },
    devices: [{ name: "iPhone", platform: "iPhone" }],
    push: { devices: 1, apple: 1, lastOkAt: NOW - 3 * HOUR },
    providers: [status("claude"), status("codex", { plan: "ChatGPT Plus" })],
    accounts: [],
    localServers: [],
    mac: MAC,
    machines: [],
    machineVersions: {},
    pool: null,
    ...over,
  };
}

const get = (c: SetupChecklist, id: string) => {
  const i = c.items.find((x) => x.id === id);
  if (!i) throw new Error(`no item ${id} in ${c.items.map((x) => x.id).join(", ")}`);
  return i;
};
const itemOf = (f: SetupFacts, id: string) => get(setupChecklist(f), id);
const linux = (over: Partial<SetupFacts> = {}, hub: Partial<SetupFacts["hub"]> = {}) =>
  facts({ mac: undefined, service: { runningUnder: "systemd", label: "crosstalk-hub.service", file: "/home/me/.config/systemd/user/crosstalk-hub.service", fileExists: true, linger: true }, tailscale: { cli: "tailscale", tried: ["cli"], from: "cli", state: "Running", dnsName: "box.tail1.ts.net", certs: true, keyExpiry: null, serve: { target: "http://127.0.0.1:7420", funnel: false } }, ...over }, { platform: "linux", arch: "x64", publicUrl: "https://box.tail1.ts.net", ...hub });
const machine = (over: Partial<MachineInfo> = {}): MachineInfo => ({ id: "h_box", name: "Linux box", url: "https://box.tail1.ts.net", addedAt: NOW, scope: "full", agents: "one-way", error: null, ...over });
const account = (over: Partial<AgentAccount>): AgentAccount => ({ provider: "codex", id: "a1", label: "Ollama", kind: "endpoint", signedIn: true, account: "http://127.0.0.1:11434", plan: "Custom model", authMethod: "endpoint", error: null, checkedAt: NOW, ...over });

/**
 * BrowserOS neo as the hub read it: installed, up to date, answering, and Claude Code pointed at it. Each test below
 * changes one thing. The versions are the real ones from 2026-10-23, so the words are the words a person would see.
 */
function browserOs(over: Partial<BrowserOsFacts> = {}): BrowserOsFacts {
  return {
    installed: { path: "/Applications/BrowserOS neo.app", version: "0.51.2.3", bundleId: "com.browseros.BrowserClaw", kind: "dmg", running: false },
    target: buildTarget("darwin", "arm64"),
    newest: { tag: "browserclaw/v0.51.2.3", version: "0.51.2.3", kind: "dmg", publishedAt: NOW - 7 * 24 * HOUR, asset: { name: "BrowserOS_neo_v0.51.2.3_arm64.dmg", url: "https://github.com/x.dmg", size: 165_186_976, sha256: "71de41267c6a9bd991c2d560125304082aa32a45a86f572fd819ce6e521e8a56" } },
    releases: { ok: true },
    mcp: { url: "http://127.0.0.1:9010/mcp", port: 9010, from: "proxy", serverName: "browseros-neo", serverVersion: "0.0.80" },
    links: [{ agent: "claude", name: "browseros-neo", url: "http://127.0.0.1:9010/mcp" }],
    agents: ["claude"],
    ...over,
  };
}

test("everything set up: every required item is done, in the documented order, with the connect commands", () => {
  const c = setupChecklist(facts());
  expect(c.schema).toBe(1);
  expect(c.items.map((i) => i.id)).toEqual(["service", "version", "tailscale", "https", "public-url", "devices", "push", "agent.claude", "agent.codex", "services", "mac.autologin", "mac.power", "mac.full-disk", "mac.updates", "machines"]);
  expect(c.summary).toEqual({ total: 11, done: 11, missing: 0, user: 0, unknown: 0 });
  for (const i of c.items.filter((x) => !x.optional)) expect([i.id, i.state, i.fix]).toEqual([i.id, "done", null]);
  expect(c.hub).toMatchObject({ running: true, version: "0.4.1", name: "Mac mini", url: "https://mini.tail1.ts.net", localUrl: "http://127.0.0.1:7420", service: "launchd", update: null });
  expect(c.connect).toEqual({
    claude: "claude mcp add --scope user crosstalk-setup -- /Users/me/.local/bin/crosstalk-hub setup-mcp",
    codex: "codex mcp add crosstalk-setup -- /Users/me/.local/bin/crosstalk-hub setup-mcp",
    gemini: "gemini mcp add --scope user crosstalk-setup /Users/me/.local/bin/crosstalk-hub setup-mcp",
    cli: "/Users/me/.local/bin/crosstalk-hub setup --json",
    guide: "http://127.0.0.1:7420/setup.md",
    prompt: SETUP_PROMPT,
    // BrowserOS neo wasn't checked on this hub, so there is no address to hand an agent and nothing is claimed.
    browseros: null,
  });
  expect(SETUP_PROMPT).toBe("Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password.");
});

test("a hub with its data elsewhere passes CROSSTALK_HOME on to each agent's MCP server, the way each CLI takes it", () => {
  const c = setupChecklist(facts({}, { home: "/tmp/ct test", defaultHome: false }));
  expect(c.connect.claude).toBe("claude mcp add --scope user crosstalk-setup -e CROSSTALK_HOME='/tmp/ct test' -- /Users/me/.local/bin/crosstalk-hub setup-mcp");
  expect(c.connect.codex).toBe("codex mcp add crosstalk-setup --env CROSSTALK_HOME='/tmp/ct test' -- /Users/me/.local/bin/crosstalk-hub setup-mcp");
  expect(c.connect.gemini.endsWith("setup-mcp -e CROSSTALK_HOME='/tmp/ct test'")).toBe(true);
});

test("the hub's own commands name a data folder other than ~/.crosstalk: without it they'd look there, and pair would make a code nobody knows", () => {
  const elsewhere = setupChecklist(facts({ devices: [] }, { home: "/Volumes/Data/crosstalk", defaultHome: false }));
  expect(elsewhere.connect.cli).toBe("CROSSTALK_HOME=/Volumes/Data/crosstalk /Users/me/.local/bin/crosstalk-hub setup --json");
  expect(get(elsewhere, "devices").fix?.command).toBe("CROSSTALK_HOME=/Volumes/Data/crosstalk /Users/me/.local/bin/crosstalk-hub pair 15");
  expect(setupChecklist(facts({ devices: [] }, { home: "/tmp/ct test", defaultHome: false })).connect.cli).toBe("CROSSTALK_HOME='/tmp/ct test' /Users/me/.local/bin/crosstalk-hub setup --json");
  // The usual folder needs no name.
  const usual = setupChecklist(facts({ devices: [] }));
  expect(usual.connect.cli).toBe("/Users/me/.local/bin/crosstalk-hub setup --json");
  expect(get(usual, "devices").fix?.command).toBe("/Users/me/.local/bin/crosstalk-hub pair 15");
});

test("the summary counts required items only, by state", () => {
  const c = setupChecklist(facts({ devices: [], push: { devices: 0, apple: 0, lastOkAt: null }, staged: "0.4.2", tailscale: undefined, https: undefined }));
  // version: missing; devices: user; tailscale, https, public-url and push (pair first): unknown.
  expect(c.summary).toEqual({ total: 11, done: 5, missing: 1, user: 1, unknown: 4 });
  expect(c.summary.done + c.summary.missing + c.summary.user + c.summary.unknown).toBe(c.summary.total);
  expect(c.hub.update).toEqual({ version: "0.4.2", source: "staged" });
});

describe("service", () => {
  test("under launchd with its plist: done; the plist gone: missing, with the installer, run outside Crosstalk", () => {
    expect(itemOf(facts(), "service")).toMatchObject({ state: "done", detail: expect.stringContaining("LaunchAgent (com.crosstalk.hub)") });
    const gone = itemOf(facts({ service: { runningUnder: "launchd", label: "com.crosstalk.hub", file: "/x.plist", fileExists: false } }), "service");
    expect(gone.state).toBe("missing");
    expect(gone.fix).toMatchObject({ command: "./install-macos.sh", password: true });
    // It unloads the LaunchAgent that runs Crosstalk now: in Crosstalk's terminal it would end with it, halfway.
    expect(gone.fix?.text).toContain("Run it in Terminal on the Mac, not in a Crosstalk chat or Crosstalk's terminal");
  });
  test("started by hand: missing, with the installer, or with starting the service that's installed", () => {
    const byHand = itemOf(facts({ service: { runningUnder: "none", label: "com.crosstalk.hub", file: "/x.plist", fileExists: false } }), "service");
    expect(byHand).toMatchObject({ state: "missing", detail: expect.stringContaining("started by hand") });
    expect(byHand.fix?.command).toBe("./install-macos.sh");
    // Nothing of launchd's runs it to unload.
    expect(byHand.fix?.text).not.toContain("Crosstalk's terminal");
    const installed = itemOf(facts({ service: { runningUnder: "none", label: "com.crosstalk.hub", file: "/x.plist", fileExists: true } }), "service");
    expect(installed.fix?.command).toBe("launchctl kickstart gui/$(id -u)/com.crosstalk.hub");
    // Never -k: that would stop the copy that runs.
    expect(installed.fix?.command).not.toContain("-k");
  });
  test("systemd with linger off needs the person's password; with it on, done", () => {
    expect(itemOf(linux(), "service").state).toBe("done");
    const off = itemOf(linux({ service: { runningUnder: "systemd", label: "crosstalk-hub.service", file: "/u", fileExists: true, linger: false } }), "service");
    expect(off).toMatchObject({ state: "user", fix: { command: "sudo loginctl enable-linger me", password: true } });
  });
  test("not known: unknown", () => {
    expect(itemOf(facts({ service: null }), "service").state).toBe("unknown");
  });
});

describe("the CLI's checklist when the hub doesn't answer", () => {
  const offline = (service: SetupFacts["service"], code: "stopped" | "blocked" | "older" | "key" = "stopped", version?: string, over: Partial<SetupFacts> = {}) =>
    setupChecklist(facts({ offline: { code, version }, service, tailscale: undefined, devices: null, push: null, providers: null, accounts: null, mac: undefined, machines: null, ...over }, { running: code === "older" }));
  const svc = (over: Partial<NonNullable<SetupFacts["service"]>>) => ({ runningUnder: null, label: "com.crosstalk.hub", file: "/Users/me/Library/LaunchAgents/com.crosstalk.hub.plist", fileExists: true, loaded: true, active: false, ...over });

  test("no service: install it; not loaded: bootstrap it; loaded but not running: read the log, then start it", () => {
    expect(get(offline(svc({ fileExists: false })), "service").fix?.command).toBe("./install-macos.sh");
    expect(get(offline(svc({ loaded: false })), "service").fix?.command).toBe("launchctl bootstrap gui/$(id -u) /Users/me/Library/LaunchAgents/com.crosstalk.hub.plist");
    const down = get(offline(svc({})), "service");
    expect(down.fix).toMatchObject({ command: "launchctl kickstart gui/$(id -u)/com.crosstalk.hub", text: expect.stringContaining("~/Library/Logs/Crosstalk/hub.log") });
  });
  test("every other item waits for a hub that answers, with the ids it has when it does", () => {
    const c = offline(svc({ fileExists: false }));
    expect(c.hub.running).toBe(false);
    expect(c.items.map((i) => i.id)).toEqual(["service", "version", "tailscale", "https", "public-url", "devices", "push", "agent.claude", "agent.codex"]);
    for (const i of c.items.slice(1)) expect([i.id, i.state, i.detail]).toEqual([i.id, "unknown", i.id === "version" ? "Crosstalk 0.4.1 is installed." : "Start Crosstalk first, then check again."]);
  });
  test("nothing in the way names both ways tried, and never sends the caller back to the tools it is", () => {
    const tried: NonNullable<SetupFacts["offline"]>["tried"] = [
      { via: "socket", address: "/Users/me/.crosstalk/run/hub.sock", why: "it refused the connection" },
      { via: "local", address: "http://127.0.0.1:7420", why: "nothing answered" },
    ];
    // The command says it: run it again outside the sandbox.
    const cli = offline(svc({ active: true }), "blocked", undefined, { asker: "cli", offline: { code: "blocked", tried } });
    expect(get(cli, "service")).toMatchObject({
      state: "unknown",
      detail: "Crosstalk runs as a service, but nothing here could ask it: its socket (it refused the connection) and http://127.0.0.1:7420 (nothing answered).",
      fix: { text: "Run it again in a terminal on this machine, outside the agent's sandbox:", command: "/Users/me/.local/bin/crosstalk-hub setup" },
    });
    expect(get(cli, "devices").detail).toBe("Crosstalk can't be reached from here: its socket (it refused the connection) and http://127.0.0.1:7420 (nothing answered). Run this again in a terminal on this machine, outside the agent's sandbox.");
    // The setup tools say it: only the person can get past this. Never "use the setup tools": they are the caller.
    const mcp = offline(svc({ active: true }), "blocked", undefined, { asker: "mcp", offline: { code: "blocked", tried } });
    expect(get(mcp, "service").fix).toMatchObject({ text: expect.stringContaining("only the person can see why"), command: "/Users/me/.local/bin/crosstalk-hub setup" });
    expect(get(mcp, "devices").detail).toBe("Crosstalk can't be reached from here: its socket (it refused the connection) and http://127.0.0.1:7420 (nothing answered). Ask the person to run /Users/me/.local/bin/crosstalk-hub setup in a terminal on this machine.");
    for (const c of [cli, mcp]) expect(JSON.stringify(c.items)).not.toMatch(/crosstalk-setup|MCP|setup tools/i);
    // A data folder of its own goes into the command the person is handed.
    const elsewhere = setupChecklist(facts({ offline: { code: "blocked", tried }, asker: "mcp", service: svc({ active: true }), tailscale: undefined, devices: null, push: null, providers: null, accounts: null, mac: undefined, machines: null }, { running: false, home: "/Users/me/hub-data", defaultHome: false }));
    expect(get(elsewhere, "service").fix?.command).toBe("CROSSTALK_HOME=/Users/me/hub-data /Users/me/.local/bin/crosstalk-hub setup");
    // Nothing tried (the key couldn't even be read): still no made-up cause.
    expect(get(offline(svc({ active: true }), "blocked"), "devices").detail).toBe("Crosstalk can't be reached from here: neither its socket nor its address on this machine answered. Run this again in a terminal on this machine, outside the agent's sandbox.");
    // The hub answered at its own address but its build has no setup API there: that is what the words say, and no
    // build is claimed to be waiting (a missing route says nothing about the program at the hub's path).
    const noApi = setupChecklist(
      facts(
        {
          offline: { code: "blocked", version: "0.4.1", answered: true, tried: [tried![0], { via: "local", address: "http://127.0.0.1:7420", why: "it answers, but the build it runs has no setup API there" }] },
          asker: "mcp",
          service: svc({ active: true }),
          tailscale: undefined,
          devices: null,
          push: null,
          providers: null,
          accounts: null,
          mac: undefined,
          machines: null,
        },
        { running: true },
      ),
    );
    expect(noApi.hub.update).toBe(null);
    expect(get(noApi, "version")).toMatchObject({ state: "unknown", detail: "Crosstalk 0.4.1 is installed.", fix: null });
    expect(get(noApi, "service").detail).toBe("Crosstalk runs as a service, but nothing here could ask it: its socket (it refused the connection) and http://127.0.0.1:7420 (it answers, but the build it runs has no setup API there).");
    expect(JSON.stringify(noApi.items)).not.toMatch(/waits for a restart|starts at its next restart|kickstart/);
  });
  test("an older hub runs: it gets the new build at its next restart, through the idle watcher", () => {
    const c = offline(svc({ active: true }), "older", "0.4.0");
    expect(c.hub).toMatchObject({ running: true, version: "0.4.0", update: { version: "0.4.1", source: "staged" } });
    expect(get(c, "service").state).toBe("done");
    expect(get(c, "version")).toMatchObject({ state: "missing", detail: "Crosstalk 0.4.0 runs. 0.4.1 is installed and starts at its next restart." });
    expect(get(c, "version").fix?.command).toBe("nohup /Users/me/.crosstalk/bin/restart-when-idle.sh >> ~/Library/Logs/Crosstalk/restart-when-idle.log 2>&1 &");
    expect(get(c, "https").detail).toContain("restarted with the newer build");
  });
});

describe("version", () => {
  test("a staged build waits for an idle restart; without the idle watcher, the person is asked first", () => {
    const staged = itemOf(facts({ staged: "0.4.2" }), "version");
    expect(staged).toMatchObject({ state: "missing", detail: "Crosstalk 0.4.2 is installed and waits for a restart (0.4.1 runs now)." });
    expect(staged.fix?.text).toContain("pgrep -f restart-when-idle");
    const bare = itemOf(facts({ staged: "0.4.2", idleRestart: null }), "version");
    expect(bare.fix).toMatchObject({ command: "launchctl kickstart -k gui/$(id -u)/com.crosstalk.hub", text: expect.stringContaining("ask the person first") });
    expect(itemOf(linux({ staged: "0.4.2", idleRestart: null }), "version").fix?.command).toBe("systemctl --user restart crosstalk-hub");
    expect(itemOf(facts({ staged: "0.4.1" }), "version").detail).toBe("A new build of 0.4.1 is installed and waits for a restart.");
  });
  test("a linked machine on a newer version: the person updates this one", () => {
    const c = setupChecklist(facts({ machines: [machine()], machineVersions: { h_box: "0.4.10" } }));
    expect(get(c, "version")).toMatchObject({ state: "user", detail: "Linux box runs Crosstalk 0.4.10, newer than this one (0.4.1)." });
    expect(c.hub.update).toEqual({ version: "0.4.10", source: "machine", machine: "Linux box" });
    expect(itemOf(facts({ machines: [machine()], machineVersions: { h_box: "0.4.1" } }), "version").detail).toBe("Crosstalk 0.4.1. No newer build is waiting here or on your other machines.");
  });
  test("versions compare as numbers", () => {
    expect(newerThan("0.4.10", "0.4.9")).toBe(true);
    expect(newerThan("0.4.1", "0.4.1")).toBe(false);
    expect(newerThan("0.5.0", "0.4.12")).toBe(true);
    expect(newerThan("0.3.9", "0.4.0")).toBe(false);
  });
});

describe("network", () => {
  test("Tailscale not installed, signed out, or signing the machine out soon: the person's", () => {
    const none = itemOf(facts({ tailscale: null }), "tailscale");
    expect(none).toMatchObject({ state: "user", fix: { url: "https://tailscale.com/download", password: true } });
    expect(none.fix?.command).toBeUndefined();
    expect(itemOf(linux({ tailscale: null }), "tailscale").fix?.command).toBe("curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up");
    const ts = facts().tailscale!;
    expect(itemOf(facts({ tailscale: { ...ts, state: "NeedsLogin" } }), "tailscale")).toMatchObject({ state: "user", detail: expect.stringContaining("signed out") });
    const expiring = itemOf(facts({ tailscale: { ...ts, keyExpiry: Date.parse("2027-04-01T12:00:00Z") } }), "tailscale");
    expect(expiring).toMatchObject({ state: "user", detail: expect.stringContaining("2027-04-01"), fix: { url: "https://login.tailscale.com/admin/machines" } });
    expect(itemOf(facts({ tailscale: undefined }), "tailscale").state).toBe("unknown");
    expect(itemOf(facts(), "tailscale").detail).toBe("On your tailnet as mini.tail1.ts.net.");
  });
  test("https: certificates off is the person's; serve off, elsewhere or on Funnel is for an agent, with the exact command", () => {
    const ts = facts().tailscale!;
    const serveCmd = "/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:7420";
    expect(itemOf(facts({ tailscale: { ...ts, certs: false } }), "https")).toMatchObject({ state: "user", fix: { url: "https://login.tailscale.com/admin/dns" } });
    expect(itemOf(facts({ tailscale: { ...ts, serve: { target: null, funnel: false } } }), "https")).toMatchObject({ state: "missing", detail: expect.stringContaining("serve is off"), fix: { command: serveCmd } });
    const elsewhere = itemOf(facts({ tailscale: { ...ts, serve: { target: "http://127.0.0.1:3000", funnel: false } } }), "https");
    expect(elsewhere).toMatchObject({ state: "missing", detail: expect.stringContaining("http://127.0.0.1:3000"), fix: { command: serveCmd } });
    const funnel = itemOf(facts({ tailscale: { ...ts, serve: { target: "http://127.0.0.1:7420", funnel: true } } }), "https");
    expect(funnel).toMatchObject({ state: "missing", detail: expect.stringContaining("public internet") });
    expect(funnel.fix?.command).toBe(`/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=443 off && ${serveCmd}`);
    expect(itemOf(facts({ tailscale: { ...ts, serve: { target: "http://localhost:7420", funnel: false } } }), "https").state).toBe("done");
    expect(itemOf(linux({ tailscale: { ...linux().tailscale!, serve: { target: null, funnel: false } } }), "https").fix?.text).toContain("--operator=$USER");
    // Waits for Tailscale: it answered that it's off, so this item has nothing to say and no command that can help.
    expect(itemOf(facts({ tailscale: { ...ts, state: "Stopped" }, https: { answers: false, crosstalk: false, version: null } }), "https")).toMatchObject({ state: "unknown", detail: "Needs Tailscale first (above).", fix: null });
  });
  test("its own address: fixed where it's set now (the service's environment wins over config.json)", () => {
    expect(itemOf(facts(), "public-url").state).toBe("done");
    const unset = itemOf(facts({}, { publicUrl: null, publicUrlFrom: null }), "public-url");
    expect(unset).toMatchObject({ state: "missing", fix: { text: 'Set "publicUrl": "https://mini.tail1.ts.net" in /Users/me/.crosstalk/config.json, then restart Crosstalk when no chat is working (see Version).' } });
    const env = itemOf(facts({}, { publicUrl: "https://old.tail1.ts.net" }), "public-url");
    expect(env.detail).toContain("https://old.tail1.ts.net");
    expect(env.fix?.command).toBe('/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:CROSSTALK_PUBLIC_URL https://mini.tail1.ts.net" /Users/me/Library/LaunchAgents/com.crosstalk.hub.plist && launchctl bootout gui/$(id -u)/com.crosstalk.hub && launchctl bootstrap gui/$(id -u) /Users/me/Library/LaunchAgents/com.crosstalk.hub.plist');
    // bootout ends Crosstalk and all it started: from a chat or its terminal the command dies before bootstrap, and
    // Crosstalk stays off. So it's the person's, in Terminal at the Mac.
    expect(env.state).toBe("user");
    expect(env.fix?.text).toContain("Run it in Terminal on the Mac, not in a Crosstalk chat or Crosstalk's terminal");
    // systemd finishes a restart whoever asked, and config.json is restarted through Version: an agent may do those.
    const unit = itemOf(linux({}, { publicUrl: "https://old.tail1.ts.net" }), "public-url");
    expect(unit).toMatchObject({ state: "missing", fix: { command: expect.stringContaining("Environment=CROSSTALK_PUBLIC_URL=https://box.tail1.ts.net#") } });
    expect(itemOf(facts({}, { publicUrl: "https://old.tail1.ts.net", publicUrlFrom: "config" }), "public-url").state).toBe("missing");
    expect(itemOf(facts({ tailscale: null, https: undefined }), "public-url")).toMatchObject({ state: "unknown", detail: expect.stringContaining("Tailscale isn't up") });
  });
  test("Tailscale didn't answer: it says which ways were tried, and the hub's own https address answers for the group", () => {
    // A fault seen on a Mac: the app's CLI printed its GUI error, so every network item went unknown with it.
    const silent: SetupFacts["tailscale"] = { cli: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", tried: ["cli", "app"], from: null, state: null, dnsName: null, certs: null, keyExpiry: null, serve: null };
    const answers = facts({ tailscale: silent });
    const ts = itemOf(answers, "tailscale");
    expect(ts).toMatchObject({ state: "unknown", fix: null });
    expect(ts.detail).toBe("Tailscale is installed but didn't answer (tried the tailscale command and the Tailscale app's own API). Its https address still reaches Crosstalk, so Tailscale itself is running.");
    const https = itemOf(answers, "https");
    expect(https).toMatchObject({ state: "done", fix: null });
    expect(https.detail).toBe("https://mini.tail1.ts.net answers and reaches this Crosstalk. Tailscale itself couldn't be asked, so whether Funnel also puts it on the public internet isn't known.");
    expect(itemOf(answers, "public-url")).toMatchObject({ state: "done", detail: expect.stringContaining("this hub answers there") });
    // Only one way in on a Linux hub, and nothing answering there: then there is something to do.
    const quiet = linux({ tailscale: { ...silent, cli: "tailscale", tried: ["cli"] }, https: { answers: false, crosstalk: false, version: null } });
    expect(itemOf(quiet, "tailscale")).toMatchObject({ state: "unknown", detail: "Tailscale is installed but didn't answer (tried the tailscale command).", fix: { command: "tailscale status" } });
    expect(itemOf(quiet, "https")).toMatchObject({ state: "missing", detail: expect.stringContaining("Nothing answers at https://box.tail1.ts.net"), fix: { command: "tailscale serve --bg --https=443 http://127.0.0.1:7420" } });
    expect(itemOf(quiet, "public-url")).toMatchObject({ state: "unknown", detail: expect.stringContaining("nothing answers there") });
    // No Tailscale at all: the item waits for it rather than naming a serve command that isn't installed.
    expect(itemOf(facts({ tailscale: null, https: { answers: false, crosstalk: false, version: null } }), "https")).toMatchObject({ state: "unknown", detail: "Needs Tailscale first (above)." });
    // Something answers there, but not this Crosstalk: another hub's version, or not Crosstalk at all.
    for (const h of [{ answers: true, crosstalk: false, version: null }, { answers: true, crosstalk: true, version: "0.3.9" }]) {
      expect([h, itemOf(facts({ tailscale: silent, https: h }), "https").state]).toEqual([h, "missing"]);
      expect(itemOf(facts({ tailscale: silent, https: h }), "https").detail).toContain("Something other than this Crosstalk answers");
    }
  });
  test("Tailscale answered that it's off or signed out: no item says it couldn't be asked, or offers a serve command", () => {
    // It said what's wrong itself, so the network items wait for it. Standing in for a Tailscale that *answered* would
    // tell the person a falsehood, hand them a command that can do nothing until tailscaled is back, and count the one
    // problem twice in the summary.
    const ts = facts().tailscale!;
    for (const state of ["Stopped", "NeedsLogin"]) {
      const off = facts({ tailscale: { ...ts, state }, https: { answers: false, crosstalk: false, version: null } });
      const https = itemOf(off, "https");
      expect([state, https.state, https.detail, https.fix]).toEqual([state, "unknown", "Needs Tailscale first (above).", null]);
      const url = itemOf(off, "public-url");
      expect([state, url.state, url.detail]).toEqual([state, "unknown", "Set to https://mini.tail1.ts.net; Tailscale isn't up to check it, and nothing answers there."]);
      expect(setupChecklist(off).summary.missing).toBe(0);
      // Nor when its own address does answer (the probe only ever asks an address this machine has, setup/system.ts).
      expect(itemOf(facts({ tailscale: { ...ts, state } }), "https").detail).toBe("Needs Tailscale first (above).");
      expect(itemOf(facts({ tailscale: { ...ts, state } }), "public-url").state).toBe("unknown");
    }
  });
  test("Tailscale answered but its serve configuration couldn't be read: the words name that gap, not Tailscale", () => {
    const ts = facts().tailscale!;
    const unread = itemOf(facts({ tailscale: { ...ts, serve: null } }), "https");
    expect(unread).toMatchObject({ state: "done", fix: null });
    expect(unread.detail).toBe("https://mini.tail1.ts.net answers and reaches this Crosstalk. Where tailscale serve sends https couldn't be read, so whether Funnel is also on isn't known.");
    // Nothing answering there: publishing the address is the thing to do, with the line that makes serve status work.
    const nothing = itemOf(linux({ tailscale: { ...linux().tailscale!, serve: null }, https: { answers: false, crosstalk: false, version: null } }), "https");
    expect(nothing).toMatchObject({ state: "missing", detail: "Nothing answers at https://box.tail1.ts.net, and where tailscale serve sends https couldn't be read.", fix: { command: "tailscale serve --bg --https=443 http://127.0.0.1:7420" } });
    expect(nothing.fix?.text).toContain("--operator=$USER");
    // Its own address not asked either: then the item says only what it couldn't ask.
    expect(itemOf(facts({ tailscale: { ...ts, serve: null }, https: undefined }), "https")).toMatchObject({ state: "unknown", detail: "Couldn't ask where tailscale serve sends https." });
  });
  test("where only the Tailscale app's own API answers, the fixes still name a command to run", () => {
    const viaApp = facts({ tailscale: { ...facts().tailscale!, cli: null, tried: ["app"], from: "app", serve: { target: null, funnel: false } } });
    expect(itemOf(viaApp, "https")).toMatchObject({ state: "missing", fix: { command: "tailscale serve --bg --https=443 http://127.0.0.1:7420" } });
  });
});

describe("devices and notifications", () => {
  test("no device: the person types a code an agent makes, at the hub's address", () => {
    const none = itemOf(facts({ devices: [] }), "devices");
    expect(none).toMatchObject({ state: "user", fix: { command: "/Users/me/.local/bin/crosstalk-hub pair 15", screen: "Settings → Devices → Pair a new device", target: "devices" } });
    expect(none.fix?.text).toContain("pair_code");
    expect(none.fix?.text).toContain("https://mini.tail1.ts.net");
    const many = itemOf(facts({ devices: ["iPhone\u202e", "iPad", "MacBook", "Pixel"].map((name) => ({ name, platform: "" })) }), "devices");
    expect(many).toMatchObject({ state: "done", detail: "4 paired: iPhone, iPad, MacBook and 1 more." });
  });
  test("the address to pair at is one a phone can open: never 127.0.0.1, never a name Tailscale no longer gives", () => {
    const ts = facts().tailscale!;
    const text = (over: Partial<SetupFacts>, hub: Partial<SetupFacts["hub"]> = {}) => itemOf(facts({ devices: [], ...over }, hub), "devices").fix!.text;
    // Installed before Tailscale: no address of its own, but serve already sends this machine's name to Crosstalk.
    expect(text({}, { publicUrl: null, publicUrlFrom: null })).toContain("open https://mini.tail1.ts.net on the phone");
    // An old name (the machine was renamed): the one Tailscale gives now.
    expect(text({}, { publicUrl: "https://old.tail1.ts.net" })).toContain("open https://mini.tail1.ts.net on the phone");
    // https doesn't reach Crosstalk yet: the network items come first, and the local address is no use on a phone.
    for (const serve of [{ target: null, funnel: false }, { target: "http://127.0.0.1:3000", funnel: false }]) {
      const none = text({ tailscale: { ...ts, serve } }, { publicUrl: null, publicUrlFrom: null });
      expect(none).toContain("A phone can't open http://127.0.0.1:7420 (that only works on this machine), so first set up Tailscale and the HTTPS address (above).");
      expect(none).not.toContain("open http://127.0.0.1:7420 on the phone");
    }
    expect(text({ tailscale: { ...ts, certs: false } })).toContain("first set up Tailscale");
  });
  test("pairingUrl: this machine's https name once serve sends it to Crosstalk, else the hub's own https address while Tailscale can't tell", () => {
    const ts = facts().tailscale!;
    const at = (publicUrl: string | null, tailscale: SetupFacts["tailscale"]) => pairingUrl({ hub: { publicUrl, port: 7420 }, tailscale });
    expect(at(null, ts)).toBe("https://mini.tail1.ts.net");
    expect(at("https://old.tail1.ts.net/", ts)).toBe("https://mini.tail1.ts.net");
    expect(at("https://mini.tail1.ts.net", { ...ts, serve: { target: null, funnel: false } })).toBeNull();
    expect(at("https://mini.tail1.ts.net", { ...ts, certs: false })).toBeNull();
    // serve couldn't be asked: the hub's own address when it's this machine's name, else none.
    expect(at("https://mini.tail1.ts.net/", { ...ts, serve: null })).toBe("https://mini.tail1.ts.net");
    expect(at("https://old.tail1.ts.net", { ...ts, serve: null })).toBeNull();
    // Tailscale not checked, not installed or down: the hub's own address, if it's an https one.
    expect(at("https://crosstalk.example.com", undefined)).toBe("https://crosstalk.example.com");
    expect(at("https://mini.tail1.ts.net", null)).toBe("https://mini.tail1.ts.net");
    expect(at("https://mini.tail1.ts.net", { ...ts, state: "Stopped" })).toBe("https://mini.tail1.ts.net");
    expect(at("http://127.0.0.1:7420", undefined)).toBeNull();
    expect(at(null, undefined)).toBeNull();
  });
  test("notifications: none on is the person's; iPhones without the https address are not", () => {
    const off = itemOf(facts({ push: { devices: 0, apple: 0, lastOkAt: null } }), "push");
    expect(off).toMatchObject({ state: "user", fix: { screen: "Settings → Devices", target: "devices" } });
    expect(off.fix?.text).toContain("Add to Home Screen");
    expect(itemOf(facts({ push: { devices: 0, apple: 0, lastOkAt: null } }, { publicUrl: null }), "push").detail).toContain("https address first");
    expect(itemOf(facts({}, { publicUrl: null }), "push")).toMatchObject({ state: "missing", detail: expect.stringContaining("iPhones") });
    expect(itemOf(facts(), "push").detail).toBe("On for 1 device; the last one was delivered 3 hours ago.");
    expect(itemOf(facts({ devices: [] }), "push").state).toBe("unknown");
  });
});

describe("agents", () => {
  test("installed agents are needed; with none installed, Claude Code and Codex both are", () => {
    const one = setupChecklist(facts({ providers: [status("claude"), status("codex", { installed: false, version: null, binPath: null, signedIn: null })] }));
    expect(get(one, "agent.codex")).toMatchObject({ state: "missing", optional: true, fix: { command: INSTALL_LINES.codex, screen: "Settings → AI services → Codex", target: "agent-codex" } });
    const none = setupChecklist(facts({ providers: (["claude", "codex", "gemini", "antigravity", "muse"] as Provider[]).map((p) => status(p, { installed: false, version: null, binPath: null, signedIn: null })) }));
    expect(none.items.filter((i) => i.group === "agents").map((i) => [i.id, i.state, i.optional])).toEqual([
      ["agent.claude", "missing", false],
      ["agent.codex", "missing", false],
    ]);
    expect(get(none, "agent.claude").fix?.command).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  });
  test("Gemini, Antigravity or Muse alone leaves Claude Code and Codex needed: chats run only those two", () => {
    const absent = { installed: false, version: null, binPath: null, signedIn: null };
    for (const other of ["gemini", "antigravity", "muse"] as Provider[]) {
      const c = setupChecklist(facts({ providers: [status("claude", absent), status("codex", absent), status(other)] }));
      expect([other, c.items.filter((i) => i.group === "agents").map((i) => [i.id, i.state, i.optional])]).toEqual([
        other,
        [
          ["agent.claude", "missing", false],
          ["agent.codex", "missing", false],
          [`agent.${other}`, "done", false],
        ],
      ]);
      expect(get(c, "agent.codex").detail).toBe("Codex isn't installed.");
      // So Settings never says everything needed is set up while no chat can start.
      expect(c.summary).toMatchObject({ missing: 2 });
      expect(c.summary.done).toBeLessThan(c.summary.total);
    }
  });
  test("signed out is the person's (from the phone, or at the machine); any signed-in account counts, as in Settings", () => {
    const out = itemOf(facts({ providers: [status("claude", { signedIn: false }), status("codex")] }), "agent.claude");
    expect(out).toMatchObject({ state: "user", detail: "Claude Code 2.1.0 is installed but not signed in.", fix: { command: "/opt/homebrew/bin/claude auth login", password: true, screen: "Settings → AI services → Claude Code → Sign in", target: "agent-claude" } });
    const viaAccount = itemOf(facts({ providers: [status("claude", { signedIn: false }), status("codex")], accounts: [account({ provider: "claude", id: "work", label: "Work", kind: "signin" })] }), "agent.claude");
    expect(viaAccount.state).toBe("done");
    // The plan shows; the account's email never does.
    expect(itemOf(facts(), "agent.codex").detail).toBe("Codex 2.1.0 is signed in (ChatGPT Plus).");
  });
  test("Gemini, Antigravity and Muse show only once installed, with a sign-in at the machine", () => {
    const c = setupChecklist(facts({ providers: [status("claude"), status("codex"), status("gemini", { installed: false }), status("antigravity", { signedIn: false, binPath: "/Users/me/.local/bin/agy" }), status("muse", { installed: false })] }));
    expect(c.items.filter((i) => i.group === "agents").map((i) => i.id)).toEqual(["agent.claude", "agent.codex", "agent.antigravity"]);
    expect(get(c, "agent.antigravity")).toMatchObject({ state: "user", fix: { command: "/Users/me/.local/bin/agy", password: true } });
  });
  test("not checked yet, or a sign-in that couldn't be read: unknown, with how to check again", () => {
    expect(itemOf(facts({ providers: [status("claude", { checkedAt: 0 }), status("codex")] }), "agent.claude")).toMatchObject({ state: "unknown", fix: { text: expect.stringContaining("recheck_agents") } });
    const odd = itemOf(facts({ providers: [status("claude", { signedIn: null, error: "timed out\u001b[31m\nagain" }), status("codex")] }), "agent.claude");
    expect(odd).toMatchObject({ state: "unknown", detail: "Claude Code 2.1.0 is installed; its sign-in couldn't be checked (timed out [31m again)." });
  });
  test("each install line is part of its agent's official installer", () => {
    const modules = { claude: claudeProvider, codex: codexProvider, gemini: geminiProvider, antigravity: antigravityProvider, muse: museProvider, opencode: opencodeProvider };
    for (const [p, line] of Object.entries(INSTALL_LINES)) expect([p, modules[p as keyof typeof modules].installCommand!.join(" ").includes(line)]).toEqual([p, true]);
  });
});

describe("AI services", () => {
  test("optional: none added, a key refused, a server here not used yet, or what was added", () => {
    expect(itemOf(facts(), "services")).toMatchObject({ state: "user", optional: true, fix: { screen: "Settings → AI services", target: "ai-services" } });
    expect(itemOf(facts({ accounts: [account({ kind: "apikey", label: "Work key", signedIn: false })] }), "services")).toMatchObject({ state: "user", detail: "Work key (Codex): its key was refused." });
    const unused = itemOf(facts({ localServers: [{ label: "Ollama (port 11434)", used: false }] }), "services");
    expect(unused.detail).toBe("Ollama (port 11434) runs on this machine and isn't used yet.");
    // The shortest way to use it is the New chat menu, which lists a server found here (web/src/newChat.ts).
    expect(unused.fix?.text).toContain("New chat");
    const added = itemOf(facts({ accounts: [account({}), account({ provider: "claude", id: "a2", kind: "apikey", label: "Work key" })], localServers: [{ label: "Ollama (port 11434)", used: true }] }), "services");
    expect(added).toMatchObject({ state: "done", detail: "2 added: Ollama (Codex) and Work key (Claude Code)." });
    // A server's address isn't repeated.
    expect(added.detail).not.toContain("11434");
  });
});

describe("This Mac", () => {
  test("automatic login off: the fixed command Settings runs, without its terminal wrapper, for the person's password", () => {
    const off = itemOf(facts({ mac: { ...MAC, autoLogin: null } }), "mac.autologin");
    expect(off).toMatchObject({ state: "user", fix: { command: "/usr/bin/sudo /usr/sbin/sysadminctl -autologin set -userName me -password -", password: true, screen: "Settings → This Mac → Turn on automatic login", target: "this-mac" } });
    expect(itemOf(facts({ mac: { ...MAC, autoLogin: null, fileVault: true } }), "mac.autologin")).toMatchObject({ state: "user", detail: expect.stringContaining("FileVault") });
    expect(itemOf(facts({ mac: { ...MAC, autoLogin: null, fileVault: null } }), "mac.autologin").state).toBe("unknown");
  });
  test("sleeping or staying off after a power cut: Keep it on", () => {
    const sleeps = itemOf(facts({ mac: { ...MAC, sleepMinutes: 10, restartsAfterPowerCut: false } }), "mac.power");
    expect(sleeps).toMatchObject({ state: "user", detail: "It sleeps after 10 minutes with nobody using it, and chats stop until it wakes. After a power cut it stays off until someone presses its button.", fix: { command: "/usr/bin/sudo /usr/bin/pmset -a sleep 0 autorestart 1 womp 1", password: true } });
    expect(itemOf(facts(), "mac.power").detail).toBe("It never sleeps and starts up again after a power cut.");
  });
  test("Full Disk Access and updates are optional; dialogs waiting on the screen need the person", () => {
    const fda = itemOf(facts({ mac: { ...MAC, fullDiskAccess: false } }), "mac.full-disk");
    expect(fda).toMatchObject({ state: "user", optional: true, fix: { command: "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'" } });
    expect(itemOf(facts({ mac: { ...MAC, autoLogin: null } }), "mac.updates")).toMatchObject({ state: "user", optional: true });
    expect(itemOf(facts({ mac: { ...MAC, autoUpdates: false } }), "mac.updates").state).toBe("done");
    const waiting = setupChecklist(facts({ mac: { ...MAC, dialogs: [{ id: "d1", app: "adb (started by Crosstalk)‮", wants: "files on external drives", since: NOW, count: 2 }] } }));
    expect(get(waiting, "mac.dialogs")).toMatchObject({ state: "user", optional: false, detail: "A question from macOS waits on the Mac's screen: adb (started by Crosstalk) wants files on external drives." });
    expect(waiting.summary.user).toBe(1);
  });
  test("not a Mac: no Mac items; a Mac that couldn't be read: unknown ones", () => {
    expect(setupChecklist(linux()).items.some((i) => i.group === "mac")).toBe(false);
    expect(setupChecklist(facts({ mac: undefined })).items.some((i) => i.group === "mac")).toBe(false);
    const unread = setupChecklist(facts({ mac: null })).items.filter((i) => i.group === "mac");
    expect(unread.map((i) => [i.id, i.state])).toEqual([
      ["mac.autologin", "unknown"],
      ["mac.power", "unknown"],
      ["mac.full-disk", "unknown"],
      ["mac.updates", "unknown"],
    ]);
  });
});

describe("linked machines and the model pool", () => {
  test("machines are optional: an older one, one signed out, one unreachable, or all fine", () => {
    expect(itemOf(facts(), "machines")).toMatchObject({ state: "user", optional: true, fix: { target: "machines" } });
    expect(itemOf(facts({ machines: [machine({ agents: "needs-update" })] }), "machines")).toMatchObject({ state: "user", detail: "Linux box runs an older Crosstalk." });
    expect(itemOf(facts({ machines: [machine()], machineVersions: { h_box: "0.3.1" } }), "machines").detail).toBe("Linux box runs an older Crosstalk (0.3.1).");
    expect(itemOf(facts({ machines: [machine({ agents: "signed-out" })] }), "machines").fix?.text).toBe("Link it again in Settings → Machines.");
    expect(itemOf(facts({ machines: [machine({ agents: "failed", error: "Couldn't reach box: timed out" })] }), "machines").detail).toBe("Couldn't reach Linux box: Couldn't reach box: timed out.");
    expect(itemOf(facts({ machines: [machine(), machine({ id: "h_2", name: "Studio", agents: "two-way" })] }), "machines")).toMatchObject({ state: "done", detail: "Linked: Linux box and Studio." });
    expect(itemOf(facts({ machines: [machine({ agents: "removing" })] }), "machines").detail).toContain("None linked");
  });
  test("the pool shows once it's set up: running, stopped with an error (needed), or off (optional)", () => {
    expect(setupChecklist(facts({ pool: { configured: false, state: "off", detail: null, alias: "", machines: 1 } })).items.some((i) => i.id === "pool")).toBe(false);
    const pool = (state: "running" | "error" | "off" | "starting", detail: string | null = null) => itemOf(facts({ pool: { configured: true, state, detail, alias: "qwen3-235b", machines: 3 } }), "pool");
    expect(pool("running")).toMatchObject({ state: "done", detail: "qwen3-235b runs on 3 machines." });
    expect(pool("error", "The PC's helper didn't start: open its window.")).toMatchObject({ state: "missing", optional: false, detail: "The PC's helper didn't start: open its window.", fix: { target: "model-pool" } });
    expect(pool("off")).toMatchObject({ state: "missing", optional: true });
    expect(pool("starting", "Loading the model")).toMatchObject({ state: "unknown", detail: "Starting: Loading the model. Check again in a minute." });
  });
});

describe("BrowserOS neo", () => {
  const item = (over: Partial<BrowserOsFacts> = {}) => itemOf(facts({ browseros: browserOs(over) }), "browseros");

  test("a hub that didn't check it has no item at all, and hands out no command", () => {
    expect(setupChecklist(facts()).items.find((i) => i.id === "browseros")).toBeUndefined();
    expect(setupChecklist(facts()).connect.browseros).toBeNull();
    expect(itemOf(facts({ browseros: null }), "browseros")).toMatchObject({ state: "unknown", optional: true });
  });

  test("installed, newest and connected is done — and it never counts against the summary", () => {
    const i = item();
    expect(i).toMatchObject({ state: "done", optional: true, fix: null, group: "agents", title: "BrowserOS neo" });
    expect(i.detail).toBe("BrowserOS neo 0.51.2.3 is the newest build, and Claude Code is connected at http://127.0.0.1:9010/mcp.");
    const c = setupChecklist(facts({ browseros: browserOs() }));
    expect(c.summary.total).toBe(11);
    expect(c.connect.browseros).toEqual({ url: "http://127.0.0.1:9010/mcp", rows: [{ agent: "claude", name: "Claude Code", command: "claude mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp", connected: true }], restart: expect.stringContaining("starts again") });
  });

  test("not installed offers the build for this machine, with its size and what gets checked", () => {
    const i = item({ installed: null, mcp: null, links: [] });
    expect(i.state).toBe("missing");
    expect(i.detail).toBe("Not installed. The newest build for this machine is 0.51.2.3 (165 MB).");
    expect(i.fix?.command).toBe("/Users/me/.local/bin/crosstalk-hub browseros install");
    expect(i.fix?.text).toContain("SHA-256");
    expect(i.fix?.text).toContain("notarisation");
    expect(i.fix?.target).toBe("agent-setup");
  });

  test("installed but never opened asks the person to open it once, and says why the port isn't guessed", () => {
    const i = item({ mcp: null, links: [] });
    expect(i.state).toBe("user");
    expect(i.detail).toContain("can't find the address it serves agents on");
    expect(i.fix?.text).toContain("Open BrowserOS neo once");
    expect(i.fix?.text).toContain("rather than guessing");
    expect(i.fix?.command).toBeUndefined();
  });

  test("an agent that hasn't got it gets that agent's own command, and the restart is said", () => {
    const i = item({ agents: ["claude", "codex"], links: [] });
    expect(i.state).toBe("missing");
    expect(i.detail).toContain("Claude Code (and 1 more) hasn't got it yet");
    expect(i.fix?.command).toBe("claude mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp");
    expect(i.fix?.text).toContain("starts again");
    const codexOnly = item({ agents: ["codex"], links: [] });
    expect(codexOnly.fix?.command).toBe("codex mcp add browseros-neo --url http://127.0.0.1:9010/mcp");
  });

  test("an entry left pointing at an old port is named, with the one line that fixes it", () => {
    const i = item({ links: [{ agent: "claude", name: "browseros-neo", url: "http://127.0.0.1:9210/mcp" }] });
    expect(i.state).toBe("missing");
    expect(i.detail).toContain("answers at http://127.0.0.1:9010/mcp, but Claude Code points at http://127.0.0.1:9210/mcp");
    expect(i.detail).toContain("port moves between builds");
    // Joined with ";", never "&&": removing a name that isn't registered exits 1, which stopped the add from running.
    expect(i.fix?.command).toBe("claude mcp remove browseros-neo -s user; claude mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp");
  });

  test("the entry it removes is the one that's really there, whatever the person named it", () => {
    // The browser's own "connect your agent" page, and its Manual Setup instructions, register it under any name.
    const i = item({ links: [{ agent: "claude", name: "neo", url: "http://127.0.0.1:9210/mcp" }] });
    expect(i.state).toBe("missing");
    expect(i.fix?.command).toBe("claude mcp remove neo -s user; claude mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp");
    // A name that couldn't go on a command line as it is falls back to the name Crosstalk gives its own entry.
    const odd = item({ links: [{ agent: "claude", name: "neo; rm -rf ~", url: "http://127.0.0.1:9210/mcp" }] });
    expect(odd.fix?.command).toBe("claude mcp remove browseros-neo -s user; claude mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp");
  });

  test("the same address spelled another way is connected, not an old entry", () => {
    for (const url of ["http://localhost:9010/mcp", "http://127.0.0.1:9010/mcp/", "http://[::1]:9010/mcp"]) {
      const i = item({ links: [{ agent: "claude", name: "browseros-neo", url }] });
      expect([url, i.state]).toEqual([url, "done"]);
      expect(i.detail).toContain("Claude Code is connected at http://127.0.0.1:9010/mcp");
    }
  });

  test("an agent with two entries counts as connected when one of them reaches it", () => {
    const i = item({
      links: [
        { agent: "claude", name: "browseros-neo", url: "http://127.0.0.1:9210/mcp" },
        { agent: "claude", name: "neo", url: "http://localhost:9010/mcp" },
      ],
    });
    expect(i.state).toBe("done");
    expect(i.fix).toBeNull();
  });

  test("a newer build is offered, never taken: the words say the profile stays", () => {
    const newer = { tag: "browserclaw/v0.52.0.0", version: "0.52.0.0", kind: "dmg" as const, publishedAt: NOW, asset: { name: "BrowserOS_neo_v0.52.0.0_arm64.dmg", url: "https://github.com/y.dmg", size: 170_000_000, sha256: "b".repeat(64) } };
    const i = item({ newest: newer });
    expect(i.state).toBe("missing");
    expect(i.optional).toBe(true);
    expect(i.detail).toContain("0.52.0.0 is out (170 MB)");
    expect(i.detail).toContain("sign-ins and tabs stay");
    expect(i.fix?.command).toBe("/Users/me/.local/bin/crosstalk-hub browseros install");
    // Open now: the words say to quit it first, and the command is **never** pre-armed with --replace-running. That
    // flag is what keeps a browser with the person's work in it from being deleted under them, and whoever is handed
    // this line runs it: an agent polling the checklist, or a Copy on the phone.
    const open = item({ newest: newer, installed: { path: "/Applications/BrowserOS neo.app", version: "0.51.2.3", bundleId: null, kind: "dmg", running: true } });
    expect(open.detail).toContain("It's open now, so quit it first");
    expect(open.fix?.command).toBe("/Users/me/.local/bin/crosstalk-hub browseros install");
    expect(open.fix?.command).not.toContain("--replace-running");
    expect(open.fix?.text).toContain("Quit BrowserOS neo on the machine");
  });

  test("GitHub out of reach: a working browser stays done and says the check couldn't run", () => {
    const offline = item({ releases: { ok: false, why: "offline", detail: "Unable to connect" } });
    expect(offline.state).toBe("done");
    expect(offline.detail).toContain("GitHub couldn't be reached");
    const rate = item({ releases: { ok: false, why: "rate", detail: "used up", retryAt: Date.parse("2026-10-28T13:21:00Z") } });
    expect(rate.state).toBe("done");
    expect(rate.detail).toContain("limit for unsigned checks is used up");
    expect(rate.detail).toMatch(/back at \d{1,2}:\d{2}/);
  });

  test("GitHub out of reach with nothing installed can't claim anything, and gives no busywork", () => {
    const rate = item({ installed: null, mcp: null, links: [], releases: { ok: false, why: "rate", detail: "used up", retryAt: Date.parse("2026-10-28T13:21:00Z") } });
    expect(rate.state).toBe("unknown");
    expect(rate.detail).toContain("Not installed");
    expect(rate.fix?.text).toContain("60 times an hour");
    expect(rate.fix?.command).toBeUndefined();
  });

  test("a machine with no build says so once, and offers nothing to run", () => {
    const i = item({ installed: null, mcp: null, links: [], target: buildTarget("linux", "riscv64"), newest: null });
    expect(i).toMatchObject({ state: "unknown", fix: null });
    expect(i.detail).toBe("BrowserOS neo has no Linux build for riscv64.");
  });

  test("answering but no agent installed here says that, instead of offering a command for nothing", () => {
    const i = item({ agents: [], links: [] });
    expect(i.state).toBe("user");
    expect(i.detail).toContain("no agent is installed here");
    expect(setupChecklist(facts({ browseros: browserOs({ agents: [], links: [] }) })).connect.browseros).toMatchObject({ rows: [] });
  });
});

test("names and errors from elsewhere come out as one plain line, capped", () => {
  expect(clean("Phone\u0007\n‮evil​ name", 100)).toBe("Phone evil name");
  expect(clean("x".repeat(50), 10)).toBe("xxxxxxxxx…");
  expect(sh("/Users/me/.local/bin/crosstalk-hub")).toBe("/Users/me/.local/bin/crosstalk-hub");
  expect(sh("/Users/me/My Apps/hub")).toBe("'/Users/me/My Apps/hub'");
  expect(sh("it's")).toBe("'it'\\''s'");
});

test("the guide has a section for every item, and no item id is missing from it", () => {
  const ids = SETUP_ITEM_IDS;
  // Every id the checklist can make, from facts that make each one, in the documented order.
  const every = setupChecklist(facts({ pool: { configured: true, state: "off", detail: null, alias: "m", machines: 1 }, providers: (["claude", "codex", "gemini", "antigravity", "muse", "opencode"] as Provider[]).map((p) => status(p)), mac: { ...MAC, dialogs: [{ id: "d", app: "a", wants: "b", since: NOW, count: 1 }] }, browseros: browserOs() }));
  expect(every.items.map((i) => i.id)).toEqual(ids);
  for (const id of ids) {
    const s = guideSection(id);
    expect([id, s?.split("\n")[0]]).toEqual([id, `## ${id}`]);
    expect(s!.length).toBeGreaterThan(40);
  }
  expect(guideSection("nope")).toBeNull();
  // The JSON contract and the rules are in it too.
  expect(SETUP_GUIDE).toContain("## Rules");
  expect(SETUP_GUIDE).toContain('"schema": 1');
});

test("tailscale's own answers: up, its name, certificates, key expiry and where serve sends https", () => {
  // Already parsed: hub/src/tailscale.ts is the one place that decides what counts as an answer (tailscale.test.ts).
  expect(parseTailscaleStatus({ BackendState: "Running", CertDomains: ["mini.tail1.ts.net"], Self: { DNSName: "mini.tail1.ts.net.", KeyExpiry: "2027-04-01T12:00:00Z" } })).toEqual({ state: "Running", dnsName: "mini.tail1.ts.net", certs: true, keyExpiry: Date.parse("2027-04-01T12:00:00Z") });
  expect(parseTailscaleStatus({ BackendState: "Running", CertDomains: null, Self: { DNSName: "mini.tail1.ts.net." } })).toMatchObject({ certs: false, keyExpiry: null });
  expect(parseTailscaleStatus({ BackendState: "NeedsLogin", Self: {} })).toEqual({ state: "NeedsLogin", dnsName: null, certs: null, keyExpiry: null });
  for (const nothing of [null, undefined, "not json", [1]]) expect([nothing, parseTailscaleStatus(nothing)]).toEqual([nothing, { state: null, dnsName: null, certs: null, keyExpiry: null }]);
  const serve = { TCP: { "443": { HTTPS: true } }, Web: { "mini.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7420" } } } } };
  expect(parseServeStatus(serve, "mini.tail1.ts.net")).toEqual({ target: "http://127.0.0.1:7420", funnel: false });
  expect(parseServeStatus({ ...serve, AllowFunnel: { "mini.tail1.ts.net:443": true } }, "mini.tail1.ts.net")).toEqual({ target: "http://127.0.0.1:7420", funnel: true });
  expect(parseServeStatus({}, "mini.tail1.ts.net")).toEqual({ target: null, funnel: false });
  for (const nothing of [null, undefined, "{broken", [1]]) expect([nothing, parseServeStatus(nothing, null)]).toEqual([nothing, null]);
});

test("the log an agent reads hides codes, keys, tokens, one-time links, push endpoints and emails", () => {
  const secretToken = "Zq8x3vB0kLmN4pQrStUvWxYz0123456789AbCdEfG";
  const lines = redactLog([
    "  │  and enter the code:  K7QM-2XPA               │",
    `GET /api/computers/claim/${"a1b2c3d4e5f6"}/script`,
    `curl -fsSL https://mini.ts.net/api/machines/install/${"q".repeat(10)}9abcdefgh`,
    "Authorization: Bearer abc.def.ghi",
    `?token=${secretToken}&v=2`,
    'saved {"apiKey":"sk-proj-abcdefghijklmnop"} and hf_ABCDEFGHIJKLMNOPQRS',
    "push to https://web.push.apple.com/QWxhZGRpbjpvcGVuIHNlc2FtZQ failed: 410",
    "signed in as person@example.com",
    `member token ${"e".repeat(20)}${"1".repeat(44)}`,
    "\u001b[31mERROR\u001b[0m [http] listening on http://127.0.0.1:7420",
    "x".repeat(500),
  ]);
  const all = lines.join("\n");
  for (const secret of ["K7QM-2XPA", "a1b2c3d4e5f6", "9abcdefgh", "abc.def.ghi", secretToken, "sk-proj-abcdefghijklmnop", "hf_ABCDEFGHIJKLMNOPQRS", "QWxhZGRpbjpvcGVuIHNlc2FtZQ", "person@example.com", "1".repeat(44)]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  expect(lines[0]).toContain("[code]");
  expect(lines[6]).toBe("push to https://web.push.apple.com/[hidden] failed: 410");
  expect(lines[9]).toBe("ERROR [http] listening on http://127.0.0.1:7420");
  expect(lines[10].length).toBe(400);
});

test("long log lines are read only as far as their start, quickly, and nothing cut in two slips out", () => {
  // Lines of a 256 KB tail that once held up the hub: a dotted word with no "@" took the address pattern 4 seconds a
  // line, and dashed words the key pattern longer.
  const dotted = "word1.x".repeat(37_000);
  const dashed = `${"key-".repeat(498)} ${"a-".repeat(120_000)}`;
  const started = performance.now();
  const out = redactLog([...Array<string>(100).fill(dotted), ...Array<string>(100).fill(dashed)]);
  expect(performance.now() - started).toBeLessThan(1500);
  expect(out.every((l) => l.length <= 400)).toBe(true);
  // Tokens hidden before the cut leave room for what's after them: an address there, cut in two, never shows its start.
  const atCut = `${Array.from({ length: 19 }, () => "Zq8x3vB0kL".repeat(10)).join(" ")} ${"Zq8x3vB0kL".repeat(7)} person.name@example.com and more`;
  expect(atCut.indexOf("person")).toBeLessThan(2000);
  expect(atCut.indexOf("example.com")).toBeGreaterThan(2000);
  const [cut] = redactLog([atCut]);
  expect(cut).not.toContain("person");
  expect(cut.endsWith("[hidden] …")).toBe(true);
  // A long name before "token" or "key" still hides what follows it.
  const [named] = redactLog(["a_very_long_configuration_name_for_the_service_x_token=Secret123 and accessKey: s3cr3t"]);
  expect(named).toBe("a_very_long_configuration_name_for_the_service_x_token=[hidden] and accessKey: [hidden]");
});

test("/setup.md is for requests made on this machine only: never through tailscale serve or another proxy", () => {
  const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:7420/setup.md", { headers });
  expect(directLocal(req({ host: "127.0.0.1:7420" }), "127.0.0.1")).toBe(true);
  expect(directLocal(req({ host: "localhost:7420" }), "::1")).toBe(true);
  expect(directLocal(req({ host: "[::1]:7420" }), "::ffff:127.0.0.1")).toBe(true);
  // tailscale serve: from 127.0.0.1, with the tailnet name kept and its headers added.
  expect(directLocal(req({ host: "mini.tail1.ts.net" }), "127.0.0.1")).toBe(false);
  for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "tailscale-user-login", "tailscale-headers-info", "via", "x-real-ip"]) expect([h, directLocal(req({ host: "127.0.0.1:7420", [h]: "1" }), "127.0.0.1")]).toEqual([h, false]);
  expect(directLocal(req({ host: "127.0.0.1:7420" }), "100.101.102.103")).toBe(false);
  expect(directLocal(req({ host: "127.0.0.1:7420" }), "192.168.1.20")).toBe(false);
  expect(directLocal(req({ host: "127.0.0.1:7420" }), null)).toBe(false);
});
