// What the person's own runs of OpenCode saved with "Allow always" doesn't reach a Crosstalk chat: the real program, with
// a home folder of the test's own, on the stand-in service. Skipped where OpenCode isn't installed.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { OpenCodeDriver } from "../src/agents/opencode";
import { fakeRefuseless } from "./fixtures/fake-refuseless";

const KEY = "abl_test_key_0001";
const MODEL = "deepseek-v4.1-flash-abliterated";
const BIN = join(userInfo().homedir, ".npm-global/bin/opencode");
const it = existsSync(BIN) ? test : test.skip;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function env(home: string) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache") };
}

/** The person's own run, in the person's config and data folder: one prompt, every question answered Allow always. */
async function ownRun(home: string, cwd: string) {
  const proc = Bun.spawn([BIN, "acp"], { cwd, env: { ...env(home), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let next = 1;
  const waiting = new Map<number, (v: any) => void>();
  void (async () => {
    let buf = "";
    for await (const c of proc.stdout as any) {
      buf += new TextDecoder().decode(c);
      for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
        const m = JSON.parse(buf.slice(0, nl) || "{}");
        buf = buf.slice(nl + 1);
        if (m.id !== undefined && m.method) proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: "always" } } }) + "\n");
        else if (m.id !== undefined) waiting.get(m.id)?.(m.result);
      }
    }
  })();
  const req = (method: string, params: unknown) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "own", version: "1" } });
  const { sessionId } = await req("session/new", { cwd, mcpServers: [] });
  await req("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
  proc.kill();
  await proc.exited;
}

it("Ask still asks for what the person's own OpenCode saved with Allow always", async () => {
  const home = mkdtempSync(join(tmpdir(), "ct-oc-saved-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "proj");
  mkdirSync(cwd);
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
  git("init", "-q");
  writeFileSync(join(cwd, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const fake = fakeRefuseless({ key: KEY, replies: [
    { calls: [{ name: "write", args: { path: "own.txt", content: "mine\n" } }] },
    { calls: [{ name: "shell", args: { command: "rm -f nothing.txt", description: "x" } }] },
    { text: "Done." },
    { calls: [{ name: "write", args: { path: "chat.txt", content: "chat\n" } }] },
    { calls: [{ name: "shell", args: { command: "rm -f README.md", description: "x" } }] },
    { text: "Done." },
  ] });
  cleanups.push(() => fake.stop());
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify({ model: `mine/${MODEL}`, update: "disable", snapshots: false, agents: { title: { disabled: true } }, providers: { mine: { name: "Mine", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${fake.base}/v1`, apiKey: KEY }, models: { [MODEL]: {} } } }, permissions: [{ action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "ask" }] }));
  await ownRun(home, cwd);
  const db = new Database(join(home, ".local/share/opencode/opencode.db"), { readonly: true });
  expect(db.query("select action, resource from permission order by action").all()).toEqual([{ action: "edit", resource: "*" }, { action: "shell", resource: "rm *" }]);
  db.close();

  const ctx: any = {
    room: { id: "r1", cwd, name: "t" },
    member: { id: "mb-oc", provider: "opencode", model: MODEL, permissionMode: "ask", config: {} },
    session: {},
    mcp: { command: "", args: [], env: {} },
    env: env(home),
    bin: BIN,
    chat: null,
    endpoint: { id: "rl", label: "Refuseless", baseUrl: fake.base, models: [MODEL], contextWindow: 1_048_576, key: KEY },
  };
  const d = new OpenCodeDriver(ctx, BIN, { browserUrl: async () => null, runDir: join(home, "run"), settleMs: 0 });
  cleanups.push(() => d.dispose());
  const approvals: any[] = [];
  const ac = new AbortController();
  const sink: any = { text() {}, setText() {}, activity: () => "a", updateActivity() {}, approval: async (a: any) => { approvals.push([a.kind, a.title]); return "deny"; }, usage() {}, rateLimit() {}, status() {}, saveSession() {}, newReply() {}, taken() {}, signal: ac.signal };
  await d.runTurn({ turnId: "t", prompt: "go", systemNote: null, messageIds: [] } as any, sink);
  expect(approvals[0]).toEqual(["file_change", "Write chat.txt"]);
  expect(existsSync(join(cwd, "chat.txt"))).toBe(false);
  expect(existsSync(join(cwd, "README.md"))).toBe(true);
}, 60_000);
