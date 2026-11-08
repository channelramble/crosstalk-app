// A hub of its own for e2e/signIn.spec.ts: the hub's real sign-in code (hub/src/signin.ts and the engine's recovery from a
// stale sign-in) driving the hub tests' fake Claude Code and fake Codex (hub/test/fixtures), whose sign-in is a file in
// this hub's own folder. Nothing here runs a real agent CLI, signs in to anything or looks at this Mac's own sign-ins: the
// agents are found only as the fakes, Claude Code's and Codex's config folders are this hub's own, and the Crosstalk home
// is a new temporary one. It listens on a free port of 127.0.0.1 (never 7420) and says where on one line of stdout:
//   SIGNIN_HUB {"port":…,"token":"…","dir":"…"}
// `dir` holds the fakes' files the test reads and writes: claude-auth ("in"/"out", the shared sign-in Claude Code clears
// when its refresh token is refused), login-state (the `state` in the sign-in link), codex-auth, codex-approved (made by
// the test once the device code is "approved" on its page). SIGTERM ends it, its agents' processes, and its folder.
//
// Options, as JSON in SIGNIN_HUB_OPTS: { staleStarts?: "1" (the first Claude Code process holds a stale sign-in),
// codex?: "in" | "out", pageCode?: string (the code part of what Claude Code's sign-in page shows), nano?: true (a
// stand-in NanoGPT, the hub tests' fixtures/fake-nanogpt.ts, for Crosstalk's own agent: it takes only the key
// "sk-nano-test-key-0001" and answers a chat with "Hello from NanoGPT."; its address, to save an account with, is
// `nano` on the SIGNIN_HUB line) }.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@crosstalk/shared";

const opts = JSON.parse(process.env.SIGNIN_HUB_OPTS || "{}") as { staleStarts?: string; codex?: "in" | "out"; pageCode?: string; nano?: boolean };
const dir = realpathSync(mkdtempSync(join(tmpdir(), "crosstalk-signin-")));
const FIX = join(import.meta.dir, "../../hub/test/fixtures");

// As e2e/hub.ts: nothing of the live hub's, and nothing on this machine or the internet is asked about.
for (const key of Object.keys(process.env)) if (key.startsWith("CROSSTALK_") || key.startsWith("FAKE_")) delete process.env[key];
process.env.CROSSTALK_TAILSCALE_BIN = join(dir, "no-tailscale");
process.env.CROSSTALK_TAILSCALE_APP_DIR = join(dir, "no-tailscale-app");
process.env.CROSSTALK_GITHUB_API = "http://127.0.0.1:9";
process.env.CROSSTALK_LLAMA_RELEASES = "http://127.0.0.1:9";
process.env.CROSSTALK_HF_URL = "http://127.0.0.1:9";
process.env.CROSSTALK_LOCAL_SERVER_PORTS = "";
process.env.CROSSTALK_LOCAL_PROGRAMS = "";
process.env.CROSSTALK_OLLAMA_REGISTRY = "http://127.0.0.1:9";
process.env.CROSSTALK_PRICES_URL = "http://127.0.0.1:9/prices.json";
process.env.CROSSTALK_FEATHERLESS_URL = "http://127.0.0.1:9";
process.env.CROSSTALK_ANTHROPIC_API_URL = "http://127.0.0.1:9";
// Nor NanoGPT (its list, its prices, anyone's balance): a closed port, or the stand-in when asked for one.
const nano = opts.nano ? (await import("../../hub/test/fixtures/fake-nanogpt")).fakeNanoGpt({ key: "sk-nano-test-key-0001", replies: [{ text: "Hello from NanoGPT." }] }) : null;
process.env.CROSSTALK_NANOGPT_URL = nano?.url ?? "http://127.0.0.1:9";
// Nor Refuseless's balances (refuseless.ts).
process.env.CROSSTALK_REFUSELESS_URL = "http://127.0.0.1:9";
process.env.CROSSTALK_HOME = join(dir, "home");
mkdirSync(process.env.CROSSTALK_HOME);
process.env.CROSSTALK_WORKSPACES = join(dir, "workspaces");
// The agents' own folders are this hub's: never ~/.claude or ~/.codex.
process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
process.env.CODEX_HOME = join(dir, "codex-home");
mkdirSync(process.env.CLAUDE_CONFIG_DIR);
mkdirSync(process.env.CODEX_HOME);
// The fakes' sign-ins (hub/test/fixtures/fake-claude, fake-codex-login).
process.env.FAKE_CLAUDE_AUTH_FILE = join(dir, "claude-auth");
process.env.FAKE_CLAUDE_LOGIN_STATE_OUT = join(dir, "login-state");
process.env.FAKE_CLAUDE_LOGIN_CODE = opts.pageCode || "fake-auth-code-123456";
// Its terminal shows what's typed into it, as a terminal that echoes would: Crosstalk must pass none of it on.
process.env.FAKE_CLAUDE_LOGIN_ECHO = "1";
process.env.FAKE_CLAUDE_ARGS_OUT = join(dir, "claude-starts.jsonl");
if (opts.staleStarts) process.env.FAKE_CLAUDE_STALE_STARTS = opts.staleStarts;
process.env.FAKE_CODEX_AUTH_FILE = join(dir, "codex-auth");
process.env.FAKE_COMPLETE_FILE = join(dir, "codex-approved");
writeFileSync(process.env.FAKE_CLAUDE_AUTH_FILE, "in");
writeFileSync(process.env.FAKE_CODEX_AUTH_FILE, opts.codex ?? "in");

// Every agent's own module (its sign-in check, its driver), as the hub registers them when it starts.
await import("../../hub/src/providers/all");
// Except that Crosstalk's own agent is never given BrowserOS neo here: as registered, it would ask the browser the person
// works in on this Mac for its tools.
const { registerDriver } = await import("../../hub/src/agents");
const { BuiltinDriver } = await import("../../hub/src/agents/builtin");
registerDriver("builtin", (ctx) => new BuiltinDriver(ctx, { browserUrl: async () => null }));
const { App } = await import("../../hub/src/app");
const { startServer } = await import("../../hub/src/server");
const { ClaudeDriver } = await import("../../hub/src/agents/claude");
// Nothing of this Mac's own Claude Code sessions (open in the Claude app) is looked at.
ClaudeDriver.sessionsInUse = () => new Set();

const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: join(dir, "workspaces"), maxHopsDefault: 5 } });
const FAKES: Partial<Record<Provider, string>> = { claude: join(FIX, "fake-claude"), codex: join(FIX, "fake-codex-login") };
app.providers.which = (p) => FAKES[p] ?? null;
// Model lists and usage are other tests' business: answered here without starting anything.
app.providers.models = async (provider) => ({ provider, live: true, error: null, models: [{ id: `${provider}-model`, label: `${provider} model`, description: null, isDefault: true, efforts: [], defaultEffort: null }] });
app.providers.refreshUsage = async () => {};
app.providers.accountDir = (provider, account) => join(dir, "accounts", provider, account);
app.setHubSettings({ machineName: "Mac mini" });
const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Browser tests", "Web"))!;
await app.start();
// What the setup checklist and Settings show from the start: each agent's own sign-in check, against the fakes.
await app.providers.refresh("claude");
await app.providers.refresh("codex");
const server = startServer(app);
process.stdout.write(`SIGNIN_HUB ${JSON.stringify({ port: server.port, token: device.token, dir, nano: nano?.base ?? null })}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.stop(true);
  await app.shutdown().catch(() => {});
  nano?.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
// Whoever started it went away without a word (a run that was killed): it goes too.
process.stdin.on("end", () => void close());
process.stdin.resume();
