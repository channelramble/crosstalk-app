#!/usr/bin/env bun
import { App, selfCommand } from "./app";
import { DB_PATH, HOME, HUB_VERSION, ensureDirs, loadConfig } from "./config";
import { startServer } from "./server";
import { runMcpStdio } from "./mcp/stdio";
import { runSetupMcp } from "./mcp/setup";
import { runSetupCli } from "./setup/cli";
import { runBrowserOsCli } from "./browserosCli";
import { runHook } from "./agents/model-lock";
import { Store } from "./db";
import { Auth } from "./auth";
import { logger } from "./util/log";
import "./providers/all";

const log = logger("main");
const [cmd = "serve", ...rest] = process.argv.slice(2);

async function serve() {
  // One stray error mustn't take the hub down: that would stop every agent's turn in every room.
  process.on("unhandledRejection", (e) => log.error(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.on("uncaughtException", (e) => log.error(`uncaught exception: ${e.stack ?? e.message}`));
  const config = loadConfig();
  const app = new App({ config, dbPath: DB_PATH });
  await app.start();
  const server = startServer(app);

  if (!app.auth.hasDevices()) {
    const { code } = await app.auth.createPairingCode(24 * 3600_000);
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
  // What the model pool ran on other hubs when this one last stopped without ending it (a crash, a power cut) is
  // ended; then the pool starts again if it was running when the hub stopped and "Start when the hub starts" is on.
  app.pool.recover();
  app.pool.resume();
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

async function pair() {
  // Only the data folder, not loadConfig(): the Crosstalk Hub app runs `pair` too, and macOS counts what it opens as the
  // app's doing, so checking a workspace folder in Documents or on a drive would ask about it in the app's name.
  ensureDirs();
  const store = new Store(DB_PATH);
  const auth = new Auth(store);
  const ttl = Number(rest[0] ?? 30) * 60_000;
  const { code, expiresAt } = await auth.createPairingCode(ttl);
  console.log(`Pairing code: ${code}  (valid until ${new Date(expiresAt).toLocaleTimeString()})`);
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
