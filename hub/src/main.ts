#!/usr/bin/env bun
import { App, selfCommand } from "./app";
import { readFileSync } from "node:fs";
import { CONFIG_PATH, DB_PATH, HOME, HUB_VERSION, ensureDirs, loadConfig } from "./config";
import { pairLink, pairScreen } from "./pairLink";
import { startServer } from "./server";
import { runMcpStdio } from "./mcp/stdio";
import { runSetupMcp } from "./mcp/setup";
import { runSetupCli } from "./setup/cli";
import { runBrowserOsCli } from "./browserosCli";
import { runHook } from "./agents/model-lock";
import { Store } from "./db";
import { Auth, FIRST_CODE_TTL_MS } from "./auth";
import { logger } from "./util/log";
import { rotateLog } from "./setup/system";
import "./providers/all";

const log = logger("main");
const [cmd = "serve", ...rest] = process.argv.slice(2);

async function serve() {
  // One stray error mustn't take the hub down: that would stop every agent's turn in every room.
  process.on("unhandledRejection", (e) => log.error(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.on("uncaughtException", (e) => log.error(`uncaught exception: ${e.stack ?? e.message}`));
  const config = loadConfig();
  // The Mac service's log starts over once it's big (the one before is kept beside it).
  if (process.platform === "darwin" && rotateLog()) log.info("the log passed 5 MB: what was in it is in hub.log.1");
  const app = new App({ config, dbPath: DB_PATH });
  await app.start();
  const server = startServer(app);

  if (!app.auth.hasDevices()) {
    // The first code is printed where the service's log keeps it: an hour, then `crosstalk-hub pair` makes another.
    const { code } = await app.auth.createPairingCode(FIRST_CODE_TTL_MS);
    const where = config.publicUrl ?? `http://${config.host}:${server.port}`;
    // As wide as the address needs: a tailnet name can be longer than the box used to be.
    const lines = ["Pair your first device", `Open ${where}`, `and enter the code:  ${code}`];
    const width = Math.max(44, ...lines.map((l) => l.length));
    console.log("");
    console.log(`  ┌─${"─".repeat(width)}─┐`);
    for (const l of lines) console.log(`  │ ${l.padEnd(width)} │`);
    console.log(`  └─${"─".repeat(width)}─┘`);
    console.log("");
  }

  void app.providers.refreshAll().then(() => app.providers.refreshUsage());
  // Plan usage every 15 minutes: agents also report their limits as they work, so polling can be sparing.
  const usageTimer = setInterval(() => void app.providers.refreshUsage(), 15 * 60_000);
  // Model lists in use are asked for again now and then, so new models and changed context sizes show up by themselves.
  const stopModelWatch = app.providers.watchModels();
  const sweep = setInterval(() => app.pty.sweep(), 60_000);

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearInterval(usageTimer);
    clearInterval(sweep);
    stopModelWatch();
    server.stop(true);
    await app.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log.info(`Crosstalk hub ${HUB_VERSION} · data in ${HOME}`);
}

/** The address in config.json, read as it is: nothing else of the config is looked at (see pair). */
function savedAddress(): string | null {
  try {
    const v = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).publicUrl;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

async function pair() {
  // Only the data folder, not loadConfig(): the Crosstalk Hub app runs `pair` too, and macOS counts what it opens as the
  // app's doing, so checking a workspace folder in Documents or on a drive would ask about it in the app's name.
  ensureDirs();
  const store = new Store(DB_PATH);
  const auth = new Auth(store);
  // `pair 60 --url https://box.ts.net`: how long the code lasts (minutes), and the address to put in the link.
  const at = rest.indexOf("--url");
  const given = at >= 0 ? rest[at + 1] : undefined;
  const minutes = rest.find((a, i) => /^\d+$/.test(a) && (at < 0 || i !== at + 1));
  const ttl = Number(minutes ?? 30) * 60_000;
  // `--for-machine`: the code links another machine's hub (the Linux setup command asks for one), never a person's device.
  const { code, expiresAt } = await auth.createPairingCode(ttl, rest.includes("--for-machine") ? { kind: "hub" } : {});
  console.log(`Pairing code: ${code}  (valid until ${new Date(expiresAt).toLocaleTimeString()})`);
  // A person at the terminal (or an installer that says the address) also gets the code as a QR to scan. A program
  // that reads the line above gets only that line, as ever.
  if (given || process.stdout.isTTY) {
    const link = pairLink(given ?? process.env.CROSSTALK_PUBLIC_URL ?? savedAddress(), code);
    if (link) console.log(await pairScreen(link));
  }
  store.close();
}

switch (cmd) {
  case "serve":
    await serve();
    break;
  case "mcp":
    await runMcpStdio();
    break;
  case "hook":
    process.exitCode = await runHook(rest[0]);
    break;
  case "pair":
    await pair();
    break;
  case "setup":
    process.exitCode = await runSetupCli(rest, selfCommand());
    break;
  case "setup-mcp":
    await runSetupMcp(selfCommand());
    break;
  case "browseros":
    process.exitCode = await runBrowserOsCli(rest);
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(HUB_VERSION);
    break;
  default:
    console.log(`Crosstalk hub ${HUB_VERSION}

Usage:
  crosstalk-hub [serve]     start the hub (default)
  crosstalk-hub pair [min]  print a one-time code to pair a new device (default 30 minutes)
  crosstalk-hub setup [--json]
                            what's left to set up on this machine (--json: the same, for AI agents)
  crosstalk-hub setup-mcp   setup tools for an AI agent on this machine, e.g.
                            claude mcp add --scope user crosstalk-setup -- crosstalk-hub setup-mcp
  crosstalk-hub browseros [check|install]
                            BrowserOS neo, the browser for agents: what's installed, what's
                            newest for this machine, and installing it (checked before it lands)
  crosstalk-hub mcp         room MCP helper (launched by agents, not by you)
  crosstalk-hub hook ...    checks agents' tool calls (run by Claude Code, not by you)
  crosstalk-hub version`);
}
