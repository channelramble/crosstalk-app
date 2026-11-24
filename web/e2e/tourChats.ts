import type { Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Approval, BackgroundTask, Member, Message, ReplyStart, Room, Turn } from "@crosstalk/shared";

/*
 * Chats made up for a page alone (the test hub never hears of them), with what real ones hold: a long chat with code,
 * a table and a picture; a chat at work with helpers and a request waiting; a chat whose last reply failed; a group
 * chat at work; and a list with every state and long names. layoutTour.spec.ts looks at every screen with them, and
 * layoutPolish.spec.ts uses them too.
 */

const APP = "http://127.0.0.1:5198";
const MIN = 60_000;

const LONG_REPLY = `## What changed

The importer now reads the file in **chunks** instead of all at once, so a 2 GB export no longer runs out of memory. Three things to know:

1. Rows are validated as they stream in, and a bad row is reported with its line number.
2. The progress bar counts bytes, not rows, so it moves evenly.
3. A cancelled import leaves nothing behind: the temporary table is dropped.

\`\`\`ts
export async function importRows(source: ReadableStream<Uint8Array>, onProgress: (done: number, total: number) => void): Promise<ImportResult> {
  const reader = source.pipeThrough(new TextDecoderStream()).pipeThrough(splitLines()).getReader();
  let done = 0;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    await insert(parseRow(value));
    onProgress(++done, estimatedTotal);
  }
  return { rows: done };
}
\`\`\`

| File | Before | After | Change |
| --- | --- | --- | --- |
| \`importer/read.ts\` | 412 lines | 268 lines | streaming reader |
| \`importer/validate.ts\` | 96 lines | 141 lines | per-row errors with line numbers |
| \`importer/progress.ts\` | — | 58 lines | new |

Run it with \`bun run import ./exports/customers-2026-11.csv --dry-run\` first. A much longer path wraps too: \`/Users/me/Projects/crosstalk-importer/fixtures/exports/2026/11/customers-with-a-very-long-file-name.csv\`.

${Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} of the notes: the reader keeps a small buffer, and each chunk is decoded, split into lines and handed on before the next one is asked for, so memory stays flat however large the file is.`).join("\n\n")}

That's everything. Tell me if the dry run looks right and I'll run it for real.`;

/** The made-up chats: their rows for the list, and each one's history. */
export function tour(now: number, picture: string) {
  const rooms: Room[] = [];
  const members: Member[] = [];
  const histories: Record<string, { messages: Message[]; turns: Turn[]; activities: Activity[]; approvals: Approval[]; tasks: Record<string, BackgroundTask[]> }> = {};
  const chat = (id: string, name: string, ago: number, extra: Partial<Room> = {}, agent: Partial<Member> = {}): Member => {
    const provider = (agent.provider ?? "claude") as Member["provider"];
    rooms.push({ id, name, cwd: `/Users/me/Projects/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)}`, mode: "direct", leadMemberId: `m-${id}`, maxHops: 5, rounds: 1, parallel: false, createdAt: now - 86_400_000, updatedAt: now - ago, archived: false, chat: { provider, origin: "web" }, lastReplyAt: now - ago, readAt: now, ...extra } as Room);
    const m: Member = { id: `m-${id}`, roomId: id, handle: provider, provider, model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: now - 86_400_000, position: 0, ...agent } as Member;
    members.push(m);
    histories[id] = { messages: [], turns: [], activities: [], approvals: [], tasks: {} };
    return m;
  };
  let n = 0;
  const say = (roomId: string, kind: "human" | "agent", text: string, extra: Partial<Message> = {}, by?: Member): Message => {
    const list = histories[roomId].messages;
    const seq = list.length + 1;
    const m = { id: `tour-${++n}`, seq, roomId, authorKind: kind, authorName: kind === "human" ? "Phone" : (by?.handle ?? "claude"), memberId: kind === "agent" ? (by?.id ?? `m-${roomId}`) : null, text, mentions: [], turnId: null, status: "done", createdAt: now - 3 * 3600_000 + n * 40_000, updatedAt: now - 3 * 3600_000 + n * 40_000, ...extra } as Message;
    list.push(m);
    return m;
  };
  const turn = (roomId: string, id: string, memberId: string, patch: Partial<Turn>): Turn => {
    const t = { id, roomId, memberId, triggerMessageId: null, replyMessageId: null, hop: 0, chainId: id, origin: "human", status: "done", error: null, usage: null, createdAt: now - 10 * MIN, startedAt: now - 10 * MIN, endedAt: null, ...patch } as Turn;
    histories[roomId].turns.push(t);
    return t;
  };

  // A long chat: short exchanges, then a long reply with code, a table and a long path; a picture; a list.
  const long = chat("tour-long", "Rewrite the importer", 4 * MIN, { pinnedAt: now - 9000, pinOrder: 1 });
  for (let i = 1; i <= 6; i++) {
    say(long.roomId, "human", i === 3 ? "Can you also check that a cancelled import cleans up after itself? Last time it left a temporary table behind and the next run failed on it." : `Question ${i}: how does part ${i} of the importer work?`);
    say(long.roomId, "agent", `Part ${i} reads its input, checks it and hands it on. ${"It keeps no state between rows. ".repeat(i)}`);
  }
  say(long.roomId, "human", `Here's the export that failed.\n\n[customers-2026-11.png](/api/rooms/${long.roomId}/uploads/customers.png)`);
  say(long.roomId, "agent", LONG_REPLY);
  say(long.roomId, "human", "Looks right. Run it for real.");
  say(long.roomId, "agent", "Done: 1,204,331 rows imported in 4m 12s, no bad rows.\n\n- `customers`: 1,204,331 rows\n- `orders`: untouched\n- the temporary table is gone");

  // At work: steps, a request waiting, helpers.
  const work = chat("tour-work", "Fix the flaky login test", 30_000, {}, { status: "approval", model: "claude-opus-5-5", config: { effort: "high" } as Member["config"] });
  const asked = say(work.roomId, "human", "The login test fails about one run in five on CI. Find out why and fix it.");
  const streaming = say(work.roomId, "agent", "I ran the test 40 times locally and it failed 7 times, each time waiting for the redirect. Looking at how the session cookie is set…", { turnId: "tw", status: "streaming" });
  turn(work.roomId, "tw", work.id, { status: "running", triggerMessageId: asked.id, replyMessageId: streaming.id, startedAt: now - 6 * MIN - 12_000, createdAt: now - 6 * MIN - 12_000 });
  const step = (id: string, kind: Activity["kind"], title: string, detail: string, status: Activity["status"]): Activity => ({ id, roomId: work.roomId, turnId: "tw", memberId: work.id, kind, title, detail, status, createdAt: now - 5 * MIN, updatedAt: now - MIN });
  histories[work.roomId].activities.push(
    step("s1", "command", "npm test -- login --repeat 40", "33 passed, 7 failed\n  ✗ redirects to the dashboard after sign-in (timeout 5000ms)", "done"),
    step("s2", "tool", "Read src/auth/session.ts", "", "done"),
    step("s3", "file_change", "Edit src/auth/session.ts", "-  res.cookie('sid', id)\n+  await store.save(id)\n+  res.cookie('sid', id)", "done"),
    step("s4", "command", "npm test -- login --repeat 200", "", "running"),
  );
  const approval: Approval = { id: "tour-ap", roomId: work.roomId, memberId: work.id, turnId: "tw", kind: "command", title: "git push origin fix/login-race", detail: "Run `git push origin fix/login-race` in /Users/me/Projects/fix-the-flaky-login-test", status: "pending", decision: null, decidedBy: null, createdAt: now - 40_000, decidedAt: null };
  histories[work.roomId].approvals.push(approval);
  const task = (id: string, description: string, status: BackgroundTask["status"] = "running"): BackgroundTask => ({ id, kind: "local_agent", description, agentType: "Explore", workflow: null, background: true, status, startedAt: now - 4 * MIN, endedAt: status === "running" ? null : now - MIN, tokens: 48_200, toolUses: 12, lastTool: "Grep", summary: status === "running" ? "Reading the session store's tests" : "Found two more callers", error: null, model: "claude-opus-5-5", effort: "high", contextTokens: 61_000, contextWindow: 1_000_000 });
  const tasks: Record<string, BackgroundTask[]> = { [work.id]: [task("h1", "Find every caller of setSession"), task("h2", "Check the CI logs for the last 20 runs"), task("h3", "Look for other cookies set before a save", "completed")] };
  histories[work.roomId].tasks = tasks;

  // A reply that failed.
  const failed = chat("tour-failed", "Migrate the database", 12 * MIN, { cwd: "/Users/me/Projects/api-server" }, { provider: "codex", handle: "codex", status: "error", statusDetail: "stream disconnected before completion" });
  say(failed.roomId, "human", "Write the migration that splits `name` into `first_name` and `last_name`.");
  say(failed.roomId, "agent", "Here's the plan: add the two columns, backfill them in batches of 5,000, then drop `name` in a second migration once nothing reads it.", {}, failed);
  const again = say(failed.roomId, "human", "Go ahead with the first migration.");
  const broke = say(failed.roomId, "agent", "The connection to OpenAI dropped before the reply finished (stream disconnected before completion).", { turnId: "tf", status: "error" }, failed);
  turn(failed.roomId, "tf", failed.id, { status: "error", error: "stream disconnected before completion", triggerMessageId: again.id, replyMessageId: broke.id, endedAt: now - 12 * MIN });

  // A group chat at work.
  const g1 = chat("tour-group", "Design review", 20_000, { chat: { provider: "claude", origin: "web", group: true } as Room["chat"] }, { handle: "claude", status: "working" });
  const g2: Member = { ...g1, id: "m-tour-group-b", handle: "codex", provider: "codex", position: 1, status: "queued" } as Member;
  const g3: Member = { ...g1, id: "m-tour-group-c", handle: "reviewer", provider: "claude", position: 2, status: "idle", model: "claude-sonnet-4-6" } as Member;
  members.push(g2, g3);
  const brief = say(g1.roomId, "human", "@all Here's the new onboarding flow. What would you change before we ship it?");
  say(g1.roomId, "agent", "The second step asks for a folder before saying why. I'd move the explanation above the picker and keep the list to the five newest folders.", {}, g3);
  const g1reply = say(g1.roomId, "agent", "Looking at the sign-in step now: it shows the code before", { turnId: "tg1", status: "streaming" }, g1);
  turn(g1.roomId, "tg1", g1.id, { status: "running", triggerMessageId: brief.id, replyMessageId: g1reply.id, startedAt: now - 70_000, createdAt: now - 70_000 });
  turn(g1.roomId, "tg2", g2.id, { status: "queued", triggerMessageId: brief.id, startedAt: null, createdAt: now - 70_000 });

  // The rest of the list: every state, long names.
  chat("tour-r1", "Holiday photos", 9 * MIN, { cwd: "/Users/me/Pictures/2026", lastReplyAt: now - 9 * MIN, readAt: now - 10 * MIN });
  chat("tour-r2", "A chat with a very long name that goes on and on past the edge of any phone", 26 * MIN, {}, { provider: "codex", handle: "codex" });
  chat("tour-r3", "Weekly report", 5 * 60 * MIN);
  chat("tour-r4", "Pricing page copy", 26 * 60 * MIN, { cwd: "/Users/me/Projects/site" }, { provider: "codex", handle: "codex" });
  chat("tour-r5", "Translate the docs", 70 * MIN, {}, { provider: "codex", handle: "codex", status: "waiting", wait: { provider: "codex", account: "default", kind: "usage", label: "5-hour", resetsAt: now + 3 * 60 * MIN, runAt: now + 3 * 60 * MIN + 30_000, attempts: 1 } as Member["wait"] });
  chat("tour-r6", "Tidy the backlog", 2 * 24 * 60 * MIN);

  const replyStarts: Record<string, ReplyStart> = { [work.id]: { turnId: "tw", at: now - 6 * MIN - 12_000 }, [g1.id]: { turnId: "tg1", at: now - 70_000 } };
  return { rooms, members, histories, approvals: [approval], tasks, replyStarts, picture, ids: { long: long.roomId, work: work.roomId, failed: failed.roomId, group: g1.roomId } };
}

/** The page is given the made-up chats, and answers of its own for whatever they ask the hub. */
export async function given(page: Page) {
  // A picture for the long chat: any PNG will do, so one of the page itself.
  const picture = (await page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 200 } })).toString("base64");
  const t = tour(Date.now(), picture);
  await page.routeWebSocket("**/api/ws?**", (ws: WebSocketRoute) => {
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.route((url) => url.origin === APP && url.pathname === "/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    await route.fulfill({ json: { ...s, rooms: t.rooms, members: t.members, approvals: t.approvals, tasks: t.tasks, replyStarts: t.replyStarts, roomActivity: {} } });
  });
  await page.route((url) => url.origin === APP && /^\/api\/rooms\/tour-[^/]+\//.test(url.pathname), (route) => {
    const [, , , id, what] = new URL(route.request().url()).pathname.split("/");
    const h = t.histories[id];
    if (what === "history" && h) return route.fulfill({ json: { room: t.rooms.find((r) => r.id === id), ...h, totals: null, hasMore: false } });
    if (what === "uploads") return route.fulfill({ contentType: "image/png", body: Buffer.from(t.picture, "base64") });
    // Marked read, and whatever else a screen asks of a chat that isn't the hub's.
    return route.fulfill({ json: route.request().method() === "POST" ? (t.rooms.find((r) => r.id === id) ?? {}) : [] });
  });
  return t;
}
