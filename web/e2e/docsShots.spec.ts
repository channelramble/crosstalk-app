import type { Page, WebSocketRoute } from "@playwright/test";
import type { Activity, Approval, BackgroundTask, Member, Message, ModelCatalog, Room, Turn, UsageSnapshot } from "@crosstalk/shared";
import { hostname } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixtures";

/*
 * The pictures in README.md and docs/GETTING-STARTED.md (docs/images/phone-*.png), taken from the app itself with
 * made-up chats on a made-up machine. Nothing of the machine that takes them may show: its name, its folders and its
 * accounts are replaced in everything the page is told, and each picture's words are checked before it is saved.
 *
 *   CT_DOCS_SHOTS=/some/dir npx playwright test docsShots --project=chromium-390
 *
 * Skipped without CT_DOCS_SHOTS. Look at every picture before it goes into docs/images. The Liquid glass one goes in as
 * WebP with no metadata (`cwebp -q 90 -metadata none`): as a PNG its gradient weighs close to a megabyte.
 */

const APP = "http://127.0.0.1:5198";
const MIN = 60_000;
const HOME = "/Users/me";
const MACHINE = "Mac mini";

/** Whatever names this machine, wherever the hub says it. */
function neutral(text: string): string {
  const host = hostname();
  let out = text.replace(/(\/private)?\/var\/folders\/[^"\\\s]*?\/crosstalk-browser-[A-Za-z0-9]+(\/home)?/g, HOME).replace(/(\/private)?\/var\/folders\/[^"\\\s]*/g, HOME).replace(/\/Users\/(?!me\b)[^/"\\\s]+/g, HOME);
  for (const name of new Set([host, host.replace(/\.local$/, ""), host.split(".")[0]])) if (name.length > 2) out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), MACHINE);
  return out;
}
const PRIVATE = new RegExp(`/var/folders|/private/|/Users/(?!me\\b)|${hostname().split(".")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\\.ts\\.net|\\b100\\.\\d+\\.\\d+\\.\\d+\\b|crosstalk-browser`, "i");

const CLAUDE_MODELS: ModelCatalog = {
  provider: "claude",
  live: true,
  error: null,
  models: [
    { id: "claude-opus-5-5", label: "Opus 5.5", description: "Most capable, for hard problems", efforts: ["low", "medium", "high", "max"], defaultEffort: "high", isDefault: true, contextWindow: 1_000_000 },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Fast and capable, for everyday work", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, contextWindow: 1_000_000 },
    { id: "claude-haiku-5-5", label: "Haiku 5.5", description: "Fastest, for quick answers", efforts: [], defaultEffort: null, isDefault: false, contextWindow: 200_000 },
  ],
} as ModelCatalog;

function chats(now: number) {
  const rooms: Room[] = [];
  const members: Member[] = [];
  const histories: Record<string, { messages: Message[]; turns: Turn[]; activities: Activity[]; approvals: Approval[]; tasks: Record<string, BackgroundTask[]> }> = {};
  const chat = (id: string, name: string, folder: string, ago: number, extra: Partial<Room> = {}, agent: Partial<Member> = {}): Member => {
    const provider = (agent.provider ?? "claude") as Member["provider"];
    rooms.push({ id, name, cwd: `${HOME}/Projects/${folder}`, mode: "direct", leadMemberId: `m-${id}`, maxHops: 5, rounds: 1, parallel: false, createdAt: now - 86_400_000, updatedAt: now - ago, archived: false, chat: { provider, origin: "web" }, lastReplyAt: now - ago, readAt: now, ...extra } as Room);
    const m = { id: `m-${id}`, roomId: id, handle: provider, provider, model: provider === "claude" ? "claude-opus-5-5" : null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: provider === "claude" ? { effort: "high" } : {}, createdAt: now - 86_400_000, position: 0, ...agent } as Member;
    members.push(m);
    histories[id] = { messages: [], turns: [], activities: [], approvals: [], tasks: {} };
    return m;
  };
  let n = 0;
  const say = (roomId: string, kind: "human" | "agent", text: string, extra: Partial<Message> = {}, by?: Member): Message => {
    const list = histories[roomId].messages;
    const at = now - 20 * MIN + ++n * 40_000;
    const m = { id: `docs-${n}`, seq: list.length + 1, roomId, authorKind: kind, authorName: kind === "human" ? "My phone" : (by?.handle ?? "claude"), memberId: kind === "agent" ? (by?.id ?? `m-${roomId}`) : null, text, mentions: [], turnId: null, status: "done", createdAt: at, updatedAt: at, ...extra } as Message;
    list.push(m);
    return m;
  };

  // The chat in the picture: a question, steps, a request waiting, helpers at work.
  const work = chat("docs-work", "Fix the flaky login test", "web-app", 30_000, { pinnedAt: now - 9000, pinOrder: 1 }, { status: "approval" });
  const asked = say(work.roomId, "human", "The login test fails about one run in five on CI. Find out why and fix it.");
  const reply = say(work.roomId, "agent", "Found it: the session cookie is sent before the session is saved, so a fast redirect sometimes arrives first. I saved the session first and ran the test 200 times: all pass. Ready to push the fix.", { turnId: "dw", status: "streaming" });
  histories[work.roomId].turns.push({ id: "dw", roomId: work.roomId, memberId: work.id, triggerMessageId: asked.id, replyMessageId: reply.id, hop: 0, chainId: "dw", origin: "human", status: "running", error: null, usage: null, createdAt: now - 6 * MIN, startedAt: now - 6 * MIN, endedAt: null } as Turn);
  const step = (id: string, kind: Activity["kind"], title: string, detail: string): Activity => ({ id, roomId: work.roomId, turnId: "dw", memberId: work.id, kind, title, detail, status: "done", createdAt: now - 5 * MIN, updatedAt: now - MIN }) as Activity;
  histories[work.roomId].activities.push(
    step("s1", "command", "npm test -- login --repeat 40", "33 passed, 7 failed"),
    step("s2", "tool", "Read src/auth/session.ts", ""),
    step("s3", "file_change", "Edit src/auth/session.ts", "-  res.cookie('sid', id)\n+  await store.save(id)\n+  res.cookie('sid', id)"),
    step("s4", "command", "npm test -- login --repeat 200", "200 passed"),
  );
  const approval = { id: "docs-ap", roomId: work.roomId, memberId: work.id, turnId: "dw", kind: "command", title: "git push origin fix/login-race", detail: "git push origin fix/login-race", status: "pending", decision: null, decidedBy: null, createdAt: now - 40_000, decidedAt: null } as Approval;
  histories[work.roomId].approvals.push(approval);

  // A finished chat, for a picture of a reply.
  const done = chat("docs-done", "Plan the pricing page", "site", 9 * MIN, { lastReplyAt: now - 9 * MIN, readAt: now - 10 * MIN });
  say(done.roomId, "human", "Draft the three plans for the pricing page from notes.md.");
  say(done.roomId, "agent", "Here's a first draft, in `pricing.md`:\n\n| Plan | Price | For |\n| --- | --- | --- |\n| Starter | Free | trying it out |\n| Team | $12 a seat | small teams |\n| Business | $29 a seat | SSO and audit logs |\n\nI kept your wording for Team and shortened the other two. Want the yearly prices too?");

  const review = chat("docs-group", "Design review", "web-app", 2 * MIN, { chat: { provider: "claude", origin: "web", group: true } as Room["chat"] }, { status: "working" });
  members.push({ ...review, id: "m-docs-group-b", handle: "codex", provider: "codex", model: null, config: {}, position: 1, status: "idle" } as Member);
  const brief = say(review.roomId, "human", "@all Here's the new onboarding flow. What would you change before we ship it?");
  const r = say(review.roomId, "agent", "Looking at the sign-in step now.", { turnId: "dg", status: "streaming" }, review);
  histories[review.roomId].turns.push({ id: "dg", roomId: review.roomId, memberId: review.id, triggerMessageId: brief.id, replyMessageId: r.id, hop: 0, chainId: "dg", origin: "human", status: "running", error: null, usage: null, createdAt: now - 70_000, startedAt: now - 70_000, endedAt: null } as Turn);

  chat("docs-r1", "Migrate the database", "api-server", 26 * MIN, {}, { provider: "codex", handle: "codex" });
  chat("docs-r2", "Weekly report", "reports", 5 * 60 * MIN);
  chat("docs-r3", "Translate the docs", "site", 26 * 60 * MIN, {}, { provider: "codex", handle: "codex" });
  chat("docs-r4", "Tidy the backlog", "web-app", 2 * 24 * 60 * MIN);

  const replyStarts = { [work.id]: { turnId: "dw", at: now - 6 * MIN }, [review.id]: { turnId: "dg", at: now - 70_000 } };
  return { rooms, members, histories, approvals: [approval], replyStarts, ids: { work: work.roomId, done: done.roomId } };
}

const usage = (now: number): UsageSnapshot[] => [
  { provider: "claude", accountId: "default", account: null, plan: "Max", windows: [{ label: "5-hour", usedPercent: 34, resetsAt: now + 150 * MIN }, { label: "Weekly", usedPercent: 58, resetsAt: now + 3 * 24 * 60 * MIN }], credits: null, note: null, updatedAt: now },
  { provider: "codex", accountId: "default", account: null, plan: "Plus", windows: [{ label: "5-hour", usedPercent: 12, resetsAt: now + 200 * MIN }, { label: "Weekly", usedPercent: 41, resetsAt: now + 5 * 24 * 60 * MIN }], credits: null, note: null, updatedAt: now },
] as UsageSnapshot[];

test("pictures for the README and the guide", async ({ browser, token }) => {
  const dir = process.env.CT_DOCS_SHOTS;
  test.skip(!dir || test.info().project.name !== "chromium-390", "Set CT_DOCS_SHOTS to a folder to take them (chromium-390 only).");
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL: APP, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: "reduce", serviceWorkers: "block", colorScheme: "dark" });
  const page: Page = await context.newPage();
  // "new": a machine where nobody has signed in yet (the welcome card). "used": the made-up chats.
  let scene: "new" | "used" = "used";
  const t = chats(Date.now());
  await page.addInitScript((token) => {
    localStorage.setItem("crosstalk.conn.v1", JSON.stringify({ baseUrl: "", token, deviceName: "My phone" }));
  }, token);
  await page.routeWebSocket("**/api/ws?**", (ws: WebSocketRoute) => {
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  // Everything the hub says goes through `neutral` first; the routes below then put the made-up parts in.
  await page.route((url) => url.origin === APP && url.pathname.startsWith("/api/"), async (route) => {
    const res = await route.fetch();
    const type = res.headers()["content-type"] ?? "";
    if (!/json|text/.test(type)) return route.fulfill({ response: res });
    await route.fulfill({ response: res, body: neutral(await res.text()) });
  });
  await page.route((url) => url.origin === APP && url.pathname === "/api/state", async (route) => {
    const s = JSON.parse(neutral(await (await route.fetch()).text()));
    const fresh = scene === "new";
    const providers = (s.providers as { provider: string; installed: boolean; signedIn: boolean | null; account: string | null; plan: string | null; binPath: string | null }[]).map((p) =>
      p.provider === "claude" || p.provider === "codex" ? { ...p, installed: true, signedIn: !fresh, account: null, plan: fresh ? null : p.provider === "claude" ? "Max" : "Plus", binPath: `${HOME}/.local/bin/${p.provider}` } : fresh ? { ...p, signedIn: false } : p,
    );
    // On the new machine nobody has signed in anywhere, and no service has been added.
    const accounts = fresh ? (s.accounts as { id: string; signedIn?: boolean | null }[]).filter((a) => a.id === "default").map((a) => ({ ...a, signedIn: false })) : s.accounts;
    await route.fulfill({
      json: {
        ...s,
        hub: { ...s.hub, hostname: "mac-mini", name: MACHINE, workspaceRoot: `${HOME}/Projects`, publicUrl: null },
        device: { ...s.device, name: "My phone" },
        providers,
        accounts,
        usage: fresh ? [] : usage(Date.now()),
        rooms: fresh ? [] : t.rooms,
        members: fresh ? [] : t.members,
        approvals: fresh ? [] : t.approvals,
        tasks: {},
        replyStarts: fresh ? {} : t.replyStarts,
        roomActivity: {},
        signIns: [],
        signInSessions: [],
        macDialogs: [],
      },
    });
  });
  await page.route((url) => url.origin === APP && url.pathname === "/api/folders", (route) =>
    route.fulfill({ json: { root: `${HOME}/Projects`, folders: scene === "new" ? [] : ["web-app", "site", "api-server", "reports"].map((f, i) => ({ path: `${HOME}/Projects/${f}`, usedAt: Date.now() - (i + 1) * 20 * MIN })) } }),
  );
  await page.route((url) => url.origin === APP && url.pathname === "/api/providers/claude/models", (route) => route.fulfill({ json: CLAUDE_MODELS }));
  await page.route((url) => url.origin === APP && /^\/api\/rooms\/docs-[^/]+\//.test(url.pathname), (route) => {
    const [, , , id, what] = new URL(route.request().url()).pathname.split("/");
    const h = t.histories[id];
    if (what === "history" && h) return route.fulfill({ json: { room: t.rooms.find((r) => r.id === id), ...h, totals: null, hasMore: false } });
    return route.fulfill({ json: route.request().method() === "POST" ? (t.rooms.find((r) => r.id === id) ?? {}) : [] });
  });

  const shot = async (name: string) => {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150)))));
    const words = await page.evaluate(() => document.body.innerText + " " + [...document.querySelectorAll("input, textarea")].map((el) => `${(el as HTMLInputElement).value} ${(el as HTMLInputElement).placeholder}`).join(" "));
    expect(words.match(PRIVATE)?.[0] ?? null, `${name} shows something of this machine`).toBeNull();
    await page.screenshot({ path: join(dir!, `${name}.png`), animations: "disabled" });
  };
  const open = async (hash: string, welcome: boolean) => {
    await page.goto(`/#${hash}`);
    await page.evaluate((welcome) => (welcome ? localStorage.removeItem("crosstalk.welcome.dismissed") : localStorage.setItem("crosstalk.welcome.dismissed", "1")), welcome);
    await page.reload();
    await expect(page.locator(".topbar").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
  };

  // The welcome card on a new machine.
  scene = "new";
  await open("/", true);
  await expect(page.getByText("Welcome to Crosstalk")).toBeVisible();
  await shot("phone-welcome");

  // Home: the agents, and how much of each plan is left.
  scene = "used";
  await open("/", false);
  await expect(page.getByText("Claude Code").first()).toBeVisible();
  await shot("phone-home");

  // The chat list.
  await page.getByRole("button", { name: /^Show chats/ }).click();
  await expect(page.getByText("Design review").first()).toBeVisible();
  await shot("phone-chats");

  // A chat at work, with a request waiting.
  await open(`/room/${t.ids.work}`, false);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await expect(page.getByText("git push origin fix/login-race").first()).toBeVisible();
  await shot("phone-chat");

  // A finished reply.
  await open(`/room/${t.ids.done}`, false);
  await expect(page.locator(".messages").getByText("Starter")).toBeVisible();
  await shot("phone-reply");

  // Chat settings.
  await page.getByRole("button", { name: "Chat settings", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: /Chat settings/ })).toBeVisible();
  await shot("phone-chat-settings");
  await page.keyboard.press("Escape");

  // New chat.
  await open("/agent/claude", false);
  await page.getByRole("button", { name: /^New chat/ }).first().click();
  await expect(page.getByRole("dialog", { name: /New chat/ })).toBeVisible();
  await shot("phone-new-chat");
  await page.keyboard.press("Escape");

  // Themes: the picker, then Home in two of them.
  await open("/settings/display", false);
  const tiles = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await tiles.evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    const sc = el.closest(".settings-body, .content, main") ?? document.scrollingElement;
    if (sc) sc.scrollTop -= 120;
  });
  await shot("phone-themes");
  // (The glass picture is Nebula under the Liquid glass texture: what the Liquid glass theme was.)
  for (const [name, file, texture, room, words] of [
    ["Nebula", "phone-theme-glass", "Liquid glass", t.ids.done, "Starter"],
    ["OLED black", "phone-theme-metal", "Skeuomorphic", t.ids.work, "git push origin fix/login-race"],
  ] as const) {
    await page.goto("/#/settings/display");
    await tiles.getByRole("radio", { name: new RegExp(`^${name}\\.`) }).click();
    await page.getByRole("radiogroup", { name: "Texture", exact: true }).getByRole("radio", { name: new RegExp(`^${texture}\\.`) }).click();
    await page.goto(`/#/room/${room}`);
    await expect(page.locator(".messages").getByText(words).first()).toBeVisible();
    await shot(file);
  }

  await context.close();
});
