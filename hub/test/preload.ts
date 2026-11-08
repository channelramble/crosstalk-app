// All tests share an isolated hub home, created before any application module is loaded.
// App imports resolve config paths once, so setting environment variables inside a test is too late.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteSpawns, runEnds, testBegins, testEnds } from "./standins";
// A test subprocess must never inherit the live hub's URL, Unix socket or member credentials.
for (const key of Object.keys(process.env)) if (key.startsWith("CROSSTALK_")) delete process.env[key];
const testHome = mkdtempSync(join(tmpdir(), "crosstalk-tests-"));
process.env.CROSSTALK_HOME = testHome;
process.env.CROSSTALK_WORKSPACES = join(testHome, "workspaces");
process.env.CROSSTALK_PUBLIC_URL = "";
process.env.CROSSTALK_INTERNAL_SECRET = "";
// Price lists (prices.ts) come only from here: a closed port on this machine, so no test reaches the internet for one.
process.env.CROSSTALK_PRICES_URL = "http://127.0.0.1:9/prices.json";
// An API-key account's Claude models (Anthropic's Models API, providers/claude.ts): a closed port too, unless a test starts a fake.
process.env.CROSSTALK_ANTHROPIC_API_URL = "http://127.0.0.1:9";
// Settings → AI services looks for model servers on this machine (services.ts): tests look nowhere unless they say where.
process.env.CROSSTALK_LOCAL_SERVER_PORTS = "";
// Featherless's model catalogue (featherless.ts): a closed port, so no test reaches the real service; the Featherless
// tests point this at their own stand-in.
process.env.CROSSTALK_FEATHERLESS_URL = "http://127.0.0.1:9";
// NanoGPT (nanogpt.ts and its price list in prices.ts): a closed port too; the NanoGPT tests start their own stand-in.
process.env.CROSSTALK_NANOGPT_URL = "http://127.0.0.1:9";
// Refuseless (refuseless.ts, its prices in prices.ts): a closed port too; the Refuseless tests start their own stand-in.
process.env.CROSSTALK_REFUSELESS_URL = "http://127.0.0.1:9";
// GitHub's API (the model pool's llama.cpp builds, BrowserOS neo's releases): a closed port, so no test asks the real
// one — which also means no test spends the 60 unsigned checks an hour a machine gets. Tests that want an answer
// point this at their own stand-in.
process.env.CROSSTALK_GITHUB_API = "http://127.0.0.1:9";
// Tailscale (hub/src/tailscale.ts) is asked two ways: the command and, on a Mac, the app's own local API under
// /Library/Tailscale. Both point at paths that aren't there, so a test hub never reads this Mac's real Tailscale (its
// status, its tailnet name, its proof token); a test that wants one sets these itself.
process.env.CROSSTALK_TAILSCALE_BIN = join(testHome, "no-tailscale");
process.env.CROSSTALK_TAILSCALE_APP_DIR = join(testHome, "no-tailscale-app");
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));

// Every process a test starts (or the hub code it runs starts) is noted, and none may be left running: a test that leaves
// a process group running fails, and so does a run that leaves anything (standins.ts). These hooks run around every
// test of every file: beforeEach before the file's own, afterEach after them.
noteSpawns();
beforeEach(testBegins);
afterEach(testEnds, { timeout: 10_000 });
afterAll(runEnds, { timeout: 10_000 });
