import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Member, Message, Room, Turn } from "@crosstalk/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect } from "./fixtures";

/*
 * A measurement, not a check: how smoothly a long chat (hundreds of messages) draws while a reply streams into it, with
 * the chat's motion on (a message of yours arriving, the status line, the reply's steps, the words coming in). It never
 * runs with the suite: `CROSSTALK_E2E_FRAMES=<runs>` runs it, on a phone (390 px) in each engine, and Chromium again
 * with its CPU slowed 4x (an older phone). Each run prints its numbers and writes them to /tmp/motion-frames/.
 * The history and the live events are the test's own (the agent never runs).
 */

const HUB = "http://127.0.0.1:8451";
const RUNS = Number(process.env.CROSSTALK_E2E_FRAMES || 0);
const LABEL = process.env.CROSSTALK_E2E_FRAMES_LABEL || "run";
const HISTORY = Number(process.env.CROSSTALK_E2E_FRAMES_HISTORY || 400);
const OUT = "/tmp/motion-frames";

test.skip(!RUNS, "A measurement: CROSSTALK_E2E_FRAMES=<runs> runs it.");
test.beforeEach(({}, info) => test.skip(!info.project.name.endsWith("-390"), "On a phone (390 px), once per engine."));
// With the chat's motion on, as most phones have it (CROSSTALK_E2E_FRAMES_REDUCE=1: with Reduce Motion, to compare).
test.use({ reducedMotion: process.env.CROSSTALK_E2E_FRAMES_REDUCE ? "reduce" : "no-preference" });

const answer = (i: number) =>
  [
    `Answer ${i}: here's what I found in \`src/module${i}.ts\`, and what to do about it.`,
    "",
    "- The first point, with **bold words** and a [link](https://example.com/docs).",
    "- The second point, a little longer, so that it wraps on a phone screen at least once.",
    ...(i % 5 === 0 ? ["", "```ts", `export function step${i}(input: string) {`, `  return input.trim().length + ${i};`, "}", "```"] : []),
    ...(i % 7 === 0 ? ["", "| File | Lines |", "| --- | --- |", `| a${i}.ts | ${i * 3} |`, `| b${i}.ts | ${i * 5} |`] : []),
    "",
    "A closing paragraph that says what happens next and why it matters for the build.",
  ].join("\n");

/** What streams in: a long reply with paragraphs, a list and code, as a model writes it. */
const STREAMED = Array.from({ length: 6 }, (_, k) =>
  [
    `## Part ${k + 1}`,
    "",
    "The streaming reply keeps going with sentences of ordinary length, the kind a model writes when it explains a change, so the markdown has to lay out again as each piece arrives.",
    "",
    "- One thing it checked",
    "- Another thing, with `inline code` in it",
    "",
    "```sh",
    `bun test src/part${k}.test.ts`,
    "```",
    "",
  ].join("\n"),
).join("\n");

async function longChat(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Frames: a long chat" } })).json();
  const snapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  delete member.readSeq;
  let seq = 0;
  const at = (n: number) => 1_700_000_000_000 + n * 1000;
  const message = (kind: "human" | "agent", text: string, extra: Partial<Message> = {}): Message =>
    ({ id: `fr-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: at(seq), updatedAt: at(seq), ...extra }) as Message;
  const messages: Message[] = [];
  for (let i = 1; i <= HISTORY / 2; i++) messages.push(message("human", `Question ${i}: can you look at module ${i}?`), message("agent", answer(i)));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route("**/api/state", (r) => r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, readSeq: seq } : m)) } }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: { room, messages, turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false } }));
  const send = (e: unknown) => socket!.send(JSON.stringify(e));
  return { room, member, message, send, nextSeq: () => seq, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

type Numbers = { frames: number; ms: number; dropped: number; janky: number; p50: number; p95: number; p99: number; worst: number; loaf: number; loafBlocking: number; longTasks: number; cpu?: Record<string, number> };

function summarize(times: number[]): Pick<Numbers, "frames" | "ms" | "dropped" | "janky" | "p50" | "p95" | "p99" | "worst"> {
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const frame = 1000 / 60;
  return {
    frames: gaps.length,
    ms: Math.round(times.at(-1)! - times[0]),
    // Frames that never drew: a gap of two frames' time lost one, and so on.
    dropped: gaps.reduce((n, g) => n + Math.max(0, Math.round(g / frame) - 1), 0),
    janky: gaps.filter((g) => g > frame * 1.5).length,
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    p99: +q(0.99).toFixed(1),
    worst: +(sorted.at(-1) ?? 0).toFixed(1),
  };
}

async function measure(page: Page, request: APIRequestContext, token: string, browserName: string, throttle: number) {
  const chat = await longChat(page, request, token);
  const results: Numbers[] = [];
  try {
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    for (let run = 0; run < RUNS; run++) {
      await page.goto(`/#/room/${chat.room.id}`);
      await expect(page.getByText(`Answer ${HISTORY / 2}:`, { exact: false })).toBeVisible({ timeout: 20_000 });
      // Settled: the history drawn, the screen past its own first moments.
      await page.waitForTimeout(1500);
      if (cdp) {
        await cdp.send("Performance.enable");
        if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
      }
      const before = cdp ? Object.fromEntries(((await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value])) : null;
      await page.evaluate(() => {
        type Rec = { t: number[]; loaf: { d: number; b: number }[]; long: number[]; stop: boolean; miss: number };
        const rec: Rec = { t: [], loaf: [], long: [], stop: false, miss: 0 };
        (window as unknown as { __frames: Rec }).__frames = rec;
        const loop = (t: number) => {
          rec.t.push(t);
          if (!rec.stop) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        try {
          new PerformanceObserver((l) => rec.loaf.push(...l.getEntries().map((e) => ({ d: e.duration, b: (e as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0 })))).observe({ type: "long-animation-frame" });
        } catch {
          // not in this engine
        }
        try {
          new PerformanceObserver((l) => rec.long.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask" });
        } catch {
          // not in this engine
        }
      });

      // The live part: your message from another device, the agent starting, its reply arriving and its steps, then
      // the words streaming in every 40 ms for about five seconds, and the reply ending.
      const n = chat.nextSeq();
      const mine = chat.message("human", `Question ${n}: and the streaming part?`, { createdAt: Date.now(), updatedAt: Date.now() });
      const turn: Turn = { id: `fr-turn-${run}`, roomId: chat.room.id, memberId: chat.member.id, triggerMessageId: mine.id, replyMessageId: null, hop: 0, chainId: `fr-chain-${run}`, status: "running", error: null, usage: null, createdAt: Date.now(), startedAt: Date.now(), endedAt: null };
      const reply = chat.message("agent", "", { turnId: turn.id, status: "streaming", createdAt: Date.now() + 1, updatedAt: Date.now() + 1 });
      const step = (k: number, status: Activity["status"]): Activity => ({ id: `fr-step-${run}-${k}`, roomId: chat.room.id, turnId: turn.id, memberId: chat.member.id, kind: "command", title: `bun test src/part${k}.test.ts`, detail: status === "done" ? "12 pass\n0 fail" : "", status, createdAt: Date.now() + k, updatedAt: Date.now() + k });
      await page.waitForTimeout(150);
      chat.send({ t: "message", message: mine });
      await page.waitForTimeout(150);
      chat.send({ t: "member", member: { ...chat.member, status: "working", readSeq: mine.seq } });
      chat.send({ t: "turn", turn: { ...turn, replyMessageId: reply.id } });
      await page.waitForTimeout(100);
      chat.send({ t: "message", message: reply });
      for (let k = 0; k < 3; k++) {
        await page.waitForTimeout(150);
        chat.send({ t: "activity", activity: step(k, "running") });
        await page.waitForTimeout(150);
        chat.send({ t: "activity", activity: step(k, "done") });
      }
      let offset = 0;
      const started = Date.now();
      while (offset < STREAMED.length && Date.now() - started < 5000) {
        const delta = STREAMED.slice(offset, offset + 24);
        chat.send({ t: "message.delta", messageId: reply.id, roomId: chat.room.id, delta, offset });
        offset += delta.length;
        await page.waitForTimeout(40);
      }
      chat.send({ t: "message", message: { ...reply, text: STREAMED.slice(0, offset), status: "done", updatedAt: Date.now() } });
      chat.send({ t: "turn", turn: { ...turn, replyMessageId: reply.id, status: "done", endedAt: Date.now() } });
      chat.send({ t: "member", member: { ...chat.member, status: "idle", readSeq: mine.seq } });
      await page.waitForTimeout(800);

      const rec = await page.evaluate(() => {
        const r = (window as unknown as { __frames: { t: number[]; loaf: { d: number; b: number }[]; long: number[]; stop: boolean } }).__frames;
        r.stop = true;
        return { t: r.t, loaf: r.loaf, long: r.long };
      });
      const after = cdp ? Object.fromEntries(((await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value])) : null;
      if (cdp && throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      const cpu =
        before && after
          ? Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"].map((k) => [k, +((after[k] - before[k]) * (k.endsWith("Count") ? 1 : 1000)).toFixed(k.endsWith("Count") ? 0 : 1)]))
          : undefined;
      // The reply really streamed and ended in the chat.
      await expect(page.locator(".msg.agent").last()).toContainText("Part 1");
      results.push({ ...summarize(rec.t), loaf: rec.loaf.length, loafBlocking: Math.round(rec.loaf.reduce((s, e) => s + e.b, 0)), longTasks: rec.long.length, cpu });
    }
  } finally {
    await chat.cleanup();
  }
  return results;
}

for (const throttle of [1, 4]) {
  test(`a reply streaming into a long chat draws smoothly (CPU ${throttle}x)`, async ({ page, request, token, browserName }, info) => {
    test.skip(throttle > 1 && browserName !== "chromium", "Only Chromium can slow its CPU down.");
    test.setTimeout(60_000 + RUNS * 45_000);
    const results = await measure(page, request, token, browserName, throttle);
    mkdirSync(OUT, { recursive: true });
    const name = `${LABEL}-${info.project.name}-cpu${throttle}`;
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify(results, null, 1));
    console.log(`${name}: ${JSON.stringify(results)}`);
  });
}
