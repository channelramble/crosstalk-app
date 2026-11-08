// Crosstalk's own agent when a reply doesn't end the usual way: Stop, Stop and answer, a hub that restarts mid-command, a
// message handed over at the last moment. What it used still counts, what's sent stays in the order a service takes, and
// what a command started stops with it. The model service is the stand-in Refuseless; nothing real is asked.
import { processGrace, processesEnding } from "../src/util/process";
import { TEXT_TOOL_CALL_NUDGE } from "../src/agents/toolText";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, Room } from "@crosstalk/shared";
import { registerDriver } from "../src/agents";
import { BuiltinDriver, sendable, type BuiltinDeps, type ChatMessage, type Saved } from "../src/agents/builtin";
import type { DriverContext, TurnSink } from "../src/agents/driver";
import { App } from "../src/app";
import { Bus } from "../src/bus";
import { RUN_DIR } from "../src/config";
import { Store } from "../src/db";
import { Engine } from "../src/engine/engine";
import { builtinProvider } from "../src/providers/builtin";
import { registerProvider } from "../src/providers/index";
import { newId } from "../src/util/ids";
import { fakeRefuseless, type RefuselessReply } from "./fixtures/fake-refuseless";
import { strictFetch } from "./fixtures/strict-service";

setDefaultTimeout(20_000);

const KEY = "abl_test_key_0001";
const MODEL = "deepseek-v4.1-flash-abliterated";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "ct-agent-stop-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rl(replies: RefuselessReply[]) {
  const fake = fakeRefuseless({ key: KEY, replies });
  cleanups.push(() => fake.stop());
  return fake;
}

const until = async (done: () => unknown, ms = 8000) => {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error(`Still not so after ${ms} ms: ${done}`);
    await Bun.sleep(10);
  }
};

/** Holds the model calls `holds` picks (numbered from 1) until the test lets them go, or the reply is stopped. `deaf` calls don't hear a stop. */
function holding(holds: (n: number) => boolean, o: { deaf?: boolean; next?: typeof fetch } = {}) {
  let n = 0;
  const waiting: (() => void)[] = [];
  const get = (async (url: string, init?: RequestInit) => {
    if (typeof init?.body === "string" && holds(++n)) {
      await new Promise<void>((go, no) => {
        waiting.push(go);
        if (!o.deaf) init.signal?.addEventListener("abort", () => no(new DOMException("Aborted", "AbortError")));
      });
    }
    return (o.next ?? fetch)(url, init);
  }) as unknown as typeof fetch;
  return { get, let: () => waiting.splice(0).forEach((go) => go()), letOldest: () => waiting.shift()?.(), held: () => waiting.length };
}

/** A one-agent chat on a hub of its own, on the stand-in. */
async function chatOn(fake: { base: string }, o: { mode?: string; deps?: BuiltinDeps } = {}) {
  registerProvider(builtinProvider);
  registerDriver("builtin", (ctx) => new BuiltinDriver(ctx, { browserUrl: async () => null, ...o.deps }));
  const dir = folder();
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  cleanups.push(() => app.shutdown());
  await app.providers.refresh("builtin");
  const account = app.providers.setEndpointAccount("builtin", { label: "Refuseless", baseUrl: fake.base, apiKey: KEY, models: [MODEL], contextWindow: 1_048_576, protocol: "chat" });
  const room = app.chats.create({ provider: "builtin", account: account.id, model: MODEL, permissionMode: o.mode ?? "full", cwd: dir } as never);
  const member = app.store.listMembers(room.id)[0];
  /** The conversation as it's kept, each message by its role. */
  const kept = (): Saved => JSON.parse(readFileSync(join(RUN_DIR, "builtin", member.id, `${String(app.store.getMemberSession(member.id).builtinConversation)}.json`), "utf8")) as Saved;
  const ledger = () => app.store.db.query("SELECT input_tokens AS input, output_tokens AS output FROM spend_ledger").all() as { input: number; output: number }[];
  return { app, room, member, dir, kept, ledger };
}

const rolesOf = (messages: ChatMessage[]) => messages.map((m) => (m.role === "user" ? `user: ${m.content}` : m.tool_calls ? "calls" : m.role));

function sinkFor(decisions: ApprovalDecision[] = []) {
  const ac = new AbortController();
  const out = { text: "", approvals: 0, usage: [] as { inputTokens?: number; outputTokens?: number }[], stop: () => ac.abort() };
  const sink: TurnSink = {
    text: (d) => void (out.text += d),
    setText: (t) => void (out.text = t),
    activity: () => "a",
    updateActivity: () => {},
    // A card ends with the reply, or when the driver gives up on it, as it does under the engine.
    approval: (_req, opts) =>
      new Promise((res) => {
        out.approvals++;
        const decision = decisions.shift();
        if (decision) return res(decision);
        ac.signal.addEventListener("abort", () => res("deny"));
        opts?.signal?.addEventListener("abort", () => res("deny"));
      }),
    usage: (u) => void out.usage.push(u),
    rateLimit: () => {},
    status: () => {},
    saveSession: () => {},
    newReply: () => {},
    heartbeat: () => {},
    taken: () => {},
    signal: ac.signal,
  };
  return { sink, out };
}

/** A driver on its own, its conversation in `cwd`/.run under the member's own name, the session unused. */
function driverOn(fake: { base: string }, cwd: string, deps: BuiltinDeps = {}, o: { mode?: string; memberId?: string } = {}) {
  const ctx = {
    room: { id: "r1", cwd, name: "Agent test" },
    member: { id: o.memberId ?? "mb-rl", provider: "builtin", model: MODEL, permissionMode: o.mode ?? "full", config: {} },
    session: {},
    mcp: { command: "", args: [], env: {} },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
    bin: "",
    chat: null,
    endpoint: { id: "rl", label: "Refuseless", baseUrl: fake.base, models: [MODEL], contextWindow: 1_048_576, key: KEY },
  } as unknown as DriverContext;
  const d = new BuiltinDriver(ctx, { browserUrl: async () => null, runDir: join(cwd, ".run"), ...deps });
  cleanups.push(() => d.dispose());
  return d;
}

const turn = (prompt: string, ids: string[] = []) => ({ turnId: `t-${prompt.slice(0, 8)}`, prompt, systemNote: null, messageIds: ids });
const run = (command: string, extra: Record<string, unknown> = {}): RefuselessReply => ({ calls: [{ name: "run_command", args: { command, ...extra } }] });

/** The conversation a driver finds on disk, as an earlier version or an earlier process left it. */
function leftBehind(cwd: string, messages: ChatMessage[], turns: Saved["turns"], memberId = "mb-rl") {
  mkdirSync(join(cwd, ".run", "builtin"), { recursive: true });
  const file = join(cwd, ".run", "builtin", `${memberId}.json`);
  writeFileSync(file, JSON.stringify({ v: 1, messages, turns }));
  return () => JSON.parse(readFileSync(file, "utf8")) as Saved;
}
const call = (id: string, command = "echo hi"): ChatMessage["tool_calls"] => [{ id, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command }) } }];
const answerTo = (id: string, content = "hi\n[exit code 0]"): ChatMessage => ({ role: "tool", tool_call_id: id, content });

// ------------------------------------------------------------------------------------- the order of what's sent

test("what's sent: a well-formed conversation goes as it is, and each kind of disorder comes out as a service takes it", () => {
  const good: ChatMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: call("c1") }, answerTo("c1"), { role: "assistant", content: "done" }, { role: "user", content: "b" }];
  expect(sendable(good)).toEqual(good);
  // The answer landed after the next message: it moves up, and the new message stays after it.
  expect(rolesOf(sendable([{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: call("c1") }, { role: "user", content: "b" }, answerTo("c1")]))).toEqual(["user: a", "calls", "tool", "user: b"]);
  // No answer at all: one that says what's known, which isn't that it finished.
  const missing = sendable([{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: call("c1") }, { role: "user", content: "b" }]);
  expect(missing[2]).toEqual({ role: "tool", tool_call_id: "c1", content: expect.stringContaining("Not known to have finished") });
  // An answer with no call (a rewind cut the call, and the answer came after): gone.
  expect(rolesOf(sendable([{ role: "user", content: "a" }, answerTo("c9"), { role: "user", content: "b" }]))).toEqual(["user: a", "user: b"]);
  // Two calls of the same id (some services number them afresh), in one answer or in two: each gets its own answer.
  const twice = sendable([{ role: "assistant", content: null, tool_calls: call("c1") }, answerTo("c1", "first"), { role: "assistant", content: null, tool_calls: [...call("c1")!, ...call("c1")!] }, answerTo("c1", "second"), answerTo("c1", "third")]);
  expect(twice.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["first", "second", "third"]);
});

test("Stop and answer my message during a command: its answer goes in first, the new reply goes through, and so does the next", async () => {
  const fake = rl([run("touch started; sleep 31; echo late"), { text: "Answered the second." }, { text: "Answered the third." }]);
  const strict = strictFetch();
  const h = await chatOn(fake, { deps: { fetch: strict.get } });
  h.app.engine.postHumanMessage(h.room.id, "First", "Phone");
  await until(() => existsSync(join(h.dir, "started")));
  h.app.engine.postHumanMessage(h.room.id, "Second", "Phone");
  await h.app.engine.stop(h.room.id, undefined, { keepWaiting: true });
  // By the time Stop has finished, the command's own ending is what's kept after its call.
  expect(rolesOf(h.kept().messages).slice(0, 3)).toEqual(["user: First", "calls", "tool"]);
  expect(h.kept().messages[2].content).toContain("[Stopped by the user.]");
  await h.app.engine.whenIdle();
  expect(strict.refused).toEqual([]);
  expect(rolesOf(h.kept().messages)).toEqual(["user: First", "calls", "tool", "user: Second", "assistant"]);
  h.app.engine.postHumanMessage(h.room.id, "Third", "Phone");
  await h.app.engine.whenIdle();
  expect(strict.refused).toEqual([]);
  expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("Answered the third.");
});

test("Stop then Edit around a command that ignores SIGTERM: all of it is killed, and no late answer lands after the edit", async () => {
  const fake = rl([run("trap '' TERM; touch started; sh -c 'echo $$ > stubborn.pid; exec sleep 31'; echo late"), { text: "Answered the edit." }, { text: "Answered the next." }]);
  const strict = strictFetch();
  const h = await chatOn(fake, { deps: { fetch: strict.get } });
  const first = h.app.engine.postHumanMessage(h.room.id, "First", "Phone");
  await until(() => existsSync(join(h.dir, "stubborn.pid")));
  const pid = Number(readFileSync(join(h.dir, "stubborn.pid"), "utf8"));
  await h.app.engine.stop(h.room.id);
  // The group's SIGKILL came, and the reply had ended before Stop came back.
  await until(() => !alive(pid), 2000);
  await h.app.engine.reviseMessage(first.id, "First, edited", "Phone");
  await h.app.engine.whenIdle();
  h.app.engine.postHumanMessage(h.room.id, "Next", "Phone");
  await h.app.engine.whenIdle();
  expect(strict.refused).toEqual([]);
  expect(rolesOf(h.kept().messages)).toEqual(["user: First, edited", "assistant", "user: Next", "assistant"]);
});

test("a reply stuck past the wait for it holds up nothing, and when it does end it doesn't end the reply after it", async () => {
  const fake = rl([{ text: "A first answer." }, { text: "And an answer to what was handed over." }]);
  const gate = holding((n) => n <= 2, { deaf: true });
  const d = driverOn(fake, folder(), { fetch: gate.get });
  const first = sinkFor();
  const stuck = d.runTurn(turn("First"), first.sink);
  await until(() => gate.held() === 1);
  first.out.stop();
  const started = Date.now();
  await d.interrupt();
  expect(Date.now() - started).toBeLessThan(4000);
  const second = sinkFor();
  const next = d.runTurn(turn("Second"), second.sink);
  await until(() => gate.held() === 2);
  // The stuck one ends while the new one waits for the model: what's handed over is the new one's, before and after that.
  expect(await d.steer("Handed over", ["m2"])).toBe(true);
  gate.letOldest();
  expect(await stuck).toEqual({ ok: false, error: "stopped" });
  expect(await d.steer("And this", ["m3"])).toBe(true);
  expect(d.canEndWhenIdle()).toBe(false);
  gate.let();
  expect(await next).toEqual({ ok: true });
  expect(d.canEndWhenIdle()).toBe(true);
  expect(fake.state.chats).toHaveLength(2);
  expect(rolesOf(fake.state.chats[1].messages).slice(-2)).toEqual(["user: Handed over", "user: And this"]);
});

// ------------------------------------------------------------------------------------- a hub that stopped mid-command

test("a hub that stopped during a command: the chat goes on, /compact too, and what's kept and its rewind points don't move", async () => {
  const cwd = folder();
  const before: ChatMessage[] = [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Fine." }, { role: "user", content: "Run it" }, { role: "assistant", content: null, tool_calls: call("c1") }];
  const disk = leftBehind(cwd, before, [{ at: 0, ids: ["m1"] }, { at: 2, ids: ["m2"] }]);
  const fake = rl([{ text: "Checked, carrying on." }, { text: "SUMMARY" }, { text: "After the summary." }]);
  const strict = strictFetch();
  const d = driverOn(fake, cwd, { fetch: strict.get });
  expect(await d.runTurn(turn("Crosstalk restarted. Carry on.", ["m3"]), sinkFor().sink)).toEqual({ ok: true });
  expect(strict.refused).toEqual([]);
  const sent = fake.state.chats[0].messages;
  expect(sent[4]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1" }] });
  expect(sent[5]).toEqual({ role: "tool", tool_call_id: "c1", content: expect.stringContaining("Check before repeating it") });
  // Kept as it was: no answer was made up in the file, so "m3" is still where it went in.
  expect(disk().messages.slice(0, 4)).toEqual(before);
  expect(disk().turns.map((t) => t.at)).toEqual([0, 2, 4]);
  const { sink, out } = sinkFor();
  expect(await d.runTurn(turn("/compact"), sink)).toEqual({ ok: true });
  expect(out.text).toBe("Done: the conversation so far is summarised, and the chat goes on from the summary.");
  expect(strict.refused).toEqual([]);
});

test("a hub that stopped between three calls of one answer: the first answer is kept, the others go as not known", async () => {
  const cwd = folder();
  const calls = [...call("c1")!, ...call("c2")!, ...call("c3")!];
  leftBehind(cwd, [{ role: "user", content: "Go" }, { role: "assistant", content: null, tool_calls: calls }, answerTo("c1", "the first ran")], [{ at: 0, ids: [] }]);
  const fake = rl([{ text: "Carrying on." }]);
  const strict = strictFetch();
  expect(await driverOn(fake, cwd, { fetch: strict.get }).runTurn(turn("Carry on"), sinkFor().sink)).toEqual({ ok: true });
  expect(strict.refused).toEqual([]);
  const answers = fake.state.chats[0].messages.filter((m: ChatMessage) => m.role === "tool");
  expect(answers.map((m: ChatMessage) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
  expect(answers[0].content).toBe("the first ran");
  expect(answers[2].content).toContain("Not known to have finished");
});

test("chats already saved out of order work again, with nothing for the person to do", async () => {
  for (const [name, messages] of Object.entries<ChatMessage[]>({
    "Stop and answer": [{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: call("c1") }, { role: "user", content: "b" }, answerTo("c1"), { role: "assistant", content: "ok" }],
    "an edit that left the call": [{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: call("c1") }, { role: "user", content: "b" }],
    "an answer left by a rewind": [{ role: "user", content: "a" }, answerTo("c1"), { role: "assistant", content: "ok" }],
  })) {
    const cwd = folder();
    leftBehind(cwd, messages, [{ at: 0, ids: [] }]);
    const fake = rl([{ text: "Fine." }]);
    const strict = strictFetch();
    expect([name, await driverOn(fake, cwd, { fetch: strict.get }).runTurn(turn("Next"), sinkFor().sink)]).toEqual([name, { ok: true }]);
    expect(strict.refused).toEqual([]);
  }
});

test("the hub restarting during a command isn't said as the user's doing, nor a card it closed as the user declining", async () => {
  const cwd = folder();
  const fake = rl([{ calls: [{ name: "run_command", args: { command: "touch started; sleep 31" } }, { name: "run_command", args: { command: "touch never" } }] }]);
  const d = driverOn(fake, cwd);
  const running = d.runTurn(turn("Go"), sinkFor().sink);
  await until(() => existsSync(join(cwd, "started")));
  await d.dispose();
  await running;
  const kept = JSON.parse(readFileSync(join(cwd, ".run/builtin/mb-rl.json"), "utf8")) as Saved;
  expect(kept.messages.at(-2)?.content).toContain("[Stopped because Crosstalk restarted.]");
  expect(kept.messages.at(-1)?.content).toBe("Not run: Crosstalk restarted first.");

  const cwd2 = folder();
  const fake2 = rl([run("touch never")]);
  const d2 = driverOn(fake2, cwd2, {}, { mode: "ask", memberId: "mb-2" });
  const { sink, out } = sinkFor();
  const waiting = d2.runTurn(turn("Go"), sink);
  await until(() => out.approvals === 1);
  await d2.dispose();
  await waiting;
  const kept2 = JSON.parse(readFileSync(join(cwd2, ".run/builtin/mb-2.json"), "utf8")) as Saved;
  expect(kept2.messages.at(-1)?.content).toBe("Not run: Crosstalk restarted before the user answered.");
});

// ------------------------------------------------------------------------------------- what a stopped reply used

test("Stop during a command: Costs has the model calls it made, once", async () => {
  const fake = rl([run("echo one"), run("echo two"), run("touch started; sleep 31")]);
  const h = await chatOn(fake);
  h.app.engine.postHumanMessage(h.room.id, "Go", "Phone");
  await until(() => existsSync(join(h.dir, "started")));
  await h.app.engine.stop(h.room.id);
  await h.app.engine.whenIdle();
  expect(h.ledger()).toEqual([{ input: 3000, output: 150 }]);
});

test("Stop during a model call: the calls before it, and the one in flight at four characters a token", async () => {
  const fake = rl([run("echo one"), run("echo two"), { text: "Never read." }]);
  const gate = holding((n) => n === 3);
  const h = await chatOn(fake, { deps: { fetch: gate.get } });
  h.app.engine.postHumanMessage(h.room.id, "Go", "Phone");
  await until(() => gate.held() === 1);
  await h.app.engine.stop(h.room.id);
  await h.app.engine.whenIdle();
  const [row, ...more] = h.ledger();
  expect(more).toEqual([]);
  // The request's few thousand characters are on top of the two calls' 2000 tokens, and nothing came back of this one.
  expect(row.input).toBeGreaterThan(2000);
  expect(row.input).toBeLessThan(10_000);
  expect(row.output).toBe(100);
});

test("a reply stopped during its only model call isn't free, and one stopped while a busy model is waited out books nothing for it", async () => {
  const only = rl([{ text: "Never read." }]);
  const gate = holding(() => true);
  const h = await chatOn(only, { deps: { fetch: gate.get } });
  h.app.engine.postHumanMessage(h.room.id, "Go", "Phone");
  await until(() => gate.held() === 1);
  await h.app.engine.stop(h.room.id);
  await h.app.engine.whenIdle();
  expect(h.ledger()).toHaveLength(1);
  expect(h.ledger()[0].input).toBeGreaterThan(500);

  const busy = rl([{ status: 429, code: "model_busy", error: "Model is busy.", retryAfter: "15" }]);
  const h2 = await chatOn(busy);
  h2.app.engine.postHumanMessage(h2.room.id, "Go", "Phone");
  await until(() => h2.app.store.getMember(h2.member.id)?.statusDetail?.includes("trying again"));
  await h2.app.engine.stop(h2.room.id);
  await h2.app.engine.whenIdle();
  expect(h2.ledger()).toEqual([]);
});

test("a reply that isn't stopped books each call once, whatever the running totals said on the way", async () => {
  const fake = rl([run("echo one"), { text: "Done." }]);
  const h = await chatOn(fake);
  h.app.engine.postHumanMessage(h.room.id, "Go", "Phone");
  await h.app.engine.whenIdle();
  expect(h.ledger()).toEqual([{ input: 2000, output: 100 }]);
});

test("the running totals say a summary's tokens as soon as it's made", async () => {
  const steps: RefuselessReply[] = [...Array.from({ length: 5 }, (_, i) => run(`echo ${i}`)), { ...run("echo big"), usage: { prompt: 260_000, completion: 0 } }];
  const fake = rl([...steps, { text: "SUMMARY", usage: { prompt: 7000, completion: 70 } }, { text: "Done." }]);
  const { sink, out } = sinkFor();
  const seen: number[] = [];
  const asked = (async (url: string, init?: RequestInit) => {
    seen.push(out.usage.at(-1)?.inputTokens ?? 0);
    return fetch(url, init);
  }) as unknown as typeof fetch;
  await driverOn(fake, folder(), { fetch: asked }).runTurn(turn("Work"), sink);
  // Before the call after the summary, the summary's 7000 are already in what's been said.
  const beforeSummary = seen[6];
  expect(seen[7]).toBe(beforeSummary + 7000);
});

test("under the engine's watchdog: a reply that hangs on its third model call still books the two before it", async () => {
  const fake = rl([run("echo one"), run("echo two"), { text: "Never read." }, { text: "The retry." }]);
  const gate = holding((n) => n === 3);
  const cwd = folder();
  const booked: { input: number; output: number }[] = [];
  const store = new Store(":memory:");
  const deps: Partial<ConstructorParameters<typeof Engine>[0]> = { recordUsage: (_room, _member, _turn, u) => void booked.push({ input: u.inputTokens, output: u.outputTokens }) };
  const engine = new Engine({ store, bus: new Bus(), stallMs: 300, createDriver: () => driverOn(fake, cwd, { fetch: gate.get }), mcpLaunch: () => ({ command: "true", args: [], env: {} }), ...deps });
  cleanups.push(() => engine.shutdown());
  const now = Date.now();
  const room: Room = { id: newId("r"), name: "R", cwd, mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  store.insertRoom(room);
  store.insertMember({ id: newId("mb"), roomId: room.id, handle: "agent", provider: "builtin", model: MODEL, role: "", permissionMode: "full", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
  engine.postHumanMessage(room.id, "Go", "Phone");
  await until(() => booked.length > 0);
  expect(booked[0]).toEqual({ input: 2000, output: 100 });
  gate.let();
  await engine.whenIdle();
});

// ------------------------------------------------------------------------------------- Send now

test("Send now during the reply's last answer: read and answered in the same turn, in order, and it can be taken back", async () => {
  const fake = rl([{ text: "First answer." }, { text: "Second answer." }]);
  const gate = holding((n) => n === 1);
  const h = await chatOn(fake, { deps: { fetch: gate.get } });
  h.app.engine.postHumanMessage(h.room.id, "First question", "Phone");
  await until(() => gate.held() === 1);
  const second = h.app.engine.postHumanMessage(h.room.id, "Second question", "Phone");
  expect(await h.app.engine.sendNowWhy(h.room.id)).toEqual({ sent: true });
  gate.let();
  await h.app.engine.whenIdle();
  expect(fake.state.chats).toHaveLength(2);
  expect(rolesOf(fake.state.chats[1].messages).slice(1)).toEqual(["user: First question", "assistant", "user: Second question"]);
  expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("Second answer.");
  // It went in with its turn, so it can be unsent: not "that message isn't in this conversation any more".
  await h.app.engine.reviseMessage(second.id, null, "Phone");
  expect(rolesOf(h.kept().messages)).toEqual([]);
});

test("Send now keeps the other reasons to go on: a cut-off answer is still told to continue, and a leaked call still told it didn't run", async () => {
  const cutOff = rl([{ text: "Half", finish: "length" }, { text: " of it." }]);
  const gate = holding((n) => n === 1);
  const d = driverOn(cutOff, folder(), { fetch: gate.get });
  const running = d.runTurn(turn("Go"), sinkFor().sink);
  await until(() => gate.held() === 1);
  expect(await d.steer("And this", ["m2"])).toBe(true);
  gate.let();
  await running;
  expect(rolesOf(cutOff.state.chats[1].messages).slice(1)).toEqual(["user: Go", "assistant", "user: Your answer was cut off by the output limit. Continue exactly where it stopped.", "user: And this"]);
  const leak = rl([{ text: 'Calling.\n<｜DSML｜invoke name="read_file">' }, { text: "Done." }]);
  const held = holding((n) => n === 1);
  const again = driverOn(leak, folder(), { fetch: held.get });
  const second = again.runTurn(turn("Go"), sinkFor().sink);
  await until(() => held.held() === 1);
  expect(await again.steer("And this", ["m2"])).toBe(true);
  held.let();
  await second;
  expect(rolesOf(leak.state.chats[1].messages).slice(1)).toEqual(["user: Go", "assistant", `user: ${TEXT_TOOL_CALL_NUDGE}`, "user: And this"]);
});

test("Send now during /compact isn't taken: the waiting turn answers the message once the summary is made", async () => {
  const work = Array.from({ length: 5 }, (_, i) => run(`echo ${i}`));
  const fake = rl([...work, { text: "Done." }, { text: "SUMMARY" }, { text: "The answer." }]);
  const gate = holding((n) => n === 7);
  const h = await chatOn(fake, { deps: { fetch: gate.get } });
  h.app.engine.postHumanMessage(h.room.id, "Work", "Phone");
  await h.app.engine.whenIdle();
  h.app.engine.postHumanMessage(h.room.id, "/compact", "Phone");
  await until(() => gate.held() === 1);
  h.app.engine.postHumanMessage(h.room.id, "A question", "Phone");
  // Not "ended": the reply goes on until the summary is made.
  expect(await h.app.engine.sendNowWhy(h.room.id)).toEqual({ sent: false, why: "unsupported" });
  gate.let();
  await h.app.engine.whenIdle();
  expect(fake.state.chats[6].stream).toBe(false);
  expect(fake.state.chats[7].messages.at(-1)).toEqual({ role: "user", content: "A question" });
  expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("The answer.");
});

test("Send now as a /compact starts, before it has shown anything: it says the message waits for the reply after it, never to try again", async () => {
  const work = Array.from({ length: 5 }, (_, i) => run(`echo ${i}`));
  const fake = rl([...work, { text: "Done." }, { text: "SUMMARY" }, { text: "The answer." }]);
  let hold: Promise<void> | null = null;
  let open = () => {};
  // What a reply waits for before its first step: whether BrowserOS neo is there.
  const h = await chatOn(fake, { deps: { browserUrl: async () => (await hold, null) } });
  h.app.engine.postHumanMessage(h.room.id, "Work", "Phone");
  await h.app.engine.whenIdle();
  hold = new Promise<void>((go) => (open = go));
  h.app.engine.postHumanMessage(h.room.id, "/compact", "Phone");
  await until(() => h.app.store.listTurns(h.room.id).at(-1)?.status === "running");
  h.app.engine.postHumanMessage(h.room.id, "A question", "Phone");
  expect(await h.app.engine.sendNowWhy(h.room.id)).toEqual({ sent: false, why: "unsupported" });
  open();
  await h.app.engine.whenIdle();
  expect(fake.state.chats.at(-1)!.messages.at(-1)).toEqual({ role: "user", content: "A question" });
  expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("The answer.");
});

test("a message handed over and not read before a Stop or a failure is handed back: not in the conversation, on disk or in the next request, and never handed back twice", async () => {
  const fake = rl([{ text: "Answered the next one." }]);
  const gate = holding((n) => n === 1);
  const cwd = folder();
  const d = driverOn(fake, cwd, { fetch: gate.get });
  const first = sinkFor();
  const running = d.runTurn(turn("First", ["m1"]), first.sink);
  await until(() => gate.held() === 1);
  expect(await d.steer("Handed over", ["m2"])).toBe(true);
  first.out.stop();
  expect(await running).toEqual({ ok: false, error: "stopped" });
  // The engine makes it unread again by this (Engine.giveBack): the hub's word on what's been read is the one that counts,
  // so a fresh session or another account gets it too, and it is never in the conversation as well as delivered again.
  expect(d.takeUnread()).toEqual(["m2"]);
  expect(d.takeUnread()).toEqual([]);
  expect(rolesOf((JSON.parse(readFileSync(join(cwd, ".run/builtin/mb-rl.json"), "utf8")) as Saved).messages)).toEqual(["user: First"]);
  await d.runTurn(turn("Next", ["m3"]), sinkFor().sink);
  expect(rolesOf(fake.state.chats.at(-1)!.messages).slice(1)).toEqual(["user: First", "user: Next"]);

  // A failure mid-answer does the same.
  const broke = rl([{ text: "Half an ans", streamError: { code: "insufficient_credits", message: "Credits ran out." } }, { text: "Fine now." }]);
  const gate2 = holding((n) => n === 1);
  const d2 = driverOn(broke, folder(), { fetch: gate2.get }, { memberId: "mb-2" });
  const failing = d2.runTurn(turn("First"), sinkFor().sink);
  await until(() => gate2.held() === 1);
  await d2.steer("Handed over", ["m2"]);
  gate2.let();
  expect((await failing).ok).toBe(false);
  expect(d2.takeUnread()).toEqual(["m2"]);
  await d2.runTurn(turn("Next"), sinkFor().sink);
  expect(rolesOf(broke.state.chats.at(-1)!.messages).slice(1)).toEqual(["user: First", "user: Next"]);
});

test("through the hub: stopped before it read the message, it's unread again and the next message brings it along, once", async () => {
  // The stopped request never reaches the stand-in, so this is the answer to the next one.
  const fake = rl([{ text: "Both answered." }]);
  const gate = holding((n) => n === 1);
  const h = await chatOn(fake, { deps: { fetch: gate.get } });
  h.app.engine.postHumanMessage(h.room.id, "First question", "Phone");
  await until(() => gate.held() === 1);
  const second = h.app.engine.postHumanMessage(h.room.id, "Second question", "Phone");
  expect(await h.app.engine.sendNowWhy(h.room.id)).toEqual({ sent: true });
  await h.app.engine.stop(h.room.id);
  gate.let();
  await h.app.engine.whenIdle();
  expect(h.app.store.getLastSeen(h.member.id).seq).toBeLessThan(h.app.store.messageSeq(second.id));
  expect(rolesOf(h.kept().messages)).toEqual(["user: First question"]);
  h.app.engine.postHumanMessage(h.room.id, "Third question", "Phone");
  await h.app.engine.whenIdle();
  // Once each, in order: the stopped request's copy isn't kept, and the next one is the first to carry the message.
  const said = fake.state.chats.at(-1)!.messages.map((m: { role: string; content: string }) => m.content).join("\n");
  expect(said.split("Second question")).toHaveLength(2);
  expect(said.indexOf("First question")).toBeLessThan(said.indexOf("Second question"));
  expect(said.indexOf("Second question")).toBeLessThan(said.indexOf("Third question"));
  expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("Both answered.");
});

test("through the hub: a fresh session after a failure still gets the message its reply never read: it was never counted read", async () => {
  const fake = rl([{ status: 400, code: "bad_request", error: "No." }, { text: "Answered it." }]);
  const gate = holding((n) => n === 1);
  const h = await chatOn(fake, { deps: { fetch: gate.get } });
  h.app.engine.postHumanMessage(h.room.id, "First question", "Phone");
  await until(() => gate.held() === 1);
  h.app.engine.postHumanMessage(h.room.id, "Second question", "Phone");
  expect(await h.app.engine.sendNowWhy(h.room.id)).toEqual({ sent: true });
  gate.let();
  await h.app.engine.whenIdle();
  expect(h.app.store.listTurns(h.room.id).map((t) => t.status)).toContain("error");
  await h.app.engine.resetSession(h.member);
  h.app.engine.retry(h.room.id);
  await h.app.engine.whenIdle();
  // Kept in the old conversation and counted read, it would have gone with that conversation.
  expect(rolesOf(fake.state.chats.at(-1)!.messages).slice(1)).toEqual(["user: Second question"]);
  expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("Answered it.");
});

test("through the hub: one handed over and never read is edited like any unread message, with no rewind: the edit is what goes", async () => {
  const fake = rl([{ text: "The edit answered." }]);
  const gate = holding((n) => n === 1);
  const h = await chatOn(fake, { deps: { fetch: gate.get } });
  h.app.engine.postHumanMessage(h.room.id, "First question", "Phone");
  await until(() => gate.held() === 1);
  const second = h.app.engine.postHumanMessage(h.room.id, "Second question", "Phone");
  expect(await h.app.engine.sendNowWhy(h.room.id)).toEqual({ sent: true });
  await h.app.engine.stop(h.room.id);
  gate.let();
  await h.app.engine.whenIdle();
  const revised = await h.app.engine.reviseMessage(second.id, "Second, edited", "Phone");
  expect(revised).toMatchObject({ removed: [], sent: { id: second.id, text: "Second, edited" } });
  await h.app.engine.whenIdle();
  expect(rolesOf(fake.state.chats.at(-1)!.messages).slice(1)).toEqual(["user: First question", "user: Second, edited"]);
});

// ------------------------------------------------------------------------------------- what a command started

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const [name, command] of [
  ["a pipeline", "sh -c 'echo $$ > p.pid; exec sleep 37' | tail -1"],
  ["a list", "sh -c 'echo $$ > p.pid; exec sleep 37'; echo late"],
  ["an and-list", "cd . && sh -c 'echo $$ > p.pid; exec sleep 37' && echo ok"],
] as const) {
  test(`Stop ends all of ${name}, not only its shell`, async () => {
    const cwd = folder();
    const fake = rl([run(command)]);
    const { sink, out } = sinkFor();
    const running = driverOn(fake, cwd).runTurn(turn("Go"), sink);
    await until(() => existsSync(join(cwd, "p.pid")) && readFileSync(join(cwd, "p.pid"), "utf8").trim());
    const pid = Number(readFileSync(join(cwd, "p.pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    out.stop();
    await running;
    await until(() => !alive(pid), 2000);
  });
}

test("the time limit ends what ignores its first signal too, and doesn't call that something left in the background", async () => {
  const cwd = folder();
  const fake = rl([run("sh -c 'trap \"\" TERM; echo $$ > p.pid; sleep 37'; echo after", { timeout_seconds: 1 }), { text: "It timed out." }]);
  expect(await driverOn(fake, cwd).runTurn(turn("Go"), sinkFor().sink)).toEqual({ ok: true });
  expect(String(fake.state.chats[1].messages.at(-1).content).trim()).toBe("[Stopped after 1 seconds.]");
  await until(() => !alive(Number(readFileSync(join(cwd, "p.pid"), "utf8"))), 4000);
});

test("the time limit ends all of a pipeline too, and says only that it stopped it", async () => {
  const cwd = folder();
  const fake = rl([run("sh -c 'echo $$ > p.pid; exec sleep 37' | tail -1", { timeout_seconds: 1 }), { text: "It timed out." }]);
  expect(await driverOn(fake, cwd).runTurn(turn("Go"), sinkFor().sink)).toEqual({ ok: true });
  expect(String(fake.state.chats[1].messages.at(-1).content).trim()).toBe("[Stopped after 1 seconds.]");
  await until(() => !alive(Number(readFileSync(join(cwd, "p.pid"), "utf8"))), 2000);
});

// What the last review of these found.

test("a redirect to something that isn't a web address isn't followed, whatever the permission, and raw UTF-8 in a redirect goes where it says", async () => {
  const dir = folder();
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "LOCAL-FILE-MARKER");
  const seen: string[] = [];
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (path === "/file") return new Response("", { status: 302, headers: { location: `file://127.0.0.1${secret}` } });
      if (path === "/data") return new Response("", { status: 302, headers: { location: `data:text/plain;base64,${btoa("DATA-MARKER")}` } });
      if (path === "/menu") return new Response("", { status: 301, headers: { location: Buffer.from("/caf\u00e9/menu", "utf8").toString("latin1") } });
      return new Response(`you got ${path}`);
    },
  });
  cleanups.push(() => site.stop(true));
  const base = `http://127.0.0.1:${site.port}`;
  const fetchOf = (path: string): RefuselessReply => ({ calls: [{ name: "fetch_url", args: { url: `${base}${path}` } }] });
  const fake = rl([fetchOf("/file"), fetchOf("/data"), fetchOf("/menu"), { text: "Done." }]);
  const d = driverOn(fake, dir, {}, { mode: "full" });
  await d.runTurn(turn("Go"), sinkFor().sink);
  const sent = JSON.stringify(fake.state.chats);
  expect(sent).not.toContain("LOCAL-FILE-MARKER");
  expect(sent).not.toContain("DATA-MARKER");
  expect(sent).toContain("which isn't an http or https address");
  expect(seen).toContain("/caf%C3%A9/menu");
});

test("Stop during a summary's request books what it sent", async () => {
  // Enough of a conversation that there's something before the last few messages to summarise.
  const fake = rl([run("echo a"), run("echo b"), run("echo c"), run("echo d"), run("echo e"), { text: "An answer.", usage: { prompt: 6000, completion: 300 } }, { text: "Never seen." }]);
  const gate = holding((n) => n === 7);
  const d = driverOn(fake, folder(), { fetch: gate.get }, { mode: "full" });
  await d.runTurn(turn("Work"), sinkFor().sink);
  const { sink, out } = sinkFor();
  const running = d.runTurn(turn("/compact"), sink);
  await until(() => gate.held() === 1);
  out.stop();
  await running;
  expect(out.usage.at(-1)!.inputTokens).toBeGreaterThan(0);
});

test("a call left unanswered isn't given the answer of a later call with the same id", () => {
  const messages: ChatMessage[] = [{ role: "assistant", content: "", tool_calls: call("call_0", "long-build") }, { role: "user", content: "Then?" }, { role: "assistant", content: "", tool_calls: call("call_0", "git status") }, answerTo("call_0", "clean")];
  const sent = sendable(messages);
  expect(sent.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([expect.stringContaining("Not known to have finished"), "clean"]);
});

test("what a stopped command left running after ignoring the signal is ended, and a hub shutting down waits for that", async () => {
  const dir = folder();
  const fake = rl([run(`sh -c 'trap "" TERM; echo $$ > p.pid; exec sleep 37'; echo after`), { text: "Done." }]);
  const d = driverOn(fake, dir, {}, { mode: "full" });
  const { sink, out } = sinkFor();
  const running = d.runTurn(turn("Go"), sink);
  await until(() => existsSync(join(dir, "p.pid")) && readFileSync(join(dir, "p.pid"), "utf8").trim());
  const pid = Number(readFileSync(join(dir, "p.pid"), "utf8").trim());
  processGrace.ms = 300;
  out.stop();
  await running;
  await processesEnding();
  processGrace.ms = 3000;
  await until(() => !alive(pid));
  expect(alive(pid)).toBe(false);
});

test("a message sent while Start fresh waits for a slow-dying command waits for the fresh session", async () => {
  const fake = rl([run("trap '' TERM; touch started; sleep 3; sleep 37"), { text: "On the fresh session." }]);
  const h = await chatOn(fake);
  h.app.engine.postHumanMessage(h.room.id, "OLD WORDS", "Phone");
  await until(() => existsSync(join(h.dir, "started")));
  const reset = h.app.engine.resetSession(h.member);
  await Bun.sleep(300);
  h.app.engine.postHumanMessage(h.room.id, "MID-RESET MESSAGE", "Phone");
  await reset;
  await h.app.engine.whenIdle();
  const said = JSON.stringify(fake.state.chats.at(-1)!.messages);
  expect(said).toContain("MID-RESET MESSAGE");
  expect(said).not.toContain("OLD WORDS");
  expect(h.app.store.listMessages(h.room.id).at(-1)?.text).toBe("On the fresh session.");
});
