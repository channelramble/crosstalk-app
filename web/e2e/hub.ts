// An isolated real hub. Agent/provider operations are stand-ins: browser tests never
// run an installed agent, change sign-ins, or consume the owner's subscriptions.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider } from "@crosstalk/shared";

const dir = mkdtempSync(join(tmpdir(), "crosstalk-browser-"));
for (const key of Object.keys(process.env)) if (key.startsWith("CROSSTALK_")) delete process.env[key];
// Settings → Model pool asks this hub about itself (a check when it first opens): it must never run this Mac's real
// Tailscale (a path that isn't there reads as "not installed") or reach GitHub and Hugging Face (nothing listens on
// port 9, so a request fails at once).
process.env.CROSSTALK_TAILSCALE_BIN = join(dir, "no-tailscale");
process.env.CROSSTALK_TAILSCALE_APP_DIR = join(dir, "no-tailscale-app");
process.env.CROSSTALK_GITHUB_API = "http://127.0.0.1:9";
process.env.CROSSTALK_LLAMA_RELEASES = "http://127.0.0.1:9";
process.env.CROSSTALK_HF_URL = "http://127.0.0.1:9";
// Settings → AI services scans this machine's own model-server ports (Ollama, LM Studio, llama.cpp): never in a test hub.
process.env.CROSSTALK_LOCAL_SERVER_PORTS = "";
// Settings → Local models never finds this machine's own ollama or llama-server, or asks Ollama's real library.
process.env.CROSSTALK_LOCAL_PROGRAMS = "";
process.env.CROSSTALK_OLLAMA_REGISTRY = "http://127.0.0.1:9";
process.env.CROSSTALK_PRICES_URL = "http://127.0.0.1:9/prices.json";
// Nor is Featherless's real catalogue ever asked for its 22,406 models: a test hub reaches no AI service.
process.env.CROSSTALK_FEATHERLESS_URL = "http://127.0.0.1:9";
// Nor NanoGPT's model list, its prices or anyone's balance (nanogpt.ts, prices.ts).
process.env.CROSSTALK_NANOGPT_URL = "http://127.0.0.1:9";
// Nor Refuseless's balances (refuseless.ts).
process.env.CROSSTALK_REFUSELESS_URL = "http://127.0.0.1:9";
// An API-key account's Claude models are never asked of Anthropic (its Models API) from a test hub.
process.env.CROSSTALK_ANTHROPIC_API_URL = "http://127.0.0.1:9";
process.env.CROSSTALK_HOME = join(dir, "home");
mkdirSync(process.env.CROSSTALK_HOME);
process.env.CROSSTALK_WORKSPACES = join(dir, "workspaces");
const { App } = await import("../../hub/src/app");
const { startServer } = await import("../../hub/src/server");
const statePath = join(tmpdir(), "crosstalk-browser-state-8451.json");
const app = new App({ dbPath: ":memory:", config: { port: 8451, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
const statuses = (["claude", "codex", "mock"] as Provider[]).map((provider) => ({ provider, installed: true, signedIn: true, version: "test", binPath: null, account: "Browser fixture", plan: "test", authMethod: null, error: null, checkedAt: Date.now() }));
app.providers.list = () => statuses;
app.providers.models = async (provider) => ({ provider, live: true, models: [{ id: `${provider}-model`, label: `${provider} model`, isDefault: true, efforts: ["low", "high"] }] });
app.providers.refreshAll = async () => statuses as never;
app.providers.refreshUsage = async () => {};
app.providers.refresh = async (provider) => statuses.find((s) => s.provider === provider)!;
// Account creation/removal must never touch the owner's real sign-in folders.
app.providers.accountDir = (provider, account) => join(dir, "accounts", provider, account);
const actualAccounts = app.providers.accounts.bind(app.providers);
app.providers.accounts = () => [
  ...statuses.filter((s) => s.provider !== "mock").map((s) => ({ ...s, id: "default", label: "Main" })),
  ...actualAccounts().filter((a) => a.id !== "default"),
];
const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Browser tests", "Web"))!;
writeFileSync(statePath, JSON.stringify({ token: device.token, workspaceRoot: dir }), { mode: 0o600 });
await app.start();
const server = startServer(app);

async function close() {
  server.stop(true);
  await app.engine.shutdown();
  app.store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(app.computers.dir, { recursive: true, force: true });
  rmSync(statePath, { force: true });
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
