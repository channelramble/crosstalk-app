// Chatting with the model pool (docs/MODEL-POOL.md): what the pool offers every screen that starts a chat
// (Pool.chatOffer) in each state, and what a chat on it says when the pool isn't there to answer (Pool.chatProblem,
// through the engine). Against the pool's own fakes only: llama.cpp is the fake llama-server from a fake GitHub
// release, the model comes from a fake Hugging Face, Tailscale is the fake CLI, and a computer's helper is a plain TCP
// listener. CROSSTALK_POOL_LOOPBACK=1 keeps every helper and server on 127.0.0.1. Nothing connects to a Tailscale
// (100.x) address, nothing is downloaded from the internet, and nothing is left running.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { registerDriver } from "../src/agents";
import { ClaudeDriver } from "../src/agents/claude";
import { App } from "../src/app";
import { readSecrets, writeSecret } from "../src/config";
import { HF_SECRET, KEY_SECRET } from "../src/pool/pool";
import { llamaDir } from "../src/pool/llama";
import { modelsDir, quantOf } from "../src/pool/models";
import type { PoolMachine, PoolModel, PoolOffer, PoolView, ServerEvent } from "@crosstalk/shared";
import { fakeGitHub, fakeHuggingFace, freePort, installScript, llamaTarball } from "./fixtures/pool-fakes";

const BUILD = "b11669";
/** Starting a pool takes a few seconds (a helper settles, the model loads): these flows get longer than the default 5 s. */
const SLOW = 60_000;

const work = realpathSync(mkdtempSync(join(tmpdir(), "ct-pool-chat-")));
const fakeTailscale = join(work, "tailscale");
const ENV = ["CROSSTALK_GITHUB_API", "CROSSTALK_LLAMA_RELEASES", "CROSSTALK_HF_URL", "CROSSTALK_TAILSCALE_BIN", "CROSSTALK_POOL_LOOPBACK", "CROSSTALK_NO_AGENT_CLIS", "FAKE_LLAMA_LOAD_MS", "FAKE_TAILSCALE_IP", "FAKE_TAILSCALE_STATUS"];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const savedSecrets = { hf: readSecrets()[HF_SECRET] ?? null, key: readSecrets()[KEY_SECRET] ?? null };

const bytes = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 255;
  return b;
};
const FILES = { "Tiny-Q4_K_M.gguf": bytes(300_000) };
const tiny: PoolModel = { repo: "acme/Tiny-GGUF", files: ["Tiny-Q4_K_M.gguf"], quant: quantOf("Tiny-Q4_K_M.gguf"), sizeBytes: FILES["Tiny-Q4_K_M.gguf"].length, gated: false };

let gh: ReturnType<typeof fakeGitHub>;
let hf: ReturnType<typeof fakeHuggingFace>;

/** Stands in for Claude Code: answers, unless the test says what it should do instead. */
class Agent implements AgentDriver {
  readonly provider = "claude" as const;
  static ran = 0;
  static before: (() => Promise<void>) | null = null;
  static result: TurnResult = { ok: true };
  constructor(private ctx: DriverContext) {}
  async runTurn(_input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    Agent.ran++;
    await Agent.before?.();
    if (Agent.result.ok) sink.text(`Answered on ${this.ctx.endpoint?.models[0] ?? "no model"}`);
    return Agent.result;
  }
  async interrupt() {}
  async dispose() {}
}

interface Hub {
  app: App;
  offers: PoolOffer[];
  close(): Promise<void>;
}
const hubs: Hub[] = [];

/** A hub with an in-memory database, quick pool timers, and a stand-in for the agent CLI. */
function hub(name = "Mac mini"): Hub {
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: join(work, "workspaces"), maxHopsDefault: 6 } });
  // autoClean off: a test must never clear this Mac's real caches.
  app.setHubSettings({ machineName: name, storage: { autoClean: false, lowSpaceGb: 15 } });
  app.poolNode.trashOptions = { home: join(work, "trash-home"), gio: false };
  app.pool.watchMs = { self: 100, hub: 150 };
  app.pool.metricsMs = 1000;
  app.pool.restartDelayMs = 100_000; // no automatic restart inside these tests
  // A safety net: a computer at a Tailscale address is never really connected to from a test.
  const probe = app.pool.probe;
  app.pool.probe = (host, port) => (host.startsWith("100.") ? Promise.resolve(false) : probe(host, port));
  const h: Hub = {
    app,
    offers: [],
    async close() {
      await app.shutdown();
    },
  };
  app.bus.on((e: ServerEvent) => {
    if (e.t === "poolOffer") h.offers.push(e.offer);
  });
  hubs.push(h);
  return h;
}

const selfMachine = (enabled: boolean): PoolMachine => ({ id: "self", kind: "self", name: "", address: null, os: null, backend: null, enabled, rpcPort: 50052 });
const computer = (rpcPort: number): PoolMachine => ({ id: "pc_box00001", kind: "computer", name: "Box", address: "127.0.0.1", os: "windows", backend: "vulkan", enabled: true, rpcPort });

/** A computer's helper: a TCP listener (ggml-rpc-server serves one client at a time). */
function helperListener() {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {} } });
  return { port: l.port, stop: () => l.stop(true) };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const settled = async (h: Hub, ms = 30_000) => {
  await until(() => ["running", "error", "off"].includes(h.app.pool.view().status.state), "the pool to settle", ms);
  return h.app.pool.view().status;
};
/** What a chat's messages say: who wrote each one, how it ended, and its words. */
const said = (h: Hub, roomId: string) => h.app.store.listMessages(roomId).map((m) => `${m.authorKind}:${m.status}:${m.text}`);
async function say(h: Hub, roomId: string, text: string) {
  h.app.engine.postHumanMessage(roomId, text, "Phone");
  for (let i = 0; i < 400 && h.app.engine.isBusy(); i++) await Bun.sleep(10);
  await Bun.sleep(30);
  return said(h, roomId);
}

beforeAll(async () => {
  const tarball = await llamaTarball(work, BUILD);
  gh = fakeGitHub({
    [BUILD]: {
      [`llama-${BUILD}-bin-macos-arm64.tar.gz`]: { bytes: tarball },
      [`llama-${BUILD}-bin-ubuntu-vulkan-x64.tar.gz`]: { bytes: tarball },
      [`llama-${BUILD}-bin-ubuntu-x64.tar.gz`]: { bytes: tarball },
    },
  });
  hf = fakeHuggingFace({ "acme/Tiny-GGUF": { files: FILES } });
  installScript("fake-tailscale", fakeTailscale);
  mkdirSync(join(work, "chats"), { recursive: true });
  Object.assign(process.env, {
    CROSSTALK_GITHUB_API: gh.api,
    CROSSTALK_LLAMA_RELEASES: gh.releases,
    CROSSTALK_HF_URL: hf.url,
    CROSSTALK_TAILSCALE_BIN: fakeTailscale,
    CROSSTALK_POOL_LOOPBACK: "1",
    // Never find (or start) the real agent CLIs.
    CROSSTALK_NO_AGENT_CLIS: "1",
    FAKE_LLAMA_LOAD_MS: "200",
  });
  delete process.env.FAKE_TAILSCALE_IP;
  delete process.env.FAKE_TAILSCALE_STATUS;
  writeSecret(HF_SECRET, null);
  registerDriver("claude", (c) => new Agent(c));
});

afterAll(async () => {
  for (const h of hubs.splice(0)) await h.close().catch(() => {});
  gh?.stop();
  hf?.stop();
  registerDriver("claude", (c) => new ClaudeDriver(c, c.bin));
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  writeSecret(HF_SECRET, savedSecrets.hf);
  writeSecret(KEY_SECRET, savedSecrets.key);
  // The "Model pool" accounts' copies of the key (the secrets file is shared by the test run).
  for (const [k, v] of Object.entries(readSecrets())) if (k.startsWith("apikey:") && v.startsWith("ctpool-")) writeSecret(k, null);
  // The hub's home is shared by the test run: leave no builds or models for other tests to find.
  rmSync(llamaDir(), { recursive: true, force: true });
  rmSync(modelsDir(), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test("a pool nobody has set up is still one entry, saying it isn't set up", () => {
  const h = hub();
  // A hub that never set it up: only this machine in the pool, no model, never run.
  expect(h.app.pool.chatOffer()).toEqual({
    label: "Model pool",
    state: "off",
    detail: null,
    setUp: false,
    ready: false,
    model: null,
    modelName: null,
    // The main machine is in it even when its own GPU is left out: it holds the model and answers the chats.
    machines: ["Mac mini"],
    missing: [],
    accounts: {},
  });
  // It goes with the state every device loads, so the New chat menu has it without asking for the whole pool.
  expect(h.app.snapshot({ id: "d1", name: "Phone", platform: "Web", createdAt: 0, lastSeenAt: 0 }).pool).toEqual(h.app.pool.chatOffer());
});

test("a model chosen makes it something to start: the offer says the model, the machines and where", () => {
  const h = hub();
  h.app.pool.update({ model: tiny, machines: [selfMachine(true), computer(50052)] });
  const offer = h.app.pool.chatOffer();
  expect([offer.setUp, offer.ready, offer.state, offer.model, offer.modelName]).toEqual([true, false, "off", "tiny", "Tiny"]);
  // The main machine first, then the machines lending a GPU.
  expect(offer.machines).toEqual(["Mac mini", "Box"]);
  expect(offer.missing).toEqual([]);
  // The name chats see can be changed by hand (Advanced), and the offer follows it.
  h.app.pool.update({ alias: "tiny-two" });
  expect(h.app.pool.chatOffer().model).toBe("tiny-two");
  // A machine switched off isn't one the pool is waiting for.
  h.app.pool.update({ machines: [selfMachine(true), { ...computer(50052), enabled: false }] });
  expect(h.app.pool.chatOffer().machines).toEqual(["Mac mini"]);
  // Every change goes out as an offer event, so a phone with New chat open follows it.
  expect(h.offers.map((o) => o.model)).toContain("tiny-two");
});

test("a machine the pool needs that didn't answer is named in the offer", async () => {
  const h = hub();
  const dead = freePort(); // nothing listens there: the helper window is closed
  h.app.pool.update({ model: tiny, machines: [selfMachine(true), computer(dead)] });
  await h.app.pool.check();
  const offer = h.app.pool.chatOffer();
  expect(offer.missing).toEqual(["Box"]);
  expect(offer.setUp).toBe(true);
  expect(offer.ready).toBe(false);
  // A machine never checked is not "missing": nothing is known about it yet.
  const fresh = hub("Other");
  fresh.app.pool.update({ model: tiny, machines: [selfMachine(true), computer(dead)] });
  expect(fresh.app.pool.chatOffer().missing).toEqual([]);
}, SLOW);

test("running, the pool is a model to chat with: ready, its alias, its machines, an account per agent", async () => {
  const h = hub();
  const helper = helperListener();
  try {
    h.app.pool.update({ model: tiny, machines: [selfMachine(true), computer(helper.port)], port: freePort(), contextSize: 8192 });
    h.app.pool.start();
    expect((await settled(h)).state).toBe("running");
    const offer = h.app.pool.chatOffer();
    expect([offer.ready, offer.state, offer.model, offer.machines]).toEqual([true, "running", "tiny", ["Mac mini", "Box"]]);
    expect(Object.keys(offer.accounts).sort()).toEqual(["claude", "codex"]);
    // The entry's accounts are the pool's own custom-model accounts, both called "Model pool".
    for (const p of ["claude", "codex"] as const) {
      expect(h.app.providers.account(p, offer.accounts[p]!)).toMatchObject({ kind: "endpoint", label: "Model pool", endpoint: { models: ["tiny"] } });
    }
    // On its way there, the offer said so (so the entry can say "Starting…" rather than offering a chat).
    expect(h.offers.map((o) => o.state)).toContain("starting");
    expect(h.offers.filter((o) => o.ready).length).toBe(1);
    // A chat on it answers while it runs, and nothing refuses it.
    const room = h.app.chats.create({ provider: "claude", name: "Pool chat", cwd: join(work, "chats"), account: offer.accounts.claude, model: "tiny" });
    Agent.ran = 0;
    expect((await say(h, room.id, "hello")).at(-1)).toBe("agent:done:Answered on tiny");
    expect(Agent.ran).toBe(1);

    // Stopped, the accounts stay (the next start reuses them) and the offer says it isn't running.
    await h.app.pool.stop();
    const stopped = h.app.pool.chatOffer();
    expect([stopped.ready, stopped.state]).toEqual([false, "off"]);
    expect(stopped.accounts).toEqual(offer.accounts);
  } finally {
    helper.stop();
    await h.app.pool.stop().catch(() => {});
  }
}, SLOW);

test("a chat on a stopped pool says so in plain words with a way out, and keeps the message", async () => {
  const h = hub();
  const helper = helperListener();
  try {
    h.app.pool.update({ model: tiny, machines: [selfMachine(true), computer(helper.port)], port: freePort(), contextSize: 8192 });
    h.app.pool.start();
    expect((await settled(h)).state).toBe("running");
    const accounts = h.app.pool.chatOffer().accounts;
    const room = h.app.chats.create({ provider: "claude", name: "Pool chat", cwd: join(work, "chats"), account: accounts.claude, model: "tiny" });
    const member = h.app.store.listMembers(room.id)[0];
    await h.app.pool.stop();

    Agent.ran = 0;
    const messages = await say(h, room.id, "are you there?");
    // No agent was started at all: it would have failed on a refused connection and said so in the server's words.
    expect(Agent.ran).toBe(0);
    // The ways out it names are ones that exist: the pool's own screen, and the chat's Account (its model menu holds
    // the pool's one model, so "pick another model" there would be a dead end).
    expect(messages.at(-1)).toBe("agent:error:Model pool (tiny) isn't running, so this chat has no model to answer with. Start it again in Settings → Model pool, or move this chat to another account in its settings.");
    // The message is the user's again, unread, so Answer now (or Try again) answers it once the pool is back.
    expect(h.app.store.getLastSeen(member.id).seq).toBeLessThan(h.app.store.maxSeq(room.id));
    // A chat on the agent's own sign-in is never touched by the pool's state.
    const own = h.app.chats.create({ provider: "claude", name: "Own chat", cwd: join(work, "chats") });
    expect((await say(h, own.id, "hello")).at(-1)).toStartWith("agent:done:");
    expect(h.app.pool.chatProblem({ provider: "claude", config: {} })).toBeNull();

    // Still starting: it says to send it again once it's running, not that the pool is broken.
    h.app.pool.start();
    await until(() => h.app.pool.view().status.state !== "off", "the start to begin");
    const starting = h.app.pool.chatProblem({ provider: "claude", config: { account: accounts.claude } });
    expect(starting).toContain("Model pool (tiny) is still starting.");
    expect(starting).toContain("once it says Running");
    expect((await settled(h)).state).toBe("running");
  } finally {
    helper.stop();
    await h.app.pool.stop().catch(() => {});
  }
}, SLOW);

test("the pool going away under a running reply ends it in plain words, not a connection error", async () => {
  const h = hub();
  const helper = helperListener();
  try {
    h.app.pool.update({ model: tiny, machines: [selfMachine(true), computer(helper.port)], port: freePort(), contextSize: 8192 });
    h.app.pool.start();
    expect((await settled(h)).state).toBe("running");
    const accounts = h.app.pool.chatOffer().accounts;
    const room = h.app.chats.create({ provider: "claude", name: "Pool chat", cwd: join(work, "chats"), account: accounts.claude, model: "tiny" });
    // The pool is stopped while the reply runs (a machine dropping off ends the same way): the agent then fails on a
    // refused connection, in its own words, which nobody can act on.
    Agent.before = async () => {
      await h.app.pool.stop();
    };
    Agent.result = { ok: false, error: "API Error: fetch failed (ECONNREFUSED 127.0.0.1:9931)" };
    const messages = await say(h, room.id, "write me a haiku");
    Agent.before = null;
    Agent.result = { ok: true };
    const reply = messages.at(-1)!;
    expect(reply).toStartWith("agent:error:");
    expect(reply).toContain("Model pool (tiny) isn't running, so this chat has no model to answer with.");
    expect(reply).toContain("Start it again in Settings → Model pool, or move this chat to another account in its settings.");
    expect(reply).not.toContain("ECONNREFUSED");
    // The agent's status says the same thing, so the chat list says it too.
    expect(h.app.store.listMembers(room.id)[0].statusDetail).toContain("isn't running");
  } finally {
    helper.stop();
    Agent.before = null;
    Agent.result = { ok: true };
    await h.app.pool.stop().catch(() => {});
  }
}, SLOW);

test("the pool's model changing moves the chats on it, and the chat says so", async () => {
  const h = hub();
  const helper = helperListener();
  try {
    h.app.pool.update({ model: tiny, machines: [selfMachine(true), computer(helper.port)], port: freePort(), contextSize: 8192 });
    h.app.pool.start();
    expect((await settled(h)).state).toBe("running");
    const accounts = h.app.pool.chatOffer().accounts;
    const room = h.app.chats.create({ provider: "claude", name: "Pool chat", cwd: join(work, "chats"), account: accounts.claude, model: "tiny" });
    const member = h.app.store.listMembers(room.id)[0];
    await h.app.pool.stop();

    // Another model (here renamed, as Advanced does; choosing a model in Settings → Model pool changes the name the
    // same way), and the pool started again: the chat follows, because the pool serves one model at a time.
    h.app.pool.update({ alias: "tiny-two" });
    h.app.pool.start();
    expect((await settled(h)).state).toBe("running");
    expect(h.app.pool.chatOffer().model).toBe("tiny-two");
    expect(h.app.store.getMember(member.id)!.model).toBe("tiny-two");
    expect(said(h, room.id).at(-1)).toBe("system:done:Model pool now runs tiny-two, not tiny. This chat runs it too: the pool serves one model at a time.");
    // And it answers on the new model, with no stale name sent to the server.
    expect((await say(h, room.id, "still there?")).at(-1)).toBe("agent:done:Answered on tiny-two");
    // Started again with the same model, the chat is left alone (no note, nothing changed).
    const before = said(h, room.id).length;
    await h.app.pool.stop();
    h.app.pool.start();
    expect((await settled(h)).state).toBe("running");
    expect(said(h, room.id).length).toBe(before);
  } finally {
    helper.stop();
    await h.app.pool.stop().catch(() => {});
  }
}, SLOW);

test("the offer only goes out when it changed", async () => {
  const h = hub();
  h.app.pool.update({ model: tiny, machines: [selfMachine(true)] });
  const n = h.offers.length;
  expect(n).toBeGreaterThan(0);
  // The same settings again: the pool's own view event still goes out, but the offer hasn't changed.
  h.app.pool.update({ model: tiny, machines: [selfMachine(true)] });
  await Bun.sleep(600);
  expect(h.offers.length).toBe(n);
});

test("a view the app can read: the file list and the offer never throw on a pool with nothing in it", () => {
  const h = hub();
  const view: PoolView = h.app.pool.view();
  expect(view.status.accounts).toEqual({});
  // The offer is made from the same settings the screen shows.
  expect(h.app.pool.chatOffer().machines).toEqual([h.app.machineName()]);
  expect(readFileSync(fakeTailscale, "utf8").length).toBeGreaterThan(0); // the fake CLI is what the pool would ask
});
