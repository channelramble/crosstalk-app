import { describe, expect, test } from "bun:test";
import { parseMentions, type Member, type Room, type ServerEvent } from "@crosstalk/shared";
import { Store } from "../src/db";
import { Bus } from "../src/bus";
import { Engine } from "../src/engine/engine";
import { MockDriver } from "../src/agents/mock";
import type { AgentDriver, DriverContext, TurnInput, TurnSink } from "../src/agents/driver";
import { newId } from "../src/util/ids";
import { buildTurnPrompt } from "../src/engine/prompt";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup(roomPatch: Partial<Room> = {}) {
  const store = new Store(":memory:");
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  const prompts: { handle: string; input: TurnInput }[] = [];
  const engine = new Engine({
    store,
    bus,
    createDriver: (ctx: DriverContext): AgentDriver => {
      const inner = new MockDriver(ctx);
      return {
        provider: "mock",
        runTurn: (input: TurnInput, sink: TurnSink) => {
          prompts.push({ handle: ctx.member.handle, input });
          return inner.runTurn(input, sink);
        },
        interrupt: () => inner.interrupt(),
        dispose: () => inner.dispose(),
      };
    },
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  const room: Room = {
    id: newId("r"),
    name: "Test room",
    cwd: "/tmp",
    mode: "relay",
    leadMemberId: null,
    maxHops: 6,
    rounds: 1,
    parallel: false,
    createdAt: now,
    updatedAt: now,
    archived: false,
    ...roomPatch,
  };
  store.insertRoom(room);
  const add = (handle: string, config: Record<string, unknown> = {}): Member => {
    const m: Member = {
      id: newId("mb"),
      roomId: room.id,
      handle,
      provider: "mock",
      model: null,
      role: "",
      permissionMode: "ask",
      status: "idle",
      statusDetail: null,
      config: { delayMs: 30, ...config },
      createdAt: Date.now(),
      position: store.listMembers(room.id).length,
    };
    store.insertMember(m);
    return m;
  };
  const agentMessages = () => store.listMessages(room.id, { limit: 500 }).filter((m) => m.authorKind === "agent");
  const systemMessages = () => store.listMessages(room.id, { limit: 500 }).filter((m) => m.authorKind === "system");
  return { store, bus, engine, room, add, events, prompts, agentMessages, systemMessages };
}

describe("parseMentions", () => {
  test("finds handles in order, once each", () => {
    expect(parseMentions("@codex please review, then @claude fix. thanks @codex")).toEqual(["codex", "claude"]);
  });
  test("ignores emails, code and paths", () => {
    expect(parseMentions("mail me at dev@example.com")).toEqual([]);
    expect(parseMentions("run `npm i @types/node` and\n```\n@decorator\n```")).toEqual([]);
    expect(parseMentions("see ./src/@scope/pkg")).toEqual([]);
  });
  test("handles punctuation around mentions", () => {
    expect(parseMentions("(@muse) and @gemini-2, ok")).toEqual(["muse", "gemini-2"]);
  });
});

describe("engine routing", () => {
  test("a message with no mention goes to the first agent", async () => {
    const t = setup();
    const a = t.add("alpha");
    t.add("beta");
    t.engine.postHumanMessage(t.room.id, "hello team", "Phone");
    await t.engine.whenIdle();
    const msgs = t.agentMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].memberId).toBe(a.id);
    expect(msgs[0].status).toBe("done");
    expect(msgs[0].text).toContain("hello team");
  });

  test("relay: an agent's @mention starts the next agent's turn with the new context", async () => {
    const t = setup();
    t.add("writer", { handoff: "reviewer", reply: "I wrote the parser." });
    const reviewer = t.add("reviewer", { reply: "Looks good to me." });
    t.engine.postHumanMessage(t.room.id, "build a parser", "Mac");
    await t.engine.whenIdle();
    const msgs = t.agentMessages();
    expect(msgs.map((m) => m.authorName)).toEqual(["writer", "reviewer"]);
    expect(msgs[0].mentions).toEqual([reviewer.id]);
    const reviewerPrompt = t.prompts.find((p) => p.handle === "reviewer")!.input;
    expect(reviewerPrompt.prompt).toContain("I wrote the parser.");
    expect(reviewerPrompt.prompt).toContain("build a parser");
    expect(reviewerPrompt.prompt).toContain("@writer");
    expect(reviewerPrompt.systemNote).toContain("You are @reviewer");
  });

  test("hand-off limit stops a ping-pong and posts a notice", async () => {
    const t = setup({ maxHops: 3 });
    t.add("ping", { handoff: "pong", pingpong: true });
    t.add("pong", { handoff: "ping", pingpong: true });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().length).toBe(4); // initial turn + 3 hand-offs
    expect(t.systemMessages().some((m) => m.text.includes("Hand-off limit reached (3)"))).toBe(true);
  });

  test("build & review: the work goes back and forth until the reviewer approves", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { replies: ["Built v1.", "Fixed the bug in v2."] });
    t.add("checker", { replies: ["Bug in parse.ts:10.", "APPROVED: parser works."] });
    t.engine.postHumanMessage(t.room.id, "build a parser", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["builder", "checker", "builder", "checker"]);
    expect(t.systemMessages().some((m) => m.text.includes("approved @builder's work after 2 review rounds"))).toBe(true);
    const review = t.prompts.filter((p) => p.handle === "checker")[0].input;
    expect(review.systemNote).toContain("You are the reviewer");
    expect(review.prompt).toContain("Review the actual changes");
  });

  test("build & review: the reviewer answering the human directly isn't bounced to the builder as a review", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { reply: "Built it." });
    t.add("checker", { reply: "Here's the command you asked for." });
    t.engine.postHumanMessage(t.room.id, "@checker give me the scp command", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["checker"]);
  });

  test("build & review: the reviewer can bring the builder in with an @mention, and that work is reviewed", async () => {
    const t = setup({ mode: "review", maxHops: 3 });
    t.add("builder", { reply: "Fixed the flag." });
    t.add("checker", { replies: ["The flag is wrong.\n\n@builder please fix the --effort flag.", "APPROVED: fixed."] });
    t.engine.postHumanMessage(t.room.id, "@checker is the flag right?", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["checker", "builder", "checker"]);
    expect(t.systemMessages().some((m) => m.text.includes("approved @builder's work after 1 review round"))).toBe(true);
    // With no room left to review the builder's work, the builder isn't started.
    const tight = setup({ mode: "review", maxHops: 1 });
    tight.add("builder", { reply: "Fixed." });
    tight.add("checker", { reply: "@builder please fix the flag." });
    tight.engine.postHumanMessage(tight.room.id, "@checker is the flag right?", "Mac");
    await tight.engine.whenIdle();
    expect(tight.agentMessages().map((m) => m.authorName)).toEqual(["checker"]);
    expect(tight.systemMessages().some((m) => m.text.includes("Hand-off limit reached"))).toBe(true);
  });

  test("build & review: possessives and paths in the reviewer's reply aren't requests", async () => {
    const t = setup({ mode: "review" });
    t.add("builder");
    t.add("checker", { reply: "I agree with @builder's approach; notes are in /tmp/@builder/notes.md and @builder/out." });
    t.engine.postHumanMessage(t.room.id, "@checker thoughts?", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["checker"]);
  });

  test("build & review: @all runs one loop, with one review and one approval", async () => {
    for (const parallel of [false, true]) {
      // The reviewer answers the human, then reviews the build once: no second loop.
      const t = setup({ mode: "review", parallel });
      t.add("builder", { delayMs: 120, reply: "Built it." });
      t.add("checker", { delayMs: 60, replies: ["I'll review once it's built.", "APPROVED: good."] });
      t.engine.postHumanMessage(t.room.id, "@all build it", "Mac");
      await t.engine.whenIdle();
      expect(t.prompts.map((p) => p.handle)).toEqual(["builder", "checker", "checker"]);
      expect(t.prompts[2].input.prompt).toContain("Review the actual changes");
      expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
    }
  });

  test("build & review: the reviewer's review and a direct question to it stay separate turns", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { delayMs: 200, reply: "Built it." });
    t.add("checker", { replies: ["It uses port 8080.", "APPROVED: good."] });
    t.engine.postHumanMessage(t.room.id, "build it", "Mac");
    await Bun.sleep(40);
    t.engine.postHumanMessage(t.room.id, "@checker which port does it use?", "Mac");
    await t.engine.whenIdle();
    const checker = t.prompts.filter((p) => p.handle === "checker");
    expect(checker.length).toBe(2);
    expect(checker[0].input.prompt).toContain("The human mentioned you");
    expect(checker[1].input.prompt).toContain("Review the actual changes");
    const done = t.events.filter((e) => e.t === "turn").map((e) => (e as Extract<ServerEvent, { t: "turn" }>).turn).filter((x) => x.status === "done");
    expect(done.map((x) => x.origin)).toEqual(["human", "human", "loop"]);
    expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
  });

  test("build & review: a new request merged with pending fixes keeps its own review budget", async () => {
    const t = setup({ mode: "review", maxHops: 3 });
    t.add("builder", { delayMs: 30, reply: "Work {n}." });
    t.add("checker", { delayMs: 200, replies: ["Bug in A.", "Bug in B.", "APPROVED: ok."] });
    t.engine.postHumanMessage(t.room.id, "build A", "Mac");
    await Bun.sleep(120); // the checker is reviewing A
    t.engine.postHumanMessage(t.room.id, "now build B", "Mac");
    await t.engine.whenIdle();
    // The fixes for A and the new request B share one builder turn, which starts a fresh budget: B is reviewed twice.
    const builder = t.prompts.filter((p) => p.handle === "builder");
    expect(builder[1].input.prompt).toContain("reviewed your work and found issues");
    expect(builder[1].input.prompt).toContain("The human also wrote to you above");
    expect(t.prompts.filter((p) => p.handle === "checker").length).toBe(3);
    expect(t.systemMessages().some((m) => m.text.includes("approved"))).toBe(true);
  });

  test("build & review: a reviewed turn's @mention of a third agent isn't mistaken for a loop", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { reply: "Built the schema. @expert please check the schema." });
    t.add("checker", { reply: "APPROVED: ok." });
    t.add("expert", { reply: "Schema looks fine." });
    t.engine.postHumanMessage(t.room.id, "build it", "Mac");
    await t.engine.whenIdle();
    expect(t.prompts.map((p) => p.handle).sort()).toEqual(["builder", "checker", "expert"]);
    expect(t.systemMessages().some((m) => m.text.includes("Stopped a loop"))).toBe(false);
  });

  test("build & review: a QUESTION pauses loop steps already waiting until the human answers", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { delayMs: 100, replies: ["Built A.", "QUESTION: which database for B?", "Built B with SQLite."] });
    t.add("checker", { reply: "APPROVED: all good." });
    t.engine.postHumanMessage(t.room.id, "build A", "Mac");
    await Bun.sleep(40);
    t.engine.postHumanMessage(t.room.id, "then build B", "Mac"); // waits behind A
    await t.engine.whenIdle();
    // A's review was waiting when B asked: it's cancelled, so nothing runs without the answer.
    expect(t.prompts.map((p) => p.handle)).toEqual(["builder", "builder"]);
    expect(t.systemMessages().some((m) => m.text.includes("waiting for your answer to @builder's question"))).toBe(true);
    t.engine.postHumanMessage(t.room.id, "SQLite", "Mac");
    await t.engine.whenIdle();
    // The answer resumes the work, and one review covers everything.
    expect(t.prompts.map((p) => p.handle)).toEqual(["builder", "builder", "builder", "checker"]);
    expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
  });

  test("build & review: pausing keeps the human's own request that was merged into a waiting loop step", async () => {
    const t = setup({ mode: "review", parallel: true });
    t.add("builder", { delayMs: 300, replies: ["Built A.", "QUESTION: tabs or spaces?", "Did C."] });
    t.add("checker", { delayMs: 50, replies: ["Bug in A."] });
    t.engine.postHumanMessage(t.room.id, "build A", "Mac");
    await Bun.sleep(150);
    t.engine.postHumanMessage(t.room.id, "build B", "Mac"); // queued behind A; runs while A is reviewed
    await Bun.sleep(300);
    t.engine.postHumanMessage(t.room.id, "also do C", "Mac"); // merged into the waiting "fix A" step
    await t.engine.whenIdle();
    const builder = t.prompts.filter((p) => p.handle === "builder");
    expect(builder.length).toBe(3);
    expect(builder[2].input.prompt).toContain("also do C");
    expect(builder[2].input.prompt).not.toContain("found issues"); // the loop step was dropped, the request kept
    expect(t.prompts.filter((p) => p.handle === "checker").length).toBe(1); // paused: "Did C." isn't reviewed yet
  });

  test("a request survives a flood of other messages and the digest's length limit", async () => {
    const t = setup({ mode: "direct" });
    const builder = t.add("builder", { reply: "ok" });
    t.add("checker", { delayMs: 200, reply: "done" });
    t.engine.postHumanMessage(t.room.id, "@checker warm up", "Mac");
    await Bun.sleep(60);
    t.engine.postHumanMessage(t.room.id, "@checker UNIQUE_FIRST_REQUEST", "Mac"); // waits; then 600 posts arrive
    for (let i = 0; i < 600; i++) t.engine.agentPost(builder.id, `status update ${i} ${"x".repeat(120)}`);
    await t.engine.whenIdle();
    const second = t.prompts.filter((p) => p.handle === "checker")[1].input.prompt;
    expect(second).toContain("UNIQUE_FIRST_REQUEST");
    expect(second).toContain("status update 599"); // the newest messages too
    expect(second).toMatch(/\(\d+ other messages omitted for length/);
    // A request posted after the flood is there as well.
    t.engine.postHumanMessage(t.room.id, "@checker UNIQUE_LATEST_REQUEST", "Mac");
    await t.engine.whenIdle();
    expect(t.prompts.filter((p) => p.handle === "checker")[2].input.prompt).toContain("UNIQUE_LATEST_REQUEST");
  });

  test("the turn's trigger and every request survive the digest's length limit", () => {
    const now = Date.now();
    const room = { id: "r", name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 5, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false } as Room;
    const me = { id: "me", roomId: "r", handle: "checker", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 } as Member;
    const human = (i: number) => ({ seq: i + 1, id: `m${i}`, roomId: "r", authorKind: "human" as const, memberId: null, authorName: "Mac", text: `REQUEST_${i} ${"x".repeat(29_000)}`, mentions: [], turnId: null, status: "done" as const, createdAt: now + i, updatedAt: now + i });
    const { text, deferred } = buildTurnPrompt({ room, members: [me], me, newMessages: [0, 1, 2, 3].map(human), reason: "go", triggerId: "m0" });
    expect(text).toContain("REQUEST_0"); // the trigger, though it's the oldest
    expect(text).toContain("REQUEST_3");
    expect(deferred.map((m) => m.id)).toEqual(["m1"]); // kept unread for the next turn, not dropped
    expect(text).toContain("1 earlier request didn't fit: you'll get it in your next turn");
  });

  test("requests that didn't fit are delivered in a follow-up turn", async () => {
    const t = setup({ mode: "direct" });
    t.add("checker", { delayMs: 150, reply: "ok {n}" });
    t.engine.postHumanMessage(t.room.id, "@checker warm up", "Mac");
    await Bun.sleep(50);
    for (let i = 0; i < 4; i++) t.engine.postHumanMessage(t.room.id, `@checker REQUEST_${i} ${"x".repeat(29_000)}`, "Mac");
    await t.engine.whenIdle();
    const prompts = t.prompts.map((p) => p.input.prompt);
    expect(prompts.length).toBe(3);
    expect(["REQUEST_0", "REQUEST_2", "REQUEST_3"].every((r) => prompts[1].includes(r))).toBe(true);
    expect(prompts[1]).not.toContain("REQUEST_1");
    expect(prompts[2]).toContain("REQUEST_1");
    expect(prompts[2]).toContain("Continuing: some earlier messages didn't fit");
  });

  test("a message too long for the prompt is saved whole for the agent to read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-long-"));
    try {
      const t = setup({ mode: "direct", cwd: dir });
      t.add("checker", { reply: "ok" });
      const long = `START ${"y".repeat(50_000)} END_OF_LONG_MESSAGE`;
      const msg = t.engine.postHumanMessage(t.room.id, long, "Mac");
      await t.engine.whenIdle();
      const path = join(realpathSync(dir), ".crosstalk", "messages", `${msg.id}.md`); // /var is /private/var on macOS
      expect(t.prompts[0].input.prompt).toContain(`the full message is in ${path}`);
      expect(t.prompts[0].input.prompt).not.toContain("END_OF_LONG_MESSAGE");
      expect(existsSync(path) && readFileSync(path, "utf8")).toBe(long);
      // A link planted where the messages folder goes is never followed.
      const evil = mkdtempSync(join(tmpdir(), "ct-elsewhere-"));
      const other = mkdtempSync(join(tmpdir(), "ct-linked-"));
      try {
        const t2 = setup({ mode: "direct", cwd: other });
        t2.add("checker", { reply: "ok" });
        mkdirSync(join(other, ".crosstalk"), { recursive: true });
        symlinkSync(evil, join(other, ".crosstalk", "messages"));
        t2.engine.postHumanMessage(t2.room.id, long, "Mac");
        await t2.engine.whenIdle();
        expect(readdirSync(evil)).toEqual([]);
        expect(t2.prompts[0].input.prompt).toContain("room_read shows the full message");
      } finally {
        rmSync(evil, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("build & review: an expert's fix request reaches the builder even while a review runs", async () => {
    const t = setup({ mode: "review", parallel: true });
    t.add("builder", { delayMs: 30, replies: ["Built the schema. @expert please check the schema.", "Fixed the users table."] });
    t.add("checker", { delayMs: 300, reply: "APPROVED: ok." });
    t.add("expert", { delayMs: 30, reply: "@builder MUST_FIX_SCHEMA: the users table needs an index." });
    t.engine.postHumanMessage(t.room.id, "build the schema", "Mac");
    await t.engine.whenIdle();
    const builder = t.prompts.filter((p) => p.handle === "builder");
    expect(builder.length).toBe(2);
    expect(builder[1].input.prompt).toContain("MUST_FIX_SCHEMA");
    // The first review approved older work while the fix was under way: only the review of the fix ends the loop.
    expect(t.prompts.filter((p) => p.handle === "checker").length).toBe(2);
    expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
  });

  test("build & review: a review running when the loop paused doesn't restart old work after the answer", async () => {
    const t = setup({ mode: "review", parallel: true });
    t.add("builder", { delayMs: 50, replies: ["Built A.", "QUESTION: which format for B?", "Built B with JSON."] });
    t.add("checker", { delayMs: 400, replies: ["Bug in A.", "APPROVED: ok."] });
    t.engine.postHumanMessage(t.room.id, "build A", "Mac");
    await Bun.sleep(100); // A is built; its review is running
    t.engine.postHumanMessage(t.room.id, "now build B", "Mac");
    while (!t.systemMessages().some((m) => m.text.includes("waiting for your answer"))) await Bun.sleep(5); // B asked
    expect(t.engine.runningTurns(t.room.id).length).toBe(1); // A's review is still running
    t.engine.postHumanMessage(t.room.id, "JSON", "Mac");
    await t.engine.whenIdle();
    // The old review's "Bug in A." came back after the answer: it doesn't send the builder off again.
    expect(t.prompts.filter((p) => p.handle === "builder").length).toBe(3);
    expect(t.prompts.filter((p) => p.handle === "checker").length).toBe(2);
    expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
  });

  test("build & review: the reviewer's explicit @builder request reaches a busy builder", async () => {
    const t = setup({ mode: "review", parallel: true });
    t.add("builder", { delayMs: 300, replies: ["Built A.", "Renamed the endpoint."] });
    t.add("checker", { delayMs: 30, replies: ["@builder MUST_RENAME the endpoint to /v2.", "APPROVED: ok."] });
    t.engine.postHumanMessage(t.room.id, "build A", "Mac");
    await Bun.sleep(50);
    t.engine.postHumanMessage(t.room.id, "@checker is the endpoint name right?", "Mac"); // answered while A is built
    await t.engine.whenIdle();
    const builder = t.prompts.filter((p) => p.handle === "builder");
    expect(builder.length).toBe(2);
    expect(builder[1].input.prompt).toContain("MUST_RENAME");
    expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
  });

  test("build & review: the reviewer's request reaches the builder while its turn is stale after a pause", async () => {
    const t = setup({ mode: "review", parallel: true });
    t.add("builder", { delayMs: 500, replies: ["Built A.", "Built B.", "Used tabs."] });
    const checker = t.add("checker", { delayMs: 150, replies: ["QUESTION: tabs or spaces?", "@builder use tabs: MUST_TABS.", "APPROVED: ok."] });
    t.engine.postHumanMessage(t.room.id, "build A", "Mac");
    while (!t.engine.runningTurns(t.room.id).some((x) => x.memberId === checker.id)) await Bun.sleep(5); // A's review
    t.engine.postHumanMessage(t.room.id, "build B", "Mac"); // B is being built when the review asks its question
    while (!t.systemMessages().some((m) => m.text.includes("waiting for your answer"))) await Bun.sleep(5);
    t.engine.postHumanMessage(t.room.id, "@checker what do you mean?", "Mac");
    await t.engine.whenIdle();
    const builder = t.prompts.filter((p) => p.handle === "builder");
    expect(builder.length).toBe(3);
    expect(builder[2].input.prompt).toContain("MUST_TABS");
    expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
  });

  test("build & review: a stale review can't restart old work through an expert", async () => {
    const t = setup({ mode: "review", parallel: true });
    t.add("builder", { delayMs: 50, replies: ["Built A.", "QUESTION: which format for B?", "Built B with JSON."] });
    const checker = t.add("checker", { delayMs: 400, replies: ["@expert inspect OLD_SCHEMA.", "APPROVED: ok."] });
    t.add("expert", { delayMs: 30, reply: "@builder APPLY_OLD_SCHEMA_FIX" });
    t.engine.postHumanMessage(t.room.id, "build A", "Mac");
    while (!t.engine.runningTurns(t.room.id).some((x) => x.memberId === checker.id)) await Bun.sleep(5); // A's review
    t.engine.postHumanMessage(t.room.id, "now build B", "Mac");
    while (!t.systemMessages().some((m) => m.text.includes("waiting for your answer"))) await Bun.sleep(5);
    t.engine.postHumanMessage(t.room.id, "JSON", "Mac");
    await t.engine.whenIdle();
    expect(t.prompts.filter((p) => p.handle === "expert").length).toBe(0);
    expect(t.prompts.filter((p) => p.handle === "builder").length).toBe(3);
    expect(t.systemMessages().filter((m) => m.text.includes("approved")).length).toBe(1);
  });

  test("build & review: QUESTION inside a code example doesn't pause; a real one posts a notice", async () => {
    const example = setup({ mode: "review", maxHops: 1 });
    example.add("builder", { reply: "Prompt format:\n```\nQUESTION: like this\n```\nDone." });
    example.add("checker", { reply: "APPROVED: ok." });
    example.engine.postHumanMessage(example.room.id, "go", "Mac");
    await example.engine.whenIdle();
    expect(example.agentMessages().map((m) => m.authorName)).toEqual(["builder", "checker"]);
    const real = setup({ mode: "review" });
    real.add("builder", { reply: "**QUESTION:** Postgres or SQLite?" });
    real.add("checker", { reply: "APPROVED: ok." });
    real.engine.postHumanMessage(real.room.id, "go", "Mac");
    await real.engine.whenIdle();
    expect(real.agentMessages().map((m) => m.authorName)).toEqual(["builder"]);
    expect(real.systemMessages().some((m) => m.text.includes("waiting for your answer to @builder's question"))).toBe(true);
  });

  test("build & review: approval on its own line after a short note still ends the loop", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { reply: "Built it." });
    t.add("checker", { reply: "Checked the diff and ran the tests.\n\n**APPROVED:** looks good." });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["builder", "checker"]);
    expect(t.systemMessages().some((m) => m.text.includes("approved"))).toBe(true);
  });

  test("build & review: pauses at the hand-off limit without approval", async () => {
    const t = setup({ mode: "review", maxHops: 3 });
    t.add("builder", { reply: "Work, turn {n}." });
    t.add("checker", { reply: "Still broken, turn {n}." });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().length).toBe(4);
    expect(t.systemMessages().some((m) => m.text.includes("Review loop paused after 3 hand-offs"))).toBe(true);
  });

  test("build & review: a QUESTION for the human pauses the loop", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { reply: "QUESTION: Postgres or SQLite?" });
    t.add("checker", { reply: "APPROVED: fine." });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["builder"]);
  });

  test("build & review: even limits end on the reviewer without an unchecked final build", async () => {
    const t = setup({ mode: "review", maxHops: 4 });
    t.add("builder", { reply: "Work, turn {n}." });
    t.add("checker", { reply: "Still broken, turn {n}." });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["builder", "checker", "builder", "checker"]);
  });

  test("build & review: quoted approval and approval with a question do not accept the work", async () => {
    for (const reply of ['Example output:\n> APPROVED: example only.\nFix parse.ts:10 first.', 'APPROVED: maybe.\n  QUESTION: Which behavior do you want?', 'Example output:\n```text\nAPPROVED: example only.\n```\nFix parse.ts:10 first.', 'Example output:\n~~~\nAPPROVED: example only.\n~~~\nFix parse.ts:10 first.', 'Example output:\n    APPROVED: example only.\nFix parse.ts:10 first.']) {
      const t = setup({ mode: "review", maxHops: 1 });
      t.add("builder", { reply: "Built it." });
      t.add("checker", { reply });
      t.engine.postHumanMessage(t.room.id, "go", "Mac");
      await t.engine.whenIdle();
      expect(t.systemMessages().some((m) => m.text.includes("approved @builder"))).toBe(false);
      expect(t.agentMessages().length).toBe(2);
    }
  });

  test("attachment paths do not select a different recipient", async () => {
    const t = setup({ mode: "direct" });
    t.add("builder"); t.add("checker");
    t.engine.postHumanMessage(t.room.id, 'See local file "/tmp/folder @checker/file.png"', "Mac", "See this image");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["builder"]);
  });

  test("loop guard stops an agent repeating itself", async () => {
    const t = setup({ maxHops: 20 });
    t.add("ping", { handoff: "pong", pingpong: true, reply: "same" });
    t.add("pong", { handoff: "ping", pingpong: true, reply: "same" });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().length).toBeLessThan(6);
    expect(t.systemMessages().some((m) => m.text.includes("Stopped a loop"))).toBe(true);
  });

  test("Off: agent mentions don't start turns, in replies or chat posts", async () => {
    const t = setup({ mode: "direct", parallel: true });
    const writer = t.add("writer", { handoff: "reviewer", delayMs: 200 });
    t.add("reviewer");
    t.engine.postHumanMessage(t.room.id, "@writer do it", "Mac");
    await Bun.sleep(60);
    expect(t.engine.agentPost(writer.id, "@reviewer should I keep the old API?")!.mentions).toEqual([]);
    await t.engine.whenIdle();
    expect(t.agentMessages().filter((m) => m.turnId && m.text).map((m) => m.authorName)).toEqual(["writer", "writer"]); // reply + post
    expect(t.prompts.map((p) => p.handle)).toEqual(["writer"]);
  });

  test("a chat post's @mention doesn't start a turn in a review room either", async () => {
    const t = setup({ mode: "review", parallel: true });
    const builder = t.add("builder", { delayMs: 200, reply: "Built." });
    t.add("checker", { reply: "APPROVED: ok." });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await Bun.sleep(60);
    t.engine.agentPost(builder.id, "Working on api.ts; @checker please stay off it.");
    await t.engine.whenIdle();
    expect(t.prompts.map((p) => p.handle)).toEqual(["builder", "checker"]); // just the loop's review
  });

  test("a reply still being written when another agent reads the chat reaches it once finished", async () => {
    const t = setup({ mode: "direct", parallel: true });
    t.add("slow", { delayMs: 400, reply: "Slow agent's finished answer." });
    t.add("fast", { delayMs: 30, reply: "fast reply {n}" });
    t.engine.postHumanMessage(t.room.id, "@slow @fast go", "Mac");
    await t.engine.whenIdle();
    t.engine.postHumanMessage(t.room.id, "@fast what did slow say?", "Mac");
    await t.engine.whenIdle();
    const fast = t.prompts.filter((p) => p.handle === "fast");
    expect(fast[0].input.prompt).not.toContain("Slow agent's finished answer."); // still being written then
    expect(fast[1].input.prompt).toContain("Slow agent's finished answer.");
    expect(fast[1].input.prompt.match(/what did slow say/g)?.length).toBe(1); // nothing delivered twice
  });

  test("several quick human messages to a busy agent queue one turn, not one each", async () => {
    const t = setup({ mode: "review" });
    t.add("builder", { delayMs: 200, reply: "Working." });
    t.add("checker", { reply: "APPROVED: ok." });
    t.engine.postHumanMessage(t.room.id, "first", "Mac");
    await Bun.sleep(40);
    t.engine.postHumanMessage(t.room.id, "second", "Mac");
    t.engine.postHumanMessage(t.room.id, "third", "Mac");
    await t.engine.whenIdle();
    // Three messages: two builder turns (the second sees both later messages), and one review covers them.
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["builder", "builder", "checker"]);
    expect(t.prompts.filter((p) => p.handle === "builder")[1].input.prompt).toContain("third");
  });

  test("human @all reaches every agent", async () => {
    const t = setup({ mode: "direct" });
    t.add("a");
    t.add("b");
    t.add("c");
    t.engine.postHumanMessage(t.room.id, "@all status?", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName).sort()).toEqual(["a", "b", "c"]);
  });

  test("round-robin runs each agent in order for N rounds", async () => {
    const t = setup({ mode: "roundrobin", rounds: 2 });
    t.add("a");
    t.add("b");
    t.add("c");
    t.engine.postHumanMessage(t.room.id, "brainstorm names", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages().map((m) => m.authorName)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  test("lead mode sends un-mentioned messages to the lead", async () => {
    const t = setup({ mode: "lead" });
    t.add("worker");
    const lead = t.add("boss");
    t.store.updateRoom(t.room.id, { leadMemberId: lead.id });
    t.engine.postHumanMessage(t.room.id, "ship it", "Mac");
    await t.engine.whenIdle();
    expect(t.agentMessages()[0].authorName).toBe("boss");
    expect(t.prompts[0].input.prompt).toContain("lead");
  });

  test("one agent at a time unless the room is parallel", async () => {
    const t = setup({ mode: "direct" });
    t.add("a", { delayMs: 120, reply: "a" });
    t.add("b", { delayMs: 120, reply: "b" });
    let maxRunning = 0;
    t.bus.on(() => (maxRunning = Math.max(maxRunning, t.engine.runningTurns(t.room.id).length)));
    t.engine.postHumanMessage(t.room.id, "@a @b go", "Mac");
    await t.engine.whenIdle();
    expect(maxRunning).toBe(1);

    const p = setup({ mode: "direct", parallel: true });
    p.add("a", { delayMs: 120, reply: "a" });
    p.add("b", { delayMs: 120, reply: "b" });
    let maxP = 0;
    p.bus.on(() => (maxP = Math.max(maxP, p.engine.runningTurns(p.room.id).length)));
    p.engine.postHumanMessage(p.room.id, "@a @b go", "Mac");
    await p.engine.whenIdle();
    expect(maxP).toBe(2);
  });
});

describe("agent settings", () => {
  test("a change made while an agent is busy (say, its account) takes effect from its next turn", async () => {
    const store = new Store(":memory:");
    let account = "first-account";
    const envs: string[] = [];
    const engine = new Engine({
      store,
      bus: new Bus(),
      agentEnv: () => ({ ACCOUNT: account }),
      createDriver: (ctx) => {
        envs.push(ctx.env.ACCOUNT);
        return new MockDriver(ctx);
      },
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    const now = Date.now();
    store.insertRoom({ id: "r", name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false });
    store.insertMember({ id: "a", roomId: "r", handle: "agent", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: { delayMs: 150, reply: "ok" }, createdAt: now, position: 0 });
    engine.postHumanMessage("r", "one", "Mac");
    await Bun.sleep(40);
    account = "second-account"; // switched mid-turn, nothing in the member's own settings changed
    await engine.memberChanged("a");
    await engine.whenIdle();
    engine.postHumanMessage("r", "two", "Mac");
    await engine.whenIdle();
    expect(envs).toEqual(["first-account", "second-account"]);
    await engine.shutdown();
  });
});

describe("frozen agents", () => {
  function frozenSetup(behaviour: (call: number, input: TurnInput, sink: TurnSink) => Promise<{ ok: boolean; text?: string }>) {
    const store = new Store(":memory:");
    const bus = new Bus();
    const calls: TurnInput[] = [];
    let disposed = 0;
    const engine = new Engine({
      store,
      bus,
      stallMs: 150,
      createDriver: (): AgentDriver => ({
        provider: "mock",
        runTurn: (input, sink) => {
          calls.push(input);
          return behaviour(calls.length, input, sink);
        },
        interrupt: async () => {},
        dispose: async () => {
          disposed++;
        },
      }),
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    const now = Date.now();
    const room: Room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
    store.insertRoom(room);
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    const replies = () => store.listMessages(room.id, { limit: 50 }).filter((m) => m.authorKind === "agent").map((m) => [m.status, m.text]);
    return { store, engine, room, calls, replies, disposedCount: () => disposed };
  }
  const never = () => new Promise<{ ok: boolean }>(() => {});

  test("a turn that goes silent is ended, the agent restarted, and asked once to continue", async () => {
    const t = frozenSetup(async (call) => (call === 1 ? never() : { ok: true, text: "Picked up and finished." }));
    t.engine.postHumanMessage(t.room.id, "do the thing", "Mac");
    await t.engine.whenIdle();
    expect(t.calls.length).toBe(2);
    expect(t.calls[1].prompt).toContain("Your last turn stopped responding, so Crosstalk restarted you");
    // The retry gets the original request again, and a fresh briefing: the new process may not have the old session.
    expect(t.calls[1].prompt).toContain("do the thing");
    expect(t.calls[1].systemNote).toBeTruthy();
    expect(t.replies()).toEqual([
      ["error", "⚠️ @claude stopped responding for 1 minute, so Crosstalk restarted it and asked it to continue."],
      ["done", "Picked up and finished."],
    ]);
    expect(t.disposedCount()).toBe(1); // the frozen process was replaced
    await t.engine.shutdown();
  });

  test("in a chat, the retry after a freeze keeps the message's rewind point at the try the agent took it in with", async () => {
    const t = frozenSetup(async (call, _input, sink) => {
      if (call > 1) return { ok: true, text: "Picked up and finished." };
      sink.taken?.();
      return never();
    });
    t.store.insertChat({ roomId: t.room.id, provider: "claude", origin: "web", localId: null });
    const ask = t.engine.postHumanMessage(t.room.id, "do the thing", "Mac");
    await t.engine.whenIdle();
    // Sent again, but a rewind to it still goes back to before the frozen try (it's in the agent's session).
    expect(t.calls[1].prompt).toContain("do the thing");
    expect(t.calls.map((c) => c.messageIds)).toEqual([[ask.id], []]);
    await t.engine.shutdown();
  });

  test("a second freeze in a row isn't retried again", async () => {
    const t = frozenSetup(() => never());
    t.engine.postHumanMessage(t.room.id, "do the thing", "Mac");
    await t.engine.whenIdle();
    expect(t.calls.length).toBe(2);
    expect(t.replies().map((r) => r[0])).toEqual(["error", "error"]);
    expect(String(t.replies()[1][1])).toContain("Send a message to try again");
    await t.engine.shutdown();
  });

  test("shutdown waits for processes the watchdog let go of, not only current ones", async () => {
    const { endProcess, processGrace } = await import("../src/util/process");
    const grace = processGrace.ms;
    processGrace.ms = 100;
    const procs: ReturnType<typeof Bun.spawn>[] = [];
    try {
      const store = new Store(":memory:");
      const engine = new Engine({
        store,
        bus: new Bus(),
        stallMs: 150,
        createDriver: (): AgentDriver => {
          let proc: ReturnType<typeof Bun.spawn> | null = null;
          return {
            provider: "mock",
            runTurn: () => {
              // Frozen: it ignores SIGTERM (and ends once the run that started it has gone, should that run be killed).
              proc = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; while kill -0 $PPID 2>/dev/null; do sleep 1; done"]);
              procs.push(proc);
              return new Promise(() => {});
            },
            interrupt: async () => {},
            dispose: async () => {
              if (proc) await endProcess(proc);
            },
          };
        },
        mcpLaunch: () => ({ command: "true", args: [], env: {} }),
      });
      const now = Date.now();
      store.insertRoom({ id: "r", name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false });
      store.insertMember({ id: "m", roomId: "r", handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
      engine.postHumanMessage("r", "go", "Mac");
      while (procs.length < 2) await Bun.sleep(10); // the first froze, the watchdog dropped it and retried
      await engine.shutdown();
      // Every one has exited by the time shutdown returns (by SIGKILL, or SIGTERM if it hadn't set its trap yet).
      for (const p of procs) {
        expect(p.signalCode !== null || p.exitCode !== null).toBe(true);
        expect(() => process.kill(p.pid, 0)).toThrow();
      }
    } finally {
      processGrace.ms = grace;
      for (const p of procs) p.kill("SIGKILL");
    }
  });

  test("waiting for the human's approval isn't mistaken for a freeze", async () => {
    let approvalAsked = false;
    const t = frozenSetup(async (_call, _input, sink) => {
      approvalAsked = true;
      const decision = await sink.approval({ kind: "command", title: "npm test", detail: "" });
      await Bun.sleep(100); // keeps working quietly after the (long) approval, within the stall limit
      return { ok: true, text: `Decision: ${decision}` };
    });
    t.engine.postHumanMessage(t.room.id, "run the tests", "Mac");
    while (!approvalAsked) await Bun.sleep(10);
    await Bun.sleep(600); // four times the stall limit
    expect(t.engine.runningTurns(t.room.id).length).toBe(1);
    const pending = t.store.listMessages(t.room.id, { limit: 10 }); // the turn is still the same one
    expect(pending.some((m) => m.status === "error")).toBe(false);
    const approval = (t.store as unknown as { db: { query: (q: string) => { get: () => { id: string } } } }).db.query("SELECT id FROM approvals LIMIT 1").get();
    t.engine.decideApproval(approval.id, "approve", "Mac");
    await t.engine.whenIdle();
    expect(t.replies()).toEqual([["done", "Decision: approve"]]);
    await t.engine.shutdown();
  });
});

describe("streaming", () => {
  test("each streamed piece says where it starts, so a client can merge after reloading history", async () => {
    const t = setup({ mode: "direct" });
    // Long enough to go out in several batches.
    t.add("writer", { reply: "Streaming 🚀 in several words, emoji included.", delayMs: 800 });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    const deltas = t.events.filter((e) => e.t === "message.delta") as Extract<ServerEvent, { t: "message.delta" }>[];
    expect(deltas.length).toBeGreaterThan(2);
    let text = "";
    for (const d of deltas) {
      expect(d.offset).toBe(text.length);
      text += d.delta;
    }
    expect(text).toBe(t.agentMessages()[0].text);
  });

  /** A chat whose agent writes its reply in many small pieces, a few milliseconds apart. */
  function writer(pieces: string[], gapMs = 2) {
    const store = new Store(":memory:");
    const bus = new Bus();
    const events: ServerEvent[] = [];
    bus.on((e) => events.push(e));
    const engine = new Engine({
      store,
      bus,
      createDriver: (): AgentDriver => ({
        provider: "mock",
        runTurn: async (_input, sink) => {
          for (const p of pieces) {
            sink.text(p);
            await Bun.sleep(gapMs);
          }
          return { ok: true };
        },
        interrupt: async () => {},
        dispose: async () => {},
      }),
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    const now = Date.now();
    const room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false } as Room;
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
    const member: Member = { id: newId("mb"), roomId: room.id, handle: "writer", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 };
    store.insertMember(member);
    return { store, engine, room, member, events };
  }

  test("a reply streamed in many pieces sends a few member events, not one per piece", async () => {
    const pieces = Array.from({ length: 200 }, (_, i) => `word${i} `);
    const t = writer(pieces);
    t.engine.postHumanMessage(t.room.id, "write a lot", "Mac");
    await t.engine.whenIdle();
    const mine = t.events.filter((e): e is Extract<ServerEvent, { t: "member" }> => e.t === "member" && e.member.id === t.member.id);
    // Waiting, reading the message, writing, done: each said once, however many pieces the reply came in.
    expect(mine.map((e) => e.member.status)).toEqual(["queued", "thinking", "working", "idle"]);
    expect(mine.length).toBeLessThanOrEqual(4);
    expect(t.store.listMessages(t.room.id).at(-1)?.text).toBe(pieces.join("").trim());
    await t.engine.shutdown();
  });

  test("batched pieces still say where they start", async () => {
    const pieces = Array.from({ length: 150 }, (_, i) => (i % 25 === 0 ? `\n\n🚀 Part ${i / 25 + 1}: ` : `w${i} `));
    const t = writer(pieces);
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    const deltas = t.events.filter((e): e is Extract<ServerEvent, { t: "message.delta" }> => e.t === "message.delta");
    // Several batches, far fewer than the pieces.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThan(pieces.length / 5);
    let text = "";
    for (const d of deltas) {
      expect(d.offset).toBe(text.length);
      text += d.delta;
    }
    expect(text).toBe(pieces.join(""));
    // The finished reply is the same text (trimmed), and every batch went out before it.
    const finished = t.events.findLastIndex((e) => e.t === "message" && e.message.authorKind === "agent" && e.message.status === "done");
    expect(t.events.findLastIndex((e) => e.t === "message.delta")).toBeLessThan(finished);
    expect(t.store.listMessages(t.room.id).at(-1)?.text).toBe(text.trim());
    await t.engine.shutdown();
  });
});

describe("restarts and stuck processes", () => {
  test("work a restart interrupted is picked up again, once", async () => {
    const t = setup({ mode: "direct" });
    const worker = t.add("worker", { reply: "Finished it." });
    const now = Date.now();
    // The human's request had been delivered (marked read) when the restart hit.
    const human = { id: newId("m") };
    t.store.insertMessage({ id: human.id, roomId: t.room.id, authorKind: "human", memberId: null, authorName: "Mac", text: "ORIGINAL_REQUEST: tidy the README", mentions: [], turnId: null, status: "done", createdAt: now - 61_000, updatedAt: now - 61_000 });
    t.store.setLastSeen(worker.id, t.store.maxSeq(t.room.id), 1, []);
    t.store.insertTurn({ id: newId("t"), roomId: t.room.id, memberId: worker.id, triggerMessageId: human.id, replyMessageId: null, hop: 0, chainId: "ch_x", origin: "human", status: "running", error: null, usage: null, createdAt: now - 60_000, startedAt: now - 60_000, endedAt: null });
    // The hub restarts: a new engine on the same database.
    const seenPrompts: string[] = [];
    const engine = new Engine({
      store: t.store,
      bus: t.bus,
      createDriver: (ctx) => {
        const inner = new MockDriver(ctx);
        return { provider: "mock", runTurn: (input, sink) => (seenPrompts.push(input.prompt), inner.runTurn(input, sink)), interrupt: () => inner.interrupt(), dispose: () => inner.dispose() };
      },
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    engine.resumeAfterRestart();
    await engine.whenIdle();
    expect(seenPrompts[0]).toContain("ORIGINAL_REQUEST"); // the request is delivered again, not just "pick up where you left off"
    const replies = t.store.listMessages(t.room.id, { limit: 50 }).filter((m) => m.authorKind === "agent").map((m) => m.text);
    expect(replies).toEqual(["Finished it."]);
    expect(t.systemMessages().some((m) => m.text.includes("Agents that were working are picking up where they left off"))).toBe(true);
    // Another restart straight away (say the turn crashed the hub) doesn't resume the same work again.
    t.store.insertTurn({ id: newId("t"), roomId: t.room.id, memberId: worker.id, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: "ch_x", origin: "human", status: "running", error: null, usage: null, createdAt: now, startedAt: now, endedAt: null });
    const again = new Engine({ store: t.store, bus: t.bus, createDriver: (ctx) => new MockDriver(ctx), mcpLaunch: () => ({ command: "true", args: [], env: {} }) });
    again.resumeAfterRestart();
    await again.whenIdle();
    expect(t.store.listMessages(t.room.id, { limit: 50 }).filter((m) => m.authorKind === "agent").length).toBe(1);
    await engine.shutdown();
    await again.shutdown();
  });

  test("a hub shutdown keeps running work unfinished, and the next start resumes it", async () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const prompts: string[] = [];
    const make = () =>
      new Engine({
        store,
        bus,
        createDriver: (ctx) => {
          const inner = new MockDriver(ctx);
          return { provider: "mock", runTurn: (input, sink) => (prompts.push(input.prompt), inner.runTurn(input, sink)), interrupt: () => inner.interrupt(), dispose: () => inner.dispose() };
        },
        mcpLaunch: () => ({ command: "true", args: [], env: {} }),
      });
    const now = Date.now();
    const room: Room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
    store.insertRoom(room);
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "worker", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: { delayMs: 400, reply: "Finished." }, createdAt: now, position: 0 });
    const first = make();
    first.postHumanMessage(room.id, "TIDY_THE_README please", "Mac");
    while (!first.runningTurns(room.id).length) await Bun.sleep(10);
    await first.shutdown(); // a normal restart, mid-turn
    expect(store.unfinishedTurns().length).toBe(1);
    const second = make();
    second.resumeAfterRestart();
    await second.whenIdle();
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("TIDY_THE_README"); // the request is delivered again
    const replies = store.listMessages(room.id, { limit: 20 }).filter((m) => m.authorKind === "agent");
    expect(replies.at(-1)).toMatchObject({ status: "done", text: "Finished." });
    await second.shutdown();
  });

  test("a reply on the model pool's server waits after a restart until the pool runs again, and not if it was answered meanwhile", async () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const prompts: string[] = [];
    const make = () =>
      new Engine({
        store,
        bus,
        createDriver: (ctx) => {
          const inner = new MockDriver(ctx);
          return { provider: "mock", runTurn: (input, sink) => (prompts.push(input.prompt), inner.runTurn(input, sink)), interrupt: () => inner.interrupt(), dispose: () => inner.dispose() };
        },
        mcpLaunch: () => ({ command: "true", args: [], env: {} }),
      });
    const now = Date.now();
    const room: Room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
    store.insertRoom(room);
    const member = { id: newId("mb"), roomId: room.id, handle: "local", provider: "mock" as const, model: null, role: "", permissionMode: "ask" as const, status: "idle" as const, statusDetail: null, config: { delayMs: 400, reply: "Finished.", account: "pool1" }, createdAt: now, position: 0 };
    store.insertMember(member);
    const onPool = (m: Member) => m.config?.account === "pool1";
    const first = make();
    first.postHumanMessage(room.id, "SUMMARIZE_THE_LOG please", "Phone");
    while (!first.runningTurns(room.id).length) await Bun.sleep(10);
    await first.shutdown();
    // The hub starts again: the pool's server isn't up yet, so the reply waits instead of failing.
    const second = make();
    second.resumeAfterRestart(onPool);
    await Bun.sleep(100);
    expect(prompts.length).toBe(1);
    expect(store.listMessages(room.id, { limit: 20 }).at(-1)?.text).toContain("once the model pool runs again");
    // The pool runs: it picks up where it left off.
    second.resumeHeld(onPool);
    await second.whenIdle();
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("SUMMARIZE_THE_LOG");
    // Held again after another restart, then answered by hand before the pool came back: nothing to pick up later.
    second.postHumanMessage(room.id, "SECOND_REQUEST now", "Phone");
    while (!second.runningTurns(room.id).length) await Bun.sleep(10);
    await second.shutdown();
    const third = make();
    third.resumeAfterRestart(onPool);
    third.postHumanMessage(room.id, "answer it now", "Phone");
    await third.whenIdle();
    const count = prompts.length;
    third.resumeHeld(onPool);
    await Bun.sleep(100);
    await third.whenIdle();
    expect(prompts.length).toBe(count);
    await third.shutdown();
  });

  test("a chat turn resumed after a restart, once the agent had its message, still rewinds to before the first try", async () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const inputs: TurnInput[] = [];
    const make = (behave: (sink: TurnSink) => Promise<{ ok: boolean; error?: string; text?: string }>) =>
      new Engine({
        store,
        bus,
        createDriver: (): AgentDriver => ({ provider: "mock", runTurn: (input, sink) => (inputs.push(input), behave(sink)), interrupt: async () => {}, dispose: async () => {} }),
        mcpLaunch: () => ({ command: "true", args: [], env: {} }),
      });
    const now = Date.now();
    const room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false } as Room;
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    // It took the message in and had written part of its answer when the hub restarted.
    const first = make(async (sink) => {
      sink.taken?.();
      sink.text("Half way through the migration");
      return new Promise(() => {});
    });
    const ask = first.postHumanMessage(room.id, "migrate the prod DB", "Phone");
    for (let i = 0; i < 200 && !inputs.length; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    await first.shutdown();
    const second = make(async () => ({ ok: true, text: "Done." }));
    second.resumeAfterRestart();
    await second.whenIdle();
    // Delivered again, but its rewind point stays the first try's (that try is in the agent's session).
    expect(inputs[1].prompt).toContain("migrate the prod DB");
    expect(inputs[0].messageIds).toEqual([ask.id]);
    expect(inputs[1].messageIds).toEqual([]);
    await second.shutdown();
  });

  test("a process that ignores SIGTERM is killed after the grace period", async () => {
    const { endProcess, processGrace } = await import("../src/util/process");
    const grace = processGrace.ms;
    processGrace.ms = 100;
    // It ignores SIGTERM (and ends once the run that started it has gone, should that run be killed).
    const proc = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; printf ready; while kill -0 $PPID 2>/dev/null; do sleep 1; done"], { stdout: "pipe" });
    try {
      // Under load a fixed delay can expire before the shell installs its signal trap.
      const output = proc.stdout.getReader();
      const ready = await output.read();
      output.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toBe("ready");
      await endProcess(proc); // resolves once it's really gone, so a hub shutting down can wait for it
      expect(proc.signalCode).toBe("SIGKILL");
    } finally {
      processGrace.ms = grace;
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});

describe("approvals and stopping", () => {
  test("approve lets the turn finish", async () => {
    const t = setup();
    t.add("a", { approval: true });
    t.engine.postHumanMessage(t.room.id, "run the tests", "Mac");
    let approvalId = "";
    for (let i = 0; i < 50 && !approvalId; i++) {
      await Bun.sleep(10);
      approvalId = t.store.listPendingApprovals()[0]?.id ?? "";
    }
    expect(approvalId).not.toBe("");
    expect(t.store.listMembers(t.room.id)[0].status).toBe("approval");
    t.engine.decideApproval(approvalId, "approve", "Phone");
    await t.engine.whenIdle();
    expect(t.store.getApproval(approvalId)!.status).toBe("approved");
    expect(t.agentMessages()[0].status).toBe("done");
  });

  test("stop ends a running turn, clears the queue and expires approvals", async () => {
    const t = setup({ mode: "direct" });
    t.add("a", { approval: true });
    t.add("b");
    t.engine.postHumanMessage(t.room.id, "@a @b go", "Mac");
    for (let i = 0; i < 50 && !t.store.listPendingApprovals().length; i++) await Bun.sleep(10);
    await t.engine.stop(t.room.id);
    await t.engine.whenIdle();
    const msgs = t.agentMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].status).toBe("stopped");
    expect(t.store.listPendingApprovals().length).toBe(0);
    expect(t.store.listMembers(t.room.id).every((m) => m.status === "idle")).toBe(true);
  });

  test("errors are reported on the reply and the member", async () => {
    const t = setup();
    t.add("a", { fail: true });
    t.engine.postHumanMessage(t.room.id, "go", "Mac");
    await t.engine.whenIdle();
    const m = t.agentMessages()[0];
    expect(m.status).toBe("error");
    expect(m.text).toContain("Mock failure");
    expect(t.store.listMembers(t.room.id)[0].status).toBe("error");
  });

  test("an agent only sees messages since its last turn", async () => {
    const t = setup({ mode: "direct" });
    t.add("a");
    t.engine.postHumanMessage(t.room.id, "@a first question", "Mac");
    await t.engine.whenIdle();
    t.engine.postHumanMessage(t.room.id, "@a second question", "Mac");
    await t.engine.whenIdle();
    const second = t.prompts[1].input;
    expect(second.prompt).toContain("second question");
    expect(second.prompt).not.toContain("first question");
    expect(second.systemNote).toBeNull(); // roster unchanged, session exists
  });

  test("Stop with keepWaiting ends the running reply, then answers the waiting message", async () => {
    const t = chatSetup(async (call, _input, sink) => {
      if (call > 1) return { ok: true, text: "Using staging now." };
      sink.taken?.();
      sink.text("Building it…");
      await new Promise<void>((res) => sink.signal.addEventListener("abort", () => res(), { once: true }));
      return { ok: false, error: "stopped" };
    });
    t.engine.postHumanMessage(t.room.id, "build it", "Mac");
    await t.started(1);
    const waiting = t.engine.postHumanMessage(t.room.id, "wait, use the staging database", "Phone");
    await t.engine.stop(t.room.id, undefined, { keepWaiting: true });
    await t.engine.whenIdle();
    expect(t.prompts).toEqual(["build it", "wait, use the staging database"]);
    expect(t.replies()).toEqual([["stopped", "Building it…"], ["done", "Using staging now."]]);
    expect(t.member().readSeq ?? 0).toBeGreaterThanOrEqual(waiting.seq);
    expect(t.member().status).toBe("idle");
    await t.engine.shutdown();
  });

  test("Stop everything leaves the waiting message unread, and retry answers it", async () => {
    const t = chatSetup(async (call, _input, sink) => {
      if (call > 1) return { ok: true, text: "Using staging now." };
      sink.taken?.();
      await new Promise<void>((res) => sink.signal.addEventListener("abort", () => res(), { once: true }));
      return { ok: false, error: "stopped" };
    });
    t.engine.postHumanMessage(t.room.id, "build it", "Mac");
    await t.started(1);
    const waiting = t.engine.postHumanMessage(t.room.id, "wait, use the staging database", "Phone");
    await t.engine.stop(t.room.id);
    await t.engine.whenIdle();
    expect(t.prompts).toEqual(["build it"]);
    // Nothing answers it, and the app can tell (the agent hasn't read it): "Not answered · Answer now".
    expect(t.member().readSeq ?? 0).toBeLessThan(waiting.seq);
    expect(t.member().status).toBe("idle");
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.prompts).toEqual(["build it", "wait, use the staging database"]);
    expect(t.replies().at(-1)).toEqual(["done", "Using staging now."]);
    expect(t.member().readSeq ?? 0).toBeGreaterThanOrEqual(waiting.seq);
    await t.engine.shutdown();
  });
});

/**
 * A chat whose agent does what `behave` says on each turn (call counts from 1), with what it was sent recorded
 * (`inputs` has each turn's whole input). `extra`: more of the driver (steer, say).
 */
function chatSetup(behave: (call: number, input: TurnInput, sink: TurnSink) => Promise<{ ok: boolean; error?: string; text?: string }>, extra: Partial<AgentDriver> = {}) {
  const store = new Store(":memory:");
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  const prompts: string[] = [];
  const inputs: TurnInput[] = [];
  const engine = new Engine({
    store,
    bus,
    createDriver: (): AgentDriver => ({
      provider: "mock",
      runTurn: (input, sink) => {
        prompts.push(input.prompt);
        inputs.push(input);
        return behave(prompts.length, input, sink);
      },
      interrupt: async () => {},
      dispose: async () => {},
      ...extra,
    }),
    mcpLaunch: () => ({ command: "true", args: [], env: {} }),
  });
  const now = Date.now();
  const room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false } as Room;
  store.insertRoom(room);
  store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
  const memberId = newId("mb");
  store.insertMember({ id: memberId, roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
  const replies = () => store.listMessages(room.id, { limit: 50 }).filter((m) => m.authorKind === "agent").map((m) => [m.status, m.text]);
  const started = async (n: number) => {
    for (let i = 0; i < 200 && (prompts.length < n || !engine.runningTurns(room.id).length); i++) await Bun.sleep(5);
  };
  return { store, engine, room, events, prompts, inputs, replies, started, member: () => store.getMember(memberId)! };
}

describe("try again", () => {
  test("member events carry readSeq", async () => {
    const t = chatSetup(async () => ({ ok: true, text: "Hi." }));
    const sent = t.engine.postHumanMessage(t.room.id, "hello", "Mac");
    // The message's own event says where it is in the chat.
    expect(t.events.find((e) => e.t === "message" && e.message.id === sent.id)).toMatchObject({ message: { seq: sent.seq } });
    await t.engine.whenIdle();
    const mine = t.events.filter((e): e is Extract<ServerEvent, { t: "member" }> => e.t === "member");
    // Waiting for it: not read yet. Reading it: read up to it (and every event after says so).
    expect(mine[0].member).toMatchObject({ status: "queued", readSeq: 0 });
    expect(mine.find((e) => e.member.status === "thinking")?.member.readSeq ?? 0).toBeGreaterThanOrEqual(sent.seq);
    expect(mine.at(-1)?.member).toMatchObject({ status: "idle" });
    expect(mine.at(-1)!.member.readSeq!).toBeGreaterThanOrEqual(sent.seq);
    await t.engine.shutdown();
  });

  test("Try again answers the failed request once, adding the continue note only when the agent had it", async () => {
    let mode: "busy" | "break" | "ok" = "busy";
    const t = chatSetup(async (_call, _input, sink) => {
      // Claude Code refusing a session that's open in the Claude app: it never takes the message in.
      if (mode === "busy") return { ok: false, error: "This conversation is open in the Claude app right now." };
      sink.taken?.();
      if (mode === "break") {
        sink.text("Half way");
        return { ok: false, error: "API Error: overloaded" };
      }
      return { ok: true, text: "Done." };
    });
    // 1. It failed before the agent got the message: given back, and Try again sends it as it was.
    const first = t.engine.postHumanMessage(t.room.id, "please fix the login page", "Phone");
    await t.engine.whenIdle();
    expect(t.replies()).toEqual([["error", "⚠️ This conversation is open in the Claude app right now."]]);
    expect(t.member()).toMatchObject({ status: "error" });
    expect(t.member().readSeq ?? 0).toBeLessThan(first.seq);
    mode = "ok";
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.prompts).toEqual(["please fix the login page", "please fix the login page"]);
    expect(t.replies().at(-1)).toEqual(["done", "Done."]);
    // Answered: once only.
    expect(() => t.engine.retry(t.room.id)).toThrow("A later reply already answered this.");

    // 2. The agent had the message when its reply failed: it gets it again, told to carry on from where it got to.
    mode = "break";
    const second = t.engine.postHumanMessage(t.room.id, "now the signup page", "Phone");
    await t.engine.whenIdle();
    expect(t.replies().at(-1)).toEqual(["error", "Half way"]);
    expect(t.member().readSeq ?? 0).toBeGreaterThanOrEqual(second.seq);
    mode = "ok";
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.prompts).toHaveLength(4);
    expect(t.prompts[3]).toStartWith("(Your last reply ended with an error, and the user asked you to try again.");
    expect(t.prompts[3]).toContain("continuing from wherever you'd got to");
    expect(t.prompts[3]).toEndWith("now the signup page");
    expect(t.replies().at(-1)).toEqual(["done", "Done."]);
    // Both tries answered the same message, so the app can show the failed one as tried again.
    expect(t.store.turnsFor(second.id).map((x) => x.status)).toEqual(["error", "done"]);
    expect(() => t.engine.retry(t.room.id)).toThrow("A later reply already answered this.");
    await t.engine.shutdown();
  });

  test("Try again is refused while the agent works and after a later reply succeeded", async () => {
    let release = () => {};
    const t = chatSetup(async (call, _input, sink) => {
      sink.taken?.();
      if (call === 1) return { ok: false, error: "API Error: overloaded" };
      if (call === 2) await new Promise<void>((res) => (release = res));
      return { ok: true, text: `Reply ${call}` };
    });
    t.engine.postHumanMessage(t.room.id, "first", "Phone");
    await t.engine.whenIdle();
    expect(t.replies().at(-1)?.[0]).toBe("error");
    // A new message is being answered: Try again waits for it.
    t.engine.postHumanMessage(t.room.id, "second", "Phone");
    await t.started(2);
    expect(() => t.engine.retry(t.room.id)).toThrow("is working on it already");
    release();
    await t.engine.whenIdle();
    // That reply succeeded: the older failure isn't tried again.
    expect(() => t.engine.retry(t.room.id)).toThrow("A later reply already answered this.");
    expect(t.prompts).toEqual(["first", "second"]);
    await t.engine.shutdown();
  });

  /** A chat whose first reply waits for `release` (after taking its message in), and whose later ones say "Done.". */
  function heldChat(extra: Partial<AgentDriver> = {}) {
    let release: (r: { ok: boolean; error?: string; text?: string }) => void = () => {};
    const t = chatSetup(async (call, _input, sink) => {
      sink.taken?.();
      if (call === 1) return new Promise((res) => (release = res));
      return { ok: true, text: "Done." };
    }, extra);
    return { ...t, release: (r: { ok: boolean; error?: string; text?: string }) => release(r) };
  }

  test("Try again works after Send now handed a waiting message to the reply that then failed", async () => {
    const t = heldChat({ steer: async () => true });
    t.engine.postHumanMessage(t.room.id, "build it", "Phone");
    await t.started(1);
    t.engine.postHumanMessage(t.room.id, "and the tests", "Phone");
    expect(await t.engine.sendNow(t.room.id)).toBe(true);
    t.release({ ok: false, error: "API Error: overloaded" });
    await t.engine.whenIdle();
    expect(t.replies().at(-1)?.[0]).toBe("error");
    // The waiting turn Send now dropped (made after the reply, never run) isn't what's tried again: the reply is.
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toStartWith("(Your last reply ended with an error");
    expect(t.prompts[1]).toEndWith("build it\n\nand the tests");
    expect(t.replies().at(-1)).toEqual(["done", "Done."]);
    await t.engine.shutdown();
  });

  test("Try again works after a waiting message was taken back while the reply ran, and that reply failed", async () => {
    const t = heldChat();
    t.engine.postHumanMessage(t.room.id, "build it", "Phone");
    await t.started(1);
    const oops = t.engine.postHumanMessage(t.room.id, "oops, wrong chat", "Phone");
    await t.engine.reviseMessage(oops.id, null, "Phone");
    t.release({ ok: false, error: "API Error: overloaded" });
    await t.engine.whenIdle();
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toEndWith("build it");
    expect(t.replies().at(-1)).toEqual(["done", "Done."]);
    await t.engine.shutdown();
  });

  test("Try again sends what the agent had again without making it the rewind point, even after a try that couldn't start", async () => {
    let mode: "break" | "busy" | "ok" = "break";
    const t = chatSetup(async (_call, _input, sink) => {
      if (mode === "busy") return { ok: false, error: "This conversation is open in the Claude app right now." };
      sink.taken?.();
      if (mode === "break") return { ok: false, error: "API Error: overloaded" };
      return { ok: true, text: "Migrated." };
    });
    const ask = t.engine.postHumanMessage(t.room.id, "migrate the prod DB", "Phone");
    await t.engine.whenIdle();
    // The first try delivered it: a rewind to it goes back to before that try.
    expect(t.inputs[0].messageIds).toEqual([ask.id]);
    // Try again that can't start (the Claude app has the conversation open): the agent still has the message from the
    // first try, so it isn't given back as unread.
    mode = "busy";
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.inputs[1].prompt).toEndWith("migrate the prod DB");
    expect(t.inputs[1].messageIds).toEqual([]);
    expect(t.member().readSeq ?? 0).toBeGreaterThanOrEqual(ask.seq);
    // And again, which works: the same request, still the first try's to rewind to.
    mode = "ok";
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.inputs[2].prompt).toStartWith("(Your last reply ended with an error");
    expect(t.inputs[2].messageIds).toEqual([]);
    expect(t.replies().at(-1)).toEqual(["done", "Migrated."]);
    // A new message is its own turn's.
    const next = t.engine.postHumanMessage(t.room.id, "now the staging DB", "Phone");
    await t.engine.whenIdle();
    expect(t.inputs[3].messageIds).toEqual([next.id]);
    await t.engine.shutdown();
  });

  test("Start fresh stops the reply and leaves a message the agent hadn't read unread, for Answer now", async () => {
    const t = chatSetup(async (call, _input, sink) => {
      if (call > 1) return { ok: true, text: "Fresh answer." };
      sink.taken?.();
      await new Promise<void>((res) => sink.signal.addEventListener("abort", () => res(), { once: true }));
      return { ok: false, error: "stopped" };
    });
    t.engine.postHumanMessage(t.room.id, "build it", "Phone");
    await t.started(1);
    const waiting = t.engine.postHumanMessage(t.room.id, "wait, use staging", "Phone");
    await t.engine.resetSession(t.member());
    await t.engine.whenIdle();
    expect(t.replies()[0][0]).toBe("stopped");
    expect(t.prompts).toEqual(["build it"]);
    // Not answered by itself, and not lost: the app shows "Not answered · Answer now" under it.
    expect(t.member().readSeq ?? 0).toBeLessThan(waiting.seq);
    expect(t.member().status).toBe("idle");
    t.engine.retry(t.room.id);
    await t.engine.whenIdle();
    expect(t.prompts).toEqual(["build it", "wait, use staging"]);
    expect(t.replies().at(-1)).toEqual(["done", "Fresh answer."]);
    await t.engine.shutdown();
  });
});

describe("questions from an agent", () => {
  function questionSetup(answer: (store: Store, engine: Engine, approvalId: string) => void) {
    const store = new Store(":memory:");
    const bus = new Bus();
    const engine: Engine = new Engine({
      store,
      bus,
      createDriver: (): AgentDriver => ({
        provider: "mock",
        runTurn: async (_input, sink) => {
          const got = await sink.ask!("Go public", [
            { id: "0", header: "Go public", question: "How should it go public?", options: [{ label: "You flip it", description: "" }, { label: "I flip it", description: "" }], multiSelect: false, allowOther: true },
            { id: "1", header: "Extras", question: "Which extras?", options: [{ label: "Docs", description: "" }, { label: "Tests", description: "" }], multiSelect: true, allowOther: true },
          ]);
          return { ok: true, text: got ? `Answers: ${JSON.stringify(got)}` : "Skipped." };
        },
        interrupt: async () => {},
        dispose: async () => {},
      }),
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    bus.on((e) => {
      if (e.t === "approval" && e.approval.status === "pending") setTimeout(() => answer(store, engine, e.approval.id), 5);
    });
    const now = Date.now();
    const room: Room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
    store.insertRoom(room);
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    const reply = () => store.listMessages(room.id, { limit: 50 }).filter((m) => m.authorKind === "agent").map((m) => m.text);
    return { store, engine, room, reply };
  }

  test("the agent gets your answers; answers to questions it didn't ask, and extra picks, are dropped", async () => {
    const t = questionSetup((_s, engine, id) => engine.decideApproval(id, "approve", "Phone", { "0": ["I flip it", "You flip it"], "1": ["Docs", "Something else"], "9": ["sneaky"] }));
    t.engine.postHumanMessage(t.room.id, "publish it", "Mac");
    await t.engine.whenIdle();
    expect(t.reply()).toEqual([`Answers: {"0":["I flip it"],"1":["Docs","Something else"]}`]);
    const a = t.store.listApprovals(t.room.id)[0];
    expect(a).toMatchObject({ kind: "question", status: "approved", answers: { "0": ["I flip it"], "1": ["Docs", "Something else"] } });
    expect(a.questions?.[1].multiSelect).toBe(true);
    await t.engine.shutdown();
  });

  test("skipping tells the agent nobody answered", async () => {
    const t = questionSetup((_s, engine, id) => engine.decideApproval(id, "deny", "Phone"));
    t.engine.postHumanMessage(t.room.id, "publish it", "Mac");
    await t.engine.whenIdle();
    expect(t.reply()).toEqual(["Skipped."]);
    expect(t.store.listApprovals(t.room.id)[0]).toMatchObject({ status: "denied", answers: null });
    await t.engine.shutdown();
  });
});

describe("send now", () => {
  test("a message waiting behind a chat's running reply goes into that reply, and no second reply runs", async () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const inputs: string[] = [];
    let steered = null as string | null;
    let release = null as (() => void) | null;
    const engine = new Engine({
      store,
      bus,
      createDriver: (): AgentDriver => ({
        provider: "mock",
        runTurn: async (input) => {
          inputs.push(input.prompt);
          await new Promise<void>((res) => (release = res));
          return { ok: true, text: steered ? `Done, and noted: ${steered}` : "Done." };
        },
        steer: async (text) => {
          steered = text;
          return true;
        },
        interrupt: async () => {},
        dispose: async () => {},
      }),
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    const now = Date.now();
    const room: Room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false, chat: { provider: "claude", origin: "web" } } as Room;
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    engine.postHumanMessage(room.id, "build it", "Mac");
    for (let i = 0; i < 100 && !release; i++) await Bun.sleep(5);
    engine.postHumanMessage(room.id, "also add tests", "Phone");
    expect(await engine.sendNow(room.id)).toBe(true);
    expect(steered).toBe("also add tests");
    release!();
    await engine.whenIdle();
    expect(inputs).toEqual(["build it"]); // no second turn for the message that went in early
    const replies = store.listMessages(room.id, { limit: 20 }).filter((m) => m.authorKind === "agent").map((m) => m.text);
    expect(replies).toEqual(["Done, and noted: also add tests"]);
    expect(await engine.sendNow(room.id)).toBe(false); // nothing waiting any more
    await engine.shutdown();
  });

  test("once the agent reads it, the reply continues below the message, with the earlier part kept above", async () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    let sink = null as TurnSink | null;
    let release = null as (() => void) | null;
    const engine = new Engine({
      store,
      bus,
      createDriver: (): AgentDriver => ({
        provider: "mock",
        runTurn: async (_input, s) => {
          sink = s;
          s.text("Working on step one. ");
          await new Promise<void>((res) => (release = res));
          return { ok: true, text: "the whole turn's text, which mustn't replace the last part" };
        },
        steer: async () => {
          // The agent reads the message at its next step, then writes the rest.
          setTimeout(() => {
            sink!.newReply!();
            sink!.text("Got your note, adding tests too.");
            release!();
          }, 10);
          return true;
        },
        interrupt: async () => {},
        dispose: async () => {},
      }),
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    const now = Date.now();
    const room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false } as Room;
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    engine.postHumanMessage(room.id, "build it", "Mac");
    for (let i = 0; i < 100 && !release; i++) await Bun.sleep(5);
    engine.postHumanMessage(room.id, "also add tests", "Phone");
    expect(await engine.sendNow(room.id)).toBe(true);
    await engine.whenIdle();
    const log = store.listMessages(room.id, { limit: 20 }).filter((m) => m.authorKind !== "system").map((m) => `${m.authorKind}: ${m.text}`);
    expect(log).toEqual(["human: build it", "agent: Working on step one.", "human: also add tests", "agent: Got your note, adding tests too."]);
    await engine.shutdown();
  });

  test("both parts of a split reply, and a finished reply, go through finishReply (images the agent linked)", async () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    let sink = null as TurnSink | null;
    let release = null as (() => void) | null;
    const seen: string[] = [];
    const engine = new Engine({
      store,
      bus,
      createDriver: (): AgentDriver => ({
        provider: "mock",
        runTurn: async (_input, s) => {
          sink = s;
          s.text("Before: ![a](a.png)");
          await new Promise<void>((res) => (release = res));
          return { ok: true, text: "" };
        },
        steer: async () => {
          setTimeout(() => {
            sink!.newReply!();
            sink!.text("After: ![b](b.png)");
            release!();
          }, 10);
          return true;
        },
        interrupt: async () => {},
        dispose: async () => {},
      }),
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
      finishReply: (room, text) => {
        seen.push(room.id);
        return text.replace(/\]\((\w)\.png\)/g, "](/api/rooms/r/uploads/$1)");
      },
    });
    const now = Date.now();
    const room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false } as Room;
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    engine.postHumanMessage(room.id, "show me", "Mac");
    for (let i = 0; i < 100 && !release; i++) await Bun.sleep(5);
    engine.postHumanMessage(room.id, "and the other one", "Phone");
    expect(await engine.sendNow(room.id)).toBe(true);
    await engine.whenIdle();
    const replies = store.listMessages(room.id, { limit: 20 }).filter((m) => m.authorKind === "agent").map((m) => m.text);
    expect(replies).toEqual(["Before: ![a](/api/rooms/r/uploads/a)", "After: ![b](/api/rooms/r/uploads/b)"]);
    expect(seen).toEqual([room.id, room.id]);
    await engine.shutdown();
  });
});


describe("editing and unsending your messages", () => {
  function setup() {
    const store = new Store(":memory:");
    const bus = new Bus();
    const prompts: string[] = [];
    const rewound: string[] = [];
    let hold: Promise<void> | null = null;
    const engine = new Engine({
      store,
      bus,
      createDriver: (): AgentDriver => ({
        provider: "mock",
        runTurn: async (input) => {
          prompts.push(input.prompt);
          if (hold) await hold;
          return { ok: true, text: `Re: ${input.prompt}` };
        },
        rewind: async (id) => {
          rewound.push(id);
          return [id];
        },
        interrupt: async () => {},
        dispose: async () => {},
      }),
      mcpLaunch: () => ({ command: "true", args: [], env: {} }),
    });
    const now = Date.now();
    const room = { id: newId("r"), name: "R", cwd: "/tmp", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false } as Room;
    store.insertRoom(room);
    store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null });
    store.insertMember({ id: newId("mb"), roomId: room.id, handle: "claude", provider: "mock", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now, position: 0 });
    const log = () => store.listMessages(room.id, { limit: 50 }).map((m) => `${m.authorKind}: ${m.text}`);
    return { store, engine, room, prompts, rewound, log, setHold: (p: Promise<void> | null) => (hold = p) };
  }

  test("a message the agent read: rewind to before it, drop it and what came after, then send the edit", async () => {
    const t = setup();
    t.engine.postHumanMessage(t.room.id, "one", "Mac");
    await t.engine.whenIdle();
    const two = t.engine.postHumanMessage(t.room.id, "two", "Mac");
    await t.engine.whenIdle();
    expect(t.log()).toEqual(["human: one", "agent: Re: one", "human: two", "agent: Re: two"]);
    const r = await t.engine.reviseMessage(two.id, "TWO, edited", "Mac");
    expect(t.rewound).toEqual([two.id]);
    expect(r.removed.length).toBe(2);
    await t.engine.whenIdle();
    expect(t.log()).toEqual(["human: one", "agent: Re: one", "human: TWO, edited", "agent: Re: TWO, edited"]);
    expect(t.prompts.at(-1)).toBe("TWO, edited");
    await t.engine.shutdown();
  });

  test("a message still waiting: edited in place, or unsent along with the turn that would answer it", async () => {
    const t = setup();
    let release!: () => void;
    t.setHold(new Promise<void>((res) => (release = res)));
    t.engine.postHumanMessage(t.room.id, "first", "Mac");
    await Bun.sleep(20);
    const waiting = t.engine.postHumanMessage(t.room.id, "second", "Mac");
    await t.engine.reviseMessage(waiting.id, "second, fixed", "Mac");
    expect(t.store.getMessage(waiting.id)?.text).toBe("second, fixed");
    expect(t.rewound).toEqual([]); // nothing to rewind: the agent hasn't read it
    await t.engine.reviseMessage(waiting.id, null, "Mac");
    t.setHold(null);
    release();
    await t.engine.whenIdle();
    expect(t.log()).toEqual(["human: first", "agent: Re: first"]); // unsent, and no reply to it
    expect(t.prompts).toEqual(["first"]);
    await t.engine.shutdown();
  });

  test("a read message can't be rewound while the agent works", async () => {
    const t = setup();
    const one = t.engine.postHumanMessage(t.room.id, "one", "Mac");
    await t.engine.whenIdle();
    let release!: () => void;
    t.setHold(new Promise<void>((res) => (release = res)));
    t.engine.postHumanMessage(t.room.id, "two", "Mac");
    await Bun.sleep(20);
    await expect(t.engine.reviseMessage(one.id, null, "Mac")).rejects.toThrow("Stop it first");
    t.setHold(null);
    release();
    await t.engine.whenIdle();
    await t.engine.shutdown();
  });
});
