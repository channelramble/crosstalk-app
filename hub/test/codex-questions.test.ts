// Codex's questions shown as cards in the chat, answered back the way Codex expects: request_user_input (a server
// request; isBlocking says whether Codex can go on without an answer) and request_user_input_async (an agentMessage with
// delivery "async", answered with a message in Codex's reply envelope, steered into the running turn). Against the
// fake Codex app-server with a temporary CODEX_HOME; never a real agent.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexQuestionReply, type AgentQuestion, type Member, type MessageVia, type Room } from "@crosstalk/shared";
import type { DriverContext, TurnResult, TurnSink } from "../src/agents/driver";
import { CodexDriver, CODEX_QUESTION_NOTE, codexQuestionReplyOf, threadGone } from "../src/agents/codex";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import { newId } from "../src/util/ids";
import { processesEnding } from "../src/util/process";

const FAKE = join(import.meta.dir, "fixtures", "fake-codex-app");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ASYNC_ID = (item: string) => JSON.stringify(["request_user_input_async", item, 0]);

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "ct-codex-q-"));
  dirs.push(dir);
  return dir;
}

/**
 * A Codex chat's driver on the fake app-server, with a sink that records what it's asked. `answered`: what it said was
 * answered in another app (DriverContext.questionsAnswered).
 */
function driver(env: Record<string, string> = {}, session: Record<string, unknown> = {}) {
  const dir = folder();
  const rpc = join(dir, "rpc.jsonl");
  const room: Room = { id: "r1", name: "Chat", cwd: dir, mode: "relay", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
  const member: Member = { id: "m1", roomId: "r1", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 };
  const answered: Record<string, string>[] = [];
  // A Codex home of its own: a chat connects to the Codex app's server when one is running, and tests must never.
  const ctx: DriverContext = { room, member, session, mcp: { command: "true", args: [], env: {} }, env: { PATH: process.env.PATH ?? "", CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_RPC_LOG: rpc, ...env }, bin: "", chat: { helper: null, notes: null }, questionsAnswered: (a) => void answered.push(a) };
  const d = new CodexDriver(ctx, FAKE);
  const sent = () => (existsSync(rpc) ? readFileSync(rpc, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { d, ctx, sent, answered };
}

function sink(answer: (questions: AgentQuestion[], signal?: AbortSignal) => Promise<Record<string, string[]> | null> = async () => null) {
  const abort = new AbortController();
  const rec = { text: "", notices: [] as { kind: string; title: string; detail?: string }[], saved: [] as Record<string, unknown>[], later: [] as { title: string; questions: AgentQuestion[] }[], asked: [] as { questions: AgentQuestion[]; autoResolveMs?: number | null; signal?: AbortSignal }[] };
  const s: TurnSink = {
    signal: abort.signal,
    text: (t) => (rec.text += t),
    setText: (t) => (rec.text = t),
    activity: (a) => (rec.notices.push(a), "a1"),
    updateActivity: () => {},
    approval: async () => "deny",
    ask: (_title, questions, opts) => {
      rec.asked.push({ questions, ...opts });
      return answer(questions, opts?.signal);
    },
    askLater: (title, questions) => void rec.later.push({ title, questions }),
    usage: () => {},
    rateLimit: () => {},
    status: () => {},
    saveSession: (patch) => void rec.saved.push(patch),
  };
  return { sink: s, rec };
}

const turn = (d: CodexDriver, prompt: string, s: TurnSink) => d.runTurn({ turnId: `t-${prompt}`, prompt, systemNote: null }, s);
/** A reply left running fails here, not at the test's time limit. */
const ended = (r: Promise<TurnResult>, ms = 3000) => Promise.race([r, Bun.sleep(ms).then((): TurnResult => ({ ok: false, error: "still running" }))]);
/** What Crosstalk answered the fake app's question request with. */
const answerTo = (sent: () => { id?: unknown; method?: string; result?: unknown }[]) => sent().find((x) => x.id === 1000 && !x.method)?.result;
/** Waits for `what` to come true (it may be async), failing the test after `ms`. */
const until = async (what: () => unknown, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) if (await what()) return;
  throw new Error("timed out waiting");
};

describe("Codex's questions, in the driver", () => {
  test("a question Codex asks without waiting (request_user_input_async) is a card, not reply text", async () => {
    const { d } = driver();
    const s = sink();
    try {
      expect(await ended(turn(d, "ASK_ASYNC", s.sink))).toEqual({ ok: true });
      expect(s.rec.later).toHaveLength(1);
      const [card] = s.rec.later;
      expect(card.title).toBe("Ship it?");
      expect(card.questions).toEqual([
        { id: card.questions[0].id, header: "", question: "Ship it?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }, { label: "Not sure", description: "" }], multiSelect: false, allowOther: true, preselected: "Yes" },
      ]);
      // The id Codex's apps give it: the item's id and the question's place, as JSON.
      expect(JSON.parse(card.questions[0].id)).toEqual(["request_user_input_async", expect.stringMatching(/^call_ask\d+$/), 0]);
      // The reply keeps what the agent wrote, not the question's text version.
      expect(s.rec.text).toBe("I'll keep checking the build meanwhile.");
      expect(s.rec.asked).toHaveLength(0);
    } finally { await d.dispose(); }
  });

  test("questions asked together are a card each, as Codex's apps take them one at a time", async () => {
    const { d } = driver();
    const s = sink();
    try {
      expect(await ended(turn(d, "ASK_ASYNC_TWO", s.sink))).toEqual({ ok: true });
      expect(s.rec.later.map((c) => c.title)).toEqual(["Ship it?", "Tell the team?"]);
      expect(s.rec.later.map((c) => c.questions.length)).toEqual([1, 1]);
      const [first, second] = s.rec.later.map((c) => JSON.parse(c.questions[0].id));
      expect(second).toEqual([first[0], first[1], 1]);
      expect(s.rec.later[1].questions[0]).toMatchObject({ question: "Tell the team?", preselected: "Yes" });
    } finally { await d.dispose(); }
  });

  test("an answer to its questions said in the chat's thread, read as Codex's apps read one, closes their cards", async () => {
    const { d, answered } = driver();
    const s = sink();
    try {
      const reply = turn(d, "ASK_ASYNC_WAIT", s.sink);
      await until(() => s.rec.later.length);
      const qid = s.rec.later[0].questions[0].id;
      // As the Codex app sends it: its IDE context first, then the envelope.
      const envelope = codexQuestionReply([{ questionItemId: qid, question: "Ship it?", answer: "Not sure" }]);
      await until(() => d.steer(`# Context from my IDE setup:\n\n## Open tabs:\n- app.ts\n\n## My request for Codex:\n${envelope}\n`));
      expect(await ended(reply)).toEqual({ ok: true });
      expect(answered).toEqual([{ [qid]: "Not sure" }]);
    } finally { await d.dispose(); }
    // Skills and mentions aside, the message is that one text; anything else in it, or around it, isn't an answer.
    const text = { type: "text", text: codexQuestionReply([{ questionItemId: "q", question: "Q?", answer: "A" }]), text_elements: [] };
    expect(codexQuestionReplyOf([{ type: "skill", name: "s", path: "/s" }, text, { type: "mention", name: "m", path: "/m" }])).toEqual([{ questionItemId: "q", question: "Q?", answer: "A" }]);
    expect(codexQuestionReplyOf([text, { type: "localImage", path: "/a.png" }])).toBeNull();
    expect(codexQuestionReplyOf([text, text])).toBeNull();
    expect(codexQuestionReplyOf([{ ...text, text: `Answer: ${text.text}` }])).toBeNull();
    expect(codexQuestionReplyOf(undefined)).toBeNull();
  });

  test("where nobody can answer a card (a one-off question), the question stays text", async () => {
    const { d } = driver();
    const s = sink();
    delete s.sink.askLater;
    try {
      expect(await ended(turn(d, "ASK_ASYNC", s.sink))).toEqual({ ok: true });
      expect(s.rec.text).toBe("Ship it?\n- Yes\n- No\n- Not sure\n\nI'll keep checking the build meanwhile.");
    } finally { await d.dispose(); }
  });

  test("a question Codex waits for (Plan mode) waits for you, and your answer goes back as Codex reads it", async () => {
    for (const how of ["blocking", "unsaid"]) {
      const { d, sent } = driver();
      const s = sink(async () => ({ ship: ["Yes (Recommended)"] }));
      try {
        expect(await ended(turn(d, `ASK_INPUT:${how}`, s.sink))).toEqual({ ok: true });
        expect(s.rec.asked).toHaveLength(1);
        expect(s.rec.asked[0].autoResolveMs ?? null).toBeNull(); // no time limit
        expect(s.rec.asked[0].questions[0]).toMatchObject({ id: "ship", header: "Release", question: "Ship it?", allowOther: true });
        expect(answerTo(sent)).toEqual({ answers: { ship: { answers: ["Yes (Recommended)"] } } });
      } finally { await d.dispose(); }
    }
  });

  test("one Codex can go on without (Default mode) gets Codex's time limit, and a skip tells it there's no answer", async () => {
    const { d, sent } = driver();
    const s = sink(async () => null);
    try {
      expect(await ended(turn(d, "ASK_INPUT:optional", s.sink))).toEqual({ ok: true });
      expect(s.rec.asked[0].autoResolveMs).toBe(CodexDriver.optionalQuestionMs);
      expect(CodexDriver.optionalQuestionMs).toBe(120_000);
      expect(answerTo(sent)).toEqual({ answers: {} });
    } finally { await d.dispose(); }
  });

  test("a question Codex settles elsewhere (answered in the Codex app) closes its card", async () => {
    const { d } = driver();
    let closed = false;
    const s = sink((_q, signal) => new Promise((done) => signal?.addEventListener("abort", () => ((closed = true), done(null)), { once: true })));
    try {
      expect(await ended(turn(d, "ASK_RESOLVED", s.sink))).toEqual({ ok: true });
      expect(closed).toBe(true);
      expect(s.rec.text).toBe("Answered in the Codex app.");
    } finally { await d.dispose(); }
  });

  test("another thread's question isn't shown here or answered for it", async () => {
    const { d, sent } = driver();
    const s = sink(async () => ({ ship: ["No"] }));
    try {
      expect(await ended(turn(d, "ASK_OTHER_THREAD", s.sink))).toEqual({ ok: true });
      expect(s.rec.asked).toHaveLength(0);
      // Left to the app that has that thread until Codex said it was settled: no answer of this chat's went before.
      const log = sent();
      const settled = log.findIndex((x) => x.sent === "serverRequest/resolved");
      const answered = log.findIndex((x) => x.id === 1000 && !x.method);
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(answered === -1 || answered > settled).toBe(true);
    } finally { await d.dispose(); }
  });

  test("the agent is told to ask with its question tool, except in a one-off question", async () => {
    const chat = driver();
    // What the thread was started with (the fake app-server writes it here).
    const log = join(chat.ctx.room.cwd, "thread.json");
    chat.ctx.env.FAKE_CODEX_LOG = log;
    try {
      expect(await ended(turn(chat.d, "hello", sink().sink))).toEqual({ ok: true });
      const started = JSON.parse(readFileSync(log, "utf8"));
      expect(started.developerInstructions).toContain(CODEX_QUESTION_NOTE);
      // Questions in Default mode too, which Codex can go on without.
      expect(started.config.features.default_mode_request_user_input).toBe(true);
      // A thread the Codex app already had keeps its old instructions: the first message says it too.
      expect(chat.sent().find((x) => x.method === "turn/start").params.input[0].text).toContain(CODEX_QUESTION_NOTE);
      // Crosstalk never picks a collaboration mode (Codex's own Default mode text says to ask in plain text).
      expect(chat.sent().find((x) => x.method === "turn/start").params.collaborationMode).toBeUndefined();
    } finally { await chat.d.dispose(); }
    const once = driver();
    const onceLog = join(once.ctx.room.cwd, "thread.json");
    once.ctx.env.FAKE_CODEX_LOG = onceLog;
    once.ctx.chat = { helper: null, ephemeral: true };
    try {
      expect(await ended(turn(once.d, "hello", sink().sink))).toEqual({ ok: true });
      expect(JSON.parse(readFileSync(onceLog, "utf8")).developerInstructions ?? "").not.toContain(CODEX_QUESTION_NOTE);
      expect(once.sent().find((x) => x.method === "turn/start").params.input[0].text).not.toContain(CODEX_QUESTION_NOTE);
    } finally { await once.d.dispose(); }
  });
});

/**
 * The Codex app's shared app-server, as far as this needs it. Like Codex 0.160, it opens every new thread to every client
 * connected to it: each thread's events and requests go to all of them, and the first answer to a request settles it
 * (serverRequest/resolved). A thread/resume of a thread that has requests open sends them again to the client that
 * resumed it, after its answer, and a turn/start on a thread whose turn is running adds to that turn (it answers with
 * that turn's id, and nothing new starts). Turns: "ASK_RUN" asks to run a command and says what the first answer was
 * (with "SLOW", 300 ms after it); "ASK_ASYNC" asks a question without waiting (request_user_input_async). `startTurn` runs
 * a turn as another client (the Codex app) would, and `say` is a message of another client's in a turn of its own.
 */
function codexApp(home: string, opts: { foreignAtStart?: boolean } = {}) {
  mkdirSync(join(home, "app-server-control"), { recursive: true });
  const got: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown }[] = [];
  const sockets = new Set<{ send: (s: string) => unknown }>();
  /** Requests waiting for their first answer, by id: their thread, the request as sent, and what the answer does. */
  const waiting = new Map<number, { threadId: string; request: object; then: (r: Record<string, unknown>) => void }>();
  /** The turn running on each thread. */
  const running = new Map<string, string>();
  let n = 0;
  let requestId = 100;
  const all = (o: object) => {
    for (const ws of sockets) ws.send(JSON.stringify({ jsonrpc: "2.0", ...o }));
  };
  const settle = (id: number, result: Record<string, unknown>) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    all({ method: "serverRequest/resolved", params: { threadId: w.threadId, requestId: id } });
    w.then(result);
  };
  const newTurn = (threadId: string) => {
    const turn = { id: `tu-app-${++n}` };
    running.set(threadId, turn.id);
    return turn;
  };
  const run = (threadId: string, turn: { id: string }, text: string) => {
    const end = (said: string) => {
      all({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "i1", delta: said } });
      running.delete(threadId);
      all({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
    };
    if (text.includes("ASK_RUN")) {
      const id = ++requestId;
      const request = { id, method: "item/commandExecution/requestApproval", params: { threadId, turnId: turn.id, itemId: "cmd-1", kind: "command", environmentId: null, command: "npm test", cwd: "/tmp" } };
      waiting.set(id, { threadId, request, then: (r) => setTimeout(() => end(`Decision: ${r.decision}`), text.includes("SLOW") ? 300 : 0) });
      // A moment after the turn started, as Codex asks once the model has worked out what to run.
      return void setTimeout(() => waiting.has(id) && all(request), 20);
    }
    if (text.includes("ASK_ASYNC")) {
      const item = { type: "agentMessage", id: `call_ask${n}`, text: "Ship it?\n- Yes\n- No", phase: "final_answer", memoryCitation: null, delivery: "async", questions: [{ title: "Ship it?", options: ["Yes", "No"] }] };
      all({ method: "item/started", params: { threadId, turnId: turn.id, item } });
      all({ method: "item/completed", params: { threadId, turnId: turn.id, item } });
      return end("I'll keep checking.");
    }
    end("Done.");
  };
  const server = Bun.serve({
    unix: join(home, "app-server-control", "app-server-control.sock"),
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        got.push(m);
        const answer = (o: object) => void ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }));
        // The first answer settles it, for every client.
        if (!m.method && waiting.has(m.id)) return settle(m.id, m.result ?? {});
        if (m.method === "initialize") return answer({ result: { userAgent: "crosstalk/0.160.0 (Mac OS 27.0.1; arm64) unknown (crosstalk; 0.1.0)" } });
        if (m.method === "thread/start") {
          // Other clients' requests (the Codex app's own conversations) reach a new chat before its start is answered.
          if (opts.foreignAtStart) for (const [id, method] of [[201, "item/commandExecution/requestApproval"], [202, "item/tool/requestUserInput"]] as const) ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { threadId: "th-elsewhere", turnId: "tu-elsewhere", itemId: `call_${id}`, kind: "command", command: "npm test", cwd: "/tmp", questions: [] } }));
          return answer({ result: { thread: { id: `th-app-${++n}` }, model: "gpt-test", reasoningEffort: "high" } });
        }
        if (m.method === "thread/resume") {
          answer({ result: { thread: { id: m.params.threadId }, model: "gpt-test", reasoningEffort: "high" } });
          for (const w of waiting.values()) if (w.threadId === m.params.threadId) ws.send(JSON.stringify({ jsonrpc: "2.0", ...w.request }));
          return;
        }
        if (m.method === "turn/start") {
          const threadId = m.params.threadId;
          const now = running.get(threadId);
          if (now) return answer({ result: { turn: { id: now } } });
          const turn = newTurn(threadId);
          answer({ result: { turn } });
          return run(threadId, turn, String(m.params.input?.[0]?.text ?? ""));
        }
        if (m.method && m.id !== undefined) answer({ result: {} });
      },
    },
  });
  return {
    got,
    send: all,
    stop: () => server.stop(true),
    /** Another client (the Codex app) runs a turn on a thread. */
    startTurn: (threadId: string, text: string) => run(threadId, newTurn(threadId), text),
    /** Another client answers request `id` first. */
    answer: settle,
    /** Another client sends `text` on a thread, in a turn of its own. */
    say: (threadId: string, text: string) => {
      const turn = newTurn(threadId);
      const item = { type: "userMessage", id: `u-${n}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
      all({ method: "item/started", params: { threadId, turnId: turn.id, item } });
      all({ method: "item/completed", params: { threadId, turnId: turn.id, item } });
      run(threadId, turn, "");
    },
  };
}

/** A socket's path has to be short: under /tmp. */
const socketHome = () => {
  const dir = mkdtempSync("/tmp/ct-cq-");
  dirs.push(dir);
  return dir;
};

describe("on the Codex app's server, which opens every thread to every client", () => {
  const home = socketHome;

  test("a question from the Codex app's own turn on this chat's thread, while the chat isn't replying, is left to the Codex app", async () => {
    const h = home();
    const app = codexApp(h);
    const { d } = driver({ CODEX_HOME: h });
    try {
      expect(await ended(turn(d, "hello", sink().sink))).toEqual({ ok: true });
      app.send({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "th-app-1", turnId: "tu-app-x", itemId: "call_x", questions: [{ id: "ship", header: "", question: "Ship it?", isOther: true, isSecret: false, options: [{ label: "Yes", description: "" }] }], isBlocking: true, autoResolutionMs: null } });
      await Bun.sleep(150);
      // Neither answered nor refused (either would settle it in the Codex app too)...
      expect(app.got.some((x) => x.id === 7 && !x.method)).toBe(false);
      // ...until Codex says it's settled there.
      app.send({ method: "serverRequest/resolved", params: { threadId: "th-app-1", requestId: 7 } });
      await Bun.sleep(50);
      expect(app.got.find((x) => x.id === 7 && !x.method)).toMatchObject({ result: { answers: {} } });
    } finally {
      await d.dispose();
      app.stop();
    }
  });

  test("a chat that isn't replying doesn't answer another chat's approval (it used to refuse it for that chat)", async () => {
    const h = home();
    const app = codexApp(h);
    const idle = driver({ CODEX_HOME: h });
    const asking = driver({ CODEX_HOME: h });
    try {
      expect(await ended(turn(idle.d, "hello", sink().sink))).toEqual({ ok: true });
      const s = sink();
      let asked = 0;
      s.sink.approval = async () => (asked++, "approve");
      expect(await ended(turn(asking.d, "ASK_RUN", s.sink))).toEqual({ ok: true });
      expect(asked).toBe(1);
      expect(s.rec.text).toBe("Decision: accept");
      // The idle chat didn't answer it first; once it was settled, the idle chat let go of it (an answer then is ignored).
      await Bun.sleep(50);
      const answers = app.got.filter((x) => x.id === 101 && !x.method);
      expect(answers[0].result).toEqual({ decision: "accept" });
      expect(answers.length).toBeLessThanOrEqual(2);
    } finally {
      await idle.d.dispose();
      await asking.d.dispose();
      app.stop();
    }
  });

  test("a reply that carries on a turn left waiting for an approval (the hub restarted) shows that approval, and ends", async () => {
    const h = home();
    const app = codexApp(h);
    const first = driver({ CODEX_HOME: h });
    const s1 = sink();
    let asked1 = 0;
    s1.sink.approval = () => (asked1++, new Promise(() => {})); // nobody answers before the restart
    try {
      void turn(first.d, "ASK_RUN", s1.sink);
      await until(() => asked1 === 1);
      // The hub stops: its connection goes, and the turn waits on in the Codex app's server, unanswered.
      await first.d.dispose();
      await Bun.sleep(50);
      expect(app.got.some((x) => x.id === 101 && !x.method)).toBe(false);
      // The restarted hub picks the reply up again: it resumes the thread (the server sends the open request again) and
      // its message goes into the turn that's waiting.
      const second = driver({ CODEX_HOME: h }, { threadId: "th-app-1" });
      const s2 = sink();
      let asked2 = 0;
      s2.sink.approval = async () => (asked2++, "approve");
      try {
        expect(await ended(turn(second.d, "Crosstalk restarted: carry on", s2.sink))).toEqual({ ok: true });
        expect(asked2).toBe(1);
        expect(s2.rec.text).toBe("Decision: accept");
        expect(app.got.filter((x) => x.id === 101 && !x.method).map((x) => x.result)).toEqual([{ decision: "accept" }]);
      } finally { await second.d.dispose(); }
    } finally {
      await first.d.dispose();
      app.stop();
    }
  });

  test("a message sent while the Codex app's own turn on this chat's thread waits for an approval shows that approval, and the reply ends", async () => {
    const h = home();
    const app = codexApp(h);
    const { d } = driver({ CODEX_HOME: h });
    try {
      expect(await ended(turn(d, "hello", sink().sink))).toEqual({ ok: true });
      // The Codex app runs a turn on the chat's thread that asks to run a command: the chat isn't replying, so it's left
      // to the Codex app.
      app.startTurn("th-app-1", "ASK_RUN");
      await Bun.sleep(100);
      expect(app.got.some((x) => x.id === 101 && !x.method)).toBe(false);
      // A message from the phone goes into that turn: its approval is the reply's now.
      const s = sink();
      let asked = 0;
      s.sink.approval = async () => (asked++, "approve");
      expect(await ended(turn(d, "go ahead", s.sink))).toEqual({ ok: true });
      expect(asked).toBe(1);
      expect(s.rec.text).toBe("Decision: accept");
      expect(app.got.filter((x) => x.id === 101 && !x.method).map((x) => x.result)).toEqual([{ decision: "accept" }]);
    } finally {
      await d.dispose();
      app.stop();
    }
  });
});

/**
 * A Codex chat on the engine, its driver on the fake app-server (`extra`: its environment, a CODEX_HOME with the Codex
 * app's server in it, say). `store` carries on after a restart (`again`).
 */
function chat(store = new Store(":memory:"), reuse?: { room: Room; member: Member; dir: string }, extra: Record<string, string> = {}) {
  const dir = reuse?.dir ?? folder();
  const bus = new Bus();
  const rpc = join(dir, "rpc.jsonl");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_RPC_LOG: rpc, ...extra };
  const engine = new Engine({ store, bus, createDriver: (ctx) => new CodexDriver({ ...ctx, env }, FAKE), mcpLaunch: () => ({ command: "true", args: [], env: {} }) });
  const now = Date.now();
  const room: Room = reuse?.room ?? { id: newId("r"), name: "Chat", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
  const member: Member = reuse?.member ?? { id: newId("mb"), roomId: room.id, handle: "codex", provider: "codex", model: null, role: "", permissionMode: "full", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 };
  if (!reuse) {
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "codex", origin: "web", localId: null });
    store.insertMember(member);
  }
  const sent = () => (existsSync(rpc) ? readFileSync(rpc, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const conversation = () => store.listMessages(room.id, { limit: 50 }).filter((m) => m.authorKind !== "system").map((m) => `${m.authorKind}: ${m.text}`);
  const cards = () => store.listApprovals(room.id);
  const until = async (what: () => unknown, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) if (what()) return;
    throw new Error("timed out waiting");
  };
  const close = async () => {
    await engine.stop(room.id);
    await engine.shutdown();
    await processesEnding();
  };
  const again = async () => {
    await close();
    return chat(store, { room, member, dir }, extra);
  };
  return { store, engine, bus, room, member, env, sent, conversation, cards, until, close, again };
}

describe("Codex's questions, in a chat", () => {
  test("answered while the reply runs: the answer goes into it as Codex's reply envelope, and no second reply runs", async () => {
    const t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC_WAIT: check the build", "Phone");
      await t.until(() => t.cards().some((a) => a.status === "pending"));
      const [card] = t.cards();
      expect(card).toMatchObject({ kind: "question", delivery: "async", title: "Ship it?", status: "pending" });
      // It isn't something the agent waits on.
      expect(t.store.getMember(t.member.id)!.status).not.toBe("approval");
      const qid = card.questions![0].id;
      expect(qid).toBe(ASYNC_ID(JSON.parse(qid)[1]));
      t.engine.decideApproval(card.id, "approve", "Phone", { [qid]: ["No"] });
      await t.engine.whenIdle();
      const envelope = codexQuestionReply([{ questionItemId: qid, question: "Ship it?", answer: "No" }]);
      expect(envelope).toBe(`<send_user_message_question_reply>\n[{"answer":"No","question":"Ship it?","questionItemId":${JSON.stringify(qid)}}]\n</send_user_message_question_reply>`);
      // Into the running turn, exactly as Codex's apps send it.
      const steer = t.sent().filter((x) => x.method === "turn/steer");
      expect(steer).toHaveLength(1);
      expect(steer[0].params.input[0].text).toBe(envelope);
      expect(t.sent().filter((x) => x.method === "turn/start")).toHaveLength(1);
      expect(t.cards()[0]).toMatchObject({ status: "approved", answers: { [qid]: ["No"] }, decidedBy: "Phone" });
      expect(t.conversation()).toEqual(["human: ASK_ASYNC_WAIT: check the build", "agent: I'll keep checking the build meanwhile.", `human: ${envelope}`, "agent: Got your answer."]);
    } finally { await t.close(); }
  });

  test("the card outlives its reply and a restart; answered later, the answer starts the next reply", async () => {
    let t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC", "Phone");
      await t.engine.whenIdle();
      expect(t.store.getTurn(t.store.listTurns(t.room.id, 5)[0].id)!.status).toBe("done");
      expect(t.cards()[0].status).toBe("pending");
      t = await t.again();
      const [card] = t.cards();
      expect(card.status).toBe("pending");
      const qid = card.questions![0].id;
      t.engine.decideApproval(card.id, "approve", "Mac", { [qid]: ["Not sure"] });
      await t.engine.whenIdle();
      const starts = t.sent().filter((x) => x.method === "turn/start");
      expect(starts).toHaveLength(2);
      // The whole message, as Codex's apps send it (only that is an answer to them): a new driver's notes wait for the next.
      expect(starts[1].params.input[0].text).toBe(codexQuestionReply([{ questionItemId: qid, question: "Ship it?", answer: "Not sure" }]));
      expect(t.cards()[0].status).toBe("approved");
      t.engine.postHumanMessage(t.room.id, "thanks", "Mac");
      await t.engine.whenIdle();
      const next = t.sent().filter((x) => x.method === "turn/start")[2].params.input[0].text;
      expect(next.startsWith("(Note from Crosstalk: ")).toBe(true);
      expect(next).toContain(CODEX_QUESTION_NOTE);
      expect(next.endsWith("\n\nthanks")).toBe(true);
    } finally { await t.close(); }
  });

  test("another message of yours closes the card; a skip sends nothing", async () => {
    const t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC", "Phone");
      await t.engine.whenIdle();
      t.engine.postHumanMessage(t.room.id, "never mind, ship it", "Phone");
      await t.engine.whenIdle();
      expect(t.cards()[0].status).toBe("expired");
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC again", "Phone");
      await t.engine.whenIdle();
      const skipped = t.cards().find((a) => a.status === "pending")!;
      t.engine.decideApproval(skipped.id, "deny", "Phone");
      await t.engine.whenIdle();
      expect(t.store.getApproval(skipped.id)!.status).toBe("denied");
      expect(t.sent().filter((x) => x.method === "turn/start")).toHaveLength(3); // nothing more went to Codex
    } finally { await t.close(); }
  });

  test("a fresh session closes the cards the old one asked", async () => {
    const t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC", "Phone");
      await t.engine.whenIdle();
      await t.engine.resetSession(t.store.getMember(t.member.id)!);
      expect(t.cards()[0].status).toBe("expired");
    } finally { await t.close(); }
  });

  test("a question Codex can go on without waits until a device shows it, then goes on with no answer after the time limit, unless you start answering", async () => {
    const was = CodexDriver.optionalQuestionMs;
    CodexDriver.optionalQuestionMs = 300;
    const t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_INPUT:optional", "Phone");
      await t.until(() => t.cards().some((a) => a.status === "pending"));
      const first = t.cards()[0];
      expect(first.autoResolveMs).toBe(300);
      expect(first.autoResolveAt ?? null).toBeNull();
      // Nobody has seen it (a phone in a pocket): it waits, well past its time.
      await Bun.sleep(700);
      expect(t.store.getApproval(first.id)!.status).toBe("pending");
      expect(t.sent().some((x) => x.id === 1000 && !x.method)).toBe(false);
      // A device shows it: its time starts now, and another device showing it changes nothing.
      const seen = t.engine.seenApproval(first.id)!;
      expect(seen.autoResolveAt).toBeGreaterThan(Date.now() + 200);
      expect(t.engine.seenApproval(first.id)!.autoResolveAt).toBe(seen.autoResolveAt);
      await t.engine.whenIdle();
      const gone = t.store.getApproval(first.id)!;
      expect(gone.status).toBe("expired");
      expect(gone.decidedAt!).toBeGreaterThanOrEqual(seen.autoResolveAt! - 50);
      expect(t.conversation().at(-1)).toBe('agent: Answers: {"answers":{}}');
      // Once you start answering, it waits for you, past the time limit, whoever shows it afterwards.
      t.engine.postHumanMessage(t.room.id, "ASK_INPUT:optional again", "Phone");
      await t.until(() => t.cards().some((a) => a.status === "pending"));
      const second = t.cards().find((a) => a.status === "pending")!;
      t.engine.seenApproval(second.id);
      expect(t.engine.holdApproval(second.id)).toMatchObject({ status: "pending", autoResolveMs: null, autoResolveAt: null });
      expect(t.engine.seenApproval(second.id)!.autoResolveAt ?? null).toBeNull();
      await Bun.sleep(700);
      expect(t.store.getApproval(second.id)!.status).toBe("pending");
      t.engine.decideApproval(second.id, "approve", "Phone", { ship: ["No"] });
      await t.engine.whenIdle();
      expect(t.conversation().at(-1)).toBe('agent: Answers: {"answers":{"ship":{"answers":["No"]}}}');
    } finally {
      CodexDriver.optionalQuestionMs = was;
      await t.close();
    }
  });

  test("questions asked together are answered one by one: each answer goes alone, and the others stay to answer", async () => {
    const t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC_TWO", "Phone");
      await t.engine.whenIdle();
      const [ship, team] = t.cards();
      expect([ship.title, team.title]).toEqual(["Ship it?", "Tell the team?"]);
      expect([ship.status, team.status]).toEqual(["pending", "pending"]);
      // Only the question you answer is answered: the other's recommended option isn't sent for you.
      t.engine.decideApproval(ship.id, "approve", "Phone", { [ship.questions![0].id]: ["No"] });
      await t.engine.whenIdle();
      const starts = () => t.sent().filter((x) => x.method === "turn/start").map((x) => x.params.input[0].text);
      expect(starts()[1]).toBe(codexQuestionReply([{ questionItemId: ship.questions![0].id, question: "Ship it?", answer: "No" }]));
      expect(t.store.getApproval(team.id)!.status).toBe("pending");
      t.engine.decideApproval(team.id, "approve", "Phone", { [team.questions![0].id]: ["Yes"] });
      await t.engine.whenIdle();
      expect(starts()[2]).toBe(codexQuestionReply([{ questionItemId: team.questions![0].id, question: "Tell the team?", answer: "Yes" }]));
      expect(t.cards().map((a) => a.status)).toEqual(["approved", "approved"]);
    } finally { await t.close(); }
  });

  test("an answer handed to the running reply along with another waiting message goes in a message of its own", async () => {
    const t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC_WAIT: check the build", "Phone");
      await t.until(() => t.cards().some((a) => a.status === "pending"));
      // Another chat's agent writes meanwhile: its message waits for this reply to end.
      const via: MessageVia = { hubId: "h1", machine: "Mac", chatId: "r-other", chatName: "Release", agent: "Claude Code", hop: 1, kind: "message" };
      t.engine.postRelayMessage(t.room.id, "The release is tagged.", via, "Claude Code");
      const [card] = t.cards();
      const qid = card.questions![0].id;
      t.engine.decideApproval(card.id, "approve", "Phone", { [qid]: ["Yes"] });
      await t.engine.whenIdle();
      const steers = t.sent().filter((x) => x.method === "turn/steer").map((x) => x.params.input[0].text);
      expect(steers).toHaveLength(2);
      expect(steers[0]).toContain("The release is tagged.");
      expect(steers[1]).toBe(codexQuestionReply([{ questionItemId: qid, question: "Ship it?", answer: "Yes" }]));
      // Both went into the reply that was running: no second reply.
      expect(t.sent().filter((x) => x.method === "turn/start")).toHaveLength(1);
      expect(t.conversation().at(-1)).toBe("agent: Got your answer.");
    } finally { await t.close(); }
  });

  test("a question answered in the Codex app closes here at once, while the reply goes on", async () => {
    const t = chat();
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_RESOLVED", "Phone");
      await t.until(() => t.cards()[0]?.status === "expired");
      expect(t.cards()[0]).toMatchObject({ kind: "question", status: "expired" });
      expect(t.engine.runningTurns(t.room.id)).toHaveLength(1);
      // It isn't waiting for you any more.
      expect(t.store.getMember(t.member.id)!.status).toBe("working");
      await t.engine.whenIdle();
      expect(t.conversation().at(-1)).toBe("agent: Answered in the Codex app.");
    } finally { await t.close(); }
  });
});

describe("in a chat on the Codex app's server", () => {
  test("an approval answered in the Codex app closes here at once, and the agent works on", async () => {
    const h = socketHome();
    const app = codexApp(h);
    const t = chat(undefined, undefined, { CODEX_HOME: h });
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_RUN SLOW", "Phone");
      await t.until(() => t.cards().some((a) => a.status === "pending"));
      expect(t.cards()[0]).toMatchObject({ kind: "command", title: "npm test" });
      expect(t.store.getMember(t.member.id)!.status).toBe("approval");
      // Approved in the Codex app on the Mac (the first answer settles it for every client).
      app.answer(101, { decision: "accept" });
      await t.until(() => t.cards()[0].status === "expired");
      // It isn't waiting for you any more, though its reply hasn't ended.
      expect(t.engine.runningTurns(t.room.id)).toHaveLength(1);
      expect(t.store.getMember(t.member.id)!.status).toBe("working");
      await t.engine.whenIdle();
      expect(t.conversation().at(-1)).toBe("agent: Decision: accept");
    } finally {
      await t.close();
      app.stop();
    }
  });

  test("a question answered in the Codex app after its reply ended closes here too", async () => {
    const h = socketHome();
    const app = codexApp(h);
    const t = chat(undefined, undefined, { CODEX_HOME: h });
    try {
      t.engine.postHumanMessage(t.room.id, "ASK_ASYNC", "Phone");
      await t.engine.whenIdle();
      const [card] = t.cards();
      expect(card).toMatchObject({ delivery: "async", status: "pending" });
      const qid = card.questions![0].id;
      // The Codex app sends the answer in a turn of its own, while no reply of this chat's runs.
      app.say("th-app-1", codexQuestionReply([{ questionItemId: qid, question: "Ship it?", answer: "No" }]));
      await t.until(() => t.cards()[0].status !== "pending");
      expect(t.cards()[0]).toMatchObject({ status: "approved", decidedBy: "another app", answers: { [qid]: ["No"] } });
      // Nothing more went to Codex for it.
      await Bun.sleep(100);
      expect(app.got.filter((x) => x.method === "turn/start")).toHaveLength(1);
    } finally {
      await t.close();
      app.stop();
    }
  });
});

describe("a chat's thread: before it's known, and when it can't be resumed", () => {
  /** What Crosstalk answered the fake app's requests with (its own notes in the log aren't answers). */
  const answers = (sent: () => { id?: unknown; method?: string; sent?: string }[]) => sent().filter((x) => x.id !== undefined && !x.method && !x.sent);

  test("another thread's requests that come before a new chat's thread starts are left to their client", async () => {
    const { d, sent } = driver({ FAKE_CODEX_START_FOREIGN: "1", FAKE_CODEX_START_DELAY: "100" });
    try {
      const s = sink();
      expect(await ended(turn(d, "hello", s.sink))).toEqual({ ok: true });
      expect(s.rec.text).toBe("Done.");
      // The fake sent an approval and a question of another thread (ids 1000 and 1001) before it answered thread/start.
      // Neither was answered or refused (that would settle it for every client of a shared server).
      expect(sent().filter((x) => x.sent).map((x) => x.id)).toEqual([1000, 1001]);
      expect(answers(sent)).toEqual([]);
    } finally { await d.dispose(); }
  });

  test("on the Codex app's server too: another client's requests that come before the thread starts stay its to answer", async () => {
    const h = socketHome();
    const app = codexApp(h, { foreignAtStart: true });
    const { d } = driver({ CODEX_HOME: h });
    try {
      expect(await ended(turn(d, "hello", sink().sink))).toEqual({ ok: true });
      await Bun.sleep(100);
      const answered = () => app.got.filter((x) => (x.id === 201 || x.id === 202) && !x.method);
      // Neither answered nor refused (either would settle it in the Codex app too)...
      expect(answered()).toEqual([]);
      // ...until Codex says each is settled there (what's sent then, Codex ignores).
      for (const requestId of [201, 202]) app.send({ method: "serverRequest/resolved", params: { threadId: "th-elsewhere", requestId } });
      await until(() => answered().length === 2);
    } finally {
      await d.dispose();
      app.stop();
    }
  });

  test.each(["thread/resume timed out", "The connection to the Codex app's server closed.", "failed to locate thread id th-old: Resource temporarily unavailable (os error 35)"])(
    "a resume that fails with %s keeps the saved thread, and the reply offers Try again",
    async (why) => {
      const { d, ctx, sent } = driver({ FAKE_CODEX_RESUME_ERROR: why }, { threadId: "th-old" });
      try {
        const s = sink();
        expect(await ended(turn(d, "hello", s.sink))).toEqual({ ok: false, error: "Couldn't reach Codex to continue this chat. Try again." });
        // The session wasn't touched, and no new thread took the old one's place.
        expect(s.rec.saved.filter((p) => "threadId" in p)).toEqual([]);
        expect(sent().filter((x) => x.method === "thread/start")).toEqual([]);
        // Codex is back: the next reply resumes the same thread (on a new connection) and goes on in it.
        delete ctx.env.FAKE_CODEX_RESUME_ERROR;
        const again = sink();
        expect(await ended(turn(d, "hello again", again.sink))).toEqual({ ok: true });
        expect(again.rec.text).toBe("Done.");
        expect(sent().filter((x) => x.method === "thread/resume").map((x) => x.params.threadId)).toEqual(["th-old", "th-old"]);
        expect(sent().filter((x) => x.method === "thread/start")).toEqual([]);
        expect(sent().find((x) => x.method === "turn/start").params.threadId).toBe("th-old");
        expect(again.rec.saved.filter((p) => "threadId" in p)).toEqual([]);
        expect(again.rec.notices).toEqual([]);
      } finally { await d.dispose(); }
    },
  );

  test.each(["thread not found: th-old", "no rollout found for thread id th-old", "no such thread"])("a resume that fails with %s starts a new thread, and the chat says so", async (why) => {
    const { d, sent } = driver({ FAKE_CODEX_RESUME_ERROR: why }, { threadId: "th-old" });
    try {
      const s = sink();
      expect(await ended(turn(d, "hello", s.sink))).toEqual({ ok: true });
      expect(s.rec.text).toBe("Done.");
      const methods = sent().map((x) => x.method);
      expect(methods.indexOf("thread/start")).toBeGreaterThan(methods.indexOf("thread/resume"));
      expect(sent().find((x) => x.method === "turn/start").params.threadId).toBe("th-1");
      expect(s.rec.saved).toContainEqual({ threadId: "th-1" });
      expect(s.rec.notices).toEqual([expect.objectContaining({ kind: "notice", title: "Codex has lost this chat's earlier conversation" })]);
    } finally { await d.dispose(); }
  });

  test("in a chat: the failed reply says to try again, the saved session keeps its thread, and Try again goes on in it", async () => {
    const t = chat(undefined, undefined, { FAKE_CODEX_RESUME_ERROR: "thread/resume timed out" });
    try {
      t.store.setMemberSession(t.member.id, { threadId: "th-old" });
      t.engine.postHumanMessage(t.room.id, "hello", "Phone");
      await t.engine.whenIdle();
      expect(t.conversation()).toEqual(["human: hello", "agent: ⚠️ Couldn't reach Codex to continue this chat. Try again."]);
      expect(t.store.lastEndedTurn(t.member.id)?.status).toBe("error");
      expect(t.store.getMemberSession(t.member.id).threadId).toBe("th-old");
      // Codex is back: Try again resumes the same thread, and the chat goes on in it.
      delete t.env.FAKE_CODEX_RESUME_ERROR;
      t.engine.retry(t.room.id);
      await t.engine.whenIdle();
      expect(t.conversation().at(-1)).toBe("agent: Done.");
      expect(t.store.getMemberSession(t.member.id).threadId).toBe("th-old");
      expect(t.sent().filter((x) => x.method === "thread/start")).toEqual([]);
      expect(t.sent().find((x) => x.method === "turn/start").params.threadId).toBe("th-old");
    } finally { await t.close(); }
  });

  test("which resume errors say a thread is gone", () => {
    for (const why of ["thread not found: 019a-th", "Thread not found", "no rollout found for thread id 019a-th", "no rollout found for conversation id 019a-th", "no such thread", "couldn't find the rollout"]) expect(threadGone(why)).toBe(true);
    for (const why of ["thread/resume timed out", "codex has gone", "The connection to the Codex app's server closed.", "failed to locate thread id 019a-th: Resource temporarily unavailable (os error 35)", "model not found: gpt-9", "failed to load configuration: invalid type"]) expect(threadGone(why)).toBe(false);
  });
});
